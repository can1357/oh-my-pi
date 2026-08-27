//! Durable non-interactive session assembly shared by print, RPC, and ACP.

pub mod finalize;

use std::{
	collections::BTreeSet,
	env, fmt, io, mem,
	path::{Path, PathBuf},
	sync::Arc,
};

use omp_agent::{
	AbortDisposition, Agent, AgentEvent, AgentKind, AgentRunSummary, AgentSnapshot, AgentState,
	AgentStatus, AgentTree, ApprovalBook, ApprovalInbox, ApprovalRoute, Budget, EventSubscription,
	InProcTurnClient, Journal, TurnId,
};
use omp_catalog::{ModelKey, ProviderId, snapshot};
use omp_core::{SecretString, Str, sf};
use omp_inference::Registry as InferenceRegistry;
use omp_proto::thread::v1::Item;
use omp_sdk::{ProductionSessionError, SessionHandle, SessionIdentity, SessionRuntime};
use omp_settings::manager::{MutationScope, SettingsManager, SettingsManagerError, SettingsPaths};
use omp_storage::{
	index::SessionFilter,
	transcript::{
		ModelChange as JournalModelChange, ModelId as JournalModelId, ModelRef as JournalModelRef,
		ProviderId as JournalProviderId,
	},
};
use parking_lot::Mutex;

use self::finalize::{FinalizerBudget, FinalizerReport, HeadlessFinalizerHandle};
/// Typed failure while composing or mutating a headless session.
///
/// Every variant names the composition step that failed and carries the
/// step's own error typed as its source. Sources stay inline (never boxed),
/// so `chat::ChatError` at 120 bytes is the floor-setter of the enum's size:
/// slimming `ChatError`/`SettingsManagerError` shrinks the pinned bound below.
#[derive(Debug, thiserror::Error)]
pub enum HeadlessError {
	/// The project root could not be canonicalized.
	#[error("could not canonicalize the project root")]
	CanonicalProject(#[source] chat::ChatError),
	/// The production model catalog could not be assembled.
	#[error("could not build the production model catalog")]
	ProductionCatalog(#[source] RegistryError),
	/// A typed settings domain could not be projected from the snapshot.
	#[error("could not project settings")]
	SettingsProjection(#[source] omp_settings::SnapshotError),
	/// The Environment client could not be bound to the session principal.
	#[error("could not bind the session principal")]
	EnvPrincipal(#[source] omp_env::ClientError),
	/// An ephemeral session was asked to use a durable sessions directory.
	#[error("ephemeral headless sessions cannot use a durable sessions directory")]
	EphemeralSessionsDirectory,
	/// The ephemeral sessions directory could not be created.
	#[error("could not create an ephemeral sessions directory")]
	EphemeralSessions(#[source] chat::ChatError),
	/// The requested model selector could not be resolved against the catalog.
	#[error("could not resolve model selector")]
	ResolveModelSelector(#[source] chat::ChatError),
	/// Session settings could not be loaded.
	#[error(transparent)]
	Settings(#[from] SettingsManagerError),
	/// The project state directory could not be derived.
	#[error("could not derive the project state directory {path:?}")]
	ProjectStateDirectory {
		/// Project root whose state directory was being opened.
		path:   PathBuf,
		/// Underlying state-directory error.
		#[source]
		source: io::Error,
	},
	/// A session state directory could not be created.
	#[error("could not create session state directory")]
	EnsureStateDirectory(#[source] chat::ChatError),
	/// The project environment authority failed to start or connect.
	#[error(transparent)]
	Environment(#[from] omp_envd::EnvdError),
	/// The durable session could not be opened, resumed, or forked.
	#[error("could not open session")]
	OpenSession(#[source] chat::ChatError),
	/// The shared SDK session blueprint could not be planned.
	#[error("could not plan the session blueprint")]
	SessionBlueprint(#[source] chat::ChatError),
	/// The initial agent snapshot could not be projected.
	#[error("could not project the agent snapshot")]
	AgentSnapshot(#[source] chat::ChatError),
	/// Cross-process loop revival failed.
	#[error(transparent)]
	Revival(#[from] omp_agent::RevivalError),
	/// The production inference stack could not be assembled.
	#[error(transparent)]
	ProductionInference(#[from] RegistryError),
	/// The in-process turn authority could not be constructed.
	#[error(transparent)]
	TurnClient(#[from] omp_agent::Error),
	/// Two extension hosts declared the same layer, tier, and extension.
	#[error(
		"duplicate extension host identity: {}/{}/{}",
		.key.layer(),
		.key.tier(),
		.key.extension()
	)]
	DuplicateExtensionHost {
		/// Identity declared by two attached extension hosts.
		key: omp_envd::worker::HostKey,
	},
	/// The sessions index could not be listed for the latest durable session.
	#[error("could not list the sessions index")]
	SessionsIndex(#[source] omp_storage::index::Error),
	/// No durable headless session exists for the project to continue.
	#[error("no durable headless session exists for this project")]
	NoDurableSession,
	/// Prompt customization inputs could not be resolved from files or inline
	/// text.
	#[error("could not resolve prompt inputs")]
	PromptInputs(#[source] crate::prompt_input::PromptInputError),
	/// The prompt property bag could not be projected from the frozen facts.
	#[error("could not project the prompt properties")]
	PromptProperties(#[source] omp_agent::PromptError),
	/// The memory reflection bridge could not be bound to the extraction lane.
	#[error("could not bind the reflection bridge")]
	ReflectionBridge(#[source] omp_envd::memory::ReflectionBindingError),
	/// The requested tool is not enabled for the next submitted turn.
	#[error("tool `{name}` is not enabled")]
	DisabledTool {
		/// Disabled tool name.
		name: Str,
	},
	/// One attached host's model-visible tool roster could not be replaced.
	#[error("could not replace the host tools")]
	ReplaceHostTools(#[source] omp_tool::RegistryError),
	/// The replacement generation could not be advertised to the model.
	#[error("could not advertise the host tools")]
	AdvertiseTools(#[source] omp_tool::RegistryError),
	/// A lowered tool definition could not be converted for the protocol.
	#[error("could not lower the protocol tool definition")]
	ProtocolToolDefinition(#[source] chat::ChatError),
	/// Durable regime activations could not be recovered.
	#[error("could not recover regimes")]
	RecoverRegimes(#[source] omp_agent::AgentError),
	/// The initial regime could not be started.
	#[error("could not start regime")]
	StartRegime(#[source] omp_agent::AgentError),
	/// The main agent node could not be registered in the tree.
	#[error(transparent)]
	RegisterAgent(#[from] omp_agent::SpawnRefusal),
	/// The durable session handle could not be launched.
	#[error("could not launch the session")]
	LaunchSession(#[source] ProductionSessionError),
	/// A validated session model override could not be journaled.
	#[error("could not journal the model override")]
	ModelOverride(#[source] omp_agent::ControlError),
	/// The session title could not be journaled.
	#[error("could not journal the session title")]
	SetTitle(#[source] omp_agent::ControlError),
	/// No model in the embedded catalog can be selected for a revived session.
	#[error("no selectable model is available to resume")]
	NoSelectableModel,
	/// The requested model selector was not present in the embedded catalog.
	#[error("unknown model `{0}`")]
	UnknownModel(Str),
	/// The selected model had no usable route.
	#[error("model `{0}` has no selectable route")]
	MissingRoute(Str),
}

const _: () = assert!(
	mem::size_of::<HeadlessError>() <= 128,
	"HeadlessError must stay at the natural ChatError-derived size; slim \
	 ChatError/SettingsManagerError to shrink this"
);

/// Operator-relevant notices produced while composing a headless session.
///
/// Driver composition publishes these so app adapters decide presentation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HeadlessNotice {
	/// Journaled or launch selector that could not be selected.
	pub saved:    Str,
	/// Deterministic catalog fallback used for this process.
	pub fallback: Str,
}

impl fmt::Display for HeadlessNotice {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			formatter,
			"Session model `{}` is unavailable; resumed with `{}` without changing the session pin.",
			self.saved, self.fallback
		)
	}
}

use omp_envd::exthost::lifecycle::{HeadlessLifecycleSink, HeadlessLifecycleSubscription};
use omp_proto::inference::{v1, v1::response_format};
use tokio::io::AsyncWrite;

use crate::{
	bridges::{AgentGoalBinding, AgentGoalControl, InferenceBridge, builtin_with_content},
	chat::{self},
	discovery,
	discovery::context,
	memory::{ExtractionWorker, InferenceExtractionLane},
	modes::RegimeHandle,
	prompt_prep::{PromptSnapshot, settings::PromptSettings},
	registry::{
		InferenceSessionOverrides, ProductionInference, RegistryError,
		production_inference_for_session, production_redemption_authority,
	},
	rulebook,
	settings::Settings,
	skills,
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
			return Err(HeadlessError::DuplicateExtensionHost { key: key.clone() });
		}
	}
	Ok(())
}

/// Single owner of every authority needed by a non-interactive agent loop.
///
/// Rust drops fields in declaration order. `environment_bound` owns the live
/// session (`SessionHandle`) and is declared before `approval_book`,
/// `approval_route`, `approval_inbox`, and `_goal_binding` so the session
/// interrupts before any host binding that the still-running actor may observe.
/// It remains before `_ephemeral_sessions` so live session resources do not
/// borrow the temporary directory after it has been removed, and `_environment`
/// remains the final drop so the Environment outlives every authority that
/// borrows it.
pub struct HeadlessSession {
	advise_queue:        omp_agent::advisor::AdvisorAdviceQueue,
	state:               AgentState,
	control:             omp_agent::ControlSender,
	regimes:             Arc<RegimeHandle>,
	tree:                Arc<AgentTree>,
	events:              Option<EventSubscription>,
	lifecycle:           HeadlessLifecycleSink,
	lifecycle_events:    Option<HeadlessLifecycleSubscription>,
	environment_bound:   EnvironmentBound,
	approval_book:       Arc<ApprovalBook>,
	approval_route:      ApprovalRoute,
	approval_inbox:      Option<ApprovalInbox>,
	finalizer:           HeadlessFinalizerHandle,
	_goal_binding:       AgentGoalBinding,
	session_id:          Str,
	initial_items:       Vec<Item>,
	notices:             Vec<HeadlessNotice>,
	_inference_registry: InferenceRegistry,
	_catalog:            Arc<snapshot::Catalog>,
	_memory_extraction:  Option<ExtractionWorker>,
	_tool_policy:        HeadlessToolPolicy,
	_lsp_enabled:        bool,
	_compaction_methods: omp_agent::CompactionMethodOrder,
	_mid_turn_policy:    omp_agent::MidTurnCompactionPolicy,
	_retry_policy:       omp_agent::RetryPolicy,
	_forced_tool:        Mutex<Option<Str>>,
	_ephemeral_sessions: Option<chat::EphemeralSessions>,
	_environment:        omp_envd::ProjectEnvironment,
}

/// Every authority that borrows the project Environment.
///
/// Held in one field so the Environment cannot be dropped first: this struct
/// is declared before `_environment`, and Rust drops fields in declaration
/// order.
struct EnvironmentBound {
	session:           SessionHandle,
	advisor_parent:    Arc<chat::ChatParentHost<InProcTurnClient>>,
	env:               omp_env::EnvClient,
	_edit_repair_task: Option<tokio::task::JoinHandle<()>>,
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

	/// Derives the effective model for the requested open without creating or
	/// modifying durable session state. Callers can validate per-model options
	/// before calling `open_with_policy`.
	pub fn preview_effective_model(
		data_dir: &Path,
		options: &HeadlessSessionOptions,
		policy: &HeadlessLaunchPolicy,
	) -> Result<Str, HeadlessError> {
		let root =
			chat::canonical_project(&options.project).map_err(HeadlessError::CanonicalProject)?;
		let home = env::var_os("HOME").map_or_else(|| root.clone(), PathBuf::from);
		let catalog_owner =
			crate::registry::production_catalog(data_dir).map_err(HeadlessError::ProductionCatalog)?;
		let catalog = catalog_owner.as_ref();
		let mut settings_paths = SettingsPaths::discover(data_dir, Some(&root));
		settings_paths
			.overlays
			.extend(options.settings_overlays.iter().cloned());
		let settings_manager = SettingsManager::open(settings_paths)?;
		let settings_snapshot = settings_manager.snapshot();
		let model_settings = settings_snapshot
			.project::<omp_catalog::settings::ModelSettings>()
			.map_err(HeadlessError::SettingsProjection)?
			.get()
			.resolve_path_scopes(&root, &home);

		let model = chat::resolve_model_selector(catalog, options.model.as_str())
			.map_err(HeadlessError::ResolveModelSelector)?;
		if matches!(&policy.session, HeadlessSessionOpen::New | HeadlessSessionOpen::Ephemeral)
			&& !crate::discovery::roles::model_selector_allowed(
				catalog,
				&model_settings,
				model.as_str(),
			) {
			return Err(HeadlessError::MissingRoute(model));
		}

		if matches!(&policy.session, HeadlessSessionOpen::New | HeadlessSessionOpen::Ephemeral) {
			return Ok(model);
		}

		let state_dir = omp_env::project_state::directory(data_dir, &root)
			.map_err(|source| HeadlessError::ProjectStateDirectory { path: root.clone(), source })?;
		let sessions_dir = match (&policy.session, policy.sessions_dir.as_ref()) {
			(HeadlessSessionOpen::Ephemeral, Some(_)) => {
				return Err(HeadlessError::EphemeralSessionsDirectory);
			},
			(HeadlessSessionOpen::Ephemeral, None) => {
				let owner =
					chat::EphemeralSessions::create().map_err(HeadlessError::EphemeralSessions)?;
				owner.path().to_owned()
			},
			(_, Some(directory)) => directory.clone(),
			(_, None) => state_dir.join("sessions"),
		};

		let source = match &policy.session {
			HeadlessSessionOpen::Resume(source) | HeadlessSessionOpen::Fork(source) => {
				Some(source.clone())
			},
			HeadlessSessionOpen::ContinueLatest => {
				let index =
					omp_storage::index::SessionIndex::open(sessions_dir.join("sessions.sqlite3"))
						.map_err(HeadlessError::SessionsIndex)?;
				let page = index
					.list(&SessionFilter {
						project: Some(Str::from(root.to_string_lossy().as_ref())),
						limit: 1,
						..SessionFilter::default()
					})
					.map_err(HeadlessError::SessionsIndex)?;
				Some(
					page
						.sessions
						.first()
						.map(|session| session.id.0.clone())
						.ok_or(HeadlessError::NoDurableSession)?,
				)
			},
			_ => None,
		};
		let source = source.expect("resume/fork/continue have a source");
		let journal_path = sessions_dir.join(format!("{}.jsonl", source.as_str()));
		let journal =
			Journal::open(&journal_path).map_err(|error| HeadlessError::Revival(error.into()))?;
		let registry = Arc::new(omp_tool::Registry::new());
		let session_id = sf!("preview");
		let blueprint = chat::session_blueprint(
			model.as_str(),
			catalog,
			&root,
			&options.additional_roots,
			&session_id,
			Arc::clone(&registry),
		)
		.map_err(HeadlessError::SessionBlueprint)?;
		let snapshot =
			chat::agent_snapshot(&blueprint, catalog, None).map_err(HeadlessError::AgentSnapshot)?;
		let revived = omp_agent::revive_existing(&journal_path, journal, snapshot)
			.map_err(HeadlessError::Revival)?;
		let mut snapshot = revived.snapshot;
		apply_revived_session_model(
			&mut snapshot,
			catalog,
			revived.model_override.as_ref(),
			&root,
			&options.additional_roots,
			&model_settings,
			options.credential_provider.as_ref(),
		)?;
		Ok(Str::new(snapshot.turn.params.model.as_str()))
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
		let root =
			chat::canonical_project(&options.project).map_err(HeadlessError::CanonicalProject)?;
		let home = env::var_os("HOME").map_or_else(|| root.clone(), PathBuf::from);
		let catalog_owner = crate::registry::production_catalog(&data_dir)
			.map_err(HeadlessError::ProductionCatalog)?;
		let catalog = catalog_owner.as_ref();
		let model = chat::resolve_model_selector(catalog, options.model.as_str())
			.map_err(HeadlessError::ResolveModelSelector)?;
		let mut settings_paths = SettingsPaths::discover(&data_dir, Some(&root));
		settings_paths
			.overlays
			.extend(options.settings_overlays.iter().cloned());
		let settings_manager = SettingsManager::open(settings_paths)?;
		if let Some(approval_mode) = options.approval_mode {
			settings_manager.set_sync(
				MutationScope::Runtime,
				"tools.approval_mode",
				&approval_mode.to_string(),
			)?;
		}
		let settings_snapshot = settings_manager.snapshot();
		let mut settings = settings_snapshot
			.project::<Settings>()
			.map_err(HeadlessError::SettingsProjection)?
			.get()
			.clone();
		settings.mnemopi = settings.mnemopi.normalize();
		let model_settings = settings_snapshot
			.project::<omp_catalog::settings::ModelSettings>()
			.map_err(HeadlessError::SettingsProjection)?
			.get()
			.resolve_path_scopes(&root, &home);
		if matches!(policy.session, HeadlessSessionOpen::New | HeadlessSessionOpen::Ephemeral)
			&& !crate::discovery::roles::model_selector_allowed(
				catalog,
				&model_settings,
				model.as_str(),
			) {
			return Err(HeadlessError::MissingRoute(model));
		}
		let prompt_discovery_settings = discovery::PromptDiscoverySettings {
			model:   model_settings.clone(),
			skills:  settings_snapshot
				.project::<discovery::skills::SkillDiscoverySettings>()
				.map_err(HeadlessError::SettingsProjection)?
				.get()
				.clone(),
			foreign: settings_snapshot
				.project::<discovery::foreign::ForeignContentSettings>()
				.map_err(HeadlessError::SettingsProjection)?
				.get()
				.clone(),
			rules:   settings_snapshot
				.project::<crate::rulebook::RulebookSettings>()
				.map_err(HeadlessError::SettingsProjection)?
				.get()
				.clone(),
			native:  policy.native_discovery.clone(),
		};
		let prompt_discovery = discovery::active_prompt_snapshots(
			&root,
			&options.additional_roots,
			&home,
			&prompt_discovery_settings,
		);
		let content = &prompt_discovery.content;
		let state_dir = omp_env::project_state::directory(&data_dir, &root)
			.map_err(|source| HeadlessError::ProjectStateDirectory { path: root.clone(), source })?;
		let mut ephemeral_sessions = None;
		let sessions_dir = match (&policy.session, policy.sessions_dir.as_ref()) {
			(HeadlessSessionOpen::Ephemeral, Some(_)) => {
				return Err(HeadlessError::EphemeralSessionsDirectory);
			},
			(HeadlessSessionOpen::Ephemeral, None) => {
				let owner =
					chat::EphemeralSessions::create().map_err(HeadlessError::EphemeralSessions)?;
				let path = owner.path().to_owned();
				ephemeral_sessions = Some(owner);
				path
			},
			(_, Some(directory)) => directory.clone(),
			(_, None) => state_dir.join("sessions"),
		};
		chat::ensure_state_directory(&state_dir).map_err(HeadlessError::EnsureStateDirectory)?;
		chat::ensure_state_directory(&sessions_dir).map_err(HeadlessError::EnsureStateDirectory)?;
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
		let mut bridges = builtin_with_content(
			&root,
			Arc::clone(&search),
			goal_control.clone(),
			None,
			advise_queue.clone(),
			&prompt_discovery.content,
		);
		bridges.edit_model = Some(model.clone());
		bridges.edit_repair = settings.tools.edit_auto_repair.then_some(edit_repair);
		let environment = omp_envd::ProjectEnvironment::start_with_settings_snapshot(
			&root,
			&state_dir,
			&omp_env::project_state::document_socket(&state_dir),
			options.py_eval,
			&extension_specs,
			policy.contributed_values.as_ref(),
			Arc::clone(&settings_snapshot),
			bridges,
		)
		.await?;
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
				.map_err(HeadlessError::SessionsIndex)?;
			Some(
				page
					.sessions
					.first()
					.map(|session| session.id.0.clone())
					.ok_or(HeadlessError::NoDurableSession)?,
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
		.map_err(HeadlessError::OpenSession)?;
		let env = env
			.with_principal(session.id.clone(), session.id.clone())
			.map_err(HeadlessError::EnvPrincipal)?;
		let blueprint = chat::session_blueprint(
			model.as_str(),
			catalog,
			&root,
			&options.additional_roots,
			&session.id,
			Arc::clone(&registry),
		)
		.map_err(HeadlessError::SessionBlueprint)?;
		let mut snapshot =
			chat::agent_snapshot(&blueprint, catalog, None).map_err(HeadlessError::AgentSnapshot)?;
		let mut notices = Vec::new();
		if matches!(
			policy.session,
			HeadlessSessionOpen::Resume(_)
				| HeadlessSessionOpen::Fork(_)
				| HeadlessSessionOpen::ContinueLatest
		) {
			let journal_path = sessions_dir.join(format!("{}.jsonl", session.id.as_str()));
			let mut revived = omp_agent::revive_existing(&journal_path, session.journal, snapshot)?;
			session.journal = revived.journal;
			snapshot = revived.snapshot;
			let revived_model = apply_revived_session_model(
				&mut snapshot,
				catalog,
				revived.model_override.as_ref(),
				&root,
				&options.additional_roots,
				&model_settings,
				options.credential_provider.as_ref(),
			)?;
			if let Some(notice) = revived_model.notice {
				notices.push(notice);
			}
			if revived_model.substituted {
				if let Some(pending) = session.journal.pending_turn().cloned() {
					session
						.journal
						.abort_turn(now_ms(), pending.turn_id.as_str(), AbortDisposition::Continue)
						.map_err(|error| HeadlessError::Revival(error.into()))?;
				}
			}
		}
		apply_tool_policy(&mut snapshot, &policy.tools, policy.lsp_enabled);
		for warning in content.warnings.iter() {
			tracing::warn!(%warning, "headless content discovery warning");
		}
		for diagnostic in prompt_discovery.context.diagnostics.iter() {
			tracing::warn!(?diagnostic, "headless context discovery warning");
		}
		let prompt_settings = settings_snapshot
			.project::<PromptSettings>()
			.map_err(HeadlessError::SettingsProjection)?
			.get()
			.clone()
			.resolve_inputs(&root, &home)
			.map_err(HeadlessError::PromptInputs)?;
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
		snapshot.props = prompt_facts
			.props()
			.map_err(HeadlessError::PromptProperties)?;
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
		let ProductionInference {
			registry: inference_registry,
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
				provider:              options.credential_provider,
				api_key:               options.api_key,
				prompt_cache_affinity: options.prompt_cache_affinity,
				usage_fetchers:        Some(environment.usage_fetchers()),
				settings:              Some(Arc::clone(&settings_snapshot)),
			},
		)
		.await?;
		let _ = search.bind(inference.clone());
		let _ = environment.github_credentials().bind(credential_authority);
		environment
			.bind_mcp_oauth(mcp_authority, mcp_oauth, auth_control)
			.await?;
		let client = InProcTurnClient::new(inference).await?;
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
				.map_err(HeadlessError::ReflectionBridge)?;
		}
		let memory_extraction = memory_lane.map(|lane| {
			ExtractionWorker::start(
				environment.memory_runtime(),
				lane,
				settings.mnemopi.shutdown_timeout_ms,
			)
		});
		let mut agent =
			Agent::new(client, env.clone(), state.clone(), session.journal, chat::CHAT_CAPS_BASE);
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
		let control = agent.control();
		agent
			.recover_regimes(omp_agent::core_regime, now_ms())
			.map_err(HeadlessError::RecoverRegimes)?;
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
				.map_err(HeadlessError::StartRegime)?;
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
		let node = tree.register(
			session.id.clone(),
			sf!("Main"),
			AgentKind::Main,
			None,
			session.id.clone(),
			Budget::default(),
		)?;
		node.set_status(AgentStatus::Running);
		let session_handle = blueprint
			.launch(
				SessionIdentity { id: session.id.clone(), journal_path, expected_revision: None },
				SessionRuntime::from_agent(agent),
				None,
				None,
			)
			.map_err(HeadlessError::LaunchSession)?;
		let events = session_handle.subscribe_lossless();
		let (lifecycle, lifecycle_events) = HeadlessLifecycleSink::new(options.session_generation);
		let approval_book = Arc::new(ApprovalBook::new());
		let (approval_route, approval_inbox) = ApprovalRoute::new(Arc::clone(&approval_book));
		environment
			.bind_approval_authority(Some(Arc::clone(&approval_book)), Some(approval_route.clone()));
		Ok(Self {
			advise_queue,
			state,
			control,
			regimes: modes,
			tree,
			events: Some(events),
			lifecycle,
			lifecycle_events: Some(lifecycle_events),
			environment_bound: EnvironmentBound {
				session: session_handle,
				advisor_parent,
				env,
				_edit_repair_task: edit_repair_task,
			},
			approval_book,
			approval_route,
			approval_inbox: Some(approval_inbox),
			finalizer: HeadlessFinalizerHandle::new(),
			_goal_binding: goal_binding,
			session_id: session.id,
			initial_items: session.initial_items,
			notices,
			_inference_registry: inference_registry,
			_catalog: catalog_owner,
			_memory_extraction: memory_extraction,
			_tool_policy: policy.tools,
			_lsp_enabled: policy.lsp_enabled,
			_compaction_methods: compaction_methods,
			_mid_turn_policy: mid_turn_policy,
			_retry_policy: retry_policy,
			_forced_tool: Mutex::new(None),
			_ephemeral_sessions: ephemeral_sessions,
			_environment: environment,
		})
	}

	/// Submits caller-authored items through the durable agent loop.
	pub async fn submit(
		&mut self,
		items: impl IntoIterator<Item = Item>,
		turn_id: TurnId,
	) -> Result<AgentRunSummary, omp_sdk::SessionHandleError> {
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
		let result = self.environment_bound.session.submit(items, turn_id).await;
		if let Some(previous) = previous {
			self
				.state
				.update(|snapshot| snapshot.turn.params.tool_choice = previous);
		}
		result
	}

	/// Forces one exact registered tool for the next submitted turn only.
	pub fn force_tool_once(&self, name: Str) -> Result<(), HeadlessError> {
		if !self.state.snapshot().enabled_tools.contains(&name) {
			return Err(HeadlessError::DisabledTool { name });
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
		self
			.environment_bound
			.session
			.retry_last_turn(turn_id)
			.await
	}

	/// Executes and durably commits one manual compaction.
	pub async fn compact_manual(
		&self,
		request: omp_agent::ManualCompactionRequest,
	) -> Result<omp_agent::ManualCompactionOutcome, omp_sdk::SessionHandleError> {
		self.environment_bound.session.compact_manual(request).await
	}

	/// Returns the durable session identifier.
	pub fn session_id(&self) -> &str {
		self.session_id.as_str()
	}

	/// Returns the session-local parent authority used by persistent advisor
	/// children.
	pub fn advisor_parent(&self) -> Arc<chat::ChatParentHost<InProcTurnClient>> {
		Arc::clone(&self.environment_bound.advisor_parent)
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
			.map_err(HeadlessError::ReplaceHostTools)?;
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
				.map_err(HeadlessError::AdvertiseTools)?
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
				tools.push(
					chat::protocol_tool_definition(tool.definition)
						.map_err(HeadlessError::ProtocolToolDefinition)?,
				);
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

	/// Takes composition notices so an app adapter can present them.
	pub fn take_notices(&mut self) -> Vec<HeadlessNotice> {
		mem::take(&mut self.notices)
	}

	/// Returns the Environment client owned alongside the agent.
	pub const fn env(&self) -> &omp_env::EnvClient {
		&self.environment_bound.env
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
		let model = chat::resolve_model_selector(catalog, selector)
			.map_err(HeadlessError::ResolveModelSelector)?;
		let spec = catalog
			.model(ModelKey::from_ref(model.as_str()))
			.ok_or_else(|| HeadlessError::UnknownModel(Str::new(selector)))?;
		let route = spec
			.routes
			.first()
			.and_then(|route| catalog.route(route))
			.ok_or_else(|| HeadlessError::MissingRoute(Str::new(selector)))?;
		self
			.control
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
			.map_err(HeadlessError::ModelOverride)?;
		self
			.state
			.update(|snapshot| snapshot.turn.params.model = model.to_string());
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
		self.environment_bound.session.interrupt();
	}

	/// Returns a cheap interrupt-only capable clone of the durable handle.
	///
	/// Protocol hosts use this before borrowing the session mutably for a
	/// submission so cancellation never contends on their session mutex.
	pub fn interrupt_handle(&self) -> SessionHandle {
		self.environment_bound.session.clone()
	}

	/// Records a user-visible session title through the sole journal owner.
	pub async fn set_title(&self, title: Str) -> Result<(), HeadlessError> {
		self
			.control
			.set_title(now_ms(), title)
			.await
			.map_err(HeadlessError::SetTitle)?;
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
			.environment_bound
			.session
			.start_regime(spec, regime, omp_agent::StartOptions { now_ms: now_ms(), queue })
			.await?;
		self.regimes.sync_records(&entries);
		Ok(receipt)
	}

	/// Stops an active regime on the actor-owned regime set.
	pub async fn stop_regime(&self, activation: Str) -> Result<bool, omp_sdk::SessionHandleError> {
		let (removed, entries) = self
			.environment_bound
			.session
			.stop_regime(activation, now_ms())
			.await?;
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
	pub(crate) async fn dispose(&mut self) {
		let _ = self.environment_bound.session.dispose().await;
		if let Some(worker) = self._memory_extraction.as_mut() {
			worker.shutdown().await;
		}
	}

	/// Runs ordered bounded finalization. Dropping this session afterward
	/// disposes the agent and Environment last.
	pub async fn finalize<W>(&mut self, stdout: &mut W, budget: FinalizerBudget) -> FinalizerReport
	where
		W: AsyncWrite + Unpin,
	{
		let report = mem::take(&mut self.finalizer)
			.finalize(stdout, budget)
			.await;
		let _ = self.environment_bound.session.dispose().await;
		if let Some(worker) = self._memory_extraction.as_mut() {
			worker.shutdown().await;
		}
		report
	}

	/// Publishes an additional event through the session's generation-stamped
	/// event bus. Intended for typed mode transitions owned by protocol hosts.
	pub fn publish(&self, event: AgentEvent) {
		self.environment_bound.session.publish(event);
	}
}
/// Result of reconciling the model selector after reviving a durable session.
struct RevivedModelResult {
	/// Selector that could not be selected, with the fallback used instead.
	pub notice:      Option<HeadlessNotice>,
	/// Whether a catalog fallback replaced the journaled or launch selector.
	pub substituted: bool,
}

/// Applies a journaled model override, substitutes a catalog fallback when the
/// pinned selector is unselectable, and reprojects model-derived snapshot
/// fields through `session_blueprint`/`agent_snapshot`.
fn apply_revived_session_model(
	snapshot: &mut AgentSnapshot,
	catalog: &snapshot::Catalog,
	model_override: Option<&JournalModelChange>,
	root: &Path,
	additional_roots: &[PathBuf],
	model_settings: &omp_catalog::settings::ModelSettings,
	credential_provider: Option<&ProviderId>,
) -> Result<RevivedModelResult, HeadlessError> {
	let mut model_applied = false;
	if let Some(model) = model_override
		&& !model.fallback
	{
		snapshot.turn.params.model = model.model.model.0.to_string();
		model_applied = true;
	}
	let mut notice = None;
	let mut substituted = false;
	if !chat::model_selector_is_selectable(catalog, &snapshot.turn.params.model)
		|| !crate::discovery::roles::model_selector_allowed(
			catalog,
			model_settings,
			&snapshot.turn.params.model,
		) || credential_provider.is_some_and(|provider| {
		chat::resolve_model_provider(catalog, &snapshot.turn.params.model, Some(provider.as_str()))
			.is_err()
	}) {
		let saved = Str::new(snapshot.turn.params.model.as_str());
		let fallback = crate::discovery::roles::fallback_model_selector(
			catalog,
			model_settings,
			credential_provider,
		)
		.ok_or(HeadlessError::NoSelectableModel)?;
		snapshot.turn.params.model = fallback.as_str().to_owned();
		notice = Some(HeadlessNotice { saved, fallback });
		substituted = true;
	}
	if model_applied || substituted {
		let session_id = snapshot
			.turn
			.context_id
			.clone()
			.unwrap_or_else(|| sf!("session"));
		let blueprint = chat::session_blueprint(
			snapshot.turn.params.model.as_str(),
			catalog,
			root,
			additional_roots,
			&session_id,
			Arc::clone(&snapshot.registry),
		)
		.map_err(HeadlessError::SessionBlueprint)?;
		let projected =
			chat::agent_snapshot(&blueprint, catalog, None).map_err(HeadlessError::AgentSnapshot)?;
		let retained: Arc<[Str]> = snapshot
			.enabled_tools
			.iter()
			.filter(|name| {
				projected
					.enabled_tools
					.iter()
					.any(|available| available == *name)
			})
			.cloned()
			.collect::<Vec<_>>()
			.into();
		let retained_set: BTreeSet<&str> = retained.iter().map(Str::as_str).collect();
		let mut turn = projected.turn;
		turn
			.params
			.tools
			.retain(|tool| retained_set.contains(tool.name.as_str()));
		snapshot.turn = turn;
		snapshot.enabled_tools = retained;
		snapshot.reasoning_dialect = projected.reasoning_dialect;
	}
	Ok(RevivedModelResult { notice, substituted })
}

#[cfg(test)]
mod tests {
	use omp_agent::{Journal, TurnInputRecord, TurnOptionsRecord, TurnStart};
	use omp_proto::thread::v1::{Message, Part, Role, Thread, item, part};
	use omp_storage::transcript::{Event, Header, ItemRecord, Kind, Patch, SessionId, Writer};
	use omp_tool::Registry;

	use super::*;

	#[test]
	fn duplicate_extension_host_keys_fail_before_environment_freeze() {
		let key = omp_envd::worker::HostKey::new("project", "trusted", "example/tool");
		let error = validate_extension_host_keys([&key, &key]).expect_err("duplicate rejected");
		let HeadlessError::DuplicateExtensionHost { key: duplicate } = error else {
			panic!("duplicate key must be a duplicate extension host error");
		};
		assert_eq!(duplicate.layer().as_str(), "project");
		assert_eq!(duplicate.tier().as_str(), "trusted");
		assert_eq!(duplicate.extension().as_str(), "example/tool");
	}

	#[test]
	fn distinct_extension_host_keys_are_admitted() {
		let first = omp_envd::worker::HostKey::new("project", "trusted", "example/one");
		let second = omp_envd::worker::HostKey::new("user", "trusted", "example/one");
		validate_extension_host_keys([&first, &second]).expect("distinct scoped keys");
	}

	fn launch_snapshot_with_registry(
		catalog: &snapshot::Catalog,
		root: &Path,
		model: &str,
		registry: Arc<Registry>,
	) -> AgentSnapshot {
		let session_id = sf!("test-session");
		let blueprint = chat::session_blueprint(model, catalog, root, &[], &session_id, registry)
			.expect("blueprint");
		chat::agent_snapshot(&blueprint, catalog, None).expect("snapshot")
	}

	fn launch_snapshot(catalog: &snapshot::Catalog, root: &Path, model: &str) -> AgentSnapshot {
		launch_snapshot_with_registry(catalog, root, model, Arc::new(Registry::new()))
	}

	fn write_unavailable_model_journal(root: &Path) -> std::path::PathBuf {
		let sessions = root.join("sessions");
		std::fs::create_dir_all(&sessions).expect("sessions dir");
		let id = Str::from(omp_core::Ulid::generate().to_string());
		let path = sessions.join(format!("{id}.jsonl"));
		let mut writer = Writer::create(&path, &Header {
			v:       4,
			id:      SessionId(id.clone()),
			created: 1,
			cwd:     root.to_owned(),
		})
		.expect("create transcript");
		writer
			.append(&Event {
				ts:   2,
				kind: Kind::Item(ItemRecord {
					item:        Item {
						seq:           0,
						created_at_ms: 2,
						kind:          Some(item::Kind::Message(Message {
							role:  i32::from(Role::User),
							parts: vec![Part { kind: Some(part::Kind::Text("hello".to_owned())) }],
						})),
						props:         None,
					},
					turn_id:     None,
					prompt_hash: None,
				}),
			})
			.expect("append prompt");
		writer
			.append(&Event {
				ts:   3,
				kind: Kind::Infer {
					thinking: Patch::Unchanged,
					model:    Patch::Set(JournalModelChange {
						role:     sf!("temporary"),
						model:    JournalModelRef {
							provider: JournalProviderId(sf!("gone")),
							api:      sf!("openai"),
							model:    JournalModelId(sf!("gone/gone")),
						},
						fallback: false,
					}),
					tier:     Patch::Unchanged,
					cred_pin: Patch::Unchanged,
				},
			})
			.expect("append model override");
		drop(writer);
		path
	}

	#[test]
	fn revived_journal_falls_back_from_unavailable_pinned_model() {
		let catalog = snapshot::Catalog::try_embedded().expect("embedded catalog");
		let scratch = tempfile::tempdir().expect("scratch");
		let root = scratch.path().join("project");
		std::fs::create_dir_all(&root).expect("project");
		let launch = "apple-intelligence/apple-intelligence";
		let path = write_unavailable_model_journal(&root);
		let journal = Journal::open(&path).expect("open journal");
		let mut snapshot = launch_snapshot(catalog, &root, launch);
		let model_settings = omp_catalog::settings::ModelSettings::default();
		let revived = omp_agent::revive_existing(&path, journal, snapshot).expect("revive");
		snapshot = revived.snapshot;
		let result = apply_revived_session_model(
			&mut snapshot,
			catalog,
			revived.model_override.as_ref(),
			&root,
			&[],
			&model_settings,
			None,
		)
		.expect("fallback applies");
		let expected =
			crate::discovery::roles::fallback_model_selector(catalog, &model_settings, None)
				.expect("catalog fallback");
		assert_eq!(snapshot.turn.params.model, expected.as_str());
		assert!(result.substituted);
		assert_eq!(
			result.notice,
			Some(HeadlessNotice { saved: Str::from("gone/gone"), fallback: expected.clone() })
		);
		assert_eq!(
			snapshot.reasoning_dialect,
			chat::interrupted_reasoning_dialect(catalog, expected.as_str())
		);
		let fallback_snapshot = chat::agent_snapshot(
			&chat::session_blueprint(
				expected.as_str(),
				catalog,
				&root,
				&[],
				&sf!("test-session"),
				Arc::clone(&snapshot.registry),
			)
			.expect("fallback blueprint"),
			catalog,
			None,
		)
		.expect("fallback snapshot");
		assert_eq!(snapshot.enabled_tools, fallback_snapshot.enabled_tools);
		assert_eq!(
			snapshot.turn.stream_watchdog,
			crate::chat::model_stream_watchdog(catalog, expected.as_str())
		);
	}

	#[test]
	fn revived_journal_errors_when_catalog_has_no_selectable_model() {
		let catalog = snapshot::Catalog::try_embedded().expect("embedded catalog");
		let scratch = tempfile::tempdir().expect("scratch");
		let root = scratch.path().join("project");
		std::fs::create_dir_all(&root).expect("project");
		let path = write_unavailable_model_journal(&root);
		let journal = Journal::open(&path).expect("open journal");
		let mut snapshot = launch_snapshot(catalog, &root, "apple-intelligence/apple-intelligence");
		let mut model_settings = omp_catalog::settings::ModelSettings::default();
		model_settings.enabled_models =
			Arc::from([omp_catalog::settings::PathScopedStringEntry::Bare(Str::new("no/such"))]);
		let revived = omp_agent::revive_existing(&path, journal, snapshot).expect("revive");
		snapshot = revived.snapshot;
		let error = match apply_revived_session_model(
			&mut snapshot,
			catalog,
			revived.model_override.as_ref(),
			&root,
			&[],
			&model_settings,
			None,
		) {
			Err(error) => error,
			Ok(_) => panic!("empty catalog fallback"),
		};
		assert!(matches!(error, HeadlessError::NoSelectableModel));
	}

	#[test]
	fn revived_journal_falls_back_through_incompatible_provider_to_compatible() {
		let catalog = snapshot::Catalog::try_embedded().expect("embedded catalog");
		let scratch = tempfile::tempdir().expect("scratch");
		let root = scratch.path().join("project");
		std::fs::create_dir_all(&root).expect("project");
		let path = write_unavailable_model_journal(&root);
		let journal = Journal::open(&path).expect("open journal");
		let mut snapshot = launch_snapshot(catalog, &root, "apple-intelligence/apple-intelligence");
		let model_settings = omp_catalog::settings::ModelSettings::default();
		let revived = omp_agent::revive_existing(&path, journal, snapshot).expect("revive");
		snapshot = revived.snapshot;
		let provider = omp_catalog::ProviderId::new("openai");
		let result = apply_revived_session_model(
			&mut snapshot,
			catalog,
			revived.model_override.as_ref(),
			&root,
			&[],
			&model_settings,
			Some(&provider),
		)
		.expect("fallback applies");
		assert!(result.substituted);
		assert_ne!(snapshot.turn.params.model, "apple-intelligence/apple-intelligence");
		chat::resolve_model_provider(catalog, &snapshot.turn.params.model, Some(provider.as_str()))
			.expect("fallback is compatible with the credential provider");
	}

	#[test]
	fn revived_session_retains_durable_tool_restriction_after_model_substitution() {
		use omp_tool::{Claims, Precedence, Presentation};

		let catalog = snapshot::Catalog::try_embedded().expect("embedded catalog");
		let scratch = tempfile::tempdir().expect("scratch");
		let root = scratch.path().join("project");
		std::fs::create_dir_all(&root).expect("project");
		let path = write_unavailable_model_journal(&root);
		let mut journal = Journal::open(&path).expect("open journal");

		let mut registry = Registry::new();
		registry
			.register(omp_tools::yield_tool::tool(), Presentation::Slot, Claims {
				precedence: Precedence::DEFAULT,
				claimant:   sf!("test"),
				replaces:   None,
			})
			.expect("register yield test tool");
		registry
			.register(omp_tools::todo::tool(), Presentation::Slot, Claims {
				precedence: Precedence::DEFAULT,
				claimant:   sf!("test"),
				replaces:   None,
			})
			.expect("register todo test tool");
		let registry = Arc::new(registry);

		let snapshot = launch_snapshot_with_registry(
			catalog,
			&root,
			"apple-intelligence/apple-intelligence",
			registry,
		);
		journal
			.start_turn(4, TurnStart {
				turn_id:            sf!("durable"),
				item_events:        Vec::new(),
				prompt_hash:        omp_core::Hash32::new([0; 32]),
				prompt_head_events: Vec::new(),
				toolset_hash:       snapshot.registry.slot_hash(),
				enabled_tools:      vec![sf!("yield")],
				sequence_targets:   Vec::new(),
				input:              TurnInputRecord::Full { thread: Thread::default() },
				options:            TurnOptionsRecord {
					context_id: snapshot.turn.context_id.clone(),
					params:     snapshot.turn.params.clone(),
					executor:   snapshot.turn.executor.clone(),
					props:      snapshot.turn.props.clone(),
				},
			})
			.expect("persist durable tool restriction");
		let model_settings = omp_catalog::settings::ModelSettings::default();
		let revived = omp_agent::revive_existing(&path, journal, snapshot).expect("revive");
		let mut snapshot = revived.snapshot;
		assert_eq!(snapshot.enabled_tools.as_ref(), &[sf!("yield")]);
		let provider = omp_catalog::ProviderId::new("openai");
		let result = apply_revived_session_model(
			&mut snapshot,
			catalog,
			revived.model_override.as_ref(),
			&root,
			&[],
			&model_settings,
			Some(&provider),
		)
		.expect("fallback applies");
		assert!(result.substituted);
		assert!(!chat::model_rejects_tools(catalog, &snapshot.turn.params.model));
		assert_eq!(snapshot.enabled_tools.as_ref(), &[sf!("yield")]);
		assert!(
			snapshot
				.turn
				.params
				.tools
				.iter()
				.all(|tool| tool.name == "yield")
		);
		assert_eq!(snapshot.turn.params.tools.len(), 1);
	}

	#[tokio::test]
	async fn dropped_session_without_finalize_leaves_environment_reopenable() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let data_dir = scratch.path().join("data");
		let root = scratch.path().join("project");
		std::fs::create_dir_all(&root).expect("project root");
		let catalog = crate::registry::production_catalog(&data_dir).expect("production catalog");
		let model = chat::fallback_model_selector(&catalog).expect("selectable fallback model");
		let options = HeadlessSessionOptions {
			project: root,
			settings_overlays: Box::new([]),
			additional_roots: Box::new([]),
			model,
			initial_regime: None,
			initial_prompt_slot: None,
			plan_handoff: None,
			resume: None,
			fork: None,
			py_eval: false,
			approval_mode: None,
			pty_denied: false,
			credential_provider: None,
			api_key: None,
			prompt_cache_affinity: None,
			session_generation: 1,
		};
		let first = HeadlessSession::open(data_dir.clone(), options.clone())
			.await
			.expect("first session opens");
		drop(first);
		let second = HeadlessSession::open(data_dir, options)
			.await
			.expect("second session opens on the same project root");
		drop(second);
	}
	#[test]
	fn preview_effective_model_returns_resolved_new_session_model() {
		let catalog = snapshot::Catalog::try_embedded().expect("embedded catalog");
		let launch = crate::discovery::roles::fallback_model_selector(
			&catalog,
			&omp_catalog::settings::ModelSettings::default(),
			None,
		)
		.expect("fallback");
		let scratch = tempfile::tempdir().expect("scratch");
		let data_dir = scratch.path().join("data");
		std::fs::create_dir_all(&data_dir).expect("data dir");
		let root = scratch.path().join("project");
		std::fs::create_dir_all(&root).expect("project");
		let options = HeadlessSessionOptions {
			project:               root,
			settings_overlays:     Box::new([]),
			additional_roots:      Box::new([]),
			model:                 launch.clone(),
			initial_regime:        None,
			initial_prompt_slot:   None,
			plan_handoff:          None,
			resume:                None,
			fork:                  None,
			py_eval:               false,
			approval_mode:         None,
			pty_denied:            false,
			credential_provider:   None,
			api_key:               None,
			prompt_cache_affinity: None,
			session_generation:    1,
		};
		let policy = HeadlessLaunchPolicy::default();
		let effective =
			HeadlessSession::preview_effective_model(&data_dir, &options, &policy).expect("preview");
		assert_eq!(effective.as_str(), launch.as_str());
	}

	#[test]
	fn preview_effective_model_falls_back_from_unavailable_pinned_model() {
		let catalog = snapshot::Catalog::try_embedded().expect("embedded catalog");
		let scratch = tempfile::tempdir().expect("scratch");
		let data_dir = scratch.path().join("data");
		std::fs::create_dir_all(&data_dir).expect("data dir");
		let root = scratch.path().join("project");
		std::fs::create_dir_all(&root).expect("project");

		let journal_path = write_unavailable_model_journal(&root);
		let source = Str::new(journal_path.file_stem().unwrap().to_str().unwrap());

		let state_dir = omp_env::project_state::directory(&data_dir, &root).expect("state dir");
		let sessions_dir = state_dir.join("sessions");
		std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
		let target = sessions_dir.join(journal_path.file_name().unwrap());
		std::fs::copy(&journal_path, &target).expect("copy journal");

		let launch = crate::discovery::roles::fallback_model_selector(
			&catalog,
			&omp_catalog::settings::ModelSettings::default(),
			None,
		)
		.expect("fallback");
		let options = HeadlessSessionOptions {
			project:               root,
			settings_overlays:     Box::new([]),
			additional_roots:      Box::new([]),
			model:                 launch.clone(),
			initial_regime:        None,
			initial_prompt_slot:   None,
			plan_handoff:          None,
			resume:                None,
			fork:                  None,
			py_eval:               false,
			approval_mode:         None,
			pty_denied:            false,
			credential_provider:   None,
			api_key:               None,
			prompt_cache_affinity: None,
			session_generation:    1,
		};
		let policy = HeadlessLaunchPolicy {
			session: HeadlessSessionOpen::Resume(source),
			..HeadlessLaunchPolicy::default()
		};
		let effective =
			HeadlessSession::preview_effective_model(&data_dir, &options, &policy).expect("preview");
		let expected = crate::discovery::roles::fallback_model_selector(
			&catalog,
			&omp_catalog::settings::ModelSettings::default(),
			None,
		)
		.expect("fallback");
		assert_eq!(effective, expected);
		assert_ne!(effective.as_str(), "gone/gone");
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
