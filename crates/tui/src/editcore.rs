//! Editing core: the flat-text [`EditBuffer`] (grapheme-safe word wrapping
//! and navigation, undo, kill-ring yank/yank-pop, atomic
//! references, character jumps, sticky page motion) and the
//! [`Editor`] built on top of it (pluggable completion, inline ghost
//! hints, emoji expansion, prompt history).

use std::{
	cell::Cell,
	cmp::Reverse,
	collections::HashMap,
	env, fs, iter, ops,
	ops::Range,
	path,
	path::{Path, PathBuf},
	sync::{Arc, LazyLock},
};

use im::Vector;
use omp_core::{Str, sf, str::IntoStr};
use smallvec::SmallVec;
use xutf::Text;

use crate::{
	Icon,
	input::{Key, sanitize_paste},
	rich::cell_width,
};

const KILL_CAP: usize = 60;
const UNDO_CAP: usize = 100;
/// Default dropdown window.
const PICKER_ROWS: usize = 10;
/// Page navigation fallback before a host reports its rendered viewport.
const DEFAULT_PAGE_ROWS: usize = 10;
/// Completion window bounds.
const PICKER_ROWS_MIN: usize = 3;
const PICKER_ROWS_MAX: usize = 20;
const MAX_INPUT_ROWS: usize = 16;
const MAX_EMOJI_SUGGESTIONS: usize = 12;
const HISTORY_CAPACITY: usize = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
/// Whether an editing command changed the buffer.
pub enum BufferOutcome {
	/// Text, cursor, or transient editing state changed.
	Changed,
	/// The key had no applicable effect.
	Ignored,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Action {
	Kill,
	Yank,
	YankPop,
	TypeWord,
	Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Jump {
	Forward,
	Backward,
}

/// One atomic unit in the visible text: the `start..end` marker range is
/// displayed, navigated, and deleted as a whole, and `payload` replaces it
/// in the submitted text. Ranges are maintained through every edit, so
/// text that merely looks like a marker is never treated as one.
#[derive(Clone, Debug)]
struct Atom {
	start:   usize,
	end:     usize,
	payload: Str,
}

#[derive(Clone, Copy, Debug)]
/// One visual word-wrapped row borrowed from an [`EditBuffer`].
pub struct VisualRow<'a> {
	/// UTF-8 byte start in the complete buffer.
	pub start:         usize,
	/// UTF-8 byte end in the complete buffer.
	pub end:           usize,
	/// Grapheme-aligned text belonging to the row.
	pub text:          &'a str,
	/// Cursor cell column when this row owns the cursor.
	pub cursor_column: Option<u16>,
}

#[derive(Clone, Copy, Debug)]
struct Segment {
	/// Source span owned by this row, including whitespace hidden at a wrap.
	source_start: usize,
	source_end:   usize,
	/// Visible contiguous slice within the source span.
	start:        usize,
	end:          usize,
	last:         bool,
}

#[derive(Clone, Debug)]
struct KillEntry {
	text:  String,
	atoms: Vector<Atom>,
}

/// Shared flat text editing model used by the widget and chat editors.
#[derive(Clone, Debug)]
pub struct EditBuffer {
	text:          String,
	cursor:        usize,
	anchor:        Option<usize>,
	copied:        Option<Str>,
	desired:       Option<u16>,
	kill_ring:     Vec<KillEntry>,
	kill_index:    usize,
	last_yank:     Option<(usize, usize)>,
	last_action:   Action,
	undo:          Vec<(String, usize, Vector<Atom>)>,
	atoms:         Vector<Atom>,
	jump:          Option<Jump>,
	layout_width:  Cell<u16>,
	xml:           bool,
	view_offset:   Cell<usize>,
	manual_scroll: Cell<bool>,
}

impl Default for EditBuffer {
	fn default() -> Self {
		Self::new("")
	}
}

impl EditBuffer {
	/// Creates a buffer with the cursor at the end of sanitized `text`.
	pub fn new(text: &str) -> Self {
		let text = sanitize_paste(text);
		let cursor = text.len();
		Self {
			text,
			cursor,
			anchor: None,
			copied: None,
			desired: None,
			kill_ring: Vec::new(),
			kill_index: 0,
			last_yank: None,
			last_action: Action::Other,
			undo: Vec::new(),
			atoms: Vector::new(),
			jump: None,
			layout_width: Cell::new(80),
			view_offset: Cell::new(0),
			manual_scroll: Cell::new(false),
			xml: true,
		}
	}

	/// Enables `</` close-tag completion (on by default).
	pub const fn set_xml(&mut self, xml: bool) {
		self.xml = xml;
	}

	/// Returns the visible marker text.
	pub fn text(&self) -> &str {
		&self.text
	}

	/// Returns the UTF-8 byte cursor.
	pub const fn cursor(&self) -> usize {
		self.cursor
	}

	/// Returns the normalized selected UTF-8 byte range, or `None` when
	/// collapsed.
	pub fn selection(&self) -> Option<Range<usize>> {
		let anchor = self.anchor?;
		if anchor == self.cursor {
			return None;
		}
		let (start, end) = if anchor < self.cursor {
			(anchor, self.cursor)
		} else {
			(self.cursor, anchor)
		};
		let (start, end) = self.expand_to_atoms(start, end);
		Some(start..end)
	}

	/// Returns the selected visible text.
	pub fn selected_text(&self) -> Option<&str> {
		self.selection().map(|range| &self.text[range])
	}

	/// Selects the complete buffer.
	pub const fn select_all(&mut self) {
		self.anchor = Some(0);
		self.cursor = self.text.len();
		self.desired = None;
		self.break_sequence();
	}

	/// Collapses the active selection at its cursor edge.
	pub const fn clear_selection(&mut self) {
		self.anchor = None;
	}

	/// Takes the text captured by the last `Copy`/`Cut`, handing the
	/// clipboard write to the host (OSC 52 on terminals, a detached
	/// native write on the GPU host).
	pub const fn take_copied(&mut self) -> Option<Str> {
		self.copied.take()
	}

	/// Returns the selected display-column span intersecting `row`.
	pub fn selection_span(&self, row: &VisualRow<'_>) -> Option<(u16, u16)> {
		let selection = self.selection()?;
		let start = selection.start.max(row.start);
		let end = selection.end.min(row.end);
		if start >= end {
			return None;
		}
		Some((cell_width(&row.text[..start - row.start]), cell_width(&row.text[..end - row.start])))
	}

	/// Returns the number of logical newline-delimited lines.
	pub fn line_count(&self) -> usize {
		self.text.bytes().filter(|byte| *byte == b'\n').count() + 1
	}

	/// Returns the zero-based logical cursor line.
	pub fn cursor_line(&self) -> usize {
		self.text[..self.cursor]
			.bytes()
			.filter(|byte| *byte == b'\n')
			.count()
	}

	/// Returns the cursor's cell column within its logical line.
	pub fn cursor_column(&self) -> u16 {
		let (start, _) = self.line_bounds();
		cell_width(&self.text[start..self.cursor])
	}

	/// Iterates logical lines without allocating.
	pub fn logical_lines(
		&self,
	) -> impl DoubleEndedIterator<Item = &str> + Clone + iter::FusedIterator + '_ {
		self.text.split('\n')
	}

	/// Replaces text without creating an undo entry, for history browsing.
	pub fn replace_external(&mut self, text: &str, cursor_at_start: bool) {
		self.text = sanitize_paste(text);
		self.atoms.clear();
		self.cursor = if cursor_at_start { 0 } else { self.text.len() };
		self.undo.clear();
		self.anchor = None;
		self.desired = None;
		self.view_offset.set(0);
		self.manual_scroll.set(false);
		self.break_sequence();
	}

	/// Moves the cursor to the start (`end == false`) or end of the whole
	/// message, collapsing any selection.
	pub fn move_to_message_edge(&mut self, end: bool) -> BufferOutcome {
		let at = if end { self.text.len() } else { 0 };
		self.anchor = None;
		self.desired = None;
		self.manual_scroll.set(false);
		self.move_to(at)
	}

	/// Undoes the last meaningful edit while ignoring `transient` text that
	/// was just removed at the cursor: every
	/// undo snapshot that only differs from the current text by a partially
	/// typed `transient` is discarded first, so a `#undo` trigger never
	/// counts as the edit being undone.
	pub fn undo_past_transient(&mut self, transient: &str) -> BufferOutcome {
		let (before, after) = self.text.split_at(self.cursor);
		while let Some((text, ..)) = self.undo.last() {
			let typed = text
				.strip_prefix(before)
				.and_then(|rest| rest.strip_suffix(after));
			let Some(typed) = typed else {
				break;
			};
			if !transient.starts_with(typed) {
				break;
			}
			self.undo.pop();
		}
		self.undo()
	}

	/// Places the cursor on a logical line and cell column.
	pub fn set_cursor_line_column(&mut self, line: usize, column: u16) {
		let mut start = 0;
		for _ in 0..line {
			let Some(offset) = self.text[start..].find('\n') else {
				break;
			};
			start += offset + 1;
		}
		let end = self.text[start..]
			.find('\n')
			.map_or(self.text.len(), |offset| start + offset);
		let at = start + byte_at_column(&self.text[start..end], column);
		self.cursor = self.snap_position(at, at >= self.cursor);
		self.anchor = None;
		self.desired = None;
		self.manual_scroll.set(false);
		self.break_sequence();
	}

	/// Places the cursor on a visible visual row and cell column.
	pub fn set_cursor_visual_row(&mut self, row: usize, column: u16, width_limit: u16) {
		self.layout_width.set(width_limit.max(1));
		let at = self.visual_position(row, column, width_limit);
		self.cursor = self.snap_position(at, at >= self.cursor);
		self.anchor = None;
		self.desired = None;
		self.manual_scroll.set(false);
		self.break_sequence();
	}

	/// Extends the selection to a visible visual row and cell column.
	pub fn extend_selection_visual_row(&mut self, row: usize, column: u16, width_limit: u16) {
		self.layout_width.set(width_limit.max(1));
		let anchor = *self.anchor.get_or_insert(self.cursor);
		let at = self.visual_position(row, column, width_limit);
		self.cursor = self.snap_position(at, at >= anchor);
		self.desired = None;
		self.manual_scroll.set(false);
		self.break_sequence();
	}

	/// Selects the coarse word around a position on a visible visual row.
	pub fn select_word_visual_row(&mut self, row: usize, column: u16, width_limit: u16) {
		self.layout_width.set(width_limit.max(1));
		let at = self.visual_position(row, column, width_limit);
		let (seed_start, seed_end) = if let Some(grapheme) = self.text[at..].graphemes().next() {
			(at, at + grapheme.len())
		} else if let Some((start, grapheme)) = self.text[..at].grapheme_indices().next_back() {
			(start, start + grapheme.len())
		} else {
			self.cursor = at;
			self.anchor = None;
			return;
		};
		let class = word_class(&self.text[seed_start..seed_end]);
		let (start, end) = if class == WordClass::Whitespace {
			let start = self.text[..seed_start]
				.grapheme_indices()
				.rev()
				.take_while(|(_, grapheme)| word_class(grapheme) == class)
				.map(|(at, _)| at)
				.last()
				.unwrap_or(seed_start);
			let end = self.text[seed_end..]
				.grapheme_indices()
				.take_while(|(_, grapheme)| word_class(grapheme) == class)
				.map(|(at, grapheme)| seed_end + at + grapheme.len())
				.last()
				.unwrap_or(seed_end);
			self.expand_to_atoms(start, end)
		} else {
			self.expand_to_atoms(word_left(&self.text, seed_end), word_right(&self.text, seed_start))
		};
		self.anchor = Some(start);
		self.cursor = end;
		self.desired = None;
		self.manual_scroll.set(false);
		self.break_sequence();
	}

	/// Replaces a byte range as one undoable edit. A non-empty range that
	/// touches an atomic marker widens to the whole marker, so partial
	/// replacements can never tear a unit apart.
	pub fn replace_range(&mut self, range: ops::Range<usize>, replacement: &str) {
		self.snapshot();
		let (start, end) = if range.is_empty() {
			(range.start, range.end)
		} else {
			self.expand_to_atoms(range.start, range.end)
		};
		self.cursor = start + replacement.len();
		self.splice(start..end, replacement);
		self.anchor = None;
		self.desired = None;
		self.break_sequence();
	}

	fn restore_cursor_offset(&mut self, offset: usize) {
		let cursor = self.cursor.saturating_add(offset).min(self.text.len());
		if self.text.is_char_boundary(cursor) {
			self.cursor = cursor;
		}
	}

	/// Replaces a transient range without recording an undo snapshot.
	///
	/// Streaming speech previews use this to replace one volatile span while
	/// preserving a caret before or after that span.
	fn replace_transient_range(
		&mut self,
		range: ops::Range<usize>,
		replacement: &str,
	) -> ops::Range<usize> {
		let range = if range.start <= range.end
			&& range.end <= self.text.len()
			&& self.text.is_char_boundary(range.start)
			&& self.text.is_char_boundary(range.end)
		{
			range
		} else {
			self.cursor..self.cursor
		};
		let old_end = range.end;
		let was_empty = range.is_empty();
		let prior_cursor = self.cursor;
		let replacement = sanitize_paste(replacement);
		self.splice(range.clone(), &replacement);
		let new_end = range.start + replacement.len();
		self.cursor = if was_empty && prior_cursor == range.start {
			new_end
		} else if prior_cursor <= range.start {
			prior_cursor
		} else if prior_cursor >= old_end {
			prior_cursor - (old_end - range.start) + replacement.len()
		} else {
			new_end
		};
		self.anchor = None;
		self.desired = None;
		self.break_sequence();
		range.start..new_end
	}

	/// Replaces a volatile range with one undoable committed edit.
	fn commit_transient_range(&mut self, range: ops::Range<usize>, replacement: &str) {
		let start = range.start;
		self.replace_transient_range(range, "");
		let replacement = sanitize_paste(replacement);
		if replacement.is_empty() {
			return;
		}
		self.snapshot();
		let prior_cursor = self.cursor;
		self.splice(start..start, &replacement);
		if prior_cursor >= start {
			self.cursor = prior_cursor + replacement.len();
		}
		self.anchor = None;
		self.desired = None;
		self.break_sequence();
	}

	/// Widens `start..end` to whole-atom bounds for every atom it touches.
	fn expand_to_atoms(&self, mut start: usize, mut end: usize) -> (usize, usize) {
		for atom in &self.atoms {
			if start < atom.end && end > atom.start {
				start = start.min(atom.start);
				end = end.max(atom.end);
			}
		}
		(start, end)
	}

	/// Replaces `range` with `replacement`, shifting the atoms behind the
	/// edit and dropping any atom the edit tears through.
	fn splice(&mut self, range: ops::Range<usize>, replacement: &str) {
		let inserted = replacement.len();
		self
			.atoms
			.retain(|atom| atom.end <= range.start || atom.start >= range.end);
		for atom in self.atoms.iter_mut().filter(|atom| atom.start >= range.end) {
			atom.start = atom.start - range.len() + inserted;
			atom.end = atom.end - range.len() + inserted;
		}
		self.text.replace_range(range, replacement);
	}

	/// Inserts sanitized text at the cursor.
	///
	/// Text is inserted verbatim; hosts that collapse large pastes into
	/// compact chips stage them through [`EditBuffer::insert_reference`].
	pub fn insert_text(&mut self, text: &str) -> BufferOutcome {
		let sanitized = sanitize_paste(text);
		if sanitized.is_empty() {
			return BufferOutcome::Ignored;
		}
		self.snapshot();
		self.break_sequence();
		let range = self.selection().unwrap_or(self.cursor..self.cursor);
		let start = range.start;
		self.splice(range, &sanitized);
		self.cursor = start + sanitized.len();
		self.anchor = None;
		self.desired = None;
		BufferOutcome::Changed
	}

	/// Returns text with every atomic reference expanded to its payload.
	pub fn expanded_text(&self) -> String {
		let mut atoms: SmallVec<&Atom, 4> = self.atoms.iter().collect();
		atoms.sort_unstable_by_key(|atom| atom.start);
		let mut result = String::with_capacity(self.text.len());
		let mut at = 0;
		for atom in atoms {
			result.push_str(&self.text[at..atom.start]);
			result.push_str(&atom.payload);
			at = atom.end;
		}
		result.push_str(&self.text[at..]);
		result
	}

	/// Inserts an atomic reference at the cursor: `marker` is displayed,
	/// navigated, and deleted as one unit, and expands to `payload` in the
	/// submitted text. `marker` must be a single line.
	///
	/// The unit is tracked by position, not by content: typed text that
	/// happens to equal `marker` stays ordinary text.
	pub fn insert_reference(&mut self, marker: &str, payload: &str) -> BufferOutcome {
		if marker.is_empty() || marker.contains('\n') {
			return BufferOutcome::Ignored;
		}
		self.snapshot();
		self.break_sequence();
		let range = self.selection().unwrap_or(self.cursor..self.cursor);
		let start = range.start;
		self.splice(range, marker);
		self.cursor = start + marker.len();
		self.anchor = None;
		self
			.atoms
			.push_back(Atom { start, end: start + marker.len(), payload: Str::new(payload) });
		self.desired = None;
		BufferOutcome::Changed
	}

	/// Inserts references and a suffix after each as one undoable action.
	///
	/// Invalid (empty or multiline) markers are ignored. This is used for one
	/// terminal paste/drop gesture that produces one or more attachment chips.
	pub fn insert_reference_group(
		&mut self,
		references: &[(String, String)],
		suffix: &str,
	) -> BufferOutcome {
		if references
			.iter()
			.all(|(marker, _)| marker.is_empty() || marker.contains('\n'))
		{
			return BufferOutcome::Ignored;
		}
		self.snapshot();
		self.break_sequence();
		let range = self.selection().unwrap_or(self.cursor..self.cursor);
		let start = range.start;
		self.splice(range, "");
		self.cursor = start;
		self.anchor = None;
		for (marker, payload) in references {
			if marker.is_empty() || marker.contains('\n') {
				continue;
			}
			let start = self.cursor;
			self.splice(start..start, marker);
			self.cursor += marker.len();
			self
				.atoms
				.push_back(Atom { start, end: self.cursor, payload: Str::new(payload) });
			self.splice(self.cursor..self.cursor, suffix);
			self.cursor += suffix.len();
		}
		self.desired = None;
		BufferOutcome::Changed
	}

	/// Byte ranges of atomic markers present in the text, ascending. Slice
	/// [`EditBuffer::text`] with a range to recover the marker.
	pub fn atom_ranges(&self) -> SmallVec<(usize, usize), 4> {
		let mut ranges: SmallVec<(usize, usize), 4> = self
			.atoms
			.iter()
			.map(|atom| (atom.start, atom.end))
			.collect();
		ranges.sort_unstable();
		ranges
	}

	/// Returns expanded text and resets the buffer after submission.
	pub fn clear_after_submit(&mut self) -> String {
		let result = self.expanded_text();
		self.text.clear();
		self.cursor = 0;
		self.anchor = None;
		self.desired = None;
		self.undo.clear();
		self.atoms.clear();
		self.view_offset.set(0);
		self.manual_scroll.set(false);
		self.break_sequence();
		result
	}

	/// Applies a decoded editor key at the given layout width.
	pub fn handle(&mut self, key: Key, width: u16, page_rows: usize) -> BufferOutcome {
		self.layout_width.set(width.max(1));
		// The copy stash lives exactly one key: hosts drain it right after
		// the `Copy`/`Cut` that filled it, and any other key voids it so a
		// later drain can never emit stale clipboard contents.
		self.copied = None;
		self.manual_scroll.set(false);
		if let Some(jump) = self.jump.take() {
			return match key {
				Key::Char(ch) => self.jump_to(ch, jump),
				Key::Space => self.jump_to(' ', jump),
				_ => BufferOutcome::Ignored,
			};
		}
		match key {
			Key::Ctrl(']') => {
				self.anchor = None;
				self.jump = Some(Jump::Forward);
				self.break_sequence();
				BufferOutcome::Changed
			},
			Key::CtrlAlt(']') => {
				self.anchor = None;
				self.jump = Some(Jump::Backward);
				self.break_sequence();
				BufferOutcome::Changed
			},
			Key::Ctrl('-' | '_') => self.undo(),
			Key::Ctrl('y') => self.yank(),
			Key::Alt('y') => self.yank_pop(),
			Key::Ctrl('k') => self.kill_line_end(),
			Key::Ctrl('u') => self.kill_line_start(),
			Key::Ctrl('w') => self.kill_word_backward(),
			Key::WordDelete => self.kill_word_forward(),
			Key::Backspace => self.backspace(),
			Key::Delete | Key::Ctrl('d') => self.delete(),
			Key::Left | Key::Ctrl('b') => self.collapse_or(false, Self::move_left),
			Key::Right | Key::Ctrl('f') => self.collapse_or(true, Self::move_right),
			Key::WordLeft => self.collapse_or(false, |buffer| {
				let at = buffer.word_left();
				buffer.move_to(at)
			}),
			Key::WordRight => self.collapse_or(true, |buffer| {
				let at = buffer.word_right();
				buffer.move_to(at)
			}),
			Key::Home | Key::Ctrl('a') => self.collapse_or(false, |buffer| {
				let at = buffer.line_bounds().0;
				buffer.move_to(at)
			}),
			Key::End | Key::Ctrl('e') => self.collapse_or(true, |buffer| {
				let at = buffer.line_bounds().1;
				buffer.move_to(at)
			}),
			Key::Up => self.collapse_or(false, |buffer| buffer.move_visual(-1)),
			Key::Down => self.collapse_or(true, |buffer| buffer.move_visual(1)),
			Key::PageUp => self.collapse_or(false, |buffer| {
				buffer.move_visual(-(page_rows.saturating_sub(1).max(1) as isize))
			}),
			Key::PageDown => self.collapse_or(true, |buffer| {
				buffer.move_visual(page_rows.saturating_sub(1).max(1) as isize)
			}),
			Key::SelectLeft => self.extend(Self::move_left),
			Key::SelectRight => self.extend(Self::move_right),
			Key::SelectWordLeft => self.extend(|buffer| {
				let at = buffer.word_left();
				buffer.move_to(at)
			}),
			Key::SelectWordRight => self.extend(|buffer| {
				let at = buffer.word_right();
				buffer.move_to(at)
			}),
			Key::SelectHome => self.extend(|buffer| {
				let at = buffer.line_bounds().0;
				buffer.move_to(at)
			}),
			Key::SelectEnd => self.extend(|buffer| {
				let at = buffer.line_bounds().1;
				buffer.move_to(at)
			}),
			Key::SelectUp => self.extend(|buffer| buffer.move_visual(-1)),
			Key::SelectDown => self.extend(|buffer| buffer.move_visual(1)),
			Key::SelectAll => {
				self.select_all();
				BufferOutcome::Changed
			},
			Key::Copy => self.copy_selection(),
			Key::Cut => self.cut_selection(),
			Key::Esc => {
				let changed = self.selection().is_some();
				self.anchor = None;
				self.break_sequence();
				if changed {
					BufferOutcome::Changed
				} else {
					BufferOutcome::Ignored
				}
			},
			Key::Enter | Key::ShiftEnter => self.insert_char('\n'),
			Key::Space => self.insert_char(' '),
			Key::Char(ch) => self.insert_char(ch),
			_ => {
				self.break_sequence();
				BufferOutcome::Ignored
			},
		}
	}

	/// Returns the visible visual rows.
	///
	/// Keyboard editing keeps the cursor in view. A manual viewport scroll
	/// remains detached until the next editing command.
	pub fn rows(&self, width_limit: u16, max_rows: usize) -> SmallVec<VisualRow<'_>, 8> {
		self.rows_with_metrics(width_limit, max_rows).0
	}

	/// Returns visible rows and `(first, visible, total)` viewport metrics from
	/// one wrapping pass.
	pub fn rows_with_metrics(
		&self,
		width_limit: u16,
		max_rows: usize,
	) -> (SmallVec<VisualRow<'_>, 8>, (usize, usize, usize)) {
		let width_limit = width_limit.max(1);
		self.layout_width.set(width_limit);
		let segments = self.segments(width_limit);
		let cursor_row = self.segment_at_cursor(&segments);
		let total = segments.len();
		let visible = total.min(max_rows);
		let max_offset = total - visible;
		let first = if self.manual_scroll.get() {
			self.view_offset.get().min(max_offset)
		} else {
			cursor_row
				.saturating_sub(max_rows.saturating_sub(1))
				.min(max_offset)
		};
		self.view_offset.set(first);
		let rows = segments[first..first + visible]
			.iter()
			.map(|segment| VisualRow {
				start:         segment.start,
				end:           segment.end,
				text:          &self.text[segment.start..segment.end],
				cursor_column: (self.cursor >= segment.source_start
					&& self.cursor <= segment.source_end
					&& (segment.last || self.cursor < segment.source_end))
					.then(|| {
						let cursor = self.cursor.clamp(segment.start, segment.end);
						cell_width(&self.text[segment.start..cursor])
					}),
			})
			.collect();
		(rows, (first, visible, total))
	}

	/// Moves the visible row window without moving the cursor.
	///
	/// Returns whether the clamped viewport offset changed.
	pub fn scroll_rows(&self, delta: i32, width_limit: u16, max_rows: usize) -> bool {
		let width_limit = width_limit.max(1);
		self.layout_width.set(width_limit);
		let segments = self.segments(width_limit);
		let visible = segments.len().min(max_rows);
		let max_offset = segments.len().saturating_sub(visible);
		let current = if self.manual_scroll.get() {
			self.view_offset.get().min(max_offset)
		} else {
			self
				.segment_at_cursor(&segments)
				.saturating_sub(max_rows.saturating_sub(1))
				.min(max_offset)
		};
		let next = (current as i64 + i64::from(delta)).clamp(0, max_offset as i64) as usize;
		self.view_offset.set(next);
		self.manual_scroll.set(true);
		next != current
	}

	/// Returns the clipped visual row count.
	pub fn visual_height(&self, width: u16, max_rows: usize) -> usize {
		let width = width.max(1);
		self.layout_width.set(width);
		self.segments(width).len().min(max_rows)
	}

	/// Reports whether the cursor is at the document's visual start.
	pub fn at_visual_start(&self) -> bool {
		let width = self.layout_width.get();
		self.segment_at_cursor(&self.segments(width)) == 0 && self.cursor == 0
	}

	/// Reports whether the cursor is at the document's visual end.
	pub fn at_visual_end(&self) -> bool {
		let segments = self.segments(self.layout_width.get());
		self.segment_at_cursor(&segments) + 1 == segments.len() && self.cursor == self.text.len()
	}

	fn snapshot(&mut self) {
		if self
			.undo
			.last()
			.is_some_and(|state| state.0 == self.text && state.1 == self.cursor)
		{
			return;
		}
		if self.undo.len() == UNDO_CAP {
			self.undo.remove(0);
		}
		self
			.undo
			.push((self.text.clone(), self.cursor, self.atoms.clone()));
	}

	fn undo(&mut self) -> BufferOutcome {
		let Some((text, cursor, atoms)) = self.undo.pop() else {
			self.break_sequence();
			return BufferOutcome::Ignored;
		};
		self.text = text;
		self.cursor = cursor;
		self.atoms = atoms;
		self.anchor = None;
		self.desired = None;
		self.break_sequence();
		BufferOutcome::Changed
	}

	const fn break_sequence(&mut self) {
		self.last_action = Action::Other;
		self.last_yank = None;
	}

	fn collapse_or(
		&mut self,
		forward: bool,
		motion: impl FnOnce(&mut Self) -> BufferOutcome,
	) -> BufferOutcome {
		if let Some(selection) = self.selection() {
			self.cursor = if forward {
				selection.end
			} else {
				selection.start
			};
			self.anchor = None;
			self.desired = None;
			self.break_sequence();
			BufferOutcome::Changed
		} else {
			self.anchor = None;
			motion(self)
		}
	}

	fn extend(&mut self, motion: impl FnOnce(&mut Self) -> BufferOutcome) -> BufferOutcome {
		self.anchor.get_or_insert(self.cursor);
		motion(self)
	}

	fn insert_char(&mut self, ch: char) -> BufferOutcome {
		// Group every consecutive non-whitespace typing run into one undo unit,
		// including punctuation and symbols.
		let word = !ch.is_whitespace();
		let selection = self.selection();
		if selection.is_some() || !word || self.last_action != Action::TypeWord {
			self.snapshot();
		}
		if let Some(range) = selection {
			self.cursor = range.start;
			self.splice(range, "");
			self.anchor = None;
			self.last_action = Action::Other;
		}
		if ch == '/'
			&& self.xml
			&& self.text[..self.cursor].ends_with('<')
			&& let Some(name) = nearest_open_tag(&self.text[..self.cursor - 1])
		{
			let name = Str::new(name);
			let mut expansion = String::with_capacity(name.len() + 2);
			expansion.push('/');
			expansion.push_str(&name);
			expansion.push('>');
			self.splice(self.cursor..self.cursor, &expansion);
			self.cursor += expansion.len();
		} else {
			let mut encoded = [0_u8; 4];
			self.splice(self.cursor..self.cursor, ch.encode_utf8(&mut encoded));
			self.cursor += ch.len_utf8();
		}
		self.anchor = None;
		self.desired = None;
		self.last_action = if word {
			Action::TypeWord
		} else {
			Action::Other
		};
		self.last_yank = None;
		BufferOutcome::Changed
	}

	fn move_to(&mut self, cursor: usize) -> BufferOutcome {
		self.break_sequence();
		self.desired = None;
		let forward = cursor >= self.cursor;
		let cursor = self.snap_position(cursor, forward);
		if cursor == self.cursor {
			BufferOutcome::Ignored
		} else {
			self.cursor = cursor;
			BufferOutcome::Changed
		}
	}

	fn move_left(&mut self) -> BufferOutcome {
		let Some((mut at, _)) = self.text[..self.cursor].grapheme_indices().next_back() else {
			self.break_sequence();
			return BufferOutcome::Ignored;
		};
		if let Some((start, _)) = self.atomic_at(at) {
			at = start;
		}
		self.move_to(at)
	}

	fn move_right(&mut self) -> BufferOutcome {
		let Some(grapheme) = self.text[self.cursor..].graphemes().next() else {
			self.break_sequence();
			let segments = self.segments(self.layout_width.get());
			let segment = segments[self.segment_at_cursor(&segments)];
			let cursor = self.cursor.clamp(segment.start, segment.end);
			self.desired = Some(cell_width(&self.text[segment.start..cursor]));
			return BufferOutcome::Ignored;
		};
		let at = self
			.atomic_at(self.cursor)
			.map_or(self.cursor + grapheme.len(), |(_, end)| end);
		self.move_to(at)
	}

	fn move_visual(&mut self, delta: isize) -> BufferOutcome {
		self.break_sequence();
		let segments = self.segments(self.layout_width.get());
		let current = self.segment_at_cursor(&segments);
		let target = current.saturating_add_signed(delta).min(segments.len() - 1);
		if target == current {
			let edge = self.snap_position(
				if delta < 0 {
					segments[current].source_start
				} else {
					segments[current].source_end
				},
				delta > 0,
			);
			if edge == self.cursor {
				return BufferOutcome::Ignored;
			}
			self.cursor = edge;
			return BufferOutcome::Changed;
		}
		let source = segments[current];
		let destination = segments[target];
		let source_cursor = self.cursor.clamp(source.start, source.end);
		let column = cell_width(&self.text[source.start..source_cursor]);
		let target_max =
			segment_max_column(&self.text[destination.start..destination.end], destination.last);
		let preferred = self.desired.unwrap_or(column);
		let target_column = preferred.min(target_max);
		let at = destination.start
			+ byte_at_column(&self.text[destination.start..destination.end], target_column);
		let cursor = self.snap_position(at, delta > 0);
		let landed_column = self.text.get(destination.start..cursor).map(cell_width);
		self.desired =
			(target_column != preferred || cursor != at || landed_column != Some(preferred))
				.then_some(preferred);
		self.cursor = cursor;
		BufferOutcome::Changed
	}

	fn backspace(&mut self) -> BufferOutcome {
		if let Some(range) = self.selection() {
			return self.delete_range(range.start, range.end, false);
		}
		let Some((mut start, _)) = self.text[..self.cursor].grapheme_indices().next_back() else {
			self.break_sequence();
			return BufferOutcome::Ignored;
		};
		if let Some((token_start, _)) = self.atomic_at(start) {
			start = token_start;
		}
		self.delete_range(start, self.cursor, false)
	}

	fn delete(&mut self) -> BufferOutcome {
		if let Some(range) = self.selection() {
			return self.delete_range(range.start, range.end, false);
		}
		let Some(grapheme) = self.text[self.cursor..].graphemes().next() else {
			self.break_sequence();
			return BufferOutcome::Ignored;
		};
		let end = self
			.atomic_at(self.cursor)
			.map_or(self.cursor + grapheme.len(), |(_, end)| end);
		self.delete_range(self.cursor, end, false)
	}

	fn kill_line_start(&mut self) -> BufferOutcome {
		if let Some(range) = self.selection() {
			return self.delete_range(range.start, range.end, true);
		}
		let (start, _) = self.line_bounds();
		let start = if start == self.cursor && start > 0 {
			start - 1
		} else {
			start
		};
		self.delete_range(start, self.cursor, true)
	}

	fn kill_line_end(&mut self) -> BufferOutcome {
		if let Some(range) = self.selection() {
			return self.delete_range(range.start, range.end, true);
		}
		let (_, end) = self.line_bounds();
		let end = if self.cursor < end {
			end
		} else if end < self.text.len() {
			end + 1
		} else {
			end
		};
		self.delete_range(self.cursor, end, true)
	}

	fn kill_word_backward(&mut self) -> BufferOutcome {
		if let Some(range) = self.selection() {
			return self.delete_range(range.start, range.end, true);
		}
		let start = self.word_left();
		self.delete_range(start, self.cursor, true)
	}

	fn kill_word_forward(&mut self) -> BufferOutcome {
		if let Some(range) = self.selection() {
			return self.delete_range(range.start, range.end, true);
		}
		let end = self.word_right();
		self.delete_range(self.cursor, end, true)
	}

	fn delete_range(&mut self, start: usize, end: usize, kill: bool) -> BufferOutcome {
		if start == end {
			if !kill {
				self.break_sequence();
			}
			return BufferOutcome::Ignored;
		}
		let (start, end) = self.expand_to_atoms(start, end);
		self.snapshot();
		let removed = self.text[start..end].to_owned();
		let removed_atoms = self
			.atoms
			.iter()
			.filter(|atom| atom.start >= start && atom.end <= end)
			.map(|atom| Atom {
				start:   atom.start - start,
				end:     atom.end - start,
				payload: atom.payload.clone(),
			})
			.collect();
		let backward = end == self.cursor;
		self.splice(start..end, "");
		self.cursor = start;
		self.anchor = None;
		self.desired = None;
		self.last_yank = None;
		if kill {
			self.record_kill(KillEntry { text: removed, atoms: removed_atoms }, backward);
		} else {
			self.last_action = Action::Other;
		}
		BufferOutcome::Changed
	}

	fn record_kill(&mut self, mut killed: KillEntry, backward: bool) {
		if self.last_action == Action::Kill && !self.kill_ring.is_empty() {
			let current = &mut self.kill_ring[0];
			if backward {
				let shift = killed.text.len();
				for atom in current.atoms.iter_mut() {
					atom.start += shift;
					atom.end += shift;
				}
				for atom in &current.atoms {
					killed.atoms.push_back(atom.clone());
				}
				killed.text.push_str(&current.text);
				*current = killed;
			} else {
				let shift = current.text.len();
				for atom in killed.atoms.iter_mut() {
					atom.start += shift;
					atom.end += shift;
				}
				current.text.push_str(&killed.text);
				for atom in &killed.atoms {
					current.atoms.push_back(atom.clone());
				}
			}
		} else {
			self.kill_ring.insert(0, killed);
			if self.kill_ring.len() > KILL_CAP {
				self.kill_ring.pop();
			}
		}
		self.kill_index = 0;
		self.last_action = Action::Kill;
	}

	fn insert_kill_entry(&mut self, start: usize, value: &KillEntry) {
		self.splice(start..start, &value.text);
		for atom in &value.atoms {
			self.atoms.push_back(Atom {
				start:   start + atom.start,
				end:     start + atom.end,
				payload: atom.payload.clone(),
			});
		}
	}

	fn yank(&mut self) -> BufferOutcome {
		let Some(value) = self.kill_ring.first().cloned() else {
			self.break_sequence();
			return BufferOutcome::Ignored;
		};
		self.snapshot();
		let range = self.selection().unwrap_or(self.cursor..self.cursor);
		let start = range.start;
		self.splice(range, "");
		self.insert_kill_entry(start, &value);
		self.cursor = start + value.text.len();
		self.anchor = None;
		self.kill_index = 0;
		self.last_yank = Some((start, self.cursor));
		self.last_action = Action::Yank;
		self.desired = None;
		BufferOutcome::Changed
	}

	fn copy_selection(&mut self) -> BufferOutcome {
		let Some(range) = self.selection() else {
			return BufferOutcome::Ignored;
		};
		self.break_sequence();
		self.copied = Some(Str::new(&self.text[range]));
		BufferOutcome::Changed
	}

	fn cut_selection(&mut self) -> BufferOutcome {
		let Some(range) = self.selection() else {
			return BufferOutcome::Ignored;
		};
		self.copied = Some(Str::new(&self.text[range.clone()]));
		self.delete_range(range.start, range.end, true)
	}

	fn yank_pop(&mut self) -> BufferOutcome {
		if !matches!(self.last_action, Action::Yank | Action::YankPop) || self.kill_ring.len() < 2 {
			self.break_sequence();
			return BufferOutcome::Ignored;
		}
		let Some((start, end)) = self.last_yank else {
			return BufferOutcome::Ignored;
		};
		self.snapshot();
		self.kill_index = (self.kill_index + 1) % self.kill_ring.len();
		let value = self.kill_ring[self.kill_index].clone();
		self.splice(start..end, "");
		self.insert_kill_entry(start, &value);
		self.cursor = start + value.text.len();
		self.last_yank = Some((start, self.cursor));
		self.last_action = Action::YankPop;
		BufferOutcome::Changed
	}

	fn jump_to(&mut self, ch: char, jump: Jump) -> BufferOutcome {
		self.break_sequence();
		let found = match jump {
			Jump::Forward => self.text[self.cursor..]
				.char_indices()
				.find(|(offset, candidate)| *offset > 0 && *candidate == ch)
				.map(|(offset, _)| self.cursor + offset),
			Jump::Backward => self.text[..self.cursor]
				.char_indices()
				.rev()
				.find(|(_, candidate)| *candidate == ch)
				.map(|(offset, _)| offset),
		};
		found.map_or(BufferOutcome::Ignored, |at| {
			self.cursor = self.snap_position(at, matches!(jump, Jump::Forward));
			BufferOutcome::Changed
		})
	}

	fn snap_position(&self, at: usize, forward: bool) -> usize {
		self
			.atomic_at(at)
			.map_or(at, |(start, end)| if forward { end } else { start })
	}

	fn line_bounds(&self) -> (usize, usize) {
		let start = self.text[..self.cursor].rfind('\n').map_or(0, |at| at + 1);
		let end = self.text[self.cursor..]
			.find('\n')
			.map_or(self.text.len(), |at| self.cursor + at);
		(start, end)
	}

	fn word_left(&self) -> usize {
		if self.cursor > 0 && self.text.as_bytes()[self.cursor - 1] == b'\n' {
			self.cursor - 1
		} else {
			word_left(&self.text, self.cursor)
		}
	}

	fn word_right(&self) -> usize {
		if self.text.as_bytes().get(self.cursor) == Some(&b'\n') {
			self.cursor + 1
		} else {
			word_right(&self.text, self.cursor)
		}
	}

	fn atomic_at(&self, index: usize) -> Option<(usize, usize)> {
		self
			.atoms
			.iter()
			.find(|atom| index >= atom.start && index < atom.end)
			.map(|atom| (atom.start, atom.end))
	}

	fn visual_position(&self, row: usize, column: u16, width_limit: u16) -> usize {
		let segments = self.segments(width_limit.max(1));
		let index = self
			.view_offset
			.get()
			.saturating_add(row)
			.min(segments.len() - 1);
		let segment = segments[index];
		segment.start + byte_at_column(&self.text[segment.start..segment.end], column)
	}

	fn segments(&self, width_limit: u16) -> SmallVec<Segment, 16> {
		let mut result = SmallVec::new();
		let mut logical_start = 0;
		loop {
			let logical_end = self.text[logical_start..]
				.find('\n')
				.map_or(self.text.len(), |at| logical_start + at);
			wrap_logical_line(&self.text, logical_start, logical_end, width_limit.max(1), &mut result);
			if logical_end == self.text.len() {
				break;
			}
			logical_start = logical_end + 1;
		}
		result
	}

	fn segment_at_cursor(&self, segments: &[Segment]) -> usize {
		segments
			.iter()
			.position(|segment| {
				self.cursor >= segment.source_start
					&& (self.cursor < segment.source_end
						|| segment.last && self.cursor == segment.source_end)
			})
			.unwrap_or(segments.len() - 1)
	}
}

#[derive(Clone, Copy)]
struct GraphemeCell {
	start:      usize,
	end:        usize,
	width:      u16,
	whitespace: bool,
}

fn push_wrapped_segment(
	text: &str,
	result: &mut SmallVec<Segment, 16>,
	source_start: usize,
	source_end: usize,
	start: usize,
	end: usize,
) {
	let end = start + text[start..end].trim_end_matches(char::is_whitespace).len();
	result.push(Segment { source_start, source_end, start, end, last: false });
}

fn wrap_logical_line(
	text: &str,
	logical_start: usize,
	logical_end: usize,
	width_limit: u16,
	result: &mut SmallVec<Segment, 16>,
) {
	let first_segment = result.len();
	if logical_start == logical_end {
		result.push(Segment {
			source_start: logical_start,
			source_end:   logical_end,
			start:        logical_start,
			end:          logical_end,
			last:         true,
		});
		return;
	}

	let glyphs = text[logical_start..logical_end]
		.grapheme_indices()
		.map(|(offset, grapheme)| GraphemeCell {
			start:      logical_start + offset,
			end:        logical_start + offset + grapheme.len(),
			width:      cell_width(grapheme),
			whitespace: grapheme.chars().all(char::is_whitespace),
		})
		.collect::<Vec<_>>();

	let mut chunk_source_start = logical_start;
	let mut chunk_start = logical_start;
	let mut chunk_end = logical_start;
	let mut chunk_width = 0_u16;
	let mut token_start = 0;
	while token_start < glyphs.len() {
		let whitespace = glyphs[token_start].whitespace;
		let mut token_end = token_start + 1;
		while token_end < glyphs.len() && glyphs[token_end].whitespace == whitespace {
			token_end += 1;
		}
		let token_start_byte = glyphs[token_start].start;
		let token_end_byte = glyphs[token_end - 1].end;
		let token_width = glyphs[token_start..token_end]
			.iter()
			.fold(0_u16, |width, glyph| width.saturating_add(glyph.width));
		let token_has_wide = glyphs[token_start..token_end]
			.iter()
			.any(|glyph| glyph.width > 1);

		if chunk_end == chunk_start && whitespace {
			if let Some(previous) = result
				.get_mut(first_segment..)
				.and_then(|rows| rows.last_mut())
			{
				previous.source_end = token_end_byte;
			} else {
				chunk_start = token_end_byte;
				chunk_end = token_end_byte;
			}
			token_start = token_end;
			continue;
		}

		if token_width > width_limit {
			let mut consumed = token_start;
			if chunk_end > chunk_start && chunk_width < width_limit {
				let mut available = width_limit - chunk_width;
				while consumed < token_end && glyphs[consumed].width <= available {
					available -= glyphs[consumed].width;
					chunk_width += glyphs[consumed].width;
					chunk_end = glyphs[consumed].end;
					consumed += 1;
				}
			}
			if chunk_end > chunk_start {
				let source_end = if consumed > token_start {
					chunk_end
				} else {
					token_start_byte
				};
				push_wrapped_segment(
					text,
					result,
					chunk_source_start,
					source_end,
					chunk_start,
					chunk_end,
				);
				chunk_source_start = source_end;
			}

			while consumed < token_end {
				let segment_start = glyphs[consumed].start;
				let source_start = chunk_source_start;
				let mut segment_end = segment_start;
				let mut segment_width = 0_u16;
				while consumed < token_end {
					let next = segment_width.saturating_add(glyphs[consumed].width);
					if next > width_limit && segment_end > segment_start {
						break;
					}
					segment_width = next;
					segment_end = glyphs[consumed].end;
					consumed += 1;
					if segment_width >= width_limit {
						break;
					}
				}
				if consumed < token_end {
					push_wrapped_segment(
						text,
						result,
						source_start,
						segment_end,
						segment_start,
						segment_end,
					);
					chunk_source_start = segment_end;
				} else {
					chunk_source_start = source_start;
					chunk_start = segment_start;
					chunk_end = segment_end;
					chunk_width = segment_width;
				}
			}
			token_start = token_end;
			continue;
		}

		if chunk_width.saturating_add(token_width) > width_limit {
			let mut consumed = token_start;
			if !whitespace && token_has_wide && chunk_end > chunk_start {
				let mut available = width_limit - chunk_width;
				while consumed < token_end && glyphs[consumed].width <= available {
					available -= glyphs[consumed].width;
					chunk_end = glyphs[consumed].end;
					consumed += 1;
				}
			}
			let source_end = if consumed > token_start {
				chunk_end
			} else {
				token_start_byte
			};
			push_wrapped_segment(text, result, chunk_source_start, source_end, chunk_start, chunk_end);
			chunk_source_start = source_end;
			if consumed == token_end {
				chunk_start = source_end;
				chunk_end = source_end;
				chunk_width = 0;
			} else if whitespace {
				if let Some(previous) = result.last_mut() {
					previous.source_end = token_end_byte;
				}
				chunk_source_start = token_end_byte;
				chunk_start = token_end_byte;
				chunk_end = token_end_byte;
				chunk_width = 0;
			} else {
				chunk_start = glyphs[consumed].start;
				chunk_end = token_end_byte;
				chunk_width = glyphs[consumed..token_end]
					.iter()
					.fold(0_u16, |width, glyph| width.saturating_add(glyph.width));
			}
		} else {
			if chunk_end == chunk_start {
				chunk_start = token_start_byte;
			}
			chunk_end = token_end_byte;
			chunk_width = chunk_width.saturating_add(token_width);
		}
		token_start = token_end;
	}

	if chunk_end > chunk_start || result.len() == first_segment {
		push_wrapped_segment(text, result, chunk_source_start, logical_end, chunk_start, chunk_end);
	} else if let Some(last) = result.last_mut() {
		last.source_end = logical_end;
	}
	if let Some(last) = result.last_mut() {
		last.last = true;
	}
}

/// Markdown code spans and fences whose contents are opaque to XML completion
/// and prose assistance.
pub fn code_ranges(text: &str) -> SmallVec<Range<usize>, 8> {
	let bytes = text.as_bytes();
	let mut ranges = SmallVec::new();
	let mut at = 0;
	while at < bytes.len() {
		let marker = bytes[at];
		if marker != b'`' && marker != b'~' {
			at += 1;
			continue;
		}
		let mut run = 1;
		while bytes.get(at + run) == Some(&marker) {
			run += 1;
		}
		let fenced = run >= 3
			&& text[..at].rsplit_once('\n').map_or_else(
				|| at <= 3 && text[..at].trim().is_empty(),
				|(_, prefix)| prefix.len() <= 3 && prefix.trim().is_empty(),
			);
		if marker == b'~' && !fenced {
			at += run;
			continue;
		}
		let mut search = at + run;
		let mut close = None;
		while search < bytes.len() {
			let Some(relative) = bytes[search..].iter().position(|byte| *byte == marker) else {
				break;
			};
			let candidate = search + relative;
			let mut candidate_run = 1;
			while bytes.get(candidate + candidate_run) == Some(&marker) {
				candidate_run += 1;
			}
			let closes = if fenced {
				candidate_run >= run
					&& text[..candidate].rsplit_once('\n').map_or_else(
						|| candidate <= 3 && text[..candidate].trim().is_empty(),
						|(_, prefix)| prefix.len() <= 3 && prefix.trim().is_empty(),
					)
			} else {
				candidate_run == run
			};
			if closes {
				close = Some(candidate + candidate_run);
				break;
			}
			search = candidate + candidate_run;
		}
		let end = close.unwrap_or(text.len());
		ranges.push(at..end);
		at = end;
	}
	ranges
}

/// XML tags, comments, declarations, and processing instructions hidden from
/// prose assistance. Apparent markup inside Markdown code is already covered
/// by [`code_ranges`].
pub fn xml_ranges(text: &str) -> SmallVec<Range<usize>, 8> {
	let mut ranges = SmallVec::new();
	let mut offset = 0;
	while let Some(relative) = text[offset..].find('<') {
		let start = offset + relative;
		let rest = &text[start + 1..];
		let valid = rest.chars().next().is_some_and(|character| {
			matches!(character, '/' | '!' | '?') || character.is_ascii_alphabetic()
		});
		if !valid {
			offset = start + 1;
			continue;
		}
		let end = if let Some(comment) = text[start..].strip_prefix("<!--") {
			comment
				.find("-->")
				.map_or(text.len(), |relative| start + 4 + relative + 3)
		} else {
			let processing = text[start..].starts_with("<?");
			tag_end(text, start + 1, processing).map_or(text.len(), |end| end + 1)
		};
		ranges.push(start..end);
		offset = end;
	}
	ranges
}

fn nearest_open_tag(text: &str) -> Option<&str> {
	let code = code_ranges(text);
	let mut stack: SmallVec<&str, 16> = SmallVec::new();
	let mut offset = 0;
	while let Some(relative) = text[offset..].find('<') {
		let start = offset + relative;
		if let Some(range) = code
			.iter()
			.find(|range| range.start <= start && start < range.end)
		{
			offset = range.end;
			continue;
		}
		let rest = &text[start..];
		if let Some(body) = rest.strip_prefix("<!--") {
			let Some(end) = body.find("-->") else {
				break;
			};
			offset = start + 4 + end + 3;
			continue;
		}
		let processing = rest.starts_with("<?");
		let Some(end) = tag_end(text, start + 1, processing) else {
			break;
		};
		offset = end + 1;
		if processing || rest.starts_with("<!") {
			continue;
		}

		let mut name_start = start + 1;
		let closing = text.as_bytes().get(name_start) == Some(&b'/');
		if closing {
			name_start += 1;
		}
		let name_end = text[name_start..end]
			.find(|ch: char| {
				ch.is_whitespace() || matches!(ch, '/' | '>' | '<' | '=' | '?' | '!' | '"' | '\'')
			})
			.map_or(end, |relative| name_start + relative);
		if name_end == name_start {
			continue;
		}
		let name = &text[name_start..name_end];
		if closing {
			if let Some(index) = stack.iter().rposition(|open| *open == name) {
				stack.truncate(index);
			}
		} else if !text[name_end..end].trim_ascii_end().ends_with('/') {
			stack.push(name);
		}
	}
	stack.pop()
}

fn tag_end(text: &str, start: usize, processing: bool) -> Option<usize> {
	let mut quote = None;
	let mut previous = None;
	for (relative, ch) in text[start..].char_indices() {
		if let Some(delimiter) = quote {
			if ch == delimiter {
				quote = None;
			}
		} else if matches!(ch, '"' | '\'') {
			quote = Some(ch);
		} else if ch == '>' && (!processing || previous == Some('?')) {
			return Some(start + relative);
		}
		previous = Some(ch);
	}
	None
}

fn byte_at_column(text: &str, column: u16) -> usize {
	text.truncate_width(usize::from(column)).len()
}

fn segment_max_column(text: &str, last: bool) -> u16 {
	let width = cell_width(text);
	if last {
		width
	} else {
		text
			.graphemes()
			.next_back()
			.map_or(0, |grapheme| width.saturating_sub(cell_width(grapheme)))
	}
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum WordClass {
	Word,
	Whitespace,
	Cjk,
	Delimiter,
}

const fn is_cjk(character: char) -> bool {
	matches!(
		character as u32,
		0x2E80..=0x2FFF
			| 0x3040..=0x30FF
			| 0x3100..=0x312F
			| 0x3130..=0x318F
			| 0x31A0..=0x31BF
			| 0x31F0..=0x31FF
			| 0x3400..=0x4DBF
			| 0x4E00..=0x9FFF
			| 0xA960..=0xA97F
			| 0xAC00..=0xD7AF
			| 0xF900..=0xFAFF
			| 0x20000..=0x2FA1F
	)
}

fn word_class(grapheme: &str) -> WordClass {
	let Some(character) = grapheme.chars().next() else {
		return WordClass::Delimiter;
	};
	if character.is_whitespace() {
		WordClass::Whitespace
	} else if is_cjk(character) {
		WordClass::Cjk
	} else if character.is_alphanumeric() || character == '_' {
		WordClass::Word
	} else {
		WordClass::Delimiter
	}
}

fn is_word_joiner(grapheme: &str) -> bool {
	matches!(grapheme, "'" | "’" | "-" | "‐" | "‑")
}

fn word_left(text: &str, at: usize) -> usize {
	let mut graphemes = text[..at].grapheme_indices().rev().peekable();
	while graphemes
		.peek()
		.is_some_and(|(_, grapheme)| word_class(grapheme) == WordClass::Whitespace)
	{
		graphemes.next();
	}
	let Some((offset, grapheme)) = graphemes.next() else {
		return 0;
	};
	let class = word_class(grapheme);
	if class != WordClass::Word {
		let mut target = offset;
		while let Some((offset, grapheme)) = graphemes.peek() {
			if word_class(grapheme) != class {
				break;
			}
			target = *offset;
			graphemes.next();
		}
		return target;
	}
	let mut target = offset;
	while let Some((offset, grapheme)) = graphemes.next() {
		if word_class(grapheme) == WordClass::Word {
			target = offset;
		} else if is_word_joiner(grapheme)
			&& graphemes
				.peek()
				.is_some_and(|(_, left)| word_class(left) == WordClass::Word)
		{
			let (left, _) = graphemes.next().expect("peeked left word");
			target = left;
		} else {
			break;
		}
	}
	target
}

fn word_right(text: &str, at: usize) -> usize {
	let mut graphemes = text[at..].grapheme_indices().peekable();
	while graphemes
		.peek()
		.is_some_and(|(_, grapheme)| word_class(grapheme) == WordClass::Whitespace)
	{
		graphemes.next();
	}
	let Some((first_at, first)) = graphemes.next() else {
		return text.len();
	};
	let class = word_class(first);
	let mut end = at + first_at + first.len();
	if class != WordClass::Word {
		while let Some((_, grapheme)) = graphemes.peek() {
			if word_class(grapheme) != class {
				break;
			}
			let (offset, grapheme) = graphemes.next().expect("peeked delimiter");
			end = at + offset + grapheme.len();
		}
		return end;
	}
	while let Some((offset, grapheme)) = graphemes.next() {
		if word_class(grapheme) == WordClass::Word
			|| (is_word_joiner(grapheme)
				&& graphemes
					.peek()
					.is_some_and(|(_, right)| word_class(right) == WordClass::Word))
		{
			end = at + offset + grapheme.len();
		} else {
			break;
		}
	}
	end
}

type EmojiBuckets = HashMap<&'static str, Vec<[&'static str; 2]>>;

static EMOJI_BUCKETS: LazyLock<EmojiBuckets> = LazyLock::new(|| {
	serde_json::from_str(include_str!("emojis.json")).expect("embedded emoji data must be valid")
});

/// Feature switches for [`Editor::new`]; everything defaults on.
/// Completion is not a switch: register one with [`Editor::set_completion`].
#[derive(Clone, Copy, Debug)]
pub struct EditorOptions {
	/// `:emoji` shortcode dropdown plus inline `:shortcode:` and
	/// emoticon (`:-)`) expansion while typing.
	pub emoji:       bool,
	/// Up/Down prompt history with draft restore below the newest entry.
	pub history:     bool,
	/// XML affordances: `</` completes the innermost open tag, and
	/// renderers should apply structural markup highlighting.
	pub xml:         bool,
	/// Rows the completion dropdown shows at once, clamped to `[3, 20]` on
	/// use.
	pub picker_rows: usize,
}

impl Default for EditorOptions {
	fn default() -> Self {
		Self { emoji: true, history: true, xml: true, picker_rows: PICKER_ROWS }
	}
}

impl EditorOptions {
	/// The dropdown window after the `[3, 20]` clamp.
	#[must_use]
	pub const fn picker_rows(&self) -> usize {
		if self.picker_rows < PICKER_ROWS_MIN {
			PICKER_ROWS_MIN
		} else if self.picker_rows > PICKER_ROWS_MAX {
			PICKER_ROWS_MAX
		} else {
			self.picker_rows
		}
	}
}

const EMOTICONS: &[(&str, &str)] = &[
	(":'-(", "😢"),
	(">:-(", "😠"),
	(":-)", "🙂"),
	(":-(", "🙁"),
	(":-D", "😃"),
	(":-P", "😛"),
	(":-p", "😛"),
	(":-O", "😮"),
	(":-o", "😮"),
	(":-|", "😐"),
	(":-/", "😕"),
	(":-\\", "😕"),
	(":-*", "😘"),
	(";-)", "😉"),
	(";-P", "😜"),
	(":')", "🥲"),
	(":'D", "😂"),
	(":'(", "😢"),
	("</3", "💔"),
	(">:(", "😠"),
	("B-)", "😎"),
	("8-)", "😎"),
	("o.O", "😳"),
	("O.o", "😳"),
	(":)", "🙂"),
	(":(", "🙁"),
	(":D", "😃"),
	(":P", "😛"),
	(":p", "😛"),
	(":O", "😮"),
	(":o", "😮"),
	(":|", "😐"),
	(":/", "😕"),
	(":\\", "😕"),
	(":*", "😘"),
	(";)", "😉"),
	(":3", "😺"),
	("<3", "❤️"),
	("xD", "😆"),
	("XD", "😆"),
	("B)", "😎"),
	("8)", "😎"),
];

/// Display content for one completion row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SuggestionDisplay {
	/// A plain text label (command name, file path, mention, …).
	Text(Str),
	/// An emoji paired with its shortcode or emoticon.
	Emoji {
		/// The emoji inserted on acceptance.
		emoji:     &'static str,
		/// The `:shortcode:` name or emoticon spelling that matched.
		shortcode: &'static str,
	},
}

/// One selectable completion row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Suggestion {
	value:       Str,
	display:     SuggestionDisplay,
	description: Option<Str>,
	icon:        Option<Icon>,
	hint:        Option<Str>,
	category:    Option<Str>,
	match_spans: SmallVec<(u16, u16), 8>,
	submits:     bool,
}

impl Suggestion {
	/// Builds a row: on acceptance `insert` replaces the completion's
	/// replacement range verbatim; `label` is shown in the dropdown.
	pub fn new(insert: impl IntoStr, label: impl IntoStr) -> Self {
		Self {
			value:       insert.into_str(),
			display:     SuggestionDisplay::Text(label.into_str()),
			description: None,
			icon:        None,
			hint:        None,
			category:    None,
			match_spans: SmallVec::new(),
			submits:     false,
		}
	}

	/// Explanatory text shown beside the label.
	pub fn with_description(mut self, description: impl IntoStr) -> Self {
		self.description = Some(description.into_str());
		self
	}

	/// Assigns a semantic type-indicator icon.
	pub const fn with_icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
		self
	}

	/// Returns the semantic type-indicator icon.
	pub const fn icon(&self) -> Option<Icon> {
		self.icon
	}

	/// Ghost text shown after the cursor while this row is selected.
	pub fn with_hint(mut self, hint: impl IntoStr) -> Self {
		self.hint = Some(hint.into_str());
		self
	}

	/// Assigns a category. The picker retains one non-selectable header at each
	/// category boundary inside the visible window.
	pub fn with_category(mut self, category: impl IntoStr) -> Self {
		self.category = Some(category.into_str());
		self
	}

	/// Assigns UTF-8 byte spans to emphasize within the dropdown label.
	pub fn with_match_spans(mut self, spans: impl IntoIterator<Item = (u16, u16)>) -> Self {
		self.match_spans = spans
			.into_iter()
			.filter(|(start, end)| start < end)
			.collect();
		self
	}

	/// Marks this row as a complete command: Enter both applies the
	/// completion and submits the input when only whitespace precedes the
	/// command token (submitted-slash-command rule).
	pub const fn with_submit(mut self) -> Self {
		self.submits = true;
		self
	}

	/// Whether Enter-acceptance may also submit the completed input.
	pub const fn submits(&self) -> bool {
		self.submits
	}

	/// Returns the row category, when present.
	pub fn category(&self) -> Option<&str> {
		self.category.as_deref()
	}

	/// Returns UTF-8 byte match spans in the dropdown label.
	pub fn match_spans(&self) -> &[(u16, u16)] {
		&self.match_spans
	}

	/// Returns the row's dropdown label.
	pub const fn display(&self) -> &SuggestionDisplay {
		&self.display
	}

	/// Returns optional explanatory text shown beside the label.
	pub fn description(&self) -> Option<&str> {
		self.description.as_deref()
	}

	/// Returns the text inserted when this row is accepted.
	pub const fn value(&self) -> &Str {
		&self.value
	}
}

/// Ranked dropdown rows; inline up to eight before spilling.
pub type SuggestionList = SmallVec<Suggestion, 8>;

/// Ranked dropdown suggestions returned by [`EditorCompletion::suggest`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Suggestions {
	/// UTF-8 byte range replaced by the selected row. The editor clamps it
	/// around the request cursor and inside the request text; acceptance
	/// separately rejects a result whose text or caret snapshot went stale.
	pub range: ops::Range<usize>,
	/// Rows in display order; empty closes the dropdown.
	pub items: SuggestionList,
}

/// Buffer edit returned by [`EditorCompletion::tab`]: replaces `range`
/// with `insert` and leaves the cursor after it.
pub struct CompletionEdit {
	/// Byte range to replace.
	pub range:  ops::Range<usize>,
	/// Replacement text.
	pub insert: Str,
}

/// Provider verdict for a Tab press, from [`EditorCompletion::tab`].
pub enum TabAction {
	/// Accept the selected dropdown row (no-op when none is open).
	Accept,
	/// Apply a buffer edit, e.g. materializing the current ghost hint.
	Edit(CompletionEdit),
	/// Pass Tab through to the embedding app.
	Pass,
}

/// Pluggable completion engine registered with [`Editor::set_completion`].
///
/// The editor consults it after every edit, so an implementation chooses
/// its own trigger convention (`/`, `@`, `#`, or none at all) by inspecting
/// the text before the cursor. [`SlashCommands`] is the built-in
/// implementation.
pub trait EditorCompletion {
	/// Dropdown suggestions for the current text and byte cursor, or
	/// `None` to close the dropdown.
	fn suggest(&mut self, text: &str, cursor: usize) -> Option<Suggestions>;

	/// Dim ghost text rendered after the cursor (usage hints, AI
	/// completion). Re-queried after every edit.
	fn hint(&mut self, text: &str, cursor: usize) -> Option<Str> {
		let _ = (text, cursor);
		None
	}

	/// Tab pressed. `selected` is the highlighted row while this engine's
	/// dropdown is open. Accepts the open row, otherwise passes Tab through to
	/// the embedding app. The built-in emoji dropdown always accepts without
	/// consulting the engine.
	fn tab(&mut self, text: &str, cursor: usize, selected: Option<&Suggestion>) -> TabAction {
		let _ = (text, cursor);
		if selected.is_some() {
			TabAction::Accept
		} else {
			TabAction::Pass
		}
	}

	/// Whether the editor may consult its built-in emoji provider after this
	/// engine declines. Slash-command argument contexts use this to keep
	/// `#action`/`:emoji` text literal while still allowing their own
	/// argument, GitHub-ref, URL, and file providers.
	fn allow_builtin_emoji(&mut self, text: &str, cursor: usize) -> bool {
		let _ = (text, cursor);
		true
	}

	/// One of this engine's rows was accepted: `replaced` is the buffer text
	/// the row's value overwrote (the typed trigger and query). Action rows
	/// record their side effect here for the host to apply.
	fn accepted(&mut self, replaced: &str, suggestion: &Suggestion) {
		let _ = (replaced, suggestion);
	}
}

/// One retained row in a visible picker window.
#[derive(Clone, Copy, Debug)]
pub enum PickerRow<'a> {
	/// Non-selectable category header.
	Header(&'a Str),
	/// Selectable suggestion and its absolute picker index.
	Suggestion {
		/// Absolute suggestion index.
		index:      usize,
		/// Borrowed suggestion.
		suggestion: &'a Suggestion,
	},
}

/// Active completion dropdown state.
pub struct Picker {
	range:             ops::Range<usize>,
	suggestions:       SuggestionList,
	selected:          usize,
	/// Exact request snapshot. Async producers may finish after another edit;
	/// acceptance is allowed only while generation, text, and caret still match.
	source_generation: u64,
	source_text:       Str,
	source_cursor:     usize,
	/// Bytes between an assistance replacement and the request caret. These
	/// bytes remain in the buffer and the caret is restored after them.
	cursor_offset:     usize,
	/// Produced by the registered engine (vs the built-in emoji dropdown).
	provided:          bool,
	/// Window height, from [`EditorOptions::picker_rows`] at open time.
	rows:              usize,
}

impl Picker {
	/// The dropdown window height this picker opened with.
	#[must_use]
	pub const fn rows(&self) -> usize {
		self.rows
	}

	/// Returns the centered suggestion window (`rows` tall) and its first
	/// index.
	pub fn visible_suggestions(&self) -> (usize, &[Suggestion]) {
		let visible = self.suggestions.len().min(self.rows);
		let max_start = self.suggestions.len().saturating_sub(visible);
		let start = self.selected.saturating_sub(self.rows / 2).min(max_start);
		(start, &self.suggestions[start..start + visible])
	}

	/// Returns visible rows including category headers. Headers only
	/// separate mixed categories: a dropdown whose rows all share one
	/// category is a plain list without a heading.
	pub fn visible_rows(&self) -> SmallVec<PickerRow<'_>, 8> {
		let (start, suggestions) = self.visible_suggestions();
		let mut rows = SmallVec::new();
		let first = self
			.suggestions
			.first()
			.and_then(|suggestion| suggestion.category.as_ref());
		let uniform = self
			.suggestions
			.iter()
			.all(|suggestion| suggestion.category.as_ref() == first);
		let mut category: Option<&Str> = None;
		for (offset, suggestion) in suggestions.iter().enumerate() {
			if !uniform && suggestion.category.as_ref() != category {
				category = suggestion.category.as_ref();
				if let Some(header) = category {
					rows.push(PickerRow::Header(header));
				}
			}
			rows.push(PickerRow::Suggestion { index: start + offset, suggestion });
		}
		rows
	}

	/// Returns the selected suggestion's absolute index.
	pub const fn selected(&self) -> usize {
		self.selected
	}

	/// Returns the total number of matching suggestions.
	pub const fn len(&self) -> usize {
		self.suggestions.len()
	}

	/// Reports whether no suggestions matched (never true for a live picker).
	pub const fn is_empty(&self) -> bool {
		self.suggestions.is_empty()
	}
}

/// Result of handling one terminal key event.
#[derive(Debug, Eq, PartialEq)]
pub enum EditOutcome {
	/// Editor contents or selection changed.
	Changed,
	/// Complete input was submitted, with paste markers expanded.
	Submitted(String),
	/// The key had no editor meaning; the embedding app may act on it.
	Ignored,
}

/// Editable multiline input with completion and editing.
///
/// Wraps an [`EditBuffer`] with a pluggable [`EditorCompletion`] dropdown,
/// inline ghost hints, built-in emoji expansion, and prompt history —
/// each governed by [`EditorOptions`].
pub struct Editor {
	buffer:                EditBuffer,
	picker:                Option<Picker>,
	completion:            Option<Box<dyn EditorCompletion>>,
	/// Monotonic identity of the current completion query. Text and caret
	/// checks reject ordinary drift; this also fences ABA snapshots.
	completion_generation: u64,
	options:               EditorOptions,
	hint:                  Option<Str>,
	history:               Vec<Str>,
	history_index:         Option<usize>,
	history_draft:         Str,
	history_query:         Option<Str>,
	/// Volatile speech/IME preview range and exact text in the visible buffer.
	volatile:              Option<(Range<usize>, Str)>,
	/// Whether a volatile preview exposes its insertion caret. Native IMEs
	/// use `None` to hide it while selecting a marked-text candidate.
	volatile_cursor:       bool,
	last_layout_width:     Cell<u16>,
	last_page_rows:        Cell<usize>,
}

impl Editor {
	/// Creates an empty editor with the given feature switches.
	pub fn new(options: EditorOptions) -> Self {
		let mut buffer = EditBuffer::default();
		buffer.set_xml(options.xml);
		Self {
			buffer,
			picker: None,
			completion: None,
			completion_generation: 0,
			options,
			hint: None,
			history: Vec::new(),
			history_index: None,
			history_draft: Default::default(),
			history_query: None,
			volatile: None,
			volatile_cursor: true,
			last_layout_width: Cell::new(80),
			last_page_rows: Cell::new(DEFAULT_PAGE_ROWS),
		}
	}

	/// Installs a completion handler, replacing any previous one.
	pub fn set_completion(&mut self, completion: Box<dyn EditorCompletion>) {
		self.completion = Some(completion);
		self.refresh();
	}

	/// Replaces the editor text without adding an undo entry, preserving
	/// completion and history configuration. Leaves history browsing.
	pub fn set_text(&mut self, text: &str) {
		self.history_index = None;
		self.history_query = None;
		self.volatile = None;
		self.volatile_cursor = true;
		self.buffer.replace_external(text, false);
		self.refresh();
	}

	/// Records a submitted prompt as the newest history entry: blank text is
	/// ignored, an earlier copy is dropped, the list is capped, and browsing
	/// state resets so the
	/// next Up starts from the newest entry. The host calls this after it
	/// decides the submission really happened.
	pub fn add_to_history(&mut self, text: &str) {
		self.history_index = None;
		self.history_query = None;
		if !self.options.history {
			return;
		}
		let trimmed = text.trim();
		if trimmed.is_empty() {
			return;
		}
		self.history.retain(|entry| entry.as_str() != trimmed);
		self.history.insert(0, Str::new(trimmed));
		self.history.truncate(HISTORY_CAPACITY);
	}

	/// Replaces the history list with `prompts`, newest first. A resumed
	/// session seeds Up/Down from stored prompts. Duplicates keep their first
	/// (newest) position.
	pub fn seed_history(&mut self, prompts: impl IntoIterator<Item = Str>) {
		self.history_index = None;
		self.history_query = None;
		self.history.clear();
		if !self.options.history {
			return;
		}
		for prompt in prompts {
			let trimmed = prompt.trim();
			if trimmed.is_empty() || self.history.iter().any(|entry| entry.as_str() == trimmed) {
				continue;
			}
			self.history.push(if trimmed.len() == prompt.len() {
				prompt
			} else {
				Str::new(trimmed)
			});
			if self.history.len() == HISTORY_CAPACITY {
				break;
			}
		}
	}

	/// Whether `key` would step prompt history instead of moving the caret:
	/// Up on an empty draft or while browsing
	/// from the first visual row, Down while browsing from the last visual
	/// row. Hosts that borrow Up/Down at the draft's edges (transcript
	/// scrolling) yield to the editor when this holds.
	#[must_use]
	pub fn history_navigates(&self, key: Key) -> bool {
		if !self.options.history || self.picker.is_some() {
			return false;
		}
		match key {
			Key::Up => self.history_gate_up() && !self.history.is_empty(),
			Key::Down => self.history_index.is_some() && self.buffer.at_visual_end(),
			_ => false,
		}
	}

	/// Replaces the editor text without an undo entry, optionally parking the
	/// cursor at the start, keeping completion and popup state consistent.
	#[cfg(test)]
	pub(crate) fn replace_external(&mut self, text: &str, cursor_at_start: bool) {
		self.buffer.replace_external(text, cursor_at_start);
		self.refresh();
	}

	/// Returns the underlying edit buffer for component rendering.
	pub(crate) const fn buffer(&self) -> &EditBuffer {
		&self.buffer
	}

	/// Returns the feature switches the editor was built with, so
	/// renderers can honor them (e.g. XML highlighting).
	pub const fn options(&self) -> EditorOptions {
		self.options
	}

	/// Replaces the feature switches at runtime: an open dropdown re-queries
	/// so its window and built-in emoji source follow the new switches.
	pub fn set_options(&mut self, options: EditorOptions) {
		self.options = options;
		self.buffer.set_xml(options.xml);
		if !options.history {
			self.history_index = None;
			self.history_query = None;
		}
		self.refresh();
	}

	/// Returns the visible text, with paste markers unexpanded.
	pub fn text(&self) -> &str {
		self.buffer.text()
	}

	/// Returns the visible text of the line containing the cursor, without
	/// its trailing newline, for host copy-line actions.
	pub fn current_line(&self) -> &str {
		let text = self.buffer.text();
		let cursor = self.buffer.cursor().min(text.len());
		let start = text[..cursor].rfind('\n').map_or(0, |index| index + 1);
		let end = text[cursor..]
			.find('\n')
			.map_or(text.len(), |index| cursor + index);
		&text[start..end]
	}

	/// Returns the open completion dropdown, if any.
	pub const fn picker(&self) -> Option<&Picker> {
		self.picker.as_ref()
	}

	/// Returns the rows the open completion dropdown occupies (0 when closed).
	pub fn picker_height(&self) -> u16 {
		u16::try_from(
			self
				.picker
				.as_ref()
				.map_or(0, |picker| picker.visible_rows().len().min(picker.rows)),
		)
		.unwrap_or(u16::MAX)
	}

	#[cfg(test)]
	fn input_height(&self) -> u16 {
		u16::try_from(
			self
				.buffer
				.visual_height(self.last_layout_width.get(), MAX_INPUT_ROWS),
		)
		.unwrap_or(u16::MAX)
	}

	/// Returns the clipped input row count at `width`, remembering the
	/// width for subsequent key handling.
	pub fn input_height_for(&self, width: u16) -> u16 {
		self.last_layout_width.set(width.max(1));
		u16::try_from(self.buffer.visual_height(width.max(1), MAX_INPUT_ROWS)).unwrap_or(u16::MAX)
	}

	/// Returns up to `max_rows` cursor-centered visible input rows at `width`.
	pub fn view_rows(&self, width: u16, max_rows: usize) -> SmallVec<VisualRow<'_>, 8> {
		self.last_layout_width.set(width.max(1));
		self.last_page_rows.set(max_rows.max(1));
		self.buffer.rows(width, max_rows)
	}

	/// Returns visible input rows and `(first, visible, total)` viewport
	/// metrics from one wrapping pass.
	pub fn view_rows_with_metrics(
		&self,
		width: u16,
		max_rows: usize,
	) -> (SmallVec<VisualRow<'_>, 8>, (usize, usize, usize)) {
		self.last_layout_width.set(width.max(1));
		self.last_page_rows.set(max_rows.max(1));
		self.buffer.rows_with_metrics(width, max_rows)
	}

	/// Returns the cursor-centered visible input rows at `width`.
	pub fn view(&self, width: u16) -> SmallVec<VisualRow<'_>, 8> {
		self.view_rows(width, MAX_INPUT_ROWS)
	}

	/// Places the cursor on a visual input row and refreshes derived editor
	/// state.
	pub fn set_cursor_visual_row(&mut self, row: usize, column: u16, width: u16) {
		self.buffer.set_cursor_visual_row(row, column, width);
		self.refresh();
	}

	/// Returns the selected display-column span intersecting `row`.
	pub fn selection_span(&self, row: &VisualRow<'_>) -> Option<(u16, u16)> {
		self.buffer.selection_span(row)
	}

	/// Takes the text captured by the last `Copy`/`Cut`; see
	/// [`EditBuffer::take_copied`].
	pub const fn take_copied(&mut self) -> Option<Str> {
		self.buffer.take_copied()
	}

	/// Extends the selection to a visual input row and refreshes derived state.
	pub fn extend_selection_visual_row(&mut self, row: usize, column: u16, width: u16) {
		self.buffer.extend_selection_visual_row(row, column, width);
		self.refresh();
	}

	/// Selects the word around a visual input position and refreshes derived
	/// state.
	pub fn select_word_visual_row(&mut self, row: usize, column: u16, width: u16) {
		self.buffer.select_word_visual_row(row, column, width);
		self.refresh();
	}

	/// Scrolls the input viewport by `delta` visual rows.
	///
	/// Returns whether the clamped viewport offset changed.
	pub fn scroll_rows(&self, delta: i32, width: u16, max_rows: usize) -> bool {
		self.last_layout_width.set(width.max(1));
		self.last_page_rows.set(max_rows.max(1));
		self.buffer.scroll_rows(delta, width, max_rows)
	}

	/// Applies one decoded terminal key.
	pub fn handle_key(&mut self, key: Key) -> EditOutcome {
		self.handle(key)
	}

	/// Applies one decoded editor key.
	///
	/// While the dropdown is open, navigation and acceptance keys drive
	/// it and `Esc` closes it; every other key edits the buffer as usual.
	pub fn handle(&mut self, key: Key) -> EditOutcome {
		if self.picker.is_some() {
			return match key {
				Key::Esc => {
					self.picker = None;
					EditOutcome::Changed
				},
				Key::Up => self.select_previous(),
				Key::Down => self.select_next(),
				Key::PageUp => self.select_page(false),
				Key::PageDown => self.select_page(true),
				Key::Enter => self.enter_picker(),
				Key::Tab => self.tab_complete(),
				Key::Right if self.cursor_at_logical_line_end() => self.tab_complete(),
				_ => self.handle_without_picker(key),
			};
		}
		self.handle_without_picker(key)
	}

	fn handle_without_picker(&mut self, key: Key) -> EditOutcome {
		match key {
			Key::Enter => self.submit(),
			Key::Tab => self.tab_complete(),
			Key::Ctrl('r') if self.options.history => self.history_search(),
			Key::Up if self.options.history && self.history_gate_up() => self.history_older(),
			Key::Down
				if self.options.history
					&& self.history_index.is_some()
					&& self.buffer.at_visual_end() =>
			{
				self.history_newer()
			},
			_ => {
				// Any edit leaves history browsing; caret motion inside a recalled
				// entry keeps it and never pops the dropdown.
				if !is_caret_motion(key) {
					self.history_index = None;
					self.history_query = None;
				}
				let outcome =
					self
						.buffer
						.handle(key, self.last_layout_width.get(), self.last_page_rows.get());
				if matches!(outcome, BufferOutcome::Changed) {
					if self.options.emoji {
						match key {
							Key::Char(':') => self.replace_shortcode(),
							Key::Char(character) if character.is_whitespace() => self.replace_emoticon(),
							Key::Space => self.replace_emoticon(),
							_ => {},
						}
					}
					if self.history_index.is_some() {
						self.refresh_recalled();
					} else {
						self.refresh();
					}
					EditOutcome::Changed
				} else {
					EditOutcome::Ignored
				}
			},
		}
	}

	fn cursor_at_logical_line_end(&self) -> bool {
		self
			.buffer
			.text()
			.as_bytes()
			.get(self.buffer.cursor())
			.is_none_or(|byte| *byte == b'\n')
	}

	fn tab_complete(&mut self) -> EditOutcome {
		// Fence a delayed provider result before asking that provider to act
		// on its selected row. `accept_picker` closes it without an edit.
		if self
			.picker
			.as_ref()
			.is_some_and(|picker| !self.picker_is_current(picker))
		{
			return self.accept_picker();
		}
		// the built-in emoji dropdown accepts without consulting the engine
		if self.picker.as_ref().is_some_and(|picker| !picker.provided) {
			return self.accept_picker();
		}
		let action = match self.completion.as_mut() {
			Some(completion) => {
				let selected = self
					.picker
					.as_ref()
					.map(|picker| &picker.suggestions[picker.selected]);
				completion.tab(self.buffer.text(), self.buffer.cursor(), selected)
			},
			None if self.picker.is_some() => TabAction::Accept,
			None => TabAction::Pass,
		};
		match action {
			TabAction::Accept if self.picker.is_some() => self.accept_picker(),
			TabAction::Edit(edit) => {
				self.buffer.replace_range(edit.range, &edit.insert);
				self.refresh();
				EditOutcome::Changed
			},
			TabAction::Accept | TabAction::Pass => EditOutcome::Ignored,
		}
	}

	fn history_gate_up(&self) -> bool {
		if !self.buffer.at_visual_start() {
			return false;
		}
		self.history_index.is_some() || self.buffer.text().is_empty()
	}

	fn history_older(&mut self) -> EditOutcome {
		if self.history.is_empty() {
			return EditOutcome::Ignored;
		}
		let next = self.history_index.map_or(0, |index| index + 1);
		if next >= self.history.len() {
			return EditOutcome::Ignored;
		}
		if self.history_index.is_none() {
			self.history_draft = Str::new(self.buffer.text());
		}
		self.history_query = None;
		self.history_index = Some(next);
		self.buffer.replace_external(&self.history[next], true);
		self.refresh_recalled();
		EditOutcome::Changed
	}

	/// Re-queries completion after a history step but keeps the dropdown
	/// closed. A recalled `/command` is a prompt to resend, and Up/Down keep
	/// stepping history
	/// instead of walking a popup that popped over it.
	fn refresh_recalled(&mut self) {
		self.refresh();
		self.picker = None;
	}

	fn history_search(&mut self) -> EditOutcome {
		if self.history.is_empty() {
			return EditOutcome::Ignored;
		}
		if self.history_index.is_none() {
			self.history_draft = Str::new(self.buffer.text());
		}
		if self.history_query.is_none() {
			self.history_query = Some(self.history_draft.trim().to_ascii_lowercase().into());
		}
		let query = self
			.history_query
			.as_ref()
			.map_or("", |query| query.as_str());
		let start = self
			.history_index
			.map_or(0, |index| index.saturating_add(1));
		let found = self
			.history
			.iter()
			.enumerate()
			.skip(start)
			.find_map(|(index, entry)| history_entry_matches(query, entry).then_some(index));
		let Some(index) = found else {
			return EditOutcome::Ignored;
		};
		self.history_index = Some(index);
		self.buffer.replace_external(&self.history[index], false);
		self.refresh_recalled();
		EditOutcome::Changed
	}

	fn history_newer(&mut self) -> EditOutcome {
		let Some(index) = self.history_index else {
			return EditOutcome::Ignored;
		};
		let next = if let Some(query) = &self.history_query {
			(0..index)
				.rev()
				.find(|&candidate| history_entry_matches(query, &self.history[candidate]))
		} else {
			index.checked_sub(1)
		};
		if let Some(next) = next {
			self.history_index = Some(next);
			self.buffer.replace_external(&self.history[next], false);
		} else {
			self.history_index = None;
			self.history_query = None;
			self.buffer.replace_external(&self.history_draft, false);
		}
		self.refresh_recalled();
		EditOutcome::Changed
	}

	/// Applies a programmatic replacement (word completion, platform
	/// autocorrect) as one undo unit, leaving the cursor after `insert`,
	/// and re-queries completion state.
	pub fn apply_edit(&mut self, range: Range<usize>, insert: &str) {
		self.history_index = None;
		self.history_query = None;
		self.buffer.replace_range(range, insert);
		self.refresh();
	}

	/// Shows or replaces one volatile speech-recognition preview.
	///
	/// Replacements do not enter undo history. The caret stays synchronized
	/// with its logical position around the span as its byte length changes.
	pub fn set_volatile_text(&mut self, text: &str) {
		self.set_volatile_text_selection(text, Some(text.len()..text.len()));
	}

	/// Shows or replaces one volatile native-IME preedit and applies the
	/// byte-indexed selection winit reports inside that preedit. `None`
	/// hides the insertion caret while the platform candidate picker owns it.
	pub fn set_volatile_text_selection(&mut self, text: &str, selection: Option<Range<usize>>) {
		self.history_index = None;
		self.history_query = None;
		let range = self
			.volatile
			.take()
			.filter(|(range, expected)| {
				self.buffer.text().get(range.clone()) == Some(expected.as_str())
			})
			.map_or_else(|| self.buffer.cursor()..self.buffer.cursor(), |(range, _)| range);
		let range = self.buffer.replace_transient_range(range, text);
		self.volatile_cursor = selection.is_some();
		if let Some(selection) = selection {
			let (start, end) = {
				// `replace_transient_range` applies the same NFC/control
				// sanitation as ordinary input. Clamp the platform's offsets
				// against those retained bytes so decomposed marked text
				// cannot place the caret beyond the normalized span.
				let retained = &self.buffer.text()[range.clone()];
				let boundary = |mut at: usize| {
					at = at.min(retained.len());
					while !retained.is_char_boundary(at) {
						at -= 1;
					}
					at
				};
				let start = boundary(selection.start);
				let end = boundary(selection.end);
				if start <= end {
					(start, end)
				} else {
					(end, start)
				}
			};
			self.buffer.cursor = range.start + end;
			self.buffer.anchor = (start != end).then_some(range.start + start);
		}
		self.volatile =
			(!range.is_empty()).then(|| (range.clone(), Str::new(&self.buffer.text()[range])));
		self.refresh();
	}

	/// Whether the retained editor should expose its hardware/native caret.
	#[must_use]
	pub const fn caret_visible(&self) -> bool {
		self.volatile_cursor
	}

	/// Whether a volatile speech/IME span is currently retained.
	#[must_use]
	pub const fn volatile_active(&self) -> bool {
		self.volatile.is_some()
	}

	/// Discards the active volatile speech-recognition preview.
	pub fn clear_volatile_text(&mut self) {
		self.volatile_cursor = true;
		let Some((range, expected)) = self.volatile.take() else {
			return;
		};
		if self.buffer.text().get(range.clone()) == Some(expected.as_str()) {
			self.buffer.replace_transient_range(range, "");
			self.refresh();
		}
	}

	/// Replaces the volatile preview with one undoable finalized segment.
	pub fn commit_volatile_text(&mut self, text: &str) {
		self.history_index = None;
		self.history_query = None;
		self.volatile_cursor = true;
		if let Some((range, expected)) = self.volatile.take()
			&& self.buffer.text().get(range.clone()) == Some(expected.as_str())
		{
			self.buffer.commit_transient_range(range, text);
			self.refresh();
		} else if matches!(self.buffer.insert_text(text), BufferOutcome::Changed) {
			self.refresh();
		}
	}

	/// Inserts sanitized text at the cursor (pastes, programmatic prefill).
	pub fn insert_text(&mut self, text: &str) -> EditOutcome {
		self.history_index = None;
		self.history_query = None;
		if matches!(self.buffer.insert_text(text), BufferOutcome::Changed) {
			self.refresh();
			EditOutcome::Changed
		} else {
			EditOutcome::Ignored
		}
	}

	/// Inserts an atomic reference at the cursor; see
	/// [`EditBuffer::insert_reference`].
	pub fn insert_reference(&mut self, marker: &str, payload: &str) -> EditOutcome {
		self.history_index = None;
		self.history_query = None;
		if matches!(self.buffer.insert_reference(marker, payload), BufferOutcome::Changed) {
			self.refresh();
			EditOutcome::Changed
		} else {
			EditOutcome::Ignored
		}
	}

	/// Inserts one paste/drop gesture's attachment references as one undo unit.
	pub fn insert_reference_group(
		&mut self,
		references: &[(String, String)],
		suffix: &str,
	) -> EditOutcome {
		self.history_index = None;
		self.history_query = None;
		if matches!(self.buffer.insert_reference_group(references, suffix), BufferOutcome::Changed) {
			self.refresh();
			EditOutcome::Changed
		} else {
			EditOutcome::Ignored
		}
	}

	/// Byte ranges of atomic markers in the visible text; see
	/// [`EditBuffer::atom_ranges`].
	pub fn atom_ranges(&self) -> SmallVec<(usize, usize), 4> {
		self.buffer.atom_ranges()
	}

	/// Opens a replacement picker for `range` at or before the cursor;
	/// acceptance replaces that range and preserves the cursor's trailing
	/// offset (for example, after a word-boundary space).
	pub fn show_replacements(
		&mut self,
		range: Range<usize>,
		items: impl IntoIterator<Item = Str>,
	) -> bool {
		let text = self.buffer.text();
		let cursor = self.buffer.cursor();
		if range.start >= range.end
			|| range.end > text.len()
			|| cursor < range.start
			|| !text.is_char_boundary(range.start)
			|| !text.is_char_boundary(range.end)
		{
			return false;
		}
		let cursor_offset = cursor.saturating_sub(range.end);
		let rows = self.options.picker_rows();
		let suggestions: SuggestionList = items
			.into_iter()
			.take(rows)
			.map(|item| Suggestion::new(item.clone(), item))
			.collect();
		if suggestions.is_empty() {
			return false;
		}
		self.picker = Some(Picker {
			range,
			suggestions,
			selected: 0,
			source_generation: self.completion_generation,
			source_text: Str::new(self.buffer.text()),
			source_cursor: self.buffer.cursor(),
			cursor_offset,
			provided: false,
			rows,
		});
		true
	}

	fn submit(&mut self) -> EditOutcome {
		if self.buffer.text().trim().is_empty() {
			return EditOutcome::Ignored;
		}
		let submitted = self.buffer.clear_after_submit();
		let submitted = if self.options.emoji {
			expand_emoticons(submitted)
		} else {
			submitted
		};
		self.add_to_history(&submitted);
		self.picker = None;
		self.hint = None;
		EditOutcome::Submitted(submitted)
	}

	const fn select_previous(&mut self) -> EditOutcome {
		let picker = self.picker.as_mut().expect("picker presence was checked");
		picker.selected = if picker.selected == 0 {
			picker.len() - 1
		} else {
			picker.selected - 1
		};
		EditOutcome::Changed
	}

	const fn select_next(&mut self) -> EditOutcome {
		let picker = self.picker.as_mut().expect("picker presence was checked");
		picker.selected = (picker.selected + 1) % picker.len();
		EditOutcome::Changed
	}

	fn select_page(&mut self, down: bool) -> EditOutcome {
		let picker = self.picker.as_mut().expect("picker presence was checked");
		picker.selected = if down {
			picker
				.selected
				.saturating_add(picker.rows)
				.min(picker.len() - 1)
		} else {
			picker.selected.saturating_sub(picker.rows)
		};
		EditOutcome::Changed
	}

	/// Moves keyboard selection one row without wrapping, as a pointer wheel
	/// over the completion list does.
	pub fn wheel_picker(&mut self, down: bool) -> EditOutcome {
		let Some(picker) = self.picker.as_mut() else {
			return EditOutcome::Ignored;
		};
		let next = if down {
			picker.selected.saturating_add(1).min(picker.len() - 1)
		} else {
			picker.selected.saturating_sub(1)
		};
		if next == picker.selected {
			return EditOutcome::Ignored;
		}
		picker.selected = next;
		EditOutcome::Changed
	}

	/// Promotes one pointer row to keyboard selection and accepts it.
	pub fn click_picker(&mut self, index: usize) -> EditOutcome {
		let Some(picker) = self.picker.as_mut() else {
			return EditOutcome::Ignored;
		};
		if index >= picker.len() {
			return EditOutcome::Ignored;
		}
		picker.selected = index;
		self.accept_picker()
	}

	fn accept_picker(&mut self) -> EditOutcome {
		let picker = self.picker.take().expect("picker presence was checked");
		if !self.picker_is_current(&picker) {
			let cursor = self.buffer.cursor();
			self.hint = self
				.completion
				.as_mut()
				.and_then(|completion| completion.hint(self.buffer.text(), cursor));
			return EditOutcome::Changed;
		}
		let suggestion = &picker.suggestions[picker.selected];
		// Accepting an already-typed value is a no-op; re-querying would
		// reopen the identical dropdown and trap Enter forever. Close the
		// dropdown and let the next keypress act on the finished text.
		if self.buffer.text()[picker.range.clone()] == *suggestion.value {
			let cursor = self.buffer.cursor();
			self.hint = self
				.completion
				.as_mut()
				.and_then(|completion| completion.hint(self.buffer.text(), cursor));
			return EditOutcome::Changed;
		}
		self.apply_suggestion(&picker, suggestion);
		self.refresh();
		EditOutcome::Changed
	}

	fn picker_is_current(&self, picker: &Picker) -> bool {
		picker.source_generation == self.completion_generation
			&& picker.source_text == self.buffer.text()
			&& picker.source_cursor == self.buffer.cursor()
			&& self
				.buffer
				.atom_ranges()
				.iter()
				.all(|&(start, end)| picker.range.end <= start || picker.range.start >= end)
	}

	/// Replaces the picker's range with the row's value and, for
	/// engine-provided rows, reports the acceptance to the engine.
	fn apply_suggestion(&mut self, picker: &Picker, suggestion: &Suggestion) {
		let Some(completion) = self.completion.as_mut().filter(|_| picker.provided) else {
			self
				.buffer
				.replace_range(picker.range.clone(), &suggestion.value);
			self.buffer.restore_cursor_offset(picker.cursor_offset);
			return;
		};
		let replaced = Str::new(&self.buffer.text()[picker.range.clone()]);
		self
			.buffer
			.replace_range(picker.range.clone(), &suggestion.value);
		completion.accepted(&replaced, suggestion);
	}

	/// Moves the cursor to the start or end of the whole message.
	pub fn move_to_message_edge(&mut self, end: bool) -> EditOutcome {
		match self.buffer.move_to_message_edge(end) {
			BufferOutcome::Changed => {
				self.refresh();
				EditOutcome::Changed
			},
			BufferOutcome::Ignored => EditOutcome::Ignored,
		}
	}

	/// Undoes the last meaningful edit, skipping snapshots that only carry
	/// the just-removed `transient` trigger text (see
	/// [`EditBuffer::undo_past_transient`]).
	pub fn undo_past_transient(&mut self, transient: &str) -> EditOutcome {
		self.history_index = None;
		self.history_query = None;
		match self.buffer.undo_past_transient(transient) {
			BufferOutcome::Changed => {
				self.refresh();
				EditOutcome::Changed
			},
			BufferOutcome::Ignored => EditOutcome::Ignored,
		}
	}

	/// When the dropdown is open, a command row with nothing before its token
	/// completes the command and submits in one keypress; every other row is
	/// accepted in place.
	fn enter_picker(&mut self) -> EditOutcome {
		if self.picker_enter_submits() {
			self.accept_for_submit();
			return self.submit();
		}
		self.accept_picker()
	}

	/// Whether Enter with the open dropdown should submit: the selected row
	/// is a command completion (see [`Suggestion::with_submit`]) and only
	/// whitespace precedes its token.
	pub fn picker_enter_submits(&self) -> bool {
		self.picker.as_ref().is_some_and(|picker| {
			self.picker_is_current(picker)
				&& picker.suggestions[picker.selected].submits
				&& self.buffer.text()[..picker.range.start].trim().is_empty()
		})
	}

	/// Applies the selected dropdown row and closes the dropdown without
	/// re-querying, leaving the completed text in place for the host's
	/// submit path. Enter on a submitted slash command applies, then submits.
	pub fn accept_for_submit(&mut self) {
		let Some(picker) = self.picker.take() else {
			return;
		};
		if !self.picker_is_current(&picker) {
			let cursor = self.buffer.cursor();
			self.hint = self
				.completion
				.as_mut()
				.and_then(|completion| completion.hint(self.buffer.text(), cursor));
			return;
		}
		let suggestion = &picker.suggestions[picker.selected];
		self.apply_suggestion(&picker, suggestion);
		self.hint = None;
	}

	/// Re-queries the completion engine (dropdown and ghost hint), falling
	/// back to the built-in emoji dropdown when the engine declines.
	fn refresh(&mut self) {
		self.completion_generation = self.completion_generation.wrapping_add(1);
		let generation = self.completion_generation;
		let cursor = self.buffer.cursor();
		let text = self.buffer.text();
		let atoms = self.buffer.atom_ranges();
		// A dropdown replaces its range on accept; a range that touches an
		// atomic marker (a `<icon> #N` chip whose text merely looks like a
		// trigger) would tear the unit, so no engine may open over one.
		let clear_of_atoms = |range: &ops::Range<usize>| {
			atoms
				.iter()
				.all(|&(start, end)| range.end <= start || range.start >= end)
		};
		let rows = self.options.picker_rows();
		let mut picker = self
			.completion
			.as_mut()
			.and_then(|completion| {
				let suggestions = completion.suggest(text, cursor)?;
				(!suggestions.items.is_empty()).then(|| Picker {
					range: clamp_completion_range(text, cursor, suggestions.range),
					suggestions: suggestions.items,
					selected: 0,
					source_generation: generation,
					source_text: Str::new(text),
					source_cursor: cursor,
					cursor_offset: 0,
					provided: true,
					rows,
				})
			})
			.filter(|picker| clear_of_atoms(&picker.range));
		if picker.is_none()
			&& self.options.emoji
			&& self
				.completion
				.as_mut()
				.is_none_or(|completion| completion.allow_builtin_emoji(text, cursor))
		{
			picker = emoji_picker(text, cursor, generation, rows)
				.filter(|picker| clear_of_atoms(&picker.range));
		}
		self.hint = self
			.completion
			.as_mut()
			.and_then(|completion| completion.hint(text, cursor));
		self.picker = picker;
	}

	/// Dim ghost text rendered after the cursor: the selected suggestion's
	/// hint while the dropdown is open, otherwise the completion engine's
	/// latest [`EditorCompletion::hint`].
	pub fn inline_hint(&self) -> Option<Str> {
		if let Some(picker) = &self.picker
			&& let Some(hint) = &picker.suggestions[picker.selected].hint
		{
			return Some(hint.clone());
		}
		self.hint.clone()
	}

	fn replace_shortcode(&mut self) {
		let cursor = self.buffer.cursor();
		let before = &self.buffer.text()[..cursor];
		let bytes = before.as_bytes();
		if bytes.last() != Some(&b':') {
			return;
		}
		let close = bytes.len() - 1;
		let mut name_start = close;
		while name_start > 0 && is_name_byte(bytes[name_start - 1]) {
			name_start -= 1;
		}
		if name_start == close || name_start == 0 || bytes[name_start - 1] != b':' {
			return;
		}
		let open = name_start - 1;
		if !has_left_boundary(bytes, open) {
			return;
		}
		let name = before[name_start..close].to_ascii_lowercase();
		if let Some(emoji) = lookup_emoji(&name) {
			self.buffer.replace_range(open..cursor, emoji);
		}
	}

	fn replace_emoticon(&mut self) {
		let cursor = self.buffer.cursor();
		let before = &self.buffer.text()[..cursor];
		let Some(terminator) = before.chars().next_back() else {
			return;
		};
		let tail = before.len() - terminator.len_utf8();
		for &(pattern, emoji) in EMOTICONS {
			let Some(start) = tail.checked_sub(pattern.len()) else {
				continue;
			};
			if before.get(start..tail) != Some(pattern) || !has_left_boundary(before.as_bytes(), start)
			{
				continue;
			}
			let mut replacement = String::with_capacity(emoji.len() + terminator.len_utf8());
			replacement.push_str(emoji);
			replacement.push(terminator);
			self.buffer.replace_range(start..cursor, &replacement);
			break;
		}
	}
}

/// Clamps an engine-supplied replacement range around its request cursor:
/// both ends are pulled onto char boundaries inside the request text.
/// Picker snapshot validation separately rejects asynchronous drift.
fn clamp_completion_range(text: &str, cursor: usize, range: Range<usize>) -> Range<usize> {
	let mut start = range.start.min(cursor);
	while !text.is_char_boundary(start) {
		start -= 1;
	}
	let mut end = range.end.max(cursor).min(text.len());
	while !text.is_char_boundary(end) {
		end += 1;
	}
	start..end
}

fn completion_token_end(text: &str, cursor: usize) -> usize {
	text[cursor..]
		.find(char::is_whitespace)
		.map_or(text.len(), |offset| cursor + offset)
}

/// One slash-command palette entry completed by [`SlashCommands`].
#[derive(Clone)]
pub struct Command {
	name:         Str,
	description:  Str,
	aliases:      SmallVec<Str, 1>,
	icon:         Option<Icon>,
	args:         Box<[CommandArg]>,
	hint:         Option<Str>,
	dynamic_args: Option<Arc<dyn Fn(&str) -> Box<[CommandArgument]> + Send + Sync>>,
	status:       Option<Arc<dyn Fn() -> Str + Send + Sync>>,
}

/// One argument candidate completed after a command name (`/mcp add …`).
#[derive(Clone)]
struct CommandArg {
	name:        Str,
	description: Str,
	usage:       Option<Str>,
}
/// One dynamic slash-command argument candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandArgument {
	/// Text inserted into the editor.
	pub value:       Str,
	/// One-line candidate description.
	pub description: Str,
	/// Ghosted usage after insertion.
	pub usage:       Option<Str>,
}

impl Command {
	/// Builds a palette entry from its name, blurb, and alias spellings.
	pub fn new(name: &str, description: &str, aliases: &[&str]) -> Self {
		Self {
			name:         Str::new(name),
			description:  Str::new(description),
			aliases:      aliases.iter().map(Str::new).collect(),
			icon:         None,
			args:         Box::default(),
			hint:         None,
			dynamic_args: None,
			status:       None,
		}
	}

	/// Assigns a semantic type-indicator icon resolved by the active charset.
	pub const fn with_icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
		self
	}

	/// Supplies live argument candidates. The provider runs only while this
	/// command's first argument is being completed.
	pub fn with_dynamic_args(
		mut self,
		provider: impl Fn(&str) -> Box<[CommandArgument]> + Send + Sync + 'static,
	) -> Self {
		self.dynamic_args = Some(Arc::new(provider));
		self
	}

	/// Supplies a live status line for the command-palette description.
	pub fn with_status(mut self, provider: impl Fn() -> Str + Send + Sync + 'static) -> Self {
		self.status = Some(Arc::new(provider));
		self
	}

	/// Argument candidates offered once the command name is complete:
	/// `(name, description, usage)`, with `""` usage meaning none. Usage
	/// text ghosts after the argument (`<path>`, `<a> <b>`).
	pub fn with_args(mut self, args: &[(&str, &str, &str)]) -> Self {
		self.args = args
			.iter()
			.map(|&(name, description, usage)| CommandArg {
				name:        Str::new(name),
				description: Str::new(description),
				usage:       (!usage.is_empty()).then(|| Str::new(usage)),
			})
			.collect();
		self
	}

	/// Usage hint shown as dim ghost text after the cursor
	/// (e.g. `<name> [--scope project|user]`).
	pub fn with_hint(mut self, hint: &str) -> Self {
		self.hint = Some(Str::new(hint));
		self
	}

	/// The command's primary spelling, without the leading `/`.
	pub fn name(&self) -> &str {
		&self.name
	}

	/// Semantic type-indicator icon resolved by the active charset.
	pub const fn icon(&self) -> Option<Icon> {
		self.icon
	}

	/// The one-line blurb shown beside the command name.
	pub fn description(&self) -> &str {
		&self.description
	}
}

/// Slash-command completion over a fixed [`Command`] palette.
///
/// `/` at a line start opens ranked name completion, the first argument
/// completes against candidates, and usage text ghosts after the cursor.
pub struct SlashCommands {
	commands: Box<[Command]>,
	usage:    Option<Arc<dyn Fn(&str) -> u64 + Send + Sync>>,
}

impl SlashCommands {
	/// Wraps a command palette for [`Editor::set_completion`].
	pub fn new(commands: impl Into<Box<[Command]>>) -> Self {
		Self { commands: commands.into(), usage: None }
	}

	/// Ranks equally matching command names by their persisted invocation count.
	pub fn with_usage(mut self, usage: impl Fn(&str) -> u64 + Send + Sync + 'static) -> Self {
		self.usage = Some(Arc::new(usage));
		self
	}

	fn find(&self, name: &str) -> Option<&Command> {
		self
			.commands
			.iter()
			.find(|command| command.name == name || command.aliases.iter().any(|a| a == name))
	}

	fn name_suggestions(
		&self,
		line_start: usize,
		line: &str,
		range_end: usize,
	) -> Option<Suggestions> {
		const SKILL_NAMESPACE: &str = "skill:";
		let trimmed = line.trim_start_matches([' ', '\t']);
		let body = trimmed.strip_prefix('/')?;
		if body.contains('/') {
			return None;
		}
		let prefix_start = line_start + line.len() - trimmed.len();
		let query = body.to_ascii_lowercase();
		let in_skill_namespace = query.starts_with(SKILL_NAMESPACE);
		let approaches_skill_namespace = SKILL_NAMESPACE.starts_with(&query);
		let strongest_command_tier = if !approaches_skill_namespace {
			{
				self
					.commands
					.iter()
					.filter(|command| !command.name.starts_with(SKILL_NAMESPACE))
					.flat_map(|command| {
						std::iter::once(command.name.as_str())
							.chain(command.aliases.iter().map(Str::as_str))
					})
					.map(|name| breakout_match_tier(&query, name))
					.max()
					.unwrap_or(0)
			}
		} else {
			0
		};
		let skill_count = self
			.commands
			.iter()
			.filter(|command| command.name.starts_with(SKILL_NAMESPACE))
			.count();
		let skill_icon = self
			.commands
			.iter()
			.find(|command| command.name.starts_with(SKILL_NAMESPACE))
			.and_then(|command| command.icon);
		let mut ranked: SmallVec<(u16, u64, Suggestion), 8> = SmallVec::new();
		for command in &self.commands {
			let skill_name = command.name.strip_prefix(SKILL_NAMESPACE);
			if let Some(ref bare_name) = skill_name
				&& !in_skill_namespace
				&& (approaches_skill_namespace
					|| breakout_match_tier(&query, bare_name) <= strongest_command_tier)
			{
				continue;
			}
			let mut selected_name = &command.name;
			let mut score = command_score(&query, &command.name);
			if let Some(bare_name) = skill_name {
				score = score.max(command_score(&query, &bare_name));
			}
			for alias in &command.aliases {
				let alias_score = command_score(&query, alias);
				if alias_score > score {
					selected_name = alias;
					score = alias_score;
				}
			}
			let description_score = fuzzy_score(&query, &command.description.to_ascii_lowercase()) / 2;
			score = score.max(description_score);
			if score > 0 {
				ranked.push((
					score,
					self.usage.as_ref().map_or(0, |usage| usage(&command.name)),
					Suggestion {
						value:       sf!("/{selected_name} "),
						display:     SuggestionDisplay::Text(selected_name.clone()),
						description: Some(
							command
								.status
								.as_ref()
								.map_or_else(|| command.description.clone(), |status| status()),
						),
						icon:        command.icon,
						hint:        command.hint.clone(),
						category:    Some(sf!("Commands")),
						match_spans: fuzzy_match_spans(selected_name, &query),
						submits:     true,
					},
				));
			}
		}
		if !in_skill_namespace && skill_count > 0 && approaches_skill_namespace {
			ranked.push((command_score(&query, SKILL_NAMESPACE), 0, Suggestion {
				value:       sf!("/skill:"),
				display:     SuggestionDisplay::Text(sf!("skill:")),
				description: Some(sf!(
					"{skill_count} skill{}",
					if skill_count == 1 { "" } else { "s" }
				)),
				icon:        skill_icon,
				hint:        None,
				category:    Some(sf!("Commands")),
				match_spans: fuzzy_match_spans(SKILL_NAMESPACE, &query),
				submits:     false,
			}));
		}
		ranked.sort_by_key(|(score, usage, _)| (Reverse(*score), Reverse(*usage)));
		let items = ranked
			.into_iter()
			.map(|(_, _, suggestion)| suggestion)
			.collect::<SuggestionList>();
		(!items.is_empty()).then_some(Suggestions { range: prefix_start..range_end, items })
	}

	fn argument_suggestions(
		&self,
		cursor: usize,
		body: &str,
		delimiter: usize,
		range_end: usize,
	) -> Option<Suggestions> {
		let (name, rest) = body.split_at(delimiter);
		let partial = rest.trim_start_matches([' ', '\t', ':']);
		let first_argument = !partial.contains(char::is_whitespace);
		let command = self.find(name)?;
		// Dynamic providers receive the whole argument tail. This lets
		// declarative subcommand providers switch to a second-token source
		// (`/mcp test <server>`) while static candidates stay first-token only.
		let dynamic = command
			.dynamic_args
			.as_ref()
			.map(|provider| provider(partial))
			.unwrap_or_default();
		let paths = if first_argument && command.name == "move" {
			filesystem_path_arguments(partial)
		} else {
			Default::default()
		};
		if command.args.is_empty() && dynamic.is_empty() && paths.is_empty() {
			return None;
		}
		let prefix_start = cursor - partial.len();
		let query = partial.to_ascii_lowercase();
		let mut ranked: SmallVec<(u16, Suggestion), 8> = SmallVec::new();
		for (arg, spaced) in command
			.args
			.iter()
			.filter(|_| first_argument)
			.map(|arg| {
				(
					CommandArgument {
						value:       arg.name.clone(),
						description: arg.description.clone(),
						usage:       arg.usage.clone(),
					},
					true,
				)
			})
			.chain(dynamic.into_vec().into_iter().map(|arg| (arg, true)))
			.chain(paths.into_iter().map(|arg| (arg, false)))
		{
			let score = command_score(&query, &arg.value.to_ascii_lowercase());
			if score > 0 {
				let hint = argument_inline_hint(&arg.value, partial, arg.usage.as_ref());
				ranked.push((score, Suggestion {
					value: if spaced {
						sf!("{} ", arg.value)
					} else {
						arg.value.clone()
					},
					display: SuggestionDisplay::Text(arg.value.clone()),
					description: Some(arg.description.clone()),
					icon: None,
					hint,
					category: Some(sf!("Arguments")),
					match_spans: fuzzy_match_spans(&arg.value, &query),
					submits: false,
				}));
			}
		}
		ranked.sort_by_key(|(score, _)| Reverse(*score));
		let items = ranked
			.into_iter()
			.map(|(_, suggestion)| suggestion)
			.collect::<SuggestionList>();
		(!items.is_empty()).then_some(Suggestions { range: prefix_start..range_end, items })
	}
}

/// Ghosts the untyped suffix of the selected argument before its post-accept
/// usage. A bare command keeps its command-level hint instead.
fn argument_inline_hint(value: &str, partial: &str, usage: Option<&Str>) -> Option<Str> {
	if partial.is_empty() {
		return None;
	}
	let remaining = value.get(partial.len()..).filter(|_| {
		value
			.get(..partial.len())
			.is_some_and(|prefix| prefix.eq_ignore_ascii_case(partial))
	});
	match (remaining, usage) {
		(Some(""), Some(usage)) => Some(usage.clone()),
		(Some(""), None) => None,
		(Some(remaining), Some(usage)) => Some(sf!("{remaining} {usage}")),
		(Some(remaining), None) => Some(Str::new(remaining)),
		(None, usage) => usage.cloned(),
	}
}

fn filesystem_path_arguments(partial: &str) -> Vec<CommandArgument> {
	if partial == "~" {
		return vec![CommandArgument {
			value:       Str::new_static("~/"),
			description: Str::new_static("home directory"),
			usage:       None,
		}];
	}
	let expanded = if let Some(rest) = partial.strip_prefix('~') {
		let Some(home) = env::var_os("HOME") else {
			return Vec::new();
		};
		PathBuf::from(home).join(rest.trim_start_matches(['/', '\\']))
	} else if partial.is_empty() {
		PathBuf::from(".")
	} else {
		PathBuf::from(partial)
	};
	if expanded
		.components()
		.any(|component| component.as_os_str() == ".git")
	{
		return Vec::new();
	}
	let (directory, prefix) = if partial.is_empty() || partial.ends_with(['/', '\\']) {
		(expanded.as_path(), "")
	} else {
		(
			expanded.parent().unwrap_or_else(|| Path::new(".")),
			expanded
				.file_name()
				.and_then(|name| name.to_str())
				.unwrap_or(""),
		)
	};
	let Ok(entries) = fs::read_dir(directory) else {
		return Vec::new();
	};
	let typed_parent = partial
		.rfind(['/', '\\'])
		.map_or("", |separator| &partial[..=separator]);
	let mut candidates = Vec::new();
	for entry in entries.flatten() {
		let name = entry.file_name();
		let Some(name) = name.to_str() else {
			continue;
		};
		if name == ".git" || !name.starts_with(prefix) {
			continue;
		}
		let is_directory = entry.path().is_dir();
		let mut value =
			String::with_capacity(typed_parent.len() + name.len() + usize::from(is_directory));
		value.push_str(typed_parent);
		value.push_str(name);
		if is_directory {
			value.push(path::MAIN_SEPARATOR);
		}
		candidates.push(CommandArgument {
			value:       Str::new(value),
			description: if is_directory {
				Str::new_static("directory")
			} else {
				Str::new_static("file")
			},
			usage:       None,
		});
	}
	candidates.sort_by(|left, right| left.value.cmp(&right.value));
	candidates
}

impl EditorCompletion for SlashCommands {
	fn suggest(&mut self, text: &str, cursor: usize) -> Option<Suggestions> {
		let before = &text[..cursor];
		let line_start = before.rfind('\n').map_or(0, |index| index + 1);
		let line = &before[line_start..];
		let body = line.trim_start_matches([' ', '\t']).strip_prefix('/')?;
		let range_end = completion_token_end(text, cursor);
		if body.starts_with("skill:") && !body.contains(char::is_whitespace) {
			return self.name_suggestions(line_start, line, range_end);
		}
		match body.find(|ch: char| ch.is_whitespace() || ch == ':') {
			Some(delimiter) => self.argument_suggestions(cursor, body, delimiter, range_end),
			None => self.name_suggestions(line_start, line, range_end),
		}
	}

	/// Usage ghosting: bare `/name ` shows the command's own usage; a partial
	/// argument shows its remaining characters plus usage; a chosen argument
	/// ghosts the usage words not yet typed.
	fn hint(&mut self, text: &str, cursor: usize) -> Option<Str> {
		let line_start = text[..cursor].rfind('\n').map_or(0, |at| at + 1);
		let line = &text[line_start..cursor];
		let body = line.trim_start_matches([' ', '\t']).strip_prefix('/')?;
		let delimiter = body.find(|ch: char| ch.is_whitespace() || ch == ':')?;
		let (name, rest) = body.split_at(delimiter);
		let command = self.find(name)?;
		let argument = rest.trim_start_matches([' ', '\t', ':']);
		if argument.is_empty() {
			return command.hint.clone();
		}
		match argument.find(char::is_whitespace) {
			None => {
				let prefix = argument.to_ascii_lowercase();
				let matched = command
					.args
					.iter()
					.find(|arg| arg.name.starts_with(&prefix))?;
				let remaining = &matched.name.as_str()[prefix.len()..];
				match &matched.usage {
					Some(usage) => Some(sf!("{remaining} {usage}")),
					None if remaining.is_empty() => None,
					None => Some(Str::new(remaining)),
				}
			},
			Some(argument_end) => {
				let (chosen, after) = argument.split_at(argument_end);
				let arg = command.args.iter().find(|arg| arg.name == chosen)?;
				let usage = arg.usage.as_deref()?;
				let typed = after.split_whitespace().count();
				if typed == 0 {
					return Some(Str::new(usage));
				}
				let mut words = usage.split(' ');
				for _ in 0..typed {
					words.next()?;
				}
				let remaining = words.collect::<Vec<_>>().join(" ");
				(!remaining.is_empty()).then(|| Str::new(&remaining))
			},
		}
	}

	fn allow_builtin_emoji(&mut self, text: &str, cursor: usize) -> bool {
		let before = &text[..cursor];
		let line_start = before.rfind('\n').map_or(0, |at| at + 1);
		if !before[..line_start].trim().is_empty() {
			return true;
		}
		let Some(body) = before[line_start..]
			.trim_start_matches([' ', '\t'])
			.strip_prefix('/')
		else {
			return true;
		};
		let Some(delimiter) = body.find(char::is_whitespace) else {
			return true;
		};
		self.find(&body[..delimiter]).is_none()
	}
}

fn emoji_picker(text: &str, cursor: usize, generation: u64, rows: usize) -> Option<Picker> {
	let (prefix_start, query) = emoji_trigger(&text[..cursor])?;
	let mut suggestions = SuggestionList::new();
	let wanted = format!(":{query}");
	for &(pattern, emoji) in EMOTICONS {
		if suggestions.len() >= MAX_EMOJI_SUGGESTIONS {
			break;
		}
		if pattern.len() >= wanted.len() && pattern[..wanted.len()].eq_ignore_ascii_case(&wanted) {
			suggestions.push(Suggestion {
				value:       sf!(emoji),
				display:     SuggestionDisplay::Emoji { emoji, shortcode: pattern },
				description: None,
				icon:        None,
				hint:        None,
				category:    Some(sf!("Emoji")),
				match_spans: SmallVec::new(),
				submits:     false,
			});
		}
	}
	let first = query.get(..1)?;
	if let Some(bucket) = EMOJI_BUCKETS.get(first) {
		let start = bucket.partition_point(|entry| entry[0] < query.as_str());
		for entry in &bucket[start..] {
			if suggestions.len() >= MAX_EMOJI_SUGGESTIONS || !entry[0].starts_with(&query) {
				break;
			}
			suggestions.push(Suggestion {
				value:       sf!(entry[1]),
				display:     SuggestionDisplay::Emoji { emoji: entry[1], shortcode: entry[0] },
				description: None,
				icon:        None,
				hint:        None,
				category:    Some(sf!("Emoji")),
				match_spans: SmallVec::new(),
				submits:     false,
			});
		}
	}
	if suggestions.is_empty() {
		None
	} else {
		Some(Picker {
			range: prefix_start..emoji_token_end(text, cursor),
			suggestions,
			selected: 0,
			source_generation: generation,
			source_text: Str::new(text),
			source_cursor: cursor,
			cursor_offset: 0,
			provided: false,
			rows,
		})
	}
}

fn emoji_token_end(text: &str, mut cursor: usize) -> usize {
	while text
		.as_bytes()
		.get(cursor)
		.is_some_and(|byte| is_name_byte(*byte))
	{
		cursor += 1;
	}
	cursor
}

fn emoji_trigger(text: &str) -> Option<(usize, String)> {
	let bytes = text.as_bytes();
	let mut index = bytes.len();
	while index > 0 && is_name_byte(bytes[index - 1]) {
		index -= 1;
	}
	if index == 0 || bytes[index - 1] != b':' {
		return None;
	}
	let colon = index - 1;
	if !has_left_boundary(bytes, colon) || index == bytes.len() {
		return None;
	}
	Some((colon, text[index..].to_ascii_lowercase()))
}

const fn is_name_byte(byte: u8) -> bool {
	byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'-')
}

const fn has_left_boundary(bytes: &[u8], index: usize) -> bool {
	index == 0
		|| matches!(bytes[index - 1], b' ' | b'\t' | b'\n' | b'\r' | b'(' | b'[' | b'{' | b'>')
}

fn lookup_emoji(name: &str) -> Option<&'static str> {
	let bucket = EMOJI_BUCKETS.get(name.get(..1)?)?;
	let index = bucket.partition_point(|entry| entry[0] < name);
	bucket
		.get(index)
		.filter(|entry| entry[0] == name)
		.map(|entry| entry[1])
}

fn expand_emoticons(text: String) -> String {
	if text.len() < 2 {
		return text;
	}
	let bytes = text.as_bytes();
	let mut output: Option<String> = None;
	let mut copied = 0;
	let mut index = 0;
	while index < text.len() {
		let boundary = index == 0 || has_left_boundary(bytes, index);
		let matched = boundary
			.then(|| {
				EMOTICONS.iter().find_map(|&(pattern, emoji)| {
					let end = index.checked_add(pattern.len())?;
					(end <= text.len()
						&& &bytes[index..end] == pattern.as_bytes()
						&& (end == text.len()
							|| bytes
								.get(end)
								.is_some_and(|byte| matches!(*byte, b' ' | b'\t' | b'\n' | b'\r'))))
					.then_some((end, emoji))
				})
			})
			.flatten();
		if let Some((end, emoji)) = matched {
			let out = output.get_or_insert_with(|| String::with_capacity(text.len()));
			out.push_str(&text[copied..index]);
			out.push_str(emoji);
			copied = end;
			index = end;
			continue;
		}
		index += text[index..].chars().next().map_or(1, char::len_utf8);
	}
	let Some(mut output) = output else {
		return text;
	};
	output.push_str(&text[copied..]);
	output
}

fn fuzzy_match_spans(candidate: &str, query: &str) -> SmallVec<(u16, u16), 8> {
	if query.is_empty() {
		return SmallVec::new();
	}
	let folded = candidate.to_ascii_lowercase();
	if let Some(start) = folded.find(query) {
		let Ok(start) = u16::try_from(start) else {
			return SmallVec::new();
		};
		let Ok(end) = u16::try_from(usize::from(start) + query.len()) else {
			return SmallVec::new();
		};
		return smallvec::smallvec![(start, end)];
	}
	let mut spans = SmallVec::new();
	let mut query = query.bytes();
	let mut wanted = query.next();
	for (index, byte) in folded.bytes().enumerate() {
		if wanted == Some(byte) {
			if let Ok(index) = u16::try_from(index) {
				spans.push((index, index.saturating_add(1)));
			}
			wanted = query.next();
			if wanted.is_none() {
				break;
			}
		}
	}
	if wanted.is_none() {
		spans
	} else {
		SmallVec::new()
	}
}

fn command_score(query: &str, target: &str) -> u16 {
	if query.is_empty() {
		1
	} else if query == target {
		1_000
	} else if target.starts_with(query) {
		900
	} else {
		fuzzy_score(query, target)
	}
}

fn breakout_match_tier(query: &str, target: &str) -> u16 {
	if query == target {
		1_000
	} else if target.starts_with(query) {
		900
	} else {
		0
	}
}

/// Keys that move or select without editing text (the readline motions
/// included), so browsing prompt history survives them.
const fn is_caret_motion(key: Key) -> bool {
	matches!(
		key,
		Key::Up
			| Key::Down
			| Key::Left
			| Key::Right
			| Key::SelectLeft
			| Key::SelectRight
			| Key::SelectUp
			| Key::SelectDown
			| Key::Home
			| Key::End
			| Key::SelectHome
			| Key::SelectEnd
			| Key::PageUp
			| Key::PageDown
			| Key::WordLeft
			| Key::WordRight
			| Key::SelectWordLeft
			| Key::SelectWordRight
			| Key::SelectAll
			| Key::Copy
			| Key::Ctrl('a' | 'e' | 'b' | 'f')
	)
}

fn history_entry_matches(query: &str, entry: &str) -> bool {
	if query.is_empty() {
		return true;
	}
	let entry = entry.to_ascii_lowercase();
	entry.contains(query) || fuzzy_score(query, &entry) > 0
}

fn fuzzy_score(query: &str, target: &str) -> u16 {
	if query.is_empty() {
		return 1;
	}
	let mut query_bytes = query.bytes();
	let Some(mut wanted) = query_bytes.next() else {
		return 1;
	};
	let mut matched = 0_u16;
	let mut gaps = 0_u16;
	for byte in target.bytes() {
		if byte == wanted {
			matched = matched.saturating_add(1);
			if let Some(next) = query_bytes.next() {
				wanted = next;
			} else {
				return 500_u16
					.saturating_add(matched.saturating_mul(8))
					.saturating_sub(gaps);
			}
		} else if matched > 0 {
			gaps = gaps.saturating_add(1);
		}
	}
	0
}

#[cfg(test)]
mod tests {
	use self::editor as make_editor;
	use super::*;

	fn type_slash(text: &str) -> EditBuffer {
		let mut buffer = EditBuffer::new(text);
		assert_eq!(buffer.handle(Key::Char('/'), 80, 10), BufferOutcome::Changed);
		buffer
	}

	#[test]
	fn close_tag_completes_innermost_open_element() {
		let buffer = type_slash("<box><row gap=1><Foo.Bar>hi<");
		assert_eq!(buffer.text(), "<box><row gap=1><Foo.Bar>hi</Foo.Bar>");
		assert_eq!(buffer.cursor(), buffer.text().len());
	}

	#[test]
	fn close_tag_ignores_self_closing_elements() {
		let buffer = type_slash("<a><hr/><");
		assert_eq!(buffer.text(), "<a><hr/></a>");
		assert_eq!(buffer.cursor(), buffer.text().len());
	}

	#[test]
	fn close_tag_pops_already_closed_pair() {
		let buffer = type_slash("<a><b></b><");
		assert_eq!(buffer.text(), "<a><b></b></a>");
		assert_eq!(buffer.cursor(), buffer.text().len());
	}

	#[test]
	fn close_tag_respects_quoted_attribute_delimiters() {
		let buffer = type_slash("<a t=\"x>y\"><");
		assert_eq!(buffer.text(), "<a t=\"x>y\"></a>");
		assert_eq!(buffer.cursor(), buffer.text().len());
	}

	#[test]
	fn close_tag_ignores_comment_contents() {
		let buffer = type_slash("<a><!-- <b> --><");
		assert_eq!(buffer.text(), "<a><!-- <b> --></a>");
		assert_eq!(buffer.cursor(), buffer.text().len());
	}

	#[test]
	fn close_tag_ignores_inline_and_fenced_code() {
		let inline = type_slash("<real>`<fake>`<");
		assert_eq!(inline.text(), "<real>`<fake>`</real>");

		let fenced = type_slash("<real>\n```\n<fake>\n```\n<");
		assert_eq!(fenced.text(), "<real>\n```\n<fake>\n```\n</real>");
	}

	#[test]
	fn close_tag_recovers_from_a_mismatched_closer_without_leaking_inner_tags() {
		let buffer = type_slash("<outer><inner></outer><");
		assert_eq!(buffer.text(), "<outer><inner></outer></");
	}

	#[test]
	fn code_and_xml_masks_cover_structural_text_only() {
		let text = "prose `let x = <fake>` <real attr=\">\">body</real>\n~~~\n<tag>\n~~~";
		assert_eq!(
			code_ranges(text)
				.iter()
				.map(|range| &text[range.clone()])
				.collect::<Vec<_>>(),
			["`let x = <fake>`", "~~~\n<tag>\n~~~"]
		);
		assert_eq!(
			xml_ranges(text)
				.iter()
				.map(|range| &text[range.clone()])
				.collect::<Vec<_>>(),
			["<fake>", "<real attr=\">\">", "</real>", "<tag>"]
		);
	}

	#[test]
	fn close_tag_types_literal_slash_when_stack_is_empty() {
		let buffer = type_slash("<");
		assert_eq!(buffer.text(), "</");
		assert_eq!(buffer.cursor(), buffer.text().len());
	}
	#[test]
	fn pasting_a_document_does_not_complete_its_closing_tags() {
		// completion is a typing affordance; a pasted document already
		// carries its closers, so duplicating them would corrupt the paste
		let document = "<box bg=\"black\">\n  <row gap=\"1\">\n    <col>hi</col>\n  </row>\n</box>";
		let mut buffer = EditBuffer::new("");
		assert_eq!(buffer.insert_text(document), BufferOutcome::Changed);
		assert_eq!(buffer.text(), document);
	}

	fn key(key: Key) -> Key {
		key
	}

	/// Small palette with enough shape for ranking-sensitive expectations.
	fn palette() -> Vec<Command> {
		vec![
			Command::new("security", "Plan, run, inspect, and compare security scans", &[])
				.with_args(&[
					("plan", "Draft a scan plan", ""),
					("import", "Import an external report", "<path>"),
					("compare", "Diff two runs", "<run-a> <run-b>"),
				])
				.with_hint("plan|import|compare"),
			Command::new("settings", "Open settings menu", &[]),
			Command::new("setup", "Open provider setup", &["providers"]),
		]
	}

	fn editor() -> Editor {
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(SlashCommands::new(palette())));
		editor
	}

	fn type_text(editor: &mut Editor, text: &str) {
		for character in text.chars() {
			assert_eq!(editor.handle_key(key(Key::Char(character))), EditOutcome::Changed);
		}
	}

	#[test]
	fn command_picker_navigates_and_inserts_a_trailing_space() {
		let mut editor = editor();
		type_text(&mut editor, "/");
		assert_eq!(editor.handle_key(key(Key::Down)), EditOutcome::Changed);
		assert_eq!(editor.handle_key(key(Key::Tab)), EditOutcome::Changed);
		assert_eq!(editor.text(), "/settings ");
	}

	#[test]
	fn right_arrow_at_logical_line_end_accepts_the_selected_completion() {
		let mut editor = editor();
		type_text(&mut editor, "/se");
		assert_eq!(editor.handle_key(Key::Right), EditOutcome::Changed);
		assert_eq!(editor.text(), "/security ");
	}

	#[test]
	fn emoji_popup_stays_suppressed_inside_recognized_slash_arguments() {
		let mut editor = editor();
		type_text(&mut editor, "/security :joy");
		assert!(editor.picker().is_none());
		editor.set_text("prose :joy");
		assert!(editor.picker().is_some());
	}

	#[test]
	fn replacement_picker_replaces_the_word_under_the_cursor() {
		let mut editor = Editor::new(EditorOptions::default());
		editor.replace_external("teh", true);
		assert_eq!(editor.handle_key(Key::Right), EditOutcome::Changed);
		assert!(editor.show_replacements(0..3, [Str::new("the")]));
		assert_eq!(editor.handle_key(Key::Enter), EditOutcome::Changed);
		assert_eq!(editor.text(), "the");
	}

	#[test]
	fn replacement_picker_preserves_caret_after_trailing_boundary() {
		let mut editor = Editor::new(EditorOptions::default());
		editor.replace_external("teh ", false);
		assert!(editor.show_replacements(0..3, [Str::new("the")]));
		assert_eq!(editor.handle_key(Key::Tab), EditOutcome::Changed);
		assert_eq!(editor.text(), "the ");
		assert_eq!(editor.buffer().cursor(), 4);
	}

	#[test]
	fn completion_replaces_text_after_the_cursor() {
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(AtNames));
		type_text(&mut editor, "@alicex");
		assert_eq!(editor.handle_key(Key::Left), EditOutcome::Changed);
		assert!(editor.picker().is_some(), "exact prefix reopens the picker");
		assert_eq!(editor.handle_key(Key::Enter), EditOutcome::Changed);
		assert_eq!(editor.text(), "@alice ");
	}

	/// Engine claiming a range that no longer contains the cursor (stale
	/// async rows): the dropdown must stay open on the clamped span.
	#[test]
	fn degenerate_completion_range_is_clamped_not_hidden() {
		struct StaleRange;
		impl EditorCompletion for StaleRange {
			fn suggest(&mut self, text: &str, _cursor: usize) -> Option<Suggestions> {
				(!text.is_empty()).then(|| Suggestions {
					range: 0..0,
					items: [Suggestion::new("value", "value")].into_iter().collect(),
				})
			}
		}
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(StaleRange));
		type_text(&mut editor, "ab");
		assert!(editor.picker().is_some(), "degenerate range keeps the dropdown open");
		assert_eq!(editor.handle_key(Key::Enter), EditOutcome::Changed);
		assert!(editor.text().starts_with("value"), "{}", editor.text());
	}

	#[test]
	fn stale_async_picker_snapshot_never_overwrites_a_newer_buffer_or_caret() {
		let mut editor = editor();
		type_text(&mut editor, "/se");
		assert!(editor.picker().is_some());
		// Model an async request that completed for `/se` while an input
		// mutation advanced without installing a replacement result.
		editor.buffer.replace_external("keep this", true);
		assert_eq!(editor.handle_key(Key::Tab), EditOutcome::Changed);
		assert_eq!(editor.text(), "keep this");
		assert_eq!(editor.buffer.cursor(), 0);

		// An ABA query can have the same text and caret as an old result.
		// Generation identity still prevents that result being accepted.
		editor.set_text("/se");
		let stale = editor.picker.take().expect("matching picker");
		editor.set_text("other");
		editor.set_text("/se");
		editor.picker = Some(stale);
		assert_eq!(editor.handle_key(Key::Enter), EditOutcome::Changed);
		assert_eq!(editor.text(), "/se");
		assert_eq!(editor.buffer.cursor(), 3);
	}

	/// A `#N` chip marker looks like a `#<number>` reference trigger, but the
	/// engine's range would tear the atom on accept: no dropdown opens over
	/// it, and the same key still removes the whole chip.
	#[test]
	fn completion_never_opens_over_an_atomic_marker() {
		struct HashRefs;
		impl EditorCompletion for HashRefs {
			fn suggest(&mut self, text: &str, cursor: usize) -> Option<Suggestions> {
				let hash = text[..cursor].rfind('#')?;
				let digits = &text[hash + 1..cursor];
				(!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| {
					Suggestions {
						range: hash..cursor,
						items: [Suggestion::new("pr://1 ", "pr #1")].into_iter().collect(),
					}
				})
			}
		}
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(HashRefs));
		let chip = "\u{f15c} #1";
		editor.insert_reference_group(&[(chip.to_owned(), "payload".to_owned())], " ");
		assert_eq!(editor.text(), format!("{chip} "));
		assert_eq!(editor.handle_key(Key::Backspace), EditOutcome::Changed);
		assert_eq!(editor.text(), chip);
		assert!(editor.picker().is_none(), "the chip's `#1` is not a reference token");
		assert_eq!(editor.handle_key(Key::Backspace), EditOutcome::Changed);
		assert_eq!(editor.text(), "");
		// Ordinary text after the chip still completes.
		editor.insert_reference_group(&[(chip.to_owned(), "payload".to_owned())], " ");
		type_text(&mut editor, "#2");
		assert!(editor.picker().is_some(), "a typed reference after the chip completes");
	}

	#[test]
	fn command_frequency_breaks_equal_text_score_ties() {
		let mut usage = HashMap::new();
		usage.insert("settings", 4_u64);
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(
			SlashCommands::new(palette())
				.with_usage(move |name| usage.get(name).copied().unwrap_or(0)),
		));
		type_text(&mut editor, "/se");
		let picker = editor.picker().expect("command candidates open");
		assert_eq!(picker.suggestions[picker.selected].value(), "/settings ");
	}

	#[test]
	fn skill_namespace_collapses_then_chains_to_individual_skills() {
		let commands = vec![
			Command::new("settings", "Open settings", &[]),
			Command::new("skill:review", "Review code", &[]).with_icon(Icon::Skill),
			Command::new("skill:test", "Run focused tests", &[]).with_icon(Icon::Skill),
		];
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(SlashCommands::new(commands)));
		type_text(&mut editor, "/");
		let picker = editor.picker().expect("namespace candidates open");
		assert!(
			picker
				.suggestions
				.iter()
				.any(|item| item.value() == "/skill:"),
			"collapsed namespace is offered"
		);
		assert!(
			picker
				.suggestions
				.iter()
				.all(|item| !item.value().starts_with("/skill:") || item.value() == "/skill:"),
			"individual skills stay collapsed"
		);

		type_text(&mut editor, "skill:");
		let picker = editor.picker().expect("skill candidates expand");
		assert_eq!(
			picker
				.suggestions
				.iter()
				.map(|item| item.value().as_str())
				.collect::<Vec<_>>(),
			["/skill:review ", "/skill:test "]
		);
		assert!(
			picker
				.suggestions
				.iter()
				.all(|item| item.icon() == Some(Icon::Skill))
		);
	}

	#[test]
	fn accepting_skill_namespace_reopens_completion_without_a_space() {
		let commands = vec![Command::new("skill:review", "Review code", &[])];
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(SlashCommands::new(commands)));
		type_text(&mut editor, "/");
		assert_eq!(editor.handle_key(Key::Enter), EditOutcome::Changed);
		assert_eq!(editor.text(), "/skill:");
		assert_eq!(editor.picker().expect("skill candidates reopen").len(), 1);
	}

	#[test]
	fn bare_skill_prefix_breaks_out_above_fuzzy_commands() {
		let commands = vec![
			Command::new("skill:batch", "Run batch workflows", &[]),
			Command::new("skill:reviewer", "Review code", &[]),
			Command::new("run-batch", "Run a saved batch job", &[]),
		];
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(SlashCommands::new(commands)));
		type_text(&mut editor, "/batch");
		assert_eq!(
			editor
				.picker()
				.expect("bare skill prefix opens")
				.suggestions
				.iter()
				.map(|suggestion| suggestion.value().as_str())
				.collect::<Vec<_>>(),
			["/skill:batch ", "/run-batch "],
		);
	}

	#[test]
	fn bare_skill_prefix_alias_tie_keeps_command_only() {
		let commands = vec![
			Command::new("skill:setup-ci", "Bootstrap CI pipelines", &[]),
			Command::new("configure", "Open settings", &["settings"]),
		];
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(SlashCommands::new(commands)));
		type_text(&mut editor, "/set");
		let picker = editor.picker().expect("command prefix opens");
		assert_eq!(picker.suggestions.len(), 1);
		assert_eq!(picker.suggestions[0].value(), "/settings ");
	}

	#[test]
	fn exact_bare_skill_breaks_out_above_command_prefix() {
		let commands = vec![
			Command::new("skill:set", "Set tracked values", &[]),
			Command::new("settings", "Open settings", &[]),
		];
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(SlashCommands::new(commands)));
		type_text(&mut editor, "/set");
		assert_eq!(
			editor
				.picker()
				.expect("exact skill opens")
				.suggestions
				.iter()
				.map(|suggestion| suggestion.value().as_str())
				.collect::<Vec<_>>(),
			["/skill:set ", "/settings "],
		);
	}

	#[test]
	fn fuzzy_only_bare_skill_does_not_break_out() {
		let commands = vec![Command::new("skill:humanizer", "Remove signs of AI writing", &[])];
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(SlashCommands::new(commands)));
		type_text(&mut editor, "/hmz");
		assert!(editor.picker().is_none());
	}

	#[test]
	fn command_picker_defaults_to_ten_visible_suggestions() {
		let commands = (0..12)
			.map(|index| Command::new(&format!("command-{index}"), "command", &[]))
			.collect::<Vec<_>>();
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(SlashCommands::new(commands)));
		type_text(&mut editor, "/");
		assert_eq!(
			editor
				.picker()
				.expect("command candidates open")
				.visible_suggestions()
				.1
				.len(),
			10
		);
	}

	#[test]
	fn enter_submits_a_command_straight_from_the_name_picker() {
		let mut editor = editor();
		type_text(&mut editor, "/settings");
		assert!(editor.picker().is_some());
		assert_eq!(
			editor.handle_key(key(Key::Enter)),
			EditOutcome::Submitted("/settings ".to_owned())
		);
	}

	#[test]
	fn enter_submits_a_bare_command_that_takes_optional_arguments() {
		let mut editor = editor();
		type_text(&mut editor, "/security");
		assert!(editor.picker().is_some());
		assert_eq!(
			editor.handle_key(key(Key::Enter)),
			EditOutcome::Submitted("/security ".to_owned())
		);
	}

	#[test]
	fn exact_argument_enter_accepts_once_then_submits() {
		let mut editor = editor();
		type_text(&mut editor, "/security plan");
		assert!(editor.picker().is_some());
		assert_eq!(editor.handle_key(key(Key::Enter)), EditOutcome::Changed);
		assert_eq!(editor.text(), "/security plan ");
		assert!(editor.picker().is_none());
		assert_eq!(
			editor.handle_key(key(Key::Enter)),
			EditOutcome::Submitted("/security plan ".to_owned())
		);
	}

	#[test]
	fn options_gate_emoji_history_and_xml() {
		// no completion registered: `/` never opens a dropdown
		let mut editor = Editor::new(EditorOptions::default());
		type_text(&mut editor, "/se");
		assert!(editor.picker().is_none(), "no completion registered");
		assert!(editor.inline_hint().is_none());

		let mut editor = Editor::new(EditorOptions { emoji: false, ..EditorOptions::default() });
		type_text(&mut editor, ":joy");
		assert!(editor.picker().is_none(), "emoji dropdown disabled");
		type_text(&mut editor, ": ");
		assert_eq!(editor.text(), ":joy: ", "shortcode expansion disabled");

		let mut editor = Editor::new(EditorOptions { history: false, ..EditorOptions::default() });
		type_text(&mut editor, "one");
		assert_eq!(editor.handle(Key::Enter), EditOutcome::Submitted("one".into()));
		assert_eq!(editor.handle(Key::Up), EditOutcome::Ignored, "history disabled");

		let mut editor = Editor::new(EditorOptions { xml: false, ..EditorOptions::default() });
		type_text(&mut editor, "<a></");
		assert_eq!(editor.text(), "<a></", "close-tag completion disabled");
	}

	#[test]
	fn argument_completion_inside_a_slash_command() {
		let mut editor = editor();
		type_text(&mut editor, "/security i");
		let picker = editor.picker().expect("argument candidates open");
		assert_eq!(
			*picker.suggestions[picker.selected].display(),
			SuggestionDisplay::Text("import".into())
		);
		assert_eq!(editor.handle_key(key(Key::Enter)), EditOutcome::Changed);
		assert_eq!(editor.text(), "/security import ");
		// second word is free-form: no picker re-opens
		assert!(editor.picker().is_none());
	}

	#[test]
	fn colon_delimiter_opens_subcommand_completion() {
		let mut editor = editor();
		type_text(&mut editor, "/security:im");
		let picker = editor.picker().expect("colon argument candidates open");
		assert_eq!(
			*picker.suggestions[picker.selected].display(),
			SuggestionDisplay::Text("import".into())
		);
		assert_eq!(editor.inline_hint().as_deref(), Some("port <path>"));
	}

	#[test]
	fn inline_hint_follows_selection_arguments_and_usage() {
		let mut editor = editor();
		type_text(&mut editor, "/sec");
		assert_eq!(editor.inline_hint().as_deref(), Some("plan|import|compare"));
		assert_eq!(editor.handle_key(key(Key::Tab)), EditOutcome::Changed);
		assert_eq!(editor.text(), "/security ");
		// bare `/name ` ghosts the command usage, picker open or not
		assert_eq!(editor.inline_hint().as_deref(), Some("plan|import|compare"));
		// typing an argument prefix ghosts the remaining name + its usage
		type_text(&mut editor, "im");
		assert_eq!(editor.inline_hint().as_deref(), Some("port <path>"));
		// accepting the argument ghosts its remaining usage
		assert_eq!(editor.handle_key(key(Key::Enter)), EditOutcome::Changed);
		assert_eq!(editor.text(), "/security import ");
		assert_eq!(editor.inline_hint().as_deref(), Some("<path>"));
		// usage words already typed stop ghosting
		type_text(&mut editor, "report.json");
		assert_eq!(editor.inline_hint(), None);
		// Multi-word usages ghost only the remainder; whole and in-progress
		// words count alike.
		let mut compare = make_editor();
		type_text(&mut compare, "/security compare one");
		assert_eq!(compare.inline_hint().as_deref(), Some("<run-b>"));
		type_text(&mut compare, " two");
		assert_eq!(compare.inline_hint(), None, "usage fully consumed");
	}

	#[test]
	fn emoji_picker_and_shortcode_use_the_same_dataset() {
		let mut picker_editor = editor();
		type_text(&mut picker_editor, ":joy");
		let picker = picker_editor.picker().expect("joy opens the picker");
		assert_eq!(*picker.suggestions[picker.selected].display(), SuggestionDisplay::Emoji {
			emoji:     "😂",
			shortcode: "joy",
		});
		assert_eq!(picker_editor.handle_key(key(Key::Enter)), EditOutcome::Changed);
		assert_eq!(picker_editor.text(), "😂");

		let mut shortcode_editor = editor();
		type_text(&mut shortcode_editor, ":joy:");
		assert_eq!(shortcode_editor.text(), "😂");
	}

	#[test]
	fn emoticon_replacement_is_unicode_boundary_safe() {
		let mut editor = editor();
		type_text(&mut editor, "é:) ");
		assert_eq!(editor.text(), "é:) ");
	}

	#[test]
	fn submit_expands_a_complete_emoticon_without_a_trailing_space() {
		let mut editor = editor();
		type_text(&mut editor, "hello :)");
		assert_eq!(editor.handle_key(Key::Enter), EditOutcome::Submitted("hello 🙂".to_owned()));
	}

	#[test]
	fn cursor_navigation_and_backspace_preserve_graphemes() {
		let mut editor = editor();
		type_text(&mut editor, "a👩‍💻b");
		assert_eq!(editor.handle_key(key(Key::Left)), EditOutcome::Changed);
		assert_eq!(editor.handle_key(key(Key::Backspace)), EditOutcome::Changed);
		assert_eq!(editor.text(), "ab");
	}

	#[test]
	fn shift_enter_adds_lines_and_vertical_navigation_preserves_column() {
		let mut editor = editor();
		type_text(&mut editor, "first");
		assert_eq!(editor.handle_key(Key::ShiftEnter), EditOutcome::Changed);
		type_text(&mut editor, "second");

		assert_eq!(editor.text(), "first\nsecond");
		assert_eq!(editor.input_height(), 2);
		{
			let rows = editor.view(20);
			assert_eq!(rows.iter().map(|row| row.text).collect::<Vec<_>>(), ["first", "second"]);
			assert_eq!(rows[0].cursor_column, None);
			assert_eq!(rows[1].cursor_column, Some(6));
		}

		assert_eq!(editor.handle_key(key(Key::Up)), EditOutcome::Changed);
		assert_eq!(editor.view(20)[0].cursor_column, Some(5));
		assert_eq!(editor.handle_key(key(Key::Down)), EditOutcome::Changed);
		assert_eq!(editor.view(20)[1].cursor_column, Some(6));

		assert_eq!(
			editor.handle_key(key(Key::Enter)),
			EditOutcome::Submitted("first\nsecond".to_owned())
		);
	}

	#[test]
	fn slash_commands_complete_at_the_start_of_later_lines() {
		let mut editor = editor();
		type_text(&mut editor, "context");
		editor.handle_key(Key::ShiftEnter);
		type_text(&mut editor, "/set");

		assert!(editor.picker().is_some());
		assert_eq!(editor.handle_key(key(Key::Enter)), EditOutcome::Changed);
		assert_eq!(editor.text(), "context\n/settings ");
	}

	#[test]
	fn control_a_e_and_u_are_scoped_to_logical_lines() {
		let mut editor = editor();
		assert_eq!(editor.insert_text("one\ntwo"), EditOutcome::Changed);
		assert_eq!(editor.handle_key(Key::Ctrl('a')), EditOutcome::Changed);
		assert_eq!(editor.buffer.cursor(), 4);
		assert_eq!(editor.handle_key(Key::Ctrl('e')), EditOutcome::Changed);
		assert_eq!(editor.buffer.cursor(), 7);
		// Ctrl-U kills only to this line's start, rather than clearing the document.
		assert_eq!(editor.handle_key(Key::Ctrl('u')), EditOutcome::Changed);
		assert_eq!(editor.text(), "one\n");
		assert_eq!(editor.handle_key(Key::Ctrl('u')), EditOutcome::Changed);
		assert_eq!(editor.text(), "one");
	}

	#[test]
	fn word_motion_keeps_apostrophes_and_hyphens_inside_words() {
		let mut editor = editor();
		editor.insert_text("don't foo-bar");
		assert_eq!(editor.handle(Key::WordLeft), EditOutcome::Changed);
		assert_eq!(editor.buffer.cursor(), 6);
		assert_eq!(editor.handle(Key::WordLeft), EditOutcome::Changed);
		assert_eq!(editor.buffer.cursor(), 0);
		assert_eq!(editor.handle(Key::WordRight), EditOutcome::Changed);
		assert_eq!(editor.buffer.cursor(), 5);
	}

	#[test]
	fn word_motion_matches_pi_unicode_coarse_blocks() {
		let text = "你好，世界\u{a0}foo‑bar «привет»";
		let mut buffer = EditBuffer::new(text);
		for expected in [
			text.rfind('»').expect("closing quote"),
			text.find('п').expect("Russian word"),
			text.find('«').expect("opening quote"),
			text.find('f').expect("joined Latin word"),
			text.find('世').expect("second CJK block"),
			text.find('，').expect("Unicode delimiter"),
			0,
		] {
			assert_eq!(buffer.handle(Key::WordLeft, 80, 10), BufferOutcome::Changed);
			assert_eq!(buffer.cursor(), expected);
		}

		assert_eq!(buffer.handle(Key::WordRight, 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), text.find('，').expect("after first CJK block"));
		assert_eq!(buffer.handle(Key::WordRight, 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), text.find('，').expect("delimiter") + '，'.len_utf8());
		assert_eq!(buffer.handle(Key::WordRight, 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), text.find('\u{a0}').expect("after second CJK block"));
	}

	#[test]
	fn word_deletes_merge_logical_lines() {
		let mut editor = editor();
		editor.insert_text("first\nsecond");
		editor.handle(Key::Ctrl('a'));
		assert_eq!(editor.handle(Key::Ctrl('w')), EditOutcome::Changed);
		assert_eq!(editor.text(), "firstsecond");

		let mut forward = make_editor();
		forward.insert_text("first\nsecond");
		forward.buffer.set_cursor_line_column(0, 5);
		assert_eq!(forward.handle(Key::WordDelete), EditOutcome::Changed);
		assert_eq!(forward.text(), "firstsecond");
	}

	#[test]
	fn paste_normalizes_newlines_controls_and_unicode_composition() {
		let mut editor = editor();
		assert_eq!(editor.insert_text("a\r\nb\u{0007}e\u{301}"), EditOutcome::Changed);
		assert_eq!(editor.text(), "a\nbé");
	}

	#[test]
	fn vertical_motion_snaps_at_document_boundaries_before_ignoring() {
		let mut editor = editor();
		editor.insert_text("abc");
		assert_eq!(editor.handle(Key::Up), EditOutcome::Changed);
		assert_eq!(editor.buffer.cursor(), 0);
		assert_eq!(editor.handle(Key::Up), EditOutcome::Ignored);
		assert_eq!(editor.handle(Key::Down), EditOutcome::Changed);
		assert_eq!(editor.buffer.cursor(), 3);
		assert_eq!(editor.handle(Key::Down), EditOutcome::Ignored);
	}

	#[test]
	fn kill_ring_accumulates_yanks_and_cycles_older_entries() {
		let mut editor = editor();
		type_text(&mut editor, "alpha beta gamma");
		editor.handle(Key::Ctrl('w'));
		editor.handle(Key::Ctrl('w'));
		assert_eq!(editor.handle(Key::Ctrl('y')), EditOutcome::Changed);
		assert_eq!(editor.text(), "alpha beta gamma");
		editor.handle(Key::Space);
		type_text(&mut editor, "older");
		editor.handle(Key::Ctrl('w'));
		assert_eq!(editor.handle(Key::Ctrl('y')), EditOutcome::Changed);
		assert_eq!(editor.handle(Key::Alt('y')), EditOutcome::Changed);
		assert!(editor.text().ends_with("beta gamma"));
	}

	#[test]
	fn kill_and_yank_preserve_atomic_reference_identity() {
		let mut buffer = EditBuffer::new("prefix ");
		buffer.insert_reference("[chip]", "<attachment/>");
		assert_eq!(buffer.handle(Key::Ctrl('w'), 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "prefix ");
		assert!(buffer.atom_ranges().is_empty());

		assert_eq!(buffer.handle(Key::Ctrl('y'), 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "prefix [chip]");
		assert_eq!(buffer.atom_ranges().as_slice(), &[(7, 13)]);
		assert_eq!(buffer.expanded_text(), "prefix <attachment/>");

		assert_eq!(buffer.handle(Key::Backspace, 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "prefix ");
	}

	#[test]
	fn backward_kill_accumulation_keeps_reference_offsets() {
		let mut buffer = EditBuffer::new("");
		buffer.insert_reference("[one]", "<one/>");
		buffer.insert_text(" tail");
		buffer.handle(Key::Ctrl('w'), 80, 10);
		buffer.handle(Key::Ctrl('w'), 80, 10);
		assert_eq!(buffer.handle(Key::Ctrl('y'), 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "[one] tail");
		assert_eq!(buffer.atom_ranges().as_slice(), &[(0, 5)]);
		assert_eq!(buffer.expanded_text(), "<one/> tail");
	}

	#[test]
	fn yank_pop_restores_atoms_from_an_older_kill_entry() {
		let mut buffer = EditBuffer::new("");
		buffer.insert_reference("[one]", "<one/>");
		buffer.handle(Key::Ctrl('w'), 80, 10);
		buffer.insert_text("plain");
		buffer.handle(Key::Ctrl('w'), 80, 10);

		buffer.handle(Key::Ctrl('y'), 80, 10);
		assert_eq!(buffer.text(), "plain");
		assert_eq!(buffer.handle(Key::Alt('y'), 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "[one]");
		assert_eq!(buffer.atom_ranges().as_slice(), &[(0, 5)]);
		assert_eq!(buffer.expanded_text(), "<one/>");
	}

	#[test]
	fn undo_coalesces_non_whitespace_typing_and_splits_at_spaces() {
		let mut editor = editor();
		type_text(&mut editor, "abc.def ghi");
		assert_eq!(editor.handle(Key::Ctrl('-')), EditOutcome::Changed);
		assert_eq!(editor.text(), "abc.def ");
		assert_eq!(editor.handle(Key::Ctrl('_')), EditOutcome::Changed);
		assert_eq!(editor.text(), "abc.def");
		assert_eq!(editor.handle(Key::Ctrl('-')), EditOutcome::Changed);
		assert_eq!(editor.text(), "");
	}

	#[test]
	fn history_deduplicates_navigates_and_restores_the_draft() {
		let mut editor = editor();
		type_text(&mut editor, "one");
		assert_eq!(editor.handle(Key::Enter), EditOutcome::Submitted("one".into()));
		type_text(&mut editor, "two");
		assert_eq!(editor.handle(Key::Enter), EditOutcome::Submitted("two".into()));
		type_text(&mut editor, "one");
		editor.handle(Key::Enter);
		assert_eq!(editor.history.len(), 2);
		assert_eq!(editor.handle(Key::Up), EditOutcome::Changed);
		assert_eq!(editor.text(), "one");
		assert_eq!(editor.handle(Key::Up), EditOutcome::Changed);
		assert_eq!(editor.text(), "two");
		editor.history_draft = "draft".into();
		editor.handle(Key::End);
		assert_eq!(editor.handle(Key::Down), EditOutcome::Changed);
		assert_eq!(editor.handle(Key::Down), EditOutcome::Changed);
		assert_eq!(editor.text(), "draft");
	}

	#[test]
	fn host_recorded_and_seeded_history_drives_up_down_navigation() {
		// The host records what it actually sent; a resumed session seeds
		// newest-first.
		let mut editor = editor();
		assert!(!editor.history_navigates(Key::Up), "nothing recorded yet");
		editor.seed_history(["older".into(), "  ".into(), "newest".into(), "older".into()]);
		assert_eq!(editor.history, vec![Str::new_static("older"), Str::new_static("newest")]);
		editor.add_to_history("  older ");
		assert_eq!(editor.history, vec![Str::new_static("older"), Str::new_static("newest")]);
		editor.add_to_history("");
		assert_eq!(editor.history.len(), 2);
		assert!(editor.history_navigates(Key::Up));
		assert!(!editor.history_navigates(Key::Down), "not browsing yet");
		assert_eq!(editor.handle(Key::Up), EditOutcome::Changed);
		assert_eq!(editor.text(), "older");
		assert!(editor.history_navigates(Key::Up));
		editor.handle(Key::End);
		assert!(editor.history_navigates(Key::Down));
		assert_eq!(editor.handle(Key::Down), EditOutcome::Changed);
		assert_eq!(editor.text(), "");
		// A non-empty draft owns Up unless the editor is already browsing.
		type_text(&mut editor, "draft");
		editor.handle(Key::Home);
		assert!(!editor.history_navigates(Key::Up));
		// The host replacing the draft leaves browsing mode.
		editor.set_text("");
		editor.handle(Key::Up);
		assert_eq!(editor.text(), "older");
		assert_eq!(editor.history_index, Some(0));
		editor.set_text("");
		assert!(editor.history_index.is_none());
		assert_eq!(editor.handle(Key::Up), EditOutcome::Changed);
		assert_eq!(editor.text(), "older", "Up restarts from the newest entry");
		// A recalled `/command` never opens the dropdown, so the next Down
		// steps history, not rows.
		editor.set_text("");
		editor.add_to_history("/settings");
		assert_eq!(editor.handle(Key::Up), EditOutcome::Changed);
		assert_eq!(editor.text(), "/settings");
		assert!(editor.picker().is_none(), "recall keeps the popup closed");
		editor.handle(Key::End);
		assert_eq!(editor.handle(Key::Down), EditOutcome::Changed);
		assert_eq!(editor.text(), "");
	}

	#[test]
	fn ctrl_r_fuzzy_search_preserves_draft_and_walks_older_matches() {
		let mut editor = editor();
		for prompt in ["fix parser", "write docs", "parser tests"] {
			type_text(&mut editor, prompt);
			editor.handle(Key::Enter);
		}
		type_text(&mut editor, "prs");
		assert_eq!(editor.handle(Key::Ctrl('r')), EditOutcome::Changed);
		assert_eq!(editor.text(), "parser tests");
		assert_eq!(editor.handle(Key::Ctrl('r')), EditOutcome::Changed);
		assert_eq!(editor.text(), "fix parser");
		editor.handle(Key::End);
		assert_eq!(editor.handle(Key::Down), EditOutcome::Changed);
		assert_eq!(editor.text(), "parser tests");
		editor.handle(Key::End);
		assert_eq!(editor.handle(Key::Down), EditOutcome::Changed);
		assert_eq!(editor.text(), "prs");
	}

	#[test]
	fn reference_markers_are_atomic_for_every_delete_and_expand_on_submit() {
		let payload = (0..12)
			.map(|n| format!("line{n}"))
			.collect::<Vec<_>>()
			.join("\n");
		for key in [
			Key::Backspace,
			Key::Delete,
			Key::Ctrl('w'),
			Key::WordDelete,
			Key::Ctrl('k'),
			Key::Ctrl('u'),
		] {
			let mut editor = editor();
			editor.insert_reference("txt #1", &payload);
			assert_eq!(editor.text(), "txt #1");
			if matches!(key, Key::Delete | Key::WordDelete | Key::Ctrl('k')) {
				editor.buffer.set_cursor_line_column(0, 0);
			}
			assert_eq!(editor.handle(key), EditOutcome::Changed);
			assert_eq!(editor.text(), "", "{key:?}");
		}
		let mut editor = editor();
		editor.insert_reference("txt #1", &payload);
		assert_eq!(editor.handle(Key::Enter), EditOutcome::Submitted(payload));
	}

	#[test]
	fn reference_groups_are_one_undoable_drop_action() {
		let mut editor = editor();
		let references = [
			("[one]".to_owned(), "<ref one/>".to_owned()),
			("[two]".to_owned(), "<ref two/>".to_owned()),
		];
		assert_eq!(editor.insert_reference_group(&references, " "), EditOutcome::Changed);
		assert_eq!(editor.text(), "[one] [two] ");
		assert_eq!(
			editor.handle(Key::Enter),
			EditOutcome::Submitted("<ref one/> <ref two/> ".into())
		);

		let mut editor = self::editor();
		editor.insert_reference_group(&references, " ");
		assert_eq!(editor.handle(Key::Ctrl('-')), EditOutcome::Changed);
		assert_eq!(editor.text(), "");
		assert!(editor.atom_ranges().is_empty());
	}

	#[test]
	fn references_are_positional_atoms_immune_to_lookalike_text() {
		let mut editor = editor();
		assert_eq!(editor.insert_reference("* #1", "<ref image=1/>"), EditOutcome::Changed);
		type_text(&mut editor, " hi ");
		editor.insert_text("* #1");
		assert_eq!(editor.text(), "* #1 hi * #1");
		assert_eq!(
			editor.atom_ranges().as_slice(),
			&[(0, 4)],
			"typed lookalike text never becomes an atom"
		);
		assert_eq!(
			editor.handle(Key::Enter),
			EditOutcome::Submitted("<ref image=1/> hi * #1".into()),
			"only the real reference expands"
		);
	}

	#[test]
	fn reference_markers_delete_atomically_and_undo_restores_them() {
		let mut editor = editor();
		editor.insert_reference("* #1", "<ref image=1/>");
		assert_eq!(editor.handle(Key::Backspace), EditOutcome::Changed);
		assert_eq!(editor.text(), "");
		assert!(editor.atom_ranges().is_empty());
		assert_eq!(editor.handle(Key::Ctrl('_')), EditOutcome::Changed);
		assert_eq!(editor.text(), "* #1");
		assert_eq!(
			editor.atom_ranges().as_slice(),
			&[(0, 4)],
			"undo restores the atom, not just its text"
		);
	}

	#[test]
	fn reference_markers_are_single_units_for_caret_and_selection_motion() {
		let mut buffer = EditBuffer::new("a");
		buffer.insert_reference("[chip]", "<ref/>");
		buffer.insert_text("z");
		buffer.set_cursor_line_column(0, 1);
		assert_eq!(buffer.handle(Key::Right, 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), 7);
		assert_eq!(buffer.handle(Key::Left, 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), 1);
		assert_eq!(buffer.handle(Key::SelectRight, 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.selection(), Some(1..7));
		assert_eq!(buffer.selected_text(), Some("[chip]"));
	}

	#[test]
	fn partial_replacements_widen_to_whole_reference_markers() {
		let mut torn = editor();
		type_text(&mut torn, "ab");
		torn.insert_reference("* #1", "<ref image=1/>");
		type_text(&mut torn, "cd");
		// Overlap the marker's first byte only: the whole unit must go.
		torn.buffer.replace_range(1..3, "X");
		assert_eq!(torn.text(), "aXcd");
		assert!(torn.atom_ranges().is_empty(), "torn atom is dropped whole");
		// Insertions at the marker boundary leave the unit intact.
		let mut fresh = editor();
		fresh.insert_reference("* #1", "<ref image=1/>");
		fresh.buffer.replace_range(0..0, ">");
		assert_eq!(fresh.text(), ">* #1");
		assert_eq!(fresh.atom_ranges().as_slice(), &[(1, 5)]);
	}

	#[test]
	fn character_jump_moves_forward_and_backward() {
		let mut editor = editor();
		editor.insert_text("abacad");
		editor.buffer.set_cursor_line_column(0, 0);
		editor.handle(Key::Ctrl(']'));
		editor.handle(Key::Char('a'));
		assert_eq!(editor.buffer.cursor(), 2);
		editor.handle(Key::CtrlAlt(']'));
		editor.handle(Key::Char('a'));
		assert_eq!(editor.buffer.cursor(), 0);
	}

	#[test]
	fn character_jump_crosses_lines_and_never_lands_inside_an_atom() {
		let mut buffer = EditBuffer::new("a\n");
		buffer.insert_reference("[chip]", "<ref/>");
		buffer.insert_text("\nz");
		buffer.set_cursor_line_column(0, 0);
		buffer.handle(Key::Ctrl(']'), 80, 10);
		assert_eq!(buffer.handle(Key::Char('h'), 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), 8, "forward jump snaps to the atom's far edge");

		buffer.handle(Key::CtrlAlt(']'), 80, 10);
		assert_eq!(buffer.handle(Key::Char('c'), 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), 2, "backward jump snaps to the atom's near edge");
	}

	#[test]
	fn line_message_and_selection_motions_use_distinct_boundaries() {
		let mut buffer = EditBuffer::new("one\ntwo\nthree");
		buffer.set_cursor_line_column(1, 1);
		assert_eq!(buffer.handle(Key::SelectEnd, 80, 10), BufferOutcome::Changed);
		assert_eq!(buffer.selected_text(), Some("wo"));
		assert_eq!(buffer.handle(Key::Home, 80, 10), BufferOutcome::Changed);
		assert_eq!((buffer.cursor_line(), buffer.cursor_column()), (1, 1));
		assert_eq!(buffer.handle(Key::Home, 80, 10), BufferOutcome::Changed);
		assert_eq!((buffer.cursor_line(), buffer.cursor_column()), (1, 0));
		assert_eq!(buffer.move_to_message_edge(false), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), 0);
		assert_eq!(buffer.move_to_message_edge(true), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), buffer.text().len());
	}

	#[test]
	fn page_motion_uses_visible_rows_and_keeps_sticky_column() {
		let mut editor = editor();
		editor.insert_text("abcd\nx\nabcd\nx\nabcd\nx\nabcd\nx\nabcd");
		editor.buffer.set_cursor_line_column(0, 3);
		editor.handle(Key::PageDown);
		assert_eq!((editor.buffer.cursor_line(), editor.buffer.cursor_column()), (8, 3));
		editor.handle(Key::PageUp);
		assert_eq!((editor.buffer.cursor_line(), editor.buffer.cursor_column()), (0, 3));

		// The rendered viewport, not logical lines, controls the jump. With a
		// three-row viewport these wrapped rows move two at a time, preserving
		// the requested display column across the short logical line.
		editor.set_text("abcde\nx\nabcde\nx\nabcde");
		editor.buffer.set_cursor_line_column(0, 2);
		let _ = editor.view_rows(3, 3);
		editor.handle(Key::PageDown);
		assert_eq!((editor.buffer.cursor_line(), editor.buffer.cursor_column()), (1, 1));
		editor.handle(Key::PageDown);
		assert_eq!((editor.buffer.cursor_line(), editor.buffer.cursor_column()), (2, 5));

		// A viewport resize immediately changes the page distance.
		let _ = editor.view_rows(3, 2);
		editor.handle(Key::PageUp);
		assert_eq!((editor.buffer.cursor_line(), editor.buffer.cursor_column()), (2, 2));

		// A display column that falls inside a wide grapheme snaps to a valid
		// boundary without losing the sticky column on the following page.
		editor.set_text("ab\nx\ne\u{301}界z\nx\nab");
		editor.buffer.set_cursor_line_column(0, 2);
		let _ = editor.view_rows(20, 3);
		editor.handle(Key::PageDown);
		assert_eq!((editor.buffer.cursor_line(), editor.buffer.cursor_column()), (2, 1));
		assert_eq!(&editor.text()[..editor.buffer.cursor()], "ab\nx\né");
		editor.handle(Key::PageDown);
		assert_eq!((editor.buffer.cursor_line(), editor.buffer.cursor_column()), (4, 2));

		// Atomic markers may only be crossed as a whole. Landing inside one
		// chooses the motion-direction edge while retaining the requested
		// display column for the next page.
		editor.set_text("ab\nx\n");
		editor.insert_reference("[chip]", "<ref/>");
		editor.insert_text("z\nx\nab");
		editor.buffer.set_cursor_line_column(0, 1);
		let _ = editor.view_rows(20, 3);
		let (atom_start, atom_end) = editor.buffer.atom_ranges()[0];
		editor.handle(Key::PageDown);
		assert_eq!(editor.buffer.cursor(), atom_end);
		editor.handle(Key::PageDown);
		assert_eq!((editor.buffer.cursor_line(), editor.buffer.cursor_column()), (4, 1));
		editor.handle(Key::PageUp);
		assert_eq!(editor.buffer.cursor(), atom_start);
		editor.handle(Key::PageUp);
		assert_eq!((editor.buffer.cursor_line(), editor.buffer.cursor_column()), (0, 1));
	}

	#[test]
	fn page_motion_uses_the_rendered_viewport_minus_one_row() {
		let mut editor = editor();
		editor.insert_text("0\n1\n2\n3\n4\n5\n6");
		editor.buffer.set_cursor_line_column(0, 0);
		let _ = editor.view_rows(20, 4);
		assert_eq!(editor.handle(Key::PageDown), EditOutcome::Changed);
		assert_eq!(editor.buffer.cursor_line(), 3);
		assert_eq!(editor.handle(Key::PageUp), EditOutcome::Changed);
		assert_eq!(editor.buffer.cursor_line(), 0);
	}

	#[test]
	fn right_at_message_end_seeds_the_vertical_sticky_column() {
		let mut buffer = EditBuffer::new("abcd\nx\nabcd");
		buffer.set_cursor_line_column(2, 4);
		assert_eq!(buffer.handle(Key::Right, 80, 8), BufferOutcome::Ignored);
		assert_eq!(buffer.handle(Key::Up, 80, 8), BufferOutcome::Changed);
		assert_eq!((buffer.cursor_line(), buffer.cursor_column()), (1, 1));
		assert_eq!(buffer.handle(Key::Up, 80, 8), BufferOutcome::Changed);
		assert_eq!((buffer.cursor_line(), buffer.cursor_column()), (0, 4));
	}

	#[test]
	fn view_word_wraps_and_vertical_motion_uses_visual_rows() {
		let mut editor = editor();
		editor.insert_text("hello world");
		let rows = editor
			.view(7)
			.iter()
			.map(|row| row.text)
			.collect::<Vec<_>>();
		assert_eq!(rows, ["hello", "world"]);
		editor.buffer.set_cursor_line_column(0, 4);
		editor.handle(Key::Down);
		assert_eq!(editor.buffer.cursor(), 10);
		editor.handle(Key::Up);
		assert_eq!(editor.buffer.cursor(), 4);
	}

	#[test]
	fn wrapping_fills_wide_tokens_but_keeps_narrow_words_whole() {
		let wide = EditBuffer::new("word 一二三四五");
		assert_eq!(
			wide
				.rows(10, 8)
				.iter()
				.map(|row| row.text)
				.collect::<Vec<_>>(),
			["word 一二", "三四五"]
		);

		let mixed = EditBuffer::new("word 一a二b三c四d");
		assert_eq!(
			mixed
				.rows(10, 8)
				.iter()
				.map(|row| row.text)
				.collect::<Vec<_>>(),
			["word 一a二", "b三c四d"]
		);

		let narrow = EditBuffer::new("word über");
		assert_eq!(
			narrow
				.rows(8, 8)
				.iter()
				.map(|row| row.text)
				.collect::<Vec<_>>(),
			["word", "über"]
		);
	}

	#[test]
	fn wrapping_uses_remaining_width_before_splitting_a_long_token() {
		let buffer = EditBuffer::new("word abcdefghijklmnop");
		assert_eq!(
			buffer
				.rows(10, 8)
				.iter()
				.map(|row| row.text)
				.collect::<Vec<_>>(),
			["word abcde", "fghijklmno", "p"]
		);
	}

	#[test]
	fn wrap_hidden_whitespace_stays_addressable_and_rows_fit() {
		let mut buffer = EditBuffer::new("word     next");
		let rows = buffer.rows(6, 8);
		assert_eq!(rows.iter().map(|row| row.text).collect::<Vec<_>>(), ["word", "next"]);
		assert!(rows.iter().all(|row| cell_width(row.text) <= 6));
		drop(rows);

		buffer.set_cursor_line_column(0, 7);
		let rows = buffer.rows(6, 8);
		assert_eq!(rows[0].cursor_column, Some(4));
		assert_eq!(rows[1].cursor_column, None);
	}

	#[test]
	fn manual_scroll_detaches_until_the_next_edit_then_follows_the_caret() {
		let mut buffer = EditBuffer::new("0\n1\n2\n3\n4");
		assert_eq!(buffer.rows_with_metrics(20, 2).1, (3, 2, 5));
		assert!(buffer.scroll_rows(-2, 20, 2));
		assert_eq!(buffer.rows_with_metrics(20, 2).1, (1, 2, 5));

		assert_eq!(buffer.handle(Key::Char('x'), 20, 2), BufferOutcome::Changed);
		assert_eq!(buffer.rows_with_metrics(20, 2).1, (3, 2, 5));
		buffer.replace_external("a\nb\nc", false);
		assert_eq!(buffer.rows_with_metrics(20, 2).1, (1, 2, 3));
	}

	#[test]
	fn double_clicking_whitespace_selects_only_its_run() {
		let mut buffer = EditBuffer::new("one  two");
		buffer.select_word_visual_row(0, 3, 80);
		assert_eq!(buffer.selection(), Some(3..5));
		assert_eq!(buffer.selected_text(), Some("  "));
	}

	#[test]
	fn shift_motion_extends_and_plain_motion_collapses_selection() {
		let mut buffer = EditBuffer::new("abc");
		assert_eq!(buffer.handle(Key::SelectLeft, 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.handle(Key::SelectLeft, 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.selection(), Some(1..3));
		assert_eq!(buffer.selected_text(), Some("bc"));

		assert_eq!(buffer.handle(Key::Left, 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.cursor(), 1);
		assert_eq!(buffer.selection(), None);
	}

	#[test]
	fn typing_replaces_selection_in_one_undo_step() {
		let mut buffer = EditBuffer::new("abcd");
		buffer.handle(Key::SelectLeft, 80, 8);
		buffer.handle(Key::SelectLeft, 80, 8);
		assert_eq!(buffer.handle(Key::Char('X'), 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "abX");

		assert_eq!(buffer.handle(Key::Ctrl('_'), 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "abcd");
		assert_eq!(buffer.cursor(), 2);
		assert_eq!(buffer.handle(Key::Ctrl('_'), 80, 8), BufferOutcome::Ignored);
	}

	#[test]
	fn kill_commands_prefer_the_active_selection() {
		for key in [Key::Ctrl('u'), Key::Ctrl('k'), Key::Ctrl('w'), Key::WordDelete] {
			let mut buffer = EditBuffer::new("one two");
			buffer.handle(Key::SelectWordLeft, 80, 8);
			assert_eq!(buffer.handle(key, 80, 8), BufferOutcome::Changed);
			assert_eq!(buffer.text(), "one ", "{key:?}");
			assert_eq!(buffer.handle(Key::Ctrl('y'), 80, 8), BufferOutcome::Changed);
			assert_eq!(buffer.text(), "one two", "{key:?}");
		}
	}

	#[test]
	fn cut_deletes_and_yank_reinserts_selection() {
		let mut buffer = EditBuffer::new("one two");
		assert_eq!(buffer.handle(Key::SelectWordLeft, 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.selected_text(), Some("two"));
		assert_eq!(buffer.handle(Key::Cut, 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "one ");
		assert_eq!(buffer.take_copied().as_deref(), Some("two"), "the host drains the cut text");
		assert_eq!(buffer.take_copied(), None, "drained once");
		assert_eq!(buffer.handle(Key::Ctrl('y'), 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "one two");
	}

	#[test]
	fn copy_stashes_text_for_the_host_without_editing() {
		let mut buffer = EditBuffer::new("one two");
		assert_eq!(buffer.handle(Key::Copy, 80, 8), BufferOutcome::Ignored, "no selection");
		assert_eq!(buffer.take_copied(), None);
		buffer.handle(Key::SelectWordLeft, 80, 8);
		assert_eq!(buffer.handle(Key::Copy, 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.text(), "one two", "copy never edits");
		assert_eq!(buffer.take_copied().as_deref(), Some("two"));
	}

	#[test]
	fn undrained_copy_is_voided_by_the_next_key() {
		let mut buffer = EditBuffer::new("one two");
		buffer.handle(Key::SelectWordLeft, 80, 8);
		assert_eq!(buffer.handle(Key::Copy, 80, 8), BufferOutcome::Changed);
		// A host that skipped the drain must not surface the old text
		// alongside a later, unrelated edit.
		assert_eq!(buffer.handle(Key::Char('x'), 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.take_copied(), None, "stash lives exactly one key");
	}

	#[test]
	fn select_all_exposes_selected_text() {
		let mut buffer = EditBuffer::new("hello\nworld");
		assert_eq!(buffer.handle(Key::SelectAll, 80, 8), BufferOutcome::Changed);
		assert_eq!(buffer.selection(), Some(0..11));
		assert_eq!(buffer.selected_text(), Some("hello\nworld"));
	}

	#[test]
	fn selection_span_maps_columns_within_a_wrapped_row() {
		let mut buffer = EditBuffer::new("abcdefghi");
		buffer.set_cursor_visual_row(1, 1, 4);
		buffer.handle(Key::SelectRight, 4, 8);
		buffer.handle(Key::SelectRight, 4, 8);
		let rows = buffer.rows(4, 8);
		assert_eq!(rows[1].text, "efgh");
		assert_eq!(buffer.selection_span(&rows[1]), Some((1, 3)));
	}

	#[test]
	fn selection_edge_inside_atomic_marker_snaps_to_the_whole_atom() {
		let mut buffer = EditBuffer::new("a");
		buffer.insert_reference("[chip]", "<ref/>");
		buffer.insert_text("z");
		buffer.set_cursor_visual_row(0, 1, 80);
		buffer.extend_selection_visual_row(0, 3, 80);
		assert_eq!(buffer.atom_ranges().as_slice(), &[(1, 7)]);
		assert_eq!(buffer.selection(), Some(1..7));
		assert_eq!(buffer.selected_text(), Some("[chip]"));
	}

	/// Toy engine: `@` mentions with any-key trigger, a fixed ghost
	/// completion after `hel`, and Tab materializing that ghost text.
	struct AtNames;

	impl EditorCompletion for AtNames {
		fn suggest(&mut self, text: &str, cursor: usize) -> Option<Suggestions> {
			let before = &text[..cursor];
			let at = before.rfind('@')?;
			let query = &before[at + 1..];
			let items = ["alice", "bob"]
				.iter()
				.filter(|name| !query.is_empty() && name.starts_with(query))
				.map(|name| Suggestion::new(sf!("@{name} "), *name))
				.collect::<SuggestionList>();
			(!items.is_empty())
				.then_some(Suggestions { range: at..completion_token_end(text, cursor), items })
		}

		fn hint(&mut self, text: &str, cursor: usize) -> Option<Str> {
			text[..cursor]
				.ends_with("hel")
				.then(|| Str::new("lo world"))
		}

		fn tab(&mut self, text: &str, cursor: usize, selected: Option<&Suggestion>) -> TabAction {
			// with our dropdown open, Tab belongs to the app (focus switch)
			if selected.is_some() {
				return TabAction::Pass;
			}
			match self.hint(text, cursor) {
				Some(insert) => TabAction::Edit(CompletionEdit { range: cursor..cursor, insert }),
				None => TabAction::Pass,
			}
		}
	}

	#[test]
	fn custom_completion_controls_trigger_ghost_text_and_tab() {
		let mut editor = Editor::new(EditorOptions::default());
		editor.set_completion(Box::new(AtNames));
		type_text(&mut editor, "hi @al");
		let picker = editor.picker().expect("@ trigger opens the dropdown");
		assert_eq!(picker.len(), 1);
		// the engine overrides Tab even while its own dropdown is open
		assert_eq!(editor.handle(Key::Tab), EditOutcome::Ignored);
		assert!(editor.picker().is_some(), "passthrough leaves the dropdown open");
		assert_eq!(editor.handle(Key::Enter), EditOutcome::Changed);
		assert_eq!(editor.text(), "hi @alice ");

		type_text(&mut editor, "hel");
		assert_eq!(editor.inline_hint().as_deref(), Some("lo world"));
		assert_eq!(editor.handle(Key::Tab), EditOutcome::Changed);
		assert_eq!(editor.text(), "hi @alice hello world");
		// nothing to complete: Tab passes through to the embedding app
		assert_eq!(editor.handle(Key::Tab), EditOutcome::Ignored);

		// the emoji dropdown accepts on Tab without consulting the engine
		type_text(&mut editor, " :joy");
		assert!(editor.picker().is_some(), "emoji dropdown open");
		assert_eq!(editor.handle(Key::Tab), EditOutcome::Changed);
		assert!(editor.text().ends_with("😂"), "{}", editor.text());
	}
}
