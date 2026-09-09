//! SQLite target parsing, read-only querying, and deterministic text rendering.

use std::{
	collections::HashMap,
	fmt::Write,
	fs::File,
	io::{Read, Seek, SeekFrom},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use omp_core::sf;
use omp_tool::{Diag, DiagKind, Unit};
use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, types, types::ValueRef};
use smallvec::{SmallVec, smallvec};

use super::format::Rendered;

const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const DEFAULT_QUERY_LIMIT: usize = 20;
const DEFAULT_SCHEMA_SAMPLE_LIMIT: usize = 5;
const MAX_QUERY_LIMIT: usize = 500;
/// Maximum rows retained from an unrestricted raw query.
pub const MAX_RAW_QUERY_ROWS: usize = 1_000;
const MAX_RENDER_WIDTH: usize = 120;
const MAX_COLUMN_WIDTH: usize = 40;
const MIN_COLUMN_WIDTH: usize = 3;
const COLUMN_SEPARATOR_WIDTH: usize = 3;
const TABLE_FRAME_WIDTH: usize = 1;
/// Maximum rows scanned to establish a table's row count.
pub const ROW_COUNT_PROBE_CAP: usize = 50_000;

const COMMENT_OR_TERMINATOR_ERROR: &str = "SQLite 'where' clause must not contain comments or \
                                           statement terminators; use '?q=SELECT ...' for raw SQL";
const FORBIDDEN_KEYWORD_ERROR: &str = "SQLite 'where' clause must not contain \
                                       LIMIT/OFFSET/UNION/INTERSECT/EXCEPT/ATTACH/DETACH/PRAGMA; \
                                       use '?q=SELECT ...' for raw SQL";

/// A deterministic SQLite read or selector error.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Error(String);

impl From<rusqlite::Error> for Error {
	fn from(value: rusqlite::Error) -> Self {
		Self(value.to_string())
	}
}

/// Cross-thread cancellation for one SQLite inspection.
///
/// The progress callback closes the race where cancellation arrives just
/// before a query begins, while SQLite's interrupt handle stops work already
/// running inside the virtual machine.
#[derive(Default)]
pub struct QueryInterrupt {
	interrupted: AtomicBool,
	handle:      Mutex<Option<rusqlite::InterruptHandle>>,
}

impl QueryInterrupt {
	/// Requests cancellation of the current or next SQLite operation.
	pub fn interrupt(&self) {
		self.interrupted.store(true, Ordering::Release);
		if let Some(handle) = self.handle.lock().as_ref() {
			handle.interrupt();
		}
	}

	fn install(self: &Arc<Self>, connection: &Connection) -> Result<(), Error> {
		let progress = self.clone();
		connection
			.progress_handler(1_000, Some(move || progress.interrupted.load(Ordering::Acquire)))?;
		let handle = connection.get_interrupt_handle();
		let mut published = self.handle.lock();
		if self.interrupted.load(Ordering::Acquire) {
			handle.interrupt();
		}
		*published = Some(handle);
		Ok(())
	}

	fn is_interrupted(&self) -> bool {
		self.interrupted.load(Ordering::Acquire)
	}
}

/// A possible split of a path at a recognized SQLite extension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathCandidate {
	/// Authored path to the database file.
	pub sqlite_path:  PathBuf,
	/// Sub-path identifying the table or row.
	pub sub_path:     String,
	/// Query string containing query parameters.
	pub query_string: String,
}

/// Parsed read operation encoded after a SQLite database path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Selector {
	/// List tables in the database.
	List,
	/// Show table schema and sample rows.
	Schema {
		/// Target table name.
		table:        String,
		/// Number of sample rows to include.
		sample_limit: usize,
	},
	/// Look up a single row by primary key or ROWID.
	Row {
		/// Target table name.
		table: String,
		/// Row key value.
		key:   String,
	},
	/// Query a table with optional filter, sort, and pagination.
	Query {
		/// Target table name.
		table:        String,
		/// Max rows to return.
		limit:        usize,
		/// Row offset.
		offset:       usize,
		/// Optional ORDER BY clause.
		order:        Option<String>,
		/// Optional WHERE clause.
		where_clause: Option<String>,
	},
	/// Execute a raw SELECT query.
	Raw {
		/// Raw SQL query text.
		sql: String,
	},
}

/// Validated strategy for looking up a single row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RowLookup {
	/// Look up row by explicit primary key column.
	PrimaryKey {
		/// Column name.
		column:        String,
		/// Declared SQLite type.
		declared_type: String,
	},
	/// Look up row by SQLite internal ROWID.
	RowId,
}

/// A bounded table row count.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TableRowCount {
	/// Exact row count.
	Exact(usize),
	/// Estimated row count.
	Estimate(usize),
	/// Lower bound row count.
	AtLeast(usize),
}

/// One table shown by a database-root read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TableSummary {
	/// Table name.
	pub name:  String,
	/// Row count summary.
	pub count: TableRowCount,
}

/// A SQLite value retained independently of a connection or statement.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
	/// NULL value.
	Null,
	/// Integer (64-bit).
	Integer(i64),
	/// Real / floating point.
	Real(f64),
	/// Text / string.
	Text(String),
	/// Binary blob.
	Blob(Vec<u8>),
}

/// A row whose column order is stable and matches SQLite's result metadata.
pub type Row = Vec<(String, types::Value)>;

/// A rectangular query page.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryPage {
	/// Column names in order.
	pub columns:     Vec<String>,
	/// Returned row values.
	pub rows:        Vec<Row>,
	/// Total row count in table or query.
	pub total_count: usize,
}

/// Result of a capped raw query.
#[derive(Clone, Debug, PartialEq)]
pub struct RawQueryResult {
	/// Column names in order.
	pub columns:   Vec<String>,
	/// Returned row values.
	pub rows:      Vec<Row>,
	/// Whether the result was truncated at the row cap.
	pub truncated: bool,
}
/// Schema information validated against an open database.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedTable {
	/// Table name.
	pub name:        String,
	/// Column names in schema order.
	pub columns:     Vec<String>,
	/// Primary key column name and declared type if unique.
	pub primary_key: Option<(String, String)>,
	/// Whether the table supports ROWID lookups.
	pub has_rowid:   bool,
}
/// Returns whether the bytes begin with SQLite's file magic.
pub fn looks_like_sqlite(bytes: &[u8]) -> bool {
	bytes.starts_with(SQLITE_MAGIC)
}
/// Detects a SQLite target by both a recognized extension boundary and magic.
pub fn is_sqlite_target(display_path: &str, prefix: &[u8]) -> bool {
	looks_like_sqlite(prefix) && !parse_path_candidates(display_path).is_empty()
}

/// Opens an existing database for query-only reads and installs a
/// three-second busy timeout.
///
/// A cleanly closed WAL database can retain WAL format bytes in its header
/// after SQLite removes its `-wal` and `-shm` files. SQLite cannot recreate
/// those sidecars through a read-only file handle, so that case is opened
/// read-write once and immediately constrained with `query_only`.
pub fn open_read_only(path: &Path) -> Result<Connection, Error> {
	let flags = if requires_wal_sidecar_initialization(path) {
		OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI
	} else {
		OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI
	};
	let connection = Connection::open_with_flags(path, flags)?;
	connection.pragma_update(None, "query_only", true)?;
	connection.busy_timeout(Duration::from_millis(3_000))?;
	connection
		.query_row("SELECT name FROM sqlite_master LIMIT 1", [], |_| Ok(()))
		.optional()?;
	Ok(connection)
}

fn requires_wal_sidecar_initialization(path: &Path) -> bool {
	let Ok(mut file) = File::open(path) else {
		return false;
	};
	let mut format_versions = [0; 2];
	if file.seek(SeekFrom::Start(18)).is_err() || file.read_exact(&mut format_versions).is_err() {
		return false;
	}
	format_versions == [2, 2]
		&& (!sidecar_path(path, "-wal").exists() || !sidecar_path(path, "-shm").exists())
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
	let mut sidecar = path.as_os_str().to_os_string();
	sidecar.push(suffix);
	PathBuf::from(sidecar)
}

/// Finds every extension-boundary split, longest database path first.
pub fn parse_path_candidates(file_path: &str) -> Vec<PathCandidate> {
	let normalized = file_path.replace('\\', "/");
	let lower = normalized.to_ascii_lowercase();
	let mut result = Vec::new();
	for extension in [".sqlite3", ".sqlite", ".db3", ".db"] {
		let mut start = 0;
		while let Some(relative) = lower[start..].find(extension) {
			let end = start + relative + extension.len();
			let boundary = lower.as_bytes().get(end).copied();
			if matches!(boundary, None | Some(b':' | b'?')) {
				let remainder = &normalized[end..];
				let (sub_path, query_string) = match remainder.find('?') {
					Some(index) => (&remainder[..index], &remainder[index + 1..]),
					None => (remainder, ""),
				};
				let candidate = PathCandidate {
					sqlite_path:  PathBuf::from(&file_path[..end]),
					sub_path:     sub_path.trim_start_matches(':').to_owned(),
					query_string: query_string.to_owned(),
				};
				if !result.contains(&candidate) {
					result.push(candidate);
				}
			}
			start = end;
		}
	}
	result.sort_by(|left, right| {
		right
			.sqlite_path
			.as_os_str()
			.len()
			.cmp(&left.sqlite_path.as_os_str().len())
	});
	result
}

fn decode_component(value: &str) -> String {
	let bytes = value.as_bytes();
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		match bytes[index] {
			b'+' => {
				decoded.push(b' ');
				index += 1;
			},
			b'%' if index + 2 < bytes.len() => {
				let hex = |byte: u8| match byte {
					b'0'..=b'9' => Some(byte - b'0'),
					b'a'..=b'f' => Some(byte - b'a' + 10),
					b'A'..=b'F' => Some(byte - b'A' + 10),
					_ => None,
				};
				if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
					decoded.push(high * 16 + low);
					index += 3;
				} else {
					decoded.push(bytes[index]);
					index += 1;
				}
			},
			byte => {
				decoded.push(byte);
				index += 1;
			},
		}
	}
	String::from_utf8_lossy(&decoded).into_owned()
}

fn query_params(query: &str) -> Vec<(String, String)> {
	query
		.split('&')
		.filter(|part| !part.is_empty())
		.map(|part| {
			let (key, value) = part.split_once('=').unwrap_or((part, ""));
			(decode_component(key), decode_component(value))
		})
		.collect()
}

fn first_param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
	params
		.iter()
		.find(|(name, _)| name == key)
		.map(|(_, value)| value.as_str())
}

fn parse_int_prefix(value: &str) -> Option<i128> {
	let value = value.trim_start();
	let (negative, digits) = match value.as_bytes().first() {
		Some(b'-') => (true, &value[1..]),
		Some(b'+') => (false, &value[1..]),
		_ => (false, value),
	};
	let digit_count = digits.bytes().take_while(u8::is_ascii_digit).count();
	if digit_count == 0 {
		return None;
	}
	let magnitude = digits[..digit_count].bytes().fold(0_i128, |number, digit| {
		number
			.saturating_mul(10)
			.saturating_add(i128::from(digit - b'0'))
	});
	Some(if negative {
		magnitude.saturating_neg()
	} else {
		magnitude
	})
}

fn parse_limit(value: Option<&str>, fallback: usize) -> Result<usize, Error> {
	let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
		return Ok(fallback);
	};
	let parsed = parse_int_prefix(value)
		.ok_or_else(|| Error(format!("SQLite limit must be a positive integer; got '{value}'")))?;
	if parsed < 1 {
		return Err(Error(format!("SQLite limit must be a positive integer; got '{value}'")));
	}
	Ok(usize::try_from(parsed)
		.unwrap_or(usize::MAX)
		.min(MAX_QUERY_LIMIT))
}

fn parse_offset(value: Option<&str>) -> Result<usize, Error> {
	let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
		return Ok(0);
	};
	let parsed = parse_int_prefix(value).ok_or_else(|| {
		Error(format!("SQLite offset must be a non-negative integer; got '{value}'"))
	})?;
	if parsed < 0 {
		return Err(Error(format!("SQLite offset must be a non-negative integer; got '{value}'")));
	}
	Ok(usize::try_from(parsed).unwrap_or(usize::MAX))
}

/// Validates a structured `where=` clause without changing its SQL semantics.
pub fn validate_where_clause(value: Option<&str>) -> Result<Option<String>, Error> {
	let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
		return Ok(None);
	};
	let mut single = false;
	let mut double = false;
	let mut token = String::new();
	let bytes = value.as_bytes();
	let forbidden =
		["limit", "offset", "union", "intersect", "except", "attach", "detach", "pragma"];
	let mut keyword_violation = false;
	let mut flush = |token: &mut String| {
		if forbidden.contains(&token.to_ascii_lowercase().as_str()) {
			keyword_violation = true;
		}
		token.clear();
	};
	let mut index = 0;
	while index <= bytes.len() {
		let current = bytes.get(index).copied();
		let next = bytes.get(index + 1).copied();
		if single {
			if current == Some(b'\'') && next == Some(b'\'') {
				index += 2;
				continue;
			}
			if current == Some(b'\'') {
				single = false;
			}
			index += 1;
			continue;
		}
		if double {
			if current == Some(b'"') && next == Some(b'"') {
				index += 2;
				continue;
			}
			if current == Some(b'"') {
				double = false;
			}
			index += 1;
			continue;
		}
		if current.is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_') {
			token.push(current.unwrap() as char);
			index += 1;
			continue;
		}
		flush(&mut token);
		match current {
			None => break,
			Some(b'\'') => single = true,
			Some(b'"') => double = true,
			Some(b';') => return Err(Error(COMMENT_OR_TERMINATOR_ERROR.to_owned())),
			Some(b'-') if next == Some(b'-') => {
				return Err(Error(COMMENT_OR_TERMINATOR_ERROR.to_owned()));
			},
			Some(b'/') if next == Some(b'*') => {
				return Err(Error(COMMENT_OR_TERMINATOR_ERROR.to_owned()));
			},
			Some(b'*') if next == Some(b'/') => {
				return Err(Error(COMMENT_OR_TERMINATOR_ERROR.to_owned()));
			},
			_ => {},
		}
		index += 1;
	}
	if keyword_violation {
		return Err(Error(FORBIDDEN_KEYWORD_ERROR.to_owned()));
	}
	Ok(Some(value.to_owned()))
}

/// Parses selectors and percent-decoded query parameters exactly once.
pub fn parse_selector(sub_path: &str, query_string: &str) -> Result<Selector, Error> {
	let normalized = sub_path.trim_start_matches(':').trim();
	let query = query_params(query_string);
	if let Some(raw) = first_param(&query, "q") {
		if !normalized.is_empty() || query.iter().any(|(key, _)| key != "q") {
			return Err(Error(
				"SQLite raw queries cannot be combined with table selectors or pagination".into(),
			));
		}
		if raw.trim().is_empty() {
			return Err(Error("SQLite query parameter 'q' cannot be empty".into()));
		}
		return Ok(Selector::Raw { sql: raw.to_owned() });
	}
	if normalized.is_empty() {
		if !query.is_empty() {
			return Err(Error(
				"SQLite query parameters require a table selector or q=SELECT...".into(),
			));
		}
		return Ok(Selector::List);
	}
	let (table, key) = normalized
		.split_once(':')
		.map_or((normalized, None), |(table, key)| (table, Some(key)));
	if table.is_empty() {
		return Err(Error("SQLite selectors must include a table name".into()));
	}
	if let Some(key) = key.filter(|key| !key.is_empty()) {
		if !query.is_empty() {
			return Err(Error("SQLite row lookups cannot be combined with query parameters".into()));
		}
		return Ok(Selector::Row { table: table.to_owned(), key: key.to_owned() });
	}
	let where_clause = validate_where_clause(first_param(&query, "where"))?;
	let order = first_param(&query, "order")
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(str::to_owned);
	let has_query = query
		.iter()
		.any(|(key, _)| key == "limit" || key == "offset")
		|| order.is_some()
		|| where_clause.is_some();
	let known = ["limit", "offset", "order", "where"];
	if let Some((unknown, _)) = query.iter().find(|(key, _)| !known.contains(&key.as_str())) {
		return Err(Error(format!("Unsupported SQLite query parameter '{unknown}'")));
	}
	if has_query {
		return Ok(Selector::Query {
			table: table.to_owned(),
			limit: parse_limit(first_param(&query, "limit"), DEFAULT_QUERY_LIMIT)?,
			offset: parse_offset(first_param(&query, "offset"))?,
			order,
			where_clause,
		});
	}
	Ok(Selector::Schema {
		table:        table.to_owned(),
		sample_limit: DEFAULT_SCHEMA_SAMPLE_LIMIT,
	})
}

fn quote_identifier(identifier: &str) -> String {
	format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn master_row(connection: &Connection, table: &str) -> Result<(String, Option<String>), Error> {
	connection
		.query_row(
			"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
			 AND name = ?1",
			[table],
			|row| Ok((row.get(0)?, row.get(1)?)),
		)
		.optional()?
		.ok_or_else(|| Error(format!("SQLite table '{table}' not found")))
}

/// Returns the validated column names for an existing user table.
pub fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, Error> {
	master_row(connection, table)?;
	let mut statement =
		connection.prepare(&format!("PRAGMA table_info({})", quote_identifier(table)))?;

	let columns = statement
		.query_map([], |row| row.get(1))?
		.collect::<Result<Vec<_>, _>>()?;
	Ok(columns)
}

#[derive(Debug)]
struct ColumnInfo {
	name:          String,
	declared_type: String,
	pk:            i64,
}

fn column_info(connection: &Connection, table: &str) -> Result<Vec<ColumnInfo>, Error> {
	master_row(connection, table)?;
	let mut statement =
		connection.prepare(&format!("PRAGMA table_info({})", quote_identifier(table)))?;
	let columns = statement
		.query_map([], |row| {
			Ok(ColumnInfo {
				name:          row.get(1)?,
				declared_type: row.get(2)?,
				pk:            row.get(5)?,
			})
		})?
		.collect::<Result<Vec<_>, _>>()?;
	Ok(columns)
}
/// Returns a table's single-column primary key, or `None` when absent or
/// composite.
pub fn table_primary_key(
	connection: &Connection,
	table: &str,
) -> Result<Option<(String, String)>, Error> {
	let mut primary: Vec<_> = column_info(connection, table)?
		.into_iter()
		.filter(|column| column.pk > 0)
		.collect();
	primary.sort_by_key(|column| column.pk);
	Ok(if primary.len() == 1 {
		let column = primary.remove(0);
		Some((column.name, column.declared_type))
	} else {
		None
	})
}

/// Returns the CREATE TABLE statement for an existing user table.
pub fn table_schema(connection: &Connection, table: &str) -> Result<String, Error> {
	let (_, sql) = master_row(connection, table)?;
	sql.ok_or_else(|| Error(format!("SQLite schema for table '{table}' is unavailable")))
}

/// Resolves single-PK and implicit-rowid tables while rejecting ambiguous keys.
pub fn resolve_row_lookup(connection: &Connection, table: &str) -> Result<RowLookup, Error> {
	let mut primary: Vec<_> = column_info(connection, table)?
		.into_iter()
		.filter(|column| column.pk > 0)
		.collect();
	primary.sort_by_key(|column| column.pk);
	if primary.len() == 1 {
		let column = primary.remove(0);
		return Ok(RowLookup::PrimaryKey {
			column:        column.name,
			declared_type: column.declared_type,
		});
	}
	if primary.len() > 1 {
		return Err(Error(format!(
			"SQLite table '{table}' has a composite primary key; use '?where=' instead"
		)));
	}
	if table_schema(connection, table)?
		.to_ascii_uppercase()
		.split_whitespace()
		.collect::<Vec<_>>()
		.windows(2)
		.any(|pair| pair == ["WITHOUT", "ROWID"])
	{
		return Err(Error(format!(
			"SQLite table '{table}' does not expose ROWID; use '?where=' instead"
		)));
	}
	Ok(RowLookup::RowId)
}
/// Validates a table name and captures schema facts needed by later row
/// operations. Callers must still quote validated identifiers and bind values.
pub fn validate_table(connection: &Connection, table: &str) -> Result<ValidatedTable, Error> {
	let name = master_row(connection, table)?.0;
	let schema = table_schema(connection, table)?;
	let has_rowid = !schema
		.to_ascii_uppercase()
		.split_whitespace()
		.collect::<Vec<_>>()
		.windows(2)
		.any(|pair| pair == ["WITHOUT", "ROWID"]);
	Ok(ValidatedTable {
		name,
		columns: table_columns(connection, table)?,
		primary_key: table_primary_key(connection, table)?,
		has_rowid,
	})
}

/// Checks user-supplied column names against a previously validated schema.
pub fn validate_columns<'a>(
	table: &ValidatedTable,
	columns: impl IntoIterator<Item = &'a str>,
) -> Result<Vec<String>, Error> {
	columns
		.into_iter()
		.map(|column| {
			if table.columns.iter().any(|known| known == column) {
				Ok(column.to_owned())
			} else {
				Err(Error(format!("SQLite table '{}' has no column named '{column}'", table.name)))
			}
		})
		.collect()
}

fn row_from_sql(row: &rusqlite::Row<'_>, columns: &[String]) -> rusqlite::Result<Row> {
	columns
		.iter()
		.enumerate()
		.map(|(index, name)| {
			let value = match row.get_ref(index)? {
				ValueRef::Null => types::Value::Null,
				ValueRef::Integer(value) => types::Value::Integer(value),
				ValueRef::Real(value) => types::Value::Real(value),
				ValueRef::Text(value) => {
					types::Value::Text(String::from_utf8_lossy(value).into_owned())
				},
				ValueRef::Blob(value) => types::Value::Blob(value.to_vec()),
			};
			Ok((name.clone(), value))
		})
		.collect()
}

fn coerce_integer(key: &str, label: &str) -> Result<i64, Error> {
	let trimmed = key.trim();
	if trimmed.is_empty()
		|| !trimmed
			.bytes()
			.enumerate()
			.all(|(index, byte)| byte.is_ascii_digit() || index == 0 && byte == b'-')
	{
		return Err(Error(format!("{label} must be an integer; got '{key}'")));
	}
	trimmed
		.parse()
		.map_err(|_| Error(format!("{label} must be an integer; got '{key}'")))
}

fn lookup_value(key: &str, declared_type: &str) -> Result<types::Value, Error> {
	let kind = declared_type.trim().to_ascii_uppercase();
	if kind.contains("INT") {
		return Ok(coerce_integer(key, &format!("Primary key '{key}'"))?.into());
	}
	if (kind.contains("REAL") || kind.contains("FLOA") || kind.contains("DOUB"))
		&& let Ok(value) = key.parse::<f64>()
		&& value.is_finite()
	{
		return Ok(value.into());
	}
	Ok(key.to_owned().into())
}

/// Reads one row using a previously resolved lookup strategy.
pub fn row_by_key(
	connection: &Connection,
	table: &str,
	lookup: &RowLookup,
	key: &str,
) -> Result<Option<Row>, Error> {
	let columns = table_columns(connection, table)?;
	let (predicate, binding) = match lookup {
		RowLookup::PrimaryKey { column, declared_type } => {
			(format!("{} = ?1", quote_identifier(column)), lookup_value(key, declared_type)?)
		},
		RowLookup::RowId => ("rowid = ?1".to_owned(), coerce_integer(key, "SQLite ROWID")?.into()),
	};
	let mut statement = connection
		.prepare(&format!("SELECT * FROM {} WHERE {predicate} LIMIT 1", quote_identifier(table)))?;
	Ok(statement
		.query_row([binding], |row| row_from_sql(row, &columns))
		.optional()?)
}

fn resolved_order(order: Option<&str>, columns: &[String]) -> Result<String, Error> {
	let Some(order) = order.map(str::trim).filter(|order| !order.is_empty()) else {
		return Ok(String::new());
	};
	let (column, direction) = order
		.rsplit_once(':')
		.map_or((order, "asc"), |(column, direction)| (column, direction.trim()));
	if !columns.iter().any(|candidate| candidate == column) {
		return Err(Error(format!("SQLite order column '{column}' not found in table schema")));
	}
	let direction = direction.to_ascii_lowercase();
	if direction != "asc" && direction != "desc" {
		return Err(Error(format!(
			"SQLite order direction must be 'asc' or 'desc'; got '{direction}'"
		)));
	}
	Ok(format!(" ORDER BY {} {}", quote_identifier(column), direction.to_ascii_uppercase()))
}

/// Executes a validated, bounded structured table query.
pub fn query_rows(
	connection: &Connection,
	table: &str,
	limit: usize,
	offset: usize,
	order: Option<&str>,
	where_clause: Option<&str>,
) -> Result<QueryPage, Error> {
	let columns = table_columns(connection, table)?;
	let where_clause = validate_where_clause(where_clause)?
		.map_or(String::new(), |clause| format!(" WHERE {clause}"));
	let order_clause = resolved_order(order, &columns)?;
	let count_sql = format!("SELECT COUNT(*) FROM {}{where_clause}", quote_identifier(table));
	let total_count: i64 = connection.query_row(&count_sql, [], |row| row.get(0))?;
	let sql = format!(
		"SELECT * FROM {}{where_clause}{order_clause} LIMIT ?1 OFFSET ?2",
		quote_identifier(table)
	);
	let mut statement = connection.prepare(&sql)?;
	if statement.parameter_count() != 2 {
		return Err(Error(
			"SQLite where clause changed the expected pagination parameters; use q=SELECT ... for \
			 raw SQL"
				.into(),
		));
	}
	let rows = statement
		.query_map(params![limit as i64, offset as i64], |row| row_from_sql(row, &columns))?
		.collect::<Result<Vec<_>, _>>()?;
	Ok(QueryPage { columns, rows, total_count: total_count.max(0) as usize })
}

/// Executes read-only SQL and retains at most [`MAX_RAW_QUERY_ROWS`] rows.
pub fn execute_read_query(connection: &Connection, sql: &str) -> Result<RawQueryResult, Error> {
	let mut statement = connection.prepare(sql)?;
	if statement.parameter_count() > 0 {
		return Err(Error("SQLite raw queries do not support bound parameters".into()));
	}
	if !statement.readonly() {
		return Err(Error("attempt to write a readonly database".into()));
	}
	let columns = statement
		.column_names()
		.into_iter()
		.map(str::to_owned)
		.collect::<Vec<_>>();
	let mut query = statement.query([])?;
	let mut rows = Vec::new();
	let mut truncated = false;
	while let Some(row) = query.next()? {
		if rows.len() >= MAX_RAW_QUERY_ROWS {
			truncated = true;
			break;
		}
		rows.push(row_from_sql(row, &columns)?);
	}
	Ok(RawQueryResult { columns, rows, truncated })
}

fn load_estimates(connection: &Connection) -> Result<HashMap<String, usize>, Error> {
	let exists: Option<i64> = connection
		.query_row(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
			[],
			|row| row.get(0),
		)
		.optional()?;
	if exists.is_none() {
		return Ok(HashMap::new());
	}
	let mut statement = connection.prepare("SELECT tbl, stat FROM sqlite_stat1")?;
	let pairs = statement
		.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))?
		.collect::<Result<Vec<_>, _>>()?;
	let mut result: HashMap<String, usize> = HashMap::new();
	for (table, stat) in pairs {
		let Some(rows) = stat.and_then(|stat| stat.split_whitespace().next()?.parse::<usize>().ok())
		else {
			continue;
		};
		result
			.entry(table)
			.and_modify(|current| *current = (*current).max(rows))
			.or_insert(rows);
	}
	Ok(result)
}

fn probe_count(connection: &Connection, table: &str, cap: usize) -> Result<TableRowCount, Error> {
	let sql = format!(
		"SELECT COUNT(*) FROM (SELECT 1 FROM {} LIMIT {})",
		quote_identifier(table),
		cap.saturating_add(1)
	);
	let count: usize = connection.query_row(&sql, [], |row| row.get(0))?;
	Ok(if count > cap {
		TableRowCount::AtLeast(cap)
	} else {
		TableRowCount::Exact(count)
	})
}

/// Lists user tables with exact, planner-estimated, or lower-bound counts.
pub fn list_tables(connection: &Connection, probe_cap: usize) -> Result<Vec<TableSummary>, Error> {
	let estimates = load_estimates(connection)?;
	let mut statement = connection.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY \
		 name COLLATE NOCASE",
	)?;
	let names = statement
		.query_map([], |row| row.get::<_, String>(0))?
		.collect::<Result<Vec<_>, _>>()?;
	names
		.into_iter()
		.map(|name| {
			let count = match estimates.get(&name).copied() {
				Some(rows) if rows > probe_cap => TableRowCount::Estimate(rows),
				_ => probe_count(connection, &name, probe_cap)?,
			};
			Ok(TableSummary { name, count })
		})
		.collect()
}

fn display_width(value: &str) -> usize {
	xutf::width_str(value)
}
fn truncate_width(value: &str, width: usize) -> String {
	if display_width(value) <= width {
		return value.to_owned();
	}
	let target = width.saturating_sub(1);
	let mut result = String::new();
	let mut used = 0;
	for character in value.chars() {
		let char_width = xutf::width_char(character);
		if used + char_width > target {
			break;
		}
		result.push(character);
		used += char_width;
	}
	result.push('…');
	result
}
fn sanitize(value: &str) -> String {
	value
		.replace('\t', "    ")
		.replace("\r\n", "\\n")
		.replace('\n', "\\n")
}
fn format_bytes(bytes: usize) -> String {
	if bytes < 1024 {
		format!("{bytes}B")
	} else if bytes < 1024 * 1024 {
		format!("{:.1}KB", bytes as f64 / 1024.0)
	} else if bytes < 1024 * 1024 * 1024 {
		format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
	} else {
		format!("{:.1}GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
	}
}
fn value_text(value: &types::Value) -> String {
	match value {
		types::Value::Null => "NULL".into(),
		types::Value::Integer(value) => value.to_string(),
		types::Value::Real(value) => value.to_string(),
		types::Value::Text(value) => value.clone(),
		types::Value::Blob(value) => format!("<BLOB {}>", format_bytes(value.len())),
	}
}
fn row_value<'a>(row: &'a Row, column: &str) -> Option<&'a types::Value> {
	row.iter()
		.find(|(name, _)| name == column)
		.map(|(_, value)| value)
}
fn pad(value: &str, width: usize) -> String {
	let value = truncate_width(&sanitize(value), width.max(MIN_COLUMN_WIDTH));
	let padding = width.saturating_sub(display_width(&value));
	format!("{value}{}", " ".repeat(padding))
}

fn vertical_table(columns: &[String], rows: &[Row]) -> String {
	if rows.is_empty() {
		return "(no rows)".into();
	}
	let name_width = columns
		.iter()
		.map(|column| display_width(&sanitize(column)))
		.max()
		.unwrap_or(MIN_COLUMN_WIDTH)
		.clamp(MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
	rows
		.iter()
		.enumerate()
		.map(|(index, row)| {
			let mut lines = vec![format!("── Row {} ──", index + 1)];
			for column in columns {
				let value = row_value(row, column).map(value_text).unwrap_or_default();
				lines.push(truncate_width(
					&format!("{}: {}", pad(column, name_width), sanitize(&value)),
					MAX_RENDER_WIDTH,
				));
			}
			lines.join("\n")
		})
		.collect::<Vec<_>>()
		.join("\n\n")
}

/// Renders rows as a 120-column table, falling back to expanded row blocks.
pub fn render_ascii_table(columns: &[String], rows: &[Row]) -> String {
	if columns.is_empty() {
		return if rows.is_empty() {
			"(no rows)".into()
		} else {
			"(rows returned without named columns)".into()
		};
	}
	if MIN_COLUMN_WIDTH * columns.len() + COLUMN_SEPARATOR_WIDTH * columns.len() + TABLE_FRAME_WIDTH
		> MAX_RENDER_WIDTH
	{
		return vertical_table(columns, rows);
	}
	let mut widths = columns
		.iter()
		.map(|column| display_width(&sanitize(column)).clamp(MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH))
		.collect::<Vec<_>>();
	for row in rows {
		for (index, column) in columns.iter().enumerate() {
			widths[index] = widths[index].max(
				display_width(&sanitize(&row_value(row, column).map(value_text).unwrap_or_default()))
					.min(MAX_COLUMN_WIDTH),
			);
		}
	}
	let overhead = columns.len() * COLUMN_SEPARATOR_WIDTH + TABLE_FRAME_WIDTH;
	while widths.iter().sum::<usize>() + overhead > MAX_RENDER_WIDTH {
		let mut widest_index = None;
		let mut widest_width = MIN_COLUMN_WIDTH;
		for (index, width) in widths.iter().copied().enumerate() {
			if width > widest_width {
				widest_index = Some(index);
				widest_width = width;
			}
		}
		let Some(index) = widest_index else {
			break;
		};
		widths[index] -= 1;
	}
	let mut lines = vec![
		format!(
			"| {} |",
			columns
				.iter()
				.enumerate()
				.map(|(index, column)| pad(column, widths[index]))
				.collect::<Vec<_>>()
				.join(" | ")
		),
		format!(
			"| {} |",
			widths
				.iter()
				.map(|width| "-".repeat(*width))
				.collect::<Vec<_>>()
				.join(" | ")
		),
	];
	if rows.is_empty() {
		lines.push("(no rows)".into());
	} else {
		for row in rows {
			lines.push(format!(
				"| {} |",
				columns
					.iter()
					.enumerate()
					.map(|(index, column)| pad(
						&row_value(row, column).map(value_text).unwrap_or_default(),
						widths[index]
					))
					.collect::<Vec<_>>()
					.join(" | ")
			));
		}
	}
	lines
		.into_iter()
		.map(|line| truncate_width(&line.replace('\t', "    "), MAX_RENDER_WIDTH))
		.collect::<Vec<_>>()
		.join("\n")
}

/// Renders the database-root table listing.
pub fn render_table_list(tables: &[TableSummary]) -> String {
	if tables.is_empty() {
		return "(no tables)".into();
	}
	tables
		.iter()
		.map(|table| {
			let count = match table.count {
				TableRowCount::Exact(rows) => format!("{rows} rows"),
				TableRowCount::Estimate(rows) => format!("~{rows} rows"),
				TableRowCount::AtLeast(rows) => format!("{rows}+ rows"),
			};
			truncate_width(
				&format!("{} ({count})", table.name).replace('\t', "    "),
				MAX_RENDER_WIDTH,
			)
		})
		.collect::<Vec<_>>()
		.join("\n")
}

/// Renders CREATE SQL followed by five sample rows.
pub fn render_schema(create_sql: &str, sample: &QueryPage) -> String {
	let schema = create_sql
		.replace('\t', "    ")
		.lines()
		.map(|line| truncate_width(line, MAX_RENDER_WIDTH))
		.collect::<Vec<_>>()
		.join("\n");
	format!("{schema}\n\nSample rows:\n{}", render_ascii_table(&sample.columns, &sample.rows))
}

/// Renders a single row as `column: value` lines.
pub fn render_row(row: &Row) -> String {
	if row.is_empty() {
		return "(no columns)".into();
	}
	row.iter()
		.map(|(column, value)| {
			truncate_width(
				&format!("{column}: {}", value_text(value)).replace('\t', "    "),
				MAX_RENDER_WIDTH,
			)
		})
		.collect::<Vec<_>>()
		.join("\n")
}

/// Renders a query page and its exact continuation diagnostic.
pub fn render_table(page: &QueryPage, offset: usize, limit: usize, table: &str) -> Rendered {
	let text = render_ascii_table(&page.columns, &page.rows);
	let shown = page.total_count.min(offset + page.rows.len());
	let mut diags = SmallVec::new();
	if shown < page.total_count {
		let omitted = page.total_count - shown;
		diags.push(
			Diag::info(DiagKind::Pagination, sf!("{omitted} rows remain in table '{table}'."))
				.continuation(sf!(":{table}?limit={limit}&offset={}", offset + page.rows.len()))
				.omitted(omitted as u64, Unit::Rows),
		);
	}
	Rendered { text: text.into(), diags }
}

/// Executes and renders any parsed selector against an already-open read-only
/// database.
pub fn render_selector(connection: &Connection, selector: &Selector) -> Result<Rendered, Error> {
	match selector {
		Selector::List => Ok(Rendered {
			text:  render_table_list(&list_tables(connection, ROW_COUNT_PROBE_CAP)?).into(),
			diags: smallvec![],
		}),
		Selector::Schema { table, sample_limit } => {
			let sample = query_rows(connection, table, *sample_limit, 0, None, None)?;
			let output = render_schema(&table_schema(connection, table)?, &sample);
			let mut diags = SmallVec::new();
			if sample.rows.len() < sample.total_count {
				let omitted = sample.total_count - sample.rows.len();
				diags.push(
					Diag::info(DiagKind::Pagination, sf!("{omitted} rows remain in table '{table}'."))
						.continuation(sf!(":{table}?limit=20&offset={}", sample.rows.len()))
						.omitted(omitted as u64, Unit::Rows),
				);
			}
			Ok(Rendered { text: output.into(), diags })
		},
		Selector::Row { table, key } => {
			let text =
				match row_by_key(connection, table, &resolve_row_lookup(connection, table)?, key)? {
					Some(row) => render_row(&row),
					None => format!("No row found in table '{table}' for key '{key}'."),
				};
			Ok(Rendered { text: text.into(), diags: smallvec![] })
		},
		Selector::Query { table, limit, offset, order, where_clause } => Ok(render_table(
			&query_rows(
				connection,
				table,
				*limit,
				*offset,
				order.as_deref(),
				where_clause.as_deref(),
			)?,
			*offset,
			*limit,
			table,
		)),
		Selector::Raw { sql } => {
			let result = execute_read_query(connection, sql)?;
			let page = QueryPage {
				columns:     result.columns,
				total_count: result.rows.len(),
				rows:        result.rows,
			};
			let mut rendered = render_table(&page, 0, page.rows.len().max(1), "query");
			if result.truncated {
				rendered.diags.push(
					Diag::info(
						DiagKind::LimitReached,
						sf!("Output capped at {MAX_RAW_QUERY_ROWS} rows."),
					)
					.continuation("q=SELECT ... LIMIT ... OFFSET ...")
					.omitted(1, Unit::Rows),
				);
			}
			Ok(rendered)
		},
	}
}

/// Opens, parses, executes, and renders a SQLite target.
pub fn read_path(path: &Path, sub_path: &str, query_string: &str) -> Result<Rendered, Error> {
	let selector = parse_selector(sub_path, query_string)?;
	let connection = open_read_only(path)?;
	render_selector(&connection, &selector)
}

/// Opens, executes, and renders a SQLite target with cross-thread interruption.
pub fn read_interruptible(
	path: &Path,
	authored_target: &str,
	interrupt: Arc<QueryInterrupt>,
) -> Result<Rendered, Error> {
	let candidate = parse_path_candidates(authored_target)
		.into_iter()
		.next()
		.ok_or_else(|| Error(format!("SQLite path target '{authored_target}' is invalid")))?;
	let selector = parse_selector(&candidate.sub_path, &candidate.query_string)?;
	let connection = open_read_only(path)?;
	interrupt.install(&connection)?;
	if interrupt.is_interrupted() {
		return Err(Error("interrupted".into()));
	}
	render_selector(&connection, &selector)
}

/// Parses an authored database target, then reads it from the resolved path.
///
/// The authored target supplies the `:table[:key]` and `?query` suffix while
/// `path` remains the resource-owned, resolved database path.
pub fn read(path: &Path, authored_target: &str) -> Result<Rendered, Error> {
	let candidate = parse_path_candidates(authored_target)
		.into_iter()
		.next()
		.ok_or_else(|| Error(format!("SQLite path target '{authored_target}' is invalid")))?;
	read_path(path, &candidate.sub_path, &candidate.query_string)
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	#[test]
	fn opens_clean_wal_database_without_sidecars_as_query_only() {
		let directory = tempfile::tempdir().unwrap();
		let path = directory.path().join("clean.sqlite");
		let writer = Connection::open(&path).unwrap();
		writer.pragma_update(None, "journal_mode", "WAL").unwrap();
		writer
			.execute_batch("CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('kept');")
			.unwrap();
		drop(writer);

		assert_eq!(&fs::read(&path).unwrap()[18..20], &[2, 2]);
		let _ = fs::remove_file(sidecar_path(&path, "-wal"));
		let _ = fs::remove_file(sidecar_path(&path, "-shm"));

		let reader = open_read_only(&path).unwrap();
		let value: String = reader
			.query_row("SELECT value FROM records", [], |row| row.get(0))
			.unwrap();
		assert_eq!(value, "kept");
		assert!(
			reader
				.pragma_query_value(None, "query_only", |row| row.get::<_, bool>(0))
				.unwrap()
		);
		assert!(
			reader
				.execute("INSERT INTO records VALUES ('changed')", [])
				.is_err()
		);
	}
}
