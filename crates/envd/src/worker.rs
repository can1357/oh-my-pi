//! Supervision and same-binary execution for Python extension hosts.

use std::{
	collections::{BTreeMap, BTreeSet, HashSet},
	env, fmt, io, mem,
	path::{Path, PathBuf},
	str,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::{Bytes, BytesMut};
use flume::Receiver;
use notify::{RecursiveMode, Watcher as _};
use omp_agent::{GateError, HookEvent, HookGate, HookPatch};
use omp_core::{
	CowBytes, Duration as CoreDuration, InvocationPhase, LifecyclePhase, Principal, RestartReason,
	Str, sf,
};
use omp_proto::{
	env::v1::{ArgText, ArgsCommitted, Interrupt},
	prost::Message,
	thread::v1::{Blob, Part, part},
	toolhost::v1::{
		ArgIssue, HookEventId, ProtocolError, ProtocolErrorCode, ToolDecl, ToolExecutionMode,
		ToolUpdate, UiHostEnvelope, UiWorkerEnvelope, ui_host_envelope, ui_worker_envelope,
	},
	ui::v1::{
		CommandDispatchResult, CompletionCandidate, RegisterUi, RenderedView, ShortcutDispatchResult,
		Tml, UiDispatchResult, UiError, command_dispatch_result, ui_dispatch, ui_dispatch_result,
	},
};
use omp_tool::AvailabilityDelta;
use parking_lot::{Mutex, RwLock};
use thiserror::Error;
use tokio::{
	task::JoinHandle,
	time::{self, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::exthost::{DispatchError, control::ControlRuntimeError};
use crate::{
	admission::ApprovalTier,
	blobs::BlobHost,
	exthost::{
		ActivationCause, ActivationEvent, ActivationTrigger, AvailabilityBatch, AvailabilitySink,
		CallbackConcurrency, CancellationOutcome, ControlAuthority, ControlAuthorityFactory,
		ControlCompositionError, ControlQuotaRuntime, EventDeadline, ExtensionManifest,
		GenerationFence, HostControlAuthorityFactory, LifecycleHost, RunningHost, RunningHostError,
		ServiceBroker, ServiceKey, ServiceResponse, SpawnSpec, SpawnedHost,
		control::{
			ContributedValueDelivery, ControlAuthoritySnapshot, ControlConnectionIdentity,
			ControlDispatch, ControlEffect, ControlHandle, ControlInvocationAuthority,
			ControlProtocolError, ControlRequestContext, ControlTierTarget,
		},
		dispatch::{
			CallbackDispatcher, PromptContributionProvider, PromptContributionRecord,
			PromptDispatchError, PromptPullContext, PromptSlotBinding, UiCallbackDispatch,
			decode_prompt_contribution, prompt_dispatch_arguments,
		},
		extensions::{PyCallbackRoute, SealedRegistryEvidence, seal_registry_evidence},
		notify_extension_load, notify_extension_unload, notify_host_reconnect,
		services::{ServiceControlAuthorityFactory, ServiceDispatch, ServiceDispatchBackend},
		spawn::spawn,
	},
	policy::{AuthorityTable, Grants},
	tools::{HookControlFactory, HookEventPolicy, HookSubscription, RegistryControlFactory},
	worker_pool::WorkerUnavailable,
};

/// Default upper bound for one encoded environment payload.
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

struct ServiceRouter {
	broker: Arc<Mutex<ServiceBroker>>,
	routes: Mutex<BTreeMap<HostKey, ProviderRoute>>,
}

#[derive(Clone)]
struct ProviderRoute {
	commands:   flume::Sender<ControlHostCommand>,
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
		let (reply, response) = flume::bounded(1);
		provider
			.commands
			.send_async(ControlHostCommand::ServiceDispatch { dispatch, reply })
			.await
			.map_err(|_| sf!("service provider command channel closed"))?;
		time::timeout(deadline, response.recv_async())
			.await
			.map_err(|_| sf!("service call deadline elapsed"))?
			.map_err(|_| sf!("service provider response channel closed"))?
			.map_err(|error| Str::from(error.to_string()))
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
	/// Workspace root inherited by every extension-host process.
	workspace_root:         Option<PathBuf>,
	/// Active extensions. An empty set starts no Python process.
	pub extensions:         Vec<ExtHostSpec>,
	/// Whether the built-in environment-owned Python evaluator is enabled.
	pub py_eval:            bool,
	/// Typed launch values validated against the active extension manifests.
	pub contributed_values: Vec<omp_ext::config::ContributedCliValue>,
	/// Time allowed for the extension host to publish its frozen registry.
	pub spawn_timeout:      Duration,
	/// Courtesy-interrupt grace period used by environment invocation policy.
	pub interrupt_grace:    CoreDuration,
	/// Shared DATA authorization table owned by the Environment.
	pub data_authority:     Option<Arc<AuthorityTable>>,
	/// Core-issued synchronous policy and session facts installed before import.
	authority_snapshot:     ControlAuthoritySnapshot,
	/// Existing environment CAS used for oversized CONTROL tool results.
	result_store:           Option<BlobHost>,
	/// Complete authority factory for dedicated JSON CONTROL connections.
	control_authorities:    Option<Arc<HostControlAuthorityFactory>>,
	registry_control:       Option<Arc<RegistryControlFactory>>,
	hook_control:           Option<Arc<HookControlFactory>>,
	quota_runtime:          ControlQuotaRuntime,
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
			py_eval: false,
			contributed_values: Vec::new(),
			spawn_timeout: Duration::from_secs(30),
			interrupt_grace: omp_tool::DEFAULT_INTERRUPT_GRACE,
			data_authority: None,
			authority_snapshot: ControlAuthoritySnapshot::default(),
			result_store: None,
			control_authorities: None,
			registry_control: None,
			hook_control: None,
			quota_runtime: ControlQuotaRuntime::new(),
			domain_control: DomainControlSlot::new(),
			availability_sink: Arc::new(Mutex::new(None)),
		}
	}

	/// Binds this supervisor configuration to the Environment's sole DATA
	/// authorization table.
	pub fn bind_data_authority(&mut self, authority: Arc<AuthorityTable>) {
		self.data_authority = Some(authority);
	}

	/// Binds extension-host processes to the Environment's workspace root.
	pub fn bind_workspace_root(&mut self, root: &Path) {
		self.workspace_root = Some(root.to_path_buf());
	}

	/// Installs the authoritative synchronous policy and current-session view.
	pub fn bind_authority_snapshot(&mut self, snapshot: ControlAuthoritySnapshot) {
		self.authority_snapshot = snapshot;
	}

	/// Installs the live session-authority projection without replacing policy tiers.
	pub(crate) fn bind_session_authority_snapshot(
		&mut self,
		current_session: serde_json::Value,
		agent_depth: u32,
	) {
		self.authority_snapshot.current_session = Some(current_session);
		self.authority_snapshot.agent_depth = agent_depth;
	}

	/// Installs the environment result CAS before any dedicated host starts.
	pub fn bind_result_store(&mut self, store: BlobHost) {
		self.result_store = Some(store);
	}

	/// Installs the complete production authority factory before any dedicated
	/// CONTROL connection starts.
	pub fn bind_control_authorities(&mut self, factory: Arc<HostControlAuthorityFactory>) {
		self.control_authorities = Some(factory);
	}

	/// Installs the parent-owned sealed registry projection shared with CONTROL.
	pub fn bind_registry_control(&mut self, registry: Arc<RegistryControlFactory>) {
		self.registry_control = Some(registry);
	}

	pub(crate) fn bind_hook_control(&mut self, hooks: Arc<HookControlFactory>) {
		self.hook_control = Some(hooks);
	}

	/// Returns the sole quota runtime shared by host supervision and CONTROL.
	pub(crate) fn quota_runtime(&self) -> ControlQuotaRuntime {
		self.quota_runtime.clone()
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
/// CONTROL extension tools receive only the final effective document supplied
/// by [`ExtHostInvocation::args_committed`].
#[derive(Clone, Debug)]
pub struct ExtHostToolCall {
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
pub enum ExtHostAbortKind {
	/// The invocation guard was dropped or explicitly cancelled.
	Cancelled,
	/// The committed invocation exceeded its deadline.
	TimedOut,
	/// The worker exited or violated its protocol during the invocation.
	Crashed,
}

/// Terminal supervisor-owned abort truth.
#[derive(Clone, Debug)]
pub struct ExtHostAbort {
	/// Call whose effects are no longer knowable.
	pub call_id:         Str,
	/// Abort classification.
	pub kind:            ExtHostAbortKind,
	/// Human-readable owner diagnostic.
	pub reason:          Str,
	/// True after dispatch; false when a queued call is cancelled before
	/// dispatch.
	pub effects_unknown: bool,
}

/// Decoded terminal branch from an extension host.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtHostOutcomeKind {
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
pub struct ExtHostCompletion {
	/// Stable call identity.
	pub call_id:      Str,
	/// Exact terminal branch.
	pub kind:         ExtHostOutcomeKind,
	/// Model-facing result parts, each with a present discriminator.
	pub parts:        Vec<Part>,
	/// Inline structured details for in-process CONTROL completions.
	pub details_json: Option<Bytes>,
	/// Complete structured result staged by the Environment CAS when it exceeds
	/// the bounded inline CONTROL projection.
	pub details_blob: Option<Blob>,
	/// Structured argument issue, present only for
	/// [`ExtHostOutcomeKind::ArgsRejected`].
	pub args_issue:   Option<ArgIssue>,
	/// Whether model-facing parts may be compacted.
	pub useless:      bool,
	/// Whether this result opts in to suppressing the automatic model follow-up.
	pub terminate:    bool,
}

/// One ordered event from a committed Python invocation.
#[derive(Clone, Debug)]
pub enum ExtHostEvent {
	/// Typed JSON progress serialized by the extension.
	Update(ToolUpdate),
	/// A typed protocol error returned by the extension host.
	ProtocolError(ProtocolError),
	/// Normal terminal completion.
	Complete(ExtHostCompletion),
	/// Abnormal terminal completion owned by the supervisor.
	Aborted(ExtHostAbort),
}

/// RAII handle to a Python invocation.
///
/// Dropping a live handle requests cancellation. The supervisor then applies
/// the CONTROL cancellation ladder to only the owning extension fate unit and
/// replaces that host before it accepts the next invocation.
#[must_use]
pub struct ExtHostInvocation {
	id:                 u64,
	invocation_id:      Str,
	host_generation:    u64,
	session_generation: u64,
	owner:              HostKey,
	maximum_effects:    omp_tool::Effects,
	data_authority:     Option<Arc<AuthorityTable>>,
	events:             Receiver<ExtHostEvent>,
	commands:           flume::Sender<ControlHostCommand>,
	committed:          bool,
	terminal:           bool,
	cancel_requested:   bool,
}

impl ExtHostInvocation {
	/// Receives the next update or terminal event.
	///
	/// # Errors
	/// Returns `RecvError` only if the supervisor shuts down without a terminal
	/// event.
	pub async fn next(&mut self) -> Result<ExtHostEvent, flume::RecvError> {
		let event = self.events.recv_async().await?;
		if matches!(event, ExtHostEvent::Complete(_) | ExtHostEvent::Aborted(_)) {
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

	/// Returns whether this invocation accepts speculative argument fragments.
	///
	/// CONTROL extension hosts currently admit committed arguments only.
	pub const fn streams_args(&self) -> bool {
		false
	}

	/// Returns the registered maximum as a wire envelope for trusted internal
	/// dispatches that have no external admission frame to carry a narrowing.
	pub fn maximum_effect_envelope(&self) -> omp_proto::policy::v1::EffectEnvelope {
		omp_proto::policy::v1::EffectEnvelope::from(&self.maximum_effects)
	}

	/// Rejects a speculative argument fragment.
	///
	/// CONTROL extension hosts currently admit only the final
	/// [`ArgsCommitted`] document.
	///
	/// # Errors
	/// Returns a typed protocol error for a stale invocation id or because
	/// speculative fragments are unsupported.
	pub fn arg_text(&self, frame: ArgText) -> Result<(), ExtHostError> {
		self.validate_environment_id(frame.invocation_id.as_str())?;
		Err(ExtHostError::Protocol(sf!("CONTROL extension tools accept committed arguments only",)))
	}

	/// Forwards the assistant-item/effect-authorization receipt verbatim.
	///
	/// The effect token and authorization timestamp remain in this exact frame;
	/// no lifecycle side channel is synthesized.
	///
	/// # Errors
	/// Returns a typed protocol error for a stale invocation id, a duplicate
	/// commit, or a stopped actor.
	pub fn args_committed(&mut self, frame: ArgsCommitted) -> Result<(), ExtHostError> {
		self.validate_environment_id(frame.invocation_id.as_str())?;
		if self.committed {
			return Err(ExtHostError::Protocol(sf!("ArgsCommitted was already forwarded")));
		}
		let narrowed = frame
			.effects
			.as_ref()
			.map(omp_tool::Effects::try_from)
			.transpose()
			.map_err(|_| ExtHostError::Protocol(sf!("ArgsCommitted effects are invalid")))?
			.unwrap_or_default();
		if !narrowed.is_subset_of(&self.maximum_effects) {
			return Err(ExtHostError::Protocol(sf!(
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
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
		}
		self
			.commands
			.send(ControlHostCommand::ArgsCommitted { id: self.id, frame })
			.map_err(|_| ExtHostError::Unavailable)?;
		self.committed = true;
		Ok(())
	}

	/// Sends a survivable, classed interrupt verbatim.
	///
	/// # Errors
	/// Returns a typed protocol error for a stale invocation id or stopped
	/// actor.
	pub fn interrupt(&self, frame: Interrupt) -> Result<(), ExtHostError> {
		self.validate_environment_id(frame.invocation_id.as_str())?;
		if self.terminal || self.cancel_requested {
			return Err(ExtHostError::Protocol(sf!("invocation is already terminal")));
		}
		self
			.commands
			.send(ControlHostCommand::Interrupt { id: self.id, frame })
			.map_err(|_| ExtHostError::Unavailable)
	}

	fn validate_environment_id(&self, invocation_id: &str) -> Result<(), ExtHostError> {
		if invocation_id == self.invocation_id.as_str() {
			Ok(())
		} else {
			Err(ExtHostError::Protocol(sf!(
				"stale invocation id does not match extension-host handle"
			)))
		}
	}

	/// Requests cancellation while retaining the terminal event stream.
	pub fn cancel(&mut self, reason: impl Into<Str>) {
		if self.terminal || self.cancel_requested {
			return;
		}
		if self
			.commands
			.send(ControlHostCommand::Cancel { id: self.id, reason: reason.into() })
			.is_ok()
		{
			self.cancel_requested = true;
		}
	}
}

impl Drop for ExtHostInvocation {
	fn drop(&mut self) {
		if !self.terminal && !self.cancel_requested {
			let _ = self.commands.send(ControlHostCommand::Cancel {
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
	/// Sealed extension-host declaration.
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

fn control_manifest_snapshot(spec: &ExtHostSpec) -> Result<Str, ExtHostError> {
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
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))
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

fn python_registration_authority(
	key: &HostKey,
	session: &Str,
	host_generation: u64,
	settings: &serde_json::Map<String, serde_json::Value>,
) -> ControlInvocationAuthority {
	ControlInvocationAuthority {
		invocation:        sf!("extension-register:{}:{}", key.extension(), host_generation),
		phase:             InvocationPhase::Open,
		session:           session.clone(),
		turn:              None,
		event:             Some(sf!("extension.register")),
		call:              None,
		device:            None,
		effects:           Box::new([]),
		place_kind:        sf!("host"),
		lifecycle:         LifecyclePhase::Active,
		roots:             Box::new([]),
		remote:            false,
		has_ui:            false,
		headless:          true,
		settings:          settings.clone(),
		secret_settings:   Box::new([]),
		data:              None,
		direct_filesystem: None,
	}
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
	registry_control:   Arc<RegistryControlFactory>,
	hook_control:       Option<Arc<HookControlFactory>>,
	quota_runtime:      ControlQuotaRuntime,
	lifecycle_gate:     Option<Arc<HookGate>>,
	registered_ui:        Arc<RwLock<Option<RegisterUi>>>,
	availability:         Arc<RwLock<AvailabilityBatch>>,
	availability_sink:    Arc<Mutex<Option<Arc<dyn AvailabilitySink>>>>,
	availability_pending: Arc<Mutex<BTreeMap<Str, AvailabilityDelta>>>,
	settings:             serde_json::Map<String, serde_json::Value>,
	cli_contributions:  omp_ext::config::CliContributionSet,
	contributed_values: Arc<[omp_ext::config::ContributedCliValue]>,
	python_route:       PyCallbackRoute,
	roots:              Box<[Str]>,
}
struct LiveControlRoute {
	control:  RwLock<ControlHandle>,
	identity: RwLock<Arc<ControlConnectionIdentity>>,
}

struct FrozenControlLifecycleHost {
	control:            ControlHandle,
	extension:          Str,
	session:            Str,
	host_generation:    u64,
	next_invocation:    u64,
	identity:           Arc<ControlConnectionIdentity>,
	manifest:           ExtensionManifest,
	frozen_registry:    Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
	staged_evidence:    Option<((Str, Str, Str), Arc<SealedRegistryEvidence>)>,
	settings:           serde_json::Map<String, serde_json::Value>,
	cli_contributions:  omp_ext::config::CliContributionSet,
	contributed_values: Arc<[omp_ext::config::ContributedCliValue]>,
}

impl FrozenControlLifecycleHost {
	fn new(
		control: ControlHandle,
		extension: Str,
		session: Str,
		host_generation: u64,
		identity: Arc<ControlConnectionIdentity>,
		manifest: ExtensionManifest,
		frozen_registry: Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
		settings: serde_json::Map<String, serde_json::Value>,
		cli_contributions: omp_ext::config::CliContributionSet,
		contributed_values: Arc<[omp_ext::config::ContributedCliValue]>,
	) -> Self {
		Self {
			control,
			extension,
			session,
			host_generation,
			next_invocation: 1,
			identity,
			manifest,
			frozen_registry,
			staged_evidence: None,
			settings,
			cli_contributions,
			contributed_values,
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
			let mut frozen = self
				.control
				.dispatch(dispatch)
				.await
				.map_err(|error| Str::from(error.to_string()))?;
			normalize_control_availability(&self.manifest, &mut frozen)
				.map_err(|error| Str::from(error.to_string()))?;
			let evidence = seal_registry_evidence(
				Arc::clone(&self.identity),
				self.session.clone(),
				&self.manifest,
				frozen,
			)
			.map_err(|error| Str::from(error.to_string()))?;
			ensure_committed_argument_tools(&evidence.tools)
				.map_err(|error| Str::from(error.to_string()))?;
			let evidence = Arc::new(evidence);
			let key = (
				self.identity.layer.clone(),
				self.identity.tier.clone(),
				self.identity.extension.clone(),
			);
			let registry = self.frozen_registry.lock();
			if let Some(previous) = registry.get(&key)
				&& !previous.same_declarations(&evidence)
			{
				return Err(sf!("hot reload changed the sealed extension declaration set"));
			}
			drop(registry);
			self.staged_evidence = Some((key, evidence));
			Ok(())
		}
	}

	fn activate(
		&mut self,
		event: &ActivationEvent,
		_principal: &Principal,
	) -> impl Future<Output = Result<(), Str>> + Send {
		use std::time::Instant;

		let reason: &'static str = event.reason.into();
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
		let generation = event.generation;
		let cli_values = ContributedValueDelivery::new(
			self.extension.clone(),
			generation,
			&self.cli_contributions,
			&self.contributed_values,
		)
		.map_err(|error| Str::from(error.to_string()))
		.and_then(|mut delivery| {
			delivery
				.deliver(self.extension.as_str(), generation)
				.map_err(|error| Str::from(error.to_string()))
		})
		.map(|values| {
			values
				.into_iter()
				.map(|entry| {
					let value = match entry.value {
						omp_ext::config::ContributedValue::Boolean(value) => {
							serde_json::Value::Bool(value)
						},
						omp_ext::config::ContributedValue::String(value) => {
							serde_json::Value::String(value.to_string())
						},
					};
					serde_json::json!({"sink": entry.sink.as_str(), "value": value})
				})
				.collect::<Vec<_>>()
		});
		let authority = self.authority(
			"extension_activate",
			InvocationPhase::EffectsAuthorized,
			LifecyclePhase::Active,
		);
		async move {
			let cli_values = cli_values?;
			let mut arguments = serde_json::Map::new();
			arguments.insert(
				String::from("payload"),
				serde_json::json!({
					"extension": self.extension.as_str(),
					"reason": reason,
					"session_started_at": started_at_ms,
					"generation": generation,
					"trigger": trigger,
					"cli_values": cli_values,
				}),
			);
			self
				.control
				.dispatch(ControlDispatch {
					operation: sf!("omp.lifecycle.activate"),
					arguments,
					authority,
					policy: CallbackConcurrency::Serialized,
					deadline: EventDeadline { at: Instant::now() + Duration::from_secs(10) },
				})
				.await
				.map_err(|error| Str::from(error.to_string()))?;
			if let Some((key, evidence)) = self.staged_evidence.take() {
				self.frozen_registry.lock().insert(key, evidence);
			}
			Ok(())
		}
	}
}

fn normalize_control_availability(
	manifest: &ExtensionManifest,
	publication: &mut serde_json::Value,
) -> Result<(), ExtHostError> {
	let rows = publication
		.as_object_mut()
		.and_then(|publication| publication.get_mut("availability"))
		.and_then(serde_json::Value::as_array_mut)
		.ok_or_else(|| ExtHostError::Protocol(sf!("CONTROL freeze omitted availability")))?;
	for row in rows {
		let row = row
			.as_object_mut()
			.ok_or_else(|| ExtHostError::Protocol(sf!("CONTROL availability row is malformed")))?;
		let name = row
			.get("name")
			.and_then(serde_json::Value::as_str)
			.ok_or_else(|| ExtHostError::Protocol(sf!("CONTROL availability name is malformed")))?;
		let revision = row
			.get("rev")
			.and_then(serde_json::Value::as_u64)
			.and_then(|revision| u16::try_from(revision).ok())
			.ok_or_else(|| {
				ExtHostError::Protocol(sf!("CONTROL availability revision is malformed"))
			})?;
		let family = row
			.get("family")
			.and_then(serde_json::Value::as_str)
			.ok_or_else(|| ExtHostError::Protocol(sf!("CONTROL availability family is malformed")))?;
		let Some(declared) = manifest
			.declarations
			.tools()
			.find(|declared| declared.name == name && declared.rev == revision)
		else {
			continue;
		};
		if family == manifest.provenance.extension_id() && family != declared.family.as_str() {
			row.insert(
				String::from("family"),
				serde_json::Value::String(declared.family.to_string()),
			);
		}
	}
	Ok(())
}

async fn freeze_control_registry(
	control: ControlHandle,
	identity: Arc<ControlConnectionIdentity>,
	session: Str,
	manifest: &ExtensionManifest,
	settings: &serde_json::Map<String, serde_json::Value>,
) -> Result<Arc<SealedRegistryEvidence>, ExtHostError> {
	let mut authority = python_registration_authority(
		&HostKey::new(identity.layer.clone(), identity.tier.clone(), identity.extension.clone()),
		&session,
		identity.host_generation,
		settings,
	);
	authority.phase = InvocationPhase::Open;
	authority.lifecycle = LifecyclePhase::Frozen;
	authority.event = Some(sf!("freeze"));
	let mut payload = control
		.dispatch(ControlDispatch {
			operation: sf!("omp.lifecycle.freeze"),
			arguments: serde_json::Map::new(),
			authority,
			policy: CallbackConcurrency::Serialized,
			deadline: EventDeadline { at: std::time::Instant::now() + Duration::from_secs(10) },
		})
		.await
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	normalize_control_availability(manifest, &mut payload)?;
	let evidence = seal_registry_evidence(identity, session, manifest, payload)
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	ensure_committed_argument_tools(&evidence.tools)?;
	Ok(Arc::new(evidence))
}

fn evidence_availability(evidence: &SealedRegistryEvidence) -> AvailabilityBatch {
	AvailabilityBatch {
		deltas: evidence
			.availability
			.iter()
			.map(|row| AvailabilityDelta {
				name: row.name.clone(),
				mounted: row.mounted,
				reason: row.reason.clone(),
			})
			.collect(),
	}
}

fn publish_availability(
	sink: &Mutex<Option<Arc<dyn AvailabilitySink>>>,
	pending: &Mutex<BTreeMap<Str, AvailabilityDelta>>,
	batch: AvailabilityBatch,
) {
	if batch.deltas.is_empty() {
		return;
	}
	let destination = sink.lock();
	if let Some(target) = destination.as_ref().map(Arc::clone) {
		drop(destination);
		target.set_availability(batch);
		return;
	}
	let mut pending = pending.lock();
	for delta in batch.deltas {
		pending.insert(delta.name.clone(), delta);
	}
}

fn publish_host_down(activation: &PendingControlActivation, reason: &'static str) {
	let current = activation.availability.read();
	let batch = AvailabilityBatch {
		deltas: current
			.deltas
			.iter()
			.map(|delta| AvailabilityDelta {
				name: delta.name.clone(),
				mounted: false,
				reason: Some(Str::new_static(reason)),
			})
			.collect(),
	};
	drop(current);
	publish_availability(
		&activation.availability_sink,
		&activation.availability_pending,
		batch,
	);
}

fn publish_host_availability(
	activation: &PendingControlActivation,
	evidence: &SealedRegistryEvidence,
) {
	let batch = evidence_availability(evidence);
	*activation.availability.write() = batch.clone();
	publish_availability(
		&activation.availability_sink,
		&activation.availability_pending,
		batch,
	);
}

fn initial_authority_snapshot(config: &ExtHostConfig) -> ControlAuthoritySnapshot {
	let mut snapshot = config.authority_snapshot.clone();
	if snapshot.current_session.is_none() {
		let root = config
			.workspace_root
			.as_ref()
			.and_then(|root| Url::from_file_path(root).ok())
			.map_or_else(|| String::from("file:///"), |root| root.to_string());
		let started_at_ms = config
			.session_started_at
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis()
			.try_into()
			.unwrap_or(u64::MAX);
		snapshot.current_session = Some(serde_json::json!({
			"id": config.session_id.as_str(),
			"title": null,
			"title_source": "system",
			"cwd": root.clone(),
			"project": root,
			"created_ms": started_at_ms,
			"updated_ms": started_at_ms,
			"status": "pending",
			"kind": "interactive",
			"parent": null,
			"entries": 0,
			"turns": 0,
			"usage": {},
			"cost": {"nanos_usd": 0, "estimated": true},
			"models": [],
			"remote": false,
		}));
	}
	for extension in &config.extensions {
		for tool in extension.manifest.declarations.tools() {
			let row = extension
				.manifest
				.static_declarations()
				.tools
				.iter()
				.find(|row| row.key.as_str() == format!("{}@{}.{}", tool.name, tool.family, tool.rev));
			let tier = row
				.and_then(|row| row.properties.get("tier"))
				.and_then(serde_json::Value::as_str)
				.filter(|tier| matches!(*tier, "read" | "write" | "exec" | "privileged"))
				.map(Str::from)
				.or_else(|| {
					row.and_then(|row| row.properties.get("effects"))
						.and_then(|value| {
							serde_json::from_value::<omp_tool::Effects>(value.clone()).ok()
						})
						.map(|effects| {
							Str::from(<&'static str>::from(ApprovalTier::from_effects(&effects)))
						})
				})
				.unwrap_or_else(|| sf!("exec"));
			snapshot
				.tiers
				.entry(ControlTierTarget::Device {
					name: tool.name.clone(),
					family: tool.family.clone(),
					rev: Str::from(tool.rev.to_string()),
				})
				.or_insert(tier);
		}
	}
	snapshot
}

fn ensure_committed_argument_tools(tools: &[ToolDecl]) -> Result<(), ExtHostError> {
	if let Some(tool) = tools.iter().find(|tool| tool.streams_args) {
		let name = tool
			.definition
			.as_ref()
			.map_or("<unnamed>", |definition| definition.name.as_str());
		return Err(ExtHostError::Protocol(sf!(
			"extension tool {name} declares streams_args, but CONTROL extension hosts accept \
			 committed arguments only",
		)));
	}
	Ok(())
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
	availability_pending: Arc<Mutex<BTreeMap<Str, AvailabilityDelta>>>,
	availability_sink:    Arc<Mutex<Option<Arc<dyn AvailabilitySink>>>>,
	control_authorities:  Option<Arc<HostControlAuthorityFactory>>,
	frozen_registry:      Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
	domain_control:       Arc<DomainControlSlot>,
	service_router:       Arc<ServiceRouter>,
	agents_control:       Arc<AgentsControlSlot>,
	control_activations:  Vec<PendingControlActivation>,
	live_controls:        BTreeMap<HostKey, Arc<LiveControlRoute>>,
	quota_updates:        Mutex<Option<JoinHandle<()>>>,
	watchers:             Vec<LinkWatcher>,
	lifecycle_gate:       Option<Arc<HookGate>>,
	lifecycle_manifests:  Arc<[ExtensionManifest]>,
}
impl ExtHostSupervisor {
	/// Starts and verifies every configured active extension.
	///
	/// An empty configuration is lazy: it starts no Python interpreter. Every
	/// configured extension owns exactly one independently supervised process.
	///
	/// # Errors
	/// Returns a startup, identity, registration, or handshake error.
	pub async fn spawn(config: ExtHostConfig) -> Result<Self, ExtHostError> {
		let control_authorities = config.control_authorities.clone();
		let registry_control = config.registry_control.clone();
		let hook_control = config.hook_control.clone();
		let quota_runtime = config.quota_runtime();
		let authority_snapshot = initial_authority_snapshot(&config);
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
		let mut service_broker = ServiceBroker::new(config.session_generation);
		for extension in &config.extensions {
			validate_extension_spec(extension)?;
			quota_runtime
				.register_limits(
					extension.key.clone(),
					extension.manifest.resource_limits.iter().cloned(),
				)
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
			service_broker
				.publish_manifest(extension.key.clone(), extension.manifest.services.clone())
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
		}
		let service_router = Arc::new(ServiceRouter {
			broker: Arc::new(Mutex::new(service_broker)),
			routes: Mutex::new(BTreeMap::new()),
		});
		let frozen_registry = Arc::new(Mutex::new(BTreeMap::new()));
		let data_authority = config.data_authority.clone();
		let availability_sink = Arc::clone(&config.availability_sink);
		let availability_pending = Arc::new(Mutex::new(BTreeMap::new()));
		let mut identities = HashSet::with_capacity(config.extensions.len());
		let mut routes = BTreeMap::new();
		let mut registrations = Vec::new();
		let mut prompt_registrations = Vec::new();
		let mut prompt_routes = BTreeMap::new();
		let mut actors = Vec::new();
		let mut control_activations = Vec::new();
		let mut live_controls = BTreeMap::new();

		'extension: for extension in &config.extensions {
			if !identities.insert(extension.key.clone()) {
				return Err(ExtHostError::Protocol(sf!(
					"extension host identity is configured more than once",
				)));
			}
			if let Some(authority) = &data_authority {
				authority.register_host(extension.key.clone(), extension.data_grants.clone());
			}
			let Some(trigger) = extension
				.manifest
				.activation_triggers
				.iter()
				.copied()
				.find(|trigger| trigger.requires_host())
			else {
				continue;
			};
			let python_site = extension.python_site.as_ref().ok_or_else(|| {
				ExtHostError::Protocol(sf!(
					"extension {} has no authenticated Python site",
					extension.key.extension()
				))
			})?;
			let env_socket = extension.data_socket.as_ref().ok_or_else(|| {
				ExtHostError::Protocol(sf!(
					"extension {} has no scoped DATA socket",
					extension.key.extension()
				))
			})?;
			let factory = control_authorities.as_ref().ok_or_else(|| {
				ExtHostError::Protocol(sf!(
					"production extension host omitted CONTROL authority composition"
				))
			})?;
			let registry = registry_control.as_ref().ok_or_else(|| {
				ExtHostError::Protocol(sf!(
					"production extension host omitted registry CONTROL composition"
				))
			})?;
			let identity = control_connection_identity(&config, extension, 1);
			let agents = agents_control
				.factory()
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
			let authority = factory
				.bind_with_agents(Arc::clone(&identity), Arc::clone(&agents))
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
			let mut modules = Vec::with_capacity(extension.manifest.declaration_modules.len() + 1);
			modules.push(extension.manifest.entry.clone());
			modules.extend(extension.manifest.declaration_modules.iter().cloned());
			let manifest_snapshot = control_manifest_snapshot(extension)?;
			let spawned = match spawn(SpawnSpec {
				key: extension.key.clone(),
				executable: extension
					.host_executable
					.clone()
					.unwrap_or_else(|| config.executable.clone()),
				python_site: python_site.clone(),
				entry_path: extension.entry_path.clone(),
				env_socket: env_socket.clone(),
				current_dir: config.workspace_root.clone(),
				workspace_root: extension
					.manifest
					.static_declarations()
					.ordered
					.iter()
					.any(|row| matches!(row.kind.as_str(), "telemetry" | "telemetry_subscription"))
					.then(|| config.workspace_root.clone())
					.flatten(),
				host_generation: 1,
				session_generation: config.session_generation,
				package_snapshot: None,
				manifest_snapshot,
				declaration_modules: modules.into_boxed_slice(),
			})
			.await
			{
				Ok(spawned) => spawned,
				Err(error @ crate::exthost::SpawnError::Python(_)) => {
					tracing::warn!(
						extension_id = %extension.key.extension(),
						error = %error,
						"Python extension child failed to load; containing failure",
					);
					continue;
				},
				Err(error) => {
					return Err(ExtHostError::Protocol(Str::from(error.to_string())));
				},
			};
			let running = spawned
				.start_control((*identity).clone(), authority, &authority_snapshot)
				.await
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
			let receipt = quota_runtime
				.receipt(config.session_id.as_str(), &extension.key)
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
			running
				.control()
				.install_resource_receipt(&receipt)
				.await
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
			let evidence = match time::timeout(
				config.spawn_timeout,
				freeze_control_registry(
					running.control(),
					Arc::clone(&identity),
					config.session_id.clone(),
					&extension.manifest,
					&extension.settings,
				),
			)
			.await
			{
				Ok(Ok(evidence)) => evidence,
				Ok(Err(error)) => {
					tracing::warn!(
						extension_id = %extension.key.extension(),
						error = %error,
						"Python extension registry freeze failed; containing failure",
					);
					running.shutdown().await;
					continue 'extension;
				},
				Err(_) => {
					let mut tail = Vec::new();
					while let Ok(log) = running.logs().try_recv() {
						tail.extend_from_slice(&log.bytes);
					}
					let start = tail.len().saturating_sub(800);
					tracing::warn!(
						extension_id = %extension.key.extension(),
						output_tail = %String::from_utf8_lossy(&tail[start..]).trim(),
						"Python extension registry freeze timed out; containing failure",
					);
					running.shutdown().await;
					continue 'extension;
				},
			};
			let evidence = registry
				.install_evidence(evidence)
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
			let python_route = PyCallbackRoute::new(
				running.control(),
				python_registration_authority(
					&extension.key,
					&config.session_id,
					1,
					&extension.settings,
				),
			);
			let activation = PendingControlActivation {
				control: running.control(),
				identity: Arc::clone(&identity),
				manifest: extension.manifest.clone(),
				key: extension.key.clone(),
				data_enabled: true,
				trigger,
				session_id: config.session_id.clone(),
				session_started_at: config.session_started_at,
				session_generation: config.session_generation,
				principal: config.principal.clone(),
				host_factory: Arc::clone(factory),
				agents_factory: Arc::clone(&agents),
				registry_control: Arc::clone(registry),
				hook_control: hook_control.clone(),
				quota_runtime: quota_runtime.clone(),
				lifecycle_gate: hook_control.as_ref().map(|hooks| hooks.admission_gate()),
				registered_ui: Arc::new(RwLock::new(Some(evidence.ui_registration.clone()))),
				availability: Arc::new(RwLock::new(evidence_availability(&evidence))),
				availability_sink: Arc::clone(&availability_sink),
				availability_pending: Arc::clone(&availability_pending),
				settings: extension.settings.clone(),
				cli_contributions: extension.cli_contributions.clone(),
				contributed_values: Arc::from(config.contributed_values.clone()),
				python_route,
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
			let (commands, mailbox) = flume::unbounded();
			let host_generation = Arc::new(AtomicU64::new(1));
			for declaration in evidence.tools.iter() {
				let definition = declaration
					.definition
					.as_ref()
					.ok_or_else(|| ExtHostError::Protocol(sf!("registered tool has no definition")))?;
				let maximum_effects = declaration
					.effects
					.as_ref()
					.map(omp_tool::Effects::try_from)
					.transpose()
					.map_err(|_| ExtHostError::Protocol(sf!("registered tool effects are invalid")))?
					.unwrap_or_default();
				let route = (Str::from(definition.name.as_str()), Str::from(declaration.rev.as_str()));
				if routes
					.insert(route, HostRoute {
						commands: commands.clone(),
						owner: extension.key.clone(),
						maximum_effects,
						callback_policy: match ToolExecutionMode::try_from(declaration.execution_mode) {
							Ok(ToolExecutionMode::Sequential) => CallbackConcurrency::Serialized,
							Ok(ToolExecutionMode::Unspecified | ToolExecutionMode::Parallel) => {
								CallbackConcurrency::Threadsafe
							},
							Err(_) => {
								return Err(ExtHostError::Protocol(sf!(
									"registered tool execution mode is invalid"
								)));
							},
						},
						host_generation: Arc::clone(&host_generation),
						session_generation: config.session_generation,
					})
					.is_some()
				{
					return Err(ExtHostError::Protocol(sf!(
						"two extension hosts registered the same tool name and revision",
					)));
				}
				registrations.push(OwnedToolDecl {
					owner:        extension.key.clone(),
					declaration:  declaration.clone(),
					hard_granted: hard_tool_granted(extension, definition.name.as_str()),
				});
			}
			for binding in evidence.prompts.iter() {
				if binding.owner != *extension.key.extension() {
					return Err(ExtHostError::Protocol(sf!(
						"prompt declaration owner differs from its authenticated CONTROL host"
					)));
				}
				prompt_registrations.push(binding.clone());
				prompt_routes.insert(binding.owner.clone(), PromptRoute { commands: commands.clone() });
			}
			service_router
				.broker
				.lock()
				.activate_provider_declarations(&extension.key, 1, evidence.services.iter().cloned())
				.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
			service_router
				.routes
				.lock()
				.insert(extension.key.clone(), ProviderRoute {
					commands:   commands.clone(),
					generation: Arc::clone(&host_generation),
				});
			frozen_registry.lock().insert(
				(identity.layer.clone(), identity.tier.clone(), identity.extension.clone()),
				Arc::clone(&evidence),
			);
			live_controls.insert(extension.key.clone(), Arc::clone(&live_control));
			control_activations.push(activation.clone());
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
				Arc::clone(&service_router),
				config.result_store.clone(),
			));
			actors.push(HostActor {
				commands,
				actor: Mutex::new(Some(actor)),
				shutdown,
				reloadable: true,
				owners: Arc::from([extension.key.extension().clone()]),
			});
		}

		let quota_updates = if live_controls.is_empty() {
			None
		} else {
			let updates = quota_runtime.updates();
			let routes = live_controls.clone();
			let session = config.session_id.clone();
			Some(tokio::spawn(async move {
				while let Ok(update) = updates.recv_async().await {
					if update.session != session {
						continue;
					}
					let Some(route) = routes.get(&update.owner) else {
						continue;
					};
					let control = route.control.read().clone();
					if let Err(error) = control.install_resource_receipt(&update.receipt).await {
						tracing::warn!(
							extension_id = %update.owner.extension(),
							%error,
							"failed to publish extension quota receipt",
						);
					}
				}
			}))
		};
		let mut watchers = Vec::new();
		for extension in &config.extensions {
			let Some(root) = extension.watch_root.as_ref() else {
				continue;
			};
			let Some(commands) = actors
				.iter()
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
		Ok(Self {
			routes,
			registrations: registrations.into(),
			prompt_registrations: prompt_registrations.into(),
			prompt_routes,
			next_invocation: AtomicU64::new(1),
			actors,
			data_authority,
			availability_sink,
			availability_pending,
			control_authorities,
			frozen_registry,
			domain_control,
			service_router,
			agents_control,
			control_activations,
			live_controls,
			quota_updates: Mutex::new(quota_updates),
			watchers,
			lifecycle_gate,
			lifecycle_manifests,
		})
	}

	/// Completes FREEZE and ACTIVATE after envd-owned CONTROL authorities are
	/// installed. Late app/driver domains remain fail-closed until their atomic
	/// factory bundle is bound before first user reach.
	pub async fn activate_control_hosts(&self) -> Result<(), ExtHostError> {
		let mut activated = BTreeSet::new();
		for activation in &self.control_activations {
			match activate_control_generation(
				activation,
				activation.control.clone(),
				1,
				ActivationCause::FirstReach,
				Arc::clone(&self.frozen_registry),
			)
			.await
			{
				Ok(()) => {
					let evidence = self
						.frozen_registry
						.lock()
						.get(&(
							activation.identity.layer.clone(),
							activation.identity.tier.clone(),
							activation.identity.extension.clone(),
						))
						.cloned()
						.ok_or_else(|| {
							ExtHostError::Protocol(sf!(
								"CONTROL child omitted sealed hook registry evidence"
							))
						})?;
					if let Err(error) = install_control_hooks(activation, &evidence) {
						tracing::warn!(
							extension_id = %activation.key.extension(),
							error = %error,
							"Python extension hook registry was rejected; containing failure",
						);
						self.frozen_registry.lock().remove(&(
							activation.identity.layer.clone(),
							activation.identity.tier.clone(),
							activation.identity.extension.clone(),
						));
						publish_host_down(activation, "extension hook registry was rejected");
						continue;
					}
					publish_host_availability(activation, &evidence);
					activated.insert(activation.key.extension().clone());
				},
				Err(error @ ExtHostError::ExtensionLifecycle { .. }) => {
					tracing::warn!(
						extension_id = %activation.key.extension(),
						error = %error,
						"Python extension activation failed; containing failure",
					);
					self.frozen_registry.lock().remove(&(
						activation.identity.layer.clone(),
						activation.identity.tier.clone(),
						activation.identity.extension.clone(),
					));
					publish_host_down(activation, "extension activation failed");
					continue;
				},
				Err(error) => return Err(error),
			}
		}
		if let Some(gate) = self.lifecycle_gate.as_deref() {
			for manifest in self
				.lifecycle_manifests
				.iter()
				.filter(|manifest| activated.contains(manifest.provenance.extension_id()))
			{
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
		self
			.frozen_registry
			.lock()
			.get(&key)
			.filter(|evidence| same_control_identity(&evidence.identity, identity))
			.cloned()
	}

	/// Returns every currently sealed exact-generation registry for app-owned
	/// roster publication.
	pub fn sealed_registry_evidences(&self) -> Vec<Arc<SealedRegistryEvidence>> {
		self.frozen_registry.lock().values().cloned().collect()
	}

	/// Registers every frozen Python Director and Component with the engine.
	pub fn register_python_extensions(
		&self,
		registrar: &mut omp_agent::ExtensionRegistrar,
	) -> Result<Vec<crate::exthost::PyComponent>, crate::exthost::PyExtensionError> {
		let evidence = self.frozen_registry.lock();
		let mut components = Vec::new();
		for activation in &self.control_activations {
			let key = (
				activation.identity.layer.clone(),
				activation.identity.tier.clone(),
				activation.identity.extension.clone(),
			);
			let Some(sealed) = evidence.get(&key) else {
				continue;
			};
			components.extend(crate::exthost::extensions::register_python_extensions(
				registrar,
				&sealed.directors,
				&sealed.components,
				activation.python_route.clone(),
				None,
			)?);
		}
		Ok(components)
	}

	/// Returns every authenticated CONTROL identity, including hosts whose
	/// declaration freeze has not yet published registry evidence.
	pub fn control_identities(&self) -> Vec<Arc<ControlConnectionIdentity>> {
		self
			.live_controls
			.values()
			.map(|route| route.identity.read().clone())
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
			Some(ui_dispatch::Kind::Render(render)) => {
				if render.rev != "message@1" || render.name.is_empty() || render.call_id.is_empty() {
					return Err(ControlProtocolError::new(
						"InvalidUiDispatch",
						"message renderer dispatch has an invalid identity",
					));
				}
				let state: serde_json::Value = serde_json::from_slice(&render.state).map_err(|_| {
					ControlProtocolError::new(
						"InvalidUiDispatch",
						"message renderer state is not valid JSON",
					)
				})?;
				let mut state = state.as_object().cloned().ok_or_else(|| {
					ControlProtocolError::new(
						"InvalidUiDispatch",
						"message renderer state must be an object",
					)
				})?;
				let message = state.remove("message").ok_or_else(|| {
					ControlProtocolError::new(
						"InvalidUiDispatch",
						"message renderer state omitted message",
					)
				})?;
				let ctx = state.remove("ctx").unwrap_or_else(|| serde_json::json!({}));
				(
					sf!("omp.ui.message_renderer"),
					serde_json::Map::from_iter([
						("kind".to_owned(), serde_json::Value::String(render.name)),
						("message".to_owned(), message),
						("ctx".to_owned(), ctx),
					]),
					UiDispatchKind::MessageRenderer,
				)
			},
			_ => {
				return Err(ControlProtocolError::new(
					"InvalidUiDispatch",
					"typed UI callback route does not accept this payload",
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
				UiDispatchKind::MessageRenderer => {
					let source = value
						.as_object()
						.and_then(|value| value.get("source").or_else(|| value.get("_source")))
						.and_then(serde_json::Value::as_str);
					let rendered = source.map(|source| {
						ui_dispatch_result::Result::Rendered(RenderedView {
							content: Some(Tml {
								source: Bytes::copy_from_slice(source.as_bytes()),
								hash:   0,
							}),
							state:   Bytes::new(),
						})
					});
					(rendered, Vec::new())
				},
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

	/// Binds the active Agent mailbox's device availability destination.
	pub fn bind_availability_sink(&self, sink: Arc<dyn AvailabilitySink>) {
		let pending = {
			let mut availability_sink = self.availability_sink.lock();
			*availability_sink = Some(Arc::clone(&sink));
			mem::take(&mut *self.availability_pending.lock())
		};
		if !pending.is_empty() {
			sink.set_availability(AvailabilityBatch {
				deltas: pending.into_values().collect(),
			});
		}
	}

	/// Opens one invocation and establishes its host-owned request mapping.
	///
	/// CONTROL extension tools are not dispatched until the final
	/// [`ArgsCommitted`] frame arrives.
	///
	/// # Errors
	/// Returns [`ExtHostError::NotRegistered`] when no active extension owns the
	/// exact name/revision, or [`ExtHostError::Unavailable`] when its host actor
	/// has stopped.
	pub fn open(&self, call: ExtHostToolCall) -> Result<ExtHostInvocation, ExtHostError> {
		let route = self
			.routes
			.get(&(call.name.clone(), call.rev.clone()))
			.ok_or_else(|| ExtHostError::NotRegistered {
				name: call.name.clone(),
				rev:  call.rev.clone(),
			})?;
		let commands = route.commands.clone();
		let id = self.next_invocation.fetch_add(1, Ordering::Relaxed).max(1);
		let invocation_id = call.invocation_id.clone();
		if let Some(authority) = &self.data_authority {
			authority.open(route.owner.clone(), invocation_id.clone());
		}
		let (events_tx, events) = flume::unbounded();
		if commands
			.send(ControlHostCommand::Open {
				id,
				owner: route.owner.clone(),
				call,
				events: events_tx,
				callback_policy: route.callback_policy,
			})
			.is_err()
		{
			if let Some(authority) = &self.data_authority {
				authority.settle(&route.owner, invocation_id.as_str());
			}
			return Err(ExtHostError::Unavailable);
		}
		Ok(ExtHostInvocation {
			id,
			invocation_id,
			owner: route.owner.clone(),
			data_authority: self.data_authority.clone(),
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
	pub async fn reload_extension(&self, extension: &str) -> Result<u64, ExtHostError> {
		let host = self
			.actors
			.iter()
			.rev()
			.find(|host| host.reloadable && host.owners.iter().any(|owner| owner == extension))
			.ok_or(ExtHostError::Unavailable)?;
		reload_host(&host.commands).await
	}

	/// Drains idle extension hosts and replaces each with a hot-reload
	/// generation.
	pub async fn reload(&self) -> Result<Vec<u64>, ExtHostError> {
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
			let _ = host.commands.send(ControlHostCommand::Shutdown);
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
		if let Some(task) = self.quota_updates.lock().take() {
			task.abort();
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
				let _ = host.commands.send(ControlHostCommand::Shutdown);
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
	MessageRenderer,
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
			.ok_or(PromptDispatchError::MissingContext)?;
		let request_id = self.next_invocation.fetch_add(1, Ordering::Relaxed).max(1);
		let (reply, response) = flume::bounded(1);
		route
			.commands
			.send_async(ControlHostCommand::PromptPull {
				request_id,
				binding: binding.clone(),
				context: context.clone(),
				reply,
			})
			.await
			.map_err(|_| PromptDispatchError::MissingContext)?;
		response
			.recv_async()
			.await
			.map_err(|_| PromptDispatchError::MissingContext)?
	}
}

#[derive(Clone)]
struct PromptRoute {
	commands: flume::Sender<ControlHostCommand>,
}

#[derive(Clone)]
struct HostRoute {
	commands:           flume::Sender<ControlHostCommand>,
	owner:              HostKey,
	maximum_effects:    omp_tool::Effects,
	callback_policy:    CallbackConcurrency,
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

	const ID: HookEventId = HookEventId::HookEventResourcesChanged;
	const REV: u32 = 1;

	fn encode_into(&self, out: &mut BytesMut) {
		out.extend_from_slice(b"\n");
		out.extend_from_slice(br#"{"added":[],"removed":[],"reason":"extension_changed"}"#);
	}

	fn apply(&mut self, _: &HookPatch) -> Result<(), GateError> {
		Ok(())
	}
}

async fn reload_host(commands: &flume::Sender<ControlHostCommand>) -> Result<u64, ExtHostError> {
	let (reply, response) = flume::bounded(1);
	commands
		.send_async(ControlHostCommand::Reload { reply })
		.await
		.map_err(|_| ExtHostError::Unavailable)?;
	response
		.recv_async()
		.await
		.map_err(|_| ExtHostError::Unavailable)?
}

fn spawn_link_watcher(
	root: &Path,
	extension: Str,
	commands: flume::Sender<ControlHostCommand>,
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
									&& gate.subscribed(HookEventId::HookEventResourcesChanged)
								{
									gate.notify(&ResourcesChangedEvent);
								}
								break;
							},
							Err(ExtHostError::Unavailable) => {
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
	commands:   flume::Sender<ControlHostCommand>,
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

/// Extension-host startup, routing, and lifecycle failure.
#[derive(Debug, Error)]
pub enum ExtHostError {
	/// An authenticated extension-host contract was violated.
	#[error("Python extension host protocol violation: {0}")]
	Protocol(Str),
	/// No configured extension registered the requested exact tool identity.
	#[error("no extension host registered tool {name} at revision {rev}")]
	NotRegistered {
		/// Requested tool name.
		name: Str,
		/// Requested tool revision.
		rev:  Str,
	},
	/// A Python extension declaration or activation generation failed.
	#[error("Python extension {extension} lifecycle failed")]
	ExtensionLifecycle {
		/// Extension whose generation was quarantined.
		extension: Str,
		/// Typed lifecycle transition failure.
		#[source]
		source:    crate::exthost::LifecycleError,
	},
	/// The extension-host supervisor is no longer available.
	#[error("Python extension host supervisor is unavailable")]
	Unavailable,
	/// Named-worker routing refused immediate placement.
	#[error(transparent)]
	WorkerUnavailable(#[from] WorkerUnavailable),
}

enum ControlHostCommand {
	Open {
		id:              u64,
		owner:           HostKey,
		call:            ExtHostToolCall,
		events:          flume::Sender<ExtHostEvent>,
		callback_policy: CallbackConcurrency,
	},
	ArgsCommitted {
		id:    u64,
		frame: ArgsCommitted,
	},
	ServiceDispatch {
		dispatch: ServiceDispatch,
		reply:    flume::Sender<Result<ServiceResponse, ExtHostError>>,
	},
	PromptPull {
		request_id: u64,
		binding:    PromptSlotBinding,
		context:    PromptPullContext,
		reply:      flume::Sender<Result<PromptContributionRecord, PromptDispatchError>>,
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
		reply: flume::Sender<Result<u64, ExtHostError>>,
	},
	Shutdown,
}

struct PendingInvocation {
	call:            ExtHostToolCall,
	events:          flume::Sender<ExtHostEvent>,
	callback_policy: CallbackConcurrency,
}

fn validate_extension_spec(spec: &ExtHostSpec) -> Result<(), ExtHostError> {
	if spec.key.layer().is_empty()
		|| spec.key.tier().is_empty()
		|| spec.key.extension().is_empty()
		|| spec.manifest.entry.is_empty()
	{
		return Err(ExtHostError::Protocol(sf!(
			"extension host identity and manifest entry must be nonempty",
		)));
	}
	if spec.manifest.provenance.extension_id() != spec.key.extension().as_str()
		|| spec.manifest.provenance.layer() != spec.key.layer().as_str()
		|| spec.manifest.provenance.tier() != spec.key.tier().as_str()
	{
		return Err(ExtHostError::Protocol(sf!(
			"extension manifest provenance does not match its authenticated host key",
		)));
	}
	Ok(())
}

fn hard_tool_granted(spec: &ExtHostSpec, name: &str) -> bool {
	if spec.manifest.runtime_declarations_trusted() {
		return true;
	}
	let declarations = spec.manifest.static_declarations();
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
	if spec.key.layer() == "native" {
		return true;
	}
	declarations
		.capability_grants
		.get("tools.hard")
		.or_else(|| {
			declarations
				.capability_grants
				.get("tools")
				.and_then(|tools| tools.get("hard"))
		})
		.and_then(serde_json::Value::as_array)
		.is_some_and(|names| names.iter().any(|granted| granted.as_str() == Some(name)))
}

async fn activate_control_generation(
	activation: &PendingControlActivation,
	control: ControlHandle,
	host_generation: u64,
	cause: ActivationCause,
	frozen_registry: Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
) -> Result<(), ExtHostError> {
	let mut identity = (*activation.identity).clone();
	identity.host_generation = host_generation;
	let identity = Arc::new(identity);
	let mut lifecycle = activation
		.manifest
		.lifecycle(activation.session_started_at, activation.session_generation);
	if !activation
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
			ExtHostError::Protocol(sf!("extension host omitted sealed UI registry evidence"))
		})?;
		registration.generation = host_generation;
		lifecycle
			.register_ui(registration, GenerationFence {
				host:    host_generation,
				session: activation.session_generation,
			})
			.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	}
	let mut host = FrozenControlLifecycleHost::new(
		control,
		activation.key.extension().clone(),
		activation.session_id.clone(),
		host_generation,
		identity,
		activation.manifest.clone(),
		frozen_registry,
		activation.settings.clone(),
		activation.cli_contributions.clone(),
		Arc::clone(&activation.contributed_values),
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
		.map_err(|source| ExtHostError::ExtensionLifecycle {
			extension: activation.key.extension().clone(),
			source,
		})
}
fn advance_control_activation(activation: &mut PendingControlActivation, running: &RunningHost) {
	let mut identity = (*activation.identity).clone();
	identity.host_generation = running.generation();
	activation.control = running.control();
	activation.identity = Arc::new(identity);
}

fn publish_python_generation(activation: &PendingControlActivation, running: &RunningHost) {
	activation.python_route.replace(
		running.control(),
		python_registration_authority(
			&activation.key,
			&activation.session_id,
			running.generation(),
			&activation.settings,
		),
	);
}
fn next_control_authority(
	activation: &PendingControlActivation,
	running: &RunningHost,
) -> Result<Arc<dyn ControlAuthority>, ExtHostError> {
	let generation = running
		.generation()
		.checked_add(1)
		.ok_or_else(|| ExtHostError::Protocol(sf!("extension host generation is exhausted")))?;
	let mut identity = (*activation.identity).clone();
	identity.host_generation = generation;
	activation
		.host_factory
		.bind_with_agents(Arc::new(identity), Arc::clone(&activation.agents_factory))
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))
}
fn text_part(text: String) -> Part {
	Part { kind: Some(part::Kind::Text(text)) }
}

const CONTROL_RESULT_INLINE_BYTES: usize = 64 * 1024;

fn control_result_storage(
	store: Option<&BlobHost>,
	session: &str,
	call_id: &str,
	details: Bytes,
) -> Result<(Option<Bytes>, Option<Blob>), ExtHostError> {
	if details.len() <= CONTROL_RESULT_INLINE_BYTES {
		return Ok((Some(details), None));
	}
	let store = store.ok_or_else(|| {
		ExtHostError::Protocol(sf!("oversized CONTROL result has no environment result store"))
	})?;
	let blob = store
		.put_verdict_bytes(Some(session), call_id, &details)
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	Ok((None, Some(blob)))
}

fn control_completion(
	call_id: Str,
	result: serde_json::Value,
	store: Option<&BlobHost>,
	session: &str,
) -> Result<ExtHostCompletion, ExtHostError> {
	if result.as_object().is_some_and(|completion| {
		["parts", "details", "is_error", "terminate", "args_issue"]
			.iter()
			.any(|key| completion.contains_key(*key))
	}) && let serde_json::Value::Object(mut completion) = result
	{
		if let Some(serde_json::Value::Object(issue)) = completion.remove("args_issue") {
			let path = issue
				.get("path")
				.and_then(serde_json::Value::as_array)
				.into_iter()
				.flatten()
				.filter_map(serde_json::Value::as_str)
				.map(str::to_owned)
				.collect();
			let field = |name| {
				issue
					.get(name)
					.and_then(serde_json::Value::as_str)
					.unwrap_or_default()
					.to_owned()
			};
			let optional = |name| {
				issue
					.get(name)
					.and_then(serde_json::Value::as_str)
					.map(str::to_owned)
			};
			return Ok(ExtHostCompletion {
				call_id,
				kind: ExtHostOutcomeKind::ArgsRejected,
				parts: Vec::new(),
				details_json: Some(Bytes::from(
					serde_json::to_vec(&issue).expect("serializing an existing JSON value cannot fail"),
				)),
				details_blob: None,
				args_issue: Some(ArgIssue {
					path,
					expected: field("expected"),
					kind: field("kind"),
					example: optional("example"),
					found: optional("found"),
					props: None,
				}),
				useless: false,
				terminate: false,
			});
		}
		let parts = match completion.remove("parts") {
			Some(serde_json::Value::Array(parts)) => parts
				.into_iter()
				.map(|part| {
					part
						.as_str()
						.map(|text| text_part(text.to_owned()))
						.ok_or_else(|| {
							ExtHostError::Protocol(sf!(
								"CONTROL completion parts must contain only strings"
							))
						})
				})
				.collect::<Result<Vec<_>, _>>()?,
			Some(_) => {
				return Err(ExtHostError::Protocol(sf!("CONTROL completion parts must be an array")));
			},
			None => Vec::new(),
		};
		let details = completion
			.remove("details")
			.unwrap_or(serde_json::Value::Null);
		let is_error = match completion.remove("is_error") {
			Some(serde_json::Value::Bool(is_error)) => is_error,
			Some(_) => {
				return Err(ExtHostError::Protocol(sf!("CONTROL completion is_error must be boolean")));
			},
			None => false,
		};
		let terminate = match completion.remove("terminate") {
			Some(serde_json::Value::Bool(terminate)) => terminate,
			Some(_) => {
				return Err(ExtHostError::Protocol(sf!(
					"CONTROL completion terminate must be boolean"
				)));
			},
			None => false,
		};
		let details = Bytes::from(
			serde_json::to_vec(&details).expect("serializing an existing JSON value cannot fail"),
		);
		let (details_json, details_blob) =
			control_result_storage(store, session, call_id.as_str(), details)?;
		let parts = if details_blob.is_some()
			&& parts
				.iter()
				.map(|part| match part.kind.as_ref() {
					Some(part::Kind::Text(text)) => text.len(),
					_ => 0,
				})
				.sum::<usize>()
				> CONTROL_RESULT_INLINE_BYTES
		{
			Vec::new()
		} else {
			parts
		};
		return Ok(ExtHostCompletion {
			call_id,
			kind: if is_error {
				ExtHostOutcomeKind::Faulted
			} else {
				ExtHostOutcomeKind::Ok
			},
			parts,
			details_json,
			details_blob,
			args_issue: None,
			useless: false,
			terminate,
		});
	}

	let details = Bytes::from(
		serde_json::to_vec(&result).expect("serializing an existing JSON value cannot fail"),
	);
	let (details_json, details_blob) =
		control_result_storage(store, session, call_id.as_str(), details)?;
	let parts = if details_blob.is_some() {
		Vec::new()
	} else {
		let text = match result {
			serde_json::Value::String(text) => text,
			value => serde_json::to_string(&value)
				.expect("serializing an existing JSON value cannot fail"),
		};
		vec![text_part(text)]
	};
	Ok(ExtHostCompletion {
		call_id,
		kind: ExtHostOutcomeKind::Ok,
		parts,
		details_json,
		details_blob,
		args_issue: None,
		useless: false,
		terminate: false,
	})
}

fn install_hook_evidence(
	hooks: &HookControlFactory,
	identity: &Arc<ControlConnectionIdentity>,
	session: &Str,
	evidence: &SealedRegistryEvidence,
) -> Result<(), ExtHostError> {
	for hook in evidence.hooks.iter() {
		hooks
			.subscribe(HookSubscription {
				identity:     Arc::clone(identity),
				session:      session.clone(),
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
			.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	}
	Ok(())
}

fn install_control_hooks(
	activation: &PendingControlActivation,
	evidence: &SealedRegistryEvidence,
) -> Result<(), ExtHostError> {
	let Some(hooks) = activation.hook_control.as_deref() else {
		return Ok(());
	};
	install_hook_evidence(hooks, &activation.identity, &activation.session_id, evidence)
}

const CONTROL_RESTART_INITIAL: Duration = Duration::from_secs(1);
const CONTROL_RESTART_MAXIMUM: Duration = Duration::from_secs(30);
const CONTROL_RESTART_HEALTHY: Duration = Duration::from_secs(30);
const CONTROL_RESTART_FAILURE_LIMIT: u8 = 4;

struct ControlRestartBreaker {
	next:          Duration,
	failures:      u8,
	healthy_since: std::time::Instant,
}

impl ControlRestartBreaker {
	fn new() -> Self {
		Self {
			next: CONTROL_RESTART_INITIAL,
			failures: 0,
			healthy_since: std::time::Instant::now(),
		}
	}

	fn failed(&mut self) -> Option<Duration> {
		if self.healthy_since.elapsed() >= CONTROL_RESTART_HEALTHY {
			self.next = CONTROL_RESTART_INITIAL;
			self.failures = 0;
		}
		self.failures = self.failures.saturating_add(1);
		if self.failures > CONTROL_RESTART_FAILURE_LIMIT {
			return None;
		}
		let delay = self.next;
		self.next = self.next.saturating_mul(2).min(CONTROL_RESTART_MAXIMUM);
		Some(delay)
	}

	fn restored(&mut self) {
		self.healthy_since = std::time::Instant::now();
	}
}

fn abort_control_invocation(
	invocation: PendingInvocation,
	reason: &'static str,
	effects_unknown: bool,
) {
	let _ = invocation.events.send(ExtHostEvent::Aborted(ExtHostAbort {
		call_id: invocation.call.invocation_id,
		kind: ExtHostAbortKind::Crashed,
		reason: Str::new_static(reason),
		effects_unknown,
	}));
}

fn reject_queued_control_commands(
	mailbox: &Receiver<ControlHostCommand>,
	reason: &'static str,
) {
	while let Ok(command) = mailbox.try_recv() {
		match command {
			ControlHostCommand::Open { call, events, .. } => {
				let _ = events.send(ExtHostEvent::Aborted(ExtHostAbort {
					call_id: call.invocation_id,
					kind: ExtHostAbortKind::Crashed,
					reason: Str::new_static(reason),
					effects_unknown: false,
				}));
			},
			ControlHostCommand::ServiceDispatch { reply, .. } => {
				let _ = reply.send(Err(ExtHostError::Unavailable));
			},
			ControlHostCommand::PromptPull { reply, .. } => {
				let _ = reply.send(Err(PromptDispatchError::Control(
					ControlRuntimeError::Protocol(ControlProtocolError::new(
						"host_disabled",
						reason,
					)),
				)));
			},
			ControlHostCommand::Reload { reply } => {
				let _ = reply.send(Err(ExtHostError::Unavailable));
			},
			ControlHostCommand::ArgsCommitted { .. }
			| ControlHostCommand::Cancel { .. }
			| ControlHostCommand::Interrupt { .. }
			| ControlHostCommand::Shutdown => {},
		}
	}
}

async fn run_control_supervisor(
	mut running: RunningHost,
	owner: HostKey,
	session_id: Str,
	session_generation: u64,
	mailbox: Receiver<ControlHostCommand>,
	host_generation: Arc<AtomicU64>,
	shutdown: CancellationToken,
	activation: PendingControlActivation,
	frozen_registry: Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
	live_control: Arc<LiveControlRoute>,
	service_router: Arc<ServiceRouter>,
	result_store: Option<BlobHost>,
) {
	use std::time::Instant;

	let mut activation = activation;
	let mut pending = BTreeMap::<u64, PendingInvocation>::new();
	let in_flight = Arc::new(Mutex::new(BTreeMap::<u64, Str>::new()));
	let cancelled = Arc::new(Mutex::new(BTreeSet::<u64>::new()));
	let mut exit_poll = time::interval(Duration::from_millis(50));
	exit_poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
	let mut breaker = ControlRestartBreaker::new();
	'supervision: loop {
		let command = tokio::select! {
			() = shutdown.cancelled() => break,
			command = mailbox.recv_async() => match command {
				Ok(command) => Some(command),
				Err(_) => break,
			},
			_ = exit_poll.tick() => None,
		};
		let Some(command) = command else {
			if running.has_exited().unwrap_or(true) {
				if running.is_disabled() {
					break 'supervision;
				}
				if let Some(gate) = activation.lifecycle_gate.as_deref() {
					notify_extension_unload(gate, activation.key.extension(), "error", 0);
				}
				publish_host_down(&activation, "extension host crashed");
				for invocation in mem::take(&mut pending).into_values() {
					abort_control_invocation(
						invocation,
						"extension host crashed before dispatch",
						false,
					);
				}
				loop {
					reject_queued_control_commands(
						&mailbox,
						"CONTROL extension host is restarting",
					);
					let Some(delay) = breaker.failed() else {
						tracing::error!(
							extension_id = %activation.key.extension(),
							failures = CONTROL_RESTART_FAILURE_LIMIT,
							"Python extension restart breaker opened",
						);
						break 'supervision;
					};
					tokio::select! {
						() = shutdown.cancelled() => break 'supervision,
						() = time::sleep(delay) => {},
					}
					let authority = match next_control_authority(&activation, &running) {
						Ok(authority) => authority,
						Err(error) => {
							tracing::warn!(
								extension_id = %activation.key.extension(),
								%error,
								"Python extension replacement authority failed",
							);
							continue;
						},
					};
					let connected_at = Instant::now();
					let restarted = tokio::select! {
						() = shutdown.cancelled() => break 'supervision,
						result = running.restart_with_authority(authority) => result,
					};
					let restored = match restarted {
						Ok(()) => {
							refresh_control_generation(
								&mut activation,
								&running,
								&host_generation,
								&live_control,
								&frozen_registry,
								&service_router,
								ActivationCause::Restart(RestartReason::Crash),
								false,
								connected_at,
							)
							.await
						},
						Err(error) => Err(ExtHostError::Protocol(Str::from(error.to_string()))),
					};
					match restored {
						Ok(()) => {
							breaker.restored();
							break;
						},
						Err(error) => {
							tracing::warn!(
								extension_id = %activation.key.extension(),
								%error,
								"Python extension replacement failed verification",
							);
						},
					}
				}
			}
			continue;
		};
		match command {
			ControlHostCommand::Open { id, owner: request_owner, call, events, callback_policy }
				if request_owner == owner =>
			{
				pending.insert(id, PendingInvocation { call, events, callback_policy });
			},
			ControlHostCommand::ArgsCommitted { id, frame } => {
				let Some(invocation) = pending.remove(&id) else {
					continue;
				};
				let args = match serde_json::from_slice::<serde_json::Value>(&frame.raw) {
					Ok(serde_json::Value::Object(args)) => args,
					Ok(_) | Err(_) => {
						let _ = invocation
							.events
							.send(ExtHostEvent::ProtocolError(ProtocolError {
								code:    ProtocolErrorCode::InvalidArgument.into(),
								message: sf!("committed extension arguments are not a JSON object")
									.to_string(),
								props:   None,
							}));
						continue;
					},
				};
				let revision = match invocation.call.rev.parse::<omp_tool::Rev>() {
					Ok(revision) => revision,
					Err(error) => {
						let _ = invocation
							.events
							.send(ExtHostEvent::ProtocolError(ProtocolError {
								code:    ProtocolErrorCode::InvalidArgument.into(),
								message: sf!("extension tool revision is invalid: {error}").to_string(),
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
				arguments.insert(
					String::from("family"),
					serde_json::Value::String(revision.family.to_string()),
				);
				arguments.insert(String::from("rev"), serde_json::Value::from(revision.n));
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
				let dispatch = ControlDispatch {
					operation: sf!("omp.devices.call"),
					arguments,
					authority: ControlInvocationAuthority {
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
					},
					policy: invocation.callback_policy,
					deadline: EventDeadline { at: Instant::now() + invocation.call.deadline },
				};
				in_flight
					.lock()
					.insert(id, invocation.call.invocation_id.clone());
				let control = activation.control.clone();
				let store = result_store.clone();
				let result_session = session_id.clone();
				let task_in_flight = Arc::clone(&in_flight);
				let task_cancelled = Arc::clone(&cancelled);
				tokio::spawn(async move {
					let (progress_tx, progress_rx) = flume::bounded(64);
					let progress_events = invocation.events.clone();
					let progress_call = invocation.call.invocation_id.clone();
					let progress = tokio::spawn(async move {
						while let Ok(update) = progress_rx.recv_async().await {
							let json = match serde_json::to_vec(&update) {
								Ok(json) => json,
								Err(_) => break,
							};
							if progress_events
								.send_async(ExtHostEvent::Update(ToolUpdate {
									call_id: progress_call.to_string(),
									json:    json.into(),
									props:   None,
								}))
								.await
								.is_err()
							{
								break;
							}
						}
					});
					let result = control.dispatch_with_progress(dispatch, progress_tx).await;
					let _ = progress.await;
					let was_cancelled = task_cancelled.lock().remove(&id);
					if was_cancelled {
						let _ = invocation.events.send(ExtHostEvent::Aborted(ExtHostAbort {
							call_id:         invocation.call.invocation_id,
							kind:            ExtHostAbortKind::Cancelled,
							reason:          sf!("extension invocation cancelled"),
							effects_unknown: true,
						}));
					} else {
						match result {
							Ok(result) => {
								send_control_result(&invocation, result, store, result_session).await
							},
							Err(error) => {
								let _ = invocation.events.send(ExtHostEvent::Aborted(ExtHostAbort {
									call_id:         invocation.call.invocation_id,
									kind:            ExtHostAbortKind::Crashed,
									reason:          Str::from(error.to_string()),
									effects_unknown: true,
								}));
							},
						}
					}
					task_in_flight.lock().remove(&id);
				});
			},
			ControlHostCommand::Cancel { id, reason } => {
				if let Some(invocation) = pending.remove(&id) {
					let _ = invocation.events.send(ExtHostEvent::Aborted(ExtHostAbort {
						call_id: invocation.call.invocation_id,
						kind: ExtHostAbortKind::Cancelled,
						reason,
						effects_unknown: false,
					}));
				} else {
					let invocation = { in_flight.lock().get(&id).cloned() };
					if let Some(invocation) = invocation {
						cancelled.lock().insert(id);
						let connected_at = Instant::now();
						match running.cancel_dispatch(invocation.as_str()).await {
							Ok(CancellationOutcome::Killed(_)) => {
								publish_host_down(
									&activation,
									"extension host restarted after cancellation",
								);
								let replacement = async {
									let authority = next_control_authority(&activation, &running)?;
									running
										.restart_with_authority(authority)
										.await
										.map_err(|error| {
											ExtHostError::Protocol(Str::from(error.to_string()))
										})?;
									refresh_control_generation(
										&mut activation,
										&running,
										&host_generation,
										&live_control,
										&frozen_registry,
										&service_router,
										ActivationCause::Restart(RestartReason::CancelEscalation),
										false,
										connected_at,
									)
									.await
								}
								.await;
								if let Err(error) = replacement {
									tracing::warn!(
										extension_id = %activation.key.extension(),
										%error,
										"cancelled extension host could not install a verified replacement",
									);
									break;
								}
								breaker.restored();
							},
							Ok(CancellationOutcome::Disabled(_)) | Err(_) => break,
							Ok(
								CancellationOutcome::DispatchCancel | CancellationOutcome::InterruptThread,
							) => {},
						}
					}
				}
			},
			ControlHostCommand::Interrupt { id, .. } => {
				let invocation = { in_flight.lock().get(&id).cloned() };
				if let Some(invocation) = invocation {
					cancelled.lock().insert(id);
					let _ = activation
						.python_route
						.cancel_dispatch(invocation.as_str())
						.await;
				}
			},
			ControlHostCommand::ServiceDispatch { dispatch, reply } => {
				let result = dispatch_control_service(&activation, dispatch).await;
				let _ = reply.send(result);
			},
			ControlHostCommand::PromptPull { request_id, binding, context, reply } => {
				let result = dispatch_control_prompt(&activation, request_id, binding, context).await;
				let _ = reply.send(result);
			},
			ControlHostCommand::Reload { reply } => {
				if !pending.is_empty() || !in_flight.lock().is_empty() {
					let _ = reply.send(Err(ExtHostError::Unavailable));
					continue;
				}
				if let Some(gate) = activation.lifecycle_gate.as_deref() {
					notify_extension_unload(gate, activation.key.extension(), "reload", 0);
				}
				publish_host_down(&activation, "extension host is reloading");
				let connected_at = Instant::now();
				let result = async {
					let authority = next_control_authority(&activation, &running)?;
					running
						.restart_with_authority(authority)
						.await
						.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
					refresh_control_generation(
						&mut activation,
						&running,
						&host_generation,
						&live_control,
						&frozen_registry,
						&service_router,
						ActivationCause::Restart(RestartReason::HotReload),
						true,
						connected_at,
					)
					.await?;
					Ok(running.generation())
				}
				.await;
				let failed = result.is_err();
				if !failed {
					breaker.restored();
				}
				let _ = reply.send(result);
				if failed {
					break;
				}
			},
			ControlHostCommand::Shutdown => break,
			ControlHostCommand::Open { events, call, .. } => {
				let _ = events.send(ExtHostEvent::Aborted(ExtHostAbort {
					call_id:         call.invocation_id,
					kind:            ExtHostAbortKind::Crashed,
					reason:          sf!("CONTROL route owner did not match"),
					effects_unknown: false,
				}));
			},
		}
	}
	publish_host_down(&activation, "extension host is unavailable");
	if let Some(gate) = activation.lifecycle_gate.as_deref() {
		notify_extension_unload(gate, activation.key.extension(), "shutdown", 0);
	}
	for invocation in pending.into_values() {
		abort_control_invocation(
			invocation,
			"CONTROL supervisor stopped before dispatch",
			false,
		);
	}
	reject_queued_control_commands(&mailbox, "CONTROL extension host was disabled");
	cancelled.lock().extend(in_flight.lock().keys().copied());
	running.shutdown().await;
}

async fn refresh_control_generation(
	activation: &mut PendingControlActivation,
	running: &RunningHost,
	host_generation: &AtomicU64,
	live_control: &LiveControlRoute,
	frozen_registry: &Arc<Mutex<BTreeMap<(Str, Str, Str), Arc<SealedRegistryEvidence>>>>,
	service_router: &ServiceRouter,
	cause: ActivationCause,
	hot_reload: bool,
	connected_at: std::time::Instant,
) -> Result<(), ExtHostError> {
	advance_control_activation(activation, running);
	let receipt = activation
		.quota_runtime
		.receipt(activation.session_id.as_str(), &activation.key)
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	running
		.control()
		.install_resource_receipt(&receipt)
		.await
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	let evidence = freeze_control_registry(
		running.control(),
		Arc::clone(&activation.identity),
		activation.session_id.clone(),
		&activation.manifest,
		&activation.settings,
	)
	.await?;
	if let Some(previous) = frozen_registry.lock().get(&(
		activation.identity.layer.clone(),
		activation.identity.tier.clone(),
		activation.identity.extension.clone(),
	)) && !previous.same_declarations(&evidence)
	{
		return Err(ExtHostError::Protocol(sf!(
			"replacement extension host changed the sealed declaration set"
		)));
	}
	let evidence = activation
		.registry_control
		.install_evidence(evidence)
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	*activation.registered_ui.write() = Some(evidence.ui_registration.clone());
	activate_control_generation(
		activation,
		running.control(),
		running.generation(),
		cause,
		Arc::clone(frozen_registry),
	)
	.await?;
	let evidence = frozen_registry
		.lock()
		.get(&(
			activation.identity.layer.clone(),
			activation.identity.tier.clone(),
			activation.identity.extension.clone(),
		))
		.cloned()
		.ok_or_else(|| {
			ExtHostError::Protocol(sf!("CONTROL child omitted sealed registry evidence"))
		})?;
	install_control_hooks(activation, &evidence)?;
	publish_host_availability(activation, &evidence);
	publish_python_generation(activation, running);
	*live_control.control.write() = running.control();
	*live_control.identity.write() = Arc::clone(&activation.identity);
	host_generation.store(running.generation(), Ordering::Release);
	{
		let mut broker = service_router.broker.lock();
		broker.deactivate_provider(&activation.key, "provider process restarted");
		broker
			.activate_provider_declarations(
				&activation.key,
				running.generation(),
				evidence.services.iter().cloned(),
			)
			.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	}
	if let Some(gate) = activation.lifecycle_gate.as_deref() {
		notify_extension_load(gate, &activation.manifest.provenance, hot_reload);
		notify_host_reconnect(
			gate,
			running.generation(),
			0,
			match cause {
				ActivationCause::Restart(reason) => reason,
				ActivationCause::FirstReach => RestartReason::Crash,
			},
			connected_at.elapsed(),
		);
	}
	Ok(())
}

async fn send_control_result(
	invocation: &PendingInvocation,
	result: serde_json::Value,
	store: Option<BlobHost>,
	session: Str,
) {
	let call_id = invocation.call.invocation_id.clone();
	let completion = tokio::task::spawn_blocking(move || {
		control_completion(call_id, result, store.as_ref(), session.as_str())
	})
	.await;
	match completion {
		Ok(Ok(completion)) => {
			let _ = invocation.events.send(ExtHostEvent::Complete(completion));
		},
		Ok(Err(error)) => {
			let _ = invocation.events.send(ExtHostEvent::Aborted(ExtHostAbort {
				call_id:         invocation.call.invocation_id.clone(),
				kind:            ExtHostAbortKind::Crashed,
				reason:          Str::from(error.to_string()),
				effects_unknown: true,
			}));
		},
		Err(error) => {
			let _ = invocation.events.send(ExtHostEvent::Aborted(ExtHostAbort {
				call_id:         invocation.call.invocation_id.clone(),
				kind:            ExtHostAbortKind::Crashed,
				reason:          Str::from(error.to_string()),
				effects_unknown: true,
			}));
		},
	}
}
async fn dispatch_control_prompt(
	activation: &PendingControlActivation,
	request_id: u64,
	binding: PromptSlotBinding,
	context: PromptPullContext,
) -> Result<PromptContributionRecord, PromptDispatchError> {
	let arguments = prompt_dispatch_arguments(&binding, &context)?;
	let mut authority = activation.python_route.authority();
	authority.invocation = sf!(
		"prompt:{}:{}:{request_id}",
		activation.key.extension(),
		activation.identity.host_generation,
	);
	authority.event = Some(sf!("prompt.render"));
	let result = activation
		.python_route
		.dispatch(ControlDispatch {
			operation: sf!("omp.prompts.render"),
			arguments,
			authority,
			policy: CallbackConcurrency::Serialized,
			deadline: EventDeadline { at: std::time::Instant::now() + Duration::from_secs(5) },
		})
		.await
		.map_err(PromptDispatchError::Control)?;
	decode_prompt_contribution(result, &binding)
}

async fn dispatch_control_service(
	activation: &PendingControlActivation,
	dispatch: ServiceDispatch,
) -> Result<ServiceResponse, ExtHostError> {
	let payload: serde_json::Value = serde_json::from_slice(dispatch.payload.as_ref())
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	let payload = payload
		.as_object()
		.ok_or_else(|| ExtHostError::Protocol(sf!("service payload is not a JSON object")))?;
	let args = payload
		.get("args")
		.and_then(serde_json::Value::as_array)
		.cloned()
		.ok_or_else(|| ExtHostError::Protocol(sf!("service payload omitted args")))?;
	let kwargs = payload
		.get("kwargs")
		.and_then(serde_json::Value::as_object)
		.cloned()
		.ok_or_else(|| ExtHostError::Protocol(sf!("service payload omitted kwargs")))?;
	let request_id = dispatch.id.0;
	let deadline = dispatch
		.meta
		.deadline
		.to_std()
		.map_err(|_| ExtHostError::Protocol(sf!("service deadline exceeds host duration")))?;
	let mut authority = activation.python_route.authority();
	authority.invocation = sf!(
		"service:{}:{}:{request_id}",
		activation.key.extension(),
		activation.identity.host_generation,
	);
	authority.event = Some(sf!("service.dispatch"));
	authority.call = Some(sf!("{request_id}"));
	let result = activation
		.python_route
		.dispatch(ControlDispatch {
			operation: sf!("omp.services.dispatch"),
			arguments: serde_json::Map::from_iter([
				("request_id".to_owned(), serde_json::Value::from(request_id)),
				("name".to_owned(), serde_json::Value::String(dispatch.route.service.name.to_string())),
				("rev".to_owned(), serde_json::Value::from(dispatch.route.service.rev)),
				("method".to_owned(), serde_json::Value::String(dispatch.method.to_string())),
				("args".to_owned(), serde_json::Value::Array(args)),
				("kwargs".to_owned(), serde_json::Value::Object(kwargs)),
			]),
			authority,
			policy: CallbackConcurrency::Serialized,
			deadline: EventDeadline { at: std::time::Instant::now() + deadline },
		})
		.await
		.map_err(|error| ExtHostError::Protocol(Str::from(error.to_string())))?;
	let values = result
		.as_array()
		.filter(|values| values.len() == 2)
		.ok_or_else(|| ExtHostError::Protocol(sf!("service callback returned an invalid result")))?;
	if values[0].as_u64() != Some(request_id) {
		return Err(ExtHostError::Protocol(sf!("service callback returned a stale correlation")));
	}
	Ok(ServiceResponse::Success(CowBytes::from(
		serde_json::to_vec(&values[1]).expect("serializing an existing JSON value cannot fail"),
	)))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn control_tools_reject_streamed_argument_declarations() {
		let committed = ToolDecl::default();
		assert!(ensure_committed_argument_tools(&[committed]).is_ok());

		let streamed = ToolDecl {
			definition: Some(omp_proto::inference::v1::ToolDef {
				name: "streaming".to_owned(),
				..Default::default()
			}),
			streams_args: true,
			..Default::default()
		};
		let error = ensure_committed_argument_tools(&[streamed])
			.expect_err("CONTROL registration must reject streamed arguments");
		assert!(matches!(error, ExtHostError::Protocol(_)));
	}

	#[test]
	fn control_restart_breaker_is_bounded_and_resets_after_health() {
		let mut breaker = ControlRestartBreaker::new();
		let delays = (0..CONTROL_RESTART_FAILURE_LIMIT)
			.map(|_| breaker.failed().expect("breaker remains closed within its limit"))
			.collect::<Vec<_>>();
		assert_eq!(
			delays,
			[
				Duration::from_secs(1),
				Duration::from_secs(2),
				Duration::from_secs(4),
				Duration::from_secs(8),
			]
		);
		assert!(breaker.failed().is_none());
		breaker.healthy_since = std::time::Instant::now() - CONTROL_RESTART_HEALTHY;
		assert_eq!(breaker.failed(), Some(CONTROL_RESTART_INITIAL));
	}

	#[test]
	fn terminal_breaker_fails_queued_invocations() {
		let (commands, mailbox) = flume::unbounded();
		let (events, received) = flume::unbounded();
		commands
			.send(ControlHostCommand::Open {
				id: 1,
				owner: HostKey::new("project", "trusted", "broken"),
				call: ExtHostToolCall {
					invocation_id: sf!("queued"),
					name: sf!("tool"),
					rev: sf!("1"),
					deadline: Duration::from_secs(1),
				},
				events,
				callback_policy: CallbackConcurrency::Threadsafe,
			})
			.expect("queue invocation");
		reject_queued_control_commands(&mailbox, "breaker open");
		let ExtHostEvent::Aborted(abort) = received.recv().expect("queued terminal abort") else {
			panic!("queued invocation did not receive terminal abort");
		};
		assert_eq!(abort.call_id, "queued");
		assert_eq!(abort.kind, ExtHostAbortKind::Crashed);
		assert!(!abort.effects_unknown);
	}

	#[test]
	fn oversized_control_result_spills_without_inline_copy() {
		let scratch = tempfile::tempdir().expect("result store scratch");
		let store = BlobHost::open(scratch.path()).expect("result store");
		let value = serde_json::Value::String("x".repeat(CONTROL_RESULT_INLINE_BYTES + 1));
		let completion = control_completion(sf!("large"), value, Some(&store), "session")
			.expect("spill oversized result");
		assert!(completion.details_json.is_none());
		let blob = completion.details_blob.expect("result blob");
		assert!(blob.size > CONTROL_RESULT_INLINE_BYTES as u64);
	}

	#[test]
	fn control_invocation_rejects_argument_fragments() {
		let (commands, _mailbox) = flume::bounded(1);
		let (_events_tx, events) = flume::bounded(1);
		let invocation = ExtHostInvocation {
			id: 1,
			invocation_id: sf!("call"),
			host_generation: 1,
			session_generation: 1,
			owner: HostKey::new(sf!("project"), sf!("trusted"), sf!("extension")),
			maximum_effects: omp_tool::Effects::default(),
			data_authority: None,
			events,
			commands,
			committed: false,
			terminal: false,
			cancel_requested: false,
		};

		assert!(!invocation.streams_args());
		let error = invocation
			.arg_text(ArgText { invocation_id: "call".to_owned(), ..Default::default() })
			.expect_err("CONTROL invocation must reject argument fragments");
		assert!(matches!(error, ExtHostError::Protocol(_)));
	}
}
