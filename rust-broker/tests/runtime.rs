use umbra_rust_broker::{create_mac_hex, BrokerConfig, RuntimeBroker};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
#[ignore = "binds loopback TCP and Unix sockets; run explicitly for live broker parity"]
async fn runtime_routes_shim_commands_through_one_extension_socket_and_denies_cross_session_tabs() {
    let shared_key = "runtime-test-key";
    let socket_path = format!(
        "/tmp/umbra-runtime-test-{}-{}.sock",
        std::process::id(),
        now_ms()
    );
    let config = BrokerConfig {
        shared_key: shared_key.to_string(),
        host: "127.0.0.1".to_string(),
        port_start: 0,
        port_end: 0,
        bound_port: None,
        mode: umbra_rust_broker::BrokerMode::RustBroker,
        request_timeout_ms: 2_000,
        bind_timeout_ms: 2_000,
        idle_empty_session_ttl_ms: 20 * 60 * 1000,
        idle_empty_session_min_age_ms: 5 * 60 * 1000,
        idle_reaper_interval_ms: 60 * 1000,
        broker_session_id: "runtime-test-broker".to_string(),
        socket_path: socket_path.clone(),
    };

    let broker_task = tokio::spawn(async move { RuntimeBroker::new(config).serve().await });
    time::sleep(Duration::from_millis(10)).await;
    if broker_task.is_finished() {
        let result = broker_task.await.expect("broker task should not panic");
        panic!("Rust broker exited before test connected: {result:?}");
    }

    let mut shim = connect_shim(&socket_path, &broker_task).await;
    let health = send_shim(&mut shim, json!({ "type": "health", "id": "health_1" })).await;
    let port = health["result"]["listener"]["port"]
        .as_u64()
        .expect("broker health should report a bound websocket port");

    let mut extension = connect_extension(shared_key, port as u16).await;

    let registered = send_shim(
        &mut shim,
        json!({
            "type": "register_session",
            "id": "register_a",
            "session_id": "sess_a"
        }),
    )
    .await;
    assert_eq!(registered["ok"], true);

    let command = json!({
        "type": "command",
        "id": "cmd_create",
        "session_id": "sess_a",
        "tool": "browser_create_tab",
        "params": { "url": "https://example.com", "activate": false }
    });
    let command_result = tokio::spawn(async move { send_shim(&mut shim, command).await });

    let routed = read_ws_json(&mut extension).await;
    assert_eq!(routed["type"], "command");
    assert_eq!(routed["sessionId"], "sess_a");
    assert_eq!(routed["tool"], "browser_create_tab");
    let request_id = routed["id"].as_str().unwrap();
    let mut health_shim = connect_shim(&socket_path, &broker_task).await;
    let in_flight = send_shim(
        &mut health_shim,
        json!({ "type": "health", "id": "health_pending" }),
    )
    .await;
    let sess_a = in_flight["result"]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["session_id"] == "sess_a")
        .expect("sess_a should be listed in health while command is pending");
    assert_eq!(sess_a["pending_requests"], 1);
    extension
        .send(Message::Text(
            json!({
                "type": "result",
                "id": request_id,
                "result": { "tabId": 44, "url": "https://example.com" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let created = command_result.await.unwrap();
    assert_eq!(created["ok"], true);
    assert_eq!(created["result"]["tabId"], 44);

    let mut shim_b = connect_shim(&socket_path, &broker_task).await;
    let _ = send_shim(
        &mut shim_b,
        json!({
            "type": "register_session",
            "id": "register_b",
            "session_id": "sess_b"
        }),
    )
    .await;

    let impersonated_command = send_shim(
        &mut shim_b,
        json!({
            "type": "command",
            "id": "cmd_impersonate",
            "session_id": "sess_a",
            "tool": "browser_get_page_content",
            "params": { "tabId": 44 }
        }),
    )
    .await;
    assert_eq!(impersonated_command["ok"], false);
    assert_eq!(impersonated_command["error"]["code"], "session_mismatch");

    let impersonated_disconnect = send_shim(
        &mut shim_b,
        json!({
            "type": "disconnect_session",
            "id": "disconnect_impersonate",
            "session_id": "sess_a",
            "reason": "malicious_disconnect"
        }),
    )
    .await;
    assert_eq!(impersonated_disconnect["ok"], false);
    assert_eq!(impersonated_disconnect["error"]["code"], "session_mismatch");

    let denied = send_shim(
        &mut shim_b,
        json!({
            "type": "command",
            "id": "cmd_cross",
            "session_id": "sess_b",
            "tool": "browser_get_page_content",
            "params": { "tabId": 44 }
        }),
    )
    .await;
    assert_eq!(denied["ok"], false);
    let denial_message = denied["error"]["message"].as_str().unwrap();
    assert!(denial_message.contains("tab 44"));
    assert!(
        denial_message.contains("already owned by session sess_a")
            || denial_message.contains("not owned by session sess_b")
    );

    broker_task.abort();
    let _ = tokio::fs::remove_file(socket_path).await;
}

async fn connect_shim(
    socket_path: &str,
    broker_task: &tokio::task::JoinHandle<
        Result<(), umbra_rust_broker::RuntimeError>,
    >,
) -> BufReader<UnixStream> {
    for _ in 0..50 {
        match UnixStream::connect(socket_path).await {
            Ok(stream) => return BufReader::new(stream),
            Err(_) => {
                assert!(
                    !broker_task.is_finished(),
                    "Rust broker task exited before shim socket was ready"
                );
                time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    panic!("Rust broker shim socket did not become ready");
}

async fn send_shim(stream: &mut BufReader<UnixStream>, payload: Value) -> Value {
    let line = format!("{payload}\n");
    stream.get_mut().write_all(line.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_line(&mut response).await.unwrap();
    serde_json::from_str(response.trim()).unwrap()
}

async fn connect_extension(
    shared_key: &str,
    port: u16,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let timestamp = now_ms();
    let nonce = "client-runtime-nonce";
    let mac = create_mac_hex(
        shared_key.as_bytes(),
        &format!("hello:{port}:{timestamp}:{nonce}"),
    );
    let url = format!("ws://127.0.0.1:{port}/bridge?ts={timestamp}&nonce={nonce}&mac={mac}");
    let (mut websocket, _) = connect_async(url).await.unwrap();
    let hello_ack = read_ws_json(&mut websocket).await;
    assert_eq!(hello_ack["type"], "hello_ack");
    assert_eq!(hello_ack["protocolVersion"], 2);
    assert_eq!(hello_ack["broker"], true);
    let server_nonce = hello_ack["serverNonce"].as_str().unwrap();
    let session_id = hello_ack["sessionId"].as_str().unwrap();
    let proof = create_mac_hex(
        shared_key.as_bytes(),
        &format!("bind:{session_id}:{nonce}:{server_nonce}"),
    );
    websocket
        .send(Message::Text(
            json!({
                "type": "bind",
                "extensionInstanceId": "runtime-test-extension",
                "proof": proof
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let bind_ack = read_ws_json(&mut websocket).await;
    assert_eq!(bind_ack["type"], "bind_ack");
    assert_eq!(bind_ack["protocolVersion"], 2);
    websocket
}

async fn read_ws_json<S>(websocket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = websocket.next().await.unwrap().unwrap();
    let Message::Text(text) = message else {
        panic!("expected text websocket message");
    };
    serde_json::from_str(&text).unwrap()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as i64
}
