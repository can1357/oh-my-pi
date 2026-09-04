//! Secret-typed command credential resolution with process-local caching.

use std::{collections::BTreeMap, fmt, future::Future, pin::Pin, sync::Arc, time::Duration};

use omp_core::{SecretString, Str};
use parking_lot::Mutex;
use tokio::{sync::watch, time::Instant};
use tokio_util::sync::CancellationToken;

/// Boxed environment-execution future at the cold command-credential boundary.
pub type CommandExecutionFuture =
	Pin<Box<dyn Future<Output = Result<SecretString, CommandCredentialError>> + Send + 'static>>;

/// Injected command executor. Implementations must cross the Environment
/// boundary rather than spawning a process directly.
pub trait CommandCredentialExecutor: Send + Sync + 'static {
	/// Executes one configured command and returns only its secret stdout value.
	fn execute(&self, command: Str, cancellation: CancellationToken) -> CommandExecutionFuture;
}

/// A redaction-safe command credential failure.
#[derive(Clone, Copy, Debug, thiserror::Error, Eq, PartialEq)]
pub enum CommandCredentialError {
	/// The caller cancelled resolution.
	#[error("command credential resolution was cancelled")]
	Cancelled,
	/// The configured timeout expired.
	#[error("command credential resolution timed out")]
	Timeout,
	/// The environment rejected or failed the command.
	#[error("command credential execution failed")]
	Execution,
	/// Standard output exceeded the secret-value bound.
	#[error("command credential output exceeded its limit")]
	OutputTooLarge,
	/// Standard output was not UTF-8.
	#[error("command credential output was not UTF-8")]
	InvalidUtf8,
	/// Trimmed standard output was empty.
	#[error("command credential output was empty")]
	Empty,
	/// A recent failure is still inside the bounded retry delay.
	#[error("command credential resolution is temporarily unavailable")]
	FailureCached,
}

#[derive(Debug)]
enum CacheEntry {
	Resolving(watch::Sender<()>),
	Ready(SecretString),
	FailedUntil(Instant),
}

/// Single-flight, process-lifetime successful command credential cache.
///
/// Successful values never leave their secret wrapper and remain cached for
/// this process. Failures are cached only for `failure_ttl`, preventing tight
/// retry loops without making a transient environment failure permanent.
pub struct CommandCredentialResolver {
	executor:    Arc<dyn CommandCredentialExecutor>,
	failure_ttl: Duration,
	cache:       Mutex<BTreeMap<Str, CacheEntry>>,
}

impl CommandCredentialResolver {
	/// Creates a resolver over an injected Environment executor.
	pub fn new(executor: Arc<dyn CommandCredentialExecutor>, failure_ttl: Duration) -> Self {
		Self { executor, failure_ttl, cache: Mutex::new(BTreeMap::new()) }
	}

	/// Invalidates one command's successful or failed cached result.
	///
	/// The next [`Self::resolve`] call executes the command again. Empty command
	/// strings are ignored.
	pub fn invalidate(&self, command: &str) -> bool {
		let command = command.trim();
		!command.is_empty() && self.cache.lock().remove(command).is_some()
	}

	/// Resolves a configured command, sharing concurrent work for the same
	/// command.
	pub async fn resolve(
		&self,
		command: &str,
		cancellation: CancellationToken,
	) -> Result<SecretString, CommandCredentialError> {
		let command = command.trim();
		if command.is_empty() {
			return Err(CommandCredentialError::Empty);
		}
		let key = Str::new(command);
		loop {
			let pending = {
				let mut cache = self.cache.lock();
				match cache.get(&key) {
					Some(CacheEntry::Ready(secret)) => return Ok(secret.clone()),
					Some(CacheEntry::FailedUntil(until)) if *until > Instant::now() => {
						return Err(CommandCredentialError::FailureCached);
					},
					// Subscribing under the lock snapshots the sender's version, so a
					// completion between releasing the lock and awaiting `changed()`
					// still resolves the wait — no lost wakeup.
					Some(CacheEntry::Resolving(done)) => Some(done.subscribe()),
					Some(CacheEntry::FailedUntil(_)) | None => {
						let (done, _) = watch::channel(());
						cache.insert(key.clone(), CacheEntry::Resolving(done));
						None
					},
				}
			};
			if let Some(mut done) = pending {
				tokio::select! {
					() = cancellation.cancelled() => return Err(CommandCredentialError::Cancelled),
					_ = done.changed() => continue,
				}
			}
			let result = self
				.executor
				.execute(key.clone(), cancellation.clone())
				.await;
			{
				// Replacing the entry drops the `Resolving` sender, which wakes every
				// subscribed waiter via `changed()` returning a closed error.
				let mut cache = self.cache.lock();
				match &result {
					Ok(secret) => {
						cache.insert(key.clone(), CacheEntry::Ready(secret.clone()));
					},
					Err(_) => {
						cache.insert(
							key.clone(),
							CacheEntry::FailedUntil(Instant::now() + self.failure_ttl),
						);
					},
				}
			}
			return result;
		}
	}
}

impl fmt::Debug for CommandCredentialResolver {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CommandCredentialResolver")
			.field("failure_ttl", &self.failure_ttl)
			.finish_non_exhaustive()
	}
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use omp_core::ExposeSecret as _;
	use tokio::{task, time};

	use super::*;

	struct CountingExecutor {
		calls: AtomicUsize,
		fail:  AtomicUsize,
	}

	impl CommandCredentialExecutor for CountingExecutor {
		fn execute(&self, _: Str, _: CancellationToken) -> CommandExecutionFuture {
			let call = self.calls.fetch_add(1, Ordering::SeqCst);
			let fail = self.fail.load(Ordering::SeqCst);
			Box::pin(async move {
				task::yield_now().await;
				if call < fail {
					Err(CommandCredentialError::Execution)
				} else {
					Ok(SecretString::from("secret-marker"))
				}
			})
		}
	}

	#[tokio::test]
	async fn concurrent_success_executes_once_and_never_debugs_secret() {
		let executor =
			Arc::new(CountingExecutor { calls: AtomicUsize::new(0), fail: AtomicUsize::new(0) });
		let resolver =
			Arc::new(CommandCredentialResolver::new(executor.clone(), Duration::from_millis(10)));
		let (left, right) = tokio::join!(
			resolver.resolve("credential command", CancellationToken::new()),
			resolver.resolve("credential command", CancellationToken::new())
		);
		assert_eq!(left.unwrap().expose_secret(), "secret-marker");
		assert_eq!(right.unwrap().expose_secret(), "secret-marker");
		assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
		assert!(!format!("{resolver:?}").contains("secret-marker"));
	}

	#[tokio::test]
	async fn invalidation_reexecutes_a_successful_command() {
		let executor =
			Arc::new(CountingExecutor { calls: AtomicUsize::new(0), fail: AtomicUsize::new(0) });
		let resolver = CommandCredentialResolver::new(executor.clone(), Duration::from_secs(1));
		resolver
			.resolve("credential command", CancellationToken::new())
			.await
			.expect("initial credential");
		assert!(resolver.invalidate(" credential command "));
		resolver
			.resolve("credential command", CancellationToken::new())
			.await
			.expect("refreshed credential");
		assert_eq!(executor.calls.load(Ordering::SeqCst), 2);
	}

	#[tokio::test(start_paused = true)]
	async fn transient_failure_retries_after_ttl() {
		let executor =
			Arc::new(CountingExecutor { calls: AtomicUsize::new(0), fail: AtomicUsize::new(1) });
		let resolver = CommandCredentialResolver::new(executor.clone(), Duration::from_millis(1));
		assert!(matches!(
			resolver
				.resolve("credential command", CancellationToken::new())
				.await,
			Err(CommandCredentialError::Execution)
		));
		assert!(matches!(
			resolver
				.resolve("credential command", CancellationToken::new())
				.await,
			Err(CommandCredentialError::FailureCached)
		));
		time::advance(Duration::from_millis(2)).await;
		assert_eq!(
			resolver
				.resolve("credential command", CancellationToken::new())
				.await
				.unwrap()
				.expose_secret(),
			"secret-marker"
		);
		assert_eq!(executor.calls.load(Ordering::SeqCst), 2);
	}
}
