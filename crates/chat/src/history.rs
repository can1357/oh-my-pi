//! Durable, searchable prompt history shared by chat actors.
//!
//! Prompt history is not a second session transcript: each normalized prompt
//! appears once and carries only the project and session of its latest
//! submission. Session bodies remain authoritative in `omp-session`.

use std::{
	fs,
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use omp_core::{FastHashMap, FastHashSet, Str};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension as _, Transaction, params};
use thiserror::Error;

/// Maximum rows retained in the durable prompt index.
pub const HISTORY_CAPACITY: usize = 10_000;
/// Maximum rows returned by one history query.
pub const HISTORY_QUERY_LIMIT: usize = 1_000;
const HISTORY_DATA_VERSION: i64 = 2;

const HISTORY_TABLE_DDL: &str = "
CREATE TABLE IF NOT EXISTS history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 prompt TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
 cwd TEXT,
 session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC, id DESC);
";

const HISTORY_INDEX_DDL: &str = "
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts
 USING fts5(prompt, content='history', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
 INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
 INSERT INTO history_fts(history_fts, rowid, prompt) VALUES ('delete', old.id, old.prompt);
END;
CREATE TRIGGER IF NOT EXISTS history_au AFTER UPDATE ON history BEGIN
 INSERT INTO history_fts(history_fts, rowid, prompt) VALUES ('delete', old.id, old.prompt);
 INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
";

/// One unique prompt and the provenance of its latest submission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryEntry {
	/// Stable SQLite row identifier.
	pub id:         i64,
	/// Canonical prompt text.
	pub prompt:     Str,
	/// Unix timestamp in seconds of the latest submission.
	pub created_at: i64,
	/// Canonical project directory of the latest submission.
	pub cwd:        Option<PathBuf>,
	/// Journal stem of the latest originating session.
	pub session_id: Option<Str>,
}

/// Prompt-history open, migration, or query failure.
#[derive(Debug, Error)]
pub enum HistoryError {
	/// The history database's parent directory could not be created.
	#[error("failed to create the prompt-history directory")]
	CreateDirectory {
		/// Underlying filesystem failure.
		#[source]
		source: std::io::Error,
	},
	/// A SQLite operation failed.
	#[error("prompt-history database operation failed")]
	Database(#[from] rusqlite::Error),
	/// The system clock is before the Unix epoch.
	#[error("system clock precedes the Unix epoch")]
	Clock(#[from] std::time::SystemTimeError),
}

/// Thread-safe SQLite prompt history.
///
/// Opening performs one dump-and-rebuild migration for legacy schemas,
/// including missing `session_id`, `unixepoch()` defaults, duplicate rows,
/// and terminal-padded multiline prompts.
pub struct HistoryStorage {
	connection: Mutex<Connection>,
}

impl HistoryStorage {
	/// Opens or creates `path`, migrating legacy schemas without discarding
	/// rows.
	pub fn open(path: impl AsRef<Path>) -> Result<Self, HistoryError> {
		let path = path.as_ref();
		if let Some(parent) = path
			.parent()
			.filter(|parent| !parent.as_os_str().is_empty())
		{
			fs::create_dir_all(parent).map_err(|source| HistoryError::CreateDirectory { source })?;
		}
		let mut connection = Connection::open(path)?;
		connection.busy_timeout(std::time::Duration::from_secs(2))?;
		connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
		migrate(&mut connection)?;
		Ok(Self { connection: Mutex::new(connection) })
	}

	/// Stores a prompt durably, replacing provenance with the latest submission.
	///
	/// Blank text and secret-bearing command lines are rejected before SQLite is
	/// touched. The durable table is capped after every accepted write.
	pub fn add(
		&self,
		prompt: &str,
		cwd: Option<&Path>,
		session_id: Option<&str>,
	) -> Result<bool, HistoryError> {
		let prompt = normalize_prompt(prompt);
		if prompt.is_empty() || crate::composer::should_skip_history(prompt.trim_start()) {
			return Ok(false);
		}
		let created_at =
			i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()).unwrap_or(i64::MAX);
		let cwd = cwd.map(|path| path.to_string_lossy());
		let session_id = session_id.filter(|id| !id.is_empty());
		let mut connection = self.connection.lock();
		let transaction = connection.transaction()?;
		transaction.execute(
			"INSERT INTO history(prompt, created_at, cwd, session_id)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(prompt) DO UPDATE SET
			   created_at=excluded.created_at,
			   cwd=excluded.cwd,
			   session_id=excluded.session_id",
			params![prompt, created_at, cwd.as_deref(), session_id],
		)?;
		cap(&transaction)?;
		transaction.commit()?;
		Ok(true)
	}

	/// Returns unique prompts newest first.
	pub fn recent(&self, limit: usize) -> Result<Vec<HistoryEntry>, HistoryError> {
		let limit = normalize_limit(limit);
		if limit == 0 {
			return Ok(Vec::new());
		}
		let connection = self.connection.lock();
		let mut statement = connection.prepare(
			"SELECT id, prompt, created_at, cwd, session_id
			 FROM history ORDER BY created_at DESC, id DESC LIMIT ?1",
		)?;
		rows(&mut statement, params![limit as i64])
	}

	/// Finds prompts containing every alphanumeric query token, newest first.
	///
	/// FTS prefix results are merged with literal substring matches so
	/// punctuation and infix queries (`git-commit`, `mit`) behave consistently.
	pub fn search(&self, query: &str, limit: usize) -> Result<Vec<HistoryEntry>, HistoryError> {
		let limit = normalize_limit(limit);
		let tokens = query_tokens(query);
		if limit == 0 || tokens.is_empty() {
			return Ok(Vec::new());
		}
		let connection = self.connection.lock();
		let fts_query = tokens
			.iter()
			.map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
			.collect::<Vec<_>>()
			.join(" ");
		let mut matches = FastHashMap::<i64, HistoryEntry>::default();
		let mut fts = connection.prepare(
			"SELECT h.id, h.prompt, h.created_at, h.cwd, h.session_id
			 FROM history_fts f JOIN history h ON h.id=f.rowid
			 WHERE history_fts MATCH ?1
			 ORDER BY h.created_at DESC, h.id DESC LIMIT ?2",
		)?;
		for entry in rows(&mut fts, params![fts_query, limit as i64])? {
			matches.insert(entry.id, entry);
		}

		let where_clause =
			std::iter::repeat_n("prompt LIKE ? ESCAPE '\\' COLLATE NOCASE", tokens.len())
				.collect::<Vec<_>>()
				.join(" AND ");
		let sql = format!(
			"SELECT id, prompt, created_at, cwd, session_id FROM history
			 WHERE {where_clause} ORDER BY created_at DESC, id DESC LIMIT ?"
		);
		let mut values = tokens
			.iter()
			.map(|token| rusqlite::types::Value::Text(format!("%{}%", escape_like(token))))
			.collect::<Vec<_>>();
		values.push(rusqlite::types::Value::Integer(limit as i64));
		let mut substring = connection.prepare(&sql)?;
		let mapped = substring.query_map(rusqlite::params_from_iter(values), map_row)?;
		for row in mapped {
			let entry = row?;
			matches.entry(entry.id).or_insert(entry);
		}

		let mut matches = matches.into_values().collect::<Vec<_>>();
		matches.sort_by(|a, b| {
			b.created_at
				.cmp(&a.created_at)
				.then_with(|| b.id.cmp(&a.id))
		});
		matches.truncate(limit);
		Ok(matches)
	}

	/// Returns matching session IDs in prompt-recency order, without duplicates.
	pub fn matching_session_ids(&self, query: &str, limit: usize) -> Result<Vec<Str>, HistoryError> {
		let mut seen = FastHashSet::<Str>::default();
		let mut ids = Vec::new();
		for entry in self.search(query, limit)? {
			let Some(id) = entry.session_id else {
				continue;
			};
			if seen.insert(id.clone()) {
				ids.push(id);
			}
		}
		Ok(ids)
	}
}

fn migrate(connection: &mut Connection) -> Result<(), HistoryError> {
	let exists = connection
		.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history'", [], |row| {
			row.get::<_, i64>(0)
		})
		.optional()?
		.is_some();
	if !exists {
		connection.execute_batch(HISTORY_TABLE_DDL)?;
		connection.pragma_update(None, "user_version", HISTORY_DATA_VERSION)?;
		connection.execute_batch(HISTORY_INDEX_DDL)?;
		connection.execute("INSERT INTO history_fts(history_fts) VALUES('rebuild')", [])?;
		return Ok(());
	}

	let version = connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
	if version < HISTORY_DATA_VERSION {
		rebuild(connection)?;
	}
	connection.execute_batch(
		"DROP TRIGGER IF EXISTS history_ai;
		 DROP TRIGGER IF EXISTS history_ad;
		 DROP TRIGGER IF EXISTS history_au;
		 DROP TABLE IF EXISTS history_fts;",
	)?;
	connection.execute_batch(HISTORY_INDEX_DDL)?;
	connection.execute("INSERT INTO history_fts(history_fts) VALUES('rebuild')", [])?;
	Ok(())
}

fn rebuild(connection: &mut Connection) -> Result<(), HistoryError> {
	let columns = {
		let mut statement = connection.prepare("PRAGMA table_info(history)")?;
		statement
			.query_map([], |row| row.get::<_, String>(1))?
			.collect::<Result<FastHashSet<_>, _>>()?
	};
	let id = if columns.contains("id") {
		"id"
	} else {
		"rowid AS id"
	};
	let created = if columns.contains("created_at") {
		"created_at"
	} else {
		"0 AS created_at"
	};
	let cwd = if columns.contains("cwd") {
		"cwd"
	} else {
		"NULL AS cwd"
	};
	let session = if columns.contains("session_id") {
		"session_id"
	} else {
		"NULL AS session_id"
	};
	let sql = format!("SELECT {id}, prompt, {created}, {cwd}, {session} FROM history");
	let legacy = {
		let mut statement = connection.prepare(&sql)?;
		rows(&mut statement, rusqlite::params![])?
	};
	let mut winners = FastHashMap::<Str, HistoryEntry>::default();
	for mut entry in legacy {
		let normalized = Str::new(normalize_prompt(entry.prompt.as_str()));
		if normalized.is_empty() {
			continue;
		}
		entry.prompt = normalized.clone();
		let wins = winners.get(&normalized).is_none_or(|incumbent| {
			(entry.created_at, entry.id) > (incumbent.created_at, incumbent.id)
		});
		if wins {
			winners.insert(normalized, entry);
		}
	}
	let transaction = connection.transaction()?;
	transaction.execute_batch(
		"DROP INDEX IF EXISTS idx_history_created_at;
		 DROP TRIGGER IF EXISTS history_ai;
		 DROP TRIGGER IF EXISTS history_ad;
		 DROP TRIGGER IF EXISTS history_au;
		 DROP TABLE IF EXISTS history_fts;
		 DROP TABLE history;",
	)?;
	transaction.execute_batch(HISTORY_TABLE_DDL)?;
	{
		let mut insert = transaction.prepare(
			"INSERT INTO history(id, prompt, created_at, cwd, session_id)
			 VALUES (?1, ?2, ?3, ?4, ?5)",
		)?;
		for entry in winners.into_values() {
			let cwd = entry.cwd.as_ref().map(|path| path.to_string_lossy());
			insert.execute(params![
				entry.id,
				entry.prompt.as_str(),
				entry.created_at,
				cwd.as_deref(),
				entry.session_id.as_deref(),
			])?;
		}
	}
	cap(&transaction)?;
	transaction.pragma_update(None, "user_version", HISTORY_DATA_VERSION)?;
	transaction.commit()?;
	Ok(())
}

fn cap(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
	transaction.execute(
		"DELETE FROM history WHERE id NOT IN (
		 SELECT id FROM history ORDER BY created_at DESC, id DESC LIMIT ?1
		)",
		[HISTORY_CAPACITY as i64],
	)?;
	Ok(())
}

fn rows(
	statement: &mut rusqlite::Statement<'_>,
	params: impl rusqlite::Params,
) -> Result<Vec<HistoryEntry>, HistoryError> {
	statement
		.query_map(params, map_row)?
		.collect::<Result<Vec<_>, _>>()
		.map_err(HistoryError::from)
}

fn map_row(row: &rusqlite::Row<'_>) -> Result<HistoryEntry, rusqlite::Error> {
	Ok(HistoryEntry {
		id:         row.get(0)?,
		prompt:     Str::new(row.get::<_, String>(1)?),
		created_at: row.get(2)?,
		cwd:        row.get::<_, Option<String>>(3)?.map(PathBuf::from),
		session_id: row
			.get::<_, Option<String>>(4)?
			.filter(|id| !id.is_empty())
			.map(Str::new),
	})
}

fn normalize_limit(limit: usize) -> usize {
	limit.min(HISTORY_QUERY_LIMIT)
}

fn query_tokens(query: &str) -> Vec<String> {
	query
		.split(|character: char| !character.is_alphanumeric())
		.filter(|token| !token.is_empty())
		.map(str::to_lowercase)
		.collect()
}

fn escape_like(text: &str) -> String {
	let mut escaped = String::with_capacity(text.len());
	for character in text.chars() {
		if matches!(character, '\\' | '%' | '_') {
			escaped.push('\\');
		}
		escaped.push(character);
	}
	escaped
}

fn normalize_prompt(prompt: &str) -> String {
	let normalized = prompt.replace("\r\n", "\n").replace('\r', "\n");
	let mut output = String::with_capacity(normalized.len());
	for (index, line) in normalized.split('\n').enumerate() {
		if index > 0 {
			output.push('\n');
		}
		output.push_str(line.trim_end());
	}
	output.trim().to_owned()
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use super::*;

	fn storage() -> (tempfile::TempDir, HistoryStorage) {
		let dir = tempfile::tempdir().unwrap();
		let storage = HistoryStorage::open(dir.path().join("history.db")).unwrap();
		(dir, storage)
	}

	#[test]
	fn normalizes_deduplicates_and_keeps_latest_provenance() {
		let (_dir, storage) = storage();
		storage
			.add(" line one   \r\nline two  ", Some(Path::new("/old")), Some("old"))
			.unwrap();
		storage
			.add("line one\nline two", Some(Path::new("/new")), Some("new"))
			.unwrap();
		let rows = storage.recent(10).unwrap();
		assert_eq!(rows.len(), 1);
		assert_eq!(rows[0].prompt, "line one\nline two");
		assert_eq!(rows[0].cwd.as_deref(), Some(Path::new("/new")));
		assert_eq!(rows[0].session_id.as_deref(), Some("new"));
	}

	#[test]
	fn committed_rows_survive_reopen() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("history.db");
		let storage = HistoryStorage::open(&path).unwrap();
		storage
			.add("durable prompt", Some(Path::new("/repo")), Some("session"))
			.unwrap();
		drop(storage);
		let reopened = HistoryStorage::open(&path).unwrap();
		let row = reopened.recent(1).unwrap().pop().unwrap();
		assert_eq!(row.prompt, "durable prompt");
		assert_eq!(row.cwd.as_deref(), Some(Path::new("/repo")));
		assert_eq!(row.session_id.as_deref(), Some("session"));
	}

	#[test]
	fn query_merges_prefix_and_infix_matches_in_recency_order() {
		let (_dir, storage) = storage();
		storage
			.add("commit the changes", None, Some("one"))
			.unwrap();
		storage
			.add("precommit hook fix", None, Some("two"))
			.unwrap();
		let rows = storage.search("commit", 10).unwrap();
		assert_eq!(
			rows
				.iter()
				.map(|row| row.prompt.as_str())
				.collect::<Vec<_>>(),
			["precommit hook fix", "commit the changes",]
		);
		assert_eq!(storage.search("git-commit", 10).unwrap(), Vec::new());
		storage
			.add("run git commit --amend", None, Some("three"))
			.unwrap();
		assert_eq!(
			storage.search("git-commit", 10).unwrap()[0]
				.session_id
				.as_deref(),
			Some("three")
		);
	}

	#[test]
	fn matching_session_ids_are_ranked_and_deduplicated() {
		let (_dir, storage) = storage();
		storage
			.add("deploy alpha", Some(Path::new("/repo")), Some("one"))
			.unwrap();
		storage
			.add("deploy beta", Some(Path::new("/repo")), Some("one"))
			.unwrap();
		storage
			.add("deploy gamma", Some(Path::new("/repo")), Some("two"))
			.unwrap();
		storage
			.add("deploy orphan", Some(Path::new("/repo")), None)
			.unwrap();
		assert_eq!(storage.matching_session_ids("deploy", 100).unwrap(), [
			Str::new_static("two"),
			Str::new_static("one")
		]);
	}

	#[test]
	fn migration_collapses_legacy_rows_and_adds_session_metadata() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("history.db");
		let connection = Connection::open(&path).unwrap();
		connection
			.execute_batch(
				"CREATE TABLE history (
				 id INTEGER PRIMARY KEY AUTOINCREMENT,
				 prompt TEXT NOT NULL,
				 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				 cwd TEXT
				);",
			)
			.unwrap();
		connection
			.execute("INSERT INTO history(prompt, created_at, cwd) VALUES (?1, 1, '/old')", [
				"same   \nline",
			])
			.unwrap();
		connection
			.execute("INSERT INTO history(prompt, created_at, cwd) VALUES (?1, 2, '/new')", [
				"same\nline",
			])
			.unwrap();
		drop(connection);
		let storage = HistoryStorage::open(&path).unwrap();
		let rows = storage.recent(10).unwrap();
		assert_eq!(rows.len(), 1);
		assert_eq!(rows[0].id, 2);
		assert_eq!(rows[0].cwd.as_deref(), Some(Path::new("/new")));
		assert_eq!(rows[0].session_id, None);
		storage.add("new", None, Some("session")).unwrap();
		assert_eq!(storage.search("new", 1).unwrap()[0].session_id.as_deref(), Some("session"));
	}

	#[test]
	fn durable_history_is_capped_by_recency() {
		let (_dir, storage) = storage();
		let mut connection = storage.connection.lock();
		let transaction = connection.transaction().unwrap();
		transaction
			.execute_batch(
				"WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))
				 INSERT INTO history(prompt, created_at)
				 SELECT 'prompt-' || (a.d*1000+b.d*100+c.d*10+d.d),
				        a.d*1000+b.d*100+c.d*10+d.d
				 FROM digits a, digits b, digits c, digits d;
				 INSERT INTO history(prompt, created_at) VALUES('prompt-10000', 10000);",
			)
			.unwrap();
		cap(&transaction).unwrap();
		transaction.commit().unwrap();
		let count = connection
			.query_row("SELECT count(*) FROM history", [], |row| row.get::<_, i64>(0))
			.unwrap();
		assert_eq!(count, HISTORY_CAPACITY as i64);
		let oldest = connection
			.query_row("SELECT 1 FROM history WHERE prompt='prompt-0'", [], |row| row.get::<_, i64>(0))
			.optional()
			.unwrap();
		assert_eq!(oldest, None);
	}

	#[test]
	fn privacy_filter_is_enforced_at_the_storage_boundary() {
		let (_dir, storage) = storage();
		for secret in ["/login raw-code", "/join omp://share/key", "/mcp add server --token bearer"] {
			assert!(!storage.add(secret, None, Some("session")).unwrap());
		}
		assert!(storage.add("/login", None, Some("session")).unwrap());
		assert_eq!(storage.recent(10).unwrap().len(), 1);
	}
}
