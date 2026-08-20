use crate::auth::{
    create_mac_hex, validate_bind_proof, validate_hello_query, HelloQuery, DEFAULT_MAX_SKEW_MS,
};
use crate::broker::{BrokerConfig, RustBroker};
use crate::session::SessionStatus;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio::time;

#[derive(Clone)]
pub struct RuntimeBroker {
    config: BrokerConfig,
    broker: RustBroker,
    extension: Arc<RwLock<Option<ExtensionHandle>>>,
    pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
    late_claims: Arc<Mutex<HashMap<String, LateClaim>>>,
    request_counter: Arc<AtomicU64>,
    nonce_counter: Arc<AtomicU64>,
}

#[derive(Debug, Clone)]
struct ExtensionHandle {
    sender: mpsc::Sender<Value>,
    extension_instance_id: Option<String>,
}

struct PendingRequest {
    session_id: String,
    tool: String,
    sender: oneshot::Sender<Result<Value, RuntimeError>>,
}

struct LateClaim {
    session_id: String,
    tool: String,
}

const COMMAND_TIMEOUT_SLACK_MS: u64 = 5_000;
const MAX_COMMAND_TIMEOUT_MS: u64 = 185_000;

pub fn resolve_command_timeout_ms(config_ms: u64, params: &Value) -> u64 {
    let floor = if config_ms == 0 { 60_000 } else { config_ms };
    let tool_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(0);
    if tool_ms == 0 {
        return floor;
    }
    floor.max(tool_ms.saturating_add(COMMAND_TIMEOUT_SLACK_MS)).min(MAX_COMMAND_TIMEOUT_MS)
}

#[derive(Debug, Clone, Serialize)]
struct ErrorBody {
    code: String,
    message: String,
}

#[derive(Debug)]
pub enum RuntimeError {
    BindFailed(String),
    ExtensionNotConnected,
    ExtensionSendFailed,
    InvalidExtensionMessage(String),
    RequestTimedOut(String),
    ShimIo(String),
    ShimProtocol(String),
    Session(String),
    Socket(String),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BindFailed(message)
            | Self::InvalidExtensionMessage(message)
            | Self::RequestTimedOut(message)
            | Self::ShimIo(message)
            | Self::ShimProtocol(message)
            | Self::Session(message)
            | Self::Socket(message) => write!(formatter, "{message}"),
            Self::ExtensionNotConnected => write!(
                formatter,
                "Chrome extension is not connected to the Rust broker."
            ),
            Self::ExtensionSendFailed => {
                write!(formatter, "failed to send command to Chrome extension.")
            }
        }
    }
}

impl Error for RuntimeError {}

#[derive(Debug, Deserialize)]
struct BridgeHelloParams {
    ts: i64,
    nonce: String,
    mac: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ShimRequest {
    RegisterSession {
        id: String,
        session_id: String,
    },
    Command {
        id: String,
        session_id: String,
        tool: String,
        #[serde(default)]
        params: Value,
    },
    Health {
        id: String,
    },
    DisconnectSession {
        id: String,
        session_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    ReapIdleEmptySessions {
        id: String,
        #[serde(default)]
        ttl_ms: Option<u64>,
        #[serde(default)]
        min_age_ms: Option<u64>,
        #[serde(default)]
        dry_run: Option<bool>,
    },
}

#[derive(Debug, Serialize)]
struct ShimResponse {
    #[serde(rename = "type")]
    response_type: &'static str,
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

impl RuntimeBroker {
    pub fn new(config: BrokerConfig) -> Self {
        Self {
            broker: RustBroker::new(config.clone()),
            config,
            extension: Arc::new(RwLock::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            late_claims: Arc::new(Mutex::new(HashMap::new())),
            request_counter: Arc::new(AtomicU64::new(1)),
            nonce_counter: Arc::new(AtomicU64::new(1)),
        }
    }

    pub async fn serve(self) -> Result<(), RuntimeError> {
        let (listener, bound_port) = bind_first_available(
            &self.config.host,
            self.config.port_start,
            self.config.port_end,
        )
        .await?;
        let bound = Self::new(self.config.with_bound_port(bound_port));
        let state = Arc::new(bound);

        prepare_unix_socket(&state.config.socket_path).await?;
        let shim_listener = UnixListener::bind(&state.config.socket_path)
            .map_err(|error| RuntimeError::BindFailed(error.to_string()))?;

        let app = Router::new()
            .route("/healthz", get(health_handler))
            .route("/bridge", any(bridge_handler))
            .with_state(Arc::clone(&state));

        let http_task = async move {
            axum::serve(listener, app)
                .await
                .map_err(|error| RuntimeError::Socket(error.to_string()))
        };
        let shim_task = serve_shim_socket(Arc::clone(&state), shim_listener);

        tokio::select! {
            result = http_task => result,
            result = shim_task => result,
            result = tokio::signal::ctrl_c() => {
                result.map_err(|error| RuntimeError::Socket(error.to_string()))?;
                let _ = state.broker.graceful_shutdown().await;
                Ok(())
            }
        }
    }

    async fn next_request_id(&self) -> String {
        let counter = self.request_counter.fetch_add(1, Ordering::AcqRel);
        format!("rust_req_{counter}")
    }

    fn create_server_nonce(&self, client_nonce: &str) -> String {
        let counter = self.nonce_counter.fetch_add(1, Ordering::AcqRel);
        let now = now_ms();
        create_mac_hex(
            self.config.shared_key.as_bytes(),
            &format!("server_nonce:{now}:{client_nonce}:{counter}"),
        )
        .chars()
        .take(32)
        .collect()
    }

    async fn route_extension_command(
        &self,
        session_id: &str,
        tool: &str,
        params: Value,
    ) -> Result<Value, RuntimeError> {
        if let Some(tab_id) = params.get("tabId").and_then(Value::as_u64) {
            if let Err(error) = self
                .broker
                .route_tab_command(session_id, tab_id, tool, params.clone())
                .await
            {
                return Err(RuntimeError::Session(error.to_string()));
            }
        } else if let Err(error) = self
            .broker
            .route_session_command(session_id, tool, params.clone())
            .await
        {
            return Err(RuntimeError::Session(error.to_string()));
        }

        let handle = self
            .extension
            .read()
            .await
            .as_ref()
            .cloned()
            .ok_or(RuntimeError::ExtensionNotConnected)?;
        let request_id = self.next_request_id().await;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(
            request_id.clone(),
            PendingRequest {
                session_id: session_id.to_string(),
                tool: tool.to_string(),
                sender,
            },
        );
        self.broker.registry().add_pending_request(session_id).await;

        let payload = json!({
            "type": "command",
            "id": request_id,
            "sessionId": session_id,
            "tool": tool,
            "params": params,
        });

        self.broker.pressure().begin_pending_request();
        if handle.sender.send(payload).await.is_err() {
            self.pending.lock().await.remove(&request_id);
            let _ = self
                .broker
                .registry()
                .settle_pending_request(session_id)
                .await;
            self.broker.pressure().end_pending_request();
            return Err(RuntimeError::ExtensionSendFailed);
        }

        let timeout = Duration::from_millis(resolve_command_timeout_ms(
            self.config.request_timeout_ms,
            &params,
        ));
        let result = match time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RuntimeError::ExtensionSendFailed),
            Err(_) => {
                if let Some(pending) = self.pending.lock().await.remove(&request_id) {
                    self.late_claims.lock().await.insert(
                        request_id.clone(),
                        LateClaim {
                            session_id: pending.session_id,
                            tool: pending.tool,
                        },
                    );
                }
                let _ = self
                    .broker
                    .registry()
                    .settle_pending_request(session_id)
                    .await;
                Err(RuntimeError::RequestTimedOut(format!(
                    "Timed out waiting for {tool} result from the Rust broker."
                )))
            }
        };
        self.broker.pressure().end_pending_request();

        let result = result?;
        self.observe_tool_result(session_id, tool, &result).await;
        Ok(result)
    }

    async fn settle_extension_message(&self, message: Value) -> Result<(), RuntimeError> {
        let message_type = message.get("type").and_then(Value::as_str).unwrap_or("");
        if message_type != "result" && message_type != "error" {
            return Ok(());
        }
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                RuntimeError::InvalidExtensionMessage("extension response missing id".to_string())
            })?
            .to_string();
        let pending = self.pending.lock().await.remove(&id);
        let Some(pending) = pending else {
            if let Some(late) = self.late_claims.lock().await.remove(&id) {
                if message_type == "result" {
                    if let Some(result) = message.get("result") {
                        self.observe_tool_result(&late.session_id, &late.tool, result)
                            .await;
                    }
                }
            }
            return Ok(());
        };
        let response = if message_type == "result" {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        } else {
            let error = message.get("error").cloned().unwrap_or_else(|| {
                json!({
                    "code": "extension_error",
                    "message": "extension returned an unknown error"
                })
            });
            Err(RuntimeError::InvalidExtensionMessage(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("extension command failed")
                    .to_string(),
            ))
        };
        let _ = self
            .broker
            .registry()
            .settle_pending_request(&pending.session_id)
            .await;
        let _ = pending.sender.send(response);
        Ok(())
    }

    async fn observe_tool_result(&self, session_id: &str, tool: &str, result: &Value) {
        match tool {
            "browser_create_tab" | "browser_navigate" | "browser_adopt_tab" => {
                if let Some(tab_id) = result
                    .get("tabId")
                    .or_else(|| result.get("id"))
                    .and_then(Value::as_u64)
                {
                    let _ = self.broker.registry().claim_tab(session_id, tab_id).await;
                    let _ = self
                        .broker
                        .registry()
                        .set_active_tab(session_id, tab_id)
                        .await;
                }
            }
            "browser_list_tabs" | "browser_tabs_context" | "browser_get_session_status" => {
                if let Some(tabs) = result.get("tabs").and_then(Value::as_array) {
                    for tab in tabs {
                        let owned = tab.get("owned").and_then(Value::as_bool);
                        if owned == Some(false) {
                            continue;
                        }
                        if let Some(tab_id) = tab
                            .get("tabId")
                            .or_else(|| tab.get("id"))
                            .and_then(Value::as_u64)
                        {
                            let _ = self.broker.registry().claim_tab(session_id, tab_id).await;
                        }
                    }
                }
            }
            "browser_group_tabs" => {
                if let Some(group_id) = result
                    .get("group")
                    .and_then(|group| group.get("groupId").or_else(|| group.get("id")))
                    .and_then(Value::as_i64)
                {
                    self.broker.registry().set_group(session_id, group_id).await;
                }
            }
            "browser_close_tab" => {
                if let Some(tab_id) = result.get("tabId").and_then(Value::as_u64) {
                    let _ = self.broker.registry().release_tab(tab_id).await;
                }
            }
            "browser_close_session_tabs" => {
                if let Some(closed_tabs) = result.get("closedTabIds").and_then(Value::as_array) {
                    for tab_id in closed_tabs.iter().filter_map(Value::as_u64) {
                        let _ = self.broker.registry().release_tab(tab_id).await;
                    }
                }
            }
            _ => {}
        }
    }

    async fn notify_session_disconnected(&self, session_id: &str, reason: &str) {
        let handle = self.extension.read().await.as_ref().cloned();
        if let Some(handle) = handle {
            let _ = handle
                .sender
                .send(json!({
                    "type": "session_disconnected",
                    "sessionId": session_id,
                    "reason": reason,
                }))
                .await;
        }
    }

    async fn reap_idle_empty_sessions(
        &self,
        ttl_ms: Option<u64>,
        min_age_ms: Option<u64>,
        dry_run: bool,
    ) -> Value {
        let ttl_ms = ttl_ms.unwrap_or(self.config.idle_empty_session_ttl_ms);
        let min_age_ms = min_age_ms.unwrap_or(self.config.idle_empty_session_min_age_ms);
        let now = now_ms() as u64;
        let protected = self.protected_session_ids();
        let candidates = self
            .broker
            .registry()
            .idle_empty_reap_candidates(now, ttl_ms, min_age_ms, &protected)
            .await;
        let mut reaped = Vec::new();
        if !dry_run {
            for candidate in &candidates {
                if self
                    .broker
                    .registry()
                    .detach_idle_empty_session(
                        &candidate.session_id,
                        now_ms() as u64,
                        ttl_ms,
                        min_age_ms,
                        &protected,
                    )
                    .await
                    .is_some()
                {
                    self.notify_session_disconnected(
                        &candidate.session_id,
                        "idle_empty_session_reaped",
                    )
                    .await;
                    reaped.push(candidate.session_id.clone());
                }
            }
        }
        json!({
            "dryRun": dry_run,
            "ttlMs": ttl_ms,
            "minAgeMs": min_age_ms,
            "candidateCount": candidates.len(),
            "candidates": candidates,
            "reapedCount": reaped.len(),
            "reapedSessionIds": reaped,
        })
    }

    fn protected_session_ids(&self) -> HashSet<String> {
        HashSet::from([self.config.broker_session_id.clone()])
    }

    async fn health_value(&self) -> Value {
        let mut health =
            serde_json::to_value(self.broker.health().await).unwrap_or_else(|_| json!({}));
        let extension = self.extension.read().await;
        let sessions = self.broker.registry().statuses().await;
        let now = now_ms() as u64;
        let protected_ids = self.protected_session_ids();
        let empty_shims = sessions
            .iter()
            .filter(|session| is_empty_shim_session(session))
            .collect::<Vec<_>>();
        let idle_empty_shims = sessions
            .iter()
            .filter(|session| {
                is_empty_shim_session(session)
                    && !protected_ids.contains(&session.session_id)
                    && now.saturating_sub(session.created_at_ms)
                        >= self.config.idle_empty_session_min_age_ms
                    && now.saturating_sub(session.last_activity_at_ms)
                        >= self.config.idle_empty_session_ttl_ms
            })
            .collect::<Vec<_>>();
        let protected_count = sessions
            .iter()
            .filter(|session| {
                protected_ids.contains(&session.session_id)
                    || session.pending_requests > 0
                    || !session.tab_ids.is_empty()
                    || session.group_id.is_some()
                    || session.active_tab_id.is_some()
            })
            .count();
        let pending_request_count: usize = sessions
            .iter()
            .map(|session| session.pending_requests)
            .sum();
        let mut reason_codes = Vec::new();
        if !extension.is_some() {
            reason_codes.push("extension_disconnected");
        }
        if !empty_shims.is_empty() {
            reason_codes.push("connected_empty_shims");
        }
        if !idle_empty_shims.is_empty() {
            reason_codes.push("idle_empty_reap_candidates");
        }
        let status = if !idle_empty_shims.is_empty() {
            "jammed"
        } else if !empty_shims.is_empty() || !extension.is_some() {
            "degraded"
        } else {
            "ok"
        };
        let recommended_action = if !idle_empty_shims.is_empty() {
            "npm run doctor -- --fix"
        } else if !empty_shims.is_empty() {
            "monitor; idle empty shim sessions are below TTL"
        } else {
            "none"
        };
        if let Value::Object(ref mut object) = health {
            object.insert(
                "extension_connected".to_string(),
                Value::Bool(extension.is_some()),
            );
            object.insert(
                "socketPath".to_string(),
                Value::String(self.config.socket_path.clone()),
            );
            object.insert(
                "extensionInstanceId".to_string(),
                extension
                    .as_ref()
                    .and_then(|handle| handle.extension_instance_id.clone())
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            object.insert(
                "diagnostics".to_string(),
                json!({
                    "status": status,
                    "reason_codes": reason_codes,
                    "recommended_action": recommended_action,
                    "empty_shim_session_count": empty_shims.len(),
                    "idle_empty_shim_session_count": idle_empty_shims.len(),
                    "protected_session_count": protected_count,
                    "pending_request_count": pending_request_count,
                    "idle_empty_session_ttl_ms": self.config.idle_empty_session_ttl_ms,
                    "idle_empty_session_min_age_ms": self.config.idle_empty_session_min_age_ms,
                    "reap_candidate_session_ids": idle_empty_shims
                        .iter()
                        .map(|session| session.session_id.clone())
                        .collect::<Vec<_>>(),
                }),
            );
        }
        health
    }
}

async fn health_handler(State(state): State<Arc<RuntimeBroker>>) -> Json<Value> {
    Json(state.health_value().await)
}

async fn bridge_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<BridgeHelloParams>,
    State(state): State<Arc<RuntimeBroker>>,
) -> Response {
    let port = state.config.bound_port.unwrap_or(state.config.port_start);
    let validated = validate_hello_query(
        state.config.shared_key.as_bytes(),
        HelloQuery {
            port,
            timestamp_ms: query.ts,
            nonce: &query.nonce,
            mac: &query.mac,
        },
        now_ms(),
        DEFAULT_MAX_SKEW_MS,
    );
    let Ok(validated) = validated else {
        state.broker.pressure().observe_auth_failure();
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                code: "invalid_hello".to_string(),
                message: "invalid bridge hello proof".to_string(),
            }),
        )
            .into_response();
    };

    ws.on_upgrade(move |socket| handle_extension_socket(state, socket, validated.nonce))
}

async fn handle_extension_socket(
    state: Arc<RuntimeBroker>,
    socket: WebSocket,
    client_nonce: String,
) {
    let (mut websocket_sender, mut websocket_receiver) = socket.split();
    let (outbound_sender, mut outbound_receiver) = mpsc::channel::<Value>(256);
    let server_nonce = state.create_server_nonce(&client_nonce);
    let broker_session_id = state.config.broker_session_id.clone();

    let hello_ack = json!({
        "type": "hello_ack",
        "sessionId": broker_session_id,
        "serverNonce": server_nonce,
        "protocolVersion": 2,
        "broker": true,
        "supportsSessionRouting": true,
    });
    if websocket_sender
        .send(Message::Text(hello_ack.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    let writer = tokio::spawn(async move {
        while let Some(payload) = outbound_receiver.recv().await {
            if websocket_sender
                .send(Message::Text(payload.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let mut authenticated = false;
    let bind_deadline = time::sleep(Duration::from_millis(state.config.bind_timeout_ms));
    tokio::pin!(bind_deadline);

    loop {
        tokio::select! {
            _ = &mut bind_deadline, if !authenticated => {
                state.broker.pressure().observe_auth_failure();
                writer.abort();
                return;
            }
            maybe_message = websocket_receiver.next() => {
                let Some(Ok(message)) = maybe_message else {
                    break;
                };
                let Message::Text(text) = message else {
                    continue;
                };
                state.broker.pressure().add_bytes_in(text.len() as u64);
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let message_type = parsed.get("type").and_then(Value::as_str).unwrap_or("");

                if !authenticated {
                    if message_type == "hello" {
                        continue;
                    }
                    if message_type != "bind" {
                        state.broker.pressure().observe_auth_failure();
                        break;
                    }
                    let proof = parsed.get("proof").and_then(Value::as_str).unwrap_or("");
                    if validate_bind_proof(
                        state.config.shared_key.as_bytes(),
                        &broker_session_id,
                        &client_nonce,
                        &server_nonce,
                        proof,
                    )
                    .is_err()
                    {
                        state.broker.pressure().observe_auth_failure();
                        break;
                    }

                    authenticated = true;
                    let extension_instance_id = parsed
                        .get("extensionInstanceId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let _ = state
                        .broker
                        .attach_session_channel(
                            &broker_session_id,
                            "extension",
                            state.config.bound_port.unwrap_or(state.config.port_start),
                            now_ms() as u64,
                        )
                        .await;
                    let _ = state
                        .broker
                        .authenticate_session(
                            &broker_session_id,
                            extension_instance_id.clone(),
                            now_ms() as u64,
                        )
                        .await;
                    *state.extension.write().await = Some(ExtensionHandle {
                        sender: outbound_sender.clone(),
                        extension_instance_id,
                    });
                    let bind_ack = json!({
                        "type": "bind_ack",
                        "sessionId": broker_session_id,
                        "ready": true,
                        "protocolVersion": 2,
                        "broker": true,
                    });
                    let _ = outbound_sender.send(bind_ack).await;
                    continue;
                }

                let _ = state.settle_extension_message(parsed).await;
            }
        }
    }

    *state.extension.write().await = None;
    reject_all_pending(&state, "extension disconnected").await;
    let _ = state
        .broker
        .registry()
        .detach_channel(&broker_session_id)
        .await;
    writer.abort();
}

async fn serve_shim_socket(
    state: Arc<RuntimeBroker>,
    listener: UnixListener,
) -> Result<(), RuntimeError> {
    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|error| RuntimeError::ShimIo(error.to_string()))?;
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let _ = handle_shim_connection(state, stream).await;
        });
    }
}

async fn handle_shim_connection(
    state: Arc<RuntimeBroker>,
    stream: UnixStream,
) -> Result<(), RuntimeError> {
    let (reader, writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    let (response_sender, mut response_receiver) = mpsc::channel::<ShimResponse>(256);
    let registered_session = Arc::new(Mutex::new(None::<String>));
    let mut idle_check =
        time::interval(Duration::from_millis(state.config.idle_reaper_interval_ms));
    let mut detached_before_close = false;

    let writer_task = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(response) = response_receiver.recv().await {
            let Ok(line) = serde_json::to_string(&response) else {
                continue;
            };
            if writer.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if writer.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            maybe_line = lines.next_line() => {
                let Some(line) = maybe_line.map_err(|error| RuntimeError::ShimIo(error.to_string()))? else {
                    break;
                };
                if let Some(session_id) = registered_session.lock().await.as_ref().cloned() {
                    state.broker.registry().touch_session(&session_id).await;
                }
                let request: Result<ShimRequest, _> = serde_json::from_str(&line);
                let response_sender = response_sender.clone();
                let state = Arc::clone(&state);
                let registered_session = Arc::clone(&registered_session);
                tokio::spawn(async move {
                    let response = match request {
                        Ok(request) => handle_shim_request(state, registered_session, request).await,
                        Err(error) => ShimResponse::error(
                            "unknown".to_string(),
                            "invalid_shim_json",
                            &error.to_string(),
                        ),
                    };
                    let _ = response_sender.send(response).await;
                });
            }
            _ = idle_check.tick() => {
                let Some(session_id) = registered_session.lock().await.as_ref().cloned() else {
                    continue;
                };
                let protected = state.protected_session_ids();
                if state
                    .broker
                    .registry()
                    .detach_idle_empty_session(
                        &session_id,
                        now_ms() as u64,
                        state.config.idle_empty_session_ttl_ms,
                        state.config.idle_empty_session_min_age_ms,
                        &protected,
                    )
                    .await
                    .is_some()
                {
                    *registered_session.lock().await = None;
                    state
                        .notify_session_disconnected(&session_id, "idle_empty_session_reaped")
                        .await;
                    detached_before_close = true;
                    break;
                }
            }
        }
    }

    if !detached_before_close {
        if let Some(session_id) = registered_session.lock().await.take() {
            let _ = state.broker.registry().detach_session(&session_id).await;
            state
                .notify_session_disconnected(&session_id, "shim_disconnected")
                .await;
        }
    }
    writer_task.abort();
    Ok(())
}

async fn handle_shim_request(
    state: Arc<RuntimeBroker>,
    registered_session: Arc<Mutex<Option<String>>>,
    request: ShimRequest,
) -> ShimResponse {
    match request {
        ShimRequest::RegisterSession { id, session_id } => {
            if session_id.trim().is_empty() {
                return ShimResponse::error(id, "invalid_session", "session_id is required");
            }
            {
                let registered = registered_session.lock().await;
                if let Some(existing) = registered.as_ref() {
                    if existing != &session_id {
                        return ShimResponse::error(
                            id,
                            "session_mismatch",
                            "this shim socket is already registered to a different session",
                        );
                    }
                }
            }
            let _ = state.broker.registry().ensure_session(&session_id).await;
            if let Err(error) = state
                .broker
                .attach_session_channel(&session_id, "mcp-shim", 0, now_ms() as u64)
                .await
            {
                return ShimResponse::error(id, "session_already_connected", &error.to_string());
            }
            if let Err(error) = state
                .broker
                .authenticate_session(&session_id, None, now_ms() as u64)
                .await
            {
                return ShimResponse::error(id, "session_auth_failed", &error.to_string());
            }
            *registered_session.lock().await = Some(session_id.clone());
            let status = state.broker.registry().status(&session_id).await;
            ShimResponse::ok(id, json!({ "sessionId": session_id, "status": status }))
        }
        ShimRequest::Command {
            id,
            session_id,
            tool,
            params,
        } => {
            if let Err(response) =
                require_registered_session(&id, &registered_session, &session_id).await
            {
                return response;
            }
            match state
                .route_extension_command(&session_id, &tool, params)
                .await
            {
                Ok(result) => ShimResponse::ok(id, result),
                Err(error) => ShimResponse::error(id, "broker_command_failed", &error.to_string()),
            }
        }
        ShimRequest::Health { id } => {
            let health = state.health_value().await;
            ShimResponse::ok(id, health)
        }
        ShimRequest::DisconnectSession {
            id,
            session_id,
            reason,
        } => {
            if let Err(response) =
                require_registered_session(&id, &registered_session, &session_id).await
            {
                return response;
            }
            let reason = reason.unwrap_or_else(|| "shim_requested_disconnect".to_string());
            let _ = state.broker.registry().detach_session(&session_id).await;
            state
                .notify_session_disconnected(&session_id, &reason)
                .await;
            ShimResponse::ok(id, json!({ "sessionId": session_id, "disconnected": true }))
        }
        ShimRequest::ReapIdleEmptySessions {
            id,
            ttl_ms,
            min_age_ms,
            dry_run,
        } => {
            let result = state
                .reap_idle_empty_sessions(ttl_ms, min_age_ms, dry_run.unwrap_or(true))
                .await;
            ShimResponse::ok(id, result)
        }
    }
}

async fn require_registered_session(
    request_id: &str,
    registered_session: &Arc<Mutex<Option<String>>>,
    requested_session_id: &str,
) -> Result<(), ShimResponse> {
    let registered = registered_session.lock().await;
    match registered.as_ref() {
        None => Err(ShimResponse::error(
            request_id.to_string(),
            "session_not_registered",
            "register_session must be called before sending broker commands",
        )),
        Some(session_id) if session_id == requested_session_id => Ok(()),
        Some(_) => Err(ShimResponse::error(
            request_id.to_string(),
            "session_mismatch",
            "shim request session_id does not match the registered session for this socket",
        )),
    }
}

impl ShimResponse {
    fn ok(id: String, result: Value) -> Self {
        Self {
            response_type: "response",
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: String, code: &str, message: &str) -> Self {
        Self {
            response_type: "response",
            id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: code.to_string(),
                message: message.to_string(),
            }),
        }
    }
}

async fn reject_all_pending(state: &RuntimeBroker, reason: &str) {
    let pending = std::mem::take(&mut *state.pending.lock().await);
    for (_, request) in pending {
        let _ = state
            .broker
            .registry()
            .settle_pending_request(&request.session_id)
            .await;
        state.broker.pressure().end_pending_request();
        let _ = request
            .sender
            .send(Err(RuntimeError::InvalidExtensionMessage(
                reason.to_string(),
            )));
    }
}

async fn bind_first_available(
    host: &str,
    port_start: u16,
    port_end: u16,
) -> Result<(TcpListener, u16), RuntimeError> {
    for port in port_start..=port_end {
        let address = format!("{host}:{port}");
        match TcpListener::bind(&address).await {
            Ok(listener) => {
                let bound_port = listener
                    .local_addr()
                    .map(|addr| addr.port())
                    .unwrap_or(port);
                return Ok((listener, bound_port));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(RuntimeError::BindFailed(error.to_string())),
        }
    }
    Err(RuntimeError::BindFailed(format!(
        "No free broker port found in {port_start}-{port_end}."
    )))
}

async fn prepare_unix_socket(path: &str) -> Result<(), RuntimeError> {
    let socket_path = Path::new(path);
    if let Some(parent) = socket_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| RuntimeError::ShimIo(error.to_string()))?;
    }
    if socket_path.exists() {
        tokio::fs::remove_file(socket_path)
            .await
            .map_err(|error| RuntimeError::ShimIo(error.to_string()))?;
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as i64
}

fn is_empty_shim_session(session: &SessionStatus) -> bool {
    session.connected
        && session
            .channel
            .as_ref()
            .is_some_and(|channel| channel.channel_id == "mcp-shim")
        && session.pending_requests == 0
        && session.tab_ids.is_empty()
        && session.group_id.is_none()
        && session.active_tab_id.is_none()
}

#[cfg(test)]
mod tests {
    use super::resolve_command_timeout_ms;
    use serde_json::json;

    #[test]
    fn command_timeout_honors_tool_timeout_above_broker_floor() {
        assert_eq!(
            resolve_command_timeout_ms(15_000, &json!({ "timeoutMs": 90_000 })),
            95_000
        );
        assert_eq!(resolve_command_timeout_ms(15_000, &json!({})), 15_000);
        assert_eq!(
            resolve_command_timeout_ms(15_000, &json!({ "timeoutMs": 1_000 })),
            15_000
        );
    }
}
