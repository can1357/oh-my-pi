//! Core-owned extension-host lifecycle, CONTROL accounting, and service
//! routing.
//!
//! Process ownership remains in [`crate::worker::ExtHostSupervisor`].
//! Children are spawned lazily at a declared surface's first reach.

pub mod backends;
pub mod cancel;
pub mod control;
pub mod dispatch;
pub mod extensions;
pub mod lifecycle;
pub mod params;
pub mod presentation;
pub mod quota;
pub mod services;
pub mod spawn;
pub use cancel::{
	CANCEL_GRACE, CancelStage, CancellationError, CancellationJournal, CancellationLadder,
	CancellationOutcome, MAX_KILL_ESCALATIONS_PER_SESSION,
};
pub use control::{
	ControlAuthority, ControlAuthorityFactory, ControlCompositionError, ConvarControlFactory,
	EnvdControlAuthorities, ExternalControlAuthorities, FixedControlAuthorityFactory,
	HostControlAuthorityFactory, PersistenceControlAuthorities, PolicyControlAuthorities,
	PresentationControlAuthorities, ProviderControlAuthorities, RegistryControlAuthorities,
};
pub use dispatch::{
	CallbackConcurrency, DispatchError, DispatchPending, DispatchRequest, DispatchRouter,
	EventDeadline, PromptContributionProvider, PromptContributionRecord, PromptDispatchError,
	PromptPullContext, PromptSlotBinding, UiCallbackDispatch, UiCallbackOwner, UiCommandRosterEntry,
	UiCompletionRosterEntry, UiDispatchError, UiMessageRendererRosterEntry, UiRendererRosterEntry,
	UiRoster, UiRosterConflict, UiShortcutRosterEntry, decode_ui_dispatch_result,
	prompt_dispatch_arguments, shortcut_dispatch_succeeded,
};
pub use extensions::{
	DEFAULT_EXTENSION_HOOK_TIMEOUT, ExtensionConvarError, PyComponent, PyDirector, PyExtensionError,
	SealedHookRegistration, SealedRegistryEvidence, SealedRegistryEvidenceError,
	register_extension_setting_convars, seal_registry_evidence,
};
pub use lifecycle::{
	ActivateReason, ActivationCause, ActivationDisposition, ActivationEvent, ActivationTrigger,
	AvailabilityBatch, AvailabilitySink, ControlLifecycleHost, DeclarationDrift, DeclarationSet,
	ExtensionManifest, GenerationFence, HookDeclarationKey, LifecycleError, LifecycleHost,
	LifecycleMachine, Principal, PrincipalAuthority, PrincipalMismatch, RegistryAvailabilitySink,
	RestartReason, ToolDeclarationKey, UiRegistrationError, VerifiedMarkdownTransformer,
	VerifiedMessageRendererDeclaration, VerifiedRendererDeclaration, VerifiedUiRoster,
	verify_ui_registration,
};
pub(crate) use lifecycle::{notify_extension_load, notify_extension_unload, notify_host_reconnect};
pub use params::{
	DIRECT_FILESYSTEM_CAPABILITY, DirectFilesystemAuthorityError, DirectFilesystemControlOwner,
	DirectFilesystemEntry, DirectFilesystemExecutor, DirectFilesystemJournal,
	DirectFilesystemOutput, DirectFilesystemStat, MAX_PENDING_PARAMETER_PULLS,
	ParameterAuthorityError, ParameterControlOwner, ParameterOperation, ParameterPathPart,
	ParameterPullRequest, ParameterPullResult, ParameterSource,
};
pub use presentation::{
	JobsControlAuthority, JobsControlOwner, TelemetryControlAuthority, TelemetryControlRequest,
	UiControlAuthority, UiControlOwner, UiControlRequest, UiControlResult,
};
pub use quota::{
	ChargeOutcome, ControlQuotaLedger, ControlQuotaRuntime, FairControlQueue, QuotaBehavior,
	QuotaError, QuotaExceeded, QuotaReceiptUpdate, QuotaScope, QuotaSpec, QuotaStatus,
	ResourceReceipt, request_quota,
};
pub use services::{
	PendingServiceCall, ServiceBroker, ServiceCallError, ServiceCallId, ServiceCancellation,
	ServiceConnection, ServiceDeclarationDrift, ServiceDispatch, ServiceError, ServiceKey,
	ServiceManifest, ServiceRequestMeta, ServiceResponse, ServiceRoute, ServiceTransport,
};
pub use spawn::{
	CONTROL_FD_ENV, ENV_SOCKET_ENV, EXT_HOST_ARG, HostChildLimit, HostLog, HostLogStream,
	PY_SITE_ENV, RunningHost, RunningHostError, SpawnError, SpawnSpec, SpawnedHost,
	run_ext_host_entry,
};

pub use crate::worker::{
	ControlHostStartError, ExtHostSupervisor, ExternalControlAuthorityBinding,
	ExternalDomainControlBinding, ExternalDomainControlFactories, HostKey,
};
