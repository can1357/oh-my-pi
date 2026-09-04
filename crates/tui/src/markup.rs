//! Parse-once html-like markup for declarative component trees.
//!
//! Grammar (subset, grows with the component zoo):
//! `<col>`, `<row>`, `<box>`, `<text>`, `<md>`, `<latex>`, `<pre>`,
//! `<hr/>`, `<spacer/>` with attributes `gap`, `pad="y x"`, `grow[=n]`,
//! `w=N|N%`, `min`, `max`, `h` (fixed height — a layout boundary),
//! `border=square|round|heavy|double|dash` (paints a frame on `<box>`,
//! `<row>`, and `<col>`, insetting children by one cell), `bc=`/`edge=`
//! (border color), `title="…"`/`footer="…"` (frame labels, each with a
//! `-align=left|center|right` variant), `align`, `valign`, `justify`, the
//! `wrap` and `truncate` flags, color tokens (`accent`, `muted`, …), and the
//! flag styles `bold`/`dim`/`italic`/`underline`/`strike`/`reverse`.
//! Attributes are not per-tag: each applies wherever its axis exists.
//! `<row>` lays children side by side, `<col>` stacks them, and both honor
//! `pad`/`gap`. `align` positions along the writing axis — inside a row it
//! distributes leftover width, inside a column it shrink-wraps and
//! positions each child. `valign` is the cross axis, and says how a
//! container places *its own* children: `start`, `center`, `end`, or
//! `stretch`. A row stretches by default (flex `align-items: stretch`), so
//! a `bg=` panel fills its share of the line; `valign=start` opts out.
//! `justify` distributes leftover row width: `center`, `end`, or
//! `between`, which expands the gaps so the first and last child hug the
//! edges. A `wrap` row flows children onto as many lines as needed — each
//! line holds as many children as fit and is solved and justified on its
//! own, degrading to one child per line when nothing fits side by side.
//! `truncate` clips a text child to one line with a trailing ellipsis
//! instead of wrapping (`truncate=start` keeps the tail behind a leading
//! ellipsis — ids and paths whose suffix matters), and cascades from the
//! container to its implicit text children. Bare text lines inside a `<row>`
//! are separate children laid side by side (consecutive `|` table lines stay
//! one child); columns keep multi-line text as a single Markdown leaf.
//! `grow` claims leftover space on the container's axis: width in a row,
//! height in a column that has a fixed `h`. A `<hr/>` follows the axis
//! too — a vertical separator inside a row, a horizontal divider anywhere
//! else. `fg=` and `bg=` (alias `on=`) accept theme tokens and every CSS
//! color form — named colors, `#`-hex, `rgb()`, `hsl()`, `hwb()`, `hsv()`,
//! `lab()`, `lch()`, `oklab()`, `oklch()`, and `color()` — via the crate's
//! `color` module.
//! A two-stop value (`start..end`) makes a gradient; `angle=N` sets its
//! direction in screen degrees (0 left-to-right, 90 top-to-bottom). Backgrounds
//! are opt-in, so every element (boxes included) is transparent until `bg=`
//! names one. On a framed container the fill stops inside the border; the
//! `bleed` flag extends it behind the frame. Attribute values may
//! be bare, `'single'`-, or `"double"`-quoted. Bare text between tags is an
//! implicit Markdown leaf — every Markdown feature works anywhere text
//! does, and `<text>` is the verbatim escape hatch: no tags, no Markdown,
//! though HTML character references (`&amp;`, `&lt;`, …) still decode so
//! producers can embed arbitrary text safely. Markup owns `<` only
//! for its own known tags outside Markdown code context, so `<em>` HTML,
//! `<https://x>` autolinks, fences, code spans, math, comments, and
//! backslash escapes behave exactly as they do inside `<md>`. Inside
//! `<md>` only line-start block markup is recognized and interactive tags
//! are rejected. Markdown indentation is measured from the enclosing
//! tag's own column, not from column zero, so pretty-printing a document
//! is structure rather than a chain of indented code blocks; a body is
//! dedented by that column before it renders, and four columns past it
//! still opens a code block. Agents never state cell
//! geometry beyond optional hints; the layout engine owns measurement.
//! `<ico:name/>` embeds a semantic icon anywhere text or a `title=` value
//! appears; the active [`crate::Charset`] picks the glyph
//! (unicode | nerd | ascii) and unknown names degrade to the bare name.
//! `<pre>` is a verbatim block for ASCII/half-block art.
//! `<segmented>` owns `<option value icon label/>` children and exposes one
//! selected value; `<checkbox checked label/>` exposes a boolean value.
//! `<table>` holds `<tr>` rows of `<td>` cells and solves every column
//! once across all rows, so cells align vertically; surplus room goes to
//! `grow` cells' columns and a deficit shrinks the widest flexible column
//! first. `<td>` lays its children out side by side; with `truncate` it
//! flattens text children into one styled line clipped by a single
//! trailing ellipsis. Tables are layout-only — for an interactive list,
//! `<option>` accepts the same `<td>` cells and the hosting `<select>`
//! owns cursor, filter, hover, and activation over aligned rows.

use std::{num::ParseIntError, str::FromStr};

use omp_core::{Str, StrMut};
use strum::{EnumString, IntoStaticStr};

use crate::{
	component::{Cached, Component},
	components::{
		Boxed, Button, Callout, Checkbox, Choice, Col, CustomElement, DiffStat, DiffView, EditorPane,
		Fact, Field, Files, Form, Hr, Icon, Img, Input, JsonPreview, Latex, Markdown, NumberLeaf,
		Pre, Progress, Pulse, Qr, Quote, Radio, Row, Scroll, Segment, Segmented, Select,
		SelectOption, Spacer, Spinner, State, Status, Strike, Table, TableCell, TableRow, Tabs,
		TaskStatus, TextLeaf, Time, Todo, TodoTask, Tree, TreeNode, Wizard,
	},
	context::{Charset, UiContext},
	markdown,
	props::{Prop, PropValue, Props},
};

/// Border glyph set for framed containers (`<box>`, bordered `<row>`/`<col>`).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, EnumString, IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum Border {
	/// Sharp corners: `┌ ┐ └ ┘`.
	#[default]
	Square,
	/// Dashed strokes: `╌ ┆`.
	Dash,
	/// Rounded corners: `╭ ╮ ╰ ╯`.
	Round,
	/// Heavy strokes: `┏ ┓ ┗ ┛`.
	Heavy,
	/// Double strokes: `╔ ╗ ╚ ╝`.
	Double,
}

/// Width request for a row child.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Dim {
	/// Fixed cell hint.
	Cells(u16),
	/// Percentage of the row's content width.
	Pct(u8),
}

impl FromStr for Dim {
	type Err = ParseIntError;

	/// Parses a fixed cell count (`12`) or a percentage (`50%`).
	fn from_str(value: &str) -> Result<Self, Self::Err> {
		match value.strip_suffix('%') {
			Some(percent) => percent.parse().map(Self::Pct),
			None => value.parse().map(Self::Cells),
		}
	}
}

/// Cross-axis content alignment.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, EnumString, IntoStaticStr)]
pub enum Align {
	#[default]
	#[strum(to_string = "start", serialize = "left")]
	Start,
	#[strum(to_string = "center", serialize = "middle")]
	Center,
	#[strum(to_string = "end", serialize = "right")]
	End,
}
/// Main-axis distribution for a row's children.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, EnumString, IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum Justify {
	#[default]
	Start,
	Center,
	End,
	Between,
}

/// Which end of a truncated line is clipped away.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, EnumString, IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum Truncate {
	/// Keep the head; a trailing ellipsis replaces the overflow.
	#[default]
	End,
	/// Keep the tail; a leading ellipsis replaces the overflow — ids and
	/// paths whose distinctive part is the suffix.
	Start,
}
/// How text flows to the layout width.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, EnumString, IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum TextWrap {
	/// Break at word boundaries, collapsing the whitespace at each break.
	#[default]
	Word,
	/// Flow grapheme-exact to the width like a bare terminal: every break
	/// is a byte-preserving soft wrap the renderer re-joins for native
	/// copy.
	Char,
	/// Preserve authored whitespace and newlines verbatim without soft
	/// wrapping, matching CSS `white-space: pre`.
	Pre,
}

/// How a container distributes leftover vertical space among its children.
///
/// Unset means "inherit the axis default": a `<row>` stretches its children
/// to the tallest one (like flex `align-items: stretch`), every other
/// container leaves them at the top.
#[derive(Clone, Copy, Debug, Eq, PartialEq, EnumString, IntoStaticStr)]
pub enum VAlign {
	/// Children keep their own height, at the top.
	#[strum(to_string = "start", serialize = "top")]
	Start,
	/// Centered in the available height.
	#[strum(to_string = "center", serialize = "middle")]
	Center,
	/// Flush with the bottom.
	#[strum(to_string = "end", serialize = "bottom")]
	End,
	/// Every child's rect spans the full height, so a `bg=` panel fills it.
	#[strum(to_string = "stretch", serialize = "fill")]
	Stretch,
}

/// Markup rejection with byte position context.
#[derive(Debug, thiserror::Error)]
#[error("markup error at byte {at}: {message}")]
pub struct ParseError {
	/// Human-readable failure description.
	pub message: String,
	/// Byte offset into the source.
	pub at:      usize,
}

/// Origin of a TML document.
///
/// Extension markup cannot instantiate renderer chrome reserved to the core.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MarkupOrigin {
	/// Markup produced by omp itself.
	#[default]
	Core,
	/// Markup received from an authenticated extension connection.
	Extension,
}

/// Parses core-owned markup into a retained component tree rooted at a [`Col`].
pub fn parse(source: &Str, ctx: &UiContext) -> Result<Cached, ParseError> {
	parse_with_origin(source, ctx, MarkupOrigin::Core)
}

/// Parses markup at its trust boundary, retaining unknown elements while
/// recovering from malformed tags and attributes.
pub fn parse_with_origin(
	source: &Str,
	ctx: &UiContext,
	origin: MarkupOrigin,
) -> Result<Cached, ParseError> {
	parse_component_with_origin(source, ctx, origin).map(Cached::new)
}

/// Parses runtime markup directly into a retained component.
///
/// This is the component-level counterpart of [`parse_with_origin`] for
/// projection registries which need to embed extension TML inside a larger
/// typed tree instead of creating a standalone [`crate::Ui`].
///
/// # Errors
/// Returns [`ParseError`] for malformed markup.
pub fn parse_component_with_origin(
	source: &Str,
	ctx: &UiContext,
	origin: MarkupOrigin,
) -> Result<Box<dyn Component>, ParseError> {
	let mut parser = Parser { source, src: source, ctx, fragment: false, origin };
	let (parts, _) = parser.parse_children(0, None, false, 0, "col", &Props::new())?;
	let children = cached_children(parts, "col")?;
	Ok(build("col", Props::new(), children, &Str::default())
		.expect("the root col is a catalog component"))
}

pub fn parse_md_fragment_inheriting(
	text: &Str,
	ctx: &UiContext,
	host: &Props,
) -> Result<Vec<Cached>, ParseError> {
	if text.is_empty() {
		return Ok(Vec::new());
	}
	let inherited = child_props(host);
	let mut parser =
		Parser { source: text, src: text, ctx, fragment: true, origin: MarkupOrigin::Core };
	let (first, mut children, _) = parser.scan_md(0, 0, &inherited, false)?;
	children.insert(0, markdown_part(first, inherited));
	Ok(children)
}

#[allow(
	clippy::large_enum_variant,
	reason = "parser nodes move once into their final owners; boxing the larger variants would add \
	          one allocation per parsed node"
)]
#[derive(IntoStaticStr)]
#[strum(serialize_all = "lowercase", const_into_str)]
enum Parsed {
	#[strum(to_string = "content")]
	Cached {
		cached:   Box<Cached>,
		text:     Option<Str>,
		at:       usize,
		implicit: bool,
	},
	Option {
		option: SelectOption,
		at:     usize,
	},
	Segment {
		segment: Segment,
		at:      usize,
	},
	Tab {
		title:    Str,
		icon:     Str,
		children: Vec<Cached>,
		at:       usize,
	},
	#[strum(to_string = "node")]
	TreeItem {
		node: TreeNode,
		at:   usize,
	},
	Task {
		task: TodoTask,
		at:   usize,
	},
	Field {
		field: Field,
		at:    usize,
	},
	Step {
		title:    Str,
		children: Vec<Cached>,
		at:       usize,
	},
	#[strum(to_string = "tr")]
	TableRow {
		row: Box<TableRow>,
		at:  usize,
	},
	#[strum(to_string = "td")]
	Cell {
		cell: TableCell,
		at:   usize,
	},
}

impl Parsed {
	fn into_cached(self, parent: &str) -> Result<Cached, ParseError> {
		match self {
			Self::Cached { cached, .. } => Ok(*cached),
			Self::Option { at, .. } => Err(parent_error("option", parent, at)),
			Self::Segment { at, .. } => Err(parent_error("segment", parent, at)),
			Self::Tab { at, .. } => Err(parent_error("tab", parent, at)),
			Self::TreeItem { at, .. } => Err(parent_error("node", parent, at)),
			Self::Task { at, .. } => Err(parent_error("task", parent, at)),
			Self::Field { at, .. } => Err(parent_error("field", parent, at)),
			Self::Step { at, .. } => Err(parent_error("step", parent, at)),
			Self::TableRow { at, .. } => Err(parent_error("tr", parent, at)),
			Self::Cell { at, .. } => Err(parent_error("td", parent, at)),
		}
	}

	const fn name(&self) -> &'static str {
		self.into_str()
	}
}

fn parent_error(tag: &str, parent: &str, at: usize) -> ParseError {
	ParseError { message: format!("<{tag}> is not allowed directly inside <{parent}>"), at }
}

fn cached_children(parts: Vec<Parsed>, parent: &str) -> Result<Vec<Cached>, ParseError> {
	parts
		.into_iter()
		.map(|part| part.into_cached(parent))
		.collect()
}

struct Parser<'a> {
	source:   &'a Str,
	src:      &'a str,
	ctx:      &'a UiContext,
	fragment: bool,
	origin:   MarkupOrigin,
}

impl Parser<'_> {
	/// Scans a container body after all literal Markdown guards have run.
	fn parse_children(
		&mut self,
		body_start: usize,
		closing: Option<&str>,
		restricted: bool,
		indent: usize,
		parent_tag: &str,
		parent_props: &Props,
	) -> Result<(Vec<Parsed>, usize), ParseError> {
		let mut parts = Vec::new();
		let mut segment_start = body_start;
		let mut at = body_start;
		let mut fence = FenceScan::segment(indent);
		while at < self.src.len() {
			let Some(offset) = self.src[at..].find('<') else {
				break;
			};
			fence.consume(&self.src[at..at + offset]);
			at += offset;
			if self.src[at..].starts_with("<!--") {
				let skip = self.src[at + 4..]
					.find("-->")
					.map_or(1, |end| end + 4 + "-->".len());
				fence.skip(&self.src[at..at + skip]);
				at += skip;
				continue;
			}
			let name = tag_name(&self.src[at + 1..]);
			let escaped = self.src[segment_start..at]
				.bytes()
				.rev()
				.take_while(|&byte| byte == b'\\')
				.count() % 2
				== 1;
			let literal = escaped
				|| fence.in_code()
				|| fence.in_code_span(&self.src[at..])
				|| in_math_span(&self.src[segment_start..], at - segment_start);
			if literal || name.is_none() {
				fence.consume(&self.src[at..=at]);
				at += 1;
				continue;
			}
			let name = name.unwrap_or_default();
			let Some(close) = tag_close(&self.src[at + 1..]).map(|end| end + at + 1) else {
				break;
			};
			let is_closing = self.src[at + 1..].starts_with('/');
			let raw = &self.src[at + 1..close];
			let self_closing = raw.ends_with('/');
			let catalog = is_catalog_tag(name)
				&& !(self.origin == MarkupOrigin::Extension && is_reserved_chrome_tag(name));
			let custom = !catalog
				&& !is_markdown_html_tag(name)
				&& if is_closing {
					closing == Some(name)
				} else {
					self_closing || has_matching_close(&self.src[close + 1..], name)
				};
			if !catalog && !custom {
				fence.consume(&self.src[at..=at]);
				at += 1;
				continue;
			}
			if is_closing {
				if closing != Some(name) && (restricted || self.fragment) {
					return Err(ParseError {
						message: format!(
							"closing </{name}> does not match open <{}>",
							closing.unwrap_or("nothing")
						),
						at,
					});
				}
				self.add_text(&mut parts, parent_tag, parent_props, segment_start, at, indent);
				if closing == Some(name) {
					return Ok((parts, close + 1));
				}
				if closing.is_some() {
					return Ok((parts, at));
				}
				at = close + 1;
				segment_start = at;
				fence = FenceScan::segment(indent);
				continue;
			}
			self.add_text(&mut parts, parent_tag, parent_props, segment_start, at, indent);
			let (part, next) = self.parse_element(at, close, restricted, parent_props)?;
			parts.push(part);
			at = next;
			segment_start = at;
			fence = FenceScan::segment(indent);
		}
		if closing.is_some() && (restricted || self.fragment) {
			return Err(ParseError {
				message: format!("unclosed <{}> tag", closing.unwrap_or_default()),
				at:      self.src.len(),
			});
		}
		self.add_text(&mut parts, parent_tag, parent_props, segment_start, self.src.len(), indent);
		Ok((parts, self.src.len()))
	}

	fn parse_element(
		&mut self,
		at: usize,
		close: usize,
		restricted: bool,
		inherited: &Props,
	) -> Result<(Parsed, usize), ParseError> {
		let raw = &self.src[at + 1..close];
		let self_closing = raw.ends_with('/');
		let raw = raw.strip_suffix('/').unwrap_or(raw);
		let (name, attrs) = raw.split_once(char::is_whitespace).unwrap_or((raw, ""));
		let indent = leading_spaces(line_of(self.src, at));
		if restricted && is_interactive_tag(name) {
			return Err(ParseError {
				message: format!("interactive tag <{name}> is not allowed inside <md>"),
				at,
			});
		}
		let mut props =
			apply_attrs(attrs, at, self.source, self.ctx, inherited, !self.fragment && !restricted)?;
		let tag = self.source.slice_ref(name);
		let name = tag.as_str();
		if self.fragment && (props.contains(Prop::Id) || props.contains(Prop::When)) {
			return Err(ParseError {
				message: "id= and when= are not allowed in dynamic Markdown".into(),
				at,
			});
		}
		if name == "box" {
			if !props.contains(Prop::Border) {
				props
					.try_set(Prop::Border, PropValue::Border(Border::Square))
					.unwrap();
			}
			if !props.contains(Prop::PadX) {
				props.try_set(Prop::PadX, PropValue::U16(1)).unwrap();
			}
		} else if name == "spacer" && !props.contains(Prop::Grow) {
			props.try_set(Prop::Grow, PropValue::F32(1.0)).unwrap();
		}
		let body_start = close + 1;
		if self_closing {
			return finish_element(name, props, Vec::new(), Str::default(), at)
				.map(|part| (part, body_start));
		}
		if matches!(
			name,
			"pre" | "latex" | "callout" | "diff" | "json" | "files" | "quote" | "choice" | "qr"
		) {
			let closer = match name {
				"pre" => "</pre>",
				"qr" => "</qr>",
				"latex" => "</latex>",
				"callout" => "</callout>",
				"diff" => "</diff>",
				"json" => "</json>",
				"files" => "</files>",
				"quote" => "</quote>",
				"choice" => "</choice>",
				_ => unreachable!(),
			};
			let end = self.src[body_start..]
				.find(closer)
				.map_or(self.src.len(), |offset| body_start + offset);
			let trim: &[_] = if name == "pre" {
				&['\n', '\r']
			} else if matches!(name, "json" | "files" | "quote" | "choice") {
				&[]
			} else {
				&['\n']
			};
			let body = self.src[body_start..end].trim_matches(trim);
			let body = decode_raw_body(self.source, body);
			let part = finish_element(name, props, Vec::new(), body, at)?;
			return Ok((part, (end + closer.len()).min(self.src.len())));
		}
		if matches!(name, "text" | "button" | "icon") {
			let closer = match name {
				"text" => "</text>",
				"button" => "</button>",
				"icon" => "</icon>",
				_ => unreachable!(),
			};
			let end = self.src[body_start..]
				.find(closer)
				.map(|offset| body_start + offset);
			if end.is_none() && (restricted || self.fragment) {
				return Err(ParseError {
					message: format!("unclosed <{name}> tag"),
					at:      self.src.len(),
				});
			}
			let end = end.unwrap_or(self.src.len());
			let body =
				decode_raw_body(self.source, self.src[body_start..end].trim_matches(['\n', '\r']));
			let part = finish_element(name, props, Vec::new(), body, at)?;
			return Ok((part, (end + closer.len()).min(self.src.len())));
		}
		if name == "md" {
			return self.parse_md(body_start, indent, props, true);
		}
		if is_leaf_tag(name) {
			return finish_element(name, props, Vec::new(), Str::default(), at)
				.map(|part| (part, body_start));
		}
		let child_props = child_props(&props);
		let (parts, end) =
			self.parse_children(body_start, Some(name), restricted, indent, name, &child_props)?;
		let part = finish_element(name, props, parts, Str::default(), at)?;
		Ok((part, end))
	}

	fn parse_md(
		&mut self,
		body_start: usize,
		indent: usize,
		props: Props,
		require_close: bool,
	) -> Result<(Parsed, usize), ParseError> {
		let (text, children, end) = self.scan_md(body_start, indent, &props, require_close)?;
		Ok((markdown_with_parts(props, text, children, body_start, false), end))
	}

	fn scan_md(
		&mut self,
		body_start: usize,
		indent: usize,
		props: &Props,
		require_close: bool,
	) -> Result<(Str, Vec<Cached>, usize), ParseError> {
		let mut segment_start = body_start;
		let mut first = true;
		let mut first_text = Str::default();
		let mut embedded = Vec::new();
		let child_props = child_props(props);
		loop {
			let event = self.next_md_event(segment_start, indent, require_close)?;
			let end = match &event {
				MdEvent::Close(at) | MdEvent::End(at) | MdEvent::Element(at, _) => *at,
			};
			let body = self.src[segment_start..end].trim_matches('\n');
			let text = dedent(self.source, body, indent);
			if first {
				first_text = text;
				first = false;
			} else {
				embedded.push(markdown_part(text, child_props.clone()));
			}
			match event {
				MdEvent::Close(_) => {
					return Ok((first_text, embedded, end + "</md>".len()));
				},
				MdEvent::End(_) => return Ok((first_text, embedded, end)),
				MdEvent::Element(at, close) => {
					let (part, next) = self.parse_element(at, close, true, &child_props)?;
					embedded.push(part.into_cached("md")?);
					segment_start = next;
				},
			}
		}
	}

	fn next_md_event(
		&self,
		mut at: usize,
		indent: usize,
		require_close: bool,
	) -> Result<MdEvent, ParseError> {
		let mut fence: Option<(u8, usize)> = None;
		while at < self.src.len() {
			let line_end = self.src[at..].find('\n').map_or(self.src.len(), |p| p + at);
			let line = self.src[at..line_end]
				.strip_suffix('\r')
				.unwrap_or_else(|| &self.src[at..line_end]);
			let trimmed = line.trim_start();
			let prefix = &line[..line.len() - trimmed.len()];
			let spaces = prefix.as_bytes().iter().take_while(|&&b| b == b' ').count();
			let indented_code = spaces >= indent + 4 || prefix.contains('\t');
			if let Some((marker, length)) = fence {
				let run = trimmed
					.as_bytes()
					.iter()
					.take_while(|&&b| b == marker)
					.count();
				if run >= length {
					fence = None;
					if let Some(pos) = trimmed[run..].find("</md>") {
						let close_at = at + (line.len() - trimmed.len()) + run + pos;
						if require_close {
							return Ok(MdEvent::Close(close_at));
						}
						return Err(stray_md_close(close_at));
					}
				}
			} else {
				let marker = trimmed.as_bytes().first().copied();
				let run =
					marker.map_or(0, |m| trimmed.as_bytes().iter().take_while(|&&b| b == m).count());
				if matches!(marker, Some(b'`' | b'~')) && run >= 3 && !indented_code {
					fence = Some((marker.unwrap_or_default(), run));
				} else {
					let tag_at = at + (line.len() - trimmed.len());
					if !indented_code && let Some((name, close)) = line_tag(trimmed, tag_at) {
						if is_md_block_tag(name) || is_custom_tag_at(self.src, name, tag_at, close) {
							return Ok(MdEvent::Element(tag_at, close));
						}
						if is_interactive_tag(name) {
							return Err(ParseError {
								message: format!("interactive tag <{name}> is not allowed inside <md>"),
								at:      tag_at,
							});
						}
					}
					if let Some(close) = line.find("</md>") {
						let close_at = at + close;
						if require_close {
							return Ok(MdEvent::Close(close_at));
						}
						return Err(stray_md_close(close_at));
					}
				}
			}
			at = if line_end < self.src.len() {
				line_end + 1
			} else {
				line_end
			};
		}
		Ok(MdEvent::End(self.src.len()))
	}

	fn add_text(
		&self,
		parts: &mut Vec<Parsed>,
		parent_tag: &str,
		parent_props: &Props,
		start: usize,
		end: usize,
		indent: usize,
	) {
		let raw = &self.src[start..end];
		if raw.trim().is_empty() {
			return;
		}
		// The full clone already carries `truncate` (including its
		// clipped-side value) into implicit text children.
		let props = parent_props.clone();
		if parent_tag == "row" {
			let mut table_start: Option<usize> = None;
			let mut offset = 0;
			for line in raw.split_inclusive('\n') {
				let content = line.trim();
				let at = start + offset;
				offset += line.len();
				if content.starts_with('|') {
					table_start.get_or_insert(at);
					continue;
				}
				if let Some(from) = table_start.take() {
					let chunk = self.src[from..at].trim_matches(['\n', '\r']);
					if !chunk.trim().is_empty() {
						let text = dedent(self.source, chunk, indent);
						parts.push(markdown_parsed(text, props.clone(), from));
					}
				}
				if !content.is_empty() {
					let text = self.source.slice_ref(content);
					parts.push(markdown_parsed(text, props.clone(), at));
				}
			}
			if let Some(from) = table_start {
				let chunk = self.src[from..end].trim_matches(['\n', '\r']);
				if !chunk.trim().is_empty() {
					let text = dedent(self.source, chunk, indent);
					parts.push(markdown_parsed(text, props, from));
				}
			}
		} else {
			let text = dedent(self.source, raw.trim_matches(['\n', '\r']), indent);
			parts.push(markdown_parsed(text, props, start));
		}
	}
}
/// Slices a raw-text body zero-copy, decoding HTML character references —
/// raw-text elements suppress markup, not character references, so producers
/// embed untrusted text with standard entity escaping (matching HTML).
fn decode_raw_body(source: &Str, body: &str) -> Str {
	if !body.contains('&') {
		return source.slice_ref(body);
	}
	let mut decoded = StrMut::with_capacity(body.len());
	markdown::decode_entities(body, &mut decoded);
	decoded.freeze()
}

/// Removes up to `indent` leading spaces from every line, so a body's
/// Markdown indentation is measured from the tag that encloses it and a
/// pretty-printed document does not read as a code block.
///
/// Zero-copy when there is nothing to strip.
fn dedent(source: &Str, body: &str, indent: usize) -> Str {
	if indent == 0 || !body.lines().any(|line| line.starts_with(' ')) {
		return source.slice_ref(body);
	}
	let mut out = StrMut::with_capacity(body.len());
	for (index, line) in body.split('\n').enumerate() {
		if index > 0 {
			out.push_str("\n");
		}
		out.push_str(&line[leading_spaces(line).min(indent)..]);
	}
	out.freeze()
}

/// Leading spaces of `line`.
fn leading_spaces(line: &str) -> usize {
	line.bytes().take_while(|byte| *byte == b' ').count()
}

/// The line `at` sits on, from its first byte up to `at`.
///
/// Only the indentation matters to callers, so the tail is not scanned.
fn line_of(src: &str, at: usize) -> &str {
	let start = src[..at].rfind('\n').map_or(0, |newline| newline + 1);
	&src[start..at]
}

/// Tracks Markdown code state across the text runs of an implicit body —
/// fenced blocks and inline code spans — so their `<` stays literal.
struct FenceScan {
	fence:         Option<(u8, usize)>,
	/// Backtick-run length of an open inline code span.
	code:          Option<usize>,
	/// The current line is an indented code line.
	indented:      bool,
	/// Column of the tag that opened this body. Markdown indentation is
	/// measured from here, so pretty-printing a document does not turn its
	/// children into code blocks.
	indent:        usize,
	at_line_start: bool,
}

impl FenceScan {
	/// Scanner for a fresh Markdown segment inside a tag at column
	/// `indent`. Each implicit segment renders as its own document, so its
	/// first byte begins a line — a fence may open immediately after the
	/// enclosing tag.
	const fn segment(indent: usize) -> Self {
		Self { fence: None, code: None, indented: false, indent, at_line_start: true }
	}

	/// Whether Markdown owns this position's code context — a fenced block
	/// or a code line indented four columns past the enclosing tag.
	const fn in_code(&self) -> bool {
		self.fence.is_some() || self.indented
	}

	/// Whether an inline code span is open here *and* closes later, so an
	/// unmatched backtick never swallows the rest of the body.
	///
	/// The lookahead mirrors [`crate::markdown`]'s own `code_span`: any
	/// equal-length backtick run closes it, newlines included — a span may
	/// cross blank lines.
	fn in_code_span(&self, tail: &str) -> bool {
		let Some(length) = self.code else {
			return false;
		};
		let bytes = tail.as_bytes();
		let mut at = 0;
		while at < bytes.len() {
			if bytes[at] != b'`' {
				at += 1;
				continue;
			}
			let run = bytes[at..].iter().take_while(|&&byte| byte == b'`').count();
			if run == length {
				return true;
			}
			at += run;
		}
		false
	}

	/// Advances line state over text Markdown removes before parsing (HTML
	/// comments), without letting its content toggle code state.
	fn skip(&mut self, text: &str) {
		for piece in text.split_inclusive('\n') {
			self.at_line_start = piece.ends_with('\n');
			if self.at_line_start {
				self.indented = false;
			}
		}
	}

	fn consume(&mut self, run: &str) {
		for piece in run.split_inclusive('\n') {
			let line = piece.trim_end_matches(['\n', '\r']);
			if self.at_line_start {
				// four spaces past the enclosing tag start an indented code
				// line (renderer's is_indented_code); it holds for the line
				self.indented = leading_spaces(line) >= self.indent + 4;
			}
			let fenced = self.at_line_start && self.fence_marker(line);
			if !fenced && self.fence.is_none() {
				self.code_spans(line);
			}
			self.at_line_start = piece.ends_with('\n');
			if self.at_line_start {
				// the next line's indent is unknown until it is scanned, so
				// a tag at column 0 never inherits this line's
				self.indented = false;
			}
		}
	}

	/// Opens or closes a fenced block, reporting whether `line` was a fence
	/// marker. The rules mirror [`crate::markdown`]'s `fence_start` /
	/// `is_closing_fence`: ≤3 spaces of indent, a run of 3+ backticks or
	/// tildes to open (info string allowed), and a same-marker run at
	/// least as long with a whitespace-only remainder to close.
	fn fence_marker(&mut self, line: &str) -> bool {
		let trimmed = line.trim_start_matches(' ');
		if line.len().saturating_sub(trimmed.len()) > 3 {
			return false;
		}
		let Some(marker) = trimmed.as_bytes().first().copied() else {
			return false;
		};
		let run = trimmed.bytes().take_while(|&byte| byte == marker).count();
		if let Some((open, length)) = self.fence {
			let closes = marker == open && run >= length && trimmed[run..].trim().is_empty();
			if closes {
				self.fence = None;
			}
			return closes;
		}
		let opens = matches!(marker, b'`' | b'~') && run >= 3;
		if opens {
			self.fence = Some((marker, run));
			self.code = None;
		}
		opens
	}

	/// Toggles inline code spans: a run of N backticks opens, an equal run
	/// closes.
	fn code_spans(&mut self, line: &str) {
		let bytes = line.as_bytes();
		let mut at = 0;
		while at < bytes.len() {
			if bytes[at] != b'`' {
				at += 1;
				continue;
			}
			let run = bytes[at..].iter().take_while(|&&byte| byte == b'`').count();
			match self.code {
				Some(length) if length == run => self.code = None,
				Some(_) => {},
				None => self.code = Some(run),
			}
			at += run;
		}
	}
}

/// Whether `offset` falls inside a Markdown math span of `text`. Uses the
/// renderer's own scanner, so `$$…$$`, `\[…\]`, `\(…\)`, and the
/// anti-currency `$…$` rule stay in one place.
fn in_math_span(text: &str, offset: usize) -> bool {
	let mut at = 0;
	while at < offset {
		let Some(next) = text[at..].find(['$', '\\']) else {
			return false;
		};
		let start = at + next;
		if start >= offset {
			return false;
		}
		match markdown::math_span(&text[start..]) {
			Some((_, consumed)) if offset < start + consumed => return true,
			Some((_, consumed)) => at = start + consumed,
			None => at = start + 1,
		}
	}
	false
}

/// The tag name opening just past a `<`, or `None` when the payload isn't
/// a plain identifier followed by whitespace, `/>`, or `>` — `<https://x>`
/// and `<a@b.com>` are Markdown autolinks, not malformed tags. Scans only
/// a prefix, so tag ownership is decided before the (quote-aware) closing
/// `>` is located.
fn tag_name(after: &str) -> Option<&str> {
	let after = after.strip_prefix('/').unwrap_or(after);
	let end = after
		.find(|character: char| !(character.is_ascii_alphanumeric() || character == '-'))
		.unwrap_or(after.len());
	let name = &after[..end];
	let rest = &after[end..];
	let delimited =
		rest.starts_with('>') || rest.starts_with("/>") || rest.starts_with(char::is_whitespace);
	(delimited && name.starts_with(|character: char| character.is_ascii_alphabetic()))
		.then_some(name)
}

/// Byte offset of the `>` closing the tag payload `after` (just past its
/// `<`), skipping `"…"`/`'…'` quoted attribute values so a title may embed
/// `<ico:name/>`. `None` when unterminated.
const fn tag_close(after: &str) -> Option<usize> {
	let bytes = after.as_bytes();
	let mut index = 0;
	while index < bytes.len() {
		match bytes[index] {
			b'>' => return Some(index),
			quote @ (b'"' | b'\'') => {
				index += 1;
				while index < bytes.len() && bytes[index] != quote {
					index += 1;
				}
				if index == bytes.len() {
					return None;
				}
				index += 1;
			},
			_ => index += 1,
		}
	}
	None
}

/// The `<ico:name/>` tag at `text`'s start: `(name, consumed bytes)`.
///
/// Shared between attribute resolution here and Markdown inline rendering,
/// so the icon grammar can never fork. Names accept the catalog's short
/// keys and qualified aliases (`[A-Za-z0-9_.-]+`); the `/` is optional.
pub fn ico_tag(text: &str) -> Option<(&str, usize)> {
	let rest = text.strip_prefix("<ico:")?;
	let end = rest
		.find(|character: char| {
			!(character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-'))
		})
		.unwrap_or(rest.len());
	let name = &rest[..end];
	let tail = rest[end..].trim_start_matches(' ');
	let tail = tail.strip_prefix('/').unwrap_or(tail);
	let tail = tail.strip_prefix('>')?;
	(!name.is_empty()).then(|| (name, text.len() - tail.len()))
}

/// Substitutes every `<ico:name/>` in an attribute value through the
/// charset; zero-copy when none are present. Unknown names keep the bare
/// name — visible and greppable instead of silently dropped.
fn resolve_icons(charset: Charset, source: &Str, value: &str) -> Str {
	if !value.contains("<ico:") {
		return source.slice_ref(value);
	}
	let mut resolved = StrMut::new("");
	let mut rest = value;
	while let Some(at) = rest.find("<ico:") {
		if let Some((name, consumed)) = ico_tag(&rest[at..]) {
			resolved.push_str(&rest[..at]);
			resolved.push_str(charset.icon_named(name).unwrap_or(name));
			rest = &rest[at + consumed..];
		} else {
			resolved.push_str(&rest[..at + "<ico:".len()]);
			rest = &rest[at + "<ico:".len()..];
		}
	}
	resolved.push_str(rest);
	resolved.freeze()
}

enum MdEvent {
	Close(usize),
	Element(usize, usize),
	End(usize),
}

fn line_tag(line: &str, at: usize) -> Option<(&str, usize)> {
	let raw = line.strip_prefix('<')?;
	let close = tag_close(raw)?;
	let tag = raw[..close].strip_suffix('/').unwrap_or(&raw[..close]);
	let name = tag
		.split_once(char::is_whitespace)
		.map_or(tag, |(name, _)| name);
	Some((name, at + close + 1))
}

fn is_md_block_tag(name: &str) -> bool {
	is_catalog_tag(name) && !is_interactive_tag(name)
}

fn is_markdown_html_tag(name: &str) -> bool {
	matches!(name, "br" | "p" | "span" | "code" | "li" | "ul" | "ol" | "blockquote")
}

fn is_catalog_tag(name: &str) -> bool {
	matches!(
		name,
		"col"
			| "row"
			| "box"
			| "text"
			| "pre"
			| "md" | "latex"
			| "hr" | "spacer"
			| "select"
			| "option"
			| "radio"
			| "segmented"
			| "checkbox"
			| "spinner"
			| "pulse"
			| "strike"
			| "status"
			| "segment"
			| "input"
			| "button"
			| "scroll"
			| "tabs"
			| "tab"
			| "tree"
			| "node"
			| "todo"
			| "task"
			| "form"
			| "field"
			| "progress"
			| "img"
			| "diff"
			| "editor"
			| "wizard"
			| "step"
			| "callout"
			| "icon"
			| "table"
			| "tr" | "td"
			| "json"
			| "files"
			| "time"
			| "num"
			| "bytes"
			| "diffstat"
			| "state"
			| "fact"
			| "quote"
			| "choice"
			| "qr"
	)
}

fn is_reserved_chrome_tag(name: &str) -> bool {
	matches!(name, "approval" | "attribution" | "tool-card" | "transcript" | "logo")
}
fn is_interactive_tag(name: &str) -> bool {
	matches!(
		name,
		"select"
			| "option"
			| "radio"
			| "segmented"
			| "checkbox"
			| "input"
			| "button"
			| "scroll"
			| "tabs"
			| "tab"
			| "tree"
			| "node"
			| "form"
			| "field"
			| "editor"
			| "wizard"
			| "step"
	)
}

fn is_leaf_tag(name: &str) -> bool {
	matches!(
		name,
		"pre"
			| "hr" | "spacer"
			| "radio"
			| "checkbox"
			| "input"
			| "progress"
			| "img"
			| "json"
			| "files"
			| "time"
			| "num"
			| "bytes"
			| "diffstat"
			| "state"
			| "choice"
	)
}

fn has_matching_close(mut after: &str, name: &str) -> bool {
	while let Some(at) = after.find("</") {
		let tail = &after[at + 2..];
		if tail
			.strip_prefix(name)
			.is_some_and(|tail| tail.starts_with('>'))
		{
			return true;
		}
		after = tail;
	}
	false
}

fn is_custom_tag_at(src: &str, name: &str, at: usize, close: usize) -> bool {
	!name.starts_with('/')
		&& !is_catalog_tag(name)
		&& !is_markdown_html_tag(name)
		&& (src[at..=close].trim_end().ends_with("/>") || has_matching_close(&src[close + 1..], name))
}
fn stray_md_close(at: usize) -> ParseError {
	ParseError { message: "closing </md> does not match open <nothing>".into(), at }
}

/// True when a dynamic `<md>` body embeds a line-start markup element
/// outside code fences.
pub fn md_embeds_markup(text: &str) -> bool {
	let mut fence: Option<(u8, usize)> = None;
	let mut at = 0;
	for piece in text.split_inclusive('\n') {
		let line = piece.strip_suffix('\n').unwrap_or(piece);
		let line = line.strip_suffix('\r').unwrap_or(line);
		let trimmed = line.trim_start();
		let prefix = &line[..line.len() - trimmed.len()];
		let spaces = prefix.bytes().take_while(|&b| b == b' ').count();
		let indented = spaces >= 4 || prefix.contains('\t');
		if let Some((marker, length)) = fence {
			let run = trimmed.bytes().take_while(|&b| b == marker).count();
			if run >= length {
				fence = None;
			}
			at += piece.len();
			continue;
		}
		let marker = trimmed.as_bytes().first().copied();
		let run = marker.map_or(0, |m| trimmed.bytes().take_while(|&b| b == m).count());
		if matches!(marker, Some(b'`' | b'~')) && run >= 3 && !indented {
			fence = Some((marker.unwrap_or_default(), run));
			at += piece.len();
			continue;
		}
		let tag_at = at + prefix.len();
		if !indented
			&& let Some((name, close)) = line_tag(trimmed, tag_at)
			&& (is_md_block_tag(name)
				|| is_interactive_tag(name)
				|| is_custom_tag_at(text, name, tag_at, close))
		{
			return true;
		}
		at += piece.len();
	}
	false
}

fn child_props(parent: &Props) -> Props {
	let mut child = Props::new();
	for prop in [
		Prop::Fg,
		Prop::Bold,
		Prop::Dim,
		Prop::Italic,
		Prop::Underline,
		Prop::Reverse,
		Prop::Strike,
		Prop::Truncate,
	] {
		if let Some(value) = parent.get(prop)
			&& !matches!(&value, PropValue::Gradient(_))
		{
			child.try_set(prop, value).unwrap();
		}
	}
	child
}

macro_rules! replay_props {
	($component:ident, $props:expr) => {
		for prop in <Prop as strum::IntoEnumIterator>::iter() {
			if let Some(value) = $props.get(prop) {
				$component = $component.with(prop, value);
			}
		}
	};
}

fn boxed_component<T: Component + 'static>(mut component: T, props: Props) -> Box<dyn Component> {
	*component.props_mut() = props;
	Box::new(component)
}

fn build(tag: &str, props: Props, children: Vec<Cached>, body: &Str) -> Option<Box<dyn Component>> {
	macro_rules! configured {
		($component:expr) => {{
			let mut component = $component;
			replay_props!(component, props);
			boxed_component(component, props)
		}};
	}
	Some(match tag {
		"col" => configured!(Col::new().child(children)),
		"row" => configured!(Row::new().child(children)),
		"fact" => configured!(Fact::new().child(children)),
		"box" => configured!(Boxed::new().child(children)),
		"text" => configured!(TextLeaf::new().text(body.clone())),
		"pre" => configured!(Pre::new().text(body.clone())),
		"json" => configured!(JsonPreview::new().text(body.clone())),
		"files" => configured!(Files::new().text(body.clone())),
		"quote" => configured!(Quote::new().text(body.clone())),
		"choice" => configured!(Choice::new().text(body.clone())),
		"md" => configured!(Markdown::text_of(body.clone()).child(children)),
		"latex" => configured!(Latex::new().text(body.clone())),
		"hr" => configured!(Hr::new()),
		"spacer" => configured!(Spacer::new()),
		"select" => configured!(Select::new()),
		"table" => configured!(Table::new()),
		"radio" => configured!(Radio::new()),
		"checkbox" => configured!(Checkbox::new()),
		"spinner" => configured!(Spinner::new().label(body.clone())),
		"strike" => configured!(Strike::new().text(body.clone())),
		"pulse" => configured!(Pulse::new().label(body.clone())),
		"time" => configured!(Time::new()),
		"num" => configured!(NumberLeaf::new()),
		"bytes" => configured!(NumberLeaf::bytes()),
		"diffstat" => configured!(DiffStat::new()),
		"state" => configured!(State::new()),
		"input" => configured!(Input::new()),
		"button" => configured!(Button::new().child(body.clone())),
		"scroll" => configured!(Scroll::new().child(children)),
		"tabs" => configured!(Tabs::new().child(children)),
		"tree" => configured!(Tree::new()),
		"todo" => configured!(Todo::new()),
		"form" => configured!(Form::new()),
		"progress" => configured!(Progress::new()),
		"qr" => configured!(Qr::new().text(body.clone())),
		"img" => configured!(Img::new()),
		"diff" => configured!(DiffView::new().text(body.clone())),
		"callout" => configured!(Callout::new().text(body.clone())),
		"editor" => configured!(EditorPane::new()),
		"icon" => {
			let name = if body.is_empty() {
				props.str_of(Prop::Icon).cloned().unwrap_or_default()
			} else {
				body.clone()
			};
			configured!(Icon::named(name))
		},
		"segmented" => configured!(Segmented::new()),
		"option" | "segment" | "tab" | "node" | "field" | "step" | "task" | "tr" | "td" => {
			return None;
		},
		_ => return None,
	})
}

fn finish_element(
	tag: &str,
	props: Props,
	mut parts: Vec<Parsed>,
	body: Str,
	at: usize,
) -> Result<Parsed, ParseError> {
	match tag {
		"option" => {
			let label = take_label(&mut parts).unwrap_or_default();
			let mut option = SelectOption::new();
			replay_props!(option, props);
			if !label.is_empty() {
				option = option.label(label);
			}
			for part in parts {
				match part {
					// Cells become the option's aligned row; anything else
					// stays preview content shown beneath it.
					Parsed::Cell { cell, .. } => option = option.cell(cell),
					other => option = option.child(other.into_cached("option")?),
				}
			}
			Ok(Parsed::Option { option, at })
		},
		"td" => {
			let children = cached_children(parts, "td")?;
			let mut cell = TableCell::new().child(children);
			*cell.props_mut() = props;
			Ok(Parsed::Cell { cell, at })
		},
		"tr" => {
			let mut row = TableRow::new();
			replay_props!(row, props);
			for part in parts {
				match part {
					Parsed::Cell { cell, .. } => row = row.cell(cell),
					other => return Err(parent_error(other.name(), "tr", at)),
				}
			}
			Ok(Parsed::TableRow { row: Box::new(row), at })
		},
		"table" => {
			let mut table = Table::new();
			for part in parts {
				match part {
					Parsed::TableRow { row, .. } => table = table.row(*row),
					other => return Err(parent_error(other.name(), "table", at)),
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(boxed_component(table, props))),
				text: None,
				at,
				implicit: false,
			})
		},
		"segment" => {
			let label = take_label(&mut parts).unwrap_or_default();
			if let Some(other) = parts.into_iter().next() {
				return Err(parent_error(other.name(), "segment", at));
			}
			let mut segment = Segment::new();
			replay_props!(segment, props);
			if !label.is_empty() {
				segment = segment.label(label);
			}
			Ok(Parsed::Segment { segment, at })
		},
		"tab" => {
			let title = props.title().cloned().unwrap_or_else(|| Str::new("tab"));
			let icon = props.str_of(Prop::Icon).cloned().unwrap_or_default();
			let children = cached_children(parts, "tab")?;
			Ok(Parsed::Tab { title, icon, children, at })
		},
		"node" => {
			let body_label = take_label(&mut parts);
			let label = body_label
				.or_else(|| props.str_of(Prop::Label).cloned())
				.unwrap_or_default();
			let mut node = TreeNode::new();
			replay_props!(node, props);
			if !label.is_empty() {
				node = node.label(label);
			}
			for part in parts {
				match part {
					Parsed::TreeItem { node: child, .. } => node = node.node(child),
					other => return Err(parent_error(other.name(), "node", at)),
				}
			}
			Ok(Parsed::TreeItem { node, at })
		},
		"task" => {
			let body_label = take_label(&mut parts);
			let label = body_label
				.or_else(|| props.str_of(Prop::Label).cloned())
				.unwrap_or_default();
			if let Some(status) = props.str_of(Prop::Status)
				&& TaskStatus::parse(status).is_none()
			{
				return Err(ParseError {
					message: format!(
						"unknown task status {status:?} (use pending|active|done|dropped|blocked)"
					),
					at,
				});
			}
			let mut task = TodoTask::new();
			replay_props!(task, props);
			if !label.is_empty() {
				task = task.label(label);
			}
			for part in parts {
				match part {
					Parsed::Task { task: child, .. } => task = task.task(child),
					other => return Err(parent_error(other.name(), "task", at)),
				}
			}
			Ok(Parsed::Task { task, at })
		},
		"field" => {
			let label = take_label(&mut parts);
			let children = cached_children(parts, "field")?;
			let mut field = Field::new();
			replay_props!(field, props);
			if let Some(label) = label {
				field = field.label(label);
			}
			if !children.is_empty() {
				field = field.child(children);
			}
			Ok(Parsed::Field { field, at })
		},
		"step" => {
			let title = props.title().cloned().unwrap_or_else(|| Str::new("step"));
			let children = cached_children(parts, "step")?;
			Ok(Parsed::Step { title, children, at })
		},
		"segmented" => {
			let mut segmented = Segmented::new();
			replay_props!(segmented, props);
			*segmented.props_mut() = props;
			for part in parts {
				match part {
					Parsed::Option { option, .. } => segmented = segmented.option(option),
					other => return Err(parent_error(other.name(), "segmented", at)),
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(Box::new(segmented))),
				text: None,
				at,
				implicit: false,
			})
		},
		"select" => {
			let mut select = Select::new();
			replay_props!(select, props);
			*select.props_mut() = props;
			for part in parts {
				match part {
					Parsed::Option { option, .. } => select = select.option(option),
					other => return Err(parent_error(other.name(), "select", at)),
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(Box::new(select))),
				text: None,
				at,
				implicit: false,
			})
		},
		"status" => {
			let mut status = Status::new();
			replay_props!(status, props);
			*status.props_mut() = props;
			for part in parts {
				match part {
					Parsed::Segment { segment, .. } => status = status.segment(segment),
					other => return Err(parent_error(other.name(), "status", at)),
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(Box::new(status))),
				text: None,
				at,
				implicit: false,
			})
		},
		"editor" => {
			let mut editor = EditorPane::new();
			replay_props!(editor, props);
			let mut has_input = false;
			let mut has_status = false;
			for part in parts {
				let Parsed::Cached { cached, at: child_at, implicit, .. } = part else {
					return Err(ParseError {
						message: "<editor> takes at most one input child and one <status>".into(),
						at,
					});
				};
				if implicit {
					return Err(ParseError {
						message: "<editor> takes at most one input child and one <status>".into(),
						at:      child_at,
					});
				}
				if cached.comp().is::<Status>() {
					if has_status {
						return Err(ParseError {
							message: "<editor> takes at most one input child and one <status>".into(),
							at:      child_at,
						});
					}
					editor = editor.status(cached.into_comp());
					has_status = true;
				} else {
					if has_input {
						return Err(ParseError {
							message: "<editor> takes at most one input child and one <status>".into(),
							at:      child_at,
						});
					}
					editor = editor.input(cached.into_comp());
					has_input = true;
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(boxed_component(editor, props))),
				text: None,
				at,
				implicit: false,
			})
		},
		"tabs" => {
			let mut tabs = Tabs::new();
			replay_props!(tabs, props);
			*tabs.props_mut() = props;
			for part in parts {
				match part {
					Parsed::Tab { title, icon, children, .. } => {
						tabs = tabs.pane_icon(icon, title, children);
					},
					other => return Err(parent_error(other.name(), "tabs", at)),
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(Box::new(tabs))),
				text: None,
				at,
				implicit: false,
			})
		},
		"tree" => {
			let mut tree = Tree::new();
			replay_props!(tree, props);
			*tree.props_mut() = props;
			for part in parts {
				match part {
					Parsed::TreeItem { node, .. } => tree = tree.node(node),
					other => return Err(parent_error(other.name(), "tree", at)),
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(Box::new(tree))),
				text: None,
				at,
				implicit: false,
			})
		},
		"todo" => {
			let mut todo = Todo::new();
			replay_props!(todo, props);
			*todo.props_mut() = props;
			for part in parts {
				match part {
					Parsed::Task { task, .. } => todo = todo.task(task),
					other => return Err(parent_error(other.name(), "todo", at)),
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(Box::new(todo))),
				text: None,
				at,
				implicit: false,
			})
		},
		"form" => {
			let mut form = Form::new();
			replay_props!(form, props);
			*form.props_mut() = props;
			for part in parts {
				match part {
					Parsed::Field { field, .. } => form = form.field(field),
					other => return Err(parent_error(other.name(), "form", at)),
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(Box::new(form))),
				text: None,
				at,
				implicit: false,
			})
		},
		"wizard" => {
			let mut wizard = Wizard::new();
			replay_props!(wizard, props);
			*wizard.props_mut() = props;
			for part in parts {
				match part {
					Parsed::Step { title, children, .. } => wizard = wizard.step(title, children),
					other => return Err(parent_error(other.name(), "wizard", at)),
				}
			}
			Ok(Parsed::Cached {
				cached: Box::new(Cached::new(Box::new(wizard))),
				text: None,
				at,
				implicit: false,
			})
		},
		_ => {
			let children = cached_children(parts, tag)?;
			let text = matches!(tag, "text" | "pre" | "md" | "latex").then(|| body.clone());
			let component = if is_catalog_tag(tag) {
				build(tag, props, children, &body).expect("catalog tag has a component")
			} else {
				let mut custom = CustomElement::new(tag).child(children);
				replay_props!(custom, props);
				boxed_component(custom, props)
			};
			Ok(Parsed::Cached { cached: Box::new(Cached::new(component)), text, at, implicit: false })
		},
	}
}

fn take_label(parts: &mut Vec<Parsed>) -> Option<Str> {
	let index = parts
		.iter()
		.position(|part| matches!(part, Parsed::Cached { text: Some(_), .. }))?;
	match parts.remove(index) {
		Parsed::Cached { text: Some(text), .. } => Some(text),
		_ => unreachable!(),
	}
}
fn markdown_with_parts(
	props: Props,
	text: Str,
	children: Vec<Cached>,
	at: usize,
	implicit: bool,
) -> Parsed {
	let metadata = text.clone();
	let component = build("md", props, children, &text).expect("markdown is a catalog component");
	Parsed::Cached { cached: Box::new(Cached::new(component)), text: Some(metadata), at, implicit }
}

fn markdown_part(text: Str, props: Props) -> Cached {
	let visible = !text.is_empty();
	let Parsed::Cached { cached, .. } = markdown_with_parts(props, text, Vec::new(), 0, false)
	else {
		unreachable!();
	};
	let mut cached = *cached;
	cached.visible = visible;
	cached
}

fn markdown_parsed(text: Str, props: Props, at: usize) -> Parsed {
	markdown_with_parts(props, text, Vec::new(), at, true)
}

fn apply_attrs(
	attrs: &str,
	at: usize,
	source: &Str,
	ctx: &UiContext,
	inherited: &Props,
	recover: bool,
) -> Result<Props, ParseError> {
	let mut props = inherited.clone();
	for (key, value) in (AttrIter { rest: attrs }) {
		if matches!(key, "gradient" | "dir") {
			if recover {
				continue;
			}
			return Err(ParseError {
				message: format!("{key} was replaced by fg=/bg= and angle="),
				at,
			});
		}
		if value.is_none() && ctx.theme.token(key).is_some() {
			if let Err(error) = props.try_set(Prop::Fg, PropValue::Token(source.slice_ref(key)))
				&& !recover
			{
				return Err(bad(key, &error.value, at));
			}
		} else if let Some(prop) = Props::prop_of(key) {
			let value = match (prop, value) {
				(Prop::Title, Some(value)) => PropValue::Str(resolve_icons(ctx.charset, source, value)),
				(Prop::Gap | Prop::Grow, None) => PropValue::Str(Str::new("1")),
				(_, Some(value)) => PropValue::Str(source.slice_ref(value)),
				(_, None) => PropValue::Bool(true),
			};
			if let Err(error) = props.try_set(prop, value)
				&& !recover
			{
				return Err(bad(key, &error.value, at));
			}
		} else {
			let value =
				value.map_or(PropValue::Bool(true), |value| PropValue::Str(source.slice_ref(value)));
			props.set_custom(source.slice_ref(key), value);
		}
	}
	Ok(props)
}

fn bad(key: &str, value: &str, at: usize) -> ParseError {
	ParseError { message: format!("bad value {value:?} for attribute {key}"), at }
}

/// Zero-alloc attribute scanner: `key`, `key=value`, `key="quoted value"`.
struct AttrIter<'a> {
	rest: &'a str,
}

impl<'a> Iterator for AttrIter<'a> {
	type Item = (&'a str, Option<&'a str>);

	fn next(&mut self) -> Option<Self::Item> {
		self.rest = self.rest.trim_start();
		if self.rest.is_empty() {
			return None;
		}
		let key_end = self.rest.find(|c: char| c == '=' || c.is_whitespace());
		let (key, after) = match key_end {
			Some(p) => (&self.rest[..p], &self.rest[p..]),
			None => (self.rest, ""),
		};
		if let Some(after_eq) = after.strip_prefix('=') {
			// `key="a b"`, `key='a b'`, and bare `key=a` are equivalent
			for quote in ['"', '\''] {
				if let Some(quoted) = after_eq.strip_prefix(quote) {
					let end = quoted.find(quote).unwrap_or(quoted.len());
					self.rest = quoted.get(end + 1..).unwrap_or("");
					return Some((key, Some(&quoted[..end])));
				}
			}
			let end = after_eq.find(char::is_whitespace).unwrap_or(after_eq.len());
			self.rest = &after_eq[end..];
			return Some((key, Some(&after_eq[..end])));
		}
		self.rest = after;
		Some((key, None))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		Ui,
		frame::{Color, Style},
		test_support::frame_row_text,
	};

	fn child(node: &Cached, index: usize) -> &Cached {
		&node.comp().children()[index]
	}

	#[test]
	fn retained_primitive_catalog_dispatches_each_tag_once() {
		let ctx = UiContext::default();
		let source = Str::new(
			"<json>{\"a\":1}</json><files>a/b</files><time ms=1/><num value=2 compact/><bytes \
			 value=3/><diffstat added=1 removed=2 ops=3/><state status=running/><fact \
			 label=X><text>v</text></fact><quote>x\n</quote><choice selected>x</choice>",
		);
		let root = parse(&source, &ctx).unwrap();
		let children = root.comp().children();
		assert_eq!(children.len(), 10);
		assert!(children[0].comp().is::<JsonPreview>());
		assert!(children[1].comp().is::<Files>());
		assert!(children[2].comp().is::<Time>());
		assert!(children[3].comp().is::<NumberLeaf>());
		assert!(children[4].comp().is::<NumberLeaf>());
		assert!(children[5].comp().is::<DiffStat>());
		assert!(children[6].comp().is::<State>());
		assert!(children[7].comp().is::<Fact>());
		assert!(children[8].comp().is::<Quote>());
		assert!(children[9].comp().is::<Choice>());
	}

	#[test]
	fn well_known_bad_values_are_ignored() {
		let ctx = UiContext::default();
		for source in [
			"<text fg=nosuch>x</text>",
			"<text fg=\"rgb(300,0)\">x</text>",
			"<text fg=💥>x</text>",
			"<text fg=\"rgb💥(1,2,3)\">x</text>",
			"<text fg=#héx>x</text>",
		] {
			let root = parse(&Str::new(source), &ctx).unwrap();
			assert!(!child(&root, 0).comp().props().contains(Prop::Fg), "{source}");
			let ui = Ui::from_markup(source, 20, UiContext::default()).unwrap();
			assert_eq!(frame_row_text(ui.frame(), 0), "x");
		}
	}
	#[test]
	fn invalid_attributes_do_not_block_later_attributes() {
		let ctx = UiContext::default();
		let root = parse(&Str::new("<text fg=nosuch bold>x</text>"), &ctx).unwrap();
		let props = child(&root, 0).comp().props();
		assert!(!props.contains(Prop::Fg));
		assert_eq!(props.style(&ctx.theme), Style::new().bold());
	}

	#[test]
	fn long_semantic_color_aliases_parse_everywhere() {
		let ctx = UiContext::default();
		for markup in [
			"<box bc=warning><text>x</text></box>",
			"<text fg=error>x</text>",
			"<text fg=success>x</text>",
			"<text bg=warning>x</text>",
		] {
			assert!(parse(&Str::new(markup), &ctx).is_ok(), "{markup}");
		}
	}

	#[test]
	fn chrome_attributes_parse_with_aliases_and_flags() {
		let ctx = UiContext::default();
		let root = parse(
			&Str::new(
				"<col><box border=dash on=navy edge=red><text accent reverse strike truncate \
				 mystery>x</text></box><spacer/></col>",
			),
			&ctx,
		)
		.unwrap();
		let col = child(&root, 0);
		let boxed = child(col, 0);
		assert_eq!(boxed.comp().props().border(), Some(Border::Dash));
		assert_eq!(boxed.comp().props().style(&ctx.theme).background_color(), Color::Rgb(0, 0, 0x80));
		assert_eq!(boxed.comp().props().edge(&ctx.theme), Some(Color::Rgb(0xff, 0, 0)));
		assert_eq!(boxed.comp().props().pad().1, 1);
		let text = child(boxed, 0).comp().props();
		assert_eq!(
			text.style(&ctx.theme),
			Style::new().fg(ctx.theme.accent).reverse().strikethrough()
		);
		assert!(text.flag(Prop::Truncate));
		assert_eq!(text.custom("mystery"), Some(&PropValue::Bool(true)));
		assert_eq!(child(col, 1).comp().props().grow(), Some(1.0));

		let overrides =
			parse(&Str::new("<col><box pad='2 3'></box><spacer grow=2/></col>"), &ctx).unwrap();
		let col = child(&overrides, 0);
		assert_eq!(child(col, 0).comp().props().pad(), (2, 3));
		assert_eq!(child(col, 1).comp().props().grow(), Some(2.0));
	}

	#[test]
	fn attribute_quoting_styles_are_equivalent() {
		let ctx = UiContext::default();
		for src in [
			"<box title=b><text>x</text></box>",
			"<box title='b'><text>x</text></box>",
			"<box title=\"b\"><text>x</text></box>",
		] {
			let root = parse(&Str::new(src), &ctx).unwrap();
			assert_eq!(child(&root, 0).comp().props().title().map(Str::as_str), Some("b"));
		}
		let root =
			parse(&Str::new("<box title='say \"hi\" now'><text>x</text></box>"), &ctx).unwrap();
		assert_eq!(child(&root, 0).comp().props().title().map(Str::as_str), Some("say \"hi\" now"));
	}

	#[test]
	fn title_resolves_ico_tags_through_the_charset() {
		let unicode = UiContext::default();
		let src = Str::new("<box title=\"<ico:folder/> Files\"><text>x</text></box>");
		let root = parse(&src, &unicode).unwrap();
		assert_eq!(child(&root, 0).comp().props().title().map(Str::as_str), Some("📁 Files"));

		let ascii = UiContext { charset: Charset::Ascii, ..UiContext::default() };
		let root = parse(&src, &ascii).unwrap();
		assert_eq!(child(&root, 0).comp().props().title().map(Str::as_str), Some("[D] Files"));

		let src = Str::new("<hr title=\"<ico:icon.folder/> <ico:nope/>\"/>");
		let root = parse(&src, &unicode).unwrap();
		assert_eq!(child(&root, 0).comp().props().title().map(Str::as_str), Some("📁 nope"));
	}

	#[test]
	fn styles_cascade_to_children() {
		let ctx = UiContext::default();
		let root = parse(
			&Str::new(
				"<col fg=#0000ff bold><text>a</text><text fg=#ff0000>b</text><box \
				 bg=#00ff00><text>c</text></box></col>",
			),
			&ctx,
		)
		.unwrap();
		let col = child(&root, 0);
		let blue = Color::Rgb(0, 0, 0xff);
		assert_eq!(child(col, 0).comp().props().style(&ctx.theme), Style::new().fg(blue).bold());
		assert_eq!(
			child(col, 1).comp().props().style(&ctx.theme),
			Style::new().fg(Color::Rgb(0xff, 0, 0)).bold()
		);
		let nested = child(child(col, 2), 0).comp().props().style(&ctx.theme);
		assert_eq!(nested, Style::new().fg(blue).bold());
		assert_eq!(nested.background_color(), Color::Default);
	}

	#[test]
	fn gradients_live_in_property_values() {
		let ctx = UiContext::default();
		let root = parse(
			&Str::new(
				r##"<box bg="#000000..#ffffff" angle=90><pre fg="accent..info" angle=45>  ██
 █</pre></box>"##,
			),
			&ctx,
		)
		.unwrap();
		let boxed = child(&root, 0);
		assert_eq!(
			boxed.comp().props().get(Prop::Bg),
			Some(PropValue::Gradient(Str::new("#000000..#ffffff")))
		);
		assert_eq!(boxed.comp().props().angle(), 90);
		let pre = child(boxed, 0);
		assert_eq!(
			pre.comp().props().get(Prop::Fg),
			Some(PropValue::Gradient(Str::new("accent..info")))
		);
		assert_eq!(pre.comp().props().angle(), 45);
		for source in ["<pre gradient=\"accent..info\">x</pre>", "<pre dir=h>x</pre>"] {
			let root = parse(&Str::new(source), &ctx).unwrap();
			assert!(!child(&root, 0).comp().props().contains(Prop::Fg), "{source}");
		}
	}

	#[test]
	fn custom_elements_require_a_complete_tag_pair() {
		let ctx = UiContext::default();
		let root = parse(&Str::new("<panel mystery><text>x</text></panel>"), &ctx).unwrap();
		let panel = child(&root, 0);
		assert_eq!(panel.comp().props().custom("mystery"), Some(&PropValue::Bool(true)));
		assert_eq!(panel.comp().children().len(), 1);

		let literal = parse(&Str::new("before <panel> after"), &ctx).unwrap();
		assert_eq!(literal.comp().children().len(), 1);
	}

	#[test]
	fn mismatched_close_implicitly_closes_open_elements() {
		let ctx = UiContext::default();
		let root =
			parse(&Str::new("<col><box><text>inside</text></col><text>after</text>"), &ctx).unwrap();
		let col = child(&root, 0);
		assert_eq!(col.comp().children().len(), 1);
		assert_eq!(child(col, 0).comp().children().len(), 1);
		assert_eq!(root.comp().children().len(), 2);
		let ui = Ui::from_markup(
			"<col><box><text>inside</text></col><text>after</text>",
			20,
			UiContext::default(),
		)
		.unwrap();
		let rendered = (0..ui.height())
			.map(|row| frame_row_text(ui.frame(), row))
			.collect::<Vec<_>>()
			.join("\n");
		assert!(rendered.contains("inside"));
		assert!(rendered.contains("after"));
	}

	#[test]
	fn unclosed_named_tags_auto_close_at_end_of_input() {
		for source in ["<text>inside", "<box><text>inside</text>", "<md>inside"] {
			let ui = Ui::from_markup(source, 20, UiContext::default()).unwrap();
			let rendered = (0..ui.height())
				.map(|row| frame_row_text(ui.frame(), row))
				.collect::<Vec<_>>()
				.join("\n");
			assert!(rendered.contains("inside"), "{source}");
		}
	}

	#[test]
	fn interactive_markup_inside_extension_markdown_is_rejected() {
		let result = parse_with_origin(
			&Str::new("<md>\n<button id=unsafe when=active>safe text</button>\n</md>"),
			&UiContext::default(),
			MarkupOrigin::Extension,
		);
		assert!(result.is_err());
	}

	#[test]
	fn dynamic_markdown_rejects_id_and_when() {
		let result = parse_md_fragment_inheriting(
			&Str::new("<box id=unsafe when=active><text>safe</text></box>"),
			&UiContext::default(),
			&Props::new(),
		);
		assert!(result.is_err());
	}

	#[test]
	fn stray_closing_tags_are_ignored() {
		let ui = Ui::from_markup("before</md><text>after</text>", 20, UiContext::default()).unwrap();
		let rendered = (0..ui.height())
			.map(|row| frame_row_text(ui.frame(), row))
			.collect::<Vec<_>>()
			.join("\n");
		assert!(rendered.contains("before"));
		assert!(rendered.contains("after"));
		assert!(!rendered.contains("</md>"));

		let fragment = parse_md_fragment_inheriting(
			&Str::new("before</md>after"),
			&UiContext::default(),
			&Props::new(),
		);
		assert!(fragment.is_err());
	}

	#[test]
	fn markdown_html_stays_literal_but_line_start_custom_elements_embed() {
		let ctx = UiContext::default();
		let html = parse(&Str::new("<md>before <span>inside</span> after</md>"), &ctx).unwrap();
		assert!(child(&html, 0).comp().children().is_empty());

		let custom = parse(&Str::new("<md>before\n<panel/>\nafter</md>"), &ctx).unwrap();
		assert_eq!(child(&custom, 0).comp().children().len(), 2);
	}

	#[test]
	fn diff_markup_classifies_unified_body() {
		let ctx = UiContext::default();
		let ui = Ui::from_markup("<diff>@@ -1 +1 @@\n-old\n+new\n same</diff>", 20, ctx).unwrap();
		assert_eq!(ui.height(), 4);
	}

	#[test]
	fn diff_markup_context_limits_unchanged_lines() {
		let ctx = UiContext::default();
		let ui = Ui::from_markup(
			"<diff context=1>@@ -1 +1 @@\n old far\n old near\n-old\n+new\n new near\n new far</diff>",
			20,
			ctx,
		)
		.unwrap();
		// Context elision intentionally retains a summary marker on each side;
		// at 20 columns each marker wraps to two rows.
		assert_eq!(ui.height(), 9);
		let rendered = (0..ui.height())
			.map(|row| frame_row_text(ui.frame(), row))
			.collect::<Vec<_>>()
			.join("\n");
		assert!(!rendered.contains("old far"));
		assert!(!rendered.contains("new far"));
		assert!(rendered.contains("old near"));
		assert!(rendered.contains("new near"));
		assert_eq!(rendered.matches("unchanged").count(), 2);
	}

	#[test]
	fn extension_reserved_chrome_degrades_to_custom_element() {
		let ctx = UiContext::default();
		let root = parse_with_origin(
			&Str::new("<approval><text>untrusted</text></approval>"),
			&ctx,
			MarkupOrigin::Extension,
		)
		.unwrap();
		assert!(child(&root, 0).comp().is::<CustomElement>());
	}
}
