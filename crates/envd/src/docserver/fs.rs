use std::{
	collections::VecDeque,
	ffi::{OsStr, OsString},
	fmt,
	io::{self, Read, Seek, SeekFrom, Write},
	path::{Component, Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::SystemTime,
};

use bytes::Bytes;
use cap_std::{
	fs,
	fs::{Dir, Metadata, OpenOptions},
};
#[cfg(test)]
use omp_core::Hash32;
use omp_core::{Str, sf};
#[cfg(test)]
use parking_lot::Mutex;
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
use rustix::fs::RenameFlags;
use xutf::IntoAnsiStripped as _;

use crate::docserver::{Error, FileFingerprint, FileMetadata, Result, ServerConfig};

const STABLE_READ_ATTEMPTS: usize = 4;
const TEMP_CREATE_ATTEMPTS: usize = 128;

/// Whether an operation dereferences its final symbolic-link component.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FollowSymlinks {
	/// Operate on the final directory entry itself.
	No,
	/// Operate on the final link target.
	Yes,
}

/// Portable classification of a filesystem entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileKind {
	/// A regular file.
	RegularFile,
	/// A directory.
	Directory,
	/// A symbolic link observed without dereferencing it.
	SymbolicLink,
	/// A platform-specific special entry.
	Other,
}

/// Portable permission properties reported by and accepted by path operations.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PortablePermissions {
	/// Read-only state, or `None` when a change must preserve it.
	pub read_only:  Option<bool>,
	/// Owner-execute state, or `None` when unavailable or preserved.
	pub executable: Option<bool>,
}

/// Capability-observed metadata for a path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathMetadata {
	/// Absolute confined identity of the selected entry.
	pub path:        PathBuf,
	/// Portable entry kind.
	pub kind:        FileKind,
	/// Host-reported byte length.
	pub byte_length: u64,
	/// Portable permission state.
	pub permissions: PortablePermissions,
	/// Last modification time when available.
	pub modified:    Option<SystemTime>,
	/// Last access time when available.
	pub accessed:    Option<SystemTime>,
	/// Creation time when available.
	pub created:     Option<SystemTime>,
}

/// One immediate child in a deterministic directory listing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryEntry {
	/// Unicode final path component.
	pub name:     Str,
	/// No-follow metadata for the child.
	pub metadata: PathMetadata,
}

/// Treatment of an existing destination entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DestinationOverwritePolicy {
	/// Fail if any destination entry exists.
	FailIfExists,
	/// Replace an existing non-directory entry.
	ReplaceNonDirectory,
	/// For rename only, replace an existing empty directory with a directory.
	ReplaceEmptyDirectory,
}

/// Treatment of an existing leaf during directory creation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExistingDirectoryPolicy {
	/// Fail if the leaf already exists.
	FailIfExists,
	/// Accept an existing directory entry, but not a symlink to one.
	AllowExistingDirectory,
}

/// On-disk representation of a symbolic-link target.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SymlinkTargetForm {
	/// Store an absolute target path.
	Absolute,
	/// Store a path relative to the link parent.
	Relative,
}

/// Portable target-kind hint for platforms that require one.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SymlinkTargetKind {
	/// A non-directory target.
	File,
	/// A directory target.
	Directory,
}

/// Semantic representation of a confined symbolic-link target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SymlinkTarget {
	/// Absolute lexical target location inside the Environment.
	pub path: PathBuf,
	/// Form stored in the symbolic-link entry.
	pub form: SymlinkTargetForm,
}

/// Result of a server-side copy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CopyOutcome {
	/// No-follow metadata for the destination entry.
	pub metadata:     PathMetadata,
	/// Number of regular-file bytes copied, or zero for a copied link.
	pub bytes_copied: u64,
}

/// Exact stable state of document bytes on disk.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DiskState {
	/// A regular file was read without byte transformation.
	Present {
		/// Shared exact file bytes.
		content:     Bytes,
		/// Metadata and exact-content fingerprint from the stable observation.
		fingerprint: FileFingerprint,
	},
	/// No directory entry exists at the document target.
	Missing,
}

impl DiskState {
	/// Returns the fingerprint when the file is present.
	pub const fn fingerprint(&self) -> Option<&FileFingerprint> {
		match self {
			Self::Present { fingerprint, .. } => Some(fingerprint),
			Self::Missing => None,
		}
	}

	/// Returns the exact bytes when the file is present.
	pub const fn content(&self) -> Option<&Bytes> {
		match self {
			Self::Present { content, .. } => Some(content),
			Self::Missing => None,
		}
	}
}

/// Disk state required immediately before committing a prepared replacement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DiskExpectation {
	/// The destination must still be absent.
	Missing,
	/// The destination must still have this exact stable fingerprint.
	Present(FileFingerprint),
}
/// Bounded terminal rows captured after ANSI and control sanitization.
#[derive(Clone, Debug)]
pub struct TerminalRowCapture {
	rows:        VecDeque<Str>,
	max_rows:    usize,
	max_columns: usize,
}

impl TerminalRowCapture {
	/// Creates a capture with fixed row and per-row scalar bounds.
	pub fn new(max_rows: usize, max_columns: usize) -> Self {
		Self {
			rows:        VecDeque::with_capacity(max_rows.min(4096)),
			max_rows:    max_rows.min(4096),
			max_columns: max_columns.min(16 * 1024),
		}
	}

	/// Appends terminal output, retaining only the newest complete bounded rows.
	pub fn push(&mut self, output: &str) {
		for row in output.split(['\r', '\n']) {
			if row.is_empty() && self.rows.back().is_some_and(|last| last.is_empty()) {
				continue;
			}
			if self.max_rows == 0 {
				continue;
			}
			self
				.rows
				.push_back(sanitize_terminal_row(row, self.max_columns));
			while self.rows.len() > self.max_rows {
				self.rows.pop_front();
			}
		}
	}

	/// Iterates captured rows from oldest to newest without allocating.
	pub fn rows(&self) -> impl ExactSizeIterator<Item = &Str> + DoubleEndedIterator + '_ {
		self.rows.iter()
	}
}

/// Removes ANSI escapes and terminal control characters from one bounded row.
pub fn sanitize_terminal_row(row: &str, max_columns: usize) -> Str {
	let stripped = row.to_owned().into_ansi_stripped();
	let mut clean = String::with_capacity(stripped.len().min(max_columns));
	let mut columns = 0usize;
	for character in stripped.chars() {
		if columns >= max_columns {
			break;
		}
		match character {
			'\t' => clean.push(' '),
			character if !character.is_control() => clean.push(character),
			_ => {},
		}
		columns += 1;
	}
	Str::new(clean)
}

/// Result of reconciling an ACP editor buffer with the authoritative disk.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditorBufferState {
	/// Disk still matches the last committed editor buffer.
	InSync(DiskState),
	/// A format-on-save or another writer changed disk; the returned state is
	/// the new authoritative editor buffer.
	Drifted(DiskState),
}

/// Revision-fenced ACP editor write bridge.
///
/// The bridge snapshots exact disk state before each write, commits through
/// [`LocalFs`], and then detects post-save formatter drift without guessing
/// which bytes won.
pub struct EditorBufferSync {
	path:     PathBuf,
	observed: DiskState,
}
/// Prepared replacement minted by one [`EditorBufferSync`] baseline.
pub struct PreparedEditorWrite {
	write: PreparedWrite,
}

impl EditorBufferSync {
	/// Opens one editor buffer from a stable disk snapshot.
	pub fn open(filesystem: &LocalFs, path: impl AsRef<Path>) -> Result<Self> {
		let path = path.as_ref().to_path_buf();
		let observed = filesystem.stable_read(&path)?;
		Ok(Self { path, observed })
	}

	/// Returns the exact bytes currently authoritative for the editor buffer.
	pub const fn observed(&self) -> &DiskState {
		&self.observed
	}

	/// Prepares an atomic editor replacement fenced by the last synchronized
	/// disk revision.
	pub fn prepare_write(
		&self,
		filesystem: &LocalFs,
		content: Bytes,
	) -> Result<PreparedEditorWrite> {
		let expected = match &self.observed {
			DiskState::Present { fingerprint, .. } => DiskExpectation::Present(fingerprint.clone()),
			DiskState::Missing => DiskExpectation::Missing,
		};
		filesystem
			.prepare_write(&self.path, content, expected)
			.map(|write| PreparedEditorWrite { write })
	}

	/// Commits a prepared editor write and makes its exact result the new
	/// synchronization baseline.
	pub fn commit(
		&mut self,
		filesystem: &LocalFs,
		prepared: PreparedEditorWrite,
	) -> Result<&DiskState> {
		self.observed = filesystem.commit_prepared(prepared.write)?;
		Ok(&self.observed)
	}

	/// Re-reads after format-on-save and reports whether the editor buffer must
	/// be replaced with formatter-authored bytes.
	pub fn reconcile_after_save(&mut self, filesystem: &LocalFs) -> Result<EditorBufferState> {
		let current = filesystem.stable_read(&self.path)?;
		let drifted = current != self.observed;
		self.observed = current.clone();
		Ok(if drifted {
			EditorBufferState::Drifted(current)
		} else {
			EditorBufferState::InSync(current)
		})
	}
}

#[cfg(test)]
type MutationHook = Box<dyn FnMut(MutationStage, &Path) + Send>;
struct LocalFsInner {
	root:               Dir,
	root_path:          PathBuf,
	max_document_bytes: u64,
	temp_sequence:      AtomicU64,
	#[cfg(test)]
	mutation_hook:      Mutex<Option<MutationHook>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MutationStage {
	BeforeWrite,
	AfterWrite,
	BeforeDelete,
	AfterDelete,
	BeforeMove,
	AfterMove,
	BeforeTemporaryInstall,
	AfterTemporaryInstall,
	BeforePermissions,
}

/// Synchronous capability-rooted local filesystem operations.
#[derive(Clone)]
pub struct LocalFs {
	inner: Arc<LocalFsInner>,
}

impl fmt::Debug for LocalFs {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("LocalFs")
			.field("root_path", &self.inner.root_path)
			.finish_non_exhaustive()
	}
}

/// A fully written same-directory temporary awaiting an actor-owned commit.
#[must_use]
pub struct PreparedWrite {
	owner:            Arc<LocalFsInner>,
	parent:           Dir,
	parent_relative:  PathBuf,
	parent_identity:  DirectoryIdentity,
	destination_path: PathBuf,
	destination_name: OsString,
	temporary_name:   OsString,
	expected:         DiskExpectation,
	committed:        bool,
	installed_state:  DiskState,
}

impl fmt::Debug for PreparedWrite {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("PreparedWrite")
			.field("destination_path", &self.destination_path)
			.field("temporary_name", &self.temporary_name)
			.field("expected", &self.expected)
			.finish_non_exhaustive()
	}
}

impl Drop for PreparedWrite {
	fn drop(&mut self) {
		if !self.committed {
			let _ = self.parent.remove_file(&self.temporary_name);
		}
	}
}

/// A confined file deletion awaiting an exact-state commit.
pub struct PreparedDelete {
	owner:  Arc<LocalFsInner>,
	target: PreparedEntry,
}

impl fmt::Debug for PreparedDelete {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("PreparedDelete")
			.field("path", &self.target.path)
			.field("expected", &self.target.expected)
			.finish_non_exhaustive()
	}
}

/// A confined file move awaiting exact source and destination checks.
pub struct PreparedMove {
	owner:       Arc<LocalFsInner>,
	source:      PreparedEntry,
	destination: PreparedEntry,
	content:     Option<PreparedWrite>,
}

impl fmt::Debug for PreparedMove {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("PreparedMove")
			.field("source", &self.source.path)
			.field("destination", &self.destination.path)
			.field("source_expected", &self.source.expected)
			.field("destination_expected", &self.destination.expected)
			.field("replaces_content", &self.content.is_some())
			.finish_non_exhaustive()
	}
}

struct PreparedEntry {
	parent:          Dir,
	parent_relative: PathBuf,
	parent_identity: DirectoryIdentity,
	path:            PathBuf,
	name:            OsString,
	expected:        DiskExpectation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ReadObservation {
	Missing,
	Present { content: Bytes, metadata: FileMetadata },
	Unstable,
}

#[derive(Debug)]
struct ResolvedPath {
	absolute: PathBuf,
	relative: PathBuf,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
	device: u64,
	inode:  u64,
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
	volume:     Option<u32>,
	file_index: Option<u64>,
}
#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
	device: u64,
	inode:  u64,
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
	volume:     Option<u32>,
	file_index: Option<u64>,
}

#[cfg(not(any(unix, windows)))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity;

#[cfg(not(any(unix, windows)))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity;

impl LocalFs {
	/// Opens the configured Environment root as the sole ambient capability.
	pub fn new(config: &ServerConfig) -> Result<Self> {
		let root_path = config.environment_root().to_path_buf();
		let root = config.clone_root()?;
		Ok(Self {
			inner: Arc::new(LocalFsInner {
				root,
				root_path,
				max_document_bytes: config.max_document_bytes().get(),
				temp_sequence: AtomicU64::new(0),
				#[cfg(test)]
				mutation_hook: Mutex::new(None),
			}),
		})
	}

	/// Returns the canonical ambient identity of the capability root.
	pub fn root_path(&self) -> &Path {
		&self.inner.root_path
	}

	#[cfg(test)]
	fn set_mutation_hook(&self, hook: impl FnMut(MutationStage, &Path) + Send + 'static) {
		*self.inner.mutation_hook.lock() = Some(Box::new(hook));
	}

	#[cfg(test)]
	fn run_mutation_hook(this: &Self, stage: MutationStage, path: &Path) {
		if let Some(hook) = this.inner.mutation_hook.lock().as_mut() {
			hook(stage, path);
		}
	}

	#[cfg(not(test))]
	const fn run_mutation_hook(_: &Self, _: MutationStage, _: &Path) {}

	/// Canonicalizes an existing path while rejecting any capability escape.
	pub fn canonicalize(&self, path: impl AsRef<Path>) -> Result<PathBuf> {
		let relative = self.lexical_relative(path.as_ref())?;
		let canonical = self.canonicalize_existing(&relative, path.as_ref())?;
		Ok(self.absolute_for(&canonical))
	}

	/// Reads exact document bytes and verifies two matching observations.
	pub fn stable_read(&self, path: impl AsRef<Path>) -> Result<DiskState> {
		let path = path.as_ref();
		let resolved = self.resolve_target(path)?;
		let (parent, name) = self.open_parent(&resolved)?;
		self.stable_read_at(&parent, &name, &resolved.absolute)
	}

	fn ensure_document_size(&self, path: &Path, byte_length: u64) -> Result<()> {
		if byte_length > self.inner.max_document_bytes {
			return Err(Error::InvalidContent {
				reason: sf!(
					"document {} is {byte_length} bytes; the configured limit is {} bytes",
					path.display(),
					self.inner.max_document_bytes
				),
			});
		}
		Ok(())
	}

	/// Writes and synchronizes a collision-safe temporary beside its
	/// destination.
	///
	/// This method never renames the temporary. Only [`Self::commit_prepared`]
	/// performs the final replacement.
	pub fn prepare_write(
		&self,
		path: impl AsRef<Path>,
		content: Bytes,
		expected: DiskExpectation,
	) -> Result<PreparedWrite> {
		self.ensure_document_size(path.as_ref(), u64::try_from(content.len()).unwrap_or(u64::MAX))?;
		let resolved = self.resolve_target(path.as_ref())?;
		let (parent_relative, _) = Self::split_relative(&resolved.relative)
			.ok_or_else(|| Self::invalid_argument(&resolved.absolute, "path has no parent entry"))?;
		let (parent, destination_name) = self.open_parent(&resolved)?;
		let parent_identity = Self::directory_identity(&parent).map_err(|source| {
			Self::io_error("identify prepared-write parent", &resolved.absolute, source)
		})?;
		let existing_permissions = match parent.metadata(&destination_name) {
			Ok(metadata) => Some(metadata.permissions()),
			Err(source) if source.kind() == io::ErrorKind::NotFound => None,
			Err(source) => {
				return Err(Self::io_error(
					"inspect replacement permissions",
					&resolved.absolute,
					source,
				));
			},
		};
		let (temporary_name, mut file) = self.create_temporary(&parent, &destination_name)?;
		let prepared = (|| -> Result<DiskState> {
			file
				.write_all(&content)
				.map_err(|source| Self::persistence_error(&resolved.absolute, source))?;
			if let Some(permissions) = existing_permissions {
				file
					.set_permissions(permissions)
					.map_err(|source| Self::persistence_error(&resolved.absolute, source))?;
			}
			file
				.flush()
				.map_err(|source| Self::persistence_error(&resolved.absolute, source))?;
			file
				.sync_all()
				.map_err(|source| Self::persistence_error(&resolved.absolute, source))?;
			let metadata = file
				.metadata()
				.map_err(|source| Self::persistence_error(&resolved.absolute, source))?;
			let fingerprint =
				FileFingerprint::for_content(Self::fingerprint_metadata(&metadata), &content);
			Ok(DiskState::Present { content: content.clone(), fingerprint })
		})();
		let installed_state = match prepared {
			Ok(state) => state,
			Err(error) => {
				let _ = parent.remove_file(&temporary_name);
				return Err(error);
			},
		};
		Ok(PreparedWrite {
			owner: Arc::clone(&self.inner),
			parent,
			parent_relative,
			parent_identity,
			destination_path: resolved.absolute,
			destination_name,
			temporary_name,
			expected,
			committed: false,
			installed_state,
		})
	}

	/// Writes a prepared replacement and applies an exact Unix mode to the
	/// temporary before it can become visible.
	pub fn prepare_write_with_mode(
		&self,
		path: impl AsRef<Path>,
		content: Bytes,
		expected: DiskExpectation,
		mode: u32,
	) -> Result<PreparedWrite> {
		let prepared = self.prepare_write(path, content, expected)?;
		if mode == 0 {
			return Ok(prepared);
		}
		#[cfg(unix)]
		{
			use cap_std::fs::PermissionsExt;

			let file = prepared
				.parent
				.open(&prepared.temporary_name)
				.map_err(|source| Self::persistence_error(&prepared.destination_path, source))?;
			let mut permissions = file
				.metadata()
				.map_err(|source| Self::persistence_error(&prepared.destination_path, source))?
				.permissions();
			permissions.set_mode(mode);
			file
				.set_permissions(permissions)
				.map_err(|source| Self::persistence_error(&prepared.destination_path, source))?;
		}
		#[cfg(not(unix))]
		{
			return Err(Self::io_error(
				"set prepared write mode",
				&prepared.destination_path,
				io::Error::new(
					io::ErrorKind::Unsupported,
					"exact file modes are unavailable on this platform",
				),
			));
		}
		Ok(prepared)
	}

	/// Rechecks the expected disk state, atomically renames, and flushes the
	/// parent.
	///
	/// The document actor is the intended sole caller of this synchronous final
	/// commit operation.
	pub fn commit_prepared(&self, mut prepared: PreparedWrite) -> Result<DiskState> {
		if !Arc::ptr_eq(&self.inner, &prepared.owner) {
			return Err(Error::InvalidTarget {
				target: Str::new(prepared.destination_path.to_string_lossy()),
				reason: sf!("prepared write belongs to another filesystem root"),
			});
		}
		if !self.prepared_parent_is_current(&prepared)? {
			return Err(Error::StaleDiskState { path: prepared.destination_path.clone() });
		}
		Self::run_mutation_hook(self, MutationStage::BeforeWrite, &prepared.destination_path);
		match &prepared.expected {
			DiskExpectation::Missing => {
				Self::rename_noreplace(
					&prepared.parent,
					&prepared.temporary_name,
					&prepared.parent,
					&prepared.destination_name,
				)
				.map_err(|source| {
					if source.kind() == io::ErrorKind::AlreadyExists {
						Error::StaleDiskState { path: prepared.destination_path.clone() }
					} else {
						Self::persistence_error(&prepared.destination_path, source)
					}
				})?;
				Self::run_mutation_hook(self, MutationStage::AfterWrite, &prepared.destination_path);
			},
			DiskExpectation::Present(expected) => {
				Self::rename_exchange(
					&prepared.parent,
					&prepared.temporary_name,
					&prepared.parent,
					&prepared.destination_name,
				)
				.map_err(|source| {
					if source.kind() == io::ErrorKind::NotFound {
						Error::StaleDiskState { path: prepared.destination_path.clone() }
					} else {
						Self::persistence_error(&prepared.destination_path, source)
					}
				})?;
				Self::run_mutation_hook(self, MutationStage::AfterWrite, &prepared.destination_path);
				let displaced = self.stable_read_at(
					&prepared.parent,
					&prepared.temporary_name,
					&prepared.destination_path,
				);
				let matches = displaced.as_ref().is_ok_and(|state| {
					matches!(
						state,
						DiskState::Present { fingerprint, .. } if fingerprint == expected
					)
				});
				if !matches {
					if Self::rename_exchange(
						&prepared.parent,
						&prepared.temporary_name,
						&prepared.parent,
						&prepared.destination_name,
					)
					.is_ok()
					{
						return Err(Error::StaleDiskState { path: prepared.destination_path.clone() });
					}
					prepared.committed = true;
					return Ok(prepared.installed_state.clone());
				}
				prepared.committed = true;
				let _ = prepared.parent.remove_file(&prepared.temporary_name);
			},
		}
		prepared.committed = true;
		let _ = Self::flush_directory(&prepared.parent, &prepared.destination_path);
		Ok(prepared.installed_state.clone())
	}

	/// Captures a confined file entry for a later exact-state deletion.
	pub fn prepare_delete(
		&self,
		path: impl AsRef<Path>,
		expected: DiskExpectation,
	) -> Result<PreparedDelete> {
		let target = self.prepare_entry(path.as_ref(), expected, "prepare delete")?;
		Ok(PreparedDelete { owner: Arc::clone(&self.inner), target })
	}

	/// Deletes a prepared file only while its parent and exact state remain
	/// current.
	pub fn commit_prepared_delete(&self, prepared: PreparedDelete) -> Result<DiskState> {
		self.verify_prepared_owner(&prepared.owner, &prepared.target.path, "delete")?;
		if !self.prepared_entry_parent_is_current(&prepared.target)? {
			return Err(Self::stale_entry(&prepared.target));
		}
		if matches!(&prepared.target.expected, DiskExpectation::Missing) {
			return match self.stable_expected_state(&prepared.target)? {
				DiskState::Missing => Ok(DiskState::Missing),
				DiskState::Present { .. } => Err(Self::stale_entry(&prepared.target)),
			};
		}
		Self::run_mutation_hook(self, MutationStage::BeforeDelete, &prepared.target.path);
		let mut quarantine = None;
		for _ in 0..TEMP_CREATE_ATTEMPTS {
			let candidate = self.next_temporary_name(&prepared.target.name);
			match Self::rename_noreplace(
				&prepared.target.parent,
				&prepared.target.name,
				&prepared.target.parent,
				&candidate,
			) {
				Ok(()) => {
					quarantine = Some(candidate);
					Self::run_mutation_hook(self, MutationStage::AfterDelete, &prepared.target.path);
					break;
				},
				Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {},
				Err(source) if source.kind() == io::ErrorKind::NotFound => {
					return Err(Self::stale_entry(&prepared.target));
				},
				Err(source) => {
					return Err(Self::persistence_error(&prepared.target.path, source));
				},
			}
		}
		let quarantine = quarantine.ok_or_else(|| {
			Self::persistence_error(
				&prepared.target.path,
				io::Error::new(
					io::ErrorKind::AlreadyExists,
					"could not allocate a deletion quarantine name",
				),
			)
		})?;
		let displaced =
			self.stable_read_at(&prepared.target.parent, &quarantine, &prepared.target.path);
		if !displaced
			.as_ref()
			.is_ok_and(|state| Self::expectation_matches(&prepared.target.expected, state))
		{
			if Self::rename_noreplace(
				&prepared.target.parent,
				&quarantine,
				&prepared.target.parent,
				&prepared.target.name,
			)
			.is_ok()
			{
				return Err(Self::stale_entry(&prepared.target));
			}
			// The entry is already absent and cannot be restored without risking
			// a newer path occupant. Preserve it in quarantine and report the
			// applied removal.
			return Ok(DiskState::Missing);
		}
		let _ = prepared.target.parent.remove_file(&quarantine);
		let _ = Self::flush_directory(&prepared.target.parent, &prepared.target.path);
		Ok(DiskState::Missing)
	}

	/// Captures confined source and destination entries for a later exact-state
	/// move.
	pub fn prepare_move(
		&self,
		source: impl AsRef<Path>,
		destination: impl AsRef<Path>,
		source_expected: DiskExpectation,
		destination_expected: DiskExpectation,
	) -> Result<PreparedMove> {
		if matches!(&source_expected, DiskExpectation::Missing) {
			return Err(Self::invalid_argument(
				source.as_ref(),
				"a prepared move requires an exact-present source",
			));
		}
		let source = self.prepare_entry(source.as_ref(), source_expected, "prepare move source")?;
		let destination = self.prepare_entry(
			destination.as_ref(),
			destination_expected,
			"prepare move destination",
		)?;
		if Self::directory_identities_match(source.parent_identity, destination.parent_identity)
			&& source.name == destination.name
		{
			return Err(Self::invalid_argument(
				&source.path,
				"move source and destination are the same entry",
			));
		}
		Self::reject_prepared_move_directory(&source)?;
		Self::reject_prepared_move_directory(&destination)?;
		Ok(PreparedMove { owner: Arc::clone(&self.inner), source, destination, content: None })
	}

	/// Stages exact final bytes for an atomic move-with-content commit.
	pub fn prepare_move_with_content(
		&self,
		source: impl AsRef<Path>,
		destination: impl AsRef<Path>,
		content: Bytes,
		source_expected: DiskExpectation,
		destination_expected: DiskExpectation,
	) -> Result<PreparedMove> {
		let mut prepared = self.prepare_move(
			source,
			destination.as_ref(),
			source_expected,
			destination_expected.clone(),
		)?;
		prepared.content = Some(self.prepare_write(destination, content, destination_expected)?);
		Ok(prepared)
	}

	/// Moves a prepared file only while both parents and exact states remain
	/// current.
	pub fn commit_prepared_move(&self, mut prepared: PreparedMove) -> Result<DiskState> {
		self.verify_prepared_owner(&prepared.owner, &prepared.source.path, "move")?;
		if !self.prepared_entry_parent_is_current(&prepared.source)?
			|| !self.prepared_entry_parent_is_current(&prepared.destination)?
		{
			return Err(Self::stale_entry(&prepared.source));
		}
		if !Self::directories_share_filesystem(
			prepared.source.parent_identity,
			prepared.destination.parent_identity,
		) {
			return Err(Self::io_error(
				"move prepared file",
				&prepared.source.path,
				io::Error::new(
					io::ErrorKind::InvalidInput,
					"source and destination are on different filesystems",
				),
			));
		}
		Self::run_mutation_hook(self, MutationStage::BeforeMove, &prepared.destination.path);
		let source_state = self.stable_expected_state(&prepared.source)?;
		if !Self::expectation_matches(&prepared.source.expected, &source_state) {
			return Err(Self::stale_entry(&prepared.source));
		}
		if let Some(content) = prepared.content.take() {
			let destination_state = self.stable_expected_state(&prepared.destination)?;
			if !Self::expectation_matches(&prepared.destination.expected, &destination_state) {
				return Err(Self::stale_entry(&prepared.destination));
			}
			let mut quarantine = None;
			for _ in 0..TEMP_CREATE_ATTEMPTS {
				let candidate = self.next_temporary_name(&prepared.source.name);
				match Self::rename_noreplace(
					&prepared.source.parent,
					&prepared.source.name,
					&prepared.source.parent,
					&candidate,
				) {
					Ok(()) => {
						quarantine = Some(candidate);
						break;
					},
					Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
					Err(error) => {
						return Err(Self::persistence_error(&prepared.source.path, error));
					},
				}
			}
			let quarantine = quarantine.ok_or_else(|| {
				Self::persistence_error(
					&prepared.source.path,
					io::Error::new(
						io::ErrorKind::AlreadyExists,
						"could not allocate a move source quarantine name",
					),
				)
			})?;
			let installed = match self.commit_prepared(content) {
				Ok(installed) => installed,
				Err(error) => {
					if Self::rename_noreplace(
						&prepared.source.parent,
						&quarantine,
						&prepared.source.parent,
						&prepared.source.name,
					)
					.is_err()
					{
						return Err(Self::persistence_error(
							&prepared.source.path,
							io::Error::other("move-with-content rollback failed"),
						));
					}
					return Err(error);
				},
			};
			Self::run_mutation_hook(self, MutationStage::AfterMove, &prepared.destination.path);
			let _ = prepared.source.parent.remove_file(&quarantine);
			let same_parent = Self::directory_identities_match(
				prepared.source.parent_identity,
				prepared.destination.parent_identity,
			);
			let _ = Self::flush_directory(&prepared.destination.parent, &prepared.destination.path);
			if !same_parent {
				let _ = Self::flush_directory(&prepared.source.parent, &prepared.source.path);
			}
			return Ok(installed);
		}
		let exchanged = matches!(&prepared.destination.expected, DiskExpectation::Present(_));
		let mutation = if exchanged {
			Self::rename_exchange(
				&prepared.source.parent,
				&prepared.source.name,
				&prepared.destination.parent,
				&prepared.destination.name,
			)
		} else {
			Self::rename_noreplace(
				&prepared.source.parent,
				&prepared.source.name,
				&prepared.destination.parent,
				&prepared.destination.name,
			)
		};
		mutation.map_err(|source| {
			if matches!(
				source.kind(),
				std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::NotFound
			) {
				Self::stale_entry(&prepared.destination)
			} else {
				Self::persistence_error(&prepared.source.path, source)
			}
		})?;
		Self::run_mutation_hook(self, MutationStage::AfterMove, &prepared.destination.path);
		if exchanged {
			let displaced_matches = self
				.stable_read_at(&prepared.source.parent, &prepared.source.name, &prepared.source.path)
				.as_ref()
				.is_ok_and(|state| Self::expectation_matches(&prepared.destination.expected, state));
			if !displaced_matches {
				if Self::rename_exchange(
					&prepared.source.parent,
					&prepared.source.name,
					&prepared.destination.parent,
					&prepared.destination.name,
				)
				.is_ok()
				{
					return Err(Self::stale_entry(&prepared.destination));
				}
				// The exchange linearized and could not be rolled back safely.
				// Return the source state captured before the atomic move.
				return Ok(source_state);
			}
		}
		if exchanged {
			let _ = prepared.source.parent.remove_file(&prepared.source.name);
		}
		let same_parent = Self::directory_identities_match(
			prepared.source.parent_identity,
			prepared.destination.parent_identity,
		);
		let _ = Self::flush_directory(&prepared.destination.parent, &prepared.destination.path);
		if !same_parent {
			let _ = Self::flush_directory(&prepared.source.parent, &prepared.source.path);
		}
		Ok(source_state)
	}

	/// Returns stat or lstat metadata according to `follow`.
	pub fn stat(&self, path: impl AsRef<Path>, follow: FollowSymlinks) -> Result<PathMetadata> {
		let path = path.as_ref();
		let resolved = match follow {
			FollowSymlinks::No => self.resolve_entry(path)?,
			FollowSymlinks::Yes => self.resolve_target(path)?,
		};
		let metadata = match follow {
			FollowSymlinks::No => self.inner.root.symlink_metadata(&resolved.relative),
			FollowSymlinks::Yes => self.inner.root.metadata(&resolved.relative),
		}
		.map_err(|source| Self::io_error("inspect path metadata", &resolved.absolute, source))?;
		Ok(Self::path_metadata(resolved.absolute, &metadata))
	}

	/// Lists immediate children in deterministic Unicode-name order.
	pub fn list_directory(
		&self,
		path: impl AsRef<Path>,
		follow: FollowSymlinks,
	) -> Result<Vec<DirectoryEntry>> {
		let path = path.as_ref();
		let resolved = match follow {
			FollowSymlinks::No => self.resolve_entry(path)?,
			FollowSymlinks::Yes => self.resolve_target(path)?,
		};
		if follow == FollowSymlinks::No {
			let metadata = self
				.inner
				.root
				.symlink_metadata(&resolved.relative)
				.map_err(|source| {
					Self::io_error("inspect directory entry", &resolved.absolute, source)
				})?;
			if !metadata.is_dir() {
				return Err(Self::io_error(
					"list directory",
					&resolved.absolute,
					io::Error::new(io::ErrorKind::NotADirectory, "selected entry is not a directory"),
				));
			}
		}
		let iterator = self
			.inner
			.root
			.read_dir(&resolved.relative)
			.map_err(|source| Self::io_error("list directory", &resolved.absolute, source))?;
		let mut entries = Vec::new();
		for entry in iterator {
			let entry = entry
				.map_err(|source| Self::io_error("read directory entry", &resolved.absolute, source))?;
			let file_name = entry.file_name();
			let Some(name) = file_name.to_str() else {
				return Err(Error::InvalidTarget {
					target: Str::new(resolved.absolute.to_string_lossy()),
					reason: sf!("directory contains a non-Unicode entry name"),
				});
			};
			let child_relative = resolved.relative.join(&file_name);
			let child_absolute = resolved.absolute.join(&file_name);
			let metadata = self
				.inner
				.root
				.symlink_metadata(&child_relative)
				.map_err(|source| Self::io_error("inspect directory child", &child_absolute, source))?;
			entries.push(DirectoryEntry {
				name:     Str::new(name),
				metadata: Self::path_metadata(child_absolute, &metadata),
			});
		}
		entries.sort_unstable_by(|left, right| left.name.as_str().cmp(right.name.as_str()));
		Ok(entries)
	}

	/// Creates one directory or a complete missing parent chain.
	pub fn create_directory(
		&self,
		path: impl AsRef<Path>,
		recursive: bool,
		existing: ExistingDirectoryPolicy,
	) -> Result<PathMetadata> {
		let path = path.as_ref();
		let requested_relative = self.lexical_relative(path)?;
		let relative = if recursive {
			self.resolve_creation_relative(&requested_relative, path)?
		} else {
			self.resolve_entry(path)?.relative
		};
		if relative == Path::new(".") {
			return match existing {
				ExistingDirectoryPolicy::AllowExistingDirectory => {
					self.stat(&self.inner.root_path, FollowSymlinks::No)
				},
				ExistingDirectoryPolicy::FailIfExists => {
					Err(Self::already_exists("create directory", path))
				},
			};
		}
		let absolute = self.absolute_for(&relative);
		match self.inner.root.symlink_metadata(&relative) {
			Ok(metadata) => {
				if existing == ExistingDirectoryPolicy::AllowExistingDirectory && metadata.is_dir() {
					return Ok(Self::path_metadata(absolute, &metadata));
				}
				return Err(Self::already_exists("create directory", path));
			},
			Err(source) if source.kind() == io::ErrorKind::NotFound => {},
			Err(source) => return Err(Self::io_error("inspect directory destination", path, source)),
		}
		let result = if recursive {
			self.inner.root.create_dir_all(&relative)
		} else {
			self.inner.root.create_dir(&relative)
		};
		result.map_err(|source| Self::io_error("create directory", &absolute, source))?;
		self.stat(absolute, FollowSymlinks::No)
	}

	/// Removes one exact final entry through its already-open parent handle.
	///
	/// The final component is first moved to a collision-safe quarantine name,
	/// then its inode identity is rechecked before deletion. A symlink is
	/// removed as a link and is never followed.
	pub fn remove_no_follow_if(
		&self,
		path: impl AsRef<Path>,
		expected_present: bool,
		recursive: bool,
	) -> Result<DiskState> {
		let resolved = self.resolve_entry(path.as_ref())?;
		Self::reject_root_entry(&resolved, "remove")?;
		let (parent_relative, _) = Self::split_relative(&resolved.relative)
			.ok_or_else(|| Self::invalid_argument(&resolved.absolute, "path has no parent entry"))?;
		let (parent, name) = self.open_parent(&resolved)?;
		let parent_identity = Self::directory_identity(&parent)
			.map_err(|source| Self::io_error("identify removal parent", &resolved.absolute, source))?;
		let metadata = match parent.symlink_metadata(&name) {
			Ok(_) if !expected_present => {
				return Err(Error::StaleDiskState { path: resolved.absolute });
			},
			Ok(metadata) => metadata,
			Err(source) if source.kind() == io::ErrorKind::NotFound && !expected_present => {
				return Ok(DiskState::Missing);
			},
			Err(source) if source.kind() == io::ErrorKind::NotFound => {
				return Err(Error::StaleDiskState { path: resolved.absolute });
			},
			Err(source) => {
				return Err(Self::io_error("inspect removal target", &resolved.absolute, source));
			},
		};
		if metadata.is_dir() && !recursive {
			return Err(Self::io_error(
				"remove directory",
				&resolved.absolute,
				io::Error::new(io::ErrorKind::IsADirectory, "recursive removal was not approved"),
			));
		}
		let expected_identity = Self::metadata_file_identity(&metadata);
		let quarantine = self.unique_temporary_name(&parent, &name, |candidate| {
			Self::rename_noreplace(&parent, &name, &parent, candidate)
		})?;
		if !self.prepared_parent_is_current_parts(
			&parent_relative,
			parent_identity,
			&resolved.absolute,
		)? {
			let _ = Self::rename_noreplace(&parent, &quarantine, &parent, &name);
			return Err(Error::StaleDiskState { path: resolved.absolute });
		}
		let displaced = parent.symlink_metadata(&quarantine).map_err(|source| {
			Self::io_error("reinspect quarantined removal target", &resolved.absolute, source)
		})?;
		if Self::metadata_file_identity(&displaced) != expected_identity {
			let _ = Self::rename_noreplace(&parent, &quarantine, &parent, &name);
			return Err(Error::StaleDiskState { path: resolved.absolute });
		}
		let removed = if displaced.is_dir() {
			parent.remove_dir_all(&quarantine)
		} else {
			parent.remove_file(&quarantine)
		};
		removed.map_err(|source| Self::persistence_error(&resolved.absolute, source))?;
		Self::flush_directory(&parent, &resolved.absolute)?;
		Ok(DiskState::Missing)
	}

	/// Removes a file, link, empty directory, or recursively a directory tree.
	pub fn remove(&self, path: impl AsRef<Path>, recursive: bool) -> Result<()> {
		let resolved = self.resolve_entry(path.as_ref())?;
		Self::reject_root_entry(&resolved, "remove")?;
		let metadata = self
			.inner
			.root
			.symlink_metadata(&resolved.relative)
			.map_err(|source| Self::io_error("inspect removal target", &resolved.absolute, source))?;
		let result = if metadata.is_dir() {
			if recursive {
				self.inner.root.remove_dir_all(&resolved.relative)
			} else {
				self.inner.root.remove_dir(&resolved.relative)
			}
		} else {
			self.inner.root.remove_file(&resolved.relative)
		};
		result.map_err(|source| Self::io_error("remove path", &resolved.absolute, source))
	}

	/// Renames a directory entry without following its final symbolic link.
	pub fn rename(
		&self,
		source: impl AsRef<Path>,
		destination: impl AsRef<Path>,
		overwrite: DestinationOverwritePolicy,
	) -> Result<PathMetadata> {
		let source = self.resolve_entry(source.as_ref())?;
		let destination = self.resolve_entry(destination.as_ref())?;
		Self::reject_root_entry(&source, "rename")?;
		Self::reject_root_entry(&destination, "rename")?;
		let source_metadata = self
			.inner
			.root
			.symlink_metadata(&source.relative)
			.map_err(|error| Self::io_error("inspect rename source", &source.absolute, error))?;
		self.check_rename_destination(&destination, overwrite, source_metadata.is_dir())?;
		let (source_parent, source_name) = self.open_parent(&source)?;
		let (destination_parent, destination_name) = self.open_parent(&destination)?;
		source_parent
			.rename(source_name, &destination_parent, destination_name)
			.map_err(|error| Self::io_error("rename path", &source.absolute, error))?;
		Self::flush_directory(&destination_parent, &destination.absolute)?;
		self.stat(destination.absolute, FollowSymlinks::No)
	}

	/// Copies one regular file or, without following, recreates one symbolic
	/// link.
	pub fn copy(
		&self,
		source: impl AsRef<Path>,
		destination: impl AsRef<Path>,
		follow_source: FollowSymlinks,
		overwrite: DestinationOverwritePolicy,
	) -> Result<CopyOutcome> {
		if overwrite == DestinationOverwritePolicy::ReplaceEmptyDirectory {
			return Err(Self::invalid_argument(
				destination.as_ref(),
				"copy cannot replace a directory",
			));
		}
		let source = match follow_source {
			FollowSymlinks::No => self.resolve_entry(source.as_ref())?,
			FollowSymlinks::Yes => self.resolve_target(source.as_ref())?,
		};
		let destination = self.resolve_entry(destination.as_ref())?;
		Self::reject_root_entry(&destination, "copy")?;
		let source_metadata = match follow_source {
			FollowSymlinks::No => self.inner.root.symlink_metadata(&source.relative),
			FollowSymlinks::Yes => self.inner.root.metadata(&source.relative),
		}
		.map_err(|error| Self::io_error("inspect copy source", &source.absolute, error))?;
		if source_metadata.is_dir() {
			return Err(Self::io_error(
				"copy path",
				&source.absolute,
				io::Error::new(
					io::ErrorKind::IsADirectory,
					"recursive directory copy is not supported",
				),
			));
		}
		if !source_metadata.is_file() && !source_metadata.is_symlink() {
			return Err(Self::invalid_argument(
				&source.absolute,
				"copy source is not a regular file or symbolic link",
			));
		}
		let (destination_parent, destination_name) = self.open_parent(&destination)?;
		self.check_non_directory_destination(&destination, overwrite)?;
		let (temporary_name, bytes_copied) = if source_metadata.is_symlink() {
			let target = self
				.inner
				.root
				.read_link_contents(&source.relative)
				.map_err(|error| {
					Self::io_error("read copied symbolic link", &source.absolute, error)
				})?;
			let target_kind = if self
				.inner
				.root
				.metadata(&source.relative)
				.is_ok_and(|metadata| metadata.is_dir())
			{
				SymlinkTargetKind::Directory
			} else {
				SymlinkTargetKind::File
			};
			let temporary_name = self.create_temporary_symlink(
				&destination_parent,
				&destination_name,
				&target,
				target_kind,
			)?;
			(temporary_name, 0)
		} else {
			let (temporary_name, reservation) =
				self.create_temporary(&destination_parent, &destination_name)?;
			drop(reservation);
			let copied = self
				.inner
				.root
				.copy(&source.relative, &destination_parent, &temporary_name);
			let bytes_copied = match copied {
				Ok(bytes_copied) => bytes_copied,
				Err(copy_error) => {
					let _ = destination_parent.remove_file(&temporary_name);
					return Err(Self::io_error("copy regular file", &source.absolute, copy_error));
				},
			};
			let copied_file = destination_parent.open(&temporary_name).map_err(|source| {
				Self::io_error("open copied temporary", &destination.absolute, source)
			})?;
			if let Err(source) = copied_file.sync_all() {
				let _ = destination_parent.remove_file(&temporary_name);
				return Err(Self::io_error("flush copied temporary", &destination.absolute, source));
			}
			(temporary_name, bytes_copied)
		};
		let metadata = match self.finish_temporary_entry(
			&destination_parent,
			&temporary_name,
			&destination_name,
			&destination,
			overwrite,
		) {
			Ok(metadata) => metadata,
			Err(error) => {
				let _ = destination_parent.remove_file(&temporary_name);
				return Err(error);
			},
		};
		Ok(CopyOutcome { metadata, bytes_copied })
	}

	/// Reads a symbolic link without dereferencing it and returns its confined
	/// semantic target.
	pub fn read_link(&self, path: impl AsRef<Path>) -> Result<SymlinkTarget> {
		let resolved = self.resolve_entry(path.as_ref())?;
		let raw = self
			.inner
			.root
			.read_link_contents(&resolved.relative)
			.map_err(|error| Self::io_error("read symbolic link", &resolved.absolute, error))?;
		let (parent_relative, _) = Self::split_relative(&resolved.relative).ok_or_else(|| {
			Self::invalid_argument(&resolved.absolute, "Environment root is not a symbolic-link entry")
		})?;
		let (target_relative, form) = if raw.is_absolute() {
			(self.normalize_absolute_target(&raw, &resolved.absolute)?, SymlinkTargetForm::Absolute)
		} else {
			(
				Self::normalize_from(&parent_relative, &raw, &resolved.absolute)?,
				SymlinkTargetForm::Relative,
			)
		};
		Ok(SymlinkTarget { path: self.absolute_for(&target_relative), form })
	}

	/// Creates a symbolic link without requiring its target to exist.
	pub fn create_symlink(
		&self,
		target: &SymlinkTarget,
		link: impl AsRef<Path>,
		target_kind: SymlinkTargetKind,
		overwrite: DestinationOverwritePolicy,
	) -> Result<PathMetadata> {
		if overwrite == DestinationOverwritePolicy::ReplaceEmptyDirectory {
			return Err(Self::invalid_argument(
				link.as_ref(),
				"symbolic links cannot replace directories",
			));
		}
		let target_relative = self.normalize_semantic_path(&target.path, &target.path)?;
		let link = self.resolve_entry(link.as_ref())?;
		Self::reject_root_entry(&link, "create symbolic link")?;
		let (link_parent_relative, _) = Self::split_relative(&link.relative).ok_or_else(|| {
			Self::invalid_argument(&link.absolute, "Environment root cannot be a symbolic-link entry")
		})?;
		let raw_target = match target.form {
			SymlinkTargetForm::Absolute => self.absolute_for(&target_relative),
			SymlinkTargetForm::Relative => {
				Self::relative_path_between(&link_parent_relative, &target_relative)
			},
		};
		let (parent, link_name) = self.open_parent(&link)?;
		self.check_non_directory_destination(&link, overwrite)?;
		let temporary_name =
			self.create_temporary_symlink(&parent, &link_name, &raw_target, target_kind)?;
		match self.finish_temporary_entry(&parent, &temporary_name, &link_name, &link, overwrite) {
			Ok(metadata) => Ok(metadata),
			Err(error) => {
				let _ = parent.remove_file(&temporary_name);
				Err(error)
			},
		}
	}

	/// Creates a hard link with explicit source-following and overwrite
	/// behavior.
	pub fn create_hard_link(
		&self,
		source: impl AsRef<Path>,
		link: impl AsRef<Path>,
		follow_source: FollowSymlinks,
		overwrite: DestinationOverwritePolicy,
	) -> Result<PathMetadata> {
		if overwrite == DestinationOverwritePolicy::ReplaceEmptyDirectory {
			return Err(Self::invalid_argument(
				link.as_ref(),
				"hard links cannot replace directories",
			));
		}
		let source = match follow_source {
			FollowSymlinks::No => self.resolve_entry(source.as_ref())?,
			FollowSymlinks::Yes => self.resolve_target(source.as_ref())?,
		};
		let metadata = match follow_source {
			FollowSymlinks::No => self.inner.root.symlink_metadata(&source.relative),
			FollowSymlinks::Yes => self.inner.root.metadata(&source.relative),
		}
		.map_err(|error| Self::io_error("inspect hard-link source", &source.absolute, error))?;
		if !(metadata.is_file() || follow_source == FollowSymlinks::No && metadata.is_symlink()) {
			return Err(Self::invalid_argument(
				&source.absolute,
				"hard-link source is not a regular file or link entry",
			));
		}
		let link = self.resolve_entry(link.as_ref())?;
		Self::reject_root_entry(&link, "create hard link")?;
		let (parent, link_name) = self.open_parent(&link)?;
		self.check_non_directory_destination(&link, overwrite)?;
		let temporary_name = self.unique_temporary_name(&parent, &link_name, |name| {
			self.inner.root.hard_link(&source.relative, &parent, name)
		})?;
		match self.finish_temporary_entry(&parent, &temporary_name, &link_name, &link, overwrite) {
			Ok(metadata) => Ok(metadata),
			Err(error) => {
				let _ = parent.remove_file(&temporary_name);
				Err(error)
			},
		}
	}

	/// Applies portable permission changes only while the selected entry still
	/// matches an exact disk expectation.
	pub fn set_permissions_if(
		&self,
		path: impl AsRef<Path>,
		expected: DiskExpectation,
		changes: PortablePermissions,
		follow: FollowSymlinks,
	) -> Result<PathMetadata> {
		let path = path.as_ref();
		if changes.read_only.is_none() && changes.executable.is_none() {
			return Err(Self::invalid_argument(path, "at least one permission property is required"));
		}
		let resolved = match follow {
			FollowSymlinks::No => self.resolve_entry(path)?,
			FollowSymlinks::Yes => self.resolve_target(path)?,
		};
		let (parent, name) = self.open_parent(&resolved)?;
		if follow == FollowSymlinks::No {
			let metadata = parent.symlink_metadata(&name).map_err(|source| {
				Self::io_error("inspect conditional permissions", &resolved.absolute, source)
			})?;
			if metadata.is_symlink() {
				return Err(Self::io_error(
					"set symbolic-link permissions",
					&resolved.absolute,
					io::Error::new(
						io::ErrorKind::Unsupported,
						"changing link-entry permissions is unsupported",
					),
				));
			}
		}
		let file = parent.open(&name).map_err(|source| {
			if source.kind() == io::ErrorKind::NotFound {
				Error::StaleDiskState { path: resolved.absolute.clone() }
			} else {
				Self::io_error("open conditional permission target", &resolved.absolute, source)
			}
		})?;
		let observed = self.stable_read_open_file(&file, &resolved.absolute)?;
		if !Self::expectation_matches(&expected, &observed)
			|| !Self::entry_matches_open_file(&parent, &name, &file, &resolved.absolute)?
		{
			return Err(Error::StaleDiskState { path: resolved.absolute });
		}
		let metadata = file.metadata().map_err(|source| {
			Self::io_error("inspect conditional permission handle", &resolved.absolute, source)
		})?;
		let mut permissions = metadata.permissions();
		if let Some(read_only) = changes.read_only {
			permissions.set_readonly(read_only);
		}
		#[cfg(unix)]
		Self::set_executable(&mut permissions, changes.executable);
		#[cfg(not(unix))]
		Self::set_executable(&mut permissions, changes.executable).map_err(|source| {
			Self::io_error("set owner-executable permission", &resolved.absolute, source)
		})?;
		Self::run_mutation_hook(self, MutationStage::BeforePermissions, &resolved.absolute);
		file.set_permissions(permissions).map_err(|source| {
			Self::io_error("set conditional path permissions", &resolved.absolute, source)
		})?;
		let metadata = file.metadata().map_err(|source| {
			Self::io_error("reinspect conditional permission handle", &resolved.absolute, source)
		})?;
		Ok(Self::path_metadata(resolved.absolute, &metadata))
	}

	/// Applies only supplied portable permission properties and preserves
	/// omissions.
	pub fn set_permissions(
		&self,
		path: impl AsRef<Path>,
		changes: PortablePermissions,
		follow: FollowSymlinks,
	) -> Result<PathMetadata> {
		let path = path.as_ref();
		if changes.read_only.is_none() && changes.executable.is_none() {
			return Err(Self::invalid_argument(path, "at least one permission property is required"));
		}
		let resolved = match follow {
			FollowSymlinks::No => self.resolve_entry(path)?,
			FollowSymlinks::Yes => self.resolve_target(path)?,
		};
		let metadata = match follow {
			FollowSymlinks::No => self.inner.root.symlink_metadata(&resolved.relative),
			FollowSymlinks::Yes => self.inner.root.metadata(&resolved.relative),
		}
		.map_err(|error| Self::io_error("inspect permissions", &resolved.absolute, error))?;
		if follow == FollowSymlinks::No && metadata.is_symlink() {
			return Err(Self::io_error(
				"set symbolic-link permissions",
				&resolved.absolute,
				io::Error::new(
					io::ErrorKind::Unsupported,
					"changing link-entry permissions is unsupported",
				),
			));
		}
		let mut permissions = metadata.permissions();
		if let Some(read_only) = changes.read_only {
			permissions.set_readonly(read_only);
		}
		#[cfg(unix)]
		Self::set_executable(&mut permissions, changes.executable);
		#[cfg(not(unix))]
		Self::set_executable(&mut permissions, changes.executable).map_err(|source| {
			Self::io_error("set owner-executable permission", &resolved.absolute, source)
		})?;
		self
			.inner
			.root
			.set_permissions(&resolved.relative, permissions)
			.map_err(|error| Self::io_error("set path permissions", &resolved.absolute, error))?;
		self.stat(resolved.absolute, follow)
	}

	fn resolve_entry(&self, path: &Path) -> Result<ResolvedPath> {
		let relative = self.lexical_relative(path)?;
		if relative == Path::new(".") {
			return Ok(ResolvedPath { absolute: self.inner.root_path.clone(), relative });
		}
		let (parent, name) = Self::split_relative(&relative)
			.ok_or_else(|| Self::invalid_argument(path, "path has no final component"))?;
		let canonical_parent = self.canonicalize_existing(&parent, path)?;
		let relative = canonical_parent.join(name);
		Ok(ResolvedPath { absolute: self.absolute_for(&relative), relative })
	}

	fn resolve_target(&self, path: &Path) -> Result<ResolvedPath> {
		let entry = self.resolve_entry(path)?;
		match self.inner.root.symlink_metadata(&entry.relative) {
			Ok(metadata) if metadata.is_symlink() => {
				let relative = self
					.canonicalize_existing(&entry.relative, path)
					.map_err(|error| match error {
						Error::Io { source, .. }
							if matches!(
								source.kind(),
								std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
							) =>
						{
							Error::InvalidTarget {
								target: Str::new(entry.absolute.to_string_lossy()),
								reason: sf!("document target is a dangling symbolic link"),
							}
						},
						error => error,
					})?;
				Ok(ResolvedPath { absolute: self.absolute_for(&relative), relative })
			},
			Ok(_) => Ok(entry),
			Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(entry),
			Err(source) => Err(Self::io_error("inspect document target", path, source)),
		}
	}

	fn canonicalize_existing(&self, relative: &Path, identity: &Path) -> Result<PathBuf> {
		let mut pending = VecDeque::new();
		self.prepend_path_steps(&mut pending, None, relative, identity)?;
		let mut resolved: Vec<OsString> = Vec::new();
		let mut symlinks = 0usize;
		while let Some(component) = pending.pop_front() {
			if component == OsStr::new("..") {
				if resolved.pop().is_none() {
					return Err(Error::InvalidTarget {
						target: Str::new(identity.to_string_lossy()),
						reason: sf!("target escapes the Environment root"),
					});
				}
				continue;
			}
			let mut candidate = PathBuf::new();
			for component in &resolved {
				candidate.push(component);
			}
			candidate.push(&component);
			let metadata = self
				.inner
				.root
				.symlink_metadata(&candidate)
				.map_err(|source| Self::io_error("canonicalize path", identity, source))?;
			if metadata.is_symlink() {
				symlinks += 1;
				if symlinks > 40 {
					return Err(Error::InvalidTarget {
						target: Str::new(identity.to_string_lossy()),
						reason: sf!("symbolic-link resolution exceeded the traversal limit"),
					});
				}
				let target = self
					.inner
					.root
					.read_link_contents(&candidate)
					.map_err(|source| {
						Self::io_error("read symbolic link during resolution", identity, source)
					})?;
				self.prepend_path_steps(&mut pending, Some(&mut resolved), &target, identity)?;
				continue;
			}
			if !pending.is_empty() && !metadata.is_dir() {
				return Err(Self::io_error(
					"canonicalize path",
					identity,
					io::Error::new(
						io::ErrorKind::NotADirectory,
						"an intermediate path component is not a directory",
					),
				));
			}
			resolved.push(component);
		}
		let mut canonical = PathBuf::new();
		for component in resolved {
			canonical.push(component);
		}
		if canonical.as_os_str().is_empty() {
			canonical.push(".");
		}
		Ok(canonical)
	}

	fn prepend_path_steps(
		&self,
		pending: &mut VecDeque<OsString>,
		resolved: Option<&mut Vec<OsString>>,
		path: &Path,
		identity: &Path,
	) -> Result<()> {
		let relative = if path.is_absolute() {
			let relative =
				path
					.strip_prefix(&self.inner.root_path)
					.map_err(|_| Error::InvalidTarget {
						target: Str::new(identity.to_string_lossy()),
						reason: sf!("symbolic-link target escapes the Environment root"),
					})?;
			if let Some(resolved) = resolved {
				resolved.clear();
			}
			relative
		} else {
			path
		};
		let mut steps = Vec::new();
		for component in relative.components() {
			match component {
				Component::CurDir => {},
				Component::Normal(component) => steps.push(component.to_os_string()),
				Component::ParentDir => steps.push(OsString::from("..")),
				Component::Prefix(_) | Component::RootDir => {
					return Err(Error::InvalidTarget {
						target: Str::new(identity.to_string_lossy()),
						reason: sf!("symbolic-link target escapes the Environment root"),
					});
				},
			}
		}
		for step in steps.into_iter().rev() {
			pending.push_front(step);
		}
		Ok(())
	}

	fn resolve_creation_relative(&self, relative: &Path, identity: &Path) -> Result<PathBuf> {
		if relative
			.components()
			.any(|component| matches!(component, Component::ParentDir))
		{
			return Err(Error::InvalidTarget {
				target: Str::new(identity.to_string_lossy()),
				reason: sf!("recursive directory creation requires a normalized target"),
			});
		}
		let components: Vec<OsString> = relative
			.components()
			.filter_map(|component| match component {
				Component::Normal(component) => Some(component.to_os_string()),
				_ => None,
			})
			.collect();
		let parent_count = components.len().saturating_sub(1);
		for prefix_length in (0..=parent_count).rev() {
			let mut prefix = PathBuf::new();
			for component in &components[..prefix_length] {
				prefix.push(component);
			}
			if prefix.as_os_str().is_empty() {
				prefix.push(".");
			}
			let canonical = match self.canonicalize_existing(&prefix, identity) {
				Ok(canonical) => canonical,
				Err(Error::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
					continue;
				},
				Err(error) => return Err(error),
			};
			let metadata = self
				.inner
				.root
				.metadata(&canonical)
				.map_err(|source| Self::io_error("inspect directory ancestor", identity, source))?;
			if !metadata.is_dir() {
				return Err(Self::io_error(
					"create directory",
					identity,
					io::Error::new(
						io::ErrorKind::NotADirectory,
						"an existing ancestor is not a directory",
					),
				));
			}
			let mut result = canonical;
			for component in &components[prefix_length..] {
				result.push(component);
			}
			return Ok(result);
		}
		Err(Self::io_error(
			"create directory",
			identity,
			io::Error::new(io::ErrorKind::NotFound, "Environment root is unavailable"),
		))
	}

	fn stable_read_at(&self, parent: &Dir, name: &OsStr, path: &Path) -> Result<DiskState> {
		for _ in 0..STABLE_READ_ATTEMPTS {
			match self.read_observation_at(parent, name, path)? {
				ReadObservation::Missing => {
					if Self::entry_missing_at(parent, name, path)? {
						return Ok(DiskState::Missing);
					}
				},
				ReadObservation::Present { content, metadata } => {
					if Self::verify_observation_at(parent, name, path, &content, &metadata)? {
						let fingerprint = FileFingerprint::for_content(metadata, &content);
						return Ok(DiskState::Present { content, fingerprint });
					}
				},
				ReadObservation::Unstable => {},
			}
		}
		Err(Error::Io {
			operation: sf!("read a stable file snapshot"),
			path:      path.to_path_buf(),
			source:    io::Error::new(
				io::ErrorKind::Interrupted,
				"file did not stabilize across bounded observations",
			),
		})
	}

	fn stable_read_open_file(&self, file: &fs::File, path: &Path) -> Result<DiskState> {
		for _ in 0..STABLE_READ_ATTEMPTS {
			let before = file
				.metadata()
				.map_err(|source| Self::io_error("inspect open document", path, source))?;
			if !before.is_file() {
				return Err(Self::invalid_argument(path, "document target is not a regular file"));
			}
			self.ensure_document_size(path, before.len())?;
			let mut reader = file
				.try_clone()
				.map_err(|source| Self::io_error("clone open document", path, source))?;
			reader
				.seek(SeekFrom::Start(0))
				.map_err(|source| Self::io_error("rewind open document", path, source))?;
			let mut content = Vec::with_capacity(usize::try_from(before.len()).unwrap_or(0));
			Read::by_ref(&mut reader)
				.take(self.inner.max_document_bytes.saturating_add(1))
				.read_to_end(&mut content)
				.map_err(|source| Self::io_error("read open document", path, source))?;
			self.ensure_document_size(path, u64::try_from(content.len()).unwrap_or(u64::MAX))?;
			let after = file
				.metadata()
				.map_err(|source| Self::io_error("reinspect open document", path, source))?;
			let before = Self::fingerprint_metadata(&before);
			let after = Self::fingerprint_metadata(&after);
			if before == after && after.byte_length() == content.len() as u64 {
				let content = Bytes::from(content);
				let fingerprint = FileFingerprint::for_content(after, &content);
				return Ok(DiskState::Present { content, fingerprint });
			}
		}
		Err(Error::Io {
			operation: sf!("read a stable open file snapshot"),
			path:      path.to_path_buf(),
			source:    io::Error::new(
				io::ErrorKind::Interrupted,
				"open file did not stabilize across bounded observations",
			),
		})
	}

	fn entry_matches_open_file(
		parent: &Dir,
		name: &OsStr,
		file: &fs::File,
		path: &Path,
	) -> Result<bool> {
		let expected = Self::file_identity(file)
			.map_err(|source| Self::io_error("identify open document", path, source))?;
		let current = match parent.open(name) {
			Ok(current) => current,
			Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(false),
			Err(source) => return Err(Self::io_error("reopen document entry", path, source)),
		};
		let current = Self::file_identity(&current)
			.map_err(|source| Self::io_error("identify current document entry", path, source))?;
		Ok(expected == current)
	}

	fn read_observation_at(
		&self,
		parent: &Dir,
		name: &OsStr,
		path: &Path,
	) -> Result<ReadObservation> {
		let entry_before = match parent.symlink_metadata(name) {
			Ok(metadata) if metadata.is_file() => metadata,
			Ok(metadata) if metadata.is_symlink() => return Ok(ReadObservation::Unstable),
			Ok(_) => {
				return Err(Self::invalid_argument(path, "document target is not a regular file"));
			},
			Err(source) if source.kind() == io::ErrorKind::NotFound => {
				return Ok(ReadObservation::Missing);
			},
			Err(source) => return Err(Self::io_error("inspect document entry", path, source)),
		};
		let mut file = match parent.open(name) {
			Ok(file) => file,
			Err(source) if source.kind() == io::ErrorKind::NotFound => {
				return Ok(ReadObservation::Unstable);
			},
			Err(source) => return Err(Self::io_error("open document bytes", path, source)),
		};
		let before = file
			.metadata()
			.map_err(|source| Self::io_error("inspect open document", path, source))?;
		if !before.is_file() {
			return Ok(ReadObservation::Unstable);
		}
		self.ensure_document_size(path, before.len())?;
		let mut content = Vec::with_capacity(usize::try_from(before.len()).unwrap_or(0));
		Read::by_ref(&mut file)
			.take(self.inner.max_document_bytes.saturating_add(1))
			.read_to_end(&mut content)
			.map_err(|source| Self::io_error("read document bytes", path, source))?;
		self.ensure_document_size(path, u64::try_from(content.len()).unwrap_or(u64::MAX))?;
		let after = file
			.metadata()
			.map_err(|source| Self::io_error("reinspect open document", path, source))?;
		let entry_after = match parent.symlink_metadata(name) {
			Ok(metadata) if metadata.is_file() => metadata,
			Ok(_) => return Ok(ReadObservation::Unstable),
			Err(source) if source.kind() == io::ErrorKind::NotFound => {
				return Ok(ReadObservation::Unstable);
			},
			Err(source) => return Err(Self::io_error("reinspect document entry", path, source)),
		};
		let before = Self::fingerprint_metadata(&before);
		let after = Self::fingerprint_metadata(&after);
		if before != after
			|| Self::fingerprint_metadata(&entry_before) != after
			|| Self::fingerprint_metadata(&entry_after) != after
			|| after.byte_length() != content.len() as u64
		{
			return Ok(ReadObservation::Unstable);
		}
		Ok(ReadObservation::Present { content: Bytes::from(content), metadata: after })
	}

	fn entry_missing_at(parent: &Dir, name: &OsStr, path: &Path) -> Result<bool> {
		match parent.symlink_metadata(name) {
			Ok(_) => Ok(false),
			Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(true),
			Err(source) => Err(Self::io_error("reinspect missing document entry", path, source)),
		}
	}

	fn verify_observation_at(
		parent: &Dir,
		name: &OsStr,
		path: &Path,
		expected_content: &[u8],
		expected_metadata: &FileMetadata,
	) -> Result<bool> {
		let entry_before = match parent.symlink_metadata(name) {
			Ok(metadata) if metadata.is_file() => metadata,
			Ok(_) => return Ok(false),
			Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(false),
			Err(source) => return Err(Self::io_error("reinspect document entry", path, source)),
		};
		if Self::fingerprint_metadata(&entry_before) != *expected_metadata {
			return Ok(false);
		}
		let mut file = match parent.open(name) {
			Ok(file) => file,
			Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(false),
			Err(source) => return Err(Self::io_error("reopen document bytes", path, source)),
		};
		let before = file
			.metadata()
			.map_err(|source| Self::io_error("reinspect open document", path, source))?;
		if !before.is_file() || Self::fingerprint_metadata(&before) != *expected_metadata {
			return Ok(false);
		}
		let mut offset = 0usize;
		let mut buffer = vec![0u8; 64 * 1024];
		loop {
			let read = file
				.read(&mut buffer)
				.map_err(|source| Self::io_error("verify document bytes", path, source))?;
			if read == 0 {
				break;
			}
			let Some(end) = offset.checked_add(read) else {
				return Ok(false);
			};
			if expected_content.get(offset..end) != Some(&buffer[..read]) {
				return Ok(false);
			}
			offset = end;
		}
		if offset != expected_content.len() {
			return Ok(false);
		}
		let after = file
			.metadata()
			.map_err(|source| Self::io_error("finish verifying document", path, source))?;
		if Self::fingerprint_metadata(&after) != *expected_metadata {
			return Ok(false);
		}
		match parent.symlink_metadata(name) {
			Ok(metadata) if metadata.is_file() => {
				Ok(Self::fingerprint_metadata(&metadata) == *expected_metadata)
			},
			Ok(_) => Ok(false),
			Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
			Err(source) => Err(Self::io_error("finish verifying document entry", path, source)),
		}
	}

	fn lexical_relative(&self, path: &Path) -> Result<PathBuf> {
		let relative = if path.is_absolute() {
			path
				.strip_prefix(&self.inner.root_path)
				.map_err(|_| Error::InvalidTarget {
					target: Str::new(path.to_string_lossy()),
					reason: sf!("target escapes the Environment root"),
				})?
		} else {
			path
		};
		let mut normalized = PathBuf::new();
		for component in relative.components() {
			match component {
				Component::CurDir => {},
				Component::Normal(component) => normalized.push(component),
				Component::ParentDir => normalized.push(".."),
				Component::Prefix(_) | Component::RootDir => {
					return Err(Error::InvalidTarget {
						target: Str::new(path.to_string_lossy()),
						reason: sf!("target is not relative to the Environment root"),
					});
				},
			}
		}
		if normalized.as_os_str().is_empty() {
			normalized.push(".");
		}
		Ok(normalized)
	}

	fn normalize_semantic_path(&self, target: &Path, identity: &Path) -> Result<PathBuf> {
		if target.is_absolute() {
			self.normalize_absolute_target(target, identity)
		} else {
			Self::normalize_from(Path::new("."), target, identity)
		}
	}

	fn normalize_absolute_target(&self, target: &Path, identity: &Path) -> Result<PathBuf> {
		let relative =
			target
				.strip_prefix(&self.inner.root_path)
				.map_err(|_| Error::InvalidTarget {
					target: Str::new(identity.to_string_lossy()),
					reason: sf!("symbolic-link target escapes the Environment root"),
				})?;
		Self::normalize_from(Path::new("."), relative, identity)
	}

	fn normalize_from(base: &Path, target: &Path, identity: &Path) -> Result<PathBuf> {
		let mut components: Vec<OsString> = base
			.components()
			.filter_map(|component| match component {
				Component::Normal(value) => Some(value.to_os_string()),
				_ => None,
			})
			.collect();
		for component in target.components() {
			match component {
				Component::CurDir => {},
				Component::Normal(value) => components.push(value.to_os_string()),
				Component::ParentDir => {
					if components.pop().is_none() {
						return Err(Error::InvalidTarget {
							target: Str::new(identity.to_string_lossy()),
							reason: sf!("symbolic-link target escapes the Environment root"),
						});
					}
				},
				Component::Prefix(_) | Component::RootDir => {
					return Err(Self::invalid_argument(
						identity,
						"relative symbolic-link target is absolute",
					));
				},
			}
		}
		let mut normalized = PathBuf::new();
		for component in components {
			normalized.push(component);
		}
		if normalized.as_os_str().is_empty() {
			normalized.push(".");
		}
		Ok(normalized)
	}

	fn absolute_for(&self, relative: &Path) -> PathBuf {
		if relative == Path::new(".") || relative.as_os_str().is_empty() {
			self.inner.root_path.clone()
		} else {
			self.inner.root_path.join(relative)
		}
	}

	fn split_relative(relative: &Path) -> Option<(PathBuf, OsString)> {
		let name = relative.file_name()?.to_os_string();
		let parent = relative.parent().unwrap_or_else(|| Path::new("."));
		let parent = if parent.as_os_str().is_empty() {
			PathBuf::from(".")
		} else {
			parent.to_path_buf()
		};
		Some((parent, name))
	}

	fn open_parent(&self, resolved: &ResolvedPath) -> Result<(Dir, OsString)> {
		let (parent, name) = Self::split_relative(&resolved.relative)
			.ok_or_else(|| Self::invalid_argument(&resolved.absolute, "path has no parent entry"))?;
		let directory =
			self.inner.root.open_dir(parent).map_err(|source| {
				Self::io_error("open parent directory", &resolved.absolute, source)
			})?;
		Ok((directory, name))
	}

	fn is_disk_state_mismatch(error: &Error) -> bool {
		match error {
			Error::InvalidTarget { .. } => true,
			Error::Io { source, .. } => source.kind() == io::ErrorKind::Interrupted,
			_ => false,
		}
	}

	fn prepare_entry(
		&self,
		path: &Path,
		expected: DiskExpectation,
		operation: &'static str,
	) -> Result<PreparedEntry> {
		let resolved = self.resolve_entry(path)?;
		Self::reject_root_entry(&resolved, operation)?;
		let (parent_relative, _) = Self::split_relative(&resolved.relative)
			.ok_or_else(|| Self::invalid_argument(&resolved.absolute, "path has no parent entry"))?;
		let (parent, name) = self.open_parent(&resolved)?;
		let parent_identity = Self::directory_identity(&parent).map_err(|source| {
			Self::io_error("identify prepared-operation parent", &resolved.absolute, source)
		})?;
		Ok(PreparedEntry {
			parent,
			parent_relative,
			parent_identity,
			path: resolved.absolute,
			name,
			expected,
		})
	}

	fn verify_prepared_owner(
		&self,
		owner: &Arc<LocalFsInner>,
		path: &Path,
		operation: &'static str,
	) -> Result<()> {
		if Arc::ptr_eq(&self.inner, owner) {
			return Ok(());
		}
		Err(Error::InvalidTarget {
			target: Str::new(path.to_string_lossy()),
			reason: sf!("prepared {operation} belongs to another filesystem root"),
		})
	}

	fn stable_expected_state(&self, entry: &PreparedEntry) -> Result<DiskState> {
		match self.stable_read_at(&entry.parent, &entry.name, &entry.path) {
			Ok(state) => Ok(state),
			Err(error) if Self::is_disk_state_mismatch(&error) => Err(Self::stale_entry(entry)),
			Err(error) => Err(error),
		}
	}

	fn expectation_matches(expected: &DiskExpectation, state: &DiskState) -> bool {
		match (expected, state) {
			(DiskExpectation::Missing, DiskState::Missing) => true,
			(DiskExpectation::Present(expected), DiskState::Present { fingerprint, .. }) => {
				expected == fingerprint
			},
			_ => false,
		}
	}

	fn stale_entry(entry: &PreparedEntry) -> Error {
		Error::StaleDiskState { path: entry.path.clone() }
	}

	fn reject_prepared_move_directory(entry: &PreparedEntry) -> Result<()> {
		match entry.parent.symlink_metadata(&entry.name) {
			Ok(metadata) if metadata.is_dir() => {
				Err(Self::invalid_argument(&entry.path, "prepared moves do not support directories"))
			},
			Ok(_) => Ok(()),
			Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
			Err(source) => Err(Self::io_error("inspect prepared move entry", &entry.path, source)),
		}
	}

	fn prepared_parent_is_current(&self, prepared: &PreparedWrite) -> Result<bool> {
		self.prepared_parent_is_current_parts(
			&prepared.parent_relative,
			prepared.parent_identity,
			&prepared.destination_path,
		)
	}

	fn prepared_entry_parent_is_current(&self, prepared: &PreparedEntry) -> Result<bool> {
		self.prepared_parent_is_current_parts(
			&prepared.parent_relative,
			prepared.parent_identity,
			&prepared.path,
		)
	}

	fn prepared_parent_is_current_parts(
		&self,
		parent_relative: &Path,
		parent_identity: DirectoryIdentity,
		path: &Path,
	) -> Result<bool> {
		let current_relative = match self.canonicalize_existing(parent_relative, path) {
			Ok(current_relative) => current_relative,
			Err(Error::InvalidTarget { .. }) => return Ok(false),
			Err(Error::Io { source, .. })
				if matches!(
					source.kind(),
					std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
				) =>
			{
				return Ok(false);
			},
			Err(error) => return Err(error),
		};
		if current_relative != parent_relative {
			return Ok(false);
		}
		let current = self
			.inner
			.root
			.open_dir(&current_relative)
			.map_err(|source| Self::io_error("reopen prepared-operation parent", path, source))?;
		let current_identity = Self::directory_identity(&current)
			.map_err(|source| Self::io_error("reidentify prepared-operation parent", path, source))?;
		Ok(Self::directory_identities_match(parent_identity, current_identity))
	}

	#[cfg(unix)]
	fn metadata_file_identity(metadata: &Metadata) -> FileIdentity {
		use cap_std::fs::MetadataExt;

		FileIdentity { device: metadata.dev(), inode: metadata.ino() }
	}

	#[cfg(windows)]
	fn metadata_file_identity(metadata: &Metadata) -> FileIdentity {
		FileIdentity { volume: None, file_index: Some(metadata.len()) }
	}

	#[cfg(not(any(unix, windows)))]
	const fn metadata_file_identity(_: &Metadata) -> FileIdentity {
		FileIdentity
	}

	#[cfg(unix)]
	fn file_identity(file: &fs::File) -> io::Result<FileIdentity> {
		use cap_std::fs::MetadataExt;

		let metadata = file.metadata()?;
		Ok(FileIdentity { device: metadata.dev(), inode: metadata.ino() })
	}

	#[cfg(windows)]
	fn file_identity(file: &fs::File) -> io::Result<FileIdentity> {
		use std::os::windows::fs::MetadataExt;

		let metadata = file.try_clone()?.into_std().metadata()?;
		Ok(FileIdentity {
			volume:     metadata.volume_serial_number(),
			file_index: metadata.file_index(),
		})
	}

	#[cfg(not(any(unix, windows)))]
	fn file_identity(_: &fs::File) -> io::Result<FileIdentity> {
		Err(io::Error::new(
			io::ErrorKind::Unsupported,
			"file identity is unavailable on this platform",
		))
	}

	#[cfg(unix)]
	fn directory_identity(directory: &Dir) -> io::Result<DirectoryIdentity> {
		use cap_std::fs::MetadataExt;

		let metadata = directory.dir_metadata()?;
		Ok(DirectoryIdentity { device: metadata.dev(), inode: metadata.ino() })
	}

	#[cfg(windows)]
	fn directory_identity(directory: &Dir) -> io::Result<DirectoryIdentity> {
		use std::os::windows::fs::MetadataExt;

		let metadata = directory.try_clone()?.into_std_file().metadata()?;
		Ok(DirectoryIdentity {
			volume:     metadata.volume_serial_number(),
			file_index: metadata.file_index(),
		})
	}

	#[cfg(not(any(unix, windows)))]
	fn directory_identity(_: &Dir) -> io::Result<DirectoryIdentity> {
		Ok(DirectoryIdentity)
	}

	#[cfg(unix)]
	const fn directory_identities_match(
		expected: DirectoryIdentity,
		current: DirectoryIdentity,
	) -> bool {
		expected.device == current.device && expected.inode == current.inode
	}

	#[cfg(windows)]
	const fn directory_identities_match(
		expected: DirectoryIdentity,
		current: DirectoryIdentity,
	) -> bool {
		matches!(
			(
				expected.volume,
				expected.file_index,
				current.volume,
				current.file_index,
			),
			(Some(expected_volume), Some(expected_index), Some(current_volume), Some(current_index))
				if expected_volume == current_volume && expected_index == current_index
		)
	}

	#[cfg(not(any(unix, windows)))]
	const fn directory_identities_match(_: DirectoryIdentity, _: DirectoryIdentity) -> bool {
		false
	}

	#[cfg(unix)]
	const fn directories_share_filesystem(
		left: DirectoryIdentity,
		right: DirectoryIdentity,
	) -> bool {
		left.device == right.device
	}

	#[cfg(windows)]
	const fn directories_share_filesystem(
		left: DirectoryIdentity,
		right: DirectoryIdentity,
	) -> bool {
		matches!((left.volume, right.volume), (Some(left), Some(right)) if left == right)
	}

	#[cfg(not(any(unix, windows)))]
	const fn directories_share_filesystem(_: DirectoryIdentity, _: DirectoryIdentity) -> bool {
		true
	}

	#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
	fn rename_noreplace(
		source_parent: &Dir,
		source: &OsStr,
		destination_parent: &Dir,
		destination: &OsStr,
	) -> io::Result<()> {
		rustix::fs::renameat_with(
			source_parent,
			source,
			destination_parent,
			destination,
			RenameFlags::NOREPLACE,
		)
		.map_err(io::Error::from)
	}

	#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
	fn rename_noreplace(_: &Dir, _: &OsStr, _: &Dir, _: &OsStr) -> io::Result<()> {
		Err(io::Error::new(
			io::ErrorKind::Unsupported,
			"atomic no-replace rename is unavailable on this platform",
		))
	}

	#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
	fn rename_exchange(
		source_parent: &Dir,
		source: &OsStr,
		destination_parent: &Dir,
		destination: &OsStr,
	) -> io::Result<()> {
		rustix::fs::renameat_with(
			source_parent,
			source,
			destination_parent,
			destination,
			RenameFlags::EXCHANGE,
		)
		.map_err(io::Error::from)
	}

	#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
	fn rename_exchange(_: &Dir, _: &OsStr, _: &Dir, _: &OsStr) -> io::Result<()> {
		Err(io::Error::new(
			io::ErrorKind::Unsupported,
			"atomic exchange rename is unavailable on this platform",
		))
	}

	fn reject_root_entry(resolved: &ResolvedPath, operation: &'static str) -> Result<()> {
		if resolved.relative == Path::new(".") {
			return Err(Self::invalid_argument(
				&resolved.absolute,
				&format!("cannot {operation} the Environment root"),
			));
		}
		Ok(())
	}

	fn create_temporary(&self, parent: &Dir, destination: &OsStr) -> Result<(OsString, fs::File)> {
		for _ in 0..TEMP_CREATE_ATTEMPTS {
			let name = self.next_temporary_name(destination);
			let mut options = OpenOptions::new();
			options.write(true).create_new(true);
			match parent.open_with(&name, &options) {
				Ok(file) => return Ok((name, file)),
				Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {},
				Err(source) => {
					return Err(Self::persistence_error(
						&self.inner.root_path.join(destination),
						source,
					));
				},
			}
		}
		Err(Self::persistence_error(
			&self.inner.root_path.join(destination),
			io::Error::new(io::ErrorKind::AlreadyExists, "could not allocate a unique temporary name"),
		))
	}

	fn unique_temporary_name<F>(
		&self,
		parent: &Dir,
		destination: &OsStr,
		mut create: F,
	) -> Result<OsString>
	where
		F: FnMut(&OsStr) -> io::Result<()>,
	{
		for _ in 0..TEMP_CREATE_ATTEMPTS {
			let name = self.next_temporary_name(destination);
			match create(&name) {
				Ok(()) => return Ok(name),
				Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {},
				Err(source) => {
					return Err(Self::io_error(
						"create temporary destination entry",
						&self.inner.root_path.join(destination),
						source,
					));
				},
			}
		}
		let _ = parent;
		Err(Self::already_exists(
			"allocate temporary destination entry",
			&self.inner.root_path.join(destination),
		))
	}

	fn next_temporary_name(&self, _: &OsStr) -> OsString {
		let sequence = self.inner.temp_sequence.fetch_add(1, Ordering::Relaxed);
		OsString::from(format!(".omp-{}-{sequence:016x}.tmp", std::process::id()))
	}

	fn create_temporary_symlink(
		&self,
		parent: &Dir,
		destination: &OsStr,
		target: &Path,
		target_kind: SymlinkTargetKind,
	) -> Result<OsString> {
		self.unique_temporary_name(parent, destination, |name| {
			Self::symlink_raw(parent, target, name, target_kind)
		})
	}

	#[cfg(not(windows))]
	fn symlink_raw(
		parent: &Dir,
		target: &Path,
		link: &OsStr,
		_: SymlinkTargetKind,
	) -> io::Result<()> {
		parent.symlink_contents(target, link)
	}

	#[cfg(windows)]
	fn symlink_raw(
		parent: &Dir,
		target: &Path,
		link: &OsStr,
		target_kind: SymlinkTargetKind,
	) -> io::Result<()> {
		match target_kind {
			SymlinkTargetKind::File => parent.symlink_file(target, link),
			SymlinkTargetKind::Directory => parent.symlink_dir(target, link),
		}
	}

	fn finish_temporary_entry(
		&self,
		parent: &Dir,
		temporary: &OsStr,
		destination_name: &OsStr,
		destination: &ResolvedPath,
		overwrite: DestinationOverwritePolicy,
	) -> Result<PathMetadata> {
		let installed = parent.symlink_metadata(temporary).map_err(|source| {
			Self::io_error("inspect prepared destination entry", &destination.absolute, source)
		})?;
		let installed = Self::path_metadata(destination.absolute.clone(), &installed);
		Self::run_mutation_hook(self, MutationStage::BeforeTemporaryInstall, &destination.absolute);
		match overwrite {
			DestinationOverwritePolicy::FailIfExists => {
				Self::rename_noreplace(parent, temporary, parent, destination_name).map_err(
					|source| {
						if source.kind() == io::ErrorKind::AlreadyExists {
							Self::already_exists("create destination", &destination.absolute)
						} else {
							Self::io_error("install destination entry", &destination.absolute, source)
						}
					},
				)?;
				Self::run_mutation_hook(
					self,
					MutationStage::AfterTemporaryInstall,
					&destination.absolute,
				);
			},
			DestinationOverwritePolicy::ReplaceNonDirectory => {
				match Self::rename_exchange(parent, temporary, parent, destination_name) {
					Ok(()) => {
						Self::run_mutation_hook(
							self,
							MutationStage::AfterTemporaryInstall,
							&destination.absolute,
						);
						match parent.symlink_metadata(temporary) {
							Ok(displaced) if displaced.is_dir() => {
								if Self::rename_exchange(parent, temporary, parent, destination_name)
									.is_ok()
								{
									return Err(Self::io_error(
										"replace destination",
										&destination.absolute,
										io::Error::new(
											io::ErrorKind::IsADirectory,
											"destination is a directory",
										),
									));
								}
							},
							Ok(_) => {
								let _ = parent.remove_file(temporary);
							},
							Err(_) => {},
						}
					},
					Err(source) if source.kind() == io::ErrorKind::NotFound => {
						Self::rename_noreplace(parent, temporary, parent, destination_name).map_err(
							|source| {
								if source.kind() == io::ErrorKind::AlreadyExists {
									Self::already_exists("create destination", &destination.absolute)
								} else {
									Self::io_error(
										"install destination entry",
										&destination.absolute,
										source,
									)
								}
							},
						)?;
						Self::run_mutation_hook(
							self,
							MutationStage::AfterTemporaryInstall,
							&destination.absolute,
						);
					},
					Err(source) => {
						return Err(Self::io_error(
							"install destination entry",
							&destination.absolute,
							source,
						));
					},
				}
			},
			DestinationOverwritePolicy::ReplaceEmptyDirectory => {
				return Err(Self::invalid_argument(
					&destination.absolute,
					"operation does not support replacing a directory",
				));
			},
		}
		let _ = Self::flush_directory(parent, &destination.absolute);
		Ok(installed)
	}

	fn check_non_directory_destination(
		&self,
		destination: &ResolvedPath,
		overwrite: DestinationOverwritePolicy,
	) -> Result<()> {
		match self.inner.root.symlink_metadata(&destination.relative) {
			Ok(metadata) => match overwrite {
				DestinationOverwritePolicy::FailIfExists => {
					Err(Self::already_exists("create destination", &destination.absolute))
				},
				DestinationOverwritePolicy::ReplaceNonDirectory if !metadata.is_dir() => Ok(()),
				DestinationOverwritePolicy::ReplaceNonDirectory => Err(Self::io_error(
					"replace destination",
					&destination.absolute,
					io::Error::new(io::ErrorKind::IsADirectory, "destination is a directory"),
				)),
				DestinationOverwritePolicy::ReplaceEmptyDirectory => Err(Self::invalid_argument(
					&destination.absolute,
					"operation does not support replacing a directory",
				)),
			},
			Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
			Err(source) => {
				Err(Self::io_error("inspect destination entry", &destination.absolute, source))
			},
		}
	}

	fn check_rename_destination(
		&self,
		destination: &ResolvedPath,
		overwrite: DestinationOverwritePolicy,
		source_is_directory: bool,
	) -> Result<()> {
		if overwrite == DestinationOverwritePolicy::ReplaceEmptyDirectory && !source_is_directory {
			return Err(Self::invalid_argument(
				&destination.absolute,
				"only a directory may replace an empty directory",
			));
		}
		match self.inner.root.symlink_metadata(&destination.relative) {
			Ok(metadata) => match overwrite {
				DestinationOverwritePolicy::FailIfExists => {
					Err(Self::already_exists("rename destination", &destination.absolute))
				},
				DestinationOverwritePolicy::ReplaceNonDirectory if !metadata.is_dir() => Ok(()),
				DestinationOverwritePolicy::ReplaceNonDirectory => Err(Self::io_error(
					"replace rename destination",
					&destination.absolute,
					io::Error::new(io::ErrorKind::IsADirectory, "destination is a directory"),
				)),
				DestinationOverwritePolicy::ReplaceEmptyDirectory if metadata.is_dir() => {
					let mut entries =
						self
							.inner
							.root
							.read_dir(&destination.relative)
							.map_err(|source| {
								Self::io_error(
									"inspect destination directory",
									&destination.absolute,
									source,
								)
							})?;
					if entries.next().is_some() {
						Err(Self::io_error(
							"replace rename destination",
							&destination.absolute,
							io::Error::new(
								io::ErrorKind::DirectoryNotEmpty,
								"destination directory is not empty",
							),
						))
					} else {
						Ok(())
					}
				},
				DestinationOverwritePolicy::ReplaceEmptyDirectory => Err(Self::io_error(
					"replace rename destination",
					&destination.absolute,
					io::Error::new(io::ErrorKind::NotADirectory, "destination is not a directory"),
				)),
			},
			Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
			Err(source) => {
				Err(Self::io_error("inspect rename destination", &destination.absolute, source))
			},
		}
	}

	fn flush_directory(directory: &Dir, path: &Path) -> Result<()> {
		let clone = directory
			.try_clone()
			.map_err(|source| Self::io_error("clone parent directory handle", path, source))?;
		match clone.into_std_file().sync_all() {
			Ok(()) => Ok(()),
			Err(source)
				if matches!(
					source.kind(),
					std::io::ErrorKind::Unsupported | std::io::ErrorKind::InvalidInput
				) =>
			{
				Ok(())
			},
			Err(source) => Err(Self::io_error("flush parent directory", path, source)),
		}
	}

	fn path_metadata(path: PathBuf, metadata: &Metadata) -> PathMetadata {
		PathMetadata {
			path,
			kind: if metadata.is_file() {
				FileKind::RegularFile
			} else if metadata.is_dir() {
				FileKind::Directory
			} else if metadata.is_symlink() {
				FileKind::SymbolicLink
			} else {
				FileKind::Other
			},
			byte_length: metadata.len(),
			permissions: Self::portable_permissions(metadata),
			modified: metadata.modified().ok().map(|time| time.into_std()),
			accessed: metadata.accessed().ok().map(|time| time.into_std()),
			created: metadata.created().ok().map(|time| time.into_std()),
		}
	}

	fn fingerprint_metadata(metadata: &Metadata) -> FileMetadata {
		FileMetadata::new(
			metadata.len(),
			metadata.modified().ok().map(|time| time.into_std()),
			metadata.permissions().readonly(),
		)
	}

	fn portable_permissions(metadata: &Metadata) -> PortablePermissions {
		let permissions = metadata.permissions();
		PortablePermissions {
			read_only:  Some(permissions.readonly()),
			executable: {
				#[cfg(unix)]
				{
					Some(Self::owner_executable(&permissions))
				}
				#[cfg(not(unix))]
				{
					None
				}
			},
		}
	}

	#[cfg(unix)]
	fn owner_executable(permissions: &fs::Permissions) -> bool {
		use cap_std::fs::PermissionsExt;
		permissions.mode() & 0o100 != 0
	}

	#[cfg(not(unix))]
	fn owner_executable(_: &fs::Permissions) -> Option<bool> {
		None
	}

	#[cfg(unix)]
	fn set_executable(permissions: &mut fs::Permissions, executable: Option<bool>) {
		use cap_std::fs::PermissionsExt;
		if let Some(executable) = executable {
			let mut mode = permissions.mode();
			if executable {
				mode |= 0o100;
			} else {
				mode &= !0o100;
			}
			permissions.set_mode(mode);
		}
	}

	#[cfg(not(unix))]
	fn set_executable(_: &mut fs::Permissions, executable: Option<bool>) -> io::Result<()> {
		if executable.is_some() {
			Err(io::Error::new(
				io::ErrorKind::Unsupported,
				"owner-executable permission is unavailable on this host",
			))
		} else {
			Ok(())
		}
	}

	fn relative_path_between(from_directory: &Path, target: &Path) -> PathBuf {
		let from: Vec<&OsStr> = from_directory
			.components()
			.filter_map(|component| match component {
				Component::Normal(value) => Some(value),
				_ => None,
			})
			.collect();
		let to: Vec<&OsStr> = target
			.components()
			.filter_map(|component| match component {
				Component::Normal(value) => Some(value),
				_ => None,
			})
			.collect();
		let common = from
			.iter()
			.zip(&to)
			.take_while(|(left, right)| left == right)
			.count();
		let mut result = PathBuf::new();
		for _ in common..from.len() {
			result.push("..");
		}
		for component in &to[common..] {
			result.push(component);
		}
		if result.as_os_str().is_empty() {
			result.push(".");
		}
		result
	}

	fn io_error(operation: &'static str, path: &Path, source: io::Error) -> Error {
		Error::Io { operation: sf!(operation), path: path.to_path_buf(), source }
	}

	fn persistence_error(path: &Path, source: io::Error) -> Error {
		Error::Persistence { path: path.to_path_buf(), source }
	}

	fn already_exists(operation: &'static str, path: &Path) -> Error {
		Self::io_error(
			operation,
			path,
			io::Error::new(io::ErrorKind::AlreadyExists, "destination already exists"),
		)
	}

	fn invalid_argument(path: &Path, reason: &str) -> Error {
		Error::InvalidTarget { target: Str::new(path.to_string_lossy()), reason: Str::new(reason) }
	}
}

#[cfg(test)]
mod tests {
	use std::{fs, num::NonZeroU64};

	use self::filesystem as create_filesystem;
	use super::*;

	fn filesystem() -> (tempfile::TempDir, LocalFs) {
		let temporary = tempfile::tempdir().expect("temporary root");
		let config = ServerConfig::new(temporary.path()).expect("server config");
		let filesystem = LocalFs::new(&config).expect("local filesystem");
		(temporary, filesystem)
	}

	fn present_expectation(filesystem: &LocalFs, path: &Path) -> DiskExpectation {
		match filesystem.stable_read(path).expect("stable fixture read") {
			DiskState::Present { fingerprint, .. } => DiskExpectation::Present(fingerprint),
			DiskState::Missing => panic!("fixture should be present"),
		}
	}

	#[test]
	fn stable_read_preserves_exact_bytes_and_missing_state() {
		let (_root, filesystem) = create_filesystem();
		let bytes = b"a\0\xff\r\n";
		fs::write(filesystem.root_path().join("exact.bin"), bytes).expect("write fixture");
		let DiskState::Present { content, fingerprint } = filesystem
			.stable_read(filesystem.root_path().join("exact.bin"))
			.expect("stable read")
		else {
			panic!("file should be present");
		};
		assert_eq!(content.as_ref(), bytes);
		assert_eq!(fingerprint.content_hash(), Hash32::sum(bytes).as_bytes());
		assert_eq!(
			filesystem
				.stable_read(filesystem.root_path().join("missing"))
				.expect("missing read"),
			DiskState::Missing
		);
	}

	#[test]
	fn document_limit_bounds_reads_and_prepared_writes() {
		let root = tempfile::tempdir().expect("temporary root");
		let config = ServerConfig::new(root.path())
			.expect("server config")
			.with_max_document_bytes(NonZeroU64::new(4).expect("nonzero limit"));
		let filesystem = LocalFs::new(&config).expect("local filesystem");
		let oversized = filesystem.root_path().join("oversized");
		fs::write(&oversized, b"12345").expect("write oversized fixture");
		let error = filesystem
			.stable_read(&oversized)
			.expect_err("oversized read must fail");
		assert!(matches!(error, Error::InvalidContent { .. }), "unexpected error: {error:?}");
		assert!(matches!(
			filesystem.prepare_write(
				filesystem.root_path().join("new"),
				Bytes::from_static(b"12345"),
				DiskExpectation::Missing,
			),
			Err(Error::InvalidContent { .. })
		));
	}

	#[test]
	fn prepared_replacement_is_deferred_and_preserves_permissions() {
		let (_root, filesystem) = create_filesystem();
		let path = filesystem.root_path().join("document");
		fs::write(&path, b"old").expect("write fixture");
		let original = filesystem.stable_read(&path).expect("initial read");
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			fs::set_permissions(&path, fs::Permissions::from_mode(0o741)).expect("set mode");
		}
		let expected = match filesystem.stable_read(&path).expect("fingerprinted read") {
			DiskState::Present { fingerprint, .. } => fingerprint,
			DiskState::Missing => panic!("fixture should be present"),
		};
		let prepared = filesystem
			.prepare_write(&path, Bytes::from_static(b"new"), DiskExpectation::Present(expected))
			.expect("prepare write");
		assert_eq!(fs::read(&path).expect("read before commit"), b"old");
		let result = filesystem.commit_prepared(prepared).expect("commit write");
		assert_eq!(result.content().expect("present content").as_ref(), b"new");
		assert_ne!(result, original);
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			assert_eq!(fs::metadata(&path).expect("metadata").permissions().mode() & 0o777, 0o741);
		}
	}

	#[test]
	fn dropping_prepared_write_removes_only_its_temporary() {
		let (_root, filesystem) = create_filesystem();
		let destination = filesystem.root_path().join("new-document");
		let prepared = filesystem
			.prepare_write(&destination, Bytes::from_static(b"candidate"), DiskExpectation::Missing)
			.expect("prepare write");
		let temporary = filesystem.root_path().join(&prepared.temporary_name);
		assert!(temporary.exists());
		drop(prepared);
		assert!(!temporary.exists());
		assert!(!destination.exists());
	}

	#[test]
	fn stale_fingerprint_rejects_prepared_replacement() {
		let (_root, filesystem) = create_filesystem();
		let path = filesystem.root_path().join("document");
		fs::write(&path, b"base").expect("write fixture");
		let expected = match filesystem.stable_read(&path).expect("initial read") {
			DiskState::Present { fingerprint, .. } => fingerprint,
			DiskState::Missing => panic!("fixture should be present"),
		};
		let prepared = filesystem
			.prepare_write(&path, Bytes::from_static(b"candidate"), DiskExpectation::Present(expected))
			.expect("prepare write");
		fs::write(&path, b"external").expect("external change");
		assert!(matches!(filesystem.commit_prepared(prepared), Err(Error::StaleDiskState { .. })));
		assert_eq!(fs::read(path).expect("read external state"), b"external");
	}

	#[test]
	fn prepared_commit_rejects_a_replaced_parent_even_when_fingerprint_matches() {
		let (_root, filesystem) = create_filesystem();
		let parent = filesystem.root_path().join("parent");
		let moved_parent = filesystem.root_path().join("moved-parent");
		fs::create_dir(&parent).expect("parent fixture");
		let path = parent.join("document");
		fs::write(&path, b"base").expect("document fixture");
		let expected = match filesystem.stable_read(&path).expect("initial read") {
			DiskState::Present { fingerprint, .. } => fingerprint,
			DiskState::Missing => panic!("fixture should be present"),
		};
		let prepared = filesystem
			.prepare_write(
				&path,
				Bytes::from_static(b"candidate"),
				DiskExpectation::Present(expected.clone()),
			)
			.expect("prepare write");
		fs::rename(&parent, &moved_parent).expect("move original parent");
		fs::create_dir(&parent).expect("replace parent");
		fs::hard_link(moved_parent.join("document"), &path).expect("matching replacement entry");
		assert_eq!(
			filesystem
				.stable_read(&path)
				.expect("replacement read")
				.fingerprint(),
			Some(&expected)
		);
		assert!(matches!(filesystem.commit_prepared(prepared), Err(Error::StaleDiskState { .. })));
		assert_eq!(fs::read(moved_parent.join("document")).expect("original entry"), b"base");
		assert_eq!(fs::read(path).expect("replacement entry"), b"base");
	}

	#[test]
	fn prepared_move_rejects_a_stale_source_without_touching_either_entry() {
		let (_root, filesystem) = create_filesystem();
		let source = filesystem.root_path().join("source");
		let destination = filesystem.root_path().join("destination");
		fs::write(&source, b"base").expect("source fixture");
		let prepared = filesystem
			.prepare_move(
				&source,
				&destination,
				present_expectation(&filesystem, &source),
				DiskExpectation::Missing,
			)
			.expect("prepare move");
		fs::write(&source, b"external").expect("external source change");
		assert!(matches!(
			filesystem.commit_prepared_move(prepared),
			Err(Error::StaleDiskState { path }) if path == source
		));
		assert_eq!(fs::read(&source).expect("unchanged source"), b"external");
		assert!(!destination.exists());
	}

	#[test]
	fn prepared_move_rejects_a_stale_destination_without_touching_either_entry() {
		let (_root, filesystem) = create_filesystem();
		let source = filesystem.root_path().join("source");
		let destination = filesystem.root_path().join("destination");
		fs::write(&source, b"source").expect("source fixture");
		fs::write(&destination, b"destination").expect("destination fixture");
		let prepared = filesystem
			.prepare_move(
				&source,
				&destination,
				present_expectation(&filesystem, &source),
				present_expectation(&filesystem, &destination),
			)
			.expect("prepare move");
		fs::write(&destination, b"external").expect("external destination change");
		assert!(matches!(
			filesystem.commit_prepared_move(prepared),
			Err(Error::StaleDiskState { path }) if path == destination
		));
		assert_eq!(fs::read(&source).expect("unchanged source"), b"source");
		assert_eq!(fs::read(&destination).expect("unchanged destination"), b"external");
	}

	#[test]
	fn prepared_move_with_content_rejects_a_raced_destination_without_partial_state() {
		let (_root, filesystem) = create_filesystem();
		let source = filesystem.root_path().join("source");
		let destination = filesystem.root_path().join("destination");
		fs::write(&source, b"source").expect("source fixture");
		let prepared = filesystem
			.prepare_move_with_content(
				&source,
				&destination,
				Bytes::from_static(b"edited"),
				present_expectation(&filesystem, &source),
				DiskExpectation::Missing,
			)
			.expect("prepare move with content");
		fs::write(&destination, b"external").expect("raced destination");
		assert!(matches!(
			filesystem.commit_prepared_move(prepared),
			Err(Error::StaleDiskState { path }) if path == destination
		));
		assert_eq!(fs::read(&source).expect("source remains"), b"source");
		assert_eq!(fs::read(&destination).expect("external remains"), b"external");
	}

	#[test]
	fn prepared_delete_rejects_a_replaced_parent_without_touching_either_entry() {
		let (_root, filesystem) = create_filesystem();
		let parent = filesystem.root_path().join("parent");
		let moved_parent = filesystem.root_path().join("moved-parent");
		fs::create_dir(&parent).expect("parent fixture");
		let path = parent.join("document");
		fs::write(&path, b"base").expect("document fixture");
		let prepared = filesystem
			.prepare_delete(&path, present_expectation(&filesystem, &path))
			.expect("prepare delete");
		fs::rename(&parent, &moved_parent).expect("move original parent");
		fs::create_dir(&parent).expect("replace parent");
		fs::hard_link(moved_parent.join("document"), &path).expect("matching replacement entry");
		assert!(matches!(
			filesystem.commit_prepared_delete(prepared),
			Err(Error::StaleDiskState { .. })
		));
		assert_eq!(fs::read(moved_parent.join("document")).expect("original entry"), b"base");
		assert_eq!(fs::read(path).expect("replacement entry"), b"base");
	}

	#[test]
	fn prepared_move_overwrites_only_an_exact_present_destination() {
		let (_root, filesystem) = create_filesystem();
		let source = filesystem.root_path().join("source");
		let destination = filesystem.root_path().join("destination");
		fs::write(&source, b"moved").expect("source fixture");
		fs::write(&destination, b"replaced").expect("destination fixture");
		let prepared = filesystem
			.prepare_move(
				&source,
				&destination,
				present_expectation(&filesystem, &source),
				present_expectation(&filesystem, &destination),
			)
			.expect("prepare move");
		let result = filesystem
			.commit_prepared_move(prepared)
			.expect("commit move");
		assert_eq!(result.content().expect("destination content").as_ref(), b"moved");
		assert_eq!(filesystem.stable_read(&source).expect("source observation"), DiskState::Missing);
		assert_eq!(fs::read(destination).expect("destination bytes"), b"moved");
	}

	#[test]
	fn prepared_move_moves_between_names_in_one_parent() {
		let (_root, filesystem) = create_filesystem();
		let source = filesystem.root_path().join("before");
		let destination = filesystem.root_path().join("after");
		fs::write(&source, b"payload").expect("source fixture");
		let prepared = filesystem
			.prepare_move(
				&source,
				&destination,
				present_expectation(&filesystem, &source),
				DiskExpectation::Missing,
			)
			.expect("prepare move");
		let result = filesystem
			.commit_prepared_move(prepared)
			.expect("commit move");
		assert_eq!(result.content().expect("destination content").as_ref(), b"payload");
		assert!(!source.exists());
		assert_eq!(fs::read(destination).expect("destination bytes"), b"payload");
	}

	#[test]
	fn prepared_move_moves_between_captured_parent_handles() {
		let (_root, filesystem) = create_filesystem();
		let source_parent = filesystem.root_path().join("source-parent");
		let destination_parent = filesystem.root_path().join("destination-parent");
		fs::create_dir(&source_parent).expect("source parent");
		fs::create_dir(&destination_parent).expect("destination parent");
		let source = source_parent.join("document");
		let destination = destination_parent.join("document");
		fs::write(&source, b"payload").expect("source fixture");
		let prepared = filesystem
			.prepare_move(
				&source,
				&destination,
				present_expectation(&filesystem, &source),
				DiskExpectation::Missing,
			)
			.expect("prepare move");
		let result = filesystem
			.commit_prepared_move(prepared)
			.expect("commit move");
		assert_eq!(result.content().expect("destination content").as_ref(), b"payload");
		assert_eq!(filesystem.stable_read(source).expect("source observation"), DiskState::Missing);
		assert_eq!(fs::read(destination).expect("destination bytes"), b"payload");
	}

	#[test]
	fn prepared_delete_removes_and_observes_the_captured_entry() {
		let (_root, filesystem) = create_filesystem();
		let path = filesystem.root_path().join("document");
		fs::write(&path, b"payload").expect("document fixture");
		let prepared = filesystem
			.prepare_delete(&path, present_expectation(&filesystem, &path))
			.expect("prepare delete");
		assert_eq!(
			filesystem
				.commit_prepared_delete(prepared)
				.expect("commit delete"),
			DiskState::Missing
		);
		assert_eq!(filesystem.stable_read(path).expect("deleted observation"), DiskState::Missing);
	}

	#[test]
	fn prepared_operations_cannot_be_committed_by_another_local_filesystem() {
		let (_root, filesystem) = create_filesystem();
		let config = ServerConfig::new(filesystem.root_path()).expect("second server config");
		let other = LocalFs::new(&config).expect("second local filesystem");
		let path = filesystem.root_path().join("document");
		fs::write(&path, b"payload").expect("document fixture");
		let prepared = filesystem
			.prepare_delete(&path, present_expectation(&filesystem, &path))
			.expect("prepare delete");
		assert!(matches!(other.commit_prepared_delete(prepared), Err(Error::InvalidTarget { .. })));
		assert_eq!(fs::read(path).expect("unchanged entry"), b"payload");
	}

	#[cfg(unix)]
	#[test]
	fn symbolic_link_escape_is_confined() {
		use std::os::unix::fs::symlink;

		let (_root, filesystem) = create_filesystem();
		let outside = tempfile::tempdir().expect("outside root");
		fs::write(outside.path().join("secret"), b"secret").expect("outside fixture");
		symlink(outside.path().join("secret"), filesystem.root_path().join("escape"))
			.expect("escape link");
		assert!(
			filesystem
				.stable_read(filesystem.root_path().join("escape"))
				.is_err()
		);
		assert!(
			filesystem
				.canonicalize(filesystem.root_path().join("escape"))
				.is_err()
		);
	}

	#[test]
	fn representative_path_operations_obey_entry_semantics() {
		let (_root, filesystem) = create_filesystem();
		let directory = filesystem.root_path().join("tree");
		filesystem
			.create_directory(&directory, false, ExistingDirectoryPolicy::FailIfExists)
			.expect("create directory");
		fs::write(directory.join("source"), b"payload").expect("source fixture");
		assert_eq!(
			filesystem
				.canonicalize(directory.join("..").join("tree").join("source"))
				.expect("canonicalize dotted path"),
			directory.join("source")
		);
		let copied = filesystem
			.copy(
				directory.join("source"),
				directory.join("copy"),
				FollowSymlinks::Yes,
				DestinationOverwritePolicy::FailIfExists,
			)
			.expect("copy file");
		assert_eq!(copied.bytes_copied, 7);
		filesystem
			.create_hard_link(
				directory.join("copy"),
				directory.join("hard"),
				FollowSymlinks::Yes,
				DestinationOverwritePolicy::FailIfExists,
			)
			.expect("hard link");
		filesystem
			.rename(
				directory.join("copy"),
				directory.join("renamed"),
				DestinationOverwritePolicy::FailIfExists,
			)
			.expect("rename");
		let names: Vec<_> = filesystem
			.list_directory(&directory, FollowSymlinks::Yes)
			.expect("list")
			.into_iter()
			.map(|entry| entry.name)
			.collect();
		assert_eq!(names, [sf!("hard"), sf!("renamed"), sf!("source")]);
		filesystem
			.remove(directory.join("renamed"), false)
			.expect("remove file");
		filesystem.remove(&directory, true).expect("remove tree");
		assert!(!directory.exists());
	}

	#[cfg(unix)]
	#[test]
	fn relative_symlink_round_trips_and_partial_permissions_preserve_omissions() {
		use std::os::unix::fs::PermissionsExt;

		let (_root, filesystem) = create_filesystem();
		let target = filesystem.root_path().join("target");
		fs::write(&target, b"target").expect("target fixture");
		fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).expect("fixture mode");
		let link = filesystem.root_path().join("link");
		filesystem
			.create_symlink(
				&SymlinkTarget { path: target.clone(), form: SymlinkTargetForm::Relative },
				&link,
				SymlinkTargetKind::File,
				DestinationOverwritePolicy::FailIfExists,
			)
			.expect("create symlink");
		assert_eq!(filesystem.read_link(&link).expect("read link"), SymlinkTarget {
			path: target.clone(),
			form: SymlinkTargetForm::Relative,
		});
		let absolute_link = filesystem.root_path().join("absolute-link");
		filesystem
			.create_symlink(
				&SymlinkTarget { path: target.clone(), form: SymlinkTargetForm::Absolute },
				&absolute_link,
				SymlinkTargetKind::File,
				DestinationOverwritePolicy::FailIfExists,
			)
			.expect("create absolute symlink");
		assert_eq!(
			filesystem
				.stable_read(&absolute_link)
				.expect("follow confined absolute link")
				.content()
				.expect("linked content")
				.as_ref(),
			b"target"
		);
		filesystem
			.set_permissions(
				&target,
				PortablePermissions { read_only: None, executable: Some(true) },
				FollowSymlinks::Yes,
			)
			.expect("set executable");
		assert_eq!(fs::metadata(target).expect("metadata").permissions().mode() & 0o777, 0o740);
	}
	#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
	#[test]
	fn prepared_write_is_atomic_across_pre_and_post_syscall_replacement() {
		let (_root, filesystem) = create_filesystem();
		let path = filesystem.root_path().join("write-before");
		fs::write(&path, b"old").expect("old fixture");
		let prepared = filesystem
			.prepare_write(
				&path,
				Bytes::from_static(b"action"),
				present_expectation(&filesystem, &path),
			)
			.expect("prepare replacement");
		let old = filesystem.root_path().join("write-before-old");
		filesystem.set_mutation_hook(move |stage, path| {
			if stage == MutationStage::BeforeWrite {
				fs::rename(path, &old).expect("move checked entry");
				fs::write(path, b"external").expect("install external entry");
			}
		});
		assert!(matches!(filesystem.commit_prepared(prepared), Err(Error::StaleDiskState { .. })));
		assert_eq!(fs::read(&path).expect("external destination"), b"external");

		let (_root, filesystem) = create_filesystem();
		let path = filesystem.root_path().join("write-after");
		fs::write(&path, b"old").expect("old fixture");
		let prepared = filesystem
			.prepare_write(
				&path,
				Bytes::from_static(b"action"),
				present_expectation(&filesystem, &path),
			)
			.expect("prepare replacement");
		let installed = filesystem.root_path().join("write-after-installed");
		filesystem.set_mutation_hook(move |stage, path| {
			if stage == MutationStage::AfterWrite {
				fs::rename(path, &installed).expect("move installed action");
				fs::write(path, b"external-after").expect("replace after syscall");
			}
		});
		let committed = filesystem
			.commit_prepared(prepared)
			.expect("committed write");
		assert_eq!(committed.content().expect("installed bytes").as_ref(), b"action");
		assert_eq!(fs::read(&path).expect("newer external destination"), b"external-after");
	}

	#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
	#[test]
	fn missing_create_is_atomic_and_returns_prepared_metadata() {
		let (_root, filesystem) = create_filesystem();
		let source = filesystem.root_path().join("copy-source");
		let destination = filesystem.root_path().join("copy-before");
		fs::write(&source, b"action").expect("source fixture");
		filesystem.set_mutation_hook(move |stage, path| {
			if stage == MutationStage::BeforeTemporaryInstall {
				fs::write(path, b"external").expect("race missing destination");
			}
		});
		assert!(
			filesystem
				.copy(
					&source,
					&destination,
					FollowSymlinks::Yes,
					DestinationOverwritePolicy::FailIfExists,
				)
				.is_err()
		);
		assert_eq!(fs::read(&destination).expect("external destination"), b"external");

		let (_root, filesystem) = create_filesystem();
		let source = filesystem.root_path().join("copy-source");
		let destination = filesystem.root_path().join("copy-after");
		let moved = filesystem.root_path().join("copy-installed");
		fs::write(&source, b"action").expect("source fixture");
		filesystem.set_mutation_hook(move |stage, path| {
			if stage == MutationStage::AfterTemporaryInstall {
				fs::rename(path, &moved).expect("move installed copy");
				fs::write(path, b"external-after").expect("replace copied destination");
			}
		});
		let copied = filesystem
			.copy(&source, &destination, FollowSymlinks::Yes, DestinationOverwritePolicy::FailIfExists)
			.expect("copy committed");
		assert_eq!(copied.metadata.byte_length, 6);
		assert_eq!(fs::read(&destination).expect("external destination"), b"external-after");
	}

	#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
	#[cfg(unix)]
	#[test]
	fn privileged_write_refuses_final_symlink() {
		use std::os::unix::fs::symlink;

		let (_root, filesystem) = create_filesystem();
		let target = filesystem.root_path().join("target.txt");
		let link = filesystem.root_path().join("link.txt");
		fs::write(&target, b"keep").expect("target");
		symlink(&target, &link).expect("link");
		let prepared = filesystem.prepare_write_with_mode(
			&link,
			Bytes::from_static(b"replace"),
			DiskExpectation::Missing,
			0,
		);
		assert!(prepared.is_ok(), "staging beside a link is side-effect free");
		assert!(
			filesystem
				.commit_prepared(prepared.expect("prepared"))
				.is_err()
		);
		assert_eq!(fs::read(&target).expect("target remains"), b"keep");
		assert!(link.is_symlink());
	}

	#[cfg(unix)]
	#[test]
	fn privileged_no_follow_removal_unlinks_symlink_not_target() {
		use std::os::unix::fs::symlink;

		let (_root, filesystem) = create_filesystem();
		let target = filesystem.root_path().join("target.txt");
		let link = filesystem.root_path().join("link.txt");
		fs::write(&target, b"keep").expect("target");
		symlink(&target, &link).expect("link");
		assert_eq!(
			filesystem
				.remove_no_follow_if(&link, true, false)
				.expect("unlink"),
			DiskState::Missing
		);
		assert_eq!(fs::read(&target).expect("target remains"), b"keep");
		assert!(!link.exists());
	}

	#[test]
	fn prepared_delete_preserves_replacements_on_both_sides_of_rename() {
		let (_root, filesystem) = create_filesystem();
		let path = filesystem.root_path().join("delete-before");
		let old = filesystem.root_path().join("delete-old");
		fs::write(&path, b"old").expect("old fixture");
		let prepared = filesystem
			.prepare_delete(&path, present_expectation(&filesystem, &path))
			.expect("prepare delete");
		filesystem.set_mutation_hook(move |stage, path| {
			if stage == MutationStage::BeforeDelete {
				fs::rename(path, &old).expect("move checked entry");
				fs::write(path, b"external").expect("install replacement");
			}
		});
		assert!(matches!(
			filesystem.commit_prepared_delete(prepared),
			Err(Error::StaleDiskState { .. })
		));
		assert_eq!(fs::read(&path).expect("restored external entry"), b"external");

		let (_root, filesystem) = create_filesystem();
		let path = filesystem.root_path().join("delete-after");
		fs::write(&path, b"old").expect("old fixture");
		let prepared = filesystem
			.prepare_delete(&path, present_expectation(&filesystem, &path))
			.expect("prepare delete");
		filesystem.set_mutation_hook(move |stage, path| {
			if stage == MutationStage::AfterDelete {
				fs::write(path, b"external-after").expect("replace after removal rename");
			}
		});
		assert_eq!(
			filesystem
				.commit_prepared_delete(prepared)
				.expect("delete committed"),
			DiskState::Missing
		);
		assert_eq!(fs::read(&path).expect("newer external entry"), b"external-after");
	}

	#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
	#[test]
	fn prepared_move_never_overwrites_a_racing_destination_or_rereads_success() {
		let (_root, filesystem) = create_filesystem();
		let source = filesystem.root_path().join("move-before-source");
		let destination = filesystem.root_path().join("move-before-destination");
		fs::write(&source, b"action").expect("source fixture");
		let prepared = filesystem
			.prepare_move(
				&source,
				&destination,
				present_expectation(&filesystem, &source),
				DiskExpectation::Missing,
			)
			.expect("prepare move");
		filesystem.set_mutation_hook(move |stage, path| {
			if stage == MutationStage::BeforeMove {
				fs::write(path, b"external").expect("race destination");
			}
		});
		assert!(matches!(
			filesystem.commit_prepared_move(prepared),
			Err(Error::StaleDiskState { .. })
		));
		assert_eq!(fs::read(&destination).expect("external destination"), b"external");
		assert_eq!(fs::read(&source).expect("unmoved source"), b"action");

		let (_root, filesystem) = create_filesystem();
		let source = filesystem.root_path().join("move-after-source");
		let destination = filesystem.root_path().join("move-after-destination");
		let moved = filesystem.root_path().join("move-installed");
		fs::write(&source, b"action").expect("source fixture");
		let prepared = filesystem
			.prepare_move(
				&source,
				&destination,
				present_expectation(&filesystem, &source),
				DiskExpectation::Missing,
			)
			.expect("prepare move");
		filesystem.set_mutation_hook(move |stage, path| {
			if stage == MutationStage::AfterMove {
				fs::rename(path, &moved).expect("move installed action");
				fs::write(path, b"external-after").expect("replace moved destination");
			}
		});
		let committed = filesystem
			.commit_prepared_move(prepared)
			.expect("move committed");
		assert_eq!(committed.content().expect("installed bytes").as_ref(), b"action");
		assert_eq!(fs::read(&destination).expect("newer external destination"), b"external-after");
	}

	#[cfg(unix)]
	#[test]
	fn conditional_permissions_never_chmod_a_replacement_inode() {
		use std::os::unix::fs::PermissionsExt;

		let (_root, filesystem) = create_filesystem();
		let path = filesystem.root_path().join("permissions");
		let old = filesystem.root_path().join("permissions-old");
		fs::write(&path, b"old").expect("old fixture");
		fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("old mode");
		let expected = present_expectation(&filesystem, &path);
		filesystem.set_mutation_hook(move |stage, path| {
			if stage == MutationStage::BeforePermissions {
				fs::rename(path, &old).expect("move checked inode");
				fs::write(path, b"external").expect("install replacement inode");
				fs::set_permissions(path, fs::Permissions::from_mode(0o644)).expect("replacement mode");
			}
		});
		let changed = filesystem
			.set_permissions_if(
				&path,
				expected,
				PortablePermissions { read_only: Some(true), executable: None },
				FollowSymlinks::No,
			)
			.expect("chmod checked handle");
		assert_eq!(changed.permissions.read_only, Some(true));
		assert_eq!(fs::read(&path).expect("replacement bytes"), b"external");
		assert_eq!(
			fs::metadata(&path)
				.expect("replacement metadata")
				.permissions()
				.mode() & 0o777,
			0o644
		);
	}
}
