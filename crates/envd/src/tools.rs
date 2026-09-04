//! Production built-in tool registry assembly.

#[cfg(test)]
use std::sync::LazyLock;
use std::{
	collections::{BTreeMap, BTreeSet, VecDeque},
	env,
	env::consts,
	future::Future,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time,
};

use futures::StreamExt as _;
use omp_agent::{
	GateDecision, GateEvent, GateOutcome, HookDispatch as AgentHookDispatch, HookGate, HookPatch,
	HookPhase, KernelSender, OBSERVE_HANDLER_CAP,
};
use omp_ai::{
	BeforeRequestDenied, BeforeRequestDraft, BeforeRequestMutation, CredentialDisabledObservation,
	ModelsDiscoverHookPage, ModelsDiscoverHookRequest, ProviderHookCredential, ProviderHookError,
	ProviderHookObserver, ProviderLoginHookRequest, ProviderRefreshHookRequest,
	ProviderResponseObservation, ProviderResponseObserver, ProviderSignHookRequest,
	ProviderSignature,
	answer::{
		UsageAccountMetadata, UsageAmount, UsageQuantity, UsageUnit, UsageWindow, UsageWindowKind,
	},
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
		UsageFetcherRegistry,
	},
	receipt::UsageSource,
};
use omp_cache::{github_cache::GithubCache, telemetry_cache::TelemetryIndex};
use omp_catalog::{ModelKey, ProviderId, snapshot::Catalog};
use omp_con::Ctx;
use omp_core::{
	Duration, ExposeSecret as _, FastHashSet, Hash32, InvocationPhase, LifecyclePhase, SecretString,
	Str, Ulid, sf,
};
use omp_env::EnvClient;
use omp_proto::{
	env::v1 as env_wire,
	inference::{v1, v1::tool_def},
	prost::Message as _,
	thread::v1::Blob,
	toolhost::v1::{
		GrammarSyntax as WorkerGrammarSyntax, HookEventId, PreludeParamKind, ToolDecl,
		ToolExecutionMode as WorkerExecutionMode, tool_constraint,
	},
};
use omp_tool::{
	AvailabilityDelta, Claims, Constraint, Ev, ExecutionMode, GrammarSyntax, IncomingParams,
	LeafOwner, LeafReplacementError, LeafReplacementRegistry, LeafVersion, Precedence, Presentation,
	Registry, RegistryLeaf, Rev, Tool, ToolLocus, ToolSpec, ToolTerminal, ToolsPolicy,
};
use omp_tools::{
	ask::PresenterSlot,
	checkpoint,
	device::{DeviceCatalog, dyn_enabled, flatten_slots},
	edit::{EditRevisionCandidates, resolve_edit_revision},
	eval::{EvalSessionControl, TaskDescriptionSnapshot},
	goal,
	read::{
		Fault as ReadFault,
		conflicts::ConflictRegistry,
		resolver::{ResolverTable, ResourceCompletion, ResourceList, SchemeEntry},
		selector::ParsedSelector,
	},
	shell::TimeoutBounds,
	staging::StagedProposalRegistry,
};
use parking_lot::{Mutex, RwLock};
use serde_json::{Map as JsonMap, Value as JsonValue, json};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio_util::sync::CancellationToken;

use super::{
	EnvdError,
	admission::DynamicAdmission,
	blobs::BlobHost,
	computer::ComputerSessionHost,
	devices_host::DynHost,
	docs::{DocumentHost, ResourceMutationServices},
	document_cache,
	eval::{
		PRELUDE_PYTHON_KEYWORDS, PRELUDE_RESERVED_NAMES, PreludeHelper, PreludeInvoker,
		PreludeParamStub, PreludeTable, ProcessEvalExec, SessionBridgeHost,
	},
	exec::ExecHost,
	exec_settings::{AcpRouting, AcpSettings, SandboxSettings, ShellSettings},
	exthost::{
		CallbackConcurrency, ExtensionManifest,
		control::{
			ControlAuthority, ControlAuthorityFactory, ControlCompositionError,
			ControlConnectionIdentity, ControlDispatch, ControlEffect, ControlInvocationAuthority,
			ControlProtocolError, ControlRequestContext,
		},
		dispatch::{CallbackDispatcher, EventDeadline, NestedCallbackDispatcher},
		extensions::{SealedRegistryEvidence, SealedRegistryEvidenceError, seal_registry_evidence},
	},
	github::GithubService,
	managed_skills::ManagedSkills,
	mcp::{
		McpService,
		manager::{McpHookNotification, McpManager, McpNotificationSink},
	},
	media_devices,
	media_tts::{SpeechConfig, SpeechPreference},
	memory::ReflectionBridgeHost,
	report_issue,
	search_backend::SearchBridgeHost,
	security_scan::SecurityScanService,
	ssh::{HostPaths, HostStore, SshService},
	tool_ast_grep::AstSearchAuthority,
	tool_debug::DocumentDebugControl,
	tool_document::SessionReadBlobs,
	tool_lsp::DocumentLspControl,
	tool_read_sources::ReadSourceAdapter,
	tool_search::WorkspaceSearchAdapter,
	tool_settings::ToolSettings,
	tool_shell::{AcpExecSlot, ShellExecHost},
	tool_url::{UrlResolver, production_url_resolvers},
	vault::{VaultPaths, VaultService},
	worker::ExtHostSupervisor,
	workspace::{WorkspaceHost, WorkspaceOperationError, WorkspaceOperations},
};
use crate::{
	browser_daemon::{BrowserDaemon, BrowserSettings},
	github_url::GithubCredentialBridge,
};

tokio::task_local! {
	static PTY_DENIED: bool;
	static INVOCATION_SESSION_ID: Option<Str>;
	static OUTPUT_REQUEST: omp_tool::OutputRequest;
	static EDIT_REPAIR_CONTEXT: InvocationEditRepairContext;
	static ACP_BACKENDS: InvocationAcpBackends;
}
/// Session-owned edit repair capability scoped to one native invocation.
#[derive(Clone, Default)]
pub(super) struct InvocationEditRepairContext {
	repair: Option<omp_tools::edit::observer::EditRepairClient>,
	model:  Option<Str>,
}

impl InvocationEditRepairContext {
	/// Captures the invoking connection's optional repair route and model tag.
	pub(super) fn new(
		repair: Option<omp_tools::edit::observer::EditRepairClient>,
		model: Option<Str>,
	) -> Self {
		Self { repair, model }
	}
}
/// Editor-owned capabilities authenticated by the invoking Environment
/// connection.
#[derive(Clone, Default)]
pub(super) struct InvocationAcpBackends {
	documents: Option<Arc<dyn super::docs::AcpDocumentBackend>>,
	exec:      Option<Arc<dyn super::tool_shell::AcpExecBackend>>,
}

impl InvocationAcpBackends {
	pub(super) fn new(
		documents: Option<Arc<dyn super::docs::AcpDocumentBackend>>,
		exec: Option<Arc<dyn super::tool_shell::AcpExecBackend>>,
	) -> Self {
		Self { documents, exec }
	}
}

/// Composition-supplied capabilities the environment host cannot own.
#[derive(Default)]
pub struct RegistryBridges {
	/// Constructs the command-backed credential executor after the environment
	/// client is available.
	pub command_credentials:    Option<Arc<dyn CommandCredentialExecutorFactory>>,
	/// Extra device tools registered verbatim by the composition layer.
	pub dynamic_tools:          Vec<DynamicTool>,
	/// Host tool factories registered before and bound after client creation.
	pub dynamic_tool_factories: Vec<Arc<dyn DynamicToolFactory>>,
	/// Internal-URL resolvers installed into the read resolver table.
	pub url_resolvers:          Vec<Arc<dyn ContentResolver>>,
	/// Regime/goal authority backing the `goal` tool.
	pub goal_control:           Option<Arc<dyn GoalAuthority>>,
	/// Auxiliary inference used by workspace search and media tools.
	pub search:                 Option<Arc<dyn SearchInference>>,
	/// Active model identity captured by edit regression observation.
	pub edit_model:             Option<Str>,
	/// Typed small-model completion bridge for validated edit auto-repair.
	pub edit_repair:            Option<omp_tools::edit::observer::EditRepairClient>,
	/// Host-resource broker used by composition-owned internal resource URLs.
	pub host_resources:         Option<Arc<dyn HostResources>>,
	/// Live session routing authority for `agent://`, `history://`, and
	/// attachments.
	pub session_authority:      Option<Arc<dyn omp_agent::SessionAuthority>>,
	/// Background telemetry delivery started once credentials exist.
	pub telemetry_upload:       Option<Arc<dyn TelemetryUpload>>,
	/// Fallback presenter for interactive `ask` invocations.
	///
	/// The daemon defaults to [`omp_tools::ask::HeadlessPresenter`]; an
	/// interactive composition supplies its own terminal presenter, and a live
	/// session may rebind one later through `bind_ask_presenter`.
	pub ask_presenter:          Option<Arc<dyn omp_tools::ask::AskPresenter>>,
	/// Plain data: active project content and native roots.
	pub content:                ActiveContentInputs,
}

/// Builds the command credential executor from the live Environment client.
pub trait CommandCredentialExecutorFactory: Send + Sync + 'static {
	/// Creates one executor rooted at the active project workspace.
	fn make(
		&self,
		client: omp_env::EnvClient,
		cwd: &Path,
	) -> Arc<dyn omp_ai::auth::command::CommandCredentialExecutor>;
}
/// Registers host-owned tools before registry freeze, then binds their live
/// Environment client after transport composition.
pub trait DynamicToolFactory: Send + Sync + 'static {
	/// Registers every declaration-backed tool using factory-retained slots.
	fn register(&self, registry: &mut Registry) -> Result<(), omp_tool::RegistryError>;
	/// Binds the live Environment process/data authority exactly once.
	fn bind(&self, client: EnvClient, root: &Path);
}

/// One composition-owned device tool and its admission facts.
pub struct DynamicTool {
	register: Box<dyn FnOnce(&mut Registry) -> Result<(), omp_tool::RegistryError> + Send + 'static>,
}

impl DynamicTool {
	/// Erases one concrete tool only at the startup registration boundary.
	pub fn new<T>(tool: T, presentation: Presentation, claims: Claims) -> Self
	where
		T: Tool,
	{
		Self {
			register: Box::new(move |registry| {
				register_instrumented(registry, tool, presentation, claims)
			}),
		}
	}

	fn register(self, registry: &mut Registry) -> Result<(), omp_tool::RegistryError> {
		(self.register)(registry)
	}
}

struct InstrumentedTool<T> {
	inner: T,
}

impl<T> Tool for InstrumentedTool<T>
where
	T: Tool,
{
	type Fault = T::Fault;
	type Params = T::Params;
	type Payload = T::Payload;
	type Update = T::Update;

	fn spec(&self) -> &ToolSpec {
		self.inner.spec()
	}

	fn execution_mode(&self) -> ExecutionMode {
		self.inner.execution_mode()
	}

	fn prompt_examples(&self) -> &[omp_tool::ToolPromptExample] {
		self.inner.prompt_examples()
	}

	fn prompt_docs(&self) -> Option<&str> {
		self.inner.prompt_docs()
	}

	fn call<'c>(
		&'c self,
		params: IncomingParams<'c>,
	) -> impl futures::Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		let spec = self.inner.spec();
		let span = tracing::debug_span!(
			"tool_invocation",
			tool = %spec.name,
			revision = %spec.rev,
			outcome = tracing::field::Empty,
		);
		let events = self.inner.call(params);
		async_stream::stream! {
			tokio::pin!(events);
			while let Some(event) = events.next().await {
				match &event {
					Ev::Done(ToolTerminal::Done { result: Ok(_), .. }) => {
						span.record("outcome", "success");
					},
					Ev::Done(ToolTerminal::Done { result: Err(_), .. }) => {
						span.record("outcome", "fault");
						tracing::warn!(
							parent: &span,
							outcome = "fault",
							"tool invocation returned error verdict"
						);
					},
					Ev::Done(ToolTerminal::Detached(_)) => {
						span.record("outcome", "detached");
					},
					Ev::Args(_) => {
						span.record("outcome", "invalid_arguments");
					},
					Ev::Aborted(_) => {
						span.record("outcome", "aborted");
					},
					Ev::Update(_) | Ev::Diag(_) => {},
				}
				yield event;
			}
		}
	}

	fn prompt(
		&self,
		view: Result<&Self::Payload, &Self::Fault>,
		caps: &omp_tool::PromptCaps,
	) -> Vec<omp_tool::Part> {
		self.inner.prompt(view, caps)
	}

	fn invoke_input(
		&self,
		update: &Self::Update,
		invocation_id: &str,
	) -> Option<omp_proto::inference::v1::InvokeInput> {
		self.inner.invoke_input(update, invocation_id)
	}

	fn lift(&self, from: &Rev, call: omp_tool::RecordedCall<'_>) -> Option<omp_tool::LiftedCall> {
		self.inner.lift(from, call)
	}
}

fn register_instrumented<T: Tool>(
	registry: &mut Registry,
	tool: T,
	presentation: Presentation,
	claims: Claims,
) -> Result<(), omp_tool::RegistryError> {
	Registry::register(registry, InstrumentedTool { inner: tool }, presentation, claims)
}
/// Registers one concrete executor in the authoritative environment half.
pub(crate) fn environment_registry<T: Tool>(
	registry: &mut Registry,
	tool: T,
	presentation: Presentation,
	claims: Claims,
) -> Result<(), omp_tool::RegistryError> {
	registry.register_environment(InstrumentedTool { inner: tool }, presentation, claims)
}

type ControlConnectionKey = (Str, Str, Str, u64, u64);

fn connection_key(identity: &ControlConnectionIdentity) -> ControlConnectionKey {
	(
		identity.layer.clone(),
		identity.tier.clone(),
		identity.extension.clone(),
		identity.host_generation,
		identity.session_generation,
	)
}

fn same_connection(
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

fn stale_connection() -> ControlProtocolError {
	ControlProtocolError::new(
		"StaleGeneration",
		"CONTROL authority belongs to a replaced extension-host connection",
	)
}

/// Owns manifest verification and retained sealed registry evidence.
#[derive(Clone)]
pub struct RegistryControlFactory {
	manifests: Arc<BTreeMap<(Str, Str, Str), ExtensionManifest>>,
	evidence:  Arc<RwLock<BTreeMap<ControlConnectionKey, Arc<SealedRegistryEvidence>>>>,
	published: Arc<Notify>,
}

impl RegistryControlFactory {
	/// Creates the registry owner from deployment-authenticated manifests.
	pub fn new(manifests: BTreeMap<(Str, Str, Str), ExtensionManifest>) -> Arc<Self> {
		Arc::new(Self {
			manifests: Arc::new(manifests),
			evidence:  Arc::new(RwLock::new(BTreeMap::new())),
			published: Arc::new(Notify::new()),
		})
	}

	/// Returns exact-generation evidence only after the child published and
	/// passed the sealed registry comparison.
	pub fn evidence(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<Arc<SealedRegistryEvidence>> {
		self.evidence.read().get(&connection_key(identity)).cloned()
	}

	/// Waits until the exact child generation publishes sealed registry
	/// evidence.
	pub async fn wait_evidence(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Arc<SealedRegistryEvidence> {
		loop {
			let published = self.published.notified();
			tokio::pin!(published);
			published.as_mut().enable();
			if let Some(evidence) = self.evidence(identity) {
				return evidence;
			}
			published.await;
		}
	}

	fn admits(&self, identity: &ControlConnectionIdentity) -> bool {
		self.manifests.contains_key(&(
			identity.layer.clone(),
			identity.tier.clone(),
			identity.extension.clone(),
		))
	}

	/// Accepts the sole registry publication for one connection generation.
	pub fn publish(
		&self,
		context: &ControlRequestContext,
		payload: &JsonValue,
	) -> Result<Arc<SealedRegistryEvidence>, ControlProtocolError> {
		let key = (
			context.connection.layer.clone(),
			context.connection.tier.clone(),
			context.connection.extension.clone(),
		);
		let manifest = self.manifests.get(&key).ok_or_else(|| {
			ControlProtocolError::new(
				"RegistryUnauthorized",
				"no authenticated manifest owns this registry publication",
			)
		})?;
		let session = context
			.invocation
			.as_ref()
			.map(|invocation| invocation.session.clone())
			.ok_or_else(|| {
				ControlProtocolError::new(
					"InvalidPhase",
					"registry FREEZE evidence has no authenticated lifecycle session",
				)
			})?;
		let evidence = Arc::new(
			seal_registry_evidence(
				Arc::clone(&context.connection),
				session,
				manifest,
				payload.clone(),
			)
			.map_err(registry_evidence_error)?,
		);
		self.install_evidence(evidence)
	}

	/// Installs evidence already sealed by the trusted extension-host lifecycle.
	///
	/// A newer host/session generation replaces the retained generation for
	/// the same deployment. Re-publication within one exact generation must be
	/// declaration-identical.
	pub fn install_evidence(
		&self,
		evidence: Arc<SealedRegistryEvidence>,
	) -> Result<Arc<SealedRegistryEvidence>, ControlProtocolError> {
		if !self.admits(&evidence.identity) {
			return Err(ControlProtocolError::new(
				"RegistryUnauthorized",
				"no authenticated manifest owns this sealed registry evidence",
			));
		}
		let connection = connection_key(&evidence.identity);
		let mut published = self.evidence.write();
		if let Some(current) = published.get(&connection) {
			if !same_registry_evidence(current, &evidence) {
				return Err(ControlProtocolError::new(
					"RegistryConflict",
					"sealed registry changed within one host generation",
				));
			}
			return Ok(Arc::clone(current));
		}
		let generation = (connection.3, connection.4);
		if published.iter().any(|(key, _)| {
			key.0 == connection.0
				&& key.1 == connection.1
				&& key.2 == connection.2
				&& (key.3, key.4) > generation
		}) {
			return Err(stale_connection());
		}
		published
			.retain(|key, _| key.0 != connection.0 || key.1 != connection.1 || key.2 != connection.2);
		published.insert(connection, Arc::clone(&evidence));
		drop(published);
		self.published.notify_waiters();
		Ok(evidence)
	}
}

fn same_registry_evidence(
	current: &SealedRegistryEvidence,
	candidate: &SealedRegistryEvidence,
) -> bool {
	same_connection(&current.identity, &candidate.identity)
		&& current.session == candidate.session
		&& current.tools == candidate.tools
		&& current.prompts == candidate.prompts
		&& current.services == candidate.services
		&& current.hooks == candidate.hooks
		&& current.ui_registration == candidate.ui_registration
		&& current.ui.generation == candidate.ui.generation
		&& current.ui.extension == candidate.ui.extension
		&& current.ui.commands == candidate.ui.commands
		&& current.ui.shortcuts == candidate.ui.shortcuts
		&& current.ui.triggers == candidate.ui.triggers
		&& current.ui.message_renderers == candidate.ui.message_renderers
		&& current.ui.markdown_transformers == candidate.ui.markdown_transformers
		&& current.ui.renderers == candidate.ui.renderers
		&& current.providers == candidate.providers
		&& current.directors == candidate.directors
		&& current.components == candidate.components
}

fn registry_evidence_error(error: SealedRegistryEvidenceError) -> ControlProtocolError {
	let code = match error {
		SealedRegistryEvidenceError::Identity => "RegistryUnauthorized",
		SealedRegistryEvidenceError::ManifestDrift => "DeclarationDrift",
		SealedRegistryEvidenceError::Duplicate
		| SealedRegistryEvidenceError::SourceModule
		| SealedRegistryEvidenceError::Ui(_)
		| SealedRegistryEvidenceError::Prompt(_) => "RegistryDrift",
		SealedRegistryEvidenceError::Malformed => "RegistryMalformed",
	};
	ControlProtocolError::new(code, Str::from(error.to_string()))
}

/// One live dynamic device row published to catalog observers.
#[derive(Clone, Debug)]
pub struct DynamicDeviceCatalogEntry {
	/// Canonical mounted leaf path.
	pub path:       Str,
	/// Frozen parent family.
	pub family:     Str,
	/// Frozen parent revision.
	pub rev:        u16,
	/// Authenticated claimant.
	pub claimant:   Str,
	/// Frozen placement.
	pub place:      Str,
	/// Leaf summary.
	pub summary:    Str,
	/// Validated JSON Schema.
	pub schema:     JsonValue,
	/// Optional long-form documentation.
	pub docs:       Option<Str>,
	/// Current reachability.
	pub mounted:    bool,
	/// Current unavailable reason.
	pub reason:     Option<Str>,
	/// Authenticated installation provenance.
	pub provenance: omp_core::Provenance,
}

/// Receives exactly one notification after each effective catalog transition.
pub trait DeviceCatalogObserver: Send + Sync + 'static {
	/// Publishes an immutable old-or-new catalog snapshot.
	fn catalog_changed(&self, epoch: u64, catalog: Arc<[DynamicDeviceCatalogEntry]>);
}

/// Performs the independent policy/admission decision for a nested device call.
#[async_trait::async_trait]
pub trait DeviceInvocationAdmission: Send + Sync + 'static {
	/// Admits the exact resolved leaf and arguments without inheriting authority
	/// from the caller.
	async fn admit(
		&self,
		caller: &ControlRequestContext,
		target: &DynamicDeviceCatalogEntry,
		arguments: &JsonMap<String, JsonValue>,
	) -> Result<(), ControlProtocolError>;
}

#[derive(Clone)]
struct DynamicDeviceBinding {
	entry:    DynamicDeviceCatalogEntry,
	identity: Arc<ControlConnectionIdentity>,
}

/// Composes sealed registry evidence with dynamic device dispatch authority.
#[derive(Clone)]
pub struct DeviceControlFactory {
	registries: Arc<RegistryControlFactory>,
	catalog:    Arc<LeafReplacementRegistry<DynamicDeviceBinding>>,
	callbacks:  Arc<NestedCallbackDispatcher>,
	observer:   Arc<dyn DeviceCatalogObserver>,
	admission:  Arc<dyn DeviceInvocationAdmission>,
	mutation:   Arc<Mutex<()>>,
}

impl DeviceControlFactory {
	/// Binds dynamic catalog mutation to sealed evidence, policy admission, the
	/// live callback dispatcher, and the durable catalog observer.
	pub fn new(
		registries: Arc<RegistryControlFactory>,
		dispatcher: Arc<dyn CallbackDispatcher>,
		observer: Arc<dyn DeviceCatalogObserver>,
		admission: Arc<dyn DeviceInvocationAdmission>,
	) -> Arc<Self> {
		Arc::new(Self {
			registries,
			catalog: Arc::new(LeafReplacementRegistry::new()),
			callbacks: Arc::new(NestedCallbackDispatcher::new(dispatcher)),
			observer,
			admission,
			mutation: Arc::new(Mutex::new(())),
		})
	}

	/// Returns the current immutable catalog projection.
	pub fn catalog(&self) -> Arc<[DynamicDeviceCatalogEntry]> {
		self
			.catalog
			.snapshot()
			.leaves
			.iter()
			.map(|leaf| {
				let mut entry = leaf.value.entry.clone();
				entry.mounted = leaf.mounted;
				entry.reason = leaf.reason.clone();
				entry
			})
			.collect()
	}

	fn publish_catalog(&self, epoch: u64) -> Arc<[DynamicDeviceCatalogEntry]> {
		let catalog = self.catalog();
		self.observer.catalog_changed(epoch, Arc::clone(&catalog));
		catalog
	}

	fn mount(
		&self,
		context: &ControlRequestContext,
		arguments: &JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		require_active_invocation(context)?;
		let evidence = self
			.registries
			.evidence(&context.connection)
			.ok_or_else(|| {
				ControlProtocolError::new(
					"RegistryUnavailable",
					"dynamic mount requires sealed registry evidence",
				)
			})?;
		let parent = arguments
			.get("parent")
			.and_then(JsonValue::as_object)
			.ok_or_else(|| invalid_device("dynamic mount parent must be an object"))?;
		let parent_name = required_string(parent, "name")?;
		let family = required_string(parent, "family")?;
		let rev = required_u16(parent, "rev")?;
		let parent_revision = Rev { family: family.clone(), n: rev };
		let place = required_string(parent, "place")?;
		let _registration = evidence
			.tools
			.iter()
			.find(|tool| {
				tool
					.definition
					.as_ref()
					.is_some_and(|definition| definition.name.as_str() == parent_name.as_str())
					&& tool
						.rev
						.parse::<Rev>()
						.is_ok_and(|revision| revision == parent_revision)
					&& tool.place == place
			})
			.ok_or_else(|| {
				ControlProtocolError::new(
					"RegistryUnauthorized",
					"dynamic mount parent is not present in sealed registration evidence",
				)
			})?;
		let specs = arguments
			.get("specs")
			.and_then(JsonValue::as_array)
			.ok_or_else(|| invalid_device("dynamic mount specs must be an array"))?;
		let owner = LeafOwner {
			root:     parent_name.clone(),
			claimant: context.connection.extension.clone(),
		};
		let _guard = self.mutation.lock();
		let mut leaves = self
			.catalog
			.snapshot()
			.leaves
			.iter()
			.filter(|leaf| leaf.owner == owner)
			.map(|leaf| RegistryLeaf {
				name:  leaf.name.clone(),
				rev:   leaf.rev.clone(),
				code:  leaf.code,
				value: Arc::clone(&leaf.value),
			})
			.collect::<Vec<_>>();
		let mut paths = Vec::with_capacity(specs.len());
		for spec in specs {
			let spec = spec
				.as_object()
				.ok_or_else(|| invalid_device("dynamic mount spec must be an object"))?;
			let path = required_string(spec, "path")?;
			let subpath = required_string(spec, "subpath")?;
			if path.as_str() != format!("{parent_name}/{subpath}")
				|| !valid_device_subpath(subpath.as_str())
			{
				return Err(invalid_device("dynamic mount path is outside its sealed parent"));
			}
			if leaves.iter().any(|leaf| leaf.name == path)
				|| paths.iter().any(|existing| existing == &path)
			{
				return Err(ControlProtocolError::new(
					"DeviceNameError",
					"dynamic device path is already mounted",
				));
			}
			let schema = spec
				.get("schema")
				.filter(|schema| schema.is_object())
				.cloned()
				.ok_or_else(|| invalid_device("dynamic device schema must be an object"))?;
			let summary = required_string(spec, "summary")?;
			let docs = optional_string(spec, "docs")?;
			let entry = DynamicDeviceCatalogEntry {
				path: path.clone(),
				family: family.clone(),
				rev,
				claimant: context.connection.extension.clone(),
				place: place.clone(),
				summary,
				schema,
				docs,
				mounted: true,
				reason: None,
				provenance: evidence.provenance.clone(),
			};
			let mut hasher = Hash32::hasher();
			hasher.update(b"omp/dynamic-device-binding/v1\0");
			hasher.update(
				serde_json::to_vec(&json!({
					"path": entry.path.as_str(),
					"family": entry.family.as_str(),
					"rev": entry.rev,
					"place": entry.place.as_str(),
					"summary": entry.summary.as_str(),
					"schema": &entry.schema,
					"docs": entry.docs.as_deref(),
					"artifact": context.connection.artifact_digest.as_str(),
				}))
				.map_err(|error| invalid_device(error.to_string()))?,
			);
			leaves.push(RegistryLeaf {
				name:  path.clone(),
				rev:   Rev { family: family.clone(), n: rev },
				code:  hasher.finalize(),
				value: Arc::new(DynamicDeviceBinding {
					entry,
					identity: Arc::clone(&context.connection),
				}),
			});
			paths.push(path);
		}
		let epoch = self
			.catalog
			.replace(
				owner,
				LeafVersion {
					manager_generation: context.connection.host_generation,
					definition_epoch:   context.request_id,
				},
				leaves,
			)
			.map_err(device_catalog_error)?;
		let catalog = self.publish_catalog(epoch);
		Ok(json!({
			"paths": paths.iter().map(Str::as_str).collect::<Vec<_>>(),
			"catalog": catalog.iter().map(device_catalog_json).collect::<Vec<_>>(),
		}))
	}

	fn availability(
		&self,
		context: &ControlRequestContext,
		arguments: &JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		require_active_invocation(context)?;
		let rows = arguments
			.get("deltas")
			.and_then(JsonValue::as_array)
			.ok_or_else(|| invalid_device("availability deltas must be an array"))?;
		let mut deltas = Vec::with_capacity(rows.len());
		for row in rows {
			let row = row
				.as_object()
				.ok_or_else(|| invalid_device("availability delta must be an object"))?;
			let path = required_string(row, "path")?;
			let root = path
				.split("/")
				.next()
				.filter(|root| !root.is_empty())
				.ok_or_else(|| invalid_device("availability path is invalid"))?;
			let mounted = row
				.get("mounted")
				.and_then(JsonValue::as_bool)
				.ok_or_else(|| invalid_device("availability mounted must be boolean"))?;
			let reason = optional_string(row, "reason")?;
			deltas.push((
				LeafOwner { root: Str::new(root), claimant: context.connection.extension.clone() },
				AvailabilityDelta { name: path, mounted, reason },
			));
		}
		let _guard = self.mutation.lock();
		let epoch = self
			.catalog
			.set_availability_many(context.connection.host_generation, &deltas)
			.map_err(device_catalog_error)?;
		let catalog = self.publish_catalog(epoch);
		Ok(json!({
			"catalog": catalog.iter().map(device_catalog_json).collect::<Vec<_>>(),
		}))
	}

	async fn invoke(
		&self,
		context: &ControlRequestContext,
		arguments: &JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		require_active_invocation(context)?;
		let path = required_string(arguments, "path")?;
		let args = arguments
			.get("args")
			.and_then(JsonValue::as_object)
			.cloned()
			.ok_or_else(|| invalid_device("device invocation args must be an object"))?;
		let matches = self
			.catalog
			.snapshot()
			.leaves
			.iter()
			.filter(|leaf| leaf.name == path && leaf.mounted)
			.cloned()
			.collect::<Vec<_>>();
		let [leaf] = matches.as_slice() else {
			return Err(ControlProtocolError::new(
				"DeviceUnavailable",
				"no unique mounted device owns the requested path",
			));
		};
		self
			.admission
			.admit(context, &leaf.value.entry, &args)
			.await?;
		let mut callback_args = JsonMap::new();
		callback_args.insert(String::from("path"), JsonValue::String(path.to_string()));
		callback_args.insert(String::from("args"), JsonValue::Object(args));
		callback_args
			.insert(String::from("family"), JsonValue::String(leaf.value.entry.family.to_string()));
		callback_args.insert(String::from("rev"), JsonValue::from(leaf.value.entry.rev));
		self
			.callbacks
			.dispatch(
				Arc::clone(&leaf.value.identity),
				context,
				"omp.devices.call",
				callback_args,
				CallbackConcurrency::Serialized,
				request_timeout(arguments, time::Duration::from_secs(30))?,
				None,
				Some(path),
			)
			.await
	}
}

fn device_catalog_json(entry: &DynamicDeviceCatalogEntry) -> JsonValue {
	json!({
		"name": entry.path.as_str(),
		"family": entry.family.as_str(),
		"rev": entry.rev,
		"identity": format!("{}@{}", entry.path, entry.claimant),
		"claimant": entry.claimant.as_str(),
		"path": entry.path.as_str(),
		"summary": entry.summary.as_str(),
		"place": entry.place.as_str(),
		"precedence": 0,
		"tier": entry.provenance.tier(),
		"effects": null,
		"mounted": entry.mounted,
		"enabled": true,
		"available": entry.mounted,
		"reason": entry.reason.as_deref(),
		"shadowed_by": null,
		"source": entry.provenance.extension_id(),
		"provenance": {
			"publisher": entry.provenance.publisher(),
			"extension_id": entry.provenance.extension_id(),
			"version": entry.provenance.version(),
			"artifact_digest": entry.provenance.artifact_digest().to_string(),
			"layer": entry.provenance.layer(),
			"tier": entry.provenance.tier(),
			"trust": entry.provenance.tier(),
		},
		"slotted": false,
		"schema_bytes": serde_json::to_vec(&entry.schema).map_or(0, |bytes| bytes.len()),
		"schema_tokens": 0,
	})
}

fn device_catalog_error(error: LeafReplacementError) -> ControlProtocolError {
	match error {
		LeafReplacementError::Stale { current_generation, manager_generation, .. }
		| LeafReplacementError::Generation {
			expected: current_generation,
			actual: manager_generation,
		} => ControlProtocolError::new(
			"StaleGeneration",
			format!(
				"device catalog generation is stale: expected {current_generation}, got \
				 {manager_generation}"
			),
		),
		LeafReplacementError::UnknownName(name) => ControlProtocolError::new(
			"DeviceUnavailable",
			format!("dynamic device is not mounted: {name}"),
		),
		other => ControlProtocolError::new("DeviceError", Str::from(other.to_string())),
	}
}

fn invalid_device(message: impl Into<Str>) -> ControlProtocolError {
	ControlProtocolError::new("DeviceError", message)
}

fn required_string(
	object: &JsonMap<String, JsonValue>,
	field: &'static str,
) -> Result<Str, ControlProtocolError> {
	object
		.get(field)
		.and_then(JsonValue::as_str)
		.filter(|value| !value.is_empty())
		.map(Str::new)
		.ok_or_else(|| invalid_device(format!("{field} must be a non-empty string")))
}

fn optional_string(
	object: &JsonMap<String, JsonValue>,
	field: &'static str,
) -> Result<Option<Str>, ControlProtocolError> {
	match object.get(field) {
		None | Some(JsonValue::Null) => Ok(None),
		Some(JsonValue::String(value)) => Ok(Some(Str::new(value))),
		_ => Err(invalid_device(format!("{field} must be a string or null"))),
	}
}

fn required_u16(
	object: &JsonMap<String, JsonValue>,
	field: &'static str,
) -> Result<u16, ControlProtocolError> {
	object
		.get(field)
		.and_then(JsonValue::as_u64)
		.and_then(|value| u16::try_from(value).ok())
		.ok_or_else(|| invalid_device(format!("{field} must be a u16")))
}

fn valid_device_subpath(path: &str) -> bool {
	!path.is_empty()
		&& path.split('/').all(|segment| {
			!segment.is_empty()
				&& segment.len() <= 64
				&& segment.bytes().enumerate().all(|(index, byte)| {
					byte.is_ascii_lowercase()
						|| byte.is_ascii_digit() && index > 0
						|| byte == b'_' && index > 0
				})
		})
}

fn request_timeout(
	arguments: &JsonMap<String, JsonValue>,
	default: time::Duration,
) -> Result<time::Duration, ControlProtocolError> {
	let Some(value) = arguments.get("deadline") else {
		return Ok(default);
	};
	let Some(value) = value.as_str() else {
		if value.is_null() {
			return Ok(default);
		}
		return Err(invalid_device("deadline must be a duration string or null"));
	};
	value
		.parse::<Duration>()
		.map_err(|error| invalid_device(error.to_string()))?
		.to_std()
		.map_err(|_| invalid_device("deadline exceeds host duration range"))
}

fn require_active_invocation(context: &ControlRequestContext) -> Result<(), ControlProtocolError> {
	let invocation = context.invocation.as_ref().ok_or_else(|| {
		ControlProtocolError::new(
			"InvalidPhase",
			"device mutation and invocation require a live callback",
		)
	})?;
	if invocation.lifecycle != LifecyclePhase::Active
		|| invocation.phase < InvocationPhase::EffectsAuthorized
	{
		return Err(ControlProtocolError::new(
			"InvalidPhase",
			"device operation requires ACTIVE effects-authorized phase",
		));
	}
	Ok(())
}

impl ControlAuthorityFactory for DeviceControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		if !self.registries.admits(&identity) {
			return Err(ControlCompositionError::unavailable(
				"devices",
				"authenticated extension has no deployment manifest",
			));
		}
		Ok(Arc::new(BoundDeviceControl { identity, owner: self.clone() }))
	}
}

struct BoundDeviceControl {
	identity: Arc<ControlConnectionIdentity>,
	owner:    DeviceControlFactory,
}

#[async_trait::async_trait]
impl ControlAuthority for BoundDeviceControl {
	fn handles(&self, operation: &str) -> bool {
		matches!(
			operation,
			"omp.devices.dynamic_mount"
				| "omp.devices.set_availability"
				| "omp.devices.refresh"
				| "omp.devices.invoke"
		)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		_arguments: &JsonMap<String, JsonValue>,
	) -> Result<(), ControlProtocolError> {
		if !same_connection(&self.identity, &context.connection) {
			return Err(stale_connection());
		}
		if !self.handles(operation) {
			return Err(ControlProtocolError::new(
				"InvalidOperation",
				"device owner does not handle this operation",
			));
		}
		require_active_invocation(context)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		match operation.as_str() {
			"omp.devices.dynamic_mount" => self.owner.mount(&context, &arguments),
			"omp.devices.set_availability" => self.owner.availability(&context, &arguments),
			"omp.devices.refresh" => {
				let catalog = self.owner.catalog();
				Ok(json!({
					"catalog": catalog.iter().map(device_catalog_json).collect::<Vec<_>>(),
				}))
			},
			"omp.devices.invoke" => self.owner.invoke(&context, &arguments).await,
			_ => unreachable!("authorized exact device operation"),
		}
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		if same_connection(&self.identity, &context.connection) {
			Err(ControlProtocolError::new("InvalidEffect", "device owner accepts requests only"))
		} else {
			Err(stale_connection())
		}
	}
}

/// Failure behavior for one subscribed hook callback.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HookFailurePolicy {
	/// Ignore an unavailable or failed callback.
	Defer,
	/// Convert callback failure into a composed denial.
	Deny,
}

/// Composition rule for one mutable event field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HookFieldComposition {
	/// Later ordered values replace earlier values.
	Replace,
	/// Ordered arrays concatenate.
	Append,
	/// Ordered arrays retain only common values.
	Intersect,
}

/// Host-owned behavior for one revisioned hook event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HookEventPolicy {
	/// Exact payload/decision schema revision.
	pub revision:    u16,
	/// Deadline used when a subscription has no narrower timeout.
	pub timeout:     time::Duration,
	/// Event-level failure default.
	pub on_failure:  HookFailurePolicy,
	/// Decision returned when every subscription defers.
	pub default:     JsonValue,
	/// Per-field mutation composition.
	pub composition: BTreeMap<Str, HookFieldComposition>,
}

/// One exact frozen Python subscription callback.
#[derive(Clone)]
pub struct HookSubscription {
	/// Authenticated child generation owning the callback.
	pub identity:     Arc<ControlConnectionIdentity>,
	/// Authenticated durable session owning this callback.
	pub session:      Str,
	/// Stable event name.
	pub event:        Str,
	/// Frozen phase spelling.
	pub phase:        Str,
	/// Stable callback name selected inside Python.
	pub name:         Str,
	/// Deterministic order within a phase.
	pub order:        i32,
	/// Per-subscription failure override.
	pub on_failure:   Option<HookFailurePolicy>,
	/// Per-subscription deadline override.
	pub timeout:      Option<time::Duration>,
	/// Declared callback overlap policy.
	pub concurrency:  CallbackConcurrency,
	/// Provider ids admitted by this callback, when provider-scoped.
	pub providers:    Option<Box<[Str]>>,
	/// Exact raw MCP mount names admitted by this callback.
	pub servers:      Option<Box<[Str]>>,
	/// Anchored MCP JSON-RPC method globs admitted by this callback.
	pub method_globs: Box<[Str]>,
	/// Event policy frozen with the Python registry declaration.
	pub event_policy: HookEventPolicy,
}
#[derive(Clone)]
struct ExtensionUsageFetcher {
	provider:    ProviderId,
	settings:    JsonMap<String, JsonValue>,
	identity:    Arc<ControlConnectionIdentity>,
	session:     Str,
	dispatcher:  Arc<dyn CallbackDispatcher>,
	callback:    Str,
	concurrency: CallbackConcurrency,
	timeout:     time::Duration,
	next_id:     Arc<AtomicU64>,
}

impl ConsoleUsageFetcher for ExtensionUsageFetcher {
	fn provider(&self) -> &ProviderId<str> {
		&self.provider
	}

	fn credential_requirement(&self) -> UsageCredentialRequirement {
		UsageCredentialRequirement::Optional
	}

	fn fetch<'a>(
		&'a self,
		credential: Option<&'a omp_core::SecretString>,
		now: time::SystemTime,
		deadline: Option<time::Instant>,
	) -> futures::future::BoxFuture<'a, Result<ConsoleUsageObservation, UsageFetchError>> {
		Box::pin(async move {
			let id = self.next_id.fetch_add(1, Ordering::Relaxed).max(1);
			let mut payload = JsonMap::new();
			payload.insert("provider".to_owned(), JsonValue::String(self.provider.to_string()));
			payload.insert("identity".to_owned(), JsonValue::Null);
			payload.insert("scope".to_owned(), JsonValue::String("all".to_owned()));
			payload.insert("allow_stale".to_owned(), JsonValue::Bool(true));
			if let Some(credential) = credential {
				payload.insert(
					"api_key".to_owned(),
					json!({"$bytes": omp_core::base64::encode(credential.expose_secret().as_bytes())}),
				);
			}
			let mut arguments = JsonMap::new();
			arguments.insert("event".to_owned(), JsonValue::String("provider_usage".to_owned()));
			arguments.insert("phase".to_owned(), JsonValue::String("domain".to_owned()));
			arguments.insert("name".to_owned(), JsonValue::String(self.callback.to_string()));
			arguments.insert("payload".to_owned(), JsonValue::Object(payload));
			let timeout_at = deadline.unwrap_or_else(|| time::Instant::now() + self.timeout);
			let result = self
				.dispatcher
				.dispatch(Arc::clone(&self.identity), ControlDispatch {
					operation: sf!("omp.hooks.dispatch"),
					arguments,
					authority: ControlInvocationAuthority {
						invocation:        sf!("provider-usage:{}:{id}", self.identity.host_generation),
						phase:             InvocationPhase::EffectsAuthorized,
						session:           self.session.clone(),
						turn:              None,
						event:             Some(sf!("provider_usage")),
						call:              None,
						device:            None,
						effects:           Box::new([]),
						place_kind:        sf!("host"),
						lifecycle:         LifecyclePhase::Active,
						roots:             Box::new([]),
						remote:            false,
						has_ui:            false,
						headless:          true,
						settings:          self.settings.clone(),
						secret_settings:   Box::new([]),
						data:              None,
						direct_filesystem: None,
					},
					policy: self.concurrency,
					deadline: EventDeadline { at: timeout_at },
				})
				.await
				.map_err(|error| {
					if error.code.as_str().contains("Auth") {
						UsageFetchError::AuthRejected
					} else {
						UsageFetchError::Unavailable
					}
				})?;
			decode_extension_usage(result, now)
		})
	}
}

fn decode_extension_usage(
	value: JsonValue,
	observed_at: time::SystemTime,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	let report = value.as_object().ok_or(UsageFetchError::Protocol)?;
	let windows = report
		.get("windows")
		.and_then(JsonValue::as_array)
		.ok_or(UsageFetchError::Protocol)?
		.iter()
		.map(|window| decode_extension_usage_window(window, observed_at))
		.collect::<Result<Vec<_>, _>>()?;
	Ok(ConsoleUsageObservation {
		account_meta: UsageAccountMetadata::default(),
		plan: report
			.get("plan")
			.and_then(JsonValue::as_str)
			.map(Str::from),
		source_label: Some(sf!("extension")),
		notes: Box::new([]),
		reset_credits: None,
		windows,
	})
}

fn decode_extension_usage_window(
	value: &JsonValue,
	observed_at: time::SystemTime,
) -> Result<UsageWindow, UsageFetchError> {
	let window = value.as_object().ok_or(UsageFetchError::Protocol)?;
	let unit = match window.get("unit").and_then(JsonValue::as_str) {
		Some("requests") => UsageUnit::Requests,
		Some("tokens") => UsageUnit::Tokens,
		Some("premium_units") => UsageUnit::Unknown,
		Some("nanos_usd") => UsageUnit::Usd,
		_ => return Err(UsageFetchError::Protocol),
	};
	let exponent = u8::from(unit == UsageUnit::Usd) * 9;
	let consumed = window
		.get("used")
		.and_then(JsonValue::as_u64)
		.map(|units| UsageQuantity::new(units, exponent));
	let limit = window
		.get("limit")
		.and_then(JsonValue::as_u64)
		.map(|units| UsageQuantity::new(units, exponent));
	let remaining = match (consumed, limit) {
		(Some(consumed), Some(limit)) => {
			Some(UsageQuantity::new(limit.units.saturating_sub(consumed.units), exponent))
		},
		_ => None,
	};
	let resets_at = window
		.get("resets_at_ms")
		.and_then(JsonValue::as_u64)
		.map(|millis| time::UNIX_EPOCH + time::Duration::from_millis(millis));
	Ok(UsageWindow {
		id: window
			.get("id")
			.and_then(JsonValue::as_str)
			.map(Str::from)
			.ok_or(UsageFetchError::Protocol)?,
		kind: UsageWindowKind::Quota,
		dimension: Str::from(
			window
				.get("unit")
				.and_then(JsonValue::as_str)
				.unwrap_or("usage"),
		),
		label: None,
		scope: None,
		amount: UsageAmount { unit, consumed, remaining, limit },
		status: None,
		duration: None,
		resets_at,
		reset_label: None,
		notes: Box::new([]),
		source: UsageSource::Provider,
		observed_at,
	})
}

fn usage_registration_id(subscription: &HookSubscription) -> Str {
	sf!(
		"{}:{}:{}:{}",
		subscription.identity.extension,
		subscription.identity.host_generation,
		subscription.identity.session_generation,
		subscription.name
	)
}

#[derive(Clone)]
struct McpQueuedDelivery {
	notification:  McpHookNotification,
	subscriptions: Vec<HookSubscription>,
}

struct McpDeliveryQueue {
	pending:         VecDeque<McpQueuedDelivery>,
	running_servers: BTreeSet<Str>,
	dropped:         u64,
}

impl McpDeliveryQueue {
	fn push(&mut self, delivery: McpQueuedDelivery) -> bool {
		let dropped = self.pending.len() == MCP_HOOK_QUEUE_CAPACITY;
		if dropped {
			self.pending.pop_front();
			self.dropped = self.dropped.saturating_add(1);
		}
		self.pending.push_back(delivery);
		dropped
	}
}

/// Per-session MCP notification queue capacity.
pub const MCP_HOOK_QUEUE_CAPACITY: usize = 100;

#[derive(Clone)]
pub struct HookControlFactory {
	registries:                   Arc<RegistryControlFactory>,
	dispatcher:                   Arc<dyn CallbackDispatcher>,
	callbacks:                    Arc<NestedCallbackDispatcher>,
	policies:                     Arc<RwLock<BTreeMap<Str, HookEventPolicy>>>,
	subscriptions:                Arc<RwLock<BTreeMap<ControlConnectionKey, Vec<HookSubscription>>>>,
	usage_fetchers:               UsageFetcherRegistry,
	mcp_queues:                   Arc<Mutex<BTreeMap<u64, McpDeliveryQueue>>>,
	mcp_journal:                  Arc<RwLock<Option<(Arc<TelemetryIndex>, Str)>>>,
	provider_response_subscribed: Arc<AtomicBool>,
	settings:                     Arc<BTreeMap<(Str, Str, Str), JsonMap<String, JsonValue>>>,
	tool_call_timeout:            time::Duration,
	admission_gate:               Arc<HookGate>,
}

fn extension_callback_timeout(
	event: &str,
	configured: time::Duration,
	subscription: Option<time::Duration>,
	event_default: time::Duration,
) -> time::Duration {
	if event == "tool_call" {
		subscription.map_or(configured, |timeout| timeout.min(configured))
	} else {
		subscription.unwrap_or(event_default)
	}
}

impl HookControlFactory {
	/// Creates the composed hook owner over the live callback dispatcher.
	pub fn new(
		registries: Arc<RegistryControlFactory>,
		dispatcher: Arc<dyn CallbackDispatcher>,
		policies: BTreeMap<Str, HookEventPolicy>,
		settings: BTreeMap<(Str, Str, Str), JsonMap<String, JsonValue>>,
		tool_call_timeout: time::Duration,
	) -> Arc<Self> {
		let admission_timeout = tool_call_timeout
			.checked_mul(OBSERVE_HANDLER_CAP as u32)
			.unwrap_or(time::Duration::MAX);
		let (admission_gate, dispatches) =
			HookGate::delegated_channel_with_tool_call_timeout(admission_timeout);
		let owner = Arc::new(Self {
			registries,
			dispatcher: Arc::clone(&dispatcher),
			callbacks: Arc::new(NestedCallbackDispatcher::new(dispatcher)),
			policies: Arc::new(RwLock::new(policies)),
			subscriptions: Arc::new(RwLock::new(BTreeMap::new())),
			usage_fetchers: UsageFetcherRegistry::default(),
			mcp_queues: Arc::new(Mutex::new(BTreeMap::new())),
			mcp_journal: Arc::new(RwLock::new(None)),
			provider_response_subscribed: Arc::new(AtomicBool::new(false)),
			settings: Arc::new(settings),
			tool_call_timeout,
			admission_gate: Arc::new(admission_gate),
		});
		let weak = Arc::downgrade(&owner);
		tokio::spawn(async move {
			while let Ok(dispatch) = dispatches.recv_async().await {
				let Some(owner) = weak.upgrade() else {
					break;
				};
				tokio::spawn(async move {
					owner.answer_admission_dispatch(dispatch).await;
				});
			}
		});
		owner
	}

	fn settings_for(&self, identity: &ControlConnectionIdentity) -> JsonMap<String, JsonValue> {
		self
			.settings
			.get(&(identity.layer.clone(), identity.tier.clone(), identity.extension.clone()))
			.cloned()
			.unwrap_or_default()
	}

	fn callback_timeout(
		&self,
		event: &str,
		subscription: &HookSubscription,
		policy: &HookEventPolicy,
	) -> time::Duration {
		extension_callback_timeout(
			event,
			self.tool_call_timeout,
			subscription.timeout,
			policy.timeout,
		)
	}

	async fn answer_admission_dispatch(&self, dispatch: AgentHookDispatch) {
		let event = hook_event_name(dispatch.event);
		let identity = event.as_deref().and_then(|event| {
			self
				.subscriptions
				.read()
				.values()
				.flatten()
				.find(|row| row.event == event)
				.map(|row| (Arc::clone(&row.identity), row.session.clone()))
		});
		let decision = match (event, identity) {
			(Some(event), Some((identity, session))) => {
				let payload = if dispatch.phase == HookPhase::Observe {
					serde_json::from_slice::<JsonValue>(&dispatch.payload).ok()
				} else {
					dispatch
						.payload
						.iter()
						.position(|byte| *byte == b'\n')
						.and_then(|separator| {
							serde_json::from_slice::<JsonValue>(&dispatch.payload[separator + 1..]).ok()
						})
				};
				match payload {
					Some(mut payload) => {
						if event == "tool_call" && !hydrate_tool_call_bash(&mut payload) {
							let _ = self.admission_gate.answer(dispatch.dispatch_id, vec![(
								0,
								GateDecision::Deny(sf!("malformed tool_call Bash IR admission payload")),
							)]);
							return;
						}
						let shutdown_bounded = event == "session_shutdown";
						let event_id = Str::from(event.as_str());
						let mut arguments = JsonMap::new();
						arguments.insert("event".to_owned(), JsonValue::String(event.clone()));
						arguments
							.insert("event_rev".to_owned(), JsonValue::from(u64::from(dispatch.rev)));
						arguments.insert("payload".to_owned(), payload.clone());
						let settings = self.settings_for(&identity);
						let context = ControlRequestContext {
							connection: identity,
							request_id: dispatch.dispatch_id,
							invocation: Some(ControlInvocationAuthority {
								invocation: sf!("hook-admission:{}", dispatch.dispatch_id),
								phase: InvocationPhase::EffectsAuthorized,
								session,
								turn: None,
								event: Some(event_id.clone()),
								call: None,
								device: None,
								effects: Box::new([]),
								place_kind: sf!("host"),
								lifecycle: LifecyclePhase::Active,
								roots: Box::new([]),
								remote: false,
								has_ui: false,
								headless: true,
								settings,
								secret_settings: Box::new([]),
								data: None,
								direct_filesystem: None,
							}),
						};
						if dispatch.phase == HookPhase::Observe {
							self.observe(&context, event_id.as_str(), &payload).await;
							GateDecision::Defer
						} else {
							let composed = if shutdown_bounded {
								match tokio::time::timeout(
									time::Duration::from_secs(2),
									self.compose(&context, &arguments),
								)
								.await
								{
									Ok(result) => result,
									Err(_) => Ok(json!({"kind": "defer"})),
								}
							} else {
								self.compose(&context, &arguments).await
							};
							match composed {
								Ok(value) => gate_decision_from_json(value, payload),
								Err(error) => GateDecision::Deny(error.message),
							}
						}
					},
					None => GateDecision::Deny(sf!("malformed hook admission payload")),
				}
			},
			_ => GateDecision::Deny(sf!("required hook subscription unavailable")),
		};
		let _ = self
			.admission_gate
			.answer(dispatch.dispatch_id, vec![(0, decision)]);
	}

	/// Binds durable accounting for drop-oldest MCP queue overflow.
	pub fn bind_mcp_drop_journal(&self, telemetry: Arc<TelemetryIndex>, session: Str) {
		*self.mcp_journal.write() = Some((telemetry, session));
	}

	/// Returns the per-session admission gate backed by this live composer.
	pub fn admission_gate(&self) -> Arc<HookGate> {
		Arc::clone(&self.admission_gate)
	}

	/// Returns the shared runtime provider usage registry.
	pub fn usage_fetchers(&self) -> UsageFetcherRegistry {
		self.usage_fetchers.clone()
	}

	/// Installs callback details only for a key proven by the sealed registry
	/// effect. Re-installing the same name replaces its old declaration within
	/// the exact host generation.
	pub fn subscribe(&self, subscription: HookSubscription) -> Result<(), ControlProtocolError> {
		let evidence = self
			.registries
			.evidence(&subscription.identity)
			.ok_or_else(|| {
				ControlProtocolError::new(
					"RegistryUnavailable",
					"hook subscription requires sealed registry evidence",
				)
			})?;
		if !evidence
			.hooks
			.iter()
			.any(|hook| hook.event == subscription.event && hook.phase == subscription.phase)
		{
			return Err(ControlProtocolError::new(
				"RegistryUnauthorized",
				"hook subscription is absent from sealed registry evidence",
			));
		}
		let key = connection_key(&subscription.identity);
		let mut policies = self.policies.write();
		match policies.get(&subscription.event) {
			Some(policy) if policy != &subscription.event_policy => {
				return Err(ControlProtocolError::new(
					"HookContractError",
					"hook registrations disagree on their event policy",
				));
			},
			Some(_) => {},
			None => {
				policies.insert(subscription.event.clone(), subscription.event_policy.clone());
			},
		}
		drop(policies);
		let mut subscriptions = self.subscriptions.write();
		let fetchers = self.usage_fetchers.clone();
		{
			for (candidate, rows) in subscriptions.iter() {
				if candidate.0 == key.0
					&& candidate.1 == key.1
					&& candidate.2 == key.2
					&& *candidate != key
				{
					for row in rows.iter().filter(|row| row.event == "provider_usage") {
						for provider in row.providers.as_deref().unwrap_or_default() {
							let provider = ProviderId::from(provider.clone());
							fetchers.unregister_runtime(&provider, usage_registration_id(row).as_str());
						}
					}
				}
			}
		}
		subscriptions.retain(|candidate, _| {
			candidate.0 != key.0 || candidate.1 != key.1 || candidate.2 != key.2 || *candidate == key
		});
		let rows = subscriptions.entry(key).or_default();
		rows.retain(|row| {
			row.event != subscription.event
				|| row.phase != subscription.phase
				|| row.name != subscription.name
		});
		rows.push(subscription);
		if rows.last().is_some_and(|row| row.event == "provider_usage") {
			let fetchers = self.usage_fetchers.clone();
			let row = rows.last().expect("subscription was just inserted");
			let session = row.session.clone();
			for provider in row.providers.as_deref().unwrap_or_default() {
				fetchers.register_runtime(
					usage_registration_id(row),
					Arc::new(ExtensionUsageFetcher {
						provider:    ProviderId::from(provider.clone()),
						settings:    self.settings_for(&row.identity),
						identity:    Arc::clone(&row.identity),
						session:     session.clone(),
						dispatcher:  Arc::clone(&self.dispatcher),
						callback:    row.name.clone(),
						concurrency: row.concurrency,
						timeout:     row.timeout.unwrap_or(row.event_policy.timeout),
						next_id:     Arc::new(AtomicU64::new(1)),
					}),
				);
			}
		}
		self.provider_response_subscribed.store(
			subscriptions
				.values()
				.flatten()
				.any(|row| row.event == "provider_response" && row.phase == "observe"),
			Ordering::Release,
		);
		let mask = subscriptions
			.values()
			.flatten()
			.filter_map(|row| hook_event_id(row.event.as_str()))
			.fold(0_u128, |mask, event| mask | (1_u128 << event as u32));
		let fail_closed = subscriptions
			.values()
			.flatten()
			.filter(|row| {
				row.on_failure.unwrap_or(row.event_policy.on_failure) == HookFailurePolicy::Deny
			})
			.filter_map(|row| hook_event_id(row.event.as_str()))
			.fold(0_u128, |mask, event| mask | (1_u128 << event as u32));
		self.admission_gate.replace_masks(mask, fail_closed);
		Ok(())
	}

	fn enqueue_mcp(&self, session_generation: u64, delivery: McpQueuedDelivery) {
		{
			let mut queues = self.mcp_queues.lock();
			let queue = queues
				.entry(session_generation)
				.or_insert_with(|| McpDeliveryQueue {
					pending:         VecDeque::with_capacity(MCP_HOOK_QUEUE_CAPACITY),
					running_servers: BTreeSet::new(),
					dropped:         0,
				});
			if queue.push(delivery) {
				let dropped = queue.dropped;
				tracing::warn!(
					session_generation,
					dropped,
					"journal: dropped oldest MCP hook notification"
				);
				if let Some((telemetry, session)) = self.mcp_journal.read().clone() {
					let encoded = json!({
						"session_generation": session_generation,
						"dropped": dropped,
					})
					.to_string();
					tokio::task::spawn_blocking(move || {
						let occurred_at_ms = time::SystemTime::now()
							.duration_since(time::UNIX_EPOCH)
							.map_or(0, |elapsed| elapsed.as_millis().try_into().unwrap_or(u64::MAX));
						let _ = telemetry.append(
							session.as_str(),
							"mcp_notification_dropped",
							occurred_at_ms,
							encoded.as_bytes(),
						);
					});
				}
			}
		}
		self.schedule_mcp(session_generation);
	}

	fn schedule_mcp(&self, session_generation: u64) {
		loop {
			let delivery = {
				let mut queues = self.mcp_queues.lock();
				let Some(queue) = queues.get_mut(&session_generation) else {
					return;
				};
				let Some(index) = queue.pending.iter().position(|delivery| {
					!queue
						.running_servers
						.contains(&delivery.notification.server)
				}) else {
					return;
				};
				let delivery = queue
					.pending
					.remove(index)
					.expect("selected delivery exists");
				queue
					.running_servers
					.insert(delivery.notification.server.clone());
				delivery
			};
			let owner = self.clone();
			tokio::spawn(async move {
				let server = delivery.notification.server.clone();
				owner
					.clone()
					.deliver_mcp(session_generation, delivery)
					.await;
				{
					let mut queues = owner.mcp_queues.lock();
					if let Some(queue) = queues.get_mut(&session_generation) {
						queue.running_servers.remove(&server);
					}
				}
				owner.schedule_mcp(session_generation);
			});
		}
	}

	async fn deliver_mcp(self, session_generation: u64, delivery: McpQueuedDelivery) {
		for subscription in delivery.subscriptions {
			let notification = &delivery.notification;
			let mut arguments = JsonMap::new();
			arguments
				.insert(String::from("event"), JsonValue::String(String::from("mcp_notification")));
			arguments.insert(String::from("phase"), JsonValue::String(String::from("observe")));
			arguments.insert(String::from("name"), JsonValue::String(subscription.name.to_string()));
			arguments.insert(
				String::from("payload"),
				json!({
					"server": notification.server,
					"method": notification.method,
					"params": notification.params,
					"sequence": notification.sequence,
				}),
			);
			let _ = self
				.dispatcher
				.dispatch(Arc::clone(&subscription.identity), ControlDispatch {
					operation: sf!("omp.hooks.dispatch"),
					arguments,
					authority: ControlInvocationAuthority {
						invocation:        sf!(
							"mcp-notification:{}:{}",
							notification.server,
							notification.sequence
						),
						phase:             InvocationPhase::Open,
						session:           sf!("session-{session_generation}"),
						turn:              None,
						event:             Some(sf!("mcp_notification")),
						call:              None,
						device:            None,
						effects:           Box::new([]),
						place_kind:        sf!("host"),
						lifecycle:         LifecyclePhase::Active,
						roots:             Box::new([]),
						remote:            false,
						has_ui:            false,
						headless:          true,
						settings:          self.settings_for(&subscription.identity),
						secret_settings:   Box::new([]),
						data:              None,
						direct_filesystem: None,
					},
					policy: subscription.concurrency,
					deadline: EventDeadline {
						at: time::Instant::now()
							+ subscription
								.timeout
								.unwrap_or(subscription.event_policy.timeout),
					},
				})
				.await;
		}
	}

	async fn dispatch_provider_domain(
		&self,
		event: &'static str,
		provider: &ProviderId<str>,
		payload: JsonValue,
		fail_closed: bool,
	) -> Result<Vec<JsonValue>, ProviderHookError> {
		let mut rows = self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.filter(|row| {
				row.event == event
					&& row.phase == "domain"
					&& row.providers.as_ref().is_none_or(|providers| {
						providers
							.iter()
							.any(|candidate| candidate.as_str() == provider.as_str())
					})
			})
			.cloned()
			.collect::<Vec<_>>();
		rows.sort_by(|left, right| {
			left
				.identity
				.layer
				.cmp(&right.identity.layer)
				.then_with(|| left.identity.tier.cmp(&right.identity.tier))
				.then_with(|| left.identity.extension.cmp(&right.identity.extension))
				.then_with(|| left.name.cmp(&right.name))
		});
		if rows.is_empty() {
			return Err(ProviderHookError::Unavailable);
		}
		let mut values = Vec::with_capacity(rows.len());
		for row in rows {
			let session = row.session.clone();
			let context = ControlRequestContext {
				connection: Arc::clone(&row.identity),
				request_id: 0,
				invocation: Some(ControlInvocationAuthority {
					invocation: sf!("{event}:{}", Ulid::generate()),
					phase: InvocationPhase::EffectsAuthorized,
					session,
					turn: None,
					event: Some(Str::new_static(event)),
					call: None,
					device: None,
					effects: Box::new([]),
					place_kind: sf!("host"),
					lifecycle: LifecyclePhase::Active,
					roots: Box::new([]),
					remote: false,
					has_ui: event == "provider_login",
					headless: event != "provider_login",
					settings: self.settings_for(&row.identity),
					secret_settings: Box::new([]),
					data: None,
					direct_filesystem: None,
				}),
			};
			let mut callback = JsonMap::new();
			callback.insert("event".to_owned(), JsonValue::String(event.to_owned()));
			callback.insert("phase".to_owned(), JsonValue::String("domain".to_owned()));
			callback.insert("name".to_owned(), JsonValue::String(row.name.to_string()));
			callback.insert("payload".to_owned(), payload.clone());
			match self
				.callbacks
				.dispatch_provider_hook(
					Arc::clone(&row.identity),
					&context,
					event,
					callback,
					row.concurrency,
					row.timeout.unwrap_or(row.event_policy.timeout),
				)
				.await
			{
				Ok(value) => values.push(value),
				Err(_) if fail_closed => return Err(ProviderHookError::Failed),
				Err(_) => {},
			}
		}
		if values.is_empty() {
			Err(if fail_closed {
				ProviderHookError::Failed
			} else {
				ProviderHookError::Unavailable
			})
		} else {
			Ok(values)
		}
	}

	async fn observe(&self, context: &ControlRequestContext, event: &str, payload: &JsonValue) {
		let scoped_provider = payload.get("provider").and_then(JsonValue::as_str);
		let mut rows = self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.filter(|row| {
				row.event == event
					&& row.phase == "observe"
					&& row.identity.session_generation == context.connection.session_generation
					&& row.providers.as_ref().is_none_or(|providers| {
						scoped_provider.is_none_or(|provider| {
							providers
								.iter()
								.any(|candidate| candidate.as_str() == provider)
						})
					}) && lifecycle_hook_recipient(event, payload, row.identity.extension.as_str())
			})
			.cloned()
			.collect::<Vec<_>>();
		rows.sort_by(|left, right| {
			left
				.identity
				.layer
				.cmp(&right.identity.layer)
				.then_with(|| left.identity.tier.cmp(&right.identity.tier))
				.then_with(|| left.identity.extension.cmp(&right.identity.extension))
				.then_with(|| left.name.cmp(&right.name))
		});
		rows.truncate(OBSERVE_HANDLER_CAP);
		let deliveries = rows.into_iter().map(|row| {
			let mut callback = JsonMap::new();
			callback.insert(String::from("event"), JsonValue::String(event.to_owned()));
			callback.insert(String::from("phase"), JsonValue::String(String::from("observe")));
			callback.insert(String::from("name"), JsonValue::String(row.name.to_string()));
			callback.insert(String::from("payload"), payload.clone());
			async move {
				let _ = self
					.callbacks
					.dispatch(
						Arc::clone(&row.identity),
						context,
						"omp.hooks.dispatch",
						callback,
						row.concurrency,
						row.timeout.unwrap_or(row.event_policy.timeout),
						Some(row.event.clone()),
						None,
					)
					.await;
			}
		});
		let _ = futures::future::join_all(deliveries).await;
	}

	async fn compose(
		&self,
		context: &ControlRequestContext,
		arguments: &JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		require_active_invocation(context)?;
		let event = required_string(arguments, "event")?;
		let event_rev = required_u16(arguments, "event_rev")?;
		let policy = self.policies.read().get(&event).cloned().ok_or_else(|| {
			ControlProtocolError::new("UnknownEvent", format!("unknown hook event {event}"))
		})?;
		if event_rev != policy.revision {
			return Err(ControlProtocolError::new(
				"HookContractError",
				format!("hook event revision mismatch: expected {}, got {event_rev}", policy.revision),
			));
		}
		let mut payload = arguments.get("payload").cloned().unwrap_or(JsonValue::Null);
		let scoped_provider = payload.get("provider").and_then(JsonValue::as_str);
		let mut rows = self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.filter(|row| {
				row.event == event
					&& row.phase != "observe"
					&& row.identity.session_generation == context.connection.session_generation
					&& row.providers.as_ref().is_none_or(|providers| {
						scoped_provider.is_none_or(|provider| {
							providers
								.iter()
								.any(|candidate| candidate.as_str() == provider)
						})
					}) && lifecycle_hook_recipient(
					event.as_str(),
					&payload,
					row.identity.extension.as_str(),
				)
			})
			.cloned()
			.collect::<Vec<_>>();
		rows.sort_by(|left, right| {
			hook_phase_rank(&left.phase)
				.cmp(&hook_phase_rank(&right.phase))
				.then_with(|| left.order.cmp(&right.order))
				.then_with(|| left.identity.layer.cmp(&right.identity.layer))
				.then_with(|| left.identity.tier.cmp(&right.identity.tier))
				.then_with(|| left.identity.extension.cmp(&right.identity.extension))
				.then_with(|| left.name.cmp(&right.name))
		});
		let mut modification: Option<JsonMap<String, JsonValue>> = None;
		let mut approvals = Vec::new();
		for row in rows {
			let mut callback = JsonMap::new();
			callback.insert(String::from("event"), JsonValue::String(event.to_string()));
			callback.insert(String::from("phase"), JsonValue::String(row.phase.to_string()));
			callback.insert(String::from("name"), JsonValue::String(row.name.to_string()));
			callback.insert(String::from("payload"), payload.clone());
			let result = self
				.callbacks
				.dispatch(
					Arc::clone(&row.identity),
					context,
					"omp.hooks.dispatch",
					callback,
					row.concurrency,
					self.callback_timeout(event.as_str(), &row, &policy),
					Some(event.clone()),
					None,
				)
				.await;
			let result = match result {
				Ok(result) => result,
				Err(error) => {
					match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
						None => continue,
						Some(decision) => return Ok(decision),
					}
				},
			};
			let result = if row.phase == "domain" {
				match domain_reply_decision(result)? {
					Some(decision) => decision,
					None => continue,
				}
			} else {
				result
			};
			let Some(decision) = result.as_object() else {
				let error = ControlProtocolError::new(
					"HookContractError",
					"hook callback returned a non-object decision",
				);
				match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
					None => continue,
					Some(decision) => return Ok(decision),
				}
			};
			let kind = decision.get("kind").and_then(JsonValue::as_str);
			if !hook_decision_is_legal(row.phase.as_str(), kind) {
				let error = ControlProtocolError::new(
					"HookContractError",
					"hook callback returned a decision illegal in its phase",
				);
				match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
					None => continue,
					Some(decision) => return Ok(decision),
				}
			}
			match kind {
				Some("deny") => return Ok(result),
				Some("require_approval") => {
					let Some(spec) = decision.get("spec").cloned() else {
						let error = ControlProtocolError::new(
							"HookContractError",
							"approval decision omitted its specification",
						);
						match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
							None => continue,
							Some(decision) => return Ok(decision),
						}
					};
					approvals.push(approval_spec_with_provenance(
						spec,
						row.name.as_str(),
						row.identity.extension.as_str(),
						row.identity.host_generation,
						row.identity.session_generation,
					));
				},
				Some("allow" | "defer") => {},
				Some("modify") => {
					if let Err(error) = compose_hook_modify(
						event.as_str(),
						&policy,
						&mut payload,
						&mut modification,
						decision,
					) {
						match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
							None => continue,
							Some(decision) => return Ok(decision),
						}
					}
				},
				_ => unreachable!("phase legality checked the closed decision vocabulary"),
			}
		}
		if approvals.is_empty() {
			Ok(modification.map_or_else(|| policy.default.clone(), JsonValue::Object))
		} else {
			Ok(json!({
				"kind": "require_approvals",
				"specs": approvals,
				"effective": payload,
			}))
		}
	}
}

fn hook_event_id(event: &str) -> Option<HookEventId> {
	let mut name = String::with_capacity("HOOK_EVENT_".len() + event.len());
	name.push_str("HOOK_EVENT_");
	name.extend(
		event
			.chars()
			.map(|character| character.to_ascii_uppercase()),
	);
	HookEventId::from_str_name(&name)
}

fn hook_event_name(event: HookEventId) -> Option<String> {
	event
		.as_str_name()
		.strip_prefix("HOOK_EVENT_")
		.map(str::to_ascii_lowercase)
}

fn hydrate_tool_call_bash(payload: &mut JsonValue) -> bool {
	let Some(object) = payload.as_object_mut() else {
		return false;
	};
	let Some(wire) = object.remove("__omp_bash_proto") else {
		return true;
	};
	if wire.is_null() {
		return true;
	}
	let Some(encoded) = wire
		.as_object()
		.and_then(|wire| wire.get("$bytes"))
		.and_then(JsonValue::as_str)
	else {
		return false;
	};
	let Ok(bytes) = omp_core::base64::decode(encoded).into_vec() else {
		return false;
	};
	let Ok(ir) = omp_proto::policy::v1::BashIr::decode(bytes.as_slice()) else {
		return false;
	};
	let source = ir.source.clone();
	object.insert(String::from("bash"), crate::policy::bash_ir_json(&ir, &source));
	true
}

fn gate_decision_from_json(value: JsonValue, mut payload: JsonValue) -> GateDecision {
	let Some(decision) = value.as_object() else {
		return GateDecision::Deny(sf!("hook composer returned a non-object decision"));
	};
	match decision.get("kind").and_then(JsonValue::as_str) {
		Some("allow") => GateDecision::Allow,
		Some("defer") => GateDecision::Defer,
		Some("modify") => {
			let Some(effective) = payload.as_object_mut() else {
				return GateDecision::Deny(sf!("hook modification requires an object payload"));
			};
			for (field, value) in decision
				.get("patch")
				.and_then(JsonValue::as_object)
				.into_iter()
				.flatten()
			{
				effective.insert(field.clone(), value.clone());
			}
			for field in decision
				.get("unset")
				.and_then(JsonValue::as_array)
				.into_iter()
				.flatten()
				.filter_map(JsonValue::as_str)
			{
				effective.remove(field);
			}
			match serde_json::to_vec(&payload) {
				Ok(args) => GateDecision::Modify(HookPatch {
					target: None,
					args:   Some(bytes::Bytes::from(args)),
				}),
				Err(error) => GateDecision::Deny(Str::from(format!(
					"could not encode effective hook payload: {error}"
				))),
			}
		},
		Some("deny") => {
			let reason = decision
				.get("reason")
				.and_then(JsonValue::as_str)
				.map_or_else(|| sf!("hook policy denied operation"), Str::from);
			let code = decision
				.get("code")
				.and_then(JsonValue::as_str)
				.map(Str::from);
			let decision_id = decision
				.get("decision_id")
				.and_then(JsonValue::as_str)
				.map_or_else(|| Str::from(Ulid::generate().to_string()), Str::from);
			let rules = decision
				.get("rules")
				.and_then(JsonValue::as_array)
				.into_iter()
				.flatten()
				.filter_map(|rule| {
					rule
						.as_object()
						.and_then(|rule| rule.get("id"))
						.and_then(JsonValue::as_str)
						.map(Str::from)
				})
				.collect::<Vec<_>>();
			GateDecision::DenyPolicy(Arc::new(omp_tool::PolicyDenied {
				reason,
				code,
				decision_id,
				rules: rules.into(),
			}))
		},
		Some("require_approval") => {
			match decision
				.get("spec")
				.cloned()
				.ok_or_else(|| {
					ControlProtocolError::new(
						"HookContractError",
						"approval decision omitted its specification",
					)
				})
				.and_then(crate::policy::approval_spec)
			{
				Ok(spec) => GateDecision::RequireApproval(spec),
				Err(error) => GateDecision::Deny(error.message),
			}
		},
		Some("require_approvals") => {
			let specs = decision
				.get("specs")
				.and_then(JsonValue::as_array)
				.ok_or_else(|| {
					ControlProtocolError::new(
						"HookContractError",
						"composed approval decision omitted its specifications",
					)
				})
				.and_then(|specs| {
					specs
						.iter()
						.cloned()
						.map(crate::policy::approval_spec)
						.collect::<Result<Vec<_>, _>>()
				});
			match specs {
				Ok(specs) if !specs.is_empty() => {
					let patch = decision
						.get("effective")
						.map(serde_json::to_vec)
						.transpose()
						.map(|args| args.map(bytes::Bytes::from))
						.map(|args| args.map(|args| HookPatch { target: None, args: Some(args) }));
					match patch {
						Ok(patch) => GateDecision::RequireApprovals { specs, patch },
						Err(error) => GateDecision::Deny(Str::from(format!(
							"could not encode effective hook payload: {error}"
						))),
					}
				},
				Ok(_) => GateDecision::Deny(sf!("composed approval decision was empty")),
				Err(error) => GateDecision::Deny(error.message),
			}
		},
		_ => GateDecision::Deny(sf!("hook composer returned an illegal admission decision")),
	}
}

impl McpNotificationSink for HookControlFactory {
	fn interested(&self, server: &str, method: &str) -> bool {
		self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.any(|row| {
				row.event == "mcp_notification"
					&& row.phase == "observe"
					&& mcp_subscription_matches(row, server, method)
			})
	}

	fn offer(&self, notification: McpHookNotification) {
		let rows = self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.filter(|row| {
				row.event == "mcp_notification"
					&& row.phase == "observe"
					&& mcp_subscription_matches(
						row,
						notification.server.as_str(),
						notification.method.as_str(),
					)
			})
			.cloned()
			.collect::<Vec<_>>();
		if rows.is_empty() {
			return;
		}
		let mut by_session = BTreeMap::<u64, Vec<HookSubscription>>::new();
		for row in rows {
			by_session
				.entry(row.identity.session_generation)
				.or_default()
				.push(row);
		}
		for (session_generation, subscriptions) in by_session {
			self.enqueue_mcp(session_generation, McpQueuedDelivery {
				notification: notification.clone(),
				subscriptions,
			});
		}
	}
}

impl ProviderHookObserver for HookControlFactory {
	fn provider_login_subscribed(&self, provider: &ProviderId<str>) -> bool {
		provider_hook_subscribed(self, "provider_login", provider)
	}

	fn provider_login<'a>(
		&'a self,
		request: ProviderLoginHookRequest,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<ProviderHookCredential, ProviderHookError>> + Send + 'a>,
	> {
		Box::pin(async move {
			let method: &'static str = request.method.into();
			let mut values = self
				.dispatch_provider_domain(
					"provider_login",
					&request.provider,
					json!({
						"provider": request.provider,
						"method": method.replace('-', "_"),
						"ui": {},
					}),
					true,
				)
				.await?;
			parse_provider_credential(values.pop().ok_or(ProviderHookError::Failed)?)
		})
	}

	fn provider_refresh_subscribed(&self, provider: &ProviderId<str>) -> bool {
		provider_hook_subscribed(self, "provider_refresh", provider)
	}

	fn provider_refresh<'a>(
		&'a self,
		request: ProviderRefreshHookRequest,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<ProviderHookCredential, ProviderHookError>> + Send + 'a>,
	> {
		Box::pin(async move {
			let mut values = self
				.dispatch_provider_domain(
					"provider_refresh",
					&request.provider,
					json!({
						"provider": request.provider,
						"identity": request.identity,
						"refresh_token": {
							"$bytes": omp_core::base64::encode(
								request.refresh_token.expose_secret().as_bytes()
							),
						},
						"expires_at_ms": request.expires_at_ms,
						"props": request.props,
						"reason": request.reason.to_string(),
					}),
					true,
				)
				.await?;
			parse_provider_credential(values.pop().ok_or(ProviderHookError::Failed)?)
		})
	}

	fn provider_sign_subscribed(&self, provider: &ProviderId<str>) -> bool {
		provider_hook_subscribed(self, "provider_sign", provider)
	}

	fn provider_sign<'a>(
		&'a self,
		request: ProviderSignHookRequest,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<ProviderSignature, ProviderHookError>> + Send + 'a>,
	> {
		Box::pin(async move {
			let provider = request.provider.clone();
			let headers = request
				.headers
				.iter()
				.map(|header| (header.name.to_string(), JsonValue::String(header.value.to_string())))
				.collect::<JsonMap<_, _>>();
			let mut values = self
				.dispatch_provider_domain(
					"provider_sign",
					&provider,
					json!({
						"provider": request.provider,
						"route": request.route,
						"method": request.method,
						"url": request.url,
						"headers": headers,
						"body_sha256": {
							"$bytes": omp_core::base64::encode(&request.body_sha256),
						},
						"signer": {},
					}),
					true,
				)
				.await?;
			parse_provider_signature(values.pop().ok_or(ProviderHookError::Failed)?)
		})
	}

	fn models_discover_subscribed(&self, provider: &ProviderId<str>) -> bool {
		provider_hook_subscribed(self, "models_discover", provider)
	}

	fn models_discover<'a>(
		&'a self,
		request: ModelsDiscoverHookRequest,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<ModelsDiscoverHookPage, ProviderHookError>> + Send + 'a>,
	> {
		Box::pin(async move {
			let values = self
				.dispatch_provider_domain(
					"models_discover",
					&request.provider,
					json!({
						"provider": request.provider,
						"route": request.route,
						"cursor": request.cursor,
						"page_size": request.page_size,
						"trigger": request.trigger,
					}),
					false,
				)
				.await?;
			let mut pages = values
				.into_iter()
				.map(parse_discovery_page)
				.collect::<Result<Vec<_>, _>>()?;
			let Some(mut page) = pages.pop() else {
				return Err(ProviderHookError::Unavailable);
			};
			for prior in pages {
				let ids = page
					.models
					.iter()
					.filter_map(|model| model.get("id").and_then(JsonValue::as_str))
					.map(Str::new)
					.collect::<BTreeSet<_>>();
				let retained = prior
					.models
					.into_vec()
					.into_iter()
					.filter(|model| {
						model
							.get("id")
							.and_then(JsonValue::as_str)
							.is_some_and(|id| ids.contains(id))
					})
					.collect::<Vec<_>>();
				page.models = retained.into_boxed_slice();
				page.authoritative |= prior.authoritative;
			}
			Ok(page)
		})
	}
}

fn provider_hook_subscribed(
	owner: &HookControlFactory,
	event: &str,
	provider: &ProviderId<str>,
) -> bool {
	owner.subscriptions.read().values().flatten().any(|row| {
		row.event == event
			&& row.phase == "domain"
			&& row.providers.as_ref().is_none_or(|providers| {
				providers
					.iter()
					.any(|candidate| candidate.as_str() == provider.as_str())
			})
	})
}

fn parse_provider_credential(
	value: JsonValue,
) -> Result<ProviderHookCredential, ProviderHookError> {
	let object = value.as_object().ok_or(ProviderHookError::InvalidResult)?;
	let kind = object
		.get("kind")
		.and_then(JsonValue::as_str)
		.filter(|kind| matches!(*kind, "api_key" | "bearer" | "oauth" | "aws" | "session"))
		.ok_or(ProviderHookError::InvalidResult)?;
	let secret = parse_hook_secret(
		object
			.get("secret")
			.ok_or(ProviderHookError::InvalidResult)?,
	)?;
	let refresh_token = object
		.get("refresh_token")
		.filter(|value| !value.is_null())
		.map(parse_hook_secret)
		.transpose()?;
	let props = object
		.get("props")
		.and_then(JsonValue::as_object)
		.cloned()
		.unwrap_or_default();
	if props.values().any(|value| {
		!matches!(value, JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_))
	}) {
		return Err(ProviderHookError::InvalidResult);
	}
	Ok(ProviderHookCredential {
		kind: Str::new(kind),
		secret,
		refresh_token,
		expires_at_ms: object.get("expires_at_ms").and_then(JsonValue::as_u64),
		identity: object
			.get("identity")
			.and_then(JsonValue::as_str)
			.map(Str::new),
		props,
	})
}

fn parse_hook_secret(value: &JsonValue) -> Result<SecretString, ProviderHookError> {
	let encoded = value
		.as_object()
		.and_then(|object| object.get("$bytes"))
		.and_then(JsonValue::as_str)
		.ok_or(ProviderHookError::InvalidResult)?;
	let bytes = omp_core::base64::decode(encoded)
		.into_vec()
		.map_err(|_| ProviderHookError::InvalidResult)?;
	let value = String::from_utf8(bytes).map_err(|_| ProviderHookError::InvalidResult)?;
	if value.is_empty() {
		return Err(ProviderHookError::InvalidResult);
	}
	Ok(SecretString::from(value))
}

fn parse_provider_signature(value: JsonValue) -> Result<ProviderSignature, ProviderHookError> {
	let object = value.as_object().ok_or(ProviderHookError::InvalidResult)?;
	let parse = |field: &str| {
		object
			.get(field)
			.and_then(JsonValue::as_object)
			.into_iter()
			.flatten()
			.map(|(name, value)| {
				let value = value
					.as_str()
					.filter(|value| !value.is_empty())
					.ok_or(ProviderHookError::InvalidResult)?;
				Ok((Str::new(name), SecretString::from(value)))
			})
			.collect::<Result<Vec<_>, ProviderHookError>>()
			.map(Vec::into_boxed_slice)
	};
	Ok(ProviderSignature { headers: parse("headers")?, query: parse("query")? })
}

fn parse_discovery_page(value: JsonValue) -> Result<ModelsDiscoverHookPage, ProviderHookError> {
	if let JsonValue::Array(models) = value {
		return Ok(ModelsDiscoverHookPage {
			models:        models.into_boxed_slice(),
			next_cursor:   None,
			authoritative: false,
		});
	}
	let object = value.as_object().ok_or(ProviderHookError::InvalidResult)?;
	let models = object
		.get("models")
		.and_then(JsonValue::as_array)
		.cloned()
		.ok_or(ProviderHookError::InvalidResult)?;
	if models
		.iter()
		.any(|model| model.get("id").and_then(JsonValue::as_str).is_none())
	{
		return Err(ProviderHookError::InvalidResult);
	}
	Ok(ModelsDiscoverHookPage {
		models:        models.into_boxed_slice(),
		next_cursor:   object
			.get("next_cursor")
			.and_then(JsonValue::as_str)
			.map(Str::new),
		authoritative: object
			.get("authoritative")
			.and_then(JsonValue::as_bool)
			.unwrap_or(false),
	})
}

impl ProviderResponseObserver for HookControlFactory {
	fn before_request_subscribed(&self) -> bool {
		self
			.admission_gate
			.subscribed(HookEventId::HookEventBeforeRequest)
	}

	fn before_request<'a>(
		&'a self,
		draft: &'a BeforeRequestDraft,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<BeforeRequestMutation, BeforeRequestDenied>> + Send + 'a>,
	> {
		let owner = self.clone();
		Box::pin(async move {
			let headers = draft
				.headers
				.iter()
				.map(|header| (header.name.to_string(), JsonValue::String(header.value.to_string())))
				.collect::<JsonMap<_, _>>();
			let payload = json!({
				"provider": draft.provider,
				"route": draft.route,
				"model": draft.model,
				"operation": draft.operation.to_string(),
				"scalars": draft.scalars,
				"headers": headers,
				"intents": draft.intents,
				"message_count": draft.message_count,
				"approx_prompt_tokens": draft.approx_prompt_tokens,
			});
			let requested = serde_json::to_vec(&payload)
				.map(bytes::Bytes::from)
				.map_err(|_| BeforeRequestDenied {
					reason: sf!("provider request hook payload could not be encoded"),
					code:   Some(sf!("HookContractError")),
				})?;
			let effective = match owner
				.admission_gate
				.gate(
					HookEventId::HookEventBeforeRequest,
					GateEvent::new(sf!("before_request"), requested.clone()),
				)
				.await
			{
				GateOutcome::Allow { event, .. } => {
					if event.effective_args == requested {
						return Ok(BeforeRequestMutation::default());
					}
					serde_json::from_slice::<JsonValue>(&event.effective_args).map_err(|_| {
						BeforeRequestDenied {
							reason: sf!("provider request hook payload could not be decoded"),
							code:   Some(sf!("HookContractError")),
						}
					})?
				},
				GateOutcome::Deny { reason, .. } => {
					return Err(BeforeRequestDenied { reason, code: None });
				},
				GateOutcome::Approval { .. } => {
					return Err(BeforeRequestDenied {
						reason: sf!("provider request hook requested unsupported approval"),
						code:   Some(sf!("HookContractError")),
					});
				},
			};
			let effective = effective.as_object().ok_or_else(|| BeforeRequestDenied {
				reason: sf!("provider request hook returned a non-object payload"),
				code:   Some(sf!("HookContractError")),
			})?;
			let body = effective
				.get("body")
				.and_then(JsonValue::as_object)
				.cloned()
				.unwrap_or_default();
			let headers = effective
				.get("headers")
				.and_then(JsonValue::as_object)
				.map(|headers| {
					headers
						.iter()
						.filter_map(|(name, value)| {
							(value.is_null() || value.is_string())
								.then(|| (Str::new(name), value.as_str().map(Str::new)))
						})
						.collect::<Vec<_>>()
						.into_boxed_slice()
				})
				.unwrap_or_default();
			let intents = effective
				.get("intents")
				.and_then(JsonValue::as_array)
				.map(|values| values.clone().into_boxed_slice());
			let timeout = effective
				.get("timeout")
				.and_then(|value| {
					value
						.as_str()
						.or_else(|| value.get("$duration").and_then(JsonValue::as_str))
				})
				.and_then(|value| value.parse::<omp_core::Duration>().ok())
				.and_then(|value| value.to_std().ok());
			Ok(BeforeRequestMutation { body, headers, intents, timeout })
		})
	}

	fn credential_disabled_subscribed(&self) -> bool {
		self
			.admission_gate
			.subscribed(HookEventId::HookEventCredentialDisabled)
	}

	fn observe_credential_disabled(&self, observation: CredentialDisabledObservation) {
		let subscriptions = self
			.subscriptions
			.read()
			.values()
			.flatten()
			.filter(|row| {
				row.event == "credential_disabled"
					&& row.phase == "observe"
					&& row.providers.as_ref().is_none_or(|providers| {
						providers
							.iter()
							.any(|provider| provider == observation.provider.as_str())
					})
			})
			.cloned()
			.collect::<Vec<_>>();
		if subscriptions.is_empty() {
			return;
		}
		let owner = self.clone();
		tokio::spawn(async move {
			for subscription in subscriptions {
				let mut arguments = JsonMap::new();
				arguments.insert(
					String::from("event"),
					JsonValue::String(String::from("credential_disabled")),
				);
				arguments.insert(String::from("phase"), JsonValue::String(String::from("observe")));
				arguments
					.insert(String::from("name"), JsonValue::String(subscription.name.to_string()));
				arguments.insert(
					String::from("payload"),
					json!({
						"provider": observation.provider,
						"account": observation.account.as_ref().map(ToString::to_string),
						"cause": observation.cause,
					}),
				);
				let session_generation = subscription.identity.session_generation;
				let _ = owner
					.dispatcher
					.dispatch(Arc::clone(&subscription.identity), ControlDispatch {
						operation: sf!("omp.hooks.dispatch"),
						arguments,
						authority: ControlInvocationAuthority {
							invocation:        sf!("credential-disabled:{}", observation.provider),
							phase:             InvocationPhase::Open,
							session:           sf!("session-{session_generation}"),
							turn:              None,
							event:             Some(sf!("credential_disabled")),
							call:              None,
							device:            None,
							effects:           Box::new([]),
							place_kind:        sf!("host"),
							lifecycle:         LifecyclePhase::Active,
							roots:             Box::new([]),
							remote:            false,
							has_ui:            false,
							headless:          true,
							settings:          owner.settings_for(&subscription.identity),
							secret_settings:   Box::new([]),
							data:              None,
							direct_filesystem: None,
						},
						policy: subscription.concurrency,
						deadline: EventDeadline {
							at: time::Instant::now()
								+ subscription
									.timeout
									.unwrap_or(subscription.event_policy.timeout),
						},
					})
					.await;
			}
		});
	}

	fn subscribed(&self) -> bool {
		self.provider_response_subscribed.load(Ordering::Relaxed)
	}

	fn observe(&self, observation: ProviderResponseObservation) {
		let subscriptions = self
			.subscriptions
			.read()
			.values()
			.flatten()
			.filter(|row| {
				row.event == "provider_response"
					&& row.phase == "observe"
					&& row.providers.as_ref().is_none_or(|providers| {
						providers
							.iter()
							.any(|provider| provider == observation.provider.as_str())
					})
			})
			.cloned()
			.collect::<Vec<_>>();
		if subscriptions.is_empty() {
			return;
		}
		let owner = self.clone();
		tokio::spawn(async move {
			for subscription in subscriptions {
				let headers = observation
					.headers
					.iter()
					.map(|(name, value)| (name.to_string(), JsonValue::String(value.to_string())))
					.collect::<JsonMap<_, _>>();
				let mut arguments = JsonMap::new();
				arguments
					.insert(String::from("event"), JsonValue::String(String::from("provider_response")));
				arguments.insert(String::from("phase"), JsonValue::String(String::from("observe")));
				arguments
					.insert(String::from("name"), JsonValue::String(subscription.name.to_string()));
				arguments.insert(
					String::from("payload"),
					json!({
						"provider": observation.provider,
						"model": {
							"provider": observation.provider,
							"api": observation.api,
							"model": observation.model,
						},
						"status": observation.status,
						"headers": headers,
						"request_id": observation.request_id,
					}),
				);
				let _ = owner
					.dispatcher
					.dispatch(Arc::clone(&subscription.identity), ControlDispatch {
						operation: sf!("omp.hooks.dispatch"),
						arguments,
						authority: ControlInvocationAuthority {
							invocation:        sf!(
								"provider-response:{}:{}",
								observation.provider,
								observation.status
							),
							phase:             InvocationPhase::Open,
							session:           sf!("session-{}", subscription.identity.session_generation),
							turn:              None,
							event:             Some(sf!("provider_response")),
							call:              None,
							device:            None,
							effects:           Box::new([]),
							place_kind:        sf!("host"),
							lifecycle:         LifecyclePhase::Active,
							roots:             Box::new([]),
							remote:            false,
							has_ui:            false,
							headless:          true,
							settings:          owner.settings_for(&subscription.identity),
							secret_settings:   Box::new([]),
							data:              None,
							direct_filesystem: None,
						},
						policy: subscription.concurrency,
						deadline: EventDeadline {
							at: time::Instant::now()
								+ subscription
									.timeout
									.unwrap_or(subscription.event_policy.timeout),
						},
					})
					.await;
			}
		});
	}
}

fn mcp_subscription_matches(subscription: &HookSubscription, server: &str, method: &str) -> bool {
	mcp_filter_matches(subscription.servers.as_deref(), &subscription.method_globs, server, method)
}

fn mcp_filter_matches(
	servers: Option<&[Str]>,
	method_globs: &[Str],
	server: &str,
	method: &str,
) -> bool {
	let server_matches =
		servers.is_none_or(|servers| servers.iter().any(|candidate| candidate == server));
	let method_matches = method_globs.is_empty()
		|| method_globs
			.iter()
			.any(|pattern| anchored_glob_matches(pattern, method));
	server_matches && method_matches
}

fn anchored_glob_matches(pattern: &str, value: &str) -> bool {
	let pattern = pattern.as_bytes();
	let value = value.as_bytes();
	let mut pattern_index = 0;
	let mut value_index = 0;
	let mut star = None;
	let mut retry_value = 0;
	while value_index < value.len() {
		if pattern_index < pattern.len()
			&& (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index])
		{
			pattern_index += 1;
			value_index += 1;
		} else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
			star = Some(pattern_index);
			pattern_index += 1;
			retry_value = value_index;
		} else if let Some(star_index) = star {
			pattern_index = star_index + 1;
			retry_value += 1;
			value_index = retry_value;
		} else {
			return false;
		}
	}
	while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
		pattern_index += 1;
	}
	pattern_index == pattern.len()
}

fn hook_callback_failure(
	policy: HookFailurePolicy,
	error: ControlProtocolError,
) -> Option<JsonValue> {
	(policy == HookFailurePolicy::Deny).then(|| {
		json!({
			"kind": "deny",
			"reason": error.message.as_str(),
			"fatal": false,
			"code": error.code.as_str(),
		})
	})
}

fn hook_decision_is_legal(phase: &str, kind: Option<&str>) -> bool {
	matches!(
		(phase, kind),
		("precheck", Some("deny" | "defer"))
			| ("transform", Some("modify" | "defer"))
			| ("review", Some("allow" | "deny" | "defer"))
			| ("approval", Some("allow" | "deny" | "defer" | "require_approval"))
			| ("domain", Some("allow" | "deny" | "defer" | "modify"))
	)
}

fn approval_spec_with_provenance(
	mut spec: JsonValue,
	hook: &str,
	extension: &str,
	host_generation: u64,
	session_generation: u64,
) -> JsonValue {
	if let Some(object) = spec.as_object_mut() {
		let evidence = object
			.entry(String::from("evidence"))
			.or_insert_with(|| JsonValue::Array(Vec::new()));
		if !evidence.is_array() {
			*evidence = JsonValue::Array(Vec::new());
		}
		let evidence = evidence.as_array_mut().expect("normalized to array");
		evidence.push(JsonValue::String(format!(
			"hook={hook} extension={extension} host_generation={host_generation} \
			 session_generation={session_generation}",
		)));
	}
	spec
}

/// Lifts a domain handler's raw return (Python returns the dataclass itself:
/// `ContextPatch`, `CustomSummary`, … or `None`) into the five-arm decision
/// vocabulary the composer folds: `None` contributes nothing, a bare object
/// is a transform whose fields patch the effective payload, and an object
/// already spelled as a decision passes through.
fn domain_reply_decision(result: JsonValue) -> Result<Option<JsonValue>, ControlProtocolError> {
	match result {
		JsonValue::Null => Ok(None),
		JsonValue::Object(object) if object.get("kind").is_some_and(JsonValue::is_string) => {
			Ok(Some(JsonValue::Object(object)))
		},
		JsonValue::Object(object) => Ok(Some(json!({"kind": "modify", "patch": object}))),
		_ => Err(ControlProtocolError::new(
			"HookContractError",
			"domain hook callback returned neither an object nor None",
		)),
	}
}

fn hook_phase_rank(phase: &str) -> u8 {
	match phase {
		"precheck" => 0,
		"transform" => 1,
		"review" => 2,
		"approval" => 3,
		"observe" => 4,
		_ => 5,
	}
}

fn lifecycle_hook_recipient(event: &str, payload: &JsonValue, extension: &str) -> bool {
	!matches!(event, "extension_load" | "extension_unload")
		|| payload
			.get("extension")
			.and_then(JsonValue::as_str)
			.is_none_or(|subject| subject != extension)
}

fn compose_hook_modify(
	event: &str,
	policy: &HookEventPolicy,
	payload: &mut JsonValue,
	modification: &mut Option<JsonMap<String, JsonValue>>,
	decision: &JsonMap<String, JsonValue>,
) -> Result<(), ControlProtocolError> {
	let output = modification.get_or_insert_with(|| {
		JsonMap::from_iter([(String::from("kind"), JsonValue::String(String::from("modify")))])
	});
	if let Some(reason) = decision.get("reason").filter(|value| !value.is_null()) {
		output.insert(String::from("reason"), reason.clone());
	}
	let mut patch = decision
		.get("patch")
		.and_then(JsonValue::as_object)
		.cloned()
		.unwrap_or_default();
	let mut unset = decision
		.get("unset")
		.and_then(JsonValue::as_array)
		.cloned()
		.unwrap_or_default();
	let payload_object = payload.as_object_mut().ok_or_else(|| {
		ControlProtocolError::new("HookContractError", "hook modification requires an object payload")
	})?;
	if event == "tool_call" {
		let mut args = decision
			.get("args")
			.and_then(JsonValue::as_object)
			.cloned()
			.or_else(|| {
				payload_object
					.get("args")
					.and_then(JsonValue::as_object)
					.cloned()
			})
			.unwrap_or_default();
		let mut args_changed = decision.get("args").is_some_and(JsonValue::is_object);
		patch.retain(|field, value| {
			if policy.composition.contains_key(field.as_str()) {
				true
			} else {
				args.insert(field.clone(), value.clone());
				args_changed = true;
				false
			}
		});
		unset.retain(|field| {
			let Some(field) = field.as_str() else {
				return true;
			};
			if policy.composition.contains_key(field) {
				true
			} else {
				args.remove(field);
				args_changed = true;
				false
			}
		});
		if args_changed {
			patch.insert(String::from("args"), JsonValue::Object(args));
		}
	} else if let Some(args) = decision.get("args").filter(|value| !value.is_null()) {
		patch.insert(String::from("args"), args.clone());
	}
	if let Some(target) = decision.get("target").filter(|value| !value.is_null()) {
		patch.insert(String::from("target"), target.clone());
	}
	let output_patch = output
		.entry(String::from("patch"))
		.or_insert_with(|| JsonValue::Object(JsonMap::new()))
		.as_object_mut()
		.expect("host-created hook patch is an object");
	for (field, value) in patch {
		let composed = match policy
			.composition
			.get(field.as_str())
			.copied()
			.unwrap_or(HookFieldComposition::Replace)
		{
			HookFieldComposition::Replace => value,
			HookFieldComposition::Append => {
				let mut current = payload_object
					.get(&field)
					.and_then(JsonValue::as_array)
					.cloned()
					.unwrap_or_default();
				let appended = value.as_array().ok_or_else(|| {
					ControlProtocolError::new(
						"HookContractError",
						format!("append-composed hook field {field} must be an array"),
					)
				})?;
				current.extend(appended.iter().cloned());
				JsonValue::Array(current)
			},
			HookFieldComposition::Intersect => {
				let current = payload_object
					.get(&field)
					.and_then(JsonValue::as_array)
					.cloned()
					.unwrap_or_default();
				let requested = value.as_array().ok_or_else(|| {
					ControlProtocolError::new(
						"HookContractError",
						format!("intersect-composed hook field {field} must be an array"),
					)
				})?;
				JsonValue::Array(if payload_object.get(&field).is_none_or(JsonValue::is_null) {
					requested.clone()
				} else {
					current
						.into_iter()
						.filter(|item| requested.contains(item))
						.collect()
				})
			},
		};
		payload_object.insert(field.clone(), composed.clone());
		output_patch.insert(field, composed);
	}
	for field in unset {
		let field = field.as_str().ok_or_else(|| {
			ControlProtocolError::new("HookContractError", "hook unset fields must be strings")
		})?;
		payload_object.remove(field);
		output_patch.remove(field);
	}
	Ok(())
}

impl ControlAuthorityFactory for HookControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		if !self.registries.admits(&identity) {
			return Err(ControlCompositionError::unavailable(
				"hooks",
				"authenticated extension has no deployment manifest",
			));
		}
		Ok(Arc::new(BoundHookControl { identity, owner: self.clone() }))
	}
}

struct BoundHookControl {
	identity: Arc<ControlConnectionIdentity>,
	owner:    HookControlFactory,
}

#[async_trait::async_trait]
impl ControlAuthority for BoundHookControl {
	fn handles(&self, operation: &str) -> bool {
		operation == "omp.hooks.dispatch"
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		_arguments: &JsonMap<String, JsonValue>,
	) -> Result<(), ControlProtocolError> {
		if !same_connection(&self.identity, &context.connection) {
			return Err(stale_connection());
		}
		if !self.handles(operation) {
			return Err(ControlProtocolError::new(
				"InvalidOperation",
				"hook owner does not handle this operation",
			));
		}
		require_active_invocation(context)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		self.owner.compose(&context, &arguments).await
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		if same_connection(&self.identity, &context.connection) {
			Err(ControlProtocolError::new("InvalidEffect", "hook owner accepts requests only"))
		} else {
			Err(stale_connection())
		}
	}
}

/// Active project content used to configure environment-owned tool resolvers.
#[derive(Default)]
pub struct ActiveContentInputs {
	/// Skill names authored outside the managed provider.
	pub authored_skills:     BTreeSet<Str>,
	/// Managed-skill authority root.
	pub managed_skills_root: Option<PathBuf>,
	/// Explicit Agent Plugins roots whose data-only MCP declarations join
	/// automatic project discovery.
	pub agent_plugin_roots:  Vec<PathBuf>,
}

/// Object-safe composition boundary for one active internal-URL resolver.
///
/// This mirrors the cold resolver-table calls because
/// [`read::resolver::Resolve`] uses return-position `impl Future`
/// and therefore cannot be used as a trait object.
#[async_trait::async_trait]
pub trait ContentResolver: Send + Sync + 'static {
	/// Returns the scheme metadata installed with this resolver.
	fn entry(&self) -> SchemeEntry;

	/// Reads one addressed resource.
	async fn read(
		&self,
		resource: &str,
		selector: &ParsedSelector,
	) -> Result<omp_core::CowBytes<'static>, ReadFault>;

	/// Reads one addressed resource while preserving its query.
	async fn read_query(
		&self,
		resource: &str,
		query: Option<&str>,
		selector: &ParsedSelector,
	) -> Result<omp_core::CowBytes<'static>, ReadFault> {
		let _ = query;
		self.read(resource, selector).await
	}

	/// Lists direct entries below one resource.
	async fn list(
		&self,
		_resource: &str,
		_max_entries: usize,
		_max_bytes: usize,
	) -> Result<ResourceList, ReadFault> {
		Err(ReadFault::Invalid { message: Str::new_static("This resource cannot be listed.") })
	}

	/// Resolves one resource to an Environment URI without reading bytes.
	async fn path(&self, _resource: &str) -> Result<Option<Str>, ReadFault> {
		Err(ReadFault::Invalid {
			message: Str::new_static("This resource has no materializable path."),
		})
	}

	/// Returns bounded local completion candidates.
	async fn complete(
		&self,
		_query: &str,
		_max_results: usize,
	) -> Result<Vec<ResourceCompletion>, ReadFault> {
		Ok(Vec::new())
	}
}

/// Object-safe regime authority supplied by composition.
///
/// This exists because [`goal::GoalControl`] requires `Clone` and
/// uses return-position `impl Future`, so that tools trait is not
/// dyn-compatible.
#[async_trait::async_trait]
pub trait GoalAuthority: Send + Sync + 'static {
	/// Applies one validated goal operation.
	async fn apply(
		&self,
		params: omp_tools::goal::Params,
	) -> Result<Option<omp_tools::goal::Goal>, goal::Fault>;
}

/// Auxiliary inference used by workspace search and media tools.
#[async_trait::async_trait]
pub trait SearchInference: Send + Sync + 'static {
	/// Performs one web-search request.
	async fn search(
		&self,
		request: v1::SearchRequest,
	) -> Result<v1::SearchResponse, omp_tools::web_search::BackendError>;

	/// Generates or edits images and returns the final blobs.
	async fn generate_image(
		&self,
		request: v1::GenerateImageRequest,
	) -> Result<Vec<Blob>, omp_tools::web_search::BackendError>;

	/// Synthesizes speech and returns the encoded bytes in wire order.
	async fn speak(
		&self,
		request: v1::SpeakRequest,
	) -> Result<Vec<u8>, omp_tools::web_search::BackendError>;
}

/// One host-resource resolution result.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HostResourceResult {
	/// Optional resolved UTF-8 body.
	pub content: Option<String>,
	/// Human-readable resolution notes.
	pub notes:   Vec<String>,
}

/// Broker resolving composition-owned internal resources.
#[async_trait::async_trait]
pub trait HostResources: Send + Sync + 'static {
	/// Resolves one host-owned resource read.
	async fn resolve_read(&self, url: &str) -> Result<HostResourceResult, Str>;

	/// Writes one host-owned resource.
	async fn resolve_write(&self, url: &str, content: String) -> Result<HostResourceResult, Str>;
}

/// Starts background telemetry delivery once the credential bridge exists.
pub trait TelemetryUpload: Send + Sync + 'static {
	/// Starts delivery for one Environment telemetry index.
	fn start(&self, index: Arc<TelemetryIndex>, credentials: Arc<GithubCredentialBridge>);
}

/// Runs one native tool stream under its authenticated invocation restrictions.
pub(super) async fn with_invocation_scope<T>(
	pty_denied: bool,
	future: impl Future<Output = T>,
) -> T {
	PTY_DENIED.scope(pty_denied, future).await
}

/// Runs one native tool stream with its caller-selected output policy.
///
/// The value is intent only: host implementations always retain their fixed
/// security ceiling.
pub(super) async fn with_output_request_scope<T>(
	request: omp_tool::OutputRequest,
	future: impl Future<Output = T>,
) -> T {
	OUTPUT_REQUEST.scope(request, future).await
}

/// Runs one native registry stream with its authenticated durable session
/// principal. `None` deliberately represents an invocation without a principal.
pub(super) async fn with_invocation_session_scope<T>(
	session_id: Option<Str>,
	future: impl Future<Output = T>,
) -> T {
	INVOCATION_SESSION_ID.scope(session_id, future).await
}
/// Runs one native tool stream with its invoking connection's edit repair
/// route.
pub(super) async fn with_edit_repair_scope<T>(
	context: InvocationEditRepairContext,
	future: impl Future<Output = T>,
) -> T {
	EDIT_REPAIR_CONTEXT.scope(context, future).await
}

/// Runs one native tool stream with editor capabilities from its invoking
/// connection.
pub(super) async fn with_acp_scope<T>(
	context: InvocationAcpBackends,
	future: impl Future<Output = T>,
) -> T {
	ACP_BACKENDS.scope(context, future).await
}

pub(super) fn invocation_acp_documents() -> Option<Arc<dyn super::docs::AcpDocumentBackend>> {
	ACP_BACKENDS
		.try_with(|context| context.documents.clone())
		.ok()
		.flatten()
}

pub(super) fn invocation_acp_exec() -> Option<Arc<dyn super::tool_shell::AcpExecBackend>> {
	ACP_BACKENDS
		.try_with(|context| context.exec.clone())
		.ok()
		.flatten()
}
/// Returns the caller-selected output policy for the current invocation.
pub(super) fn invocation_output_request() -> omp_tool::OutputRequest {
	OUTPUT_REQUEST
		.try_with(|request| *request)
		.unwrap_or(omp_tool::OutputRequest::Bounded)
}

/// Returns the durable session principal for the current native invocation.
pub(super) fn invocation_session_id() -> Option<Str> {
	INVOCATION_SESSION_ID.try_with(Clone::clone).ok().flatten()
}

async fn invocation_edit_repair(
	prompt: omp_tools::edit::observer::EditRepairPrompt,
) -> Result<Str, omp_tools::edit::observer::EditRepairError> {
	let repair = EDIT_REPAIR_CONTEXT
		.try_with(|context| context.repair.clone())
		.ok()
		.flatten()
		.ok_or(omp_tools::edit::observer::EditRepairError::Unavailable)?;
	repair.complete(prompt).await
}

fn invocation_edit_model() -> Option<Str> {
	EDIT_REPAIR_CONTEXT
		.try_with(|context| context.model.clone())
		.ok()
		.flatten()
}

/// Returns whether the current authenticated invocation denies PTY allocation.
pub(super) fn pty_denied() -> bool {
	PTY_DENIED.try_with(|denied| *denied).unwrap_or(false)
}

fn configured_model_edit_revision(ctx: &Ctx) -> Result<Option<Rev>, EnvdError> {
	let settings = omp_catalog::settings::ModelSettings::from_con(ctx);
	let Some(selector) = settings.role_selector("default") else {
		return Ok(None);
	};
	let catalog = Catalog::embedded();
	let model = catalog
		.model(ModelKey::from_ref(selector))
		.or_else(|| catalog.resolve_alias(selector));
	let Some(revision) = model.and_then(|model| model.edit_revision.as_deref()) else {
		return Ok(None);
	};
	revision
		.parse::<Rev>()
		.map(Some)
		.map_err(|error| EnvdError::EditDialect(error.to_string().into()))
}

fn configured_model_identity(ctx: &Ctx) -> Option<Str> {
	let settings = omp_catalog::settings::ModelSettings::from_con(ctx);
	let selected = omp_agent::AI_MODEL.get(ctx);
	if let Some(role) = selected.strip_prefix("@") {
		return settings.role_selector(role.as_str()).cloned();
	}
	if !selected.is_empty() {
		return Some(selected);
	}
	settings.role_selector("default").cloned()
}

fn image_config(ctx: &Ctx) -> media_devices::ImageConfig {
	let provider_order = omp_ai::settings::AI_PROVIDERS_IMAGE_ORDER
		.get(ctx)
		.into_iter()
		.filter_map(|provider| provider.parse().ok())
		.filter(|provider| *provider != media_devices::ImageProvider::Auto)
		.collect();
	media_devices::ImageConfig { provider_order, active_model: configured_model_identity(ctx) }
}

fn speech_config(ctx: &Ctx) -> SpeechConfig {
	use omp_ai::speech_settings::{AI_TTS_PROVIDER, CL_TTS_MODEL, CL_TTS_VOICE, TtsProvider};
	let preference = match AI_TTS_PROVIDER.get(ctx) {
		TtsProvider::Auto => SpeechPreference::Auto,
		TtsProvider::Local => SpeechPreference::Local,
		TtsProvider::Xai => SpeechPreference::Xai,
		TtsProvider::Deepinfra => SpeechPreference::Deepinfra,
	};
	SpeechConfig {
		preference,
		local_model: Str::new(<&'static str>::from(CL_TTS_MODEL.get(ctx))),
		local_voice: Str::new(<&'static str>::from(CL_TTS_VOICE.get(ctx))),
	}
}

fn prepare_registry(registry: &mut Registry) -> Result<(), EnvdError> {
	registry.protect_core_claims([
		"read",
		"write",
		"bash",
		"edit",
		"glob",
		"eval",
		"task",
		"hub",
		"browser",
		"learn",
		"manage_skill",
		"computer",
		"lsp",
		"debug",
	]);
	for name in [
		"read",
		"edit",
		"bash",
		"grep",
		"glob",
		"write",
		"eval",
		"todo",
		"ask",
		"web_search",
		"think",
		"goal",
		"yield",
		"checkpoint",
		"rewind",
		"hub",
		"browser",
		"github",
		"image_gen",
		"tts",
		"report_issue",
		"retain",
		"recall",
		"reflect",
		"memory_edit",
		"learn",
		"manage_skill",
		"lsp",
		"debug",
		"computer",
	] {
		ensure_name_absent(registry, name)?;
	}
	Ok(())
}

struct SessionBaseOutput {
	search_bridge:      Arc<SearchBridgeHost>,
	github_credentials: Arc<GithubCredentialBridge>,
	ask_presenter:      PresenterSlot,
	checkpoint_control: AgentCheckpointControl,
}

#[allow(
	clippy::too_many_arguments,
	reason = "session tool composition carries independent typed authorities"
)]
fn register_session_base(
	registry: &mut Registry,
	dynamic_tools: Vec<DynamicTool>,
	dynamic_tool_factories: Vec<Arc<dyn DynamicToolFactory>>,
	search: Option<Arc<dyn SearchInference>>,
	ask_presenter: Option<Arc<dyn omp_tools::ask::AskPresenter>>,
	goal_control: Option<Arc<dyn GoalAuthority>>,
	telemetry_upload: Option<Arc<dyn TelemetryUpload>>,
	blobs: &BlobHost,
	project_root: &Path,
	state_dir: &Path,
	telemetry: &Arc<TelemetryIndex>,
	github_cache: Arc<GithubCache>,
	tool_settings: &ToolSettings,
	image_config: media_devices::ImageConfig,
	speech_config: SpeechConfig,
	policy: ToolsPolicy,
) -> Result<SessionBaseOutput, EnvdError> {
	for dynamic in dynamic_tools {
		dynamic.register(registry)?;
	}
	for factory in dynamic_tool_factories {
		factory.register(registry)?;
	}
	let search_bridge = Arc::new(SearchBridgeHost::new(search));
	let github_credentials = Arc::new(GithubCredentialBridge::new());
	let ask_presenter = PresenterSlot::new(
		ask_presenter.unwrap_or_else(|| Arc::new(omp_tools::ask::HeadlessPresenter)),
	);
	for device in [
		media_devices::image_gen(
			Arc::clone(&search_bridge),
			image_config,
			blobs.clone(),
			project_root.to_path_buf(),
		),
		media_devices::tts_with_config(
			Arc::clone(&search_bridge),
			Arc::clone(&github_credentials),
			speech_config,
			blobs.clone(),
			project_root.to_path_buf(),
		),
	] {
		register_instrumented(
			registry,
			device,
			long_tail_presentation(policy),
			builtin_device_claims(),
		)?;
	}
	register_instrumented(
		registry,
		report_issue::tool(Arc::clone(telemetry)),
		long_tail_presentation(policy),
		builtin_device_claims(),
	)?;
	let github = GithubService::new(
		project_root.to_path_buf(),
		state_dir,
		Arc::clone(&github_credentials),
		github_cache,
		blobs.clone(),
	);
	if let Some(upload) = telemetry_upload {
		upload.start(Arc::clone(telemetry), Arc::clone(&github_credentials));
	}
	register_instrumented(
		registry,
		omp_tools::github::tool(github),
		long_tail_presentation(policy),
		builtin_device_claims(),
	)?;
	if tool_settings.enabled("web_search") {
		register_instrumented(
			registry,
			omp_tools::web_search::tool(Arc::clone(&search_bridge)),
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	if tool_settings.enabled("todo") {
		register_instrumented(
			registry,
			omp_tools::todo::tool(),
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	if tool_settings.enabled("ask") {
		register_instrumented(
			registry,
			omp_tools::ask::tool_with_vocalizer(
				Arc::new(ask_presenter.clone()),
				media_devices::ask_vocalizer(Arc::clone(&search_bridge)),
			),
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	if tool_settings.enabled("think") {
		// External-thinking sessions select `think` explicitly via
		// `advertise_selected`; ordinary models must never see it.
		register_instrumented(
			registry,
			omp_tools::think::tool(),
			Presentation::Hidden,
			core_claims(),
		)?;
	}
	if let Some(goal_control) = goal_control {
		register_instrumented(
			registry,
			omp_tools::goal::tool(GoalControlAdapter(goal_control)),
			Presentation::Hidden,
			core_claims(),
		)?;
	}
	if tool_settings.enabled("yield") {
		register_instrumented(
			registry,
			omp_tools::yield_tool::tool(),
			Presentation::Hidden,
			core_claims(),
		)?;
	}
	let checkpoint_control = AgentCheckpointControl::default();
	let (checkpoint, rewind) = omp_tools::checkpoint::tools(checkpoint_control.clone());
	if tool_settings.enabled("checkpoint") {
		register_instrumented(
			registry,
			checkpoint,
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	if tool_settings.enabled("rewind") {
		register_instrumented(
			registry,
			rewind,
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	Ok(SessionBaseOutput { search_bridge, github_credentials, ask_presenter, checkpoint_control })
}

fn register_session_workers(
	registry: &mut Registry,
	workers: &ExtHostSupervisor,
	policy: ToolsPolicy,
) -> Result<(), EnvdError> {
	let flattened_slots = if policy == ToolsPolicy::ToolOnly {
		let mut slots = Vec::new();
		for registration in workers.registrations() {
			if is_prelude_declaration(&registration.declaration)? {
				continue;
			}
			let definition = registration
				.declaration
				.definition
				.as_ref()
				.ok_or_else(|| worker_declaration_error("worker tool declaration has no definition"))?;
			slots.push((Str::from(definition.name.as_str()), registration.owner.extension().clone()));
		}
		Some(flatten_slots(slots).map_err(|collision| {
			EnvdError::WorkerDeclaration(Str::from(format!(
				"tool_only slot {} is owned by both {} and {}",
				collision.slot, collision.existing_owner, collision.conflicting_owner
			)))
		})?)
	} else {
		None
	};
	for registration in workers.registrations() {
		let declaration = &registration.declaration;
		if is_prelude_declaration(declaration)? {
			continue;
		}
		let mut spec = worker_spec(declaration)?;
		if flattened_slots.is_some() {
			spec.name = Str::from(spec.name.as_str().replace('/', "_"));
		}
		let device_name = spec.name.clone();
		let owner = registration.owner.clone();
		ensure_name_absent(registry, &spec.name)?;
		let execution = match WorkerExecutionMode::try_from(declaration.execution_mode) {
			Ok(WorkerExecutionMode::Unspecified | WorkerExecutionMode::Parallel) => {
				ExecutionMode::Parallel
			},
			Ok(WorkerExecutionMode::Sequential) => ExecutionMode::Sequential,
			Err(_) => return Err(worker_declaration_error("worker execution mode is invalid")),
		};
		registry.register_worker_with_mode(
			spec,
			if flattened_slots.is_some() {
				Presentation::Slot
			} else {
				Presentation::Device
			},
			Claims {
				precedence: Precedence::DEFAULT,
				claimant:   registration.owner.extension().clone(),
				replaces:   None,
			},
			execution,
		)?;
		registry.bind_device_metadata(
			device_name,
			owner.extension().clone(),
			omp_tool::DeviceMetadata {
				extension_id: Some(owner.extension().clone()),
				layer: Some(owner.layer().clone()),
				tier: Some(owner.tier().clone()),
				..omp_tool::DeviceMetadata::default()
			},
		);
	}
	Ok(())
}

#[derive(Clone)]
pub(crate) struct EnvironmentDeclarationInputs {
	pub read_policy:      omp_tools::read::ReadPolicy,
	pub selected_edit:    Rev,
	pub eval_description: Option<Str>,
	pub shell_snapshot:   Option<omp_tools::shell::ShellPromptSnapshot>,
	pub memory:           omp_memory::Capabilities,
	pub managed_skills:   bool,
}
#[allow(
	clippy::too_many_arguments,
	reason = "declaration projection mirrors independent tool setting domains"
)]
pub(crate) fn build_environment_declaration_inputs(
	_state_dir: &Path,
	_project_root: &Path,
	con: &Ctx,
	workers: &ExtHostSupervisor,
	tool_settings: &ToolSettings,
	shell_settings: &ShellSettings,
	acp_settings: &AcpSettings,
	memory_settings: &omp_memory::MemorySettings,
	autolearn_settings: &omp_memory::AutolearnSettings,
	content: &ActiveContentInputs,
	policy: ToolsPolicy,
) -> Result<EnvironmentDeclarationInputs, EnvdError> {
	let environment_edit_dialect = env::var("OMP_EDIT_DIALECT").ok();
	let force_hashline = env::var_os("OMP_STRICT_EDIT_MODE").is_some();
	let model_edit_revision = configured_model_edit_revision(con)?;
	let selected_edit = resolve_edit_revision(EditRevisionCandidates {
		environment: environment_edit_dialect.as_deref(),
		model_rule: model_edit_revision.as_ref(),
		setting: tool_settings.edit_dialect.as_deref(),
		force_hashline,
		..EditRevisionCandidates::default()
	})
	.map_err(EnvdError::EditDialect)?
	.revision;
	let prelude = build_prelude_table(workers)?;
	let helper_docs = prelude
		.helpers()
		.map(|helper| omp_tools::eval::PreludeHelperDescription {
			signature: helper.signature.as_str(),
			summary:   helper.summary.as_str(),
		})
		.collect::<Vec<_>>();
	let mut task_snapshot =
		TaskDescriptionSnapshot { helpers: &helper_docs, ..TaskDescriptionSnapshot::standard() };
	if !tool_settings.enabled("task") {
		task_snapshot.agents = &[];
	}
	let eval_description = tool_settings
		.enabled("eval")
		.then(|| omp_tools::eval::task_description(task_snapshot));
	let dyn_installed = tool_settings.enabled("dyn") && dyn_enabled(policy);
	let shell_snapshot = (tool_settings.enabled("bash") && shell_settings.enabled).then(|| {
		omp_tools::shell::ShellPromptSnapshot {
			sibling_tools:       Arc::default(),
			platform:            Str::new(consts::OS),
			devices:             dyn_installed,
			embedded_builtins:   shell_settings.embedded_builtins,
			interceptor_enabled: shell_settings.interceptor.enabled,
			interceptor_rules:   shell_settings
				.interceptor
				.patterns
				.iter()
				.map(|rule| omp_tools::shell_intercept::Rule {
					pattern: rule.pattern.clone(),
					tool:    rule.tool.clone(),
					message: rule.message.clone(),
				})
				.collect(),
			acp_routing:         acp_settings.routing != AcpRouting::Never,
			command_prefix:      shell_settings.command_prefix.is_some(),
		}
	});
	let memory = if memory_settings.backend == omp_memory::MemoryBackend::Off {
		omp_memory::Capabilities::default()
	} else {
		omp_memory::Capabilities {
			writable:   true,
			searchable: true,
			resolvable: true,
			editable:   true,
			lifecycle:  true,
			embeddings: false,
		}
	};
	Ok(EnvironmentDeclarationInputs {
		read_policy: omp_tools::read::ReadPolicy {
			fetch_enabled:      tool_settings.fetch_enabled,
			render_markdown:    tool_settings.render_markdown,
			auto_resize_images: tool_settings.auto_resize_images,
			hashline_headers:   tool_settings.enabled("edit") && selected_edit.family.as_str() == "hl",
			summarize:          tool_settings.read_summarize,
			line_numbers:       tool_settings.read_line_numbers,
		},
		selected_edit,
		eval_description,
		shell_snapshot,
		memory,
		managed_skills: autolearn_settings.enabled && content.managed_skills_root.is_some(),
	})
}

#[derive(Clone)]
struct EnvironmentDeclaration {
	spec:         ToolSpec,
	presentation: Presentation,
	claims:       Claims,
}

fn environment_declarations(
	tool_settings: &ToolSettings,
	browser_settings: &BrowserSettings,
	inputs: &EnvironmentDeclarationInputs,
	py_eval: bool,
	policy: ToolsPolicy,
) -> Vec<EnvironmentDeclaration> {
	let mut declarations = Vec::new();
	let mut push = |spec, presentation, claims| {
		declarations.push(EnvironmentDeclaration { spec, presentation, claims });
	};
	if browser_settings.enabled && tool_settings.enabled("browser") {
		push(omp_tools::browser::spec(), long_tail_presentation(policy), builtin_device_claims());
	}
	if tool_settings.enabled("computer") {
		push(omp_tools::computer::spec(), long_tail_presentation(policy), builtin_device_claims());
	}
	if tool_settings.enabled("security_scan") {
		push(omp_tools::security_scan::spec(), Presentation::Device, builtin_device_claims());
	}
	if inputs.memory.writable {
		push(
			omp_tools::memory::retain_spec(),
			long_tail_presentation(policy),
			builtin_device_claims(),
		);
	}
	if inputs.memory.searchable {
		push(
			omp_tools::memory::recall_spec(),
			long_tail_presentation(policy),
			builtin_device_claims(),
		);
		push(
			omp_tools::memory::reflect_spec(),
			long_tail_presentation(policy),
			builtin_device_claims(),
		);
	}
	if inputs.memory.editable {
		push(omp_tools::memory_edit::spec(), long_tail_presentation(policy), builtin_device_claims());
	}
	if inputs.managed_skills {
		push(
			omp_tools::manage_skill::spec(),
			long_tail_presentation(policy),
			builtin_device_claims(),
		);
		if inputs.memory.writable {
			push(omp_tools::learn::spec(), long_tail_presentation(policy), builtin_device_claims());
		}
	}
	if tool_settings.enabled("read") {
		push(
			omp_tools::read::spec(inputs.read_policy),
			essential_presentation(policy),
			core_claims(),
		);
	}
	if tool_settings.enabled("edit") {
		let mut edits = [
			omp_tools::edit::replace::legacy_replace_spec(),
			omp_tools::edit::apply_patch::legacy_patch_spec(),
			omp_tools::edit::hashline_spec(),
			omp_tools::edit::replace::replace_spec(),
			omp_tools::edit::apply_patch::patch_spec(),
			omp_tools::edit::apply_patch::apply_patch_spec(),
			omp_tools::edit::apply_patch::sloppy_spec(),
		];
		edits.sort_by_key(|spec| spec.rev == inputs.selected_edit);
		for spec in edits {
			push(spec, essential_presentation(policy), core_claims());
		}
	}
	if tool_settings.enabled("write") {
		push(omp_tools::write::spec(), long_tail_presentation(policy), long_tail_claims(policy));
	}
	if tool_settings.enabled("lsp") {
		push(omp_tools::lsp::spec(), long_tail_presentation(policy), long_tail_claims(policy));
	}
	if tool_settings.enabled("debug") {
		push(omp_tools::debug::spec(), long_tail_presentation(policy), long_tail_claims(policy));
	}
	if tool_settings.enabled("grep") {
		push(omp_tools::grep::spec(), essential_presentation(policy), core_claims());
	}
	if tool_settings.enabled("glob") {
		push(omp_tools::glob::spec(), essential_presentation(policy), core_claims());
	}
	if tool_settings.enabled("ast_grep") {
		push(omp_tools::ast_grep::spec(), long_tail_presentation(policy), long_tail_claims(policy));
	}
	if tool_settings.enabled("ast_edit") {
		push(omp_tools::ast_edit::spec(), long_tail_presentation(policy), long_tail_claims(policy));
	}
	if tool_settings.enabled("eval") {
		if let Some(description) = &inputs.eval_description {
			push(
				omp_tools::eval::spec(description.clone()),
				long_tail_presentation(policy),
				long_tail_claims(policy),
			);
		}
	}
	if py_eval {
		push(
			omp_tools::eval::py_eval_spec(),
			long_tail_presentation(policy),
			long_tail_claims(policy),
		);
	}
	if tool_settings.enabled("bash") {
		if let Some(snapshot) = &inputs.shell_snapshot {
			push(omp_tools::shell::spec(snapshot), bash_presentation(policy), core_claims());
		}
	}
	declarations
}

/// Declares the enabled environment half in a session-owned registry.
///
/// All inputs are frozen settings or content-derived snapshots; constructing
/// this half never opens an environment resource host.
fn declare_remote_environment(
	registry: &mut Registry,
	tool_settings: &ToolSettings,
	browser_settings: &BrowserSettings,
	inputs: &EnvironmentDeclarationInputs,
	py_eval: bool,
	policy: ToolsPolicy,
) -> Result<(), EnvdError> {
	for declaration in
		environment_declarations(tool_settings, browser_settings, inputs, py_eval, policy)
	{
		registry.declare_remote(
			declaration.spec,
			declaration.presentation,
			declaration.claims,
			ExecutionMode::Parallel,
		)?;
	}
	Ok(())
}

pub(crate) struct SessionRegistryBridges {
	pub dynamic_tools:          Vec<DynamicTool>,
	pub dynamic_tool_factories: Vec<Arc<dyn DynamicToolFactory>>,
	pub goal_control:           Option<Arc<dyn GoalAuthority>>,
	pub search:                 Option<Arc<dyn SearchInference>>,
	pub telemetry_upload:       Option<Arc<dyn TelemetryUpload>>,
	pub ask_presenter:          Option<Arc<dyn omp_tools::ask::AskPresenter>>,
}

pub(crate) struct SessionRegistryOutput {
	pub registry:           Arc<Registry>,
	pub search_bridge:      Arc<SearchBridgeHost>,
	pub github_credentials: Arc<GithubCredentialBridge>,
	pub ask_presenter:      PresenterSlot,
	pub checkpoint_control: AgentCheckpointControl,
}

#[allow(
	clippy::too_many_arguments,
	reason = "session registry composition carries independent typed authorities"
)]
pub(crate) fn session_registry(
	mut registry: Registry,
	blobs: &BlobHost,
	project_root: &Path,
	state_dir: &Path,
	telemetry: &Arc<TelemetryIndex>,
	github_cache: Arc<GithubCache>,
	workers: &ExtHostSupervisor,
	py_eval: bool,
	con: &Ctx,
	policy: ToolsPolicy,
	tool_settings: &ToolSettings,
	browser_settings: &BrowserSettings,
	environment: &EnvironmentDeclarationInputs,
	bridges: SessionRegistryBridges,
) -> Result<SessionRegistryOutput, EnvdError> {
	prepare_registry(&mut registry)?;
	let SessionRegistryBridges {
		dynamic_tools,
		dynamic_tool_factories,
		goal_control,
		search,
		telemetry_upload,
		ask_presenter,
	} = bridges;
	let base = register_session_base(
		&mut registry,
		dynamic_tools,
		dynamic_tool_factories,
		search,
		ask_presenter,
		goal_control,
		telemetry_upload,
		blobs,
		project_root,
		state_dir,
		telemetry,
		github_cache,
		tool_settings,
		image_config(con),
		speech_config(con),
		policy,
	)?;
	let mut declarations = environment.clone();
	let shell = declarations.shell_snapshot.take();
	declare_remote_environment(
		&mut registry,
		tool_settings,
		browser_settings,
		&declarations,
		py_eval,
		policy,
	)?;
	if tool_settings.enabled("bash") {
		if let Some(mut snapshot) = shell {
			snapshot.sibling_tools = registry
				.live_identities()
				.filter_map(|(name, _)| {
					(name != "bash" && registry.presentation(name).ok() == Some(Presentation::Slot))
						.then(|| name.clone())
				})
				.collect();
			let declaration = omp_tools::shell::spec(&snapshot);
			ensure_name_absent(&registry, &declaration.name)?;
			registry.declare_remote(
				declaration,
				bash_presentation(policy),
				core_claims(),
				ExecutionMode::Parallel,
			)?;
		}
	}
	register_session_workers(&mut registry, workers, policy)?;
	Ok(SessionRegistryOutput {
		registry:           Arc::new(registry),
		search_bridge:      base.search_bridge,
		github_credentials: base.github_credentials,
		ask_presenter:      base.ask_presenter,
		checkpoint_control: base.checkpoint_control,
	})
}

/// Returns the live tools whose authoritative executor is the environment.
///
/// The set is derived exclusively from registry locus metadata so settings,
/// revisions, and contributed entries cannot drift from routing.
pub(crate) fn environment_tool_names(registry: &Registry) -> FastHashSet<Str> {
	registry
		.live_identities()
		.filter_map(|(name, _)| {
			(registry.locus(name).ok() == Some(ToolLocus::Environment)).then(|| name.clone())
		})
		.collect()
}

fn managed_skills_enabled(con: &Ctx, autolearn_enabled: bool) -> bool {
	autolearn_enabled && crate::SV_SKILLS_ENABLED.get(con)
}

/// Builds the complete registry shared by environment dispatch and the agent.
///
/// Resource adapters are cloned into their typed executors. Worker declarations
/// occupy device presentation entries and explicit worker routes; only the
/// environment's worker supervisor can invoke them.
pub(crate) fn production_registry<
	I: omp_tools::device::DeviceInvoker + Clone + 'static,
	P: PreludeInvoker + 'static,
>(
	documents: &DocumentHost,
	blobs: &BlobHost,
	exec: &ExecHost,
	state_dir: &Path,
	con: &Ctx,
	session_id: &str,
	github_cache: Arc<GithubCache>,
	mcp: &Arc<McpService>,
	mcp_manager: Arc<McpManager>,
	workspace: &WorkspaceHost,
	memory: &Arc<omp_memory::MemoryRuntime>,
	telemetry: &Arc<TelemetryIndex>,
	root_uri: &Str,
	workers: &ExtHostSupervisor,
	interrupt_grace: Duration,
	py_eval: bool,
	tool_settings: &ToolSettings,
	browser_settings: &BrowserSettings,
	shell_settings: &ShellSettings,
	sandbox_settings: &SandboxSettings,
	acp_settings: &AcpSettings,
	acp_exec: AcpExecSlot,
	autolearn_settings: &omp_memory::config::AutolearnSettings,
	hooks: Arc<HookGate>,
	device_invoker: I,
	prelude_invoker: P,
	policy: ToolsPolicy,
	mut registry: Registry,
	bridges: RegistryBridges,
) -> Result<
	(
		Arc<Registry>,
		Arc<SessionBridgeHost>,
		Arc<ReflectionBridgeHost>,
		EvalSessionControl,
		AgentCheckpointControl,
		StagedProposalRegistry,
		Arc<ResolverTable<UrlResolver>>,
		Arc<SearchBridgeHost>,
		Arc<GithubCredentialBridge>,
		PresenterSlot,
	),
	EnvdError,
> {
	let RegistryBridges {
		command_credentials: _,
		dynamic_tools,
		dynamic_tool_factories,
		url_resolvers,
		goal_control,
		search,
		edit_model,
		edit_repair,
		host_resources,
		session_authority,
		telemetry_upload,
		ask_presenter,
		content,
	} = bridges;
	exec.configure_sandbox(sandbox_settings, workspace.root());
	let previews = StagedProposalRegistry::new();
	prepare_registry(&mut registry)?;
	let SessionBaseOutput { search_bridge, github_credentials, ask_presenter, checkpoint_control } =
		register_session_base(
			&mut registry,
			dynamic_tools,
			dynamic_tool_factories,
			search,
			ask_presenter,
			goal_control,
			telemetry_upload,
			blobs,
			workspace.root(),
			state_dir,
			telemetry,
			Arc::clone(&github_cache),
			tool_settings,
			image_config(con),
			speech_config(con),
			policy,
		)?;
	if browser_settings.enabled && tool_settings.enabled("browser") {
		let browser_daemon = BrowserDaemon::start(blobs.clone(), browser_settings.clone());
		environment_registry(
			&mut registry,
			omp_tools::browser::tool(browser_daemon),
			long_tail_presentation(policy),
			builtin_device_claims(),
		)?;
	}
	if tool_settings.enabled("computer") {
		let computer = ComputerSessionHost::new(blobs.clone(), con);
		environment_registry(
			&mut registry,
			omp_tools::computer::tool(computer),
			long_tail_presentation(policy),
			builtin_device_claims(),
		)?;
	}
	let security = SecurityScanService::new(workspace.root().to_path_buf(), state_dir)
		.with_credentials(Arc::clone(&github_credentials));
	if tool_settings.enabled("security_scan") {
		environment_registry(
			&mut registry,
			omp_tools::security_scan::tool(security.clone()),
			Presentation::Device,
			builtin_device_claims(),
		)?;
	}
	let reflection_bridge = Arc::new(ReflectionBridgeHost::new());
	let memory_capabilities = memory.capabilities();
	if memory_capabilities.writable {
		environment_registry(
			&mut registry,
			omp_tools::memory::retain_tool(Arc::clone(memory)),
			long_tail_presentation(policy),
			builtin_device_claims(),
		)?;
	}
	if memory_capabilities.searchable {
		environment_registry(
			&mut registry,
			omp_tools::memory::recall_tool(Arc::clone(memory)),
			long_tail_presentation(policy),
			builtin_device_claims(),
		)?;
		environment_registry(
			&mut registry,
			omp_tools::memory::reflect_tool(Arc::clone(memory), Arc::clone(&reflection_bridge)),
			long_tail_presentation(policy),
			builtin_device_claims(),
		)?;
	}
	if memory_capabilities.editable {
		environment_registry(
			&mut registry,
			omp_tools::memory_edit::tool(Arc::clone(memory)),
			long_tail_presentation(policy),
			builtin_device_claims(),
		)?;
	}
	if managed_skills_enabled(con, autolearn_settings.enabled) {
		if let Some(managed_skills_root) = content.managed_skills_root {
			let authority = Arc::new(ManagedSkills::new(
				managed_skills_root,
				content.authored_skills,
				Arc::clone(&hooks),
			));
			environment_registry(
				&mut registry,
				omp_tools::manage_skill::tool(Arc::clone(&authority)),
				Presentation::Device,
				builtin_device_claims(),
			)?;
			if memory_capabilities.writable {
				environment_registry(
					&mut registry,
					omp_tools::learn::tool(Arc::clone(memory), authority),
					Presentation::Device,
					builtin_device_claims(),
				)?;
			}
		}
	}
	let user_config_root = omp_core::dirs::user_config_root()?;
	let ssh = SshService::new(
		HostStore::load_layered(&HostPaths::new(&user_config_root, workspace.root()))
			.map_err(|error| EnvdError::State(Str::new(error.to_string())))?,
	);
	let vault = VaultService::load_layered(&VaultPaths::new(&user_config_root, workspace.root()))
		.map_err(|error| EnvdError::State(Str::new(error.to_string())))?
		.with_obsidian_enabled(omp_tools::settings::SV_VAULT_ENABLED.get(con));
	documents.set_resource_mutations(ResourceMutationServices {
		ssh:   ssh.clone(),
		vault: vault.clone(),
	});
	let read_sources = ReadSourceAdapter::new(
		documents.clone(),
		workspace.clone(),
		document_cache::project_document_cache(state_dir),
	);
	let read_blobs = SessionReadBlobs::open(blobs.clone(), session_id).map_err(EnvdError::State)?;
	let conflicts = Arc::new(ConflictRegistry::default());
	let catalog = DeviceCatalog::default();
	let resolvers = production_url_resolvers(
		Arc::clone(&conflicts),
		blobs.store().clone(),
		session_id,
		state_dir.join("sessions"),
		workspace.root().to_path_buf(),
		github_cache,
		Arc::clone(&github_credentials),
		url_resolvers,
		host_resources,
		session_authority,
		Arc::clone(mcp),
		ssh,
		security,
		vault,
	);
	let environment_edit_dialect = env::var("OMP_EDIT_DIALECT").ok();
	let force_hashline = env::var_os("OMP_STRICT_EDIT_MODE").is_some();
	let model_edit_revision = configured_model_edit_revision(con)?;
	let selected_edit = resolve_edit_revision(EditRevisionCandidates {
		environment: environment_edit_dialect.as_deref(),
		model_rule: model_edit_revision.as_ref(),
		setting: tool_settings.edit_dialect.as_deref(),
		force_hashline,
		..EditRevisionCandidates::default()
	})
	.map_err(EnvdError::EditDialect)?
	.revision;
	let read = omp_tools::read::tool_with_policy(
		read_sources.clone(),
		read_blobs.clone(),
		Arc::clone(&resolvers),
		Arc::clone(&conflicts),
		omp_tools::read::ReadPolicy {
			fetch_enabled:      tool_settings.fetch_enabled,
			render_markdown:    tool_settings.render_markdown,
			auto_resize_images: tool_settings.auto_resize_images,
			hashline_headers:   tool_settings.enabled("edit") && selected_edit.family.as_str() == "hl",
			summarize:          tool_settings.read_summarize,
			line_numbers:       tool_settings.read_line_numbers,
		},
	);
	if tool_settings.enabled("read") {
		environment_registry(&mut registry, read, essential_presentation(policy), core_claims())?;
	}
	let edit_repair = tool_settings.edit_auto_repair.then(|| {
		edit_repair
			.unwrap_or_else(|| {
				omp_tools::edit::observer::EditRepairClient::from_completion(invocation_edit_repair)
			})
			.with_model_identity(invocation_edit_model)
	});
	let edit_observer = omp_tools::edit::observer::EditObserver::new(
		omp_tools::edit::observer::EditBlackboxConfig {
			path: tool_settings.edit_blackbox_path.as_ref().map(|path| {
				if path.is_absolute() {
					path.clone()
				} else {
					workspace.root().join(path)
				}
			}),
			model: edit_model
				.or_else(|| configured_model_identity(con))
				.unwrap_or_else(|| sf!("unknown")),
			..omp_tools::edit::observer::EditBlackboxConfig::default()
		},
		edit_repair,
	);
	let mut hashline_edit = Some(omp_tools::edit::tool_with_observer(
		documents.clone(),
		blobs.clone(),
		tool_settings.format_policy,
		edit_observer.clone(),
		tool_settings.edit_guard_generated,
	));
	let mut legacy_replace_edit = Some(
		omp_tools::edit::legacy_replace_tool_with_observer(
			documents.clone(),
			tool_settings.format_policy,
			edit_observer.clone(),
			tool_settings.edit_guard_generated,
			tool_settings.edit_fuzzy,
			tool_settings.edit_require_seen,
		)
		.with_fuzzy_threshold(tool_settings.edit_fuzzy_threshold),
	);
	let mut replace_edit = Some(
		omp_tools::edit::replace_tool_with_observer(
			documents.clone(),
			tool_settings.format_policy,
			edit_observer.clone(),
			tool_settings.edit_guard_generated,
			tool_settings.edit_fuzzy,
			tool_settings.edit_require_seen,
		)
		.with_fuzzy_threshold(tool_settings.edit_fuzzy_threshold),
	);
	let mut legacy_patch_edit = Some(omp_tools::edit::legacy_patch_tool_with_observer(
		documents.clone(),
		tool_settings.format_policy,
		edit_observer.clone(),
		tool_settings.edit_guard_generated,
		tool_settings.edit_require_seen,
	));
	let mut patch_edit = Some(omp_tools::edit::patch_tool_with_observer(
		documents.clone(),
		tool_settings.format_policy,
		edit_observer.clone(),
		tool_settings.edit_guard_generated,
		tool_settings.edit_require_seen,
	));
	let mut apply_patch_edit = Some(omp_tools::edit::apply_patch_tool_with_observer(
		documents.clone(),
		tool_settings.format_policy,
		edit_observer.clone(),
		tool_settings.edit_guard_generated,
		tool_settings.edit_require_seen,
	));
	let mut sloppy_edit = Some(omp_tools::edit::sloppy_tool_with_observer(
		documents.clone(),
		tool_settings.format_policy,
		edit_observer,
		tool_settings.edit_guard_generated,
		tool_settings.edit_require_seen,
	));
	if tool_settings.enabled("edit") {
		let mut edits = [
			(
				legacy_replace_edit
					.as_ref()
					.expect("constructed")
					.spec()
					.identity(),
				0_u8,
			),
			(
				legacy_patch_edit
					.as_ref()
					.expect("constructed")
					.spec()
					.identity(),
				1,
			),
			(
				hashline_edit
					.as_ref()
					.expect("constructed")
					.spec()
					.identity(),
				2,
			),
			(
				replace_edit
					.as_ref()
					.expect("constructed")
					.spec()
					.identity(),
				3,
			),
			(patch_edit.as_ref().expect("constructed").spec().identity(), 4),
			(
				apply_patch_edit
					.as_ref()
					.expect("constructed")
					.spec()
					.identity(),
				5,
			),
			(sloppy_edit.as_ref().expect("constructed").spec().identity(), 6),
		];
		edits.sort_by_key(|(identity, _)| identity.rev == selected_edit);
		for (_, index) in edits {
			match index {
				0 => environment_registry(
					&mut registry,
					legacy_replace_edit.take().expect("once"),
					essential_presentation(policy),
					core_claims(),
				)?,
				1 => environment_registry(
					&mut registry,
					legacy_patch_edit.take().expect("once"),
					essential_presentation(policy),
					core_claims(),
				)?,
				2 => environment_registry(
					&mut registry,
					hashline_edit.take().expect("once"),
					essential_presentation(policy),
					core_claims(),
				)?,
				3 => environment_registry(
					&mut registry,
					replace_edit.take().expect("once"),
					essential_presentation(policy),
					core_claims(),
				)?,
				4 => environment_registry(
					&mut registry,
					patch_edit.take().expect("once"),
					essential_presentation(policy),
					core_claims(),
				)?,
				5 => environment_registry(
					&mut registry,
					apply_patch_edit.take().expect("once"),
					essential_presentation(policy),
					core_claims(),
				)?,
				6 => environment_registry(
					&mut registry,
					sloppy_edit.take().expect("once"),
					essential_presentation(policy),
					core_claims(),
				)?,
				_ => unreachable!(),
			}
		}
	}
	let write = omp_tools::write::tool_with_policy_and_conflicts(
		documents.clone(),
		conflicts,
		tool_settings.format_policy,
		tool_settings.edit_guard_generated,
	);
	if tool_settings.enabled("write") {
		environment_registry(
			&mut registry,
			write,
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	if tool_settings.enabled("lsp") {
		let maximum = tool_settings
			.max_timeout
			.and_then(|duration| duration.to_std().ok())
			.unwrap_or_else(|| time::Duration::from_secs(300));
		environment_registry(
			&mut registry,
			omp_tools::lsp::tool(DocumentLspControl::new(documents.clone(), exec.clone()), maximum),
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	if tool_settings.enabled("debug") {
		let maximum = tool_settings
			.max_timeout
			.and_then(|duration| duration.to_std().ok())
			.unwrap_or_else(|| time::Duration::from_secs(300));
		environment_registry(
			&mut registry,
			omp_tools::debug::tool(DocumentDebugControl::new(documents.clone()), maximum),
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	let search = WorkspaceSearchAdapter::new(
		workspace.clone(),
		documents.clone(),
		read_sources.clone(),
		Arc::clone(&resolvers),
	);
	let grep = omp_tools::grep::tool(
		search.clone(),
		u32::from(tool_settings.grep_context_before),
		u32::from(tool_settings.grep_context_after),
	);
	if tool_settings.enabled("grep") {
		environment_registry(&mut registry, grep, essential_presentation(policy), core_claims())?;
	}
	let glob = omp_tools::glob::tool(search);
	if tool_settings.enabled("glob") {
		environment_registry(&mut registry, glob, essential_presentation(policy), core_claims())?;
	}
	if tool_settings.enabled("ast_grep") {
		let ast_search = AstSearchAuthority::new(
			workspace.clone(),
			read_sources.clone(),
			Arc::clone(&resolvers),
			state_dir,
		);
		environment_registry(
			&mut registry,
			omp_tools::ast_grep::tool(ast_search),
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	if tool_settings.enabled("ast_edit") {
		environment_registry(
			&mut registry,
			omp_tools::ast_edit::tool(workspace.root().to_path_buf(), previews.clone()),
			long_tail_presentation(policy),
			long_tail_claims(policy),
		)?;
	}
	let prelude = Arc::new(build_prelude_table(workers)?);
	let helper_docs = prelude
		.helpers()
		.map(|helper| omp_tools::eval::PreludeHelperDescription {
			signature: helper.signature.as_str(),
			summary:   helper.summary.as_str(),
		})
		.collect::<Vec<_>>();
	let eval_host = Arc::new(SessionBridgeHost::new());
	let mut eval_control = EvalSessionControl::default();
	if tool_settings.enabled("eval") || py_eval {
		let eval_exec = compose_eval_executor(
			ProcessEvalExec::production(
				exec.clone(),
				Arc::clone(&eval_host),
				interrupt_grace,
				blobs.clone(),
				tool_settings
					.eval_interpreters
					.get("py")
					.map(|path| PathBuf::from(path.as_str())),
			),
			py_eval,
		)?;
		if let Some(eval_exec) = eval_exec {
			let mut task_snapshot = TaskDescriptionSnapshot {
				helpers: &helper_docs,
				..TaskDescriptionSnapshot::standard()
			};
			if !tool_settings.enabled("task") {
				task_snapshot.agents = &[];
			}
			let (eval_tool, control) =
				omp_tools::eval::eval_controlled_with_task_snapshot(eval_exec.clone(), task_snapshot);
			eval_control = control;
			if tool_settings.enabled("eval") {
				environment_registry(
					&mut registry,
					eval_tool,
					long_tail_presentation(policy),
					long_tail_claims(policy),
				)?;
			}
			if py_eval {
				environment_registry(
					&mut registry,
					omp_tools::eval::py_eval(eval_exec),
					long_tail_presentation(policy),
					long_tail_claims(policy),
				)?;
			}
		}
	}
	let dyn_installed = tool_settings.enabled("dyn") && dyn_enabled(policy);
	if dyn_installed {
		exec.install_devices(Arc::new(DynHost::new(
			catalog.clone(),
			Arc::new(device_invoker),
			previews.clone(),
			Arc::clone(&hooks),
			blobs.clone(),
			mcp_manager,
			DynamicAdmission::new(tool_settings.approval_mode, tool_settings.approval.clone(), None),
		)));
	}
	if tool_settings.enabled("bash") && shell_settings.enabled {
		let sibling_tools = registry
			.live_identities()
			.filter_map(|(name, _)| {
				(name != "bash" && registry.presentation(name).ok() == Some(Presentation::Slot))
					.then(|| name.clone())
			})
			.collect::<Arc<[_]>>();
		let snapshot = omp_tools::shell::ShellPromptSnapshot {
			sibling_tools,
			platform: Str::new(consts::OS),
			devices: dyn_installed,
			embedded_builtins: shell_settings.embedded_builtins,
			interceptor_enabled: shell_settings.interceptor.enabled,
			interceptor_rules: shell_settings
				.interceptor
				.patterns
				.iter()
				.map(|rule| omp_tools::shell_intercept::Rule {
					pattern: rule.pattern.clone(),
					tool:    rule.tool.clone(),
					message: rule.message.clone(),
				})
				.collect(),
			acp_routing: acp_settings.routing != AcpRouting::Never,
			command_prefix: shell_settings.command_prefix.is_some(),
		};
		let shell = omp_tools::shell::shell_with_snapshot_and_timeout_bounds(
			ShellExecHost::new(
				exec.clone(),
				blobs.clone(),
				root_uri.clone(),
				Arc::clone(&resolvers),
				shell_settings.clone(),
				sandbox_settings.clone(),
				acp_exec,
				acp_settings.routing != AcpRouting::Never,
			),
			shell_timeout_bounds(tool_settings),
			&snapshot,
		)
		.with_auto_background(
			shell_settings.auto_background.enabled,
			time::Duration::from_millis(shell_settings.auto_background.threshold_ms),
		);
		environment_registry(&mut registry, shell, bash_presentation(policy), core_claims())?;
	}
	register_session_workers(&mut registry, workers, policy)?;
	let registry = Arc::new(registry);
	catalog
		.install_registry(Arc::clone(&registry))
		.map_err(|_| EnvdError::WorkerDeclaration(sf!("dynamic device catalog installed twice")))?;
	eval_host
		.bind_registry(Arc::clone(&registry))
		.map_err(|error| EnvdError::Eval(Str::from(error.to_string())))?;
	eval_host
		.bind_prelude(prelude, Arc::new(prelude_invoker))
		.map_err(|error| EnvdError::Eval(Str::from(error.to_string())))?;
	Ok((
		registry,
		eval_host,
		reflection_bridge,
		eval_control,
		checkpoint_control,
		previews,
		resolvers,
		search_bridge,
		github_credentials,
		ask_presenter,
	))
}

fn compose_eval_executor<T>(
	executor: Result<T, std::io::Error>,
	py_eval_explicit: bool,
) -> Result<Option<T>, EnvdError> {
	match executor {
		Ok(executor) => Ok(Some(executor)),
		Err(error) if py_eval_explicit => Err(EnvdError::Eval(Str::from(format!(
			"environment composition could not construct the explicitly requested py_eval executor: \
			 {error}"
		)))),
		Err(error) => {
			tracing::warn!(
				error = %error,
				"Python tools omitted because the eval child configuration is unavailable"
			);
			Ok(None)
		},
	}
}

#[derive(Clone)]
struct GoalControlAdapter(Arc<dyn GoalAuthority>);

impl omp_tools::goal::GoalControl for GoalControlAdapter {
	fn apply(
		&self,
		params: omp_tools::goal::Params,
	) -> impl Future<Output = Result<Option<omp_tools::goal::Goal>, goal::Fault>> + Send + '_ {
		async move { self.0.apply(params).await }
	}
}

#[derive(Clone)]
struct CheckpointBinding {
	id:     u64,
	sender: KernelSender,
}

#[derive(Clone)]
enum CheckpointWorkspace {
	Local(WorkspaceOperations),
	Owner(EnvClient),
}

#[derive(Clone)]
struct ActiveCheckpoint {
	binding_id: u64,
	info:       Arc<checkpoint::CheckpointInfo>,
}

/// Late-bound bridge from environment-owned checkpoint tools to the active
/// Agent CONTROL mailbox.
#[derive(Clone, Default)]
pub struct AgentCheckpointControl {
	sender:             Arc<RwLock<Option<CheckpointBinding>>>,
	workspace:          Arc<RwLock<Option<CheckpointWorkspace>>>,
	active_checkpoints: Arc<RwLock<Vec<ActiveCheckpoint>>>,
	rewind_pending:     Arc<RwLock<bool>>,
	transition:         Arc<AsyncMutex<()>>,
}

impl AgentCheckpointControl {
	/// Binds the local project environment's document-backed workspace owner.
	pub fn bind_local_workspace(&self, workspace: WorkspaceOperations) {
		*self.workspace.write() = Some(CheckpointWorkspace::Local(workspace));
	}

	/// Binds a child session host to its project environment's workspace owner.
	pub fn bind_owner_workspace(&self, workspace: EnvClient) {
		*self.workspace.write() = Some(CheckpointWorkspace::Owner(workspace));
	}

	/// Replaces the active session binding.
	pub fn bind(&self, id: u64, sender: KernelSender) {
		*self.sender.write() = Some(CheckpointBinding { id, sender });
		self.active_checkpoints.write().clear();
		*self.rewind_pending.write() = false;
	}

	/// Re-derives checkpoint execution state from the selected journal's DOM.
	/// The process-local cache never decides whether a checkpoint survives a
	/// switch, rewind, or resume.
	pub fn restore_session(&self, id: u64, dom: &omp_dom::Dom) {
		if !self
			.sender
			.read()
			.as_ref()
			.is_some_and(|binding| binding.id == id)
		{
			return;
		}
		let checkpoints = dom
			.handles()
			.filter_map(|handle| {
				let node = dom.get(handle)?;
				if node.tag != omp_dom::Tag::Custom(Str::new_static("rewind-checkpoint")) {
					return None;
				}
				let text = |name: &'static str| {
					node
						.prop(&omp_dom::PropKey::Custom(Str::new_static(name)))
						.and_then(omp_dom::Value::as_str)
						.map(Str::new)
				};
				let number = |name: &'static str| match node
					.prop(&omp_dom::PropKey::Custom(Str::new_static(name)))?
				{
					omp_dom::Value::Int(value) => u64::try_from(*value).ok(),
					_ => None,
				};
				let boolean = |name: &'static str| match node
					.prop(&omp_dom::PropKey::Custom(Str::new_static(name)))?
				{
					omp_dom::Value::Bool(value) => Some(*value),
					_ => None,
				};
				let label = node
					.prop(&omp_dom::PropKey::from(omp_dom::PropId::Label))
					.and_then(omp_dom::Value::as_str)
					.map(Str::new)?;
				let snapshot = env_wire::WorkspaceSnapshot {
					snapshot_id: text("workspace-snapshot")?.to_string(),
					generation: number("workspace-generation")?,
					root_uri: text("workspace-root")?.to_string(),
					tree_hash: text("workspace-tree")?.to_string(),
					files: number("workspace-files")?,
					bytes: number("workspace-bytes")?,
					entry_count: number("workspace-files")?,
					created_ms: number("workspace-created-at")?,
					label: Some(label.to_string()),
					parent_snapshot_id: text("workspace-parent").map(|value| value.to_string()),
					partial: boolean("workspace-partial")?,
					wire_revision: omp_proto::SCHEMA_REV,
					..Default::default()
				};
				Some(ActiveCheckpoint {
					binding_id: id,
					info:       Arc::new(checkpoint::CheckpointInfo {
						token: text("token")?,
						label,
						goal: text("goal")?,
						started_at: number("started-at")?,
						parent_token: text("parent-token"),
						session_target: text("target"),
						workspace: checkpoint_snapshot(&snapshot),
					}),
				})
			})
			.collect();
		*self.active_checkpoints.write() = checkpoints;
		*self.rewind_pending.write() = false;
	}

	/// Releases the binding only when it is still owned by `id`, returning
	/// whether this lease was current.
	pub fn unbind(&self, id: u64) -> bool {
		let mut binding = self.sender.write();
		if binding.as_ref().is_some_and(|binding| binding.id == id) {
			*binding = None;
			self.active_checkpoints.write().clear();
			*self.rewind_pending.write() = false;
			true
		} else {
			false
		}
	}

	fn binding(&self) -> Result<CheckpointBinding, omp_tools::checkpoint::CheckpointFault> {
		self
			.sender
			.read()
			.clone()
			.ok_or_else(|| omp_tools::checkpoint::CheckpointFault {
				code:    checkpoint::FaultCode::Control,
				message: sf!("active Agent CONTROL is not bound"),
			})
	}

	fn ensure_binding(&self, id: u64) -> Result<(), omp_tools::checkpoint::CheckpointFault> {
		if self
			.sender
			.read()
			.as_ref()
			.is_some_and(|binding| binding.id == id)
		{
			Ok(())
		} else {
			Err(checkpoint_fault(
				checkpoint::FaultCode::NotFound,
				"checkpoint belongs to another session",
			))
		}
	}

	fn workspace(&self) -> Result<CheckpointWorkspace, omp_tools::checkpoint::CheckpointFault> {
		self
			.workspace
			.read()
			.clone()
			.ok_or_else(|| omp_tools::checkpoint::CheckpointFault {
				code:    checkpoint::FaultCode::Control,
				message: sf!("workspace authority is not bound"),
			})
	}
}

impl CheckpointWorkspace {
	async fn snapshot(
		&self,
		request: env_wire::SnapshotWorkspace,
		cancel: &CancellationToken,
	) -> Result<env_wire::WorkspaceSnapshot, omp_tools::checkpoint::CheckpointFault> {
		let result = match self {
			Self::Local(workspace) => {
				let workspace = workspace.clone();
				let cancel = cancel.clone();
				tokio::task::spawn_blocking(move || workspace.snapshot(&request, &cancel))
					.await
					.map_err(|source| {
						tracing::warn!(?source, "checkpoint workspace snapshot worker failed");
						checkpoint_fault(
							checkpoint::FaultCode::SnapshotFailed,
							"workspace snapshot worker failed",
						)
					})?
					.map_err(local_snapshot_fault)
			},
			Self::Owner(workspace) => {
				tokio::select! {
					result = workspace.snapshot_workspace(request) => {
						result.map_err(|source| {
							tracing::warn!(?source, "checkpoint workspace capture failed");
							checkpoint_fault(
								checkpoint::FaultCode::SnapshotFailed,
								"workspace snapshot failed",
							)
						})
					},
					() = cancel.cancelled() => {
						Err(checkpoint_fault(
							checkpoint::FaultCode::RestoreCancelled,
							"workspace snapshot was cancelled",
						))
					},
				}
			},
		};
		if cancel.is_cancelled() {
			return Err(checkpoint_fault(
				checkpoint::FaultCode::RestoreCancelled,
				"workspace snapshot was cancelled",
			));
		}
		result
	}

	async fn restore(
		&self,
		request: env_wire::RestoreWorkspace,
		cancel: &CancellationToken,
	) -> Result<env_wire::WorkspaceRestored, omp_tools::checkpoint::CheckpointFault> {
		match self {
			Self::Local(workspace) => workspace
				.restore(&request, cancel)
				.await
				.map_err(local_workspace_fault),
			Self::Owner(workspace) => {
				if cancel.is_cancelled() {
					return Err(checkpoint_fault(
						checkpoint::FaultCode::RestoreCancelled,
						"workspace restoration was cancelled",
					));
				}
				let dry_run = request.dry_run;
				let restore = workspace.restore_workspace(request);
				tokio::pin!(restore);
				let result = if dry_run {
					tokio::select! {
						result = &mut restore => result,
						() = cancel.cancelled() => {
							return Err(checkpoint_fault(
								checkpoint::FaultCode::RestoreCancelled,
								"workspace restoration was cancelled",
							));
						},
					}
				} else {
					restore.await
				};
				result.map_err(|source| {
					tracing::warn!(?source, "checkpoint workspace restore failed");
					checkpoint_fault(
						checkpoint::FaultCode::RestoreFailed,
						"workspace restoration failed",
					)
				})
			},
		}
	}
}

impl omp_tools::checkpoint::CheckpointControl for AgentCheckpointControl {
	async fn create_checkpoint(
		&self,
		goal: Str,
		label: Str,
		cancel: CancellationToken,
	) -> Result<omp_tools::checkpoint::CheckpointAck, omp_tools::checkpoint::CheckpointFault> {
		let _transition = self.transition.lock().await;
		let binding = self.binding()?;
		let parent_token = {
			let checkpoints = self.active_checkpoints.read();
			if checkpoints
				.iter()
				.any(|checkpoint| checkpoint.info.label == label)
			{
				return Err(checkpoint_fault(
					checkpoint::FaultCode::DuplicateLabel,
					"checkpoint label already exists on the selected branch",
				));
			}
			checkpoints
				.last()
				.map(|checkpoint| checkpoint.info.token.clone())
		};
		let started_at = epoch_millis()?;
		let token = sf!("checkpoint-{}-{}", binding.id, Ulid::generate());
		let snapshot = self
			.workspace()?
			.snapshot(
				env_wire::SnapshotWorkspace {
					scope: "checkpoint".to_owned(),
					label: Some(label.to_string()),
					wire_revision: omp_proto::SCHEMA_REV,
					..Default::default()
				},
				&cancel,
			)
			.await?;
		self.ensure_binding(binding.id)?;
		let info = Arc::new(checkpoint::CheckpointInfo {
			token: token.clone(),
			label: label.clone(),
			goal: goal.clone(),
			started_at,
			parent_token: parent_token.clone(),
			session_target: None,
			workspace: checkpoint_snapshot(&snapshot),
		});
		binding
			.sender
			.send(omp_agent::Up::Env(omp_agent::EnvEvent::CheckpointOpened {
				token,
				label,
				goal,
				parent_token,
				started_at,
				workspace: snapshot,
			}))
			.map_err(|_| {
				checkpoint_fault(checkpoint::FaultCode::Control, "active Agent mailbox is closed")
			})?;
		self
			.active_checkpoints
			.write()
			.push(ActiveCheckpoint { binding_id: binding.id, info: info.clone() });
		Ok(omp_tools::checkpoint::CheckpointAck { checkpoint: info })
	}

	fn list_checkpoints(
		&self,
		limit: u16,
	) -> impl Future<
		Output = Result<Vec<Arc<checkpoint::CheckpointInfo>>, omp_tools::checkpoint::CheckpointFault>,
	> + Send {
		let result = self.binding().map(|binding| {
			self
				.active_checkpoints
				.read()
				.iter()
				.rev()
				.filter(|checkpoint| checkpoint.binding_id == binding.id)
				.take(usize::from(limit))
				.map(|checkpoint| checkpoint.info.clone())
				.collect()
		});
		std::future::ready(result)
	}

	async fn schedule_rewind(
		&self,
		selector: Str,
		report: Str,
		cancel: CancellationToken,
	) -> Result<omp_tools::checkpoint::RewindAck, omp_tools::checkpoint::CheckpointFault> {
		let _transition = self.transition.lock().await;
		if *self.rewind_pending.read() {
			return Err(checkpoint_fault(
				checkpoint::FaultCode::AlreadyScheduled,
				"a rewind is already scheduled",
			));
		}
		let binding = self.binding()?;
		let active = {
			let checkpoints = self.active_checkpoints.read();
			checkpoints
				.iter()
				.find(|checkpoint| {
					checkpoint.binding_id == binding.id && checkpoint.info.token == selector
				})
				.cloned()
				.or_else(|| {
					let mut labels = checkpoints.iter().filter(|checkpoint| {
						checkpoint.binding_id == binding.id && checkpoint.info.label == selector
					});
					let checkpoint = labels.next()?.clone();
					labels.next().is_none().then_some(checkpoint)
				})
		}
		.ok_or_else(|| {
			let ambiguous = self
				.active_checkpoints
				.read()
				.iter()
				.filter(|checkpoint| {
					checkpoint.binding_id == binding.id && checkpoint.info.label == selector
				})
				.count() > 1;
			if ambiguous {
				checkpoint_fault(
					checkpoint::FaultCode::AmbiguousSelector,
					"checkpoint label is ambiguous; select by token",
				)
			} else {
				checkpoint_fault(
					checkpoint::FaultCode::NotFound,
					"checkpoint token or label is not on the selected branch",
				)
			}
		})?;
		let workspace = self.workspace()?;
		let request = env_wire::RestoreWorkspace {
			snapshot_id: active.info.workspace.snapshot_id.to_string(),
			dry_run: true,
			scope: "checkpoint".to_owned(),
			wire_revision: omp_proto::SCHEMA_REV,
			..Default::default()
		};
		let preview = workspace.restore(request.clone(), &cancel).await?;
		ensure_complete_restore(&preview)?;
		self.ensure_binding(binding.id)?;
		if cancel.is_cancelled() {
			return Err(checkpoint_fault(
				checkpoint::FaultCode::RestoreCancelled,
				"workspace restoration was cancelled",
			));
		}
		let restored = workspace
			.restore(
				env_wire::RestoreWorkspace {
					dry_run: false,
					expected_generation: preview.from_generation,
					..request
				},
				&cancel,
			)
			.await?;
		if let Err(fault) = ensure_complete_restore(&restored) {
			if restored.partial {
				rollback_workspace(&workspace, &restored).await;
			}
			return Err(fault);
		}
		if let Err(fault) = self.ensure_binding(binding.id) {
			rollback_workspace(&workspace, &restored).await;
			return Err(fault);
		}
		let receipt = sf!("rewind-{}", Ulid::generate());
		let rewound_at = epoch_millis()?;
		if binding
			.sender
			.send(omp_agent::Up::Env(omp_agent::EnvEvent::CheckpointRewind {
				token: active.info.token.clone(),
				report: report.clone(),
				receipt: receipt.clone(),
				workspace: restored.clone(),
				rewound_at,
			}))
			.is_err()
		{
			rollback_workspace(&workspace, &restored).await;
			return Err(checkpoint_fault(
				checkpoint::FaultCode::Control,
				"active Agent mailbox is closed",
			));
		}
		*self.rewind_pending.write() = true;
		Ok(omp_tools::checkpoint::RewindAck {
			checkpoint: active.info,
			receipt,
			workspace: checkpoint_restore(&restored),
		})
	}
}

async fn rollback_workspace(
	workspace: &CheckpointWorkspace,
	restored: &env_wire::WorkspaceRestored,
) {
	if restored.undo_snapshot_id.is_empty() {
		return;
	}
	let rollback_cancel = CancellationToken::new();
	let rollback = workspace
		.restore(
			env_wire::RestoreWorkspace {
				snapshot_id: restored.undo_snapshot_id.clone(),
				scope: "checkpoint-rollback".to_owned(),
				wire_revision: omp_proto::SCHEMA_REV,
				..Default::default()
			},
			&rollback_cancel,
		)
		.await;
	if rollback.as_ref().is_err()
		|| rollback
			.as_ref()
			.is_ok_and(|value| value.partial || !value.conflicts.is_empty())
	{
		tracing::error!(
			snapshot = %restored.undo_snapshot_id,
			"checkpoint restoration and automatic rollback both failed"
		);
	}
}

fn epoch_millis() -> Result<u64, omp_tools::checkpoint::CheckpointFault> {
	let elapsed = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_err(|source| {
			tracing::warn!(?source, "checkpoint clock is before the Unix epoch");
			checkpoint_fault(checkpoint::FaultCode::Control, "system clock is unavailable")
		})?;
	Ok(u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

fn local_snapshot_fault(source: WorkspaceOperationError) -> omp_tools::checkpoint::CheckpointFault {
	let cancelled = matches!(
		&source,
		WorkspaceOperationError::Workspace(crate::workspace::WorkspaceError::Cancelled)
	);
	tracing::warn!(?source, "checkpoint workspace snapshot failed");
	if cancelled {
		checkpoint_fault(checkpoint::FaultCode::RestoreCancelled, "workspace snapshot was cancelled")
	} else {
		checkpoint_fault(checkpoint::FaultCode::SnapshotFailed, "workspace snapshot failed")
	}
}

fn local_workspace_fault(
	source: WorkspaceOperationError,
) -> omp_tools::checkpoint::CheckpointFault {
	let cancelled = matches!(
		&source,
		WorkspaceOperationError::Workspace(crate::workspace::WorkspaceError::Cancelled)
	);
	tracing::warn!(?source, "checkpoint workspace operation failed");
	if cancelled {
		checkpoint_fault(checkpoint::FaultCode::RestoreCancelled, "workspace operation was cancelled")
	} else {
		checkpoint_fault(checkpoint::FaultCode::RestoreFailed, "workspace operation failed")
	}
}

fn ensure_complete_restore(
	restored: &env_wire::WorkspaceRestored,
) -> Result<(), omp_tools::checkpoint::CheckpointFault> {
	if restored.partial {
		return Err(checkpoint_fault(
			checkpoint::FaultCode::RestoreFailed,
			"workspace restoration partially committed; the undo snapshot was retained",
		));
	}
	if !restored.conflicts.is_empty() {
		return Err(omp_tools::checkpoint::CheckpointFault {
			code:    checkpoint::FaultCode::RestoreConflict,
			message: sf!(
				"workspace restoration blocked by {} conflict(s), first at {}",
				restored.conflicts.len(),
				restored.conflicts[0].path
			),
		});
	}
	Ok(())
}

fn checkpoint_snapshot(
	snapshot: &env_wire::WorkspaceSnapshot,
) -> omp_tools::checkpoint::WorkspaceSnapshot {
	omp_tools::checkpoint::WorkspaceSnapshot {
		snapshot_id:        Str::new(&snapshot.snapshot_id),
		root_uri:           Str::new(&snapshot.root_uri),
		generation:         snapshot.generation,
		tree_hash:          Str::new(&snapshot.tree_hash),
		files:              snapshot.files,
		bytes:              snapshot.bytes,
		label:              snapshot.label.as_deref().map(Str::new),
		parent_snapshot_id: snapshot.parent_snapshot_id.as_deref().map(Str::new),
		created_at:         snapshot.created_ms,
		partial:            snapshot.partial,
	}
}

fn checkpoint_restore(
	restored: &env_wire::WorkspaceRestored,
) -> omp_tools::checkpoint::WorkspaceRestore {
	omp_tools::checkpoint::WorkspaceRestore {
		snapshot_id:      Str::new(&restored.snapshot_id),
		undo_snapshot_id: Str::new(&restored.undo_snapshot_id),
		written:          restored.written,
		deleted:          restored.deleted,
		unchanged:        restored.unchanged,
		from_generation:  restored.from_generation,
		to_generation:    restored.to_generation,
	}
}

fn checkpoint_fault(
	code: checkpoint::FaultCode,
	message: &'static str,
) -> omp_tools::checkpoint::CheckpointFault {
	omp_tools::checkpoint::CheckpointFault { code, message: sf!(message) }
}

#[cfg(test)]
pub(super) fn python_engine() -> Result<Arc<omp_py::Engine>, EnvdError> {
	static ENGINE: LazyLock<Result<Arc<omp_py::Engine>, Str>> = LazyLock::new(|| {
		omp_py::Engine::builder()
			.init()
			.map(Arc::new)
			.map_err(|error| Str::from(error.to_string()))
	});
	ENGINE
		.as_ref()
		.map(Arc::clone)
		.map_err(|error| EnvdError::Eval(error.clone()))
}

fn ensure_name_absent(registry: &Registry, name: &str) -> Result<(), EnvdError> {
	if registry.live_identity(name).is_some() {
		return Err(EnvdError::DuplicateToolName(Str::from(name)));
	}
	Ok(())
}

const fn essential_presentation(policy: ToolsPolicy) -> Presentation {
	if matches!(policy, ToolsPolicy::DeviceOnly) {
		Presentation::Device
	} else {
		Presentation::Slot
	}
}

const fn bash_presentation(_policy: ToolsPolicy) -> Presentation {
	Presentation::Slot
}

const fn long_tail_presentation(policy: ToolsPolicy) -> Presentation {
	if matches!(policy, ToolsPolicy::ToolOnly) {
		Presentation::Slot
	} else {
		Presentation::Device
	}
}

const fn core_claims() -> Claims {
	Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None }
}

/// Claims for a long-tail tool: core precedence only while it rides the wire
/// roster as a slot; the registry refuses devices at core precedence.
const fn long_tail_claims(policy: ToolsPolicy) -> Claims {
	if matches!(policy, ToolsPolicy::ToolOnly) {
		core_claims()
	} else {
		builtin_device_claims()
	}
}

const fn builtin_device_claims() -> Claims {
	Claims { precedence: Precedence::ENHANCEMENT, claimant: sf!("omp/core"), replaces: None }
}

fn shell_timeout_bounds(settings: &ToolSettings) -> TimeoutBounds {
	let mut bounds = TimeoutBounds::default();
	let Some(maximum) = settings.max_timeout else {
		return bounds;
	};
	let milliseconds = maximum
		.to_std()
		.ok()
		.and_then(|duration| u64::try_from(duration.as_millis()).ok())
		.unwrap_or(bounds.ceiling_ms);
	bounds.ceiling_ms = milliseconds.max(bounds.floor_ms).min(bounds.ceiling_ms);
	bounds.default_ms = bounds
		.default_ms
		.min(bounds.ceiling_ms)
		.max(bounds.floor_ms);
	bounds
}

fn build_prelude_table(workers: &ExtHostSupervisor) -> Result<PreludeTable, EnvdError> {
	let mut registrations = Vec::new();
	let mut ordinary_names = BTreeSet::new();
	for registration in workers.registrations() {
		if !is_prelude_declaration(&registration.declaration)? {
			if let Some(definition) = &registration.declaration.definition {
				ordinary_names.insert(Str::from(definition.name.as_str()));
			}
			continue;
		}
		let definition = registration
			.declaration
			.definition
			.as_ref()
			.ok_or_else(|| worker_declaration_error("prelude helper declaration has no definition"))?;
		if registration.declaration.extension_id.is_empty() {
			return Err(worker_declaration_error("prelude helper declaration has no extension id"));
		}
		registrations.push((
			Str::from(definition.name.as_str()),
			registration.owner.extension().clone(),
			&registration.declaration,
		));
	}
	registrations.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));

	let mut table = PreludeTable::new();
	let mut declared_by = BTreeMap::<Str, Str>::new();
	for (name, owner, declaration) in registrations {
		if let Some(first) = declared_by.get(&name) {
			return Err(EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {name} is declared by both {first} and {owner}"
			))));
		}
		if PRELUDE_RESERVED_NAMES.contains(&name.as_str()) {
			return Err(EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {name} shadows a prelude builtin"
			))));
		}
		if name.starts_with("__") {
			return Err(EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {name} uses the reserved dunder namespace"
			))));
		}
		if !valid_prelude_name(name.as_str()) {
			return Err(EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {name} has an invalid name"
			))));
		}
		if PRELUDE_PYTHON_KEYWORDS.contains(&name.as_str()) {
			return Err(EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {name} uses a Python keyword"
			))));
		}
		if ordinary_names.contains(&name) {
			return Err(EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {name} collides with a worker tool"
			))));
		}
		let params = prelude_params(&name, declaration)?;
		let helper = PreludeHelper::new(
			name.clone(),
			Str::from(declaration.rev.as_str()),
			Str::from(declaration.docs.as_str()),
			Str::from(declaration.summary.as_str()),
			params,
		);
		let previous = table.insert(helper);
		debug_assert!(previous.is_none(), "duplicate prelude helper checked above");
		declared_by.insert(name, owner);
	}
	Ok(table)
}
fn valid_prelude_name(name: &str) -> bool {
	let Some((&first, rest)) = name.as_bytes().split_first() else {
		return false;
	};
	name.len() <= 64
		&& first.is_ascii_lowercase()
		&& rest
			.iter()
			.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn valid_prelude_param_name(name: &str) -> bool {
	let Some((&first, rest)) = name.as_bytes().split_first() else {
		return false;
	};
	(first == b'_' || first.is_ascii_alphabetic())
		&& rest
			.iter()
			.all(|byte| *byte == b'_' || byte.is_ascii_alphanumeric())
}

fn prelude_params(
	helper_name: &str,
	declaration: &ToolDecl,
) -> Result<Vec<PreludeParamStub>, EnvdError> {
	let mut params = Vec::with_capacity(declaration.prelude_params.len());
	let mut names = BTreeSet::new();
	let mut keyword_only = false;
	let mut positional_default = false;
	for param in &declaration.prelude_params {
		if !valid_prelude_param_name(&param.name) {
			return Err(EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {helper_name} parameter {} has an invalid name",
				param.name
			))));
		}
		if PRELUDE_PYTHON_KEYWORDS.contains(&param.name.as_str()) {
			return Err(EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {helper_name} parameter {} uses a Python keyword",
				param.name
			))));
		}
		let param_name = Str::from(param.name.as_str());
		if !names.insert(param_name.clone()) {
			return Err(EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {helper_name} declares parameter {} more than once",
				param.name
			))));
		}
		let kind = PreludeParamKind::try_from(param.kind).map_err(|_| {
			EnvdError::WorkerDeclaration(Str::from(format!(
				"prelude helper {helper_name} parameter {} has an invalid kind",
				param.name
			)))
		})?;
		match kind {
			PreludeParamKind::Unspecified => {
				return Err(EnvdError::WorkerDeclaration(Str::from(format!(
					"prelude helper {helper_name} parameter {} has an unspecified kind",
					param.name
				))));
			},
			PreludeParamKind::PositionalOrKeyword => {
				if keyword_only {
					return Err(EnvdError::WorkerDeclaration(Str::from(format!(
						"prelude helper {helper_name} has a positional parameter after a keyword-only \
						 parameter"
					))));
				}
				if param.default_json.is_some() {
					positional_default = true;
				} else if positional_default {
					return Err(EnvdError::WorkerDeclaration(Str::from(format!(
						"prelude helper {helper_name} has a required positional parameter after a \
						 default"
					))));
				}
			},
			PreludeParamKind::KeywordOnly => keyword_only = true,
		}
		let default_json = param
			.default_json
			.as_deref()
			.map(|raw| {
				serde_json::from_slice::<serde_json::Value>(raw).map_err(|error| {
					EnvdError::WorkerDeclaration(Str::from(format!(
						"prelude helper {helper_name} parameter {} has an invalid JSON default: {error}",
						param.name
					)))
				})?;
				Str::from_utf8(raw).map_err(|error| {
					EnvdError::WorkerDeclaration(Str::from(format!(
						"prelude helper {helper_name} parameter {} has a non-UTF-8 default: {error}",
						param.name
					)))
				})
			})
			.transpose()?;
		params.push(PreludeParamStub {
			name: param_name,
			kind,
			default_json,
			annotation: param.annotation.as_deref().map(Str::from),
		});
	}
	Ok(params)
}

fn worker_revision(declaration: &ToolDecl) -> Result<Rev, EnvdError> {
	declaration
		.rev
		.parse::<Rev>()
		.map_err(|error| EnvdError::WorkerDeclaration(Str::from(error.to_string())))
}

fn is_prelude_declaration(declaration: &ToolDecl) -> Result<bool, EnvdError> {
	Ok(worker_revision(declaration)?.family == "prelude")
}

fn worker_spec(declaration: &ToolDecl) -> Result<ToolSpec, EnvdError> {
	let definition = declaration.definition.as_ref().ok_or_else(|| {
		EnvdError::WorkerDeclaration(sf!("worker tool declaration has no definition"))
	})?;
	if declaration.extension_id.is_empty() {
		return Err(worker_declaration_error("worker tool declaration has no extension id"));
	}
	let Some(tool_def::Input::JsonSchema(json_schema)) = definition.input.as_ref() else {
		return Err(worker_declaration_error("worker tool definition requires a JSON Schema input"));
	};
	Ok(ToolSpec {
		name:            Str::from(definition.name.as_str()),
		rev:             worker_revision(declaration)?,
		description:     Str::from(definition.description.as_str()),
		schema:          omp_tool::inject_protocol_schema(&json_schema.schema_json)?,
		constraint:      worker_constraint(declaration)?,
		projection_code: worker_projection_code(declaration),
		effects:         declaration
			.effects
			.as_ref()
			.map(omp_tool::Effects::try_from)
			.transpose()
			.map_err(|error| EnvdError::WorkerDeclaration(Str::from(error.to_string())))?
			.unwrap_or_default(),
	})
}

fn worker_projection_code(declaration: &ToolDecl) -> [u8; 32] {
	let mut hasher = Hash32::hasher();
	hasher.update(b"omp/frozen-worker-registration/v1");
	hasher.update(declaration.encode_to_vec());
	hasher.finalize().into_bytes()
}

fn worker_constraint(declaration: &ToolDecl) -> Result<Constraint, EnvdError> {
	let Some(kind) = declaration
		.constraint
		.as_ref()
		.and_then(|value| value.kind.as_ref())
	else {
		let strict = declaration
			.definition
			.as_ref()
			.and_then(|definition| definition.input.as_ref())
			.and_then(|input| match input {
				tool_def::Input::JsonSchema(schema) => schema.strict,
				tool_def::Input::Grammar(_) => None,
			})
			.unwrap_or(false);
		return Ok(if strict {
			Constraint::Schema { priority: 100, on_unsupported: v1::Fallback::Unspecified }
		} else {
			Constraint::None
		});
	};
	match kind {
		tool_constraint::Kind::Schema(schema) => Ok(Constraint::Schema {
			priority:       constraint_priority(schema.priority)?,
			on_unsupported: worker_fallback(schema.on_unsupported)?,
		}),
		tool_constraint::Kind::Grammar(grammar) => {
			let syntax = match WorkerGrammarSyntax::try_from(grammar.syntax) {
				Ok(WorkerGrammarSyntax::Lark) => GrammarSyntax::Lark,
				Ok(WorkerGrammarSyntax::Regex) => GrammarSyntax::Regex,
				Ok(WorkerGrammarSyntax::Ebnf) => GrammarSyntax::Ebnf,
				_ => {
					return Err(worker_declaration_error(
						"worker grammar constraint has an unsupported syntax",
					));
				},
			};
			Ok(Constraint::Grammar {
				syntax,
				definition: Str::from(grammar.definition.as_str()),
				priority: constraint_priority(grammar.priority)?,
				on_unsupported: worker_fallback(grammar.on_unsupported)?,
			})
		},
		tool_constraint::Kind::Textual(_) => {
			Err(worker_declaration_error("worker textual constraints are not supported"))
		},
		tool_constraint::Kind::Json(_) => {
			Err(worker_declaration_error("worker JSON constraints are not supported"))
		},
	}
}

fn worker_fallback(value: i32) -> Result<v1::Fallback, EnvdError> {
	v1::Fallback::try_from(value)
		.map_err(|_| worker_declaration_error("worker constraint fallback is invalid"))
}

fn constraint_priority(priority: u32) -> Result<u8, EnvdError> {
	u8::try_from(priority)
		.map_err(|_| worker_declaration_error("worker constraint priority exceeds u8"))
}

const fn worker_declaration_error(message: &'static str) -> EnvdError {
	EnvdError::WorkerDeclaration(sf!(message))
}

#[cfg(test)]
mod tests {
	use super::*;

	static EVAL_ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

	struct EvalEnvRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);

	impl EvalEnvRestore {
		fn set(values: &[(&'static str, &std::ffi::OsStr)]) -> Self {
			let previous = values
				.iter()
				.map(|(name, _)| (*name, env::var_os(name)))
				.collect();
			for (name, value) in values {
				// SAFETY: every mutation of these eval-specific variables in this
				// module is serialized by EVAL_ENV_LOCK and restored on drop.
				unsafe { env::set_var(name, value) };
			}
			Self(previous)
		}
	}

	impl Drop for EvalEnvRestore {
		fn drop(&mut self) {
			for (name, value) in self.0.drain(..).rev() {
				// SAFETY: EVAL_ENV_LOCK remains held until after this guard drops.
				unsafe {
					if let Some(value) = value {
						env::set_var(name, value);
					} else {
						env::remove_var(name);
					}
				}
			}
		}
	}

	#[test]
	fn explicit_py_eval_failure_is_typed_and_environment_override_has_precedence() {
		let _lock = EVAL_ENV_LOCK.lock();
		let scratch = tempfile::tempdir().expect("eval scratch");
		let current_exe = env::current_exe().expect("current test executable");
		let invalid_override = scratch.path().join("missing-python");
		let _restore = EvalEnvRestore::set(&[
			("CARGO_BIN_EXE_omp", current_exe.as_os_str()),
			("OMP_PYTHON_INTERPRETER", invalid_override.as_os_str()),
		]);
		let blobs = BlobHost::open(scratch.path().join("blobs")).expect("blob host");
		let constructed = ProcessEvalExec::production(
			ExecHost::new(),
			Arc::new(SessionBridgeHost::new()),
			"1s".parse().expect("interrupt grace"),
			blobs,
			Some(current_exe),
		);
		let error = match compose_eval_executor(constructed, true) {
			Err(error) => error,
			Ok(_) => panic!("explicit py_eval must reject an invalid environment override"),
		};
		let EnvdError::Eval(message) = error else {
			panic!("explicit py_eval failure must use the typed eval composition error");
		};
		assert!(message.contains("explicitly requested py_eval"));
		assert!(
			message.contains(invalid_override.to_string_lossy().as_ref()),
			"the environment override must win over the valid configured interpreter"
		);
	}

	#[test]
	fn incidental_eval_executor_failure_remains_an_omission() {
		let unavailable = std::io::Error::new(
			std::io::ErrorKind::NotFound,
			"configured Python interpreter is unavailable",
		);
		assert!(matches!(compose_eval_executor::<()>(Err(unavailable), false), Ok(None)));
	}

	#[test]
	fn extension_tool_call_timeout_caps_only_tool_call_handlers() {
		let configured = time::Duration::from_millis(125);
		let short = time::Duration::from_millis(25);
		let long = time::Duration::from_secs(5);
		assert_eq!(extension_callback_timeout("tool_call", configured, None, long), configured);
		assert_eq!(extension_callback_timeout("tool_call", configured, Some(short), long), short);
		assert_eq!(extension_callback_timeout("tool_call", configured, Some(long), long), configured);
		assert_eq!(extension_callback_timeout("tool_result", configured, None, long), long);
	}

	#[tokio::test]
	async fn checkpoint_cache_rehydrates_from_the_selected_branch_and_clears_on_switch() {
		let control = AgentCheckpointControl::default();
		let (sender, _mailbox) = flume::unbounded();
		control.bind(7, sender);
		let mut dom = omp_dom::Dom::new();
		dom.apply(&omp_dom::Txn {
			cause: omp_journal::EntryId::default(),
			label: None,
			ops:   vec![omp_dom::Op::Ins {
				parent: dom.meta(),
				after:  None,
				node:   omp_dom::NodeSpec::new(omp_dom::Tag::Custom(sf!("rewind-checkpoint")))
					.with_prop(
						omp_dom::PropKey::Custom(sf!("token")),
						omp_dom::Value::Str(sf!("checkpoint-1")),
					)
					.with_prop(omp_dom::PropId::Label, omp_dom::Value::Str(sf!("parser-baseline")))
					.with_prop(
						omp_dom::PropKey::Custom(sf!("goal")),
						omp_dom::Value::Str(sf!("inspect parser")),
					)
					.with_prop(
						omp_dom::PropKey::Custom(sf!("target")),
						omp_dom::Value::Str(sf!("01K4TARGET")),
					)
					.with_prop(
						omp_dom::PropKey::Custom(sf!("workspace-snapshot")),
						omp_dom::Value::Str(sf!("snapshot-1")),
					)
					.with_prop(
						omp_dom::PropKey::Custom(sf!("workspace-generation")),
						omp_dom::Value::Int(3),
					)
					.with_prop(
						omp_dom::PropKey::Custom(sf!("workspace-root")),
						omp_dom::Value::Str(sf!("file:///workspace")),
					)
					.with_prop(
						omp_dom::PropKey::Custom(sf!("workspace-tree")),
						omp_dom::Value::Str(sf!("tree")),
					)
					.with_prop(omp_dom::PropKey::Custom(sf!("workspace-files")), omp_dom::Value::Int(2))
					.with_prop(omp_dom::PropKey::Custom(sf!("workspace-bytes")), omp_dom::Value::Int(12))
					.with_prop(
						omp_dom::PropKey::Custom(sf!("workspace-parent")),
						omp_dom::Value::Str(sf!("snapshot-0")),
					)
					.with_prop(
						omp_dom::PropKey::Custom(sf!("workspace-created-at")),
						omp_dom::Value::Int(42),
					)
					.with_prop(
						omp_dom::PropKey::Custom(sf!("workspace-partial")),
						omp_dom::Value::Bool(false),
					)
					.with_prop(omp_dom::PropKey::Custom(sf!("started-at")), omp_dom::Value::Int(42)),
			}],
		})
		.expect("checkpoint DOM");

		control.restore_session(7, &dom);
		let active = control.active_checkpoints.read();
		assert_eq!(active.first().map(|value| value.info.token.as_str()), Some("checkpoint-1"));
		assert_eq!(
			active
				.first()
				.map(|value| value.info.workspace.snapshot_id.as_str()),
			Some("snapshot-1")
		);
		assert_eq!(
			active
				.first()
				.and_then(|value| value.info.session_target.as_deref()),
			Some("01K4TARGET")
		);
		assert_eq!(
			active
				.first()
				.and_then(|value| value.info.workspace.parent_snapshot_id.as_deref()),
			Some("snapshot-0")
		);
		drop(active);
		let listed = omp_tools::checkpoint::CheckpointControl::list_checkpoints(&control, 10)
			.await
			.expect("checkpoint list");
		assert_eq!(listed.first().map(|value| value.label.as_str()), Some("parser-baseline"));

		control.restore_session(7, &omp_dom::Dom::new());
		assert!(control.active_checkpoints.read().is_empty());
	}

	#[test]
	fn skills_enabled_gates_managed_skill_runtime() {
		let ctx = Ctx::new();
		assert!(managed_skills_enabled(&ctx, true));
		crate::SV_SKILLS_ENABLED
			.set(&ctx, false)
			.expect("disable skills");
		assert!(!managed_skills_enabled(&ctx, true));
		assert!(!managed_skills_enabled(&Ctx::new(), false));
	}

	fn worker_declaration_with_schema(schema: &'static [u8]) -> ToolDecl {
		ToolDecl {
			definition: Some(omp_proto::inference::v1::ToolDef {
				name:        "worker".to_owned(),
				description: "worker tool".to_owned(),
				input:       Some(tool_def::Input::JsonSchema(
					omp_proto::inference::v1::tool_def::JsonSchema {
						schema_json: bytes::Bytes::from_static(schema),
						strict:      Some(true),
					},
				)),
			}),
			rev: "1".to_owned(),
			extension_id: "test.extension".to_owned(),
			..ToolDecl::default()
		}
	}

	#[test]
	fn worker_schema_injects_exact_protocol_fields() {
		let declaration = worker_declaration_with_schema(
			br#"{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}"#,
		);
		let spec = worker_spec(&declaration).expect("valid worker schema");
		let schema: JsonValue = serde_json::from_slice(&spec.schema).expect("injected schema");
		assert_eq!(schema["required"], json!(["i", "value"]));
		assert_eq!(schema["properties"]["i"]["type"], "string");
		assert_eq!(schema["properties"]["notrunc"]["type"], "boolean");
	}

	#[test]
	fn worker_schema_rejects_invalid_protocol_shapes() {
		for schema in [
			&b"{"[..],
			br#"{"type":"array"}"#,
			br#"{"type":"object","properties":[]}"#,
			br#"{"type":"object","required":{}}"#,
			br#"{"type":"object","required":[1]}"#,
		] {
			assert!(
				matches!(
					worker_spec(&worker_declaration_with_schema(schema)),
					Err(EnvdError::WorkerProtocolSchema(_))
				),
				"schema should be rejected: {}",
				String::from_utf8_lossy(schema)
			);
		}
	}

	#[tokio::test]
	async fn invocation_edit_repair_is_unavailable_without_connection_capability() {
		let result = with_edit_repair_scope(
			InvocationEditRepairContext::default(),
			invocation_edit_repair(omp_tools::edit::observer::EditRepairPrompt {
				language:         sf!("rust"),
				before:           Str::new_static("fn ok() {}"),
				after:            Str::new_static("fn bad( {}"),
				previous_attempt: None,
			}),
		)
		.await;
		assert_eq!(result, Err(omp_tools::edit::observer::EditRepairError::Unavailable));
	}

	#[tokio::test]
	async fn invocation_edit_models_are_task_local() {
		let first = with_edit_repair_scope(
			InvocationEditRepairContext::new(None, Some(sf!("model-a"))),
			async { invocation_edit_model() },
		);
		let second = with_edit_repair_scope(
			InvocationEditRepairContext::new(None, Some(sf!("model-b"))),
			async { invocation_edit_model() },
		);
		let (first, second) = tokio::join!(first, second);
		assert_eq!(first, Some(sf!("model-a")));
		assert_eq!(second, Some(sf!("model-b")));
		assert_eq!(invocation_edit_model(), None);
	}

	#[test]
	fn default_roster_has_exactly_five_slots_and_keeps_long_tail_devices_live() {
		let inputs = EnvironmentDeclarationInputs {
			read_policy:      omp_tools::read::ReadPolicy::default(),
			selected_edit:    omp_tools::edit::hashline_spec().rev,
			eval_description: Some(sf!("Evaluate code.")),
			shell_snapshot:   Some(omp_tools::shell::ShellPromptSnapshot {
				sibling_tools:       Arc::default(),
				platform:            sf!("linux"),
				command_prefix:      false,
				embedded_builtins:   true,
				devices:             true,
				interceptor_enabled: false,
				interceptor_rules:   Arc::default(),
				acp_routing:         false,
			}),
			memory:           omp_memory::Capabilities::default(),
			managed_skills:   false,
		};
		let mut tool_settings = ToolSettings::default();
		tool_settings
			.enabled
			.insert(Str::new_static("ast_grep"), true);
		let browser_settings = BrowserSettings::default();
		let py_eval_declaration = environment_declarations(
			&tool_settings,
			&browser_settings,
			&inputs,
			true,
			ToolsPolicy::Auto,
		)
		.into_iter()
		.find(|declaration| declaration.spec.name == "py_eval")
		.expect("explicit py_eval declaration");
		assert_eq!(py_eval_declaration.spec, omp_tools::eval::py_eval_spec());

		let declarations = environment_declarations(
			&tool_settings,
			&browser_settings,
			&inputs,
			false,
			ToolsPolicy::Auto,
		);
		assert!(
			declarations
				.iter()
				.all(|declaration| declaration.spec.name != "py_eval"),
			"py_eval must remain absent unless explicitly requested"
		);
		let slots = declarations
			.iter()
			.filter(|declaration| declaration.presentation == Presentation::Slot)
			.map(|declaration| declaration.spec.name.clone())
			.collect::<BTreeSet<_>>();
		assert_eq!(
			slots,
			[sf!("bash"), sf!("edit"), sf!("glob"), sf!("grep"), sf!("read")]
				.into_iter()
				.collect()
		);

		let mut registry = Registry::new();
		for declaration in declarations {
			registry
				.declare_remote(
					declaration.spec,
					declaration.presentation,
					declaration.claims,
					ExecutionMode::Parallel,
				)
				.expect("declare environment tool");
		}
		let registry = Arc::new(registry);
		let catalog = DeviceCatalog::default();
		catalog
			.install_registry(Arc::clone(&registry))
			.expect("install device catalog");
		let live = catalog.registry().expect("live catalog");
		let lsp = live
			.devices()
			.find(|device| device.name.as_str() == "lsp")
			.expect("LSP dynamic device");
		assert_eq!(lsp.rev.n, 3);
		assert_eq!(lsp.schema, omp_tools::lsp::spec().schema.as_ref());
		let devices = live
			.devices()
			.map(|device| device.name.clone())
			.collect::<BTreeSet<_>>();
		for expected in ["ast_edit", "ast_grep", "debug", "eval", "lsp", "write"] {
			assert!(devices.contains(expected), "{expected} must remain reachable through dyn");
		}
	}

	#[test]
	fn registry_loci_and_remote_names_follow_authoritative_metadata() {
		let mut registry = Registry::new();
		register_instrumented(
			&mut registry,
			omp_tools::todo::tool(),
			Presentation::Slot,
			core_claims(),
		)
		.expect("session tool");
		environment_registry(
			&mut registry,
			omp_tools::ast_grep::tool(PathBuf::from(".")),
			Presentation::Slot,
			core_claims(),
		)
		.expect("environment tool");
		let remote = omp_tools::write::spec();
		let expected_description = remote.description.clone();
		registry
			.declare_remote(remote, Presentation::Slot, core_claims(), ExecutionMode::Parallel)
			.expect("remote environment declaration");

		assert_eq!(registry.locus("write").expect("write locus"), ToolLocus::Environment);
		assert_eq!(registry.locus("ast_grep").expect("ast_grep locus"), ToolLocus::Environment);
		assert_eq!(registry.locus("todo").expect("todo locus"), ToolLocus::Session);
		assert_eq!(registry.presentation("write").expect("write presentation"), Presentation::Slot);
		assert_eq!(
			&registry
				.live_spec("write")
				.expect("remote spec")
				.description,
			&expected_description
		);
		let names = environment_tool_names(&registry);
		assert!(names.contains("write"));
		assert!(names.contains("ast_grep"));
		assert!(!names.contains("todo"));
	}
	fn prelude_param(
		name: &str,
		kind: PreludeParamKind,
		default_json: Option<&'static [u8]>,
	) -> omp_proto::toolhost::v1::PreludeParam {
		omp_proto::toolhost::v1::PreludeParam {
			name:         name.to_owned(),
			kind:         kind as i32,
			default_json: default_json.map(bytes::Bytes::from_static),
			annotation:   None,
			props:        None,
		}
	}

	#[test]
	fn tool_call_bash_wire_expands_to_public_hook_shape() {
		let ir = omp_proto::policy::v1::BashIr {
			source: String::from("touch marker"),
			rev: String::from("bashir@3"),
			parser_rev: String::from("qa"),
			parse_ok: true,
			commands: vec![omp_proto::policy::v1::BashCommand {
				name: Some(String::from("touch")),
				..omp_proto::policy::v1::BashCommand::default()
			}],
			..omp_proto::policy::v1::BashIr::default()
		};
		let mut payload = json!({
			"bash": null,
			"__omp_bash_proto": {
				"$bytes": omp_core::base64::encode(&ir.encode_to_vec()),
			},
		});
		assert!(hydrate_tool_call_bash(&mut payload), "hydrate Bash IR");
		assert!(payload.get("__omp_bash_proto").is_none());
		assert_eq!(payload["bash"]["source"], "touch marker");
		assert_eq!(payload["bash"]["commands"][0]["name"], "touch");
	}

	#[test]
	fn lifecycle_observe_excludes_subject_and_reaches_second_active_extension() {
		let payload = json!({"extension": "publisher.subject"});
		let active = ["publisher.subject", "publisher.observer"];
		let recipients = active
			.into_iter()
			.filter(|extension| lifecycle_hook_recipient("extension_load", &payload, extension))
			.collect::<Vec<_>>();
		assert_eq!(recipients, ["publisher.observer"]);
		assert!(!lifecycle_hook_recipient("extension_unload", &payload, "publisher.subject",));
		assert!(lifecycle_hook_recipient("extension_unload", &payload, "publisher.observer",));
	}

	#[test]
	fn lifecycle_phase_vocabulary_is_closed_and_observe_cannot_authorize() {
		for kind in ["deny", "defer"] {
			assert!(hook_decision_is_legal("precheck", Some(kind)));
		}
		assert!(hook_decision_is_legal("transform", Some("modify")));
		assert!(hook_decision_is_legal("review", Some("allow")));
		assert!(hook_decision_is_legal("approval", Some("require_approval")));
		assert!(!hook_decision_is_legal("observe", Some("allow")));
		assert!(!hook_decision_is_legal("precheck", Some("require_approval")));
		assert!(!hook_decision_is_legal("review", Some("modify")));
	}

	#[test]
	fn approval_requirement_retains_authenticated_generation_evidence() {
		let spec = approval_spec_with_provenance(
			json!({
				"title": "Approve",
				"body": "Policy requires approval",
				"subject": "bash",
				"evidence": ["rule=destructive"],
			}),
			"publisher.guard",
			"publisher.extension",
			11,
			19,
		);
		assert_eq!(
			spec["evidence"],
			json!([
				"rule=destructive",
				"hook=publisher.guard extension=publisher.extension host_generation=11 \
				 session_generation=19",
			]),
		);
	}

	#[test]
	fn delegated_composer_decodes_every_merged_approval_requirement() {
		let decision = json!({
			"kind": "require_approvals",
			"specs": [
				{
					"title": "Hook approval",
					"body": "extension policy",
					"subject": "bash",
					"kind": "exec",
					"evidence": ["host_generation=4"],
				},
				{
					"title": "Capability approval",
					"body": "native policy",
					"subject": "network",
					"kind": "network",
				},
			],
			"effective": {"args": {"value": 2}},
		});
		let GateDecision::RequireApprovals { specs, patch } =
			gate_decision_from_json(decision, json!({"args": {}}))
		else {
			panic!("merged approval decision");
		};
		assert_eq!(specs.len(), 2);
		let patch = patch.expect("effective transform");
		assert_eq!(
			serde_json::from_slice::<JsonValue>(patch.args.as_deref().expect("argument patch"))
				.expect("effective JSON"),
			json!({"args": {"value": 2}}),
		);
		assert_eq!(specs[0].evidence, [sf!("host_generation=4")]);
		assert_eq!(specs[1].subject, "network");
	}

	#[test]
	fn session_branch_transform_composes_summarize() {
		let policy = HookEventPolicy {
			revision:    1,
			timeout:     time::Duration::from_secs(1),
			on_failure:  HookFailurePolicy::Defer,
			default:     json!({"kind": "allow"}),
			composition: BTreeMap::from([(sf!("summarize"), HookFieldComposition::Replace)]),
		};
		let mut payload = json!({
			"at_event": 9,
			"keep_event": 9,
			"reason": "user",
			"summarize": false,
		});
		let mut modification = None;
		let decision = json!({"kind": "modify", "patch": {"summarize": true}});
		compose_hook_modify(
			"session_branch",
			&policy,
			&mut payload,
			&mut modification,
			decision.as_object().expect("modify object"),
		)
		.expect("compose branch summarize");
		assert_eq!(payload["summarize"], true);
		assert_eq!(
			modification
				.as_ref()
				.and_then(|value| value.get("patch"))
				.and_then(JsonValue::as_object)
				.and_then(|patch| patch.get("summarize")),
			Some(&JsonValue::Bool(true)),
		);
	}

	#[test]
	fn tool_call_transform_patches_effective_arguments() {
		let policy = HookEventPolicy {
			revision:    1,
			timeout:     time::Duration::from_secs(1),
			on_failure:  HookFailurePolicy::Deny,
			default:     json!({"kind": "allow"}),
			composition: BTreeMap::from([
				(sf!("target"), HookFieldComposition::Replace),
				(sf!("args"), HookFieldComposition::Replace),
				(sf!("cwd"), HookFieldComposition::Replace),
				(sf!("deadline"), HookFieldComposition::Replace),
			]),
		};
		let mut payload = json!({
			"target": {"kind": "core", "name": "bash", "rev": "core.1", "args": {
				"command": "printf original"
			}},
			"args": {"command": "printf original"},
			"cwd": ".",
			"deadline": null,
		});
		let mut modification = None;
		let decision = json!({"kind": "modify", "patch": {"command": "printf modified"}});
		compose_hook_modify(
			"tool_call",
			&policy,
			&mut payload,
			&mut modification,
			decision.as_object().expect("modify object"),
		)
		.expect("compose tool arguments");
		assert_eq!(payload["args"]["command"], "printf modified");
		assert_eq!(
			modification
				.as_ref()
				.and_then(|value| value.get("patch"))
				.and_then(JsonValue::as_object)
				.and_then(|patch| patch.get("args"))
				.and_then(JsonValue::as_object)
				.and_then(|args| args.get("command")),
			Some(&JsonValue::String(String::from("printf modified"))),
		);
	}

	#[test]
	fn domain_replies_compose_as_transforms_or_nothing() {
		assert_eq!(domain_reply_decision(JsonValue::Null).expect("none"), None);
		assert_eq!(
			domain_reply_decision(json!({"prune": [{"ids": ["3"]}], "note": "trim"})).expect("patch"),
			Some(json!({"kind": "modify", "patch": {"prune": [{"ids": ["3"]}], "note": "trim"}}))
		);
		assert_eq!(
			domain_reply_decision(json!({"kind": "deny", "reason": "no"})).expect("decision"),
			Some(json!({"kind": "deny", "reason": "no"}))
		);
		assert!(domain_reply_decision(json!("continue")).is_err());
	}

	#[test]
	fn hook_deny_policy_fails_closed_on_callback_error() {
		let decision = hook_callback_failure(
			HookFailurePolicy::Deny,
			ControlProtocolError::new("CallbackUnavailable", "extension callback failed"),
		)
		.expect("DENY policy must produce a terminal denial");
		assert_eq!(
			decision,
			serde_json::json!({
				"kind": "deny",
				"reason": "extension callback failed",
				"fatal": false,
				"code": "CallbackUnavailable",
			})
		);
		assert!(
			hook_callback_failure(
				HookFailurePolicy::Defer,
				ControlProtocolError::new("CallbackUnavailable", "extension callback failed"),
			)
			.is_none()
		);
	}
	#[test]
	fn mcp_filter_is_anchored_and_queue_drops_oldest() {
		let servers = [sf!("github")];
		let methods = [sf!("notifications/*"), sf!("acme/*")];
		assert!(mcp_filter_matches(
			Some(&servers),
			&methods,
			"github",
			"notifications/tools/list_changed",
		));
		assert!(mcp_filter_matches(Some(&servers), &methods, "github", "acme/custom"));
		assert!(!mcp_filter_matches(
			Some(&servers),
			&methods,
			"linear",
			"notifications/tools/list_changed",
		));
		assert!(!mcp_filter_matches(Some(&servers), &methods, "github", "other/update",));
		assert!(anchored_glob_matches("notifications/*", "notifications/tools/list_changed"));
		assert!(anchored_glob_matches("acme/??", "acme/ok"));
		assert!(!anchored_glob_matches("notifications/*", "prefix/notifications/update"));
		assert!(!anchored_glob_matches("acme/??", "acme/long"));

		let mut queue = McpDeliveryQueue {
			pending:         VecDeque::new(),
			running_servers: BTreeSet::new(),
			dropped:         0,
		};
		for sequence in 1..=102 {
			queue.push(McpQueuedDelivery {
				notification:  McpHookNotification {
					server: sf!("github"),
					method: sf!("notifications/update"),
					params: JsonValue::Null,
					sequence,
				},
				subscriptions: Vec::new(),
			});
		}
		assert_eq!(queue.pending.len(), MCP_HOOK_QUEUE_CAPACITY);
		assert_eq!(queue.dropped, 2);
		assert_eq!(
			queue
				.pending
				.front()
				.map(|delivery| delivery.notification.sequence),
			Some(3)
		);
		assert_eq!(
			queue
				.pending
				.back()
				.map(|delivery| delivery.notification.sequence),
			Some(102)
		);
	}

	#[test]
	fn extension_usage_projection_is_typed_and_rejects_malformed_reports() {
		let observed = time::UNIX_EPOCH + time::Duration::from_secs(10);
		let report = decode_extension_usage(
			json!({
				"plan": "extension",
				"windows": [{
					"id": "requests",
					"used": 2,
					"limit": 10,
					"unit": "requests",
					"resets_at_ms": 20_000,
				}],
			}),
			observed,
		)
		.expect("typed extension usage report");
		assert_eq!(report.plan.as_deref(), Some("extension"));
		assert_eq!(report.windows[0].amount.consumed.map(|value| value.units), Some(2));
		assert_eq!(report.windows[0].amount.remaining.map(|value| value.units), Some(8));
		assert!(matches!(
			decode_extension_usage(json!({"windows": [{"id": "bad", "unit": "secret"}]}), observed),
			Err(UsageFetchError::Protocol),
		));
	}

	#[test]
	fn worker_tools_never_expand_the_auto_slot_roster() {
		assert_eq!(long_tail_presentation(ToolsPolicy::Auto), Presentation::Device);
		assert_eq!(long_tail_presentation(ToolsPolicy::ToolOnly), Presentation::Slot);
	}

	#[test]
	fn worker_constraint_preserves_registration_fallback() {
		let declaration = ToolDecl {
			constraint: Some(omp_proto::toolhost::v1::ToolConstraint {
				kind: Some(tool_constraint::Kind::Schema(omp_proto::toolhost::v1::SchemaConstraint {
					priority:       73,
					on_unsupported: omp_proto::inference::v1::Fallback::Error as i32,
				})),
			}),
			..ToolDecl::default()
		};
		assert_eq!(worker_constraint(&declaration).expect("constraint lowers"), Constraint::Schema {
			priority:       73,
			on_unsupported: omp_proto::inference::v1::Fallback::Error,
		});
	}

	#[test]
	fn prelude_parameter_metadata_rejects_invalid_signatures() {
		let cases = [
			(
				vec![
					prelude_param("value", PreludeParamKind::PositionalOrKeyword, None),
					prelude_param("value", PreludeParamKind::KeywordOnly, None),
				],
				"more than once",
			),
			(
				vec![
					prelude_param("mode", PreludeParamKind::KeywordOnly, None),
					prelude_param("value", PreludeParamKind::PositionalOrKeyword, None),
				],
				"after a keyword-only parameter",
			),
			(
				vec![
					prelude_param("optional", PreludeParamKind::PositionalOrKeyword, Some(b"null")),
					prelude_param("required", PreludeParamKind::PositionalOrKeyword, None),
				],
				"after a default",
			),
			(
				vec![prelude_param("not valid", PreludeParamKind::PositionalOrKeyword, None)],
				"invalid name",
			),
			(vec![prelude_param("é", PreludeParamKind::PositionalOrKeyword, None)], "invalid name"),
			(
				vec![prelude_param("class", PreludeParamKind::PositionalOrKeyword, None)],
				"Python keyword",
			),
		];
		for (params, expected) in cases {
			let declaration = ToolDecl { prelude_params: params, ..ToolDecl::default() };
			let error = prelude_params("contract_helper", &declaration)
				.expect_err("invalid prelude signature was accepted");
			assert!(error.to_string().contains(expected), "{error}");
		}
	}
}
