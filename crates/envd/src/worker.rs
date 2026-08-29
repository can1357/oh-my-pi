//! Supervision and same-binary execution for Python tool workers.

use std::{
	collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
	env,
	ffi::CString,
	fmt,
	io::{self, Read, Write},
	iter, mem,
	num::NonZeroUsize,
	path::{Path, PathBuf},
	process::{self, Stdio},
	str,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::{Bytes, BytesMut};
use flume::Receiver;
#[cfg(unix)]
use nix::sys::signal;
#[cfg(unix)]
use nix::unistd::Pid;
use notify::{RecursiveMode, Watcher as _};
use omp_agent::{GateError, HookEvent, HookGate, HookPatch};
use omp_core::{
	CowBytes, Duration as CoreDuration, DurationUnit, InvocationPhase, LifecyclePhase, Principal,
	RestartReason, Str, sf,
};
use omp_inference::recovery::tools::{ToolAssemblyLimits, validate_schema};
use omp_proto::{
	env::v1::{ArgText, ArgsCommitted, Interrupt},
	inference::v1::{ToolDef, Value, ValueMap, tool_def, value},
	prost::Message,
	thread::v1::{Blob, Part, part},
	toolhost::{
		v1,
		v1::{
			ActivateExtension, ActivateReason as WireActivateReason,
			ActivationCliValue as WireActivationCliValue, AdmitExtensions, AdmittedExtension,
			ArgIssue, ArgumentHostEnvelope, ArgumentWorkerEnvelope, CancelTool, ContextHostEnvelope,
			ContextWorkerEnvelope, ExtensionActivated, ExtensionDecl, FreezeDeclarations, HostFrame,
			InvokeTool, JournalHostEnvelope, LifecycleHostEnvelope, OutcomeKind, Ping, Pong,
			PreludeParam, PreludeParamKind, PrincipalRef, PromptContribution, ProtocolError,
			ProtocolErrorCode, PullReply, PullRequest, QuotaDrop, QuotaStatus, RegimeApply,
			RegimeControl, RegimeControlKind, RegimeDraft, RegimeEffect, RegimeEffectKind,
			RegimeHostEnvelope, RegimeStart, RegimeStop, RegimeWorkerEnvelope, RegisterTools,
			ResourceUpdate, RestartReason as WireRestartReason,
			ServiceDispatch as WireServiceDispatch, ServiceReply, ServiceResult, ToolAborted,
			ToolArgs, ToolComplete, ToolDecl, ToolUpdate, UiHostEnvelope, UiWorkerEnvelope,
			WorkerFrame, WorkerHello, activation_cli_value, argument_host_envelope,
			argument_worker_envelope, context_host_envelope, context_worker_envelope, host_frame,
			lifecycle_host_envelope, lifecycle_worker_envelope, regime_host_envelope,
			regime_worker_envelope, ui_host_envelope, ui_worker_envelope, worker_frame,
		},
	},
	ui::v1::{
		CommandArgDecl, CommandDecl, CommandDispatchResult, CompletionCandidate, RegisterUi,
		ShortcutDecl, ShortcutDispatchResult, TriggerDecl, UiDispatchResult, UiError,
		command_dispatch_result, ui_dispatch, ui_dispatch_result,
	},
};
use omp_tool::{Rev, ToolIdentity};
use omp_tools::read::resolver::SchemeSnapshot;
use parking_lot::{Mutex, RwLock};
use pyo3::{
	exceptions::{PyImportError, PyKeyError, PyTypeError, PyValueError},
	intern,
	prelude::*,
	types::{PyBytes, PyDict, PyIterator, PyList, PyModule, PyString},
	wrap_pyfunction,
};
use serde::Deserialize;
use thiserror::Error;
use tokio::{
	io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
	process::{Child, ChildStdin, ChildStdout, Command},
	runtime,
	task::JoinHandle,
	time,
	time::{Instant, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;
use url::Url;
#[cfg(windows)]
use windows_sys::Win32::System::Console;

use super::exthost::{DispatchError, control::ControlRuntimeError};
use crate::{
	exthost::{
		ActivationCause, ActivationEvent, ActivationTrigger, AvailabilityBatch, AvailabilitySink,
		CallbackConcurrency, ControlAuthority, ControlAuthorityFactory, ControlCompositionError,
		ControlQuotaLedger, DeclarationSet, ENV_SOCKET_ENV, EventDeadline, ExtensionManifest,
		GenerationFence, HostControlAuthorityFactory, LifecycleHost, RunningHost, RunningHostError,
		ServiceBroker, ServiceCallId, ServiceConnection, ServiceKey, ServiceRequestMeta,
		ServiceResponse, SpawnSpec, SpawnedHost, ToolDeclarationKey, VerifiedMarkdownTransformer,
		VerifiedRendererDeclaration, VerifiedUiRoster,
		control::{
			ActivationCliValue, ContributedValueDelivery, ControlAuthoritySnapshot,
			ControlConnectionIdentity, ControlDispatch, ControlEffect, ControlHandle,
			ControlInvocationAuthority, ControlProtocolError, ControlRequestContext,
			ExternalJournalRequest, JournalConnectionIdentity, JournalControl, JournalDispatch,
			journal_rows,
		},
		dispatch::{
			CallbackDispatcher, PROMPT_CONTEXT_PROP, PROMPT_KEY_PROP, PROMPT_OWNER_PROP,
			PromptContributionProvider, PromptContributionRecord, PromptDispatchError,
			PromptPullContext, PromptSlotBinding, REGIME_SUBMISSION_TIMEOUT, UiCallbackDispatch,
			decode_prompt_contribution, prompt_prop, prompt_pull_frame, prompt_slot_binding,
		},
		notify_extension_load, notify_extension_unload, notify_host_reconnect,
		services::{
			ServiceControlAuthorityFactory, ServiceDispatch, ServiceDispatchBackend,
			ServiceMethodSchema, ServiceProviderDeclaration,
		},
		spawn::spawn,
		verify_ui_registration,
	},
	policy::{AuthorityTable, Grants},
	tools::{
		HookControlFactory, HookEventPolicy, HookFailurePolicy, HookFieldComposition,
		HookSubscription, RegistryControlFactory,
	},
	worker_pool::WorkerUnavailable,
};
/// Child argv selector for the dedicated placed-Python worker runtime.
pub const WORKER_ARG: &str = "__omp-py-worker";

/// Python ABI revision required by this worker implementation.
#[cfg(target_os = "android")]
pub const PYTHON_REV: &str = "3.14";
/// Python ABI revision required by this worker implementation.
#[cfg(not(target_os = "android"))]
pub const PYTHON_REV: &str = "3.14t";
/// Canonical import name for the opt-in built-in Python evaluation tool.
pub const PY_EVAL_MODULE: &str = "omp_py_eval";

/// Default upper bound for one encoded tool-host frame.
pub const DEFAULT_MAX_FRAME_BYTES: usize = omp_proto::bounds::FRAME_MAX_BYTES;

/// Stable identity of one extension host.
#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct HostKey(Arc<HostKeyFields>);

#[derive(Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct HostKeyFields {
	/// Extension layer, such as project or user.
	layer:     Str,
	/// Trust or sandbox tier.
	tier:      Str,
	/// Stable extension identity.
	extension: Str,
}

impl fmt::Debug for HostKey {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("HostKey")
			.field("layer", self.layer())
			.field("tier", self.tier())
			.field("extension", self.extension())
			.finish()
	}
}

const _: () =
	assert!(std::mem::size_of::<HostKey>() <= 16, "HostKey must remain a cheap identity handle");

impl HostKey {
	/// Builds a host identity.
	pub fn new(layer: impl Into<Str>, tier: impl Into<Str>, extension: impl Into<Str>) -> Self {
		Self(Arc::new(HostKeyFields {
			layer:     layer.into(),
			tier:      tier.into(),
			extension: extension.into(),
		}))
	}

	/// Returns the extension layer, such as project or user.
	pub fn layer(&self) -> &Str {
		&self.0.layer
	}

	/// Returns the trust or sandbox tier.
	pub fn tier(&self) -> &Str {
		&self.0.tier
	}

	/// Returns the stable extension identity.
	pub fn extension(&self) -> &Str {
		&self.0.extension
	}

	/// Returns the ordered identity fields used by scoped binding derivation.
	pub fn fields(&self) -> [&str; 3] {
		[self.layer().as_str(), self.tier().as_str(), self.extension().as_str()]
	}
}

/// Configuration of one active extension.
#[derive(Clone, Debug)]
pub struct ExtHostSpec {
	/// Stable extension identity.
	pub key:               HostKey,
	/// Authoritative deployment manifest; never inferred from child frames.
	pub manifest:          ExtensionManifest,
	/// Explicit opt-in fate-sharing pool. Absence isolates this extension.
	pub pool:              Option<Str>,
	/// Manifest-derived DATA capabilities for this extension.
	pub data_grants:       Grants,
	/// Optional site-packages directory passed through as `OMP_PY_SITE`.
	pub python_site:       Option<PathBuf>,
	/// Exact entry file preloaded under the manifest module name.
	pub entry_path:        Option<PathBuf>,
	/// Scoped DATA socket passed only to this extension host.
	pub data_socket:       Option<PathBuf>,
	/// Explicit trusted host executable, or the environment executable.
	pub host_executable:   Option<PathBuf>,
	/// Authenticated static CLI declarations owned by this extension.
	pub cli_contributions: omp_ext::config::CliContributionSet,
	/// Immutable non-secret settings resolved during manifest admission.
	pub settings:          serde_json::Map<String, serde_json::Value>,
	/// Linked source root watched for supervised hot reload.
	pub watch_root:        Option<PathBuf>,
}

impl ExtHostSpec {
	/// Builds an isolated extension configuration from an authenticated
	/// manifest.
	pub fn new(key: HostKey, manifest: ExtensionManifest) -> Self {
		Self {
			key,
			manifest,
			pool: None,
			data_grants: Grants::default(),
			python_site: None,
			entry_path: None,
			data_socket: None,
			host_executable: None,
			cli_contributions: omp_ext::config::CliContributionSet::default(),
			settings: serde_json::Map::new(),
			watch_root: None,
		}
	}
}
/// One journal backend request emitted by an authenticated extension host.
///
/// The receiver must send exactly one fused reply sequence. Every sequence is
/// written to the requesting host in order on its existing CONTROL stream.
pub struct ExternalJournalCall {
	/// Core-stamped request with no worker-supplied principal fields.
	pub request:  ExternalJournalRequest,
	/// Authenticated principal, provenance, and generation fences for backend
	/// authority.
	pub identity: JournalConnectionIdentity,
	/// Ordered response stream; dropping the last sender fuses the host stream.
	pub reply:    flume::Sender<Result<JournalHostEnvelope, Str>>,
}

/// Agent-Journal and storage-backend handles installed into extension hosts.
#[derive(Clone)]
pub struct JournalRuntime {
	/// Serialized Agent Journal mailbox sender.
	pub agent:    omp_agent::control::ControlSender,
	/// Environment composition endpoint for session indexes, state, usage, and
	/// artifacts.
	pub external: flume::Sender<ExternalJournalCall>,
}
#[derive(Clone)]
struct BoundJournalRuntime {
	id:      u64,
	runtime: JournalRuntime,
}

struct JournalRuntimeSlot {
	binding:   Option<BoundJournalRuntime>,
	was_bound: bool,
}

struct ServiceRouter {
	broker: Arc<Mutex<ServiceBroker>>,
	routes: Mutex<BTreeMap<HostKey, ProviderRoute>>,
}

#[derive(Clone)]
struct ProviderRoute {
	process_id: ProcessKey,
	commands:   flume::Sender<SupervisorCommand>,
	generation: Arc<AtomicU64>,
}

#[async_trait::async_trait]
impl ServiceDispatchBackend for ServiceRouter {
	async fn activate(&self, provider: &HostKey, _service: &ServiceKey) -> Result<(), Str> {
		let route = self
			.routes
			.lock()
			.get(provider)
			.cloned()
			.ok_or_else(|| sf!("service provider is unavailable"))?;
		if route.generation.load(Ordering::Acquire) == 0 {
			return Err(sf!("service provider has no live generation"));
		}
		Ok(())
	}

	async fn dispatch(&self, dispatch: ServiceDispatch) -> Result<ServiceResponse, Str> {
		let provider = self
			.routes
			.lock()
			.get(&dispatch.route.provider)
			.cloned()
			.ok_or_else(|| sf!("service provider is unavailable"))?;
		let provider_generation = provider.generation.load(Ordering::Acquire);
		if provider_generation != dispatch.route.provider_generation {
			return Err(sf!("service provider generation is stale"));
		}
		let deadline = dispatch
			.meta
			.deadline
			.to_std()
			.map_err(|_| sf!("service deadline exceeds host duration"))?;
		let deadline_ms = deadline.as_millis().try_into().unwrap_or(u64::MAX);
		let request_id = dispatch.id.0;
		let wire = WireServiceDispatch {
			provider_extension_id: dispatch.route.provider.extension().to_string(),
			service: dispatch.route.service.name.to_string(),
			rev: dispatch.route.service.rev,
			method: dispatch.method.to_string(),
			payload: dispatch.payload.into_owned().to_vec().into(),
			deadline_ms,
			caller_request_id: request_id,
			caller_host_generation: dispatch.meta.host_generation,
			session_generation: dispatch.meta.session_generation,
			provider_generation,
			props: None,
		};
		let (reply, response) = flume::bounded(1);
		provider
			.commands
			.send_async(SupervisorCommand::ServiceDispatch { request_id, frame: wire, reply })
			.await
			.map_err(|_| sf!("service provider command channel closed"))?;
		let result = time::timeout(deadline, response.recv_async())
			.await
			.map_err(|_| sf!("service call deadline elapsed"))?
			.map_err(|_| sf!("service provider response channel closed"))?
			.map_err(|error| Str::from(error.to_string()))?;
		if result.caller_request_id != request_id || result.provider_generation != provider_generation
		{
			return Err(sf!("provider ServiceResult identity is stale"));
		}
		if let Some(error) = result.error {
			if !result.payload.is_empty() {
				return Err(sf!("provider ServiceResult carries both payload and error"));
			}
			Ok(ServiceResponse::Failure(Str::from(error.message)))
		} else {
			Ok(ServiceResponse::Success(CowBytes::from(result.payload)))
		}
	}
}

/// Driver/app-owned CONTROL factories installed before declaration-dependent
/// extension hosts start.
#[derive(Clone, Default)]
pub struct ExternalDomainControlFactories {
	/// Policy mutation and approval-decision owner.
	pub policy:            Option<Arc<dyn ControlAuthorityFactory>>,
	/// Invocation parameter cursor owner.
	pub parameters:        Option<Arc<dyn ControlAuthorityFactory>>,
	/// Named worker placement/process owner.
	pub workers:           Option<Arc<dyn ControlAuthorityFactory>>,
	/// Audited trusted direct-filesystem owner.
	pub direct_filesystem: Option<Arc<dyn ControlAuthorityFactory>>,
	/// Opaque credential and secret resolution owner.
	pub credentials:       Option<Arc<dyn ControlAuthorityFactory>>,
	/// Typed system-prompt contribution owner.
	pub prompts:           Option<Arc<dyn ControlAuthorityFactory>>,
	/// Interactive session create/seed/switch owner.
	pub sessions:          Option<Arc<dyn ControlAuthorityFactory>>,
	/// Interactive UI compositor owner.
	pub ui:                Option<Arc<dyn ControlAuthorityFactory>>,
	/// Durable telemetry query/export owner.
	pub telemetry:         Option<Arc<dyn ControlAuthorityFactory>>,
	/// Job-board owner.
	pub jobs:              Option<Arc<dyn ControlAuthorityFactory>>,
	/// Inference provider mutation owner.
	pub provider:          Option<Arc<dyn ControlAuthorityFactory>>,
	/// Session/turn regime owner.
	pub regimes:           Option<Arc<dyn ControlAuthorityFactory>>,
	/// Inter-extension service broker owner.
	pub services:          Option<Arc<dyn ControlAuthorityFactory>>,
}

struct DomainControlBinding {
	id:        u64,
	factories: ExternalDomainControlFactories,
}

pub(crate) struct DomainControlSlot {
	next_id: AtomicU64,
	binding: Mutex<Option<DomainControlBinding>>,
}

impl DomainControlSlot {
	fn new() -> Arc<Self> {
		Arc::new(Self { next_id: AtomicU64::new(1), binding: Mutex::new(None) })
	}

	pub(crate) fn snapshot(&self) -> Option<(u64, ExternalDomainControlFactories)> {
		self
			.binding
			.lock()
			.as_ref()
			.map(|binding| (binding.id, binding.factories.clone()))
	}

	pub(crate) fn is_live(&self, id: u64) -> bool {
		self
			.binding
			.lock()
			.as_ref()
			.is_some_and(|binding| binding.id == id)
	}

	fn install(
		self: &Arc<Self>,
		factories: ExternalDomainControlFactories,
	) -> ExternalDomainControlBinding {
		let id = self.next_id.fetch_add(1, Ordering::Relaxed);
		*self.binding.lock() = Some(DomainControlBinding { id, factories });
		ExternalDomainControlBinding { slot: Arc::clone(self), id }
	}
}

/// Sole-owner lease for the driver/app CONTROL factory bundle.
#[must_use]
pub struct ExternalDomainControlBinding {
	slot: Arc<DomainControlSlot>,
	id:   u64,
}

impl Drop for ExternalDomainControlBinding {
	fn drop(&mut self) {
		let mut binding = self.slot.binding.lock();
		if binding
			.as_ref()
			.is_some_and(|binding| binding.id == self.id)
		{
			*binding = None;
		}
	}
}

/// One atomic lease for Agents plus every driver/app CONTROL domain.
#[must_use]
pub struct ExternalControlAuthorityBinding {
	agents:  AgentsControlAuthorityBinding,
	domains: ExternalDomainControlBinding,
}

impl ExternalControlAuthorityBinding {
	/// Keeps both component leases alive for the same replacement lifetime.
	pub fn is_live(&self) -> bool {
		self.agents.slot.is_live(self.agents.id) && self.domains.slot.is_live(self.domains.id)
	}
}

/// Configuration for all active Python extension hosts.
#[derive(Clone)]
pub struct ExtHostConfig {
	/// Executable to re-enter. Defaults to the current executable.
	pub executable:         PathBuf,
	/// Authenticated daemon principal stamped core-side.
	pub principal:          omp_core::Principal,
	/// Stable active session identity.
	pub session_id:         Str,
	/// Active session generation fence.
	pub session_generation: u64,
	/// Session start timestamp used by activation events.
	pub session_started_at: SystemTime,
	/// Workspace root inherited by every placed worker process.
	workspace_root:         Option<PathBuf>,
	/// Active extensions. An empty set starts no Python process.
	pub extensions:         Vec<ExtHostSpec>,
	/// Typed launch values validated against the active extension manifests.
	pub contributed_values: Vec<omp_ext::config::ContributedCliValue>,
	/// Expected workspace protobuf schema revision.
	pub schema_rev:         u32,
	/// Expected embedded Python ABI revision.
	pub python_rev:         Str,
	/// Maximum accepted encoded frame size.
	pub max_frame_bytes:    NonZeroUsize,
	/// Time allowed for steady-state pings and individual frame reads.
	pub health_timeout:     Duration,
	/// Time allowed for a cold worker to complete hello, registration, and
	/// activation; spawn covers process exec plus embedded-interpreter boot, so
	/// it tolerates load the steady-state health deadline must not.
	pub spawn_timeout:      Duration,
	/// Idle interval between worker health probes.
	pub ping_interval:      Duration,
	/// Courtesy-interrupt grace period before the process group is killed.
	pub interrupt_grace:    CoreDuration,
	/// Initial delay after an unhealthy host.
	pub initial_backoff:    Duration,
	/// Maximum delay between respawn attempts.
	pub max_backoff:        Duration,
	/// Healthy duration after which the per-host backoff resets.
	pub healthy_reset:      Duration,
	/// Device-hash-keyed URL scheme metadata installed before activation.
	pub scheme_snapshot:    Option<SchemeSnapshot>,
	/// Shared DATA authorization table owned by the Environment.
	pub data_authority:     Option<Arc<AuthorityTable>>,
	/// CONTROL routing to the serialized Agent Journal and external storage
	/// backends.
	pub journal:            Option<JournalRuntime>,
	/// Complete authority factory for dedicated JSON CONTROL connections.
	control_authorities:    Option<Arc<HostControlAuthorityFactory>>,
	registry_control:       Option<Arc<RegistryControlFactory>>,
	hook_control:           Option<Arc<HookControlFactory>>,
	/// Driver/app factories retained until the production router is composed.
	domain_control:         Arc<DomainControlSlot>,
	/// Late-bound, generation-fenced device availability destination.
	availability_sink:      Arc<Mutex<Option<Arc<dyn AvailabilitySink>>>>,
}
impl ExtHostConfig {
	/// Builds the production configuration from authenticated session context.
	pub fn new(
		executable: PathBuf,
		principal: omp_core::Principal,
		session_id: Str,
		session_generation: u64,
	) -> Self {
		Self {
			executable,
			principal,
			session_id,
			session_generation,
			session_started_at: SystemTime::now(),
			workspace_root: None,
			extensions: Vec::new(),
			contributed_values: Vec::new(),
			schema_rev: omp_proto::SCHEMA_REV,
			python_rev: sf!(PYTHON_REV),
			max_frame_bytes: NonZeroUsize::new(DEFAULT_MAX_FRAME_BYTES)
				.expect("the default worker frame limit is nonzero"),
			health_timeout: Duration::from_secs(5),
			spawn_timeout: Duration::from_secs(30),
			ping_interval: Duration::from_secs(15),
			interrupt_grace: omp_tool::DEFAULT_INTERRUPT_GRACE,
			data_authority: None,
			journal: None,
			control_authorities: None,
			registry_control: None,
			hook_control: None,
			domain_control: DomainControlSlot::new(),
			initial_backoff: Duration::from_secs(1),
			scheme_snapshot: None,
			availability_sink: Arc::new(Mutex::new(None)),
			max_backoff: Duration::from_secs(30),
			healthy_reset: Duration::from_secs(30),
		}
	}

	/// Binds this supervisor configuration to the Environment's sole DATA
	/// authorization table.
	pub fn bind_data_authority(&mut self, authority: Arc<AuthorityTable>) {
		self.data_authority = Some(authority);
	}

	/// Binds placed worker processes to the Environment's workspace root.
	pub fn bind_workspace_root(&mut self, root: &Path) {
		self.workspace_root = Some(root.to_path_buf());
	}

	/// Installs authenticated journal and scoped-state CONTROL routing.
	pub fn bind_journal(&mut self, runtime: JournalRuntime) {
		self.journal = Some(runtime);
	}

	/// Installs the complete production authority factory before any dedicated
	/// CONTROL connection starts.
	pub fn bind_control_authorities(&mut self, factory: Arc<HostControlAuthorityFactory>) {
		self.control_authorities = Some(factory);
	}

	/// Installs the authenticated dynamic-registry owner used by CONTROL hosts.
	pub fn bind_registry_control(&mut self, registry: Arc<RegistryControlFactory>) {
		self.registry_control = Some(registry);
	}

	pub(crate) fn bind_hook_control(&mut self, hooks: Arc<HookControlFactory>) {
		self.hook_control = Some(hooks);
	}

	/// Installs driver/app-owned factories before production CONTROL
	/// composition.
	pub fn bind_domain_control_factories(&mut self, factories: ExternalDomainControlFactories) {
		let slot = DomainControlSlot::new();
		*slot.binding.lock() = Some(DomainControlBinding { id: 0, factories });
		self.domain_control = slot;
	}

	/// Returns the immutable driver/app factory projection used by envd.
	pub(crate) fn domain_control_factories(&self) -> Arc<DomainControlSlot> {
		Arc::clone(&self.domain_control)
	}

	/// Installs the registry-derived URL scheme snapshot for child activation.
	pub fn set_scheme_snapshot(&mut self, snapshot: SchemeSnapshot) {
		self.scheme_snapshot = Some(snapshot);
	}

	/// Builds a configuration that re-enters the current executable.
	///
	/// # Errors
	/// Returns the operating-system error if the current executable cannot be
	/// resolved.
	pub fn current(
		principal: omp_core::Principal,
		session_id: Str,
		session_generation: u64,
	) -> io::Result<Self> {
		env::current_exe()
			.map(|executable| Self::new(executable, principal, session_id, session_generation))
	}
}

/// An environment invocation opened against a registered Python tool.
///
/// The host chooses streaming from the registered declaration. Ordinary v1
/// tools are held until [`WorkerInvocation::args_committed`] supplies the one
/// final effective document; streaming tools receive forwarded fragments.
#[derive(Clone, Debug)]
pub struct OpenToolCall {
	/// Environment-plane invocation identity.
	pub invocation_id: Str,
	/// Registered tool name.
	pub name:          Str,
	/// Registered tool revision.
	pub rev:           Str,
	/// Maximum execution duration after the worker receives the call.
	pub deadline:      Duration,
}

/// Why the supervisor terminated an invocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerAbortKind {
	/// The invocation guard was dropped or explicitly cancelled.
	Cancelled,
	/// The committed invocation exceeded its deadline.
	TimedOut,
	/// The worker exited or violated its protocol during the invocation.
	Crashed,
}

/// Terminal supervisor-owned abort truth.
#[derive(Clone, Debug)]
pub struct WorkerAbort {
	/// Call whose effects are no longer knowable.
	pub call_id:         Str,
	/// Abort classification.
	pub kind:            WorkerAbortKind,
	/// Human-readable owner diagnostic.
	pub reason:          Str,
	/// True after dispatch; false when a queued call is cancelled before
	/// dispatch.
	pub effects_unknown: bool,
}

/// Decoded terminal branch from an extension host.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerOutcomeKind {
	/// Successful completion.
	Ok,
	/// Extension-declared fault.
	Faulted,
	/// Structured argument rejection.
	ArgsRejected,
	/// Aborted execution.
	Aborted,
}

/// Validated completion from an extension host.
#[derive(Clone, Debug)]
pub struct WorkerCompletion {
	/// Stable call identity.
	pub call_id:      Str,
	/// Exact terminal branch.
	pub kind:         WorkerOutcomeKind,
	/// Model-facing result parts, each with a present discriminator.
	pub parts:        Vec<Part>,
	/// Inline structured details when the worker did not spill them.
	pub details_json: Option<Bytes>,
	/// Spilled structured details when the worker did not send them inline.
	pub details_blob: Option<Blob>,
	/// Structured argument issue, present only for
	/// [`WorkerOutcomeKind::ArgsRejected`].
	pub args_issue:   Option<ArgIssue>,
	/// Whether model-facing parts may be compacted.
	pub useless:      bool,
	/// Whether this result opts in to suppressing the automatic model follow-up.
	pub terminate:    bool,
}

/// One ordered event from a committed Python invocation.
#[derive(Clone, Debug)]
pub enum WorkerEvent {
	/// Typed JSON progress serialized by the extension.
	Update(ToolUpdate),
	/// One bounded cursor pull awaiting a host reply.
	Pull(PullRequest),
	/// A typed protocol error returned by the extension host.
	ProtocolError(ProtocolError),
	/// Normal terminal completion.
	Complete(WorkerCompletion),
	/// Abnormal terminal completion owned by the supervisor.
	Aborted(WorkerAbort),
}

/// RAII handle to a Python invocation.
///
/// Dropping a live handle requests cancellation. The supervisor then kills only
/// the worker process group, reports effects-unknown, and replaces the worker
/// before it accepts the next invocation.
#[must_use]
pub struct WorkerInvocation {
	id:                 u64,
	invocation_id:      Str,
	streams_args:       bool,
	host_generation:    u64,
	session_generation: u64,
	owner:              HostKey,
	maximum_effects:    omp_tool::Effects,
	data_authority:     Option<Arc<AuthorityTable>>,
	events:             Receiver<WorkerEvent>,
	commands:           flume::Sender<SupervisorCommand>,
	committed:          bool,
	terminal:           bool,
	cancel_requested:   bool,
}

impl WorkerInvocation {
	/// Receives the next update or terminal event.
	///
	/// # Errors
	/// Returns `RecvError` only if the supervisor shuts down without a terminal
	/// event.
	pub async fn next(&mut self) -> Result<WorkerEvent, flume::RecvError> {
		let event = self.events.recv_async().await?;
		if matches!(event, WorkerEvent::Complete(_) | WorkerEvent::Aborted(_)) {
			self.terminal = true;
			if let Some(authority) = &self.data_authority {
				authority.settle(&self.owner, self.invocation_id.as_str());
			}
		}
		Ok(event)
	}

	/// Returns the host generation that must fence this invocation's DATA
	/// requests.
	pub const fn host_generation(&self) -> u64 {
		self.host_generation
	}

	/// Returns the session generation that must fence this invocation's DATA
	/// requests.
	pub const fn session_generation(&self) -> u64 {
		self.session_generation
	}

	/// Returns whether the registered declaration selected streamed arguments.
	pub const fn streams_args(&self) -> bool {
		self.streams_args
	}

	/// Returns the registered maximum as a wire envelope for trusted internal
	/// dispatches that have no external admission frame to carry a narrowing.
	pub fn maximum_effect_envelope(&self) -> omp_proto::policy::v1::EffectEnvelope {
		omp_proto::policy::v1::EffectEnvelope::from(&self.maximum_effects)
	}

	/// Forwards one speculative argument fragment verbatim.
	///
	/// # Errors
	/// Returns a typed protocol error for a stale invocation id, a declaration
	/// that did not opt into streaming, a committed invocation, or a stopped
	/// actor.
	pub fn arg_text(&self, frame: ArgText) -> Result<(), WorkerError> {
		self.validate_environment_id(frame.invocation_id.as_str())?;
		if !self.streams_args {
			return Err(WorkerError::Protocol(sf!("tool declaration did not enable streams_args",)));
		}
		if self.committed {
			return Err(WorkerError::Protocol(sf!("ArgText arrived after ArgsCommitted")));
		}
		self
			.commands
			.send(SupervisorCommand::ArgText { id: self.id, frame })
			.map_err(|_| WorkerError::Unavailable)
	}

	/// Forwards the assistant-item/effect-authorization receipt verbatim.
	///
	/// The effect token and authorization timestamp remain in this exact frame;
	/// no lifecycle side channel is synthesized.
	///
	/// # Errors
	/// Returns a typed protocol error for a stale invocation id, a duplicate
	/// commit, or a stopped actor.
	pub fn args_committed(&mut self, frame: ArgsCommitted) -> Result<(), WorkerError> {
		self.validate_environment_id(frame.invocation_id.as_str())?;
		if self.committed {
			return Err(WorkerError::Protocol(sf!("ArgsCommitted was already forwarded")));
		}
		let narrowed = frame
			.effects
			.as_ref()
			.map(omp_tool::Effects::try_from)
			.transpose()
			.map_err(|_| WorkerError::Protocol(sf!("ArgsCommitted effects are invalid")))?
			.unwrap_or_default();
		if !narrowed.is_subset_of(&self.maximum_effects) {
			return Err(WorkerError::Protocol(sf!(
				"ArgsCommitted effects exceed the registered tool maximum",
			)));
		}
		if let Some(authority) = &self.data_authority {
			authority
				.authorize(
					&self.owner,
					self.invocation_id.as_str(),
					frame.effect_token.clone(),
					frame
						.effects
						.as_ref()
						.map_or_else(Grants::default, Grants::from_effect_envelope),
					frame.authorized_at_ms,
					self.host_generation,
					self.session_generation,
				)
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
		}
		self
			.commands
			.send(SupervisorCommand::ArgsCommitted { id: self.id, frame })
			.map_err(|_| WorkerError::Unavailable)?;
		self.committed = true;
		Ok(())
	}

	/// Sends a survivable, classed interrupt verbatim.
	///
	/// # Errors
	/// Returns a typed protocol error for a stale invocation id or stopped
	/// actor.
	pub fn interrupt(&self, frame: Interrupt) -> Result<(), WorkerError> {
		self.validate_environment_id(frame.invocation_id.as_str())?;
		if self.terminal || self.cancel_requested {
			return Err(WorkerError::Protocol(sf!("invocation is already terminal")));
		}
		self
			.commands
			.send(SupervisorCommand::Interrupt { id: self.id, frame })
			.map_err(|_| WorkerError::Unavailable)
	}

	/// Replies to the invocation's sole outstanding pull.
	///
	/// # Errors
	/// Returns a typed protocol error for a stale call id or stopped actor.
	pub fn reply_pull(&self, reply: PullReply) -> Result<(), WorkerError> {
		if reply.call_id != self.invocation_id.as_str() {
			return Err(WorkerError::Protocol(sf!("PullReply call id does not match invocation",)));
		}
		self
			.commands
			.send(SupervisorCommand::PullReply { id: self.id, reply })
			.map_err(|_| WorkerError::Unavailable)
	}

	fn validate_environment_id(&self, invocation_id: &str) -> Result<(), WorkerError> {
		if invocation_id == self.invocation_id.as_str() {
			Ok(())
		} else {
			Err(WorkerError::Protocol(sf!("stale invocation id does not match worker handle",)))
		}
	}

	/// Requests cancellation while retaining the terminal event stream.
	pub fn cancel(&mut self, reason: impl Into<Str>) {
		if self.terminal || self.cancel_requested {
			return;
		}
		if self
			.commands
			.send(SupervisorCommand::Cancel { id: self.id, reason: reason.into() })
			.is_ok()
		{
			self.cancel_requested = true;
		}
	}
}

impl Drop for WorkerInvocation {
	fn drop(&mut self) {
		if !self.terminal && !self.cancel_requested {
			let _ = self.commands.send(SupervisorCommand::Cancel {
				id:     self.id,
				reason: sf!("invocation guard dropped"),
			});
		}
		if let Some(authority) = &self.data_authority {
			authority.settle(&self.owner, self.invocation_id.as_str());
		}
	}
}

/// A registered declaration and the extension host that owns it.
#[derive(Clone, Debug)]
pub struct OwnedToolDecl {
	/// Owning extension host.
	pub owner:        HostKey,
	/// Worker declaration.
	pub declaration:  ToolDecl,
	/// Whether the authenticated deployment grant covers this named hard slot.
	pub hard_granted: bool,
}

struct AgentsControlBinding {
	id:      u64,
	factory: Arc<dyn ControlAuthorityFactory>,
}

struct AgentsControlSlot {
	session_generation: u64,
	next_id:            AtomicU64,
	was_bound:          AtomicBool,
	binding:            Mutex<Option<AgentsControlBinding>>,
}

impl AgentsControlSlot {
	fn is_live(&self, id: u64) -> bool {
		self
			.binding
			.lock()
			.as_ref()
			.is_some_and(|binding| binding.id == id)
	}

	fn factory(
		self: &Arc<Self>,
	) -> Result<Arc<dyn ControlAuthorityFactory>, ControlCompositionError> {
		Ok(Arc::new(DynamicAgentsControlFactory {
			slot:               Arc::downgrade(self),
			session_generation: self.session_generation,
		}))
	}
}

struct DynamicAgentsControlFactory {
	slot:               Weak<AgentsControlSlot>,
	session_generation: u64,
}

impl ControlAuthorityFactory for DynamicAgentsControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		if identity.session_generation != self.session_generation {
			return Err(ControlCompositionError::unavailable(
				"agents",
				"the extension connection belongs to a different session generation",
			));
		}
		let slot = self.slot.upgrade().ok_or_else(|| {
			ControlCompositionError::unavailable("agents", "the extension host has shut down")
		})?;
		Ok(Arc::new(DynamicAgentsControlAuthority {
			slot: Arc::downgrade(&slot),
			identity,
			requests: Mutex::new(BTreeMap::new()),
		}))
	}
}

struct DynamicAgentsControlAuthority {
	slot:     Weak<AgentsControlSlot>,
	identity: Arc<ControlConnectionIdentity>,
	requests: Mutex<BTreeMap<u64, (u64, Arc<dyn ControlAuthority>)>>,
}

impl DynamicAgentsControlAuthority {
	fn bound(
		&self,
	) -> Result<(Arc<AgentsControlSlot>, u64, Arc<dyn ControlAuthority>), ControlProtocolError> {
		let slot = self.slot.upgrade().ok_or_else(|| {
			ControlProtocolError::new("AgentsOwnerUnavailable", "the extension host has shut down")
		})?;
		let (id, factory) = {
			let binding = slot.binding.lock();
			let binding = binding.as_ref().ok_or_else(|| {
				ControlProtocolError::new(
					"AgentsOwnerUnavailable",
					"no installed Agents lease owns this CONTROL connection",
				)
				.retryable(true)
			})?;
			(binding.id, Arc::clone(&binding.factory))
		};
		let authority = factory.bind(Arc::clone(&self.identity)).map_err(|error| {
			ControlProtocolError::new("AgentsOwnerUnavailable", Str::from(error.to_string()))
				.retryable(true)
		})?;
		if !slot.is_live(id) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the Agents lease changed while binding the request",
			));
		}
		Ok((slot, id, authority))
	}

	fn validate(&self, context: &ControlRequestContext) -> Result<(), ControlProtocolError> {
		if context.connection.extension == self.identity.extension
			&& context.connection.principal == self.identity.principal
			&& context.connection.artifact_digest == self.identity.artifact_digest
			&& context.connection.layer == self.identity.layer
			&& context.connection.tier == self.identity.tier
			&& context.connection.trust == self.identity.trust
			&& context.connection.host_generation == self.identity.host_generation
			&& context.connection.session_generation == self.identity.session_generation
			&& context.connection.capabilities == self.identity.capabilities
		{
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"the Agents authority belongs to a replaced extension-host connection",
			))
		}
	}
}

#[async_trait::async_trait]
impl ControlAuthority for DynamicAgentsControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		operation.starts_with("omp.agents.")
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		self.validate(context)?;
		let (slot, id, authority) = self.bound()?;
		authority.authorize(context, operation, arguments)?;
		if !slot.is_live(id) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the Agents lease changed while authorizing the request",
			));
		}
		self
			.requests
			.lock()
			.insert(context.request_id, (id, authority));
		Ok(())
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		self.validate(&context)?;
		let (id, authority) = self
			.requests
			.lock()
			.remove(&context.request_id)
			.ok_or_else(|| {
				ControlProtocolError::new(
					"AgentsOwnerUnavailable",
					"the Agents request has no authorized lease",
				)
			})?;
		let slot = self.slot.upgrade().ok_or_else(|| {
			ControlProtocolError::new("AgentsOwnerUnavailable", "the extension host has shut down")
		})?;
		if !slot.is_live(id) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the Agents lease changed before request dispatch",
			));
		}
		authority.request(context, operation, arguments).await
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.validate(&context)?;
		let (slot, id, authority) = self.bound()?;
		authority.effect(context, effect).await?;
		if slot.is_live(id) {
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"the Agents lease changed during effect dispatch",
			))
		}
	}
}

/// Sole-owner lease for one chat parent's agents CONTROL authority.
///
/// Replacing a binding immediately fences authorities created from the old
/// lease. Dropping the current lease revokes the domain without affecting MCP
/// or any envd-owned authority.
pub struct AgentsControlAuthorityBinding {
	slot: Arc<AgentsControlSlot>,
	id:   u64,
}

impl Drop for AgentsControlAuthorityBinding {
	fn drop(&mut self) {
		let mut binding = self.slot.binding.lock();
		if binding
			.as_ref()
			.is_some_and(|binding| binding.id == self.id)
		{
			*binding = None;
		}
	}
}

fn control_manifest_snapshot(spec: &ExtHostSpec) -> Result<Str, WorkerError> {
	let tools = spec
		.manifest
		.declarations
		.tools()
		.map(|tool| serde_json::json!([tool.name.as_str(), tool.family.as_str(), tool.rev]))
		.collect::<Vec<_>>();
	let hooks = spec
		.manifest
		.declarations
		.hooks()
		.map(|hook| serde_json::json!([hook.event.as_str(), hook.phase.to_string()]))
		.collect::<Vec<_>>();
	let services = spec
		.manifest
		.services
		.provides()
		.map(|service| serde_json::json!([service.name.as_str(), service.rev]))
		.collect::<Vec<_>>();
	let requires = spec
		.manifest
		.services
		.requires()
		.map(|service| serde_json::json!([service.name.as_str(), service.rev]))
		.collect::<Vec<_>>();
	let mut snapshot = serde_json::json!({
		"extension": spec.key.extension().as_str(),
		"tools": tools,
		"hooks": hooks,
		"capabilities": spec.data_grants.iter().collect::<Vec<_>>(),
		"services": services,
		"requires": requires,
		"trust_runtime_declarations": spec.manifest.runtime_declarations_trusted(),
	});
	if spec.manifest.has_uniform_declarations() {
		snapshot
			.as_object_mut()
			.expect("manifest snapshot is an object")
			.insert(
				"declarations".into(),
				serde_json::json!(&spec.manifest.static_declarations().ordered),
			);
	}
	serde_json::to_string(&snapshot)
		.map(Str::from)
		.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))
}

fn control_connection_identity(
	config: &ExtHostConfig,
	spec: &ExtHostSpec,
	host_generation: u64,
) -> Arc<ControlConnectionIdentity> {
	Arc::new(ControlConnectionIdentity {
		extension: spec.key.extension().clone(),
		principal: config.principal.clone(),
		artifact_digest: Str::from(spec.manifest.provenance.artifact_digest().to_string()),
		layer: spec.key.layer().clone(),
		tier: spec.key.tier().clone(),
		trust: spec.key.tier().clone(),
		host_generation,
		session_generation: config.session_generation,
		capabilities: Arc::new(spec.data_grants.iter().map(Str::from).collect()),
	})
}

fn same_control_identity(
	expected: &ControlConnectionIdentity,
	actual: &ControlConnectionIdentity,
) -> bool {
	expected.extension == actual.extension
		&& expected.principal == actual.principal
		&& expected.artifact_digest == actual.artifact_digest
		&& expected.layer == actual.layer
		&& expected.tier == actual.tier
		&& expected.trust == actual.trust
		&& expected.host_generation == actual.host_generation
		&& expected.session_generation == actual.session_generation
		&& expected.capabilities == actual.capabilities
}

#[derive(Clone)]
struct PendingControlActivation {
	control:            ControlHandle,
	identity:           Arc<ControlConnectionIdentity>,
	manifest:           ExtensionManifest,
	key:                HostKey,
	data_enabled:       bool,
	trigger:            ActivationTrigger,
	session_id:         Str,
	session_started_at: SystemTime,
	session_generation: u64,
	principal:          Principal,
	host_factory:       Arc<HostControlAuthorityFactory>,
	agents_factory:     Arc<dyn ControlAuthorityFactory>,
	registry_control:   Option<Arc<RegistryControlFactory>>,
	lifecycle_gate:     Option<Arc<HookGate>>,
	registered_ui:      Arc<RwLock<Option<RegisterUi>>>,
	settings:           serde_json::Map<String, serde_json::Value>,
	roots:              Box<[Str]>,
}
struct LiveControlRoute {
	control:  RwLock<ControlHandle>,
	identity: RwLock<Arc<ControlConnectionIdentity>>,
}

struct FrozenControlLifecycleHost {
	control:         ControlHandle,
	extension:       Str,
	session:         Str,
	host_generation: u64,
	next_invocation: u64,
	identity:        Arc<ControlConnectionIdentity>,
	manifest:        ExtensionManifest,
	verified_ui:     VerifiedUiRoster,
	frozen_registry: Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
	settings:        serde_json::Map<String, serde_json::Value>,
}

impl FrozenControlLifecycleHost {
	fn new(
		control: ControlHandle,
		extension: Str,
		session: Str,
		host_generation: u64,
		identity: Arc<ControlConnectionIdentity>,
		manifest: ExtensionManifest,
		verified_ui: VerifiedUiRoster,
		frozen_registry: Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
		settings: serde_json::Map<String, serde_json::Value>,
	) -> Self {
		Self {
			control,
			extension,
			session,
			host_generation,
			next_invocation: 1,
			identity,
			manifest,
			verified_ui,
			frozen_registry,
			settings,
		}
	}

	fn authority(
		&mut self,
		name: &'static str,
		phase: InvocationPhase,
		lifecycle: LifecyclePhase,
	) -> ControlInvocationAuthority {
		let id = self.next_invocation;
		self.next_invocation = self.next_invocation.saturating_add(1);
		ControlInvocationAuthority {
			invocation: sf!("lifecycle:{}:{}:{}", self.extension, self.host_generation, id),
			phase,
			session: self.session.clone(),
			turn: None,
			event: Some(sf!("{name}")),
			call: None,
			device: None,
			effects: Box::new([]),
			place_kind: sf!("host"),
			lifecycle,
			roots: Box::new([]),
			remote: false,
			has_ui: false,
			headless: true,
			settings: self.settings.clone(),
			secret_settings: Box::new([]),
			data: None,
			direct_filesystem: None,
		}
	}
}

impl LifecycleHost for FrozenControlLifecycleHost {
	fn freeze(&mut self) -> impl Future<Output = Result<(), Str>> + Send {
		use std::time::Instant;

		let dispatch = ControlDispatch {
			operation: sf!("omp.lifecycle.freeze"),
			arguments: serde_json::Map::new(),
			authority: self.authority("freeze", InvocationPhase::Open, LifecyclePhase::Frozen),
			policy:    CallbackConcurrency::Serialized,
			deadline:  EventDeadline { at: Instant::now() + Duration::from_secs(10) },
		};
		async move {
			let frozen = self
				.control
				.dispatch(dispatch)
				.await
				.map_err(|error| Str::from(error.to_string()))?;
			let mut evidence = seal_frozen_control_evidence(
				Arc::clone(&self.identity),
				self.session.clone(),
				&self.manifest,
				frozen,
			)
			.map_err(|error| Str::from(error.to_string()))?;
			evidence.ui = self.verified_ui.clone();
			let evidence = Arc::new(evidence);
			self.frozen_registry.lock().insert(
				(
					self.identity.layer.clone(),
					self.identity.tier.clone(),
					self.identity.extension.clone(),
				),
				evidence,
			);
			Ok(())
		}
	}

	fn activate(
		&mut self,
		event: &ActivationEvent,
		_principal: &Principal,
	) -> impl Future<Output = Result<(), Str>> + Send {
		use std::time::Instant;

		let reason: &str = event.reason.into();

		let trigger = match event.trigger {
			ActivationTrigger::Static => "static",
			ActivationTrigger::FirstReach => "first_reach",
			ActivationTrigger::BeforeFirstPrompt => "before_first_prompt",
			ActivationTrigger::BeforeUiInput => "before_ui_input",
		};
		let started_at_ms = event
			.session_started_at
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis()
			.try_into()
			.unwrap_or(u64::MAX);
		let mut arguments = serde_json::Map::new();
		arguments.insert(
			String::from("payload"),
			serde_json::json!({
				"extension": self.extension.as_str(),
				"reason": reason,
				"session_started_at": started_at_ms,
				"generation": event.generation,
				"trigger": trigger,
			}),
		);
		let dispatch = ControlDispatch {
			operation: sf!("omp.lifecycle.activate"),
			arguments,
			authority: self.authority(
				"extension_activate",
				InvocationPhase::EffectsAuthorized,
				LifecyclePhase::Active,
			),
			policy: CallbackConcurrency::Serialized,
			deadline: EventDeadline { at: Instant::now() + Duration::from_secs(10) },
		};
		async move {
			self
				.control
				.dispatch(dispatch)
				.await
				.map(|_| ())
				.map_err(|error| Str::from(error.to_string()))
		}
	}
}

/// Independently supervises the process group for each active extension host.
pub struct ExtHostSupervisor {
	routes:               BTreeMap<(Str, Str), HostRoute>,
	registrations:        Arc<[OwnedToolDecl]>,
	prompt_registrations: Arc<[PromptSlotBinding]>,
	prompt_routes:        BTreeMap<Str, PromptRoute>,
	next_invocation:      AtomicU64,
	actors:               Vec<HostActor>,
	data_authority:       Option<Arc<AuthorityTable>>,
	journal_runtime:      Arc<Mutex<JournalRuntimeSlot>>,
	availability_pending: Arc<Mutex<VecDeque<AvailabilityBatch>>>,
	availability_sink:    Arc<Mutex<Option<Arc<dyn AvailabilitySink>>>>,
	children_active:      AtomicBool,
	control_authorities:  Option<Arc<HostControlAuthorityFactory>>,
	registry_control:     Option<Arc<RegistryControlFactory>>,
	frozen_registry:      Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
	domain_control:       Arc<DomainControlSlot>,
	service_router:       Arc<ServiceRouter>,
	agents_control:       Arc<AgentsControlSlot>,
	control_activations:  Vec<PendingControlActivation>,
	live_controls:        BTreeMap<HostKey, Arc<LiveControlRoute>>,
	watchers:             Vec<LinkWatcher>,
	lifecycle_gate:       Option<Arc<HookGate>>,
	lifecycle_manifests:  Arc<[ExtensionManifest]>,
}
impl ExtHostSupervisor {
	/// Starts and verifies every configured active extension.
	///
	/// An empty configuration is lazy: it starts no Python interpreter.
	/// Extensions share a process only when every member names the same explicit
	/// pool in the same layer and tier.
	///
	/// # Errors
	/// Returns a startup, identity, registration, or handshake error.
	pub async fn spawn(config: ExtHostConfig) -> Result<Self, WorkerError> {
		let control_authorities = config.control_authorities.clone();
		let registry_control = config.registry_control.clone();
		let hook_control = config.hook_control.clone();
		let lifecycle_gate = hook_control.as_ref().map(|hooks| hooks.admission_gate());
		let lifecycle_manifests = config
			.extensions
			.iter()
			.filter(|extension| {
				extension
					.manifest
					.activation_triggers
					.iter()
					.any(|trigger| trigger.requires_host())
			})
			.map(|extension| extension.manifest.clone())
			.collect::<Arc<[_]>>();
		let domain_control = Arc::clone(&config.domain_control);
		let agents_control = Arc::new(AgentsControlSlot {
			session_generation: config.session_generation,
			next_id:            AtomicU64::new(1),
			was_bound:          AtomicBool::new(false),
			binding:            Mutex::new(None),
		});
		let mut control_activations = Vec::new();
		let mut control_routes = BTreeMap::new();
		let mut live_controls = BTreeMap::new();
		let mut control_actors = Vec::new();
		let frozen_registry = Arc::new(Mutex::new(BTreeMap::new()));
		for extension in &config.extensions {
			let (Some(python_site), Some(env_socket)) =
				(&extension.python_site, &extension.data_socket)
			else {
				continue;
			};
			let Some(trigger) = extension
				.manifest
				.activation_triggers
				.iter()
				.copied()
				.find(|trigger| trigger.requires_host())
			else {
				continue;
			};
			let factory = control_authorities.as_ref().ok_or_else(|| {
				WorkerError::Protocol(sf!(
					"production extension host omitted CONTROL authority composition"
				))
			})?;
			let identity = control_connection_identity(&config, extension, 1);
			let agents = agents_control
				.factory()
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
			let authority = factory
				.bind_with_agents(Arc::clone(&identity), Arc::clone(&agents))
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
			let mut modules = Vec::with_capacity(extension.manifest.declaration_modules.len() + 1);
			modules.push(extension.manifest.entry.clone());
			modules.extend(extension.manifest.declaration_modules.iter().cloned());
			let spawned = spawn(SpawnSpec {
				key:                 extension.key.clone(),
				executable:          extension
					.host_executable
					.clone()
					.unwrap_or_else(|| config.executable.clone()),
				python_site:         python_site.clone(),
				env_socket:          env_socket.clone(),
				workspace_root:      extension
					.manifest
					.static_declarations()
					.ordered
					.iter()
					.any(|row| matches!(row.kind.as_str(), "telemetry" | "telemetry_subscription"))
					.then(|| config.workspace_root.clone())
					.flatten(),
				host_generation:     1,
				session_generation:  config.session_generation,
				package_snapshot:    None,
				manifest_snapshot:   control_manifest_snapshot(extension)?,
				declaration_modules: modules.into_boxed_slice(),
			})
			.await
			.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
			let running = spawned
				.start_control((*identity).clone(), authority, &ControlAuthoritySnapshot::default())
				.await
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
			if (extension.manifest.runtime_declarations_trusted()
				|| extension.manifest.declarations.hooks().next().is_some()
				|| !extension
					.manifest
					.static_declarations()
					.providers
					.is_empty())
				&& let Some(hooks) = &hook_control
			{
				let registry = registry_control.as_ref().ok_or_else(|| {
					WorkerError::Protocol(sf!("hook CONTROL owner requires registry CONTROL owner"))
				})?;
				let evidence = time::timeout(config.spawn_timeout, registry.wait_evidence(&identity))
					.await
					.map_err(|_| {
						// Blind timeouts are undiagnosable; carry the child's captured
						// output tail as evidence.
						let mut tail = Vec::new();
						while let Ok(log) = running.logs().try_recv() {
							tail.extend_from_slice(&log.bytes);
						}
						let start = tail.len().saturating_sub(800);
						WorkerError::Protocol(Str::from(format!(
							"CONTROL handshake timed out before sealed hook registry evidence; host \
							 output tail: {}",
							String::from_utf8_lossy(&tail[start..]).trim()
						)))
					})?;
				for hook in evidence.hooks.iter() {
					hooks
						.subscribe(HookSubscription {
							identity:     Arc::clone(&identity),
							session:      config.session_id.clone(),
							event:        hook.event.clone(),
							phase:        hook.phase.clone(),
							name:         hook.name.clone(),
							order:        hook.order,
							on_failure:   hook.on_failure,
							timeout:      hook.timeout,
							concurrency:  hook.concurrency,
							providers:    hook.providers.clone(),
							servers:      hook.servers.clone(),
							method_globs: hook.method_globs.clone(),
							event_policy: HookEventPolicy {
								revision:    hook.event_revision,
								timeout:     hook.event_timeout,
								on_failure:  hook.event_on_failure,
								default:     hook.event_default.clone(),
								composition: hook.composition.clone(),
							},
						})
						.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
				}
			}
			let activation = PendingControlActivation {
				control: running.control(),
				identity: Arc::clone(&identity),
				manifest: extension.manifest.clone(),
				key: extension.key.clone(),
				data_enabled: extension.data_socket.is_some(),
				trigger,
				session_id: config.session_id.clone(),
				session_started_at: config.session_started_at,
				session_generation: config.session_generation,
				principal: config.principal.clone(),
				host_factory: Arc::clone(factory),
				agents_factory: Arc::clone(&agents),
				registry_control: registry_control.clone(),
				lifecycle_gate: hook_control.as_ref().map(|hooks| hooks.admission_gate()),
				registered_ui: Arc::new(RwLock::new(None)),
				settings: extension.settings.clone(),
				roots: config
					.workspace_root
					.iter()
					.map(|root| {
						Str::from(
							Url::from_file_path(root)
								.expect("workspace root is an absolute filesystem path")
								.as_str(),
						)
					})
					.collect(),
			};
			let live_control = Arc::new(LiveControlRoute {
				control:  RwLock::new(running.control()),
				identity: RwLock::new(Arc::clone(&identity)),
			});
			live_controls.insert(extension.key.clone(), Arc::clone(&live_control));
			control_activations.push(activation.clone());
			let (commands, mailbox) = flume::unbounded();
			let host_generation = Arc::new(AtomicU64::new(1));
			let shutdown = CancellationToken::new();
			let actor = tokio::spawn(run_control_supervisor(
				running,
				extension.key.clone(),
				config.session_id.clone(),
				config.session_generation,
				mailbox,
				Arc::clone(&host_generation),
				shutdown.clone(),
				activation,
				Arc::clone(&frozen_registry),
				live_control,
			));
			control_routes.insert(
				extension.key.clone(),
				(commands.clone(), Arc::clone(&host_generation), config.session_generation),
			);
			control_actors.push(HostActor {
				commands,
				actor: Mutex::new(Some(actor)),
				shutdown,
				reloadable: true,
				owners: Arc::from([extension.key.extension().clone()]),
			});
		}
		let mut service_broker = ServiceBroker::new(config.session_generation);
		for extension in &config.extensions {
			service_broker
				.publish_manifest(extension.key.clone(), extension.manifest.services.clone())
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
		}
		let service_router = Arc::new(ServiceRouter {
			broker: Arc::new(Mutex::new(service_broker)),
			routes: Mutex::new(BTreeMap::new()),
		});
		let mut groups = BTreeMap::<ProcessKey, Vec<ExtHostSpec>>::new();
		let mut identities = HashSet::with_capacity(config.extensions.len());
		let data_authority = config.data_authority.clone();
		let resources = Arc::new(Mutex::new(ControlQuotaLedger::new()));
		let availability_sink = Arc::clone(&config.availability_sink);
		let availability_pending = Arc::new(Mutex::new(VecDeque::new()));
		let journal_runtime = Arc::new(Mutex::new(JournalRuntimeSlot {
			binding:   config
				.journal
				.clone()
				.map(|runtime| BoundJournalRuntime { id: 0, runtime }),
			was_bound: config.journal.is_some(),
		}));
		let children_active = AtomicBool::new(false);
		for extension in config.extensions.iter().cloned() {
			validate_extension_spec(&extension)?;
			if !identities.insert(extension.key.clone()) {
				return Err(WorkerError::Protocol(sf!(
					"extension host identity is configured more than once",
				)));
			}
			if let Some(authority) = &config.data_authority {
				authority.register_host(extension.key.clone(), extension.data_grants.clone());
			}
			resources
				.lock()
				.register_limits(
					extension.key.clone(),
					extension.manifest.resource_limits.iter().cloned(),
				)
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
			groups
				.entry(ProcessKey::from_spec(&extension))
				.or_default()
				.push(extension);
		}

		let mut prepared = Vec::with_capacity(groups.len());
		for (key, extensions) in groups {
			let process_config = ProcessConfig::new(
				&config,
				key,
				extensions,
				Arc::clone(&resources),
				Arc::clone(&availability_pending),
				Arc::clone(&journal_runtime),
			)?;
			match WorkerProcess::spawn(&process_config, 1, ActivationCause::FirstReach).await {
				Ok(process) => prepared.push((process_config, process)),
				Err(error) => {
					for (prepared_config, mut process) in prepared {
						process.terminate(prepared_config.interrupt_grace).await;
					}
					return Err(error);
				},
			}
		}

		let mut routes = BTreeMap::new();
		for activation in &mut control_activations {
			*activation.registered_ui.write() = prepared.iter().find_map(|(config, process)| {
				config
					.manifests
					.contains_key(&activation.key)
					.then(|| process.ui_registrations.get(&activation.key).cloned())
					.flatten()
			});
		}
		let mut registrations = Vec::new();
		let mut prompt_registrations = Vec::new();
		let mut prompt_processes = BTreeMap::<Str, ProcessKey>::new();
		let mut registration_error = None;
		'registration: for (process_config, process) in &prepared {
			for binding in &process.prompt_registrations {
				if let Some(existing) =
					prompt_processes.insert(binding.owner.clone(), process_config.process_id.clone())
					&& existing != process_config.process_id
				{
					registration_error = Some(WorkerError::Protocol(sf!(
						"one extension registered prompt slots from multiple worker processes",
					)));
					break 'registration;
				}
				prompt_registrations.push(binding.clone());
			}
			for declaration in &process.registrations {
				let owner = match process_config.owner_for(declaration) {
					Ok(owner) => owner,
					Err(error) => {
						registration_error = Some(error);
						break 'registration;
					},
				};
				let Some(definition) = declaration.definition.as_ref() else {
					continue;
				};
				let maximum_effects = if let Ok(effects) = declaration
					.effects
					.as_ref()
					.map(omp_tool::Effects::try_from)
					.transpose()
				{
					effects.unwrap_or_default()
				} else {
					registration_error =
						Some(WorkerError::Protocol(sf!("registered tool effects are invalid",)));
					break 'registration;
				};
				let route = (Str::from(definition.name.as_str()), Str::from(declaration.rev.as_str()));
				if routes
					.insert(
						route,
						(
							process_config.process_id.clone(),
							owner.clone(),
							declaration.streams_args,
							maximum_effects,
							declaration.place.clone(),
						),
					)
					.is_some()
				{
					registration_error = Some(WorkerError::Protocol(sf!(
						"two extension hosts registered the same tool name and revision",
					)));
					break 'registration;
				}
				let hard_granted = process_config.hard_tool_granted(&owner, definition.name.as_str());
				registrations.push(OwnedToolDecl {
					owner,
					declaration: declaration.clone(),
					hard_granted,
				});
			}
		}
		if let Some(error) = registration_error {
			for (prepared_config, mut process) in prepared {
				process.terminate(prepared_config.interrupt_grace).await;
			}
			return Err(error);
		}

		let mut senders = BTreeMap::new();
		let mut actors = Vec::with_capacity(prepared.len());
		for (process_config, process) in prepared {
			let process_id = process_config.process_id.clone();
			let session_generation = process_config.session_generation;
			let host_generation = Arc::new(AtomicU64::new(1));
			let expected_registrations: Arc<[ToolDecl]> = process.registrations.clone().into();
			let expected_prompt_registrations: Arc<[PromptSlotBinding]> =
				process.prompt_registrations.clone().into();
			let (commands, mailbox) = flume::unbounded();
			let shutdown = CancellationToken::new();
			for owner in process_config.manifests.keys() {
				service_router
					.broker
					.lock()
					.activate_provider_declarations(
						owner,
						1,
						process
							.service_registrations
							.get(owner)
							.into_iter()
							.flat_map(|services| services.iter().cloned()),
					)
					.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
				service_router
					.routes
					.lock()
					.insert(owner.clone(), ProviderRoute {
						process_id: process_id.clone(),
						commands:   commands.clone(),
						generation: host_generation.clone(),
					});
			}
			let owners = process_config
				.manifests
				.keys()
				.map(|owner| owner.extension().clone())
				.collect::<Arc<[_]>>();
			let actor = tokio::spawn(run_supervisor(
				process_config,
				process,
				expected_registrations,
				expected_prompt_registrations,
				mailbox,
				host_generation.clone(),
				1,
				Arc::clone(&service_router),
				shutdown.clone(),
			));
			senders.insert(process_id, (commands.clone(), host_generation, session_generation));
			actors.push(HostActor {
				commands,
				actor: Mutex::new(Some(actor)),
				shutdown,
				reloadable: true,
				owners,
			});
		}
		actors.extend(control_actors);
		let prompt_routes = prompt_processes
			.into_iter()
			.map(|(owner, process_id)| {
				let (commands, ..) = senders
					.get(&process_id)
					.expect("every prompt renderer has a worker process");
				(owner, PromptRoute { commands: commands.clone() })
			})
			.collect();
		let mut watchers = Vec::new();
		for extension in &config.extensions {
			let Some(root) = extension.watch_root.as_ref() else {
				continue;
			};
			let Some(commands) = actors
				.iter()
				.rev()
				.find(|actor| actor.owners.contains(extension.key.extension()))
				.map(|actor| actor.commands.clone())
			else {
				continue;
			};
			if let Some(watcher) = spawn_link_watcher(
				root,
				extension.key.extension().clone(),
				commands,
				lifecycle_gate.clone(),
			) {
				watchers.push(watcher);
			}
		}
		let routes = routes
			.into_iter()
			.map(|(route, (process_id, owner, streams_args, maximum_effects, place))| {
				let control = (place == "host")
					.then(|| control_routes.get(&owner))
					.flatten();
				let (commands, host_generation, session_generation) = control
					.or_else(|| senders.get(&process_id))
					.expect("every verified process has a command channel");
				(route, HostRoute {
					commands: commands.clone(),
					owner,
					streams_args,
					maximum_effects,
					host_generation: host_generation.clone(),
					session_generation: *session_generation,
				})
			})
			.collect();
		Ok(Self {
			routes,
			registrations: registrations.into(),
			prompt_registrations: prompt_registrations.into(),
			prompt_routes,
			next_invocation: AtomicU64::new(1),
			actors,
			data_authority,
			journal_runtime,
			availability_sink,
			availability_pending,
			children_active,
			control_authorities,
			registry_control,
			frozen_registry,
			domain_control,
			service_router,
			agents_control,
			control_activations,
			live_controls,
			watchers,
			lifecycle_gate,
			lifecycle_manifests,
		})
	}

	/// Completes FREEZE and ACTIVATE after envd-owned CONTROL authorities are
	/// installed. Late app/driver domains remain fail-closed until their atomic
	/// factory bundle is bound before first user reach.
	pub async fn activate_control_hosts(&self) -> Result<(), WorkerError> {
		for activation in &self.control_activations {
			activate_control_generation(
				activation,
				activation.control.clone(),
				1,
				ActivationCause::FirstReach,
				Arc::clone(&self.frozen_registry),
			)
			.await?;
			wait_control_registry(activation).await?;
		}
		if let Some(gate) = self.lifecycle_gate.as_deref() {
			for manifest in self.lifecycle_manifests.iter() {
				notify_extension_load(gate, &manifest.provenance, false);
			}
		}
		Ok(())
	}

	/// Returns the active session generation fencing every CONTROL connection.
	pub fn session_generation(&self) -> u64 {
		self.agents_control.session_generation
	}

	/// Atomically installs one chat parent's agents-domain authority.
	///
	/// The returned lease revokes this exact binding on drop. A later binding
	/// supersedes it immediately; dropping an older lease cannot revoke the
	/// replacement.
	pub fn bind_agents_control_authority(
		&self,
		factory: Arc<dyn ControlAuthorityFactory>,
	) -> AgentsControlAuthorityBinding {
		let id = self.agents_control.next_id.fetch_add(1, Ordering::Relaxed);
		let mut binding = self.agents_control.binding.lock();
		self.agents_control.was_bound.store(true, Ordering::Release);
		*binding = Some(AgentsControlBinding { id, factory });
		drop(binding);
		AgentsControlAuthorityBinding { slot: Arc::clone(&self.agents_control), id }
	}

	/// Atomically installs every driver/app CONTROL owner for this session.
	pub fn bind_domain_control_factories(
		&self,
		factories: ExternalDomainControlFactories,
	) -> ExternalDomainControlBinding {
		self.domain_control.install(factories)
	}

	/// Atomically replaces Agents and every driver/app CONTROL domain.
	pub fn bind_external_control_authorities(
		&self,
		agents: Arc<dyn ControlAuthorityFactory>,
		domains: ExternalDomainControlFactories,
	) -> ExternalControlAuthorityBinding {
		let agents_id = self.agents_control.next_id.fetch_add(1, Ordering::Relaxed);
		let domains_id = self.domain_control.next_id.fetch_add(1, Ordering::Relaxed);
		let mut agents_binding = self.agents_control.binding.lock();
		let mut domains_binding = self.domain_control.binding.lock();
		self.agents_control.was_bound.store(true, Ordering::Release);
		*agents_binding = Some(AgentsControlBinding { id: agents_id, factory: agents });
		*domains_binding = Some(DomainControlBinding { id: domains_id, factories: domains });
		drop(domains_binding);
		drop(agents_binding);
		ExternalControlAuthorityBinding {
			agents:  AgentsControlAuthorityBinding {
				slot: Arc::clone(&self.agents_control),
				id:   agents_id,
			},
			domains: ExternalDomainControlBinding {
				slot: Arc::clone(&self.domain_control),
				id:   domains_id,
			},
		}
	}

	/// Builds the service CONTROL owner over this supervisor's sole live broker
	/// and generation-fenced provider routes.
	pub fn service_control_factory(&self) -> Arc<dyn ControlAuthorityFactory> {
		Arc::new(ServiceControlAuthorityFactory::new(
			Arc::clone(&self.service_router.broker),
			self.service_router.clone(),
		))
	}

	/// Binds the complete CONTROL router for one authenticated connection.
	pub fn control_authority(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let factory = self.control_authorities.as_ref().ok_or_else(|| {
			ControlCompositionError::unavailable(
				"host",
				"the host configuration omitted CONTROL authority composition",
			)
		})?;
		match self.agents_control.factory() {
			Ok(agents) => factory.bind_with_agents(identity, agents),
			Err(error) if self.agents_control.was_bound.load(Ordering::Acquire) => Err(error),
			Err(_) => factory.bind(identity),
		}
	}

	/// Returns the authenticated manifest only for an exact live connection
	/// generation.
	pub fn control_manifest(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<ExtensionManifest> {
		let key =
			HostKey::new(identity.layer.clone(), identity.tier.clone(), identity.extension.clone());
		let live = self.live_controls.get(&key)?.identity.read().clone();
		if !same_control_identity(&live, identity) {
			return None;
		}
		self
			.control_activations
			.iter()
			.find(|activation| activation.key == key)
			.map(|activation| activation.manifest.clone())
	}

	/// Returns the full frozen runtime declaration projection for an exact
	/// authenticated connection generation.
	pub fn sealed_registry_evidence(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<Arc<SealedRegistryEvidence>> {
		let key = (identity.layer.clone(), identity.tier.clone(), identity.extension.clone());
		if let Some(evidence) = self.frozen_registry.lock().get(&key).cloned()
			&& same_control_identity(&evidence.identity, identity)
		{
			return Some(evidence);
		}
		self.registry_control.as_ref()?.evidence(identity)
	}

	/// Returns every currently sealed exact-generation registry for app-owned
	/// roster publication.
	pub fn sealed_registry_evidences(&self) -> Vec<Arc<SealedRegistryEvidence>> {
		self.frozen_registry.lock().values().cloned().collect()
	}

	/// Returns every authenticated CONTROL identity, including hosts whose
	/// declaration freeze has not yet published registry evidence.
	pub fn control_identities(&self) -> Vec<Arc<ControlConnectionIdentity>> {
		self
			.control_activations
			.iter()
			.map(|activation| Arc::clone(&activation.identity))
			.collect()
	}

	/// Dispatches one device or hook callback to the exact retained child
	/// generation. Dropping this future invokes the CONTROL cancellation ladder.
	pub async fn dispatch_extension_callback(
		&self,
		target: &ControlConnectionIdentity,
		dispatch: ControlDispatch,
	) -> Result<serde_json::Value, ExtensionCallbackError> {
		let operation = dispatch.operation.as_str();
		if !matches!(operation, "omp.devices.call" | "omp.hooks.dispatch")
			&& !operation.starts_with("omp.regimes.")
			&& !operation.starts_with("omp.provider.")
			&& !operation.starts_with("omp.ui.")
			&& !operation.starts_with("omp.jobs.")
			&& !operation.starts_with("omp.prompts.")
			&& !operation.starts_with("omp.telemetry.")
		{
			return Err(ExtensionCallbackError::InvalidOperation);
		}
		let key = HostKey::new(target.layer.clone(), target.tier.clone(), target.extension.clone());
		let route = self
			.live_controls
			.get(&key)
			.ok_or(ExtensionCallbackError::UnknownHost)?;
		let identity = route.identity.read().clone();
		if identity.principal != target.principal
			|| identity.artifact_digest != target.artifact_digest
			|| identity.trust != target.trust
			|| identity.capabilities != target.capabilities
		{
			return Err(ExtensionCallbackError::UnknownHost);
		}
		if identity.host_generation != target.host_generation {
			return Err(ExtensionCallbackError::StaleHostGeneration {
				expected: identity.host_generation,
				actual:   target.host_generation,
			});
		}
		if identity.session_generation != target.session_generation {
			return Err(ExtensionCallbackError::StaleSessionGeneration {
				expected: identity.session_generation,
				actual:   target.session_generation,
			});
		}
		self
			.control_activations
			.iter()
			.find(|activation| activation.key == key)
			.ok_or(ExtensionCallbackError::UnknownHost)?;
		let control = route.control.read().clone();
		control.dispatch(dispatch).await.map_err(Into::into)
	}

	async fn dispatch_extension_ui_callback(
		&self,
		target: &ControlConnectionIdentity,
		authority: ControlInvocationAuthority,
		dispatch: UiCallbackDispatch,
		timeout: Duration,
	) -> Result<UiDispatchResult, ControlProtocolError> {
		if dispatch.owner.host.layer() != &target.layer
			|| dispatch.owner.host.tier() != &target.tier
			|| dispatch.owner.host.extension() != &target.extension
			|| dispatch.owner.generation != target.host_generation
		{
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"typed UI callback owner does not match the authenticated host",
			));
		}
		let owner = dispatch.owner.clone();
		let request = dispatch
			.request(1, timeout)
			.map_err(|error| ControlProtocolError::new("InvalidUiDispatch", error.to_string()))?;
		let envelope = UiHostEnvelope::decode(request.payload.as_ref())
			.map_err(|error| ControlProtocolError::new("InvalidUiDispatch", error.to_string()))?;
		let Some(ui_host_envelope::Body::Dispatch(dispatch)) = envelope.body else {
			return Err(ControlProtocolError::new(
				"InvalidUiDispatch",
				"typed UI callback envelope has no dispatch body",
			));
		};
		let (operation, arguments, kind) = match dispatch.kind {
			Some(ui_dispatch::Kind::Command(command)) => (
				sf!("omp.ui.command"),
				serde_json::Map::from_iter([
					(
						"invocation".to_owned(),
						serde_json::json!({
							"name": command.name,
							"argv": command.argv,
							"raw": command.raw,
							"mode": command.mode,
						}),
					),
					("ctx".to_owned(), serde_json::json!({})),
				]),
				UiDispatchKind::Command,
			),
			Some(ui_dispatch::Kind::Shortcut(shortcut)) => (
				sf!("omp.ui.shortcut"),
				serde_json::Map::from_iter([
					(
						"action".to_owned(),
						serde_json::json!({
							"action_id": shortcut.action_id,
							"chord": shortcut.chord,
							"phase": shortcut.phase,
						}),
					),
					("ctx".to_owned(), serde_json::json!({})),
				]),
				UiDispatchKind::Shortcut,
			),
			Some(ui_dispatch::Kind::Completion(completion)) => {
				let (operation, arguments) = if let Some(command) = completion.command {
					(
						sf!("omp.ui.command_completion"),
						serde_json::Map::from_iter([
							("name".to_owned(), serde_json::Value::String(command)),
							(
								"query".to_owned(),
								serde_json::json!({
									"prefix": completion.text,
									"argv": completion.argv,
								}),
							),
							("ctx".to_owned(), serde_json::json!({})),
						]),
					)
				} else {
					(
						sf!("omp.ui.completion"),
						serde_json::Map::from_iter([
							("trigger".to_owned(), serde_json::Value::String(completion.trigger)),
							("query".to_owned(), serde_json::Value::String(completion.text)),
							("ctx".to_owned(), serde_json::json!({})),
						]),
					)
				};
				(operation, arguments, UiDispatchKind::Completion)
			},
			_ => {
				return Err(ControlProtocolError::new(
					"InvalidUiDispatch",
					"typed UI callback route accepts only commands, shortcuts, and completions",
				));
			},
		};
		let result = self
			.dispatch_extension_callback(target, ControlDispatch {
				operation,
				arguments,
				authority,
				policy: request.policy,
				deadline: request.deadline,
			})
			.await;
		let (result, candidates) = match result {
			Ok(value) => match kind {
				UiDispatchKind::Command => (
					Some(ui_dispatch_result::Result::Command(ui_command_dispatch_result(value))),
					Vec::new(),
				),
				UiDispatchKind::Shortcut => {
					(Some(ui_dispatch_result::Result::Shortcut(ShortcutDispatchResult {})), Vec::new())
				},
				UiDispatchKind::Completion => (None, ui_completion_candidates(value)),
			},
			Err(ExtensionCallbackError::Runtime(ControlRuntimeError::Remote(error))) => (
				Some(ui_dispatch_result::Result::Error(UiError {
					code: error.code.to_string(),
					message: error.message.to_string(),
					..Default::default()
				})),
				Vec::new(),
			),
			Err(error) => return Err(extension_callback_protocol_error(error)),
		};
		let payload = UiWorkerEnvelope {
			body:  Some(ui_worker_envelope::Body::DispatchResult(UiDispatchResult {
				result,
				candidates,
				generation: owner.generation,
				declaration_id: owner.declaration_id.to_string(),
				..Default::default()
			})),
			props: None,
		}
		.encode_to_vec();
		crate::exthost::decode_ui_dispatch_result(&payload, &owner)
			.map_err(|error| ControlProtocolError::new("InvalidUiDispatchResult", error.to_string()))
	}

	/// Starts a spawned extension host only after every authority has bound.
	pub async fn start_control_host(
		&self,
		spawned: SpawnedHost,
		identity: Arc<ControlConnectionIdentity>,
		snapshot: &ControlAuthoritySnapshot,
	) -> Result<RunningHost, ControlHostStartError> {
		let authority = self.control_authority(Arc::clone(&identity))?;
		spawned
			.start_control((*identity).clone(), authority, snapshot)
			.await
			.map_err(Into::into)
	}

	/// Returns declarations paired with their owning host identity.
	pub fn registrations(&self) -> &[OwnedToolDecl] {
		&self.registrations
	}

	/// Installs sole-owner Agent Journal CONTROL routing.
	///
	/// # Errors
	/// Fails closed if a binding is already live. The initial binding must be
	/// installed before activation; a released binding may be replaced between
	/// agent loops without restarting extension children.
	pub fn bind_journal_runtime(&self, id: u64, runtime: JournalRuntime) -> Result<(), WorkerError> {
		let mut slot = self.journal_runtime.lock();
		if slot.binding.is_some() {
			return Err(WorkerError::Protocol(sf!("journal runtime is already bound")));
		}
		if self.children_active.load(Ordering::Acquire) && !slot.was_bound {
			return Err(WorkerError::Protocol(sf!(
				"journal runtime must be bound before the first extension child is active",
			)));
		}
		slot.binding = Some(BoundJournalRuntime { id, runtime });
		slot.was_bound = true;
		Ok(())
	}

	/// Releases the runtime only when it is still owned by `id`.
	pub fn unbind_journal_runtime(&self, id: u64) {
		let mut slot = self.journal_runtime.lock();
		if slot
			.binding
			.as_ref()
			.is_some_and(|binding| binding.id == id)
		{
			slot.binding = None;
		}
	}

	/// Binds the active Agent mailbox's device availability destination.
	pub fn bind_availability_sink(&self, sink: Arc<dyn AvailabilitySink>) {
		let pending = {
			let mut availability_sink = self.availability_sink.lock();
			*availability_sink = Some(Arc::clone(&sink));
			mem::take(&mut *self.availability_pending.lock())
		};
		for batch in pending {
			sink.set_availability(batch);
		}
	}

	/// Opens one invocation and establishes its host-owned request mapping.
	///
	/// The declaration's `streams_args` bit selects the protocol. Non-streaming
	/// tools are not dispatched until the final [`ArgsCommitted`] frame arrives.
	///
	/// # Errors
	/// Returns [`WorkerError::NotRegistered`] when no active extension owns the
	/// exact name/revision, or [`WorkerError::Unavailable`] when its host actor
	/// has stopped.
	pub fn open(&self, call: OpenToolCall) -> Result<WorkerInvocation, WorkerError> {
		let route = self
			.routes
			.get(&(call.name.clone(), call.rev.clone()))
			.ok_or_else(|| WorkerError::NotRegistered {
				name: call.name.clone(),
				rev:  call.rev.clone(),
			})?;
		self.children_active.store(true, Ordering::Release);
		let commands = route.commands.clone();
		let id = self.next_invocation.fetch_add(1, Ordering::Relaxed).max(1);
		let invocation_id = call.invocation_id.clone();
		if let Some(authority) = &self.data_authority {
			authority.open(route.owner.clone(), invocation_id.clone());
		}
		let (events_tx, events) = flume::unbounded();
		if commands
			.send(SupervisorCommand::Open {
				id,
				owner: route.owner.clone(),
				call,
				streams_args: route.streams_args,
				events: events_tx,
			})
			.is_err()
		{
			if let Some(authority) = &self.data_authority {
				authority.settle(&route.owner, invocation_id.as_str());
			}
			return Err(WorkerError::Unavailable);
		}
		Ok(WorkerInvocation {
			id,
			invocation_id,
			owner: route.owner.clone(),
			data_authority: self.data_authority.clone(),
			streams_args: route.streams_args,
			maximum_effects: route.maximum_effects.clone(),
			host_generation: route.host_generation.load(Ordering::Acquire),
			session_generation: route.session_generation,
			events,
			commands,
			committed: false,
			terminal: false,
			cancel_requested: false,
		})
	}

	/// Replaces only the child which owns `extension` with a hot-reload
	/// generation.
	pub async fn reload_extension(&self, extension: &str) -> Result<u64, WorkerError> {
		let host = self
			.actors
			.iter()
			.rev()
			.find(|host| host.reloadable && host.owners.iter().any(|owner| owner == extension))
			.ok_or(WorkerError::Unavailable)?;
		reload_host(&host.commands).await
	}

	/// Drains idle process hosts and replaces each with a hot-reload generation.
	pub async fn reload(&self) -> Result<Vec<u64>, WorkerError> {
		let mut generations = Vec::new();
		for host in self.actors.iter().filter(|host| host.reloadable) {
			generations.push(reload_host(&host.commands).await?);
		}
		Ok(generations)
	}

	/// Stops every active host and waits for its process group to exit.
	pub async fn shutdown(&self) {
		for watcher in &self.watchers {
			watcher.shutdown.cancel();
		}
		for host in &self.actors {
			host.shutdown.cancel();
			let _ = host.commands.send(SupervisorCommand::Shutdown);
		}
		for host in &self.actors {
			let actor = host.actor.lock().take();
			if let Some(actor) = actor {
				let _ = actor.await;
			}
		}
		for watcher in &self.watchers {
			watcher.actor.abort();
		}
	}

	/// Immediately stops every process group containing a newly revoked
	/// extension. Static routes remain registered and therefore fail closed as
	/// unavailable deny stubs for the remainder of the session.
	pub async fn quarantine(&self, extensions: &[Str]) {
		for host in &self.actors {
			if host
				.owners
				.iter()
				.any(|owner| extensions.iter().any(|extension| extension == owner))
			{
				host.shutdown.cancel();
				let _ = host.commands.send(SupervisorCommand::Shutdown);
			}
		}
		for host in &self.actors {
			if host
				.owners
				.iter()
				.any(|owner| extensions.iter().any(|extension| extension == owner))
			{
				let actor = host.actor.lock().take();
				if let Some(actor) = actor {
					let _ = actor.await;
				}
			}
		}
	}
}
#[derive(Clone, Copy)]
enum UiDispatchKind {
	Command,
	Shortcut,
	Completion,
}

fn ui_completion_candidates(value: serde_json::Value) -> Vec<CompletionCandidate> {
	let Some(items) = value.as_array() else {
		return Vec::new();
	};
	items
		.iter()
		.take(100)
		.filter_map(|item| {
			let item = item.as_object()?;
			let value = item.get("insert")?.as_str()?.to_owned();
			let optional = |name| {
				item
					.get(name)
					.and_then(serde_json::Value::as_str)
					.map(str::to_owned)
			};
			Some(CompletionCandidate {
				value,
				display: optional("label"),
				description: optional("desc"),
				hint: optional("hint"),
				group: optional("group"),
				icon: optional("icon"),
				sort: item
					.get("sort")
					.and_then(serde_json::Value::as_i64)
					.unwrap_or_default()
					.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
			})
		})
		.collect()
}

fn ui_command_dispatch_result(value: serde_json::Value) -> CommandDispatchResult {
	let Some(object) = value.as_object() else {
		return CommandDispatchResult::default();
	};
	if let Some(text) = object.get("text").and_then(serde_json::Value::as_str) {
		return CommandDispatchResult {
			outcome: Some(command_dispatch_result::Outcome::Prompt(text.to_owned())),
			submit:  object.get("submit").and_then(serde_json::Value::as_bool),
		};
	}
	let consumed = object
		.get("notice")
		.and_then(serde_json::Value::as_object)
		.and_then(|notice| {
			notice
				.get("_source")
				.or_else(|| notice.get("source"))
				.and_then(serde_json::Value::as_str)
		})
		.map(|source| omp_proto::ui::v1::Tml {
			source: Bytes::copy_from_slice(source.as_bytes()),
			hash:   0,
		});
	CommandDispatchResult {
		outcome: consumed.map(command_dispatch_result::Outcome::Consumed),
		submit:  None,
	}
}

fn extension_callback_protocol_error(error: ExtensionCallbackError) -> ControlProtocolError {
	match error {
		ExtensionCallbackError::StaleHostGeneration { expected, actual } => {
			ControlProtocolError::new(
				"StaleGeneration",
				format!("stale host generation: expected {expected}, got {actual}"),
			)
			.with_details(serde_json::json!({
				"field": "host_generation",
				"expected": expected,
				"actual": actual,
			}))
		},
		ExtensionCallbackError::StaleSessionGeneration { expected, actual } => {
			ControlProtocolError::new(
				"StaleGeneration",
				format!("stale session generation: expected {expected}, got {actual}"),
			)
			.with_details(serde_json::json!({
				"field": "session_generation",
				"expected": expected,
				"actual": actual,
			}))
		},
		ExtensionCallbackError::Runtime(ControlRuntimeError::Remote(error)) => error,
		ExtensionCallbackError::Runtime(ControlRuntimeError::Dispatch(DispatchError::Deadline)) => {
			ControlProtocolError::new("DeadlineExceeded", "extension callback deadline elapsed")
		},
		ExtensionCallbackError::Session => ControlProtocolError::new(
			"InvalidPhase",
			"extension callback authority belongs to another session",
		),
		ExtensionCallbackError::UnknownHost => ControlProtocolError::new(
			"CallbackUnavailable",
			"the registered extension callback host is unavailable",
		)
		.retryable(true),
		ExtensionCallbackError::InvalidOperation => {
			ControlProtocolError::new("InvalidOperation", "operation is not an extension callback")
		},
		ExtensionCallbackError::Runtime(error) => {
			ControlProtocolError::new("CallbackUnavailable", Str::from(error.to_string()))
				.retryable(true)
		},
	}
}

#[async_trait::async_trait]
impl CallbackDispatcher for ExtHostSupervisor {
	async fn dispatch(
		&self,
		target: Arc<ControlConnectionIdentity>,
		dispatch: ControlDispatch,
	) -> Result<serde_json::Value, ControlProtocolError> {
		match self
			.dispatch_extension_callback(target.as_ref(), dispatch)
			.await
		{
			Ok(value) => Ok(value),
			Err(ExtensionCallbackError::StaleHostGeneration { expected, actual }) => Err(
				ControlProtocolError::new(
					"StaleGeneration",
					format!("stale host generation: expected {expected}, got {actual}"),
				)
				.with_details(serde_json::json!({
					"field": "host_generation",
					"expected": expected,
					"actual": actual,
				})),
			),
			Err(ExtensionCallbackError::StaleSessionGeneration { expected, actual }) => Err(
				ControlProtocolError::new(
					"StaleGeneration",
					format!("stale session generation: expected {expected}, got {actual}"),
				)
				.with_details(serde_json::json!({
					"field": "session_generation",
					"expected": expected,
					"actual": actual,
				})),
			),
			Err(ExtensionCallbackError::Runtime(ControlRuntimeError::Remote(error))) => Err(error),
			Err(ExtensionCallbackError::Runtime(ControlRuntimeError::Dispatch(
				DispatchError::Deadline,
			))) => Err(ControlProtocolError::new(
				"DeadlineExceeded",
				"extension callback deadline elapsed",
			)),
			Err(ExtensionCallbackError::Session) => Err(ControlProtocolError::new(
				"InvalidPhase",
				"extension callback authority belongs to another session",
			)),
			Err(ExtensionCallbackError::UnknownHost) => Err(
				ControlProtocolError::new(
					"CallbackUnavailable",
					"the registered extension callback host is unavailable",
				)
				.retryable(true),
			),
			Err(ExtensionCallbackError::InvalidOperation) => Err(ControlProtocolError::new(
				"InvalidOperation",
				"operation is not an extension device or hook callback",
			)),
			Err(ExtensionCallbackError::Runtime(error)) => Err(
				ControlProtocolError::new("CallbackUnavailable", Str::from(error.to_string()))
					.retryable(true),
			),
		}
	}

	async fn dispatch_ui(
		&self,
		target: Arc<ControlConnectionIdentity>,
		authority: ControlInvocationAuthority,
		dispatch: UiCallbackDispatch,
		timeout: Duration,
	) -> Result<UiDispatchResult, ControlProtocolError> {
		self
			.dispatch_extension_ui_callback(target.as_ref(), authority, dispatch, timeout)
			.await
	}
}

#[async_trait::async_trait]
impl PromptContributionProvider for ExtHostSupervisor {
	fn declarations(&self) -> Vec<PromptSlotBinding> {
		self.prompt_registrations.to_vec()
	}

	async fn pull(
		&self,
		binding: &PromptSlotBinding,
		context: &PromptPullContext,
	) -> Result<PromptContributionRecord, PromptDispatchError> {
		let route = self
			.prompt_routes
			.get(&binding.owner)
			.ok_or(PromptDispatchError::Undeclared)?;
		let request_id = self.next_invocation.fetch_add(1, Ordering::Relaxed).max(1);
		let (reply, response) = flume::bounded(1);
		route
			.commands
			.send_async(SupervisorCommand::PromptPull {
				request_id,
				binding: binding.clone(),
				context: context.clone(),
				reply,
			})
			.await
			.map_err(|_| PromptDispatchError::Worker(WorkerError::Unavailable))?;
		response
			.recv_async()
			.await
			.map_err(|_| PromptDispatchError::Worker(WorkerError::Unavailable))?
			.map_err(PromptDispatchError::Worker)
	}
}

#[derive(Clone)]
struct PromptRoute {
	commands: flume::Sender<SupervisorCommand>,
}

#[derive(Clone)]
struct HostRoute {
	commands:           flume::Sender<SupervisorCommand>,
	owner:              HostKey,
	streams_args:       bool,
	maximum_effects:    omp_tool::Effects,
	host_generation:    Arc<AtomicU64>,
	session_generation: u64,
}

struct LinkWatcher {
	shutdown: CancellationToken,
	actor:    JoinHandle<()>,
}

struct ResourcesChangedEvent;

impl HookEvent for ResourcesChangedEvent {
	type Return = ();

	const ID: v1::HookEventId = v1::HookEventId::HookEventResourcesChanged;
	const REV: u32 = 1;

	fn encode_into(&self, out: &mut BytesMut) {
		out.extend_from_slice(b"\n");
		out.extend_from_slice(br#"{"added":[],"removed":[],"reason":"extension_changed"}"#);
	}

	fn apply(&mut self, _: &HookPatch) -> Result<(), GateError> {
		Ok(())
	}
}

async fn reload_host(commands: &flume::Sender<SupervisorCommand>) -> Result<u64, WorkerError> {
	let (reply, response) = flume::bounded(1);
	commands
		.send_async(SupervisorCommand::Reload { reply })
		.await
		.map_err(|_| WorkerError::Unavailable)?;
	response
		.recv_async()
		.await
		.map_err(|_| WorkerError::Unavailable)?
}

fn spawn_link_watcher(
	root: &Path,
	extension: Str,
	commands: flume::Sender<SupervisorCommand>,
	hook_gate: Option<Arc<HookGate>>,
) -> Option<LinkWatcher> {
	let (events, changes) = flume::unbounded();
	let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
		if event.is_ok() {
			let _ = events.send(());
		}
	})
	.ok()?;
	watcher.watch(root, RecursiveMode::Recursive).ok()?;
	let shutdown = CancellationToken::new();
	let task_shutdown = shutdown.clone();
	let actor = tokio::spawn(async move {
		let _watcher = watcher;
		loop {
			tokio::select! {
				() = task_shutdown.cancelled() => break,
				change = changes.recv_async() => {
					if change.is_err() {
						break;
					}
					time::sleep(Duration::from_millis(100)).await;
					while changes.try_recv().is_ok() {}
					loop {
						match reload_host(&commands).await {
							Ok(_) => {
								if let Some(gate) = hook_gate.as_deref()
									&& gate.subscribed(v1::HookEventId::HookEventResourcesChanged)
								{
									gate.notify(&ResourcesChangedEvent);
								}
								break;
							},
							Err(WorkerError::Unavailable) => {
								tokio::select! {
									() = task_shutdown.cancelled() => return,
									() = time::sleep(Duration::from_millis(100)) => {},
								}
							},
							Err(error) => {
								tracing::warn!(%extension, %error, "linked extension hot reload failed");
								break;
							},
						}
					}
				},
			}
		}
	});
	Some(LinkWatcher { shutdown, actor })
}

struct HostActor {
	commands:   flume::Sender<SupervisorCommand>,
	actor:      Mutex<Option<JoinHandle<()>>>,
	shutdown:   CancellationToken,
	reloadable: bool,
	owners:     Arc<[Str]>,
}

/// Failure while composing or starting a dedicated CONTROL connection.
#[derive(Debug, Error)]
pub enum ControlHostStartError {
	/// A required domain owner could not be constructed.
	#[error(transparent)]
	Composition(#[from] ControlCompositionError),
	/// The child or CONTROL pump failed to start.
	#[error(transparent)]
	Runtime(#[from] RunningHostError),
}

/// Failure while selecting or calling one exact live Python callback host.
#[derive(Debug, Error)]
pub enum ExtensionCallbackError {
	/// No active CONTROL host owns the authenticated extension identity.
	#[error("no live extension callback host owns the authenticated identity")]
	UnknownHost,
	/// The requested operation is not a device or hook callback.
	#[error("operation is not an extension device or hook callback")]
	InvalidOperation,
	/// A replaced host generation attempted to receive a callback.
	#[error("extension callback host generation is stale: expected {expected}, got {actual}")]
	StaleHostGeneration {
		/// Generation of the active callback host.
		expected: u64,
		/// Generation supplied by the retained registry binding.
		actual:   u64,
	},
	/// The callback binding belongs to another session generation.
	#[error("extension callback session generation is stale: expected {expected}, got {actual}")]
	StaleSessionGeneration {
		/// Generation of the active session.
		expected: u64,
		/// Generation supplied by the retained registry binding.
		actual:   u64,
	},
	/// Callback authority was scoped to a different session.
	#[error("extension callback authority belongs to another session")]
	Session,
	/// The live CONTROL runtime rejected or failed the callback.
	#[error(transparent)]
	Runtime(#[from] ControlRuntimeError),
}

/// Worker startup, transport, protocol, or embedded-Python failure.
#[derive(Debug, Error)]
pub enum WorkerError {
	/// Failed to resolve or launch the worker process.
	#[error("python tool worker I/O failed: {0}")]
	Io(#[from] io::Error),
	/// A protobuf frame was malformed.
	#[error("python tool worker sent an invalid protobuf frame: {0}")]
	Decode(#[from] omp_proto::prost::DecodeError),
	/// A protobuf frame could not be encoded.
	#[error("python tool worker frame encoding failed: {0}")]
	Encode(#[from] omp_proto::prost::EncodeError),
	/// A frame length prefix was invalid.
	#[error("python tool worker frame length prefix is invalid")]
	InvalidLength,
	/// A frame exceeded the configured bound.
	#[error("python tool worker frame is {actual} bytes; limit is {limit}")]
	FrameTooLarge {
		/// Encoded message length.
		actual: usize,
		/// Configured maximum.
		limit:  usize,
	},
	/// An encoded frame violated extension-host allocation bounds.
	#[error("python tool worker frame bounds violation: {0}")]
	FrameBounds(#[from] omp_proto::bounds::FrameBoundsError),
	/// The worker did not complete a health operation in time.
	#[error("python tool worker health check timed out")]
	HealthTimeout,
	/// The worker closed its protocol stream.
	#[error("python tool worker exited")]
	Exited,
	/// The worker used an unexpected protocol sequence.
	#[error("python tool worker protocol violation: {0}")]
	Protocol(Str),
	/// Host and worker schema revisions differed.
	#[error("python tool worker schema revision {actual} does not match host {expected}")]
	SchemaRevision {
		/// Host revision.
		expected: u32,
		/// Worker revision.
		actual:   u32,
	},
	/// Host and worker Python revisions differed.
	#[error("python tool worker Python revision {actual} does not match host {expected}")]
	PythonRevision {
		/// Host revision.
		expected: Str,
		/// Worker revision.
		actual:   Str,
	},
	/// No configured extension registered the requested exact tool identity.
	#[error("no extension host registered tool {name} at revision {rev}")]
	NotRegistered {
		/// Requested tool name.
		name: Str,
		/// Requested tool revision.
		rev:  Str,
	},
	/// A Python extension declaration or invocation failed.
	#[error("python tool extension failed: {0}")]
	Python(Str),
	/// The supervisor actor is no longer available.
	#[error("python tool worker supervisor is unavailable")]
	Unavailable,
	/// Named-worker routing refused immediate placement.
	#[error(transparent)]
	WorkerUnavailable(#[from] WorkerUnavailable),
}

impl From<PyErr> for WorkerError {
	fn from(error: PyErr) -> Self {
		Self::Python(Str::from(error.to_string()))
	}
}

enum SupervisorCommand {
	Open {
		id:           u64,
		owner:        HostKey,
		call:         OpenToolCall,
		streams_args: bool,
		events:       flume::Sender<WorkerEvent>,
	},
	ArgText {
		id:    u64,
		frame: ArgText,
	},
	ArgsCommitted {
		id:    u64,
		frame: ArgsCommitted,
	},
	PullReply {
		id:    u64,
		reply: PullReply,
	},
	ServiceDispatch {
		request_id: u64,
		frame:      WireServiceDispatch,
		reply:      flume::Sender<Result<ServiceResult, WorkerError>>,
	},
	PromptPull {
		request_id: u64,
		binding:    PromptSlotBinding,
		context:    PromptPullContext,
		reply:      flume::Sender<Result<PromptContributionRecord, WorkerError>>,
	},
	Cancel {
		id:     u64,
		reason: Str,
	},
	Interrupt {
		id:    u64,
		frame: Interrupt,
	},
	Reload {
		reply: flume::Sender<Result<u64, WorkerError>>,
	},
	Shutdown,
}

struct PendingInvocation {
	id:           u64,
	owner:        HostKey,
	call:         OpenToolCall,
	streams_args: bool,
	arguments:    VecDeque<ArgText>,
	committed:    Option<ArgsCommitted>,
	interrupt:    Option<Interrupt>,
	events:       flume::Sender<WorkerEvent>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum FateUnit {
	Extension(Str),
	Pool(Str),
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ProcessKey {
	layer: Str,
	tier:  Str,
	unit:  FateUnit,
}

impl ProcessKey {
	fn from_spec(spec: &ExtHostSpec) -> Self {
		let unit = if spec.data_socket.is_some() {
			FateUnit::Extension(spec.key.extension().clone())
		} else {
			spec
				.pool
				.clone()
				.map_or_else(|| FateUnit::Extension(spec.key.extension().clone()), FateUnit::Pool)
		};
		Self { layer: spec.key.layer().clone(), tier: spec.key.tier().clone(), unit }
	}

	const fn pool(&self) -> Option<&Str> {
		match &self.unit {
			FateUnit::Extension(_) => None,
			FateUnit::Pool(pool) => Some(pool),
		}
	}
}

#[derive(Clone)]
struct ProcessConfig {
	process_id:           ProcessKey,
	executable:           PathBuf,
	workspace_root:       Option<PathBuf>,
	python_site:          Option<PathBuf>,
	exact_entry:          Option<(Str, PathBuf)>,
	modules:              Vec<Str>,
	manifests:            BTreeMap<HostKey, ExtensionManifest>,
	cli_values:           BTreeMap<HostKey, Vec<ActivationCliValue>>,
	data_socket:          Option<PathBuf>,
	schema_rev:           u32,
	python_rev:           Str,
	principal:            omp_core::Principal,
	session_started_at:   SystemTime,
	session_id:           Str,
	max_frame_bytes:      NonZeroUsize,
	health_timeout:       Duration,
	spawn_timeout:        Duration,
	ping_interval:        Duration,
	interrupt_grace:      Duration,
	initial_backoff:      Duration,
	max_backoff:          Duration,
	healthy_reset:        Duration,
	session_generation:   u64,
	scheme_snapshot:      Option<SchemeSnapshot>,
	journal:              Arc<Mutex<JournalRuntimeSlot>>,
	resources:            Arc<Mutex<ControlQuotaLedger>>,
	availability_sink:    Arc<Mutex<Option<Arc<dyn AvailabilitySink>>>>,
	availability_pending: Arc<Mutex<VecDeque<AvailabilityBatch>>>,
	lifecycle_gate:       Option<Arc<HookGate>>,
}

impl ProcessConfig {
	fn new(
		root: &ExtHostConfig,
		process_id: ProcessKey,
		extensions: Vec<ExtHostSpec>,
		resources: Arc<Mutex<ControlQuotaLedger>>,
		availability_pending: Arc<Mutex<VecDeque<AvailabilityBatch>>>,
		journal: Arc<Mutex<JournalRuntimeSlot>>,
	) -> Result<Self, WorkerError> {
		let python_site = extensions
			.first()
			.and_then(|extension| extension.python_site.clone());
		if extensions
			.iter()
			.any(|extension| extension.python_site != python_site)
		{
			return Err(WorkerError::Protocol(sf!(
				"extensions in an explicit pool must use the same Python site",
			)));
		}
		let executable = extensions
			.first()
			.and_then(|extension| extension.host_executable.clone())
			.unwrap_or_else(|| root.executable.clone());
		if extensions.iter().any(|extension| {
			extension
				.host_executable
				.as_ref()
				.unwrap_or(&root.executable)
				!= &executable
		}) {
			return Err(WorkerError::Protocol(sf!(
				"extensions in an explicit pool must use the same host executable",
			)));
		}
		let data_socket = extensions
			.first()
			.and_then(|extension| extension.data_socket.clone());
		if extensions
			.iter()
			.any(|extension| extension.data_socket != data_socket)
		{
			return Err(WorkerError::Protocol(sf!(
				"extensions in an explicit pool must use the same scoped DATA socket",
			)));
		}
		let exact_entries = extensions
			.iter()
			.filter_map(|extension| {
				extension
					.entry_path
					.as_ref()
					.map(|path| (extension.manifest.entry.clone(), path.clone()))
			})
			.collect::<Vec<_>>();
		if exact_entries.len() > 1 {
			return Err(WorkerError::Protocol(sf!(
				"an exact trusted module cannot share an extension host process",
			)));
		}
		let exact_entry = exact_entries.into_iter().next();
		let mut modules_seen = HashSet::new();
		let mut manifests = BTreeMap::new();
		let mut cli_values = BTreeMap::new();
		let mut modules = Vec::new();
		for extension in extensions {
			let mut delivery = ContributedValueDelivery::new(
				extension.key.extension().clone(),
				1,
				&extension.cli_contributions,
				&root.contributed_values,
			)
			.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
			let values = delivery
				.deliver(extension.key.extension(), 1)
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
			let key = extension.key;
			for module in iter::once(extension.manifest.entry.clone())
				.chain(extension.manifest.declaration_modules.iter().cloned())
			{
				if !modules_seen.insert(module.clone()) {
					return Err(WorkerError::Protocol(sf!(
						"an extension declaration module is configured more than once in one host",
					)));
				}
				modules.push(module);
			}
			cli_values.insert(key.clone(), values);
			manifests.insert(key, extension.manifest);
		}
		Ok(Self {
			process_id,
			executable,
			workspace_root: root.workspace_root.clone(),
			python_site,
			exact_entry,
			modules,
			manifests,
			cli_values,
			data_socket,
			schema_rev: root.schema_rev,
			python_rev: root.python_rev.clone(),
			principal: root.principal.clone(),
			session_id: root.session_id.clone(),
			session_started_at: root.session_started_at,
			max_frame_bytes: root.max_frame_bytes,
			health_timeout: root.health_timeout,
			spawn_timeout: root.spawn_timeout,
			ping_interval: root.ping_interval,
			interrupt_grace: root
				.interrupt_grace
				.to_std()
				.map_err(|_| WorkerError::Protocol(sf!("interrupt grace is too large")))?,
			initial_backoff: root.initial_backoff,
			max_backoff: root.max_backoff,
			healthy_reset: root.healthy_reset,
			session_generation: root.session_generation,
			scheme_snapshot: root.scheme_snapshot.clone(),
			journal,
			resources,
			availability_sink: Arc::clone(&root.availability_sink),
			availability_pending,
			lifecycle_gate: root
				.hook_control
				.as_ref()
				.map(|hooks| hooks.admission_gate()),
		})
	}

	fn owner_for(&self, declaration: &ToolDecl) -> Result<HostKey, WorkerError> {
		self
			.manifests
			.keys()
			.find(|owner| owner.extension().as_str() == declaration.extension_id)
			.cloned()
			.ok_or_else(|| {
				WorkerError::Protocol(sf!(
					"worker registered a declaration for an unconfigured extension",
				))
			})
	}

	fn hard_tool_granted(&self, owner: &HostKey, name: &str) -> bool {
		let Some(manifest) = self.manifests.get(owner) else {
			return false;
		};
		if manifest.runtime_declarations_trusted() {
			return true;
		}
		let declarations = manifest.static_declarations();
		let declared = declarations.tools.iter().any(|row| {
			row.kind == "hard"
				&& (row.key == name
					|| row
						.key
						.split_once('@')
						.is_some_and(|(tool, _)| tool == name)
					|| row.id == name)
		});
		if !declared {
			return false;
		}
		// `native` is an exact invocation root selected directly by the operator.
		if owner.layer() == "native" {
			return true;
		}
		let grants = declarations
			.capability_grants
			.get("tools.hard")
			.or_else(|| {
				declarations
					.capability_grants
					.get("tools")
					.and_then(|tools| tools.get("hard"))
			});
		grants
			.and_then(serde_json::Value::as_array)
			.is_some_and(|names| names.iter().any(|granted| granted.as_str() == Some(name)))
	}
}

fn validate_extension_spec(spec: &ExtHostSpec) -> Result<(), WorkerError> {
	if spec.key.layer().is_empty()
		|| spec.key.tier().is_empty()
		|| spec.key.extension().is_empty()
		|| spec.manifest.entry.is_empty()
		|| spec.pool.as_ref().is_some_and(Str::is_empty)
	{
		return Err(WorkerError::Protocol(sf!(
			"extension host identity, manifest entry, and explicit pool names must be nonempty",
		)));
	}
	if spec.manifest.provenance.extension_id() != spec.key.extension().as_str()
		|| spec.manifest.provenance.layer() != spec.key.layer().as_str()
		|| spec.manifest.provenance.tier() != spec.key.tier().as_str()
	{
		return Err(WorkerError::Protocol(sf!(
			"extension manifest provenance does not match its authenticated host key",
		)));
	}
	Ok(())
}

struct WorkerProcess {
	child:                 Child,
	stdin:                 ChildStdin,
	stdout:                ChildStdout,
	read_scratch:          BytesMut,
	write_scratch:         BytesMut,
	registrations:         Vec<ToolDecl>,
	prompt_registrations:  Vec<PromptSlotBinding>,
	ui_registrations:      BTreeMap<HostKey, RegisterUi>,
	service_registrations: BTreeMap<HostKey, Box<[ServiceProviderDeclaration]>>,
}
#[derive(Deserialize)]
struct RegisteredCallback {
	#[serde(rename = "$omp.callable")]
	callable: String,
}
#[derive(Deserialize)]
struct RegisteredMarkdownTransformer {
	kind:    String,
	name:    String,
	value:   RegisteredCallback,
	trigger: String,
}
#[derive(Deserialize)]
struct RegisteredRendererValue {
	function:  RegisteredCallback,
	#[serde(default)]
	reduce:    Option<RegisteredCallback>,
	#[serde(default)]
	decorates: bool,
}

#[derive(Deserialize)]
struct RegisteredRenderer {
	kind:    String,
	name:    (String, String, u16),
	value:   RegisteredRendererValue,
	trigger: String,
}

#[derive(Deserialize)]
struct RegisteredCompletion {
	kind:     String,
	name:     String,
	value:    RegisteredCallback,
	metadata: RegisteredCompletionTrigger,
	trigger:  String,
}

#[derive(Deserialize)]
struct RegisteredCompletionTrigger {
	prefix:         String,
	#[serde(default)]
	at_line_start:  bool,
	#[serde(default)]
	min_chars:      u32,
	#[serde(default = "default_completion_debounce")]
	debounce:       serde_json::Value,
	#[serde(default = "default_completion_max_results")]
	max_results:    u32,
	#[serde(default = "default_completion_cache")]
	cache:          serde_json::Value,
	#[serde(default = "default_completion_refine_locally")]
	refine_locally: bool,
}

fn default_completion_debounce() -> serde_json::Value {
	serde_json::Value::String("90ms".to_owned())
}

const fn default_completion_max_results() -> u32 {
	20
}

fn default_completion_cache() -> serde_json::Value {
	serde_json::Value::String("2s".to_owned())
}

const fn default_completion_refine_locally() -> bool {
	true
}

#[derive(Deserialize)]
struct RegisteredCommandArg {
	name:        String,
	#[serde(default)]
	description: String,
	#[serde(default)]
	usage:       Option<String>,
}

#[derive(Deserialize)]
struct RegisteredCommand {
	name:            String,
	#[serde(default)]
	aliases:         Vec<String>,
	#[serde(default)]
	description:     String,
	#[serde(default)]
	args:            Vec<RegisteredCommandArg>,
	#[serde(default)]
	hint:            Option<String>,
	#[serde(default)]
	arg_completions: Option<RegisteredCallback>,
	handler:         RegisteredCallback,
	#[serde(default)]
	trigger:         String,
}

#[derive(Deserialize)]
struct RegisteredShortcut {
	chord:       String,
	action_id:   String,
	#[serde(default)]
	description: String,
	#[serde(default)]
	when:        Option<Vec<String>>,
	handler:     RegisteredCallback,
	#[serde(default)]
	trigger:     String,
}

#[derive(Deserialize)]
struct RegisteredServiceMethod {
	name:          String,
	input_schema:  serde_json::Value,
	result_schema: serde_json::Value,
}

#[derive(Deserialize)]
struct RegisteredService {
	name:          String,
	rev:           u32,
	source_module: String,
	methods:       Vec<RegisteredServiceMethod>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
struct RegisteredTool {
	name:          Str,
	family:        Str,
	rev:           u16,
	kind:          Str,
	place:         Str,
	source_module: Str,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
struct RegisteredHook {
	event:            Str,
	phase:            Str,
	name:             Str,
	order:            i32,
	on_failure:       Option<Str>,
	timeout:          Option<Str>,
	concurrency:      usize,
	threadsafe:       bool,
	#[serde(default)]
	when:             Option<RegisteredHookWhen>,
	event_rev:        u16,
	event_on_failure: Str,
	event_default:    Option<Str>,
	event_timeout:    Str,
	#[serde(default)]
	composition:      BTreeMap<Str, Str>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
struct RegisteredHookWhen {
	#[serde(default)]
	provider:     Option<Vec<Str>>,
	#[serde(default)]
	server:       Option<Vec<Str>>,
	#[serde(default)]
	method_globs: Vec<Str>,
}

#[derive(Deserialize)]
struct RegisteredSkill {
	path:     Str,
	#[serde(default)]
	metadata: BTreeMap<Str, serde_json::Value>,
}

#[derive(Deserialize)]
struct RegisteredRegistrySnapshot {
	#[serde(default)]
	tools:                 Vec<RegisteredTool>,
	#[serde(default)]
	hooks:                 Vec<RegisteredHook>,
	#[serde(default)]
	skills:                Vec<RegisteredSkill>,
	#[serde(default)]
	services:              Vec<RegisteredService>,
	#[serde(default)]
	commands:              Vec<RegisteredCommand>,
	#[serde(default)]
	shortcuts:             Vec<RegisteredShortcut>,
	#[serde(default)]
	completions:           Vec<RegisteredCompletion>,
	#[serde(default)]
	markdown_transformers: Vec<RegisteredMarkdownTransformer>,
	#[serde(default)]
	verdict_renderers:     Vec<RegisteredRenderer>,
	#[serde(default)]
	providers:             Vec<serde_json::Value>,
	#[serde(default)]
	regimes:               Vec<serde_json::Value>,
}

/// One manifest-verified runtime tool registration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedToolRegistration {
	/// Public device name.
	pub name:          Str,
	/// Compatibility family.
	pub family:        Str,
	/// Monotonic family revision.
	pub rev:           u16,
	/// Frozen declaration kind.
	pub kind:          Str,
	/// Frozen placement spelling.
	pub place:         Str,
	/// Admitted module which created the declaration.
	pub source_module: Str,
}

/// One manifest-verified runtime hook subscription key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedHookRegistration {
	/// Stable event name.
	pub event:            Str,
	/// Frozen hook phase.
	pub phase:            Str,
	/// Stable callback name selected inside Python.
	pub name:             Str,
	/// Deterministic callback order.
	pub order:            i32,
	/// Optional callback failure override.
	pub on_failure:       Option<HookFailurePolicy>,
	/// Optional callback timeout override.
	pub timeout:          Option<Duration>,
	/// Declared callback overlap behavior.
	pub concurrency:      CallbackConcurrency,
	/// Provider ids admitted by this callback, when provider-scoped.
	pub providers:        Option<Box<[Str]>>,
	/// Exact raw MCP mount names admitted by this callback.
	pub servers:          Option<Box<[Str]>>,
	/// Anchored MCP JSON-RPC method globs admitted by this callback.
	pub method_globs:     Box<[Str]>,
	/// Exact event payload/decision revision.
	pub event_revision:   u16,
	/// Event-level callback failure default.
	pub event_on_failure: HookFailurePolicy,
	/// Event default decision for an all-deferred composition.
	pub event_default:    serde_json::Value,
	/// Event-level callback deadline.
	pub event_timeout:    Duration,
	/// Event field composition declarations.
	pub composition:      BTreeMap<Str, HookFieldComposition>,
}

/// Exact sealed registry publication accepted from one authenticated child.
#[derive(Clone, Debug)]
pub struct SealedRegistryEvidence {
	/// Connection identity whose generation published this evidence.
	pub identity:   Arc<ControlConnectionIdentity>,
	/// Host-authenticated session identity used by generation-fenced callbacks.
	pub session:    Option<Str>,
	/// Core-authenticated installation provenance behind the publication.
	pub provenance: omp_core::Provenance,
	/// Verified runtime tool declarations.
	pub tools:      Arc<[SealedToolRegistration]>,
	/// Verified runtime hook declaration keys.
	pub hooks:      Arc<[SealedHookRegistration]>,
	/// Manifest-verified command and shortcut declarations.
	pub ui:         VerifiedUiRoster,
	/// Full frozen runtime provider declaration documents.
	pub providers:  Arc<[serde_json::Value]>,
	/// Full frozen runtime regime declaration documents.
	pub regimes:    Arc<[serde_json::Value]>,
}
type RegimeEvidenceLookup =
	dyn Fn(&ControlConnectionIdentity) -> Option<Arc<SealedRegistryEvidence>> + Send + Sync;

/// Resolves executable extension regimes only from exact-generation FREEZE
/// evidence.
pub struct ExtensionRegimeResolver {
	callbacks: Arc<dyn CallbackDispatcher>,
	evidence:  Arc<RegimeEvidenceLookup>,
	owners:    Mutex<BTreeMap<Str, Str>>,
	runtime:   Option<runtime::Handle>,
}

impl ExtensionRegimeResolver {
	/// Binds the live callback router to the retained frozen declaration lookup.
	pub fn new<F>(callbacks: Arc<dyn CallbackDispatcher>, evidence: F) -> Arc<Self>
	where
		F: Fn(&ControlConnectionIdentity) -> Option<Arc<SealedRegistryEvidence>>
			+ Send
			+ Sync
			+ 'static,
	{
		Arc::new(Self {
			callbacks,
			evidence: Arc::new(evidence),
			owners: Mutex::new(BTreeMap::new()),
			runtime: runtime::Handle::try_current().ok(),
		})
	}

	/// Resolves one declaration and constructs its exact-generation callback
	/// machine.
	pub fn resolve(
		&self,
		identity: &ControlConnectionIdentity,
		regime: &str,
		state: Option<&[u8]>,
		state_revision: Option<u32>,
	) -> Result<(Arc<omp_agent::RegimeSpec>, Box<dyn omp_agent::Regime>), ControlProtocolError> {
		let evidence = (self.evidence)(identity).ok_or_else(|| {
			ControlProtocolError::new(
				"StaleGeneration",
				"regime declarations are unavailable for this host or session generation",
			)
		})?;
		if !same_control_identity(&evidence.identity, identity) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"regime declaration belongs to a replaced host or session generation",
			));
		}
		let session = evidence.session.clone().ok_or_else(|| {
			ControlProtocolError::new(
				"InvalidRegimeDeclaration",
				"regime declaration has no authenticated callback session",
			)
		})?;
		let document = evidence
			.regimes
			.iter()
			.find(|document| document.get("id").and_then(serde_json::Value::as_str) == Some(regime))
			.ok_or_else(|| {
				ControlProtocolError::new(
					"TargetNotFound",
					"regime is absent from the sealed declaration table",
				)
			})?;
		let declaration = FrozenRegimeDeclaration::parse(document)?;
		let state = state.unwrap_or_default();
		if (!state.is_empty() || state_revision.is_some())
			&& declaration.state_revision != state_revision
		{
			return Err(ControlProtocolError::new(
				"InvalidRegimeState",
				"regime state revision differs from the sealed declaration",
			));
		}
		let state = std::str::from_utf8(state).map_err(|_| {
			ControlProtocolError::new("InvalidRegimeState", "regime state must be UTF-8")
		})?;
		let spec = declaration.spec();
		let mut owners = self.owners.lock();
		if owners
			.get(&spec.id)
			.is_some_and(|owner| owner != &identity.extension)
		{
			return Err(ControlProtocolError::new(
				"InvalidRegimeDeclaration",
				"two extensions resolved the same frozen regime identity",
			));
		}
		owners.insert(spec.id.clone(), identity.extension.clone());
		drop(owners);
		let machine = ExtensionRegime {
			callbacks: Arc::clone(&self.callbacks),
			identity: Arc::clone(&evidence.identity),
			session,
			regime: spec.id.clone(),
			revision: declaration.revision,
			state_revision: declaration.state_revision,
			on_failure: declaration.on_failure,
			state: Str::from(state),
			started_activation: None,
			runtime: self.runtime.clone(),
		};
		Ok((Arc::new(spec), Box::new(machine)))
	}

	/// Returns the owner retained when a frozen declaration was resolved.
	pub fn owner(&self, regime: &str) -> Option<Str> {
		self.owners.lock().get(regime).cloned()
	}
}

#[derive(Clone, Copy)]
enum RegimeFailurePolicy {
	Defer,
	Deny,
}

struct FrozenRegimeDeclaration {
	id: Str,
	revision: u32,
	events: omp_core::PointSet,
	precedence: i16,
	max_steps: Option<u32>,
	committed_step_interval_ms: Option<u64>,
	has_on_limit: bool,
	lifetime: omp_agent::RegimeLifetime,
	family_rev: Str,
	state_revision: Option<u32>,
	when: Option<omp_agent::RegimeWhen>,
	owns: Arc<[omp_agent::Resource]>,
	sets: Arc<[omp_agent::ScopedSetting]>,
	minimum_duration_ms: Option<u64>,
	on_failure: RegimeFailurePolicy,
}

impl FrozenRegimeDeclaration {
	fn parse(document: &serde_json::Value) -> Result<Self, ControlProtocolError> {
		let object = document
			.as_object()
			.ok_or_else(|| frozen_declaration_error("sealed regime manifest must be an object"))?;
		let text = |name: &str| {
			object
				.get(name)
				.and_then(serde_json::Value::as_str)
				.filter(|value| !value.is_empty())
				.ok_or_else(|| frozen_declaration_error(sf!("regime omitted {name}")))
		};
		let id = Str::from(text("id")?);
		let revision = object
			.get("revision")
			.and_then(serde_json::Value::as_u64)
			.and_then(|revision| u32::try_from(revision).ok())
			.filter(|revision| *revision > 0)
			.ok_or_else(|| frozen_declaration_error("regime revision must be positive"))?;
		let mut events = omp_core::PointSet::EMPTY;
		for point in object
			.get("points")
			.and_then(serde_json::Value::as_array)
			.ok_or_else(|| frozen_declaration_error("regime omitted points"))?
		{
			events = events.with(parse_regime_point(
				point
					.as_str()
					.ok_or_else(|| frozen_declaration_error("regime point must be a string"))?,
			)?);
		}
		if events == omp_core::PointSet::EMPTY {
			return Err(frozen_declaration_error("regime points must not be empty"));
		}
		let precedence = object
			.get("precedence")
			.and_then(serde_json::Value::as_i64)
			.and_then(|value| i16::try_from(value).ok())
			.ok_or_else(|| frozen_declaration_error("regime precedence is invalid"))?;
		let lifetime = match text("lifetime")? {
			"turn" => omp_agent::RegimeLifetime::Turn,
			"run" => omp_agent::RegimeLifetime::Run,
			"session" => omp_agent::RegimeLifetime::Session,
			_ => return Err(frozen_declaration_error("regime has an unknown lifetime")),
		};
		let max_steps = optional_u32(object, "max_steps")?;
		let committed_step_interval_ms = optional_u64(object, "committed_step_interval_ms")?;
		let has_on_limit = object
			.get("has_on_limit")
			.and_then(serde_json::Value::as_bool)
			.ok_or_else(|| frozen_declaration_error("regime omitted has_on_limit"))?;
		if has_on_limit && max_steps.is_none() {
			return Err(frozen_declaration_error("regime on_limit requires max_steps"));
		}
		let state_family = optional_text(object, "state_family")?;
		let state_revision = optional_u32(object, "state_revision")?;
		let family_rev = match (state_family, state_revision) {
			(Some(family), Some(state_revision)) => sf!("{family}@{state_revision}"),
			(None, None) => sf!("{}@{revision}", id),
			_ => return Err(frozen_declaration_error("regime state family is malformed")),
		};
		let when = match decode_manifest_json(
			object
				.get("when")
				.ok_or_else(|| frozen_declaration_error("regime omitted when"))?,
		)? {
			serde_json::Value::Null => None,
			when => Some(parse_regime_when(&when)?),
		};
		let owns = object
			.get("owns")
			.and_then(serde_json::Value::as_array)
			.ok_or_else(|| frozen_declaration_error("regime omitted owns"))?
			.iter()
			.map(|resource| {
				let resource = resource
					.as_str()
					.filter(|resource| !resource.is_empty())
					.ok_or_else(|| frozen_declaration_error("regime resource must be a string"))?;
				Ok(match resource {
					"tool_choice" => omp_agent::Resource::ToolChoice,
					"worktree" => omp_agent::Resource::Worktree,
					"director" => omp_agent::Resource::Director,
					"editor-surface" => omp_agent::Resource::EditorSurface,
					"batch-execution" => omp_agent::Resource::BatchExecution,
					"mode" => omp_agent::Resource::Mode,
					other => omp_agent::Resource::Named(Str::from(other)),
				})
			})
			.collect::<Result<Vec<_>, ControlProtocolError>>()?;
		let sets = decode_manifest_json(
			object
				.get("sets")
				.ok_or_else(|| frozen_declaration_error("regime omitted sets"))?,
		)?
		.as_object()
		.ok_or_else(|| frozen_declaration_error("regime sets must encode an object"))?
		.iter()
		.map(|(name, value)| {
			Ok(omp_agent::ScopedSetting {
				slot:  setting_slot(name),
				value: json_setting_value(value)?,
			})
		})
		.collect::<Result<Vec<_>, ControlProtocolError>>()?;
		let minimum_duration_ms = optional_u64(object, "minimum_duration_ms")?;
		let on_failure = match text("on_failure")? {
			"defer" => RegimeFailurePolicy::Defer,
			"deny" => RegimeFailurePolicy::Deny,
			_ => return Err(frozen_declaration_error("regime has an unknown failure policy")),
		};
		Ok(Self {
			id,
			revision,
			events,
			precedence,
			max_steps,
			committed_step_interval_ms,
			has_on_limit,
			lifetime,
			family_rev,
			state_revision,
			when,
			owns: owns.into(),
			sets: sets.into(),
			minimum_duration_ms,
			on_failure,
		})
	}

	fn spec(&self) -> omp_agent::RegimeSpec {
		omp_agent::RegimeSpec {
			id: self.id.clone(),
			events: self.events,
			precedence: self.precedence,
			max_steps: self.max_steps,
			committed_step_interval_ms: self.committed_step_interval_ms,
			on_limit: self.has_on_limit,
			lifetime: self.lifetime,
			family_rev: self.family_rev.clone(),
			when: self.when.clone(),
			owns: Arc::clone(&self.owns),
			sets: Arc::clone(&self.sets),
			minimum_duration_ms: self.minimum_duration_ms,
		}
	}
}

fn optional_text(
	object: &serde_json::Map<String, serde_json::Value>,
	name: &str,
) -> Result<Option<Str>, ControlProtocolError> {
	match object.get(name) {
		Some(serde_json::Value::Null) => Ok(None),
		Some(serde_json::Value::String(value)) if !value.is_empty() => Ok(Some(Str::from(value))),
		_ => Err(frozen_declaration_error(sf!("regime {name} is malformed"))),
	}
}

fn decode_manifest_json(
	value: &serde_json::Value,
) -> Result<serde_json::Value, ControlProtocolError> {
	let bytes = callback_bytes(value)
		.map_err(|_| frozen_declaration_error("regime manifest byte field is malformed"))?;
	serde_json::from_slice(&bytes)
		.map_err(|_| frozen_declaration_error("regime manifest JSON field is malformed"))
}

fn optional_u32(
	object: &serde_json::Map<String, serde_json::Value>,
	name: &str,
) -> Result<Option<u32>, ControlProtocolError> {
	optional_u64(object, name)?
		.map(|value| {
			u32::try_from(value)
				.map_err(|_| frozen_declaration_error(sf!("regime {name} is too large")))
		})
		.transpose()
}

fn optional_u64(
	object: &serde_json::Map<String, serde_json::Value>,
	name: &str,
) -> Result<Option<u64>, ControlProtocolError> {
	match object.get(name) {
		Some(serde_json::Value::Null) => Ok(None),
		Some(value) => value
			.as_u64()
			.map(Some)
			.ok_or_else(|| frozen_declaration_error(sf!("regime {name} is malformed"))),
		None => Err(frozen_declaration_error(sf!("regime omitted {name}"))),
	}
}

fn parse_regime_point(value: &str) -> Result<omp_core::Point, ControlProtocolError> {
	match value {
		"context" => Ok(omp_core::Point::Context),
		"tool_choice" => Ok(omp_core::Point::ToolChoice),
		"pre_model" => Ok(omp_core::Point::PreModel),
		"stream" => Ok(omp_core::Point::Stream),
		"admission" => Ok(omp_core::Point::Admission),
		"batch" => Ok(omp_core::Point::Batch),
		"turn_end" => Ok(omp_core::Point::TurnEnd),
		"settle" => Ok(omp_core::Point::Settle),
		"idle" => Ok(omp_core::Point::Idle),
		_ => Err(frozen_declaration_error("regime has an unknown point")),
	}
}

fn parse_regime_when(
	value: &serde_json::Value,
) -> Result<omp_agent::RegimeWhen, ControlProtocolError> {
	let object = value
		.as_object()
		.ok_or_else(|| frozen_declaration_error("regime when must be an object"))?;
	const KEYS: [&str; 5] =
		["point", "invocation_id", "stream_contains", "delivered", "checkpoint_active"];
	if object.keys().any(|key| !KEYS.contains(&key.as_str())) {
		return Err(frozen_declaration_error("regime when has an unknown field"));
	}
	let optional_string = |name: &str| match object.get(name) {
		None | Some(serde_json::Value::Null) => Ok(None),
		Some(serde_json::Value::String(value)) if !value.is_empty() => Ok(Some(Str::from(value))),
		_ => Err(frozen_declaration_error(sf!("regime when {name} is malformed"))),
	};
	let optional_bool = |name: &str| match object.get(name) {
		None | Some(serde_json::Value::Null) => Ok(None),
		Some(serde_json::Value::Bool(value)) => Ok(Some(*value)),
		_ => Err(frozen_declaration_error(sf!("regime when {name} is malformed"))),
	};
	Ok(omp_agent::RegimeWhen {
		point:             parse_regime_point(
			object
				.get("point")
				.and_then(serde_json::Value::as_str)
				.ok_or_else(|| frozen_declaration_error("regime when omitted point"))?,
		)?,
		invocation_id:     optional_string("invocation_id")?,
		stream_contains:   optional_string("stream_contains")?,
		delivered:         optional_bool("delivered")?,
		checkpoint_active: optional_bool("checkpoint_active")?,
	})
}

fn setting_slot(name: &str) -> omp_agent::SettingSlot {
	match name {
		"toolset" => omp_agent::SettingSlot::Toolset,
		"model" | "model_route" => omp_agent::SettingSlot::ModelRoute,
		"prompt" | "prompt_slot" => omp_agent::SettingSlot::PromptSlot,
		"delivery" | "delivery_policy" => omp_agent::SettingSlot::DeliveryPolicy,
		other => omp_agent::SettingSlot::Named(Str::from(other)),
	}
}

fn json_setting_value(value: &serde_json::Value) -> Result<Str, ControlProtocolError> {
	value
		.as_str()
		.map(Str::from)
		.ok_or_else(|| frozen_declaration_error("regime setting values must be strings"))
}

struct ExtensionRegime {
	callbacks:          Arc<dyn CallbackDispatcher>,
	identity:           Arc<ControlConnectionIdentity>,
	session:            Str,
	regime:             Str,
	revision:           u32,
	state_revision:     Option<u32>,
	on_failure:         RegimeFailurePolicy,
	state:              Str,
	started_activation: Option<Str>,
	runtime:            Option<runtime::Handle>,
}

#[derive(Debug, Error)]
enum ExtensionRegimeError {
	#[error("extension regime callback runtime is unavailable")]
	RuntimeUnavailable,
	#[error("extension regime callback dispatch failed")]
	Dispatch(#[source] ControlProtocolError),
	#[error("extension regime event encoding failed")]
	EventEncode(#[source] serde_json::Error),
	#[error("extension regime callback returned an invalid draft")]
	Draft(#[source] RegimeDraftError),
}

impl ExtensionRegimeError {
	const fn failure_reason(&self) -> &'static str {
		match self {
			Self::RuntimeUnavailable => "extension regime callback runtime is unavailable",
			Self::Dispatch(_) => "extension regime callback dispatch failed",
			Self::EventEncode(_) => "extension regime event encoding failed",
			Self::Draft(_) => "extension regime callback returned an invalid draft",
		}
	}
}

#[derive(Clone, Copy, Debug, Error)]
enum RegimeDraftError {
	#[error("regime callback draft has an invalid envelope")]
	Envelope,
	#[error("regime callback draft correlation is stale")]
	StaleCorrelation,
	#[error("regime callback control is invalid")]
	Control,
	#[error("regime callback effect is invalid")]
	Effect,
	#[error("regime callback context payload is invalid")]
	Context,
	#[error("regime callback byte payload is invalid")]
	Bytes,
}

enum DecodedRegimeControl {
	Retry,
	Wait(omp_agent::WaitTicket),
	Reject(Str),
	Cancel(Str),
	Complete,
	Fail(omp_agent::RegimeFailure),
}

enum DecodedRegimeEffect {
	AppendContext(Vec<omp_proto::thread::v1::Item>),
	RewriteContext(omp_agent::ContextPatch),
	RequireTool(Str),
	SetScoped(omp_agent::ScopedSetting),
	ReplaceState(Str),
}

struct DecodedRegimeDraft {
	control: Option<DecodedRegimeControl>,
	effects: Vec<DecodedRegimeEffect>,
}

impl ExtensionRegime {
	const fn point_name(point: omp_core::Point) -> &'static str {
		match point {
			omp_core::Point::Context => "context",
			omp_core::Point::ToolChoice => "tool_choice",
			omp_core::Point::PreModel => "pre_model",
			omp_core::Point::Stream => "stream",
			omp_core::Point::Admission => "admission",
			omp_core::Point::Batch => "batch",
			omp_core::Point::TurnEnd => "turn_end",
			omp_core::Point::Settle => "settle",
			omp_core::Point::Idle => "idle",
		}
	}

	fn failure(&self, next: omp_agent::Next<'_>, error: ExtensionRegimeError) {
		if matches!(self.on_failure, RegimeFailurePolicy::Deny) {
			next.reject(error.failure_reason());
		}
	}

	fn authority(
		&self,
		activation: &str,
		point: Option<omp_core::Point>,
		call: Option<&str>,
	) -> ControlInvocationAuthority {
		ControlInvocationAuthority {
			invocation:        sf!(
				"regime:{}:{}:{}",
				self.identity.extension,
				self.identity.host_generation,
				activation
			),
			phase:             InvocationPhase::EffectsAuthorized,
			session:           self.session.clone(),
			turn:              None,
			event:             point.map(|point| sf!(Self::point_name(point))),
			call:              call.map(Str::from),
			device:            None,
			effects:           Box::new([]),
			place_kind:        sf!("host"),
			lifecycle:         LifecyclePhase::Active,
			roots:             Box::new([]),
			remote:            false,
			has_ui:            false,
			headless:          true,
			settings:          serde_json::Map::new(),
			secret_settings:   Box::new([]),
			data:              None,
			direct_filesystem: None,
		}
	}

	fn dispatch(
		&self,
		operation: &'static str,
		activation: &str,
		point: Option<omp_core::Point>,
		call: Option<&str>,
		arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ExtensionRegimeError> {
		use std::time::Instant;

		let runtime = self
			.runtime
			.clone()
			.ok_or(ExtensionRegimeError::RuntimeUnavailable)?;
		let callback = self
			.callbacks
			.dispatch(Arc::clone(&self.identity), ControlDispatch {
				operation: sf!(operation),
				arguments,
				authority: self.authority(activation, point, call),
				policy: CallbackConcurrency::Serialized,
				deadline: EventDeadline { at: Instant::now() + REGIME_SUBMISSION_TIMEOUT },
			});
		if runtime::Handle::try_current().is_ok() {
			futures::executor::block_on(callback)
		} else {
			runtime.block_on(callback)
		}
		.map_err(ExtensionRegimeError::Dispatch)
	}

	fn ensure_started(
		&mut self,
		ctx: &omp_agent::RegimeContext<'_>,
	) -> Result<(), ExtensionRegimeError> {
		if self.started_activation.as_deref() == Some(ctx.activation_id()) {
			return Ok(());
		}
		let mut arguments = serde_json::Map::new();
		arguments.insert("regime_id".to_owned(), self.regime.to_string().into());
		arguments.insert("activation_id".to_owned(), ctx.activation_id().into());
		arguments.insert("regime_revision".to_owned(), self.revision.into());
		arguments.insert(
			"state".to_owned(),
			serde_json::json!({"$bytes": omp_core::base64::encode(self.state.as_bytes())}),
		);
		arguments.insert(
			"state_revision".to_owned(),
			self
				.state_revision
				.map_or(serde_json::Value::Null, Into::into),
		);
		arguments.insert(
			"deadline_ms".to_owned(),
			u64::try_from(REGIME_SUBMISSION_TIMEOUT.as_millis())
				.unwrap_or(u64::MAX)
				.into(),
		);
		arguments.insert("props".to_owned(), serde_json::json!({}));
		self.dispatch(
			"omp.regimes.start",
			ctx.activation_id(),
			Some(ctx.point()),
			ctx.facts().invocation_id,
			arguments,
		)?;
		self.started_activation = Some(Str::from(ctx.activation_id()));
		Ok(())
	}

	fn apply_callback(
		&self,
		ctx: &omp_agent::RegimeContext<'_>,
		limit_handler: bool,
	) -> Result<DecodedRegimeDraft, ExtensionRegimeError> {
		let event = serde_json::to_vec(&serde_json::json!({
			"turn_id": ctx.facts().turn_id,
			"invocation_id": ctx.facts().invocation_id,
			"stream_delta": ctx.facts().stream_delta,
			"stream_part": ctx.facts().stream_part.map(|part| {
				serde_json::json!({
					"index": part.index,
					"source": <&'static str>::from(part.source),
					"tool_name": part.tool_name,
				})
			}),
			"now_ms": ctx.facts().now_ms,
			"delivered": ctx.facts().delivered,
			"checkpoint_active": ctx.facts().checkpoint_active,
			"hidden": ctx.facts().hidden,
			"empty_output": ctx.facts().empty_output,
			"trailing_aborts": ctx.facts().trailing_aborts,
		}))
		.map_err(ExtensionRegimeError::EventEncode)?;
		let mut arguments = serde_json::Map::new();
		arguments.insert("regime_id".to_owned(), self.regime.to_string().into());
		arguments.insert("activation_id".to_owned(), ctx.activation_id().into());
		arguments.insert("regime_revision".to_owned(), self.revision.into());
		arguments.insert("point".to_owned(), Self::point_name(ctx.point()).into());
		arguments.insert("event_revision".to_owned(), 1.into());
		arguments.insert(
			"event_payload".to_owned(),
			serde_json::json!({"$bytes": omp_core::base64::encode(&event)}),
		);
		arguments.insert(
			"state".to_owned(),
			serde_json::json!({"$bytes": omp_core::base64::encode(self.state.as_bytes())}),
		);
		arguments.insert(
			"state_revision".to_owned(),
			self
				.state_revision
				.map_or(serde_json::Value::Null, Into::into),
		);
		arguments.insert("committed_steps".to_owned(), ctx.committed_steps().into());
		arguments.insert(
			"deadline_ms".to_owned(),
			u64::try_from(REGIME_SUBMISSION_TIMEOUT.as_millis())
				.unwrap_or(u64::MAX)
				.into(),
		);
		arguments.insert("limit_handler".to_owned(), limit_handler.into());
		arguments.insert("props".to_owned(), serde_json::json!({}));
		let result = self.dispatch(
			"omp.regimes.apply",
			ctx.activation_id(),
			Some(ctx.point()),
			ctx.facts().invocation_id,
			arguments,
		)?;
		decode_callback_draft(&result, ctx.activation_id(), self.revision, self.state_revision)
			.map_err(ExtensionRegimeError::Draft)
	}

	fn commit_draft(
		draft: DecodedRegimeDraft,
		ctx: &mut omp_agent::RegimeContext<'_>,
		next: omp_agent::Next<'_>,
	) {
		for effect in draft.effects {
			match effect {
				DecodedRegimeEffect::AppendContext(items) => ctx.append_context(items),
				DecodedRegimeEffect::RewriteContext(patch) => ctx.rewrite_context(patch),
				DecodedRegimeEffect::RequireTool(tool) => ctx.require_tool(tool),
				DecodedRegimeEffect::SetScoped(setting) => ctx.set_scoped(setting),
				DecodedRegimeEffect::ReplaceState(state) => ctx.replace_state(state),
			}
		}
		match draft.control {
			None => {},
			Some(DecodedRegimeControl::Retry) => next.retry(),
			Some(DecodedRegimeControl::Wait(ticket)) => next.wait(ticket),
			Some(DecodedRegimeControl::Reject(reason)) => next.reject(reason),
			Some(DecodedRegimeControl::Cancel(reason)) => next.cancel(reason),
			Some(DecodedRegimeControl::Complete) => next.complete(),
			Some(DecodedRegimeControl::Fail(detail)) => next.fail(detail),
		}
	}

	fn evaluate(
		&mut self,
		ctx: &mut omp_agent::RegimeContext<'_>,
		next: omp_agent::Next<'_>,
		limit_handler: bool,
	) -> Result<(), omp_agent::RegimeError> {
		if let Err(error) = self.ensure_started(ctx) {
			self.failure(next, error);
			return Ok(());
		}
		let draft = match self.apply_callback(ctx, limit_handler) {
			Ok(draft) => draft,
			Err(error) => {
				self.failure(next, error);
				return Ok(());
			},
		};
		Self::commit_draft(draft, ctx, next);
		Ok(())
	}
}

impl omp_agent::Regime for ExtensionRegime {
	fn apply(
		&mut self,
		ctx: &mut omp_agent::RegimeContext<'_>,
		next: omp_agent::Next<'_>,
	) -> Result<(), omp_agent::RegimeError> {
		self.evaluate(ctx, next, false)
	}

	fn on_limit(
		&mut self,
		ctx: &mut omp_agent::RegimeContext<'_>,
		next: omp_agent::Next<'_>,
	) -> Result<(), omp_agent::RegimeError> {
		self.evaluate(ctx, next, true)
	}

	fn state(&self) -> Str {
		self.state.clone()
	}

	fn restore(&mut self, payload: &str) -> Result<(), omp_agent::RegimeStateError> {
		self.state = Str::from(payload);
		Ok(())
	}
}

impl Drop for ExtensionRegime {
	fn drop(&mut self) {
		use std::time::Instant;

		let (Some(runtime), Some(activation)) =
			(self.runtime.clone(), self.started_activation.clone())
		else {
			return;
		};
		let mut arguments = serde_json::Map::new();
		arguments.insert("regime_id".to_owned(), self.regime.to_string().into());
		arguments.insert("activation_id".to_owned(), activation.to_string().into());
		arguments.insert("regime_revision".to_owned(), self.revision.into());
		arguments.insert("reason".to_owned(), "core_activation_stopped".into());
		arguments.insert(
			"deadline_ms".to_owned(),
			u64::try_from(REGIME_SUBMISSION_TIMEOUT.as_millis())
				.unwrap_or(u64::MAX)
				.into(),
		);
		arguments.insert("props".to_owned(), serde_json::json!({}));
		let callbacks = Arc::clone(&self.callbacks);
		let identity = Arc::clone(&self.identity);
		let dispatch = ControlDispatch {
			operation: sf!("omp.regimes.stop"),
			arguments,
			authority: self.authority(activation.as_str(), None, None),
			policy: CallbackConcurrency::Serialized,
			deadline: EventDeadline { at: Instant::now() + REGIME_SUBMISSION_TIMEOUT },
		};
		runtime.spawn(async move {
			let _ = callbacks.dispatch(identity, dispatch).await;
		});
	}
}

fn decode_callback_draft(
	value: &serde_json::Value,
	activation: &str,
	revision: u32,
	state_revision: Option<u32>,
) -> Result<DecodedRegimeDraft, RegimeDraftError> {
	let object = value.as_object().ok_or(RegimeDraftError::Envelope)?;
	if object
		.get("activation_id")
		.and_then(serde_json::Value::as_str)
		!= Some(activation)
		|| object
			.get("regime_revision")
			.and_then(serde_json::Value::as_u64)
			!= Some(u64::from(revision))
		|| object
			.get("event_revision")
			.and_then(serde_json::Value::as_u64)
			!= Some(1)
	{
		return Err(RegimeDraftError::StaleCorrelation);
	}
	let control = decode_callback_control(object.get("control").ok_or(RegimeDraftError::Envelope)?)?;
	let effects = object
		.get("effects")
		.and_then(serde_json::Value::as_array)
		.ok_or(RegimeDraftError::Envelope)?
		.iter()
		.map(|effect| decode_callback_effect(effect, state_revision))
		.collect::<Result<Vec<_>, _>>()?;
	Ok(DecodedRegimeDraft { control, effects })
}

fn decode_callback_control(
	value: &serde_json::Value,
) -> Result<Option<DecodedRegimeControl>, RegimeDraftError> {
	let Some(object) = value.as_object() else {
		return if value.is_null() {
			Ok(None)
		} else {
			Err(RegimeDraftError::Control)
		};
	};
	let kind = object
		.get("kind")
		.and_then(serde_json::Value::as_str)
		.ok_or(RegimeDraftError::Control)?;
	let text = |name: &str| {
		object
			.get(name)
			.and_then(serde_json::Value::as_str)
			.filter(|value| !value.is_empty())
			.map(Str::from)
			.ok_or(RegimeDraftError::Control)
	};
	Ok(Some(match kind {
		"retry" => DecodedRegimeControl::Retry,
		"wait" => DecodedRegimeControl::Wait(omp_agent::WaitTicket {
			id:          text("wait_ticket")?,
			deadline_ms: object
				.get("wait_deadline_ms")
				.and_then(serde_json::Value::as_u64)
				.ok_or(RegimeDraftError::Control)?,
			reason:      text("reason")?,
		}),
		"reject" => DecodedRegimeControl::Reject(text("reason")?),
		"cancel" => DecodedRegimeControl::Cancel(text("reason")?),
		"complete" => DecodedRegimeControl::Complete,
		"fail" => DecodedRegimeControl::Fail(omp_agent::RegimeFailure::structured(
			bytes::Bytes::from(callback_bytes(object.get("error").ok_or(RegimeDraftError::Control)?)?),
		)),
		_ => return Err(RegimeDraftError::Control),
	}))
}

fn decode_callback_effect(
	value: &serde_json::Value,
	state_revision: Option<u32>,
) -> Result<DecodedRegimeEffect, RegimeDraftError> {
	let object = value.as_object().ok_or(RegimeDraftError::Effect)?;
	let kind = object
		.get("kind")
		.and_then(serde_json::Value::as_str)
		.ok_or(RegimeDraftError::Effect)?;
	let payload = callback_bytes(object.get("payload").ok_or(RegimeDraftError::Effect)?)?;
	let name = || {
		object
			.get("name")
			.and_then(serde_json::Value::as_str)
			.filter(|name| !name.is_empty())
			.map(Str::from)
			.ok_or(RegimeDraftError::Effect)
	};
	match kind {
		"append_context" => decode_context_items(&payload).map(DecodedRegimeEffect::AppendContext),
		"rewrite_context" => Ok(DecodedRegimeEffect::RewriteContext(omp_agent::ContextPatch(
			bytes::Bytes::from(payload),
		))),
		"require_tool" => Ok(DecodedRegimeEffect::RequireTool(name()?)),
		"set_scoped" => {
			let value =
				serde_json::from_slice::<String>(&payload).map_err(|_| RegimeDraftError::Effect)?;
			Ok(DecodedRegimeEffect::SetScoped(omp_agent::ScopedSetting {
				slot:  setting_slot(name()?.as_str()),
				value: Str::from(value),
			}))
		},
		"replace_state" => {
			let effect_revision = object
				.get("state_revision")
				.and_then(serde_json::Value::as_u64)
				.and_then(|revision| u32::try_from(revision).ok());
			if effect_revision != state_revision {
				return Err(RegimeDraftError::Effect);
			}
			Ok(DecodedRegimeEffect::ReplaceState(Str::from(
				String::from_utf8(payload).map_err(|_| RegimeDraftError::Effect)?,
			)))
		},
		_ => Err(RegimeDraftError::Effect),
	}
}

fn decode_context_items(
	payload: &[u8],
) -> Result<Vec<omp_proto::thread::v1::Item>, RegimeDraftError> {
	use omp_proto::thread::v1::{Item, Message, Part, Role, item, part};

	let items = serde_json::from_slice::<Vec<serde_json::Value>>(payload)
		.map_err(|_| RegimeDraftError::Context)?;
	items
		.into_iter()
		.map(|value| {
			let object = value.as_object().ok_or(RegimeDraftError::Context)?;
			if object
				.get("props")
				.and_then(serde_json::Value::as_object)
				.is_some_and(|props| !props.is_empty())
			{
				return Err(RegimeDraftError::Context);
			}
			let message = object
				.get("message")
				.and_then(serde_json::Value::as_object)
				.ok_or(RegimeDraftError::Context)?;
			let role = match message.get("role").and_then(serde_json::Value::as_str) {
				Some("ROLE_SYSTEM") => Role::System,
				Some("ROLE_USER") => Role::User,
				Some("ROLE_ASSISTANT") => Role::Assistant,
				_ => return Err(RegimeDraftError::Context),
			};
			let parts = message
				.get("parts")
				.and_then(serde_json::Value::as_array)
				.ok_or(RegimeDraftError::Context)?
				.iter()
				.map(|part| {
					part
						.get("text")
						.and_then(serde_json::Value::as_str)
						.map(|text| Part { kind: Some(part::Kind::Text(text.to_owned())) })
						.ok_or(RegimeDraftError::Context)
				})
				.collect::<Result<Vec<_>, _>>()?;
			Ok(Item {
				seq:           object
					.get("seq")
					.and_then(serde_json::Value::as_u64)
					.unwrap_or(0),
				created_at_ms: object
					.get("created_at_ms")
					.and_then(serde_json::Value::as_u64)
					.unwrap_or(0),
				kind:          Some(item::Kind::Message(Message { role: role.into(), parts })),
				props:         None,
			})
		})
		.collect()
}

fn callback_bytes(value: &serde_json::Value) -> Result<Vec<u8>, RegimeDraftError> {
	let encoded = value
		.as_object()
		.and_then(|value| value.get("$bytes"))
		.and_then(serde_json::Value::as_str)
		.ok_or(RegimeDraftError::Bytes)?;
	omp_core::base64::decode(encoded)
		.into_vec()
		.map_err(|_| RegimeDraftError::Bytes)
}

/// Rejection while sealing a child registry publication.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum SealedRegistryEvidenceError {
	/// Registry publication was nested inside a callback.
	#[error("registry publication is legal only during host bootstrap")]
	Nested,
	/// Authenticated connection identity does not match the deployment manifest.
	#[error("registry publication identity does not match its deployment manifest")]
	Identity,
	/// Registry effect or metadata JSON was malformed.
	#[error("registry publication is malformed: {0}")]
	Malformed(Str),
	/// Executable tool rows differ from the sealed metadata projection.
	#[error("registry executable rows differ from sealed metadata")]
	ExecutableDrift,
	/// Frozen runtime declarations differ from the authenticated manifest.
	#[error("registry publication differs from authenticated manifest")]
	ManifestDrift,
	/// Typed UI declarations differ from the authenticated manifest.
	#[error(transparent)]
	Ui(#[from] crate::exthost::UiRegistrationError),
	/// One declaration was duplicated.
	#[error("registry publication contains a duplicate declaration")]
	Duplicate,
	/// A declaration came from a module outside the admitted module set.
	#[error("registry declaration source module is not admitted")]
	SourceModule,
}

fn frozen_declaration_error(message: impl Into<Str>) -> ControlProtocolError {
	ControlProtocolError::new("InvalidRegimeDeclaration", message)
}

fn seal_frozen_control_evidence(
	identity: Arc<ControlConnectionIdentity>,
	session: Str,
	manifest: &ExtensionManifest,
	payload: serde_json::Value,
) -> Result<SealedRegistryEvidence, ControlProtocolError> {
	let root = payload
		.as_object()
		.ok_or_else(|| frozen_declaration_error("FREEZE acknowledgment must be an object"))?;
	let regimes = root
		.get("regimes")
		.and_then(serde_json::Value::as_object)
		.ok_or_else(|| {
			frozen_declaration_error("FREEZE acknowledgment omitted the sealed regime table")
		})?;
	if regimes
		.get("extension_id")
		.and_then(serde_json::Value::as_str)
		!= Some(identity.extension.as_str())
	{
		return Err(frozen_declaration_error("sealed regime table belongs to another extension"));
	}
	if regimes
		.get("generation")
		.and_then(serde_json::Value::as_u64)
		!= Some(identity.host_generation)
	{
		return Err(frozen_declaration_error(
			"sealed regime table belongs to another host generation",
		));
	}
	if regimes.get("api_level").and_then(serde_json::Value::as_u64) != Some(1) {
		return Err(frozen_declaration_error("sealed regime table has an unsupported API level"));
	}
	if regimes
		.get("table_revision")
		.and_then(serde_json::Value::as_u64)
		!= Some(1)
	{
		return Err(frozen_declaration_error("sealed regime table has an unsupported revision"));
	}
	const POINT_TABLE: [&str; 9] = [
		"context",
		"tool_choice",
		"pre_model",
		"stream",
		"admission",
		"batch",
		"turn_end",
		"settle",
		"idle",
	];
	const CONTROL_TABLE: [&str; 6] = ["retry", "wait", "reject", "cancel", "complete", "fail"];
	const EFFECT_TABLE: [&str; 5] =
		["append_context", "rewrite_context", "require_tool", "set_scoped", "replace_state"];
	let table_matches = |name: &str, expected: &[&str]| {
		regimes
			.get(name)
			.and_then(serde_json::Value::as_array)
			.is_some_and(|actual| {
				actual.len() == expected.len()
					&& actual
						.iter()
						.zip(expected)
						.all(|(actual, expected)| actual.as_str() == Some(*expected))
			})
	};
	if !table_matches("point_table", &POINT_TABLE)
		|| !table_matches("control_table", &CONTROL_TABLE)
		|| !table_matches("effect_table", &EFFECT_TABLE)
	{
		return Err(frozen_declaration_error(
			"sealed regime vocabulary differs from the host protocol",
		));
	}
	let regime_documents = regimes
		.get("manifests")
		.and_then(serde_json::Value::as_array)
		.ok_or_else(|| frozen_declaration_error("sealed regime table omitted manifests"))?
		.clone();
	let provider_documents = root
		.get("providers")
		.and_then(serde_json::Value::as_array)
		.ok_or_else(|| frozen_declaration_error("FREEZE acknowledgment omitted providers"))?
		.clone();
	let runtime_regime_ids = sealed_document_ids(&regime_documents)
		.map_err(|error| frozen_declaration_error(error.to_string()))?;
	let runtime_provider_ids = sealed_document_ids(&provider_documents)
		.map_err(|error| frozen_declaration_error(error.to_string()))?;
	let declared_regime_ids = manifest
		.static_declarations()
		.regimes
		.iter()
		.map(|declaration| declaration.id.as_str())
		.collect::<BTreeSet<_>>();
	let declared_provider_ids = manifest
		.static_declarations()
		.providers
		.iter()
		.map(|row| row.key.as_str())
		.collect::<BTreeSet<_>>();
	if runtime_regime_ids != declared_regime_ids || runtime_provider_ids != declared_provider_ids {
		return Err(frozen_declaration_error(
			"FREEZE declarations differ from the authenticated manifest",
		));
	}
	Ok(SealedRegistryEvidence {
		identity:   Arc::clone(&identity),
		session:    Some(session),
		provenance: manifest.provenance.clone(),
		tools:      Arc::from([]),
		hooks:      Arc::from([]),
		ui:         VerifiedUiRoster {
			generation: identity.host_generation,
			extension: identity.extension.clone(),
			..Default::default()
		},
		providers:  provider_documents.into(),
		regimes:    regime_documents.into(),
	})
}

/// Validates one complete registry effect against authenticated manifest facts.
pub fn seal_registry_evidence(
	context: &ControlRequestContext,
	manifest: &ExtensionManifest,
	payload: &serde_json::Value,
) -> Result<SealedRegistryEvidence, SealedRegistryEvidenceError> {
	if context.invocation.is_some() {
		return Err(SealedRegistryEvidenceError::Nested);
	}
	let identity = &context.connection;
	if manifest.provenance.extension_id() != identity.extension.as_str()
		|| manifest.provenance.layer() != identity.layer.as_str()
		|| manifest.provenance.tier() != identity.tier.as_str()
		|| manifest.provenance.artifact_digest().to_string() != identity.artifact_digest.as_str()
	{
		return Err(SealedRegistryEvidenceError::Identity);
	}
	let object = payload.as_object().ok_or_else(|| {
		SealedRegistryEvidenceError::Malformed(sf!("registry effect must be an object"))
	})?;
	let metadata = object
		.get("metadata_json")
		.and_then(serde_json::Value::as_str)
		.ok_or_else(|| {
			SealedRegistryEvidenceError::Malformed(sf!("registry effect omitted metadata_json"))
		})?;
	let mut snapshot: RegisteredRegistrySnapshot = serde_json::from_str(metadata)
		.map_err(|error| SealedRegistryEvidenceError::Malformed(Str::from(error.to_string())))?;
	let executable = object.get("tools").cloned().ok_or_else(|| {
		SealedRegistryEvidenceError::Malformed(sf!("registry effect omitted executable tools"))
	})?;
	let mut executable: Vec<RegisteredTool> = serde_json::from_value(executable)
		.map_err(|error| SealedRegistryEvidenceError::Malformed(Str::from(error.to_string())))?;
	executable.sort();
	snapshot.tools.sort();
	if executable != snapshot.tools {
		return Err(SealedRegistryEvidenceError::ExecutableDrift);
	}
	if snapshot.tools.windows(2).any(|rows| rows[0] == rows[1]) {
		return Err(SealedRegistryEvidenceError::Duplicate);
	}
	snapshot.hooks.sort();
	if snapshot.hooks.windows(2).any(|rows| rows[0] == rows[1]) {
		return Err(SealedRegistryEvidenceError::Duplicate);
	}
	let manifest_tools = manifest
		.declarations
		.tools()
		.map(|tool| (tool.name.as_str(), tool.family.as_str(), tool.rev))
		.collect::<BTreeSet<_>>();
	let runtime_tools = snapshot
		.tools
		.iter()
		.map(|tool| (tool.name.as_str(), tool.family.as_str(), tool.rev))
		.collect::<BTreeSet<_>>();
	let manifest_hooks = manifest
		.declarations
		.hooks()
		.map(|hook| (hook.event.as_str(), hook.phase.to_string()))
		.collect::<BTreeSet<_>>();
	let runtime_hooks = snapshot
		.hooks
		.iter()
		.map(|hook| (hook.event.as_str(), hook.phase.to_string()))
		.collect::<BTreeSet<_>>();
	if !manifest.runtime_declarations_trusted()
		&& (manifest_tools != runtime_tools || manifest_hooks != runtime_hooks)
	{
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	let mut runtime_skills = BTreeMap::new();
	for skill in snapshot.skills {
		if runtime_skills.insert(skill.path, skill.metadata).is_some() {
			return Err(SealedRegistryEvidenceError::Duplicate);
		}
	}
	let manifest_skills = manifest
		.static_declarations()
		.ordered
		.iter()
		.filter(|row| {
			row.kind == "skills"
				&& row
					.path
					.as_deref()
					.is_some_and(|path| path.contains(".omp-generated/skills/"))
		})
		.map(|row| (row.path.clone().expect("filtered skill row has a path"), row.metadata.clone()))
		.collect::<BTreeMap<_, _>>();
	if !manifest.runtime_declarations_trusted() && manifest_skills != runtime_skills {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	let declared_provider_ids = manifest
		.static_declarations()
		.providers
		.iter()
		.map(|row| row.key.as_str())
		.collect::<BTreeSet<_>>();
	let declared_regime_ids = manifest
		.static_declarations()
		.regimes
		.iter()
		.map(|row| row.id.as_str())
		.collect::<BTreeSet<_>>();
	let runtime_provider_ids = sealed_document_ids(&snapshot.providers)?;
	let runtime_regime_ids = sealed_document_ids(&snapshot.regimes)?;
	if !manifest.runtime_declarations_trusted()
		&& (declared_provider_ids != runtime_provider_ids
			|| declared_regime_ids != runtime_regime_ids)
	{
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	let modules = iter::once(manifest.entry.as_str())
		.chain(manifest.declaration_modules.iter().map(Str::as_str))
		.collect::<BTreeSet<_>>();
	if snapshot
		.tools
		.iter()
		.any(|tool| !modules.contains(tool.source_module.as_str()))
	{
		return Err(SealedRegistryEvidenceError::SourceModule);
	}
	for hook in &snapshot.hooks {
		let Some(filter) = manifest
			.static_declarations()
			.hooks
			.iter()
			.find(|row| {
				row.key.as_str() == format!("{}/{}", hook.event, hook.phase.to_ascii_uppercase())
			})
			.and_then(|row| row.filter.as_ref())
		else {
			if !manifest.runtime_declarations_trusted() && hook.event == "mcp_notification" {
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
			continue;
		};
		if !hook_when_matches_filter(hook.when.as_ref(), filter) {
			return Err(SealedRegistryEvidenceError::ManifestDrift);
		}
	}
	let ui = seal_registered_ui(
		manifest,
		identity,
		snapshot.commands,
		snapshot.shortcuts,
		snapshot.completions,
		snapshot.markdown_transformers,
		snapshot.verdict_renderers,
	)?;
	Ok(SealedRegistryEvidence {
		identity: Arc::clone(identity),
		session: None,
		provenance: manifest.provenance.clone(),
		tools: snapshot
			.tools
			.into_iter()
			.map(|tool| SealedToolRegistration {
				name:          tool.name,
				family:        tool.family,
				rev:           tool.rev,
				kind:          tool.kind,
				place:         tool.place,
				source_module: tool.source_module,
			})
			.collect(),
		hooks: Arc::from(
			snapshot
				.hooks
				.into_iter()
				.map(seal_hook_registration)
				.collect::<Result<Vec<_>, _>>()?,
		),
		ui,
		providers: snapshot.providers.into(),
		regimes: snapshot.regimes.into(),
	})
}
fn hook_when_matches_filter(
	when: Option<&RegisteredHookWhen>,
	filter: &omp_ext::config::HookDeclarationFilter,
) -> bool {
	when.is_some_and(|when| {
		when.server.as_deref().unwrap_or_default() == filter.servers.as_ref()
			&& when.method_globs.as_slice() == filter.method_globs.as_ref()
	})
}

fn seal_registered_ui(
	manifest: &ExtensionManifest,
	identity: &ControlConnectionIdentity,
	commands: Vec<RegisteredCommand>,
	shortcuts: Vec<RegisteredShortcut>,
	completions: Vec<RegisteredCompletion>,
	markdown_transformers: Vec<RegisteredMarkdownTransformer>,
	renderers: Vec<RegisteredRenderer>,
) -> Result<VerifiedUiRoster, SealedRegistryEvidenceError> {
	let mut register = RegisterUi {
		generation: identity.host_generation,
		extension_id: identity.extension.to_string(),
		..Default::default()
	};
	for command in commands {
		let module = manifest_module_for_callback(manifest, command.handler.callable.as_str())?;
		let row = manifest
			.static_declarations()
			.ui
			.commands
			.iter()
			.find(|row| row.key.as_str() == command.name);
		register.commands.push(CommandDecl {
			name:                    command.name.clone(),
			description:             command.description,
			hint:                    command.hint,
			aliases:                 command.aliases,
			args:                    command
				.args
				.into_iter()
				.map(|arg| CommandArgDecl {
					name:        arg.name,
					description: arg.description,
					usage:       arg.usage,
				})
				.collect(),
			declaration_id:          row.map_or_else(|| command.name, |row| row.id.to_string()),
			callback:                command.handler.callable,
			module:                  module.to_owned(),
			activation_trigger:      if command.trigger.is_empty() {
				row.map_or_else(|| "lazy".to_owned(), |row| row.trigger.to_string())
			} else {
				command.trigger
			},
			arg_completion_callback: command.arg_completions.map(|callback| callback.callable),
			props:                   None,
		});
	}
	register.shortcuts = seal_registered_shortcuts(manifest, shortcuts)?;
	register.triggers = completions
		.into_iter()
		.map(|completion| seal_registered_completion(manifest, completion))
		.collect::<Result<Vec<_>, _>>()?;
	let mut verified = verify_ui_registration(manifest.static_declarations(), register)?;
	verified.markdown_transformers = markdown_transformers
		.into_iter()
		.map(|transformer| {
			if transformer.kind != "markdown_transformer" {
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
			let row = manifest
				.static_declarations()
				.ui
				.message_renderers
				.iter()
				.find(|row| row.key.as_str() == transformer.name)
				.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
			let module = manifest_module_for_callback(manifest, transformer.value.callable.as_str())?;
			if row.module.as_str() != module
				|| (!row.trigger.is_empty() && row.trigger.as_str() != transformer.trigger)
			{
				return Err(SealedRegistryEvidenceError::ManifestDrift);
			}
			Ok(VerifiedMarkdownTransformer {
				declaration_id: row.id.clone(),
				name:           Str::new(transformer.name),
				callback:       Str::new(transformer.value.callable),
				module:         row.module.clone(),
			})
		})
		.collect::<Result<Vec<_>, _>>()?
		.into_boxed_slice();
	let mut renderer_keys = BTreeSet::new();
	verified.renderers = renderers
		.into_iter()
		.map(|renderer| {
			if !renderer_keys.insert(renderer.name.clone()) {
				return Err(SealedRegistryEvidenceError::Duplicate);
			}
			seal_registered_renderer(manifest, renderer)
		})
		.collect::<Result<Vec<_>, _>>()?
		.into_boxed_slice();
	let expected_renderers = manifest
		.static_declarations()
		.ui
		.verdict_renderers
		.iter()
		.map(|row| row.id.as_str())
		.collect::<BTreeSet<_>>();
	let published_renderers = verified
		.renderers
		.iter()
		.map(|renderer| renderer.declaration_id.as_str())
		.collect::<BTreeSet<_>>();
	if expected_renderers != published_renderers {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	Ok(verified)
}

fn seal_registered_renderer(
	manifest: &ExtensionManifest,
	renderer: RegisteredRenderer,
) -> Result<VerifiedRendererDeclaration, SealedRegistryEvidenceError> {
	if renderer.kind != "verdict_renderer" || renderer.name.0.is_empty() {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	let (name, family, revision) = renderer.name;
	let key = if family.is_empty() && revision == 0 {
		name.clone()
	} else {
		format!("{name}@{family}.{revision}")
	};
	let row = manifest
		.static_declarations()
		.ui
		.verdict_renderers
		.iter()
		.find(|row| row.key.as_str() == key)
		.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
	let callback = renderer.value.function.callable;
	let module = manifest_module_for_callback(manifest, callback.as_str())?;
	if row.module.as_str() != module
		|| (!row.trigger.is_empty() && row.trigger.as_str() != renderer.trigger)
	{
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	let reduce = renderer
		.value
		.reduce
		.map(|reduce| {
			let callable = Str::new(reduce.callable);
			manifest_module_for_callback(manifest, callable.as_str()).map(|_| callable)
		})
		.transpose()?;
	Ok(VerifiedRendererDeclaration {
		declaration_id: row.id.clone(),
		identity: ToolIdentity {
			name: Str::new(name),
			rev:  Rev { family: Str::new(family), n: revision },
		},
		callback: Str::new(callback),
		reduce,
		decorates: renderer.value.decorates,
		module: row.module.clone(),
	})
}
fn seal_registered_completion(
	manifest: &ExtensionManifest,
	completion: RegisteredCompletion,
) -> Result<TriggerDecl, SealedRegistryEvidenceError> {
	if completion.kind != "completion"
		|| completion.name.is_empty()
		|| completion.metadata.prefix != completion.name
		|| completion.metadata.max_results == 0
	{
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	let row = manifest
		.static_declarations()
		.ui
		.completions
		.iter()
		.find(|row| row.key.as_str() == completion.name)
		.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
	let module = manifest_module_for_callback(manifest, completion.value.callable.as_str())?;
	if row.module.as_str() != module
		|| (!row.trigger.is_empty() && row.trigger.as_str() != completion.trigger)
	{
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	Ok(TriggerDecl {
		prefix:             completion.name,
		kind:               "completion".to_owned(),
		at_line_start:      completion.metadata.at_line_start,
		min_chars:          completion.metadata.min_chars,
		debounce_ms:        completion_duration_millis(&completion.metadata.debounce)?,
		max_results:        completion.metadata.max_results.min(100),
		cache_ms:           completion_duration_millis(&completion.metadata.cache)?,
		refine_locally:     completion.metadata.refine_locally,
		declaration_id:     row.id.to_string(),
		callback:           completion.value.callable,
		module:             module.to_owned(),
		activation_trigger: if completion.trigger.is_empty() {
			row.trigger.to_string()
		} else {
			completion.trigger
		},
		props:              None,
	})
}

fn completion_duration_millis(
	value: &serde_json::Value,
) -> Result<u64, SealedRegistryEvidenceError> {
	if let Some(milliseconds) = value.as_u64() {
		return Ok(milliseconds);
	}
	let text = value
		.as_str()
		.ok_or(SealedRegistryEvidenceError::ManifestDrift)?;
	let (number, multiplier) = if let Some(number) = text.strip_suffix("ms") {
		(number, 1.0)
	} else if let Some(number) = text.strip_suffix('s') {
		(number, 1_000.0)
	} else if let Some(number) = text.strip_suffix('m') {
		(number, 60_000.0)
	} else if let Some(number) = text.strip_suffix('h') {
		(number, 3_600_000.0)
	} else {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	};
	let milliseconds = number
		.parse::<f64>()
		.map_err(|_| SealedRegistryEvidenceError::ManifestDrift)?
		* multiplier;
	if !milliseconds.is_finite() || milliseconds < 0.0 || milliseconds > u64::MAX as f64 {
		return Err(SealedRegistryEvidenceError::ManifestDrift);
	}
	Ok(milliseconds.round() as u64)
}

fn seal_registered_shortcuts(
	manifest: &ExtensionManifest,
	shortcuts: Vec<RegisteredShortcut>,
) -> Result<Vec<ShortcutDecl>, SealedRegistryEvidenceError> {
	shortcuts
		.into_iter()
		.map(|shortcut| {
			let module = manifest_module_for_callback(manifest, shortcut.handler.callable.as_str())?;
			let row = manifest
				.static_declarations()
				.ui
				.shortcuts
				.iter()
				.find(|row| row.key.as_str() == shortcut.chord);
			Ok(ShortcutDecl {
				chord:              shortcut.chord.clone(),
				action_id:          shortcut.action_id,
				description:        shortcut.description,
				when:               shortcut.when.unwrap_or_default(),
				declaration_id:     row.map_or_else(|| shortcut.chord, |row| row.id.to_string()),
				callback:           shortcut.handler.callable,
				module:             module.to_owned(),
				activation_trigger: if shortcut.trigger.is_empty() {
					row.map_or_else(|| "lazy".to_owned(), |row| row.trigger.to_string())
				} else {
					shortcut.trigger
				},
				props:              None,
			})
		})
		.collect()
}

fn manifest_module_for_callback<'a>(
	manifest: &'a ExtensionManifest,
	callback: &str,
) -> Result<&'a str, SealedRegistryEvidenceError> {
	std::iter::once(&manifest.entry)
		.chain(manifest.declaration_modules.iter())
		.find(|module| {
			callback == module.as_str()
				|| callback
					.strip_prefix(module.as_str())
					.is_some_and(|suffix| suffix.starts_with('.'))
		})
		.map(Str::as_str)
		.ok_or(SealedRegistryEvidenceError::SourceModule)
}

fn seal_hook_registration(
	hook: RegisteredHook,
) -> Result<SealedHookRegistration, SealedRegistryEvidenceError> {
	if hook.name.is_empty() || hook.event.is_empty() || hook.phase.is_empty() || hook.event_rev == 0
	{
		return Err(SealedRegistryEvidenceError::Malformed(sf!(
			"hook registration has an empty identity or zero event revision"
		)));
	}
	if hook.concurrency == 0 {
		return Err(SealedRegistryEvidenceError::Malformed(sf!(
			"hook {} has zero concurrency",
			hook.name
		)));
	}
	let concurrency = if hook.threadsafe {
		CallbackConcurrency::Threadsafe
	} else if hook.concurrency == 1 {
		CallbackConcurrency::Serialized
	} else {
		CallbackConcurrency::Concurrent { limit: hook.concurrency }
	};
	let providers = hook
		.when
		.as_ref()
		.and_then(|when| when.provider.as_ref())
		.map(|providers| providers.clone().into_boxed_slice());
	let servers = hook
		.when
		.as_ref()
		.and_then(|when| when.server.as_ref())
		.map(|servers| servers.clone().into_boxed_slice());
	let method_globs = hook
		.when
		.as_ref()
		.map(|when| when.method_globs.clone().into_boxed_slice())
		.unwrap_or_default();
	let on_failure = hook
		.on_failure
		.as_deref()
		.map(|value| hook_failure_policy(value, &hook.name))
		.transpose()?;
	let timeout = hook
		.timeout
		.as_deref()
		.map(|value| hook_timeout(value, &hook.name))
		.transpose()?;
	let event_on_failure = hook_failure_policy(&hook.event_on_failure, &hook.name)?;
	let event_default = hook_default_decision(hook.event_default.as_deref(), &hook.name)?;
	let event_timeout = hook_timeout(&hook.event_timeout, &hook.name)?;
	let composition = hook
		.composition
		.into_iter()
		.map(|(field, value)| hook_composition(field, value, &hook.name))
		.collect::<Result<_, _>>()?;
	Ok(SealedHookRegistration {
		event: hook.event,
		phase: hook.phase,
		name: hook.name,
		order: hook.order,
		on_failure,
		timeout,
		concurrency,
		providers,
		servers,
		method_globs,
		event_revision: hook.event_rev,
		event_on_failure,
		event_default,
		event_timeout,
		composition,
	})
}

fn hook_failure_policy(
	value: &str,
	name: &str,
) -> Result<HookFailurePolicy, SealedRegistryEvidenceError> {
	match value {
		"defer" => Ok(HookFailurePolicy::Defer),
		"deny" => Ok(HookFailurePolicy::Deny),
		_ => Err(SealedRegistryEvidenceError::Malformed(sf!(
			"hook {name} has an invalid on_failure policy {value}"
		))),
	}
}

fn hook_timeout(value: &str, name: &str) -> Result<Duration, SealedRegistryEvidenceError> {
	value
		.parse::<CoreDuration>()
		.and_then(CoreDuration::to_std)
		.map_err(|error| {
			SealedRegistryEvidenceError::Malformed(sf!(
				"hook {name} has an invalid timeout {value}: {error}"
			))
		})
}

fn hook_composition(
	field: Str,
	value: Str,
	name: &str,
) -> Result<(Str, HookFieldComposition), SealedRegistryEvidenceError> {
	match value.as_str() {
		"replace" => Ok((field, HookFieldComposition::Replace)),
		"append" => Ok((field, HookFieldComposition::Append)),
		"intersect" => Ok((field, HookFieldComposition::Intersect)),
		_ => Err(SealedRegistryEvidenceError::Malformed(sf!(
			"hook {name} has an invalid composition policy {value}"
		))),
	}
}

fn hook_default_decision(
	value: Option<&str>,
	name: &str,
) -> Result<serde_json::Value, SealedRegistryEvidenceError> {
	match value {
		None => Ok(serde_json::Value::Null),
		Some("allow") => Ok(serde_json::json!({ "kind": "allow" })),
		Some(value) => Err(SealedRegistryEvidenceError::Malformed(sf!(
			"hook {name} has an invalid default decision {value}"
		))),
	}
}

fn sealed_document_ids(
	documents: &[serde_json::Value],
) -> Result<BTreeSet<&str>, SealedRegistryEvidenceError> {
	let mut ids = BTreeSet::new();
	for document in documents {
		let id = document
			.as_object()
			.and_then(|document| document.get("id"))
			.and_then(serde_json::Value::as_str)
			.filter(|id| !id.is_empty())
			.ok_or_else(|| {
				SealedRegistryEvidenceError::Malformed(sf!(
					"provider/regime declaration has no non-empty id"
				))
			})?;
		if !ids.insert(id) {
			return Err(SealedRegistryEvidenceError::Duplicate);
		}
	}
	Ok(ids)
}

impl WorkerProcess {
	#[tracing::instrument(
		level = "debug",
		name = "py_worker_spawn",
		skip_all,
		fields(
			layer = %config.process_id.layer,
			tier = %config.process_id.tier,
			pool = %config.process_id.pool().map_or("", Str::as_str),
			generation,
			extension_count = config.manifests.len(),
		)
	)]
	async fn spawn(
		config: &ProcessConfig,
		generation: u64,
		cause: ActivationCause,
	) -> Result<Self, WorkerError> {
		let mut command = Command::new(&config.executable);
		command
			.arg(WORKER_ARG)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::inherit())
			.kill_on_drop(true);
		if let Some(root) = &config.workspace_root {
			command.current_dir(root);
		}
		if let Some(site) = &config.python_site {
			command.env("OMP_PY_SITE", site);
		}
		if let Some((module, path)) = &config.exact_entry {
			command
				.env("OMP_PY_ENTRY_MODULE", module.as_str())
				.env("OMP_PY_ENTRY_PATH", path);
		} else {
			command
				.env_remove("OMP_PY_ENTRY_MODULE")
				.env_remove("OMP_PY_ENTRY_PATH");
		}
		if config.modules.is_empty() {
			command.env_remove("OMP_PY_MODULES");
		} else {
			let modules = config
				.modules
				.iter()
				.map(Str::as_str)
				.collect::<Vec<_>>()
				.join(",");
			command.env("OMP_PY_MODULES", modules);
		}
		let manifest_tools = config
			.manifests
			.values()
			.flat_map(|manifest| manifest.declarations.tools())
			.map(|tool| (tool.name.clone(), tool.family.clone(), tool.rev))
			.collect::<BTreeSet<_>>()
			.into_iter()
			.map(|(name, family, rev)| serde_json::json!([name.as_str(), family.as_str(), rev]))
			.collect::<Vec<_>>();
		let manifest_hooks = config
			.manifests
			.values()
			.flat_map(|manifest| manifest.declarations.hooks())
			.map(|hook| (hook.event.clone(), hook.phase.to_string()))
			.collect::<BTreeSet<_>>()
			.into_iter()
			.map(|(event, phase)| serde_json::json!([event.as_str(), phase]))
			.collect::<Vec<_>>();
		let manifest_services = config
			.manifests
			.values()
			.flat_map(|manifest| manifest.services.provides())
			.map(|service| (service.name.clone(), service.rev))
			.collect::<BTreeSet<_>>()
			.into_iter()
			.map(|(name, rev)| serde_json::json!([name.as_str(), rev]))
			.collect::<Vec<_>>();
		let manifest_requires = config
			.manifests
			.values()
			.flat_map(|manifest| manifest.services.requires())
			.map(|service| (service.name.clone(), service.rev))
			.collect::<BTreeSet<_>>()
			.into_iter()
			.map(|(name, rev)| serde_json::json!([name.as_str(), rev]))
			.collect::<Vec<_>>();
		let has_uniform_declarations = config
			.manifests
			.values()
			.any(|manifest| manifest.has_uniform_declarations());
		let trust_runtime_declarations = config.manifests.len() == 1
			&& config
				.manifests
				.values()
				.all(|manifest| manifest.runtime_declarations_trusted());
		let manifest_declarations = config
			.manifests
			.values()
			.flat_map(|manifest| manifest.static_declarations().ordered.iter())
			.map(|declaration| {
				serde_json::json!({
					"id": declaration.id.as_str(),
					"kind": declaration.kind.as_str(),
					"module": declaration.module.as_str(),
					"key": declaration.key.as_str(),
					"trigger": declaration.trigger.as_str(),
					"api": declaration.api,
					"failure": declaration.failure.as_str(),
				})
			})
			.collect::<Vec<_>>();
		let extension = (config.manifests.len() == 1).then(|| {
			config
				.manifests
				.keys()
				.next()
				.expect("one manifest")
				.extension()
				.as_str()
		});
		let mut manifest_snapshot = serde_json::json!({
			"extension": extension,
			"tools": manifest_tools,
			"hooks": manifest_hooks,
			"services": manifest_services,
			"requires": manifest_requires,
			"trust_runtime_declarations": trust_runtime_declarations,
		});
		if has_uniform_declarations {
			manifest_snapshot
				.as_object_mut()
				.expect("manifest snapshot is an object")
				.insert("declarations".into(), serde_json::Value::Array(manifest_declarations));
		}
		let manifest_snapshot = serde_json::to_string(&manifest_snapshot)
			.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
		command.env("OMP_EXT_MANIFEST_SNAPSHOT", manifest_snapshot);
		if let Some(socket) = &config.data_socket {
			command.env(ENV_SOCKET_ENV, socket);
		} else {
			command.env_remove(ENV_SOCKET_ENV);
		}
		if let Some(snapshot) = &config.scheme_snapshot {
			let entries = snapshot
				.entries
				.iter()
				.map(|entry| {
					serde_json::json!([
						entry.member.as_str(),
						entry.readable,
						entry.mintable,
						entry.selectors,
						entry.description.as_str()
					])
				})
				.collect::<Vec<_>>();
			let encoded = serde_json::to_string(&serde_json::json!({
				"device_hash": snapshot.device_hash,
				"entries": entries,
			}))
			.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
			command.env("OMP_EXT_SCHEME_SNAPSHOT", encoded);
		} else {
			command.env_remove("OMP_EXT_SCHEME_SNAPSHOT");
		}
		command
			.env("OMP_EXT_LAYER", config.process_id.layer.as_str())
			.env("OMP_EXT_TIER", config.process_id.tier.as_str())
			.env("OMP_EXT_SESSION_ID", config.session_id.as_str())
			.env("OMP_EXT_PRINCIPAL_ID", config.principal.id())
			.env("OMP_EXT_PRINCIPAL_DISPLAY", config.principal.display())
			.env("OMP_EXT_HOST_GENERATION", generation.to_string())
			.env("OMP_EXT_SESSION_GENERATION", config.session_generation.to_string());
		if let Some(pool) = config.process_id.pool() {
			command.env("OMP_EXT_POOL", pool.as_str());
		} else {
			command.env_remove("OMP_EXT_POOL");
		}
		#[cfg(unix)]
		{
			use std::os::unix::process::CommandExt;
			command.as_std_mut().process_group(0);
		}
		#[cfg(windows)]
		{
			use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
			command.creation_flags(CREATE_NEW_PROCESS_GROUP);
		}
		let mut child = match command.spawn() {
			Ok(child) => child,
			Err(error) => {
				tracing::warn!(%error, "python worker spawn failed");
				return Err(error.into());
			},
		};
		let stdin = child
			.stdin
			.take()
			.ok_or_else(|| WorkerError::Protocol(sf!("worker stdin unavailable")))?;
		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| WorkerError::Protocol(sf!("worker stdout unavailable")))?;
		let mut process = Self {
			child,
			stdin,
			stdout,
			read_scratch: BytesMut::with_capacity(8 * 1024),
			write_scratch: BytesMut::with_capacity(8 * 1024),
			registrations: Vec::new(),
			prompt_registrations: Vec::new(),
			ui_registrations: BTreeMap::new(),
			service_registrations: BTreeMap::new(),
		};
		if let Err(error) = process.handshake(config, generation, cause).await {
			process.terminate(config.interrupt_grace).await;
			tracing::warn!(%error, "python worker handshake failed");
			return Err(error);
		}
		Ok(process)
	}

	#[tracing::instrument(
		level = "debug",
		name = "py_worker_handshake",
		skip_all,
		fields(generation)
	)]
	async fn handshake(
		&mut self,
		config: &ProcessConfig,
		generation: u64,
		cause: ActivationCause,
	) -> Result<(), WorkerError> {
		let hello_frame = self.read_deadline(config.spawn_timeout, config).await?;
		let Some(worker_frame::Body::Hello(hello)) = hello_frame.body else {
			return Err(WorkerError::Protocol(sf!("WorkerHello must be the first frame")));
		};
		if hello.worker_id.is_empty() {
			return Err(WorkerError::Protocol(sf!("WorkerHello has no worker id")));
		}
		if hello.schema_rev != config.schema_rev {
			return Err(WorkerError::SchemaRevision {
				expected: config.schema_rev,
				actual:   hello.schema_rev,
			});
		}
		if hello.python_rev != config.python_rev.as_str() {
			return Err(WorkerError::PythonRevision {
				expected: config.python_rev.clone(),
				actual:   Str::from(hello.python_rev),
			});
		}
		if hello.api_level != 1
			|| hello.layer != config.process_id.layer.as_str()
			|| hello.tier != config.process_id.tier.as_str()
			|| hello.pool != config.process_id.pool().map_or("", Str::as_str)
			|| hello.host_version != env!("CARGO_PKG_VERSION")
			|| hello.host_generation != generation
			|| hello.session_generation != config.session_generation
		{
			return Err(WorkerError::Protocol(sf!(
				"WorkerHello identity or generation did not match the spawned host",
			)));
		}
		let admitted = config
			.manifests
			.iter()
			.flat_map(|(key, manifest)| {
				iter::once(&manifest.entry)
					.chain(manifest.declaration_modules.iter())
					.map(|module| AdmittedExtension {
						extension_id: key.extension().to_string(),
						module:       module.to_string(),
						rev:          manifest.provenance.version().to_owned(),
					})
			})
			.collect();
		self
			.write(
				&HostFrame {
					request_id: 0,
					body:       Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
						body:  Some(lifecycle_host_envelope::Body::AdmitExtensions(AdmitExtensions {
							extensions: admitted,
							generation,
							props: None,
						})),
						props: None,
					})),
					props:      None,
				},
				config,
			)
			.await?;
		let registrations = self.read_deadline(config.spawn_timeout, config).await?;
		let Some(worker_frame::Body::RegisterTools(RegisterTools {
			tools,
			generation: registration_generation,
			extensions,
			slots,
			props,
		})) = registrations.body
		else {
			return Err(WorkerError::Protocol(sf!("RegisterTools must follow WorkerHello",)));
		};
		if registration_generation != generation {
			return Err(WorkerError::Protocol(sf!("RegisterTools generation is stale")));
		}
		let registered_extensions = extensions
			.iter()
			.map(|extension| extension.extension_id.as_str())
			.collect::<HashSet<_>>();
		if registered_extensions.len() != config.manifests.len()
			|| config
				.manifests
				.keys()
				.any(|owner| !registered_extensions.contains(owner.extension().as_str()))
		{
			return Err(WorkerError::Protocol(sf!(
				"RegisterTools extension set did not match the spawned host",
			)));
		}
		validate_registrations(&tools)?;
		validate_manifest_registrations(config, &tools)?;
		let mut prompt_keys = HashSet::with_capacity(slots.len());
		self.prompt_registrations = slots
			.iter()
			.map(|declaration| {
				let owner =
					prompt_prop(declaration.props.as_ref(), PROMPT_OWNER_PROP).ok_or_else(|| {
						WorkerError::Protocol(sf!("prompt declaration has no authenticated owner"))
					})?;
				if !config
					.manifests
					.keys()
					.any(|key| key.extension().as_str() == owner)
				{
					return Err(WorkerError::Protocol(sf!("prompt declaration owner is not admitted",)));
				}
				let binding = prompt_slot_binding(owner, declaration)
					.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
				if !prompt_keys.insert(binding.key.clone()) {
					return Err(WorkerError::Protocol(sf!(
						"prompt declaration key is registered more than once",
					)));
				}
				Ok(binding)
			})
			.collect::<Result<_, WorkerError>>()?;
		self.ui_registrations = parse_ui_registrations(config, props.as_ref(), generation)?;
		self.service_registrations = parse_service_registrations(config, props.as_ref())?;
		self.registrations = tools;
		self.activate_manifests(config, generation, cause).await?;
		Ok(())
	}

	async fn activate_manifests(
		&mut self,
		config: &ProcessConfig,
		generation: u64,
		cause: ActivationCause,
	) -> Result<(), WorkerError> {
		let mut request_id = 1_u64;
		for (owner, manifest) in &config.manifests {
			let declared = if manifest.runtime_declarations_trusted() {
				manifest.declarations.clone()
			} else {
				actual_declarations(config, &self.registrations, owner)?
			};
			let mut machine = manifest.lifecycle(config.session_started_at, config.session_generation);
			let register_ui = self
				.ui_registrations
				.get(owner)
				.cloned()
				.expect("every admitted extension has a UI registration");
			machine
				.register_ui(register_ui, GenerationFence {
					host:    generation,
					session: config.session_generation,
				})
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
			let mut host = WorkerLifecycleAdapter {
				process: self,
				config,
				extension_id: owner.extension().clone(),
				generation,
				request_id: &mut request_id,
			};
			machine
				.activate_declared(
					&mut host,
					&declared,
					GenerationFence { host: generation, session: config.session_generation },
					ActivationTrigger::FirstReach,
					cause,
					&config.principal,
				)
				.await
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
		}
		Ok(())
	}

	async fn read_timeout(&mut self, config: &ProcessConfig) -> Result<WorkerFrame, WorkerError> {
		self.read_deadline(config.health_timeout, config).await
	}

	async fn read_deadline(
		&mut self,
		deadline: Duration,
		config: &ProcessConfig,
	) -> Result<WorkerFrame, WorkerError> {
		time::timeout(
			deadline,
			read_async_frame(&mut self.stdout, config.max_frame_bytes, &mut self.read_scratch),
		)
		.await
		.map_err(|_| WorkerError::HealthTimeout)?
		.and_then(|frame| frame.ok_or(WorkerError::Exited))
	}

	async fn write(&mut self, frame: &HostFrame, config: &ProcessConfig) -> Result<(), WorkerError> {
		write_async_frame(&mut self.stdin, frame, config.max_frame_bytes, &mut self.write_scratch)
			.await
	}

	fn courtesy_interrupt(&self) {
		let pid = self.child.id();
		#[cfg(unix)]
		if let Some(pid) = pid {
			let _ = signal::killpg(Pid::from_raw(pid.cast_signed()), signal::Signal::SIGINT);
		}
		#[cfg(windows)]
		if let Some(pid) = pid {
			unsafe {
				let _ = Console::GenerateConsoleCtrlEvent(Console::CTRL_BREAK_EVENT, pid);
			}
		}
	}

	async fn terminate(&mut self, grace: Duration) {
		let pid = self.child.id();
		self.courtesy_interrupt();
		if time::timeout(grace, self.child.wait()).await.is_ok() {
			return;
		}
		#[cfg(unix)]
		if let Some(pid) = pid {
			let _ = signal::killpg(Pid::from_raw(pid.cast_signed()), signal::Signal::SIGKILL);
		}
		#[cfg(windows)]
		{
			// `start_kill` is the hard fallback on Windows. The worker is a new
			// process-group leader, so the courtesy CTRL_BREAK reaches descendants.
			let _ = self.child.start_kill();
		}
		let _ = self.child.wait().await;
	}
}

struct WorkerLifecycleAdapter<'a> {
	process:      &'a mut WorkerProcess,
	config:       &'a ProcessConfig,
	extension_id: Str,
	generation:   u64,
	request_id:   &'a mut u64,
}

impl LifecycleHost for WorkerLifecycleAdapter<'_> {
	async fn freeze(&mut self) -> Result<(), Str> {
		let request_id = take_request_id(self.request_id);
		self
			.process
			.write(
				&HostFrame {
					request_id,
					body: Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
						body:  Some(lifecycle_host_envelope::Body::FreezeDeclarations(
							FreezeDeclarations {
								extension_id: self.extension_id.to_string(),
								generation:   self.generation,
								props:        None,
							},
						)),
						props: None,
					})),
					props: None,
				},
				self.config,
			)
			.await
			.map_err(|error| Str::from(error.to_string()))
	}

	fn activate(
		&mut self,
		event: &ActivationEvent,
		principal: &omp_core::Principal,
	) -> impl Future<Output = Result<(), Str>> + Send {
		let event = event.clone();
		let principal = principal.clone();
		async move {
			let request_id = take_request_id(self.request_id);
			let session_started_at_ms = event
				.session_started_at
				.duration_since(SystemTime::UNIX_EPOCH)
				.map_err(|_| sf!("session start precedes the Unix epoch"))?
				.as_millis()
				.try_into()
				.map_err(|_| sf!("session start does not fit the lifecycle wire"))?;
			let cli_values = self
				.config
				.cli_values
				.iter()
				.find(|(owner, _)| owner.extension() == &self.extension_id)
				.into_iter()
				.flat_map(|(_, values)| values)
				.map(|value| WireActivationCliValue {
					sink:  value.sink.to_string(),
					value: Some(match &value.value {
						omp_ext::config::ContributedValue::Boolean(value) => {
							activation_cli_value::Value::Boolean(*value)
						},
						omp_ext::config::ContributedValue::String(value) => {
							activation_cli_value::Value::String(value.to_string())
						},
					}),
					props: None,
				})
				.collect();
			self
				.process
				.write(
					&HostFrame {
						request_id,
						body: Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
							body:  Some(lifecycle_host_envelope::Body::ActivateExtension(
								ActivateExtension {
									extension_id: self.extension_id.to_string(),
									reason: wire_activate_reason(event.reason).into(),
									session_started_at_ms,
									generation: event.generation,
									principal: Some(PrincipalRef {
										id:      principal.id().to_owned(),
										display: principal.display().to_owned(),
										props:   None,
									}),
									restart_reason: event
										.restart_reason
										.map(wire_restart_reason)
										.map(Into::into),
									cli_values,
									props: None,
								},
							)),
							props: None,
						})),
						props: None,
					},
					self.config,
				)
				.await
				.map_err(|error| Str::from(error.to_string()))?;
			loop {
				let reply = self
					.process
					.read_deadline(self.config.spawn_timeout, self.config)
					.await
					.map_err(|error| Str::from(error.to_string()))?;
				let Some(worker_frame::Body::Lifecycle(envelope)) = reply.body else {
					return Err(sf!("activation did not return a lifecycle envelope"));
				};
				match envelope.body {
					Some(lifecycle_worker_envelope::Body::ResourceQuery(query))
						if query.extension_id == self.extension_id.as_str() =>
					{
						send_resource_update(
							self.process,
							self.config,
							reply.request_id,
							&self.extension_id,
						)
						.await
						.map_err(|error| Str::from(error.to_string()))?;
					},
					Some(lifecycle_worker_envelope::Body::ExtensionActivated(activated)) => {
						if reply.request_id != request_id
							|| activated.extension_id != self.extension_id.as_str()
							|| activated.generation != self.generation
						{
							return Err(sf!("activation reply correlation or generation is stale",));
						}
						if activated.degraded {
							return Err(Str::from(
								activated
									.error
									.unwrap_or_else(|| "extension activation degraded".into()),
							));
						}
						return Ok(());
					},
					_ => {
						return Err(sf!("activation returned an unsupported lifecycle frame",));
					},
				}
			}
		}
	}
}

async fn send_resource_update(
	process: &mut WorkerProcess,
	config: &ProcessConfig,
	request_id: u64,
	extension_id: &str,
) -> Result<(), WorkerError> {
	use std::time::Instant;

	let owner = config
		.manifests
		.keys()
		.find(|owner| owner.extension().as_str() == extension_id)
		.ok_or_else(|| WorkerError::Protocol(sf!("resource query is not admitted")))?;
	let receipt = config
		.resources
		.lock()
		.resources(config.session_id.as_str(), owner, Instant::now())
		.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
	let quotas = receipt
		.quotas
		.into_iter()
		.map(|(name, status)| {
			let window_ms = status
				.window
				.map(CoreDuration::to_std)
				.transpose()
				.map_err(|_| WorkerError::Protocol(sf!("quota window is too large")))?
				.map(|window| window.as_millis().try_into())
				.transpose()
				.map_err(|_| WorkerError::Protocol(sf!("quota window is too large")))?;
			Ok(QuotaStatus {
				name: name.to_string(),
				limit: status.limit,
				used: status.used,
				window_ms,
				props: None,
			})
		})
		.collect::<Result<Vec<_>, WorkerError>>()?;
	let dropped = receipt
		.dropped
		.into_iter()
		.map(|(name, count)| QuotaDrop { name: name.to_string(), count, props: None })
		.collect();
	process
		.write(
			&HostFrame {
				request_id,
				body: Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
					body:  Some(lifecycle_host_envelope::Body::ResourceUpdate(ResourceUpdate {
						extension_id: extension_id.to_owned(),
						quotas,
						dropped,
						props: None,
					})),
					props: None,
				})),
				props: None,
			},
			config,
		)
		.await
}

fn take_request_id(next: &mut u64) -> u64 {
	let request_id = *next;
	*next = next.wrapping_add(1).max(1);
	request_id
}

const fn wire_activate_reason(reason: omp_core::ActivateReason) -> WireActivateReason {
	match reason {
		omp_core::ActivateReason::FirstReach => WireActivateReason::FirstReach,
		omp_core::ActivateReason::Restart => WireActivateReason::Restart,
		omp_core::ActivateReason::HotReload => WireActivateReason::HotReload,
	}
}

const fn wire_restart_reason(reason: RestartReason) -> WireRestartReason {
	match reason {
		RestartReason::Crash => WireRestartReason::Crash,
		RestartReason::HotReload => WireRestartReason::HotReload,
		RestartReason::CancelEscalation => WireRestartReason::CancelEscalation,
		RestartReason::ProtocolError => WireRestartReason::ProtocolError,
		RestartReason::Oom => WireRestartReason::Oom,
		RestartReason::HealthTimeout => WireRestartReason::HealthTimeout,
	}
}

async fn activate_control_generation(
	activation: &PendingControlActivation,
	control: ControlHandle,
	host_generation: u64,
	cause: ActivationCause,
	frozen_registry: Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
) -> Result<(), WorkerError> {
	let mut identity = (*activation.identity).clone();
	identity.host_generation = host_generation;
	let identity = Arc::new(identity);
	let mut lifecycle = activation
		.manifest
		.lifecycle(activation.session_started_at, activation.session_generation);
	let verified_ui = if !activation
		.manifest
		.static_declarations()
		.ui
		.commands
		.is_empty()
		|| !activation
			.manifest
			.static_declarations()
			.ui
			.shortcuts
			.is_empty()
		|| !activation
			.manifest
			.static_declarations()
			.ui
			.completions
			.is_empty()
		|| !activation
			.manifest
			.static_declarations()
			.ui
			.message_renderers
			.is_empty()
		|| !activation
			.manifest
			.static_declarations()
			.ui
			.verdict_renderers
			.is_empty()
	{
		let mut registration = activation.registered_ui.read().clone().ok_or_else(|| {
			WorkerError::Protocol(sf!("worker handshake omitted sealed UI registry evidence"))
		})?;
		registration.generation = host_generation;
		let verified_ui =
			verify_ui_registration(activation.manifest.static_declarations(), registration.clone())
				.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
		lifecycle
			.register_ui(registration, GenerationFence {
				host:    host_generation,
				session: activation.session_generation,
			})
			.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
		verified_ui
	} else {
		VerifiedUiRoster {
			generation: host_generation,
			extension: activation.key.extension().clone(),
			..Default::default()
		}
	};
	let mut host = FrozenControlLifecycleHost::new(
		control,
		activation.key.extension().clone(),
		activation.session_id.clone(),
		host_generation,
		identity,
		activation.manifest.clone(),
		verified_ui,
		frozen_registry,
		activation.settings.clone(),
	);
	lifecycle
		.activate_declared(
			&mut host,
			&activation.manifest.declarations,
			GenerationFence { host: host_generation, session: activation.session_generation },
			activation.trigger,
			cause,
			&activation.principal,
		)
		.await
		.map(|_| ())
		.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))
}
fn advance_control_activation(activation: &mut PendingControlActivation, running: &RunningHost) {
	let mut identity = (*activation.identity).clone();
	identity.host_generation = running.generation();
	activation.control = running.control();
	activation.identity = Arc::new(identity);
}
fn next_control_authority(
	activation: &PendingControlActivation,
	running: &RunningHost,
) -> Result<Arc<dyn ControlAuthority>, WorkerError> {
	let generation = running
		.generation()
		.checked_add(1)
		.ok_or_else(|| WorkerError::Protocol(sf!("extension host generation is exhausted")))?;
	let mut identity = (*activation.identity).clone();
	identity.host_generation = generation;
	activation
		.host_factory
		.bind_with_agents(Arc::new(identity), Arc::clone(&activation.agents_factory))
		.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))
}
fn control_completion(
	call_id: Str,
	result: serde_json::Value,
) -> Result<WorkerCompletion, WorkerError> {
	if let serde_json::Value::Object(mut completion) = result {
		let parts = match completion.remove("parts") {
			Some(serde_json::Value::Array(parts)) => parts
				.into_iter()
				.map(|part| {
					part
						.as_str()
						.map(|text| text_part(text.to_owned()))
						.ok_or_else(|| {
							WorkerError::Protocol(sf!(
								"CONTROL completion parts must contain only strings"
							))
						})
				})
				.collect::<Result<Vec<_>, _>>()?,
			Some(_) => {
				return Err(WorkerError::Protocol(sf!("CONTROL completion parts must be an array")));
			},
			None => Vec::new(),
		};
		let details = completion
			.remove("details")
			.unwrap_or(serde_json::Value::Null);
		let is_error = match completion.remove("is_error") {
			Some(serde_json::Value::Bool(is_error)) => is_error,
			Some(_) => {
				return Err(WorkerError::Protocol(sf!("CONTROL completion is_error must be boolean")));
			},
			None => false,
		};
		let terminate = match completion.remove("terminate") {
			Some(serde_json::Value::Bool(terminate)) => terminate,
			Some(_) => {
				return Err(WorkerError::Protocol(sf!("CONTROL completion terminate must be boolean")));
			},
			None => false,
		};
		return Ok(WorkerCompletion {
			call_id,
			kind: if is_error {
				WorkerOutcomeKind::Faulted
			} else {
				WorkerOutcomeKind::Ok
			},
			parts,
			details_json: Some(Bytes::from(
				serde_json::to_vec(&details).expect("serializing an existing JSON value cannot fail"),
			)),
			details_blob: None,
			args_issue: None,
			useless: false,
			terminate,
		});
	}

	let text = match &result {
		serde_json::Value::String(text) => text.clone(),
		_ => serde_json::to_string(&result).expect("serializing an existing JSON value cannot fail"),
	};
	Ok(WorkerCompletion {
		call_id,
		kind: WorkerOutcomeKind::Ok,
		parts: vec![text_part(text)],
		details_json: Some(Bytes::from(
			serde_json::to_vec(&result).expect("serializing an existing JSON value cannot fail"),
		)),
		details_blob: None,
		args_issue: None,
		useless: false,
		terminate: false,
	})
}

async fn wait_control_registry(activation: &PendingControlActivation) -> Result<(), WorkerError> {
	let Some(registry) = activation.registry_control.as_ref() else {
		return Ok(());
	};
	time::timeout(Duration::from_secs(10), async {
		loop {
			if registry.evidence(&activation.identity).is_some() {
				break;
			}
			time::sleep(Duration::from_millis(5)).await;
		}
	})
	.await
	.map_err(|_| WorkerError::Protocol(sf!("CONTROL child did not publish registry readiness")))
}

async fn run_control_supervisor(
	mut running: RunningHost,
	owner: HostKey,
	session_id: Str,
	session_generation: u64,
	mailbox: Receiver<SupervisorCommand>,
	host_generation: Arc<AtomicU64>,
	shutdown: CancellationToken,
	activation: PendingControlActivation,
	frozen_registry: Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
	live_control: Arc<LiveControlRoute>,
) {
	use std::time::Instant;
	let mut activation = activation;
	let mut pending = BTreeMap::<u64, PendingInvocation>::new();
	let in_flight = Arc::new(Mutex::new(BTreeMap::<u64, Str>::new()));
	let cancelled = Arc::new(Mutex::new(BTreeSet::<u64>::new()));
	let mut health = time::interval(Duration::from_millis(50));
	health.set_missed_tick_behavior(MissedTickBehavior::Delay);
	loop {
		let command = tokio::select! {
			() = shutdown.cancelled() => break,
			command = mailbox.recv_async() => match command {
				Ok(command) => Some(command),
				Err(_) => break,
			},
			_ = health.tick() => None,
		};
		let Some(command) = command else {
			if !running.is_disabled() && running.has_exited().unwrap_or(true) {
				if let Some(gate) = activation.lifecycle_gate.as_deref() {
					notify_extension_unload(gate, activation.key.extension(), "error", 0);
				}
				loop {
					let authority = match next_control_authority(&activation, &running) {
						Ok(authority) => authority,
						Err(_) => {
							time::sleep(Duration::from_millis(100)).await;
							continue;
						},
					};
					let restarted = tokio::select! {
						() = shutdown.cancelled() => break,
						result = running.restart_with_authority(authority) => result,
					};
					match restarted {
						Ok(()) => {
							let connected_at = Instant::now();
							advance_control_activation(&mut activation, &running);
							if wait_control_registry(&activation).await.is_err() {
								continue;
							}
							if activate_control_generation(
								&activation,
								running.control(),
								running.generation(),
								ActivationCause::Restart(RestartReason::Crash),
								Arc::clone(&frozen_registry),
							)
							.await
							.is_err()
							{
								continue;
							}
							*live_control.control.write() = running.control();
							*live_control.identity.write() = Arc::clone(&activation.identity);
							host_generation.store(running.generation(), Ordering::Release);
							if let Some(gate) = activation.lifecycle_gate.as_deref() {
								notify_extension_load(gate, &activation.manifest.provenance, false);
								notify_host_reconnect(
									gate,
									running.generation(),
									0,
									RestartReason::Crash,
									connected_at.elapsed(),
								);
							}
							break;
						},
						Err(_) => {
							tokio::select! {
								() = shutdown.cancelled() => break,
								() = time::sleep(Duration::from_millis(100)) => {},
							}
						},
					}
				}
			}
			continue;
		};
		match command {
			SupervisorCommand::Open { id, owner: request_owner, call, streams_args, events }
				if request_owner == owner =>
			{
				pending.insert(id, PendingInvocation {
					id,
					owner: request_owner,
					call,
					streams_args,
					arguments: VecDeque::new(),
					committed: None,
					interrupt: None,
					events,
				});
			},
			SupervisorCommand::ArgText { id, frame } => {
				if let Some(invocation) = pending.get_mut(&id) {
					invocation.arguments.push_back(frame);
				}
			},
			SupervisorCommand::ArgsCommitted { id, frame } => {
				let Some(invocation) = pending.remove(&id) else {
					continue;
				};
				let args = match serde_json::from_slice::<serde_json::Value>(&frame.raw) {
					Ok(serde_json::Value::Object(args)) => args,
					Ok(_) | Err(_) => {
						let _ = invocation
							.events
							.send(WorkerEvent::ProtocolError(ProtocolError {
								code:    ProtocolErrorCode::InvalidArgument.into(),
								message: sf!("committed extension arguments are not a JSON object")
									.to_string(),
								props:   None,
							}));
						continue;
					},
				};
				let mut arguments = serde_json::Map::new();
				arguments.insert(
					String::from("path"),
					serde_json::Value::String(invocation.call.name.to_string()),
				);
				arguments.insert(String::from("args"), serde_json::Value::Object(args));
				let data = (activation.data_enabled && frame.effects.is_some()).then(|| {
					serde_json::json!({
						"invocation": invocation.call.invocation_id.as_str(),
						"effect_token": {
							"$bytes": omp_core::base64::encode(frame.effect_token.as_ref()),
						},
						"host_generation": host_generation.load(Ordering::Acquire),
						"session_generation": session_generation,
						"pty_denied": false,
					})
				});
				let authority = ControlInvocationAuthority {
					invocation: invocation.call.invocation_id.clone(),
					phase: InvocationPhase::EffectsAuthorized,
					session: session_id.clone(),
					turn: None,
					event: None,
					call: Some(invocation.call.invocation_id.clone()),
					device: Some(invocation.call.name.clone()),
					effects: Box::new([]),
					place_kind: sf!("host"),
					lifecycle: LifecyclePhase::Active,
					roots: activation.roots.clone(),
					remote: false,
					has_ui: false,
					headless: true,
					settings: activation.settings.clone(),
					secret_settings: Box::new([]),
					data,
					direct_filesystem: None,
				};
				let dispatch = ControlDispatch {
					operation: sf!("omp.devices.call"),
					arguments,
					authority,
					policy: CallbackConcurrency::Serialized,
					deadline: EventDeadline { at: Instant::now() + invocation.call.deadline },
				};
				in_flight
					.lock()
					.insert(id, invocation.call.invocation_id.clone());
				let control = running.control();
				let task_in_flight = Arc::clone(&in_flight);
				let task_cancelled = Arc::clone(&cancelled);
				tokio::spawn(async move {
					let result = control.dispatch(dispatch).await;
					let was_cancelled = task_cancelled.lock().remove(&id);
					if was_cancelled {
						let _ = invocation.events.send(WorkerEvent::Aborted(WorkerAbort {
							call_id:         invocation.call.invocation_id,
							kind:            WorkerAbortKind::Cancelled,
							reason:          sf!("extension invocation cancelled"),
							effects_unknown: true,
						}));
					} else {
						match result {
							Ok(result) => {
								match control_completion(invocation.call.invocation_id.clone(), result) {
									Ok(completion) => {
										let _ = invocation.events.send(WorkerEvent::Complete(completion));
									},
									Err(error) => {
										let _ = invocation.events.send(WorkerEvent::Aborted(WorkerAbort {
											call_id:         invocation.call.invocation_id,
											kind:            WorkerAbortKind::Crashed,
											reason:          Str::from(error.to_string()),
											effects_unknown: true,
										}));
									},
								}
							},
							Err(error) => {
								let _ = invocation.events.send(WorkerEvent::Aborted(WorkerAbort {
									call_id:         invocation.call.invocation_id,
									kind:            WorkerAbortKind::Crashed,
									reason:          Str::from(error.to_string()),
									effects_unknown: true,
								}));
							},
						}
					}
					task_in_flight.lock().remove(&id);
				});
			},
			SupervisorCommand::Cancel { id, .. } => {
				if let Some(invocation) = pending.remove(&id) {
					let _ = invocation.events.send(WorkerEvent::Aborted(WorkerAbort {
						call_id:         invocation.call.invocation_id,
						kind:            WorkerAbortKind::Cancelled,
						reason:          sf!("extension invocation cancelled before dispatch"),
						effects_unknown: false,
					}));
				} else {
					let invocation = { in_flight.lock().get(&id).cloned() };
					if let Some(invocation) = invocation {
						cancelled.lock().insert(id);
						let _ = running.cancel_dispatch(invocation.as_str()).await;
						host_generation.store(running.generation(), Ordering::Release);
					}
				}
			},
			SupervisorCommand::Interrupt { id, frame } => {
				if let Some(invocation) = pending.get_mut(&id) {
					invocation.interrupt = Some(frame);
				}
			},
			SupervisorCommand::PullReply { .. } => {},
			SupervisorCommand::ServiceDispatch { reply, .. } => {
				let _ = reply.send(Err(WorkerError::Unavailable));
			},
			SupervisorCommand::PromptPull { reply, .. } => {
				let _ = reply.send(Err(WorkerError::Unavailable));
			},
			SupervisorCommand::Reload { reply } => {
				if !pending.is_empty() || !in_flight.lock().is_empty() {
					let _ = reply.send(Err(WorkerError::Unavailable));
					continue;
				}
				if let Some(gate) = activation.lifecycle_gate.as_deref() {
					notify_extension_unload(gate, activation.key.extension(), "reload", 0);
				}
				let result = async {
					let authority = next_control_authority(&activation, &running)?;
					running
						.restart_with_authority(authority)
						.await
						.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
					let connected_at = Instant::now();
					advance_control_activation(&mut activation, &running);
					wait_control_registry(&activation).await?;
					activate_control_generation(
						&activation,
						running.control(),
						running.generation(),
						ActivationCause::Restart(RestartReason::HotReload),
						Arc::clone(&frozen_registry),
					)
					.await?;
					*live_control.control.write() = running.control();
					*live_control.identity.write() = Arc::clone(&activation.identity);
					host_generation.store(running.generation(), Ordering::Release);
					if let Some(gate) = activation.lifecycle_gate.as_deref() {
						notify_extension_load(gate, &activation.manifest.provenance, true);
						notify_host_reconnect(
							gate,
							running.generation(),
							0,
							RestartReason::HotReload,
							connected_at.elapsed(),
						);
					}
					Ok(running.generation())
				}
				.await;
				let _ = reply.send(result);
			},
			SupervisorCommand::Shutdown => break,
			SupervisorCommand::Open { events, call, .. } => {
				let _ = events.send(WorkerEvent::Aborted(WorkerAbort {
					call_id:         call.invocation_id,
					kind:            WorkerAbortKind::Crashed,
					reason:          sf!("CONTROL route owner did not match"),
					effects_unknown: false,
				}));
			},
		}
	}
	if let Some(gate) = activation.lifecycle_gate.as_deref() {
		notify_extension_unload(gate, activation.key.extension(), "shutdown", 0);
	}
	for invocation in pending.into_values() {
		let _ = invocation.events.send(WorkerEvent::Aborted(WorkerAbort {
			call_id:         invocation.call.invocation_id,
			kind:            WorkerAbortKind::Cancelled,
			reason:          sf!("CONTROL supervisor shut down"),
			effects_unknown: false,
		}));
	}
	cancelled.lock().extend(in_flight.lock().keys().copied());
	running.shutdown().await;
	let _ = session_generation;
}

async fn run_supervisor(
	config: ProcessConfig,
	mut process: WorkerProcess,
	expected_registrations: Arc<[ToolDecl]>,
	expected_prompt_registrations: Arc<[PromptSlotBinding]>,
	mailbox: Receiver<SupervisorCommand>,
	host_generation: Arc<AtomicU64>,
	mut generation: u64,
	service_router: Arc<ServiceRouter>,
	shutdown: CancellationToken,
) {
	let mut pending = VecDeque::new();
	let mut ping_nonce = 1_u64;
	let mut ping_tick = time::interval(config.ping_interval);
	let mut healthy_since = Instant::now();
	let mut backoff = initial_backoff(&config);
	ping_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
	ping_tick.tick().await;
	loop {
		if let Some(invocation) = pending.pop_front() {
			match run_invocation(
				&config,
				&mut process,
				invocation,
				&mailbox,
				&mut pending,
				&service_router,
				generation,
			)
			.await
			{
				InvocationAction::KeepWorker => {},
				InvocationAction::ReplaceWorker(reason) => {
					if healthy_since.elapsed() >= config.healthy_reset {
						backoff = initial_backoff(&config);
					}
					notify_process_unload(&config, "error");
					process.terminate(config.interrupt_grace).await;
					let Some((replacement, uptime)) = respawn(
						&config,
						&expected_registrations,
						&expected_prompt_registrations,
						&mut generation,
						&mut backoff,
						reason,
						&shutdown,
						&mailbox,
					)
					.await
					else {
						abort_queued_invocations(
							&mut pending,
							&mailbox,
							"extension host shutdown while awaiting respawn",
						);
						return;
					};
					process = replacement;
					host_generation.store(generation, Ordering::Release);
					notify_process_reconnect(&config, generation, reason, uptime);
					let mut broker = service_router.broker.lock();
					for owner in config.manifests.keys() {
						broker.deactivate_provider(owner, "provider process restarted");
						let declarations = process
							.service_registrations
							.get(owner)
							.into_iter()
							.flat_map(|services| services.iter().cloned());
						let _ = broker.activate_provider_declarations(owner, generation, declarations);
					}
					healthy_since = Instant::now();
				},
				InvocationAction::Shutdown => {
					notify_process_unload(&config, "shutdown");
					process.terminate(config.interrupt_grace).await;
					return;
				},
			}
			continue;
		}

		tokio::select! {
			() = shutdown.cancelled() => {
				notify_process_unload(&config, "shutdown");
				process.terminate(config.interrupt_grace).await;
				abort_queued_invocations(
					&mut pending,
					&mailbox,
					"extension host supervisor shut down",
				);
				return;
			},
			command = mailbox.recv_async() => match command {
				Ok(SupervisorCommand::Open { id, owner, call, streams_args, events }) => {
					pending.push_back(PendingInvocation {
						id,
						owner,
						call,
						streams_args,
						arguments: VecDeque::new(),
						committed: None,
						interrupt: None,
						events,
					});
				},
				Ok(SupervisorCommand::PromptPull { request_id, binding, context, reply }) => {
					let result = async {
						let frame = prompt_pull_frame(request_id, &binding, &context)
							.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
						process.write(&frame, &config).await?;
						let response = process.read_timeout(&config).await?;
						if response.request_id != request_id {
							return Err(WorkerError::Protocol(sf!(
								"prompt contribution correlation is stale",
							)));
						}
						decode_prompt_contribution(response, &binding)
							.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))
					}
					.await;
					let _ = reply.send(result);
				},
				Ok(SupervisorCommand::ServiceDispatch { request_id, frame, reply }) => {
					let result = async {
						process
							.write(
								&HostFrame {
									request_id,
									body: Some(omp_proto::toolhost::v1::host_frame::Body::Lifecycle(LifecycleHostEnvelope {
										body: Some(omp_proto::toolhost::v1::lifecycle_host_envelope::Body::ServiceDispatch(frame)),
										props: None,
									})),
									props: None,
								},
								&config,
							)
							.await?;
						let response = process.read_timeout(&config).await?;
						let Some(omp_proto::toolhost::v1::worker_frame::Body::Lifecycle(envelope)) = response.body else {
							return Err(WorkerError::Protocol(sf!(
								"provider did not return a lifecycle envelope",
							)));
						};
						let Some(omp_proto::toolhost::v1::lifecycle_worker_envelope::Body::ServiceResult(result)) =
							envelope.body
						else {
							return Err(WorkerError::Protocol(sf!(
								"provider did not return ServiceResult",
							)));
						};
						if response.request_id != request_id {
							return Err(WorkerError::Protocol(sf!(
								"provider ServiceResult correlation is stale",
							)));
						}
						Ok(result)
					}
					.await;
					let _ = reply.send(result);
				},
				Ok(SupervisorCommand::Reload { reply }) => {
					notify_process_unload(&config, "reload");
					process.terminate(config.interrupt_grace).await;
					let Some((replacement, uptime)) = respawn(
						&config,
						&expected_registrations,
						&expected_prompt_registrations,
						&mut generation,
						&mut backoff,
						RestartReason::HotReload,
						&shutdown,
						&mailbox,
					)
					.await
					else {
						let _ = reply.send(Err(WorkerError::Unavailable));
						abort_queued_invocations(
							&mut pending,
							&mailbox,
							"extension host shutdown while awaiting reload",
						);
						return;
					};
					process = replacement;
					host_generation.store(generation, Ordering::Release);
					notify_process_reconnect(
						&config,
						generation,
						RestartReason::HotReload,
						uptime,
					);
					let mut broker = service_router.broker.lock();
					for owner in config.manifests.keys() {
						broker.deactivate_provider(owner, "provider process hot-reloaded");
						let declarations = process
							.service_registrations
							.get(owner)
							.into_iter()
							.flat_map(|services| services.iter().cloned());
						let _ =
							broker.activate_provider_declarations(owner, generation, declarations);
					}
					drop(broker);
					healthy_since = Instant::now();
					let _ = reply.send(Ok(generation));
				},
				Ok(SupervisorCommand::Shutdown) => {
					notify_process_unload(&config, "shutdown");
					process.terminate(config.interrupt_grace).await;
					return;
				},
				Ok(command) => stage_pending(&mut pending, command),
				Err(_) => {
					notify_process_unload(&config, "shutdown");
					process.terminate(config.interrupt_grace).await;
					return;
				},
			},
			_ = ping_tick.tick() => {
				let frame = HostFrame {
					request_id: 0,
					body: Some(omp_proto::toolhost::v1::host_frame::Body::Ping(Ping { nonce: ping_nonce, props: None })),
					props: None,
				};
				let healthy = process.write(&frame, &config).await.is_ok()
					&& matches!(process.read_timeout(&config).await,
						Ok(WorkerFrame { body: Some(omp_proto::toolhost::v1::worker_frame::Body::Pong(Pong { nonce, .. })), .. }) if nonce == ping_nonce);
				ping_nonce = ping_nonce.wrapping_add(1).max(1);
				if !healthy {
					if healthy_since.elapsed() >= config.healthy_reset {
						backoff = initial_backoff(&config);
					}
					notify_process_unload(&config, "error");
					process.terminate(config.interrupt_grace).await;
					let Some((replacement, uptime)) = respawn(
						&config,
						&expected_registrations,
						&expected_prompt_registrations,
						&mut generation,
						&mut backoff,
						RestartReason::HealthTimeout,
						&shutdown,
						&mailbox,
					)
					.await
					else {
						abort_queued_invocations(
							&mut pending,
							&mailbox,
							"extension host shutdown while awaiting health restart",
						);
						return;
					};
					process = replacement;
					host_generation.store(generation, Ordering::Release);
					notify_process_reconnect(
						&config,
						generation,
						RestartReason::HealthTimeout,
						uptime,
					);
					healthy_since = Instant::now();
				}
			},
		}
	}
}

enum InvocationAction {
	KeepWorker,
	ReplaceWorker(RestartReason),
	Shutdown,
}

async fn dispatch_journal_control(
	process: &mut WorkerProcess,
	config: &ProcessConfig,
	invocation: &PendingInvocation,
	host_generation: u64,
	request_id: u64,
	envelope: v1::JournalWorkerEnvelope,
) -> Result<(), WorkerError> {
	if request_id == 0 {
		return Err(WorkerError::Protocol(sf!("journal CONTROL request_id must be nonzero",)));
	}
	let runtime = config
		.journal
		.lock()
		.binding
		.as_ref()
		.map(|binding| binding.runtime.clone())
		.ok_or_else(|| WorkerError::Protocol(sf!("journal CONTROL is not installed")))?;
	let manifest = config
		.manifests
		.get(&invocation.owner)
		.ok_or_else(|| WorkerError::Protocol(sf!("journal CONTROL owner is not admitted")))?;
	let committed = invocation.committed.as_ref().ok_or_else(|| {
		WorkerError::Protocol(sf!("journal CONTROL cannot run before ArgsCommitted"))
	})?;
	let identity = JournalConnectionIdentity {
		principal: config.principal.clone(),
		provenance: manifest.provenance.clone(),
		host_generation,
		session_generation: config.session_generation,
	};
	let control = JournalControl::new(
		runtime.agent.clone(),
		invocation.owner.extension().clone(),
		Vec::new(),
		identity.clone(),
	);
	match control
		.dispatch(request_id, envelope, committed.authorized_at_ms)
		.await
		.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?
	{
		JournalDispatch::Reply(reply) => {
			process
				.write(
					&HostFrame { request_id, body: Some(host_frame::Body::Journal(reply)), props: None },
					config,
				)
				.await
		},
		JournalDispatch::Rows { request_id, rows } => {
			for reply in journal_rows(&rows) {
				process
					.write(
						&HostFrame {
							request_id,
							body: Some(host_frame::Body::Journal(reply)),
							props: None,
						},
						config,
					)
					.await?;
			}
			Ok(())
		},
		JournalDispatch::External(request) => {
			let (reply, replies) = flume::unbounded();
			runtime
				.external
				.send_async(ExternalJournalCall { request, identity, reply })
				.await
				.map_err(|_| WorkerError::Unavailable)?;
			while let Ok(row) = replies.recv_async().await {
				let reply = row.map_err(WorkerError::Protocol)?;
				process
					.write(
						&HostFrame {
							request_id,
							body: Some(host_frame::Body::Journal(reply)),
							props: None,
						},
						config,
					)
					.await?;
			}
			Ok(())
		},
	}
}

async fn dispatch_service_call(
	process: &mut WorkerProcess,
	config: &ProcessConfig,
	invocation: &PendingInvocation,
	router: &Arc<ServiceRouter>,
	host_generation: u64,
	request_id: u64,
	call: v1::ServiceCall,
) -> Result<(), WorkerError> {
	if request_id == 0
		|| call.extension_id != invocation.owner.extension().as_str()
		|| call.host_generation != host_generation
		|| call.session_generation != config.session_generation
	{
		return Err(WorkerError::Protocol(sf!("service call identity or generation is stale",)));
	}
	let service = ServiceKey::new(call.service.as_str(), call.rev);
	let (dispatch, pending) = {
		let broker = router.broker.lock();
		let connection = broker
			.connect(&invocation.owner, service)
			.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
		let ServiceConnection::Active(route) = connection else {
			return Err(WorkerError::Protocol(sf!("service provider requires activation",)));
		};
		broker
			.begin_call(
				route,
				ServiceRequestMeta {
					host_generation:    call.host_generation,
					session_generation: call.session_generation,
					deadline:           CoreDuration::new(call.deadline_ms, DurationUnit::Milliseconds),
				},
				call.method.as_str(),
				CowBytes::from(call.payload),
			)
			.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?
	};
	let provider = router
		.routes
		.lock()
		.get(&dispatch.route.provider)
		.cloned()
		.ok_or_else(|| WorkerError::Protocol(sf!("service provider is unavailable")))?;
	if provider.process_id == config.process_id {
		return Err(WorkerError::Protocol(sf!(
			"reentrant service callback into the active worker is disabled",
		)));
	}
	let provider_generation = provider.generation.load(Ordering::Acquire);
	if provider_generation != dispatch.route.provider_generation {
		return Err(WorkerError::Protocol(sf!("service provider generation is stale")));
	}
	let provider_id = dispatch.id.0;
	let provider_host = dispatch.route.provider.clone();
	let wire = WireServiceDispatch {
		provider_extension_id: provider_host.extension().to_string(),
		service: dispatch.route.service.name.to_string(),
		rev: dispatch.route.service.rev,
		method: dispatch.method.to_string(),
		payload: dispatch.payload.into_owned().to_vec().into(),
		deadline_ms: call.deadline_ms,
		caller_request_id: request_id,
		caller_host_generation: call.host_generation,
		session_generation: call.session_generation,
		provider_generation,
		props: None,
	};
	let (reply, response) = flume::bounded(1);
	provider
		.commands
		.send_async(SupervisorCommand::ServiceDispatch {
			request_id: provider_id,
			frame: wire,
			reply,
		})
		.await
		.map_err(|_| WorkerError::Unavailable)?;
	let result = time::timeout(Duration::from_millis(call.deadline_ms), response.recv_async())
		.await
		.map_err(|_| WorkerError::Protocol(sf!("service call deadline elapsed")))?
		.map_err(|_| WorkerError::Unavailable)??;
	if result.caller_request_id != request_id || result.provider_generation != provider_generation {
		return Err(WorkerError::Protocol(sf!("provider ServiceResult identity is stale",)));
	}
	let response = if let Some(error) = result.error {
		if !result.payload.is_empty() {
			return Err(WorkerError::Protocol(sf!(
				"provider ServiceResult carries both payload and error",
			)));
		}
		ServiceResponse::Failure(Str::from(error.message))
	} else {
		ServiceResponse::Success(CowBytes::from(result.payload))
	};
	router
		.broker
		.lock()
		.complete(&provider_host, provider_generation, ServiceCallId(provider_id), response)
		.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
	let reply = match pending.response().await {
		Ok(payload) => ServiceReply {
			payload: payload.into_owned().to_vec().into(),
			error:   None,
			props:   None,
		},
		Err(error) => ServiceReply {
			payload: Bytes::new(),
			error:   Some(ProtocolError {
				code:    ProtocolErrorCode::Internal.into(),
				message: error.to_string(),
				props:   None,
			}),
			props:   None,
		},
	};
	process
		.write(
			&HostFrame {
				request_id,
				body: Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
					body:  Some(lifecycle_host_envelope::Body::ServiceReply(reply)),
					props: None,
				})),
				props: None,
			},
			config,
		)
		.await
}
async fn run_invocation(
	config: &ProcessConfig,
	process: &mut WorkerProcess,
	mut invocation: PendingInvocation,
	mailbox: &Receiver<SupervisorCommand>,
	pending: &mut VecDeque<PendingInvocation>,
	service_router: &Arc<ServiceRouter>,
	host_generation: u64,
) -> InvocationAction {
	let id = invocation.id;
	let call_id = invocation.call.invocation_id.clone();

	while !invocation.streams_args && invocation.committed.is_none() {
		match mailbox.recv_async().await {
			Ok(SupervisorCommand::ArgsCommitted { id: committed, frame }) if committed == id => {
				if frame.invocation_id != call_id.as_str() {
					send_host_protocol_error(
						&invocation,
						ProtocolErrorCode::InvalidArgument,
						"ArgsCommitted invocation id is stale",
					);
					return InvocationAction::KeepWorker;
				}
				invocation.committed = Some(frame);
			},
			Ok(SupervisorCommand::Cancel { id: cancelled, reason }) if cancelled == id => {
				let _ = invocation.events.send(WorkerEvent::Aborted(WorkerAbort {
					call_id,
					kind: WorkerAbortKind::Cancelled,
					reason,
					effects_unknown: false,
				}));
				return InvocationAction::KeepWorker;
			},
			Ok(SupervisorCommand::Interrupt { id: interrupted, frame }) if interrupted == id => {
				if frame.invocation_id == call_id.as_str() {
					invocation.interrupt = Some(frame);
				} else {
					send_host_protocol_error(
						&invocation,
						ProtocolErrorCode::InvalidArgument,
						"Interrupt invocation id is stale",
					);
				}
			},
			Ok(SupervisorCommand::ArgText { id: streamed, .. }) if streamed == id => {
				send_host_protocol_error(
					&invocation,
					ProtocolErrorCode::Unsupported,
					"tool declaration did not enable streams_args",
				);
			},
			Ok(SupervisorCommand::PullReply { id: replied, .. }) if replied == id => {
				send_host_protocol_error(
					&invocation,
					ProtocolErrorCode::Busy,
					"PullReply has no outstanding pull",
				);
			},
			Ok(SupervisorCommand::Open { id, owner, call, streams_args, events }) => {
				pending.push_back(PendingInvocation {
					id,
					owner,
					call,
					streams_args,
					arguments: VecDeque::new(),
					committed: None,
					interrupt: None,
					events,
				});
			},
			Ok(SupervisorCommand::Shutdown) | Err(_) => return InvocationAction::Shutdown,
			Ok(command) => stage_pending(pending, command),
		}
	}
	if invocation.events.is_disconnected() {
		return InvocationAction::KeepWorker;
	}

	let request_id = id.max(1);
	let args_json = invocation
		.committed
		.as_ref()
		.map_or_else(Bytes::new, |commit| commit.raw.clone());
	let frame = HostFrame {
		request_id,
		body: Some(host_frame::Body::InvokeTool(InvokeTool {
			call_id: call_id.to_string(),
			name: invocation.call.name.to_string(),
			args_json,
			deadline_ms: invocation
				.call
				.deadline
				.as_millis()
				.try_into()
				.unwrap_or(u64::MAX),
			rev: invocation.call.rev.to_string(),
			props: None,
		})),
		props: None,
	};
	if process.write(&frame, config).await.is_err() {
		send_abort(
			&invocation,
			WorkerAbortKind::Crashed,
			"worker exited before accepting invocation",
		);
		return InvocationAction::ReplaceWorker(RestartReason::Crash);
	}

	while let Some(fragment) = invocation.arguments.pop_front() {
		if write_argument_frame(
			process,
			config,
			request_id,
			argument_host_envelope::Body::ArgText(fragment),
		)
		.await
		.is_err()
		{
			send_abort(&invocation, WorkerAbortKind::Crashed, "worker exited during ArgText");
			return InvocationAction::ReplaceWorker(RestartReason::Crash);
		}
	}
	if let Some(commit) = invocation.committed.as_ref()
		&& write_argument_frame(
			process,
			config,
			request_id,
			argument_host_envelope::Body::ArgsCommitted(commit.clone()),
		)
		.await
		.is_err()
	{
		send_abort(&invocation, WorkerAbortKind::Crashed, "worker exited during ArgsCommitted");
		return InvocationAction::ReplaceWorker(RestartReason::Crash);
	}
	if let Some(interrupt) = invocation.interrupt.as_ref()
		&& write_argument_frame(
			process,
			config,
			request_id,
			argument_host_envelope::Body::Interrupt(interrupt.clone()),
		)
		.await
		.is_err()
	{
		send_abort(&invocation, WorkerAbortKind::Crashed, "worker exited during Interrupt");
		return InvocationAction::ReplaceWorker(RestartReason::Crash);
	}

	let deadline = Instant::now() + invocation.call.deadline;
	let mut pull_open = false;
	loop {
		tokio::select! {
			frame = read_async_frame::<_, WorkerFrame>(&mut process.stdout, config.max_frame_bytes, &mut process.read_scratch) => {
				let Ok(Some(frame)) = frame else {
					send_abort(&invocation, WorkerAbortKind::Crashed, "worker exited during invocation");
					return InvocationAction::ReplaceWorker(RestartReason::Crash);
				};
				if let Some(omp_proto::toolhost::v1::worker_frame::Body::Lifecycle(envelope)) = &frame.body
					&& let Some(omp_proto::toolhost::v1::lifecycle_worker_envelope::Body::SetAvailability(availability)) =
						&envelope.body
				{
					if availability.deltas.iter().any(|delta| !owns_availability(config, delta)) {
						send_abort(
							&invocation,
							WorkerAbortKind::Crashed,
							"worker availability named an undeclared device",
						);
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					}
					let batch = AvailabilityBatch::from_wire(availability.clone());
					let sink = config.availability_sink.lock().as_ref().map(Arc::clone);
					match sink {
						Some(sink) => sink.set_availability(batch),
						None => config.availability_pending.lock().push_back(batch),
					}
					continue;
				}
				if let Some(omp_proto::toolhost::v1::worker_frame::Body::Lifecycle(envelope)) = &frame.body
					&& let Some(omp_proto::toolhost::v1::lifecycle_worker_envelope::Body::ResourceQuery(query)) =
						&envelope.body
				{
					if query.extension_id != invocation.owner.extension().as_str()
						|| send_resource_update(
							process,
							config,
							frame.request_id,
							query.extension_id.as_str(),
						)
						.await
						.is_err()
					{
						send_abort(
							&invocation,
							WorkerAbortKind::Crashed,
							"worker resource query was stale or could not be answered",
						);
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					}
					continue;
				}
				if let Some(omp_proto::toolhost::v1::worker_frame::Body::Journal(envelope)) = &frame.body {
					if dispatch_journal_control(
						process,
						config,
						&invocation,
						host_generation,
						frame.request_id,
						envelope.clone(),
					)
					.await
					.is_err()
					{
						send_host_protocol_error(
							&invocation,
							ProtocolErrorCode::InvalidArgument,
							"journal CONTROL request was rejected",
						);
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					}
					continue;
				}
				if let Some(omp_proto::toolhost::v1::worker_frame::Body::Lifecycle(envelope)) = &frame.body
					&& let Some(lifecycle_worker_envelope::Body::ServiceCall(call)) = &envelope.body
				{
					if let Err(error) = dispatch_service_call(
						process,
						config,
						&invocation,
						service_router,
						host_generation,
						frame.request_id,
						call.clone(),
					)
					.await
					{
						let _ = process
							.write(
								&HostFrame {
									request_id: frame.request_id,
									body: Some(omp_proto::toolhost::v1::host_frame::Body::Lifecycle(LifecycleHostEnvelope {
										body: Some(omp_proto::toolhost::v1::lifecycle_host_envelope::Body::ServiceReply(
											ServiceReply {
												payload: Bytes::new(),
												error: Some(ProtocolError {
													code: ProtocolErrorCode::InvalidArgument.into(),
													message: error.to_string(),
													props: None,
												}),
												props: None,
											},
										)),
										props: None,
									})),
									props: None,
								},
								config,
							)
							.await;
					}
					continue;
				}
				if frame.request_id != request_id {
					send_abort(&invocation, WorkerAbortKind::Crashed, "worker response request id did not match invocation");
					return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
				}
				match frame.body {
					Some(omp_proto::toolhost::v1::worker_frame::Body::ToolUpdate(update)) if update.call_id == call_id.as_str() => {
						if invocation.events.send(WorkerEvent::Update(update)).is_err() {
							cancel_worker(process, config, request_id, &call_id, "invocation receiver dropped").await;
							return InvocationAction::ReplaceWorker(RestartReason::CancelEscalation);
						}
					},
					Some(omp_proto::toolhost::v1::worker_frame::Body::ToolComplete(complete)) if complete.call_id == call_id.as_str() => {
						let Ok(complete) = WorkerCompletion::try_from(complete) else {
							send_abort(
								&invocation,
								WorkerAbortKind::Crashed,
								"worker sent an invalid ToolComplete",
							);
							return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
						};
						let _ = invocation.events.send(WorkerEvent::Complete(complete));
						return InvocationAction::KeepWorker;
					},
					Some(omp_proto::toolhost::v1::worker_frame::Body::Arguments(arguments)) => match arguments.body {
						Some(omp_proto::toolhost::v1::argument_worker_envelope::Body::PullRequest(pull)) => {
							if !invocation.streams_args || pull.call_id != call_id.as_str() || pull_open {
								let message = if pull_open {
									"only one argument pull may be outstanding"
								} else {
									"argument pull does not match a streaming invocation"
								};
								let issue = ArgIssue {
									kind: "protocol".into(),
									expected: message.into(),
									..Default::default()
								};
								let _ = invocation.events.send(WorkerEvent::Complete(args_rejected(&call_id, issue)));
								cancel_worker(process, config, request_id, &call_id, message).await;
								return InvocationAction::ReplaceWorker(RestartReason::CancelEscalation);
							}
							pull_open = true;
							if invocation.events.send(WorkerEvent::Pull(pull)).is_err() {
								cancel_worker(process, config, request_id, &call_id, "invocation receiver dropped").await;
								return InvocationAction::ReplaceWorker(RestartReason::CancelEscalation);
							}
						},
						Some(omp_proto::toolhost::v1::argument_worker_envelope::Body::ToolArgs(args)) => {
							if args.call_id != call_id.as_str() {
								send_abort(&invocation, WorkerAbortKind::Crashed, "ToolArgs call id did not match invocation");
								return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
							}
							let Some(issue) = args.issue else {
								send_abort(&invocation, WorkerAbortKind::Crashed, "ToolArgs omitted its ArgIssue");
								return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
							};
							let _ = invocation.events.send(WorkerEvent::Complete(args_rejected(&call_id, issue)));
							return InvocationAction::KeepWorker;
						},
						None => {
							send_host_protocol_error(&invocation, ProtocolErrorCode::Unsupported, "unsupported argument worker frame");
							return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
						},
					},
					Some(omp_proto::toolhost::v1::worker_frame::Body::ToolAborted(aborted)) if aborted.call_id == call_id.as_str() => {
						let _ = invocation.events.send(WorkerEvent::Aborted(WorkerAbort {
							call_id,
							kind: WorkerAbortKind::Crashed,
							reason: Str::from(aborted.reason),
							effects_unknown: aborted.effects_unknown,
						}));
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					},
					Some(omp_proto::toolhost::v1::worker_frame::Body::Error(error)) => {
						let _ = invocation.events.send(WorkerEvent::ProtocolError(error));
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					},
					_ => {
						send_host_protocol_error(&invocation, ProtocolErrorCode::Unsupported, "unsupported invocation worker frame");
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					},
				}
			},
			command = mailbox.recv_async() => match command {
				Ok(SupervisorCommand::Cancel { id: cancelled, reason }) if cancelled == id => {
					cancel_worker(process, config, request_id, &call_id, reason.as_str()).await;
					let reason = cancellation_reason(config, &invocation.owner, reason.as_str());
					send_abort(&invocation, WorkerAbortKind::Cancelled, reason.as_str());
					return InvocationAction::ReplaceWorker(RestartReason::CancelEscalation);
				},
				Ok(SupervisorCommand::ArgText { id: streamed, frame }) if streamed == id => {
					if !invocation.streams_args || invocation.committed.is_some() || frame.invocation_id != call_id.as_str() {
						send_host_protocol_error(&invocation, ProtocolErrorCode::InvalidArgument, "stale or illegal ArgText");
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					}
					if write_argument_frame(process, config, request_id, omp_proto::toolhost::v1::argument_host_envelope::Body::ArgText(frame)).await.is_err() {
						send_abort(&invocation, WorkerAbortKind::Crashed, "worker exited during ArgText");
						return InvocationAction::ReplaceWorker(RestartReason::Crash);
					}
				},
				Ok(SupervisorCommand::ArgsCommitted { id: committed, frame }) if committed == id => {
					if invocation.committed.is_some() || frame.invocation_id != call_id.as_str() {
						send_host_protocol_error(&invocation, ProtocolErrorCode::InvalidArgument, "stale or duplicate ArgsCommitted");
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					}
					if write_argument_frame(process, config, request_id, omp_proto::toolhost::v1::argument_host_envelope::Body::ArgsCommitted(frame.clone())).await.is_err() {
						send_abort(&invocation, WorkerAbortKind::Crashed, "worker exited during ArgsCommitted");
						return InvocationAction::ReplaceWorker(RestartReason::Crash);
					}
					invocation.committed = Some(frame);
				},
				Ok(SupervisorCommand::PullReply { id: replied, reply }) if replied == id => {
					if !pull_open || reply.call_id != call_id.as_str() || reply.chunk.len() > omp_proto::bounds::PULL_CHUNK_MAX_BYTES {
						send_host_protocol_error(&invocation, ProtocolErrorCode::InvalidArgument, "stale, oversized, or unsolicited PullReply");
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					}
					let terminal = reply.complete || reply.issue.is_some();
					if write_argument_frame(process, config, request_id, omp_proto::toolhost::v1::argument_host_envelope::Body::PullReply(reply)).await.is_err() {
						send_abort(&invocation, WorkerAbortKind::Crashed, "worker exited during PullReply");
						return InvocationAction::ReplaceWorker(RestartReason::Crash);
					}
					if terminal {
						pull_open = false;
					}
				},
				Ok(SupervisorCommand::Interrupt { id: interrupted, frame }) if interrupted == id => {
					if frame.invocation_id != call_id.as_str()
						|| write_argument_frame(process, config, request_id, omp_proto::toolhost::v1::argument_host_envelope::Body::Interrupt(frame)).await.is_err()
					{
						send_host_protocol_error(&invocation, ProtocolErrorCode::InvalidArgument, "stale or undeliverable Interrupt");
						return InvocationAction::ReplaceWorker(RestartReason::ProtocolError);
					}
				},
				Ok(SupervisorCommand::Open { id, owner, call, streams_args, events }) => {
					pending.push_back(PendingInvocation {
						id,
						owner,
						call,
						streams_args,
						arguments: VecDeque::new(),
						committed: None,
						interrupt: None,
						events,
					});
				},
				Ok(SupervisorCommand::Shutdown) | Err(_) => return InvocationAction::Shutdown,
				Ok(command) => stage_pending(pending, command),
			},
			() = time::sleep_until(deadline) => {
				cancel_worker(process, config, request_id, &call_id, "worker invocation timed out").await;
				send_abort(&invocation, WorkerAbortKind::TimedOut, "worker invocation timed out");
				return InvocationAction::ReplaceWorker(RestartReason::CancelEscalation);
			},
		}
	}
}

fn owns_availability(config: &ProcessConfig, delta: &v1::AvailabilityDelta) -> bool {
	config.manifests.values().any(|manifest| {
		manifest
			.declarations
			.tools()
			.any(|tool| tool.name.as_str() == delta.name && tool.rev.to_string() == delta.rev)
	})
}

async fn write_argument_frame(
	process: &mut WorkerProcess,
	config: &ProcessConfig,
	request_id: u64,
	body: argument_host_envelope::Body,
) -> Result<(), WorkerError> {
	process
		.write(
			&HostFrame {
				request_id,
				body: Some(host_frame::Body::Arguments(ArgumentHostEnvelope {
					body:  Some(body),
					props: None,
				})),
				props: None,
			},
			config,
		)
		.await
}

async fn cancel_worker(
	process: &mut WorkerProcess,
	config: &ProcessConfig,
	request_id: u64,
	call_id: &Str,
	reason: &str,
) {
	let _ = process
		.write(
			&HostFrame {
				request_id,
				body: Some(host_frame::Body::CancelTool(CancelTool {
					call_id: call_id.as_str().to_owned(),
					reason:  reason.to_owned(),
					props:   None,
				})),
				props: None,
			},
			config,
		)
		.await;
	process.terminate(config.interrupt_grace).await;
}

fn stage_pending(pending: &mut VecDeque<PendingInvocation>, command: SupervisorCommand) {
	let command = match command {
		SupervisorCommand::ServiceDispatch { reply, .. } => {
			let _ = reply.send(Err(WorkerError::Protocol(sf!(
				"provider worker is busy; reentrant callbacks are disabled",
			))));
			return;
		},
		SupervisorCommand::PromptPull { reply, .. } => {
			let _ = reply.send(Err(WorkerError::Protocol(sf!(
				"prompt renderer worker is busy; reentrant callbacks are disabled",
			))));
			return;
		},
		SupervisorCommand::Reload { reply } => {
			let _ = reply.send(Err(WorkerError::Protocol(sf!(
				"extension worker is busy; retry reload after the active invocation drains",
			))));
			return;
		},
		command => command,
	};
	let id = match &command {
		SupervisorCommand::ArgText { id, .. }
		| SupervisorCommand::ArgsCommitted { id, .. }
		| SupervisorCommand::PullReply { id, .. }
		| SupervisorCommand::Cancel { id, .. }
		| SupervisorCommand::Interrupt { id, .. } => *id,
		SupervisorCommand::Open { .. }
		| SupervisorCommand::ServiceDispatch { .. }
		| SupervisorCommand::PromptPull { .. }
		| SupervisorCommand::Reload { .. }
		| SupervisorCommand::Shutdown => return,
	};
	let Some(index) = pending.iter().position(|invocation| invocation.id == id) else {
		return;
	};
	if let SupervisorCommand::Cancel { reason, .. } = &command {
		let reason = reason.clone();
		let invocation = pending
			.remove(index)
			.expect("the located queued invocation exists");
		let _ = invocation.events.send(WorkerEvent::Aborted(WorkerAbort {
			call_id: invocation.call.invocation_id,
			kind: WorkerAbortKind::Cancelled,
			reason,
			effects_unknown: false,
		}));
		return;
	}
	let invocation = &mut pending[index];
	match command {
		SupervisorCommand::ArgText { frame, .. }
			if invocation.streams_args
				&& invocation.committed.is_none()
				&& frame.invocation_id == invocation.call.invocation_id.as_str() =>
		{
			invocation.arguments.push_back(frame);
		},
		SupervisorCommand::ArgsCommitted { frame, .. }
			if invocation.committed.is_none()
				&& frame.invocation_id == invocation.call.invocation_id.as_str() =>
		{
			invocation.committed = Some(frame);
		},
		SupervisorCommand::Interrupt { frame, .. }
			if frame.invocation_id == invocation.call.invocation_id.as_str() =>
		{
			invocation.interrupt = Some(frame);
		},
		SupervisorCommand::PullReply { .. } => send_host_protocol_error(
			invocation,
			ProtocolErrorCode::Busy,
			"PullReply has no outstanding pull",
		),
		SupervisorCommand::ArgText { .. } => send_host_protocol_error(
			invocation,
			ProtocolErrorCode::Unsupported,
			"stale ArgText or declaration did not enable streams_args",
		),
		SupervisorCommand::ArgsCommitted { .. } => send_host_protocol_error(
			invocation,
			ProtocolErrorCode::InvalidArgument,
			"stale or duplicate ArgsCommitted",
		),
		SupervisorCommand::Interrupt { .. } => {
			send_host_protocol_error(
				invocation,
				ProtocolErrorCode::InvalidArgument,
				"stale Interrupt",
			);
		},
		SupervisorCommand::Open { .. }
		| SupervisorCommand::ServiceDispatch { .. }
		| SupervisorCommand::PromptPull { .. }
		| SupervisorCommand::Cancel { .. }
		| SupervisorCommand::Reload { .. }
		| SupervisorCommand::Shutdown => {},
	}
}

fn send_host_protocol_error(
	invocation: &PendingInvocation,
	code: ProtocolErrorCode,
	message: &'static str,
) {
	let _ = invocation
		.events
		.send(WorkerEvent::ProtocolError(ProtocolError {
			code:    code.into(),
			message: message.into(),
			props:   None,
		}));
}

fn args_rejected(call_id: &Str, issue: ArgIssue) -> WorkerCompletion {
	WorkerCompletion {
		call_id:      call_id.clone(),
		kind:         WorkerOutcomeKind::ArgsRejected,
		parts:        Vec::new(),
		details_json: Some(Bytes::from_static(b"null")),
		details_blob: None,
		args_issue:   Some(issue),
		useless:      false,
		terminate:    false,
	}
}

fn send_abort(invocation: &PendingInvocation, kind: WorkerAbortKind, reason: &str) {
	let _ = invocation.events.send(WorkerEvent::Aborted(WorkerAbort {
		call_id: invocation.call.invocation_id.clone(),
		kind,
		reason: Str::from(reason),
		effects_unknown: invocation.committed.is_some(),
	}));
}

fn notify_process_unload(config: &ProcessConfig, reason: &'static str) {
	let Some(gate) = config.lifecycle_gate.as_deref() else {
		return;
	};
	for manifest in config.manifests.values() {
		notify_extension_unload(gate, manifest.provenance.extension_id(), reason, 0);
	}
}

fn notify_process_reconnect(
	config: &ProcessConfig,
	generation: u64,
	reason: RestartReason,
	uptime: Duration,
) {
	let Some(gate) = config.lifecycle_gate.as_deref() else {
		return;
	};
	for manifest in config.manifests.values() {
		notify_extension_load(gate, &manifest.provenance, reason == RestartReason::HotReload);
	}
	notify_host_reconnect(gate, generation, 0, reason, uptime);
}

fn initial_backoff(config: &ProcessConfig) -> Duration {
	config
		.initial_backoff
		.max(Duration::from_millis(1))
		.min(config.max_backoff.max(Duration::from_millis(1)))
}

fn cancellation_reason(config: &ProcessConfig, owner: &HostKey, reason: &str) -> Str {
	if let Some(pool) = config.process_id.pool() {
		Str::from(format!(
			"{reason}; effects unknown for {}; explicit pool {pool} fate-sharing terminated sibling \
			 extension calls",
			owner.extension(),
		))
	} else {
		Str::from(format!(
			"{reason}; effects unknown for {}; no other extension host was terminated",
			owner.extension(),
		))
	}
}

async fn respawn(
	config: &ProcessConfig,
	expected: &[ToolDecl],
	expected_prompts: &[PromptSlotBinding],
	generation: &mut u64,
	backoff: &mut Duration,
	reason: RestartReason,
	shutdown: &CancellationToken,
	mailbox: &Receiver<SupervisorCommand>,
) -> Option<(WorkerProcess, Duration)> {
	let max_delay = config.max_backoff.max(Duration::from_millis(1));
	loop {
		if shutdown.is_cancelled() || mailbox.is_disconnected() {
			return None;
		}
		tokio::select! {
			() = shutdown.cancelled() => return None,
			() = time::sleep(*backoff) => {},
		}
		if mailbox.is_disconnected() {
			return None;
		}
		*generation = generation.wrapping_add(1).max(1);
		let started_at = Instant::now();
		let spawned = tokio::select! {
			() = shutdown.cancelled() => return None,
			result = WorkerProcess::spawn(
				config,
				*generation,
				ActivationCause::Restart(reason),
			) => result,
		};
		match spawned {
			Ok(process)
				if process.registrations.as_slice() == expected
					&& process.prompt_registrations.as_slice() == expected_prompts =>
			{
				*backoff = backoff.saturating_mul(2).min(max_delay);
				return Some((process, started_at.elapsed()));
			},
			Ok(mut process) => process.terminate(config.interrupt_grace).await,
			Err(_) => {},
		}
		*backoff = backoff.saturating_mul(2).min(max_delay);
	}
}

fn abort_queued_invocations(
	pending: &mut VecDeque<PendingInvocation>,
	mailbox: &Receiver<SupervisorCommand>,
	reason: &str,
) {
	while let Ok(command) = mailbox.try_recv() {
		match command {
			SupervisorCommand::Open { id, owner, call, streams_args, events } => {
				pending.push_back(PendingInvocation {
					id,
					owner,
					call,
					streams_args,
					arguments: VecDeque::new(),
					committed: None,
					interrupt: None,
					events,
				});
			},
			SupervisorCommand::ServiceDispatch { reply, .. } => {
				let _ = reply.send(Err(WorkerError::Unavailable));
			},
			SupervisorCommand::PromptPull { reply, .. } => {
				let _ = reply.send(Err(WorkerError::Unavailable));
			},
			SupervisorCommand::Reload { reply } => {
				let _ = reply.send(Err(WorkerError::Unavailable));
			},
			command => stage_pending(pending, command),
		}
	}
	for invocation in pending.drain(..) {
		send_abort(&invocation, WorkerAbortKind::Crashed, reason);
	}
}
impl TryFrom<ToolComplete> for WorkerCompletion {
	type Error = WorkerError;

	fn try_from(complete: ToolComplete) -> Result<Self, Self::Error> {
		if complete.parts.iter().any(|part| part.kind.is_none()) {
			return Err(WorkerError::Protocol(sf!(
				"ToolComplete contains a part without its presence discriminator",
			)));
		}
		let has_json = !complete.details_json.is_empty();
		let has_blob = complete.details_blob.is_some();
		if has_json == has_blob {
			return Err(WorkerError::Protocol(sf!(
				"ToolComplete must carry exactly one of details_json or details_blob",
			)));
		}
		let kind = match OutcomeKind::try_from(complete.kind).unwrap_or(OutcomeKind::Unspecified) {
			OutcomeKind::Unspecified if complete.is_error => WorkerOutcomeKind::Faulted,
			OutcomeKind::Unspecified => WorkerOutcomeKind::Ok,
			OutcomeKind::Ok => WorkerOutcomeKind::Ok,
			OutcomeKind::Faulted => WorkerOutcomeKind::Faulted,
			OutcomeKind::ArgsRejected => WorkerOutcomeKind::ArgsRejected,
			OutcomeKind::Aborted => WorkerOutcomeKind::Aborted,
		};
		if matches!(kind, WorkerOutcomeKind::ArgsRejected) != complete.args_issue.is_some() {
			return Err(WorkerError::Protocol(sf!(
				"ToolComplete args_issue presence does not match ArgsRejected",
			)));
		}
		Ok(Self {
			call_id: Str::from(complete.call_id),
			kind,
			parts: complete.parts,
			details_json: has_json.then_some(complete.details_json),
			details_blob: complete.details_blob,
			args_issue: complete.args_issue,
			useless: complete.useless,
			terminate: complete.terminate.unwrap_or(false),
		})
	}
}

fn validate_registrations(tools: &[ToolDecl]) -> Result<(), WorkerError> {
	let mut names = HashSet::with_capacity(tools.len());
	for tool in tools {
		let Some(definition) = &tool.definition else {
			return Err(WorkerError::Protocol(sf!("registered tool has no definition")));
		};
		if definition.name.is_empty() || tool.rev.is_empty() {
			return Err(WorkerError::Protocol(sf!(
				"registered tool name and revision must be nonempty",
			)));
		}
		let Some(tool_def::Input::JsonSchema(json_schema)) = definition.input.as_ref() else {
			return Err(WorkerError::Protocol(sf!(
				"worker registered tool definition without a JSON Schema input",
			)));
		};
		if serde_json::from_slice::<serde_json::Value>(&json_schema.schema_json).is_err() {
			return Err(WorkerError::Protocol(Str::from(format!(
				"worker registered invalid JSON Schema for {}",
				definition.name
			))));
		}
		if !names.insert((definition.name.as_str(), tool.rev.as_str())) {
			return Err(WorkerError::Protocol(Str::from(format!(
				"worker registered duplicate tool identity: {}@{}",
				definition.name, tool.rev
			))));
		}
	}
	Ok(())
}

fn validate_manifest_registrations(
	config: &ProcessConfig,
	tools: &[ToolDecl],
) -> Result<(), WorkerError> {
	for (owner, manifest) in &config.manifests {
		if manifest.runtime_declarations_trusted() {
			continue;
		}
		let actual = actual_declarations(config, tools, owner)?;
		if actual != manifest.declarations {
			return Err(WorkerError::Protocol(manifest_registration_diff(
				owner, manifest, tools, &actual,
			)));
		}
	}
	Ok(())
}

fn parse_service_registrations(
	config: &ProcessConfig,
	props: Option<&ValueMap>,
) -> Result<BTreeMap<HostKey, Box<[ServiceProviderDeclaration]>>, WorkerError> {
	let encoded = props
		.and_then(|props| props.fields.get("omp/registry-snapshot-json"))
		.and_then(|value| match value.kind.as_ref() {
			Some(value::Kind::String(encoded)) => Some(encoded.as_str()),
			_ => None,
		})
		.ok_or_else(|| {
			WorkerError::Protocol(sf!("RegisterTools omitted sealed registry metadata"))
		})?;
	let snapshot: RegisteredRegistrySnapshot = serde_json::from_str(encoded)
		.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
	let mut registrations = config
		.manifests
		.keys()
		.cloned()
		.map(|owner| (owner, Vec::new()))
		.collect::<BTreeMap<_, _>>();
	let mut identities = BTreeSet::new();
	for service in snapshot.services {
		if service.name.is_empty()
			|| service.rev == 0
			|| service.methods.is_empty()
			|| service.methods.iter().any(|method| {
				method.name.is_empty()
					|| !method.input_schema.is_object()
					|| !method.result_schema.is_object()
			}) {
			return Err(WorkerError::Protocol(sf!(
				"sealed service metadata has an invalid identity or method schema",
			)));
		}
		let owners = config
			.manifests
			.iter()
			.filter(|(_, manifest)| {
				iter::once(&manifest.entry)
					.chain(manifest.declaration_modules.iter())
					.any(|module| module.as_str() == service.source_module)
			})
			.map(|(owner, _)| owner)
			.collect::<Vec<_>>();
		let [owner] = owners.as_slice() else {
			return Err(WorkerError::Protocol(sf!(
				"sealed service source module is not owned by exactly one admitted extension",
			)));
		};
		let key = ServiceKey::new(service.name, service.rev);
		if !identities.insert(((*owner).clone(), key.clone())) {
			return Err(WorkerError::Protocol(sf!(
				"sealed registry published a duplicate service identity",
			)));
		}
		registrations
			.get_mut(*owner)
			.expect("admitted owner has a service bucket")
			.push(ServiceProviderDeclaration {
				service: key,
				methods: service
					.methods
					.into_iter()
					.map(|method| ServiceMethodSchema {
						name:          Str::from(method.name),
						input_schema:  method.input_schema,
						result_schema: method.result_schema,
					})
					.collect(),
			});
	}
	Ok(registrations
		.into_iter()
		.map(|(owner, services)| (owner, services.into_boxed_slice()))
		.collect())
}
fn parse_ui_registrations(
	config: &ProcessConfig,
	props: Option<&ValueMap>,
	generation: u64,
) -> Result<BTreeMap<HostKey, RegisterUi>, WorkerError> {
	let encoded = props
		.and_then(|props| props.fields.get("omp/registry-snapshot-json"))
		.and_then(|value| match value.kind.as_ref() {
			Some(value::Kind::String(encoded)) => Some(encoded.as_str()),
			_ => None,
		})
		.ok_or_else(|| {
			WorkerError::Protocol(sf!("RegisterTools omitted sealed registry metadata"))
		})?;
	let snapshot: RegisteredRegistrySnapshot = serde_json::from_str(encoded)
		.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
	let mut registrations = config
		.manifests
		.keys()
		.cloned()
		.map(|owner| {
			(owner.clone(), RegisterUi {
				generation,
				extension_id: owner.extension().to_string(),
				..Default::default()
			})
		})
		.collect::<BTreeMap<_, _>>();
	for command in snapshot.commands {
		let (owner, module) = ui_callback_owner(config, command.handler.callable.as_str())?;
		let module = module.to_owned();
		let manifest = config
			.manifests
			.get(owner)
			.expect("UI callback owner is admitted");
		let row = manifest
			.static_declarations()
			.ui
			.commands
			.iter()
			.find(|row| row.key.as_str() == command.name);
		registrations
			.get_mut(owner)
			.expect("UI callback owner has a registration")
			.commands
			.push(CommandDecl {
				name: command.name.clone(),
				description: command.description,
				hint: command.hint,
				aliases: command.aliases,
				args: command
					.args
					.into_iter()
					.map(|arg| CommandArgDecl {
						name:        arg.name,
						description: arg.description,
						usage:       arg.usage,
					})
					.collect(),
				declaration_id: row.map_or_else(|| command.name.clone(), |row| row.id.to_string()),
				callback: command.handler.callable,
				module,
				activation_trigger: if command.trigger.is_empty() {
					row.map_or_else(|| "lazy".to_owned(), |row| row.trigger.to_string())
				} else {
					command.trigger
				},
				arg_completion_callback: command.arg_completions.map(|callback| callback.callable),
				props: None,
			});
	}
	for shortcut in snapshot.shortcuts {
		let (owner, module) = ui_callback_owner(config, shortcut.handler.callable.as_str())?;
		let module = module.to_owned();
		let manifest = config
			.manifests
			.get(owner)
			.expect("UI callback owner is admitted");
		let row = manifest
			.static_declarations()
			.ui
			.shortcuts
			.iter()
			.find(|row| row.key.as_str() == shortcut.chord);
		registrations
			.get_mut(owner)
			.expect("UI callback owner has a registration")
			.shortcuts
			.push(ShortcutDecl {
				chord: shortcut.chord.clone(),
				action_id: shortcut.action_id,
				description: shortcut.description,
				when: shortcut.when.unwrap_or_default(),
				declaration_id: row.map_or_else(|| shortcut.chord, |row| row.id.to_string()),
				callback: shortcut.handler.callable,
				module,
				activation_trigger: if shortcut.trigger.is_empty() {
					row.map_or_else(|| "lazy".to_owned(), |row| row.trigger.to_string())
				} else {
					shortcut.trigger
				},
				props: None,
			});
	}
	for completion in snapshot.completions {
		let owner = ui_callback_owner(config, completion.value.callable.as_str())?
			.0
			.clone();
		let manifest = config
			.manifests
			.get(&owner)
			.expect("UI callback owner is admitted");
		let trigger = seal_registered_completion(manifest, completion)
			.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
		registrations
			.get_mut(&owner)
			.expect("UI callback owner has a registration")
			.triggers
			.push(trigger);
	}
	Ok(registrations)
}

fn ui_callback_owner<'a>(
	config: &'a ProcessConfig,
	callback: &str,
) -> Result<(&'a HostKey, &'a str), WorkerError> {
	let owners = config
		.manifests
		.iter()
		.filter_map(|(owner, manifest)| {
			std::iter::once(&manifest.entry)
				.chain(manifest.declaration_modules.iter())
				.find(|module| {
					callback == module.as_str()
						|| callback
							.strip_prefix(module.as_str())
							.is_some_and(|suffix| suffix.starts_with('.'))
				})
				.map(|module| (owner, module.as_str()))
		})
		.collect::<Vec<_>>();
	let [owner] = owners.as_slice() else {
		return Err(WorkerError::Protocol(sf!(
			"UI callback module is not owned by exactly one admitted extension",
		)));
	};
	Ok(*owner)
}

fn manifest_registration_diff(
	owner: &HostKey,
	manifest: &ExtensionManifest,
	tools: &[ToolDecl],
	actual: &DeclarationSet,
) -> Str {
	let missing = manifest
		.declarations
		.tools()
		.filter(|expected| !actual.tools().any(|registered| *registered == **expected))
		.map(|tool| format!("{}@{}:{}", tool.name, tool.family, tool.rev))
		.collect::<Vec<_>>();
	let unexpected = actual
		.tools()
		.filter(|registered| {
			!manifest
				.declarations
				.tools()
				.any(|expected| *expected == **registered)
		})
		.map(|tool| format!("{}@{}:{}", tool.name, tool.family, tool.rev))
		.collect::<Vec<_>>();
	let mismatches = manifest
		.declarations
		.tools()
		.filter_map(|expected| {
			actual
				.tools()
				.find(|registered| registered.name == expected.name)
				.and_then(|registered| {
					(registered.rev != expected.rev || registered.family != expected.family).then(|| {
						format!(
							"name {} has registered rev {}@{} instead of {}@{}",
							expected.name,
							registered.family,
							registered.rev,
							expected.family,
							expected.rev
						)
					})
				})
		})
		.collect::<Vec<_>>();
	let flags = tools
		.iter()
		.filter(|tool| tool.extension_id == owner.extension().as_str())
		.map(|tool| {
			format!(
				"{}: streams_args={}, effects={}",
				tool
					.definition
					.as_ref()
					.map_or("", |definition| definition.name.as_str()),
				tool.streams_args,
				tool.effects.is_some()
			)
		})
		.collect::<Vec<_>>();
	Str::from(format!(
		"frozen worker declarations differ from authenticated manifest for {}: missing=[{}]; \
		 unexpected=[{}]; name/rev mismatches=[{}]; registered flags=[{}]",
		owner.extension(),
		missing.join(", "),
		unexpected.join(", "),
		mismatches.join(", "),
		flags.join(", "),
	))
}

fn actual_declarations(
	config: &ProcessConfig,
	tools: &[ToolDecl],
	owner: &HostKey,
) -> Result<DeclarationSet, WorkerError> {
	let tools = tools
		.iter()
		.filter(|tool| tool.extension_id == owner.extension().as_str())
		.map(|tool| {
			let definition = tool
				.definition
				.as_ref()
				.ok_or_else(|| WorkerError::Protocol(sf!("registered tool has no definition")))?;
			let rev = tool
				.rev
				.parse::<omp_tool::Rev>()
				.map_err(|_| WorkerError::Protocol(sf!("registered tool revision is not canonical")))?;
			Ok(ToolDeclarationKey::new(definition.name.as_str(), rev.family, rev.n))
		})
		.collect::<Result<Vec<_>, WorkerError>>()?;
	let hooks = config
		.manifests
		.get(owner)
		.into_iter()
		.flat_map(|manifest| manifest.declarations.hooks())
		.cloned();
	Ok(DeclarationSet::new(tools, hooks))
}

#[pyfunction]
fn evaluate_python_expression<'py>(
	py: Python<'py>,
	params: &Bound<'py, PyDict>,
) -> PyResult<Bound<'py, PyDict>> {
	let code = params
		.get_item("code")?
		.ok_or_else(|| PyKeyError::new_err("py_eval requires code"))?
		.extract::<String>()?;
	if code.is_empty() {
		return Err(PyValueError::new_err("py_eval code must be nonempty"));
	}
	let code =
		CString::new(code).map_err(|_| PyValueError::new_err("py_eval code contains a null byte"))?;
	let globals = PyDict::new(py);
	globals.set_item("__builtins__", PyModule::import(py, "builtins")?)?;
	let value = py.eval(code.as_c_str(), Some(&globals), Some(&globals))?;
	let json = PyModule::import(py, "json")?;
	let json_options = PyDict::new(py);
	json_options.set_item("allow_nan", false)?;
	let details = PyDict::new(py);
	if json
		.getattr("dumps")?
		.call((&value,), Some(&json_options))
		.is_ok()
	{
		details.set_item("result", value)?;
	} else {
		details.set_item("result", value.repr()?.to_str()?)?;
	}
	let completion = PyDict::new(py);
	completion.set_item("details", details)?;
	Ok(completion)
}

#[pymodule(gil_used = false)]
fn omp_py_eval(m: &Bound<'_, PyModule>) -> PyResult<()> {
	let py = m.py();
	let declaration = PyDict::new(py);
	declaration.set_item("name", "py_eval")?;
	declaration.set_item("description", "Evaluate one Python expression")?;
	declaration.set_item(
		"schema",
		r#"{"type":"object","properties":{"code":{"type":"string","minLength":1}},"required":["code"],"additionalProperties":false}"#,
	)?;
	declaration.set_item("rev", "1")?;
	declaration.set_item("strict", true)?;
	declaration.set_item("handler", wrap_pyfunction!(evaluate_python_expression, m)?)?;
	m.add("OMP_TOOLS", PyList::new(py, [declaration])?)
}

/// Boots embedded Python, imports configured extension modules, registers their
/// declarations, and serves toolhost/v1 on stdin/stdout.
///
/// `OMP_PY_SITE` selects the optional site-packages directory.
/// `OMP_PY_MODULES` is the comma-separated list of import names enabled for
/// this worker. Modules normally publish decorated declarations through the
/// sealed `omp._registry`; the first-party evaluator additionally exercises the
/// documented legacy `OMP_TOOLS` mapping input.
///
/// # Errors
/// Returns a worker startup, extension import, or stdio protocol error.
#[tracing::instrument(level = "debug", name = "py_worker_entry", skip_all)]
pub fn run_py_worker_entry() -> Result<(), WorkerError> {
	let modules = configured_modules();
	if modules
		.iter()
		.any(|module| module.as_str() == PY_EVAL_MODULE)
	{
		pyo3::append_to_inittab!(omp_py_eval);
	}
	let engine = omp_py::Engine::builder()
		.init()
		.map_err(|error| WorkerError::Python(Str::from(error.to_string())))?;
	install_scheme_snapshot()?;
	serve_worker(&engine, &modules)
}

fn install_scheme_snapshot() -> Result<(), WorkerError> {
	let Ok(encoded) = env::var("OMP_EXT_SCHEME_SNAPSHOT") else {
		return Ok(());
	};
	let value: serde_json::Value = serde_json::from_str(&encoded)
		.map_err(|error| WorkerError::Protocol(Str::from(error.to_string())))?;
	let hash_values = value
		.get("device_hash")
		.and_then(serde_json::Value::as_array)
		.ok_or_else(|| WorkerError::Protocol(sf!("scheme snapshot has no hash")))?;
	let hash = <[u8; 32]>::try_from(
		hash_values
			.iter()
			.map(|value| value.as_u64().and_then(|value| u8::try_from(value).ok()))
			.collect::<Option<Vec<_>>>()
			.ok_or_else(|| WorkerError::Protocol(sf!("scheme snapshot hash is invalid")))?
			.as_slice(),
	)
	.map_err(|_| WorkerError::Protocol(sf!("scheme snapshot hash is invalid")))?;
	let entries =
		value
			.get("entries")
			.and_then(serde_json::Value::as_array)
			.ok_or_else(|| WorkerError::Protocol(sf!("scheme snapshot has no entries")))?
			.iter()
			.map(|entry| {
				let entry = entry
					.as_array()
					.ok_or_else(|| WorkerError::Protocol(sf!("scheme snapshot entry is invalid")))?;
				let [member, readable, mintable, selectors, description] = entry.as_slice() else {
					return Err(WorkerError::Protocol(sf!("scheme snapshot entry is invalid")));
				};
				Ok((
					Str::from(member.as_str().ok_or_else(|| {
						WorkerError::Protocol(sf!("scheme snapshot member is invalid"))
					})?),
					readable.as_bool().ok_or_else(|| {
						WorkerError::Protocol(sf!("scheme snapshot readable bit is invalid"))
					})?,
					mintable.as_bool().ok_or_else(|| {
						WorkerError::Protocol(sf!("scheme snapshot mintable bit is invalid"))
					})?,
					selectors.as_bool().ok_or_else(|| {
						WorkerError::Protocol(sf!("scheme snapshot selector bit is invalid"))
					})?,
					Str::from(description.as_str().ok_or_else(|| {
						WorkerError::Protocol(sf!("scheme snapshot description is invalid"))
					})?),
				))
			})
			.collect::<Result<Vec<_>, WorkerError>>()?;
	omp_py::set_scheme_snapshot(hash, entries);
	Ok(())
}

fn preload_exact_entry(engine: &omp_py::Engine, modules: &[Str]) -> Result<(), WorkerError> {
	let module = env::var_os("OMP_PY_ENTRY_MODULE");
	let path = env::var_os("OMP_PY_ENTRY_PATH");
	let (module, path) = match (module, path) {
		(None, None) => return Ok(()),
		(Some(module), Some(path)) => (
			module
				.into_string()
				.map_err(|_| WorkerError::Protocol(sf!("exact Python entry module is not UTF-8")))?,
			PathBuf::from(path),
		),
		_ => {
			return Err(WorkerError::Protocol(sf!(
				"exact Python entry requires both module and path",
			)));
		},
	};
	if !modules
		.iter()
		.any(|configured| configured.as_str() == module)
	{
		return Err(WorkerError::Protocol(sf!("exact Python entry module is not admitted",)));
	}
	engine
		.attach(|py| -> PyResult<()> {
			let importlib = PyModule::import(py, "importlib.util")?;
			let spec = importlib.call_method1("spec_from_file_location", (module.as_str(), &path))?;
			if spec.is_none() {
				return Err(PyValueError::new_err("exact Python entry has no import specification"));
			}
			let loaded = importlib.call_method1("module_from_spec", (&spec,))?;
			let sys = PyModule::import(py, "sys")?;
			sys.getattr("modules")?
				.cast::<PyDict>()?
				.set_item(module.as_str(), &loaded)?;
			spec
				.getattr("loader")?
				.call_method1("exec_module", (&loaded,))?;
			Ok(())
		})
		.map_err(WorkerError::from)
}

fn configure_python_manifest(engine: &omp_py::Engine) -> Result<(), WorkerError> {
	let encoded = required_env("OMP_EXT_MANIFEST_SNAPSHOT")?;
	engine
		.attach(|py| -> PyResult<()> {
			let json = PyModule::import(py, "json")?;
			let manifest = json.call_method1("loads", (encoded.as_str(),))?;
			let manifest = manifest.cast::<PyDict>()?;
			PyModule::import(py, "omp._registry")?
				.getattr("configure_manifest")?
				.call((), Some(manifest))?;
			Ok(())
		})
		.map_err(WorkerError::from)
}

fn load_prompt_slots(
	engine: &omp_py::Engine,
	admitted_modules: &BTreeMap<&str, &str>,
) -> Result<Vec<v1::SlotDecl>, WorkerError> {
	engine
		.attach(|py| -> PyResult<Vec<v1::SlotDecl>> {
			let registry = PyModule::import(py, "omp._registry")?.getattr("registry")?;
			let snapshot = registry.call_method0("snapshot")?;
			let definitions = snapshot.getattr("prompt_slots")?;
			let mut slots = Vec::new();
			for definition in PyIterator::from_object(&definitions)? {
				let definition = definition?;
				let renderer = definition.getattr("renderer")?;
				let module: String = renderer.getattr("__module__")?.extract()?;
				let qualname: String = renderer.getattr("__qualname__")?.extract()?;
				let owner = admitted_modules.get(module.as_str()).ok_or_else(|| {
					PyValueError::new_err("prompt renderer module is not an admitted extension")
				})?;
				let slot: String = definition.getattr("slot")?.extract()?;
				let slot = slot.parse::<omp_agent::SlotId>().map_err(|_| {
					PyValueError::new_err("prompt renderer named an unknown catalog slot")
				})?;
				let class: String = definition.getattr("cls")?.extract()?;
				let priority: i32 = definition.getattr("priority")?.extract()?;
				let key = format!("{module}.{qualname}");
				slots.push(v1::SlotDecl {
					slot: slot as u32,
					class,
					priority,
					props: Some(ValueMap {
						fields: BTreeMap::from([
							(PROMPT_OWNER_PROP.to_owned(), Value {
								kind: Some(value::Kind::String((*owner).to_owned())),
							}),
							(PROMPT_KEY_PROP.to_owned(), Value { kind: Some(value::Kind::String(key)) }),
						]),
					}),
				});
			}
			Ok(slots)
		})
		.map_err(WorkerError::from)
}

fn render_python_prompt_slot(
	engine: &omp_py::Engine,
	key: &str,
	context_json: &str,
) -> Result<String, WorkerError> {
	engine
		.attach(|py| -> PyResult<String> {
			let registry = PyModule::import(py, "omp._registry")?.getattr("registry")?;
			let snapshot = registry.call_method0("snapshot")?;
			let definitions = snapshot.getattr("prompt_slots")?;
			let json = PyModule::import(py, "json")?;
			let kwargs = json.call_method1("loads", (context_json,))?;
			let kwargs = kwargs.cast::<PyDict>()?;
			let prompts = PyModule::import(py, "omp.prompts")?;
			let class = kwargs
				.get_item("cls")?
				.ok_or_else(|| PyKeyError::new_err("prompt context has no cls"))?;
			kwargs.set_item("cls", prompts.getattr("SlotClass")?.call1((class,))?)?;
			let context = prompts.getattr("PromptContext")?.call((), Some(kwargs))?;
			for definition in PyIterator::from_object(&definitions)? {
				let definition = definition?;
				let renderer = definition.getattr("renderer")?;
				let module: String = renderer.getattr("__module__")?.extract()?;
				let qualname: String = renderer.getattr("__qualname__")?.extract()?;
				if format!("{module}.{qualname}") != key {
					continue;
				}
				let first = renderer.call1((&context,))?;
				let second = renderer.call1((&context,))?;
				if !first.eq(&second)? {
					return Err(PyValueError::new_err(
						"prompt renderer returned different bytes for identical input",
					));
				}
				if first.is_none() {
					return Ok(String::new());
				}
				let value = first
					.cast::<PyString>()
					.map_err(|_| PyTypeError::new_err("prompt renderer must return str or None"))?;
				return value
					.extract::<String>()
					.map_err(|_| PyTypeError::new_err("prompt renderer must return str or None"));
			}
			Err(PyKeyError::new_err("prompt renderer declaration is not registered"))
		})
		.map_err(WorkerError::from)
}

fn serve_worker(engine: &omp_py::Engine, modules: &[Str]) -> Result<(), WorkerError> {
	engine.attach(|py| -> PyResult<()> {
		let sys = PyModule::import(py, "sys")?;
		if let Ok(site) = env::var("OMP_PY_SITE") {
			let path = sys.getattr("path")?;
			let path = path.cast::<PyList>()?;
			path.insert(0, site)?;
		}
		sys.setattr("stdout", sys.getattr("stderr")?)?;
		Ok(())
	})?;
	let layer = required_env("OMP_EXT_LAYER")?;
	let tier = required_env("OMP_EXT_TIER")?;
	let session_id = required_env("OMP_EXT_SESSION_ID")?;
	let principal_id = required_env("OMP_EXT_PRINCIPAL_ID")?;
	let principal_display = required_env("OMP_EXT_PRINCIPAL_DISPLAY")?;
	let pool = env::var("OMP_EXT_POOL").unwrap_or_default();
	let host_generation = required_env_u64("OMP_EXT_HOST_GENERATION")?;
	let session_generation = required_env_u64("OMP_EXT_SESSION_GENERATION")?;
	let stdin = io::stdin();
	let stdout = io::stdout();
	let mut reader = stdin.lock();
	let mut writer = stdout.lock();
	let mut read_scratch = BytesMut::with_capacity(8 * 1024);
	let mut write_scratch = BytesMut::with_capacity(8 * 1024);
	let limit = NonZeroUsize::new(DEFAULT_MAX_FRAME_BYTES)
		.expect("the default worker frame limit is nonzero");
	write_sync_frame(
		&mut writer,
		&WorkerFrame {
			request_id: 0,
			body:       Some(worker_frame::Body::Hello(WorkerHello {
				schema_rev: omp_proto::SCHEMA_REV,
				python_rev: PYTHON_REV.to_owned(),
				worker_id: Bytes::copy_from_slice(&process::id().to_be_bytes()),
				api_level: 1,
				layer,
				tier: tier.clone(),
				pool,
				host_version: env!("CARGO_PKG_VERSION").to_owned(),
				host_generation,
				session_generation,
				props: None,
			})),
			props:      None,
		},
		limit,
		&mut write_scratch,
	)?;
	let admit_frame = read_sync_frame::<_, HostFrame>(&mut reader, limit, &mut read_scratch)?
		.ok_or(WorkerError::Exited)?;
	let HostFrame {
		request_id: 0,
		body:
			Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
				body: Some(lifecycle_host_envelope::Body::AdmitExtensions(admitted)),
				..
			})),
		..
	} = admit_frame
	else {
		return Err(WorkerError::Protocol(sf!("AdmitExtensions must follow WorkerHello",)));
	};
	if admitted.generation != host_generation {
		return Err(WorkerError::Protocol(sf!("AdmitExtensions generation is stale")));
	}
	let admitted_modules = admitted
		.extensions
		.iter()
		.map(|extension| (extension.module.as_str(), extension.extension_id.as_str()))
		.collect::<BTreeMap<_, _>>();
	if admitted_modules.len() != modules.len()
		|| modules
			.iter()
			.any(|module| !admitted_modules.contains_key(module.as_str()))
	{
		return Err(WorkerError::Protocol(sf!(
			"AdmitExtensions modules differ from the spawned worker configuration",
		)));
	}
	configure_python_manifest(engine)?;
	preload_exact_entry(engine, modules)?;
	let (mut tools, registry_metadata) = load_tools(engine, modules)?;
	tools.extend(load_prelude(engine, modules)?);
	for tool in &mut tools {
		let extension_id = match admitted_modules.get(tool.decl.extension_id.as_str()) {
			Some(extension_id) => extension_id,
			None if matches!(&tool.kind, PythonToolKind::Prelude) => {
				return Err(WorkerError::Protocol(sf!(
					"prelude helper declared outside an admitted extension module",
				)));
			},
			None => panic!("loaded tool module was admitted"),
		};
		tool.decl.extension_id = (*extension_id).to_owned();
	}
	let declarations = tools.iter().map(|tool| tool.decl.clone()).collect();
	let prompt_slots = load_prompt_slots(engine, &admitted_modules)?;
	let entry_modules =
		admitted
			.extensions
			.iter()
			.fold(BTreeMap::<Str, Str>::new(), |mut entries, extension| {
				entries
					.entry(Str::from(extension.extension_id.as_str()))
					.or_insert_with(|| Str::from(extension.module.as_str()));
				entries
			});
	let mut seen_extensions = HashSet::new();
	let extensions = admitted
		.extensions
		.into_iter()
		.filter(|extension| seen_extensions.insert(extension.extension_id.clone()))
		.map(|extension| ExtensionDecl {
			extension_id: extension.extension_id,
			version:      extension.rev,
			api_level:    1,
			capabilities: Vec::new(),
			props:        None,
		})
		.collect();
	write_sync_frame(
		&mut writer,
		&WorkerFrame {
			request_id: 0,
			body:       Some(worker_frame::Body::RegisterTools(RegisterTools {
				tools: declarations,
				generation: host_generation,
				extensions,
				slots: prompt_slots.clone(),
				props: Some(ValueMap {
					fields: BTreeMap::from([("omp/registry-snapshot-json".to_owned(), Value {
						kind: Some(value::Kind::String(registry_metadata)),
					})]),
				}),
				..Default::default()
			})),
			props:      None,
		},
		limit,
		&mut write_scratch,
	)?;
	fn dispatch_python_service(
		engine: &omp_py::Engine,
		request_id: u64,
		dispatch: &WireServiceDispatch,
	) -> Result<Vec<u8>, WorkerError> {
		let payload = str::from_utf8(&dispatch.payload)
			.map_err(|_| WorkerError::Protocol(sf!("service payload is not UTF-8 JSON")))?;
		engine
			.attach(|py| -> PyResult<Vec<u8>> {
				let json = PyModule::import(py, "json")?;
				let decoded = json.call_method1("loads", (payload,))?;
				let args = decoded.get_item("args")?;
				let kwargs = decoded.get_item("kwargs")?;
				let registry = PyModule::import(py, "omp._registry")?;
				let awaitable = registry.call_method1(
					"dispatch_service",
					(
						request_id,
						dispatch.service.as_str(),
						dispatch.rev,
						dispatch.method.as_str(),
						args,
						kwargs,
					),
				)?;
				let asyncio = PyModule::import(py, "asyncio")?;
				let result = asyncio.call_method1("run", (awaitable,))?;
				let echoed: u64 = result.get_item(0)?.extract()?;
				if echoed != request_id {
					return Err(PyValueError::new_err("service provider returned stale correlation"));
				}
				let value = result.get_item(1)?;
				let lowered = registry.call_method1("service_json_value", (value,))?;
				let encoded: String = json.call_method1("dumps", (lowered,))?.extract()?;
				Ok(encoded.into_bytes())
			})
			.map_err(WorkerError::from)
	}

	loop {
		let Some(frame) = read_sync_frame::<_, HostFrame>(&mut reader, limit, &mut read_scratch)?
		else {
			return Ok(());
		};
		match frame.body {
			Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
				body: Some(lifecycle_host_envelope::Body::FreezeDeclarations(freeze)),
				..
			})) => {
				if freeze.generation != host_generation
					|| !entry_modules.contains_key(freeze.extension_id.as_str())
				{
					return Err(WorkerError::Protocol(sf!(
						"FreezeDeclarations carries stale extension identity or generation",
					)));
				}
				freeze_python_declarations(engine)?;
			},
			Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
				body: Some(lifecycle_host_envelope::Body::ActivateExtension(activate)),
				..
			})) => {
				let result = activate_python_extension(engine, &entry_modules, &activate);
				let (degraded, error) = match result {
					Ok(()) => (false, None),
					Err(error) => (true, Some(error.to_string())),
				};
				write_sync_frame(
					&mut writer,
					&WorkerFrame {
						request_id: frame.request_id,
						body:       Some(worker_frame::Body::Lifecycle(v1::LifecycleWorkerEnvelope {
							body:  Some(lifecycle_worker_envelope::Body::ExtensionActivated(
								ExtensionActivated {
									extension_id: activate.extension_id,
									generation: activate.generation,
									degraded,
									error,
									props: None,
								},
							)),
							props: None,
						})),
						props:      None,
					},
					limit,
					&mut write_scratch,
				)?;
			},
			Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
				body: Some(lifecycle_host_envelope::Body::ResourceUpdate(update)),
				..
			})) => {
				omp_py::set_resource_receipt(
					update.quotas.into_iter().map(|quota| {
						(
							Str::from(quota.name),
							quota.limit,
							quota.used,
							quota
								.window_ms
								.map(|millis| CoreDuration::new(millis, DurationUnit::Milliseconds)),
						)
					}),
					update
						.dropped
						.into_iter()
						.map(|drop| (Str::from(drop.name), drop.count)),
				);
			},
			Some(host_frame::Body::Lifecycle(LifecycleHostEnvelope {
				body: Some(lifecycle_host_envelope::Body::ServiceDispatch(dispatch)),
				..
			})) => {
				let result = if dispatch.provider_generation != host_generation
					|| dispatch.session_generation != session_generation
					|| !entry_modules.contains_key(dispatch.provider_extension_id.as_str())
				{
					Err(WorkerError::Protocol(sf!(
						"ServiceDispatch carries stale provider identity or generation",
					)))
				} else {
					dispatch_python_service(engine, frame.request_id, &dispatch)
				};
				let (payload, error) = match result {
					Ok(payload) => (payload, None),
					Err(error) => (
						Vec::new(),
						Some(ProtocolError {
							code:    ProtocolErrorCode::Internal.into(),
							message: error.to_string(),
							props:   None,
						}),
					),
				};
				write_sync_frame(
					&mut writer,
					&WorkerFrame {
						request_id: frame.request_id,
						body:       Some(worker_frame::Body::Lifecycle(v1::LifecycleWorkerEnvelope {
							body:  Some(lifecycle_worker_envelope::Body::ServiceResult(ServiceResult {
								caller_request_id: dispatch.caller_request_id,
								provider_generation: dispatch.provider_generation,
								payload: payload.into(),
								error,
								props: None,
							})),
							props: None,
						})),
						props:      None,
					},
					limit,
					&mut write_scratch,
				)?;
			},
			Some(host_frame::Body::Context(ContextHostEnvelope {
				body: Some(context_host_envelope::Body::PromptPull(pull)),
				..
			})) => {
				let owner = prompt_prop(pull.props.as_ref(), PROMPT_OWNER_PROP)
					.ok_or_else(|| WorkerError::Protocol(sf!("PromptPull has no owner")))?;
				let key = prompt_prop(pull.props.as_ref(), PROMPT_KEY_PROP)
					.ok_or_else(|| WorkerError::Protocol(sf!("PromptPull has no declaration key")))?;
				let context = prompt_prop(pull.props.as_ref(), PROMPT_CONTEXT_PROP)
					.ok_or_else(|| WorkerError::Protocol(sf!("PromptPull has no context")))?;
				let declared = prompt_slots.iter().any(|declaration| {
					declaration.slot == pull.slot
						&& prompt_prop(declaration.props.as_ref(), PROMPT_OWNER_PROP) == Some(owner)
						&& prompt_prop(declaration.props.as_ref(), PROMPT_KEY_PROP) == Some(key)
				});
				if !declared {
					return Err(WorkerError::Protocol(sf!(
						"PromptPull names an unregistered declaration",
					)));
				}
				let content = render_python_prompt_slot(engine, key, context)?;
				let props = ValueMap {
					fields: BTreeMap::from([
						(PROMPT_OWNER_PROP.to_owned(), Value {
							kind: Some(value::Kind::String(owner.to_owned())),
						}),
						(PROMPT_KEY_PROP.to_owned(), Value {
							kind: Some(value::Kind::String(key.to_owned())),
						}),
					]),
				};
				write_sync_frame(
					&mut writer,
					&WorkerFrame {
						request_id: frame.request_id,
						body:       Some(worker_frame::Body::Context(ContextWorkerEnvelope {
							body:  Some(context_worker_envelope::Body::PromptContribution(
								PromptContribution {
									slot:      pull.slot,
									parts:     vec![Part { kind: Some(part::Kind::Text(content)) }],
									cache_key: None,
									props:     Some(props),
								},
							)),
							props: None,
						})),
						props:      None,
					},
					limit,
					&mut write_scratch,
				)?;
			},
			Some(host_frame::Body::Regimes(RegimeHostEnvelope { body: Some(body), .. })) => {
				let draft = match body {
					regime_host_envelope::Body::Start(start) => {
						dispatch_python_regime_start(engine, &start)
					},
					regime_host_envelope::Body::Apply(apply) => {
						dispatch_python_regime_apply(engine, &apply)
					},
					regime_host_envelope::Body::Stop(stop) => dispatch_python_regime_stop(engine, &stop),
				};
				match draft {
					Ok(draft) => write_sync_frame(
						&mut writer,
						&WorkerFrame {
							request_id: frame.request_id,
							body:       Some(worker_frame::Body::Regimes(RegimeWorkerEnvelope {
								body:  Some(regime_worker_envelope::Body::Draft(draft)),
								props: None,
							})),
							props:      None,
						},
						limit,
						&mut write_scratch,
					)?,
					Err(error) => write_protocol_error(
						&mut writer,
						frame.request_id,
						ProtocolErrorCode::Internal,
						error.to_string().as_str(),
						limit,
						&mut write_scratch,
					)?,
				}
			},
			Some(host_frame::Body::InvokeTool(invoke)) => {
				let Some(commit_frame) =
					read_sync_frame::<_, HostFrame>(&mut reader, limit, &mut read_scratch)?
				else {
					return Ok(());
				};
				let commit = match commit_frame {
					HostFrame {
						request_id,
						body:
							Some(host_frame::Body::Arguments(ArgumentHostEnvelope {
								body: Some(argument_host_envelope::Body::ArgsCommitted(commit)),
								..
							})),
						..
					} if request_id == frame.request_id
						&& commit.invocation_id == invoke.call_id
						&& commit.raw == invoke.args_json =>
					{
						commit
					},
					_ => {
						write_protocol_error(
							&mut writer,
							frame.request_id,
							ProtocolErrorCode::InvalidArgument,
							"non-streaming InvokeTool must be followed by its exact ArgsCommitted",
							limit,
							&mut write_scratch,
						)?;
						continue;
					},
				};
				debug_assert_eq!(commit.raw, invoke.args_json);
				serve_invocation(
					engine,
					&tools,
					frame.request_id,
					invoke,
					&commit,
					&session_id,
					&principal_id,
					&principal_display,
					host_generation,
					session_generation,
					&mut writer,
					limit,
					&mut write_scratch,
				)?;
			},
			Some(host_frame::Body::Ping(ping)) => write_sync_frame(
				&mut writer,
				&WorkerFrame {
					request_id: frame.request_id,
					body:       Some(worker_frame::Body::Pong(Pong { nonce: ping.nonce, props: None })),
					props:      None,
				},
				limit,
				&mut write_scratch,
			)?,
			Some(host_frame::Body::CancelTool(cancel)) => write_sync_frame(
				&mut writer,
				&WorkerFrame {
					request_id: frame.request_id,
					body:       Some(worker_frame::Body::ToolAborted(ToolAborted {
						call_id:         cancel.call_id,
						reason:          cancel.reason,
						effects_unknown: true,
						props:           None,
					})),
					props:      None,
				},
				limit,
				&mut write_scratch,
			)?,
			Some(_) => write_protocol_error(
				&mut writer,
				frame.request_id,
				ProtocolErrorCode::Unsupported,
				"host frame operation is not supported by the v1 worker",
				limit,
				&mut write_scratch,
			)?,
			None => write_protocol_error(
				&mut writer,
				frame.request_id,
				ProtocolErrorCode::InvalidArgument,
				"host frame has no body",
				limit,
				&mut write_scratch,
			)?,
		}
	}
}

fn dispatch_python_regime_start(
	engine: &omp_py::Engine,
	start: &RegimeStart,
) -> Result<RegimeDraft, WorkerError> {
	engine
		.attach(|py| -> PyResult<()> {
			let regimes = PyModule::import(py, "omp.regimes")?;
			let kwargs = PyDict::new(py);
			kwargs.set_item("regime_revision", start.regime_revision)?;
			kwargs.set_item("state_revision", start.state_revision)?;
			kwargs.set_item("deadline_ms", (start.deadline_ms != 0).then_some(start.deadline_ms))?;
			kwargs.set_item("props", py.None())?;
			let awaitable = regimes.getattr("dispatch_regime_start")?.call(
				(start.regime_id.as_str(), start.activation_id.as_str(), start.state.as_ref()),
				Some(&kwargs),
			)?;
			PyModule::import(py, "asyncio")?.call_method1("run", (awaitable,))?;
			Ok(())
		})
		.map_err(WorkerError::from)?;
	Ok(RegimeDraft {
		activation_id:   start.activation_id.clone(),
		regime_revision: start.regime_revision,
		event_revision:  0,
		control:         None,
		effects:         Vec::new(),
		props:           None,
	})
}

fn dispatch_python_regime_apply(
	engine: &omp_py::Engine,
	apply: &RegimeApply,
) -> Result<RegimeDraft, WorkerError> {
	let point = v1::RegimePoint::try_from(apply.point)
		.map_err(|_| WorkerError::Protocol(sf!("RegimeApply has an invalid point")))?;
	let point = point
		.as_str_name()
		.strip_prefix("REGIME_POINT_")
		.expect("regime point prefix")
		.to_ascii_lowercase();
	engine
		.attach(|py| -> PyResult<RegimeDraft> {
			let regimes = PyModule::import(py, "omp.regimes")?;
			let kwargs = PyDict::new(py);
			kwargs.set_item("activation_id", apply.activation_id.as_str())?;
			kwargs.set_item("regime_revision", apply.regime_revision)?;
			kwargs.set_item("event_revision", apply.event_revision)?;
			kwargs.set_item("committed_steps", apply.committed_steps)?;
			kwargs.set_item("state_revision", apply.state_revision)?;
			kwargs.set_item("deadline_ms", (apply.deadline_ms != 0).then_some(apply.deadline_ms))?;
			kwargs.set_item("limit_handler", apply.limit_handler)?;
			kwargs.set_item("props", py.None())?;
			let awaitable = regimes.getattr("dispatch_regime_apply")?.call(
				(
					apply.regime_id.as_str(),
					point.as_str(),
					apply.event_payload.as_ref(),
					apply.state.as_ref(),
				),
				Some(&kwargs),
			)?;
			let result = PyModule::import(py, "asyncio")?.call_method1("run", (awaitable,))?;
			let activation_id: String = result.get_item("activation_id")?.extract()?;
			let regime_revision: u32 = result.get_item("regime_revision")?.extract()?;
			let event_revision: u32 = result.get_item("event_revision")?.extract()?;
			if activation_id != apply.activation_id
				|| regime_revision != apply.regime_revision
				|| event_revision != apply.event_revision
			{
				return Err(PyValueError::new_err(
					"regime draft correlation does not match the applied activation",
				));
			}
			let control = result.get_item("control")?;
			let control = if control.is_none() {
				None
			} else {
				let control = control.cast::<PyDict>()?;
				let kind: String = control
					.get_item("kind")?
					.ok_or_else(|| PyKeyError::new_err("regime control omitted kind"))?
					.extract()?;
				let kind_name = format!("REGIME_CONTROL_KIND_{}", kind.to_ascii_uppercase());
				let kind = RegimeControlKind::from_str_name(&kind_name)
					.filter(|kind| *kind != RegimeControlKind::Unspecified)
					.ok_or_else(|| PyValueError::new_err("regime draft has an unknown control"))?;
				Some(RegimeControl {
					kind:             kind.into(),
					reason:           optional_string(control, "reason")?,
					wait_ticket:      optional_string(control, "wait_ticket")?,
					wait_deadline_ms: control
						.get_item("wait_deadline_ms")?
						.map(|value| value.extract())
						.transpose()?,
					error:            control
						.get_item("error")?
						.map(|value| value.extract::<Vec<u8>>())
						.transpose()?
						.unwrap_or_default()
						.into(),
					props:            None,
				})
			};
			let effects = result.get_item("effects")?;
			let mut ordered_effects = Vec::new();
			for effect in PyIterator::from_object(&effects)? {
				let effect = effect?;
				let effect = effect.cast::<PyDict>()?;
				let kind: String = effect
					.get_item("kind")?
					.ok_or_else(|| PyKeyError::new_err("regime effect omitted kind"))?
					.extract()?;
				let kind_name = format!("REGIME_EFFECT_KIND_{}", kind.to_ascii_uppercase());
				let kind = RegimeEffectKind::from_str_name(&kind_name)
					.filter(|kind| *kind != RegimeEffectKind::Unspecified)
					.ok_or_else(|| PyValueError::new_err("regime draft has an unknown effect"))?;
				ordered_effects.push(RegimeEffect {
					kind:           kind.into(),
					payload:        effect
						.get_item("payload")?
						.ok_or_else(|| PyKeyError::new_err("regime effect omitted payload"))?
						.extract::<Vec<u8>>()?
						.into(),
					name:           optional_string(effect, "name")?,
					state_revision: effect
						.get_item("state_revision")?
						.map(|value| value.extract())
						.transpose()?,
					props:          None,
				});
			}
			Ok(RegimeDraft {
				activation_id,
				regime_revision,
				event_revision,
				control,
				effects: ordered_effects,
				props: None,
			})
		})
		.map_err(WorkerError::from)
}

fn dispatch_python_regime_stop(
	engine: &omp_py::Engine,
	stop: &RegimeStop,
) -> Result<RegimeDraft, WorkerError> {
	engine
		.attach(|py| -> PyResult<()> {
			let regimes = PyModule::import(py, "omp.regimes")?;
			let kwargs = PyDict::new(py);
			kwargs.set_item("regime_revision", stop.regime_revision)?;
			kwargs.set_item("reason", stop.reason.as_deref())?;
			kwargs.set_item("deadline_ms", (stop.deadline_ms != 0).then_some(stop.deadline_ms))?;
			kwargs.set_item("props", py.None())?;
			let awaitable = regimes
				.getattr("dispatch_regime_stop")?
				.call((stop.regime_id.as_str(), stop.activation_id.as_str()), Some(&kwargs))?;
			PyModule::import(py, "asyncio")?.call_method1("run", (awaitable,))?;
			Ok(())
		})
		.map_err(WorkerError::from)?;
	Ok(RegimeDraft {
		activation_id:   stop.activation_id.clone(),
		regime_revision: stop.regime_revision,
		event_revision:  0,
		control:         None,
		effects:         Vec::new(),
		props:           None,
	})
}

fn freeze_python_declarations(engine: &omp_py::Engine) -> Result<(), WorkerError> {
	engine
		.attach(|py| -> PyResult<()> {
			let registry = PyModule::import(py, "omp._registry")?;
			if !registry
				.getattr("registry")?
				.getattr("sealed")?
				.extract::<bool>()?
			{
				registry.getattr("freeze_declarations")?.call0()?;
			}
			Ok(())
		})
		.map_err(WorkerError::from)
}

fn activate_python_extension(
	engine: &omp_py::Engine,
	entry_modules: &BTreeMap<Str, Str>,
	activate: &ActivateExtension,
) -> Result<(), WorkerError> {
	if activate.generation == 0 {
		return Err(WorkerError::Protocol(sf!("ActivateExtension generation must be nonzero",)));
	}
	let module = entry_modules
		.get(activate.extension_id.as_str())
		.ok_or_else(|| WorkerError::Protocol(sf!("ActivateExtension is not admitted")))?
		.clone();
	engine
		.attach(|py| -> PyResult<()> {
			let extension = PyModule::import(py, module.as_str())?;
			let Ok(callback) = extension.getattr("extension_activate") else {
				return Ok(());
			};
			let payload = PyDict::new(py);
			payload.set_item("reason", activate.reason)?;
			payload.set_item("restart_reason", activate.restart_reason)?;
			payload.set_item("session_started_at_ms", activate.session_started_at_ms)?;
			payload.set_item("generation", activate.generation)?;
			let cli_values = PyDict::new(py);
			for value in &activate.cli_values {
				match value.value.as_ref() {
					Some(activation_cli_value::Value::Boolean(inner)) => {
						cli_values.set_item(value.sink.as_str(), *inner)?;
					},
					Some(activation_cli_value::Value::String(inner)) => {
						cli_values.set_item(value.sink.as_str(), inner.as_str())?;
					},
					None => {},
				}
			}
			payload.set_item("cli_values", cli_values)?;
			let context = PyDict::new(py);
			if let Some(principal) = &activate.principal {
				let identity = PyDict::new(py);
				identity.set_item("id", principal.id.as_str())?;
				identity.set_item("display", principal.display.as_str())?;
				context.set_item("principal", identity)?;
			}
			let result = callback.call1((payload, context))?;
			if result.hasattr("__await__")? {
				PyModule::import(py, "asyncio")?
					.getattr("run")?
					.call1((result,))?;
			}
			Ok(())
		})
		.map_err(WorkerError::from)
}
fn required_env(name: &'static str) -> Result<String, WorkerError> {
	env::var(name).map_err(|_| {
		WorkerError::Protocol(Str::from(format!(
			"worker process is missing required identity variable {name}",
		)))
	})
}

fn required_env_u64(name: &'static str) -> Result<u64, WorkerError> {
	required_env(name)?
		.parse()
		.map_err(|_| WorkerError::Protocol(Str::from(format!("{name} is not an unsigned integer"))))
}
#[derive(Clone, Copy, Debug, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
enum PythonPreludeParamKind {
	PositionalOrKeyword,
	KeywordOnly,
}

impl From<PythonPreludeParamKind> for PreludeParamKind {
	fn from(value: PythonPreludeParamKind) -> Self {
		match value {
			PythonPreludeParamKind::PositionalOrKeyword => Self::PositionalOrKeyword,
			PythonPreludeParamKind::KeywordOnly => Self::KeywordOnly,
		}
	}
}

enum PythonToolKind {
	Legacy,
	Contextual { place: String },
	Prelude,
}

struct PythonTool {
	decl:    ToolDecl,
	handler: Py<PyAny>,
	kind:    PythonToolKind,
}

fn configured_modules() -> Vec<Str> {
	env::var("OMP_PY_MODULES")
		.unwrap_or_default()
		.split(',')
		.map(str::trim)
		.filter(|module| !module.is_empty())
		.map(Str::from)
		.collect()
}

fn load_tools(
	engine: &omp_py::Engine,
	modules: &[Str],
) -> Result<(Vec<PythonTool>, String), WorkerError> {
	engine
		.attach(|py| -> PyResult<(Vec<PythonTool>, String)> {
			let json = PyModule::import(py, "json")?;
			let registry = PyModule::import(py, "omp._registry")?;
			for module_name in modules {
				let module = PyModule::import(py, module_name.as_str())?;
				if let Ok(declarations) = module.getattr("OMP_TOOLS") {
					for declaration in PyIterator::from_object(&declarations)? {
						registry.call_method1("register_legacy_worker_tool", (declaration?,))?;
					}
				}
			}
			registry.call_method0("freeze_declarations")?;
			let projection = registry.call_method0("project_worker_registry")?;
			let rows = projection.get_item(0)?;
			let metadata: String = projection.get_item(1)?.extract()?;
			let mut tools = Vec::new();
			let mut identities = HashSet::new();
			for row in PyIterator::from_object(&rows)? {
				let row = row?;
				let name: String = row.getattr("name")?.extract()?;
				let family: String = row.getattr("family")?.extract()?;
				let number: u16 = row.getattr("rev")?.extract()?;
				let rev = if family.is_empty() {
					number.to_string()
				} else {
					format!("{family}.{number}")
				};
				if !identities.insert((name.clone(), rev.clone())) {
					return Err(PyKeyError::new_err(format!(
						"duplicate Python tool identity: {name}@{rev}",
					)));
				}
				let schema = row.getattr("schema")?;
				let schema_json = if schema.is_instance_of::<PyString>() {
					Bytes::from(schema.extract::<String>()?)
				} else {
					Bytes::from(
						json
							.call_method1("dumps", (&schema,))?
							.extract::<String>()?,
					)
				};
				let handler = row.getattr("handler")?;
				if !handler.is_callable() {
					return Err(PyTypeError::new_err(format!(
						"Python tool {name} handler is not callable",
					)));
				}
				let kind = if row.getattr("legacy")?.extract()? {
					PythonToolKind::Legacy
				} else {
					PythonToolKind::Contextual { place: row.getattr("place")?.extract()? }
				};
				let effects = row.getattr("effects")?;
				let effects = if effects.is_none() {
					None
				} else {
					let mapping =
						PyModule::import(py, "dataclasses")?.call_method1("asdict", (&effects,))?;
					let encoded: String = json.call_method1("dumps", (mapping,))?.extract()?;
					let effects: omp_tool::Effects =
						serde_json::from_str(&encoded).map_err(|error| {
							PyValueError::new_err(format!(
								"Python tool {name} effects are invalid: {error}",
							))
						})?;
					Some(omp_proto::policy::v1::EffectEnvelope::from(&effects))
				};
				let constraint = python_tool_constraint(&row)?;
				let kind_name: String = row.getattr("kind")?.extract()?;
				let place: String = row.getattr("place")?.extract()?;
				let execution_mode = if row.getattr("serial")?.extract::<bool>()? {
					v1::ToolExecutionMode::Sequential
				} else {
					v1::ToolExecutionMode::Parallel
				};
				tools.push(PythonTool {
					decl: ToolDecl {
						definition: Some(ToolDef {
							name,
							description: row.getattr("description")?.extract()?,
							input: Some(tool_def::Input::JsonSchema(tool_def::JsonSchema {
								schema_json,
								strict: row.getattr("strict")?.extract()?,
							})),
						}),
						rev,
						constraint,
						extension_id: row.getattr("source_module")?.extract()?,
						streams_args: row.getattr("streams_args")?.extract()?,
						effects,
						kind: kind_name,
						execution_mode: execution_mode as i32,
						props: None,
						place,
						..Default::default()
					},
					handler: handler.unbind(),
					kind,
				});
			}
			Ok((tools, metadata))
		})
		.map_err(WorkerError::from)
}

fn python_tool_constraint(row: &Bound<'_, PyAny>) -> PyResult<Option<v1::ToolConstraint>> {
	let constraint = row.getattr("constraint")?;
	if constraint.is_none() {
		return Ok(None);
	}
	let priority: u32 = constraint.getattr("priority")?.extract()?;
	let fallback: String = constraint.getattr("on_unsupported")?.extract()?;
	let on_unsupported = match fallback.as_str() {
		"unspecified" => omp_proto::inference::v1::Fallback::Unspecified,
		"error" => omp_proto::inference::v1::Fallback::Error,
		"drop" => omp_proto::inference::v1::Fallback::Ignore,
		_ => return Err(PyValueError::new_err("unknown tool constraint fallback")),
	};
	let kind: String = constraint.getattr("kind")?.extract()?;
	let kind = match kind.as_str() {
		"schema" => v1::tool_constraint::Kind::Schema(v1::SchemaConstraint {
			priority,
			on_unsupported: on_unsupported as i32,
		}),
		"grammar" => {
			let syntax: String = constraint.getattr("syntax")?.extract()?;
			let syntax = match syntax.as_str() {
				"lark" => v1::GrammarSyntax::Lark,
				"regex" => v1::GrammarSyntax::Regex,
				"ebnf" => v1::GrammarSyntax::Ebnf,
				"gbnf" => v1::GrammarSyntax::Gbnf,
				_ => return Err(PyValueError::new_err("unknown tool constraint grammar syntax")),
			};
			v1::tool_constraint::Kind::Grammar(v1::GrammarConstraint {
				syntax: syntax as i32,
				definition: constraint.getattr("definition")?.extract()?,
				priority,
				on_unsupported: on_unsupported as i32,
			})
		},
		_ => return Err(PyValueError::new_err("unknown tool constraint kind")),
	};
	Ok(Some(v1::ToolConstraint { kind: Some(kind) }))
}

fn load_prelude(engine: &omp_py::Engine, _modules: &[Str]) -> Result<Vec<PythonTool>, WorkerError> {
	engine
		.attach(|py| -> PyResult<Vec<PythonTool>> {
			let registry = match PyModule::import(py, "omp._registry") {
				Ok(registry) => registry,
				Err(error) if error.is_instance_of::<PyImportError>(py) => return Ok(Vec::new()),
				Err(error) => return Err(error),
			};
			let definitions = registry
				.getattr(intern!(py, "prelude_definitions"))?
				.call0()?;
			let json = PyModule::import(py, "json")?;
			let mut tools = Vec::new();
			for definition in PyIterator::from_object(&definitions)? {
				let definition = definition?;
				let name = definition.getattr(intern!(py, "name"))?;
				let name = name.cast::<PyString>()?;
				let properties = PyDict::new(py);
				let required = PyList::empty(py);
				let mut params = Vec::new();
				for param in PyIterator::from_object(&definition.getattr(intern!(py, "params"))?)? {
					let param = param?;
					let param_name = param.getattr(intern!(py, "name"))?;
					let param_name = param_name.cast::<PyString>()?;
					properties.set_item(param_name, PyDict::new(py))?;

					let default = param.getattr(intern!(py, "default_json"))?;
					let default_json = if default.is_none() {
						required.append(param_name)?;
						None
					} else {
						Some(Bytes::copy_from_slice(default.cast::<PyString>()?.to_str()?.as_bytes()))
					};
					let kind = param.getattr(intern!(py, "kind"))?;
					let kind = kind.cast::<PyString>()?;
					let kind_name = kind.to_str()?;
					let kind = kind_name
						.parse::<PythonPreludeParamKind>()
						.map(PreludeParamKind::from)
						.map_err(|_| {
							PyValueError::new_err(format!("unknown prelude parameter kind: {kind_name}",))
						})?;
					let annotation = param.getattr(intern!(py, "annotation"))?;
					let annotation = if annotation.is_none() {
						None
					} else {
						Some(annotation.cast::<PyString>()?.to_str()?.to_owned())
					};
					params.push(PreludeParam {
						name: param_name.to_str()?.to_owned(),
						kind: kind as i32,
						default_json,
						annotation,
						props: None,
					});
				}
				let schema = PyDict::new(py);
				schema.set_item("type", "object")?;
				schema.set_item("properties", properties)?;
				schema.set_item("required", required)?;
				schema.set_item("additionalProperties", false)?;
				let schema_json = Bytes::from(
					json
						.call_method1(intern!(py, "dumps"), (&schema,))?
						.extract::<String>()?,
				);
				let handler = definition.getattr(intern!(py, "handler"))?;
				if !handler.is_callable() {
					return Err(PyTypeError::new_err(format!(
						"Python prelude helper {} handler is not callable",
						name.to_str()?,
					)));
				}
				let summary = definition
					.getattr(intern!(py, "summary"))?
					.cast::<PyString>()?
					.to_str()?
					.to_owned();
				let rev: u16 = definition.getattr(intern!(py, "rev"))?.extract()?;
				tools.push(PythonTool {
					decl:    ToolDecl {
						definition: Some(ToolDef {
							name:        name.to_str()?.to_owned(),
							description: summary.clone(),
							input:       Some(tool_def::Input::JsonSchema(tool_def::JsonSchema {
								schema_json,
								strict: Some(true),
							})),
						}),
						rev: format!("prelude.{rev}"),
						extension_id: definition
							.getattr(intern!(py, "module"))?
							.cast::<PyString>()?
							.to_str()?
							.to_owned(),
						summary,
						docs: definition
							.getattr(intern!(py, "doc"))?
							.cast::<PyString>()?
							.to_str()?
							.to_owned(),
						prelude_params: params,
						..Default::default()
					},
					handler: handler.unbind(),
					kind:    PythonToolKind::Prelude,
				});
			}
			Ok(tools)
		})
		.map_err(WorkerError::from)
}

fn serve_invocation<W: Write>(
	engine: &omp_py::Engine,
	tools: &[PythonTool],
	request_id: u64,
	invoke: InvokeTool,
	commit: &ArgsCommitted,
	session_id: &str,
	principal_id: &str,
	principal_display: &str,
	host_generation: u64,
	session_generation: u64,
	writer: &mut W,
	limit: NonZeroUsize,
	scratch: &mut BytesMut,
) -> Result<(), WorkerError> {
	let Some(tool) = tools.iter().find(|tool| {
		tool
			.decl
			.definition
			.as_ref()
			.is_some_and(|definition| definition.name == invoke.name)
			&& tool.decl.rev == invoke.rev
	}) else {
		return write_protocol_error(
			writer,
			request_id,
			ProtocolErrorCode::NotFound,
			"Python tool name/revision is not registered",
			limit,
			scratch,
		);
	};
	let call_id = invoke.call_id.clone();
	let argument_issue = python_argument_issue(tool, &invoke.args_json);
	let result = if let Some(issue) = argument_issue {
		Ok(PythonCompletion {
			parts:        Vec::new(),
			details_json: Bytes::from_static(b"null"),
			kind:         OutcomeKind::ArgsRejected,
			args_issue:   Some(issue),
			terminate:    false,
		})
	} else {
		engine.attach(|py| -> Result<PythonCompletion, WorkerError> {
			let json = PyModule::import(py, "json")?;
			let args = str::from_utf8(invoke.args_json.as_ref())
				.map_err(|_| WorkerError::Python(sf!("committed args are not UTF-8")))?;
			let params = json.getattr("loads")?.call1((args,))?;
			let authority = PyDict::new(py);
			if env::var_os(ENV_SOCKET_ENV).is_some() && commit.effects.is_some() {
				let data = PyDict::new(py);
				data.set_item("invocation", commit.invocation_id.as_str())?;
				data.set_item("effect_token", PyBytes::new(py, commit.effect_token.as_ref()))?;
				data.set_item("host_generation", host_generation)?;
				data.set_item("session_generation", session_generation)?;
				data.set_item("pty_denied", false)?;
				authority.set_item("data", data)?;
			}
			let environment = PyModule::import(py, "omp.env")?;
			let invoke_with_environment = environment.getattr("_invoke_with_environment")?;
			let pending_updates = PyList::empty(py);
			let scope_module = PyModule::import(py, "omp._scope")?;
			let scope_kwargs = PyDict::new(py);
			scope_kwargs.set_item("invocation", invoke.call_id.as_str())?;
			scope_kwargs.set_item("generation", host_generation)?;
			scope_kwargs.set_item(
				"principal",
				omp_py::bind_principal(
					py,
					Principal::new(Str::from(principal_id), Str::from(principal_display)),
				)?,
			)?;
			scope_kwargs.set_item(
				"phase",
				scope_module
					.getattr("InvocationPhase")?
					.getattr("EFFECTS_AUTHORIZED")?,
			)?;
			scope_kwargs.set_item("extension", tool.decl.extension_id.as_str())?;
			scope_kwargs.set_item("session", session_id)?;
			scope_kwargs.set_item("call", invoke.call_id.as_str())?;
			scope_kwargs.set_item("device", invoke.name.as_str())?;
			scope_kwargs.set_item("place_kind", match &tool.kind {
				PythonToolKind::Contextual { place } => place.as_str(),
				PythonToolKind::Legacy | PythonToolKind::Prelude => "host",
			})?;
			let scope = scope_module
				.getattr("Scope")?
				.call((), Some(&scope_kwargs))?;
			let coroutine =
				match &tool.kind {
					PythonToolKind::Legacy | PythonToolKind::Prelude => invoke_with_environment
						.call1((&authority, tool.handler.bind(py), &params, py.None(), false))?,
					PythonToolKind::Contextual { place } => {
						let omp = PyModule::import(py, "omp")?;
						let kwargs = PyDict::new(py);
						kwargs.set_item("extension", tool.decl.extension_id.as_str())?;
						kwargs.set_item("session", session_id)?;
						kwargs.set_item("invocation", invoke.call_id.as_str())?;
						kwargs.set_item(
							"principal",
							omp_py::bind_principal(
								py,
								Principal::new(Str::from(principal_id), Str::from(principal_display)),
							)?,
						)?;
						kwargs.set_item("generation", host_generation)?;
						kwargs.set_item("call", invoke.call_id.as_str())?;
						kwargs.set_item("device", invoke.name.as_str())?;
						kwargs.set_item("_update_sink", pending_updates.getattr("append")?)?;
						kwargs.set_item(
							"place",
							omp.getattr("Place")?
								.call_method1("parse", (place.as_str(),))?,
						)?;
						let context = omp.getattr("Context")?.call((), Some(&kwargs))?;
						invoke_with_environment.call1((
							&authority,
							tool.handler.bind(py),
							&params,
							context,
							true,
						))?
					},
				};
			let asyncio_run = PyModule::import(py, "asyncio")?.getattr("run")?;
			let scope_token = scope_module.getattr("install")?.call1((&scope,))?;
			let value = asyncio_run.call1((coroutine,));
			scope_module.getattr("reset")?.call1((scope_token,))?;
			let value = value?;
			for update in pending_updates.iter() {
				write_update(writer, request_id, &call_id, &json, &update, limit, scratch)?;
			}
			if matches!(&tool.kind, PythonToolKind::Prelude) {
				let details_json = Bytes::from(
					json
						.call_method1(intern!(py, "dumps"), (&value,))?
						.extract::<String>()?,
				);
				return Ok(PythonCompletion {
					parts: Vec::new(),
					details_json,
					kind: OutcomeKind::Ok,
					args_issue: None,
					terminate: false,
				});
			}
			if let Ok(dict) = value.cast::<PyDict>() {
				if let Some(updates) = dict.get_item("updates")? {
					for update in PyIterator::from_object(&updates)? {
						write_update(writer, request_id, &call_id, &json, &update?, limit, scratch)?;
					}
				}
				return completion_from_dict(dict, &json);
			}
			if let Ok(iterator) = PyIterator::from_object(&value)
				&& iterator.as_any().is(&value)
			{
				for item in iterator {
					let item = item?;
					if let Ok(dict) = item.cast::<PyDict>()
						&& let Some(complete) = dict.get_item("complete")?
					{
						let complete = complete.cast::<PyDict>().map_err(|_| {
							PyTypeError::new_err("generator complete value must be a dictionary")
						})?;
						return completion_from_dict(complete, &json);
					}
					let update = if let Ok(dict) = item.cast::<PyDict>() {
						dict.get_item("update")?.unwrap_or_else(|| item.clone())
					} else {
						item
					};
					write_update(writer, request_id, &call_id, &json, &update, limit, scratch)?;
				}
				return Ok(PythonCompletion {
					parts:        Vec::new(),
					details_json: Bytes::from_static(b"null"),
					kind:         OutcomeKind::Ok,
					args_issue:   None,
					terminate:    false,
				});
			}
			let details_json = Bytes::from(
				json
					.getattr("dumps")?
					.call1((&value,))?
					.extract::<String>()?,
			);
			let text = value.str()?.to_string_lossy().into_owned();
			Ok(PythonCompletion {
				parts: vec![text_part(text)],
				details_json,
				kind: OutcomeKind::Ok,
				args_issue: None,
				terminate: false,
			})
		})
	};
	let completion = match result {
		Ok(completion) => completion,
		Err(error) => PythonCompletion {
			parts:        vec![text_part(error.to_string())],
			details_json: Bytes::from(
				serde_json::to_vec(&serde_json::json!({
					"kind": "effects_unknown",
					"reason": error.to_string(),
				}))
				.expect("serializing a string abort cannot fail"),
			),
			kind:         OutcomeKind::Aborted,
			args_issue:   None,
			terminate:    false,
		},
	};
	let PythonCompletion { parts, details_json, kind, args_issue, terminate } = completion;
	let body = if let Some(issue) = args_issue {
		worker_frame::Body::Arguments(ArgumentWorkerEnvelope {
			body:  Some(argument_worker_envelope::Body::ToolArgs(ToolArgs {
				call_id,
				issue: Some(issue),
				props: None,
			})),
			props: None,
		})
	} else {
		worker_frame::Body::ToolComplete(ToolComplete {
			call_id,
			parts,
			details_json,
			is_error: matches!(kind, OutcomeKind::Faulted),
			kind: kind.into(),
			terminate: terminate.then_some(true),
			props: None,
			..Default::default()
		})
	};
	write_sync_frame(
		writer,
		&WorkerFrame { request_id, body: Some(body), props: None },
		limit,
		scratch,
	)
}

struct PythonCompletion {
	parts:        Vec<Part>,
	details_json: Bytes,
	kind:         OutcomeKind,
	args_issue:   Option<ArgIssue>,
	terminate:    bool,
}

fn python_argument_issue(tool: &PythonTool, args_json: &[u8]) -> Option<ArgIssue> {
	let schema = tool
		.decl
		.definition
		.as_ref()
		.and_then(|definition| definition.input.as_ref())
		.and_then(|input| match input {
			tool_def::Input::JsonSchema(schema) => Some(schema),
			tool_def::Input::Grammar(_) => None,
		})?;
	schema_argument_issue(&schema.schema_json, args_json)
}

fn schema_argument_issue(schema_json: &[u8], args_json: &[u8]) -> Option<ArgIssue> {
	let arguments = match serde_json::from_slice::<serde_json::Value>(args_json) {
		Ok(serde_json::Value::Object(arguments)) => serde_json::Value::Object(arguments),
		Ok(value) => {
			return Some(ArgIssue {
				expected: "an argument object".into(),
				kind: "type_mismatch".into(),
				found: Some(json_value_kind(&value).into()),
				..ArgIssue::default()
			});
		},
		Err(_) => {
			return Some(ArgIssue {
				expected: "one complete JSON argument object".into(),
				kind: "malformed".into(),
				..ArgIssue::default()
			});
		},
	};
	let schema_value = serde_json::from_slice::<serde_json::Value>(schema_json).ok()?;
	let violation =
		validate_schema(&schema_value, &arguments, false, ToolAssemblyLimits::default()).err()?;
	let expected = if violation.rule == "required" {
		"required parameter".into()
	} else if violation.rule == "additionalProperties" {
		"no additional properties".into()
	} else if violation.rule == "type" && !violation.expected_types.is_empty() {
		violation
			.expected_types
			.iter()
			.map(Str::as_str)
			.collect::<Vec<_>>()
			.join(" or ")
	} else {
		format!("arguments matching the declared schema ({})", violation.rule)
	};
	Some(ArgIssue {
		path: json_pointer_path(&violation.path),
		expected,
		kind: if violation.rule == "required" {
			"missing".into()
		} else if violation.rule == "type" {
			"type_mismatch".into()
		} else {
			"malformed".into()
		},
		found: (violation.rule == "additionalProperties").then(|| "additional property".into()),
		..ArgIssue::default()
	})
}

fn json_pointer_path(pointer: &str) -> Vec<String> {
	pointer
		.strip_prefix('/')
		.filter(|path| !path.is_empty())
		.into_iter()
		.flat_map(|path| path.split('/'))
		.map(|segment| segment.replace("~1", "/").replace("~0", "~"))
		.collect()
}

const fn json_value_kind(value: &serde_json::Value) -> &'static str {
	match value {
		serde_json::Value::Null => "null",
		serde_json::Value::Bool(_) => "boolean",
		serde_json::Value::Number(_) => "number",
		serde_json::Value::String(_) => "string",
		serde_json::Value::Array(_) => "array",
		serde_json::Value::Object(_) => "object",
	}
}

fn completion_from_dict(
	dict: &Bound<'_, PyDict>,
	json: &Bound<'_, PyModule>,
) -> Result<PythonCompletion, WorkerError> {
	let parts = match dict.get_item("parts")? {
		Some(parts) => PyIterator::from_object(&parts)?
			.map(|part| {
				part
					.and_then(|part| part.extract::<String>())
					.map(text_part)
			})
			.collect::<PyResult<Vec<_>>>()?,
		None => Vec::new(),
	};
	let details_json = match dict.get_item("details")? {
		Some(details) => {
			let options = PyDict::new(dict.py());
			options.set_item("separators", (",", ":"))?;
			Bytes::from(
				json
					.getattr("dumps")?
					.call((&details,), Some(&options))?
					.extract::<String>()?,
			)
		},
		None => Bytes::from_static(b"null"),
	};
	let args_issue = dict
		.get_item("args_issue")?
		.map(|issue| {
			let issue = issue
				.cast::<PyDict>()
				.map_err(|_| WorkerError::Python(sf!("args_issue must be a dictionary")))?;
			python_arg_issue(issue)
		})
		.transpose()?;
	let kind = if args_issue.is_some() {
		OutcomeKind::ArgsRejected
	} else if dict
		.get_item("is_error")?
		.map(|value| value.extract::<bool>())
		.transpose()?
		.unwrap_or(false)
	{
		OutcomeKind::Faulted
	} else {
		OutcomeKind::Ok
	};
	let terminate = dict
		.get_item("terminate")?
		.map(|value| value.extract::<bool>())
		.transpose()?
		.unwrap_or(false);
	Ok(PythonCompletion { parts, details_json, kind, args_issue, terminate })
}

fn optional_string(dict: &Bound<'_, PyDict>, key: &str) -> PyResult<Option<String>> {
	dict.get_item(key)?.map(|value| value.extract()).transpose()
}

fn python_arg_issue(dict: &Bound<'_, PyDict>) -> Result<ArgIssue, WorkerError> {
	let path = match dict.get_item("path")? {
		Some(path) => PyIterator::from_object(&path)?
			.map(|segment| segment.and_then(|segment| segment.extract::<String>()))
			.collect::<PyResult<Vec<_>>>()?,
		None => Vec::new(),
	};
	Ok(ArgIssue {
		path,
		expected: optional_string(dict, "expected")?.unwrap_or_default(),
		kind: optional_string(dict, "kind")?.unwrap_or_else(|| "protocol".into()),
		example: optional_string(dict, "example")?,
		found: optional_string(dict, "found")?,
		props: None,
	})
}

fn write_update<W: Write>(
	writer: &mut W,
	request_id: u64,
	call_id: &str,
	json: &Bound<'_, PyModule>,
	update: &Bound<'_, PyAny>,
	limit: NonZeroUsize,
	scratch: &mut BytesMut,
) -> Result<(), WorkerError> {
	let bytes = Bytes::from(
		json
			.getattr("dumps")?
			.call1((update,))?
			.extract::<String>()?,
	);
	write_sync_frame(
		writer,
		&WorkerFrame {
			request_id,
			body: Some(worker_frame::Body::ToolUpdate(ToolUpdate {
				call_id: call_id.to_owned(),
				json:    bytes,
				props:   None,
			})),
			props: None,
		},
		limit,
		scratch,
	)
}

const fn text_part(text: String) -> Part {
	Part { kind: Some(part::Kind::Text(text)) }
}

fn write_protocol_error<W: Write>(
	writer: &mut W,
	request_id: u64,
	code: ProtocolErrorCode,
	message: &str,
	limit: NonZeroUsize,
	scratch: &mut BytesMut,
) -> Result<(), WorkerError> {
	write_sync_frame(
		writer,
		&WorkerFrame {
			request_id,
			body: Some(worker_frame::Body::Error(ProtocolError {
				code:    code as i32,
				message: message.to_owned(),
				props:   None,
			})),
			props: None,
		},
		limit,
		scratch,
	)
}

trait BoundedFrame: Message + Default {
	fn validate_raw(bytes: &[u8]) -> Result<(), omp_proto::bounds::FrameBoundsError>;
}

impl BoundedFrame for HostFrame {
	fn validate_raw(bytes: &[u8]) -> Result<(), omp_proto::bounds::FrameBoundsError> {
		omp_proto::bounds::validate_host_frame(bytes)
	}
}

impl BoundedFrame for WorkerFrame {
	fn validate_raw(bytes: &[u8]) -> Result<(), omp_proto::bounds::FrameBoundsError> {
		omp_proto::bounds::validate_worker_frame(bytes)
	}
}

async fn read_async_frame<R, M>(
	reader: &mut R,
	limit: NonZeroUsize,
	scratch: &mut BytesMut,
) -> Result<Option<M>, WorkerError>
where
	R: AsyncRead + Unpin,
	M: BoundedFrame,
{
	let Some(length) = read_async_length(reader).await? else {
		return Ok(None);
	};
	check_length(length, limit)?;
	scratch.clear();
	scratch.resize(length, 0);
	reader.read_exact(scratch).await?;
	M::validate_raw(&scratch[..length])?;
	Ok(Some(M::decode(&scratch[..length])?))
}

async fn write_async_frame<W, M>(
	writer: &mut W,
	frame: &M,
	limit: NonZeroUsize,
	scratch: &mut BytesMut,
) -> Result<(), WorkerError>
where
	W: AsyncWrite + Unpin,
	M: Message,
{
	let length = frame.encoded_len();
	check_length(length, limit)?;
	scratch.clear();
	scratch.reserve(length + encoded_varint_len(length));
	frame.encode_length_delimited(&mut *scratch)?;
	writer.write_all(scratch).await?;
	writer.flush().await?;
	Ok(())
}

fn read_sync_frame<R, M>(
	reader: &mut R,
	limit: NonZeroUsize,
	scratch: &mut BytesMut,
) -> Result<Option<M>, WorkerError>
where
	R: Read,
	M: BoundedFrame,
{
	let Some(length) = read_sync_length(reader)? else {
		return Ok(None);
	};
	check_length(length, limit)?;
	scratch.clear();
	scratch.resize(length, 0);
	reader.read_exact(scratch)?;
	M::validate_raw(&scratch[..length])?;
	Ok(Some(M::decode(&scratch[..length])?))
}

fn write_sync_frame<W, M>(
	writer: &mut W,
	frame: &M,
	limit: NonZeroUsize,
	scratch: &mut BytesMut,
) -> Result<(), WorkerError>
where
	W: Write,
	M: Message,
{
	let length = frame.encoded_len();
	check_length(length, limit)?;
	scratch.clear();
	scratch.reserve(length + encoded_varint_len(length));
	frame.encode_length_delimited(&mut *scratch)?;
	writer.write_all(scratch)?;
	writer.flush()?;
	Ok(())
}

async fn read_async_length<R: AsyncRead + Unpin>(
	reader: &mut R,
) -> Result<Option<usize>, WorkerError> {
	let mut value = 0_u64;
	for shift in (0..70).step_by(7) {
		let mut byte = [0_u8; 1];
		match reader.read_exact(&mut byte).await {
			Ok(_) => {},
			Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && shift == 0 => {
				return Ok(None);
			},
			Err(error) => return Err(error.into()),
		}
		let part = u64::from(byte[0] & 0x7f);
		if shift == 63 && part > 1 {
			return Err(WorkerError::InvalidLength);
		}
		value |= part << shift;
		if byte[0] & 0x80 == 0 {
			return usize::try_from(value)
				.map(Some)
				.map_err(|_| WorkerError::InvalidLength);
		}
	}
	Err(WorkerError::InvalidLength)
}

fn read_sync_length<R: Read>(reader: &mut R) -> Result<Option<usize>, WorkerError> {
	let mut value = 0_u64;
	for shift in (0..70).step_by(7) {
		let mut byte = [0_u8; 1];
		match reader.read_exact(&mut byte) {
			Ok(()) => {},
			Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && shift == 0 => {
				return Ok(None);
			},
			Err(error) => return Err(error.into()),
		}
		let part = u64::from(byte[0] & 0x7f);
		if shift == 63 && part > 1 {
			return Err(WorkerError::InvalidLength);
		}
		value |= part << shift;
		if byte[0] & 0x80 == 0 {
			return usize::try_from(value)
				.map(Some)
				.map_err(|_| WorkerError::InvalidLength);
		}
	}
	Err(WorkerError::InvalidLength)
}

const fn check_length(length: usize, limit: NonZeroUsize) -> Result<(), WorkerError> {
	let limit = if limit.get() < omp_proto::bounds::FRAME_MAX_BYTES {
		limit.get()
	} else {
		omp_proto::bounds::FRAME_MAX_BYTES
	};
	if length > limit {
		Err(WorkerError::FrameTooLarge { actual: length, limit })
	} else {
		Ok(())
	}
}

const fn encoded_varint_len(mut value: usize) -> usize {
	let mut length = 1;
	while value >= 0x80 {
		value >>= 7;
		length += 1;
	}
	length
}
#[cfg(test)]
mod tests {
	use pyo3::ffi::c_str;

	use super::*;
	use crate::tools::python_engine;

	#[test]
	fn mcp_hook_filter_verification_is_byte_exact() {
		let filter = omp_ext::config::HookDeclarationFilter {
			servers:      vec![sf!("github"), sf!("linear")].into_boxed_slice(),
			method_globs: vec![sf!("notifications/*"), sf!("acme/*")].into_boxed_slice(),
		};
		let exact = RegisteredHookWhen {
			provider:     None,
			server:       Some(vec![sf!("github"), sf!("linear")]),
			method_globs: vec![sf!("notifications/*"), sf!("acme/*")],
		};
		assert!(hook_when_matches_filter(Some(&exact), &filter));
		let reordered =
			RegisteredHookWhen { server: Some(vec![sf!("linear"), sf!("github")]), ..exact.clone() };
		assert!(!hook_when_matches_filter(Some(&reordered), &filter));
		assert!(!hook_when_matches_filter(None, &filter));
	}

	#[test]
	fn python_argument_validation_returns_typed_issues() {
		let schema = br#"{
			"type":"object",
			"properties":{"i":{"type":"string"},"count":{"type":"integer"}},
			"required":["i","count"],
			"additionalProperties":false
		}"#;
		let missing = schema_argument_issue(schema, br#"{"count":3}"#)
			.expect("missing required parameter must be rejected");
		assert_eq!(missing.path, ["i"]);
		assert_eq!(missing.kind, "missing");

		let mistyped = schema_argument_issue(schema, br#"{"i":"x","count":"three"}"#)
			.expect("wrong scalar type must be rejected after charitable repair is exhausted");
		assert_eq!(mistyped.path, ["count"]);
		assert_eq!(mistyped.kind, "type_mismatch");
		assert_eq!(mistyped.expected, "integer");

		let malformed = schema_argument_issue(schema, br#"{"i":"x""#)
			.expect("truncated document must be rejected");
		assert!(malformed.path.is_empty());
		assert_eq!(malformed.kind, "malformed");

		let additional = schema_argument_issue(schema, br#"{"i":"x","count":3,"extra":true}"#)
			.expect("closed schema must reject an unknown member");
		assert_eq!(additional.path, ["extra"]);
		assert_eq!(additional.kind, "malformed");
		assert_eq!(additional.expected, "no additional properties");
		assert_eq!(additional.found.as_deref(), Some("additional property"));
	}

	#[test]
	fn python_argument_validation_checks_nested_required_properties() {
		let schema = br#"{
			"type":"object",
			"properties":{
				"args":{
					"type":"object",
					"properties":{
						"flag":{"type":"boolean"},
						"label":{"type":"string"}
					},
					"required":["flag","label"],
					"additionalProperties":false
				}
			},
			"required":["args"],
			"additionalProperties":false
		}"#;
		let missing = schema_argument_issue(schema, br#"{"args":{"flag":true}}"#)
			.expect("nested required parameter must be rejected");
		assert_eq!(missing.path, ["args", "label"]);
		assert_eq!(missing.kind, "missing");
		assert_eq!(missing.expected, "required parameter");
	}
	#[test]
	fn control_completion_matches_stdio_envelopes() {
		let plain = control_completion(sf!("plain"), serde_json::json!("Hello"))
			.expect("lower plain CONTROL result");
		assert_eq!(plain.parts, vec![text_part("Hello".to_owned())]);
		assert_eq!(plain.details_json.as_deref(), Some(br#""Hello""#.as_slice()));

		let payload = control_completion(
			sf!("payload"),
			serde_json::json!({
				"updates": [],
				"details": {"payload": {"plain": "yes"}},
				"is_error": false,
				"terminate": true,
			}),
		)
		.expect("lower structured CONTROL result");
		assert!(payload.parts.is_empty());
		assert_eq!(
			payload.details_json.as_deref(),
			Some(br#"{"payload":{"plain":"yes"}}"#.as_slice()),
		);
		assert!(payload.terminate);
	}

	#[test]
	fn python_completion_lowers_terminate_opt_in() {
		let engine = python_engine().expect("initialize embedded Python");
		let completion = engine
			.attach(|py| {
				py.run(
					c_str!(
						r#"
from dataclasses import dataclass
import omp
from omp._verdicts import _canonical_json, loads

@dataclass(frozen=True, slots=True)
class Result(omp.Payload):
    value: int

@dataclass(frozen=True, slots=True)
class Failure(omp.Fault):
    reason: str

result = Result(7, terminate=True)
failure = Failure("no", terminate=True)
inline = omp.Payload({"plain": "yes"}, terminate=True)
assert result.terminate is True and failure.terminate is True
assert inline.terminate is True
assert _canonical_json(inline) == b'{"plain":"yes"}'
assert _canonical_json(result) == b'{"value":7}'
assert _canonical_json(failure) == b'{"reason":"no"}'
assert loads(b'{"value":7}', Result) == Result(7)
assert loads(b'{"reason":"no"}', Failure) == Failure("no")
"#
					),
					None,
					None,
				)?;
				let json = PyModule::import(py, "json")?;
				let dict = PyDict::new(py);
				dict.set_item("details", 7)?;
				dict.set_item("terminate", true)?;
				completion_from_dict(&dict, &json)
			})
			.expect("lower Python completion");
		assert!(completion.terminate);

		let wire = ToolComplete {
			call_id: "terminate".to_owned(),
			details_json: completion.details_json,
			terminate: completion.terminate.then_some(true),
			..ToolComplete::default()
		};
		assert!(
			WorkerCompletion::try_from(wire)
				.expect("decode terminal frame")
				.terminate
		);
	}

	#[test]
	fn python_constraint_round_trips_into_registration() {
		let engine = python_engine().expect("initialize embedded Python");
		let wire = engine
			.attach(|py| {
				let devices = PyModule::import(py, "omp.devices")?;
				let types = PyModule::import(py, "types")?;
				let constraint_kwargs = PyDict::new(py);
				constraint_kwargs.set_item("priority", 81)?;
				constraint_kwargs.set_item(
					"on_unsupported",
					devices.getattr("ConstraintFallback")?.getattr("ERROR")?,
				)?;
				let constraint = devices.getattr("ToolConstraint")?.call_method(
					"grammar",
					(devices.getattr("GrammarSyntax")?.getattr("REGEX")?, "[0-9]+"),
					Some(&constraint_kwargs),
				)?;
				let kwargs = PyDict::new(py);
				kwargs.set_item("constraint", constraint)?;
				let row = types.getattr("SimpleNamespace")?.call((), Some(&kwargs))?;
				python_tool_constraint(&row)
			})
			.expect("lower Python constraint")
			.expect("constraint is present");
		let Some(v1::tool_constraint::Kind::Grammar(grammar)) = wire.kind else {
			panic!("constraint did not lower as grammar");
		};
		assert_eq!(grammar.syntax, v1::GrammarSyntax::Regex as i32);
		assert_eq!(grammar.definition, "[0-9]+");
		assert_eq!(grammar.priority, 81);
		assert_eq!(grammar.on_unsupported, omp_proto::inference::v1::Fallback::Error as i32);
	}

	#[test]
	fn contextual_python_update_sink_emits_update_before_completion() {
		let engine = python_engine().expect("initialize embedded Python");
		let handler = engine
			.attach(|py| {
				let locals = PyDict::new(py);
				py.run(
					c_str!(
						r#"
async def handler(params, ctx):
    ctx.update({"step": params["step"]})
    return {"details": {"done": True}}
"#
					),
					None,
					Some(&locals),
				)?;
				Ok::<_, PyErr>(
					locals
						.get_item("handler")?
						.expect("handler defined")
						.unbind(),
				)
			})
			.expect("define Python handler");
		let tool = PythonTool {
			decl: ToolDecl {
				definition: Some(ToolDef {
					name: "stream_contract".to_owned(),
					description: "stream update contract".to_owned(),
					input: Some(tool_def::Input::JsonSchema(tool_def::JsonSchema {
						schema_json: Bytes::from_static(
							br#"{"type":"object","properties":{"step":{"type":"integer"}},"required":["step"],"additionalProperties":false}"#,
						),
						strict: Some(true),
					})),
				}),
				rev: "1".to_owned(),
				extension_id: "stream.contract".to_owned(),
				kind: "soft".to_owned(),
				execution_mode: v1::ToolExecutionMode::Parallel as i32,
				..ToolDecl::default()
			},
			handler,
			kind: PythonToolKind::Contextual { place: "host".to_owned() },
		};
		let invoke = InvokeTool {
			call_id: "stream-call".to_owned(),
			name: "stream_contract".to_owned(),
			args_json: Bytes::from_static(br#"{"step":2}"#),
			rev: "1".to_owned(),
			..InvokeTool::default()
		};
		let commit = ArgsCommitted {
			invocation_id: "stream-call".to_owned(),
			raw: invoke.args_json.clone(),
			..ArgsCommitted::default()
		};
		let mut wire = Vec::new();
		serve_invocation(
			&engine,
			&[tool],
			7,
			invoke,
			&commit,
			"session",
			"principal",
			"Principal",
			1,
			1,
			&mut wire,
			NonZeroUsize::new(DEFAULT_MAX_FRAME_BYTES).expect("nonzero frame limit"),
			&mut BytesMut::new(),
		)
		.expect("serve contextual invocation");

		let mut cursor = std::io::Cursor::new(wire);
		let limit = NonZeroUsize::new(DEFAULT_MAX_FRAME_BYTES).expect("nonzero frame limit");
		let mut scratch = BytesMut::new();
		let update = read_sync_frame::<_, WorkerFrame>(&mut cursor, limit, &mut scratch)
			.expect("decode update frame")
			.expect("update frame");
		let Some(worker_frame::Body::ToolUpdate(update)) = update.body else {
			panic!("first frame was not a tool update");
		};
		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(&update.json).expect("update JSON"),
			serde_json::json!({"step": 2})
		);
		let complete = read_sync_frame::<_, WorkerFrame>(&mut cursor, limit, &mut scratch)
			.expect("decode completion frame")
			.expect("completion frame");
		assert!(matches!(complete.body, Some(worker_frame::Body::ToolComplete(_))));
	}

	#[test]
	fn prelude_declaration_extracts_and_invokes_adapter() {
		let engine = python_engine().expect("initialize embedded Python");
		engine
			.attach(|py| {
				py.run(
					c_str!(
						r#"
import sys
import types

import omp
import omp._registry as registry

registry.configure_manifest(
    extension="worker-prelude-contract",
    tools=(("worker_prelude_round_trip", "prelude", 1),),
    services=(),
)
module = types.ModuleType("worker_prelude_contract")
sys.modules[module.__name__] = module
exec(
    """
import omp

@omp.prelude
async def worker_prelude_round_trip(patches, *, strategy: str = "sequential"):
    '''Merge patches for the worker prelude contract.

    Returns the bound arguments unchanged.
    '''
    return {"patches": patches, "strategy": strategy}
""",
    module.__dict__,
)
"#
					),
					None,
					None,
				)
			})
			.expect("declare prelude helper");

		let modules = [Str::from("worker_prelude_contract")];
		let (ordinary_tools, _) =
			load_tools(&engine, &modules).expect("freeze ordinary worker declarations");
		assert!(ordinary_tools.is_empty());
		let helpers = load_prelude(&engine, &modules).expect("extract prelude declarations");
		assert_eq!(helpers.len(), 1);
		let helper = &helpers[0];
		let decl = &helper.decl;
		let definition = decl.definition.as_ref().expect("prelude tool definition");
		assert_eq!(definition.name, "worker_prelude_round_trip");
		assert_eq!(definition.description, "Merge patches for the worker prelude contract.");
		let Some(tool_def::Input::JsonSchema(json_schema)) = definition.input.as_ref() else {
			panic!("prelude helper uses JSON Schema input");
		};
		assert_eq!(json_schema.strict, Some(true));
		assert_eq!(decl.rev, "prelude.1");
		assert_eq!(decl.extension_id, "worker_prelude_contract");
		assert_eq!(decl.summary, "Merge patches for the worker prelude contract.");
		assert_eq!(
			decl.docs,
			"Merge patches for the worker prelude contract.\n\nReturns the bound arguments unchanged."
		);
		assert_eq!(decl.prelude_params.len(), 2);
		assert_eq!(decl.prelude_params[0].name, "patches");
		assert_eq!(decl.prelude_params[0].kind, PreludeParamKind::PositionalOrKeyword as i32);
		assert_eq!(decl.prelude_params[0].default_json, None);
		assert_eq!(decl.prelude_params[1].name, "strategy");
		assert_eq!(decl.prelude_params[1].kind, PreludeParamKind::KeywordOnly as i32);
		assert_eq!(
			decl.prelude_params[1].default_json.as_deref(),
			Some(b"\"sequential\"".as_slice())
		);
		assert_eq!(decl.prelude_params[1].annotation.as_deref(), Some("str"));
		let schema: serde_json::Value =
			serde_json::from_slice(&json_schema.schema_json).expect("valid helper schema");
		assert_eq!(
			schema,
			serde_json::json!({
				"type": "object",
				"properties": {
					"patches": {},
					"strategy": {},
				},
				"required": ["patches"],
				"additionalProperties": false,
			})
		);

		let limit = NonZeroUsize::new(DEFAULT_MAX_FRAME_BYTES).expect("nonzero frame limit");
		let mut encoded = Vec::new();
		let mut write_scratch = BytesMut::new();
		let commit =
			ArgsCommitted { invocation_id: "prelude-call".to_owned(), ..ArgsCommitted::default() };
		serve_invocation(
			&engine,
			&helpers,
			41,
			InvokeTool {
				call_id:     "prelude-call".to_owned(),
				name:        "worker_prelude_round_trip".to_owned(),
				args_json:   Bytes::from_static(
					br#"{"patches":["first","second"],"strategy":"parallel"}"#,
				),
				deadline_ms: 1_000,
				rev:         "prelude.1".to_owned(),
				props:       None,
			},
			&commit,
			"session",
			"principal",
			"Principal",
			7,
			3,
			&mut encoded,
			limit,
			&mut write_scratch,
		)
		.expect("invoke prelude helper");
		let mut reader = io::Cursor::new(encoded);
		let mut read_scratch = BytesMut::new();
		let frame = read_sync_frame::<_, WorkerFrame>(&mut reader, limit, &mut read_scratch)
			.expect("decode worker frame")
			.expect("worker frame");
		let Some(worker_frame::Body::ToolComplete(complete)) = frame.body else {
			panic!("prelude invocation did not complete");
		};
		assert_eq!(complete.kind, OutcomeKind::Ok as i32);
		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(&complete.details_json)
				.expect("valid helper result"),
			serde_json::json!({
				"patches": ["first", "second"],
				"strategy": "parallel",
			})
		);
	}

	#[tokio::test]
	async fn linked_source_burst_requests_one_hot_reload() {
		let tree = tempfile::tempdir().expect("linked source");
		let source = tree.path().join("extension.py");
		std::fs::write(&source, "value = 1\n").expect("initial source");
		let (commands, mailbox) = flume::unbounded();
		let watcher =
			spawn_link_watcher(tree.path(), sf!("demo"), commands, None).expect("source watcher");
		time::sleep(Duration::from_millis(50)).await;
		std::fs::write(&source, "value = 2\n").expect("first edit");
		std::fs::write(&source, "value = 3\n").expect("second edit");

		let command = time::timeout(Duration::from_secs(3), mailbox.recv_async())
			.await
			.expect("watch timeout")
			.expect("reload command");
		let SupervisorCommand::Reload { reply } = command else {
			panic!("watcher sent a non-reload command");
		};
		reply.send(Ok(2)).expect("reload response");
		assert_eq!(wire_restart_reason(RestartReason::HotReload), WireRestartReason::HotReload);
		assert!(
			time::timeout(Duration::from_millis(350), mailbox.recv_async())
				.await
				.is_err(),
			"one source burst must request exactly one child respawn"
		);
		watcher.shutdown.cancel();
		watcher.actor.abort();
	}
}
