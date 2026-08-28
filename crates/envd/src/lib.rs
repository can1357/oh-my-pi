//! Environment-host composition for project-scoped filesystem, process,
//! document, tool, and extension authority.

mod admission;
pub mod blobs;
mod browser_daemon;
pub mod browser_fetch;
mod computer;
mod direnv;
pub mod docs;
pub mod document_cache;
pub mod eval;
pub mod exec;
pub mod exec_settings;
pub mod ext_git;
pub mod exthost;
mod github;
pub mod github_url;
pub mod host_info;
pub mod host_settings;
mod http_egress;
mod journal_runtime;
pub mod lsp_settings;
mod managed_skills;
pub mod managed_skills_domain;
pub mod mcp;
mod media_devices;
pub mod memory;
pub mod policy;
mod presence;
pub mod process_identity;
pub mod process_log;
pub mod process_store;
pub mod recovery;
mod resource_materializer;
pub mod schedules;
pub mod search_backend;
mod server;
pub mod shell_profile;
pub mod site;
pub mod ssh;
mod staged_preview;
mod tool_debug;
mod tool_document;
mod tool_lsp;
mod tool_read_sources;
mod tool_search;
pub mod tool_settings;
/// Shell-tool execution, managed process sessions, and shell URI resolution.
pub mod tool_shell;
pub mod tool_url;
mod tools;
mod vault;
pub mod vcs;
#[cfg(windows)]
pub mod windows;
pub mod worker;
pub mod worker_pool;
pub mod workspace;
pub mod workspace_roots;
mod xd;
use std::{
	env,
	fs::{self, OpenOptions},
	io,
	path::{Path, PathBuf},
	process::{Stdio, id},
	sync::Arc,
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
use github_url::GithubCredentialBridge;
use miette::IntoDiagnostic as _;
#[cfg(unix)]
use nix::unistd::User;
use omp_agent::control::ControlSender;
use omp_core::{Hash32, Str, Ulid, sf};
use omp_env::EnvClient;
use omp_ext::config::ContributedCliValue;
use omp_inference::auth::AuthControlHandle;
use omp_proto::env::v1::{ClientHello, RegisterPresence, ReleasePresence, ServerHello};
use omp_settings::snapshot::SettingsSnapshot;
use omp_storage::index::SessionIndex;
use omp_tool::Registry;
use omp_tools::eval::EvalSessionControl;
pub use presence::PresenceError;
pub use server::{AgentControlBinding, EnvServer, EnvdError};
pub use site::validate_trusted_module;
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::{
	process,
	task::{AbortHandle, JoinHandle},
	time::{self, Instant},
};
use tokio_util::sync::CancellationToken;
pub use tools::{
	ActiveContentInputs, CommandCredentialExecutorFactory, ContentResolver, DynamicTool,
	DynamicToolFactory, DynamicToolRegistrar, GoalAuthority, HostResourceResult, HostResources,
	RegistryBridges, SearchInference, TelemetryUpload,
};
#[cfg(windows)]
use windows::OwnerPipeListener;
#[doc(hidden)]
pub use worker::run_py_worker_entry;

use self::{
	server::ExtensionDataBinding,
	tool_settings::ApprovalMode,
	worker::{ExtHostConfig, ExtHostSpec, HostKey, PY_EVAL_MODULE},
};
use crate::eval::{BridgeHostError, ParentSessionHost};

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

/// Registers one launch-shaped application process with its project daemon.
#[cfg(any(unix, windows))]
pub async fn register_project_presence(
	project_root: &Path,
	data_dir: &Path,
	kind: &'static str,
) -> Result<ClientPresenceLease, EnvdError> {
	let root = fs::canonicalize(project_root)?;
	let state_dir = omp_env::project_state::directory(data_dir, &root)?;
	let socket = omp_env::project_state::environment_socket(&state_dir);
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
			)
			.await?;
			connect_presence_owner(&socket).await?
		},
		Err(error) => return Err(error),
	};
	if let Err(error) = hello(&client).await {
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
	Ok(ClientPresenceLease { client, lease_id: registered.lease_id, bridge })
}

/// Reports that client-presence registration needs a local Environment
/// transport.
#[cfg(not(any(unix, windows)))]
pub async fn register_project_presence(
	_project_root: &Path,
	_data_dir: &Path,
	_kind: &'static str,
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
pub async fn run(config: EnvdConfig, bridges: RegistryBridges) -> miette::Result<()> {
	server::run(config, bridges).await.into_diagnostic()
}

/// Starts the Windows named-pipe project environment daemon.
#[cfg(windows)]
pub async fn run(config: EnvdConfig, bridges: RegistryBridges) -> miette::Result<()> {
	windows::run(config, bridges).await.into_diagnostic()
}

/// Reports that no owner-local environment transport exists on this target.
#[cfg(not(any(unix, windows)))]
pub async fn run(config: EnvdConfig, bridges: RegistryBridges) -> miette::Result<()> {
	server::run(config, bridges).await.into_diagnostic()
}

/// Client-side ownership of one project environment composition.
///
/// Dropping this value shuts down only servers and children started by this
/// composition. An existing owner environment remains untouched.
pub struct ProjectEnvironment {
	pub(crate) client:   EnvClient,
	pub(crate) registry: Arc<Registry>,
	eval_bridge:         Arc<eval::SessionBridgeHost>,
	reflection_bridge:   Arc<memory::ReflectionBridgeHost>,
	eval_control:        EvalSessionControl,
	search_bridge:       Arc<search_backend::SearchBridgeHost>,
	github_credentials:  Arc<GithubCredentialBridge>,
	lifecycle:           ProjectLifecycle,
}
/// Cloneable authority for replacing the Environment's extension worker
/// generation.
#[derive(Clone)]
pub struct ExtensionReloadHandle {
	server: Arc<EnvServer>,
}

impl ExtensionReloadHandle {
	/// Drains idle extension workers and respawns their hot-reload generations.
	pub async fn reload(&self) -> Result<Vec<u64>, worker::WorkerError> {
		self.server.reload_extensions().await
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

	/// Deletes one server's credential from the shared encrypted store and
	/// drops its authenticated connection.
	pub async fn clear_authorization(&self, name: &str) -> Result<bool, mcp::manager::ManagerError> {
		self.manager.clear_authorization(name).await
	}

	/// Runs a fresh OAuth grant while exposing the complete authorization URL
	/// to the application shell.
	pub async fn reauthorize<F>(
		&self,
		name: &str,
		present: F,
	) -> Result<bool, mcp::manager::ManagerError>
	where
		F: Fn(&str) + Send + Sync,
	{
		self.manager.reauthorize(name, &present).await
	}
}

struct ProjectLifecycle {
	shutdown: Option<CancellationToken>,
	tasks:    Vec<JoinHandle<()>>,
	server:   Arc<EnvServer>,
}

impl Drop for ProjectLifecycle {
	fn drop(&mut self) {
		if let Some(shutdown) = &self.shutdown {
			shutdown.cancel();
		}
		for task in &self.tasks {
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
			.bind_command_executor(factory.make(client.clone(), root));
	}
	for factory in dynamic_tools {
		factory.bind(dynamic_client.clone(), root);
	}
}

impl ProjectEnvironment {
	/// Connects an existing owner environment or starts one for this process.
	///
	/// An approval-mode override is retained only by this composition.
	#[cfg(unix)]
	pub async fn connect_or_start(
		root: &Path,
		state_dir: &Path,
		socket: &Path,
		docserver_socket: &Path,
		py_eval: bool,
		approval_mode: Option<ApprovalMode>,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		interrupt_grace: omp_core::Duration,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		match EnvServer::connect_owner_uds(socket).await {
			Ok((owner_probe, bridge)) => {
				match hello(&owner_probe).await {
					Ok(owner_hello)
						if omp_env::build_id::is_stale(
							omp_env::build_id::current(),
							&owner_hello.server_build,
						) =>
					{
						// Stale-build owners can only appear on explicitly
						// configured socket paths; the automatic path is keyed
						// by executable generation. Ask the owner to retire, then wait
						// briefly for the endpoint to be released.
						let _ = owner_probe.retire().await;
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
									return Self::start(
										root,
										state_dir,
										socket,
										docserver_socket,
										py_eval,
										approval_mode,
										trusted_extensions,
										contributed_values,
										interrupt_grace,
										bridges,
									)
									.await;
								},
								_ if Instant::now() >= deadline => break,
								_ => time::sleep(Duration::from_millis(50)).await,
							}
						}
						tracing::warn!(
							socket = %socket.display(),
							"stale-build environment daemon kept its socket; using an in-process environment"
						);
					},
					Ok(_) => {
						let owner_bridge = tokio::spawn(async move {
							let _ = bridge.await;
						});
						return Self::connect_peer(
							root,
							state_dir,
							docserver_socket,
							py_eval,
							approval_mode,
							trusted_extensions,
							contributed_values,
							interrupt_grace,
							owner_probe,
							owner_bridge,
							bridges,
						)
						.await;
					},
					Err(EnvdError::Client(omp_env::ClientError::Protocol(error))) => {
						// Owners from before the current schema revision reject
						// the hello outright; their endpoint drains with its
						// owner while this process stays in-process.
						bridge.abort();
						tracing::warn!(
							socket = %socket.display(),
							code = error.code,
							message = %error.message,
							"environment owner rejected the handshake; using an in-process environment"
						);
					},
					Err(error) => return Err(error),
				}
				Self::start(
					root,
					state_dir,
					socket,
					docserver_socket,
					py_eval,
					approval_mode,
					trusted_extensions,
					contributed_values,
					interrupt_grace,
					bridges,
				)
				.await
			},
			Err(EnvdError::Io(error))
				if matches!(
					error.kind(),
					io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
				) =>
			{
				// No owner: autostart a detached project daemon so the shared
				// authorities outlive this process, then join it as a peer.
				match spawn_project_daemon(root, state_dir, socket, docserver_socket).await {
					Ok(()) => {
						Self::connect_owner_peer(
							root,
							state_dir,
							socket,
							docserver_socket,
							py_eval,
							approval_mode,
							trusted_extensions,
							contributed_values,
							interrupt_grace,
							bridges,
						)
						.await
					},
					Err(error) => {
						tracing::warn!(
							socket = %socket.display(),
							%error,
							"could not autostart the project daemon; running an embedded environment"
						);
						Self::start(
							root,
							state_dir,
							socket,
							docserver_socket,
							py_eval,
							approval_mode,
							trusted_extensions,
							contributed_values,
							interrupt_grace,
							bridges,
						)
						.await
					},
				}
			},
			Err(error) => Err(error),
		}
	}

	/// Connects to or starts the owner-scoped Windows project environment.
	///
	/// An approval-mode override is retained only by this composition.
	#[cfg(windows)]
	pub async fn connect_or_start(
		root: &Path,
		state_dir: &Path,
		socket: &Path,
		docserver_socket: &Path,
		py_eval: bool,
		approval_mode: Option<ApprovalMode>,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		interrupt_grace: omp_core::Duration,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		use crate::windows::{connect_owner_pipe, open_owner_pipe};
		match connect_owner_pipe(socket) {
			Ok((owner_probe, bridge)) => {
				match hello(&owner_probe).await {
					Ok(owner_hello)
						if omp_env::build_id::is_stale(
							omp_env::build_id::current(),
							&owner_hello.server_build,
						) =>
					{
						let _ = owner_probe.retire().await;
						bridge.abort();
						let deadline = Instant::now() + Duration::from_secs(5);
						loop {
							match open_owner_pipe(socket) {
								Err(error) if error.kind() == io::ErrorKind::NotFound => {
									return Self::start(
										root,
										state_dir,
										socket,
										docserver_socket,
										py_eval,
										approval_mode,
										trusted_extensions,
										contributed_values,
										interrupt_grace,
										bridges,
									)
									.await;
								},
								_ if Instant::now() >= deadline => break,
								_ => time::sleep(Duration::from_millis(50)).await,
							}
						}
					},
					Ok(_) => {
						let owner_bridge = tokio::spawn(async move {
							let _ = bridge.await;
						});
						return Self::connect_peer(
							root,
							state_dir,
							docserver_socket,
							py_eval,
							approval_mode,
							trusted_extensions,
							contributed_values,
							interrupt_grace,
							owner_probe,
							owner_bridge,
							bridges,
						)
						.await;
					},
					Err(omp_env::ClientError::Protocol(error)) => {
						bridge.abort();
						tracing::warn!(
							socket = %socket.display(),
							code = error.code,
							message = %error.message,
							"environment owner rejected the handshake; joining document authority"
						);
					},
					Err(error) => return Err(EnvdError::Client(error)),
				}
				Self::start(
					root,
					state_dir,
					socket,
					docserver_socket,
					py_eval,
					approval_mode,
					trusted_extensions,
					contributed_values,
					interrupt_grace,
					bridges,
				)
				.await
			},
			Err(error)
				if matches!(
					error.kind(),
					io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
				) =>
			{
				match spawn_project_daemon(root, state_dir, socket, docserver_socket).await {
					Ok(()) => {
						Self::connect_owner_peer(
							root,
							state_dir,
							socket,
							docserver_socket,
							py_eval,
							approval_mode,
							trusted_extensions,
							contributed_values,
							interrupt_grace,
							bridges,
						)
						.await
					},
					Err(error) => {
						tracing::warn!(
							socket = %socket.display(),
							%error,
							"could not autostart the project daemon; running an embedded environment"
						);
						Self::start(
							root,
							state_dir,
							socket,
							docserver_socket,
							py_eval,
							approval_mode,
							trusted_extensions,
							contributed_values,
							interrupt_grace,
							bridges,
						)
						.await
					},
				}
			},
			Err(error) => Err(error.into()),
		}
	}

	/// Starts an isolated in-process environment from one exact layered settings
	/// snapshot.
	///
	/// This path never joins or reuses an existing environment owner, so every
	/// tool and security owner is composed from `settings` for `root`.
	pub async fn start_with_settings_snapshot(
		root: &Path,
		state_dir: &Path,
		docserver_socket: &Path,
		py_eval: bool,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		settings: Arc<SettingsSnapshot>,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let interrupt_grace = settings
			.project::<host_settings::HostSettings>()
			.map_err(|error| EnvdError::State(Str::from(error.to_string())))?
			.get()
			.runtime
			.interrupt_grace;
		let command_credentials = bridges.command_credentials.clone();
		let dynamic_tool_factories = bridges.dynamic_tool_factories.clone();
		let (worker_config, data_bindings) = worker_config(
			state_dir,
			py_eval,
			trusted_extensions,
			contributed_values,
			interrupt_grace,
		)?;
		let server = EnvServer::open_project(
			root,
			state_dir,
			docserver_socket,
			Registry::new(),
			None,
			worker_config,
			None,
			false,
			None,
			Some(settings.as_ref()),
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
		spawn_extension_data_servers(&server, data_bindings, &shutdown, &mut tasks);
		hello(&client).await?;
		let lifecycle = ProjectLifecycle { shutdown: Some(shutdown), tasks, server };
		Ok(Self {
			client,
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			lifecycle,
		})
	}

	/// Joins the project as a peer of an already-running owner environment.
	#[cfg(unix)]
	async fn connect_owner_peer(
		root: &Path,
		state_dir: &Path,
		socket: &Path,
		docserver_socket: &Path,
		py_eval: bool,
		approval_mode: Option<ApprovalMode>,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		interrupt_grace: omp_core::Duration,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let (owner, bridge) = EnvServer::connect_owner_uds(socket).await?;
		hello(&owner).await?;
		let bridge = tokio::spawn(async move {
			let _ = bridge.await;
		});
		Self::connect_peer(
			root,
			state_dir,
			docserver_socket,
			py_eval,
			approval_mode,
			trusted_extensions,
			contributed_values,
			interrupt_grace,
			owner,
			bridge,
			bridges,
		)
		.await
	}

	#[cfg(windows)]
	async fn connect_owner_peer(
		root: &Path,
		state_dir: &Path,
		socket: &Path,
		docserver_socket: &Path,
		py_eval: bool,
		approval_mode: Option<ApprovalMode>,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		interrupt_grace: omp_core::Duration,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let (owner, bridge) = crate::windows::connect_owner_pipe(socket)?;
		hello(&owner).await?;
		let bridge = tokio::spawn(async move {
			let _ = bridge.await;
		});
		Self::connect_peer(
			root,
			state_dir,
			docserver_socket,
			py_eval,
			approval_mode,
			trusted_extensions,
			contributed_values,
			interrupt_grace,
			owner,
			bridge,
			bridges,
		)
		.await
	}

	/// Joins the project as a peer of an already-running owner environment.
	///
	/// The composition serves tools in-process and holds only client
	/// connections to shared authorities, so dropping it never affects other
	/// connected apps.
	async fn connect_peer(
		root: &Path,
		state_dir: &Path,
		docserver_socket: &Path,
		py_eval: bool,
		approval_mode: Option<ApprovalMode>,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		interrupt_grace: omp_core::Duration,
		owner_client: EnvClient,
		owner_bridge: JoinHandle<()>,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let command_credentials = bridges.command_credentials.clone();
		let dynamic_tool_factories = bridges.dynamic_tool_factories.clone();
		let (worker_config, data_bindings) = worker_config(
			state_dir,
			py_eval,
			trusted_extensions,
			contributed_values,
			interrupt_grace,
		)?;
		let dynamic_tool_client = owner_client.clone();
		let server = EnvServer::open_project(
			root,
			state_dir,
			docserver_socket,
			Registry::new(),
			Some(owner_client),
			worker_config,
			None,
			false,
			approval_mode,
			None,
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
			dynamic_tool_client,
			root,
		);
		let in_process_server = Arc::clone(&server);
		let in_process =
			tokio::spawn(async move { in_process_server.serve_in_process(transport).await });
		let shutdown = CancellationToken::new();
		let mut tasks = vec![in_process, owner_bridge];
		spawn_extension_data_servers(&server, data_bindings, &shutdown, &mut tasks);
		hello(&client).await?;
		let lifecycle = ProjectLifecycle { shutdown: Some(shutdown), tasks, server };
		Ok(Self {
			client,
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			lifecycle,
		})
	}

	#[cfg(unix)]
	async fn start(
		root: &Path,
		state_dir: &Path,
		socket: &Path,
		docserver_socket: &Path,
		py_eval: bool,
		approval_mode: Option<ApprovalMode>,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		interrupt_grace: omp_core::Duration,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let command_credentials = bridges.command_credentials.clone();
		let dynamic_tool_factories = bridges.dynamic_tool_factories.clone();
		let (worker_config, data_bindings) = worker_config(
			state_dir,
			py_eval,
			trusted_extensions,
			contributed_values,
			interrupt_grace,
		)?;
		let server = EnvServer::open_project(
			root,
			state_dir,
			docserver_socket,
			Registry::new(),
			None,
			worker_config,
			None,
			false,
			approval_mode,
			None,
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
		let in_process = tokio::spawn(async move {
			in_process_server.serve_in_process(transport).await;
		});
		hello(&client).await?;
		let shutdown = CancellationToken::new();
		let uds_server = Arc::clone(&server);
		let uds_shutdown = shutdown.clone();
		let socket = socket.to_path_buf();
		let uds = tokio::spawn(async move {
			if let Err(error) = uds_server.serve_uds(&socket, uds_shutdown, None).await {
				// A lost same-build bind race is benign: the winner serves the
				// endpoint while this composition stays fully in-process.
				tracing::debug!(
					socket = %socket.display(),
					%error,
					"environment socket is served by another process"
				);
			}
		});
		let mut tasks = vec![in_process, uds];
		spawn_extension_data_servers(&server, data_bindings, &shutdown, &mut tasks);
		let lifecycle = ProjectLifecycle { shutdown: Some(shutdown), tasks, server };
		Ok(Self {
			client,
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			lifecycle,
		})
	}

	#[cfg(windows)]
	async fn start(
		root: &Path,
		state_dir: &Path,
		socket: &Path,
		docserver_socket: &Path,
		py_eval: bool,
		approval_mode: Option<ApprovalMode>,
		trusted_extensions: &[ExtHostSpec],
		contributed_values: &[ContributedCliValue],
		interrupt_grace: omp_core::Duration,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let owner_listener = OwnerPipeListener::bind(socket)?;
		let command_credentials = bridges.command_credentials.clone();
		let dynamic_tool_factories = bridges.dynamic_tool_factories.clone();
		let (worker_config, data_bindings) = worker_config(
			state_dir,
			py_eval,
			trusted_extensions,
			contributed_values,
			interrupt_grace,
		)?;
		let server = EnvServer::open_project(
			root,
			state_dir,
			docserver_socket,
			Registry::new(),
			None,
			worker_config,
			None,
			false,
			approval_mode,
			None,
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
		let in_process = tokio::spawn(async move {
			in_process_server.serve_in_process(transport).await;
		});
		hello(&client).await?;
		let shutdown = CancellationToken::new();
		let owner_server = Arc::clone(&server);
		let owner_shutdown = shutdown.clone();
		let owner = tokio::spawn(async move {
			if let Err(error) =
				windows::serve_owner_pipe(owner_server, owner_listener, owner_shutdown, None).await
			{
				tracing::warn!(%error, "environment owner pipe stopped");
			}
		});
		let mut tasks = vec![in_process, owner];
		spawn_extension_data_servers(&server, data_bindings, &shutdown, &mut tasks);
		let lifecycle = ProjectLifecycle { shutdown: Some(shutdown), tasks, server };
		Ok(Self {
			client,
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			lifecycle,
		})
	}

	/// Starts an embedded Environment rooted at one isolated worktree.
	pub async fn isolated(
		root: &Path,
		state_dir: &Path,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let command_credentials = bridges.command_credentials.clone();
		let dynamic_tool_factories = bridges.dynamic_tool_factories.clone();
		let (worker_config, data_bindings) =
			worker_config(state_dir, true, &[], &[], omp_tool::DEFAULT_INTERRUPT_GRACE)?;
		let server = Arc::new(
			EnvServer::open_local(root, state_dir, Registry::new(), worker_config, bridges).await?,
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
		spawn_extension_data_servers(&server, data_bindings, &shutdown, &mut tasks);
		hello(&client).await?;
		let lifecycle = ProjectLifecycle { shutdown: Some(shutdown), tasks, server };
		Ok(Self {
			client,
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			lifecycle,
		})
	}

	/// Returns the typed Environment client for this composition.
	pub const fn client(&self) -> &EnvClient {
		&self.client
	}

	/// Binds the application's shared credential authority and MCP OAuth flow
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
			.map_err(|error| EnvdError::State(Str::from(error.to_string())))
	}

	/// Returns the immutable production tool registry.
	pub fn registry(&self) -> Arc<Registry> {
		Arc::clone(&self.registry)
	}

	/// Returns the Environment-owned document host.
	pub fn documents(&self) -> &docs::DocumentHost {
		self.lifecycle.server.documents()
	}

	/// Binds or clears the editor-owned terminal backend for this environment
	/// composition.
	pub fn bind_acp_exec(&self, backend: Option<Arc<dyn tool_shell::AcpExecBackend>>) {
		self.lifecycle.server.bind_acp_exec(backend);
	}

	/// Binds or clears the editor-owned document backend for this environment
	/// composition.
	pub fn bind_acp_documents(&self, backend: Option<Arc<dyn docs::AcpDocumentBackend>>) {
		self.lifecycle.server.bind_acp_documents(backend);
	}

	/// Replaces the ask presenter for this environment composition.
	pub fn bind_ask_presenter(&self, presenter: Arc<dyn omp_tools::ask::AskPresenter>) {
		self.lifecycle.server.bind_ask_presenter(presenter);
	}

	/// Binds or clears the durable approval authority for Environment
	/// fallbacks.
	pub fn bind_approval_authority(
		&self,
		book: Option<Arc<omp_agent::ApprovalBook>>,
		route: Option<omp_agent::ApprovalRoute>,
	) {
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
	) -> Result<impl Drop + use<>, BridgeHostError> {
		self.eval_bridge.bind_sdk_parent(owner, parent)
	}

	/// Returns the late-bound memory reflection bridge.
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
	pub fn github_credentials(&self) -> Arc<GithubCredentialBridge> {
		Arc::clone(&self.github_credentials)
	}

	/// Returns the Environment-owned authoritative sessions index.
	pub fn sessions_index(&self) -> Arc<SessionIndex> {
		self.lifecycle.server.sessions_index()
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
	/// provider, regime, presentation, and job owners.
	pub fn extension_callback_dispatcher(&self) -> Arc<dyn CallbackDispatcher> {
		self.lifecycle.server.extension_callback_dispatcher()
	}

	/// Returns a cloneable extension-generation replacement authority.
	pub fn extension_reload_handle(&self) -> ExtensionReloadHandle {
		ExtensionReloadHandle { server: Arc::clone(&self.lifecycle.server) }
	}

	/// Returns the shared extension and built-in provider usage registry.
	pub fn usage_fetchers(&self) -> omp_inference::operation::usage::UsageFetcherRegistry {
		self.lifecycle.server.usage_fetchers()
	}

	/// Returns the sealed deployment manifest only when every authenticated
	/// connection and generation fact exactly matches the live activation.
	pub fn extension_control_manifest(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<ExtensionManifest> {
		self.lifecycle.server.extension_control_manifest(identity)
	}

	/// Returns full frozen provider and regime declarations for one exact
	/// authenticated extension generation.
	pub fn extension_registry_evidence(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<Arc<worker::SealedRegistryEvidence>> {
		self.lifecycle.server.extension_registry_evidence(identity)
	}

	/// Returns the live resolver over exact-generation regime declarations
	/// retained from extension FREEZE acknowledgments.
	pub fn extension_regime_resolver(&self) -> Arc<worker::ExtensionRegimeResolver> {
		let server = Arc::clone(&self.lifecycle.server);
		let callbacks = server.extension_callback_dispatcher();
		worker::ExtensionRegimeResolver::new(callbacks, move |identity| {
			server.extension_registry_evidence(identity)
		})
	}

	/// Returns a cloneable authority for retained MCP commands and inspection.
	pub fn mcp_inspector(&self) -> McpInspectorHandle {
		McpInspectorHandle { manager: Arc::clone(self.lifecycle.server.mcp_manager()) }
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

	/// Binds authenticated extension CONTROL to the active Agent Journal until
	/// the returned sole-owner lease is dropped.
	///
	/// # Errors
	///
	/// Fails if a journal runtime is concurrently owned or an initial binding
	/// is attempted after child activation began.
	pub fn bind_agent_control(
		&self,
		sender: ControlSender,
	) -> Result<server::AgentControlBinding, EnvdError> {
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
	pub fn bind_device_availability(&self, mailbox: omp_agent::MailboxSender) {
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
	let mut bindings = Vec::new();
	if py_eval {
		let key = HostKey::new("workspace", "trusted", PY_EVAL_MODULE);
		let binding = ExtensionDataBinding::built_in(
			state_dir,
			key.clone(),
			session_id.as_str(),
			session_generation,
		);
		let mut digest = Hash32::hasher();
		digest.update(omp_env::build_id::current().as_bytes());
		digest.update(env!("CARGO_PKG_VERSION").as_bytes());
		digest.update(PY_EVAL_MODULE.as_bytes());
		let provenance = omp_core::Provenance::new(
			sf!("omp-first-party"),
			sf!(PY_EVAL_MODULE),
			sf!(env!("CARGO_PKG_VERSION")),
			omp_core::ArtifactDigest::new(digest.finalize().into_bytes()),
			sf!("workspace"),
			sf!("trusted"),
			1,
		);
		let manifest = ExtensionManifest::py_eval(provenance, []);
		let mut extension = ExtHostSpec::new(key, manifest);
		extension.data_grants = binding.grants().clone();
		extension.data_socket = Some(extension_data_endpoint(&binding));
		config.extensions.push(extension);
		bindings.push(binding);
	}
	config.extensions.extend_from_slice(trusted_extensions);
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
	Ok(client
		.hello(ClientHello {
			client: "omp-chat".into(),
			schema_rev: omp_proto::SCHEMA_REV,
			..ClientHello::default()
		})
		.await?)
}

/// Launches a detached `omp envd` for this project and waits until its
/// environment socket answers a hello.
async fn spawn_project_daemon(
	root: &Path,
	state_dir: &Path,
	socket: &Path,
	docserver_socket: &Path,
) -> Result<(), EnvdError> {
	let executable = env::current_exe()?;
	spawn_project_daemon_with(
		&executable,
		root,
		state_dir,
		socket,
		docserver_socket,
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
/// to an embedded environment.
async fn spawn_project_daemon_with(
	executable: &Path,
	root: &Path,
	state_dir: &Path,
	socket: &Path,
	docserver_socket: &Path,
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
	let deadline = Instant::now() + deadline;
	loop {
		if let Some(status) = child.try_wait()? {
			return Err(
				io::Error::other(format!("project daemon exited during startup: {status}")).into(),
			);
		}
		if owner_endpoint_ready(socket).await {
			// Reap in the background; the daemon's lifetime is its own.
			tokio::spawn(async move {
				let _ = child.wait().await;
			});
			return Ok(());
		}
		if Instant::now() >= deadline {
			let _ = child.start_kill();
			tokio::spawn(async move {
				let _ = child.wait().await;
			});
			return Err(
				io::Error::new(io::ErrorKind::TimedOut, "project daemon did not become ready").into(),
			);
		}
		time::sleep(Duration::from_millis(50)).await;
	}
}

#[cfg(unix)]
async fn owner_endpoint_ready(socket: &Path) -> bool {
	let Ok((probe, bridge)) = EnvServer::connect_owner_uds(socket).await else {
		return false;
	};
	let ready = hello(&probe).await.is_ok();
	bridge.abort();
	ready
}

#[cfg(windows)]
async fn owner_endpoint_ready(socket: &Path) -> bool {
	use crate::windows::connect_owner_pipe;
	let Ok((probe, bridge)) = connect_owner_pipe(socket) else {
		return false;
	};
	let ready = hello(&probe).await.is_ok();
	bridge.abort();
	ready
}

#[cfg(all(test, unix))]
mod tests {
	use super::*;

	async fn spawn_with(executable: &Path, deadline_ms: u64) -> Result<(), EnvdError> {
		let scratch = tempfile::tempdir().expect("scratch state directory");
		spawn_project_daemon_with(
			executable,
			scratch.path(),
			scratch.path(),
			&scratch.path().join("env.sock"),
			&scratch.path().join("doc.sock"),
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
	async fn spawn_kills_a_daemon_that_never_becomes_ready() {
		use std::os::unix::fs::PermissionsExt as _;

		let scratch = tempfile::tempdir().expect("scratch script directory");
		let script = scratch.path().join("hang.sh");
		fs::write(&script, "#!/bin/sh\nexec sleep 30\n").expect("write hang script");
		fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
			.expect("mark script executable");

		let error = spawn_with(&script, 300)
			.await
			.expect_err("unready daemon must time out");
		let EnvdError::Io(error) = &error else {
			panic!("unexpected error: {error}");
		};
		assert_eq!(error.kind(), io::ErrorKind::TimedOut);
	}
}
