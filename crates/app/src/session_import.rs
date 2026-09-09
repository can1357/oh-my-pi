//! Claude Code and Codex transcript import into native `.oms` journals.

mod convert;

use std::{
	fs,
	io::{self, BufRead, BufReader, IsTerminal as _, Write},
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use miette::{IntoDiagnostic as _, miette};
use omp_core::Str;
use serde_json::Value;

use crate::cli::ChatArgs;

/// Foreign transcript dialect accepted by the one-shot importer.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
pub enum ForeignFormat {
	/// Claude Code JSON-line events.
	Claude,
	/// Codex CLI rollout JSON-line events.
	Codex,
}

/// Lightweight metadata for one importable foreign transcript.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForeignCandidate {
	/// Stable source-local session identity.
	pub id:            Str,
	/// Source transcript path.
	pub path:          PathBuf,
	/// Project directory recorded by the source, or its containing directory.
	pub cwd:           PathBuf,
	/// Source-provided title, when present.
	pub title:         Option<Str>,
	/// Creation time, Unix milliseconds.
	pub created_ms:    u64,
	/// Last modification, Unix milliseconds.
	pub modified_ms:   u64,
	/// Exact user and assistant message count for transcripts small enough to
	/// index eagerly.
	pub messages:      u32,
	/// First user message, when it occurs in the indexed prefix.
	pub first_message: Option<Str>,
}

impl From<omp_chat::overlays::services::ForeignSessionSource> for ForeignFormat {
	fn from(source: omp_chat::overlays::services::ForeignSessionSource) -> Self {
		match source {
			omp_chat::overlays::services::ForeignSessionSource::Claude => Self::Claude,
			omp_chat::overlays::services::ForeignSessionSource::Codex => Self::Codex,
		}
	}
}

/// Enumerates transcripts for `format`, newest first, without materializing a
/// native session.
pub fn candidates(format: ForeignFormat) -> miette::Result<Vec<ForeignCandidate>> {
	let root = foreign_root(format)?;
	let mut candidates = jsonl_candidates(format, &root)?
		.into_iter()
		.map(|path| inspect_candidate(format, path, &root))
		.collect::<miette::Result<Vec<_>>>()?;
	candidates.sort_by(|left, right| {
		right
			.modified_ms
			.cmp(&left.modified_ms)
			.then_with(|| left.path.cmp(&right.path))
	});
	Ok(candidates)
}

/// Lets the operator select a requested foreign session, imports it, and
/// rewrites the launch to resume the resulting native journal.
pub(crate) fn prepare(args: &mut ChatArgs) -> miette::Result<()> {
	let format = if args.from_claude {
		ForeignFormat::Claude
	} else {
		ForeignFormat::Codex
	};
	let root = foreign_root(format)?;
	let candidates = candidates(format)?
		.into_iter()
		.map(|candidate| candidate.path)
		.collect::<Vec<_>>();
	let source = match candidates.as_slice() {
		[] => {
			return Err(miette!(
				"no importable {} sessions were found under {}",
				format,
				root.display(),
			));
		},
		[only] => only.clone(),
		_ if !io::stdin().is_terminal() => {
			return Err(miette!(
				"multiple foreign sessions were found; rerun from an interactive terminal to select \
				 one"
			));
		},
		_ => {
			let stdin = io::stdin();
			let mut input = stdin.lock();
			let stderr = io::stderr();
			let mut output = stderr.lock();
			select_candidate(&candidates, &mut input, &mut output)?
		},
	};
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let project = fs::canonicalize(&args.project).into_diagnostic()?;
	let state_dir =
		omp_env::project_state::directory(&data_dir, &project).map_err(|source| miette!(source))?;
	let sessions = args
		.session_dir
		.clone()
		.unwrap_or_else(|| state_dir.join("sessions"));
	fs::create_dir_all(&sessions).into_diagnostic()?;
	let destination = sessions.join(format!("{}.oms", omp_core::Ulid::generate()));
	let count = import_file(format, &source, &destination)?;
	if count == 0 {
		return Err(miette!(
			"{} contains no importable user or assistant messages",
			source.display()
		));
	}
	eprintln!(
		"Imported {} messages from {} into {}.",
		count,
		source.display(),
		destination.display()
	);
	args.resume = Some(Str::new(destination.to_string_lossy()));
	args.session_dir = Some(sessions);
	args.from_claude = false;
	args.from_codex = false;
	Ok(())
}

/// Imports a picker selection into a fresh native journal.
///
/// The selected path is revalidated against the source authority. Conversion
/// happens in a hidden sibling file and becomes visible only after an atomic
/// rename, so a failed import never leaves a resumable partial journal.
pub fn import_selected(
	format: ForeignFormat,
	source: &Path,
	destination: &Path,
) -> miette::Result<PathBuf> {
	let source = validate_selection(format, source)?;
	if destination.extension().and_then(|value| value.to_str()) != Some("oms") {
		return Err(miette!("native session destination must use the .oms extension"));
	}
	if destination.exists() {
		return Err(miette!("native session destination already exists"));
	}
	let parent = destination
		.parent()
		.ok_or_else(|| miette!("native session destination has no parent directory"))?;
	fs::create_dir_all(parent).into_diagnostic()?;
	let staging = parent.join(format!(".{}.importing.oms", omp_core::Ulid::generate()));
	let imported = import_file(format, &source, &staging);
	let count = match imported {
		Ok(count) => count,
		Err(error) => {
			let _ = fs::remove_file(&staging);
			return Err(error);
		},
	};
	if count == 0 {
		let _ = fs::remove_file(&staging);
		return Err(miette!(
			"Selected {format} session contains no importable user or assistant messages"
		));
	}
	if let Err(source) = fs::rename(&staging, destination) {
		let _ = fs::remove_file(&staging);
		return Err(source).into_diagnostic();
	}
	Ok(destination.to_path_buf())
}

/// Imports one foreign JSONL transcript into a replayable `.oms` journal.
///
/// Conversion retains the exact source bytes in the journal's content-addressed
/// store and materializes every representable message, content block, tool
/// exchange, attachment, timestamp, usage record, and branch.
pub fn import_file(
	format: ForeignFormat,
	source: &Path,
	destination: &Path,
) -> miette::Result<usize> {
	convert::import_file(format, source, destination)
}

fn foreign_root(format: ForeignFormat) -> miette::Result<PathBuf> {
	let home = std::env::var_os("HOME")
		.map(PathBuf::from)
		.ok_or_else(|| miette!("HOME is unset"))?;
	Ok(match format {
		ForeignFormat::Claude => std::env::var_os("CLAUDE_CONFIG_DIR")
			.map(PathBuf::from)
			.unwrap_or_else(|| home.join(".claude")),
		ForeignFormat::Codex => home.join(".codex"),
	})
}

fn transcript_roots(format: ForeignFormat, root: &Path) -> Vec<PathBuf> {
	match format {
		ForeignFormat::Claude => vec![root.join("projects"), root.join(".projects")],
		ForeignFormat::Codex => {
			vec![root.join("sessions"), root.join(".sessions"), root.join("archived_sessions")]
		},
	}
}

fn validate_selection(format: ForeignFormat, source: &Path) -> miette::Result<PathBuf> {
	let source = match fs::canonicalize(source) {
		Ok(path) => path,
		Err(error) if error.kind() == io::ErrorKind::NotFound => {
			return Err(miette!("Selected {format} session is no longer available"));
		},
		Err(error) => return Err(error).into_diagnostic(),
	};
	let root = foreign_root(format)?;
	let allowed = transcript_roots(format, &root)
		.into_iter()
		.filter_map(|path| fs::canonicalize(path).ok())
		.any(|path| source.starts_with(path));
	if source.extension().and_then(|value| value.to_str()) != Some("jsonl") || !allowed {
		return Err(miette!(
			"Selected {format} session is outside the {format} transcript directory"
		));
	}
	Ok(source)
}

fn inspect_candidate(
	format: ForeignFormat,
	path: PathBuf,
	root: &Path,
) -> miette::Result<ForeignCandidate> {
	const MAX_EAGER_INDEX_BYTES: u64 = 1024 * 1024;

	let metadata = fs::metadata(&path).into_diagnostic()?;
	let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
	let created = metadata.created().unwrap_or(modified);
	let mut candidate = ForeignCandidate {
		id: Str::new(
			path
				.file_stem()
				.and_then(|value| value.to_str())
				.unwrap_or_default(),
		),
		cwd: path.parent().unwrap_or(root).to_path_buf(),
		path,
		title: None,
		created_ms: system_time_millis(created),
		modified_ms: system_time_millis(modified),
		messages: 0,
		first_message: None,
	};
	let exact_count = metadata.len() <= MAX_EAGER_INDEX_BYTES;
	let mut input = BufReader::new(fs::File::open(&candidate.path).into_diagnostic()?);
	let mut indexed_bytes = 0_u64;
	let mut source_created_ms = None::<u64>;
	let mut source_modified_ms = None::<u64>;
	let mut line = Vec::new();
	loop {
		line.clear();
		let read = input.read_until(b'\n', &mut line).into_diagnostic()?;
		if read == 0 {
			break;
		}
		indexed_bytes = indexed_bytes.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
		if !exact_count && indexed_bytes > MAX_EAGER_INDEX_BYTES {
			break;
		}
		let Ok(value) = serde_json::from_slice::<Value>(&line) else {
			continue;
		};
		let payload = value.get("payload").unwrap_or(&value);
		if let Some(timestamp) = foreign_timestamp_ms(
			value
				.get("timestamp")
				.or_else(|| value.get("ts"))
				.or_else(|| payload.get("timestamp")),
		) {
			source_created_ms = Some(source_created_ms.map_or(timestamp, |old| old.min(timestamp)));
			source_modified_ms = Some(source_modified_ms.map_or(timestamp, |old| old.max(timestamp)));
		}
		if let Some(id) = value.get("sessionId").and_then(Value::as_str).or_else(|| {
			(value.get("type").and_then(Value::as_str) == Some("session_meta"))
				.then(|| payload.get("id").and_then(Value::as_str))
				.flatten()
		}) {
			candidate.id = Str::new(id);
		}
		if let Some(cwd) = value
			.get("cwd")
			.and_then(Value::as_str)
			.or_else(|| payload.get("cwd").and_then(Value::as_str))
		{
			candidate.cwd = PathBuf::from(cwd);
		}
		let record_title = match value.get("type").and_then(Value::as_str) {
			Some("custom-title") => value.get("customTitle").and_then(Value::as_str),
			Some("ai-title") => value.get("aiTitle").and_then(Value::as_str),
			_ if payload.get("type").and_then(Value::as_str) == Some("thread_name_updated") => {
				payload.get("thread_name").and_then(Value::as_str)
			},
			_ => value
				.get("summary")
				.and_then(Value::as_str)
				.or_else(|| value.get("title").and_then(Value::as_str))
				.or_else(|| payload.get("title").and_then(Value::as_str)),
		};
		if let Some(title) = record_title.filter(|title| !title.trim().is_empty()) {
			candidate.title = Some(Str::new(title));
		}
		if let Some((role, text)) = foreign_message(format, &value) {
			candidate.messages = candidate.messages.saturating_add(1);
			if role == "user" && candidate.first_message.is_none() && !text.trim().is_empty() {
				candidate.first_message = Some(text);
			}
		}
		if !exact_count && candidate.first_message.is_some() {
			candidate.messages = 0;
			break;
		}
	}
	if !exact_count {
		candidate.messages = 0;
	}
	if let Some(created) = source_created_ms {
		candidate.created_ms = created;
	}
	if exact_count && let Some(modified) = source_modified_ms {
		candidate.modified_ms = modified;
	}
	Ok(candidate)
}

fn system_time_millis(time: SystemTime) -> u64 {
	time
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

fn foreign_timestamp_ms(value: Option<&Value>) -> Option<u64> {
	let value = value?;
	if let Some(number) = value.as_u64() {
		return Some(if number < 10_000_000_000 {
			number.saturating_mul(1000)
		} else {
			number
		});
	}
	let timestamp = value.as_str()?.parse::<jiff::Timestamp>().ok()?;
	u64::try_from(timestamp.as_millisecond()).ok()
}

fn foreign_message(format: ForeignFormat, value: &Value) -> Option<(&'static str, Str)> {
	match format {
		ForeignFormat::Claude => {
			let role = value
				.get("type")
				.and_then(Value::as_str)
				.or_else(|| value.pointer("/message/role").and_then(Value::as_str))?;
			let role = match role {
				"user" | "human" => "user",
				"assistant" => "assistant",
				_ => return None,
			};
			let content = value
				.pointer("/message/content")
				.or_else(|| value.get("content"))?;
			text_content(content).map(|text| (role, text))
		},
		ForeignFormat::Codex => {
			let payload = value.get("payload").unwrap_or(value);
			if payload
				.get("type")
				.and_then(Value::as_str)
				.is_some_and(|kind| !matches!(kind, "message" | "user_message" | "assistant_message"))
			{
				return None;
			}
			let role = payload.get("role").and_then(Value::as_str).or_else(|| {
				match payload.get("type").and_then(Value::as_str) {
					Some("user_message") => Some("user"),
					Some("assistant_message") => Some("assistant"),
					_ => None,
				}
			})?;
			let role = match role {
				"user" => "user",
				"assistant" => "assistant",
				_ => return None,
			};
			let content = payload.get("content").or_else(|| payload.get("message"))?;
			text_content(content).map(|text| (role, text))
		},
	}
}

fn text_content(value: &Value) -> Option<Str> {
	if let Some(text) = value.as_str() {
		return Some(Str::new(text));
	}
	let parts = value.as_array()?;
	let mut text = String::new();
	for part in parts {
		if let Some(value) = part
			.as_str()
			.or_else(|| part.get("text").and_then(Value::as_str))
		{
			text.push_str(value);
		}
	}
	(!text.is_empty()).then(|| Str::new(text))
}

fn jsonl_candidates(format: ForeignFormat, root: &Path) -> miette::Result<Vec<PathBuf>> {
	let mut stack = transcript_roots(format, root);
	stack.sort();
	stack.dedup();
	let mut candidates = Vec::new();
	while let Some(directory) = stack.pop() {
		let entries = match fs::read_dir(&directory) {
			Ok(entries) => entries,
			Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
			Err(source) => return Err(source).into_diagnostic(),
		};
		for entry in entries {
			let entry = entry.into_diagnostic()?;
			let path = entry.path();
			let metadata = entry.metadata().into_diagnostic()?;
			if metadata.is_dir() {
				stack.push(path);
			} else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
				candidates.push((metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH), path));
			}
		}
	}
	sort_candidate_paths(&mut candidates);
	Ok(candidates.into_iter().map(|(_, path)| path).collect())
}

fn sort_candidate_paths(candidates: &mut [(SystemTime, PathBuf)]) {
	candidates.sort_by(|(left_time, left_path), (right_time, right_path)| {
		right_time
			.cmp(left_time)
			.then_with(|| left_path.cmp(right_path))
	});
}

fn select_candidate(
	candidates: &[PathBuf],
	input: &mut impl BufRead,
	output: &mut impl Write,
) -> miette::Result<PathBuf> {
	writeln!(output, "Select a foreign session to import:").into_diagnostic()?;
	for (index, path) in candidates.iter().enumerate() {
		writeln!(output, "  {}. {}", index + 1, path.display()).into_diagnostic()?;
	}
	write!(output, "Selection [1-{}]: ", candidates.len()).into_diagnostic()?;
	output.flush().into_diagnostic()?;
	let mut line = String::new();
	input.read_line(&mut line).into_diagnostic()?;
	let selected = line
		.trim()
		.parse::<usize>()
		.ok()
		.and_then(|value| value.checked_sub(1))
		.and_then(|index| candidates.get(index))
		.ok_or_else(|| miette!("invalid foreign session selection"))?;
	Ok(selected.clone())
}

#[cfg(test)]
mod tests {
	use omp_dom::{PropKey, Value as DomValue};
	use omp_session::{ComponentRegistry, Session};

	use super::*;

	#[test]
	fn foreign_picker_lists_every_candidate_and_honors_the_explicit_selection() {
		let candidates = vec![PathBuf::from("newest.jsonl"), PathBuf::from("older.jsonl")];
		let mut input = io::Cursor::new(b"2\n");
		let mut output = Vec::new();
		let selected = select_candidate(&candidates, &mut input, &mut output).unwrap();
		assert_eq!(selected, PathBuf::from("older.jsonl"));
		let rendered = String::from_utf8(output).unwrap();
		assert!(rendered.contains("1. newest.jsonl"));
		assert!(rendered.contains("2. older.jsonl"));
	}

	#[test]
	fn candidate_order_is_newest_first_then_path_ascending() {
		let earlier = UNIX_EPOCH + std::time::Duration::from_secs(1);
		let later = UNIX_EPOCH + std::time::Duration::from_secs(2);
		let mut rows = vec![
			(later, PathBuf::from("z.jsonl")),
			(earlier, PathBuf::from("old.jsonl")),
			(later, PathBuf::from("a.jsonl")),
		];
		sort_candidate_paths(&mut rows);
		assert_eq!(rows.into_iter().map(|(_, path)| path).collect::<Vec<_>>(), vec![
			PathBuf::from("a.jsonl"),
			PathBuf::from("z.jsonl"),
			PathBuf::from("old.jsonl"),
		]);
	}

	#[test]
	fn imported_session_records_source_selection_metadata() {
		let directory = tempfile::tempdir().unwrap();
		let source = directory.path().join("source.jsonl");
		let destination = directory.path().join("destination.oms");
		fs::write(&source, r#"{"type":"user","message":{"content":"hello"}}"#).unwrap();
		assert_eq!(import_file(ForeignFormat::Claude, &source, &destination).unwrap(), 1);
		let session = Session::open(&destination, ComponentRegistry::standard()).unwrap();
		let meta = session.dom().get(session.dom().meta()).unwrap();
		assert_eq!(
			meta
				.prop(&PropKey::Custom(Str::new_static("import-source")))
				.and_then(DomValue::as_str),
			Some(source.to_string_lossy().as_ref())
		);
		assert_eq!(
			meta
				.prop(&PropKey::Custom(Str::new_static("import-format")))
				.and_then(DomValue::as_str),
			Some("claude")
		);
	}
}
