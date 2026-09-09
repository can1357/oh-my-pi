//! Provider-neutral state machine for resumable asynchronous jobs.

use std::{
	fmt,
	sync::Arc,
	time::{Duration, SystemTime},
};

use flume::Receiver;
use omp_core::Str;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::{
	catalog::{OperationKind, ProviderId, RouteId},
	id::GenerationHandle,
};

/// Provider-qualified identity of a resumable operation job.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct JobRef {
	/// Provider that owns the handle namespace.
	pub provider:  ProviderId,
	/// Route on which the handle is valid.
	pub route:     RouteId,
	/// Operation that created the job.
	pub operation: OperationKind,
	/// Opaque sanitized provider handle.
	pub handle:    GenerationHandle,
}

/// Serializable caller-held state needed to resume polling.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct JobCheckpoint {
	/// Qualified job identity.
	pub job:        JobRef,
	/// Last accepted monotonic completed counter.
	pub completed:  u64,
	/// Last accepted total counter.
	pub total:      Option<u64>,
	/// Polls already issued for this job.
	pub polls:      u32,
	/// Absolute expiry after which the handle must not be used.
	pub expires_at: Option<SystemTime>,
	/// Original submission time retained across resumes.
	pub created_at: SystemTime,
}

/// Clone-cheap live checkpoint shared by a generation session and its job
/// actor.
#[derive(Clone)]
pub struct JobCheckpointHandle {
	inner: Arc<RwLock<JobCheckpoint>>,
}

impl JobCheckpointHandle {
	/// Starts a live checkpoint at submission or explicit resume state.
	pub fn new(checkpoint: JobCheckpoint) -> Self {
		Self { inner: Arc::new(RwLock::new(checkpoint)) }
	}

	/// Returns a consistent resumable checkpoint snapshot.
	pub fn snapshot(&self) -> JobCheckpoint {
		self.inner.read().clone()
	}

	/// Replaces the checkpoint after the actor accepts a monotonic update.
	pub(crate) fn update(&self, checkpoint: JobCheckpoint) {
		*self.inner.write() = checkpoint;
	}
}

impl fmt::Debug for JobCheckpointHandle {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_tuple("JobCheckpointHandle")
			.field(&self.snapshot())
			.finish()
	}
}

/// Polling and lifetime bounds shared by asynchronous operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JobPolicy {
	/// Initial delay before polling.
	pub initial_delay: Duration,
	/// Maximum delay accepted from a route poll response.
	pub max_delay:     Duration,
	/// Maximum number of polls, including polls before a resume.
	pub max_polls:     u32,
	/// Maximum elapsed job lifetime.
	pub max_elapsed:   Duration,
}

/// Provider-neutral state obtained from one poll response.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JobUpdate<A> {
	/// Job remains queued.
	Queued {
		/// Provider-requested delay before the next poll.
		retry_after: Option<Duration>,
	},
	/// Job is running with monotonic progress.
	Running {
		/// Completed work units.
		completed:   u64,
		/// Total work units when the provider reports one.
		total:       Option<u64>,
		/// Provider-requested delay before the next poll.
		retry_after: Option<Duration>,
	},
	/// Job produced an artifact descriptor or download locator.
	Artifact(A),
	/// Job completed and no more polling is allowed.
	Succeeded,
	/// Provider confirmed cancellation.
	Cancelled,
	/// Job failed with a sanitized typed code and message.
	Failed {
		/// Sanitized provider failure code.
		code:    Str,
		/// Sanitized provider failure message.
		message: Str,
	},
}

/// Next action chosen by the polling state machine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JobAction<A> {
	/// Wait for the bounded duration and issue another poll.
	PollAfter(Duration),
	/// Stream the supplied artifact before polling again.
	Download(A),
	/// Send one cancellation request.
	Cancel,
	/// Job reached a successful terminal state.
	Complete,
	/// Job reached a cancelled terminal state.
	Cancelled,
}

/// Typed polling failure independent of provider wire errors.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JobError {
	/// Poll response reduced progress or contradicted a known total.
	NonMonotonicProgress,
	/// Completed work exceeds total work.
	InvalidProgress {
		/// Completed work units reported by the provider.
		completed: u64,
		/// Total work units reported by the provider.
		total:     u64,
	},
	/// Poll count exceeded the caller policy.
	PollLimit {
		/// Maximum permitted poll count.
		limit: u32,
	},
	/// Job exceeded its lifetime or provider expiry.
	Expired,
	/// An update arrived after a terminal transition.
	AlreadyTerminal,
	/// Provider reported a typed job failure.
	Provider {
		/// Sanitized provider failure code.
		code:    Str,
		/// Sanitized provider failure message.
		message: Str,
	},
}

/// Final cancellation evidence included in operation receipts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobCancellationReceipt {
	/// Qualified cancelled job.
	pub job:          JobRef,
	/// Whether a cancel request was dispatched.
	pub dispatched:   bool,
	/// Whether provider cancellation was confirmed.
	pub acknowledged: bool,
	/// Poll count at cancellation.
	pub polls:        u32,
}

/// Actor command for a shared asynchronous job controller.
#[derive(Debug)]
pub enum JobCommand {
	/// Cancel the provider job and optionally acknowledge explicit cancellation.
	Cancel {
		/// Receipt channel present for explicit `cancel().await` and absent for
		/// Drop.
		acknowledgement: Option<flume::Sender<JobCancellationReceipt>>,
	},
}

/// Immediate backend action selected from a job actor command.
#[derive(Debug)]
pub enum JobCommandAction {
	/// Dispatch one provider cancellation request.
	Cancel {
		/// Qualified job to cancel.
		job:             JobRef,
		/// Optional explicit-caller acknowledgement channel.
		acknowledgement: Option<flume::Sender<JobCancellationReceipt>>,
	},
}
/// Failure to dispatch or confirm an explicit job cancellation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobCancelError {
	/// Command mailbox capacity must be non-zero.
	ZeroCapacity,
	/// Cancellation was already dispatched by this handle.
	AlreadyRequested,
	/// The job actor stopped before accepting cancellation.
	ActorClosed,
	/// The job actor stopped before confirming provider cancellation.
	AcknowledgementClosed,
}

/// Non-clone cancellation command handle owned by a generation session.
pub struct JobCancelHandle {
	job:          JobRef,
	sender:       flume::Sender<JobCommand>,
	command_sent: bool,
}

impl JobCancelHandle {
	/// Creates a bounded command mailbox and its unique session-owned handle.
	pub fn bounded(
		job: JobRef,
		capacity: usize,
	) -> Result<(Self, Receiver<JobCommand>), JobCancelError> {
		if capacity == 0 {
			return Err(JobCancelError::ZeroCapacity);
		}
		let (sender, receiver) = flume::bounded(capacity);
		Ok((Self { job, sender, command_sent: false }, receiver))
	}

	/// Requests cancellation and waits for the actor's typed provider receipt.
	pub async fn cancel(&mut self) -> Result<JobCancellationReceipt, JobCancelError> {
		if self.command_sent {
			return Err(JobCancelError::AlreadyRequested);
		}
		self.command_sent = true;
		let (acknowledgement, receipt) = flume::bounded(1);
		self
			.sender
			.send_async(JobCommand::Cancel { acknowledgement: Some(acknowledgement) })
			.await
			.map_err(|_| JobCancelError::ActorClosed)?;
		receipt
			.recv_async()
			.await
			.map_err(|_| JobCancelError::AcknowledgementClosed)
	}

	/// Returns the stable provider-qualified job identity.
	pub const fn job(&self) -> &JobRef {
		&self.job
	}

	/// Returns whether this handle already dispatched its single cancel command.
	pub const fn cancellation_requested(&self) -> bool {
		self.command_sent
	}

	/// Disarms Drop after a containing session rejects ownership before
	/// publication.
	pub(crate) const fn disarm(&mut self) {
		self.command_sent = true;
	}
}

impl fmt::Debug for JobCancelHandle {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("JobCancelHandle")
			.field("job", &self.job)
			.field("command_sent", &self.command_sent)
			.finish()
	}
}

impl Drop for JobCancelHandle {
	fn drop(&mut self) {
		if !self.command_sent {
			self.command_sent = true;
			let _ = self
				.sender
				.try_send(JobCommand::Cancel { acknowledgement: None });
		}
	}
}

/// Stateful verifier and action planner for a single asynchronous job.
#[derive(Debug)]
pub struct JobController {
	checkpoint:          JobCheckpoint,
	checkpoint_handle:   JobCheckpointHandle,
	policy:              JobPolicy,
	terminal:            bool,
	cancel_requested:    bool,
	cancel_dispatched:   bool,
	cancel_acknowledged: bool,
}

impl JobController {
	/// Starts polling a newly submitted job.
	pub fn submitted(
		job: JobRef,
		policy: JobPolicy,
		now: SystemTime,
		expires_at: Option<SystemTime>,
	) -> Self {
		let checkpoint =
			JobCheckpoint { job, completed: 0, total: None, polls: 0, expires_at, created_at: now };
		let checkpoint_handle = JobCheckpointHandle::new(checkpoint.clone());
		Self {
			checkpoint,
			checkpoint_handle,
			policy,
			terminal: false,
			cancel_requested: false,
			cancel_dispatched: false,
			cancel_acknowledged: false,
		}
	}

	/// Restores polling from explicit caller-held state.
	pub fn resume(
		checkpoint: JobCheckpoint,
		policy: JobPolicy,
		now: SystemTime,
	) -> Result<Self, JobError> {
		if checkpoint.polls >= policy.max_polls {
			return Err(JobError::PollLimit { limit: policy.max_polls });
		}
		if checkpoint.expires_at.is_some_and(|expiry| now >= expiry)
			|| now
				.duration_since(checkpoint.created_at)
				.unwrap_or_default()
				>= policy.max_elapsed
		{
			return Err(JobError::Expired);
		}
		let checkpoint_handle = JobCheckpointHandle::new(checkpoint.clone());
		Ok(Self {
			checkpoint,
			checkpoint_handle,
			policy,
			terminal: false,
			cancel_requested: false,
			cancel_dispatched: false,
			cancel_acknowledged: false,
		})
	}

	/// Requests cancellation; the next action is exactly one cancel dispatch.
	pub const fn request_cancel(&mut self) -> Result<(), JobError> {
		if self.terminal {
			return Err(JobError::AlreadyTerminal);
		}
		self.cancel_requested = true;
		Ok(())
	}

	/// Accepts an actor command and returns the exact backend action to
	/// dispatch.
	pub fn accept_command(&mut self, command: JobCommand) -> Result<JobCommandAction, JobError> {
		if self.terminal || self.cancel_dispatched {
			return Err(JobError::AlreadyTerminal);
		}
		match command {
			JobCommand::Cancel { acknowledgement } => {
				self.cancel_requested = true;
				self.cancel_dispatched = true;
				Ok(JobCommandAction::Cancel { job: self.checkpoint.job.clone(), acknowledgement })
			},
		}
	}

	/// Records provider cancellation outcome and returns its typed receipt.
	pub fn complete_cancel(&mut self, acknowledged: bool) -> JobCancellationReceipt {
		self.cancel_acknowledged = acknowledged;
		if acknowledged {
			self.terminal = true;
		}
		self.cancellation_receipt()
	}

	/// Records one poll response and chooses the next operation.
	pub fn update<A>(
		&mut self,
		update: JobUpdate<A>,
		now: SystemTime,
	) -> Result<JobAction<A>, JobError> {
		self.ensure_active(now)?;
		if self.cancel_requested && !self.cancel_dispatched {
			self.cancel_dispatched = true;
			return Ok(JobAction::Cancel);
		}
		self.checkpoint.polls = self.checkpoint.polls.saturating_add(1);
		if self.checkpoint.polls > self.policy.max_polls {
			return Err(JobError::PollLimit { limit: self.policy.max_polls });
		}
		let action = match update {
			JobUpdate::Queued { retry_after } => {
				JobAction::PollAfter(self.next_poll_delay(retry_after)?)
			},
			JobUpdate::Running { completed, total, retry_after } => {
				self.accept_progress(completed, total)?;
				JobAction::PollAfter(self.next_poll_delay(retry_after)?)
			},
			JobUpdate::Artifact(artifact) => JobAction::Download(artifact),
			JobUpdate::Succeeded => {
				self.terminal = true;
				JobAction::Complete
			},
			JobUpdate::Cancelled => {
				self.terminal = true;
				self.cancel_acknowledged = true;
				JobAction::Cancelled
			},
			JobUpdate::Failed { code, message } => {
				self.terminal = true;
				return Err(JobError::Provider { code, message });
			},
		};
		self.checkpoint_handle.update(self.checkpoint.clone());
		Ok(action)
	}

	/// Returns the live checkpoint handle shared with the generation session.
	pub fn checkpoint_handle(&self) -> JobCheckpointHandle {
		self.checkpoint_handle.clone()
	}

	/// Returns an explicit checkpoint suitable for caller persistence.
	pub fn checkpoint(&self) -> JobCheckpoint {
		self.checkpoint.clone()
	}

	/// Returns cancellation evidence without changing state.
	pub fn cancellation_receipt(&self) -> JobCancellationReceipt {
		JobCancellationReceipt {
			job:          self.checkpoint.job.clone(),
			dispatched:   self.cancel_dispatched,
			acknowledged: self.cancel_acknowledged,
			polls:        self.checkpoint.polls,
		}
	}

	fn ensure_active(&self, now: SystemTime) -> Result<(), JobError> {
		if self.terminal {
			return Err(JobError::AlreadyTerminal);
		}
		if self
			.checkpoint
			.expires_at
			.is_some_and(|expiry| now >= expiry)
			|| now
				.duration_since(self.checkpoint.created_at)
				.unwrap_or_default()
				>= self.policy.max_elapsed
		{
			return Err(JobError::Expired);
		}
		Ok(())
	}

	fn accept_progress(&mut self, completed: u64, total: Option<u64>) -> Result<(), JobError> {
		if completed < self.checkpoint.completed
			|| self
				.checkpoint
				.total
				.is_some_and(|known| total != Some(known))
		{
			return Err(JobError::NonMonotonicProgress);
		}
		if let Some(total) = total
			&& completed > total
		{
			return Err(JobError::InvalidProgress { completed, total });
		}
		self.checkpoint.completed = completed;
		self.checkpoint.total = total.or(self.checkpoint.total);
		Ok(())
	}

	fn next_poll_delay(&self, requested: Option<Duration>) -> Result<Duration, JobError> {
		if self.checkpoint.polls >= self.policy.max_polls {
			return Err(JobError::PollLimit { limit: self.policy.max_polls });
		}
		Ok(requested
			.unwrap_or(self.policy.initial_delay)
			.min(self.policy.max_delay))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn controller() -> JobController {
		let job = JobRef {
			provider:  ProviderId::from("provider"),
			route:     RouteId::from("route"),
			operation: OperationKind::GenerateVideo,
			handle:    GenerationHandle::from("job"),
		};
		JobController::submitted(
			job,
			JobPolicy {
				initial_delay: Duration::from_secs(1),
				max_delay:     Duration::from_secs(5),
				max_polls:     3,
				max_elapsed:   Duration::from_secs(30),
			},
			SystemTime::UNIX_EPOCH,
			None,
		)
	}

	#[test]
	fn cancellation_dispatches_once_and_is_receipted() {
		let mut job = controller();
		job.request_cancel().unwrap();
		assert!(matches!(
			job.update::<()>(JobUpdate::Queued { retry_after: None }, SystemTime::UNIX_EPOCH),
			Ok(JobAction::Cancel)
		));
		assert!(job.cancellation_receipt().dispatched);
		assert!(matches!(
			job.update::<()>(JobUpdate::Cancelled, SystemTime::UNIX_EPOCH),
			Ok(JobAction::Cancelled)
		));
		assert!(job.cancellation_receipt().acknowledged);
	}

	#[test]
	fn progress_never_moves_backwards() {
		let mut job = controller();
		job.update::<()>(
			JobUpdate::Running { completed: 2, total: Some(4), retry_after: None },
			SystemTime::UNIX_EPOCH,
		)
		.unwrap();
		assert_eq!(
			job.update::<()>(
				JobUpdate::Running { completed: 1, total: Some(4), retry_after: None },
				SystemTime::UNIX_EPOCH
			),
			Err(JobError::NonMonotonicProgress)
		);
	}
}
