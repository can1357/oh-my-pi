//! Whole-lifetime tool dispatch and central execution policy.
//!
//! A call is *prepared* the moment the provider names it (ADR 0008: the
//! executor consumes argument streaming live), *committed* when its canonical
//! arguments settle, and *driven* by one multiplexed loop that journals every
//! event of every call in a batch. Independent read-only calls run
//! concurrently; a mutating call is exclusive within its batch. Every call
//! settles through exactly one path: a typed terminal, a harness abort, or
//! detachment into the job primitive (ADR 0010) when it outlives the central
//! blocking limit.

use std::{
	future::Future,
	io::Write as _,
	pin::Pin,
	sync::Arc,
	task::{Context, Poll},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use flume::{Receiver, r#async::RecvStream};
use futures::{Stream, StreamExt as _};
use omp_core::{FastHashMap, Hash32, Str, sf};
use omp_dom::{Handle, KnownTag, NodeSpec, Op, PropId, PropKey, Sid, Tag, Txn, Value};
use omp_journal::{
	EntryId,
	blob::{BlobRef, BlobStage, BlobStore},
};
use omp_session::{Session, SessionError};
use omp_tool::{
	Abort, ArtifactLifetime, BlobRef as ToolBlobRef, CallOutcome, CallOutcomeDetails, CapsBase,
	Diag, DiagEnvelope, DiagKind, Effects, ErasedEv, ErasedOutcome, ExpectedArtifact,
	IncomingParams, Interrupt, InvocationFeed, JobKind, JobMetadata, JobOwner, JobRef, ModelClass,
	OutputProjection, OutputRequest, Part, ProjectionSpan, PromptCaps, Registry, RegistryError, Rev,
	Severity, ToolIdentity, ToolRoute, ToolSpec, Unit as ToolUnit, VisibilityReceipt,
	VisibleSourceLine,
};
use serde_json::value::RawValue;
use thiserror::Error;
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

use crate::{
	CancelTree, JobBoard, KernelEvent, SessionAuthority, TurnCancellation, Up,
	cancel::{BackgroundToolCancellation, ForegroundMutationCancellation, ReadOnlyToolCancellation},
	events::KernelEvents,
	steering,
};

/// Cancellation authority selected from a tool's declared effects.
#[derive(Clone, Debug)]
pub enum ToolCancellation {
	/// Session-only cancellation for a foreground mutation.
	Foreground(ForegroundMutationCancellation),
	/// Turn-scoped cancellation for a read-only call.
	ReadOnly(ReadOnlyToolCancellation),
	/// Turn-scoped cancellation for detached or background work.
	Background(BackgroundToolCancellation),
}

impl ToolCancellation {
	/// Host stop request for this call: turn interruption or session
	/// cancellation for every scope.
	fn interrupt_token(&self) -> CancellationToken {
		match self {
			Self::Foreground(scope) => scope.interrupt_token(),
			Self::ReadOnly(scope) => scope.token(),
			Self::Background(scope) => scope.token(),
		}
	}

	/// Whether the call mutates shared state and therefore runs exclusively
	/// within its batch.
	const fn is_exclusive(&self) -> bool {
		matches!(self, Self::Foreground(_))
	}
}

/// Central policy applied once to every tool call.
#[derive(Clone, Debug)]
pub struct DispatchPolicy {
	/// Maximum inline output bytes under the ordinary policy.
	pub max_output_bytes:          usize,
	/// Fixed host-memory and transcript ceiling for a `notrunc` request.
	pub max_complete_output_bytes: usize,
	/// Maximum bytes retained from one output line.
	pub max_line_bytes:            usize,
	/// Maximum bytes retained from the beginning of artifact-spilled output.
	pub artifact_head_bytes:       usize,
	/// Maximum bytes retained from the end of artifact-spilled output.
	pub artifact_tail_bytes:       usize,
	/// Maximum lines retained in each artifact-spilled output head/tail window.
	pub artifact_tail_lines:       usize,
	/// Maximum time a call may block the turn.
	pub blocking_limit:            Duration,
	/// Bounded wait after a stop request before a call that has not settled
	/// is forcibly terminated and journaled as effects-unknown (ADR 0011).
	/// Execution units apply their own courtesy grace inside this bound.
	pub interrupt_grace:           Duration,
	/// Content-addressed store for complete spilled output.
	pub spill:                     BlobStore,
}

impl DispatchPolicy {
	/// Standard inline output bound shared by tool terminals and job
	/// settlements.
	pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 64 * 1024;
	/// Hard ceiling retained inline for an explicit complete-output request.
	pub const MAX_COMPLETE_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

	/// Creates the standard 64 KiB / 8 MiB hard / 512-byte / 30-second /
	/// 1-second policy.
	#[must_use]
	pub const fn new(spill: BlobStore) -> Self {
		Self {
			max_output_bytes: Self::DEFAULT_MAX_OUTPUT_BYTES,
			max_complete_output_bytes: Self::MAX_COMPLETE_OUTPUT_BYTES,
			max_line_bytes: 512,
			artifact_head_bytes: Self::DEFAULT_MAX_OUTPUT_BYTES,
			artifact_tail_bytes: 0,
			artifact_tail_lines: usize::MAX,
			blocking_limit: Duration::from_secs(30),
			interrupt_grace: Duration::from_secs(1),
			spill,
		}
	}

	/// Replaces the bounded settle window granted after a stop request.
	#[must_use]
	pub const fn with_interrupt_grace(mut self, interrupt_grace: Duration) -> Self {
		self.interrupt_grace = interrupt_grace;
		self
	}

	/// Replaces central limits while retaining the selected blob store.
	#[must_use]
	pub const fn with_limits(
		mut self,
		max_output_bytes: usize,
		max_line_bytes: usize,
		blocking_limit: Duration,
	) -> Self {
		self.max_output_bytes = max_output_bytes;
		self.max_line_bytes = max_line_bytes;
		self.artifact_head_bytes = max_output_bytes;
		self.artifact_tail_bytes = 0;
		self.artifact_tail_lines = usize::MAX;
		self.blocking_limit = blocking_limit;
		self
	}

	/// Selects the inline head/tail projection used after complete output is
	/// saved to the artifact store.
	#[must_use]
	pub const fn with_artifact_projection(
		mut self,
		head_bytes: usize,
		tail_bytes: usize,
		tail_lines: usize,
	) -> Self {
		self.artifact_head_bytes = head_bytes;
		self.artifact_tail_bytes = tail_bytes;
		self.artifact_tail_lines = tail_lines;
		self
	}
}

/// Per-call policy choices parsed from model arguments.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DispatchOptions {
	/// Requests complete inline output up to the fixed host security ceiling.
	pub notrunc: bool,
}

impl DispatchOptions {
	/// Reads the caller-owned `notrunc` preference from canonical arguments.
	#[must_use]
	pub fn from_args(args: &RawValue) -> Self {
		let notrunc = serde_json::from_str::<serde_json::Value>(args.get())
			.ok()
			.and_then(|value| value.get("notrunc").and_then(serde_json::Value::as_bool))
			.unwrap_or(false);
		Self { notrunc }
	}

	/// Typed caller request forwarded across environment execution boundaries.
	#[must_use]
	pub const fn output_request(self) -> OutputRequest {
		if self.notrunc {
			OutputRequest::Complete
		} else {
			OutputRequest::Bounded
		}
	}
}

/// One authorized invocation ready for registry dispatch.
pub struct DispatchRequest {
	/// Exact live tool identity recorded on the call element.
	pub identity:     ToolIdentity,
	/// Stable provider call identity.
	pub call_id:      Str,
	/// Journal identity of the corresponding `tool.call@1`.
	pub call:         EntryId,
	/// Canonical committed argument object.
	pub args:         Box<RawValue>,
	/// Central caller choices.
	pub options:      DispatchOptions,
	/// Cancellation scope selected from the tool's effects.
	pub cancellation: ToolCancellation,
}

/// One externally routed invocation with committed canonical arguments.
pub struct ExternalDispatchRequest {
	/// Exact selected tool identity.
	pub identity:       ToolIdentity,
	/// Stable durable session identity owning this call.
	pub session_id:     Str,
	/// Content-addressed store owned by the session currently dispatching the
	/// call. Session switches and relocation therefore cannot leave the
	/// external executor writing into its launch-time namespace.
	pub blobs:          BlobStore,
	/// Stable provider call identity.
	pub call_id:        Str,
	/// Canonical committed argument object.
	pub args:           Box<RawValue>,
	/// Resolved worker or remote execution route.
	pub route:          ToolRoute,
	/// Maximum time the invocation may block this turn.
	pub blocking_limit: Duration,
	/// Caller-selected output projection policy. The environment still enforces
	/// its fixed security ceiling.
	pub output_request: OutputRequest,
	/// Turn/session cancellation the executor must honor (ADR 0011): once
	/// cancelled, the invocation is interrupted and settles aborted.
	pub cancellation:   CancellationToken,
}

/// One state mutation produced by an externally routed tool executor.
pub enum ExternalDispatchEvent {
	/// Ephemeral structured progress.
	Update(Box<RawValue>),
	/// Durable structured outcome and its canonical model-facing projection.
	Done {
		/// Typed `CallOutcome` truth decoded once at the environment boundary.
		outcome:         CallOutcome<serde_json::Value, serde_json::Value>,
		/// Canonical bounded-later model-facing parts.
		parts:           Vec<Part>,
		/// Whether the outcome is model-facing error content.
		is_error:        bool,
		/// Verified environment artifact adopted into the session CAS.
		source_artifact: Option<BlobRef>,
	},
	/// Durable outcome with typed trust-boundary projection facts.
	DoneProjected {
		/// Typed `CallOutcome` truth decoded once at the environment boundary.
		outcome:         CallOutcome<serde_json::Value, serde_json::Value>,
		/// Environment-bounded model-facing parts.
		parts:           Vec<Part>,
		/// Whether the outcome is model-facing error content.
		is_error:        bool,
		/// Verified environment artifact adopted into the session CAS.
		source_artifact: Option<BlobRef>,
		/// Facts for the projection already applied by the environment host.
		projection:      OutputProjection,
	},
	/// Execution stopped without a normal typed verdict.
	Aborted(Abort),
}

/// Owned externally routed tool event stream.
pub type ExternalDispatchStream =
	Pin<Box<dyn Stream<Item = ExternalDispatchEvent> + Send + 'static>>;

/// Host composition seam for worker- and remote-routed tool execution.
pub trait ExternalToolExecutor: Send + Sync {
	/// Opens one committed invocation. Every stream must end in `Done` or
	/// `Aborted`; transport failures are mapped to an explicit abort by the
	/// adapter while their typed source is logged at that boundary.
	fn invoke(&self, request: ExternalDispatchRequest) -> ExternalDispatchStream;
}

/// One boxed cold-call future at the session-tool dynamic quarantine.
///
/// Session-owned tools are rare, spawn-scale operations (`task`, `hub`), so
/// one allocation per call is intentional; ordinary tools retain static
/// dispatch through [`Registry`].
pub type SessionToolFuture<'a> = Pin<
	Box<
		dyn Future<Output = Result<CallOutcome<Box<RawValue>, Box<RawValue>>, SessionToolError>>
			+ Send
			+ 'a,
	>,
>;

/// The kernel's live control surface handed to whoever holds the session
/// while a call runs: the upward mailbox plus the cancellation scopes it
/// steers. Steering received here is journaled on receipt.
#[derive(Clone)]
pub struct CallControl {
	mailbox:   Receiver<Up>,
	turn:      TurnCancellation,
	session:   CancelTree,
	run:       Option<crate::RunControl>,
	approvals: crate::ApprovalDesk,
}

/// What one handled mailbox message meant for the running batch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Received {
	/// Nothing the batch must react to.
	None,
	/// Steering was journaled: not-yet-started calls are skipped and the
	/// batch stops at the next safe point.
	Steering,
	/// The authoritative session rewound and runtime lifecycle must follow.
	Rewound(omp_session::LifecycleWork),
	/// The journal-derived global runtime gate changed.
	PauseChanged,
	/// The turn or session was cancelled.
	Cancelled,
	/// One or more identified tool calls were interrupted without cancelling
	/// unrelated siblings.
	ToolScopedAbort(crate::ToolScopedAbortReason),
	/// A journaled approval prompt was decided; a call waiting on it
	/// starts or settles denied.
	Approved(crate::ApprovalTicket),
}

/// Host policy deciding whether a native call may start from its declared
/// effect tier, the session approval mode, and per-tool overrides.
pub trait ToolAdmission: Send + Sync {
	/// Decides one committed call before its unit starts.
	fn admit(
		&self,
		name: &str,
		effects: &omp_tool::Effects,
		args: &RawValue,
	) -> ToolAdmissionVerdict;
}

/// One admission answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolAdmissionVerdict {
	/// Start the call.
	Allow,
	/// Never start; the call settles as a policy denial.
	Deny(Str),
	/// Journal this prompt and start only once it is approved.
	Prompt(crate::ApprovalSpec),
}

impl CallControl {
	pub(crate) const fn new(
		mailbox: Receiver<Up>,
		turn: TurnCancellation,
		session: CancelTree,
		run: Option<crate::RunControl>,
		approvals: crate::ApprovalDesk,
	) -> Self {
		Self { mailbox, turn, session, run, approvals }
	}

	/// Receives the next mailbox message; pending forever once the kernel is
	/// gone.
	pub async fn recv(&self) -> Up {
		match self.mailbox.recv_async().await {
			Ok(message) => message,
			Err(_) => std::future::pending().await,
		}
	}

	/// Resolves when the caller-owned run control (deadline or external
	/// cancellation) fires; pending forever without one.
	pub async fn run_expired(&self) {
		match &self.run {
			Some(run) => run.cancelled().await,
			None => std::future::pending().await,
		}
	}

	/// Whether the turn was interrupted or the session cancelled.
	#[must_use]
	pub fn is_cancelled(&self) -> bool {
		self.turn.is_turn_cancelled() || self.session.is_session_cancelled()
	}

	/// Interrupts the current turn.
	pub fn cancel_turn(&self) {
		self.turn.cancel_turn();
	}

	/// Applies one mailbox message to the session: steering and notices are
	/// journaled immediately, approvals decided, subscriptions served, and
	/// interrupts routed to the cancellation tree.
	pub fn handle(&self, session: &mut Session, message: Up) -> Result<Received, SessionError> {
		match message {
			Up::Steer { text, attachments } => {
				steering::queue_steering(session, text, &attachments)?;
				Ok(Received::Steering)
			},
			Up::SteerAuthored { text, attachments, author } => {
				steering::queue_authored_steering(session, text, &attachments, author)?;
				Ok(Received::Steering)
			},
			Up::SkillPrompt(prompt) => {
				session.skill_prompt(prompt)?;
				Ok(Received::Steering)
			},
			Up::Peer(text) => {
				steering::queue_peer(session, text)?;
				Ok(Received::None)
			},
			Up::Queue { text, attachments } => {
				steering::queue_prompt(session, text, &attachments)?;
				Ok(Received::None)
			},
			Up::Unqueue(reply) => {
				let _ = reply.send(steering::unqueue_steering(session)?);
				Ok(Received::None)
			},
			Up::Pause { active } => {
				crate::set_paused(session, active)?;
				Ok(Received::PauseChanged)
			},
			Up::AbortTools(reason) => Ok(Received::ToolScopedAbort(reason)),
			Up::Interrupt => {
				self.turn.cancel_turn();
				Ok(Received::Cancelled)
			},
			Up::Cancel => {
				self.session.cancel_session();
				self.turn.cancel_turn();
				Ok(Received::Cancelled)
			},
			Up::SessionMutation(request) => {
				request.apply(session);
				Ok(Received::None)
			},
			Up::Env(event) => {
				Ok(journal_env_event(session, event)?.map_or(Received::None, Received::Rewound))
			},
			Up::Autoreply { payload, committed } => {
				let result = session
					.dom()
					.children(session.dom().body())
					.last()
					.copied()
					.ok_or(SessionError::NoActiveTurn)
					.and_then(|turn| crate::append_irc_traffic(session, turn, &payload));
				let _ = committed.send(result.is_ok());
				result.map(|()| Received::None)
			},
			Up::Approval(request) => {
				if let Err(error) = self.approvals.file(session, request.clone()) {
					tracing::warn!(%error, ticket = %request.ticket.ticket_id, "approval prompt could not be journaled");
					let _ = request.respond(crate::ApprovalDecision {
						approved:   false,
						scope:      crate::ApprovalScope::Once,
						source:     crate::ApprovalSource::Unavailable,
						decided_by: None,
						reason:     Some(Str::new_static("approval prompt could not be journaled")),
						audited:    false,
					});
				}
				Ok(Received::None)
			},
			Up::Approve { id, decision } => {
				match self.approvals.decide(session, id.as_str(), decision) {
					Ok(ticket) => Ok(Received::Approved(ticket)),
					Err(error) => {
						tracing::debug!(%error, ticket = %id, "approval decision targets no live prompt");
						Ok(Received::None)
					},
				}
			},
			Up::Subscribe(reply) => {
				let _ = reply.send(session.subscribe());
				Ok(Received::None)
			},
		}
	}
}

/// Journals an environment observation under the current turn.
pub(crate) fn journal_env_event(
	session: &mut Session,
	event: crate::EnvEvent,
) -> Result<Option<omp_session::LifecycleWork>, SessionError> {
	let Ok(turn) = crate::current_turn(session) else {
		return Ok(None);
	};
	match event {
		crate::EnvEvent::DeviceAvailability { payload } => {
			steering::append_notice(session, turn, payload)?;
			Ok(None)
		},
		crate::EnvEvent::StagedPreview { proposal_id, source_tool } => {
			steering::append_notice(
				session,
				turn,
				sf!(
					"Staged proposal {proposal_id} from {source_tool} awaits `dyn resolve \
					 \"{proposal_id}\" \"<one-sentence reason>\"` or `dyn reject \"{proposal_id}\" \
					 \"<one-sentence reason>\"`."
				),
			)?;
			Ok(None)
		},
		crate::EnvEvent::CheckpointOpened {
			token,
			label,
			goal,
			parent_token,
			started_at,
			workspace,
		} => {
			checkpoint_open(session, token, label, goal, parent_token, started_at, workspace)?;
			Ok(None)
		},
		crate::EnvEvent::CheckpointRewind { token, report, receipt, workspace, rewound_at } => {
			checkpoint_rewind(session, &token, report, receipt, &workspace, rewound_at)
		},
		crate::EnvEvent::IrcTraffic { payload } => {
			crate::append_irc_traffic(session, turn, &payload)?;
			Ok(None)
		},
		crate::EnvEvent::LateDiagnostics(diagnostics) => {
			let Some(diagnostics) = diagnostics.non_empty() else {
				return Ok(None);
			};
			session.patch(Txn {
				cause: session.head().ok_or(SessionError::NoActiveTurn)?,
				label: Some(Str::new_static("diagnostics.late")),
				ops:   vec![Op::Ins {
					parent: turn,
					after:  session.dom().children(turn).last().copied(),
					node:   diagnostics.into_node()?,
				}],
			})?;
			Ok(None)
		},
		crate::EnvEvent::CustomMessage(message) => {
			steering::append_custom_message(session, turn, message)?;
			Ok(None)
		},
		crate::EnvEvent::Notice { kind, name, body } => {
			steering::append_named_notice(session, turn, kind, name, body)?;
			Ok(None)
		},
	}
}

fn checkpoint_open(
	session: &mut Session,
	token: Str,
	label: Str,
	goal: Str,
	parent_token: Option<Str>,
	started_at: u64,
	workspace: omp_proto::env::v1::WorkspaceSnapshot,
) -> Result<(), SessionError> {
	let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
	let mut node = NodeSpec::new(omp_dom::Tag::Custom(Str::new_static("rewind-checkpoint")))
		.with_prop(PropKey::Custom(Str::new_static("token")), Value::Str(token))
		.with_prop(PropId::Label, Value::Str(label))
		.with_prop(
			PropKey::Custom(Str::new_static("target")),
			Value::Str(Str::new(cause.to_string())),
		)
		.with_prop(PropKey::Custom(Str::new_static("goal")), Value::Str(goal))
		.with_prop(
			PropKey::Custom(Str::new_static("started-at")),
			Value::Int(i64::try_from(started_at).unwrap_or(i64::MAX)),
		)
		.with_prop(
			PropKey::Custom(Str::new_static("workspace-snapshot")),
			Value::Str(Str::new(workspace.snapshot_id)),
		)
		.with_prop(
			PropKey::Custom(Str::new_static("workspace-root")),
			Value::Str(Str::new(workspace.root_uri)),
		)
		.with_prop(
			PropKey::Custom(Str::new_static("workspace-generation")),
			Value::Int(i64::try_from(workspace.generation).unwrap_or(i64::MAX)),
		)
		.with_prop(
			PropKey::Custom(Str::new_static("workspace-tree")),
			Value::Str(Str::new(workspace.tree_hash)),
		)
		.with_prop(
			PropKey::Custom(Str::new_static("workspace-files")),
			Value::Int(i64::try_from(workspace.files).unwrap_or(i64::MAX)),
		)
		.with_prop(
			PropKey::Custom(Str::new_static("workspace-bytes")),
			Value::Int(i64::try_from(workspace.bytes).unwrap_or(i64::MAX)),
		)
		.with_prop(
			PropKey::Custom(Str::new_static("workspace-created-at")),
			Value::Int(i64::try_from(workspace.created_ms).unwrap_or(i64::MAX)),
		)
		.with_prop(
			PropKey::Custom(Str::new_static("workspace-partial")),
			Value::Bool(workspace.partial),
		);
	if let Some(parent_token) = parent_token {
		node =
			node.with_prop(PropKey::Custom(Str::new_static("parent-token")), Value::Str(parent_token));
	}
	if let Some(workspace_parent) = workspace.parent_snapshot_id {
		node = node.with_prop(
			PropKey::Custom(Str::new_static("workspace-parent")),
			Value::Str(Str::new(workspace_parent)),
		);
	}
	session.patch(Txn {
		cause,
		label: Some(Str::new_static("checkpoint.open")),
		ops: vec![Op::Ins {
			parent: session.dom().meta(),
			after: session.dom().children(session.dom().meta()).last().copied(),
			node,
		}],
	})?;
	Ok(())
}

fn checkpoint_rewind(
	session: &mut Session,
	token: &str,
	report: Str,
	receipt: Str,
	workspace: &omp_proto::env::v1::WorkspaceRestored,
	rewound_at: u64,
) -> Result<Option<omp_session::LifecycleWork>, SessionError> {
	if workspace.partial || !workspace.conflicts.is_empty() {
		return Ok(None);
	}
	let checkpoint = session.dom().handles().find_map(|handle| {
		let node = session.dom().get(handle)?;
		if node.tag != omp_dom::Tag::Custom(Str::new_static("rewind-checkpoint"))
			|| node
				.prop(&PropKey::Custom(Str::new_static("token")))
				.and_then(Value::as_str)
				!= Some(token)
			|| node
				.prop(&PropKey::Custom(Str::new_static("workspace-snapshot")))
				.and_then(Value::as_str)
				!= Some(workspace.snapshot_id.as_str())
		{
			return None;
		}
		let target = node
			.prop(&PropKey::Custom(Str::new_static("target")))
			.and_then(Value::as_str)?
			.parse::<EntryId>()
			.ok()?;
		let started_at = match node.prop(&PropKey::Custom(Str::new_static("started-at")))? {
			Value::Int(value) => u64::try_from(*value).ok()?,
			_ => return None,
		};
		let label = node
			.prop(&PropKey::from(PropId::Label))
			.and_then(Value::as_str)
			.map(Str::new)?;
		Some((target, started_at, label))
	});
	let Some((target, started_at, label)) = checkpoint else {
		return Ok(None);
	};
	let work = session.rewind(target)?;
	let turn = session
		.dom()
		.children(session.dom().body())
		.last()
		.copied()
		.ok_or(SessionError::NoActiveTurn)?;
	let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
	let report_body = sf!(
		"<system-notice>\nExploration checkpoint rewound.\nReport:\n{}\n</system-notice>",
		report
	);
	let status = sf!(
		"Workspace restored to checkpoint {}: {} written, {} deleted, {} unchanged.",
		label,
		workspace.written,
		workspace.deleted,
		workspace.unchanged
	);
	session.patch(Txn {
		cause,
		label: Some(Str::new_static("checkpoint.rewound")),
		ops: vec![
			Op::Ins {
				parent: turn,
				after:  session.dom().children(turn).last().copied(),
				node:   NodeSpec::new(KnownTag::Developer)
					.with_prop(
						PropKey::Custom(Str::new_static("checkpoint-token")),
						Value::Str(Str::new(token)),
					)
					.with_prop(PropKey::Custom(Str::new_static("checkpoint-label")), Value::Str(label))
					.with_prop(
						PropKey::Custom(Str::new_static("workspace-snapshot")),
						Value::Str(Str::new(&workspace.snapshot_id)),
					)
					.with_prop(
						PropKey::Custom(Str::new_static("workspace-undo-snapshot")),
						Value::Str(Str::new(&workspace.undo_snapshot_id)),
					)
					.with_prop(
						PropKey::Custom(Str::new_static("started-at")),
						Value::Int(i64::try_from(started_at).unwrap_or(i64::MAX)),
					)
					.with_prop(
						PropKey::Custom(Str::new_static("rewound-at")),
						Value::Int(i64::try_from(rewound_at).unwrap_or(i64::MAX)),
					)
					.with_prop(PropKey::Custom(Str::new_static("receipt")), Value::Str(receipt))
					.with_content(report_body),
			},
			Op::Ins {
				parent: turn,
				after:  session.dom().children(turn).last().copied(),
				node:   NodeSpec::new(KnownTag::Notice)
					.with_prop(PropId::Kind, Value::Str(Str::new_static("info")))
					.with_prop(
						PropKey::Custom(Str::new_static("name")),
						Value::Str(Str::new_static("checkpoint")),
					)
					.with_content(status),
			},
		],
	})?;
	Ok(Some(work))
}

/// Runtime context available only to a session-owned tool.
pub struct SessionToolCx<'a> {
	/// Authoritative parent session controller.
	pub session:   &'a mut Session,
	/// Materialized tool-call element.
	pub call:      Handle,
	/// Disposable runtime index over `<meta><jobs>`.
	pub jobs:      &'a JobBoard,
	/// Kill boundary for detached work.
	pub cancel:    BackgroundToolCancellation,
	/// Host-owned routing authority for live peer sessions.
	pub authority: Option<&'a dyn SessionAuthority>,
	/// The kernel's mailbox and cancellation scopes, for tools that wait
	/// (`hub wait`): steering and interrupts are observed while blocked.
	pub control:   Option<&'a CallControl>,
	/// Extension lifecycle gates (`subagent_spawn`); `None` without an
	/// extension host.
	pub hooks:     Option<&'a crate::LifecycleHooks>,
}

/// Failure before a session tool can produce its typed terminal outcome.
#[derive(Debug, Error)]
pub enum SessionToolError {
	/// Session-tool argument or outcome JSON was malformed.
	#[error("session tool JSON is invalid")]
	Json(#[from] serde_json::Error),
	/// Host composition rejected the operation before a typed tool fault.
	#[error("{message}")]
	Rejected {
		/// Stable diagnostic.
		message: Str,
	},
	/// Journaling a job or steering side effect failed.
	#[error(transparent)]
	Session(#[from] SessionError),
	/// A session-owned Director transition failed.
	#[error(transparent)]
	Director(#[from] crate::DirectorError),
}

/// A host-authority tool whose operation requires the session DOM.
///
/// Implementations must journal through `Session`; private durable state is
/// prohibited.
pub trait SessionTool: Send + Sync {
	/// Exact model-facing declaration.
	fn spec(&self) -> &ToolSpec;
	/// Executes one committed call against the authoritative session.
	fn call<'a>(&'a self, cx: SessionToolCx<'a>, args: Box<RawValue>) -> SessionToolFuture<'a>;

	/// Projects the terminal truth into model-visible parts.
	///
	/// Structured session tools default to their typed JSON. Tools whose
	/// contract promises a human-oriented projection (for example `todo`)
	/// override this without changing the journaled outcome.
	fn project(
		&self,
		outcome: &CallOutcome<Box<RawValue>, Box<RawValue>>,
	) -> Result<Vec<Part>, SessionToolError> {
		Ok(match outcome {
			CallOutcome::Ok(payload) | CallOutcome::Faulted(payload) => {
				vec![Part::Json { json: bytes::Bytes::copy_from_slice(payload.get().as_bytes()) }]
			},
			CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. } => Vec::new(),
		})
	}
}

/// Live ordered output of one dispatched call (ADR 0008 tool output
/// streaming), bounded on the host side (ADR 0009).
///
/// A tool update carrying `sequence` and `data` is an ordered output frame
/// (`omp_tools::shell::Update`, eval process frames). The dispatcher binds a
/// DOM text stream to the call's `<result>` text at the first frame, appends
/// each frame's bytes as UTF-8 in sequence order up to the central inline
/// limit, and diverts everything beyond it into a content-addressed spill
/// stage so neither the DOM, the journal, nor an actor's patch queue ever
/// receives more than the policy allows. The typed update still journals the
/// frame's metadata; its bytes live only in the stream or the artifact.
pub(crate) struct OutputStream {
	sid:     Option<Sid>,
	/// Highest sequence appended; stale or duplicate frames are dropped.
	last:    Option<u64>,
	/// Bytes of a UTF-8 sequence split across frames, completed by the next.
	carry:   Vec<u8>,
	/// Inline byte budget. Production paths always set a finite host ceiling.
	limit:   Option<usize>,
	/// Bytes revealed inline so far.
	shown:   usize,
	/// Inline prefix retained until an overflow opens the spill stage, so the
	/// artifact holds the complete output.
	prefix:  String,
	/// Complete-output spill once the inline budget is exhausted.
	stage:   Option<BlobStage>,
	/// Whether any byte was diverted from the DOM.
	spilled: bool,
}

impl OutputStream {
	const fn new(limit: Option<usize>) -> Self {
		Self {
			sid: None,
			last: None,
			carry: Vec::new(),
			limit,
			shown: 0,
			prefix: String::new(),
			stage: None,
			spilled: false,
		}
	}

	/// Reads the frame's ordering and bytes when `value` is an output frame.
	fn frame(value: &serde_json::Value) -> Option<(u64, Vec<u8>)> {
		let sequence = value.get("sequence")?.as_u64()?;
		let bytes = match value.get("data")? {
			serde_json::Value::String(text) => text.as_bytes().to_vec(),
			serde_json::Value::Array(items) => items
				.iter()
				.filter_map(serde_json::Value::as_u64)
				.filter_map(|byte| u8::try_from(byte).ok())
				.collect(),
			_ => return None,
		};
		Some((sequence, bytes))
	}

	/// Decodes a frame's bytes, carrying an incomplete trailing sequence to
	/// the next frame instead of replacing it.
	fn decode(&mut self, bytes: &[u8]) -> String {
		let mut buffer = std::mem::take(&mut self.carry);
		buffer.extend_from_slice(bytes);
		let text = match std::str::from_utf8(&buffer) {
			Ok(text) => text.to_owned(),
			Err(error) if error.error_len().is_none() => {
				let valid = error.valid_up_to();
				let text = String::from_utf8_lossy(&buffer[..valid]).into_owned();
				buffer.drain(..valid);
				self.carry = buffer;
				return text;
			},
			Err(_) => String::from_utf8_lossy(&buffer).into_owned(),
		};
		buffer.clear();
		self.carry = buffer;
		text
	}

	/// Appends one frame in order; returns the update with its bytes
	/// removed so they are not journaled twice.
	fn push(
		&mut self,
		session: &mut Session,
		call: EntryId,
		spill: &BlobStore,
		mut value: serde_json::Value,
		sequence: u64,
		bytes: &[u8],
	) -> Result<Box<RawValue>, DispatchError> {
		if self.last.is_none_or(|last| sequence > last) {
			self.last = Some(sequence);
			let text = self.decode(bytes);
			if !text.is_empty() {
				self.reveal(session, call, spill, &text)?;
			}
		}
		if let Some(data) = value.get_mut("data") {
			*data = match data {
				serde_json::Value::String(_) => serde_json::Value::String(String::new()),
				_ => serde_json::Value::Array(Vec::new()),
			};
		}
		Ok(serde_json::value::to_raw_value(&value)?)
	}

	/// Reveals `text` inline up to the budget and diverts the rest to the
	/// spill stage.
	fn reveal(
		&mut self,
		session: &mut Session,
		call: EntryId,
		spill: &BlobStore,
		text: &str,
	) -> Result<(), DispatchError> {
		let available = self
			.limit
			.map_or(usize::MAX, |limit| limit.saturating_sub(self.shown));
		let visible = utf8_prefix(text, available);
		if !visible.is_empty() {
			let sid = if let Some(sid) = self.sid {
				sid
			} else {
				let sid = session.stream_open(result_handle(session, call)?, PropId::Text.into())?;
				self.sid = Some(sid);
				sid
			};
			session.stream_append(sid, visible)?;
			self.shown += visible.len();
			if self.stage.is_none() {
				self.prefix.push_str(visible);
			}
		}
		let overflow = &text[visible.len()..];
		if overflow.is_empty() {
			return Ok(());
		}
		self.spilled = true;
		let stage = if let Some(stage) = self.stage.as_mut() {
			stage
		} else {
			let mut stage = spill.begin_put()?;
			stage
				.write_all(std::mem::take(&mut self.prefix).as_bytes())
				.map_err(omp_journal::blob::Error::from)?;
			self.stage.insert(stage)
		};
		stage
			.write_all(overflow.as_bytes())
			.map_err(omp_journal::blob::Error::from)?;
		Ok(())
	}

	/// Closes the stream, flushing any dangling partial sequence lossily, and
	/// finalizes the complete-output artifact when bytes were diverted.
	fn close(
		&mut self,
		session: &mut Session,
		call: EntryId,
		spill: &BlobStore,
	) -> Result<Option<BlobRef>, DispatchError> {
		if !self.carry.is_empty() {
			let tail = String::from_utf8_lossy(&self.carry).into_owned();
			self.carry.clear();
			self.reveal(session, call, spill, &tail)?;
		}
		if let Some(sid) = self.sid.take() {
			session.stream_close(sid)?;
		}
		let spilled = self.stage.take().map(BlobStage::finish).transpose()?;
		Ok(spilled)
	}
}

/// The `<result>` element of a live call.
pub(crate) fn result_handle(session: &Session, call: EntryId) -> Result<Handle, DispatchError> {
	let element = session.call_handle(call)?;
	let dom = session.dom();
	dom.children(element)
		.iter()
		.copied()
		.find(|child| {
			dom.get(*child)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Result))
		})
		.ok_or(DispatchError::Session(SessionError::UnknownCall { id: call }))
}

/// Durable result of one dispatched invocation.
#[derive(Clone, Debug)]
pub struct DispatchReport {
	/// Whether the model-facing terminal is an error.
	pub is_error:      bool,
	/// Typed facts for the single model-facing output projection.
	pub projection:    OutputProjection,
	/// Complete-output artifact created by central bounding.
	pub spilled:       Option<BlobRef>,
	/// Number of individual lines clamped.
	pub lines_clamped: u64,
	/// Job reference when execution detached.
	pub detached:      Option<JobRef>,
	/// Wall time from admission to settlement (zero for calls that never
	/// started).
	pub duration:      Duration,
}

/// Registry dispatch, projection, persistence, or journal failure.
#[derive(Debug, Error)]
pub enum DispatchError {
	/// Tool registry operation failed.
	#[error(transparent)]
	Registry(#[from] RegistryError),
	/// Session journal or DOM fold failed.
	#[error(transparent)]
	Session(#[from] SessionError),
	/// Blob persistence failed.
	#[error(transparent)]
	Blob(#[from] omp_journal::blob::Error),
	/// JSON serialization failed.
	#[error(transparent)]
	Json(#[from] serde_json::Error),
	/// Tool event task failed independently of its terminal stream.
	#[error(transparent)]
	Join(#[from] JoinError),
	/// A lifecycle hook rejected or malformed a tool transition.
	#[error(transparent)]
	LifecycleHook(#[from] crate::LifecycleHookError),
	/// Invocation input was dropped before the executor received commitment.
	#[error("tool invocation input channel closed before commitment")]
	InputClosed,
	/// Session-owned tool failed before producing a terminal outcome.
	#[error(transparent)]
	SessionTool(#[from] SessionToolError),
	/// No host executor was injected for an externally routed tool.
	#[error("externally routed tool {name} has no host executor")]
	ExternalExecutorMissing {
		/// Selected tool name.
		name: Str,
	},
	/// A model-facing JSON part contained invalid UTF-8.
	#[error("tool JSON projection is not UTF-8")]
	ProjectionUtf8 {
		/// UTF-8 validation failure.
		#[source]
		source: std::str::Utf8Error,
	},
	/// A prepared call was driven before its arguments were committed.
	#[error("tool call {call_id} was driven before its arguments were committed")]
	Uncommitted {
		/// Stable provider call identity.
		call_id: Str,
	},
	/// The approval prompt a call requires could not be journaled.
	#[error("tool approval prompt could not be journaled")]
	Approval {
		/// Typed prompt failure.
		#[source]
		source: crate::ApprovalError,
	},
}

/// Model-facing reason for a call the host refused.
fn denial_reason(ticket: &crate::ApprovalTicket) -> Str {
	let by = ticket
		.decision
		.as_ref()
		.map_or("policy", |decision| <&'static str>::from(decision.source));
	match ticket
		.decision
		.as_ref()
		.and_then(|decision| decision.reason.as_deref())
	{
		Some(reason) => sf!("tool call denied by {by}: {reason}"),
		None => sf!("tool call denied by {by}"),
	}
}

/// One event from an execution unit, native or external.
pub(crate) enum DispatchEvent {
	Native(Result<ErasedEv, RegistryError>),
	External(ExternalDispatchEvent),
}

/// The journaling half of dispatch: registry projection, central bounding,
/// and terminal commitment. Cloned into detached jobs so they settle through
/// the same code the foreground path uses.
#[derive(Clone)]
pub(crate) struct Committer {
	registry:        Arc<Registry>,
	policy:          DispatchPolicy,
	events:          KernelEvents,
	lifecycle_hooks: Option<crate::LifecycleHooks>,
}

/// Executes registry calls and commits every event through `omp-session`.
#[derive(Clone)]
pub struct Dispatcher {
	committer:     Committer,
	external:      Option<Arc<dyn ExternalToolExecutor>>,
	session_tools: FastHashMap<Str, Arc<dyn SessionTool>>,
	jobs:          Arc<JobBoard>,
	authority:     Option<Arc<dyn SessionAuthority>>,
	admission:     Option<Arc<dyn ToolAdmission>>,
}

/// Where a prepared call executes.
enum Unit {
	/// In-process registry tool fed live argument fragments.
	Native { feed: InvocationFeed },
	/// Worker/remote tool started at commit with complete arguments.
	External {
		executor: Arc<dyn ExternalToolExecutor>,
		route:    ToolRoute,
		event_tx: Option<flume::Sender<DispatchEvent>>,
	},
	/// Host-authority tool run inline against the session.
	Session(Arc<dyn SessionTool>),
	/// Runtime-only view used to settle an already-detached unit.
	Detached { feed: Option<InvocationFeed> },
}

/// Lifecycle of a prepared call within its batch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
	/// Committed and waiting for the scheduler.
	Pending,
	/// Journaled approval prompt open; starts once approved.
	AwaitingApproval,
	/// Executing.
	Running,
	/// Stop requested; the unit has until the grace expires.
	Interrupting,
	/// Journaled a terminal.
	Settled,
}

/// A call whose execution unit is open and consuming argument streaming.
pub struct PreparedCall {
	identity:         ToolIdentity,
	call_id:          Str,
	call:             EntryId,
	cancellation:     ToolCancellation,
	interrupt:        CancellationToken,
	/// Armed once at admission and polled in place by [`Signals`]; the
	/// `Notified` inside is `!Unpin` and the call lives in a movable `Vec`,
	/// so it is pinned on the heap exactly once per running call.
	interrupted:      Option<Pin<Box<WaitForCancellationFutureOwned>>>,
	unit:             Unit,
	events:           Receiver<DispatchEvent>,
	/// Persistent async view of `events`, polled in place by [`Signals`].
	stream:           RecvStream<'static, DispatchEvent>,
	task:             Option<tokio::task::JoinHandle<Result<(), RegistryError>>>,
	args:             Option<Box<RawValue>>,
	options:          DispatchOptions,
	output:           Option<OutputStream>,
	phase:            Phase,
	started:          Option<Instant>,
	grace_until:      Option<Instant>,
	closed:           bool,
	report:           Option<DispatchReport>,
	/// Approval prompt this call waits on while `AwaitingApproval`.
	ticket:           Option<Str>,
	/// Hook requirements merged with native admission before filing.
	approval_specs:   Vec<crate::ApprovalSpec>,
	/// Deadline and default decision for the open durable ticket.
	approval_timeout: Option<(Instant, crate::ApprovalDecision)>,
	/// Call-specific stop label supplied by a scoped abort.
	abort_reason:     Option<Str>,
}

impl PreparedCall {
	/// Journal identity of the `tool.call@1`.
	#[must_use]
	pub const fn entry(&self) -> EntryId {
		self.call
	}

	/// Stable provider call identity.
	#[must_use]
	pub const fn call_id(&self) -> &Str {
		&self.call_id
	}

	/// Exact tool identity.
	#[must_use]
	pub const fn identity(&self) -> &ToolIdentity {
		&self.identity
	}

	/// Whether canonical arguments were committed.
	#[must_use]
	pub const fn is_committed(&self) -> bool {
		self.args.is_some()
	}

	/// Canonical committed arguments, once [`Self::commit`] ran.
	#[must_use]
	pub fn args(&self) -> Option<&RawValue> {
		self.args.as_deref()
	}

	/// Feeds one streamed argument fragment to the executor as it arrives
	/// (ADR 0008: preview work happens once, while arguments stream).
	pub fn arg_delta(&self, fragment: &str) {
		if let Unit::Native { feed } = &self.unit {
			// A closed feed means the unit already ended (e.g. it rejected the
			// call); commitment reports that as the terminal.
			let _ = feed.arg_text(Str::new(fragment));
		}
	}

	/// Records approval requirements returned by the lifecycle gate.
	pub fn require_approvals(&mut self, specs: Vec<crate::ApprovalSpec>) {
		self.approval_specs.extend(specs);
	}

	/// Records the canonical committed arguments. Execution starts when the
	/// batch scheduler admits the call.
	pub fn commit(&mut self, args: Box<RawValue>) {
		self.options = DispatchOptions::from_args(&args);
		self.args = Some(args);
	}

	const fn is_exclusive(&self) -> bool {
		self.cancellation.is_exclusive() || matches!(self.unit, Unit::Session(_))
	}

	fn output(&mut self, policy: &DispatchPolicy) -> &mut OutputStream {
		let limit = if self.options.notrunc {
			policy.max_complete_output_bytes
		} else {
			policy.max_output_bytes
		};
		self
			.output
			.get_or_insert_with(|| OutputStream::new(Some(limit)))
	}

	/// Discards a speculative execution unit before replacing transformed input.
	pub(crate) fn discard(&mut self) {
		if let Some(task) = self.task.take() {
			task.abort();
		}
	}

	/// Whether the call still occupies its scheduling slot: running,
	/// stopping, or waiting on an approval prompt (ordering holds while the
	/// host decides).
	const fn is_live(&self) -> bool {
		matches!(self.phase, Phase::Running | Phase::Interrupting | Phase::AwaitingApproval)
	}
}

impl Dispatcher {
	/// Creates a dispatcher over one runtime registry and central policy.
	#[must_use]
	pub fn new(registry: Arc<Registry>, policy: DispatchPolicy) -> Self {
		let jobs = Arc::new(JobBoard::new());
		jobs.set_output_bound(policy.max_output_bytes);
		jobs.set_artifact_store(policy.spill.clone());
		Self {
			committer: Committer {
				registry,
				policy,
				events: KernelEvents::default(),
				lifecycle_hooks: None,
			},
			external: None,
			session_tools: FastHashMap::default(),
			jobs,
			authority: None,
			admission: None,
		}
	}

	/// Installs the host approval policy consulted before a native call
	/// starts.
	#[must_use]
	pub fn with_tool_admission(mut self, admission: Arc<dyn ToolAdmission>) -> Self {
		self.admission = Some(admission);
		self
	}

	/// Injects the host adapter for worker- and remote-routed tools.
	#[must_use]
	pub fn with_external_executor(mut self, executor: Arc<dyn ExternalToolExecutor>) -> Self {
		self.external = Some(executor);
		self
	}

	/// Registers a session-authority tool before registry route lookup.
	#[must_use]
	pub fn with_session_tool(mut self, tool: Arc<dyn SessionTool>) -> Self {
		self.session_tools.insert(tool.spec().name.clone(), tool);
		self
	}

	/// Uses the supplied runtime job index for session tools and rewind work.
	#[must_use]
	pub fn with_job_board(mut self, jobs: Arc<JobBoard>) -> Self {
		jobs.set_output_bound(self.committer.policy.max_output_bytes);
		jobs.set_artifact_store(self.committer.policy.spill.clone());
		self.jobs = jobs;
		self
	}

	/// Injects the host-owned live-session routing authority.
	#[must_use]
	pub fn with_session_authority(mut self, authority: Arc<dyn SessionAuthority>) -> Self {
		self.authority = Some(authority);
		self
	}

	pub(crate) fn with_events(mut self, events: KernelEvents) -> Self {
		self.committer.events = events;
		self
	}

	pub(crate) fn with_lifecycle_hooks(mut self, hooks: crate::LifecycleHooks) -> Self {
		self.committer.lifecycle_hooks = Some(hooks);
		self
	}

	/// Borrows the runtime registry.
	#[must_use]
	pub const fn registry(&self) -> &Arc<Registry> {
		&self.committer.registry
	}

	/// Replaces the runtime registry between turns.
	///
	/// Composition owners use this for child-only contracts whose advertised
	/// schema depends on the next queued unit of work. Callers must never swap
	/// the registry while a turn has prepared calls.
	pub fn replace_registry(&mut self, registry: Arc<Registry>) {
		self.committer.registry = registry;
	}

	/// Borrows the central dispatch policy.
	#[must_use]
	pub const fn policy(&self) -> &DispatchPolicy {
		&self.committer.policy
	}

	/// Borrows the runtime job index.
	#[must_use]
	pub const fn jobs(&self) -> &Arc<JobBoard> {
		&self.jobs
	}

	/// Opens the execution unit for a call the provider just named. Native
	/// tools start consuming argument fragments immediately; they act only
	/// after [`PreparedCall::commit`] and scheduler admission.
	pub fn prepare(
		&self,
		identity: ToolIdentity,
		call_id: Str,
		call: EntryId,
		cancellation: ToolCancellation,
	) -> Result<PreparedCall, DispatchError> {
		let interrupt = cancellation.interrupt_token();
		let (event_tx, events) = flume::unbounded();
		let stream = events.clone().into_stream();
		let name = identity.name.clone();
		if let Some(tool) = self.session_tools.get(&name).cloned() {
			return Ok(PreparedCall {
				identity,
				call_id,
				call,
				cancellation,
				interrupt,
				interrupted: None,
				unit: Unit::Session(tool),
				events,
				stream,
				task: None,
				args: None,
				options: DispatchOptions::default(),
				output: None,
				phase: Phase::Pending,
				started: None,
				grace_until: None,
				closed: true,
				report: None,
				ticket: None,
				approval_specs: Vec::new(),
				approval_timeout: None,
				abort_reason: None,
			});
		}
		let route = self.committer.registry.route(name.as_str())?;
		let (unit, task) = match route {
			ToolRoute::Native => {
				let (feed, params) = IncomingParams::channel_for(None, Some(call_id.clone()));
				let registry = Arc::clone(&self.committer.registry);
				let task = tokio::spawn(async move {
					let mut stream = registry.invoke(name.as_str(), params)?;
					while let Some(event) = stream.next().await {
						if event_tx.send(DispatchEvent::Native(event)).is_err() {
							break;
						}
					}
					Ok::<_, RegistryError>(())
				});
				(Unit::Native { feed }, Some(task))
			},
			route => {
				let executor = self
					.external
					.clone()
					.ok_or_else(|| DispatchError::ExternalExecutorMissing { name: name.clone() })?;
				(Unit::External { executor, route, event_tx: Some(event_tx) }, None)
			},
		};
		Ok(PreparedCall {
			identity,
			call_id,
			call,
			cancellation,
			interrupt,
			interrupted: None,
			unit,
			events,
			stream,
			task,
			args: None,
			options: DispatchOptions::default(),
			output: None,
			phase: Phase::Pending,
			started: None,
			grace_until: None,
			closed: false,
			report: None,
			ticket: None,
			approval_specs: Vec::new(),
			approval_timeout: None,
			abort_reason: None,
		})
	}

	/// Drives one authorized call to exactly one journaled terminal.
	pub async fn dispatch(
		&self,
		session: &mut Session,
		request: DispatchRequest,
	) -> Result<DispatchReport, DispatchError> {
		let mut call =
			self.prepare(request.identity, request.call_id, request.call, request.cancellation)?;
		call.commit(request.args);
		call.options = request.options;
		let mut reports = self.drive(session, vec![call], None).await?;
		Ok(reports.remove(0))
	}

	/// Settles a prepared call that will never run (the stream that named it
	/// was cancelled or failed) with a harness abort, so the journal never
	/// keeps an unpaired call.
	pub fn abort_prepared(
		&self,
		session: &mut Session,
		mut call: PreparedCall,
		abort: Abort,
	) -> Result<DispatchReport, DispatchError> {
		if let Some(task) = call.task.take() {
			task.abort();
		}
		let mut output = std::mem::take(call.output(&self.committer.policy));
		self
			.committer
			.commit_abort(session, &call, abort, &mut output)
	}

	/// Drives a batch of committed calls to their terminals, journaling every
	/// event through the session as it arrives. Read-only calls run
	/// concurrently; a mutating or session-owned call is exclusive. Steering
	/// journaled meanwhile skips every call that has not started; a call
	/// outliving the blocking limit detaches into the job primitive; a stop
	/// request follows the cooperative → grace →
	/// forced ladder (ADR 0011). Reports are returned in batch order.
	pub async fn drive(
		&self,
		session: &mut Session,
		mut calls: Vec<PreparedCall>,
		control: Option<&CallControl>,
	) -> Result<Vec<DispatchReport>, DispatchError> {
		self.jobs.set_artifact_store(session.blobs().clone());
		for call in &calls {
			if !call.is_committed() {
				return Err(DispatchError::Uncommitted { call_id: call.call_id.clone() });
			}
		}
		let policy = self.committer.policy.clone();
		let mut run_expired = false;
		loop {
			self.admit(session, &mut calls, control).await?;
			if calls.iter().all(|call| call.phase == Phase::Settled) {
				break;
			}
			if let Some(index) = calls
				.iter()
				.position(|call| call.closed && call.task.is_some())
			{
				let task = calls[index].task.take().expect("filtered on presence");
				let joined = task.await;
				let call = &mut calls[index];
				match joined {
					Ok(Ok(())) => {},
					Ok(Err(error)) => return Err(error.into()),
					Err(error) => return Err(error.into()),
				}
				let mut terminal = None;
				while let Ok(event) = call.events.try_recv() {
					if let Some(report) = self.committer.apply_event(session, call, event).await? {
						terminal = Some(report);
						break;
					}
				}
				let report = if let Some(report) = terminal {
					report
				} else {
					let mut output = std::mem::take(call.output(&policy));
					self
						.committer
						.commit_abort(session, call, Abort::MissingOutcome, &mut output)?
				};
				call.phase = Phase::Settled;
				call.report = Some(report);
				self.on_settled(session, &mut calls, control).await?;
				continue;
			}
			let now = Instant::now();
			let deadline = calls
				.iter()
				.filter(|call| call.phase == Phase::Running)
				.filter_map(|call| call.started)
				.map(|started| started + policy.blocking_limit)
				.min();
			let grace = calls
				.iter()
				.filter(|call| call.phase == Phase::Interrupting)
				.filter_map(|call| call.grace_until)
				.min();
			let approval = calls
				.iter()
				.filter(|call| call.phase == Phase::AwaitingApproval)
				.filter_map(|call| {
					call
						.approval_timeout
						.as_ref()
						.map(|(deadline, _)| *deadline)
				})
				.min();
			let wake = [deadline, grace, approval].into_iter().flatten().min();
			let signal = tokio::select! {
				biased;
				() = control_expired(control), if !run_expired => Signal::RunExpired,
				message = control_recv(control) => Signal::Mailbox(message),
				() = sleep_until(wake) => Signal::Wake,
				signal = Signals { calls: &mut calls } => signal,
			};
			match signal {
				Signal::RunExpired => {
					run_expired = true;
					if let Some(control) = control {
						control.cancel_turn();
					}
				},
				Signal::Mailbox(message) => {
					let Some(control) = control else { continue };
					match control.handle(session, message)? {
						Received::Steering => self.skip_pending(session, &mut calls).await?,
						Received::Rewound(work) => {
							control.cancel_turn();
							for call in &calls {
								call.interrupt.cancel();
							}
							self.jobs.apply_lifecycle(session, &work).await;
						},
						Received::ToolScopedAbort(reason) => {
							for call in calls.iter_mut().filter(|call| {
								reason.contains(call.call_id.as_str()) && call.phase != Phase::Settled
							}) {
								call.abort_reason = Some(reason.message_for(call.call_id.as_str()).clone());
								call.interrupt.cancel();
							}
						},
						Received::Approved(ticket) => {
							let approved = ticket
								.decision
								.as_ref()
								.is_some_and(|decision| decision.approved);
							for call in calls.iter_mut().filter(|call| {
								call.phase == Phase::AwaitingApproval
									&& call.ticket.as_deref() == Some(ticket.ticket_id.as_str())
							}) {
								call.interrupted = None;
								call.approval_timeout = None;
								if approved {
									// Re-admitted by the next `admit` pass; the ticket stays
									// recorded so policy is not consulted twice.
									call.phase = Phase::Pending;
								} else {
									let mut output = std::mem::take(call.output(&self.committer.policy));
									let report = self.committer.commit_abort(
										session,
										call,
										Abort::Skipped { reason: denial_reason(&ticket) },
										&mut output,
									)?;
									call.phase = Phase::Settled;
									call.report = Some(report);
								}
							}
						},
						Received::None | Received::PauseChanged | Received::Cancelled => {},
					}
					// A cancellation while a prompt is open withdraws the
					// prompt and settles the never-started call as skipped.
					for call in calls.iter_mut().filter(|call| {
						call.phase == Phase::AwaitingApproval && call.interrupt.is_cancelled()
					}) {
						if let Some(ticket) = call.ticket.take() {
							let _ = crate::ApprovalBook::new().withdraw(session, ticket.as_str());
						}
						call.interrupted = None;
						call.approval_timeout = None;
						let mut output = std::mem::take(call.output(&self.committer.policy));
						let reason = call.abort_reason.take().unwrap_or_else(|| {
							Str::new_static("tool execution cancelled while awaiting approval")
						});
						let report = self.committer.commit_abort(
							session,
							call,
							Abort::Skipped { reason },
							&mut output,
						)?;
						call.phase = Phase::Settled;
						call.report = Some(report);
					}
				},
				Signal::Interrupt(index) => {
					let call = &mut calls[index];
					call.interrupted = None;
					if call.phase == Phase::AwaitingApproval {
						if let Some(ticket) = call.ticket.take() {
							let _ = crate::ApprovalBook::new().withdraw(session, ticket.as_str());
						}
						call.approval_timeout = None;
						let mut output = std::mem::take(call.output(&policy));
						let reason = call.abort_reason.take().unwrap_or_else(|| {
							Str::new_static("tool execution cancelled while awaiting approval")
						});
						let report = self.committer.commit_abort(
							session,
							call,
							Abort::Skipped { reason },
							&mut output,
						)?;
						call.phase = Phase::Settled;
						call.report = Some(report);
						continue;
					}
					call.phase = Phase::Interrupting;
					call.grace_until = Some(Instant::now() + policy.interrupt_grace);
					if let Unit::Native { feed } = &call.unit {
						let _ = feed.interrupt(Interrupt {
							class:  Str::new_static(Interrupt::ESCAPE),
							reason: call
								.abort_reason
								.clone()
								.unwrap_or_else(|| Str::new_static("tool execution cancelled")),
						});
					}
				},
				Signal::Wake => {
					let now = Instant::now();
					for index in 0..calls.len() {
						let call = &mut calls[index];
						if call.phase == Phase::AwaitingApproval
							&& call
								.approval_timeout
								.as_ref()
								.is_some_and(|(deadline, _)| *deadline <= now)
						{
							let (_, decision) = call
								.approval_timeout
								.take()
								.expect("filtered on approval timeout");
							let ticket = if let (Some(control), Some(ticket_id)) =
								(control, call.ticket.as_deref())
							{
								control
									.approvals
									.decide(session, ticket_id, decision)
									.map_err(|source| DispatchError::Approval { source })?
							} else {
								let mut output = std::mem::take(call.output(&policy));
								let report = self.committer.commit_abort(
									session,
									call,
									Abort::Skipped {
										reason: Str::new_static(
											"approval deadline elapsed without a host route",
										),
									},
									&mut output,
								)?;
								call.phase = Phase::Settled;
								call.report = Some(report);
								continue;
							};
							call.interrupted = None;
							if ticket
								.decision
								.as_ref()
								.is_some_and(|decision| decision.approved)
							{
								call.phase = Phase::Pending;
							} else {
								let mut output = std::mem::take(call.output(&policy));
								let report = self.committer.commit_abort(
									session,
									call,
									Abort::Skipped { reason: denial_reason(&ticket) },
									&mut output,
								)?;
								call.phase = Phase::Settled;
								call.report = Some(report);
							}
							continue;
						}
						if call.phase == Phase::Interrupting
							&& call.grace_until.is_some_and(|until| until <= now)
						{
							if let Some(task) = call.task.take() {
								task.abort();
								let _ = task.await;
							}
							let mut output = std::mem::take(call.output(&policy));
							let reason = call.abort_reason.take().unwrap_or_else(|| {
								Str::new_static(
									"tool execution cancelled; the call did not settle within the \
									 interrupt grace and was terminated",
								)
							});
							let report = self.committer.commit_abort(
								session,
								call,
								Abort::EffectsUnknown { reason },
								&mut output,
							)?;
							call.phase = Phase::Settled;
							call.report = Some(report);
						} else if call.phase == Phase::Running
							&& call
								.started
								.is_some_and(|started| started + policy.blocking_limit <= now)
						{
							self.detach(session, call)?;
						}
					}
				},
				Signal::Event(index, Some(event)) => {
					let call = &mut calls[index];
					if let Some(report) = self.committer.apply_event(session, call, event).await? {
						call.phase = Phase::Settled;
						call.report = Some(report);
						if let Some(task) = call.task.take() {
							let _ = task.await;
						}
						self.on_settled(session, &mut calls, control).await?;
					}
				},
				Signal::Event(index, None) => calls[index].closed = true,
			}
			let _ = now;
		}
		Ok(calls
			.into_iter()
			.map(|call| {
				let mut report = call.report.expect("settled calls carry a report");
				report.duration = call
					.started
					.map_or(Duration::ZERO, |started| started.elapsed());
				report
			})
			.collect())
	}

	/// Starts every pending call the exclusivity rule admits.
	async fn admit(
		&self,
		session: &mut Session,
		calls: &mut [PreparedCall],
		control: Option<&CallControl>,
	) -> Result<(), DispatchError> {
		if control.is_some() && crate::pause_state(session.dom()).active {
			return Ok(());
		}
		loop {
			let Some(index) = (0..calls.len()).find(|index| {
				let call = &calls[*index];
				if call.phase != Phase::Pending {
					return false;
				}
				let earlier_live = calls[..*index].iter().any(PreparedCall::is_live);
				let earlier_exclusive_live = calls[..*index]
					.iter()
					.any(|earlier| earlier.is_live() && earlier.is_exclusive());
				let later_live = calls[index + 1..].iter().any(PreparedCall::is_live);
				if call.is_exclusive() {
					!earlier_live && !later_live
				} else {
					!earlier_exclusive_live
				}
			}) else {
				return Ok(());
			};
			let call = &mut calls[index];
			if call.interrupt.is_cancelled() {
				// A stop already requested never starts new work.
				let mut output = std::mem::take(call.output(&self.committer.policy));
				let reason = call
					.abort_reason
					.take()
					.unwrap_or_else(|| Str::new_static("tool execution cancelled before it started"));
				let report = self.committer.commit_abort(
					session,
					call,
					Abort::Skipped { reason },
					&mut output,
				)?;
				call.phase = Phase::Settled;
				call.report = Some(report);
				continue;
			}
			let args = call.args.clone().expect("drive requires committed calls");
			// Hook and native tool-admission requirements are collected before
			// filing, so one invocation can open only one durable prompt.
			if call.ticket.is_none() {
				let mut specs = std::mem::take(&mut call.approval_specs);
				// Worker/remote calls are admitted by their environment;
				// session tools are trusted host code.
				if matches!(call.unit, Unit::Native { .. })
					&& let Some(admission) = &self.admission
				{
					let effects = self
						.committer
						.registry
						.effects(call.identity.name.as_str())
						.cloned()
						.unwrap_or_else(|_| Effects::empty());
					match admission.admit(call.identity.name.as_str(), &effects, &args) {
						ToolAdmissionVerdict::Allow => {},
						ToolAdmissionVerdict::Deny(reason) => {
							let mut output = std::mem::take(call.output(&self.committer.policy));
							let report = self.committer.commit_abort(
								session,
								call,
								Abort::Skipped { reason },
								&mut output,
							)?;
							call.phase = Phase::Settled;
							call.report = Some(report);
							continue;
						},
						ToolAdmissionVerdict::Prompt(spec) => specs.push(spec),
					}
				}
				if !specs.is_empty() {
					let ticket = if let Some(control) = control {
						control
							.approvals
							.file_specs(session, call.call_id.clone(), specs)
							.map_err(|source| DispatchError::Approval { source })?
					} else {
						let book = crate::ApprovalBook::new();
						let ticket = book
							.open_for(
								session,
								Some(call.call_id.clone()),
								specs,
								crate::approvals::epoch_millis(),
							)
							.map_err(|source| DispatchError::Approval { source })?;
						let decision =
							crate::approvals::unreachable_decision(&ticket, "approval host unavailable");
						book
							.decide(session, ticket.ticket_id.as_str(), decision)
							.map_err(|source| DispatchError::Approval { source })?
					};
					if ticket.state == crate::TicketState::Decided {
						// A session-wide grant in the tree decided every
						// requirement at once.
						if !ticket
							.decision
							.as_ref()
							.is_some_and(|decision| decision.approved)
						{
							let mut output = std::mem::take(call.output(&self.committer.policy));
							let report = self.committer.commit_abort(
								session,
								call,
								Abort::Skipped { reason: denial_reason(&ticket) },
								&mut output,
							)?;
							call.phase = Phase::Settled;
							call.report = Some(report);
							continue;
						}
					} else {
						call.approval_timeout = ticket
							.reasons
							.iter()
							.map(|reason| reason.timeout_ms)
							.filter(|timeout| *timeout != 0)
							.min()
							.map(|timeout| {
								(
									Instant::now() + Duration::from_millis(timeout),
									crate::approvals::timeout_decision(&ticket),
								)
							});
						call.ticket = Some(ticket.ticket_id);
						call.interrupted = Some(Box::pin(call.interrupt.clone().cancelled_owned()));
						call.phase = Phase::AwaitingApproval;
						continue;
					}
				}
			}
			// Journal the execution boundary before releasing committed
			// arguments or spawning the host unit. A cancellation observed
			// above remains a never-started placeholder on replay.
			session.call_started(call.call)?;
			call.started = Some(Instant::now());
			match &mut call.unit {
				Unit::Native { feed } => {
					feed
						.args_committed(Str::new(args.get()))
						.map_err(|_| DispatchError::InputClosed)?;
					call.interrupted = Some(Box::pin(call.interrupt.clone().cancelled_owned()));
					call.phase = Phase::Running;
				},
				Unit::External { executor, route, event_tx } => {
					let executor = Arc::clone(executor);
					let request = ExternalDispatchRequest {
						identity: call.identity.clone(),
						session_id: {
							let digest =
								Hash32::sum(session.journal_path().as_os_str().as_encoded_bytes()).to_hex();
							Str::new(digest.as_str())
						},
						blobs: session.blobs().clone(),
						call_id: call.call_id.clone(),
						args,
						route: route.clone(),
						blocking_limit: self.committer.policy.blocking_limit,
						output_request: call.options.output_request(),
						cancellation: call.interrupt.clone(),
					};
					let event_tx = event_tx.take().expect("external unit starts once");
					call.task = Some(tokio::spawn(async move {
						let mut stream = executor.invoke(request);
						while let Some(event) = stream.next().await {
							if event_tx.send(DispatchEvent::External(event)).is_err() {
								break;
							}
						}
						Ok(())
					}));
					call.interrupted = Some(Box::pin(call.interrupt.clone().cancelled_owned()));
					call.phase = Phase::Running;
				},
				Unit::Session(tool) => {
					let tool = Arc::clone(tool);
					call.phase = Phase::Running;
					let report = self
						.run_session_tool(session, call, &tool, args, control)
						.await?;
					call.phase = Phase::Settled;
					call.report = Some(report);
				},
				Unit::Detached { .. } => unreachable!("detached units are never scheduler inputs"),
			}
		}
	}

	/// Runs a session-owned tool inline under the ADR 0011 ladder: a stop
	/// request is followed by the interrupt grace, after which the future is
	/// dropped and the call journaled as effects-unknown.
	async fn run_session_tool(
		&self,
		session: &mut Session,
		call: &mut PreparedCall,
		tool: &Arc<dyn SessionTool>,
		args: Box<RawValue>,
		control: Option<&CallControl>,
	) -> Result<DispatchReport, DispatchError> {
		self.jobs.rebuild(session);
		let handle = session.call_handle(call.call)?;
		let interrupt = call.interrupt.clone();
		let grace = self.committer.policy.interrupt_grace;
		let outcome = {
			let future = tool.call(
				SessionToolCx {
					session,
					call: handle,
					jobs: &self.jobs,
					cancel: BackgroundToolCancellation::from_token(interrupt.clone()),
					authority: self.authority.as_deref(),
					control,
					hooks: self.committer.lifecycle_hooks.as_ref(),
				},
				args,
			);
			tokio::pin!(future);
			tokio::select! {
				biased;
				outcome = &mut future => Some(outcome),
				() = interrupt.cancelled() => {
					tokio::select! {
						biased;
						outcome = &mut future => Some(outcome),
						() = tokio::time::sleep(grace) => None,
					}
				},
			}
		};
		let mut output = std::mem::take(call.output(&self.committer.policy));
		let outcome = match outcome {
			Some(outcome) => outcome?,
			None => {
				return self.committer.commit_abort(
					session,
					call,
					Abort::EffectsUnknown {
						reason: Str::new_static(
							"tool execution cancelled; the session tool did not settle within the \
							 interrupt grace and was terminated",
						),
					},
					&mut output,
				);
			},
		};
		let is_error = matches!(
			outcome,
			CallOutcome::Faulted(_) | CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }
		);
		let parts = tool.project(&outcome)?;
		let outcome = serde_json::value::to_raw_value(&outcome)?;
		let staged = self.committer.stage_external(
			session,
			call,
			outcome,
			parts,
			&[],
			is_error,
			&mut output,
		)?;
		let staged = self
			.committer
			.gate_result(session, call, staged, &mut output)
			.await?;
		self
			.committer
			.commit_staged(session, call, staged, &mut output)
	}

	/// After a settlement, applies the steering-stop rule: when steering is
	/// waiting for the safe point, every call that has not started is skipped
	/// so the user's redirection is served before further side effects.
	async fn on_settled(
		&self,
		session: &mut Session,
		calls: &mut [PreparedCall],
		control: Option<&CallControl>,
	) -> Result<(), DispatchError> {
		if control.is_some() && steering::steering_pending(session) {
			self.skip_pending(session, calls).await?;
		}
		Ok(())
	}

	async fn skip_pending(
		&self,
		session: &mut Session,
		calls: &mut [PreparedCall],
	) -> Result<(), DispatchError> {
		for call in calls.iter_mut() {
			if call.phase != Phase::Pending {
				continue;
			}
			if let Some(task) = call.task.take() {
				task.abort();
			}
			let mut output = std::mem::take(call.output(&self.committer.policy));
			let report = self.committer.commit_abort(
				session,
				call,
				Abort::Skipped {
					reason: Str::new_static(
						"pending steering message. Do not count this skipped result as completed work \
						 or verification. After the queued message is handled on the next step, retry \
						 the skipped tool if it is still needed",
					),
				},
				&mut output,
			)?;
			call.phase = Phase::Settled;
			call.report = Some(report);
		}
		Ok(())
	}

	/// Moves a call that outlived the blocking limit into the job primitive:
	/// the call settles for the model with a job reference, and its live
	/// execution unit (event receiver, task, kill boundary) is retained by the
	/// [`JobBoard`] so `hub jobs/wait/logs/cancel` address it and its eventual
	/// terminal is journaled onto the same element.
	fn detach(&self, session: &mut Session, call: &mut PreparedCall) -> Result<(), DispatchError> {
		let job = timeout_job(&call.identity);
		let outcome = detached_outcome(&job)?;
		let prompt = vec![Part::Text { text: sf!("detached job {}", job.id) }];
		let mut output = std::mem::take(call.output(&self.committer.policy));
		// The stream keeps flowing into the element after detachment; the
		// terminal below closes nothing that is still open.
		let output_sid = output.sid.take();
		self.committer.commit_terminal(
			session,
			call,
			outcome,
			prompt,
			false,
			false,
			None,
			&mut output,
		)?;
		output.sid = output_sid;
		let detached = crate::jobs::DetachedCall {
			committer: self.committer.clone(),
			identity: call.identity.clone(),
			call_id: call.call_id.clone(),
			call: call.call,
			options: call.options,
			events: call.events.clone(),
			task: call.task.take(),
			feed: match &call.unit {
				Unit::Native { feed } => Some(feed.clone()),
				Unit::External { .. } | Unit::Session(_) | Unit::Detached { .. } => None,
			},
			output,
			closed: call.closed,
		};
		self
			.jobs
			.adopt_tool_job(session, &job.id, call.interrupt.clone(), detached);
		call.phase = Phase::Settled;
		call.report = Some(DispatchReport {
			is_error:      false,
			projection:    OutputProjection {
				request:      call.options.output_request(),
				source_bytes: 0,
				inline_bytes: 0,
				omitted:      false,
				artifact:     None,
			},
			spilled:       None,
			lines_clamped: 0,
			detached:      Some(job),
			duration:      Duration::ZERO,
		});
		Ok(())
	}
}

impl Default for OutputStream {
	fn default() -> Self {
		Self::new(Some(DispatchPolicy::MAX_COMPLETE_OUTPUT_BYTES))
	}
}

/// One wake reason of the batch loop.
enum Signal {
	RunExpired,
	Mailbox(Up),
	Interrupt(usize),
	Wake,
	Event(usize, Option<DispatchEvent>),
}

/// The batch's per-call wake sources, polled in place: a stop request on a
/// running call (earliest in batch order wins) or the next event of any live
/// call. Nothing is allocated per poll; each call's stream and armed interrupt
/// future persist across loop iterations and register their wakers once.
struct Signals<'a> {
	calls: &'a mut [PreparedCall],
}

impl Future for Signals<'_> {
	type Output = Signal;

	fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
		for (index, call) in self.calls.iter_mut().enumerate() {
			if matches!(call.phase, Phase::Running | Phase::AwaitingApproval)
				&& let Some(interrupted) = call.interrupted.as_mut()
				&& interrupted.as_mut().poll(cx).is_ready()
			{
				return Poll::Ready(Signal::Interrupt(index));
			}
		}
		for (index, call) in self.calls.iter_mut().enumerate() {
			if !call.is_live() || call.closed {
				continue;
			}
			if let Poll::Ready(event) = Pin::new(&mut call.stream).poll_next(cx) {
				return Poll::Ready(Signal::Event(index, event));
			}
		}
		Poll::Pending
	}
}

async fn control_expired(control: Option<&CallControl>) {
	match control {
		Some(control) => control.run_expired().await,
		None => std::future::pending().await,
	}
}

async fn control_recv(control: Option<&CallControl>) -> Up {
	match control {
		Some(control) => control.recv().await,
		None => std::future::pending().await,
	}
}

async fn sleep_until(at: Option<Instant>) {
	match at {
		Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
		None => std::future::pending().await,
	}
}

impl crate::jobs::DetachedCall {
	pub(crate) fn poll(
		&mut self,
		session: &mut Session,
	) -> Result<Option<DispatchReport>, DispatchError> {
		let (_, empty_events) = flume::unbounded();
		let stub = PreparedCall {
			identity:         self.identity.clone(),
			call_id:          self.call_id.clone(),
			call:             self.call,
			cancellation:     ToolCancellation::Background(BackgroundToolCancellation::from_token(
				CancellationToken::new(),
			)),
			interrupt:        CancellationToken::new(),
			interrupted:      None,
			unit:             Unit::Detached { feed: self.feed.clone() },
			stream:           empty_events.clone().into_stream(),
			events:           empty_events,
			task:             None,
			args:             None,
			options:          self.options,
			output:           None,
			phase:            Phase::Running,
			started:          None,
			grace_until:      None,
			closed:           false,
			report:           None,
			ticket:           None,
			approval_specs:   Vec::new(),
			approval_timeout: None,
			abort_reason:     None,
		};
		while let Ok(event) = self.events.try_recv() {
			// A detached settlement lands from the job board's synchronous
			// poll; its `tool_result` gate ran when the call detached, and the
			// background terminal commits as-is.
			if let Some(settled) =
				self
					.committer
					.apply_event_with(session, &stub, event, &mut self.output)?
			{
				self.task.take();
				let report = match settled {
					Settled::Report(report) => report,
					Settled::Staged(staged) => {
						self
							.committer
							.commit_staged(session, &stub, staged, &mut self.output)?
					},
				};
				return Ok(Some(report));
			}
		}
		self.closed |= self.events.is_disconnected();
		if self.closed || self.task.as_ref().is_some_and(JoinHandle::is_finished) {
			self.task.take();
			let report =
				self
					.committer
					.commit_abort(session, &stub, Abort::MissingOutcome, &mut self.output)?;
			return Ok(Some(report));
		}
		Ok(None)
	}
}

impl Committer {
	/// Journals one execution-unit event; returns the report when it was the
	/// terminal. A completed terminal passes the `tool_result` extension gate
	/// (annotate, spill, replace) before it is journaled.
	pub(crate) async fn apply_event(
		&self,
		session: &mut Session,
		call: &mut PreparedCall,
		event: DispatchEvent,
	) -> Result<Option<DispatchReport>, DispatchError> {
		let mut output = std::mem::take(call.output(&self.policy));
		let result = match self.apply_event_with(session, call, event, &mut output) {
			Ok(Some(Settled::Report(report))) => Ok(Some(report)),
			Ok(Some(Settled::Staged(staged))) => {
				match self.gate_result(session, call, staged, &mut output).await {
					Ok(staged) => self
						.commit_staged(session, call, staged, &mut output)
						.map(Some),
					Err(error) => Err(error),
				}
			},
			Ok(None) => Ok(None),
			Err(error) => Err(error),
		};
		call.output = Some(output);
		result
	}

	/// Runs the `tool_result` gate over a staged terminal. Hooks may annotate,
	/// force a spill, or replace the payload/fault. The gate fails open: a
	/// denial or a
	/// malformed transform keeps the tool's own terminal.
	async fn gate_result(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		mut staged: StagedTerminal,
		output: &mut OutputStream,
	) -> Result<StagedTerminal, DispatchError> {
		let Some(hooks) = &self.lifecycle_hooks else {
			return Ok(staged);
		};
		if !hooks
			.hook_gate()
			.subscribed(omp_proto::toolhost::v1::HookEventId::HookEventToolResult)
		{
			return Ok(staged);
		}
		let outcome: serde_json::Value = serde_json::from_str(staged.outcome.get())?;
		let kind = outcome_kind(&outcome);
		let payload = serde_json::json!({
			"call_id": call.call_id,
			"target": call_target(call),
			"outcome": kind,
			"payload": (kind == "ok").then(|| outcome.clone()),
			"fault": (kind == "faulted").then(|| outcome.clone()),
			"abort": (kind == "aborted").then(|| outcome.clone()),
			"artifact": staged.spilled.as_ref().map(artifact_address),
			"useless": false,
			"annotate": [],
			"spill": serde_json::Value::Null,
		});
		let transformed = match hooks
			.gate(omp_proto::toolhost::v1::HookEventId::HookEventToolResult, payload.clone())
			.await
		{
			Ok(value) => value,
			Err(error) => {
				tracing::warn!(?error, call_id = %call.call_id, "tool_result hook failed; keeping the tool terminal");
				hooks.notify(omp_proto::toolhost::v1::HookEventId::HookEventToolResult, payload)?;
				return Ok(staged);
			},
		};
		// Observers see the effective outcome after every transform.
		hooks
			.notify(omp_proto::toolhost::v1::HookEventId::HookEventToolResult, transformed.clone())?;
		if let Some(annotations) = transformed
			.get("annotate")
			.and_then(serde_json::Value::as_array)
		{
			for annotation in annotations {
				let diag = Diag {
					kind: annotation
						.get("kind")
						.and_then(serde_json::Value::as_str)
						.map_or_else(|| Str::new_static("annotation"), Str::new),
					severity: Severity::Info,
					text: annotation
						.get("text")
						.and_then(serde_json::Value::as_str)
						.map_or_else(|| Str::new_static(""), Str::new),
					..Diag::default()
				};
				let mut raw = serde_json::to_value(diag)?
					.as_object()
					.cloned()
					.expect("Diag serializes as an object");
				raw.insert(
					"data".to_owned(),
					annotation
						.get("data")
						.cloned()
						.unwrap_or(serde_json::Value::Null),
				);
				raw.insert(
					"display".to_owned(),
					annotation
						.get("display")
						.cloned()
						.unwrap_or(serde_json::Value::Bool(true)),
				);
				let envelope = DiagEnvelope { diag: serde_json::Value::Object(raw) };
				self.commit_update(
					session,
					call,
					serde_json::value::to_raw_value(&envelope)?,
					output,
				)?;
			}
		}
		let replacement = match kind {
			"ok" => transformed.get("payload"),
			"faulted" => transformed.get("fault"),
			"aborted" => transformed.get("abort"),
			_ => None,
		}
		.filter(|value| !value.is_null() && **value != outcome);
		if let Some(value) = replacement {
			staged.outcome = serde_json::value::to_raw_value(value)?;
		}
		staged.force_spill |= transformed
			.get("spill")
			.and_then(serde_json::Value::as_bool)
			== Some(true);
		Ok(staged)
	}

	fn apply_event_with(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		event: DispatchEvent,
		output: &mut OutputStream,
	) -> Result<Option<Settled>, DispatchError> {
		match event {
			DispatchEvent::Native(Ok(ErasedEv::Update(update))) => {
				let update =
					RawValue::from_string(String::from_utf8(update.to_vec()).map_err(|source| {
						serde_json::Error::io(std::io::Error::new(
							std::io::ErrorKind::InvalidData,
							source,
						))
					})?)?;
				self.commit_update(session, call, update, output)?;
				Ok(None)
			},
			DispatchEvent::Native(Ok(ErasedEv::Done(outcome))) => {
				self.commit_finalized_args(session, call, output)?;
				Ok(Some(self.finish(session, call, outcome, output)?))
			},
			DispatchEvent::Native(Err(error)) => Err(error.into()),
			DispatchEvent::External(ExternalDispatchEvent::Update(update)) => {
				self.commit_update(session, call, update, output)?;
				Ok(None)
			},
			DispatchEvent::External(ExternalDispatchEvent::Done {
				outcome,
				parts,
				is_error,
				source_artifact,
			}) => {
				let outcome = serde_json::value::to_raw_value(&outcome)?;
				Ok(Some(Settled::Staged(self.stage_external_from_artifact(
					session,
					call,
					outcome,
					parts,
					is_error,
					source_artifact,
					None,
					output,
				)?)))
			},
			DispatchEvent::External(ExternalDispatchEvent::DoneProjected {
				outcome,
				parts,
				is_error,
				source_artifact,
				projection,
			}) => {
				let outcome = serde_json::value::to_raw_value(&outcome)?;
				Ok(Some(Settled::Staged(self.stage_external_from_artifact(
					session,
					call,
					outcome,
					parts,
					is_error,
					source_artifact,
					Some(projection),
					output,
				)?)))
			},
			DispatchEvent::External(ExternalDispatchEvent::Aborted(abort)) => {
				// External cancellation tokens cannot carry a reason. Preserve
				// the scoped label selected by the controller when the unit
				// reports a cooperative interruption; owner-reported
				// effects-unknown/skipped detail remains authoritative.
				let abort = match (abort, &call.abort_reason) {
					(Abort::Interrupted { .. }, Some(reason)) => {
						Abort::Interrupted { reason: reason.clone() }
					},
					(abort, _) => abort,
				};
				Ok(Some(Settled::Report(self.commit_abort(session, call, abort, output)?)))
			},
		}
	}

	fn commit_finalized_args(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		output: &mut OutputStream,
	) -> Result<(), DispatchError> {
		let feed = match &call.unit {
			Unit::Native { feed } => feed,
			Unit::Detached { feed: Some(feed) } => feed,
			Unit::External { .. } | Unit::Session(_) | Unit::Detached { feed: None } => return Ok(()),
		};
		let Some(finalized) = feed.take_finalized_args() else {
			return Ok(());
		};
		if finalized.repairs().is_empty() {
			return Ok(());
		}
		let update = serde_json::value::to_raw_value(&serde_json::json!({
			"kernel": "arguments_finalized",
			"repairs": finalized.repairs(),
		}))?;
		self.commit_update(session, call, update, output)
	}

	fn finish(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		outcome: ErasedOutcome,
		output: &mut OutputStream,
	) -> Result<Settled, DispatchError> {
		match outcome {
			ErasedOutcome::Detached(job) => {
				let raw = detached_outcome(&job)?;
				self.commit_terminal(
					session,
					call,
					raw,
					vec![Part::Text { text: sf!("detached job {}", job.id) }],
					false,
					false,
					None,
					output,
				)?;
				Ok(Settled::Report(DispatchReport {
					is_error:      false,
					projection:    OutputProjection {
						request:      call.options.output_request(),
						source_bytes: 0,
						inline_bytes: 0,
						omitted:      false,
						artifact:     None,
					},
					spilled:       None,
					lines_clamped: 0,
					detached:      Some(job),
					duration:      Duration::ZERO,
				}))
			},
			ErasedOutcome::Done { verdict, useless } => {
				let caps = PromptCaps::for_tool(
					CapsBase {
						maximum_parts:      u16::MAX,
						maximum_text_bytes: u32::MAX,
						media:              true,
						model_class:        ModelClass::Standard,
					},
					&call.identity.rev,
				);
				let projected =
					self
						.registry
						.project_verdict(&call.identity, &verdict, useless, &caps)?;
				let raw =
					RawValue::from_string(String::from_utf8(verdict.to_vec()).map_err(|source| {
						serde_json::Error::io(std::io::Error::new(
							std::io::ErrorKind::InvalidData,
							source,
						))
					})?)?;
				Ok(Settled::Staged(self.stage_external(
					session,
					call,
					raw,
					projected.parts.to_vec(),
					&projected.visibility,
					projected.is_error,
					output,
				)?))
			},
		}
	}

	/// Bounds a completed terminal and journals its truncation diagnostic
	/// without committing the outcome, so the `tool_result` gate can still
	/// annotate or replace it.
	fn stage_external(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		outcome: Box<RawValue>,
		parts: Vec<Part>,
		visibility: &[ProjectionSpan],
		is_error: bool,
		output: &mut OutputStream,
	) -> Result<StagedTerminal, DispatchError> {
		self.stage_external_inner(
			session, call, outcome, parts, visibility, is_error, None, None, output,
		)
	}

	fn stage_external_from_artifact(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		outcome: Box<RawValue>,
		parts: Vec<Part>,
		is_error: bool,
		source_artifact: Option<BlobRef>,
		transport_projection: Option<OutputProjection>,
		output: &mut OutputStream,
	) -> Result<StagedTerminal, DispatchError> {
		self.stage_external_inner(
			session,
			call,
			outcome,
			parts,
			&[],
			is_error,
			source_artifact,
			transport_projection,
			output,
		)
	}

	fn stage_external_inner(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		outcome: Box<RawValue>,
		parts: Vec<Part>,
		visibility: &[ProjectionSpan],
		is_error: bool,
		source_artifact: Option<BlobRef>,
		transport_projection: Option<OutputProjection>,
		output: &mut OutputStream,
	) -> Result<StagedTerminal, DispatchError> {
		let transport_spill = (call.identity.name == "bash")
			.then(|| transport_output_spill(outcome.get()))
			.flatten()
			.or_else(|| {
				transport_projection
					.as_ref()
					.is_some_and(|projection| projection.omitted)
					.then_some(source_artifact)
					.flatten()
			});
		let spill = session.blobs().clone();
		let bounded =
			bound_parts(&parts, visibility, call.options, &self.policy, &spill, transport_spill)?;
		let stream_inline_bytes = u64::try_from(output.shown).unwrap_or(u64::MAX);
		let stream_spill = output.close(session, call.call, &spill)?;
		let stream_was_spilled = stream_spill.is_some();
		let spilled = bounded.spilled.or(stream_spill);
		let transport_source_bytes = transport_projection
			.as_ref()
			.map_or(0, |projection| projection.source_bytes);
		let source_bytes =
			spilled
				.as_ref()
				.map_or(bounded.source_bytes.max(transport_source_bytes), |artifact| {
					artifact
						.size
						.max(bounded.source_bytes)
						.max(transport_source_bytes)
				});
		let projection = OutputProjection {
			request: call.options.output_request(),
			source_bytes,
			inline_bytes: bounded.inline_bytes.max(stream_inline_bytes),
			omitted: bounded.omitted
				|| stream_was_spilled
				|| transport_projection
					.as_ref()
					.is_some_and(|projection| projection.omitted),
			artifact: transport_projection
				.as_ref()
				.filter(|projection| projection.omitted)
				.and_then(|projection| projection.artifact.clone())
				.or_else(|| spilled.as_ref().map(projection_blob)),
		};
		if let Some(artifact) = &spilled {
			let address = artifact_address(artifact);
			let diag =
				Diag::info(DiagKind::OutputBounded, "output exceeded inline limits").artifact(address);
			let diag = if bounded.lines_clamped == 0 {
				diag
			} else {
				diag.omitted(bounded.lines_clamped, ToolUnit::Lines)
			};
			self.commit_update(
				session,
				call,
				serde_json::value::to_raw_value(&DiagEnvelope { diag })?,
				output,
			)?;
		}
		let visibility_verdict =
			(!visibility.is_empty()).then(|| bytes::Bytes::copy_from_slice(outcome.get().as_bytes()));
		Ok(StagedTerminal {
			outcome,
			parts: bounded.parts,
			is_error,
			projection,
			spilled,
			lines_clamped: bounded.lines_clamped,
			visibility: bounded.visibility,
			visibility_verdict,
			force_spill: source_artifact.is_some(),
			source_artifact,
		})
	}

	/// Journals a staged terminal.
	fn commit_staged(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		staged: StagedTerminal,
		output: &mut OutputStream,
	) -> Result<DispatchReport, DispatchError> {
		let StagedTerminal {
			outcome,
			parts,
			is_error,
			projection,
			spilled,
			lines_clamped,
			visibility,
			visibility_verdict,
			force_spill,
			source_artifact,
		} = staged;
		self.commit_terminal(
			session,
			call,
			outcome,
			parts,
			is_error,
			force_spill,
			source_artifact,
			output,
		)?;
		if let Some(verdict) = &visibility_verdict {
			self
				.registry
				.authorize_visibility(&call.identity, verdict, &visibility)?;
		}
		Ok(DispatchReport {
			is_error,
			projection,
			spilled,
			lines_clamped,
			detached: None,
			duration: Duration::ZERO,
		})
	}

	fn finish_external(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		outcome: Box<RawValue>,
		parts: Vec<Part>,
		is_error: bool,
		output: &mut OutputStream,
	) -> Result<DispatchReport, DispatchError> {
		let staged = self.stage_external(session, call, outcome, parts, &[], is_error, output)?;
		self.commit_staged(session, call, staged, output)
	}

	pub(crate) fn commit_abort(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		abort: Abort,
		output: &mut OutputStream,
	) -> Result<DispatchReport, DispatchError> {
		// An abort is harness-owned: its projection never depends on the tool
		// or its route, so external units settle exactly like native ones.
		let parts = vec![Part::Text { text: abort.render() }];
		let outcome = serde_json::value::to_raw_value(&CallOutcome::<
			serde_json::Value,
			serde_json::Value,
		>::aborted(abort))?;
		self.finish_external(session, call, outcome, parts, true, output)
	}

	fn commit_update(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		update: Box<RawValue>,
		output: &mut OutputStream,
	) -> Result<(), DispatchError> {
		let value: serde_json::Value = serde_json::from_str(update.get())?;
		if let Some(hooks) = &self.lifecycle_hooks {
			let target = serde_json::json!({
				"kind": "core",
				"name": call.identity.name,
				"rev": format!("{}@{}", call.identity.rev.family, call.identity.rev.n),
				"args": {},
			});
			hooks.notify(
				omp_proto::toolhost::v1::HookEventId::HookEventToolUpdate,
				serde_json::json!({
					"call_id": call.call_id,
					"target": target,
					"update": value,
					"coalesced": 1,
				}),
			)?;
		}
		let update = match OutputStream::frame(&value) {
			Some((sequence, bytes)) => {
				let spill = session.blobs().clone();
				output.push(session, call.call, &spill, value, sequence, &bytes)?
			},
			None => update,
		};
		session.call_update(call.call, update)?;
		self
			.events
			.publish(KernelEvent::ToolUpdate { call_id: call.call_id.clone() });
		Ok(())
	}

	fn commit_terminal(
		&self,
		session: &mut Session,
		call: &PreparedCall,
		outcome: Box<RawValue>,
		parts: Vec<Part>,
		is_error: bool,
		force_spill: bool,
		source_artifact: Option<BlobRef>,
		output: &mut OutputStream,
	) -> Result<(), DispatchError> {
		let spill = session.blobs().clone();
		output.close(session, call.call, &spill)?;
		// The raw outcome is published on the element and travels in every
		// snapshot and patch: bound it under the same policy as the prompt
		// projection so an actor never receives an unbounded payload (ADR
		// 0009). `notrunc` selects the larger fixed security ceiling; it never
		// disables host memory bounds. A `tool_result` hook may demand the spill
		// regardless.
		let inline_limit = if call.options.notrunc {
			self.policy.max_complete_output_bytes
		} else {
			self.policy.max_output_bytes
		};
		let inline = !force_spill && outcome.get().len() <= inline_limit;
		let outcome = if inline {
			outcome
		} else {
			let outcome_bytes = outcome.get().as_bytes();
			let artifact = match source_artifact {
				Some(artifact)
					if artifact.size == u64::try_from(outcome_bytes.len()).unwrap_or(u64::MAX)
						&& artifact.hash == Hash32::sum(outcome_bytes) =>
				{
					artifact
				},
				_ => session.blobs().put(outcome_bytes)?,
			};
			serde_json::value::to_raw_value(&CallOutcomeDetails::Spilled {
				blob:     ToolBlobRef {
					hash:       Str::new(artifact.to_hex()),
					media_type: Str::new_static("application/json"),
					byte_len:   u64::try_from(outcome.get().len()).unwrap_or(u64::MAX),
				},
				byte_len: u64::try_from(outcome.get().len()).unwrap_or(u64::MAX),
			})?
		};
		let parts = serde_json::value::to_raw_value(&parts)?;
		match (is_error, source_artifact) {
			(true, Some(source_artifact)) => {
				session.fail_projected_from_blob(call.call, outcome, parts, source_artifact)?;
			},
			(false, Some(source_artifact)) => {
				session.settle_projected_from_blob(call.call, outcome, parts, source_artifact)?;
			},
			(true, None) => {
				session.fail_projected(call.call, outcome, parts)?;
			},
			(false, None) => {
				session.settle_projected(call.call, outcome, parts)?;
			},
		}
		self
			.events
			.publish(KernelEvent::ToolSettled { call_id: call.call_id.clone(), is_error });
		Ok(())
	}
}

/// A completed terminal bounded and diagnosed but not yet journaled.
pub(crate) struct StagedTerminal {
	outcome:            Box<RawValue>,
	parts:              Vec<Part>,
	is_error:           bool,
	projection:         OutputProjection,
	spilled:            Option<BlobRef>,
	lines_clamped:      u64,
	visibility:         VisibilityReceipt,
	visibility_verdict: Option<bytes::Bytes>,
	force_spill:        bool,
	source_artifact:    Option<BlobRef>,
}

/// What one execution-unit event settled into.
pub(crate) enum Settled {
	/// A harness-owned terminal (abort, detachment) already journaled.
	Report(DispatchReport),
	/// A tool-produced terminal awaiting the `tool_result` gate.
	Staged(StagedTerminal),
}

/// The `CallOutcome` arm name of a serialized outcome.
fn outcome_kind(outcome: &serde_json::Value) -> &'static str {
	match outcome.get("kind").and_then(serde_json::Value::as_str) {
		Some("faulted") => "faulted",
		Some("args_rejected") => "args_rejected",
		Some("aborted") => "aborted",
		_ => "ok",
	}
}

/// The `CallTarget` hook payload for one prepared call.
pub(crate) fn call_target(call: &PreparedCall) -> serde_json::Value {
	serde_json::json!({
		"kind": "core",
		"name": call.identity.name,
		"rev": format!("{}@{}", call.identity.rev.family, call.identity.rev.n),
		"args": call
			.args
			.as_deref()
			.and_then(|args| serde_json::from_str::<serde_json::Value>(args.get()).ok())
			.unwrap_or_else(|| serde_json::json!({})),
	})
}

fn detached_outcome(job: &JobRef) -> Result<Box<RawValue>, serde_json::Error> {
	serde_json::value::to_raw_value(&serde_json::json!({
		"kind": "detached",
		"id": job.id,
		"job": job,
	}))
}

fn timeout_job(identity: &ToolIdentity) -> JobRef {
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis() as u64;
	let id = Str::new(omp_core::Ulid::generate().to_string());
	JobRef {
		id,
		owner: JobOwner::AgentLoop { agent_id: Str::new_static("kernel") },
		metadata: Arc::new(JobMetadata::running(JobKind::Shell, identity.name.clone(), now)),
		artifact: ExpectedArtifact {
			description: sf!("detached {} output", identity.name),
			media_type:  Some(Str::new_static("application/json")),
			lifetime:    ArtifactLifetime::Session,
		},
	}
}

struct BoundedParts {
	parts:         Vec<Part>,
	spilled:       Option<BlobRef>,
	source_bytes:  u64,
	inline_bytes:  u64,
	omitted:       bool,
	lines_clamped: u64,
	visibility:    VisibilityReceipt,
}

fn bound_parts(
	parts: &[Part],
	visibility: &[ProjectionSpan],
	options: DispatchOptions,
	policy: &DispatchPolicy,
	spill: &BlobStore,
	transport_spill: Option<BlobRef>,
) -> Result<BoundedParts, DispatchError> {
	let inline_limit = if options.notrunc {
		policy.max_complete_output_bytes
	} else {
		policy.max_output_bytes
	};
	let source_bytes = parts.iter().fold(0_usize, |total, part| {
		total.saturating_add(match part {
			Part::Text { text } => text.len(),
			Part::Json { json } => json.len(),
			Part::Blob { alt, .. } => alt.as_ref().map_or(0, Str::len),
		})
	});
	if options.notrunc && source_bytes <= inline_limit {
		let parts = parts.to_vec();
		let inline_bytes = u64::try_from(source_bytes).unwrap_or(u64::MAX);
		let source_bytes = transport_spill
			.as_ref()
			.map_or(inline_bytes, |artifact| artifact.size.max(inline_bytes));
		return Ok(BoundedParts {
			parts,
			spilled: transport_spill,
			source_bytes,
			inline_bytes,
			omitted: transport_spill.is_some(),
			lines_clamped: 0,
			visibility: visibility_receipt(visibility.iter()),
		});
	}
	let text_limit = inline_limit;
	let line_limit = if options.notrunc {
		usize::MAX
	} else {
		policy.max_line_bytes
	};
	let mut output = Vec::with_capacity(parts.len());
	let mut full = String::new();
	let mut projected = String::new();
	let mut shown_bytes = 0;
	let mut lines_clamped = 0;
	let mut changed = false;
	let mut byte_truncated = false;
	let mut visible_spans = Vec::new();
	for (part_index, part) in parts.iter().enumerate() {
		match part {
			Part::Text { text } => {
				full.push_str(text.as_str());
				let bounded = clamp_text(text.as_str(), line_limit);
				projected.push_str(&bounded.text);
				lines_clamped += bounded.lines_clamped;
				changed |= bounded.lines_clamped != 0;
				let available = text_limit.saturating_sub(shown_bytes);
				let visible = utf8_prefix(&bounded.text, available);
				shown_bytes += visible.len();
				byte_truncated |= visible.len() != bounded.text.len();
				changed |= visible.len() != bounded.text.len();
				visible_spans.extend(visibility.iter().filter(|span| {
					span.part == part_index
						&& bounded.source_range_visible(span.start_byte, span.end_byte, visible.len())
				}));
				output.push(Part::Text { text: Str::new(visible) });
			},
			Part::Json { json } => {
				let text = std::str::from_utf8(json)
					.map_err(|source| DispatchError::ProjectionUtf8 { source })?;
				full.push_str(text);
				let bounded = clamp_text(text, line_limit);
				projected.push_str(&bounded.text);
				lines_clamped += bounded.lines_clamped;
				changed |= bounded.lines_clamped != 0;
				let available = text_limit.saturating_sub(shown_bytes);
				let visible = utf8_prefix(&bounded.text, available);
				shown_bytes += visible.len();
				byte_truncated |= visible.len() != bounded.text.len();
				changed |= visible.len() != bounded.text.len();
				visible_spans.extend(visibility.iter().filter(|span| {
					span.part == part_index
						&& bounded.source_range_visible(span.start_byte, span.end_byte, visible.len())
				}));
				output.push(Part::Text { text: Str::new(visible) });
			},
			Part::Blob { blob, alt } => {
				if let Some(alt) = alt {
					full.push_str(alt.as_str());
				}
				output.push(Part::Blob { blob: blob.clone(), alt: alt.clone() });
			},
		}
	}
	if byte_truncated && !options.notrunc && policy.artifact_tail_bytes != 0 {
		let tail_bytes = policy.artifact_tail_bytes.min(text_limit);
		let head_bytes = policy
			.artifact_head_bytes
			.min(text_limit.saturating_sub(tail_bytes));
		let text =
			artifact_projection(&projected, head_bytes, tail_bytes, policy.artifact_tail_lines);
		shown_bytes = text.len();
		output.retain(|part| matches!(part, Part::Blob { .. }));
		output.push(Part::Text { text: Str::new(text) });
		// Head/tail elision can expose complete source lines at both ends. A
		// later projection-aware implementation may retain those receipts;
		// conservatively authorizing none is safe today.
		visible_spans.clear();
	}
	let spilled = match transport_spill {
		Some(artifact) => Some(artifact),
		None if changed => Some(spill.put(full.as_bytes())?),
		None => None,
	};
	let source_bytes = u64::try_from(source_bytes).unwrap_or(u64::MAX);
	let source_bytes = transport_spill
		.as_ref()
		.map_or(source_bytes, |artifact| artifact.size.max(source_bytes));
	Ok(BoundedParts {
		parts: output,
		spilled,
		source_bytes,
		inline_bytes: u64::try_from(shown_bytes).unwrap_or(u64::MAX),
		omitted: changed || transport_spill.is_some(),
		lines_clamped,
		visibility: visibility_receipt(visible_spans),
	})
}

/// Builds the model-visible head/tail view of output that has already been
/// preserved in the artifact store.
fn artifact_projection(
	text: &str,
	head_bytes: usize,
	tail_bytes: usize,
	max_lines: usize,
) -> String {
	let head_line_end = if max_lines == usize::MAX {
		text.len()
	} else {
		text
			.match_indices('\n')
			.nth(max_lines.saturating_sub(1))
			.map_or(text.len(), |(index, _)| index + 1)
	};
	let head = utf8_prefix(text, head_bytes.min(head_line_end));

	let mut tail_line_start = 0;
	if max_lines != usize::MAX {
		let mut remaining = max_lines.max(1);
		for (index, _) in text.match_indices('\n').rev() {
			if index + 1 == text.len() {
				continue;
			}
			if remaining == 1 {
				tail_line_start = index + 1;
				break;
			}
			remaining -= 1;
		}
	}
	let mut tail_byte_start = text.len().saturating_sub(tail_bytes);
	while !text.is_char_boundary(tail_byte_start) {
		tail_byte_start += 1;
	}
	let tail_start = tail_byte_start.max(tail_line_start);
	if head.len() >= tail_start {
		return text.to_owned();
	}

	let tail = &text[tail_start..];
	let mut output = String::with_capacity(head.len().saturating_add(tail.len()).saturating_add(5));
	if !head.is_empty() {
		output.push_str(head);
		if !head.ends_with('\n') {
			output.push('\n');
		}
	}
	output.push('…');
	if !tail.is_empty() {
		output.push('\n');
		output.push_str(tail);
	}
	output
}

fn visibility_receipt<'a>(
	spans: impl IntoIterator<Item = &'a ProjectionSpan>,
) -> VisibilityReceipt {
	let mut lines = spans
		.into_iter()
		.map(|span| VisibleSourceLine { source_key: span.source_key.clone(), line: span.line })
		.collect::<Vec<_>>();
	lines.sort_unstable();
	lines.dedup();
	VisibilityReceipt { lines }
}

/// Recovers the environment transport's authoritative full-output artifact
/// from a typed `bash` outcome. Callers must gate this helper by tool identity
/// so an extension payload cannot spoof transport metadata.
fn transport_output_spill(outcome: &str) -> Option<BlobRef> {
	fn find(value: &serde_json::Value) -> Option<&serde_json::Value> {
		match value {
			serde_json::Value::Object(object) => object
				.get("spilled_output")
				.filter(|value| !value.is_null())
				.or_else(|| object.values().find_map(find)),
			serde_json::Value::Array(values) => values.iter().find_map(find),
			_ => None,
		}
	}

	let value = serde_json::from_str::<serde_json::Value>(outcome).ok()?;
	let wire = serde_json::from_value::<ToolBlobRef>(find(&value)?.clone()).ok()?;
	BlobRef::parse_hex(wire.hash.as_str(), wire.byte_len).ok()
}

#[derive(Clone, Copy, Debug)]
struct SourceSegment {
	source_start: usize,
	output_start: usize,
	len:          usize,
}

struct ClampedText {
	text:          String,
	segments:      Vec<SourceSegment>,
	lines_clamped: u64,
}

impl ClampedText {
	fn source_range_visible(
		&self,
		start_byte: usize,
		end_byte: usize,
		visible_output_bytes: usize,
	) -> bool {
		if start_byte >= end_byte {
			return false;
		}
		let mut covered = start_byte;
		for segment in &self.segments {
			if segment.output_start >= visible_output_bytes {
				break;
			}
			let retained = segment
				.len
				.min(visible_output_bytes.saturating_sub(segment.output_start));
			let segment_start = segment.source_start;
			let segment_end = segment_start.saturating_add(retained);
			if segment_end <= covered || segment_start > covered {
				continue;
			}
			covered = segment_end;
			if covered >= end_byte {
				return true;
			}
		}
		false
	}
}

fn clamp_text(text: &str, maximum: usize) -> ClampedText {
	let mut output = String::with_capacity(text.len().min(maximum.saturating_mul(2)));
	let mut segments = Vec::<SourceSegment>::new();
	let mut line_bytes: usize = 0;
	let mut eliding = false;
	let mut lines_clamped = 0;
	for (source_start, character) in text.char_indices() {
		if character == '\n' {
			push_source_character(&mut output, &mut segments, source_start, character);
			line_bytes = 0;
			eliding = false;
			continue;
		}
		if eliding {
			continue;
		}
		if line_bytes.saturating_add(character.len_utf8()) > maximum {
			output.push('…');
			eliding = true;
			lines_clamped += 1;
			continue;
		}
		push_source_character(&mut output, &mut segments, source_start, character);
		line_bytes += character.len_utf8();
	}
	ClampedText { text: output, segments, lines_clamped }
}

fn push_source_character(
	output: &mut String,
	segments: &mut Vec<SourceSegment>,
	source_start: usize,
	character: char,
) {
	let output_start = output.len();
	output.push(character);
	let len = character.len_utf8();
	if let Some(last) = segments.last_mut()
		&& last.source_start.saturating_add(last.len) == source_start
		&& last.output_start.saturating_add(last.len) == output_start
	{
		last.len = last.len.saturating_add(len);
	} else {
		segments.push(SourceSegment { source_start, output_start, len });
	}
}

/// The longest prefix of `text` within `maximum` bytes that ends on a char
/// boundary.
pub(crate) fn utf8_prefix(text: &str, maximum: usize) -> &str {
	if text.len() <= maximum {
		return text;
	}
	let mut end = maximum;
	while !text.is_char_boundary(end) {
		end -= 1;
	}
	&text[..end]
}

#[cfg(test)]
mod checkpoint_tests {
	use omp_core::sf;
	use omp_dom::{KnownTag, PropKey, Tag, Value};
	use omp_proto::env::v1::{WorkspaceRestored, WorkspaceSnapshot};
	use omp_session::{ComponentRegistry, Session};

	use super::journal_env_event;

	fn snapshot(id: &str) -> WorkspaceSnapshot {
		WorkspaceSnapshot {
			snapshot_id: id.to_owned(),
			root_uri: "file:///workspace".to_owned(),
			generation: 7,
			tree_hash: "tree".to_owned(),
			files: 2,
			bytes: 12,
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		}
	}

	fn restored(id: &str) -> WorkspaceRestored {
		WorkspaceRestored {
			snapshot_id: id.to_owned(),
			undo_snapshot_id: "undo".to_owned(),
			from_generation: 8,
			to_generation: 9,
			written: 1,
			deleted: 1,
			unchanged: 0,
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		}
	}

	#[test]
	fn checkpoint_control_rewinds_to_the_journaled_workspace_and_retains_report() {
		let temp = tempfile::tempdir().expect("tempdir");
		let path = temp.path().join("checkpoint.oms");
		let mut session = Session::create(&path, ComponentRegistry::standard()).expect("session");
		session.begin_turn().expect("turn");
		session.user("before", Vec::new()).expect("before");
		journal_env_event(&mut session, crate::EnvEvent::CheckpointOpened {
			token:        sf!("checkpoint-1"),
			label:        sf!("parser-baseline"),
			goal:         sf!("inspect"),
			parent_token: None,
			started_at:   42,
			workspace:    snapshot("snapshot-1"),
		})
		.expect("checkpoint");
		let checkpoint = session
			.dom()
			.select("rewind-checkpoint")
			.expect("selector")
			.next()
			.expect("checkpoint element");
		assert_eq!(
			session
				.dom()
				.get(checkpoint)
				.and_then(|node| node.prop(&PropKey::Custom(sf!("workspace-snapshot"))))
				.and_then(Value::as_str),
			Some("snapshot-1")
		);
		journal_env_event(&mut session, crate::EnvEvent::CheckpointOpened {
			token:        sf!("checkpoint-2"),
			label:        sf!("parser-nested"),
			goal:         sf!("inspect nested branch"),
			parent_token: Some(sf!("checkpoint-1")),
			started_at:   43,
			workspace:    snapshot("snapshot-2"),
		})
		.expect("nested checkpoint");
		let nested = session
			.dom()
			.select("rewind-checkpoint[label=parser-nested]")
			.expect("selector")
			.next()
			.and_then(|handle| session.dom().get(handle))
			.expect("nested checkpoint element");
		assert_eq!(
			nested
				.prop(&PropKey::Custom(sf!("parent-token")))
				.and_then(Value::as_str),
			Some("checkpoint-1")
		);
		let jobs = session
			.dom()
			.handles()
			.find(|handle| {
				session
					.dom()
					.get(*handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Jobs))
			})
			.expect("canonical jobs component");
		session
			.patch(omp_dom::Txn {
				cause: session.head().expect("head"),
				label: Some(sf!("test.job")),
				ops:   vec![omp_dom::Op::Ins {
					parent: jobs,
					after:  session.dom().children(jobs).last().copied(),
					node:   omp_dom::NodeSpec::new(KnownTag::Job)
						.with_prop(omp_dom::PropId::Id, Value::Str(sf!("job-after-checkpoint")))
						.with_prop(omp_dom::PropId::Status, Value::Str(sf!("running"))),
				}],
			})
			.expect("running job");

		session.user("after", Vec::new()).expect("after");
		let work = journal_env_event(&mut session, crate::EnvEvent::CheckpointRewind {
			token:      sf!("checkpoint-1"),
			report:     sf!("kept finding"),
			receipt:    sf!("rewind-1"),
			workspace:  restored("snapshot-1"),
			rewound_at: 84,
		})
		.expect("schedule")
		.expect("rewind work");
		assert_eq!(work.terminate.len(), 1);
		let texts = session
			.dom()
			.select("body turn user")
			.expect("selector")
			.filter_map(|handle| session.dom().get(handle)?.content.as_deref())
			.collect::<Vec<_>>();
		assert_eq!(texts, ["before"]);
		assert_eq!(session.dom().count("rewind-checkpoint").expect("selector"), 0);
		let report = session
			.dom()
			.select("body turn developer")
			.expect("selector")
			.filter_map(|handle| session.dom().get(handle)?.content.as_deref())
			.next()
			.expect("retained report");
		assert!(report.contains("kept finding"));
		let status = session
			.dom()
			.select("body turn notice")
			.expect("selector")
			.filter_map(|handle| session.dom().get(handle)?.content.as_deref())
			.next()
			.expect("restoration status");
		assert!(status.contains("parser-baseline: 1 written, 1 deleted, 0 unchanged"));

		let live = session.dom().snapshot();
		drop(session);
		let replayed = Session::open(path, ComponentRegistry::standard()).expect("replay");
		assert_eq!(replayed.dom().snapshot(), live);
	}

	#[test]
	fn mismatched_workspace_snapshot_never_selects_the_branch() {
		let temp = tempfile::tempdir().expect("tempdir");
		let mut session =
			Session::create(temp.path().join("checkpoint.oms"), ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn");
		session.user("before", Vec::new()).expect("before");
		journal_env_event(&mut session, crate::EnvEvent::CheckpointOpened {
			token:        sf!("checkpoint-1"),
			label:        sf!("parser-baseline"),
			goal:         sf!("inspect"),
			parent_token: None,
			started_at:   42,
			workspace:    snapshot("snapshot-1"),
		})
		.expect("checkpoint");
		session.user("after", Vec::new()).expect("after");
		assert!(
			journal_env_event(&mut session, crate::EnvEvent::CheckpointRewind {
				token:      sf!("checkpoint-1"),
				report:     sf!("wrong workspace"),
				receipt:    sf!("rewind-1"),
				workspace:  restored("snapshot-from-another-project"),
				rewound_at: 84,
			})
			.expect("mismatch is ignored")
			.is_none()
		);
		assert_eq!(session.dom().count("body turn user").expect("selector"), 2);
	}

	#[test]
	fn late_diagnostics_event_materializes_typed_files_and_replays() {
		use omp_session::late_diagnostics::{LateDiagnostics, LateDiagnosticsFile};

		let temp = tempfile::tempdir().expect("tempdir");
		let path = temp.path().join("late-diagnostics.oms");
		let mut session = Session::create(&path, ComponentRegistry::standard()).expect("session");
		session.begin_turn().expect("turn");
		let expected = LateDiagnostics {
			files: vec![LateDiagnosticsFile {
				path:     sf!("src/lib.rs"),
				summary:  sf!("1 error(s)"),
				errored:  true,
				messages: vec![sf!("src/lib.rs:2:1 [error] [rustc] mismatched types (E0308)")],
			}],
		};
		journal_env_event(&mut session, crate::EnvEvent::LateDiagnostics(expected.clone()))
			.expect("late diagnostics journal");
		let notice = session
			.dom()
			.select("body turn developer[kind=diagnostics]")
			.expect("selector")
			.next()
			.and_then(|handle| session.dom().get(handle))
			.expect("typed diagnostics notice");
		assert_eq!(notice.tag, Tag::Known(KnownTag::Developer));
		assert_eq!(
			notice
				.prop(&PropKey::from(omp_dom::PropId::Kind))
				.and_then(Value::as_str),
			Some("diagnostics")
		);
		assert_eq!(LateDiagnostics::from_node(notice), Some(expected));

		let live = session.dom().snapshot();
		drop(session);
		let replayed = Session::open(path, ComponentRegistry::standard()).expect("replay");
		assert_eq!(replayed.dom().snapshot(), live);
	}
}

fn projection_blob(blob: &BlobRef) -> ToolBlobRef {
	ToolBlobRef {
		hash:       Str::new(blob.to_hex()),
		media_type: Str::new_static("application/octet-stream"),
		byte_len:   blob.size,
	}
}

pub(crate) fn artifact_address(blob: &BlobRef) -> Str {
	sf!("artifact://sha256/{}", blob.to_hex())
}

/// Converts a semantic revision into the journal's numeric revision field.
#[must_use]
pub fn journal_revision(rev: &Rev) -> u32 {
	u32::from(rev.n)
}
