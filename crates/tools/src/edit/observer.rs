//! Syntax-regression observation and bounded automatic edit repair.

use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc, time::Duration};

use bytes::Bytes;
use flume::{Receiver, Sender};
use omp_ast::summary::{SummarySettings, summarize_source};
use omp_core::{Str, sf};
use omp_tool::{Diag, DiagKind};
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
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
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

/// Optional valid-to-invalid recorder configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditBlackboxConfig {
	/// JSONL destination. Absence disables recording.
	pub path:             Option<PathBuf>,
	/// Active model identity captured with each record.
	pub model:            Str,
	/// Maximum bytes retained from each source image.
	pub max_source_bytes: usize,
	/// Maximum serialized invocation-argument bytes.
	pub max_args_bytes:   usize,
}

impl Default for EditBlackboxConfig {
	fn default() -> Self {
		Self {
			path:             None,
			model:            sf!("unknown"),
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

/// Type-erased cold completion future used only when a repair is requested.
type EditRepairFuture =
	Pin<Box<dyn Future<Output = Result<Str, EditRepairError>> + Send + 'static>>;
type EditRepairCompletion = dyn Fn(EditRepairPrompt) -> EditRepairFuture + Send + Sync + 'static;
type EditRepairModel = dyn Fn() -> Option<Str> + Send + Sync + 'static;

#[derive(Clone)]
enum EditRepairBackend {
	Channel(Sender<EditRepairRequest>),
	Completion(Arc<EditRepairCompletion>),
}

/// Cloneable client for an automatic-repair service.
#[derive(Clone)]
pub struct EditRepairClient {
	backend: EditRepairBackend,
	model:   Option<Arc<EditRepairModel>>,
}

impl std::fmt::Debug for EditRepairClient {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("EditRepairClient")
			.field("backend", &match &self.backend {
				EditRepairBackend::Channel(_) => "channel",
				EditRepairBackend::Completion(_) => "completion",
			})
			.field("has_model_identity", &self.model.is_some())
			.finish()
	}
}

impl EditRepairClient {
	/// Creates a client and its existing single-consumer request stream.
	pub fn channel() -> (Self, Receiver<EditRepairRequest>) {
		let (tx, rx) = flume::unbounded();
		(Self { backend: EditRepairBackend::Channel(tx), model: None }, rx)
	}

	/// Creates a client backed by a cold typed completion callback.
	///
	/// The callback is invoked only after an edit introduces a parse failure.
	/// Its future is boxed at that erased repair boundary, not on the normal
	/// edit path.
	pub fn from_completion<F, Fut>(completion: F) -> Self
	where
		F: Fn(EditRepairPrompt) -> Fut + Send + Sync + 'static,
		Fut: Future<Output = Result<Str, EditRepairError>> + Send + 'static,
	{
		Self {
			backend: EditRepairBackend::Completion(Arc::new(move |prompt| {
				Box::pin(completion(prompt))
			})),
			model:   None,
		}
	}

	/// Adds a dynamic model identity used only for blackbox record metadata.
	///
	/// Returning `None` preserves the model configured on the observer.
	pub fn with_model_identity<F>(mut self, model: F) -> Self
	where
		F: Fn() -> Option<Str> + Send + Sync + 'static,
	{
		self.model = Some(Arc::new(model));
		self
	}

	/// Requests one typed repair completion.
	///
	/// Channel-backed clients forward to the existing session repair service;
	/// callback-backed clients invoke their cold completion callback directly.
	pub async fn complete(&self, prompt: EditRepairPrompt) -> Result<Str, EditRepairError> {
		match &self.backend {
			EditRepairBackend::Channel(tx) => {
				let (reply, response) = flume::bounded(1);
				tx.send_async(EditRepairRequest { prompt, reply })
					.await
					.map_err(|_| EditRepairError::Unavailable)?;
				response
					.recv_async()
					.await
					.map_err(|_| EditRepairError::Unavailable)?
			},
			EditRepairBackend::Completion(completion) => completion(prompt).await,
		}
	}

	fn model_identity(&self) -> Option<Str> {
		self.model.as_ref().and_then(|model| model())
	}
}

/// Edit-level syntax policy shared by every edit dialect.
#[derive(Clone, Debug, Default)]
pub struct EditObserver {
	blackbox:    Arc<EditBlackboxConfig>,
	auto_repair: Option<EditRepairClient>,
	append_lock: Arc<parking_lot::Mutex<()>>,
}

impl EditObserver {
	/// Constructs an observer. `None` blackbox path and repair client disable
	/// all work.
	pub fn new(blackbox: EditBlackboxConfig, auto_repair: Option<EditRepairClient>) -> Self {
		Self {
			blackbox: Arc::new(blackbox),
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
		let Some(language) = parse_regression_language(&snapshot) else {
			return EditInspection { content: snapshot.after, diag: None, pending: None };
		};
		let pending = self.blackbox.path.as_ref().map(|_| PendingBlackbox {
			record: bounded_record(
				&snapshot,
				mode,
				args,
				&self.blackbox,
				self
					.auto_repair
					.as_ref()
					.and_then(EditRepairClient::model_identity),
			),
		});
		if let Some(client) = &self.auto_repair
			&& let Some(repaired) = repair_parse_regression(&snapshot, client).await
		{
			tracing::warn!(
				path = %snapshot.path,
				attempts = repaired.attempts,
				"automatic edit syntax repair applied",
			);
			return EditInspection {
				content: repaired.content,
				diag: Some(Diag::info(
					DiagKind::SyntaxRepaired,
					sf!(
						"{language}: automatic syntax repair succeeded in {} attempt(s)",
						repaired.attempts
					),
				)),
				pending,
			};
		}
		tracing::warn!(
			path = %snapshot.path,
			repair_enabled = self.auto_repair.is_some(),
			"edit introduced a syntax regression",
		);
		EditInspection {
			content: snapshot.after,
			diag: Some(Diag::warn(
				DiagKind::SyntaxBroken,
				sf!("{language}: no longer parses after this edit"),
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
	/// Structured repair or regression diagnostic.
	pub diag:    Option<Diag>,
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
	parse_regression_language(snapshot).is_some()
}

fn parse_regression_language(snapshot: &AppliedEditSnapshot) -> Option<Str> {
	let before = std::str::from_utf8(&snapshot.before).ok()?;
	let after = std::str::from_utf8(&snapshot.after).ok()?;
	let summary = summarize_source(before, SummarySettings {
		path: Some(&snapshot.path),
		..SummarySettings::default()
	})
	.ok()?;
	if !summary.parsed || source_parses(after, &snapshot.path) {
		return None;
	}
	summary.language.map(Str::new)
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
	model: Option<Str>,
) -> EditBlackboxRecord {
	EditBlackboxRecord {
		path:   snapshot.path.clone(),
		before: capture(&snapshot.before, config.max_source_bytes),
		after:  capture(&snapshot.after, config.max_source_bytes),
		model:  model.unwrap_or_else(|| config.model.clone()),
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
		let (client, requests) = EditRepairClient::channel();
		drop(requests);
		let observer = EditObserver::new(
			EditBlackboxConfig {
				path:             Some(log.clone()),
				model:            sf!("openai/test"),
				max_source_bytes: 24,
				max_args_bytes:   16,
			},
			Some(client),
		);
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
			assert!(inspected.diag.is_some());
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
		assert_eq!(record.model, "openai/test");
		assert_eq!(record.mode, "replace");
		assert!(record.before.truncated);
		assert_eq!(record.args["truncated"], true);
	}

	#[tokio::test]
	async fn callback_repair_uses_dynamic_model_only_for_record_metadata() {
		let prompts = Arc::new(parking_lot::Mutex::new(Vec::new()));
		let observed = Arc::clone(&prompts);
		let client = EditRepairClient::from_completion(move |prompt| {
			let observed = Arc::clone(&observed);
			async move {
				observed.lock().push(prompt);
				Ok(Str::new_static("export function value(): number {\n\treturn (1);\n}"))
			}
		})
		.with_model_identity(|| Some(sf!("session/edit-model")));
		let observer = EditObserver::new(
			EditBlackboxConfig {
				path: Some(PathBuf::from("unused.jsonl")),
				model: sf!("registry/model"),
				..EditBlackboxConfig::default()
			},
			Some(client),
		);

		let inspected = observer
			.inspect(snapshot(INVALID), "replace", &serde_json::Value::Null)
			.await;

		assert!(source_parses(std::str::from_utf8(&inspected.content).expect("utf8"), PATH));
		assert_eq!(inspected.pending.expect("record").record.model, "session/edit-model");
		let prompts = prompts.lock();
		assert_eq!(prompts.len(), 1);
		assert_eq!(prompts[0].language, "typescript");
		assert!(prompts[0].after.contains("return (;"));
		assert!(prompts[0].previous_attempt.is_none());
	}

	#[tokio::test]
	async fn public_channel_completion_preserves_typed_service_api() {
		let (client, requests) = EditRepairClient::channel();
		let worker = tokio::spawn(async move {
			let request = requests.recv_async().await.expect("request");
			assert_eq!(request.prompt.language, "rust");
			request
				.reply
				.send_async(Err(EditRepairError::Completion {
					message: sf!("provider rejected request"),
				}))
				.await
				.expect("reply");
		});
		let result = client
			.complete(EditRepairPrompt {
				language:         sf!("rust"),
				before:           Str::new_static("fn main() {}"),
				after:            Str::new_static("fn main( {}"),
				previous_attempt: None,
			})
			.await;

		assert_eq!(
			result,
			Err(EditRepairError::Completion { message: sf!("provider rejected request") })
		);
		worker.await.expect("worker");
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
		let observer = EditObserver::new(EditBlackboxConfig::default(), Some(client));
		let inspected = observer
			.inspect(snapshot(INVALID), "replace", &serde_json::Value::Null)
			.await;
		assert!(source_parses(std::str::from_utf8(&inspected.content).expect("utf8"), PATH));
		let repaired = inspected.diag.expect("syntax repair diagnostic");
		assert_eq!(repaired.native_kind(), Some(DiagKind::SyntaxRepaired));
		assert_eq!(repaired.severity, omp_tool::Severity::Info);
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
		let observer = EditObserver::new(EditBlackboxConfig::default(), Some(client));
		let inspected = observer
			.inspect(snapshot(INVALID), "replace", &serde_json::Value::Null)
			.await;
		assert_eq!(inspected.content, Bytes::copy_from_slice(INVALID.as_bytes()));
		let broken = inspected.diag.expect("syntax regression diagnostic");
		assert_eq!(broken.native_kind(), Some(DiagKind::SyntaxBroken));
		assert_eq!(broken.severity, omp_tool::Severity::Warn);
		tokio::time::timeout(Duration::from_secs(1), worker)
			.await
			.expect("worker timeout")
			.expect("worker");
	}
}
