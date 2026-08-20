use crate::health::{
    BrokerHealth, BrokerListener, BrokerMode, PortRange, BROKER_NAME, PROTOCOL_VERSION,
};
use crate::pressure::PressureCounters;
use crate::session::{RoutingTarget, SessionError, SessionRegistry};
use std::env;
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT_START: u16 = 47821;
const DEFAULT_PORT_END: u16 = 47852;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_BIND_TIMEOUT_MS: u64 = 5_000;
const DEFAULT_IDLE_EMPTY_SESSION_TTL_MS: u64 = 20 * 60 * 1000;
const DEFAULT_IDLE_EMPTY_SESSION_MIN_AGE_MS: u64 = 5 * 60 * 1000;
const DEFAULT_IDLE_REAPER_INTERVAL_MS: u64 = 60 * 1000;
const DEFAULT_BROKER_SESSION_ID: &str = "umbra-rust-broker";

/// Per-user default for the shim socket, mirroring `resolveBrokerSocketPath()`
/// in `mcp-server/config.js`.
///
/// The two resolvers must produce the identical string: the broker binds this
/// path and the Node companion dials it, so any divergence leaves the shim
/// connecting to a socket nothing ever created. That is also why this function
/// does not consult `XDG_RUNTIME_DIR`, even though a runtime directory is the
/// conventional home for a socket on Linux; the Node resolver does not consult
/// it either, and anyone who wants the socket elsewhere sets
/// `UMBRA_BROKER_SOCKET` on both sides.
///
/// The old default lived at `/tmp/umbra-rust-broker.sock`. `/tmp` is
/// world-writable, so an unprivileged local account could pre-create that path
/// and make the startup `remove_file` fail under the sticky bit, which is a
/// denial of service against every session on the machine.
fn default_broker_socket_path() -> String {
    let home = env::var("HOME").unwrap_or_default();
    let trimmed = home.trim();
    let base = if trimmed.is_empty() {
        // HOME is unset only in a broken environment. Anchor to the current
        // directory rather than to world-writable /tmp, and expect anyone
        // running that way to set UMBRA_BROKER_SOCKET explicitly.
        PathBuf::from(".umbra")
    } else {
        Path::new(trimmed).join(".umbra")
    };
    base.join("run")
        .join("broker.sock")
        .to_string_lossy()
        .into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerConfig {
    pub shared_key: String,
    pub host: String,
    pub port_start: u16,
    pub port_end: u16,
    pub bound_port: Option<u16>,
    pub mode: BrokerMode,
    pub request_timeout_ms: u64,
    pub bind_timeout_ms: u64,
    pub idle_empty_session_ttl_ms: u64,
    pub idle_empty_session_min_age_ms: u64,
    pub idle_reaper_interval_ms: u64,
    pub broker_session_id: String,
    pub socket_path: String,
}

impl Default for BrokerConfig {
    fn default() -> Self {
        Self {
            shared_key: String::new(),
            host: DEFAULT_HOST.to_string(),
            port_start: DEFAULT_PORT_START,
            port_end: DEFAULT_PORT_END,
            bound_port: None,
            mode: BrokerMode::RustOptIn,
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            bind_timeout_ms: DEFAULT_BIND_TIMEOUT_MS,
            idle_empty_session_ttl_ms: DEFAULT_IDLE_EMPTY_SESSION_TTL_MS,
            idle_empty_session_min_age_ms: DEFAULT_IDLE_EMPTY_SESSION_MIN_AGE_MS,
            idle_reaper_interval_ms: DEFAULT_IDLE_REAPER_INTERVAL_MS,
            broker_session_id: DEFAULT_BROKER_SESSION_ID.to_string(),
            socket_path: default_broker_socket_path(),
        }
    }
}

/// Read an environment variable the way `trimmedEnv` in `mcp-server/config.js`
/// does: surrounding whitespace is stripped, and a value that is empty or only
/// whitespace counts as unset.
///
/// The two resolvers have to agree exactly. Before this, a padded
/// `UMBRA_BROKER_SOCKET` made the broker treat the raw value as a relative path
/// and build a mirror tree under its working directory, while Node trimmed the
/// same value and looked for a socket that was never created.
fn trimmed_env(key: &str) -> Option<String> {
    match env::var(key) {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(_) => None,
    }
}

/// Expand a leading `~` the way `expandUserPath` in `mcp-server/config.js` does.
/// A launchd plist and an MCP client config are both JSON, so a tilde arrives
/// unexpanded and used to be created as a directory literally named `~`.
fn expand_user_with_home(value: &str, home: &str) -> String {
    let home = home.trim();
    if home.is_empty() {
        return value.to_string();
    }
    if value == "~" {
        return home.to_string();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return Path::new(home).join(rest).to_string_lossy().into_owned();
    }
    value.to_string()
}

fn expand_user(value: &str) -> String {
    expand_user_with_home(value, &env::var("HOME").unwrap_or_default())
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "localhost" | "[::1]")
}

impl BrokerConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let mut config = Self::default();
        config.shared_key = load_shared_key_from_env()?;
        config.host = trimmed_env("UMBRA_HOST").unwrap_or(config.host);
        config.port_start = parse_env_u16("UMBRA_PORT_START", config.port_start)?;
        config.port_end = parse_env_u16("UMBRA_PORT_END", config.port_end)?;
        config.request_timeout_ms = parse_env_u64(
            "UMBRA_REQUEST_TIMEOUT_MS",
            config.request_timeout_ms,
        )?;
        config.bind_timeout_ms = parse_env_u64(
            "UMBRA_BIND_TIMEOUT_MS",
            config.bind_timeout_ms,
        )?;
        config.idle_empty_session_ttl_ms = parse_env_u64(
            "UMBRA_IDLE_EMPTY_SESSION_TTL_MS",
            config.idle_empty_session_ttl_ms,
        )?;
        config.idle_empty_session_min_age_ms = parse_env_u64(
            "UMBRA_IDLE_EMPTY_SESSION_MIN_AGE_MS",
            config.idle_empty_session_min_age_ms,
        )?;
        config.idle_reaper_interval_ms = parse_env_u64(
            "UMBRA_IDLE_REAPER_INTERVAL_MS",
            config.idle_reaper_interval_ms,
        )?;
        config.broker_session_id =
            trimmed_env("UMBRA_BROKER_SESSION_ID").unwrap_or(config.broker_session_id);
        if let Some(socket_path) = trimmed_env("UMBRA_BROKER_SOCKET") {
            config.socket_path = expand_user(&socket_path);
        }
        config.mode = BrokerMode::RustBroker;

        if config.port_start > config.port_end {
            return Err(ConfigError::InvalidPortRange {
                start: config.port_start,
                end: config.port_end,
            });
        }

        if config.shared_key.is_empty() {
            return Err(ConfigError::MissingSharedKey);
        }

        // A relative socket path binds under whatever working directory the
        // process happened to start in, which under launchd is the user's home,
        // and the Node side resolves the same value to an absolute path. A
        // broker nothing can reach is worse than a broker that refuses to start.
        if !Path::new(&config.socket_path).is_absolute() {
            return Err(ConfigError::RelativeSocketPath {
                path: config.socket_path.clone(),
            });
        }

        // docs/install.md states that the extension and the server talk only
        // over loopback, and mcp-server/bridge-core.js enforces it. Binding
        // every interface exposes the signed-in browser to the whole network to
        // anyone holding the key, so it takes a second, explicit opt-in.
        if !is_loopback_host(&config.host)
            && trimmed_env("UMBRA_ALLOW_NON_LOOPBACK_HOST").as_deref() != Some("1")
        {
            return Err(ConfigError::NonLoopbackHost {
                host: config.host.clone(),
            });
        }

        Ok(config)
    }

    pub fn with_bound_port(&self, port: u16) -> Self {
        let mut next = self.clone();
        next.bound_port = Some(port);
        next
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    InvalidPort { key: &'static str, value: String },
    InvalidNumber { key: &'static str, value: String },
    InvalidPortRange { start: u16, end: u16 },
    MissingSharedKey,
    SharedKeyReadFailed { path: String, message: String },
    RelativeSocketPath { path: String },
    NonLoopbackHost { host: String },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPort { key, value } => {
                write!(formatter, "{key} must be a u16 port, got {value}")
            }
            Self::InvalidPortRange { start, end } => {
                write!(formatter, "port start {start} must be <= port end {end}")
            }
            Self::InvalidNumber { key, value } => {
                write!(formatter, "{key} must be a positive integer, got {value}")
            }
            Self::MissingSharedKey => write!(
                formatter,
                "missing UMBRA_SHARED_KEY or UMBRA_SHARED_KEY_FILE"
            ),
            Self::SharedKeyReadFailed { path, message } => {
                write!(
                    formatter,
                    "could not read shared key file {path}: {message}"
                )
            }
            Self::RelativeSocketPath { path } => write!(
                formatter,
                "UMBRA_BROKER_SOCKET must be an absolute path, got {path}"
            ),
            Self::NonLoopbackHost { host } => write!(
                formatter,
                "UMBRA_HOST is {host}, which is not a loopback address. Umbra listens on loopback only; set UMBRA_ALLOW_NON_LOOPBACK_HOST=1 to override, which exposes the signed-in browser to every host that can reach this machine"
            ),
        }
    }
}

impl Error for ConfigError {}

#[derive(Debug, Clone)]
pub struct RustBroker {
    config: BrokerConfig,
    registry: Arc<SessionRegistry>,
    pressure: Arc<PressureCounters>,
}

impl RustBroker {
    pub fn new(config: BrokerConfig) -> Self {
        Self {
            config,
            registry: Arc::new(SessionRegistry::default()),
            pressure: Arc::new(PressureCounters::default()),
        }
    }

    pub fn registry(&self) -> Arc<SessionRegistry> {
        Arc::clone(&self.registry)
    }

    pub fn pressure(&self) -> Arc<PressureCounters> {
        Arc::clone(&self.pressure)
    }

    pub async fn attach_session_channel(
        &self,
        session_id: &str,
        channel_id: impl Into<String>,
        port: u16,
        connected_at_ms: u64,
    ) -> Result<(), SessionError> {
        self.registry
            .attach_channel(session_id, channel_id, port, connected_at_ms)
            .await?;
        self.refresh_pressure_from_registry().await;
        Ok(())
    }

    pub async fn authenticate_session(
        &self,
        session_id: &str,
        extension_instance_id: Option<String>,
        authenticated_at_ms: u64,
    ) -> Result<(), SessionError> {
        self.registry
            .mark_authenticated(session_id, extension_instance_id, authenticated_at_ms)
            .await?;
        self.refresh_pressure_from_registry().await;
        Ok(())
    }

    /// Resolve the channel a session's command travels over.
    ///
    /// This used to return a `RoutedCommand` carrying a cloned `params` tree and
    /// a freshly allocated `tool` String. Nothing in the crate or its tests ever
    /// read either field, so both allocations were paid per command and thrown
    /// away by the caller. The routing target is the only value with a reader.
    pub async fn route_session_command(
        &self,
        session_id: &str,
    ) -> Result<RoutingTarget, SessionError> {
        match self.registry.route_session(session_id).await {
            Ok(target) => {
                self.pressure.observe_routed_command();
                self.registry.touch_session(session_id).await;
                Ok(target)
            }
            Err(error) => {
                self.pressure.observe_rejected_command();
                Err(error)
            }
        }
    }

    /// Resolve the channel for a command against one specific tab, refusing a
    /// tab the session does not own.
    ///
    /// The runtime no longer calls this on the command path: the broker's tab
    /// map is a non-authoritative copy of state the extension owns, and it is
    /// empty after a broker restart, so gating there rejected commands for tabs
    /// the extension still owned. The extension enforces ownership itself in the
    /// process that holds the tabs. This stays as the registry-level ownership
    /// check that health reporting and the ownership tests exercise.
    pub async fn route_tab_command(
        &self,
        session_id: &str,
        tab_id: u64,
    ) -> Result<RoutingTarget, SessionError> {
        match self.registry.route_tab(session_id, tab_id).await {
            Ok(target) => {
                self.pressure.observe_routed_command();
                self.registry.touch_session(session_id).await;
                Ok(target)
            }
            Err(error) => {
                self.pressure.observe_rejected_command();
                Err(error)
            }
        }
    }

    pub async fn health(&self) -> BrokerHealth {
        let sessions = self.registry.statuses().await;
        self.pressure.set_active_sessions(sessions.len() as u64);
        self.pressure.set_connected_channels(
            sessions.iter().filter(|session| session.connected).count() as u64,
        );

        BrokerHealth {
            ok: true,
            name: BROKER_NAME.to_string(),
            mode: self.config.mode.clone(),
            protocol_version: PROTOCOL_VERSION,
            listener: BrokerListener {
                host: self.config.host.clone(),
                port: self.config.bound_port,
                port_range: PortRange {
                    start: self.config.port_start,
                    end: self.config.port_end,
                },
            },
            extension_connected: sessions.iter().any(|session| session.connected),
            sessions,
            pressure: self.pressure.snapshot(),
        }
    }

    pub async fn graceful_shutdown(&self) -> BrokerHealth {
        self.registry.detach_all().await;
        self.refresh_pressure_from_registry().await;
        self.health().await
    }

    async fn refresh_pressure_from_registry(&self) {
        let sessions = self.registry.statuses().await;
        self.pressure.set_active_sessions(sessions.len() as u64);
        self.pressure.set_connected_channels(
            sessions.iter().filter(|session| session.connected).count() as u64,
        );
    }
}

fn parse_env_u16(key: &'static str, fallback: u16) -> Result<u16, ConfigError> {
    let Ok(value) = env::var(key) else {
        return Ok(fallback);
    };
    value
        .parse::<u16>()
        .map_err(|_| ConfigError::InvalidPort { key, value })
}

fn parse_env_u64(key: &'static str, fallback: u64) -> Result<u64, ConfigError> {
    let Ok(value) = env::var(key) else {
        return Ok(fallback);
    };
    value
        .parse::<u64>()
        .map_err(|_| ConfigError::InvalidNumber { key, value })
}

fn load_shared_key_from_env() -> Result<String, ConfigError> {
    if let Some(value) = trimmed_env("UMBRA_SHARED_KEY") {
        return Ok(value);
    }

    let Some(raw_path) = trimmed_env("UMBRA_SHARED_KEY_FILE") else {
        return Ok(String::new());
    };
    let path = expand_user(&raw_path);
    let contents = fs::read_to_string(&path).map_err(|error| ConfigError::SharedKeyReadFailed {
        path: path.clone(),
        message: error.to_string(),
    })?;
    // A blank key file is a truncated write or a half-finished install, never a
    // request for a zero-length HMAC key. from_env turns the empty string into
    // MissingSharedKey, which is the message that names the fix.
    Ok(contents.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_padded_or_blank_environment_value_resolves_the_way_the_node_side_resolves_it() {
        // config.js treats an exported-but-blank variable as unset and trims the
        // rest. The two resolvers have to produce the identical string, or the
        // broker binds one path and the companion dials another.
        std::env::set_var("UMBRA_TEST_TRIMMED", "  /tmp/spaced.sock  ");
        assert_eq!(trimmed_env("UMBRA_TEST_TRIMMED").as_deref(), Some("/tmp/spaced.sock"));
        std::env::set_var("UMBRA_TEST_TRIMMED", "   ");
        assert_eq!(trimmed_env("UMBRA_TEST_TRIMMED"), None);
        std::env::set_var("UMBRA_TEST_TRIMMED", "");
        assert_eq!(trimmed_env("UMBRA_TEST_TRIMMED"), None);
        std::env::remove_var("UMBRA_TEST_TRIMMED");
        assert_eq!(trimmed_env("UMBRA_TEST_TRIMMED"), None);
    }

    #[test]
    fn a_tilde_path_expands_rather_than_becoming_a_directory_named_tilde() {
        // The home is a parameter, so this asserts the expansion rule without
        // mutating a process-wide variable other tests read.
        let home = "/tmp/umbra-home";
        assert_eq!(
            expand_user_with_home("~/.umbra/run/broker.sock", home),
            "/tmp/umbra-home/.umbra/run/broker.sock"
        );
        assert_eq!(expand_user_with_home("~", home), "/tmp/umbra-home");
        assert_eq!(expand_user_with_home("/already/absolute", home), "/already/absolute");
        // A tilde in the middle is part of the name, not a home reference.
        assert_eq!(expand_user_with_home("/opt/~/x", home), "/opt/~/x");
    }

    #[test]
    fn only_loopback_hosts_count_as_loopback() {
        for host in ["127.0.0.1", "::1", "localhost", "[::1]"] {
            assert!(is_loopback_host(host), "{host} should be loopback");
        }
        for host in ["0.0.0.0", "192.168.0.13", "::", "example.test"] {
            assert!(!is_loopback_host(host), "{host} must not count as loopback");
        }
    }

    #[test]
    fn the_default_shim_socket_is_per_user_and_outside_tmp() {
        let socket_path = BrokerConfig::default().socket_path;
        assert!(
            !socket_path.starts_with("/tmp/"),
            "a world-writable directory lets another local account pre-create the path and block startup, got {socket_path}"
        );
        assert!(
            socket_path.ends_with(".umbra/run/broker.sock"),
            "the Rust default must match resolveBrokerSocketPath() in mcp-server/config.js, got {socket_path}"
        );
    }
}
