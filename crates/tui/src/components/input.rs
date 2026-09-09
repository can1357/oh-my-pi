use std::{fmt::Write as _, iter};

use omp_core::Str;
use xutf::Text;

use crate::{
	component::{Component, EventCtx, Flow, Hit, HitTag, PaintCtx, Slot, next_slot},
	context::{Theme, UiContext},
	frame::{Rect, Style},
	input::{
		Key, Mouse, UiEvent, byte_at_column, sanitize_paste, word_left_column, word_right_column,
		word_rubout_start,
	},
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

const INPUT_UNDO_CAP: usize = 100;
const INPUT_KILL_CAP: usize = 60;

/// What one routed key did to the input.
#[derive(Clone, Copy, Eq, PartialEq)]
enum Edited {
	/// The key was not an editing key.
	None,
	/// Only the caret or kill/yank bookkeeping moved.
	Caret,
	/// The text content changed.
	Text,
}

#[derive(Clone, Copy, Default, Eq, PartialEq)]
enum InputAction {
	#[default]
	Other,
	TypeWord,
	Kill,
	Yank,
	YankPop,
}

#[derive(Default)]
struct InputState {
	text:        String,
	/// UTF-8 byte boundary in `text`.
	cursor:      usize,
	mask:        bool,
	masked:      String,
	counter:     String,
	undo:        Vec<(String, usize)>,
	kill_ring:   Vec<String>,
	kill_index:  usize,
	last_yank:   Option<(usize, usize)>,
	last_action: InputAction,
}

impl InputState {
	fn refresh_mask(&mut self) {
		self.masked.clear();
		if self.mask {
			self
				.masked
				.reserve(self.text.graphemes().count().saturating_mul('•'.len_utf8()));
			self
				.masked
				.extend(iter::repeat_n('•', self.text.graphemes().count()));
		}
	}

	fn cursor_column(&self) -> u16 {
		if self.mask {
			u16::try_from(self.text[..self.cursor].graphemes().count()).unwrap_or(u16::MAX)
		} else {
			cell_width(&self.text[..self.cursor])
		}
	}

	fn cursor_at_column(&self, column: u16) -> usize {
		if !self.mask {
			return byte_at_column(&self.text, column);
		}
		self
			.text
			.grapheme_indices()
			.nth(usize::from(column))
			.map_or(self.text.len(), |(at, _)| at)
	}

	fn snapshot(&mut self) {
		if self
			.undo
			.last()
			.is_some_and(|(text, cursor)| text == &self.text && *cursor == self.cursor)
		{
			return;
		}
		if self.undo.len() == INPUT_UNDO_CAP {
			self.undo.remove(0);
		}
		self.undo.push((self.text.clone(), self.cursor));
	}

	const fn break_sequence(&mut self) {
		self.last_action = InputAction::Other;
		self.last_yank = None;
	}

	fn record_kill(&mut self, killed: String, backward: bool) {
		if self.last_action == InputAction::Kill && !self.kill_ring.is_empty() {
			if backward {
				self.kill_ring[0].insert_str(0, &killed);
			} else {
				self.kill_ring[0].push_str(&killed);
			}
		} else {
			self.kill_ring.insert(0, killed);
			self.kill_ring.truncate(INPUT_KILL_CAP);
		}
		self.kill_index = 0;
		self.last_action = InputAction::Kill;
		self.last_yank = None;
	}

	fn refresh_counter(&mut self, limit: Option<usize>) {
		self.counter.clear();
		let Some(limit) = limit else {
			return;
		};
		let len = self.text.chars().count();
		if len <= limit {
			let _ = write!(self.counter, "{}", limit - len);
		} else {
			let _ = write!(self.counter, "-{}", len - limit);
		}
	}
}

/// An editable, single-line text field.
///
/// The `limit` property reserves only the countdown's current width at the
/// right edge; `rail` replaces the standard cursor prefix with a focus-colored
/// one-cell rail.
pub struct Input {
	props: Props,
	slot:  Slot,
	state: InputState,
}

impl Input {
	/// Creates an empty input.
	pub fn new() -> Self {
		Self { props: Props::new(), slot: next_slot(), state: InputState::default() }
	}

	/// Sets one input property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self.sync_prop(prop);
		self
	}

	/// Sets one input property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self.sync_prop(prop);
		self
	}

	fn sync_prop(&mut self, prop: Prop) {
		match prop {
			Prop::Value => {
				self.state.text = self
					.props
					.str_of(Prop::Value)
					.map(ToString::to_string)
					.unwrap_or_default();
				self.state.cursor = self.state.text.len();
				self.state.undo.clear();
				self.state.kill_ring.clear();
				self.state.break_sequence();
				self.state.refresh_mask();
			},
			Prop::Mask => {
				self.state.mask = self.props.flag(Prop::Mask);
				self.state.refresh_mask();
			},
			Prop::Limit => {},
			_ => {},
		}
		if matches!(prop, Prop::Value | Prop::Limit) {
			let limit = self.limit();
			self.state.refresh_counter(limit);
		}
	}

	fn limit(&self) -> Option<usize> {
		match self.props.get(Prop::Limit) {
			Some(PropValue::U16(limit)) => Some(usize::from(limit)),
			_ => None,
		}
	}

	fn edit(&mut self, key: Key) -> Edited {
		let changed = match key {
			Key::Left | Key::Ctrl('b') => {
				self.state.cursor = self.state.text[..self.state.cursor]
					.grapheme_indices()
					.next_back()
					.map_or(0, |(at, _)| at);
				self.state.break_sequence();
				true
			},
			Key::Right | Key::Ctrl('f') => {
				self.state.cursor += self.state.text[self.state.cursor..]
					.graphemes()
					.next()
					.map_or(0, str::len);
				self.state.break_sequence();
				true
			},
			Key::Home | Key::Ctrl('a') => {
				self.state.cursor = 0;
				self.state.break_sequence();
				true
			},
			Key::End | Key::Ctrl('e') => {
				self.state.cursor = self.state.text.len();
				self.state.break_sequence();
				true
			},
			Key::Backspace => {
				let end = self.state.cursor;
				let start = self.state.text[..end]
					.grapheme_indices()
					.next_back()
					.map_or(0, |(offset, _)| offset);
				if start == end {
					false
				} else {
					self.state.snapshot();
					self.state.text.replace_range(start..end, "");
					self.state.cursor = start;
					self.state.break_sequence();
					true
				}
			},
			Key::Delete | Key::Ctrl('d') => {
				let start = self.state.cursor;
				let end = start
					+ self.state.text[start..]
						.graphemes()
						.next()
						.map_or(0, str::len);
				if start == end {
					false
				} else {
					self.state.snapshot();
					self.state.text.replace_range(start..end, "");
					self.state.break_sequence();
					true
				}
			},
			Key::Space => {
				self.state.snapshot();
				self.state.text.insert(self.state.cursor, ' ');
				self.state.cursor += 1;
				self.state.break_sequence();
				true
			},
			Key::Char(character) => {
				let word = character.is_alphanumeric() || character == '_';
				if !word || self.state.last_action != InputAction::TypeWord {
					self.state.snapshot();
				}
				self.state.text.insert(self.state.cursor, character);
				self.state.cursor += character.len_utf8();
				self.state.last_action = if word {
					InputAction::TypeWord
				} else {
					InputAction::Other
				};
				self.state.last_yank = None;
				true
			},
			Key::Ctrl('-' | '_') => {
				let Some((text, cursor)) = self.state.undo.pop() else {
					return Edited::None;
				};
				self.state.text = text;
				self.state.cursor = cursor;
				self.state.break_sequence();
				true
			},
			Key::Ctrl('k') => self.kill_range(self.state.cursor, self.state.text.len()),
			Key::Ctrl('u') => self.kill_range(0, self.state.cursor),
			Key::Ctrl('w') => {
				let end = self.state.cursor;
				self.kill_range(word_rubout_start(&self.state.text, end), end)
			},
			Key::WordLeft => {
				let column = cell_width(&self.state.text[..self.state.cursor]);
				let target = word_left_column(&self.state.text, column);
				self.state.cursor = byte_at_column(&self.state.text, target);
				self.state.break_sequence();
				true
			},
			Key::WordRight => {
				let column = cell_width(&self.state.text[..self.state.cursor]);
				let target = word_right_column(&self.state.text, column);
				self.state.cursor = byte_at_column(&self.state.text, target);
				self.state.break_sequence();
				true
			},
			Key::WordDelete => {
				let column = cell_width(&self.state.text[..self.state.cursor]);
				let target = word_right_column(&self.state.text, column);
				let end = byte_at_column(&self.state.text, target);
				self.kill_range(self.state.cursor, end)
			},
			Key::Ctrl('y') => self.yank(),
			Key::Alt('y') => self.yank_pop(),
			_ => return Edited::None,
		};
		if !changed {
			return Edited::None;
		}
		if matches!(
			key,
			Key::Left
				| Key::Right
				| Key::Home
				| Key::End
				| Key::WordLeft
				| Key::WordRight
				| Key::Ctrl('b' | 'f' | 'a' | 'e')
		) {
			return Edited::Caret;
		}
		self.state.refresh_mask();
		let limit = self.limit();
		self.state.refresh_counter(limit);
		Edited::Text
	}

	fn kill_range(&mut self, start: usize, end: usize) -> bool {
		if start == end {
			return false;
		}
		self.state.snapshot();
		let killed = self.state.text[start..end].to_owned();
		let backward = end == self.state.cursor;
		self.state.text.replace_range(start..end, "");
		self.state.cursor = start;
		self.state.record_kill(killed, backward);
		true
	}

	fn yank(&mut self) -> bool {
		let Some(value) = self.state.kill_ring.first().cloned() else {
			self.state.break_sequence();
			return false;
		};
		self.state.snapshot();
		let start = self.state.cursor;
		self.state.text.insert_str(start, &value);
		self.state.cursor += value.len();
		self.state.kill_index = 0;
		self.state.last_yank = Some((start, self.state.cursor));
		self.state.last_action = InputAction::Yank;
		true
	}

	fn yank_pop(&mut self) -> bool {
		if !matches!(self.state.last_action, InputAction::Yank | InputAction::YankPop)
			|| self.state.kill_ring.len() < 2
		{
			self.state.break_sequence();
			return false;
		}
		let Some((start, end)) = self.state.last_yank else {
			return false;
		};
		self.state.snapshot();
		self.state.kill_index = (self.state.kill_index + 1) % self.state.kill_ring.len();
		let value = self.state.kill_ring[self.state.kill_index].clone();
		self.state.text.replace_range(start..end, &value);
		self.state.cursor = start + value.len();
		self.state.last_yank = Some((start, self.state.cursor));
		self.state.last_action = InputAction::YankPop;
		true
	}

	/// Surfaces the edited text as [`UiEvent::Changed`] when the input is
	/// named, so hosts can react to every keystroke (live filtering).
	fn changed_event(&self) -> Flow {
		match self.props.id() {
			Some(id) => {
				Flow::Event(UiEvent::Changed { id: id.clone(), value: Str::new(&self.state.text) })
			},
			None => Flow::Consumed,
		}
	}
}

impl Default for Input {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Input {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		let placeholder = self
			.props
			.str_of(Prop::Placeholder)
			.map_or(0, |placeholder| cell_width(placeholder));
		(16, placeholder.saturating_add(3).max(30))
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.y >= pc.clip {
			return;
		}
		pc.hits
			.push(Hit { rect, slot: self.slot, tag: HitTag::Press });
		let focused = pc.focus == Some(self.slot);
		let rail = self.props.flag(Prop::Rail);
		let prefix = if rail {
			if focused { "▎" } else { "▏" }
		} else {
			pc.ctx.charset.cursor()
		};
		let prefix_style = if rail {
			Style::new().fg(if focused {
				pc.ctx.theme.accent
			} else {
				pc.ctx.theme.border
			})
		} else if focused {
			Style::new().fg(pc.ctx.theme.accent)
		} else {
			dim(&pc.ctx.theme)
		};
		let content_x = pc.frame.put(rect.x, rect.y, prefix, prefix_style);
		// Rail inputs align content with the editor's `▎ text` column so
		// stacked rail fields share one text column.
		let content_x = if rail {
			content_x.saturating_add(1)
		} else {
			content_x
		};
		let right = rect.x.saturating_add(rect.width);
		let counter_width = cell_width(&self.state.counter).min(rect.width);
		let counter_start = byte_at_column(
			&self.state.counter,
			cell_width(&self.state.counter).saturating_sub(counter_width),
		);
		let counter = &self.state.counter[counter_start..];
		let counter_x = right.saturating_sub(counter_width);
		let available = counter_x.saturating_sub(content_x);
		let shown = if self.state.mask {
			&self.state.masked
		} else {
			&self.state.text
		};
		if shown.is_empty() && !focused {
			if let Some(placeholder) = self.props.str_of(Prop::Placeholder) {
				let end = byte_at_column(placeholder, available);
				pc.frame
					.put(content_x, rect.y, &placeholder[..end], dim(&pc.ctx.theme).italic());
			}
		} else if available > 0 {
			let total = cell_width(shown);
			let cursor = self.state.cursor_column();
			let cursor_room = available.saturating_sub(u16::from(focused));
			let left = if total > available || cursor > cursor_room {
				cursor.saturating_sub(cursor_room)
			} else {
				0
			};
			let start = byte_at_column(shown, left);
			let visible = &shown[start..];
			let end = byte_at_column(visible, available);
			let visible = &visible[..end];
			pc.frame
				.put(content_x, rect.y, visible, base(&pc.ctx.theme));
			if focused {
				// The real terminal cursor marks the insertion point — one
				// cursor treatment across every core single-line editor.
				let split = byte_at_column(visible, cursor.saturating_sub(left));
				pc.frame
					.set_cursor(content_x.saturating_add(cell_width(&visible[..split])), rect.y);
			}
		}
		if !counter.is_empty() {
			let style = if self.state.counter.starts_with('-') {
				Style::new().fg(pc.ctx.theme.warn)
			} else {
				dim(&pc.ctx.theme)
			};
			pc.frame.put(counter_x, rect.y, counter, style);
		}
	}

	fn focusable(&self) -> bool {
		true
	}

	fn key(&mut self, _ec: &mut EventCtx<'_>, key: Key) -> Flow {
		if key == Key::Enter && self.props.flag(Prop::Submit) {
			return Flow::Event(UiEvent::Submit);
		}
		match self.edit(key) {
			Edited::Text => self.changed_event(),
			Edited::Caret => Flow::Consumed,
			Edited::None => Flow::Skip,
		}
	}

	fn mouse(
		&mut self,
		ec: &mut EventCtx<'_>,
		tag: HitTag,
		at: (u16, u16),
		rect: Rect,
		mouse: Mouse,
	) -> Flow {
		match mouse {
			Mouse::Click if tag == HitTag::Press => {
				let prefix_width = if self.props.flag(Prop::Rail) {
					2
				} else {
					cell_width(ec.ctx.charset.cursor())
				};
				let column = at
					.0
					.saturating_sub(rect.x.saturating_add(prefix_width))
					.min(cell_width(if self.state.mask {
						&self.state.masked
					} else {
						&self.state.text
					}));
				self.state.cursor = self.state.cursor_at_column(column);
				self.state.break_sequence();
				Flow::Consumed
			},
			Mouse::Click
			| Mouse::RightClick
			| Mouse::MiddleClick
			| Mouse::Move
			| Mouse::Drag
			| Mouse::Release
			| Mouse::WheelUp
			| Mouse::WheelDown
			| Mouse::WheelLeft
			| Mouse::WheelRight => Flow::Skip,
		}
	}

	fn paste(&mut self, _ec: &mut EventCtx<'_>, text: &str) -> Flow {
		let sanitized = sanitize_paste(text);
		if sanitized.is_empty() {
			return Flow::Skip;
		}
		let paste = sanitized.replace('\n', " ");
		self.state.snapshot();
		self.state.text.insert_str(self.state.cursor, &paste);
		self.state.cursor += paste.len();
		self.state.break_sequence();
		self.state.refresh_mask();
		let limit = self.limit();
		self.state.refresh_counter(limit);
		self.changed_event()
	}

	fn value(&self, out: &mut serde_json::Map<String, serde_json::Value>) {
		if let Some(id) = self.props.id() {
			out.insert(id.to_string(), serde_json::Value::String(self.state.text.clone()));
		}
	}
}

const fn base(theme: &Theme) -> Style {
	Style::new().fg(theme.fg)
}
const fn dim(theme: &Theme) -> Style {
	Style::new().fg(theme.muted)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Frame, Size, test_support::frame_row_text};

	fn event_ctx(ctx: &UiContext) -> EventCtx<'_> {
		EventCtx::new(ctx, 32, 1)
	}

	#[test]
	fn key_and_paste_edit_exported_text() {
		let mut input = Input::new().with(Prop::Id, "name");
		let ctx = UiContext::default();
		assert_eq!(
			input.key(&mut event_ctx(&ctx), Key::Char('a')),
			Flow::Event(UiEvent::Changed { id: "name".into(), value: "a".into() })
		);
		assert_eq!(
			input.key(&mut event_ctx(&ctx), Key::Char('b')),
			Flow::Event(UiEvent::Changed { id: "name".into(), value: "ab".into() })
		);
		assert_eq!(
			input.paste(&mut event_ctx(&ctx), " c\td"),
			Flow::Event(UiEvent::Changed { id: "name".into(), value: "ab c   d".into() })
		);
		let mut values = serde_json::Map::new();
		input.value(&mut values);
		assert_eq!(values["name"], serde_json::json!("ab c   d"));
	}

	#[test]
	fn cursor_motion_stays_on_grapheme_boundaries() {
		let mut input = Input::new().with(Prop::Value, "界a");
		assert_eq!(input.state.cursor, "界a".len());
		assert!(input.edit(Key::Left) == Edited::Caret);
		assert_eq!(input.state.cursor, "界".len());
		assert!(input.edit(Key::Left) == Edited::Caret);
		assert_eq!(input.state.cursor, 0);
		assert!(input.edit(Key::Right) == Edited::Caret);
		assert_eq!(input.state.cursor, "界".len());
		assert!(input.edit(Key::Backspace) == Edited::Text);
		assert_eq!(input.state.text, "a");
		assert_eq!(input.state.cursor, 0);
	}

	#[test]
	fn undo_and_kill_ring_restore_single_line_edits() {
		let mut input = Input::new().with(Prop::Value, "one two");
		assert!(input.edit(Key::Ctrl('w')) == Edited::Text);
		assert_eq!(input.state.text, "one ");
		assert!(input.edit(Key::Char('x')) == Edited::Text);
		assert!(input.edit(Key::Ctrl('u')) == Edited::Text);
		assert_eq!(input.state.text, "");
		assert!(input.edit(Key::Ctrl('y')) == Edited::Text);
		assert_eq!(input.state.text, "one x");
		assert!(input.edit(Key::Alt('y')) == Edited::Text);
		assert_eq!(input.state.text, "two");
		assert!(input.edit(Key::Ctrl('-')) == Edited::Text);
		assert_eq!(input.state.text, "one x");
	}

	#[test]
	fn paste_is_one_undo_unit_and_keeps_tab_expansion_visible() {
		let ctx = UiContext::default();
		let mut input = Input::new().with(Prop::Value, "a");
		assert_eq!(input.paste(&mut event_ctx(&ctx), "\tb"), Flow::Consumed);
		assert_eq!(input.state.text, "a   b");
		assert!(input.edit(Key::Ctrl('-')) == Edited::Text);
		assert_eq!(input.state.text, "a");
	}

	#[test]
	fn paint_draws_text_and_press_hit() {
		let mut input = Input::new().with(Prop::Value, "hello");
		let ctx = UiContext::default();
		let mut frame = Frame::new(Size::new(32, 1));
		let mut hits = Vec::new();
		let slot = input.slot();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		input.paint(&mut pc, Rect::new(0, 0, 32, 1));
		assert!(frame_row_text(&frame, 0).contains("hello"));
		assert_eq!(hits[0].slot, slot);
	}

	#[test]
	fn limit_counter_marks_boundary_and_overflow() {
		let ctx = UiContext::default();
		for (value, counter, color) in [("abc", "0", ctx.theme.muted), ("abcd", "-1", ctx.theme.warn)]
		{
			let mut input = Input::new()
				.with(Prop::Value, value)
				.with(Prop::Limit, 3_u16);
			let mut frame = Frame::new(Size::new(12, 1));
			let mut hits = Vec::new();
			let mut wakes = Vec::new();
			let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
			input.paint(&mut pc, Rect::new(0, 0, 12, 1));
			assert!(frame_row_text(&frame, 0).ends_with(counter));
			let start = 12 - u16::try_from(counter.len()).unwrap();
			assert_eq!(frame.cell(start, 0).style.foreground_color(), color);
		}
	}

	#[test]
	fn rail_tracks_focus_with_semantic_colors() {
		let ctx = UiContext::default();
		let mut input = Input::new().with(Prop::Rail, true);
		let slot = input.slot();
		for (focus, glyph, color) in
			[(None, "▏", ctx.theme.border), (Some(slot), "▎", ctx.theme.accent)]
		{
			let mut frame = Frame::new(Size::new(8, 1));
			let mut hits = Vec::new();
			let mut wakes = Vec::new();
			let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
			pc.focus = focus;
			input.paint(&mut pc, Rect::new(0, 0, 8, 1));
			assert!(frame_row_text(&frame, 0).starts_with(glyph));
			assert_eq!(frame.cell(0, 0).style.foreground_color(), color);
		}
	}
}
