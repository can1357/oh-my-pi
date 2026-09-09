//! `/stats` folds every stored journal into the usage index
//! (`omp_cache::stats_cache`), then reads the aggregate.
//!
//! Every project's `sessions/` under the data directory is scanned, plus the
//! launch session directory when
//! it lives elsewhere (`--session-dir`). A journal is re-read only when its
//! size or mtime moved since the last sync; a journal that vanished drops
//! its rows. Rows come from the whole file, not just the live chain: a
//! rewound branch still spent its tokens.

use std::{
	fs, io,
	path::{Path, PathBuf},
	time::UNIX_EPOCH,
};

use omp_cache::stats_cache::{FileState, MessageRow, StatsIndex, StatsSummary, ToolCallRow};
use omp_chat::overlays::services::{
	Pending, ServiceError, ServiceResult, StatsGroup, StatsReport, StatsTool,
};
use omp_core::{FastHashMap, Str};
use omp_journal::{
	Entry, EntryId, Kind, KindName,
	data::{
		Genesis, MsgAssistantEnd, MsgAssistantStart, ReceiptRole, ToolCall, ToolResult, TurnReceipt,
	},
};

use super::ServiceState;

/// Usage index file under the data directory.
const STATS_DB: &str = "stats.sqlite3";
/// Rows per grouping in the report.
const GROUP_LIMIT: usize = 10;

/// Starts the sync on the runtime; the receiver settles with the report.
pub fn fetch(state: &ServiceState) -> ServiceResult<Pending<StatsReport>> {
	let (tx, rx) = flume::bounded(1);
	let data_dir = state.data_dir.clone();
	let extra = state.sessions_dir.clone();
	state.runtime.spawn_blocking(move || {
		let _ = tx.send(sync(&data_dir, &extra));
	});
	Ok(rx)
}

/// Syncs the index at `data_dir/stats.sqlite3` from every journal it can
/// find and returns the aggregate.
pub fn sync(data_dir: &Path, extra_sessions_dir: &Path) -> ServiceResult<StatsReport> {
	let index = StatsIndex::open(&data_dir.join(STATS_DB)).map_err(ServiceError::failed)?;
	let journals = journals(data_dir, extra_sessions_dir).map_err(ServiceError::failed)?;
	let mut synced = 0_u64;
	let mut keep = Vec::with_capacity(journals.len());
	for path in &journals {
		let key = Str::new(path.to_string_lossy());
		keep.push(key.clone());
		let Some(state) = file_state(path) else {
			continue;
		};
		if index.file_state(&key).map_err(ServiceError::failed)? == Some(state) {
			continue;
		}
		let Ok(entries) = omp_journal::Journal::scan(path) else {
			continue;
		};
		let (messages, tool_calls) = fold(&entries);
		index
			.replace_file(&key, state, &messages, &tool_calls)
			.map_err(ServiceError::failed)?;
		synced = synced.saturating_add(1);
	}
	index.retain_files(&keep).map_err(ServiceError::failed)?;
	let summary = index.summary(GROUP_LIMIT).map_err(ServiceError::failed)?;
	Ok(report(synced, summary))
}

/// Every `*.oms` under `<data>/projects/*/sessions/` plus `extra`.
fn journals(data_dir: &Path, extra: &Path) -> io::Result<Vec<PathBuf>> {
	let mut dirs = Vec::new();
	match fs::read_dir(data_dir.join("projects")) {
		Ok(projects) => {
			for project in projects {
				let sessions = project?.path().join("sessions");
				if sessions.is_dir() {
					dirs.push(sessions);
				}
			}
		},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {},
		Err(error) => return Err(error),
	}
	if extra.is_dir() && !dirs.iter().any(|dir| dir == extra) {
		dirs.push(extra.to_path_buf());
	}
	let mut journals = Vec::new();
	for dir in dirs {
		for entry in fs::read_dir(dir)? {
			let path = entry?.path();
			if path.extension().is_some_and(|ext| ext == "oms") {
				journals.push(path);
			}
		}
	}
	journals.sort();
	Ok(journals)
}

fn file_state(path: &Path) -> Option<FileState> {
	let meta = fs::metadata(path).ok()?;
	let modified_ms = meta
		.modified()
		.ok()
		.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX));
	Some(FileState { size: meta.len(), modified_ms })
}

/// One inference in flight inside a turn, keyed by the turn cause.
#[derive(Default)]
struct TurnFold {
	model:    Str,
	provider: Str,
	errors:   u32,
	requests: u32,
}

/// Folds every entry of one journal into index rows: one message row per
/// `turn.receipt@1` (one per inference), carrying the assistant starts and
/// error stops journaled in the same turn since the previous receipt; one
/// tool row per `tool.call@1`, faulted when its `tool.result@1` was a fault.
pub fn fold(entries: &[Entry]) -> (Vec<MessageRow>, Vec<ToolCallRow>) {
	let genesis = Kind::known(KindName::Journal);
	let assistant_start = Kind::known(KindName::MsgAssistantStart);
	let assistant_end = Kind::known(KindName::MsgAssistantEnd);
	let receipt_kind = Kind::known(KindName::TurnReceipt);
	let tool_call = Kind::known(KindName::ToolCall);
	let tool_result = Kind::known(KindName::ToolResult);
	let mut folder = Str::default();
	let mut turns: FastHashMap<EntryId, TurnFold> = FastHashMap::default();
	let mut calls: FastHashMap<EntryId, usize> = FastHashMap::default();
	let mut messages = Vec::new();
	let mut tool_calls: Vec<ToolCallRow> = Vec::new();
	for entry in entries {
		let stamp = entry.id.as_ulid().timestamp_ms();
		if entry.kind == genesis {
			if let Ok(payload) = serde_json::from_str::<Genesis>(entry.data.as_str()) {
				folder = payload.cwd;
			}
			continue;
		}
		let Some(by) = entry.by else { continue };
		if entry.kind == assistant_start {
			if let Ok(payload) = serde_json::from_str::<MsgAssistantStart>(entry.data.as_str()) {
				let turn = turns.entry(by).or_default();
				turn.model = payload.model;
				turn.provider = payload.provider;
				turn.requests = turn.requests.saturating_add(1);
			}
		} else if entry.kind == assistant_end {
			if let Ok(payload) = serde_json::from_str::<MsgAssistantEnd>(entry.data.as_str())
				&& matches!(payload.stop_reason.as_str(), "error" | "content_filter")
			{
				turns.entry(by).or_default().errors += 1;
			}
		} else if entry.kind == receipt_kind {
			let Ok(receipt) = serde_json::from_str::<TurnReceipt>(entry.data.as_str()) else {
				continue;
			};
			let turn = turns.entry(by).or_default();
			let advisor = receipt
				.identity
				.as_ref()
				.filter(|identity| identity.role == ReceiptRole::Advisor);
			messages.push(MessageRow {
				entry_id:      Str::new(entry.id.to_string()),
				folder:        folder.clone(),
				model:         advisor
					.map_or_else(|| turn.model.clone(), |identity| identity.model.clone()),
				provider:      advisor
					.map_or_else(|| turn.provider.clone(), |identity| identity.provider.clone()),
				timestamp_ms:  stamp,
				requests:      if advisor.is_some() {
					1
				} else {
					turn.requests.max(1)
				},
				errors:        if advisor.is_some() { 0 } else { turn.errors },
				duration_ms:   receipt.duration_ms,
				ttft_ms:       receipt.ttft_ms,
				input_tokens:  receipt.tokens_in,
				output_tokens: receipt.tokens_out,
				cache_read:    receipt.cache_read,
				cache_write:   receipt.cache_write,
				cost_nano_usd: (receipt.cost_nano_usd > 0).then_some(receipt.cost_nano_usd),
			});
			if advisor.is_none() {
				turn.requests = 0;
				turn.errors = 0;
			}
		} else if entry.kind == tool_call {
			if let Ok(payload) = serde_json::from_str::<ToolCall>(entry.data.as_str()) {
				calls.insert(entry.id, tool_calls.len());
				tool_calls.push(ToolCallRow {
					call_id:      payload.call_id,
					folder:       folder.clone(),
					tool:         payload.name,
					timestamp_ms: stamp,
					is_error:     false,
				});
			}
		} else if entry.kind == tool_result {
			if let Some(&index) = calls.get(&by)
				&& let Ok(ToolResult::Fault { .. }) =
					serde_json::from_str::<ToolResult>(entry.data.as_str())
			{
				tool_calls[index].is_error = true;
			}
		}
	}
	(messages, tool_calls)
}

fn report(synced: u64, summary: StatsSummary) -> StatsReport {
	let group = |row: omp_cache::stats_cache::GroupStat| StatsGroup {
		key:           row.key,
		requests:      row.requests,
		cost_nano_usd: row.cost_nano_usd,
		unpriced:      row.unpriced,
		input_tokens:  row.input_tokens,
		output_tokens: row.output_tokens,
		cache_read:    row.cache_read,
		cache_write:   row.cache_write,
	};
	StatsReport {
		synced,
		files: summary.files,
		requests: summary.requests,
		errors: summary.errors,
		input_tokens: summary.input_tokens,
		output_tokens: summary.output_tokens,
		cache_read: summary.cache_read,
		cache_write: summary.cache_write,
		cost_nano_usd: summary.cost_nano_usd,
		unpriced: summary.unpriced,
		avg_duration_ms: summary.avg_duration_ms,
		avg_ttft_ms: summary.avg_ttft_ms,
		tokens_per_second: summary.tokens_per_second,
		by_model: summary.by_model.into_iter().map(group).collect(),
		by_folder: summary.by_folder.into_iter().map(group).collect(),
		tools: summary
			.tools
			.into_iter()
			.map(|row| StatsTool { tool: row.tool, calls: row.calls, errors: row.errors })
			.collect(),
	}
}

#[cfg(test)]
mod tests {
	use omp_journal::data::ReceiptIdentity;
	use omp_session::{ComponentRegistry, Session};

	use super::*;

	fn write_session(dir: &Path, name: &str) -> PathBuf {
		let path = dir.join(name);
		let mut session = Session::create(path.clone(), ComponentRegistry::standard()).unwrap();
		session.begin_turn().unwrap();
		session.user("hi", Vec::new()).unwrap();
		session
			.assistant_start("anthropic/claude-sonnet-4-5", "anthropic", "anthropic")
			.unwrap();
		let call = session
			.call(
				"read",
				1,
				"c1",
				None,
				Some(serde_json::value::to_raw_value(&serde_json::json!({})).unwrap()),
				None,
			)
			.unwrap();
		session
			.fail(
				call,
				serde_json::value::to_raw_value(
					&serde_json::json!({"kind": "faulted", "value": "nope"}),
				)
				.unwrap(),
			)
			.unwrap();
		session.assistant_end("tool_calls").unwrap();
		session
			.receipt(TurnReceipt {
				tokens_in:                   100,
				tokens_out:                  10,
				cost_nano_usd:               5_000,
				cache_read:                  0,
				cache_write:                 0,
				ttft_ms:                     Some(100),
				duration_ms:                 Some(1_000),
				premium_requests_millionths: 0,
				identity:                    None,
				recoveries:                  Vec::new(),
			})
			.unwrap();
		session
			.receipt(TurnReceipt {
				tokens_in: 7,
				tokens_out: 2,
				cost_nano_usd: 80,
				identity: Some(ReceiptIdentity {
					role:     ReceiptRole::Advisor,
					provider: Str::new_static("openai"),
					model:    Str::new_static("gpt-5"),
				}),
				..TurnReceipt::default()
			})
			.unwrap();
		session
			.assistant_start("anthropic/claude-sonnet-4-5", "anthropic", "anthropic")
			.unwrap();
		session.assistant_end("error").unwrap();
		session
			.receipt(TurnReceipt {
				tokens_in:                   50,
				tokens_out:                  0,
				cost_nano_usd:               0,
				cache_read:                  0,
				cache_write:                 0,
				ttft_ms:                     None,
				duration_ms:                 None,
				premium_requests_millionths: 0,
				identity:                    None,
				recoveries:                  Vec::new(),
			})
			.unwrap();
		path
	}

	#[test]
	fn sync_indexes_project_journals_incrementally() {
		let data = tempfile::tempdir().unwrap();
		let sessions = data.path().join("projects").join("abc").join("sessions");
		fs::create_dir_all(&sessions).unwrap();
		let path = write_session(&sessions, "one.oms");
		let report = sync(data.path(), &sessions).unwrap();
		assert_eq!(report.synced, 1);
		assert_eq!(report.files, 1);
		assert_eq!(report.requests, 3);
		assert_eq!(report.errors, 1);
		assert_eq!(report.input_tokens, 157);
		assert_eq!(report.cost_nano_usd, 5_080);
		assert_eq!(report.unpriced, 1);
		assert!(
			report
				.by_model
				.iter()
				.any(|row| row.key == "anthropic/claude-sonnet-4-5")
		);
		assert!(report.by_model.iter().any(|row| row.key == "gpt-5"));
		assert_eq!(report.tools, vec![StatsTool {
			tool:   Str::new_static("read"),
			calls:  1,
			errors: 1,
		}]);
		// Unchanged files are not re-read; a removed file drops its rows.
		let again = sync(data.path(), &sessions).unwrap();
		assert_eq!(again.synced, 0);
		assert_eq!(again.requests, 3);
		fs::remove_file(path).unwrap();
		let gone = sync(data.path(), &sessions).unwrap();
		assert_eq!(gone.files, 0);
		assert_eq!(gone.requests, 0);
	}
}
