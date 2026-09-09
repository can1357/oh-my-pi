//! Content-addressed env blob storage and hash-only result references.

use std::{
	fmt, fs,
	io::{self, Read as _},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use omp_core::{FastHashSet, Hash32, Str, sf};
use omp_journal::{
	Journal, KindName,
	blob::{self, BlobRange, BlobRef, BlobStage, BlobStore},
	data::ToolResult,
	live_chain,
};
use omp_proto::{blob::v1 as blob_pb, thread::v1 as thread_pb};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use thiserror::Error;
use tokio::task;

const VERDICT_PENDING_LEASE_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const VERDICT_DOWNLOAD_GRACE_MS: i64 = 24 * 60 * 60 * 1_000;
const VERDICT_COLLECTION_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Stable content identity returned by blob host operations.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct BlobId {
	/// Raw SHA-256 content digest.
	pub hash: [u8; 32],
	/// Exact byte length of the content.
	pub size: u64,
}

impl From<BlobRef> for BlobId {
	fn from(reference: BlobRef) -> Self {
		Self { hash: reference.hash.into_bytes(), size: reference.size }
	}
}

impl From<BlobId> for BlobRef {
	fn from(id: BlobId) -> Self {
		Self { hash: Hash32::new(id.hash), size: id.size }
	}
}

/// An open complete or ranged blob read without text encoding.
#[derive(Debug)]
pub struct BlobRead {
	range: BlobRange,
}

impl BlobRead {
	/// Returns the identity of the complete stored content.
	pub fn id(&self) -> BlobId {
		self.range.reference().into()
	}

	/// Returns the requested starting byte offset.
	pub const fn offset(&self) -> u64 {
		self.range.offset()
	}

	/// Returns the exact selected byte count.
	pub const fn len(&self) -> u64 {
		self.range.len()
	}

	/// Returns whether the selected range is empty.
	pub const fn is_empty(&self) -> bool {
		self.range.is_empty()
	}

	/// Reads the selected range into one exact-sized shared buffer.
	///
	/// Streaming transports should use the crate-local file handoff instead.
	///
	/// # Errors
	/// Fails when the range length cannot fit this host, the file read fails,
	/// or the stored range ends before its declared byte count.
	pub fn read_all(self) -> Result<Bytes, BlobError> {
		let expected = self.len();
		let capacity = usize::try_from(expected).map_err(|_| BlobError::LengthOverflow)?;
		let mut data = Vec::with_capacity(capacity);
		self
			.into_file()
			.take(expected)
			.read_to_end(&mut data)
			.map_err(blob::Error::from)?;
		let actual = u64::try_from(data.len()).unwrap_or(u64::MAX);
		if actual != expected {
			return Err(BlobError::ReadTruncated { expected, actual });
		}
		Ok(Bytes::from(data))
	}

	/// Transfers the positioned file into the asynchronous transport reader.
	pub(crate) fn into_file(self) -> fs::File {
		self.range.into_file()
	}
}

/// A blob request or backing-store operation failed.
#[derive(Debug, Error)]
pub enum BlobError {
	/// Backing blob storage error.
	#[error(transparent)]
	Store(#[from] blob::Error),
	/// Blocking blob finalization task failed.
	#[error("blob finalization task failed: {0}")]
	FinalizeTask(#[from] task::JoinError),
	/// Blob hash format was not 32 bytes.
	#[error("blob hash must be exactly 32 bytes")]
	InvalidHash,
	/// Blob bytes did not match the expected digest.
	#[error("uploaded blob digest differs from the expected digest")]
	HashMismatch,
	/// Blob byte count differed from expected.
	#[error("uploaded blob size differs from expected {expected} bytes (received {actual})")]
	SizeMismatch {
		/// Expected byte count.
		expected: u64,
		/// Received byte count.
		actual:   u64,
	},
	/// Requested range started beyond content bounds.
	#[error("blob range starts at {offset}, beyond stored size {size}")]
	InvalidRange {
		/// Requested zero-based byte offset.
		offset: u64,
		/// Complete stored blob size.
		size:   u64,
	},
	/// A stored range ended before its selected byte count was read.
	#[error("blob range ended early: expected {expected} bytes, read {actual}")]
	ReadTruncated {
		/// Exact selected byte count.
		expected: u64,
		/// Bytes read before the unexpected end.
		actual:   u64,
	},
	/// Content length exceeded host address limits.
	#[error("blob length cannot be represented on this host")]
	LengthOverflow,
	/// Underlying filesystem removal operation failed.
	#[error("blob removal failed: {0}")]
	Remove(#[source] io::Error),
	/// Durable artifact metadata database failed.
	#[error("artifact metadata operation failed: {0}")]
	ArtifactMetadata(#[from] rusqlite::Error),
	/// A session journal could not be scanned while deriving verdict roots.
	#[error("could not derive verdict blob roots from {}", path.display())]
	JournalScan {
		/// Journal whose committed live chain could not be read.
		path:   PathBuf,
		/// Typed journal read or framing failure.
		#[source]
		source: omp_journal::JournalError,
	},
	/// A tool-result revision is newer than the collector's root decoder.
	#[error("cannot collect verdict blobs with tool.result@{rev} in {}", path.display())]
	UnsupportedJournalResult {
		/// Journal containing the unsupported terminal result.
		path: PathBuf,
		/// Tool-result schema revision.
		rev:  u32,
	},
	/// A revision-1 tool result could not be decoded while deriving verdict
	/// roots.
	#[error("could not decode a verdict blob root from {}", path.display())]
	JournalResult {
		/// Journal containing the invalid terminal result.
		path:   PathBuf,
		/// Typed terminal-payload decode failure.
		#[source]
		source: serde_json::Error,
	},
	/// A retained verdict blob is still reachable or awaiting durable adoption.
	#[error("verdict blob is pinned by an active delivery or session journal")]
	VerdictPinned,
	/// The host clock cannot produce an artifact creation time.
	#[error("artifact creation time is before the Unix epoch")]
	ArtifactClock,
}
/// JSON-facing metadata complement to the content/retention catalog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactMetadata {
	/// Monotonic catalog identity.
	pub catalog_id:  u64,
	/// Media type supplied at adoption, defaulted once by the authority.
	pub media_type:  Str,
	/// Optional user-facing description.
	pub description: Option<Str>,
	/// Core-authenticated source identity.
	pub source:      Str,
	/// Durable creation time.
	pub created_ms:  u64,
}

/// Durable owner of artifact metadata not represented by the GC roots table.
#[derive(Clone)]
pub struct ArtifactMetadataStore {
	connection: Arc<Mutex<Connection>>,
}

impl ArtifactMetadataStore {
	/// Opens the metadata table beside the authoritative blob catalog.
	pub fn open(store: &BlobStore) -> Result<Self, BlobError> {
		let connection = Connection::open(store.root().join("artifact-metadata.sqlite3"))?;
		connection.pragma_update(None, "journal_mode", "WAL")?;
		connection.pragma_update(None, "synchronous", "FULL")?;
		connection.execute_batch(
			"CREATE TABLE IF NOT EXISTS artifact_metadata (
			 catalog_id INTEGER PRIMARY KEY,
			 media_type TEXT NOT NULL,
			 description TEXT,
			 source TEXT NOT NULL,
			 created_ms INTEGER NOT NULL
			 ) WITHOUT ROWID;",
		)?;
		Ok(Self { connection: Arc::new(Mutex::new(connection)) })
	}

	/// Records metadata exactly once so retries cannot rewrite provenance.
	pub fn record(
		&self,
		catalog_id: u64,
		media_type: Option<&str>,
		description: Option<&str>,
		source: &str,
	) -> Result<ArtifactMetadata, BlobError> {
		let created_ms = u64::try_from(
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.map_err(|_| BlobError::ArtifactClock)?
				.as_millis(),
		)
		.unwrap_or(u64::MAX);
		let media_type = media_type.unwrap_or("application/octet-stream");
		let connection = self.connection.lock();
		connection.execute(
			"INSERT OR IGNORE INTO artifact_metadata(
			 catalog_id, media_type, description, source, created_ms
			 ) VALUES (?1, ?2, ?3, ?4, ?5)",
			params![catalog_id, media_type, description, source, created_ms],
		)?;
		drop(connection);
		self
			.get(catalog_id)?
			.ok_or_else(|| BlobError::ArtifactMetadata(rusqlite::Error::QueryReturnedNoRows))
	}

	/// Loads metadata for one catalog record.
	pub fn get(&self, catalog_id: u64) -> Result<Option<ArtifactMetadata>, BlobError> {
		self
			.connection
			.lock()
			.query_row(
				"SELECT catalog_id, media_type, description, source, created_ms
				 FROM artifact_metadata WHERE catalog_id = ?1",
				[catalog_id],
				|row| {
					Ok(ArtifactMetadata {
						catalog_id:  row.get(0)?,
						media_type:  Str::new(row.get::<_, String>(1)?),
						description: row.get::<_, Option<String>>(2)?.map(Str::new),
						source:      Str::new(row.get::<_, String>(3)?),
						created_ms:  row.get(4)?,
					})
				},
			)
			.optional()
			.map_err(BlobError::from)
	}
}

/// Durable delivery leases plus journal-derived roots for worker verdict blobs.
///
/// Each lease is keyed by durable session, invocation identity, and blob
/// digest, so one verdict can deliver its structured outcome plus every media
/// part without one lease overwriting another. Equal call ids or equal content
/// in another session cannot acknowledge it. Only
/// blobs registered by [`BlobHost::retain_verdict`] participate in this
/// collector. Other environment CAS users keep their existing lifetime.
struct VerdictRetention {
	connection:        Mutex<Connection>,
	sessions_dir:      PathBuf,
	collector_started: AtomicBool,
}

impl fmt::Debug for VerdictRetention {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("VerdictRetention")
			.field("sessions_dir", &self.sessions_dir)
			.finish_non_exhaustive()
	}
}

impl VerdictRetention {
	fn open(store: &BlobStore, sessions_dir: PathBuf) -> Result<Self, BlobError> {
		let connection = Connection::open(store.root().join("verdict-retention.sqlite3"))?;
		connection.busy_timeout(Duration::from_secs(5))?;
		connection.pragma_update(None, "journal_mode", "WAL")?;
		connection.pragma_update(None, "synchronous", "FULL")?;
		connection.pragma_update(None, "foreign_keys", "ON")?;
		connection.execute_batch(
			"CREATE TABLE IF NOT EXISTS verdict_blob (
			 hash BLOB PRIMARY KEY,
			 size INTEGER NOT NULL,
			 created_ms INTEGER NOT NULL
			 ) WITHOUT ROWID;
			 CREATE TABLE IF NOT EXISTS verdict_lease (
			 delivery_key TEXT NOT NULL,
			 hash BLOB NOT NULL,
			 deadline_ms INTEGER NOT NULL,
			 downloaded INTEGER NOT NULL DEFAULT 0,
			 PRIMARY KEY(delivery_key, hash),
			 FOREIGN KEY(hash) REFERENCES verdict_blob(hash) ON DELETE CASCADE
			 ) WITHOUT ROWID;
			 CREATE INDEX IF NOT EXISTS verdict_lease_hash
			 ON verdict_lease(hash);",
		)?;
		let legacy_key = connection
			.query_row(
				"SELECT 1 FROM pragma_table_info('verdict_lease')
				 WHERE name = 'invocation_id'",
				[],
				|row| row.get::<_, i64>(0),
			)
			.optional()?
			.is_some();
		if legacy_key {
			connection
				.execute("ALTER TABLE verdict_lease RENAME COLUMN invocation_id TO delivery_key", [])?;
		}
		let hash_is_key = connection.query_row(
			"SELECT pk FROM pragma_table_info('verdict_lease') WHERE name = 'hash'",
			[],
			|row| row.get::<_, i64>(0),
		)? != 0;
		if !hash_is_key {
			connection.execute_batch(
				"ALTER TABLE verdict_lease RENAME TO verdict_lease_single;
				 CREATE TABLE verdict_lease (
				  delivery_key TEXT NOT NULL,
				  hash BLOB NOT NULL,
				  deadline_ms INTEGER NOT NULL,
				  downloaded INTEGER NOT NULL DEFAULT 0,
				  PRIMARY KEY(delivery_key, hash),
				  FOREIGN KEY(hash) REFERENCES verdict_blob(hash) ON DELETE CASCADE
				 ) WITHOUT ROWID;
				 INSERT INTO verdict_lease(delivery_key, hash, deadline_ms, downloaded)
				  SELECT delivery_key, hash, deadline_ms, downloaded FROM verdict_lease_single;
				 DROP TABLE verdict_lease_single;
				 CREATE INDEX verdict_lease_hash ON verdict_lease(hash);",
			)?;
		}
		Ok(Self {
			connection: Mutex::new(connection),
			sessions_dir,
			collector_started: AtomicBool::new(false),
		})
	}

	fn start_collector(self: &Arc<Self>, store: BlobStore) {
		let Ok(runtime) = tokio::runtime::Handle::try_current() else {
			return;
		};
		if self.collector_started.swap(true, Ordering::AcqRel) {
			return;
		}
		let retention = Arc::downgrade(self);
		runtime.spawn(async move {
			loop {
				tokio::time::sleep(VERDICT_COLLECTION_INTERVAL).await;
				let Some(retention) = retention.upgrade() else {
					break;
				};
				let store = store.clone();
				let result = task::spawn_blocking(move || {
					let now = retention_now_ms()?;
					retention.collect(&store, now)
				})
				.await;
				match result {
					Ok(Ok(_)) => {},
					Ok(Err(error)) => {
						tracing::warn!(%error, "worker verdict collection failed closed");
					},
					Err(error) => {
						tracing::warn!(%error, "worker verdict collector task failed");
					},
				}
			}
		});
	}

	fn finish_stage(&self, stage: BlobStage, now_ms: i64) -> Result<BlobRef, BlobError> {
		let mut connection = self.connection.lock();
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		let reference = stage.finish()?;
		let size = i64::try_from(reference.size).map_err(|_| BlobError::LengthOverflow)?;
		transaction.execute(
			"INSERT OR IGNORE INTO verdict_blob(hash, size, created_ms)
			 VALUES (?1, ?2, ?3)",
			params![reference.hash.as_bytes().as_slice(), size, now_ms],
		)?;
		let retained_size = transaction.query_row(
			"SELECT size FROM verdict_blob WHERE hash = ?1",
			[reference.hash.as_bytes().as_slice()],
			|row| row.get::<_, i64>(0),
		)?;
		if retained_size != size {
			return Err(BlobError::SizeMismatch {
				expected: u64::try_from(retained_size).unwrap_or_default(),
				actual:   reference.size,
			});
		}
		let provisional = provisional_lease_id(&reference.hash);
		transaction.execute(
			"INSERT INTO verdict_lease(delivery_key, hash, deadline_ms, downloaded)
			 VALUES (?1, ?2, ?3, 0)
			 ON CONFLICT(delivery_key, hash) DO UPDATE SET
			 deadline_ms = excluded.deadline_ms,
			 downloaded = 0",
			params![
				provisional,
				reference.hash.as_bytes().as_slice(),
				now_ms.saturating_add(VERDICT_PENDING_LEASE_MS)
			],
		)?;
		transaction.commit()?;
		Ok(reference)
	}

	fn retain(
		&self,
		store: &BlobStore,
		session_id: Option<&str>,
		invocation_id: &str,
		id: BlobId,
		now_ms: i64,
	) -> Result<(), BlobError> {
		let reference = BlobRef::from(id);
		let size = i64::try_from(id.size).map_err(|_| BlobError::LengthOverflow)?;
		let deadline = now_ms.saturating_add(VERDICT_PENDING_LEASE_MS);
		let mut connection = self.connection.lock();
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		let metadata = fs::metadata(store.path(&reference)).map_err(|error| {
			if error.kind() == io::ErrorKind::NotFound {
				BlobError::Store(blob::Error::NotFound)
			} else {
				BlobError::Store(error.into())
			}
		})?;
		if metadata.len() != id.size {
			return Err(BlobError::SizeMismatch { expected: id.size, actual: metadata.len() });
		}
		transaction.execute(
			"INSERT OR IGNORE INTO verdict_blob(hash, size, created_ms)
			 VALUES (?1, ?2, ?3)",
			params![id.hash.as_slice(), size, now_ms],
		)?;
		let retained_size = transaction.query_row(
			"SELECT size FROM verdict_blob WHERE hash = ?1",
			[id.hash.as_slice()],
			|row| row.get::<_, i64>(0),
		)?;
		if retained_size != size {
			return Err(BlobError::SizeMismatch {
				expected: u64::try_from(retained_size).unwrap_or_default(),
				actual:   id.size,
			});
		}
		transaction.execute(
			"INSERT INTO verdict_lease(delivery_key, hash, deadline_ms, downloaded)
			 VALUES (?1, ?2, ?3, 0)
			 ON CONFLICT(delivery_key, hash) DO UPDATE SET
			 deadline_ms = excluded.deadline_ms,
			 downloaded = 0",
			params![delivery_key(session_id, invocation_id), id.hash.as_slice(), deadline],
		)?;
		transaction.execute("DELETE FROM verdict_lease WHERE delivery_key = ?1", [
			provisional_lease_id(&reference.hash),
		])?;
		transaction.commit()?;
		Ok(())
	}

	fn tracked(&self, hash: [u8; 32]) -> Result<bool, BlobError> {
		self
			.connection
			.lock()
			.query_row("SELECT 1 FROM verdict_blob WHERE hash = ?1", [hash.as_slice()], |row| {
				row.get::<_, i64>(0)
			})
			.optional()
			.map(|row| row.is_some())
			.map_err(BlobError::from)
	}

	fn renew(
		&self,
		session_id: Option<&str>,
		invocation_id: &str,
		id: BlobId,
		now_ms: i64,
	) -> Result<bool, BlobError> {
		let deadline = now_ms.saturating_add(VERDICT_PENDING_LEASE_MS);
		let updated = self.connection.lock().execute(
			"UPDATE verdict_lease SET deadline_ms = ?1
			 WHERE delivery_key = ?2 AND hash = ?3 AND downloaded = 0",
			params![deadline, delivery_key(session_id, invocation_id), id.hash.as_slice()],
		)?;
		Ok(updated != 0)
	}

	fn downloaded(
		&self,
		session_id: Option<&str>,
		invocation_id: &str,
		id: BlobId,
		now_ms: i64,
	) -> Result<bool, BlobError> {
		let deadline = now_ms.saturating_add(VERDICT_DOWNLOAD_GRACE_MS);
		let updated = self.connection.lock().execute(
			"UPDATE verdict_lease SET deadline_ms = ?1, downloaded = 1
			 WHERE delivery_key = ?2 AND hash = ?3 AND downloaded = 0",
			params![deadline, delivery_key(session_id, invocation_id), id.hash.as_slice()],
		)?;
		Ok(updated != 0)
	}

	fn roots(&self) -> Result<FastHashSet<Hash32>, BlobError> {
		let mut paths = Vec::new();
		collect_journal_paths(&self.sessions_dir, &mut paths)?;
		let mut roots = FastHashSet::default();
		for path in paths {
			let entries = Journal::scan(&path)
				.map_err(|source| BlobError::JournalScan { path: path.clone(), source })?;
			for entry in live_chain(&entries) {
				if entry.kind.name.as_str() != <&'static str>::from(KindName::ToolResult) {
					continue;
				}
				if entry.kind.rev != 1 {
					return Err(BlobError::UnsupportedJournalResult {
						path: path.clone(),
						rev:  entry.kind.rev,
					});
				}
				let result = serde_json::from_str::<ToolResult>(entry.data.as_str())
					.map_err(|source| BlobError::JournalResult { path: path.clone(), source })?;
				let source_blob = match result {
					ToolResult::Outcome { source_blob, .. } | ToolResult::Fault { source_blob, .. } => {
						source_blob
					},
				};
				if let Some(source_blob) = source_blob {
					roots.insert(source_blob.hash);
				}
			}
		}
		Ok(roots)
	}

	fn collect(&self, store: &BlobStore, now_ms: i64) -> Result<usize, BlobError> {
		let stored_files = collect_store_blob_files(store)?;
		let (has_candidates, orphan_files) = {
			let mut connection = self.connection.lock();
			let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
			transaction.execute("DELETE FROM verdict_lease WHERE deadline_ms <= ?1", [now_ms])?;
			let candidates = transaction.query_row(
				"SELECT EXISTS(
				   SELECT 1 FROM verdict_blob AS blob
				   WHERE NOT EXISTS (
				     SELECT 1 FROM verdict_lease AS lease WHERE lease.hash = blob.hash
				   )
				 )",
				[],
				|row| row.get::<_, bool>(0),
			)?;
			let tracked = {
				let mut statement = transaction.prepare("SELECT hash FROM verdict_blob")?;
				let rows = statement.query_map([], |row| row.get::<_, Vec<u8>>(0))?;
				let mut tracked = FastHashSet::default();
				for row in rows {
					let hash = row?;
					if let Ok(hash) = <[u8; 32]>::try_from(hash.as_slice()) {
						tracked.insert(Hash32::new(hash));
					}
				}
				tracked
			};
			transaction.commit()?;
			let orphans = stored_files
				.into_iter()
				.filter(|(_, hash)| !tracked.contains(hash))
				.collect::<Vec<_>>();
			(candidates, orphans)
		};
		if !has_candidates && orphan_files.is_empty() {
			return Ok(0);
		}
		// Derive roots only when a tracked verdict or crash orphan is eligible.
		// Any unreadable journal aborts collection, preferring a leak to
		// premature deletion.
		let roots = self.roots()?;
		let mut connection = self.connection.lock();
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		transaction.execute("DELETE FROM verdict_lease WHERE deadline_ms <= ?1", [now_ms])?;
		let candidates = {
			let mut statement = transaction.prepare(
				"SELECT blob.hash, blob.size
				 FROM verdict_blob AS blob
				 WHERE NOT EXISTS (
				   SELECT 1 FROM verdict_lease AS lease WHERE lease.hash = blob.hash
				 )",
			)?;
			let rows = statement
				.query_map([], |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?)))?;
			rows.collect::<Result<Vec<_>, _>>()?
		};
		let mut removed = 0_usize;
		for (hash, size) in candidates {
			let hash: [u8; 32] = hash
				.as_slice()
				.try_into()
				.map_err(|_| BlobError::InvalidHash)?;
			let digest = Hash32::new(hash);
			if roots.contains(&digest) {
				continue;
			}
			let reference = BlobRef {
				hash: digest,
				size: u64::try_from(size).map_err(|_| BlobError::LengthOverflow)?,
			};
			match fs::remove_file(store.path(&reference)) {
				Ok(()) => {},
				Err(error) if error.kind() == io::ErrorKind::NotFound => {},
				Err(error) => return Err(BlobError::Remove(error)),
			}
			transaction.execute("DELETE FROM verdict_blob WHERE hash = ?1", [hash.as_slice()])?;
			removed += 1;
		}
		for (path, hash) in orphan_files {
			if roots.contains(&hash) {
				continue;
			}
			let tracked = transaction
				.query_row(
					"SELECT 1 FROM verdict_blob WHERE hash = ?1",
					[hash.as_bytes().as_slice()],
					|row| row.get::<_, i64>(0),
				)
				.optional()?
				.is_some();
			if tracked {
				continue;
			}
			match fs::remove_file(path) {
				Ok(()) => removed += 1,
				Err(error) if error.kind() == io::ErrorKind::NotFound => {},
				Err(error) => return Err(BlobError::Remove(error)),
			}
		}
		transaction.commit()?;
		Ok(removed)
	}

	fn delete(&self, store: &BlobStore, hash: [u8; 32], now_ms: i64) -> Result<bool, BlobError> {
		let digest = Hash32::new(hash);
		let mut connection = self.connection.lock();
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		transaction.execute("DELETE FROM verdict_lease WHERE deadline_ms <= ?1", [now_ms])?;
		let leased = transaction
			.query_row(
				"SELECT 1 FROM verdict_lease WHERE hash = ?1 LIMIT 1",
				[hash.as_slice()],
				|row| row.get::<_, i64>(0),
			)
			.optional()?
			.is_some();
		if leased || self.roots()?.contains(&digest) {
			return Err(BlobError::VerdictPinned);
		}
		let probe = BlobRef { hash: digest, size: 0 };
		let deleted = match fs::remove_file(store.path(&probe)) {
			Ok(()) => true,
			Err(error) if error.kind() == io::ErrorKind::NotFound => false,
			Err(error) => return Err(BlobError::Remove(error)),
		};
		transaction.execute("DELETE FROM verdict_blob WHERE hash = ?1", [hash.as_slice()])?;
		transaction.commit()?;
		Ok(deleted)
	}
}

fn delivery_key(session_id: Option<&str>, invocation_id: &str) -> String {
	let session_id = session_id.unwrap_or_default();
	format!("v1:{}:{session_id}{invocation_id}", session_id.len())
}

fn provisional_lease_id(hash: &Hash32) -> String {
	format!("pending:{}", hash.to_hex())
}

fn collect_store_blob_files(store: &BlobStore) -> Result<Vec<(PathBuf, Hash32)>, BlobError> {
	let mut paths = Vec::new();
	collect_blob_paths(&store.root().join("blobs"), &mut paths)?;
	Ok(paths
		.into_iter()
		.filter_map(|path| {
			let name = path.file_name()?.to_str()?;
			BlobRef::parse_hex(name, 0)
				.ok()
				.map(|reference| (path, reference.hash))
		})
		.collect())
}

fn collect_blob_paths(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), BlobError> {
	let entries = match fs::read_dir(root) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(BlobError::Store(error.into())),
	};
	for entry in entries {
		let entry = entry.map_err(|error| BlobError::Store(error.into()))?;
		let kind = entry
			.file_type()
			.map_err(|error| BlobError::Store(error.into()))?;
		let path = entry.path();
		if kind.is_dir() {
			collect_blob_paths(&path, output)?;
		} else if kind.is_file() {
			output.push(path);
		}
	}
	Ok(())
}

fn collect_journal_paths(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), BlobError> {
	let entries = match fs::read_dir(root) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(BlobError::Store(error.into())),
	};
	for entry in entries {
		let entry = entry.map_err(|error| BlobError::Store(error.into()))?;
		let kind = entry
			.file_type()
			.map_err(|error| BlobError::Store(error.into()))?;
		let path = entry.path();
		if kind.is_dir() {
			collect_journal_paths(&path, output)?;
		} else if kind.is_file()
			&& path.extension().and_then(|extension| extension.to_str())
				== Some(omp_journal::FILE_EXTENSION)
		{
			output.push(path);
		}
	}
	Ok(())
}

fn retention_now_ms() -> Result<i64, BlobError> {
	let elapsed = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(|_| BlobError::ArtifactClock)?;
	Ok(i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}

/// Concrete env-side owner of a filesystem-backed content-addressed store.
#[derive(Clone, Debug)]
pub struct BlobHost {
	store:         BlobStore,
	verdict_store: Option<BlobStore>,
	retention:     Option<Arc<VerdictRetention>>,
}

impl BlobHost {
	/// Opens or creates an unmanaged content-addressed store beneath `root`.
	///
	/// Tests and isolated stores use this path. Production project hosts use
	/// [`Self::open_managed`] so worker verdicts receive durable leases.
	pub fn open(root: impl AsRef<Path>) -> Result<Self, BlobError> {
		Ok(Self {
			store:         BlobStore::open(root.as_ref())?,
			verdict_store: None,
			retention:     None,
		})
	}

	/// Opens the project blob authority and derives durable verdict roots from
	/// every session journal beneath `sessions_dir`.
	///
	/// Startup collection is intentionally synchronous and runs before worker
	/// producers are installed. Delivery leases survive daemon restart in the
	/// store-local SQLite catalog; journal roots are re-derived rather than
	/// cached, so removed and rewound sessions release their blobs.
	pub fn open_managed(
		root: impl AsRef<Path>,
		sessions_dir: impl AsRef<Path>,
	) -> Result<Self, BlobError> {
		let store = BlobStore::open(root.as_ref())?;
		let verdict_store = BlobStore::open(store.root().join("verdicts"))?;
		let retention =
			Arc::new(VerdictRetention::open(&store, sessions_dir.as_ref().to_path_buf())?);
		let host = Self { store, verdict_store: Some(verdict_store), retention: Some(retention) };
		host.collect_verdicts()?;
		if let Some(retention) = &host.retention {
			retention.start_collector(host.worker_verdict_store().clone());
		}
		Ok(host)
	}

	/// Takes ownership of an already-open store without verdict collection.
	pub const fn from_store(store: BlobStore) -> Self {
		Self { store, verdict_store: None, retention: None }
	}

	/// Borrows the single blob authority for metadata and retention operations.
	pub(crate) const fn store(&self) -> &BlobStore {
		&self.store
	}

	pub(crate) fn worker_verdict_store(&self) -> &BlobStore {
		self.verdict_store.as_ref().unwrap_or(&self.store)
	}

	/// Opens the single staged minting path shared by every blob producer.
	pub(crate) fn begin_spill(&self) -> Result<BlobStage, BlobError> {
		self.store.begin_put().map_err(BlobError::from)
	}

	/// Opens a stage in the verdict-only CAS namespace.
	pub(crate) fn begin_worker_verdict(&self) -> Result<BlobStage, BlobError> {
		self
			.worker_verdict_store()
			.begin_put()
			.map_err(BlobError::from)
	}

	/// Stores and durably retains an in-memory environment verdict for one
	/// session-scoped delivery.
	pub(crate) fn put_verdict_bytes(
		&self,
		session_id: Option<&str>,
		invocation_id: &str,
		data: &[u8],
	) -> Result<thread_pb::Blob, BlobError> {
		let mut stage = self.begin_worker_verdict()?;
		io::Write::write_all(&mut stage, data).map_err(blob::Error::from)?;
		let id = self.finish_worker_verdict(stage)?;
		self.retain_verdict(session_id, invocation_id, id)?;
		Ok(self.reference(id, sf!("application/json"), thread_pb::blob::Detail::Original))
	}

	/// Copies a tool-result media blob into the verdict-delivery namespace and
	/// retains it for the same session/invocation handshake as the structured
	/// outcome. Repeated references are content-addressed and idempotent.
	pub(crate) fn retain_verdict_blob(
		&self,
		session_id: Option<&str>,
		invocation_id: &str,
		id: BlobId,
	) -> Result<(), BlobError> {
		let reference = BlobRef::from(id);
		let verdicts = self.worker_verdict_store();
		if !verdicts.has(&reference) {
			let bytes = self.store.get(&reference)?;
			let copied = verdicts.put(&bytes)?;
			if copied != reference {
				return Err(BlobError::HashMismatch);
			}
		}
		if !verdicts.verify(&reference)? {
			return Err(BlobError::HashMismatch);
		}
		self.retain_verdict(session_id, invocation_id, id)
	}

	/// Atomically finishes the worker-verdict stage and its provisional lease.
	pub(crate) fn finish_worker_verdict(&self, stage: BlobStage) -> Result<BlobId, BlobError> {
		let reference = match &self.retention {
			Some(retention) => retention.finish_stage(stage, retention_now_ms()?)?,
			None => stage.finish()?,
		};
		Ok(reference.into())
	}

	/// Retains a completed worker verdict until one full download has had time
	/// to become a journaled `source_blob`.
	///
	/// Repeating the same session/invocation pair is idempotent. Equal
	/// invocation ids in different sessions remain independent. A managed host
	/// persists the lease before publishing `env/v1 Verdict`; unmanaged hosts
	/// leave the content under their caller-owned lifetime.
	pub fn retain_verdict(
		&self,
		session_id: Option<&str>,
		invocation_id: &str,
		id: BlobId,
	) -> Result<(), BlobError> {
		let Some(retention) = &self.retention else {
			return Ok(());
		};
		retention.retain(
			self.worker_verdict_store(),
			session_id,
			invocation_id,
			id,
			retention_now_ms()?,
		)
	}

	/// Renews an unfinished exact delivery when a client starts or resumes a
	/// range.
	pub(crate) fn renew_verdict_delivery(
		&self,
		session_id: Option<&str>,
		invocation_id: &str,
		id: BlobId,
	) -> Result<bool, BlobError> {
		let Some(retention) = &self.retention else {
			return Ok(false);
		};
		retention.renew(session_id, invocation_id, id, retention_now_ms()?)
	}

	/// Acknowledges one exact session/invocation delivery after a complete blob
	/// transfer.
	///
	/// The first acknowledgement converts the lease to a short crash window;
	/// repeats and foreign-session acknowledgements are no-ops. The next
	/// collection re-derives journal roots first.
	pub(crate) fn verdict_downloaded(
		&self,
		session_id: Option<&str>,
		invocation_id: &str,
		id: BlobId,
	) -> Result<bool, BlobError> {
		let Some(retention) = &self.retention else {
			return Ok(false);
		};
		retention.downloaded(session_id, invocation_id, id, retention_now_ms()?)
	}

	/// Collects unleased worker-verdict blobs not referenced by any live
	/// `.oms` chain in this project.
	///
	/// Other environment blobs are never enrolled and therefore never removed.
	/// An unreadable journal fails closed without deleting anything.
	pub fn collect_verdicts(&self) -> Result<usize, BlobError> {
		let Some(retention) = &self.retention else {
			return Ok(0);
		};
		retention.collect(self.worker_verdict_store(), retention_now_ms()?)
	}

	/// Stores exact bytes and returns their SHA-256-derived identity.
	pub fn put(&self, data: &[u8]) -> Result<BlobId, BlobError> {
		self
			.store
			.put(data)
			.map(BlobId::from)
			.map_err(BlobError::from)
	}

	/// Stores bytes while validating optional upload-stream preconditions.
	pub fn put_checked(
		&self,
		data: &[u8],
		expected_hash: Option<&[u8]>,
		expected_size: Option<u64>,
	) -> Result<BlobId, BlobError> {
		let expected_hash = expected_hash.map(parse_hash).transpose()?;
		let actual_size = u64::try_from(data.len()).map_err(|_| BlobError::LengthOverflow)?;
		if let Some(expected) = expected_size
			&& expected != actual_size
		{
			return Err(BlobError::SizeMismatch { expected, actual: actual_size });
		}
		if expected_hash.is_some_and(|expected| expected != Hash32::sum(data).into_bytes()) {
			return Err(BlobError::HashMismatch);
		}
		self.put(data)
	}

	/// Stores exact bytes and returns the env wire response.
	pub fn put_response(&self, data: &[u8]) -> Result<blob_pb::PutResponse, BlobError> {
		let id = self.put(data)?;
		Ok(blob_pb::PutResponse { hash: Bytes::copy_from_slice(&id.hash), size: id.size })
	}

	/// Returns presence and size for a raw SHA-256 digest.
	pub fn stat(&self, hash: &[u8]) -> Result<blob_pb::StatResponse, BlobError> {
		let hash = parse_hash(hash)?;
		let tracked = self
			.retention
			.as_ref()
			.map_or(Ok(false), |retention| retention.tracked(hash))?;
		if tracked && let Some(store) = &self.verdict_store {
			let verdict = stat_store(store, hash)?;
			if verdict.present {
				return Ok(verdict);
			}
		}
		let primary = stat_store(&self.store, hash)?;
		if primary.present {
			return Ok(primary);
		}
		match &self.verdict_store {
			Some(store) => stat_store(store, hash),
			None => Ok(primary),
		}
	}

	/// Reads a complete blob by content identity.
	pub fn get(&self, id: BlobId) -> Result<Bytes, BlobError> {
		let reference = BlobRef::from(id);
		let tracked = self
			.retention
			.as_ref()
			.map_or(Ok(false), |retention| retention.tracked(id.hash))?;
		if tracked && let Some(store) = &self.verdict_store {
			match store.get(&reference) {
				Ok(bytes) => return Ok(bytes),
				Err(blob::Error::NotFound) => {},
				Err(error) => return Err(error.into()),
			}
		}
		match self.store.get(&reference) {
			Ok(bytes) => Ok(bytes),
			Err(blob::Error::NotFound) => self
				.verdict_store
				.as_ref()
				.ok_or(BlobError::Store(blob::Error::NotFound))?
				.get(&reference)
				.map_err(BlobError::from),
			Err(error) => Err(error.into()),
		}
	}

	/// Opens the env wire range without materializing the complete blob.
	///
	/// A caller resumes an interrupted transfer by issuing the same digest and
	/// complete-size provenance with `offset` advanced by bytes already
	/// persisted. The selected file remains open through streaming, while each
	/// transport chunk remains bounded independently.
	pub fn get_request(&self, request: &blob_pb::GetRequest) -> Result<BlobRead, BlobError> {
		let hash = parse_hash(&request.hash)?;
		let tracked = self
			.retention
			.as_ref()
			.map_or(Ok(false), |retention| retention.tracked(hash))?;
		if tracked && let Some(store) = &self.verdict_store {
			match open_range(store, hash, request.offset, request.length) {
				Ok(read) => return Ok(read),
				Err(BlobError::Store(blob::Error::NotFound)) => {},
				Err(error) => return Err(error),
			}
		}
		match open_range(&self.store, hash, request.offset, request.length) {
			Ok(read) => Ok(read),
			Err(BlobError::Store(blob::Error::NotFound)) => self
				.verdict_store
				.as_ref()
				.ok_or(BlobError::Store(blob::Error::NotFound))
				.and_then(|store| open_range(store, hash, request.offset, request.length)),
			Err(error) => Err(error),
		}
	}

	/// Removes a raw digest and reports whether content existed.
	///
	/// A managed verdict cannot be removed while a durable delivery lease or
	/// live journal root still pins it.
	pub fn delete(&self, hash: &[u8]) -> Result<blob_pb::DeleteResponse, BlobError> {
		let hash = parse_hash(hash)?;
		let verdict_deleted = match (&self.retention, &self.verdict_store) {
			(Some(retention), Some(store)) => retention.delete(store, hash, retention_now_ms()?)?,
			_ => false,
		};
		let primary_deleted = remove_hash(&self.store, hash)?;
		Ok(blob_pb::DeleteResponse { deleted: verdict_deleted || primary_deleted })
	}
}

fn open_range(
	store: &BlobStore,
	hash: [u8; 32],
	offset: u64,
	length: u64,
) -> Result<BlobRead, BlobError> {
	match store.open_range(Hash32::new(hash), offset, length) {
		Ok(range) => Ok(BlobRead { range }),
		Err(blob::Error::RangeOutOfBounds { offset, size }) => {
			Err(BlobError::InvalidRange { offset, size })
		},
		Err(error) => Err(error.into()),
	}
}

fn stat_store(store: &BlobStore, hash: [u8; 32]) -> Result<blob_pb::StatResponse, BlobError> {
	let probe = BlobRef { hash: Hash32::new(hash), size: 0 };
	match fs::metadata(store.path(&probe)) {
		Ok(metadata) if metadata.is_file() => {
			Ok(blob_pb::StatResponse { present: true, size: metadata.len() })
		},
		Ok(_) => Ok(blob_pb::StatResponse { present: false, size: 0 }),
		Err(error) if error.kind() == io::ErrorKind::NotFound => {
			Ok(blob_pb::StatResponse { present: false, size: 0 })
		},
		Err(error) => Err(BlobError::Store(error.into())),
	}
}

fn remove_hash(store: &BlobStore, hash: [u8; 32]) -> Result<bool, BlobError> {
	let probe = BlobRef { hash: Hash32::new(hash), size: 0 };
	match fs::remove_file(store.path(&probe)) {
		Ok(()) => Ok(true),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
		Err(error) => Err(BlobError::Remove(error)),
	}
}

mod references {
	use bytes::Bytes;
	use omp_core::Str;
	use omp_proto::thread::v1::{self as thread_pb, blob};

	use super::{BlobError, BlobHost, BlobId};

	impl BlobHost {
		/// Creates the canonical hash-only media/result shape used by thread
		/// parts.
		pub fn reference(&self, id: BlobId, mime: Str, detail: blob::Detail) -> thread_pb::Blob {
			thread_pb::Blob {
				hash:   Bytes::copy_from_slice(&id.hash),
				mime:   mime.into(),
				size:   id.size,
				inline: Bytes::new(),
				detail: detail.into(),
			}
		}

		/// Stores media/result bytes and returns their canonical hash-only shape.
		pub fn put_reference(
			&self,
			data: &[u8],
			mime: Str,
			detail: blob::Detail,
		) -> Result<thread_pb::Blob, BlobError> {
			let id = self.put(data)?;
			Ok(self.reference(id, mime, detail))
		}
	}
}

impl omp_tool::CallOutcomeSpill for BlobHost {
	type Error = BlobError;
	type Stage<'a> = BlobStage;

	fn open(&self) -> Result<Self::Stage<'_>, Self::Error> {
		self.begin_spill()
	}

	async fn finish<'a>(&'a self, stage: Self::Stage<'a>) -> Result<omp_tool::BlobRef, Self::Error> {
		let reference = task::spawn_blocking(move || stage.finish()).await??;
		Ok(call_outcome_reference(reference))
	}
}

fn call_outcome_reference(reference: BlobRef) -> omp_tool::BlobRef {
	let hash = reference.hash.to_hex();
	omp_tool::BlobRef {
		hash:       Str::from(hash.as_str()),
		media_type: sf!("application/json"),
		byte_len:   reference.size,
	}
}

fn parse_hash(hash: &[u8]) -> Result<[u8; 32], BlobError> {
	hash.try_into().map_err(|_| BlobError::InvalidHash)
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		io::Write as _,
		path::{Path, PathBuf},
	};

	use omp_core::{Hash32, Str};
	use omp_journal::{EntryDraft, Journal, Kind, KindName, data::ToolResult};
	use omp_tool::{CallOutcome, CallOutcomeDetails, CallOutcomeDetailsError, call_outcome_details};
	use serde_json::value::RawValue;
	use tempfile::TempDir;

	use super::{
		BlobError, BlobHost, BlobId, VERDICT_DOWNLOAD_GRACE_MS, VERDICT_PENDING_LEASE_MS,
		delivery_key, retention_now_ms,
	};

	fn open_host() -> (TempDir, BlobHost) {
		let root = tempfile::tempdir().expect("temporary blob root");
		let host = BlobHost::open(root.path()).expect("open blob host");
		(root, host)
	}

	fn tmp_dir(root: &Path) -> PathBuf {
		root.join("tmp")
	}

	fn poison_tmp_dir(root: &Path) {
		let tmp = tmp_dir(root);
		fs::remove_dir(&tmp).expect("remove empty temporary directory");
		fs::File::create(tmp).expect("replace temporary directory with a file");
	}

	fn managed_host(root: &Path) -> BlobHost {
		BlobHost::open_managed(root.join("blobs"), root.join("sessions"))
			.expect("open managed blob host")
	}

	#[test]
	fn worker_media_is_copied_into_the_verdict_delivery_store_idempotently() {
		let root = tempfile::tempdir().expect("project root");
		let host = managed_host(root.path());
		let media = host.put(b"tool image bytes").expect("store worker media");
		let second = host
			.put(b"tool audio bytes")
			.expect("store second worker media");
		host
			.retain_verdict_blob(Some("session-a"), "call-a", media)
			.expect("retain media");
		host
			.retain_verdict_blob(Some("session-a"), "call-a", second)
			.expect("retain second media");
		host
			.retain_verdict_blob(Some("session-a"), "call-a", media)
			.expect("repeat retention");
		for id in [media, second] {
			let reference = id.into();
			assert!(
				host
					.worker_verdict_store()
					.verify(&reference)
					.expect("verify retained media"),
				"scoped verdict downloads read the exact media bytes"
			);
			assert!(
				host
					.renew_verdict_delivery(Some("session-a"), "call-a", id)
					.expect("renew retained media"),
				"every blob from one invocation has an independent lease"
			);
		}
	}

	fn put_verdict(host: &BlobHost, data: &[u8]) -> BlobId {
		let mut stage = host.begin_worker_verdict().expect("begin verdict");
		stage.write_all(data).expect("write verdict");
		host.finish_worker_verdict(stage).expect("finish verdict")
	}

	fn append_blob_root(path: &Path, id: BlobId, faulted: bool) -> (Journal, omp_journal::EntryId) {
		fs::create_dir_all(path.parent().expect("journal parent")).expect("create sessions");
		let mut journal = Journal::create(path).expect("create session journal");
		let genesis = journal
			.append(EntryDraft {
				kind:  Kind::known(KindName::Journal),
				by:    None,
				prior: None,
				label: None,
				data:  Str::new_static(r#"{"version":1,"cwd":"/tmp","created":"now"}"#),
			})
			.expect("append genesis");
		let terminal = RawValue::from_string("null".to_owned()).expect("raw terminal value");
		let result = if faulted {
			ToolResult::Fault {
				fault:        terminal,
				prompt_parts: None,
				source_blob:  Some(id.into()),
			}
		} else {
			ToolResult::Outcome {
				outcome:      terminal,
				prompt_parts: None,
				source_blob:  Some(id.into()),
			}
		};
		journal
			.append(EntryDraft {
				kind:  Kind::known(KindName::ToolResult),
				by:    Some(genesis.id),
				prior: None,
				label: None,
				data:  Str::new(serde_json::to_string(&result).expect("encode result")),
			})
			.expect("append result");
		(journal, genesis.id)
	}

	fn abandon_result(journal: &mut Journal, genesis: omp_journal::EntryId) {
		journal
			.append(EntryDraft {
				kind:  Kind::known(KindName::Patch),
				by:    Some(genesis),
				prior: Some(genesis),
				label: None,
				data:  Str::new_static(r#"{"ops":[]}"#),
			})
			.expect("append branch");
	}

	#[tokio::test]
	async fn inline_outcome_never_opens_a_blob_stage() {
		let (root, host) = open_host();
		poison_tmp_dir(root.path());
		let outcome = CallOutcome::<u8, u8>::Ok(7);

		let details = call_outcome_details(&outcome, 1_024, &host)
			.await
			.expect("inline serialization must not touch poisoned blob staging");

		assert!(matches!(details, CallOutcomeDetails::Inline { .. }));
	}

	#[tokio::test]
	async fn spilled_outcome_retains_exact_bytes_digest_and_size() {
		let (_root, host) = open_host();
		let outcome = CallOutcome::<Str, Str>::Ok(omp_core::sf!("payload beyond the inline limit",));
		let expected = serde_json::to_vec(&outcome).expect("serialize expected outcome");
		let expected_hash = Hash32::sum(&expected);

		let details = call_outcome_details(&outcome, 1, &host)
			.await
			.expect("spill outcome");
		let CallOutcomeDetails::Spilled { blob, byte_len } = details else {
			panic!("outcome larger than one byte must spill");
		};

		assert_eq!(byte_len, expected.len() as u64);
		assert_eq!(blob.byte_len, expected.len() as u64);
		assert_eq!(blob.media_type.as_str(), "application/json");
		assert_eq!(blob.hash.as_str(), expected_hash.to_hex().as_str());
		assert_eq!(
			host
				.get(BlobId { hash: expected_hash.into(), size: expected.len() as u64 })
				.expect("read spilled outcome")
				.as_ref(),
			expected.as_slice()
		);
	}

	#[test]
	fn dropping_an_unfinished_spill_removes_its_temporary_file() {
		let (root, host) = open_host();
		let mut stage = host.begin_spill().expect("begin staged spill");
		stage
			.write_all(b"cancelled bytes")
			.expect("write staged bytes");
		assert_eq!(
			fs::read_dir(tmp_dir(root.path()))
				.expect("read tmp")
				.count(),
			1
		);

		drop(stage);

		assert_eq!(
			fs::read_dir(tmp_dir(root.path()))
				.expect("read tmp")
				.count(),
			0
		);
	}

	#[tokio::test]
	async fn storage_open_errors_remain_typed() {
		let (root, host) = open_host();
		poison_tmp_dir(root.path());
		let outcome = CallOutcome::<u8, u8>::Ok(7);

		let error = call_outcome_details(&outcome, 0, &host)
			.await
			.expect_err("poisoned staging directory must fail");

		assert!(matches!(error, CallOutcomeDetailsError::SpillOpen(BlobError::Store(_))));
	}

	#[test]
	fn verdict_delivery_lease_survives_daemon_restart_then_releases() {
		let root = tempfile::tempdir().expect("project root");
		let host = managed_host(root.path());
		let id = put_verdict(&host, b"durable verdict");
		host
			.retain_verdict(Some("session-a"), "call-a", id)
			.expect("retain verdict");
		drop(host);

		let host = managed_host(root.path());
		assert!(host.worker_verdict_store().has(&id.into()), "pending delivery survives reopen");
		let retention = host.retention.as_ref().expect("managed retention");
		assert!(
			retention
				.downloaded(Some("session-a"), "call-a", id, 10)
				.expect("mark full download")
		);
		assert_eq!(
			retention
				.collect(host.worker_verdict_store(), 10 + super::VERDICT_DOWNLOAD_GRACE_MS)
				.expect("collect after grace"),
			1
		);
		assert!(!host.worker_verdict_store().has(&id.into()));
	}

	#[test]
	fn delivery_ack_is_session_scoped_persistent_and_exactly_once() {
		let root = tempfile::tempdir().expect("project root");
		let host = managed_host(root.path());
		let id = put_verdict(&host, b"shared detached verdict");
		let now = retention_now_ms().expect("host clock");
		let retention = host.retention.as_ref().expect("managed retention");
		retention
			.retain(host.worker_verdict_store(), Some("session-a"), "same-call", id, now)
			.expect("retain first session");
		retention
			.retain(host.worker_verdict_store(), Some("session-b"), "same-call", id, now)
			.expect("retain second session");
		let resumed_at = now.saturating_add(VERDICT_PENDING_LEASE_MS - 1);
		assert!(
			retention
				.renew(Some("session-a"), "same-call", id, resumed_at)
				.expect("renew first transfer")
		);
		assert!(
			retention
				.renew(Some("session-b"), "same-call", id, resumed_at)
				.expect("renew second transfer")
		);
		drop(host);

		let host = managed_host(root.path());
		let retention = host.retention.as_ref().expect("reopened retention");
		assert_eq!(
			retention
				.collect(host.worker_verdict_store(), now.saturating_add(VERDICT_PENDING_LEASE_MS),)
				.expect("collect after original deadline"),
			0,
			"resumed ranges renew their persisted leases"
		);
		assert!(
			!retention
				.downloaded(Some("session-c"), "same-call", id, now)
				.expect("reject foreign session")
		);
		assert!(
			retention
				.downloaded(Some("session-a"), "same-call", id, now)
				.expect("ack first session")
		);
		assert!(
			!retention
				.downloaded(Some("session-a"), "same-call", id, now)
				.expect("repeat first ack")
		);
		let first_downloaded = retention
			.connection
			.lock()
			.query_row(
				"SELECT downloaded FROM verdict_lease WHERE delivery_key = ?1",
				[delivery_key(Some("session-a"), "same-call")],
				|row| row.get::<_, bool>(0),
			)
			.expect("first delivery row");
		let second_downloaded = retention
			.connection
			.lock()
			.query_row(
				"SELECT downloaded FROM verdict_lease WHERE delivery_key = ?1",
				[delivery_key(Some("session-b"), "same-call")],
				|row| row.get::<_, bool>(0),
			)
			.expect("second delivery row");
		assert!(first_downloaded);
		assert!(!second_downloaded, "one session's ack released another session's lease");
		assert_eq!(
			retention
				.collect(host.worker_verdict_store(), now.saturating_add(VERDICT_DOWNLOAD_GRACE_MS),)
				.expect("collect with second delivery pending"),
			0
		);
		assert!(
			retention
				.downloaded(Some("session-b"), "same-call", id, now)
				.expect("ack second session")
		);
		assert_eq!(
			retention
				.collect(host.worker_verdict_store(), now.saturating_add(VERDICT_DOWNLOAD_GRACE_MS),)
				.expect("collect after every delivery"),
			1
		);
		assert!(!host.worker_verdict_store().has(&id.into()));
	}

	#[test]
	fn live_journal_roots_pin_across_sessions_and_release_after_rewind() {
		let root = tempfile::tempdir().expect("project root");
		let host = managed_host(root.path());
		let id = put_verdict(&host, b"shared verdict");
		host
			.retain_verdict(Some("first"), "call-a", id)
			.expect("retain first delivery");
		host
			.retain_verdict(Some("second"), "call-b", id)
			.expect("retain second delivery");
		let (mut first, first_genesis) =
			append_blob_root(&root.path().join("sessions/first.oms"), id, false);
		let (mut second, second_genesis) =
			append_blob_root(&root.path().join("sessions/nested/second.oms"), id, true);
		let retention = host.retention.as_ref().expect("managed retention");
		assert!(
			retention
				.downloaded(Some("first"), "call-a", id, 10)
				.expect("complete first download")
		);
		assert!(
			retention
				.downloaded(Some("second"), "call-b", id, 10)
				.expect("complete second download")
		);
		drop(host);

		let host = managed_host(root.path());
		assert!(host.worker_verdict_store().has(&id.into()), "journal roots survive daemon restart");
		abandon_result(&mut first, first_genesis);
		let retention = host.retention.as_ref().expect("managed retention");
		assert_eq!(
			retention
				.collect(host.worker_verdict_store(), i64::MAX)
				.expect("collect with second session live"),
			0
		);
		assert!(
			host.worker_verdict_store().has(&id.into()),
			"one live session still pins shared content"
		);

		abandon_result(&mut second, second_genesis);
		assert_eq!(
			retention
				.collect(host.worker_verdict_store(), i64::MAX)
				.expect("collect after every root rewinds"),
			1
		);
		assert!(!host.worker_verdict_store().has(&id.into()));
	}

	#[test]
	fn explicit_delete_refuses_leased_and_journal_rooted_verdicts() {
		let root = tempfile::tempdir().expect("project root");
		let host = managed_host(root.path());
		let id = put_verdict(&host, b"pinned verdict");
		host
			.retain_verdict(Some("pinned"), "call-a", id)
			.expect("retain delivery");
		assert!(matches!(host.delete(&id.hash), Err(BlobError::VerdictPinned)));
		let (_journal, _genesis) =
			append_blob_root(&root.path().join("sessions/pinned.oms"), id, false);
		let retention = host.retention.as_ref().expect("managed retention");
		assert!(
			retention
				.downloaded(Some("pinned"), "call-a", id, 10)
				.expect("complete download")
		);
		assert!(matches!(
			retention.delete(host.worker_verdict_store(), id.hash, i64::MAX),
			Err(BlobError::VerdictPinned)
		));
	}

	#[test]
	fn daemon_restart_collects_a_finalized_but_unregistered_verdict() {
		let root = tempfile::tempdir().expect("project root");
		let host = managed_host(root.path());
		let orphan = host
			.worker_verdict_store()
			.put(b"crash orphan")
			.expect("finalize orphan");
		drop(host);

		let host = managed_host(root.path());
		assert!(
			!host.worker_verdict_store().has(&orphan),
			"startup collection removes the unregistered crash window"
		);
	}

	#[test]
	fn verdict_collection_never_deletes_equal_generic_cas_content() {
		let root = tempfile::tempdir().expect("project root");
		let host = managed_host(root.path());
		let generic = host.put(b"shared bytes").expect("store generic blob");
		let verdict = put_verdict(&host, b"shared bytes");
		assert_eq!(generic, verdict);
		host
			.retain_verdict(Some("generic"), "call-a", verdict)
			.expect("retain verdict");
		let retention = host.retention.as_ref().expect("managed retention");
		assert!(
			retention
				.downloaded(Some("generic"), "call-a", verdict, 10)
				.expect("complete download")
		);
		assert_eq!(
			retention
				.collect(host.worker_verdict_store(), 10 + super::VERDICT_DOWNLOAD_GRACE_MS)
				.expect("collect verdict namespace"),
			1
		);
		assert!(
			host.store.has(&generic.into()),
			"generic CAS identity remains independently retained"
		);
		assert!(!host.worker_verdict_store().has(&verdict.into()));
	}

	#[test]
	fn project_collectors_do_not_share_or_leak_roots() {
		let parent = tempfile::tempdir().expect("projects root");
		let first_root = parent.path().join("first");
		let second_root = parent.path().join("second");
		let first = managed_host(&first_root);
		let second = managed_host(&second_root);
		let first_id = put_verdict(&first, b"same verdict");
		let second_id = put_verdict(&second, b"same verdict");
		assert_eq!(first_id, second_id);
		first
			.retain_verdict(Some("live"), "first-call", first_id)
			.expect("retain first");
		second
			.retain_verdict(Some("live"), "second-call", second_id)
			.expect("retain second");
		let (_journal, _genesis) =
			append_blob_root(&first_root.join("sessions/live.oms"), first_id, false);
		assert!(
			first
				.retention
				.as_ref()
				.expect("first retention")
				.downloaded(Some("live"), "first-call", first_id, 10)
				.expect("release first")
		);
		assert!(
			second
				.retention
				.as_ref()
				.expect("second retention")
				.downloaded(Some("live"), "second-call", second_id, 10)
				.expect("release second")
		);
		drop((first, second));

		let first = managed_host(&first_root);
		let second = managed_host(&second_root);
		assert!(
			first.worker_verdict_store().has(&first_id.into()),
			"first project journal pins only first CAS"
		);
		assert!(
			!second.worker_verdict_store().has(&second_id.into()),
			"unrooted second project CAS is collected"
		);
	}

	#[test]
	fn blob_host_is_clone_send_and_sync() {
		fn assert_traits<T: Clone + Send + Sync>() {}
		assert_traits::<BlobHost>();
	}
}
