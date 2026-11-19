//! Production composition for the journal-first headless agent kernel.

use std::{
	fs,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use futures::StreamExt as _;
use omp_agent::{
	CanonicalPromptSource, DirectorRegistry, DispatchPolicy, ExtensionRegistrar,
	ExternalDispatchEvent, ExternalDispatchRequest, ExternalDispatchStream, ExternalToolExecutor,
	Kernel, RouteFacts, RuntimeFlags,
};
use omp_ai::{
	AnswerBody, Call, CallMeta, ChatEvent, ChatRequest, ChatStream, ContentPart, ExecutionBudget,
	Message, NegotiationPolicy, OperationCall, RequestId, Role, Sampling, Setting, Target,
};
use omp_core::{FastHashMap, Hash32, SecretString, Str, StrMut, Ulid, sf};
use omp_dom::{Op, PropKey, Txn, Value};
use omp_envd::fetch_host::{FetchHostNamer, NETWORK_APPROVAL_KIND, NamedFetches};
use omp_ext::workspace_trust::WorkspaceTrust;
use omp_session::{ComponentRegistry, Session};
use omp_tool::{
	Abort, BlobRef as ToolBlobRef, CallOutcome, Claims, Part as ToolPart, Precedence, Presentation,
	Registry,
};
use omp_tools::output_schema::SchemaMode;
use parking_lot::{Mutex, RwLock};

#[path = "con_journal.rs"]
mod con_journal;

use super::{HeadlessError, gateway::GatewayInference, reflection::bind_reflection};
use crate::{
	registry::{
		InferenceSessionOverrides, PinnedRoutes, ProductionInference as ProductionStack,
		production_inference_for_session,
	},
	workspace_trust::{WITHHELD_NOTICE, WithheldInputs, WorkspaceTrustSource, journal_decision},
};

/// Stable prompt projection overrides supplied by one invocation.
#[derive(Clone, Debug)]
pub struct PromptOverrides {
	/// Complete replacement for the customizable prompt bands.
	pub custom_prompt:          Option<Str>,
	/// Guidance appended after the stable prompt.
	pub append_prompt:          Option<Str>,
	/// Resolved personality prompt text.
	pub personality:            Option<Str>,
	/// Whether model identity is included.
	pub include_model:          Option<bool>,
	/// Whether workstation facts are included.
	pub include_workstation:    Option<bool>,
	/// Whether a bounded workspace tree is included.
	pub include_workspace_tree: Option<bool>,
	/// Whether Mermaid guidance is included.
	pub render_mermaid:         Option<bool>,
	/// Whether enabled skills are included.
	pub include_skills:         Option<bool>,
	/// Whether all provider prompt bands are bypassed.
	pub null_prompt:            bool,
	/// Whether discovered context files (AGENTS.md and friends) are included
	/// (`--no-context-files`).
	pub include_context_files:  bool,
	/// Whether discovered rules (`.omp/rules`, `RULES.md`, `.cursor/rules`, …)
	/// are included (`--no-rules`).
	pub include_rules:          bool,
	/// Additional workspace roots the prompt names beside the project.
	pub additional_roots:       Vec<PathBuf>,
}

impl Default for PromptOverrides {
	fn default() -> Self {
		Self {
			custom_prompt:          None,
			append_prompt:          None,
			personality:            None,
			include_model:          None,
			include_workstation:    None,
			include_workspace_tree: None,
			render_mermaid:         None,
			include_skills:         None,
			null_prompt:            false,
			include_context_files:  true,
			include_rules:          true,
			additional_roots:       Vec::new(),
		}
	}
}

/// Native extension-root composition for one invocation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NativeExtensionMode {
	/// Merge explicit roots with configured roots.
	#[default]
	Merge,
	/// Admit only explicit roots.
	ExplicitOnly,
	/// Disable native extension discovery.
	Disabled,
}

/// Driver-owned extension policy supplied by one invocation.
#[derive(Clone, Debug)]
pub struct LaunchExtensionPolicy {
	/// Ordered explicit native extension roots.
	pub native_roots:      Vec<PathBuf>,
	/// How explicit roots compose with configured roots.
	pub native_mode:       NativeExtensionMode,
	/// Whether workspace-owned roots participate.
	pub include_workspace: bool,
	/// Exact operator-trusted Python extension hosts.
	pub trusted:           Vec<omp_envd::worker::ExtHostSpec>,
	/// Declaration-owned CLI values delivered at activation.
	pub contributed:       Vec<omp_ext::config::ContributedCliValue>,
	/// Manifest setting overrides applied before environment attachment.
	pub setting_overrides: Vec<omp_ext::config::CliSettingOverride>,
}

impl Default for LaunchExtensionPolicy {
	fn default() -> Self {
		Self {
			native_roots:      Vec::new(),
			native_mode:       NativeExtensionMode::Merge,
			include_workspace: true,
			trusted:           Vec::new(),
			contributed:       Vec::new(),
			setting_overrides: Vec::new(),
		}
	}
}

/// Session selection and invocation-local production options.
#[derive(Clone, Default)]
pub struct KernelOptions {
	/// Resume the newest journal in the project session directory.
	pub continue_session:   bool,
	/// Open this exact journal path or session id.
	pub session:            Option<PathBuf>,
	/// Fork this journal path or session id into a fresh durable session.
	pub fork:               Option<PathBuf>,
	/// Override the project-native durable session directory.
	pub sessions_dir:       Option<PathBuf>,
	/// Create the journal in the system temporary directory.
	pub ephemeral:          bool,
	/// Disable every project tool while retaining normal inference discovery.
	pub no_tools:           bool,
	/// Restrict the registry to these validated stable tool names.
	pub tools:              Option<Vec<Str>>,
	/// Enable the Python evaluation tool in the project environment.
	pub py_eval:            bool,
	/// Detached environment daemon idle timeout.
	pub spawn_idle_timeout: Option<u64>,
	/// Invocation-only provider API key.
	pub api_key:            Option<SecretString>,
	/// Invocation-only approval policy.
	pub approval_mode:      Option<omp_contract::posture::ApprovalMode>,
	/// Whether `model_selector` came from an explicit `--model`.
	pub model_override:     bool,
	/// How the launch model settles after discovery.
	pub launch_model:       LaunchModelPolicy,
	/// Stable prompt projection overrides.
	pub prompt:             PromptOverrides,
	/// Skill discovery snapshot shared with an interactive command host.
	pub discovered_skills:  Option<Arc<crate::discovery::skills::ActiveSkills>>,
	/// Installed marketplace plugin set the launching host resolved and
	/// surfaced diagnostics for; `None` resolves it from the data directory
	/// during composition.
	pub claude_plugins:     Option<Arc<omp_ext::claude_plugin::ClaudePlugins>>,
	/// Invocation extension policy.
	pub extensions:         LaunchExtensionPolicy,
	/// Optional provider routing constraint.
	pub provider:           Option<omp_catalog::ProviderId>,
	/// Connected inference gateway used instead of local provider composition.
	pub gateway:            Option<tonic::transport::Channel>,
	/// Process-local live-session routing authority.
	pub sessions:           Option<Arc<crate::sessions::SessionRegistry>>,
	/// Human-readable routing name for this kernel.
	pub session_name:       Option<Str>,
	/// Authenticated parent session id or routing name for a child kernel.
	pub parent_session:     Option<Str>,
	/// Agent class this kernel runs as; `None` is the top-level session
	/// ([`MAIN_AGENT`](crate::subagent::MAIN_AGENT)). Rule `agents:` scopes are
	/// evaluated against it.
	pub agent:              Option<crate::subagent::AgentName>,
	/// Explicit restricted registry for specialized child compositions.
	pub tool_registry:      Option<Arc<Registry>>,
	/// Child-specific structured output schema installed on `yield@2`.
	pub output_schema:      Option<serde_json::Value>,
	/// Enforcement mode for the child-specific output schema.
	pub schema_mode:        Option<SchemaMode>,
	/// Deny PTY-backed shell sessions to every tool (`--no-pty`).
	pub no_pty:             bool,
	/// Invocation-scoped provider prompt-cache identity (`--prompt-cache-key`).
	pub prompt_cache_key:   Option<Str>,
	/// Invocation-scoped provider session identity (`--provider-session-id`).
	pub provider_session:   Option<Str>,
	/// Where the workspace trust decision comes from (host-supplied, never a
	/// convar): evaluated against the operator's grant file by default, or a
	/// decision the host or parent session already holds.
	pub workspace_trust:    WorkspaceTrustSource,
}

/// How composition settles the launch model once runtime discovery has
/// refreshed the catalog.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LaunchModelPolicy {
	/// The model selector names the launch model (an explicit flag, a
	/// `--models` scope, a subagent or tool composition).
	#[default]
	Selected,
	/// The launch follows the remembered default role (`OMP_DEFAULT_MODEL`,
	/// else `ai_model_roles.default`), resolved against the post-discovery
	/// catalog; the model selector is only the fallback.
	RememberedDefault,
}

/// The launch model composition settled on.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchModel {
	/// Catalog key of the launch model.
	pub model:           Str,
	/// Thinking annotation carried by the remembered default selector.
	pub thinking:        Option<Str>,
	/// A remembered default the post-discovery catalog does not list; `model`
	/// is the fallback launched in its place.
	pub missing_default: Option<Str>,
}

/// Neither the remembered default nor the launch's selector names a model in
/// the catalog composition routes through.
#[derive(Debug, thiserror::Error)]
#[error("no catalog model matches the launch model selector")]
pub struct UnknownLaunchModel {
	/// The selector that matched nothing.
	pub selector: Str,
}

/// Removes a no-session journal and its private blob/local/temp namespace
/// regardless of which presentation adapter or error path drops the composed
/// kernel.
pub struct EphemeralJournal {
	root: PathBuf,
}

impl Drop for EphemeralJournal {
	fn drop(&mut self) {
		if let Err(error) = fs::remove_dir_all(&self.root)
			&& error.kind() != std::io::ErrorKind::NotFound
		{
			tracing::warn!(
				session_root = %self.root.display(),
				%error,
				"ephemeral session cleanup failed"
			);
		}
	}
}

/// Direct production inference client plus the authorities that keep its
/// environment and authentication stack alive.
pub struct ProductionInference {
	/// Route client pinned to one published registry; it adopts a newer
	/// publication only at a turn boundary.
	routes:             PinnedRoutes,
	/// Call metadata as composed at launch; `ai_model` re-targets a copy.
	meta:               CallMeta,
	/// Model the client is currently targeted at.
	model:              omp_catalog::ModelKey,
	/// How composition settled the launch model.
	launch:             LaunchModel,
	_environment:       omp_envd::ProjectEnvironment,
	_agent_control:     Mutex<Option<omp_envd::AgentControlBinding>>,
	stack:              ProductionStack,
	con:                Arc<omp_con::Ctx>,
	_python_components: Vec<omp_envd::exthost::PyComponent>,
	_eval_parent:       Option<omp_contract::eval_bridge::ParentBindingLease>,
	_ephemeral_journal: Option<EphemeralJournal>,
	rules:              Arc<crate::discovery::rules::RuleScope>,
	workspace_trust:    omp_ext::workspace_trust::TrustDecision,
}

impl ProductionInference {
	/// The catalog model `ai_model` currently selects (role selectors such
	/// as `@plan` resolve through the launch roles), else the launch model.
	fn selected_model(&self) -> Str {
		select_model(self.routes.catalog().as_ref(), &self.con, &self.launch.model).0
	}

	/// Catalog facts for the model the next request targets (R2 #10: `/model`
	/// switches must not leave compaction, vision, or tool lowering on the
	/// launch model).
	fn route_facts(&self) -> Option<RouteFacts> {
		let model = self.selected_model();
		let spec = self
			.routes
			.catalog()
			.model(omp_catalog::ModelKey::from_ref(model.as_str()))?;
		Some(route_facts(self.routes.catalog().as_ref(), spec, Some(&self.meta.target)))
	}

	/// Resolves the journaled session account pins (`ai_account_pins`)
	/// against the live account pool and attaches them to the client's
	/// affinity, so every call this session sends honors them. Resolved per
	/// call: a login, logout, or `/pin` between requests takes effect on the
	/// next one, and a pin whose account was removed fails closed.
	fn apply_account_pins(&mut self) {
		let pins = self
			.stack
			.auth_manager
			.session_pins(&omp_ai::account::AI_ACCOUNT_PINS.get(&self.con));
		let client = self.routes.client_mut();
		if client.affinity().account_pins != pins {
			let mut affinity = client.affinity().clone();
			affinity.account_pins = pins;
			client.set_affinity(affinity);
		}
	}

	/// Applies the control plane to the next call: `ai_model` re-targets the
	/// client when it names a different catalog model (ADR 0012: the convar
	/// is the live route), and `ai_thinking` sets the reasoning effort.
	fn apply_convars(&mut self, request: &mut ChatRequest) {
		self.apply_account_pins();
		let model = self.selected_model();
		if model.as_str() != self.model.as_str() {
			let key = omp_catalog::ModelKey::from(model.as_str());
			let mut meta = self.meta.clone();
			meta.target = match &self.meta.target {
				Target::Provider { provider, .. } => {
					Target::Provider { provider: provider.clone(), model: key.clone() }
				},
				_ => Target::Model(key.clone()),
			};
			self.routes.client_mut().set_call_meta(meta);
			self.model = key;
		}
		// Provider reasoning stays off; the kernel
		// advertises the hidden `think` tool instead.
		if omp_ai::settings::AI_EXTERNAL_THINKING.get(&self.con) {
			request.reasoning = omp_ai::Setting::Unset;
		} else if matches!(request.reasoning, omp_ai::Setting::Unset) {
			let thinking = omp_agent::AI_THINKING.get(&self.con);
			request.reasoning =
				convar_reasoning(self.routes.catalog().as_ref(), &self.model, &thinking);
		}
		let tier_family = self
			.routes
			.catalog()
			.model(&self.model)
			.map(|spec| spec.service_tier_family)
			.unwrap_or_default();
		omp_ai::settings::InferenceSettings::from_con(&self.con).apply_chat_request(
			request,
			tier_family,
			None,
		);
	}
}

/// Resolves `ai_model` against `catalog`: an exact key or alias, else a role
/// selector (`@plan`, reported with its role) or catalog selection; an empty
/// or unresolvable selector is the launch model. The one resolution both the
/// route and the kernel's `model_changed` watch read.
fn select_model(
	catalog: &omp_catalog::snapshot::Catalog,
	con: &omp_con::Ctx,
	launch: &str,
) -> (Str, Option<Str>) {
	let selector = omp_agent::AI_MODEL.get(con);
	if selector.is_empty() {
		return (Str::new(launch), None);
	}
	if let Ok(model) = resolve_model_selector(catalog, selector.as_str()) {
		return (model, None);
	}
	let settings = omp_catalog::settings::ModelSettings::from_con(con);
	match crate::discovery::roles::resolve_role_selector(catalog, &settings, selector.as_str()) {
		Ok(selected) => {
			let role = selector
				.as_str()
				.strip_prefix('@')
				.map(|role| role.split_once(':').map_or(role, |(role, _)| role))
				.filter(|role| !role.is_empty())
				.map(Str::new);
			(Str::new(selected.model.as_str()), role)
		},
		Err(_) => (Str::new(launch), None),
	}
}

/// Resolves the model of one isolated call on `selector` (a catalog model,
/// alias, or `@role`). An unresolvable selector is a planning
/// `TargetNotFound`.
fn isolated_call_model(
	catalog: &omp_catalog::snapshot::Catalog,
	con: &omp_con::Ctx,
	selector: &str,
) -> Result<omp_catalog::ModelKey, omp_ai::Error> {
	let model = resolve_model_selector(catalog, selector)
		.ok()
		.or_else(|| {
			let settings = omp_catalog::settings::ModelSettings::from_con(con);
			crate::discovery::roles::resolve_role_selector(catalog, &settings, selector)
				.ok()
				.map(|selected| Str::new(selected.model.as_str()))
		})
		.ok_or_else(|| {
			omp_ai::Error::planning(
				omp_ai::ErrorKind::TargetNotFound,
				omp_ai::ErrorDetail::target(Str::new(selector)),
				omp_ai::ExecutionReceipt::default(),
			)
		})?;
	Ok(omp_catalog::ModelKey::from(model.as_str()))
}

/// Gives a request to `model` the `ai_thinking` reasoning it lacks, unless
/// thinking runs through the hidden tool (`ai_external_thinking`).
fn default_reasoning(
	catalog: &omp_catalog::snapshot::Catalog,
	con: &omp_con::Ctx,
	model: &omp_catalog::ModelKey<str>,
	request: &mut ChatRequest,
) {
	if matches!(request.reasoning, omp_ai::Setting::Unset)
		&& !omp_ai::settings::AI_EXTERNAL_THINKING.get(con)
	{
		let thinking = omp_agent::AI_THINKING.get(con);
		request.reasoning = convar_reasoning(catalog, model, &thinking);
	}
}

/// `base` re-targeted at `model`, keeping an explicit provider constraint.
fn retarget(base: &Target, model: omp_catalog::ModelKey) -> Target {
	match base {
		Target::Provider { provider, .. } => Target::Provider { provider: provider.clone(), model },
		_ => Target::Model(model),
	}
}

/// The reasoning effort the next request to `model` carries: `ai_thinking`
/// clamped by the model's thinking policy ([`convar_reasoning`]), none when
/// thinking runs through the hidden tool (`ai_external_thinking`).
fn selected_thinking(
	catalog: &omp_catalog::snapshot::Catalog,
	con: &omp_con::Ctx,
	model: &str,
) -> Option<omp_catalog::ReasoningEffort> {
	if omp_ai::settings::AI_EXTERNAL_THINKING.get(con) {
		return None;
	}
	let thinking = omp_agent::AI_THINKING.get(con);
	match convar_reasoning(catalog, omp_catalog::ModelKey::from_ref(model), &thinking) {
		omp_ai::Setting::Prefer(reasoning) | omp_ai::Setting::Require(reasoning) => reasoning.effort,
		omp_ai::Setting::Unset => None,
	}
}

/// The production [`omp_agent::ModelSelector`]: the route's own resolution
/// ([`select_model`], [`selected_thinking`]) over the catalog as currently
/// published.
struct LiveModelSelector {
	catalog: crate::registry::LiveCatalog,
	launch:  Str,
}

impl omp_agent::ModelSelector for LiveModelSelector {
	fn select(&self, con: &omp_con::Ctx) -> Option<omp_agent::ModelSelection> {
		let catalog = self.catalog.load();
		let (model, role) = select_model(&catalog, con, &self.launch);
		let thinking = selected_thinking(&catalog, con, &model);
		Some(omp_agent::ModelSelection { model, role, thinking })
	}
}

/// Translates the `ai_thinking` convar into the canonical reasoning request
/// the catalog allows for `model` (ADR 0017: code branches on compiled
/// capabilities, never on model names).
///
/// The model's thinking policy and routing decide through
/// [`omp_catalog::ThinkingRouting::resolve`]: an effort above the ladder
/// clamps to the model ceiling, one between rungs clamps down, and `off` on a
/// model that cannot stop reasoning falls back to the catalog's default level
/// (or stays unset so the router applies `ai_default_thinking`). Models
/// without a thinking policy never carry a reasoning request; codecs then
/// spell the resolved effort per route (ADR 0022: one canonical request).
fn convar_reasoning(
	catalog: &omp_catalog::snapshot::Catalog,
	model: &omp_catalog::ModelKey<str>,
	thinking: &str,
) -> omp_ai::Setting<omp_ai::ReasoningRequest> {
	let Some(spec) = catalog.model(model) else {
		return omp_ai::Setting::Unset;
	};
	let Some(policy) = spec
		.thinking
		.as_ref()
		.and_then(|id| catalog.thinking_policy(id))
	else {
		return omp_ai::Setting::Unset;
	};
	let requested = if let Ok(effort) = thinking.parse::<omp_catalog::ReasoningEffort>() {
		omp_catalog::ThinkingEffort::from(effort)
	} else {
		tracing::warn!(value = thinking, "ai_thinking is not a reasoning effort; ignored");
		return omp_ai::Setting::Unset;
	};
	let wire_model = omp_catalog::WireModelId::from_ref(model.as_str());
	let effort = match spec
		.thinking_routing
		.resolve(policy, Some(requested), wire_model)
	{
		Ok(selection) => selection.effort,
		Err(_) => match policy.default_level {
			Some(level) => level,
			None => return omp_ai::Setting::Unset,
		},
	};
	omp_ai::Setting::Prefer(omp_ai::ReasoningRequest {
		visibility:          omp_ai::ReasoningVisibility::Visible,
		effort:              Some(effort.into()),
		max_tokens:          None,
		preserve_signatures: true,
	})
}

/// Revokes the session's network approvals in the environment whenever the
/// live session is rewound or the host switches to another session (ADR
/// 0028): the environment's grants are a cache of journaled decisions, and the
/// journal the kernel now serves stays the authority.
struct RevokeSessionGrants(omp_envd::SessionGrants);

impl omp_agent::SessionObserver for RevokeSessionGrants {
	fn rewound(&self, _session: &Session) {
		self.0.revoke();
	}

	fn switched(&self, _next: &Session) {
		self.0.revoke();
	}
}

/// Makes `kernel`'s approval route the one approval authority of
/// `environment`, and returns the route for the session's other prompters
/// (the tool executor's admission queries).
///
/// Every prompt filed on the route lands in the kernel mailbox, is journaled
/// under `<queues><prompts>` and is answered by the host's `Up::Approve`. The
/// environment binds it in two places: as the route of its in-process host,
/// through which an embedded or isolated composition prompts sandbox
/// amendments, privileged mutations and dynamic devices; and, when the session
/// is attached to the project daemon, as the route that answers the sandbox
/// amendments the daemon relays for the commands this session issued.
///
/// The network endpoints approved there for the session are journaled
/// decisions the environment caches. A rewind may drop them from the journal
/// and a session switch serves another journal, so the kernel's session
/// observer revokes the cache on both, and the approval desk refills it from
/// the grants the journal it now serves keeps (ADR 0028).
pub fn bind_environment_approvals<C>(
	kernel: &Kernel<C>,
	environment: &omp_envd::ProjectEnvironment,
) -> omp_agent::ApprovalRoute {
	let approvals = kernel.approval_route();
	environment.bind_approval_authority(
		Some(Arc::new(omp_agent::ApprovalBook::new())),
		Some(approvals.clone()),
	);
	kernel
		.jobs()
		.observe_sessions(Arc::new(RevokeSessionGrants(environment.session_grants())));
	approvals
}

/// Environment-routed tool execution: opens the invocation on the project
/// environment, commits the arguments, and answers the environment's
/// admission query by prompting the session's approval authority.
#[derive(Clone)]
pub struct EnvToolExecutor {
	client:    omp_env::EnvClient,
	approvals: omp_agent::ApprovalRoute,
	posture:   PostureNotice,
}

impl EnvToolExecutor {
	/// Executes environment tools for `client`; every admission query the
	/// environment raises (an `--approval-mode` tier above the call's
	/// policy) becomes one prompt on `approvals`.
	///
	/// It reports the session's approval posture only once
	/// [`install_tool_authority`] installs it.
	#[must_use]
	pub const fn new(client: omp_env::EnvClient, approvals: omp_agent::ApprovalRoute) -> Self {
		Self { client, approvals, posture: PostureNotice(None) }
	}

	/// The sandbox state the environment that admits this executor's calls
	/// reported in its handshake (`ServerHello.sandbox_state`); `None` before
	/// a handshake or when it reported none.
	fn reported_sandbox(&self) -> Option<omp_contract::posture::SandboxState> {
		self
			.client
			.info()
			.and_then(|hello| omp_contract::posture::SandboxState::from_wire(hello.sandbox_state()))
	}
}

/// Installs the session's tool authority on `kernel`, which serves `session`
/// first: `executor` runs the calls the environment admits, and `admission`
/// admits the native calls the kernel runs itself.
///
/// When the session's approval mode is a `yolo` that no sandbox confines
/// ([`session_posture`]), both report it from one shared report, a typed
/// `approval-posture` notice on the kernel mailbox, at whichever admission
/// comes first: over an attached project daemon every environment tool is
/// admitted there, never by the kernel.
///
/// The journal decides whether the report is due. It is due while the live
/// branch of the session the kernel serves holds no notice of this posture:
/// `session` decides it here, and the session the kernel serves decides it
/// again after every rewind (a tool-tail retry included) and every switch to
/// another session, through the session observer this registers.
///
/// Only this function wires the report: an executor or an admission installed
/// on its own reports nothing.
#[must_use]
pub fn install_tool_authority<C>(
	kernel: Kernel<C>,
	session: &Session,
	executor: EnvToolExecutor,
	admission: SettingsAdmission,
) -> Kernel<C> {
	let pending = session_posture(&admission, &executor).map(|posture| {
		let pending = Arc::new(PendingPosture {
			posture,
			mailbox: kernel.mailbox(),
			posted: std::sync::atomic::AtomicBool::new(false),
		});
		pending.sync(session);
		pending
	});
	let posture = PostureNotice(pending.clone());
	let kernel = kernel
		.with_external_executor(Arc::new(EnvToolExecutor { posture: posture.clone(), ..executor }))
		.with_tool_admission(Arc::new(SettingsAdmission { posture, ..admission }));
	match pending {
		Some(pending) => kernel.with_session_observer(pending),
		None => kernel,
	}
}

/// The approval posture the session reports: `admission`'s configured
/// approval mode against the sandbox state the environment `executor` runs
/// reported in its handshake.
///
/// That is the state every call the environment admits is resolved against,
/// and the one that confines the tools the sandbox covers: an attached
/// session's environment tools run on the project daemon, which probed its
/// host once, when it started, and may have found otherwise than this process
/// under equal settings (a backend installed since, or an outer sandbox around
/// either process). The state `admission` probed counts only when the
/// environment reported none; an embedded environment probes the same
/// settings in this process.
fn session_posture(
	admission: &SettingsAdmission,
	executor: &EnvToolExecutor,
) -> Option<omp_contract::posture::ApprovalPosture> {
	omp_contract::posture::ApprovalPosture::resolve(
		admission.settings.configured_approval(),
		executor.reported_sandbox().unwrap_or(admission.sandbox),
	)
}

const OUTCOME_REPLICATION_ATTEMPTS: usize = 3;

#[derive(Debug, thiserror::Error)]
enum OutcomeReplicationError {
	#[error(transparent)]
	Client(#[from] omp_env::ClientError),
	#[error(transparent)]
	Store(#[from] omp_journal::blob::Error),
	#[error("environment outcome retrieval was interrupted")]
	Interrupted,
	#[error("environment outcome identity changed during replication")]
	IdentityChanged,
	#[error("environment verdict media reference is invalid")]
	InvalidMedia,
	#[error("environment verdict media exceeds the host retrieval bound")]
	MediaTooLarge {
		/// Declared media byte length.
		size:  u64,
		/// Maximum accepted byte length.
		limit: u64,
	},
}

const fn resumable_blob_error(error: &omp_env::ClientError) -> bool {
	matches!(
		error,
		omp_env::ClientError::TransportClosed
			| omp_env::ClientError::StreamLost(_)
			| omp_env::ClientError::IncompleteBlob
	)
}

async fn replicate_outcome_blob(
	client: &omp_env::EnvClient,
	session_store: &omp_journal::blob::BlobStore,
	invocation_id: &str,
	expected_hash: Hash32,
	expected_size: u64,
	max_bytes: u64,
	cancel: &tokio_util::sync::CancellationToken,
) -> Result<omp_journal::blob::BlobRef, OutcomeReplicationError> {
	let mut stage = session_store.begin_put()?;
	let mut transfer = omp_env::ResumableBlobTransfer::new(expected_hash, expected_size, max_bytes)?;

	for attempt in 0..OUTCOME_REPLICATION_ATTEMPTS {
		let download = match client
			.blob_get_for_invocation(invocation_id, transfer.request())
			.await
		{
			Ok(download) => download,
			Err(source)
				if resumable_blob_error(&source) && attempt + 1 < OUTCOME_REPLICATION_ATTEMPTS =>
			{
				continue;
			},
			Err(source) => return Err(source.into()),
		};
		let received = tokio::select! {
			biased;
			() = cancel.cancelled() => return Err(OutcomeReplicationError::Interrupted),
			received = transfer.receive(download, &mut stage) => received,
		};
		match received {
			Ok(Some(_)) => break,
			Ok(None) => {},
			Err(source)
				if resumable_blob_error(&source) && attempt + 1 < OUTCOME_REPLICATION_ATTEMPTS =>
			{
				continue;
			},
			Err(source) => return Err(source.into()),
		}
	}

	if !transfer.is_complete() {
		return Err(omp_env::ClientError::IncompleteBlob.into());
	}
	let reference = stage.finish()?;
	if reference.hash != expected_hash || reference.size != expected_size {
		return Err(OutcomeReplicationError::IdentityChanged);
	}
	Ok(reference)
}

fn valid_blob_media_type(media_type: &str) -> bool {
	if media_type.bytes().any(|byte| byte.is_ascii_control()) {
		return false;
	}
	let essence = media_type.split(';').next().unwrap_or_default().trim();
	let Some((kind, subtype)) = essence.split_once('/') else {
		return false;
	};
	!kind.is_empty()
		&& !subtype.is_empty()
		&& !essence.bytes().any(|byte| byte.is_ascii_whitespace())
}

async fn replicate_verdict_parts(
	client: &omp_env::EnvClient,
	session_store: &omp_journal::blob::BlobStore,
	invocation_id: &str,
	parts: Vec<omp_proto::thread::v1::Part>,
	max_bytes: u64,
	cancel: &tokio_util::sync::CancellationToken,
) -> Result<Vec<ToolPart>, OutcomeReplicationError> {
	let mut replicated = FastHashMap::<Hash32, u64>::default();
	let mut projected = Vec::with_capacity(parts.len());
	for mut part in parts {
		let Some(omp_proto::thread::v1::part::Kind::Blob(blob)) = part.kind.as_mut() else {
			if let Some(part) = tool_part(part) {
				projected.push(part);
			}
			continue;
		};
		if cancel.is_cancelled() {
			return Err(OutcomeReplicationError::Interrupted);
		}
		if !valid_blob_media_type(&blob.mime) {
			return Err(OutcomeReplicationError::InvalidMedia);
		}
		if blob.size > max_bytes {
			return Err(OutcomeReplicationError::MediaTooLarge { size: blob.size, limit: max_bytes });
		}
		let reference = if blob.inline.is_empty() {
			let hash: [u8; 32] = blob
				.hash
				.as_ref()
				.try_into()
				.map_err(|_| OutcomeReplicationError::InvalidMedia)?;
			omp_journal::blob::BlobRef { hash: Hash32::new(hash), size: blob.size }
		} else {
			let size = u64::try_from(blob.inline.len()).unwrap_or(u64::MAX);
			if size != blob.size {
				return Err(OutcomeReplicationError::InvalidMedia);
			}
			let hash = Hash32::sum(&blob.inline);
			if !blob.hash.is_empty() && blob.hash.as_ref() != hash.as_bytes() {
				return Err(OutcomeReplicationError::InvalidMedia);
			}
			let reference = session_store.put(&blob.inline)?;
			blob.hash = Bytes::copy_from_slice(reference.hash.as_bytes());
			blob.inline = Bytes::new();
			reference
		};
		if let Some(previous_size) = replicated.insert(reference.hash, reference.size) {
			if previous_size != reference.size {
				return Err(OutcomeReplicationError::IdentityChanged);
			}
		} else if session_store.has(&reference) {
			if !session_store.verify(&reference)? {
				return Err(OutcomeReplicationError::IdentityChanged);
			}
		} else {
			let replicated = replicate_outcome_blob(
				client,
				session_store,
				invocation_id,
				reference.hash,
				reference.size,
				max_bytes,
				cancel,
			)
			.await?;
			if replicated != reference {
				return Err(OutcomeReplicationError::IdentityChanged);
			}
		}
		if let Some(part) = tool_part(part) {
			projected.push(part);
		}
	}
	Ok(projected)
}

/// The requirements of one environment admission query for the call of `name`
/// with committed arguments `args`.
///
/// A `bash` call presents its exact command. Any other call presents the tool
/// itself at the tier its envelope was judged by, unless that tier is a fetch,
/// and, when the envelope fetches, one `network` requirement per distinct
/// host the environment named for its fetches, beside the tool's own
/// ([`omp_envd::fetch_host::tool_fetch_subject`]) for any fetch it could not
/// name: one it reported unnamed, a target that names no host, or a call with
/// no named host at all. Every requirement offers `once` and `session`, and a
/// session grant covers a later prompt only when each of that prompt's
/// requirements is granted, so a grant for one host never covers another and
/// the tool's own fetch never covers a host.
fn admission_specs(
	name: &str,
	args: &str,
	query: &omp_env::frame::AdmitInvocation,
) -> Vec<omp_agent::ApprovalSpec> {
	let requirement = |title, body, subject, kind: &'static str, evidence| omp_agent::ApprovalSpec {
		title,
		body,
		subject,
		kind: Str::new_static(kind),
		scopes: vec![Str::new_static("once"), Str::new_static("session")],
		default: Some(false),
		route: Str::new_static("user"),
		approver: None,
		timeout_ms: query.deadline_ms,
		unreachable: Str::new_static("deny"),
		require_human: true,
		pattern: None,
		evidence: vec![evidence],
	};
	if let Some(bash) = query.bash.as_ref() {
		return vec![requirement(
			sf!("Run {name}"),
			sf!("$ {}", bash.source),
			Str::new(bash.source.as_str()),
			"exec",
			sf!("tool `{name}` requires approval under the session approval mode"),
		)];
	}
	let effects = query
		.effects
		.as_ref()
		.and_then(|envelope| omp_tool::Effects::try_from(envelope).ok());
	let fetches = effects
		.as_ref()
		.is_some_and(|effects| effects.fetch.is_some());
	let tier = effects
		.as_ref()
		.map(omp_contract::posture::ApprovalTier::from_effects);
	let shown = args.chars().take(512).collect::<String>();
	let tool = (tier != Some(omp_contract::posture::ApprovalTier::Fetch)).then(|| {
		requirement(
			sf!("Run {name}"),
			sf!("{name} {shown}"),
			Str::new(name),
			"tool",
			sf!("tool `{name}` requires approval under the session approval mode"),
		)
	});
	let named = fetches.then(|| NamedFetches::from_wire(&query.fetch, query.fetch_unnamed));
	let network = named
		.iter()
		.flat_map(|named| named.subjects(name))
		.map(|(subject, about)| {
			requirement(
				sf!("Allow {name} to fetch"),
				sf!("{name} fetches from {about}.\n{name} {shown}"),
				subject,
				NETWORK_APPROVAL_KIND,
				sf!("`{name}` fetches from {about}, which the session approval mode asks for"),
			)
		});
	tool.into_iter().chain(network).collect()
}

/// Resolves native-tool approval from the declared effect tier, session
/// approval mode, and per-tool overrides, and keys a fetch on the hosts it
/// reaches.
///
/// It reports the session's approval posture only once
/// [`install_tool_authority`] installs it.
pub struct SettingsAdmission {
	settings:    omp_envd::tool_settings::ToolSettings,
	sandbox:     omp_contract::posture::SandboxState,
	posture:     PostureNotice,
	/// Names the hosts the fetches of the native tools this kernel runs reach
	/// ([`Self::with_fetch_hosts`]); without it every such fetch is asked as
	/// the tool's own.
	fetch_hosts: Option<FetchHostNamer>,
}

/// The live session's one report that its `yolo` runs with no sandbox
/// confining it.
///
/// The report ([`omp_contract::posture::ApprovalPosture`]) is a typed
/// `approval-posture` notice on the kernel mailbox, posted when the first call
/// of any tool is admitted. Calls are admitted in two places: by the kernel
/// ([`SettingsAdmission`], for the native tools this process runs) and by the
/// environment that runs them ([`EnvToolExecutor`], for every environment tool
/// of a session attached to the project daemon and the worker tools of any
/// composition). [`install_tool_authority`] gives both clones of one report,
/// so the session is told once, at whichever admission comes first. The
/// default reports nothing.
#[derive(Clone, Default)]
struct PostureNotice(Option<Arc<PendingPosture>>);

/// A posture to report, where to, and whether the session the kernel serves
/// has been told.
struct PendingPosture {
	posture: omp_contract::posture::ApprovalPosture,
	mailbox: flume::Sender<omp_agent::Up>,
	/// Set when an admission posts the report, and re-derived from the live
	/// branch of the session the kernel serves ([`Self::sync`]).
	posted:  std::sync::atomic::AtomicBool,
}

impl PendingPosture {
	/// Marks the report spent exactly when the live branch of `session` holds
	/// an `approval-posture` notice of this posture, whichever process
	/// journaled it. A notice of another posture leaves this one due.
	fn sync(&self, session: &Session) {
		let dom = session.dom();
		let name = PropKey::Custom(Str::new_static("name"));
		let data = PropKey::from(omp_dom::PropId::Data);
		let told = dom
			.handles()
			.filter_map(|handle| dom.get(handle))
			.any(|node| {
				node.tag == omp_dom::Tag::Known(omp_dom::KnownTag::Notice)
					&& node.prop(&name).and_then(Value::as_str)
						== Some(omp_contract::posture::APPROVAL_POSTURE_NOTICE)
					&& matches!(node.prop(&data), Some(Value::Json(payload))
						if serde_json::from_str::<omp_contract::posture::ApprovalPosture>(payload.get())
							.is_ok_and(|told| told == self.posture))
			});
		self
			.posted
			.store(told, std::sync::atomic::Ordering::Release);
	}
}

/// The kernel outlives the session it serves, and a rewind can drop the turn
/// that holds the notice (a tool-tail retry rewinds past it to the call's
/// authorization), so the journal the kernel serves afterwards decides again
/// whether the report is due.
impl omp_agent::SessionObserver for PendingPosture {
	fn rewound(&self, session: &Session) {
		self.sync(session);
	}

	fn switched(&self, next: &Session) {
		self.sync(next);
	}
}

impl PostureNotice {
	/// Posts the notice unless an earlier admission did.
	fn post(&self) {
		let Some(pending) = &self.0 else {
			return;
		};
		if pending
			.posted
			.swap(true, std::sync::atomic::Ordering::AcqRel)
		{
			return;
		}
		let Ok(data) = serde_json::value::to_raw_value(&pending.posture) else {
			return;
		};
		let _ = pending
			.mailbox
			.send(omp_agent::Up::Env(omp_agent::EnvEvent::TypedNotice {
				kind: Str::new_static("warn"),
				name: Str::new_static(omp_contract::posture::APPROVAL_POSTURE_NOTICE),
				data,
				body: pending.posture.body(),
			}));
	}
}

/// Posts `withheld` as one typed [`WITHHELD_NOTICE`] notice on `mailbox`; the
/// kernel journals it under the session's next turn, as it journals the
/// approval-posture report.
fn post_withheld_notice(mailbox: &flume::Sender<omp_agent::Up>, withheld: &WithheldInputs) {
	let data = match serde_json::value::to_raw_value(withheld) {
		Ok(data) => data,
		Err(error) => {
			tracing::warn!(%error, "the withheld workspace inputs could not be encoded");
			return;
		},
	};
	let _ = mailbox.send(omp_agent::Up::Env(omp_agent::EnvEvent::TypedNotice {
		kind: Str::new_static("warn"),
		name: Str::new_static(WITHHELD_NOTICE),
		data,
		body: withheld.body(),
	}));
}

impl SettingsAdmission {
	/// Resolves the policy from the effective control plane plus the
	/// invocation's `--approval-mode` override, against the sandbox the control
	/// plane constructs for `workspace_root`.
	///
	/// That probe decides only the calls admitted here. A session joins only a
	/// project daemon whose sandbox and approval policy equals its own
	/// (`omp_envd::daemon_policy`), but the daemon probed the same settings on
	/// its own, so the session's approval posture is reported from the state
	/// the environment reports instead ([`install_tool_authority`]).
	#[must_use]
	pub fn new(
		ctx: &omp_con::Ctx,
		approval_mode: Option<omp_contract::posture::ApprovalMode>,
		workspace_root: &Path,
	) -> Self {
		Self {
			settings:    omp_envd::tool_settings::ToolSettings::from_con(ctx)
				.with_approval_mode_override(approval_mode),
			sandbox:     omp_envd::admission::probe_sandbox(ctx, workspace_root),
			posture:     PostureNotice::default(),
			fetch_hosts: None,
		}
	}

	/// Binds the host's trust decision to native-tool admission and posture.
	#[must_use]
	pub fn with_workspace_trust(mut self, trust: WorkspaceTrust) -> Self {
		self.settings = self.settings.with_workspace_trust(trust);
		self
	}

	/// Keys each fetch of a native tool this kernel runs on the hosts `namer`
	/// names for the URLs the call fetches, as the environment's admission
	/// gate keys the fetches of the tools it runs. `namer` must name with the
	/// resolvers of the environment whose native tools the kernel runs
	/// ([`omp_envd::ProjectEnvironment::fetch_hosts`]).
	#[must_use]
	pub fn with_fetch_hosts(mut self, namer: FetchHostNamer) -> Self {
		self.fetch_hosts = Some(namer);
		self
	}
}

impl omp_agent::ToolAdmission for SettingsAdmission {
	/// The probed sandbox counts only for a tool it confines. Over an attached
	/// daemon every tool admitted here is session-process host code (session
	/// base, RPC host tools) and `Host`; an embedded or isolated composition
	/// also runs the environment's native tools here, `bash` among them.
	///
	/// A prompt holds the call's exact command when it has one; otherwise the
	/// tool at its tier unless that tier is a fetch, and, when the call
	/// fetches, one `network` requirement per host the fetch hosts namer
	/// names for `fetch_locators`, beside the tool's own for any fetch left
	/// unnamed, exactly as [`admission_specs`] asks for an environment-run
	/// call.
	fn admit(
		&self,
		name: &str,
		effects: &omp_tool::Effects,
		confinement: omp_tool::Confinement,
		args: &serde_json::value::RawValue,
		fetch_locators: &[Str],
	) -> omp_agent::ToolAdmissionVerdict {
		self.posture.post();
		let resolved = self
			.settings
			.approval_for(name, name, effects, confinement, self.sandbox);
		match resolved.policy {
			omp_contract::posture::ApprovalPolicy::Allow => omp_agent::ToolAdmissionVerdict::Allow,
			omp_contract::posture::ApprovalPolicy::Deny => omp_agent::ToolAdmissionVerdict::Deny(sf!(
				"tool `{name}` is denied by approval policy (tools.approval.{name})"
			)),
			omp_contract::posture::ApprovalPolicy::Prompt => {
				let command = serde_json::from_str::<serde_json::Value>(args.get())
					.ok()
					.and_then(|value| {
						value
							.get("command")
							.and_then(serde_json::Value::as_str)
							.map(str::to_owned)
					});
				let evidence = admission_evidence(
					&resolved,
					omp_contract::posture::effective_approval_mode(
						self.settings.configured_approval(),
						self.sandbox,
					),
				);
				let requirement =
					|title: Str, body: Str, subject: Str, kind: &'static str| omp_agent::ApprovalSpec {
						title,
						body,
						subject,
						kind: Str::new_static(kind),
						scopes: vec![Str::new_static("once"), Str::new_static("session")],
						default: Some(false),
						route: Str::new_static("user"),
						approver: None,
						timeout_ms: 0,
						unreachable: Str::new_static("deny"),
						require_human: true,
						pattern: None,
						evidence: evidence.clone(),
					};
				if let Some(command) = &command {
					return omp_agent::ToolAdmissionVerdict::Prompt(vec![requirement(
						sf!("Run {name}"),
						sf!("$ {command}"),
						Str::new(command.as_str()),
						"exec",
					)]);
				}
				let shown = args.get().chars().take(512).collect::<String>();
				let tool = (resolved.tier != omp_contract::posture::ApprovalTier::Fetch).then(|| {
					requirement(sf!("Run {name}"), sf!("{name} {shown}"), Str::new(name), "tool")
				});
				let named = effects.fetch.is_some().then(|| match &self.fetch_hosts {
					Some(namer) => namer.name(fetch_locators),
					None => NamedFetches::unnamed(),
				});
				let network =
					named
						.iter()
						.flat_map(|named| named.subjects(name))
						.map(|(subject, about)| {
							requirement(
								sf!("Allow {name} to fetch"),
								sf!("{name} fetches from {about}.\n{name} {shown}"),
								subject,
								NETWORK_APPROVAL_KIND,
							)
						});
				omp_agent::ToolAdmissionVerdict::Prompt(tool.into_iter().chain(network).collect())
			},
		}
	}
}

/// Why a native call needs approval: its tier and confinement under the mode
/// in force for it, and, when the session's `yolo` holds only inside the
/// sandbox, that this tool runs outside it.
fn admission_evidence(
	resolved: &omp_contract::posture::ResolvedApproval,
	session_mode: omp_contract::posture::ApprovalMode,
) -> Vec<Str> {
	let tier: &'static str = resolved.tier.into();
	let confinement: &'static str = resolved.confinement.into();
	let mode: &'static str = resolved.mode.into();
	let mut evidence =
		vec![sf!("{tier} tier, {confinement} confinement, under approval mode {mode}")];
	if resolved.mode != session_mode {
		evidence.push(Str::new_static(
			"the default `yolo` covers only tools the sandbox confines; this tool runs outside it",
		));
	}
	evidence
}

/// The structured denial the environment journals when the prompt refused
/// the call.
fn admission_denial(
	call_id: &str,
	name: &str,
	decision: &omp_agent::ApprovalDecision,
) -> omp_proto::policy::v1::PolicyDenied {
	let by = <&'static str>::from(decision.source);
	omp_proto::policy::v1::PolicyDenied {
		reason:      decision.reason.as_deref().map_or_else(
			|| format!("Tool call denied by {by}: {name}"),
			|reason| format!("Tool call denied by {by}: {name} ({reason})"),
		),
		code:        String::from("approval_denied"),
		decision_id: call_id.to_owned(),
		rules:       vec![format!("tools.approval.{name}")],
		props:       Default::default(),
	}
}

impl ExternalToolExecutor for EnvToolExecutor {
	fn authorize_visibility<'a>(
		&'a self,
		identity: &'a omp_tool::ToolIdentity,
		verdict: Bytes,
		receipt: omp_tool::VisibilityReceipt,
	) -> omp_agent::VisibilityAuthorizationFuture<'a> {
		Box::pin(async move {
			self
				.client
				.authorize_visibility(omp_env::frame::VisibilityAuthorization {
					name: identity.name.as_str().to_owned(),
					rev: identity.rev.to_string(),
					verdict,
					lines: receipt
						.lines
						.into_iter()
						.map(|line| omp_env::frame::VisibleSourceLine {
							source_key: line.source_key.as_str().to_owned(),
							line:       line.line as u64,
						})
						.collect(),
				})
				.await
				.map_err(omp_tool::ProjectionAuthorizationError::new)
		})
	}

	fn invoke(&self, request: ExternalDispatchRequest) -> ExternalDispatchStream {
		let client = self.client.clone();
		let approvals = self.approvals.clone();
		let posture = self.posture.clone();
		let outcome_store = request.blobs.clone();
		Box::pin(async_stream::stream! {
			let client = match client.with_principal(request.session_id.clone(), "kernel") {
				Ok(client) => client,
				Err(source) => {
					tracing::warn!(%source, call_id = %request.call_id, "environment tool principal is invalid");
					yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
						reason: Str::new_static("environment tool principal is invalid"),
					});
					return;
				},
			};
			let opened = client.invoke(omp_env::frame::InvokeTool {
				invocation_id: request.call_id.to_string(),
				name: request.identity.name.to_string(),
				rev: request.identity.rev.to_string(),
				deadline_ms: u64::try_from(request.blocking_limit.as_millis()).unwrap_or(u64::MAX),
				output_request: match request.output_request {
					omp_tool::OutputRequest::Bounded => {
						omp_env::frame::OutputRequest::Bounded as i32
					},
					omp_tool::OutputRequest::Complete => {
						omp_env::frame::OutputRequest::Complete as i32
					},
				},
				// The environment hands the request's roster to tools hosting
				// nested calls (the eval bridge), which apply it per call.
				restrictions: request.restrictions.as_deref().map(Into::into),
				..Default::default()
			}).await;
			let mut invocation = match opened {
				Ok(invocation) => invocation,
				Err(source) => {
					tracing::warn!(%source, call_id = %request.call_id, "environment tool open failed");
					yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
						reason: Str::new_static("environment tool open failed"),
					});
					return;
				},
			};
			match invocation.next_event().await {
				Ok(Some(omp_env::InvocationEvent::Accepted(_))) => {},
				Ok(_) => {
					yield ExternalDispatchEvent::Aborted(Abort::InputDropped);
					return;
				},
				Err(source) => {
					tracing::warn!(%source, call_id = %request.call_id, "environment tool acceptance failed");
					yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
						reason: Str::new_static("environment tool acceptance failed"),
					});
					return;
				},
			}
			let token = Bytes::from(Ulid::generate().to_string());
			let authorized_at_ms = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX));
			// The environment admits the call on its committed arguments: the
			// session hears its posture first, before any prompt that admission
			// files.
			posture.post();
			if let Err(source) = invocation
				.commit_args(Bytes::copy_from_slice(request.args.get().as_bytes()), token, authorized_at_ms, None)
				.await
			{
				tracing::warn!(%source, call_id = %request.call_id, "environment tool commit failed");
				yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
					reason: Str::new_static("environment tool commit failed"),
				});
				return;
			}
			// ADR 0011: the stop request is forwarded to the environment, which
			// interrupts the unit (TERM, `sv_interrupt_grace`, KILL) and reports
			// the unit's own verdict; the dispatcher bounds how long that report
			// may take. Dropping this stream cancels the request as well.
			let mut interrupted = false;
			loop {
				let next = tokio::select! {
					biased;
					() = request.cancellation.cancelled(), if !interrupted => {
						interrupted = true;
						if let Err(source) = invocation.interrupt(Str::new_static("interrupted")).await {
							tracing::warn!(%source, call_id = %request.call_id, "environment tool interrupt failed");
							yield ExternalDispatchEvent::Aborted(Abort::EffectsUnknown {
								reason: Str::new_static("environment tool interrupt failed"),
							});
							return;
						}
						continue;
					},
					next = invocation.next_event() => next,
				};
				match next {
					Ok(Some(omp_env::InvocationEvent::Accepted(_))) => {},
					Ok(Some(omp_env::InvocationEvent::Admission(query))) => {
						let specs = admission_specs(request.identity.name.as_str(), request.args.get(), &query);
						let ticket = approvals
							.request_cancellable(
								Some(request.call_id.clone()),
								specs,
								authorized_at_ms,
								request.cancellation.clone(),
							)
							.await;
						let decision = ticket.decision.unwrap_or_else(|| omp_agent::ApprovalDecision {
							approved:   false,
							scope:      omp_agent::ApprovalScope::Once,
							source:     omp_agent::ApprovalSource::Unavailable,
							decided_by: None,
							reason:     Some(Str::new_static("approval prompt settled without a decision")),
							audited:    false,
						});
						let admission = omp_env::frame::Admission {
							invocation_id: query.invocation_id,
							allow: decision.approved,
							denied: (!decision.approved).then(|| {
								admission_denial(request.call_id.as_str(), request.identity.name.as_str(), &decision)
							}),
							..Default::default()
						};
						if let Err(source) = invocation.admit(admission).await {
							tracing::warn!(%source, call_id = %request.call_id, "environment tool admission failed");
							yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
								reason: Str::new_static("environment tool admission failed"),
							});
							return;
						}
					},
					Ok(Some(omp_env::InvocationEvent::Update(update))) => {
						match raw_json(update.json) {
							Ok(update) => yield ExternalDispatchEvent::Update(update),
							Err(()) => {
								yield ExternalDispatchEvent::Aborted(Abort::MissingOutcome);
								return;
							},
						}
					},
					Ok(Some(omp_env::InvocationEvent::Verdict(verdict))) => {
						if verdict.invocation_id != request.call_id.as_str() {
							tracing::warn!(
								call_id = %request.call_id,
								verdict_invocation_id = %verdict.invocation_id,
								"environment verdict provenance does not match the invocation"
							);
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						let inline_json = verdict.json;
						let Some(projection) = verdict.projection else {
							tracing::warn!(call_id = %request.call_id, "environment verdict omitted output projection facts");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						};
						let Some(details) = verdict.details_blob else {
							tracing::warn!(call_id = %request.call_id, "environment verdict omitted outcome blob");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						};
						if !valid_output_projection(request.output_request, &projection, &details) {
							tracing::warn!(call_id = %request.call_id, "environment verdict output projection facts are invalid");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						if details.mime != "application/json" || !details.inline.is_empty() {
							tracing::warn!(call_id = %request.call_id, mime = %details.mime, "environment verdict blob provenance is invalid");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						let hash: [u8; 32] = if let Ok(hash) = details.hash.as_ref().try_into() { hash } else {
							tracing::warn!(call_id = %request.call_id, hash_bytes = details.hash.len(), "environment verdict blob digest is invalid");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						};
						let expected_hash = Hash32::new(hash);
						let max_bytes = u64::try_from(omp_proto::bounds::FRAME_MAX_BYTES)
							.expect("protocol frame limit fits u64");
						if details.size > max_bytes {
							tracing::warn!(
								call_id = %request.call_id,
								size = details.size,
								limit = max_bytes,
								"environment outcome blob exceeds the host retrieval bound"
							);
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						let (source_artifact, bytes) = if inline_json.is_empty() {
							let source_artifact = match replicate_outcome_blob(
								&client,
								&outcome_store,
								request.call_id.as_str(),
								expected_hash,
								details.size,
								max_bytes,
								&request.cancellation,
							)
							.await
							{
								Ok(source_artifact) => source_artifact,
								Err(OutcomeReplicationError::Interrupted) => {
									yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
										reason: Str::new_static("environment outcome retrieval interrupted"),
									});
									return;
								},
								Err(source) => {
									tracing::warn!(%source, call_id = %request.call_id, "environment outcome replication failed");
									yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
									return;
								},
							};
							let bytes = match outcome_store.get(&source_artifact) {
								Ok(bytes) => bytes,
								Err(source) => {
									tracing::warn!(%source, call_id = %request.call_id, "session outcome artifact read failed");
									yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
									return;
								},
							};
							(source_artifact, bytes)
						} else {
							let inline_size = u64::try_from(inline_json.len()).unwrap_or(u64::MAX);
							if inline_size != details.size
								|| projection.source_bytes != details.size
								|| projection.inline_bytes != inline_size
								|| projection.omitted
								|| Hash32::sum(&inline_json) != expected_hash
							{
								tracing::warn!(
									call_id = %request.call_id,
									"environment inline outcome does not match its artifact"
								);
								yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
								return;
							}
							let source_artifact = match outcome_store.put(&inline_json) {
								Ok(source_artifact) => source_artifact,
								Err(source) => {
									tracing::warn!(%source, call_id = %request.call_id, "session outcome artifact write failed");
									yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
									return;
								},
							};
							(source_artifact, inline_json)
						};
						let terminal = match decode_environment_terminal(&bytes) {
							Ok(terminal) => terminal,
							Err(source) => {
								tracing::warn!(%source, call_id = %request.call_id, "environment outcome blob is not a supported terminal");
								yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
								return;
							},
						};
						let typed_is_error = match &terminal {
							EnvironmentTerminal::Outcome(outcome) => !matches!(outcome, CallOutcome::Ok(_)),
							EnvironmentTerminal::Detached(DetachedVerdict::Detached(job)) => {
								if !valid_detached_job(job, request.session_id.as_str()) || verdict.useless {
									tracing::warn!(call_id = %request.call_id, "environment detached job is invalid or stale");
									yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
									return;
								}
								false
							},
						};
						if typed_is_error != verdict.is_error {
							tracing::warn!(
								call_id = %request.call_id,
								wire_is_error = verdict.is_error,
								typed_is_error,
								"environment outcome classification mismatch"
							);
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						let visibility = if let Ok(visibility) = tool_visibility_spans(verdict.visibility, &verdict.parts) { visibility } else {
							tracing::warn!(call_id = %request.call_id, "environment visibility spans are invalid");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						};
						let mut parts = match replicate_verdict_parts(
							&client,
							&outcome_store,
							request.call_id.as_str(),
							verdict.parts,
							max_bytes,
							&request.cancellation,
						)
						.await
						{
							Ok(parts) => parts,
							Err(OutcomeReplicationError::Interrupted) => {
								yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
									reason: Str::new_static("environment media retrieval interrupted"),
								});
								return;
							},
							Err(source) => {
								tracing::warn!(%source, call_id = %request.call_id, "environment verdict media replication failed");
								yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
								return;
							},
						};
						match terminal {
							EnvironmentTerminal::Outcome(outcome) => {
								if parts.is_empty() {
									parts = harness_parts(&outcome);
								}
								yield ExternalDispatchEvent::DoneProjected {
									outcome,
									parts,
									is_error: verdict.is_error,
									source_artifact: Some(source_artifact),
									projection: tool_output_projection(projection),
									visibility,
								};
							},
							EnvironmentTerminal::Detached(DetachedVerdict::Detached(job)) => {
								if parts.is_empty() {
									parts.push(ToolPart::Text { text: sf!("detached job {}", job.id) });
								}
								yield ExternalDispatchEvent::DetachedProjected {
									job,
									parts,
									source_artifact,
									projection: tool_output_projection(projection),
								};
							},
						}
						return;
					},
					Ok(None) => {
						yield ExternalDispatchEvent::Aborted(Abort::MissingOutcome);
						return;
					},
					Err(source) => {
						tracing::warn!(%source, call_id = %request.call_id, "environment tool stream failed");
						yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
							reason: Str::new_static("environment tool stream failed"),
						});
						return;
					},
				}
			}
		})
	}
}

// Detached descriptors are executor terminals, not one of CallOutcome's
// settled branches. Keep their original artifact bytes through the boundary.
enum EnvironmentTerminal {
	Outcome(CallOutcome<serde_json::Value, serde_json::Value>),
	Detached(DetachedVerdict),
}

fn decode_environment_terminal(bytes: &[u8]) -> Result<EnvironmentTerminal, serde_json::Error> {
	// Ordinary outcomes retain their single-pass decoding path. Only detached
	// executor terminals need the second, distinct tagged wire shape.
	match serde_json::from_slice::<CallOutcome<serde_json::Value, serde_json::Value>>(bytes) {
		Ok(outcome) => Ok(EnvironmentTerminal::Outcome(outcome)),
		Err(_) => serde_json::from_slice(bytes).map(EnvironmentTerminal::Detached),
	}
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DetachedVerdict {
	Detached(omp_tool::JobRef),
}

fn valid_detached_job(job: &omp_tool::JobRef, session_id: &str) -> bool {
	!job.id.is_empty()
		&& match &job.owner {
			omp_tool::JobOwner::NamedProcess { name, generation } => {
				!name.is_empty() && *generation != 0
			},
			omp_tool::JobOwner::AgentLoop { agent_id } => !agent_id.is_empty(),
		} && matches!(job.metadata.status, omp_tool::JobStatus::Queued | omp_tool::JobStatus::Running)
		&& job.metadata.settled_at_ms.is_none()
		&& job
			.metadata
			.owner_session
			.as_ref()
			.is_none_or(|owner| owner == session_id)
}

fn raw_json(bytes: Bytes) -> Result<Box<serde_json::value::RawValue>, ()> {
	let text = String::from_utf8(bytes.to_vec()).map_err(|_| ())?;
	serde_json::value::RawValue::from_string(text).map_err(|_| ())
}

/// Model-facing text for a verdict the environment published without parts:
/// the harness-owned branches it authors itself (aborts and policy denials)
/// or a worker left unprojected (rejected arguments). A tool-owned `Ok` or
/// `Faulted` branch carries the tool's own projection from the environment
/// and is never reconstructed from its payload here.
fn harness_parts(outcome: &CallOutcome<serde_json::Value, serde_json::Value>) -> Vec<ToolPart> {
	match outcome {
		CallOutcome::ArgsRejected(_) => {
			vec![ToolPart::Text { text: Str::new_static("Tool arguments were rejected") }]
		},
		CallOutcome::Aborted { abort, .. } => vec![ToolPart::Text { text: abort.render() }],
		CallOutcome::Ok(_) | CallOutcome::Faulted(_) => Vec::new(),
	}
}

fn tool_output_projection(
	projection: omp_env::frame::OutputProjection,
) -> omp_tool::OutputProjection {
	let request = match omp_env::frame::OutputRequest::try_from(projection.request) {
		Ok(omp_env::frame::OutputRequest::Complete) => omp_tool::OutputRequest::Complete,
		Ok(omp_env::frame::OutputRequest::Bounded | omp_env::frame::OutputRequest::Unspecified)
		| Err(_) => omp_tool::OutputRequest::Bounded,
	};
	let artifact = projection.artifact.map(|artifact| ToolBlobRef {
		hash:       Str::new(omp_core::hex::encode(&artifact.hash).to_string()),
		media_type: Str::new(artifact.mime),
		byte_len:   artifact.size,
	});
	omp_tool::OutputProjection {
		request,
		source_bytes: projection.source_bytes,
		inline_bytes: projection.inline_bytes,
		omitted: projection.omitted,
		artifact,
	}
}

fn valid_output_projection(
	request: omp_tool::OutputRequest,
	projection: &omp_env::frame::OutputProjection,
	details: &omp_proto::thread::v1::Blob,
) -> bool {
	let expected_request = match request {
		omp_tool::OutputRequest::Bounded => omp_env::frame::OutputRequest::Bounded as i32,
		omp_tool::OutputRequest::Complete => omp_env::frame::OutputRequest::Complete as i32,
	};
	let inline_limit = match request {
		omp_tool::OutputRequest::Bounded => omp_agent::DispatchPolicy::DEFAULT_MAX_OUTPUT_BYTES,
		omp_tool::OutputRequest::Complete => omp_agent::DispatchPolicy::MAX_COMPLETE_OUTPUT_BYTES,
	};
	projection.request == expected_request
		&& projection.inline_bytes <= u64::try_from(inline_limit).unwrap_or(u64::MAX)
		&& projection.source_bytes >= projection.inline_bytes
		&& projection.artifact.as_ref().is_some_and(|artifact| {
			artifact.hash == details.hash
				&& artifact.size == details.size
				&& artifact.mime == details.mime
				&& artifact.inline.is_empty()
		})
}

const fn invalid_outcome_blob() -> Abort {
	Abort::EffectsUnknown {
		reason: Str::new_static("environment returned an invalid outcome artifact"),
	}
}

fn tool_visibility_spans(
	visibility: Vec<omp_env::frame::ProjectionSpan>,
	parts: &[omp_proto::thread::v1::Part],
) -> Result<Vec<omp_tool::ProjectionSpan>, ()> {
	if visibility.is_empty() {
		return Ok(Vec::new());
	}
	use omp_proto::thread::v1::part::Kind;
	let mut next = 0;
	let remapped = parts
		.iter()
		.map(|part| {
			let retained =
				matches!(part.kind.as_ref(), Some(Kind::Text(_) | Kind::Thinking(_) | Kind::Blob(_)));
			let index = retained.then_some(next);
			next += usize::from(retained);
			index
		})
		.collect::<Vec<_>>();
	visibility
		.into_iter()
		.map(|span| {
			let part = usize::try_from(span.part).map_err(|_| ())?;
			let start_byte = usize::try_from(span.start_byte).map_err(|_| ())?;
			let end_byte = usize::try_from(span.end_byte).map_err(|_| ())?;
			let line = usize::try_from(span.line).map_err(|_| ())?;
			let text = match parts.get(part).and_then(|part| part.kind.as_ref()) {
				Some(Kind::Text(text)) => text.as_str(),
				Some(Kind::Thinking(thinking)) => thinking.text.as_str(),
				_ => return Err(()),
			};
			if line == 0
				|| span.source_key.is_empty()
				|| start_byte >= end_byte
				|| end_byte > text.len()
				|| !text.is_char_boundary(start_byte)
				|| !text.is_char_boundary(end_byte)
			{
				return Err(());
			}
			Ok(omp_tool::ProjectionSpan {
				part: remapped[part].ok_or(())?,
				start_byte,
				end_byte,
				source_key: Str::from(span.source_key),
				line,
			})
		})
		.collect()
}

fn tool_part(part: omp_proto::thread::v1::Part) -> Option<ToolPart> {
	match part.kind? {
		omp_proto::thread::v1::part::Kind::Text(text) => {
			Some(ToolPart::Text { text: Str::new(text) })
		},
		omp_proto::thread::v1::part::Kind::Thinking(thinking) => {
			Some(ToolPart::Text { text: Str::new(thinking.text) })
		},
		omp_proto::thread::v1::part::Kind::Blob(blob) => Some(ToolPart::Blob {
			blob: ToolBlobRef {
				hash:       Str::new(omp_core::hex::encode(&blob.hash).to_string()),
				media_type: Str::new(blob.mime),
				byte_len:   blob.size,
			},
			alt:  None,
		}),
		omp_proto::thread::v1::part::Kind::Fallback(_)
		| omp_proto::thread::v1::part::Kind::ServerTool(_) => None,
	}
}

impl omp_agent::Inference for ProductionInference {
	fn chat(
		&mut self,
		mut request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.apply_convars(&mut request);
		self.routes.client_mut().execute(request)
	}

	/// A discovery refresh published since the last turn becomes this turn's
	/// registry; the previous turn finished on the one it started with.
	fn begin_turn(&mut self) {
		if self.routes.adopt_published() {
			tracing::debug!(
				models = self.routes.catalog().models().len(),
				"turn adopted the refreshed model catalog"
			);
		}
	}

	/// One isolated call on `selector` (a catalog model, alias, or `@role`
	/// such as the advisor's `@advisor`): the client is re-targeted for the
	/// plan only and restored to the live route afterwards, so the primary's
	/// next request is untouched. An unresolvable selector is a planning
	/// `TargetNotFound` (the advisor journals `no_model`).
	fn chat_on(
		&mut self,
		selector: &str,
		mut request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.apply_account_pins();
		let resolved = isolated_call_model(self.routes.catalog().as_ref(), &self.con, selector);
		async move {
			let key = resolved?;
			default_reasoning(self.routes.catalog().as_ref(), &self.con, &key, &mut request);
			let live = self.routes.client_mut().call_meta().clone();
			let mut meta = self.meta.clone();
			meta.target = retarget(&self.meta.target, key);
			self.routes.client_mut().set_call_meta(meta);
			let result = self.routes.client_mut().execute(request).await;
			self.routes.client_mut().set_call_meta(live);
			result
		}
	}

	fn install_retry_sink(&mut self, sink: omp_ai::RetrySink) {
		// Both the launch metadata (the base every `ai_model` re-target copies)
		// and the client's live copy carry the sink.
		self.meta.response_hooks = self.meta.response_hooks.clone().with_retry_sink(sink);
		let mut live = self.routes.client_mut().call_meta().clone();
		live.response_hooks = self.meta.response_hooks.clone();
		self.routes.client_mut().set_call_meta(live);
	}
}

/// A cloneable auxiliary inference handle for enhanced speech rewriting.
///
/// It shares the production registry and credential authorities already
/// composed for the session; it never creates a second provider stack.
#[derive(Clone)]
pub enum SpeechRewriteClient {
	/// Direct provider call sharing the session's registry and credentials.
	Production {
		/// The session's registry publication point; each rewrite routes
		/// through its current snapshot.
		registry: omp_ai::RegistryHandle,
		/// Resolved tiny-role model.
		model:    omp_catalog::ModelKey,
	},
	/// Auxiliary call through the already-connected inference gateway.
	Gateway {
		/// Cloneable gateway client.
		inference: GatewayInference,
	},
}

/// Typed failure from one enhanced-speech auxiliary completion.
#[derive(Debug, thiserror::Error)]
pub enum SpeechRewriteClientError {
	/// The operation was cancelled before a final response.
	#[error("speech rewrite was cancelled")]
	Cancelled,
	/// The rewrite exceeded its bounded completion deadline.
	#[error("speech rewrite timed out")]
	Timeout,
	/// The production inference route failed.
	#[error("speech rewrite inference failed")]
	Inference {
		/// Typed provider/runtime source.
		#[source]
		source: omp_ai::Error,
	},
	/// The route completed without emitting speakable text.
	#[error("speech rewrite completed without text")]
	EmptyOutput,
}

impl SpeechRewriteClient {
	/// Rewrites one bounded block on the configured `@tiny` role.
	pub async fn rewrite(
		&self,
		instruction: &'static str,
		text: Str,
		cancel: tokio_util::sync::CancellationToken,
	) -> Result<Str, SpeechRewriteClientError> {
		let message = |role, text| Message {
			role,
			content: Arc::from([ContentPart::Text { text, proof: None }]),
			name: None,
		};
		let request = ChatRequest {
			messages:          Arc::from([
				message(Role::System, Str::new_static(instruction)),
				message(Role::User, text),
			]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: Some(1_536),
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		};
		let mut stream = match self {
			Self::Production { registry, model } => {
				let meta = CallMeta {
					id:             RequestId::from(format!("speech-{}", Ulid::generate())),
					target:         Target::Model(model.clone()),
					deadline:       None,
					budget:         ExecutionBudget::default(),
					session:        None,
					debug_session:  None,
					response_hooks: Default::default(),
				};
				let execute = omp_ai::router::execute_registry_call(
					omp_ai::Registry::clone(&registry.load()),
					Call::new(meta, OperationCall::Chat(Arc::new(request))),
					Duration::from_secs(6),
				);
				let answer = tokio::select! {
					biased;
					() = cancel.cancelled() => return Err(SpeechRewriteClientError::Cancelled),
					answer = execute => answer.map_err(|source| SpeechRewriteClientError::Inference { source })?,
				};
				let AnswerBody::Chat(stream) = answer.body else {
					return Err(SpeechRewriteClientError::EmptyOutput);
				};
				stream
			},
			Self::Gateway { inference } => {
				let mut inference = inference.clone();
				let execute = tokio::time::timeout(
					Duration::from_secs(6),
					omp_agent::Inference::chat_on(&mut inference, "@tiny", request),
				);
				tokio::select! {
					biased;
					() = cancel.cancelled() => return Err(SpeechRewriteClientError::Cancelled),
					stream = execute => stream
						.map_err(|_| SpeechRewriteClientError::Timeout)?
						.map_err(|source| SpeechRewriteClientError::Inference { source })?,
				}
			},
		};
		let mut output = StrMut::new("");
		loop {
			let event = tokio::select! {
				biased;
				() = cancel.cancelled() => return Err(SpeechRewriteClientError::Cancelled),
				event = stream.next() => event,
			};
			let Some(event) = event else { break };
			match event.map_err(|source| SpeechRewriteClientError::Inference { source })? {
				ChatEvent::TextDelta { text, .. } => output.push_str(text.as_str()),
				ChatEvent::Started(_)
				| ChatEvent::BlockStarted { .. }
				| ChatEvent::ThinkingDelta { .. }
				| ChatEvent::ToolCallStarted { .. }
				| ChatEvent::ToolArgumentsDelta { .. }
				| ChatEvent::ToolCallReady { .. }
				| ChatEvent::Artifact { .. }
				| ChatEvent::Usage(_)
				| ChatEvent::WorkflowAction(_)
				| ChatEvent::WorkflowResume(_)
				| ChatEvent::WorkflowCancelled { .. }
				| ChatEvent::Completed(_) => {},
			}
		}
		let output = output.freeze();
		if output.trim().is_empty() {
			Err(SpeechRewriteClientError::EmptyOutput)
		} else {
			Ok(output)
		}
	}
}

/// Cloneable side route over the session's inference authorities, for an
/// auxiliary request issued while the kernel owns the primary route (memory
/// reflection runs inside a tool call).
///
/// A direct production call pins the session's current registry publication
/// and honors its journaled account pins; behind a gateway it rides the
/// already-connected channel. It never builds a second provider stack, and a
/// clone shares every authority.
#[derive(Clone)]
pub struct AuxiliaryInference {
	route: AuxiliaryRoute,
}

#[derive(Clone)]
enum AuxiliaryRoute {
	Production(Arc<AuxiliaryProduction>),
	Gateway(GatewayInference),
}

struct AuxiliaryProduction {
	/// The session's registry publication point.
	registry: omp_ai::RegistryHandle,
	/// Authentication owner that resolves `ai_account_pins` per call.
	auth:     omp_ai::auth::AuthManager,
	/// The session's control context: `ai_model`, `ai_thinking`, roles, pins.
	con:      Arc<omp_con::Ctx>,
	/// Launch target; a selected model re-targets it and keeps its provider.
	target:   Target,
	/// Launch model the live `ai_model` selection falls back to.
	launch:   Str,
}

impl AuxiliaryProduction {
	/// Plans and starts one call on the current publication: `selector` when
	/// given, else the live `ai_model` selection.
	async fn chat(
		&self,
		selector: Option<&str>,
		mut request: ChatRequest,
	) -> Result<ChatStream, omp_ai::Error> {
		let affinity = omp_ai::CallAffinity {
			account_pins: self
				.auth
				.session_pins(&omp_ai::account::AI_ACCOUNT_PINS.get(&self.con)),
			..omp_ai::CallAffinity::none()
		};
		let meta = CallMeta {
			id:             RequestId::from(format!("omp-auxiliary-{}", Ulid::generate())),
			target:         self.target.clone(),
			deadline:       None,
			budget:         ExecutionBudget::default(),
			session:        None,
			debug_session:  None,
			response_hooks: Default::default(),
		};
		let mut routes = PinnedRoutes::new(self.registry.clone(), meta, affinity);
		let key = if let Some(selector) = selector {
			isolated_call_model(routes.catalog().as_ref(), &self.con, selector)?
		} else {
			let model = select_model(routes.catalog().as_ref(), &self.con, &self.launch).0;
			omp_catalog::ModelKey::from(model.as_str())
		};
		default_reasoning(routes.catalog().as_ref(), &self.con, &key, &mut request);
		let mut meta = routes.client().call_meta().clone();
		meta.target = retarget(&self.target, key);
		routes.client_mut().set_call_meta(meta);
		routes.client_mut().execute(request).await
	}
}

impl omp_agent::Inference for AuxiliaryInference {
	/// One call on the session's live `ai_model` selection.
	async fn chat(&mut self, request: ChatRequest) -> Result<ChatStream, omp_ai::Error> {
		match &mut self.route {
			AuxiliaryRoute::Production(production) => production.chat(None, request).await,
			AuxiliaryRoute::Gateway(gateway) => gateway.chat(request).await,
		}
	}

	/// One isolated call on `selector` (a catalog model, alias, or `@role`),
	/// resolved like the kernel's own isolated calls; a gateway decides the
	/// model itself.
	async fn chat_on(
		&mut self,
		selector: &str,
		request: ChatRequest,
	) -> Result<ChatStream, omp_ai::Error> {
		match &mut self.route {
			AuxiliaryRoute::Production(production) => production.chat(Some(selector), request).await,
			AuxiliaryRoute::Gateway(gateway) => gateway.chat_on(selector, request).await,
		}
	}
}

/// Inference selected by one headless invocation.
pub enum ComposedInference {
	/// Direct production provider stack.
	Production(ProductionInference),
	/// Remote inference gateway plus its local project-tool authority.
	Gateway {
		/// Raw gateway turn adapter.
		inference:          GatewayInference,
		/// How composition settled the launch model.
		launch:             LaunchModel,
		/// Environment owner retained for local tool execution.
		_environment:       omp_envd::ProjectEnvironment,
		/// Active session's generation-fenced Agent CONTROL lease.
		_agent_control:     Mutex<Option<omp_envd::AgentControlBinding>>,
		/// Live Python Component reducers retained for the controller lifetime.
		_python_components: Vec<omp_envd::exthost::PyComponent>,
		/// Authenticated eval-parent binding retained for this kernel.
		_eval_parent:       Option<omp_contract::eval_bridge::ParentBindingLease>,
		/// No-session journal cleanup owner.
		_ephemeral_journal: Option<EphemeralJournal>,
		/// Discovered rules and the agent class the live session runs as.
		rules:              Arc<crate::discovery::rules::RuleScope>,
		/// The workspace trust decision this composition runs under.
		workspace_trust:    omp_ext::workspace_trust::TrustDecision,
	},
}

impl ComposedInference {
	fn retain_ephemeral_journal(&mut self, journal: EphemeralJournal) {
		match self {
			Self::Production(inference) => inference._ephemeral_journal = Some(journal),
			Self::Gateway { _ephemeral_journal, .. } => *_ephemeral_journal = Some(journal),
		}
	}

	fn retain_eval_parent(&mut self, lease: omp_contract::eval_bridge::ParentBindingLease) {
		match self {
			Self::Production(inference) => inference._eval_parent = Some(lease),
			Self::Gateway { _eval_parent, .. } => *_eval_parent = Some(lease),
		}
	}

	/// Routes environment-originated checkpoint controls to the kernel mailbox
	/// and clears transient checkpoint state whenever that kernel selects a
	/// different durable session.
	pub fn refresh_agent_control(&self, sender: omp_agent::KernelSender, dom: &omp_dom::Dom) {
		let (environment, slot) = match self {
			Self::Production(inference) => (&inference._environment, &inference._agent_control),
			Self::Gateway { _environment, _agent_control, .. } => (_environment, _agent_control),
		};
		let mut slot = slot.lock();
		if slot.is_none() {
			*slot = Some(environment.bind_agent_control(sender));
		}
		slot
			.as_ref()
			.expect("Agent CONTROL binding was installed")
			.refresh_session(dom);
	}

	/// Borrows the project environment client retained by this composition.
	#[must_use]
	pub const fn environment_client(&self) -> &omp_env::EnvClient {
		match self {
			Self::Production(inference) => inference._environment.client(),
			Self::Gateway { _environment, .. } => _environment.client(),
		}
	}

	/// The discovered rules and the agent class the live session runs as;
	/// [`SessionHome::with_rules`] scopes the rule facts of sessions opened
	/// in-chat with it.
	#[must_use]
	pub const fn rule_scope(&self) -> &Arc<crate::discovery::rules::RuleScope> {
		match self {
			Self::Production(inference) => &inference.rules,
			Self::Gateway { rules, .. } => rules,
		}
	}

	/// The workspace trust decision this composition runs under; a host
	/// composing a child or side kernel over the same workspace hands it on
	/// ([`crate::workspace_trust::WorkspaceTrustSource::Fixed`]).
	#[must_use]
	pub const fn workspace_trust(&self) -> &omp_ext::workspace_trust::TrustDecision {
		match self {
			Self::Production(inference) => &inference.workspace_trust,
			Self::Gateway { workspace_trust, .. } => workspace_trust,
		}
	}

	/// The seam through which an ACP adapter binds its editor as the document
	/// base of this composition's environment (ADR 0037 §1.2). The handle is
	/// cloneable, so the adapter can rebind on session switches while a turn
	/// owns the kernel.
	#[must_use]
	pub fn editor_documents(&self) -> omp_envd::EditorDocuments {
		self.environment().editor_documents()
	}

	/// Borrows the project environment retained by this composition (MCP
	/// inspection, extension reload).
	#[must_use]
	pub const fn environment(&self) -> &omp_envd::ProjectEnvironment {
		match self {
			Self::Production(inference) => &inference._environment,
			Self::Gateway { _environment, .. } => _environment,
		}
	}

	/// Returns an auxiliary speech rewriter sharing this session's production
	/// registry or already-connected remote gateway. Direct production returns
	/// `None` only when no tiny role resolves.
	#[must_use]
	pub fn speech_rewriter(&self) -> Option<SpeechRewriteClient> {
		match self {
			Self::Production(inference) => {
				let settings = omp_catalog::settings::ModelSettings::from_con(&inference.con);
				let selected = crate::discovery::roles::resolve_role_selector(
					inference.stack.catalog().as_ref(),
					&settings,
					"@tiny",
				)
				.ok()?;
				Some(SpeechRewriteClient::Production {
					registry: inference.stack.registry.clone(),
					model:    selected.model,
				})
			},
			Self::Gateway { inference, .. } => {
				Some(SpeechRewriteClient::Gateway { inference: inference.clone() })
			},
		}
	}

	/// Returns the cloneable side route over this composition's production
	/// registry, credentials, and account pins, or its connected gateway.
	#[must_use]
	pub fn auxiliary_inference(&self) -> AuxiliaryInference {
		let route = match self {
			Self::Production(inference) => AuxiliaryRoute::Production(Arc::new(AuxiliaryProduction {
				registry: inference.stack.registry.clone(),
				auth:     inference.stack.auth_manager.clone(),
				con:      Arc::clone(&inference.con),
				target:   inference.meta.target.clone(),
				launch:   inference.launch.model.clone(),
			})),
			Self::Gateway { inference, .. } => AuxiliaryRoute::Gateway(inference.clone()),
		};
		AuxiliaryInference { route }
	}

	/// Resolves the production target for a side-channel request without
	/// losing an explicit provider constraint from the ordinary turn.
	pub(crate) fn side_channel_target(&self) -> Option<Target> {
		let Self::Production(inference) = self else {
			return None;
		};
		let model = omp_catalog::ModelKey::from(inference.selected_model().as_str());
		Some(match &inference.meta.target {
			Target::Provider { provider, .. } => {
				Target::Provider { provider: provider.clone(), model }
			},
			_ => Target::Model(model),
		})
	}

	/// Borrows the production authentication and usage stack; `None` behind
	/// a remote gateway, whose credentials live on the gateway host.
	#[must_use]
	pub const fn production_stack(&self) -> Option<&ProductionStack> {
		match self {
			Self::Production(inference) => Some(&inference.stack),
			Self::Gateway { .. } => None,
		}
	}

	/// The composition's live catalog publication: every read sees the latest
	/// discovery refresh. `None` behind a remote gateway.
	#[must_use]
	pub fn live_catalog(&self) -> Option<crate::registry::LiveCatalog> {
		match self {
			Self::Production(inference) => {
				Some(crate::registry::LiveCatalog::Published(inference.stack.registry.clone()))
			},
			Self::Gateway { .. } => None,
		}
	}

	/// How composition settled the launch model.
	#[must_use]
	pub const fn launch_model(&self) -> &LaunchModel {
		match self {
			Self::Production(inference) => &inference.launch,
			Self::Gateway { launch, .. } => launch,
		}
	}
}

impl omp_agent::Inference for ComposedInference {
	fn chat(
		&mut self,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		async move {
			match self {
				Self::Production(inference) => inference.chat(request).await,
				Self::Gateway { inference, .. } => inference.chat(request).await,
			}
		}
	}

	fn chat_on(
		&mut self,
		selector: &str,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		async move {
			match self {
				Self::Production(inference) => inference.chat_on(selector, request).await,
				Self::Gateway { inference, .. } => inference.chat_on(selector, request).await,
			}
		}
	}

	fn set_debug_session(&mut self, session: Option<Str>) {
		if let Self::Production(inference) = self {
			inference.meta.debug_session = session;
			inference
				.routes
				.client_mut()
				.set_call_meta(inference.meta.clone());
		}
	}

	fn begin_turn(&mut self) {
		if let Self::Production(inference) = self {
			omp_agent::Inference::begin_turn(inference);
		}
	}

	fn select_session(&self, dom: &omp_dom::Dom) {
		let binding = match self {
			Self::Production(inference) => &inference._agent_control,
			Self::Gateway { _agent_control, .. } => _agent_control,
		};
		if let Some(binding) = binding.lock().as_ref() {
			binding.refresh_session(dom);
		}
	}

	fn install_retry_sink(&mut self, sink: omp_ai::RetrySink) {
		match self {
			Self::Production(inference) => inference.install_retry_sink(sink),
			Self::Gateway { inference, .. } => inference.install_retry_sink(sink),
		}
	}

	fn route_facts(&self) -> Option<RouteFacts> {
		match self {
			Self::Production(inference) => inference.route_facts(),
			Self::Gateway { .. } => None,
		}
	}

	fn selected_model(&self) -> Option<Str> {
		match self {
			Self::Production(inference) => Some(inference.selected_model()),
			Self::Gateway { .. } => None,
		}
	}

	fn model_selector(&self) -> Option<Arc<dyn omp_agent::ModelSelector>> {
		let catalog = self.live_catalog()?;
		Some(Arc::new(LiveModelSelector { catalog, launch: self.launch_model().model.clone() }))
	}
}

/// Concrete prompt projection returned by [`compose_kernel`].
pub type PromptSource = CanonicalPromptSource;

fn install_yield_contract(
	registry: Arc<Registry>,
	output_schema: Option<&serde_json::Value>,
	schema_mode: Option<SchemaMode>,
) -> Result<Arc<Registry>, HeadlessError> {
	let Some(output_schema) = output_schema else {
		return Ok(registry);
	};
	let retained = registry
		.live_identities()
		.filter(|(name, _)| name.as_str() != "yield")
		.map(|(name, _)| name.clone())
		.collect::<Vec<_>>();
	let mut registry = registry.restrict(retained.iter().map(Str::as_str));
	registry.register(
		omp_tools::yield_tool::tool_for_schema(output_schema, schema_mode.unwrap_or_default())?,
		Presentation::Hidden,
		Claims {
			precedence: Precedence::CORE,
			claimant:   Str::new_static("omp/core"),
			replaces:   None,
		},
	)?;
	Ok(Arc::new(registry))
}

#[derive(Clone, Copy)]
struct GoalDeclaration;

impl omp_tools::goal::GoalControl for GoalDeclaration {
	fn apply(
		&self,
		_params: omp_tools::goal::Params,
	) -> impl Future<Output = Result<Option<omp_tools::goal::Goal>, omp_tools::goal::Fault>> + Send + '_
	{
		async { Err(omp_tools::goal::Fault::Unavailable) }
	}
}

/// Installs the stable Goal declaration. Live execution is intercepted by the
/// session-owned reducer so no goal state exists outside the session DOM.
fn install_goal_contract(registry: Arc<Registry>) -> Result<Arc<Registry>, HeadlessError> {
	let retained = registry
		.live_names()
		.into_iter()
		.filter(|name| name.as_str() != "goal")
		.collect::<Vec<_>>();
	let mut registry = registry.restrict(retained.iter().map(Str::as_str));
	registry.register(omp_tools::goal::tool(GoalDeclaration), Presentation::Hidden, Claims {
		precedence: Precedence::CORE,
		claimant:   Str::new_static("omp/core"),
		replaces:   None,
	})?;
	Ok(Arc::new(registry))
}

/// Replaces generic `yield` with one strict batch-local workpool contract.
pub(crate) fn install_workpool_yield_contract(
	registry: &Registry,
	items: Vec<omp_tools::yield_tool::WorkpoolItem>,
) -> Result<Arc<Registry>, HeadlessError> {
	let retained = registry
		.live_names()
		.into_iter()
		.filter(|name| name.as_str() != "yield")
		.collect::<Vec<_>>();
	let mut registry = registry.restrict(retained.iter().map(Str::as_str));
	registry.register(
		omp_tools::yield_tool::tool_for_workpool(items)?,
		Presentation::Slot,
		Claims {
			precedence: Precedence::CORE,
			claimant:   Str::new_static("omp/core"),
			replaces:   None,
		},
	)?;
	Ok(Arc::new(registry))
}

/// Composes the production environment, inference route, tools, prompt, and
/// authoritative `.oms` session for a headless command.
pub async fn compose_kernel(
	data_dir: &Path,
	project_root: &Path,
	model_selector: &str,
	ctx: Arc<omp_con::Ctx>,
	options: KernelOptions,
) -> Result<(Kernel<ComposedInference>, Session, PromptSource), HeadlessError> {
	let project_root = fs::canonicalize(project_root)?;
	let state_dir = omp_env::project_state::directory(data_dir, &project_root)?;
	let sessions_dir = options
		.sessions_dir
		.clone()
		.unwrap_or_else(|| state_dir.join("sessions"));
	fs::create_dir_all(&sessions_dir)?;
	let tools_enabled = !options.no_tools;
	let live_sessions = options
		.sessions
		.clone()
		.unwrap_or_else(|| Arc::new(crate::sessions::SessionRegistry::new()));
	// The workspace's trust decision gates every project-sourced input this
	// composition loads; a child composition inherits its parent's.
	let workspace_trust = options.workspace_trust.decide(data_dir, &project_root);
	let disabled_extensions = crate::discovery::CL_DISABLED_EXTENSIONS.get(&ctx);
	let native_mode = match options.extensions.native_mode {
		NativeExtensionMode::Merge => crate::discovery::native::NativeLoadMode::Merge,
		NativeExtensionMode::ExplicitOnly => crate::discovery::native::NativeLoadMode::ExplicitOnly,
		NativeExtensionMode::Disabled => crate::discovery::native::NativeLoadMode::Disabled,
	};
	let home = if native_mode == crate::discovery::native::NativeLoadMode::Merge {
		omp_core::dirs::home_dir().ok_or(omp_core::dirs::DataDirError::HomeUnset)?
	} else {
		project_root.clone()
	};
	let protected_home = omp_core::dirs::home_dir().unwrap_or_else(|| home.clone());
	let configured_writable_roots = omp_envd::exec_settings::SV_SANDBOX_WRITABLE_ROOTS
		.get(&ctx)
		.into_iter()
		.map(|path| PathBuf::from(path.as_str()))
		.collect::<Vec<_>>();
	let control_options = crate::discovery::native::NativeControlGrantOptions {
		data_dir,
		sandbox_mode: omp_envd::exec_settings::SV_SANDBOX_MODE.get(&ctx),
		writable_roots: &configured_writable_roots,
		sandbox_available: omp_envd::admission::probe_sandbox(&ctx, &project_root).confines(),
	};
	let protected_write_paths =
		crate::discovery::native::protected_write_paths(data_dir, &protected_home);
	let native_extensions = crate::discovery::native::admit_native_extensions_contained_with_control(
		&project_root,
		&home,
		crate::discovery::native::NativeAdmissionOptions {
			explicit_roots:    &options.extensions.native_roots,
			mode:              native_mode,
			// The workspace's own extensions load only while it is trusted;
			// the operator's user-level ones are never gated.
			include_workspace: options.extensions.include_workspace
				&& workspace_trust.trust() == WorkspaceTrust::Trusted,
			setting_overrides: &options.extensions.setting_overrides,
			disabled:          &disabled_extensions,
		},
		&control_options,
	);
	for error in &native_extensions.errors {
		tracing::warn!(error = %error, "Python extension was not admitted");
	}
	let mut extension_skill_sources = options
		.extensions
		.native_roots
		.iter()
		.filter_map(|root| {
			crate::discovery::skills::agent_plugin_skill_source(
				root,
				crate::discovery::skills::SkillLevel::Project,
			)
		})
		.collect::<Vec<_>>();
	for extension in &native_extensions.extensions {
		let level = if extension.spec.key.layer() == "user" {
			crate::discovery::skills::SkillLevel::User
		} else {
			crate::discovery::skills::SkillLevel::Project
		};
		for root in extension.skill_roots() {
			extension_skill_sources.push(crate::discovery::skills::SkillSource {
				provider: sf!("extension:{}", extension.spec.key.extension()),
				root,
				level,
			});
		}
	}
	let claude_plugins = if let Some(plugins) = &options.claude_plugins {
		Arc::clone(plugins)
	} else {
		let plugins = omp_ext::claude_plugin::ClaudePlugins::resolve(
			data_dir,
			&project_root,
			omp_ext::claude_plugin::ClaudeCodeHome::detect().as_ref(),
			workspace_trust.trust(),
		);
		// The launching host surfaces these once; a host-less composition
		// (child, maintenance, or tool kernel) only records them.
		for diagnostic in &plugins.diagnostics {
			tracing::debug!(error = %diagnostic, "installed plugin diagnostic");
		}
		Arc::new(plugins)
	};
	let skills = match &options.discovered_skills {
		Some(skills) => {
			let mut merged = (**skills).clone();
			merged.merge_extension_sources(
				&extension_skill_sources,
				&crate::discovery::skills::SkillPolicy::from_con(&ctx),
			);
			Arc::new(merged)
		},
		None => Arc::new(crate::discovery::skills::ActiveSkills::discover_with_sources(
			&ctx,
			&project_root,
			&claude_plugins,
			&extension_skill_sources,
		)?),
	};
	let (context_files, rules) =
		discover_prompt_material(&project_root, &options.prompt, &claude_plugins)?;
	// Serves the composition's class until the journal is open; a session
	// resumed without an explicit class then settles it from its journal.
	let rule_scope = Arc::new(crate::discovery::rules::RuleScope::new(
		rules,
		options
			.agent
			.clone()
			.unwrap_or_else(|| crate::subagent::MAIN_AGENT.to_owned()),
	));
	let inference_bridge =
		tools_enabled.then(|| Arc::new(crate::bridges::InferenceBridge::default()));
	let roster = omp_tools::roster::SelectedRoster::production();
	let bridges = if tools_enabled {
		omp_envd::RegistryBridges {
			command_credentials: Some(Arc::new(crate::bridges::CommandCredentials)),
			search: inference_bridge
				.clone()
				.map(|bridge| bridge as Arc<dyn omp_envd::SearchInference>),
			telemetry_upload: Some(Arc::new(crate::bridges::TelemetryDelivery)),
			url_resolvers: vec![skills.resolver(), rule_scope.resolver()],
			content: omp_envd::ActiveContentInputs {
				authored_skills:     skills.names(),
				managed_skills_root: Some(crate::discovery::skills::managed_skills_root(
					&omp_core::dirs::user_config_root()?,
				)),
				agent_plugin_roots:  crate::plugin_commands::agent_plugin_roots(
					&options.extensions.native_roots,
					&claude_plugins,
				),
				command_approvals:   claude_plugins.command_approvals.clone(),
				claude_plugins:      claude_plugins
					.plugins
					.iter()
					.filter(|plugin| plugin.claude_components().is_some())
					.cloned()
					.collect(),
				workspace_trust:     workspace_trust.trust(),
			},
			dynamic_tools: crate::roster::composer_dynamic_tools(&roster),
			selected_roster: Some(roster),
			..omp_envd::RegistryBridges::default()
		}
	} else {
		omp_envd::RegistryBridges {
			content: omp_envd::ActiveContentInputs {
				workspace_trust: workspace_trust.trust(),
				..omp_envd::ActiveContentInputs::default()
			},
			selected_roster: Some(roster),
			..omp_envd::RegistryBridges::default()
		}
	};

	// Control grants come only from the operator's grant records, which native
	// admission has already applied to the native specs; the specs the caller
	// supplied are cleared of any grant when the two lists are assembled below.
	let mut caller_extensions = options.extensions.trusted.clone();
	for extension in &mut caller_extensions {
		omp_ext::config::apply_resolved_setting_overrides(
			extension.key.extension().as_str(),
			&extension.manifest.setting_schemas,
			&mut extension.settings,
			&options.extensions.setting_overrides,
		)?;
	}
	let native_specs: Vec<_> = native_extensions
		.extensions
		.into_iter()
		.map(|extension| extension.spec)
		.collect();
	let terminal = terminal_identity();
	let journal_path = select_journal_path(
		&sessions_dir,
		options.session.as_deref(),
		options.fork.as_deref(),
		options.continue_session,
		options.ephemeral,
		terminal.as_deref(),
	)?;
	let cfg_files = crate::cfg::CfgFiles::new(Some(&project_root));
	// A composition without an explicit class (the main chat, `--resume`)
	// presents the class journaled on its live session, so a resumed child
	// runs on its own class configuration; a spawned child arrives configured.
	let class_scope = match (&options.agent, &cfg_files) {
		(Some(_), _) => con_journal::ClassScope::Composed,
		(None, Ok(files)) => con_journal::ClassScope::Journaled(Arc::new(files.clone())),
		(None, Err(error)) => {
			tracing::warn!(%error, "class cfgs unavailable; a resumed child keeps this console");
			con_journal::ClassScope::Composed
		},
	};
	// The environment fixes its sandbox, approval and workspace trust policy
	// when it starts, so a resumed child's class is presented before it does.
	con_journal::present_journaled_class(&ctx, &class_scope, &journal_path);
	let sandbox_matches = crate::discovery::native::control_grant_sandbox_matches(
		&control_options,
		&ctx,
		&project_root,
	);
	if !sandbox_matches {
		tracing::warn!(
			"withholding extension CONTROL grants because the journaled class changed the exec \
			 sandbox"
		);
	}
	let trusted_extensions = crate::discovery::native::assemble_trusted_specs(
		caller_extensions,
		native_specs,
		sandbox_matches,
	);
	let environment_policy = omp_envd::daemon_policy::from_con_with_protected_write_paths(
		&ctx,
		workspace_trust.trust(),
		&protected_write_paths,
	);
	// Without the policy the configuration files resolve, a spawned daemon's
	// hello is checked instead.
	let spawn_policy = match &cfg_files {
		Ok(files) => files
			.daemon_policy(workspace_trust.trust())
			.inspect_err(|error| tracing::debug!(%error, "configured daemon policy unavailable"))
			.ok(),
		Err(error) => {
			tracing::debug!(%error, "configured daemon policy unavailable");
			None
		},
	};
	let environment = omp_envd::ProjectEnvironment::attach_with_protected_write_paths(
		&project_root,
		&state_dir,
		omp_envd::AttachOptions {
			py_eval: options.py_eval,
			approval_mode: options.approval_mode,
			trusted_extensions,
			contributed_values: options.extensions.contributed.clone(),
			con: Arc::clone(&ctx),
			bridges,
			spawn_idle_timeout: options.spawn_idle_timeout,
			spawn_policy,
		},
		&protected_write_paths,
	)
	.await?;
	let admission_gate = environment.admission_gate();
	let hub_environment = environment.client().clone();
	let mut component_registry = ComponentRegistry::standard();
	let mut director_registry = DirectorRegistry::standard();
	let mut extension_registrar = ExtensionRegistrar::new();
	let python_components = environment.register_python_extensions(&mut extension_registrar)?;
	let live_python_components = python_components.clone();
	let _installed = extension_registrar.install(&mut director_registry, &mut component_registry);

	let remote_build = if tools_enabled {
		crate::remote_build::enabled(&ctx)
	} else {
		None
	};
	let complete_registry = options
		.tool_registry
		.clone()
		.unwrap_or_else(|| environment.registry());
	let complete_registry = if tools_enabled {
		install_goal_contract(complete_registry)?
	} else {
		complete_registry
	};
	let complete_registry = match remote_build {
		Some(remote_build) => Arc::new(remote_build.declare(&complete_registry)?),
		None => complete_registry,
	};
	let registry = if options.no_tools {
		if options.tools.is_some() {
			return Err(
				std::io::Error::new(
					std::io::ErrorKind::InvalidInput,
					"--tools and --no-tools are mutually exclusive",
				)
				.into(),
			);
		}
		Arc::new(Registry::new())
	} else if let Some(names) = &options.tools {
		validate_tool_names(&complete_registry, names)?;
		Arc::new(complete_registry.restrict(names.iter().map(Str::as_str)))
	} else {
		complete_registry
	};
	let registry = if tools_enabled {
		install_goal_contract(registry)?
	} else {
		registry
	};
	let registry =
		install_yield_contract(registry, options.output_schema.as_ref(), options.schema_mode)?;

	// The production stack refreshes runtime model discovery while it
	// composes. The launch model and every later `ai_model` switch resolve
	// against the catalog that refresh left, so a model discovered during
	// this composition is selectable in this session.
	let backend = match options.gateway {
		Some(channel) => Err(channel),
		None => Ok(production_inference_for_session(
			data_dir,
			Arc::clone(&registry),
			Some(&project_root),
			InferenceSessionOverrides {
				provider: options
					.api_key
					.as_ref()
					.and_then(|_| options.provider.clone()),
				api_key: options.api_key,
				con: Some(Arc::clone(&ctx)),
				..InferenceSessionOverrides::default()
			},
		)
		.await?),
	};
	let catalog = match &backend {
		Ok(stack) => stack.catalog(),
		Err(_) => Arc::new(omp_catalog::snapshot::Catalog::embedded().clone()),
	};
	let launch = settle_launch_model(
		catalog.as_ref(),
		&ctx,
		&project_root,
		model_selector,
		options.launch_model,
	)
	.map_err(|error| HeadlessError::UnknownModel { selector: error.selector })?;
	let model = launch.model.clone();
	let model_key = omp_catalog::ModelKey::from(model.as_str());
	let model_spec = catalog
		.model(&model_key)
		.ok_or_else(|| HeadlessError::UnknownModel { selector: model.clone() })?;
	let route_facts = route_facts(catalog.as_ref(), model_spec, None);
	let tool_client = if options.no_pty {
		environment
			.client()
			.with_invocation_grant(omp_env::InvocationGrant::unrestricted().deny_pty())
	} else {
		environment.client().clone()
	};

	let mut inference = match backend {
		Err(channel) => {
			if let Some(bridge) = &inference_bridge {
				bridge.bind_remote(channel.clone())?;
			}
			ComposedInference::Gateway {
				inference: GatewayInference::new(channel, model.as_str()),
				launch,
				_environment: environment,
				_agent_control: Mutex::new(None),
				_python_components: python_components,
				_eval_parent: None,
				_ephemeral_journal: None,
				rules: Arc::clone(&rule_scope),
				workspace_trust: workspace_trust.clone(),
			}
		},
		Ok(stack) => {
			if let Some(bridge) = &inference_bridge {
				bridge.bind(stack.rpc.clone())?;
			}
			let target = match options.provider {
				Some(provider) => Target::Provider { provider, model: model_key },
				None => Target::Model(model_key),
			};
			let meta = CallMeta {
				id: RequestId::from(format!("omp-print-{}", Ulid::generate())),
				target,
				deadline: None,
				budget: ExecutionBudget::default(),
				session: None,
				debug_session: None,
				response_hooks: Default::default(),
			};
			let routes =
				PinnedRoutes::new(stack.registry.clone(), meta.clone(), omp_ai::CallAffinity {
					prompt_cache:     options.prompt_cache_key.clone(),
					provider_session: options.provider_session.clone(),
					account_pins:     omp_ai::account::SessionAccountPins::NONE,
				});
			ComposedInference::Production(ProductionInference {
				routes,
				meta,
				model: omp_catalog::ModelKey::from(model.as_str()),
				launch,
				_environment: environment,
				_agent_control: Mutex::new(None),
				stack,
				con: Arc::clone(&ctx),
				_python_components: python_components,
				_eval_parent: None,
				_ephemeral_journal: None,
				rules: Arc::clone(&rule_scope),
				workspace_trust: workspace_trust.clone(),
			})
		},
	};
	// A `reflect` this process hosts synthesizes through the session's own
	// inference capability, one auxiliary request per call; an attached
	// session's runs on the project daemon, which this binding cannot reach.
	if tools_enabled {
		bind_reflection(inference.environment(), inference.auxiliary_inference())?;
	}

	let debug_session = journal_path
		.file_stem()
		.and_then(|name| name.to_str())
		.map(Str::new);
	if let ComposedInference::Production(production) = &mut inference {
		production.meta.debug_session = debug_session;
		production
			.routes
			.client_mut()
			.set_call_meta(production.meta.clone());
	}
	let ephemeral_journal = options.ephemeral.then(|| EphemeralJournal {
		root: journal_path
			.parent()
			.expect("ephemeral journals always have a private parent")
			.to_path_buf(),
	});
	let mut session = if journal_path.exists() {
		let mut session = Session::open(&journal_path, component_registry)?;
		session.recover_process_disappearance()?;
		session
	} else {
		if let Some(parent) = journal_path.parent() {
			fs::create_dir_all(parent)?;
		}
		Session::create(&journal_path, component_registry)?
	};
	let con_journal = Arc::new(con_journal::ConJournal::attach(
		Arc::clone(&ctx),
		session.dom(),
		class_scope,
		workspace_trust.trust(),
	));
	// The session never presents a policy its environment does not enforce:
	// a class the early presentation could not read refuses the composition.
	let presented_policy = omp_envd::daemon_policy::from_con_with_protected_write_paths(
		&ctx,
		workspace_trust.trust(),
		&protected_write_paths,
	);
	if presented_policy != environment_policy {
		return Err(HeadlessError::EnvironmentPolicyDrift {
			composed:  environment_policy,
			presented: presented_policy,
		});
	}
	apply_model_override(&ctx, model.as_str(), options.model_override)?;
	// A child journals the class and recursion depth it runs at, so resuming
	// its session later (from the main chat or `--resume`) scopes rules to
	// that class and presents its configuration and roster at that depth.
	if let Some(agent) = &options.agent {
		crate::subagent::journal_agent(
			&mut session,
			agent,
			crate::subagent::settings::SV_TASK_RECURSION_DEPTH.get(&ctx),
		)?;
	}
	// The session records the trust decision it runs under once; a resumed
	// session already holding it records nothing again.
	journal_decision(&mut session, &workspace_trust)?;
	let agent = kernel_agent(options.agent.as_deref(), session.dom());
	rule_scope.select(agent.clone());
	let compiled = omp_agent::directors::stream_rules::StreamRuleSet::compile(
		rule_scope.rules().stream_patterns(&agent),
	);
	for warning in &compiled.warnings {
		tracing::warn!(error = %warning, "stream rule left out");
	}
	if let Some(set) = compiled.set {
		director_registry.register_extension(Box::new(
			omp_agent::directors::stream_rules::StreamRules::new(Arc::new(set)),
		));
		let mut directors = omp_agent::DirectorStack::from_dom(session.dom(), &director_registry);
		if !directors.active_ids().contains(&"stream-rules") {
			directors.engage_registered(&mut session, "stream-rules")?;
		}
	}
	let facts = prompt_facts(&project_root, &agent, &skills, &context_files, rule_scope.rules());
	install_prompt_facts(
		&mut session,
		&project_root,
		model.as_str(),
		&options.prompt,
		&facts,
		tools_enabled,
	)?;
	if !options.ephemeral {
		remember_terminal_session(&sessions_dir, terminal.as_deref(), &journal_path)?;
	}
	if let Some(ephemeral_journal) = ephemeral_journal {
		inference.retain_ephemeral_journal(ephemeral_journal);
	}

	let prompt = CanonicalPromptSource;
	// Tool output, provider media, user attachments, and compaction summaries
	// share the project/session CAS. Every durable byte is therefore rooted by
	// the journals that reference it and cannot leak across project namespaces.
	let spill = session.blobs().clone();
	// The environment applies `sv_interrupt_grace` between TERM and KILL; the
	// dispatcher grants that courtesy plus one second for the unit's verdict
	// to travel back before it forces the call closed as effects-unknown.
	let unit_grace = omp_envd::host_settings::SV_INTERRUPT_GRACE
		.get(&ctx)
		.to_std()?;
	let output_spill_bytes =
		usize::try_from(omp_envd::tool_settings::SV_TOOLS_OUTPUT_SPILL_BYTES.get(&ctx))
			.unwrap_or(usize::MAX);
	let artifact_head_bytes =
		usize::try_from(omp_tools::settings::SV_TOOLS_ARTIFACT_HEAD_BYTES.get(&ctx))
			.unwrap_or(usize::MAX);
	let artifact_tail_bytes =
		usize::try_from(omp_tools::settings::SV_TOOLS_ARTIFACT_TAIL_BYTES.get(&ctx))
			.unwrap_or(usize::MAX);
	let artifact_tail_lines =
		usize::try_from(omp_tools::settings::SV_TOOLS_ARTIFACT_TAIL_LINES.get(&ctx))
			.unwrap_or(usize::MAX);
	let output_max_columns = omp_tools::settings::SV_TOOLS_OUTPUT_MAX_COLUMNS.get(&ctx);
	let max_line_bytes = if output_max_columns == 0 {
		usize::MAX
	} else {
		usize::try_from(output_max_columns).unwrap_or(usize::MAX)
	};
	let policy = DispatchPolicy::new(spill)
		.with_limits(output_spill_bytes, max_line_bytes, Duration::from_secs(30))
		.with_artifact_projection(artifact_head_bytes, artifact_tail_bytes, artifact_tail_lines)
		.with_interrupt_grace(unit_grace.saturating_add(Duration::from_secs(1)));
	let runtime_flags = RuntimeFlags {
		automatic_compaction:     ctx
			.get("ai_compaction_enabled")
			.and_then(|value| match value {
				omp_con::Value::Bool(value) => Some(value),
				_ => None,
			})
			.unwrap_or(true),
		goal_enabled:             ctx
			.get("cl_goal_enabled")
			.and_then(|value| match value {
				omp_con::Value::Bool(value) => Some(value),
				_ => None,
			})
			.unwrap_or(true),
		autolearn_enabled:        ctx
			.get("ai_autolearn_enabled")
			.and_then(|value| match value {
				omp_con::Value::Bool(value) => Some(value),
				_ => None,
			})
			.unwrap_or(false),
		autolearn_min_tool_calls: ctx
			.get("ai_autolearn_min_tool_calls")
			.and_then(|value| match value {
				omp_con::Value::Int(value) => usize::try_from(value).ok(),
				_ => None,
			})
			.unwrap_or(5),
		recover_inline_edits:     ctx
			.get("sv_edit_recover_inline_edits")
			.and_then(|value| match value {
				omp_con::Value::Bool(value) => Some(value),
				_ => None,
			})
			.unwrap_or(true),
	};
	let kernel = Kernel::new(inference, registry, policy, prompt)
		.with_director_registry(director_registry)
		.with_file_mention_source(super::file_mentions::EnvFileMentionSource::new(
			hub_environment.clone(),
		))
		.with_route_facts(route_facts)
		.with_runtime_flags(runtime_flags)
		.with_con_context(Arc::clone(&ctx))
		.with_hook_gate(Arc::clone(&admission_gate))
		.with_session_state_bridge(con_journal.clone())
		.with_session_state_bridge(Arc::clone(&rule_scope) as Arc<dyn omp_agent::SessionStateBridge>);
	// The session's one approval authority, which the tool executor's admission
	// queries use too. The daemon relays nothing but sandbox amendments yet:
	// its dynamic-device admissions and privileged mutations still fail
	// closed.
	let approvals = bind_environment_approvals(&kernel, kernel.inference().environment());
	// The native tools this kernel runs (every environment tool of an
	// embedded fallback, an attached session's session tools) are admitted
	// here, outside the environment's gate, so their fetches are keyed on the
	// hosts that environment's resolvers name.
	let fetch_hosts = kernel.inference().environment().fetch_hosts();
	let admission = SettingsAdmission::new(&ctx, options.approval_mode, &project_root)
		.with_workspace_trust(kernel.inference().workspace_trust().trust())
		.with_fetch_hosts(fetch_hosts);
	// The kernel's admission and the calls the environment admits (every
	// environment tool of a session attached to the project daemon, worker
	// tools everywhere) report the session's approval posture, once, at
	// whichever admission comes first; a resumed session already told of it
	// is not told again.
	let mut kernel = install_tool_authority(
		kernel,
		&session,
		EnvToolExecutor::new(tool_client, approvals.clone()),
		admission,
	);
	kernel
		.inference()
		.environment()
		.bind_mcp_literal_notices(Arc::new(omp_agent::UpMailbox(kernel.mailbox())));
	kernel.register_live_component(con_journal.live_component());
	for component in live_python_components {
		kernel.register_live_component(Box::new(component));
	}
	kernel = kernel
		.with_session_authority(Arc::clone(&live_sessions) as Arc<dyn omp_agent::SessionAuthority>);
	kernel.reconcile_jobs(&mut session)?;
	// A top-level session that is not trusted is told once what the
	// workspace withholds; a child inherits its parent's decision and
	// report, and a session already holding this report is not told again.
	if options.parent_session.is_none()
		&& let Some(withheld) = WithheldInputs::of(&workspace_trust, data_dir, &project_root)
		&& !withheld.told(&session)
	{
		post_withheld_notice(&kernel.mailbox(), &withheld);
	}
	let id = journal_path
		.file_stem()
		.and_then(|name| name.to_str())
		.map_or_else(|| Str::new(Ulid::generate().to_string()), Str::new);
	let name = options.session_name.clone().unwrap_or_else(|| id.clone());
	let topology = match options.parent_session.as_deref() {
		Some(parent) => {
			let parent = omp_agent::SessionAuthority::lookup(live_sessions.as_ref(), parent)
				.ok_or_else(|| HeadlessError::ParentSessionUnavailable { parent: Str::new(parent) })?;
			omp_agent::SessionTopology::child(parent.id, parent.topology.main_id)
		},
		None => omp_agent::SessionTopology::main(id.clone()),
	};
	let relay_ctx = Arc::clone(&ctx);
	let relay = crate::sessions::IrcRelayPolicy::new(move || {
		crate::subagent::settings::CL_IRC_RELAY_TO_MAIN.get(&relay_ctx)
	});
	let up = kernel.mailbox();
	// Installed plugins' Claude-format hooks answer on the generic hook
	// surface, beside extension hosts.
	if tools_enabled
		&& let Some(host) = crate::plugin_hooks::PluginHookHost::new(
			hub_environment.clone(),
			crate::plugin_hooks::PluginHookSession {
				session_id:   id.clone(),
				transcript:   journal_path,
				project_root: project_root.clone(),
				data_dir:     data_dir.to_path_buf(),
				subagent:     options.parent_session.is_some(),
				agent:        options.agent.clone(),
				idle_prompt:  crate::plugin_hooks::SV_PLUGIN_HOOK_IDLE_PROMPT
					.get(&ctx)
					.to_std(),
			},
			&claude_plugins,
		) {
		host.bind_mailbox(up.clone());
		host.attach(&admission_gate);
	}
	let session_mutator = crate::subagent::workpool_scheduler::SessionMutator::new(up.clone());
	kernel
		.inference()
		.refresh_agent_control(Arc::new(omp_agent::UpMailbox(up.clone())), session.dom());
	let autoreply = crate::subagent::autoreply::producer(
		kernel.inference(),
		&live_sessions,
		up.clone(),
		kernel.turn_activity(),
		kernel.session_cancellation(),
		kernel.reply_obligations(),
		session.blobs().clone(),
	);
	live_sessions.register(name.clone(), crate::sessions::KernelHandle {
		id: crate::sessions::SessionId::new(id.clone()),
		name: name.clone(),
		up,
		snapshot: Arc::new(RwLock::new(session.dom().snapshot())),
		topology,
		relay,
		autoreply,
		idle_subscribe: None,
		ask: None,
		turn_activity: kernel.turn_activity(),
		project_root: Arc::from(project_root.as_path()),
	});
	if tools_enabled {
		let cfg: Arc<dyn omp_con::CfgLoader> =
			Arc::new(crate::cfg::CfgFiles::new(Some(&project_root))?);
		let jobs = Arc::clone(kernel.jobs());
		let eval = kernel.inference().environment().eval_control();
		let authority: Arc<dyn omp_agent::SessionAuthority> = live_sessions.clone();
		let producers = Arc::new(crate::subagent::workpool::WorkpoolRegistry::new(authority));
		let launcher = Arc::new(crate::subagent::workpool_scheduler::KernelWorkpoolLauncher::new(
			data_dir.to_path_buf(),
			sessions_dir.clone(),
			Arc::clone(&live_sessions),
			session_mutator.clone(),
			Arc::clone(&jobs),
			hub_environment.clone(),
			Arc::clone(&ctx),
			Arc::clone(&cfg),
			model.clone(),
			Arc::clone(kernel.tool_registry()),
			eval.clone(),
			workspace_trust.clone(),
		));
		let scheduler = Arc::new(crate::subagent::workpool_scheduler::SchedulerRegistry::new(
			id.clone(),
			session_mutator,
			jobs,
			session.blobs().clone(),
			producers,
			launcher,
			Arc::new(crate::subagent::workpool_scheduler::ConWorkpoolPolicy::new(Arc::clone(&ctx))),
			eval,
		));
		let parent = Arc::new(crate::subagent::workpool_scheduler::WorkpoolParentHost::new(
			crate::subagent::workpool_scheduler::WorkpoolSessionHost::new(project_root.clone()),
			scheduler,
		));
		let lease = kernel
			.inference()
			.environment()
			.bind_eval_sdk_parent(id, parent)?;
		kernel.inference_mut().retain_eval_parent(lease);

		kernel = kernel.with_session_tool(Arc::new(super::goal::GoalSessionTool::new()));
		if let Some(remote_build) = remote_build {
			kernel = kernel.with_session_tool(Arc::new(crate::remote_build::RemoteBuildTool::new(
				remote_build,
				Arc::clone(&ctx),
				approvals,
				crate::remote_build::EnvironmentHost::new(
					hub_environment.clone(),
					project_root.clone(),
				),
				name.clone(),
			)));
		}
		// `todo` is a session reducer: every invocation starts from the
		// journal-derived `<meta><todo>` projection, including after resume,
		// rewind, or an observer-authored todo patch.
		kernel = kernel.with_session_tool(Arc::new(super::todo::TodoSessionTool::new()));
		// ADR 0013: `subagent.cfg` and `<agent>.cfg` resolve through the same
		// user (`~/.o2`) and project cfg roots every other `exec` uses.
		// The tool follows the live console: a session at the recursion
		// ceiling — a spawned child, or a child the main chat resumed — is
		// never advertised `task`, so it cannot plan a delegation the spawner
		// would refuse, and a switch back to the main session advertises it
		// again.
		kernel = kernel.with_session_tool(Arc::new(crate::subagent::spawn::TaskSessionTool::new(
			data_dir.to_path_buf(),
			project_root.clone(),
			sessions_dir.clone(),
			Arc::clone(&live_sessions),
			Arc::clone(&ctx),
			Arc::clone(&cfg),
			hub_environment.clone(),
			name.clone(),
			model,
			workspace_trust.clone(),
		)));
		kernel = kernel.with_session_tool(Arc::new(crate::subagent::hub::HubSessionTool::new(
			hub_environment,
			project_root.clone(),
			name,
			Arc::clone(&ctx),
		)));
	}
	Ok((kernel, session, prompt))
}

/// Facts fixed at composition that in-chat session switches (`/new`,
/// `/resume`, `/fork`, `/drop`) reuse: where journals live, which project
/// and model the prompt facts name, and the live-session routing index the
/// switched-in session registers with.
#[derive(Clone)]
pub struct SessionHome {
	/// Directory holding this project's `.oms` journals.
	pub sessions_dir:    PathBuf,
	/// Canonical project root recorded in prompt facts.
	pub project_root:    PathBuf,
	/// Resolved model key recorded in prompt facts.
	pub model:           Str,
	/// Invocation prompt projection overrides.
	pub prompt:          PromptOverrides,
	/// Discovered prompt material (skills, context files, rules) projected
	/// into every session's prompt facts.
	pub facts:           crate::discovery::PromptFacts,
	/// Process-local live-session routing authority.
	pub live:            Arc<crate::sessions::SessionRegistry>,
	/// Whether the session's production composition exposes the tool surface.
	pub tools_enabled:   bool,
	/// The kernel's turn activity, shared like [`Self::up`] by every session it
	/// drives and copied onto each handle [`Self::register`] publishes.
	pub turn_activity:   Arc<std::sync::atomic::AtomicBool>,
	/// The kernel's upward mailbox, shared by every session it drives.
	pub up:              flume::Sender<omp_agent::Up>,
	/// The kernel's discovered rules. When present, each session's rule facts
	/// are scoped to the agent class journaled on it (a resumed child keeps
	/// its own rules) instead of copying [`Self::facts`]' rule rows.
	pub rules:           Option<Arc<crate::discovery::rules::RuleScope>>,
	/// Serves DOM subscriptions to observers while the session is idle.
	///
	/// Set by the owner that runs an idle loop over the session; a headless
	/// composition that has none leaves it `None`.
	pub idle_subscribe:  Option<flume::Sender<flume::Sender<omp_agent::steering::DomSubscription>>>,
	/// Pairs every session's waiting UI requests with remote answers.
	///
	/// Set by the owner that presents the session's UI; a composition that
	/// presents none leaves it `None`.
	pub ask:             Option<crate::headless::AskRoute>,
	/// The workspace trust decision the kernel was composed under; every
	/// session this home creates or opens journals it once. `None` journals
	/// nothing (a home over another workspace, whose trust nobody decided).
	pub workspace_trust: Option<omp_ext::workspace_trust::TrustDecision>,
}

impl SessionHome {
	/// Resolves the session directory exactly as [`compose_kernel`] does.
	pub fn new(
		data_dir: &Path,
		project_root: &Path,
		options: &KernelOptions,
		model: Str,
		up: flume::Sender<omp_agent::Up>,
		turn_activity: Arc<std::sync::atomic::AtomicBool>,
	) -> Result<Self, HeadlessError> {
		let project_root = fs::canonicalize(project_root)?;
		let state_dir = omp_env::project_state::directory(data_dir, &project_root)?;
		let sessions_dir = options
			.sessions_dir
			.clone()
			.unwrap_or_else(|| state_dir.join("sessions"));
		fs::create_dir_all(&sessions_dir)?;
		let live = options
			.sessions
			.clone()
			.unwrap_or_else(|| Arc::new(crate::sessions::SessionRegistry::new()));
		Ok(Self {
			sessions_dir,
			project_root,
			model,
			prompt: options.prompt.clone(),
			facts: crate::discovery::PromptFacts::default(),
			live,
			tools_enabled: !options.no_tools,
			up,
			turn_activity,
			rules: None,
			workspace_trust: None,
			idle_subscribe: None,
			ask: None,
		})
	}

	/// Installs the channel an idle owner serves DOM subscriptions on.
	///
	/// The session is registered by `compose_kernel` before its owner exists,
	/// so the live handle is patched here as well as every later one: an
	/// observer looks the handle up, and a handle without the seam is only
	/// reachable while a turn runs.
	#[must_use]
	pub fn with_idle_subscribe(
		mut self,
		idle: flume::Sender<flume::Sender<omp_agent::steering::DomSubscription>>,
	) -> Self {
		for live in self.live.list() {
			if live.up.same_channel(&self.up) {
				let name = live.name.clone();
				self.live.register(name, crate::sessions::KernelHandle {
					idle_subscribe: Some(idle.clone()),
					..live
				});
			}
		}
		self.idle_subscribe = Some(idle);
		self
	}

	/// Installs the route the owner answers this kernel's UI requests on, so a
	/// remote `AnswerUi` reaches the same waiting request.
	///
	/// Like [`Self::with_idle_subscribe`], it patches the handle
	/// `compose_kernel` registered before the owner existed as well as every
	/// later one.
	#[must_use]
	pub fn with_ask(mut self, ask: crate::headless::AskRoute) -> Self {
		for live in self.live.list() {
			if live.up.same_channel(&self.up) {
				let name = live.name.clone();
				self
					.live
					.register(name, crate::sessions::KernelHandle { ask: Some(ask.clone()), ..live });
			}
		}
		self.ask = Some(ask);
		self
	}

	/// Records the discovered prompt material so sessions created in-chat
	/// carry the same prompt facts as the launch session.
	#[must_use]
	pub fn with_facts(mut self, facts: crate::discovery::PromptFacts) -> Self {
		self.facts = facts;
		self
	}

	/// Adopts the prompt material [`compose_kernel`] journaled into the launch
	/// session, so `/new`, `/fork`, and `/resume` sessions carry the same
	/// skills, context files, and rules without a second discovery pass.
	#[must_use]
	pub fn with_facts_of(self, session: &Session) -> Self {
		self.with_facts(journaled_prompt_facts(session))
	}

	/// Scopes the rule facts of every session this home creates or opens to
	/// the agent class journaled on it, over the kernel's discovered `rules`
	/// ([`ComposedInference::rule_scope`]).
	#[must_use]
	pub fn with_rules(mut self, rules: Arc<crate::discovery::rules::RuleScope>) -> Self {
		self.rules = Some(rules);
		self
	}

	/// Journals `decision`, the kernel's workspace trust decision
	/// ([`ComposedInference::workspace_trust`]), on every session this home
	/// creates or opens.
	#[must_use]
	pub fn with_workspace_trust(
		mut self,
		decision: omp_ext::workspace_trust::TrustDecision,
	) -> Self {
		self.workspace_trust = Some(decision);
		self
	}

	/// Journals [`Self::workspace_trust`] on `session` unless it records it.
	fn journal_trust(&self, session: &mut Session) -> Result<(), omp_session::SessionError> {
		if let Some(decision) = &self.workspace_trust {
			journal_decision(session, decision)?;
		}
		Ok(())
	}

	/// The prompt facts journaled on `session`: [`Self::facts`], with the rule
	/// rows re-scoped to the session's agent class when [`Self::rules`] is set.
	fn facts_for(&self, session: &Session) -> std::borrow::Cow<'_, crate::discovery::PromptFacts> {
		let Some(scope) = &self.rules else {
			return std::borrow::Cow::Borrowed(&self.facts);
		};
		let buckets = scope
			.rules()
			.prompt_facts(&crate::subagent::session_agent(session.dom()));
		std::borrow::Cow::Owned(crate::discovery::PromptFacts {
			always_apply_rules: buckets.always_apply,
			rules: buckets.rulebook,
			..self.facts.clone()
		})
	}

	/// Path of a fresh journal in the session directory.
	#[must_use]
	pub fn fresh_path(&self) -> PathBuf {
		self.sessions_dir.join(format!("{}.oms", Ulid::generate()))
	}

	/// Creates a new journal at `path` (or a fresh one), installs the prompt
	/// facts, and registers it as the live session.
	pub fn create(&self, path: Option<PathBuf>) -> Result<Session, HeadlessError> {
		let path = path.unwrap_or_else(|| self.fresh_path());
		if let Some(parent) = path.parent() {
			fs::create_dir_all(parent)?;
		}
		let mut session = Session::create(&path, ComponentRegistry::standard())?;
		let facts = self.facts_for(&session);
		install_prompt_facts(
			&mut session,
			&self.project_root,
			self.model.as_str(),
			&self.prompt,
			&facts,
			self.tools_enabled,
		)?;
		self.journal_trust(&mut session)?;
		self.register(&session);
		Ok(session)
	}

	/// Opens an existing journal and registers it as the live session.
	pub fn open(&self, path: &Path) -> Result<Session, HeadlessError> {
		let path = resolve_session_path(&self.sessions_dir, path);
		let mut session = Session::open(&path, ComponentRegistry::standard())?;
		session.recover_process_disappearance()?;
		let facts = self.facts_for(&session);
		install_prompt_facts(
			&mut session,
			&self.project_root,
			self.model.as_str(),
			&self.prompt,
			&facts,
			self.tools_enabled,
		)?;
		self.journal_trust(&mut session)?;
		self.register(&session);
		Ok(session)
	}

	/// Copies `source` and its session-local files to a fresh journal and opens
	/// the copy: the whole branch tree travels with the fork.
	pub fn fork(&self, source: &Path) -> Result<Session, HeadlessError> {
		let source = resolve_session_path(&self.sessions_dir, source);
		let path = self.fresh_path();
		copy_private_file(&source, &path)?;
		if let (Some(source_local), Some(destination_local)) =
			(session_local_tree(&source), session_local_tree(&path))
			&& source_local.is_dir()
			&& let Err(error) = copy_private_tree(&source_local, &destination_local)
		{
			let _ = fs::remove_file(&path);
			let _ = fs::remove_dir_all(&destination_local);
			return Err(error.into());
		}
		match self.open(&path) {
			Ok(session) => Ok(session),
			Err(error) => {
				let _ = fs::remove_file(&path);
				if let Some(local) = session_local_tree(&path) {
					let _ = fs::remove_dir_all(local);
				}
				Err(error)
			},
		}
	}

	/// Registers (or re-registers) `session` under its journal stem.
	pub fn register(&self, session: &Session) {
		let id = session
			.journal_path()
			.file_stem()
			.and_then(|name| name.to_str())
			.map_or_else(|| Str::new(Ulid::generate().to_string()), Str::new);
		let prior = self
			.live
			.list()
			.into_iter()
			.find(|live| live.up.same_channel(&self.up));
		let autoreply = prior.as_ref().and_then(|live| live.autoreply.clone());
		if let Some(producer) = &autoreply {
			producer.rebind(session.blobs().clone());
		}
		let topology = prior.as_ref().map_or_else(
			|| omp_agent::SessionTopology::main(id.clone()),
			|live| live.topology.rebind(id.clone()),
		);
		let relay = prior.map_or_else(crate::sessions::IrcRelayPolicy::default, |live| live.relay);
		self
			.live
			.register(id.clone(), crate::sessions::KernelHandle {
				id: crate::sessions::SessionId::new(id.clone()),
				name: id,
				up: self.up.clone(),
				snapshot: Arc::new(RwLock::new(session.dom().snapshot())),
				topology,
				relay,
				autoreply,
				idle_subscribe: self.idle_subscribe.clone(),
				ask: self.ask.clone(),
				turn_activity: Arc::clone(&self.turn_activity),
				project_root: Arc::from(self.project_root.as_path()),
			});
	}

	/// Removes `session`'s journal from the live index (before its file is
	/// deleted or the process switches away).
	pub fn unregister(&self, session: &Session) {
		if let Some(id) = session
			.journal_path()
			.file_stem()
			.and_then(|name| name.to_str())
		{
			self.live.remove(crate::sessions::SessionId::from_ref(id));
		}
	}
}

/// Resolves a session selector the way `--resume` does: a bare id is a
/// stem in the session directory, anything with a directory or extension
/// is a path.
fn resolve_session_path(sessions_dir: &Path, path: &Path) -> PathBuf {
	if path.components().count() > 1 || path.extension().is_some() {
		path.to_path_buf()
	} else {
		sessions_dir.join(path).with_extension("oms")
	}
}

fn apply_model_override(
	ctx: &omp_con::Ctx,
	model: &str,
	explicit: bool,
) -> Result<(), HeadlessError> {
	if explicit {
		omp_agent::AI_MODEL
			.set(ctx, Str::new(model))
			.map_err(std::io::Error::other)?;
	}
	Ok(())
}

/// Catalog facts for `model`, identified on the route `target` pins (its
/// route, or its provider's most preferred route) or else the model's most
/// preferred route.
fn route_facts(
	catalog: &omp_catalog::snapshot::Catalog,
	model: &omp_catalog::ModelSpec,
	target: Option<&Target>,
) -> RouteFacts {
	RouteFacts {
		identity:           route_identity(catalog, model, target),
		// `forced_choice` is capability, not cost. Only an affirmative
		// penalty-free named-choice fact skips ADR 0019's soft escalation.
		forced_choice_free: catalog
			.wire_policy(&model.wire_policy)
			.is_some_and(|policy| {
				policy.tool.named_choice == Some(true) && policy.tool.forced_choice_penalty.is_none()
			}),
		context_window:     model.limits.context_window.unwrap_or(0),
		strict_schema:      model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| chat.tools.constraints())
			.is_some_and(|tools| {
				tools
					.features
					.contains(omp_catalog::capability::ToolFeatureBits::STRICT_SCHEMA)
			}),
		grammar:            model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| chat.grammar.constraints())
			.copied()
			.unwrap_or_default(),
		maximum_tools:      model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| chat.tools.constraints())
			.and_then(|tools| tools.maximum_tools),
		image_input:        model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| chat.input_modalities.constraints())
			.is_some_and(|modalities| {
				modalities.contains(omp_catalog::capability::ModalityBits::IMAGE)
			}),
	}
}

fn route_identity(
	catalog: &omp_catalog::snapshot::Catalog,
	model: &omp_catalog::ModelSpec,
	target: Option<&Target>,
) -> Option<Arc<omp_agent::RouteIdentity>> {
	let preferred = || model.routes.iter().find_map(|route| catalog.route(route));
	let route = match target {
		Some(Target::Route { route, .. } | Target::RouteService(route)) => catalog.route(route),
		Some(Target::Provider { provider, .. } | Target::ProviderService(provider)) => model
			.routes
			.iter()
			.filter_map(|route| catalog.route(route))
			.find(|route| route.provider == *provider),
		Some(Target::Model(_)) | None => None,
	}
	.or_else(preferred)?;
	Some(Arc::new(omp_agent::RouteIdentity {
		model:       model.key.clone(),
		provider:    route.provider.clone(),
		codec:       route.codec.clone(),
		image_frame: model.image_frame,
	}))
}

#[derive(Debug, thiserror::Error)]
#[error("unknown tool `{name}` in --tools allow-list")]
struct UnknownTool {
	name: Str,
}

fn validate_tool_names(registry: &Registry, names: &[Str]) -> Result<(), HeadlessError> {
	for name in names {
		if registry.live_identity(name.as_str()).is_none() {
			return Err(HeadlessError::Io(std::io::Error::new(
				std::io::ErrorKind::InvalidInput,
				UnknownTool { name: name.clone() },
			)));
		}
	}
	Ok(())
}

fn resolve_model_selector(
	catalog: &omp_catalog::snapshot::Catalog,
	selector: &str,
) -> Result<Str, HeadlessError> {
	if let Some(model) = catalog.model(omp_catalog::ModelKey::from_ref(selector)) {
		return Ok(Str::new(model.key.as_str()));
	}
	if let Some(model) = catalog.resolve_alias(selector) {
		return Ok(Str::new(model.key.as_str()));
	}
	Err(HeadlessError::UnknownModel { selector: Str::new(selector) })
}

/// Settles the launch model against the catalog composition routes through,
/// after runtime discovery refreshed it.
///
/// `model_selector` resolves as an exact key or alias, else through catalog
/// selection (a bare or provider-qualified id such as `--model fast`). Under
/// [`LaunchModelPolicy::RememberedDefault`] the remembered default role
/// resolves here rather than against the pre-discovery launch snapshot, so a
/// discovered default survives an expired discovery cache. A remembered
/// default the refreshed catalog still does not list falls back to
/// `model_selector` (the launch's fallback) and is reported in
/// [`LaunchModel::missing_default`] instead of being replaced silently.
///
/// # Errors
///
/// [`UnknownLaunchModel`] when neither the remembered default nor the
/// fallback names a catalog model.
pub fn settle_launch_model(
	catalog: &omp_catalog::snapshot::Catalog,
	ctx: &omp_con::Ctx,
	project_root: &Path,
	model_selector: &str,
	policy: LaunchModelPolicy,
) -> Result<LaunchModel, UnknownLaunchModel> {
	let home = std::env::var_os("HOME").map_or_else(|| project_root.to_path_buf(), PathBuf::from);
	let settings =
		omp_catalog::settings::ModelSettings::from_con(ctx).resolve_path_scopes(project_root, &home);
	// An exact key or alias, else a bare or provider-qualified model id
	// (`--model fast`) through the same catalog selection `/model` uses.
	let selected = catalog
		.model(omp_catalog::ModelKey::from_ref(model_selector))
		.or_else(|| catalog.resolve_alias(model_selector))
		.map(|model| Str::new(model.key.as_str()))
		.or_else(|| {
			crate::discovery::roles::resolve_role_selector(catalog, &settings, model_selector)
				.ok()
				.map(|selected| Str::new(selected.model.as_str()))
		});
	let unknown = || UnknownLaunchModel { selector: Str::new(model_selector) };
	let default = match policy {
		LaunchModelPolicy::Selected => crate::discovery::roles::LaunchDefault::Unset,
		LaunchModelPolicy::RememberedDefault => {
			crate::discovery::roles::resolve_launch_default(catalog, &settings)
		},
	};
	match default {
		crate::discovery::roles::LaunchDefault::Resolved(default) => Ok(LaunchModel {
			model:           Str::new(default.model.as_str()),
			thinking:        default.thinking,
			missing_default: None,
		}),
		crate::discovery::roles::LaunchDefault::Unset => {
			let model = selected.ok_or_else(unknown)?;
			Ok(LaunchModel { model, thinking: None, missing_default: None })
		},
		crate::discovery::roles::LaunchDefault::Missing { selector } => {
			let model = selected
				.or_else(|| crate::discovery::roles::fallback_model_selector(catalog, &settings))
				.ok_or_else(unknown)?;
			tracing::warn!(
				remembered = %selector,
				fallback = %model,
				"the remembered default model is not in the catalog after discovery; launching on a \
				 fallback"
			);
			Ok(LaunchModel { model, thinking: None, missing_default: Some(selector) })
		},
	}
}

fn terminal_identity() -> Option<Str> {
	let environment = [
		"OMP_TERMINAL_ID",
		"TERM_SESSION_ID",
		"WEZTERM_PANE",
		"KITTY_WINDOW_ID",
		"WT_SESSION",
		"TMUX_PANE",
		"SSH_TTY",
		"TTY",
	]
	.into_iter()
	.find_map(|name| {
		let value = std::env::var_os(name)?;
		let value = value.to_string_lossy();
		(!value.is_empty()).then(|| Str::new(value.as_ref()))
	});
	environment.or_else(terminal_device_identity)
}

#[cfg(unix)]
fn terminal_device_identity() -> Option<Str> {
	use std::io::IsTerminal as _;
	if !std::io::stdin().is_terminal() {
		return None;
	}
	["/dev/fd/0", "/proc/self/fd/0"].into_iter().find_map(|fd| {
		let path = fs::canonicalize(fd).ok()?;
		path
			.starts_with("/dev/")
			.then(|| Str::new(path.to_string_lossy()))
	})
}

#[cfg(not(unix))]
const fn terminal_device_identity() -> Option<Str> {
	None
}

fn terminal_marker(sessions_dir: &Path, terminal: &str) -> PathBuf {
	let key = omp_core::Hash32::sum(terminal.as_bytes()).to_hex();
	sessions_dir.join(".continue").join(key.as_str())
}

/// The most recently modified `.oms` journal directly in `sessions_dir`, if
/// any: what `--continue` resumes in a project's session directory and RPC
/// `open_session` resumes in a host-keyed one.
pub fn newest_session(sessions_dir: &Path) -> std::io::Result<Option<PathBuf>> {
	let entries = match fs::read_dir(sessions_dir) {
		Ok(entries) => entries,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error),
	};
	let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
	for entry in entries {
		let entry = entry?;
		let path = entry.path();
		if path.extension().and_then(|extension| extension.to_str())
			!= Some(omp_journal::FILE_EXTENSION)
			|| !path.is_file()
		{
			continue;
		}
		let modified = entry.metadata()?.modified()?;
		if newest.as_ref().is_none_or(|(when, _)| modified > *when) {
			newest = Some((modified, path));
		}
	}
	Ok(newest.map(|(_, path)| path))
}

fn remembered_terminal_session(
	sessions_dir: &Path,
	terminal: Option<&str>,
) -> Result<Option<PathBuf>, HeadlessError> {
	let Some(terminal) = terminal else {
		return Ok(None);
	};
	let marker = terminal_marker(sessions_dir, terminal);
	let name = match fs::read_to_string(marker) {
		Ok(name) => name,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error.into()),
	};
	let name = name.trim();
	let relative = Path::new(name);
	if name.is_empty()
		|| relative.components().count() != 1
		|| relative
			.extension()
			.and_then(|extension| extension.to_str())
			!= Some(omp_journal::FILE_EXTENSION)
	{
		return Ok(None);
	}
	let path = sessions_dir.join(relative);
	Ok(path.is_file().then_some(path))
}

fn remember_terminal_session(
	sessions_dir: &Path,
	terminal: Option<&str>,
	journal: &Path,
) -> Result<(), HeadlessError> {
	let Some(terminal) = terminal else {
		return Ok(());
	};
	let Ok(relative) = journal.strip_prefix(sessions_dir) else {
		return Ok(());
	};
	if relative.components().count() != 1 {
		return Ok(());
	}
	let Some(name) = relative.file_name() else {
		return Ok(());
	};
	let marker = terminal_marker(sessions_dir, terminal);
	if let Some(parent) = marker.parent() {
		fs::create_dir_all(parent)?;
	}
	fs::write(marker, name.to_string_lossy().as_bytes())?;
	Ok(())
}

fn select_journal_path(
	sessions_dir: &Path,
	explicit: Option<&Path>,
	fork: Option<&Path>,
	continue_session: bool,
	ephemeral: bool,
	terminal: Option<&str>,
) -> Result<PathBuf, HeadlessError> {
	let selected = usize::from(explicit.is_some())
		+ usize::from(fork.is_some())
		+ usize::from(continue_session)
		+ usize::from(ephemeral);
	if selected > 1 {
		return Err(
			std::io::Error::new(
				std::io::ErrorKind::InvalidInput,
				"session, fork, continue, and ephemeral modes are mutually exclusive",
			)
			.into(),
		);
	}
	if let Some(path) = explicit {
		return Ok(resolve_session_path(sessions_dir, path));
	}
	if let Some(source) = fork {
		let source = resolve_session_path(sessions_dir, source);
		let destination = sessions_dir.join(format!("{}.oms", Ulid::generate()));
		copy_private_file(&source, &destination)?;
		if let (Some(source_local), Some(destination_local)) =
			(session_local_tree(&source), session_local_tree(&destination))
			&& source_local.is_dir()
			&& let Err(error) = copy_private_tree(&source_local, &destination_local)
		{
			let _ = fs::remove_file(&destination);
			let _ = fs::remove_dir_all(&destination_local);
			return Err(error.into());
		}
		return Ok(destination);
	}
	if continue_session {
		if let Some(path) = remembered_terminal_session(sessions_dir, terminal)? {
			return Ok(path);
		}
		// No breadcrumb exists for this terminal, so
		// continue the project's newest journal before creating a fresh one.
		if let Some(path) = newest_session(sessions_dir)? {
			return Ok(path);
		}
	}
	if !ephemeral {
		return Ok(sessions_dir.join(format!("{}.oms", Ulid::generate())));
	}
	loop {
		let root = std::env::temp_dir().join(format!("omp-session-{}", Ulid::generate()));
		match fs::create_dir(&root) {
			Ok(()) => return Ok(root.join("session.oms")),
			Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
			Err(error) => return Err(error.into()),
		}
	}
}

fn session_local_tree(journal: &Path) -> Option<PathBuf> {
	let stem = journal.file_stem().filter(|stem| !stem.is_empty())?;
	Some(journal.with_file_name(stem))
}

fn copy_private_file(source: &Path, destination: &Path) -> std::io::Result<()> {
	let result = (|| {
		let mut source = fs::File::open(source)?;
		let mut destination = fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(destination)?;
		std::io::copy(&mut source, &mut destination)?;
		destination.sync_all()
	})();
	if result.is_err() {
		let _ = fs::remove_file(destination);
	}
	result
}

fn copy_private_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
	fs::create_dir_all(destination)?;
	for entry in fs::read_dir(source)? {
		let entry = entry?;
		let file_type = entry.file_type()?;
		let target = destination.join(entry.file_name());
		if file_type.is_dir() {
			copy_private_tree(&entry.path(), &target)?;
		} else if file_type.is_file() {
			fs::copy(entry.path(), target)?;
		}
	}
	Ok(())
}

/// The discovered prompt material [`install_prompt_facts`] journaled on
/// `session`'s `<meta>`; empty when the session carries no facts.
#[must_use]
pub fn journaled_prompt_facts(session: &Session) -> crate::discovery::PromptFacts {
	let dom = session.dom();
	let mut facts = crate::discovery::PromptFacts::default();
	let Some(Value::Json(raw)) = dom
		.get(dom.meta())
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static("prompt-facts"))))
	else {
		return facts;
	};
	let Ok(serde_json::Value::Object(mut values)) =
		serde_json::from_str::<serde_json::Value>(raw.get())
	else {
		return facts;
	};
	let mut take = |key: &str| match values.remove(key) {
		Some(serde_json::Value::Array(rows)) => rows,
		_ => Vec::new(),
	};
	facts.skills = take("skills");
	facts.context_files = take("context_files");
	facts.always_apply_rules = take("always_apply_rules");
	facts.rules = take("rules");
	facts.active_repository = values
		.remove("active_repository")
		.and_then(|value| serde_json::from_value(value).ok());
	facts
}

/// The agent class a kernel composed over the session `dom` runs as: the
/// composition's `explicit` class ([`KernelOptions::agent`], a spawned or
/// revived child), else the class journaled on the session (a child resumed
/// with `--resume`), else [`MAIN_AGENT`](crate::subagent::MAIN_AGENT).
pub(crate) fn kernel_agent(
	explicit: Option<&crate::subagent::AgentName<str>>,
	dom: &omp_dom::Dom,
) -> crate::subagent::AgentName {
	explicit.map_or_else(|| crate::subagent::session_agent(dom), ToOwned::to_owned)
}

/// The prompt facts [`compose_kernel`] journals: skills, context files, the
/// rules admitted for the kernel's agent class, and the active repository.
pub(crate) fn prompt_facts(
	project_root: &Path,
	agent: &crate::subagent::AgentName<str>,
	skills: &crate::discovery::skills::ActiveSkills,
	context_files: &crate::discovery::rules::ContextFiles,
	rules: &crate::discovery::rules::ActiveRules,
) -> crate::discovery::PromptFacts {
	let buckets = rules.prompt_facts(agent);
	crate::discovery::PromptFacts {
		skills:             skills.prompt_facts(),
		context_files:      context_files.prompt_facts(),
		always_apply_rules: buckets.always_apply,
		rules:              buckets.rulebook,
		active_repository:  crate::discovery::active_repo::resolve(project_root),
	}
}

/// Discovers context files and rules for `project_root` under the invocation
/// prompt policy: `--no-context-files` / `--no-rules` yield empty sets so the
/// flags are honest seams rather than post-hoc filters.
pub(crate) fn discover_prompt_material(
	project_root: &Path,
	overrides: &PromptOverrides,
	plugins: &omp_ext::claude_plugin::ClaudePlugins,
) -> Result<
	(crate::discovery::rules::ContextFiles, Arc<crate::discovery::rules::ActiveRules>),
	HeadlessError,
> {
	use crate::discovery::rules::{ActiveRules, ContextFiles};
	if !overrides.include_context_files && !overrides.include_rules {
		return Ok((ContextFiles::default(), Arc::new(ActiveRules::default())));
	}
	let home = omp_core::dirs::home_dir().ok_or(omp_core::dirs::DataDirError::HomeUnset)?;
	let config_root = omp_core::dirs::user_config_root()?;
	let context_files = if overrides.include_context_files {
		ContextFiles::discover(project_root, &home, &config_root)
	} else {
		ContextFiles::default()
	};
	let rules = if overrides.include_rules {
		ActiveRules::discover(project_root, &home, &config_root, plugins)
	} else {
		ActiveRules::default()
	};
	for warning in context_files.warnings.iter().chain(&rules.warnings) {
		tracing::warn!(path = %warning.path.display(), "{}", warning.message);
	}
	Ok((context_files, Arc::new(rules)))
}

fn install_prompt_facts(
	session: &mut Session,
	project_root: &Path,
	model: &str,
	overrides: &PromptOverrides,
	discovered: &crate::discovery::PromptFacts,
	tools_enabled: bool,
) -> Result<(), omp_session::SessionError> {
	let home = std::env::var_os("HOME").map_or_else(|| project_root.to_path_buf(), PathBuf::from);
	let mut facts = serde_json::json!({
		"cwd": project_root.to_string_lossy(),
		"home": home.to_string_lossy(),
		"model": { "identifier": model, "codex_task_policy": false },
		"context_files": discovered.context_files,
		"context_files_enabled": overrides.include_context_files,
		"always_apply_rules": discovered.always_apply_rules,
		"rules": discovered.rules,
		"additional_roots": overrides
			.additional_roots
			.iter()
			.map(|root| root.to_string_lossy().into_owned())
			.collect::<Vec<_>>(),
		"skills": discovered.skills,
		"date": jiff::Zoned::now().strftime("%Y-%m-%d").to_string(),
		"null_prompt": overrides.null_prompt,
	});
	let object = facts.as_object_mut().expect("prompt facts are an object");
	if tools_enabled {
		object.insert(
			"device_guidance".to_owned(),
			serde_json::Value::String(omp_tools::device::PROMPT_GUIDANCE.to_owned()),
		);
		object.insert(
			"auto_qa_guidance".to_owned(),
			serde_json::Value::String(omp_tools::device::AUTO_QA_PROMPT_GUIDANCE.to_owned()),
		);
	}
	// Only a resolved repository is journaled: `active-repo.md` renders
	// whenever the key is present, so a JSON null would misfire.
	if let Some(repository) = &discovered.active_repository {
		object.insert("active_repository".to_owned(), serde_json::to_value(repository)?);
	}
	for (name, value) in [
		("custom_prompt", overrides.custom_prompt.as_ref()),
		("append_prompt", overrides.append_prompt.as_ref()),
		("personality", overrides.personality.as_ref()),
	] {
		if let Some(value) = value {
			object.insert(name.to_owned(), serde_json::Value::String(value.to_string()));
		}
	}
	for (name, value) in [
		("include_model", overrides.include_model),
		("include_workstation", overrides.include_workstation),
		("include_workspace_tree", overrides.include_workspace_tree),
		("render_mermaid", overrides.render_mermaid),
		("include_skills", overrides.include_skills),
	] {
		if let Some(value) = value {
			object.insert(name.to_owned(), serde_json::Value::Bool(value));
		}
	}
	let raw = serde_json::value::to_raw_value(&facts)?;
	session.patch(Txn {
		cause: session
			.head()
			.ok_or(omp_session::SessionError::NoActiveTurn)?,
		label: Some(Str::new_static("prompt.facts")),
		ops:   vec![Op::Set {
			h:     session.dom().meta(),
			prop:  PropKey::Custom(Str::new_static("prompt-facts")),
			value: Value::Json(raw),
		}],
	})?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_ai::{
		ChatRequest, NegotiationPolicy, RequestId, Sampling, Setting,
		codec::{
			EncodeContext,
			openai_responses::{OpenAiResponsesCodec, OpenAiResponsesOptions},
		},
	};
	use omp_catalog::{
		ModelKey, ReasoningEffort, ThinkingEffort, ThinkingPolicy, WireTarget, snapshot::Catalog,
	};
	use omp_core::sf;
	use omp_ext::workspace_trust::WorkspaceTrust;

	use super::{
		EphemeralJournal, HeadlessError, KernelOptions, PromptOverrides, apply_model_override,
		convar_reasoning, install_prompt_facts, install_workpool_yield_contract,
		install_yield_contract, isolated_call_model, remember_terminal_session,
		replicate_outcome_blob, replicate_verdict_parts, retarget, route_facts, select_journal_path,
		session_local_tree, validate_tool_names,
	};

	const GPT5: &str = "openai/gpt-5";

	#[test]
	fn a_registered_session_carries_the_composed_project_root() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let data_dir = scratch.path().join("data");
		let project_root = scratch.path().join("project");
		std::fs::create_dir_all(&project_root).expect("project root");
		let (up, _inbox) = flume::unbounded();
		let home = super::SessionHome::new(
			&data_dir,
			&project_root,
			&KernelOptions::default(),
			sf!(GPT5),
			up,
			Arc::default(),
		)
		.expect("session home");
		let session = home.create(None).expect("session");
		let id = session
			.journal_path()
			.file_stem()
			.and_then(|name| name.to_str())
			.expect("journal stem");
		let live = home
			.live
			.lookup(crate::sessions::SessionId::from_ref(id))
			.expect("registered handle");
		assert_eq!(&*live.project_root, home.project_root.as_path());
		assert_eq!(&*live.project_root, std::fs::canonicalize(&project_root).expect("canonical"));
	}

	#[test]
	fn visibility_transport_preserves_source_lines_and_remaps_filtered_parts() {
		use omp_proto::thread::v1::{Part, part::Kind};
		let parts = [Part::default(), Part { kind: Some(Kind::Text("alpha".to_owned())) }];
		let spans = super::tool_visibility_spans(
			vec![omp_env::frame::ProjectionSpan {
				part:       1,
				start_byte: 0,
				end_byte:   5,
				source_key: "source".to_owned(),
				line:       7,
			}],
			&parts,
		)
		.expect("valid visibility");
		assert_eq!(spans, [omp_tool::ProjectionSpan {
			part:       0,
			start_byte: 0,
			end_byte:   5,
			source_key: sf!("source"),
			line:       7,
		}]);
	}

	#[test]
	fn legacy_verdict_defaults_to_empty_visibility() {
		use omp_proto::prost::Message;
		let verdict =
			omp_env::frame::Verdict { invocation_id: "legacy".to_owned(), ..Default::default() };
		let decoded = omp_env::frame::Verdict::decode(verdict.encode_to_vec().as_slice())
			.expect("legacy verdict");
		assert!(
			super::tool_visibility_spans(decoded.visibility, &decoded.parts)
				.expect("empty receipt")
				.is_empty()
		);
	}

	#[test]
	fn visibility_transport_rejects_malformed_ranges() {
		use omp_proto::thread::v1::{Part, part::Kind};
		let parts = [Part { kind: Some(Kind::Text("écho".to_owned())) }];
		for (part, start_byte, end_byte, source_key, line) in [
			(1, 0, 2, "source", 1),
			(0, 1, 2, "source", 1),
			(0, 0, 6, "source", 1),
			(0, 2, 2, "source", 1),
			(0, 0, 2, "", 1),
			(0, 0, 2, "source", 0),
		] {
			assert!(
				super::tool_visibility_spans(
					vec![omp_env::frame::ProjectionSpan {
						part,
						start_byte,
						end_byte,
						source_key: source_key.to_owned(),
						line
					}],
					&parts
				)
				.is_err()
			);
		}
	}

	/// A fetch envelope, fetching with credentials when `credentials`.
	fn fetching(credentials: bool) -> omp_tool::Effects {
		omp_tool::Effects {
			documents: Some(omp_tool::DocEffects {
				read:        true,
				write_globs: std::sync::Arc::from([]),
			}),
			fetch: Some(omp_tool::FetchEffects { credentials }),
			..omp_tool::Effects::empty()
		}
	}

	/// The admission query the environment sends for a call judged by
	/// `effects`, whose fetches reach `hosts`.
	fn admission_query(
		effects: Option<&omp_tool::Effects>,
		hosts: &[omp_envd::fetch_host::FetchHost],
	) -> omp_env::frame::AdmitInvocation {
		omp_env::frame::AdmitInvocation {
			invocation_id: "call".to_owned(),
			deadline_ms: 30_000,
			effects: effects.map(Into::into),
			fetch: hosts.iter().map(Into::into).collect(),
			..omp_env::frame::AdmitInvocation::default()
		}
	}

	/// `(kind, subject)` of each requirement, in filing order.
	fn keyed(specs: &[omp_agent::ApprovalSpec]) -> Vec<(&str, &str)> {
		specs
			.iter()
			.map(|spec| (spec.kind.as_str(), spec.subject.as_str()))
			.collect()
	}

	/// A fetch is asked per host: one `network` requirement for each distinct
	/// host the environment named, and the tool itself only for what its tier
	/// adds beyond the fetch. A fetch the environment could not name (reported
	/// unnamed, or a target that names no host) is asked as the tool's own
	/// beside every named host, never instead of them. Every requirement
	/// offers the session; `bash` keeps its exact command.
	#[test]
	fn admission_queries_key_each_fetch_on_its_host() {
		use omp_envd::fetch_host::FetchHost;

		let args = r#"{"path":"https://docs.rs/serde"}"#;
		let docs = FetchHost::http("docs.rs", 443);
		let forge = FetchHost::github("github.com");
		let specs = super::admission_specs(
			"read",
			args,
			&admission_query(Some(&fetching(true)), &[docs.clone(), forge, docs.clone()]),
		);
		assert_eq!(keyed(&specs), [
			("network", "http:docs.rs:443"),
			("network", "github:github.com")
		]);
		for spec in &specs {
			assert_eq!(spec.scopes, [sf!("once"), sf!("session")]);
			assert_eq!(spec.timeout_ms, 30_000);
			assert!(spec.require_human);
		}
		assert!(specs[0].body.contains("the authored host docs.rs:443"), "{}", specs[0].body);
		assert!(specs[1].body.contains("stored GitHub credentials"), "{}", specs[1].body);

		// A fetch beside a write is asked for the tool and for each host.
		let fetch_and_write = omp_tool::Effects {
			documents: Some(omp_tool::DocEffects {
				read:        true,
				write_globs: std::sync::Arc::from([sf!("**")]),
			}),
			..fetching(false)
		};
		assert_eq!(
			keyed(&super::admission_specs(
				"download",
				args,
				&admission_query(Some(&fetch_and_write), std::slice::from_ref(&docs)),
			)),
			[("tool", "download"), ("network", "http:docs.rs:443")]
		);

		// No named host, or a target that names none: the tool's own fetch.
		let malformed_target = omp_proto::policy::v1::FetchTarget {
			resolver: omp_proto::policy::v1::FetchResolver::Http as i32,
			host:     "evil.example".to_owned(),
			port:     None,
			props:    None,
		};
		let malformed = omp_env::frame::AdmitInvocation {
			fetch: vec![malformed_target.clone()],
			..admission_query(Some(&fetching(false)), &[])
		};
		for query in [admission_query(Some(&fetching(false)), &[]), malformed] {
			assert_eq!(keyed(&super::admission_specs("read", args, &query)), [(
				"network",
				"tool:read"
			)]);
		}

		// A fetch partly unnamed keeps every named host beside the tool's own:
		// reported by the environment, or a malformed target among good ones.
		let partly = omp_env::frame::AdmitInvocation {
			fetch_unnamed: true,
			..admission_query(Some(&fetching(false)), std::slice::from_ref(&docs))
		};
		let mut beside_malformed =
			admission_query(Some(&fetching(false)), std::slice::from_ref(&docs));
		beside_malformed.fetch.push(malformed_target);
		for query in [partly, beside_malformed] {
			assert_eq!(keyed(&super::admission_specs("read", args, &query)), [
				("network", "http:docs.rs:443"),
				("network", "tool:read")
			]);
		}

		// No fetch: the tool, whatever hosts were sent; no envelope: the tool.
		let write = omp_tool::Effects {
			documents: Some(omp_tool::DocEffects {
				read:        true,
				write_globs: std::sync::Arc::from([sf!("**")]),
			}),
			..omp_tool::Effects::empty()
		};
		for query in
			[admission_query(Some(&write), std::slice::from_ref(&docs)), admission_query(None, &[])]
		{
			assert_eq!(keyed(&super::admission_specs("write", "{}", &query)), [("tool", "write")]);
		}

		let bash = omp_env::frame::AdmitInvocation {
			bash: Some(omp_proto::policy::v1::BashIr {
				source: "cargo test".to_owned(),
				..omp_proto::policy::v1::BashIr::default()
			}),
			..admission_query(Some(&omp_tool::Effects::empty()), &[])
		};
		let specs = super::admission_specs("bash", r#"{"command":"cargo test"}"#, &bash);
		assert_eq!(keyed(&specs), [("exec", "cargo test")]);
		assert_eq!(specs[0].body, "$ cargo test");
	}

	/// Under `always-ask` a fetch is asked once per host per session: a
	/// session grant for one host answers every later fetch from that host,
	/// whatever the path, while a fetch from another host, a fetch that also
	/// reaches another host, and the tool's own non-fetch requirement are
	/// asked again. Hosts granted one prompt at a time answer a fetch reaching
	/// all of them, and a grant for the tool's own unnamed fetch never answers
	/// a host the environment names beside it.
	#[test]
	fn a_session_fetch_grant_covers_its_host_and_no_other() {
		use omp_agent::{
			ApprovalDecision, ApprovalDesk, ApprovalScope, ApprovalSource, KernelEvents, TicketState,
		};
		use omp_envd::fetch_host::FetchHost;

		let scratch = tempfile::tempdir().expect("scratch");
		let blobs = omp_journal::blob::BlobStore::open(scratch.path().join("blobs")).expect("blobs");
		let mut session = omp_session::Session::create_with_blob_store(
			scratch.path().join("fetch.oms"),
			omp_session::ComponentRegistry::standard(),
			blobs,
		)
		.expect("session");
		let desk = ApprovalDesk::new(KernelEvents::default());
		let docs = FetchHost::http("docs.rs", 443);
		let crates = FetchHost::http("crates.io", 443);
		let ask_partly = |session: &mut omp_session::Session,
		                  call: &str,
		                  path: &str,
		                  hosts: &[FetchHost],
		                  fetch_unnamed: bool| {
			let args = format!(r#"{{"path":"{path}"}}"#);
			let query = omp_env::frame::AdmitInvocation {
				fetch_unnamed,
				..admission_query(Some(&fetching(false)), hosts)
			};
			desk
				.file_specs(
					session,
					omp_core::Str::new(call),
					super::admission_specs("read", &args, &query),
				)
				.expect("prompt files")
		};
		let ask = |session: &mut omp_session::Session,
		           call: &str,
		           path: &str,
		           hosts: &[FetchHost]| { ask_partly(session, call, path, hosts, false) };
		let grant = |session: &mut omp_session::Session, ticket: &omp_agent::ApprovalTicket| {
			desk
				.decide(session, ticket.ticket_id.as_str(), ApprovalDecision {
					approved:   true,
					scope:      ApprovalScope::Session,
					source:     ApprovalSource::User,
					decided_by: None,
					reason:     None,
					audited:    false,
				})
				.expect("the session grant is journaled");
		};

		let first = ask(&mut session, "call-1", "https://docs.rs/serde", std::slice::from_ref(&docs));
		assert_eq!(first.state, TicketState::Pending, "the first fetch from a host asks");
		let docs_again =
			ask(&mut session, "call-2", "https://docs.rs/tokio", std::slice::from_ref(&docs));
		assert_eq!(docs_again.state, TicketState::Pending, "an undecided host still asks");

		grant(&mut session, &first);

		let granted =
			ask(&mut session, "call-3", "https://docs.rs/bytes", std::slice::from_ref(&docs));
		assert_eq!(granted.state, TicketState::Decided, "the granted host is not asked again");
		let decision = granted.decision.as_ref().expect("decided by the grant");
		assert!(decision.approved);
		assert_eq!(decision.source, ApprovalSource::Config);

		let other = ask(
			&mut session,
			"call-4",
			"https://crates.io/crates/serde",
			std::slice::from_ref(&crates),
		);
		assert_eq!(other.state, TicketState::Pending, "a grant for one host never covers another");
		let both = ask(&mut session, "call-5", "https://docs.rs/serde;https://crates.io", &[
			crates.clone(),
			docs.clone(),
		]);
		assert_eq!(both.state, TicketState::Pending, "every host of a fetch must be granted");
		let unnamed = ask(&mut session, "call-6", "https://docs.rs/serde", &[]);
		assert_eq!(unnamed.state, TicketState::Pending, "the tool's own fetch is not a host's");

		// Each host granted on its own prompt: a fetch reaching both is not
		// asked again.
		grant(&mut session, &other);
		let both = ask(&mut session, "call-8", "https://docs.rs/serde;https://crates.io", &[
			crates,
			docs.clone(),
		]);
		assert_eq!(both.state, TicketState::Decided, "hosts granted one at a time cover both");

		// The tool's own unnamed fetch granted for the session never covers a
		// host named beside an unnamed locator, and covers only the remainder
		// beside a granted one.
		grant(&mut session, &unnamed);
		let evil = FetchHost::http("evil.example", 443);
		let smuggled =
			ask_partly(&mut session, "call-9", "https://evil.example/x;issue://5", &[evil], true);
		assert_eq!(
			smuggled.state,
			TicketState::Pending,
			"a named host is asked beside the remainder"
		);
		assert_eq!(keyed(&smuggled.reasons), [
			("network", "http:evil.example:443"),
			("network", "tool:read")
		]);
		let remainder =
			ask_partly(&mut session, "call-10", "https://docs.rs/x;issue://5", &[docs], true);
		assert_eq!(remainder.state, TicketState::Decided, "the granted host and remainder answer");

		let write = omp_tool::Effects {
			documents: Some(omp_tool::DocEffects {
				read:        true,
				write_globs: std::sync::Arc::from([sf!("**")]),
			}),
			..omp_tool::Effects::empty()
		};
		let tool = desk
			.file_specs(
				&mut session,
				omp_core::Str::new("call-7"),
				super::admission_specs("read", "{}", &admission_query(Some(&write), &[])),
			)
			.expect("prompt files");
		assert_eq!(tool.state, TicketState::Pending, "a host grant never covers the tool");
	}

	/// Without a fetch hosts namer a kernel-admitted fetch names no host: a
	/// call whose tier is a fetch is asked as the tool's own fetch, offering
	/// the session, and a call above the fetch tier is asked as the tool and
	/// as the tool's own fetch, whatever URLs it names.
	#[test]
	fn settings_admission_asks_an_unnamed_kernel_fetch_as_the_tools_own() {
		use omp_agent::{ToolAdmission, ToolAdmissionVerdict};
		use omp_contract::posture::SandboxState;
		use omp_envd::tool_settings::ToolSettings;

		let args = serde_json::value::RawValue::from_string(String::from(r#"{"url":"x"}"#))
			.expect("raw args");
		let admission = super::SettingsAdmission {
			settings:    ToolSettings::default()
				.with_approval_mode_override(Some(omp_contract::posture::ApprovalMode::AlwaysAsk)),
			sandbox:     SandboxState::Off,
			posture:     super::PostureNotice::default(),
			fetch_hosts: None,
		};
		let locators = [sf!("https://docs.rs/serde")];
		let ToolAdmissionVerdict::Prompt(specs) = admission.admit(
			"host_fetch",
			&fetching(true),
			omp_tool::Confinement::Host,
			&args,
			&locators,
		) else {
			panic!("always-ask asks for a fetch");
		};
		assert_eq!(keyed(&specs), [("network", "tool:host_fetch")]);
		assert_eq!(specs[0].scopes, [sf!("once"), sf!("session")]);
		let write = omp_tool::Effects {
			documents: Some(omp_tool::DocEffects {
				read:        true,
				write_globs: std::sync::Arc::from([sf!("**")]),
			}),
			..fetching(false)
		};
		let ToolAdmissionVerdict::Prompt(specs) =
			admission.admit("host_fetch", &write, omp_tool::Confinement::Host, &args, &locators)
		else {
			panic!("always-ask asks for a write");
		};
		assert_eq!(keyed(&specs), [("tool", "host_fetch"), ("network", "tool:host_fetch")]);
		let bash = serde_json::value::RawValue::from_string(String::from(r#"{"command":"ls"}"#))
			.expect("raw args");
		let ToolAdmissionVerdict::Prompt(specs) =
			admission.admit("bash", &write, omp_tool::Confinement::Host, &bash, &[])
		else {
			panic!("always-ask asks for a command");
		};
		assert_eq!(keyed(&specs), [("exec", "ls")]);
	}

	/// The kernel admission point applies decision 4 with an injected active
	/// sandbox (Linux CI never constructs one): under the shipped `yolo`, a
	/// `Host` network tool prompts and says why, while `bash` and `Host` read
	/// tools proceed; an explicit `yolo` prompts for neither.
	#[test]
	fn settings_admission_prompts_for_host_tools_under_a_sandboxed_default_yolo() {
		use omp_agent::{ToolAdmission, ToolAdmissionVerdict};
		use omp_contract::posture::SandboxState;
		use omp_envd::tool_settings::ToolSettings;
		use omp_tool::{Confinement, DocEffects, Effects, ExecEffects, InferenceEffects, Usd};

		let args = serde_json::value::RawValue::from_string(String::from("{}")).expect("raw args");
		let web_search = Effects {
			exec: Some(ExecEffects { commands: std::sync::Arc::from([]), network: true }),
			inference: Some(InferenceEffects { max_requests: 1, max_usd: Usd::from_nanos(1) }),
			..Effects::empty()
		};
		let read = Effects {
			documents: Some(DocEffects { read: true, write_globs: std::sync::Arc::from([]) }),
			..Effects::empty()
		};
		let admission = |settings| super::SettingsAdmission {
			settings,
			sandbox: SandboxState::Active,
			posture: super::PostureNotice::default(),
			fetch_hosts: None,
		};

		let defaulted = admission(ToolSettings::default());
		let ToolAdmissionVerdict::Prompt(specs) =
			defaulted.admit("web_search", &web_search, Confinement::Host, &args, &[])
		else {
			panic!("a host network tool must prompt under a sandbox-kept default yolo");
		};
		assert_eq!(specs[0].evidence, [
			sf!("exec tier, host confinement, under approval mode write"),
			sf!(
				"the default `yolo` covers only tools the sandbox confines; this tool runs outside it"
			),
		]);
		assert_eq!(
			defaulted.admit("bash", &Effects::empty(), Confinement::ExecSandbox, &args, &[]),
			ToolAdmissionVerdict::Allow
		);
		assert_eq!(
			defaulted.admit("read", &read, Confinement::Host, &args, &[]),
			ToolAdmissionVerdict::Allow
		);

		let explicit = admission(
			ToolSettings::default()
				.with_approval_mode_override(Some(omp_contract::posture::ApprovalMode::Yolo)),
		);
		assert!(matches!(
			explicit.admit("web_search", &web_search, Confinement::Host, &args, &[]),
			ToolAdmissionVerdict::Prompt(_)
		));
		let explicit = explicit.with_workspace_trust(WorkspaceTrust::Trusted);
		assert_eq!(
			explicit.admit("web_search", &web_search, Confinement::Host, &args, &[]),
			ToolAdmissionVerdict::Allow
		);
		assert_eq!(
			explicit.admit("bash", &Effects::empty(), Confinement::ExecSandbox, &args, &[]),
			ToolAdmissionVerdict::Allow
		);
	}

	/// The session's one posture report is shared by the kernel's admission
	/// and the environment executor ([`super::install_tool_authority`]): the
	/// first admission at either posts the typed notice and a later one at
	/// either adds nothing, until a rewind or a switch leaves the kernel on a
	/// live branch without the notice, which makes it due again. (The notice
	/// posted here reaches no journal, so every session below lacks it; the
	/// driver's `approval_authority` tests journal it through a kernel.)
	#[test]
	fn the_posture_report_posts_once_until_the_journal_lacks_it() {
		use omp_agent::{EnvEvent, SessionObserver as _, ToolAdmission as _, Up};
		use omp_contract::posture::{ApprovalPosture, SandboxState};
		use omp_envd::tool_settings::ToolSettings;
		use omp_tool::{Confinement, Effects};

		let scratch = tempfile::tempdir().expect("scratch");
		let session = super::Session::create(
			scratch.path().join("posture.oms"),
			super::ComponentRegistry::standard(),
		)
		.expect("session");
		let args = serde_json::value::RawValue::from_string(String::from("{}")).expect("raw args");
		let (mailbox, notices) = flume::unbounded();
		let settings = ToolSettings::default();
		let Some(posture) =
			ApprovalPosture::resolve(settings.configured_approval(), SandboxState::Off)
		else {
			panic!("a defaulted yolo without a sandbox is reported");
		};
		// What `install_tool_authority` builds and hands the executor, the
		// admission and the session observers, here marked spent so that only
		// the journal can make it due.
		let observer = Arc::new(super::PendingPosture {
			posture,
			mailbox,
			posted: std::sync::atomic::AtomicBool::new(true),
		});
		observer.sync(&session);
		let executor = super::PostureNotice(Some(Arc::clone(&observer)));
		let admission = super::SettingsAdmission {
			settings,
			sandbox: SandboxState::Off,
			posture: executor.clone(),
			fetch_hosts: None,
		};
		let admit = || {
			let _ = admission.admit("bash", &Effects::empty(), Confinement::ExecSandbox, &args, &[]);
		};

		admit();
		executor.post();
		admit();
		let posted = notices.drain().collect::<Vec<_>>();
		let [Up::Env(EnvEvent::TypedNotice { kind, name, data, body })] = posted.as_slice() else {
			panic!("one typed notice for the first session, {} posted", posted.len());
		};
		assert_eq!(kind.as_str(), "warn");
		assert_eq!(name.as_str(), omp_contract::posture::APPROVAL_POSTURE_NOTICE);
		assert_eq!(
			serde_json::from_str::<serde_json::Value>(data.get()).expect("typed payload"),
			serde_json::json!({
				"configured": "yolo",
				"provenance": "default",
				"effective": "write",
				"sandbox": { "state": "off" },
				"workspace_trust": "untrusted",
				"reason": "default_without_sandbox",
			})
		);
		assert_eq!(
			body.as_str(),
			"Approval `yolo` is the default and needs an active sandbox; `write` is in force \
			 (sandbox off)."
		);

		observer.rewound(&session);
		executor.post();
		admit();
		assert_eq!(notices.drain().count(), 1, "a rewound branch without the notice is told once");

		observer.switched(&session);
		executor.post();
		admit();
		assert_eq!(notices.drain().count(), 1, "a next session without the notice is told once");
	}

	/// An executor whose environment answered its handshake reporting
	/// `reported` as its sandbox state.
	async fn executor_reporting(reported: omp_env::frame::SandboxState) -> super::EnvToolExecutor {
		let (client, transport) = omp_env::EnvClient::in_process(1);
		let server = tokio::spawn(async move {
			let hello = transport.recv().await.expect("client hello");
			transport
				.send(omp_env::frame::ServerFrame {
					request_id: hello.request_id,
					body: Some(omp_env::frame::server_frame::Body::Hello(omp_env::frame::ServerHello {
						sandbox_state: reported.into(),
						..Default::default()
					})),
					..Default::default()
				})
				.await
				.expect("server hello");
			transport
		});
		client
			.hello(omp_env::frame::ClientHello::default())
			.await
			.expect("handshake");
		drop(server.await.expect("server task"));
		let (approvals, _inbox) =
			omp_agent::ApprovalRoute::new(Arc::new(omp_agent::ApprovalBook::new()), None);
		super::EnvToolExecutor::new(client, approvals)
	}

	/// The session's posture is resolved against the sandbox state the
	/// environment reported in its handshake, the state its admissions and the
	/// sandboxed tools run under, whatever this process probed under the same
	/// settings; the probe counts only when the environment reported none.
	#[tokio::test]
	async fn the_session_posture_follows_the_sandbox_the_environment_reports() {
		use omp_contract::posture::{
			ApprovalMode, ApprovalPosture, Provenance, SandboxState, SandboxUnavailable,
		};
		use omp_env::frame::SandboxState as Reported;
		use omp_envd::tool_settings::ToolSettings;

		let probed = |sandbox| super::SettingsAdmission {
			settings: ToolSettings::default(),
			sandbox,
			posture: super::PostureNotice::default(),
			fetch_hosts: None,
		};
		let downgraded = |sandbox| ApprovalPosture {
			configured: ApprovalMode::Yolo,
			provenance: Provenance::Default,
			effective: ApprovalMode::Write,
			sandbox,
			workspace_trust: WorkspaceTrust::Untrusted,
			reason: omp_contract::posture::ApprovalPostureReason::DefaultWithoutSandbox,
		};

		// A daemon whose sandbox confines its commands keeps the defaulted
		// `yolo`, although this process found none: nothing is reported.
		assert_eq!(
			super::session_posture(
				&probed(SandboxState::Off),
				&executor_reporting(Reported::Active).await
			),
			None
		);
		// A daemon that could not construct its sandbox downgrades it, although
		// this process constructed one: the daemon's state is reported.
		let unavailable = SandboxState::Unavailable { cause: SandboxUnavailable::BackendUnavailable };
		assert_eq!(
			super::session_posture(
				&probed(SandboxState::Active),
				&executor_reporting(Reported::BackendUnavailable).await
			),
			Some(downgraded(unavailable))
		);
		// An environment that reported no state leaves the probe to decide.
		assert_eq!(
			super::session_posture(
				&probed(SandboxState::Off),
				&executor_reporting(Reported::Unspecified).await
			),
			Some(downgraded(SandboxState::Off))
		);
	}

	#[tokio::test]
	async fn remote_outcome_replication_resumes_with_stable_session_provenance() {
		let (client, transport) = omp_env::EnvClient::in_process(0);
		let client = client
			.with_principal("session-a", "kernel")
			.expect("valid principal");
		let bytes = b"detached outcome crossing hosts";
		let size = u64::try_from(bytes.len()).expect("fixture size fits u64");
		let digest = omp_core::Hash32::sum(bytes);
		let scratch = tempfile::tempdir().expect("temporary CAS");
		let store = omp_journal::blob::BlobStore::open(scratch.path()).expect("open session CAS");
		let cancel = tokio_util::sync::CancellationToken::new();
		let replication = tokio::spawn({
			let client = client.clone();
			let store = store.clone();
			let cancel = cancel.clone();
			async move {
				replicate_outcome_blob(&client, &store, "call-a", digest, size, 1024, &cancel).await
			}
		});

		let first = transport.recv().await.expect("first blob range");
		let first_request = match first.body {
			Some(omp_env::frame::client_frame::Body::BlobGet(request)) => request,
			_ => panic!("expected first blob get"),
		};
		assert_eq!(first_request.offset, 0);
		assert_eq!(
			first.scope.as_ref().map(|scope| (
				scope.session_id.as_str(),
				scope.agent_id.as_str(),
				scope.invocation_id.as_str(),
			)),
			Some(("session-a", "kernel", "call-a"))
		);
		let split = 9;
		transport
			.send(omp_env::frame::ServerFrame {
				request_id: first.request_id,
				body: Some(omp_env::frame::server_frame::Body::BlobChunk(omp_env::blob_frame::Chunk {
					data: bytes::Bytes::copy_from_slice(&bytes[..split]),
					hash: bytes::Bytes::copy_from_slice(digest.as_bytes()),
					size: Some(size),
				})),
				..Default::default()
			})
			.await
			.expect("first blob chunk");
		transport
			.send(omp_env::frame::ServerFrame {
				request_id: first.request_id,
				body: Some(omp_env::frame::server_frame::Body::EventStreamError(
					omp_env::frame::EventStreamError {
						stream: omp_env::frame::EventStreamKind::Unspecified as i32,
						failure: omp_env::frame::EventStreamFailure::Closed as i32,
						message: "remote blob stream interrupted".into(),
						..Default::default()
					},
				)),
				..Default::default()
			})
			.await
			.expect("interrupt first range");

		let resumed = loop {
			let frame = transport.recv().await.expect("resumed blob range");
			if matches!(&frame.body, Some(omp_env::frame::client_frame::Body::BlobGet(_))) {
				break frame;
			}
		};
		let resumed_request = match resumed.body {
			Some(omp_env::frame::client_frame::Body::BlobGet(request)) => request,
			_ => unreachable!("filtered to blob get"),
		};
		assert_eq!(resumed_request.offset, u64::try_from(split).expect("split fits u64"));
		assert_eq!(resumed.scope, first.scope);
		transport
			.send(omp_env::frame::ServerFrame {
				request_id: resumed.request_id,
				body: Some(omp_env::frame::server_frame::Body::BlobChunk(omp_env::blob_frame::Chunk {
					data: bytes::Bytes::copy_from_slice(&bytes[split..]),
					hash: bytes::Bytes::copy_from_slice(digest.as_bytes()),
					size: Some(size),
				})),
				..Default::default()
			})
			.await
			.expect("resumed blob chunk");
		transport
			.send(omp_env::frame::ServerFrame {
				request_id: resumed.request_id,
				body: Some(omp_env::frame::server_frame::Body::BlobGetComplete(
					omp_env::frame::BlobGetComplete {
						hash: bytes::Bytes::copy_from_slice(digest.as_bytes()),
						bytes_sent: u64::try_from(bytes.len() - split).expect("remainder fits u64"),
						..Default::default()
					},
				)),
				..Default::default()
			})
			.await
			.expect("complete resumed range");

		let reference = replication
			.await
			.expect("replication task")
			.expect("replicated outcome");
		assert_eq!(reference.hash, digest);
		assert_eq!(store.get(&reference).expect("read local replica").as_ref(), bytes);
	}

	#[tokio::test]
	async fn inline_tool_media_is_canonicalized_into_the_session_cas() {
		let (client, _transport) = omp_env::EnvClient::in_process(0);
		let scratch = tempfile::tempdir().expect("temporary CAS");
		let store = omp_journal::blob::BlobStore::open(scratch.path()).expect("open session CAS");
		let bytes = bytes::Bytes::from_static(b"tool image");
		let cancel = tokio_util::sync::CancellationToken::new();
		let parts = replicate_verdict_parts(
			&client,
			&store,
			"call-media",
			vec![omp_proto::thread::v1::Part {
				kind: Some(omp_proto::thread::v1::part::Kind::Blob(omp_proto::thread::v1::Blob {
					mime: "image/png".to_owned(),
					size: u64::try_from(bytes.len()).expect("fixture length"),
					inline: bytes.clone(),
					..Default::default()
				})),
			}],
			1024,
			&cancel,
		)
		.await
		.expect("pin media");
		let [omp_tool::Part::Blob { blob, .. }] = parts.as_slice() else {
			panic!("one canonical blob part: {parts:?}");
		};
		let reference = omp_journal::blob::BlobRef::parse_hex(blob.hash.as_str(), blob.byte_len)
			.expect("canonical reference");
		assert_eq!(
			store.get(&reference).expect("session media").as_ref(),
			bytes.as_ref(),
			"tool media resolves without the environment host"
		);
	}

	fn gpt5_policy(catalog: &Catalog) -> &ThinkingPolicy {
		let spec = catalog
			.model(ModelKey::from_ref(GPT5))
			.expect("embedded gpt-5");
		catalog
			.thinking_policy(spec.thinking.as_ref().expect("gpt-5 reasons"))
			.expect("gpt-5 thinking policy")
	}

	fn effort(setting: &Setting<omp_ai::ReasoningRequest>) -> Option<ReasoningEffort> {
		match setting {
			Setting::Unset => None,
			Setting::Require(value) | Setting::Prefer(value) => value.effort,
		}
	}

	/// Lowers the convar-derived request for gpt-5 through the planner's
	/// thinking resolution and the Responses codec, exactly as a live call
	/// would, and returns the serialized `reasoning` object.
	fn gpt5_wire_reasoning(catalog: &Catalog, thinking: &str) -> Option<serde_json::Value> {
		let key = ModelKey::from_ref(GPT5);
		let spec = catalog.model(key).expect("embedded gpt-5");
		let policy = gpt5_policy(catalog);
		let route = spec
			.routes
			.iter()
			.filter_map(|route| catalog.route(route))
			.find(|route| route.codec.as_str() == "openai-responses")
			.expect("gpt-5 Responses route");
		let wire_model = spec
			.wire_ids
			.iter()
			.find(|(candidate, _)| candidate == &route.id)
			.expect("gpt-5 wire id")
			.1
			.clone();
		let wire_policy = catalog
			.wire_policy(&spec.wire_policy)
			.expect("gpt-5 wire policy");
		let request = ChatRequest {
			messages:          Arc::from([]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         convar_reasoning(catalog, key, thinking),
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		};
		let selection = effort(&request.reasoning).map(|effort| {
			spec
				.thinking_routing
				.resolve(policy, Some(effort.into()), &wire_model)
				.expect("convar effort resolves against the catalog")
		});
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		let request_id = RequestId::new("convar-thinking");
		let context = EncodeContext {
			request_id: &request_id,
			route,
			target: Some(&target),
			policy: wire_policy,
			thinking_policy: Some(policy),
			thinking_selection: selection.as_ref(),
			..EncodeContext::default()
		};
		let encoded = OpenAiResponsesCodec::new(OpenAiResponsesOptions::default())
			.encode_chat(&context, &request)
			.expect("gpt-5 request encodes");
		encoded
			.request
			.reasoning
			.as_ref()
			.map(|reasoning| serde_json::to_value(reasoning).expect("reasoning serializes"))
	}

	#[test]
	fn ai_thinking_off_never_sends_none_to_a_model_without_off() {
		let catalog = Catalog::embedded();
		let policy = gpt5_policy(catalog);
		assert!(
			!policy.efforts.contains(&ThinkingEffort::Off)
				&& policy.efforts.contains(&ThinkingEffort::Minimal),
			"gpt-5 ladder is minimal..high with no wire `none`: {:?}",
			policy.efforts
		);
		let reasoning = gpt5_wire_reasoning(catalog, "off");
		let effort = reasoning
			.as_ref()
			.and_then(|reasoning| reasoning.get("effort"))
			.cloned();
		assert_eq!(effort, None, "reasoning-off must not spell an effort: {reasoning:?}");
	}

	#[test]
	fn ai_thinking_above_the_ladder_clamps_to_the_catalog_ceiling() {
		let catalog = Catalog::embedded();
		let request = convar_reasoning(catalog, ModelKey::from_ref(GPT5), "xhigh");
		assert_eq!(effort(&request), Some(ReasoningEffort::High));
		let reasoning = gpt5_wire_reasoning(catalog, "xhigh").expect("reasoning object");
		assert_eq!(reasoning.get("effort"), Some(&serde_json::json!("high")));
	}

	#[test]
	fn ai_thinking_off_on_a_model_that_requires_effort_uses_the_catalog_default() {
		let catalog = Catalog::embedded();
		let (spec, policy) = catalog
			.models()
			.iter()
			.find_map(|spec| {
				let policy = catalog.thinking_policy(spec.thinking.as_ref()?)?;
				(policy.requires_effort == Some(true)).then_some((spec, policy))
			})
			.expect("embedded catalog has a model that cannot stop reasoning");
		assert!(!policy.supports(ThinkingEffort::Off));
		let request = convar_reasoning(catalog, &spec.key, "off");
		assert_eq!(
			effort(&request),
			policy.default_level.map(ReasoningEffort::from),
			"{}: off falls back to the catalog default level",
			spec.key
		);
	}

	#[test]
	fn ai_thinking_without_a_thinking_policy_leaves_reasoning_unset() {
		let catalog = Catalog::embedded();
		let spec = catalog
			.models()
			.iter()
			.find(|spec| spec.thinking.is_none())
			.expect("embedded catalog has a non-reasoning model");
		assert!(matches!(convar_reasoning(catalog, &spec.key, "high"), Setting::Unset));
	}

	#[test]
	fn explicit_model_replaces_the_restored_session_value() {
		let ctx = omp_con::Ctx::new();
		ctx.restore_session_write("ai_model", "archived/model")
			.expect("restored model");
		apply_model_override(&ctx, "explicit/model", true).expect("explicit model");
		assert_eq!(omp_agent::AI_MODEL.get(&ctx).as_str(), "explicit/model");
		assert!(
			ctx.session_writes()
				.any(|(name, value)| name == "ai_model" && value.to_string() == "explicit/model")
		);

		let inherited = omp_con::Ctx::new();
		inherited
			.restore_session_write("ai_model", "archived/model")
			.expect("restored model");
		apply_model_override(&inherited, "default/model", false).expect("default model");
		assert_eq!(omp_agent::AI_MODEL.get(&inherited).as_str(), "archived/model");
	}

	#[test]
	fn continue_prefers_the_terminal_breadcrumb_then_the_newest_project_session() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let sessions = scratch.path();
		let first = sessions.join("first.oms");
		std::fs::write(&first, b"journal").expect("journal");
		remember_terminal_session(sessions, Some("terminal-a"), &first).expect("breadcrumb");

		let resumed = select_journal_path(sessions, None, None, true, false, Some("terminal-a"))
			.expect("continue");
		assert_eq!(resumed, first);

		// A terminal without its own breadcrumb continues the newest session of the
		// project, not a fresh one.
		let other_terminal =
			select_journal_path(sessions, None, None, true, false, Some("terminal-b"))
				.expect("newest project session");
		assert_eq!(other_terminal, first);

		// A stale breadcrumb with no journals left falls back to a fresh journal.
		std::fs::remove_file(&first).expect("remove stale journal");
		let stale = select_journal_path(sessions, None, None, true, false, Some("terminal-a"))
			.expect("stale fallback");
		assert_ne!(stale, first);
		assert!(!stale.exists());
		assert_eq!(stale.parent(), Some(sessions));
	}

	#[test]
	fn startup_fork_copies_to_a_fresh_project_journal() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let source = scratch.path().join("source.oms");
		std::fs::write(&source, b"authoritative branch").expect("source");
		std::fs::create_dir_all(scratch.path().join("source/local")).expect("local root");
		std::fs::write(scratch.path().join("source/local/plan.md"), b"branch-local")
			.expect("local artifact");
		let fork = select_journal_path(
			scratch.path(),
			None,
			Some(std::path::Path::new("source")),
			false,
			false,
			None,
		)
		.expect("fork");
		assert_ne!(fork, source);
		assert_eq!(std::fs::read(&fork).expect("fork bytes"), b"authoritative branch");
		let fork_local = session_local_tree(&fork).expect("fork local root");
		assert_eq!(
			std::fs::read(fork_local.join("local/plan.md")).expect("fork local artifact"),
			b"branch-local"
		);
	}

	#[test]
	fn ephemeral_cleanup_removes_the_private_journal_and_blob_namespace() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let path =
			select_journal_path(scratch.path(), None, None, false, true, None).expect("private path");
		let root = path.parent().expect("private root").to_path_buf();
		let cleanup = EphemeralJournal { root: root.clone() };
		assert!(root.is_dir(), "selector atomically reserves the owned directory");
		assert_ne!(root, scratch.path());
		std::fs::create_dir_all(root.join("blobs/aa/bb")).expect("blob directories");
		std::fs::create_dir_all(root.join("local")).expect("local directory");
		std::fs::write(&path, b"private transcript").expect("journal");
		std::fs::write(root.join("blobs/aa/bb/content"), b"private media").expect("media");
		std::fs::write(root.join("local/paste.md"), b"private local artifact").expect("local");

		drop(cleanup);

		assert!(!root.exists(), "the no-session namespace must not leak");
	}

	#[test]
	fn prompt_overrides_are_journaled_as_prompt_facts() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let path = scratch.path().join("prompt.oms");
		let mut session =
			omp_session::Session::create(path, omp_session::ComponentRegistry::standard())
				.expect("session");
		let overrides = PromptOverrides {
			custom_prompt: Some(omp_core::Str::new_static("custom")),
			append_prompt: Some(omp_core::Str::new_static("append")),
			include_model: Some(false),
			null_prompt: true,
			..PromptOverrides::default()
		};
		install_prompt_facts(
			&mut session,
			scratch.path(),
			"provider/model",
			&overrides,
			&crate::discovery::PromptFacts::default(),
			true,
		)
		.expect("prompt facts");
		let value = session
			.dom()
			.get(session.dom().meta())
			.and_then(|meta| {
				meta.prop(&omp_dom::PropKey::Custom(omp_core::Str::new_static("prompt-facts")))
			})
			.expect("prompt facts prop");
		let omp_dom::Value::Json(raw) = value else {
			panic!("prompt facts are structured JSON");
		};
		let facts: serde_json::Value = serde_json::from_str(raw.get()).expect("facts JSON");
		assert_eq!(facts["custom_prompt"], "custom");
		assert_eq!(facts["append_prompt"], "append");
		assert_eq!(facts["include_model"], false);
		assert_eq!(facts["null_prompt"], true);
		assert_eq!(facts["device_guidance"], omp_tools::device::PROMPT_GUIDANCE);
		assert_eq!(facts["auto_qa_guidance"], omp_tools::device::AUTO_QA_PROMPT_GUIDANCE,);
	}

	#[test]
	fn discovered_material_round_trips_through_prompt_facts_and_session_home() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let path = scratch.path().join("facts.oms");
		let mut session =
			omp_session::Session::create(path, omp_session::ComponentRegistry::standard())
				.expect("session");
		let discovered = crate::discovery::PromptFacts {
			skills:             vec![serde_json::json!({ "name": "tla", "description": "TLA" })],
			context_files:      vec![
				serde_json::json!({ "origin": "/p/AGENTS.md", "content": "ctx" }),
			],
			always_apply_rules: vec![serde_json::json!({ "name": "RULES", "content": "sticky" })],
			rules:              vec![
				serde_json::json!({ "name": "style", "description": "d", "globs": ["*.rs"] }),
			],
			active_repository:  Some(crate::discovery::active_repo::ActiveRepository {
				relative_root: std::path::PathBuf::from("omp"),
			}),
		};
		install_prompt_facts(
			&mut session,
			scratch.path(),
			"provider/model",
			&PromptOverrides::default(),
			&discovered,
			true,
		)
		.expect("prompt facts");
		let props = omp_agent::prompt::template_props(session.dom());
		for key in ["skills", "context_files", "always_apply_rules", "rules", "active_repository"] {
			assert!(
				props.get(key).is_some_and(omp_scribe::Value::is_truthy),
				"{key} reaches the template props"
			);
		}
		assert_eq!(super::journaled_prompt_facts(&session), discovered, "facts read back for /new");
		use omp_proto::thread::v1::{item, part};
		let rendered = omp_agent::prompt::CanonicalPromptSource
			.system_items(session.dom())
			.expect("system prompt")
			.into_iter()
			.filter_map(|item| match item.kind {
				Some(item::Kind::Message(message)) => Some(message.parts),
				_ => None,
			})
			.flatten()
			.filter_map(|part| match part.kind {
				Some(part::Kind::Text(text)) => Some(text),
				_ => None,
			})
			.collect::<Vec<_>>()
			.join("\n");
		assert!(
			rendered.contains("Exactly one direct-child git repo detected: `omp`"),
			"active-repo.md names the nested repository:\n{rendered}"
		);
	}

	/// A child session resumed from the main chat (`/resume` opens it through
	/// the chat's [`SessionHome`]) journals rule facts for its own class, and
	/// the kernel's `rule://` scope follows the switch.
	#[tokio::test]
	async fn resumed_child_session_scopes_rules_to_its_journaled_agent() {
		use std::fs;

		use omp_agent::SessionStateBridge as _;
		use omp_core::Str;
		use omp_session::{ComponentRegistry, Session};
		use omp_tools::read::selector::ParsedSelector;

		use super::SessionHome;
		use crate::{
			discovery::rules::{ActiveRules, Level, Rule, RuleScope},
			subagent::{AgentName, MAIN_AGENT, journal_agent},
		};

		let scratch = tempfile::tempdir().expect("tempdir");
		let sessions_dir = scratch.path().join("sessions");
		fs::create_dir_all(&sessions_dir).expect("sessions dir");
		let rule = |name: &'static str, agents: &[&'static str]| Rule {
			name:           Str::new_static(name),
			path:           scratch.path().join(format!("{name}.md")),
			content:        Str::new_static(name),
			description:    None,
			globs:          Vec::new(),
			always_apply:   true,
			condition:      Vec::new(),
			scope:          Vec::new(),
			interrupt_mode: None,
			agents:         agents.iter().copied().map(Str::new_static).collect(),
			provider:       Str::new_static("native"),
			level:          Level::Project,
		};
		let rules = Arc::new(ActiveRules {
			rules:    vec![
				rule("everyone", &[]),
				rule("main-only", &["main"]),
				rule("scout-only", &["scout"]),
				rule("not-scout", &["!scout"]),
			],
			warnings: Vec::new(),
		});
		let scope = Arc::new(RuleScope::new(Arc::clone(&rules), MAIN_AGENT.to_owned()));
		let always_apply = |session: &Session| {
			super::journaled_prompt_facts(session)
				.always_apply_rules
				.iter()
				.filter_map(|row| row["name"].as_str().map(str::to_owned))
				.collect::<Vec<_>>()
		};

		// The child composed as `scout` journaled its class.
		let child_path = sessions_dir.join("child.oms");
		{
			let mut child =
				Session::create(&child_path, ComponentRegistry::standard()).expect("child");
			journal_agent(&mut child, AgentName::from_ref("scout"), 1).expect("journal agent");
			journal_agent(&mut child, AgentName::from_ref("scout"), 1).expect("idempotent");
			assert_eq!(crate::subagent::journaled_depth(child.dom()), Some(1));
		}

		let main_facts = crate::discovery::PromptFacts {
			always_apply_rules: rules.prompt_facts(MAIN_AGENT).always_apply,
			..crate::discovery::PromptFacts::default()
		};
		let home = SessionHome {
			sessions_dir:    sessions_dir.clone(),
			idle_subscribe:  None,
			ask:             None,
			project_root:    scratch.path().to_path_buf(),
			model:           Str::new_static("provider/model"),
			prompt:          PromptOverrides::default(),
			facts:           main_facts,
			live:            Arc::new(crate::sessions::SessionRegistry::new()),
			tools_enabled:   false,
			up:              flume::unbounded().0,
			turn_activity:   Arc::default(),
			rules:           None,
			workspace_trust: None,
		}
		.with_rules(Arc::clone(&scope));

		let resumed = home.open(&child_path).expect("resume child");
		assert_eq!(
			crate::subagent::journaled_agent(resumed.dom())
				.as_deref()
				.map(AgentName::as_str),
			Some("scout")
		);
		assert_eq!(always_apply(&resumed), ["everyone", "scout-only"], "child rules, not main's");
		assert_eq!(
			super::kernel_agent(None, resumed.dom()).as_str(),
			"scout",
			"`--resume` of the child composes as its journaled class"
		);
		assert_eq!(
			super::kernel_agent(Some(AgentName::from_ref("task")), resumed.dom()).as_str(),
			"task",
			"an explicit composition class wins"
		);

		// The session switch resyncs the kernel's `rule://` scope.
		scope.resync(resumed.dom());
		assert_eq!(scope.agent(), "scout");
		let resolver = scope.resolver();
		assert!(
			resolver
				.read("scout-only", &ParsedSelector::None)
				.await
				.is_ok()
		);
		assert!(
			resolver
				.read("main-only", &ParsedSelector::None)
				.await
				.is_err()
		);

		// `/new` from there is a main session again.
		let fresh = home.create(None).expect("new session");
		assert_eq!(crate::subagent::journaled_agent(fresh.dom()), None);
		assert_eq!(always_apply(&fresh), ["everyone", "main-only", "not-scout"]);
		scope.resync(fresh.dom());
		assert_eq!(scope.agent(), "main");
		assert!(
			resolver
				.read("main-only", &ParsedSelector::None)
				.await
				.is_ok()
		);
	}

	#[test]
	fn cwd_inside_a_repository_journals_no_active_repository() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let path = scratch.path().join("facts.oms");
		let mut session =
			omp_session::Session::create(path, omp_session::ComponentRegistry::standard())
				.expect("session");
		install_prompt_facts(
			&mut session,
			scratch.path(),
			"provider/model",
			&PromptOverrides::default(),
			&crate::discovery::PromptFacts::default(),
			true,
		)
		.expect("prompt facts");
		let props = omp_agent::prompt::template_props(session.dom());
		assert!(
			props.get("active_repository").is_none(),
			"an unresolved repository never reaches the template (a null would render active-repo.md)"
		);
		assert_eq!(super::journaled_prompt_facts(&session).active_repository, None);
	}

	#[test]
	fn no_rules_and_no_context_files_yield_empty_material() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let project = scratch.path().join("proj");
		std::fs::create_dir_all(project.join(".omp/rules")).expect("rules dir");
		std::fs::create_dir_all(project.join(".git")).expect("repo root");
		std::fs::write(project.join(".omp/rules/one.md"), "---\nalwaysApply: true\n---\nbody\n")
			.expect("rule");
		std::fs::write(project.join("AGENTS.md"), "context\n").expect("context file");

		// The developer's own `<config root>` may hold user-level material;
		// only the scratch project's files are asserted.
		use crate::discovery::rules::Level;
		let project_files = |files: &crate::discovery::rules::ContextFiles| {
			files
				.files
				.iter()
				.filter(|file| file.level == Level::Project)
				.count()
		};
		let project_rules = |rules: &crate::discovery::rules::ActiveRules| {
			rules
				.rules
				.iter()
				.filter(|rule| rule.level == Level::Project)
				.count()
		};
		let (files, rules) = super::discover_prompt_material(
			&project,
			&PromptOverrides::default(),
			&Default::default(),
		)
		.expect("discovery");
		assert_eq!(project_files(&files), 1);
		assert_eq!(project_rules(&rules), 1);

		let no_rules = PromptOverrides { include_rules: false, ..PromptOverrides::default() };
		let (files, rules) =
			super::discover_prompt_material(&project, &no_rules, &Default::default())
				.expect("discovery");
		assert_eq!(project_files(&files), 1, "--no-rules leaves context files alone");
		assert!(rules.rules.is_empty(), "--no-rules suppresses rule discovery");

		let no_context =
			PromptOverrides { include_context_files: false, ..PromptOverrides::default() };
		let (files, rules) =
			super::discover_prompt_material(&project, &no_context, &Default::default())
				.expect("discovery");
		assert!(files.files.is_empty(), "--no-context-files suppresses context files");
		assert_eq!(project_rules(&rules), 1);
	}

	/// `forced_choice_free` is a statement about cost, not capability, so the
	/// penalty is what the selection has to turn on. Both models here declare
	/// named choice; only the declared penalty separates them, which is the
	/// whole of the fact ADR 0019's soft escalation reads.
	#[test]
	fn forced_choice_capability_does_not_claim_penalty_free_routing() {
		let catalog = Catalog::embedded();
		let claude_with_penalty = |declares_penalty: bool| {
			catalog.models().iter().find(move |model| {
				model.key.as_str().contains("claude")
					&& catalog
						.wire_policy(&model.wire_policy)
						.is_some_and(|policy| {
							policy.tool.forced_choice == Some(true)
								&& policy.tool.named_choice == Some(true)
								&& policy.tool.forced_choice_penalty.is_some() == declares_penalty
						})
			})
		};

		let paid = claude_with_penalty(true)
			.expect("embedded Anthropic model whose forced choice declares a penalty");
		assert!(
			!route_facts(catalog, paid, None).forced_choice_free,
			"a declared penalty is not penalty-free routing, named choice notwithstanding"
		);

		let unpriced = claude_with_penalty(false)
			.expect("embedded Anthropic model whose forced choice declares no penalty");
		assert!(
			route_facts(catalog, unpriced, None).forced_choice_free,
			"named choice with no declared penalty is the one route that skips escalation"
		);
	}

	#[test]
	fn ordinary_kernel_retains_generic_yield_contract() {
		let mut registry = omp_tool::Registry::new();
		registry
			.register(
				omp_tools::yield_tool::tool(),
				omp_tool::Presentation::Hidden,
				omp_tool::Claims {
					precedence: omp_tool::Precedence::CORE,
					claimant:   omp_core::Str::new_static("omp/core"),
					replaces:   None,
				},
			)
			.expect("generic yield");
		let registry = Arc::new(registry);
		let installed =
			install_yield_contract(Arc::clone(&registry), None, None).expect("ordinary registry");
		assert!(Arc::ptr_eq(&registry, &installed));
		assert!(matches!(
			installed.live_spec("yield").expect("yield").constraint,
			omp_tool::Constraint::None
		));
	}

	#[test]
	fn workpool_yield_contract_is_child_local_and_wire_identical_for_each_batch() {
		let mut registry = omp_tool::Registry::new();
		registry
			.register(
				omp_tools::yield_tool::tool(),
				omp_tool::Presentation::Hidden,
				omp_tool::Claims {
					precedence: omp_tool::Precedence::CORE,
					claimant:   omp_core::Str::new_static("omp/core"),
					replaces:   None,
				},
			)
			.expect("generic yield");
		let original = Arc::new(registry);
		let batch = install_workpool_yield_contract(original.as_ref(), vec![
			omp_tools::yield_tool::WorkpoolItem { id: sf!("pool#1"), index: 1 },
			omp_tools::yield_tool::WorkpoolItem { id: sf!("pool#2"), index: 2 },
		])
		.expect("batch contract");
		assert!(matches!(
			original
				.live_spec("yield")
				.expect("parent yield")
				.constraint,
			omp_tool::Constraint::None
		));
		let schema: serde_json::Value =
			serde_json::from_slice(&batch.live_spec("yield").expect("child yield").schema)
				.expect("batch schema");
		assert_eq!(schema["properties"]["key"]["minimum"], 1);
		assert!(schema["properties"]["key"].get("enum").is_none());
		assert!(matches!(
			batch.live_spec("yield").expect("child yield").constraint,
			omp_tool::Constraint::None
		));
		assert_eq!(
			batch.presentation("yield").expect("child presentation"),
			omp_tool::Presentation::Slot
		);
		let next = install_workpool_yield_contract(batch.as_ref(), vec![
			omp_tools::yield_tool::WorkpoolItem { id: sf!("pool#3"), index: 1 },
		])
		.expect("next batch contract");
		// A smaller tail batch installs a rebuilt registry whose `yield`
		// declaration is byte-identical: the cached tool prefix survives it.
		assert_eq!(
			next.live_spec("yield").expect("next yield").schema,
			batch.live_spec("yield").expect("child yield").schema
		);
		assert_eq!(
			next.live_spec("yield").expect("next yield").description,
			batch.live_spec("yield").expect("child yield").description
		);
	}

	#[test]
	fn child_schema_replaces_generic_yield_before_registry_freeze() {
		let mut registry = omp_tool::Registry::new();
		registry
			.register(
				omp_tools::yield_tool::tool(),
				omp_tool::Presentation::Hidden,
				omp_tool::Claims {
					precedence: omp_tool::Precedence::CORE,
					claimant:   omp_core::Str::new_static("omp/core"),
					replaces:   None,
				},
			)
			.expect("generic yield");
		let installed = install_yield_contract(
			Arc::new(registry),
			Some(&serde_json::json!({
				"type": "object",
				"required": ["ok"],
				"properties": {"ok": {"type": "boolean"}},
			})),
			Some(omp_tools::output_schema::SchemaMode::Strict),
		)
		.expect("child yield contract");
		let spec = installed.live_spec("yield").expect("yield");
		assert!(matches!(spec.constraint, omp_tool::Constraint::Schema { priority: 100, .. }));
		assert_eq!(
			installed.presentation("yield").expect("presentation"),
			omp_tool::Presentation::Hidden
		);
		let schema: serde_json::Value =
			serde_json::from_slice(&spec.schema).expect("yield parameter schema");
		assert_eq!(
			schema["properties"]["result"]["oneOf"][0]["properties"]["data"]["anyOf"][0]["properties"]
				["ok"]["type"],
			"boolean"
		);
	}

	#[test]
	fn child_schema_installs_yield_in_an_otherwise_empty_registry() {
		let installed = install_yield_contract(
			Arc::new(omp_tool::Registry::new()),
			Some(&serde_json::json!({"type": "boolean"})),
			None,
		)
		.expect("child yield contract");
		assert_eq!(installed.live_identities().len(), 1);
		assert!(installed.live_identity("yield").is_some());
		assert!(matches!(
			installed.live_spec("yield").expect("yield").constraint,
			omp_tool::Constraint::None
		));
	}

	/// The session is registered before its owner exists, so installing an
	/// owner seam (the idle subscription channel, the UI answer route) has to
	/// patch the live handle rather than wait for a re-register.
	#[tokio::test]
	async fn installing_owner_seams_patches_the_live_handle_in_place() {
		let scratch = tempfile::tempdir().expect("scratch");
		let sessions_dir = scratch.path().join("sessions");
		std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
		let live = std::sync::Arc::new(crate::sessions::SessionRegistry::new());
		let (up, _mailbox) = flume::unbounded();
		live.register(omp_core::Str::new_static("main"), crate::sessions::KernelHandle {
			id:             crate::sessions::SessionId::new("main"),
			name:           omp_core::Str::new_static("main"),
			up:             up.clone(),
			snapshot:       std::sync::Arc::new(parking_lot::RwLock::new(
				omp_dom::Dom::new().snapshot(),
			)),
			topology:       omp_agent::SessionTopology::main(omp_core::Str::new_static("main")),
			relay:          crate::sessions::IrcRelayPolicy::default(),
			autoreply:      None,
			idle_subscribe: None,
			ask:            None,
			turn_activity:  std::sync::Arc::default(),
			project_root:   std::sync::Arc::from(scratch.path()),
		});
		let home = super::SessionHome {
			sessions_dir,
			idle_subscribe: None,
			ask: None,
			project_root: scratch.path().to_path_buf(),
			model: omp_core::Str::new_static("provider/model"),
			prompt: super::PromptOverrides::default(),
			facts: crate::discovery::PromptFacts::default(),
			live: std::sync::Arc::clone(&live),
			tools_enabled: false,
			up,
			turn_activity: std::sync::Arc::default(),
			rules: None,
			workspace_trust: None,
		};

		let (idle_tx, _idle_rx) = flume::unbounded();
		let route = crate::headless::AskRoute::new();
		let home = home.with_idle_subscribe(idle_tx).with_ask(route.clone());

		assert_eq!(live.list().len(), 1, "the handle is patched, not duplicated");
		let patched = live
			.lookup(crate::sessions::SessionId::from_ref("main"))
			.expect("the session is still registered under its id");
		assert!(patched.idle_subscribe.is_some(), "the live handle carries the seam");
		assert_eq!(patched.name.as_str(), "main", "the routing name is unchanged");
		assert!(home.idle_subscribe.is_some(), "later registrations carry it too");

		let questions = [omp_tools::ask::Question {
			id:          omp_core::Str::new_static("q"),
			question:    omp_core::Str::new_static("Pick one"),
			header:      None,
			options:     Vec::new(),
			multi:       false,
			recommended: None,
		}];
		let mut waiting = omp_tools::ask::AskPresenter::present(&route, &questions, Some("call-1"));
		assert!(futures::poll!(waiting.as_mut()).is_pending());
		for (holder, ask) in [("the live handle", patched.ask), ("a later registration", home.ask)] {
			let ask = ask.unwrap_or_else(|| panic!("{holder} lacks the ask route"));
			assert_eq!(
				ask.pending(),
				[omp_core::Str::new_static("call-1")],
				"{holder} shares the owner's route"
			);
		}
	}

	#[test]
	fn malformed_child_schema_fails_kernel_composition() {
		let result = install_yield_contract(
			Arc::new(omp_tool::Registry::new()),
			Some(&serde_json::json!(["not", "a", "schema"])),
			Some(omp_tools::output_schema::SchemaMode::Strict),
		);
		assert!(matches!(result, Err(HeadlessError::YieldSchema(_))));
	}

	#[test]
	fn unknown_tool_allow_list_is_rejected_before_kernel_construction() {
		let registry = omp_tool::Registry::new();
		let error =
			validate_tool_names(&registry, &[omp_core::Str::new_static("definitely-not-installed")])
				.expect_err("unknown tool");
		let HeadlessError::Io(error) = error else {
			panic!("tool validation is an invalid-input error");
		};
		assert!(error.to_string().contains("definitely-not-installed"));
	}

	#[test]
	fn approval_override_is_typed_in_kernel_options() {
		let options = KernelOptions {
			approval_mode: Some(omp_contract::posture::ApprovalMode::AlwaysAsk),
			..KernelOptions::default()
		};
		assert_eq!(options.approval_mode, Some(omp_contract::posture::ApprovalMode::AlwaysAsk));
	}

	/// An auxiliary call moved to its selected model keeps an explicit
	/// provider constraint; any other launch target becomes the model alone.
	#[test]
	fn an_auxiliary_retarget_keeps_an_explicit_provider() {
		let selected = ModelKey::from(GPT5);
		let constrained = omp_ai::Target::Provider {
			provider: omp_catalog::ProviderId::from("openai"),
			model:    ModelKey::from("openai/launch"),
		};
		assert_eq!(retarget(&constrained, selected.clone()), omp_ai::Target::Provider {
			provider: omp_catalog::ProviderId::from("openai"),
			model:    selected.clone(),
		});
		let unconstrained = omp_ai::Target::Model(ModelKey::from("openai/launch"));
		assert_eq!(retarget(&unconstrained, selected.clone()), omp_ai::Target::Model(selected));
	}

	/// Reflection's `@memory` selector resolves through the catalog's role
	/// chain (configured memory selectors, then `@commit`, then `@smol`) like
	/// any isolated call, and an unknown selector is a planning
	/// `TargetNotFound`.
	#[test]
	fn isolated_calls_resolve_the_memory_role_and_refuse_unknown_selectors() {
		let catalog = Catalog::embedded();
		let con = omp_con::Ctx::new();
		let memory = isolated_call_model(catalog, &con, "@memory").expect("@memory resolves");
		let commit = isolated_call_model(catalog, &con, "@commit").ok();
		let smol = isolated_call_model(catalog, &con, "@smol").ok();
		assert!(
			Some(&memory) == commit.as_ref() || Some(&memory) == smol.as_ref(),
			"with no memory selectors configured, @memory falls back to @commit or @smol: \
			 {memory:?}, commit {commit:?}, smol {smol:?}"
		);
		let unknown = isolated_call_model(catalog, &con, "no-such-model-for-reflection")
			.expect_err("an unknown selector is refused");
		assert_eq!(unknown.kind, omp_ai::ErrorKind::TargetNotFound);
	}
}
