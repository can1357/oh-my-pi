//! Atomic pruning of abandoned journal branches.

use std::{
	fs::{self, File, OpenOptions},
	io::{self, Write as _},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

use omp_core::{FastHashSet, Hash32};
use serde_json::Value;
use thiserror::Error;

use crate::{
	EntryId, Journal, JournalError, JournalNamespaceLock, WriterLock,
	blob::{BlobRef, BlobStore, GcPolicy, GcSweep},
	decode_committed, live_chain, sse,
};

/// Result of pruning one journal to its selected live chain.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GcReport {
	/// Committed entries before pruning.
	pub entries_before: usize,
	/// Live entries retained by the rewrite.
	pub entries_after:  usize,
	/// File bytes before pruning.
	pub bytes_before:   u64,
	/// File bytes after pruning.
	pub bytes_after:    u64,
}

impl GcReport {
	/// Number of abandoned entries removed.
	#[must_use]
	pub const fn entries_pruned(self) -> usize {
		self.entries_before.saturating_sub(self.entries_after)
	}

	/// Number of journal bytes reclaimed.
	#[must_use]
	pub const fn bytes_reclaimed(self) -> u64 {
		self.bytes_before.saturating_sub(self.bytes_after)
	}
}

/// Result of deriving journal roots and sweeping one project/session blob
/// namespace.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BlobGcReport {
	/// Session, child-job, checkpoint, or imported journals scanned.
	pub journals_scanned:        usize,
	/// Committed entries inspected across complete branch DAGs.
	pub entries_scanned:         usize,
	/// Journals containing abandoned branch history.
	pub journals_with_abandoned: usize,
	/// Abandoned entries that applying journal pruning would remove.
	pub abandoned_entries:       usize,
	/// Journal bytes that applying branch pruning would reclaim.
	pub journal_bytes_eligible:  u64,
	/// Distinct content digests retained by at least one journal history.
	pub roots_retained:          usize,
	/// Blob-store files inspected, selected, and possibly reclaimed.
	pub storage:                 crate::blob::GcReport,
}

/// Hard bounds and mutation policy for one journal-rooted CAS pass.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlobGcOptions {
	/// Whether selected CAS content is removed.
	pub apply:            bool,
	/// Whether abandoned branch entries continue to root blobs.
	pub retain_abandoned: bool,
	/// Age policy protecting put-before-journal transactions and stages.
	pub policy:           GcPolicy,
	/// Maximum journals in one shared CAS namespace.
	pub max_journals:     usize,
	/// Maximum committed entries inspected across those journals.
	pub max_entries:      usize,
	/// Maximum filesystem entries traversed in the CAS.
	pub max_blob_entries: usize,
	/// Maximum directory depth traversed in the CAS.
	pub max_blob_depth:   usize,
}

impl BlobGcOptions {
	/// Conservative production bounds for an applying collection.
	#[must_use]
	pub const fn apply(policy: GcPolicy) -> Self {
		Self {
			apply: true,
			retain_abandoned: true,
			policy,
			max_journals: 100_000,
			max_entries: 10_000_000,
			max_blob_entries: 1_000_000,
			max_blob_depth: 64,
		}
	}

	/// Conservative production bounds for a non-mutating collection preview.
	#[must_use]
	pub const fn dry_run(policy: GcPolicy) -> Self {
		Self { apply: false, ..Self::apply(policy) }
	}
}

/// Cloneable cancellation flag checked at journal, entry, and CAS boundaries.
#[derive(Clone, Debug, Default)]
pub struct GcCancellation {
	cancelled: Arc<AtomicBool>,
}

impl GcCancellation {
	/// Requests cancellation of an in-progress collection.
	pub fn cancel(&self) {
		self.cancelled.store(true, Ordering::Release);
	}

	/// Returns whether cancellation has been requested.
	#[must_use]
	pub fn is_cancelled(&self) -> bool {
		self.cancelled.load(Ordering::Acquire)
	}
}

/// Failure to inventory, collect, encode, or atomically replace journal
/// storage.
#[derive(Debug, Error)]
pub enum GcError {
	/// Existing journal validation or recovery failed.
	#[error("journal could not be opened for pruning")]
	Journal(#[from] JournalError),
	/// A retained entry could not be encoded.
	#[error("retained journal entry could not be encoded")]
	Encode(#[from] sse::SseError),
	/// A journal entry's data was not valid JSON, so collection could not prove
	/// its blob reachability.
	#[error("cannot derive blob roots from entry {entry} in {}", path.display())]
	RootData {
		/// Journal containing the invalid payload.
		path:   PathBuf,
		/// Entry whose payload could not be decoded.
		entry:  EntryId,
		/// Typed JSON decoder failure.
		#[source]
		source: serde_json::Error,
	},
	/// Blob-store enumeration or removal failed.
	#[error("blob collection failed")]
	Blob(#[from] crate::blob::Error),
	/// A filesystem operation failed.
	#[error("journal pruning I/O failed")]
	Io(#[from] io::Error),
	/// System time cannot be represented for a unique staging name.
	#[error("system clock is before the Unix epoch")]
	Clock(#[from] std::time::SystemTimeError),
	/// Collection was cancelled at a safe journal, entry, or CAS boundary.
	#[error("journal garbage collection was cancelled")]
	Cancelled,
	/// A supplied journal is not owned by the selected CAS namespace.
	#[error("journal {} is outside blob namespace {}", path.display(), root.display())]
	JournalOutsideNamespace {
		/// Supplied journal path.
		path: PathBuf,
		/// Selected project/session CAS root.
		root: PathBuf,
	},
	/// Journal discovery or entry scanning exceeded a configured hard bound.
	#[error("journal garbage collection exceeded its {resource} bound of {limit}")]
	Limit {
		/// Bounded resource that was exhausted.
		resource: &'static str,
		/// Configured maximum.
		limit:    usize,
	},
}

/// Marks every blob referenced by every committed entry of every supplied
/// journal, then sweeps old unreferenced content from `store`.
///
/// All journals are decoded successfully before the first file can be removed.
/// Roots include typed attachment/compaction/source-blob records, assistant
/// media elements journaled through `patch@1`, and artifact addresses nested
/// in tool payloads. Complete branch history remains rooted until
/// [`prune_abandoned`] removes it, so a later rewind cannot discover an evicted
/// blob. Scanning every session that shares the store means a session switch
/// or deleting one journal cannot evict content still used by another session.
///
/// # Errors
///
/// Returns without sweeping if any journal or JSON payload cannot be decoded,
/// preserving content when reachability is uncertain.
pub fn collect_blobs(
	store: &BlobStore,
	journals: &[PathBuf],
	policy: GcPolicy,
) -> Result<BlobGcReport, GcError> {
	collect_blobs_with(store, journals, BlobGcOptions::apply(policy), &GcCancellation::default())
}

/// Marks complete histories while holding every journal writer lease, then
/// previews or applies one bounded CAS sweep.
///
/// Journal paths are sorted and deduplicated before leases are acquired. The
/// leases remain held through the namespace-locked sweep, preventing a writer
/// from committing a newly reachable old blob after the mark boundary. Blob
/// producers that have not yet acquired a journal lease remain protected by
/// the age grace. Any locked journal, malformed payload, cancellation, or
/// traversal limit fails closed before unproven content can be removed.
///
/// # Errors
///
/// Returns a typed error without starting the CAS sweep when reachability is
/// incomplete, or when the bounded sweep cannot finish safely.
pub fn collect_blobs_with(
	store: &BlobStore,
	journals: &[PathBuf],
	options: BlobGcOptions,
	cancel: &GcCancellation,
) -> Result<BlobGcReport, GcError> {
	if cancel.is_cancelled() {
		return Err(GcError::Cancelled);
	}
	if journals.len() > options.max_journals {
		return Err(GcError::Limit { resource: "journal-count", limit: options.max_journals });
	}
	for path in journals {
		if path.parent().unwrap_or_else(|| Path::new(".")) != store.root() {
			return Err(GcError::JournalOutsideNamespace {
				path: path.clone(),
				root: store.root().to_path_buf(),
			});
		}
	}
	let _namespace = JournalNamespaceLock::acquire_exclusive(store.root())?;
	let mut paths = journals.to_vec();
	discover_namespace_journals(
		store.root(),
		options.max_blob_entries,
		options.max_journals,
		cancel,
		&mut paths,
	)?;
	paths.sort();
	paths.dedup();
	if paths.len() > options.max_journals {
		return Err(GcError::Limit { resource: "journal-count", limit: options.max_journals });
	}

	let mut leases = Vec::<WriterLock>::with_capacity(paths.len());
	let mut roots = FastHashSet::default();
	let mut entries_scanned = 0usize;
	let mut journals_with_abandoned = 0usize;
	let mut abandoned_entries = 0usize;
	let mut journal_bytes_eligible = 0u64;
	for path in &paths {
		if cancel.is_cancelled() {
			return Err(GcError::Cancelled);
		}
		let lock = WriterLock::acquire(path)?;
		let bytes = fs::read(path)?;
		let (entries, clean_len) = decode_committed(&bytes)?;
		entries_scanned = entries_scanned.saturating_add(entries.len());
		if entries_scanned > options.max_entries {
			return Err(GcError::Limit {
				resource: "journal-entry-count",
				limit:    options.max_entries,
			});
		}
		let retained: Vec<_> = live_chain(&entries).collect();
		let abandoned = entries.len().saturating_sub(retained.len());
		abandoned_entries = abandoned_entries.saturating_add(abandoned);
		if abandoned != 0 {
			journals_with_abandoned += 1;
			let mut encoded = Vec::new();
			for entry in &retained {
				sse::encode(entry, &mut encoded)?;
			}
			let retained_bytes =
				u64::try_from(encoded.len()).map_err(|_| io::Error::other("journal is too large"))?;
			let current_bytes = u64::try_from(clean_len).unwrap_or(u64::MAX);
			journal_bytes_eligible =
				journal_bytes_eligible.saturating_add(current_bytes.saturating_sub(retained_bytes));
		}
		if options.retain_abandoned {
			for entry in &entries {
				if cancel.is_cancelled() {
					return Err(GcError::Cancelled);
				}
				collect_entry_roots(path, entry, &mut roots)?;
			}
		} else {
			for entry in live_chain(&entries) {
				if cancel.is_cancelled() {
					return Err(GcError::Cancelled);
				}
				collect_entry_roots(path, entry, &mut roots)?;
			}
		}
		leases.push(lock);
	}

	let roots_retained = roots.len();
	let sweep = GcSweep {
		policy:      options.policy,
		apply:       options.apply,
		max_entries: options.max_blob_entries,
		max_depth:   options.max_blob_depth,
	};
	let storage = match store.sweep_unreferenced(&roots, sweep, &cancel.cancelled) {
		Ok(storage) => storage,
		Err(crate::blob::Error::GcCancelled) => return Err(GcError::Cancelled),
		Err(source) => return Err(GcError::Blob(source)),
	};
	drop(leases);
	Ok(BlobGcReport {
		journals_scanned: paths.len(),
		entries_scanned,
		journals_with_abandoned,
		abandoned_entries,
		journal_bytes_eligible,
		roots_retained,
		storage,
	})
}

fn discover_namespace_journals(
	root: &Path,
	max_entries: usize,
	max_journals: usize,
	cancel: &GcCancellation,
	output: &mut Vec<PathBuf>,
) -> Result<(), GcError> {
	let entries = match fs::read_dir(root) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(GcError::Io(error)),
	};
	for (visited, entry) in entries.enumerate() {
		if cancel.is_cancelled() {
			return Err(GcError::Cancelled);
		}
		if visited >= max_entries {
			return Err(GcError::Limit {
				resource: "journal-discovery-entry-count",
				limit:    max_entries,
			});
		}
		let entry = entry?;
		let file_type = entry.file_type()?;
		let path = entry.path();
		if file_type.is_file()
			&& path.extension().and_then(|extension| extension.to_str()) == Some(crate::FILE_EXTENSION)
		{
			output.push(path);
			if output.len() > max_journals {
				return Err(GcError::Limit { resource: "journal-count", limit: max_journals });
			}
		}
	}
	Ok(())
}

/// Copies exactly the blobs named by every committed entry of `journals` from
/// one project/session namespace into another.
///
/// Relocation retains the complete branch DAG, not only its current head, so
/// this deliberately includes abandoned-history media that a later rewind can
/// select. It neither bulk-copies unrelated project artifacts nor leaves the
/// moved journal pointing at absent content.
///
/// # Errors
///
/// Returns without copying if any journal payload cannot prove its roots, or
/// if a rooted source blob is missing or corrupt.
pub fn copy_journal_blobs(
	source: &BlobStore,
	destination: &BlobStore,
	journals: &[PathBuf],
) -> Result<usize, GcError> {
	let roots = journal_blob_roots(journals)?;
	Ok(source.copy_retained_to(destination, &roots)?)
}

/// Derives the complete set of content digests reachable from every committed
/// branch of `journals`.
///
/// The operation is fail-closed: one unreadable journal or payload returns an
/// error instead of a partial root set.
pub fn journal_blob_roots(journals: &[PathBuf]) -> Result<FastHashSet<Hash32>, GcError> {
	let mut roots = FastHashSet::default();
	for path in journals {
		let entries = Journal::scan(path)?;
		for entry in &entries {
			collect_entry_roots(path, entry, &mut roots)?;
		}
	}
	Ok(roots)
}

fn collect_entry_roots(
	path: &Path,
	entry: &crate::Entry,
	roots: &mut FastHashSet<Hash32>,
) -> Result<(), GcError> {
	let value = serde_json::from_str::<Value>(entry.data.as_str())
		.map_err(|source| GcError::RootData { path: path.to_path_buf(), entry: entry.id, source })?;
	collect_value_roots(&value, roots);
	Ok(())
}

fn collect_value_roots(value: &Value, roots: &mut FastHashSet<Hash32>) {
	match value {
		Value::Object(object) => {
			if let Some(hash) = object
				.get("h")
				.and_then(Value::as_str)
				.filter(|_| object.get("n").and_then(Value::as_u64).is_some())
				.and_then(parse_digest)
			{
				roots.insert(hash);
			}
			if let Some(hash) = object
				.get("hash")
				.and_then(Value::as_str)
				.filter(|_| {
					object.get("byte_len").and_then(Value::as_u64).is_some()
						|| object.get("size").and_then(Value::as_u64).is_some()
				})
				.and_then(parse_digest)
			{
				roots.insert(hash);
			}
			for child in object.values() {
				collect_value_roots(child, roots);
			}
		},
		Value::Array(array) => {
			for child in array {
				collect_value_roots(child, roots);
			}
		},
		Value::String(text) => collect_uri_roots(text, roots),
		Value::Null | Value::Bool(_) | Value::Number(_) => {},
	}
}

fn collect_uri_roots(text: &str, roots: &mut FastHashSet<Hash32>) {
	for prefix in ["artifact://sha256/", "blob:sha256:"] {
		let mut rest = text;
		while let Some(index) = rest.find(prefix) {
			rest = &rest[index + prefix.len()..];
			let Some(hex) = rest.get(..64) else {
				break;
			};
			if let Some(hash) = parse_digest(hex) {
				roots.insert(hash);
			}
			rest = &rest[64.min(rest.len())..];
		}
	}
}

fn parse_digest(hex: &str) -> Option<Hash32> {
	let source: &[u8; 64] = hex.as_bytes().try_into().ok()?;
	let mut normalized = *source;
	normalized.make_ascii_lowercase();
	let normalized = std::str::from_utf8(&normalized).ok()?;
	BlobRef::parse_hex(normalized, 0)
		.ok()
		.map(|reference| reference.hash)
}

/// Rewrites `path` atomically so it contains only the tail-selected live chain.
///
/// The replacement is fully encoded and synced beside the journal before the
/// atomic rename. A crash therefore leaves either the old complete journal or
/// the new complete journal at `path`; an unreferenced staging file is
/// harmless. Blob references remain embedded in retained entries and are not
/// rewritten.
///
/// The journal's writer lock is held from the initial read through the
/// rename, so a live session never keeps appending to an inode that was
/// unlinked underneath it: a session that has the journal open makes pruning
/// fail with [`JournalError::Locked`] instead.
///
/// # Errors
///
/// Returns a typed error if the source journal is invalid or locked, a
/// retained frame cannot be encoded, or staging/sync/replacement fails.
pub fn prune_abandoned(path: impl AsRef<Path>) -> Result<GcReport, GcError> {
	let path = path.as_ref();
	let (journal, entries) = Journal::open(path)?;
	let bytes_before = fs::metadata(path)?.len();
	let retained: Vec<_> = live_chain(&entries).cloned().collect();
	let entries_before = entries.len();
	let entries_after = retained.len();

	if entries_before == entries_after {
		return Ok(GcReport {
			entries_before,
			entries_after,
			bytes_before,
			bytes_after: bytes_before,
		});
	}

	let mut encoded = Vec::new();
	for entry in &retained {
		sse::encode(entry, &mut encoded)?;
	}
	let bytes_after =
		u64::try_from(encoded.len()).map_err(|_| io::Error::other("journal is too large"))?;
	let staging = staging_path(path)?;
	let permissions = fs::metadata(path)?.permissions();
	let mut staged = OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&staging)?;
	let result = (|| -> Result<(), io::Error> {
		staged.set_permissions(permissions)?;
		staged.write_all(&encoded)?;
		staged.sync_all()?;
		// Close the replaceable journal inode (required by Windows), but keep
		// its stable sidecar lock through rename and parent-directory sync.
		let _lock = journal.close_for_replace();
		fs::rename(&staging, path)?;
		if let Some(parent) = path
			.parent()
			.filter(|parent| !parent.as_os_str().is_empty())
		{
			File::open(parent)?.sync_all()?;
		}
		Ok(())
	})();
	if result.is_err() {
		let _ = fs::remove_file(&staging);
	}
	result?;

	Ok(GcReport { entries_before, entries_after, bytes_before, bytes_after })
}

fn staging_path(path: &Path) -> Result<PathBuf, GcError> {
	let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
	let name = path.file_name().unwrap_or_default().to_string_lossy();
	Ok(path.with_file_name(format!(".{name}.gc-{}-{nonce}.tmp", std::process::id())))
}
