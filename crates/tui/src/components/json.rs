use omp_core::{IntoStr, Str};
use serde_json::Value;
use smol_bitmap::SmolBitmap;

use super::text::put_clipped;
use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::{Charset, UiContext},
	frame::{Rect, Style},
	markup::Border,
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

const DEFAULT_MAX_DEPTH: usize = 2;
const DEFAULT_MAX_ROWS: usize = 6;
const DEFAULT_MAX_CHARS: usize = 60;
const MAX_DEPTH_LIMIT: usize = 64;
const MAX_ROWS_LIMIT: usize = 1_000;
const MAX_CHARS_LIMIT: usize = 4_096;

/// A bounded, retained JSON tree backing the `<json>` markup tag.
///
/// Source is parsed when it is assigned. The source-order projection is then
/// retained until one of its bounds changes; paint only clips cached rows to
/// the current rectangle.
pub struct JsonPreview {
	props:    Props,
	slot:     Slot,
	source:   Option<Str>,
	document: Document,
	rows:     Vec<JsonRow>,
	bounds:   Option<Bounds>,
	#[cfg(test)]
	parses:   usize,
	#[cfg(test)]
	projects: usize,
}

impl JsonPreview {
	/// Creates an empty JSON preview.
	pub fn new() -> Self {
		Self {
			props:                 Props::new(),
			slot:                  next_slot(),
			source:                None,
			document:              Document::Invalid(Str::new("expected JSON input")),
			rows:                  Vec::new(),
			bounds:                None,
			#[cfg(test)]
			parses:                0,
			#[cfg(test)]
			projects:              0,
		}
	}

	/// Sets one JSON preview property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self.bounds = None;
		self
	}

	/// Sets one JSON preview property from a string.
	pub fn with_str(self, prop: Prop, value: &str) -> Self {
		self.with(prop, value)
	}

	/// Sets and parses the raw JSON source.
	pub fn text(mut self, source: impl IntoStr) -> Self {
		self.replace_source(source.into_str());
		self
	}

	fn replace_source(&mut self, source: Str) -> bool {
		if self.source.as_ref() == Some(&source) {
			return false;
		}
		self.document = match serde_json::from_str(source.as_ref()) {
			Ok(value) => Document::Valid(value),
			Err(error) => Document::Invalid(Str::new(error.to_string())),
		};
		self.source = Some(source);
		self.bounds = None;
		#[cfg(test)]
		{
			self.parses += 1;
		}
		true
	}

	fn configured_bounds(&self) -> Bounds {
		Bounds {
			max_depth: usize::from(self.props.max_depth().unwrap_or(DEFAULT_MAX_DEPTH as u16))
				.min(MAX_DEPTH_LIMIT),
			max_rows:  usize::from(self.props.max_rows().unwrap_or(DEFAULT_MAX_ROWS as u16))
				.min(MAX_ROWS_LIMIT),
			max_chars: usize::from(self.props.max_chars().unwrap_or(DEFAULT_MAX_CHARS as u16))
				.min(MAX_CHARS_LIMIT),
		}
	}

	fn rebuild(&mut self) {
		let bounds = self.configured_bounds();
		if self.bounds == Some(bounds) {
			return;
		}
		self.rows.clear();
		let mut projector = Projector { bounds, rows: &mut self.rows };
		match &self.document {
			Document::Valid(value) => projector.root(value),
			Document::Invalid(error) => projector.invalid(error),
		}
		self.bounds = Some(bounds);
		#[cfg(test)]
		{
			self.projects += 1;
		}
	}
}

impl Default for JsonPreview {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for JsonPreview {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		self.rebuild();
		let natural = self
			.rows
			.iter()
			.map(|row| row.width(ctx.charset))
			.max()
			.unwrap_or(0);
		(natural.min(8), natural)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		self.rebuild();
		u16::try_from(self.rows.len()).unwrap_or(u16::MAX)
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.rebuild();
		let clip = pc.clip.min(rect.y.saturating_add(rect.height));
		let right = rect.x.saturating_add(rect.width);
		let base = self.props.style(&pc.ctx.theme);
		for (index, row) in self.rows.iter().enumerate() {
			let y = rect.y.saturating_add(index as u16);
			if y >= clip {
				break;
			}
			row.paint(pc, rect.x, y, right, base);
		}
	}

	fn set_text(&mut self, _ctx: &UiContext, text: Str) -> bool {
		self.replace_source(text)
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Bounds {
	max_depth: usize,
	max_rows:  usize,
	max_chars: usize,
}

enum Document {
	Valid(Value),
	Invalid(Str),
}

struct Projector<'a> {
	bounds: Bounds,
	rows:   &'a mut Vec<JsonRow>,
}

impl Projector<'_> {
	fn root(&mut self, value: &Value) {
		let mut ancestors = SmolBitmap::new();
		match value {
			Value::Object(values) if !values.is_empty() => {
				let count = values.len();
				for (index, (key, value)) in values.iter().enumerate() {
					self.node(value, key, &mut ancestors, 0, index + 1 == count, 1);
					if self.full() {
						break;
					}
				}
			},
			Value::Array(values) if !values.is_empty() => {
				let count = values.len();
				for (index, value) in values.iter().enumerate() {
					self.node(value, &format!("[{index}]"), &mut ancestors, 0, index + 1 == count, 1);
					if self.full() {
						break;
					}
				}
			},
			_ => self.node(value, "value", &mut ancestors, 0, true, 0),
		}
	}

	fn invalid(&mut self, error: &str) {
		if self.full() {
			return;
		}
		self.rows.push(JsonRow {
			ancestors:      SmolBitmap::new(),
			ancestor_depth: 0,
			last:           true,
			content:        RowContent::Invalid(clipped(
				&format!("Invalid JSON: {error}"),
				self.bounds.max_chars,
			)),
		});
	}

	const fn full(&self) -> bool {
		self.rows.len() >= self.bounds.max_rows
	}

	fn push(&mut self, row: JsonRow) -> bool {
		if self.full() {
			return false;
		}
		self.rows.push(row);
		true
	}

	fn node(
		&mut self,
		value: &Value,
		key: &str,
		ancestors: &mut SmolBitmap,
		ancestor_depth: usize,
		last: bool,
		depth: usize,
	) {
		if self.full() {
			return;
		}
		let key = clipped(key, self.bounds.max_chars);
		let content = match value {
			Value::Null => RowContent::Scalar {
				key,
				value: clipped("null", self.bounds.max_chars),
				kind: ScalarKind::Null,
			},
			Value::Bool(value) => RowContent::Scalar {
				key,
				value: clipped(if *value { "true" } else { "false" }, self.bounds.max_chars),
				kind: ScalarKind::Bool,
			},
			Value::Number(value) => RowContent::Scalar {
				key,
				value: clipped(&value.to_string(), self.bounds.max_chars),
				kind: ScalarKind::Number,
			},
			Value::String(_) => RowContent::Scalar {
				key,
				value: clipped(
					&serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()),
					self.bounds.max_chars,
				),
				kind: ScalarKind::String,
			},
			Value::Array(_) => RowContent::Container { key, kind: ContainerKind::Array },
			Value::Object(_) => RowContent::Container { key, kind: ContainerKind::Object },
		};
		if !self.push(JsonRow { ancestors: ancestors.clone(), ancestor_depth, last, content }) {
			return;
		}

		let (children, marker) = match value {
			Value::Array(values) if values.is_empty() => (Children::None, Some(Marker::Array)),
			Value::Object(values) if values.is_empty() => (Children::None, Some(Marker::Object)),
			Value::Array(_) | Value::Object(_) if depth >= self.bounds.max_depth => {
				(Children::None, Some(Marker::Ellipsis))
			},
			Value::Array(values) => (Children::Array(values), None),
			Value::Object(values) => (Children::Object(values), None),
			_ => (Children::None, None),
		};

		if let Some(marker) = marker {
			ancestors.set(ancestor_depth, !last);
			self.push(JsonRow {
				ancestors:      ancestors.clone(),
				ancestor_depth: ancestor_depth + 1,
				last:           true,
				content:        RowContent::Marker(marker),
			});
			ancestors.set(ancestor_depth, false);
			return;
		}

		ancestors.set(ancestor_depth, !last);
		match children {
			Children::Array(values) => {
				let count = values.len();
				for (index, value) in values.iter().enumerate() {
					self.node(
						value,
						&format!("[{index}]"),
						ancestors,
						ancestor_depth + 1,
						index + 1 == count,
						depth + 1,
					);
					if self.full() {
						break;
					}
				}
			},
			Children::Object(values) => {
				let count = values.len();
				for (index, (key, value)) in values.iter().enumerate() {
					self.node(value, key, ancestors, ancestor_depth + 1, index + 1 == count, depth + 1);
					if self.full() {
						break;
					}
				}
			},
			Children::None => {},
		}
		ancestors.set(ancestor_depth, false);
	}
}

enum Children<'a> {
	Array(&'a [Value]),
	Object(&'a serde_json::Map<String, Value>),
	None,
}

struct JsonRow {
	ancestors:      SmolBitmap,
	ancestor_depth: usize,
	last:           bool,
	content:        RowContent,
}

impl JsonRow {
	fn width(&self, charset: Charset) -> u16 {
		let guides = u16::try_from(self.ancestor_depth.saturating_add(1))
			.unwrap_or(u16::MAX)
			.saturating_mul(3);
		guides.saturating_add(self.content.width(charset))
	}

	fn paint(&self, pc: &mut PaintCtx<'_>, mut x: u16, y: u16, right: u16, base: Style) {
		let guide = base.fg(pc.ctx.theme.muted);
		let (branch, last, cont) = pc.ctx.charset.guides(Border::Square);
		for index in 0..self.ancestor_depth {
			x = put_clipped(
				pc.frame,
				x,
				y,
				right,
				if self.ancestors.get(index) {
					cont
				} else {
					"  "
				},
				guide,
			);
			x = put_clipped(pc.frame, x, y, right, " ", guide);
		}
		x = put_clipped(pc.frame, x, y, right, if self.last { last } else { branch }, guide);
		x = put_clipped(pc.frame, x, y, right, " ", guide);
		self.content.paint(pc, x, y, right, base);
	}
}

enum RowContent {
	Scalar { key: Clipped, value: Clipped, kind: ScalarKind },
	Container { key: Clipped, kind: ContainerKind },
	Marker(Marker),
	Invalid(Clipped),
}

impl RowContent {
	fn width(&self, charset: Charset) -> u16 {
		match self {
			Self::Scalar { key, value, .. } => key
				.width(charset)
				.saturating_add(2)
				.saturating_add(value.width(charset)),
			Self::Container { key, .. } => key.width(charset).saturating_add(3),
			Self::Marker(marker) => cell_width(marker.text(charset)),
			Self::Invalid(message) => message.width(charset),
		}
	}

	fn paint(&self, pc: &mut PaintCtx<'_>, mut x: u16, y: u16, right: u16, base: Style) {
		match self {
			Self::Scalar { key, value, kind } => {
				x = key.paint(pc, x, y, right, base.fg(pc.ctx.theme.accent));
				x = put_clipped(pc.frame, x, y, right, ": ", base.fg(pc.ctx.theme.muted));
				value.paint(pc, x, y, right, base.fg(kind.color(pc.ctx)))
			},
			Self::Container { key, kind } => {
				x = key.paint(pc, x, y, right, base.fg(pc.ctx.theme.accent));
				put_clipped(pc.frame, x, y, right, kind.suffix(), base.fg(pc.ctx.theme.muted))
			},
			Self::Marker(marker) => put_clipped(
				pc.frame,
				x,
				y,
				right,
				marker.text(pc.ctx.charset),
				base.fg(pc.ctx.theme.muted),
			),
			Self::Invalid(message) => message.paint(pc, x, y, right, base.fg(pc.ctx.theme.err)),
		};
	}
}

#[derive(Clone, Copy)]
enum ScalarKind {
	Null,
	Bool,
	Number,
	String,
}

impl ScalarKind {
	const fn color(self, ctx: &UiContext) -> crate::Color {
		match self {
			Self::Null => ctx.theme.muted,
			Self::Bool => ctx.theme.warn,
			Self::Number => ctx.theme.secondary,
			Self::String => ctx.theme.ok,
		}
	}
}

#[derive(Clone, Copy)]
enum ContainerKind {
	Array,
	Object,
}

impl ContainerKind {
	const fn suffix(self) -> &'static str {
		match self {
			Self::Array => " []",
			Self::Object => " {}",
		}
	}
}

#[derive(Clone, Copy)]
enum Marker {
	Array,
	Object,
	Ellipsis,
}

impl Marker {
	const fn text(self, charset: Charset) -> &'static str {
		match self {
			Self::Array => "[]",
			Self::Object => "{}",
			Self::Ellipsis if matches!(charset, Charset::Ascii) => "...",
			Self::Ellipsis => "…",
		}
	}
}

struct Clipped {
	head:      Str,
	truncated: bool,
}

impl Clipped {
	fn width(&self, charset: Charset) -> u16 {
		cell_width(&self.head).saturating_add(if self.truncated {
			cell_width(ellipsis(charset))
		} else {
			0
		})
	}

	fn paint(&self, pc: &mut PaintCtx<'_>, mut x: u16, y: u16, right: u16, style: Style) -> u16 {
		x = put_clipped(pc.frame, x, y, right, &self.head, style);
		if self.truncated {
			x = put_clipped(pc.frame, x, y, right, ellipsis(pc.ctx.charset), style);
		}
		x
	}
}

const fn ellipsis(charset: Charset) -> &'static str {
	if matches!(charset, Charset::Ascii) {
		"..."
	} else {
		"…"
	}
}

/// Truncates at JavaScript's UTF-16 column boundary. If that boundary splits
/// a surrogate pair, its UTF-8 projection includes the replacement scalar.
fn clipped(text: &str, max_chars: usize) -> Clipped {
	if text.len() <= max_chars {
		return Clipped { head: Str::new(text), truncated: false };
	}
	let mut units = 0usize;
	for (index, character) in text.char_indices() {
		let next = units.saturating_add(character.len_utf16());
		if next > max_chars {
			let mut head = String::from(&text[..index]);
			if units < max_chars {
				head.push('\u{fffd}');
			}
			return Clipped { head: Str::new(head), truncated: true };
		}
		units = next;
		if units == max_chars {
			let end = index + character.len_utf8();
			return if end == text.len() {
				Clipped { head: Str::new(text), truncated: false }
			} else {
				Clipped { head: Str::new(&text[..end]), truncated: true }
			};
		}
	}
	Clipped { head: Str::new(text), truncated: false }
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		Frame,
		frame::Size,
		test_support::{frame_cell_style, frame_row_text},
	};

	fn paint(component: &mut JsonPreview, ctx: &UiContext, width: u16) -> Frame {
		let height = component.height(ctx, width);
		let mut frame = Frame::new(Size::new(width, height));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		component.paint(
			&mut PaintCtx::new(&mut frame, ctx, &mut hits, &mut wakes),
			Rect::new(0, 0, width, height),
		);
		frame
	}

	fn rows(frame: &Frame) -> Vec<String> {
		(0..frame.size().height)
			.map(|row| frame_row_text(frame, row))
			.collect()
	}

	fn column_of(line: &str, needle: &str) -> u16 {
		let byte = line.find(needle).expect("needle present");
		cell_width(&line[..byte])
	}

	#[test]
	fn projects_objects_arrays_and_scalars_in_source_order() {
		let mut json = JsonPreview::new().text(r#"{"first":1,"second":[true,"yes"],"last":null}"#);
		let ctx = UiContext::default();
		let frame = paint(&mut json, &ctx, 40);
		let lines = rows(&frame);
		assert_eq!(lines[0], "├─ first: 1");
		assert_eq!(lines[1], "├─ second []");
		assert_eq!(lines[2], "│  ├─ [0]: true");
		assert_eq!(lines[3], "│  └─ [1]: \"yes\"");
		assert_eq!(lines[4], "└─ last: null");
		let key_column = column_of(&lines[0], "first");
		let value_column = column_of(&lines[0], "1");
		assert_eq!(frame_cell_style(&frame, 0, 0).foreground_color(), ctx.theme.muted);
		assert_eq!(frame_cell_style(&frame, key_column, 0).foreground_color(), ctx.theme.accent);
		assert_eq!(frame_cell_style(&frame, value_column, 0).foreground_color(), ctx.theme.secondary);
		let bool_column = column_of(&lines[2], "true");
		let string_column = column_of(&lines[3], "\"yes\"");
		let null_column = column_of(&lines[4], "null");
		assert_eq!(frame_cell_style(&frame, bool_column, 2).foreground_color(), ctx.theme.warn);
		assert_eq!(frame_cell_style(&frame, string_column, 3).foreground_color(), ctx.theme.ok);
		assert_eq!(frame_cell_style(&frame, null_column, 4).foreground_color(), ctx.theme.muted);
	}

	#[test]
	fn retains_false_ancestors_before_deeper_continuations() {
		let mut json = JsonPreview::new()
			.text(r#"{"root":{"first":{"leaf":1},"last":2}}"#)
			.with(Prop::MaxDepth, 3_u16);
		let frame = paint(&mut json, &UiContext::default(), 32);
		assert_eq!(rows(&frame), [
			"└─ root {}",
			"   ├─ first {}",
			"   │  └─ leaf: 1",
			"   └─ last: 2",
		]);
	}

	#[test]
	fn empty_objects_and_arrays_keep_their_value_kind() {
		let mut json = JsonPreview::new().text(r#"{"object":{},"array":[]}"#);
		let frame = paint(&mut json, &UiContext::default(), 32);
		assert_eq!(rows(&frame), ["├─ object {}", "│  └─ {}", "└─ array []", "   └─ []"]);
	}

	#[test]
	fn depth_bound_replaces_descendants_with_a_marker() {
		let mut json = JsonPreview::new()
			.text(r#"{"a":{"b":{"c":1}}}"#)
			.with(Prop::MaxDepth, 1_u16);
		let frame = paint(&mut json, &UiContext::default(), 32);
		assert_eq!(rows(&frame), ["└─ a {}", "   └─ …"]);
	}

	#[test]
	fn row_bound_keeps_only_complete_leading_rows() {
		let mut json = JsonPreview::new()
			.text(r#"{"a":1,"b":2,"c":3}"#)
			.with(Prop::MaxRows, 2_u16);
		let frame = paint(&mut json, &UiContext::default(), 32);
		assert_eq!(rows(&frame), ["├─ a: 1", "├─ b: 2"]);
	}

	#[test]
	fn scalar_bound_matches_utf16_surrogate_slicing() {
		let mut json = JsonPreview::new()
			.text(r#"{"emoji":"😀x"}"#)
			.with(Prop::MaxChars, 2_u16);
		let frame = paint(&mut json, &UiContext::default(), 32);
		assert_eq!(rows(&frame), ["└─ em…: \"�…"]);
	}

	#[test]
	fn invalid_json_is_a_styled_bounded_row() {
		let mut json = JsonPreview::new()
			.text("{not json")
			.with(Prop::MaxChars, 18_u16);
		let ctx = UiContext::default();
		let frame = paint(&mut json, &ctx, 40);
		let line = frame_row_text(&frame, 0);
		assert!(line.starts_with("└─ Invalid JSON:"));
		assert!(line.ends_with('…'));
		assert_eq!(frame_cell_style(&frame, 3, 0).foreground_color(), ctx.theme.err);
	}

	#[test]
	fn ascii_charset_degrades_guides_and_ellipsis() {
		let ctx = UiContext { charset: Charset::Ascii, ..UiContext::default() };
		let mut json = JsonPreview::new()
			.text(r#"{"a":{"b":1}}"#)
			.with(Prop::MaxDepth, 1_u16);
		let frame = paint(&mut json, &ctx, 32);
		assert_eq!(rows(&frame), ["`- a {}", "   `- ..."]);
	}

	#[test]
	fn parse_and_projection_are_retained_across_frames() {
		let mut json = JsonPreview::new().text(r#"{"a":[1,2]}"#);
		let ctx = UiContext::default();
		let _ = paint(&mut json, &ctx, 20);
		let _ = paint(&mut json, &ctx, 12);
		assert_eq!(json.parses, 1);
		assert_eq!(json.projects, 1);
	}
}
