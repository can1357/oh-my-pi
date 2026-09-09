//! Archive-member and SQLite-row mutation contracts shared by the write tool
//! and the app-owned filesystem adapter.

use std::{
	fmt::Display,
	io::{Read, Seek, Write},
	iter,
	path::Path,
	time,
};

use omp_ar::{Archive, Format, tar::Writer as TarWriter, zip::Writer as ZipWriter};
use omp_core::{IntoStr, Str};
use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde_json::{Map, Value};

use super::{WriteDisposition, WriteOperation};
use crate::read::{
	archive,
	archive::{ArchiveFormat, parse_archive_path_candidates},
	selector,
	sqlite::{
		Error, RowLookup, parse_path_candidates, resolve_row_lookup, validate_columns, validate_table,
	},
};

/// A model-facing special-write failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct Fault {
	/// Exact model-facing error text.
	pub message: Str,
}

impl Fault {
	fn new(message: impl IntoStr) -> Self {
		Self { message: message.into_str() }
	}
}

/// Common durable truth returned after a special mutation commits.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResultPayload {
	/// Canonical filesystem path of the mutated container.
	pub resolved_path: Str,
	/// Full archive-member or SQLite-row selector shown to the model.
	pub display_path:  Str,
	/// Authored content bytes persisted by the operation.
	pub byte_len:      u64,
	/// Created/overwrote meaning defined by the operation family.
	pub disposition:   WriteDisposition,
	/// Typed operation details used for exact prompt projection.
	pub operation:     WriteOperation,
	/// Special writes record/invalidate snapshots internally but do not expose a
	/// hashline header for their binary container.
	pub snapshot_tag:  Option<Str>,
}

/// Parsed archive member selector, independent of filesystem resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchiveTarget {
	/// Authored archive container path.
	pub archive_path: String,
	/// Normalized member path within the container.
	pub member_path:  String,
}

/// Returns every plausible archive split, longest container path first.
pub fn archive_targets(path: &str) -> Result<Vec<ArchiveTarget>, Fault> {
	parse_archive_path_candidates(path)
		.into_iter()
		.filter(|candidate| candidate.archive_path != path)
		.map(|candidate| {
			Ok(ArchiveTarget {
				archive_path: candidate.archive_path,
				member_path:  normalize_archive_member(&candidate.sub_path)?,
			})
		})
		.collect()
}

/// Normalizes a member write target using traversal and directory guards.
pub fn normalize_archive_member(raw: &str) -> Result<String, Fault> {
	let normalized = raw.replace('\\', "/");
	if normalized.is_empty() {
		return Err(Fault::new("Archive write path must target a file inside the archive"));
	}
	if normalized.ends_with('/') {
		return Err(Fault::new("Archive write path must target a file, not a directory"));
	}
	let mut parts = Vec::new();
	for part in normalized.split('/') {
		if part.is_empty() || part == "." {
			continue;
		}
		if part == ".." {
			return Err(Fault::new("Archive path cannot contain '..'"));
		}
		parts.push(part);
	}
	if parts.is_empty() {
		return Err(Fault::new("Archive write path must target a file inside the archive"));
	}
	Ok(parts.join("/"))
}

/// Rejects an empty archive-member write that is actually addressed like a
/// read selector, unless an existing member has that exact literal spelling.
pub fn empty_archive_selector_misfire(
	target: &str,
	content_is_empty: bool,
	member_exists: bool,
) -> Option<Fault> {
	if !content_is_empty || member_exists {
		return None;
	}
	let split = selector::split_path_and_selector(target);
	let selector = split.selector?;
	Some(Fault::new(format!(
		"write target '{target}' ends with a read-tool selector ':{selector}' and no such file \
		 exists — refusing to create a literal file by that name. If you meant to read it, use \
		 read({{ path: \"{target}\" }}). If you truly intend to create this file, pass its contents \
		 in `content` (a non-empty write is never blocked)."
	)))
}

/// Rebuilds one ZIP with every readable source member except `member`, then
/// appends its replacement.
pub fn rewrite_zip_member<R, W>(
	reader: R,
	writer: W,
	member: &str,
	content: &[u8],
) -> Result<(), Fault>
where
	R: Read + Seek,
	W: Write,
{
	let mut destination = ZipWriter::new(writer);
	rewrite_archive_member(reader, &mut destination, Format::Zip, member, content)?;
	destination.finish().map_err(archive_error)?;
	Ok(())
}

/// Creates a deterministic ZIP containing one UTF-8-addressed member.
pub fn create_zip_member<W>(writer: W, member: &str, content: &[u8]) -> Result<(), Fault>
where
	W: Write,
{
	let mut destination = ZipWriter::new(writer);
	destination
		.add_file(member, content)
		.map_err(archive_error)?;
	destination.finish().map_err(archive_error)?;
	Ok(())
}

/// Rebuilds one TAR with every readable source member except `member`, then
/// appends its replacement.
pub fn rewrite_tar_member<R, W>(
	reader: R,
	writer: W,
	member: &str,
	content: &[u8],
) -> Result<(), Fault>
where
	R: Read + Seek,
	W: Write,
{
	let mut destination = TarWriter::new(writer);
	rewrite_archive_member(reader, &mut destination, Format::Tar, member, content)?;
	destination.finish().map_err(archive_error)?;
	Ok(())
}

/// Creates a deterministic TAR containing one member.
pub fn create_tar_member<W>(writer: W, member: &str, content: &[u8]) -> Result<(), Fault>
where
	W: Write,
{
	let mut destination = TarWriter::new(writer);
	destination
		.add_file(member, content)
		.map_err(archive_error)?;
	destination.finish().map_err(archive_error)?;
	Ok(())
}

trait ArchiveMemberWriter {
	fn add_file(&mut self, path: &str, data: &[u8]) -> omp_ar::Result<()>;

	fn add_directory(&mut self, path: &str) -> omp_ar::Result<()>;
}

impl<W: Write> ArchiveMemberWriter for ZipWriter<W> {
	fn add_file(&mut self, path: &str, data: &[u8]) -> omp_ar::Result<()> {
		Self::add_file(self, path, data)
	}

	fn add_directory(&mut self, path: &str) -> omp_ar::Result<()> {
		Self::add_directory(self, path)
	}
}

impl<W: Write> ArchiveMemberWriter for TarWriter<W> {
	fn add_file(&mut self, path: &str, data: &[u8]) -> omp_ar::Result<()> {
		Self::add_file(self, path, data)
	}

	fn add_directory(&mut self, path: &str) -> omp_ar::Result<()> {
		Self::add_directory(self, path)
	}
}

fn rewrite_archive_member<R, W>(
	reader: R,
	destination: &mut W,
	format: Format,
	member: &str,
	content: &[u8],
) -> Result<(), Fault>
where
	R: Read + Seek,
	W: ArchiveMemberWriter,
{
	let mut source = Archive::with_format(reader, format).map_err(archive_error)?;
	let entries: Vec<_> = source
		.entries()
		.map(|entry| (entry.path().to_owned(), entry.is_directory()))
		.collect();
	for (path, directory) in entries {
		if path == member {
			continue;
		}
		if directory {
			destination.add_directory(&path).map_err(archive_error)?;
		} else {
			let bytes = source.read(&path).map_err(archive_error)?;
			destination.add_file(&path, &bytes).map_err(archive_error)?;
		}
	}
	destination.add_file(member, content).map_err(archive_error)
}

fn archive_error(error: impl Display) -> Fault {
	Fault::new(error.to_string())
}

/// Parsed SQLite table or row target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqliteTarget {
	/// Authored SQLite database path.
	pub sqlite_path: String,
	/// Target table.
	pub table:       String,
	/// Optional primary-key or rowid spelling.
	pub key:         Option<String>,
}

/// Returns every plausible SQLite split, longest database path first.
pub fn sqlite_targets(path: &str) -> Result<Vec<SqliteTarget>, Fault> {
	parse_path_candidates(path)
		.into_iter()
		.filter(|candidate| candidate.sqlite_path.to_string_lossy() != path)
		.map(|candidate| {
			if !candidate.query_string.trim().is_empty() {
				return Err(Fault::new("SQLite write paths do not support query parameters"));
			}
			let normalized = candidate.sub_path.trim_start_matches(':').trim();
			if normalized.is_empty() {
				return Err(Fault::new("SQLite write path must target a table"));
			}
			let (table, key) = normalized
				.split_once(':')
				.map_or((normalized, None), |(table, key)| (table, Some(key)));
			if table.is_empty() {
				return Err(Fault::new("SQLite write path must target a table"));
			}
			if key == Some("") {
				return Err(Fault::new("SQLite row writes require a non-empty row key"));
			}
			Ok(SqliteTarget {
				sqlite_path: candidate.sqlite_path.to_string_lossy().into_owned(),
				table:       table.to_owned(),
				key:         key.map(str::to_owned),
			})
		})
		.collect()
}

/// Typed committed SQLite mutation truth.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqliteMutation {
	/// Mutation kind and affected-row truth.
	pub operation:   WriteOperation,
	/// Whether the mutation creates or overwrites logical state.
	pub disposition: WriteDisposition,
}

/// Applies one insert/update/delete in a transaction. Any validation, binding,
/// constraint, or commit failure rolls back the complete mutation.
pub fn mutate_sqlite_row(
	connection: &mut Connection,
	target: &SqliteTarget,
	content: &str,
) -> Result<SqliteMutation, Fault> {
	connection
		.busy_timeout(time::Duration::from_millis(3_000))
		.map_err(sqlite_error)?;
	let transaction = connection.transaction().map_err(sqlite_error)?;
	let table = validate_table(&transaction, &target.table).map_err(read_sqlite_error)?;
	let result = if content.trim().is_empty() {
		let key = target
			.key
			.as_deref()
			.ok_or_else(|| Fault::new("SQLite deletes require a row key in the path"))?;
		let lookup = resolve_row_lookup(&transaction, &target.table).map_err(read_sqlite_error)?;
		let changed = delete_row(&transaction, &target.table, &lookup, key)?;
		SqliteMutation {
			operation:   WriteOperation::SqliteDelete {
				table:   target.table.clone().into(),
				key:     Str::new(key),
				changed: changed > 0,
			},
			disposition: WriteDisposition::Overwrote,
		}
	} else {
		let parsed: Value = omp_core::slopjson::from_str(content).map_err(|error| {
			Fault::new(format!("SQLite write content must be valid JSON5: {error}"))
		})?;
		let object = parsed
			.as_object()
			.ok_or_else(|| Fault::new("SQLite write content must be a JSON object"))?;
		let columns =
			validate_columns(&table, object.keys().map(String::as_str)).map_err(read_sqlite_error)?;
		let values = bind_values(object, &columns)?;
		if let Some(key) = target.key.as_deref() {
			if columns.is_empty() {
				return Err(Fault::new("SQLite updates require at least one column value"));
			}
			let lookup = resolve_row_lookup(&transaction, &target.table).map_err(read_sqlite_error)?;
			let changed = update_row(&transaction, &target.table, &lookup, key, &columns, values)?;
			SqliteMutation {
				operation:   WriteOperation::SqliteUpdate {
					table:   target.table.clone().into(),
					key:     Str::new(key),
					changed: changed > 0,
				},
				disposition: WriteDisposition::Overwrote,
			}
		} else {
			insert_row(&transaction, &target.table, &columns, values)?;
			SqliteMutation {
				operation:   WriteOperation::SqliteInsert { table: target.table.clone().into() },
				disposition: WriteDisposition::Created,
			}
		}
	};
	transaction.commit().map_err(sqlite_error)?;
	Ok(result)
}

fn bind_values(object: &Map<String, Value>, columns: &[String]) -> Result<Vec<SqlValue>, Fault> {
	columns
		.iter()
		.map(|column| json_binding(object.get(column).expect("validated object column"), column))
		.collect()
}

fn json_binding(value: &Value, column: &str) -> Result<SqlValue, Fault> {
	match value {
		Value::Null => Ok(SqlValue::Null),
		Value::Bool(value) => Ok(SqlValue::Integer(i64::from(*value))),
		Value::String(value) => Ok(SqlValue::Text(value.clone())),
		Value::Number(value) => {
			if let Some(value) = value.as_i64() {
				Ok(SqlValue::Integer(value))
			} else if let Some(value) = value.as_u64().and_then(|value| i64::try_from(value).ok()) {
				Ok(SqlValue::Integer(value))
			} else if let Some(value) = value.as_f64() {
				Ok(SqlValue::Real(value))
			} else {
				Err(Fault::new(format!(
					"SQLite column '{column}' only accepts JSON scalar values or null"
				)))
			}
		},
		Value::Array(_) | Value::Object(_) => Err(Fault::new(format!(
			"SQLite column '{column}' only accepts JSON scalar values or null"
		))),
	}
}

fn insert_row(
	connection: &Connection,
	table: &str,
	columns: &[String],
	values: Vec<SqlValue>,
) -> Result<(), Fault> {
	if columns.is_empty() {
		connection
			.execute(&format!("INSERT INTO {} DEFAULT VALUES", quote(table)), [])
			.map_err(sqlite_error)?;
		return Ok(());
	}
	let names = columns
		.iter()
		.map(|column| quote(column))
		.collect::<Vec<_>>()
		.join(", ");
	let placeholders = iter::repeat_n("?", columns.len())
		.collect::<Vec<_>>()
		.join(", ");
	connection
		.execute(
			&format!("INSERT INTO {} ({names}) VALUES ({placeholders})", quote(table)),
			params_from_iter(values),
		)
		.map_err(sqlite_error)?;
	Ok(())
}

fn update_row(
	connection: &Connection,
	table: &str,
	lookup: &RowLookup,
	key: &str,
	columns: &[String],
	mut values: Vec<SqlValue>,
) -> Result<usize, Fault> {
	let assignments = columns
		.iter()
		.map(|column| format!("{} = ?", quote(column)))
		.collect::<Vec<_>>()
		.join(", ");
	let (predicate, binding) = lookup_predicate(lookup, key)?;
	values.push(binding);
	connection
		.execute(
			&format!("UPDATE {} SET {assignments} WHERE {predicate} = ?", quote(table)),
			params_from_iter(values),
		)
		.map_err(sqlite_error)
}

fn delete_row(
	connection: &Connection,
	table: &str,
	lookup: &RowLookup,
	key: &str,
) -> Result<usize, Fault> {
	let (predicate, binding) = lookup_predicate(lookup, key)?;
	connection
		.execute(&format!("DELETE FROM {} WHERE {predicate} = ?", quote(table)), [binding])
		.map_err(sqlite_error)
}

fn lookup_predicate(lookup: &RowLookup, key: &str) -> Result<(String, SqlValue), Fault> {
	match lookup {
		RowLookup::PrimaryKey { column, declared_type } => {
			Ok((quote(column), coerce_key(key, declared_type, &format!("Primary key '{key}'"))?))
		},
		RowLookup::RowId => Ok(("rowid".to_owned(), coerce_integer_key(key, "SQLite ROWID")?)),
	}
}

fn coerce_key(key: &str, declared_type: &str, integer_label: &str) -> Result<SqlValue, Fault> {
	let upper = declared_type.trim().to_ascii_uppercase();
	if upper.contains("INT") {
		return coerce_integer_key(key, integer_label);
	}
	if (upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB"))
		&& let Ok(value) = key.parse::<f64>()
		&& value.is_finite()
	{
		return Ok(SqlValue::Real(value));
	}
	Ok(SqlValue::Text(key.to_owned()))
}

fn coerce_integer_key(key: &str, label: &str) -> Result<SqlValue, Fault> {
	let trimmed = key.trim();
	if trimmed.is_empty()
		|| !trimmed
			.bytes()
			.enumerate()
			.all(|(index, byte)| byte.is_ascii_digit() || (index == 0 && byte == b'-'))
	{
		return Err(Fault::new(format!("{label} must be an integer; got '{key}'")));
	}
	trimmed
		.parse::<i64>()
		.map(SqlValue::Integer)
		.map_err(|_| Fault::new(format!("{label} must be an integer; got '{key}'")))
}

fn quote(identifier: &str) -> String {
	format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn read_sqlite_error(error: Error) -> Fault {
	Fault::new(error.to_string())
}

fn sqlite_error(error: rusqlite::Error) -> Fault {
	Fault::new(error.to_string())
}

/// Returns the expected container format for a resolved archive path.
pub fn format_for_path(path: &Path) -> ArchiveFormat {
	archive::archive_format_from_path(path).unwrap_or(ArchiveFormat::Tar)
}

#[cfg(test)]
mod tests {
	use std::io::Cursor;

	use omp_ar::Archive;

	use super::*;

	#[test]
	fn write_selector_routing_uses_the_shared_archive_registry() {
		for (authored, archive, member) in [
			("bundle.tar.zst:src/lib.rs", "bundle.tar.zst", "src/lib.rs"),
			("package.deb:control", "package.deb", "control"),
			("payload.7z:docs/readme.txt", "payload.7z", "docs/readme.txt"),
		] {
			let target = archive_targets(authored).unwrap().remove(0);
			assert_eq!(target.archive_path, archive);
			assert_eq!(target.member_path, member);
		}
	}

	#[test]
	fn zip_rewrite_preserves_other_members_and_rejects_invalid_sources() {
		let mut source = Cursor::new(Vec::new());
		create_zip_member(&mut source, "keep.txt", b"keep").unwrap();
		let mut with_two = Cursor::new(Vec::new());
		rewrite_zip_member(Cursor::new(source.into_inner()), &mut with_two, "change.txt", b"old")
			.unwrap();
		let original = with_two.into_inner();
		let mut changed = Cursor::new(Vec::new());
		rewrite_zip_member(Cursor::new(original), &mut changed, "change.txt", b"new").unwrap();
		let changed = changed.into_inner();
		let mut archive = Archive::from_bytes(&changed).unwrap();
		assert_eq!(archive.read("keep.txt").unwrap(), b"keep");
		assert_eq!(archive.read("change.txt").unwrap(), b"new");

		assert!(
			rewrite_zip_member(Cursor::new(b"not zip"), Cursor::new(Vec::new()), "x", b"y").is_err()
		);
	}

	#[test]
	fn zip_rewrite_accepts_directory_entries_from_the_read_fixture() {
		let source = include_bytes!("../../tests/fixtures/special-sources/archives/bundle.zip");
		let mut original = Archive::from_bytes(source).unwrap();
		assert!(original.entry("dir/member.txt").is_some());
		let root = original.read("root.txt").unwrap();
		let mut changed = Cursor::new(Vec::new());
		rewrite_zip_member(
			Cursor::new(source.as_slice()),
			&mut changed,
			"dir/member.txt",
			b"changed",
		)
		.unwrap();
		let changed = changed.into_inner();
		let mut archive = Archive::from_bytes(&changed).unwrap();
		assert_eq!(archive.read("dir/member.txt").unwrap(), b"changed");
		assert_eq!(archive.read("root.txt").unwrap(), root);
	}

	#[test]
	fn tar_rewrite_preserves_other_member_content() {
		let mut source = Vec::new();
		create_tar_member(&mut source, "keep.txt", b"keep").unwrap();
		let mut with_two = Vec::new();
		rewrite_tar_member(Cursor::new(source), &mut with_two, "change.txt", b"old").unwrap();
		let mut changed = Vec::new();
		rewrite_tar_member(Cursor::new(with_two), &mut changed, "change.txt", b"new").unwrap();
		let mut archive = Archive::from_bytes(&changed).unwrap();
		assert_eq!(archive.read("keep.txt").unwrap(), b"keep");
		assert_eq!(archive.read("change.txt").unwrap(), b"new");
	}

	#[test]
	fn sqlite_mutations_commit_and_validation_failure_rolls_back() {
		let mut db = Connection::open_in_memory().unwrap();
		db.execute_batch(
			"CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE); INSERT INTO item \
			 VALUES (1, 'old');",
		)
		.unwrap();
		let insert =
			SqliteTarget { sqlite_path: "x.db".into(), table: "item".into(), key: None };
		assert_eq!(
			mutate_sqlite_row(&mut db, &insert, "{id: 2, name: 'second',}")
				.unwrap()
				.operation,
			WriteOperation::SqliteInsert { table: "item".into() }
		);
		let update = SqliteTarget { key: Some("1".into()), ..insert.clone() };
		assert_eq!(
			mutate_sqlite_row(&mut db, &update, r#"{"name":"new"}"#)
				.unwrap()
				.operation,
			WriteOperation::SqliteUpdate {
				table:   "item".into(),
				key:     "1".into(),
				changed: true,
			}
		);
		assert!(mutate_sqlite_row(&mut db, &update, r#"{"name":"second"}"#).is_err());
		let name: String = db
			.query_row("SELECT name FROM item WHERE id = 1", [], |row| row.get(0))
			.unwrap();
		assert_eq!(name, "new");
		assert_eq!(
			mutate_sqlite_row(&mut db, &update, "").unwrap().operation,
			WriteOperation::SqliteDelete {
				table:   "item".into(),
				key:     "1".into(),
				changed: true,
			}
		);
	}

	#[test]
	fn archive_empty_selector_guard_preserves_existing_literal_member() {
		let target = "a.zip:src/lib.rs:10-20";
		assert!(empty_archive_selector_misfire(target, true, true).is_none());
		assert!(empty_archive_selector_misfire(target, false, false).is_none());
		assert_eq!(
			empty_archive_selector_misfire(target, true, false)
				.unwrap()
				.to_string(),
			"write target 'a.zip:src/lib.rs:10-20' ends with a read-tool selector ':10-20' and no \
			 such file exists — refusing to create a literal file by that name. If you meant to read \
			 it, use read({ path: \"a.zip:src/lib.rs:10-20\" }). If you truly intend to create this \
			 file, pass its contents in `content` (a non-empty write is never blocked)."
		);
	}

	#[test]
	fn sqlite_selector_and_column_errors_match_pi() {
		assert_eq!(
			sqlite_targets("data.db:items?limit=1")
				.unwrap_err()
				.to_string(),
			"SQLite write paths do not support query parameters"
		);
		assert_eq!(
			sqlite_targets("data.db:").unwrap_err().to_string(),
			"SQLite write path must target a table"
		);
		assert_eq!(
			sqlite_targets("data.db:items:").unwrap_err().to_string(),
			"SQLite row writes require a non-empty row key"
		);

		let mut db = Connection::open_in_memory().unwrap();
		db.execute_batch("CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT);")
			.unwrap();
		let insert =
			SqliteTarget { sqlite_path: "x.db".into(), table: "item".into(), key: None };
		assert_eq!(
			mutate_sqlite_row(&mut db, &insert, "{missing: 1}")
				.unwrap_err()
				.to_string(),
			"SQLite table 'item' has no column named 'missing'"
		);
		let rows: i64 = db
			.query_row("SELECT COUNT(*) FROM item", [], |row| row.get(0))
			.unwrap();
		assert_eq!(rows, 0);
	}
}
