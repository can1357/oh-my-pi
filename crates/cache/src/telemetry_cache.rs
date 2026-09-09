//! Per-session telemetry side index and durable `AutoQA` issue store.
//!
//! Telemetry payloads remain in `telemetry.bin`; SQLite stores only indexed
//! columns and byte offsets. This deliberately branches from transcript entry
//! indexes rather than copying settled outcomes into a second journal.

use std::{
	fs,
	fs::{File, OpenOptions},
	io::{self, Read as _, Seek as _, SeekFrom, Write as _},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
};

use omp_core::Str;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};

/// A byte offset into a session's append-only `telemetry.bin` side file.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct TelemetryWatermark(pub u64);

/// The indexed scalar facts of one telemetry record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexedEvent {
	/// Session containing the event.
	pub session_id:     Str,
	/// Offset of the framed payload in that session's `telemetry.bin`.
	pub offset:         TelemetryWatermark,
	/// Firehose kind string.
	pub kind:           Str,
	/// Event timestamp in Unix milliseconds.
	pub occurred_at_ms: u64,
	/// True when this row was reconstructed from transcript replay.
	pub backfilled:     bool,
}

/// Result of an indexed telemetry query.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TelemetryQueryResult {
	/// Rows selected by the core-side query.
	pub rows:       Vec<IndexedEvent>,
	/// Whether the caller's install-time access floor removed older rows.
	pub floored:    bool,
	/// Whether transcript replay supplied any returned rows.
	pub backfilled: bool,
}

/// Durable `AutoQA` issue metadata kept beside telemetry index rows.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredIssue {
	/// Stable issue identifier.
	pub id:                 Str,
	/// Session that filed the issue.
	pub session_id:         Str,
	/// Device that produced the reported result.
	pub device:             Str,
	/// Committed device revision, if the target has one.
	pub rev:                Option<Str>,
	/// User consent disposition.
	pub consent:            Str,
	/// Creation timestamp in Unix milliseconds.
	pub created_at_ms:      u64,
	/// Payload frame offset in the private telemetry side file.
	pub payload_offset:     u64,
	/// Exact payload byte length.
	pub payload_len:        u32,
	/// UI-bound target revision accepted for upload.
	pub consent_revision:   Option<Str>,
	/// Completed upload attempts.
	pub attempt_count:      u32,
	/// Earliest next upload attempt.
	pub next_attempt_at_ms: u64,
	/// Whether delivery reached a terminal state.
	pub terminal:           bool,
	/// Remote idempotent acknowledgement.
	pub remote_ack:         Option<Str>,
}
/// One consented issue and its redacted private payload ready for delivery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingIssue {
	/// Durable upload row.
	pub issue:   StoredIssue,
	/// Exact payload bytes referenced by the row.
	pub payload: Vec<u8>,
}
/// User-authored disposition for a revision-bound telemetry report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
	/// Keep the report private and terminally local-only.
	LocalOnly,
	/// Consent to upload this exact target revision.
	Upload,
}

/// Revision-bound consent emitted by user interaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConsentIntent {
	/// Durable local issue id.
	pub issue_id: Str,
	/// Exact report revision shown when consent was requested.
	pub revision: Str,
	/// User-authored disposition.
	pub decision: Decision,
}
/// Filter for a cross-session `AutoQA` issue inventory.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct IssueInventoryFilter {
	/// Restrict findings to one device/tool name.
	pub device: Option<Str>,
	/// Maximum number of newest findings to return.
	pub limit:  usize,
}

/// One durable issue and its locally stored, already-redacted finding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IssueFinding {
	/// Durable issue metadata.
	pub issue:   StoredIssue,
	/// Exact private payload referenced by the metadata row.
	pub payload: Vec<u8>,
}

/// Raw mutually-exclusive selectors accepted by issue deletion.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct IssueDeleteSelector {
	/// Delete one exact stable issue identifier.
	pub id:     Option<Str>,
	/// Delete every issue for one device/tool name.
	pub device: Option<Str>,
	/// Delete every issue in the project inventory.
	pub all:    bool,
}

impl IssueDeleteSelector {
	/// Enforces exact-one selector semantics before any database is opened or
	/// mutated.
	///
	/// # Errors
	/// Returns a typed selector error unless exactly one selector is present.
	pub fn validate(&self) -> Result<(), QueryError> {
		let selected = usize::from(self.id.is_some())
			+ usize::from(self.device.is_some())
			+ usize::from(self.all);
		if selected == 0 {
			return Err(QueryError::MissingIssueSelector);
		}
		if selected > 1 {
			return Err(QueryError::ConflictingIssueSelectors);
		}
		Ok(())
	}
}

/// A cancellation guard for a core-side query.
#[derive(Clone, Debug, Default)]
#[must_use]
pub struct QueryGuard(Arc<AtomicBool>);

impl QueryGuard {
	/// Creates an uncancelled query guard.
	pub fn new() -> Self {
		Self::default()
	}

	/// Returns whether query work should stop.
	pub fn cancelled(&self) -> bool {
		self.0.load(Ordering::Relaxed)
	}
}

impl Drop for QueryGuard {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Relaxed);
	}
}
/// Operators accepted by the restricted telemetry `where` language.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WhereOp {
	/// Exact equality.
	Eq,
	/// Exact inequality.
	Ne,
	/// Greater-than comparison.
	Gt,
	/// Greater-than-or-equal comparison.
	Ge,
	/// Less-than comparison.
	Lt,
	/// Less-than-or-equal comparison.
	Le,
}

impl WhereOp {
	const fn sql(self) -> &'static str {
		match self {
			Self::Eq => "=",
			Self::Ne => "!=",
			Self::Gt => ">",
			Self::Ge => ">=",
			Self::Lt => "<",
			Self::Le => "<=",
		}
	}
}

/// A scalar predicate that compiles to SQLite and has a matching Rust
/// evaluator.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Where {
	/// Indexed field name: `kind`, `occurred_at_ms`, or `offset`.
	pub field: Str,
	/// Comparison operator.
	pub op:    WhereOp,
	/// String representation of the scalar value.
	pub value: Str,
}

/// Error produced when a telemetry query is not safely indexable.
#[derive(Debug, thiserror::Error)]
pub enum QueryError {
	/// The requested field has no index column or Rust evaluator.
	#[error("unknown telemetry query field {0}")]
	UnknownField(Str),
	/// A numeric predicate had an invalid value.
	#[error("invalid numeric telemetry query value {0}")]
	InvalidNumber(Str),
	/// A side-file operation failed.
	#[error("telemetry side-file error: {0}")]
	Io(#[from] io::Error),
	/// SQLite reported an error.
	#[error("telemetry index error: {0}")]
	Sql(#[from] rusqlite::Error),
	/// The query was cancelled by dropping its guard.
	#[error("telemetry query cancelled")]
	Cancelled,
	/// Issue deletion requires one selector.
	#[error("specify exactly one issue selector: id, device, or all")]
	MissingIssueSelector,
	/// Issue deletion selectors are mutually exclusive.
	#[error("issue selectors id, device, and all are mutually exclusive")]
	ConflictingIssueSelectors,
}

impl Where {
	/// Produces the SQL expression for this predicate after whitelisting its
	/// column.
	///
	/// # Errors
	/// Returns [`QueryError`] when the field is not indexed or a numeric literal
	/// cannot be represented exactly.
	pub fn to_sql(&self) -> Result<String, QueryError> {
		match self.field.as_str() {
			"kind" => Ok(format!("kind {} ?", self.op.sql())),
			"occurred_at_ms" | "offset" => {
				self
					.value
					.as_str()
					.parse::<u64>()
					.map_err(|_| QueryError::InvalidNumber(self.value.clone()))?;
				Ok(format!("{} {} ?", self.field, self.op.sql()))
			},
			_ => Err(QueryError::UnknownField(self.field.clone())),
		}
	}

	/// Evaluates this exact indexed predicate without SQLite for transcript
	/// backfill.
	///
	/// # Errors
	/// Returns the same field/value errors as [`Self::to_sql`].
	pub fn matches(&self, event: &IndexedEvent) -> Result<bool, QueryError> {
		match self.field.as_str() {
			"kind" => Ok(compare_str(event.kind.as_str(), self.value.as_str(), self.op)),
			"occurred_at_ms" => compare_u64(event.occurred_at_ms, &self.value, self.op),
			"offset" => compare_u64(event.offset.0, &self.value, self.op),
			_ => Err(QueryError::UnknownField(self.field.clone())),
		}
	}
}

fn compare_str(left: &str, right: &str, op: WhereOp) -> bool {
	match op {
		WhereOp::Eq => left == right,
		WhereOp::Ne => left != right,
		WhereOp::Gt => left > right,
		WhereOp::Ge => left >= right,
		WhereOp::Lt => left < right,
		WhereOp::Le => left <= right,
	}
}

fn compare_u64(left: u64, right: &Str, op: WhereOp) -> Result<bool, QueryError> {
	let right = right
		.as_str()
		.parse::<u64>()
		.map_err(|_| QueryError::InvalidNumber(right.clone()))?;
	Ok(match op {
		WhereOp::Eq => left == right,
		WhereOp::Ne => left != right,
		WhereOp::Gt => left > right,
		WhereOp::Ge => left >= right,
		WhereOp::Lt => left < right,
		WhereOp::Le => left <= right,
	})
}

/// Incremental side-file indexer backed by the project telemetry database.
pub struct TelemetryIndex {
	database:    Mutex<Connection>,
	side_file:   Mutex<File>,
	side_path:   PathBuf,
	next_offset: AtomicU64,
}

impl TelemetryIndex {
	/// Opens the session's side file and the project telemetry index database.
	///
	/// # Errors
	/// Returns file-system or SQLite errors when the durable index cannot be
	/// opened or initialized.
	#[tracing::instrument(
		name = "telemetry_index_open",
		level = "debug",
		skip_all,
		fields(
			session_dir = %session_dir.display(),
			database = %database_path.display()
		)
	)]
	pub fn open(session_dir: &Path, database_path: &Path) -> Result<Self, QueryError> {
		fs::create_dir_all(session_dir)?;
		let side_path = session_dir.join("telemetry.bin");
		let side_file = OpenOptions::new()
			.create(true)
			.append(true)
			.read(true)
			.open(&side_path)?;
		let next_offset = side_file.metadata()?.len();
		let database = Connection::open(database_path)?;
		database.execute_batch(
			"CREATE TABLE IF NOT EXISTS telemetry_events (
				session_id TEXT NOT NULL,
				offset INTEGER NOT NULL,
				kind TEXT NOT NULL,
				occurred_at_ms INTEGER NOT NULL,
				backfilled INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY(session_id, offset)
			);
			CREATE INDEX IF NOT EXISTS telemetry_events_query
				ON telemetry_events(session_id, kind, occurred_at_ms, offset);
			CREATE TABLE IF NOT EXISTS telemetry_issues (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				device TEXT NOT NULL,
				rev TEXT,
				consent TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				payload_offset INTEGER NOT NULL DEFAULT 0,
				payload_len INTEGER NOT NULL DEFAULT 0,
				consent_revision TEXT,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
				terminal INTEGER NOT NULL DEFAULT 0,
				remote_ack TEXT
			);",
		)?;
		let mut migrated_columns = 0_usize;
		for (name, declaration) in [
			("payload_offset", "INTEGER NOT NULL DEFAULT 0"),
			("payload_len", "INTEGER NOT NULL DEFAULT 0"),
			("consent_revision", "TEXT"),
			("attempt_count", "INTEGER NOT NULL DEFAULT 0"),
			("next_attempt_at_ms", "INTEGER NOT NULL DEFAULT 0"),
			("terminal", "INTEGER NOT NULL DEFAULT 0"),
			("remote_ack", "TEXT"),
		] {
			let statement = format!("ALTER TABLE telemetry_issues ADD COLUMN {name} {declaration}");
			match database.execute(&statement, []) {
				Ok(_) => migrated_columns = migrated_columns.saturating_add(1),
				Err(error) if error.to_string().contains("duplicate column name") => {},
				Err(error) => return Err(QueryError::Sql(error)),
			}
		}
		if migrated_columns != 0 {
			tracing::info!(
				database = "telemetry_index",
				column_count = migrated_columns,
				"storage migration completed"
			);
		}
		Ok(Self {
			database: Mutex::new(database),
			side_file: Mutex::new(side_file),
			side_path,
			next_offset: AtomicU64::new(next_offset),
		})
	}

	/// Returns the current byte-offset watermark of `telemetry.bin`.
	pub fn watermark(&self) -> TelemetryWatermark {
		TelemetryWatermark(self.next_offset.load(Ordering::Acquire))
	}

	/// Returns the session side-file path.
	pub fn side_path(&self) -> &Path {
		&self.side_path
	}

	/// Appends one encoded event and incrementally indexes its scalar facts.
	///
	/// # Errors
	/// Returns an I/O or SQLite error when either durable write fails.
	pub fn append(
		&self,
		session_id: &str,
		kind: &str,
		occurred_at_ms: u64,
		encoded: &[u8],
	) -> Result<TelemetryWatermark, QueryError> {
		let length = u32::try_from(encoded.len()).map_err(|_| {
			QueryError::Io(io::Error::new(
				io::ErrorKind::InvalidInput,
				"telemetry event exceeds u32 frame",
			))
		})?;
		let offset;
		{
			let mut file = self.side_file.lock();
			offset = self.next_offset.load(Ordering::Acquire);
			file.write_all(&length.to_le_bytes())?;
			file.write_all(encoded)?;
			file.flush()?;
			self
				.next_offset
				.store(offset.saturating_add(u64::from(length) + 4), Ordering::Release);
		}
		self.database.lock().execute(
			"INSERT INTO telemetry_events(session_id, offset, kind, occurred_at_ms, backfilled)
			 VALUES(?1, ?2, ?3, ?4, 0)",
			params![session_id, offset, kind, occurred_at_ms],
		)?;
		Ok(TelemetryWatermark(offset))
	}

	/// Inserts a transcript-replayed telemetry row without duplicating its
	/// payload.
	///
	/// # Errors
	/// Returns a SQLite error when the index row cannot be written.
	pub fn backfill(&self, event: &IndexedEvent) -> Result<(), QueryError> {
		self.database.lock().execute(
			"INSERT OR IGNORE INTO telemetry_events(session_id, offset, kind, occurred_at_ms, \
			 backfilled)
			 VALUES(?1, ?2, ?3, ?4, 1)",
			params![
				event.session_id.as_str(),
				event.offset.0,
				event.kind.as_str(),
				event.occurred_at_ms
			],
		)?;
		Ok(())
	}

	/// Executes a core-side index query; only returned rows should cross
	/// CONTROL.
	///
	/// # Errors
	/// Returns invalid-predicate, SQLite, or cancellation errors.
	#[tracing::instrument(
		name = "telemetry_index_query",
		level = "debug",
		skip_all,
		fields(
			session_id = %session_id,
			has_predicate = predicate.is_some(),
			install_floor = ?install_floor.map(|floor| floor.0)
		)
	)]
	pub fn query(
		&self,
		session_id: &str,
		predicate: Option<&Where>,
		install_floor: Option<TelemetryWatermark>,
		guard: &QueryGuard,
	) -> Result<TelemetryQueryResult, QueryError> {
		if guard.cancelled() {
			return Err(QueryError::Cancelled);
		}
		let (sql, value) = match predicate {
			Some(predicate) => {
				(format!(" AND {}", predicate.to_sql()?), Some(predicate.value.as_str()))
			},
			None => (String::new(), None),
		};
		let floor = install_floor.map_or(0, |floor| floor.0);
		let statement = format!(
			"SELECT session_id, offset, kind, occurred_at_ms, backfilled FROM telemetry_events
			 WHERE session_id = ?1 AND offset >= ?2{sql} ORDER BY offset ASC"
		);
		let database = self.database.lock();
		let mut query = database.prepare(&statement)?;
		let mut rows = if let Some(value) = value {
			query.query(params![session_id, floor, value])?
		} else {
			query.query(params![session_id, floor])?
		};
		let mut result = TelemetryQueryResult::default();
		while let Some(row) = rows.next()? {
			if guard.cancelled() {
				return Err(QueryError::Cancelled);
			}
			let backfilled = row.get::<_, i64>(4)? != 0;
			result.backfilled |= backfilled;
			result.rows.push(IndexedEvent {
				session_id: Str::from(row.get::<_, String>(0)?),
				offset: TelemetryWatermark(row.get(1)?),
				kind: Str::from(row.get::<_, String>(2)?),
				occurred_at_ms: row.get(3)?,
				backfilled,
			});
		}
		result.floored = install_floor.is_some();
		tracing::debug!(
			row_count = result.rows.len(),
			floored = result.floored,
			backfilled = result.backfilled,
			"telemetry index query completed"
		);
		Ok(result)
	}

	/// Stores an `AutoQA` issue in the audit-tier issue table exactly once.
	pub fn store_issue(&self, issue: &StoredIssue) -> Result<(), QueryError> {
		self.database.lock().execute(
			"INSERT OR IGNORE INTO telemetry_issues(id, session_id, device, rev, consent, \
			 created_at_ms, payload_offset, payload_len, consent_revision, attempt_count, \
			 next_attempt_at_ms, terminal, remote_ack)
			 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
			params![
				issue.id.as_str(),
				issue.session_id.as_str(),
				issue.device.as_str(),
				issue.rev.as_ref().map(Str::as_str),
				issue.consent.as_str(),
				issue.created_at_ms,
				issue.payload_offset,
				issue.payload_len,
				issue.consent_revision.as_ref().map(Str::as_str),
				issue.attempt_count,
				issue.next_attempt_at_ms,
				issue.terminal,
				issue.remote_ack.as_ref().map(Str::as_str),
			],
		)?;
		Ok(())
	}

	/// Reads a durable `AutoQA` issue by identifier.
	pub fn issue(&self, id: &str) -> Result<Option<StoredIssue>, QueryError> {
		self
			.database
			.lock()
			.query_row(
				"SELECT id, session_id, device, rev, consent, created_at_ms, payload_offset, \
				 payload_len, consent_revision, attempt_count, next_attempt_at_ms, terminal, \
				 remote_ack FROM telemetry_issues WHERE id = ?1",
				params![id],
				stored_issue_row,
			)
			.optional()
			.map_err(QueryError::from)
	}

	/// Lists the newest issues across every session in this project index.
	///
	/// Payloads are read through the telemetry owner rather than by callers
	/// opening the private side file directly.
	///
	/// # Errors
	/// Returns a SQLite or side-file error if inventory materialization fails.
	pub fn issue_inventory(
		&self,
		filter: &IssueInventoryFilter,
	) -> Result<Vec<IssueFinding>, QueryError> {
		let limit = i64::try_from(filter.limit).unwrap_or(i64::MAX);
		let issues = {
			let database = self.database.lock();
			let mut statement = if filter.device.is_some() {
				database.prepare(
					"SELECT id, session_id, device, rev, consent, created_at_ms, payload_offset, \
					 payload_len, consent_revision, attempt_count, next_attempt_at_ms, terminal, \
					 remote_ack FROM telemetry_issues WHERE device = ?1 ORDER BY created_at_ms DESC, \
					 id DESC LIMIT ?2",
				)?
			} else {
				database.prepare(
					"SELECT id, session_id, device, rev, consent, created_at_ms, payload_offset, \
					 payload_len, consent_revision, attempt_count, next_attempt_at_ms, terminal, \
					 remote_ack FROM telemetry_issues ORDER BY created_at_ms DESC, id DESC LIMIT ?2",
				)?
			};
			let rows = if let Some(device) = filter.device.as_deref() {
				statement.query_map(params![device, limit], stored_issue_row)?
			} else {
				statement.query_map(params![Option::<&str>::None, limit], stored_issue_row)?
			};
			rows.collect::<Result<Vec<_>, _>>()?
		};
		let mut findings = Vec::with_capacity(issues.len());
		for issue in issues {
			let payload = self.read_payload(issue.payload_offset, issue.payload_len)?;
			findings.push(IssueFinding { issue, payload });
		}
		Ok(findings)
	}

	/// Deletes one unambiguous issue scope in a single SQLite transaction.
	///
	/// # Errors
	/// Returns a typed selector error before opening the transaction unless
	/// exactly one of `id`, `device`, or `all` is selected.
	pub fn delete_issues(&self, selector: &IssueDeleteSelector) -> Result<usize, QueryError> {
		selector.validate()?;
		let mut database = self.database.lock();
		let transaction = database.transaction()?;
		let deleted = if let Some(id) = selector.id.as_deref() {
			transaction.execute("DELETE FROM telemetry_issues WHERE id = ?1", params![id])?
		} else if let Some(device) = selector.device.as_deref() {
			transaction.execute("DELETE FROM telemetry_issues WHERE device = ?1", params![device])?
		} else {
			transaction.execute("DELETE FROM telemetry_issues", [])?
		};
		transaction.commit()?;
		Ok(deleted)
	}

	/// Grants upload consent only when the UI-confirmed target revision still
	/// matches the filed issue.
	pub fn consent_upload(&self, id: &str, revision: &str, now_ms: u64) -> Result<bool, QueryError> {
		let changed = self.database.lock().execute(
			"UPDATE telemetry_issues SET consent = 'upload', consent_revision = ?2, \
			 next_attempt_at_ms = ?3 WHERE id = ?1 AND rev = ?2 AND terminal = 0",
			params![id, revision, now_ms],
		)?;
		Ok(changed == 1)
	}

	/// Returns bounded consented rows due for upload with exact payload bytes.
	pub fn pending_uploads(
		&self,
		now_ms: u64,
		limit: usize,
	) -> Result<Vec<PendingIssue>, QueryError> {
		let issues = {
			let database = self.database.lock();
			let mut statement = database.prepare(
				"SELECT id, session_id, device, rev, consent, created_at_ms, payload_offset, \
				 payload_len, consent_revision, attempt_count, next_attempt_at_ms, terminal, \
				 remote_ack FROM telemetry_issues WHERE consent = 'upload' AND terminal = 0 AND \
				 remote_ack IS NULL AND next_attempt_at_ms <= ?1 ORDER BY created_at_ms, id LIMIT ?2",
			)?;
			let rows = statement.query_map(params![now_ms, limit], stored_issue_row)?;
			rows.collect::<Result<Vec<_>, _>>()?
		};
		let mut pending = Vec::with_capacity(issues.len());
		for issue in issues {
			let payload = self.read_payload(issue.payload_offset, issue.payload_len)?;
			pending.push(PendingIssue { issue, payload });
		}
		Ok(pending)
	}

	/// Returns bounded unacknowledged rows for an explicit manual push.
	///
	/// Manual invocation is itself the user's upload intent, so this bypasses
	/// the interactive consent disposition while preserving terminal remote
	/// acknowledgements.
	///
	/// # Errors
	/// Returns a SQLite or side-file error if pending findings cannot be read.
	pub fn pending_manual_uploads(&self, limit: usize) -> Result<Vec<PendingIssue>, QueryError> {
		let issues = {
			let database = self.database.lock();
			let mut statement = database.prepare(
				"SELECT id, session_id, device, rev, consent, created_at_ms, payload_offset, \
				 payload_len, consent_revision, attempt_count, next_attempt_at_ms, terminal, \
				 remote_ack FROM telemetry_issues WHERE terminal = 0 AND remote_ack IS NULL ORDER BY \
				 created_at_ms, id LIMIT ?1",
			)?;
			let rows = statement.query_map(params![limit], stored_issue_row)?;
			rows.collect::<Result<Vec<_>, _>>()?
		};
		let mut pending = Vec::with_capacity(issues.len());
		for issue in issues {
			let payload = self.read_payload(issue.payload_offset, issue.payload_len)?;
			pending.push(PendingIssue { issue, payload });
		}
		Ok(pending)
	}

	/// Records one retryable delivery failure and its bounded next attempt.
	pub fn record_upload_failure(
		&self,
		id: &str,
		next_attempt_at_ms: u64,
	) -> Result<(), QueryError> {
		self.database.lock().execute(
			"UPDATE telemetry_issues SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?2 \
			 WHERE id = ?1 AND terminal = 0",
			params![id, next_attempt_at_ms],
		)?;
		Ok(())
	}

	/// Atomically records the sole remote acknowledgement and terminal state.
	pub fn acknowledge_upload(&self, id: &str, acknowledgement: &str) -> Result<bool, QueryError> {
		let changed = self.database.lock().execute(
			"UPDATE telemetry_issues SET remote_ack = ?2, terminal = 1, attempt_count = \
			 attempt_count + 1 WHERE id = ?1 AND remote_ack IS NULL AND terminal = 0",
			params![id, acknowledgement],
		)?;
		Ok(changed == 1)
	}

	/// Marks an issue terminally local-only or rejected so it can never send.
	pub fn reject_upload(&self, id: &str) -> Result<(), QueryError> {
		self.database.lock().execute(
			"UPDATE telemetry_issues SET consent = 'local_only', terminal = 1 WHERE id = ?1",
			params![id],
		)?;
		Ok(())
	}

	fn read_payload(&self, offset: u64, length: u32) -> Result<Vec<u8>, QueryError> {
		let mut file = File::open(&self.side_path)?;
		file.seek(SeekFrom::Start(offset.saturating_add(4)))?;
		let mut payload = vec![0; length as usize];
		file.read_exact(&mut payload)?;
		Ok(payload)
	}
}

fn stored_issue_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredIssue> {
	Ok(StoredIssue {
		id:                 Str::from(row.get::<_, String>(0)?),
		session_id:         Str::from(row.get::<_, String>(1)?),
		device:             Str::from(row.get::<_, String>(2)?),
		rev:                row.get::<_, Option<String>>(3)?.map(Str::from),
		consent:            Str::from(row.get::<_, String>(4)?),
		created_at_ms:      row.get(5)?,
		payload_offset:     row.get(6)?,
		payload_len:        row.get(7)?,
		consent_revision:   row.get::<_, Option<String>>(8)?.map(Str::from),
		attempt_count:      row.get(9)?,
		next_attempt_at_ms: row.get(10)?,
		terminal:           row.get::<_, i64>(11)? != 0,
		remote_ack:         row.get::<_, Option<String>>(12)?.map(Str::from),
	})
}

#[cfg(test)]
mod tests {
	use omp_core::sf;
	use tempfile::tempdir;

	use super::*;

	#[test]
	fn sql_and_backfill_predicates_agree() {
		let predicate = Where { field: sf!("kind"), op: WhereOp::Eq, value: sf!("tool_call") };
		assert_eq!(predicate.to_sql().unwrap(), "kind = ?");
		assert!(
			predicate
				.matches(&IndexedEvent {
					session_id:     sf!("s"),
					offset:         TelemetryWatermark(0),
					kind:           sf!("tool_call"),
					occurred_at_ms: 1,
					backfilled:     true,
				})
				.unwrap()
		);
	}

	#[test]
	fn append_tracks_byte_offset_watermark() {
		let temporary = tempdir().unwrap();
		let index =
			TelemetryIndex::open(temporary.path(), &temporary.path().join("telemetry.sqlite"))
				.unwrap();
		assert_eq!(index.append("s", "turn_start", 1, b"one").unwrap(), TelemetryWatermark(0));
		assert_eq!(index.watermark(), TelemetryWatermark(7));
	}
	fn store_test_issue(
		index: &TelemetryIndex,
		id: &'static str,
		session: &'static str,
		device: &'static str,
		created_at_ms: u64,
	) {
		let payload = format!(r#"{{"report":"{id}"}}"#);
		let offset = index
			.append(session, "issue_report", created_at_ms, payload.as_bytes())
			.unwrap();
		index
			.store_issue(&StoredIssue {
				id: Str::new_static(id),
				session_id: Str::new_static(session),
				device: Str::new_static(device),
				rev: Some(sf!("1")),
				consent: sf!("local_only"),
				created_at_ms,
				payload_offset: offset.0,
				payload_len: payload.len().try_into().unwrap(),
				consent_revision: Some(sf!("1")),
				attempt_count: 0,
				next_attempt_at_ms: 0,
				terminal: false,
				remote_ack: None,
			})
			.unwrap();
	}

	#[test]
	fn issue_inventory_filters_across_sessions_and_delete_is_transactional() {
		let temporary = tempdir().unwrap();
		let index =
			TelemetryIndex::open(temporary.path(), &temporary.path().join("telemetry.sqlite"))
				.unwrap();
		store_test_issue(&index, "qa-a", "session-a", "read", 1);
		store_test_issue(&index, "qa-b", "session-b", "write", 2);
		store_test_issue(&index, "qa-c", "session-c", "read", 3);

		let all = index
			.issue_inventory(&IssueInventoryFilter { device: None, limit: 20 })
			.unwrap();
		assert_eq!(
			all.iter()
				.map(|finding| finding.issue.id.as_str())
				.collect::<Vec<_>>(),
			["qa-c", "qa-b", "qa-a"]
		);
		let reads = index
			.issue_inventory(&IssueInventoryFilter { device: Some(sf!("read")), limit: 20 })
			.unwrap();
		assert_eq!(
			reads
				.iter()
				.map(|finding| finding.issue.session_id.as_str())
				.collect::<Vec<_>>(),
			["session-c", "session-a"]
		);

		assert!(matches!(
			index.delete_issues(&IssueDeleteSelector::default()),
			Err(QueryError::MissingIssueSelector)
		));
		assert!(matches!(
			index.delete_issues(&IssueDeleteSelector {
				id:     Some(sf!("qa-a")),
				device: None,
				all:    true,
			}),
			Err(QueryError::ConflictingIssueSelectors)
		));
		assert_eq!(
			index
				.delete_issues(&IssueDeleteSelector {
					id:     None,
					device: Some(sf!("read")),
					all:    false,
				})
				.unwrap(),
			2
		);
		let remaining = index
			.issue_inventory(&IssueInventoryFilter { device: None, limit: 20 })
			.unwrap();
		assert_eq!(remaining.len(), 1);
		assert_eq!(remaining[0].issue.id, "qa-b");
	}

	#[test]
	fn upload_acknowledgement_is_committed_once() {
		let temporary = tempdir().unwrap();
		let index =
			TelemetryIndex::open(temporary.path(), &temporary.path().join("telemetry.sqlite"))
				.unwrap();
		store_test_issue(&index, "qa-a", "session-a", "read", 1);
		let pending = index.pending_manual_uploads(20).unwrap();
		assert_eq!(pending.len(), 1);
		assert_eq!(pending[0].issue.consent, "local_only");
		assert!(index.acknowledge_upload("qa-a", "remote-1").unwrap());
		assert!(!index.acknowledge_upload("qa-a", "remote-2").unwrap());
		let issue = index.issue("qa-a").unwrap().unwrap();
		assert_eq!(issue.remote_ack.as_deref(), Some("remote-1"));
		assert_eq!(issue.attempt_count, 1);
		assert!(issue.terminal);
	}
}
