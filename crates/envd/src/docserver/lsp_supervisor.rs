//! Workspace-scoped native language-server management.
//!
//! Manages the LSP lifecycle: bundled/user/project declarations are discovered
//! once per authority, filtered to servers whose root markers match the
//! project and whose binary resolves, then started lazily on the first
//! matching document open (or eagerly at serve start when lazy mode is off).
//! Every stage transition is published on the registry event bus so clients
//! can render live server status.

use std::{
	collections::BTreeMap,
	env,
	ffi::OsStr,
	path::{Path, PathBuf},
	process,
	sync::Arc,
	time::Duration,
};

use omp_core::{Hash32, Str};
use parking_lot::Mutex;
use tokio::{sync::watch, time::timeout};
use tokio_util::sync::CancellationToken;

use crate::docserver::{
	Environment,
	environment::WeakEnvironment,
	lsp_binary::{BinaryPlatform, resolve_lsp_binary},
	lsp_config::{LspConfigError, ResolvedLspServer, discover_native_lsp_sources, load_lsp_config},
	lsp_pool::{LspPool, LspPoolKey},
	lsp_process::{LspProcess, LspProcessError},
	lsp_registry::{LspStartupStage, root_marker_ancestor},
};

/// Upper bound on one roster quiescence wait; individual starts are already
/// bounded by their initialize and readiness timeouts.
const WAIT_IDLE_BOUND: Duration = Duration::from_secs(120);

/// Native language-server management options supplied by the embedding host.
#[derive(Clone, Debug)]
pub struct NativeLspOptions {
	/// Whether native language servers are managed at all.
	pub enabled: bool,
	/// Defers server startup until the first matching document open.
	pub lazy:    bool,
}

impl Default for NativeLspOptions {
	fn default() -> Self {
		Self { enabled: true, lazy: true }
	}
}

/// Lifecycle stage of one discovered server declaration.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum LspServerState {
	/// Matched the workspace and resolves to a runnable binary; not started.
	Available,
	/// Spawn and initialize are in flight.
	Starting,
	/// Initialized and installed; workspace readiness polling is in flight.
	Indexing,
	/// Serving requests.
	Ready,
	/// Spawn or initialize failed.
	Failed,
}

/// One roster row surfaced to status queries.
#[derive(Clone, Debug)]
pub struct LspServerStatusView {
	/// Declaration name.
	pub name:       Str,
	/// Current lifecycle stage.
	pub state:      LspServerState,
	/// Accepted extensions or exact filenames.
	pub file_types: Vec<Str>,
	/// Failure detail populated when `state` is [`LspServerState::Failed`].
	pub detail:     Option<Str>,
	/// Winning configuration source kind.
	pub source:     &'static str,
}

struct ServerSlot {
	config: ResolvedLspServer,
	state:  LspServerState,
	detail: Option<Str>,
	source: &'static str,
}

struct SupervisorInner {
	environment: WeakEnvironment,
	root:        PathBuf,
	user_root:   Option<PathBuf>,
	roster:      Mutex<BTreeMap<Str, ServerSlot>>,
	pool:        LspPool<LspProcess, LspProcessError>,
	pending:     watch::Sender<usize>,
	cancel:      CancellationToken,
}

/// Discovers, starts, and tracks native language servers for one project
/// authority.
#[derive(Clone)]
pub struct NativeLspSupervisor {
	inner: Arc<SupervisorInner>,
}

impl NativeLspSupervisor {
	/// Discovers the workspace roster: bundled, user, and project declarations
	/// filtered to enabled non-linter servers whose root markers match the
	/// project root and whose binary resolves.
	///
	/// # Errors
	/// Returns configuration read, parse, or validation failures.
	pub fn discover(
		environment: &Environment,
		user_config_root: Option<&Path>,
	) -> Result<Self, LspConfigError> {
		let root = environment
			.root_uri()
			.to_file_path()
			.unwrap_or_else(|()| PathBuf::from("/"));
		let roster = discover_roster(&root, user_config_root)?;
		tracing::info!(server_count = roster.len(), "LSP roster discovered");
		let (pending, _) = watch::channel(0_usize);
		Ok(Self {
			inner: Arc::new(SupervisorInner {
				environment: environment.downgrade(),
				root,
				user_root: user_config_root.map(Path::to_path_buf),
				roster: Mutex::new(roster),
				pool: LspPool::default(),
				pending,
				cancel: CancellationToken::new(),
			}),
		})
	}

	/// Returns the roster snapshot in stable name order.
	pub fn status(&self) -> Vec<LspServerStatusView> {
		self
			.inner
			.roster
			.lock()
			.iter()
			.map(|(name, slot)| LspServerStatusView {
				name:       name.clone(),
				state:      slot.state,
				file_types: slot.config.file_types.value.clone(),
				detail:     slot.detail.clone(),
				source:     slot.source,
			})
			.collect()
	}

	/// Re-runs configuration discovery, admitting new or changed declarations.
	///
	/// Every prior declaration is evicted and shut down, including unchanged
	/// ones: `reload` is an explicit restart boundary, not only a config-cache
	/// refresh. Fresh declarations return to `Available` for eager or lazy
	/// startup chosen by the caller.
	///
	/// # Errors
	/// Returns configuration read, parse, or validation failures.
	#[tracing::instrument(name = "lsp_roster_reload", level = "debug", skip_all)]
	pub fn reload(&self) -> Result<(), LspConfigError> {
		let fresh = discover_roster(&self.inner.root, self.inner.user_root.as_deref())?;
		let mut roster = self.inner.roster.lock();
		let mut previous = std::mem::take(&mut *roster);
		let mut next = BTreeMap::new();
		let mut superseded = Vec::new();
		for (name, slot) in fresh {
			if let Some(existing) = previous.remove(&name) {
				superseded.push(pool_key(&name, &existing.config, &self.inner.root));
			}
			next.insert(name, slot);
		}
		for (name, slot) in previous {
			superseded.push(pool_key(&name, &slot.config, &self.inner.root));
		}
		let server_count = next.len();
		*roster = next;
		drop(roster);
		for key in superseded {
			if let Some(process) = self.inner.pool.evict(&key)
				&& let Ok(process) = Arc::try_unwrap(process)
			{
				tokio::spawn(async move {
					if let Err(error) = process.shutdown().await {
						tracing::warn!(server = %key.server, %error, "superseded LSP shutdown failed");
					}
				});
			}
		}
		tracing::info!(server_count, "LSP roster reloaded");
		Ok(())
	}

	/// Starts every available server whose file types match `path`.
	///
	/// Matching servers are marked `Starting` synchronously so a subsequent
	/// [`Self::wait_idle`] observes the pending starts; the spawn itself runs
	/// in the background and never delays the caller.
	pub fn notify_open(&self, path: &Path) {
		let matched: Vec<Str> = {
			let roster = self.inner.roster.lock();
			roster
				.iter()
				.filter(|(_, slot)| {
					slot.state == LspServerState::Available
						&& matches_path(&slot.config.file_types.value, path)
				})
				.map(|(name, _)| name.clone())
				.collect()
		};
		for name in matched {
			self.begin_start(name);
		}
	}

	/// Starts every available server in the roster; used by eager warmup.
	pub fn warm_all(&self) {
		let matched: Vec<Str> = {
			let roster = self.inner.roster.lock();
			roster
				.iter()
				.filter(|(_, slot)| slot.state == LspServerState::Available)
				.map(|(name, _)| name.clone())
				.collect()
		};
		for name in matched {
			self.begin_start(name);
		}
	}

	/// Waits until no server start is in flight, bounded by cancellation and a
	/// safety timeout. Individual starts are bounded by their own initialize
	/// and readiness timeouts.
	pub async fn wait_idle(&self, cancel: &CancellationToken) {
		let mut pending = self.inner.pending.subscribe();
		let quiesced = async {
			while *pending.borrow_and_update() != 0 {
				if pending.changed().await.is_err() {
					return;
				}
			}
		};
		tokio::select! {
			result = timeout(WAIT_IDLE_BOUND, quiesced) => { let _ = result; },
			() = cancel.cancelled() => {},
			() = self.inner.cancel.cancelled() => {},
		}
	}

	/// Cancels in-flight starts and shuts down every pooled process, removing
	/// registry bindings gracefully where possible.
	#[tracing::instrument(name = "lsp_roster_shutdown", level = "debug", skip_all)]
	pub async fn shutdown(&self) {
		self.inner.cancel.cancel();
		let keys: Vec<LspPoolKey> = {
			let roster = self.inner.roster.lock();
			roster
				.iter()
				.map(|(name, slot)| pool_key(name, &slot.config, &self.inner.root))
				.collect()
		};
		for key in keys {
			if let Some(process) = self.inner.pool.evict(&key)
				&& let Ok(process) = Arc::try_unwrap(process)
			{
				if let Err(error) = process.shutdown().await {
					tracing::warn!(
						server = %key.server,
						%error,
						"LSP server shutdown failed"
					);
				}
			}
		}
		tracing::info!("LSP roster stopped");
	}

	/// Marks one available server as starting and spawns its startup task.
	fn begin_start(&self, name: Str) {
		{
			let mut roster = self.inner.roster.lock();
			let Some(slot) = roster.get_mut(&name) else {
				return;
			};
			if slot.state != LspServerState::Available {
				return;
			}
			slot.state = LspServerState::Starting;
		}
		self.inner.pending.send_modify(|count| *count += 1);
		self.publish(&name, LspStartupStage::Starting);
		let supervisor = self.clone();
		tokio::spawn(async move {
			supervisor.run_start(&name).await;
			supervisor
				.inner
				.pending
				.send_modify(|count| *count = count.saturating_sub(1));
		});
	}

	#[tracing::instrument(
		name = "lsp_server_start",
		level = "debug",
		skip_all,
		fields(server = %name)
	)]
	async fn run_start(&self, name: &Str) {
		let Some(environment) = self.inner.environment.upgrade() else {
			return;
		};
		let (config, key) = {
			let roster = self.inner.roster.lock();
			let Some(slot) = roster.get(name) else {
				return;
			};
			(slot.config.clone(), pool_key(name, &slot.config, &self.inner.root))
		};
		let cancel = self.inner.cancel.child_token();
		let result = self
			.inner
			.pool
			.get_or_try_init(key.clone(), || {
				LspProcess::start(config.to_process_config(), &environment, cancel.clone())
			})
			.await;
		match result {
			Ok(process) => {
				let current = self
					.inner
					.roster
					.lock()
					.get(name)
					.map(|slot| pool_key(name, &slot.config, &self.inner.root));
				if current.as_ref() != Some(&key) {
					drop(self.inner.pool.evict(&key));
					if let Ok(process) = Arc::try_unwrap(process)
						&& let Err(error) = process.shutdown().await
					{
						tracing::warn!(server = %name, %error, "superseded LSP startup shutdown failed");
					}
					return;
				}
				self.set_state(name, LspServerState::Indexing, None);
				let _ = environment
					.lsp()
					.wait_for_binding_ready(process.binding_id(), cancel)
					.await;
				let current = self
					.inner
					.roster
					.lock()
					.get(name)
					.map(|slot| pool_key(name, &slot.config, &self.inner.root));
				if current.as_ref() != Some(&key) {
					drop(self.inner.pool.evict(&key));
					if let Ok(process) = Arc::try_unwrap(process)
						&& let Err(error) = process.shutdown().await
					{
						tracing::warn!(server = %name, %error, "superseded indexing shutdown failed");
					}
					return;
				}
				self.set_state(name, LspServerState::Ready, None);
				self.publish(name, LspStartupStage::Ready);
				tracing::info!(server = %name, "LSP server ready");
			},
			Err(error) => {
				let current = self
					.inner
					.roster
					.lock()
					.get(name)
					.map(|slot| pool_key(name, &slot.config, &self.inner.root));
				if current.as_ref() != Some(&key) {
					return;
				}
				self.set_state(name, LspServerState::Failed, Some(Str::from(error.to_string())));
				self.publish(name, LspStartupStage::Failed);
				tracing::warn!(server = %name, %error, "LSP server failed to start");
			},
		}
	}

	fn set_state(&self, name: &Str, state: LspServerState, detail: Option<Str>) {
		let mut roster = self.inner.roster.lock();
		if let Some(slot) = roster.get_mut(name) {
			slot.state = state;
			slot.detail = detail;
		}
	}

	fn publish(&self, name: &Str, stage: LspStartupStage) {
		if let Some(environment) = self.inner.environment.upgrade() {
			environment.lsp().publish_startup(name.clone(), stage);
		}
	}
}

fn pool_key(name: &Str, config: &ResolvedLspServer, root: &Path) -> LspPoolKey {
	let mut fingerprint = Vec::with_capacity(256);
	fingerprint.extend_from_slice(config.command.value.as_bytes());
	for arg in &config.args.value {
		fingerprint.push(0);
		fingerprint.extend_from_slice(arg.as_bytes());
	}
	fingerprint.push(0);
	let _ = serde_json::to_writer(&mut fingerprint, &config.settings.value);
	let _ = serde_json::to_writer(&mut fingerprint, &config.init_options.value);
	LspPoolKey {
		server:        name.clone(),
		workspace:     root.to_path_buf(),
		configuration: *Hash32::sum(&fingerprint).as_bytes(),
	}
}

fn discover_roster(
	root: &Path,
	user_config_root: Option<&Path>,
) -> Result<BTreeMap<Str, ServerSlot>, LspConfigError> {
	let sources = discover_native_lsp_sources(user_config_root, root)?;
	let config = load_lsp_config(&sources)?;
	let platform = if cfg!(windows) {
		BinaryPlatform::Windows
	} else {
		BinaryPlatform::Posix
	};
	let local_roots = [root.to_path_buf()];
	let path = env::var_os("PATH");
	let mut roster = BTreeMap::new();
	for (name, server) in &config.servers {
		if server.disabled.value || server.is_linter.value {
			continue;
		}
		if root_marker_ancestor(root, &server.root_markers.value).is_none() {
			continue;
		}
		if resolve_lsp_binary(
			server.command.value.as_str(),
			&server.args.value,
			&local_roots,
			path.as_deref(),
			process::id(),
			platform,
		)
		.is_err()
		{
			continue;
		}
		roster.insert(name.clone(), ServerSlot {
			config: server.clone(),
			state:  LspServerState::Available,
			detail: None,
			source: server.command.provenance.kind.into(),
		});
	}
	Ok(roster)
}

/// Matches `fileTypes` entries by extension equality (dot- and
/// case-insensitive) or exact file-name equality.
///
/// Entries with a leading dot are extension specs only: a dotfile literally
/// named like the spec (`.rs`) never matches by name.
fn matches_path(file_types: &[Str], path: &Path) -> bool {
	let Some(name) = path.file_name().and_then(OsStr::to_str) else {
		return false;
	};
	let file_name = name.to_ascii_lowercase();
	let extension = Path::new(name)
		.extension()
		.and_then(OsStr::to_str)
		.map(str::to_ascii_lowercase);
	file_types.iter().any(|file_type| {
		let normalized = file_type.as_str().to_ascii_lowercase();
		let dotless = normalized.strip_prefix('.').unwrap_or(&normalized);
		extension.as_deref() == Some(dotless)
			|| (!normalized.starts_with('.') && dotless == file_name)
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn file_type_matching_covers_extensions_compounds_and_exact_names() {
		let types =
			[Str::new_static(".rs"), Str::new_static("code-workspace"), Str::new_static("Justfile")];
		assert!(matches_path(&types, Path::new("/w/src/main.rs")));
		assert!(matches_path(&types, Path::new("/w/src/MAIN.RS")));
		assert!(!matches_path(&types, Path::new("/w/main.rson")));
		assert!(!matches_path(&types, Path::new("/w/.rs")), "exact dotfile names match");
		assert!(matches_path(&types, Path::new("/w/app.code-workspace")));
		assert!(matches_path(&types, Path::new("/w/Justfile")));
		assert!(!matches_path(&types, Path::new("/w/notJustfile")));
	}

	#[test]
	fn roster_requires_marker_match_and_resolvable_binary() {
		let scratch = tempfile::tempdir().unwrap();
		let root = scratch.path();
		// No markers at all: bundled catalog yields an empty roster.
		let roster = discover_roster(root, None).unwrap();
		assert!(roster.is_empty(), "unexpected servers: {:?}", roster.keys().collect::<Vec<_>>());

		// A Cargo marker admits rust-analyzer only when the binary resolves.
		std::fs::write(root.join("Cargo.toml"), "[package]").unwrap();
		let roster = discover_roster(root, None).unwrap();
		let expected = which_available("rust-analyzer");
		assert_eq!(roster.contains_key("rust-analyzer"), expected);
	}

	fn which_available(binary: &str) -> bool {
		resolve_lsp_binary(
			binary,
			&[],
			&[],
			env::var_os("PATH").as_deref(),
			process::id(),
			BinaryPlatform::Posix,
		)
		.is_ok()
	}
}
