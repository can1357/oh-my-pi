//! One edit session per tool call: accumulates streamed arguments, computes
//! previews, and finally stages + applies the edit through a host writer.
//!
//! Threading and callbacks live in the napi layer; this type is single
//! threaded and pure apart from file reads and the writer trait.

use std::path::PathBuf;

use async_trait::async_trait;

use crate::{
	diff_string::{CompactDiffOptions, build_compact_diff_preview},
	engine::{EditMode, FileOp, FileOpIntent, HeaderKind, ModeEngine, PreviewFile, StagedFile},
	error::{EditError, EditResult},
	files::{FileCache, FileSource},
	notebook,
	path_policy::{PathPolicy, UrlResolution, canonical_key},
	store::{EditStore, Snapshot, file_hash, seen_lines_from_body},
	stream_json::ArgStream,
	text::{normalize_to_lf, strip_bom, utf16_len},
};

/// Everything the host configures per tool call.
#[derive(Debug, Clone)]
pub struct SessionConfig {
	pub mode:               EditMode,
	pub policy:             PathPolicy,
	pub allow_fuzzy:        bool,
	pub fuzzy_threshold:    f64,
	pub enforce_seen_lines: bool,
	/// The payload is not JSON (custom-format tool): the buffer is `input`.
	pub raw_input:          bool,
}

/// One streamed preview pass. Empty `files` means "nothing to show yet";
/// consumers keep the previous batch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreviewBatch {
	/// Monotonically increasing per session.
	pub generation: u32,
	/// False for the final untrimmed pass after `finish()`.
	pub streaming:  bool,
	pub files:      Vec<PreviewFile>,
}

/// Host write request. Rust never touches disk for writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteRequest {
	pub absolute:     PathBuf,
	pub display:      String,
	pub op:           FileOp,
	/// Absolute destination for a rename; the host writes `content` there
	/// and deletes `absolute`.
	pub move_to:      Option<PathBuf>,
	/// Final bytes as text; `None` for deletes.
	pub content:      Option<String>,
	/// Last write of this call && the LSP batch requested a flush.
	pub flush_lsp:    bool,
	pub lsp_batch_id: Option<String>,
}

/// Host write response.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WriteResponse {
	/// Text actually persisted (a bridge may reformat); empty for deletes.
	pub written:          String,
	/// Diagnostics payload serialized by the host; opaque here.
	pub diagnostics_json: Option<String>,
}

/// Host-side byte owner.
#[async_trait]
pub trait EditWriter: Send + Sync {
	async fn write(&self, request: WriteRequest) -> EditResult<WriteResponse>;
}

/// Apply-time knobs.
#[derive(Debug, Clone, Default)]
pub struct ApplyRequest {
	pub lsp_batch_id: Option<String>,
	pub lsp_flush:    bool,
}

/// Per-file apply outcome.
#[derive(Debug, Clone)]
pub struct FileOutcome {
	pub absolute:           PathBuf,
	pub display:            String,
	pub op:                 FileOp,
	pub move_to:            Option<PathBuf>,
	pub diff:               String,
	pub first_changed_line: Option<u32>,
	pub old_text:           Option<String>,
	pub new_text:           Option<String>,
	/// `old_text`/`new_text` were dropped because their combined size
	/// exceeded [`MAX_EDIT_SNAPSHOT_TEXT_CHARS`].
	pub snapshots_pruned:   bool,
	pub diagnostics_json:   Option<String>,
	/// Engine warnings (also rendered in the `Warnings:` block).
	pub warnings:           Vec<String>,
	/// Rendered model-facing text for this file.
	pub text:               String,
	/// `before` parsed and `after` does not (`pi_ast` summary).
	pub parse_regressed:    bool,
}

/// Whole-call apply outcome.
#[derive(Debug, Clone, Default)]
pub struct ApplyOutcome {
	/// Per-file texts joined with `\n\n`.
	pub text:  String,
	pub files: Vec<FileOutcome>,
}

/// Combined `old_text + new_text` length (UTF-16 units) above which result
/// snapshots are pruned (`MAX_EDIT_SNAPSHOT_TEXT_CHARS`).
pub const MAX_EDIT_SNAPSHOT_TEXT_CHARS: usize = 32_768;

/// Separates completed edit sections in model-visible tool output.
pub const EDIT_RESULT_SEPARATOR: &str = "\n\n";

/// Per-call edit session.
pub struct Session {
	config:          SessionConfig,
	engine:          Box<dyn ModeEngine>,
	args:            ArgStream,
	files:           FileCache,
	store:           EditStore,
	generation:      u32,
	/// Generation the last preview was computed for.
	previewed:       u32,
	final_pass_done: bool,
	/// Apply began: URL answers provided from here on belong to apply.
	applying:        bool,
}

impl Session {
	pub fn new(config: SessionConfig, store: EditStore) -> Self {
		let engine = crate::modes::engine_for(
			config.mode,
			config.allow_fuzzy,
			config.fuzzy_threshold,
			config.enforce_seen_lines,
		);
		let files = FileCache::new(config.policy.clone());
		Self {
			args: ArgStream::new(config.raw_input),
			config,
			engine,
			files,
			store,
			generation: 0,
			previewed: 0,
			final_pass_done: false,
			applying: false,
		}
	}

	pub const fn store(&self) -> &EditStore {
		&self.store
	}

	pub const fn config(&self) -> &SessionConfig {
		&self.config
	}

	pub fn engine(&self) -> &dyn ModeEngine {
		self.engine.as_ref()
	}

	/// Append a raw argument fragment.
	pub fn push(&mut self, delta: &str) {
		self.args.push(delta);
		self.generation += 1;
	}

	/// Replace the buffer with the complete argument JSON (no-delta path).
	pub fn set_args_json(&mut self, json: &str) {
		self.args.replace(json);
		self.generation += 1;
	}

	/// Arguments are complete; the next preview is the final untrimmed pass.
	pub const fn finish(&mut self) {
		self.args.finish();
		self.generation += 1;
	}

	pub const fn is_finished(&self) -> bool {
		self.args.is_finished()
	}

	/// Whether a preview pass would produce something newer than the last.
	pub const fn preview_pending(&self) -> bool {
		self.generation != self.previewed || (self.args.is_finished() && !self.final_pass_done)
	}

	/// Drain internal URLs that missed the resolution table since the last
	/// call (deduped, first-seen order). Streaming passes record misses too:
	/// the host answers half-streamed URLs like any other (locating has no
	/// side effects), so previews never wait for the arguments to finish.
	pub fn take_unresolved(&mut self) -> Vec<String> {
		self.files.take_unresolved()
	}

	/// Record the host answer for `url`; clears cached reads/resolutions for
	/// it and makes [`Self::preview_pending`] true. Answers provided before
	/// the apply phase serve previews only.
	pub fn provide(&mut self, url: String, resolution: UrlResolution) {
		self.files.provide(url, resolution);
		self.generation += 1;
	}

	/// Enter the apply phase (idempotent) and list the internal URL targets
	/// the finished arguments name — section paths and move destinations,
	/// deduped in payload order — so the host can answer them all in one
	/// pass before [`Self::apply`] instead of one staging retry per URL.
	/// Entering the phase drops every preview-time answer: those were
	/// resolved before approval and without the call's abort signal. Empty
	/// while the arguments are incomplete.
	pub fn begin_apply_url_targets(&mut self) -> Vec<String> {
		self.begin_apply();
		let snapshot = self.args.snapshot();
		if !snapshot.complete {
			return Vec::new();
		}
		let inspection = self.engine.inspect(&snapshot);
		let moves = inspection.file_ops.iter().filter_map(|op| match op {
			FileOpIntent::Move { to, .. } => Some(to),
			FileOpIntent::Delete { .. } => None,
		});
		let policy = &self.config.policy;
		let mut targets: Vec<String> = Vec::new();
		for authored in inspection.paths.iter().chain(moves) {
			if let Some(url) = policy.url_target(authored)
				&& !targets.iter().any(|known| *known == url)
			{
				targets.push(url.into_owned());
			}
		}
		targets
	}

	/// Switch to the apply phase once, forgetting preview-time URL answers.
	fn begin_apply(&mut self) {
		if !self.applying {
			self.applying = true;
			self.files.forget_urls();
		}
	}

	/// Compute the preview for the current buffer. While streaming, trailing
	/// removal-only tails are trimmed so additions never visibly "catch up".
	pub fn preview(&mut self) -> PreviewBatch {
		let generation = self.generation;
		let streaming = !self.args.is_finished();
		let snapshot = self.args.snapshot();
		let mut files = self
			.engine
			.preview(&snapshot, streaming, &mut self.files, &self.store);
		if streaming {
			for file in &mut files {
				if let Some(diff) = file.diff.take() {
					file.diff = Some(strip_trailing_unbalanced_removal(&diff).into_owned());
				}
			}
		} else {
			self.final_pass_done = true;
		}
		self.previewed = generation;
		PreviewBatch { generation, streaming, files }
	}

	/// Stage and apply the finished arguments through `writer`.
	///
	/// Order: reread every target fresh, stage all files in memory (any
	/// failure aborts before the first write), enforce the plan-mode guard
	/// for every file, then write in payload order. A writer failure aborts
	/// the loop; files already written stay written and the error is
	/// returned verbatim. URL targets never reuse preview-time answers (see
	/// [`Self::begin_apply_url_targets`]).
	///
	/// # Errors
	/// Staging and plan-mode failures, all raised before the first write —
	/// including [`EditError::UnresolvedUrl`], after which the host may
	/// [`Self::provide`] the URL and retry — or the writer's error.
	pub async fn apply(
		&mut self,
		request: ApplyRequest,
		writer: &dyn EditWriter,
	) -> EditResult<ApplyOutcome> {
		self.begin_apply();
		self.files.clear();
		let snapshot = self.args.snapshot();
		if !snapshot.complete {
			return Err(EditError::parse("Edit arguments were incomplete"));
		}
		let staged = self.engine.stage(&snapshot, &mut self.files, &self.store)?;
		for file in &staged {
			self.files.enforce_write(
				&file.display,
				file.op,
				file.move_to.as_ref().map(|m| m.display.as_str()),
			)?;
		}

		let last_write = staged.iter().rposition(|file| file.op != FileOp::Noop);
		let mut files = Vec::with_capacity(staged.len());
		for (index, mut file) in staged.into_iter().enumerate() {
			let canonical = canonical_key(&file.absolute);
			let response = if file.op == FileOp::Noop {
				WriteResponse::default()
			} else {
				writer
					.write(WriteRequest {
						absolute:     file.absolute.clone(),
						display:      file.display.clone(),
						op:           file.op,
						move_to:      file.move_to.as_ref().map(|m| m.absolute.clone()),
						content:      file.persisted.clone(),
						flush_lsp:    request.lsp_flush && last_write == Some(index),
						lsp_batch_id: request.lsp_batch_id.clone(),
					})
					.await?
			};

			let mut tag: Option<String> = None;
			// Updated files register their response rows (plus still-valid prior
			// provenance) against the minted tag: (store key, carried lines, drifted).
			let mut provenance: Option<(PathBuf, Vec<u32>, bool)> = None;
			match file.op {
				FileOp::Delete => self.store.invalidate(&canonical),
				FileOp::Noop => {
					if file.record_snapshot {
						tag = Some(self.store.record(&canonical, &file.after, None));
					}
				},
				FileOp::Create | FileOp::Update => {
					let dest_canonical = file.move_to.as_ref().map(|m| canonical_key(&m.absolute));
					let track_provenance = file.record_snapshot && file.op == FileOp::Update;
					let prior = if track_provenance {
						self.store.by_content(&canonical, &file.before)
					} else {
						None
					};
					if let Some(dest) = &dest_canonical {
						self.store.relocate(&canonical, dest);
					}
					if file.record_snapshot {
						let recorded = recorded_view(&file, &response.written);
						let drifted = recorded != file.after;
						if dest_canonical.is_none() && drifted {
							file.warnings.push(write_drift_warning(&file.display));
						}
						let key = dest_canonical.unwrap_or_else(|| canonical.clone());
						tag = Some(self.store.record(&key, &recorded, None));
						if track_provenance {
							let carried = carried_seen_lines(&file.before, &recorded, prior.as_ref());
							provenance = Some((key, carried, drifted));
						}
					}
					self.store.reset_noop(&canonical);
				},
			}
			if let Some(clipboard) = file.clipboard_after.take() {
				self.store.commit_clipboard(&clipboard);
			}

			let header_path = file
				.move_to
				.as_ref()
				.map_or(file.display.as_str(), |m| m.display.as_str());
			let response_tag = match file.header {
				HeaderKind::HashlineTag => Some(tag.unwrap_or_else(|| file_hash(&file.after))),
				HeaderKind::Path => None,
			};
			let header = response_tag
				.as_ref()
				.map_or_else(|| format!("[{header_path}]"), |tag| format!("[{header_path}#{tag}]"));
			let text = format_file_text(&file, &header);
			if let (Some((key, mut seen_lines, drifted)), Some(tag)) = (provenance, &response_tag) {
				// A drifted write shows rows of the previewed text, not of the recorded
				// version the tag names, so only carried lines stay anchorable.
				if !drifted {
					seen_lines.extend(seen_lines_from_body(&text));
				}
				if !seen_lines.is_empty() {
					self.store.record_seen_lines(&key, tag, &seen_lines);
				}
			}
			let parse_regressed = file.op != FileOp::Delete
				&& file.op != FileOp::Noop
				&& file.existed
				&& source_parses(&file.before, &file.display)
				&& !source_parses(&file.after, &file.display);

			let old_text = if file.op == FileOp::Create {
				None
			} else {
				file.before_raw.clone()
			};
			let new_text = match file.op {
				FileOp::Delete => None,
				FileOp::Noop => file.before_raw.clone(),
				_ => Some(response.written.clone()),
			};
			let (old_text, new_text, snapshots_pruned) = prune_snapshots(old_text, new_text);

			files.push(FileOutcome {
				absolute: file.absolute.clone(),
				display: file.display.clone(),
				op: file.op,
				move_to: file.move_to.as_ref().map(|m| m.absolute.clone()),
				diff: file.diff.clone(),
				first_changed_line: file.first_changed_line,
				old_text,
				new_text,
				snapshots_pruned,
				diagnostics_json: response.diagnostics_json,
				warnings: file.warnings.clone(),
				text,
				parse_regressed,
			});
		}

		let text = files
			.iter()
			.map(|file| file.text.as_str())
			.filter(|text| !text.is_empty())
			.collect::<Vec<_>>()
			.join(EDIT_RESULT_SEPARATOR);
		Ok(ApplyOutcome { text, files })
	}
}

/// The editable (view-space) text that actually landed on disk: `after`
/// when the host persisted exactly what was sent, otherwise re-derived from
/// the reported bytes (notebook JSON decoded back to cell text; a broken
/// notebook falls back to `after`).
fn recorded_view(file: &StagedFile, written: &str) -> String {
	if file.persisted.as_deref() == Some(written) {
		return file.after.clone();
	}
	if notebook::is_notebook_path(&file.absolute) {
		return notebook::notebook_to_editable_text(written, &file.display)
			.map_or_else(|_| file.after.clone(), |text| normalize_to_lf(&text).into_owned());
	}
	normalize_to_lf(strip_bom(written).1).into_owned()
}

/// Prior-snapshot lines that keep both their number and content in `after`:
/// the unchanged leading run, filtered by what `prior` displayed. A missing or
/// unrestricted prior snapshot let the edit anchor anywhere, so the whole run
/// carries over. Lines after the first change shifted, so their old numbers
/// never carry.
fn carried_seen_lines(before: &str, after: &str, prior: Option<&Snapshot>) -> Vec<u32> {
	let unchanged = before
		.split('\n')
		.zip(after.split('\n'))
		.take_while(|(old, new)| old == new)
		.count();
	let unchanged = u32::try_from(unchanged).unwrap_or(u32::MAX);
	match prior.and_then(|snapshot| snapshot.seen_lines.as_ref()) {
		// `range(1..=0)` panics; a first-line change carries nothing.
		_ if unchanged == 0 => Vec::new(),
		Some(seen) if !seen.is_empty() => seen.range(1..=unchanged).copied().collect(),
		_ => (1..=unchanged).collect(),
	}
}

/// Model-facing text for one file (`formatEditResultText`).
fn format_file_text(file: &StagedFile, header: &str) -> String {
	if let Some(text) = &file.text_override {
		return text.clone();
	}
	if file.op == FileOp::Delete {
		return format!("Deleted {}", file.display);
	}
	let preview_source = file.preview_diff.as_deref().unwrap_or(&file.diff);
	let preview = build_compact_diff_preview(preview_source, &CompactDiffOptions::default()).preview;
	let mut lines: Vec<&str> = vec![header];
	lines.extend(file.before_preview.iter().map(String::as_str));
	let moved = file
		.move_to
		.as_ref()
		.map(|m| format!("Moved to {}", m.display));
	if let Some(moved) = &moved {
		lines.push(moved);
	}
	if !preview.is_empty() {
		lines.push(&preview);
	}
	lines.extend(file.after_preview.iter().map(String::as_str));
	let body = lines
		.into_iter()
		.filter(|line| !line.is_empty())
		.collect::<Vec<_>>()
		.join("\n");
	let warnings: Vec<&str> = file
		.warnings
		.iter()
		.map(String::as_str)
		.filter(|w| !w.is_empty())
		.collect();
	if warnings.is_empty() {
		body
	} else {
		format!("{body}\n\nWarnings:\n{}", warnings.join("\n"))
	}
}

/// `pruneOversizedEditSnapshots` for a single file.
fn prune_snapshots(
	old: Option<String>,
	new: Option<String>,
) -> (Option<String>, Option<String>, bool) {
	let size = old.as_deref().map_or(0, utf16_len) + new.as_deref().map_or(0, utf16_len);
	if size <= MAX_EDIT_SNAPSHOT_TEXT_CHARS {
		(old, new, false)
	} else {
		(None, None, true)
	}
}

/// True when tree-sitter parses `code` (language from `path`) without
/// errors. Unknown languages never "parse", so they never regress.
pub fn source_parses(code: &str, path: &str) -> bool {
	let code = if code.is_empty() { "\n" } else { code };
	pi_ast::summary::summarize_code(pi_ast::summary::SummaryOptions {
		code:               code.to_owned(),
		lang:               None,
		path:               Some(path.to_owned()),
		min_body_lines:     None,
		min_comment_lines:  None,
		unfold_until_lines: None,
		unfold_limit_lines: None,
	})
	.is_ok_and(|summary| summary.parsed)
}

/// The persisted bytes differ from what was sent (an editor reformatted on
/// save); the recorded snapshot reflects the real file.
pub fn write_drift_warning(path: &str) -> String {
	format!(
		"{path}: the file on disk after this write differs from what was sent — the client \
		 (editor/IDE) likely reformatted it on save (e.g. format-on-save, tab/space settings). The \
		 returned snapshot reflects the actual file; re-read before further edits if the extra \
		 changes were unexpected."
	)
}

/// Drop trailing removal / hunk-header rows that precede their matching
/// `+` rows in a streaming diff, so previews grow at the bottom instead of
/// showing removals first.
pub fn strip_trailing_unbalanced_removal(diff: &str) -> std::borrow::Cow<'_, str> {
	if diff.is_empty() {
		return std::borrow::Cow::Borrowed(diff);
	}
	let lines: Vec<&str> = diff.split('\n').collect();
	let last_add = lines.iter().rposition(|line| line.starts_with('+'));
	let tail_start = last_add.map_or(0, |i| i + 1);
	let unbalanced = lines[tail_start..]
		.iter()
		.any(|line| line.starts_with('-') || line.starts_with("@@"));
	if !unbalanced {
		return std::borrow::Cow::Borrowed(diff);
	}
	match last_add {
		None => std::borrow::Cow::Borrowed(""),
		Some(i) => std::borrow::Cow::Owned(lines[..=i].join("\n")),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn trailing_removal_is_trimmed_while_streaming() {
		assert_eq!(strip_trailing_unbalanced_removal("+1|a\n-2|b\n-3|c"), "+1|a");
		assert_eq!(strip_trailing_unbalanced_removal("-2|b"), "");
		assert_eq!(strip_trailing_unbalanced_removal("-1|a\n+1|b\n 2|c"), "-1|a\n+1|b\n 2|c");
	}

	#[test]
	fn snapshot_pruning_uses_combined_budget() {
		let big = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		assert_eq!(prune_snapshots(Some(big.clone()), None), (Some(big.clone()), None, false));
		assert_eq!(prune_snapshots(Some(big), Some("y".into())), (None, None, true));
	}
}
