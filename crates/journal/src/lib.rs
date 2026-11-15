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
pub mod idempotency;
pub mod kind;
pub mod runlog;
pub mod sse;
pub mod ulid;

use std::{
	fs::{self, File, OpenOptions},
	io::{self, BufRead, BufReader, Write as _},
	path::{Path, PathBuf},
};

pub use chain::{abandoned, live_chain};
pub use entry::{Entry, EntryDraft, EntryId};
pub use kind::{Kind, KindError, KindName, Vocabulary};
use omp_core::{FastHashSet, Str, Ulid};
use thiserror::Error;

use crate::{
	kind::JOURNAL,
	sse::{Block, FRAME_HARD_CAP, SseError, parse_frame_with, read_block},
	ulid::{MonotonicUlid, UlidGenerationError},
};

/// Read buffer for streaming journal decode. The decoder never holds more than
/// one frame ([`sse::FRAME_HARD_CAP`]) beyond this.
const READ_BUFFER: usize = 64 << 10;

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
	vocabulary:           Vocabulary,
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
		Self::create_with(path, Vocabulary::builtin())
	}

	/// Creates a new empty journal that also accepts the kinds in `vocabulary`.
	///
	/// # Errors
	///
	/// As [`Self::create`].
	pub fn create_with(
		path: impl AsRef<Path>,
		vocabulary: Vocabulary,
	) -> Result<Self, JournalError> {
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
			vocabulary,
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
		Self::open_with(path, Vocabulary::builtin())
	}

	/// Opens a journal that also accepts the kinds in `vocabulary`.
	///
	/// # Errors
	///
	/// As [`Self::open`].
	pub fn open_with(
		path: impl AsRef<Path>,
		vocabulary: Vocabulary,
	) -> Result<(Self, Vec<Entry>), JournalError> {
		let path = path.as_ref().to_path_buf();
		// Lock the stable sidecar before opening the journal. Locking the
		// journal inode itself is insufficient: GC replaces that inode, and
		// an opener that raced the rename could otherwise lock and append to
		// the unlinked predecessor.
		let namespace = JournalNamespaceLock::acquire_shared(&path)?;
		let lock = WriterLock::acquire(&path)?;
		let file = OpenOptions::new().append(true).read(true).open(&path)?;
		let decoded =
			decode_committed(BufReader::with_capacity(READ_BUFFER, File::open(&path)?), &vocabulary)?;
		let Decoded { entries, clean_len, torn_len } = decoded;
		if torn_len != 0 {
			file.set_len(clean_len)?;
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
				recovered_tail_bytes: torn_len,
				vocabulary,
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
		Self::scan_with(path, &Vocabulary::builtin())
	}

	/// [`Self::scan`] for a journal whose vocabulary is wider than the closed
	/// set.
	///
	/// # Errors
	///
	/// As [`Self::scan`].
	pub fn scan_with(
		path: impl AsRef<Path>,
		vocabulary: &Vocabulary,
	) -> Result<Vec<Entry>, JournalError> {
		let file = File::open(path)?;
		decode_committed(BufReader::with_capacity(READ_BUFFER, file), vocabulary)
			.map(|decoded| decoded.entries)
	}

	/// Reads the committed entries within the first `limit` bytes of a
	/// journal, without taking the writer lock.
	///
	/// A frame the limit cuts through is dropped exactly like a torn tail, so
	/// the result is always a prefix of what [`Self::scan`] returns. Indexes
	/// that only need facts a journal records when it is created (its genesis
	/// and creation-time `<meta>`) read this much instead of the whole
	/// history.
	///
	/// # Errors
	///
	/// Returns a typed error for I/O, malformed complete frames, invalid
	/// journal structure, or invalid branch links within the prefix.
	pub fn scan_prefix(path: impl AsRef<Path>, limit: u64) -> Result<Vec<Entry>, JournalError> {
		let file = io::Read::take(File::open(path)?, limit);
		decode_committed(BufReader::with_capacity(READ_BUFFER, file), &Vocabulary::builtin())
			.map(|decoded| decoded.entries)
	}

	/// Reports whether a writer currently holds the journal at `path`.
	///
	/// Read-only: it opens an **existing** `<journal>.lock` sidecar without
	/// `create` and tries a shared non-blocking lock, so it never creates a
	/// file, never truncates, and never takes the writer lock. A missing
	/// sidecar means no writer has ever opened the journal, so it is not live.
	/// The advisory lock dies with its holder, so a sidecar left behind by a
	/// finished or crashed writer is not live either.
	///
	/// The answer is a point-in-time observation: the shared lock is held only
	/// for the probe, and a writer that opens the journal an instant later is
	/// not seen. A writer racing the probe itself can see
	/// [`JournalError::Locked`] once; it is the caller's refusal to act on, not
	/// a stuck lock.
	///
	/// # Errors
	///
	/// Returns [`JournalError::Io`] when the sidecar exists but cannot be
	/// opened or locked for a reason other than the lock being held.
	pub fn is_live(path: impl AsRef<Path>) -> Result<bool, JournalError> {
		WriterLock::is_held(path.as_ref())
	}

	/// Appends and durably commits one entry.
	///
	/// # Errors
	///
	/// Returns a typed error when the draft violates genesis/cause/branch rules,
	/// its payload is not single-line JSON or exceeds one mebibyte, identity
	/// generation is exhausted, or the durable write fails.
	pub fn append(&mut self, draft: EntryDraft) -> Result<Entry, JournalError> {
		validate_draft(&draft, self.entry_count, &self.ids, &self.vocabulary)?;
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
		sse::encode_with(&entry, &mut encoded, &self.vocabulary).map_err(map_sse_write_error)?;
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
	/// A draft or entry names a kind outside the closed revision-1 vocabulary
	/// this build can write.
	#[error("journal kind {kind} is not in the closed revision-1 vocabulary")]
	UnknownKind {
		/// Unsupported versioned kind.
		kind: Kind,
	},
	/// A journal on disk was written by a newer revision of omp than this
	/// build understands: it holds an entry whose kind name or revision lies
	/// outside the closed vocabulary.
	///
	/// Fail-closed by design: replaying a history this build only partly
	/// understands would fold it into a wrong session, so the whole journal
	/// is refused and the user is told to upgrade.
	#[error("journal entry {kind} was written by a newer revision of omp; upgrade omp to open it")]
	NewerRevision {
		/// The first versioned kind this build cannot read.
		kind: Kind,
	},
	/// A journal's genesis declares a format version newer than this build
	/// supports ([`data::GENESIS_VERSION`]).
	///
	/// Fail-closed like [`Self::NewerRevision`].
	#[error(
		"journal format version {found} is newer than the supported version {supported}; upgrade \
		 omp to open it"
	)]
	NewerGenesisVersion {
		/// Version the genesis declares.
		found:     u32,
		/// Newest version this build reads and writes.
		supported: u32,
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
	/// A frame's block grew past [`sse::FRAME_HARD_CAP`] before its committing
	/// blank line, so it was rejected without buffering the rest.
	#[error("journal frame is larger than the {limit}-byte frame limit")]
	FrameTooLarge {
		/// The frame byte limit that was exceeded.
		limit: usize,
	},
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

/// The committed content of a journal file.
struct Decoded {
	/// Every complete frame, in file order.
	entries:   Vec<Entry>,
	/// Byte offset of the last commit point.
	clean_len: u64,
	/// Bytes after the last commit point (a torn tail).
	torn_len:  u64,
}

/// Streams every complete frame from `reader` without holding more than one
/// frame ([`sse::FRAME_HARD_CAP`]) in memory beyond its read buffer.
///
/// A block that reaches the cap without its committing blank line fails
/// before any more of it is buffered. A frame whose kind is outside the closed
/// vocabulary is reported as [`JournalError::NewerRevision`] rather than a
/// generic frame failure, so a journal written by a newer omp is diagnosed
/// instead of looking corrupt.
fn decode_committed<R: BufRead>(
	mut reader: R,
	vocabulary: &Vocabulary,
) -> Result<Decoded, JournalError> {
	let mut entries = Vec::new();
	let mut block = Vec::new();
	let mut clean_len = 0_u64;
	let mut torn_len = 0_u64;
	loop {
		match read_block(&mut reader, &mut block)? {
			Block::End => break,
			Block::Torn => {
				torn_len = block.len() as u64;
				break;
			},
			Block::TooLarge => {
				return Err(JournalError::FrameTooLarge { limit: FRAME_HARD_CAP });
			},
			Block::Complete => {
				clean_len += block.len() as u64;
				if block == b"\n" || block == b"\r\n" {
					continue;
				}
				entries.push(parse_frame_with(&block, vocabulary).map_err(|source| match source {
					SseError::UnknownKind { kind } => JournalError::NewerRevision { kind },
					source => JournalError::Frame { source },
				})?);
			},
		}
	}
	validate_history(&entries, vocabulary)?;
	validate_genesis_version(&entries)?;
	Ok(Decoded { entries, clean_len, torn_len })
}

/// Refuses a journal whose genesis declares a format version newer than
/// [`data::GENESIS_VERSION`].
///
/// Only the `version` field is read, and a genesis without a readable one is
/// accepted here: this check detects "written by a newer omp", it does not
/// validate the payload (the session index and fold own that).
fn validate_genesis_version(entries: &[Entry]) -> Result<(), JournalError> {
	#[derive(serde::Deserialize)]
	struct Header {
		version: Option<u32>,
	}

	let Some(genesis) = entries.first() else {
		return Ok(());
	};
	let Ok(Header { version: Some(found) }) = serde_json::from_str(genesis.data.as_str()) else {
		return Ok(());
	};
	if found > data::GENESIS_VERSION {
		return Err(JournalError::NewerGenesisVersion { found, supported: data::GENESIS_VERSION });
	}
	Ok(())
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
	/// Path of the sidecar lock for the journal at `path`.
	fn sidecar(path: &Path) -> PathBuf {
		let mut name = path.file_name().unwrap_or_default().to_os_string();
		name.push(".lock");
		path.with_file_name(name)
	}

	/// Probes the sidecar without creating it: `false` when it is absent or
	/// no one holds it, `true` when a writer holds the exclusive lock.
	fn is_held(path: &Path) -> Result<bool, JournalError> {
		let file = match File::open(Self::sidecar(path)) {
			Ok(file) => file,
			Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(false),
			Err(source) => return Err(JournalError::Io(source)),
		};
		match File::try_lock_shared(&file) {
			// The probe lock releases when `file` drops.
			Ok(()) => Ok(false),
			Err(fs::TryLockError::WouldBlock) => Ok(true),
			Err(fs::TryLockError::Error(source)) => Err(JournalError::Io(source)),
		}
	}

	/// Takes the journal's exclusive advisory lock without blocking.
	fn acquire(path: &Path) -> Result<Self, JournalError> {
		let file = OpenOptions::new()
			.create(true)
			.read(true)
			.write(true)
			.open(Self::sidecar(path))?;
		match file.try_lock() {
			Ok(()) => Ok(Self { _file: file }),
			Err(fs::TryLockError::WouldBlock) => {
				Err(JournalError::Locked { path: path.to_path_buf() })
			},
			Err(fs::TryLockError::Error(source)) => Err(JournalError::Io(source)),
		}
	}
}

fn validate_history(entries: &[Entry], vocabulary: &Vocabulary) -> Result<(), JournalError> {
	let mut ids = FastHashSet::default();
	for (index, entry) in entries.iter().enumerate() {
		validate_entry(entry, index, &ids, vocabulary)?;
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
	vocabulary: &Vocabulary,
) -> Result<(), JournalError> {
	validate_fields(
		&draft.kind,
		draft.by,
		draft.prior,
		&draft.label,
		&draft.data,
		index,
		ids,
		vocabulary,
	)
}

fn validate_entry(
	entry: &Entry,
	index: usize,
	ids: &FastHashSet<EntryId>,
	vocabulary: &Vocabulary,
) -> Result<(), JournalError> {
	validate_fields(
		&entry.kind,
		entry.by,
		entry.prior,
		&entry.label,
		&entry.data,
		index,
		ids,
		vocabulary,
	)
}

fn validate_fields(
	kind: &Kind,
	by: Option<EntryId>,
	prior: Option<EntryId>,
	label: &Option<Str>,
	data: &Str,
	index: usize,
	ids: &FastHashSet<EntryId>,
	vocabulary: &Vocabulary,
) -> Result<(), JournalError> {
	if !vocabulary.accepts(kind) {
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
		SseError::FrameTooLarge { limit } => JournalError::FrameTooLarge { limit },
		other => JournalError::Frame { source: other },
	}
}
