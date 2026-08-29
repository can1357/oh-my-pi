//! Agent Client Protocol (ACP) server over newline-delimited JSON on stdio.

use std::{
	collections::{BTreeMap, BTreeSet, HashMap},
	env, fs,
	future::Future,
	io,
	io::IsTerminal as _,
	path::{Path, PathBuf},
	pin::Pin,
	sync::{Arc, Weak},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use flume::{Receiver, Sender};
use miette::{IntoDiagnostic as _, miette};
use omp_agent::{
	AgentEvent, AgentRunSummary, ApprovalBook, ApprovalDecision, ApprovalInbox, ApprovalRequest,
	ApprovalSource, ApprovalSpec, EventProvenance, EventSubscription, EventVisibility, PlanState,
	RunSettlement,
};
use omp_catalog::{ModelKey, ThinkingEffort, clamp_thinking_effort};
use omp_core::{CowBytes, Hash32, Str, ToolPath, sf};
use omp_driver::{
	headless::{
		HeadlessLaunchPolicy, HeadlessSession, HeadlessSessionOpen, HeadlessSessionOptions,
		HeadlessToolPolicy,
	},
	plan::PlanArtifactStore,
	skills::SkillInvocationKind,
};
use omp_envd::{
	docs::AcpDocumentBackend,
	exthost::lifecycle::{HeadlessLifecycleKind, HeadlessLifecycleSubscription},
	tool_shell::{AcpExecBackend, AcpExecRequest, AcpExecRun},
};
use omp_inference::call::{ContentPart, MediaInput};
use omp_proto::{
	env::v1 as env_wire,
	inference::v1::{self as inference_wire, Effort, Reasoning, part_start, turn_event},
	thread::v1::{self as thread, Blob, Item, Message, Part, Role, blob, item, part},
	ui::v1::{ui_effect, ui_request},
	value_json::value_to_json,
};
use omp_settings::manager::{SettingsManager, SettingsPaths};
use omp_storage::index::{SessionFilter, SessionIndex};
use omp_tool::{Presentation, ToolIdentity};
use omp_tools::{
	ask,
	shell::{ExecOutcome, ExecStatus, Fault as ShellFault, OutputChannel, RunEvent, Update},
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::{
	io::{AsyncBufReadExt as _, AsyncWrite, AsyncWriteExt as _, BufReader, stdin, stdout},
	sync::oneshot,
	task::{self, JoinHandle},
	time,
	time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::{
	chat_ui::commands::registry::{CommandRole, CommandRoster, CommandSurface},
	cli::{AcpArgs, turn_id},
};

const CANCEL_CLEANUP: Duration = Duration::from_secs(2);
const DELIVERY_DRAIN_PASSES: usize = 8;
const DELIVERY_DRAIN_BATCH: usize = 256;
const EMBEDDED_TEXT_LIMIT: usize = 4_000;

fn acp_model_selectors(
	catalog: &omp_catalog::snapshot::Catalog,
	settings: &omp_catalog::settings::ModelSettings,
) -> Vec<String> {
	catalog
		.models()
		.iter()
		.filter(|model| {
			omp_driver::discovery::roles::model_selector_allowed(catalog, settings, model.key.as_str())
		})
		.map(|model| model.key.as_str().to_owned())
		.collect()
}

fn acp_model_rank(
	catalog: &omp_catalog::snapshot::Catalog,
	settings: &omp_catalog::settings::ModelSettings,
	selector: &str,
) -> usize {
	let Some(model) = catalog.model(ModelKey::from_ref(selector)) else {
		return usize::MAX;
	};
	let model_id = model
		.key
		.as_str()
		.split_once('/')
		.map_or(model.key.as_str(), |(_, model)| model);
	model
		.routes
		.iter()
		.filter_map(|route| catalog.route(route))
		.filter_map(|route| settings.model_rank(route.provider.as_str(), model_id))
		.min()
		.unwrap_or(usize::MAX)
}

enum AcpPromptIntercept {
	Prompt(Str),
	Consumed,
	Retry,
	Handoff(Option<Str>),
	Exit,
}

/// Runs ACP using stdin for NDJSON requests and stdout for NDJSON responses.
pub async fn run(args: AcpArgs) -> miette::Result<()> {
	let Some(max_time) = args.max_time.map(|duration| duration.0) else {
		return run_inner(args).await;
	};
	time::timeout(max_time, run_inner(args))
		.await
		.map_err(|_| miette!("ACP mode exceeded --max-time"))?
}

async fn run_inner(args: AcpArgs) -> miette::Result<()> {
	if io::stdin().is_terminal() {
		eprintln!("warning: `omp acp` expects newline-delimited JSON on stdin");
	}
	let root = fs::canonicalize(&args.project).into_diagnostic()?;
	let home = env::var_os("HOME").map_or_else(|| root.clone(), PathBuf::from);
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let state_dir = omp_env::project_state::directory(&data_dir, &root).into_diagnostic()?;
	fs::create_dir_all(state_dir.join("sessions")).into_diagnostic()?;
	let index = Arc::new(SessionIndex::open(state_dir.join("sessions.sqlite3")).into_diagnostic()?);
	let local_root = state_dir.join("local");
	fs::create_dir_all(&local_root).into_diagnostic()?;
	let mut settings_paths = SettingsPaths::discover(&data_dir, Some(&root));
	settings_paths.overlays.extend(args.config.iter().cloned());
	let settings_manager = SettingsManager::open(settings_paths).into_diagnostic()?;
	let settings_snapshot = settings_manager.snapshot();
	let model_settings = settings_snapshot
		.project::<omp_catalog::settings::ModelSettings>()
		.into_diagnostic()?
		.get()
		.resolve_path_scopes(&root, &home);
	let mut skill_settings = settings_snapshot
		.project::<omp_driver::discovery::skills::SkillDiscoverySettings>()
		.into_diagnostic()?
		.get()
		.clone();
	if args.no_skills {
		skill_settings.enabled = false;
	}
	skill_settings
		.custom_directories
		.extend(args.skill.iter().cloned());
	let disabled_extensions =
		matches!(args.extension_launch.mode, crate::cli::InvocationExtensionMode::Disabled);
	let app_settings = settings_snapshot
		.project::<omp_driver::settings::Settings>()
		.into_diagnostic()?;
	let extension_scopes = app_settings
		.get()
		.extension_scopes(
			omp_driver::settings::workspace_extension_overlay(&root)
				.map_err(|error| miette!("{error}"))?,
		)
		.map_err(|error| miette!("{error}"))?;
	let prompt_discovery_settings = omp_driver::discovery::PromptDiscoverySettings {
		model: model_settings.clone(),
		skills: skill_settings.clone(),
		foreign: settings_snapshot
			.project::<omp_driver::discovery::foreign::ForeignContentSettings>()
			.into_diagnostic()?
			.get()
			.clone(),
		rules: settings_snapshot
			.project::<omp_driver::rulebook::RulebookSettings>()
			.into_diagnostic()?
			.get()
			.clone(),
		native: omp_driver::discovery::native::NativeDiscoveryOptions {
			explicit_roots: if disabled_extensions {
				Vec::new()
			} else {
				args.extension_launch.native_roots.clone()
			},
			root_mode: match args.extension_launch.mode {
				crate::cli::InvocationExtensionMode::Merge => {
					omp_driver::discovery::native::NativeRootMode::Merge
				},
				crate::cli::InvocationExtensionMode::ExplicitOnly
				| crate::cli::InvocationExtensionMode::Disabled => {
					omp_driver::discovery::native::NativeRootMode::ExplicitOnly
				},
			},
			skill_settings,
			prompt_templates: args.prompt_template.clone(),
			themes: args.theme.clone(),
			include_workspace: !args.extension_launch.no_workspace && !disabled_extensions,
			client_installed: Some(data_dir.join("ext/installed.toml")),
			workspace_identity: Some(omp_driver::discovery::workspace_identity(&root)),
		},
		grants: Some(omp_driver::discovery::ExtensionGrantSettings {
			path:    data_dir.join("ext/grants.toml"),
			session: Arc::from([]),
		}),
		extension_scopes,
		extension_overrides: args.extension_launch.settings.clone().into(),
	};
	let content = omp_driver::discovery::active_prompt_snapshots(
		&root,
		&args.add_dir,
		&home,
		&prompt_discovery_settings,
	)
	.content;
	let catalog_owner =
		omp_driver::registry::production_catalog(&data_dir).map_err(|error| miette!(error))?;
	let catalog = catalog_owner.as_ref();
	let roles = omp_driver::discovery::roles::resolve_launch_roles(
		catalog,
		&model_settings,
		None,
		args.smol.as_deref(),
		args.slow.as_deref(),
		args.plan.as_deref(),
	)
	.map_err(|error| miette!(error))?;
	let model = args
		.model
		.clone()
		.or_else(|| roles.primary.map(|model| Str::from(model.as_str())))
		.ok_or_else(|| miette!("acp mode requires a configured default model role"))?;
	let mut models = acp_model_selectors(catalog, &model_settings);
	models.sort_by_key(|selector| {
		(acp_model_rank(catalog, &model_settings, selector), selector.clone())
	});
	let cycle_selectors = args.models.as_ref().map_or_else(
		|| {
			model_settings
				.cycle_order
				.iter()
				.cloned()
				.collect::<Vec<_>>()
		},
		|configured| configured.0.clone(),
	);
	let mut cycle_models = cycle_selectors
		.iter()
		.filter_map(|selector| {
			omp_driver::discovery::roles::resolve_role_selector(catalog, &model_settings, selector)
				.ok()
				.map(|selected| selected.model.as_str().to_owned())
		})
		.collect::<Vec<_>>();
	cycle_models.extend(models);
	let mut seen_models = BTreeSet::new();
	cycle_models.retain(|model| seen_models.insert(model.clone()));
	let models = cycle_models;
	let session_open = if args.no_session {
		HeadlessSessionOpen::Ephemeral
	} else if args.continue_session {
		HeadlessSessionOpen::ContinueLatest
	} else if let Some(source) = args.fork.clone() {
		HeadlessSessionOpen::Fork(source)
	} else if let Some(source) = args.resume.clone() {
		HeadlessSessionOpen::Resume(source)
	} else {
		HeadlessSessionOpen::New
	};
	let tool_policy = if args.no_tools {
		HeadlessToolPolicy::None
	} else if let Some(tools) = args.tools.as_ref() {
		HeadlessToolPolicy::Only(tools.0.clone().into_boxed_slice())
	} else {
		HeadlessToolPolicy::All
	};
	let launch_policy = HeadlessLaunchPolicy {
		session:            session_open,
		sessions_dir:       args.session_dir.clone(),
		tools:              tool_policy,
		lsp_enabled:        !args.no_lsp,
		auto_thinking:      None,
		native_discovery:   prompt_discovery_settings.native.clone(),
		extension_specs:    Arc::from(args.extension_launch.trusted.clone()),
		contributed_values: Arc::from(args.extension_launch.contributed.clone()),
	};
	let (output_tx, output_rx) = flume::unbounded();
	let writer = tokio::spawn(write_ndjson(stdout(), output_rx));
	let runtime = Arc::new(Runtime {
		output: output_tx.clone(),
		state:  Mutex::new(State {
			initialized: false,
			data_dir,
			settings_overlays: args.config.clone().into_boxed_slice(),
			additional_roots: args.add_dir.clone().into_boxed_slice(),
			launch_policy,
			root,
			local_root,
			index,
			content,
			prompt_discovery_settings,
			sessions: HashMap::new(),
			active: HashMap::new(),
			approvals: ApprovalBook::new(),
			model: model.to_string(),
			explicit_model: args.model.clone(),
			models,
			mode: "default".into(),
			thinking: "auto".into(),
			capabilities: PeerCapabilities::default(),
			next_peer_request: 1,
			pending_peer: HashMap::new(),
			next_session_generation: 1,
			command_generation: 1,
		}),
	});
	let result = read_ndjson(Arc::clone(&runtime)).await;
	let (active, sessions) = {
		let mut state = runtime.state.lock();
		for (_, pending) in state.pending_peer.drain() {
			let _ = pending.send(Err(json!({"code":-32000,"message":"ACP peer disconnected"})));
		}
		(
			state
				.active
				.drain()
				.map(|(_, token)| token)
				.collect::<Vec<_>>(),
			state
				.sessions
				.drain()
				.map(|(_, session)| session)
				.collect::<Vec<_>>(),
		)
	};
	for token in active {
		token.cancel();
	}
	for session in sessions {
		let _ = session.close_adapters().await;
	}
	time::sleep(CANCEL_CLEANUP.min(Duration::from_millis(20))).await;
	drop(runtime);
	drop(output_tx);
	writer.await.into_diagnostic()??;
	result
}

async fn read_ndjson(runtime: Arc<Runtime>) -> miette::Result<()> {
	let mut lines = BufReader::new(stdin()).lines();
	while let Some(line) = lines.next_line().await.into_diagnostic()? {
		if line.trim().is_empty() {
			continue;
		}
		let value: Value = match serde_json::from_str(&line) {
			Ok(value) => value,
			Err(error) => {
				tracing::warn!(%error, "malformed ACP request");
				runtime.error(Value::Null, -32700, error.to_string())?;
				continue;
			},
		};
		if value.get("method").is_none() && value.get("id").is_some() {
			runtime.settle_peer_response(value);
			continue;
		}
		if value.get("method").and_then(Value::as_str) == Some("initialize") {
			runtime.dispatch(value).await?;
		} else {
			let runtime = Arc::clone(&runtime);
			tokio::spawn(async move {
				if let Err(error) = runtime.dispatch(value).await {
					tracing::warn!(%error, "ACP request dispatch failed");
				}
			});
		}
	}
	Ok(())
}

async fn write_ndjson<W: AsyncWrite + Unpin>(
	mut output: W,
	receiver: Receiver<Value>,
) -> miette::Result<()> {
	while let Ok(value) = receiver.recv_async().await {
		let mut bytes = serde_json::to_vec(&value).into_diagnostic()?;
		bytes.push(b'\n');
		output.write_all(&bytes).await.into_diagnostic()?;
		output.flush().await.into_diagnostic()?;
	}
	Ok(())
}

struct Runtime {
	output: Sender<Value>,
	state:  Mutex<State>,
}

struct State {
	initialized: bool,
	data_dir: PathBuf,
	settings_overlays: Box<[PathBuf]>,
	additional_roots: Box<[PathBuf]>,
	launch_policy: HeadlessLaunchPolicy,
	root: PathBuf,
	local_root: PathBuf,
	index: Arc<SessionIndex>,
	content: omp_driver::discovery::ActiveContentSnapshots,
	prompt_discovery_settings: omp_driver::discovery::PromptDiscoverySettings,
	sessions: HashMap<Str, Arc<AcpSession>>,
	active: HashMap<Str, CancellationToken>,
	approvals: ApprovalBook,
	model: String,
	explicit_model: Option<Str>,
	models: Vec<String>,
	mode: String,
	thinking: String,
	capabilities: PeerCapabilities,
	next_peer_request: u64,
	pending_peer: HashMap<u64, oneshot::Sender<Result<Value, Value>>>,
	next_session_generation: u64,
	command_generation: u64,
}

#[derive(Clone, Copy, Debug, Default)]
struct PeerCapabilities {
	read_text_file:  bool,
	write_text_file: bool,
	terminal:        bool,
	auth_terminal:   bool,
	elicitation:     bool,
}

struct AcpSession {
	asynchronous:     AcpSessionAsync,
	events:           EventSubscription,
	meta:             Mutex<AcpSessionMeta>,
	mapper:           Mutex<AcpEventMapper>,
	terminal_backend: AcpTerminalBackend,
	capabilities:     PeerCapabilities,
	root:             PathBuf,
	forwarders:       Mutex<Vec<JoinHandle<()>>>,
}
mod acp_session_async {
	use omp_driver::headless::HeadlessSession;
	use tokio::sync::Mutex;

	pub(super) struct AcpSessionAsync {
		pub(super) headless:   Mutex<HeadlessSession>,
		pub(super) mcp_update: Mutex<()>,
	}

	impl AcpSessionAsync {
		pub(super) fn new(headless: HeadlessSession) -> Self {
			Self { headless: Mutex::new(headless), mcp_update: Mutex::new(()) }
		}
	}
}
use acp_session_async::AcpSessionAsync;

#[derive(Clone)]
struct AcpDocumentBridge {
	runtime:    Weak<Runtime>,
	session_id: Str,
}

#[derive(Clone)]
struct AcpAskPresenter {
	runtime:    Weak<Runtime>,
	session_id: Str,
}

impl omp_tools::ask::AskPresenter for AcpAskPresenter {
	fn present<'p>(
		&'p self,
		questions: &'p [omp_tools::ask::Question],
	) -> Pin<Box<dyn Future<Output = Result<omp_tools::ask::Presentation, ask::Fault>> + Send + 'p>>
	{
		let runtime = self.runtime.upgrade();
		Box::pin(async move {
			let runtime = runtime.ok_or_else(|| ask_fault("ACP peer disconnected"))?;
			let params = ask_elicitation_params(&self.session_id, questions);
			let response = runtime
				.peer_request("session/unstable_createElicitation", params)
				.await
				.map_err(|error| ask::Fault::Presenter { message: Str::from(error.to_string()) })?;
			let accepted = response.get("action").and_then(Value::as_str) == Some("accept");
			let content = response.get("content").and_then(Value::as_object);
			if !accepted || content.is_none() {
				return Err(ask_fault("Ask dialog was dismissed"));
			}
			Ok(omp_tools::ask::Presentation {
				answers:  ask_answers(questions, content.expect("checked form content")),
				headless: false,
			})
		})
	}
}

impl AcpDocumentBackend for AcpDocumentBridge {
	fn read_text(
		&self,
		absolute_path: Str,
	) -> Pin<Box<dyn Future<Output = miette::Result<Str>> + Send + '_>> {
		Box::pin(async move {
			let runtime = self
				.runtime
				.upgrade()
				.ok_or_else(|| miette!("ACP peer disconnected"))?;
			let value = runtime
				.peer_operation(&self.session_id, &RemoteOperation::ReadText {
					path:  absolute_path,
					line:  None,
					limit: None,
				})
				.await?;
			value
				.get("content")
				.and_then(Value::as_str)
				.map(Str::from)
				.ok_or_else(|| miette!("ACP read response has no UTF-8 content"))
		})
	}

	fn write_text(
		&self,
		absolute_path: Str,
		content: Str,
	) -> Pin<Box<dyn Future<Output = miette::Result<Str>> + Send + '_>> {
		Box::pin(async move {
			let runtime = self
				.runtime
				.upgrade()
				.ok_or_else(|| miette!("ACP peer disconnected"))?;
			runtime
				.peer_operation(&self.session_id, &RemoteOperation::WriteText {
					path: absolute_path.clone(),
					content,
				})
				.await?;
			let value = runtime
				.peer_operation(&self.session_id, &RemoteOperation::ReadText {
					path:  absolute_path,
					line:  None,
					limit: None,
				})
				.await?;
			value
				.get("content")
				.and_then(Value::as_str)
				.map(Str::from)
				.ok_or_else(|| miette!("ACP write read-back has no UTF-8 content"))
		})
	}
}

struct AcpSessionMeta {
	title:              Option<Str>,
	model:              String,
	mode:               String,
	thinking:           String,
	replay:             Vec<Value>,
	mcp_servers:        Value,
	mcp_mounts:         SessionMcpMountSet,
	session_generation: u64,
}

impl AcpSession {
	async fn close_adapters(&self) -> miette::Result<()> {
		for task in self.forwarders.lock().drain(..) {
			task.abort();
		}
		let _update = self.asynchronous.mcp_update.lock().await;
		self.terminal_backend.close_all().await;
		let (client, mut mounts) = {
			let headless = self.asynchronous.headless.lock().await;
			headless.bind_acp_exec(None);
			headless.bind_acp_documents(None);
			headless.bind_approval_authority(None, None);
			(headless.env().clone(), self.meta.lock().mcp_mounts.clone())
		};
		mounts.clear(&client).await?;
		self.meta.lock().mcp_mounts = mounts;
		Ok(())
	}
}

#[derive(Clone, Debug, Default)]
struct SessionMcpMountSet {
	generation: u64,
	mounted:    BTreeMap<Str, Str>,
}

impl SessionMcpMountSet {
	async fn replace(
		&mut self,
		env: &omp_env::EnvClient,
		session_id: &str,
		servers: &Value,
	) -> miette::Result<Vec<Value>> {
		let declarations = mcp_declarations(servers)?;
		let mut persisted = env
			.mcp_config(env_wire::McpConfigRequest {
				action: env_wire::McpConfigAction::List as i32,
				scope: env_wire::McpConfigScope::Unspecified as i32,
				wire_revision: omp_proto::SCHEMA_REV,
				..env_wire::McpConfigRequest::default()
			})
			.await
			.into_diagnostic()?
			.entries
			.into_iter()
			.filter(|entry| entry.scope == env_wire::McpConfigScope::Project as i32)
			.map(|entry| Str::from(entry.name))
			.collect::<BTreeSet<_>>();
		let next_generation = self.generation.wrapping_add(1).max(1);
		let mut next = BTreeMap::new();
		let session_prefix = scoped_mcp_prefix(session_id);
		for (name, config) in declarations {
			let mounted = scoped_mcp_name(session_id, &name);
			let action = if persisted.contains(&mounted) {
				env_wire::McpConfigAction::Update
			} else {
				env_wire::McpConfigAction::Add
			};
			env.mcp_config(env_wire::McpConfigRequest {
				action:        action as i32,
				scope:         env_wire::McpConfigScope::Project as i32,
				name:          mounted.to_string(),
				server_json:   serde_json::to_vec(&config).into_diagnostic()?.into(),
				wire_revision: omp_proto::SCHEMA_REV,
			})
			.await
			.into_diagnostic()?;
			persisted.insert(mounted.clone());
			next.insert(name, mounted);
		}
		for mounted in persisted
			.iter()
			.filter(|mounted| mounted.starts_with(&session_prefix))
			.cloned()
			.collect::<Vec<_>>()
		{
			if next.values().any(|candidate| candidate == &mounted) {
				continue;
			}
			env.mcp_config(env_wire::McpConfigRequest {
				action:        env_wire::McpConfigAction::Remove as i32,
				scope:         env_wire::McpConfigScope::Project as i32,
				name:          mounted.to_string(),
				server_json:   Bytes::new(),
				wire_revision: omp_proto::SCHEMA_REV,
			})
			.await
			.into_diagnostic()?;
		}
		let _ = env
			.mcp_status(env_wire::McpStatusRequest {
				name:          None,
				wire_revision: omp_proto::SCHEMA_REV,
			})
			.await
			.into_diagnostic()?;
		self.generation = next_generation;
		self.mounted = next;
		Ok(self
			.mounted
			.iter()
			.map(|(logical, mounted)| {
				json!({"name":logical,"mountedName":mounted,"uri":format!("mcp://{mounted}/")})
			})
			.collect())
	}

	async fn clear(&mut self, env: &omp_env::EnvClient) -> miette::Result<()> {
		for mounted in self.mounted.values() {
			let _ = env
				.mcp_config(env_wire::McpConfigRequest {
					action:        env_wire::McpConfigAction::Remove as i32,
					scope:         env_wire::McpConfigScope::Project as i32,
					name:          mounted.to_string(),
					server_json:   Bytes::new(),
					wire_revision: omp_proto::SCHEMA_REV,
				})
				.await;
		}
		self.mounted.clear();
		self.generation = self.generation.wrapping_add(1).max(1);
		Ok(())
	}
}

#[derive(Clone)]
struct AcpTerminalBackend {
	runtime:    Weak<Runtime>,
	session_id: Str,
	generation: u64,
	live:       Arc<Mutex<HashMap<Str, u64>>>,
}

#[derive(Clone, Debug, Default)]
struct TerminalSnapshot {
	output:    Str,
	truncated: bool,
	exit:      Option<TerminalExit>,
}

#[derive(Clone, Debug)]
struct TerminalExit {
	exit_code: Option<i32>,
	signal:    Option<Str>,
}

impl AcpTerminalBackend {
	fn new(runtime: Weak<Runtime>, session_id: Str, generation: u64) -> Self {
		Self { runtime, session_id, generation, live: Arc::new(Mutex::new(HashMap::new())) }
	}

	async fn execute(
		&self,
		command: Str,
		cwd: Option<Str>,
		env: BTreeMap<Str, Str>,
		output_byte_limit: u64,
		timeout: Option<Duration>,
		cancel: CancellationToken,
		events: Option<&Sender<Result<RunEvent, ShellFault>>>,
	) -> miette::Result<()> {
		let runtime = self
			.runtime
			.upgrade()
			.ok_or_else(|| miette!("ACP peer disconnected"))?;
		let operation = RemoteOperation::shell(command, cwd, env, output_byte_limit);
		let create_runtime = Arc::clone(&runtime);
		let create_session = self.session_id.clone();
		let mut create = tokio::spawn(async move {
			create_runtime
				.peer_operation(&create_session, &operation)
				.await
				.and_then(terminal_id)
		});
		let terminal_id = if let Some(limit) = timeout {
			tokio::select! {
				result = &mut create => result.into_diagnostic()??,
				() = cancel.cancelled() => {
					self.cleanup_late_create(create);
					return Err(miette!("ACP terminal execution was cancelled before creation"));
				},
				() = time::sleep(limit) => {
					self.cleanup_late_create(create);
					return Err(miette!("ACP terminal creation timed out"));
				},
			}
		} else {
			tokio::select! {
				result = &mut create => result.into_diagnostic()??,
				() = cancel.cancelled() => {
					self.cleanup_late_create(create);
					return Err(miette!("ACP terminal execution was cancelled before creation"));
				},
			}
		};
		self
			.live
			.lock()
			.insert(terminal_id.clone(), self.generation);
		let exec_id = Bytes::copy_from_slice(terminal_id.as_str().as_bytes());
		if let Some(events) = events {
			let _ = events.send(Ok(RunEvent::Started { exec_id: exec_id.clone() }));
		}
		let started = Instant::now();
		let mut last = TerminalSnapshot::default();
		let mut delivered = String::new();
		let mut sequence = 0;
		loop {
			let elapsed = started.elapsed();
			let timed_out = timeout.is_some_and(|limit| elapsed >= limit);
			if cancel.is_cancelled() || timed_out {
				self.kill_bounded(&runtime, &terminal_id).await;
				last = self.snapshot_bounded(&runtime, &terminal_id, last).await;
				if let Some(events) = events {
					emit_terminal_delta(events, &exec_id, &last.output, &mut delivered, &mut sequence);
					let _ = events.send(Ok(RunEvent::Exit(ExecStatus {
						outcome:            if cancel.is_cancelled() {
							ExecOutcome::Cancelled
						} else {
							ExecOutcome::Timeout
						},
						exit_code:          last
							.exit
							.as_ref()
							.and_then(|status| status.exit_code)
							.or(Some(137)),
						signal:             last.exit.as_ref().and_then(|status| status.signal.clone()),
						wall_clock_ms:      started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
						spilled_output:     None,
						aborted:            cancel.is_cancelled(),
						effects_unknown:    false,
						final_cwd_uri:      None,
						final_cwd_revision: 0,
					})));
				}
				self.release_bounded(&runtime, &terminal_id).await;
				self.live.lock().remove(&terminal_id);
				return Ok(());
			}
			let wait = timeout
				.and_then(|limit| limit.checked_sub(elapsed))
				.map_or(Duration::from_millis(250), |remaining| {
					remaining.min(Duration::from_millis(250))
				});
			tokio::select! {
				() = cancel.cancelled() => continue,
				() = time::sleep(wait) => {},
			}
			last = self.snapshot_bounded(&runtime, &terminal_id, last).await;
			if let Some(events) = events {
				emit_terminal_delta(events, &exec_id, &last.output, &mut delivered, &mut sequence);
			}
			if let Some(status) = &last.exit {
				if last.truncated {
					tracing::warn!(terminal_id = %terminal_id, "ACP terminal output was truncated by the client");
				}
				let exit_code = status
					.exit_code
					.or_else(|| status.signal.as_ref().map(|_| 137));
				if let Some(events) = events {
					let _ = events.send(Ok(RunEvent::Exit(ExecStatus {
						outcome: ExecOutcome::Exited,
						exit_code,
						signal: status.signal.clone(),
						wall_clock_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
						spilled_output: None,
						aborted: false,
						effects_unknown: false,
						final_cwd_uri: None,
						final_cwd_revision: 0,
					})));
				}
				self.release_bounded(&runtime, &terminal_id).await;
				self.live.lock().remove(&terminal_id);
				return Ok(());
			}
		}
	}

	fn cleanup_late_create(&self, create: JoinHandle<miette::Result<Str>>) {
		let backend = self.clone();
		tokio::spawn(async move {
			let Ok(Ok(terminal_id)) = create.await else {
				return;
			};
			let Some(runtime) = backend.runtime.upgrade() else {
				return;
			};
			backend.kill_bounded(&runtime, &terminal_id).await;
			backend.release_bounded(&runtime, &terminal_id).await;
		});
	}

	async fn snapshot_bounded(
		&self,
		runtime: &Runtime,
		terminal_id: &Str,
		fallback: TerminalSnapshot,
	) -> TerminalSnapshot {
		let operation = RemoteOperation::PollTerminal { terminal_id: terminal_id.clone() };
		match time::timeout(
			Duration::from_secs(2),
			runtime.peer_operation(&self.session_id, &operation),
		)
		.await
		{
			Ok(Ok(value)) => terminal_snapshot(value).unwrap_or(fallback),
			_ => fallback,
		}
	}

	async fn kill_bounded(&self, runtime: &Runtime, terminal_id: &Str) {
		let operation = RemoteOperation::KillTerminal { terminal_id: terminal_id.clone() };
		let _ = time::timeout(
			Duration::from_secs(1),
			runtime.peer_operation(&self.session_id, &operation),
		)
		.await;
	}

	async fn release_bounded(&self, runtime: &Runtime, terminal_id: &Str) {
		let operation = RemoteOperation::ReleaseTerminal { terminal_id: terminal_id.clone() };
		let _ = time::timeout(
			Duration::from_secs(1),
			runtime.peer_operation(&self.session_id, &operation),
		)
		.await;
	}

	async fn close_all(&self) {
		let Some(runtime) = self.runtime.upgrade() else {
			self.live.lock().clear();
			return;
		};
		let terminals = self.live.lock().keys().cloned().collect::<Vec<_>>();
		for terminal_id in terminals {
			self.kill_bounded(&runtime, &terminal_id).await;
			let _ = self
				.snapshot_bounded(&runtime, &terminal_id, TerminalSnapshot::default())
				.await;
			self.release_bounded(&runtime, &terminal_id).await;
			self.live.lock().remove(&terminal_id);
		}
	}
}

fn emit_terminal_delta(
	events: &Sender<Result<RunEvent, ShellFault>>,
	exec_id: &Bytes,
	output: &str,
	delivered: &mut String,
	sequence: &mut u64,
) {
	let delta = output.strip_prefix(delivered.as_str()).unwrap_or(output);
	if delta.is_empty() {
		return;
	}
	*sequence = sequence.saturating_add(1);
	let _ = events.send(Ok(RunEvent::Output(Update {
		channel:  OutputChannel::Stdout,
		data:     CowBytes::owned(Bytes::copy_from_slice(delta.as_bytes())),
		sequence: *sequence,
		exec_id:  exec_id.clone(),
		started:  false,
		terminal: false,
	})));
	delivered.clear();
	delivered.push_str(output);
}

impl AcpExecBackend for AcpTerminalBackend {
	fn run(
		&self,
		request: AcpExecRequest,
	) -> Pin<Box<dyn Future<Output = Result<AcpExecRun, ShellFault>> + Send + '_>> {
		Box::pin(async move {
			let (events_tx, events_rx) = flume::unbounded();
			let cancel = CancellationToken::new();
			let execution_cancel = cancel.clone();
			let backend = self.clone();
			tokio::spawn(async move {
				let result = backend
					.execute(
						request.command,
						request.cwd,
						request.env,
						8 * 1024 * 1024,
						request.timeout_ms.map(Duration::from_millis),
						execution_cancel,
						Some(&events_tx),
					)
					.await;
				if let Err(error) = result {
					let _ = events_tx.send(Err(ShellFault::Resource {
						operation: sf!("acp_terminal"),
						message:   Str::from(error.to_string()),
					}));
				}
			});
			Ok(AcpExecRun { events: events_rx, cancel })
		})
	}
}

#[derive(Default)]
struct AcpEventMapper {
	parts:               BTreeMap<u32, part_start::Kind>,
	tools:               HashMap<Str, AcpToolState>,
	assistant_text:      String,
	terminal_fault_seen: bool,
	registry:            Option<Arc<omp_tool::Registry>>,
	usage:               Option<Value>,
}

struct AcpToolState {
	identity:     ToolIdentity,
	path:         Option<ToolPath>,
	visibility:   EventVisibility,
	provenance:   EventProvenance,
	presentation: Option<Presentation>,
	args:         Vec<u8>,
}

impl AcpEventMapper {
	fn map(&mut self, event: &AgentEvent, root: &Path) -> Vec<Value> {
		match event {
			AgentEvent::Snapshot(snapshot) => {
				self.registry = Some(Arc::clone(&snapshot.registry));
				Vec::new()
			},
			AgentEvent::Turn { event, .. } => self.map_turn(event),
			AgentEvent::ToolObserved { call_id, identity, path, visibility, provenance, .. } => {
				let presentation = self
					.registry
					.as_ref()
					.and_then(|registry| registry.presentation(identity.name.as_str()).ok());
				self.tools.insert(call_id.clone(), AcpToolState {
					identity: identity.clone(),
					path: path.clone(),
					visibility: *visibility,
					provenance: *provenance,
					presentation,
					args: Vec::new(),
				});
				Vec::new()
			},
			AgentEvent::ToolOpened { call_id, name, .. } => {
				let Some(tool) = self.tools.get(call_id) else {
					return Vec::new();
				};
				if !visible_tool(tool) {
					return Vec::new();
				}
				vec![json!({
					"sessionUpdate":"tool_call",
					"toolCallId":call_id,
					"title":name,
					"kind":tool_kind(tool),
					"status":"pending",
					"rawInput":{},
				})]
			},
			AgentEvent::ToolArgs { call_id, fragment, .. } => {
				let Some(tool) = self.tools.get_mut(call_id) else {
					return Vec::new();
				};
				tool.args.extend_from_slice(fragment);
				if !visible_tool(tool) {
					return Vec::new();
				}
				let args = serde_json::from_slice::<Value>(&tool.args)
					.unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&tool.args).into_owned()));
				let mut update = json!({
					"sessionUpdate":"tool_call_update",
					"toolCallId":call_id,
					"status":"in_progress",
					"rawInput":args,
				});
				if let Some(locations) = tool_locations(&args, root) {
					update["locations"] = locations;
				}
				vec![update]
			},
			AgentEvent::ToolUpdate { call_id, json: raw } => {
				let Some(tool) = self.tools.get(call_id) else {
					return Vec::new();
				};
				if !visible_tool(tool) {
					return Vec::new();
				}
				let output = serde_json::from_slice::<Value>(raw)
					.unwrap_or_else(|_| Value::String(String::from_utf8_lossy(raw).into_owned()));
				vec![tool_update(call_id, "in_progress", output, root)]
			},
			AgentEvent::ToolFinished { call_id, item, .. } => {
				let tool = self.tools.remove(call_id);
				if tool.as_ref().is_some_and(|tool| !visible_tool(tool)) {
					return Vec::new();
				}
				let Some(item::Kind::ToolResult(result)) = item.kind.as_ref() else {
					return vec![
						json!({"sessionUpdate":"tool_call_update","toolCallId":call_id,"status":"completed"}),
					];
				};
				let details = result
					.details
					.as_ref()
					.and_then(value_to_json)
					.unwrap_or(Value::Null);
				let mut update = tool_update(
					call_id,
					if result.is_error {
						"failed"
					} else {
						"completed"
					},
					details.clone(),
					root,
				);
				let content = tool_result_content(result, &details, root);
				if !content.is_empty() {
					update["content"] = Value::Array(content);
				}
				vec![update]
			},
			AgentEvent::PlanStateChanged { to, .. } => vec![plan_update(*to)],
			AgentEvent::TitleChanged { title, .. } => vec![json!({
				"sessionUpdate":"session_info_update",
				"title":title,
			})],
			AgentEvent::Failed { message, .. } => {
				self.terminal_fault_seen = true;
				vec![json!({
					"sessionUpdate":"agent_message_chunk",
					"content":{"type":"text","text":bounded_text(message.as_str())},
					"error":true,
				})]
			},
			AgentEvent::PeerRelay(_)
			| AgentEvent::RunStateChanged { .. }
			| AgentEvent::PhaseChanged { .. }
			| AgentEvent::RosterChanged { .. }
			| AgentEvent::JobRegistered { .. }
			| AgentEvent::JobSettled { .. }
			| AgentEvent::HistoryRewritten { .. } => Vec::new(),
		}
	}

	fn map_turn(&mut self, event: &inference_wire::TurnEvent) -> Vec<Value> {
		match event.event.as_ref() {
			Some(turn_event::Event::PartStart(start)) => {
				if let Ok(kind) = part_start::Kind::try_from(start.kind) {
					self.parts.insert(start.index, kind);
				}
				Vec::new()
			},
			Some(turn_event::Event::PartDelta(delta)) => {
				let text = String::from_utf8_lossy(&delta.chunk);
				match self.parts.get(&delta.index) {
					Some(part_start::Kind::Text) => {
						self.assistant_text.push_str(&text);
						vec![
							json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}),
						]
					},
					Some(part_start::Kind::Thinking) => vec![
						json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":text}}),
					],
					_ => Vec::new(),
				}
			},
			Some(turn_event::Event::PartEnd(end)) => {
				self.parts.remove(&end.index);
				Vec::new()
			},
			Some(turn_event::Event::Outcome(outcome)) => {
				let Some(usage) = outcome.usage.as_ref() else {
					return Vec::new();
				};
				let usage = json!({"input_tokens":usage.input_tokens,"output_tokens":usage.output_tokens,"cache_read_tokens":usage.cache_read_tokens,"cache_write_tokens":usage.cache_write_tokens,"total_tokens":usage.total_tokens});
				self.usage = Some(usage.clone());
				vec![json!({"sessionUpdate":"usage_update","usage":usage})]
			},
			Some(turn_event::Event::Error(error)) => {
				self.terminal_fault_seen = true;
				vec![
					json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":bounded_text(&error.detail)},"error":true}),
				]
			},
			_ => Vec::new(),
		}
	}

	fn final_delivery(&mut self, summary: &AgentRunSummary) -> Vec<Value> {
		let mut updates = Vec::new();
		if let Some(final_text) = summary.final_assistant()
			&& final_text != self.assistant_text
		{
			let missing = final_text
				.strip_prefix(&self.assistant_text)
				.unwrap_or(final_text);
			if !missing.is_empty() {
				updates.push(
					json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":missing}}),
				);
			}
			self.assistant_text.clear();
			self.assistant_text.push_str(final_text);
		}
		if summary.settlement == RunSettlement::TerminalFault && !self.terminal_fault_seen {
			updates.push(json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"The turn failed before producing a final response."},"error":true}));
			self.terminal_fault_seen = true;
		}
		updates
	}
}

impl Runtime {
	#[tracing::instrument(
		name = "acp_request",
		level = "debug",
		skip_all,
		fields(method = tracing::field::Empty)
	)]
	async fn dispatch(self: &Arc<Self>, frame: Value) -> miette::Result<()> {
		let id = frame.get("id").cloned();
		let Some(method) = frame.get("method").and_then(Value::as_str) else {
			if let Some(id) = id {
				self.error(id, -32600, "request has no method")?;
			}
			return Ok(());
		};
		tracing::Span::current().record("method", method);
		let params = frame
			.get("params")
			.and_then(Value::as_object)
			.cloned()
			.unwrap_or_default();
		if method != "initialize" && !self.state.lock().initialized {
			if let Some(id) = id {
				self.error(id, -32002, "initialize must complete before other requests")?;
			}
			return Ok(());
		}
		if method == "session/prompt" {
			let Some(id) = id else {
				return Ok(());
			};
			if let Err(error) = self.start_prompt(id.clone(), params).await {
				self.error(id, -32602, error.to_string())?;
			}
			return Ok(());
		}
		let result = match method {
			"initialize" => self.initialize(&params),
			"authenticate" => self.authenticate(&params).await,
			"session/new" => self.new_session(&params).await,
			"session/load" | "session/resume" => self.load_session(&params).await,
			"session/list" => self.list_sessions(&params),
			"session/close" => self.close_session(&params).await,
			"session/fork" => self.fork_session(&params).await,
			"session/cancel" => self.cancel(&params),
			"session/set_mode" => self.set_mode(&params).await,
			"session/set_model" => self.set_model(&params).await,
			"session/set_thinking" => self.set_thinking(&params).await,
			"session/set_config_option" => self.set_config_option(&params).await,
			"session/configure_mcp_servers" => self.configure_mcp_servers(&params).await,
			"session/elicitation" => self.elicit(&params).await,
			"session/approve" => self.approve(&params),
			"session/propose_plan" => self.propose_plan(&params).await,
			"session/reload_extensions" => {
				let session_id = Str::from(required_text(&params, "sessionId")?);
				self.reload_commands(&session_id).await?;
				Ok(json!({"generation":self.state.lock().command_generation}))
			},
			"speech.models.list" => self.speech_models().await,
			"_omp/sessions/listAll" => self.list_all_sessions(&params),
			"_omp/projects/list" => self.list_projects(),
			"_omp/chats/byCwd" => self.list_chats_by_cwd(&params),
			"_omp/usage" => self.usage(&params),
			"_omp/extensions" => self.list_extensions(),
			"_omp/extensions/toggle" => self.toggle_extension(&params).await,
			_ => Err(miette!("unknown ACP method `{method}`")),
		};
		if let Some(id) = id {
			match result {
				Ok(value) => {
					let session_id = value
						.get("sessionId")
						.and_then(Value::as_str)
						.map(Str::from);
					self.respond(id, value)?;
					if matches!(
						method,
						"session/new" | "session/load" | "session/resume" | "session/fork"
					) && let Some(session_id) = session_id
					{
						self.push_initial(&session_id)?;
						self.push_replay(&session_id)?;
					}
				},
				Err(error) => self.error(id, -32602, error.to_string())?,
			}
		}
		Ok(())
	}

	fn initialize(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let version = params
			.get("protocolVersion")
			.and_then(Value::as_u64)
			.unwrap_or(1);
		if version != 1 {
			return Err(miette!("unsupported ACP protocol version {version}"));
		}
		let mut state = self.state.lock();
		state.initialized = true;
		let client = params.get("clientCapabilities").and_then(Value::as_object);
		let fs = client
			.and_then(|value| value.get("fs"))
			.and_then(Value::as_object);
		state.capabilities = PeerCapabilities {
			read_text_file:  fs
				.and_then(|value| value.get("readTextFile"))
				.and_then(Value::as_bool)
				.unwrap_or(false),
			write_text_file: fs
				.and_then(|value| value.get("writeTextFile"))
				.and_then(Value::as_bool)
				.unwrap_or(false),
			terminal:        client
				.and_then(|value| value.get("terminal"))
				.is_some_and(|value| value.as_bool().unwrap_or(value.is_object())),
			auth_terminal:   client
				.and_then(|value| value.get("auth"))
				.and_then(Value::as_object)
				.and_then(|value| value.get("terminal"))
				.and_then(Value::as_bool)
				.unwrap_or(false),
			elicitation:     client
				.and_then(|value| value.get("elicitation"))
				.and_then(Value::as_object)
				.is_some_and(|value| value.contains_key("form")),
		};
		let auth = acp_auth_methods(state.capabilities.auth_terminal);
		Ok(json!({
			"protocolVersion":1,
			"agentInfo":{"name":"oh-my-pi","title":"Oh My Pi","version":env!("CARGO_PKG_VERSION")},
			"authMethods":auth,
			"agentCapabilities":{
				"loadSession":true,
				"sessionCapabilities":{"fork":{},"list":{},"resume":{},"close":{}},
				"promptCapabilities":{"image":true,"embeddedContext":true},
				"mcpCapabilities":{"http":true,"sse":true}
			}
		}))
	}

	async fn authenticate(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let method = required_text(params, "methodId")?;
		let terminal = self.state.lock().capabilities.auth_terminal;
		if method != "agent" && !(method == "terminal" && terminal) {
			return Err(miette!("authentication method `{method}` was not advertised"));
		}
		Ok(json!({}))
	}

	async fn new_session(self: &Arc<Self>, params: &Map<String, Value>) -> miette::Result<Value> {
		self.open_session(None, None, params).await
	}

	async fn load_session(self: &Arc<Self>, params: &Map<String, Value>) -> miette::Result<Value> {
		let source = Str::from(required_text(params, "sessionId")?);
		self.open_session(Some(source), None, params).await
	}

	async fn fork_session(self: &Arc<Self>, params: &Map<String, Value>) -> miette::Result<Value> {
		let source = Str::from(required_text(params, "sessionId")?);
		let source_session = self.session(&source)?;
		let inherited = {
			let source_meta = source_session.meta.lock();
			let mut inherited = params.clone();
			inherited.insert("modeId".into(), json!(source_meta.mode));
			inherited.insert("modelId".into(), json!(source_meta.model));
			inherited.insert("thinking".into(), json!(source_meta.thinking));
			inherited.insert("mcpServers".into(), source_meta.mcp_servers.clone());
			inherited
		};
		self.open_session(None, Some(source), &inherited).await
	}

	async fn open_session(
		self: &Arc<Self>,
		resume: Option<Str>,
		fork: Option<Str>,
		params: &Map<String, Value>,
	) -> miette::Result<Value> {
		let (
			data_dir,
			settings_overlays,
			additional_roots,
			mut launch_policy,
			default_model,
			explicit_model,
			default_mode,
			default_thinking,
			capabilities,
			generation,
		) = {
			let mut state = self.state.lock();
			let generation = state.next_session_generation;
			state.next_session_generation = generation.wrapping_add(1).max(1);
			(
				state.data_dir.clone(),
				state.settings_overlays.clone(),
				state.additional_roots.clone(),
				state.launch_policy.clone(),
				state.model.clone(),
				state.explicit_model.clone(),
				state.mode.clone(),
				state.thinking.clone(),
				state.capabilities,
				generation,
			)
		};
		let root = canonical_session_root(required_text(params, "cwd")?)?;
		let home = env::var_os("HOME").map_or_else(|| root.clone(), PathBuf::from);
		let mut paths = SettingsPaths::discover(&data_dir, Some(&root));
		paths.overlays.extend(settings_overlays.iter().cloned());
		let manager = SettingsManager::open(paths).into_diagnostic()?;
		let settings_snapshot = manager.snapshot();
		let model_settings = settings_snapshot
			.project::<omp_catalog::settings::ModelSettings>()
			.into_diagnostic()?
			.get()
			.resolve_path_scopes(&root, &home);
		let catalog_owner =
			omp_driver::registry::production_catalog(&data_dir).map_err(|error| miette!(error))?;
		let catalog = catalog_owner.as_ref();
		let resolved = omp_driver::discovery::roles::resolve_launch_roles(
			catalog,
			&model_settings,
			None,
			None,
			None,
			None,
		)
		.map_err(|error| miette!(error))?;
		let default_model = explicit_model
			.map(|model| model.to_string())
			.or_else(|| resolved.primary.map(|model| model.as_str().to_owned()))
			.unwrap_or(default_model);
		let models = acp_model_selectors(catalog, &model_settings);
		let mode = params
			.get("modeId")
			.and_then(Value::as_str)
			.unwrap_or(&default_mode);
		if !matches!(mode, "default" | "plan") {
			return Err(miette!("unknown mode `{mode}`"));
		}
		let model = params
			.get("modelId")
			.and_then(Value::as_str)
			.unwrap_or(&default_model);
		let model = Str::new(model);
		let requested = params
			.get("thinking")
			.and_then(Value::as_str)
			.unwrap_or(&default_thinking);
		let thinking = match omp_driver::chat::resolve_model_selector(catalog, model.as_str()) {
			Ok(resolved) => clamp_thinking_level(resolved.as_str(), requested)?.to_owned(),
			Err(_) => requested.to_owned(),
		};
		launch_policy.session = if let Some(source) = fork {
			HeadlessSessionOpen::Fork(source)
		} else if let Some(source) = resume {
			HeadlessSessionOpen::Resume(source)
		} else {
			launch_policy.session
		};
		let mut headless = HeadlessSession::open_with_policy(
			data_dir,
			HeadlessSessionOptions {
				project: root.clone(),
				settings_overlays,
				additional_roots,
				model: model.clone(),
				initial_regime: (mode == "plan").then_some("plan"),
				initial_prompt_slot: None,
				plan_handoff: None,
				resume: None,
				fork: None,
				py_eval: false,
				approval_mode: None,
				spawn_idle_timeout: None,
				pty_denied: false,
				credential_provider: None,
				api_key: None,
				prompt_cache_affinity: None,
				session_generation: generation,
			},
			launch_policy,
		)
		.await
		.into_diagnostic()?;
		if mode == "plan" {
			headless.publish(AgentEvent::PlanStateChanged {
				from:               PlanState::Inactive,
				to:                 PlanState::Active,
				session_generation: generation,
			});
		}
		headless.set_thinking(reasoning_for(&thinking));
		let session_id = Str::from(headless.session_id());
		if capabilities.elicitation {
			headless.bind_ask_presenter(Arc::new(AcpAskPresenter {
				runtime:    Arc::downgrade(self),
				session_id: session_id.clone(),
			}));
		}
		let replay = replay_updates(headless.initial_items(), &root);
		let events = headless
			.take_events()
			.expect("ACP session owns its lossless event stream");
		let approvals = headless
			.take_approval_inbox()
			.expect("ACP session owns its approval inbox");
		let lifecycle = headless
			.take_lifecycle_events()
			.expect("ACP session owns its extension lifecycle stream");
		let mut mounts = SessionMcpMountSet::default();
		let mcp_servers = params
			.get("mcpServers")
			.cloned()
			.unwrap_or_else(|| json!([]));
		let mounted = mounts
			.replace(headless.env(), &session_id, &mcp_servers)
			.await?;
		let terminal_backend =
			AcpTerminalBackend::new(Arc::downgrade(self), session_id.clone(), generation);
		headless.bind_acp_exec(
			capabilities
				.terminal
				.then(|| Arc::new(terminal_backend.clone()) as Arc<dyn AcpExecBackend>),
		);
		headless.bind_acp_documents(
			(capabilities.read_text_file || capabilities.write_text_file).then(|| {
				Arc::new(AcpDocumentBridge {
					runtime:    Arc::downgrade(self),
					session_id: session_id.clone(),
				}) as Arc<dyn AcpDocumentBackend>
			}),
		);
		let session = Arc::new(AcpSession {
			asynchronous: AcpSessionAsync::new(headless),
			events,
			meta: Mutex::new(AcpSessionMeta {
				title: None,
				model: model.to_string(),
				mode: mode.to_owned(),
				thinking,
				replay,
				mcp_servers,
				mcp_mounts: mounts,
				session_generation: generation,
			}),
			mapper: Mutex::new(AcpEventMapper::default()),
			terminal_backend,
			capabilities,
			root,
			forwarders: Mutex::new(Vec::new()),
		});
		let response = session_config_response(&session_id, &session.meta.lock(), &models, &mounted);
		self
			.state
			.lock()
			.sessions
			.insert(session_id.clone(), Arc::clone(&session));
		self.spawn_session_forwarders(session_id, session, approvals, lifecycle);
		Ok(response)
	}

	fn spawn_session_forwarders(
		self: &Arc<Self>,
		session_id: Str,
		session: Arc<AcpSession>,
		approvals: ApprovalInbox,
		lifecycle: HeadlessLifecycleSubscription,
	) {
		let runtime = Arc::downgrade(self);
		let approval_session = session_id.clone();
		let approval_task = tokio::spawn(async move {
			while let Ok(request) = approvals.recv().await {
				let Some(runtime) = runtime.upgrade() else {
					break;
				};
				let decision = runtime.forward_approval(&approval_session, &request).await;
				let _ = request.respond(decision);
			}
		});
		let runtime = Arc::downgrade(self);
		let lifecycle_session = session_id;
		let lifecycle_owner = Arc::clone(&session);
		let lifecycle_task = tokio::spawn(async move {
			while let Ok(event) = lifecycle.recv().await {
				let Some(runtime) = runtime.upgrade() else {
					break;
				};
				if let Err(error) = runtime
					.forward_lifecycle(&lifecycle_session, &lifecycle_owner, &event.kind)
					.await
				{
					tracing::warn!(%error, "ACP extension lifecycle forwarding failed");
				}
			}
		});
		session
			.forwarders
			.lock()
			.extend([approval_task, lifecycle_task]);
	}

	async fn forward_approval(
		&self,
		session_id: &Str,
		request: &ApprovalRequest,
	) -> ApprovalDecision {
		let title = request
			.ticket
			.reasons
			.first()
			.map_or("Tool permission", |reason| reason.title.as_str());
		let body = request
			.ticket
			.reasons
			.iter()
			.map(|reason| reason.body.as_str())
			.collect::<Vec<_>>()
			.join("\n\n");
		let subject = request
			.ticket
			.reasons
			.first()
			.map(|reason| reason.subject.as_str());
		let tool_call_id = request
			.ticket
			.invocation_id
			.as_deref()
			.unwrap_or(request.ticket.ticket_id.as_str());
		let mut tool_call = json!({
			"toolCallId":tool_call_id,
			"title":title,
			"status":"pending",
			"rawInput":{"subject":subject,"reason":body},
		});
		if let Some(path) = subject.filter(|value| Path::new(value).is_absolute()) {
			tool_call["locations"] = json!([{"path":path}]);
		}
		let response = self
			.peer_request(
				"session/request_permission",
				json!({
					"sessionId":session_id,
					"toolCall":tool_call,
					"options":[
						{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},
						{"optionId":"allow_always","name":"Always allow","kind":"allow_always"},
						{"optionId":"reject_once","name":"Reject once","kind":"reject_once"},
						{"optionId":"reject_always","name":"Always reject","kind":"reject_always"}
					]
				}),
			)
			.await;
		let option = response
			.as_ref()
			.ok()
			.and_then(|value| value.pointer("/outcome/optionId"))
			.and_then(Value::as_str);
		let approved = matches!(option, Some("allow_once" | "allow_always"));
		let scope = if matches!(option, Some("allow_always" | "reject_always")) {
			sf!("always")
		} else {
			sf!("once")
		};
		ApprovalDecision {
			approved,
			scope,
			source: if response.is_ok() {
				ApprovalSource::External
			} else {
				ApprovalSource::Unavailable
			},
			decided_by: None,
			reason: response
				.err()
				.map(|_| sf!("ACP permission peer unavailable")),
			audited: true,
		}
	}

	async fn forward_lifecycle(
		&self,
		session_id: &Str,
		session: &AcpSession,
		kind: &HeadlessLifecycleKind,
	) -> miette::Result<()> {
		match kind {
			HeadlessLifecycleKind::Activated(event) => self.update(
				session_id,
				json!({"sessionUpdate":"extension_generation_update","generation":event.generation}),
			),
			HeadlessLifecycleKind::CommandRosterInvalidated => self.refresh_commands(session_id),
			HeadlessLifecycleKind::ExtensionError { extension, error } => self.update(
				session_id,
				json!({"sessionUpdate":"extension_error","extension":extension,"message":error.to_string()}),
			),
			HeadlessLifecycleKind::UiEffect(effect) => {
				let update = match effect.kind.as_ref() {
					Some(ui_effect::Kind::SetStatus(status)) => {
						json!({"sessionUpdate":"extension_status","content":status.content.as_ref().map(|content|String::from_utf8_lossy(&content.source).into_owned())})
					},
					Some(ui_effect::Kind::SetWorking(working)) => {
						json!({"sessionUpdate":"extension_working","working":working.working,"label":working.label})
					},
					Some(ui_effect::Kind::Notify(notify)) => {
						json!({"sessionUpdate":"extension_notification","message":notify.message,"level":notify.level,"durationMs":notify.duration_ms})
					},
					Some(ui_effect::Kind::SetTitle(title)) => {
						session
							.asynchronous
							.headless
							.lock()
							.await
							.set_title(Str::from(title.title.as_str()))
							.await
							.into_diagnostic()?;
						session.meta.lock().title = Some(Str::from(title.title.as_str()));
						json!({"sessionUpdate":"session_info_update","title":title.title})
					},
					Some(ui_effect::Kind::SetProgress(progress)) => {
						json!({"sessionUpdate":"extension_progress","fraction":progress.fraction,"label":progress.label})
					},
					Some(ui_effect::Kind::OpenUrl(open)) => {
						json!({"sessionUpdate":"extension_open_url","url":open.url})
					},
					Some(_) | None => {
						json!({"sessionUpdate":"extension_ui_effect","supported":false})
					},
				};
				self.update(session_id, update)
			},
			HeadlessLifecycleKind::UiRequest(request) => {
				let Some(ui_request::Kind::Dialog(dialog)) = request.kind.as_ref() else {
					return self.update(
						session_id,
						json!({"sessionUpdate":"extension_ui_request","supported":false,"ownerInvocation":request.owner_invocation}),
					);
				};
				let content = dialog
					.content
					.as_ref()
					.map(|content| String::from_utf8_lossy(&content.source).into_owned())
					.unwrap_or_default();
				if !session.capabilities.elicitation {
					return self.update(
						session_id,
						json!({"sessionUpdate":"extension_ui_response","ownerInvocation":request.owner_invocation,"cancelled":true}),
					);
				}
				let response = self
					.peer_request("session/unstable_createElicitation", json!({
						"sessionId":session_id,
						"mode":"form",
						"message":content,
						"requestedSchema":{"type":"object","properties":{"value":{"type":"string","title":dialog.title,"enum":dialog.choices}},"required":["value"]}
					}))
					.await?;
				self.update(
					session_id,
					json!({"sessionUpdate":"extension_ui_response","ownerInvocation":request.owner_invocation,"response":response}),
				)
			},
		}
	}

	async fn reload_commands(&self, session_id: &Str) -> miette::Result<()> {
		let session = self.session(session_id)?;
		let reload = session
			.asynchronous
			.headless
			.lock()
			.await
			.extension_reload_handle();
		reload.reload().await.into_diagnostic()?;
		self.refresh_commands(session_id)
	}

	fn refresh_commands(&self, session_id: &Str) -> miette::Result<()> {
		let (commands, generation) = {
			let mut state = self.state.lock();
			let home = env::var_os("HOME").map_or_else(|| state.root.clone(), PathBuf::from);
			state.content = omp_driver::discovery::active_prompt_snapshots(
				&state.root,
				&state.additional_roots,
				&home,
				&state.prompt_discovery_settings,
			)
			.content;
			state.command_generation = state.command_generation.wrapping_add(1).max(1);
			(available_commands(&state.content, state.command_generation), state.command_generation)
		};
		self.update(
			session_id,
			json!({"sessionUpdate":"available_commands_update","availableCommands":commands,"generation":generation}),
		)
	}

	fn list_sessions(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let state = self.state.lock();
		let limit = params
			.get("limit")
			.and_then(Value::as_u64)
			.unwrap_or(100)
			.min(500) as u32;
		let page = state
			.index
			.list(&SessionFilter {
				project: Some(Str::from(state.root.to_string_lossy().into_owned())),
				limit,
				..SessionFilter::default()
			})
			.into_diagnostic()?;
		Ok(
			json!({"sessions":page.sessions.into_iter().map(|row| json!({"sessionId":row.id.0,"title":row.title,"cwd":row.cwd,"createdAt":row.created_ms,"updatedAt":row.updated_ms,"parentSessionId":row.parent.map(|id|id.0)})).collect::<Vec<_>>() }),
		)
	}

	fn list_all_sessions(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let state = self.state.lock();
		let limit = params
			.get("limit")
			.and_then(Value::as_u64)
			.unwrap_or(1_000)
			.clamp(1, 5_000) as u32;
		let page = state
			.index
			.list(&SessionFilter { limit, ..SessionFilter::default() })
			.into_diagnostic()?;
		let total = page.sessions.len();
		Ok(json!({
			"total":total,
			"sessions":page.sessions.into_iter().map(|row|json!({
				"sessionId":row.id.0,
				"title":row.title,
				"cwd":row.cwd,
				"createdAt":row.created_ms,
				"updatedAt":row.updated_ms,
				"parentSessionId":row.parent.map(|id|id.0),
			})).collect::<Vec<_>>()
		}))
	}

	fn list_projects(&self) -> miette::Result<Value> {
		let state = self.state.lock();
		let session_count = state
			.index
			.list(&SessionFilter {
				project: Some(Str::from(state.root.to_string_lossy().as_ref())),
				limit: 5_000,
				..SessionFilter::default()
			})
			.into_diagnostic()?
			.sessions
			.len();
		Ok(json!({"projects":[{
			"path":state.root,
			"name":state.root.file_name().and_then(|name|name.to_str()),
			"sessionCount":session_count
		}]}))
	}

	fn list_chats_by_cwd(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let cwd = params
			.get("cwd")
			.and_then(Value::as_str)
			.map(PathBuf::from)
			.unwrap_or_else(|| self.state.lock().root.clone());
		let state = self.state.lock();
		let page = state
			.index
			.list(&SessionFilter {
				project: Some(Str::from(cwd.to_string_lossy().as_ref())),
				limit: params
					.get("limit")
					.and_then(Value::as_u64)
					.unwrap_or(1_000)
					.clamp(1, 5_000) as u32,
				..SessionFilter::default()
			})
			.into_diagnostic()?;
		Ok(json!({"cwd":cwd,"chats":page.sessions.into_iter().map(|row|json!({
			"sessionId":row.id.0,
			"title":row.title,
			"updatedAt":row.updated_ms
		})).collect::<Vec<_>>()}))
	}

	fn usage(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let session_id = required_text(params, "sessionId")?;
		Ok(self
			.session(session_id)?
			.mapper
			.lock()
			.usage
			.clone()
			.unwrap_or_else(|| json!({"input_tokens":0,"output_tokens":0,"total_tokens":0})))
	}

	async fn speech_models(&self) -> miette::Result<Value> {
		#[cfg(feature = "local")]
		{
			use omp_inference::local::{
				ArtifactStore, LocalCancellation,
				speech_catalog::{SpeechArtifactManifests, SpeechCatalog},
			};
			let root = self.state.lock().data_dir.join("models");
			fs::create_dir_all(&root).into_diagnostic()?;
			let store = ArtifactStore::open(&root).into_diagnostic()?;
			let manifests = SpeechArtifactManifests::curated().into_diagnostic()?;
			let snapshot = SpeechCatalog
				.snapshot(&store, &manifests, &LocalCancellation::new())
				.into_diagnostic()?;
			serde_json::to_value(snapshot).into_diagnostic()
		}
		#[cfg(not(feature = "local"))]
		{
			Err(miette!(
				"speech model inspection is unavailable in this build; local speech features are \
				 disabled"
			))
		}
	}

	fn list_extensions(&self) -> miette::Result<Value> {
		use omp_ext::lock::InstalledRecord;
		let state = self.state.lock();
		let client_path = state.data_dir.join("ext/installed.toml");
		let workspace_path = state.root.join(".omp/installed.toml");
		let client = InstalledRecord::read(&client_path).map_err(|error| miette!("{error}"))?;
		let workspace = InstalledRecord::read(&workspace_path).map_err(|error| miette!("{error}"))?;
		Ok(json!({
			"generation":state.command_generation,
			"extensions":client.extensions.into_iter().map(|entry|json!({
				"id":entry.id,"enabled":entry.enabled,"scope":"user"
			})).chain(workspace.extensions.into_iter().map(|entry|json!({
				"id":entry.id,"enabled":entry.enabled,"scope":"project"
			}))).collect::<Vec<_>>()
		}))
	}

	async fn toggle_extension(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		use omp_ext::{lock::InstalledRecord, upgrade::set_enabled};
		let id = required_text(params, "id")?;
		let enabled = params
			.get("enabled")
			.and_then(Value::as_bool)
			.ok_or_else(|| miette!("missing boolean `enabled`"))?;
		let scope = params
			.get("scope")
			.and_then(Value::as_str)
			.unwrap_or("user");
		let path = {
			let state = self.state.lock();
			match scope {
				"user" => state.data_dir.join("ext/installed.toml"),
				"project" => state.root.join(".omp/installed.toml"),
				_ => return Err(miette!("extension scope must be user or project")),
			}
		};
		let mut installed = InstalledRecord::read(&path).map_err(|error| miette!("{error}"))?;
		set_enabled(&mut installed, id, enabled).map_err(|error| miette!("{error}"))?;
		installed.write(&path).into_diagnostic()?;
		let sessions = self
			.state
			.lock()
			.sessions
			.keys()
			.cloned()
			.collect::<Vec<_>>();
		for session_id in sessions {
			self.reload_commands(&session_id).await?;
		}
		Ok(json!({"id":id,"enabled":enabled,"scope":scope}))
	}

	async fn propose_plan(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let session_id = Str::from(required_text(params, "sessionId")?);
		let supplied_title = params.get("title").and_then(Value::as_str);
		let session = self.session(&session_id)?;
		let plan_state = session
			.asynchronous
			.headless
			.lock()
			.await
			.regimes()
			.plan()
			.filter(|state| state.enabled)
			.ok_or_else(|| miette!("plan mode is not active"))?;
		let local_root = self.state.lock().local_root.clone();
		let artifact = PlanArtifactStore::new(local_root)
			.resolve(supplied_title, plan_state.artifact.as_str())
			.map_err(|error| miette!("{error}"))?;
		let response = if session.capabilities.elicitation {
			self.peer_request("session/unstable_createElicitation", json!({
				"sessionId":session_id,
				"mode":"form",
				"message":artifact.content,
				"requestedSchema":{"type":"object","properties":{"decision":{"type":"string","title":artifact.title,"enum":["execute","refine"]}},"required":["decision"]}
			})).await.ok()
		} else {
			None
		};
		let execute = response
			.as_ref()
			.and_then(|value| value.pointer("/content/decision"))
			.and_then(Value::as_str)
			.map_or(!session.capabilities.elicitation, |decision| decision == "execute");
		{
			let headless = session.asynchronous.headless.lock().await;
			headless
				.regimes()
				.set_plan_artifact(artifact.url.clone())
				.map_err(|error| miette!("{error}"))?;
			if execute && let Some(activation) = headless.regimes().mode_activation() {
				headless
					.stop_regime(activation)
					.await
					.map_err(|error| miette!("{error}"))?;
			}
		}
		if execute {
			session.meta.lock().mode = "default".into();
			self.update(
				&session_id,
				json!({"sessionUpdate":"current_mode_update","currentModeId":"default"}),
			)?;
		}
		Ok(json!({
			"approved":execute,
			"decision":if execute {"execute"} else {"refine"},
			"planFilePath":artifact.url,
			"title":artifact.title,
			"planExists":true
		}))
	}

	async fn close_session(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let id = Str::from(required_text(params, "sessionId")?);
		let session = {
			let mut state = self.state.lock();
			if let Some(token) = state.active.remove(&id) {
				token.cancel();
			}
			state
				.sessions
				.remove(&id)
				.ok_or_else(|| miette!("unknown session `{id}`"))?
		};
		session.close_adapters().await?;
		Ok(json!({}))
	}

	fn cancel(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let id = Str::from(required_text(params, "sessionId")?);
		let state = self.state.lock();
		let cancelled = state.active.get(&id).is_some_and(|token| {
			token.cancel();
			true
		});
		Ok(json!({"cancelled":cancelled}))
	}

	async fn set_mode(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let mode = required_text(params, "modeId")?;
		if !matches!(mode, "default" | "plan") {
			return Err(miette!("unknown mode `{mode}`"));
		}
		let session_id = Str::from(required_text(params, "sessionId")?);
		let session = self.session(&session_id)?;
		let generation = session.meta.lock().session_generation;
		{
			let headless = session.asynchronous.headless.lock().await;
			let from = if headless.regimes().holds_mode("plan") {
				PlanState::Active
			} else {
				PlanState::Inactive
			};
			let to = if mode == "plan" {
				if !headless.regimes().holds_mode("plan") {
					headless
						.start_regime("plan", false)
						.await
						.map_err(|error| miette!("{error}"))?;
				}
				PlanState::Active
			} else {
				if headless.regimes().holds_mode("plan")
					&& let Some(activation) = headless.regimes().mode_activation()
				{
					headless
						.stop_regime(activation)
						.await
						.map_err(|error| miette!("{error}"))?;
				}
				PlanState::Inactive
			};
			headless.publish(AgentEvent::PlanStateChanged {
				from,
				to,
				session_generation: generation,
			});
		}
		session.meta.lock().mode = mode.to_owned();
		self.update(
			&session_id,
			json!({"sessionUpdate":"current_mode_update","currentModeId":mode}),
		)?;
		Ok(json!({}))
	}

	async fn set_model(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let selector = required_text(params, "modelId")?;
		let session_id = Str::from(required_text(params, "sessionId")?);
		let session = self.session(&session_id)?;
		let model = {
			let headless = session.asynchronous.headless.lock().await;
			headless.set_model(selector).await.into_diagnostic()?;
			headless.model()
		};
		session.meta.lock().model = model.to_string();
		self.update(&session_id, json!({"sessionUpdate":"config_option_update","configOptions":[{"id":"model","currentValue":model}]}))?;
		Ok(json!({}))
	}

	async fn set_thinking(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let requested = required_text(params, "thinking")?;
		let session_id = Str::from(required_text(params, "sessionId")?);
		let session = self.session(&session_id)?;
		let model = session.meta.lock().model.clone();
		let thinking = clamp_thinking_level(&model, requested)?.to_owned();
		session
			.asynchronous
			.headless
			.lock()
			.await
			.set_thinking(reasoning_for(&thinking));
		session.meta.lock().thinking = thinking.clone();
		self.update(&session_id, json!({"sessionUpdate":"config_option_update","configOptions":[{"id":"thinking","currentValue":thinking}]}))?;
		Ok(json!({}))
	}

	async fn set_config_option(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let session_id = required_text(params, "sessionId")?;
		let config_id = required_text(params, "configId")?;
		let value = required_text(params, "value")?;
		let mut forwarded = Map::new();
		forwarded.insert("sessionId".into(), json!(session_id));
		match config_id {
			"mode" => {
				forwarded.insert("modeId".into(), json!(value));
				self.set_mode(&forwarded).await?;
			},
			"model" => {
				forwarded.insert("modelId".into(), json!(value));
				self.set_model(&forwarded).await?;
			},
			"thinking" => {
				forwarded.insert("thinking".into(), json!(value));
				self.set_thinking(&forwarded).await?;
			},
			_ => return Err(miette!("unknown ACP config option `{config_id}`")),
		}
		let session = self.session(session_id)?;
		let models = self.state.lock().models.clone();
		Ok(json!({"configOptions":config_options(&session.meta.lock(),&models)}))
	}

	async fn configure_mcp_servers(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let session_id = Str::from(required_text(params, "sessionId")?);
		let servers = params
			.get("mcpServers")
			.cloned()
			.ok_or_else(|| miette!("missing `mcpServers`"))?;
		let session = self.session(&session_id)?;
		let _update = session.asynchronous.mcp_update.lock().await;
		let client = session.asynchronous.headless.lock().await.env().clone();
		let mut mounts = session.meta.lock().mcp_mounts.clone();
		let mounted = mounts.replace(&client, &session_id, &servers).await?;
		{
			let mut meta = session.meta.lock();
			meta.mcp_servers = servers;
			meta.mcp_mounts = mounts;
		}
		self.update(&session_id, json!({"sessionUpdate":"mcp_servers_update","servers":mounted}))?;
		Ok(json!({"generation":session.meta.lock().mcp_mounts.generation,"servers":mounted}))
	}

	async fn elicit(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let session_id = Str::from(required_text(params, "sessionId")?);
		let title = required_text(params, "title")?;
		let body = required_text(params, "body")?;
		let (ticket, supported) = {
			let state = self.state.lock();
			let ticket = state.approvals.file(
				params
					.get("invocationId")
					.and_then(Value::as_str)
					.map(Str::from),
				vec![ApprovalSpec {
					title:         Str::from(title),
					body:          Str::from(body),
					subject:       params
						.get("subject")
						.and_then(Value::as_str)
						.map_or_else(|| Str::from(title), Str::from),
					kind:          sf!("acp_elicitation"),
					scopes:        vec![sf!("once")],
					default:       None,
					route:         sf!("acp"),
					approver:      None,
					timeout_ms:    0,
					unreachable:   sf!("deny"),
					require_human: true,
					pattern:       None,
					evidence:      Vec::new(),
				}],
				now_ms(),
			);
			let supported = state
				.sessions
				.get(&session_id)
				.ok_or_else(|| miette!("unknown session `{session_id}`"))?
				.capabilities
				.elicitation;
			(ticket, supported)
		};
		let response = if supported {
			self.peer_request("session/unstable_createElicitation", json!({
				"sessionId":session_id,
				"mode":"form",
				"message":body,
				"requestedSchema":{"type":"object","properties":{"decision":{"type":"string","title":title,"enum":["approve","reject"]}},"required":["decision"]}
			})).await.ok()
		} else {
			None
		};
		let approved = response
			.as_ref()
			.and_then(|value| value.pointer("/content/decision"))
			.and_then(Value::as_str)
			== Some("approve");
		let decision = ApprovalDecision {
			approved,
			scope: sf!("once"),
			source: if supported {
				ApprovalSource::External
			} else {
				ApprovalSource::Unavailable
			},
			decided_by: None,
			reason: (!supported).then(|| sf!("ACP client does not support elicitation")),
			audited: true,
		};
		let decided = self
			.state
			.lock()
			.approvals
			.decide(ticket.ticket_id.as_str(), decision)
			.ok_or_else(|| miette!("approval ticket disappeared"))?;
		Ok(json!({"ticketId":decided.ticket_id,"approved":approved}))
	}

	fn approve(&self, params: &Map<String, Value>) -> miette::Result<Value> {
		let ticket_id = required_text(params, "ticketId")?;
		let approved = params
			.get("approved")
			.and_then(Value::as_bool)
			.ok_or_else(|| miette!("missing boolean `approved`"))?;
		self
			.state
			.lock()
			.approvals
			.decide(ticket_id, ApprovalDecision {
				approved,
				scope: sf!("once"),
				source: ApprovalSource::External,
				decided_by: params
					.get("decidedBy")
					.and_then(Value::as_str)
					.map(Str::from),
				reason: params.get("reason").and_then(Value::as_str).map(Str::from),
				audited: true,
			})
			.ok_or_else(|| miette!("unknown approval ticket `{ticket_id}`"))?;
		Ok(json!({"approved":approved}))
	}

	async fn intercept_prompt(
		&self,
		session_id: &Str,
		text: &str,
	) -> miette::Result<Option<AcpPromptIntercept>> {
		if let Some(invocation) = omp_driver::skills::parse_invocation(text) {
			let skill = {
				let state = self.state.lock();
				state.content.skills.get(invocation.name.as_str()).cloned()
			}
			.ok_or_else(|| miette!("unknown skill `{}`", invocation.name))?;
			let rendered = omp_driver::skills::render_invocation(
				&skill,
				invocation.args.as_str(),
				SkillInvocationKind::User,
			);
			self.command_output(session_id, sf!("Skill `{}` loaded for this turn.", skill.name))?;
			return Ok(Some(AcpPromptIntercept::Prompt(rendered)));
		}
		let Some(command) = text.strip_prefix('/') else {
			return Ok(None);
		};
		if command.is_empty() || command.starts_with('/') {
			return Ok(None);
		}
		let split = command.find(char::is_whitespace).unwrap_or(command.len());
		let name = &command[..split];
		let args = command[split..].trim();
		match name {
			"help" => {
				let output = {
					let state = self.state.lock();
					serde_json::to_string_pretty(&available_commands(
						&state.content,
						state.command_generation,
					))
					.into_diagnostic()?
				};
				self.command_output(session_id, Str::from(output))?;
				return Ok(Some(AcpPromptIntercept::Consumed));
			},
			"reload-plugins" => {
				self.reload_commands(session_id).await?;
				self.command_output(session_id, sf!("Extensions and commands reloaded."))?;
				return Ok(Some(AcpPromptIntercept::Consumed));
			},
			"usage" => {
				let usage = self
					.session(session_id)?
					.mapper
					.lock()
					.usage
					.clone()
					.unwrap_or_else(|| json!({"input_tokens":0,"output_tokens":0,"total_tokens":0}));
				self.command_output(session_id, Str::from(usage.to_string()))?;
				return Ok(Some(AcpPromptIntercept::Consumed));
			},
			"model" if !args.is_empty() => {
				let mut params = Map::new();
				params.insert("sessionId".into(), json!(session_id));
				params.insert("modelId".into(), json!(args));
				self.set_model(&params).await?;
				self.command_output(session_id, sf!("Model changed to {args}."))?;
				return Ok(Some(AcpPromptIntercept::Consumed));
			},
			"plan" => {
				let mode = if matches!(args, "off" | "exit" | "default") {
					"default"
				} else {
					"plan"
				};
				let mut params = Map::new();
				params.insert("sessionId".into(), json!(session_id));
				params.insert("modeId".into(), json!(mode));
				self.set_mode(&params).await?;
				self.command_output(session_id, sf!("Mode changed to {mode}."))?;
				return Ok(Some(AcpPromptIntercept::Consumed));
			},
			"retry" if args.is_empty() => return Ok(Some(AcpPromptIntercept::Retry)),
			"handoff" => {
				return Ok(Some(AcpPromptIntercept::Handoff(
					(!args.is_empty()).then(|| Str::from(args)),
				)));
			},
			"quit" | "exit" => return Ok(Some(AcpPromptIntercept::Exit)),
			_ => {},
		}
		let template = {
			let state = self.state.lock();
			state
				.content
				.commands
				.iter()
				.find(|command| command.name.as_str() == name)
				.and_then(|command| command.template.clone())
		};
		let Some(template) = template else {
			return Ok(None);
		};
		let expanded = template
			.replace("{{args}}", args)
			.replace("$ARGUMENTS", args);
		self.command_output(session_id, sf!("Command /{name} expanded."))?;
		Ok(Some(AcpPromptIntercept::Prompt(Str::from(expanded))))
	}

	fn command_output(&self, session_id: &Str, content: Str) -> miette::Result<()> {
		self.update(
			session_id,
			json!({"sessionUpdate":"command_output","stream":"stdout","content":content,"status":"completed"}),
		)
	}

	async fn start_prompt(
		self: &Arc<Self>,
		request_id: Value,
		params: Map<String, Value>,
	) -> miette::Result<()> {
		let session_id = Str::from(required_text(&params, "sessionId")?);
		let blocks = params
			.get("prompt")
			.or_else(|| params.get("content"))
			.ok_or_else(|| miette!("missing prompt content"))?;
		let (mut parts, _) = convert_blocks(blocks)?;
		if parts.is_empty() {
			return Err(miette!("prompt contains no supported content"));
		}
		loop {
			let Some(text) = parts.as_slice().first().and_then(|part| match part {
				ContentPart::Text { text, .. } if parts.len() == 1 => Some(text.clone()),
				_ => None,
			}) else {
				break;
			};
			let Some(intercept) = self.intercept_prompt(&session_id, text.as_str()).await? else {
				break;
			};
			match intercept {
				AcpPromptIntercept::Prompt(prompt) => {
					parts = vec![ContentPart::Text { text: prompt, proof: None }];
				},
				AcpPromptIntercept::Consumed => {
					self.respond(request_id, prompt_settlement("end_turn", true))?;
					return Ok(());
				},
				AcpPromptIntercept::Retry => {
					self.start_retry(request_id, session_id)?;
					return Ok(());
				},
				AcpPromptIntercept::Handoff(instructions) => {
					self.start_handoff(request_id, session_id, instructions)?;
					return Ok(());
				},
				AcpPromptIntercept::Exit => {
					let _ = self.close_session(&params).await;
					let mut response = prompt_settlement("end_turn", true);
					response["exit"] = json!(true);
					self.respond(request_id, response)?;
					return Ok(());
				},
			}
		}
		let proposed_title = parts.iter().find_map(|part| match part {
			ContentPart::Text { text, .. } if !text.trim().is_empty() => {
				Some(Str::from(text.chars().take(80).collect::<String>()))
			},
			_ => None,
		});
		let items = prompt_items(parts);
		let token = CancellationToken::new();
		let session = {
			let mut state = self.state.lock();
			if state.active.contains_key(&session_id) {
				return Err(miette!("session is busy"));
			}
			let session = state
				.sessions
				.get(&session_id)
				.cloned()
				.ok_or_else(|| miette!("unknown session `{session_id}`"))?;
			state.active.insert(session_id.clone(), token.clone());
			session
		};
		if let Some(title) = proposed_title.filter(|_| session.meta.lock().title.is_none()) {
			session
				.asynchronous
				.headless
				.lock()
				.await
				.set_title(title.clone())
				.await
				.into_diagnostic()?;
			session.meta.lock().title = Some(title);
		}
		let runtime = Arc::clone(self);
		tokio::spawn(async move {
			let result = runtime.run_prompt(&session_id, session, items, token).await;
			runtime.state.lock().active.remove(&session_id);
			match result {
				Ok(reason) => {
					let _ = runtime.respond(request_id, prompt_settlement(reason, false));
				},
				Err(error) => {
					let _ = runtime.error(request_id, -32000, error.to_string());
				},
			}
		});
		Ok(())
	}

	fn start_retry(self: &Arc<Self>, request_id: Value, session_id: Str) -> miette::Result<()> {
		let cancellation = CancellationToken::new();
		let session = self.claim_turn(&session_id, &cancellation)?;
		let runtime = Arc::clone(self);
		tokio::spawn(async move {
			let result = runtime
				.run_retry_command(&session_id, session, cancellation)
				.await;
			runtime.state.lock().active.remove(&session_id);
			match result {
				Ok((reason, status)) => {
					if let Some(status) = status {
						let _ = runtime.command_output(&session_id, status);
					}
					let _ = runtime.respond(request_id, prompt_settlement(reason, true));
				},
				Err(error) => {
					let _ = runtime.error(request_id, -32000, error.to_string());
				},
			}
		});
		Ok(())
	}

	fn start_handoff(
		self: &Arc<Self>,
		request_id: Value,
		session_id: Str,
		instructions: Option<Str>,
	) -> miette::Result<()> {
		let cancellation = CancellationToken::new();
		let session = self.claim_turn(&session_id, &cancellation)?;
		let runtime = Arc::clone(self);
		tokio::spawn(async move {
			let result = runtime
				.run_handoff_command(&session_id, session, instructions, cancellation)
				.await;
			runtime.state.lock().active.remove(&session_id);
			match result {
				Ok((reason, status)) => {
					if let Some(status) = status {
						let _ = runtime.command_output(&session_id, status);
					}
					let _ = runtime.respond(request_id, prompt_settlement(reason, true));
				},
				Err(error) => {
					let _ = runtime.error(request_id, -32000, error.to_string());
				},
			}
		});
		Ok(())
	}

	fn claim_turn(
		&self,
		session_id: &Str,
		cancellation: &CancellationToken,
	) -> miette::Result<Arc<AcpSession>> {
		let mut state = self.state.lock();
		if state.active.contains_key(session_id) {
			return Err(miette!("session is busy"));
		}
		let session = state
			.sessions
			.get(session_id)
			.cloned()
			.ok_or_else(|| miette!("unknown session `{session_id}`"))?;
		state
			.active
			.insert(session_id.clone(), cancellation.clone());
		Ok(session)
	}

	async fn run_retry_command(
		&self,
		session_id: &Str,
		session: Arc<AcpSession>,
		cancellation: CancellationToken,
	) -> miette::Result<(&'static str, Option<Str>)> {
		let headless = session.asynchronous.headless.lock().await;
		let interrupt = headless.interrupt_handle();
		let retry = headless.retry_last_turn(omp_agent::TurnId::new(format!("retry-{}", turn_id())));
		tokio::pin!(retry);
		let mut interrupted = false;
		let result = loop {
			tokio::select! {
				result = &mut retry => break result,
				event = session.events.recv() => {
					if let Ok(event) = event {
						self.deliver_event(session_id, &session, &event)?;
					}
				},
				() = cancellation.cancelled(), if !interrupted => {
					interrupted = true;
					interrupt.interrupt();
				},
			}
		};
		self.drain_deliveries(session_id, &session).await?;
		if interrupted || cancellation.is_cancelled() {
			return Ok(("cancelled", None));
		}
		Ok(match result {
			Ok(Some((_, _, summary))) => {
				for update in session.mapper.lock().final_delivery(&summary) {
					self.update(session_id, update)?;
				}
				("end_turn", Some(sf!("Retrying the last failed turn.")))
			},
			Ok(None) => ("end_turn", Some(sf!("Nothing to retry."))),
			Err(error) => ("end_turn", Some(sf!("Retry failed: {error}"))),
		})
	}

	async fn run_handoff_command(
		&self,
		session_id: &Str,
		session: Arc<AcpSession>,
		instructions: Option<Str>,
		cancellation: CancellationToken,
	) -> miette::Result<(&'static str, Option<Str>)> {
		let headless = session.asynchronous.headless.lock().await;
		let interrupt = headless.interrupt_handle();
		let handoff = headless
			.compact_manual(omp_agent::ManualCompactionRequest { mode: None, focus: instructions });
		tokio::pin!(handoff);
		let mut interrupted = false;
		let result = loop {
			tokio::select! {
				result = &mut handoff => break result,
				event = session.events.recv() => {
					if let Ok(event) = event {
						self.deliver_event(session_id, &session, &event)?;
					}
				},
				() = cancellation.cancelled(), if !interrupted => {
					interrupted = true;
					interrupt.interrupt();
				},
			}
		};
		self.drain_deliveries(session_id, &session).await?;
		if interrupted || cancellation.is_cancelled() {
			return Ok(("cancelled", None));
		}
		Ok(match result {
			Ok(_) => ("end_turn", Some(sf!("Context handed off and compacted in place."))),
			Err(error) => ("end_turn", Some(sf!("Handoff failed: {error}"))),
		})
	}

	async fn run_prompt(
		&self,
		session_id: &Str,
		session: Arc<AcpSession>,
		items: Vec<Item>,
		cancellation: CancellationToken,
	) -> miette::Result<&'static str> {
		let mut headless = session.asynchronous.headless.lock().await;
		let interrupt = headless.interrupt_handle();
		let submit = headless.submit(items, omp_agent::TurnId::new(turn_id()));
		tokio::pin!(submit);
		let mut interrupted = false;
		let summary = loop {
			tokio::select! {
				result = &mut submit => break result.into_diagnostic()?,
				event = session.events.recv() => {
					if let Ok(event) = event {
						self.deliver_event(session_id, &session, &event)?;
					}
				},
				() = cancellation.cancelled(), if !interrupted => {
					interrupted = true;
					interrupt.interrupt();
				},
			}
		};
		self.drain_deliveries(session_id, &session).await?;
		let final_updates = session.mapper.lock().final_delivery(&summary);
		for update in final_updates {
			self.update(session_id, update)?;
		}
		Ok(map_settlement(&summary))
	}

	fn deliver_event(
		&self,
		session_id: &Str,
		session: &AcpSession,
		event: &AgentEvent,
	) -> miette::Result<()> {
		for update in session.mapper.lock().map(event, &session.root) {
			self.update(session_id, update)?;
		}
		Ok(())
	}

	async fn drain_deliveries(&self, session_id: &Str, session: &AcpSession) -> miette::Result<()> {
		for _ in 0..DELIVERY_DRAIN_PASSES {
			let mut drained = 0;
			while drained < DELIVERY_DRAIN_BATCH {
				let Ok(event) = session.events.try_recv() else {
					break;
				};
				self.deliver_event(session_id, session, &event)?;
				drained += 1;
			}
			if drained == 0 {
				break;
			}
			task::yield_now().await;
		}
		Ok(())
	}

	fn push_replay(&self, session_id: &Str) -> miette::Result<()> {
		let replay = self.session(session_id)?.meta.lock().replay.clone();
		for update in replay {
			self.update(session_id, update)?;
		}
		self.update(session_id, json!({"sessionUpdate":"history_replay_complete"}))
	}

	fn push_initial(&self, session_id: &Str) -> miette::Result<()> {
		let session = self.session(session_id)?;
		let state = self.state.lock();
		let meta = session.meta.lock();
		self.update(session_id, json!({"sessionUpdate":"session_info_update","title":meta.title}))?;
		self.update(
			session_id,
			json!({"sessionUpdate":"usage_update","usage":{"input_tokens":0,"output_tokens":0}}),
		)?;
		self.update(
			session_id,
			json!({"sessionUpdate":"current_mode_update","currentModeId":meta.mode}),
		)?;
		self.update(session_id, json!({"sessionUpdate":"config_option_update","configOptions":config_options(&meta,&state.models)}))?;
		self.update(
			session_id,
			json!({"sessionUpdate":"available_commands_update","availableCommands":available_commands(&state.content,state.command_generation),"generation":state.command_generation}),
		)?;
		self.update(session_id, json!({
			"sessionUpdate":"capabilities_update",
			"remoteFs":{"read":session.capabilities.read_text_file,"write":session.capabilities.write_text_file},
			"terminal":session.capabilities.terminal,
			"terminalBackend":if session.capabilities.terminal { "acp" } else { "environment" },
			"elicitation":session.capabilities.elicitation,
			"mcpConfigured":!meta.mcp_mounts.mounted.is_empty(),
			"mcpGeneration":meta.mcp_mounts.generation,
		}))
	}

	fn session(&self, id: &str) -> miette::Result<Arc<AcpSession>> {
		self
			.state
			.lock()
			.sessions
			.get(id)
			.cloned()
			.ok_or_else(|| miette!("unknown session `{id}`"))
	}

	async fn peer_request(&self, method: &'static str, params: Value) -> miette::Result<Value> {
		let (id, response) = {
			let mut state = self.state.lock();
			let id = state.next_peer_request;
			state.next_peer_request = state.next_peer_request.wrapping_add(1).max(1);
			let (reply, response) = oneshot::channel();
			state.pending_peer.insert(id, reply);
			(id, response)
		};
		self
			.output
			.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
			.into_diagnostic()?;
		match response.await {
			Ok(Ok(value)) => Ok(value),
			Ok(Err(error)) => Err(miette!("ACP peer request failed: {error}")),
			Err(_) => Err(miette!("ACP peer disconnected")),
		}
	}

	async fn peer_operation(
		&self,
		session_id: &str,
		operation: &RemoteOperation,
	) -> miette::Result<Value> {
		let frame = operation.request(Value::Null, session_id);
		let method = frame
			.get("method")
			.and_then(Value::as_str)
			.ok_or_else(|| miette!("remote operation has no method"))?;
		let params = frame.get("params").cloned().unwrap_or(Value::Null);
		match method {
			"fs/read_text_file" => self.peer_request("fs/read_text_file", params).await,
			"fs/write_text_file" => self.peer_request("fs/write_text_file", params).await,
			"terminal/create" => self.peer_request("terminal/create", params).await,
			"terminal/output" => self.peer_request("terminal/output", params).await,
			"terminal/kill" => self.peer_request("terminal/kill", params).await,
			"terminal/release" => self.peer_request("terminal/release", params).await,
			_ => Err(miette!("unsupported remote operation method `{method}`")),
		}
	}

	fn settle_peer_response(&self, frame: Value) {
		let Some(id) = frame.get("id").and_then(Value::as_u64) else {
			return;
		};
		let Some(reply) = self.state.lock().pending_peer.remove(&id) else {
			return;
		};
		let result = frame
			.get("result")
			.cloned()
			.ok_or_else(|| frame.get("error").cloned().unwrap_or(Value::Null));
		let _ = reply.send(result);
	}

	fn update(&self, session: &Str, update: Value) -> miette::Result<()> {
		self.output.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":update}})).into_diagnostic()
	}

	fn respond(&self, id: Value, result: Value) -> miette::Result<()> {
		self
			.output
			.send(json!({"jsonrpc":"2.0","id":id,"result":result}))
			.into_diagnostic()
	}

	fn error(&self, id: Value, code: i64, message: impl Into<String>) -> miette::Result<()> {
		self
			.output
			.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message.into()}}))
			.into_diagnostic()
	}
}

fn map_settlement(summary: &AgentRunSummary) -> &'static str {
	match summary.settlement {
		RunSettlement::Success
		| RunSettlement::Warning
		| RunSettlement::SilentCompactionTransition => "end_turn",
		RunSettlement::CallerAbort => "cancelled",
		RunSettlement::MaxTokens => "max_tokens",
		RunSettlement::TerminalFault => "refusal",
	}
}

fn prompt_settlement(reason: &str, command: bool) -> Value {
	let mut response = json!({"stopReason":reason});
	if command {
		response["command"] = json!(true);
	}
	response
}

fn prompt_items(parts: Vec<ContentPart>) -> Vec<Item> {
	let mut canonical = Vec::with_capacity(parts.len());
	for part in parts {
		match part {
			ContentPart::Text { text, .. } => {
				canonical.push(Part { kind: Some(part::Kind::Text(text.to_string())) })
			},
			ContentPart::Image(media) | ContentPart::Document(media) => {
				if let MediaInput::Bytes { media_type, data } = media {
					canonical.push(Part {
						kind: Some(part::Kind::Blob(Blob {
							hash:   Bytes::copy_from_slice(Hash32::sum(&data).as_bytes()),
							mime:   media_type.to_string(),
							size:   data.len() as u64,
							inline: data,
							detail: blob::Detail::Auto as i32,
						})),
					});
				}
			},
			_ => {},
		}
	}
	vec![Item {
		kind: Some(item::Kind::Message(Message { role: Role::User as i32, parts: canonical })),
		..Item::default()
	}]
}

fn replay_updates(items: &[Item], root: &Path) -> Vec<Value> {
	let mut replay = Vec::new();
	for item in items {
		match item.kind.as_ref() {
			Some(item::Kind::Message(message)) => {
				let update = if message.role() == Role::Assistant {
					"agent_message_chunk"
				} else {
					"user_message_chunk"
				};
				for part in &message.parts {
					match part.kind.as_ref() {
						Some(part::Kind::Text(text)) => replay.push(json!({"sessionUpdate":update,"content":{"type":"text","text":bounded_text(text)}})),
						Some(part::Kind::Blob(blob)) if blob.mime.starts_with("image/") => replay.push(json!({"sessionUpdate":update,"content":{"type":"image","mimeType":blob.mime,"data":omp_core::base64::encode(&blob.inline)}})),
						_ => {},
					}
				}
			},
			Some(item::Kind::ToolCall(call)) => {
				let args = serde_json::from_slice::<Value>(&call.args_json).unwrap_or(Value::Null);
				let mut update = json!({"sessionUpdate":"tool_call","toolCallId":call.id,"title":call.name,"kind":tool_kind_name(&call.name),"status":"completed","rawInput":args});
				if let Some(locations) = tool_locations(&args, root) {
					update["locations"] = locations;
				}
				replay.push(update);
			},
			Some(item::Kind::ToolResult(result)) => {
				let details = result
					.details
					.as_ref()
					.and_then(value_to_json)
					.unwrap_or(Value::Null);
				replay.push(tool_update(
					&Str::from(result.call_id.as_str()),
					if result.is_error {
						"failed"
					} else {
						"completed"
					},
					details,
					root,
				));
			},
			_ => {},
		}
	}
	replay
}

fn convert_blocks(value: &Value) -> miette::Result<(Vec<ContentPart>, Vec<Value>)> {
	let blocks = value
		.as_array()
		.map_or_else(|| vec![value], |values| values.iter().collect());
	let mut parts = Vec::new();
	let mut replay = Vec::new();
	for block in blocks {
		let kind = block.get("type").and_then(Value::as_str).unwrap_or("text");
		match kind {
			"text" => {
				let text = block
					.get("text")
					.and_then(Value::as_str)
					.unwrap_or_default();
				parts.push(ContentPart::Text { text: Str::from(text), proof: None });
				replay.push(
					json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":text}}),
				);
			},
			"image" => {
				let media_type = block
					.get("mimeType")
					.or_else(|| block.get("mediaType"))
					.and_then(Value::as_str)
					.map(Str::from);
				let image = if let Some(data) = block.get("data").and_then(Value::as_str) {
					let data = omp_core::base64::decode(data)
						.into_vec()
						.map_err(|error| miette!("invalid image base64: {error}"))?;
					MediaInput::Bytes {
						media_type: media_type.unwrap_or_else(|| sf!("image/png")),
						data:       Bytes::from(data),
					}
				} else {
					let uri = block
						.get("uri")
						.or_else(|| block.get("url"))
						.and_then(Value::as_str)
						.ok_or_else(|| miette!("image block requires `data` or `uri`"))?;
					MediaInput::Remote {
						uri: Str::from(uri),
						media_type,
						name: block.get("name").and_then(Value::as_str).map(Str::from),
					}
				};
				parts.push(ContentPart::Image(image));
				let mut bounded = block.clone();
				bound_embedded_block(&mut bounded);
				replay.push(json!({"sessionUpdate":"user_message_chunk","content":bounded}));
			},
			"resource" | "resource_link" => {
				let resource = block
					.get("resource")
					.and_then(Value::as_object)
					.unwrap_or_else(|| {
						block
							.as_object()
							.expect("ACP content blocks are JSON objects")
					});
				let uri = resource
					.get("uri")
					.and_then(Value::as_str)
					.unwrap_or("resource");
				if let Some(text) = resource.get("text").and_then(Value::as_str) {
					parts.push(ContentPart::Text { text: Str::from(bounded_text(text)), proof: None });
				} else if let Some(blob) = resource.get("blob").and_then(Value::as_str)
					&& let Some(media_type) = resource
						.get("mimeType")
						.or_else(|| resource.get("mediaType"))
						.and_then(Value::as_str)
						.filter(|media_type| media_type.starts_with("image/"))
				{
					let data = omp_core::base64::decode(blob)
						.into_vec()
						.map_err(|error| miette!("invalid resource image base64: {error}"))?;
					parts.push(ContentPart::Image(MediaInput::Bytes {
						media_type: Str::from(media_type),
						data:       Bytes::from(data),
					}));
				} else {
					parts.push(ContentPart::Text { text: sf!("[Resource: {uri}]"), proof: None });
				}
				let mut bounded = block.clone();
				bound_embedded_block(&mut bounded);
				replay.push(json!({"sessionUpdate":"user_message_chunk","content":bounded}));
			},
			"audio" => {
				parts.push(ContentPart::Text {
					text:  sf!("[Audio attachment unavailable in ACP]"),
					proof: None,
				});
				replay.push(json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"[Audio attachment]"}}));
			},
			other => return Err(miette!("unsupported content block `{other}`")),
		}
	}
	Ok((parts, replay))
}

fn bound_embedded_block(block: &mut Value) {
	for field in ["text", "data", "blob"] {
		if let Some(text) = block.get(field).and_then(Value::as_str) {
			block[field] = Value::String(bounded_text(text));
		}
	}
	if let Some(resource) = block.get_mut("resource") {
		bound_embedded_block(resource);
	}
}

fn bounded_text(text: &str) -> String {
	text.chars().take(EMBEDDED_TEXT_LIMIT).collect()
}

fn visible_tool(tool: &AcpToolState) -> bool {
	tool.visibility == EventVisibility::User && tool.provenance != EventProvenance::Subagent
}

fn tool_kind(tool: &AcpToolState) -> &'static str {
	let name = tool
		.path
		.as_ref()
		.map_or(tool.identity.name.as_str(), ToolPath::name);
	if tool.presentation == Some(Presentation::Device) && name == "write" {
		return "execute";
	}
	tool_kind_name(name)
}

fn tool_kind_name(name: &str) -> &'static str {
	match name {
		"read" => "read",
		"write" | "edit" => "edit",
		"delete" => "delete",
		"move" => "move",
		"bash" | "shell" | "exec" | "eval" => "execute",
		"grep" | "glob" | "ast_grep" => "search",
		"web_search" | "web_fetch" => "fetch",
		"todo" | "task" => "think",
		_ => "other",
	}
}

fn tool_update(call_id: &Str, status: &str, output: Value, root: &Path) -> Value {
	let mut update = json!({"sessionUpdate":"tool_call_update","toolCallId":call_id,"status":status,"rawOutput":output});
	if let Some(locations) = tool_locations(&output, root) {
		update["locations"] = locations;
	}
	update
}

fn tool_locations(value: &Value, root: &Path) -> Option<Value> {
	let mut locations = Vec::new();
	let mut add = |raw: &str| {
		if is_internal_url(raw) {
			return;
		}
		let path = Path::new(raw);
		let absolute = if path.is_absolute() {
			path.to_path_buf()
		} else {
			root.join(path)
		};
		let rendered = absolute.to_string_lossy().into_owned();
		if !locations
			.iter()
			.any(|entry: &Value| entry["path"] == rendered)
		{
			locations.push(json!({"path":rendered}));
		}
	};
	for key in ["path", "oldPath", "newPath"] {
		if let Some(path) = value.get(key).and_then(Value::as_str) {
			add(path);
		}
	}
	if let Some(details) = value.get("details") {
		for key in ["path", "oldPath", "newPath"] {
			if let Some(path) = details.get(key).and_then(Value::as_str) {
				add(path);
			}
		}
		if let Some(files) = details.get("perFileResults").and_then(Value::as_array) {
			for file in files {
				if let Some(path) = file.get("path").and_then(Value::as_str) {
					add(path);
				}
			}
		}
	}
	(!locations.is_empty()).then(|| Value::Array(locations))
}

fn tool_result_content(result: &thread::ToolResult, details: &Value, root: &Path) -> Vec<Value> {
	let mut content = Vec::new();
	let entries = details
		.get("perFileResults")
		.and_then(Value::as_array)
		.map_or_else(|| vec![details], |values| values.iter().collect());
	for entry in entries {
		if entry.get("isError").and_then(Value::as_bool) == Some(true) {
			continue;
		}
		let Some(path) = entry.get("path").and_then(Value::as_str) else {
			continue;
		};
		let old = entry.get("oldText").and_then(Value::as_str);
		let new = entry.get("newText").and_then(Value::as_str);
		if old.is_some() || new.is_some() {
			let absolute = if Path::new(path).is_absolute() {
				PathBuf::from(path)
			} else {
				root.join(path)
			};
			content.push(
				json!({"type":"diff","path":absolute,"oldText":old,"newText":new.unwrap_or_default()}),
			);
		}
	}
	for part in &result.parts {
		match part.kind.as_ref() {
			Some(part::Kind::Text(text)) => content.push(json!({"type":"content","content":{"type":"text","text":bounded_text(text)}})),
			Some(part::Kind::Blob(blob)) if blob.mime.starts_with("image/") => content.push(json!({"type":"content","content":{"type":"image","mimeType":blob.mime,"data":omp_core::base64::encode(&blob.inline)}})),
			_ => {},
		}
	}
	if let Some(terminal_id) = details
		.get("terminalId")
		.and_then(Value::as_str)
		.or_else(|| {
			details
				.pointer("/details/terminalId")
				.and_then(Value::as_str)
		}) {
		content.push(json!({"type":"terminal","terminalId":terminal_id}));
	}
	content
}

fn plan_update(state: PlanState) -> Value {
	let entries = match state {
		PlanState::Inactive => Vec::new(),
		PlanState::Active => {
			vec![json!({"content":"Planning changes","priority":"medium","status":"in_progress"})]
		},
		PlanState::Yolo => vec![
			json!({"content":"Planning with one authorized mutation","priority":"medium","status":"in_progress"}),
		],
	};
	json!({"sessionUpdate":"plan","entries":entries})
}

fn is_internal_url(value: &str) -> bool {
	let Some((scheme, _)) = value.split_once("://") else {
		return false;
	};
	!scheme.is_empty()
		&& scheme.as_bytes()[0].is_ascii_alphabetic()
		&& scheme
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn reasoning_for(thinking: &str) -> Option<Reasoning> {
	let effort = match thinking {
		"none" => Effort::Off,
		"minimal" => Effort::Minimal,
		"low" => Effort::Low,
		"medium" => Effort::Medium,
		"high" => Effort::High,
		"xhigh" => Effort::Xhigh,
		"max" => Effort::Max,
		_ => return None,
	};
	Some(Reasoning {
		effort:         effort as i32,
		budget_tokens:  None,
		hide_summary:   None,
		on_unsupported: 0,
	})
}

fn mcp_declarations(servers: &Value) -> miette::Result<Vec<(Str, Value)>> {
	let mut declarations = Vec::new();
	match servers {
		Value::Array(values) => {
			for declaration in values {
				let mut config = declaration
					.as_object()
					.cloned()
					.ok_or_else(|| miette!("MCP declaration must be an object"))?;
				let name = config
					.remove("name")
					.and_then(|value| value.as_str().map(Str::from))
					.ok_or_else(|| miette!("MCP declaration requires `name`"))?;
				normalize_mcp_config(&mut config)?;
				declarations.push((name, Value::Object(config)));
			}
		},
		Value::Object(values) => {
			for (name, declaration) in values {
				let mut config = declaration
					.as_object()
					.cloned()
					.ok_or_else(|| miette!("MCP declaration `{name}` must be an object"))?;
				normalize_mcp_config(&mut config)?;
				declarations.push((Str::from(name.as_str()), Value::Object(config)));
			}
		},
		_ => return Err(miette!("`mcpServers` must be an array or object")),
	}
	Ok(declarations)
}

fn normalize_mcp_config(config: &mut Map<String, Value>) -> miette::Result<()> {
	for field in ["env", "headers"] {
		let Some(Value::Array(entries)) = config.get(field) else {
			continue;
		};
		let mut mapped = Map::new();
		for entry in entries {
			let name = entry
				.get("name")
				.and_then(Value::as_str)
				.ok_or_else(|| miette!("MCP `{field}` entry requires `name`"))?;
			let value = entry
				.get("value")
				.and_then(Value::as_str)
				.ok_or_else(|| miette!("MCP `{field}` entry requires string `value`"))?;
			mapped.insert(name.to_owned(), Value::String(value.to_owned()));
		}
		config.insert(field.to_owned(), Value::Object(mapped));
	}
	Ok(())
}

fn scoped_mcp_name(session_id: &str, logical: &str) -> Str {
	let prefix = scoped_mcp_prefix(session_id);
	let logical = logical
		.chars()
		.map(|character| {
			if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':') {
				character
			} else {
				'_'
			}
		})
		.take(64)
		.collect::<String>();
	Str::from(format!("{prefix}{logical}"))
}

fn scoped_mcp_prefix(session_id: &str) -> String {
	let session = session_id.chars().take(12).collect::<String>();
	format!("acp-{session}-")
}

fn available_commands(
	content: &omp_driver::discovery::ActiveContentSnapshots,
	generation: u64,
) -> Vec<Value> {
	let mut commands = CommandRoster::builtins()
		.advertised(CommandSurface::Acp, CommandRole::Owner, true, |_| true)
		.into_iter()
		.map(|command| {
			json!({
				"name":command.name,
				"description":command.description,
				"input":command.argument_hint,
				"source":command.provenance.source,
				"generation":command.provenance.generation,
			})
		})
		.collect::<Vec<_>>();
	commands.extend(content.extensions.iter().flat_map(|extension| {
		extension
			.manifest
			.static_declarations()
			.ui
			.commands
			.iter()
			.map(|command| {
				json!({
					"name":command.key,
					"description":command
						.properties
						.get("description")
						.and_then(Value::as_str)
						.unwrap_or_default(),
					"input":command.properties.get("hint"),
					"source":format!("extension:{}",extension.key.extension()),
					"generation":generation,
				})
			})
	}));
	commands.extend(content.commands.iter().map(|command| {
		json!({
			"name":command.name,
			"description":command.description,
			"input":{"hint":command.hint},
			"source":command.origin,
			"generation":generation,
		})
	}));
	commands.extend(content.skills.visible().map(|skill| {
		json!({
			"name":format!("skill:{}",skill.name),
			"description":skill.description,
			"input":{"hint":"[arguments]"},
			"source":skill.source,
			"generation":generation,
		})
	}));
	commands
}

fn session_config_response(
	session_id: &Str,
	session: &AcpSessionMeta,
	models: &[String],
	mounted: &[Value],
) -> Value {
	json!({
		"sessionId":session_id,
		"configOptions":config_options(session,models),
		"modes":{"currentModeId":session.mode,"availableModes":[{"id":"default","name":"Default"},{"id":"plan","name":"Plan"}]},
		"mcpServers":mounted,
	})
}

fn config_options(session: &AcpSessionMeta, models: &[String]) -> Vec<Value> {
	vec![
		json!({"id":"mode","name":"Mode","type":"select","currentValue":session.mode,"options":["default","plan"]}),
		json!({"id":"model","name":"Model","type":"select","currentValue":session.model,"options":models}),
		json!({"id":"thinking","name":"Thinking","type":"select","currentValue":session.thinking,"options":["auto","none","minimal","low","medium","high","xhigh","max"]}),
	]
}

fn clamp_thinking_level(model: &str, requested: &str) -> miette::Result<&'static str> {
	if matches!(requested, "auto" | "none") {
		return Ok(if requested == "none" { "none" } else { "auto" });
	}
	let requested = requested
		.parse::<ThinkingEffort>()
		.map_err(|_| miette!("unknown thinking level `{requested}`"))?;
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let catalog =
		omp_driver::registry::production_catalog(&data_dir).map_err(|error| miette!(error))?;
	let model = catalog
		.model(ModelKey::from_ref(model))
		.ok_or_else(|| miette!("unknown model `{model}`"))?;
	let policy = model
		.thinking
		.as_ref()
		.and_then(|id| catalog.thinking_policy(id))
		.ok_or_else(|| miette!("model `{}` does not support thinking", model.key))?;
	let effective = clamp_thinking_effort(policy, Some(requested), None)
		.ok_or_else(|| miette!("model `{}` has no compatible thinking level", model.key))?;
	Ok(<&'static str>::from(effective))
}

fn ask_elicitation_params(session_id: &str, questions: &[omp_tools::ask::Question]) -> Value {
	let message = if questions.len() == 1 {
		questions[0].question.to_string()
	} else {
		format!("Answer {} questions", questions.len())
	};
	json!({
		"sessionId":session_id,
		"mode":"form",
		"message":message,
		"requestedSchema":ask_elicitation_schema(questions),
	})
}

fn ask_elicitation_schema(questions: &[omp_tools::ask::Question]) -> Value {
	let mut properties = Map::new();
	for (index, question) in questions.iter().enumerate() {
		let key = format!("q{index}");
		let choices = question
			.options
			.iter()
			.map(|option| {
				let mut choice = Map::from_iter([
					("const".into(), json!(option.label)),
					("title".into(), json!(option.label)),
				]);
				if let Some(description) = option
					.description
					.as_deref()
					.map(str::trim)
					.filter(|value| !value.is_empty())
				{
					choice.insert("description".into(), json!(description));
				}
				Value::Object(choice)
			})
			.collect::<Vec<_>>();
		let mut property = Map::new();
		property.insert("type".into(), json!(if question.multi { "array" } else { "string" }));
		property.insert("title".into(), json!(question.question));
		if let Some(header) = question
			.header
			.as_deref()
			.map(str::trim)
			.filter(|value| !value.is_empty())
		{
			property.insert("description".into(), json!(header));
		}
		if question.multi {
			property.insert("items".into(), json!({"anyOf":choices}));
		} else {
			property.insert("oneOf".into(), Value::Array(choices));
			if let Some(recommended) = question
				.recommended
				.and_then(|recommended| question.options.get(recommended))
			{
				property.insert("default".into(), json!(recommended.label));
			}
		}
		if !question.options.is_empty() {
			properties.insert(key.clone(), Value::Object(property));
		}
		properties.insert(
			format!("{key}__other"),
			json!({"type":"string","title":omp_tools::ask::OTHER_OPTION}),
		);
	}
	json!({"type":"object","properties":properties})
}

fn ask_answers(
	questions: &[omp_tools::ask::Question],
	content: &Map<String, Value>,
) -> Vec<omp_tools::ask::Answer> {
	questions
		.iter()
		.enumerate()
		.map(|(index, question)| {
			let key = format!("q{index}");
			let offered = |candidate: &str| {
				question
					.options
					.iter()
					.any(|option| option.label.as_str() == candidate)
			};
			let selected: Vec<Str> = if question.multi {
				content
					.get(&key)
					.and_then(Value::as_array)
					.into_iter()
					.flatten()
					.filter_map(Value::as_str)
					.filter(|candidate| offered(candidate))
					.map(Str::from)
					.collect()
			} else {
				content
					.get(&key)
					.and_then(Value::as_str)
					.filter(|candidate| offered(candidate))
					.map(Str::from)
					.into_iter()
					.collect()
			};
			let custom_input = content
				.get(&format!("{key}__other"))
				.and_then(Value::as_str)
				.map(str::trim)
				.filter(|value| !value.is_empty())
				.map(Str::from);
			omp_tools::ask::Answer {
				id: question.id.clone(),
				selected,
				custom_input,
				note: None,
				timed_out: false,
			}
		})
		.collect()
}

fn ask_fault(message: &'static str) -> ask::Fault {
	ask::Fault::Presenter { message: Str::new_static(message) }
}

fn acp_auth_methods(terminal: bool) -> Vec<Value> {
	let mut methods = vec![json!({
		"id":"agent",
		"name":"Use existing local credentials",
		"description":"Authenticate via provider keys or OAuth state already configured under ~/.omp."
	})];
	if terminal {
		methods.push(json!({
			"type":"terminal",
			"id":"terminal",
			"name":"Set up Oh My Pi in terminal",
			"description":"Launch the omp TUI to add provider keys and select models.",
			"args":["--acp-terminal-auth"]
		}));
	}
	methods
}

fn canonical_session_root(raw: &str) -> miette::Result<PathBuf> {
	let requested = PathBuf::from(raw);
	if !requested.is_absolute() {
		return Err(miette!("ACP session cwd must be an absolute path"));
	}
	let root = requested
		.canonicalize()
		.into_diagnostic()
		.map_err(|error| miette!("ACP session cwd is unavailable: {error}"))?;
	if !root.is_dir() {
		return Err(miette!("ACP session cwd must be a directory"));
	}
	Ok(root)
}

fn required_text<'a>(params: &'a Map<String, Value>, name: &str) -> miette::Result<&'a str> {
	params
		.get(name)
		.and_then(Value::as_str)
		.ok_or_else(|| miette!("missing string `{name}`"))
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

fn terminal_id(value: Value) -> miette::Result<Str> {
	value
		.get("terminalId")
		.or_else(|| value.get("id"))
		.and_then(Value::as_str)
		.map(Str::from)
		.ok_or_else(|| miette!("ACP terminal/create response has no terminal id"))
}

fn terminal_snapshot(value: Value) -> Option<TerminalSnapshot> {
	let output = value
		.get("output")
		.and_then(Value::as_str)
		.unwrap_or_default();
	let truncated = value
		.get("truncated")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let status = value.get("exitStatus").or_else(|| value.get("exit_status"));
	let exit = status.and_then(|status| {
		if status.is_null() {
			return None;
		}
		let exit_code = status
			.get("exitCode")
			.or_else(|| status.get("exit_code"))
			.and_then(Value::as_i64)
			.and_then(|code| i32::try_from(code).ok());
		let signal = status.get("signal").and_then(Value::as_str).map(Str::from);
		(exit_code.is_some() || signal.is_some()).then_some(TerminalExit { exit_code, signal })
	});
	Some(TerminalSnapshot { output: Str::from(output), truncated, exit })
}

/// Operation delegated to an ACP client that owns the remote workspace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteOperation {
	/// Read a remote UTF-8 file.
	ReadText {
		/// ACP `fs/read_text_file.path`, resolved to an absolute workspace path.
		path:  Str,
		/// Optional one-based ACP `fs/read_text_file.line` at which reading
		/// begins.
		line:  Option<u64>,
		/// Optional ACP `fs/read_text_file.limit` maximum number of lines to
		/// return.
		limit: Option<u64>,
	},
	/// Write a remote UTF-8 file.
	WriteText {
		/// ACP `fs/write_text_file.path`, resolved to an absolute workspace path.
		path:    Str,
		/// UTF-8 payload carried by ACP `fs/write_text_file.content`.
		content: Str,
	},
	/// Spawn a remote terminal command through the host user's shell.
	StartTerminal {
		/// Executable carried by ACP `terminal/create.command`.
		command:           Str,
		/// Argument vector carried by ACP `terminal/create.args`.
		args:              Vec<Str>,
		/// Environment name-value pairs projected into ACP `terminal/create.env`.
		env:               BTreeMap<Str, Str>,
		/// Optional working directory carried by ACP `terminal/create.cwd`.
		cwd:               Option<Str>,
		/// ACP `terminal/create.outputByteLimit` cap in bytes.
		output_byte_limit: u64,
	},
	/// Poll a remote terminal's output and exit state.
	PollTerminal {
		/// ACP `terminal/output.terminalId` returned by `terminal/create`.
		terminal_id: Str,
	},
	/// Kill a previously spawned remote terminal.
	KillTerminal {
		/// ACP `terminal/kill.terminalId` returned by `terminal/create`.
		terminal_id: Str,
	},
	/// Release a remote terminal after its final output snapshot.
	ReleaseTerminal {
		/// ACP `terminal/release.terminalId` returned by `terminal/create`.
		terminal_id: Str,
	},
}

impl RemoteOperation {
	/// Wraps a shell line for a spec-conformant ACP client which spawns
	/// `command` plus `args` directly.
	pub fn shell(
		command: Str,
		cwd: Option<Str>,
		env: BTreeMap<Str, Str>,
		output_byte_limit: u64,
	) -> Self {
		#[cfg(windows)]
		let (shell, args) = {
			let shell = env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned());
			(Str::from(shell), vec![sf!("/D"), sf!("/S"), sf!("/C"), command])
		};
		#[cfg(not(windows))]
		let (shell, args) = {
			let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned());
			(Str::from(shell), vec![sf!("-l"), sf!("-c"), command])
		};
		Self::StartTerminal { command: shell, args, env, cwd, output_byte_limit }
	}

	/// Encodes this operation as a JSON-RPC request for the ACP client.
	pub fn request(&self, id: Value, session_id: &str) -> Value {
		let (method, arguments) = match self {
			Self::ReadText { path, line, limit } => (
				"fs/read_text_file",
				json!({"sessionId":session_id,"path":path,"line":line,"limit":limit}),
			),
			Self::WriteText { path, content } => {
				("fs/write_text_file", json!({"sessionId":session_id,"path":path,"content":content}))
			},
			Self::StartTerminal { command, args, env, cwd, output_byte_limit } => (
				"terminal/create",
				json!({"sessionId":session_id,"command":command,"args":args,"env":env.iter().map(|(name,value)|json!({"name":name,"value":value})).collect::<Vec<_>>(),"cwd":cwd,"outputByteLimit":output_byte_limit}),
			),
			Self::PollTerminal { terminal_id } => {
				("terminal/output", json!({"sessionId":session_id,"terminalId":terminal_id}))
			},
			Self::KillTerminal { terminal_id } => {
				("terminal/kill", json!({"sessionId":session_id,"terminalId":terminal_id}))
			},
			Self::ReleaseTerminal { terminal_id } => {
				("terminal/release", json!({"sessionId":session_id,"terminalId":terminal_id}))
			},
		};
		json!({"jsonrpc":"2.0","id":id,"method":method,"params":arguments})
	}
}

#[cfg(test)]
mod tests {

	use std::slice;

	use omp_proto::inference::v1::value;

	use super::*;

	#[test]
	fn canonical_auth_methods_follow_client_terminal_capability() {
		let agent_only = acp_auth_methods(false);
		assert_eq!(agent_only.len(), 1);
		assert_eq!(agent_only[0]["id"], "agent");
		let terminal = acp_auth_methods(true);
		assert_eq!(terminal[1]["type"], "terminal");
		assert_eq!(terminal[1]["id"], "terminal");
		assert_eq!(terminal[1]["args"], json!(["--acp-terminal-auth"]));
	}

	#[test]
	fn session_cwd_must_be_absolute_and_is_canonicalized() {
		assert!(canonical_session_root("relative").is_err());
		let directory = tempfile::tempdir().unwrap();
		assert_eq!(
			canonical_session_root(directory.path().to_str().unwrap()).unwrap(),
			directory.path().canonicalize().unwrap()
		);
	}

	#[test]
	fn converts_all_acp_content_families() {
		let (parts, updates) = convert_blocks(&json!([
			{"type":"text","text":"a"},
			{"type":"image","uri":"x"},
			{"type":"resource_link","uri":"y"},
			{"type":"audio"}
		]))
		.unwrap();
		assert_eq!(parts.len(), 4);
		assert_eq!(updates.len(), 4);
	}
	#[test]
	fn converts_nested_acp_text_and_image_resources() {
		let encoded = omp_core::base64::encode(b"image");
		let (parts, updates) = convert_blocks(&json!([
			{"type":"resource","resource":{"uri":"file:///context.txt","text":"IMPORTANT CONTEXT"}},
			{"type":"resource","resource":{"uri":"file:///image.png","mimeType":"image/png","blob":encoded}}
		]))
		.unwrap();
		assert!(matches!(
			&parts[0],
			ContentPart::Text { text, .. } if text.as_str() == "IMPORTANT CONTEXT"
		));
		assert!(matches!(
			&parts[1],
			ContentPart::Image(MediaInput::Bytes { media_type, data })
				if media_type.as_str() == "image/png" && data.as_ref() == b"image"
		));
		assert_eq!(updates[0]["content"]["resource"]["text"], "IMPORTANT CONTEXT");
	}
	#[test]
	fn command_prompt_settlements_always_close_the_turn() {
		assert_eq!(
			prompt_settlement("end_turn", true),
			json!({"stopReason":"end_turn","command":true})
		);
		assert_eq!(
			prompt_settlement("cancelled", true),
			json!({"stopReason":"cancelled","command":true})
		);
	}

	#[test]
	fn ask_elicitation_schema_covers_choice_multi_recommended_and_free_text() {
		let questions = vec![
			omp_tools::ask::Question {
				id:          sf!("approach"),
				question:    sf!("Which approach?"),
				header:      Some(sf!("Choose one")),
				options:     vec![
					omp_tools::ask::OptionItem {
						label:       sf!("A"),
						description: Some(sf!("Faster")),
						preview:     None,
					},
					omp_tools::ask::OptionItem {
						label:       sf!("B"),
						description: Some(sf!("Safer")),
						preview:     None,
					},
				],
				multi:       false,
				recommended: Some(1),
			},
			omp_tools::ask::Question {
				id:          sf!("features"),
				question:    sf!("Which features?"),
				header:      None,
				options:     vec![
					omp_tools::ask::OptionItem {
						label:       sf!("auth"),
						description: None,
						preview:     None,
					},
					omp_tools::ask::OptionItem {
						label:       sf!("search"),
						description: None,
						preview:     None,
					},
				],
				multi:       true,
				recommended: None,
			},
		];

		let schema = ask_elicitation_schema(&questions);
		assert_eq!(
			schema["properties"]["q0"],
			json!({
				"type":"string",
				"title":"Which approach?",
				"description":"Choose one",
				"oneOf":[
					{"const":"A","title":"A","description":"Faster"},
					{"const":"B","title":"B","description":"Safer"}
				],
				"default":"B"
			})
		);
		assert_eq!(
			schema["properties"]["q1"],
			json!({
				"type":"array",
				"title":"Which features?",
				"items":{"anyOf":[
					{"const":"auth","title":"auth"},
					{"const":"search","title":"search"}
				]}
			})
		);
		assert_eq!(
			schema["properties"]["q0__other"],
			json!({"type":"string","title":"Other (type your own)"})
		);
		assert!(schema.get("required").is_none());

		let answers = ask_answers(
			&questions,
			json!({"q0":"A","q0__other":" custom ","q1":["auth","unknown"]})
				.as_object()
				.expect("form content"),
		);
		assert_eq!(answers[0].selected, vec![sf!("A")]);
		assert_eq!(answers[0].custom_input.as_deref(), Some("custom"));
		assert_eq!(answers[1].selected, vec![sf!("auth")]);
		assert_eq!(answers[1].custom_input, None);
		assert!(answers.iter().all(|answer| !answer.timed_out));
		let free_text = omp_tools::ask::Question {
			id:          sf!("details"),
			question:    sf!("Explain"),
			header:      None,
			options:     Vec::new(),
			multi:       false,
			recommended: None,
		};
		assert!(omp_tools::ask::validate(slice::from_ref(&free_text)).is_ok());
		let free_schema = ask_elicitation_schema(slice::from_ref(&free_text));
		assert!(free_schema["properties"].get("q0").is_none());
		assert_eq!(
			free_schema["properties"]["q0__other"],
			json!({"type":"string","title":"Other (type your own)"})
		);
		let free_answers = ask_answers(
			&[free_text],
			json!({"q0__other":"free form"})
				.as_object()
				.expect("free-text form content"),
		);
		assert!(free_answers[0].selected.is_empty());
		assert_eq!(free_answers[0].custom_input.as_deref(), Some("free form"));
	}

	#[test]
	fn mapper_omits_internal_locations_and_extracts_diffs() {
		let root = Path::new("/repo");
		assert!(tool_locations(&json!({"path":"mcp://server/item"}), root).is_none());
		let result = thread::ToolResult {
			call_id: "call".into(),
			name: "edit".into(),
			details: Some(inference_wire::Value {
				kind: Some(value::Kind::Map(inference_wire::ValueMap {
					fields: BTreeMap::from([
						("path".into(), inference_wire::Value {
							kind: Some(value::Kind::String("src/lib.rs".into())),
						}),
						("oldText".into(), inference_wire::Value {
							kind: Some(value::Kind::String("a".into())),
						}),
						("newText".into(), inference_wire::Value {
							kind: Some(value::Kind::String("b".into())),
						}),
					]),
				})),
				..inference_wire::Value::default()
			}),
			..thread::ToolResult::default()
		};
		let details = result.details.as_ref().and_then(value_to_json).unwrap();
		let content = tool_result_content(&result, &details, root);
		assert_eq!(content[0]["type"], "diff");
		assert_eq!(content[0]["path"], "/repo/src/lib.rs");
	}

	#[test]
	fn remote_terminal_requests_wrap_shell_arguments_and_map_signals() {
		let request = RemoteOperation::shell(sf!("pwd"), None, BTreeMap::new(), 1024)
			.request(json!(7), "session");
		assert_eq!(request["method"], "terminal/create");
		#[cfg(not(windows))]
		assert_eq!(request["params"]["args"][2], "pwd");

		let snapshot = terminal_snapshot(json!({
			"output":"terminated",
			"exitStatus":{"exitCode":null,"signal":"SIGKILL"}
		}))
		.expect("terminal snapshot");
		let status = snapshot.exit.expect("terminal exit");
		assert_eq!(status.exit_code.or_else(|| status.signal.map(|_| 137)), Some(137));
	}
}
