//! Content-addressed storage for binary payloads.
//!
//! Blobs are addressed by their SHA-256 digest, which deduplicates payloads
//! across sessions, makes writes idempotent, and gives references the same
//! meaning on every machine. Files live at `<root>/blobs/<hh>/<hh>/
//! <full-64-hex>`; the two fanout levels use the first two digest bytes so that
//! a single directory does not accumulate millions of entries.
//!
//! New blobs are written to `<root>/tmp`, flushed with `fsync`, and atomically
//! renamed into their final location, so readers never observe a
//! partially-written blob. [`BlobStore::get`] verifies length only by default.
//! Call [`BlobStore::verify`] when a full digest check is required.
//!
//! Blob-producing transactions intentionally finish before the journal entry
//! that makes them reachable. This put-before-journal ordering can leave an
//! unreferenced blob after a crash, but never a journal reference to a missing
//! blob. A streaming put holds a shared retention lease from temporary-file
//! creation through final placement; collection takes it exclusively before
//! inventory, so an active writer cannot age into a sweep candidate.

use std::{
	fmt::{self, Display},
	fs::{self, File, FileTimes, OpenOptions},
	io::{self, Read, Seek, SeekFrom, Write},
	path::{Path, PathBuf},
	process,
	sync::atomic::{AtomicBool, AtomicU64, Ordering},
	time::{Duration, SystemTime},
};

use bytes::Bytes;
use cap_std::{ambient_authority, fs::Dir};
use omp_ar::{Archive, Format};
use omp_core::{FastHashSet, Hash32, Str, encoding::hex::ArrayStr, hash32::Hasher};
use serde::{
	Deserialize, Deserializer, Serialize, Serializer,
	de::{self, Visitor},
	ser::SerializeStruct,
};
use thiserror::Error as ThisError;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const COPY_BUFFER_SIZE: usize = 64 * 1024;

/// A stable reference to a content-addressed blob.
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub struct BlobRef {
	/// The SHA-256 digest of the blob contents.
	pub hash: Hash32,
	/// The blob length in bytes.
	pub size: u64,
}

impl BlobRef {
	/// Returns the digest as 64 lowercase hexadecimal characters in stack
	/// storage.
	pub const fn to_hex(&self) -> ArrayStr<32> {
		self.hash.to_hex()
	}

	/// Parses a 64-character lowercase hexadecimal digest with the supplied byte
	/// length.
	///
	/// # Errors
	///
	/// Returns [`Error::BadHex`] when `hash` is not exactly 64 lowercase
	/// hexadecimal characters.
	pub fn parse_hex(hash: &str, size: u64) -> Result<Self, Error> {
		Ok(Self { hash: parse_hash(hash)?, size })
	}
}

impl Display for BlobRef {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.to_hex().as_str())
	}
}

impl Serialize for BlobRef {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		let hash = self.to_hex();
		let mut state = serializer.serialize_struct("BlobRef", 2)?;
		state.serialize_field("h", hash.as_str())?;
		state.serialize_field("n", &self.size)?;
		state.end()
	}
}

impl<'de> Deserialize<'de> for BlobRef {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		#[derive(Deserialize)]
		struct WireRef {
			#[serde(rename = "h", deserialize_with = "deserialize_hash")]
			hash: Hash32,
			#[serde(rename = "n")]
			size: u64,
		}

		let wire = WireRef::deserialize(deserializer)?;
		Ok(Self { hash: wire.hash, size: wire.size })
	}
}

/// Errors produced by blob reference parsing and blob-store operations.
#[derive(Debug, ThisError)]
pub enum Error {
	/// An underlying filesystem or stream operation failed.
	#[error(transparent)]
	Io(#[from] io::Error),
	/// A wheel archive was malformed or exceeded extraction limits.
	#[error(transparent)]
	Archive(#[from] omp_ar::Error),
	/// A wheel naming component was empty or unsafe for a store path.
	#[error("invalid wheel {component} component")]
	InvalidWheelComponent {
		/// Component kind rejected by the path validator.
		component: &'static str,
	},
	/// A wheel directory exists without the completion marker written before
	/// its atomic adoption.
	#[error("incomplete unpacked wheel directory")]
	IncompleteWheel,
	/// A blob's stored length differs from the referenced length.
	#[error("corrupt blob: expected {expected} bytes, found {actual} bytes")]
	Corrupt {
		/// The byte length recorded by the reference.
		expected: u64,
		/// The byte length found on disk.
		actual:   u64,
	},
	/// Blob bytes did not match the content-addressed digest.
	#[error("blob digest mismatch: expected {expected}, found {actual}")]
	DigestMismatch {
		/// Digest named by the durable reference.
		expected: Hash32,
		/// Digest computed from the stored bytes.
		actual:   Hash32,
	},
	/// A requested byte range starts beyond the stored content.
	#[error("blob range starts at {offset}, beyond stored size {size}")]
	RangeOutOfBounds {
		/// Requested zero-based byte offset.
		offset: u64,
		/// Complete stored blob size.
		size:   u64,
	},
	/// A digest was not exactly 64 lowercase hexadecimal characters.
	#[error("invalid SHA-256 hash hex")]
	BadHex,
	/// The referenced blob does not exist.
	#[error("blob not found")]
	NotFound,
	/// Collection was cancelled at a filesystem-entry boundary.
	#[error("blob collection was cancelled")]
	GcCancelled,
	/// Collection exceeded its traversal bound and stopped fail-closed.
	#[error("blob collection exceeded its {limit}-entry traversal bound")]
	GcTraversalLimit {
		/// Configured maximum filesystem entries.
		limit: usize,
	},
	/// An active blob writer holds the namespace retention lease.
	#[error("blob namespace has an active writer")]
	GcBusy,
	/// Collection encountered a tree deeper than its configured safety bound.
	#[error("blob collection exceeded its depth bound of {limit}")]
	GcDepthLimit {
		/// Configured maximum directory depth.
		limit: usize,
	},
}

/// Immutable wheel identity used for unpacked-store directory names.
///
/// A directory is named `<distribution>-<version>-<tag>-<sha256-16>`, tying
/// its contents to the exact wheel blob without relying on a mutable index.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WheelName {
	/// Normalized distribution name.
	pub distribution: Str,
	/// Wheel distribution version.
	pub version:      Str,
	/// Wheel compatibility tag.
	pub tag:          Str,
}

impl WheelName {
	/// Validates the path-safe components of a wheel store name.
	///
	/// # Errors
	///
	/// Returns [`Error::InvalidWheelComponent`] when a component is empty or
	/// contains a path separator.
	pub fn new(
		distribution: impl Into<Str>,
		version: impl Into<Str>,
		tag: impl Into<Str>,
	) -> Result<Self, Error> {
		let name = Self {
			distribution: distribution.into(),
			version:      version.into(),
			tag:          tag.into(),
		};
		for (component, value) in
			[("distribution", &name.distribution), ("version", &name.version), ("tag", &name.tag)]
		{
			if !is_store_component(value) {
				return Err(Error::InvalidWheelComponent { component });
			}
		}
		Ok(name)
	}
}

/// One bounded byte range opened from immutable content-addressed storage.
///
/// The open file pins the selected inode for the lifetime of the transfer, so
/// concurrent retention cleanup cannot switch or truncate a resumed read.
#[derive(Debug)]
pub struct BlobRange {
	reference: BlobRef,
	offset:    u64,
	length:    u64,
	file:      File,
}

impl BlobRange {
	/// Returns the identity of the complete stored blob.
	pub const fn reference(&self) -> BlobRef {
		self.reference
	}

	/// Returns the zero-based starting offset of this range.
	pub const fn offset(&self) -> u64 {
		self.offset
	}

	/// Returns the exact number of bytes selected for this range.
	pub const fn len(&self) -> u64 {
		self.length
	}

	/// Returns whether this range contains no bytes.
	pub const fn is_empty(&self) -> bool {
		self.length == 0
	}

	/// Transfers ownership of the positioned file to an asynchronous reader.
	pub fn into_file(self) -> File {
		self.file
	}
}

/// Five-minute safety window for a blob put that has completed but whose
/// journal entry has not committed yet. Collection keeps younger files even
/// when a crashed producer released its active retention lease before the
/// authoritative journal root became visible.
pub const DEFAULT_GC_GRACE: Duration = Duration::from_mins(5);

/// Policy for one mark-and-sweep pass over a blob namespace.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GcPolicy {
	/// Minimum age of an unreferenced final blob before removal.
	pub unreferenced_grace: Duration,
	/// Minimum age of an abandoned staging file or directory before removal.
	pub temporary_grace:    Duration,
}

impl Default for GcPolicy {
	fn default() -> Self {
		Self { unreferenced_grace: DEFAULT_GC_GRACE, temporary_grace: DEFAULT_GC_GRACE }
	}
}

/// Storage selected and reclaimed by one blob collection pass.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GcReport {
	/// Final blob files inspected.
	pub blobs_examined:             usize,
	/// Unreferenced final blob files old enough to remove.
	pub blobs_eligible:             usize,
	/// Bytes held by eligible final blob files.
	pub blob_bytes_eligible:        u64,
	/// Unreferenced final blob files removed.
	pub blobs_removed:              usize,
	/// Bytes removed from final blob files.
	pub blob_bytes_reclaimed:       u64,
	/// Abandoned staging files or directories old enough to remove.
	pub temporaries_eligible:       usize,
	/// Bytes held by eligible abandoned staging content.
	pub temporary_bytes_eligible:   u64,
	/// Abandoned staging files or directories removed.
	pub temporaries_removed:        usize,
	/// Bytes removed from abandoned staging files.
	pub temporary_bytes_reclaimed:  u64,
	/// Filesystem entries visited under the bounded traversal.
	pub filesystem_entries_visited: usize,
}

/// Controls a bounded dry-run or applying blob sweep.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GcSweep {
	/// Age policy for final and staging content.
	pub policy:      GcPolicy,
	/// Whether eligible content is removed.
	pub apply:       bool,
	/// Maximum filesystem entries visited in one namespace.
	pub max_entries: usize,
	/// Maximum directory nesting below `blobs/` or `tmp/`.
	pub max_depth:   usize,
}

impl GcSweep {
	/// Production applying sweep with conservative traversal bounds.
	#[must_use]
	pub const fn apply(policy: GcPolicy) -> Self {
		Self { policy, apply: true, max_entries: 1_000_000, max_depth: 64 }
	}

	/// Production dry-run sweep with the same selection semantics as apply.
	#[must_use]
	pub const fn dry_run(policy: GcPolicy) -> Self {
		Self { policy, apply: false, max_entries: 1_000_000, max_depth: 64 }
	}
}

struct GcWalk<'a> {
	options: GcSweep,
	cancel:  &'a AtomicBool,
	visited: usize,
}

struct TemporaryCandidate {
	path:      PathBuf,
	directory: bool,
	bytes:     u64,
}

impl GcWalk<'_> {
	fn ensure_depth(&self, depth: usize) -> Result<(), Error> {
		if self.cancel.load(Ordering::Relaxed) {
			return Err(Error::GcCancelled);
		}
		if depth > self.options.max_depth {
			return Err(Error::GcDepthLimit { limit: self.options.max_depth });
		}
		Ok(())
	}

	fn visit(&mut self, depth: usize) -> Result<(), Error> {
		self.ensure_depth(depth)?;
		self.visited = self.visited.saturating_add(1);
		if self.visited > self.options.max_entries {
			return Err(Error::GcTraversalLimit { limit: self.options.max_entries });
		}
		Ok(())
	}
}

/// A filesystem-backed, content-addressed blob store.
#[derive(Clone, Debug)]
pub struct BlobStore {
	root: PathBuf,
}

impl BlobStore {
	/// Opens a store rooted at `root`, creating its blob and temporary
	/// directories when absent.
	///
	/// # Errors
	///
	/// Returns [`Error::Io`] when the directory hierarchy cannot be created.
	pub fn open(root: impl Into<PathBuf>) -> Result<Self, Error> {
		let store = Self { root: root.into() };
		fs::create_dir_all(store.blobs_dir())?;
		fs::create_dir_all(store.tmp_dir())?;
		sync_directory(&store.root)?;
		sync_directory(&store.blobs_dir())?;
		sync_directory(&store.tmp_dir())?;
		if let Some(parent) = store
			.root
			.parent()
			.filter(|parent| !parent.as_os_str().is_empty())
		{
			sync_directory(parent)?;
		}
		Ok(store)
	}

	/// Returns the filesystem root that owns this blob namespace.
	pub fn root(&self) -> &Path {
		&self.root
	}

	/// Removes old unreferenced final blobs and abandoned staging content.
	///
	/// The namespace lock serializes final placement with collection. A
	/// successful deduplicated put refreshes the existing file's modification
	/// time, so `unreferenced_grace` also protects the put-before-journal
	/// transaction window. Callers may use a zero grace only while the store is
	/// quiescent (for example, in a test or an offline maintenance command).
	///
	/// # Errors
	///
	/// Returns [`Error::Io`] when the namespace cannot be locked, enumerated,
	/// inspected, or cleaned.
	pub fn collect_unreferenced(
		&self,
		retained: &FastHashSet<Hash32>,
		policy: GcPolicy,
	) -> Result<GcReport, Error> {
		let cancel = AtomicBool::new(false);
		self.sweep_unreferenced(retained, GcSweep::apply(policy), &cancel)
	}

	/// Selects or removes old unreferenced content using a bounded traversal.
	///
	/// The namespace lock is held for the whole walk, including dry-run, so
	/// candidate reporting and applying observe the same placement boundary.
	/// `cancel` is checked before every filesystem entry and destructive
	/// operation. A traversal-limit or cancellation error is fail-closed.
	///
	/// # Errors
	///
	/// Returns a typed error for cancellation, a configured traversal bound,
	/// namespace locking, enumeration, inspection, or removal.
	pub fn sweep_unreferenced(
		&self,
		retained: &FastHashSet<Hash32>,
		options: GcSweep,
		cancel: &AtomicBool,
	) -> Result<GcReport, Error> {
		let _retention = self.lock_gc_collector()?;
		let _lock = self.lock_namespace()?;
		let now = SystemTime::now();
		let mut report = GcReport::default();
		let mut blobs = Vec::new();
		let mut temporaries = Vec::new();
		let mut walk = GcWalk { options, cancel, visited: 0 };
		self.collect_blob_files(
			&self.blobs_dir(),
			retained,
			options.policy.unreferenced_grace,
			now,
			0,
			&mut walk,
			&mut report,
			&mut blobs,
		)?;
		self.collect_temporaries(
			options.policy.temporary_grace,
			now,
			&mut walk,
			&mut report,
			&mut temporaries,
		)?;
		report.filesystem_entries_visited = walk.visited;
		if options.apply {
			for (path, bytes) in blobs {
				if cancel.load(Ordering::Relaxed) {
					return Err(Error::GcCancelled);
				}
				match fs::remove_file(path) {
					Ok(()) => {
						report.blobs_removed += 1;
						report.blob_bytes_reclaimed = report.blob_bytes_reclaimed.saturating_add(bytes);
					},
					Err(error) if error.kind() == io::ErrorKind::NotFound => {},
					Err(error) => return Err(error.into()),
				}
			}
			for candidate in temporaries {
				if cancel.load(Ordering::Relaxed) {
					return Err(Error::GcCancelled);
				}
				let removed = if candidate.directory {
					fs::remove_dir_all(candidate.path)
				} else {
					fs::remove_file(candidate.path)
				};
				match removed {
					Ok(()) => {
						report.temporaries_removed += 1;
						report.temporary_bytes_reclaimed = report
							.temporary_bytes_reclaimed
							.saturating_add(candidate.bytes);
					},
					Err(error) if error.kind() == io::ErrorKind::NotFound => {},
					Err(error) => return Err(error.into()),
				}
			}
		}
		Ok(report)
	}

	/// Copies the selected content identities into another namespace.
	///
	/// Each source is streamed once through the destination's normal
	/// content-addressing path and its digest is checked. Existing destination
	/// content deduplicates without rewriting bytes.
	///
	/// # Errors
	///
	/// Returns [`Error::NotFound`] for a missing selected source,
	/// [`Error::DigestMismatch`] if stored bytes do not match their path, or a
	/// typed filesystem error.
	pub fn copy_retained_to(
		&self,
		destination: &Self,
		retained: &FastHashSet<Hash32>,
	) -> Result<usize, Error> {
		let mut copied = 0usize;
		for expected in retained {
			let probe = BlobRef { hash: *expected, size: 0 };
			let source = File::open(self.path(&probe)).map_err(map_read_error)?;
			let actual = destination.put_reader(source)?;
			if actual.hash != *expected {
				return Err(Error::DigestMismatch { expected: *expected, actual: actual.hash });
			}
			let destination_bytes = destination.get(&actual)?;
			let stored = Hash32::sum(&destination_bytes);
			if stored != *expected {
				return Err(Error::DigestMismatch { expected: *expected, actual: stored });
			}
			copied += 1;
		}
		Ok(copied)
	}

	/// Stores an in-memory blob and returns its content-derived reference.
	///
	/// This uses the same staged, single-pass placement authority as
	/// [`Self::put_reader`] and [`Self::begin_put`]. If the digest is already
	/// present, the operation succeeds without rewriting the file.
	///
	/// # Errors
	///
	/// Returns [`Error::Io`] when the input length cannot be represented or a
	/// filesystem operation fails.
	pub fn put(&self, data: &[u8]) -> Result<BlobRef, Error> {
		self.put_reader(data)
	}

	/// Streams a blob from `reader` into the store while computing its digest.
	///
	/// The reader is consumed once using one recycled fixed-size scratch
	/// allocation. Bytes pass through [`BlobStage`], so reader-driven and
	/// serializer-driven writes share hashing, synchronization, atomic
	/// placement, deduplication, and cleanup.
	///
	/// # Errors
	///
	/// Returns [`Error::Io`] when reading, writing, synchronizing, or renaming
	/// fails.
	pub fn put_reader(&self, mut reader: impl Read) -> Result<BlobRef, Error> {
		let mut stage = self.begin_put()?;
		let mut buffer = vec![0_u8; COPY_BUFFER_SIZE].into_boxed_slice();

		loop {
			let read = match reader.read(&mut buffer) {
				Ok(0) => break,
				Ok(read) => read,
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {
					continue;
				},
				Err(error) => {
					return Err(error.into());
				},
			};
			stage.write_all(&buffer[..read])?;
		}

		stage.finish()
	}

	/// Starts a store-owned streaming blob transaction.
	///
	/// Write already-encoded bytes into the returned [`BlobStage`] and call
	/// [`BlobStage::finish`] to synchronize and atomically adopt them. Dropping
	/// the stage, including while unwinding from a serializer error, removes its
	/// temporary file. Finalization deliberately precedes any journal record
	/// that makes the returned reference reachable.
	///
	/// # Errors
	///
	/// Returns [`Error::Io`] when a temporary staging file cannot be created.
	pub fn begin_put(&self) -> Result<BlobStage, Error> {
		let retention = self.lock_gc_writer()?;
		let (file, temporary) = self.create_temp()?;
		Ok(BlobStage {
			store: self.clone(),
			file: Some(file),
			_retention: retention,
			temporary,
			hasher: Hash32::hasher(),
			size: 0,
			failed: false,
		})
	}

	/// Reads a blob, checking that its stored byte length matches the reference.
	///
	/// This deliberately does not recompute the digest; use [`Self::verify`] for
	/// full content verification.
	///
	/// # Errors
	///
	/// Returns [`Error::NotFound`] when the blob is absent, [`Error::Corrupt`]
	/// when its length is wrong, or [`Error::Io`] for another read failure.
	pub fn get(&self, reference: &BlobRef) -> Result<Bytes, Error> {
		let data = fs::read(self.path(reference)).map_err(map_read_error)?;
		let actual = usize_to_u64(data.len())?;
		if actual != reference.size {
			return Err(Error::Corrupt { expected: reference.size, actual });
		}
		Ok(Bytes::from(data))
	}

	/// Opens a bounded range without materializing the complete blob.
	///
	/// `offset` may equal the complete stored size. A zero `length` selects the
	/// remainder; any other length is clamped to the available bytes. The
	/// returned identity always carries the complete size and digest so every
	/// resumed segment has the same provenance.
	///
	/// # Errors
	///
	/// Returns [`Error::NotFound`] when the digest is absent,
	/// [`Error::RangeOutOfBounds`] when `offset` exceeds the complete size, or
	/// [`Error::Io`] when metadata or positioning fails.
	pub fn open_range(&self, hash: Hash32, offset: u64, length: u64) -> Result<BlobRange, Error> {
		let probe = BlobRef { hash, size: 0 };
		let mut file = File::open(self.path(&probe)).map_err(map_read_error)?;
		let size = file.metadata()?.len();
		if offset > size {
			return Err(Error::RangeOutOfBounds { offset, size });
		}
		let available = size - offset;
		let length = if length == 0 {
			available
		} else {
			length.min(available)
		};
		file.seek(SeekFrom::Start(offset))?;
		Ok(BlobRange { reference: BlobRef { hash, size }, offset, length, file })
	}

	/// Returns whether the referenced blob path currently exists as a file.
	pub fn has(&self, reference: &BlobRef) -> bool {
		self.path(reference).is_file()
	}

	/// Returns the sharded filesystem path for a blob reference.
	///
	/// The layout is
	/// `<root>/blobs/<first-byte-hex>/<second-byte-hex>/<full-64-hex>`.
	pub fn path(&self, reference: &BlobRef) -> PathBuf {
		let hash = reference.to_hex();
		self
			.blobs_dir()
			.join(&hash[..2])
			.join(&hash[2..4])
			.join(hash.as_str())
	}

	/// Fully verifies that a blob's byte length and SHA-256 digest match its
	/// reference.
	///
	/// # Errors
	///
	/// Returns [`Error::NotFound`] when the blob is absent or [`Error::Io`] when
	/// it cannot be read.
	pub fn verify(&self, reference: &BlobRef) -> Result<bool, Error> {
		let mut file = File::open(self.path(reference)).map_err(map_read_error)?;
		let mut hasher = Hash32::hasher();
		let mut size = 0_u64;
		let mut buffer = vec![0_u8; COPY_BUFFER_SIZE].into_boxed_slice();

		loop {
			let read = match file.read(&mut buffer) {
				Ok(0) => break,
				Ok(read) => read,
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {
					continue;
				},
				Err(error) => {
					return Err(error.into());
				},
			};
			hasher.update(&buffer[..read]);
			size = size
				.checked_add(usize_to_u64(read)?)
				.ok_or_else(|| io::Error::other("blob length exceeds u64"))?;
		}

		Ok(size == reference.size && hasher.finalize().as_bytes() == reference.hash.as_bytes())
	}

	/// Returns the immutable unpacked-wheel directory for `wheel`.
	///
	/// The path is `<root>/<distribution>-<version>-<tag>-<sha256-16>`, the
	/// stable store convention shared by every materializer using this store.
	pub fn unpacked_wheel_path(&self, wheel: &WheelName, reference: &BlobRef) -> PathBuf {
		let digest = reference.to_hex();
		self.root.join(format!(
			"{}-{}-{}-{}",
			wheel.distribution,
			wheel.version,
			wheel.tag,
			&digest[..16]
		))
	}

	/// Unpacks a wheel blob into its immutable content-addressed store
	/// directory.
	///
	/// Existing matching directories are left untouched. Extraction happens in
	/// the store's temporary area and is renamed into place only after the ZIP
	/// reader has validated every member, so incomplete wheels are never
	/// observable.
	///
	/// # Errors
	///
	/// Returns an error when `reference` is missing or corrupt, the wheel is
	/// not a valid ZIP archive, or the filesystem cannot stage the directory.
	pub fn unpack_wheel(&self, wheel: &WheelName, reference: &BlobRef) -> Result<PathBuf, Error> {
		let _retention = self.lock_gc_writer()?;
		let destination = self.unpacked_wheel_path(wheel, reference);
		let complete = destination.join(".complete");
		if complete.is_file() {
			return Ok(destination);
		}
		if destination.try_exists()? {
			return Err(Error::IncompleteWheel);
		}
		let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let temporary = self
			.tmp_dir()
			.join(format!("{}-{sequence:016x}.wheel", process::id()));
		fs::create_dir(&temporary)?;
		let extracted = (|| {
			let bytes = self.get(reference)?;
			let mut archive = Archive::from_bytes_with_format(&bytes, Format::Zip)?;
			let directory = Dir::open_ambient_dir(&temporary, ambient_authority())?;
			archive.extract_to(&directory)?;
			fs::write(temporary.join(".complete"), b"")?;
			set_read_only_contents(&temporary)?;
			Ok::<(), Error>(())
		})();
		if let Err(error) = extracted {
			let _ = fs::remove_dir_all(&temporary);
			return Err(error);
		}
		match fs::rename(&temporary, &destination) {
			Ok(()) => {
				set_read_only(&destination)?;
				Ok(destination)
			},
			Err(_error) if destination.is_dir() => {
				let _ = fs::remove_dir_all(&temporary);
				Ok(destination)
			},
			Err(error) => {
				let _ = fs::remove_dir_all(&temporary);
				Err(error.into())
			},
		}
	}

	fn blobs_dir(&self) -> PathBuf {
		self.root.join("blobs")
	}

	fn tmp_dir(&self) -> PathBuf {
		self.root.join("tmp")
	}

	fn lock_gc_writer(&self) -> Result<GcLease, Error> {
		// A retained `BlobStore` remains usable if its empty root was removed
		// between operations (ephemeral sessions and cleanup rely on this).
		// Recreate the namespace before minting the stable writer lease.
		fs::create_dir_all(&self.root)?;
		let file = OpenOptions::new()
			.create(true)
			.read(true)
			.write(true)
			.open(self.root.join(".blobs-gc.lock"))?;
		File::lock_shared(&file)?;
		Ok(GcLease { _file: file })
	}

	fn lock_gc_collector(&self) -> Result<GcLease, Error> {
		let file = OpenOptions::new()
			.create(true)
			.read(true)
			.write(true)
			.open(self.root.join(".blobs-gc.lock"))?;
		match file.try_lock() {
			Ok(()) => Ok(GcLease { _file: file }),
			Err(fs::TryLockError::WouldBlock) => Err(Error::GcBusy),
			Err(fs::TryLockError::Error(source)) => Err(Error::Io(source)),
		}
	}

	fn lock_namespace(&self) -> Result<NamespaceLock, Error> {
		let file = OpenOptions::new()
			.create(true)
			.read(true)
			.write(true)
			.open(self.root.join(".blobs.lock"))?;
		file.lock()?;
		Ok(NamespaceLock { _file: file })
	}

	fn collect_blob_files(
		&self,
		directory: &Path,
		retained: &FastHashSet<Hash32>,
		grace: Duration,
		now: SystemTime,
		depth: usize,
		walk: &mut GcWalk<'_>,
		report: &mut GcReport,
		candidates: &mut Vec<(PathBuf, u64)>,
	) -> Result<(), Error> {
		walk.ensure_depth(depth)?;
		let entries = match fs::read_dir(directory) {
			Ok(entries) => entries,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
			Err(error) => return Err(error.into()),
		};
		for entry in entries {
			walk.visit(depth)?;
			let entry = entry?;
			let file_type = entry.file_type()?;
			let path = entry.path();
			if file_type.is_dir() {
				self.collect_blob_files(
					&path,
					retained,
					grace,
					now,
					depth.saturating_add(1),
					walk,
					report,
					candidates,
				)?;
				continue;
			}
			if !file_type.is_file() {
				continue;
			}
			report.blobs_examined += 1;
			let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
				continue;
			};
			let Ok(hash) = parse_hash(name) else {
				continue;
			};
			let metadata = entry.metadata()?;
			if retained.contains(&hash) || !old_enough(&metadata, now, grace) {
				continue;
			}
			let bytes = metadata.len();
			report.blobs_eligible += 1;
			report.blob_bytes_eligible = report.blob_bytes_eligible.saturating_add(bytes);
			candidates.push((path, bytes));
		}
		Ok(())
	}

	fn collect_temporaries(
		&self,
		grace: Duration,
		now: SystemTime,
		walk: &mut GcWalk<'_>,
		report: &mut GcReport,
		candidates: &mut Vec<TemporaryCandidate>,
	) -> Result<(), Error> {
		let entries = match fs::read_dir(self.tmp_dir()) {
			Ok(entries) => entries,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
			Err(error) => return Err(error.into()),
		};
		for entry in entries {
			walk.visit(0)?;
			let entry = entry?;
			let file_type = entry.file_type()?;
			if !file_type.is_file() && !file_type.is_dir() {
				continue;
			}
			let metadata = entry.metadata()?;
			if !old_enough(&metadata, now, grace) {
				continue;
			}
			let path = entry.path();
			let bytes = if file_type.is_file() {
				metadata.len()
			} else {
				directory_bytes(&path, 1, walk)?
			};
			report.temporaries_eligible += 1;
			report.temporary_bytes_eligible = report.temporary_bytes_eligible.saturating_add(bytes);
			candidates.push(TemporaryCandidate { path, directory: file_type.is_dir(), bytes });
		}
		Ok(())
	}

	fn prepare_destination(destination: &Path) -> Result<(), Error> {
		let parent = destination
			.parent()
			.ok_or_else(|| io::Error::other("blob destination has no parent"))?;
		fs::create_dir_all(parent)?;
		sync_directory(parent)?;
		if let Some(first_fanout) = parent.parent() {
			sync_directory(first_fanout)?;
			if let Some(blobs) = first_fanout.parent() {
				sync_directory(blobs)?;
			}
		}
		Ok(())
	}

	fn create_temp(&self) -> Result<(File, TemporaryPath), Error> {
		let directory = self.tmp_dir();
		fs::create_dir_all(&directory)?;
		loop {
			let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
			let name = format!("{}-{sequence:016x}.blob", process::id());
			let path = directory.join(name);
			match OpenOptions::new().write(true).create_new(true).open(&path) {
				Ok(file) => return Ok((file, TemporaryPath::new(path))),
				Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
				Err(error) => return Err(error.into()),
			}
		}
	}

	fn commit(mut temporary: TemporaryPath, destination: &Path) -> Result<(), Error> {
		match fs::rename(temporary.path(), destination) {
			Ok(()) => {
				temporary.disarm();
				sync_directory(
					destination
						.parent()
						.ok_or_else(|| io::Error::other("blob destination has no parent"))?,
				)?;
				Ok(())
			},
			Err(error)
				if error.kind() == io::ErrorKind::AlreadyExists && destination.try_exists()? =>
			{
				Ok(())
			},
			Err(error) => Err(error.into()),
		}
	}
}

/// A store-owned, single-pass writer for one content-addressed blob.
///
/// Each successful write is incorporated into the blob's SHA-256 digest and
/// byte length exactly once. The temporary content is removed unless
/// [`Self::finish`] successfully adopts it.
pub struct BlobStage {
	store:      BlobStore,
	file:       Option<File>,
	temporary:  TemporaryPath,
	hasher:     Hasher,
	size:       u64,
	failed:     bool,
	_retention: GcLease,
}

impl BlobStage {
	/// Synchronizes and atomically adopts the staged bytes, returning their
	/// exact content-derived reference.
	///
	/// An existing blob with the same digest is a successful deduplication. On
	/// any error, the unadopted temporary file is removed.
	///
	/// # Errors
	///
	/// Returns [`Error::Io`] when the stage has failed, or when synchronizing,
	/// preparing the destination, or atomically placing the blob fails.
	pub fn finish(mut self) -> Result<BlobRef, Error> {
		if self.failed {
			return Err(io::Error::other("blob stage previously failed").into());
		}

		let file = self.file.take().expect("blob stage file is present");
		file.sync_all()?;
		drop(file);

		let reference = BlobRef { hash: self.hasher.finalize(), size: self.size };
		let destination = self.store.path(&reference);
		let _lock = self.store.lock_namespace()?;
		if destination.try_exists()? {
			let file = OpenOptions::new().write(true).open(&destination)?;
			file.set_times(FileTimes::new().set_modified(SystemTime::now()))?;
			return Ok(reference);
		}

		BlobStore::prepare_destination(&destination)?;
		BlobStore::commit(self.temporary, &destination)?;
		Ok(reference)
	}

	const fn file(&mut self) -> &mut File {
		self.file.as_mut().expect("blob stage file is present")
	}
}

impl Write for BlobStage {
	fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
		let written = match self.file().write(buffer) {
			Ok(written) => written,
			Err(error) => {
				self.failed = true;
				return Err(error);
			},
		};
		self.hasher.update(&buffer[..written]);
		self.size = if let Some(size) = u64::try_from(written)
			.ok()
			.and_then(|written| self.size.checked_add(written))
		{
			size
		} else {
			self.failed = true;
			return Err(io::Error::other("blob length exceeds u64"));
		};
		Ok(written)
	}

	fn write_all(&mut self, mut buffer: &[u8]) -> io::Result<()> {
		while !buffer.is_empty() {
			match self.write(buffer) {
				Ok(0) => {
					self.failed = true;
					return Err(io::Error::new(io::ErrorKind::WriteZero, "failed to write staged blob"));
				},
				Ok(written) => buffer = &buffer[written..],
				Err(error) => return Err(error),
			}
		}
		Ok(())
	}

	fn flush(&mut self) -> io::Result<()> {
		match self.file().flush() {
			Ok(()) => Ok(()),
			Err(error) => {
				self.failed = true;
				Err(error)
			},
		}
	}
}

struct NamespaceLock {
	_file: File,
}

struct GcLease {
	_file: File,
}

struct TemporaryPath {
	path: Option<PathBuf>,
}

impl TemporaryPath {
	const fn new(path: PathBuf) -> Self {
		Self { path: Some(path) }
	}

	fn path(&self) -> &Path {
		self.path.as_deref().expect("temporary path is armed")
	}

	fn disarm(&mut self) {
		self.path = None;
	}
}

impl Drop for TemporaryPath {
	fn drop(&mut self) {
		if let Some(path) = self.path.take() {
			let _ = fs::remove_file(path);
		}
	}
}

fn old_enough(metadata: &fs::Metadata, now: SystemTime, grace: Duration) -> bool {
	metadata
		.modified()
		.ok()
		.and_then(|modified| now.duration_since(modified).ok())
		.is_some_and(|age| age >= grace)
}

fn directory_bytes(path: &Path, depth: usize, walk: &mut GcWalk<'_>) -> Result<u64, Error> {
	walk.ensure_depth(depth)?;
	let mut bytes = 0_u64;
	for entry in fs::read_dir(path)? {
		walk.visit(depth)?;
		let entry = entry?;
		let file_type = entry.file_type()?;
		if !file_type.is_file() && !file_type.is_dir() {
			continue;
		}
		let metadata = entry.metadata()?;
		bytes = bytes.saturating_add(if file_type.is_dir() {
			directory_bytes(&entry.path(), depth.saturating_add(1), walk)?
		} else {
			metadata.len()
		});
	}
	Ok(bytes)
}

fn is_store_component(value: &str) -> bool {
	!value.is_empty()
		&& value != "."
		&& value != ".."
		&& !value.bytes().any(|byte| matches!(byte, b'/' | b'\\' | 0))
}

fn set_read_only_tree(path: &Path) -> io::Result<()> {
	set_read_only_contents(path)?;
	set_read_only(path)
}

fn set_read_only_contents(path: &Path) -> io::Result<()> {
	for entry in fs::read_dir(path)? {
		let entry = entry?;
		let child = entry.path();
		if entry.file_type()?.is_dir() {
			set_read_only_tree(&child)?;
		} else {
			set_read_only(&child)?;
		}
	}
	Ok(())
}

fn set_read_only(path: &Path) -> io::Result<()> {
	let mut permissions = fs::metadata(path)?.permissions();
	permissions.set_readonly(true);
	fs::set_permissions(path, permissions)
}

fn sync_directory(path: &Path) -> Result<(), Error> {
	File::open(path)?.sync_all()?;
	Ok(())
}

fn parse_hash(hash: &str) -> Result<Hash32, Error> {
	hash.parse().map_err(|_| Error::BadHex)
}

fn deserialize_hash<'de, D>(deserializer: D) -> Result<Hash32, D::Error>
where
	D: Deserializer<'de>,
{
	struct HashVisitor;

	impl Visitor<'_> for HashVisitor {
		type Value = Hash32;

		fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
			formatter.write_str("64 lowercase hexadecimal characters")
		}

		fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
		where
			E: de::Error,
		{
			parse_hash(value).map_err(E::custom)
		}
	}

	deserializer.deserialize_str(HashVisitor)
}

fn usize_to_u64(value: usize) -> Result<u64, Error> {
	u64::try_from(value).map_err(|_| io::Error::other("blob length exceeds u64").into())
}

fn map_read_error(error: io::Error) -> Error {
	if error.kind() == io::ErrorKind::NotFound {
		Error::NotFound
	} else {
		Error::Io(error)
	}
}

#[cfg(test)]
mod tests {
	use std::fs;

	use omp_ar::zip::Writer;
	use tempfile::tempdir;

	use super::{BlobRef, BlobStore, Error, Hash32, WheelName};

	#[test]
	fn put_get_round_trip() {
		let directory = tempdir().unwrap();
		let store = BlobStore::open(directory.path()).unwrap();
		let reference = store.put(b"transcript payload").unwrap();

		assert_eq!(
			reference.to_hex().as_str(),
			"fb86318f0628fefbdc509787aec007728afa63279e7025be3fbd3bf8ba0cf7bd"
		);
		assert_eq!(store.get(&reference).unwrap(), &b"transcript payload"[..]);
		assert!(store.verify(&reference).unwrap());
	}

	#[test]
	fn identical_content_is_idempotent() {
		let directory = tempdir().unwrap();
		let store = BlobStore::open(directory.path()).unwrap();

		let first = store.put(b"shared payload").unwrap();
		let second = store.put(b"shared payload").unwrap();

		assert_eq!(first, second);
	}

	#[test]
	fn has_changes_after_put() {
		let directory = tempdir().unwrap();
		let store = BlobStore::open(directory.path()).unwrap();
		let expected = BlobRef { hash: Hash32::sum(b"present later"), size: 13 };

		assert!(!store.has(&expected));
		assert_eq!(store.put(b"present later").unwrap(), expected);
		assert!(store.has(&expected));
	}

	#[test]
	fn get_rejects_tampered_size() {
		let directory = tempdir().unwrap();
		let store = BlobStore::open(directory.path()).unwrap();
		let mut reference = store.put(b"length checked").unwrap();
		reference.size += 1;

		assert!(matches!(store.get(&reference), Err(Error::Corrupt { expected: 15, actual: 14 })));
	}

	#[test]
	fn verify_detects_corrupted_file() {
		let directory = tempdir().unwrap();
		let store = BlobStore::open(directory.path()).unwrap();
		let reference = store.put(b"original").unwrap();
		fs::write(store.path(&reference), b"tampered").unwrap();

		assert!(!store.verify(&reference).unwrap());
	}

	#[test]
	fn blob_ref_json_hex_round_trip() {
		let reference = BlobRef { hash: Hash32::new([0; 32]), size: 7 };
		let json = serde_json::to_string(&reference).unwrap();

		assert_eq!(
			json,
			"{\"h\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"n\":7}"
		);
		assert_eq!(serde_json::from_str::<BlobRef>(&json).unwrap(), reference);
	}

	#[test]
	fn wheel_unpack_uses_content_addressed_store_name_and_is_idempotent() {
		let directory = tempdir().unwrap();
		let store = BlobStore::open(directory.path()).unwrap();
		let mut wheel = Writer::new(Vec::new());
		wheel
			.add_file("example/__init__.py", b"value = 1\n")
			.unwrap();
		let reference = store.put(&wheel.finish().unwrap()).unwrap();
		let name = WheelName::new("example", "1.2.3", "py3-none-any").unwrap();

		let first = store.unpack_wheel(&name, &reference).unwrap();
		let second = store.unpack_wheel(&name, &reference).unwrap();

		assert_eq!(first, second);
		assert_eq!(
			first.file_name().unwrap().to_string_lossy(),
			format!("example-1.2.3-py3-none-any-{}", &reference.to_hex()[..16])
		);
		assert_eq!(fs::read(first.join("example/__init__.py")).unwrap(), b"value = 1\n");
	}
}
