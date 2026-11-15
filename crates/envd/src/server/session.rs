//! Environment assembly and the owner-local accept loop.

#[cfg(unix)]
use super::identity::{PreparedEndpoint, UnixSocketPathGuard};
#[cfg(windows)]
use super::runtime::connect_or_start_docserver;
#[cfg(any(unix, windows))]
use super::runtime::rehost_document_authority;
#[cfg(unix)]
use super::runtime::{connect_or_start_docserver, ensure_directory};
use super::{
	ApprovalAuthoritySlot, ConnectionState, EnvServer, EnvironmentAuthorities, HANDSHAKE_TIMEOUT,
	LoopEvent, MIN_SCHEMA_REV, NEXT_AGENT_CONTROL_BINDING,
	control_factories::{
		WeakExtensionCallbackDispatcher, bind_live_session_authority_snapshot,
		production_control_authorities, register_extension_convars,
	},
	devices::{PreludeBridgeInvoker, WorkerDeviceInvoker},
	diagnostics::{AgentControlBinding, LateDiagnosticsBatcher},
	error::EnvdError,
	forward::{
		read_client_frame, read_server_frame, send_error, send_policy_denied_verdict, server_frame,
		write_client_frame, write_server_frame,
	},
	identity::{
		AcceptedHello, ConnectionPolicy, ExtensionDataBinding, ServerIdentity,
		approval_mode_from_wire,
	},
	prelude::*,
	runtime::{DocumentConfigInputs, document_user_config_root},
};

pub(in crate::server) fn execution_settings(
	ctx: &Ctx,
) -> (HostSettings, ShellSettings, SandboxSettings) {
	(HostSettings::from_con(ctx), ShellSettings::from_con(ctx), SandboxSettings::from_con(ctx))
}

/// Ensures production URL resolvers and FREEZE share one [`SchemeGeneration`].
fn install_scheme_generation(
	bridges: &mut RegistryBridges,
	ext_host_config: &mut ExtHostConfig,
) -> Arc<crate::SchemeGeneration> {
	let generation = Arc::new(crate::SchemeGeneration::new());
	if bridges.host_resources.is_none() {
		bridges.host_resources = Some(Arc::clone(&generation) as Arc<dyn crate::HostResources>);
	}
	ext_host_config.bind_scheme_generation(Arc::clone(&generation));
	generation
}

pub(in crate::server) async fn start_memory_runtime(
	settings: &HostSettings,
	data_dir: &Path,
	project_root: &Path,
	session_id: &Str,
) -> Result<RegisteredMemoryRuntime, EnvdError> {
	let snapshot = if settings.memory.backend == omp_memory::MemoryBackend::Off {
		None
	} else {
		let cancel = CancellationToken::new();
		Some(
			vcs::snapshot(project_root, &cancel)
				.await
				.map_err(EnvdError::state)?,
		)
	};
	memory::start(
		settings.memory.backend,
		&settings.mnemopi,
		data_dir,
		session_id.clone(),
		project_root.to_path_buf(),
		snapshot.as_ref(),
	)
	.map_err(EnvdError::state)
}

pub(in crate::server) fn workspace_update_failure(
	checked_at_ms: u64,
	code: impl Into<String>,
	message: impl Into<String>,
) -> pb::WorkspaceUpdateReport {
	pb::WorkspaceUpdateReport {
		checked: true,
		failure: Some(pb::ExtensionUpdateFailure { code: code.into(), message: message.into() }),
		checked_at_ms,
		..pb::WorkspaceUpdateReport::default()
	}
}
pub(in crate::server) async fn fetch_extension_metadata(url: &str) -> Result<Vec<u8>, ()> {
	const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
	let response = reqwest::get(url).await.map_err(|_| ())?;
	if !response.status().is_success() {
		return Err(());
	}
	let bytes = response.bytes().await.map_err(|_| ())?;
	if bytes.len() > MAX_METADATA_BYTES {
		return Err(());
	}
	Ok(bytes.to_vec())
}

pub(in crate::server) fn write_extension_metadata(path: &Path, bytes: &[u8]) -> io::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	let temporary = path.with_extension("tmp");
	fs::write(&temporary, bytes)?;
	fs::rename(temporary, path)
}

pub(in crate::server) fn update_refusal_wire(
	refusal: omp_ext::upgrade::UpdateRefusal,
) -> pb::ExtensionUpdateRefusal {
	use omp_ext::upgrade::UpdateRefusal;
	match refusal {
		UpdateRefusal::FeatureRemoved => pb::ExtensionUpdateRefusal::FeatureRemoved,
		UpdateRefusal::CapabilityChanged => pb::ExtensionUpdateRefusal::CapabilityChanged,
		UpdateRefusal::Pinned => pb::ExtensionUpdateRefusal::Pinned,
		UpdateRefusal::StaleRevocations => pb::ExtensionUpdateRefusal::StaleRevocations,
		UpdateRefusal::BadSignature => pb::ExtensionUpdateRefusal::BadSignature,
		UpdateRefusal::AttestationMissing => pb::ExtensionUpdateRefusal::Attestation,
		UpdateRefusal::PublisherChanged => pb::ExtensionUpdateRefusal::PublisherChanged,
		UpdateRefusal::Yanked => pb::ExtensionUpdateRefusal::Yanked,
		UpdateRefusal::Revoked => pb::ExtensionUpdateRefusal::Revoked,
		UpdateRefusal::Integrity => pb::ExtensionUpdateRefusal::Integrity,
	}
}

impl EnvServer {
	/// Clones the process lifecycle authority used by daemon-idle policy.
	pub(crate) fn process_host(&self) -> ExecHost {
		self.exec.clone()
	}

	pub(in crate::server) fn new(
		identity: ServerIdentity,
		environment: Option<EnvironmentAuthorities>,
		tool_settings: ToolSettings,
		exec: ExecHost,
		workspace: WorkspaceHost,
		mcp: Arc<McpService>,
		mcp_manager: Arc<McpManager>,
		resources: Arc<ResolverTable<UrlResolver>>,
		memory_runtime: RegisteredMemoryRuntime,
		blobs: BlobHost,
		sites: SiteMaterializer,
		materializations: ResourceMaterializer,
		registry: Arc<Registry>,
		ask_presenter: PresenterSlot,
		ext_hosts: Arc<ExtHostSupervisor>,
		eval_bridge: Arc<SessionBridgeHost>,
		reflection_bridge: Arc<ReflectionBridgeHost>,
		eval_control: EvalSessionControl,
		search_bridge: Arc<SearchBridgeHost>,
		github_credentials: Arc<ForgeCredentialBridge>,
		usage_fetchers: omp_ai::operation::usage::UsageFetcherRegistry,
		provider_response_hooks: omp_ai::ProviderResponseHooks,
		admission_gate: Arc<HookGate>,
		checkpoint_control: AgentCheckpointControl,
		previews: StagedProposalRegistry,
		schedules: DurableScheduleActor,
		authority: Arc<AuthorityTable>,
		state_dir: &Path,
		#[cfg(feature = "cap-forge")] forge_devices: crate::forge_adapter::LiveForgeDeviceClient,
		#[cfg(feature = "cap-ci")] ci_devices: crate::forge_adapter::LiveCiDeviceClient,
	) -> Self {
		let host_info = HostInfoHost::new(state_dir);
		let workspace_roots =
			WorkspaceRootHost::new(identity.root_uri.as_str(), identity.workspace_id.clone());
		let presence = PresenceRegistry::new(state_dir, workspace.root());
		Self {
			identity,
			environment,
			tool_settings,
			exec,
			approvals: ApprovalAuthoritySlot::default(),
			http_egress: HttpEgressHost::new(),
			workspace,
			mcp,
			mcp_manager,
			host_info,
			workspace_roots,
			resources,
			_memory_runtime: memory_runtime,
			blobs,
			sites,
			materializations,
			registry,
			ask_presenter,
			ext_hosts,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			usage_fetchers,
			provider_response_hooks,
			admission_gate,
			checkpoint_control,
			previews,
			schedules,
			workers: Arc::new(WorkerSupervisor::new(
				DEFAULT_WORKER_LAYER_CEILING,
				DEFAULT_MAX_CONCURRENT_SPAWNS,
			)),
			authority,
			repository_revision: AtomicU64::new(0),
			presence,
			state_dir: state_dir.to_path_buf(),
			#[cfg(feature = "cap-forge")]
			forge_devices,
			#[cfg(feature = "cap-ci")]
			ci_devices,
		}
	}

	/// Opens a complete local environment host rooted at `root`.
	///
	/// The document authority, workspace, blob store, executor, and Python
	/// worker are real environment-owned resources. `state_dir` is kept
	/// separate from the workspace so callers can use an isolated scratch
	/// directory without adding daemon state to the project tree.
	#[tracing::instrument(
		name = "environment_open",
		level = "debug",
		skip_all,
		fields(mode = "local", root = %root.display(), state_dir = %state_dir.display())
	)]
	pub async fn open_local(
		root: &Path,
		state_dir: &Path,
		registry: Registry,
		mut ext_host_config: ExtHostConfig,
		con: &Ctx,
		convars: Arc<dyn ControlAuthorityFactory>,
		mut bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let scheme_generation = install_scheme_generation(&mut bridges, &mut ext_host_config);
		let workspace = WorkspaceHost::open(root)?;
		let mcp = McpService::open(state_dir.join("mcp-cache.sqlite3")).map_err(EnvdError::state)?;
		mcp.bind_config_paths(
			McpConfigPaths::new(&omp_core::dirs::user_config_root()?, workspace.root())
				.with_agent_plugin_roots(bridges.content.agent_plugin_roots.clone())
				.with_claude_plugins(Arc::clone(&bridges.content.claude_plugins))
				.with_command_approvals(bridges.content.command_approvals.clone()),
		);
		let lsp_settings = LspSettings::from_con(con);
		let workspace_trust = bridges.content.workspace_trust;
		let doc_config = crate::docserver::ServerConfig::new(root)
			.map_err(EnvdError::document)?
			.with_server_build(omp_env::build_id::current())
			.with_project_binaries(lsp_settings.project_binaries)
			.with_workspace_trust(workspace_trust);
		let environment =
			crate::docserver::Environment::new(doc_config).map_err(EnvdError::document)?;
		let (document_client, document_server) = duplex(64 * 1024);
		tokio::spawn(async move {
			let _ = crate::docserver::connection::serve_connection(
				environment,
				document_server,
				ConnectionConfig::default(),
			)
			.await;
		});
		let documents = DocumentHost::connect(document_client).await?;
		let hello = documents.hello().clone();
		let interrupt_grace = ext_host_config.interrupt_grace;
		let py_eval = ext_host_config.py_eval;
		let session_id = ext_host_config.session_id.clone();
		let authority = Arc::new(AuthorityTable::default());
		ext_host_config.bind_workspace_root(workspace.root());
		ext_host_config.bind_data_authority(Arc::clone(&authority));
		bind_live_session_authority_snapshot(
			&mut ext_host_config,
			workspace.root(),
			bridges.session_authority.as_ref(),
		);
		let forge_cache = Arc::new(
			ForgeCache::open(
				state_dir.join("forge-cache.sqlite3"),
				ForgeCacheSettings::from_con(con).policy(),
			)
			.map_err(EnvdError::state)?,
		);
		let blobs = BlobHost::open_managed(
			omp_env::project_state::blob_store(state_dir),
			state_dir.join("sessions"),
		)?;
		ext_host_config.bind_result_store(blobs.clone());
		let exec = ExecHost::new()
			.with_process_store(ProcessStore::new(state_dir.join("processes").join("meta.json")))?
			.with_forge_cache(Arc::clone(&forge_cache))
			.with_output_store(blobs.store().clone());
		let telemetry = Arc::new(
			TelemetryIndex::open(&state_dir.join("telemetry"), &state_dir.join("telemetry.sqlite3"))
				.map_err(EnvdError::state)?,
		);
		let local_root =
			crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id);
		let mcp_manager = McpManager::new(
			Arc::clone(&mcp),
			Arc::new(ProductionConnector::new(workspace.root().to_path_buf())),
			Arc::from([hello.root_uri.clone()]),
			local_root,
		);
		mcp.bind_manager(&mcp_manager);
		mcp_manager.bind_runtime_settings(con);
		register_extension_convars(con, &ext_host_config.extensions)?;
		let schedules = DurableScheduleActor::spawn(state_dir)?;
		let control_bindings = production_control_authorities(
			state_dir,
			&session_id,
			&telemetry,
			&mcp,
			&ext_host_config.extensions,
			ext_host_config.domain_control_factories(),
			Arc::clone(&convars),
			ext_host_config.quota_runtime(),
			crate::extension_tool_call_timeout(con),
			Arc::clone(&scheme_generation),
		);
		mcp_manager.bind_notification_sink(control_bindings.hooks.clone());
		ext_host_config.bind_control_authorities(Arc::clone(&control_bindings.factory));
		ext_host_config.bind_registry_control(Arc::clone(&control_bindings.registry));
		ext_host_config.bind_hook_control(Arc::clone(&control_bindings.hooks));
		let ext_hosts = Arc::new(ExtHostSupervisor::spawn(ext_host_config).await?);
		control_bindings
			.callbacks
			.bind(Arc::new(WeakExtensionCallbackDispatcher {
				supervisor: Arc::downgrade(&ext_hosts),
			}));
		scheme_generation.bind_callbacks(Arc::clone(&control_bindings.callbacks)
			as Arc<dyn crate::exthost::dispatch::CallbackDispatcher>);
		let sites = SiteMaterializer::open(state_dir.join("ext"), blobs.store().clone())
			.map_err(EnvdError::blob)?;
		let materializations = ResourceMaterializer::open(
			workspace.root(),
			state_dir,
			&crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id),
		)?;
		let (mut host_settings, shell_settings, sandbox_settings) = execution_settings(con);
		#[cfg(feature = "cap-browser")]
		let browser_settings = BrowserSettings::from_con(con);
		host_settings.tools = host_settings.tools.with_workspace_trust(workspace_trust);
		let enforced = crate::daemon_policy::of(
			&sandbox_settings,
			&host_settings.tools,
			&shell_settings,
			workspace_trust,
		);
		exec.configure_sandbox(&sandbox_settings, workspace.root());
		let mcp_settings = McpSettings::from_con(con, workspace_trust);
		mcp.start_native_configs(mcp_settings.project_config)
			.await
			.map_err(EnvdError::state)?;
		let workspace_ops = WorkspaceOperations::open(
			workspace.clone(),
			documents.clone(),
			blobs.clone(),
			omp_env::project_state::project_worktree_root(
				state_dir,
				host_settings.worktree.base.as_deref(),
			),
		)?;
		let memory_runtime =
			start_memory_runtime(&host_settings, state_dir, workspace.root(), &session_id).await?;
		let (
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			checkpoint_control,
			previews,
			resources,
			search_bridge,
			github_credentials,
			ask_presenter,
		) = production_registry(
			&documents,
			&blobs,
			&exec,
			state_dir,
			con,
			session_id.as_str(),
			Arc::clone(&forge_cache),
			#[cfg(feature = "cap-forge")]
			control_bindings.forge_devices.clone(),
			#[cfg(feature = "cap-ci")]
			control_bindings.ci_devices.clone(),
			&mcp,
			Arc::clone(&mcp_manager),
			&workspace,
			memory_runtime.runtime(),
			&telemetry,
			&hello.root_uri,
			ext_hosts.as_ref(),
			interrupt_grace,
			py_eval,
			&host_settings.tools,
			#[cfg(feature = "cap-browser")]
			&browser_settings,
			&shell_settings,
			&sandbox_settings,
			&host_settings.autolearn,
			control_bindings.hooks.admission_gate(),
			WorkerDeviceInvoker::new(Arc::clone(&ext_hosts), blobs.clone()),
			PreludeBridgeInvoker::new(Arc::clone(&ext_hosts), blobs.clone()),
			omp_tool::ToolsPolicy::Auto,
			registry,
			bridges,
		)?;
		checkpoint_control.bind_local_workspace(workspace_ops.clone());
		control_bindings
			.resources
			.set(Arc::clone(&resources))
			.map_err(|_| EnvdError::State(sf!("CONTROL URL resolver owner was already bound")))?;
		ext_hosts.activate_control_hosts().await?;
		let identity = ServerIdentity {
			workspace_id: hello.workspace_id,
			root_uri: hello.root_uri,
			server_epoch: hello.server_epoch,
			server_version: Str::from(env!("CARGO_PKG_VERSION")),
			server_build: Str::from(omp_env::build_id::current()),
			policy: enforced,
			workspace_trust,
		};
		let usage_fetchers = control_bindings.hooks.usage_fetchers();
		let provider_response_hooks =
			omp_ai::ProviderResponseHooks::new(control_bindings.hooks.clone());
		let admission_gate = control_bindings.hooks.admission_gate();
		Ok(Self::new(
			identity,
			Some(EnvironmentAuthorities {
				documents,
				_document_authority: None,
				workspace_ops,
				lsp_settings,
				process_store: ProcessStore::new(state_dir.join("processes").join("meta.json")),
			}),
			host_settings.tools.clone(),
			exec,
			workspace,
			mcp,
			mcp_manager,
			resources,
			memory_runtime,
			blobs,
			sites,
			materializations,
			registry,
			ask_presenter,
			ext_hosts,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			usage_fetchers,
			provider_response_hooks,
			admission_gate,
			checkpoint_control,
			previews,
			schedules,
			authority,
			state_dir,
			#[cfg(feature = "cap-forge")]
			control_bindings.forge_devices,
			#[cfg(feature = "cap-ci")]
			control_bindings.ci_devices,
		))
	}

	/// Opens project resources through the owner-local document authority.
	///
	/// Only the daemon composition (`doc_connections` present) owns durable
	/// process metadata; app compositions keep in-memory process state and
	/// leave detached-process recovery to the daemon. An approval-mode override
	/// affects only this composition's in-memory tool settings.
	#[cfg(any(unix, windows))]
	#[tracing::instrument(
		name = "environment_open",
		level = "debug",
		skip_all,
		fields(
			mode = "project",
			root = %root.display(),
			state_dir = %state_dir.display(),
			daemon = doc_connections.is_some()
		)
	)]
	pub async fn open_project(
		root: &Path,
		state_dir: &Path,
		docserver_socket: &Path,
		registry: Registry,
		mut ext_host_config: ExtHostConfig,
		doc_connections: Option<watch::Sender<usize>>,
		require_document_ownership: bool,
		approval_mode: Option<crate::tool_settings::ApprovalMode>,
		con: &Ctx,
		convars: Arc<dyn ControlAuthorityFactory>,
		mut bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let scheme_generation = install_scheme_generation(&mut bridges, &mut ext_host_config);
		let workspace = WorkspaceHost::open(root)?;
		let root = workspace.root().to_path_buf();
		let mcp = McpService::open(state_dir.join("mcp-cache.sqlite3")).map_err(EnvdError::state)?;
		mcp.bind_config_paths(
			McpConfigPaths::new(&omp_core::dirs::user_config_root()?, workspace.root())
				.with_agent_plugin_roots(bridges.content.agent_plugin_roots.clone())
				.with_claude_plugins(Arc::clone(&bridges.content.claude_plugins))
				.with_command_approvals(bridges.content.command_approvals.clone()),
		);
		let lsp_settings = LspSettings::from_con(con);
		let document_lsp = lsp_settings.native_options();
		let workspace_trust = bridges.content.workspace_trust;
		let document_config = DocumentConfigInputs {
			user_config_root: Some(document_user_config_root()?),
			claude_plugins: Arc::clone(&bridges.content.claude_plugins),
			workspace_trust,
		};
		let server_build = Str::from(omp_env::build_id::current());
		let (documents, mut document_authority) = connect_or_start_docserver(
			&root,
			docserver_socket,
			doc_connections.clone(),
			require_document_ownership,
			document_lsp.clone(),
			document_config.clone(),
			server_build.clone(),
		)
		.await?;
		if !require_document_ownership {
			let retained_authority = Arc::new(tokio::sync::Mutex::new(document_authority.take()));
			let rehost_root = root.clone();
			let rehost_socket = docserver_socket.to_path_buf();
			let rehost_connections = doc_connections.clone();
			let rehost_state_dir = state_dir.to_path_buf();
			documents.install_rehost(Arc::new(move || -> crate::docs::RehostFuture {
				let retained_authority = Arc::clone(&retained_authority);
				let root = rehost_root.clone();
				let socket = rehost_socket.clone();
				let connections = rehost_connections.clone();
				let lsp = document_lsp.clone();
				let config = document_config.clone();
				let state_dir = rehost_state_dir.clone();
				let server_build = server_build.clone();
				Box::pin(async move {
					let mut retained = retained_authority.lock().await;
					retained.take();
					match rehost_document_authority(
						&root,
						&state_dir,
						&socket,
						connections,
						lsp,
						config,
						server_build,
					)
					.await
					{
						Ok(authority) => *retained = authority,
						Err(EnvdError::DocumentAuthorityHeldBy { .. }) => {},
						Err(error) => {
							tracing::debug!(%error, "document authority rehost race did not win");
						},
					}
				})
			}));
		}
		let hello = documents.hello().clone();
		let interrupt_grace = ext_host_config.interrupt_grace;
		let py_eval = ext_host_config.py_eval;
		let session_id = ext_host_config.session_id.clone();
		let authority = Arc::new(AuthorityTable::default());
		ext_host_config.bind_workspace_root(&root);
		ext_host_config.bind_data_authority(Arc::clone(&authority));
		bind_live_session_authority_snapshot(
			&mut ext_host_config,
			&root,
			bridges.session_authority.as_ref(),
		);
		let forge_cache = Arc::new(
			ForgeCache::open(
				state_dir.join("forge-cache.sqlite3"),
				ForgeCacheSettings::from_con(con).policy(),
			)
			.map_err(EnvdError::state)?,
		);
		let blobs = BlobHost::open_managed(
			omp_env::project_state::blob_store(state_dir),
			state_dir.join("sessions"),
		)?;
		ext_host_config.bind_result_store(blobs.clone());
		let exec = if doc_connections.is_some() {
			ExecHost::new()
				.with_process_store(ProcessStore::new(state_dir.join("processes").join("meta.json")))?
		} else {
			ExecHost::new()
		}
		.with_forge_cache(Arc::clone(&forge_cache))
		.with_output_store(blobs.store().clone());
		let telemetry = Arc::new(
			TelemetryIndex::open(&state_dir.join("telemetry"), &state_dir.join("telemetry.sqlite3"))
				.map_err(EnvdError::state)?,
		);
		let local_root =
			crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id);
		let mcp_manager = McpManager::new(
			Arc::clone(&mcp),
			Arc::new(ProductionConnector::new(workspace.root().to_path_buf())),
			Arc::from([hello.root_uri.clone()]),
			local_root,
		);
		mcp.bind_manager(&mcp_manager);
		mcp_manager.bind_runtime_settings(con);
		register_extension_convars(con, &ext_host_config.extensions)?;
		let schedules = DurableScheduleActor::spawn(state_dir)?;
		let control_bindings = production_control_authorities(
			state_dir,
			&session_id,
			&telemetry,
			&mcp,
			&ext_host_config.extensions,
			ext_host_config.domain_control_factories(),
			Arc::clone(&convars),
			ext_host_config.quota_runtime(),
			crate::extension_tool_call_timeout(con),
			Arc::clone(&scheme_generation),
		);
		mcp_manager.bind_notification_sink(control_bindings.hooks.clone());
		ext_host_config.bind_control_authorities(Arc::clone(&control_bindings.factory));
		ext_host_config.bind_registry_control(Arc::clone(&control_bindings.registry));
		ext_host_config.bind_hook_control(Arc::clone(&control_bindings.hooks));
		let ext_hosts = Arc::new(ExtHostSupervisor::spawn(ext_host_config).await?);
		control_bindings
			.callbacks
			.bind(Arc::new(WeakExtensionCallbackDispatcher {
				supervisor: Arc::downgrade(&ext_hosts),
			}));
		scheme_generation.bind_callbacks(Arc::clone(&control_bindings.callbacks)
			as Arc<dyn crate::exthost::dispatch::CallbackDispatcher>);
		let sites = SiteMaterializer::open(state_dir.join("ext"), blobs.store().clone())
			.map_err(EnvdError::blob)?;
		let materializations = ResourceMaterializer::open(
			workspace.root(),
			state_dir,
			&crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id),
		)?;
		let (mut host_settings, shell_settings, sandbox_settings) = execution_settings(con);
		#[cfg(feature = "cap-browser")]
		let browser_settings = BrowserSettings::from_con(con);
		let enforced = crate::daemon_policy::of(
			&sandbox_settings,
			&host_settings.tools,
			&shell_settings,
			workspace_trust,
		);
		exec.configure_sandbox(&sandbox_settings, workspace.root());
		host_settings.tools = host_settings
			.tools
			.with_workspace_trust(workspace_trust)
			.with_approval_mode_override(approval_mode);
		let mcp_settings = McpSettings::from_con(con, workspace_trust);
		mcp.start_native_configs(mcp_settings.project_config)
			.await
			.map_err(EnvdError::state)?;
		let workspace_ops = WorkspaceOperations::open(
			workspace.clone(),
			documents.clone(),
			blobs.clone(),
			omp_env::project_state::project_worktree_root(
				state_dir,
				host_settings.worktree.base.as_deref(),
			),
		)?;
		let memory_runtime =
			start_memory_runtime(&host_settings, state_dir, workspace.root(), &session_id).await?;
		let (
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			checkpoint_control,
			previews,
			resources,
			search_bridge,
			github_credentials,
			ask_presenter,
		) = production_registry(
			&documents,
			&blobs,
			&exec,
			state_dir,
			con,
			session_id.as_str(),
			Arc::clone(&forge_cache),
			#[cfg(feature = "cap-forge")]
			control_bindings.forge_devices.clone(),
			#[cfg(feature = "cap-ci")]
			control_bindings.ci_devices.clone(),
			&mcp,
			Arc::clone(&mcp_manager),
			&workspace,
			memory_runtime.runtime(),
			&telemetry,
			&hello.root_uri,
			ext_hosts.as_ref(),
			interrupt_grace,
			py_eval,
			&host_settings.tools,
			#[cfg(feature = "cap-browser")]
			&browser_settings,
			&shell_settings,
			&sandbox_settings,
			&host_settings.autolearn,
			control_bindings.hooks.admission_gate(),
			WorkerDeviceInvoker::new(Arc::clone(&ext_hosts), blobs.clone()),
			PreludeBridgeInvoker::new(Arc::clone(&ext_hosts), blobs.clone()),
			omp_tool::ToolsPolicy::Auto,
			registry,
			bridges,
		)?;
		checkpoint_control.bind_local_workspace(workspace_ops.clone());
		control_bindings
			.resources
			.set(Arc::clone(&resources))
			.map_err(|_| EnvdError::State(sf!("CONTROL URL resolver owner was already bound")))?;
		ext_hosts.activate_control_hosts().await?;
		let identity = ServerIdentity {
			workspace_id: hello.workspace_id,
			root_uri: hello.root_uri,
			server_epoch: hello.server_epoch,
			server_version: Str::from(env!("CARGO_PKG_VERSION")),
			server_build: Str::from(omp_env::build_id::current()),
			policy: enforced,
			workspace_trust,
		};
		let usage_fetchers = control_bindings.hooks.usage_fetchers();
		let provider_response_hooks =
			omp_ai::ProviderResponseHooks::new(control_bindings.hooks.clone());
		let admission_gate = control_bindings.hooks.admission_gate();
		Ok(Self::new(
			identity,
			Some(EnvironmentAuthorities {
				documents,
				_document_authority: document_authority,
				workspace_ops,
				lsp_settings,
				process_store: ProcessStore::new(state_dir.join("processes").join("meta.json")),
			}),
			host_settings.tools.clone(),
			exec,
			workspace,
			mcp,
			mcp_manager,
			resources,
			memory_runtime,
			blobs,
			sites,
			materializations,
			registry,
			ask_presenter,
			ext_hosts,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			usage_fetchers,
			provider_response_hooks,
			admission_gate,
			checkpoint_control,
			previews,
			schedules,
			authority,
			state_dir,
			#[cfg(feature = "cap-forge")]
			control_bindings.forge_devices,
			#[cfg(feature = "cap-ci")]
			control_bindings.ci_devices,
		))
	}

	/// Opens the session-owned half without composing project authorities or
	/// environment tool executors.
	#[tracing::instrument(
		name = "environment_open",
		level = "debug",
		skip_all,
		fields(mode = "session", root = %root.display(), state_dir = %state_dir.display())
	)]
	pub async fn open_session_host(
		root: &Path,
		state_dir: &Path,
		registry: Registry,
		mut ext_host_config: ExtHostConfig,
		approval_mode: Option<crate::tool_settings::ApprovalMode>,
		con: &Ctx,
		convars: Arc<dyn ControlAuthorityFactory>,
		mut bridges: RegistryBridges,
		owner: EnvClient,
	) -> Result<Self, EnvdError> {
		let scheme_generation = install_scheme_generation(&mut bridges, &mut ext_host_config);
		let owner_info = owner.info().ok_or(EnvdError::MissingOwnerHello)?;
		let workspace = WorkspaceHost::open(root)?;
		let root = workspace.root().to_path_buf();
		let py_eval = ext_host_config.py_eval;
		let session_id = ext_host_config.session_id.clone();
		let authority = Arc::new(AuthorityTable::default());
		ext_host_config.bind_workspace_root(&root);
		ext_host_config.bind_data_authority(Arc::clone(&authority));
		bind_live_session_authority_snapshot(
			&mut ext_host_config,
			&root,
			bridges.session_authority.as_ref(),
		);

		let mcp = McpService::open(state_dir.join("mcp-cache.sqlite3")).map_err(EnvdError::state)?;
		mcp.bind_config_paths(
			McpConfigPaths::new(&omp_core::dirs::user_config_root()?, &root)
				.with_agent_plugin_roots(bridges.content.agent_plugin_roots.clone())
				.with_claude_plugins(Arc::clone(&bridges.content.claude_plugins))
				.with_command_approvals(bridges.content.command_approvals.clone()),
		);
		let forge_cache = Arc::new(
			ForgeCache::open(
				state_dir.join("forge-cache.sqlite3"),
				ForgeCacheSettings::from_con(con).policy(),
			)
			.map_err(EnvdError::state)?,
		);
		let blobs = BlobHost::open_managed(
			omp_env::project_state::blob_store(state_dir),
			state_dir.join("sessions"),
		)?;
		ext_host_config.bind_result_store(blobs.clone());
		let exec = ExecHost::new()
			.with_forge_cache(Arc::clone(&forge_cache))
			.with_output_store(blobs.store().clone());
		let telemetry = Arc::new(
			TelemetryIndex::open(&state_dir.join("telemetry"), &state_dir.join("telemetry.sqlite3"))
				.map_err(EnvdError::state)?,
		);
		let local_root =
			crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id);
		let mcp_manager = McpManager::new(
			Arc::clone(&mcp),
			Arc::new(ProductionConnector::new(root.clone())),
			Arc::from([Str::from(owner_info.root_uri.clone())]),
			local_root,
		);
		mcp.bind_manager(&mcp_manager);
		mcp_manager.bind_runtime_settings(con);
		let workspace_trust = bridges.content.workspace_trust;
		let mcp_settings = McpSettings::from_con(con, workspace_trust);
		// Native config mounting requires the bound manager: reload resolves
		// through the live transport supervisor.
		mcp.start_native_configs(mcp_settings.project_config)
			.await
			.map_err(EnvdError::state)?;

		register_extension_convars(con, &ext_host_config.extensions)?;
		let schedules = DurableScheduleActor::spawn(state_dir)?;
		let control_bindings = production_control_authorities(
			state_dir,
			&session_id,
			&telemetry,
			&mcp,
			&ext_host_config.extensions,
			ext_host_config.domain_control_factories(),
			Arc::clone(&convars),
			ext_host_config.quota_runtime(),
			crate::extension_tool_call_timeout(con),
			Arc::clone(&scheme_generation),
		);
		mcp_manager.bind_notification_sink(control_bindings.hooks.clone());
		ext_host_config.bind_control_authorities(Arc::clone(&control_bindings.factory));
		ext_host_config.bind_registry_control(Arc::clone(&control_bindings.registry));
		ext_host_config.bind_hook_control(Arc::clone(&control_bindings.hooks));
		let ext_hosts = Arc::new(ExtHostSupervisor::spawn(ext_host_config).await?);
		control_bindings
			.callbacks
			.bind(Arc::new(WeakExtensionCallbackDispatcher {
				supervisor: Arc::downgrade(&ext_hosts),
			}));
		scheme_generation.bind_callbacks(Arc::clone(&control_bindings.callbacks)
			as Arc<dyn crate::exthost::dispatch::CallbackDispatcher>);

		let sites = SiteMaterializer::open(state_dir.join("ext"), blobs.store().clone())
			.map_err(EnvdError::blob)?;
		let materializations = ResourceMaterializer::open(
			&root,
			state_dir,
			&crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id),
		)?;
		let (mut host_settings, shell_settings, sandbox_settings) = execution_settings(con);
		#[cfg(feature = "cap-browser")]
		let browser_settings = BrowserSettings::from_con(con);
		let enforced = crate::daemon_policy::of(
			&sandbox_settings,
			&host_settings.tools,
			&shell_settings,
			workspace_trust,
		);
		host_settings.tools = host_settings
			.tools
			.with_workspace_trust(workspace_trust)
			.with_approval_mode_override(approval_mode);
		let memory_runtime =
			start_memory_runtime(&host_settings, state_dir, &root, &session_id).await?;

		let RegistryBridges {
			command_credentials: _,
			dynamic_tools,
			dynamic_tool_factories,
			url_resolvers: _,
			goal_control,
			search,
			edit_model: _,
			edit_repair: _,
			host_resources: _,
			session_authority: _,
			telemetry_upload,
			ask_presenter,
			content,
			selected_roster,
		} = bridges;
		let declarations = build_environment_declaration_inputs(
			state_dir,
			&root,
			con,
			ext_hosts.as_ref(),
			&host_settings.tools,
			&shell_settings,
			&host_settings.memory,
			&host_settings.autolearn,
			&content,
			omp_tool::ToolsPolicy::Auto,
		)?;
		let session = session_registry(
			registry,
			&blobs,
			&root,
			state_dir,
			&telemetry,
			Arc::clone(&forge_cache),
			#[cfg(feature = "cap-forge")]
			control_bindings.forge_devices.clone(),
			#[cfg(feature = "cap-ci")]
			control_bindings.ci_devices.clone(),
			ext_hosts.as_ref(),
			py_eval,
			con,
			omp_tool::ToolsPolicy::Auto,
			&host_settings.tools,
			#[cfg(feature = "cap-browser")]
			&browser_settings,
			&declarations,
			SessionRegistryBridges {
				dynamic_tools,
				dynamic_tool_factories,
				goal_control,
				search,
				telemetry_upload,
				ask_presenter,
				selected_roster,
			},
		)?;
		session
			.checkpoint_control
			.bind_owner_workspace(owner.clone());

		let resources = Arc::new(ResolverTable::default());
		control_bindings
			.resources
			.set(Arc::clone(&resources))
			.map_err(|_| EnvdError::State(sf!("CONTROL URL resolver owner was already bound")))?;
		ext_hosts.activate_control_hosts().await?;
		let identity = ServerIdentity {
			workspace_id: owner_info.workspace_id,
			root_uri: Str::from(owner_info.root_uri),
			server_epoch: owner_info.server_epoch,
			server_version: Str::from(env!("CARGO_PKG_VERSION")),
			server_build: Str::from(owner_info.server_build),
			policy: enforced,
			workspace_trust,
		};
		let usage_fetchers = control_bindings.hooks.usage_fetchers();
		let provider_response_hooks =
			omp_ai::ProviderResponseHooks::new(control_bindings.hooks.clone());
		let admission_gate = control_bindings.hooks.admission_gate();
		Ok(Self::new(
			identity,
			None,
			host_settings.tools.clone(),
			exec,
			workspace,
			mcp,
			mcp_manager,
			resources,
			memory_runtime,
			blobs,
			sites,
			materializations,
			session.registry,
			session.ask_presenter,
			ext_hosts,
			Arc::new(SessionBridgeHost::new()),
			Arc::new(ReflectionBridgeHost::new()),
			EvalSessionControl::default(),
			session.search_bridge,
			session.github_credentials,
			usage_fetchers,
			provider_response_hooks,
			admission_gate,
			session.checkpoint_control,
			StagedProposalRegistry::new(),
			schedules,
			authority,
			state_dir,
			#[cfg(feature = "cap-forge")]
			control_bindings.forge_devices,
			#[cfg(feature = "cap-ci")]
			control_bindings.ci_devices,
		))
	}

	/// Connects raw frame channels to an owner-only environment socket.
	#[cfg(unix)]
	pub async fn connect_owner_uds_frames(
		path: &Path,
	) -> Result<(FramePipe, JoinHandle<Result<(), EnvdError>>), EnvdError> {
		use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};

		let metadata = tokio::fs::symlink_metadata(path).await?;
		if !metadata.file_type().is_socket()
			|| metadata.uid() != nix::unistd::geteuid().as_raw()
			|| metadata.permissions().mode() & 0o077 != 0
		{
			return Err(
				io::Error::new(
					io::ErrorKind::PermissionDenied,
					"environment socket must be owner-only and owned by the current user",
				)
				.into(),
			);
		}
		let stream = UnixStream::connect(path).await?;
		let (outgoing, requests) = flume::bounded(64);
		let (responses, incoming) = flume::bounded(64);
		let task = tokio::spawn(async move {
			let (mut reader, mut writer) = stream.into_split();
			let shutdown = CancellationToken::new();
			let read_shutdown = shutdown.clone();
			let read = async move {
				let mut scratch = BytesMut::new();
				loop {
					let frame = tokio::select! {
						() = read_shutdown.cancelled() => return Ok::<(), io::Error>(()),
						result = read_server_frame(&mut reader, &mut scratch) => result?,
					};
					let Some(frame) = frame else { return Ok(()) };
					if responses.send_async(frame).await.is_err() {
						return Ok(());
					}
				}
			};
			let write = async move {
				let result = async {
					let mut scratch = BytesMut::new();
					while let Ok(frame) = requests.recv_async().await {
						write_client_frame(&mut writer, &frame, &mut scratch).await?;
					}
					Ok::<(), io::Error>(())
				}
				.await;
				shutdown.cancel();
				result
			};
			let (read_result, write_result) = tokio::join!(read, write);
			read_result?;
			write_result?;
			Ok(())
		});
		Ok((FramePipe::new(outgoing, incoming), task))
	}

	/// Connects an `EnvClient` transport to an owner-only environment socket.
	#[cfg(unix)]
	pub async fn connect_owner_uds(
		path: &Path,
	) -> Result<(EnvClient, JoinHandle<Result<(), EnvdError>>), EnvdError> {
		let (frames, task) = Self::connect_owner_uds_frames(path).await?;
		let (outgoing, incoming) = frames.into_parts();
		Ok((EnvClient::from_channels(outgoing, incoming), task))
	}

	/// Enforces persisted RECORD ownership before a trusted extension imports a
	/// module from its materialized site tree.
	pub(crate) fn require_record_owner(
		&self,
		site_key: &str,
		module: impl Into<Str>,
		owner: impl Into<Str>,
	) -> Result<(), SiteError> {
		self.sites.require_record_owner(site_key, module, owner)
	}

	/// Returns the exact registry shared by this server's dispatch paths.
	pub fn registry(&self) -> Arc<Registry> {
		Arc::clone(&self.registry)
	}

	/// Returns the namer of the hosts this server's native tools fetch from,
	/// by the resolvers that perform those fetches. A composition that runs
	/// these tools in its own process, outside this server's admission gate,
	/// keys their fetch approval on it.
	#[must_use]
	pub fn fetch_hosts(&self) -> FetchHostNamer {
		FetchHostNamer::new(&self.resources)
	}

	/// Binds the production router for one authenticated extension-host
	/// connection.
	pub fn extension_control_authority(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		self.ext_hosts.control_authority(identity)
	}

	/// Returns the generation-fenced callback transport shared by provider,
	/// presentation, and job backends.
	pub fn extension_callback_dispatcher(&self) -> Arc<dyn CallbackDispatcher> {
		Arc::new(WeakExtensionCallbackDispatcher { supervisor: Arc::downgrade(&self.ext_hosts) })
	}

	/// Returns the eager prompt-contribution provider over live worker actors.
	pub fn extension_prompt_provider(&self) -> Arc<dyn crate::exthost::PromptContributionProvider> {
		let provider: Arc<dyn crate::exthost::PromptContributionProvider> = self.ext_hosts.clone();
		provider
	}

	/// Drains idle extension hosts and starts their hot-reload generations.
	pub async fn reload_extensions(&self) -> Result<Vec<u64>, ExtHostError> {
		self.ext_hosts.reload().await
	}

	/// Respawns only the child owning one linked extension.
	pub async fn reload_extension(&self, extension: &str) -> Result<u64, ExtHostError> {
		self.ext_hosts.reload_extension(extension).await
	}

	/// Stops host groups containing newly revoked extensions while retaining
	/// their static unavailable routes.
	pub async fn quarantine_extensions(&self, extensions: &[Str]) {
		self.ext_hosts.quarantine(extensions).await;
	}

	/// Returns the shared extension and built-in provider usage registry.
	pub fn usage_fetchers(&self) -> omp_ai::operation::usage::UsageFetcherRegistry {
		self.usage_fetchers.clone()
	}

	/// Returns the session-owned provider response hook sink.
	pub fn provider_response_hooks(&self) -> omp_ai::ProviderResponseHooks {
		self.provider_response_hooks.clone()
	}

	/// Returns the live per-session admission hook gate.
	pub fn admission_gate(&self) -> Arc<HookGate> {
		Arc::clone(&self.admission_gate)
	}

	/// Returns the sealed deployment manifest for an exact live CONTROL
	/// connection generation.
	pub fn extension_control_manifest(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<ExtensionManifest> {
		self.ext_hosts.control_manifest(identity)
	}

	/// Returns the full frozen runtime provider declaration projection
	/// for an exact authenticated connection generation.
	pub fn extension_registry_evidence(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<Arc<SealedRegistryEvidence>> {
		self.ext_hosts.sealed_registry_evidence(identity)
	}

	/// Registers frozen Python Directors and Components with an engine
	/// registrar.
	pub fn register_python_extensions(
		&self,
		registrar: &mut omp_contract::ExtensionRegistrar,
	) -> Result<Vec<crate::exthost::PyComponent>, crate::exthost::PyExtensionError> {
		self.ext_hosts.register_python_extensions(registrar)
	}

	/// Returns every currently sealed exact-generation extension registry.
	pub fn extension_registry_evidences(&self) -> Vec<Arc<SealedRegistryEvidence>> {
		self.ext_hosts.sealed_registry_evidences()
	}

	/// Returns every authenticated extension CONTROL identity.
	pub fn extension_control_identities(&self) -> Vec<Arc<ControlConnectionIdentity>> {
		self.ext_hosts.control_identities()
	}

	/// Returns the session-owned MCP manager for late bridge injection.
	pub(crate) const fn mcp_manager(&self) -> &Arc<McpManager> {
		&self.mcp_manager
	}

	/// Returns the session-owned native MCP configuration authority.
	pub(crate) const fn mcp(&self) -> &Arc<McpService> {
		&self.mcp
	}

	/// Constructs one generation-fenced MCP CONTROL resolver for a host
	/// connection.
	pub(crate) fn mcp_control(
		&self,
		identity: Arc<ControlConnectionIdentity>,
		cancellation: CancellationToken,
	) -> Option<McpControl> {
		self.mcp.control(identity, cancellation)
	}

	/// Replaces the ask presenter for this environment composition.
	pub(crate) fn bind_ask_presenter(&self, presenter: Arc<dyn omp_tools::ask::AskPresenter>) {
		self.ask_presenter.bind(presenter);
	}

	pub(in crate::server) fn environment_authorities(&self) -> Option<&EnvironmentAuthorities> {
		self.environment.as_ref()
	}

	/// Returns the project document authority shared by standalone commands.
	///
	/// Session-only hosts intentionally do not expose this authority; this
	/// compatibility accessor remains until document clients are protocol-only.
	pub(crate) fn documents(&self) -> &DocumentHost {
		&self
			.environment
			.as_ref()
			.expect("session-only environment host has no document authority")
			.documents
	}

	/// Gracefully stops every nonpersistent process owned by this environment.
	///
	/// Durable detached generations remain owned by the process store and are
	/// intentionally spared by the executor's managed-shutdown policy.
	pub(crate) async fn shutdown_managed(&self, grace: Duration) {
		let _ = self.exec.shutdown_managed(grace).await;
		self.ext_hosts.shutdown().await;
	}

	/// Returns the session's sole Off/Mnemopi runtime.
	pub(crate) fn memory_runtime(&self) -> Arc<omp_memory::MemoryRuntime> {
		Arc::clone(self._memory_runtime.runtime())
	}

	/// Binds the editor this host's in-process native calls read buffers from.
	/// A session-only host owns no document authority and runs no document
	/// tools in-process, so it has nothing to bind.
	pub(crate) fn bind_in_process_editor(&self, editor: Option<Arc<dyn AcpDocumentBackend>>) {
		if let Some(environment) = &self.environment {
			environment.documents.bind_in_process_editor(editor);
		}
	}

	/// Binds the live durable approval authority used by Environment fallbacks.
	///
	/// Rebinding clears the network endpoints the previous route's session
	/// approved for the session.
	pub(crate) fn bind_approval_authority(
		&self,
		book: Option<Arc<ApprovalBook>>,
		route: Option<ApprovalRoute>,
	) {
		self.approvals.bind(book, route.clone());
		self.exec.bind_dynamic_approval_route(route.clone());
		self.exec.bind_sandbox_approval_route(route);
	}

	/// Drops the network endpoints the bound route's session approved for the
	/// session, because its conversation was rewound or switched to another
	/// session.
	pub(crate) fn revoke_approval_grants(&self) {
		self.exec.revoke_route_grants();
	}

	/// Returns the session bridge binding retained by this environment.
	pub(crate) fn eval_bridge(&self) -> Arc<SessionBridgeHost> {
		Arc::clone(&self.eval_bridge)
	}

	/// Binds one durable session principal to its live eval parent authority.
	pub fn bind_eval_sdk_parent(
		&self,
		owner: Str,
		parent: Arc<dyn ParentSessionHost>,
	) -> Result<ParentBindingLease, BridgeHostError> {
		self.eval_bridge.bind_sdk_parent(owner, parent)
	}

	/// Returns the late-bound memory reflection bridge.
	pub(crate) fn reflection_bridge(&self) -> Arc<ReflectionBridgeHost> {
		Arc::clone(&self.reflection_bridge)
	}

	pub(crate) fn eval_control(&self) -> EvalSessionControl {
		self.eval_control.clone()
	}

	/// Returns the late-bound canonical search bridge.
	pub(crate) fn search_bridge(&self) -> Arc<SearchBridgeHost> {
		Arc::clone(&self.search_bridge)
	}

	/// Returns the late-bound GitHub credential projection.
	pub(crate) fn github_credentials(&self) -> Arc<ForgeCredentialBridge> {
		Arc::clone(&self.github_credentials)
	}

	/// Canonical project root this server was opened for.
	pub(crate) fn project_root(&self) -> PathBuf {
		self.workspace.root().to_path_buf()
	}

	/// Project state directory (cache, blobs, sessions).
	pub(crate) fn state_dir(&self) -> &Path {
		&self.state_dir
	}

	/// Blob authority shared with the forge router.
	pub(crate) fn blob_host(&self) -> crate::blobs::BlobHost {
		self.blobs.clone()
	}

	/// Live forge device client bound to the mounted `forge/*` catalog.
	#[cfg(feature = "cap-forge")]
	pub(crate) fn forge_devices(&self) -> crate::forge_adapter::LiveForgeDeviceClient {
		self.forge_devices.clone()
	}

	/// Returns the session generation fencing CONTROL connections.
	pub(crate) fn session_generation(&self) -> u64 {
		self.ext_hosts.session_generation()
	}

	/// Atomically installs the chat-parent owner of `omp.agents.*`.
	pub(crate) fn bind_agents_control_authority(
		&self,
		factory: Arc<dyn ControlAuthorityFactory>,
	) -> AgentsControlAuthorityBinding {
		self.ext_hosts.bind_agents_control_authority(factory)
	}

	/// Atomically installs and generation-fences the driver/app CONTROL domain
	/// bundle. Dropping the returned lease revokes only this exact binding.
	pub fn bind_domain_control_factories(
		&self,
		mut factories: ExternalDomainControlFactories,
	) -> ExternalDomainControlBinding {
		factories.services = Some(self.ext_hosts.service_control_factory());
		self.ext_hosts.bind_domain_control_factories(factories)
	}

	/// Atomically installs Agents and all driver/app CONTROL owners under one
	/// replacement/revocation lease.
	pub fn bind_external_control_authorities(
		&self,
		agents: Arc<dyn ControlAuthorityFactory>,
		mut domains: ExternalDomainControlFactories,
	) -> ExternalControlAuthorityBinding {
		domains.services = Some(self.ext_hosts.service_control_factory());
		self
			.ext_hosts
			.bind_external_control_authorities(agents, domains)
	}

	/// Binds the active Agent Journal mailbox to checkpoint and staged-preview
	/// CONTROL until the returned lease is dropped.
	pub(crate) fn bind_agent_control(self: &Arc<Self>, sender: KernelSender) -> AgentControlBinding {
		let id = NEXT_AGENT_CONTROL_BINDING.fetch_add(1, Ordering::Relaxed);
		self.checkpoint_control.bind(id, sender.clone());
		let diagnostics = self.environment.as_ref().map(|environment| {
			let diagnostics = Arc::new(LateDiagnosticsBatcher {
				pending:   parking_lot::Mutex::new(Vec::new()),
				scheduled: AtomicBool::new(false),
				active:    AtomicBool::new(true),
				sender:    sender.clone(),
			});
			let sink = Arc::clone(&diagnostics);
			environment
				.documents
				.bind_late_diagnostics(id, Arc::new(move |batch| sink.push(batch)));
			diagnostics
		});
		self
			.previews
			.install_activation_observer(Arc::new(move |pending| {
				let sender = sender.clone();
				Box::pin(async move {
					sender
						.send(omp_contract::EnvEvent::StagedPreview {
							proposal_id: pending.id,
							source_tool: pending.source_tool,
						})
						.map_err(|_| omp_tools::staging::ProposalActivationError::Rejected)
				})
			}));
		AgentControlBinding { server: Arc::clone(self), id, diagnostics }
	}

	/// Installs the project-lifetime owner for durable scheduled Agent
	/// delivery. The backend is retained by envd independently of any chat UI.
	pub(crate) async fn bind_schedule_delivery(
		&self,
		backend: Arc<dyn ScheduleDeliveryBackend>,
	) -> Result<(), EnvdError> {
		self.schedules.bind_schedule_delivery(backend).await
	}

	pub(in crate::server) fn release_agent_control(&self, id: u64) {
		if let Some(environment) = &self.environment {
			environment.documents.unbind_late_diagnostics(id);
		}
		if self.checkpoint_control.unbind(id) {
			self.previews.remove_activation_observer();
		}
	}

	/// Binds extension device availability to the active Agent turn boundary.
	pub(crate) fn bind_device_availability(&self, mailbox: KernelSender) {
		self
			.ext_hosts
			.bind_availability_sink(Arc::new(RegistryAvailabilitySink::new(
				Arc::clone(&self.registry),
				mailbox,
			)));
	}

	/// Serves the server half returned by [`omp_env::EnvClient::in_process`].
	pub async fn serve_in_process(&self, transport: InProcessEnvTransport) {
		let (requests, responses) = transport.into_parts();
		self
			.serve_frames(requests, responses, ConnectionPolicy::in_process())
			.await;
	}

	/// Serves one already-accepted byte stream with varint protobuf framing.
	pub async fn serve_io<S>(&self, stream: S) -> Result<(), EnvdError>
	where
		S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
	{
		self
			.serve_io_with_policy(stream, ConnectionPolicy::external(None))
			.await
	}

	pub(crate) async fn serve_io_with_policy<S>(
		&self,
		stream: S,
		policy: ConnectionPolicy,
	) -> Result<(), EnvdError>
	where
		S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
	{
		let (mut reader, mut writer) = split(stream);
		let (request_tx, requests) = flume::bounded(64);
		let (responses, response_rx) = flume::bounded(64);
		let retire = policy.retire.clone();
		let dispatch = self.serve_frames(requests, responses, policy);
		let io_shutdown = CancellationToken::new();
		let read_shutdown = io_shutdown.clone();
		let read = async move {
			let mut scratch = BytesMut::new();
			loop {
				let frame = tokio::select! {
					() = read_shutdown.cancelled() => return Ok::<(), io::Error>(()),
					result = read_client_frame(&mut reader, &mut scratch) => result?,
				};
				let Some(frame) = frame else { return Ok(()) };
				if request_tx.send_async(frame).await.is_err() {
					return Ok(());
				}
			}
		};
		let write = async move {
			let result = async {
				let mut scratch = BytesMut::new();
				while let Ok(frame) = response_rx.recv_async().await {
					write_server_frame(&mut writer, &frame, &mut scratch).await?;
					if matches!(frame.body, Some(server_frame::Body::RetireStarted(_)))
						&& let Some(retire) = &retire
					{
						retire.cancel();
					}
				}
				Ok::<(), io::Error>(())
			}
			.await;
			io_shutdown.cancel();
			result
		};
		let (read_result, (), write_result) = tokio::join!(read, dispatch, write);
		read_result?;
		write_result?;
		Ok(())
	}

	/// Binds and serves an owner-only project Unix socket until cancellation.
	///
	/// Retirement unlinks the path immediately and drains accepted
	/// connections; external shutdown aborts them. A stale non-accepting
	/// socket file is replaced; a live listener yields
	/// [`io::ErrorKind::AddrInUse`].
	#[cfg(unix)]
	pub async fn serve_uds(
		self: Arc<Self>,
		path: &Path,
		shutdown: CancellationToken,
		connection_gauge: Option<watch::Sender<usize>>,
	) -> Result<(), EnvdError> {
		self
			.serve_uds_with_policy(path, shutdown, None, connection_gauge, None)
			.await
	}

	/// Binds a Unix socket whose connections are restricted to one extension
	/// host binding.
	#[cfg(unix)]
	pub async fn serve_extension_uds(
		self: Arc<Self>,
		mut binding: ExtensionDataBinding,
		shutdown: CancellationToken,
	) -> Result<(), EnvdError> {
		self
			.authority
			.register_host(binding.key.clone(), binding.grants.clone());
		let policy = binding.policy();
		let prepared = binding
			.prepared
			.take()
			.map(|PreparedEndpoint { listener, guard }| {
				UnixListener::from_std(listener).map(|listener| (listener, guard))
			})
			.transpose()?;
		let result = self
			.serve_uds_with_policy(&binding.path, shutdown, Some(policy), None, prepared)
			.await;
		if let Err(error) = &result {
			tracing::error!(
				path = %binding.path.display(),
				layer = %binding.key.layer(),
				tier = %binding.key.tier(),
				extension = %binding.key.extension(),
				%error,
				"extension DATA socket failed",
			);
		}
		result
	}

	#[cfg(unix)]
	#[tracing::instrument(
		name = "environment_bind",
		level = "debug",
		skip_all,
		fields(path = %path.display(), extension_scoped = connection_policy.is_some())
	)]
	pub(in crate::server) async fn serve_uds_with_policy(
		self: Arc<Self>,
		path: &Path,
		shutdown: CancellationToken,
		connection_policy: Option<ConnectionPolicy>,
		connection_gauge: Option<watch::Sender<usize>>,
		prepared: Option<(UnixListener, UnixSocketPathGuard)>,
	) -> Result<(), EnvdError> {
		use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};

		let parent = path.parent().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "environment socket has no parent")
		})?;
		ensure_directory(parent)?;
		let (listener, socket_metadata, _path_guard) = if let Some((listener, guard)) = prepared {
			// The guard has owned the published path since the endpoint was
			// prepared; the server only inherits it. A path that no longer names
			// that inode is someone else's and is never served or removed.
			let metadata = fs::symlink_metadata(path)?;
			if !metadata.file_type().is_socket() {
				return Err(
					io::Error::new(
						io::ErrorKind::InvalidData,
						"prepared environment path is not a socket",
					)
					.into(),
				);
			}
			if !guard.owns(&metadata) {
				return Err(
					io::Error::new(
						io::ErrorKind::AlreadyExists,
						"prepared environment socket was replaced",
					)
					.into(),
				);
			}
			(listener, metadata, guard)
		} else {
			match tokio::fs::symlink_metadata(path).await {
				Ok(metadata) if metadata.file_type().is_socket() => {
					if UnixStream::connect(path).await.is_ok() {
						return Err(
							io::Error::new(
								io::ErrorKind::AddrInUse,
								"environment socket is already accepting connections",
							)
							.into(),
						);
					}
					tokio::fs::remove_file(path).await?;
				},
				Ok(_) => {
					return Err(
						io::Error::new(
							io::ErrorKind::AlreadyExists,
							"refusing to replace a non-socket environment path",
						)
						.into(),
					);
				},
				Err(error) if error.kind() == io::ErrorKind::NotFound => {},
				Err(error) => return Err(error.into()),
			}
			// Bind under a staging name, restrict, then publish with an atomic
			// no-replace link. A competing daemon that wins the path race keeps
			// ownership; this listener never overwrites its reachable socket.
			let staging = path.with_extension(format!("staging-{}", process::id()));
			match tokio::fs::symlink_metadata(&staging).await {
				Ok(_) => tokio::fs::remove_file(&staging).await?,
				Err(error) if error.kind() == io::ErrorKind::NotFound => {},
				Err(error) => return Err(error.into()),
			}
			let listener = UnixListener::bind(&staging)?;
			let staging_metadata = fs::symlink_metadata(&staging)?;
			let staging_guard = UnixSocketPathGuard::new(staging.clone(), &staging_metadata);
			tokio::fs::set_permissions(&staging, fs::Permissions::from_mode(0o600)).await?;
			// Publish and take cleanup ownership with no await between them. A
			// cancellation (task abort, dropped serve future) at an await after
			// the link became reachable but before the guard existed leaked the
			// published socket. The link shares the staging inode, so a guard
			// keyed on the staging identity owns exactly the published path, and
			// still never removes a competing daemon's socket if the link fails.
			let path_guard = UnixSocketPathGuard::new(path.to_path_buf(), &staging_metadata);
			fs::hard_link(&staging, path)?;
			drop(staging_guard);
			let metadata = fs::symlink_metadata(path)?;
			(listener, metadata, path_guard)
		};
		let retire = CancellationToken::new();
		let mut listener = Some(listener);
		let mut connections = JoinSet::new();
		let mut abort_connections = false;
		if let Some(gauge) = &connection_gauge {
			gauge.send_replace(0);
		}
		if connection_policy.is_some() {
			tracing::debug!(path = %path.display(), "extension data socket listening");
		} else {
			tracing::info!(path = %path.display(), "environment daemon listening");
		}
		loop {
			if retire.is_cancelled() && listener.is_some() {
				drop(listener.take());
				if let Ok(metadata) = fs::symlink_metadata(path)
					&& metadata.dev() == socket_metadata.dev()
					&& metadata.ino() == socket_metadata.ino()
				{
					let _ = tokio::fs::remove_file(path).await;
				}
				if connections.is_empty() {
					break;
				}
			}
			tokio::select! {
				() = shutdown.cancelled() => {
					abort_connections = true;
					break;
				},
				() = retire.cancelled(), if listener.is_some() => {},
				accepted = async {
					listener.as_ref().expect("guarded listener").accept().await
				}, if listener.is_some() => {
					let (stream, _) = accepted?;
					let server = Arc::clone(&self);
					let policy = connection_policy.clone().unwrap_or_else(|| {
						ConnectionPolicy::external(Some(retire.clone()))
					});
					connections.spawn(async move {
						server.serve_io_with_policy(stream, policy).await
					});
					tracing::debug!(
						path = %path.display(),
						active_connections = connections.len(),
						extension_scoped = connection_policy.is_some(),
						"environment connection accepted",
					);
					if let Some(gauge) = &connection_gauge {
						gauge.send_replace(connections.len());
					}
				},
				completed = connections.join_next(), if !connections.is_empty() => {
					match completed {
						Some(Ok(Ok(()))) | None => {},
						Some(Ok(Err(error))) => {
							tracing::warn!(%error, "environment connection terminated with an error");
						},
						Some(Err(error)) => {
							tracing::error!(%error, "environment connection task failed");
						},
					}
					if let Some(gauge) = &connection_gauge {
						gauge.send_replace(connections.len());
					}
					if listener.is_none() && connections.is_empty() {
						break;
					}
				},
			}
		}
		if listener.take().is_some()
			&& let Ok(metadata) = fs::symlink_metadata(path)
			&& metadata.dev() == socket_metadata.dev()
			&& metadata.ino() == socket_metadata.ino()
		{
			let _ = tokio::fs::remove_file(path).await;
		}
		if abort_connections {
			connections.abort_all();
			while let Some(result) = connections.join_next().await {
				if let Err(error) = result
					&& !error.is_cancelled()
				{
					return Err(error.into());
				}
			}
		}
		Ok(())
	}

	pub(in crate::server) async fn serve_frames(
		&self,
		requests: Receiver<pb::ClientFrame>,
		responses: flume::Sender<pb::ServerFrame>,
		policy: ConnectionPolicy,
	) {
		let first = match time::timeout(HANDSHAKE_TIMEOUT, requests.recv_async()).await {
			Ok(Ok(first)) => first,
			Ok(Err(_)) => return,
			Err(_) => {
				send_error(
					&responses,
					0,
					pb::ProtocolErrorCode::DeadlineExceeded,
					"environment hello handshake timed out",
				)
				.await;
				return;
			},
		};
		let Some(hello) = self.accept_hello(first, &responses, &policy).await else {
			return;
		};
		let (finished_tx, finished) = flume::unbounded();
		let mut connection = ConnectionState::new(
			self.exec.clone(),
			hello,
			&self.tool_settings,
			Arc::clone(&self.authority),
			&policy,
		);
		// Only an environment host runs commands and `reflect`; a session-only
		// host refuses Exec and hosts no memory device, so a relay there would
		// never carry a query.
		if self.environment_authorities().is_some() {
			connection.bind_relays(&responses);
		}
		loop {
			let admission_deadline = connection.next_admission_deadline();
			let next = tokio::select! {
				result = requests.recv_async() => match result {
					Ok(frame) => Some(LoopEvent::Frame(Box::new(frame))),
					Err(_) => None,
				},
				result = finished.recv_async() => match result {
					Ok(done) => Some(LoopEvent::Finished(done)),
					Err(_) => None,
				},
				() = async {
					if let Some(deadline) = admission_deadline {
						time::sleep_until(deadline).await;
					} else {
						future::pending::<()>().await;
					}
				} => Some(LoopEvent::AdmissionDeadline),
			};
			let Some(next) = next else { break };
			match next {
				LoopEvent::Finished(done) => connection.finish(done),
				LoopEvent::AdmissionDeadline => {
					for (request_id, invocation_id, delivery, denied) in
						connection.take_expired_admissions()
					{
						connection.abandon_admission(request_id, &invocation_id);
						send_policy_denied_verdict(
							&responses,
							request_id,
							&invocation_id,
							&delivery,
							denied,
						)
						.await;
					}
				},
				LoopEvent::Frame(frame) => {
					while let Ok(done) = finished.try_recv() {
						connection.finish(done);
					}
					self
						.dispatch(*frame, &responses, &finished_tx, &mut connection, &policy)
						.await;
				},
			}
		}
		connection.cancel_all(&self.exec);
	}

	pub(in crate::server) async fn accept_hello(
		&self,
		frame: pb::ClientFrame,
		responses: &flume::Sender<pb::ServerFrame>,
		policy: &ConnectionPolicy,
	) -> Option<AcceptedHello> {
		let Some(client_frame::Body::Hello(hello)) = frame.body else {
			tracing::warn!(
				request_id = frame.request_id,
				"environment handshake rejected: first frame was not hello",
			);
			send_error(
				responses,
				frame.request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"the first client frame must be ClientHello",
			)
			.await;
			return None;
		};
		if frame.request_id != 0 {
			tracing::warn!(
				request_id = frame.request_id,
				"environment handshake rejected: hello used a nonzero request id",
			);
			send_error(
				responses,
				frame.request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"ClientHello must use request_id 0",
			)
			.await;
			return None;
		}
		if hello.schema_rev < MIN_SCHEMA_REV || hello.schema_rev > omp_proto::SCHEMA_REV {
			tracing::warn!(
				schema_rev = hello.schema_rev,
				min_schema_rev = MIN_SCHEMA_REV,
				max_schema_rev = omp_proto::SCHEMA_REV,
				"environment handshake rejected: unsupported schema revision",
			);
			send_error(
				responses,
				0,
				pb::ProtocolErrorCode::Unsupported,
				&format!(
					"unsupported env schema revision {}; server supports {MIN_SCHEMA_REV}..={}",
					hello.schema_rev,
					omp_proto::SCHEMA_REV
				),
			)
			.await;
			return None;
		}
		let approval_mode = match approval_mode_from_wire(hello.approval_mode) {
			Ok(approval_mode) => approval_mode,
			Err(approval_mode) => {
				tracing::warn!(
					approval_mode = approval_mode,
					"environment handshake rejected: unknown approval mode",
				);
				send_error(
					responses,
					0,
					pb::ProtocolErrorCode::InvalidArgument,
					"ClientHello approval_mode is unknown",
				)
				.await;
				return None;
			},
		};
		// Client features name what the client can answer, not DATA it may
		// reach; requesting only features keeps the connection's default grants.
		let data_capabilities = hello
			.capabilities
			.iter()
			.filter(|capability| !omp_env::CLIENT_FEATURES.contains(&capability.as_str()))
			.cloned()
			.collect::<Vec<_>>();
		let grants = if data_capabilities.is_empty() && policy.host.is_none() {
			policy.grants.clone()
		} else {
			policy.grants.requested(&data_capabilities)
		};
		tracing::debug!(
			schema_rev = hello.schema_rev,
			grants = grants.iter().len(),
			extension_authenticated = policy.host.is_some(),
			authenticated = true,
			"environment handshake accepted",
		);
		responses
			.send_async(server_frame(
				0,
				server_frame::Body::Hello(pb::ServerHello {
					schema_rev:      omp_proto::SCHEMA_REV,
					min_schema_rev:  MIN_SCHEMA_REV,
					capabilities:    grants.iter().map(str::to_owned).collect(),
					server_version:  self.identity.server_version.to_string(),
					workspace_id:    self.identity.workspace_id.clone(),
					root_uri:        self.identity.root_uri.to_string(),
					server_epoch:    self.identity.server_epoch.clone(),
					server_build:    self.identity.server_build.to_string(),
					policy_digest:   Bytes::copy_from_slice(self.identity.policy.digest().as_bytes()),
					// What this host's own probe found, which every admission on
					// the connection resolves against; equal policies do not
					// imply equal probes.
					sandbox_state:   self.exec.sandbox_state().to_wire().into(),
					workspace_trust: match self.identity.workspace_trust {
						WorkspaceTrust::Untrusted => pb::WorkspaceTrust::Untrusted,
						WorkspaceTrust::Trusted => pb::WorkspaceTrust::Trusted,
					}
					.into(),
					props:           Default::default(),
				}),
			))
			.await
			.ok()
			.map(|()| AcceptedHello {
				grants,
				capabilities: hello.capabilities.into_iter().map(Str::from).collect(),
				props: hello.props,
				approval_mode,
			})
	}

	pub(in crate::server) async fn check_workspace_updates(
		&self,
		request: pb::WorkspaceUpdateCheck,
	) -> pb::WorkspaceUpdateReport {
		use omp_ext::{
			Layer,
			config::UpdateMode,
			index::{IndexConfig, SignedIndex},
			lock::{InstalledRecord, LockFile},
			trust::RevocationsFile,
			upgrade::{
				Generation, PinsFile, resolve_candidate_generation, verify_candidate_generation,
			},
		};

		let checked_at_ms = request.now_ms;
		let mode = request.mode.parse::<UpdateMode>();
		if mode == Ok(UpdateMode::Off) {
			return pb::WorkspaceUpdateReport {
				checked: false,
				checked_at_ms,
				..pb::WorkspaceUpdateReport::default()
			};
		}
		if mode.is_err() {
			return workspace_update_failure(
				checked_at_ms,
				"update-policy",
				"workspace update mode is invalid",
			);
		}
		let workspace = self.workspace.root().join(".omp");
		let lock_path = workspace.join("omp.lock");
		if !lock_path.exists() {
			return pb::WorkspaceUpdateReport {
				checked: true,
				checked_at_ms,
				..pb::WorkspaceUpdateReport::default()
			};
		}
		let Some(data_dir) = omp_core::dirs::data_dir(None).ok() else {
			return workspace_update_failure(
				checked_at_ms,
				"storage",
				"client data directory is unavailable",
			);
		};
		let key = match fs::read_to_string(data_dir.join("ext/index.key")) {
			Ok(key) => key,
			Err(_) => {
				return workspace_update_failure(
					checked_at_ms,
					"index-key",
					"signed index key is unavailable",
				);
			},
		};
		let mut index_path = data_dir.join("ext/index.json");
		let mut revocations_path = data_dir.join("ext/revocations.json");
		if let Ok(config) = IndexConfig::read(&data_dir.join("ext/indexes.toml"))
			&& let Some(source) = config.entries.first()
		{
			let metadata_root = self.state_dir.join("ext/update-metadata");
			index_path = metadata_root.join("index.json");
			revocations_path = metadata_root.join("revocations.json");
			let Some((prefix, _)) = source.url.rsplit_once('/') else {
				return workspace_update_failure(
					checked_at_ms,
					"index-url",
					"signed index URL has no metadata directory",
				);
			};
			let revocation_bytes =
				match fetch_extension_metadata(&format!("{prefix}/revocations.json")).await {
					Ok(bytes) => bytes,
					Err(()) => {
						return workspace_update_failure(
							checked_at_ms,
							"network",
							"revocation metadata refresh failed",
						);
					},
				};
			let refreshed_revocations: RevocationsFile =
				match serde_json::from_slice(&revocation_bytes) {
					Ok(value) => value,
					Err(_) => {
						return workspace_update_failure(
							checked_at_ms,
							"revocations",
							"revocation metadata is malformed",
						);
					},
				};
			if let Err(error) = refreshed_revocations.verify(key.trim()) {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			}
			if write_extension_metadata(&revocations_path, &revocation_bytes).is_err() {
				return workspace_update_failure(
					checked_at_ms,
					"storage",
					"revocation metadata could not be persisted",
				);
			}
			let index_bytes = match fetch_extension_metadata(&source.url).await {
				Ok(bytes) => bytes,
				Err(()) => {
					return workspace_update_failure(
						checked_at_ms,
						"network",
						"signed index refresh failed",
					);
				},
			};
			let refreshed_index: SignedIndex = match serde_json::from_slice(&index_bytes) {
				Ok(value) => value,
				Err(_) => {
					return workspace_update_failure(
						checked_at_ms,
						"index",
						"signed index metadata is malformed",
					);
				},
			};
			if let Err(error) = refreshed_index.verify(key.trim()) {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			}
			if write_extension_metadata(&index_path, &index_bytes).is_err() {
				return workspace_update_failure(
					checked_at_ms,
					"storage",
					"signed index could not be persisted",
				);
			}
		}
		let index = match SignedIndex::read(&index_path, key.trim()) {
			Ok(index) => index,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let revocations = match RevocationsFile::read(&revocations_path).and_then(|value| {
			value.verify(key.trim())?;
			Ok(value)
		}) {
			Ok(revocations) => revocations,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let current = match LockFile::read(&lock_path, Layer::Workspace).and_then(|lock| {
			Ok(Generation {
				lock,
				installed: InstalledRecord::read(&workspace.join("installed.toml"))?,
			})
		}) {
			Ok(current) => current,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let target = current
			.lock
			.targets
			.first()
			.map_or("any", omp_core::Str::as_str);
		let candidate = match resolve_candidate_generation(&current, &index, target) {
			Ok(candidate) => candidate,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let pins = match PinsFile::read(&data_dir.join("ext/pins.toml")) {
			Ok(pins) => pins,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let now = jiff::Timestamp::now().to_string();
		let freshness = revocations.freshness(&now, false);
		let report = match verify_candidate_generation(
			&current,
			&candidate,
			&index,
			&pins,
			&revocations,
			freshness,
			target,
		) {
			Ok(report) => report,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		if !report.quarantined.is_empty() {
			let quarantine_root = self.state_dir.join("ext");
			let _ = fs::create_dir_all(&quarantine_root);
			let _ = fs::write(
				quarantine_root.join("quarantine.json"),
				serde_json::to_vec_pretty(&report).unwrap_or_default(),
			);
			self.ext_hosts.quarantine(&report.quarantined).await;
		}
		pb::WorkspaceUpdateReport {
			checked: true,
			items: report
				.items
				.into_iter()
				.map(|item| {
					let refusal = item.refusal.map(update_refusal_wire);
					pb::ExtensionUpdateItem {
						id:           item.diff.id.to_string(),
						from_version: item.diff.from_version.to_string(),
						to_version:   item.diff.to_version.to_string(),
						features:     item.diff.features.into_iter().map(String::from).collect(),
						diff:         Some(pb::ExtensionUpdateDiff {
							declaration_digest_from: item.diff.from_declaration_digest.to_string(),
							declaration_digest_to:   item.diff.to_declaration_digest.to_string(),
							capability_digest_from:  item.diff.from_capability_digest.to_string(),
							capability_digest_to:    item.diff.to_capability_digest.to_string(),
							manifest_digest_from:    item.diff.from_manifest_capability_digest.to_string(),
							manifest_digest_to:      item.diff.to_manifest_capability_digest.to_string(),
						}),
						refusal:      refusal.map(|value| value as i32),
					}
				})
				.collect(),
			quarantined: report
				.quarantined
				.into_iter()
				.map(|id| pb::ExtensionUpdateQuarantine {
					id:      id.to_string(),
					refusal: pb::ExtensionUpdateRefusal::Revoked as i32,
					detail:  "startup generation is newly revoked".to_owned(),
				})
				.collect(),
			failure: None,
			checked_at_ms,
		}
	}
}
