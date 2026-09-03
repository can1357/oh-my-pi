//! Durable non-interactive session assembly shared by print, RPC, and ACP.

pub mod finalize;

use std::{
	collections::{BTreeMap, BTreeSet},
	env, error,
	path::{Path, PathBuf},
	str::FromStr,
	sync::Arc,
	time::{Duration, Instant},
};

use omp_agent::{
	Agent, AgentEvent, AgentKind, AgentRunSummary, AgentState, AgentStatus, AgentTree, ApprovalBook,
	ApprovalInbox, ApprovalRoute, Budget, EventSubscription, InProcTurnClient, TurnId,
};
use omp_catalog::{ModelKey, ProviderId, snapshot};
use omp_core::{InvocationPhase, LifecyclePhase, SecretString, Str, sf};
use omp_envd::exthost::{
	CallbackConcurrency, EventDeadline, TelemetryControlAuthority,
	backends::EnvdHostOwnerBackends,
	control::{
		ControlAuthority, ControlAuthorityFactory, ControlConnectionIdentity, ControlDispatch,
		ControlInvocationAuthority,
	},
};
use omp_inference::Registry as InferenceRegistry;
use omp_observability::firehose::{
	Envelope as TelemetryEnvelope, Event as TelemetryEvent, Firehose, Kind as TelemetryKind,
	SubscriptionOptions,
};
use omp_proto::thread::v1::Item;
use omp_sdk::{SessionHandle, SessionIdentity, SessionRuntime};
use omp_settings::manager::{MutationScope, SettingsManager, SettingsPaths};
use omp_storage::{
	blob::BlobStore,
	index::SessionFilter,
	telemetry_index::TelemetryIndex,
	transcript::{
		ModelChange as JournalModelChange, ModelId as JournalModelId, ModelRef as JournalModelRef,
		ProviderId as JournalProviderId,
	},
};
use parking_lot::Mutex;

use self::finalize::{FinalizerBudget, FinalizerReport, HeadlessFinalizerHandle};
/// Typed failure while composing or mutating a headless session.
#[derive(Debug, thiserror::Error)]
pub enum HeadlessError {
	/// A typed authority used by headless composition failed.
	#[error("headless session composition failed")]
	Composition(#[source] Box<dyn error::Error + Send + Sync + 'static>),
	/// The requested model selector was not present in the embedded catalog.
	#[error("unknown model `{0}`")]
	UnknownModel(Str),
	/// The selected model had no usable route.
	#[error("model `{0}` has no selectable route")]
	MissingRoute(Str),
}

fn composition(error: impl error::Error + Send + Sync + 'static) -> HeadlessError {
	HeadlessError::Composition(Box::new(error))
}
fn prompt_control_factory(
	head: Arc<dyn rulebook::PromptHeadAuthority>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(move |identity: Arc<ControlConnectionIdentity>| {
		Ok(Arc::new(rulebook::PromptControlOwner::new(identity, Arc::clone(&head)))
			as Arc<dyn ControlAuthority>)
	})
}

fn telemetry_control_factory(
	query: Arc<dyn omp_observability::authority::DurableTelemetryQuery>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(move |identity: Arc<ControlConnectionIdentity>| {
		Ok(Arc::new(TelemetryControlAuthority::new(identity, now_ms(), Arc::clone(&query)))
			as Arc<dyn ControlAuthority>)
	})
}

fn provider_control_factory(
	registry: omp_inference::Registry,
	builtins: omp_inference::layer::stack::BuiltinConfig,
	blobs: BlobStore,
) -> Arc<dyn ControlAuthorityFactory> {
	let owner = Arc::new(ProductionProviderApplicationOwner::new(registry, builtins, blobs));
	let backend = Arc::new(ChatProviderControlBackend::new(owner));
	Arc::new(ProviderControlAuthorityFactory::new(backend))
}
fn telemetry_envelope(event: &TelemetryEvent) -> Option<&TelemetryEnvelope> {
	match event {
		TelemetryEvent::SessionStart(event) => Some(&event.envelope),
		TelemetryEvent::SessionDispatch(event) => Some(&event.envelope),
		TelemetryEvent::SessionEnd(event) => Some(&event.envelope),
		TelemetryEvent::TurnStart(event) => Some(&event.envelope),
		TelemetryEvent::TurnEnd(event) => Some(&event.envelope),
		TelemetryEvent::ModelRequest(event) => Some(&event.envelope),
		TelemetryEvent::ModelAttempt(event) => Some(&event.envelope),
		TelemetryEvent::ProviderError(event) => Some(&event.envelope),
		TelemetryEvent::ToolCall(event) => Some(&event.envelope),
		TelemetryEvent::CapabilityDegraded(event) => Some(&event.envelope),
		TelemetryEvent::Compaction(event) => Some(&event.envelope),
		TelemetryEvent::Branch(event) => Some(&event.envelope),
		TelemetryEvent::ArtifactSpill(event) => Some(&event.envelope),
		TelemetryEvent::IssueReport(event) => Some(&event.envelope),
		TelemetryEvent::HostWarning(event) => Some(&event.envelope),
		_ => None,
	}
}

fn telemetry_event_wire(event: &TelemetryEvent, sequence: u64) -> serde_json::Value {
	let kind = event.kind().as_str();
	let envelope = telemetry_envelope(event);
	let mut value = serde_json::json!({
		"kind": kind,
		"seq": sequence,
		"at_ms": envelope.map_or(0, |value| value.occurred_at_ms),
		"session": envelope.map_or("", |value| value.session_id.as_str()),
		"agent": envelope.map_or("", |value| value.agent_id.as_str()),
		"depth": 0,
		"conversation": envelope.map_or("", |value| value.session_id.as_str()),
		"trace": null,
		"principal": envelope.map_or("", |value| value.principal.as_str()),
		"generation": envelope.map_or(0, |value| value.generation),
	});
	let fields = value
		.as_object_mut()
		.expect("telemetry envelope is an object");
	match event {
		TelemetryEvent::ModelRequest(request) => {
			fields.extend(
				serde_json::json!({
					"usage": {},
					"prompt": {
						"digest": omp_core::hex::encode(&request.prompt.digest).to_string(),
						"slots": {},
						"changed": request.prompt.changed.iter().map(Str::as_str).collect::<Vec<_>>(),
						"prefix_stable_bytes": request.prompt.prefix_stable_bytes,
						"cache_key": request.prompt.cache_key.as_deref().unwrap_or(""),
						"retention": "",
						"mode": "",
						"ttl": "",
						"breakpoint": "",
						"breakpoint_indices": [],
					},
					"served_model": request.served_model.as_str(),
					"latency_ms": 0,
					"ttft_ms": null,
					"degraded": [],
					"request_content": null,
					"response_content": null,
				})
				.as_object()
				.expect("model request projection is an object")
				.clone(),
			);
		},
		TelemetryEvent::TurnStart(turn) => {
			fields.extend(
				serde_json::json!({
					"turn": turn.turn,
					"trigger": "",
					"input_chars": 0,
					"input_parts": 0,
					"attachments": 0,
					"model": "",
					"effort": null,
				})
				.as_object()
				.expect("turn projection is an object")
				.clone(),
			);
		},
		TelemetryEvent::TurnEnd(turn) => {
			fields.extend(
				serde_json::json!({
					"turn": turn.turn,
					"steps": 0,
					"requests": 0,
					"calls": 0,
					"tokens": {},
					"cost": null,
					"latency_ms": 0,
					"stop": "complete",
					"tools_used": [],
					"faults": 0,
					"interrupted": false,
					"context": {},
				})
				.as_object()
				.expect("turn projection is an object")
				.clone(),
			);
		},
		_ => {},
	}
	value
}

fn bind_extension_telemetry(
	environment: &omp_envd::ProjectEnvironment,
	firehose: &Arc<Firehose>,
	session: &Str,
) -> Vec<tokio::task::JoinHandle<()>> {
	let dispatcher = environment.extension_callback_dispatcher();
	let mut tasks = Vec::new();
	for evidence in environment.extension_control_identities() {
		let Some(manifest) = environment.extension_control_manifest(&evidence) else {
			continue;
		};
		for declaration in &manifest.static_declarations().ordered {
			if !matches!(declaration.kind.as_str(), "telemetry" | "telemetry_subscription") {
				continue;
			}
			let Ok(kind) = TelemetryKind::from_str(declaration.key.as_str()) else {
				continue;
			};
			let Ok(subscription) = firehose.subscribe(
				SubscriptionOptions::new([kind], omp_observability::firehose::QUEUE_DEFAULT)
					.expect("one telemetry kind and the default queue are valid"),
			) else {
				continue;
			};
			tracing::debug!(
				extension = %evidence.extension,
				subscription = %declaration.id,
				kind = kind.as_str(),
				"bound extension telemetry firehose"
			);
			let dispatcher = Arc::clone(&dispatcher);
			let identity = Arc::clone(&evidence);
			let qualified_name = sf!("{}.{}", declaration.module, declaration.id);
			let session = session.clone();
			tasks.push(tokio::spawn(async move {
				let mut delivered = 0_u64;
				while let Ok(event) = subscription.recv().await {
					tracing::debug!(
						extension = %identity.extension,
						kind = event.kind().as_str(),
						"received extension telemetry event"
					);
					delivered = delivered.saturating_add(1);
					let kind = event.kind();
					let turn = match event.as_ref() {
						TelemetryEvent::TurnStart(event) => Some(event.turn),
						TelemetryEvent::TurnEnd(event) => Some(event.turn),
						_ => None,
					};
					let invocation = sf!("telemetry:{}:{delivered}", qualified_name);
					let result = dispatcher
						.dispatch(Arc::clone(&identity), ControlDispatch {
							operation: sf!("omp.telemetry.dispatch"),
							arguments: serde_json::Map::from_iter([
								(
									"qualified_name".to_owned(),
									serde_json::Value::String(qualified_name.to_string()),
								),
								("event".to_owned(), telemetry_event_wire(event.as_ref(), delivered)),
								("ctx".to_owned(), serde_json::Value::Null),
								(
									"stats".to_owned(),
									serde_json::json!({
										"delivered": delivered,
										"dropped": subscription.drop_stats().dropped,
										"coalesced": 0,
										"errored": 0,
										"replay_skipped": subscription.drop_stats().replay_skipped,
										"queue_depth": 0,
										"first_drop_seq": null,
										"since_ms": 0,
									}),
								),
							]),
							authority: ControlInvocationAuthority {
								invocation,
								phase: InvocationPhase::EffectsAuthorized,
								session: session.clone(),
								turn,
								event: Some(sf!(kind.as_str())),
								call: None,
								device: None,
								effects: Box::new([]),
								place_kind: sf!("host"),
								lifecycle: LifecyclePhase::Active,
								roots: Box::new([]),
								remote: false,
								has_ui: false,
								headless: true,
								settings: serde_json::Map::new(),
								secret_settings: Box::new([]),
								data: None,
								direct_filesystem: None,
							},
							policy:    CallbackConcurrency::Serialized,
							deadline:  EventDeadline { at: Instant::now() + Duration::from_secs(5) },
						})
						.await;
					if let Err(error) = result {
						tracing::warn!(
							extension = %identity.extension,
							subscription = %qualified_name,
							%error,
							"extension telemetry delivery failed"
						);
					}
				}
			}));
		}
	}
	tasks
}

use std::mem;

use omp_envd::exthost::lifecycle::{HeadlessLifecycleSink, HeadlessLifecycleSubscription};
use omp_proto::inference::{v1, v1::response_format};
use tokio::io;

use crate::{
	bridges::{AgentGoalBinding, AgentGoalControl, InferenceBridge, builtin_with_content},
	chat::{self, ChatProviderControlBackend},
	discovery,
	discovery::context,
	memory::{ExtractionWorker, InferenceExtractionLane},
	model_controls::{ProductionProviderApplicationOwner, ProviderControlAuthorityFactory},
	modes::RegimeHandle,
	prompt_prep::{PromptSnapshot, settings::PromptSettings},
	registry::{
		InferenceSessionOverrides, ProductionInference, production_inference_for_session,
		production_redemption_authority,
	},
	rulebook,
	secrets::{
		credential_control_grants, credential_secret_control_factory, session::SecretSessionSnapshot,
	},
	settings::Settings,
	skills,
	stats_api::telemetry_backend::TelemetryIndexQuery,
};

/// Inputs required to create one production headless session.
#[derive(Clone, Debug)]
pub struct HeadlessSessionOptions {
	/// Project root whose Environment owns all effects.
	pub project:               PathBuf,
	/// Ordered invocation-local TOML or YAML settings overlays.
	pub settings_overlays:     Box<[PathBuf]>,
	/// Additional Environment-authorized workspace roots.
	pub additional_roots:      Box<[PathBuf]>,
	/// Resolved catalog model selector.
	pub model:                 Str,
	/// Built-in regime started before the agent moves into its runtime actor.
	pub initial_regime:        Option<&'static str>,
	/// Optional prompt-slot override for the initial regime.
	pub initial_prompt_slot:   Option<&'static str>,
	/// One-shot model selection applied when the plan regime exits.
	pub plan_handoff:          Option<crate::plan::ModelSelection>,
	/// Existing durable session to resume, or a fresh journal when absent.
	pub resume:                Option<Str>,
	/// Existing durable session whose live projection is copied into a fork.
	pub fork:                  Option<Str>,
	/// Whether the Python eval device is enabled.
	pub py_eval:               bool,
	/// Invocation-only tool approval mode that overrides persisted settings.
	pub approval_mode:         Option<omp_envd::tool_settings::ApprovalMode>,
	/// Detached-daemon idle timeout in seconds, forwarded only when this session
	/// spawns the daemon. `None` uses the daemon's default.
	pub spawn_idle_timeout:    Option<u64>,
	/// Whether authenticated tool invocations are forbidden from allocating
	/// PTYs.
	pub pty_denied:            bool,
	/// Provider pinned by an invocation API-key lease.
	pub credential_provider:   Option<ProviderId>,
	/// Generic invocation key held only by the inference broker overlay.
	pub api_key:               Option<SecretString>,
	/// Opaque prompt-cache identity lowered by compatible codecs.
	pub prompt_cache_affinity: Option<Str>,
	/// Session-incarnation fence stamped onto observable events.
	pub session_generation:    u64,
}
/// Persistence operation selected by a non-interactive launch.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum HeadlessSessionOpen {
	/// Create a fresh indexed durable session.
	#[default]
	New,
	/// Resume one exact durable session.
	Resume(Str),
	/// Fork one exact durable session into a new identity.
	Fork(Str),
	/// Resume the newest indexed interactive session for the project.
	ContinueLatest,
	/// Create process-lifetime state removed when the headless owner drops.
	Ephemeral,
}

/// Model-callable tool inclusion policy frozen at headless launch.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum HeadlessToolPolicy {
	/// Advertise every session-eligible Environment tool.
	#[default]
	All,
	/// Advertise no tools.
	None,
	/// Advertise only the exact ordered tool names.
	Only(Box<[Str]>),
}

/// Typed non-interactive launch policy shared by print, RPC, and ACP.
#[derive(Clone, Debug)]
pub struct HeadlessLaunchPolicy {
	/// Durable or process-lifetime session operation.
	pub session:            HeadlessSessionOpen,
	/// Exact journal directory supplied by the caller's storage authority.
	pub sessions_dir:       Option<PathBuf>,
	/// Frozen tool inclusion policy.
	pub tools:              HeadlessToolPolicy,
	/// Whether the `lsp` tool remains callable.
	pub lsp_enabled:        bool,
	/// Automatic-thinking policy installed before the agent actor starts.
	pub auto_thinking:      Option<crate::settings::AutoThinkingSettings>,
	/// Invocation-local native extension/content root policy.
	pub native_discovery:   discovery::native::NativeDiscoveryOptions,
	/// Already-admitted trusted or contributed extension host specifications.
	pub extension_specs:    Arc<[omp_envd::worker::ExtHostSpec]>,
	/// Manifest-validated contributed CLI values delivered at extension start.
	pub contributed_values: Arc<[omp_ext::config::ContributedCliValue]>,
}
impl Default for HeadlessLaunchPolicy {
	fn default() -> Self {
		Self {
			session:            HeadlessSessionOpen::New,
			sessions_dir:       None,
			tools:              HeadlessToolPolicy::All,
			lsp_enabled:        true,
			auto_thinking:      None,
			native_discovery:   discovery::native::NativeDiscoveryOptions::default(),
			extension_specs:    Arc::from([]),
			contributed_values: Arc::from([]),
		}
	}
}

fn apply_tool_policy(
	snapshot: &mut omp_agent::AgentSnapshot,
	policy: &HeadlessToolPolicy,
	lsp_enabled: bool,
) {
	let allowed = |name: &str| lsp_enabled || name != "lsp";
	let selected = match policy {
		HeadlessToolPolicy::All => snapshot
			.enabled_tools
			.iter()
			.filter(|name| allowed(name.as_str()))
			.cloned()
			.collect::<Vec<_>>(),
		HeadlessToolPolicy::None => Vec::new(),
		HeadlessToolPolicy::Only(names) => names
			.iter()
			.filter(|name| {
				allowed(name.as_str())
					&& snapshot
						.enabled_tools
						.iter()
						.any(|available| available == *name)
			})
			.cloned()
			.collect::<Vec<_>>(),
	};
	snapshot
		.turn
		.params
		.tools
		.retain(|tool| selected.iter().any(|name| name.as_str() == tool.name));
	snapshot.enabled_tools = selected.into();
}
fn validate_extension_host_keys<'a>(
	keys: impl IntoIterator<Item = &'a omp_envd::worker::HostKey>,
) -> Result<(), HeadlessError> {
	let mut seen = BTreeSet::new();
	for key in keys {
		if !seen.insert(key.clone()) {
			return Err(composition(io::Error::new(
				io::ErrorKind::InvalidInput,
				format!("duplicate extension host identity: {key:?}"),
			)));
		}
	}
	Ok(())
}

/// Single owner of every authority needed by a non-interactive agent loop.
///
/// Field order is deliberate: the Agent and its cloned Environment client are
/// dropped before the project Environment authority.
pub struct HeadlessSession {
	session:              SessionHandle,
	advisor_parent:       Arc<chat::ChatParentHost<InProcTurnClient>>,
	advise_queue:         omp_agent::advisor::AdvisorAdviceQueue,
	state:                AgentState,
	control:              omp_agent::ControlSender,
	env:                  omp_env::EnvClient,
	regimes:              Arc<RegimeHandle>,
	tree:                 Arc<AgentTree>,
	events:               Option<EventSubscription>,
	lifecycle:            HeadlessLifecycleSink,
	lifecycle_events:     Option<HeadlessLifecycleSubscription>,
	approval_book:        Arc<ApprovalBook>,
	approval_route:       ApprovalRoute,
	approval_inbox:       Option<ApprovalInbox>,
	finalizer:            HeadlessFinalizerHandle,
	_goal_binding:        AgentGoalBinding,
	session_id:           Str,
	discovery_warnings:   Arc<[Str]>,
	initial_items:        Vec<Item>,
	_inference_registry:  InferenceRegistry,
	_catalog:             Arc<snapshot::Catalog>,
	_edit_repair_task:    Option<tokio::task::JoinHandle<()>>,
	_telemetry_tasks:     Vec<tokio::task::JoinHandle<()>>,
	_memory_extraction:   Option<ExtractionWorker>,
	_ephemeral_sessions:  Option<chat::EphemeralSessions>,
	_tool_policy:         HeadlessToolPolicy,
	_lsp_enabled:         bool,
	_compaction_methods:  omp_agent::CompactionMethodOrder,
	_mid_turn_policy:     omp_agent::MidTurnCompactionPolicy,
	_retry_policy:        omp_agent::RetryPolicy,
	_forced_tool:         Mutex<Option<Str>>,
	_external_control:    omp_envd::exthost::ExternalControlAuthorityBinding,
	_journal_control:     omp_envd::AgentControlBinding,
	_eval_parent_control: omp_envd::eval::ParentBindingLease,
	_environment:         omp_envd::ProjectEnvironment,
}

impl HeadlessSession {
	/// Constructs the production Environment, v4 journal, agent loop, tree,
	/// extension sink, approval route, and lossless event subscription.
	pub async fn open(
		data_dir: PathBuf,
		options: HeadlessSessionOptions,
	) -> Result<Self, HeadlessError> {
		let session = if let Some(source) = options.fork.clone() {
			HeadlessSessionOpen::Fork(source)
		} else if let Some(source) = options.resume.clone() {
			HeadlessSessionOpen::Resume(source)
		} else {
			HeadlessSessionOpen::New
		};
		Self::open_with_policy(data_dir, options, HeadlessLaunchPolicy {
			session,
			lsp_enabled: true,
			..HeadlessLaunchPolicy::default()
		})
		.await
	}

	/// Constructs a production session with explicit persistence and tool
	/// policies instead of reinterpreting protocol-specific flags.
	pub async fn open_with_policy(
		data_dir: PathBuf,
		options: HeadlessSessionOptions,
		policy: HeadlessLaunchPolicy,
	) -> Result<Self, HeadlessError> {
		Self::open_inner(data_dir, options, policy, None).await
	}

	/// Constructs a production session over an exact command-owned tool
	/// registry while retaining the normal Environment and inference owners.
	pub(crate) async fn open_with_registry(
		data_dir: PathBuf,
		options: HeadlessSessionOptions,
		registry: Arc<omp_tool::Registry>,
	) -> Result<Self, HeadlessError> {
		let session = if let Some(source) = options.fork.clone() {
			HeadlessSessionOpen::Fork(source)
		} else if let Some(source) = options.resume.clone() {
			HeadlessSessionOpen::Resume(source)
		} else {
			HeadlessSessionOpen::New
		};
		Self::open_inner(
			data_dir,
			options,
			HeadlessLaunchPolicy { session, ..HeadlessLaunchPolicy::default() },
			Some(registry),
		)
		.await
	}

	async fn open_inner(
		data_dir: PathBuf,
		options: HeadlessSessionOptions,
		policy: HeadlessLaunchPolicy,
		registry_override: Option<Arc<omp_tool::Registry>>,
	) -> Result<Self, HeadlessError> {
		let root = chat::canonical_project(&options.project).map_err(composition)?;
		let home = env::var_os("HOME").map_or_else(|| root.clone(), PathBuf::from);
		let base_catalog_owner =
			crate::registry::production_catalog(&data_dir).map_err(composition)?;
		let base_catalog = base_catalog_owner.as_ref();
		let mut settings_paths = SettingsPaths::discover(&data_dir, Some(&root));
		settings_paths
			.overlays
			.extend(options.settings_overlays.iter().cloned());
		let settings_manager = SettingsManager::open(settings_paths).map_err(composition)?;
		if let Some(approval_mode) = options.approval_mode {
			settings_manager
				.set_sync(MutationScope::Runtime, "tools.approval_mode", &approval_mode.to_string())
				.map_err(composition)?;
		}
		let settings_snapshot = settings_manager.snapshot();
		let mut settings = settings_snapshot
			.project::<Settings>()
			.map_err(composition)?
			.get()
			.clone();
		settings.mnemopi = settings.mnemopi.normalize();
		let model_settings = settings_snapshot
			.project::<omp_catalog::settings::ModelSettings>()
			.map_err(composition)?
			.get()
			.resolve_path_scopes(&root, &home);
		let mut native_discovery = policy.native_discovery.clone();
		native_discovery.workspace_identity = Some(discovery::workspace_identity(&root));
		let extension_scopes = settings
			.extension_scopes(
				crate::settings::workspace_extension_overlay(&root).map_err(composition)?,
			)
			.map_err(composition)?;
		let prompt_discovery_settings = discovery::PromptDiscoverySettings {
			model: model_settings.clone(),
			skills: settings_snapshot
				.project::<discovery::skills::SkillDiscoverySettings>()
				.map_err(composition)?
				.get()
				.clone(),
			foreign: settings_snapshot
				.project::<discovery::foreign::ForeignContentSettings>()
				.map_err(composition)?
				.get()
				.clone(),
			rules: settings_snapshot
				.project::<crate::rulebook::RulebookSettings>()
				.map_err(composition)?
				.get()
				.clone(),
			native: native_discovery,
			grants: Some(discovery::ExtensionGrantSettings {
				path:    data_dir.join("ext/grants.toml"),
				session: Arc::from([]),
			}),
			extension_scopes,
			extension_overrides: Arc::from([]),
		};
		let mut prompt_discovery = discovery::active_prompt_snapshots(
			&root,
			&options.additional_roots,
			&home,
			&prompt_discovery_settings,
		);
		let state_dir = omp_env::project_state::directory(&data_dir, &root).map_err(composition)?;
		let mut ephemeral_sessions = None;
		let sessions_dir = match (&policy.session, policy.sessions_dir.as_ref()) {
			(HeadlessSessionOpen::Ephemeral, Some(_)) => {
				return Err(composition(io::Error::new(
					io::ErrorKind::InvalidInput,
					"ephemeral headless sessions cannot use a durable sessions directory",
				)));
			},
			(HeadlessSessionOpen::Ephemeral, None) => {
				let owner = chat::EphemeralSessions::create().map_err(composition)?;
				let path = owner.path().to_owned();
				ephemeral_sessions = Some(owner);
				path
			},
			(_, Some(directory)) => directory.clone(),
			(_, None) => state_dir.join("sessions"),
		};
		chat::ensure_state_directory(&state_dir).map_err(composition)?;
		chat::ensure_state_directory(&sessions_dir).map_err(composition)?;
		let search = Arc::new(InferenceBridge::default());
		let goal_control = AgentGoalControl::default();
		let advise_queue = omp_agent::advisor::AdvisorAdviceQueue::default();
		let (edit_repair, edit_repair_requests) =
			omp_tools::edit::observer::EditRepairClient::channel();
		let extension_specs = prompt_discovery
			.content
			.extensions
			.iter()
			.chain(policy.extension_specs.iter())
			.cloned()
			.collect::<Vec<_>>();
		validate_extension_host_keys(extension_specs.iter().map(|extension| &extension.key))?;
		let has_runtime_providers = extension_specs.iter().any(|extension| {
			!extension
				.manifest
				.static_declarations()
				.providers
				.is_empty()
		});
		let preselected_model = if has_runtime_providers {
			None
		} else {
			let model = chat::resolve_model_selector(base_catalog, options.model.as_str())
				.map_err(composition)?;
			if !crate::discovery::roles::model_selector_allowed(
				base_catalog,
				&model_settings,
				model.as_str(),
			) {
				return Err(HeadlessError::MissingRoute(model));
			}
			Some(model)
		};
		let prompt_head =
			Arc::new(crate::prompt_head::ProductionPromptHead::from_extension_specs(&extension_specs));
		let mut bridges = builtin_with_content(
			&root,
			Arc::clone(&search),
			goal_control.clone(),
			None,
			advise_queue.clone(),
			&prompt_discovery.content,
		);
		bridges.edit_model = Some(options.model.clone());
		bridges.edit_repair = settings.tools.edit_auto_repair.then_some(edit_repair);
		let environment =
			omp_envd::ProjectEnvironment::attach(&root, &state_dir, omp_envd::AttachOptions {
				py_eval: options.py_eval,
				approval_mode: options.approval_mode,
				trusted_extensions: extension_specs.clone(),
				contributed_values: policy.contributed_values.iter().cloned().collect(),
				settings: Arc::clone(&settings_snapshot),
				bridges,
				spawn_idle_timeout: options.spawn_idle_timeout,
			})
			.await
			.map_err(composition)?;
		let evidences = environment.extension_registry_evidences();
		let catalog_owner = if has_runtime_providers {
			Arc::new(
				crate::model_controls::compose_runtime_provider_catalog(
					base_catalog,
					evidences
						.iter()
						.flat_map(|evidence| evidence.providers.iter()),
				)
				.map_err(composition)?,
			)
		} else {
			base_catalog_owner
		};
		let catalog = catalog_owner.as_ref();
		let model = match preselected_model {
			Some(model) => model,
			None => {
				let model = chat::resolve_model_selector(catalog, options.model.as_str())
					.map_err(composition)?;
				if !crate::discovery::roles::model_selector_allowed(
					catalog,
					&model_settings,
					model.as_str(),
				) {
					return Err(HeadlessError::MissingRoute(model));
				}
				model
			},
		};
		let catalog_override = has_runtime_providers.then(|| Arc::clone(&catalog_owner));
		let credential_provider = match (&options.credential_provider, options.api_key.as_ref()) {
			(Some(provider), _) => Some(provider.clone()),
			(None, Some(_)) => {
				Some(chat::resolve_model_provider(catalog, model.as_str(), None).map_err(composition)?)
			},
			(None, None) => None,
		};
		prompt_head.bind_provider(environment.extension_prompt_provider());
		let mut resource_roots =
			Vec::with_capacity(1 + options.additional_roots.len() + extension_specs.len());
		resource_roots.push(root.clone());
		resource_roots.extend(options.additional_roots.iter().cloned());
		resource_roots.extend(extension_specs.iter().filter_map(|extension| {
			extension.watch_root.clone().or_else(|| {
				extension
					.entry_path
					.as_ref()?
					.parent()
					.map(Path::to_path_buf)
			})
		}));
		prompt_discovery.content = discovery::gate_resources_discover(
			environment.admission_gate().as_ref(),
			discovery::DiscoverReason::Startup,
			&root,
			&resource_roots,
			&prompt_discovery_settings,
			prompt_discovery.content,
		)
		.await
		.map_err(composition)?;
		let grant = omp_env::InvocationGrant::unrestricted();
		let grant = if options.pty_denied {
			grant.deny_pty()
		} else {
			grant
		};
		let env = environment.client().with_invocation_grant(grant);
		let registry = registry_override.unwrap_or_else(|| environment.registry());
		let continue_latest = if policy.session == HeadlessSessionOpen::ContinueLatest {
			let page = environment
				.sessions_index()
				.list(&SessionFilter {
					project: Some(Str::from(root.to_string_lossy().as_ref())),
					limit: 1,
					..SessionFilter::default()
				})
				.map_err(composition)?;
			Some(
				page
					.sessions
					.first()
					.map(|session| session.id.0.clone())
					.ok_or_else(|| {
						composition(io::Error::new(
							io::ErrorKind::NotFound,
							"no durable headless session exists for this project",
						))
					})?,
			)
		} else {
			None
		};
		let open = match &policy.session {
			HeadlessSessionOpen::New => chat::SessionOpen::New,
			HeadlessSessionOpen::Resume(source) => chat::SessionOpen::Resume(source),
			HeadlessSessionOpen::Fork(source) => chat::SessionOpen::Fork(source),
			HeadlessSessionOpen::ContinueLatest => chat::SessionOpen::Resume(
				continue_latest
					.as_ref()
					.expect("latest session resolved above"),
			),
			HeadlessSessionOpen::Ephemeral => chat::SessionOpen::Ephemeral,
		};
		let mut session = chat::open_session(
			&root,
			&sessions_dir,
			open,
			registry.as_ref(),
			(policy.session != HeadlessSessionOpen::Ephemeral).then(|| environment.sessions_index()),
		)
		.map_err(composition)?;
		let env = env
			.with_principal(session.id.clone(), session.id.clone())
			.map_err(composition)?;
		let blueprint = chat::session_blueprint(
			model.as_str(),
			catalog,
			&root,
			&options.additional_roots,
			&session.id,
			Arc::clone(&registry),
		)
		.map_err(composition)?;
		let mut snapshot = chat::agent_snapshot(&blueprint, catalog, None).map_err(composition)?;
		if matches!(
			policy.session,
			HeadlessSessionOpen::Resume(_)
				| HeadlessSessionOpen::Fork(_)
				| HeadlessSessionOpen::ContinueLatest
		) {
			let journal_path = sessions_dir.join(format!("{}.jsonl", session.id.as_str()));
			let revived = omp_agent::revive_existing(&journal_path, session.journal, snapshot)
				.map_err(composition)?;
			session.journal = revived.journal;
			snapshot = revived.snapshot;
			if let Some(model) = revived.model_override
				&& !model.fallback
			{
				snapshot.turn.params.model =
					format!("{}/{}", model.model.provider.0, model.model.model.0);
			}
		}
		apply_tool_policy(&mut snapshot, &policy.tools, policy.lsp_enabled);
		let content = prompt_discovery.content;
		for warning in content.warnings.iter() {
			tracing::warn!(%warning, "headless content discovery warning");
		}
		let discovery_warnings = Arc::clone(&content.warnings);
		for diagnostic in prompt_discovery.context.diagnostics.iter() {
			tracing::warn!(?diagnostic, "headless context discovery warning");
		}
		let prompt_settings = settings_snapshot
			.project::<PromptSettings>()
			.map_err(composition)?
			.get()
			.clone()
			.resolve_inputs(&root, &home)
			.map_err(composition)?;
		let mut prompt_facts = blueprint.prompt_facts().clone();
		prompt_facts.settings = prompt_settings.clone().into();
		prompt_facts.model = omp_agent::ModelPromptInput {
			identifier:        Str::new(&snapshot.turn.params.model),
			codex_task_policy: crate::task::prompt_policy::uses_codex_task_prompt(
				&snapshot.turn.params.model,
			),
		};
		prompt_facts.context_files = context::prompt_files(&prompt_discovery.context);
		let prompt_rules = rulebook::prompt_inputs(&content.rules);
		let prompt_skills = if prompt_settings.skills_enabled {
			skills::prompt_inputs(&content.skills)
		} else {
			Arc::from([])
		};
		let prepared_prompt = PromptSnapshot::freeze(
			prompt_facts,
			registry.as_ref(),
			Some(&snapshot.enabled_tools),
			Arc::from([]),
			Default::default(),
			Default::default(),
			Default::default(),
			prompt_rules,
			prompt_skills,
			Arc::from([]),
		);
		let mut prompt_facts = prepared_prompt.workspace;
		let prepared =
			crate::prompt_prep::prepare_environment_inputs_bounded(&env, &session.journal, &root)
				.await;
		prompt_facts.host = prepared.host;
		prompt_facts.roots = prepared.roots;
		snapshot.props = prompt_facts.props().map_err(composition)?;
		let selected_model = catalog
			.model(omp_catalog::ModelKey::from_ref(&snapshot.turn.params.model))
			.or_else(|| catalog.resolve_alias(&snapshot.turn.params.model));
		let promotion_target = selected_model
			.and_then(|model| model.context_promotion_target.as_ref())
			.map(|target| Str::new(target.as_str()));
		let usable_context = chat::model_usable_context_window(catalog, &snapshot.turn.params.model)
			.unwrap_or(u64::MAX);
		let threshold_tokens =
			((usable_context as f64) * settings.compaction.threshold_fraction) as u64;
		let autolearn = omp_agent::AutolearnSettings {
			enabled:        settings.autolearn.enabled
				&& registry
					.devices()
					.any(|device| device.name.as_str() == "manage_skill"),
			auto_continue:  settings.autolearn.auto_continue,
			min_tool_calls: settings.autolearn.min_tool_calls,
		};
		let state = AgentState::new(snapshot);
		let (prompt_model, prompt_context_window) = {
			let snapshot = state.snapshot();
			(
				Str::from(snapshot.turn.params.model.as_str()),
				chat::model_context_window(catalog, &snapshot.turn.params.model).unwrap_or(0),
			)
		};
		let prompt_provider = prompt_model
			.split_once('/')
			.map_or_else(|| Str::new_static(""), |(provider, _)| Str::from(provider));
		let mut prompt_roots = Vec::with_capacity(1 + options.additional_roots.len());
		prompt_roots.push(Str::from(root.to_string_lossy().as_ref()));
		prompt_roots.extend(
			options
				.additional_roots
				.iter()
				.map(|root| Str::from(root.to_string_lossy().as_ref())),
		);
		prompt_head
			.activate(omp_envd::exthost::PromptPullContext {
				session_id:     session.id.clone(),
				model:          prompt_model,
				provider:       prompt_provider,
				context_window: prompt_context_window,
				epoch:          0,
				cwd:            Str::from(blueprint.options().cwd.to_string_lossy().as_ref()),
				roots:          prompt_roots,
				vcs_branch:     None,
				vcs_commit:     None,
				is_subagent:    false,
				agent_kind:     None,
			})
			.await
			.map_err(composition)?;
		state.update(|snapshot| {
			snapshot.prompt_source =
				prompt_head.wrap_prompt_source(Arc::clone(&snapshot.prompt_source));
		});
		let ProductionInference {
			registry: inference_registry,
			builtins: provider_builtins,
			rpc: inference,
			credential_authority,
			mcp_authority,
			mcp_oauth,
			auth_control,
			..
		} = production_inference_for_session(
			&data_dir,
			Arc::clone(&registry),
			Some(&root),
			InferenceSessionOverrides {
				provider:                credential_provider,
				api_key:                 options.api_key,
				prompt_cache_affinity:   options.prompt_cache_affinity,
				usage_fetchers:          Some(environment.usage_fetchers()),
				provider_response_hooks: Some(environment.provider_response_hooks()),
				catalog:                 catalog_override,
				settings:                Some(Arc::clone(&settings_snapshot)),
			},
		)
		.await
		.map_err(composition)?;
		let _ = search.bind(inference.clone());
		let _ = environment.github_credentials().bind(credential_authority);
		environment
			.bind_mcp_oauth(mcp_authority, mcp_oauth, auth_control.clone())
			.await
			.map_err(composition)?;
		let client = InProcTurnClient::new(inference)
			.await
			.map_err(composition)?;
		let tree = Arc::new(AgentTree::standard(8));
		let advisor_parent = Arc::new(chat::ChatParentHost::new_with_tree(
			client.clone(),
			env.clone(),
			state.clone(),
			session.id.clone(),
			sessions_dir.clone(),
			root.clone(),
			environment.sessions_index(),
			settings.security.enabled,
			Arc::clone(&tree),
		));
		advisor_parent.bind_admission_gate(environment.admission_gate());
		advisor_parent.bind_extension_reload(environment.extension_reload_handle());
		advisor_parent.set_prompt_discovery_settings(prompt_discovery_settings);
		if let Some(auto_thinking) = policy.auto_thinking {
			advisor_parent.set_auto_thinking_settings(auto_thinking);
		}
		let edit_repair_task = settings.tools.edit_auto_repair.then(|| {
			chat::spawn_edit_repair_service(Arc::clone(&advisor_parent), edit_repair_requests)
		});
		let journal_path = sessions_dir.join(format!("{}.jsonl", session.id.as_str()));
		let (ttsr, ttsr_diagnostics) = rulebook::ttsr_registry(content.rules.as_ref());
		for error in ttsr_diagnostics {
			tracing::warn!(%error, "headless TTSR rule condition was rejected");
		}
		let memory_lane = InferenceExtractionLane::from_settings(
			client.clone(),
			state.snapshot().turn.params.clone(),
			&settings.mnemopi,
			model_settings.memory_selector.as_str(),
		);
		if let Some(lane) = memory_lane.as_ref() {
			environment
				.reflection_bridge()
				.bind(Arc::new(lane.clone()))
				.map_err(composition)?;
		}
		let memory_extraction = memory_lane.map(|lane| {
			ExtractionWorker::start(
				environment.memory_runtime(),
				lane,
				settings.mnemopi.shutdown_timeout_ms,
			)
		});
		let approval_book = Arc::new(ApprovalBook::new());
		let control_root = sessions_dir.join(session.id.as_str()).join("control");
		let host_backends =
			EnvdHostOwnerBackends::production(&control_root, Arc::clone(&approval_book));
		let secrets = SecretSessionSnapshot::build(
			0,
			&data_dir.join("secrets.toml"),
			&root.join(".omp/secrets.toml"),
			std::iter::empty(),
		)
		.map_err(composition)?;
		let credential_factory = Arc::new(credential_secret_control_factory(
			auth_control.clone(),
			credential_control_grants(&extension_specs),
			&secrets,
		)) as Arc<dyn ControlAuthorityFactory>;
		let telemetry_index = Arc::new(
			TelemetryIndex::open(&state_dir.join("telemetry"), &state_dir.join("telemetry.sqlite3"))
				.map_err(composition)?,
		);
		let telemetry_query = Arc::new(TelemetryIndexQuery::new(telemetry_index, session.id.clone()));
		let telemetry_factory = telemetry_control_factory(telemetry_query);
		let prompt_factory = prompt_control_factory(prompt_head.clone());
		let provider_factory = provider_control_factory(
			inference_registry.clone(),
			provider_builtins,
			BlobStore::open(&data_dir).map_err(composition)?,
		);
		let mut agent =
			Agent::new(client, env.clone(), state.clone(), session.journal, chat::CHAT_CAPS_BASE);
		if settings.secrets.enabled {
			agent.set_secret_obfuscator(secrets.transform_handle());
		}
		agent.set_hook_gate(environment.admission_gate());
		if settings.tools.enabled("todo") {
			agent.add_stateful_component(Arc::new(omp_agent::TodoRestore));
		}
		if let Err(error) = agent.restore_session_state().await {
			tracing::warn!(%error, "journal-derived session state was not restored");
		}
		let compaction_methods = settings.compaction.method_order();
		let mid_turn_policy = omp_agent::MidTurnCompactionPolicy {
			enabled: settings.compaction.enabled && settings.compaction.mid_turn_enabled,
			threshold_tokens,
		};
		let retry_policy = state.snapshot().retry;
		if policy.auto_thinking.is_some() {
			agent.set_difficulty_classifier(advisor_parent.clone());
		}
		agent.set_session_memory(omp_memory::session::SessionMemory::top_level(
			environment.memory_runtime(),
		));
		agent.set_steering_mode(settings.interaction.steering_mode.into());
		agent.set_context_promotion(omp_agent::ContextPromotionPolicy {
			enabled: settings.context_promotion.enabled,
			target:  promotion_target,
		});
		agent.set_mid_turn_compaction(mid_turn_policy);
		agent.configure_streaming_edit_guard(root.clone(), settings.tools.edit_streaming_abort);
		agent.set_unexpected_stop_classifier(advisor_parent.clone());
		agent.set_autolearn(autolearn);
		blueprint.configure_agent(&mut agent);
		match production_redemption_authority(&state_dir) {
			Ok(Some(authority)) => agent.set_redemption_authority(authority),
			Ok(None) => {},
			Err(error) => {
				tracing::warn!(%error, "codex redemption authority was not constructed");
			},
		}
		agent.set_ttsr_registry(ttsr);
		agent
			.events()
			.set_session_generation(options.session_generation);
		let telemetry_firehose = agent.firehose();
		let control = agent.control();
		agent
			.recover_regimes(omp_agent::core_regime, now_ms())
			.map_err(composition)?;
		if let Some(spec_id) = options.initial_regime
			&& agent
				.arbiter()
				.regimes()
				.resources()
				.owner(&omp_agent::Resource::Mode)
				.is_none()
		{
			let (spec, regime) =
				omp_agent::core_regime(spec_id).expect("headless startup names a core regime");
			let mut spec = spec;
			if let Some(prompt_slot) = options.initial_prompt_slot {
				Arc::make_mut(&mut spec).sets = Arc::from([omp_agent::ScopedSetting {
					slot:  omp_agent::SettingSlot::PromptSlot,
					value: Str::new_static(prompt_slot),
				}]);
			}
			let _ = agent
				.start_regime(spec, regime, omp_agent::StartOptions { now_ms: now_ms(), queue: false })
				.map_err(composition)?;
		}
		let modes = Arc::new(RegimeHandle::new());
		let goal_binding = goal_control.bind(Arc::clone(&modes), control.clone());
		modes.sync_regimes(agent.arbiter().regimes());
		modes.bind_plan_selection(state.clone(), None);
		if let Some(handoff) = options.plan_handoff.clone() {
			modes.bind_plan_handoff(handoff);
		}
		state.update(|snapshot| {
			snapshot.prompt_source = modes.prompt_source(Arc::clone(&snapshot.prompt_source));
		});
		agent.set_continuation_source(modes.clone());
		let node = tree
			.register(
				session.id.clone(),
				sf!("Main"),
				AgentKind::Main,
				None,
				session.id.clone(),
				Budget::default(),
			)
			.map_err(composition)?;
		node.set_status(AgentStatus::Running);
		advisor_parent.bind_agent_controls(
			session.id.clone(),
			agent.host_control(),
			agent.control(),
			agent.abort_handle(),
			agent.events().clone(),
		);
		let session_handle = blueprint
			.launch(
				SessionIdentity { id: session.id.clone(), journal_path, expected_revision: None },
				SessionRuntime::from_agent(agent),
				None,
				None,
			)
			.map_err(composition)?;
		let regime_factory = chat::extension_regime_control_factory(
			control.clone(),
			environment.extension_regime_resolver(),
		);
		let external_control = environment.bind_external_control_authorities(
			chat::AgentsControlAuthority::factory(Arc::clone(&advisor_parent)),
			omp_envd::exthost::ExternalDomainControlFactories {
				policy:            Some(host_backends.policy_factory),
				parameters:        Some(host_backends.parameter_factory),
				workers:           Some(host_backends.worker_factory),
				direct_filesystem: Some(host_backends.direct_filesystem_factory),
				credentials:       Some(credential_factory),
				prompts:           Some(prompt_factory),
				sessions:          None,
				ui:                None,
				telemetry:         Some(telemetry_factory),
				jobs:              None,
				provider:          Some(provider_factory),
				regimes:           Some(regime_factory),
				services:          None,
			},
		);
		let telemetry_tasks =
			bind_extension_telemetry(&environment, &telemetry_firehose, &session.id);
		let journal_control = environment
			.bind_agent_control(control.clone())
			.map_err(composition)?;
		let eval_parent_control = environment
			.bind_eval_sdk_parent(advisor_parent.session_id(), advisor_parent.clone())
			.map_err(composition)?;
		let events = session_handle.subscribe_lossless();
		let (lifecycle, lifecycle_events) = HeadlessLifecycleSink::new(options.session_generation);
		let (approval_route, approval_inbox) =
			ApprovalRoute::new(Arc::clone(&approval_book), Some(environment.admission_gate()));
		advisor_parent.bind_spawn_approval_route(approval_route.clone());
		environment
			.bind_approval_authority(Some(Arc::clone(&approval_book)), Some(approval_route.clone()));
		Ok(Self {
			session: session_handle,
			advisor_parent,
			advise_queue,
			state,
			control,
			env,
			regimes: modes,
			tree,
			events: Some(events),
			lifecycle,
			lifecycle_events: Some(lifecycle_events),
			approval_book,
			approval_route,
			approval_inbox: Some(approval_inbox),
			finalizer: HeadlessFinalizerHandle::new(),
			_goal_binding: goal_binding,
			session_id: session.id,
			discovery_warnings,
			initial_items: session.initial_items,
			_inference_registry: inference_registry,
			_catalog: catalog_owner,
			_edit_repair_task: edit_repair_task,
			_telemetry_tasks: telemetry_tasks,
			_memory_extraction: memory_extraction,
			_ephemeral_sessions: ephemeral_sessions,
			_tool_policy: policy.tools,
			_lsp_enabled: policy.lsp_enabled,
			_compaction_methods: compaction_methods,
			_mid_turn_policy: mid_turn_policy,
			_retry_policy: retry_policy,
			_forced_tool: Mutex::new(None),
			_external_control: external_control,
			_journal_control: journal_control,
			_eval_parent_control: eval_parent_control,
			_environment: environment,
		})
	}

	/// Submits caller-authored items through the durable agent loop.
	pub async fn submit(
		&mut self,
		items: impl IntoIterator<Item = Item>,
		turn_id: TurnId,
	) -> Result<AgentRunSummary, HeadlessError> {
		let mut items = items.into_iter().collect::<Vec<_>>();
		self
			.advisor_parent
			.admit_user_input(&mut items, "rpc", false)
			.await
			.map_err(|denial| {
				composition(io::Error::new(io::ErrorKind::PermissionDenied, denial.reason.to_string()))
			})?;
		let forced = self._forced_tool.lock().take();
		let previous = forced
			.as_ref()
			.map(|_| self.state.snapshot().turn.params.tool_choice.clone());
		if let Some(name) = forced {
			self.state.update(|snapshot| {
				snapshot.turn.params.tool_choice = Some(v1::ToolChoice {
					mode:           v1::tool_choice::Mode::Named as i32,
					name:           name.to_string(),
					on_unsupported: v1::Fallback::Error as i32,
				});
			});
		}
		let result = self
			.session
			.submit(items, turn_id)
			.await
			.map_err(composition);
		if let Some(previous) = previous {
			self
				.state
				.update(|snapshot| snapshot.turn.params.tool_choice = previous);
		}
		result
	}

	/// Gates one direct headless shell command before execution.
	pub async fn admit_user_bash(
		&self,
		command: &str,
		cwd: &Path,
	) -> Result<(Str, omp_core::EnvPath, BTreeMap<String, Option<String>>), omp_tool::PolicyDenied>
	{
		self
			.advisor_parent
			.admit_user_bash(command, cwd, true)
			.await
	}

	/// Gates one parsed headless extension command before handler dispatch.
	pub async fn admit_command_invoke(
		&self,
		name: &str,
		argv: &[Str],
		raw: &str,
		mode: &'static str,
		source: &'static str,
	) -> Result<(Str, Vec<Str>), omp_tool::PolicyDenied> {
		self
			.advisor_parent
			.admit_command_invoke(name, argv, raw, mode, source)
			.await
	}

	/// Forces one exact registered tool for the next submitted turn only.
	pub fn force_tool_once(&self, name: Str) -> Result<(), HeadlessError> {
		if !self.state.snapshot().enabled_tools.contains(&name) {
			return Err(composition(io::Error::new(
				io::ErrorKind::NotFound,
				format!("tool `{name}` is not enabled"),
			)));
		}
		*self._forced_tool.lock() = Some(name);
		Ok(())
	}

	/// Enables or disables automatic and mid-turn compaction immediately.
	pub fn set_auto_compaction(&self, enabled: bool) {
		self.state.update(|snapshot| {
			snapshot.compaction = if enabled {
				self._compaction_methods.clone()
			} else {
				omp_agent::CompactionMethodOrder::resolve(&[])
			};
			snapshot.mid_turn_compaction = if enabled {
				self._mid_turn_policy
			} else {
				omp_agent::MidTurnCompactionPolicy { enabled: false, ..self._mid_turn_policy }
			};
		});
	}

	/// Enables configured turn retries or restricts execution to one attempt.
	pub fn set_auto_retry(&self, enabled: bool) {
		let retry = if enabled {
			self._retry_policy
		} else {
			omp_agent::RetryPolicy::new(
				std::num::NonZeroU32::new(1).expect("one is non-zero"),
				std::time::Duration::ZERO,
				std::time::Duration::ZERO,
			)
			.expect("one-attempt retry policy is valid")
		};
		self.state.update(|snapshot| snapshot.retry = retry);
	}

	/// Aborts an active retry/submission immediately.
	pub fn abort_retry(&self) {
		self.interrupt();
	}

	/// Selects provider priority service or restores provider-default service.
	pub fn set_fast_mode(&self, enabled: bool) {
		self.state.update(|snapshot| {
			snapshot.turn.params.service_tier = if enabled {
				v1::ServiceTier::Priority as i32
			} else {
				v1::ServiceTier::Unspecified as i32
			};
		});
	}

	/// Rewinds and resubmits the latest durable user turn.
	pub async fn retry_last_turn(
		&self,
		turn_id: TurnId,
	) -> Result<Option<(Vec<Item>, Str, AgentRunSummary)>, omp_sdk::SessionHandleError> {
		self.session.retry_last_turn(turn_id).await
	}

	/// Executes and durably commits one manual compaction.
	pub async fn compact_manual(
		&self,
		request: omp_agent::ManualCompactionRequest,
	) -> Result<omp_agent::ManualCompactionOutcome, omp_sdk::SessionHandleError> {
		self.session.compact_manual(request).await
	}

	/// Returns the durable session identifier.
	pub fn session_id(&self) -> &str {
		self.session_id.as_str()
	}

	/// Returns startup discovery diagnostics for the presentation adapter.
	pub fn discovery_warnings(&self) -> &[Str] {
		&self.discovery_warnings
	}

	/// Returns the session-local parent authority used by persistent advisor
	/// children.
	pub fn advisor_parent(&self) -> Arc<chat::ChatParentHost<InProcTurnClient>> {
		Arc::clone(&self.advisor_parent)
	}

	/// Clone-shared session queue backing the environment's `advise@1` device.
	pub fn advise_queue(&self) -> omp_agent::advisor::AdvisorAdviceQueue {
		self.advise_queue.clone()
	}

	/// Returns the canonical Environment-owned native tool registry.
	pub fn tool_registry(&self) -> Arc<omp_tool::Registry> {
		self._environment.registry()
	}

	/// Returns the live extension-generation replacement authority.
	pub fn extension_reload_handle(&self) -> omp_envd::ExtensionReloadHandle {
		self._environment.extension_reload_handle()
	}

	/// Atomically replaces one attached host's model-visible tool roster.
	///
	/// Subsequent calls in the same durable session advertise and execute the
	/// replacement generation through the ordinary agent tool loop.
	pub fn replace_host_tools(
		&self,
		claimant: Str,
		roster_revision: u64,
		specs: Vec<omp_tool::HostToolSpec>,
		executor: Arc<dyn omp_tool::HostToolExecutor>,
	) -> Result<(), HeadlessError> {
		let registry = self._environment.registry();
		registry
			.replace_host_tools(claimant, roster_revision, specs, executor)
			.map_err(composition)?;
		let advertised = if chat::model_rejects_tools(
			self._catalog.as_ref(),
			self.state.snapshot().turn.params.model.as_str(),
		) {
			Vec::new()
		} else {
			registry
				.advertise(omp_tool::LoweringCaps {
					strict_schema:  true,
					grammar:        omp_catalog::GrammarBits::ALL,
					maximum_tools:  None,
					maximum_strict: None,
				})
				.map_err(composition)?
		};
		let mut names = Vec::new();
		let mut tools = Vec::new();
		for tool in advertised {
			let name = &tool.identity.name;
			let selected = self._lsp_enabled || name != "lsp";
			let selected = selected
				&& match &self._tool_policy {
					HeadlessToolPolicy::All => true,
					HeadlessToolPolicy::None => false,
					HeadlessToolPolicy::Only(allowed) => allowed.contains(name),
				};
			if selected {
				names.push(name.clone());
				tools.push(chat::protocol_tool_definition(tool.definition).map_err(composition)?);
			}
		}
		self.state.update(|snapshot| {
			snapshot.registry = Arc::clone(&registry);
			snapshot.enabled_tools = names.into();
			snapshot.turn.params.tools = tools;
		});
		Ok(())
	}

	/// Lists model-callable environment tools available to advisor grant
	/// evaluation.
	pub fn available_tool_names(&self) -> Vec<Str> {
		self
			._environment
			.registry()
			.devices()
			.map(|device| device.name.clone())
			.collect()
	}

	/// Returns the canonical replay projection loaded before the first turn.
	pub fn initial_items(&self) -> &[Item] {
		&self.initial_items
	}

	/// Returns the Environment client owned alongside the agent.
	pub const fn env(&self) -> &omp_env::EnvClient {
		&self.env
	}

	/// Binds or clears the session-scoped ACP terminal execution capability.
	pub fn bind_acp_exec(&self, backend: Option<Arc<dyn omp_envd::tool_shell::AcpExecBackend>>) {
		self._environment.bind_acp_exec(backend);
	}

	/// Binds or clears the session-scoped ACP document capability.
	pub fn bind_acp_documents(&self, backend: Option<Arc<dyn omp_envd::docs::AcpDocumentBackend>>) {
		self._environment.bind_acp_documents(backend);
	}

	/// Replaces the session environment's ask presentation bridge.
	pub fn bind_ask_presenter(&self, presenter: Arc<dyn omp_tools::ask::AskPresenter>) {
		self._environment.bind_ask_presenter(presenter);
	}

	/// Binds or clears the durable approval authority.
	pub fn bind_approval_authority(
		&self,
		book: Option<Arc<ApprovalBook>>,
		route: Option<ApprovalRoute>,
	) {
		self._environment.bind_approval_authority(book, route);
	}

	/// Returns the current session-effective model selector.
	pub fn model(&self) -> Str {
		Str::new(self.state.snapshot().turn.params.model.as_str())
	}

	/// Applies a validated session-only model override and records it in the
	/// owning v4 journal before changing the live snapshot.
	pub async fn set_model(&self, selector: &str) -> Result<(), HeadlessError> {
		let catalog = self._catalog.as_ref();
		let model = chat::resolve_model_selector(catalog, selector).map_err(composition)?;
		let spec = catalog
			.model(ModelKey::from_ref(model.as_str()))
			.ok_or_else(|| HeadlessError::UnknownModel(Str::new(selector)))?;
		let route = spec
			.routes
			.first()
			.and_then(|route| catalog.route(route))
			.ok_or_else(|| HeadlessError::MissingRoute(Str::new(selector)))?;
		self
			.session
			.model_override(now_ms(), JournalModelChange {
				role:     sf!("temporary"),
				model:    JournalModelRef {
					provider: JournalProviderId(Str::new(route.provider.as_str())),
					api:      Str::new(route.codec.as_str()),
					model:    JournalModelId(Str::new(spec.key.as_str())),
				},
				fallback: false,
			})
			.await
			.map_err(composition)?;
		self.state.update(|snapshot| {
			snapshot.turn.params.model = model.to_string();
			let mut fields = match snapshot.props.get(omp_agent::prompt_keys::MODEL) {
				Some(omp_scribe::Value::Map(fields)) => fields.clone(),
				_ => Default::default(),
			};
			fields.insert(
				Str::new_static(omp_agent::prompt_keys::IDENTIFIER),
				omp_scribe::Value::from(Str::new(selector)),
			);
			fields.insert(
				Str::new_static("codex_task_policy"),
				omp_scribe::Value::from(crate::task::prompt_policy::uses_codex_task_prompt(selector)),
			);
			snapshot
				.props
				.set(omp_agent::prompt_keys::MODEL, omp_scribe::Value::Map(fields));
		});
		Ok(())
	}

	/// Replaces the session-only provider reasoning request after the ACP host
	/// has clamped it through the selected model policy.
	pub fn set_thinking(&self, thinking: Option<v1::Reasoning>) {
		self
			.state
			.update(|snapshot| snapshot.turn.params.thinking = thinking);
	}

	/// Installs a strict command-owned JSON response schema for later turns.
	pub(crate) fn set_response_schema(
		&self,
		name: &'static str,
		schema: serde_json::Value,
	) -> Result<(), serde_json::Error> {
		let schema_json = serde_json::to_vec(&schema)?;
		self.state.update(|snapshot| {
			snapshot.turn.params.response_format = Some(v1::ResponseFormat {
				kind:           Some(response_format::Kind::JsonSchema(response_format::JsonSchema {
					name:        name.to_owned(),
					schema_json: schema_json.into(),
					strict:      Some(true),
				})),
				on_unsupported: v1::Fallback::Error as i32,
			});
		});
		Ok(())
	}

	/// Interrupts the active caller submission without waiting for settlement.
	pub fn interrupt(&self) {
		self.session.interrupt();
	}

	/// Returns a cheap interrupt-only capable clone of the durable handle.
	///
	/// Protocol hosts use this before borrowing the session mutably for a
	/// submission so cancellation never contends on their session mutex.
	pub fn interrupt_handle(&self) -> SessionHandle {
		self.session.clone()
	}

	/// Records a user-visible session title through the sole journal owner.
	pub async fn set_title(&self, title: Str) -> Result<(), HeadlessError> {
		self
			.control
			.set_title(now_ms(), title)
			.await
			.map_err(composition)?;
		Ok(())
	}

	/// Returns the session-scoped regime projection.
	pub fn regimes(&self) -> &RegimeHandle {
		self.regimes.as_ref()
	}

	/// Starts a built-in regime on the actor-owned regime set.
	pub async fn start_regime(
		&self,
		spec_id: &'static str,
		queue: bool,
	) -> Result<omp_agent::StartReceipt, omp_sdk::SessionHandleError> {
		let (spec, regime) =
			omp_agent::core_regime(spec_id).expect("headless command names a built-in regime");
		let (receipt, entries) = self
			.session
			.start_regime(spec, regime, omp_agent::StartOptions { now_ms: now_ms(), queue })
			.await?;
		self.regimes.sync_records(&entries);
		Ok(receipt)
	}

	/// Stops an active regime on the actor-owned regime set.
	pub async fn stop_regime(&self, activation: Str) -> Result<bool, omp_sdk::SessionHandleError> {
		let (removed, entries) = self.session.stop_regime(activation, now_ms()).await?;
		self.regimes.sync_records(&entries);
		Ok(removed)
	}

	/// Returns the append-only agent roster.
	pub fn tree(&self) -> &Arc<AgentTree> {
		&self.tree
	}

	/// Takes the single ordered lossless agent-event subscription.
	pub fn take_events(&mut self) -> Option<EventSubscription> {
		self.events.take()
	}

	/// Returns the generation-fenced extension lifecycle sink.
	pub const fn lifecycle_sink(&self) -> &HeadlessLifecycleSink {
		&self.lifecycle
	}

	/// Takes the single lossless extension lifecycle subscription.
	pub fn take_lifecycle_events(&mut self) -> Option<HeadlessLifecycleSubscription> {
		self.lifecycle_events.take()
	}

	/// Returns the durable approval book.
	pub fn approval_book(&self) -> &Arc<ApprovalBook> {
		&self.approval_book
	}

	/// Returns the awaitable approval route.
	pub const fn approval_route(&self) -> &ApprovalRoute {
		&self.approval_route
	}

	/// Takes the single host-facing approval inbox.
	pub fn take_approval_inbox(&mut self) -> Option<ApprovalInbox> {
		self.approval_inbox.take()
	}

	/// Returns the session-owned finalizer for authority registration.
	pub const fn finalizer_mut(&mut self) -> &mut HeadlessFinalizerHandle {
		&mut self.finalizer
	}

	/// Disposes the live session without running mode-specific finalizers.
	pub async fn dispose(&mut self) {
		if let Some(worker) = self._memory_extraction.as_mut() {
			worker.shutdown().await;
		}
		let _ = self.session.dispose().await;
	}

	/// Runs ordered bounded finalization. Dropping this session afterward
	/// disposes the agent and Environment last.
	pub async fn finalize<W>(&mut self, stdout: &mut W, budget: FinalizerBudget) -> FinalizerReport
	where
		W: io::AsyncWrite + Unpin,
	{
		let report = mem::take(&mut self.finalizer)
			.finalize(stdout, budget)
			.await;
		if let Some(worker) = self._memory_extraction.as_mut() {
			worker.shutdown().await;
		}
		let _ = self.session.dispose().await;
		report
	}

	/// Publishes an additional event through the session's generation-stamped
	/// event bus. Intended for typed mode transitions owned by protocol hosts.
	pub fn publish(&self, event: AgentEvent) {
		self.session.publish(event);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn duplicate_extension_host_keys_fail_before_environment_freeze() {
		let key = omp_envd::worker::HostKey::new("project", "trusted", "example/tool");
		let error = validate_extension_host_keys([&key, &key]).expect_err("duplicate rejected");
		assert_eq!(error.to_string(), "headless session composition failed");
		let HeadlessError::Composition(source) = error else {
			panic!("duplicate key must be a composition error");
		};
		assert_eq!(
			source.to_string(),
			"duplicate extension host identity: HostKey { layer: \"project\", tier: \"trusted\", \
			 extension: \"example/tool\" }",
		);
	}

	#[test]
	fn distinct_extension_host_keys_are_admitted() {
		let first = omp_envd::worker::HostKey::new("project", "trusted", "example/one");
		let second = omp_envd::worker::HostKey::new("user", "trusted", "example/one");
		validate_extension_host_keys([&first, &second]).expect("distinct scoped keys");
	}
}

fn now_ms() -> u64 {
	use std::time::{SystemTime, UNIX_EPOCH};

	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}
