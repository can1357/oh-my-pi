//! Syntax-regression observation and bounded automatic edit repair.

use std::{path::PathBuf, sync::Arc, time::Duration};

use bytes::Bytes;
use flume::{Receiver, Sender};
use omp_ast::summary::{SummarySettings, summarize_source};
use omp_core::{Str, sf};
use serde::{Deserialize, Serialize};
use similar::{Algorithm, DiffOp, capture_diff_slices};

const DEFAULT_CAPTURE_BYTES: usize = 256 * 1024;
const DEFAULT_ARGS_BYTES: usize = 64 * 1024;
const CONTEXT_LINES: usize = 6;
const MAX_REGION_LINES: usize = 150;
const MAX_PAIR_SEARCH_HUNKS: usize = 24;
const MAX_ATTEMPTS: usize = 2;
const REPAIR_TIMEOUT: Duration = Duration::from_secs(60);

/// Exact source transition proposed by one edit section.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppliedEditSnapshot {
	/// Canonical target path used for language inference.
	pub path:   Str,
	/// Parseable pre-edit bytes.
	pub before: Bytes,
	/// Initially proposed post-edit bytes.
	pub after:  Bytes,
}

/// Bounded source field retained in a blackbox record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CapturedSource {
	/// UTF-8 prefix retained in the record.
	pub text:           Str,
	/// Original source byte count.
	pub original_bytes: usize,
	/// Whether `text` is a strict prefix of the source.
	pub truncated:      bool,
}

/// One structured, bounded valid-to-invalid edit transition.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct EditBlackboxRecord {
	/// Canonical target path.
	pub path:   Str,
	/// Parseable source before the edit.
	pub before: CapturedSource,
	/// Invalid source initially proposed by the edit.
	pub after:  CapturedSource,
	/// Active model identity.
	pub model:  Str,
	/// Edit revision family.
	pub mode:   Str,
	/// Bounded invocation arguments.
	pub args:   serde_json::Value,
}

/// Shared active model identity for edit observation.
#[derive(Clone, Debug)]
pub struct EditBlackboxModel(Arc<parking_lot::RwLock<Str>>);

impl EditBlackboxModel {
	/// Creates a shared model identity.
	pub fn new(model: Str) -> Self {
		Self(Arc::new(parking_lot::RwLock::new(model)))
	}

	/// Replaces the active model identity before subsequent edit records.
	pub fn set(&self, model: Str) {
		*self.0.write() = model;
	}

	fn current(&self) -> Str {
		self.0.read().clone()
	}
}

impl Default for EditBlackboxModel {
	fn default() -> Self {
		Self::new(sf!("unknown"))
	}
}

/// Optional valid-to-invalid recorder configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditBlackboxConfig {
	/// JSONL destination. Absence disables recording.
	pub path:             Option<PathBuf>,
	/// Maximum bytes retained from each source image.
	pub max_source_bytes: usize,
	/// Maximum serialized invocation-argument bytes.
	pub max_args_bytes:   usize,
}

impl Default for EditBlackboxConfig {
	fn default() -> Self {
		Self {
			path:             None,
			max_source_bytes: DEFAULT_CAPTURE_BYTES,
			max_args_bytes:   DEFAULT_ARGS_BYTES,
		}
	}
}

/// Typed automatic-repair completion failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EditRepairError {
	/// The repair service is no longer available.
	#[error("edit repair service is unavailable")]
	Unavailable,
	/// The repair model rejected or failed the completion.
	#[error("edit repair completion failed: {message}")]
	Completion {
		/// Typed provider-facing diagnostic.
		message: Str,
	},
}

/// Structured repair prompt; the inference owner renders it for its selected
/// model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditRepairPrompt {
	/// Canonical source language.
	pub language:         Str,
	/// Parseable reference region.
	pub before:           Str,
	/// Invalid region to correct.
	pub after:            Str,
	/// Candidate rejected by the previous attempt.
	pub previous_attempt: Option<Str>,
}
impl EditRepairPrompt {
	/// Renders the strict code-only completion request for the repair model.
	pub fn render(&self) -> Str {
		let mut prompt = format!(
			"An automated edit made this {} region invalid. BEFORE parsed; AFTER does \
			 not.\n\nBEFORE:\n```\n{}\n```\n\nAFTER:\n```\n{}\n```\n\nOutput only corrected AFTER \
			 code. Preserve the intended change; fix only syntax. Do not revert to BEFORE and do not \
			 use a code fence.",
			self.language, self.before, self.after
		);
		if let Some(previous) = &self.previous_attempt {
			prompt.push_str(&format!(
				"\n\nThe previous candidate still failed validation:\n```\n{previous}\n```\nProduce a \
				 different corrected region."
			));
		}
		Str::new(prompt)
	}
}

/// One request sent to the inference-owning repair service.
#[derive(Debug)]
pub struct EditRepairRequest {
	/// Structured repair prompt.
	pub prompt: EditRepairPrompt,
	/// One-shot typed response channel.
	pub reply:  Sender<Result<Str, EditRepairError>>,
}

/// Cloneable client for the inference-owning automatic-repair service.
#[derive(Clone, Debug)]
pub struct EditRepairClient {
	tx: Sender<EditRepairRequest>,
}

impl EditRepairClient {
	/// Creates a client and its single-consumer request stream.
	pub fn channel() -> (Self, Receiver<EditRepairRequest>) {
		let (tx, rx) = flume::unbounded();
		(Self { tx }, rx)
	}

	async fn complete(&self, prompt: EditRepairPrompt) -> Result<Str, EditRepairError> {
		let (reply, response) = flume::bounded(1);
		self
			.tx
			.send_async(EditRepairRequest { prompt, reply })
			.await
			.map_err(|_| EditRepairError::Unavailable)?;
		response
			.recv_async()
			.await
			.map_err(|_| EditRepairError::Unavailable)?
	}
}

/// Edit-level syntax policy shared by every edit dialect.
#[derive(Clone, Debug, Default)]
pub struct EditObserver {
	blackbox:    Arc<EditBlackboxConfig>,
	model:       EditBlackboxModel,
	auto_repair: Option<EditRepairClient>,
	append_lock: Arc<parking_lot::Mutex<()>>,
}

impl EditObserver {
	/// Constructs an observer. `None` blackbox path and repair client disable
	/// all work.
	pub fn new(
		blackbox: EditBlackboxConfig,
		model: EditBlackboxModel,
		auto_repair: Option<EditRepairClient>,
	) -> Self {
		Self {
			blackbox: Arc::new(blackbox),
			model,
			auto_repair,
			append_lock: Arc::new(parking_lot::Mutex::new(())),
		}
	}

	/// Inspects a proposed transition, repairing only a newly introduced parse
	/// error.
	pub async fn inspect(
		&self,
		snapshot: AppliedEditSnapshot,
		mode: &str,
		args: &serde_json::Value,
	) -> EditInspection {
		if !introduced_parse_failure(&snapshot) {
			return EditInspection { content: snapshot.after, notice: None, pending: None };
		}
		let pending = self.blackbox.path.as_ref().map(|_| PendingBlackbox {
			record: bounded_record(&snapshot, mode, args, &self.blackbox, &self.model),
		});
		if let Some(client) = &self.auto_repair
			&& let Some(repaired) = repair_parse_regression(&snapshot, client).await
		{
			return EditInspection {
				content: repaired.content,
				notice: Some(sf!(
					"{} stopped parsing after this edit; automatic syntax repair succeeded in {} \
					 attempt(s). Review the repaired region.",
					snapshot.path,
					repaired.attempts
				)),
				pending,
			};
		}
		EditInspection {
			content: snapshot.after,
			notice: Some(sf!(
				"{} no longer parses after this edit. Re-read the edited region and fix the syntax.",
				snapshot.path
			)),
			pending,
		}
	}

	/// Appends a pending record after the enclosing document transaction
	/// commits.
	pub async fn record_committed(&self, pending: PendingBlackbox) {
		let Some(path) = self.blackbox.path.as_ref() else {
			return;
		};
		let Ok(mut bytes) = serde_json::to_vec(&pending.record) else {
			return;
		};
		bytes.push(b'\n');
		let path = path.clone();
		let lock = Arc::clone(&self.append_lock);
		let _ = tokio::task::spawn_blocking(move || append(&path, &bytes, &lock)).await;
	}
}

fn append(path: &PathBuf, bytes: &[u8], lock: &parking_lot::Mutex<()>) -> std::io::Result<()> {
	use std::io::Write as _;
	let _guard = lock.lock();
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)?;
	}
	std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(path)?
		.write_all(bytes)
}

/// Inspection result retained until the document transaction commits.
#[derive(Clone, Debug)]
pub struct EditInspection {
	/// Proposed final content, repaired only after a validated parse regression.
	pub content: Bytes,
	/// Model-facing repair or regression diagnostic.
	pub notice:  Option<Str>,
	/// Blackbox record which must be appended only after commit.
	pub pending: Option<PendingBlackbox>,
}

/// Deferred blackbox append proving the corresponding transaction committed.
#[derive(Clone, Debug)]
pub struct PendingBlackbox {
	record: EditBlackboxRecord,
}

/// True only for supported valid-to-invalid syntax transitions.
pub fn introduced_parse_failure(snapshot: &AppliedEditSnapshot) -> bool {
	let Ok(before) = std::str::from_utf8(&snapshot.before) else {
		return false;
	};
	let Ok(after) = std::str::from_utf8(&snapshot.after) else {
		return false;
	};
	!source_parses(after, &snapshot.path) && source_parses(before, &snapshot.path)
}

/// Whether tree-sitter accepts a supported source, treating an empty file as
/// valid.
pub fn source_parses(source: &str, path: &str) -> bool {
	if source.is_empty() {
		return true;
	}
	summarize_source(source, SummarySettings { path: Some(path), ..SummarySettings::default() })
		.is_ok_and(|summary| summary.parsed)
}

fn bounded_record(
	snapshot: &AppliedEditSnapshot,
	mode: &str,
	args: &serde_json::Value,
	config: &EditBlackboxConfig,
	model: &EditBlackboxModel,
) -> EditBlackboxRecord {
	EditBlackboxRecord {
		path:   snapshot.path.clone(),
		before: capture(&snapshot.before, config.max_source_bytes),
		after:  capture(&snapshot.after, config.max_source_bytes),
		model:  model.current(),
		mode:   Str::new(mode),
		args:   bounded_args(args, config.max_args_bytes),
	}
}

fn capture(bytes: &[u8], maximum: usize) -> CapturedSource {
	let end = floor_char_boundary(bytes, maximum.min(bytes.len()));
	CapturedSource {
		text:           Str::new(String::from_utf8_lossy(&bytes[..end])),
		original_bytes: bytes.len(),
		truncated:      end < bytes.len(),
	}
}

fn floor_char_boundary(bytes: &[u8], mut end: usize) -> usize {
	while end > 0 && std::str::from_utf8(&bytes[..end]).is_err() {
		end -= 1;
	}
	end
}

fn bounded_args(args: &serde_json::Value, maximum: usize) -> serde_json::Value {
	let Ok(encoded) = serde_json::to_vec(args) else {
		return serde_json::Value::Null;
	};
	if encoded.len() <= maximum {
		return args.clone();
	}
	let end = floor_char_boundary(&encoded, maximum);
	serde_json::json!({
		"truncated": true,
		"original_bytes": encoded.len(),
		"json_prefix": String::from_utf8_lossy(&encoded[..end]),
	})
}

#[derive(Clone, Copy, Debug)]
struct Hunk {
	a_start: usize,
	a_end:   usize,
	b_start: usize,
	b_end:   usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RepairRegion {
	b_start:   usize,
	b_end:     usize,
	broken:    Str,
	reference: Str,
	language:  Str,
}

#[derive(Clone, Debug)]
struct RepairOutcome {
	content:  Bytes,
	attempts: usize,
}

fn line_slices(source: &str) -> Vec<&str> {
	source.split('\n').collect()
}

fn hunks<'a>(before: &[&'a str], after: &[&'a str]) -> Vec<Hunk> {
	capture_diff_slices(Algorithm::Myers, before, after)
		.into_iter()
		.filter_map(|operation| match operation {
			DiffOp::Equal { .. } => None,
			DiffOp::Delete { old_index, old_len, new_index } => Some(Hunk {
				a_start: old_index,
				a_end:   old_index + old_len,
				b_start: new_index,
				b_end:   new_index,
			}),
			DiffOp::Insert { old_index, new_index, new_len } => Some(Hunk {
				a_start: old_index,
				a_end:   old_index,
				b_start: new_index,
				b_end:   new_index + new_len,
			}),
			DiffOp::Replace { old_index, old_len, new_index, new_len } => Some(Hunk {
				a_start: old_index,
				a_end:   old_index + old_len,
				b_start: new_index,
				b_end:   new_index + new_len,
			}),
		})
		.collect()
}

fn revert_hunks(before: &[&str], after: &[&str], hunks: &[Hunk], selected: &[usize]) -> String {
	let mut selected = selected.to_vec();
	selected.sort_unstable();
	let mut output = Vec::new();
	let mut at = 0;
	for index in selected {
		let hunk = hunks[index];
		output.extend_from_slice(&after[at..hunk.b_start]);
		output.extend_from_slice(&before[hunk.a_start..hunk.a_end]);
		at = hunk.b_end;
	}
	output.extend_from_slice(&after[at..]);
	output.join("\n")
}

fn culprit_hunks(
	path: &str,
	before: &[&str],
	after: &[&str],
	hunks: &[Hunk],
) -> Option<Vec<usize>> {
	for index in 0..hunks.len() {
		if source_parses(&revert_hunks(before, after, hunks, &[index]), path) {
			return Some(vec![index]);
		}
	}
	if hunks.len() <= MAX_PAIR_SEARCH_HUNKS {
		for left in 0..hunks.len() {
			for right in left + 1..hunks.len() {
				if source_parses(&revert_hunks(before, after, hunks, &[left, right]), path) {
					return Some(vec![left, right]);
				}
			}
		}
	}
	let all = (0..hunks.len()).collect::<Vec<_>>();
	source_parses(&revert_hunks(before, after, hunks, &all), path).then_some(all)
}

fn repair_region(snapshot: &AppliedEditSnapshot) -> Option<RepairRegion> {
	let before_text = std::str::from_utf8(&snapshot.before).ok()?;
	let after_text = std::str::from_utf8(&snapshot.after).ok()?;
	let before = line_slices(before_text);
	let after = line_slices(after_text);
	let hunks = hunks(&before, &after);
	let culprits = culprit_hunks(&snapshot.path, &before, &after, &hunks)?;
	let first = culprits.iter().map(|index| hunks[*index].b_start).min()?;
	let last = culprits.iter().map(|index| hunks[*index].b_end).max()?;
	let b_start = first.saturating_sub(CONTEXT_LINES);
	let b_end = last.saturating_add(CONTEXT_LINES).min(after.len());
	if b_end.saturating_sub(b_start) > MAX_REGION_LINES {
		return None;
	}
	let mut ordered = culprits
		.iter()
		.map(|index| hunks[*index])
		.collect::<Vec<_>>();
	ordered.sort_by_key(|hunk| hunk.b_start);
	let mut reference = Vec::new();
	let mut at = b_start;
	for hunk in ordered {
		if hunk.b_end < b_start || hunk.b_start > b_end {
			continue;
		}
		reference.extend_from_slice(&after[at..hunk.b_start.min(b_end)]);
		reference.extend_from_slice(&before[hunk.a_start..hunk.a_end]);
		at = hunk.b_end.min(b_end);
	}
	reference.extend_from_slice(&after[at..b_end]);
	let language = summarize_source(before_text, SummarySettings {
		path: Some(&snapshot.path),
		..SummarySettings::default()
	})
	.ok()?
	.language?;
	Some(RepairRegion {
		b_start,
		b_end,
		broken: Str::new(after[b_start..b_end].join("\n")),
		reference: Str::new(reference.join("\n")),
		language: Str::new(language),
	})
}

async fn repair_parse_regression(
	snapshot: &AppliedEditSnapshot,
	client: &EditRepairClient,
) -> Option<RepairOutcome> {
	let region = repair_region(snapshot)?;
	let after_text = std::str::from_utf8(&snapshot.after).ok()?;
	let after = line_slices(after_text);
	let normalized_reference = normalize_revert_check(&region.reference);
	let mut previous_attempt = None;
	for attempt in 1..=MAX_ATTEMPTS {
		let candidate = tokio::time::timeout(
			REPAIR_TIMEOUT,
			client.complete(EditRepairPrompt {
				language:         region.language.clone(),
				before:           region.reference.clone(),
				after:            region.broken.clone(),
				previous_attempt: previous_attempt.clone(),
			}),
		)
		.await
		.ok()?
		.ok()?;
		let candidate = strip_fence(&candidate);
		previous_attempt = Some(Str::new(candidate));
		if normalize_revert_check(candidate) == normalized_reference {
			continue;
		}
		let mut repaired = after[..region.b_start]
			.iter()
			.map(|line| (*line).to_owned())
			.collect::<Vec<_>>();
		repaired.extend(candidate.split('\n').map(str::to_owned));
		repaired.extend(after[region.b_end..].iter().map(|line| (*line).to_owned()));
		let content = repaired.join("\n");
		if source_parses(&content, &snapshot.path) {
			return Some(RepairOutcome { content: Bytes::from(content), attempts: attempt });
		}
	}
	None
}

fn strip_fence(candidate: &str) -> &str {
	let trimmed = candidate.trim();
	let Some(rest) = trimmed.strip_prefix("```") else {
		return trimmed;
	};
	let Some(body) = rest.split_once('\n').map(|(_, body)| body) else {
		return trimmed;
	};
	body.strip_suffix("```").map_or(trimmed, str::trim_end)
}

fn normalize_revert_check(source: &str) -> String {
	source.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use tempfile::tempdir;

	use super::*;

	const PATH: &str = "src/sample.ts";
	const VALID: &str = "export function value(): number {\n\treturn 1;\n}\n";
	const INVALID: &str = "export function value(): number {\n\treturn (;\n}\n";

	fn snapshot(after: &str) -> AppliedEditSnapshot {
		AppliedEditSnapshot {
			path:   sf!(PATH),
			before: Bytes::copy_from_slice(VALID.as_bytes()),
			after:  Bytes::copy_from_slice(after.as_bytes()),
		}
	}

	#[test]
	fn transition_boundaries_require_valid_to_invalid() {
		assert!(introduced_parse_failure(&snapshot(INVALID)));
		assert!(!introduced_parse_failure(&snapshot(VALID)));
		assert!(!introduced_parse_failure(&AppliedEditSnapshot {
			path:   sf!(PATH),
			before: Bytes::copy_from_slice(INVALID.as_bytes()),
			after:  Bytes::from_static(b"export const next = (;\n"),
		}));
		assert!(!introduced_parse_failure(&snapshot("")));
	}

	#[tokio::test]
	async fn blackbox_is_bounded_structured_and_opt_in() {
		assert!(
			EditObserver::default()
				.inspect(snapshot(INVALID), "replace", &serde_json::Value::Null)
				.await
				.pending
				.is_none()
		);
		let temp = tempdir().expect("tempdir");
		let log = temp.path().join("blackbox.jsonl");
		let model = EditBlackboxModel::new(sf!("openai/launch"));
		let observer = EditObserver::new(
			EditBlackboxConfig {
				path:             Some(log.clone()),
				max_source_bytes: 24,
				max_args_bytes:   16,
			},
			model.clone(),
			None,
		);
		model.set(sf!("openai/revived"));
		for mode in ["hashline", "replace", "patch", "apply_patch", "sloppy"] {
			let inspected = observer
				.inspect(
					snapshot(INVALID),
					mode,
					&serde_json::json!({
						"path": PATH,
						"old_string": "return 1",
					}),
				)
				.await;
			assert!(inspected.notice.is_some());
			observer
				.record_committed(inspected.pending.expect("record"))
				.await;
		}
		let log = tokio::fs::read_to_string(log).await.expect("log");
		let records = log
			.lines()
			.map(|line| serde_json::from_str::<EditBlackboxRecord>(line).expect("record json"))
			.collect::<Vec<_>>();
		assert_eq!(
			records
				.iter()
				.map(|record| record.mode.as_str())
				.collect::<Vec<_>>(),
			["hashline", "replace", "patch", "apply_patch", "sloppy"]
		);
		let record = &records[1];
		assert_eq!(record.model, "openai/revived");
		assert_eq!(record.mode, "replace");
		assert!(record.before.truncated);
		assert_eq!(record.args["truncated"], true);
	}

	#[tokio::test]
	async fn automatic_repair_accepts_parse_fix_and_rejects_revert_or_failure() {
		let (client, requests) = EditRepairClient::channel();
		let worker = tokio::spawn(async move {
			let first = requests.recv_async().await.expect("request");
			assert!(first.prompt.after.contains("return (;"));
			first
				.reply
				.send_async(Ok(Str::new_static("export function value(): number {\n\treturn (1);\n}")))
				.await
				.expect("reply");
		});
		let observer = EditObserver::new(
			EditBlackboxConfig::default(),
			EditBlackboxModel::default(),
			Some(client),
		);
		let inspected = observer
			.inspect(snapshot(INVALID), "replace", &serde_json::Value::Null)
			.await;
		assert!(source_parses(std::str::from_utf8(&inspected.content).expect("utf8"), PATH));
		worker.await.expect("worker");

		let (client, requests) = EditRepairClient::channel();
		let worker = tokio::spawn(async move {
			for _ in 0..2 {
				let request = requests.recv_async().await.expect("request");
				request
					.reply
					.send_async(Ok(Str::new_static("export function value(): number {\n\treturn 1;\n}")))
					.await
					.expect("reply");
			}
		});
		let observer = EditObserver::new(
			EditBlackboxConfig::default(),
			EditBlackboxModel::default(),
			Some(client),
		);
		let inspected = observer
			.inspect(snapshot(INVALID), "replace", &serde_json::Value::Null)
			.await;
		assert_eq!(inspected.content, Bytes::copy_from_slice(INVALID.as_bytes()));
		tokio::time::timeout(Duration::from_secs(1), worker)
			.await
			.expect("worker timeout")
			.expect("worker");
	}
}
