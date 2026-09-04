//! Journal-first agent turn kernel.

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Instant,
};

use futures::StreamExt as _;
use omp_ai::{
	ArtifactBody, BlockKind, ChatEvent, ChatRequest, ChatStream, Client, Completion, FinishReason,
	Message as InferenceMessage, NegotiationPolicy, Planner, RecoveryKind, RecoveryRecord,
	SafetySetting, Sampling, Setting, Usage,
};
use omp_core::{FastHashMap, Hash32, Str, sf};
use omp_dom::{Handle, KnownTag, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use omp_journal::{
	EntryId,
	blob::BlobStore,
	data::{
		AsyncJobDelivery, AsyncJobStatus, AsyncResult, Attachment, FileMentions, InferenceRecovery,
		InferenceRecoveryKind, MentionedFile, MentionedFileState, SkillPrompt, TurnReceipt,
	},
};
use omp_proto::{
	thread::v1::{Item, Message, Part as ThreadPart, Role, item, part},
	toolhost::v1::HookEventId,
};
use omp_session::{Session, SessionError};
use omp_tool::{Abort, Registry, RegistryError, ToolIdentity};
use serde_json::value::RawValue;
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use tower::Service;

use crate::{
	CallControl, CancelTree, Director as _, DirectorCx, DirectorError, DirectorRegistry,
	DirectorStack, DispatchError, DispatchPolicy, Dispatcher, ExternalToolExecutor,
	FileMentionService, FileMentionSource, KernelEvent, LiveComponent, LiveComponentError,
	LoopDecision, MaterializedFileMention, MutDirectorCx, Prepared, PreparedCall, Received,
	ReplyObligations, RouteFacts, SessionTool, ToolCancellation, TurnView, Up,
	directors::compaction::CompactionDirector,
	parse_file_mentions,
	steering::{
		EMPTY_OUTPUT_RETRY_CAP, append_custom_message, append_empty_output_cap_notice,
		append_empty_output_retry, append_error_notice, append_interrupt_notice, append_named_notice,
		append_notice, consume_steering, steering_pending,
	},
};

/// Maximum consecutive provider-declared non-terminal completions without a
/// tool call.
const PAUSED_TURN_CONTINUATION_CAP: u8 = 8;
const PAUSED_TURN_KIND: &str = "pause_turn";

struct TurnActivity(Arc<AtomicBool>);

impl TurnActivity {
	fn enter(active: Arc<AtomicBool>) -> Self {
		active.store(true, Ordering::Release);
		Self(active)
	}
}

impl Drop for TurnActivity {
	fn drop(&mut self) {
		self.0.store(false, Ordering::Release);
	}
}

/// Pure system-prompt projection from the authoritative session tree.
pub trait PromptSource: Send + Sync {
	/// Projects ordered system items without retaining parallel session state.
	///
	/// A failure (a template that cannot render from the journal-derived
	/// facts) ends the turn before inference and is journaled as a
	/// `<notice kind=error>` by the kernel rather than aborting the host.
	fn system_items(&self, dom: &omp_dom::Dom) -> Result<Vec<Item>, crate::PromptError>;
}

/// Fixed system prompt useful for tests and small embeddings.
#[derive(Clone, Debug)]
pub struct StaticPrompt(pub Str);

impl PromptSource for StaticPrompt {
	fn system_items(&self, _dom: &omp_dom::Dom) -> Result<Vec<Item>, crate::PromptError> {
		Ok(vec![Item {
			kind: Some(item::Kind::Message(Message {
				role: Role::System as i32,
				parts: vec![ThreadPart { kind: Some(part::Kind::Text(self.0.as_str().to_owned())) }],
				..Default::default()
			})),
			..Default::default()
		}])
	}
}

/// Minimal inference capability required by the agent kernel.
pub trait Inference: Send {
	/// Starts one canonical streaming chat operation.
	fn chat(
		&mut self,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send;

	/// Starts one isolated chat operation on the model `selector` names (a
	/// catalog key or `@role`) without re-targeting the live route: an
	/// auxiliary second-model call (the advisor watchdog). Stacks that carry
	/// no catalog run it on the live route.
	fn chat_on(
		&mut self,
		selector: &str,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		let _ = selector;
		self.chat(request)
	}

	/// Rebinds observer-only wire capture to the live journal after a session
	/// switch. Inference stacks without a local transport keep the default
	/// no-op.
	fn set_debug_session(&mut self, session: Option<Str>) {
		let _ = session;
	}

	/// Re-derives disposable host-side indexes from the selected session DOM.
	/// Inference stacks without environment-owned session tools keep the
	/// default no-op.
	fn select_session(&self, dom: &omp_dom::Dom) {
		let _ = dom;
	}

	/// Installs the observer that receives same-route retry notices for
	/// every subsequent chat. Inference stacks without a retry layer keep the
	/// default no-op.
	fn install_retry_sink(&mut self, sink: omp_ai::RetrySink) {
		let _ = sink;
	}

	/// Catalog facts for the route the next request will actually use
	/// (`ai_model` may re-target inference between requests); `None` keeps
	/// the facts fixed at composition.
	fn route_facts(&self) -> Option<RouteFacts> {
		None
	}

	/// The catalog model key the next request targets, when known.
	fn selected_model(&self) -> Option<Str> {
		None
	}
}

impl<S, P> Inference for Client<S, P>
where
	S: Service<omp_ai::call::Call, Response = omp_ai::Answer, Error = omp_ai::Error> + Send,
	S::Future: Send,
	P: Planner + Send,
{
	fn chat(
		&mut self,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.execute(request)
	}

	fn install_retry_sink(&mut self, sink: omp_ai::RetrySink) {
		let mut meta = self.call_meta().clone();
		meta.response_hooks = meta.response_hooks.with_retry_sink(sink);
		self.set_call_meta(meta);
	}
}

/// User input that begins one explicit session turn.
pub struct TurnInput {
	/// User-authored text.
	pub text:        Str,
	/// Content-addressed media, already in the session's blob store (see
	/// [`Session::store_attachment`]); positional against `[Image #N]`
	/// markers in `text`.
	pub attachments: Vec<Attachment>,
}

/// Why the kernel returned control to its caller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TurnStop {
	/// The candidate yield passed the Director stack.
	Completed,
	/// Turn or session cancellation was observed.
	Cancelled,
	/// Steering was consumed at a safe point before yielding.
	Steered,
	/// The turn ended in a journaled error notice (only reported through
	/// [`KernelEvent::TurnEnded`]; `run_turn` returns the error itself).
	Failed,
}

/// Durable summary of one explicit turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnOutcome {
	/// Terminal control reason.
	pub stop:           TurnStop,
	/// Visible assistant text accumulated across tool continuations.
	pub assistant_text: Str,
	/// Total input tokens across inference attempts.
	pub tokens_in:      u64,
	/// Total output tokens across inference attempts.
	pub tokens_out:     u64,
}

/// Caller-owned cancellation and optional deadline for one turn.
#[derive(Clone, Debug)]
pub struct RunControl {
	cancellation:          CancellationToken,
	deadline:              Option<Instant>,
	max_requests:          Option<u32>,
	request_budget_notice: bool,
}

impl RunControl {
	/// Creates turn control from an external cancellation token and deadline.
	#[must_use]
	pub const fn new(cancellation: CancellationToken, deadline: Option<Instant>) -> Self {
		Self { cancellation, deadline, max_requests: None, request_budget_notice: true }
	}

	/// Limits the number of provider requests this turn may start.
	#[must_use]
	pub const fn with_request_budget(mut self, max_requests: u32) -> Self {
		self.max_requests = Some(max_requests);
		self
	}

	/// Controls whether reaching the soft request budget grants one wrap-up
	/// request carrying a durable notice.
	#[must_use]
	pub const fn with_request_budget_notice(mut self, enabled: bool) -> Self {
		self.request_budget_notice = enabled;
		self
	}

	/// Returns whether request ordinal `started` may begin.
	#[must_use]
	pub fn permits_request(&self, started: u32, notice_sent: bool) -> bool {
		self.max_requests.is_none_or(|maximum| {
			started < maximum || (self.request_budget_notice && started == maximum && !notice_sent)
		})
	}

	fn should_emit_request_budget_notice(&self, started: u32, notice_sent: bool) -> bool {
		self.request_budget_notice
			&& !notice_sent
			&& self.max_requests.is_some_and(|maximum| started == maximum)
	}

	/// Reports whether cancellation or the deadline has already fired.
	#[must_use]
	pub fn is_expired(&self) -> bool {
		self.cancellation.is_cancelled()
			|| self
				.deadline
				.is_some_and(|deadline| Instant::now() >= deadline)
	}

	pub(crate) async fn cancelled(&self) {
		if let Some(deadline) = self.deadline {
			tokio::select! {
				() = self.cancellation.cancelled() => {},
				() = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {},
			}
		} else {
			self.cancellation.cancelled().await;
		}
	}
}

impl Default for RunControl {
	fn default() -> Self {
		Self::new(CancellationToken::new(), None)
	}
}

/// Turn-loop construction, inference, dispatch, or session failure.
#[derive(Debug, Error)]
pub enum KernelError {
	/// Session journal or DOM fold failed.
	#[error(transparent)]
	Session(#[from] SessionError),
	/// Inference planning or streaming failed.
	#[error(transparent)]
	Inference(#[from] omp_ai::Error),
	/// Tool registry operation failed.
	#[error(transparent)]
	Registry(#[from] RegistryError),
	/// Canonical thread projection failed.
	#[error(transparent)]
	ThreadProjection(#[from] omp_ai::ThreadProjectionError),
	/// Blob persistence failed.
	#[error(transparent)]
	Blob(#[from] omp_journal::blob::Error),
	/// Provider artifact metadata disagreed with the bytes pinned in the
	/// session CAS.
	#[error("provider artifact size differs from its pinned bytes")]
	ArtifactSizeMismatch {
		/// Size declared by the provider.
		declared: u64,
		/// Size stored in the session CAS.
		actual:   u64,
	},
	/// A provider returned a stored artifact without the size needed to
	/// address it in the session CAS.
	#[error("stored provider artifact omitted its byte length")]
	StoredArtifactSizeMissing,
	/// Tool dispatch failed.
	#[error(transparent)]
	Dispatch(#[from] DispatchError),
	/// Director reconstruction or execution failed.
	#[error(transparent)]
	Director(#[from] DirectorError),
	/// JSON serialization failed.
	#[error(transparent)]
	Json(#[from] serde_json::Error),
	/// An inference stream emitted output before response metadata.
	#[error("inference output arrived before response metadata")]
	MissingResponseStart,
	/// A tool argument block did not contain UTF-8 JSON text.
	#[error("tool argument delta is not UTF-8")]
	ToolArgumentUtf8 {
		/// UTF-8 validation failure.
		#[source]
		source: std::str::Utf8Error,
	},
	/// A ready tool call conflicts with its streamed call identity.
	#[error("ready tool call does not match its streamed call")]
	ToolCallMismatch,
	/// A live lifecycle hook denied or malformed a transition.
	#[error(transparent)]
	LifecycleHook(#[from] crate::LifecycleHookError),
	/// A live extension Component reducer failed.
	#[error(transparent)]
	LiveComponent(#[from] LiveComponentError),
	/// The system prompt could not be projected from the session tree.
	#[error("system prompt projection failed")]
	Prompt(#[source] crate::PromptError),
	/// The last turn has no aborted tool tail to re-execute.
	#[error("the last turn has no aborted tool tail to retry")]
	NothingToRetry,
	/// A provider workflow action could not be answered on its live session.
	#[error("provider workflow action response failed: {0:?}")]
	WorkflowResponse(omp_ai::ChatControlError),
}

/// Journal-backed host state which must flush and rehydrate with the session.
pub trait SessionStateBridge: Send + Sync {
	/// Journals pending host writes before session readers project state.
	fn flush(&self, session: &mut Session) -> Result<(), SessionError>;
	/// Rehydrates disposable host state after rewind or session switch.
	fn resync(&self, dom: &omp_dom::Dom);
}

/// Cross-crate runtime switches resolved by the composition owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeFlags {
	/// Whether automatic context compaction may engage.
	pub automatic_compaction:     bool,
	/// Whether Goal engagements may remain active.
	pub goal_enabled:             bool,
	/// Whether a substantive turn schedules automatic learning.
	pub autolearn_enabled:        bool,
	/// Minimum settled non-learn calls before automatic learning.
	pub autolearn_min_tool_calls: usize,
	/// Whether plain-text sloppy edit payloads become real edit calls.
	pub recover_inline_edits:     bool,
}

impl Default for RuntimeFlags {
	fn default() -> Self {
		Self {
			automatic_compaction:     true,
			goal_enabled:             true,
			autolearn_enabled:        false,
			autolearn_min_tool_calls: 5,
			recover_inline_edits:     true,
		}
	}
}

/// Agent kernel composed from inference, tool, prompt, and Director registries.
pub struct Kernel<C> {
	client:                C,
	pub(crate) dispatcher: Dispatcher,
	pub(crate) cancel:     CancelTree,
	turn_active:           Arc<AtomicBool>,
	reply_obligations:     ReplyObligations,
	director_registry:     DirectorRegistry,
	live_components:       Vec<Box<dyn LiveComponent>>,
	lifecycle_hooks:       Option<crate::LifecycleHooks>,
	state_bridges:         Vec<Arc<dyn SessionStateBridge>>,
	file_mentions:         Option<FileMentionService>,
	pub(crate) events:     crate::events::KernelEvents,
	prompt:                Arc<dyn PromptSource>,
	route:                 RouteFacts,
	con:                   Option<Arc<omp_con::Ctx>>,
	runtime_flags:         RuntimeFlags,
	pub(crate) mailbox_tx: flume::Sender<Up>,
	mailbox_rx:            flume::Receiver<Up>,
	/// Reply channels of the approval prompts journaled from the mailbox.
	approvals:             crate::ApprovalDesk,
}

impl<C> Kernel<C> {
	/// Constructs a kernel with the standard Director registry.
	#[must_use]
	pub fn new(
		mut client: C,
		registry: Arc<Registry>,
		policy: DispatchPolicy,
		prompt: impl PromptSource + 'static,
	) -> Self
	where
		C: Inference,
	{
		let (mailbox_tx, mailbox_rx) = flume::unbounded();
		let events = crate::events::KernelEvents::default();
		let retry_events = events.clone();
		client.install_retry_sink(Arc::new(move |notice: omp_ai::RetryNotice| {
			retry_events.publish(KernelEvent::InferenceRetry {
				attempt:      notice.attempt,
				max_attempts: notice.max_attempts,
				delay:        notice.delay,
				reason:       notice.message,
			});
		}));
		Self {
			client,
			dispatcher: Dispatcher::new(registry, policy).with_events(events.clone()),
			cancel: CancelTree::new(),
			turn_active: Arc::new(AtomicBool::new(false)),
			reply_obligations: ReplyObligations::default(),
			director_registry: DirectorRegistry::standard(),
			live_components: Vec::new(),
			lifecycle_hooks: None,
			state_bridges: Vec::new(),
			file_mentions: None,
			approvals: crate::ApprovalDesk::new(events.clone()),
			events,
			prompt: Arc::new(prompt),
			route: RouteFacts::default(),
			con: None,
			runtime_flags: RuntimeFlags::default(),
			mailbox_tx,
			mailbox_rx,
		}
	}

	/// Replaces the Director registry assembled by the host.
	#[must_use]
	pub fn with_director_registry(mut self, registry: DirectorRegistry) -> Self {
		self.director_registry = registry;
		self
	}

	/// Installs the shared extension lifecycle gate.
	#[must_use]
	pub fn with_hook_gate(mut self, gate: Arc<crate::HookGate>) -> Self {
		let hooks = crate::LifecycleHooks::new(gate);
		self.dispatcher = self.dispatcher.with_lifecycle_hooks(hooks.clone());
		self.lifecycle_hooks = Some(hooks);
		self
	}

	/// Installs the existing Read/document authority used for submitted
	/// `@path` materialization.
	#[must_use]
	pub fn with_file_mention_source<S: FileMentionSource>(mut self, source: S) -> Self {
		self.file_mentions = Some(FileMentionService::spawn(source));
		self
	}

	/// Returns the shared lifecycle facade for host-side session transitions.
	#[must_use]
	pub fn lifecycle_hooks(&self) -> Option<crate::LifecycleHooks> {
		self.lifecycle_hooks.clone()
	}

	/// Retains a journal-backed host state bridge for turn and session
	/// boundaries.
	#[must_use]
	pub fn with_session_state_bridge(mut self, bridge: Arc<dyn SessionStateBridge>) -> Self {
		self.state_bridges.push(bridge);
		self
	}

	/// Flushes pending host state into the authoritative journal.
	pub fn flush_session_state(&self, session: &mut Session) -> Result<(), SessionError> {
		for bridge in &self.state_bridges {
			bridge.flush(session)?;
		}
		Ok(())
	}

	/// Rehydrates disposable host state and Director layers from the current
	/// DOM.
	pub fn resync_session_state(&self, session: &Session)
	where
		C: Inference,
	{
		self.client.select_session(session.dom());
		for bridge in &self.state_bridges {
			bridge.resync(session.dom());
		}
		self.reconcile_director_binds(session);
	}

	/// Registers a live extension Component reducer.
	pub fn register_live_component(&mut self, component: Box<dyn LiveComponent>) {
		self.live_components.push(component);
	}

	/// Replaces catalog-derived facts for the selected route.
	#[must_use]
	pub const fn with_route_facts(mut self, route: RouteFacts) -> Self {
		self.route = route;
		self
	}

	/// Injects the effective control-plane context used for Director layers.
	#[must_use]
	pub fn with_con_context(mut self, con: Arc<omp_con::Ctx>) -> Self {
		self.con = Some(con);
		self
	}

	/// Replaces cross-crate runtime switches resolved by host composition.
	#[must_use]
	pub const fn with_runtime_flags(mut self, flags: RuntimeFlags) -> Self {
		self.runtime_flags = flags;
		self
	}

	/// Installs the host approval policy consulted before every native
	/// tool call starts (`--approval-mode`, `tools.approval.*`).
	#[must_use]
	pub fn with_tool_admission(mut self, admission: Arc<dyn crate::ToolAdmission>) -> Self {
		self.dispatcher = self.dispatcher.with_tool_admission(admission);
		self
	}

	/// Injects execution for worker- and remote-routed tools.
	#[must_use]
	pub fn with_external_executor(mut self, executor: Arc<dyn ExternalToolExecutor>) -> Self {
		self.dispatcher = self.dispatcher.with_external_executor(executor);
		self
	}

	/// Registers a host-authority tool that operates on the session DOM.
	#[must_use]
	pub fn with_session_tool(mut self, tool: Arc<dyn SessionTool>) -> Self {
		self.dispatcher = self.dispatcher.with_session_tool(tool);
		self
	}

	/// Injects the host-owned live-session routing authority.
	#[must_use]
	pub fn with_session_authority(mut self, authority: Arc<dyn crate::SessionAuthority>) -> Self {
		self.dispatcher = self.dispatcher.with_session_authority(authority);
		self
	}

	/// Borrows the composed inference owner.
	#[must_use]
	pub const fn inference(&self) -> &C {
		&self.client
	}

	/// Mutably borrows the composed inference owner for host-binding retention
	/// before the kernel starts a turn.
	pub const fn inference_mut(&mut self) -> &mut C {
		&mut self.client
	}

	/// Rebinds private debug capture to one durable session identity.
	pub fn set_debug_session(&mut self, session: Option<Str>)
	where
		C: Inference,
	{
		self.client.set_debug_session(session);
	}

	/// Borrows the composed runtime tool registry.
	#[must_use]
	pub const fn tool_registry(&self) -> &Arc<Registry> {
		self.dispatcher.registry()
	}

	/// Replaces the runtime tool registry between turns.
	///
	/// This is intentionally a mutable, host-only operation: workpool workers
	/// install the strict yield schema for their next batch before inference
	/// sees the roster. Ordinary sessions retain their composed registry.
	pub fn replace_tool_registry(&mut self, registry: Arc<Registry>) {
		debug_assert!(!self.turn_active.load(Ordering::Acquire));
		self.dispatcher.replace_registry(registry);
	}

	/// Borrows the runtime job board supervising detached tools, subagents,
	/// and processes.
	#[must_use]
	pub const fn jobs(&self) -> &Arc<crate::JobBoard> {
		self.dispatcher.jobs()
	}

	/// Reconciles journaled detached jobs after a session open, fork, or
	/// restart.
	///
	/// A terminal tool result whose process died before `jobs.settle` is
	/// adopted into the durable job node. A still-running detached tool with
	/// no execution unit is settled as an orphan. Repeated calls are
	/// idempotent because terminal job nodes are never selected again.
	pub fn reconcile_jobs(
		&self,
		session: &mut Session,
	) -> Result<Vec<crate::JobRecord>, SessionError> {
		self.dispatcher.jobs().rebuild(session);
		self.dispatcher.jobs().poll(session)
	}

	/// Returns the one upward control mailbox.
	#[must_use]
	pub fn mailbox(&self) -> flume::Sender<Up> {
		self.mailbox_tx.clone()
	}

	/// Creates the approval route environment policy prompts through: every
	/// request lands in this kernel's mailbox, is journaled as a pending
	/// `<prompt>` under `<queues><prompts>`, and is answered by the decision
	/// a host sends as [`Up::Approve`]. Approval observers (`tool_approval_*`)
	/// fire through the installed hook gate.
	#[must_use]
	pub fn approval_route(&self) -> crate::ApprovalRoute {
		crate::ApprovalRoute::to_kernel(
			self.mailbox_tx.clone(),
			self
				.lifecycle_hooks
				.as_ref()
				.map(|hooks| Arc::clone(hooks.hook_gate())),
		)
	}

	/// Prompt ids journaled by this kernel that still wait on a host answer.
	#[must_use]
	pub fn waiting_approvals(&self) -> Vec<Str> {
		self.approvals.waiting()
	}

	/// Subscribes to lossless observer notifications for subsequent journaled
	/// progress.
	pub fn subscribe(&mut self) -> flume::Receiver<KernelEvent> {
		self.events.subscribe()
	}

	/// Cancels the owning session and every active or future tool scope.
	pub fn cancel_session(&self) {
		self.cancel.cancel_session();
	}

	/// Shared live-turn state for recipient-owned side-channel actors.
	///
	/// The signal is runtime-only: it determines whether ordinary recipient
	/// execution is currently unavailable and never becomes session state.
	#[must_use]
	pub fn turn_activity(&self) -> Arc<AtomicBool> {
		Arc::clone(&self.turn_active)
	}

	/// Session-bound cancellation for host-owned side-channel actors.
	#[must_use]
	pub fn session_cancellation(&self) -> CancellationToken {
		self.cancel.session_child()
	}

	/// Reply obligations that keep this controller alive through side-channel
	/// model delivery.
	#[must_use]
	pub fn reply_obligations(&self) -> ReplyObligations {
		self.reply_obligations.clone()
	}

	/// Applies rewind/resume lifecycle work to every runtime execution unit.
	pub fn apply_lifecycle(
		&self,
		session: &Session,
		work: &omp_session::LifecycleWork,
	) -> impl Future<Output = ()> + Send + 'static {
		self.dispatcher.jobs().apply_lifecycle(session, work)
	}

	/// Re-derives effective Director convar layers after rewind or session
	/// switch.
	pub fn reconcile_director_binds(&self, session: &Session) {
		if let Some(con) = &self.con {
			DirectorStack::from_dom(session.dom(), &self.director_registry)
				.apply_binds(session.dom(), con);
		}
	}

	pub(crate) fn apply_live_components(
		&mut self,
		session: &mut Session,
	) -> Result<(), KernelError> {
		let Some(head) = session.head() else {
			return Ok(());
		};
		let Some(entry) = session.entry(head).cloned() else {
			return Ok(());
		};
		if let Some(hooks) = &self.lifecycle_hooks
			&& hooks
				.hook_gate()
				.subscribed(HookEventId::HookEventItemCommitted)
		{
			hooks.notify(
				HookEventId::HookEventItemCommitted,
				serde_json::json!({
					"event_index": session.entry_count(),
					"turn_id": current_turn(session).ok().map(|turn| turn.to_string()),
					"item": {
						"event_index": session.entry_count(),
						"item_id": entry.id.to_string(),
						"kind": entry.kind.name,
						"role": serde_json::Value::Null,
					},
				}),
			)?;
		}
		let mut patches = Vec::new();
		let mut failed = false;
		for component in &self.live_components {
			if !component.interested(&entry.kind) {
				continue;
			}
			match component.reduce(&entry, session.dom()) {
				Ok(ops) if !ops.is_empty() => {
					patches.push((Str::new(component.id()), ops));
				},
				Ok(_) => {},
				Err(error) => {
					tracing::warn!(?error, component = component.id(), "live Component failed");
					failed = true;
				},
			}
		}
		for (id, ops) in patches {
			session.patch(Txn { cause: entry.id, label: Some(Str::new(format!("ext:{id}"))), ops })?;
		}
		if failed && let Ok(turn) = current_turn(session) {
			append_notice(
				session,
				turn,
				Str::new_static("Python extension Component callback failed"),
			)?;
		}
		Ok(())
	}
}

impl<C: Inference> Kernel<C> {
	async fn append_file_mentions(
		&self,
		session: &mut Session,
		paths: Vec<Str>,
	) -> Result<(), SessionError> {
		let Some(source) = &self.file_mentions else {
			return Ok(());
		};
		let mut files = Vec::with_capacity(paths.len());
		for path in paths {
			let Some(materialized) = source.materialize(path).await else {
				continue;
			};
			let file = match materialized {
				MaterializedFileMention::Lines { path, content, line_count } => {
					MentionedFile { path, content, state: MentionedFileState::Lines { line_count } }
				},
				MaterializedFileMention::Image { path, media_type, bytes } => {
					let attachment = session.store_attachment(media_type, &bytes)?;
					MentionedFile {
						path,
						content: Str::new_static(""),
						state: MentionedFileState::Image { attachment },
					}
				},
				MaterializedFileMention::SkippedBinary { path, byte_size } => MentionedFile {
					path,
					content: Str::new_static(""),
					state: MentionedFileState::SkippedBinary { byte_size },
				},
				MaterializedFileMention::TooLarge { path, byte_size } => MentionedFile {
					path,
					content: Str::new_static(""),
					state: MentionedFileState::TooLarge { byte_size },
				},
			};
			files.push(file);
		}
		if !files.is_empty() {
			session.file_mentions(FileMentions { files })?;
		}
		Ok(())
	}

	/// Runs one explicit user turn through inference, tools, steering, and
	/// Directors.
	///
	/// A failure after the turn opened is journaled before it is returned: any
	/// open `<assistant>` is closed with stop reason `error` and the turn gains
	/// a `<notice kind=error>` carrying the full error chain, so a resumed or
	/// rendered session shows why the turn ended and observers never see a
	/// dangling assistant.
	pub async fn run_turn(
		&mut self,
		session: &mut Session,
		input: TurnInput,
		control: RunControl,
	) -> Result<TurnOutcome, KernelError> {
		self
			.run_explicit_turn(session, input, None, None, None, control)
			.await
	}

	/// Runs one host-authenticated collaboration prompt as an ordinary user
	/// turn.
	///
	/// The authenticated display name is committed with the initial user
	/// insertion; it is presentation metadata and never changes the inference
	/// content.
	pub async fn run_authored_turn(
		&mut self,
		session: &mut Session,
		input: TurnInput,
		author: Str,
		control: RunControl,
	) -> Result<TurnOutcome, KernelError> {
		self
			.run_explicit_turn(session, input, Some(author), None, None, control)
			.await
	}

	/// Runs a discovered skill invocation as one typed user turn.
	pub async fn run_skill_turn(
		&mut self,
		session: &mut Session,
		prompt: SkillPrompt,
		control: RunControl,
	) -> Result<TurnOutcome, KernelError> {
		let input = TurnInput { text: prompt.prompt_body.clone(), attachments: Vec::new() };
		self
			.run_explicit_turn(session, input, None, Some(prompt), None, control)
			.await
	}

	/// Runs one extension-authored message as model-visible developer context.
	pub async fn run_custom_turn(
		&mut self,
		session: &mut Session,
		message: omp_session::custom_message::CustomMessage,
		control: RunControl,
	) -> Result<TurnOutcome, KernelError> {
		let input = TurnInput { text: message.body.clone(), attachments: Vec::new() };
		self
			.run_explicit_turn(session, input, None, None, Some(message), control)
			.await
	}

	async fn run_explicit_turn(
		&mut self,
		session: &mut Session,
		mut input: TurnInput,
		author: Option<Str>,
		mut skill_prompt: Option<SkillPrompt>,
		mut custom_message: Option<omp_session::custom_message::CustomMessage>,
		control: RunControl,
	) -> Result<TurnOutcome, KernelError> {
		if control.is_expired() || self.cancel.is_session_cancelled() {
			return Ok(cancelled_outcome());
		}
		self.flush_session_state(session)?;
		let submission_id = session
			.head()
			.map_or_else(|| Str::new_static("submission"), |id| Str::new(id.to_string()));
		if let Some(hooks) = &self.lifecycle_hooks {
			let payload = hooks
				.gate(
					HookEventId::HookEventBeforeAgentStart,
					serde_json::json!({
						"submission_id": submission_id,
						"text": input.text,
						"items": [],
						"source": "interactive",
						"prompt_rev": "1",
						"staged_interrupts": 0,
						"resuming": false,
						"schedule_id": serde_json::Value::Null,
					}),
				)
				.await?;
			if let Some(text) = payload.get("text").and_then(serde_json::Value::as_str) {
				input.text = Str::new(text);
				if let Some(prompt) = &mut skill_prompt {
					prompt.prompt_body = input.text.clone();
				}
				if let Some(message) = &mut custom_message {
					message.body = input.text.clone();
				}
			}
			hooks.notify(
				HookEventId::HookEventAgentStart,
				serde_json::json!({
					"submission_id": submission_id,
					"from_phase": "idle",
					"pending_items": 1,
				}),
			)?;
		}
		let turn_cancel = self.cancel.begin_turn();
		session.begin_turn()?;
		self.apply_live_components(session)?;
		match (skill_prompt, custom_message) {
			(Some(prompt), None) => {
				session.skill_prompt(prompt)?;
			},
			(None, Some(message)) => {
				let turn = current_turn(session)?;
				append_custom_message(session, turn, message)?;
			},
			(None, None) => {
				let mention_paths = parse_file_mentions(&input.text);
				if let Some(author) = author {
					session.user_authored(input.text, input.attachments, author)?;
				} else {
					session.user(input.text, input.attachments)?;
				}
				self.append_file_mentions(session, mention_paths).await?;
			},
			(Some(_), Some(_)) => unreachable!("one explicit turn source"),
		}
		self.apply_live_components(session)?;
		let turn = current_turn(session)?;
		let _activity = TurnActivity::enter(Arc::clone(&self.turn_active));
		let result = self
			.run_turn_body(session, turn, &turn_cancel, &control, None)
			.await;
		self.turn_active.store(false, Ordering::Release);
		self
			.settle_reply_obligations(session, &turn_cancel, &control)
			.await?;
		self.finish_turn(session, turn, &submission_id, result)
	}

	async fn settle_reply_obligations(
		&self,
		session: &mut Session,
		turn: &crate::TurnCancellation,
		run: &RunControl,
	) -> Result<(), KernelError> {
		if !self.reply_obligations.is_pending() {
			return Ok(());
		}
		let control = CallControl::new(
			self.mailbox_rx.clone(),
			turn.clone(),
			self.cancel.clone(),
			Some(run.clone()),
			self.approvals.clone(),
		);
		while self.reply_obligations.is_pending() {
			tokio::select! {
				() = self.reply_obligations.wait() => {},
				message = control.recv() => {
					if let Received::Rewound(work) = control.handle(session, message)? {
						self.dispatcher.jobs().apply_lifecycle(session, &work).await;
					}
				},
			}
		}
		Ok(())
	}

	/// Journals how a turn ended, publishes `TurnEnded`, re-derives host
	/// state, and emits `agent_end`.
	fn finish_turn(
		&mut self,
		session: &mut Session,
		turn: Handle,
		submission_id: &Str,
		result: Result<TurnOutcome, KernelError>,
	) -> Result<TurnOutcome, KernelError> {
		match &result {
			Err(error) => self.journal_turn_failure(session, turn, error),
			Ok(outcome) if outcome.stop == TurnStop::Cancelled => {
				self.journal_turn_interrupt(session, turn);
			},
			Ok(_) => {},
		}
		self.events.publish(KernelEvent::TurnEnded {
			stop: match &result {
				Ok(outcome) => outcome.stop,
				Err(_) => TurnStop::Failed,
			},
		});
		self.flush_session_state(session)?;
		self.resync_session_state(session);
		if let Some(hooks) = &self.lifecycle_hooks {
			let (stop, interrupted, error) = match &result {
				Ok(outcome) => (
					format!("{:?}", outcome.stop).to_ascii_lowercase(),
					outcome.stop == TurnStop::Cancelled,
					None,
				),
				Err(_) => ("error".to_owned(), false, Some("agent turn failed")),
			};
			hooks.notify(
				HookEventId::HookEventAgentEnd,
				serde_json::json!({
					"submission_id": submission_id,
					"summary": {
						"committed_turns": committed_requests(session, turn),
						"interrupted": interrupted,
						"stop": stop,
					},
					"continued": false,
					"error": error,
				}),
			)?;
		}
		result
	}

	/// Re-executes the last turn's aborted tool tail without a model round
	/// trip: the journal rewinds to just after the batch was authorized,
	/// abandoning aborted results and the interrupt notice so
	/// `replay(journal) == state` still holds. The same call ids and arguments
	/// are dispatched again, then the normal loop continues (steering,
	/// Directors, yield).
	pub async fn retry_tool_tail(
		&mut self,
		session: &mut Session,
		control: RunControl,
	) -> Result<TurnOutcome, KernelError> {
		if control.is_expired() || self.cancel.is_session_cancelled() {
			return Ok(cancelled_outcome());
		}
		let turn = current_turn(session).map_err(|_| KernelError::NothingToRetry)?;
		if !aborted_tool_tail(session.dom(), turn) {
			return Err(KernelError::NothingToRetry);
		}
		let target = session
			.tool_tail_retry_target()
			.ok_or(KernelError::NothingToRetry)?;
		self.flush_session_state(session)?;
		let work = session.rewind(target)?;
		self.dispatcher.jobs().apply_lifecycle(session, &work).await;
		self.resync_session_state(session);
		let turn = current_turn(session)?;
		let turn_cancel = self.cancel.begin_turn();
		let mut calls = Vec::new();
		for unsettled in session.unsettled_calls() {
			let identity = self
				.dispatcher
				.registry()
				.resolved_identity(unsettled.name.as_str())
				.ok_or_else(|| RegistryError::UnknownTool(unsettled.name.clone()))?;
			let cancellation =
				tool_cancellation(self.dispatcher.registry(), identity.name.as_str(), &turn_cancel)?;
			let args = match unsettled.args {
				Some(args) => args,
				None => RawValue::from_string("{}".to_owned())?,
			};
			if !unsettled.committed {
				session.call_ready(unsettled.entry, args.clone())?;
			}
			let mut prepared = self.dispatcher.prepare(
				identity,
				unsettled.call_id.clone(),
				unsettled.entry,
				cancellation,
			)?;
			prepared.arg_delta(args.get());
			prepared.commit(args);
			self.events.publish(KernelEvent::ToolReady {
				call_id: unsettled.call_id,
				name:    unsettled.name,
			});
			calls.push(prepared);
		}
		if calls.is_empty() {
			return Err(KernelError::NothingToRetry);
		}
		let submission_id = Str::new(target.to_string());
		let result = self
			.run_turn_body(session, turn, &turn_cancel, &control, Some(calls))
			.await;
		self.finish_turn(session, turn, &submission_id, result)
	}

	/// Records an interrupted turn in the tree (ADR 0004: lifecycle derives
	/// from the tree): an open assistant closes with `cancelled` and the turn
	/// ends with `<notice kind=warn>`, never a receipt or a false completion.
	fn journal_turn_interrupt(&mut self, session: &mut Session, turn: Handle) {
		match session.assistant_end("cancelled") {
			Ok(_) => {
				if let Err(error) = self.apply_live_components(session) {
					tracing::warn!(?error, "live Components failed after an assistant interrupt close");
				}
			},
			Err(SessionError::NoActiveAssistant) => {},
			Err(journal) => {
				tracing::warn!(error = ?journal, "failed to close the assistant after an interrupt");
			},
		}
		if let Err(journal) = append_interrupt_notice(session, turn) {
			tracing::warn!(error = ?journal, "failed to journal the turn interrupt notice");
		}
	}

	fn journal_turn_failure(&mut self, session: &mut Session, turn: Handle, error: &KernelError) {
		match session.assistant_end("error") {
			Ok(_) => {
				if let Err(error) = self.apply_live_components(session) {
					tracing::warn!(?error, "live Components failed after an assistant error close");
				}
			},
			Err(SessionError::NoActiveAssistant) => {},
			Err(journal) => {
				tracing::warn!(error = ?journal, "failed to close the assistant after a turn error");
			},
		}
		if let Err(journal) = append_error_notice(session, turn, Str::new(error_chain(error))) {
			tracing::warn!(error = ?journal, "failed to journal the turn error notice");
		}
	}

	async fn run_turn_body(
		&mut self,
		session: &mut Session,
		turn: Handle,
		turn_cancel: &crate::TurnCancellation,
		control: &RunControl,
		mut replay: Option<Vec<PreparedCall>>,
	) -> Result<TurnOutcome, KernelError> {
		let mut directors = DirectorStack::from_dom(session.dom(), &self.director_registry);
		if !self.runtime_flags.goal_enabled
			&& let Some((goal, _)) = crate::find_director(session.dom(), "goal")
		{
			session.patch(Txn {
				cause: session.head().ok_or(SessionError::NoActiveTurn)?,
				label: Some(Str::new_static("director.goal-disabled")),
				ops:   vec![omp_dom::Op::Rm(goal)],
			})?;
			directors = DirectorStack::from_dom(session.dom(), &self.director_registry);
		}
		if self.runtime_flags.automatic_compaction
			&& !directors.active_ids().contains(&"compaction")
			&& !directors.queued_ids().contains(&"compaction")
		{
			directors.engage(session, Box::new(CompactionDirector::new()))?;
		}
		let mut total_text = String::new();
		let mut tokens_in = 0_u64;
		let mut tokens_out = 0_u64;
		let mut was_steered = false;
		let mut empty_output_retries = 0_u8;
		let mut requests_started = 0_u32;
		let mut request_budget_notice_sent = false;
		let mut last_model: Option<Str> = None;
		let turn_started = Instant::now();

		loop {
			if control.is_expired() || turn_cancel.is_turn_cancelled() {
				self.notify_deadline_or_interrupt(session, turn, control, turn_started);
				turn_cancel.cancel_turn();
				return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
			}
			// Admission consumes already-queued control before checking the
			// journal-derived pause gate. Otherwise an immediately-ready
			// preflight/provider future can win both biased selects and start a
			// request ahead of a pause or session cancellation accepted earlier.
			let admission_cancelled = self.drain_admission_control(session, turn_cancel)?;
			if admission_cancelled {
				self.notify_interrupt(session, turn, "admission");
				return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
			}
			if self
				.hold_while_paused(session, turn_cancel, control)
				.await?
			{
				self.notify_deadline_or_interrupt(session, turn, control, turn_started);
				return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
			}
			let mut route = self.current_route();
			// A crash can land after the durable observation tick and before
			// its one-shot handoff tick. Re-offer that journaled state before
			// projecting another request so replay never runs an extra turn on
			// the prewalk model.
			let resumed_view = TurnView {
				turn,
				had_tool_calls: false,
				assistant_text: Str::new_static(""),
				stop_reason: Str::new_static(""),
			};
			let resumed_cx = DirectorCx::new(turn, &route);
			if directors.after_settled_turn(session, &resumed_cx, &resumed_view)? {
				self.flush_session_state(session)?;
				self.resync_session_state(session);
				self.apply_live_components(session)?;
				route = self.current_route();
			}
			// A settled background job or subagent re-wakes the loop with its
			// result before the next request as an async-result follow-up.
			if self.deliver_settlements(session, turn)? {
				self.apply_live_components(session)?;
			}
			let driven = if let Some(calls) = replay.take() {
				DrivenInference::replayed(calls)
			} else {
				if !control.permits_request(requests_started, request_budget_notice_sent) {
					append_named_notice(
						session,
						turn,
						Str::new_static("warn"),
						Some(Str::new_static("request-budget")),
						Str::new_static("Subagent request budget exhausted before another inference"),
					)?;
					self.apply_live_components(session)?;
					return Ok(outcome(TurnStop::Completed, total_text, tokens_in, tokens_out));
				}
				if control
					.should_emit_request_budget_notice(requests_started, request_budget_notice_sent)
				{
					append_named_notice(
						session,
						turn,
						Str::new_static("warn"),
						Some(Str::new_static("request-budget")),
						Str::new_static(
							"Soft request budget reached; use this final request to yield a concise \
							 result.",
						),
					)?;
					request_budget_notice_sent = true;
				}
				// Steering accepted before the request leaves is flushed into
				// context first, so the model never answers the stale request.
				if steering_pending(session) {
					was_steered = true;
					let _ = consume_steering(session, turn, self.steering_mode())?;
					self.apply_live_components(session)?;
				}
				self.flush_session_state(session)?;
				if let Some(con) = &self.con {
					directors.apply_binds(session.dom(), con);
				}
				let mut request = self.finish_request(self.project_request(session)?).await?;
				let model = self.client.selected_model();
				if let (Some(hooks), Some(previous), Some(current)) =
					(&self.lifecycle_hooks, &last_model, &model)
					&& previous != current
				{
					hooks.notify(
						HookEventId::HookEventModelChanged,
						serde_json::json!({
							"from_model": model_ref(Some(previous)),
							"to_model": model_ref(Some(current)),
							"role": "default",
							"reason": "convar",
							"previous_thinking": serde_json::Value::Null,
							"thinking": reasoning_effort(&request),
						}),
					)?;
				}
				last_model = model.clone();
				if let Some(hooks) = &self.lifecycle_hooks {
					let enabled_tools = request
						.tools
						.iter()
						.map(|tool| tool.name.clone())
						.collect::<Vec<_>>();
					let payload = hooks
						.gate(
							HookEventId::HookEventTurnStart,
							serde_json::json!({
								"turn_id": turn.to_string(),
								"turn_index": requests_started,
								"prompt_hash": prompt_hash(&request),
								"toolset_hash": toolset_hash(&enabled_tools),
								"enabled_tools": enabled_tools,
								"input_mode": "full",
								"model": model_ref(model.as_ref()),
								"route": {
									"provider": model.as_deref().and_then(|model| model.split_once('/')).map_or("", |(provider, _)| provider),
									"route": model.as_deref().unwrap_or(""),
								},
								"thinking": reasoning_effort(&request),
								"deadline": serde_json::Value::Null,
								"attempt": requests_started,
								"prompt_changed": requests_started == 0,
								"toolset_changed": requests_started == 0,
							}),
						)
						.await?;
					hooks.notify(HookEventId::HookEventTurnStart, payload.clone())?;
					if let Some(enabled) = payload
						.get("enabled_tools")
						.and_then(serde_json::Value::as_array)
					{
						request.tools = request
							.tools
							.iter()
							.filter(|tool| {
								enabled
									.iter()
									.any(|name| name.as_str() == Some(tool.name.as_str()))
							})
							.cloned()
							.collect::<Vec<_>>()
							.into();
					}
				}
				let preflight_control = CallControl::new(
					self.mailbox_rx.clone(),
					turn_cancel.clone(),
					self.cancel.clone(),
					Some(control.clone()),
					self.approvals.clone(),
				);
				let preflight = {
					let mut cx = MutDirectorCx {
						session,
						inference: &mut self.client,
						blobs: &self.dispatcher.policy().spill,
						route: &route,
						turn,
						director: None,
						events: Some(&self.events),
						con: self.con.as_deref(),
						hooks: self.lifecycle_hooks.as_ref(),
					};
					let preparing = directors.before_inference(&mut cx, &request);
					tokio::pin!(preparing);
					tokio::select! {
						biased;
						result = &mut preparing => PreflightSignal::Ready(result),
						() = control.cancelled() => PreflightSignal::Cancelled,
						message = preflight_control.recv() => PreflightSignal::Control(message),
					}
				};
				let prepared = match preflight {
					PreflightSignal::Ready(result) => result?,
					PreflightSignal::Cancelled => {
						self.notify_deadline_or_interrupt(session, turn, control, turn_started);
						turn_cancel.cancel_turn();
						return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
					},
					PreflightSignal::Control(message) => {
						match preflight_control.handle(session, message)? {
							Received::ToolScopedAbort(_) => {},
							Received::Cancelled => {
								self.notify_interrupt(session, turn, "immediate");
								return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
							},
							Received::Rewound(work) => {
								self.dispatcher.jobs().apply_lifecycle(session, &work).await;
								turn_cancel.cancel_turn();
								return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
							},
							Received::None
							| Received::Steering
							| Received::PauseChanged
							| Received::Approved(_) => {},
						}
						continue;
					},
				};
				self.apply_live_components(session)?;
				if prepared == Prepared::Rebuild {
					request = self.finish_request(self.project_request(session)?).await?;
					directors = DirectorStack::from_dom(session.dom(), &self.director_registry);
				}
				let director_cx = DirectorCx::new(turn, &route);
				directors.prepare_inference(session.dom(), &director_cx, &mut request);
				let request_started = Instant::now();
				requests_started = requests_started.saturating_add(1);
				let opening_control = CallControl::new(
					self.mailbox_rx.clone(),
					turn_cancel.clone(),
					self.cancel.clone(),
					Some(control.clone()),
					self.approvals.clone(),
				);
				let stream = {
					let hooks = self.lifecycle_hooks.clone();
					let opening = self.client.chat(request);
					tokio::pin!(opening);
					loop {
						tokio::select! {
							biased;
							result = &mut opening => break result?,
							() = control.cancelled() => {
								notify_deadline_or_interrupt(hooks.as_ref(), turn, control, turn_started);
								turn_cancel.cancel_turn();
								return Ok(outcome(
									TurnStop::Cancelled,
									total_text,
									tokens_in,
									tokens_out,
								));
							},
							message = opening_control.recv() => {
								match opening_control.handle(session, message)? {
									Received::ToolScopedAbort(_) => {},
									Received::Cancelled => {
										notify_interrupt(hooks.as_ref(), turn, "immediate");
										return Ok(outcome(
											TurnStop::Cancelled,
											total_text,
											tokens_in,
											tokens_out,
										));
									},
									Received::Rewound(work) => {
										self.dispatcher.jobs().apply_lifecycle(session, &work).await;
										turn_cancel.cancel_turn();
										return Ok(outcome(
											TurnStop::Cancelled,
											total_text,
											tokens_in,
											tokens_out,
										));
									},
									Received::None
									| Received::Steering
									| Received::PauseChanged
									| Received::Approved(_) => {},
								}
							},
						}
					}
				};
				let driven = self
					.drive_inference(session, stream, control, turn_cancel, request_started)
					.await?;
				tokens_in = tokens_in.saturating_add(driven.usage.input_tokens);
				tokens_out = tokens_out.saturating_add(driven.usage.output_tokens);
				total_text.push_str(driven.text.as_str());
				if driven.cancelled {
					self.notify_deadline_or_interrupt(session, turn, control, turn_started);
					return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
				}
				driven
			};
			let mut driven = driven;
			if self
				.hold_while_paused(session, turn_cancel, control)
				.await?
			{
				self.notify_deadline_or_interrupt(session, turn, control, turn_started);
				return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
			}
			let director_cx = DirectorCx::new(turn, &route);
			let had_tool_calls = driven.had_tool_calls;
			let mut settled_reports = Vec::new();
			if had_tool_calls {
				if let Some(hooks) = &self.lifecycle_hooks {
					for call in &driven.calls {
						hooks.notify(
							HookEventId::HookEventToolExecutionStart,
							serde_json::json!({
								"call_id": call.call_id(),
								"invocation_id": call.call_id(),
								"target": crate::dispatch::call_target(call),
								"place": {"kind": "host", "name": serde_json::Value::Null},
								"deadline": serde_json::Value::Null,
							}),
						)?;
					}
				}
				let settled_calls = driven
					.calls
					.iter()
					.map(|call| (call.call_id().clone(), crate::dispatch::call_target(call)))
					.collect::<Vec<_>>();
				let call_control = CallControl::new(
					self.mailbox_rx.clone(),
					turn_cancel.clone(),
					self.cancel.clone(),
					Some(control.clone()),
					self.approvals.clone(),
				);
				let reports = self
					.dispatcher
					.drive(session, std::mem::take(&mut driven.calls), Some(&call_control))
					.await?;
				self.apply_live_components(session)?;
				if let Some(hooks) = &self.lifecycle_hooks {
					for ((call_id, target), report) in settled_calls.iter().zip(&reports) {
						hooks.notify(
							HookEventId::HookEventToolExecutionEnd,
							serde_json::json!({
								"call_id": call_id,
								"target": target,
								"outcome": if report.is_error { "faulted" } else { "ok" },
								"duration": format!("{}ms", report.duration.as_millis()),
								"spilled": report.spilled.is_some(),
								"artifact": report.spilled.as_ref().map(|blob| {
									format!("artifact://sha256/{}", blob.to_hex())
								}),
								"effects_unknown": false,
							}),
						)?;
					}
				}
				settled_reports = settled_calls
					.into_iter()
					.zip(reports)
					.map(|((call_id, target), report)| {
						serde_json::json!({"call_id": call_id, "target": target, "is_error": report.is_error})
					})
					.collect();
			}
			let steering = self.drain_mailbox(session, turn_cancel).await?;
			if steering.cancelled {
				self.notify_interrupt(session, turn, "turn_boundary");
				return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
			}
			let steering_received = steering.received || steering_pending(session);
			if steering_received {
				was_steered = true;
				let _ = consume_steering(session, turn, self.steering_mode())?;
				self.apply_live_components(session)?;
			}
			let turn_view = TurnView {
				turn,
				had_tool_calls,
				assistant_text: driven.text,
				stop_reason: driven.stop_reason,
			};
			let terminal_tool_yield = turn_has_terminal_incremental_yield(session.dom(), turn);
			directors.observe_turn(session, &director_cx, &turn_view)?;
			self.apply_live_components(session)?;
			if let Some(hooks) = &self.lifecycle_hooks {
				hooks.notify(
					HookEventId::HookEventTurnEnd,
					serde_json::json!({
						"turn_id": turn.to_string(),
						"turn_index": requests_started.saturating_sub(1),
						"event_index": session.entry_count(),
						"stop": turn_view.stop_reason,
						"usage": usage_json(&driven.usage),
						"session_usage": session_usage_json(session, turn),
						"revision": session.head().map(|id| id.to_string()),
						"calls": settled_reports,
						"items": [],
					}),
				)?;
			}
			if turn_view.had_tool_calls
				&& directors.after_settled_turn(session, &director_cx, &turn_view)?
			{
				self.flush_session_state(session)?;
				self.resync_session_state(session);
				self.apply_live_components(session)?;
			}
			if (turn_view.had_tool_calls && !terminal_tool_yield) || steering_received {
				continue;
			}
			if !terminal_tool_yield && turn_view.stop_reason == PAUSED_TURN_KIND {
				// A canonical `pause_turn` is a provider-declared scheduling
				// pause, not a candidate yield. Re-sample only after the safe
				// mailbox boundary above: steering/cancellation wins, global
				// pause has been released, and a queued follow-up prevents this
				// turn from claiming another request. The count is re-derived
				// from durable assistant evidence, never kept as shadow state.
				let paused_turn_continuations = paused_turn_continuation_count(session.dom(), turn);
				if queued_follow_up(session.dom()) {
					record_paused_turn_decision(
						session,
						turn,
						paused_turn_continuations,
						"pending-input",
					)?;
					self.apply_live_components(session)?;
					// The queued prompt is a user-owned next turn, not a
					// candidate yield for Directors or stop hooks to consume.
					return Ok(outcome(
						if was_steered {
							TurnStop::Steered
						} else {
							TurnStop::Completed
						},
						total_text,
						tokens_in,
						tokens_out,
					));
				} else if paused_turn_continuations < PAUSED_TURN_CONTINUATION_CAP {
					let attempt = paused_turn_continuations.saturating_add(1);
					record_paused_turn_decision(session, turn, attempt, "scheduled")?;
					self.apply_live_components(session)?;
					// Scripted/local providers may resolve synchronously. Yield
					// once so even those continuations cannot monopolize the
					// controller between mailbox safe points.
					tokio::task::yield_now().await;
					continue;
				}
				record_paused_turn_decision(session, turn, paused_turn_continuations, "capped")?;
				self.apply_live_components(session)?;
			}
			if turn_view.assistant_text.is_empty()
				&& !terminal_tool_yield
				&& turn_view.stop_reason != PAUSED_TURN_KIND
			{
				if empty_output_retries < EMPTY_OUTPUT_RETRY_CAP {
					empty_output_retries = empty_output_retries.saturating_add(1);
					append_empty_output_retry(session, turn, empty_output_retries)?;
					self.apply_live_components(session)?;
					continue;
				}
				append_empty_output_cap_notice(session, turn)?;
				self.apply_live_components(session)?;
			}
			if !terminal_tool_yield
				&& self.runtime_flags.autolearn_enabled
				&& should_schedule_autolearn(
					session.dom(),
					turn,
					self.runtime_flags.autolearn_min_tool_calls,
				) && self
				.dispatcher
				.registry()
				.resolved_identity("learn")
				.is_some()
			{
				directors.engage(
					session,
					Box::new(crate::directors::force_tool::ForceTool::new(
						"learn",
						crate::ForceUntil::ToolCalled(Str::new_static("learn")),
						Some(Str::new_static(
							"Capture the substantive work from this turn with the learn tool.",
						)),
						1,
					)),
				)?;
				self.apply_live_components(session)?;
				continue;
			}
			// Owned background work still running makes this candidate yield a
			// scheduling pause, not a stop. The turn waits for the first
			// settlement (or steering / an
			// interrupt) and re-enters with the async-result follow-up.
			if crate::jobs::pending_wake(session.dom()) {
				match self.await_settlement(session, turn_cancel, control).await? {
					Awaited::Settled => continue,
					Awaited::Steering => {
						was_steered = true;
						let _ = consume_steering(session, turn, self.steering_mode())?;
						self.apply_live_components(session)?;
						continue;
					},
					Awaited::Cancelled => {
						self.notify_interrupt(session, turn, "idle");
						return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
					},
				}
			}
			// Cold candidate-yield hooks (the advisor's second-model review)
			// run under the same turn control as the pre-inference hooks: an
			// interrupt drops the review mid-flight.
			let yield_control = CallControl::new(
				self.mailbox_rx.clone(),
				turn_cancel.clone(),
				self.cancel.clone(),
				Some(control.clone()),
				self.approvals.clone(),
			);
			let reviewed = {
				let mut cx = MutDirectorCx {
					session,
					inference: &mut self.client,
					blobs: &self.dispatcher.policy().spill,
					route: &route,
					turn,
					director: None,
					events: Some(&self.events),
					con: self.con.as_deref(),
					hooks: self.lifecycle_hooks.as_ref(),
				};
				let reviewing = directors.before_yield(&mut cx, &turn_view);
				tokio::pin!(reviewing);
				tokio::select! {
					biased;
					result = &mut reviewing => PreflightSignal::Ready(result),
					() = control.cancelled() => PreflightSignal::Cancelled,
					message = yield_control.recv() => PreflightSignal::Control(message),
				}
			};
			match reviewed {
				PreflightSignal::Ready(result) => result?,
				PreflightSignal::Cancelled => {
					self.notify_interrupt(session, turn, "idle");
					return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
				},
				PreflightSignal::Control(message) => match yield_control.handle(session, message)? {
					Received::ToolScopedAbort(_) => {},
					Received::Cancelled => {
						self.notify_interrupt(session, turn, "idle");
						return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
					},
					Received::Rewound(work) => {
						self.dispatcher.jobs().apply_lifecycle(session, &work).await;
						turn_cancel.cancel_turn();
						return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
					},
					Received::None
					| Received::Steering
					| Received::PauseChanged
					| Received::Approved(_) => {},
				},
			}
			if self
				.hold_while_paused(session, turn_cancel, control)
				.await?
			{
				self.notify_deadline_or_interrupt(session, turn, control, turn_started);
				return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
			}
			self.apply_live_components(session)?;
			let decision = directors.on_yield(session, &director_cx, &turn_view)?;
			self.apply_live_components(session)?;
			// A Director may have committed session-layer convar writes (a
			// plan handoff re-targeting `ai_model`): journal what the console
			// has pending, then re-derive the console from the tree.
			self.flush_session_state(session)?;
			self.resync_session_state(session);
			let late = self.drain_mailbox(session, turn_cancel).await?;
			if late.cancelled {
				self.notify_interrupt(session, turn, "idle");
				return Ok(outcome(TurnStop::Cancelled, total_text, tokens_in, tokens_out));
			}
			if late.received || steering_pending(session) {
				was_steered = true;
				let _ = consume_steering(session, turn, self.steering_mode())?;
				self.apply_live_components(session)?;
				continue;
			}
			match decision {
				LoopDecision::Continue { .. } => continue,
				LoopDecision::Yield => {
					// An extension may block the stop and demand another turn.
					if let Some(hooks) = &self.lifecycle_hooks
						&& hooks
							.agent_settled(serde_json::json!({
								"submission_id": turn.to_string(),
								"reason": if was_steered { "stop" } else { "stop" },
								"committed_turns": requests_started,
								"last_stop": turn_view.stop_reason,
								"pending_jobs": self.dispatcher.jobs().list().iter().map(|job| job.id.clone()).collect::<Vec<_>>(),
								"continuations_used": 0,
								"incomplete_todos": [],
							}))
							.await == crate::AgentSettled::Continue
					{
						continue;
					}
					let stop = if was_steered {
						TurnStop::Steered
					} else {
						TurnStop::Completed
					};
					return Ok(outcome(stop, total_text, tokens_in, tokens_out));
				},
			}
		}
	}

	/// The effective steering pacing (`ai_steering_mode`).
	fn steering_mode(&self) -> crate::SteeringMode {
		self
			.con
			.as_deref()
			.map_or_else(crate::SteeringMode::default, |con| crate::AI_STEERING_MODE.get(con))
	}

	/// Journals every finished owned job and injects the async-result follow-up
	/// for settlements the model has not seen. Returns whether anything was
	/// delivered.
	fn deliver_settlements(
		&mut self,
		session: &mut Session,
		turn: Handle,
	) -> Result<bool, KernelError> {
		if self.dispatcher.jobs().has_finished_units() {
			self.dispatcher.jobs().poll(session)?;
			self.apply_live_components(session)?;
		}
		let undelivered = crate::jobs::undelivered(session.dom());
		if undelivered.is_empty() {
			return Ok(false);
		}
		let mut rendered = Vec::with_capacity(undelivered.len());
		for record in &undelivered {
			rendered.push((record.id.clone(), record.label.clone(), settlement_text(record)));
		}
		let body = async_result_notice(&rendered);
		let delivery = AsyncResult { jobs: undelivered.iter().map(async_job_delivery).collect() };
		let data = serde_json::value::to_raw_value(&delivery)?;
		let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
		let mut ops = Vec::with_capacity(undelivered.len() + 1);
		ops.push(Op::Ins {
			parent: turn,
			after:  session.dom().children(turn).last().copied(),
			node:   NodeSpec::new(KnownTag::User)
				.with_prop(PropKey::Custom(Str::new_static("async_result")), Value::Bool(true))
				.with_prop(PropId::Data, Value::Json(data))
				.with_content(Str::new(body)),
		});
		ops.extend(undelivered.iter().map(|record| Op::Set {
			h:     record.handle,
			prop:  PropKey::Custom(Str::new_static(crate::jobs::DELIVERED)),
			value: Value::Bool(true),
		}));
		// The notice and every delivery marker are one journal entry. Replay
		// can therefore observe both or neither, never a notice that gets
		// delivered a second time after a crash.
		session.patch(Txn { cause, label: Some(Str::new_static("jobs.async-result")), ops })?;
		self.events.publish(KernelEvent::JobsDelivered {
			ids: undelivered.into_iter().map(|record| record.id).collect(),
		});
		Ok(true)
	}

	/// Idles the turn until an owned job finishes, steering arrives, or the
	/// turn is interrupted.
	async fn await_settlement(
		&mut self,
		session: &mut Session,
		turn_cancel: &crate::TurnCancellation,
		control: &RunControl,
	) -> Result<Awaited, KernelError> {
		let call_control = CallControl::new(
			self.mailbox_rx.clone(),
			turn_cancel.clone(),
			self.cancel.clone(),
			Some(control.clone()),
			self.approvals.clone(),
		);
		loop {
			let jobs = Arc::clone(self.dispatcher.jobs());
			let signal = tokio::select! {
				biased;
				() = control.cancelled() => AwaitSignal::Cancelled,
				message = call_control.recv() => AwaitSignal::Control(message),
				() = jobs.any_finished() => AwaitSignal::Finished,
			};
			match signal {
				AwaitSignal::Cancelled => {
					turn_cancel.cancel_turn();
					return Ok(Awaited::Cancelled);
				},
				AwaitSignal::Finished => return Ok(Awaited::Settled),
				AwaitSignal::Control(message) => match call_control.handle(session, message)? {
					Received::ToolScopedAbort(_) => {},
					Received::Cancelled => return Ok(Awaited::Cancelled),
					Received::Rewound(work) => {
						self.dispatcher.jobs().apply_lifecycle(session, &work).await;
						turn_cancel.cancel_turn();
						return Ok(Awaited::Cancelled);
					},
					Received::Steering => return Ok(Awaited::Steering),
					Received::None | Received::PauseChanged | Received::Approved(_) => {
						if !crate::jobs::pending_wake(session.dom()) {
							return Ok(Awaited::Settled);
						}
					},
				},
			}
		}
	}

	fn notify_interrupt(&self, _session: &Session, turn: Handle, drain_point: &str) {
		notify_interrupt(self.lifecycle_hooks.as_ref(), turn, drain_point);
	}

	fn notify_deadline_or_interrupt(
		&self,
		_session: &Session,
		turn: Handle,
		control: &RunControl,
		turn_started: Instant,
	) {
		notify_deadline_or_interrupt(self.lifecycle_hooks.as_ref(), turn, control, turn_started);
	}
}

/// Emits the `interrupt` observation for a cancellation drained at a
/// mailbox boundary.
fn notify_interrupt(hooks: Option<&crate::LifecycleHooks>, turn: Handle, drain_point: &str) {
	let Some(hooks) = hooks else {
		return;
	};
	{
		let _ = hooks.notify(
			HookEventId::HookEventInterrupt,
			serde_json::json!({
				"source": "user",
				"reason": "interrupt",
				"klass": drain_point,
				"drain_point": drain_point,
				"turn_id": turn.to_string(),
			}),
		);
	}
}

/// Emits `deadline` when the turn's budget expired, else `interrupt`
/// for an external cancellation.
fn notify_deadline_or_interrupt(
	hooks: Option<&crate::LifecycleHooks>,
	turn: Handle,
	control: &RunControl,
	turn_started: Instant,
) {
	let Some(hooks) = hooks else {
		return;
	};
	{
		if let Some(deadline) = control.deadline
			&& Instant::now() >= deadline
		{
			let _ = hooks.notify(
				HookEventId::HookEventDeadline,
				serde_json::json!({
					"scope": "turn",
					"elapsed": format!("{}ms", turn_started.elapsed().as_millis()),
					"budget": format!("{}ms", deadline.saturating_duration_since(turn_started).as_millis()),
					"turn_id": turn.to_string(),
					"call_id": serde_json::Value::Null,
				}),
			);
		} else {
			notify_interrupt(Some(hooks), turn, "immediate");
		}
	}
}

impl<C: Inference> Kernel<C> {
	/// Dispatches one ready call and journals its outcome. The mailbox stays
	/// live while the tool runs: an interrupt cancels the turn scope the tool
	/// observes instead of waiting for the tool to finish on its own; steering
	/// arriving meanwhile lands in
	/// `streamed_steering` for the next safe point.
	pub(crate) async fn dispatch_call(
		&mut self,
		session: &mut Session,
		call: ReadyCall,
		turn_cancel: &crate::TurnCancellation,
		control: &RunControl,
		streamed_steering: &mut Vec<(Str, Vec<Attachment>)>,
	) -> Result<bool, KernelError> {
		let cancellation =
			tool_cancellation(self.dispatcher.registry(), call.identity.name.as_str(), turn_cancel)?;
		let call_id = call.call_id;
		let mut prepared =
			self
				.dispatcher
				.prepare(call.identity, call_id, call.entry, cancellation)?;
		prepared.commit(call.args);
		let call_control = CallControl::new(
			self.mailbox_rx.clone(),
			turn_cancel.clone(),
			self.cancel.clone(),
			Some(control.clone()),
			self.approvals.clone(),
		);
		let mut reports = self
			.dispatcher
			.drive(session, vec![prepared], Some(&call_control))
			.await?;
		let report = reports.remove(0);
		if steering_pending(session) {
			streamed_steering.extend(crate::steering::queued_steering(session));
		}
		self.apply_live_components(session)?;
		Ok(report.is_error)
	}

	/// Catalog facts for the route the next request targets: the live
	/// selection when inference resolves `ai_model` per request, else the
	/// facts fixed at composition.
	pub(crate) fn current_route(&self) -> RouteFacts {
		self.client.route_facts().unwrap_or(self.route)
	}

	/// The `thread_projection` gate over an owned projection, then the
	/// request assembly. The projection ([`Self::project_request`]) is
	/// synchronous over the session so no session borrow crosses the hook
	/// await (`Session` is not `Sync`).
	async fn finish_request(&self, projected: ProjectedRequest) -> Result<ChatRequest, KernelError> {
		let ProjectedRequest { facts, mut messages, tools } = projected;
		// `thread_projection` (Python `ContextView` → `ContextPatch`): an
		// extension edits this request's working copy of the projection;
		// the journal and DOM stay untouched.
		if let Some(hooks) = &self.lifecycle_hooks {
			let outcome = crate::context::gate_thread_projection(hooks, &facts, &mut messages).await?;
			if outcome.applied > 0 {
				tracing::debug!(
					applied = outcome.applied,
					note = outcome.note.as_deref().unwrap_or(""),
					"thread_projection patched the request projection"
				);
			}
		}
		Ok(ChatRequest {
			messages:          messages.into(),
			tools:             tools.into(),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::<[SafetySetting]>::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		})
	}

	/// Projects the session into the working copy of the next request.
	fn project_request(&self, session: &Session) -> Result<ProjectedRequest, KernelError> {
		let route = self.current_route();
		let mut items = self
			.prompt
			.system_items(session.dom())
			.map_err(KernelError::Prompt)?;
		// `ai_prompt_mode` is the engagement layer a mode Director binds
		// (plan, vibe, autoresearch); the mode prompt joins the stable band
		// right after the projected system prompt.
		if let Some(text) = self
			.con
			.as_deref()
			.map(|con| crate::AI_PROMPT_MODE.get(con))
			.filter(|mode| !mode.is_empty())
			.and_then(|mode| crate::directors::mode_prompt(mode.as_str()))
		{
			items.push(Item {
				kind: Some(item::Kind::Message(Message {
					role: Role::System as i32,
					parts: vec![ThreadPart { kind: Some(part::Kind::Text(text.to_owned())) }],
					..Default::default()
				})),
				..Default::default()
			});
		}
		items.extend(crate::prompt::project_thread_with_attachments(session.dom(), session.blobs())?);
		let mut messages = InferenceMessage::from_thread_items(&items)?;
		crate::events::strip_unsigned_reasoning(&mut messages);
		crate::vision::apply(session.dom(), &route, &mut messages);
		let facts = crate::context::ContextFacts {
			session_id:         session
				.journal_path()
				.file_stem()
				.and_then(|stem| stem.to_str())
				.map_or_else(Str::default, Str::new),
			turn_id:            current_turn(session)
				.map(|turn| Str::new(turn.to_string()))
				.unwrap_or_default(),
			model:              self.client.selected_model().unwrap_or_default(),
			epoch:              u64::try_from(session.dom().count("compaction").unwrap_or(0))
				.unwrap_or(u64::MAX),
			context_window:     route.context_window,
			threshold_fraction: self
				.con
				.as_deref()
				.map_or(0.8, |con| crate::AI_COMPACT_THRESHOLD.get(con)),
			prompt_hash:        Str::new(prompt_hash_of(&messages)),
			prompt_head_tokens: crate::context::prompt_head_tokens(&messages),
		};
		let caps = route.lowering_caps();
		let registry = self.dispatcher.registry();
		let goal_visible = self.runtime_flags.goal_enabled
			&& crate::find_director(session.dom(), "goal").is_some_and(|(_, node)| {
				crate::director_status(node) == Some("active")
					&& !crate::state_bool(node, "done").unwrap_or(false)
					&& !crate::state_bool(node, "dropped").unwrap_or(false)
			});
		let mut tools = registry.advertise(caps)?;
		tools.retain(|tool| tool.definition.name.as_str() != "goal" || goal_visible);
		// `sv_tools` is the effective roster: the user's allowlist or a mode
		// Director's bind (plan/vibe restrict what the model may call).
		if let Some(roster) = crate::tool_allowlist(self.con.as_deref()) {
			tools.retain(|tool| roster.contains(&tool.definition.name));
		}
		// Goal engagement mounts its hidden lifecycle tool in addition to the
		// user's ordinary roster; pause, completion, drop, rewind, and resume
		// all re-derive this decision from the selected branch.
		if goal_visible
			&& !tools
				.iter()
				.any(|tool| tool.definition.name.as_str() == "goal")
		{
			tools.extend(registry.advertise_selected(caps, &[Str::new_static("goal")])?);
		}
		// When provider reasoning is off, advertise the hidden `think` slot so
		// the model reasons through a tool.
		if self
			.con
			.as_deref()
			.is_some_and(|con| omp_ai::settings::AI_EXTERNAL_THINKING.get(con))
			&& !tools
				.iter()
				.any(|tool| tool.definition.name.as_str() == "think")
		{
			tools.extend(registry.advertise_selected(caps, &[Str::new_static("think")])?);
		}
		let tools = tools
			.into_iter()
			.map(|tool| tool.definition)
			.collect::<Vec<_>>();
		Ok(ProjectedRequest { facts, messages, tools })
	}

	async fn drive_inference(
		&mut self,
		session: &mut Session,
		mut stream: ChatStream,
		control: &RunControl,
		turn_cancel: &crate::TurnCancellation,
		request_started: Instant,
	) -> Result<DrivenInference, KernelError> {
		let mut assistant = None;
		let mut content_streams = FastHashMap::<u32, u32>::default();
		let mut pending = FastHashMap::<u32, StreamingCall>::default();
		let mut ready = Vec::<IndexedPreparedCall>::new();
		let mut text = String::new();
		let mut usage = Usage::default();
		let mut stop_reason = Str::new_static("stop");
		let mut completed = false;
		let mut had_tool_calls = false;
		let call_control = CallControl::new(
			self.mailbox_rx.clone(),
			turn_cancel.clone(),
			self.cancel.clone(),
			Some(control.clone()),
			self.approvals.clone(),
		);
		// First visible or reasoning byte (or the first streamed tool-call
		// fragment) after the request left the kernel.
		let mut first_token: Option<Instant> = None;
		let fold: Result<Fold, KernelError> = async {
			loop {
				let signal = tokio::select! {
					biased;
					() = control.cancelled() => StreamSignal::Cancelled,
					message = self.mailbox_rx.recv_async() => StreamSignal::Control(message.ok()),
					event = stream.next() => StreamSignal::Event(event),
				};
				let event = match signal {
					StreamSignal::Cancelled => {
						turn_cancel.cancel_turn();
						return Ok(Fold::Cancelled);
					},
					StreamSignal::Control(Some(message)) => {
						match call_control.handle(session, message)? {
							Received::Cancelled => return Ok(Fold::Cancelled),
							Received::ToolScopedAbort(reason) => {
								turn_cancel.cancel_turn();
								return Ok(Fold::ToolScopedAbort(reason));
							},
							Received::Rewound(work) => {
								self.dispatcher.jobs().apply_lifecycle(session, &work).await;
								turn_cancel.cancel_turn();
								return Ok(Fold::Cancelled);
							},
							Received::None
							| Received::Steering
							| Received::PauseChanged
							| Received::Approved(_) => {},
						}
						continue;
					},
					StreamSignal::Control(None) => continue,
					StreamSignal::Event(Some(event)) => event?,
					StreamSignal::Event(None) => break Ok(Fold::Ended),
				};
				match event {
					ChatEvent::Started(meta) => {
						let model = meta
							.model
							.map_or_else(|| Str::new_static("unknown"), |value| Str::new(&value));
						session.assistant_start(
							model,
							Str::new(&meta.provider),
							Str::new(&meta.route),
						)?;
						self.apply_live_components(session)?;
						assistant = Some(current_assistant(session)?);
						if let (Some(hooks), Some(item)) = (&self.lifecycle_hooks, assistant) {
							hooks.notify(
								HookEventId::HookEventMessageStart,
								serde_json::json!({
									"turn_id": current_turn(session)?.to_string(),
									"item_id": item.to_string(),
									"role": "assistant",
									"index": 0,
								}),
							)?;
						}
						self.events.publish(KernelEvent::InferenceStarted);
					},
					ChatEvent::BlockStarted { index, kind } => match kind {
						BlockKind::Text => {
							content_sid(session, assistant, &mut content_streams, index, "text")?;
							self.apply_live_components(session)?;
						},
						BlockKind::Thinking => {
							content_sid(session, assistant, &mut content_streams, index, "thinking")?;
							self.apply_live_components(session)?;
						},
						BlockKind::ToolCall | BlockKind::Artifact => {},
					},
					ChatEvent::TextDelta { index, text: delta } => {
						first_token.get_or_insert_with(Instant::now);
						let sid = content_sid(session, assistant, &mut content_streams, index, "text")?;
						session.stream_append(sid, delta.as_str())?;
						self.apply_live_components(session)?;
						self.events.publish(KernelEvent::TextDelta(delta.clone()));
						text.push_str(delta.as_str());
						if let (Some(hooks), Some(item)) = (&self.lifecycle_hooks, assistant) {
							hooks.notify(
								HookEventId::HookEventMessageUpdate,
								serde_json::json!({
									"turn_id": current_turn(session)?.to_string(),
									"item_id": item.to_string(),
									"part_index": index,
									"kind": "text",
									"delta": delta,
									"coalesced": 1,
									"total_chars": text.chars().count(),
								}),
							)?;
						}
					},
					ChatEvent::ThinkingDelta { index, text: delta } => {
						first_token.get_or_insert_with(Instant::now);
						let sid =
							content_sid(session, assistant, &mut content_streams, index, "thinking")?;
						session.stream_append(sid, delta.as_str())?;
						self.apply_live_components(session)?;
						if let (Some(hooks), Some(item)) = (&self.lifecycle_hooks, assistant) {
							hooks.notify(
								HookEventId::HookEventMessageUpdate,
								serde_json::json!({
									"turn_id": current_turn(session)?.to_string(),
									"item_id": item.to_string(),
									"part_index": index,
									"kind": "reasoning",
									"delta": delta,
									"coalesced": 1,
									"total_chars": 0,
								}),
							)?;
						}
						self.events.publish(KernelEvent::ThinkingDelta(delta));
					},
					ChatEvent::ToolCallStarted { index, id, name } => {
						first_token.get_or_insert_with(Instant::now);
						let identity = self
							.dispatcher
							.registry()
							.resolved_identity(name.as_str())
							.ok_or_else(|| RegistryError::UnknownTool(name.clone()))?;
						let (entry, sid) = session.call_streaming(
							name.clone(),
							crate::journal_revision(&identity.rev),
							Str::new(&id),
							None,
						)?;
						record_provider_tool_index(session, entry, index)?;
						self.apply_live_components(session)?;
						let call_id = Str::new(&id);
						let cancellation = tool_cancellation(
							self.dispatcher.registry(),
							identity.name.as_str(),
							turn_cancel,
						)?;
						let prepared = self.dispatcher.prepare(
							identity.clone(),
							call_id.clone(),
							entry,
							cancellation,
						)?;
						if let Some(hooks) = &self.lifecycle_hooks {
							hooks.notify(
								HookEventId::HookEventCallOpen,
								serde_json::json!({
									"call_id": call_id,
									"target": {
										"kind": "core",
										"name": identity.name,
										"rev": format!("{}@{}", identity.rev.family, identity.rev.n),
										"args": {},
									},
									"kind": "core",
									"turn_id": current_turn(session)?.to_string(),
									"place": {"kind": "host", "name": serde_json::Value::Null},
								}),
							)?;
						}
						pending.insert(index, StreamingCall {
							entry,
							sid,
							identity,
							call_id,
							prepared,
							raw_args: String::new(),
						});
					},
					ChatEvent::ToolArgumentsDelta { index, bytes } => {
						let call = pending
							.get_mut(&index)
							.ok_or(KernelError::ToolCallMismatch)?;
						let fragment = std::str::from_utf8(&bytes)
							.map_err(|source| KernelError::ToolArgumentUtf8 { source })?;
						session.stream_append(call.sid, fragment)?;
						call.raw_args.push_str(fragment);
						call.prepared.arg_delta(fragment);
						self.apply_live_components(session)?;
						let abort_invalid_edit = streamed_edit_must_abort(
							self.con.as_deref(),
							call.identity.name.as_str(),
							&call.raw_args,
						);
						if abort_invalid_edit {
							let reason = crate::ToolScopedAbortReason::one(
								call.call_id.clone(),
								Str::new_static(
									"streamed edit arguments became irrecoverably invalid before commit",
								),
								Str::new_static("another tool call interrupted the inference request"),
							);
							turn_cancel.cancel_turn();
							return Ok(Fold::ToolScopedAbort(reason));
						}
					},
					ChatEvent::ToolCallReady { index, call } => {
						had_tool_calls = true;
						let args = serde_json::value::to_raw_value(call.arguments.as_value())?;
						let (entry, identity, mut prepared) = if let Some(streaming) =
							pending.remove(&index)
						{
							if call.id != streaming.call_id.as_str()
								|| streaming.identity.name != call.name
							{
								return Err(KernelError::ToolCallMismatch);
							}
							(streaming.entry, streaming.identity, streaming.prepared)
						} else {
							let identity = self
								.dispatcher
								.registry()
								.resolved_identity(call.name.as_str())
								.ok_or_else(|| RegistryError::UnknownTool(call.name.clone()))?;
							let intent = call
								.arguments
								.as_value()
								.get("i")
								.and_then(serde_json::Value::as_str)
								.map(Str::new);
							let call_id = Str::new(&call.id);
							let (entry, _) = session.call_streaming(
								call.name.clone(),
								crate::journal_revision(&identity.rev),
								call_id.clone(),
								intent,
							)?;
							record_provider_tool_index(session, entry, index)?;
							self.apply_live_components(session)?;
							let cancellation = tool_cancellation(
								self.dispatcher.registry(),
								identity.name.as_str(),
								turn_cancel,
							)?;
							let prepared =
								self
									.dispatcher
									.prepare(identity.clone(), call_id, entry, cancellation)?;
							(entry, identity, prepared)
						};
						let call_id = Str::new(&call.id);
						let denied_args = args.clone();
						let session_id = session
							.journal_path()
							.file_stem()
							.and_then(|value| value.to_str())
							.map_or_else(|| Str::new_static("session"), Str::new);
						let turn_id = current_turn(session).map_or_else(
							|_| Str::new_static("turn"),
							|handle| Str::new(handle.to_string()),
						);
						let (identity, args, approvals) = match Self::gate_tool_call(
							self.lifecycle_hooks.clone(),
							Arc::clone(self.dispatcher.registry()),
							&session_id,
							&turn_id,
							&identity,
							&call_id,
							args,
						)
						.await
						{
							ToolGate::Allow { identity, args, approvals } => (identity, args, approvals),
							ToolGate::Deny(reason) => {
								session.call_ready(entry, denied_args.clone())?;
								prepared.commit(denied_args);
								self
									.dispatcher
									.abort_prepared(session, prepared, Abort::Skipped { reason })?;
								self.apply_live_components(session)?;
								continue;
							},
						};
						session.call_ready(entry, args.clone())?;
						self.apply_live_components(session)?;
						if prepared.identity().name != identity.name || args.get() != denied_args.get() {
							prepared.discard();
							let cancellation = tool_cancellation(
								self.dispatcher.registry(),
								identity.name.as_str(),
								turn_cancel,
							)?;
							prepared = self.dispatcher.prepare(
								identity.clone(),
								call_id.clone(),
								entry,
								cancellation,
							)?;
							prepared.arg_delta(args.get());
						}
						prepared.require_approvals(approvals);
						prepared.commit(args);
						self.events.publish(KernelEvent::ToolReady {
							call_id: call_id.clone(),
							name:    identity.name.clone(),
						});
						ready.push(IndexedPreparedCall { index, call: prepared });
					},
					ChatEvent::Usage(update) => {
						usage = update.usage;
						self.events.publish(KernelEvent::Usage {
							output_tokens:    usage.output_tokens,
							reasoning_tokens: usage.reasoning_tokens,
						});
					},
					ChatEvent::Completed(completion) => {
						close_streams(session, &mut content_streams)?;
						self.apply_live_components(session)?;
						stop_reason = finish_reason(&completion.reason);
						if self.runtime_flags.recover_inline_edits
							&& matches!(completion.reason, FinishReason::Stop)
							&& pending.is_empty()
							&& ready.is_empty()
							&& let Some(identity) = self.dispatcher.registry().resolved_identity("edit")
							&& identity.rev.family.as_str() == "sloppy"
							&& let Some((remaining, input, _regions)) =
								recover_inline_sloppy_edits(session, assistant)?
						{
							text = remaining;
							let args =
								serde_json::value::to_raw_value(&serde_json::json!({"input": input}))?;
							let call_id = Str::new(format!(
								"inline-edit-{}",
								session.head().ok_or(SessionError::NoActiveTurn)?
							));
							let entry = session.call(
								"edit",
								crate::journal_revision(&identity.rev),
								call_id.clone(),
								None,
								Some(args.clone()),
								None,
							)?;
							let cancellation =
								tool_cancellation(self.dispatcher.registry(), "edit", turn_cancel)?;
							let mut prepared =
								self
									.dispatcher
									.prepare(identity, call_id.clone(), entry, cancellation)?;
							prepared.arg_delta(args.get());
							prepared.commit(args);
							ready.push(IndexedPreparedCall { index: u32::MAX, call: prepared });
							had_tool_calls = true;
							self
								.events
								.publish(KernelEvent::ToolReady { call_id, name: Str::new_static("edit") });
						}
						usage = completion.usage;
						session.assistant_end(stop_reason.clone())?;
						self.apply_live_components(session)?;
						if let (Some(hooks), Some(item)) = (&self.lifecycle_hooks, assistant) {
							hooks.notify(
								HookEventId::HookEventMessageEnd,
								serde_json::json!({
									"turn_id": current_turn(session)?.to_string(),
									"item_id": item.to_string(),
									"role": "assistant",
									"parts": completion.blocks,
									"finish": if matches!(completion.reason, FinishReason::Length) {
										"truncated"
									} else if matches!(completion.reason, FinishReason::Cancelled) {
										"interrupted"
									} else {
										"complete"
									},
								}),
							)?;
						}
						session.receipt(receipt_facts(
							&usage,
							cost_nano_usd(&completion),
							request_started,
							first_token,
							&completion.receipt.recoveries,
						))?;
						self.apply_live_components(session)?;
						completed = true;
						break Ok(Fold::Ended);
					},
					ChatEvent::Artifact { index, artifact } => {
						let media_type = artifact.media_type.clone();
						let blobs = session.blobs().clone();
						let blob = Self::artifact_blob(&blobs, artifact).await?;
						let uri = Str::new(format!("artifact://sha256/{}", blob.to_hex()));
						let assistant = assistant.ok_or(KernelError::MissingResponseStart)?;
						let kind = if media_type.starts_with("image/") {
							"image"
						} else if media_type.starts_with("video/") {
							"video"
						} else if media_type.starts_with("audio/") {
							"audio"
						} else {
							"file"
						};
						let mut node = NodeSpec::new(Tag::Custom(Str::new_static("artifact")))
							.with_prop(PropId::Blob, Value::Str(uri))
							.with_prop(PropId::Mime, Value::Str(media_type))
							.with_prop(PropId::Kind, Value::Str(Str::new_static(kind)))
							.with_prop(
								PropKey::Custom(Str::new_static(omp_session::PROVIDER_BLOCK_INDEX_PROP)),
								Value::Int(i64::from(index)),
							);
						node = node.with_prop(
							PropKey::Custom(Str::new_static("size")),
							Value::Int(i64::try_from(blob.size).unwrap_or(i64::MAX)),
						);
						session.patch(Txn {
							cause: session.head().ok_or(SessionError::NoActiveTurn)?,
							label: Some(Str::new_static("assistant.artifact")),
							ops:   vec![Op::Ins {
								parent: assistant,
								after: session.dom().children(assistant).last().copied(),
								node,
							}],
						})?;
						self.apply_live_components(session)?;
					},
					ChatEvent::WorkflowAction(action) => {
						// A provider-side workflow asks the client to execute
						// one of its tools mid-stream (Devin/GitLab agentic
						// routes). The call is journaled and dispatched like
						// any model call, and its outcome is submitted on the
						// same live session; the stream then resumes.
						let Some(stream_control) = stream.control() else {
							append_notice(
								session,
								current_turn(session)?,
								Str::new(format!(
									"provider workflow action {} ignored: route is not bidirectional",
									action.name
								)),
							)?;
							self.apply_live_components(session)?;
							continue;
						};
						self
							.answer_workflow_action(session, action, &stream_control, turn_cancel, control)
							.await?;
					},
					ChatEvent::WorkflowResume(resume) => {
						append_notice(
							session,
							current_turn(session)?,
							Str::new(format!("provider workflow resumed: {}", resume.workflow_id)),
						)?;
						self.apply_live_components(session)?;
					},
					ChatEvent::WorkflowCancelled { invocation } => {
						append_notice(
							session,
							current_turn(session)?,
							Str::new(format!("provider workflow cancelled: {invocation}")),
						)?;
						self.apply_live_components(session)?;
					},
				}
			}
		}
		.await;
		match fold {
			Ok(Fold::Ended) => {},
			Ok(state @ (Fold::Cancelled | Fold::ToolScopedAbort(_))) => {
				let scoped = match &state {
					Fold::ToolScopedAbort(reason) => Some(reason),
					Fold::Cancelled | Fold::Ended => None,
				};
				close_streams(session, &mut content_streams)?;
				// Placeholder results follow provider call order even when some
				// calls completed argument streaming and others did not. They
				// are never marked as
				// executed: no execution unit was admitted
				// before this inference fold ended.
				let mut aborted = Vec::with_capacity(pending.len() + ready.len());
				for (index, streaming) in pending.drain() {
					let _ = session.stream_close(streaming.sid);
					aborted.push((index, false, streaming.prepared));
				}
				aborted.extend(
					ready
						.drain(..)
						.map(|prepared| (prepared.index, true, prepared.call)),
				);
				aborted.sort_unstable_by_key(|(index, ..)| *index);
				for (_, authorized, prepared) in aborted {
					let reason = scoped.map_or_else(
						|| {
							if authorized {
								Str::new_static("inference cancelled before tool execution")
							} else {
								Str::new_static("inference cancelled before tool arguments settled")
							}
						},
						|reason| {
							sf!("Tool execution was aborted: {}", reason.message_for(prepared.call_id()))
						},
					);
					self
						.dispatcher
						.abort_prepared(session, prepared, Abort::Skipped { reason })?;
				}
				return Ok(DrivenInference::cancelled(text, usage));
			},
			Err(error) => {
				if let Err(journal) = close_streams(session, &mut content_streams) {
					tracing::warn!(error = ?journal, "failed to close reveal streams after a stream error");
				}
				for (_, streaming) in pending.drain() {
					let _ = session.stream_close(streaming.sid);
					self
						.dispatcher
						.abort_prepared(session, streaming.prepared, Abort::InputDropped)?;
				}
				let harmony_failure = match &error {
					KernelError::Inference(inference)
						if inference.receipt().recoveries.iter().any(|record| {
							matches!(
								record.kind,
								RecoveryKind::HarmonyLeakDetection | RecoveryKind::HarmonyLeakRepair
							)
						}) =>
					{
						Some((
							inference.receipt().usage,
							inference.receipt().cost.micro_usd,
							inference.receipt().recoveries.clone(),
						))
					},
					_ => None,
				};
				if let Some((failure_usage, micro_usd, recoveries)) = harmony_failure
					&& assistant.is_some()
				{
					session.assistant_end("error")?;
					self.apply_live_components(session)?;
					let cost_nano_usd = micro_usd
						.max(0)
						.saturating_mul(1_000)
						.try_into()
						.unwrap_or(u64::MAX);
					session.receipt(receipt_facts(
						&failure_usage,
						cost_nano_usd,
						request_started,
						first_token,
						&recoveries,
					))?;
					self.apply_live_components(session)?;
				}
				if ready.is_empty() {
					return Err(error);
				}
				// A trailer/read failure does not discard already-complete calls.
				// They remain a valid tool-use turn and execute below.
				append_notice(
					session,
					current_turn(session)?,
					Str::new(format!(
						"inference stream ended after complete tool calls: {}",
						error_chain(&error)
					)),
				)?;
				stop_reason = Str::new_static("tool_calls");
			},
		}
		if !completed {
			close_streams(session, &mut content_streams)?;
			self.apply_live_components(session)?;
			session.assistant_end("stream_closed")?;
			self.apply_live_components(session)?;
			session.receipt(receipt_facts(&usage, 0, request_started, first_token, &[]))?;
			self.apply_live_components(session)?;
		}
		Ok(DrivenInference {
			text: Str::new(text),
			usage,
			stop_reason,
			calls: ready.into_iter().map(|prepared| prepared.call).collect(),
			had_tool_calls,
			cancelled: false,
		})
	}

	async fn gate_tool_call(
		hooks: Option<crate::LifecycleHooks>,
		registry: Arc<Registry>,
		session_id: &Str,
		turn_id: &Str,
		identity: &ToolIdentity,
		call_id: &Str,
		args: Box<RawValue>,
	) -> ToolGate {
		let Some(hooks) = hooks else {
			return ToolGate::Allow { identity: identity.clone(), args, approvals: Vec::new() };
		};
		let Ok(args_value) = serde_json::from_str::<serde_json::Value>(args.get()) else {
			return ToolGate::Deny(Str::new_static("tool-call arguments are not valid JSON"));
		};
		let rev = format!("{}@{}", identity.rev.family, identity.rev.n);
		let target = serde_json::json!({
			"kind": "core",
			"name": identity.name,
			"rev": rev,
			"args": args_value.clone(),
		});
		let payload = serde_json::json!({
			"call_id": call_id,
			"invocation_id": call_id,
			"target": target.clone(),
			"kind": "core",
			"args": args_value,
			"raw_args": {
				"$bytes": omp_core::base64::encode(args.get().as_bytes()).into_string(),
			},
			"repaired": false,
			"turn_id": turn_id,
			"session_id": session_id,
			"cwd": ".",
			"origin": "model",
			"batch": [{"call_id": call_id, "target": target}],
			"deadline": serde_json::Value::Null,
			"bash": serde_json::Value::Null,
		});
		let admission = match hooks
			.evaluate(HookEventId::HookEventToolCall, payload)
			.await
		{
			Ok(admission) => admission,
			Err(crate::LifecycleHookError::Denied { reason, .. }) => return ToolGate::Deny(reason),
			Err(error) => {
				tracing::warn!(?error, "tool-call lifecycle hook failed");
				return ToolGate::Deny(Str::new_static("tool-call lifecycle hook failed"));
			},
		};
		let transformed = admission.payload;
		let Some(name) = transformed
			.get("target")
			.and_then(|target| target.get("name"))
			.and_then(serde_json::Value::as_str)
		else {
			return ToolGate::Deny(Str::new_static("tool-call hook removed the target name"));
		};
		let Some(identity) = registry.resolved_identity(name) else {
			return ToolGate::Deny(Str::new_static("tool-call hook selected an unknown target"));
		};
		let Some(args) = transformed.get("args") else {
			return ToolGate::Deny(Str::new_static("tool-call hook removed canonical arguments"));
		};
		match serde_json::value::to_raw_value(args) {
			Ok(args) => ToolGate::Allow { identity, args, approvals: admission.approvals },
			Err(error) => {
				tracing::warn!(?error, "tool-call hook returned malformed arguments");
				ToolGate::Deny(Str::new_static("tool-call hook returned malformed arguments"))
			},
		}
	}

	async fn artifact_blob(
		blobs: &BlobStore,
		artifact: omp_ai::Artifact,
	) -> Result<omp_journal::blob::BlobRef, KernelError> {
		let declared = artifact.size;
		let blob = match artifact.body {
			ArtifactBody::Bytes(bytes) => blobs.put(&bytes)?,
			ArtifactBody::Stored(reference) => {
				let size = declared.ok_or(KernelError::StoredArtifactSizeMissing)?;
				let blob = omp_journal::blob::BlobRef::parse_hex(reference.id.as_str(), size)?;
				if !blobs.verify(&blob)? {
					return Err(
						omp_journal::blob::Error::DigestMismatch {
							expected: blob.hash,
							actual:   Hash32::sum(&blobs.get(&blob)?),
						}
						.into(),
					);
				}
				blob
			},
			ArtifactBody::Stream(mut stream) => {
				let mut bytes = Vec::new();
				while let Some(chunk) = stream.next().await {
					bytes.extend_from_slice(&chunk?);
				}
				blobs.put(&bytes)?
			},
		};
		if let Some(declared) = declared
			&& declared != blob.size
		{
			return Err(KernelError::ArtifactSizeMismatch { declared, actual: blob.size });
		}
		Ok(blob)
	}

	/// Executes one provider workflow action as a journaled tool call and
	/// submits its outcome on the live provider session. An unknown target or
	/// a failed dispatch is reported to the provider as an error response,
	/// never silently
	/// dropped, so the provider can end its workflow.
	async fn answer_workflow_action(
		&mut self,
		session: &mut Session,
		action: omp_ai::WorkflowAction,
		stream_control: &omp_ai::ChatControl,
		turn_cancel: &crate::TurnCancellation,
		control: &RunControl,
	) -> Result<(), KernelError> {
		use omp_ai::{
			InvokeComplete, InvokeInput, WorkflowActionResponse, WorkflowResponse,
			WorkflowResponseKind,
		};
		let call_id = action
			.call
			.as_ref()
			.map_or_else(|| action.invocation.clone(), Str::new);
		let args = match std::str::from_utf8(&action.arguments)
			.ok()
			.and_then(|text| RawValue::from_string(text.to_owned()).ok())
		{
			Some(args) => args,
			None => RawValue::from_string("{}".to_owned())?,
		};
		let (outcome, is_error) = if let Some(identity) = self
			.dispatcher
			.registry()
			.resolved_identity(action.name.as_str())
		{
			let entry = session.call(
				identity.name.clone(),
				crate::journal_revision(&identity.rev),
				call_id.clone(),
				None,
				Some(args.clone()),
				None,
			)?;
			self.apply_live_components(session)?;
			let cancellation =
				tool_cancellation(self.dispatcher.registry(), identity.name.as_str(), turn_cancel)?;
			let mut prepared =
				self
					.dispatcher
					.prepare(identity, call_id.clone(), entry, cancellation)?;
			prepared.arg_delta(args.get());
			prepared.commit(args);
			let call_control = CallControl::new(
				self.mailbox_rx.clone(),
				turn_cancel.clone(),
				self.cancel.clone(),
				Some(control.clone()),
				self.approvals.clone(),
			);
			let mut reports = self
				.dispatcher
				.drive(session, vec![prepared], Some(&call_control))
				.await?;
			self.apply_live_components(session)?;
			let report = reports.remove(0);
			let outcome = crate::dispatch::result_handle(session, entry)
				.ok()
				.and_then(|handle| session.dom().get(handle))
				.and_then(|node| match node.prop(&omp_dom::PropKey::from(PropId::Data)) {
					Some(omp_dom::Value::Json(raw)) => Some(raw.get().to_owned()),
					_ => node.content.as_deref().map(str::to_owned),
				})
				.unwrap_or_else(|| "{}".to_owned());
			(outcome, report.is_error)
		} else {
			append_notice(
				session,
				current_turn(session)?,
				Str::new(format!("provider workflow action names unknown tool {}", action.name)),
			)?;
			self.apply_live_components(session)?;
			(serde_json::json!({"error": format!("unknown tool {}", action.name)}).to_string(), true)
		};
		let response = match action.response_kind {
			WorkflowResponseKind::Action => {
				WorkflowResponse::WorkflowActionResponse(WorkflowActionResponse {
					invocation: action.invocation.clone(),
					response: bytes::Bytes::from(outcome),
					is_error,
				})
			},
			WorkflowResponseKind::Invoke => {
				stream_control
					.submit(WorkflowResponse::InvokeInput(InvokeInput {
						invocation: action.invocation.clone(),
						payload:    bytes::Bytes::from(outcome.clone()),
					}))
					.await
					.map_err(KernelError::WorkflowResponse)?;
				WorkflowResponse::InvokeComplete(InvokeComplete {
					invocation: action.invocation.clone(),
					payload:    bytes::Bytes::from(outcome),
				})
			},
		};
		stream_control
			.submit(response)
			.await
			.map_err(KernelError::WorkflowResponse)?;
		self.events.publish(KernelEvent::WorkflowActionAnswered {
			invocation: action.invocation,
			name: action.name,
			is_error,
		});
		Ok(())
	}

	/// Holds all new inference, tool, subagent, and job admission while the
	/// authoritative `<meta><pause>` element is active. Existing execution
	/// units may settle; their terminal state is journaled but delivery and
	/// continuation wait for resume. Interrupt and session cancellation stay
	/// live while held.
	async fn hold_while_paused(
		&mut self,
		session: &mut Session,
		turn: &crate::TurnCancellation,
		run: &RunControl,
	) -> Result<bool, KernelError> {
		let control = CallControl::new(
			self.mailbox_rx.clone(),
			turn.clone(),
			self.cancel.clone(),
			Some(run.clone()),
			self.approvals.clone(),
		);
		while crate::pause_state(session.dom()).active {
			if self.dispatcher.jobs().has_finished_units() {
				self.dispatcher.jobs().poll(session)?;
				self.apply_live_components(session)?;
			}
			let jobs = Arc::clone(self.dispatcher.jobs());
			tokio::select! {
				biased;
				() = run.cancelled() => {
					turn.cancel_turn();
					return Ok(true);
				},
				message = control.recv() => match control.handle(session, message)? {
					Received::ToolScopedAbort(_) => {},
					Received::Cancelled => return Ok(true),
					Received::Rewound(work) => {
						self.dispatcher.jobs().apply_lifecycle(session, &work).await;
						turn.cancel_turn();
						return Ok(true);
					},
					Received::None
					| Received::Steering
					| Received::PauseChanged
					| Received::Approved(_) => {},
				},
				() = jobs.any_finished() => {},
			}
		}
		Ok(false)
	}

	/// Applies only admission-preempting control already accepted by the
	/// mailbox, leaving prompts, follow-ups, steering, approvals, and
	/// observations for their ordinary owner.
	///
	/// The bounded snapshot scan lets a pause behind unrelated work win
	/// provider admission without draining that work into the wrong turn.
	fn drain_admission_control(
		&self,
		session: &mut Session,
		turn: &crate::TurnCancellation,
	) -> Result<bool, SessionError> {
		let pending = self.mailbox_rx.len();
		if pending == 0 {
			return Ok(false);
		}
		let mut deferred = Vec::new();
		let mut cancelled = false;
		for _ in 0..pending {
			let Ok(message) = self.mailbox_rx.try_recv() else {
				break;
			};
			match message {
				Up::Pause { active } => {
					crate::set_paused(session, active)?;
				},
				Up::Cancel => {
					self.cancel.cancel_session();
					turn.cancel_turn();
					cancelled = true;
					break;
				},
				other => deferred.push(other),
			}
		}
		for message in deferred {
			let _ = self.mailbox_tx.send(message);
		}
		Ok(cancelled)
	}

	/// Drains every queued mailbox message at a safe point. A rewind that
	/// lands here applies its lifecycle work (removed subagents and jobs are
	/// terminated, ADR 0004) and cancels the turn like every other drain.
	async fn drain_mailbox(
		&self,
		session: &mut Session,
		turn: &crate::TurnCancellation,
	) -> Result<DrainedSteering, SessionError> {
		let mut drained = DrainedSteering::default();
		let control = CallControl::new(
			self.mailbox_rx.clone(),
			turn.clone(),
			self.cancel.clone(),
			None,
			self.approvals.clone(),
		);
		while let Ok(message) = self.mailbox_rx.try_recv() {
			match control.handle(session, message)? {
				Received::ToolScopedAbort(_) => {},
				Received::Steering => drained.received = true,
				Received::Cancelled => drained.cancelled = true,
				Received::Approved(_) => {},
				Received::Rewound(work) => {
					self.dispatcher.jobs().apply_lifecycle(session, &work).await;
					turn.cancel_turn();
					drained.cancelled = true;
				},
				Received::None | Received::PauseChanged => {},
			}
		}
		// A prompt whose policy stopped waiting (timeout, cancelled or
		// finished invocation) is withdrawn so the host stops showing it.
		if let Err(error) = self.approvals.sweep(session) {
			match error {
				crate::ApprovalError::Session(source) => return Err(source),
				other => tracing::warn!(%other, "abandoned approval prompt withdrawal failed"),
			}
		}
		Ok(drained)
	}

	/// Runs the manual compaction path between turns (`/compact`,
	/// `/handoff`): summarizes the projected history through the
	/// [`CompactionDirector`] and journals a `compaction@1` labeled
	/// `method`. Returns whether a compaction landed (an empty session
	/// projects nothing to summarize and journals nothing).
	pub async fn compact(
		&mut self,
		session: &mut Session,
		focus: Option<Str>,
		method: &'static str,
	) -> Result<bool, KernelError> {
		self
			.compact_with(session, focus, method, RunControl::default())
			.await
	}

	/// [`Self::compact`] under caller-owned cancellation: an interrupt or
	/// cancel on the mailbox, or the control token, abandons the summary
	/// inference and journals nothing.
	pub async fn compact_with(
		&mut self,
		session: &mut Session,
		focus: Option<Str>,
		method: &'static str,
		control: RunControl,
	) -> Result<bool, KernelError> {
		let Ok(turn) = current_turn(session) else {
			return Ok(false);
		};
		let request = self.finish_request(self.project_request(session)?).await?;
		let director = CompactionDirector::manual(focus).with_method(method);
		let route = self.current_route();
		let turn_cancel = self.cancel.begin_turn();
		let preflight_control = CallControl::new(
			self.mailbox_rx.clone(),
			turn_cancel.clone(),
			self.cancel.clone(),
			Some(control.clone()),
			self.approvals.clone(),
		);
		// Only an interrupt/cancel may end the summary inference; every other
		// mailbox message (steering, peer, approvals) is journaled once the
		// session is free again, exactly as a blocking `/compact` in pi.
		let mut deferred = Vec::new();
		let signal = {
			let mut cx = MutDirectorCx {
				session,
				inference: &mut self.client,
				blobs: &self.dispatcher.policy().spill,
				route: &route,
				turn,
				director: None,
				events: Some(&self.events),
				con: self.con.as_deref(),
				hooks: self.lifecycle_hooks.as_ref(),
			};
			let preparing = director.before_inference(&mut cx, &request);
			tokio::pin!(preparing);
			loop {
				let signal = tokio::select! {
					biased;
					result = &mut preparing => PreflightSignal::Ready(result),
					() = control.cancelled() => PreflightSignal::Cancelled,
					message = preflight_control.recv() => PreflightSignal::Control(message),
				};
				match signal {
					PreflightSignal::Control(message @ (Up::Interrupt | Up::Cancel)) => {
						break PreflightSignal::Control(message);
					},
					PreflightSignal::Control(message) => deferred.push(message),
					other => break other,
				}
			}
		};
		for message in deferred {
			let _ = preflight_control.handle(session, message)?;
		}
		let prepared = match signal {
			PreflightSignal::Ready(result) => result?,
			PreflightSignal::Cancelled => {
				turn_cancel.cancel_turn();
				self
					.events
					.publish(KernelEvent::CompactionSettled { applied: false });
				return Ok(false);
			},
			PreflightSignal::Control(message) => {
				let _ = preflight_control.handle(session, message)?;
				turn_cancel.cancel_turn();
				self
					.events
					.publish(KernelEvent::CompactionSettled { applied: false });
				return Ok(false);
			},
		};
		self.apply_live_components(session)?;
		Ok(prepared == Prepared::Rebuild)
	}
}

/// The owned projection of one request before the `thread_projection` gate.
struct ProjectedRequest {
	facts:    crate::context::ContextFacts,
	messages: Vec<InferenceMessage>,
	tools:    Vec<omp_ai::ToolDefinition>,
}

struct StreamingCall {
	entry:    EntryId,
	sid:      u32,
	identity: ToolIdentity,
	call_id:  Str,
	prepared: PreparedCall,
	raw_args: String,
}

struct IndexedPreparedCall {
	index: u32,
	call:  PreparedCall,
}

pub(crate) struct ReadyCall {
	pub(crate) entry:    EntryId,
	pub(crate) identity: ToolIdentity,
	pub(crate) call_id:  Str,
	pub(crate) args:     Box<RawValue>,
}

struct DrivenInference {
	text:           Str,
	usage:          Usage,
	stop_reason:    Str,
	calls:          Vec<PreparedCall>,
	had_tool_calls: bool,
	cancelled:      bool,
}

impl DrivenInference {
	fn cancelled(text: String, usage: Usage) -> Self {
		Self {
			text: Str::new(text),
			usage,
			stop_reason: Str::new_static("cancelled"),
			calls: Vec::new(),
			had_tool_calls: false,
			cancelled: true,
		}
	}

	/// A tool batch re-executed from the journal without a model round trip.
	fn replayed(calls: Vec<PreparedCall>) -> Self {
		Self {
			text: Str::new_static(""),
			usage: Usage::default(),
			stop_reason: Str::new_static("tool_calls"),
			calls,
			had_tool_calls: true,
			cancelled: false,
		}
	}
}

/// Why the scheduling pause at a candidate yield ended.
enum Awaited {
	/// An owned job or subagent finished; its result is delivered next.
	Settled,
	/// Steering arrived and is consumed at this safe point.
	Steering,
	/// The turn was interrupted or the session cancelled.
	Cancelled,
}

enum AwaitSignal {
	Cancelled,
	Control(Up),
	Finished,
}

/// The model-facing text of one settled job: a subagent's final text and
/// structured verdict, a detached tool's artifact address, or its terminal
/// error.
fn settlement_text(record: &crate::JobRecord) -> String {
	let mut text = String::new();
	let output = record
		.output
		.as_deref()
		.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.get()).ok());
	if let Some(output) = &output {
		if let Some(body) = output.get("text").and_then(serde_json::Value::as_str) {
			text.push_str(body);
		}
		if let Some(verdict) = output.get("output").filter(|value| !value.is_null()) {
			if !text.is_empty() {
				text.push_str("\n\n");
			}
			text.push_str("Structured output: ");
			text.push_str(&verdict.to_string());
		}
		if let Some(artifact) = output.get("artifact").and_then(serde_json::Value::as_str) {
			if !text.is_empty() {
				text.push('\n');
			}
			text.push_str("Full output: ");
			text.push_str(artifact);
		}
		if let Some(error) = output.get("error").and_then(serde_json::Value::as_str) {
			if !text.is_empty() {
				text.push('\n');
			}
			text.push_str("Error: ");
			text.push_str(error);
		}
		if text.is_empty() {
			text.push_str(&output.to_string());
		}
	}
	if let Some(error) = &record.error {
		if !text.is_empty() {
			text.push('\n');
		}
		text.push_str("Error: ");
		text.push_str(error.as_str());
	}
	if record.status.as_str() != "completed" {
		if !text.is_empty() {
			text.push('\n');
		}
		text.push_str("Status: ");
		text.push_str(record.status.as_str());
	}
	if text.is_empty() {
		text.push_str("(no output)");
	}
	text
}

fn async_job_delivery(record: &crate::JobRecord) -> AsyncJobDelivery {
	let output = record
		.output
		.as_deref()
		.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.get()).ok());
	let artifact = output
		.as_ref()
		.and_then(|output| output.get("artifact"))
		.and_then(serde_json::Value::as_str)
		.map(Str::new);
	let fault = record.error.clone().or_else(|| {
		output
			.as_ref()
			.and_then(|output| output.get("error"))
			.and_then(serde_json::Value::as_str)
			.map(Str::new)
	});
	AsyncJobDelivery {
		id: record.id.clone(),
		job_type: record.job_type.clone(),
		label: record.label.clone(),
		duration_ms: record.duration_ms.unwrap_or(0),
		status: record
			.status
			.parse::<AsyncJobStatus>()
			.unwrap_or(AsyncJobStatus::Failed),
		artifact,
		fault,
	}
}

fn async_result_notice(jobs: &[(Str, Str, String)]) -> String {
	let mut body = String::from("<system-notice>\n");
	if jobs.len() > 1 {
		body.push_str(&format!(
			"{} background jobs have completed. Resume your work using the results below.\n\n",
			jobs.len()
		));
		for (index, (id, label, result)) in jobs.iter().enumerate() {
			body.push_str(&format!("── Job {id} ({label}) ──\n{result}"));
			if index + 1 < jobs.len() {
				body.push('\n');
			}
		}
	} else if let Some((id, _, result)) = jobs.first() {
		body.push_str(&format!(
			"Background job {id} has completed. Resume your work using the result below.\n\n{result}"
		));
	}
	body.push_str("\n</system-notice>");
	body
}

/// Whether the last turn ends in an aborted or unsettled tool tail that
/// [`Kernel::retry_tool_tail`] can re-execute: the newest tool element is
/// cancelled/aborted, errored by a harness abort, or still running after the
/// interrupt.
#[must_use]
pub fn aborted_tool_tail(dom: &omp_dom::Dom, turn: Handle) -> bool {
	let Some(node) = dom
		.children(turn)
		.iter()
		.rev()
		.filter_map(|handle| dom.get(*handle).map(|node| (*handle, node)))
		.find(|(_, node)| matches!(node.tag, Tag::Custom(_)))
		.map(|(handle, node)| (handle, node))
	else {
		return false;
	};
	let (handle, node) = node;
	let status = node
		.prop(&omp_dom::PropKey::from(PropId::Status))
		.and_then(omp_dom::Value::as_str)
		.unwrap_or("running");
	match status {
		"cancelled" | "aborted" | "running" | "arguments" => true,
		// `Committer::commit_abort` journals `{"kind":"aborted",…}` as the
		// fault; the fold keeps it as `<diag severity=error fault=…>`.
		"error" => dom.children(handle).iter().any(|child| {
			dom.get(*child).is_some_and(|diag| {
				diag.tag == Tag::Known(KnownTag::Diag)
					&& match diag.prop(&omp_dom::PropKey::from(PropId::Fault)) {
						Some(omp_dom::Value::Json(raw)) => raw.get().contains("\"kind\":\"aborted\""),
						Some(omp_dom::Value::Str(text)) => text.contains("\"kind\":\"aborted\""),
						_ => false,
					}
			})
		}),
		_ => false,
	}
}

/// Assistant messages committed under one turn (`RunSummary.committed_turns`).
fn committed_requests(session: &Session, turn: Handle) -> usize {
	let dom = session.dom();
	dom.children(turn)
		.iter()
		.filter(|handle| {
			dom.get(**handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
		})
		.count()
}

/// `ModelRef` hook payload for a catalog model key (`provider/model`).
fn model_ref(model: Option<&Str>) -> serde_json::Value {
	let Some(model) = model else {
		return serde_json::Value::Null;
	};
	let (provider, name) = model.split_once('/').unwrap_or(("", model.as_str()));
	serde_json::json!({"provider": provider, "api": "", "model": name})
}

/// The requested reasoning effort as the hook `Effort` string.
fn reasoning_effort(request: &ChatRequest) -> &'static str {
	match &request.reasoning {
		Setting::Prefer(reasoning) | Setting::Require(reasoning) => {
			reasoning.effort.map_or("none", |effort| effort.into())
		},
		Setting::Unset => "none",
	}
}

/// Stable content hash over the system prefix of a request.
fn prompt_hash(request: &ChatRequest) -> String {
	prompt_hash_of(&request.messages)
}

/// Stable content hash over the leading system messages.
fn prompt_hash_of(messages: &[InferenceMessage]) -> String {
	let mut hasher = std::collections::hash_map::DefaultHasher::new();
	for message in messages
		.iter()
		.take_while(|message| message.role == omp_ai::Role::System)
	{
		for part in message.content.iter() {
			if let omp_ai::ContentPart::Text { text, .. } = part {
				std::hash::Hasher::write(&mut hasher, text.as_bytes());
			}
		}
	}
	format!("{:016x}", std::hash::Hasher::finish(&hasher))
}

/// Stable hash over the advertised tool names.
fn toolset_hash(names: &[Str]) -> String {
	let mut hasher = std::collections::hash_map::DefaultHasher::new();
	for name in names {
		std::hash::Hasher::write(&mut hasher, name.as_bytes());
		std::hash::Hasher::write_u8(&mut hasher, 0);
	}
	format!("{:016x}", std::hash::Hasher::finish(&hasher))
}

/// `Usage` hook payload for one completed request.
fn usage_json(usage: &Usage) -> serde_json::Value {
	serde_json::json!({
		"input_tokens": usage.input_tokens,
		"cached_input_tokens": usage.cache_read_tokens,
		"output_tokens": usage.output_tokens,
		"reasoning_tokens": usage.reasoning_tokens,
		"cache_write_tokens": usage.cache_write_tokens,
		"requests": 1,
		"cost_usd": 0.0,
		"wall": "0s",
	})
}

/// `Usage` hook payload summed over every receipt in the turn.
fn session_usage_json(session: &Session, turn: Handle) -> serde_json::Value {
	let dom = session.dom();
	let mut input = 0_u64;
	let mut output = 0_u64;
	let mut cost_nano = 0_u64;
	let mut requests = 0_u64;
	for handle in dom.children(turn) {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		if node.tag != Tag::Known(KnownTag::Usage) {
			continue;
		}
		requests += 1;
		let int = |id: PropId| match node.prop(&omp_dom::PropKey::from(id)) {
			Some(omp_dom::Value::Int(value)) => u64::try_from(*value).unwrap_or(0),
			_ => 0,
		};
		input = input.saturating_add(int(PropId::TokensIn));
		output = output.saturating_add(int(PropId::TokensOut));
		cost_nano = cost_nano.saturating_add(int(PropId::CostNanoUsd));
	}
	serde_json::json!({
		"input_tokens": input,
		"cached_input_tokens": 0,
		"output_tokens": output,
		"reasoning_tokens": 0,
		"cache_write_tokens": 0,
		"requests": requests,
		"cost_usd": cost_nano as f64 / 1e9,
		"wall": "0s",
	})
}

enum ToolGate {
	Allow { identity: ToolIdentity, args: Box<RawValue>, approvals: Vec<crate::ApprovalSpec> },
	Deny(Str),
}

enum PreflightSignal<T> {
	Ready(T),
	Control(Up),
	Cancelled,
}

enum StreamSignal {
	Event(Option<Result<ChatEvent, omp_ai::Error>>),
	Control(Option<Up>),
	Cancelled,
}

/// How one inference fold left the stream.
enum Fold {
	/// The stream completed or closed on its own.
	Ended,
	/// Caller control ended the stream before completion.
	Cancelled,
	/// One identified tool call aborted the request; siblings receive neutral
	/// placeholders rather than being blamed for the trigger.
	ToolScopedAbort(crate::ToolScopedAbortReason),
}

/// Renders an error with its full `source()` chain, one cause per line.
fn error_chain(error: &dyn std::error::Error) -> String {
	let mut text = error.to_string();
	let mut source = error.source();
	while let Some(cause) = source {
		text.push_str("\n  caused by: ");
		text.push_str(&cause.to_string());
		source = cause.source();
	}
	text
}

#[derive(Default)]
struct DrainedSteering {
	received:  bool,
	cancelled: bool,
}

fn content_sid(
	session: &mut Session,
	assistant: Option<Handle>,
	streams: &mut FastHashMap<u32, u32>,
	index: u32,
	kind: &'static str,
) -> Result<u32, KernelError> {
	if let Some(sid) = streams.get(&index) {
		return Ok(*sid);
	}
	let assistant = assistant.ok_or(KernelError::MissingResponseStart)?;
	session.patch(Txn {
		cause: session.head().ok_or(SessionError::NoActiveTurn)?,
		label: Some(Str::new_static("assistant.content")),
		ops:   vec![Op::Ins {
			parent: assistant,
			after:  session.dom().children(assistant).last().copied(),
			node:   NodeSpec::new(Tag::Custom(Str::new_static(omp_session::ASSISTANT_CONTENT_TAG)))
				.with_prop(PropId::Kind, Value::Str(Str::new_static(kind)))
				.with_prop(
					PropKey::Custom(Str::new_static(omp_session::PROVIDER_BLOCK_INDEX_PROP)),
					Value::Int(i64::from(index)),
				)
				.with_prop(PropId::Text, Value::Str(Str::new_static(""))),
		}],
	})?;
	let child = session
		.dom()
		.children(assistant)
		.last()
		.copied()
		.ok_or(KernelError::MissingResponseStart)?;
	let sid = session.stream_open(child, PropId::Text.into())?;
	streams.insert(index, sid);
	Ok(sid)
}

fn recover_inline_sloppy_edits(
	session: &mut Session,
	assistant: Option<Handle>,
) -> Result<Option<(String, String, usize)>, KernelError> {
	let Some(assistant) = assistant else {
		return Ok(None);
	};
	let mut children = session
		.dom()
		.children(assistant)
		.iter()
		.enumerate()
		.filter_map(|(position, handle)| {
			let node = session.dom().get(*handle)?;
			if !matches!(
				&node.tag,
				Tag::Custom(tag) if tag.as_str() == omp_session::ASSISTANT_CONTENT_TAG
			) || !matches!(
				node.prop(&PropId::Kind.into()),
				Some(Value::Str(kind)) if kind.as_str() == "text"
			) {
				return None;
			}
			let index = node
				.prop(&PropKey::Custom(Str::new_static(omp_session::PROVIDER_BLOCK_INDEX_PROP)))
				.and_then(|value| match value {
					Value::Int(index) => Some(*index),
					_ => None,
				})
				.unwrap_or(i64::MAX);
			let text = session
				.dom()
				.stream_text(*handle, &PropId::Text.into())
				.or_else(|| node.prop(&PropId::Text.into()).and_then(Value::as_str))?;
			Some((index, position, *handle, Str::new(text)))
		})
		.collect::<Vec<_>>();
	children.sort_by_key(|(index, position, ..)| (*index, *position));

	let mut ops = Vec::new();
	let mut visible = String::new();
	let mut payloads = Vec::new();
	let mut regions = 0;
	for (_, _, handle, text) in children {
		if let Some((remaining, input, found)) = extract_inline_sloppy_edits(text.as_str()) {
			regions += found;
			payloads.push(input);
			visible.push_str(&remaining);
			if remaining.trim().is_empty() {
				ops.push(Op::Rm(handle));
			} else {
				ops.push(Op::Set {
					h:     handle,
					prop:  PropId::Text.into(),
					value: Value::Str(Str::new(remaining)),
				});
			}
		} else {
			visible.push_str(text.as_str());
		}
	}
	if regions == 0 {
		return Ok(None);
	}
	session.patch(Txn {
		cause: session.head().ok_or(SessionError::NoActiveTurn)?,
		label: Some(Str::new_static("edit.inline-recovery")),
		ops,
	})?;
	Ok(Some((visible, payloads.join("\n"), regions)))
}

/// Persists the provider content-array position without widening `tool.call@1`.
fn record_provider_tool_index(
	session: &mut Session,
	call: EntryId,
	index: u32,
) -> Result<(), SessionError> {
	let handle = session.call_handle(call)?;
	session.patch(Txn {
		cause: call,
		label: Some(Str::new_static("tool.provider-order")),
		ops:   vec![Op::Set {
			h:     handle,
			prop:  PropKey::Custom(Str::new_static(omp_session::PROVIDER_BLOCK_INDEX_PROP)),
			value: Value::Int(i64::from(index)),
		}],
	})?;
	Ok(())
}

fn close_streams(
	session: &mut Session,
	streams: &mut FastHashMap<u32, u32>,
) -> Result<(), SessionError> {
	for (_, sid) in streams.drain() {
		session.stream_close(sid)?;
	}
	Ok(())
}

pub(crate) fn current_turn(session: &Session) -> Result<Handle, KernelError> {
	session
		.dom()
		.children(session.dom().body())
		.last()
		.copied()
		.ok_or(KernelError::MissingResponseStart)
}

fn current_assistant(session: &Session) -> Result<Handle, KernelError> {
	let turn = current_turn(session)?;
	session
		.dom()
		.children(turn)
		.iter()
		.rev()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
		})
		.ok_or(KernelError::MissingResponseStart)
}

fn tool_cancellation(
	registry: &Registry,
	name: &str,
	turn: &crate::TurnCancellation,
) -> Result<ToolCancellation, RegistryError> {
	let effects = registry.effects_owned(name)?;
	let mutating = effects
		.documents
		.as_ref()
		.is_some_and(|effects| !effects.write_globs.is_empty())
		|| effects
			.exec
			.as_ref()
			.is_some_and(|effects| !effects.is_empty())
		|| effects
			.inference
			.as_ref()
			.is_some_and(|effects| !effects.is_empty())
		|| effects
			.desktop
			.as_ref()
			.is_some_and(|effects| effects.input)
		|| effects.subagents != 0;
	Ok(if mutating {
		ToolCancellation::Foreground(turn.foreground_mutation())
	} else {
		ToolCancellation::ReadOnly(turn.read_only_tool())
	})
}

fn extract_inline_sloppy_edits(text: &str) -> Option<(String, String, usize)> {
	const OPEN: &str = "<SM:EDIT ";
	const CLOSE: &str = "</SM:EDIT>";
	let mut remaining = String::with_capacity(text.len());
	let mut payloads = Vec::new();
	let mut cursor = 0;
	while let Some(relative) = text[cursor..].find(OPEN) {
		let start = cursor + relative;
		let Some(close_relative) = text[start..].find(CLOSE) else {
			break;
		};
		let end = start + close_relative + CLOSE.len();
		let payload = &text[start..end];
		let valid = payload.contains("<SM:FIND>")
			&& payload.contains("</SM:FIND>")
			&& (payload.contains("<SM:PUT>") || payload.contains("<SM:PUT></SM:PUT>"))
			&& (payload.contains("</SM:PUT>") || payload.contains("<SM:PUT></SM:PUT>"));
		if !valid {
			remaining.push_str(&text[cursor..end]);
			cursor = end;
			continue;
		}
		remaining.push_str(&text[cursor..start]);
		payloads.push(payload.to_owned());
		cursor = end;
	}
	if payloads.is_empty() {
		return None;
	}
	remaining.push_str(&text[cursor..]);
	let regions = payloads.len();
	Some((remaining, payloads.join("\n"), regions))
}

fn turn_has_terminal_incremental_yield(dom: &omp_dom::Dom, turn: Handle) -> bool {
	dom.children(turn).iter().copied().any(|handle| {
		let Some(call) = dom.get(handle) else {
			return false;
		};
		if !matches!(&call.tag, Tag::Custom(name) if name == "yield")
			|| call
				.prop(&PropKey::from(PropId::Status))
				.and_then(Value::as_str)
				!= Some("ok")
		{
			return false;
		}
		dom.children(handle).iter().copied().any(|child| {
			let Some(result) = dom.get(child) else {
				return false;
			};
			if result.tag != Tag::Known(KnownTag::Result) {
				return false;
			}
			let Some(Value::Json(raw)) = result.prop(&PropKey::from(PropId::Outcome)) else {
				return false;
			};
			let Ok(outcome) = serde_json::from_str::<serde_json::Value>(raw.get()) else {
				return false;
			};
			let Some(payload) = outcome.get("value") else {
				return false;
			};
			payload.get("complete").and_then(serde_json::Value::as_bool) == Some(true)
				|| payload.get("failed").and_then(serde_json::Value::as_bool) == Some(true)
		})
	})
}

fn should_schedule_autolearn(dom: &omp_dom::Dom, turn: Handle, minimum: usize) -> bool {
	let mut settled = 0_usize;
	for handle in dom.children(turn) {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		let Tag::Custom(name) = &node.tag else {
			continue;
		};
		if name.as_str() == "learn" {
			return false;
		}
		let done = node
			.prop(&omp_dom::PropKey::from(PropId::Status))
			.and_then(omp_dom::Value::as_str)
			.is_some_and(|status| matches!(status, "ok" | "error"));
		settled += usize::from(done);
	}
	settled >= minimum
}

fn streamed_edit_must_abort(con: Option<&omp_con::Ctx>, name: &str, raw: &str) -> bool {
	name == "edit"
		&& con
			.and_then(|con| con.get("sv_tools_edit_streaming_abort"))
			.is_some_and(|value| matches!(value, omp_con::Value::Bool(true)))
		&& serde_json::from_str::<serde_json::Value>(raw)
			.is_err_and(|error| error.classify() != serde_json::error::Category::Eof)
}

fn finish_reason(reason: &FinishReason) -> Str {
	match reason {
		FinishReason::Stop => Str::new_static("stop"),
		FinishReason::Length => Str::new_static("length"),
		FinishReason::ToolCalls => Str::new_static("tool_calls"),
		FinishReason::ContentFilter => Str::new_static("content_filter"),
		FinishReason::Cancelled => Str::new_static("cancelled"),
		FinishReason::Other(reason) => reason.clone(),
	}
}

/// Whether a user follow-up already owns the next explicit turn.
///
/// This is read from the journal-derived queues subtree after the mailbox
/// drain, so replay and a live run make the same eligibility decision.
fn queued_follow_up(dom: &omp_dom::Dom) -> bool {
	dom.children(dom.queues()).iter().any(|queue| {
		dom.get(*queue)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Prompts))
			&& dom.children(*queue).iter().any(|prompt| {
				dom.get(*prompt).is_some_and(|node| {
					node.tag == Tag::Known(KnownTag::Prompt)
						&& node.prop(&PropId::Kind.into()).and_then(Value::as_str) == Some("queued")
						&& node.prop(&PropId::Status.into()).and_then(Value::as_str) == Some("pending")
				})
			})
	})
}

/// Counts consecutive pause continuations since the latest tool element.
///
/// The current pause assistant has not been marked yet and is ignored. A tool
/// element carries `rev`; encountering one re-arms the budget. Reading the
/// DOM makes crash replay retain the same remaining budget.
fn paused_turn_continuation_count(dom: &omp_dom::Dom, turn: Handle) -> u8 {
	let count = dom
		.children(turn)
		.iter()
		.rev()
		.take_while(|handle| {
			dom.get(**handle)
				.is_none_or(|node| node.prop(&PropId::Rev.into()).is_none())
		})
		.filter(|handle| {
			dom.get(**handle).is_some_and(|node| {
				node.tag == Tag::Known(KnownTag::Assistant)
					&& node
						.prop(&PropKey::Custom(Str::new_static("continuation-decision")))
						.and_then(Value::as_str)
						== Some("scheduled")
			})
		})
		.count();
	u8::try_from(count).unwrap_or(u8::MAX)
}

/// Persists the eligibility decision on the assistant completion that caused
/// it. These props are audit-only: projection still replays the original
/// assistant content and stop reason byte-for-byte.
fn record_paused_turn_decision(
	session: &mut Session,
	turn: Handle,
	attempt: u8,
	decision: &'static str,
) -> Result<(), SessionError> {
	let assistant = session
		.dom()
		.children(turn)
		.iter()
		.rev()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
		})
		.ok_or(SessionError::NoActiveAssistant)?;
	session.patch(Txn {
		cause: session.head().ok_or(SessionError::NoActiveTurn)?,
		label: Some(Str::new_static("kernel.pause-turn")),
		ops:   vec![
			Op::Set {
				h:     assistant,
				prop:  PropKey::Custom(Str::new_static("continuation")),
				value: Value::Str(Str::new_static(PAUSED_TURN_KIND)),
			},
			Op::Set {
				h:     assistant,
				prop:  PropKey::Custom(Str::new_static("continuation-attempt")),
				value: Value::Int(i64::from(attempt)),
			},
			Op::Set {
				h:     assistant,
				prop:  PropKey::Custom(Str::new_static("continuation-cap")),
				value: Value::Int(i64::from(PAUSED_TURN_CONTINUATION_CAP)),
			},
			Op::Set {
				h:     assistant,
				prop:  PropKey::Custom(Str::new_static("continuation-decision")),
				value: Value::Str(Str::new_static(decision)),
			},
		],
	})?;
	Ok(())
}

/// The `turn.receipt@1` payload for one completed inference: provider usage
/// plus kernel-clock timings (TTFT, duration → tok/s).
fn receipt_facts(
	usage: &Usage,
	cost_nano_usd: u64,
	request_started: Instant,
	first_token: Option<Instant>,
	recoveries: &[RecoveryRecord],
) -> TurnReceipt {
	let millis =
		|elapsed: std::time::Duration| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
	TurnReceipt {
		tokens_in: usage.input_tokens,
		tokens_out: usage.output_tokens,
		cost_nano_usd,
		cache_read: usage.cache_read_tokens,
		cache_write: usage.cache_write_tokens,
		ttft_ms: first_token.map(|at| millis(at.duration_since(request_started))),
		duration_ms: Some(millis(request_started.elapsed())),
		premium_requests_millionths: usage.premium_requests_millionths,
		identity: None,
		recoveries: recoveries.iter().map(journal_recovery).collect(),
	}
}

pub(crate) fn journal_recovery(recovery: &RecoveryRecord) -> InferenceRecovery {
	let kind = match recovery.kind {
		RecoveryKind::JsonRepair => InferenceRecoveryKind::JsonRepair,
		RecoveryKind::DialectNormalization => InferenceRecoveryKind::DialectNormalization,
		RecoveryKind::ToolAssembly => InferenceRecoveryKind::ToolAssembly,
		RecoveryKind::ThinkingClassification => InferenceRecoveryKind::ThinkingClassification,
		RecoveryKind::HarmonyLeakRepair => InferenceRecoveryKind::HarmonyLeakRepair,
		RecoveryKind::HarmonyLeakDetection => InferenceRecoveryKind::HarmonyLeakDetection,
		RecoveryKind::ReasoningStall => InferenceRecoveryKind::ReasoningStall,
		RecoveryKind::WithinAttemptRepetition => InferenceRecoveryKind::WithinAttemptRepetition,
		RecoveryKind::CrossTurnToolLoop => InferenceRecoveryKind::CrossTurnToolLoop,
		RecoveryKind::ToolResultRepair => InferenceRecoveryKind::ToolResultRepair,
		RecoveryKind::FabricatedResultRejection => InferenceRecoveryKind::FabricatedResultRejection,
		RecoveryKind::SessionReseed => InferenceRecoveryKind::SessionReseed,
		RecoveryKind::EmptyOutput => InferenceRecoveryKind::EmptyOutput,
	};
	InferenceRecovery {
		attempt: recovery.attempt,
		kind,
		rule: recovery.rule.0.clone(),
		input_bytes: recovery.input_bytes,
		steps: recovery.steps,
	}
}

fn cost_nano_usd(completion: &Completion) -> u64 {
	completion
		.receipt
		.cost
		.micro_usd
		.max(0)
		.saturating_mul(1_000)
		.try_into()
		.unwrap_or(u64::MAX)
}

pub(crate) fn outcome(
	stop: TurnStop,
	text: String,
	tokens_in: u64,
	tokens_out: u64,
) -> TurnOutcome {
	TurnOutcome { stop, assistant_text: Str::new(text), tokens_in, tokens_out }
}

#[cfg(test)]
mod streaming_edit_tests {
	use omp_con::{Ctx, DynamicVarSpec, Origin, TypeSpec, Value, VarFlags};
	use omp_core::Str;
	use omp_session::{ComponentRegistry, Session};

	use super::{
		should_schedule_autolearn, streamed_edit_must_abort, turn_has_terminal_incremental_yield,
	};

	fn context(enabled: bool) -> Ctx {
		let ctx = Ctx::new();
		ctx.register_dynamic_var(DynamicVarSpec {
			name:    Str::new_static("sv_tools_edit_streaming_abort"),
			desc:    Str::new_static("Abort invalid streamed edit arguments"),
			ty:      TypeSpec::BOOL,
			flags:   VarFlags::SESSION,
			default: Value::Bool(false),
			meta:    std::sync::Arc::from([]),
		})
		.expect("setting registers");
		ctx.set("sv_tools_edit_streaming_abort", Value::Bool(enabled), Origin::Session)
			.expect("setting writes");
		ctx
	}

	#[test]
	fn terminal_incremental_yield_is_detected_from_the_durable_payload() {
		for field in ["complete", "failed"] {
			let temp = tempfile::tempdir().expect("tempdir");
			let mut session =
				Session::create(temp.path().join("yield.oms"), ComponentRegistry::standard())
					.expect("session");
			session.begin_turn().expect("turn");
			session.user("batch", Vec::new()).expect("prompt");
			let turn = *session
				.dom()
				.children(session.dom().body())
				.last()
				.expect("turn");
			let call = session
				.call(
					"yield",
					2,
					"yield-1",
					None,
					Some(
						serde_json::value::to_raw_value(&serde_json::json!({"key": 1, "data": "done"}))
							.expect("args"),
					),
					None,
				)
				.expect("call");
			let mut payload = serde_json::json!({
				"incremental": true,
				"use_last_turn": false,
				"validation": null
			});
			payload[field] = serde_json::Value::Bool(true);
			session
				.settle(
					call,
					serde_json::value::to_raw_value(&serde_json::json!({
						"kind": "ok",
						"value": payload
					}))
					.expect("outcome"),
				)
				.expect("settle");
			assert!(turn_has_terminal_incremental_yield(session.dom(), turn));
		}
	}

	#[test]
	fn autolearn_threshold_counts_settled_non_learn_calls_at_the_boundary() {
		let temp = tempfile::tempdir().expect("tempdir");
		let mut session =
			Session::create(temp.path().join("autolearn.oms"), ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		for index in 0..2 {
			let call = session
				.call(
					"read",
					1,
					format!("call-{index}"),
					None,
					Some(serde_json::value::to_raw_value(&serde_json::json!({})).expect("args")),
					None,
				)
				.expect("call");
			session
				.settle(call, serde_json::value::to_raw_value(&serde_json::json!({})).expect("outcome"))
				.expect("settle");
		}
		assert!(!should_schedule_autolearn(session.dom(), turn, 3));
		assert!(should_schedule_autolearn(session.dom(), turn, 2));
		let learn = session
			.call(
				"learn",
				1,
				"learn-1",
				None,
				Some(serde_json::value::to_raw_value(&serde_json::json!({})).expect("args")),
				None,
			)
			.expect("learn");
		session
			.settle(learn, serde_json::value::to_raw_value(&serde_json::json!({})).expect("outcome"))
			.expect("settle learn");
		assert!(!should_schedule_autolearn(session.dom(), turn, 2));
	}

	#[test]
	fn edit_streaming_abort_only_fires_when_enabled_and_irrecoverably_invalid() {
		let disabled = context(false);
		let enabled = context(true);
		assert!(!streamed_edit_must_abort(Some(&disabled), "edit", r#"{"input":]"#));
		assert!(streamed_edit_must_abort(Some(&enabled), "edit", r#"{"input":]"#));
		assert!(!streamed_edit_must_abort(Some(&enabled), "edit", r#"{"input":"#));
		assert!(!streamed_edit_must_abort(Some(&enabled), "read", r#"{"input":]"#));
	}
}

pub(crate) const fn cancelled_outcome() -> TurnOutcome {
	TurnOutcome {
		stop:           TurnStop::Cancelled,
		assistant_text: Str::new_static(""),
		tokens_in:      0,
		tokens_out:     0,
	}
}
