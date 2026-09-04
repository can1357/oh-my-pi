//! Named durable workspace/session checkpoints and safe-boundary rewind.

use std::sync::Arc;

use async_stream::stream;
use futures::Stream;
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, DocEffects, Effects, Ev, IncomingParams,
	ParamError, Part, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// Environment bridge to the active Agent Journal and its boundary command
/// queue. Rewind must enqueue, never mutate the journal inline.
pub trait CheckpointControl: Clone + Send + Sync + 'static {
	/// Captures one durable workspace/session checkpoint.
	fn create_checkpoint(
		&self,
		goal: Str,
		label: Str,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<CheckpointAck, CheckpointFault>> + Send;

	/// Lists the selected branch's durable checkpoints, newest first.
	fn list_checkpoints(
		&self,
		limit: u16,
	) -> impl Future<Output = Result<Vec<Arc<CheckpointInfo>>, CheckpointFault>> + Send;

	/// Restores the selected workspace capture and schedules session rewind
	/// only after the document authority reports a complete commit.
	fn schedule_rewind(
		&self,
		checkpoint: Str,
		report: Str,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<RewindAck, CheckpointFault>> + Send;
}

/// Typed workspace generation captured with an exploration checkpoint.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceSnapshot {
	/// Content-addressed manifest identity.
	pub snapshot_id:        Str,
	/// Canonical environment-owned root URI.
	pub root_uri:           Str,
	/// Monotonic workspace generation.
	pub generation:         u64,
	/// Stable tree digest.
	pub tree_hash:          Str,
	/// Captured regular-file count.
	pub files:              u64,
	/// Captured content bytes.
	pub bytes:              u64,
	/// Environment snapshot label.
	pub label:              Option<Str>,
	/// Immediate workspace-snapshot ancestor.
	pub parent_snapshot_id: Option<Str>,
	/// Capture time in epoch milliseconds.
	pub created_at:         u64,
	/// Whether only selected paths were captured.
	pub partial:            bool,
}

/// Typed workspace restoration committed before the journal branches.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceRestore {
	/// Restored checkpoint manifest.
	pub snapshot_id:      Str,
	/// Pre-restore generation retained for recovery.
	pub undo_snapshot_id: Str,
	/// Files created or replaced through document transactions.
	pub written:          u64,
	/// Files deleted through document transactions.
	pub deleted:          u64,
	/// Files already equal to the checkpoint.
	pub unchanged:        u64,
	/// Generation observed before restoration.
	pub from_generation:  u64,
	/// Generation committed after restoration.
	pub to_generation:    u64,
}

/// One durable checkpoint on the selected session branch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointInfo {
	/// Opaque session-owned checkpoint token.
	pub token:          Str,
	/// Human-readable unique branch label.
	pub label:          Str,
	/// Exploration goal.
	pub goal:           Str,
	/// Checkpoint creation time in epoch milliseconds.
	pub started_at:     u64,
	/// Immediate checkpoint ancestor on the selected branch.
	pub parent_token:   Option<Str>,
	/// Journal entry selected when rewinding, when already materialized.
	pub session_target: Option<Str>,
	/// Environment-owned workspace generation paired with the journal point.
	pub workspace:      WorkspaceSnapshot,
}

/// Authoritative checkpoint activation acknowledgement.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointAck {
	/// Durable checkpoint accepted by the active session.
	pub checkpoint: Arc<CheckpointInfo>,
}

/// Stable checkpoint-domain failure returned by the active agent.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointFault {
	/// Machine-readable failure class.
	pub code:    FaultCode,
	/// Stable user-facing guidance.
	pub message: Str,
}

/// Authoritative enqueue acknowledgement.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RewindAck {
	/// Checkpoint selected for rewind.
	pub checkpoint: Arc<CheckpointInfo>,
	/// Agent-issued durable command or receipt identifier.
	pub receipt:    Str,
	/// Fully committed workspace restoration.
	pub workspace:  WorkspaceRestore,
}

/// Checkpoint operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointAction {
	/// Captures a named workspace/session checkpoint.
	Create,
	/// Lists durable checkpoints on the selected branch.
	List,
}

/// Checkpoint operation arguments for `checkpoint@3`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointParams {
	/// Operation to perform.
	pub action: CheckpointAction,
	/// Goal of the speculative exploration branch; required for `create`.
	pub goal:   Option<Str>,
	/// Human-readable unique label used by `rewind`; required for `create`.
	pub label:  Option<Str>,
	/// Maximum list rows, from 1 through 100.
	#[serde(default = "default_list_limit")]
	#[schemars(range(min = 1, max = 100))]
	pub limit:  u16,
}

/// Default checkpoint listing bound.
const fn default_list_limit() -> u16 {
	20
}

/// Rewind scheduling arguments for `rewind@4`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RewindParams {
	/// Exact checkpoint token or unique label to select.
	pub checkpoint: Str,
	/// Findings retained after the selected exploration branch is discarded.
	pub report:     Str,
}

/// Checkpoint result kind.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointResultKind {
	/// A new durable checkpoint was captured.
	Created,
	/// The selected branch's checkpoints were listed.
	Listed,
}

/// Typed checkpoint operation result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointPayload {
	/// Completed operation.
	pub action:      CheckpointResultKind,
	/// Created singleton or newest-first selected-branch listing.
	pub checkpoints: Vec<Arc<CheckpointInfo>>,
}

/// Scheduled rewind receipt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RewindPayload {
	/// Checkpoint selected by token or label.
	pub checkpoint: Arc<CheckpointInfo>,
	/// Findings retained with the rewind command.
	pub report:     Str,
	/// Agent-issued command receipt identifier.
	pub receipt:    Str,
	/// Fully committed workspace restoration.
	pub workspace:  WorkspaceRestore,
	/// Stable settlement verdict.
	pub scheduled:  bool,
}

/// Checkpoint tools do not stream updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Stable checkpoint failure class.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultCode {
	/// A checkpoint label already exists on the selected branch.
	DuplicateLabel,
	/// No checkpoint matches the supplied token or label.
	NotFound,
	/// More than one checkpoint matches the supplied label.
	AmbiguousSelector,
	/// A checkpoint argument is empty or outside its bound.
	InvalidArgument,
	/// The report is empty after trimming.
	EmptyReport,
	/// A rewind is already queued.
	AlreadyScheduled,
	/// Workspace capture failed before the checkpoint was activated.
	SnapshotFailed,
	/// Dirty documents or another workspace transition blocked restoration.
	RestoreConflict,
	/// The caller cancelled workspace capture or restoration.
	RestoreCancelled,
	/// Workspace restoration failed or partially committed.
	RestoreFailed,
	/// The active agent control bridge failed.
	Control,
}

/// Journal bridge or checkpoint validation failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Fault {
	code:    FaultCode,
	message: Str,
}

/// Creates durable checkpoint entries.
pub struct Checkpoint<C> {
	control: C,
	spec:    ToolSpec,
}
/// Schedules a boundary rewind to a durable checkpoint token.
pub struct Rewind<C> {
	control: C,
	spec:    ToolSpec,
}

/// Creates the paired tools over one active-agent bridge.
pub fn tools<C: CheckpointControl>(control: C) -> (Checkpoint<C>, Rewind<C>) {
	let checkpoint = Checkpoint {
		control: control.clone(),
		spec:    spec(
			"checkpoint",
			"Creates or lists named durable workspace/session checkpoints on the selected branch. \
			 Create captures both authorities; list returns ancestry newest first.",
			omp_tool::schema::<CheckpointParams>(),
			3,
			Effects {
				documents: Some(DocEffects { read: true, write_globs: Arc::<[Str]>::from([]) }),
				..Effects::empty()
			},
		),
	};
	let rewind = Rewind {
		control,
		spec: spec(
			"rewind",
			"Selects a checkpoint by exact token or unique label, restores its workspace through \
			 document authority, then schedules session rewind at the next safe boundary while \
			 retaining the findings report.",
			omp_tool::schema::<RewindParams>(),
			4,
			Effects {
				documents: Some(DocEffects {
					read:        true,
					write_globs: Arc::from([Str::new_static("**")]),
				}),
				..Effects::empty()
			},
		),
	};
	(checkpoint, rewind)
}

fn spec(
	name: &'static str,
	description: &'static str,
	schema: bytes::Bytes,
	revision: u16,
	effects: Effects,
) -> ToolSpec {
	ToolSpec {
		name: sf!(name),
		rev: Rev { family: Default::default(), n: revision },
		description: sf!(description),
		schema,
		constraint: Constraint::Schema {
			priority:       255,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects,
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("checkpoint.rs"),
		)
		.into(),
	}
}

impl<C: CheckpointControl> Tool for Checkpoint<C> {
	type Fault = Fault;
	type Params = CheckpointParams;
	type Payload = CheckpointPayload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, CheckpointPayload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<CheckpointParams>().await { Ok(value) => value, Err(error) => { yield param_event(error); return; } };
			if let Err(error) = incoming.interruptable().committed().await { yield commit_checkpoint(error); return; }
			match params.action {
				CheckpointAction::Create => {
					if params.limit != default_list_limit() {
						yield done_checkpoint(Err(fault(
							FaultCode::InvalidArgument,
							"create accepts only action, goal, and label",
						)));
						return;
					}
					let (Some(goal), Some(label)) = (params.goal, params.label) else {
						yield done_checkpoint(Err(fault(
							FaultCode::InvalidArgument,
							"create requires goal and label",
						)));
						return;
					};
					if goal.trim().is_empty() || label.trim().is_empty() {
						yield done_checkpoint(Err(fault(
							FaultCode::InvalidArgument,
							"goal and label must not be empty",
						)));
						return;
					}
					let goal = Str::new(goal.trim());
					let label = Str::new(label.trim());
					let cancellation = CancellationToken::new();
					let execution = self
						.control
						.create_checkpoint(goal, label, cancellation.clone());
					tokio::pin!(execution);
					tokio::select! {
						result = &mut execution => {
							let result = result
								.map(|ack| CheckpointPayload {
									action: CheckpointResultKind::Created,
									checkpoints: vec![ack.checkpoint],
								})
								.map_err(|fault| Fault { code: fault.code, message: fault.message });
							yield done_checkpoint(result);
						},
						interrupt = incoming.next_interrupt() => {
							cancellation.cancel();
							let _ = execution.await;
							yield interrupted_event(interrupt);
						},
					}
				},
				CheckpointAction::List => {
					if params.goal.is_some() || params.label.is_some() {
						yield done_checkpoint(Err(fault(
							FaultCode::InvalidArgument,
							"list accepts only action and limit",
						)));
						return;
					}
					let limit = params.limit;
					if !(1..=100).contains(&limit) {
						yield done_checkpoint(Err(fault(
							FaultCode::InvalidArgument,
							"limit must be between 1 and 100",
						)));
						return;
					}
					let result = self
						.control
						.list_checkpoints(limit)
						.await
						.map(|checkpoints| CheckpointPayload {
							action: CheckpointResultKind::Listed,
							checkpoints,
						})
						.map_err(|fault| Fault { code: fault.code, message: fault.message });
					yield done_checkpoint(result);
				},
			}
		}
	}

	fn prompt(&self, view: Result<&CheckpointPayload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(CheckpointPayload { action: CheckpointResultKind::Created, checkpoints }) => {
					let checkpoint = checkpoints
						.first()
						.expect("created checkpoint payload contains one checkpoint");
					sf!(
						"Checkpoint {} ({}) created for: {}",
						checkpoint.token,
						checkpoint.label,
						checkpoint.goal
					)
				},
				Ok(CheckpointPayload { action: CheckpointResultKind::Listed, checkpoints }) => {
					let mut text = String::from("Selected-branch checkpoints:");
					for checkpoint in checkpoints {
						use std::fmt::Write as _;
						let _ = write!(text, "\n- {} ({})", checkpoint.label, checkpoint.token);
						if let Some(parent) = &checkpoint.parent_token {
							let _ = write!(text, " <- {parent}");
						}
					}
					Str::from(text)
				},
				Err(fault) => fault.message.clone(),
			},
		}]
	}
}

impl<C: CheckpointControl> Tool for Rewind<C> {
	type Fault = Fault;
	type Params = RewindParams;
	type Payload = RewindPayload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, RewindPayload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<RewindParams>().await { Ok(value) => value, Err(error) => { yield param_event(error); return; } };
			if params.checkpoint.trim().is_empty() {
				yield done_rewind(Err(fault(
					FaultCode::InvalidArgument,
					"checkpoint selector must not be empty",
				)));
				return;
			}
			if params.report.trim().is_empty() {
				yield done_rewind(Err(fault(FaultCode::EmptyReport, "report must not be empty")));
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await { yield commit_rewind(error); return; }
			let checkpoint = Str::new(params.checkpoint.trim());
			let report = Str::new(params.report.trim());
			let cancellation = CancellationToken::new();
			let execution = self
				.control
				.schedule_rewind(checkpoint, report.clone(), cancellation.clone());
			tokio::pin!(execution);
			tokio::select! {
				result = &mut execution => {
					let result = result
						.map(|ack| RewindPayload {
							checkpoint: ack.checkpoint,
							report,
							receipt: ack.receipt,
							workspace: ack.workspace,
							scheduled: true,
						})
						.map_err(|fault| Fault { code: fault.code, message: fault.message });
					yield done_rewind(result);
				},
				interrupt = incoming.next_interrupt() => {
					cancellation.cancel();
					match execution.await {
						Ok(ack) => {
							yield done_rewind(Ok(RewindPayload {
								checkpoint: ack.checkpoint,
								report,
								receipt: ack.receipt,
								workspace: ack.workspace,
								scheduled: true,
							}));
						},
						Err(_) => yield interrupted_event(interrupt),
					}
				},
			}
		}
	}

	fn prompt(&self, view: Result<&RewindPayload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(payload) => sf!(
					"Workspace restored ({} written, {} deleted, {} unchanged); rewind to checkpoint \
					 {} scheduled at turn boundary (receipt {}).",
					payload.workspace.written,
					payload.workspace.deleted,
					payload.workspace.unchanged,
					payload.checkpoint.token,
					payload.receipt
				),
				Err(fault) => fault.message.clone(),
			},
		}]
	}
}

const fn fault(code: FaultCode, message: &'static str) -> Fault {
	Fault { code, message: sf!(message) }
}
const fn done_checkpoint(
	result: Result<CheckpointPayload, Fault>,
) -> Ev<Update, CheckpointPayload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}
const fn done_rewind(result: Result<RewindPayload, Fault>) -> Ev<Update, RewindPayload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}
fn param_event<P>(error: ParamError) -> Ev<Update, P, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn commit_checkpoint(error: CommitError) -> Ev<Update, CheckpointPayload, Fault> {
	commit_event(error)
}
fn commit_rewind(error: CommitError) -> Ev<Update, RewindPayload, Fault> {
	commit_event(error)
}
fn commit_event<P>(error: CommitError) -> Ev<Update, P, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn interrupted_event<P>(
	interrupt: Result<omp_tool::Interrupt, omp_tool::InterruptWaitError>,
) -> Ev<Update, P, Fault> {
	match interrupt {
		Ok(interrupt) => Ev::Aborted(Abort::Interrupted { reason: interrupt.reason }),
		Err(_) => Ev::Aborted(Abort::InputDropped),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  None,
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use std::{
		future,
		sync::{
			Arc, Mutex,
			atomic::{AtomicBool, Ordering},
		},
	};

	use futures::StreamExt as _;

	use super::*;

	fn snapshot() -> WorkspaceSnapshot {
		WorkspaceSnapshot {
			snapshot_id:        sf!("snapshot"),
			root_uri:           sf!("file:///workspace"),
			generation:         7,
			tree_hash:          sf!("tree"),
			files:              2,
			bytes:              12,
			label:              Some(sf!("parser-baseline")),
			parent_snapshot_id: Some(sf!("parent-snapshot")),
			created_at:         42,
			partial:            false,
		}
	}

	fn info() -> CheckpointInfo {
		CheckpointInfo {
			token:          sf!("opaque"),
			label:          sf!("parser-baseline"),
			goal:           sf!("inspect"),
			started_at:     42,
			parent_token:   Some(sf!("parent-token")),
			session_target: Some(sf!("01K4TARGET")),
			workspace:      snapshot(),
		}
	}

	fn restore() -> WorkspaceRestore {
		WorkspaceRestore {
			snapshot_id:      sf!("snapshot"),
			undo_snapshot_id: sf!("undo"),
			written:          1,
			deleted:          1,
			unchanged:        0,
			from_generation:  8,
			to_generation:    9,
		}
	}

	#[derive(Clone)]
	struct Control;
	impl CheckpointControl for Control {
		fn create_checkpoint(
			&self,
			_: Str,
			_: Str,
			_: CancellationToken,
		) -> impl Future<Output = Result<CheckpointAck, CheckpointFault>> + Send {
			future::ready(Ok(CheckpointAck { checkpoint: Arc::new(info()) }))
		}

		fn list_checkpoints(
			&self,
			_: u16,
		) -> impl Future<Output = Result<Vec<Arc<CheckpointInfo>>, CheckpointFault>> + Send {
			future::ready(Ok(vec![Arc::new(info())]))
		}

		fn schedule_rewind(
			&self,
			_: Str,
			_: Str,
			_: CancellationToken,
		) -> impl Future<Output = Result<RewindAck, CheckpointFault>> + Send {
			future::ready(Ok(RewindAck {
				checkpoint: Arc::new(info()),
				receipt:    sf!("rewind-1"),
				workspace:  restore(),
			}))
		}
	}

	#[derive(Clone, Default)]
	struct RecordingControl(Arc<Mutex<Option<(Str, Str)>>>);

	impl CheckpointControl for RecordingControl {
		fn create_checkpoint(
			&self,
			_: Str,
			_: Str,
			_: CancellationToken,
		) -> impl Future<Output = Result<CheckpointAck, CheckpointFault>> + Send {
			future::ready(Ok(CheckpointAck { checkpoint: Arc::new(info()) }))
		}

		fn list_checkpoints(
			&self,
			_: u16,
		) -> impl Future<Output = Result<Vec<Arc<CheckpointInfo>>, CheckpointFault>> + Send {
			future::ready(Ok(vec![Arc::new(info())]))
		}

		fn schedule_rewind(
			&self,
			checkpoint: Str,
			report: Str,
			_: CancellationToken,
		) -> impl Future<Output = Result<RewindAck, CheckpointFault>> + Send {
			self
				.0
				.lock()
				.expect("recording control")
				.replace((checkpoint, report));
			future::ready(Ok(RewindAck {
				checkpoint: Arc::new(info()),
				receipt:    sf!("rewind-1"),
				workspace:  restore(),
			}))
		}
	}

	#[test]
	fn pair_has_distinct_canonical_versioned_slots() {
		let (checkpoint, rewind) = tools(Control);
		assert_eq!(checkpoint.spec().name, "checkpoint");
		assert_eq!(rewind.spec().name, "rewind");
		assert!(
			crate::builtin_tool_identities()
				.iter()
				.any(|identity| { identity.name == rewind.spec().name.as_str() && !identity.hidden })
		);
		assert_eq!(checkpoint.spec().rev.n, 3);
		assert_eq!(rewind.spec().rev.n, 4);
		assert_eq!(
			checkpoint
				.spec()
				.effects
				.documents
				.as_ref()
				.map(|value| value.read),
			Some(true)
		);
		assert_eq!(
			rewind
				.spec()
				.effects
				.documents
				.as_ref()
				.map(|value| value.write_globs.as_ref()),
			Some([Str::new_static("**")].as_slice())
		);
	}

	#[test]
	fn checkpoint_schema_exposes_create_and_list_without_legacy_shape() {
		let (checkpoint, _) = tools(Control);
		let schema: serde_json::Value =
			serde_json::from_slice(&checkpoint.spec().schema).expect("checkpoint schema");
		assert_eq!(schema["additionalProperties"], false);
		assert_eq!(schema["required"], serde_json::json!(["i", "action"]));
		assert_eq!(
			schema["properties"]
				.as_object()
				.expect("properties")
				.keys()
				.map(String::as_str)
				.collect::<std::collections::BTreeSet<_>>(),
			["action", "goal", "i", "label", "limit", "notrunc"]
				.into_iter()
				.collect()
		);
		assert_eq!(schema["properties"]["limit"]["minimum"], 1);
		assert_eq!(schema["properties"]["limit"]["maximum"], 100);
	}

	#[test]
	fn rewind_schema_requires_checkpoint_selection_and_report() {
		let (_, rewind) = tools(Control);
		let schema: serde_json::Value =
			serde_json::from_slice(&rewind.spec().schema).expect("rewind schema");
		assert_eq!(schema["additionalProperties"], false);
		assert_eq!(schema["required"], serde_json::json!(["i", "checkpoint", "report"]));
		assert_eq!(
			schema["properties"]
				.as_object()
				.expect("properties")
				.keys()
				.map(String::as_str)
				.collect::<std::collections::BTreeSet<_>>(),
			["checkpoint", "i", "notrunc", "report"]
				.into_iter()
				.collect()
		);
	}

	#[tokio::test]
	async fn checkpoint_list_returns_typed_branch_ancestry() {
		let (checkpoint, _) = tools(Control);
		let raw = r#"{"action":"list","limit":10}"#;
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("stream args");
		feed.args_committed(raw.into()).expect("commit args");
		let events = checkpoint.call(incoming).collect::<Vec<_>>().await;
		assert!(matches!(
			events.last(),
			Some(Ev::Done(ToolTerminal::Done {
				result: Ok(CheckpointPayload {
					action: CheckpointResultKind::Listed,
					checkpoints,
				}),
				..
			})) if checkpoints.first().and_then(|checkpoint| checkpoint.parent_token.as_deref())
				== Some("parent-token")
		));
	}

	#[tokio::test]
	async fn rewind_routes_selector_and_report_to_checkpoint_control() {
		let control = RecordingControl::default();
		let (_, rewind) = tools(control.clone());
		let raw = r#"{"checkpoint":"parser-baseline","report":"keep this finding"}"#;
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("stream args");
		feed.args_committed(raw.into()).expect("commit args");
		let events = rewind.call(incoming).collect::<Vec<_>>().await;
		assert!(matches!(
			events.last(),
			Some(Ev::Done(ToolTerminal::Done { result: Ok(payload), .. }))
				if payload.checkpoint.token == "opaque" && payload.report == "keep this finding"
		));
		assert_eq!(
			control
				.0
				.lock()
				.expect("recording control")
				.as_ref()
				.map(|(checkpoint, report)| (checkpoint.as_str(), report.as_str())),
			Some(("parser-baseline", "keep this finding"))
		);
	}

	#[derive(Clone, Default)]
	struct CancelControl(Arc<AtomicBool>);

	impl CheckpointControl for CancelControl {
		fn create_checkpoint(
			&self,
			_: Str,
			_: Str,
			cancel: CancellationToken,
		) -> impl Future<Output = Result<CheckpointAck, CheckpointFault>> + Send {
			let observed = Arc::clone(&self.0);
			async move {
				cancel.cancelled().await;
				observed.store(true, Ordering::Release);
				Err(CheckpointFault { code: FaultCode::RestoreCancelled, message: sf!("cancelled") })
			}
		}

		fn list_checkpoints(
			&self,
			_: u16,
		) -> impl Future<Output = Result<Vec<Arc<CheckpointInfo>>, CheckpointFault>> + Send {
			future::ready(Ok(Vec::new()))
		}

		fn schedule_rewind(
			&self,
			_: Str,
			_: Str,
			_: CancellationToken,
		) -> impl Future<Output = Result<RewindAck, CheckpointFault>> + Send {
			future::pending()
		}
	}

	#[tokio::test]
	async fn interrupt_reaches_workspace_capture_boundary() {
		let control = CancelControl::default();
		let (checkpoint, _) = tools(control.clone());
		let raw = r#"{"action":"create","goal":"inspect","label":"baseline"}"#;
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("stream args");
		feed.args_committed(raw.into()).expect("commit args");
		feed
			.interrupt(omp_tool::Interrupt { class: sf!("user"), reason: sf!("stop checkpoint") })
			.expect("interrupt");
		let events = checkpoint.call(incoming).collect::<Vec<_>>().await;
		assert!(matches!(
			events.last(),
			Some(Ev::Aborted(Abort::Interrupted { reason })) if reason == "stop checkpoint"
		));
		assert!(control.0.load(Ordering::Acquire));
	}

	#[test]
	fn argument_contracts_are_closed_without_legacy_shims() {
		assert!(
			serde_json::from_value::<CheckpointParams>(
				serde_json::json!({"goal":"inspect","label":"baseline"})
			)
			.is_err()
		);
		assert!(
			serde_json::from_value::<CheckpointParams>(
				serde_json::json!({"action":"create","goal":"inspect","label":"baseline"})
			)
			.is_ok()
		);
		assert!(
			serde_json::from_value::<RewindParams>(serde_json::json!({"report":"finding"})).is_err()
		);
		assert!(
			serde_json::from_value::<RewindParams>(
				serde_json::json!({"checkpoint":"baseline","report":"finding"})
			)
			.is_ok()
		);
	}
}
