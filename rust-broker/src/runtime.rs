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
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, Mutex, Notify, RwLock};
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
    extension_generation_counter: Arc<AtomicU64>,
}

/// The live extension websocket, plus the identity that makes teardown safe.
///
/// `generation` is stamped when a socket binds and never reused. A socket clears
/// the shared handle only when the stored generation is still its own, so an old
/// socket's exit path cannot wipe a newer socket's registration and leave the
/// broker permanently reporting `ExtensionNotConnected`.
///
/// `displaced` is signalled when a newer socket takes over, so the older one
/// closes instead of lingering as a half-live connection Chrome will never
/// redial past.
#[derive(Debug, Clone)]
struct ExtensionHandle {
    generation: u64,
    sender: mpsc::Sender<Value>,
    extension_instance_id: Option<String>,
    displaced: Arc<Notify>,
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
            extension_generation_counter: Arc::new(AtomicU64::new(1)),
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
        restrict_socket_permissions(&state.config.socket_path)?;

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

    /// Register a freshly bound extension socket as the live one and return the
    /// generation that identifies it.
    ///
    /// A duplicate bind displaces the previous socket rather than silently
    /// overwriting it: two Chrome profiles pasted with the same key both scan
    /// the same port range, and the machine-wide key means both can reach the
    /// same broker. The previous socket is signalled so it closes its own loop
    /// instead of lingering as a connection the broker no longer routes to.
    async fn install_extension_handle(
        &self,
        sender: mpsc::Sender<Value>,
        extension_instance_id: Option<String>,
        displaced: Arc<Notify>,
    ) -> u64 {
        let generation = self
            .extension_generation_counter
            .fetch_add(1, Ordering::AcqRel);
        let handle = ExtensionHandle {
            generation,
            sender,
            extension_instance_id,
            displaced,
        };
        let previous = self.extension.write().await.replace(handle);
        if let Some(previous) = previous {
            previous.displaced.notify_one();
        }
        generation
    }

    /// True when an extension socket is currently registered.
    async fn has_extension_handle(&self) -> bool {
        self.extension.read().await.is_some()
    }

    /// Clear the live extension handle, but only when it is still the one this
    /// generation installed.
    ///
    /// Returns true when the handle was actually cleared, which is the caller's
    /// signal that it also owns the disconnect side effects: rejecting pending
    /// requests and detaching the registry channel. A stale socket returns false
    /// and touches nothing, so its exit cannot orphan a live connection.
    async fn release_extension_handle(&self, generation: u64) -> bool {
        let mut extension = self.extension.write().await;
        let is_current = extension
            .as_ref()
            .is_some_and(|handle| handle.generation == generation);
        if is_current {
            *extension = None;
        }
        is_current
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
        // Every command routes by session. Commands carrying an explicit `tabId`
        // used to be gated against the broker's own tab map first, but that map
        // is in-memory only and is never rehydrated, so after a broker restart
        // or after `browser_adopt_group` the gate rejected commands for tabs the
        // extension still owned, with a `TabNotOwned` message the shim's
        // reconnect matcher does not recognise. Ownership is enforced where the
        // tabs actually live: `getOwnedTab` in the extension calls
        // `sessionStore.assertOwned` against `chrome.storage.session`, which
        // survives a restart. The broker keeps its map for status and health
        // reporting, populated by `observe_tool_result`.
        if let Err(error) = self.broker.route_session_command(session_id).await {
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
        // Decide the branch up front so no borrow of `message` outlives the point
        // where the result subtree is moved out of it below.
        let is_result = message_type == "result";
        let is_error = message_type == "error";
        if !is_result && !is_error {
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
                if is_result {
                    if let Some(result) = message.get("result") {
                        self.observe_tool_result(&late.session_id, &late.tool, result)
                            .await;
                    }
                }
            }
            return Ok(());
        };
        let response = if is_result {
            // Move the result subtree out instead of cloning it. On a multi-megabyte
            // screenshot envelope the clone is a second full copy of the payload
            // resident at once, which is what peak memory looks like when several
            // agents capture at the same time.
            Ok(match message {
                Value::Object(mut map) => map.remove("result").unwrap_or(Value::Null),
                _ => Value::Null,
            })
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
            // `browser_adopt_group` is the documented resume path: it hands a
            // whole existing Chrome group to the session and returns every tab in
            // it. Nothing observed that array, so the broker's map stayed empty
            // and its health output reported a session with no tabs. It gets its
            // own arm rather than joining the list-tabs arm above, because that
            // arm deliberately sets no active tab, and the extension sets both
            // the group and the first tab as active at
            // `extension/background.js:1170`.
            "browser_adopt_group" => {
                if result.get("adopted").and_then(Value::as_bool) == Some(false) {
                    return;
                }
                let Some(tabs) = result.get("tabs").and_then(Value::as_array) else {
                    return;
                };
                let mut first_claimed: Option<u64> = None;
                for tab in tabs {
                    let Some(tab_id) = tab
                        .get("tabId")
                        .or_else(|| tab.get("id"))
                        .and_then(Value::as_u64)
                    else {
                        continue;
                    };
                    if self
                        .broker
                        .registry()
                        .claim_tab(session_id, tab_id)
                        .await
                        .is_ok()
                        && first_claimed.is_none()
                    {
                        first_claimed = Some(tab_id);
                    }
                }
                if let Some(group_id) = result.get("groupId").and_then(Value::as_i64) {
                    self.broker.registry().set_group(session_id, group_id).await;
                }
                if let Some(tab_id) = first_claimed {
                    let _ = self
                        .broker
                        .registry()
                        .set_active_tab(session_id, tab_id)
                        .await;
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
    let mut generation: Option<u64> = None;
    let displaced = Arc::new(Notify::new());
    let bind_deadline = time::sleep(Duration::from_millis(state.config.bind_timeout_ms));
    tokio::pin!(bind_deadline);

    loop {
        tokio::select! {
            _ = &mut bind_deadline, if !authenticated => {
                state.broker.pressure().observe_auth_failure();
                writer.abort();
                return;
            }
            // A newer socket bound and took over. Close this one instead of
            // holding a connection the broker no longer routes anything to.
            // `notify_one` stores its permit, so a signal that lands between two
            // loop iterations is still delivered here.
            _ = displaced.notified() => {
                break;
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

                // Answered before the authentication check as well, so an early
                // ping is never mistaken for a failed bind and used to close the
                // socket. The bind deadline still closes an unauthenticated
                // connection on schedule.
                if let Some(pong) = keepalive_reply(message_type) {
                    let _ = outbound_sender.send(pong).await;
                    continue;
                }

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
                    // A previous socket may still hold the registry channel for
                    // the broker session. Release it before attaching the
                    // replacement, because `attach_channel` refuses a duplicate
                    // on an already-authenticated channel and the registry would
                    // otherwise keep describing the socket being displaced.
                    if state.has_extension_handle().await {
                        let _ = state
                            .broker
                            .registry()
                            .detach_channel(&broker_session_id)
                            .await;
                    }
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
                    generation = Some(
                        state
                            .install_extension_handle(
                                outbound_sender.clone(),
                                extension_instance_id,
                                Arc::clone(&displaced),
                            )
                            .await,
                    );
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

    // Only the socket that is still registered may run the disconnect side
    // effects. An older socket exiting after a newer one bound used to clear the
    // handle, reject every pending request process-wide, and detach the channel,
    // which left the broker convinced no extension was connected while the live
    // socket sat there working. Nothing recovered from that: the offscreen
    // document skips redialing a port whose socket is OPEN, and the shim only
    // destroys its own connection to the same wedged broker.
    let was_registered = match generation {
        Some(generation) => state.release_extension_handle(generation).await,
        None => false,
    };
    if was_registered {
        reject_all_pending(&state, "extension disconnected").await;
        let _ = state
            .broker
            .registry()
            .detach_channel(&broker_session_id)
            .await;
    }
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

/// Answer an application-level keepalive frame from the extension.
///
/// Browser JavaScript cannot send a WebSocket protocol ping and never sees a
/// pong frame, so the offscreen document detects a dead-but-OPEN socket by
/// sending a `ping` message and watching for this answer. The broker drops every
/// message type it does not recognise, so before this existed the ping went
/// unanswered and an extension running a keepalive timer would tear down healthy
/// idle sessions on a loop.
fn keepalive_reply(message_type: &str) -> Option<Value> {
    if message_type == "ping" {
        Some(json!({ "type": "pong", "ts": now_ms() }))
    } else {
        None
    }
}

/// Restrict the shim socket to its owner.
///
/// Nothing set a mode before, so the live socket was `srwxr-xr-x` purely because
/// of the ambient umask. A user with umask 002, or anyone on Linux, ended up
/// with a world-connectable socket, and the shim's `register_session` path
/// carries no HMAC proof: whoever can connect can drive the signed-in browser.
/// 0600 makes the file system the gate.
fn restrict_socket_permissions(path: &str) -> Result<(), RuntimeError> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| RuntimeError::ShimIo(error.to_string()))
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
    use super::*;

    fn test_broker() -> RuntimeBroker {
        RuntimeBroker::new(BrokerConfig {
            shared_key: "unit-test-key".to_string(),
            request_timeout_ms: 2_000,
            ..BrokerConfig::default()
        })
    }

    async fn register_shim_session(state: &RuntimeBroker, session_id: &str) {
        state.broker.registry().ensure_session(session_id).await;
        state
            .broker
            .attach_session_channel(session_id, "mcp-shim", 0, now_ms() as u64)
            .await
            .expect("shim channel should attach");
        state
            .broker
            .authenticate_session(session_id, None, now_ms() as u64)
            .await
            .expect("shim channel should authenticate");
    }

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

    #[tokio::test]
    async fn a_stale_extension_socket_teardown_leaves_the_live_handle_registered() {
        let state = test_broker();

        let (first_sender, _first_receiver) = mpsc::channel(4);
        let first_displaced = Arc::new(Notify::new());
        let first = state
            .install_extension_handle(
                first_sender,
                Some("profile_one".to_string()),
                Arc::clone(&first_displaced),
            )
            .await;

        let (second_sender, _second_receiver) = mpsc::channel(4);
        let second_displaced = Arc::new(Notify::new());
        let second = state
            .install_extension_handle(
                second_sender,
                Some("profile_two".to_string()),
                Arc::clone(&second_displaced),
            )
            .await;
        assert_ne!(first, second, "each bind takes a fresh generation");

        time::timeout(Duration::from_secs(1), first_displaced.notified())
            .await
            .expect("the displaced socket is told to close instead of lingering");

        assert!(
            !state.release_extension_handle(first).await,
            "an older socket's exit path must not clear a newer registration"
        );
        let live = state
            .extension
            .read()
            .await
            .clone()
            .expect("the second socket is still registered");
        assert_eq!(live.generation, second);
        assert_eq!(live.extension_instance_id.as_deref(), Some("profile_two"));

        assert!(state.release_extension_handle(second).await);
        assert!(state.extension.read().await.is_none());
    }

    #[tokio::test]
    async fn adopt_group_result_claims_every_tab_and_activates_the_first() {
        let state = test_broker();
        register_shim_session(&state, "sess_a").await;

        // Claim an unrelated tab first, so the active-tab assertion proves the
        // arm sets it rather than inheriting claim_tab's first-claim default.
        state
            .broker
            .registry()
            .claim_tab("sess_a", 99)
            .await
            .expect("session should claim its own tab");
        assert_eq!(
            state
                .broker
                .registry()
                .status("sess_a")
                .await
                .expect("session should exist")
                .active_tab_id,
            Some(99)
        );

        state
            .observe_tool_result(
                "sess_a",
                "browser_adopt_group",
                &json!({
                    "adopted": true,
                    "groupId": 7,
                    "tabCount": 3,
                    "tabs": [
                        { "id": 11, "tabId": 11 },
                        { "id": 12, "tabId": 12 },
                        { "id": 13, "tabId": 13 }
                    ]
                }),
            )
            .await;

        let status = state
            .broker
            .registry()
            .status("sess_a")
            .await
            .expect("session should exist");
        assert_eq!(status.tab_ids, vec![11, 12, 13, 99]);
        assert_eq!(status.active_tab_id, Some(11));
        assert_eq!(status.group_id, Some(7));
    }

    #[tokio::test]
    async fn a_refused_adopt_group_claims_nothing() {
        let state = test_broker();
        register_shim_session(&state, "sess_a").await;

        state
            .observe_tool_result(
                "sess_a",
                "browser_adopt_group",
                &json!({
                    "adopted": false,
                    "groupId": 7,
                    "refused": [{ "tabId": 11, "reason": "internal_tab" }],
                    "message": "Group contains live-owned or browser-internal tabs and was not adopted."
                }),
            )
            .await;

        let status = state
            .broker
            .registry()
            .status("sess_a")
            .await
            .expect("session should exist");
        assert!(status.tab_ids.is_empty());
        assert_eq!(status.active_tab_id, None);
        assert_eq!(status.group_id, None);
    }

    #[tokio::test]
    async fn a_command_for_an_unseen_tab_id_is_forwarded_to_the_extension() {
        let state = test_broker();
        register_shim_session(&state, "sess_a").await;

        let (sender, mut receiver) = mpsc::channel(4);
        state
            .install_extension_handle(sender, None, Arc::new(Notify::new()))
            .await;

        let caller = state.clone();
        let call = tokio::spawn(async move {
            caller
                .route_extension_command(
                    "sess_a",
                    "browser_get_page_content",
                    json!({ "tabId": 4242 }),
                )
                .await
        });

        let forwarded = time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .expect("the broker forwards instead of rejecting a tab it has never seen")
            .expect("the extension channel stays open");
        assert_eq!(forwarded["tool"], "browser_get_page_content");
        assert_eq!(forwarded["sessionId"], "sess_a");
        assert_eq!(forwarded["params"]["tabId"], 4242);

        let request_id = forwarded["id"]
            .as_str()
            .expect("forwarded command carries a request id")
            .to_string();
        state
            .settle_extension_message(json!({
                "type": "result",
                "id": request_id,
                "result": { "content": "ok" }
            }))
            .await
            .expect("the extension result settles the pending request");

        let result = call
            .await
            .expect("command task should not panic")
            .expect("command should succeed");
        assert_eq!(result["content"], "ok");
    }

    #[test]
    fn keepalive_answers_ping_and_ignores_everything_else() {
        let pong = keepalive_reply("ping").expect("a ping is answered");
        assert_eq!(pong["type"], "pong");
        assert!(pong["ts"].as_i64().is_some());
        assert!(keepalive_reply("result").is_none());
        assert!(keepalive_reply("bind").is_none());
    }

    #[tokio::test]
    async fn the_shim_socket_is_created_owner_only() {
        let dir = std::env::temp_dir().join(format!(
            "umbra-broker-perm-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = dir.join("broker.sock").to_string_lossy().into_owned();

        prepare_unix_socket(&path)
            .await
            .expect("socket parent directory should be created");
        let listener = UnixListener::bind(&path).expect("socket should bind");
        restrict_socket_permissions(&path).expect("socket mode should be set");

        let mode = std::fs::metadata(&path)
            .expect("socket should exist")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "another local account must not be able to connect to the shim socket"
        );

        drop(listener);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
