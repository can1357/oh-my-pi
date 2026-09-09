//! Crash-tolerant session journal and content-addressed blob storage.
//!
//! Each session is one flat raw-SSE `.oms` file. A blank line commits an
//! entry; opening a journal truncates only bytes after the last commit point.
//! Branches are `prior` links, so rewinding never destroys abandoned history.

pub mod blob;
mod chain;
pub mod data;
mod entry;
pub mod gc;
pub mod kind;
pub mod sse;
pub mod ulid;

use std::{
	fs::{self, File, OpenOptions},
	io::{self, Write as _},
	path::{Path, PathBuf},
};

pub use chain::{abandoned, live_chain};
pub use entry::{Entry, EntryDraft, EntryId};
pub use kind::{Kind, KindError, KindName};
use omp_core::{FastHashSet, Str, Ulid};
use thiserror::Error;

use crate::{
	kind::JOURNAL,
	sse::{Scanner, SseError},
	ulid::{MonotonicUlid, UlidGenerationError},
};

/// Conventional journal file extension.
pub const FILE_EXTENSION: &str = "oms";

/// The single writer for one session journal.
///
/// A live `Journal` holds an exclusive advisory lock on a stable sidecar for
/// its whole lifetime, so two processes (or two owners in one process) can
/// never append to divergent materializations of one `.oms`, and
/// [`gc::prune_abandoned`] cannot replace a file another writer is
/// appending to. It also holds a shared directory-namespace lease; collection
/// takes that lease exclusively from journal inventory through CAS sweep, so
/// a new writer cannot cross the mark boundary. Read-only consumers use
/// [`Journal::scan`], which takes no lock and never truncates.
#[derive(Debug)]
pub struct Journal {
	path:                 PathBuf,
	file:                 File,
	_lock:                WriterLock,
	_namespace:           JournalNamespaceLock,
	generator:            MonotonicUlid,
	ids:                  FastHashSet<EntryId>,
	entry_count:          usize,
	recovered_tail_bytes: u64,
}

impl Journal {
	/// Creates a new empty journal at `path`.
	///
	/// The first appended entry must be the `journal@1` genesis.
	///
	/// # Errors
	///
	/// Returns [`JournalError::Io`] if the parent cannot be created or the file
	/// already exists.
	pub fn create(path: impl AsRef<Path>) -> Result<Self, JournalError> {
		let path = path.as_ref().to_path_buf();
		if let Some(parent) = path
			.parent()
			.filter(|parent| !parent.as_os_str().is_empty())
		{
			fs::create_dir_all(parent)?;
		}
		let namespace = JournalNamespaceLock::acquire_shared(&path)?;
		let lock = WriterLock::acquire(&path)?;
		let file = OpenOptions::new()
			.create_new(true)
			.append(true)
			.read(true)
			.open(&path)?;
		Ok(Self {
			path,
			file,
			_lock: lock,
			_namespace: namespace,
			generator: MonotonicUlid::default(),
			ids: FastHashSet::default(),
			entry_count: 0,
			recovered_tail_bytes: 0,
		})
	}

	/// Opens an existing journal, returning its committed entries.
	///
	/// Bytes after the last committing blank line are physically truncated.
	/// The number removed is available through [`Self::recovered_tail_bytes`].
	///
	/// # Errors
	///
	/// Returns a typed error for I/O, malformed complete frames, invalid journal
	/// structure, or invalid branch links.
	pub fn open(path: impl AsRef<Path>) -> Result<(Self, Vec<Entry>), JournalError> {
		let path = path.as_ref().to_path_buf();
		// Lock the stable sidecar before opening the journal. Locking the
		// journal inode itself is insufficient: GC replaces that inode, and
		// an opener that raced the rename could otherwise lock and append to
		// the unlinked predecessor.
		let namespace = JournalNamespaceLock::acquire_shared(&path)?;
		let lock = WriterLock::acquire(&path)?;
		let file = OpenOptions::new().append(true).read(true).open(&path)?;
		let bytes = fs::read(&path)?;
		let (entries, clean_len) = decode_committed(&bytes)?;
		let truncated = bytes.len().saturating_sub(clean_len);
		if truncated != 0 {
			file.set_len(u64::try_from(clean_len).map_err(|_| JournalError::FileTooLarge)?)?;
			file.sync_data()?;
		}
		let mut ids = FastHashSet::default();
		let mut floor = None;
		for entry in &entries {
			ids.insert(entry.id);
			let id = entry.id.as_ulid();
			floor = Some(floor.map_or(id, |prior: Ulid| prior.max(id)));
		}
		Ok((
			Self {
				path,
				file,
				_lock: lock,
				_namespace: namespace,
				generator: MonotonicUlid::seeded(floor),
				ids,
				entry_count: entries.len(),
				recovered_tail_bytes: truncated as u64,
			},
			entries,
		))
	}

	/// Reads the committed entries of a journal without taking the writer
	/// lock or truncating a torn tail.
	///
	/// This is the read-only path for session indexes, pickers, and
	/// renderers of a journal that may be live in another process: it sees
	/// the committed prefix exactly as a later [`Self::open`] would.
	///
	/// # Errors
	///
	/// Returns a typed error for I/O, malformed complete frames, invalid
	/// journal structure, or invalid branch links.
	pub fn scan(path: impl AsRef<Path>) -> Result<Vec<Entry>, JournalError> {
		let bytes = fs::read(path)?;
		decode_committed(&bytes).map(|(entries, _)| entries)
	}

	/// Appends and durably commits one entry.
	///
	/// # Errors
	///
	/// Returns a typed error when the draft violates genesis/cause/branch rules,
	/// its payload is not single-line JSON or exceeds one mebibyte, identity
	/// generation is exhausted, or the durable write fails.
	pub fn append(&mut self, draft: EntryDraft) -> Result<Entry, JournalError> {
		validate_draft(&draft, self.entry_count, &self.ids)?;
		let id = EntryId::from(self.generator.generate()?);
		let entry = Entry {
			id,
			kind: draft.kind,
			by: draft.by,
			prior: draft.prior,
			label: draft.label,
			data: draft.data,
		};
		let mut encoded = Vec::with_capacity(entry.data.len() + 160);
		sse::encode(&entry, &mut encoded).map_err(map_sse_write_error)?;
		self.file.write_all(&encoded)?;
		self.file.sync_data()?;
		self.ids.insert(id);
		self.entry_count += 1;
		Ok(entry)
	}

	/// Returns the journal file path.
	#[must_use]
	pub fn path(&self) -> &Path {
		&self.path
	}

	/// Returns the number of torn-tail bytes removed by [`Self::open`].
	#[must_use]
	pub const fn recovered_tail_bytes(&self) -> u64 {
		self.recovered_tail_bytes
	}

	/// Closes the replaceable data inode while retaining the stable sidecar
	/// lock. GC uses this immediately before its atomic rename.
	pub(crate) fn close_for_replace(self) -> ReplaceLock {
		let Self { _lock, _namespace, .. } = self;
		ReplaceLock { _writer: _lock, _namespace }
	}
}

/// Journal creation, recovery, validation, and append failure.
#[derive(Debug, Error)]
pub enum JournalError {
	/// A filesystem operation failed.
	#[error("journal I/O failed")]
	Io(#[from] io::Error),
	/// A complete SSE frame is malformed.
	#[error("journal contains a malformed complete frame")]
	Frame {
		/// SSE codec failure.
		#[source]
		source: SseError,
	},
	/// A kind is outside the closed revision-1 vocabulary.
	#[error("journal kind {kind} is not in the closed revision-1 vocabulary")]
	UnknownKind {
		/// Unsupported versioned kind.
		kind: Kind,
	},
	/// A non-genesis entry has no causal `by` link.
	#[error("non-genesis entry {kind} requires a `by` cause")]
	MissingCause {
		/// Offending versioned kind.
		kind: Kind,
	},
	/// A non-genesis entry appeared before the genesis.
	#[error("the first journal entry must be journal@1 genesis")]
	GenesisMustBeFirst,
	/// A genesis entry appeared after the first position.
	#[error("journal@1 genesis may appear only as the first entry")]
	GenesisOnlyFirst,
	/// An explicit `prior` link does not name an earlier entry.
	#[error("journal prior entry {id} does not exist earlier in the file")]
	UnknownPrior {
		/// Missing branch target.
		id: EntryId,
	},
	/// An opened file repeats an entry identity.
	#[error("journal entry id {id} is duplicated")]
	DuplicateId {
		/// Repeated identity.
		id: EntryId,
	},
	/// The JSON payload exceeds one mebibyte.
	#[error("journal data payload is {len} bytes; maximum is 1048576")]
	DataTooLarge {
		/// Payload byte length.
		len: usize,
	},
	/// The JSON payload contains a physical line break.
	#[error("journal data payload must occupy one physical line")]
	MultilineData,
	/// The optional operation label contains a physical line break.
	#[error("journal operation label must occupy one physical line")]
	MultilineLabel,
	/// The JSON payload is malformed.
	#[error("journal data payload is invalid JSON")]
	InvalidData {
		/// JSON decoder failure.
		#[source]
		source: serde_json::Error,
	},
	/// The platform cannot represent the journal file length.
	#[error("journal file length cannot be represented")]
	FileTooLarge,
	/// Another writer holds the journal's exclusive lock.
	#[error("journal {} is locked by another writer", path.display())]
	Locked {
		/// Journal file path.
		path: PathBuf,
	},
	/// Namespace collection excludes session writers while establishing roots.
	#[error("journal namespace {} is locked for garbage collection", path.display())]
	NamespaceLocked {
		/// Namespace lock path.
		path: PathBuf,
	},
	/// No larger ULID can be generated.
	#[error(transparent)]
	Ulid(#[from] UlidGenerationError),
}

/// Decodes every complete frame, returning the entries and the byte offset of
/// the last commit point.
fn decode_committed(bytes: &[u8]) -> Result<(Vec<Entry>, usize), JournalError> {
	let mut scanner = Scanner::new(bytes);
	let mut entries = Vec::new();
	while let Some(frame) = scanner.next() {
		entries.push(
			frame
				.map_err(|source| JournalError::Frame { source })?
				.entry,
		);
	}
	let clean_len = scanner.offset();
	validate_history(&entries)?;
	Ok((entries, clean_len))
}

/// Stable sidecar lock shared by journal writers and atomic replacement.
///
/// The sidecar is deliberately never deleted: unlinking a lock file allows a
/// contender to create and lock a new inode while an existing owner still
/// holds the old one.
#[derive(Debug)]
pub(crate) struct WriterLock {
	_file: File,
}

/// Shared session-writer or exclusive collector lease for one journal
/// directory.
#[derive(Debug)]
pub(crate) struct JournalNamespaceLock {
	_file: File,
}

impl JournalNamespaceLock {
	fn path(journal: &Path) -> PathBuf {
		journal
			.parent()
			.unwrap_or_else(|| Path::new("."))
			.join(".journal-gc.lock")
	}

	fn acquire_shared(journal: &Path) -> Result<Self, JournalError> {
		let path = Self::path(journal);
		let file = OpenOptions::new()
			.create(true)
			.read(true)
			.write(true)
			.open(&path)?;
		match File::try_lock_shared(&file) {
			Ok(()) => Ok(Self { _file: file }),
			Err(fs::TryLockError::WouldBlock) => Err(JournalError::NamespaceLocked { path }),
			Err(fs::TryLockError::Error(source)) => Err(JournalError::Io(source)),
		}
	}

	pub(crate) fn acquire_exclusive(root: &Path) -> Result<Self, JournalError> {
		let path = root.join(".journal-gc.lock");
		let file = OpenOptions::new()
			.create(true)
			.read(true)
			.write(true)
			.open(&path)?;
		match file.try_lock() {
			Ok(()) => Ok(Self { _file: file }),
			Err(fs::TryLockError::WouldBlock) => Err(JournalError::NamespaceLocked { path }),
			Err(fs::TryLockError::Error(source)) => Err(JournalError::Io(source)),
		}
	}
}

/// Locks retained across an atomic journal inode replacement.
pub(crate) struct ReplaceLock {
	_writer:    WriterLock,
	_namespace: JournalNamespaceLock,
}

impl WriterLock {
	/// Takes the journal's exclusive advisory lock without blocking.
	fn acquire(path: &Path) -> Result<Self, JournalError> {
		let mut name = path.file_name().unwrap_or_default().to_os_string();
		name.push(".lock");
		let file = OpenOptions::new()
			.create(true)
			.read(true)
			.write(true)
			.open(path.with_file_name(name))?;
		match file.try_lock() {
			Ok(()) => Ok(Self { _file: file }),
			Err(fs::TryLockError::WouldBlock) => {
				Err(JournalError::Locked { path: path.to_path_buf() })
			},
			Err(fs::TryLockError::Error(source)) => Err(JournalError::Io(source)),
		}
	}
}

fn validate_history(entries: &[Entry]) -> Result<(), JournalError> {
	let mut ids = FastHashSet::default();
	for (index, entry) in entries.iter().enumerate() {
		validate_entry(entry, index, &ids)?;
		if !ids.insert(entry.id) {
			return Err(JournalError::DuplicateId { id: entry.id });
		}
	}
	Ok(())
}

fn validate_draft(
	draft: &EntryDraft,
	index: usize,
	ids: &FastHashSet<EntryId>,
) -> Result<(), JournalError> {
	validate_fields(&draft.kind, draft.by, draft.prior, &draft.label, &draft.data, index, ids)
}

fn validate_entry(
	entry: &Entry,
	index: usize,
	ids: &FastHashSet<EntryId>,
) -> Result<(), JournalError> {
	validate_fields(&entry.kind, entry.by, entry.prior, &entry.label, &entry.data, index, ids)
}

fn validate_fields(
	kind: &Kind,
	by: Option<EntryId>,
	prior: Option<EntryId>,
	label: &Option<Str>,
	data: &Str,
	index: usize,
	ids: &FastHashSet<EntryId>,
) -> Result<(), JournalError> {
	if !kind.is_known() {
		return Err(JournalError::UnknownKind { kind: kind.clone() });
	}
	let genesis = kind.name.as_str() == JOURNAL && kind.rev == 1;
	if !genesis && by.is_none() {
		return Err(JournalError::MissingCause { kind: kind.clone() });
	}
	if index == 0 && !genesis {
		return Err(JournalError::GenesisMustBeFirst);
	}
	if index != 0 && genesis {
		return Err(JournalError::GenesisOnlyFirst);
	}
	if let Some(prior) = prior
		&& !ids.contains(&prior)
	{
		return Err(JournalError::UnknownPrior { id: prior });
	}
	if data.len() > sse::DATA_HARD_CAP {
		return Err(JournalError::DataTooLarge { len: data.len() });
	}
	if data.bytes().any(|byte| matches!(byte, b'\r' | b'\n')) {
		return Err(JournalError::MultilineData);
	}
	if label
		.as_ref()
		.is_some_and(|value| value.bytes().any(|byte| matches!(byte, b'\r' | b'\n')))
	{
		return Err(JournalError::MultilineLabel);
	}
	serde_json::from_str::<serde::de::IgnoredAny>(data)
		.map(|_| ())
		.map_err(|source| JournalError::InvalidData { source })
}

fn map_sse_write_error(source: SseError) -> JournalError {
	match source {
		SseError::DataTooLarge { len } => JournalError::DataTooLarge { len },
		SseError::MultilineData => JournalError::MultilineData,
		SseError::MultilineLabel => JournalError::MultilineLabel,
		SseError::InvalidData { source } => JournalError::InvalidData { source },
		other => JournalError::Frame { source: other },
	}
}
