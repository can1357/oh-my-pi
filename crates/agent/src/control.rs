//! Serialized extension CONTROL routing into the session journal owner.
//!
//! The mailbox is deliberately receiver-owned rather than spawning a second
//! journal task. The agent loop remains the sole mutable [`Journal`] owner and
//! drains these commands at its established mailbox points; one command is
//! fully handled before another callback may enter.

use std::{
	collections::{BTreeMap, VecDeque},
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use bytes::Bytes;
use flume::Receiver;
use omp_core::{Str, sf};
use omp_storage::{
	blob::BlobRef,
	state::{ContentRoot, DurableRequest, StateAuthority, StateRevision},
	transcript::{InvocationTransition, ModelChange, TitleSource},
};
use parking_lot::Mutex;
use serde_json::value::RawValue;
use thiserror::Error;

use crate::{
	AgentHostControl, ArbiterError, core_regime,
	journal::{
		Journal, JournalCustomEntry, JournalError, JournalQuery, JournalReply, JournalRequest,
		SessionStateValue, SessionStateWatchEvent, WorkspaceRoots,
	},
	journal_kinds::EntryKindDecl,
	r#loop,
	r#loop::{ActiveCheckpoint, CheckpointState},
	regime::{
		ActivationId, Regime, RegimeRecord, RegimeSpec, RegimeStepResult, StartError, StartOptions,
		StartReceipt, StopError,
	},
};

/// A cloneable sender for authenticated extension CONTROL operations.
#[derive(Clone)]
pub struct ControlSender {
	commands:         flume::Sender<ControlCommand>,
	next_receipt:     Arc<AtomicU64>,
	checkpoint_state: Arc<Mutex<CheckpointState>>,
	host_control:     Arc<Mutex<Option<AgentHostControl>>>,
}

/// The receive half retained by the sole mutable journal owner.
pub struct ControlMailbox {
	commands:         Receiver<ControlCommand>,
	checkpoint_state: Arc<Mutex<CheckpointState>>,
}

/// Failure to deliver or execute a journal-owner CONTROL operation.
#[derive(Debug, Error)]
pub enum ControlError {
	/// The sole journal owner has stopped receiving commands.
	#[error("agent CONTROL journal owner is unavailable")]
	Closed,
	/// The journal rejected the authenticated operation.
	#[error(transparent)]
	Journal(#[from] JournalError),
	/// A second checkpoint was requested before the active one settled.
	#[error("checkpoint already active")]
	CheckpointAlreadyActive,
	/// Rewind was requested before any checkpoint was created.
	#[error("no active checkpoint")]
	NoActiveCheckpoint,
	/// Rewind was repeated after the active checkpoint completed.
	#[error("checkpoint already completed; continue from the retained rewind report")]
	CheckpointAlreadyCompleted,
	/// The opaque token was not issued by this active session.
	#[error("checkpoint token does not belong to the active session")]
	WrongCheckpointToken,
	/// A rewind report contained no findings.
	#[error("rewind report must not be empty")]
	EmptyRewindReport,
	/// A rewind for the active checkpoint is already queued.
	#[error("rewind already scheduled for the active checkpoint")]
	RewindAlreadyScheduled,
	/// The regime set rejected a start.
	#[error(transparent)]
	RegimeStart(#[from] StartError),
	/// The regime set rejected a stop.
	#[error(transparent)]
	RegimeStop(#[from] StopError),
	/// Regime journaling or arbitration failed on the mutable agent owner.
	#[error(transparent)]
	RegimeArbiter(#[from] ArbiterError),
	/// A built-in regime selector was not declared by Core.
	#[error("unknown core regime `{id}`")]
	UnknownCoreRegime {
		/// Unknown stable declaration identity.
		id: Str,
	},
}

/// Authoritative acknowledgement that a checkpoint became active.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointAck {
	/// Opaque session-owned checkpoint token.
	pub token:      Str,
	/// Checkpoint creation time in epoch milliseconds.
	pub started_at: u64,
}

/// Authoritative acknowledgement that a rewind entered the boundary queue.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewindAck {
	/// Opaque token accepted for the queued rewind.
	pub token:   Str,
	/// Agent-issued command identifier.
	pub receipt: Str,
}

/// A rewind command surfaced to the agent loop for boundary execution.
pub struct ScheduledRewind {
	/// Opaque session-owned checkpoint token.
	pub token:      Str,
	/// Durable journal event index resolved from the active checkpoint.
	pub target:     u64,
	/// Findings retained after discarded exploration.
	pub report:     Str,
	/// Exploration goal retained for recovery guidance.
	pub goal:       Str,
	/// Checkpoint creation time in epoch milliseconds.
	pub started_at: u64,
}

/// Result of receiving one typed CONTROL command.
///
/// Journal-owner harnesses outside the agent loop drive
/// [`ControlMailbox::handle_next`] and match on this; loop-scoped rewinds must
/// be executed (or refused) by whoever owns full agent state.
pub enum ControlMailboxEvent {
	/// Every sender has closed.
	Closed,
	/// A journal-scoped command completed on the journal owner.
	JournalHandled,
	/// A loop-scoped rewind is ready for boundary execution.
	Rewind(ScheduledRewind),
	/// A regime command requires mutable access to the agent arbiter.
	Regime(RegimeControl),
}
/// One authenticated regime lifecycle operation surfaced to the mutable agent
/// owner.
pub enum RegimeControl {
	/// Start one declared regime activation.
	Start {
		/// Immutable declaration.
		spec:    Arc<RegimeSpec>,
		/// Extension or core handler.
		handler: Box<dyn Regime>,
		/// Start options.
		options: StartOptions,
		/// Correlated result.
		reply:   flume::Sender<Result<StartReceipt, ControlError>>,
	},
	/// Project every active or queued activation.
	Active {
		/// Correlated result.
		reply: flume::Sender<Result<Vec<RegimeRecord>, ControlError>>,
	},
	/// Stop one active or queued activation.
	Stop {
		/// Activation identity.
		activation: ActivationId,
		/// Current epoch milliseconds.
		now_ms:     u64,
		/// Correlated result.
		reply:      flume::Sender<Result<bool, ControlError>>,
	},
	/// Stop one activation and atomically project the resulting regime set.
	StopSnapshot {
		/// Activation identity.
		activation: ActivationId,
		/// Current epoch milliseconds.
		now_ms:     u64,
		/// Correlated stop result and post-stop records.
		reply:      flume::Sender<Result<(bool, Vec<RegimeRecord>), ControlError>>,
	},
	/// Advance one activation's committed-step count.
	Advance {
		/// Activation identity.
		activation: ActivationId,
		/// Forensic transition reason.
		reason:     Str,
		/// Correlated result.
		reply:      flume::Sender<Result<RegimeStepResult, ControlError>>,
	},
	/// Cancel one activation immediately.
	Cancel {
		/// Activation identity.
		activation: ActivationId,
		/// Correlated result.
		reply:      flume::Sender<Result<bool, ControlError>>,
	},
	/// Update one regime activation's typed state payload.
	UpdateState {
		/// Activation identity.
		activation: ActivationId,
		/// Versioned handler-state payload.
		payload:    Bytes,
		/// Correlated durable entry.
		reply:      flume::Sender<Result<RegimeRecord, ControlError>>,
	},
}

impl RegimeControl {
	/// Rejects a loop-scoped command received by a journal-only harness.
	pub fn reject_unavailable(self) {
		match self {
			Self::Start { reply, .. } => {
				let _ = reply.send(Err(ControlError::Closed));
			},
			Self::Active { reply } => {
				let _ = reply.send(Err(ControlError::Closed));
			},
			Self::Stop { reply, .. } => {
				let _ = reply.send(Err(ControlError::Closed));
			},
			Self::StopSnapshot { reply, .. } => {
				let _ = reply.send(Err(ControlError::Closed));
			},
			Self::Advance { reply, .. } => {
				let _ = reply.send(Err(ControlError::Closed));
			},
			Self::Cancel { reply, .. } => {
				let _ = reply.send(Err(ControlError::Closed));
			},
			Self::UpdateState { reply, .. } => {
				let _ = reply.send(Err(ControlError::Closed));
			},
		}
	}
}

type JournalReplyResult<T> = Result<T, JournalError>;

/// Creates the extension CONTROL mailbox pair.
///
/// The channel is unbounded because every durable request already has a bounded
/// protobuf frame and backpressure happens at the worker request correlation
/// slot. The receiver must stay with the sole [`Journal`] owner.
pub fn channel() -> (ControlSender, ControlMailbox) {
	let (commands, receiver) = flume::unbounded();
	let checkpoint_state = Arc::new(Mutex::new(CheckpointState::default()));
	(
		ControlSender {
			commands,
			next_receipt: Arc::new(AtomicU64::new(1)),
			checkpoint_state: Arc::clone(&checkpoint_state),
			host_control: Arc::new(Mutex::new(None)),
		},
		ControlMailbox { commands: receiver, checkpoint_state },
	)
}

impl ControlSender {
	pub(crate) fn checkpoint_state(&self) -> Arc<Mutex<CheckpointState>> {
		Arc::clone(&self.checkpoint_state)
	}

	pub(crate) fn bind_host_control(&self, host: AgentHostControl) {
		*self.host_control.lock() = Some(host);
	}

	/// Returns the generation-fenced live Agent projection mailbox.
	pub fn host_control(&self) -> Option<AgentHostControl> {
		self.host_control.lock().clone()
	}

	/// Appends an in-place reset boundary through the sole journal owner.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal transition failure.
	pub async fn reset(&self, ts: u64) -> Result<u64, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Reset { ts, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Appends a provider-reset hint through the sole journal owner.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal transition failure.
	pub async fn provider_reset(&self, ts: u64) -> Result<u64, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::ProviderReset { ts, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Appends a user-assigned durable session title through the journal owner.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal transition failure.
	pub async fn set_title(&self, ts: u64, title: Str) -> Result<u64, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::SetTitle { ts, title, source: TitleSource::User, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Appends an assistant-generated durable session title through the journal
	/// owner.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal transition failure.
	pub async fn set_generated_title(&self, ts: u64, title: Str) -> Result<u64, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::SetTitle { ts, title, source: TitleSource::Assistant, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Appends a session-only effective model override through the journal
	/// owner.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal transition failure.
	pub async fn model_override(&self, ts: u64, model: ModelChange) -> Result<u64, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::ModelOverride { ts, model, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Reads the durable effective workspace-root projection from the journal
	/// owner.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal query failure.
	pub async fn workspace_roots(&self) -> Result<WorkspaceRoots, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::WorkspaceRoots { reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Appends a future primary workspace-root change through the journal owner.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal transition failure.
	pub async fn move_workspace_root(&self, ts: u64, root: PathBuf) -> Result<u64, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::MoveWorkspaceRoot { ts, root, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Appends a Core-authored exploration checkpoint and returns its opaque
	/// session token.
	///
	/// # Errors
	pub async fn checkpoint(&self, goal: Str) -> Result<CheckpointAck, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Checkpoint { goal, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
	}

	/// Requests one authenticated journal operation and awaits its assigned
	/// indexes.
	///
	/// # Errors
	/// Returns [`ControlError::Closed`] if the journal owner stopped, or the
	/// journal's typed failure after it handled the request.
	pub async fn journal(&self, request: JournalRequest) -> Result<JournalReply, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Journal { request, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Atomically declares one authenticated extension's complete entry-kind
	/// set.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal declaration failure.
	pub async fn declare_entry_kinds(
		&self,
		extension: Str,
		declarations: Vec<EntryKindDecl>,
	) -> Result<(), ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::DeclareEntryKinds { extension, declarations, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Runs authenticated, namespace-scoped custom-entry queries on the sole
	/// journal owner and returns rows in ascending physical-index order.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal query failure.
	pub async fn query(
		&self,
		queries: Vec<JournalQuery>,
	) -> Result<Vec<JournalCustomEntry>, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Query { queries, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Reads the latest live SESSION-scoped value from the canonical journal.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal authority/query failure.
	pub async fn session_state_get(
		&self,
		authority: StateAuthority,
		key: Str,
	) -> Result<Option<SessionStateValue>, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::SessionStateGet { authority, key, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Atomically compares and replaces one SESSION-scoped value.
	///
	/// # Errors
	/// Returns a closed-owner, stale revision, authority, or journal failure.
	pub async fn session_state_compare_exchange(
		&self,
		ts: u64,
		authority: StateAuthority,
		key: Str,
		expected: Option<StateRevision>,
		value: Box<RawValue>,
		request: DurableRequest,
	) -> Result<SessionStateValue, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::SessionStateCompareExchange {
				ts,
				authority,
				key,
				expected,
				value,
				request,
				reply,
			})
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Subscribes to ordered SESSION state changes without pinning a journal
	/// callback.
	///
	/// The bounded receiver includes catch-up values newer than `since` followed
	/// by durable live updates. Dropping it cancels the subscription; terminal
	/// events distinguish lag from journal shutdown.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal authority/subscription failure.
	pub async fn session_state_watch(
		&self,
		authority: StateAuthority,
		key: Str,
		since: Option<StateRevision>,
	) -> Result<Receiver<SessionStateWatchEvent>, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::SessionStateWatch { authority, key, since, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Durably roots one already-stored blob in the live SESSION journal.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal authority failure.
	pub async fn session_state_root_content(
		&self,
		ts: u64,
		authority: StateAuthority,
		reference: BlobRef,
		request: DurableRequest,
	) -> Result<ContentRoot, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::SessionStateRootContent { ts, authority, reference, request, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Checks live SESSION-journal reachability for one blob.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal authority failure.
	pub async fn session_state_content_is_rooted(
		&self,
		authority: StateAuthority,
		reference: BlobRef,
	) -> Result<bool, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::SessionStateContentIsRooted { authority, reference, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Persists one invocation-machine transition on the same owner as extension
	/// entries.
	///
	/// # Errors
	/// Returns a closed-owner or typed journal transition failure.
	pub async fn invocation_transition(
		&self,
		ts: u64,
		transition: InvocationTransition,
	) -> Result<u64, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::InvocationTransition { ts, transition, reply })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
			.map_err(ControlError::from)
	}

	/// Starts one regime on the sole mutable agent owner.
	///
	/// # Errors
	/// Returns a closed-owner, declaration, resource-acquisition, or durable
	/// arbitration failure.
	pub async fn start_regime(
		&self,
		spec: Arc<RegimeSpec>,
		handler: Box<dyn Regime>,
		options: StartOptions,
	) -> Result<StartReceipt, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Regime(RegimeControl::Start { spec, handler, options, reply }))
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
	}

	/// Starts a built-in regime by stable declaration identity.
	///
	/// # Errors
	/// Returns [`ControlError::UnknownCoreRegime`] for an unknown identity, or
	/// any error returned by [`Self::start_regime`].
	pub async fn start_core_regime(
		&self,
		id: &str,
		queue: bool,
	) -> Result<StartReceipt, ControlError> {
		let (spec, handler) =
			core_regime(id).ok_or_else(|| ControlError::UnknownCoreRegime { id: Str::new(id) })?;
		self
			.start_regime(spec, handler, StartOptions { now_ms: r#loop::now_ms(), queue })
			.await
	}

	/// Advances one activation's committed-step accounting on the sole mutable
	/// owner.
	///
	/// # Errors
	/// Returns a closed-owner or durable arbitration failure.
	pub async fn advance_regime(
		&self,
		activation: ActivationId,
		reason: Str,
	) -> Result<RegimeStepResult, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Regime(RegimeControl::Advance { activation, reason, reply }))
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
	}

	/// Cancels one activation immediately on the sole mutable owner.
	///
	/// # Errors
	/// Returns a closed-owner or durable arbitration failure.
	pub async fn cancel_regime(&self, activation: ActivationId) -> Result<bool, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Regime(RegimeControl::Cancel { activation, reply }))
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
	}

	/// Updates one regime activation's typed state and returns the journaled
	/// record.
	///
	/// # Errors
	/// Returns a closed-owner, state-restoration, or durable journaling failure.
	pub async fn update_regime_state(
		&self,
		activation: ActivationId,
		payload: Bytes,
	) -> Result<RegimeRecord, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Regime(RegimeControl::UpdateState { activation, payload, reply }))
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
	}

	/// Returns every active or queued regime activation.
	///
	/// # Errors
	/// Returns [`ControlError::Closed`] if the mutable agent owner stopped.
	pub async fn active_regimes(&self) -> Result<Vec<RegimeRecord>, ControlError> {
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Regime(RegimeControl::Active { reply }))
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
	}

	/// Stops one regime activation on the sole mutable agent owner.
	///
	/// # Errors
	/// Returns a closed-owner, minimum-duration, or durable arbitration failure.
	pub async fn stop_regime(&self, activation: ActivationId) -> Result<bool, ControlError> {
		let now_ms = r#loop::now_ms();
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Regime(RegimeControl::Stop { activation, now_ms, reply }))
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
	}

	/// Stops one regime and returns the authoritative post-stop projection.
	///
	/// # Errors
	/// Returns a closed-owner, minimum-duration, or durable arbitration failure.
	pub async fn stop_regime_snapshot(
		&self,
		activation: ActivationId,
	) -> Result<(bool, Vec<RegimeRecord>), ControlError> {
		let now_ms = r#loop::now_ms();
		let (reply, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Regime(RegimeControl::StopSnapshot { activation, now_ms, reply }))
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
	}

	/// Schedules a full agent rewind for the next turn boundary.
	///
	/// The acknowledgement means the sole owner accepted the command into its
	/// boundary queue; execution deliberately happens later, after any active
	/// tool batch settles.
	///
	/// # Errors
	/// Returns [`ControlError::Closed`] if the agent loop stopped receiving.
	pub async fn schedule_rewind(&self, token: Str, report: Str) -> Result<RewindAck, ControlError> {
		let sequence = self.next_receipt.fetch_add(1, Ordering::Relaxed);
		let receipt = sf!("rewind-{sequence}");
		let (ack, response) = flume::bounded(1);
		self
			.commands
			.send(ControlCommand::Rewind { token, report, receipt: receipt.clone(), ack })
			.map_err(|_| ControlError::Closed)?;
		response
			.recv_async()
			.await
			.map_err(|_| ControlError::Closed)?
	}
}

impl ControlMailbox {
	/// Handles the next typed command, waiting without holding a lock.
	///
	/// Journal commands complete immediately. Loop-scoped commands are surfaced
	/// to the caller, which must execute them at its documented boundary.
	pub async fn handle_next(&self, journal: &mut Journal) -> ControlMailboxEvent {
		let Ok(command) = self.commands.recv_async().await else {
			return ControlMailboxEvent::Closed;
		};
		handle_command(journal, command, &self.checkpoint_state)
	}

	/// Drains at most `limit` commands already waiting at an agent-loop mailbox
	/// point.
	///
	/// Journal commands retain their existing latency. Loop-scoped commands are
	/// appended to `surfaced` in receive order for later boundary execution.
	pub(crate) fn drain_ready(
		&self,
		journal: &mut Journal,
		limit: usize,
		surfaced: &mut VecDeque<ScheduledRewind>,
		regimes: &mut Vec<RegimeControl>,
	) -> usize {
		let mut handled = 0;
		while handled < limit {
			let Ok(command) = self.commands.try_recv() else {
				break;
			};
			match handle_command(journal, command, &self.checkpoint_state) {
				ControlMailboxEvent::Rewind(rewind) => surfaced.push_back(rewind),
				ControlMailboxEvent::Regime(regime) => regimes.push(regime),
				ControlMailboxEvent::Closed | ControlMailboxEvent::JournalHandled => {},
			}
			handled += 1;
		}
		handled
	}
}

pub(crate) enum ControlCommand {
	Regime(RegimeControl),
	Reset {
		ts:    u64,
		reply: flume::Sender<JournalReplyResult<u64>>,
	},
	ProviderReset {
		ts:    u64,
		reply: flume::Sender<JournalReplyResult<u64>>,
	},
	ModelOverride {
		ts:    u64,
		model: ModelChange,
		reply: flume::Sender<JournalReplyResult<u64>>,
	},
	WorkspaceRoots {
		reply: flume::Sender<JournalReplyResult<WorkspaceRoots>>,
	},
	MoveWorkspaceRoot {
		ts:    u64,
		root:  PathBuf,
		reply: flume::Sender<JournalReplyResult<u64>>,
	},
	SetTitle {
		ts:     u64,
		title:  Str,
		source: TitleSource,
		reply:  flume::Sender<JournalReplyResult<u64>>,
	},
	Checkpoint {
		goal:  Str,
		reply: flume::Sender<Result<CheckpointAck, ControlError>>,
	},
	Journal {
		request: JournalRequest,
		reply:   flume::Sender<JournalReplyResult<JournalReply>>,
	},
	DeclareEntryKinds {
		extension:    Str,
		declarations: Vec<EntryKindDecl>,
		reply:        flume::Sender<JournalReplyResult<()>>,
	},
	Query {
		queries: Vec<JournalQuery>,
		reply:   flume::Sender<JournalReplyResult<Vec<JournalCustomEntry>>>,
	},
	SessionStateGet {
		authority: StateAuthority,
		key:       Str,
		reply:     flume::Sender<JournalReplyResult<Option<SessionStateValue>>>,
	},
	SessionStateCompareExchange {
		ts:        u64,
		authority: StateAuthority,
		key:       Str,
		expected:  Option<StateRevision>,
		value:     Box<RawValue>,
		request:   DurableRequest,
		reply:     flume::Sender<JournalReplyResult<SessionStateValue>>,
	},
	SessionStateWatch {
		authority: StateAuthority,
		key:       Str,
		since:     Option<StateRevision>,
		reply:     flume::Sender<JournalReplyResult<Receiver<SessionStateWatchEvent>>>,
	},
	SessionStateRootContent {
		ts:        u64,
		authority: StateAuthority,
		reference: BlobRef,
		request:   DurableRequest,
		reply:     flume::Sender<JournalReplyResult<ContentRoot>>,
	},
	SessionStateContentIsRooted {
		authority: StateAuthority,
		reference: BlobRef,
		reply:     flume::Sender<JournalReplyResult<bool>>,
	},
	InvocationTransition {
		ts:         u64,
		transition: InvocationTransition,
		reply:      flume::Sender<JournalReplyResult<u64>>,
	},
	Rewind {
		token:   Str,
		report:  Str,
		receipt: Str,
		ack:     flume::Sender<Result<RewindAck, ControlError>>,
	},
}

fn handle_command(
	journal: &mut Journal,
	command: ControlCommand,
	checkpoint_state: &Mutex<CheckpointState>,
) -> ControlMailboxEvent {
	match command {
		ControlCommand::Regime(command) => return ControlMailboxEvent::Regime(command),
		ControlCommand::Reset { ts, reply } => {
			let _ = reply.send(journal.reset(ts));
		},
		ControlCommand::ProviderReset { ts, reply } => {
			let _ = reply.send(journal.provider_reset(ts));
		},
		ControlCommand::ModelOverride { ts, model, reply } => {
			let _ = reply.send(journal.model_override(ts, model));
		},
		ControlCommand::WorkspaceRoots { reply } => {
			let result = journal.load().and_then(|view| {
				let primary = view.log().header().cwd.clone();
				drop(view);
				journal.workspace_roots(&primary)
			});
			let _ = reply.send(result);
		},
		ControlCommand::MoveWorkspaceRoot { ts, root, reply } => {
			let _ = reply.send(journal.move_workspace_root(ts, root));
		},
		ControlCommand::SetTitle { ts, title, source, reply } => {
			let _ = reply.send(journal.append_title(ts, title, source));
		},
		ControlCommand::Checkpoint { goal, reply } => {
			let mut state = checkpoint_state.lock();
			if state.active.is_some() {
				let _ = reply.send(Err(ControlError::CheckpointAlreadyActive));
			} else {
				let token = Str::from(omp_core::Ulid::generate().to_string());
				let started_at = r#loop::now_ms();
				match journal.checkpoint(started_at, token.as_str(), goal.as_str(), started_at) {
					Ok(event) => {
						state.active = Some(ActiveCheckpoint {
							opaque_token: token.clone(),
							event,
							goal,
							started_at,
						});
						state.rewind_scheduled = false;
						let _ = reply.send(Ok(CheckpointAck { token, started_at }));
					},
					Err(error) => {
						let _ = reply.send(Err(ControlError::Journal(error)));
					},
				}
			}
		},
		ControlCommand::Journal { request, reply } => {
			let _ = reply.send(journal.handle_request(request));
		},
		ControlCommand::DeclareEntryKinds { extension, declarations, reply } => {
			let _ = reply.send(journal.declare_entry_kinds(extension.as_str(), declarations));
		},
		ControlCommand::Query { queries, reply } => {
			let mut rows = BTreeMap::new();
			let result = queries.into_iter().try_for_each(|query| {
				for row in journal.query_custom(&query)? {
					rows.insert(row.index, row);
				}
				Ok::<_, JournalError>(())
			});
			let _ = reply.send(result.map(|()| rows.into_values().collect()));
		},
		ControlCommand::SessionStateGet { authority, key, reply } => {
			let _ = reply.send(journal.latest_session_state(&authority, key.as_str()));
		},
		ControlCommand::SessionStateCompareExchange {
			ts,
			authority,
			key,
			expected,
			value,
			request,
			reply,
		} => {
			let result =
				journal.compare_exchange_session_state(ts, &authority, key, expected, value, &request);
			let _ = reply.send(result);
		},
		ControlCommand::SessionStateWatch { authority, key, since, reply } => {
			let _ = reply.send(journal.subscribe_session_state(&authority, key, since));
		},
		ControlCommand::SessionStateRootContent { ts, authority, reference, request, reply } => {
			let _ =
				reply.send(journal.root_session_state_content(ts, &authority, reference, &request));
		},
		ControlCommand::SessionStateContentIsRooted { authority, reference, reply } => {
			let namespace = Str::new(authority.namespace());
			let _ = reply.send(journal.session_state_content_is_rooted(
				&authority,
				namespace.as_str(),
				&reference,
			));
		},
		ControlCommand::InvocationTransition { ts, transition, reply } => {
			let _ = reply.send(journal.record_invocation_transition(ts, transition));
		},
		ControlCommand::Rewind { token, report, receipt, ack } => {
			let mut state = checkpoint_state.lock();
			let Some(active) = state.active.clone() else {
				let error = if state.last_completed.is_some() {
					ControlError::CheckpointAlreadyCompleted
				} else {
					ControlError::NoActiveCheckpoint
				};
				let _ = ack.send(Err(error));
				return ControlMailboxEvent::JournalHandled;
			};
			if token != active.opaque_token {
				let _ = ack.send(Err(ControlError::WrongCheckpointToken));
				return ControlMailboxEvent::JournalHandled;
			}
			let report = Str::new(report.trim());
			if report.is_empty() {
				let _ = ack.send(Err(ControlError::EmptyRewindReport));
				return ControlMailboxEvent::JournalHandled;
			}
			if state.rewind_scheduled {
				let _ = ack.send(Err(ControlError::RewindAlreadyScheduled));
				return ControlMailboxEvent::JournalHandled;
			}
			state.rewind_scheduled = true;
			let _ = ack.send(Ok(RewindAck { token: token.clone(), receipt }));
			return ControlMailboxEvent::Rewind(ScheduledRewind {
				token,
				target: active.event,
				report,
				goal: active.goal,
				started_at: active.started_at,
			});
		},
	}
	ControlMailboxEvent::JournalHandled
}
#[cfg(test)]
mod tests {
	use omp_storage::transcript::{Header, SessionId};

	use super::*;

	#[tokio::test]
	async fn workspace_root_commands_run_on_the_journal_owner_and_persist() {
		let temp = tempfile::tempdir().unwrap();
		let primary = temp.path().join("primary");
		let moved = temp.path().join("moved");
		std::fs::create_dir(&primary).unwrap();
		std::fs::create_dir(&moved).unwrap();
		let path = temp.path().join("session.jsonl");
		let mut journal = Journal::create(&path, &Header {
			v:       4,
			id:      SessionId(Str::new_static("workspace-control-test")),
			created: 1,
			cwd:     primary.clone(),
		})
		.unwrap();
		let (sender, mailbox) = channel();

		let requester = async {
			sender.move_workspace_root(2, moved.clone()).await.unwrap();
			sender.workspace_roots().await.unwrap()
		};
		let owner = async {
			assert!(matches!(
				mailbox.handle_next(&mut journal).await,
				ControlMailboxEvent::JournalHandled
			));
			assert!(matches!(
				mailbox.handle_next(&mut journal).await,
				ControlMailboxEvent::JournalHandled
			));
		};
		let (roots, ()) = tokio::join!(requester, owner);
		assert_eq!(roots.primary(), moved);
		assert_eq!(roots.secondary(), &[primary.clone()]);

		drop(journal);
		let reopened = Journal::open(&path).unwrap();
		assert_eq!(reopened.workspace_roots(&primary).unwrap().primary(), moved);
	}
}
