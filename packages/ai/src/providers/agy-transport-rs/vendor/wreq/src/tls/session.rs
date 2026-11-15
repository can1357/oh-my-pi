//! TLS session caching and resumption.
//!
//! Handshakes are expensive. This module lets you reuse sessions to save
//! CPU cycles and reduce latency.
//!
//! By default, we use an in-memory LRU cache, but you can plug in your own
//! implementation if you're running at scale or need to share sessions
//! across multiple instances.

use std::{
    borrow::Borrow,
    collections::{HashMap, hash_map::Entry},
    hash::{Hash, Hasher},
    num::NonZeroUsize,
    sync::Arc,
};

use btls::ssl::{SslSession, SslVersion};
use lru::LruCache;

use crate::{conn::descriptor::ConnectionId, sync::Mutex, tls::TlsVersion};

/// An opaque key identifying a TLS session cache entry.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Key(pub(super) ConnectionId);

/// A TLS session that can be stored and retrieved from a session cache.
#[derive(Clone)]
pub struct TlsSession(pub(super) SslSession);

/// A trait for cache storing and retrieving TLS sessions.
///
/// # TLS 1.3 Session Handling
///
/// For TLS 1.3 sessions, implementations **should** remove the session after
/// retrieval to comply with [RFC 8446 Appendix C.4](https://tools.ietf.org/html/rfc8446#appendix-C.4),
/// which requires that session tickets are used at most once to prevent
/// concurrent handshakes from reusing the same session.
pub trait TlsSessionCache: Send + Sync {
    /// Store a TLS session associated with the given key.
    fn put(&self, key: Key, session: TlsSession);

    /// Retrieve a TLS session for the given key.
    ///
    /// For TLS 1.3, the session should be removed from the cache upon retrieval
    /// to ensure single-use semantics (see [RFC 8446 Appendix C.4]).
    fn pop(&self, key: &Key) -> Option<TlsSession>;
}

impl_into_shared!(
    /// Trait for converting types into a shared [`TlsSessionCache`].
    ///
    /// This allows accepting bare types, `Arc<T>`, or `Arc<dyn TlsSessionCache>`.
    pub trait IntoTlsSessionCache => TlsSessionCache
);

/// The default two-level LRU session cache.
///
/// Maintains both forward (key → sessions) and reverse (session → key) lookups
/// for efficient session storage, retrieval, and cleanup operations.
///
/// This is the built-in implementation of [`TlsSessionCache`] used when no
/// custom session store is configured.
pub struct LruTlsSessionCache {
    inner: Mutex<Inner>,
    per_host_session_capacity: usize,
}

struct Inner {
    reverse: HashMap<TlsSession, Key>,
    per_host_sessions: HashMap<Key, LruCache<TlsSession, ()>>,
}

// ===== impl TlsSession =====

impl TlsSession {
    /// Returns the TLS session ID.
    #[inline]
    pub fn id(&self) -> &[u8] {
        self.0.id()
    }

    /// Returns the time at which the session was established, in seconds since the Unix epoch.
    #[inline]
    pub fn time(&self) -> u64 {
        self.0.time()
    }

    /// Returns the sessions timeout, in seconds.
    ///
    /// A session older than this time should not be used for session resumption.
    #[inline]
    pub fn timeout(&self) -> u32 {
        self.0.timeout()
    }

    /// Returns the TLS protocol version negotiated for this session.
    #[inline]
    pub fn protocol_version(&self) -> TlsVersion {
        let version = self.0.protocol_version();
        if version == SslVersion::SSL3 {
            // SSLv3 (SSL 3.0) is obsolete and insecure, and is not supported by btls.
            // This branch should never be reached in normal operation. If it is,
            // it indicates a bug or an unsupported/legacy OpenSSL configuration.
            unreachable!(
                "Encountered unsupported protocol: SSLv3 (SSL 3.0) is obsolete and not accepted by btls"
            );
        }
        TlsVersion(version)
    }
}

impl Eq for TlsSession {}

impl PartialEq for TlsSession {
    #[inline]
    fn eq(&self, other: &TlsSession) -> bool {
        self.0.id() == other.0.id()
    }
}

impl Hash for TlsSession {
    #[inline]
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.id().hash(state);
    }
}

impl Borrow<[u8]> for TlsSession {
    #[inline]
    fn borrow(&self) -> &[u8] {
        self.0.id()
    }
}

// ===== impl LruTlsSessionCache =====

impl LruTlsSessionCache {
    /// Creates a new [`LruTlsSessionCache`] with the given per-host capacity.
    pub fn new(per_host_session_capacity: usize) -> Self {
        LruTlsSessionCache {
            inner: Mutex::new(Inner {
                reverse: HashMap::new(),
                per_host_sessions: HashMap::new(),
            }),
            per_host_session_capacity,
        }
    }
}

impl TlsSessionCache for LruTlsSessionCache {
    fn put(&self, key: Key, session: TlsSession) {
        let mut inner = self.inner.lock();

        let evicted = {
            let per_host_sessions =
                inner
                    .per_host_sessions
                    .entry(key.clone())
                    .or_insert_with(|| {
                        NonZeroUsize::new(self.per_host_session_capacity)
                            .map_or_else(LruCache::unbounded, LruCache::new)
                    });

            // Enforce per-key capacity limit by evicting the least recently used session
            let evicted = if per_host_sessions.len() >= self.per_host_session_capacity {
                per_host_sessions.pop_lru().map(|(s, _)| s)
            } else {
                None
            };

            per_host_sessions.put(session.clone(), ());
            evicted
        };

        if let Some(evicted_session) = evicted {
            inner.reverse.remove(&evicted_session);
        }
        inner.reverse.insert(session, key);
    }

    fn pop(&self, key: &Key) -> Option<TlsSession> {
        let mut inner = self.inner.lock();
        let session = {
            let per_host_sessions = inner.per_host_sessions.get_mut(key)?;
            per_host_sessions.peek_lru()?.0.clone()
        };

        // https://tools.ietf.org/html/rfc8446#appendix-C.4
        // OpenSSL will remove the session from its cache after the handshake completes anyway, but
        // this ensures that concurrent handshakes don't end up with the same session.
        if session.protocol_version() == TlsVersion::TLS_1_3
            && let Some(key) = inner.reverse.remove(&session)
            && let Entry::Occupied(mut entry) = inner.per_host_sessions.entry(key)
        {
            entry.get_mut().pop(&session);
            if entry.get().is_empty() {
                entry.remove();
            }
        }

        Some(session)
    }
}
