//! jsdiff-compatible diff primitives.
//!
//! # Overview
//! Line, line-array, and word diffs plus a unified-patch hunk builder, all
//! producing byte-identical output to the `diff` npm package (jsdiff v9) under
//! its default options. The Myers O(ND) core is a faithful port of jsdiff's
//! `base.ts`, including its greedy tie-breaking and the edit-graph edge pruning
//! (`minDiagonalToConsider` / `maxDiagonalToConsider`), so change coalescing
//! matches jsdiff run-for-run rather than merely being "a" minimal diff.
//!
//! Everything operates on UTF-16 code units end to end — [`Utf16String`] at
//! the N-API boundary, `&[u16]` internally — which is the exact value space of
//! JS strings. Ill-formed input (unpaired surrogates) is legal content that
//! diffs code-unit-for-code-unit like jsdiff, so callers never need a JS
//! fallback, and no UTF-8 conversion happens in either direction.
//!
//! # Example
//! ```ignore
//! // JS: native.diffLines("a\nb\n", "a\nc\n")
//! //   -> [{ value: "a\n", count: 1, added: false, removed: false },
//! //       { value: "b\n", count: 1, added: false, removed: true },
//! //       { value: "c\n", count: 1, added: true, removed: false }]
//! ```

use std::{collections::HashMap, fs::File, io::Read, path::PathBuf, rc::Rc, sync::Arc};

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
// Myers core (port of jsdiff base.ts, default options)
// ═══════════════════════════════════════════════════════════════════════════

/// A run of tokens sharing one edit classification, in forward order.
#[derive(Clone, Copy)]
struct Run {
	count:   usize,
	added:   bool,
	removed: bool,
}

/// Reverse-linked component list node, shared between diagonal paths exactly
/// like jsdiff's `previousComponent` chains (structural sharing keeps the
/// D-path frontier O(D) instead of O(D^2)).
struct Component {
	count:   usize,
	added:   bool,
	removed: bool,
	prev:    Option<Rc<Self>>,
}

/// Frontier state for one diagonal: furthest old-position reached plus the
/// component chain that got there.
struct PathState {
	old_pos: isize,
	last:    Option<Rc<Component>>,
}

/// Extend `path` along its diagonal while tokens match, recording the common
/// run. Returns the new-token position (mirrors jsdiff `extractCommon`).
fn extract_common(path: &mut PathState, new: &[u32], old: &[u32], diagonal: isize) -> isize {
	let new_len = new.len() as isize;
	let old_len = old.len() as isize;
	let mut old_pos = path.old_pos;
	let mut new_pos = old_pos - diagonal;
	let mut common = 0usize;
	while new_pos + 1 < new_len
		&& old_pos + 1 < old_len
		&& old[(old_pos + 1) as usize] == new[(new_pos + 1) as usize]
	{
		new_pos += 1;
		old_pos += 1;
		common += 1;
	}
	if common > 0 {
		path.last = Some(Rc::new(Component {
			count:   common,
			added:   false,
			removed: false,
			prev:    path.last.take(),
		}));
	}
	path.old_pos = old_pos;
	new_pos
}

/// Branch from `path` with one added or removed token (mirrors jsdiff
/// `addToPath`, which merges into the previous component when the edit kind
/// repeats).
fn add_to_path(path: &PathState, added: bool, removed: bool, old_pos_inc: isize) -> PathState {
	match &path.last {
		Some(last) if last.added == added && last.removed == removed => PathState {
			old_pos: path.old_pos + old_pos_inc,
			last:    Some(Rc::new(Component {
				count: last.count + 1,
				added,
				removed,
				prev: last.prev.clone(),
			})),
		},
		_ => PathState {
			old_pos: path.old_pos + old_pos_inc,
			last:    Some(Rc::new(Component { count: 1, added, removed, prev: path.last.clone() })),
		},
	}
}

/// Convert the winning component chain into forward-ordered runs.
fn build_runs(last: Option<Rc<Component>>) -> Vec<Run> {
	let mut runs = Vec::new();
	let mut cursor = last.as_deref();
	while let Some(component) = cursor {
		runs.push(Run {
			count:   component.count,
			added:   component.added,
			removed: component.removed,
		});
		cursor = component.prev.as_deref();
	}
	runs.reverse();
	runs
}

/// Myers O(ND) diff over interned token ids, replicating jsdiff's default
/// (non-`oneChangePerToken`, no timeout / `maxEditLength`) execution path so
/// the resulting run structure is identical.
fn myers_diff(old: &[u32], new: &[u32]) -> Vec<Run> {
	let old_len = old.len() as isize;
	let new_len = new.len() as isize;
	let max_edit = old_len + new_len;
	let offset = max_edit + 1;
	let mut best: Vec<Option<PathState>> = Vec::new();
	best.resize_with((2 * max_edit + 3) as usize, || None);

	// Seed edit length 0: the content may start with common tokens.
	let mut seed = PathState { old_pos: -1, last: None };
	let seed_new_pos = extract_common(&mut seed, new, old, 0);
	if seed.old_pos + 1 >= old_len && seed_new_pos + 1 >= new_len {
		return build_runs(seed.last);
	}
	best[offset as usize] = Some(seed);

	let mut min_diagonal = isize::MIN;
	let mut max_diagonal = isize::MAX;
	let mut edit_length: isize = 1;
	while edit_length <= max_edit {
		let mut diagonal = min_diagonal.max(-edit_length);
		while diagonal <= max_diagonal.min(edit_length) {
			let idx = (diagonal + offset) as usize;
			let remove_path = best[idx - 1].take();
			let add_path_old_pos = best[idx + 1].as_ref().map(|path| path.old_pos);
			let can_add = add_path_old_pos.is_some_and(|old_pos| {
				let add_new_pos = old_pos - diagonal;
				add_new_pos >= 0 && add_new_pos < new_len
			});
			let can_remove = remove_path
				.as_ref()
				.is_some_and(|path| path.old_pos + 1 < old_len);
			if !can_add && !can_remove {
				best[idx] = None;
				diagonal += 2;
				continue;
			}

			// Branch from the prior path whose old-text position is furthest
			// along, preferring the insertion path on ties (jsdiff order).
			let mut base_path = if !can_remove
				|| (can_add
					&& remove_path.as_ref().is_some_and(|path| {
						add_path_old_pos.is_some_and(|add_old| path.old_pos < add_old)
					})) {
				add_to_path(
					best[idx + 1]
						.as_ref()
						.expect("canAdd implies a live addPath"),
					true,
					false,
					0,
				)
			} else {
				add_to_path(
					remove_path
						.as_ref()
						.expect("canRemove implies a live removePath"),
					false,
					true,
					1,
				)
			};
			let new_pos = extract_common(&mut base_path, new, old, diagonal);
			if base_path.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
				return build_runs(base_path.last);
			}
			if base_path.old_pos + 1 >= old_len {
				max_diagonal = max_diagonal.min(diagonal - 1);
			}
			if new_pos + 1 >= new_len {
				min_diagonal = min_diagonal.max(diagonal + 1);
			}
			best[idx] = Some(base_path);
			diagonal += 2;
		}
		edit_length += 1;
	}
	unreachable!("Myers diff terminates within oldLen + newLen edits")
}

/// Intern each token as a dense id under exact code-unit equality, so the
/// Myers core compares `u32`s instead of re-hashing slices per probe.
fn intern_exact<'a>(old_tokens: &[&'a [u16]], new_tokens: &[&'a [u16]]) -> (Vec<u32>, Vec<u32>) {
	fn assign<'a>(ids: &mut HashMap<&'a [u16], u32>, token: &'a [u16]) -> u32 {
		let next = ids.len() as u32;
		*ids.entry(token).or_insert(next)
	}
	let mut ids: HashMap<&'a [u16], u32> =
		HashMap::with_capacity(old_tokens.len() + new_tokens.len());
	let old_ids = old_tokens
		.iter()
		.map(|token| assign(&mut ids, token))
		.collect();
	let new_ids = new_tokens
		.iter()
		.map(|token| assign(&mut ids, token))
		.collect();
	(old_ids, new_ids)
}

/// Map runs back to change objects, joining token slices with `join`.
/// Common runs take their text from the new tokens, matching jsdiff
/// `buildValues` with `useLongestToken == false`.
fn build_changes(
	runs: &[Run],
	old_tokens: &[&[u16]],
	new_tokens: &[&[u16]],
	join: impl Fn(&[&[u16]]) -> Vec<u16>,
) -> Vec<DiffChange> {
	let mut old_pos = 0usize;
	let mut new_pos = 0usize;
	runs
		.iter()
		.map(|run| {
			let value = if run.removed {
				let value = join(&old_tokens[old_pos..old_pos + run.count]);
				old_pos += run.count;
				value
			} else {
				let value = join(&new_tokens[new_pos..new_pos + run.count]);
				new_pos += run.count;
				if !run.added {
					old_pos += run.count;
				}
				value
			};
			DiffChange {
				value:   value.into(),
				count:   run.count as u32,
				added:   run.added,
				removed: run.removed,
			}
		})
		.collect()
}

// ═══════════════════════════════════════════════════════════════════════════
// Line diff
// ═══════════════════════════════════════════════════════════════════════════

/// jsdiff line tokenization under default options: each token is a line
/// including its `\n` (or `\r\n`) terminator; a final line without a newline
/// is kept as-is; a lone `\r` never terminates a line.
fn line_tokens(text: &[u16]) -> Vec<&[u16]> {
	text.split_inclusive(|&unit| unit == LF).collect()
}

fn diff_line_tokens(old_tokens: &[&[u16]], new_tokens: &[&[u16]]) -> Vec<Run> {
	let (old_ids, new_ids) = intern_exact(old_tokens, new_tokens);
	myers_diff(&old_ids, &new_ids)
}

/// Concatenate token slices (jsdiff line `join`).
fn concat_tokens(tokens: &[&[u16]]) -> Vec<u16> {
	let mut out = Vec::with_capacity(tokens.iter().map(|token| token.len()).sum());
	for token in tokens {
		out.extend_from_slice(token);
	}
	out
}

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
	let old_tokens = line_tokens(old_text);
	let new_tokens = line_tokens(new_text);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);
	build_changes(&runs, &old_tokens, &new_tokens, concat_tokens)
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
	let (old_ids, new_ids) = intern_exact(&old_tokens, &new_tokens);
	myers_diff(&old_ids, &new_ids)
		.into_iter()
		.map(|run| DiffRun { count: run.count as u32, added: run.added, removed: run.removed })
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
	let old_tokens = line_tokens(old_text);
	let new_tokens = line_tokens(new_text);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);
	let exposed_runs = runs
		.iter()
		.map(|run| DiffRun { count: run.count as u32, added: run.added, removed: run.removed })
		.collect();
	let hunks = structured_patch_hunks_from_runs(context, &old_tokens, &new_tokens, &runs);
	DiffStreamResult {
		runs: exposed_runs,
		hunks,
		old_ends_newline: old_text.last() == Some(&LF),
		new_ends_newline: new_text.last() == Some(&LF),
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Structured patch (port of jsdiff patch/create.ts hunk builder)
// ═══════════════════════════════════════════════════════════════════════════

/// Prepend a `+`/`-`/` ` marker to a line's code units.
fn prefixed_line(prefix: u8, line: &[u16]) -> Vec<u16> {
	let mut out = Vec::with_capacity(1 + line.len());
	out.push(u16::from(prefix));
	out.extend_from_slice(line);
	out
}

/// `\ No newline at end of file`, as UTF-16 code units.
fn no_newline_marker() -> Vec<u16> {
	"\\ No newline at end of file".encode_utf16().collect()
}

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
	let old_tokens = line_tokens(old_text);
	let new_tokens = line_tokens(new_text);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);
	structured_patch_hunks_from_runs(context, &old_tokens, &new_tokens, &runs)
}

fn structured_patch_hunks_from_runs(
	context: Option<u32>,
	old_tokens: &[&[u16]],
	new_tokens: &[&[u16]],
	runs: &[Run],
) -> Vec<PatchHunk> {
	let context = context.map_or(4usize, |value| value as usize);

	// Change list with per-change line slices; the trailing sentinel mirrors
	// jsdiff's pushed empty change that flushes the final hunk.
	struct ChangeLines<'a> {
		added:   bool,
		removed: bool,
		lines:   &'a [&'a [u16]],
	}
	let mut list: Vec<ChangeLines> = Vec::with_capacity(runs.len() + 1);
	let mut old_pos = 0usize;
	let mut new_pos = 0usize;
	for run in runs {
		let lines: &[&[u16]] = if run.removed {
			let slice = &old_tokens[old_pos..old_pos + run.count];
			old_pos += run.count;
			slice
		} else {
			let slice = &new_tokens[new_pos..new_pos + run.count];
			new_pos += run.count;
			if !run.added {
				old_pos += run.count;
			}
			slice
		};
		list.push(ChangeLines { added: run.added, removed: run.removed, lines });
	}
	list.push(ChangeLines { added: false, removed: false, lines: &[] });

	// Hunk skeleton before the trailing-newline post-pass; lines stay `Vec<u16>`
	// so the pass below can pop terminators in place.
	struct RawHunk {
		old_start: usize,
		old_lines: usize,
		new_start: usize,
		new_lines: usize,
		lines:     Vec<Vec<u16>>,
	}
	let mut hunks: Vec<RawHunk> = Vec::new();
	let mut old_range_start = 0usize;
	let mut new_range_start = 0usize;
	let mut cur_range: Vec<Vec<u16>> = Vec::new();
	let mut old_line = 1usize;
	let mut new_line = 1usize;
	for i in 0..list.len() {
		let current = &list[i];
		if current.added || current.removed {
			// Open a hunk seeded with trailing context from the previous
			// common run.
			if old_range_start == 0 {
				old_range_start = old_line;
				new_range_start = new_line;
				if i > 0 && context > 0 {
					let prev_lines = list[i - 1].lines;
					let take = prev_lines.len().min(context);
					cur_range = prev_lines[prev_lines.len() - take..]
						.iter()
						.map(|line| prefixed_line(b' ', line))
						.collect();
					old_range_start -= cur_range.len();
					new_range_start -= cur_range.len();
				}
			}
			let marker = if current.added { b'+' } else { b'-' };
			for line in current.lines {
				cur_range.push(prefixed_line(marker, line));
			}
			if current.added {
				new_line += current.lines.len();
			} else {
				old_line += current.lines.len();
			}
		} else {
			if old_range_start != 0 {
				if current.lines.len() <= context * 2 && i + 2 < list.len() {
					// Common run small enough to join adjacent hunks.
					for line in current.lines {
						cur_range.push(prefixed_line(b' ', line));
					}
				} else {
					// Close the hunk with leading context.
					let context_size = current.lines.len().min(context);
					for line in &current.lines[..context_size] {
						cur_range.push(prefixed_line(b' ', line));
					}
					hunks.push(RawHunk {
						old_start: old_range_start,
						old_lines: old_line - old_range_start + context_size,
						new_start: new_range_start,
						new_lines: new_line - new_range_start + context_size,
						lines:     std::mem::take(&mut cur_range),
					});
					old_range_start = 0;
					new_range_start = 0;
				}
			}
			old_line += current.lines.len();
			new_line += current.lines.len();
		}
	}

	// Strip trailing newlines and add "no newline at EOF" markers.
	for hunk in &mut hunks {
		let mut i = 0;
		while i < hunk.lines.len() {
			if hunk.lines[i].last() == Some(&LF) {
				hunk.lines[i].pop();
			} else {
				hunk.lines.insert(i + 1, no_newline_marker());
				i += 1;
			}
			i += 1;
		}
	}
	hunks
		.into_iter()
		.map(|hunk| PatchHunk {
			old_start: hunk.old_start as u32,
			old_lines: hunk.old_lines as u32,
			new_start: hunk.new_start as u32,
			new_lines: hunk.new_lines as u32,
			lines:     hunk.lines.into_iter().map(Utf16String::from).collect(),
		})
		.collect()
}

// ═══════════════════════════════════════════════════════════════════════════
// Word diff (port of jsdiff word.ts, default options)
// ═══════════════════════════════════════════════════════════════════════════

/// jsdiff's `extendedWordChars` class: Latin-script word characters. Takes a
/// code point so astral input classifies like a JS regex with the `u` flag —
/// never a word character (every member is BMP).
const fn is_word_char(cp: u32) -> bool {
	matches!(cp,
		0x30..=0x39 // 0-9
		| 0x41..=0x5A // A-Z
		| 0x5F // _
		| 0x61..=0x7A // a-z
		| 0xAD
		| 0xC0..=0xD6
		| 0xD8..=0xF6
		| 0xF8..=0x2C6
		| 0x2C8..=0x2D7
		| 0x2DE..=0x2FF
		| 0x1E00..=0x1EFF)
}

/// JavaScript's `\s` / `String.prototype.trim` whitespace set (`WhiteSpace` +
/// `LineTerminator` productions). Every member is a single UTF-16 code unit,
/// so unit-level scans here match jsdiff's code-unit-level scans exactly.
const fn is_js_whitespace(cp: u32) -> bool {
	matches!(
		cp,
		0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000
			..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
	)
}

const fn is_ws_unit(unit: u16) -> bool {
	is_js_whitespace(unit as u32)
}

fn trim_leading_ws(s: &[u16]) -> &[u16] {
	let start = s
		.iter()
		.position(|&unit| !is_ws_unit(unit))
		.unwrap_or(s.len());
	&s[start..]
}

fn trim_trailing_ws(s: &[u16]) -> &[u16] {
	let end = s
		.iter()
		.rposition(|&unit| !is_ws_unit(unit))
		.map_or(0, |i| i + 1);
	&s[..end]
}

fn leading_ws(s: &[u16]) -> &[u16] {
	&s[..s.len() - trim_leading_ws(s).len()]
}

fn trailing_ws(s: &[u16]) -> &[u16] {
	&s[trim_trailing_ws(s).len()..]
}

fn js_trim(s: &[u16]) -> &[u16] {
	trim_trailing_ws(trim_leading_ws(s))
}

/// Iterator over `(start, code_point, unit_len)` that pairs surrogates and
/// passes unpaired surrogates through as their own code points, exactly like
/// JS regex scanning under the `u` flag.
struct CodePoints<'a> {
	text: &'a [u16],
	pos:  usize,
}

impl Iterator for CodePoints<'_> {
	type Item = (usize, u32, usize);

	fn next(&mut self) -> Option<Self::Item> {
		let &unit = self.text.get(self.pos)?;
		let start = self.pos;
		if matches!(unit, 0xd800..=0xdbff)
			&& let Some(&low) = self.text.get(start + 1)
			&& matches!(low, 0xdc00..=0xdfff)
		{
			self.pos += 2;
			let cp = 0x10000 + ((u32::from(unit & 0x3ff) << 10) | u32::from(low & 0x3ff));
			return Some((start, cp, 2));
		}
		self.pos += 1;
		Some((start, u32::from(unit), 1))
	}
}

const fn code_points(text: &[u16]) -> CodePoints<'_> {
	CodePoints { text, pos: 0 }
}

/// Raw regex-equivalent scan: word runs, whitespace runs, or single other
/// code points (jsdiff `tokenizeIncludingWhitespace` with the `u` flag).
fn word_parts(text: &[u16]) -> Vec<&[u16]> {
	let mut parts = Vec::new();
	let mut iter = code_points(text).peekable();
	while let Some((start, cp, len)) = iter.next() {
		let class = if is_word_char(cp) {
			1u8
		} else if is_js_whitespace(cp) {
			2u8
		} else {
			0u8
		};
		let mut end = start + len;
		if class != 0 {
			while let Some(&(_, next_cp, next_len)) = iter.peek() {
				let same = if class == 1 {
					is_word_char(next_cp)
				} else {
					is_js_whitespace(next_cp)
				};
				if !same {
					break;
				}
				end += next_len;
				iter.next();
			}
		}
		parts.push(&text[start..end]);
	}
	parts
}

/// jsdiff `WordDiff.tokenize`: stitch whitespace runs onto adjacent word or
/// punctuation parts, duplicating interior whitespace into both neighbors.
fn word_tokens(text: &[u16]) -> Vec<Vec<u16>> {
	let parts = word_parts(text);
	let mut tokens: Vec<Vec<u16>> = Vec::with_capacity(parts.len());
	let mut prev_part: Option<&[u16]> = None;
	for part in parts {
		let part_is_ws = part.first().is_some_and(|&unit| is_ws_unit(unit));
		if part_is_ws {
			if prev_part.is_none() {
				tokens.push(part.to_vec());
			} else {
				let last = tokens
					.last_mut()
					.expect("tokens non-empty after first part");
				last.extend_from_slice(part);
			}
		} else if let Some(prev) =
			prev_part.filter(|p| p.first().is_some_and(|&unit| is_ws_unit(unit)))
		{
			if tokens.last().is_some_and(|last| last.as_slice() == prev) {
				let last = tokens.last_mut().expect("checked non-empty");
				last.extend_from_slice(part);
			} else {
				let mut token = Vec::with_capacity(prev.len() + part.len());
				token.extend_from_slice(prev);
				token.extend_from_slice(part);
				tokens.push(token);
			}
		} else {
			tokens.push(part.to_vec());
		}
		prev_part = Some(part);
	}
	tokens
}

/// jsdiff `WordDiff.join`: concatenate, stripping leading whitespace from
/// every token after the first.
fn word_join(tokens: &[&[u16]]) -> Vec<u16> {
	let mut out = Vec::new();
	for (i, token) in tokens.iter().enumerate() {
		if i == 0 {
			out.extend_from_slice(token);
		} else {
			out.extend_from_slice(trim_leading_ws(token));
		}
	}
	out
}

fn longest_common_prefix<'a>(a: &'a [u16], b: &[u16]) -> &'a [u16] {
	let len = a.iter().zip(b).take_while(|(x, y)| x == y).count();
	&a[..len]
}

fn longest_common_suffix<'a>(a: &'a [u16], b: &[u16]) -> &'a [u16] {
	let len = a
		.iter()
		.rev()
		.zip(b.iter().rev())
		.take_while(|(x, y)| x == y)
		.count();
	&a[a.len() - len..]
}

fn remove_prefix(s: &[u16], prefix: &[u16]) -> Vec<u16> {
	s.strip_prefix(prefix)
		.expect("value must start with recorded prefix")
		.to_vec()
}

fn remove_suffix(s: &[u16], suffix: &[u16]) -> Vec<u16> {
	s.strip_suffix(suffix)
		.expect("value must end with recorded suffix")
		.to_vec()
}

fn replace_prefix(s: &[u16], old_prefix: &[u16], new_prefix: &[u16]) -> Vec<u16> {
	let rest = s
		.strip_prefix(old_prefix)
		.expect("value must start with recorded prefix");
	let mut out = Vec::with_capacity(new_prefix.len() + rest.len());
	out.extend_from_slice(new_prefix);
	out.extend_from_slice(rest);
	out
}

fn replace_suffix(s: &[u16], old_suffix: &[u16], new_suffix: &[u16]) -> Vec<u16> {
	let rest = s
		.strip_suffix(old_suffix)
		.expect("value must end with recorded suffix");
	let mut out = Vec::with_capacity(rest.len() + new_suffix.len());
	out.extend_from_slice(rest);
	out.extend_from_slice(new_suffix);
	out
}

/// jsdiff `maximumOverlap`: the longest prefix of `b` that is also a suffix
/// of `a`, via the KMP failure function over code units.
fn maximum_overlap<'a>(a: &[u16], b: &'a [u16]) -> &'a [u16] {
	let start_a = a.len().saturating_sub(b.len());
	let end_b = b.len().min(a.len());
	if end_b == 0 {
		return &[];
	}
	let mut map = vec![0usize; end_b];
	let mut k = 0usize;
	for j in 1..end_b {
		if b[j] == b[k] {
			map[j] = map[k];
		} else {
			map[j] = k;
		}
		while k > 0 && b[j] != b[k] {
			k = map[k];
		}
		if b[j] == b[k] {
			k += 1;
		}
	}
	k = 0;
	for &unit in &a[start_a..] {
		while k > 0 && unit != b[k] {
			k = map[k];
		}
		if unit == b[k] {
			k += 1;
		}
	}
	&b[..k]
}

/// jsdiff `dedupeWhitespaceInChangeObjects` (no segmenter): trim whitespace
/// that the tokenizer duplicated across a keep/delete/insert boundary.
fn dedupe_whitespace(
	changes: &mut [DiffChange],
	start_keep: Option<usize>,
	deletion: Option<usize>,
	insertion: Option<usize>,
	end_keep: Option<usize>,
) {
	match (deletion, insertion) {
		(Some(del), Some(ins)) => {
			let old_ws_prefix = leading_ws(&changes[del].value).to_vec();
			let old_ws_suffix = trailing_ws(&changes[del].value).to_vec();
			let new_ws_prefix = leading_ws(&changes[ins].value).to_vec();
			let new_ws_suffix = trailing_ws(&changes[ins].value).to_vec();
			if let Some(start) = start_keep {
				let common_ws_prefix = longest_common_prefix(&old_ws_prefix, &new_ws_prefix).to_vec();
				changes[start].value =
					replace_suffix(&changes[start].value, &new_ws_prefix, &common_ws_prefix).into();
				changes[del].value = remove_prefix(&changes[del].value, &common_ws_prefix).into();
				changes[ins].value = remove_prefix(&changes[ins].value, &common_ws_prefix).into();
			}
			if let Some(end) = end_keep {
				let common_ws_suffix = longest_common_suffix(&old_ws_suffix, &new_ws_suffix).to_vec();
				changes[end].value =
					replace_prefix(&changes[end].value, &new_ws_suffix, &common_ws_suffix).into();
				changes[del].value = remove_suffix(&changes[del].value, &common_ws_suffix).into();
				changes[ins].value = remove_suffix(&changes[ins].value, &common_ws_suffix).into();
			}
		},
		(None, Some(ins)) => {
			if start_keep.is_some() {
				let ws_len = leading_ws(&changes[ins].value).len();
				changes[ins].value = changes[ins].value[ws_len..].to_vec().into();
			}
			if let Some(end) = end_keep {
				let ws_len = leading_ws(&changes[end].value).len();
				changes[end].value = changes[end].value[ws_len..].to_vec().into();
			}
		},
		(Some(del), None) => match (start_keep, end_keep) {
			(Some(start), Some(end)) => {
				let new_ws_full = leading_ws(&changes[end].value).to_vec();
				let del_ws_start = leading_ws(&changes[del].value).to_vec();
				let del_ws_end = trailing_ws(&changes[del].value).to_vec();
				let new_ws_start = longest_common_prefix(&new_ws_full, &del_ws_start).to_vec();
				changes[del].value = remove_prefix(&changes[del].value, &new_ws_start).into();
				let new_ws_end =
					longest_common_suffix(&new_ws_full[new_ws_start.len()..], &del_ws_end).to_vec();
				changes[del].value = remove_suffix(&changes[del].value, &new_ws_end).into();
				changes[end].value =
					replace_prefix(&changes[end].value, &new_ws_full, &new_ws_end).into();
				let start_ws = &new_ws_full[..new_ws_full.len() - new_ws_end.len()];
				changes[start].value =
					replace_suffix(&changes[start].value, &new_ws_full, start_ws).into();
			},
			(None, Some(end)) => {
				let end_keep_ws_prefix = leading_ws(&changes[end].value).to_vec();
				let deletion_ws_suffix = trailing_ws(&changes[del].value).to_vec();
				let overlap = maximum_overlap(&deletion_ws_suffix, &end_keep_ws_prefix).to_vec();
				changes[del].value = remove_suffix(&changes[del].value, &overlap).into();
			},
			(Some(start), None) => {
				let start_keep_ws_suffix = trailing_ws(&changes[start].value).to_vec();
				let deletion_ws_prefix = leading_ws(&changes[del].value).to_vec();
				let overlap = maximum_overlap(&start_keep_ws_suffix, &deletion_ws_prefix).to_vec();
				changes[del].value = remove_prefix(&changes[del].value, &overlap).into();
			},
			(None, None) => {},
		},
		(None, None) => {},
	}
}

/// jsdiff `WordDiff.postProcess` under default options.
fn word_post_process(changes: &mut [DiffChange]) {
	let mut last_keep: Option<usize> = None;
	let mut insertion: Option<usize> = None;
	let mut deletion: Option<usize> = None;
	for i in 0..changes.len() {
		if changes[i].added {
			insertion = Some(i);
		} else if changes[i].removed {
			deletion = Some(i);
		} else {
			if insertion.is_some() || deletion.is_some() {
				dedupe_whitespace(changes, last_keep, deletion, insertion, Some(i));
			}
			last_keep = Some(i);
			insertion = None;
			deletion = None;
		}
	}
	if insertion.is_some() || deletion.is_some() {
		dedupe_whitespace(changes, last_keep, deletion, insertion, None);
	}
}

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
	let old_tokens = word_tokens(old_text);
	let new_tokens = word_tokens(new_text);
	let old_refs: Vec<&[u16]> = old_tokens.iter().map(Vec::as_slice).collect();
	let new_refs: Vec<&[u16]> = new_tokens.iter().map(Vec::as_slice).collect();
	// Equality is whitespace-insensitive: intern by trimmed text.
	let old_keys: Vec<&[u16]> = old_refs.iter().map(|token| js_trim(token)).collect();
	let new_keys: Vec<&[u16]> = new_refs.iter().map(|token| js_trim(token)).collect();
	let (old_ids, new_ids) = intern_exact(&old_keys, &new_keys);
	let runs = myers_diff(&old_ids, &new_ids);
	let mut changes = build_changes(&runs, &old_refs, &new_refs, word_join);
	word_post_process(&mut changes);
	changes
}

#[cfg(test)]
mod tests {
	use super::*;

	fn u16s(text: &str) -> Vec<u16> {
		text.encode_utf16().collect()
	}

	fn lines(old: &str, new: &str) -> Vec<(String, bool, bool)> {
		diff_lines_impl(&u16s(old), &u16s(new))
			.into_iter()
			.map(|c| (String::from_utf16(&c.value).unwrap(), c.added, c.removed))
			.collect()
	}

	#[test]
	fn line_diff_replaces_middle_line() {
		assert_eq!(lines("a\nb\nc\n", "a\nx\nc\n"), vec![
			("a\n".into(), false, false),
			("b\n".into(), false, true),
			("x\n".into(), true, false),
			("c\n".into(), false, false),
		]);
	}

	#[test]
	fn line_diff_treats_missing_trailing_newline_as_distinct() {
		assert_eq!(lines("a\nb", "a\nb\n"), vec![
			("a\n".into(), false, false),
			("b".into(), false, true),
			("b\n".into(), true, false),
		]);
	}

	#[test]
	fn structured_patch_marks_missing_eof_newline() {
		let hunks = structured_patch_hunks_impl(&u16s("a\nb"), &u16s("a\nc"), Some(3));
		assert_eq!(hunks.len(), 1);
		let body: Vec<String> = hunks[0]
			.lines
			.iter()
			.map(|line| String::from_utf16(line).unwrap())
			.collect();
		assert_eq!(body, vec![
			" a",
			"-b",
			"\\ No newline at end of file",
			"+c",
			"\\ No newline at end of file"
		]);
	}

	#[test]
	fn word_diff_dedupes_boundary_whitespace() {
		// jsdiff's documented example 2: K:'foo ' D:'bar' I:'qux' K:' baz'.
		let changes = diff_words_impl(&u16s("foo bar baz"), &u16s("foo qux baz"));
		let shaped: Vec<(String, bool, bool)> = changes
			.into_iter()
			.map(|c| (String::from_utf16(&c.value).unwrap(), c.added, c.removed))
			.collect();
		assert_eq!(shaped, vec![
			("foo ".into(), false, false),
			("bar".into(), false, true),
			("qux".into(), true, false),
			(" baz".into(), false, false),
		]);
	}

	#[test]
	fn line_runs_preserve_empty_lines() {
		let runs = diff_line_runs_impl(&u16s("a\n\nb"), &u16s("a\n\nc"));
		let shaped: Vec<(u32, bool, bool)> = runs
			.into_iter()
			.map(|r| (r.count, r.added, r.removed))
			.collect();
		assert_eq!(shaped, vec![(2, false, false), (1, false, true), (1, true, false)]);
	}

	#[test]
	fn unpaired_surrogates_diff_as_distinct_content() {
		// Lone surrogates are legal JS string content; they must compare by
		// code unit instead of failing (or lossily surviving) a UTF-8 round
		// trip.
		let old = [0x61, 0xd800, LF];
		let new = [0x61, 0xd801, LF];
		let shaped: Vec<(Vec<u16>, bool, bool)> = diff_lines_impl(&old, &new)
			.into_iter()
			.map(|c| (c.value.to_vec(), c.added, c.removed))
			.collect();
		assert_eq!(shaped, vec![(old.to_vec(), false, true), (new.to_vec(), true, false)]);
	}

	#[test]
	fn word_scan_keeps_lone_surrogate_before_astral_pair_separate() {
		// "\u{D800}🚀" is a lone high surrogate directly followed by a valid
		// pair; the `u`-flag scan must yield two "other" tokens, so replacing
		// only the rocket leaves the lone surrogate as common content.
		let old: Vec<u16> = [0xd800, 0xd83d, 0xde80].to_vec(); // "\u{D800}🚀"
		let new: Vec<u16> = [0xd800, 0x78].to_vec(); // "\u{D800}x"
		let shaped: Vec<(Vec<u16>, bool, bool)> = diff_words_impl(&old, &new)
			.into_iter()
			.map(|c| (c.value.to_vec(), c.added, c.removed))
			.collect();
		assert_eq!(shaped, vec![
			(vec![0xd800], false, false),
			(vec![0xd83d, 0xde80], false, true),
			(vec![0x78], true, false),
		]);
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
