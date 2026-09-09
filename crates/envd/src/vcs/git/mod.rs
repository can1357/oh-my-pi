//! Git repository facades backed by `omp-vcs`.

use tokio_util::sync::CancellationToken;

pub mod commands;
pub mod diff;
pub mod lock;
pub mod mutation;
pub mod query;
pub mod refs;
pub mod repo;

/// Runs one in-process VCS operation off the async executor, while allowing the
/// caller to stop waiting. The operation itself is intentionally allowed to
/// finish on the blocking pool after cancellation.
pub(crate) async fn blocking<T, F>(
	cancel: Option<&CancellationToken>,
	operation: F,
) -> Result<T, omp_vcs::Error>
where
	T: Send + 'static,
	F: FnOnce() -> Result<T, omp_vcs::Error> + Send + 'static,
{
	let task = tokio::task::spawn_blocking(operation);
	if let Some(cancel) = cancel {
		tokio::select! {
			() = cancel.cancelled() => Err(omp_vcs::Error::Canceled),
			result = task => result.map_err(|error| omp_vcs::Error::backend("VCS blocking task", error))?,
		}
	} else {
		task
			.await
			.map_err(|error| omp_vcs::Error::backend("VCS blocking task", error))?
	}
}

#[cfg(test)]
mod tests;
