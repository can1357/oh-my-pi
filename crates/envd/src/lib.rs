//! Environment-host composition for project-scoped filesystem, process,
//! document, tool, and extension authority.

/// ACP (Agent Client Protocol) wire transport — newline-delimited JSON-RPC,
/// typed serde structs, and cancel-safe correlation table.
pub mod acp_client;
/// Approval-tier resolution and env-owned invocation admission.
pub mod admission;
/// Approval prompts relayed to the connection that issued a daemon command.
mod approval_relay;
pub mod blobs;
/// Supervised browser automation, fetch, and relay. Compiled only with
/// `cap-browser`.
#[cfg(feature = "cap-browser")]
pub mod browser_daemon;
/// Ephemeral browser fetch for inference search. Compiled only with
/// `cap-browser`.
#[cfg(feature = "cap-browser")]
pub mod browser_fetch;
/// Native Chrome-extension CDP relay. Compiled only with `cap-browser`.
#[cfg(feature = "cap-browser")]
pub mod browser_relay;
/// The environment a spawned child process is allowed to see.
pub mod child_env;
mod child_tree;
/// Codex `app-server` adapter for the delegated-executor contract (ADR 0043).
pub mod codex_app_server;
#[cfg(feature = "cap-computer")]
mod computer;
pub mod daemon_policy;
mod devices_host;
mod direnv;
pub mod docs;
/// Local document authority: filesystem, revision, transaction, watch, and
/// language-server operations.
pub mod docserver;
pub mod document_cache;
mod editor_base;
/// Write-back of committed bytes to the ACP editor, on a per-path queue owned
/// by the editor's connection (ADR 0037 §4).
pub mod editor_sync;
pub mod eval;
pub mod exec;
mod exec_network_diag;
mod exec_sandbox;
pub mod exec_settings;
pub mod ext_git;
pub mod exthost;
/// The hosts a fetch reaches and the approval subjects keyed on them.
pub mod fetch_host;
#[cfg(any(feature = "cap-forge", feature = "cap-ci"))]
mod forge_adapter;
#[cfg(feature = "cap-forge")]
pub use forge_adapter::CheckoutForge;
pub mod forge_url;
mod forge_worktree;
pub mod host_info;
pub mod host_settings;
mod http_egress;
mod journal_runtime;
/// Shared cancel-safe, size-capped newline reader used by both `acp_client`
/// and `codex_app_server`.
pub mod line_reader;
#[cfg(test)]
mod loopback_upstream;
pub mod lsp_settings;
mod managed_skills;
pub mod mcp;
/// Image generation, speech synthesis, and ask playback. Compiled only with
/// `cap-media`, which links `omp-audio`.
#[cfg(feature = "cap-media")]
mod media_devices;
/// Text-to-speech producer for the `tts` device. Compiled only with
/// `cap-media`. `local-tts` selects Kokoro inside this module and does not
/// compile it on its own.
#[cfg(feature = "cap-media")]
mod media_tts;
pub mod memory;
pub mod model_discovery;
#[cfg(test)]
mod plan_writes;
pub mod plugin_commands;
pub mod policy;
mod presence;
pub mod process_identity;
pub mod process_log;
pub mod process_store;
pub mod recovery;
/// Memory reflections relayed to the connection that issued a daemon `reflect`.
mod reflection_relay;
mod report_issue;
mod resource_materializer;
mod sandbox_proxy;
mod schedule_plan;
pub mod schedules;
pub mod search_backend;
mod security_scan;
mod server;
/// Hidden in-process shell child used by detached named processes.
pub mod shell_child;
pub mod site;
#[cfg(all(test, unix))]
mod test_process;
mod tool_ast_grep;
mod tool_debug;
mod tool_document;
mod tool_lsp;
mod tool_read_sources;
mod tool_search;
pub mod tool_settings;
/// Shell-tool execution, managed process sessions, and shell URI resolution.
pub mod tool_shell;
pub mod tool_url;
pub use tool_url::scheme_generation::{
	LiveScheme, SchemeClaim, SchemeFoldError, SchemeGeneration, WRITE_NOT_ENABLED,
};
mod tools;
mod vault;
pub mod vcs;
#[cfg(windows)]
pub mod windows;
pub mod worker;
pub mod worker_child;
pub mod worker_pool;
pub mod worker_process;

pub mod workspace;
pub mod workspace_roots;
pub mod write_scope;
use std::{
	env,
	fs::{self, OpenOptions},
	io,
	io::Write as _,
	path::{Path, PathBuf},
	process::{Stdio, id},
	sync::{
		Arc, Weak,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
#[doc(hidden)]
pub use eval::{EVAL_CHILD_ARG, run_eval_child_entry};
pub use exthost::{
	ControlAuthorityFactory, EnvdControlAuthorities, ExternalControlAuthorities,
	HostControlAuthorityFactory,
};
use exthost::{
	ExtensionManifest,
	control::{ControlAuthority, ControlCompositionError, ControlConnectionIdentity},
	dispatch::CallbackDispatcher,
};
use forge_url::ForgeCredentialBridge;
use miette::IntoDiagnostic as _;
#[cfg(unix)]
use nix::{
	sys::signal::{self, Signal},
	unistd::{Pid, User},
};
use omp_ai::auth::AuthControlHandle;
use omp_con::Ctx;
use omp_contract::KernelSender;
use omp_core::{Str, Ulid, sf};
use omp_env::{
	AcpRequest, EnvClient, PartitionedEnvTransport, in_process_frames, project_state::DaemonPolicy,
};
use omp_ext::{config::ContributedCliValue, workspace_trust::WorkspaceTrust};
use omp_proto::{
	env::v1::{
		AcpBind, AcpDocumentAnswer, ApprovalMode as ProtoApprovalMode, ClientHello, EditRepairAnswer,
		EditRepairFailure, EditRepairFailureCode, ProtocolError, ProtocolErrorCode, RegisterPresence,
		ReleasePresence, ServerHello, acp_document_answer, edit_repair_answer,
	},
	inference::v1::{Value, ValueMap, value},
};
use omp_tool::Registry;
use omp_tools::eval::EvalSessionControl;
use parking_lot::RwLock;
pub use presence::PresenceError;
/// Generation-fenced lease routing environment checkpoint controls to one
/// active Agent session.
pub use server::AgentControlBinding;
pub use server::{EnvServer, EnvdError, ExtensionDataBinding, document_user_config_root};
pub use site::validate_trusted_module;
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::{
	process,
	task::{AbortHandle, JoinHandle, JoinSet},
	time::{self, Instant},
};
use tokio_util::sync::CancellationToken;
pub use tools::{
	ActiveContentInputs, CommandCredentialExecutorFactory, ContentResolver, DeviceCatalogObserver,
	DeviceControlFactory, DeviceInvocationAdmission, DynamicDeviceCatalogEntry, DynamicTool,
	DynamicToolFactory, GoalAuthority, HostResourceResult, HostResources, HostUriJudgment,
	RegistryBridges, RegistryControlFactory, SearchInference, TelemetryUpload,
};

use self::{
	tool_settings::ApprovalMode,
	worker::{ExtHostConfig, ExtHostSpec},
};
use crate::eval::{BridgeHostError, ParentSessionHost};

omp_con::var! {
	/// Enables authored and managed skill discovery.
	pub static SV_SKILLS_ENABLED = sv_skills_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"legacy.path": "skills.enabled",
		},
	};
	/// Additional authored skill roots.
	pub static SV_SKILLS_CUSTOM_DIRECTORIES = sv_skills_custom_directories: Vec<Str> {
		default: Vec::new(),
		flags: archive,
		meta: {
			"legacy.path": "skills.customDirectories",
		},
	};
	/// Skill names excluded before publication.
	pub static SV_SKILLS_IGNORE = sv_skills_ignore: Vec<Str> {
		default: Vec::new(),
		flags: archive,
		meta: {
			"legacy.path": "skills.ignoredSkills",
		},
	};
	/// Optional skill-name inclusion filters.
	pub static SV_SKILLS_INCLUDE = sv_skills_include: Vec<Str> {
		default: Vec::new(),
		flags: archive,
		meta: {
			"legacy.path": "skills.includeSkills",
		},
	};
	/// Render non-JSON MCP text results as Markdown in the transcript.
	pub static SV_MCP_RENDER_MARKDOWN_RESULTS = sv_mcp_render_markdown_results: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Discovery & MCP",
			"ui.label": "MCP Markdown Results",
			"legacy.path": "mcp.renderMarkdownResults",
		},
	};
	/// Inject MCP resource updates into the agent conversation.
	pub static SV_MCP_NOTIFICATIONS = sv_mcp_notifications: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Discovery & MCP",
			"ui.label": "MCP Update Injection",
			"legacy.path": "mcp.notifications",
		},
	};
	/// Debounce window for MCP resource updates before injecting them into the conversation.
	pub static SV_MCP_NOTIFICATION_DEBOUNCE_MS = sv_mcp_notification_debounce_ms: i64 {
		default: 500,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Discovery & MCP",
			"ui.label": "MCP Notification Debounce",
			"ui.unit": "ms",
			"legacy.path": "mcp.notificationDebounceMs",
		},
	};
	/// Positive finite active-work timeout for extension tool_call handlers; time awaiting OMP-owned dialogs does not count.
	pub static AI_EXTENSION_HANDLERS_TOOL_CALL_TIMEOUT_MS = ai_extension_handlers_tool_call_timeout_ms: i64 {
		default: 30000,
		validate: |_ctx, value| {
			if *value > 0 {
				Ok(())
			} else {
				Err(Str::new_static("extension tool-call timeout must be positive"))
			}
		},
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Extensions",
			"ui.label": "Tool Call Handler Timeout (ms)",
			"ui.unit": "ms",
			"legacy.path": "extensionHandlers.toolCallTimeoutMs",
		},
	};
}

// Browser CDP and relay settings. These convars exist only with `cap-browser`,
// beside `SV_BROWSER_ENABLED` and `SV_BROWSER_HEADLESS` in `browser_daemon`.
// With the feature off the construction table has no Browser row, so a setting
// cannot reinstall it.
#[cfg(feature = "cap-browser")]
omp_con::var! {
	/// Default HTTP CDP discovery endpoint used when no tool-call endpoint is provided.
	pub static SV_BROWSER_CDP_URL = sv_browser_cdp_url: Str {
		default: Str::new_static(""),
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Grep & Browser",
			"ui.label": "Browser CDP URL",
			"legacy.path": "browser.cdpUrl",
		},
	};
	/// Drive the user's Chrome tabs through the omp browser relay.
	pub static SV_BROWSER_RELAY = sv_browser_relay: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Grep & Browser",
			"ui.label": "Browser Relay",
			"legacy.path": "browser.relay",
		},
	};
	/// omp browser relay endpoint.
	pub static SV_BROWSER_RELAY_URL = sv_browser_relay_url: Str {
		default: Str::new_static(""),
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Grep & Browser",
			"ui.label": "Browser Relay URL",
			"legacy.path": "browser.relayUrl",
		},
	};
}

/// Resolves the extension `tool_call` handler deadline at environment-host
/// activation.
#[must_use]
pub fn extension_tool_call_timeout(ctx: &Ctx) -> Duration {
	let milliseconds = u64::try_from(AI_EXTENSION_HANDLERS_TOOL_CALL_TIMEOUT_MS.get(ctx))
		.expect("the convar minimum keeps extension handler timeouts positive");
	Duration::from_millis(milliseconds)
}

static ATOMIC_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
mod settings_tests {
	use super::*;

	#[test]
	fn extension_tool_call_timeout_resolves_positive_milliseconds() {
		let ctx = Ctx::new();
		assert_eq!(extension_tool_call_timeout(&ctx), Duration::from_secs(30));
		AI_EXTENSION_HANDLERS_TOOL_CALL_TIMEOUT_MS
			.set(&ctx, 125)
			.expect("set extension handler timeout");
		assert_eq!(extension_tool_call_timeout(&ctx), Duration::from_millis(125));
		assert!(
			AI_EXTENSION_HANDLERS_TOOL_CALL_TIMEOUT_MS
				.set(&ctx, 0)
				.is_err()
		);
	}
}

/// Renders a fault cause once at this model-facing fault boundary.
pub(crate) fn fault(cause: impl std::fmt::Display) -> Str {
	sf!("{cause}")
}

/// Renders a contextualized fault cause once at this model-facing fault
/// boundary.
pub(crate) fn fault_in(context: impl std::fmt::Display, cause: impl std::fmt::Display) -> Str {
	sf!("{context}: {cause}")
}

pub(crate) fn atomic_replace(path: &Path, content: &str) -> io::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	let sequence = ATOMIC_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
	let name = path
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("state");
	let temporary = path.with_file_name(format!(".{name}.{}.{}.tmp", id(), sequence));
	let mut options = OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt as _;
		options.mode(0o600);
	}
	let mut file = options.open(&temporary)?;
	let result = (|| {
		file.write_all(content.as_bytes())?;
		file.sync_all()?;
		drop(file);
		replace_atomic_path(&temporary, path)?;
		#[cfg(unix)]
		if let Some(parent) = path.parent() {
			fs::File::open(parent)?.sync_all()?;
		}
		Ok(())
	})();
	if result.is_err() {
		let _ = fs::remove_file(&temporary);
	}
	result
}

const LAUNCHER_BUILD_FILE: &str = "launcher-build";

fn launcher_build_path(state_dir: &Path) -> PathBuf {
	state_dir.join(LAUNCHER_BUILD_FILE)
}

fn publish_launcher_build(state_dir: &Path) -> io::Result<()> {
	atomic_replace(&launcher_build_path(state_dir), omp_env::build_id::current())
}

pub(crate) fn launcher_build_is_stale(state_dir: &Path, server_build: &str) -> bool {
	fs::read_to_string(launcher_build_path(state_dir))
		.is_ok_and(|latest| omp_env::build_id::is_stale(latest.trim(), server_build))
}

fn replace_atomic_path(temporary: &Path, path: &Path) -> io::Result<()> {
	match fs::rename(temporary, path) {
		Ok(()) => Ok(()),
		#[cfg(windows)]
		Err(original) if original.raw_os_error() == Some(5) => {
			let backup = path.with_extension(format!("{}.bak", id()));
			match fs::rename(path, &backup) {
				Ok(()) => {},
				Err(error) if error.kind() == io::ErrorKind::NotFound => {
					return fs::rename(temporary, path);
				},
				Err(_) => return Err(original),
			}
			if let Err(error) = fs::rename(temporary, path) {
				let _ = fs::rename(&backup, path);
				return Err(error);
			}
			let _ = fs::remove_file(backup);
			Ok(())
		},
		Err(error) => Err(error),
	}
}

/// Owned configuration for one project environment daemon.
#[derive(Clone, Debug)]
pub struct EnvdConfig {
	/// Workspace root exposed by the environment.
	pub root:             PathBuf,
	/// Owner-only environment socket, or the state-directory default.
	pub socket:           Option<PathBuf>,
	/// Document-server socket, or the state-directory default.
	pub docserver_socket: Option<PathBuf>,
	/// Environment state directory, or the project-keyed data-directory default.
	pub state_dir:        Option<PathBuf>,
	/// Whether built-in Python expression evaluation is enabled.
	pub py_eval:          bool,
	/// Seconds without connected applications before the daemon exits.
	pub idle_timeout:     u64,
	/// The workspace trust decision the daemon loads project inputs under
	/// (project MCP servers, LSP/DAP configuration, hosts and vaults); part of
	/// its policy, so it keys the default environment socket. The spawning
	/// session hands its own decision down.
	pub workspace_trust:  WorkspaceTrust,
}

/// One startup client's daemon-owned project presence.
///
/// Dropping the handle closes the owner connection, which releases the lease
/// even when orderly RPC release cannot run.
#[must_use]
pub struct ClientPresenceLease {
	client:   EnvClient,
	lease_id: Bytes,
	bridge:   AbortHandle,
}

impl ClientPresenceLease {
	/// Removes the durable presence record before closing the owner connection.
	pub async fn close(self) -> Result<(), EnvdError> {
		self
			.client
			.release_presence(ReleasePresence { lease_id: self.lease_id.clone(), props: None })
			.await?;
		Ok(())
	}
}

impl Drop for ClientPresenceLease {
	fn drop(&mut self) {
		self.bridge.abort();
	}
}

/// Registers one launch-shaped application process with the project daemon
/// that enforces the sandbox and approval policy `con` resolves under the
/// workspace `trust`.
#[cfg(any(unix, windows))]
#[tracing::instrument(
	name = "project_presence_register",
	level = "debug",
	skip_all,
	fields(project_root = %project_root.display(), kind)
)]
pub async fn register_project_presence(
	project_root: &Path,
	data_dir: &Path,
	kind: &'static str,
	con: &Ctx,
	trust: WorkspaceTrust,
) -> Result<ClientPresenceLease, EnvdError> {
	let root = fs::canonicalize(project_root)?;
	let state_dir = omp_env::project_state::directory(data_dir, &root)?;
	publish_launcher_build(&state_dir)?;
	let policy = daemon_policy::from_con(con, trust);
	let socket = omp_env::project_state::environment_socket(&state_dir, &policy)?;
	let (client, bridge) = match connect_presence_owner(&socket).await {
		Ok(connection) => connection,
		Err(EnvdError::Io(error))
			if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused) =>
		{
			spawn_project_daemon(
				&root,
				&state_dir,
				&socket,
				&omp_env::project_state::document_socket(&state_dir),
				false,
				None,
				trust,
				&policy,
			)
			.await?;
			connect_presence_owner(&socket).await?
		},
		Err(error) => return Err(error),
	};
	if let Err(error) = hello(&client)
		.await
		.and_then(|served| verify_daemon_policy(&served, &socket, &policy))
	{
		bridge.abort();
		return Err(error);
	}
	let client_id = Ulid::generate().to_string();
	let registered = match client
		.register_presence(RegisterPresence {
			client_id: Bytes::copy_from_slice(client_id.as_bytes()),
			pid:       id(),
			kind:      kind.to_owned(),
			props:     None,
		})
		.await
	{
		Ok(registered) => registered,
		Err(error) => {
			bridge.abort();
			return Err(error.into());
		},
	};
	tracing::debug!(pid = id(), kind, "project presence registered");
	Ok(ClientPresenceLease { client, lease_id: registered.lease_id, bridge })
}

/// Reports that client-presence registration needs a local Environment
/// transport.
#[cfg(not(any(unix, windows)))]
pub async fn register_project_presence(
	_project_root: &Path,
	_data_dir: &Path,
	_kind: &'static str,
	_con: &Ctx,
	_trust: WorkspaceTrust,
) -> Result<ClientPresenceLease, EnvdError> {
	Err(
		io::Error::new(
			io::ErrorKind::Unsupported,
			"client presence requires a local Environment transport",
		)
		.into(),
	)
}

#[cfg(unix)]
async fn connect_presence_owner(socket: &Path) -> Result<(EnvClient, AbortHandle), EnvdError> {
	let (client, bridge) = EnvServer::connect_owner_uds(socket).await?;
	let abort = bridge.abort_handle();
	drop(bridge);
	Ok((client, abort))
}

#[cfg(windows)]
async fn connect_presence_owner(socket: &Path) -> Result<(EnvClient, AbortHandle), EnvdError> {
	use crate::windows::connect_owner_pipe;
	let (client, bridge) = connect_owner_pipe(socket)?;
	let abort = bridge.abort_handle();
	drop(bridge);
	Ok((client, abort))
}

/// Copies session-local artifacts into the replacement session root.
pub fn migrate_session_artifacts(
	sessions_dir: &Path,
	source_session: &str,
	destination_session: &str,
) -> Result<(), io::Error> {
	tool_url::local::migrate_session_artifacts(sessions_dir, source_session, destination_session)
}

/// Starts the project environment daemon and serves until process shutdown.
#[cfg(unix)]
pub async fn run(
	config: EnvdConfig,
	con: Arc<Ctx>,
	bridges: RegistryBridges,
) -> miette::Result<()> {
	server::run(config, con, bridges).await.into_diagnostic()
}

/// Starts the Windows named-pipe project environment daemon.
#[cfg(windows)]
pub async fn run(
	config: EnvdConfig,
	con: Arc<Ctx>,
	bridges: RegistryBridges,
) -> miette::Result<()> {
	windows::run(config, con, bridges).await.into_diagnostic()
}

/// Reports that no owner-local environment transport exists on this target.
#[cfg(not(any(unix, windows)))]
pub async fn run(
	config: EnvdConfig,
	con: Arc<Ctx>,
	bridges: RegistryBridges,
) -> miette::Result<()> {
	server::run(config, con, bridges).await.into_diagnostic()
}

/// Options for attaching a session composition to its detached project daemon.
pub struct AttachOptions {
	/// Whether built-in Python expression evaluation is enabled.
	pub py_eval:            bool,
	/// Optional approval-mode override retained by this composition.
	pub approval_mode:      Option<ApprovalMode>,
	/// Trusted extension hosts available to this composition.
	pub trusted_extensions: Vec<ExtHostSpec>,
	/// Extension-contributed command-line values available to workers.
	pub contributed_values: Vec<ContributedCliValue>,
	/// Process control context used to compose the session host or an embedded
	/// fallback.
	pub con:                Arc<Ctx>,
	/// Composition-supplied capabilities the environment host cannot own. Its
	/// [`ActiveContentInputs::workspace_trust`] is part of the daemon policy:
	/// a session joins only a daemon started under its own decision.
	pub bridges:            RegistryBridges,
	/// Optional idle timeout forwarded only when this attach spawns the daemon.
	pub spawn_idle_timeout: Option<u64>,
	/// The sandbox, approval and workspace trust policy a project daemon
	/// spawned now would enforce: the one `omp envd` resolves from the
	/// configuration files alone under the session's workspace trust. When it
	/// differs from the policy `con` resolves (in-process settings such as
	/// `--add-dir` roots, a cfg profile or an agent class), no daemon is
	/// spawned, because none could be joined, and the session runs embedded at
	/// once. `None` spawns one and checks its hello.
	pub spawn_policy:       Option<DaemonPolicy>,
}

/// Client-side ownership of one project environment composition.
///
/// Dropping this value shuts down only servers and children started by this
/// composition. An existing owner environment remains untouched.
pub struct ProjectEnvironment {
	pub(crate) client:   EnvClient,
	/// Warning shown when this composition had to fall back to an embedded host.
	pub fallback_notice: Option<Str>,
	pub(crate) registry: Arc<Registry>,
	eval_bridge:         Arc<eval::SessionBridgeHost>,
	reflection_bridge:   Arc<memory::ReflectionBridgeHost>,
	eval_control:        EvalSessionControl,
	search_bridge:       Arc<search_backend::SearchBridgeHost>,
	github_credentials:  Arc<ForgeCredentialBridge>,
	acp_documents:       AcpDocumentsBinding,
	/// The route an attached session answers the daemon's relayed approval
	/// prompts with; `None` for embedded and isolated compositions, whose host
	/// prompts through its own in-process route.
	approval_relay:      Option<approval_relay::ApprovalRelayBinding>,
	lifecycle:           ProjectLifecycle,
}
/// Cloneable authority for replacing the Environment's extension worker
/// generation.
#[derive(Clone)]
pub struct ExtensionReloadHandle {
	server: Arc<EnvServer>,
}

impl ExtensionReloadHandle {
	/// Drains idle extension hosts and starts their hot-reload generations.
	pub async fn reload(&self) -> Result<Vec<u64>, worker::ExtHostError> {
		self.server.reload_extensions().await
	}

	/// Respawns only the child which owns `extension`.
	pub async fn reload_extension(&self, extension: &str) -> Result<u64, worker::ExtHostError> {
		self.server.reload_extension(extension).await
	}

	/// Quarantines each newly revoked extension host while keeping its static
	/// unavailable routes registered.
	pub async fn quarantine(&self, extensions: &[Str]) {
		self.server.quarantine_extensions(extensions).await;
	}

	/// Returns every registry sealed by the current post-reload generations.
	pub fn registry_evidences(&self) -> Vec<Arc<exthost::extensions::SealedRegistryEvidence>> {
		self.server.extension_registry_evidences()
	}
}

/// Cloneable authority for retained MCP inspection and authentication commands.
#[derive(Clone)]
pub struct McpInspectorHandle {
	manager: Arc<mcp::manager::McpManager>,
}

impl McpInspectorHandle {
	/// Captures every live MCP catalog once at the current manager generation.
	pub fn snapshots(&self) -> Vec<mcp::manager::McpInspectorSnapshot> {
		self.manager.inspector_snapshots()
	}

	/// Atomically snapshots the current MCP leaf catalog and subscribes to exact
	/// tool/resource/prompt diffs which follow it.
	pub fn subscribe_definitions(
		&self,
	) -> (
		omp_tool::LeafCatalogSnapshot<mcp::McpLeaf>,
		flume::Receiver<mcp::manager::McpDefinitionDiff>,
	) {
		self.manager.subscribe_definitions()
	}

	/// Subscribes to setting-gated, URI-debounced MCP resource updates.
	pub fn subscribe_resource_updates(&self) -> flume::Receiver<mcp::manager::McpResourceUpdate> {
		self.manager.subscribe_resource_updates()
	}

	/// Manually reconnects one server, clearing its burst circuit breaker
	/// (`/mcp reconnect`, `/mcp test`).
	pub async fn reconnect(&self, name: &str) -> Result<(), mcp::manager::ManagerError> {
		self.manager.reset(name).await
	}

	/// Re-reads the native user/project configs and replaces the mounted
	/// server set (`/mcp reload`).
	pub async fn reload(&self) -> Result<mcp::manager::StartupSnapshot, mcp::McpServiceError> {
		self.manager.service().reload_native_configs().await
	}

	/// Deletes one server's credential from the shared encrypted store and
	/// drops its authenticated connection.
	pub async fn clear_authorization(&self, name: &str) -> Result<bool, mcp::manager::ManagerError> {
		self.manager.clear_authorization(name).await
	}

	/// Runs a cancellable fresh OAuth grant while exposing browser or device
	/// authorization instructions to the application shell.
	pub async fn reauthorize<F>(
		&self,
		name: &str,
		present: F,
		cancel: CancellationToken,
	) -> Result<bool, mcp::manager::ManagerError>
	where
		F: for<'a> Fn(mcp::oauth::OAuthPresentation<'a>) + Send + Sync,
	{
		self.manager.reauthorize(name, &present, cancel).await
	}
}

struct ProjectLifecycle {
	shutdown:    Option<CancellationToken>,
	tasks:       Vec<JoinHandle<()>>,
	abort_tasks: Vec<AbortHandle>,
	server:      Arc<EnvServer>,
}

impl Drop for ProjectLifecycle {
	fn drop(&mut self) {
		if let Some(shutdown) = &self.shutdown {
			shutdown.cancel();
		}
		for task in &self.tasks {
			task.abort();
		}
		for task in &self.abort_tasks {
			task.abort();
		}
	}
}

fn bind_command_credentials(
	server: &EnvServer,
	factory: Option<Arc<dyn CommandCredentialExecutorFactory>>,
	dynamic_tools: &[Arc<dyn DynamicToolFactory>],
	client: EnvClient,
	dynamic_client: EnvClient,
	root: &Path,
) {
	if let Some(factory) = factory {
		server
			.mcp_manager()
			.bind_command_executor(factory.make(client, root));
	}
	for factory in dynamic_tools {
		factory.bind(dynamic_client.clone(), root);
	}
}

impl ProjectEnvironment {
	/// Attaches to the detached daemon for this project, spawning it on demand.
	///
	/// If the daemon cannot be spawned or reached, this returns an embedded
	/// composition whose [`Self::fallback_notice`] explains the degraded
	/// document-lifetime behavior.
	#[cfg(any(unix, windows))]
	#[tracing::instrument(
		name = "environment_attach",
		level = "debug",
		skip_all,
		fields(root = %root.display(), state_dir = %state_dir.display())
	)]
	pub async fn attach(
		root: &Path,
		state_dir: &Path,
		options: AttachOptions,
	) -> Result<Self, EnvdError> {
		publish_launcher_build(state_dir)?;
		let trust = options.bridges.content.workspace_trust;
		let policy = daemon_policy::from_con(&options.con, trust);
		let socket = omp_env::project_state::environment_socket(state_dir, &policy)?;
		let docserver_socket = omp_env::project_state::document_socket(state_dir);
		let interrupt_grace = host_settings::SV_INTERRUPT_GRACE.get(&options.con);
		match attach_owner(
			root,
			state_dir,
			&socket,
			&docserver_socket,
			options.py_eval,
			options.spawn_idle_timeout,
			trust,
			&policy,
			options.spawn_policy.as_ref(),
		)
		.await
		{
			Ok((owner, owner_bridge)) => {
				let AttachOptions {
					py_eval,
					approval_mode,
					trusted_extensions,
					contributed_values,
					con,
					bridges,
					spawn_idle_timeout: _,
					spawn_policy: _,
				} = options;
				Self::connect_peer(
					root,
					state_dir,
					&socket,
					&policy,
					py_eval,
					approval_mode,
					&trusted_extensions,
					&contributed_values,
					interrupt_grace,
					con,
					owner,
					owner_bridge,
					bridges,
				)
				.await
			},
			Err(error) => {
				Self::start_attach_fallback(root, state_dir, &docserver_socket, options, error).await
			},
		}
	}

	#[cfg(any(unix, windows))]
	async fn start_attach_fallback(
		root: &Path,
		state_dir: &Path,
		docserver_socket: &Path,
		options: AttachOptions,
		error: EnvdError,
	) -> Result<Self, EnvdError> {
		let notice = sf!(
			"project daemon unavailable ({error}); running an embedded environment — other omp \
			 sessions in this project may lose document access when this one exits"
		);
		tracing::warn!(%error, "project daemon unavailable; using embedded environment");
		let mut environment = Self::start_embedded(
			root,
			state_dir,
			docserver_socket,
			options.py_eval,
			&options.trusted_extensions,
			&options.contributed_values,
			options.con,
			options.bridges,
		)
		.await?;
		environment.fallback_notice = Some(notice);
		Ok(environment)
	}

	/// Starts an isolated in-process environment from one exact control context.
	///
	/// This path never joins or reuses an existing environment owner, so every
	/// tool and security owner is composed from `con` for `root`.
	#[tracing::instrument(
		name = "environment_start",
		level = "debug",
		skip_all,
		fields(
			mode = "embedded",
			root = %root.display(),
			state_dir = %state_dir.display(),
			py_eval,
			extensions = trusted_extensions.len()
		)
	)]
	pub(crate) async fn start_embedded(
		root: &Path,
		state_dir: &Path,
		docserver_socket: &Path,
		py_eval: bool,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		con: Arc<Ctx>,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let interrupt_grace = host_settings::SV_INTERRUPT_GRACE.get(&con);
		let command_credentials = bridges.command_credentials.clone();
		let dynamic_tool_factories = bridges.dynamic_tool_factories.clone();
		let (worker_config, data_bindings) = worker_config(
			state_dir,
			py_eval,
			trusted_extensions,
			contributed_values,
			interrupt_grace,
		)?;
		let convars = Arc::new(exthost::ConvarControlFactory::new(Arc::clone(&con)));
		let server = EnvServer::open_project(
			root,
			state_dir,
			docserver_socket,
			Registry::new(),
			worker_config,
			None,
			false,
			None,
			con.as_ref(),
			convars,
			bridges,
		)
		.await?;
		let server = Arc::new(server);
		let registry = server.registry();
		let eval_bridge = server.eval_bridge();
		let reflection_bridge = server.reflection_bridge();
		let eval_control = server.eval_control();
		let search_bridge = server.search_bridge();
		let github_credentials = server.github_credentials();
		let (client, transport) = EnvClient::in_process(64);
		bind_command_credentials(
			&server,
			command_credentials,
			&dynamic_tool_factories,
			client.clone(),
			client.clone(),
			root,
		);
		let in_process_server = Arc::clone(&server);
		let in_process =
			tokio::spawn(async move { in_process_server.serve_in_process(transport).await });
		let shutdown = CancellationToken::new();
		let mut tasks = vec![in_process];
		let acp_documents = spawn_acp_pump(&client, &shutdown, &mut tasks);
		spawn_extension_data_servers(&server, data_bindings, &shutdown, &mut tasks);
		hello(&client).await?;
		let lifecycle =
			ProjectLifecycle { shutdown: Some(shutdown), tasks, abort_tasks: Vec::new(), server };
		Ok(Self {
			client,
			fallback_notice: None,
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			acp_documents,
			approval_relay: None,
			lifecycle,
		})
	}

	/// Joins the project as a peer of an already-running owner environment.
	///
	/// Session tools execute on the slim in-process host while environment
	/// frames route over a fresh daemon connection. Dropping this composition
	/// closes only those two client connections and never retires the daemon.
	#[tracing::instrument(
		name = "environment_connect",
		level = "debug",
		skip_all,
		fields(
			root = %root.display(),
			state_dir = %state_dir.display(),
			py_eval,
			extensions = trusted_extensions.len()
		)
	)]
	async fn connect_peer(
		root: &Path,
		state_dir: &Path,
		socket: &Path,
		policy: &DaemonPolicy,
		py_eval: bool,
		approval_mode: Option<ApprovalMode>,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		interrupt_grace: omp_core::Duration,
		con: Arc<Ctx>,
		owner_client: EnvClient,
		owner_bridge: JoinHandle<()>,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let command_credentials = bridges.command_credentials.clone();
		let dynamic_tool_factories = bridges.dynamic_tool_factories.clone();
		let edit_model = bridges.edit_model.clone();
		let edit_repair = bridges.edit_repair.clone();
		let has_edit_repair = edit_repair.is_some();
		let (worker_config, data_bindings) = worker_config(
			state_dir,
			py_eval,
			trusted_extensions,
			contributed_values,
			interrupt_grace,
		)?;
		let convars = Arc::new(exthost::ConvarControlFactory::new(Arc::clone(&con)));
		let server = EnvServer::open_session_host(
			root,
			state_dir,
			Registry::new(),
			worker_config,
			approval_mode,
			con.as_ref(),
			convars,
			bridges,
			owner_client,
		)
		.await?;
		let server = Arc::new(server);
		let registry = server.registry();
		let eval_bridge = server.eval_bridge();
		let reflection_bridge = server.reflection_bridge();
		let search_bridge = server.search_bridge();
		let github_credentials = server.github_credentials();

		let (local_pipe, local_transport) = in_process_frames(64);
		let local_server = Arc::clone(&server);
		let local_task =
			tokio::spawn(async move { local_server.serve_in_process(local_transport).await });
		#[cfg(unix)]
		let (remote_pipe, remote_pump) = EnvServer::connect_owner_uds_frames(socket).await?;
		#[cfg(windows)]
		let (remote_pipe, remote_pump) = omp_env::windows::connect_owner_pipe_frames(socket)?;
		let remote_tools = Arc::new(tools::environment_tool_names(registry.as_ref()));
		let (client, partition) =
			PartitionedEnvTransport::spawn(local_pipe, remote_pipe, remote_tools);
		let eval_control = EvalSessionControl::from_client(client.clone());
		bind_command_credentials(
			&server,
			command_credentials,
			&dynamic_tool_factories,
			client.clone(),
			client.clone(),
			root,
		);

		let abort_tasks = vec![partition.abort_handle(), remote_pump.abort_handle()];
		let partition_task = tokio::spawn(async move {
			match partition.await {
				Ok(Ok(())) => {},
				Ok(Err(error)) => tracing::warn!(%error, "partitioned environment router stopped"),
				Err(error) if error.is_cancelled() => {},
				Err(error) => tracing::warn!(%error, "partitioned environment router task failed"),
			}
		});
		let remote_task = tokio::spawn(async move {
			match remote_pump.await {
				Ok(Ok(())) => {},
				Ok(Err(error)) => tracing::warn!(%error, "remote environment frame pump stopped"),
				Err(error) if error.is_cancelled() => {},
				Err(error) => tracing::warn!(%error, "remote environment frame pump task failed"),
			}
		});
		let shutdown = CancellationToken::new();
		let mut tasks = vec![local_task, partition_task, remote_task, owner_bridge];
		let acp_documents = spawn_acp_pump(&client, &shutdown, &mut tasks);
		if let Some(edit_repair) = edit_repair {
			let repair_client = client.clone();
			let repair_shutdown = shutdown.clone();
			tasks.push(tokio::spawn(async move {
				pump_edit_repair_requests(repair_client, edit_repair, repair_shutdown).await;
			}));
		}
		// The daemon's host binds no approval route: it relays its commands'
		// prompts to this connection, which answers them through the session's.
		let approval_relay = approval_relay::spawn_approval_pump(&client, &shutdown, &mut tasks);
		// Nor does it own a model: the reflections its `reflect` calls need are
		// relayed here and synthesized through this composition's bridge, the
		// one the driver binds to the session's inference.
		reflection_relay::spawn_reflection_pump(
			&client,
			Arc::clone(&reflection_bridge) as Arc<dyn omp_tools::memory::ReflectionHost>,
			&shutdown,
			&mut tasks,
		);
		spawn_extension_data_servers(&server, data_bindings, &shutdown, &mut tasks);
		let lifecycle = ProjectLifecycle { shutdown: Some(shutdown), tasks, abort_tasks, server };
		// The connection that runs this session's environment tools must
		// itself reach a daemon enforcing the session's policy, whatever the
		// owner connection saw.
		if let Err(error) =
			hello_attached_session(&client, approval_mode, has_edit_repair, edit_model.as_ref())
				.await
				.and_then(|served| verify_daemon_policy(&served, socket, policy))
		{
			drop(lifecycle);
			return Err(error);
		}
		Ok(Self {
			client,
			fallback_notice: None,
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			acp_documents,
			approval_relay: Some(approval_relay),
			lifecycle,
		})
	}

	/// Starts an embedded Environment rooted at one isolated worktree.
	#[tracing::instrument(
		name = "environment_start",
		level = "debug",
		skip_all,
		fields(mode = "isolated", root = %root.display(), state_dir = %state_dir.display())
	)]
	pub async fn isolated(
		root: &Path,
		state_dir: &Path,
		con: Arc<Ctx>,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let command_credentials = bridges.command_credentials.clone();
		let dynamic_tool_factories = bridges.dynamic_tool_factories.clone();
		let (worker_config, data_bindings) =
			worker_config(state_dir, true, &[], &[], host_settings::SV_INTERRUPT_GRACE.get(&con))?;
		let convars = Arc::new(exthost::ConvarControlFactory::new(Arc::clone(&con)));
		let server = Arc::new(
			EnvServer::open_local(
				root,
				state_dir,
				Registry::new(),
				worker_config,
				&con,
				convars,
				bridges,
			)
			.await?,
		);
		let registry = server.registry();
		let eval_bridge = server.eval_bridge();
		let reflection_bridge = server.reflection_bridge();
		let eval_control = server.eval_control();
		let search_bridge = server.search_bridge();
		let github_credentials = server.github_credentials();
		let (client, transport) = EnvClient::in_process(64);
		bind_command_credentials(
			&server,
			command_credentials,
			&dynamic_tool_factories,
			client.clone(),
			client.clone(),
			root,
		);
		let in_process_server = Arc::clone(&server);
		let in_process =
			tokio::spawn(async move { in_process_server.serve_in_process(transport).await });
		let shutdown = CancellationToken::new();
		let mut tasks = vec![in_process];
		let acp_documents = spawn_acp_pump(&client, &shutdown, &mut tasks);
		spawn_extension_data_servers(&server, data_bindings, &shutdown, &mut tasks);
		hello(&client).await?;
		let lifecycle =
			ProjectLifecycle { shutdown: Some(shutdown), tasks, abort_tasks: Vec::new(), server };
		Ok(Self {
			client,
			fallback_notice: None,
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			acp_documents,
			approval_relay: None,
			lifecycle,
		})
	}

	/// Returns the typed Environment client for this composition.
	pub const fn client(&self) -> &EnvClient {
		&self.client
	}

	/// Returns the process execution authority for a local `omp-exec` backend.
	///
	/// The returned host shares this composition's shell/process lifecycle;
	/// callers must not construct a second process authority for the project.
	pub fn exec_host(&self) -> exec::ExecHost {
		self.lifecycle.server.process_host()
	}

	/// after production inference has opened the canonical credential store.
	pub async fn bind_mcp_oauth(
		&self,
		authority: Arc<mcp::auth_authority::CombinedAuthAuthority>,
		oauth: Arc<mcp::oauth::McpOAuth>,
		native_auth: AuthControlHandle,
	) -> Result<(), EnvdError> {
		self
			.lifecycle
			.server
			.mcp_manager()
			.bind_auth_authority(authority);
		self.lifecycle.server.mcp_manager().bind_oauth(oauth);
		self
			.lifecycle
			.server
			.mcp_manager()
			.bind_native_auth(native_auth);
		self
			.lifecycle
			.server
			.mcp()
			.reload_native_configs()
			.await
			.map(|_| ())
			.map_err(EnvdError::state)
	}

	/// Returns the immutable production tool registry.
	pub fn registry(&self) -> Arc<Registry> {
		Arc::clone(&self.registry)
	}

	/// Returns the namer of the hosts the fetches of this composition's
	/// in-process native tools reach ([`Self::registry`]'s native routes: every
	/// environment tool of an embedded or isolated composition, an attached
	/// session's session tools), by the resolvers of the in-process host that
	/// performs them. The kernel admits those tools itself and keys their
	/// fetch approval on these hosts.
	#[must_use]
	pub fn fetch_hosts(&self) -> fetch_host::FetchHostNamer {
		self.lifecycle.server.fetch_hosts()
	}

	/// Returns the handle through which an ACP adapter binds its editor as the
	/// document base of this composition (ADR 0037 §1.2).
	pub fn editor_documents(&self) -> EditorDocuments {
		EditorDocuments {
			client:    self.client.clone(),
			documents: Arc::clone(&self.acp_documents),
			server:    Arc::downgrade(&self.lifecycle.server),
		}
	}

	/// Returns the handle through which the session's network approvals are
	/// revoked when its conversation is rewound or switched to another session.
	pub fn session_grants(&self) -> SessionGrants {
		SessionGrants {
			client: self.approval_relay.is_some().then(|| self.client.clone()),
			server: Arc::downgrade(&self.lifecycle.server),
		}
	}

	/// Replaces the ask presenter for this environment composition.
	pub fn bind_ask_presenter(&self, presenter: Arc<dyn omp_tools::ask::AskPresenter>) {
		self.lifecycle.server.bind_ask_presenter(presenter);
	}

	/// Binds or clears the durable approval authority for Environment
	/// fallbacks.
	///
	/// The in-process host prompts through `route`. An attached session also
	/// answers the approval prompts the project daemon relays for the commands
	/// it issued through `route`; while it is cleared, those prompts are
	/// decided by their unreachable rules, which deny a sandbox amendment.
	pub fn bind_approval_authority(
		&self,
		book: Option<Arc<omp_contract::ApprovalBook>>,
		route: Option<omp_contract::ApprovalRoute>,
	) {
		if let Some(relay) = &self.approval_relay {
			relay.write().clone_from(&route);
		}
		self.lifecycle.server.bind_approval_authority(book, route);
	}

	/// Returns the session's sole Off/Mnemopi runtime.
	pub fn memory_runtime(&self) -> Arc<omp_memory::MemoryRuntime> {
		self.lifecycle.server.memory_runtime()
	}

	/// Returns the late-bound Python evaluation bridge.
	pub fn eval_bridge(&self) -> Arc<eval::SessionBridgeHost> {
		Arc::clone(&self.eval_bridge)
	}

	/// Binds one exact SDK session parent without enabling the compatibility
	/// fallback used by legacy single-parent callers.
	pub fn bind_eval_sdk_parent(
		&self,
		owner: Str,
		parent: Arc<dyn ParentSessionHost>,
	) -> Result<eval::ParentBindingLease, BridgeHostError> {
		self.eval_bridge.bind_sdk_parent(owner, parent)
	}

	/// Returns the late-bound memory reflection bridge: the inference the
	/// `reflect` calls this composition issues synthesize on. An embedded
	/// composition's own `reflect` uses it in process; an attached session's
	/// runs on the project daemon, which relays each synthesis back to this
	/// composition's bridge.
	pub fn reflection_bridge(&self) -> Arc<memory::ReflectionBridgeHost> {
		Arc::clone(&self.reflection_bridge)
	}

	/// Returns the evaluation session control.
	pub fn eval_control(&self) -> EvalSessionControl {
		self.eval_control.clone()
	}

	/// Returns the search and media inference bridge.
	pub fn search_bridge(&self) -> Arc<search_backend::SearchBridgeHost> {
		Arc::clone(&self.search_bridge)
	}

	/// Returns the Environment's provider credential projection.
	pub fn github_credentials(&self) -> Arc<ForgeCredentialBridge> {
		Arc::clone(&self.github_credentials)
	}

	/// Forge `Delegated` router for this checkout.
	///
	/// Chat's git watcher reads the branch's change request through
	/// [`CheckoutForge::view_branch`], which calls `view_change_request` on
	/// the same router `forge@1` uses. The router is built on the first read.
	/// Absent when `cap-forge` is off.
	#[cfg(feature = "cap-forge")]
	pub fn checkout_forge(&self, con: &Ctx) -> CheckoutForge {
		CheckoutForge::new(
			self.lifecycle.server.project_root(),
			self.lifecycle.server.state_dir().to_path_buf(),
			self.lifecycle.server.forge_devices(),
			forge_adapter::ForgeDynHosts::from_con(con),
		)
	}

	/// Returns the authenticated session generation fencing CONTROL clients.
	pub fn session_generation(&self) -> u64 {
		self.lifecycle.server.session_generation()
	}

	/// Binds the same production CONTROL router used by spawned extension
	/// children to one authenticated connection.
	pub fn extension_control_authority(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		self.lifecycle.server.extension_control_authority(identity)
	}

	/// Returns the live generation-fenced extension callback transport used by
	/// provider, presentation, and job owners.
	pub fn extension_callback_dispatcher(&self) -> Arc<dyn CallbackDispatcher> {
		self.lifecycle.server.extension_callback_dispatcher()
	}

	/// Returns a cloneable extension-generation replacement authority.
	pub fn extension_reload_handle(&self) -> ExtensionReloadHandle {
		ExtensionReloadHandle { server: Arc::clone(&self.lifecycle.server) }
	}

	/// Returns the shared extension and built-in provider usage registry.
	pub fn usage_fetchers(&self) -> omp_ai::operation::usage::UsageFetcherRegistry {
		self.lifecycle.server.usage_fetchers()
	}

	/// Returns the session-owned provider response hook sink.
	pub fn provider_response_hooks(&self) -> omp_ai::ProviderResponseHooks {
		self.lifecycle.server.provider_response_hooks()
	}

	/// Returns the live per-session admission hook gate.
	pub fn admission_gate(&self) -> Arc<omp_contract::HookGate> {
		self.lifecycle.server.admission_gate()
	}

	/// Returns the sealed deployment manifest only when every authenticated
	/// connection and generation fact exactly matches the live activation.
	pub fn extension_control_manifest(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<ExtensionManifest> {
		self.lifecycle.server.extension_control_manifest(identity)
	}

	/// Returns full frozen provider declarations for one exact
	/// authenticated extension generation.
	pub fn extension_registry_evidence(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<Arc<exthost::extensions::SealedRegistryEvidence>> {
		self.lifecycle.server.extension_registry_evidence(identity)
	}

	/// Returns every currently sealed exact-generation extension registry.
	pub fn extension_registry_evidences(
		&self,
	) -> Vec<Arc<exthost::extensions::SealedRegistryEvidence>> {
		self.lifecycle.server.extension_registry_evidences()
	}

	/// Registers frozen Python Directors and Components with an engine
	/// registrar.
	pub fn register_python_extensions(
		&self,
		registrar: &mut omp_contract::ExtensionRegistrar,
	) -> Result<Vec<exthost::PyComponent>, exthost::PyExtensionError> {
		self.lifecycle.server.register_python_extensions(registrar)
	}

	/// Returns every authenticated extension CONTROL identity.
	pub fn extension_control_identities(&self) -> Vec<Arc<ControlConnectionIdentity>> {
		self.lifecycle.server.extension_control_identities()
	}

	/// Returns the eager prompt-contribution provider over live worker actors.
	pub fn extension_prompt_provider(&self) -> Arc<dyn exthost::PromptContributionProvider> {
		self.lifecycle.server.extension_prompt_provider()
	}

	/// Returns a cloneable authority for retained MCP commands and inspection.
	pub fn mcp_inspector(&self) -> McpInspectorHandle {
		McpInspectorHandle { manager: Arc::clone(self.lifecycle.server.mcp_manager()) }
	}

	/// Binds literal project-MCP configuration notices to the active Agent turn.
	pub fn bind_mcp_literal_notices(&self, mailbox: KernelSender) {
		self
			.lifecycle
			.server
			.mcp_manager()
			.bind_literal_notice_sink(mailbox);
	}

	/// Constructs extension-scoped MCP CONTROL over this active Environment.
	pub fn mcp_control(
		&self,
		identity: Arc<ControlConnectionIdentity>,
		cancellation: CancellationToken,
	) -> Option<mcp::control::McpControl> {
		self.lifecycle.server.mcp_control(identity, cancellation)
	}

	/// Binds `omp.agents.*` to one live chat parent until the returned lease is
	/// dropped or superseded by a newer parent/session binding.
	///
	/// Existing CONTROL connections are generation-fenced immediately on
	/// replacement. MCP retains its independently composed owner.
	pub fn bind_agents_control_authority(
		&self,
		factory: Arc<dyn ControlAuthorityFactory>,
	) -> worker::AgentsControlAuthorityBinding {
		self.lifecycle.server.bind_agents_control_authority(factory)
	}

	/// Atomically binds every driver/app-owned CONTROL domain to one live chat
	/// session until the returned generation-fenced lease is dropped or
	/// superseded.
	pub fn bind_domain_control_factories(
		&self,
		factories: worker::ExternalDomainControlFactories,
	) -> worker::ExternalDomainControlBinding {
		self
			.lifecycle
			.server
			.bind_domain_control_factories(factories)
	}

	/// Atomically replaces the live chat parent and every driver/app-owned
	/// CONTROL domain under one generation fence and one teardown lease.
	pub fn bind_external_control_authorities(
		&self,
		agents: Arc<dyn ControlAuthorityFactory>,
		domains: worker::ExternalDomainControlFactories,
	) -> worker::ExternalControlAuthorityBinding {
		self
			.lifecycle
			.server
			.bind_external_control_authorities(agents, domains)
	}

	/// Binds checkpoint and staged-preview CONTROL to the active Agent Journal
	/// until the returned sole-owner lease is dropped.
	pub fn bind_agent_control(&self, sender: KernelSender) -> AgentControlBinding {
		self.lifecycle.server.bind_agent_control(sender)
	}

	/// Installs the project-lifetime backend which attaches or starts durable
	/// Agent sessions for scheduled delivery.
	///
	/// # Errors
	///
	/// Returns an environment protocol failure if the durable scheduler owner
	/// has stopped or was generation-fenced by a replacement environment.
	pub async fn bind_schedule_delivery(
		&self,
		backend: Arc<dyn schedules::ScheduleDeliveryBackend>,
	) -> Result<(), EnvdError> {
		self.lifecycle.server.bind_schedule_delivery(backend).await
	}

	/// Binds extension device availability notifications to the active turn.
	pub fn bind_device_availability(&self, mailbox: KernelSender) {
		self.lifecycle.server.bind_device_availability(mailbox);
	}
}

fn worker_config(
	state_dir: &Path,
	py_eval: bool,
	trusted_extensions: &[ExtHostSpec],
	contributed_values: &[ContributedCliValue],
	interrupt_grace: omp_core::Duration,
) -> Result<(ExtHostConfig, Vec<ExtensionDataBinding>), EnvdError> {
	let (authority, session_id, session_generation) = authenticated_runtime_identity()?;
	let mut config = ExtHostConfig::current(
		authority.principal().clone(),
		session_id.clone(),
		session_generation,
	)?;
	config.interrupt_grace = interrupt_grace;
	config
		.contributed_values
		.extend_from_slice(contributed_values);
	config.py_eval = py_eval;
	let mut bindings = Vec::new();
	for trusted in trusted_extensions {
		let mut extension = trusted.clone();
		let binding = ExtensionDataBinding::scoped(
			state_dir,
			extension.key.clone(),
			session_id.as_str(),
			session_generation,
			extension.data_grants.clone(),
		);
		extension.data_socket = Some(extension_data_endpoint(&binding));
		config.extensions.push(extension);
		bindings.push(binding);
	}
	#[cfg(unix)]
	{
		for binding in &mut bindings {
			binding.prepare_endpoint()?;
		}
	}
	Ok((config, bindings))
}

/// Derives the authenticated OS principal and a fresh project-runtime fence.
///
/// The generation is the runtime's creation timestamp, not a placeholder
/// ordinal, and the ULID distinguishes simultaneous runtimes.
pub(crate) fn authenticated_runtime_identity()
-> Result<(exthost::PrincipalAuthority, Str, u64), EnvdError> {
	let user = authenticated_os_user()?;
	let principal = omp_core::Principal::new(Str::from(format!("os:{user}")), user);
	let authority = exthost::PrincipalAuthority::new(principal);
	let session_id = Str::from(omp_core::Ulid::generate().to_string());
	let session_generation = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(io::Error::other)?
		.as_millis()
		.try_into()
		.map_err(io::Error::other)?;
	Ok((authority, session_id, session_generation))
}

#[cfg(unix)]
fn authenticated_os_user() -> Result<Str, EnvdError> {
	let uid = nix::unistd::geteuid();
	let user = User::from_uid(uid)
		.map_err(io::Error::from)?
		.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "current OS user has no account"))?;
	Ok(Str::from(user.name))
}

#[cfg(windows)]
fn authenticated_os_user() -> Result<Str, EnvdError> {
	use crate::windows::current_user_name;
	Ok(current_user_name()?)
}

#[cfg(not(windows))]
fn extension_data_endpoint(binding: &ExtensionDataBinding) -> PathBuf {
	binding.path().to_path_buf()
}

#[cfg(windows)]
fn extension_data_endpoint(binding: &ExtensionDataBinding) -> PathBuf {
	windows::extension_pipe_endpoint(binding)
}

#[cfg(unix)]
fn spawn_extension_data_servers(
	server: &Arc<EnvServer>,
	bindings: Vec<ExtensionDataBinding>,
	shutdown: &CancellationToken,
	tasks: &mut Vec<JoinHandle<()>>,
) {
	for binding in bindings {
		let server = Arc::clone(server);
		let shutdown = shutdown.clone();
		tasks.push(tokio::spawn(async move {
			if let Err(error) = server.serve_extension_uds(binding, shutdown).await {
				tracing::warn!(%error, "extension DATA socket stopped");
			}
		}));
	}
}

#[cfg(windows)]
fn spawn_extension_data_servers(
	server: &Arc<EnvServer>,
	bindings: Vec<ExtensionDataBinding>,
	shutdown: &CancellationToken,
	tasks: &mut Vec<JoinHandle<()>>,
) {
	for binding in bindings {
		let server = Arc::clone(server);
		let shutdown = shutdown.clone();
		tasks.push(tokio::spawn(async move {
			if let Err(error) = windows::serve_extension_pipe(server, binding, shutdown).await {
				tracing::warn!(%error, "extension DATA pipe stopped");
			}
		}));
	}
}

#[cfg(not(any(unix, windows)))]
fn spawn_extension_data_servers(
	_server: &Arc<EnvServer>,
	_bindings: Vec<ExtensionDataBinding>,
	_shutdown: &CancellationToken,
	_tasks: &mut Vec<JoinHandle<()>>,
) {
}

async fn hello(client: &EnvClient) -> Result<ServerHello, EnvdError> {
	hello_with_approval_mode(client, None).await
}

async fn hello_with_approval_mode(
	client: &EnvClient,
	approval_mode: Option<ApprovalMode>,
) -> Result<ServerHello, EnvdError> {
	Ok(client.hello(client_hello(approval_mode, &[], None)).await?)
}

async fn hello_attached_session(
	client: &EnvClient,
	approval_mode: Option<ApprovalMode>,
	edit_repair: bool,
	edit_model: Option<&Str>,
) -> Result<ServerHello, EnvdError> {
	Ok(client
		.hello(client_hello(approval_mode, attached_features(edit_repair), edit_model))
		.await?)
}

/// The client features an attached session advertises.
///
/// It always answers the approval prompts the daemon relays for its commands
/// (`approval_relay::pump_approval_queries`) and synthesizes the memory
/// reflections the daemon relays for its `reflect` calls
/// (`reflection_relay::pump_reflection_queries`), and repairs edits when the
/// application supplied a repair client. Embedded and isolated compositions
/// advertise none: their host prompts through its in-process route and
/// reflects through the bridge bound in-process.
const fn attached_features(edit_repair: bool) -> &'static [&'static str] {
	if edit_repair {
		&[
			omp_env::APPROVAL_RELAY_CAPABILITY,
			omp_env::REFLECTION_RELAY_CAPABILITY,
			omp_env::EDIT_REPAIR_CAPABILITY,
		]
	} else {
		&[omp_env::APPROVAL_RELAY_CAPABILITY, omp_env::REFLECTION_RELAY_CAPABILITY]
	}
}

fn client_hello(
	approval_mode: Option<ApprovalMode>,
	features: &[&str],
	edit_model: Option<&Str>,
) -> ClientHello {
	let approval_mode = match approval_mode {
		None => ProtoApprovalMode::Unspecified,
		Some(ApprovalMode::AlwaysAsk) => ProtoApprovalMode::AlwaysAsk,
		Some(ApprovalMode::Write) => ProtoApprovalMode::Write,
		Some(ApprovalMode::Yolo) => ProtoApprovalMode::Yolo,
	};
	let capabilities = features
		.iter()
		.map(|feature| (*feature).to_owned())
		.collect();
	let props = edit_model.map(|model| ValueMap {
		fields: std::iter::once(("edit-model".to_owned(), Value {
			kind: Some(value::Kind::String(model.to_string())),
		}))
		.collect(),
	});
	ClientHello {
		client: "omp-chat".into(),
		schema_rev: omp_proto::SCHEMA_REV,
		capabilities,
		approval_mode: approval_mode as i32,
		props,
		..ClientHello::default()
	}
}

type AcpDocumentsBinding = Arc<RwLock<Option<Arc<dyn docs::AcpDocumentBackend>>>>;

/// Cloneable handle binding the ACP editor as the document base of one
/// environment composition (ADR 0037 §1.2).
///
/// Binding registers this composition's environment connection as the editor
/// for its own tool invocations only: other connections, including every
/// subagent's composition, never reach the editor. Each bind starts a fresh
/// editor epoch in the daemon, so a session switch or resume begins
/// unanchored. Editor content is only ever a document base; every write still
/// commits through the document authority.
#[derive(Clone)]
pub struct EditorDocuments {
	client:    EnvClient,
	documents: AcpDocumentsBinding,
	/// Held weakly: a binding kept past the composition reaches nothing.
	server:    Weak<EnvServer>,
}

impl EditorDocuments {
	/// Binds `editor` for the live session, or unbinds it with `None` (session
	/// close, an ineligible session, transport loss).
	pub fn bind(&self, editor: Option<Arc<dyn docs::AcpDocumentBackend>>) {
		let binding = editor.as_ref().map_or_else(AcpBind::default, |editor| {
			let capabilities = editor.capabilities();
			AcpBind {
				documents:     true,
				fs_timeout_ms: u64::try_from(editor.deadline().as_millis()).unwrap_or(u64::MAX),
				read_text:     capabilities.read,
				write_text:    capabilities.write,
			}
		});
		// An embedded host runs the kernel's native document tools in-process,
		// outside any connection; they reach the editor through the host.
		if let Some(server) = self.server.upgrade() {
			server.bind_in_process_editor(editor.clone());
		}
		*self.documents.write() = editor;
		let documents = binding.documents;
		if let Err(error) = self.client.bind_acp(binding) {
			tracing::warn!(
				error = &error as &dyn std::error::Error,
				documents,
				"failed to update ACP connection binding"
			);
		}
	}
}

/// Cloneable handle on the network endpoints a session approved for the rest
/// of the session (sandbox amendments answered `session`, ADR 0028).
///
/// Those grants are a cache of journaled decisions, kept by the approval
/// binding that answered them: the in-process host route of an embedded or
/// isolated composition, or this composition's connection to the project
/// daemon when it is attached. [`Self::revoke`] drops both when the
/// conversation is rewound or switched to another session, so no endpoint
/// stays admitted that the journal the session now serves does not approve;
/// the approval desk refills them from that journal, one refused attempt per
/// endpoint.
#[derive(Clone)]
pub struct SessionGrants {
	/// The attached connection, whose daemon-side relay holds the grants of
	/// the commands it issues; `None` when nothing is attached.
	client: Option<EnvClient>,
	/// Held weakly: a handle kept past the composition reaches nothing.
	server: Weak<EnvServer>,
}

impl SessionGrants {
	/// Drops every network endpoint this session approved for the session.
	pub fn revoke(&self) {
		if let Some(server) = self.server.upgrade() {
			server.revoke_approval_grants();
		}
		if let Some(client) = &self.client
			&& let Err(error) = client.revoke_approval_grants()
		{
			// The attached client's queue is unbounded, so only a closed
			// transport fails here, and the daemon dropped this connection's
			// grants with its relay when it closed.
			tracing::warn!(
				error = &error as &dyn std::error::Error,
				"failed to revoke the daemon's session approval grants"
			);
		}
	}
}

/// Starts the task answering the daemon's editor queries for `client` from the
/// binding it returns.
fn spawn_acp_pump(
	client: &EnvClient,
	shutdown: &CancellationToken,
	tasks: &mut Vec<JoinHandle<()>>,
) -> AcpDocumentsBinding {
	let documents = AcpDocumentsBinding::default();
	let pump = (client.clone(), Arc::clone(&documents), shutdown.clone());
	tasks.push(tokio::spawn(async move {
		let (client, documents, shutdown) = pump;
		pump_acp_requests(client, documents, shutdown).await;
	}));
	documents
}

async fn pump_acp_requests(
	client: EnvClient,
	documents: Arc<RwLock<Option<Arc<dyn docs::AcpDocumentBackend>>>>,
	shutdown: CancellationToken,
) {
	let requests = client.acp_requests();
	let mut children = JoinSet::new();
	loop {
		tokio::select! {
			() = shutdown.cancelled() => break,
			request = requests.recv_async() => {
				let Ok(request) = request else {
					break;
				};
				match request {
					AcpRequest::Read { request_id, query } => {
						let backend = documents.read().clone();
						let client = client.clone();
						children.spawn(async move {
							let answer = answer_acp_read(backend, query).await;
							if let Err(error) = client.answer_acp_document(request_id, answer).await {
								tracing::warn!(%error, "failed to answer ACP document read");
							}
						});
					},
					AcpRequest::Write { request_id, query } => {
						let backend = documents.read().clone();
						let client = client.clone();
						children.spawn(async move {
							let answer = answer_acp_write(backend, query).await;
							if let Err(error) = client.answer_acp_document(request_id, answer).await {
								tracing::warn!(%error, "failed to answer ACP document write");
							}
						});
					},
				}
			},
			Some(result) = children.join_next(), if !children.is_empty() => {
				if let Err(error) = result
					&& !error.is_cancelled()
				{
					tracing::warn!(%error, "ACP bridge child task failed");
				}
			},
		}
	}
	children.abort_all();
	while children.join_next().await.is_some() {}
}

async fn answer_acp_read(
	backend: Option<Arc<dyn docs::AcpDocumentBackend>>,
	query: omp_proto::env::v1::AcpReadQuery,
) -> AcpDocumentAnswer {
	let result = match backend {
		Some(backend) => backend.read_text(Str::from(query.path.as_str())).await,
		None => Err(docs::EditorIoError::Unbound),
	};
	acp_document_answer(query.query_id, query.invocation_id, result)
}

async fn answer_acp_write(
	backend: Option<Arc<dyn docs::AcpDocumentBackend>>,
	query: omp_proto::env::v1::AcpWriteQuery,
) -> AcpDocumentAnswer {
	let result = match backend {
		Some(backend) => {
			backend
				.write_back(docs::WriteBack {
					path:    Str::from(query.path),
					content: Str::from(query.content),
					base:    query.base.map(Str::from),
				})
				.await
		},
		None => Err(docs::EditorIoError::Unbound),
	};
	let body = match result {
		Ok(outcome) => acp_document_answer::Body::WriteBack(outcome.into_wire()),
		Err(error) => acp_document_answer::Body::Error(acp_document_error(error)),
	};
	AcpDocumentAnswer {
		query_id:      query.query_id,
		invocation_id: query.invocation_id,
		body:          Some(body),
	}
}

/// Encodes an editor answer for the daemon; a failure crosses as its typed
/// code, named by its classification.
fn acp_document_answer(
	query_id: u64,
	invocation_id: String,
	result: Result<Str, docs::EditorIoError>,
) -> AcpDocumentAnswer {
	let body = match result {
		Ok(content) => acp_document_answer::Body::Content(content.to_string()),
		Err(error) => acp_document_answer::Body::Error(acp_document_error(error)),
	};
	AcpDocumentAnswer { query_id, invocation_id, body: Some(body) }
}

fn acp_document_error(error: docs::EditorIoError) -> ProtocolError {
	acp_error(error.protocol_code(), <&'static str>::from(error))
}

fn acp_error(code: ProtocolErrorCode, message: impl Into<String>) -> ProtocolError {
	ProtocolError { code: code as i32, message: message.into(), props: None }
}

async fn pump_edit_repair_requests(
	client: EnvClient,
	edit_repair: omp_tools::edit::observer::EditRepairClient,
	shutdown: CancellationToken,
) {
	let requests = client.edit_repair_requests();
	loop {
		let request = tokio::select! {
			() = shutdown.cancelled() => break,
			request = requests.recv_async() => {
				let Ok(request) = request else {
					break;
				};
				request
			},
		};
		let invocation_id = request.query.invocation_id;
		let result = if let Some(prompt) = request.query.prompt {
			let prompt = omp_tools::edit::observer::EditRepairPrompt {
				language:         prompt.language.into(),
				before:           prompt.before.into(),
				after:            prompt.after.into(),
				previous_attempt: prompt.previous_attempt.map(Into::into),
			};
			tokio::select! {
				() = shutdown.cancelled() => break,
				result = edit_repair.complete(prompt) => result,
			}
		} else {
			Err(omp_tools::edit::observer::EditRepairError::Unavailable)
		};
		let body = edit_repair_answer_body(result);
		let answer = EditRepairAnswer { invocation_id, body: Some(body) };
		let answered = tokio::select! {
			() = shutdown.cancelled() => break,
			answered = client.answer_edit_repair(request.request_id, answer) => answered,
		};
		if let Err(error) = answered {
			tracing::debug!(%error, "edit repair answer transport closed");
			break;
		}
	}
}

fn edit_repair_answer_body(
	result: Result<Str, omp_tools::edit::observer::EditRepairError>,
) -> edit_repair_answer::Body {
	match result {
		Ok(content) => edit_repair_answer::Body::Content(content.to_string()),
		Err(omp_tools::edit::observer::EditRepairError::Unavailable) => {
			edit_repair_answer::Body::Failure(EditRepairFailure {
				code:    EditRepairFailureCode::Unavailable as i32,
				message: "edit repair service is unavailable".to_owned(),
			})
		},
		Err(omp_tools::edit::observer::EditRepairError::Completion { message }) => {
			edit_repair_answer::Body::Failure(EditRepairFailure {
				code:    EditRepairFailureCode::Completion as i32,
				message: message.to_string(),
			})
		},
	}
}

#[cfg(unix)]
async fn attach_owner(
	root: &Path,
	state_dir: &Path,
	socket: &Path,
	docserver_socket: &Path,
	py_eval: bool,
	spawn_idle_timeout: Option<u64>,
	trust: WorkspaceTrust,
	policy: &DaemonPolicy,
	spawnable: Option<&DaemonPolicy>,
) -> Result<(EnvClient, JoinHandle<()>), EnvdError> {
	match EnvServer::connect_owner_uds(socket).await {
		Ok((owner, bridge)) => {
			let owner_hello = match hello(&owner).await {
				Ok(owner_hello) => owner_hello,
				Err(error) => {
					bridge.abort();
					return Err(error);
				},
			};
			if !omp_env::build_id::is_stale(omp_env::build_id::current(), &owner_hello.server_build) {
				if let Err(error) = verify_daemon_policy(&owner_hello, socket, policy) {
					bridge.abort();
					return Err(error);
				}
				let bridge = tokio::spawn(async move {
					let _ = bridge.await;
				});
				return Ok((owner, bridge));
			}

			// Stale owners are impossible on the default build-keyed path, but
			// retain the retirement protocol for explicitly overridden helpers.
			let _ = owner.retire().await;
			bridge.abort();
			let deadline = Instant::now() + Duration::from_secs(5);
			loop {
				match UnixStream::connect(socket).await {
					Err(error)
						if matches!(
							error.kind(),
							io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
						) =>
					{
						break;
					},
					_ if Instant::now() >= deadline => {
						return Err(
							io::Error::new(
								io::ErrorKind::TimedOut,
								"stale-build environment daemon kept its socket",
							)
							.into(),
						);
					},
					_ => time::sleep(Duration::from_millis(50)).await,
				}
			}
		},
		Err(EnvdError::Io(error))
			if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused) => {},
		Err(error) => return Err(error),
	}

	refuse_unjoinable_spawn(policy, spawnable)?;
	spawn_project_daemon(
		root,
		state_dir,
		socket,
		docserver_socket,
		py_eval,
		spawn_idle_timeout,
		trust,
		policy,
	)
	.await?;
	let (owner, bridge) = EnvServer::connect_owner_uds(socket).await?;
	if let Err(error) = hello(&owner)
		.await
		.and_then(|served| verify_daemon_policy(&served, socket, policy))
	{
		bridge.abort();
		return Err(error);
	}
	let bridge = tokio::spawn(async move {
		let _ = bridge.await;
	});
	Ok((owner, bridge))
}

#[cfg(windows)]
async fn attach_owner(
	root: &Path,
	state_dir: &Path,
	socket: &Path,
	docserver_socket: &Path,
	py_eval: bool,
	spawn_idle_timeout: Option<u64>,
	trust: WorkspaceTrust,
	policy: &DaemonPolicy,
	spawnable: Option<&DaemonPolicy>,
) -> Result<(EnvClient, JoinHandle<()>), EnvdError> {
	use crate::windows::{connect_owner_pipe, open_owner_pipe};

	match connect_owner_pipe(socket) {
		Ok((owner, bridge)) => {
			let owner_hello = match hello(&owner).await {
				Ok(owner_hello) => owner_hello,
				Err(error) => {
					bridge.abort();
					return Err(error);
				},
			};
			if !omp_env::build_id::is_stale(omp_env::build_id::current(), &owner_hello.server_build) {
				if let Err(error) = verify_daemon_policy(&owner_hello, socket, policy) {
					bridge.abort();
					return Err(error);
				}
				let bridge = tokio::spawn(async move {
					let _ = bridge.await;
				});
				return Ok((owner, bridge));
			}

			let _ = owner.retire().await;
			bridge.abort();
			let deadline = Instant::now() + Duration::from_secs(5);
			loop {
				match open_owner_pipe(socket) {
					Err(error) if error.kind() == io::ErrorKind::NotFound => break,
					_ if Instant::now() >= deadline => {
						return Err(
							io::Error::new(
								io::ErrorKind::TimedOut,
								"stale-build environment daemon kept its pipe",
							)
							.into(),
						);
					},
					_ => time::sleep(Duration::from_millis(50)).await,
				}
			}
		},
		Err(error)
			if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused) => {},
		Err(error) => return Err(error.into()),
	}

	refuse_unjoinable_spawn(policy, spawnable)?;
	spawn_project_daemon(
		root,
		state_dir,
		socket,
		docserver_socket,
		py_eval,
		spawn_idle_timeout,
		trust,
		policy,
	)
	.await?;
	let (owner, bridge) = connect_owner_pipe(socket)?;
	if let Err(error) = hello(&owner)
		.await
		.and_then(|served| verify_daemon_policy(&served, socket, policy))
	{
		bridge.abort();
		return Err(error);
	}
	let bridge = tokio::spawn(async move {
		let _ = bridge.await;
	});
	Ok((owner, bridge))
}

/// Refuses to spawn a project daemon that resolves the `spawnable` policy from
/// the configuration files when the session needs `policy`: the session could
/// never join it, so spawning it would only start and stop a whole
/// environment (its MCP servers and extension hosts) before the session runs
/// embedded anyway.
fn refuse_unjoinable_spawn(
	policy: &DaemonPolicy,
	spawnable: Option<&DaemonPolicy>,
) -> Result<(), EnvdError> {
	match spawnable {
		Some(spawnable) if spawnable != policy => {
			Err(EnvdError::DaemonPolicyNotSpawnable { expected: *policy, spawnable: *spawnable })
		},
		_ => Ok(()),
	}
}

/// Launches a detached `omp envd` for this project under the workspace
/// `trust` and waits until its environment socket answers a hello reporting
/// `policy`.
async fn spawn_project_daemon(
	root: &Path,
	state_dir: &Path,
	socket: &Path,
	docserver_socket: &Path,
	py_eval: bool,
	spawn_idle_timeout: Option<u64>,
	trust: WorkspaceTrust,
	policy: &DaemonPolicy,
) -> Result<(), EnvdError> {
	let executable = env::current_exe()?;
	spawn_project_daemon_with(
		&executable,
		root,
		state_dir,
		socket,
		docserver_socket,
		py_eval,
		spawn_idle_timeout,
		trust,
		policy,
		Duration::from_secs(10),
	)
	.await
}

/// Spawns `executable envd …` detached from this process and waits for
/// readiness on `socket` within `deadline`.
///
/// The daemon runs in its own process group with output appended to
/// `envd.log` in the state directory. A daemon that fails to become ready is
/// killed so it cannot linger half-initialized while the caller falls back
/// to an embedded environment. So is a ready daemon that reports another
/// policy than `policy`: it inherited this process's configuration files but
/// not the in-process overrides of the caller's control context (such as
/// `--add-dir` roots), and no client keyed to its socket could ever use it.
async fn spawn_project_daemon_with(
	executable: &Path,
	root: &Path,
	state_dir: &Path,
	socket: &Path,
	docserver_socket: &Path,
	py_eval: bool,
	spawn_idle_timeout: Option<u64>,
	trust: WorkspaceTrust,
	policy: &DaemonPolicy,
	deadline: Duration,
) -> Result<(), EnvdError> {
	fs::create_dir_all(state_dir)?;
	let log = OpenOptions::new()
		.create(true)
		.append(true)
		.open(state_dir.join("envd.log"))?;
	let errors = log.try_clone()?;
	let mut command = process::Command::new(executable);
	command
		.arg("envd")
		.arg("--root")
		.arg(root)
		.arg("--state-dir")
		.arg(state_dir)
		.arg("--socket")
		.arg(socket)
		.arg("--docserver-socket")
		.arg(docserver_socket)
		.arg("--workspace-trust")
		.arg(<&'static str>::from(trust));
	if py_eval {
		command.arg("--py-eval");
	}
	if let Some(idle_timeout) = spawn_idle_timeout {
		command.arg("--idle-timeout").arg(idle_timeout.to_string());
	}
	// The daemon resolves its configuration from the same profile as this
	// process, so a `--profile` session can spawn a daemon it may join.
	match omp_core::dirs::active_profile() {
		Ok(Some(profile)) => {
			command.env("OMP_PROFILE", profile.as_str());
		},
		Ok(None) => {
			command.env_remove("OMP_PROFILE");
		},
		Err(_) => {},
	}
	command
		.stdin(Stdio::null())
		.stdout(log)
		.stderr(errors)
		.kill_on_drop(false);
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt as _;
		command.as_std_mut().process_group(0);
	}
	let mut child = command.spawn()?;
	let process_group = child.id();
	let deadline = Instant::now() + deadline;
	loop {
		if let Some(status) = child.try_wait()? {
			terminate_spawned_daemon(&mut child, process_group).await;
			return Err(
				io::Error::other(format!("project daemon exited during startup: {status}")).into(),
			);
		}
		if let Some(served) = owner_endpoint_hello(socket).await {
			if let Err(error) = verify_daemon_policy(&served, socket, policy) {
				tracing::warn!(
					%error,
					"stopping the project daemon this client spawned: it does not enforce the \
					 client's sandbox and approval policy"
				);
				terminate_spawned_daemon(&mut child, process_group).await;
				return Err(error);
			}
			// Reap in the background; the daemon's lifetime is its own.
			tokio::spawn(async move {
				let _ = child.wait().await;
			});
			return Ok(());
		}
		if Instant::now() >= deadline {
			terminate_spawned_daemon(&mut child, process_group).await;
			return Err(
				io::Error::new(io::ErrorKind::TimedOut, "project daemon did not become ready").into(),
			);
		}
		time::sleep(Duration::from_millis(50)).await;
	}
}

#[cfg(unix)]
async fn terminate_spawned_daemon(child: &mut tokio::process::Child, process_group: Option<u32>) {
	if let Some(process_group) = process_group {
		let group = Pid::from_raw(process_group.cast_signed());
		let _ = signal::killpg(group, Signal::SIGTERM);
		time::sleep(Duration::from_millis(250)).await;
		let _ = signal::killpg(group, Signal::SIGKILL);
	} else {
		let _ = child.start_kill();
	}
	let _ = child.wait().await;
}

#[cfg(not(unix))]
async fn terminate_spawned_daemon(child: &mut tokio::process::Child, _process_group: Option<u32>) {
	let _ = child.start_kill();
	let _ = child.wait().await;
}

/// The hello of the daemon listening on `socket`, once it answers one.
#[cfg(unix)]
async fn owner_endpoint_hello(socket: &Path) -> Option<ServerHello> {
	let (probe, bridge) = EnvServer::connect_owner_uds(socket).await.ok()?;
	let served = hello(&probe).await.ok();
	bridge.abort();
	served
}

/// The hello of the daemon listening on `socket`, once it answers one.
#[cfg(windows)]
async fn owner_endpoint_hello(socket: &Path) -> Option<ServerHello> {
	use crate::windows::connect_owner_pipe;
	let (probe, bridge) = connect_owner_pipe(socket).ok()?;
	let served = hello(&probe).await.ok();
	bridge.abort();
	served
}

/// Admits the daemon that answered `served` on `socket` only when it enforces
/// the `expected` sandbox and approval policy.
///
/// A daemon fixes its sandbox, egress broker and approval posture when it
/// starts, so attaching to one that resolved another policy would run this
/// client's commands confined or unconfined, admitted or prompted, by
/// someone else's configuration.
fn verify_daemon_policy(
	served: &ServerHello,
	socket: &Path,
	expected: &DaemonPolicy,
) -> Result<(), EnvdError> {
	let served = DaemonPolicy::from_wire(&served.policy_digest)
		.ok_or_else(|| EnvdError::DaemonPolicyUnreported { socket: socket.to_path_buf() })?;
	if served == *expected {
		Ok(())
	} else {
		Err(EnvdError::DaemonPolicyMismatch {
			socket: socket.to_path_buf(),
			expected: *expected,
			served,
		})
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::future::Future;

	use parking_lot::Mutex;

	use super::*;

	/// An editor whose client reformats every buffer written to it.
	struct FormattingFiles(Mutex<Str>);

	impl editor_sync::EditorFiles for FormattingFiles {
		fn read_text(
			&self,
			_path: Str,
		) -> impl Future<Output = Result<Str, docs::EditorIoError>> + Send + '_ {
			std::future::ready(Ok(self.0.lock().clone()))
		}

		fn write_text(
			&self,
			_path: Str,
			content: Str,
		) -> impl Future<Output = Result<(), docs::EditorIoError>> + Send + '_ {
			*self.0.lock() = sf!("{}\n", content.trim_end());
			std::future::ready(Ok(()))
		}
	}

	#[test]
	fn attached_hello_relays_approvals_and_reflections_and_advertises_only_supplied_edit_repair_facts()
	 {
		let plain = client_hello(None, &[], None);
		assert!(plain.capabilities.is_empty(), "embedded and isolated hellos advertise nothing");
		assert!(plain.props.is_none());

		let attached = client_hello(None, attached_features(false), None);
		assert_eq!(attached.capabilities, ["approval-relay", "reflection-relay"]);
		assert!(attached.props.is_none());

		let repair = client_hello(None, attached_features(true), None);
		assert_eq!(repair.capabilities, ["approval-relay", "reflection-relay", "edit-repair"]);
		assert!(repair.props.is_none());

		let model = sf!("smol");
		let model_only =
			client_hello(Some(ApprovalMode::Write), attached_features(false), Some(&model));
		assert_eq!(model_only.capabilities, ["approval-relay", "reflection-relay"]);
		assert_eq!(model_only.approval_mode, ProtoApprovalMode::Write as i32);
		let model = model_only
			.props
			.expect("model property map")
			.fields
			.remove("edit-model")
			.expect("typed model property");
		assert_eq!(model.kind, Some(value::Kind::String("smol".to_owned())));
	}

	#[test]
	fn edit_repair_answers_preserve_typed_results() {
		let content = edit_repair_answer_body(Ok(sf!("fixed")));
		assert_eq!(content, edit_repair_answer::Body::Content("fixed".to_owned()));

		let unavailable =
			edit_repair_answer_body(Err(omp_tools::edit::observer::EditRepairError::Unavailable));
		let edit_repair_answer::Body::Failure(unavailable) = unavailable else {
			panic!("unavailable must remain a typed failure");
		};
		assert_eq!(unavailable.code, EditRepairFailureCode::Unavailable as i32);

		let completion =
			edit_repair_answer_body(Err(omp_tools::edit::observer::EditRepairError::Completion {
				message: sf!("provider"),
			}));
		let edit_repair_answer::Body::Failure(completion) = completion else {
			panic!("completion must remain a typed failure");
		};
		assert_eq!(completion.code, EditRepairFailureCode::Completion as i32);
		assert_eq!(completion.message, "provider");
	}
	#[tokio::test]
	async fn acp_document_answers_return_formatted_readback_and_typed_unbound_failure() {
		let backend: Arc<dyn docs::AcpDocumentBackend> = Arc::new(editor_sync::EditorBackend::new(
			FormattingFiles(Mutex::new(sf!("before"))),
			docs::EditorCapabilities { read: true, write: true },
			std::time::Duration::from_secs(5),
		));
		let written =
			answer_acp_write(Some(Arc::clone(&backend)), omp_proto::env::v1::AcpWriteQuery {
				query_id:      7,
				invocation_id: "invocation".into(),
				path:          "/workspace/main.rs".into(),
				content:       "fn main() {}  ".into(),
				base:          None,
			})
			.await;
		let Some(acp_document_answer::Body::WriteBack(outcome)) = written.body else {
			panic!("a write-back answers with its outcome: {written:?}");
		};
		assert_eq!(
			docs::WriteBackOutcome::from_wire(outcome),
			Ok(docs::WriteBackOutcome::Written {
				merged:    None,
				read_back: Some(Str::new_static("fn main() {}\n")),
			}),
			"the client's reformatting crosses the wire as the read-back"
		);
		let read = answer_acp_read(Some(backend), omp_proto::env::v1::AcpReadQuery {
			query_id:      8,
			invocation_id: "invocation".into(),
			path:          "/workspace/main.rs".into(),
		})
		.await;
		assert_eq!(read.body, Some(acp_document_answer::Body::Content("fn main() {}\n".into())));
		let unbound = answer_acp_read(None, omp_proto::env::v1::AcpReadQuery {
			query_id:      9,
			invocation_id: "invocation".into(),
			path:          "/workspace/main.rs".into(),
		})
		.await;
		let Some(acp_document_answer::Body::Error(error)) = unbound.body else {
			panic!("unbound ACP documents must return a typed error");
		};
		assert_eq!(error.code, ProtocolErrorCode::NotFound as i32);
		assert_eq!(
			docs::EditorIoError::from_protocol_code(error.code),
			docs::EditorIoError::Unbound,
			"the daemon decodes the classification the pump sent"
		);
	}

	async fn spawn_with(executable: &Path, deadline_ms: u64) -> Result<(), EnvdError> {
		let scratch = tempfile::tempdir().expect("scratch state directory");
		spawn_project_daemon_with(
			executable,
			scratch.path(),
			scratch.path(),
			&scratch.path().join("env.sock"),
			&scratch.path().join("doc.sock"),
			false,
			None,
			WorkspaceTrust::Untrusted,
			&daemon_policy::from_con(&Ctx::new(), WorkspaceTrust::Untrusted),
			Duration::from_millis(deadline_ms),
		)
		.await
	}

	#[tokio::test]
	async fn spawn_reports_missing_daemon_executable() {
		let error = spawn_with(Path::new("/nonexistent/omp"), 1_000)
			.await
			.expect_err("missing executable must fail");
		assert!(matches!(error, EnvdError::Io(_)));
	}

	#[tokio::test]
	async fn spawn_reports_a_daemon_that_exits_during_startup() {
		let error = spawn_with(Path::new("/usr/bin/true"), 5_000)
			.await
			.expect_err("exiting daemon must fail");
		assert!(error.to_string().contains("exited during startup"), "unexpected error: {error}");
	}

	#[tokio::test]
	async fn same_binary_daemon_spawn_reenters_the_public_envd_boundary() {
		use std::os::unix::fs::PermissionsExt as _;

		let scratch = tempfile::tempdir().expect("scratch script directory");
		let script = scratch.path().join("capture.sh");
		let capture = scratch.path().join("argv.txt");
		fs::write(
			&script,
			format!("#!/bin/sh\nprintf '%s' \"$1\" > '{}'\nexit 17\n", capture.display()),
		)
		.expect("write argument capture script");
		fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
			.expect("mark script executable");

		let error = spawn_with(&script, 5_000)
			.await
			.expect_err("capture process must exit during startup");
		assert!(error.to_string().contains("exited during startup"), "unexpected error: {error}");
		assert_eq!(fs::read_to_string(capture).expect("captured daemon selector"), "envd");
	}

	#[tokio::test]
	async fn spawn_kills_a_daemon_that_never_becomes_ready() {
		use std::os::unix::fs::PermissionsExt as _;

		let scratch = tempfile::tempdir().expect("scratch script directory");
		let script = scratch.path().join("hang.sh");
		let child_pid_path = scratch.path().join("child.pid");
		fs::write(
			&script,
			format!(
				"#!/bin/sh\nsleep 30 &\nprintf '%s' \"$!\" > '{}'\nwait\n",
				child_pid_path.display()
			),
		)
		.expect("write hang script");
		fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
			.expect("mark script executable");

		// The deadline is the only thing that stops the script, so it must leave
		// room for the script to start its descendant and record it; the first
		// exec of a freshly written script can take hundreds of milliseconds on
		// macOS.
		let error = spawn_with(&script, 5_000)
			.await
			.expect_err("unready daemon must time out");
		let EnvdError::Io(error) = &error else {
			panic!("unexpected error: {error}");
		};
		assert_eq!(error.kind(), io::ErrorKind::TimedOut);

		let child_pid = fs::read_to_string(child_pid_path)
			.expect("the daemon recorded its descendant before the startup deadline")
			.parse::<i32>()
			.expect("numeric daemon descendant pid");
		let child = Pid::from_raw(child_pid);
		let reaped = time::timeout(Duration::from_secs(2), async {
			while !crate::test_process::process_terminated(child) {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		assert!(reaped.is_ok(), "startup timeout left a daemon descendant alive");
	}

	/// A daemon is admitted only when its hello reports the client's policy; one
	/// reporting no policy is refused by name, as is one reporting another.
	#[test]
	fn the_hello_admits_only_the_clients_policy() {
		use crate::exec_settings::{ExecSandboxMode, SV_SANDBOX_MODE};

		let socket = Path::new("/tmp/omp-test-env.sock");
		let expected = daemon_policy::from_con(&Ctx::new(), WorkspaceTrust::Untrusted);
		let reporting = |policy: &DaemonPolicy| ServerHello {
			policy_digest: Bytes::copy_from_slice(policy.digest().as_bytes()),
			..ServerHello::default()
		};
		verify_daemon_policy(&reporting(&expected), socket, &expected).expect("admitted");

		let error = verify_daemon_policy(&ServerHello::default(), socket, &expected)
			.expect_err("a daemon reporting no policy is refused");
		assert!(
			matches!(&error, EnvdError::DaemonPolicyUnreported { socket: refused } if refused == socket),
			"unexpected error: {error}"
		);

		let unconfined = Ctx::new();
		SV_SANDBOX_MODE
			.set(&unconfined, ExecSandboxMode::Off)
			.expect("sandbox mode");
		let served = daemon_policy::from_con(&unconfined, WorkspaceTrust::Untrusted);
		let error = verify_daemon_policy(&reporting(&served), socket, &expected)
			.expect_err("a daemon reporting another policy is refused");
		assert!(
			matches!(
				&error,
				EnvdError::DaemonPolicyMismatch { socket: refused, expected: wanted, served: reported }
					if refused == socket && *wanted == expected && *reported == served
			),
			"unexpected error: {error}"
		);
	}

	/// A daemon this client spawned that answers with another sandbox and
	/// approval policy than the client resolved is refused and stopped, so it
	/// never lingers on a socket no client of that policy could use. The
	/// script stands for the spawned process; the environment this test serves
	/// on its socket answers the hello, and only once the script has recorded
	/// the descendant whose end proves the process group was stopped.
	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn spawn_stops_a_daemon_reporting_another_policy() {
		use std::os::unix::fs::PermissionsExt as _;

		use omp_core::Principal;

		use crate::exec_settings::{ExecSandboxMode, SV_SANDBOX_MODE};

		let scratch = tempfile::tempdir().expect("scratch");
		let root = scratch.path().join("workspace");
		let state = scratch.path().join("state");
		fs::create_dir_all(&root).expect("workspace");
		fs::create_dir_all(&state).expect("state");
		let socket = scratch.path().join("env.sock");
		let docserver_socket = scratch.path().join("doc.sock");

		let unconfined = Arc::new(Ctx::new());
		SV_SANDBOX_MODE
			.set(&unconfined, ExecSandboxMode::Off)
			.expect("sandbox mode");
		let served = daemon_policy::from_con(&unconfined, WorkspaceTrust::Untrusted);
		let expected = daemon_policy::from_con(&Ctx::new(), WorkspaceTrust::Untrusted);
		assert_ne!(served, expected);
		let server = EnvServer::open_project(
			&root,
			&state,
			&docserver_socket,
			Registry::new(),
			ExtHostConfig::current(Principal::new(sf!("tester"), sf!("Tester")), sf!("session"), 1)
				.expect("host configuration"),
			None,
			false,
			None,
			&unconfined,
			Arc::new(exthost::ConvarControlFactory::new(Arc::clone(&unconfined))),
			RegistryBridges::default(),
		)
		.await
		.expect("environment");

		// The pid file appears whole (renamed into place), so the environment
		// never answers before the descendant is recorded.
		let child_pid_path = scratch.path().join("child.pid");
		let staged_pid_path = scratch.path().join("child.pid.staged");
		let script = scratch.path().join("daemon.sh");
		fs::write(
			&script,
			format!(
				"#!/bin/sh\nsleep 30 &\nprintf '%s' \"$!\" > '{staged}'\nmv '{staged}' '{pid}'\nwait\n",
				staged = staged_pid_path.display(),
				pid = child_pid_path.display()
			),
		)
		.expect("write daemon script");
		fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
			.expect("mark script executable");

		let shutdown = CancellationToken::new();
		let serving = tokio::spawn({
			let server = Arc::new(server);
			let socket = socket.clone();
			let shutdown = shutdown.clone();
			let child_pid_path = child_pid_path.clone();
			async move {
				while !child_pid_path.exists() {
					time::sleep(Duration::from_millis(10)).await;
				}
				server.serve_uds(&socket, shutdown, None).await
			}
		});

		let error = spawn_project_daemon_with(
			&script,
			&root,
			&state,
			&socket,
			&docserver_socket,
			false,
			None,
			WorkspaceTrust::Untrusted,
			&expected,
			Duration::from_secs(30),
		)
		.await
		.expect_err("a daemon reporting another policy must be refused");
		let EnvdError::DaemonPolicyMismatch { socket: refused, expected: wanted, served: reported } =
			&error
		else {
			panic!("unexpected error: {error}");
		};
		assert_eq!(refused, &socket);
		assert_eq!(*wanted, expected);
		assert_eq!(*reported, served);
		assert!(
			error
				.to_string()
				.contains(&format!("policy {served}, not this session's {expected}")),
			"the refusal names both policies: {error}"
		);

		let child_pid = fs::read_to_string(&child_pid_path)
			.expect("the daemon recorded its descendant before the environment answered")
			.parse::<i32>()
			.expect("numeric daemon descendant pid");
		let child = Pid::from_raw(child_pid);
		let reaped = time::timeout(Duration::from_secs(2), async {
			while !crate::test_process::process_terminated(child) {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		assert!(reaped.is_ok(), "the refused daemon kept running");
		shutdown.cancel();
		serving.abort();
	}

	/// An environment opened for a trusted workspace mounts the project's MCP
	/// servers; one opened for an untrusted workspace mounts none, unless the
	/// user opted every project in (`sv_mcp_enable_project_config`).
	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn environment_open_mounts_project_mcp_only_when_trusted_or_opted_in() {
		let scratch = tempfile::tempdir().expect("scratch");
		let config = scratch.path().join("o2");
		fs::create_dir_all(&config).expect("user config root");
		// SAFETY: nextest runs each test in its own process; nothing else reads
		// the variable concurrently.
		unsafe { env::set_var("OMP_CONFIG_DIR", &config) };

		// Each opening gets its own workspace, so no document authority of
		// an earlier one is joined.
		let mounted = async |trust: WorkspaceTrust, opt_in: bool| {
			let workspace = tempfile::tempdir_in(scratch.path()).expect("workspace");
			let root = fs::canonicalize(workspace.path()).expect("canonical workspace");
			fs::create_dir_all(root.join(".omp")).expect("project .omp");
			fs::write(
				root.join(".omp/mcp.json"),
				br#"{"mcpServers":{"project-server":{"type":"stdio","command":"/nonexistent/project-mcp"}}}"#,
			)
			.expect("project MCP config");
			let state = tempfile::tempdir_in(scratch.path()).expect("state");
			let con = Arc::new(Ctx::new());
			mcp::settings::SV_MCP_ENABLE_PROJECT_CONFIG
				.set(&con, opt_in)
				.expect("user-level opt-in");
			let environment = ProjectEnvironment::start_embedded(
				&root,
				state.path(),
				&omp_env::project_state::document_socket(state.path()),
				false,
				&[],
				&[],
				con,
				RegistryBridges {
					content: ActiveContentInputs {
						workspace_trust: trust,
						..ActiveContentInputs::default()
					},
					..RegistryBridges::default()
				},
			)
			.await
			.expect("environment");
			environment
				.mcp_inspector()
				.snapshots()
				.into_iter()
				.map(|snapshot| snapshot.server)
				.collect::<Vec<_>>()
		};

		assert_eq!(mounted(WorkspaceTrust::Trusted, false).await, ["project-server"]);
		assert_eq!(
			mounted(WorkspaceTrust::Untrusted, false).await,
			Vec::<Str>::new(),
			"an untrusted workspace's project MCP server mounted"
		);
		assert_eq!(mounted(WorkspaceTrust::Untrusted, true).await, ["project-server"]);
	}
}
