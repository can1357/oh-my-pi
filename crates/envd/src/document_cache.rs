//! Environment-daemon ownership of document-cache collection.

use std::{
	collections::HashSet,
	path::Path,
	sync::Arc,
	time::{Duration, SystemTime},
};

use omp_cache::document_cache::{
	DocumentCache, DocumentCacheError, DocumentCacheGcReport, DocumentCachePolicy,
};
use omp_core::Hash32;
use tokio::{
	sync::watch::Receiver,
	task::JoinHandle,
	time::{self, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;

/// Default interval between bounded document-cache collection passes.
pub const DOCUMENT_CACHE_GC_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Opens the user-wide conversion cache beneath the application data root.
pub fn user_document_cache(data_dir: &Path) -> DocumentCache {
	DocumentCache::open(data_dir.join("cache").join("documents"))
}

/// Opens the user-wide cache from a project state directory.
///
/// Production project state is `<data>/projects/<project-key>`; isolated
/// callers that provide another layout retain that directory as their cache
/// scope rather than guessing an unrelated parent.
pub fn project_document_cache(state_dir: &Path) -> DocumentCache {
	let data_dir = state_dir
		.parent()
		.filter(|parent| parent.file_name().is_some_and(|name| name == "projects"))
		.and_then(Path::parent)
		.unwrap_or(state_dir);
	user_document_cache(data_dir)
}

/// Daemon-owned document-cache collector.
#[derive(Clone, Debug)]
pub struct DocumentCacheCollector {
	cache:    DocumentCache,
	policy:   DocumentCachePolicy,
	interval: Duration,
}

impl DocumentCacheCollector {
	/// Creates a collector with the 256 MiB/default-age policy.
	pub fn new(cache: DocumentCache) -> Self {
		Self { cache, policy: DocumentCachePolicy::default(), interval: DOCUMENT_CACHE_GC_INTERVAL }
	}

	/// Replaces collection policy, primarily for bounded operational tests.
	pub const fn with_policy(mut self, policy: DocumentCachePolicy) -> Self {
		self.policy = policy;
		self
	}

	/// Runs one collection pass using the blob authority's current reachability
	/// projection.
	pub fn collect(
		&self,
		now: SystemTime,
		reachable_blobs: &HashSet<Hash32>,
	) -> Result<DocumentCacheGcReport, DocumentCacheError> {
		self.cache.collect(self.policy, now, reachable_blobs)
	}

	/// Starts periodic GC until `shutdown`. The watch value is the blob-store
	/// reachability projection; blob-backed cache entries in it are never
	/// evicted. Collection errors are logged and retried at the next interval
	/// because the cache is an optimization, never request authority.
	pub fn spawn(
		self,
		shutdown: CancellationToken,
		reachable_blobs: Receiver<Arc<HashSet<Hash32>>>,
	) -> JoinHandle<()> {
		tokio::spawn(async move {
			let mut ticker = time::interval(self.interval);
			ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
			loop {
				tokio::select! {
					_ = shutdown.cancelled() => break,
					_ = ticker.tick() => {
						let reachable = reachable_blobs.borrow().clone();
						if let Err(error) = self.collect(SystemTime::now(), &reachable) {
							tracing::warn!(error = %error, "document cache collection failed");
						}
					},
				}
			}
		})
	}
}

#[cfg(test)]
mod tests {
	use tokio::sync::watch;

	use super::*;

	#[tokio::test]
	async fn shutdown_stops_daemon_owned_collector() {
		let directory = tempfile::tempdir().unwrap();
		let collector = DocumentCacheCollector::new(DocumentCache::open(directory.path()));
		let shutdown = CancellationToken::new();
		let (_tx, rx) = watch::channel(Arc::new(HashSet::new()));
		let task = collector.spawn(shutdown.clone(), rx);
		shutdown.cancel();
		task.await.unwrap();
	}
}
