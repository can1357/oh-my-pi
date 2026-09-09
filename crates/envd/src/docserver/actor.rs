#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::sync::mpsc::{self, Sender};
use std::{
	collections::{HashMap, HashSet, VecDeque, hash_map::Entry},
	fmt, mem,
	path::{Path, PathBuf},
	str,
	sync::{
		Arc, Weak,
		atomic::{AtomicU64, Ordering},
	},
	thread,
	time::Duration,
};

use bytes::Bytes;
use flume::Receiver;
use omp_core::{Str, sf};
use parking_lot::MutexGuard;
use rand::RngExt as _;
use tokio::{
	runtime,
	sync::{Mutex, broadcast, oneshot},
	task,
	task::JoinError,
	time::{self, Instant},
};
use url::Url;

use crate::docserver::{
	ActiveFileWatch, ByteRange, DocumentHead, DocumentId, DocumentKind, DocumentPresence,
	DocumentSnapshot, Error, FileFingerprint, FileWatchEvent, FileWatchKind, LeaseId, LineRange,
	Result, Revision, ServerConfig, TransactionId,
	environment::WorkspaceLeaseTable,
	fs::{
		DiskExpectation, DiskState, FollowSymlinks, LocalFs, PathMetadata, PortablePermissions,
		PreparedDelete, PreparedMove, PreparedWrite,
	},
};

const IDLE_EVICTION_DELAY: Duration = Duration::from_millis(250);
const INITIAL_WATCH_GENERATION: u64 = 1;
const DOCUMENT_EVENT_CAPACITY: usize = 64;
const ACTOR_COMMAND_CAPACITY: usize = 256;

/// An address accepted by document-store operations.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum DocumentLocator {
	/// A path used to activate a document, or an already-canonical active path.
	Path(PathBuf),
	/// An active document's opaque identity.
	Document(DocumentId),
	/// A lease issued by an open operation.
	Lease(LeaseId),
}

impl From<PathBuf> for DocumentLocator {
	fn from(path: PathBuf) -> Self {
		Self::Path(path)
	}
}

impl From<DocumentId> for DocumentLocator {
	fn from(document_id: DocumentId) -> Self {
		Self::Document(document_id)
	}
}

impl From<LeaseId> for DocumentLocator {
	fn from(lease_id: LeaseId) -> Self {
		Self::Lease(lease_id)
	}
}

/// A memory-only selection from an immutable document snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReadSelection {
	/// Return the complete exact byte sequence.
	Whole,
	/// Return zero-based half-open byte ranges.
	Bytes(Vec<ByteRange>),
	/// Return zero-based half-open logical-line ranges.
	Lines(Vec<LineRange>),
}

/// One selected interval and its zero-copy view of snapshot bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContentSlice {
	start:   u64,
	end:     u64,
	content: Bytes,
}

impl ContentSlice {
	/// Returns the inclusive byte or line coordinate supplied by the caller.
	pub const fn start(&self) -> u64 {
		self.start
	}

	/// Returns the exclusive byte or line coordinate supplied by the caller.
	pub const fn end(&self) -> u64 {
		self.end
	}

	/// Returns exact shared bytes covered by this interval.
	pub const fn content(&self) -> &Bytes {
		&self.content
	}
}

/// The body returned by a cached document read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReadBody {
	/// Complete exact document bytes.
	Whole(Bytes),
	/// Selected byte or line intervals in request order.
	Slices(Vec<ContentSlice>),
}

/// A committed head and bytes selected from the same immutable snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadResult {
	head: DocumentHead,
	body: ReadBody,
}

impl ReadResult {
	/// Returns the committed head that owns the returned bytes.
	pub const fn head(&self) -> &DocumentHead {
		&self.head
	}

	/// Returns the selected snapshot bytes.
	pub const fn body(&self) -> &ReadBody {
		&self.body
	}
}

/// Classification of a committed per-document event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DocumentEventKind {
	/// A transaction committed new content.
	Committed,
	/// A missing path was externally created.
	ExternalCreated,
	/// Present bytes or their exact disk fingerprint changed externally.
	ExternalModified,
	/// The active path was externally removed.
	ExternalDeleted,
	/// The active path was externally renamed away.
	ExternalRenamed,
	/// A conservative native-watch rescan completed.
	WatchRescanned,
}

/// A sequenced event delivered after its immutable head is installed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentEvent {
	event_sequence: u64,
	kind: DocumentEventKind,
	head: DocumentHead,
	path: PathBuf,
	previous_revision: Revision,
	transaction_id: Option<TransactionId>,
	invalidated_transaction_ids: Vec<TransactionId>,
	previous_path: Option<PathBuf>,
}

impl DocumentEvent {
	/// Returns the document-local, strictly increasing event sequence.
	pub const fn event_sequence(&self) -> u64 {
		self.event_sequence
	}

	/// Returns why the head was published.
	pub const fn kind(&self) -> DocumentEventKind {
		self.kind
	}

	/// Returns the installed head visible to subsequent reads.
	pub const fn head(&self) -> &DocumentHead {
		&self.head
	}

	/// Returns the active path captured with this event.
	pub fn path(&self) -> &Path {
		&self.path
	}

	/// Returns the head revision that preceded this event.
	pub const fn previous_revision(&self) -> Revision {
		self.previous_revision
	}

	/// Returns the transaction responsible for a committed event.
	pub const fn transaction_id(&self) -> Option<TransactionId> {
		self.transaction_id
	}

	/// Returns reservations invalidated before this event was installed.
	pub fn invalidated_transaction_ids(&self) -> &[TransactionId] {
		&self.invalidated_transaction_ids
	}

	/// Returns the former path for a rename event when one is known.
	pub fn previous_path(&self) -> Option<&Path> {
		self.previous_path.as_deref()
	}
}

mod opened_document {
	use tokio::sync::broadcast::Receiver;

	use super::{DocumentEvent, DocumentHead, LeaseId};

	/// An active lease, its initial committed head, and its private event
	/// stream.
	#[derive(Debug)]
	pub struct OpenedDocument {
		lease_id: LeaseId,
		head:     DocumentHead,
		events:   Receiver<DocumentEvent>,
	}

	impl OpenedDocument {
		pub(super) const fn new(
			lease_id: LeaseId,
			head: DocumentHead,
			events: Receiver<DocumentEvent>,
		) -> Self {
			Self { lease_id, head, events }
		}

		/// Returns the lease that keeps this document active.
		pub const fn lease_id(&self) -> LeaseId {
			self.lease_id
		}

		/// Returns the head installed before this open completed.
		pub const fn head(&self) -> &DocumentHead {
			&self.head
		}

		/// Returns this lease's ordered event subscription.
		pub const fn events(&mut self) -> &mut Receiver<DocumentEvent> {
			&mut self.events
		}

		/// Splits the result into its lease, head, and event subscription.
		pub fn into_parts(self) -> (LeaseId, DocumentHead, Receiver<DocumentEvent>) {
			(self.lease_id, self.head, self.events)
		}
	}
}

pub use opened_document::OpenedDocument;

/// Registry and lifecycle owner for all active canonical documents.
#[derive(Clone)]
pub struct DocumentStore {
	inner: Arc<RegistryInner>,
}

impl fmt::Debug for DocumentStore {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("DocumentStore")
			.finish_non_exhaustive()
	}
}

impl DocumentStore {
	/// Creates an empty document registry rooted at `config`.
	pub fn new(config: ServerConfig) -> Result<Self> {
		Self::new_with_workspace_leases(config, WorkspaceLeaseTable::default())
	}

	/// Creates a registry sharing the Environment's exclusive workspace leases.
	pub(crate) fn new_with_workspace_leases(
		config: ServerConfig,
		workspace_leases: WorkspaceLeaseTable,
	) -> Result<Self> {
		let fs = LocalFs::new(&config)?;
		Ok(Self {
			inner: Arc::new(RegistryInner {
				revision_capacity: config.revision_capacity().get(),
				config,
				fs,
				mutation_gate: Arc::new(Mutex::new(())),
				maps: RegistryMapsLock::new(RegistryMaps::default()),
				workspace_leases,
			}),
		})
	}

	/// Acquires a distinct lease, activating and caching a path when necessary.
	pub async fn open(&self, locator: impl Into<DocumentLocator>) -> Result<OpenedDocument> {
		let locator = locator.into();
		let gate = self.mutation_gate();
		let _authority = gate.lock().await;
		let path = match &locator {
			DocumentLocator::Path(path) if path.is_absolute() => path.clone(),
			DocumentLocator::Path(path) => self.inner.config.environment_root().join(path),
			DocumentLocator::Document(document_id) => {
				self.handle_for_id(*document_id)?.state().await?.path
			},
			DocumentLocator::Lease(lease_id) => self.handle_for_lease(*lease_id)?.state().await?.path,
		};
		self.inner.workspace_leases.check_paths(None, [path])?;
		self.open_with_mutation_authority(locator).await
	}

	/// Opens a document while the caller already owns the shared mutation
	/// authority.
	///
	/// Transaction planning uses this path to avoid recursively acquiring the
	/// non-reentrant authority held across its filesystem inspection.
	pub(crate) async fn open_with_mutation_authority(
		&self,
		locator: impl Into<DocumentLocator>,
	) -> Result<OpenedDocument> {
		let locator = locator.into();
		let handle = match locator {
			DocumentLocator::Path(path) => self.open_path_handle(path).await?,
			DocumentLocator::Document(document_id) => self.handle_for_id(document_id)?,
			DocumentLocator::Lease(lease_id) => self.handle_for_lease(lease_id)?,
		};
		let lease_id = self.inner.allocate_lease(handle.document_id);
		let mut guard = OpenLeaseGuard::new(Arc::clone(&self.inner), handle.clone(), lease_id);
		let opened = handle.open(lease_id).await?;
		guard.disarm();
		Ok(opened)
	}

	/// Reads current or retained exact bytes without consulting the filesystem.
	pub async fn read(
		&self,
		locator: impl Into<DocumentLocator>,
		revision: Option<Revision>,
		selection: ReadSelection,
	) -> Result<ReadResult> {
		self
			.resolve_active(locator.into())?
			.read(revision, selection)
			.await
	}

	/// Resolves a crate-internal actor endpoint without performing filesystem
	/// I/O.
	pub(crate) fn actor_handle(&self, locator: impl Into<DocumentLocator>) -> Result<ActorHandle> {
		self.resolve_active(locator.into())
	}

	/// Resolves an exact canonical path to its registered actor, if any.
	pub(crate) fn actor_handle_for_path(&self, path: &Path) -> Option<ActorHandle> {
		let maps = self.inner.lock_maps();
		let document_id = maps.by_path.get(path)?;
		maps.by_id.get(document_id).cloned()
	}

	/// Snapshots actor endpoints whose canonical bindings are at or below
	/// `path`.
	pub(crate) fn actor_handles_under(&self, path: &Path) -> Vec<ActorHandle> {
		let maps = self.inner.lock_maps();
		maps
			.by_path
			.iter()
			.filter(|(candidate, _)| candidate.starts_with(path))
			.filter_map(|(_, document_id)| maps.by_id.get(document_id).cloned())
			.collect()
	}

	/// Returns the capability-rooted filesystem used by actor preparation
	/// workers.
	pub(crate) fn local_fs(&self) -> LocalFs {
		self.inner.fs.clone()
	}

	/// Returns the mutation authority shared by transactions and Environment
	/// path operations.
	pub(crate) fn mutation_gate(&self) -> Arc<Mutex<()>> {
		Arc::clone(&self.inner.mutation_gate)
	}

	/// Snapshots active lease identities for the selected exact paths.
	pub(crate) fn active_leases_for_paths(&self, paths: &[PathBuf]) -> Vec<(PathBuf, LeaseId)> {
		let maps = self.inner.lock_maps();
		maps
			.by_lease
			.iter()
			.filter_map(|(lease_id, document_id)| {
				let path = maps
					.by_path
					.iter()
					.find_map(|(path, owner)| (*owner == *document_id).then_some(path))?;
				paths.contains(path).then(|| (path.clone(), *lease_id))
			})
			.collect()
	}

	/// Checks selected mutation paths against the shared workspace lease table.
	pub(crate) fn check_workspace_paths(
		&self,
		owner: Option<[u8; 16]>,
		paths: impl IntoIterator<Item = PathBuf>,
	) -> Result<()> {
		self.inner.workspace_leases.check_paths(owner, paths)
	}

	pub(crate) fn workspace_leases(&self) -> &WorkspaceLeaseTable {
		&self.inner.workspace_leases
	}

	/// Resolves a no-follow destination entry which may be missing.
	pub(crate) fn resolve_entry_path(&self, uri: &Url) -> Result<PathBuf> {
		self.inner.config.resolve_file_uri(uri)
	}

	/// Converts a confined canonical entry path into its file URI.
	pub(crate) fn file_uri(&self, path: &Path) -> Result<Url> {
		self.inner.config.file_uri(path)
	}

	/// Releases a lease and permits bounded idle eviction after the last
	/// release.
	pub async fn close(&self, lease_id: LeaseId) -> Result<()> {
		let handle = self.handle_for_lease(lease_id)?;
		handle.close(lease_id).await?;
		self.inner.remove_lease(lease_id);
		Ok(())
	}

	/// Shuts down every actor currently registered in this store.
	pub async fn shutdown(&self) {
		let handles = self.inner.handles();
		for handle in handles {
			let _ = handle.shutdown().await;
		}
	}

	async fn open_path_handle(&self, path: PathBuf) -> Result<ActorHandle> {
		let candidate = if path.is_absolute() {
			path.clone()
		} else {
			self.inner.config.environment_root().join(&path)
		};
		{
			let maps = self.inner.lock_maps();
			if let Some(handle) = maps
				.by_path
				.get(&candidate)
				.and_then(|document_id| maps.by_id.get(document_id))
			{
				return Ok(handle.clone());
			}
		}
		let config = self.inner.config.clone();
		let canonical = task::spawn_blocking(move || config.resolve_target(path))
			.await
			.map_err(join_error)??;

		let mut maps = self.inner.lock_maps();
		if maps.rebind_reservations.contains_key(&canonical) {
			return Err(Error::InvalidTarget {
				target: Str::new(canonical.to_string_lossy()),
				reason: sf!("document path is reserved by an in-flight move"),
			});
		}
		if let Some(document_id) = maps.by_path.get(&canonical).copied() {
			if let Some(handle) = maps.by_id.get(&document_id) {
				return Ok(handle.clone());
			}
			maps.by_path.remove(&canonical);
		}

		let document_id = fresh_document_id(&maps.by_id);
		let handle = spawn_actor(
			document_id,
			canonical.clone(),
			self.inner.fs.clone(),
			self.inner.revision_capacity,
			Arc::downgrade(&self.inner),
		);
		maps.by_path.insert(canonical, document_id);
		maps.by_id.insert(document_id, handle.clone());
		Ok(handle)
	}

	fn resolve_active(&self, locator: DocumentLocator) -> Result<ActorHandle> {
		match locator {
			DocumentLocator::Document(document_id) => self.handle_for_id(document_id),
			DocumentLocator::Lease(lease_id) => self.handle_for_lease(lease_id),
			DocumentLocator::Path(path) => {
				let maps = self.inner.lock_maps();
				let document_id =
					maps
						.by_path
						.get(&path)
						.copied()
						.ok_or_else(|| Error::InvalidTarget {
							target: Str::new(path.to_string_lossy()),
							reason: sf!("path reads require an already-canonical active document path",),
						})?;
				maps
					.by_id
					.get(&document_id)
					.cloned()
					.ok_or(Error::DocumentNotFound { document_id })
			},
		}
	}

	fn handle_for_id(&self, document_id: DocumentId) -> Result<ActorHandle> {
		self
			.inner
			.lock_maps()
			.by_id
			.get(&document_id)
			.cloned()
			.ok_or(Error::DocumentNotFound { document_id })
	}

	fn handle_for_lease(&self, lease_id: LeaseId) -> Result<ActorHandle> {
		let maps = self.inner.lock_maps();
		let document_id = maps
			.by_lease
			.get(&lease_id)
			.copied()
			.ok_or(Error::LeaseExpired { lease_id })?;
		maps
			.by_id
			.get(&document_id)
			.cloned()
			.ok_or(Error::LeaseExpired { lease_id })
	}

	/// Reserves an unoccupied canonical destination for an actor path rebind.
	pub(crate) fn reserve_rebind_path(
		&self,
		document_id: DocumentId,
		new_path: PathBuf,
	) -> Result<PathReservation> {
		if !new_path.is_absolute() || !new_path.starts_with(self.inner.config.environment_root()) {
			return Err(Error::InvalidTarget {
				target: Str::new(new_path.to_string_lossy()),
				reason: sf!("rebind path must be canonical and confined"),
			});
		}
		let mut maps = self.inner.lock_maps();
		if maps
			.by_path
			.get(&new_path)
			.is_some_and(|owner| *owner != document_id)
			|| maps.rebind_reservations.contains_key(&new_path)
		{
			return Err(Error::InvalidTarget {
				target: Str::new(new_path.to_string_lossy()),
				reason: sf!("rebind destination is already active or reserved"),
			});
		}
		maps
			.rebind_reservations
			.insert(new_path.clone(), document_id);
		Ok(PathReservation {
			registry: Arc::downgrade(&self.inner),
			document_id,
			path: Some(new_path),
			retired: None,
		})
	}

	/// Claims a move destination, retiring only an inactive actor at the exact
	/// expected head.
	pub(crate) async fn reserve_move_destination(
		&self,
		document_id: DocumentId,
		path: PathBuf,
		expectation: DestinationExpectation,
	) -> Result<PathReservation> {
		let incumbent = {
			let maps = self.inner.lock_maps();
			maps
				.by_path
				.get(&path)
				.filter(|owner| **owner != document_id)
				.and_then(|owner| maps.by_id.get(owner))
				.cloned()
		};
		if let Some(incumbent) = incumbent {
			return incumbent
				.retire_destination(document_id, path, expectation)
				.await;
		}
		if matches!(expectation, DestinationExpectation::Revision(_)) {
			return Err(Error::InvalidTarget {
				target: Str::new(path.to_string_lossy()),
				reason: sf!("move destination revision is not active"),
			});
		}
		self.reserve_rebind_path(document_id, path)
	}
}

/// Exact precondition used when claiming an inactive move destination.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DestinationExpectation {
	/// The destination must have no directory entry.
	Missing,
	/// The inactive destination must retain this exact revision.
	Revision(Revision),
}

impl DestinationExpectation {
	fn matches(self, snapshot: &DocumentSnapshot) -> bool {
		match self {
			Self::Missing => snapshot.head().presence() == DocumentPresence::Missing,
			Self::Revision(revision) => snapshot.head().revision() == revision,
		}
	}
}

#[derive(Default)]
struct RegistryMaps {
	by_path:             HashMap<PathBuf, DocumentId>,
	by_id:               HashMap<DocumentId, ActorHandle>,
	by_lease:            HashMap<LeaseId, DocumentId>,
	rebind_reservations: HashMap<PathBuf, DocumentId>,
}

mod registry_maps_lock {
	use parking_lot::{Mutex, MutexGuard};

	use super::RegistryMaps;

	pub(super) struct RegistryMapsLock(Mutex<RegistryMaps>);

	impl RegistryMapsLock {
		pub(super) fn new(maps: RegistryMaps) -> Self {
			Self(Mutex::new(maps))
		}

		pub(super) fn lock(&self) -> MutexGuard<'_, RegistryMaps> {
			self.0.lock()
		}

		pub(super) fn get_mut(&mut self) -> &mut RegistryMaps {
			self.0.get_mut()
		}
	}
}

use registry_maps_lock::RegistryMapsLock;

struct RegistryInner {
	config:            ServerConfig,
	fs:                LocalFs,
	revision_capacity: usize,
	mutation_gate:     Arc<Mutex<()>>,
	maps:              RegistryMapsLock,
	workspace_leases:  WorkspaceLeaseTable,
}

struct OpenLeaseGuard {
	registry: Arc<RegistryInner>,
	handle:   ActorHandle,
	lease_id: LeaseId,
	armed:    bool,
}

impl OpenLeaseGuard {
	const fn new(registry: Arc<RegistryInner>, handle: ActorHandle, lease_id: LeaseId) -> Self {
		Self { registry, handle, lease_id, armed: true }
	}

	const fn disarm(&mut self) {
		self.armed = false;
	}
}

impl Drop for OpenLeaseGuard {
	fn drop(&mut self) {
		if !self.armed {
			return;
		}
		self.registry.remove_lease(self.lease_id);
		self.handle.cancel_open(self.lease_id);
	}
}

impl RegistryInner {
	fn lock_maps(&self) -> MutexGuard<'_, RegistryMaps> {
		self.maps.lock()
	}

	fn allocate_lease(&self, document_id: DocumentId) -> LeaseId {
		let mut maps = self.lock_maps();
		loop {
			let lease_id = LeaseId::from_bytes(random_id_bytes());
			if let Entry::Vacant(entry) = maps.by_lease.entry(lease_id) {
				entry.insert(document_id);
				return lease_id;
			}
		}
	}

	fn remove_lease(&self, lease_id: LeaseId) {
		self.lock_maps().by_lease.remove(&lease_id);
	}

	fn handles(&self) -> Vec<ActorHandle> {
		self.lock_maps().by_id.values().cloned().collect()
	}

	fn actor_exited(&self, document_id: DocumentId) {
		let mut maps = self.lock_maps();
		maps.by_id.remove(&document_id);
		maps.by_path.retain(|_, owner| *owner != document_id);
		maps.by_lease.retain(|_, owner| *owner != document_id);
		maps
			.rebind_reservations
			.retain(|_, owner| *owner != document_id);
	}

	fn release_path_reservation(
		&self,
		document_id: DocumentId,
		path: &Path,
		retired: Option<RetiredPathAuthority>,
	) {
		let mut maps = self.lock_maps();
		if maps.rebind_reservations.get(path) != Some(&document_id) {
			drop(maps);
			if let Some(retired) = retired {
				retired.handle.release_retired_authority(document_id, false);
			}
			return;
		}
		maps.rebind_reservations.remove(path);
		let restored_handle = retired.map(|retired| {
			debug_assert!(!maps.by_path.contains_key(path));
			debug_assert!(!maps.by_id.contains_key(&retired.document_id));
			let handle = retired.handle.clone();
			maps.by_path.insert(path.to_path_buf(), retired.document_id);
			maps.by_id.insert(retired.document_id, retired.handle);
			handle
		});
		drop(maps);
		if let Some(handle) = restored_handle {
			handle.release_retired_authority(document_id, true);
		}
	}

	fn retire_and_reserve_path(
		self: &Arc<Self>,
		incumbent: DocumentId,
		replacement: DocumentId,
		path: &Path,
	) -> Result<PathReservation> {
		let mut maps = self.lock_maps();
		if maps.by_path.get(path) != Some(&incumbent)
			|| !maps.by_id.contains_key(&incumbent)
			|| maps.by_lease.values().any(|owner| *owner == incumbent)
			|| maps.rebind_reservations.contains_key(path)
		{
			return Err(Error::InvalidTarget {
				target: Str::new(path.to_string_lossy()),
				reason: sf!("move destination became active or changed"),
			});
		}
		let incumbent_handle = maps
			.by_id
			.remove(&incumbent)
			.expect("validated incumbent authority exists");
		maps.by_path.remove(path);
		maps
			.rebind_reservations
			.insert(path.to_path_buf(), replacement);
		Ok(PathReservation {
			registry:    Arc::downgrade(self),
			document_id: replacement,
			path:        Some(path.to_path_buf()),
			retired:     Some(RetiredPathAuthority {
				document_id: incumbent,
				handle:      incumbent_handle,
			}),
		})
	}

	fn commit_path_reservation(
		&self,
		document_id: DocumentId,
		old_path: &Path,
		new_path: &Path,
	) -> Result<()> {
		let mut maps = self.lock_maps();
		if maps.rebind_reservations.get(new_path) != Some(&document_id)
			|| maps.by_path.get(old_path) != Some(&document_id)
		{
			return Err(Error::ExternalInvalidation { path: new_path.to_path_buf() });
		}
		maps.rebind_reservations.remove(new_path);
		maps.by_path.remove(old_path);
		maps.by_path.insert(new_path.to_path_buf(), document_id);
		Ok(())
	}
}

impl Drop for RegistryInner {
	fn drop(&mut self) {
		let maps = self.maps.get_mut();
		for handle in maps.by_id.values() {
			let _ = handle.sender.try_send(Command::Shutdown { reply: None });
		}
	}
}

/// Exclusive registry claim for a future path rebind.
#[must_use]
pub struct PathReservation {
	registry:    Weak<RegistryInner>,
	document_id: DocumentId,
	path:        Option<PathBuf>,
	retired:     Option<RetiredPathAuthority>,
}

struct RetiredPathAuthority {
	document_id: DocumentId,
	handle:      ActorHandle,
}

impl PathReservation {
	/// Returns the claimed canonical destination.
	pub(crate) fn path(&self) -> &Path {
		self
			.path
			.as_deref()
			.expect("live path reservation has a path")
	}

	fn commit(mut self, old_path: &Path) -> Result<PathBuf> {
		let path = self
			.path
			.as_ref()
			.expect("live path reservation has a path")
			.clone();
		let registry = self.registry.upgrade().ok_or_else(actor_unavailable)?;
		registry.commit_path_reservation(self.document_id, old_path, &path)?;
		self.path = None;
		if let Some(retired) = self.retired.take() {
			retired
				.handle
				.release_retired_authority(self.document_id, false);
		}
		Ok(path)
	}
}

impl Drop for PathReservation {
	fn drop(&mut self) {
		let Some(path) = self.path.as_deref() else {
			return;
		};
		let retired = self.retired.take();
		if let Some(registry) = self.registry.upgrade() {
			registry.release_path_reservation(self.document_id, path, retired);
		} else if let Some(retired) = retired {
			retired
				.handle
				.release_retired_authority(self.document_id, false);
		}
	}
}

/// Monotone actor generation invalidating provisional transaction work.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ActorGeneration(u64);

/// A generation-bound claim on one actor's current committed revision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentReservation {
	document_id:    DocumentId,
	transaction_id: TransactionId,
	generation:     ActorGeneration,
	base_revision:  Revision,
}

/// Reservation plus the exact cached disk state captured in its mailbox turn.
#[derive(Clone, Debug)]
pub struct ReservedDocument {
	/// Opaque token consumed by actor-authorized commit or rebind commands.
	pub(crate) reservation:      DocumentReservation,
	/// Canonical path bound when the reservation was acquired.
	pub(crate) path:             PathBuf,
	/// Immutable committed base snapshot.
	pub(crate) snapshot:         Arc<DocumentSnapshot>,
	/// Exact persisted state required by preparation and final replacement.
	pub(crate) disk_expectation: DiskExpectation,
}

/// Final immutable metadata supplied with an actor-authorized prepared write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedSnapshotMetadata {
	/// Interpretation retained when the committed bytes become the new head.
	pub(crate) kind: DocumentKind,
}

/// Immutable diagnostic state returned from an actor mailbox turn.
#[derive(Clone, Debug)]
pub struct ActorStateSnapshot {
	/// Stable identity of the actor.
	pub(crate) document_id: DocumentId,
	/// Current canonical path binding.
	pub(crate) path:        PathBuf,
	/// Current immutable head, when activation has completed.
	pub(crate) head:        Option<Arc<DocumentSnapshot>>,
	/// Number of active leases.
	#[cfg(test)]
	pub(crate) lease_count: usize,
	/// Whether disk state is invalidated or a worker is running.
	#[cfg(test)]
	pub(crate) reloading:   bool,
}

/// Cloneable command endpoint for exactly one document actor.
#[derive(Clone)]
pub struct ActorHandle {
	document_id: DocumentId,
	sender:      flume::Sender<Command>,
}

impl ActorHandle {
	/// Returns the stable document identity routed by this handle.
	pub(crate) const fn document_id(&self) -> DocumentId {
		self.document_id
	}

	async fn open(&self, lease_id: LeaseId) -> Result<OpenedDocument> {
		let (reply, receive) = oneshot::channel();
		self.send(Command::Open { lease_id, reply }).await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	async fn read(
		&self,
		revision: Option<Revision>,
		selection: ReadSelection,
	) -> Result<ReadResult> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::Read { revision, selection, reply })
			.await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	async fn close(&self, lease_id: LeaseId) -> Result<()> {
		let (reply, receive) = oneshot::channel();
		self.send(Command::Close { lease_id, reply }).await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	fn cancel_open(&self, lease_id: LeaseId) {
		self.send_detached(Command::CancelOpen { lease_id });
	}

	fn release_retired_authority(&self, replacement: DocumentId, restored: bool) {
		self.send_detached(Command::RetiredAuthorityReleased { replacement, restored });
	}

	fn send_detached(&self, command: Command) {
		match self.sender.try_send(command) {
			Ok(()) | Err(flume::TrySendError::Disconnected(_)) => {},
			Err(flume::TrySendError::Full(command)) => {
				let sender = self.sender.clone();
				if let Ok(runtime) = runtime::Handle::try_current() {
					let _worker = runtime.spawn(async move {
						let _ = sender.send_async(command).await;
					});
				} else {
					let _worker = thread::spawn(move || {
						let _ = sender.send(command);
					});
				}
			},
		}
	}

	#[cfg(test)]
	async fn install_test_worker_gate(
		&self,
		kind: TestWorkerKind,
		gate: TestWorkerGate,
	) -> Result<()> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::InstallTestWorkerGate { kind, gate, reply })
			.await?;
		receive.await.map_err(|_| actor_unavailable())
	}

	#[cfg(test)]
	async fn force_next_move_watch_rebind_failure(&self) -> Result<()> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::ForceNextMoveWatchRebindFailure { reply })
			.await?;
		receive.await.map_err(|_| actor_unavailable())
	}

	#[cfg(test)]
	async fn inject_pending_watch_invalidation(&self) -> Result<()> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::InjectPendingWatchInvalidation { reply })
			.await?;
		receive.await.map_err(|_| actor_unavailable())
	}

	/// Returns immutable actor state serialized through the mailbox.
	pub(crate) async fn state(&self) -> Result<ActorStateSnapshot> {
		let (reply, receive) = oneshot::channel();
		self.send(Command::State { reply }).await?;
		receive.await.map_err(|_| actor_unavailable())
	}

	/// Waits for native invalidation reloads before returning immutable actor
	/// state.
	pub(crate) async fn ready_state(&self) -> Result<ActorStateSnapshot> {
		let (reply, receive) = oneshot::channel();
		self.send(Command::ReadyState { reply }).await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	/// Reserves `expected` at the current actor generation for `transaction_id`.
	pub(crate) async fn reserve(
		&self,
		transaction_id: TransactionId,
		expected: Revision,
	) -> Result<ReservedDocument> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::Reserve { transaction_id, expected, reply })
			.await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	/// Applies permissions through this actor after a mailbox-owned head check.
	pub(crate) async fn set_permissions(
		&self,
		expected: Revision,
		permissions: PortablePermissions,
		follow: FollowSymlinks,
	) -> Result<PathMetadata> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::SetPermissions { expected, permissions, follow, reply })
			.await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	/// Atomically authorizes and dispatches a prepared final replacement.
	///
	/// Generation and head validation happen in the same mailbox turn that marks
	/// persistence in flight; callers never receive a check-then-act grant.
	pub(crate) async fn commit_prepared(
		&self,
		reservation: DocumentReservation,
		prepared: PreparedWrite,
		metadata: CommittedSnapshotMetadata,
	) -> Result<DocumentHead> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::CommitPrepared { reservation, prepared, metadata, reply })
			.await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	/// Atomically authorizes and dispatches a prepared deletion.
	pub(crate) async fn commit_prepared_delete(
		&self,
		reservation: DocumentReservation,
		prepared: PreparedDelete,
	) -> Result<DocumentHead> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::CommitPreparedDelete { reservation, prepared, reply })
			.await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	/// Atomically commits a prepared move, registry claim, and native-watch
	/// rebind.
	pub(crate) async fn commit_prepared_move(
		&self,
		reservation: DocumentReservation,
		prepared: PreparedMove,
		path: PathReservation,
	) -> Result<DocumentHead> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::CommitPreparedMove {
				reservation,
				prepared: Box::new(prepared),
				path,
				reply,
			})
			.await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	/// Retires this actor only when it is inactive and matches the destination
	/// precondition.
	async fn retire_destination(
		&self,
		replacement: DocumentId,
		path: PathBuf,
		expectation: DestinationExpectation,
	) -> Result<PathReservation> {
		let (reply, receive) = oneshot::channel();
		self
			.send(Command::RetireDestination { replacement, path, expectation, reply })
			.await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	/// Releases a reservation without changing actor generation.
	pub(crate) async fn release(&self, reservation: DocumentReservation) -> Result<()> {
		let (reply, receive) = oneshot::channel();
		self.send(Command::Release { reservation, reply }).await?;
		receive.await.map_err(|_| actor_unavailable())?
	}

	async fn shutdown(&self) -> Result<()> {
		let (reply, receive) = oneshot::channel();
		self.send(Command::Shutdown { reply: Some(reply) }).await?;
		receive.await.map_err(|_| actor_unavailable())
	}

	async fn send(&self, command: Command) -> Result<()> {
		self
			.sender
			.send_async(command)
			.await
			.map_err(|_| actor_unavailable())
	}
}

fn spawn_actor(
	document_id: DocumentId,
	path: PathBuf,
	fs: LocalFs,
	revision_capacity: usize,
	registry: Weak<RegistryInner>,
) -> ActorHandle {
	let (sender, receiver) = flume::bounded(ACTOR_COMMAND_CAPACITY);
	let handle = ActorHandle { document_id, sender: sender.clone() };
	let actor =
		DocumentActor::new(document_id, path, fs, revision_capacity, registry, sender, receiver);
	tokio::spawn(actor.run());
	handle
}

type OpenReply = oneshot::Sender<Result<OpenedDocument>>;
type ReadReply = oneshot::Sender<Result<ReadResult>>;

type StateReply = oneshot::Sender<Result<ActorStateSnapshot>>;
type ReserveReply = oneshot::Sender<Result<ReservedDocument>>;
enum Command {
	Open {
		lease_id: LeaseId,
		reply:    OpenReply,
	},
	Read {
		revision:  Option<Revision>,
		selection: ReadSelection,
		reply:     ReadReply,
	},
	Close {
		lease_id: LeaseId,
		reply:    oneshot::Sender<Result<()>>,
	},
	CancelOpen {
		lease_id: LeaseId,
	},
	WatchEvent {
		event: FileWatchEvent,
		epoch: u64,
	},
	ActivationComplete(ActivationCompletion),
	SetPermissions {
		expected:    Revision,
		permissions: PortablePermissions,
		follow:      FollowSymlinks,
		reply:       oneshot::Sender<Result<PathMetadata>>,
	},
	PermissionComplete(PermissionCompletion),
	ReloadComplete(ReloadCompletion),
	CommitPrepared {
		reservation: DocumentReservation,
		prepared:    PreparedWrite,
		metadata:    CommittedSnapshotMetadata,
		reply:       oneshot::Sender<Result<DocumentHead>>,
	},
	CommitPreparedDelete {
		reservation: DocumentReservation,
		prepared:    PreparedDelete,
		reply:       oneshot::Sender<Result<DocumentHead>>,
	},
	CommitPreparedMove {
		reservation: DocumentReservation,
		prepared:    Box<PreparedMove>,
		path:        PathReservation,
		reply:       oneshot::Sender<Result<DocumentHead>>,
	},
	MoveComplete(MoveCompletion),
	CommitComplete(CommitCompletion),
	State {
		reply: oneshot::Sender<ActorStateSnapshot>,
	},
	ReadyState {
		reply: StateReply,
	},
	Reserve {
		transaction_id: TransactionId,
		expected:       Revision,
		reply:          ReserveReply,
	},
	RetireDestination {
		replacement: DocumentId,
		path:        PathBuf,
		expectation: DestinationExpectation,
		reply:       oneshot::Sender<Result<PathReservation>>,
	},
	RetiredAuthorityReleased {
		replacement: DocumentId,
		restored:    bool,
	},

	Release {
		reservation: DocumentReservation,
		reply:       oneshot::Sender<Result<()>>,
	},
	#[cfg(test)]
	InstallTestWorkerGate {
		kind:  TestWorkerKind,
		gate:  TestWorkerGate,
		reply: oneshot::Sender<()>,
	},
	#[cfg(test)]
	ForceNextMoveWatchRebindFailure {
		reply: oneshot::Sender<()>,
	},
	#[cfg(test)]
	InjectPendingWatchInvalidation {
		reply: oneshot::Sender<()>,
	},
	Shutdown {
		reply: Option<oneshot::Sender<()>>,
	},
}

struct ActivationCompletion {
	result:         Result<(ActiveFileWatch, DiskState)>,
	observed_epoch: Arc<AtomicU64>,
}

struct ReloadCompletion {
	epoch:  u64,
	result: Result<DiskState>,
}

struct PermissionCompletion {
	result: Result<(PathMetadata, DiskState)>,
	reply:  oneshot::Sender<Result<PathMetadata>>,
}
struct CommitCompletion {
	transaction_id: TransactionId,
	metadata:       CommittedSnapshotMetadata,
	result:         Result<DiskState>,
	reply:          oneshot::Sender<Result<DocumentHead>>,
}

struct MoveCompletion {
	transaction_id:    TransactionId,
	kind:              DocumentKind,
	old_path:          PathBuf,
	path:              PathReservation,
	watch:             ActiveFileWatch,
	rebind_generation: u64,
	result:            Result<(DiskState, Option<Error>)>,
	reply:             oneshot::Sender<Result<DocumentHead>>,
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum TestWorkerKind {
	Activation,
	Persist,
}

#[cfg(test)]
mod test_worker_gate {
	use std::sync::mpsc::Receiver;

	use tokio::sync::oneshot;

	pub(super) struct TestWorkerGate {
		started: oneshot::Sender<()>,
		release: Receiver<()>,
	}

	impl TestWorkerGate {
		pub(super) const fn new(started: oneshot::Sender<()>, release: Receiver<()>) -> Self {
			Self { started, release }
		}

		pub(super) fn wait(self) {
			let _ = self.started.send(());
			let _ = self.release.recv();
		}
	}
}

#[cfg(test)]
use test_worker_gate::TestWorkerGate;

#[derive(Clone, Copy, Debug, Default)]
struct ReloadCause {
	renamed:             bool,
	rescan:              bool,
	silent_if_unchanged: bool,
}

impl ReloadCause {
	const fn record(&mut self, kind: &FileWatchKind) {
		match kind {
			FileWatchKind::Changed | FileWatchKind::Removed => {},
			FileWatchKind::Renamed(_) => {
				self.renamed = true;
			},
			FileWatchKind::RescanRequired => self.rescan = true,
		}
	}
}

struct DocumentActor {
	document_id: DocumentId,
	path: PathBuf,
	fs: LocalFs,
	revision_capacity: usize,
	registry: Weak<RegistryInner>,
	sender: flume::Sender<Command>,
	receiver: Receiver<Command>,
	watch: Option<ActiveFileWatch>,
	watch_generation: u64,
	watch_invalidation_counter: Option<Arc<AtomicU64>>,
	watch_events_seen: u64,
	head: Option<Arc<DocumentSnapshot>>,
	history: VecDeque<Arc<DocumentSnapshot>>,
	fingerprint: Option<FileFingerprint>,
	leases: HashSet<LeaseId>,
	events: broadcast::Sender<DocumentEvent>,
	pending_opens: Vec<(LeaseId, OpenReply)>,
	queued_opens: Vec<(LeaseId, OpenReply)>,
	queued_reads: Vec<(Option<Revision>, ReadSelection, ReadReply)>,
	queued_states: Vec<StateReply>,
	queued_reserves: Vec<(TransactionId, Revision, ReserveReply)>,
	activation_in_flight: bool,
	reload_in_flight: bool,
	persist_in_flight: bool,
	invalidated: bool,
	reload_epoch: u64,
	reload_cause: ReloadCause,
	event_sequence: u64,
	generation: ActorGeneration,
	reservations: HashMap<TransactionId, ActorGeneration>,
	pending_invalidated_transactions: Vec<TransactionId>,
	retired_for: Option<DocumentId>,
	idle_deadline: Option<Instant>,
	shutdown_requested: bool,
	shutdown_replies: Vec<oneshot::Sender<()>>,
	#[cfg(test)]
	test_next_activation_gate: Option<TestWorkerGate>,
	#[cfg(test)]
	test_next_persist_gate: Option<TestWorkerGate>,
	#[cfg(test)]
	test_fail_next_move_watch_rebind: bool,
}

impl DocumentActor {
	fn new(
		document_id: DocumentId,
		path: PathBuf,
		fs: LocalFs,
		revision_capacity: usize,
		registry: Weak<RegistryInner>,
		sender: flume::Sender<Command>,
		receiver: Receiver<Command>,
	) -> Self {
		Self {
			document_id,
			path,
			fs,
			revision_capacity,
			registry,
			sender,
			receiver,
			watch: None,
			watch_generation: INITIAL_WATCH_GENERATION,
			watch_invalidation_counter: None,
			watch_events_seen: 0,
			head: None,
			history: VecDeque::new(),
			fingerprint: None,
			leases: HashSet::new(),
			events: broadcast::channel(DOCUMENT_EVENT_CAPACITY).0,
			pending_opens: Vec::new(),
			queued_opens: Vec::new(),
			queued_reads: Vec::new(),
			queued_states: Vec::new(),
			queued_reserves: Vec::new(),
			activation_in_flight: false,
			reload_in_flight: false,
			persist_in_flight: false,
			invalidated: false,
			reload_epoch: 0,
			reload_cause: ReloadCause::default(),
			event_sequence: 0,
			pending_invalidated_transactions: Vec::new(),
			generation: ActorGeneration(0),
			reservations: HashMap::new(),
			retired_for: None,
			idle_deadline: None,
			shutdown_requested: false,
			shutdown_replies: Vec::new(),
			#[cfg(test)]
			test_next_activation_gate: None,
			#[cfg(test)]
			test_next_persist_gate: None,
			#[cfg(test)]
			test_fail_next_move_watch_rebind: false,
		}
	}

	async fn run(mut self) {
		loop {
			let command = if let Some(deadline) = self.idle_deadline {
				match time::timeout_at(deadline, self.receiver.recv_async()).await {
					Ok(Ok(command)) => command,
					Ok(Err(_)) => break,
					Err(_) if self.background_in_flight() => {
						self.idle_deadline = Some(Instant::now() + IDLE_EVICTION_DELAY);
						continue;
					},
					Err(_) => break,
				}
			} else {
				match self.receiver.recv_async().await {
					Ok(command) => command,
					Err(_) => break,
				}
			};

			if self.handle(command) {
				break;
			}
			if self.shutdown_requested && !self.background_in_flight() {
				break;
			}
		}

		self.watch.take();
		if let Some(registry) = self.registry.upgrade() {
			registry.actor_exited(self.document_id);
		}
		for reply in self.shutdown_replies.drain(..) {
			let _ = reply.send(());
		}
	}

	fn handle(&mut self, command: Command) -> bool {
		if self.shutdown_requested {
			self.handle_during_shutdown(command);
			return false;
		}
		match command {
			Command::Open { lease_id, reply } => self.handle_open(lease_id, reply),
			Command::Read { revision, selection, reply } => {
				self.handle_read(revision, selection, reply);
			},
			Command::Close { lease_id, reply } => self.handle_close(lease_id, reply),
			Command::CancelOpen { lease_id } => self.cancel_pending_open(lease_id),
			Command::WatchEvent { event, epoch } => self.handle_watch(event, epoch),
			Command::ActivationComplete(completion) => self.finish_activation(completion),
			Command::ReloadComplete(completion) => self.finish_reload(completion),
			Command::SetPermissions { expected, permissions, follow, reply } => {
				self.start_set_permissions(expected, permissions, follow, reply);
			},
			Command::PermissionComplete(completion) => self.finish_set_permissions(completion),
			Command::CommitPrepared { reservation, prepared, metadata, reply } => {
				self.start_commit(reservation, prepared, metadata, reply);
			},
			Command::CommitPreparedDelete { reservation, prepared, reply } => {
				self.start_delete(reservation, prepared, reply);
			},
			Command::CommitPreparedMove { reservation, prepared, path, reply } => {
				self.start_move(reservation, *prepared, path, reply);
			},
			Command::MoveComplete(completion) => self.finish_move(completion),
			Command::CommitComplete(completion) => self.finish_commit(completion),
			Command::State { reply } => {
				let _ = reply.send(self.state_snapshot());
			},
			Command::ReadyState { reply } => self.handle_ready_state(reply),
			Command::Reserve { transaction_id, expected, reply } => {
				self.handle_reserve(transaction_id, expected, reply);
			},
			Command::RetireDestination { replacement, path, expectation, reply } => {
				let result = self.retire_destination(replacement, &path, expectation);
				let _ = reply.send(result);
			},
			Command::RetiredAuthorityReleased { replacement, restored } => {
				if self.retired_for == Some(replacement) {
					self.retired_for = None;
					if restored {
						self.schedule_idle_eviction();
					} else {
						return true;
					}
				}
			},

			Command::Release { reservation, reply } => {
				let result = self.release(reservation);
				let _ = reply.send(result);
			},
			#[cfg(test)]
			Command::InstallTestWorkerGate { kind, gate, reply } => {
				match kind {
					TestWorkerKind::Activation => self.test_next_activation_gate = Some(gate),
					TestWorkerKind::Persist => self.test_next_persist_gate = Some(gate),
				}
				let _ = reply.send(());
			},
			#[cfg(test)]
			Command::ForceNextMoveWatchRebindFailure { reply } => {
				self.test_fail_next_move_watch_rebind = true;
				let _ = reply.send(());
			},
			#[cfg(test)]
			Command::InjectPendingWatchInvalidation { reply } => {
				self
					.watch_invalidation_counter
					.as_ref()
					.expect("activated actor has a watch invalidation counter")
					.fetch_add(1, Ordering::SeqCst);
				let _ = reply.send(());
			},
			Command::Shutdown { reply } => {
				self.sync_pending_watch_callbacks();
				self.shutdown_requested = true;
				if let Some(reply) = reply {
					self.shutdown_replies.push(reply);
				}
			},
		}
		false
	}

	fn handle_during_shutdown(&mut self, command: Command) {
		match command {
			Command::ActivationComplete(completion) => self.finish_activation(completion),
			Command::ReloadComplete(completion) => self.finish_reload(completion),
			Command::PermissionComplete(completion) => self.finish_set_permissions(completion),
			Command::MoveComplete(completion) => self.finish_move(completion),
			Command::CommitComplete(completion) => self.finish_commit(completion),
			Command::CancelOpen { lease_id } => self.cancel_pending_open(lease_id),
			Command::Shutdown { reply: Some(reply) } => self.shutdown_replies.push(reply),
			_ => {},
		}
	}

	fn cancel_pending_open(&mut self, lease_id: LeaseId) {
		self
			.pending_opens
			.retain(|(pending, _)| *pending != lease_id);
		self
			.queued_opens
			.retain(|(pending, _)| *pending != lease_id);
		self.leases.remove(&lease_id);
		self.schedule_idle_eviction();
	}

	fn schedule_idle_eviction(&mut self) {
		if self.retired_for.is_none()
			&& self.leases.is_empty()
			&& self.reservations.is_empty()
			&& self.pending_opens.is_empty()
			&& self.queued_opens.is_empty()
			&& self.queued_reads.is_empty()
			&& self.queued_states.is_empty()
			&& self.queued_reserves.is_empty()
		{
			self.idle_deadline = Some(Instant::now() + IDLE_EVICTION_DELAY);
		}
	}

	fn handle_open(&mut self, lease_id: LeaseId, reply: OpenReply) {
		self.sync_pending_watch_callbacks();
		self.idle_deadline = None;
		if self.head.is_none() {
			self.pending_opens.push((lease_id, reply));
			if !self.activation_in_flight {
				self.start_activation();
			}
		} else if self.reads_are_queued() {
			self.queued_opens.push((lease_id, reply));
			self.ensure_reload();
		} else {
			self.complete_open(lease_id, reply);
		}
	}

	fn handle_read(
		&mut self,
		revision: Option<Revision>,
		selection: ReadSelection,
		reply: ReadReply,
	) {
		self.sync_pending_watch_callbacks();
		self.idle_deadline = None;
		if self.head.is_none() || self.reads_are_queued() {
			self.queued_reads.push((revision, selection, reply));
			self.ensure_reload();
			return;
		}
		let result = self.read_snapshot(revision, selection);
		let _ = reply.send(result);
	}

	fn handle_ready_state(&mut self, reply: StateReply) {
		self.sync_pending_watch_callbacks();
		self.idle_deadline = None;
		if self.head.is_none() {
			let _ = reply.send(Err(Error::DocumentNotFound { document_id: self.document_id }));
		} else if self.reads_are_queued() {
			self.queued_states.push(reply);
			self.ensure_reload();
		} else {
			let _ = reply.send(Ok(self.state_snapshot()));
		}
	}

	fn handle_close(&mut self, lease_id: LeaseId, reply: oneshot::Sender<Result<()>>) {
		let result = if self.leases.remove(&lease_id) {
			self.schedule_idle_eviction();
			Ok(())
		} else {
			Err(Error::LeaseExpired { lease_id })
		};
		let _ = reply.send(result);
	}

	fn handle_watch(&mut self, event: FileWatchEvent, epoch: u64) {
		if event.generation != self.watch_generation {
			return;
		}
		if epoch > self.watch_events_seen {
			let delta = epoch - self.watch_events_seen;
			self.watch_events_seen = epoch;
			self.reload_epoch = self
				.reload_epoch
				.checked_add(delta)
				.expect("reload generation exhausted");
			self.invalidated = true;
			self.invalidate_generation();
		}
		self.reload_cause.record(&event.kind);
		if self.head.is_some()
			&& self.invalidated
			&& !self.reload_in_flight
			&& !self.persist_in_flight
		{
			self.start_reload();
		}
	}

	fn start_activation(&mut self) {
		self.activation_in_flight = true;
		self.watch_invalidation_counter = None;
		self.watch_events_seen = 0;
		let path = self.path.clone();
		let fs = self.fs.clone();
		let sender = self.sender.clone();
		let watch_sender = self.sender.clone();
		let generation = self.watch_generation;
		let observed_epoch = Arc::new(AtomicU64::new(0));
		let callback_epoch = Arc::clone(&observed_epoch);
		let completion_epoch = Arc::clone(&observed_epoch);
		#[cfg(test)]
		let test_gate = self.test_next_activation_gate.take();
		let _worker = task::spawn_blocking(move || {
			#[cfg(test)]
			if let Some(gate) = test_gate {
				gate.wait();
			}
			let result = ActiveFileWatch::new(&path, generation, move |event| {
				let epoch = callback_epoch.fetch_add(1, Ordering::SeqCst) + 1;
				let _ = watch_sender.send(Command::WatchEvent { event, epoch });
			})
			.map_err(|source| Error::Watch { path: path.clone(), source })
			.and_then(|watch| fs.stable_read(&path).map(|disk| (watch, disk)));
			let _ = sender.send(Command::ActivationComplete(ActivationCompletion {
				result,
				observed_epoch: completion_epoch,
			}));
		});
	}

	fn finish_activation(&mut self, completion: ActivationCompletion) {
		self.activation_in_flight = false;
		let ActivationCompletion { result, observed_epoch } = completion;
		self.watch_invalidation_counter = Some(observed_epoch);
		self.sync_pending_watch_callbacks();
		match result {
			Ok((watch, disk)) => {
				self.watch = Some(watch);
				if self.invalidated {
					self.start_reload();
				} else if self.install_initial(disk).is_ok() {
					let pending = mem::take(&mut self.pending_opens);
					for (lease_id, reply) in pending {
						self.complete_open(lease_id, reply);
					}
					self.flush_queued();
				} else {
					self.fail_activation();
				}
			},
			Err(_) if self.invalidated => {
				self.watch_generation = self
					.watch_generation
					.checked_add(1)
					.expect("watch generation exhausted");
				self.start_activation();
			},
			Err(_) => self.fail_activation(),
		}
	}

	fn fail_activation(&mut self) {
		let path = self.path.clone();
		for (_, reply) in self.pending_opens.drain(..) {
			let _ = reply.send(Err(Error::ExternalInvalidation { path: path.clone() }));
		}
		for (_, _, reply) in self.queued_reads.drain(..) {
			let _ = reply.send(Err(Error::ExternalInvalidation { path: path.clone() }));
		}
		self.idle_deadline = Some(Instant::now());
	}

	fn ensure_reload(&mut self) {
		if self.head.is_some()
			&& self.invalidated
			&& !self.reload_in_flight
			&& !self.persist_in_flight
		{
			self.start_reload();
		}
	}

	fn start_reload(&mut self) {
		self.reload_in_flight = true;
		let epoch = self.reload_epoch;
		let path = self.path.clone();
		let fs = self.fs.clone();
		let sender = self.sender.clone();
		let _worker = task::spawn_blocking(move || {
			let result = fs.stable_read(&path);
			let _ = sender.send(Command::ReloadComplete(ReloadCompletion { epoch, result }));
		});
	}

	fn finish_reload(&mut self, completion: ReloadCompletion) {
		self.reload_in_flight = false;
		self.sync_pending_watch_callbacks();
		if completion.epoch != self.reload_epoch {
			if !self.reload_in_flight {
				self.start_reload();
			}
			return;
		}
		if let Ok(disk) = completion.result {
			let cause = mem::take(&mut self.reload_cause);
			self.invalidated = false;
			if self.head.is_none() {
				if self.install_initial(disk).is_err() {
					self.fail_activation();
					return;
				}
				let pending = mem::take(&mut self.pending_opens);
				for (lease_id, reply) in pending {
					self.complete_open(lease_id, reply);
				}
			} else if self.install_external(disk, cause).is_err() {
				self.invalidated = true;
				self.fail_queued_reads();
				return;
			}
			self.flush_queued();
		} else {
			self.invalidated = true;
			self.fail_queued_reads();
		}
	}

	fn start_set_permissions(
		&mut self,
		expected: Revision,
		permissions: PortablePermissions,
		follow: FollowSymlinks,
		reply: oneshot::Sender<Result<PathMetadata>>,
	) {
		self.sync_pending_watch_callbacks();
		let Some(current) = self.head.as_ref() else {
			let _ = reply.send(Err(Error::DocumentNotFound { document_id: self.document_id }));
			return;
		};
		if current.head().revision() != expected {
			let _ = reply
				.send(Err(Error::ContentModified { expected, current: current.head().revision() }));
			return;
		}
		if current.head().presence() != DocumentPresence::Present {
			let _ = reply.send(Err(Error::InvalidTarget {
				target: Str::new(self.path.to_string_lossy()),
				reason: sf!("cannot set permissions on a missing document"),
			}));
			return;
		}
		if self.reads_are_queued() || self.activation_in_flight {
			let _ = reply.send(Err(Error::ExternalInvalidation { path: self.path.clone() }));
			return;
		}

		let disk_expectation = DiskExpectation::Present(
			self
				.fingerprint
				.clone()
				.expect("present cached head has an exact disk fingerprint"),
		);
		self.persist_in_flight = true;
		self.invalidated = true;
		self.invalidate_generation();
		let fs = self.fs.clone();
		let path = self.path.clone();
		let sender = self.sender.clone();
		#[cfg(test)]
		let test_gate = self.test_next_persist_gate.take();
		let _worker = task::spawn_blocking(move || {
			#[cfg(test)]
			if let Some(gate) = test_gate {
				gate.wait();
			}
			let result = fs
				.set_permissions_if(&path, disk_expectation, permissions, follow)
				.and_then(|metadata| fs.stable_read(&path).map(|disk| (metadata, disk)));
			let _ = sender.send(Command::PermissionComplete(PermissionCompletion { result, reply }));
		});
	}

	fn finish_set_permissions(&mut self, completion: PermissionCompletion) {
		self.sync_pending_watch_callbacks();
		self.persist_in_flight = false;
		match completion.result {
			Ok((metadata, disk)) => {
				if let (Some(current), DiskState::Present { content, fingerprint }) =
					(self.head.as_ref(), &disk)
					&& current.content() == content
				{
					self.fingerprint = Some(fingerprint.clone());
				}
				let _ = completion.reply.send(Ok(metadata));
			},
			Err(error) => {
				let _ = completion.reply.send(Err(error));
			},
		}
		self.invalidated = true;
		self.reload_epoch = self.reload_epoch.saturating_add(1);
		self.reload_cause.rescan = true;
		self.reload_cause.silent_if_unchanged = true;
		self.start_reload();
	}

	fn install_initial(&mut self, disk: DiskState) -> Result<()> {
		let (snapshot, fingerprint) = snapshot_from_disk(self.document_id, 1, disk, None)?;
		self.fingerprint = fingerprint;
		self.push_snapshot(snapshot);
		Ok(())
	}

	fn install_external(&mut self, disk: DiskState, cause: ReloadCause) -> Result<()> {
		let current = Arc::clone(self.head.as_ref().expect("external reload requires a head"));
		let disk_unchanged =
			disk_matches_head(&disk, current.head().presence(), self.fingerprint.as_ref());
		if disk_unchanged {
			if cause.rescan && !cause.silent_if_unchanged {
				self.publish_event(
					DocumentEventKind::WatchRescanned,
					current.head().clone(),
					current.head().revision(),
					None,
					None,
				);
			} else {
				self.pending_invalidated_transactions.clear();
			}
			return Ok(());
		}

		let previous_presence = current.head().presence();
		let previous_revision = current.head().revision();
		let sequence =
			previous_revision
				.sequence()
				.checked_add(1)
				.ok_or_else(|| Error::InvalidContent {
					reason: sf!("document revision sequence exhausted"),
				})?;
		let (snapshot, fingerprint) = snapshot_from_disk(self.document_id, sequence, disk, None)?;
		let presence = snapshot.head().presence();
		let kind = if cause.rescan {
			DocumentEventKind::WatchRescanned
		} else if cause.renamed && presence == DocumentPresence::Missing {
			DocumentEventKind::ExternalRenamed
		} else if previous_presence == DocumentPresence::Missing
			&& presence == DocumentPresence::Present
		{
			DocumentEventKind::ExternalCreated
		} else if presence == DocumentPresence::Missing {
			DocumentEventKind::ExternalDeleted
		} else {
			DocumentEventKind::ExternalModified
		};
		let head = snapshot.head().clone();
		self.fingerprint = fingerprint;
		self.push_snapshot(snapshot);
		self.publish_event(kind, head, previous_revision, None, None);
		Ok(())
	}

	fn push_snapshot(&mut self, snapshot: Arc<DocumentSnapshot>) {
		self.head = Some(Arc::clone(&snapshot));
		self.history.push_back(snapshot);
		while self.history.len() > self.revision_capacity {
			self.history.pop_front();
		}
	}

	fn publish_event(
		&mut self,
		kind: DocumentEventKind,
		head: DocumentHead,
		previous_revision: Revision,
		transaction_id: Option<TransactionId>,
		previous_path: Option<PathBuf>,
	) {
		self.event_sequence = self
			.event_sequence
			.checked_add(1)
			.expect("document event sequence exhausted");
		self.pending_invalidated_transactions.sort_unstable();
		self.pending_invalidated_transactions.dedup();
		let event = DocumentEvent {
			event_sequence: self.event_sequence,
			kind,
			head,
			path: self.path.clone(),
			previous_revision,
			transaction_id,
			invalidated_transaction_ids: mem::take(&mut self.pending_invalidated_transactions),
			previous_path,
		};
		let _ = self.events.send(event);
	}

	fn complete_open(&mut self, lease_id: LeaseId, reply: OpenReply) {
		let head = self
			.head
			.as_ref()
			.expect("completed activation has a head")
			.head()
			.clone();
		let receiver = self.events.subscribe();
		self.leases.insert(lease_id);
		if reply
			.send(Ok(OpenedDocument::new(lease_id, head, receiver)))
			.is_ok()
		{
			self.idle_deadline = None;
		} else {
			self.leases.remove(&lease_id);
			if let Some(registry) = self.registry.upgrade() {
				registry.remove_lease(lease_id);
			}
			self.schedule_idle_eviction();
		}
	}

	fn flush_queued(&mut self) {
		if self.shutdown_requested {
			self.fail_queued_reads();
			return;
		}
		let states = mem::take(&mut self.queued_states);
		for reply in states {
			self.handle_ready_state(reply);
		}
		let opens = mem::take(&mut self.queued_opens);
		for (lease_id, reply) in opens {
			self.complete_open(lease_id, reply);
		}
		let reads = mem::take(&mut self.queued_reads);
		for (revision, selection, reply) in reads {
			let result = self.read_snapshot(revision, selection);
			let _ = reply.send(result);
		}
		let reserves = mem::take(&mut self.queued_reserves);
		for (transaction_id, expected, reply) in reserves {
			self.handle_reserve(transaction_id, expected, reply);
		}
	}

	fn fail_queued_reads(&mut self) {
		let path = self.path.clone();
		for (_, _, reply) in self.queued_reads.drain(..) {
			let _ = reply.send(Err(Error::ExternalInvalidation { path: path.clone() }));
		}
		for (_, reply) in self.queued_opens.drain(..) {
			let _ = reply.send(Err(Error::ExternalInvalidation { path: path.clone() }));
		}
		for reply in self.queued_states.drain(..) {
			let _ = reply.send(Err(Error::ExternalInvalidation { path: path.clone() }));
		}
		for (_, _, reply) in self.queued_reserves.drain(..) {
			let _ = reply.send(Err(Error::ExternalInvalidation { path: path.clone() }));
		}
	}

	fn read_snapshot(
		&self,
		revision: Option<Revision>,
		selection: ReadSelection,
	) -> Result<ReadResult> {
		let snapshot = self.select_snapshot(revision)?;
		let body = select_content(snapshot.content(), selection)?;
		Ok(ReadResult { head: snapshot.head().clone(), body })
	}

	fn select_snapshot(&self, revision: Option<Revision>) -> Result<&Arc<DocumentSnapshot>> {
		let current = self
			.head
			.as_ref()
			.ok_or(Error::DocumentNotFound { document_id: self.document_id })?;
		let Some(revision) = revision else {
			return Ok(current);
		};
		if current.head().revision() == revision {
			return Ok(current);
		}
		if let Some(snapshot) = self
			.history
			.iter()
			.find(|snapshot| snapshot.head().revision() == revision)
		{
			return Ok(snapshot);
		}
		let oldest = self.history.front().map_or_else(
			|| current.head().revision().sequence(),
			|snapshot| snapshot.head().revision().sequence(),
		);
		if revision.sequence() < oldest {
			Err(Error::RevisionExpired { document_id: self.document_id, revision })
		} else {
			Err(Error::RevisionMissing { document_id: self.document_id, revision })
		}
	}

	const fn reads_are_queued(&self) -> bool {
		self.invalidated || self.reload_in_flight || self.persist_in_flight
	}

	const fn background_in_flight(&self) -> bool {
		self.activation_in_flight || self.reload_in_flight || self.persist_in_flight
	}

	fn invalidate_generation(&mut self) {
		self.generation.0 = self
			.generation
			.0
			.checked_add(1)
			.expect("actor generation exhausted");
		self
			.pending_invalidated_transactions
			.extend(self.reservations.keys().copied());
		self.reservations.clear();
	}

	fn sync_pending_watch_callbacks(&mut self) {
		let Some(counter) = self.watch_invalidation_counter.as_ref() else {
			return;
		};
		let observed = counter.load(Ordering::SeqCst);
		if observed <= self.watch_events_seen {
			return;
		}
		let delta = observed - self.watch_events_seen;
		self.watch_events_seen = observed;
		self.reload_epoch = self
			.reload_epoch
			.checked_add(delta)
			.expect("reload generation exhausted");
		self.reload_cause.rescan = true;
		self.invalidated = true;
		self.invalidate_generation();
		if self.head.is_some() && !self.reload_in_flight && !self.persist_in_flight {
			self.start_reload();
		}
	}

	fn state_snapshot(&self) -> ActorStateSnapshot {
		ActorStateSnapshot {
			document_id:              self.document_id,
			path:                     self.path.clone(),
			head:                     self.head.clone(),
			#[cfg(test)]
			lease_count:              self.leases.len(),
			#[cfg(test)]
			reloading:                self.reads_are_queued(),
		}
	}

	fn handle_reserve(
		&mut self,
		transaction_id: TransactionId,
		expected: Revision,
		reply: ReserveReply,
	) {
		self.sync_pending_watch_callbacks();
		self.idle_deadline = None;
		if self.head.is_some() && self.reads_are_queued() {
			self.queued_reserves.push((transaction_id, expected, reply));
			self.ensure_reload();
			return;
		}
		let _ = reply.send(self.reserve(transaction_id, expected));
	}

	fn reserve(
		&mut self,
		transaction_id: TransactionId,
		expected: Revision,
	) -> Result<ReservedDocument> {
		let snapshot = Arc::clone(
			self
				.head
				.as_ref()
				.ok_or(Error::DocumentNotFound { document_id: self.document_id })?,
		);
		let current = snapshot.head().revision();
		if current != expected {
			return Err(Error::StaleTransaction { transaction_id, expected, current });
		}
		let generation = self
			.reservations
			.get(&transaction_id)
			.copied()
			.unwrap_or_else(|| {
				self.reservations.insert(transaction_id, self.generation);
				self.generation
			});
		let reservation = DocumentReservation {
			document_id: self.document_id,
			transaction_id,
			generation,
			base_revision: expected,
		};
		let disk_expectation = match snapshot.head().presence() {
			DocumentPresence::Present => DiskExpectation::Present(
				self
					.fingerprint
					.clone()
					.expect("present cached head has an exact disk fingerprint"),
			),
			DocumentPresence::Missing => DiskExpectation::Missing,
		};

		Ok(ReservedDocument { reservation, path: self.path.clone(), snapshot, disk_expectation })
	}

	fn retire_destination(
		&mut self,
		replacement: DocumentId,
		path: &Path,
		expectation: DestinationExpectation,
	) -> Result<PathReservation> {
		self.sync_pending_watch_callbacks();
		let snapshot = self
			.head
			.as_ref()
			.ok_or(Error::DocumentNotFound { document_id: self.document_id })?;
		if self.path != path
			|| !expectation.matches(snapshot)
			|| !self.leases.is_empty()
			|| self.background_in_flight()
			|| self.invalidated
			|| !self.reservations.is_empty()
			|| self.retired_for.is_some()
		{
			return Err(Error::InvalidTarget {
				target: Str::new(path.to_string_lossy()),
				reason: sf!("move destination is active or does not match its precondition",),
			});
		}
		let registry = self.registry.upgrade().ok_or_else(actor_unavailable)?;
		let reservation = registry.retire_and_reserve_path(self.document_id, replacement, path)?;
		self.retired_for = Some(replacement);
		self.idle_deadline = None;
		Ok(reservation)
	}

	fn validate(&self, reservation: DocumentReservation) -> Result<()> {
		let current = self
			.head
			.as_ref()
			.ok_or(Error::DocumentNotFound { document_id: self.document_id })?
			.head()
			.revision();
		if reservation.document_id != self.document_id
			|| reservation.generation != self.generation
			|| reservation.base_revision != current
			|| self.reservations.get(&reservation.transaction_id) != Some(&self.generation)
		{
			return Err(Error::StaleTransaction {
				transaction_id: reservation.transaction_id,
				expected: reservation.base_revision,
				current,
			});
		}
		Ok(())
	}

	fn release(&mut self, reservation: DocumentReservation) -> Result<()> {
		self.sync_pending_watch_callbacks();
		self.validate(reservation)?;
		self.reservations.remove(&reservation.transaction_id);
		self.schedule_idle_eviction();
		Ok(())
	}

	fn start_commit(
		&mut self,
		reservation: DocumentReservation,
		prepared: PreparedWrite,
		metadata: CommittedSnapshotMetadata,
		reply: oneshot::Sender<Result<DocumentHead>>,
	) {
		self.sync_pending_watch_callbacks();
		if let Err(error) = self.validate(reservation) {
			let _ = reply.send(Err(error));
			return;
		}

		if self.activation_in_flight || self.reload_in_flight || self.persist_in_flight {
			let current = self
				.head
				.as_ref()
				.expect("a reserved actor has a head")
				.head()
				.revision();
			let _ = reply.send(Err(Error::StaleTransaction {
				transaction_id: reservation.transaction_id,
				expected: reservation.base_revision,
				current,
			}));
			return;
		}

		self.reservations.remove(&reservation.transaction_id);
		self.persist_in_flight = true;
		self.invalidate_generation();
		let fs = self.fs.clone();
		let sender = self.sender.clone();
		let transaction_id = reservation.transaction_id;
		let _worker = task::spawn_blocking(move || {
			let result = fs.commit_prepared(prepared);
			let _ = sender.send(Command::CommitComplete(CommitCompletion {
				transaction_id,
				metadata,
				result,
				reply,
			}));
		});
	}

	fn start_delete(
		&mut self,
		reservation: DocumentReservation,
		prepared: PreparedDelete,
		reply: oneshot::Sender<Result<DocumentHead>>,
	) {
		self.sync_pending_watch_callbacks();
		if let Err(error) = self.validate(reservation) {
			let _ = reply.send(Err(error));
			return;
		}
		if self.background_in_flight() {
			let current = self
				.head
				.as_ref()
				.expect("a reserved actor has a head")
				.head()
				.revision();
			let _ = reply.send(Err(Error::StaleTransaction {
				transaction_id: reservation.transaction_id,
				expected: reservation.base_revision,
				current,
			}));
			return;
		}
		let kind = self
			.head
			.as_ref()
			.expect("a reserved actor has a head")
			.head()
			.kind()
			.clone();
		self.reservations.remove(&reservation.transaction_id);
		self.persist_in_flight = true;
		self.invalidate_generation();
		let fs = self.fs.clone();
		let sender = self.sender.clone();
		let transaction_id = reservation.transaction_id;
		let _worker = task::spawn_blocking(move || {
			let result = fs.commit_prepared_delete(prepared);
			let _ = sender.send(Command::CommitComplete(CommitCompletion {
				transaction_id,
				metadata: CommittedSnapshotMetadata { kind },
				result,
				reply,
			}));
		});
	}

	fn start_move(
		&mut self,
		reservation: DocumentReservation,
		prepared: PreparedMove,
		path: PathReservation,
		reply: oneshot::Sender<Result<DocumentHead>>,
	) {
		self.sync_pending_watch_callbacks();
		if let Err(error) = self.validate(reservation) {
			let _ = reply.send(Err(error));
			return;
		}
		if self.background_in_flight() {
			let current = self
				.head
				.as_ref()
				.expect("a reserved actor has a head")
				.head()
				.revision();
			let _ = reply.send(Err(Error::StaleTransaction {
				transaction_id: reservation.transaction_id,
				expected: reservation.base_revision,
				current,
			}));
			return;
		}
		let Some(mut watch) = self.watch.take() else {
			let _ = reply.send(Err(actor_unavailable()));
			return;
		};
		let kind = self
			.head
			.as_ref()
			.expect("a reserved actor has a head")
			.head()
			.kind()
			.clone();
		let old_path = self.path.clone();
		let destination = path.path().to_path_buf();
		let generation = self
			.watch_generation
			.checked_add(1)
			.expect("watch generation exhausted");
		self.reservations.remove(&reservation.transaction_id);
		self.persist_in_flight = true;
		self.invalidate_generation();
		let fs = self.fs.clone();
		let sender = self.sender.clone();
		let transaction_id = reservation.transaction_id;
		#[cfg(test)]
		let fail_watch_rebind = mem::take(&mut self.test_fail_next_move_watch_rebind);
		let _worker = task::spawn_blocking(move || {
			let result = fs.commit_prepared_move(prepared).map(|disk| {
				#[cfg(test)]
				let watch_error = if fail_watch_rebind {
					Some(Error::Watch {
						path:   destination.clone(),
						source: notify::Error::generic("forced move watch rebind failure"),
					})
				} else {
					watch
						.rebind(&destination, generation)
						.err()
						.map(|source| Error::Watch { path: destination.clone(), source })
				};
				#[cfg(not(test))]
				let watch_error = watch
					.rebind(&destination, generation)
					.err()
					.map(|source| Error::Watch { path: destination, source });
				(disk, watch_error)
			});
			let _ = sender.send(Command::MoveComplete(MoveCompletion {
				transaction_id,
				kind,
				old_path,
				path,
				watch,
				rebind_generation: generation,
				result,
				reply,
			}));
		});
	}

	fn finish_move(&mut self, completion: MoveCompletion) {
		self.sync_pending_watch_callbacks();
		self.persist_in_flight = false;
		let MoveCompletion {
			transaction_id,
			kind,
			old_path,
			path,
			watch,
			rebind_generation,
			result,
			reply,
		} = completion;
		match result {
			Ok((disk, watch_error)) => {
				if watch_error.is_some() {
					drop(watch);
					self.watch = None;
					self.watch_generation = rebind_generation;
				} else {
					self.watch_generation = watch.generation();
					self.watch = Some(watch);
				}
				match path.commit(&old_path) {
					Ok(new_path) => {
						self.path = new_path;
						let result = self.install_committed(
							disk,
							CommittedSnapshotMetadata { kind },
							transaction_id,
							Some(old_path),
						);
						let _ = reply.send(result);
					},
					Err(error) => {
						let _ = reply.send(Err(error));
					},
				}
			},
			Err(error) => {
				self.watch = Some(watch);
				let _ = reply.send(Err(error));
			},
		}
		self.invalidated = true;
		self.reload_epoch = self.reload_epoch.saturating_add(1);
		self.reload_cause.rescan = true;
		self.reload_cause.silent_if_unchanged = true;
		if self.watch.is_some() {
			self.start_reload();
		} else {
			self.start_activation();
		}
	}

	fn finish_commit(&mut self, completion: CommitCompletion) {
		self.sync_pending_watch_callbacks();
		self.persist_in_flight = false;
		match completion.result {
			Ok(disk) => {
				let result =
					self.install_committed(disk, completion.metadata, completion.transaction_id, None);
				match result {
					Ok(head) => {
						let _ = completion.reply.send(Ok(head));
					},
					Err(error) => {
						let _ = completion.reply.send(Err(error));
					},
				}
			},
			Err(error) => {
				let _ = completion.reply.send(Err(error));
			},
		}
		self.invalidated = true;
		self.reload_epoch = self.reload_epoch.saturating_add(1);
		self.reload_cause.rescan = true;
		self.reload_cause.silent_if_unchanged = true;
		self.start_reload();
	}

	fn install_committed(
		&mut self,
		disk: DiskState,
		metadata: CommittedSnapshotMetadata,
		transaction_id: TransactionId,
		previous_path: Option<PathBuf>,
	) -> Result<DocumentHead> {
		let current = Arc::clone(
			self
				.head
				.as_ref()
				.ok_or(Error::DocumentNotFound { document_id: self.document_id })?,
		);
		let previous_revision = current.head().revision();
		let sequence =
			previous_revision
				.sequence()
				.checked_add(1)
				.ok_or_else(|| Error::InvalidContent {
					reason: sf!("document revision sequence exhausted"),
				})?;
		let (snapshot, fingerprint) =
			snapshot_from_disk(self.document_id, sequence, disk, Some(metadata.kind))?;
		let head = snapshot.head().clone();
		self.fingerprint = fingerprint;
		self.push_snapshot(snapshot);
		self.publish_event(
			DocumentEventKind::Committed,
			head.clone(),
			previous_revision,
			Some(transaction_id),
			previous_path,
		);
		Ok(head)
	}
}

fn snapshot_from_disk(
	document_id: DocumentId,
	sequence: u64,
	disk: DiskState,
	kind: Option<DocumentKind>,
) -> Result<(Arc<DocumentSnapshot>, Option<FileFingerprint>)> {
	let (content, fingerprint, presence) = match disk {
		DiskState::Present { content, fingerprint } => {
			(content, Some(fingerprint), DocumentPresence::Present)
		},
		DiskState::Missing => (Bytes::new(), None, DocumentPresence::Missing),
	};
	let kind = kind.unwrap_or_else(|| {
		if str::from_utf8(&content).is_ok() {
			DocumentKind::Text(None)
		} else {
			DocumentKind::Binary
		}
	});
	let revision = Revision::for_content(sequence, &content);
	let head = DocumentHead::new(document_id, revision, presence, kind, content.len() as u64)?;
	let snapshot = Arc::new(DocumentSnapshot::new(head, content)?);
	Ok((snapshot, fingerprint))
}

fn disk_matches_head(
	disk: &DiskState,
	presence: DocumentPresence,
	fingerprint: Option<&FileFingerprint>,
) -> bool {
	match (disk, presence, fingerprint) {
		(DiskState::Missing, DocumentPresence::Missing, None) => true,
		(
			DiskState::Present { fingerprint: observed, .. },
			DocumentPresence::Present,
			Some(current),
		) => observed == current,
		_ => false,
	}
}

fn select_content(content: &Bytes, selection: ReadSelection) -> Result<ReadBody> {
	match selection {
		ReadSelection::Whole => Ok(ReadBody::Whole(content.clone())),
		ReadSelection::Bytes(ranges) => {
			let upper_bound = content.len() as u64;
			let mut slices = Vec::with_capacity(ranges.len());
			for range in ranges {
				let range = range.validate(upper_bound)?;
				slices.push(ContentSlice {
					start:   range.start(),
					end:     range.end(),
					content: content.slice(range.start() as usize..range.end() as usize),
				});
			}
			Ok(ReadBody::Slices(slices))
		},
		ReadSelection::Lines(ranges) => select_lines(content, ranges),
	}
}

fn select_lines(content: &Bytes, ranges: Vec<LineRange>) -> Result<ReadBody> {
	let mut starts = Vec::new();
	if !content.is_empty() {
		starts.push(0usize);
		for (index, byte) in content.iter().enumerate() {
			if *byte == b'\n' && index + 1 < content.len() {
				starts.push(index + 1);
			}
		}
	}
	let line_count = starts.len() as u64;
	let mut slices = Vec::with_capacity(ranges.len());
	for range in ranges {
		let range = range.validate(line_count)?;
		let start = if range.start() == line_count {
			content.len()
		} else {
			starts[range.start() as usize]
		};
		let end = if range.end() == line_count {
			content.len()
		} else {
			starts[range.end() as usize]
		};
		slices.push(ContentSlice {
			start:   range.start(),
			end:     range.end(),
			content: content.slice(start..end),
		});
	}
	Ok(ReadBody::Slices(slices))
}

fn fresh_document_id(by_id: &HashMap<DocumentId, ActorHandle>) -> DocumentId {
	loop {
		let document_id = DocumentId::from_bytes(random_id_bytes());
		if !by_id.contains_key(&document_id) {
			return document_id;
		}
	}
}

fn random_id_bytes() -> [u8; 16] {
	rand::rng().random()
}

const fn join_error(source: JoinError) -> Error {
	Error::Worker { source }
}

const fn actor_unavailable() -> Error {
	Error::Protocol { reason: Str::new_static("document actor is unavailable") }
}

#[cfg(test)]
mod tests {
	use std::{num::NonZeroUsize, time::Duration};

	use tempfile::TempDir;
	use tokio::sync::oneshot::Receiver;
	use tokio_util::sync::CancellationToken;

	use super::*;
	use crate::docserver::transaction::{
		DocumentMutation, DocumentTarget, FormatPolicy, MutationOperation, StalePolicy, TextMutation,
		TextProposal, TransactionCoordinator, TransactionOutcome, TransactionRejectReason,
		TransactionRequest,
	};

	fn store(root: &TempDir, capacity: usize) -> DocumentStore {
		let config = ServerConfig::new(root.path())
			.expect("temporary root is valid")
			.with_revision_capacity(NonZeroUsize::new(capacity).expect("nonzero capacity"));
		DocumentStore::new(config).expect("store opens")
	}

	fn whole(result: &ReadResult) -> &[u8] {
		match result.body() {
			ReadBody::Whole(content) => content,
			ReadBody::Slices(_) => panic!("expected whole content"),
		}
	}

	async fn await_new_revision(opened: &mut OpenedDocument, previous: Revision) -> DocumentEvent {
		loop {
			let event = time::timeout(Duration::from_secs(5), opened.events().recv())
				.await
				.expect("watch event arrives")
				.expect("event stream remains active");
			if event.head().revision() != previous {
				return event;
			}
		}
	}

	fn test_worker_gate() -> (TestWorkerGate, Receiver<()>, Sender<()>) {
		let (started, started_receive) = oneshot::channel();
		let (release, release_receive) = mpsc::channel();
		(TestWorkerGate::new(started, release_receive), started_receive, release)
	}

	async fn await_actor_settled(actor: &ActorHandle) -> ActorStateSnapshot {
		time::timeout(Duration::from_secs(5), async {
			loop {
				let state = actor.state().await.expect("actor remains active");
				if !state.reloading {
					return state;
				}
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("actor background work settles")
	}

	#[tokio::test]
	async fn first_open_caches_and_repeat_open_shares_identity() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("note.txt");
		fs::write(&path, b"cached").expect("write fixture");
		let store = store(&root, 4);

		let first = store.open(path.clone()).await.expect("first open");
		let second = store.open(path.clone()).await.expect("repeat open");
		assert_eq!(first.head().document_id(), second.head().document_id());
		assert_eq!(first.head().revision(), second.head().revision());
		assert_ne!(first.lease_id(), second.lease_id());

		fs::write(&path, b"changed on disk").expect("change fixture");
		let retained = store
			.read(first.head().document_id(), Some(first.head().revision()), ReadSelection::Whole)
			.await
			.expect("retained memory read");
		assert_eq!(whole(&retained), b"cached");
	}
	#[tokio::test]
	async fn dropped_move_destination_reservation_restores_incumbent_authority() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("destination.txt");
		fs::write(&path, b"incumbent").expect("write fixture");
		let store = store(&root, 4);
		let opened = store.open(path.clone()).await.expect("open destination");
		let incumbent_id = opened.head().document_id();
		let incumbent_revision = opened.head().revision();
		store
			.close(opened.lease_id())
			.await
			.expect("close destination lease");
		drop(opened);

		let replacement = DocumentId::from_bytes([91; 16]);
		let reservation = store
			.reserve_move_destination(
				replacement,
				store.local_fs().root_path().join("destination.txt"),
				DestinationExpectation::Revision(incumbent_revision),
			)
			.await
			.expect("reserve inactive destination");
		drop(reservation);

		let reopened = store.open(path).await.expect("reopen destination");
		assert_eq!(reopened.head().document_id(), incumbent_id);
		assert_eq!(reopened.head().revision(), incumbent_revision);
	}

	#[tokio::test]
	async fn retained_revisions_are_exact_and_expire_explicitly() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("history.txt");
		fs::write(&path, b"one").expect("write fixture");
		let store = store(&root, 1);
		let mut opened = store.open(path.clone()).await.expect("open");
		let first = opened.head().revision();

		fs::write(&path, b"two").expect("modify fixture");
		let _ = await_new_revision(&mut opened, first).await;
		let error = store
			.read(opened.head().document_id(), Some(first), ReadSelection::Whole)
			.await
			.expect_err("old revision expires");
		assert!(matches!(error, Error::RevisionExpired { revision, .. } if revision == first));
	}

	#[tokio::test]
	async fn byte_and_line_ranges_are_zero_based_half_open() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("ranges.txt");
		fs::write(&path, b"alpha\nbeta\ngamma").expect("write fixture");
		let store = store(&root, 4);
		let opened = store.open(path).await.expect("open");

		let bytes = store
			.read(
				opened.lease_id(),
				None,
				ReadSelection::Bytes(vec![ByteRange::new(1, 5).expect("range")]),
			)
			.await
			.expect("byte read");
		let ReadBody::Slices(slices) = bytes.body() else {
			panic!("expected slices");
		};
		assert_eq!(slices[0].content().as_ref(), b"lpha");

		let lines = store
			.read(
				opened.lease_id(),
				None,
				ReadSelection::Lines(vec![LineRange::new(1, 2).expect("range")]),
			)
			.await
			.expect("line read");
		let ReadBody::Slices(slices) = lines.body() else {
			panic!("expected slices");
		};
		assert_eq!(slices[0].content().as_ref(), b"beta\n");
	}

	#[tokio::test]
	async fn last_lease_allows_bounded_actor_eviction() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("lease.txt");
		fs::write(&path, b"lease").expect("write fixture");
		let store = store(&root, 4);
		let opened = store.open(path).await.expect("open");
		let document_id = opened.head().document_id();
		store.close(opened.lease_id()).await.expect("close");
		time::sleep(IDLE_EVICTION_DELAY + Duration::from_millis(200)).await;

		let error = store
			.read(document_id, None, ReadSelection::Whole)
			.await
			.expect_err("evicted document is gone");
		assert!(matches!(error, Error::DocumentNotFound { document_id: id } if id == document_id));
	}

	#[tokio::test]
	async fn watcher_installs_external_revision_before_read_resumes() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("watch.txt");
		fs::write(&path, b"before").expect("write fixture");
		let store = store(&root, 4);
		let mut opened = store.open(path.clone()).await.expect("open");
		let previous = opened.head().revision();

		fs::write(&path, b"after").expect("modify fixture");
		let event = await_new_revision(&mut opened, previous).await;
		let read = store
			.read(opened.lease_id(), None, ReadSelection::Whole)
			.await
			.expect("read installed head");
		assert_eq!(read.head().revision(), event.head().revision());
		assert_eq!(whole(&read), b"after");
	}

	#[tokio::test]
	async fn missing_canonical_leaf_opens_as_missing_before_creation() {
		let root = TempDir::new().expect("temporary directory");
		let store = store(&root, 4);
		let path = store.local_fs().root_path().join("missing.txt");

		let opened = store.open(path).await.expect("open missing document");

		assert_eq!(opened.head().presence(), DocumentPresence::Missing);
		assert_eq!(opened.head().byte_length(), 0);
		let read = store
			.read(opened.lease_id(), None, ReadSelection::Whole)
			.await
			.expect("read missing cached head");
		assert_eq!(whole(&read), b"");
	}

	#[tokio::test]
	async fn active_permissions_require_current_revision_and_preserve_head() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("permissions.txt");
		fs::write(&path, b"permissions").expect("write fixture");
		let store = store(&root, 4);
		let opened = store.open(path).await.expect("open");
		let actor = store.actor_handle(opened.lease_id()).expect("actor");
		let revision = opened.head().revision();
		let stale = Revision::for_content(revision.sequence() + 1, b"stale");
		let read_only = PortablePermissions { read_only: Some(true), executable: None };

		let error = actor
			.set_permissions(stale, read_only, FollowSymlinks::Yes)
			.await
			.expect_err("stale permission update fails");
		assert!(matches!(
			error,
			Error::ContentModified {
				expected,
				current,
			} if expected == stale && current == revision
		));

		let metadata = actor
			.set_permissions(revision, read_only, FollowSymlinks::Yes)
			.await
			.expect("current permission update succeeds");
		assert_eq!(metadata.permissions.read_only, Some(true));
		let read = store
			.read(opened.lease_id(), None, ReadSelection::Whole)
			.await
			.expect("content head remains readable");
		assert_eq!(read.head().revision(), revision);
		assert_eq!(whole(&read), b"permissions");

		actor
			.set_permissions(
				revision,
				PortablePermissions { read_only: Some(false), executable: None },
				FollowSymlinks::Yes,
			)
			.await
			.expect("restore writable fixture");
	}

	#[tokio::test]
	async fn prepared_delete_and_move_cannot_commit_after_external_change() {
		let root = TempDir::new().expect("temporary directory");
		let delete_path = root.path().join("delete.txt");
		let move_path = root.path().join("move.txt");
		let destination = root.path().join("destination.txt");
		fs::write(&delete_path, b"delete base").expect("delete fixture");
		fs::write(&move_path, b"move base").expect("move fixture");
		let store = store(&root, 4);

		let delete_opened = store.open(delete_path.clone()).await.expect("open delete");
		let delete_actor = store
			.actor_handle(delete_opened.lease_id())
			.expect("delete actor");
		let delete_id = TransactionId::from_bytes([31; 16]);
		let delete_reserved = delete_actor
			.reserve(delete_id, delete_opened.head().revision())
			.await
			.expect("reserve delete");
		let prepared_delete = store
			.local_fs()
			.prepare_delete(&delete_reserved.path, delete_reserved.disk_expectation.clone())
			.expect("prepare delete");
		fs::write(&delete_path, b"external delete replacement").expect("invalidate delete");
		let delete_error = delete_actor
			.commit_prepared_delete(delete_reserved.reservation, prepared_delete)
			.await
			.expect_err("stale delete cannot remove");
		assert!(matches!(
			delete_error,
			Error::StaleTransaction { .. } | Error::StaleDiskState { .. }
		));
		assert_eq!(
			fs::read(&delete_path).expect("delete path remains"),
			b"external delete replacement"
		);

		let move_opened = store.open(move_path.clone()).await.expect("open move");
		let move_actor = store
			.actor_handle(move_opened.lease_id())
			.expect("move actor");
		let move_id = TransactionId::from_bytes([32; 16]);
		let move_reserved = move_actor
			.reserve(move_id, move_opened.head().revision())
			.await
			.expect("reserve move");
		let canonical_destination = store.local_fs().root_path().join("destination.txt");
		let path_claim = store
			.reserve_rebind_path(move_opened.head().document_id(), canonical_destination.clone())
			.expect("reserve destination");
		let prepared_move = store
			.local_fs()
			.prepare_move(
				&move_reserved.path,
				&canonical_destination,
				move_reserved.disk_expectation.clone(),
				DiskExpectation::Missing,
			)
			.expect("prepare move");
		fs::write(&move_path, b"external move replacement").expect("invalidate move");
		let move_error = move_actor
			.commit_prepared_move(move_reserved.reservation, prepared_move, path_claim)
			.await
			.expect_err("stale move cannot rename");
		assert!(matches!(move_error, Error::StaleTransaction { .. } | Error::StaleDiskState { .. }));
		assert_eq!(fs::read(&move_path).expect("move source remains"), b"external move replacement");
		assert!(!destination.exists());
	}

	#[tokio::test]
	async fn slow_document_subscribers_observe_bounded_lag() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("lag.txt");
		fs::write(&path, b"initial").expect("write fixture");
		let store = store(&root, DOCUMENT_EVENT_CAPACITY + 2);
		let mut opened = store.open(path).await.expect("open");
		let document_id = opened.head().document_id();
		let mut revision = opened.head().revision();
		let coordinator = TransactionCoordinator::new(store.clone(), [9; 16]);
		let publish = async {
			let mut attempt = 1_u128;
			for index in 1..=DOCUMENT_EVENT_CAPACITY + 1 {
				loop {
					let request =
						TransactionRequest::new(TransactionId::from_bytes(attempt.to_be_bytes()), vec![
							DocumentMutation::new(
								DocumentTarget::Document(document_id),
								MutationOperation::Text(TextMutation::new(
									revision,
									TextProposal::Content(Bytes::from(vec![
										u8::try_from(index).expect("small index"),
									])),
									StalePolicy::Fail,
									FormatPolicy::Disabled,
								)),
							),
						]);
					attempt += 1;
					let outcome = coordinator.commit(request, CancellationToken::new()).await;
					match outcome.as_ref() {
						TransactionOutcome::Committed { operations, .. } => {
							revision = operations[0].head().revision();
							break;
						},
						TransactionOutcome::Rejected {
							reason: TransactionRejectReason::ExternalModification,
							..
						} => {
							revision = store
								.read(document_id, None, ReadSelection::Whole)
								.await
								.expect("reload after a native watcher notification")
								.head()
								.revision();
						},
						other => panic!("expected committed event, got {other:?}"),
					}
				}
			}
		};
		time::timeout(Duration::from_secs(5), publish)
			.await
			.expect("commits settle despite native watcher notifications");

		assert!(matches!(
			opened.events().recv().await,
			Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) if missed > 0
		));
	}

	#[tokio::test]
	async fn mutation_acquisition_waits_for_pending_watch_reload() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("queued-reserve.txt");
		fs::write(&path, b"base").expect("write fixture");
		let store = store(&root, 4);
		let opened = store.open(path).await.expect("open");
		let actor = store.actor_handle(opened.lease_id()).expect("actor");
		let revision = opened.head().revision();

		actor
			.inject_pending_watch_invalidation()
			.await
			.expect("inject state invalidation");
		let state = time::timeout(Duration::from_secs(2), actor.ready_state())
			.await
			.expect("ready state waits for reload")
			.expect("unchanged reload succeeds");
		assert_eq!(state.head.expect("committed head").head().revision(), revision);

		actor
			.inject_pending_watch_invalidation()
			.await
			.expect("inject reservation invalidation");
		let transaction_id = TransactionId::from_bytes([42; 16]);
		let reserved = time::timeout(Duration::from_secs(2), actor.reserve(transaction_id, revision))
			.await
			.expect("reservation waits for reload")
			.expect("unchanged reload preserves reservation base");
		actor
			.release(reserved.reservation)
			.await
			.expect("release reservation");
	}

	#[tokio::test]
	async fn release_rejects_a_reservation_after_a_pending_watch_callback() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("stale-release.txt");
		fs::write(&path, b"base").expect("write fixture");
		let store = store(&root, 4);
		let opened = store.open(path).await.expect("open");
		let actor = store.actor_handle(opened.lease_id()).expect("actor");
		let transaction_id = TransactionId::from_bytes([41; 16]);
		let reserved = actor
			.reserve(transaction_id, opened.head().revision())
			.await
			.expect("reserve current head");

		actor
			.inject_pending_watch_invalidation()
			.await
			.expect("inject callback observed before its mailbox event");
		let error = actor
			.release(reserved.reservation)
			.await
			.expect_err("pending callback makes release stale");

		assert!(
			matches!(error, Error::StaleTransaction { transaction_id: id, .. } if id == transaction_id)
		);
	}

	#[tokio::test]
	async fn shutdown_waits_for_blocking_persistence_completion_and_reply() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("shutdown-persist.txt");
		fs::write(&path, b"persist").expect("write fixture");
		let store = store(&root, 4);
		let opened = store.open(path).await.expect("open");
		let actor = store.actor_handle(opened.lease_id()).expect("actor");
		let (gate, started, release) = test_worker_gate();
		actor
			.install_test_worker_gate(TestWorkerKind::Persist, gate)
			.await
			.expect("install persistence gate");

		let permission_actor = actor.clone();
		let revision = opened.head().revision();
		let permission = tokio::spawn(async move {
			permission_actor
				.set_permissions(
					revision,
					PortablePermissions { read_only: Some(true), executable: None },
					FollowSymlinks::Yes,
				)
				.await
		});
		started.await.expect("persistence worker starts");

		let shutdown_actor = actor.clone();
		let mut shutdown = tokio::spawn(async move { shutdown_actor.shutdown().await });
		assert!(
			time::timeout(Duration::from_millis(50), &mut shutdown)
				.await
				.is_err(),
			"shutdown must wait for the blocked persistence worker"
		);
		release.send(()).expect("release persistence worker");
		permission
			.await
			.expect("permission task joins")
			.expect("persistence completion replies before shutdown");
		shutdown
			.await
			.expect("shutdown task joins")
			.expect("shutdown acknowledges");
		assert!(actor.state().await.is_err(), "acknowledged actor has exited");
	}

	#[tokio::test]
	async fn failed_move_watch_rebind_recovers_at_destination_before_later_edits() {
		let root = TempDir::new().expect("temporary directory");
		let source = root.path().join("move-watch-source.txt");
		let destination = root.path().join("move-watch-destination.txt");
		fs::write(&source, b"before move").expect("write fixture");
		let store = store(&root, 4);
		let mut opened = store.open(source.clone()).await.expect("open source");
		let actor = store.actor_handle(opened.lease_id()).expect("actor");
		let transaction_id = TransactionId::from_bytes([42; 16]);
		let reserved = actor
			.reserve(transaction_id, opened.head().revision())
			.await
			.expect("reserve move");
		let canonical_destination = store
			.local_fs()
			.root_path()
			.join("move-watch-destination.txt");
		let path_claim = store
			.reserve_rebind_path(opened.head().document_id(), canonical_destination.clone())
			.expect("reserve destination");
		let prepared = store
			.local_fs()
			.prepare_move(
				&reserved.path,
				&canonical_destination,
				reserved.disk_expectation.clone(),
				DiskExpectation::Missing,
			)
			.expect("prepare move");
		actor
			.force_next_move_watch_rebind_failure()
			.await
			.expect("force rebind failure");

		let committed = actor
			.commit_prepared_move(reserved.reservation, prepared, path_claim)
			.await
			.expect("durable move remains committed");
		let settled = await_actor_settled(&actor).await;
		assert_eq!(settled.path, canonical_destination);
		assert!(!source.exists());
		assert!(destination.exists());

		fs::write(&destination, b"after move").expect("edit destination");
		let event = await_new_revision(&mut opened, committed.revision()).await;
		let read = store
			.read(opened.lease_id(), Some(event.head().revision()), ReadSelection::Whole)
			.await
			.expect("read destination edit");
		assert_eq!(whole(&read), b"after move");
	}

	#[tokio::test]
	async fn dropped_open_activation_removes_both_registry_and_actor_leases() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("cancelled-open.txt");
		fs::write(&path, b"cancel").expect("write fixture");
		let store = store(&root, 4);
		let gate = store.mutation_gate();
		let authority = gate.lock().await;
		let actor = store
			.open_path_handle(path.clone())
			.await
			.expect("register actor while authority is held");
		let (worker_gate, started, release) = test_worker_gate();
		actor
			.install_test_worker_gate(TestWorkerKind::Activation, worker_gate)
			.await
			.expect("install activation gate");
		drop(authority);

		let open_store = store.clone();
		let open = tokio::spawn(async move { open_store.open(path).await });
		started.await.expect("activation worker starts");
		open.abort();
		let _ = open.await;
		assert!(store.inner.lock_maps().by_lease.is_empty(), "cancelled open removes registry lease");
		release.send(()).expect("release activation worker");

		time::timeout(Duration::from_secs(5), async {
			loop {
				if actor.state().await.is_err() {
					break;
				}
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("cancelled activation becomes idle and evicts");
	}

	#[tokio::test]
	async fn open_registration_is_linearized_with_remove_and_rename() {
		let root = TempDir::new().expect("temporary directory");
		let rename_source = root.path().join("rename-race.txt");
		let rename_destination = root.path().join("renamed-before-open.txt");
		let remove_path = root.path().join("remove-race.txt");
		fs::write(&rename_source, b"rename").expect("write rename fixture");
		fs::write(&remove_path, b"remove").expect("write remove fixture");
		let store = store(&root, 4);

		let gate = store.mutation_gate();
		let authority = gate.lock().await;
		let rename_store = store.clone();
		let rename_open_path = rename_source.clone();
		let mut rename_open = tokio::spawn(async move { rename_store.open(rename_open_path).await });
		assert!(
			time::timeout(Duration::from_millis(50), &mut rename_open)
				.await
				.is_err(),
			"open waits for the rename authority"
		);
		assert!(store.actor_handle_for_path(&rename_source).is_none());
		fs::rename(&rename_source, &rename_destination).expect("rename under authority");
		drop(authority);
		let renamed = rename_open
			.await
			.expect("rename open joins")
			.expect("open linearizes after rename");
		assert_eq!(renamed.head().presence(), DocumentPresence::Missing);

		let gate = store.mutation_gate();
		let authority = gate.lock().await;
		let remove_store = store.clone();
		let remove_open_path = remove_path.clone();
		let mut remove_open = tokio::spawn(async move { remove_store.open(remove_open_path).await });
		assert!(
			time::timeout(Duration::from_millis(50), &mut remove_open)
				.await
				.is_err(),
			"open waits for the removal authority"
		);
		assert!(store.actor_handle_for_path(&remove_path).is_none());
		fs::remove_file(&remove_path).expect("remove under authority");
		drop(authority);
		let removed = remove_open
			.await
			.expect("remove open joins")
			.expect("open linearizes after removal");
		assert_eq!(removed.head().presence(), DocumentPresence::Missing);
	}

	#[tokio::test]
	async fn permission_cas_never_chmods_a_replacement_entry() {
		let root = TempDir::new().expect("temporary directory");
		let path = root.path().join("permission-replacement.txt");
		fs::write(&path, b"original").expect("write fixture");
		let store = store(&root, 4);
		let opened = store.open(path.clone()).await.expect("open");
		let actor = store.actor_handle(opened.lease_id()).expect("actor");
		let (gate, started, release) = test_worker_gate();
		actor
			.install_test_worker_gate(TestWorkerKind::Persist, gate)
			.await
			.expect("install persistence gate");

		let permission_actor = actor.clone();
		let revision = opened.head().revision();
		let permission = tokio::spawn(async move {
			permission_actor
				.set_permissions(
					revision,
					PortablePermissions { read_only: Some(true), executable: None },
					FollowSymlinks::Yes,
				)
				.await
		});
		started
			.await
			.expect("permission worker reaches operation boundary");
		fs::remove_file(&path).expect("remove original entry");
		fs::write(&path, b"replacement").expect("install replacement entry");
		release.send(()).expect("release permission worker");

		let error = permission
			.await
			.expect("permission task joins")
			.expect_err("replacement fails exact disk expectation");
		assert!(matches!(error, Error::StaleDiskState { .. }));
		assert_eq!(fs::read(&path).expect("read replacement"), b"replacement");
		assert!(
			!fs::metadata(&path)
				.expect("replacement metadata")
				.permissions()
				.readonly(),
			"replacement permissions remain untouched"
		);
	}
}
