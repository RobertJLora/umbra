use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

pub type TabId = u64;
pub type GroupId = i64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelStatus {
    pub channel_id: String,
    pub port: u16,
    pub extension_instance_id: Option<String>,
    pub connected_at_ms: u64,
    pub authenticated: bool,
    pub authenticated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionStatus {
    pub session_id: String,
    pub connected: bool,
    pub channel: Option<ChannelStatus>,
    pub group_id: Option<GroupId>,
    pub active_tab_id: Option<TabId>,
    pub tab_ids: Vec<TabId>,
    pub pending_requests: usize,
    pub created_at_ms: u64,
    pub last_activity_at_ms: u64,
    pub command_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutingTarget {
    pub session_id: String,
    pub channel_id: String,
    pub tab_id: Option<TabId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    SessionAlreadyConnected {
        session_id: String,
    },
    SessionNotConnected {
        session_id: String,
    },
    SessionMissingChannel {
        session_id: String,
    },
    TabAlreadyOwned {
        tab_id: TabId,
        owner_session_id: String,
    },
    TabNotOwned {
        tab_id: TabId,
        session_id: String,
    },
    NoPendingRequest {
        session_id: String,
    },
}

impl fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SessionAlreadyConnected { session_id } => {
                write!(
                    formatter,
                    "session {session_id} already has an authenticated channel"
                )
            }
            Self::SessionNotConnected { session_id } => {
                write!(formatter, "session {session_id} is not connected")
            }
            Self::SessionMissingChannel { session_id } => {
                write!(formatter, "session {session_id} has no channel")
            }
            Self::TabAlreadyOwned {
                tab_id,
                owner_session_id,
            } => write!(
                formatter,
                "tab {tab_id} is already owned by session {owner_session_id}"
            ),
            Self::TabNotOwned { tab_id, session_id } => {
                write!(
                    formatter,
                    "tab {tab_id} is not owned by session {session_id}"
                )
            }
            Self::NoPendingRequest { session_id } => {
                write!(formatter, "session {session_id} has no pending request")
            }
        }
    }
}

impl Error for SessionError {}

#[derive(Debug, Clone)]
struct SessionRecord {
    channel: Option<ChannelStatus>,
    group_id: Option<GroupId>,
    active_tab_id: Option<TabId>,
    tab_ids: HashSet<TabId>,
    pending_requests: usize,
    created_at_ms: u64,
    last_activity_at_ms: u64,
    command_count: u64,
}

impl Default for SessionRecord {
    fn default() -> Self {
        let now = now_ms();
        Self {
            channel: None,
            group_id: None,
            active_tab_id: None,
            tab_ids: HashSet::new(),
            pending_requests: 0,
            created_at_ms: now,
            last_activity_at_ms: now,
            command_count: 0,
        }
    }
}

#[derive(Debug, Default)]
struct RegistryInner {
    sessions: HashMap<String, SessionRecord>,
    tab_to_session: HashMap<TabId, String>,
}

#[derive(Debug, Default)]
pub struct SessionRegistry {
    inner: RwLock<RegistryInner>,
}

impl SessionRegistry {
    pub async fn ensure_session(&self, session_id: &str) -> SessionStatus {
        let mut inner = self.inner.write().await;
        let record = inner.sessions.entry(session_id.to_string()).or_default();
        status_from_record(session_id, record)
    }

    /// Refresh a session's activity clock.
    ///
    /// `get_mut`, never `entry().or_default()`. Only `ensure_session` and the
    /// register path create records; every other mutation here is a follow-up on
    /// a session that is supposed to already exist. Creating one on the way past
    /// resurrected sessions that had just been removed, with `connected: false`
    /// and no channel, which the idle reaper then refused to touch because it
    /// only reaps connected shim sessions.
    pub async fn touch_session(&self, session_id: &str) {
        let mut inner = self.inner.write().await;
        if let Some(record) = inner.sessions.get_mut(session_id) {
            record.last_activity_at_ms = now_ms();
        }
    }

    pub async fn attach_channel(
        &self,
        session_id: &str,
        channel_id: impl Into<String>,
        port: u16,
        connected_at_ms: u64,
    ) -> Result<Option<ChannelStatus>, SessionError> {
        self.attach_channel_with_replace(session_id, channel_id, port, connected_at_ms, false)
            .await
    }

    /// Same as attach_channel, but a second MCP shim with a valid register HMAC
    /// may replace an authenticated channel. Used when the companion reconnects
    /// after a broker restart and the old socket has not closed yet.
    pub async fn rebind_channel(
        &self,
        session_id: &str,
        channel_id: impl Into<String>,
        port: u16,
        connected_at_ms: u64,
    ) -> Result<Option<ChannelStatus>, SessionError> {
        self.attach_channel_with_replace(session_id, channel_id, port, connected_at_ms, true)
            .await
    }

    async fn attach_channel_with_replace(
        &self,
        session_id: &str,
        channel_id: impl Into<String>,
        port: u16,
        connected_at_ms: u64,
        replace_authenticated: bool,
    ) -> Result<Option<ChannelStatus>, SessionError> {
        let mut inner = self.inner.write().await;
        let record = inner.sessions.entry(session_id.to_string()).or_default();
        if record.channel.is_none()
            && record.tab_ids.is_empty()
            && record.pending_requests == 0
            && record.command_count == 0
        {
            record.created_at_ms = connected_at_ms;
        }
        record.last_activity_at_ms = connected_at_ms;

        if record
            .channel
            .as_ref()
            .is_some_and(|channel| channel.authenticated)
            && !replace_authenticated
        {
            return Err(SessionError::SessionAlreadyConnected {
                session_id: session_id.to_string(),
            });
        }

        let replaced = record.channel.replace(ChannelStatus {
            channel_id: channel_id.into(),
            port,
            extension_instance_id: None,
            connected_at_ms,
            authenticated: false,
            authenticated_at_ms: None,
        });

        Ok(replaced)
    }

    pub async fn mark_authenticated(
        &self,
        session_id: &str,
        extension_instance_id: Option<String>,
        authenticated_at_ms: u64,
    ) -> Result<SessionStatus, SessionError> {
        let mut inner = self.inner.write().await;
        let Some(record) = inner.sessions.get_mut(session_id) else {
            return Err(SessionError::SessionMissingChannel {
                session_id: session_id.to_string(),
            });
        };
        let Some(channel) = record.channel.as_mut() else {
            return Err(SessionError::SessionMissingChannel {
                session_id: session_id.to_string(),
            });
        };

        channel.extension_instance_id = extension_instance_id;
        channel.authenticated = true;
        channel.authenticated_at_ms = Some(authenticated_at_ms);
        record.last_activity_at_ms = authenticated_at_ms;
        Ok(status_from_record(session_id, record))
    }

    pub async fn detach_channel(&self, session_id: &str) -> Option<ChannelStatus> {
        let mut inner = self.inner.write().await;
        let record = inner.sessions.get_mut(session_id)?;
        record.pending_requests = 0;
        record.channel.take()
    }

    pub async fn detach_session(&self, session_id: &str) -> Option<SessionStatus> {
        let mut inner = self.inner.write().await;
        let record = inner.sessions.remove(session_id)?;
        for tab_id in &record.tab_ids {
            inner.tab_to_session.remove(tab_id);
        }
        Some(status_from_record(session_id, &record))
    }

    pub async fn detach_all(&self) {
        let mut inner = self.inner.write().await;
        inner.sessions.clear();
        inner.tab_to_session.clear();
    }

    pub async fn is_connected(&self, session_id: &str) -> bool {
        let inner = self.inner.read().await;
        inner
            .sessions
            .get(session_id)
            .and_then(|record| record.channel.as_ref())
            .is_some_and(|channel| channel.authenticated)
    }

    pub async fn set_group(&self, session_id: &str, group_id: GroupId) {
        let mut inner = self.inner.write().await;
        if let Some(record) = inner.sessions.get_mut(session_id) {
            record.last_activity_at_ms = now_ms();
            record.group_id = Some(group_id);
        }
    }

    pub async fn claim_tab(&self, session_id: &str, tab_id: TabId) -> Result<(), SessionError> {
        let mut inner = self.inner.write().await;
        if let Some(owner_session_id) = inner.tab_to_session.get(&tab_id) {
            if owner_session_id != session_id {
                return Err(SessionError::TabAlreadyOwned {
                    tab_id,
                    owner_session_id: owner_session_id.clone(),
                });
            }
        }

        // A tool result that names a tab must not recreate a session that has
        // already gone. An extension answer arriving after its shim died used to
        // resurrect the removed record and hand it ownership of a live tab, which
        // then blocked the session that really owned it from claiming it.
        let Some(record) = inner.sessions.get_mut(session_id) else {
            return Err(SessionError::SessionNotConnected {
                session_id: session_id.to_string(),
            });
        };
        record.last_activity_at_ms = now_ms();
        record.tab_ids.insert(tab_id);
        if record.active_tab_id.is_none() {
            record.active_tab_id = Some(tab_id);
        }
        inner.tab_to_session.insert(tab_id, session_id.to_string());
        Ok(())
    }

    pub async fn set_active_tab(
        &self,
        session_id: &str,
        tab_id: TabId,
    ) -> Result<(), SessionError> {
        let mut inner = self.inner.write().await;
        assert_owned(&inner, session_id, tab_id)?;
        let Some(record) = inner.sessions.get_mut(session_id) else {
            return Err(SessionError::SessionNotConnected {
                session_id: session_id.to_string(),
            });
        };
        record.last_activity_at_ms = now_ms();
        record.active_tab_id = Some(tab_id);
        Ok(())
    }

    /// Drop a tab's ownership record, refusing a tab the caller does not own.
    ///
    /// Claiming is ownership checked and releasing was not, so a result naming a
    /// foreign tab id dropped another session's ownership. The extension enforces
    /// ownership itself before it would answer with a foreign tab, but the broker
    /// should not depend on that to keep its own map honest.
    pub async fn release_tab_owned(&self, session_id: &str, tab_id: TabId) -> Option<String> {
        {
            let inner = self.inner.read().await;
            match inner.tab_to_session.get(&tab_id) {
                Some(owner) if owner == session_id => {}
                _ => return None,
            }
        }
        self.release_tab(tab_id).await
    }

    pub async fn release_tab(&self, tab_id: TabId) -> Option<String> {
        let mut inner = self.inner.write().await;
        let session_id = inner.tab_to_session.remove(&tab_id)?;
        if let Some(record) = inner.sessions.get_mut(&session_id) {
            record.last_activity_at_ms = now_ms();
            record.tab_ids.remove(&tab_id);
            if record.active_tab_id == Some(tab_id) {
                record.active_tab_id = record.tab_ids.iter().copied().min();
            }
        }
        Some(session_id)
    }

    pub async fn add_pending_request(&self, session_id: &str) {
        let mut inner = self.inner.write().await;
        if let Some(record) = inner.sessions.get_mut(session_id) {
            record.pending_requests += 1;
            record.command_count += 1;
            record.last_activity_at_ms = now_ms();
        }
    }

    pub async fn settle_pending_request(&self, session_id: &str) -> Result<(), SessionError> {
        let mut inner = self.inner.write().await;
        let Some(record) = inner.sessions.get_mut(session_id) else {
            return Err(SessionError::NoPendingRequest {
                session_id: session_id.to_string(),
            });
        };
        if record.pending_requests == 0 {
            return Err(SessionError::NoPendingRequest {
                session_id: session_id.to_string(),
            });
        }
        record.pending_requests -= 1;
        record.last_activity_at_ms = now_ms();
        Ok(())
    }

    pub async fn route_session(&self, session_id: &str) -> Result<RoutingTarget, SessionError> {
        let inner = self.inner.read().await;
        let record =
            inner
                .sessions
                .get(session_id)
                .ok_or_else(|| SessionError::SessionNotConnected {
                    session_id: session_id.to_string(),
                })?;
        let channel = authenticated_channel(session_id, record)?;
        Ok(RoutingTarget {
            session_id: session_id.to_string(),
            channel_id: channel.channel_id.clone(),
            tab_id: None,
        })
    }

    pub async fn route_tab(
        &self,
        session_id: &str,
        tab_id: TabId,
    ) -> Result<RoutingTarget, SessionError> {
        let inner = self.inner.read().await;
        assert_owned(&inner, session_id, tab_id)?;
        let record =
            inner
                .sessions
                .get(session_id)
                .ok_or_else(|| SessionError::SessionNotConnected {
                    session_id: session_id.to_string(),
                })?;
        let channel = authenticated_channel(session_id, record)?;
        Ok(RoutingTarget {
            session_id: session_id.to_string(),
            channel_id: channel.channel_id.clone(),
            tab_id: Some(tab_id),
        })
    }

    pub async fn status(&self, session_id: &str) -> Option<SessionStatus> {
        let inner = self.inner.read().await;
        inner
            .sessions
            .get(session_id)
            .map(|record| status_from_record(session_id, record))
    }

    pub async fn statuses(&self) -> Vec<SessionStatus> {
        let inner = self.inner.read().await;
        let mut statuses = inner
            .sessions
            .iter()
            .map(|(session_id, record)| status_from_record(session_id, record))
            .collect::<Vec<_>>();
        statuses.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        statuses
    }

    pub async fn idle_empty_reap_candidates(
        &self,
        now_ms: u64,
        ttl_ms: u64,
        min_age_ms: u64,
        protected_session_ids: &HashSet<String>,
    ) -> Vec<SessionStatus> {
        let inner = self.inner.read().await;
        let mut statuses = inner
            .sessions
            .iter()
            .filter(|(session_id, record)| {
                is_idle_empty_reap_candidate(
                    session_id,
                    record,
                    now_ms,
                    ttl_ms,
                    min_age_ms,
                    protected_session_ids,
                )
            })
            .map(|(session_id, record)| status_from_record(session_id, record))
            .collect::<Vec<_>>();
        statuses.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        statuses
    }

    pub async fn detach_idle_empty_session(
        &self,
        session_id: &str,
        now_ms: u64,
        ttl_ms: u64,
        min_age_ms: u64,
        protected_session_ids: &HashSet<String>,
    ) -> Option<SessionStatus> {
        let mut inner = self.inner.write().await;
        let record = inner.sessions.get(session_id)?;
        if !is_idle_empty_reap_candidate(
            session_id,
            record,
            now_ms,
            ttl_ms,
            min_age_ms,
            protected_session_ids,
        ) {
            return None;
        }
        let record = inner.sessions.remove(session_id)?;
        Some(status_from_record(session_id, &record))
    }
}

fn authenticated_channel<'a>(
    session_id: &str,
    record: &'a SessionRecord,
) -> Result<&'a ChannelStatus, SessionError> {
    let Some(channel) = record.channel.as_ref() else {
        return Err(SessionError::SessionNotConnected {
            session_id: session_id.to_string(),
        });
    };
    if !channel.authenticated {
        return Err(SessionError::SessionNotConnected {
            session_id: session_id.to_string(),
        });
    }
    Ok(channel)
}

fn assert_owned(
    inner: &RegistryInner,
    session_id: &str,
    tab_id: TabId,
) -> Result<(), SessionError> {
    match inner.tab_to_session.get(&tab_id) {
        Some(owner_session_id) if owner_session_id == session_id => Ok(()),
        Some(owner_session_id) => Err(SessionError::TabAlreadyOwned {
            tab_id,
            owner_session_id: owner_session_id.clone(),
        }),
        None => Err(SessionError::TabNotOwned {
            tab_id,
            session_id: session_id.to_string(),
        }),
    }
}

fn status_from_record(session_id: &str, record: &SessionRecord) -> SessionStatus {
    let mut tab_ids = record.tab_ids.iter().copied().collect::<Vec<_>>();
    tab_ids.sort_unstable();
    SessionStatus {
        session_id: session_id.to_string(),
        connected: record
            .channel
            .as_ref()
            .is_some_and(|channel| channel.authenticated),
        channel: record.channel.clone(),
        group_id: record.group_id,
        active_tab_id: record.active_tab_id,
        tab_ids,
        pending_requests: record.pending_requests,
        created_at_ms: record.created_at_ms,
        last_activity_at_ms: record.last_activity_at_ms,
        command_count: record.command_count,
    }
}

fn is_idle_empty_reap_candidate(
    session_id: &str,
    record: &SessionRecord,
    now_ms: u64,
    ttl_ms: u64,
    min_age_ms: u64,
    protected_session_ids: &HashSet<String>,
) -> bool {
    if protected_session_ids.contains(session_id) {
        return false;
    }
    if !record
        .channel
        .as_ref()
        .is_some_and(|channel| channel.authenticated && channel.channel_id == "mcp-shim")
    {
        return false;
    }
    if record.pending_requests > 0
        || !record.tab_ids.is_empty()
        || record.group_id.is_some()
        || record.active_tab_id.is_some()
    {
        return false;
    }
    now_ms.saturating_sub(record.created_at_ms) >= min_age_ms
        && now_ms.saturating_sub(record.last_activity_at_ms) >= ttl_ms
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}
