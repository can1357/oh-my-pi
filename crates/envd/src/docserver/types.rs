use std::{
	collections::HashMap,
	fmt::{self, Display},
	fs, io,
	num::{NonZeroU64, NonZeroUsize},
	path::{Path, PathBuf},
	str,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::SystemTime,
};

use bytes::Bytes;
use cap_std::{ambient_authority, fs::Dir};
use omp_core::{Hash32, Str, sf};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::docserver::{Error, RangeKind, Result};

const DEFAULT_REVISION_CAPACITY: usize = 64;
const DEFAULT_MAX_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
const ID_LENGTH: usize = 16;

#[cfg(unix)]
fn same_directory_identity(expected: &fs::Metadata, opened: &fs::Metadata) -> bool {
	use std::os::unix::fs::MetadataExt as _;

	expected.dev() == opened.dev() && expected.ino() == opened.ino()
}

#[cfg(windows)]
fn same_directory_identity(expected: &fs::Metadata, opened: &fs::Metadata) -> bool {
	use std::os::windows::fs::MetadataExt as _;

	expected.volume_serial_number() == opened.volume_serial_number()
		&& expected.file_index() == opened.file_index()
}

#[cfg(not(any(unix, windows)))]
fn same_directory_identity(expected: &fs::Metadata, opened: &fs::Metadata) -> bool {
	expected.is_dir() && opened.is_dir()
}

macro_rules! opaque_id {
	($name:ident, $doc:literal) => {
		#[doc = $doc]
		#[derive(
			Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize,
		)]
		pub struct $name([u8; ID_LENGTH]);

		impl $name {
			/// Creates an identifier from its stable 16-byte representation.
			pub const fn from_bytes(bytes: [u8; ID_LENGTH]) -> Self {
				Self(bytes)
			}

			/// Returns the stable 16-byte representation.
			pub const fn as_bytes(&self) -> &[u8; ID_LENGTH] {
				&self.0
			}

			/// Consumes the identifier and returns its stable byte representation.
			pub const fn into_bytes(self) -> [u8; ID_LENGTH] {
				self.0
			}
		}

		impl Display for $name {
			fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
				for byte in self.0 {
					write!(formatter, "{byte:02x}")?;
				}
				Ok(())
			}
		}
	};
}

opaque_id!(
	DocumentId,
	"Opaque identity of a document for the lifetime of the Environment service."
);
opaque_id!(LeaseId, "Opaque identity of an active-document lease.");
opaque_id!(TransactionId, "Opaque, stable idempotency key for a document transaction.");

/// Exact identity of immutable document content.
///
/// The hash is BLAKE3-256 over the exact bytes, without text normalization or
/// character decoding. Sequences are monotone within one document.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct Revision {
	sequence:     u64,
	content_hash: [u8; 32],
}

impl Revision {
	/// Computes a revision for `content` at the supplied document-local
	/// sequence.
	pub fn for_content(sequence: u64, content: &[u8]) -> Self {
		Self { sequence, content_hash: Hash32::sum(content).into_bytes() }
	}

	/// Reconstructs a revision from a sequence and an already computed BLAKE3
	/// hash.
	pub const fn from_hash(sequence: u64, content_hash: [u8; 32]) -> Self {
		Self { sequence, content_hash }
	}

	/// Returns the document-local monotone sequence.
	pub const fn sequence(self) -> u64 {
		self.sequence
	}

	/// Returns the BLAKE3-256 content hash.
	pub const fn content_hash(&self) -> &[u8; 32] {
		&self.content_hash
	}

	/// Reports whether this revision identifies the supplied exact bytes.
	pub fn matches(self, content: &[u8]) -> bool {
		self.content_hash == Hash32::sum(content).into_bytes()
	}
}

impl Display for Revision {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}@", self.sequence)?;
		for byte in &self.content_hash[..6] {
			write!(formatter, "{byte:02x}")?;
		}
		Ok(())
	}
}

/// A validated, non-empty LSP language identifier.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct LanguageId(Str);

impl LanguageId {
	/// Validates and stores a language identifier.
	pub fn new(value: impl AsRef<str>) -> Result<Self> {
		let value = value.as_ref();
		if value.is_empty() {
			return Err(Error::InvalidContent { reason: sf!("language id must not be empty") });
		}
		Ok(Self(Str::new(value)))
	}

	/// Returns the language identifier as text.
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}
}

impl Display for LanguageId {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.as_str())
	}
}

/// Canonical lookup identity for one local file URI.
///
/// POSIX paths retain case and backslashes exactly. Windows drive paths are
/// slash-normalized and ASCII case-folded, matching the filesystem lookup
/// semantics used by language servers on Windows without aliasing distinct
/// POSIX files.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FileUriKey(Str);

impl FileUriKey {
	/// Canonicalizes a parsed local file URI for equivalent lookup.
	pub fn new(uri: &Url) -> Result<Self> {
		if uri.scheme() != "file"
			|| uri
				.host_str()
				.is_some_and(|host| !host.is_empty() && !host.eq_ignore_ascii_case("localhost"))
			|| uri.query().is_some()
			|| uri.fragment().is_some()
		{
			return Err(Error::InvalidTarget {
				target: Str::new(uri.as_str()),
				reason: sf!("target is not a plain local file URI"),
			});
		}
		let path = uri.to_file_path().map_err(|()| Error::InvalidTarget {
			target: Str::new(uri.as_str()),
			reason: sf!("target is not a local file URI"),
		})?;
		let path_text = path.to_string_lossy();
		let normalized = windows_drive_path(&path_text).map_or_else(
			|| {
				Url::from_file_path(&path)
					.map(|canonical| Str::new(canonical.as_str()))
					.map_err(|()| Error::InvalidTarget {
						target: Str::new(uri.as_str()),
						reason: sf!("file URI path cannot be represented canonically"),
					})
			},
			|windows| {
				let mut canonical =
					Url::parse("file:///").expect("the canonical file URI base is valid");
				canonical.set_path(&windows);
				Ok(Str::new(canonical.as_str()))
			},
		)?;
		Ok(Self(normalized))
	}

	/// Parses and canonicalizes a local file URI.
	pub fn parse(uri: &str) -> Result<Self> {
		let parsed = Url::parse(uri).map_err(|_| Error::InvalidTarget {
			target: Str::new(uri),
			reason: sf!("target is not a valid file URI"),
		})?;
		Self::new(&parsed)
	}

	/// Converts one local path into its percent-encoded canonical lookup key.
	pub fn from_path(path: &Path) -> Result<Self> {
		let uri = Url::from_file_path(path).map_err(|()| Error::InvalidTarget {
			target: Str::new(path.to_string_lossy()),
			reason: sf!("path cannot be represented as a file URI"),
		})?;
		Self::new(&uri)
	}

	/// Returns the canonical percent-encoded file URI.
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}
}

fn windows_drive_path(path: &str) -> Option<String> {
	let bytes = path.as_bytes();
	let drive = match bytes {
		[b'/', drive, b':', ..] if drive.is_ascii_alphabetic() => 1,
		[drive, b':', ..] if drive.is_ascii_alphabetic() => 0,
		_ => return None,
	};
	let mut normalized = String::with_capacity(path.len() + usize::from(drive == 0));
	normalized.push('/');
	for character in path[drive..].chars() {
		normalized.push(if character == '\\' {
			'/'
		} else {
			character.to_ascii_lowercase()
		});
	}
	Some(normalized)
}

/// Map keyed by canonical local file URI identity.
#[derive(Clone, Debug)]
pub struct EquivalentUriMap<V> {
	entries: HashMap<FileUriKey, V>,
}

impl<V> Default for EquivalentUriMap<V> {
	fn default() -> Self {
		Self { entries: HashMap::new() }
	}
}

impl<V> EquivalentUriMap<V> {
	/// Creates an empty equivalent-URI map.
	pub fn new() -> Self {
		Self::default()
	}

	/// Inserts a value under the canonical identity of `uri`.
	pub fn insert(&mut self, uri: &Url, value: V) -> Result<Option<V>> {
		Ok(self.entries.insert(FileUriKey::new(uri)?, value))
	}

	/// Returns the value for any spelling equivalent to `uri`.
	pub fn get(&self, uri: &Url) -> Result<Option<&V>> {
		Ok(self.entries.get(&FileUriKey::new(uri)?))
	}

	/// Reports whether any equivalent spelling of `uri` is present.
	pub fn contains_key(&self, uri: &Url) -> Result<bool> {
		Ok(self.entries.contains_key(&FileUriKey::new(uri)?))
	}

	/// Removes and returns the value for any equivalent spelling of `uri`.
	pub fn remove(&mut self, uri: &Url) -> Result<Option<V>> {
		Ok(self.entries.remove(&FileUriKey::new(uri)?))
	}

	/// Returns the number of canonical file identities.
	pub fn len(&self) -> usize {
		self.entries.len()
	}

	/// Reports whether no canonical file identity is stored.
	pub fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}
}

/// Interpretation of a document's exact stored bytes.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DocumentKind {
	/// UTF-8 text, optionally classified for a language server.
	Text(Option<LanguageId>),
	/// Bytes with no required text encoding.
	Binary,
}

/// Whether a document currently exists in its Environment filesystem.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DocumentPresence {
	/// The document exists as a regular file.
	Present,
	/// The document is absent while its identity and revision history remain
	/// active.
	Missing,
}

/// Public committed state of an active document.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DocumentHead {
	document_id: DocumentId,
	revision:    Revision,
	presence:    DocumentPresence,
	kind:        DocumentKind,
	byte_length: u64,
}

impl DocumentHead {
	/// Builds a committed head, enforcing absence and length invariants.
	pub fn new(
		document_id: DocumentId,
		revision: Revision,
		presence: DocumentPresence,
		kind: DocumentKind,
		byte_length: u64,
	) -> Result<Self> {
		if presence == DocumentPresence::Missing && byte_length != 0 {
			return Err(Error::InvalidContent {
				reason: sf!("a missing document cannot have content"),
			});
		}
		Ok(Self { document_id, revision, presence, kind, byte_length })
	}

	/// Returns the document identity.
	pub const fn document_id(&self) -> DocumentId {
		self.document_id
	}

	/// Returns the committed revision.
	pub const fn revision(&self) -> Revision {
		self.revision
	}

	/// Returns whether the document exists on disk.
	pub const fn presence(&self) -> DocumentPresence {
		self.presence
	}

	/// Returns the interpretation of the document bytes.
	pub const fn kind(&self) -> &DocumentKind {
		&self.kind
	}

	/// Returns the exact byte length.
	pub const fn byte_length(&self) -> u64 {
		self.byte_length
	}
}

/// An immutable committed head together with its shared exact bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentSnapshot {
	head:    DocumentHead,
	content: Bytes,
}

impl DocumentSnapshot {
	/// Validates content against the head's length, revision, presence, and
	/// kind.
	pub fn new(head: DocumentHead, content: Bytes) -> Result<Self> {
		if content.len() as u64 != head.byte_length {
			return Err(Error::InvalidContent {
				reason: sf!("snapshot byte length does not match its head"),
			});
		}
		if !head.revision.matches(&content) {
			return Err(Error::InvalidContent {
				reason: sf!("snapshot bytes do not match their revision"),
			});
		}
		if head.presence == DocumentPresence::Missing && !content.is_empty() {
			return Err(Error::InvalidContent {
				reason: sf!("a missing document cannot have content"),
			});
		}
		if matches!(&head.kind, DocumentKind::Text(_)) && str::from_utf8(&content).is_err() {
			return Err(Error::InvalidContent {
				reason: sf!("text document content is not valid UTF-8"),
			});
		}
		Ok(Self { head, content })
	}

	/// Returns the committed document head.
	pub const fn head(&self) -> &DocumentHead {
		&self.head
	}

	/// Returns the shared exact document bytes.
	pub const fn content(&self) -> &Bytes {
		&self.content
	}

	/// Splits the snapshot into its head and shared bytes without copying
	/// content.
	pub fn into_parts(self) -> (DocumentHead, Bytes) {
		(self.head, self.content)
	}
}

/// Filesystem metadata used when deciding whether persisted state changed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileMetadata {
	byte_length: u64,
	modified:    Option<SystemTime>,
	readonly:    bool,
}

impl FileMetadata {
	/// Captures the stable metadata fields used by document persistence.
	pub fn from_std(metadata: &fs::Metadata) -> Self {
		Self {
			byte_length: metadata.len(),
			modified:    metadata.modified().ok(),
			readonly:    metadata.permissions().readonly(),
		}
	}

	/// Constructs metadata from fields observed through a capability filesystem
	/// handle.
	pub const fn new(byte_length: u64, modified: Option<SystemTime>, readonly: bool) -> Self {
		Self { byte_length, modified, readonly }
	}

	/// Returns the file length in bytes.
	pub const fn byte_length(&self) -> u64 {
		self.byte_length
	}

	/// Returns the last modification timestamp when the filesystem supplies one.
	pub const fn modified(&self) -> Option<SystemTime> {
		self.modified
	}

	/// Reports whether the captured permissions were read-only.
	pub const fn readonly(&self) -> bool {
		self.readonly
	}
}

/// Exact-byte disk fingerprint paired with the metadata observed for that read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileFingerprint {
	metadata:     FileMetadata,
	content_hash: [u8; 32],
}

impl FileFingerprint {
	/// Hashes the exact bytes read under `metadata`.
	pub fn for_content(metadata: FileMetadata, content: &[u8]) -> Self {
		Self { metadata, content_hash: Hash32::sum(content).into_bytes() }
	}

	/// Returns the captured filesystem metadata.
	pub const fn metadata(&self) -> &FileMetadata {
		&self.metadata
	}

	/// Returns the BLAKE3-256 hash of the bytes read from disk.
	pub const fn content_hash(&self) -> &[u8; 32] {
		&self.content_hash
	}

	/// Reports whether both metadata and exact bytes still match.
	pub fn matches(&self, metadata: &FileMetadata, content: &[u8]) -> bool {
		self.metadata == *metadata && self.content_hash == Hash32::sum(content).into_bytes()
	}
}

macro_rules! half_open_range {
	($name:ident, $kind:expr, $bound_name:literal, $doc:literal) => {
		#[doc = $doc]
		#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
		pub struct $name {
			start: u64,
			end:   u64,
		}

		impl $name {
			/// Creates a half-open range, rejecting a reversed interval.
			pub const fn new(start: u64, end: u64) -> Result<Self> {
				if start > end {
					return Err(Error::InvalidRange { kind: $kind, start, end, upper_bound: None });
				}
				Ok(Self { start, end })
			}

			/// Returns the inclusive start coordinate.
			pub const fn start(self) -> u64 {
				self.start
			}

			/// Returns the exclusive end coordinate.
			pub const fn end(self) -> u64 {
				self.end
			}

			/// Returns the number of coordinates covered by the range.
			pub const fn len(self) -> u64 {
				self.end - self.start
			}

			/// Reports whether the range is empty.
			pub const fn is_empty(self) -> bool {
				self.start == self.end
			}

			#[doc = concat!("Validates this range against the available ", $bound_name, ".")]
			pub const fn validate(self, upper_bound: u64) -> Result<Self> {
				if self.end > upper_bound {
					return Err(Error::InvalidRange {
						kind:        $kind,
						start:       self.start,
						end:         self.end,
						upper_bound: Some(upper_bound),
					});
				}
				Ok(self)
			}
		}
	};
}

half_open_range!(
	ByteRange,
	RangeKind::Byte,
	"byte length",
	"A zero-based half-open byte interval."
);
half_open_range!(LineRange, RangeKind::Line, "line count", "A zero-based half-open line interval.");

/// Configuration whose stable root capability bounds every local filesystem
/// operation.
#[derive(Clone)]
pub struct ServerConfig {
	environment_root:   PathBuf,
	server_build:       Str,
	root:               Arc<Dir>,
	authority_held:     Arc<AtomicBool>,
	revision_capacity:  NonZeroUsize,
	max_document_bytes: NonZeroU64,
}

impl fmt::Debug for ServerConfig {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ServerConfig")
			.field("environment_root", &self.environment_root)
			.field("server_build", &self.server_build)
			.field("revision_capacity", &self.revision_capacity)
			.field("max_document_bytes", &self.max_document_bytes)
			.finish()
	}
}

impl PartialEq for ServerConfig {
	fn eq(&self, other: &Self) -> bool {
		self.environment_root == other.environment_root
			&& self.server_build == other.server_build
			&& self.revision_capacity == other.revision_capacity
			&& self.max_document_bytes == other.max_document_bytes
	}
}

impl Eq for ServerConfig {}

/// Exclusive daemon authority held on the stable project directory itself.
#[derive(Debug)]
#[must_use]
pub struct AuthorityLock {
	root: fs::File,
	held: Arc<AtomicBool>,
}

impl Drop for AuthorityLock {
	fn drop(&mut self) {
		let _ = self.root.unlock();
		self.held.store(false, Ordering::Release);
	}
}

impl ServerConfig {
	/// Canonicalizes and validates an Environment filesystem root.
	pub fn new(environment_root: impl AsRef<Path>) -> Result<Self> {
		let unresolved = environment_root.as_ref();
		let root =
			Dir::open_ambient_dir(unresolved, ambient_authority()).map_err(|source| Error::Io {
				operation: sf!("open Environment capability root"),
				path: unresolved.to_path_buf(),
				source,
			})?;
		let opened = root
			.try_clone()
			.and_then(|root| root.into_std_file().metadata())
			.map_err(|source| Error::Io {
				operation: sf!("inspect Environment capability root"),
				path: unresolved.to_path_buf(),
				source,
			})?;
		let canonical = fs::canonicalize(unresolved).map_err(|source| Error::Io {
			operation: sf!("canonicalize Environment root"),
			path: unresolved.to_path_buf(),
			source,
		})?;
		let metadata = fs::metadata(&canonical).map_err(|source| Error::Io {
			operation: sf!("verify Environment root"),
			path: canonical.clone(),
			source,
		})?;
		if !metadata.is_dir() {
			return Err(Error::InvalidTarget {
				target: Str::new(canonical.to_string_lossy()),
				reason: sf!("Environment root is not a directory"),
			});
		}
		if !same_directory_identity(&metadata, &opened) {
			return Err(Error::InvalidTarget {
				target: Str::new(canonical.to_string_lossy()),
				reason: sf!("Environment root changed while it was opened"),
			});
		}
		Ok(Self {
			environment_root:   canonical,
			server_build:       Str::default(),
			root:               Arc::new(root),
			authority_held:     Arc::new(AtomicBool::new(false)),
			revision_capacity:  NonZeroUsize::new(DEFAULT_REVISION_CAPACITY)
				.expect("default revision capacity is nonzero"),
			max_document_bytes: NonZeroU64::new(DEFAULT_MAX_DOCUMENT_BYTES)
				.expect("default document limit is nonzero"),
		})
	}

	/// Sets the executable-generation identity advertised to document clients.
	pub fn with_server_build(mut self, build: impl Into<Str>) -> Self {
		self.server_build = build.into();
		self
	}

	/// Returns the executable-generation identity advertised to document
	/// clients.
	pub const fn server_build(&self) -> &Str {
		&self.server_build
	}

	/// Returns the canonical absolute Environment root.
	pub fn environment_root(&self) -> &Path {
		&self.environment_root
	}

	/// Acquires process authority on the opened project directory.
	pub fn try_lock_authority(&self) -> Result<AuthorityLock> {
		use cap_std::fs;

		if self
			.authority_held
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.is_err()
		{
			return Err(Error::Io {
				operation: sf!("lock Environment authority"),
				path:      self.environment_root.clone(),
				source:    io::Error::new(
					io::ErrorKind::WouldBlock,
					"this ServerConfig already holds the Environment authority",
				),
			});
		}
		let result = (|| {
			let root = self
				.root
				.try_clone()
				.map(fs::Dir::into_std_file)
				.map_err(|source| Error::Io {
					operation: sf!("clone Environment authority handle"),
					path: self.environment_root.clone(),
					source,
				})?;
			root.try_lock().map_err(|source| Error::Io {
				operation: sf!("lock Environment authority"),
				path:      self.environment_root.clone(),
				source:    source.into(),
			})?;
			Ok(root)
		})();
		match result {
			Ok(root) => Ok(AuthorityLock { root, held: Arc::clone(&self.authority_held) }),
			Err(error) => {
				self.authority_held.store(false, Ordering::Release);
				Err(error)
			},
		}
	}

	pub(crate) fn clone_root(&self) -> Result<Dir> {
		self.root.try_clone().map_err(|source| Error::Io {
			operation: sf!("clone Environment capability root"),
			path: self.environment_root.clone(),
			source,
		})
	}

	/// Returns the number of immutable revisions retained per active document.
	pub const fn revision_capacity(&self) -> NonZeroUsize {
		self.revision_capacity
	}

	/// Sets the number of immutable revisions retained per active document.
	pub const fn with_revision_capacity(mut self, capacity: NonZeroUsize) -> Self {
		self.revision_capacity = capacity;
		self
	}

	/// Returns the largest document snapshot admitted into memory.
	pub const fn max_document_bytes(&self) -> NonZeroU64 {
		self.max_document_bytes
	}

	/// Sets the largest document snapshot admitted into memory.
	pub const fn with_max_document_bytes(mut self, limit: NonZeroU64) -> Self {
		self.max_document_bytes = limit;
		self
	}

	/// Resolves an existing relative or absolute path to a canonical path inside
	/// the Environment.
	pub fn resolve_existing(&self, path: impl AsRef<Path>) -> Result<PathBuf> {
		let path = path.as_ref();
		let candidate = if path.is_absolute() {
			path.to_path_buf()
		} else {
			self.environment_root.join(path)
		};
		let canonical = fs::canonicalize(&candidate).map_err(|source| Error::Io {
			operation: sf!("canonicalize document target"),
			path: candidate,
			source,
		})?;
		if !canonical.starts_with(&self.environment_root) {
			return Err(Error::InvalidTarget {
				target: Str::new(canonical.to_string_lossy()),
				reason: sf!("target escapes the Environment root"),
			});
		}
		Ok(canonical)
	}

	/// Resolves a filesystem entry without following its final path component.
	///
	/// The parent must exist and is canonicalized inside the Environment. The
	/// returned path can therefore address a regular entry, a symbolic link
	/// (including a dangling link), or a missing leaf. Callers must use
	/// handle-relative operations to prevent a parent symlink race after
	/// resolution.
	pub fn resolve_entry(&self, path: impl AsRef<Path>) -> Result<PathBuf> {
		let path = path.as_ref();
		let candidate = if path.is_absolute() {
			path.to_path_buf()
		} else {
			self.environment_root.join(path)
		};
		if candidate == self.environment_root {
			return Ok(self.environment_root.clone());
		}
		let Some(file_name) = candidate.file_name() else {
			return Err(Error::InvalidTarget {
				target: Str::new(candidate.to_string_lossy()),
				reason: sf!("target has no final path component"),
			});
		};
		let Some(parent) = candidate.parent() else {
			return Err(Error::InvalidTarget {
				target: Str::new(candidate.to_string_lossy()),
				reason: sf!("target has no parent directory"),
			});
		};
		let canonical_parent = fs::canonicalize(parent).map_err(|source| Error::Io {
			operation: sf!("canonicalize target parent"),
			path: parent.to_path_buf(),
			source,
		})?;
		if !canonical_parent.starts_with(&self.environment_root) {
			return Err(Error::InvalidTarget {
				target: Str::new(candidate.to_string_lossy()),
				reason: sf!("target escapes the Environment root"),
			});
		}
		Ok(canonical_parent.join(file_name))
	}

	/// Resolves a document target, following an existing final symbolic link.
	///
	/// A missing ordinary leaf is permitted. A dangling final symbolic link is
	/// rejected because it cannot identify document bytes; no-follow resource
	/// operations must instead use [`Self::resolve_entry`].
	pub fn resolve_target(&self, path: impl AsRef<Path>) -> Result<PathBuf> {
		let entry = self.resolve_entry(path)?;
		match fs::canonicalize(&entry) {
			Ok(canonical) => {
				if !canonical.starts_with(&self.environment_root) {
					return Err(Error::InvalidTarget {
						target: Str::new(canonical.to_string_lossy()),
						reason: sf!("target escapes the Environment root"),
					});
				}
				Ok(canonical)
			},
			Err(source) if source.kind() == io::ErrorKind::NotFound => {
				if fs::symlink_metadata(&entry).is_ok_and(|metadata| metadata.file_type().is_symlink())
				{
					return Err(Error::InvalidTarget {
						target: Str::new(entry.to_string_lossy()),
						reason: sf!("document target is a dangling symbolic link"),
					});
				}
				Ok(entry)
			},
			Err(source) => {
				Err(Error::Io { operation: sf!("canonicalize document target"), path: entry, source })
			},
		}
	}

	/// Resolves a file URI to a no-follow filesystem entry inside the
	/// Environment.
	///
	/// The final component may be a symbolic link or may be missing.
	pub fn resolve_file_uri(&self, uri: &Url) -> Result<PathBuf> {
		let path = uri.to_file_path().map_err(|()| Error::InvalidTarget {
			target: Str::new(uri.as_str()),
			reason: sf!("target is not a local file URI"),
		})?;
		self.resolve_entry(path)
	}

	/// Resolves a file URI as a document, following an existing final symbolic
	/// link.
	pub fn resolve_document_uri(&self, uri: &Url) -> Result<PathBuf> {
		let path = uri.to_file_path().map_err(|()| Error::InvalidTarget {
			target: Str::new(uri.as_str()),
			reason: sf!("target is not a local file URI"),
		})?;
		self.resolve_target(path)
	}

	/// Converts a confined Environment entry path to its wire-level file URI.
	pub fn file_uri(&self, canonical_path: &Path) -> Result<Url> {
		let resolved = self.resolve_entry(canonical_path)?;
		if resolved != canonical_path {
			return Err(Error::InvalidTarget {
				target: Str::new(canonical_path.to_string_lossy()),
				reason: sf!("path does not have a canonical confined parent"),
			});
		}
		Url::from_file_path(&resolved).map_err(|()| Error::InvalidTarget {
			target: Str::new(resolved.to_string_lossy()),
			reason: sf!("path cannot be represented as a file URI"),
		})
	}
}

#[cfg(test)]
mod tests {
	use tempfile::TempDir;

	use super::*;

	#[test]
	fn file_uri_keys_normalize_percent_encoding_and_windows_spelling() {
		let table = [
			("file:///C:/Users/Dev/My%20Project/Main.RS", "file:///c:/users/dev/my%20project/main.rs"),
			(
				"file:///c:%5Cusers%5Cdev%5Cmy%20project%5Cmain.rs",
				"file:///c:/users/dev/my%20project/main.rs",
			),
			("file:///tmp/My%20Project/%23main.rs", "file:///tmp/My%20Project/%23main.rs"),
			("file:///tmp/raw space.rs", "file:///tmp/raw%20space.rs"),
		];
		for (input, expected) in table {
			assert_eq!(
				FileUriKey::parse(input)
					.expect("canonical file URI")
					.as_str(),
				expected
			);
		}
	}

	#[test]
	fn equivalent_uri_map_folds_windows_case_and_slashes_but_not_posix_case() {
		let mut map = EquivalentUriMap::new();
		let windows = Url::parse("file:///C:/Work/Source/Main.rs").unwrap();
		map.insert(&windows, 7).unwrap();
		assert_eq!(
			map.get(&Url::parse("file:///c:%5Cwork%5Csource%5CMAIN.RS").unwrap())
				.unwrap(),
			Some(&7)
		);

		let upper = Url::parse("file:///tmp/Source.rs").unwrap();
		let lower = Url::parse("file:///tmp/source.rs").unwrap();
		map.insert(&upper, 9).unwrap();
		assert_eq!(map.get(&lower).unwrap(), None);
		assert_eq!(map.len(), 2);
	}

	#[test]
	fn cloned_config_cannot_reenter_its_authority() {
		let root = TempDir::new().expect("temporary directory");
		let config = ServerConfig::new(root.path()).expect("server config");
		let lock = config.try_lock_authority().expect("first authority");
		assert!(config.try_lock_authority().is_err());
		drop(lock);
		let _reacquired_authority = config.try_lock_authority().expect("released authority");
	}

	#[cfg(unix)]
	#[test]
	fn authority_follows_the_open_directory_across_rename() {
		let parent = TempDir::new().expect("temporary directory");
		let old_root = parent.path().join("old");
		let new_root = parent.path().join("new");
		fs::create_dir(&old_root).expect("create root");
		let config = ServerConfig::new(&old_root).expect("server config");
		let lock = config.try_lock_authority().expect("first authority");
		fs::rename(&old_root, &new_root).expect("rename root");

		let replacement = ServerConfig::new(&new_root).expect("replacement config");
		assert!(
			replacement.try_lock_authority().is_err(),
			"renaming a live root must not create another authority"
		);
		drop(lock);
		let _reacquired_authority = replacement
			.try_lock_authority()
			.expect("released renamed authority");
	}
}
