//! Concurrent per-server/workspace client initialization and crash backoff.

use std::{
	collections::HashMap,
	error::Error as StdError,
	future::Future,
	mem,
	path::PathBuf,
	sync::Arc,
	time::{Duration, Instant},
};

use omp_core::Str;
use parking_lot::Mutex;
use thiserror::Error;
use tokio::sync::Mutex as AsyncMutex;

/// Negative startup cache lifetime.
pub const CRASH_BACKOFF: Duration = Duration::from_secs(3 * 60);

/// Complete identity of one shareable initialized client.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LspPoolKey {
	/// Server declaration identity.
	pub server:        Str,
	/// Canonical workspace root.
	pub workspace:     PathBuf,
	/// Fingerprint of executable, arguments, settings, and initialization
	/// options.
	pub configuration: [u8; 32],
}

enum PoolEntry<T, E> {
	Empty,
	Ready(Arc<T>),
	Failed { at: Instant, source: Arc<E> },
}

/// A shareable initialized-client cache. Startup for each fingerprint is
/// serialized independently; unrelated servers initialize concurrently.
pub struct LspPool<T, E> {
	backoff: Duration,
	entries: Mutex<HashMap<LspPoolKey, Arc<AsyncMutex<PoolEntry<T, E>>>>>,
}

impl<T, E> Default for LspPool<T, E>
where
	T: Send + Sync + 'static,
	E: StdError + Send + Sync + 'static,
{
	fn default() -> Self {
		Self::new(CRASH_BACKOFF)
	}
}

impl<T, E> LspPool<T, E>
where
	T: Send + Sync + 'static,
	E: StdError + Send + Sync + 'static,
{
	/// Creates a pool with an explicit negative-cache lifetime.
	pub fn new(backoff: Duration) -> Self {
		Self { backoff, entries: Mutex::new(HashMap::new()) }
	}

	/// Returns the singleton client, invoking `initialize` at most once for
	/// concurrent callers. A failed initializer is negatively cached.
	pub async fn get_or_try_init<F, Fut>(
		&self,
		key: LspPoolKey,
		initialize: F,
	) -> Result<Arc<T>, LspPoolError<E>>
	where
		F: FnOnce() -> Fut,
		Fut: Future<Output = Result<T, E>>,
	{
		let slot = self
			.entries
			.lock()
			.entry(key)
			.or_insert_with(|| Arc::new(AsyncMutex::new(PoolEntry::Empty)))
			.clone();
		let mut entry = slot.lock().await;
		match &*entry {
			PoolEntry::Ready(client) => return Ok(client.clone()),
			PoolEntry::Failed { at, source } if at.elapsed() < self.backoff => {
				return Err(LspPoolError::Backoff {
					source:      source.clone(),
					retry_after: self.backoff.saturating_sub(at.elapsed()),
				});
			},
			PoolEntry::Empty | PoolEntry::Failed { .. } => {},
		}
		match initialize().await {
			Ok(client) => {
				let client = Arc::new(client);
				*entry = PoolEntry::Ready(client.clone());
				Ok(client)
			},
			Err(source) => {
				let source = Arc::new(source);
				*entry = PoolEntry::Failed { at: Instant::now(), source: source.clone() };
				Err(LspPoolError::Startup { source })
			},
		}
	}

	/// Explicitly evicts a client or failure entry. Ready clients remain alive
	/// until outstanding `Arc` leases release them.
	pub fn evict(&self, key: &LspPoolKey) -> Option<Arc<T>> {
		let mut entries = self.entries.lock();
		let slot = entries.get(key)?.clone();
		let Ok(mut entry) = slot.try_lock() else {
			return None;
		};
		entries.remove(key);
		match mem::replace(&mut *entry, PoolEntry::Empty) {
			PoolEntry::Ready(client) => Some(client),
			PoolEntry::Empty | PoolEntry::Failed { .. } => None,
		}
	}

	/// Clears only a negative startup cache entry, allowing immediate retry.
	pub fn clear_failure(&self, key: &LspPoolKey) -> bool {
		let Some(slot) = self.entries.lock().get(key).cloned() else {
			return false;
		};
		let Ok(mut entry) = slot.try_lock() else {
			return false;
		};
		if matches!(*entry, PoolEntry::Failed { .. }) {
			*entry = PoolEntry::Empty;
			true
		} else {
			false
		}
	}

	/// Returns whether a fingerprint has any ready, failed, or in-flight slot.
	pub fn contains(&self, key: &LspPoolKey) -> bool {
		self.entries.lock().contains_key(key)
	}
}

/// Client acquisition failure.
#[derive(Debug, Error)]
pub enum LspPoolError<E: StdError + Send + Sync + 'static> {
	/// The initializer failed and the failure was cached.
	#[error("language-server initialization failed: {source}")]
	Startup {
		/// Cached startup failure.
		#[source]
		source: Arc<E>,
	},
	/// A recent crash suppresses a spawn storm until the backoff expires.
	#[error("language-server initialization is in crash backoff for {retry_after:?}: {source}")]
	Backoff {
		/// Cached startup failure.
		#[source]
		source:      Arc<E>,
		/// Remaining negative-cache lifetime.
		retry_after: Duration,
	},
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use tokio::task;

	use super::*;

	#[derive(Debug, Error)]
	#[error("fixture startup failure")]
	struct FixtureError;

	fn key() -> LspPoolKey {
		LspPoolKey {
			server:        Str::new_static("fixture"),
			workspace:     PathBuf::from("/workspace"),
			configuration: [7; 32],
		}
	}

	#[tokio::test]
	async fn concurrent_requests_initialize_exactly_one_client() {
		let pool = Arc::new(LspPool::<usize, FixtureError>::default());
		let calls = Arc::new(AtomicUsize::new(0));
		let mut tasks = Vec::new();
		for _ in 0..12 {
			let pool = pool.clone();
			let calls = calls.clone();
			tasks.push(tokio::spawn(async move {
				pool
					.get_or_try_init(key(), || async move {
						calls.fetch_add(1, Ordering::SeqCst);
						task::yield_now().await;
						Ok(41)
					})
					.await
					.unwrap()
			}));
		}
		for task in tasks {
			assert_eq!(*task.await.unwrap(), 41);
		}
		assert_eq!(calls.load(Ordering::SeqCst), 1);
	}

	#[tokio::test]
	async fn explicit_eviction_reinitializes_the_fingerprint() {
		let pool = LspPool::<usize, FixtureError>::default();
		let first = pool
			.get_or_try_init(key(), || async { Ok(1) })
			.await
			.unwrap();
		assert_eq!(*first, 1);
		assert_eq!(*pool.evict(&key()).unwrap(), 1);
		let second = pool
			.get_or_try_init(key(), || async { Ok(2) })
			.await
			.unwrap();
		assert_eq!(*second, 2);
	}

	#[tokio::test]
	async fn failure_backoff_prevents_spawn_storm_and_can_be_cleared() {
		let pool = LspPool::<usize, FixtureError>::default();
		assert!(matches!(
			pool
				.get_or_try_init(key(), || async { Err(FixtureError) })
				.await,
			Err(LspPoolError::Startup { .. })
		));
		assert!(matches!(
			pool.get_or_try_init(key(), || async { Ok(1) }).await,
			Err(LspPoolError::Backoff { .. })
		));
		assert!(pool.clear_failure(&key()));
		assert_eq!(
			*pool
				.get_or_try_init(key(), || async { Ok(2) })
				.await
				.unwrap(),
			2
		);
	}
}
