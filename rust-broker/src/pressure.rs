use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PressureSnapshot {
    pub active_sessions: u64,
    pub connected_channels: u64,
    pub pending_requests: u64,
    pub routed_commands: u64,
    pub rejected_commands: u64,
    pub auth_failures: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
}

#[derive(Debug, Default)]
pub struct PressureCounters {
    active_sessions: AtomicU64,
    connected_channels: AtomicU64,
    pending_requests: AtomicU64,
    routed_commands: AtomicU64,
    rejected_commands: AtomicU64,
    auth_failures: AtomicU64,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
}

impl PressureCounters {
    pub fn set_active_sessions(&self, value: u64) {
        self.active_sessions.store(value, Ordering::Release);
    }

    pub fn set_connected_channels(&self, value: u64) {
        self.connected_channels.store(value, Ordering::Release);
    }

    pub fn begin_pending_request(&self) {
        self.pending_requests.fetch_add(1, Ordering::AcqRel);
    }

    pub fn end_pending_request(&self) {
        decrement_saturating(&self.pending_requests);
    }

    pub fn observe_routed_command(&self) {
        self.routed_commands.fetch_add(1, Ordering::AcqRel);
    }

    pub fn observe_rejected_command(&self) {
        self.rejected_commands.fetch_add(1, Ordering::AcqRel);
    }

    pub fn observe_auth_failure(&self) {
        self.auth_failures.fetch_add(1, Ordering::AcqRel);
    }

    pub fn add_bytes_in(&self, value: u64) {
        self.bytes_in.fetch_add(value, Ordering::AcqRel);
    }

    pub fn add_bytes_out(&self, value: u64) {
        self.bytes_out.fetch_add(value, Ordering::AcqRel);
    }

    pub fn snapshot(&self) -> PressureSnapshot {
        PressureSnapshot {
            active_sessions: self.active_sessions.load(Ordering::Acquire),
            connected_channels: self.connected_channels.load(Ordering::Acquire),
            pending_requests: self.pending_requests.load(Ordering::Acquire),
            routed_commands: self.routed_commands.load(Ordering::Acquire),
            rejected_commands: self.rejected_commands.load(Ordering::Acquire),
            auth_failures: self.auth_failures.load(Ordering::Acquire),
            bytes_in: self.bytes_in.load(Ordering::Acquire),
            bytes_out: self.bytes_out.load(Ordering::Acquire),
        }
    }
}

fn decrement_saturating(counter: &AtomicU64) {
    let _ = counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
        Some(value.saturating_sub(1))
    });
}
