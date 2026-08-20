use crate::pressure::PressureSnapshot;
use crate::session::SessionStatus;
use serde::{Deserialize, Serialize};

pub const BROKER_NAME: &str = "umbra";
pub const PROTOCOL_VERSION: u16 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerMode {
    LegacyDefault,
    RustOptIn,
    RustBroker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortRange {
    pub start: u16,
    pub end: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrokerListener {
    pub host: String,
    pub port: Option<u16>,
    pub port_range: PortRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrokerHealth {
    pub ok: bool,
    pub name: String,
    pub mode: BrokerMode,
    pub protocol_version: u16,
    pub listener: BrokerListener,
    pub extension_connected: bool,
    pub sessions: Vec<SessionStatus>,
    pub pressure: PressureSnapshot,
}
