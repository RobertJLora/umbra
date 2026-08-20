use umbra_rust_broker::{
    build_bind_message, build_hello_message, build_register_message, create_mac_hex,
    validate_bind_proof, validate_hello_query, validate_register_proof, AuthError, HelloQuery,
    DEFAULT_MAX_SKEW_MS,
};

#[test]
fn validates_hello_hmac_with_allowed_timestamp_skew() {
    let shared_key = "test-shared-key";
    let port = 47821;
    let timestamp_ms = 1_710_000_000_000;
    let nonce = "client_nonce";
    let mac = create_mac_hex(shared_key, &build_hello_message(port, timestamp_ms, nonce));

    let result = validate_hello_query(
        shared_key,
        HelloQuery {
            port,
            timestamp_ms,
            nonce,
            mac: &mac,
        },
        timestamp_ms + 500,
        DEFAULT_MAX_SKEW_MS,
    )
    .expect("valid hello HMAC should pass");

    assert_eq!(result.timestamp_ms, timestamp_ms);
    assert_eq!(result.nonce, nonce);
}

#[test]
fn rejects_forged_hello_hmac() {
    let error = validate_hello_query(
        "test-shared-key",
        HelloQuery {
            port: 47821,
            timestamp_ms: 1_710_000_000_000,
            nonce: "client_nonce",
            mac: "0000000000000000000000000000000000000000000000000000000000000000",
        },
        1_710_000_000_000,
        DEFAULT_MAX_SKEW_MS,
    )
    .expect_err("forged hello HMAC should fail");

    assert_eq!(error, AuthError::InvalidMac);
}

#[test]
fn rejects_stale_hello_timestamp() {
    let shared_key = "test-shared-key";
    let timestamp_ms = 1_710_000_000_000;
    let nonce = "client_nonce";
    let mac = create_mac_hex(shared_key, &build_hello_message(47821, timestamp_ms, nonce));

    let error = validate_hello_query(
        shared_key,
        HelloQuery {
            port: 47821,
            timestamp_ms,
            nonce,
            mac: &mac,
        },
        timestamp_ms + DEFAULT_MAX_SKEW_MS + 1,
        DEFAULT_MAX_SKEW_MS,
    )
    .expect_err("stale hello timestamp should fail");

    assert_eq!(error, AuthError::TimestampOutsideWindow);
}

#[test]
fn validates_bind_proof_against_session_and_nonces() {
    let shared_key = "test-shared-key";
    let session_id = "sess_123";
    let client_nonce = "client";
    let server_nonce = "server";
    let proof = create_mac_hex(
        shared_key,
        &build_bind_message(session_id, client_nonce, server_nonce),
    );

    validate_bind_proof(shared_key, session_id, client_nonce, server_nonce, &proof)
        .expect("matching bind proof should pass");

    let error = validate_bind_proof(shared_key, session_id, client_nonce, "other_server", &proof)
        .expect_err("mismatched bind proof should fail");
    assert_eq!(error, AuthError::InvalidMac);
}

#[test]
fn validates_register_hmac_over_the_session_id() {
    let shared_key = "test-shared-key";
    let session_id = "sess_shared";
    let mac = create_mac_hex(shared_key, &build_register_message(session_id));

    validate_register_proof(shared_key, session_id, &mac)
        .expect("matching register HMAC should pass");

    let missing = validate_register_proof(shared_key, session_id, "")
        .expect_err("an empty register HMAC should fail");
    assert_eq!(missing, AuthError::MissingMac);

    let forged = validate_register_proof(
        shared_key,
        session_id,
        "0000000000000000000000000000000000000000000000000000000000000000",
    )
    .expect_err("a forged register HMAC should fail");
    assert_eq!(forged, AuthError::InvalidMac);
}
