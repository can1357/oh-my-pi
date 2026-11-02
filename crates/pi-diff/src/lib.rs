//! jsdiff-compatible diff primitives without an FFI dependency.
//!
//! The Myers O(ND) core and line, word, and structured-patch helpers preserve
//! jsdiff v9's default tie-breaking and change coalescing. UTF-16 entry points
//! operate on JavaScript code units, while UTF-8 line helpers serve native Rust
//! callers with the same token and run semantics.

use std::{collections::HashMap, hash::Hash};

/// UTF-16 code unit for `\n`.
const LF: u16 = 0x000a;

/// A run of tokens sharing one edit classification, in forward order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
	/// Number of tokens in this run.
	pub count:   u32,
	/// True when this run exists only in the new input.
	pub added:   bool,
	/// True when this run exists only in the old input.
	pub removed: bool,
}

const NO_COMPONENT: u32 = u32::MAX;

#[derive(Clone, Copy)]
struct ComponentNode {
	count:   u32,
	prev:    u32,
	refs:    u32,
	added:   bool,
	removed: bool,
}

/// Arena-allocated component pool with intrusive free-list recycling.
/// Superseded frontier nodes are returned to `free_head` as soon as their last
/// active `PathState` drops them, keeping peak memory proportional to live
/// frontier paths rather than total explored `(edit_length, diagonal)` states.
struct ComponentArena {
	nodes:     Vec<ComponentNode>,
	free_head: u32,
}

impl ComponentArena {
	fn with_capacity(capacity: usize) -> Self {
		Self { nodes: Vec::with_capacity(capacity), free_head: NO_COMPONENT }
	}

	#[inline]
	fn alloc(&mut self, count: u32, prev: u32, added: bool, removed: bool) -> u32 {
		if self.free_head == NO_COMPONENT {
			let idx = self.nodes.len() as u32;
			self
				.nodes
				.push(ComponentNode { count, prev, refs: 1, added, removed });
			idx
		} else {
			let idx = self.free_head;
			let slot = &mut self.nodes[idx as usize];
			self.free_head = slot.prev;
			*slot = ComponentNode { count, prev, refs: 1, added, removed };
			idx
		}
	}

	#[inline]
	fn clone_ref(&mut self, idx: u32) -> u32 {
		if idx != NO_COMPONENT {
			self.nodes[idx as usize].refs += 1;
		}
		idx
	}

	#[inline]
	fn release(&mut self, mut idx: u32) {
		while idx != NO_COMPONENT {
			let node = &mut self.nodes[idx as usize];
			node.refs -= 1;
			if node.refs > 0 {
				break;
			}
			let prev = node.prev;
			node.prev = self.free_head;
			self.free_head = idx;
			idx = prev;
		}
	}
}

/// Frontier state for one diagonal: furthest old-position reached plus the
/// component chain that got there.
#[derive(Clone, Copy)]
struct PathState {
	old_pos: isize,
	last:    u32,
}

/// Extend `path` along its diagonal while tokens match, recording the common
/// run. Returns the new-token position (mirrors jsdiff `extractCommon`).
fn extract_common(
	arena: &mut ComponentArena,
	path: &mut PathState,
	new: &[u32],
	old: &[u32],
	diagonal: isize,
) -> isize {
	let new_len = new.len() as isize;
	let old_len = old.len() as isize;
	let mut old_pos = path.old_pos;
	let mut new_pos = old_pos - diagonal;
	let mut common = 0u32;
	while new_pos + 1 < new_len
		&& old_pos + 1 < old_len
		&& old[(old_pos + 1) as usize] == new[(new_pos + 1) as usize]
	{
		new_pos += 1;
		old_pos += 1;
		common += 1;
	}
	if common > 0 {
		path.last = arena.alloc(common, path.last, false, false);
	}
	path.old_pos = old_pos;
	new_pos
}

/// Branch from `path` with one added or removed token (mirrors jsdiff
/// `addToPath`, which merges into the previous component when the edit kind
/// repeats). Consumes ownership of `path`'s component reference.
fn add_to_path(
	arena: &mut ComponentArena,
	path: PathState,
	added: bool,
	removed: bool,
	old_pos_inc: isize,
) -> PathState {
	let last_idx = path.last;
	let new_last = if last_idx == NO_COMPONENT {
		arena.alloc(1, NO_COMPONENT, added, removed)
	} else {
		let last = arena.nodes[last_idx as usize];
		if last.added == added && last.removed == removed {
			if last.refs == 1 {
				arena.nodes[last_idx as usize].count = last.count + 1;
				last_idx
			} else {
				arena.nodes[last_idx as usize].refs -= 1;
				let prev = arena.clone_ref(last.prev);
				arena.alloc(last.count + 1, prev, added, removed)
			}
		} else {
			arena.alloc(1, last_idx, added, removed)
		}
	};
	PathState { old_pos: path.old_pos + old_pos_inc, last: new_last }
}

/// Convert the winning component chain into forward-ordered runs.
fn build_runs(arena: &ComponentArena, last: u32) -> Vec<Run> {
	let mut runs = Vec::new();
	let mut cursor = last;
	while cursor != NO_COMPONENT {
		let component = arena.nodes[cursor as usize];
		runs.push(Run {
			count:   component.count,
			added:   component.added,
			removed: component.removed,
		});
		cursor = component.prev;
	}
	runs.reverse();
	runs
}

/// Myers O(ND) diff over interned token ids, replicating jsdiff's default
/// (non-`oneChangePerToken`, no timeout / `maxEditLength`) execution path so
/// the resulting run structure is identical.
pub fn myers_diff(old: &[u32], new: &[u32]) -> Vec<Run> {
	let old_len = old.len() as isize;
	let new_len = new.len() as isize;
	let max_edit = old_len + new_len;
	let offset = max_edit + 1;
	let mut best: Vec<Option<PathState>> = vec![None; (2 * max_edit + 3) as usize];
	let mut arena = ComponentArena::with_capacity((old.len() + new.len()).clamp(16, 4096));

	// Seed edit length 0: the content may start with common tokens.
	let mut seed = PathState { old_pos: -1, last: NO_COMPONENT };
	let seed_new_pos = extract_common(&mut arena, &mut seed, new, old, 0);
	if seed.old_pos + 1 >= old_len && seed_new_pos + 1 >= new_len {
		return build_runs(&arena, seed.last);
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
			let add_path_old_pos = best[idx + 1].map(|path| path.old_pos);
			let can_add = add_path_old_pos.is_some_and(|old_pos| {
				let add_new_pos = old_pos - diagonal;
				add_new_pos >= 0 && add_new_pos < new_len
			});
			let can_remove = remove_path.is_some_and(|path| path.old_pos + 1 < old_len);
			if !can_add && !can_remove {
				if let Some(rem) = remove_path {
					arena.release(rem.last);
				}
				if let Some(prev) = best[idx].take() {
					arena.release(prev.last);
				}
				diagonal += 2;
				continue;
			}

			// Branch from the prior path whose old-text position is furthest
			// along, preferring the insertion path on ties (jsdiff order).
			let mut base_path = if !can_remove
				|| (can_add
					&& remove_path.is_some_and(|path| {
						add_path_old_pos.is_some_and(|add_old| path.old_pos < add_old)
					})) {
				if let Some(rem) = remove_path {
					arena.release(rem.last);
				}
				let add_path = best[idx + 1].expect("canAdd implies a live addPath");
				let cloned =
					PathState { old_pos: add_path.old_pos, last: arena.clone_ref(add_path.last) };
				add_to_path(&mut arena, cloned, true, false, 0)
			} else {
				add_to_path(
					&mut arena,
					remove_path.expect("canRemove implies a live removePath"),
					false,
					true,
					1,
				)
			};
			let new_pos = extract_common(&mut arena, &mut base_path, new, old, diagonal);
			if base_path.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
				return build_runs(&arena, base_path.last);
			}
			if base_path.old_pos + 1 >= old_len {
				max_diagonal = max_diagonal.min(diagonal - 1);
			}
			if new_pos + 1 >= new_len {
				min_diagonal = min_diagonal.max(diagonal + 1);
			}
			if let Some(prev) = best[idx].replace(base_path) {
				arena.release(prev.last);
			}
			diagonal += 2;
		}
		edit_length += 1;
	}
	unreachable!("Myers diff terminates within oldLen + newLen edits")
}

/// Intern tokens as dense ids under exact equality.
pub fn intern<T: Eq + Hash + Copy>(old: &[T], new: &[T]) -> (Vec<u32>, Vec<u32>) {
	fn assign<T: Eq + Hash + Copy>(ids: &mut HashMap<T, u32>, token: T) -> u32 {
		let next = ids.len() as u32;
		*ids.entry(token).or_insert(next)
	}
	let mut ids = HashMap::with_capacity(old.len() + new.len());
	let old_ids = old
		.iter()
		.copied()
		.map(|token| assign(&mut ids, token))
		.collect();
	let new_ids = new
		.iter()
		.copied()
		.map(|token| assign(&mut ids, token))
		.collect();
	(old_ids, new_ids)
}

/// A joined change value and its edit classification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change<V> {
	/// Joined token value for this run.
	pub value:   V,
	/// Number of tokens in this run.
	pub count:   u32,
	/// True when this run exists only in the new input.
	pub added:   bool,
	/// True when this run exists only in the old input.
	pub removed: bool,
}

/// Map runs back to values, taking common-run text from `new_tokens`.
pub fn build_changes<'a, T: ?Sized, V>(
	runs: &[Run],
	old_tokens: &[&'a T],
	new_tokens: &[&'a T],
	join: impl Fn(&[&'a T]) -> V,
) -> Vec<Change<V>> {
	let mut old_pos = 0usize;
	let mut new_pos = 0usize;
	runs
		.iter()
		.map(|run| {
			let count = run.count as usize;
			let value = if run.removed {
				let value = join(&old_tokens[old_pos..old_pos + count]);
				old_pos += count;
				value
			} else {
				let value = join(&new_tokens[new_pos..new_pos + count]);
				new_pos += count;
				if !run.added {
					old_pos += count;
				}
				value
			};
			Change { value, count: run.count, added: run.added, removed: run.removed }
		})
		.collect()
}

/// jsdiff line tokenization over UTF-16 code units.
pub fn line_tokens_u16(text: &[u16]) -> Vec<&[u16]> {
	text.split_inclusive(|&unit| unit == LF).collect()
}

/// jsdiff line tokenization over UTF-8 text.
pub fn line_tokens_str(text: &str) -> Vec<&str> {
	text.split_inclusive('\n').collect()
}

/// Myers runs over pre-split line tokens, so callers that also need the token
/// slices for rendering split each text only once.
pub fn diff_line_tokens<T: Eq + Hash + Copy>(old_tokens: &[T], new_tokens: &[T]) -> Vec<Run> {
	let (old_ids, new_ids) = intern(old_tokens, new_tokens);
	myers_diff(&old_ids, &new_ids)
}

/// Myers runs for jsdiff line tokens over UTF-16 code units.
pub fn line_runs_u16(old: &[u16], new: &[u16]) -> Vec<Run> {
	let old_tokens = line_tokens_u16(old);
	let new_tokens = line_tokens_u16(new);
	diff_line_tokens(&old_tokens, &new_tokens)
}

/// Myers runs for jsdiff line tokens over UTF-8 text.
pub fn line_runs_str(old: &str, new: &str) -> Vec<Run> {
	let old_tokens = line_tokens_str(old);
	let new_tokens = line_tokens_str(new);
	diff_line_tokens(&old_tokens, &new_tokens)
}

/// Concatenate UTF-16 token slices.
pub fn concat_tokens_u16(tokens: &[&[u16]]) -> Vec<u16> {
	let mut out = Vec::with_capacity(tokens.iter().map(|token| token.len()).sum());
	for token in tokens {
		out.extend_from_slice(token);
	}
	out
}

/// Line changes with jsdiff `diffLines` semantics over UTF-16 code units.
pub fn diff_lines_u16(old: &[u16], new: &[u16]) -> Vec<Change<Vec<u16>>> {
	let old_tokens = line_tokens_u16(old);
	let new_tokens = line_tokens_u16(new);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);
	build_changes(&runs, &old_tokens, &new_tokens, concat_tokens_u16)
}

/// One hunk of a unified diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
	/// 1-based first line of the hunk in the old text.
	pub old_start: u32,
	/// Number of old-text lines covered by the hunk.
	pub old_lines: u32,
	/// 1-based first line of the hunk in the new text.
	pub new_start: u32,
	/// Number of new-text lines covered by the hunk.
	pub new_lines: u32,
	/// Prefixed hunk body lines without trailing newlines.
	pub lines:     Vec<Vec<u16>>,
}

/// Line token that may end in a line feed.
pub trait LineToken {
	/// The token without its trailing line feed, and whether one was present.
	fn strip_lf(&self) -> (&Self, bool);
}

impl LineToken for [u16] {
	fn strip_lf(&self) -> (&Self, bool) {
		match self.split_last() {
			Some((&LF, body)) => (body, true),
			_ => (self, false),
		}
	}
}

impl LineToken for str {
	fn strip_lf(&self) -> (&Self, bool) {
		match self.strip_suffix('\n') {
			Some(body) => (body, true),
			None => (self, false),
		}
	}
}

/// Body row of a unified hunk, borrowing its text from the line tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HunkLine<'a, T: ?Sized> {
	/// ` ` row: line present in both texts.
	Context(&'a T),
	/// `-` row: line only in the old text.
	Removed(&'a T),
	/// `+` row: line only in the new text.
	Added(&'a T),
	/// `\ No newline at end of file` after the preceding row.
	NoNewlineAtEof,
}

/// Unified hunk whose rows borrow from the line tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HunkRows<'a, T: ?Sized> {
	/// 1-based first line of the hunk in the old text.
	pub old_start: u32,
	/// Number of old-text lines covered by the hunk.
	pub old_lines: u32,
	/// 1-based first line of the hunk in the new text.
	pub new_start: u32,
	/// Number of new-text lines covered by the hunk.
	pub new_lines: u32,
	/// Hunk body rows, line feeds stripped.
	pub lines:     Vec<HunkLine<'a, T>>,
}

/// Build jsdiff-compatible unified hunks from UTF-16 texts.
pub fn structured_patch_hunks_u16(
	old_text: &[u16],
	new_text: &[u16],
	context: Option<u32>,
) -> Vec<Hunk> {
	let old_tokens = line_tokens_u16(old_text);
	let new_tokens = line_tokens_u16(new_text);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);
	structured_patch_hunks_from_runs_u16(context, &old_tokens, &new_tokens, &runs)
}

/// Build jsdiff-compatible unified hunks from precomputed UTF-16 line runs.
pub fn structured_patch_hunks_from_runs_u16(
	context: Option<u32>,
	old_tokens: &[&[u16]],
	new_tokens: &[&[u16]],
	runs: &[Run],
) -> Vec<Hunk> {
	const NO_NEWLINE_MARKER: &str = "\\ No newline at end of file";
	let prefixed = |prefix: u8, line: &[u16]| {
		let mut out = Vec::with_capacity(1 + line.len());
		out.push(u16::from(prefix));
		out.extend_from_slice(line);
		out
	};
	structured_patch_hunk_rows(context, old_tokens, new_tokens, runs)
		.into_iter()
		.map(|hunk| Hunk {
			old_start: hunk.old_start,
			old_lines: hunk.old_lines,
			new_start: hunk.new_start,
			new_lines: hunk.new_lines,
			lines:     hunk
				.lines
				.into_iter()
				.map(|line| match line {
					HunkLine::Context(text) => prefixed(b' ', text),
					HunkLine::Removed(text) => prefixed(b'-', text),
					HunkLine::Added(text) => prefixed(b'+', text),
					HunkLine::NoNewlineAtEof => NO_NEWLINE_MARKER.encode_utf16().collect(),
				})
				.collect(),
		})
		.collect()
}

/// Build jsdiff-compatible unified hunks from precomputed line runs over any
/// token type; rows borrow from the tokens.
pub fn structured_patch_hunk_rows<'a, T: LineToken + ?Sized>(
	context: Option<u32>,
	old_tokens: &[&'a T],
	new_tokens: &[&'a T],
	runs: &[Run],
) -> Vec<HunkRows<'a, T>> {
	let context = context.map_or(4usize, |value| value as usize);

	// Change list with per-change line slices; the trailing sentinel mirrors
	// jsdiff's pushed empty change that flushes the final hunk.
	struct ChangeLines<'s, 'a, T: ?Sized> {
		added:   bool,
		removed: bool,
		lines:   &'s [&'a T],
	}
	let mut list: Vec<ChangeLines<'_, 'a, T>> = Vec::with_capacity(runs.len() + 1);
	let mut old_pos = 0usize;
	let mut new_pos = 0usize;
	for run in runs {
		let count = run.count as usize;
		let lines = if run.removed {
			let slice = &old_tokens[old_pos..old_pos + count];
			old_pos += count;
			slice
		} else {
			let slice = &new_tokens[new_pos..new_pos + count];
			new_pos += count;
			if !run.added {
				old_pos += count;
			}
			slice
		};
		list.push(ChangeLines { added: run.added, removed: run.removed, lines });
	}
	list.push(ChangeLines { added: false, removed: false, lines: &[] });

	// jsdiff strips each line's terminator and follows any line lacking one
	// with the "no newline at EOF" marker; doing it per row on push is
	// equivalent to its post-pass over finished hunks.
	fn push_row<'a, T: LineToken + ?Sized>(
		rows: &mut Vec<HunkLine<'a, T>>,
		row: fn(&'a T) -> HunkLine<'a, T>,
		line: &'a T,
	) {
		let (body, had_lf) = line.strip_lf();
		rows.push(row(body));
		if !had_lf {
			rows.push(HunkLine::NoNewlineAtEof);
		}
	}

	let mut hunks = Vec::new();
	let mut old_range_start = 0usize;
	let mut new_range_start = 0usize;
	let mut cur_range: Vec<HunkLine<'a, T>> = Vec::new();
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
					for line in &prev_lines[prev_lines.len() - take..] {
						push_row(&mut cur_range, HunkLine::Context, line);
					}
					old_range_start -= take;
					new_range_start -= take;
				}
			}
			let row: fn(&'a T) -> HunkLine<'a, T> = if current.added {
				HunkLine::Added
			} else {
				HunkLine::Removed
			};
			for line in current.lines {
				push_row(&mut cur_range, row, line);
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
						push_row(&mut cur_range, HunkLine::Context, line);
					}
				} else {
					// Close the hunk with leading context.
					let context_size = current.lines.len().min(context);
					for line in &current.lines[..context_size] {
						push_row(&mut cur_range, HunkLine::Context, line);
					}
					hunks.push(HunkRows {
						old_start: old_range_start as u32,
						old_lines: (old_line - old_range_start + context_size) as u32,
						new_start: new_range_start as u32,
						new_lines: (new_line - new_range_start + context_size) as u32,
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
	hunks
}

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
/// punctuation parts. Overlapping slices share interior whitespace without
/// copying it into both neighbors.
fn word_tokens(text: &[u16]) -> Vec<&[u16]> {
	let parts = word_parts(text);
	let mut tokens: Vec<&[u16]> = Vec::with_capacity(parts.len());
	let mut prev_part: Option<&[u16]> = None;
	let mut offset = 0;
	for part in parts {
		let end = offset + part.len();
		let part_is_ws = part.first().is_some_and(|&unit| is_ws_unit(unit));
		if part_is_ws {
			if prev_part.is_none() {
				tokens.push(part);
			} else {
				let last = tokens
					.last_mut()
					.expect("tokens non-empty after first part");
				*last = &text[offset - last.len()..end];
			}
		} else if let Some(prev) =
			prev_part.filter(|p| p.first().is_some_and(|&unit| is_ws_unit(unit)))
		{
			let token = &text[offset - prev.len()..end];
			if tokens.last().is_some_and(|last| *last == prev) {
				*tokens.last_mut().expect("checked non-empty") = token;
			} else {
				tokens.push(token);
			}
		} else {
			tokens.push(part);
		}
		prev_part = Some(part);
		offset = end;
	}
	tokens
}

/// jsdiff `WordDiff.join`: concatenate, stripping leading whitespace from
/// every token after the first.
fn word_join(tokens: &[&[u16]]) -> Vec<u16> {
	let cap: usize = tokens
		.iter()
		.enumerate()
		.map(|(i, t)| {
			if i == 0 {
				t.len()
			} else {
				trim_leading_ws(t).len()
			}
		})
		.sum();
	let mut out = Vec::with_capacity(cap);
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

fn remove_prefix_in_place(vec: &mut Vec<u16>, len: usize) {
	vec.drain(..len);
}

fn remove_suffix_in_place(vec: &mut Vec<u16>, len: usize) {
	vec.truncate(vec.len() - len);
}

// In-place prefix/suffix trimming replaces allocating `replace_prefix` /
// `replace_suffix`: every replacement in `dedupe_whitespace` substitutes a
// prefix of `old_suffix` (at the end of `start_keep`) or a suffix of
// `old_prefix` (at the start of `end_keep`).

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
	changes: &mut [Change<Vec<u16>>],
	start_keep: Option<usize>,
	deletion: Option<usize>,
	insertion: Option<usize>,
	end_keep: Option<usize>,
) {
	match (deletion, insertion) {
		(Some(del), Some(ins)) => {
			let (new_prefix_len, new_suffix_len, common_prefix_len, common_suffix_len) = {
				let old_ws_prefix = leading_ws(&changes[del].value);
				let old_ws_suffix = trailing_ws(&changes[del].value);
				let new_ws_prefix = leading_ws(&changes[ins].value);
				let new_ws_suffix = trailing_ws(&changes[ins].value);
				if let Some(start) = start_keep {
					assert!(
						changes[start].value.ends_with(new_ws_prefix),
						"value must end with recorded suffix"
					);
				}
				if let Some(end) = end_keep {
					assert!(
						changes[end].value.starts_with(new_ws_suffix),
						"value must start with recorded prefix"
					);
				}
				(
					new_ws_prefix.len(),
					new_ws_suffix.len(),
					longest_common_prefix(old_ws_prefix, new_ws_prefix).len(),
					longest_common_suffix(old_ws_suffix, new_ws_suffix).len(),
				)
			};
			if let Some(start) = start_keep {
				remove_suffix_in_place(&mut changes[start].value, new_prefix_len - common_prefix_len);
				remove_prefix_in_place(&mut changes[del].value, common_prefix_len);
				remove_prefix_in_place(&mut changes[ins].value, common_prefix_len);
			}
			if let Some(end) = end_keep {
				remove_prefix_in_place(&mut changes[end].value, new_suffix_len - common_suffix_len);
				remove_suffix_in_place(&mut changes[del].value, common_suffix_len);
				remove_suffix_in_place(&mut changes[ins].value, common_suffix_len);
			}
		},
		(None, Some(ins)) => {
			if start_keep.is_some() {
				let ws_len = leading_ws(&changes[ins].value).len();
				remove_prefix_in_place(&mut changes[ins].value, ws_len);
			}
			if let Some(end) = end_keep {
				let ws_len = leading_ws(&changes[end].value).len();
				remove_prefix_in_place(&mut changes[end].value, ws_len);
			}
		},
		(Some(del), None) => match (start_keep, end_keep) {
			(Some(start), Some(end)) => {
				let (full_len, new_ws_start_len, new_ws_end_len) = {
					let new_ws_full = leading_ws(&changes[end].value);
					let del_ws_start = leading_ws(&changes[del].value);
					let del_ws_end = trailing_ws(&changes[del].value);
					assert!(
						changes[start].value.ends_with(new_ws_full),
						"value must end with recorded suffix"
					);
					let new_ws_start_len = longest_common_prefix(new_ws_full, del_ws_start).len();
					let new_ws_end_len =
						longest_common_suffix(&new_ws_full[new_ws_start_len..], del_ws_end).len();
					(new_ws_full.len(), new_ws_start_len, new_ws_end_len)
				};
				remove_prefix_in_place(&mut changes[del].value, new_ws_start_len);
				remove_suffix_in_place(&mut changes[del].value, new_ws_end_len);
				remove_prefix_in_place(&mut changes[end].value, full_len - new_ws_end_len);
				remove_suffix_in_place(&mut changes[start].value, new_ws_end_len);
			},
			(None, Some(end)) => {
				let end_keep_ws_prefix = leading_ws(&changes[end].value);
				let deletion_ws_suffix = trailing_ws(&changes[del].value);
				let overlap_len = maximum_overlap(deletion_ws_suffix, end_keep_ws_prefix).len();
				remove_suffix_in_place(&mut changes[del].value, overlap_len);
			},
			(Some(start), None) => {
				let start_keep_ws_suffix = trailing_ws(&changes[start].value);
				let deletion_ws_prefix = leading_ws(&changes[del].value);
				let overlap_len = maximum_overlap(start_keep_ws_suffix, deletion_ws_prefix).len();
				remove_prefix_in_place(&mut changes[del].value, overlap_len);
			},
			(None, None) => {},
		},
		(None, None) => {},
	}
}

/// jsdiff `WordDiff.postProcess` under default options.
fn word_post_process(changes: &mut [Change<Vec<u16>>]) {
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

/// Word diff with jsdiff `diffWords` semantics over UTF-16 code units.
pub fn diff_words_u16(old_text: &[u16], new_text: &[u16]) -> Vec<Change<Vec<u16>>> {
	let old_refs = word_tokens(old_text);
	let new_refs = word_tokens(new_text);
	// Equality is whitespace-insensitive: intern by trimmed text.
	let old_keys: Vec<&[u16]> = old_refs.iter().map(|token| js_trim(token)).collect();
	let new_keys: Vec<&[u16]> = new_refs.iter().map(|token| js_trim(token)).collect();
	let (old_ids, new_ids) = intern(&old_keys, &new_keys);
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
		diff_lines_u16(&u16s(old), &u16s(new))
			.into_iter()
			.map(|change| (String::from_utf16(&change.value).unwrap(), change.added, change.removed))
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
	fn common_runs_take_values_from_new_tokens() {
		let old = String::from("same");
		let new = String::from("same");
		let old_tokens = [old.as_str()];
		let new_tokens = [new.as_str()];
		let changes = build_changes(
			&[Run { count: 1, added: false, removed: false }],
			&old_tokens,
			&new_tokens,
			|tokens| tokens[0].as_ptr(),
		);
		assert_eq!(changes[0].value, new.as_ptr());
		assert_ne!(changes[0].value, old.as_ptr());
	}

	#[test]
	fn structured_patch_marks_missing_eof_newline() {
		let hunks = structured_patch_hunks_u16(&u16s("a\nb"), &u16s("a\nc"), Some(3));
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
		let words = |old: &str, new: &str| -> Vec<(String, bool, bool)> {
			diff_words_u16(&u16s(old), &u16s(new))
				.into_iter()
				.map(|change| {
					(String::from_utf16(&change.value).unwrap(), change.added, change.removed)
				})
				.collect()
		};
		assert_eq!(words("foo bar baz", "foo qux baz"), vec![
			("foo ".into(), false, false),
			("bar".into(), false, true),
			("qux".into(), true, false),
			(" baz".into(), false, false),
		]);
		// Asymmetric whitespace around replacement
		assert_eq!(words("foo  bar\tbaz", "foo   qux\t\tbaz"), vec![
			("foo  ".into(), false, false),
			("bar".into(), false, true),
			(" qux\t".into(), true, false),
			("\tbaz".into(), false, false),
		]);
		// Pure insertion between keeps
		assert_eq!(words("foo baz", "foo bar baz"), vec![
			("foo ".into(), false, false),
			("bar ".into(), true, false),
			("baz".into(), false, false),
		]);
		// Pure deletion between keeps, at start, and at end
		assert_eq!(words("foo bar baz", "foo baz"), vec![
			("foo ".into(), false, false),
			("bar ".into(), false, true),
			("baz".into(), false, false),
		]);
		assert_eq!(words("foo bar", "bar"), vec![
			("foo ".into(), false, true),
			("bar".into(), false, false),
		]);
		assert_eq!(words("foo bar", "foo"), vec![
			("foo".into(), false, false),
			(" bar".into(), false, true),
		]);
	}

	#[test]
	fn line_runs_preserve_empty_lines() {
		let old = u16s("a\n\nb");
		let new = u16s("a\n\nc");
		let runs = line_runs_u16(&old, &new);
		let shaped: Vec<(u32, bool, bool)> = runs
			.into_iter()
			.map(|run| (run.count, run.added, run.removed))
			.collect();
		assert_eq!(shaped, vec![(2, false, false), (1, false, true), (1, true, false)]);
	}

	#[test]
	fn unpaired_surrogates_diff_as_distinct_content() {
		let old = [0x61, 0xd800, LF];
		let new = [0x61, 0xd801, LF];
		let shaped: Vec<(Vec<u16>, bool, bool)> = diff_lines_u16(&old, &new)
			.into_iter()
			.map(|change| (change.value, change.added, change.removed))
			.collect();
		assert_eq!(shaped, vec![(old.to_vec(), false, true), (new.to_vec(), true, false)]);
	}

	#[test]
	fn word_scan_keeps_lone_surrogate_before_astral_pair_separate() {
		let old: Vec<u16> = [0xd800, 0xd83d, 0xde80].to_vec();
		let new: Vec<u16> = [0xd800, 0x78].to_vec();
		let shaped: Vec<(Vec<u16>, bool, bool)> = diff_words_u16(&old, &new)
			.into_iter()
			.map(|change| (change.value, change.added, change.removed))
			.collect();
		assert_eq!(shaped, vec![
			(vec![0xd800], false, false),
			(vec![0xd83d, 0xde80], false, true),
			(vec![0x78], true, false),
		]);
	}

	#[test]
	fn myers_diff_coalesces_interleaved_insertions_and_deletions_across_diagonals() {
		let old = [1, 2, 3, 4, 5, 6, 7, 8];
		let new = [1, 9, 10, 4, 5, 11, 8];
		assert_eq!(myers_diff(&old, &new), vec![
			Run { count: 1, added: false, removed: false },
			Run { count: 2, added: false, removed: true },
			Run { count: 2, added: true, removed: false },
			Run { count: 2, added: false, removed: false },
			Run { count: 2, added: false, removed: true },
			Run { count: 1, added: true, removed: false },
			Run { count: 1, added: false, removed: false },
		]);
	}
}
