//! Content-addressed workspace generations and copy-on-write worktrees.

#[cfg(target_os = "macos")]
use std::ffi::CString;
use std::{
	collections::{BTreeMap, BTreeSet, HashMap},
	fs::{self, File},
	io::{self, Cursor, Read, Write},
	ops::ControlFlow,
	path::{Component, Path, PathBuf},
	process, slice,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time,
};
#[cfg(target_os = "linux")]
use std::{fs::OpenOptions, os::fd::AsRawFd as _};

use bytes::Bytes;
use omp_core::{Hash32, Str, Ulid, encoding::hex, sf};
use omp_proto::{
	document::v1::{
		self as document_pb, commit_transaction_response, document_mutation, text_mutation,
	},
	env::v1 as pb,
};
use omp_walker::{FileType, WalkOrder};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	super::{
		blobs::{BlobError, BlobHost, BlobId},
		docs::{DocumentError, DocumentHost, DocumentLease, WorkspaceLease, lease_target},
		tool_document::read_whole,
	},
	WorkspaceError, WorkspaceHost,
};

const MANIFEST_MAGIC: &[u8; 7] = b"OMPWS2\0";
const DIFF_MAGIC: &[u8; 8] = b"OMPWSD1\0";
const IO_BUFFER_BYTES: usize = 64 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum untracked content admitted before an isolation baseline snapshot.
pub const ISOLATION_BASELINE_MAX_UNTRACKED_BYTES: u64 = 1024 * 1024 * 1024;

/// Typed refusal for an isolation baseline whose untracked content is too
/// large.
#[derive(Debug, Error)]
#[error(
	"working tree at {root:?} carries {content_bytes} bytes of untracked content, over the \
	 {limit_bytes}-byte isolation snapshot budget; commit or gitignore the bulk, or set \
	 `task.isolation.mode: none`"
)]
pub struct IsolationBaselineTooLargeError {
	/// Repository whose isolation baseline was refused.
	pub root:          PathBuf,
	/// Untracked bytes observed through link-preserving metadata.
	pub content_bytes: u64,
	/// Configured hard ceiling.
	pub limit_bytes:   u64,
}

/// Failure while sizing untracked content ahead of an isolation snapshot.
#[derive(Debug, Error)]
pub enum IsolationBaselinePreflightError {
	/// Version-control discovery or untracked-file enumeration failed.
	#[error("could not enumerate untracked files")]
	Vcs(#[from] omp_vcs::Error),
	/// Link-preserving metadata failed for one untracked entry.
	#[error("could not size untracked entry {path:?}")]
	Metadata {
		/// Entry which could not be sized.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
}

/// Snapshot, restore, or isolated-worktree failure.
#[derive(Debug, Error)]
pub enum WorkspaceOperationError {
	/// Workspace traversal failed.
	#[error(transparent)]
	Workspace(#[from] WorkspaceError),
	/// Blob storage failed.
	#[error(transparent)]
	Blob(#[from] BlobError),
	/// Document authority failed.
	#[error(transparent)]
	Document(#[from] DocumentError),
	/// Filesystem access failed.
	#[error("workspace filesystem operation failed: {0}")]
	Io(#[from] io::Error),
	/// A caller-supplied relative path escaped its workspace root.
	#[error("workspace path escapes its isolated root")]
	OutsideRoot,
	/// A snapshot identifier or manifest was malformed.
	#[error("invalid workspace generation: {0}")]
	InvalidGeneration(Str),
	/// The requested worktree does not exist.
	#[error("worktree {0:?} was not found")]
	WorktreeNotFound(Str),
	/// A worktree name is empty or contains path separators.
	#[error("invalid worktree name")]
	InvalidWorktreeName,
	/// A workspace operation used bindings from another schema revision.
	#[error("workspace wire revision does not match the Environment schema")]
	WireRevision,

	/// A worktree registry record was malformed.
	#[error("invalid worktree registry record: {0}")]
	InvalidWorktreeRecord(Str),
	/// A durable workspace snapshot record was malformed.
	#[error("invalid workspace snapshot record: {0}")]
	InvalidSnapshotRecord(Str),
	/// Isolation baseline sizing failed before snapshot capture.
	#[error(transparent)]
	IsolationPreflight(#[from] IsolationBaselinePreflightError),
	/// Untracked content exceeded the isolation snapshot budget.
	#[error(transparent)]
	IsolationBaselineTooLarge(#[from] IsolationBaselineTooLargeError),
}

/// Result of merging an isolated worktree without invoking a VCS subprocess.
#[derive(Clone, Debug)]
pub struct WorktreeMerge {
	/// Current worktree identity and generation.
	pub worktree:  pb::WorktreeInfo,
	/// Content-addressed manifest-diff artifact preserved for patch and branch
	/// recovery.
	pub artifact:  Option<BlobId>,
	/// Internal branch metadata produced by `branch` strategy.
	pub branch:    Option<Str>,
	/// Structured conflicts that prevented the requested disposition.
	pub conflicts: Vec<pb::WorkspaceConflict>,
}

/// Environment-owned content-addressed workspace and worktree service.
#[derive(Clone)]
pub struct WorkspaceOperations {
	inner: Arc<OperationsInner>,
}

struct OperationsInner {
	workspace:       WorkspaceHost,
	documents:       DocumentHost,
	blobs:           BlobHost,
	worktree_root:   PathBuf,
	parking:         parking_state::State,
	transition:      Mutex<()>,
	next_generation: AtomicU64,
}

#[derive(Clone)]
struct CachedFile {
	fingerprint: FileFingerprint,
	blob:        BlobId,
}
mod parking_state {
	use std::{collections::HashMap, path::PathBuf};

	use omp_core::Str;
	use omp_proto::env::v1::WorkspaceSnapshot;
	use parking_lot::Mutex;

	use super::{CachedFile, WorktreeRecord};

	pub(super) struct State {
		pub(super) cache:     Mutex<HashMap<PathBuf, CachedFile>>,
		pub(super) worktrees: Mutex<HashMap<Str, WorktreeRecord>>,
		pub(super) snapshots: Mutex<Vec<WorkspaceSnapshot>>,
	}

	impl State {
		pub(super) fn new(
			worktrees: HashMap<Str, WorktreeRecord>,
			snapshots: Vec<WorkspaceSnapshot>,
		) -> Self {
			Self {
				cache:     Mutex::new(HashMap::new()),
				worktrees: Mutex::new(worktrees),
				snapshots: Mutex::new(snapshots),
			}
		}
	}
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct FileFingerprint {
	len:         u64,
	modified_ns: u128,
	mode:        u32,
	identity:    u64,
	change_ns:   i128,
}

#[derive(Clone)]
struct WorktreeRecord {
	id:         Str,
	root:       PathBuf,
	base:       Str,
	generation: u64,
	branch:     Option<Str>,
	owner_pid:  u32,
}

#[derive(Deserialize, Serialize)]
struct DurableWorktreeRecord {
	version:     u8,
	id:          String,
	root:        PathBuf,
	base:        String,
	generation:  u64,
	branch:      Option<String>,
	owner_pid:   u32,
	class:       String,
	source_root: PathBuf,
}
#[derive(Deserialize, Serialize)]
struct DurableSnapshotRecord {
	version:            u8,
	snapshot_id:        String,
	manifest_hash:      Vec<u8>,
	generation:         u64,
	label:              Option<String>,
	created_ms:         u64,
	root_uri:           String,
	parent_snapshot_id: Option<String>,
	tree_hash:          String,
	entry_count:        u64,
	bytes:              u64,
	partial:            bool,
}
#[derive(Serialize)]
struct IsolationOwner<'a> {
	pid: u32,
	id:  &'a str,
}

const ISOLATION_OWNER_FILE: &str = ".omp-isolation-owner";

#[must_use]
struct WorktreeBuild {
	root:  PathBuf,
	armed: bool,
}

impl Drop for WorktreeBuild {
	fn drop(&mut self) {
		if self.armed {
			let _ = fs::remove_dir_all(&self.root);
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManifestEntry {
	path: Str,
	mode: u32,
	hash: [u8; 32],
}

#[derive(Clone)]
struct Manifest {
	prefixes: Vec<Str>,
	entries:  BTreeMap<Str, ManifestEntry>,
}

fn untracked_paths(root: &Path) -> Result<Vec<PathBuf>, IsolationBaselinePreflightError> {
	let Some(repo) = omp_vcs::detect(root)? else {
		return Ok(Vec::new());
	};
	// jj snapshots every non-ignored path, so it has no distinct untracked set.
	Ok(repo
		.ls_files(true, true)?
		.into_iter()
		.map(PathBuf::from)
		.collect())
}

fn untracked_entry_bytes(path: &Path) -> Result<u64, IsolationBaselinePreflightError> {
	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
		Err(source) => {
			return Err(IsolationBaselinePreflightError::Metadata {
				path: path.to_path_buf(),
				source,
			});
		},
	};
	let file_type = metadata.file_type();
	Ok(if file_type.is_file() || file_type.is_symlink() {
		metadata.len()
	} else {
		0
	})
}

fn prepare_isolation_baseline<T, I, P, S, C>(
	root: &Path,
	untracked: I,
	mut size: S,
	capture: C,
) -> Result<T, WorkspaceOperationError>
where
	I: IntoIterator<Item = P>,
	P: AsRef<Path>,
	S: FnMut(&Path) -> Result<u64, IsolationBaselinePreflightError>,
	C: FnOnce() -> Result<T, WorkspaceOperationError>,
{
	let mut content_bytes = 0_u64;
	for relative in untracked {
		content_bytes = content_bytes.saturating_add(size(&root.join(relative))?);
		if content_bytes > ISOLATION_BASELINE_MAX_UNTRACKED_BYTES {
			return Err(
				IsolationBaselineTooLargeError {
					root: root.to_path_buf(),
					content_bytes,
					limit_bytes: ISOLATION_BASELINE_MAX_UNTRACKED_BYTES,
				}
				.into(),
			);
		}
	}
	capture()
}

impl WorkspaceOperations {
	/// Opens persistent workspace operations beneath an environment-private
	/// state root.
	pub fn open(
		workspace: WorkspaceHost,
		documents: DocumentHost,
		blobs: BlobHost,
		state_root: impl AsRef<Path>,
	) -> Result<Self, WorkspaceOperationError> {
		fs::create_dir_all(state_root.as_ref())?;
		fs::create_dir_all(state_root.as_ref().join(".records"))?;
		fs::create_dir_all(state_root.as_ref().join(".snapshots"))?;
		fs::create_dir_all(state_root.as_ref().join(".branches"))?;
		let worktree_root = fs::canonicalize(state_root)?;
		let (worktrees, next_generation) = load_worktree_records(&worktree_root)?;
		let snapshots = load_snapshot_records(&worktree_root)?;
		Ok(Self {
			inner: Arc::new(OperationsInner {
				workspace,
				documents,
				blobs,
				worktree_root,
				parking: parking_state::State::new(worktrees, snapshots),
				transition: Mutex::new(()),
				next_generation: AtomicU64::new(next_generation),
			}),
		})
	}

	/// Returns the registered projection for this environment's canonical
	/// workspace root, or `None` when the environment owns the primary root.
	pub fn current_worktree(&self) -> Result<Option<pb::WorktreeInfo>, WorkspaceOperationError> {
		let root = match fs::canonicalize(self.inner.workspace.root()) {
			Ok(root) => root,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(error) => return Err(error.into()),
		};
		let record = self
			.inner
			.parking
			.worktrees
			.lock()
			.values()
			.find(|record| record.root == root)
			.cloned();
		record.as_ref().map(worktree_info).transpose()
	}

	/// Captures and durably publishes one authoritative workspace generation.
	pub fn snapshot(
		&self,
		request: &pb::SnapshotWorkspace,
		cancel: &CancellationToken,
	) -> Result<pb::WorkspaceSnapshot, WorkspaceOperationError> {
		self.ensure_wire_revision(request.wire_revision)?;
		let _transition = self.inner.transition.try_lock().map_err(|_| {
			WorkspaceOperationError::InvalidGeneration(sf!(
				"workspace transition is already in progress",
			))
		})?;
		let snapshot = self.snapshot_at(self.inner.workspace.root(), &request.paths, cancel)?;
		self.publish_snapshot(snapshot, request.label.clone(), request.expected_generation, false)
	}

	/// Lists durable captures for the current workspace, newest first.
	pub fn list_snapshots(
		&self,
		request: &pb::ListWorkspaceSnapshots,
	) -> Result<pb::WorkspaceSnapshotList, WorkspaceOperationError> {
		self.ensure_wire_revision(request.wire_revision)?;
		let root_uri = file_uri(&fs::canonicalize(self.inner.workspace.root())?)?;
		let snapshots = self
			.inner
			.parking
			.snapshots
			.lock()
			.iter()
			.rev()
			.filter(|snapshot| snapshot.root_uri == root_uri.as_str())
			.take(request.limit as usize)
			.cloned()
			.collect();
		Ok(pb::WorkspaceSnapshotList {
			snapshots,
			wire_revision: omp_proto::SCHEMA_REV,
			props: Default::default(),
		})
	}

	/// Restores one generation through document leases, always preserving a
	/// durable undo capture and returning projected or committed effects.
	pub async fn restore(
		&self,
		request: &pb::RestoreWorkspace,
		cancel: &CancellationToken,
	) -> Result<pb::WorkspaceRestored, WorkspaceOperationError> {
		self.ensure_wire_revision(request.wire_revision)?;
		let _transition = self.inner.transition.lock().await;
		self.ensure_snapshot_owned(&request.snapshot_id)?;
		let undo = self.publish_snapshot(
			self.snapshot_at(self.inner.workspace.root(), &[], cancel)?,
			None,
			0,
			false,
		)?;
		let current = self.load_manifest(&undo.snapshot_id)?;
		let target = restrict_manifest(self.load_manifest(&request.snapshot_id)?, &request.paths)?;
		let mut restored = pb::WorkspaceRestored {
			snapshot_id:      request.snapshot_id.clone(),
			undo_snapshot_id: undo.snapshot_id.clone(),
			conflicts:        Vec::new(),
			partial:          false,
			from_generation:  undo.generation,
			to_generation:    undo.generation,
			written:          0,
			deleted:          0,
			unchanged:        unchanged_entries(&target, &current),
			dry_run:          request.dry_run,
			wire_revision:    omp_proto::SCHEMA_REV,
			props:            Default::default(),
		};
		if request.expected_generation != 0 && request.expected_generation != undo.generation {
			restored.conflicts.push(workspace_conflict(
				Str::from("."),
				pb::ConflictReason::GenerationChanged,
				Some(sf!(
					"expected generation {}, current generation {}",
					request.expected_generation,
					undo.generation,
				)),
			));
			return Ok(restored);
		}
		let plans = self.plan_restore(&target, &current, cancel).await?;
		restored.written = plans.iter().filter(|plan| !plan.is_delete()).count() as u64;
		restored.deleted = plans.iter().filter(|plan| plan.is_delete()).count() as u64;
		let (workspace_lease, lease_conflicts) = self
			.acquire_restore_lease(&plans, request.dry_run, cancel)
			.await?;
		restored.conflicts.extend(lease_conflicts);
		if request.dry_run || !restored.conflicts.is_empty() || plans.is_empty() {
			return Ok(restored);
		}
		let reserved = match self.publish_snapshot(undo.clone(), None, undo.generation, true) {
			Ok(snapshot) => snapshot,
			Err(WorkspaceOperationError::InvalidGeneration(detail)) => {
				restored.conflicts.push(workspace_conflict(
					Str::from("."),
					pb::ConflictReason::GenerationChanged,
					Some(detail),
				));
				return Ok(restored);
			},
			Err(error) => return Err(error),
		};
		restored.to_generation = reserved.generation;
		let Some(workspace_lease) = workspace_lease else {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!(
				"document authority omitted an uncontested workspace lease",
			)));
		};
		if cancel.is_cancelled() {
			return Err(WorkspaceError::Cancelled.into());
		}
		// Once the workspace-wide lease is held, restoration is a foreground
		// mutation: finish the authorized plan even if its caller disconnects.
		// Stopping between per-document commits would expose a half-restored
		// tree and violate the cancellation boundary.
		let commit_cancel = CancellationToken::new();

		let mut written = 0_u64;
		let mut deleted = 0_u64;
		for plan in plans {
			let path = plan.path().clone();
			let delete = plan.is_delete();
			match self.apply_restore_plan(plan, &commit_cancel).await {
				Ok(()) if delete => deleted += 1,
				Ok(()) => written += 1,
				Err(failure) => {
					restored.partial = written != 0 || deleted != 0 || failure.effects;
					restored
						.conflicts
						.push(workspace_conflict(path, failure.reason, None));
					break;
				},
			}
		}
		drop(workspace_lease);
		restored.written = written;
		restored.deleted = deleted;
		if restored.partial || restored.conflicts.is_empty() {
			let current = self.publish_snapshot(
				self.snapshot_at(self.inner.workspace.root(), &[], &commit_cancel)?,
				None,
				reserved.generation,
				false,
			)?;
			restored.to_generation = current.generation;
		}
		Ok(restored)
	}

	/// Creates an isolated copy-on-write root from the current workspace
	/// generation.
	pub fn create_worktree(
		&self,
		request: &pb::CreateWorktree,
		cancel: &CancellationToken,
	) -> Result<pb::WorktreeInfo, WorkspaceOperationError> {
		validate_worktree_name(&request.name)?;
		let root = self.inner.workspace.root();
		let untracked = untracked_paths(root)?;
		let snapshot = prepare_isolation_baseline(root, untracked, untracked_entry_bytes, || {
			self.snapshot_at(root, &request.paths, cancel)
		})?;
		if request
			.base
			.as_deref()
			.is_some_and(|base| base != snapshot.snapshot_id)
		{
			return Err(WorkspaceOperationError::InvalidGeneration(sf!(
				"copy-on-write creation requires the live workspace generation",
			)));
		}
		let id = Str::from(format!("{}-{}", request.name, Ulid::generate()));
		let root = self.inner.worktree_root.join(id.as_str());
		if root.parent() != Some(self.inner.worktree_root.as_path()) {
			return Err(WorkspaceOperationError::OutsideRoot);
		}
		fs::create_dir(&root)?;
		let mut build = WorktreeBuild { root: root.clone(), armed: true };
		let owner_pid = if request.owner_pid == 0 {
			process::id()
		} else {
			request.owner_pid
		};
		let owner = serde_json::to_vec(&IsolationOwner { pid: owner_pid, id: id.as_str() }).map_err(
			|error| WorkspaceOperationError::InvalidWorktreeRecord(Str::from(error.to_string())),
		)?;
		fs::write(root.join(ISOLATION_OWNER_FILE), owner)?;
		let manifest = self.load_manifest(&snapshot.snapshot_id)?;
		for entry in manifest.entries.values() {
			if entry.path.as_str() == ISOLATION_OWNER_FILE {
				continue;
			}
			if cancel.is_cancelled() {
				return Err(WorkspaceError::Cancelled.into());
			}
			let source = checked_join(self.inner.workspace.root(), entry.path.as_str())?;
			let source = fs::canonicalize(source)?;
			if !source.starts_with(self.inner.workspace.root()) {
				return Err(WorkspaceOperationError::OutsideRoot);
			}
			let destination = checked_join(&root, entry.path.as_str())?;
			if let Some(parent) = destination.parent() {
				fs::create_dir_all(parent)?;
			}
			clone_file_cow(&source, &destination)?;
			set_mode(&destination, entry.mode)?;
		}
		let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
		let record = WorktreeRecord {
			id: id.clone(),
			root,
			base: Str::from(snapshot.snapshot_id),
			generation,
			branch: None,
			owner_pid,
		};
		self.write_worktree_record(&record)?;
		build.armed = false;
		self
			.inner
			.parking
			.worktrees
			.lock()
			.insert(id, record.clone());
		worktree_info(&record)
	}

	/// Destroys an isolated root, refusing dirty content unless `force` is set.
	pub fn destroy_worktree(
		&self,
		request: &pb::DestroyWorktree,
		cancel: &CancellationToken,
	) -> Result<pb::WorktreeInfo, WorkspaceOperationError> {
		let key = Str::from(request.id.as_str());
		let record = self
			.inner
			.parking
			.worktrees
			.lock()
			.get(&key)
			.cloned()
			.ok_or_else(|| WorkspaceOperationError::WorktreeNotFound(key.clone()))?;
		self.ensure_registered_root(&record.root)?;
		if !request.force {
			let current = self.snapshot_at(&record.root, &[], cancel)?;
			let current = self.load_manifest(&current.snapshot_id)?;
			let base = self.load_manifest(record.base.as_str())?;
			if current.entries != base.entries {
				return Err(WorkspaceOperationError::InvalidGeneration(sf!(
					"worktree has unmerged changes",
				)));
			}
		}
		fs::remove_dir_all(&record.root)?;
		remove_if_exists(&self.record_path(record.id.as_str()))?;
		remove_if_exists(
			&self
				.inner
				.worktree_root
				.join(".branches")
				.join(record.id.as_str()),
		)?;
		self.inner.parking.worktrees.lock().remove(&key);
		worktree_info(&record)
	}

	/// Applies a three-way manifest merge or records internal branch metadata,
	/// always preserving a content-addressed recovery artifact.
	pub async fn merge_worktree(
		&self,
		request: &pb::MergeWorktree,
		cancel: &CancellationToken,
	) -> Result<WorktreeMerge, WorkspaceOperationError> {
		let _transition = self.inner.transition.lock().await;
		let key = Str::from(request.id.as_str());
		let mut record = self
			.inner
			.parking
			.worktrees
			.lock()
			.get(&key)
			.cloned()
			.ok_or_else(|| WorkspaceOperationError::WorktreeNotFound(key.clone()))?;
		self.ensure_registered_root(&record.root)?;
		let current_snapshot = self.snapshot_at(&record.root, &[], cancel)?;
		let base = self.load_manifest(record.base.as_str())?;
		let current = self.load_manifest(&current_snapshot.snapshot_id)?;
		let mode = pb::MergeMode::try_from(request.mode).unwrap_or(pb::MergeMode::Unspecified);
		if matches!(
			mode,
			omp_proto::env::v1::MergeMode::None | omp_proto::env::v1::MergeMode::Unspecified
		) {
			return Ok(WorktreeMerge {
				worktree:  worktree_info(&record)?,
				artifact:  None,
				branch:    record.branch,
				conflicts: Vec::new(),
			});
		}
		let artifact = Some(self.write_manifest_diff(&base, &current, cancel)?);
		let parent_snapshot = self.snapshot_at(self.inner.workspace.root(), &[], cancel)?;
		let parent = self.load_manifest(&parent_snapshot.snapshot_id)?;
		let (target, mut conflicts) = merge_target(&base, &parent, &current);
		let branch = if mode == pb::MergeMode::Branch {
			let branch = Str::from(format!("omp/agent/{}", record.id));
			if !request.dry_run {
				record.branch = Some(branch.clone());
				fs::write(
					self
						.inner
						.worktree_root
						.join(".branches")
						.join(record.id.as_str()),
					current_snapshot.snapshot_id.as_bytes(),
				)?;
				self.write_worktree_record(&record)?;
				self
					.inner
					.parking
					.worktrees
					.lock()
					.insert(key, record.clone());
			}
			Some(branch)
		} else {
			record.branch.clone()
		};
		if mode == pb::MergeMode::Patch && conflicts.is_empty() {
			let parent_record = self.publish_snapshot(parent_snapshot.clone(), None, 0, false)?;
			conflicts = self
				.apply_merge_target(&target, &parent, request.dry_run, cancel)
				.await?;
			if !request.dry_run {
				let merged = self.snapshot_at(self.inner.workspace.root(), &[], cancel)?;
				if merged.snapshot_id != parent_record.snapshot_id {
					self.publish_snapshot(merged, None, parent_record.generation, true)?;
				}
			}
		}
		Ok(WorktreeMerge { worktree: worktree_info(&record)?, artifact, branch, conflicts })
	}

	async fn apply_merge_target(
		&self,
		target: &Manifest,
		parent: &Manifest,
		dry_run: bool,
		cancel: &CancellationToken,
	) -> Result<Vec<pb::WorkspaceConflict>, WorkspaceOperationError> {
		let plans = self.plan_restore(target, parent, cancel).await?;
		let (workspace_lease, mut conflicts) =
			self.acquire_restore_lease(&plans, dry_run, cancel).await?;
		if dry_run || !conflicts.is_empty() || plans.is_empty() {
			return Ok(conflicts);
		}
		let Some(workspace_lease) = workspace_lease else {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!(
				"document authority omitted an uncontested workspace lease",
			)));
		};
		for plan in plans {
			if cancel.is_cancelled() {
				return Err(WorkspaceError::Cancelled.into());
			}
			let path = plan.path().clone();
			if let Err(failure) = self.apply_restore_plan(plan, cancel).await {
				conflicts.push(workspace_conflict(path, failure.reason, None));
				break;
			}
		}
		drop(workspace_lease);
		Ok(conflicts)
	}

	fn snapshot_at(
		&self,
		root: &Path,
		paths: &[String],
		cancel: &CancellationToken,
	) -> Result<pb::WorkspaceSnapshot, WorkspaceOperationError> {
		let root = fs::canonicalize(root)?;
		let isolated = root != self.inner.workspace.root();
		if isolated {
			self.ensure_registered_root(&root)?;
		}
		let prefixes = normalize_prefixes(paths)?;
		let host = WorkspaceHost::open(&root)?;
		let request = host
			.request()
			.hidden(true)
			.gitignore(true)
			.skip_git(true)
			.order(WalkOrder::Path);
		let mut manifest = self.inner.blobs.begin_spill()?;
		manifest.write_all(MANIFEST_MAGIC)?;
		write_u32(&mut manifest, prefixes.len())?;
		let mut manifest_bytes = MANIFEST_MAGIC.len() as u64 + 4;
		for prefix in &prefixes {
			manifest_bytes = manifest_bytes.saturating_add(4 + prefix.len() as u64);
			check_manifest_bound(manifest_bytes)?;
			write_bytes(&mut manifest, prefix.as_bytes())?;
		}
		let mut files = 0_u64;
		let mut bytes = 0_u64;
		let mut failure = None;
		host.walk_stream(&request, cancel, |entry| {
			if entry.file_type != FileType::File
				|| (isolated && entry.relative_path == ISOLATION_OWNER_FILE)
				|| !selected(entry.relative_path, &prefixes)
			{
				return ControlFlow::Continue(());
			}
			let result = (|| {
				let (blob, mode) = self.hash_file(entry.absolute_path.as_ref(), cancel)?;
				let encoded = 4_u64 + entry.relative_path.len() as u64 + 4 + 32;
				manifest_bytes = manifest_bytes.saturating_add(encoded);
				check_manifest_bound(manifest_bytes)?;
				write_bytes(&mut manifest, entry.relative_path.as_bytes())?;
				manifest.write_all(&mode.to_be_bytes())?;
				manifest.write_all(&blob.hash)?;
				files += 1;
				bytes = bytes.saturating_add(blob.size);
				Ok::<(), WorkspaceOperationError>(())
			})();
			if let Err(error) = result {
				failure = Some(error);
				ControlFlow::Break(())
			} else {
				ControlFlow::Continue(())
			}
		})?;
		if let Some(error) = failure {
			return Err(error);
		}
		if cancel.is_cancelled() {
			return Err(WorkspaceError::Cancelled.into());
		}
		let reference = manifest.finish().map_err(BlobError::from)?;
		let snapshot_id = reference.hash.to_string();
		Ok(pb::WorkspaceSnapshot {
			snapshot_id,
			manifest_hash: Bytes::copy_from_slice(reference.hash.as_bytes()),
			files,
			bytes,
			generation: 0,
			label: None,
			created_ms: 0,
			root_uri: file_uri(&root)?.to_string(),
			parent_snapshot_id: None,
			tree_hash: reference.hash.to_string(),
			entry_count: files,
			partial: !prefixes.is_empty(),
			wire_revision: omp_proto::SCHEMA_REV,
			props: Default::default(),
		})
	}

	fn ensure_wire_revision(&self, revision: u32) -> Result<(), WorkspaceOperationError> {
		if revision == omp_proto::SCHEMA_REV {
			Ok(())
		} else {
			Err(WorkspaceOperationError::WireRevision)
		}
	}

	fn ensure_snapshot_owned(&self, snapshot_id: &str) -> Result<(), WorkspaceOperationError> {
		let root_uri = file_uri(&fs::canonicalize(self.inner.workspace.root())?)?;
		if self.inner.parking.snapshots.lock().iter().any(|snapshot| {
			snapshot.snapshot_id == snapshot_id && snapshot.root_uri == root_uri.as_str()
		}) {
			Ok(())
		} else {
			Err(WorkspaceOperationError::InvalidGeneration(sf!(
				"snapshot is not owned by the current workspace root",
			)))
		}
	}

	fn publish_snapshot(
		&self,
		mut snapshot: pb::WorkspaceSnapshot,
		label: Option<String>,
		expected_generation: u64,
		advance_generation: bool,
	) -> Result<pb::WorkspaceSnapshot, WorkspaceOperationError> {
		let mut snapshots = self.inner.parking.snapshots.lock();
		let previous = snapshots
			.iter()
			.rev()
			.find(|candidate| candidate.root_uri == snapshot.root_uri);
		let current_generation = previous.map_or(0, |candidate| candidate.generation);
		if expected_generation != 0 && expected_generation != current_generation {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!(
				"expected generation {expected_generation}, current generation {current_generation}",
			)));
		}
		snapshot.generation = if previous.is_none() {
			1
		} else if advance_generation {
			current_generation.saturating_add(1)
		} else {
			current_generation
		};
		snapshot.label = label;
		snapshot.created_ms = unix_epoch_ms();
		snapshot.parent_snapshot_id = snapshots
			.iter()
			.rev()
			.find(|candidate| {
				candidate.root_uri == snapshot.root_uri && candidate.snapshot_id != snapshot.snapshot_id
			})
			.map(|candidate| candidate.snapshot_id.clone());
		self.write_snapshot_record(&snapshot)?;
		snapshots.push(snapshot.clone());
		Ok(snapshot)
	}

	fn write_snapshot_record(
		&self,
		snapshot: &pb::WorkspaceSnapshot,
	) -> Result<(), WorkspaceOperationError> {
		let durable = DurableSnapshotRecord::from_snapshot(snapshot);
		let bytes = serde_json::to_vec(&durable).map_err(|error| {
			WorkspaceOperationError::InvalidSnapshotRecord(Str::from(error.to_string()))
		})?;
		let path = self
			.inner
			.worktree_root
			.join(".snapshots")
			.join(format!("{}.json", Ulid::generate()));
		let temporary = path.with_extension("json.tmp");
		fs::write(&temporary, bytes)?;
		fs::rename(temporary, path)?;
		Ok(())
	}

	fn hash_file(
		&self,
		path: &Path,
		cancel: &CancellationToken,
	) -> Result<(BlobId, u32), WorkspaceOperationError> {
		let mut source = open_snapshot_file(path)?;
		let metadata = source.metadata()?;
		if !metadata.is_file() {
			return Err(WorkspaceOperationError::OutsideRoot);
		}
		let fingerprint = file_fingerprint(&metadata);
		if let Some(cached) = self.inner.parking.cache.lock().get(path)
			&& cached.fingerprint == fingerprint
		{
			return Ok((cached.blob, fingerprint.mode));
		}
		let mut stage = self.inner.blobs.begin_spill()?;
		let mut buffer = Box::new([0_u8; IO_BUFFER_BYTES]);
		loop {
			if cancel.is_cancelled() {
				return Err(WorkspaceError::Cancelled.into());
			}
			let read = source.read(&mut buffer[..])?;
			if read == 0 {
				break;
			}
			stage.write_all(&buffer[..read])?;
		}
		let blob = BlobId::from(stage.finish().map_err(BlobError::from)?);
		self
			.inner
			.parking
			.cache
			.lock()
			.insert(path.to_path_buf(), CachedFile { fingerprint, blob });
		Ok((blob, fingerprint.mode))
	}

	fn load_manifest(&self, snapshot_id: &str) -> Result<Manifest, WorkspaceOperationError> {
		let hash = hex::decode(snapshot_id)
			.into_array::<32>()
			.map_err(|_| WorkspaceOperationError::InvalidGeneration(sf!("invalid manifest hash")))?;
		let stat = self.inner.blobs.stat(&hash)?;
		if !stat.present || stat.size > MAX_MANIFEST_BYTES {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!(
				"manifest is missing or exceeds the size bound",
			)));
		}
		let bytes = self.inner.blobs.get(BlobId { hash, size: stat.size })?;
		parse_manifest(&bytes)
	}

	async fn plan_restore(
		&self,
		target: &Manifest,
		current: &Manifest,
		cancel: &CancellationToken,
	) -> Result<Vec<RestorePlan>, WorkspaceOperationError> {
		let mut plans = Vec::new();
		for entry in target.entries.values() {
			if cancel.is_cancelled() {
				return Err(WorkspaceError::Cancelled.into());
			}
			let path = checked_join(self.inner.workspace.root(), entry.path.as_str())?;
			let uri = file_uri(&path)?;
			let lease = self.inner.documents.open(uri, None, cancel).await?;
			let presence = document_pb::DocumentPresence::try_from(lease.head().presence)
				.unwrap_or(document_pb::DocumentPresence::Unspecified);
			if presence == document_pb::DocumentPresence::Present {
				let content = read_whole(&self.inner.documents, &lease).await?;
				let actual = Hash32::sum(&content).into_bytes();
				let mode = fs::metadata(&path).map_or(0, |metadata| file_mode(&metadata));
				if actual == entry.hash && mode == entry.mode {
					continue;
				}
				plans.push(RestorePlan::Replace { entry: entry.clone(), lease });
			} else {
				plans.push(RestorePlan::Create { entry: entry.clone(), lease });
			}
		}
		for entry in current.entries.values() {
			if !selected(entry.path.as_str(), &target.prefixes)
				|| target.entries.contains_key(&entry.path)
			{
				continue;
			}
			let path = checked_join(self.inner.workspace.root(), entry.path.as_str())?;
			let lease = self
				.inner
				.documents
				.open(file_uri(&path)?, None, cancel)
				.await?;
			plans.push(RestorePlan::Delete { path: entry.path.clone(), lease });
		}
		Ok(plans)
	}

	async fn acquire_restore_lease(
		&self,
		plans: &[RestorePlan],
		dry_run: bool,
		cancel: &CancellationToken,
	) -> Result<(Option<WorkspaceLease>, Vec<pb::WorkspaceConflict>), WorkspaceOperationError> {
		if plans.is_empty() {
			return Ok((None, Vec::new()));
		}
		let mut paths = BTreeMap::new();
		for plan in plans {
			let path = plan.path().clone();
			let absolute = checked_join(self.inner.workspace.root(), path.as_str())?;
			paths.insert(file_uri(&absolute)?.to_string(), path);
		}
		let (lease, response) = self
			.inner
			.documents
			.acquire_workspace_lease(
				document_pb::AcquireWorkspaceLeaseRequest {
					uris: paths.keys().cloned().collect(),
					transaction_id: Bytes::copy_from_slice(&Ulid::generate().to_bytes()),
					dry_run,
				},
				cancel,
			)
			.await?;
		let conflicts = response
			.conflicts
			.into_iter()
			.map(|conflict| {
				let path = paths
					.get(&conflict.uri)
					.cloned()
					.unwrap_or_else(|| Str::from(conflict.uri));
				workspace_conflict(
					path,
					pb::ConflictReason::OpenLease,
					Some(Str::from(hex::encode(&conflict.active_lease_id).into_string())),
				)
			})
			.collect();
		Ok((lease, conflicts))
	}

	async fn apply_restore_plan(
		&self,
		plan: RestorePlan,
		cancel: &CancellationToken,
	) -> Result<(), ApplyFailure> {
		let before_commit = |reason| ApplyFailure { reason, effects: false };
		let (path, lease, operation, mode) = match plan {
			RestorePlan::Replace { entry, lease } => {
				let bytes = self
					.read_entry_blob(&entry)
					.map_err(|error| before_commit(map_operation_error(&error)))?;
				let revision = lease
					.head()
					.revision
					.clone()
					.ok_or_else(|| before_commit(pb::ConflictReason::ModifiedAfterSnapshot))?;
				let mutation = document_pb::TextMutation {
					base_revision: Some(revision),
					change:        Some(text_mutation::Change::ProposedContent(bytes)),
					stale_policy:  document_pb::StalePolicy::Fail as i32,
					format_policy: document_pb::FormatPolicy::Disabled as i32,
				};
				(entry.path, lease, document_mutation::Operation::Text(mutation), Some(entry.mode))
			},
			RestorePlan::Create { entry, lease } => {
				let bytes = self
					.read_entry_blob(&entry)
					.map_err(|error| before_commit(map_operation_error(&error)))?;
				let mutation = document_pb::CreateMutation {
					content:           bytes,
					existing_document: document_pb::ExistingDocumentPolicy::FailIfExists as i32,
					format_policy:     document_pb::FormatPolicy::Disabled as i32,
				};
				(entry.path, lease, document_mutation::Operation::Create(mutation), Some(entry.mode))
			},
			RestorePlan::Delete { path, lease } => {
				let revision = lease
					.head()
					.revision
					.clone()
					.ok_or_else(|| before_commit(pb::ConflictReason::ModifiedAfterSnapshot))?;
				(
					path,
					lease,
					document_mutation::Operation::Delete(document_pb::DeleteMutation {
						base_revision: Some(revision),
					}),
					None,
				)
			},
		};
		let response = self
			.inner
			.documents
			.commit_transaction(
				Bytes::copy_from_slice(&Ulid::generate().to_bytes()),
				vec![document_pb::DocumentMutation {
					document:  Some(lease_target(&lease)),
					operation: Some(operation),
				}],
				cancel,
			)
			.await
			.map_err(|_| ApplyFailure {
				reason:  pb::ConflictReason::GenerationChanged,
				effects: true,
			})?;
		match response.outcome {
			Some(commit_transaction_response::Outcome::Committed(_)) => {
				if let Some(mode) = mode {
					let absolute =
						checked_join(self.inner.workspace.root(), path.as_str()).map_err(|_| {
							ApplyFailure { reason: pb::ConflictReason::OutsideRoot, effects: true }
						})?;
					set_mode(&absolute, mode).map_err(|_| ApplyFailure {
						reason:  pb::ConflictReason::Permission,
						effects: true,
					})?;
				}
				Ok(())
			},
			Some(commit_transaction_response::Outcome::Rejected(rejected)) => {
				Err(before_commit(map_reject_reason(rejected.reason)))
			},
			Some(commit_transaction_response::Outcome::PartiallyCommitted(partial)) => {
				Err(ApplyFailure { reason: map_reject_reason(partial.reason), effects: true })
			},
			None => Err(before_commit(pb::ConflictReason::GenerationChanged)),
		}
	}

	fn read_entry_blob(&self, entry: &ManifestEntry) -> Result<Bytes, WorkspaceOperationError> {
		let stat = self.inner.blobs.stat(&entry.hash)?;
		if !stat.present {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!("file blob is missing",)));
		}
		Ok(self
			.inner
			.blobs
			.get(BlobId { hash: entry.hash, size: stat.size })?)
	}

	fn write_manifest_diff(
		&self,
		base: &Manifest,
		current: &Manifest,
		cancel: &CancellationToken,
	) -> Result<BlobId, WorkspaceOperationError> {
		let mut stage = self.inner.blobs.begin_spill()?;
		stage.write_all(DIFF_MAGIC)?;
		for (path, entry) in &current.entries {
			if cancel.is_cancelled() {
				return Err(WorkspaceError::Cancelled.into());
			}
			if base.entries.get(path) == Some(entry) {
				continue;
			}
			stage.write_all(b"M")?;
			write_bytes(&mut stage, path.as_bytes())?;
			stage.write_all(&entry.mode.to_be_bytes())?;
			stage.write_all(&entry.hash)?;
		}
		for path in base.entries.keys() {
			if current.entries.contains_key(path) {
				continue;
			}
			stage.write_all(b"D")?;
			write_bytes(&mut stage, path.as_bytes())?;
		}
		Ok(BlobId::from(stage.finish().map_err(BlobError::from)?))
	}

	fn record_path(&self, id: &str) -> PathBuf {
		self
			.inner
			.worktree_root
			.join(".records")
			.join(format!("{id}.json"))
	}

	fn write_worktree_record(&self, record: &WorktreeRecord) -> Result<(), WorkspaceOperationError> {
		let durable = DurableWorktreeRecord {
			version:     1,
			id:          record.id.to_string(),
			root:        record.root.clone(),
			base:        record.base.to_string(),
			generation:  record.generation,
			branch:      record.branch.as_ref().map(ToString::to_string),
			owner_pid:   record.owner_pid,
			class:       "task-isolation".to_owned(),
			source_root: self.inner.workspace.root().to_path_buf(),
		};
		let bytes = serde_json::to_vec(&durable).map_err(|error| {
			WorkspaceOperationError::InvalidWorktreeRecord(Str::from(error.to_string()))
		})?;
		let path = self.record_path(record.id.as_str());
		let temporary = path.with_extension(format!("json.{}.tmp", Ulid::generate()));
		fs::write(&temporary, bytes)?;
		fs::rename(temporary, path)?;
		Ok(())
	}

	fn ensure_registered_root(&self, root: &Path) -> Result<(), WorkspaceOperationError> {
		let root = fs::canonicalize(root)?;
		if !root.starts_with(&self.inner.worktree_root)
			|| root.parent() != Some(self.inner.worktree_root.as_path())
			|| !self
				.inner
				.parking
				.worktrees
				.lock()
				.values()
				.any(|record| record.root == root)
		{
			return Err(WorkspaceOperationError::OutsideRoot);
		}
		Ok(())
	}
}

fn merge_target(
	base: &Manifest,
	parent: &Manifest,
	child: &Manifest,
) -> (Manifest, Vec<pb::WorkspaceConflict>) {
	let paths = base
		.entries
		.keys()
		.chain(child.entries.keys())
		.cloned()
		.collect::<BTreeSet<_>>();
	let mut target = parent.clone();
	let mut conflicts = Vec::new();
	for path in paths {
		let baseline = base.entries.get(&path);
		let isolated = child.entries.get(&path);
		if isolated == baseline {
			continue;
		}
		let current = parent.entries.get(&path);
		if current != baseline && current != isolated {
			conflicts.push(workspace_conflict(
				path,
				pb::ConflictReason::PathChanged,
				Some(sf!("parent and isolated workspace both changed relative to baseline")),
			));
			continue;
		}
		if let Some(entry) = isolated {
			target.entries.insert(path, entry.clone());
		} else {
			target.entries.remove(&path);
		}
	}
	(target, conflicts)
}

fn load_worktree_records(
	worktree_root: &Path,
) -> Result<(HashMap<Str, WorktreeRecord>, u64), WorkspaceOperationError> {
	let mut records = HashMap::new();
	let mut next_generation = 1_u64;
	for entry in fs::read_dir(worktree_root.join(".records"))? {
		let entry = entry?;
		if !entry.file_type()?.is_file()
			|| entry.path().extension().and_then(|value| value.to_str()) != Some("json")
		{
			continue;
		}
		let durable: DurableWorktreeRecord = if let Some(record) = fs::read(entry.path())
			.ok()
			.and_then(|bytes| serde_json::from_slice(&bytes).ok())
		{
			record
		} else {
			tracing::warn!(path = %entry.path().display(), "ignoring malformed worktree record");
			continue;
		};
		if durable.version != 1
			|| durable.id.is_empty()
			|| durable.root.parent() != Some(worktree_root)
			|| !durable.root.exists()
		{
			continue;
		}
		next_generation = next_generation.max(durable.generation.saturating_add(1));
		let id = Str::from(durable.id);
		records.insert(id.clone(), WorktreeRecord {
			id,
			root: durable.root,
			base: Str::from(durable.base),
			generation: durable.generation,
			branch: durable.branch.map(Str::from),
			owner_pid: durable.owner_pid,
		});
	}
	Ok((records, next_generation))
}

impl DurableSnapshotRecord {
	fn from_snapshot(snapshot: &pb::WorkspaceSnapshot) -> Self {
		Self {
			version:            1,
			snapshot_id:        snapshot.snapshot_id.clone(),
			manifest_hash:      snapshot.manifest_hash.to_vec(),
			generation:         snapshot.generation,
			label:              snapshot.label.clone(),
			created_ms:         snapshot.created_ms,
			root_uri:           snapshot.root_uri.clone(),
			parent_snapshot_id: snapshot.parent_snapshot_id.clone(),
			tree_hash:          snapshot.tree_hash.clone(),
			entry_count:        snapshot.entry_count,
			bytes:              snapshot.bytes,
			partial:            snapshot.partial,
		}
	}

	fn into_snapshot(self) -> Result<pb::WorkspaceSnapshot, WorkspaceOperationError> {
		let identity = hex::decode(self.snapshot_id.as_str())
			.into_array::<32>()
			.map_err(|_| {
				WorkspaceOperationError::InvalidSnapshotRecord(
					sf!("snapshot id is not a content hash",),
				)
			})?;
		if self.version != 1
			|| self.snapshot_id.is_empty()
			|| self.manifest_hash.len() != 32
			|| self.manifest_hash.as_slice() != identity.as_slice()
			|| self.snapshot_id != hex::encode(&identity).into_string()
			|| self.tree_hash != self.snapshot_id
			|| self.root_uri.is_empty()
			|| self.generation == 0
		{
			return Err(WorkspaceOperationError::InvalidSnapshotRecord(sf!(
				"snapshot identity or metadata is invalid",
			)));
		}
		Ok(pb::WorkspaceSnapshot {
			snapshot_id:        self.snapshot_id,
			manifest_hash:      Bytes::from(self.manifest_hash),
			files:              self.entry_count,
			bytes:              self.bytes,
			generation:         self.generation,
			label:              self.label,
			created_ms:         self.created_ms,
			root_uri:           self.root_uri,
			parent_snapshot_id: self.parent_snapshot_id,
			tree_hash:          self.tree_hash,
			entry_count:        self.entry_count,
			partial:            self.partial,
			wire_revision:      omp_proto::SCHEMA_REV,
			props:              Default::default(),
		})
	}
}

fn load_snapshot_records(
	worktree_root: &Path,
) -> Result<Vec<pb::WorkspaceSnapshot>, WorkspaceOperationError> {
	let mut snapshots = Vec::new();
	for entry in fs::read_dir(worktree_root.join(".snapshots"))? {
		let entry = entry?;
		if !entry.file_type()?.is_file()
			|| entry.path().extension().and_then(|value| value.to_str()) != Some("json")
		{
			continue;
		}
		let bytes = fs::read(entry.path())?;
		let durable: DurableSnapshotRecord = serde_json::from_slice(&bytes).map_err(|error| {
			WorkspaceOperationError::InvalidSnapshotRecord(Str::from(error.to_string()))
		})?;
		snapshots.push((entry.file_name(), durable.into_snapshot()?));
	}
	snapshots.sort_by(|(left_name, left), (right_name, right)| {
		left
			.created_ms
			.cmp(&right.created_ms)
			.then_with(|| left_name.cmp(right_name))
	});
	Ok(snapshots
		.into_iter()
		.map(|(_, snapshot)| snapshot)
		.collect())
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
	match fs::remove_file(path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
		Err(error) => Err(error),
	}
}

enum RestorePlan {
	Replace { entry: ManifestEntry, lease: DocumentLease },
	Create { entry: ManifestEntry, lease: DocumentLease },
	Delete { path: Str, lease: DocumentLease },
}

struct ApplyFailure {
	reason:  pb::ConflictReason,
	effects: bool,
}

impl RestorePlan {
	const fn path(&self) -> &Str {
		match self {
			Self::Replace { entry, .. } | Self::Create { entry, .. } => &entry.path,
			Self::Delete { path, .. } => path,
		}
	}

	const fn is_delete(&self) -> bool {
		matches!(self, Self::Delete { .. })
	}
}

fn normalize_prefixes(paths: &[String]) -> Result<Vec<Str>, WorkspaceOperationError> {
	let mut prefixes = Vec::with_capacity(paths.len());
	for path in paths {
		let normalized = normalize_relative(path)?;
		if !prefixes.contains(&normalized) {
			prefixes.push(normalized);
		}
	}
	prefixes.sort_unstable();
	Ok(prefixes)
}

fn restrict_manifest(
	mut manifest: Manifest,
	paths: &[String],
) -> Result<Manifest, WorkspaceOperationError> {
	let requested = normalize_prefixes(paths)?;
	if requested.is_empty() {
		return Ok(manifest);
	}
	let mut prefixes = Vec::new();
	if manifest.prefixes.is_empty() {
		prefixes = requested;
	} else {
		for captured in &manifest.prefixes {
			for requested in &requested {
				if selected(requested.as_str(), slice::from_ref(captured)) {
					prefixes.push(requested.clone());
				} else if selected(captured.as_str(), slice::from_ref(requested)) {
					prefixes.push(captured.clone());
				}
			}
		}
		prefixes.sort_unstable();
		prefixes.dedup();
		if prefixes.is_empty() {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!(
				"restore paths do not intersect the captured snapshot scope",
			)));
		}
	}
	manifest
		.entries
		.retain(|path, _| selected(path.as_str(), &prefixes));
	manifest.prefixes = prefixes;
	Ok(manifest)
}

fn unchanged_entries(target: &Manifest, current: &Manifest) -> u64 {
	target
		.entries
		.iter()
		.filter(|(path, entry)| current.entries.get(*path) == Some(*entry))
		.count() as u64
}

fn normalize_relative(path: &str) -> Result<Str, WorkspaceOperationError> {
	let path = Path::new(path);
	if path.is_absolute() || path.as_os_str().is_empty() {
		return Err(WorkspaceOperationError::OutsideRoot);
	}
	let mut normalized = String::new();
	for component in path.components() {
		match component {
			Component::Normal(component) => {
				let component = component
					.to_str()
					.ok_or(WorkspaceOperationError::OutsideRoot)?;
				if !normalized.is_empty() {
					normalized.push('/');
				}
				normalized.push_str(component);
			},
			Component::CurDir => {},
			_ => return Err(WorkspaceOperationError::OutsideRoot),
		}
	}
	if normalized.is_empty() {
		return Err(WorkspaceOperationError::OutsideRoot);
	}
	Ok(Str::from(normalized))
}

fn selected(path: &str, prefixes: &[Str]) -> bool {
	prefixes.is_empty()
		|| prefixes.iter().any(|prefix| {
			path == prefix.as_str()
				|| path
					.strip_prefix(prefix.as_str())
					.is_some_and(|suffix| suffix.starts_with('/'))
		})
}

fn checked_join(root: &Path, relative: &str) -> Result<PathBuf, WorkspaceOperationError> {
	let normalized = normalize_relative(relative)?;
	let joined = root.join(normalized.as_str());
	if joined.starts_with(root) {
		Ok(joined)
	} else {
		Err(WorkspaceOperationError::OutsideRoot)
	}
}

fn parse_manifest(bytes: &[u8]) -> Result<Manifest, WorkspaceOperationError> {
	let mut input = Cursor::new(bytes);
	let mut magic = [0_u8; MANIFEST_MAGIC.len()];
	input.read_exact(&mut magic).map_err(invalid_manifest)?;
	if &magic != MANIFEST_MAGIC {
		return Err(WorkspaceOperationError::InvalidGeneration(sf!("manifest magic mismatch",)));
	}
	let prefix_count = read_u32(&mut input)?;
	if u64::from(prefix_count) > (bytes.len() as u64).saturating_sub(input.position()) / 4 {
		return Err(WorkspaceOperationError::InvalidGeneration(sf!(
			"manifest prefix count exceeds remaining bytes",
		)));
	}
	let mut prefixes = Vec::with_capacity(prefix_count as usize);
	for _ in 0..prefix_count {
		let prefix = Str::from(read_string(&mut input)?);
		if normalize_relative(prefix.as_str())? != prefix {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!(
				"manifest prefix is not canonical",
			)));
		}
		prefixes.push(prefix);
	}
	if !prefixes.windows(2).all(|pair| pair[0] < pair[1]) {
		return Err(WorkspaceOperationError::InvalidGeneration(sf!(
			"manifest prefixes are not strictly sorted",
		)));
	}
	let mut entries = BTreeMap::new();
	while input.position() < bytes.len() as u64 {
		let path = Str::from(read_string(&mut input)?);
		if normalize_relative(path.as_str())? != path {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!(
				"manifest path is not canonical",
			)));
		}
		let mut mode = [0_u8; 4];
		input.read_exact(&mut mode).map_err(invalid_manifest)?;
		let mode = u32::from_be_bytes(mode);
		if mode & !0o7777 != 0 {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!("manifest mode is invalid",)));
		}
		let mut hash = [0_u8; 32];
		input.read_exact(&mut hash).map_err(invalid_manifest)?;
		let entry = ManifestEntry { path: path.clone(), mode, hash };
		if entries.insert(path, entry).is_some() {
			return Err(WorkspaceOperationError::InvalidGeneration(sf!("duplicate manifest path",)));
		}
	}
	Ok(Manifest { prefixes, entries })
}

fn write_bytes(writer: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
	let length =
		u32::try_from(bytes.len()).map_err(|_| io::Error::other("manifest path exceeds u32"))?;
	writer.write_all(&length.to_be_bytes())?;
	writer.write_all(bytes)
}

fn write_u32(writer: &mut impl Write, value: usize) -> io::Result<()> {
	let value = u32::try_from(value).map_err(|_| io::Error::other("manifest count exceeds u32"))?;
	writer.write_all(&value.to_be_bytes())
}

fn read_u32(reader: &mut impl Read) -> Result<u32, WorkspaceOperationError> {
	let mut bytes = [0_u8; 4];
	reader.read_exact(&mut bytes).map_err(invalid_manifest)?;
	Ok(u32::from_be_bytes(bytes))
}

fn read_string(reader: &mut impl Read) -> Result<String, WorkspaceOperationError> {
	let length = read_u32(reader)? as usize;
	if length > MAX_MANIFEST_BYTES as usize {
		return Err(WorkspaceOperationError::InvalidGeneration(sf!("manifest path exceeds bound",)));
	}
	let mut bytes = vec![0_u8; length];
	reader.read_exact(&mut bytes).map_err(invalid_manifest)?;
	String::from_utf8(bytes)
		.map_err(|_| WorkspaceOperationError::InvalidGeneration(sf!("manifest path is not UTF-8")))
}

fn invalid_manifest(error: io::Error) -> WorkspaceOperationError {
	WorkspaceOperationError::InvalidGeneration(Str::from(error.to_string()))
}

const fn check_manifest_bound(bytes: u64) -> Result<(), WorkspaceOperationError> {
	if bytes > MAX_MANIFEST_BYTES {
		Err(WorkspaceOperationError::InvalidGeneration(sf!("manifest exceeds size bound",)))
	} else {
		Ok(())
	}
}

fn validate_worktree_name(name: &str) -> Result<(), WorkspaceOperationError> {
	if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
		Err(WorkspaceOperationError::InvalidWorktreeName)
	} else {
		Ok(())
	}
}

fn worktree_info(record: &WorktreeRecord) -> Result<pb::WorktreeInfo, WorkspaceOperationError> {
	Ok(pb::WorktreeInfo {
		id:         record.id.to_string(),
		root_uri:   file_uri(&record.root)?.to_string(),
		base:       record.base.to_string(),
		generation: record.generation,
		props:      Default::default(),
	})
}

fn file_uri(path: &Path) -> Result<Str, WorkspaceOperationError> {
	Url::from_file_path(path)
		.map(|url| Str::from(url.to_string()))
		.map_err(|()| WorkspaceOperationError::OutsideRoot)
}

fn workspace_conflict(
	path: Str,
	reason: pb::ConflictReason,
	detail: Option<Str>,
) -> pb::WorkspaceConflict {
	pb::WorkspaceConflict {
		path:         path.to_string(),
		reason:       reason as i32,
		detail:       detail.as_ref().map(ToString::to_string),
		lease_holder: if reason == pb::ConflictReason::OpenLease {
			detail.map(|detail| detail.to_string())
		} else {
			None
		},
	}
}

fn map_reject_reason(reason: i32) -> pb::ConflictReason {
	match document_pb::TransactionRejectReason::try_from(reason) {
		Ok(document_pb::TransactionRejectReason::PreconditionFailed) => pb::ConflictReason::OpenLease,
		Ok(
			document_pb::TransactionRejectReason::StaleBase
			| document_pb::TransactionRejectReason::OverlappingChange
			| document_pb::TransactionRejectReason::ExternalModification
			| document_pb::TransactionRejectReason::RevisionExpired,
		) => pb::ConflictReason::ModifiedAfterSnapshot,
		Ok(document_pb::TransactionRejectReason::PersistFailed) => pb::ConflictReason::Permission,
		_ => pb::ConflictReason::PathChanged,
	}
}

fn map_operation_error(error: &WorkspaceOperationError) -> pb::ConflictReason {
	match error {
		WorkspaceOperationError::OutsideRoot => pb::ConflictReason::OutsideRoot,
		WorkspaceOperationError::InvalidGeneration(_) => pb::ConflictReason::PathMissing,
		WorkspaceOperationError::Io(error) if error.kind() == io::ErrorKind::PermissionDenied => {
			pb::ConflictReason::Permission
		},
		_ => pb::ConflictReason::PathChanged,
	}
}

fn file_fingerprint(metadata: &fs::Metadata) -> FileFingerprint {
	let modified_ns = metadata
		.modified()
		.ok()
		.and_then(|value| value.duration_since(time::UNIX_EPOCH).ok())
		.map_or(0, |value| value.as_nanos());
	FileFingerprint {
		len: metadata.len(),
		modified_ns,
		mode: file_mode(metadata),
		identity: file_identity(metadata),
		change_ns: file_change_ns(metadata),
	}
}

#[cfg(unix)]
fn open_snapshot_file(path: &Path) -> io::Result<File> {
	use std::os::unix::fs::OpenOptionsExt as _;
	File::options()
		.read(true)
		.custom_flags(libc::O_NOFOLLOW)
		.open(path)
}

#[cfg(not(unix))]
fn open_snapshot_file(path: &Path) -> io::Result<File> {
	File::open(path)
}

#[cfg(unix)]
fn file_mode(metadata: &fs::Metadata) -> u32 {
	use std::os::unix::fs::MetadataExt as _;
	metadata.mode() & 0o7777
}

#[cfg(not(unix))]
fn file_mode(metadata: &fs::Metadata) -> u32 {
	if metadata.permissions().readonly() {
		0o444
	} else {
		0o666
	}
}

#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata) -> u64 {
	use std::os::unix::fs::MetadataExt as _;
	metadata.ino()
}

#[cfg(not(unix))]
fn file_identity(_metadata: &fs::Metadata) -> u64 {
	0
}

#[cfg(unix)]
fn file_change_ns(metadata: &fs::Metadata) -> i128 {
	use std::os::unix::fs::MetadataExt as _;
	i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec())
}

#[cfg(not(unix))]
fn file_change_ns(_metadata: &fs::Metadata) -> i128 {
	0
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
	use std::os::unix::fs::PermissionsExt as _;
	fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
	let mut permissions = fs::metadata(path)?.permissions();
	permissions.set_readonly(mode & 0o222 == 0);
	fs::set_permissions(path, permissions)
}

fn clone_file_cow(source: &Path, destination: &Path) -> Result<(), WorkspaceOperationError> {
	match try_clone_file_cow(source, destination) {
		Ok(()) => Ok(()),
		Err(error) if cow_is_unsupported(&error) => {
			hardlink_copy_fallback(source, destination).map_err(Into::into)
		},
		Err(error) => Err(error.into()),
	}
}

#[cfg(target_os = "macos")]
fn try_clone_file_cow(source: &Path, destination: &Path) -> io::Result<()> {
	use std::os::unix::ffi::OsStrExt as _;
	let source = CString::new(source.as_os_str().as_bytes())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source path contains NUL"))?;
	let destination = CString::new(destination.as_os_str().as_bytes())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL"))?;
	// SAFETY: both C strings are live, NUL-terminated filesystem paths and flags=0.
	let result = unsafe { libc::clonefile(source.as_ptr(), destination.as_ptr(), 0) };
	if result == 0 {
		Ok(())
	} else {
		Err(io::Error::last_os_error())
	}
}

#[cfg(target_os = "linux")]
fn try_clone_file_cow(source: &Path, destination: &Path) -> io::Result<()> {
	let source = File::open(source)?;
	let output = OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(destination)?;
	const FICLONE: libc::c_ulong = 0x4004_9409;
	// SAFETY: FICLONE reads both valid file descriptors and does not retain them.
	let result = unsafe { libc::ioctl(output.as_raw_fd(), FICLONE, source.as_raw_fd()) };
	if result == 0 {
		Ok(())
	} else {
		let error = io::Error::last_os_error();
		drop(output);
		let _ = fs::remove_file(destination);
		Err(error)
	}
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn try_clone_file_cow(_source: &Path, _destination: &Path) -> io::Result<()> {
	Err(io::Error::from(io::ErrorKind::Unsupported))
}

#[cfg(target_os = "macos")]
fn cow_is_unsupported(error: &io::Error) -> bool {
	matches!(error.raw_os_error(), Some(libc::ENOTSUP | libc::EXDEV))
}

#[cfg(target_os = "linux")]
fn cow_is_unsupported(error: &io::Error) -> bool {
	matches!(
		error.raw_os_error(),
		Some(libc::EOPNOTSUPP | libc::EXDEV | libc::ENOTTY | libc::EINVAL)
	)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn cow_is_unsupported(_error: &io::Error) -> bool {
	true
}

fn hardlink_copy_fallback(source: &Path, destination: &Path) -> io::Result<()> {
	// Probe the cheap same-device path, then immediately break the link before
	// exposing the worktree. A mutable workspace must never share writable
	// inodes with its isolated child.
	if fs::hard_link(source, destination).is_ok() {
		let temporary = destination.with_extension(format!("omp-copy-{}", Ulid::generate()));
		let copied = fs::copy(source, &temporary);
		if let Err(error) = copied {
			let _ = fs::remove_file(destination);
			let _ = fs::remove_file(temporary);
			return Err(error);
		}
		#[cfg(windows)]
		fs::remove_file(destination)?;
		fs::rename(temporary, destination)
	} else {
		fs::copy(source, destination).map(|_| ())
	}
}
fn unix_epoch_ms() -> u64 {
	time::SystemTime::now()
		.duration_since(time::UNIX_EPOCH)
		.map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;

	#[test]
	fn oversized_untracked_content_is_typed_and_prevents_snapshot_capture() {
		let captured = Cell::new(false);
		let error = prepare_isolation_baseline(
			Path::new("/workspace"),
			["large.bin"],
			|_| Ok(ISOLATION_BASELINE_MAX_UNTRACKED_BYTES + 1),
			|| {
				captured.set(true);
				Ok(())
			},
		)
		.expect_err("oversized baseline");
		let WorkspaceOperationError::IsolationBaselineTooLarge(error) = error else {
			panic!("expected typed isolation baseline budget error");
		};
		assert_eq!(error.content_bytes, ISOLATION_BASELINE_MAX_UNTRACKED_BYTES + 1);
		assert!(!captured.get());
	}

	#[cfg(unix)]
	#[test]
	fn untracked_symlink_is_sized_as_the_link_not_its_target() {
		use std::os::unix::fs::symlink;

		let tree = tempfile::tempdir().expect("tree");
		let target = tree.path().join("target.bin");
		File::create(&target)
			.and_then(|file| file.set_len(ISOLATION_BASELINE_MAX_UNTRACKED_BYTES + 1))
			.expect("sparse target");
		let link = tree.path().join("large-link.bin");
		symlink(&target, &link).expect("symlink");

		let link_bytes = untracked_entry_bytes(&link).expect("link size");
		assert_eq!(link_bytes, fs::symlink_metadata(&link).expect("link metadata").len());
		assert!(link_bytes < ISOLATION_BASELINE_MAX_UNTRACKED_BYTES);
		assert!(
			fs::metadata(&link).expect("target metadata").len()
				> ISOLATION_BASELINE_MAX_UNTRACKED_BYTES
		);
	}
}
