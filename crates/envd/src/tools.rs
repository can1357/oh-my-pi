//! Production built-in tool registry assembly.

use std::{
	collections::{BTreeMap, BTreeSet},
	env,
	env::consts,
	future::Future,
	path::{Path, PathBuf},
	sync::{
		Arc, LazyLock,
		atomic::{AtomicU64, Ordering},
	},
	time,
};

use omp_agent::control;
use omp_catalog::{ModelKey, ProviderId, snapshot::Catalog};
use omp_core::{Duration, ExposeSecret as _, Hash32, InvocationPhase, LifecyclePhase, Str, sf};
use omp_env::EnvClient;
use omp_inference::{
	answer::{
		UsageAccountMetadata, UsageAmount, UsageQuantity, UsageUnit, UsageWindow, UsageWindowKind,
	},
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
		UsageFetcherRegistry,
	},
	receipt::UsageSource,
};
use omp_proto::{
	inference::{v1, v1::tool_def},
	prost::Message as _,
	thread::v1::Blob,
	toolhost::v1::{
		GrammarSyntax as WorkerGrammarSyntax, PreludeParamKind, ToolDecl, tool_constraint,
	},
};
use omp_settings::{
	BrowserSettings,
	manager::{SettingsManager, SettingsPaths},
};
use omp_storage::{github_cache::GithubCache, telemetry_index::TelemetryIndex};
use omp_tool::{
	AvailabilityDelta, Claims, Constraint, GrammarSyntax, LeafOwner, LeafReplacementError,
	LeafReplacementRegistry, LeafVersion, Precedence, Presentation, Registry, RegistryLeaf, Rev,
	Tool, ToolSpec, ToolsPolicy,
};
use omp_tools::{
	ask::PresenterSlot,
	checkpoint,
	device::{DeviceCatalog, flatten_slots, xd_enabled},
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

use super::{
	EnvdError,
	blobs::BlobHost,
	computer::ComputerSessionHost,
	docs::{DocumentHost, ResourceMutationServices},
	document_cache,
	eval::{
		PRELUDE_PYTHON_KEYWORDS, PRELUDE_RESERVED_NAMES, PreludeHelper, PreludeInvoker,
		PreludeParamStub, PreludeTable, ProcessEvalExec, SessionBridgeHost,
	},
	exec::ExecHost,
	exec_settings::{AcpRouting, AcpSettings, ShellSettings},
	exthost::{
		CallbackConcurrency, ExtensionManifest,
		control::{
			ControlAuthority, ControlAuthorityFactory, ControlCompositionError,
			ControlConnectionIdentity, ControlDispatch, ControlEffect, ControlInvocationAuthority,
			ControlProtocolError, ControlRequestContext,
		},
		dispatch::{CallbackDispatcher, EventDeadline, NestedCallbackDispatcher},
	},
	github::GithubService,
	managed_skills::ManagedSkills,
	mcp::McpService,
	media_devices,
	memory::ReflectionBridgeHost,
	search_backend::SearchBridgeHost,
	ssh::{HostStore, SshService},
	tool_debug::DocumentDebugControl,
	tool_document::SessionReadBlobs,
	tool_lsp::DocumentLspControl,
	tool_read_sources::ReadSourceAdapter,
	tool_search::WorkspaceSearchAdapter,
	tool_settings::ToolSettings,
	tool_shell::{AcpExecSlot, ShellExecHost},
	tool_url::{UrlResolver, production_url_resolvers},
	vault::VaultService,
	worker::{
		ExtHostSupervisor, SealedRegistryEvidence, SealedRegistryEvidenceError,
		seal_registry_evidence,
	},
	workspace::WorkspaceHost,
	xd::XdHost,
};
use crate::{
	browser_daemon::BrowserDaemon, github_url::GithubCredentialBridge, host_settings::HostSettings,
};

tokio::task_local! {
	static PTY_DENIED: bool;
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
	) -> Arc<dyn omp_inference::auth::command::CommandCredentialExecutor>;
}
/// Restricted registration capability for caller-supplied dynamic tool
/// factories.
pub struct DynamicToolRegistrar<'registry> {
	registry: &'registry mut Registry,
}

impl DynamicToolRegistrar<'_> {
	/// Registers one factory tool unless it claims the reserved core identity.
	pub fn register<T>(
		&mut self,
		tool: T,
		presentation: Presentation,
		claims: Claims,
	) -> Result<(), omp_tool::RegistryError>
	where
		T: Tool,
	{
		if claims.claimant == "omp/core" {
			return Err(omp_tool::RegistryError::ReservedClaimant { name: tool.spec().name.clone() });
		}
		self.registry.register(tool, presentation, claims)
	}
}

/// Registers host-owned tools before registry freeze, then binds their live
/// Environment client after transport composition.
pub trait DynamicToolFactory: Send + Sync + 'static {
	/// Registers every declaration-backed tool using factory-retained slots.
	fn register(
		&self,
		registrar: &mut DynamicToolRegistrar<'_>,
	) -> Result<(), omp_tool::RegistryError>;
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
		Self { register: Box::new(move |registry| registry.register(tool, presentation, claims)) }
	}

	fn register(self, registry: &mut Registry) -> Result<(), omp_tool::RegistryError> {
		(self.register)(registry)
	}
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
}

impl RegistryControlFactory {
	/// Creates the registry owner from deployment-authenticated manifests.
	pub fn new(manifests: BTreeMap<(Str, Str, Str), ExtensionManifest>) -> Arc<Self> {
		Arc::new(Self {
			manifests: Arc::new(manifests),
			evidence:  Arc::new(RwLock::new(BTreeMap::new())),
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
		let evidence = Arc::new(
			seal_registry_evidence(context, manifest, payload).map_err(registry_evidence_error)?,
		);
		let connection = connection_key(&context.connection);
		let mut published = self.evidence.write();
		if let Some(current) = published.get(&connection) {
			if current.tools != evidence.tools || current.hooks != evidence.hooks {
				return Err(ControlProtocolError::new(
					"RegistryConflict",
					"sealed registry changed within one host generation",
				));
			}
			return Ok(Arc::clone(current));
		}
		published
			.retain(|key, _| key.0 != connection.0 || key.1 != connection.1 || key.2 != connection.2);
		published.insert(connection, Arc::clone(&evidence));
		Ok(evidence)
	}
}

fn registry_evidence_error(error: SealedRegistryEvidenceError) -> ControlProtocolError {
	let code = match error {
		SealedRegistryEvidenceError::Identity => "RegistryUnauthorized",
		SealedRegistryEvidenceError::ManifestDrift
		| SealedRegistryEvidenceError::ExecutableDrift
		| SealedRegistryEvidenceError::Duplicate
		| SealedRegistryEvidenceError::SourceModule => "RegistryDrift",
		SealedRegistryEvidenceError::Nested => "InvalidPhase",
		SealedRegistryEvidenceError::Malformed(_) => "RegistryMalformed",
	};
	ControlProtocolError::new(code, Str::from(error.to_string()))
}

impl ControlAuthorityFactory for RegistryControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		if !self.manifests.contains_key(&(
			identity.layer.clone(),
			identity.tier.clone(),
			identity.extension.clone(),
		)) {
			return Err(ControlCompositionError::unavailable(
				"registry",
				"authenticated extension has no deployment manifest",
			));
		}
		Ok(Arc::new(BoundRegistryControl { identity, owner: self.clone() }))
	}
}

struct BoundRegistryControl {
	identity: Arc<ControlConnectionIdentity>,
	owner:    RegistryControlFactory,
}

#[async_trait::async_trait]
impl ControlAuthority for BoundRegistryControl {
	fn handles(&self, _operation: &str) -> bool {
		false
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &JsonMap<String, JsonValue>,
	) -> Result<(), ControlProtocolError> {
		if same_connection(&self.identity, &context.connection) {
			Ok(())
		} else {
			Err(stale_connection())
		}
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		_arguments: JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &JsonMap::new())?;
		Err(ControlProtocolError::new(
			"InvalidOperation",
			"registry publications are effects, not request operations",
		))
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.authorize(&context, "omp.registry.publish", &JsonMap::new())?;
		let ControlEffect::Registry(payload) = effect else {
			return Err(ControlProtocolError::new(
				"InvalidEffect",
				"registry owner accepts only Registry effects",
			));
		};
		self.owner.publish(&context, &payload)?;
		Ok(())
	}
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
		let place = required_string(parent, "place")?;
		let _registration = evidence
			.tools
			.iter()
			.find(|tool| {
				tool.name == parent_name
					&& tool.family == family
					&& tool.rev == rev
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
	/// Event policy frozen with the Python registry declaration.
	pub event_policy: HookEventPolicy,
}
#[derive(Clone)]
struct ExtensionUsageFetcher {
	provider:    ProviderId,
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
						settings:          JsonMap::new(),
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
pub struct HookControlFactory {
	registries:     Arc<RegistryControlFactory>,
	dispatcher:     Arc<dyn CallbackDispatcher>,
	callbacks:      Arc<NestedCallbackDispatcher>,
	policies:       Arc<RwLock<BTreeMap<Str, HookEventPolicy>>>,
	subscriptions:  Arc<RwLock<BTreeMap<ControlConnectionKey, Vec<HookSubscription>>>>,
	usage_fetchers: UsageFetcherRegistry,
}

impl HookControlFactory {
	/// Creates the composed hook owner over the live callback dispatcher.
	pub fn new(
		registries: Arc<RegistryControlFactory>,
		dispatcher: Arc<dyn CallbackDispatcher>,
		policies: BTreeMap<Str, HookEventPolicy>,
	) -> Arc<Self> {
		Arc::new(Self {
			registries,
			dispatcher: Arc::clone(&dispatcher),
			callbacks: Arc::new(NestedCallbackDispatcher::new(dispatcher)),
			policies: Arc::new(RwLock::new(policies)),
			subscriptions: Arc::new(RwLock::new(BTreeMap::new())),
			usage_fetchers: UsageFetcherRegistry::default(),
		})
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
			let session = evidence
				.session
				.clone()
				.unwrap_or_else(|| row.identity.extension.clone());
			for provider in row.providers.as_deref().unwrap_or_default() {
				fetchers.register_runtime(
					usage_registration_id(row),
					Arc::new(ExtensionUsageFetcher {
						provider:    ProviderId::from(provider.clone()),
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
		Ok(())
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
		let mut rows = self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.filter(|row| {
				row.event == event
					&& row.identity.session_generation == context.connection.session_generation
			})
			.cloned()
			.collect::<Vec<_>>();
		rows.sort_by(|left, right| {
			hook_phase_rank(&left.phase)
				.cmp(&hook_phase_rank(&right.phase))
				.then_with(|| left.order.cmp(&right.order))
				.then_with(|| left.name.cmp(&right.name))
				.then_with(|| left.identity.extension.cmp(&right.identity.extension))
		});
		let mut modification: Option<JsonMap<String, JsonValue>> = None;
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
					row.timeout.unwrap_or(policy.timeout),
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
			let decision = result.as_object().ok_or_else(|| {
				ControlProtocolError::new(
					"HookContractError",
					"hook callback returned a non-object decision",
				)
			})?;
			match decision.get("kind").and_then(JsonValue::as_str) {
				Some("deny" | "require_approval") => return Ok(result),
				Some("allow" | "defer") => {},
				Some("modify") => {
					compose_hook_modify(&policy, &mut payload, &mut modification, decision)?;
				},
				_ => {
					return Err(ControlProtocolError::new(
						"HookContractError",
						"hook callback returned an unknown decision kind",
					));
				},
			}
		}
		Ok(modification.map_or_else(|| policy.default.clone(), JsonValue::Object))
	}
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

fn compose_hook_modify(
	policy: &HookEventPolicy,
	payload: &mut JsonValue,
	modification: &mut Option<JsonMap<String, JsonValue>>,
	decision: &JsonMap<String, JsonValue>,
) -> Result<(), ControlProtocolError> {
	let output = modification.get_or_insert_with(|| {
		JsonMap::from_iter([(String::from("kind"), JsonValue::String(String::from("modify")))])
	});
	for field in ["target", "args", "reason"] {
		if let Some(value) = decision.get(field).filter(|value| !value.is_null()) {
			output.insert(String::from(field), value.clone());
		}
	}
	let patch = decision
		.get("patch")
		.and_then(JsonValue::as_object)
		.cloned()
		.unwrap_or_default();
	let unset = decision
		.get("unset")
		.and_then(JsonValue::as_array)
		.cloned()
		.unwrap_or_default();
	let payload_object = payload.as_object_mut().ok_or_else(|| {
		ControlProtocolError::new("HookContractError", "hook modification requires an object payload")
	})?;
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
				JsonValue::Array(
					current
						.into_iter()
						.filter(|item| requested.contains(item))
						.collect(),
				)
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

/// Deferred start of background telemetry delivery.
///
/// Registry assembly itself must not spawn the handle-less upload loop: both
/// server construction paths continue with the fallible control-host
/// activation after assembly, and a failed activation returns from
/// construction while a spawned loop would keep retrying against the
/// telemetry index and the credential bridge. Composition therefore returns
/// the start instead of performing it, and the construction path runs it
/// only after that final fallible step has succeeded.
pub struct TelemetryUploadStart {
	upload:      Option<Arc<dyn TelemetryUpload>>,
	telemetry:   Arc<TelemetryIndex>,
	credentials: Arc<GithubCredentialBridge>,
}

impl TelemetryUploadStart {
	fn new(
		upload: Option<Arc<dyn TelemetryUpload>>,
		telemetry: &Arc<TelemetryIndex>,
		credentials: &Arc<GithubCredentialBridge>,
	) -> Self {
		Self { upload, telemetry: Arc::clone(telemetry), credentials: Arc::clone(credentials) }
	}

	/// Starts background delivery exactly once, consuming the deferred start.
	pub(crate) fn start(self) {
		if let Some(upload) = self.upload {
			upload.start(self.telemetry, self.credentials);
		}
	}
}

/// Runs one native tool stream under its authenticated invocation restrictions.
pub(super) async fn with_invocation_scope<T>(
	pty_denied: bool,
	future: impl Future<Output = T>,
) -> T {
	PTY_DENIED.scope(pty_denied, future).await
}

/// Returns whether the current authenticated invocation denies PTY allocation.
pub(super) fn pty_denied() -> bool {
	PTY_DENIED.try_with(|denied| *denied).unwrap_or(false)
}

fn configured_model_edit_revision(
	data_dir: &Path,
	project_root: &Path,
) -> Result<Option<Rev>, EnvdError> {
	let manager = SettingsManager::open(SettingsPaths::discover(data_dir, Some(project_root)))
		.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
	let snapshot = manager.snapshot();
	let settings = snapshot
		.project::<HostSettings>()
		.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
	let Some(selector) = settings.get().default_model.clone() else {
		return Ok(None);
	};
	let catalog = Catalog::embedded();
	let model = catalog
		.model(ModelKey::from_ref(&selector))
		.or_else(|| catalog.resolve_alias(&selector));
	let Some(revision) = model.and_then(|model| model.edit_revision.as_deref()) else {
		return Ok(None);
	};
	revision
		.parse::<Rev>()
		.map(Some)
		.map_err(|error| EnvdError::EditDialect(error.to_string().into()))
}

fn configured_model_identity(
	data_dir: &Path,
	project_root: &Path,
) -> Result<Option<Str>, EnvdError> {
	let manager = SettingsManager::open(SettingsPaths::discover(data_dir, Some(project_root)))
		.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
	let snapshot = manager.snapshot();
	let settings = snapshot
		.project::<HostSettings>()
		.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
	Ok(settings.get().default_model.as_deref().map(Str::new))
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
	daemon_process_client: Option<EnvClient>,
	state_dir: &Path,
	session_id: &str,
	github_cache: Arc<GithubCache>,
	mcp: &Arc<McpService>,
	workspace: &WorkspaceHost,
	memory: &Arc<omp_memory::MemoryRuntime>,
	telemetry: &Arc<TelemetryIndex>,
	root_uri: &Str,
	workers: &ExtHostSupervisor,
	interrupt_grace: Duration,
	tool_settings: &ToolSettings,
	browser_settings: &BrowserSettings,
	shell_settings: &ShellSettings,
	acp_settings: &AcpSettings,
	acp_exec: AcpExecSlot,
	autolearn_settings: &omp_memory::config::AutolearnSettings,
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
		TelemetryUploadStart,
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
		telemetry_upload,
		ask_presenter,
		content,
	} = bridges;
	let previews = StagedProposalRegistry::new();
	registry.reject_reserved_claims()?;
	let ask_presenter = PresenterSlot::new(
		ask_presenter.unwrap_or_else(|| Arc::new(omp_tools::ask::HeadlessPresenter)),
	);

	let search_bridge = Arc::new(SearchBridgeHost::new(search));
	registry.protect_user_visible_core(["browser"]);
	if browser_settings.enabled && tool_settings.enabled("browser") {
		let browser_daemon = BrowserDaemon::start(blobs.clone(), *browser_settings);
		registry.register(
			omp_tools::browser::tool(browser_daemon),
			Presentation::Device,
			builtin_device_claims(),
		)?;
	}
	let computer = ComputerSessionHost::new(blobs.clone());
	registry.register(
		omp_tools::computer::tool(computer),
		Presentation::Device,
		builtin_device_claims(),
	)?;
	// The dynamic composition slots (dynamic_tools, factories) run before the
	// final protect_live_claims sweep, so `computer` must be reserved at its
	// registration seam or a factory could shadow the core device.
	registry.protect_core_claims(["computer"]);
	for device in [
		media_devices::image_gen(
			Arc::clone(&search_bridge),
			blobs.clone(),
			workspace.root().to_path_buf(),
		),
		media_devices::tts(Arc::clone(&search_bridge), blobs.clone(), workspace.root().to_path_buf()),
	] {
		registry.register(device, Presentation::Device, builtin_device_claims())?;
	}
	registry.register(
		media_devices::report_issue(Arc::clone(telemetry)),
		Presentation::Device,
		builtin_device_claims(),
	)?;
	registry.unlist_from_roster("report_issue")?;
	let reflection_bridge = Arc::new(ReflectionBridgeHost::new());
	let memory_capabilities = memory.capabilities();
	registry.protect_user_visible_core(["retain"]);
	if memory_capabilities.writable {
		registry.register(
			omp_tools::memory::retain_tool(Arc::clone(memory)),
			Presentation::Device,
			builtin_device_claims(),
		)?;
	}
	registry.protect_user_visible_core(["recall", "reflect"]);
	if memory_capabilities.searchable {
		registry.register(
			omp_tools::memory::recall_tool(Arc::clone(memory)),
			Presentation::Device,
			builtin_device_claims(),
		)?;
		registry.register(
			omp_tools::memory::reflect_tool(Arc::clone(memory), Arc::clone(&reflection_bridge)),
			Presentation::Device,
			builtin_device_claims(),
		)?;
	}
	registry.protect_user_visible_core(["memory_edit"]);
	if memory_capabilities.editable {
		registry.register(
			omp_tools::memory_edit::tool(Arc::clone(memory)),
			Presentation::Device,
			builtin_device_claims(),
		)?;
	}
	registry.protect_core_claims(["manage_skill", "learn"]);
	if autolearn_settings.enabled {
		if let Some(managed_skills_root) = content.managed_skills_root {
			let authority = Arc::new(ManagedSkills::new(managed_skills_root, content.authored_skills));
			registry.register(
				omp_tools::manage_skill::tool(Arc::clone(&authority)),
				Presentation::Device,
				builtin_device_claims(),
			)?;
			registry.unlist_from_roster("manage_skill")?;
			if memory_capabilities.writable {
				registry.register(
					omp_tools::learn::tool(Arc::clone(memory), authority),
					Presentation::Device,
					builtin_device_claims(),
				)?;
				registry.unlist_from_roster("learn")?;
			}
		}
	}
	let github_credentials = Arc::new(GithubCredentialBridge::new());
	let github = GithubService::new(
		workspace.root().to_path_buf(),
		state_dir,
		Arc::clone(&github_credentials),
	);
	registry.register(
		omp_tools::github::tool(github),
		Presentation::Device,
		builtin_device_claims(),
	)?;
	let ssh = SshService::new(
		HostStore::load(&state_dir.join("ssh/hosts.toml"))
			.map_err(|error| EnvdError::State(Str::new(error.to_string())))?,
	);
	let vault = VaultService::load(&state_dir.join("vaults.toml"))
		.map_err(|error| EnvdError::State(Str::new(error.to_string())))?;
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
	let local_root =
		crate::tool_url::local::session_local_root(&state_dir.join("sessions"), session_id);
	let resolvers = production_url_resolvers(
		Arc::clone(&conflicts),
		blobs.store().clone(),
		session_id,
		local_root,
		workspace.root().to_path_buf(),
		github_cache,
		Arc::clone(&github_credentials),
		url_resolvers,
		host_resources,
		Arc::clone(mcp),
		ssh,
		vault,
	);
	let environment_edit_dialect = env::var("OMP_EDIT_DIALECT").ok();
	let force_hashline = env::var_os("OMP_STRICT_EDIT_MODE").is_some();
	let model_edit_revision = configured_model_edit_revision(state_dir, workspace.root())?;
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
		},
	);
	registry.protect_user_visible_core(["read"]);
	if tool_settings.enabled("read") {
		registry.register(read, Presentation::Slot, core_claims())?;
	}
	let fetch = omp_tools::fetch::tool(read_sources.clone());
	registry.protect_user_visible_core(["fetch"]);
	if tool_settings.enabled("fetch") && tool_settings.fetch_enabled {
		registry.register(fetch, Presentation::Slot, core_claims())?;
	}
	registry.protect_user_visible_core(["web_search"]);
	if tool_settings.enabled("web_search") {
		let web_search = omp_tools::web_search::tool(Arc::clone(&search_bridge));
		registry.register(web_search, Presentation::Slot, core_claims())?;
	}
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
				.or(configured_model_identity(state_dir, workspace.root())?)
				.unwrap_or_else(|| sf!("unknown")),
			..omp_tools::edit::observer::EditBlackboxConfig::default()
		},
		tool_settings
			.edit_auto_repair
			.then_some(edit_repair)
			.flatten(),
	);
	let mut hashline_edit = Some(omp_tools::edit::tool_with_observer(
		documents.clone(),
		blobs.clone(),
		tool_settings.format_policy,
		edit_observer.clone(),
		tool_settings.edit_guard_generated,
	));
	let mut replace_edit = Some(omp_tools::edit::replace_tool_with_observer(
		documents.clone(),
		tool_settings.format_policy,
		edit_observer.clone(),
		tool_settings.edit_guard_generated,
	));
	let mut patch_edit = Some(omp_tools::edit::patch_tool_with_observer(
		documents.clone(),
		tool_settings.format_policy,
		edit_observer.clone(),
		tool_settings.edit_guard_generated,
	));
	let mut apply_patch_edit = Some(omp_tools::edit::apply_patch_tool_with_observer(
		documents.clone(),
		tool_settings.format_policy,
		edit_observer.clone(),
		tool_settings.edit_guard_generated,
	));
	let mut sloppy_edit = Some(omp_tools::edit::sloppy_tool_with_observer(
		documents.clone(),
		tool_settings.format_policy,
		edit_observer,
		tool_settings.edit_guard_generated,
	));
	registry.protect_user_visible_core(["edit"]);
	if tool_settings.enabled("edit") {
		let mut edits = [
			(
				hashline_edit
					.as_ref()
					.expect("constructed")
					.spec()
					.identity(),
				0_u8,
			),
			(
				replace_edit
					.as_ref()
					.expect("constructed")
					.spec()
					.identity(),
				1,
			),
			(patch_edit.as_ref().expect("constructed").spec().identity(), 2),
			(
				apply_patch_edit
					.as_ref()
					.expect("constructed")
					.spec()
					.identity(),
				3,
			),
			(sloppy_edit.as_ref().expect("constructed").spec().identity(), 4),
		];
		edits.sort_by_key(|(identity, _)| identity.rev == selected_edit);
		for (_, index) in edits {
			match index {
				0 => registry.register(
					hashline_edit.take().expect("once"),
					Presentation::Slot,
					core_claims(),
				)?,
				1 => registry.register(
					replace_edit.take().expect("once"),
					Presentation::Slot,
					core_claims(),
				)?,
				2 => registry.register(
					patch_edit.take().expect("once"),
					Presentation::Slot,
					core_claims(),
				)?,
				3 => registry.register(
					apply_patch_edit.take().expect("once"),
					Presentation::Slot,
					core_claims(),
				)?,
				4 => registry.register(
					sloppy_edit.take().expect("once"),
					Presentation::Slot,
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
	registry.protect_user_visible_core(["write"]);
	if tool_settings.enabled("write") {
		registry.register(write, Presentation::Slot, core_claims())?;
	}
	registry.protect_user_visible_core(["lsp"]);
	if tool_settings.enabled("lsp") {
		let maximum = tool_settings
			.max_timeout
			.and_then(|duration| duration.to_std().ok())
			.unwrap_or_else(|| time::Duration::from_secs(300));
		registry.register(
			omp_tools::lsp::tool(DocumentLspControl::new(documents.clone(), exec.clone()), maximum),
			Presentation::Slot,
			core_claims(),
		)?;
	}
	registry.protect_user_visible_core(["debug"]);
	if tool_settings.enabled("debug") {
		let maximum = tool_settings
			.max_timeout
			.and_then(|duration| duration.to_std().ok())
			.unwrap_or_else(|| time::Duration::from_secs(300));
		registry.register(
			omp_tools::debug::tool(DocumentDebugControl::new(documents.clone()), maximum),
			Presentation::Slot,
			core_claims(),
		)?;
	}
	let search = WorkspaceSearchAdapter::new(
		workspace.clone(),
		documents.clone(),
		read_sources.clone(),
		Arc::clone(&resolvers),
	);
	let grep = omp_tools::grep::tool(search.clone(), read_blobs.clone());
	registry.protect_user_visible_core(["grep"]);
	if tool_settings.enabled("grep") {
		registry.register(grep, Presentation::Slot, core_claims())?;
	}
	let glob = omp_tools::glob::tool(search, read_blobs);
	registry.protect_user_visible_core(["glob"]);
	if tool_settings.enabled("glob") {
		registry.register(glob, Presentation::Slot, core_claims())?;
	}
	registry.protect_user_visible_core(["ast_grep"]);
	if tool_settings.enabled("ast_grep") {
		registry.register(
			omp_tools::ast_grep::tool(workspace.root().to_path_buf()),
			Presentation::Slot,
			core_claims(),
		)?;
	}
	registry.protect_user_visible_core(["ast_edit"]);
	if tool_settings.enabled("ast_edit") {
		registry.register(
			omp_tools::ast_edit::tool(workspace.root().to_path_buf(), previews.clone()),
			Presentation::Slot,
			core_claims(),
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
	registry.protect_user_visible_core(["eval"]);
	registry.protect_core_claims(["task"]);
	if tool_settings.enabled("eval") {
		match preflight_python_eval(
			Arc::clone(&eval_host),
			interrupt_grace,
			blobs.clone(),
			tool_settings
				.eval_interpreters
				.get("py")
				.map(|path| PathBuf::from(path.as_str())),
		) {
			Ok(eval_exec) => {
				let mut task_snapshot = TaskDescriptionSnapshot {
					helpers: &helper_docs,
					..TaskDescriptionSnapshot::standard()
				};
				if !tool_settings.enabled("task") {
					task_snapshot.agents = &[];
				}
				let (eval_tool, control) =
					omp_tools::eval::eval_controlled_with_task_snapshot(eval_exec, task_snapshot);
				registry.register(eval_tool, Presentation::Slot, core_claims())?;
				eval_control = control;
			},
			Err(error) => {
				tracing::warn!(
					error = %error,
					"eval omitted because CPython is unreachable; run `just setup-python` and restart OMP"
				);
			},
		}
	}
	registry.protect_user_visible_core(["todo"]);
	if tool_settings.enabled("todo") {
		registry.register(omp_tools::todo::tool(), Presentation::Slot, core_claims())?;
	}
	registry.protect_user_visible_core(["ask"]);
	if tool_settings.enabled("ask") {
		registry.register(
			omp_tools::ask::tool_with_vocalizer(
				Arc::new(ask_presenter.clone()),
				media_devices::ask_vocalizer(Arc::clone(&search_bridge)),
			),
			Presentation::Slot,
			core_claims(),
		)?;
	}
	registry.protect_core_claims(["think"]);
	if tool_settings.enabled("think") {
		registry.register(omp_tools::think::tool(), Presentation::Slot, core_claims())?;
		registry.unlist_from_roster("think")?;
	}
	registry.protect_core_claims(["goal"]);
	if let Some(goal_control) = goal_control {
		registry.register(
			omp_tools::goal::tool(GoalControlAdapter(goal_control)),
			Presentation::Hidden,
			core_claims(),
		)?;
	}
	registry.protect_core_claims(["yield"]);
	if tool_settings.enabled("yield") {
		// Children finalize through `yield`; the top-level agent never
		// advertises it, so registration is selection-only (`Hidden`).
		registry.register(omp_tools::yield_tool::tool(), Presentation::Hidden, core_claims())?;
	}
	let checkpoint_control = AgentCheckpointControl::default();
	let (checkpoint, rewind) = omp_tools::checkpoint::tools(checkpoint_control.clone());
	registry.protect_user_visible_core(["checkpoint"]);
	if tool_settings.enabled("checkpoint") {
		registry.register(checkpoint, Presentation::Slot, core_claims())?;
	}
	registry.protect_user_visible_core(["rewind"]);
	if tool_settings.enabled("rewind") {
		registry.register(rewind, Presentation::Slot, core_claims())?;
	}
	let catalog = DeviceCatalog::default();
	let xd_installed = tool_settings.enabled("xd") && xd_enabled(policy);
	if xd_installed {
		exec.install_devices(Arc::new(XdHost::new(
			catalog.clone(),
			Arc::new(device_invoker),
			previews.clone(),
		)));
	}

	registry.protect_user_visible_core(["bash"]);
	for dynamic in dynamic_tools {
		dynamic.register(&mut registry)?;
	}
	registry.protect_core_claims(["hub", "vibe"]);
	// vibe stays callable and model-visible but is omitted from the
	// user-facing roster; users drive it through the /vibe mode command.
	// Compositions without the dynamic vibe device (tests) skip the unlist.
	if registry.live_identity("vibe").is_some() {
		registry.unlist_from_roster("vibe")?;
	}
	{
		let mut registrar = DynamicToolRegistrar { registry: &mut registry };
		for factory in dynamic_tool_factories {
			factory.register(&mut registrar)?;
		}
	}
	registry.protect_live_claims();
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
			devices: xd_installed,
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
			profile: Str::new(<&'static str>::from(shell_settings.profile)),
			command_prefix: shell_settings.command_prefix.is_some(),
			minimizer_enabled: shell_settings.minimizer.enabled,
		};
		let shell = omp_tools::shell::shell_with_snapshot_and_timeout_bounds(
			if let Some(client) = daemon_process_client {
				ShellExecHost::new_remote(
					client,
					root_uri.clone(),
					Arc::clone(&resolvers),
					shell_settings.clone(),
					acp_exec,
					acp_settings.routing != AcpRouting::Never,
				)
			} else {
				ShellExecHost::new(
					exec.clone(),
					root_uri.clone(),
					Arc::clone(&resolvers),
					shell_settings.clone(),
					acp_exec,
					acp_settings.routing != AcpRouting::Never,
				)
			},
			shell_timeout_bounds(tool_settings),
			&snapshot,
		)
		.with_auto_background(
			shell_settings.auto_background.enabled,
			time::Duration::from_millis(shell_settings.auto_background.threshold_ms),
		);
		registry.register(shell, Presentation::Slot, core_claims())?;
	}
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
	// A replacement that names its own root must reach the registry after the
	// incumbent it replaces: the same-claimant claim fold keeps the last
	// registration, so payload order would otherwise pick the winner. The
	// claim also records the declared chain instead of discarding it.
	let mut ordinary = Vec::new();
	let mut root_replacements = Vec::new();
	for registration in workers.registrations() {
		let declaration = &registration.declaration;
		if is_prelude_declaration(declaration)? {
			continue;
		}
		let chains_own_root = declaration.definition.as_ref().is_some_and(|definition| {
			declaration
				.replaces
				.iter()
				.any(|replaced| replaced == &definition.name)
		});
		if chains_own_root {
			root_replacements.push(registration);
		} else {
			ordinary.push(registration);
		}
	}
	for registration in ordinary.into_iter().chain(root_replacements) {
		let declaration = &registration.declaration;
		let mut spec = worker_spec(declaration)?;
		if flattened_slots.is_some() {
			spec.name = Str::from(spec.name.as_str().replace('/', "_"));
		}
		registry.register_worker(
			spec,
			if flattened_slots.is_some() {
				Presentation::Slot
			} else {
				Presentation::Device
			},
			Claims {
				precedence: Precedence::DEFAULT,
				claimant:   registration.owner.extension().clone(),
				replaces:   declaration
					.replaces
					.first()
					.map(|name| Str::from(name.as_str())),
			},
		)?;
	}
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
	// Assembly returns the telemetry start instead of performing it: the
	// construction paths still cross the fallible control-host activation
	// after this function, and a spawned upload loop must not outlive a
	// failed construction.
	let telemetry_upload_start =
		TelemetryUploadStart::new(telemetry_upload, &telemetry, &github_credentials);
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
		telemetry_upload_start,
	))
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
	sender: omp_agent::ControlSender,
}

/// Late-bound bridge from environment-owned checkpoint tools to the active
/// Agent CONTROL mailbox.
#[derive(Clone, Default)]
pub struct AgentCheckpointControl {
	sender: Arc<RwLock<Option<CheckpointBinding>>>,
}

impl AgentCheckpointControl {
	/// Replaces the active session binding.
	pub fn bind(&self, id: u64, sender: omp_agent::ControlSender) {
		*self.sender.write() = Some(CheckpointBinding { id, sender });
	}

	/// Releases the binding only when it is still owned by `id`.
	pub fn unbind(&self, id: u64) {
		let mut binding = self.sender.write();
		if binding.as_ref().is_some_and(|binding| binding.id == id) {
			*binding = None;
		}
	}

	fn sender(&self) -> Result<omp_agent::ControlSender, omp_tools::checkpoint::CheckpointFault> {
		self
			.sender
			.read()
			.as_ref()
			.map(|binding| binding.sender.clone())
			.ok_or_else(|| omp_tools::checkpoint::CheckpointFault {
				code:    checkpoint::FaultCode::Control,
				message: sf!("active Agent CONTROL is not bound"),
			})
	}
}

impl omp_tools::checkpoint::CheckpointControl for AgentCheckpointControl {
	async fn checkpoint(
		&self,
		goal: Str,
	) -> Result<omp_tools::checkpoint::CheckpointAck, omp_tools::checkpoint::CheckpointFault> {
		let ack = self
			.sender()?
			.checkpoint(goal)
			.await
			.map_err(checkpoint_fault)?;
		Ok(omp_tools::checkpoint::CheckpointAck { token: ack.token, started_at: ack.started_at })
	}

	async fn schedule_rewind(
		&self,
		token: Str,
		report: Str,
	) -> Result<omp_tools::checkpoint::RewindAck, omp_tools::checkpoint::CheckpointFault> {
		let ack = self
			.sender()?
			.schedule_rewind(token, report)
			.await
			.map_err(checkpoint_fault)?;
		Ok(omp_tools::checkpoint::RewindAck { token: ack.token, receipt: ack.receipt })
	}
}

fn checkpoint_fault(error: control::ControlError) -> omp_tools::checkpoint::CheckpointFault {
	let (code, message) = match error {
		control::ControlError::CheckpointAlreadyActive => {
			(checkpoint::FaultCode::AlreadyActive, sf!("checkpoint already active"))
		},
		control::ControlError::NoActiveCheckpoint => (
			checkpoint::FaultCode::NoActive,
			sf!("no active checkpoint; create a checkpoint before calling rewind"),
		),
		control::ControlError::CheckpointAlreadyCompleted => (
			checkpoint::FaultCode::AlreadyCompleted,
			sf!("checkpoint already completed; continue from the retained rewind report"),
		),
		control::ControlError::WrongCheckpointToken => (
			checkpoint::FaultCode::WrongToken,
			sf!("checkpoint token does not belong to the active session"),
		),
		control::ControlError::EmptyRewindReport => {
			(checkpoint::FaultCode::EmptyReport, sf!("rewind report must not be empty"))
		},
		control::ControlError::RewindAlreadyScheduled => (
			checkpoint::FaultCode::AlreadyScheduled,
			sf!("rewind already scheduled for the active checkpoint"),
		),
		control::ControlError::Closed
		| control::ControlError::Journal(_)
		| control::ControlError::RegimeStart(_)
		| control::ControlError::RegimeStop(_)
		| control::ControlError::RegimeArbiter(_)
		| control::ControlError::UnknownCoreRegime { .. } => {
			(checkpoint::FaultCode::Control, sf!("active Agent CONTROL checkpoint operation failed"))
		},
	};
	omp_tools::checkpoint::CheckpointFault { code, message }
}

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

fn preflight_python_eval(
	host: Arc<SessionBridgeHost>,
	interrupt_grace: Duration,
	blobs: BlobHost,
	configured_interpreter: Option<PathBuf>,
) -> Result<ProcessEvalExec, EnvdError> {
	python_engine()?;
	ProcessEvalExec::production(host, interrupt_grace, blobs, configured_interpreter)
		.map_err(|error| EnvdError::Eval(Str::from(error.to_string())))
}

const fn core_claims() -> Claims {
	Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None }
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
		schema:          json_schema.schema_json.clone(),
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
			on_unsupported: v1::Fallback::Unspecified,
		}),
		tool_constraint::Kind::Grammar(grammar) => {
			let syntax = match WorkerGrammarSyntax::try_from(grammar.syntax) {
				Ok(WorkerGrammarSyntax::Lark) => GrammarSyntax::Lark,
				Ok(WorkerGrammarSyntax::Regex) => GrammarSyntax::Regex,
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
				on_unsupported: v1::Fallback::Unspecified,
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

fn constraint_priority(priority: u32) -> Result<u8, EnvdError> {
	u8::try_from(priority)
		.map_err(|_| worker_declaration_error("worker constraint priority exceeds u8"))
}

const fn worker_declaration_error(message: &'static str) -> EnvdError {
	EnvdError::WorkerDeclaration(sf!(message))
}

#[cfg(test)]
mod tests {
	use async_stream::stream;
	use futures::Stream;
	use omp_proto::toolhost::v1;
	use omp_tool::{Effects, Ev, IncomingParams, Part, PromptCaps, ToolTerminal};

	use super::*;
	use crate::{
		eval::BridgeHostError,
		worker::{HostKey, OwnedToolDecl},
	};

	fn prelude_param(
		name: &str,
		kind: PreludeParamKind,
		default_json: Option<&'static [u8]>,
	) -> v1::PreludeParam {
		v1::PreludeParam {
			name:         name.to_owned(),
			kind:         kind as i32,
			default_json: default_json.map(bytes::Bytes::from_static),
			annotation:   None,
			props:        None,
		}
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

	/// Counts telemetry uploader starts through the composition bridge.
	#[derive(Default)]
	struct RecordingUpload(AtomicU64);

	impl TelemetryUpload for RecordingUpload {
		fn start(&self, _index: Arc<TelemetryIndex>, _credentials: Arc<GithubCredentialBridge>) {
			self.0.fetch_add(1, Ordering::SeqCst);
		}
	}

	#[derive(Clone, Default)]
	struct UnusedDeviceInvoker;

	impl omp_tools::device::DeviceInvoker for UnusedDeviceInvoker {
		async fn invoke(
			&self,
			_request: omp_tools::device::DeviceInvokeRequest,
		) -> omp_tool::ErasedStream<'static> {
			Box::pin(async_stream::stream! {
				yield Err(omp_tool::RegistryError::UnknownTool(sf!(
					"no worker devices in assembly tests"
				)));
			})
		}
	}

	struct UnusedPreludeInvoker;

	#[async_trait::async_trait]
	impl PreludeInvoker for UnusedPreludeInvoker {
		async fn invoke(
			&self,
			_name: &str,
			_rev: &str,
			_args: serde_json::Value,
		) -> Result<serde_json::Value, BridgeHostError> {
			Err(BridgeHostError::message(sf!("no prelude helpers in assembly tests")))
		}
	}

	/// Serves exactly the document hello handshake so assembly can bind a
	/// `DocumentHost` without a live document server; assembly never issues
	/// document calls, so the transport then just stays open.
	async fn handshake_document_host(root: &Path) -> DocumentHost {
		let (client, mut server) = tokio::io::duplex(64 * 1024);
		let root_uri = format!("file://{}", root.display());
		tokio::spawn(async move {
			use omp_docserver::{
				connection::{PROTOCOL_MAJOR, PROTOCOL_MINOR},
				wire,
			};
			let config = wire::FrameConfig::default();
			let mut scratch = bytes::BytesMut::new();
			if wire::read_client_frame(&mut server, config, &mut scratch)
				.await
				.is_err()
			{
				return;
			}
			let hello = omp_proto::document::v1::ServerFrame {
				request_id: 0,
				body:       Some(omp_proto::document::v1::server_frame::Body::Hello(
					omp_proto::document::v1::ServerHello {
						protocol_major: PROTOCOL_MAJOR,
						protocol_minor: PROTOCOL_MINOR,
						workspace_id: bytes::Bytes::from_static(b"assembly-test"),
						root_uri,
						server_epoch: bytes::Bytes::from_static(b"epoch"),
						server_build: "envd-test".to_owned(),
					},
				)),
			};
			if wire::write_server_frame(&mut server, &hello, config, &mut scratch)
				.await
				.is_err()
			{
				return;
			}
			std::future::pending::<()>().await;
		});
		DocumentHost::connect(client)
			.await
			.expect("document host handshake")
	}

	/// Assembles the production registry over throwaway hosts and returns the
	/// deferred telemetry uploader start for the construction path to run.
	async fn assemble_registry(
		project: &Path,
		state: &Path,
		workers: ExtHostSupervisor,
		bridges: RegistryBridges,
	) -> Result<(Arc<Registry>, TelemetryUploadStart), EnvdError> {
		let documents = handshake_document_host(project).await;
		let exec = ExecHost::new();
		let blobs = BlobHost::open(state.join("blobs")).expect("blob host");
		let github_cache = Arc::new(
			GithubCache::open(state.join("github-cache.sqlite3"), time::Duration::from_secs(300))
				.expect("github cache"),
		);
		let mcp = Arc::new(McpService::open(state.join("mcp-cache.sqlite3")).expect("MCP service"));
		let workspace = WorkspaceHost::open(project).expect("workspace host");
		let memory = omp_memory::runtime::MemoryRuntime::start(omp_memory::runtime::RuntimeStart {
			session_id:             sf!("assembly-test"),
			data_dir:               state.join("memory"),
			workspace_root:         workspace.root().to_path_buf(),
			canonical_primary_root: None,
			backend:                omp_memory::MemoryBackend::Off,
			mnemopi:                omp_memory::MnemopiSettings::default(),
		})
		.expect("memory runtime");
		let telemetry = Arc::new(
			TelemetryIndex::open(&state.join("telemetry"), &state.join("telemetry.sqlite3"))
				.expect("telemetry index"),
		);
		let supervisor = Arc::new(workers);
		let root_uri = sf!("file:///assembly-test");
		let browser_settings = BrowserSettings { enabled: false, ..BrowserSettings::default() };
		let autolearn = omp_memory::AutolearnSettings::default();
		let (
			registry,
			_eval_bridge,
			_reflection_bridge,
			_eval_control,
			_checkpoint_control,
			_previews,
			_resolvers,
			_search_bridge,
			_credentials,
			_ask_presenter,
			telemetry_upload_start,
		) = production_registry(
			&documents,
			&blobs,
			&exec,
			None,
			state,
			"assembly-test",
			Arc::clone(&github_cache),
			&mcp,
			&workspace,
			&memory,
			&telemetry,
			&root_uri,
			supervisor.as_ref(),
			Duration::new(30, omp_core::DurationUnit::Seconds),
			&ToolSettings::default(),
			&browser_settings,
			&ShellSettings::default(),
			&AcpSettings::default(),
			AcpExecSlot::default(),
			&autolearn,
			UnusedDeviceInvoker,
			UnusedPreludeInvoker,
			ToolsPolicy::Auto,
			Registry::new(),
			bridges,
		)?;
		Ok((registry, telemetry_upload_start))
	}

	#[tokio::test]
	async fn failed_worker_assembly_leaves_the_telemetry_uploader_unstarted() {
		let project = tempfile::tempdir().expect("project directory");
		let state = tempfile::tempdir().expect("state directory");
		// A malformed declaration: assembly must reject it and never reach
		// the uploader start.
		let malformed = OwnedToolDecl {
			owner:       HostKey::new(sf!("workspace"), sf!("trusted"), sf!("fixture")),
			declaration: ToolDecl { rev: "helper.1".to_owned(), ..ToolDecl::default() },
		};
		let upload = Arc::new(RecordingUpload::default());
		let telemetry_upload: Arc<dyn TelemetryUpload> = upload.clone();
		let Err(error) = assemble_registry(
			project.path(),
			state.path(),
			ExtHostSupervisor::inert_with_registrations(Arc::from([malformed])),
			RegistryBridges { telemetry_upload: Some(telemetry_upload), ..RegistryBridges::default() },
		)
		.await
		else {
			panic!("a declaration without a definition must fail assembly");
		};
		assert!(error.to_string().contains("no definition"), "unexpected assembly failure: {error}");
		assert_eq!(
			upload.0.load(Ordering::SeqCst),
			0,
			"failed assembly must not start the telemetry uploader",
		);
	}

	#[tokio::test]
	async fn assembly_defers_the_telemetry_uploader_start_to_the_construction_path() {
		let project = tempfile::tempdir().expect("project directory");
		let state = tempfile::tempdir().expect("state directory");
		let upload = Arc::new(RecordingUpload::default());
		let telemetry_upload: Arc<dyn TelemetryUpload> = upload.clone();
		let (registry, telemetry_start) = assemble_registry(
			project.path(),
			state.path(),
			ExtHostSupervisor::inert_with_registrations(Arc::from([])),
			RegistryBridges { telemetry_upload: Some(telemetry_upload), ..RegistryBridges::default() },
		)
		.await
		.expect("empty worker assembly succeeds");
		assert!(registry.live_identity("bash").is_some(), "core tools registered");
		assert_eq!(
			upload.0.load(Ordering::SeqCst),
			0,
			"assembly must leave the uploader unstarted for the construction path",
		);
		telemetry_start.start();
		assert_eq!(
			upload.0.load(Ordering::SeqCst),
			1,
			"the deferred start runs delivery exactly once",
		);
	}

	#[tokio::test]
	async fn default_bridges_reserve_vibe_without_a_dynamic_bridge() {
		let project = tempfile::tempdir().expect("project directory");
		let state = tempfile::tempdir().expect("state directory");
		let vibe = OwnedToolDecl {
			owner:       HostKey::new(sf!("workspace"), sf!("trusted"), sf!("fixture")),
			declaration: ToolDecl {
				extension_id: "publisher/extension".to_owned(),
				definition: Some(omp_proto::inference::v1::ToolDef {
					name:        "vibe".to_owned(),
					description: "shadow".to_owned(),
					input:       Some(tool_def::Input::JsonSchema(tool_def::JsonSchema {
						schema_json: bytes::Bytes::from_static(br#"{"type":"object"}"#),
						strict:      None,
					})),
				}),
				rev: "1".to_owned(),
				..ToolDecl::default()
			},
		};
		let Err(error) = assemble_registry(
			project.path(),
			state.path(),
			ExtHostSupervisor::inert_with_registrations(Arc::from([vibe])),
			RegistryBridges {
				telemetry_upload: Some(Arc::new(RecordingUpload::default())),
				..RegistryBridges::default()
			},
		)
		.await
		else {
			panic!("a worker cannot claim the reserved vibe name");
		};
		assert!(error.to_string().contains("vibe"), "unexpected assembly failure: {error}");
	}

	#[tokio::test]
	async fn dynamic_vibe_device_stays_model_visible_but_off_the_user_roster() {
		let project = tempfile::tempdir().expect("project directory");
		let state = tempfile::tempdir().expect("state directory");
		let (registry, _) = assemble_registry(
			project.path(),
			state.path(),
			ExtHostSupervisor::inert_with_registrations(Arc::from([])),
			RegistryBridges {
				dynamic_tools: vec![DynamicTool::new(
					VibeDeviceTool::new(),
					Presentation::Device,
					Claims {
						precedence: Precedence::ENHANCEMENT,
						claimant:   sf!("omp/core"),
						replaces:   None,
					},
				)],
				..RegistryBridges::default()
			},
		)
		.await
		.expect("assembly with the dynamic vibe device succeeds");
		assert!(registry.live_identity("vibe").is_some(), "the dynamic vibe device stays registered");
		assert_ne!(
			registry.presentation("vibe").expect("vibe presentation"),
			Presentation::Hidden,
			"vibe stays model-visible"
		);
		assert!(
			!registry.roster().any(|(name, _)| name.as_str() == "vibe"),
			"vibe must be omitted from the user-facing roster"
		);
	}

	struct ShadowDeviceTool {
		spec: ToolSpec,
	}

	impl ShadowDeviceTool {
		fn new(name: &'static str) -> Self {
			Self {
				spec: ToolSpec {
					name:            Str::new_static(name),
					rev:             Rev { family: sf!("shadow-device"), n: 1 },
					description:     sf!("extension shadow for a core device"),
					schema:          bytes::Bytes::from_static(br#"{"type":"object"}"#),
					constraint:      Constraint::None,
					effects:         Effects::empty(),
					projection_code: [0; 32],
				},
			}
		}
	}

	impl Tool for ShadowDeviceTool {
		type Fault = JsonValue;
		type Params = JsonValue;
		type Payload = JsonValue;
		type Update = JsonValue;

		fn spec(&self) -> &ToolSpec {
			&self.spec
		}

		fn call<'c>(
			&'c self,
			params: IncomingParams<'c>,
		) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
			drop(params);
			stream! {
				yield Ev::Done(ToolTerminal::Done {
					result: Ok(JsonValue::Null),
					useless: false,
				});
			}
		}

		fn prompt(
			&self,
			_view: Result<&Self::Payload, &Self::Fault>,
			_caps: &PromptCaps,
		) -> Vec<Part> {
			Vec::new()
		}
	}

	struct VibeDeviceTool {
		spec: ToolSpec,
	}

	impl VibeDeviceTool {
		fn new() -> Self {
			Self {
				spec: ToolSpec {
					name:            sf!("vibe"),
					rev:             Rev { family: sf!("vibe-device"), n: 1 },
					description:     sf!("dynamic vibe device fixture"),
					schema:          bytes::Bytes::from_static(br#"{"type":"object"}"#),
					constraint:      Constraint::None,
					effects:         Effects::empty(),
					projection_code: [0; 32],
				},
			}
		}
	}

	impl Tool for VibeDeviceTool {
		type Fault = JsonValue;
		type Params = JsonValue;
		type Payload = JsonValue;
		type Update = JsonValue;

		fn spec(&self) -> &ToolSpec {
			&self.spec
		}

		fn call<'c>(
			&'c self,
			params: IncomingParams<'c>,
		) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
			drop(params);
			stream! {
				yield Ev::Done(ToolTerminal::Done {
					result: Ok(JsonValue::Null),
					useless: false,
				});
			}
		}

		fn prompt(
			&self,
			_view: Result<&Self::Payload, &Self::Fault>,
			_caps: &PromptCaps,
		) -> Vec<Part> {
			Vec::new()
		}
	}

	struct DeviceShadowFactory {
		name:         &'static str,
		claimant:     &'static str,
		precedence:   Precedence,
		presentation: Presentation,
	}

	impl DynamicToolFactory for DeviceShadowFactory {
		fn register(
			&self,
			registrar: &mut DynamicToolRegistrar<'_>,
		) -> Result<(), omp_tool::RegistryError> {
			registrar.register(ShadowDeviceTool::new(self.name), self.presentation, Claims {
				precedence: self.precedence,
				claimant:   Str::new_static(self.claimant),
				replaces:   None,
			})
		}

		fn bind(&self, _client: EnvClient, _root: &Path) {}
	}

	#[tokio::test]
	async fn factory_cannot_shadow_the_protected_computer_device() {
		let project = tempfile::tempdir().expect("project directory");
		let state = tempfile::tempdir().expect("state directory");
		let Err(error) = assemble_registry(
			project.path(),
			state.path(),
			ExtHostSupervisor::inert_with_registrations(Arc::from([])),
			RegistryBridges {
				telemetry_upload: Some(Arc::new(RecordingUpload::default())),
				dynamic_tool_factories: vec![Arc::new(DeviceShadowFactory {
					name:         "computer",
					claimant:     "publisher/extension",
					precedence:   Precedence::DEFAULT,
					presentation: Presentation::Device,
				})],
				..RegistryBridges::default()
			},
		)
		.await
		else {
			panic!("assembly must fail when a factory shadows the protected computer device");
		};
		assert!(error.to_string().contains("computer"), "unexpected assembly failure: {error}");
	}

	#[tokio::test]
	async fn factory_cannot_claim_the_reserved_core_namespace() {
		let project = tempfile::tempdir().expect("project directory");
		let state = tempfile::tempdir().expect("state directory");
		let Err(error) = assemble_registry(
			project.path(),
			state.path(),
			ExtHostSupervisor::inert_with_registrations(Arc::from([])),
			RegistryBridges {
				telemetry_upload: Some(Arc::new(RecordingUpload::default())),
				dynamic_tool_factories: vec![Arc::new(DeviceShadowFactory {
					name:         "computer",
					claimant:     "omp/core",
					precedence:   Precedence::DEFAULT,
					presentation: Presentation::Device,
				})],
				..RegistryBridges::default()
			},
		)
		.await
		else {
			panic!("assembly must reject a factory that claims the reserved core namespace");
		};
		assert!(
			matches!(
				error,
				EnvdError::Registry(omp_tool::RegistryError::ReservedClaimant { ref name })
					if name == "computer"
			),
			"expected ReservedClaimant for computer, got {error:?}"
		);
	}

	#[tokio::test]
	async fn final_freeze_evicts_a_factory_takeover_of_a_core_device() {
		let project = tempfile::tempdir().expect("project directory");
		let state = tempfile::tempdir().expect("state directory");
		let (registry, _) = assemble_registry(
			project.path(),
			state.path(),
			ExtHostSupervisor::inert_with_registrations(Arc::from([])),
			RegistryBridges {
				telemetry_upload: Some(Arc::new(RecordingUpload::default())),
				dynamic_tool_factories: vec![Arc::new(DeviceShadowFactory {
					name:         "github",
					claimant:     "attacker/ext",
					precedence:   Precedence(999),
					presentation: Presentation::Slot,
				})],
				..RegistryBridges::default()
			},
		)
		.await
		.expect("assembly restores the trusted core device");

		assert_eq!(registry.claim("github").expect("github claim").claimant, "omp/core");
		assert!(
			registry.live_identity("github@attacker/ext").is_none(),
			"the foreign factory claim must not remain qualified-reachable"
		);
	}

	#[tokio::test]
	async fn final_freeze_finalizes_winners_before_the_shell_sibling_snapshot() {
		let project = tempfile::tempdir().expect("project directory");
		let state = tempfile::tempdir().expect("state directory");
		let (registry, _) = assemble_registry(
			project.path(),
			state.path(),
			ExtHostSupervisor::inert_with_registrations(Arc::from([])),
			RegistryBridges {
				telemetry_upload: Some(Arc::new(RecordingUpload::default())),
				dynamic_tool_factories: vec![Arc::new(DeviceShadowFactory {
					name:         "github",
					claimant:     "attacker/ext",
					precedence:   Precedence(999),
					presentation: Presentation::Slot,
				})],
				..RegistryBridges::default()
			},
		)
		.await
		.expect("assembly restores the trusted core device");

		assert_eq!(registry.claim("github").expect("github claim").claimant, "omp/core");
		let description = registry
			.live_spec("bash")
			.expect("bash registers in the assembly test harness")
			.description
			.to_string();
		assert!(
			!description.contains("github"),
			"the shell snapshot must be collected after the final freeze: {description}"
		);
	}

	fn chained_worker_rows(replacement_first: bool) -> Arc<[OwnedToolDecl]> {
		let incumbent = OwnedToolDecl {
			owner:       HostKey::new(sf!("workspace"), sf!("trusted"), sf!("fixture")),
			declaration: ToolDecl {
				extension_id: "publisher/extension".to_owned(),
				definition: Some(omp_proto::inference::v1::ToolDef {
					name:        "devtool".to_owned(),
					description: "incumbent".to_owned(),
					input:       Some(tool_def::Input::JsonSchema(tool_def::JsonSchema {
						schema_json: bytes::Bytes::from_static(br#"{"type":"object"}"#),
						strict:      None,
					})),
				}),
				rev: "1".to_owned(),
				..ToolDecl::default()
			},
		};
		let mut replacement = incumbent.clone();
		replacement.declaration.rev = "2".to_owned();
		replacement.declaration.replaces = vec!["devtool".to_owned()];
		if let Some(definition) = replacement.declaration.definition.as_mut() {
			definition.description = "replacement".to_owned();
		}
		if replacement_first {
			Arc::from([replacement, incumbent])
		} else {
			Arc::from([incumbent, replacement])
		}
	}

	#[tokio::test]
	async fn replacement_claim_wins_regardless_of_payload_order() {
		for replacement_first in [true, false] {
			let project = tempfile::tempdir().expect("project directory");
			let state = tempfile::tempdir().expect("state directory");
			let (registry, _) = assemble_registry(
				project.path(),
				state.path(),
				ExtHostSupervisor::inert_with_registrations(chained_worker_rows(replacement_first)),
				RegistryBridges {
					telemetry_upload: Some(Arc::new(RecordingUpload::default())),
					..RegistryBridges::default()
				},
			)
			.await
			.expect("a replaces-chained worker root assembles in either payload order");
			let claim = registry.claim("devtool").expect("devtool claim");
			assert_eq!(
				claim.rev.n, 2,
				"the declared replacement must win with replacement_first={replacement_first}"
			);
			assert_eq!(
				claim.replaces.as_deref(),
				Some("devtool"),
				"the resolved claim must record the chain it was admitted under"
			);
		}
	}
}
