//! jsdiff-compatible diff primitives without an FFI dependency.
//!
//! The Myers O(ND) core and line, word, and structured-patch helpers preserve
//! jsdiff v9's default tie-breaking and change coalescing. UTF-16 entry points
//! operate on JavaScript code units, while UTF-8 line helpers serve native Rust
//! callers with the same token and run semantics.

use std::{collections::HashMap, hash::Hash, rc::Rc};

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
			count:   component.count as u32,
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
pub fn myers_diff(old: &[u32], new: &[u32]) -> Vec<Run> {
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

fn diff_line_tokens<T: Eq + Hash + Copy>(old_tokens: &[T], new_tokens: &[T]) -> Vec<Run> {
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

fn concat_tokens_str(tokens: &[&str]) -> String {
	let mut out = String::with_capacity(tokens.iter().map(|token| token.len()).sum());
	for token in tokens {
		out.push_str(token);
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

/// Line changes with jsdiff `diffLines` semantics over UTF-8 text.
pub fn line_changes_str(old: &str, new: &str) -> Vec<Change<String>> {
	let old_tokens = line_tokens_str(old);
	let new_tokens = line_tokens_str(new);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);
	build_changes(&runs, &old_tokens, &new_tokens, concat_tokens_str)
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

/// Prepend a unified-diff marker to a UTF-16 line.
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

/// Build jsdiff-compatible unified hunks from precomputed line runs.
pub fn structured_patch_hunks_from_runs_u16(
	context: Option<u32>,
	old_tokens: &[&[u16]],
	new_tokens: &[&[u16]],
	runs: &[Run],
) -> Vec<Hunk> {
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
		let count = run.count as usize;
		let lines: &[&[u16]] = if run.removed {
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
		.map(|hunk| Hunk {
			old_start: hunk.old_start as u32,
			old_lines: hunk.old_lines as u32,
			new_start: hunk.new_start as u32,
			new_lines: hunk.new_lines as u32,
			lines:     hunk.lines,
		})
		.collect()
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
	changes: &mut [Change<Vec<u16>>],
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
					replace_suffix(&changes[start].value, &new_ws_prefix, &common_ws_prefix);
				changes[del].value = remove_prefix(&changes[del].value, &common_ws_prefix);
				changes[ins].value = remove_prefix(&changes[ins].value, &common_ws_prefix);
			}
			if let Some(end) = end_keep {
				let common_ws_suffix = longest_common_suffix(&old_ws_suffix, &new_ws_suffix).to_vec();
				changes[end].value =
					replace_prefix(&changes[end].value, &new_ws_suffix, &common_ws_suffix);
				changes[del].value = remove_suffix(&changes[del].value, &common_ws_suffix);
				changes[ins].value = remove_suffix(&changes[ins].value, &common_ws_suffix);
			}
		},
		(None, Some(ins)) => {
			if start_keep.is_some() {
				let ws_len = leading_ws(&changes[ins].value).len();
				changes[ins].value = changes[ins].value[ws_len..].to_vec();
			}
			if let Some(end) = end_keep {
				let ws_len = leading_ws(&changes[end].value).len();
				changes[end].value = changes[end].value[ws_len..].to_vec();
			}
		},
		(Some(del), None) => match (start_keep, end_keep) {
			(Some(start), Some(end)) => {
				let new_ws_full = leading_ws(&changes[end].value).to_vec();
				let del_ws_start = leading_ws(&changes[del].value).to_vec();
				let del_ws_end = trailing_ws(&changes[del].value).to_vec();
				let new_ws_start = longest_common_prefix(&new_ws_full, &del_ws_start).to_vec();
				changes[del].value = remove_prefix(&changes[del].value, &new_ws_start);
				let new_ws_end =
					longest_common_suffix(&new_ws_full[new_ws_start.len()..], &del_ws_end).to_vec();
				changes[del].value = remove_suffix(&changes[del].value, &new_ws_end);
				changes[end].value = replace_prefix(&changes[end].value, &new_ws_full, &new_ws_end);
				let start_ws = &new_ws_full[..new_ws_full.len() - new_ws_end.len()];
				changes[start].value = replace_suffix(&changes[start].value, &new_ws_full, start_ws);
			},
			(None, Some(end)) => {
				let end_keep_ws_prefix = leading_ws(&changes[end].value).to_vec();
				let deletion_ws_suffix = trailing_ws(&changes[del].value).to_vec();
				let overlap = maximum_overlap(&deletion_ws_suffix, &end_keep_ws_prefix).to_vec();
				changes[del].value = remove_suffix(&changes[del].value, &overlap);
			},
			(Some(start), None) => {
				let start_keep_ws_suffix = trailing_ws(&changes[start].value).to_vec();
				let deletion_ws_prefix = leading_ws(&changes[del].value).to_vec();
				let overlap = maximum_overlap(&start_keep_ws_suffix, &deletion_ws_prefix).to_vec();
				changes[del].value = remove_prefix(&changes[del].value, &overlap);
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
	let old_tokens = word_tokens(old_text);
	let new_tokens = word_tokens(new_text);
	let old_refs: Vec<&[u16]> = old_tokens.iter().map(Vec::as_slice).collect();
	let new_refs: Vec<&[u16]> = new_tokens.iter().map(Vec::as_slice).collect();
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
	fn utf8_and_utf16_line_changes_agree_for_ascii() {
		let old = "a\nb\nc\n";
		let new = "a\nx\nc\n";
		let utf8 = line_changes_str(old, new);
		let utf16 = diff_lines_u16(&u16s(old), &u16s(new));
		let utf16_shaped: Vec<Change<String>> = utf16
			.into_iter()
			.map(|change| Change {
				value:   String::from_utf16(&change.value).unwrap(),
				count:   change.count,
				added:   change.added,
				removed: change.removed,
			})
			.collect();
		assert_eq!(utf8, utf16_shaped);
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
		assert_eq!(line_changes_str(&old, &new)[0].value, new);
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
		let changes = diff_words_u16(&u16s("foo bar baz"), &u16s("foo qux baz"));
		let shaped: Vec<(String, bool, bool)> = changes
			.into_iter()
			.map(|change| (String::from_utf16(&change.value).unwrap(), change.added, change.removed))
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
}
