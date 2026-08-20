use umbra_rust_broker::{SessionError, SessionRegistry};
use std::collections::HashSet;

#[tokio::test]
async fn replaces_unauthenticated_channel_but_rejects_authenticated_duplicate() {
    let registry = SessionRegistry::default();

    let replaced = registry
        .attach_channel("sess_a", "chan_1", 47821, 100)
        .await
        .expect("first channel should attach");
    assert!(replaced.is_none());

    let replaced = registry
        .attach_channel("sess_a", "chan_2", 47822, 110)
        .await
        .expect("unauthenticated channel should be replaceable");
    assert_eq!(
        replaced
            .expect("first channel should be returned")
            .channel_id,
        "chan_1"
    );

    let status = registry
        .mark_authenticated("sess_a", Some("install_a".to_string()), 120)
        .await
        .expect("channel should authenticate");
    assert!(status.connected);
    assert_eq!(status.channel.expect("channel should exist").port, 47822);

    let error = registry
        .attach_channel("sess_a", "chan_3", 47823, 130)
        .await
        .expect_err("authenticated duplicate should be rejected");
    assert_eq!(
        error,
        SessionError::SessionAlreadyConnected {
            session_id: "sess_a".to_string()
        }
    );
}

#[tokio::test]
async fn enforces_tab_ownership_before_routing() {
    let registry = SessionRegistry::default();
    registry
        .attach_channel("sess_a", "chan_a", 47821, 100)
        .await
        .expect("session A should attach");
    registry
        .mark_authenticated("sess_a", Some("install_a".to_string()), 110)
        .await
        .expect("session A should authenticate");
    registry
        .attach_channel("sess_b", "chan_b", 47822, 100)
        .await
        .expect("session B should attach");
    registry
        .mark_authenticated("sess_b", Some("install_b".to_string()), 110)
        .await
        .expect("session B should authenticate");

    registry
        .claim_tab("sess_a", 101)
        .await
        .expect("session A should claim tab");

    let target = registry
        .route_tab("sess_a", 101)
        .await
        .expect("owner should route to owned tab");
    assert_eq!(target.channel_id, "chan_a");
    assert_eq!(target.tab_id, Some(101));

    let error = registry
        .route_tab("sess_b", 101)
        .await
        .expect_err("non-owner must not route to tab");
    assert_eq!(
        error,
        SessionError::TabAlreadyOwned {
            tab_id: 101,
            owner_session_id: "sess_a".to_string()
        }
    );

    assert_eq!(registry.release_tab(101).await.as_deref(), Some("sess_a"));
    registry
        .claim_tab("sess_b", 101)
        .await
        .expect("released tab should be claimable by session B");
}

#[tokio::test]
async fn tracks_pending_requests_in_session_status() {
    let registry = SessionRegistry::default();

    // The session has to exist first. Only ensure_session and the register path
    // create records; a follow-up mutation on a session that is gone is a
    // no-op rather than a resurrection.
    registry.ensure_session("sess_a").await;
    registry.add_pending_request("sess_a").await;
    registry.add_pending_request("sess_a").await;
    let status = registry
        .status("sess_a")
        .await
        .expect("session should exist");
    assert_eq!(status.pending_requests, 2);

    registry
        .settle_pending_request("sess_a")
        .await
        .expect("first pending request should settle");
    let status = registry
        .status("sess_a")
        .await
        .expect("session should exist");
    assert_eq!(status.pending_requests, 1);

    registry.detach_channel("sess_a").await;
    let status = registry
        .status("sess_a")
        .await
        .expect("session should exist");
    assert_eq!(status.pending_requests, 0);
}

#[tokio::test]
async fn reaps_only_idle_empty_mcp_shim_sessions() {
    let registry = SessionRegistry::default();
    let protected = HashSet::from(["umbra-rust-broker".to_string()]);

    registry
        .attach_channel("empty_old", "mcp-shim", 0, 100)
        .await
        .expect("empty shim should attach");
    registry
        .mark_authenticated("empty_old", None, 110)
        .await
        .expect("empty shim should authenticate");

    registry
        .attach_channel("with_tab", "mcp-shim", 0, 100)
        .await
        .expect("tab shim should attach");
    registry
        .mark_authenticated("with_tab", None, 110)
        .await
        .expect("tab shim should authenticate");
    registry
        .claim_tab("with_tab", 44)
        .await
        .expect("tab shim should own a tab");

    registry
        .attach_channel("with_pending", "mcp-shim", 0, 100)
        .await
        .expect("pending shim should attach");
    registry
        .mark_authenticated("with_pending", None, 110)
        .await
        .expect("pending shim should authenticate");
    registry.add_pending_request("with_pending").await;

    registry
        .attach_channel("umbra-rust-broker", "extension", 47821, 100)
        .await
        .expect("extension channel should attach");
    registry
        .mark_authenticated(
            "umbra-rust-broker",
            Some("extension".to_string()),
            110,
        )
        .await
        .expect("extension channel should authenticate");

    let candidates = registry
        .idle_empty_reap_candidates(20 * 60 * 1000, 5 * 60 * 1000, 5 * 60 * 1000, &protected)
        .await;
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].session_id, "empty_old");

    let detached = registry
        .detach_idle_empty_session(
            "empty_old",
            20 * 60 * 1000,
            5 * 60 * 1000,
            5 * 60 * 1000,
            &protected,
        )
        .await
        .expect("idle empty shim should detach");
    assert_eq!(detached.session_id, "empty_old");

    assert!(registry.status("empty_old").await.is_none());
    assert!(registry.status("with_tab").await.is_some());
    assert!(registry.status("with_pending").await.is_some());
    assert!(registry
        .status("umbra-rust-broker")
        .await
        .is_some());
}

#[tokio::test]
async fn a_late_observation_never_resurrects_a_removed_session() {
    let registry = SessionRegistry::default();
    registry.ensure_session("sess_gone").await;
    registry.detach_session("sess_gone").await;

    // This is what an extension answer arriving after its shim died looks like.
    // It used to recreate the record with no channel, hand it a live tab, and
    // leave a zombie the idle reaper would not touch.
    registry.touch_session("sess_gone").await;
    registry.add_pending_request("sess_gone").await;
    assert!(registry.claim_tab("sess_gone", 900).await.is_err());
    registry.set_group("sess_gone", 5).await;

    assert!(
        registry.status("sess_gone").await.is_none(),
        "a post-hoc mutation recreated a session that was already removed"
    );
    assert!(registry.statuses().await.is_empty());
}

#[tokio::test]
async fn releasing_a_tab_is_ownership_checked_like_claiming_one() {
    let registry = SessionRegistry::default();
    registry.ensure_session("sess_a").await;
    registry.ensure_session("sess_b").await;
    registry
        .claim_tab("sess_a", 500)
        .await
        .expect("session A should claim its own tab");

    // Claiming refuses a foreign tab, so releasing must too, or one session's
    // result can drop another session's ownership record.
    assert!(registry.release_tab_owned("sess_b", 500).await.is_none());
    let status = registry.status("sess_a").await.expect("session A should exist");
    assert!(status.tab_ids.contains(&500), "a foreign release dropped the owner's tab");

    assert_eq!(
        registry.release_tab_owned("sess_a", 500).await.as_deref(),
        Some("sess_a")
    );
}
