//! N-API wrappers and streaming support for jsdiff-compatible diff primitives.
//!
//! The Myers, line, word, and structured-patch implementation lives in
//! `pi-diff`. This module preserves JavaScript's UTF-16 code units at the N-API
//! boundary and owns the incremental [`DiffStream`] state.
//!
//! # Example
//! ```ignore
//! // JS: native.diffLines("a\nb\n", "a\nc\n")
//! //   -> [{ value: "a\n", count: 1, added: false, removed: false },
//! //       { value: "b\n", count: 1, added: false, removed: true },
//! //       { value: "c\n", count: 1, added: true, removed: false }]
//! ```

use std::{fs::File, io::Read, path::PathBuf, sync::Arc};

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;
use parking_lot::Mutex;

use crate::{js, task};

/// UTF-16 code unit for `\n`.
const LF: u16 = 0x000a;

/// One jsdiff change object: a run of added, removed, or common tokens.
#[napi(object)]
pub struct DiffChange {
	/// Joined token text for this run (lines keep their `\n` terminators).
	pub value:   Utf16String,
	/// Number of tokens in this run.
	pub count:   u32,
	/// True when this run exists only in the new text.
	pub added:   bool,
	/// True when this run exists only in the old text.
	pub removed: bool,
}

/// A change run without its token text, for callers that only need counts.
#[napi(object)]
pub struct DiffRun {
	/// Number of tokens in this run.
	pub count:   u32,
	/// True when this run exists only in the new text.
	pub added:   bool,
	/// True when this run exists only in the old text.
	pub removed: bool,
}

/// One hunk of a unified diff, matching jsdiff `structuredPatch` hunks.
#[napi(object)]
pub struct PatchHunk {
	/// 1-based first line of the hunk in the old text.
	pub old_start: u32,
	/// Number of old-text lines covered by the hunk.
	pub old_lines: u32,
	/// 1-based first line of the hunk in the new text.
	pub new_start: u32,
	/// Number of new-text lines covered by the hunk.
	pub new_lines: u32,
	/// Hunk body: `+`/`-`/` `-prefixed lines without trailing newlines, plus
	/// `\ No newline at end of file` markers where applicable.
	pub lines:     Vec<Utf16String>,
}

/// One side of a streamed line diff.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum DiffSide {
	/// Original/base text.
	Old,
	/// Updated/target text.
	New,
}

/// Observable ingestion state for [`DiffStream`].
#[napi(object)]
pub struct DiffStreamProgress {
	/// Complete old-side lines available for rendering.
	pub old_lines:           u32,
	/// Complete new-side lines available for rendering.
	pub new_lines:           u32,
	/// Leading complete lines proven equal on both sides.
	pub stable_common_lines: u32,
	/// Whether old-side ingestion has finished.
	pub old_done:            bool,
	/// Whether new-side ingestion has finished.
	pub new_done:            bool,
	/// Whether either side contains a NUL byte/code unit.
	pub binary:              bool,
	/// Whether either native file exceeded its caller-provided size limit.
	pub too_large:           bool,
}

/// Exact line-diff output produced when a [`DiffStream`] finishes.
#[napi(object)]
pub struct DiffStreamResult {
	/// Line-token Myers runs used to align the complete files.
	pub runs:             Vec<DiffRun>,
	/// Unified hunks for the requested context.
	pub hunks:            Vec<PatchHunk>,
	/// Whether the old text ends in a newline.
	pub old_ends_newline: bool,
	/// Whether the new text ends in a newline.
	pub new_ends_newline: bool,
}

// ═══════════════════════════════════════════════════════════════════════════
// Line diff
// ═══════════════════════════════════════════════════════════════════════════

/// Line diff with jsdiff `diffLines(oldText, newText)` semantics (default
/// options). Change values keep line terminators, and common runs are joined
/// from the new text.
#[napi]
pub fn diff_lines(old_text: JsString, new_text: JsString) -> Result<Vec<DiffChange>> {
	let old_text = js::utf16(old_text)?;
	let new_text = js::utf16(new_text)?;
	Ok(diff_lines_impl(&old_text, &new_text))
}

fn diff_lines_impl(old_text: &[u16], new_text: &[u16]) -> Vec<DiffChange> {
	pi_diff::diff_lines_u16(old_text, new_text)
		.into_iter()
		.map(|change| DiffChange {
			value:   change.value.into(),
			count:   change.count,
			added:   change.added,
			removed: change.removed,
		})
		.collect()
}

/// Diff `oldText.split("\n")` against `newText.split("\n")` with jsdiff
/// `diffArrays` semantics (exact code-unit equality, empty lines preserved),
/// returning only run lengths.
///
/// Callers that map line numbers — like hashline recovery — need the counts,
/// not another copy of the text.
#[napi]
pub fn diff_line_runs(old_text: JsString, new_text: JsString) -> Result<Vec<DiffRun>> {
	let old_text = js::utf16(old_text)?;
	let new_text = js::utf16(new_text)?;
	Ok(diff_line_runs_impl(&old_text, &new_text))
}

fn diff_line_runs_impl(old_text: &[u16], new_text: &[u16]) -> Vec<DiffRun> {
	let old_tokens: Vec<&[u16]> = old_text.split(|&unit| unit == LF).collect();
	let new_tokens: Vec<&[u16]> = new_text.split(|&unit| unit == LF).collect();
	let (old_ids, new_ids) = pi_diff::intern(&old_tokens, &new_tokens);
	pi_diff::myers_diff(&old_ids, &new_ids)
		.into_iter()
		.map(|run| DiffRun { count: run.count, added: run.added, removed: run.removed })
		.collect()
}

// ═══════════════════════════════════════════════════════════════════════════
// Streaming line diff
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Default)]
struct StreamSide {
	text:         Vec<u16>,
	line_ends:    Vec<usize>,
	pending_utf8: Vec<u8>,
	started:      bool,
	reading:      bool,
	done:         bool,
	binary:       bool,
	too_large:    bool,
}

impl StreamSide {
	fn append_units(&mut self, units: &[u16]) {
		let start = self.text.len();
		self.text.extend_from_slice(units);
		self.binary |= units.contains(&0);
		for (offset, unit) in units.iter().enumerate() {
			if *unit == LF {
				self.line_ends.push(start + offset + 1);
			}
		}
	}

	fn append_text(&mut self, chunk: JsString<'_>) -> Result<()> {
		self.ensure_pushable()?;
		let span = js::utf16_append(chunk, &mut self.text)?;
		self.binary |= self.text[span.clone()].contains(&0);
		for offset in span {
			if self.text[offset] == LF {
				self.line_ends.push(offset + 1);
			}
		}
		Ok(())
	}

	fn append_bytes(&mut self, chunk: &[u8]) -> Result<()> {
		self.ensure_pushable()?;
		self.append_utf8(chunk, false);
		Ok(())
	}

	fn ensure_pushable(&mut self) -> Result<()> {
		if self.done {
			return Err(Error::from_reason("Cannot push to a finished diff side"));
		}
		if self.reading {
			return Err(Error::from_reason("Cannot push while a native file read is active"));
		}
		self.started = true;
		Ok(())
	}

	fn append_utf8(&mut self, bytes: &[u8], final_chunk: bool) {
		self.binary |= bytes.contains(&0);
		self.pending_utf8.extend_from_slice(bytes);
		let mut decoded = Vec::with_capacity(self.pending_utf8.len());
		let mut offset = 0usize;
		while offset < self.pending_utf8.len() {
			match std::str::from_utf8(&self.pending_utf8[offset..]) {
				Ok(text) => {
					decoded.extend(text.encode_utf16());
					offset = self.pending_utf8.len();
				},
				Err(error) => {
					let valid_end = offset + error.valid_up_to();
					// SAFETY: `valid_up_to` is the UTF-8 parser's verified prefix.
					let valid =
						unsafe { std::str::from_utf8_unchecked(&self.pending_utf8[offset..valid_end]) };
					decoded.extend(valid.encode_utf16());
					offset = valid_end;
					if let Some(invalid_len) = error.error_len() {
						decoded.push(char::REPLACEMENT_CHARACTER as u16);
						offset += invalid_len;
					} else {
						break;
					}
				},
			}
		}
		if final_chunk && offset < self.pending_utf8.len() {
			decoded.push(char::REPLACEMENT_CHARACTER as u16);
			offset = self.pending_utf8.len();
		}
		if offset > 0 {
			self.pending_utf8.drain(..offset);
		}
		self.append_units(&decoded);
	}

	fn finish(&mut self) {
		if self.done {
			return;
		}
		if !self.pending_utf8.is_empty() {
			self.append_utf8(&[], true);
		}
		if !self.text.is_empty() && self.text.last() != Some(&LF) {
			self.line_ends.push(self.text.len());
		}
		self.done = true;
		self.reading = false;
	}

	fn line(&self, index: usize) -> &[u16] {
		let start = index
			.checked_sub(1)
			.map_or(0, |previous| self.line_ends[previous]);
		&self.text[start..self.line_ends[index]]
	}

	fn display_line(&self, index: usize) -> Utf16String {
		let line = self.line(index);
		let end = line
			.len()
			.saturating_sub(usize::from(line.last() == Some(&LF)));
		line[..end].to_vec().into()
	}
}

#[derive(Default)]
struct DiffStreamState {
	old:           StreamSide,
	new:           StreamSide,
	stable_common: usize,
}

impl DiffStreamState {
	const fn side(&self, side: DiffSide) -> &StreamSide {
		match side {
			DiffSide::Old => &self.old,
			DiffSide::New => &self.new,
		}
	}

	const fn side_mut(&mut self, side: DiffSide) -> &mut StreamSide {
		match side {
			DiffSide::Old => &mut self.old,
			DiffSide::New => &mut self.new,
		}
	}

	fn update_stable_common(&mut self) {
		let available = self.old.line_ends.len().min(self.new.line_ends.len());
		while self.stable_common < available
			&& self.old.line(self.stable_common) == self.new.line(self.stable_common)
		{
			self.stable_common += 1;
		}
	}

	const fn progress(&self) -> DiffStreamProgress {
		DiffStreamProgress {
			old_lines:           self.old.line_ends.len() as u32,
			new_lines:           self.new.line_ends.len() as u32,
			stable_common_lines: self.stable_common as u32,
			old_done:            self.old.done,
			new_done:            self.new.done,
			binary:              self.old.binary || self.new.binary,
			too_large:           self.old.too_large || self.new.too_large,
		}
	}
}

/// Incrementally ingests old/new text and computes an exact line diff on a
/// worker thread once both sides finish.
///
/// Complete lines are observable during ingestion. Only equal leading lines
/// are declared stable before EOF; future input can change Myers alignment
/// after the first mismatch.
#[derive(Default)]
#[napi]
pub struct DiffStream {
	state: Arc<Mutex<DiffStreamState>>,
}

#[napi]
impl DiffStream {
	/// Create an empty two-sided stream.
	#[napi(constructor)]
	pub fn new() -> Self {
		Self::default()
	}

	/// Append a JavaScript text chunk to one side.
	#[napi]
	pub fn push(&self, side: DiffSide, chunk: JsString) -> Result<DiffStreamProgress> {
		let mut state = self.state.lock();
		state.side_mut(side).append_text(chunk)?;
		state.update_stable_common();
		Ok(state.progress())
	}

	/// Append a UTF-8 subprocess/file chunk without a JS string conversion.
	#[napi]
	pub fn push_bytes(&self, side: DiffSide, chunk: Uint8Array) -> Result<DiffStreamProgress> {
		let mut state = self.state.lock();
		state.side_mut(side).append_bytes(&chunk)?;
		state.update_stable_common();
		Ok(state.progress())
	}

	/// Mark one side complete; an unfinished final line then becomes visible.
	#[napi]
	pub fn finish_side(&self, side: DiffSide) -> Result<DiffStreamProgress> {
		let mut state = self.state.lock();
		if state.side(side).reading {
			return Err(Error::from_reason(
				"Cannot finish a side while its native file read is active",
			));
		}
		state.side_mut(side).finish();
		state.update_stable_common();
		Ok(state.progress())
	}

	/// Mark one side too large and complete without further ingestion.
	#[napi]
	pub fn mark_too_large(&self, side: DiffSide) -> DiffStreamProgress {
		let mut state = self.state.lock();
		let stream = state.side_mut(side);
		stream.too_large = true;
		stream.finish();
		state.update_stable_common();
		state.progress()
	}

	/// Current ingestion state.
	#[napi]
	pub fn progress(&self) -> DiffStreamProgress {
		self.state.lock().progress()
	}

	/// Complete display lines from `from`, excluding newline terminators.
	#[napi]
	pub fn lines(&self, side: DiffSide, from: u32, limit: Option<u32>) -> Vec<Utf16String> {
		let state = self.state.lock();
		let stream = state.side(side);
		let start = (from as usize).min(stream.line_ends.len());
		let end = start
			.saturating_add(limit.map_or(usize::MAX, |value| value as usize))
			.min(stream.line_ends.len());
		(start..end)
			.map(|index| stream.display_line(index))
			.collect()
	}

	/// Snapshot all ingested text for one side.
	#[napi]
	pub fn text(&self, side: DiffSide) -> Utf16String {
		self.state.lock().side(side).text.clone().into()
	}

	/// Read a filesystem path directly into one side on the native worker pool.
	///
	/// JavaScript can poll [`DiffStream::progress`] and [`DiffStream::lines`]
	/// while this promise is pending; file bytes never need to cross into JS
	/// and back into the differ.
	#[napi]
	pub fn open_file(
		&self,
		side: DiffSide,
		path: JsString,
		max_bytes: Option<u32>,
		signal: Option<Unknown>,
	) -> Result<task::Promise<DiffStreamProgress>> {
		let path = PathBuf::from(js::utf8(path)?.to_string());
		{
			let mut state = self.state.lock();
			let stream = state.side_mut(side);
			if stream.started || stream.done {
				return Err(Error::from_reason("Diff side has already started"));
			}
			stream.started = true;
			stream.reading = true;
		}
		let state = Arc::clone(&self.state);
		let cancel = task::CancelToken::new(None, signal);
		Ok(task::blocking("diff.open_file", cancel, move |ct| {
			let result = read_file_into_stream(&state, side, &path, max_bytes.map(u64::from), &ct);
			let mut locked = state.lock();
			locked.side_mut(side).reading = false;
			if result.is_err() {
				locked.side_mut(side).done = true;
			}
			locked.update_stable_common();
			let progress = locked.progress();
			drop(locked);
			result?;
			Ok(progress)
		}))
	}

	/// Compute exact Myers runs and unified hunks off the JavaScript thread.
	#[napi]
	pub fn finish(&self, context: Option<u32>) -> Result<task::Promise<DiffStreamResult>> {
		let state = self.state.lock();
		if !state.old.done || !state.new.done {
			return Err(Error::from_reason("Both diff sides must finish before computing the result"));
		}
		let old = state.old.text.clone();
		let new = state.new.text.clone();
		drop(state);
		Ok(task::blocking("diff.finish", (), move |_| Ok(stream_result(&old, &new, context))))
	}
}

fn read_file_into_stream(
	state: &Arc<Mutex<DiffStreamState>>,
	side: DiffSide,
	path: &PathBuf,
	max_bytes: Option<u64>,
	cancel: &task::CancelToken,
) -> Result<()> {
	let mut file = File::open(path).map_err(|error| {
		Error::from_reason(format!("Failed to open streamed file {}: {error}", path.display()))
	})?;
	let size = file
		.metadata()
		.map_err(|error| {
			Error::from_reason(format!("Failed to inspect streamed file {}: {error}", path.display()))
		})?
		.len();
	if max_bytes.is_some_and(|limit| size > limit) {
		let mut locked = state.lock();
		let stream = locked.side_mut(side);
		stream.too_large = true;
		stream.finish();
		locked.update_stable_common();
		return Ok(());
	}

	let mut buffer = vec![0u8; 64 * 1024];
	loop {
		cancel.heartbeat()?;
		let read = file.read(&mut buffer).map_err(|error| {
			Error::from_reason(format!("Failed to read streamed file {}: {error}", path.display()))
		})?;
		if read == 0 {
			break;
		}
		let mut locked = state.lock();
		locked.side_mut(side).append_utf8(&buffer[..read], false);
		locked.update_stable_common();
		if locked.side(side).binary {
			break;
		}
	}
	let mut locked = state.lock();
	locked.side_mut(side).finish();
	locked.update_stable_common();
	Ok(())
}

fn stream_result(old_text: &[u16], new_text: &[u16], context: Option<u32>) -> DiffStreamResult {
	let old_tokens = pi_diff::line_tokens_u16(old_text);
	let new_tokens = pi_diff::line_tokens_u16(new_text);
	let runs = pi_diff::line_runs_u16(old_text, new_text);
	let exposed_runs = runs
		.iter()
		.map(|run| DiffRun { count: run.count, added: run.added, removed: run.removed })
		.collect();
	let hunks =
		pi_diff::structured_patch_hunks_from_runs_u16(context, &old_tokens, &new_tokens, &runs)
			.into_iter()
			.map(patch_hunk)
			.collect();
	DiffStreamResult {
		runs: exposed_runs,
		hunks,
		old_ends_newline: old_text.last() == Some(&LF),
		new_ends_newline: new_text.last() == Some(&LF),
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Structured patch
// ═══════════════════════════════════════════════════════════════════════════

/// Unified-diff hunks with jsdiff
/// `structuredPatch(_, _, oldText, newText, _, _, { context }).hunks`
/// semantics. `context` defaults to 4 like jsdiff.
#[napi]
pub fn structured_patch_hunks(
	old_text: JsString,
	new_text: JsString,
	context: Option<u32>,
) -> Result<Vec<PatchHunk>> {
	let old_text = js::utf16(old_text)?;
	let new_text = js::utf16(new_text)?;
	Ok(structured_patch_hunks_impl(&old_text, &new_text, context))
}

fn structured_patch_hunks_impl(
	old_text: &[u16],
	new_text: &[u16],
	context: Option<u32>,
) -> Vec<PatchHunk> {
	pi_diff::structured_patch_hunks_u16(old_text, new_text, context)
		.into_iter()
		.map(patch_hunk)
		.collect()
}

fn patch_hunk(hunk: pi_diff::Hunk) -> PatchHunk {
	PatchHunk {
		old_start: hunk.old_start,
		old_lines: hunk.old_lines,
		new_start: hunk.new_start,
		new_lines: hunk.new_lines,
		lines:     hunk.lines.into_iter().map(Utf16String::from).collect(),
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Word diff
// ═══════════════════════════════════════════════════════════════════════════

/// Word diff with jsdiff `diffWords(oldText, newText)` semantics (default
/// options).
///
/// Tokens carry surrounding whitespace, equality ignores it, and the
/// post-pass dedupes whitespace across change boundaries.
#[napi]
pub fn diff_words(old_text: JsString, new_text: JsString) -> Result<Vec<DiffChange>> {
	let old_text = js::utf16(old_text)?;
	let new_text = js::utf16(new_text)?;
	Ok(diff_words_impl(&old_text, &new_text))
}

fn diff_words_impl(old_text: &[u16], new_text: &[u16]) -> Vec<DiffChange> {
	pi_diff::diff_words_u16(old_text, new_text)
		.into_iter()
		.map(|change| DiffChange {
			value:   change.value.into(),
			count:   change.count,
			added:   change.added,
			removed: change.removed,
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn u16s(text: &str) -> Vec<u16> {
		text.encode_utf16().collect()
	}

	#[test]
	fn stream_progress_exposes_only_stable_complete_prefix() {
		let mut state = DiffStreamState::default();
		state.old.append_units(&u16s("same\nold"));
		state.new.append_units(&u16s("same\nnew"));
		state.update_stable_common();
		assert_eq!(state.progress().stable_common_lines, 1);
		assert_eq!(state.progress().old_lines, 1);
		assert_eq!(state.progress().new_lines, 1);

		state.old.finish();
		state.new.finish();
		state.update_stable_common();
		assert_eq!(state.progress().stable_common_lines, 1);
		assert_eq!(state.progress().old_lines, 2);
		assert_eq!(state.progress().new_lines, 2);
	}

	#[test]
	fn stream_utf8_decoder_preserves_code_points_split_across_chunks() {
		let mut side = StreamSide::default();
		let bytes = "a🚀b\n".as_bytes();
		side.append_utf8(&bytes[..3], false);
		side.append_utf8(&bytes[3..5], false);
		side.append_utf8(&bytes[5..], false);
		side.finish();
		assert_eq!(String::from_utf16(&side.text).unwrap(), "a🚀b\n");
		assert_eq!(side.line_ends.len(), 1);
	}

	#[test]
	fn streamed_result_matches_exact_hunk_builder() {
		let old = u16s("a\nb\nc\n");
		let new = u16s("a\nx\nc\n");
		let result = stream_result(&old, &new, Some(3));
		let exact = structured_patch_hunks_impl(&old, &new, Some(3));
		assert_eq!(result.hunks.len(), exact.len());
		assert_eq!(result.runs.iter().map(|run| run.count).sum::<u32>(), 4);
		let streamed_lines: Vec<Vec<u16>> = result.hunks[0]
			.lines
			.iter()
			.map(|line| line.to_vec())
			.collect();
		let exact_lines: Vec<Vec<u16>> = exact[0].lines.iter().map(|line| line.to_vec()).collect();
		assert_eq!(streamed_lines, exact_lines);
	}

	#[test]
	fn native_file_stream_reads_without_js_text_round_trip() {
		let path = std::env::temp_dir().join(format!(
			"pi-native-diff-stream-{}-{}.txt",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		std::fs::write(&path, "first\nsecond\n").unwrap();
		let state = Arc::new(Mutex::new(DiffStreamState::default()));
		read_file_into_stream(
			&state,
			DiffSide::New,
			&path,
			Some(1024),
			&task::CancelToken::default(),
		)
		.unwrap();
		let locked = state.lock();
		assert_eq!(String::from_utf16(&locked.new.text).unwrap(), "first\nsecond\n");
		assert_eq!(locked.new.line_ends.len(), 2);
		drop(locked);
		std::fs::remove_file(path).unwrap();
	}
}
