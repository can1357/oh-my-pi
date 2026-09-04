//! Application implementation of the chat host's [`Services`] seam: the
//! data feeds behind `/usage`, `/tools`, `/extensions`, `/login`, `/hub`,
//! `/plugins`, `/export`, … built once from the composed kernel and handed
//! to the actor as `HostOptions.services` (ADR 0005: the actor stays a
//! projection; engines stay in the app).

use std::{path::PathBuf, sync::Arc};

use omp_chat::{
	history::{HistoryEntry, HistoryStorage},
	overlays::services::{
		AccountRow, ActiveAccountUsage, ActiveUsageRequest, AgentRow, AgentView, CleanseRequest,
		CleanseRun, ExtensionRow, ForeignSessionRow, ForeignSessionSource, LoginFlow, MemoryOp,
		Mutation, Mutations, Pending, PluginsReport, ServiceError, ServiceResult, Services,
		SessionRow, SessionScope, SettingsChoice, SettingsInventory, SshHostRow, SshHostSpec,
		ToolRow, UsageReport,
	},
};
use omp_core::{Str, sf};
use omp_driver::registry::ProductionInference as ProductionStack;

mod accounts;
pub(crate) mod agents;
pub(crate) mod control;
mod debug;
/// Production `UiControlOwner`: extension `omp.ui.*` requests as chat dialogs.
pub mod extension_ui;
mod extensions;
mod mcp;
pub use mcp::mcp_config_paths;
mod misc;
pub use misc::secrets_files;
mod plugins;
mod session_ops;
pub(crate) mod sessions;
pub(crate) mod stats;
mod tools;
/// Kernel notification recorder behind `/trace`.
pub mod trace;
mod usage;
mod workspace;

/// Everything the feeds need, captured once at chat launch.
pub struct ServiceState {
	/// User data directory (`credentials.db`, caches).
	pub data_dir:      PathBuf,
	/// Canonical project root.
	pub project:       PathBuf,
	/// Project state directory (`sessions/`).
	pub state_dir:     PathBuf,
	/// Durable session directory.
	pub sessions_dir:  PathBuf,
	/// Journal path at launch.
	pub journal:       PathBuf,
	/// Current journal path: `/new`, `/resume`, and `/fork` swap sessions in
	/// process, and the controller writes the new path here on every switch.
	pub live_journal:  Arc<parking_lot::RwLock<PathBuf>>,
	/// Resolved launch model key (child kernels for `/btw`).
	pub model:         Str,
	/// Catalog snapshot; `None` behind a remote gateway.
	pub catalog:       Option<Arc<omp_catalog::snapshot::Catalog>>,
	/// Kernel tool registry.
	pub registry:      Arc<omp_tool::Registry>,
	/// Process console.
	pub con:           Arc<omp_con::Ctx>,
	/// Live-session routing index (`/hub` transcripts, agent steering).
	pub sessions:      Arc<omp_driver::sessions::SessionRegistry>,
	/// Collaboration relay/session owner.
	pub collab:        omp_driver::collab::session::CollabCommandHandle,
	/// Environment client (isolated workspaces for revived agents).
	pub env:           omp_env::EnvClient,
	/// MCP inspection authority.
	pub mcp:           omp_envd::McpInspectorHandle,
	/// Extension hot-reload authority.
	pub reload:        omp_envd::ExtensionReloadHandle,
	/// The session's memory runtime (`/memory`).
	pub memory:        Arc<omp_memory::MemoryRuntime>,
	/// Production auth + usage stack; `None` behind a remote gateway.
	pub stack:         Option<StackHandles>,
	/// Kernel notifications recorded since launch (`/trace`).
	pub trace:         Arc<trace::TraceLog>,
	/// Named palettes discovered at launch for settings choices and preview.
	pub theme_catalog: Arc<omp_tui::ThemeCatalog>,
	/// Runtime the asynchronous feeds spawn onto.
	pub runtime:       tokio::runtime::Handle,
}

/// Cloneable handles into the production authentication and usage stack.
#[derive(Clone)]
pub struct StackHandles {
	/// Authentication owner.
	pub auth:                 omp_ai::auth::AuthManager,
	/// Lifecycle CONTROL view of the same owner.
	pub auth_control:         omp_ai::auth::AuthControlHandle,
	/// Provider usage fetchers.
	pub usage:                omp_ai::operation::usage::UsageFetcherRegistry,
	/// Combined credential authority (GitHub gist uploads for `/share`).
	pub credential_authority: Arc<dyn omp_envd::github_url::CredentialAuthority>,
}

impl StackHandles {
	/// Clones the handles out of a composed production stack.
	#[must_use]
	pub fn from_stack(stack: &ProductionStack) -> Self {
		Self {
			auth:                 stack.auth_manager.clone(),
			auth_control:         stack.auth_control.clone(),
			usage:                stack.usage_fetchers.clone(),
			credential_authority: Arc::clone(&stack.credential_authority),
		}
	}
}

/// [`Services`] over the composed kernel.
pub struct AppServices {
	state:   Arc<ServiceState>,
	history: Option<HistoryStorage>,
}

impl AppServices {
	/// Wraps the captured state and points `<img src="artifact://sha256/…">`
	/// (tool-result image blobs in the transcript) at the project blob
	/// store.
	#[must_use]
	pub fn new(state: ServiceState) -> Self {
		let history = match HistoryStorage::open(state.data_dir.join("history.db")) {
			Ok(history) => Some(history),
			Err(error) => {
				tracing::warn!(%error, "prompt history unavailable");
				None
			},
		};
		let live_journal = Arc::clone(&state.live_journal);
		let root = live_journal.read().parent().map(PathBuf::from);
		if let Some(root) = root
			&& let Ok(blobs) = omp_journal::blob::BlobStore::open(&root)
		{
			let cache = parking_lot::Mutex::new((root, blobs));
			omp_tui::register_image_scheme(
				"artifact",
				Arc::new(move |source: &str| {
					let hex = source.strip_prefix("artifact://sha256/")?;
					let reference = omp_journal::blob::BlobRef::parse_hex(hex, 0).ok()?;
					let journal = live_journal.read();
					let root = journal.parent()?;
					let mut cache = cache.lock();
					if cache.0 != root {
						*cache = (root.to_path_buf(), omp_journal::blob::BlobStore::open(root).ok()?);
					}
					Some(cache.1.path(&reference))
				}),
			);
		}
		Self { state: Arc::new(state), history }
	}
}

impl Services for AppServices {
	fn settings_inventory(&self) -> ServiceResult<SettingsInventory> {
		let themes = self
			.state
			.theme_catalog
			.themes()
			.iter()
			.map(|loaded| SettingsChoice {
				value:       loaded.name.clone(),
				label:       loaded.name.clone(),
				description: loaded.theme.name.clone(),
			})
			.collect();
		let providers = self
			.state
			.catalog
			.as_ref()
			.map_or_else(Vec::new, |catalog| {
				catalog
					.providers()
					.iter()
					.map(|provider| Str::new(provider.id.as_str()))
					.collect()
			});
		let mut thinking_levels = vec![SettingsChoice {
			value:       Str::new_static("auto"),
			label:       Str::new_static("auto"),
			description: Str::new_static("Auto-detect per prompt"),
		}];
		if let Some(catalog) = self.state.catalog.as_ref() {
			let active_model = self
				.state
				.con
				.get("ai_model")
				.and_then(|value| {
					value
						.as_str()
						.filter(|value| !value.is_empty())
						.map(Str::new)
				})
				.unwrap_or_else(|| self.state.model.clone());
			let key = omp_catalog::ModelKey::from(active_model.as_str());
			if let Some(policy) = catalog
				.model(&key)
				.or_else(|| catalog.resolve_alias(active_model.as_str()))
				.and_then(|model| model.thinking.as_ref())
				.and_then(|id| catalog.thinking_policy(id))
			{
				thinking_levels.extend(policy.efforts.iter().map(|effort| {
					let metadata = effort.metadata();
					SettingsChoice {
						value:       Str::new_static(<&'static str>::from(*effort)),
						label:       Str::new_static(metadata.label),
						description: Str::new_static(metadata.description),
					}
				}));
			}
		}
		Ok(SettingsInventory { themes, thinking_levels, providers, ..SettingsInventory::default() })
	}

	fn theme(&self, name: &str) -> ServiceResult<Option<Arc<omp_tui::JsonTheme>>> {
		Ok(self.state.theme_catalog.get(name))
	}

	fn usage(&self) -> ServiceResult<Pending<UsageReport>> {
		usage::fetch(&self.state)
	}

	fn active_account_usage(
		&self,
		request: ActiveUsageRequest,
	) -> ServiceResult<Pending<Option<ActiveAccountUsage>>> {
		usage::active_account(&self.state, request)
	}

	fn reset_accounts(
		&self,
	) -> ServiceResult<Pending<Vec<omp_chat::overlays::services::ResetAccountRow>>> {
		usage::reset_accounts(&self.state)
	}

	fn tools(&self) -> ServiceResult<Vec<ToolRow>> {
		tools::roster(&self.state)
	}

	fn extensions(&self) -> ServiceResult<Vec<ExtensionRow>> {
		extensions::rows(&self.state)
	}

	fn accounts(&self) -> ServiceResult<Vec<AccountRow>> {
		accounts::rows(&self.state)
	}

	fn providers(&self) -> ServiceResult<Vec<omp_chat::overlays::services::ProviderRow>> {
		accounts::providers(&self.state)
	}

	fn login(&self, provider: &str) -> ServiceResult<LoginFlow> {
		accounts::login(&self.state, provider)
	}

	fn live_session_id(&self) -> ServiceResult<Str> {
		accounts::live_session_id(&self.state)
	}

	fn history_recent(&self, limit: usize) -> ServiceResult<Vec<HistoryEntry>> {
		self
			.history
			.as_ref()
			.ok_or(ServiceError::Unavailable("prompt history"))?
			.recent(limit)
			.map_err(ServiceError::failed)
	}

	fn history_search(&self, query: &str, limit: usize) -> ServiceResult<Vec<HistoryEntry>> {
		self
			.history
			.as_ref()
			.ok_or(ServiceError::Unavailable("prompt history"))?
			.search(query, limit)
			.map_err(ServiceError::failed)
	}

	fn history_matching_session_ids(&self, query: &str, limit: usize) -> ServiceResult<Vec<Str>> {
		self
			.history
			.as_ref()
			.ok_or(ServiceError::Unavailable("prompt history"))?
			.matching_session_ids(query, limit)
			.map_err(ServiceError::failed)
	}

	fn history_add(&self, prompt: &str) -> ServiceResult<()> {
		let history = self
			.history
			.as_ref()
			.ok_or(ServiceError::Unavailable("prompt history"))?;
		let session_id = self
			.state
			.live_journal
			.read()
			.file_stem()
			.and_then(|stem| stem.to_str())
			.map(Str::new);
		history
			.add(prompt, Some(&self.state.project), session_id.as_deref())
			.map(|_| ())
			.map_err(ServiceError::failed)
	}

	fn collaboration(&self) -> ServiceResult<omp_chat::overlays::services::CollabState> {
		Ok(collab_state(&self.state.collab))
	}

	fn export(&self, dom: &omp_dom::Dom, path: Option<&std::path::Path>) -> ServiceResult<PathBuf> {
		misc::export(&self.state, dom, path)
	}

	fn sessions(&self, scope: SessionScope) -> ServiceResult<Vec<SessionRow>> {
		sessions::rows(&self.state, scope)
	}

	fn foreign_sessions(
		&self,
		source: ForeignSessionSource,
	) -> ServiceResult<Vec<ForeignSessionRow>> {
		sessions::foreign_rows(source)
	}

	fn agents(&self) -> ServiceResult<Vec<AgentRow>> {
		sessions::agents(&self.state)
	}

	fn plugins(&self) -> ServiceResult<PluginsReport> {
		plugins::report(&self.state)
	}

	fn add_marketplace(&self, source: &str) -> ServiceResult<Str> {
		plugins::add_marketplace(&self.state, source)
	}

	fn remove_marketplace(&self, name: &str) -> ServiceResult<Str> {
		plugins::remove_marketplace(&self.state, name)
	}

	fn update_marketplace(&self, name: Option<&str>) -> ServiceResult<Pending<Str>> {
		plugins::update_marketplace(&self.state, name)
	}

	fn upgrade_plugins(&self, spec: Option<&str>) -> ServiceResult<Pending<Str>> {
		plugins::upgrade(&self.state, spec)
	}

	fn memory(&self, op: MemoryOp) -> ServiceResult<Str> {
		misc::memory(&self.state, op)
	}

	fn changelog(&self) -> ServiceResult<Str> {
		misc::changelog()
	}

	fn ssh_hosts(&self) -> ServiceResult<Vec<SshHostRow>> {
		misc::ssh_hosts(&self.state)
	}

	fn ssh_add(&self, spec: &SshHostSpec) -> ServiceResult<Str> {
		misc::ssh_add(&self.state, spec)
	}

	fn ssh_remove(&self, alias: &str, project: bool) -> ServiceResult<Str> {
		misc::ssh_remove(&self.state, alias, project)
	}

	fn share(&self, snapshot: serde_json::Value) -> ServiceResult<Pending<Str>> {
		misc::share(&self.state, snapshot)
	}

	fn cleanse(&self, request: CleanseRequest) -> ServiceResult<CleanseRun> {
		misc::cleanse(&self.state, request)
	}

	fn read_local(&self, url: &str) -> ServiceResult<Str> {
		session_ops::read_local(&self.state, url)
	}

	fn list_local(&self, suffix: &str) -> ServiceResult<Vec<Str>> {
		session_ops::list_local(&self.state, suffix)
	}

	fn write_local(&self, name: &str, content: &str) -> ServiceResult<Str> {
		session_ops::write_local(&self.state, name, content)
	}

	fn agent_view(&self, id: &str) -> ServiceResult<Pending<AgentView>> {
		agents::view(&self.state, id)
	}

	fn journal_tree(&self) -> ServiceResult<Vec<omp_chat::overlays::services::TreeEntry>> {
		session_ops::journal_tree(&self.state)
	}

	fn btw(
		&self,
		question: &str,
		context: &str,
	) -> ServiceResult<flume::Receiver<omp_chat::overlays::services::SideEvent>> {
		session_ops::btw(&self.state, question, context)
	}

	fn project_dir(&self) -> ServiceResult<PathBuf> {
		workspace::project_dir(&self.state)
	}

	fn create_worktree(
		&self,
		branch: &str,
	) -> ServiceResult<omp_chat::overlays::services::WorktreeInfo> {
		workspace::create_worktree(&self.state, branch)
	}

	fn dump_request(&self, dom: &omp_dom::Dom) -> ServiceResult<PathBuf> {
		control::dump_request(&self.state, dom)
	}

	fn request_restart(&self) -> ServiceResult<()> {
		control::request_restart();
		Ok(())
	}

	fn mcp(
		&self,
		op: omp_chat::overlays::services::McpOp,
	) -> ServiceResult<omp_chat::overlays::services::McpRun> {
		mcp::run(&self.state, op)
	}

	fn stats(&self) -> ServiceResult<Pending<omp_chat::overlays::services::StatsReport>> {
		stats::fetch(&self.state)
	}

	fn trace_events(&self) -> ServiceResult<Vec<omp_chat::overlays::services::TraceEvent>> {
		Ok(self.state.trace.events())
	}

	fn debug(
		&self,
		request: omp_chat::overlays::services::DebugRequest,
	) -> ServiceResult<omp_chat::overlays::services::DebugOutput> {
		debug::run(&self.state, request)
	}

	fn dump_raw_sse(&self) -> ServiceResult<PathBuf> {
		debug::dump_raw_sse(&self.state)
	}
}

impl Mutations for AppServices {
	fn apply(&self, mutation: Mutation) -> ServiceResult<Pending<Str>> {
		match mutation {
			Mutation::SetExtensionEnabled { id, enabled } => Ok(ready(
				extensions::set_enabled(&self.state, &id, enabled)
					.map(|()| sf!("Extension {}", if enabled { "enabled" } else { "disabled" })),
			)),
			Mutation::ReloadExtensions => extensions::reload(&self.state),
			Mutation::SetAgentEnabled { name, enabled } => Ok(ready(
				sessions::set_agent_enabled(&self.state, &name, enabled)
					.map(|()| sf!("Agent {name} {}", if enabled { "enabled" } else { "disabled" })),
			)),
			Mutation::SetPluginEnabled { id, enabled } => Ok(ready(
				plugins::set_enabled(&self.state, &id, enabled)
					.map(|()| sf!("{} {id}", if enabled { "Enabled" } else { "Disabled" })),
			)),
			Mutation::InstallPlugin { id } => plugins::install(&self.state, &id),
			Mutation::UninstallPlugin { id } => plugins::uninstall(&self.state, &id),
			Mutation::Logout { account } => self.logout(account),
			Mutation::PinAccount { account, pinned } => {
				Ok(ready(accounts::pin(&self.state, &account, pinned)))
			},
			Mutation::PinSession { id, pinned } => {
				Ok(ready(sessions::pin(&self.state, &id, pinned).map(|()| {
					Str::new_static(if pinned {
						"Session pinned to the top of the resume list."
					} else {
						"Session unpinned."
					})
				})))
			},
			Mutation::RenameSession { id, title } => Ok(ready(
				session_ops::rename(&self.state, &id, &title)
					.map(|()| sf!("Session renamed to \"{title}\".")),
			)),
			Mutation::DeleteSession { id } => Ok(ready(
				session_ops::delete(&self.state, &id).map(|()| Str::new_static("Session deleted")),
			)),
			Mutation::ResetUsage { target } => Ok(ready(usage::reset(&self.state, &target))),
		}
	}
}

impl AppServices {
	fn logout(&self, account: AccountRow) -> ServiceResult<Pending<Str>> {
		let label = account.label.clone();
		let pending = accounts::logout(&self.state, &account)?;
		let (tx, rx) = flume::bounded(1);
		self.state.runtime.spawn(async move {
			let result = match pending.recv_async().await {
				Ok(Ok(())) => Ok(sf!("Logged out {label}")),
				Ok(Err(error)) => Err(error),
				Err(_) => Err(ServiceError::Unavailable("logout result")),
			};
			let _ = tx.send(result);
		});
		Ok(rx)
	}
}

fn collab_state(
	handle: &omp_driver::collab::session::CollabCommandHandle,
) -> omp_chat::overlays::services::CollabState {
	use omp_chat::overlays::services::{CollabParticipant, CollabRole, CollabState};
	let Some(presence) = handle.presence() else {
		return CollabState {
			role:         None,
			connection:   Str::new_static("disconnected"),
			editor_link:  None,
			viewer_link:  None,
			participants: Vec::new(),
			line:         Str::new_static("Collaboration is not active."),
		};
	};
	let role = match presence.role() {
		omp_collab::presence::CollabRole::Host => CollabRole::Host,
		omp_collab::presence::CollabRole::Guest => CollabRole::Guest,
	};
	let connection: &'static str = match presence.connection() {
		omp_collab::presence::ConnectionState::Connecting => "connecting",
		omp_collab::presence::ConnectionState::Connected => "connected",
		omp_collab::presence::ConnectionState::Reconnecting => "reconnecting",
		omp_collab::presence::ConnectionState::Disconnected => "disconnected",
	};
	let participants = (0..presence.participant_count())
		.map(|index| CollabParticipant {
			id:        u32::try_from(index).unwrap_or(u32::MAX),
			name:      if index == 0 {
				Str::new_static("Host")
			} else {
				Str::new(format!("Participant {index}"))
			},
			host:      index == 0,
			read_only: index > 0 && presence.read_only(),
		})
		.collect();
	CollabState {
		role: Some(role),
		connection: Str::new_static(connection),
		editor_link: None,
		viewer_link: None,
		participants,
		line: Str::new(format!(
			"Collaboration {connection}: {} participant(s).",
			presence.participant_count()
		)),
	}
}

fn ready(result: ServiceResult<Str>) -> Pending<Str> {
	let (tx, rx) = flume::bounded(1);
	let _ = tx.send(result);
	rx
}
