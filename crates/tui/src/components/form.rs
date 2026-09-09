use std::fmt::Write as _;

use omp_core::{IntoStr, Str};
use serde_json::{Map, Value};
use smallvec::SmallVec;

use super::wizard;
use crate::{
	component::{
		Cached, Component, EventCtx, Flow, Hit, HitTag, IntoChildren, PaintCtx, Slot, next_slot,
	},
	context::{Theme, UiContext},
	frame::{Frame, Rect, Style},
	input::{Key, Mouse, sanitize_paste, word_rubout_start},
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FieldKind {
	Bool,
	Enum,
	Text,
	Select,
	Multi,
	Number,
}

#[derive(Clone, Debug)]
enum FieldValue {
	Bool(bool),
	Text(String),
	Choice(Str),
	Many(SmallVec<Str, 4>),
	Number(i64),
}

/// Declarative input metadata backing the `<field>` markup tag.
pub struct Field {
	props:    Props,
	label:    Str,
	children: Vec<Cached>,
}

impl Field {
	/// Creates an empty field definition.
	pub fn new() -> Self {
		Self { props: Props::new(), label: Str::new(""), children: Vec::new() }
	}

	/// Sets one field property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one field property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets the field's visible label.
	pub fn label(mut self, label: impl IntoStr) -> Self {
		self.label = label.into_str();
		self
	}

	/// Appends field content used by richer controls.
	pub fn child(mut self, children: impl IntoChildren) -> Self {
		children.extend_children(&mut self.children);
		self
	}
}

impl Default for Field {
	fn default() -> Self {
		Self::new()
	}
}

#[derive(Clone, Debug)]
struct FieldData {
	kind:     FieldKind,
	id:       Str,
	label:    Str,
	desc:     Option<Str>,
	options:  SmallVec<Str, 8>,
	value:    FieldValue,
	required: bool,
	masked:   bool,
	pattern:  Option<Str>,
	min:      i64,
	max:      i64,
	step:     i64,
}

impl FieldData {
	fn from_field(field: Field) -> Self {
		let kind = match field.props.str_of(Prop::Kind).map(Str::as_str) {
			Some("bool") => FieldKind::Bool,
			Some("enum") => FieldKind::Enum,
			Some("select") => FieldKind::Select,
			Some("multi") => FieldKind::Multi,
			Some("number") => FieldKind::Number,
			_ => FieldKind::Text,
		};
		let options: SmallVec<Str, 8> = field
			.props
			.str_of(Prop::Options)
			.map(|options| options.split_whitespace().map(Str::new).collect())
			.unwrap_or_default();
		let raw = field.props.str_of(Prop::Value);
		let value = match kind {
			FieldKind::Bool => FieldValue::Bool(raw.is_some_and(|value| value == "true")),
			FieldKind::Enum | FieldKind::Select => FieldValue::Choice(
				raw.filter(|value| options.iter().any(|option| option == *value))
					.cloned()
					.or_else(|| options.first().cloned())
					.unwrap_or_default(),
			),
			FieldKind::Multi => FieldValue::Many(
				raw.map(|value| {
					options
						.iter()
						.filter(|option| value.split_whitespace().any(|part| *option == part))
						.cloned()
						.collect()
				})
				.unwrap_or_default(),
			),
			FieldKind::Number => {
				FieldValue::Number(raw.and_then(|value| value.parse().ok()).unwrap_or(0))
			},
			FieldKind::Text => FieldValue::Text(raw.map(ToString::to_string).unwrap_or_default()),
		};
		let i64_prop = |prop| match field.props.get(prop) {
			Some(PropValue::I64(value)) => Some(value),
			Some(PropValue::U16(value)) => Some(i64::from(value)),
			Some(PropValue::Str(value)) => value.parse().ok(),
			_ => None,
		};
		let id = field.props.id().cloned().unwrap_or_default();
		let label = if field.label.is_empty() {
			field
				.props
				.str_of(Prop::Label)
				.cloned()
				.unwrap_or_else(|| id.clone())
		} else {
			field.label
		};
		Self {
			kind,
			id,
			label,
			desc: field.props.str_of(Prop::Desc).cloned(),
			options,
			value,
			required: field.props.flag(Prop::Required),
			masked: field.props.flag(Prop::Mask),
			pattern: field.props.str_of(Prop::Match).cloned(),
			min: i64_prop(Prop::Min).unwrap_or(i64::MIN),
			max: i64_prop(Prop::Max).unwrap_or(i64::MAX),
			step: i64_prop(Prop::Step).unwrap_or(1),
		}
	}
}

/// An interactive collection of fields backing the `<form>` markup tag.
pub struct Form {
	props:      Props,
	slot:       Slot,
	fields:     Vec<FieldData>,
	cursor:     u16,
	editing:    bool,
	open:       Option<u16>,
	sub_cursor: u16,
	scroll:     u16,
	scratch:    String,
}

impl Form {
	/// Creates an empty form.
	pub fn new() -> Self {
		Self {
			props:      Props::new(),
			slot:       next_slot(),
			fields:     Vec::new(),
			cursor:     0,
			editing:    false,
			open:       None,
			sub_cursor: 0,
			scroll:     0,
			scratch:    String::new(),
		}
	}

	/// Sets one form property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one form property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends a field definition.
	pub fn field(mut self, field: Field) -> Self {
		self.fields.push(FieldData::from_field(field));
		self
	}

	/// Extra rows contributed by the open dropdown, if any.
	fn open_rows(&self) -> u16 {
		self
			.open
			.and_then(|open| self.fields.get(usize::from(open)))
			.map_or(0, |field| field.options.len() as u16)
	}

	/// Scrollable rows: one per field plus the open dropdown's options.
	fn content_rows(&self) -> u16 {
		(self.fields.len() as u16).saturating_add(self.open_rows())
	}

	/// One pinned description row is reserved when any field carries one,
	/// so moving the cursor never changes the form's height.
	fn desc_rows(&self) -> u16 {
		u16::from(self.fields.iter().any(|field| field.desc.is_some()))
	}

	/// Field rows visible at once given the component's own row count.
	fn window(&self, view_rows: u16) -> u16 {
		view_rows.saturating_sub(self.desc_rows()).max(1)
	}

	/// Scrolls the viewport the minimum distance that shows `row`.
	fn chase_row(&mut self, row: u16, view_rows: u16) {
		let window = self.window(view_rows);
		if row < self.scroll {
			self.scroll = row;
		} else if row >= self.scroll.saturating_add(window) {
			self.scroll = row.saturating_add(1).saturating_sub(window);
		}
		self.scroll = self.scroll.min(self.content_rows().saturating_sub(window));
	}

	/// Shows the cursor row, plus as much of its open dropdown as fits.
	fn chase_cursor(&mut self, view_rows: u16) {
		if self.open == Some(self.cursor) {
			self.chase_row(self.cursor.saturating_add(self.open_rows()), view_rows);
		}
		self.chase_row(self.cursor, view_rows);
	}

	/// Moves the viewport without touching the cursor; false at the edges.
	fn scroll_by(&mut self, delta: i32, view_rows: u16) -> bool {
		let window = self.window(view_rows);
		let max = self.content_rows().saturating_sub(window);
		let next = (i64::from(self.scroll) + i64::from(delta)).clamp(0, i64::from(max)) as u16;
		let changed = next != self.scroll;
		self.scroll = next;
		changed
	}

	/// Centers the scrollbar thumb on the pointer row — the inverse of the
	/// thumb placement painted by [`Component::paint`].
	fn scrollbar_jump(&mut self, at: (u16, u16), rect: Rect) -> Flow {
		let track = rect.height;
		let content = self.content_rows();
		if track == 0 || content <= track {
			return Flow::Consumed;
		}
		let thumb_h = (track.saturating_mul(track) / content).max(1);
		let span = track - thumb_h;
		if span == 0 {
			return Flow::Consumed;
		}
		let row = at.1.saturating_sub(rect.y).min(track - 1);
		let grab = row.saturating_sub(thumb_h / 2).min(span);
		let range = u32::from(content - track);
		self.scroll = ((u32::from(grab) * range + u32::from(span / 2)) / u32::from(span)) as u16;
		Flow::Consumed
	}

	fn activate(&mut self) {
		let cursor = self.cursor;
		let Some(field) = self.fields.get_mut(usize::from(cursor)) else {
			return;
		};
		match field.kind {
			FieldKind::Bool => {
				if let FieldValue::Bool(value) = &mut field.value {
					*value = !*value;
				}
			},
			FieldKind::Enum => cycle_choice(field, true),
			FieldKind::Select | FieldKind::Multi => {
				self.open = Some(cursor);
				self.sub_cursor = match (&field.value, field.kind) {
					(FieldValue::Choice(choice), FieldKind::Select) => field
						.options
						.iter()
						.position(|option| option == choice)
						.unwrap_or(0) as u16,
					_ => 0,
				};
			},
			FieldKind::Text => self.editing = true,
			FieldKind::Number => {},
		}
	}

	fn click_row(&mut self, index: u16, view_rows: u16) {
		if usize::from(index) >= self.fields.len() {
			return;
		}
		self.cursor = index;
		if self.open.is_some() && self.open != Some(index) {
			self.open = None;
		}
		self.activate();
		self.chase_cursor(view_rows);
	}

	fn click_sub(&mut self, index: u16) {
		let Some(open) = self.open else { return };
		self.sub_cursor = index;
		let field = &mut self.fields[usize::from(open)];
		if field.kind == FieldKind::Multi {
			toggle_multi(field, index);
		} else {
			if let Some(option) = field.options.get(usize::from(index)) {
				field.value = FieldValue::Choice(option.clone());
			}
			self.open = None;
		}
	}
}

impl Default for Form {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Form {
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
		let natural = self
			.fields
			.iter()
			.map(|field| cell_width(&field.label) + 24)
			.max()
			.unwrap_or(24);
		(24, natural)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		let natural = self.content_rows().saturating_add(self.desc_rows());
		self
			.props
			.max_rows()
			.map_or(natural, |cap| natural.min(cap))
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let focused = pc.focus == Some(self.slot);
		if self.fields.is_empty() || rect.height == 0 {
			return;
		}
		let desc_rows = self.desc_rows();
		let content_rows = self.content_rows();
		let window = rect.height.saturating_sub(desc_rows).max(1);
		self.scroll = self.scroll.min(content_rows.saturating_sub(window));
		let overflow = content_rows > window;
		let row_width = rect.width.saturating_sub(u16::from(overflow));
		let right = rect.x.saturating_add(row_width);
		let label_width = self
			.fields
			.iter()
			.map(|field| cell_width(&field.label))
			.max()
			.unwrap_or(8)
			+ 2;
		let bottom = rect.y.saturating_add(window).min(pc.clip);
		pc.hits.push(Hit {
			rect: Rect::new(rect.x, rect.y, rect.width, window),
			slot: self.slot,
			tag:  HitTag::Wheel,
		});
		let mut y = rect.y;
		let mut row = 0u16;
		'rows: for (index, field) in self.fields.iter().enumerate() {
			if y >= bottom {
				break;
			}
			if row >= self.scroll {
				let here = focused && index as u16 == self.cursor;
				let hovered = matches!(pc.hover, Some((slot, HitTag::Row(hover_row))) if slot == self.slot && hover_row == index as u16);
				if hovered {
					pc.frame
						.fill(Rect::new(rect.x, y, row_width, 1), Style::new().bg(pc.ctx.theme.hover));
				}
				let tint = |style: Style| {
					if hovered {
						style.bg(pc.ctx.theme.hover)
					} else {
						style
					}
				};
				let mut x = pc.frame.put(
					rect.x,
					y,
					if here { pc.ctx.charset.cursor() } else { "  " },
					tint(Style::new().fg(pc.ctx.theme.accent)),
				);
				let label_style = if here {
					tint(Style::new().fg(pc.ctx.theme.accent).bold())
				} else {
					tint(base(&pc.ctx.theme))
				};
				x = pc
					.frame
					.put_clipped(x, y, right.saturating_sub(x), &field.label, label_style);
				for _ in cell_width(&field.label)..label_width {
					if x >= right {
						break;
					}
					x = pc.frame.put(x, y, " ", tint(base(&pc.ctx.theme)));
				}
				x = paint_field_value(
					pc.ctx,
					pc.frame,
					x,
					y,
					right,
					field,
					here,
					tint,
					&mut self.scratch,
				);
				if here && self.editing && x < right {
					pc.frame.put(
						x,
						y,
						pc.ctx.charset.beam(),
						tint(Style::new().fg(pc.ctx.theme.accent)),
					);
				}
				pc.hits.push(Hit {
					rect: Rect::new(rect.x, y, row_width, 1),
					slot: self.slot,
					tag:  HitTag::Row(index as u16),
				});
				y += 1;
			}
			row += 1;
			if self.open == Some(index as u16) {
				for (option_index, option) in field.options.iter().enumerate() {
					if row >= self.scroll {
						if y >= bottom {
							break 'rows;
						}
						let sub_here = option_index as u16 == self.sub_cursor;
						let picked = match &field.value {
							FieldValue::Choice(choice) => choice == option,
							FieldValue::Many(values) => values.contains(option),
							_ => false,
						};
						let mark = if field.kind == FieldKind::Multi {
							pc.ctx.charset.checkbox(picked)
						} else {
							pc.ctx.charset.radio(picked)
						};
						let mut sx = pc.frame.put(
							rect.x + 4,
							y,
							if sub_here {
								pc.ctx.charset.cursor()
							} else {
								"  "
							},
							Style::new().fg(pc.ctx.theme.accent),
						);
						sx = pc.frame.put(
							sx,
							y,
							mark,
							Style::new().fg(if picked {
								pc.ctx.theme.ok
							} else {
								pc.ctx.theme.muted
							}),
						);
						sx = pc.frame.put(sx, y, " ", base(&pc.ctx.theme));
						pc.frame.put_clipped(
							sx,
							y,
							right.saturating_sub(sx),
							option,
							if sub_here {
								Style::new().fg(pc.ctx.theme.accent).bold()
							} else {
								base(&pc.ctx.theme)
							},
						);
						pc.hits.push(Hit {
							rect: Rect::new(rect.x, y, row_width, 1),
							slot: self.slot,
							tag:  HitTag::Sub(option_index as u16),
						});
						y += 1;
					}
					row += 1;
				}
			}
		}
		if overflow {
			let bar_x = rect.x.saturating_add(rect.width.saturating_sub(1));
			let thumb_h = (window.saturating_mul(window) / content_rows).max(1);
			let denom = content_rows.saturating_sub(window).max(1);
			let thumb_top = window.saturating_sub(thumb_h).saturating_mul(self.scroll) / denom;
			for bar_row in 0..window {
				let bar_y = rect.y.saturating_add(bar_row);
				if bar_y >= pc.clip {
					break;
				}
				let (glyph, style) =
					if bar_row >= thumb_top && bar_row < thumb_top.saturating_add(thumb_h) {
						(pc.ctx.charset.scrollbar().1, Style::new().fg(pc.ctx.theme.accent))
					} else {
						(pc.ctx.charset.scrollbar().0, Style::new().fg(pc.ctx.theme.muted))
					};
				pc.frame.put(bar_x, bar_y, glyph, style);
			}
			pc.hits.push(Hit {
				rect: Rect::new(bar_x, rect.y, 1, window),
				slot: self.slot,
				tag:  HitTag::Scrollbar,
			});
		}
		if desc_rows == 1 {
			let desc_y = rect.y.saturating_add(window);
			if desc_y < pc.clip
				&& let Some(desc) = self
					.fields
					.get(usize::from(self.cursor))
					.and_then(|field| field.desc.as_ref())
			{
				pc.frame.put_clipped(
					rect.x + 2,
					desc_y,
					rect.width.saturating_sub(2),
					desc,
					dim(&pc.ctx.theme),
				);
			}
		}
	}

	fn focusable(&self) -> bool {
		true
	}

	fn enter(&mut self, forward: bool) {
		self.cursor = if forward {
			0
		} else {
			self.fields.len().saturating_sub(1) as u16
		};
		self.scroll = if forward { 0 } else { self.content_rows() };
	}

	fn key(&mut self, ec: &mut EventCtx<'_>, key: Key) -> Flow {
		if self.fields.is_empty() {
			return Flow::Skip;
		}
		if let Some(open) = self.open {
			let field = &mut self.fields[usize::from(open)];
			let len = field.options.len() as u16;
			match key {
				Key::Up if len > 0 => self.sub_cursor = (self.sub_cursor + len - 1) % len,
				Key::Down if len > 0 => self.sub_cursor = (self.sub_cursor + 1) % len,
				Key::Space if field.kind == FieldKind::Multi => toggle_multi(field, self.sub_cursor),
				Key::Left | Key::Right if field.kind == FieldKind::Multi => {
					reorder_multi(field, self.sub_cursor, key == Key::Right);
				},
				Key::Enter => {
					if field.kind != FieldKind::Multi
						&& let Some(option) = field.options.get(usize::from(self.sub_cursor))
					{
						field.value = FieldValue::Choice(option.clone());
					}
					self.open = None;
				},
				Key::Esc => self.open = None,
				_ => {},
			}
			match self.open {
				Some(open) => {
					let sub_row = open.saturating_add(1).saturating_add(self.sub_cursor);
					self.chase_row(sub_row, ec.view_rows);
				},
				None => self.chase_cursor(ec.view_rows),
			}
			return Flow::Consumed;
		}
		let field_count = self.fields.len() as u16;
		if self.editing {
			let field = &mut self.fields[usize::from(self.cursor)];
			let FieldValue::Text(text) = &mut field.value else {
				self.editing = false;
				return Flow::Consumed;
			};
			match key {
				Key::Enter | Key::Esc => self.editing = false,
				Key::Backspace => {
					text.pop();
				},
				Key::Space => text.push(' '),
				Key::Char(character) => text.push(character),
				Key::Ctrl('u') => text.clear(),
				Key::Ctrl('w') => text.truncate(word_rubout_start(text, text.len())),
				_ => {},
			}
			return Flow::Consumed;
		}
		let kind = self.fields[usize::from(self.cursor)].kind;
		match key {
			Key::Left | Key::Right if kind == FieldKind::Enum => {
				cycle_choice(&mut self.fields[usize::from(self.cursor)], key == Key::Right);
				Flow::Consumed
			},
			Key::Left | Key::Right if kind == FieldKind::Number => {
				let field = &mut self.fields[usize::from(self.cursor)];
				if let FieldValue::Number(value) = &mut field.value {
					let step = if key == Key::Right {
						field.step
					} else {
						field.step.saturating_neg()
					};
					*value = value.saturating_add(step).clamp(field.min, field.max);
				}
				Flow::Consumed
			},
			Key::Up if self.cursor > 0 => {
				self.cursor -= 1;
				self.chase_cursor(ec.view_rows);
				Flow::Consumed
			},
			Key::Down if self.cursor + 1 < field_count => {
				self.cursor += 1;
				self.chase_cursor(ec.view_rows);
				Flow::Consumed
			},
			Key::PageUp => {
				let window = self.window(ec.view_rows);
				self.cursor = self.cursor.saturating_sub(window);
				self.chase_cursor(ec.view_rows);
				Flow::Consumed
			},
			Key::PageDown => {
				let window = self.window(ec.view_rows);
				self.cursor = self
					.cursor
					.saturating_add(window)
					.min(field_count.saturating_sub(1));
				self.chase_cursor(ec.view_rows);
				Flow::Consumed
			},
			Key::Enter | Key::Space => {
				self.activate();
				self.chase_cursor(ec.view_rows);
				Flow::Consumed
			},
			_ => Flow::Skip,
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
			Mouse::Click => {
				match tag {
					HitTag::Row(index) => self.click_row(index, ec.view_rows),
					HitTag::Sub(index) => self.click_sub(index),
					HitTag::Scrollbar => return self.scrollbar_jump(at, rect),
					_ => return Flow::Skip,
				}
				Flow::Consumed
			},
			Mouse::Drag if tag == HitTag::Scrollbar => self.scrollbar_jump(at, rect),
			Mouse::WheelUp | Mouse::WheelDown => {
				let delta = if mouse == Mouse::WheelUp { -1 } else { 1 };
				if self.scroll_by(delta, ec.view_rows) {
					Flow::Consumed
				} else {
					Flow::Skip
				}
			},
			Mouse::RightClick
			| Mouse::MiddleClick
			| Mouse::Move
			| Mouse::Drag
			| Mouse::Release
			| Mouse::WheelLeft
			| Mouse::WheelRight => Flow::Skip,
		}
	}

	fn paste(&mut self, _ec: &mut EventCtx<'_>, text: &str) -> Flow {
		if !self.editing {
			return Flow::Skip;
		}
		let sanitized = sanitize_paste(text);
		if sanitized.is_empty() {
			return Flow::Skip;
		}
		let Some(FieldData { value: FieldValue::Text(value), .. }) =
			self.fields.get_mut(usize::from(self.cursor))
		else {
			return Flow::Skip;
		};
		value.push_str(&sanitized.replace(['\n', '\t'], " "));
		Flow::Consumed
	}

	fn validation_error(&self) -> Option<String> {
		for field in &self.fields {
			let value = field_value(field);
			let text = wizard::display_value(&value);
			if field.required && text.trim().is_empty() {
				return Some(format!("{} is required", field.id));
			}
			if let Some(pattern) = &field.pattern
				&& !text.trim().is_empty()
				&& !wizard::match_simple(pattern, text.trim())
			{
				return Some(format!("{} must match {}", field.id, pattern));
			}
		}
		None
	}

	fn value(&self, out: &mut Map<String, Value>) {
		let Some(id) = self.props.id() else { return };
		let mut object = Map::new();
		for field in &self.fields {
			if !field.id.is_empty() {
				object.insert(field.id.to_string(), field_value(field));
			}
		}
		out.insert(id.to_string(), Value::Object(object));
	}
}

fn cycle_choice(field: &mut FieldData, forward: bool) {
	if field.options.is_empty() {
		return;
	}
	if let FieldValue::Choice(current) = &field.value {
		let len = field.options.len();
		let at = field
			.options
			.iter()
			.position(|option| option == current)
			.unwrap_or(0);
		let next = if forward {
			(at + 1) % len
		} else {
			(at + len - 1) % len
		};
		field.value = FieldValue::Choice(field.options[next].clone());
	}
}

fn toggle_multi(field: &mut FieldData, index: u16) {
	let Some(option) = field.options.get(usize::from(index)) else {
		return;
	};
	let option = option.clone();
	if let FieldValue::Many(values) = &mut field.value {
		if values.contains(&option) {
			values.retain(|value| *value != option);
		} else {
			values.push(option);
			values.sort_by_key(|value| field.options.iter().position(|option| option == value));
		}
	}
}

fn reorder_multi(field: &mut FieldData, option_index: u16, forward: bool) {
	let Some(option) = field.options.get(usize::from(option_index)) else {
		return;
	};
	let FieldValue::Many(values) = &mut field.value else {
		return;
	};
	let Some(at) = values.iter().position(|value| value == option) else {
		return;
	};
	let next = if forward {
		(at + 1).min(values.len().saturating_sub(1))
	} else {
		at.saturating_sub(1)
	};
	if at != next {
		values.swap(at, next);
	}
}

fn field_value(field: &FieldData) -> Value {
	match &field.value {
		FieldValue::Bool(value) => Value::Bool(*value),
		FieldValue::Text(value) => Value::String(value.clone()),
		FieldValue::Choice(value) => Value::String(value.to_string()),
		FieldValue::Many(values) => Value::Array(
			values
				.iter()
				.map(|value| Value::String(value.to_string()))
				.collect(),
		),
		FieldValue::Number(value) => Value::Number((*value).into()),
	}
}

const fn base(theme: &Theme) -> Style {
	Style::new().fg(theme.fg)
}
const fn dim(theme: &Theme) -> Style {
	Style::new().fg(theme.muted)
}

fn paint_field_value(
	ctx: &UiContext,
	frame: &mut Frame,
	x: u16,
	y: u16,
	right: u16,
	field: &FieldData,
	here: bool,
	tint: impl Fn(Style) -> Style,
	scratch: &mut String,
) -> u16 {
	let put = |frame: &mut Frame, x: u16, text: &str, style: Style| {
		frame.put_clipped(x, y, right.saturating_sub(x), text, style)
	};
	match (&field.value, field.kind) {
		(FieldValue::Bool(value), _) => put(
			frame,
			x,
			if *value { "true" } else { "false" },
			tint(Style::new().fg(if *value {
				ctx.theme.ok
			} else {
				ctx.theme.muted
			})),
		),
		(FieldValue::Choice(choice), FieldKind::Enum) => {
			let mut x = put(frame, x, choice, tint(Style::new().fg(ctx.theme.info)));
			if here {
				x = put(frame, x, "  ", tint(dim(&ctx.theme)));
				x = put(frame, x, ctx.charset.arrows().0, tint(dim(&ctx.theme)));
				x = put(frame, x, " ", tint(dim(&ctx.theme)));
				x = put(frame, x, ctx.charset.arrows().1, tint(dim(&ctx.theme)));
			}
			x
		},
		(FieldValue::Choice(choice), _) => {
			let x = put(frame, x, choice, tint(Style::new().fg(ctx.theme.info)));
			put(frame, x, ctx.charset.dropdown(), tint(dim(&ctx.theme)))
		},
		(FieldValue::Many(values), _) => {
			scratch.clear();
			if values.is_empty() {
				scratch.push('—');
			} else {
				for (index, value) in values.iter().enumerate() {
					if index > 0 {
						scratch.push_str(", ");
					}
					scratch.push_str(value);
				}
			}
			let x = put(frame, x, scratch, tint(Style::new().fg(ctx.theme.info)));
			put(frame, x, ctx.charset.dropdown(), tint(dim(&ctx.theme)))
		},
		(FieldValue::Number(value), _) => {
			let mut x = x;
			if here {
				x = put(frame, x, ctx.charset.arrows().0, tint(dim(&ctx.theme)));
				x = put(frame, x, " ", tint(dim(&ctx.theme)));
			}
			scratch.clear();
			let _ = write!(scratch, "{value}");
			x = put(frame, x, scratch, tint(Style::new().fg(ctx.theme.warn)));
			if here {
				x = put(frame, x, " ", tint(dim(&ctx.theme)));
				x = put(frame, x, ctx.charset.arrows().1, tint(dim(&ctx.theme)));
			}
			x
		},
		(FieldValue::Text(text), _) => put(
			frame,
			x,
			if field.masked && !text.is_empty() {
				ctx.charset.icon_named("secret").unwrap_or("secret")
			} else {
				text
			},
			tint(base(&ctx.theme)),
		),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn event_ctx(ctx: &UiContext) -> EventCtx<'_> {
		EventCtx::new(ctx, 40, 10)
	}

	#[test]
	fn navigation_edit_and_values_match_form_contract() {
		let mut form = Form::new()
			.with(Prop::Id, "settings")
			.field(
				Field::new()
					.with(Prop::Id, "name")
					.with(Prop::Kind, "text")
					.with(Prop::Value, "omp"),
			)
			.field(
				Field::new()
					.with(Prop::Id, "theme")
					.with(Prop::Kind, "select")
					.with(Prop::Options, "dark light")
					.with(Prop::Value, "dark"),
			);
		let ctx = UiContext::default();
		let mut ec = event_ctx(&ctx);
		assert_eq!(form.key(&mut ec, Key::Enter), Flow::Consumed);
		assert_eq!(form.key(&mut ec, Key::Char('!')), Flow::Consumed);
		assert_eq!(form.key(&mut ec, Key::Enter), Flow::Consumed);
		assert_eq!(form.key(&mut ec, Key::Down), Flow::Consumed);
		assert_eq!(form.key(&mut ec, Key::Enter), Flow::Consumed);
		assert_eq!(form.key(&mut ec, Key::Down), Flow::Consumed);
		assert_eq!(form.key(&mut ec, Key::Enter), Flow::Consumed);
		let mut values = Map::new();
		form.value(&mut values);
		assert_eq!(values["settings"], serde_json::json!({ "name": "omp!", "theme": "light" }));
	}

	#[test]
	fn validation_reports_the_first_invalid_field() {
		let mut form = Form::new()
			.field(
				Field::new()
					.with(Prop::Id, "name")
					.with(Prop::Required, true),
			)
			.field(
				Field::new()
					.with(Prop::Id, "slug")
					.with(Prop::Match, "[a-z-]+")
					.with(Prop::Value, "Bad Slug"),
			);

		assert_eq!(form.validation_error().as_deref(), Some("name is required"));
		form.fields[0].value = FieldValue::Text("OMP".into());
		assert_eq!(form.validation_error().as_deref(), Some("slug must match [a-z-]+"));
		form.fields[1].value = FieldValue::Text("valid-slug".into());
		assert_eq!(form.validation_error(), None);
	}
}
