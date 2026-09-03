#![feature(integer_atomics)]
//! Transport-neutral foundations for durable, interruptible OMP agent loops.
//!
//! The crate composes immutable configuration snapshots, deterministic system
//! prompts, ordered interrupts, event fan-out, journal projection, tool-batch
//! supervision, detached jobs, and the live turn transport. Durable history is
//! canonical [`Item`] data; provider, application, and UI types stay outside
//! this boundary. [`Agent`] is the durable policy loop tying these foundations
//! into complete N-turn conversations.

#[allow(unused_imports, reason = "macro_use imports are consumed by generated and test modules")]
#[macro_use]
extern crate omp_core;

pub mod advisor;
mod approvals;
pub mod arbiter;
pub mod attachments;
mod autolearn;
mod batch;
pub mod branch_summary;
mod broker;
mod compact;
pub mod context;
mod continuation;
pub mod control;
pub(crate) mod duplex;
mod events;
pub mod handoff;
mod hooks;
mod inproc;
mod jobs;
mod journal;
pub mod journal_kinds;
pub mod lifecycle;
mod r#loop;
mod mailbox;
mod name;
mod oneshot;
mod phases;
mod project;
mod prompt;
pub mod prompt_assets;
pub mod prompt_engine;
pub mod prompt_keys;
mod read_only_policy;
pub mod regime;
mod revival;
mod schedule;
pub mod scheduler;
mod state;
mod stateful;
pub mod streaming_edit_guard;
mod subagent;
mod todo_restore;
pub mod tool_choice;
mod tree;
pub mod ttsr;
mod turn;
pub mod voice;

pub use approvals::{
	ApprovalBook, ApprovalDecision, ApprovalGuard, ApprovalInbox, ApprovalRequest, ApprovalRoute,
	ApprovalSource, ApprovalSpec, ApprovalTicket, TicketState,
};
pub use arbiter::{Arbiter, ArbiterError, PointCx, RegimeFact, StreamPart};
pub use attachments::{
	Attachment, AttachmentError, AttachmentIndex, DEFAULT_PROVIDER_IMAGE_BUDGET,
	MAX_TRANSIENT_IMAGE_BYTES, NormalizeAttachmentError, NormalizedAttachmentImage,
	clamp_provider_images, describe_images_for_text_model, normalize_latest_inline_images,
	provider_image_budget,
};
pub use autolearn::{
	AutolearnController, AutolearnSettings, CAPTURE_PROP, CaptureDecision, DEFAULT_MIN_TOOL_CALLS,
	capture_interrupt, is_capture_item, standing_guidance,
};
pub use batch::{
	BatchError, BatchResult, CommittedCall, EXECUTION_MODE_PROP, InvocationAdmission,
	InvocationHookBus, InvocationHookRequest, PLAN_YOLO_PROP, PREWALK_REASON_PROP, SpeculativeCall,
	ToolBatch, effects_mutate_environment, hook_event_mask, invocation_mode_props,
};
pub use broker::{
	AgentHistory, AgentRecord, AgentRegistry, Broker, BrokerError, BrokerInbox, CollabAgentKind,
	CollabAgentRecord, CollabRegistrySnapshot, DeliveryMode, DeliveryReceipt, DiscoveryDiagnostic,
	DiscoveryDiagnosticKind, ParkLease, PeerMessage, Receipt, RegistryError, RegistryStatus,
	RevivalRequest, RoutedEvent, now_ms as broker_now_ms, peer_item,
};
pub use compact::{
	COMPACTION_RECOVERY_BAND, CancelCompaction, CompactionBoundary, CompactionCancellation,
	CompactionCoordinator, CompactionDecision, CompactionEvent, CompactionHysteresis,
	CompactionMethodOrder, CompactionReason, CompactionResolution, CompactionSpeculationOptions,
	CompactionTier, CompactionVerdict, ContextUsage, ContextUsageBreakdown, CustomSummary,
	DelegateCompaction, IDLE_PRUNE_AFTER, ItemUsage, LosslessPlan, LosslessReceipt,
	ManualCompactionDecision, ManualCompactionError, ManualCompactionMode, ManualCompactionOutcome,
	ManualCompactionRequest, ManualShakeMode, ManualShakeOutcome, PROMPT_CACHE_WARM_SUFFIX_TOKENS,
	ProjectionItem, RemoteCheckpoint, SNAPCOMPACT_TIER, SPECULATION_LEAD_FRACTION,
	SPECULATION_LEAD_MAX_TOKENS, SPECULATION_LEAD_MIN_TOKENS, SnapcompactOutcome,
	SnapcompactPreparation, SpeculationRequest, SpeculationResult, SpeculationSnapshot,
	SpeculationState, SupersededCompaction, back_project_provider_usage, boundary_reason,
	dispatch_tier, encode_domain_verdict, execute_snapcompact, plan_lossless,
	plan_lossless_with_warm_suffix, resolve_verdicts, speculation_lead_tokens,
};
pub use context::{
	Anchor, ContextPatchSet, ContextProjection, ContextProjectionError, ContextProjectionHandler,
	ContextSnapshot, ContextSnapshotError, ContextView, InheritPosition,
	InterruptedReasoningDialect, MessageKind, MessageRef, PatchOp, PatchOutcome, PatchRejected,
	RefFlags, apply_patches, demote_interrupted_reasoning, external_thinking_for_model,
	inject_first_turn_metadata, project_context,
};
pub use continuation::{
	AgentSettledEvent, Continuation, ContinuationLedger, ContinuationPolicy, ContinuationSource,
	LoopSignal, RedemptionAuthority, RedemptionEvidence, RedemptionFuture, SettledFold,
	SettledParticipant, continues_loop, from_hook,
};
pub use control::{
	ControlError, ControlMailbox, ControlMailboxEvent, ControlSender, RewindAck,
	channel as control_channel,
};
pub use events::{
	AgentEvent, AgentPhase, AgentRunState, CollabEvent, CollabEventSubscription,
	CollabEventVisibility, EventBus, EventProvenance, EventSubscription, EventVisibility,
	LossyEventSubscription, PeerRelayObservation, PlanState,
};
pub use hooks::{
	AgentSettled, Composition, ContextPatch, DomainReturn, GateDecision, GateError, GateEvent,
	GateOutcome, HookDispatch, HookEvent, HookGate, HookPatch, MODIFY_ROUNDS, OBSERVE_HANDLER_CAP,
	OnFailure, ProviderErrorEvent, ProviderFailover, SourceRef, Subscription, TransformTrail, When,
};
pub use inproc::{InProcTurnClient, RpcTurnClient, RpcTurnSession};
pub use jobs::{
	CancelOutcome, JobBoard, JobClaimError, JobError, JobSettlement, JobWatch, PendingJobs,
	SettlementLease,
};
pub use journal::{
	AbortDisposition, ChildKind, Compact, Journal, JournalAuthor, JournalCustomEntry, JournalError,
	JournalGenerations, JournalOperation, JournalQuery, JournalReply, JournalRequest,
	JournalRequestStamp, PendingCustomEntry, ReplicationEvent, ReplicationRecord,
	ReplicationSubscription, ReplicationTerminal, ReplicationVisibility, SessionStateValue,
	SessionStateWatchEvent, SessionStateWatchTerminal, TurnInputRecord, TurnOptionsRecord,
	TurnReceipt, TurnStart, WorkspaceRoots,
};
pub use journal_kinds::{EntryKindDecl, EntryKindError, EntryKindRegistry, KindRecord, LiftHook};
pub use lifecycle::{
	MAX_MEMORY_EXTRACTION_ITEMS, MemoryExtractionWindow, MemoryExtractionWindowError,
	MemoryHookEvent, MemoryHooks, PromptMemoryQuery, PromptMemorySnapshotSource, ShutdownOutcome,
	ShutdownStage, ShutdownTask, shutdown_ordered,
};
pub use r#loop::{
	AbortHandle, Agent, AgentError, AgentHostControl, AgentRunSummary, RewindTarget, RunActivity,
	RunSettlement, TurnDifficultyClassifier, UnexpectedStopClassifier,
};
pub use mailbox::{
	DEFERRED_DIAGNOSTIC_DOCUMENT_PROP, DEFERRED_DIAGNOSTIC_GENERATION_PROP,
	DEFERRED_DIAGNOSTIC_REVISION_PROP, DeferredCommand, DeferredCommandKind, DeferredCommands,
	DeferredContext, DeferredSettlement, DeferredSettlementStatus, DrainPoint, Interrupt,
	InterruptClass, InterruptSource, Mailbox, MailboxSender, REMOTE_DISPLAY_NAME_PROP,
	REMOTE_PEER_ID_PROP, REMOTE_PRINCIPAL_PROP, REMOTE_ROOM_ID_PROP, deferred_diagnostics_interrupt,
	device_availability_interrupt, remote_principal_interrupt,
};
pub use name::{AgentNameAllocator, AgentNameError};
pub use omp_inference::TurnId;
pub use omp_proto::{
	inference::v1::{
		Accepted, ChatParams, ContextRef, ExecStatus, Executor, Invoke, InvokeCancel, InvokeComplete,
		InvokeInput, Outcome, ThreadDelta, TurnError, TurnEvent,
	},
	thread::v1::{Item, Thread},
};
pub use omp_scribe::Props;
pub use omp_storage::transcript::ModelChange;
pub use oneshot::{
	Completion, CompletionError, CompletionRequest, resolve_completion, select_choice,
};
pub use phases::{
	ActivateReason, HookDecision, HookPhase, InvocationPhase, LifecyclePhase, Point, PointSet,
	RestartReason,
};
pub use project::{
	ProjectionError, project_journal, project_thread_history, render_compaction_summary,
	tool_result_item, tool_result_item_canonical_parts, truncate_item_for_persistence,
};
pub use prompt::{
	ActiveRepositoryInput, BandHash, CachedContribution, CanonicalPromptSource, ContextFile,
	ConventionsPromptSource, DeliveryPromptSource, EagerTaskPolicy, HostInfoInput, ModelPromptInput,
	MutationPromptInput, Personality, PolicyPromptSource, ProjectPromptSource, PromptBands,
	PromptCapabilitiesInput, PromptDelegationInput, PromptDeviceInput, PromptError, PromptFacts,
	PromptHash, PromptMemoryInput, PromptMemorySlotInput, PromptNamedInput, PromptOut,
	PromptPatchSet, PromptSchemeInput, PromptSettingsInput, PromptSlotSource, PromptSource,
	PromptToolExampleInput, PromptToolInput, RenderedPrompt, RepositoryInput, RolePromptSource,
	RuntimePromptSource, SECURITY_REVIEW_INSTRUCTION_V1, SlotAssembler, SlotClass, SlotDecl, SlotId,
	SlotPatch, SlotRegistration, SlotSource, ToolInventoryMode, VcsIdentity, VolatilePrompt,
	VolatilePromptJournal, WorkflowPromptSource, WorkspacePromptSource, WorkspaceRootInput,
	WorkspaceRootsInput, WorkspaceTreeInput, dedupe_context_file_indices, render_prompt,
};
pub use read_only_policy::is_read_only_agent;
pub use regime::{
	AcquireOutcome, ActivationId, BuiltinRegime, DeclareError, GoalRegime, GoalRegimeState, Next,
	QuiescenceBarrier, RESOURCE_TABLE, Regime, RegimeContext, RegimeError, RegimeFailure, RegimeId,
	RegimeLifetime, RegimeRecord, RegimeSet, RegimeSpec, RegimeStateError, RegimeStatus,
	RegimeStepResult, RegimeWhen, Resource, ResourceDecl, ResourceRegistry, RevivalReport,
	ScopedSetting, SettingSlot, StartError, StartOptions, StartReceipt, StopError,
	SubagentYieldRegime, WaitError, WaitSet, WaitTicket, autoresearch_regime_spec, core_regime,
	goal_regime_spec, plan_regime_spec, prewalk_regime_spec, vibe_regime_spec,
};
pub use revival::{RevivalError, RevivedSession, revive, revive_existing};
pub use schedule::{
	Firing, FiringOutcome, MissedRunPolicy, Schedule, ScheduleBudget, ScheduleDelivery,
	ScheduleError, ScheduleJournal, ScheduleScope, Scheduler, Trigger, UpgradePolicy, firing_key,
};
pub use state::{
	AgentSnapshot, AgentState, ContextPromotionPolicy, MidTurnCompactionPolicy, RetryPolicy,
	RetryPolicyError, SteeringMode, UnexpectedStopMode,
};
pub use stateful::{RestoreFuture, StatefulComponent};
pub use streaming_edit_guard::{StreamingEditAbort, StreamingEditDialect, StreamingEditGuard};
pub use subagent::{
	MAX_DISPOSITION_PREVIEW_BYTES, MAX_PROGRESS_ACTIVITY_BYTES, MAX_TERMINAL_SUMMARY_BYTES,
	SubagentActivity, SubagentActivityKind, SubagentDisposition, SubagentGeneration,
	SubagentLifecycle, SubagentProgressSnapshot, SubagentRunEvent, SubagentRunEventKind,
	SubagentRunState, SubagentStateError, SubagentTerminalKind, SubagentTerminalStatus,
};
pub use todo_restore::TodoRestore;
pub use tree::{
	AgentAuxiliary, AgentDefinition, AgentDefinitionError, AgentKind, AgentModelPurpose, AgentNode,
	AgentStatus, AgentTree, AgentTreeLimits, AssembledYield, Budget, BudgetCeiling, BudgetExceeded,
	BudgetRemainder, DEFAULT_MAX_ADMISSION_QUEUE, DEFAULT_MAX_CONCURRENCY, EffectsOperation,
	MAX_YIELD_SCHEMA_RETRIES, OutputSchemaResolution, OutputSchemaSource, SpawnPermit, SpawnPolicy,
	SpawnRefusal, TreeStatistics, Usage, YieldAssembler, YieldAssemblyError, YieldPayload,
	YieldPayloadError, YieldPayloadValidator, enforce_minimum_phase, resolve_output_schema,
};
pub use ttsr::{
	StreamSource, TtsrCompileError, TtsrContextMode, TtsrInterruptMode, TtsrMatch, TtsrMatchContext,
	TtsrRegistry, TtsrRepeatMode, TtsrRule, TtsrSettings,
};
pub use turn::{
	Error, InvokeFrame, PROVIDER_RESET_PROP, Recovery, StreamWatchdog, TurnClient, TurnInput,
	TurnOptions, TurnSession, empty_stop,
};
