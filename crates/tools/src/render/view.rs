//! Typed renderer view construction.
//!
//! Renderer views are element trees built with [`view!`](crate::view) (or the
//! [`El`] builder directly for dynamic shapes) and serialized once through
//! [`El::to_tml`]. Escaping happens exclusively inside the serializer: text
//! and attribute values are stored raw and never escaped by authors.
//!
//! Tag, property, and tone vocabularies are closed enums, so a misspelled
//! tag, attribute, or theme token is a compile error instead of a silently
//! broken card.

use std::time::Duration;

use omp_core::Str;
use smallvec::SmallVec;
use strum::IntoStaticStr;

/// One typed markup element.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct El {
	tag:      Tag,
	props:    SmallVec<(Prop, Val), 4>,
	children: Vec<Kid>,
}

/// One element child: a nested element or raw (unescaped) text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Kid {
	/// A nested element.
	El(El),
	/// Raw text content; the serializer escapes it.
	Text(Str),
}

/// The closed tag vocabulary renderers may emit.
///
/// Serialized names are the kebab-case TML tags parsed by `omp-tui` markup.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case")]
pub enum Tag {
	/// Vertical stack.
	Col,
	/// Horizontal row.
	Row,
	/// Bordered frame container.
	Box,
	/// Styled inline text.
	Text,
	/// Verbatim block, optionally line-numbered.
	Pre,
	/// Markdown block.
	Md,
	/// Mathematical formula block.
	Latex,
	/// Unified diff block.
	Diff,
	/// Accent-barred notice block.
	Callout,
	/// Labeled key-value fact.
	Fact,
	/// Folded path list block.
	Files,
	/// Quoted message body block.
	Quote,
	/// Prompt option row.
	Choice,
	/// Bounded structured JSON preview block.
	Json,
	/// Hierarchical tree container.
	Tree,
	/// One tree node.
	Node,
	/// Checklist container.
	Todo,
	/// One checklist task.
	Task,
	/// Column-solved table container.
	Table,
	/// One table row.
	Tr,
	/// One table cell.
	Td,
	/// Indeterminate progress spinner.
	Spinner,
	/// Deterministic progress bar.
	Progress,
	/// Lifecycle status badge.
	State,
	/// Duration or relative-time value.
	Time,
	/// Compact numeric value.
	Num,
	/// Compact byte-count value.
	Bytes,
	/// Added/removed/ops diff summary.
	Diffstat,
	/// Horizontal divider, optionally labeled.
	Hr,
	/// Flexible spacing leaf.
	Spacer,
	/// Named semantic icon.
	Icon,
	/// Scrollable viewport container.
	Scroll,
}

/// The closed attribute vocabulary renderers may set.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case")]
pub enum Prop {
	/// Inter-child spacing.
	Gap,
	/// Symmetric padding (`"y x"`).
	Pad,
	/// Horizontal padding.
	PadX,
	/// Vertical padding.
	PadY,
	/// Inline separator between row children.
	Sep,
	/// Foreground tone.
	Fg,
	/// Background tone.
	Bg,
	/// Border tone.
	Bc,
	/// Border style.
	Border,
	/// Bold text.
	Bold,
	/// Dim text.
	Dim,
	/// Italic text.
	Italic,
	/// Underlined text.
	Underline,
	/// Wrap mode (`word`, `char`, `pre`).
	Wrap,
	/// Truncation flag or mode.
	Truncate,
	/// Truncation anchor (`start`, `end`).
	TruncateFrom,
	/// Column budget before truncation.
	MaxChars,
	/// Row budget before clamping with an overflow hint.
	MaxRows,
	/// Depth budget for structured previews.
	MaxDepth,
	/// Entity noun used by clamp hints (`overflow="matches"`).
	Overflow,
	/// Fact or spinner label.
	Label,
	/// Numeric value for value leaves.
	Value,
	/// Milliseconds for time leaves.
	Ms,
	/// Kind discriminator (`duration`, `relative`, callout kinds).
	Kind,
	/// Lifecycle badge state.
	Status,
	/// Compact numeric formatting.
	Compact,
	/// Line-number gutter for verbatim blocks.
	Numbers,
	/// First line number of a numbered block.
	Start,
	/// Tree/todo guide style.
	Guides,
	/// Todo phase numbering style.
	Numbering,
	/// Fixed width in cells or percent.
	W,
	/// Fixed height in rows.
	H,
	/// Flexible growth weight.
	Grow,
	/// Cross-axis alignment.
	Align,
	/// Container or callout title.
	Title,
	/// Spinner or icon tone.
	Color,
	/// Added-line count for diff stats.
	Added,
	/// Removed-line count for diff stats.
	Removed,
	/// Operation count for diff stats.
	Ops,
	/// Multi-select choice marker.
	Multi,
	/// Selected choice marker.
	Selected,
	/// Secondary description for tasks and choices.
	Desc,
	/// Trailing annotation for tree nodes.
	Annotation,
	/// Annotation tone for tree nodes.
	AnnotationColor,
	/// Icon name.
	Name,
	/// Hyperlink target.
	Href,
	/// Brightness-sweep animation.
	Shimmer,
	/// Streaming reveal animation.
	Reveal,
	/// Marks live streaming text.
	Partial,
	/// Host card chrome requested by the view's root element: `flush` makes
	/// the view self-presenting — the chat host draws no card header, rail,
	/// or outline around it.
	Chrome,
}

/// Theme-token palette accepted by tone-valued properties.
///
/// Only semantic tokens exist here: hardcoded colors are unrepresentable.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum Tone {
	/// Default foreground.
	Fg,
	/// Primary interactive accent.
	Accent,
	/// Informational highlight.
	Info,
	/// Success.
	Ok,
	/// Warning.
	Warn,
	/// Error.
	Err,
	/// De-emphasized chrome.
	Muted,
	/// Container borders.
	Border,
	/// Neutral chip fill.
	Surface,
	/// Elevated card fill.
	Panel,
	/// Non-status secondary accent.
	Secondary,
	/// High-contrast text on accent fills.
	Contrast,
	/// Selection highlight.
	Selection,
	/// Hover highlight.
	Hover,
}

/// One typed attribute value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Val {
	/// Unsigned numeric value.
	Uint(u64),
	/// Signed numeric value.
	Int(i64),
	/// Text value.
	Str(Str),
	/// Theme tone.
	Tone(Tone),
	/// Boolean flag; `false` omits the attribute entirely.
	Flag(bool),
}

impl From<u64> for Val {
	fn from(value: u64) -> Self {
		Self::Uint(value)
	}
}
/// Millisecond count for `ms`-valued props, saturating at `u64::MAX`.
impl From<Duration> for Val {
	fn from(value: Duration) -> Self {
		Self::Uint(u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
	}
}
impl From<u32> for Val {
	fn from(value: u32) -> Self {
		Self::Uint(value.into())
	}
}
impl From<u16> for Val {
	fn from(value: u16) -> Self {
		Self::Uint(value.into())
	}
}
impl From<usize> for Val {
	fn from(value: usize) -> Self {
		Self::Uint(u64::try_from(value).unwrap_or(u64::MAX))
	}
}
impl From<i64> for Val {
	fn from(value: i64) -> Self {
		Self::Int(value)
	}
}
impl From<i32> for Val {
	fn from(value: i32) -> Self {
		Self::Int(value.into())
	}
}
impl From<bool> for Val {
	fn from(value: bool) -> Self {
		Self::Flag(value)
	}
}
impl From<Tone> for Val {
	fn from(value: Tone) -> Self {
		Self::Tone(value)
	}
}
impl From<Str> for Val {
	fn from(value: Str) -> Self {
		Self::Str(value)
	}
}
impl From<&str> for Val {
	fn from(value: &str) -> Self {
		Self::Str(Str::new(value))
	}
}
impl From<String> for Val {
	fn from(value: String) -> Self {
		Self::Str(Str::new(value))
	}
}
impl From<&Str> for Val {
	fn from(value: &Str) -> Self {
		Self::Str(value.clone())
	}
}

impl From<El> for Kid {
	fn from(value: El) -> Self {
		Self::El(value)
	}
}
impl From<Str> for Kid {
	fn from(value: Str) -> Self {
		Self::Text(value)
	}
}
impl From<&Str> for Kid {
	fn from(value: &Str) -> Self {
		Self::Text(value.clone())
	}
}
impl From<&str> for Kid {
	fn from(value: &str) -> Self {
		Self::Text(Str::new(value))
	}
}
impl From<String> for Kid {
	fn from(value: String) -> Self {
		Self::Text(Str::new(value))
	}
}

impl El {
	/// Creates an empty element.
	pub const fn new(tag: Tag) -> Self {
		Self { tag, props: SmallVec::new(), children: Vec::new() }
	}

	/// Creates a named semantic icon (`<ico:name/>`).
	pub fn icon(name: &str) -> Self {
		Self::new(Tag::Icon).prop(Prop::Name, name)
	}

	/// Sets one attribute; `false` flags are omitted at serialization.
	#[must_use]
	pub fn prop(mut self, prop: Prop, value: impl Into<Val>) -> Self {
		self.props.push((prop, value.into()));
		self
	}

	/// Appends one child element or text run.
	#[must_use]
	pub fn child(mut self, kid: impl Into<Kid>) -> Self {
		self.children.push(kid.into());
		self
	}

	/// Appends raw text content; escaping happens at serialization.
	#[must_use]
	pub fn text(self, text: impl Into<Str>) -> Self {
		self.child(text.into())
	}

	/// Statement-form [`Self::child`] used by control flow.
	pub fn push(&mut self, kid: impl Into<Kid>) {
		self.children.push(kid.into());
	}

	/// Statement-form [`Self::text`] used by control flow.
	pub fn push_text(&mut self, text: impl Into<Str>) {
		self.children.push(Kid::Text(text.into()));
	}

	/// Serializes the tree to canonical TML once, escaping all content.
	pub fn to_tml(&self) -> Str {
		let mut output = String::with_capacity(256);
		self.write(&mut output);
		Str::new(output)
	}

	fn write(&self, output: &mut String) {
		output.push('<');
		if self.tag == Tag::Icon
			&& let Some((_, Val::Str(name))) = self.props.iter().find(|(prop, _)| *prop == Prop::Name)
		{
			// A bare name uses the inline shorthand; any styling prop needs the
			// full element form because `<ico:…/>` carries no attributes.
			if self.props.len() > 1 {
				output.push_str("icon");
				for (prop, value) in &self.props {
					if *prop != Prop::Name {
						write_prop(output, *prop, value);
					}
				}
				output.push('>');
				escape_text(output, name);
				output.push_str("</icon>");
				return;
			}
			output.push_str("ico:");
			output.push_str(name.as_str());
			output.push_str("/>");
			return;
		}
		output.push_str(self.tag.into());
		for (prop, value) in &self.props {
			write_prop(output, *prop, value);
		}
		if self.children.is_empty() {
			output.push_str("/>");
			return;
		}
		output.push('>');
		for kid in &self.children {
			match kid {
				Kid::El(el) => el.write(output),
				Kid::Text(text) => escape_text(output, text),
			}
		}
		output.push_str("</");
		output.push_str(self.tag.into());
		output.push('>');
	}
}

impl From<El> for Str {
	fn from(value: El) -> Self {
		value.to_tml()
	}
}

fn write_prop(output: &mut String, prop: Prop, value: &Val) {
	use std::fmt::Write as _;
	if matches!(value, Val::Flag(false)) {
		return;
	}
	output.push(' ');
	output.push_str(prop.into());
	match value {
		Val::Flag(_) => {},
		Val::Uint(value) => {
			write!(output, "={value}").expect("writing to String cannot fail");
		},
		Val::Int(value) => {
			write!(output, "={value}").expect("writing to String cannot fail");
		},
		Val::Tone(tone) => {
			output.push('=');
			output.push_str((*tone).into());
		},
		Val::Str(value) => {
			output.push('=');
			if needs_quotes(value) {
				output.push('"');
				escape_attr(output, value);
				output.push('"');
			} else {
				output.push_str(value.as_str());
			}
		},
	}
}

fn needs_quotes(value: &str) -> bool {
	value.is_empty()
		|| !value.bytes().all(|byte| {
			byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'#' | b'%' | b'-')
		})
}

fn escape_text(output: &mut String, text: &str) {
	for character in text.chars() {
		match character {
			'&' => output.push_str("&amp;"),
			'<' => output.push_str("&lt;"),
			'>' => output.push_str("&gt;"),
			'\t' | '\n' | '\r' => output.push(character),
			character if character.is_control() => output.push('\u{fffd}'),
			character => output.push(character),
		}
	}
}

fn escape_attr(output: &mut String, text: &str) {
	for character in text.chars() {
		match character {
			'&' => output.push_str("&amp;"),
			'<' => output.push_str("&lt;"),
			'>' => output.push_str("&gt;"),
			'"' => output.push_str("&quot;"),
			'\'' => output.push_str("&#39;"),
			character if character.is_control() => output.push('\u{fffd}'),
			character => output.push(character),
		}
	}
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;
	#[test]
	fn view_macro_lowers_elements_tones_control_flow_and_exprs() {
		let files = [("src/a.rs", 2_usize), ("src/b.rs", 1_usize)];
		let scope: Option<&str> = Some("crates");
		let el = crate::view! {
			<col gap=0>
				<row gap=1>
					<spinner color=accent/>
					<text bold>{"useState"}</text>
					if let Some(scope) = scope {
						<text fg=muted>{sf!("in {scope}")}</text>
					}
				</row>
				for (path, matches) in files {
					<row sep=" · ">
						<text>{path}</text>
						<text fg=muted>{sf!("{matches} matches")}</text>
					</row>
				}
			</col>
		};
		assert_eq!(
			el.to_tml().as_str(),
			"<col gap=0><row gap=1><spinner color=accent/><text bold>useState</text><text \
			 fg=muted>in crates</text></row><row sep=\" · \"><text>src/a.rs</text><text fg=muted>2 \
			 matches</text></row><row sep=\" · \"><text>src/b.rs</text><text fg=muted>1 \
			 matches</text></row></col>"
		);
	}

	#[test]
	fn serializes_nested_elements_props_and_escaped_text() {
		let el = El::new(Tag::Col)
			.prop(Prop::Gap, 0u64)
			.child(
				El::new(Tag::Row)
					.prop(Prop::Sep, " · ")
					.child(El::new(Tag::Text).prop(Prop::Bold, true).text("a<b&c"))
					.child(
						El::new(Tag::Text)
							.prop(Prop::Fg, Tone::Muted)
							.text(sf!("{} files", 3)),
					),
			)
			.child(El::new(Tag::Bytes).prop(Prop::Value, 2048u64));
		assert_eq!(
			el.to_tml().as_str(),
			"<col gap=0><row sep=\" · \"><text bold>a&lt;b&amp;c</text><text fg=muted>3 \
			 files</text></row><bytes value=2048/></col>"
		);
	}

	#[test]
	fn false_flags_vanish_and_attrs_quote_only_when_needed() {
		let el = El::new(Tag::Text)
			.prop(Prop::Bold, false)
			.prop(Prop::Truncate, true)
			.prop(Prop::Overflow, "diff rows")
			.prop(Prop::Wrap, "word");
		assert_eq!(el.to_tml().as_str(), "<text truncate overflow=\"diff rows\" wrap=word/>");
	}

	#[test]
	fn icon_shorthand_and_attr_escaping_round_trip() {
		let icon = El::icon("lsp");
		assert_eq!(icon.to_tml().as_str(), "<ico:lsp/>");
		let colored = El::icon("error").prop(Prop::Color, Tone::Err);
		assert_eq!(colored.to_tml().as_str(), "<icon color=err>error</icon>");
		let fact = El::new(Tag::Fact)
			.prop(Prop::Label, sf!("a\"b<c"))
			.text("v");
		assert_eq!(fact.to_tml().as_str(), "<fact label=\"a&quot;b&lt;c\">v</fact>");
	}

	#[test]
	fn kebab_props_and_multiword_tags_serialize_canonically() {
		let el = El::new(Tag::Diffstat)
			.prop(Prop::Added, 2u64)
			.prop(Prop::Removed, 1u64)
			.prop(Prop::Ops, 3u64);
		assert_eq!(el.to_tml().as_str(), "<diffstat added=2 removed=1 ops=3/>");
		let pre = El::new(Tag::Pre)
			.prop(Prop::Numbers, true)
			.prop(Prop::Start, 82u64)
			.prop(Prop::MaxRows, 8u64)
			.prop(Prop::Overflow, "lines")
			.text("line one\nline two");
		assert_eq!(
			pre.to_tml().as_str(),
			"<pre numbers start=82 max-rows=8 overflow=lines>line one\nline two</pre>"
		);
	}
}
