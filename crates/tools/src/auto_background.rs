//! Shared foreground-wait policy for tools that can detach long-running work.

use std::{
	future::Future,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::{FutureExt, pin_mut};
use omp_core::{Str, sf};
use omp_tool::{
	ArtifactLifetime, ExpectedArtifact, JobKind, JobMetadata, JobOwner, JobRef, ToolTerminal,
};
use tokio::{runtime, time};

/// Default time a managed tool waits in the foreground before detaching.
pub const DEFAULT_AUTO_BACKGROUND_THRESHOLD: Duration = Duration::from_secs(15);
const TIMEOUT_BUFFER: Duration = Duration::from_secs(1);

/// Detached work returned by a resource adapter after ownership transfer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DetachedJob {
	/// Stable environment job identifier.
	pub id:    Str,
	/// Resource generation that authoritatively reports settlement.
	pub owner: JobOwner,
}

/// Builds the canonical session-lifetime terminal for managed detached work.
pub fn managed_job_terminal<P, F>(
	job: DetachedJob,
	kind: JobKind,
	description: impl Into<Str>,
) -> ToolTerminal<P, F> {
	let description = description.into();
	let started_at_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX);
	ToolTerminal::Detached(JobRef {
		id:       job.id,
		owner:    job.owner,
		metadata: Arc::new(JobMetadata::running(kind, description.clone(), started_at_ms)),
		artifact: ExpectedArtifact {
			description,
			media_type: Some(sf!("application/vnd.omp.process-settlement+json")),
			lifetime: ArtifactLifetime::Session,
		},
	})
}

/// Formats the model-facing notice for a newly detached job.
pub fn format_background_notice(job_id: &str) -> Str {
	sf!("Backgrounded as job {job_id}; result will be delivered automatically.")
}

/// Allocates the next stable managed-job name for one tool instance.
pub fn next_background_name(prefix: &str, sequence: &AtomicU64) -> Str {
	sf!("{prefix}-bg-{}", sequence.fetch_add(1, Ordering::Relaxed))
}

/// Resolves the foreground wait against the invocation's own timeout.
///
/// A one-second buffer lets a short invocation settle inline instead of being
/// detached immediately before its deadline. A zero threshold backgrounds
/// immediately.
pub fn resolve_auto_background_wait(threshold: Duration, timeout: Option<Duration>) -> Duration {
	let Some(timeout) = timeout else {
		return threshold;
	};
	let wait = if timeout <= TIMEOUT_BUFFER {
		timeout
	} else {
		timeout.checked_sub(TIMEOUT_BUFFER).unwrap()
	};
	threshold.min(wait)
}

/// Result of racing one resource event against interruption and backgrounding.
pub enum JobWait<S, I> {
	/// The resource emitted its next event.
	Settled(S),
	/// The invocation owner supplied an interrupt.
	Interrupted(I),
	/// The foreground wait threshold elapsed.
	Background,
}

/// One absolute foreground deadline reused while a streaming job emits output.
///
/// Reusing the absolute deadline prevents each output frame from restarting the
/// threshold.
pub struct ForegroundWait {
	deadline: Instant,
}

impl ForegroundWait {
	/// Starts a foreground wait using the shared threshold/timeout policy.
	pub fn new(threshold: Duration, timeout: Option<Duration>) -> Self {
		Self { deadline: Instant::now() + resolve_auto_background_wait(threshold, timeout) }
	}

	/// Races the next resource event, invocation interrupt, and absolute
	/// foreground deadline without allocating or leaving a live timer behind.
	pub async fn race<S, I>(&self, settled: S, interrupted: I) -> JobWait<S::Output, I::Output>
	where
		S: Future,
		I: Future,
	{
		if Instant::now() >= self.deadline {
			return JobWait::Background;
		}
		let settled = settled.fuse();
		let interrupted = interrupted.fuse();
		pin_mut!(settled, interrupted);
		if runtime::Handle::try_current().is_err() {
			return futures::select_biased! {
				value = settled => JobWait::Settled(value),
				value = interrupted => JobWait::Interrupted(value),
			};
		}
		let threshold = {
			use tokio::time::Instant;

			time::sleep_until(Instant::from_std(self.deadline)).fuse()
		};
		pin_mut!(threshold);
		futures::select_biased! {
			value = settled => JobWait::Settled(value),
			value = interrupted => JobWait::Interrupted(value),
			() = threshold => JobWait::Background,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn wait_budget_keeps_timeout_buffer() {
		assert_eq!(
			resolve_auto_background_wait(
				DEFAULT_AUTO_BACKGROUND_THRESHOLD,
				Some(Duration::from_secs(10)),
			),
			Duration::from_secs(9),
		);
		assert_eq!(
			resolve_auto_background_wait(
				DEFAULT_AUTO_BACKGROUND_THRESHOLD,
				Some(Duration::from_millis(500)),
			),
			Duration::from_millis(500),
		);
		assert_eq!(
			resolve_auto_background_wait(
				DEFAULT_AUTO_BACKGROUND_THRESHOLD,
				Some(Duration::from_secs(120)),
			),
			Duration::from_secs(15),
		);
		assert_eq!(
			resolve_auto_background_wait(DEFAULT_AUTO_BACKGROUND_THRESHOLD, None),
			Duration::from_secs(15),
		);
	}

	#[test]
	fn notice_names_automatic_delivery() {
		assert_eq!(
			format_background_notice("eval-bg-7"),
			"Backgrounded as job eval-bg-7; result will be delivered automatically.",
		);
	}
}
