//! Project-scoped document authority and connection-local session state.

use std::{
	collections::{HashMap, HashSet},
	fmt,
	path::PathBuf,
	sync::{Arc, OnceLock, Weak},
};

use omp_core::{Str, sf};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::docserver::{
	DapAdapterRegistry, DapSessionRegistry, DocumentId, DocumentStore, EditAdapterRegistry, Error,
	LeaseId, PathService, Result, ServerConfig, lsp_registry::LspRegistry,
	lsp_supervisor::NativeLspSupervisor, summary::SummaryService,
	transaction::TransactionCoordinator,
};

/// Opaque workspace reservation identity.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct WorkspaceLeaseId([u8; 16]);

impl WorkspaceLeaseId {
	/// Constructs an identity from its wire representation.
	pub const fn from_bytes(bytes: [u8; 16]) -> Self {
		Self(bytes)
	}

	/// Returns the wire representation.
	pub const fn as_bytes(&self) -> &[u8; 16] {
		&self.0
	}
}

/// One path preventing an advisory or exclusive workspace reservation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceLeaseConflict {
	/// Canonical confined path.
	pub path:            PathBuf,
	/// Active document or workspace lease causing the conflict.
	pub active_lease_id: [u8; 16],
}

/// Result of a workspace lease acquisition attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceLeaseOutcome {
	/// Claimed lease, absent for dry runs and conflicts.
	pub lease_id:  Option<WorkspaceLeaseId>,
	/// Exact conflicting targets.
	pub conflicts: Vec<WorkspaceLeaseConflict>,
}

#[derive(Clone, Default)]
pub(crate) struct WorkspaceLeaseTable {
	inner: Arc<Mutex<WorkspaceLeaseState>>,
}

#[derive(Default)]
struct WorkspaceLeaseState {
	leases:    HashMap<WorkspaceLeaseId, WorkspaceLeaseRecord>,
	by_path:   HashMap<PathBuf, WorkspaceLeaseId>,
	mutations: HashMap<PathBuf, ([u8; 16], usize)>,
	ledger:    HashMap<([u8; 16], [u8; 16]), WorkspaceLeaseOutcome>,
}

struct WorkspaceLeaseRecord {
	owner: [u8; 16],
	paths: Vec<PathBuf>,
}

#[must_use]
pub(crate) struct WorkspaceMutationGuard {
	table: WorkspaceLeaseTable,
	owner: [u8; 16],
	paths: Vec<PathBuf>,
}

impl Drop for WorkspaceMutationGuard {
	fn drop(&mut self) {
		let mut state = self.table.inner.lock();
		for path in &self.paths {
			if let Some((owner, count)) = state.mutations.get_mut(path)
				&& *owner == self.owner
			{
				*count -= 1;
				if *count == 0 {
					state.mutations.remove(path);
				}
			}
		}
	}
}

impl WorkspaceLeaseTable {
	pub(crate) fn check_paths(
		&self,
		owner: Option<[u8; 16]>,
		paths: impl IntoIterator<Item = PathBuf>,
	) -> Result<()> {
		let state = self.inner.lock();
		for path in paths {
			for (reserved, lease_id) in &state.by_path {
				if path.starts_with(reserved) || reserved.starts_with(&path) {
					let lease = &state.leases[lease_id];
					let mutation_owner =
						state
							.mutations
							.iter()
							.find_map(|(mutating, (mutation_owner, _))| {
								(path.starts_with(mutating) || mutating.starts_with(&path))
									.then_some(*mutation_owner)
							});
					if Some(lease.owner) != owner.or(mutation_owner) {
						return Err(Error::InvalidTarget {
							target: Str::new(path.to_string_lossy()),
							reason: sf!("path is held by an exclusive workspace lease"),
						});
					}
				}
			}
		}
		Ok(())
	}

	pub(crate) fn begin_mutation(
		&self,
		owner: [u8; 16],
		mut paths: Vec<PathBuf>,
	) -> Result<WorkspaceMutationGuard> {
		paths.sort();
		paths.dedup();
		let mut state = self.inner.lock();
		for path in &paths {
			for (reserved, lease_id) in &state.by_path {
				if (path.starts_with(reserved) || reserved.starts_with(path))
					&& state.leases[lease_id].owner != owner
				{
					return Err(Error::InvalidTarget {
						target: Str::new(path.to_string_lossy()),
						reason: sf!("path is held by an exclusive workspace lease"),
					});
				}
			}
			for (mutating, (mutation_owner, _)) in &state.mutations {
				let overlaps = path.starts_with(mutating) || mutating.starts_with(path);
				if overlaps && *mutation_owner != owner {
					return Err(Error::InvalidTarget {
						target: Str::new(path.to_string_lossy()),
						reason: sf!("path has an in-flight workspace mutation"),
					});
				}
			}
		}
		for path in &paths {
			let entry = state.mutations.entry(path.clone()).or_insert((owner, 0));
			entry.1 += 1;
		}
		drop(state);
		Ok(WorkspaceMutationGuard { table: self.clone(), owner, paths })
	}

	fn acquire(
		&self,
		owner: [u8; 16],
		transaction_id: [u8; 16],
		paths: Vec<PathBuf>,
		active: impl IntoIterator<Item = (PathBuf, LeaseId)>,
		dry_run: bool,
	) -> WorkspaceLeaseOutcome {
		let mut state = self.inner.lock();
		if !dry_run && let Some(outcome) = state.ledger.get(&(owner, transaction_id)) {
			return outcome.clone();
		}
		let owned: HashSet<_> = paths.iter().collect();
		let mut conflicts = Vec::new();
		for (path, lease_id) in active {
			if owned.contains(&path) {
				conflicts.push(WorkspaceLeaseConflict { path, active_lease_id: *lease_id.as_bytes() });
			}
		}
		for path in &paths {
			for (reserved, lease_id) in &state.by_path {
				if path.starts_with(reserved) || reserved.starts_with(path) {
					conflicts.push(WorkspaceLeaseConflict {
						path:            path.clone(),
						active_lease_id: *lease_id.as_bytes(),
					});
				}
			}
			for (mutating, (mutation_owner, _)) in &state.mutations {
				if path.starts_with(mutating) || mutating.starts_with(path) {
					conflicts.push(WorkspaceLeaseConflict {
						path:            path.clone(),
						active_lease_id: *mutation_owner,
					});
				}
			}
		}
		conflicts.sort_by(|left, right| left.path.cmp(&right.path));
		conflicts.dedup_by(|left, right| left.path == right.path);
		let lease_id = if dry_run || !conflicts.is_empty() {
			None
		} else {
			let lease_id = loop {
				let candidate = WorkspaceLeaseId(rand::random());
				if !state.leases.contains_key(&candidate) {
					break candidate;
				}
			};
			for path in &paths {
				state.by_path.insert(path.clone(), lease_id);
			}
			state
				.leases
				.insert(lease_id, WorkspaceLeaseRecord { owner, paths });
			Some(lease_id)
		};
		let outcome = WorkspaceLeaseOutcome { lease_id, conflicts };
		if !dry_run {
			state
				.ledger
				.insert((owner, transaction_id), outcome.clone());
		}
		outcome
	}

	fn release(&self, owner: [u8; 16], lease_id: WorkspaceLeaseId) -> bool {
		let mut state = self.inner.lock();
		let Some(record) = state.leases.get(&lease_id) else {
			return false;
		};
		if record.owner != owner {
			return false;
		}
		let record = state
			.leases
			.remove(&lease_id)
			.expect("workspace lease was present");
		for path in record.paths {
			state.by_path.remove(&path);
		}
		true
	}

	fn release_owner(&self, owner: [u8; 16]) {
		let ids: Vec<_> = {
			let state = self.inner.lock();
			state
				.leases
				.iter()
				.filter_map(|(id, lease)| (lease.owner == owner).then_some(*id))
				.collect()
		};
		for id in ids {
			let _ = self.release(owner, id);
		}
	}
}
/// Project-scoped document, transaction, path, summary, LSP, and DAP authority.
#[derive(Clone)]
pub struct Environment {
	inner: Arc<EnvironmentInner>,
}

struct EnvironmentInner {
	store:            DocumentStore,
	lsp:              LspRegistry,
	lsp_supervisor:   OnceLock<NativeLspSupervisor>,
	dap_adapters:     DapAdapterRegistry,
	dap_sessions:     DapSessionRegistry,
	transactions:     TransactionCoordinator<LspRegistry>,
	paths:            PathService,
	summaries:        SummaryService,
	workspace_leases: WorkspaceLeaseTable,
	root_uri:         Url,
	workspace_id:     [u8; 16],
	server_epoch:     [u8; 16],
	server_build:     Str,
}

impl fmt::Debug for Environment {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("Environment")
			.field("root_uri", &self.inner.root_uri)
			.finish_non_exhaustive()
	}
}

impl Environment {
	/// Creates one authority for a canonical project root.
	pub fn new(config: ServerConfig) -> Result<Self> {
		let server_build = config.server_build().clone();
		let root_uri = config.file_uri(config.environment_root())?;
		let workspace_leases = WorkspaceLeaseTable::default();
		let store = DocumentStore::new_with_workspace_leases(config, workspace_leases.clone())?;
		let lsp = LspRegistry::new(store.clone());
		let workspace_id = rand::random();
		let server_epoch = rand::random();
		let transactions =
			TransactionCoordinator::with_formatter(store.clone(), server_epoch, lsp.clone());
		let paths = PathService::new(store.clone(), transactions.clone());
		Ok(Self {
			inner: Arc::new(EnvironmentInner {
				store,
				lsp,
				lsp_supervisor: OnceLock::new(),
				dap_adapters: DapAdapterRegistry::with_builtins(),
				dap_sessions: DapSessionRegistry::default(),
				transactions,
				paths,
				summaries: SummaryService::new(),
				workspace_leases,
				root_uri,
				workspace_id,
				server_epoch,
				server_build,
			}),
		})
	}

	/// Starts isolated edit provenance and lease ownership for one connection.
	pub fn session(&self) -> EnvironmentSession {
		EnvironmentSession {
			inner: Arc::new(SessionInner {
				owner:       rand::random(),
				environment: self.clone(),
				adapters:    EditAdapterRegistry::with_built_ins(),
				leases:      Mutex::new(HashMap::new()),
			}),
		}
	}

	/// Returns the shared immutable document store.
	pub fn store(&self) -> &DocumentStore {
		&self.inner.store
	}

	/// Returns the project-scoped LSP binding registry.
	pub fn lsp(&self) -> &LspRegistry {
		&self.inner.lsp
	}

	/// Installs the native language-server supervisor exactly once.
	pub fn install_lsp_supervisor(&self, supervisor: NativeLspSupervisor) {
		let _ = self.inner.lsp_supervisor.set(supervisor);
	}

	/// Returns the native language-server supervisor when one is installed.
	pub fn lsp_supervisor(&self) -> Option<&NativeLspSupervisor> {
		self.inner.lsp_supervisor.get()
	}

	/// Returns a non-owning handle that never keeps the authority alive.
	pub(crate) fn downgrade(&self) -> WeakEnvironment {
		WeakEnvironment { inner: Arc::downgrade(&self.inner) }
	}

	/// Returns the project-scoped DAP adapter registry.
	pub fn dap_adapters(&self) -> &DapAdapterRegistry {
		&self.inner.dap_adapters
	}

	/// Returns the project-scoped live DAP session registry.
	pub fn dap_sessions(&self) -> &DapSessionRegistry {
		&self.inner.dap_sessions
	}

	/// Returns the revisioned transaction coordinator.
	pub fn transactions(&self) -> &TransactionCoordinator<LspRegistry> {
		&self.inner.transactions
	}

	/// Returns the actor-aware path service.
	pub fn paths(&self) -> &PathService {
		&self.inner.paths
	}

	/// Returns the structural summary service.
	pub fn summaries(&self) -> &SummaryService {
		&self.inner.summaries
	}

	/// Returns the canonical project root URI.
	pub fn root_uri(&self) -> &Url {
		&self.inner.root_uri
	}

	/// Returns the stable identity of this running project authority.
	pub fn workspace_id(&self) -> &[u8; 16] {
		&self.inner.workspace_id
	}

	/// Returns the identity scoping the in-memory transaction outcome ledger.
	pub fn server_epoch(&self) -> &[u8; 16] {
		&self.inner.server_epoch
	}

	/// Returns the executable-generation identity advertised to document
	/// clients.
	pub fn server_build(&self) -> &str {
		self.inner.server_build.as_str()
	}

	/// Terminates debug sessions before stopping every active document actor.
	pub async fn shutdown(&self) {
		if let Some(supervisor) = self.inner.lsp_supervisor.get() {
			supervisor.shutdown().await;
		}
		for session in self.inner.dap_sessions.list() {
			let _ = session.terminate().await;
		}
		self.inner.store.shutdown().await;
	}
}
/// Non-owning [`Environment`] handle used by background supervision tasks.
pub(crate) struct WeakEnvironment {
	inner: Weak<EnvironmentInner>,
}

impl WeakEnvironment {
	/// Upgrades to the live authority when it still exists.
	pub(crate) fn upgrade(&self) -> Option<Environment> {
		self.inner.upgrade().map(|inner| Environment { inner })
	}
}

/// Connection-local edit provenance, open leases, and cancellation ownership.
#[derive(Clone)]
pub struct EnvironmentSession {
	inner: Arc<SessionInner>,
}

struct SessionInner {
	owner:       [u8; 16],
	environment: Environment,
	adapters:    EditAdapterRegistry,
	leases:      Mutex<HashMap<LeaseId, OwnedLease>>,
}

impl Drop for SessionInner {
	fn drop(&mut self) {
		self
			.environment
			.inner
			.workspace_leases
			.release_owner(self.owner);
	}
}

struct OwnedLease {
	document_id:  DocumentId,
	cancellation: CancellationToken,
	events_ready: CancellationToken,
}

impl fmt::Debug for EnvironmentSession {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("EnvironmentSession")
			.finish_non_exhaustive()
	}
}

impl EnvironmentSession {
	/// Returns the project authority shared by this connection.
	pub fn environment(&self) -> &Environment {
		&self.inner.environment
	}

	/// Returns this connection's authority identity.
	pub fn owner(&self) -> [u8; 16] {
		self.inner.owner
	}

	/// Atomically checks or claims an exclusive set of canonical workspace
	/// paths.
	pub async fn acquire_workspace_lease(
		&self,
		uris: &[Url],
		transaction_id: [u8; 16],
		dry_run: bool,
	) -> Result<WorkspaceLeaseOutcome> {
		let mut paths = Vec::with_capacity(uris.len());
		for uri in uris {
			paths.push(self.environment().store().resolve_entry_path(uri)?);
		}
		paths.sort();
		paths.dedup();
		let gate = self.environment().store().mutation_gate();
		let _authority = gate.lock().await;
		let owned: HashSet<_> = self.inner.leases.lock().keys().copied().collect();
		let active = self
			.environment()
			.store()
			.active_leases_for_paths(&paths)
			.into_iter()
			.filter(|(_, lease_id)| !owned.contains(lease_id))
			.collect::<Vec<_>>();
		Ok(self.environment().inner.workspace_leases.acquire(
			self.owner(),
			transaction_id,
			paths,
			active,
			dry_run,
		))
	}

	/// Releases an exclusive workspace lease owned by this connection.
	pub fn release_workspace_lease(&self, lease_id: WorkspaceLeaseId) -> bool {
		self
			.environment()
			.inner
			.workspace_leases
			.release(self.owner(), lease_id)
	}

	pub(crate) fn release_workspace_leases(&self) {
		self
			.environment()
			.inner
			.workspace_leases
			.release_owner(self.owner());
	}

	pub(crate) fn check_workspace_paths(
		&self,
		paths: impl IntoIterator<Item = PathBuf>,
	) -> Result<()> {
		self
			.environment()
			.inner
			.workspace_leases
			.check_paths(Some(self.owner()), paths)
	}

	/// Returns this connection's isolated edit-format registry.
	pub fn edit_adapters(&self) -> &EditAdapterRegistry {
		&self.inner.adapters
	}

	pub(crate) fn own_lease(
		&self,
		lease_id: LeaseId,
		document_id: DocumentId,
		cancellation: CancellationToken,
		events_ready: CancellationToken,
	) {
		self.inner.leases.lock().insert(lease_id, OwnedLease {
			document_id,
			cancellation,
			events_ready,
		});
	}

	pub(crate) fn owns_lease(&self, lease_id: LeaseId) -> bool {
		self.inner.leases.lock().contains_key(&lease_id)
	}

	pub(crate) fn start_lease_events(&self, lease_id: LeaseId) -> bool {
		let leases = self.inner.leases.lock();
		let Some(lease) = leases.get(&lease_id) else {
			return false;
		};
		lease.events_ready.cancel();
		true
	}

	pub(crate) fn release_lease(&self, lease_id: LeaseId) -> bool {
		self
			.inner
			.leases
			.lock()
			.remove(&lease_id)
			.map(|lease| {
				lease.cancellation.cancel();
				lease.events_ready.cancel();
			})
			.is_some()
	}

	pub(crate) fn lease_for_document(&self, document_id: DocumentId) -> Option<LeaseId> {
		self
			.inner
			.leases
			.lock()
			.iter()
			.find_map(|(lease_id, lease)| {
				(lease.document_id == document_id && lease.events_ready.is_cancelled())
					.then_some(*lease_id)
			})
	}

	pub(crate) fn take_leases(&self) -> Vec<LeaseId> {
		let mut leases = self.inner.leases.lock();
		let lease_ids = leases.keys().copied().collect();
		for lease in leases.values() {
			lease.cancellation.cancel();
			lease.events_ready.cancel();
		}
		leases.clear();
		lease_ids
	}
}

#[cfg(test)]
mod tests {

	use std::{fs, slice};

	use tempfile::TempDir;

	use super::*;

	#[test]
	fn lease_events_become_visible_only_after_the_open_response_is_enqueued() {
		let root = TempDir::new().expect("temporary directory");
		let session = Environment::new(ServerConfig::new(root.path()).expect("server config"))
			.expect("environment")
			.session();
		let lease_id = LeaseId::from_bytes([1; 16]);
		let document_id = DocumentId::from_bytes([2; 16]);
		let forwarder = CancellationToken::new();
		let ready = CancellationToken::new();
		session.own_lease(lease_id, document_id, forwarder, ready);

		assert_eq!(session.lease_for_document(document_id), None);
		assert!(session.start_lease_events(lease_id));
		assert_eq!(session.lease_for_document(document_id), Some(lease_id));
	}

	#[test]
	fn environment_owns_a_second_project_registry_for_dap() {
		let root = TempDir::new().expect("temporary directory");
		let environment = Environment::new(ServerConfig::new(root.path()).expect("server config"))
			.expect("environment");
		assert!(environment.dap_adapters().list().len() >= 14);
		assert!(environment.dap_sessions().list().is_empty());
	}

	#[tokio::test]
	async fn workspace_lease_reports_foreign_document_lease() {
		let root = TempDir::new().expect("temporary directory");
		let config = ServerConfig::new(root.path()).expect("server config");
		let path = config.environment_root().join("active.txt");
		fs::write(&path, b"active").expect("fixture");
		let uri = config.file_uri(&path).expect("file URI");
		let environment = Environment::new(config).expect("environment");
		let owner = environment.session();
		let contender = environment.session();
		let opened = environment.store().open(path).await.expect("open");
		owner.own_lease(
			opened.lease_id(),
			opened.head().document_id(),
			CancellationToken::new(),
			CancellationToken::new(),
		);

		let outcome = contender
			.acquire_workspace_lease(&[uri], [1; 16], false)
			.await
			.expect("acquire");
		assert!(outcome.lease_id.is_none());
		assert_eq!(outcome.conflicts.len(), 1);
		assert_eq!(outcome.conflicts[0].active_lease_id, *opened.lease_id().as_bytes());
	}

	#[tokio::test]
	async fn workspace_dry_run_is_advisory_and_acquire_race_has_one_winner() {
		let root = TempDir::new().expect("temporary directory");
		let config = ServerConfig::new(root.path()).expect("server config");
		let path = config.environment_root().join("restore.txt");
		fs::write(&path, b"restore").expect("fixture");
		let uri = config.file_uri(&path).expect("file URI");
		let environment = Environment::new(config).expect("environment");
		let left = environment.session();
		let right = environment.session();
		let dry_run = left
			.acquire_workspace_lease(slice::from_ref(&uri), [2; 16], true)
			.await
			.expect("dry run");
		assert!(dry_run.lease_id.is_none());
		assert!(dry_run.conflicts.is_empty());

		let (left_outcome, right_outcome) = tokio::join!(
			left.acquire_workspace_lease(slice::from_ref(&uri), [3; 16], false),
			right.acquire_workspace_lease(slice::from_ref(&uri), [4; 16], false),
		);
		let left_outcome = left_outcome.expect("left acquire");
		let right_outcome = right_outcome.expect("right acquire");
		assert_ne!(left_outcome.lease_id.is_some(), right_outcome.lease_id.is_some());
		let loser = if left_outcome.lease_id.is_none() {
			left_outcome
		} else {
			right_outcome
		};
		assert_eq!(loser.conflicts.len(), 1);
		assert!(environment.store().open(path.clone()).await.is_err());
		drop(left);
		drop(right);
		assert!(environment.store().open(path).await.is_ok());
	}

	#[tokio::test]
	async fn dropping_connection_workspace_leases_unblocks_next_owner() {
		let root = TempDir::new().expect("temporary directory");
		let config = ServerConfig::new(root.path()).expect("server config");
		let uri = config
			.file_uri(&config.environment_root().join("restore.txt"))
			.expect("file URI");
		let environment = Environment::new(config).expect("environment");
		let first = environment.session();
		let second = environment.session();
		let held = first
			.acquire_workspace_lease(slice::from_ref(&uri), [5; 16], false)
			.await
			.expect("first acquire");
		assert!(held.lease_id.is_some());
		drop(first);
		let acquired = second
			.acquire_workspace_lease(&[uri], [6; 16], false)
			.await
			.expect("second acquire");
		assert!(acquired.lease_id.is_some());
		assert!(acquired.conflicts.is_empty());
	}
}
