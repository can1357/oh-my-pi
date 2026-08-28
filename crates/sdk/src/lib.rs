//! Stable native embedding facade for OMP sessions.
//!
//! This crate exposes owned semantic inputs and authority-preserving callback
//! seams. Provider codecs, credential stores, application composition, UI
//! internals, and mutable transcript arrays are intentionally not exported.

pub mod callbacks;
pub mod discovery;
pub mod eval;
pub mod model;
pub mod prompt;
pub mod session;
pub mod tools;
pub mod workspace;

pub use bytes::Bytes;
pub use callbacks::{
	AccountId, CallbackSet, ContextPatchCommit, ContextPatchError, ContextPatchHandler,
	CredentialCallback, CredentialError, CredentialFuture, CredentialLease, CredentialNeed,
	CredentialRequest, EventCallback, FirstDispatchCallback, LeaseMeta, LocalProtocolResolver,
	PrincipalId, ProtocolResolution, RequestTuning, RequestTuningCallback, RequestTuningError,
	RequestTuningInput, RuntimeCallbacks, SdkCredentialSource, SecretString, SystemPromptCallback,
	UiContextCallback, UiContextUpdate, UsageConfirmationCallback, UsageConfirmationDecision,
	UsageConfirmationFuture, UsageConfirmationRequest,
};
pub use discovery::{
	AssetKind, DiscoveryError, DiscoveryLoader, DiscoveryRequest, DiscoveryScope, NativeAsset,
};
pub use model::{
	Dialect, DialectEvent, DialectStage, ModelPlan, ModelPlanError, ToolEnvelope, resolve_model_plan,
};
pub use omp_agent::{
	AgentEvent, AgentSnapshot, Anchor, ContextView, InheritPosition, Item, Journal, PatchOp,
	PromptError, PromptHash, PromptPatchSet, Props, RenderedPrompt, RpcTurnClient, SlotClass,
	SlotId, SlotPatch, Thread,
};
pub use omp_catalog::{
	AuthSpecId, Catalog, ModelKey, ModelRole, ProviderId, RouteId, SelectedModel,
	SelectionCandidate, SelectionError,
};
pub use omp_core::{Hash32, Str, Ulid};
pub use omp_env::EnvClient;
pub use omp_proto::thread::v1::Role;
pub use omp_tool::{
	CapsBase, Claims, Constraint, Effects, Ev, IncomingParams, LiftedCall, Part, Presentation,
	PromptCaps, RecordedCall, Registry, RegistryError, Rev, Tool, ToolPromptExample, ToolSpec,
	ToolTerminal, native_projection_code, schema,
};
pub use prompt::{PromptCompiler, PromptContribution, PromptPatchError};
pub use session::{
	AgentIdentity, DiscoveryPolicy, LaunchDiagnostic, LspSessionBinding, LspWarmupStatus,
	ModelCandidateState, ModelFallbackDiagnostic, ProductionCallbackBoundary,
	ProductionSessionComposition, ProductionSessionError, ServiceTierDiagnostic, SessionBlueprint,
	SessionBuildError, SessionBuilder, SessionCreateError, SessionDiagnostics, SessionHandle,
	SessionHandleError, SessionIdentity, SessionLifecycle, SessionLifecycleSubscription,
	SessionOptions, SessionPolicies, SessionRevivalError, SessionRevivalFactory,
	SessionRevivalFuture, SessionRevivalRequest, SessionRuntime, SubsystemToggles, ThinkingCeiling,
	ThinkingDiagnostic, WorkspaceRootDescriptor,
};
pub use tools::{
	AutoLearnCaptureDrainError, AutoLearnCaptureError, AutoLearnCaptureExecutor,
	AutoLearnCaptureHandle, AutoLearnCaptureRequest, AutoLearnCaptureRunner,
	AutoLearnCaptureSnapshot, CustomToolDefinitionError, ToolRegistryBuilder,
	custom_tool_to_definition,
};
pub use url::Url;
pub use workspace::{FormattedWorkspaceTree, WorkspaceTreeBuilder, WorkspaceTreeError};
