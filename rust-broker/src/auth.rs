use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::error::Error;
use std::fmt;

type HmacSha256 = Hmac<Sha256>;

pub const DEFAULT_MAX_SKEW_MS: i64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelloQuery<'a> {
    pub port: u16,
    pub timestamp_ms: i64,
    pub nonce: &'a str,
    pub mac: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedHello {
    pub timestamp_ms: i64,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    InvalidTimestamp,
    TimestampOutsideWindow,
    MissingNonce,
    MissingMac,
    InvalidMacHex,
    InvalidMac,
}

impl fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTimestamp => write!(formatter, "missing or invalid timestamp"),
            Self::TimestampOutsideWindow => {
                write!(
                    formatter,
                    "handshake timestamp is outside the allowed window"
                )
            }
            Self::MissingNonce => write!(formatter, "missing nonce in handshake query"),
            Self::MissingMac => write!(formatter, "missing MAC in handshake query"),
            Self::InvalidMacHex => write!(formatter, "handshake MAC is not valid hex"),
            Self::InvalidMac => write!(formatter, "invalid handshake MAC"),
        }
    }
}

impl Error for AuthError {}

pub fn build_hello_message(port: u16, timestamp_ms: i64, nonce: &str) -> String {
    format!("hello:{port}:{timestamp_ms}:{nonce}")
}

pub fn build_bind_message(session_id: &str, client_nonce: &str, server_nonce: &str) -> String {
    format!("bind:{session_id}:{client_nonce}:{server_nonce}")
}

pub fn create_mac_hex(shared_key: impl AsRef<[u8]>, message: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(shared_key.as_ref())
        .expect("HMAC accepts shared keys of any byte length");
    mac.update(message.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn verify_mac_hex(
    shared_key: impl AsRef<[u8]>,
    message: &str,
    received_mac: &str,
) -> Result<(), AuthError> {
    let received_bytes = hex::decode(received_mac).map_err(|_| AuthError::InvalidMacHex)?;
    let mut mac = HmacSha256::new_from_slice(shared_key.as_ref())
        .expect("HMAC accepts shared keys of any byte length");
    mac.update(message.as_bytes());
    mac.verify_slice(&received_bytes)
        .map_err(|_| AuthError::InvalidMac)
}

pub fn validate_hello_query(
    shared_key: impl AsRef<[u8]>,
    query: HelloQuery<'_>,
    now_ms: i64,
    max_skew_ms: i64,
) -> Result<ValidatedHello, AuthError> {
    if query.timestamp_ms <= 0 {
        return Err(AuthError::InvalidTimestamp);
    }

    if query.nonce.is_empty() {
        return Err(AuthError::MissingNonce);
    }

    if query.mac.is_empty() {
        return Err(AuthError::MissingMac);
    }

    let skew = i128::from(now_ms)
        .checked_sub(i128::from(query.timestamp_ms))
        .map(i128::abs)
        .ok_or(AuthError::InvalidTimestamp)?;
    if skew > i128::from(max_skew_ms) {
        return Err(AuthError::TimestampOutsideWindow);
    }

    let message = build_hello_message(query.port, query.timestamp_ms, query.nonce);
    verify_mac_hex(shared_key, &message, query.mac)?;

    Ok(ValidatedHello {
        timestamp_ms: query.timestamp_ms,
        nonce: query.nonce.to_string(),
    })
}

pub fn validate_bind_proof(
    shared_key: impl AsRef<[u8]>,
    session_id: &str,
    client_nonce: &str,
    server_nonce: &str,
    received_proof: &str,
) -> Result<(), AuthError> {
    let message = build_bind_message(session_id, client_nonce, server_nonce);
    verify_mac_hex(shared_key, &message, received_proof)
}
