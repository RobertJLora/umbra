use umbra_rust_broker::{BrokerConfig, PressureCounters, RustBroker};
use serde_json::json;

#[test]
fn pressure_counters_track_requests_and_saturate_on_end() {
    let counters = PressureCounters::default();

    counters.set_active_sessions(2);
    counters.set_connected_channels(1);
    counters.begin_pending_request();
    counters.begin_pending_request();
    counters.observe_routed_command();
    counters.observe_rejected_command();
    counters.observe_auth_failure();
    counters.add_bytes_in(128);
    counters.add_bytes_out(256);

    let snapshot = counters.snapshot();
    assert_eq!(snapshot.active_sessions, 2);
    assert_eq!(snapshot.connected_channels, 1);
    assert_eq!(snapshot.pending_requests, 2);
    assert_eq!(snapshot.routed_commands, 1);
    assert_eq!(snapshot.rejected_commands, 1);
    assert_eq!(snapshot.auth_failures, 1);
    assert_eq!(snapshot.bytes_in, 128);
    assert_eq!(snapshot.bytes_out, 256);

    counters.end_pending_request();
    counters.end_pending_request();
    counters.end_pending_request();
    assert_eq!(counters.snapshot().pending_requests, 0);
}

#[tokio::test]
async fn broker_health_reports_sessions_and_pressure() {
    let broker = RustBroker::new(BrokerConfig {
        shared_key: "test-shared-key".to_string(),
        ..BrokerConfig::default()
    });

    broker
        .attach_session_channel("sess_a", "chan_a", 47821, 100)
        .await
        .expect("channel should attach");
    broker
        .authenticate_session("sess_a", Some("install_a".to_string()), 110)
        .await
        .expect("session should authenticate");
    broker
        .registry()
        .claim_tab("sess_a", 101)
        .await
        .expect("tab should be owned by session");

    let command = broker
        .route_tab_command(
            "sess_a",
            101,
            "browser_get_page_content",
            json!({ "tabId": 101 }),
        )
        .await
        .expect("owned tab command should route");
    assert_eq!(command.target.channel_id, "chan_a");

    let rejected = broker
        .route_tab_command(
            "sess_a",
            202,
            "browser_get_page_content",
            json!({ "tabId": 202 }),
        )
        .await
        .expect_err("unowned tab should reject");
    assert!(rejected.to_string().contains("not owned"));

    let health = broker.health().await;
    assert!(health.ok);
    assert!(health.extension_connected);
    assert_eq!(health.sessions.len(), 1);
    assert_eq!(health.sessions[0].session_id, "sess_a");
    assert_eq!(health.sessions[0].tab_ids, vec![101]);
    assert_eq!(health.pressure.active_sessions, 1);
    assert_eq!(health.pressure.connected_channels, 1);
    assert_eq!(health.pressure.routed_commands, 1);
    assert_eq!(health.pressure.rejected_commands, 1);

    let encoded = serde_json::to_value(&health).expect("health should serialize");
    assert_eq!(encoded["name"], "umbra");
    assert_eq!(encoded["mode"], "rust_opt_in");
}
