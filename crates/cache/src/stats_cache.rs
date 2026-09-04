//! Rebuildable historical usage index behind `/stats`.
//!
//! Session journals stay authoritative; this SQLite file holds one row per
//! journaled turn receipt and per tool call, keyed by the journal file that
//! produced it, plus a per-file sync cursor so a resync only re-reads
//! journals whose size or mtime changed. The owner of the journal format
//! folds entries into [`MessageRow`]/[`ToolCallRow`]; this module only stores
//! and aggregates them.

use std::path::Path;

use omp_core::Str;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};

/// One journaled turn receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageRow {
	/// Journal entry id of the receipt.
	pub entry_id:      Str,
	/// Project folder the session ran in (journal genesis `cwd`).
	pub folder:        Str,
	/// Model route of the turn's last assistant message.
	pub model:         Str,
	/// Provider of that route.
	pub provider:      Str,
	/// Receipt time in Unix milliseconds.
	pub timestamp_ms:  u64,
	/// Provider requests folded into this receipt.
	pub requests:      u32,
	/// Requests that ended with an error stop reason.
	pub errors:        u32,
	/// Wall duration of the inference, when journaled.
	pub duration_ms:   Option<u64>,
	/// Time to first token, when journaled.
	pub ttft_ms:       Option<u64>,
	/// Input tokens.
	pub input_tokens:  u64,
	/// Output tokens.
	pub output_tokens: u64,
	/// Cache-read tokens.
	pub cache_read:    u64,
	/// Cache-write tokens.
	pub cache_write:   u64,
	/// Cost in nano-USD (`None` when the route is unpriced).
	pub cost_nano_usd: Option<u64>,
}

/// One journaled tool call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolCallRow {
	/// Tool call id.
	pub call_id:      Str,
	/// Project folder the session ran in.
	pub folder:       Str,
	/// Tool name.
	pub tool:         Str,
	/// Call time in Unix milliseconds.
	pub timestamp_ms: u64,
	/// Whether the call settled with a fault.
	pub is_error:     bool,
}

/// Sync cursor for one journal file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileState {
	/// File length in bytes at the last sync.
	pub size:        u64,
	/// File mtime in Unix milliseconds at the last sync.
	pub modified_ms: u64,
}

/// Aggregate over one grouping key (model or folder).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GroupStat {
	/// Model route or folder.
	pub key:           Str,
	/// Requests.
	pub requests:      u64,
	/// Cost in nano-USD over priced requests.
	pub cost_nano_usd: u64,
	/// Requests without a price.
	pub unpriced:      u64,
	/// Input tokens.
	pub input_tokens:  u64,
	/// Output tokens.
	pub output_tokens: u64,
	/// Cache-read tokens.
	pub cache_read:    u64,
	/// Cache-write tokens.
	pub cache_write:   u64,
}

/// Per-tool aggregate.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ToolStat {
	/// Tool name.
	pub tool:   Str,
	/// Calls.
	pub calls:  u64,
	/// Calls that faulted.
	pub errors: u64,
}

/// Everything `/stats` shows, including by-model and by-folder aggregates.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatsSummary {
	/// Journal files indexed.
	pub files:             u64,
	/// Provider requests.
	pub requests:          u64,
	/// Requests that ended in an error.
	pub errors:            u64,
	/// Input tokens.
	pub input_tokens:      u64,
	/// Output tokens.
	pub output_tokens:     u64,
	/// Cache-read tokens.
	pub cache_read:        u64,
	/// Cache-write tokens.
	pub cache_write:       u64,
	/// Cost in nano-USD over priced requests.
	pub cost_nano_usd:     u64,
	/// Requests without a price.
	pub unpriced:          u64,
	/// Mean inference duration over receipts that journaled one.
	pub avg_duration_ms:   Option<u64>,
	/// Mean time to first token over receipts that journaled one.
	pub avg_ttft_ms:       Option<u64>,
	/// Output tokens per second over receipts with a duration.
	pub tokens_per_second: Option<f64>,
	/// Top models by requests.
	pub by_model:          Vec<GroupStat>,
	/// Top folders by requests.
	pub by_folder:         Vec<GroupStat>,
	/// Tool calls by tool, most called first.
	pub tools:             Vec<ToolStat>,
}

/// Stats index failure.
#[derive(Debug, thiserror::Error)]
pub enum StatsError {
	/// SQLite failed.
	#[error("stats database failed")]
	Sqlite(#[from] rusqlite::Error),
	/// The database directory could not be created.
	#[error("stats database directory could not be created")]
	Io(#[from] std::io::Error),
}

/// SQLite-backed usage index.
pub struct StatsIndex {
	database: Mutex<Connection>,
}

impl StatsIndex {
	/// Opens or creates the index at `path`.
	///
	/// # Errors
	/// Returns [`StatsError`] when the file cannot be opened or initialized.
	pub fn open(path: &Path) -> Result<Self, StatsError> {
		if let Some(parent) = path.parent() {
			std::fs::create_dir_all(parent)?;
		}
		let database = Connection::open(path)?;
		Self::init(database)
	}

	/// Opens an in-memory index (tests).
	///
	/// # Errors
	/// Returns [`StatsError`] when SQLite cannot initialize.
	pub fn in_memory() -> Result<Self, StatsError> {
		Self::init(Connection::open_in_memory()?)
	}

	fn init(database: Connection) -> Result<Self, StatsError> {
		database.execute_batch(
			"CREATE TABLE IF NOT EXISTS file_offsets (
				session_file TEXT PRIMARY KEY,
				size INTEGER NOT NULL,
				modified_ms INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS messages (
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				model TEXT NOT NULL,
				provider TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				requests INTEGER NOT NULL,
				errors INTEGER NOT NULL,
				duration INTEGER,
				ttft INTEGER,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				cost_nano_usd INTEGER,
				UNIQUE(session_file, entry_id)
			);
			CREATE INDEX IF NOT EXISTS messages_model ON messages(model);
			CREATE INDEX IF NOT EXISTS messages_folder ON messages(folder);
			CREATE TABLE IF NOT EXISTS tool_calls (
				session_file TEXT NOT NULL,
				tool_call_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				is_error INTEGER NOT NULL,
				UNIQUE(session_file, tool_call_id)
			);
			CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls(tool_name);",
		)?;
		Ok(Self { database: Mutex::new(database) })
	}

	/// The sync cursor recorded for `file`, if it was indexed before.
	///
	/// # Errors
	/// Returns [`StatsError`] on a SQLite failure.
	pub fn file_state(&self, file: &str) -> Result<Option<FileState>, StatsError> {
		Ok(self
			.database
			.lock()
			.query_row(
				"SELECT size, modified_ms FROM file_offsets WHERE session_file = ?1",
				params![file],
				|row| {
					Ok(FileState { size: to_u64(row.get(0)?), modified_ms: to_u64(row.get(1)?) })
				},
			)
			.optional()?)
	}

	/// Replaces every row derived from `file` in one transaction and records
	/// its sync cursor.
	///
	/// # Errors
	/// Returns [`StatsError`] on a SQLite failure; nothing is written then.
	pub fn replace_file(
		&self,
		file: &str,
		state: FileState,
		messages: &[MessageRow],
		tool_calls: &[ToolCallRow],
	) -> Result<(), StatsError> {
		let mut database = self.database.lock();
		let txn = database.transaction()?;
		txn.execute("DELETE FROM messages WHERE session_file = ?1", params![file])?;
		txn.execute("DELETE FROM tool_calls WHERE session_file = ?1", params![file])?;
		{
			let mut insert = txn.prepare(
				"INSERT OR REPLACE INTO messages(session_file, entry_id, folder, model, provider,
				 timestamp, requests, errors, duration, ttft, input_tokens, output_tokens,
				 cache_read_tokens, cache_write_tokens, cost_nano_usd)
				 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
			)?;
			for row in messages {
				insert.execute(params![
					file,
					row.entry_id.as_str(),
					row.folder.as_str(),
					row.model.as_str(),
					row.provider.as_str(),
					to_i64(row.timestamp_ms),
					row.requests,
					row.errors,
					row.duration_ms.map(to_i64),
					row.ttft_ms.map(to_i64),
					to_i64(row.input_tokens),
					to_i64(row.output_tokens),
					to_i64(row.cache_read),
					to_i64(row.cache_write),
					row.cost_nano_usd.map(to_i64),
				])?;
			}
			let mut insert = txn.prepare(
				"INSERT OR REPLACE INTO tool_calls(session_file, tool_call_id, folder, tool_name,
				 timestamp, is_error)
				 VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
			)?;
			for row in tool_calls {
				insert.execute(params![
					file,
					row.call_id.as_str(),
					row.folder.as_str(),
					row.tool.as_str(),
					to_i64(row.timestamp_ms),
					row.is_error,
				])?;
			}
		}
		txn.execute(
			"INSERT OR REPLACE INTO file_offsets(session_file, size, modified_ms) VALUES(?1, ?2, ?3)",
			params![file, to_i64(state.size), to_i64(state.modified_ms)],
		)?;
		txn.commit()?;
		Ok(())
	}

	/// Drops rows for journal files that no longer exist (`keep` lists the
	/// files still on disk).
	///
	/// # Errors
	/// Returns [`StatsError`] on a SQLite failure.
	pub fn retain_files(&self, keep: &[Str]) -> Result<usize, StatsError> {
		let mut database = self.database.lock();
		let txn = database.transaction()?;
		let stale = {
			let mut select = txn.prepare("SELECT session_file FROM file_offsets")?;
			let rows = select.query_map([], |row| row.get::<_, String>(0))?;
			rows
				.filter_map(Result::ok)
				.filter(|file| !keep.iter().any(|kept| kept.as_str() == file))
				.collect::<Vec<_>>()
		};
		for file in &stale {
			txn.execute("DELETE FROM messages WHERE session_file = ?1", params![file])?;
			txn.execute("DELETE FROM tool_calls WHERE session_file = ?1", params![file])?;
			txn.execute("DELETE FROM file_offsets WHERE session_file = ?1", params![file])?;
		}
		txn.commit()?;
		Ok(stale.len())
	}

	/// Aggregates every indexed row; groups list the top `limit` keys by
	/// requests.
	///
	/// # Errors
	/// Returns [`StatsError`] on a SQLite failure.
	pub fn summary(&self, limit: usize) -> Result<StatsSummary, StatsError> {
		let database = self.database.lock();
		let files =
			database.query_row("SELECT COUNT(*) FROM file_offsets", [], |row| row.get::<_, i64>(0))?;
		let (requests, errors, input, output, cache_read, cache_write, cost, unpriced) = database
			.query_row(
				"SELECT COALESCE(SUM(requests), 0), COALESCE(SUM(errors), 0),
				 COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
				 COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0),
				 COALESCE(SUM(cost_nano_usd), 0),
				 COALESCE(SUM(CASE WHEN cost_nano_usd IS NULL THEN requests ELSE 0 END), 0)
				 FROM messages",
				[],
				|row| {
					Ok((
						row.get::<_, i64>(0)?,
						row.get::<_, i64>(1)?,
						row.get::<_, i64>(2)?,
						row.get::<_, i64>(3)?,
						row.get::<_, i64>(4)?,
						row.get::<_, i64>(5)?,
						row.get::<_, i64>(6)?,
						row.get::<_, i64>(7)?,
					))
				},
			)?;
		let avg_duration_ms = database
			.query_row("SELECT AVG(duration) FROM messages WHERE duration IS NOT NULL", [], |row| {
				row.get::<_, Option<f64>>(0)
			})?
			.map(round_u64);
		let avg_ttft_ms = database
			.query_row("SELECT AVG(ttft) FROM messages WHERE ttft IS NOT NULL", [], |row| {
				row.get::<_, Option<f64>>(0)
			})?
			.map(round_u64);
		let tokens_per_second = database
			.query_row(
				"SELECT SUM(output_tokens), SUM(duration) FROM messages
				 WHERE duration IS NOT NULL AND duration > 0",
				[],
				|row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
			)
			.map(|(tokens, duration)| match (tokens, duration) {
				(Some(tokens), Some(duration)) if duration > 0 =>
				{
					#[expect(clippy::cast_precision_loss, reason = "display precision suffices")]
					Some(tokens as f64 * 1000.0 / duration as f64)
				},
				_ => None,
			})?;
		let by_model = group_stats(&database, "model", limit)?;
		let by_folder = group_stats(&database, "folder", limit)?;
		let tools = {
			let mut select = database.prepare(
				"SELECT tool_name, COUNT(*), SUM(is_error) FROM tool_calls
				 GROUP BY tool_name ORDER BY COUNT(*) DESC, tool_name ASC",
			)?;
			let rows = select.query_map([], |row| {
				Ok(ToolStat {
					tool:   Str::new(row.get::<_, String>(0)?),
					calls:  to_u64(row.get(1)?),
					errors: to_u64(row.get(2)?),
				})
			})?;
			rows.collect::<Result<Vec<_>, _>>()?
		};
		Ok(StatsSummary {
			files: to_u64(files),
			requests: to_u64(requests),
			errors: to_u64(errors),
			input_tokens: to_u64(input),
			output_tokens: to_u64(output),
			cache_read: to_u64(cache_read),
			cache_write: to_u64(cache_write),
			cost_nano_usd: to_u64(cost),
			unpriced: to_u64(unpriced),
			avg_duration_ms,
			avg_ttft_ms,
			tokens_per_second,
			by_model,
			by_folder,
			tools,
		})
	}
}

fn group_stats(
	database: &Connection,
	column: &str,
	limit: usize,
) -> Result<Vec<GroupStat>, StatsError> {
	// `column` is one of two literals chosen by this module, never user text.
	let sql = format!(
		"SELECT {column}, SUM(requests), COALESCE(SUM(cost_nano_usd), 0),
		 COALESCE(SUM(CASE WHEN cost_nano_usd IS NULL THEN requests ELSE 0 END), 0),
		 SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens)
		 FROM messages GROUP BY {column} ORDER BY SUM(requests) DESC, {column} ASC LIMIT ?1"
	);
	let mut select = database.prepare(&sql)?;
	let rows = select.query_map(params![i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
		Ok(GroupStat {
			key:           Str::new(row.get::<_, String>(0)?),
			requests:      to_u64(row.get(1)?),
			cost_nano_usd: to_u64(row.get(2)?),
			unpriced:      to_u64(row.get(3)?),
			input_tokens:  to_u64(row.get(4)?),
			output_tokens: to_u64(row.get(5)?),
			cache_read:    to_u64(row.get(6)?),
			cache_write:   to_u64(row.get(7)?),
		})
	})?;
	Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn to_i64(value: u64) -> i64 {
	i64::try_from(value).unwrap_or(i64::MAX)
}

fn to_u64(value: i64) -> u64 {
	u64::try_from(value).unwrap_or(0)
}

const fn round_u64(value: f64) -> u64 {
	#[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "rounded average")]
	{
		value.round().max(0.0) as u64
	}
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	fn message(entry: &str, model: &str, folder: &str, cost: Option<u64>) -> MessageRow {
		MessageRow {
			entry_id:      sf!("{entry}"),
			folder:        Str::new(folder),
			model:         Str::new(model),
			provider:      Str::new_static("anthropic"),
			timestamp_ms:  1,
			requests:      2,
			errors:        1,
			duration_ms:   Some(2_000),
			ttft_ms:       Some(500),
			input_tokens:  100,
			output_tokens: 40,
			cache_read:    10,
			cache_write:   5,
			cost_nano_usd: cost,
		}
	}

	#[test]
	fn replace_file_is_idempotent_and_summary_folds_groups() {
		let index = StatsIndex::in_memory().unwrap();
		let state = FileState { size: 10, modified_ms: 5 };
		let rows = [
			message("a", "anthropic/sonnet", "/work/x", Some(1_000)),
			message("b", "openai/gpt", "/work/y", None),
		];
		let calls = [
			ToolCallRow {
				call_id:      sf!("c1"),
				folder:       sf!("/work/x"),
				tool:         sf!("read"),
				timestamp_ms: 1,
				is_error:     false,
			},
			ToolCallRow {
				call_id:      sf!("c2"),
				folder:       sf!("/work/x"),
				tool:         sf!("read"),
				timestamp_ms: 2,
				is_error:     true,
			},
		];
		index.replace_file("s1.oms", state, &rows, &calls).unwrap();
		index.replace_file("s1.oms", state, &rows, &calls).unwrap();
		assert_eq!(index.file_state("s1.oms").unwrap(), Some(state));
		let summary = index.summary(10).unwrap();
		assert_eq!(summary.files, 1);
		assert_eq!(summary.requests, 4);
		assert_eq!(summary.errors, 2);
		assert_eq!(summary.input_tokens, 200);
		assert_eq!(summary.cost_nano_usd, 1_000);
		assert_eq!(summary.unpriced, 2);
		assert_eq!(summary.avg_duration_ms, Some(2_000));
		assert_eq!(summary.avg_ttft_ms, Some(500));
		assert_eq!(summary.tokens_per_second, Some(20.0));
		assert_eq!(summary.by_model.len(), 2);
		assert_eq!(summary.by_model[0].key, "anthropic/sonnet");
		assert_eq!(summary.by_folder[1].key, "/work/y");
		assert_eq!(summary.tools, vec![ToolStat { tool: sf!("read"), calls: 2, errors: 1 }]);
		assert_eq!(index.retain_files(&[]).unwrap(), 1);
		assert_eq!(index.summary(10).unwrap().requests, 0);
	}
}
