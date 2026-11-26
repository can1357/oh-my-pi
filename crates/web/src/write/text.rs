//! Plain-text layout in the style of Lynx 2.9.3 `-dump -nolist`.

mod embedded;
mod forms;
mod lists;
mod tables;

use std::{collections::HashMap, ops::Range};

use super::markdown::{
	admonition_kind, admonition_title, cf_email, chrome_label, contains_code, image_alt,
	is_admonition, is_code_decoration, is_gutter, is_invisible, is_lang, is_layout, own_number,
	pre_follows, script_text, word_boundary,
};
use crate::{
	dom::{Element, Node},
	select::Selection,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Align {
	Left,
	Center,
	Right,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Style {
	left:  usize,
	end:   usize,
	align: Align,
}

/// Where the current line may split: the byte offset and width of the text
/// that stays, and whether a discretionary hyphen ends that text.
#[derive(Clone, Copy)]
struct Break {
	byte:   usize,
	width:  usize,
	hyphen: bool,
}

/// Lines have independent margins; the browser reserves six columns on the
/// right for ordinary paragraphs, but no columns for a preformatted block.
struct Layout {
	columns:    usize,
	output:     String,
	line:       String,
	length:     usize,
	line_break: Option<Break>,
	field_end:  usize,
	space:      bool,
	marker:     bool,
	gap:        usize,
	style:      Style,
	next_left:  usize,
}

impl Layout {
	fn new(columns: usize) -> Self {
		let mut layout = Self {
			columns,
			output: String::new(),
			line: String::new(),
			length: 0,
			line_break: None,
			field_end: 0,
			space: false,
			marker: false,
			gap: 0,
			style: Style { left: 0, end: columns, align: Align::Left },
			next_left: 0,
		};
		let body = layout.body();
		layout.style(body);
		layout
	}

	const fn body_end(&self) -> usize {
		self.columns.saturating_sub(6)
	}

	fn body(&self) -> Style {
		self.clamped(Style { left: 3, end: self.body_end(), align: Align::Left })
	}

	fn quote(&self) -> Style {
		self.clamped(Style { left: 5, end: self.columns.saturating_sub(7), align: Align::Left })
	}

	fn address(&self) -> Style {
		self.clamped(Style { left: 4, end: self.columns.saturating_sub(7), align: Align::Left })
	}

	fn clamped(&self, style: Style) -> Style {
		let max_left = self.columns.saturating_sub(2);
		let left = style.left.min(max_left);
		let end = style
			.end
			.min(self.columns)
			.max((left + 1).min(self.columns));
		Style { left, end, align: style.align }
	}

	fn style(&mut self, style: Style) {
		let style = self.clamped(style);
		self.style = style;
		self.next_left = style.left;
	}

	fn emit(&mut self, end: usize, length: usize, hyphen: bool) {
		self.output.extend(std::iter::repeat_n('\n', self.gap));
		self.gap = 0;
		let trimmed = self.line[..end]
			.trim_end_matches(' ')
			.len()
			.max(self.field_end.min(end));
		let trimmed_width = length.saturating_sub(end - trimmed) + usize::from(hyphen);
		let spare = self
			.style
			.end
			.saturating_sub(self.style.left + trimmed_width);
		let indent = self.style.left
			+ match self.style.align {
				Align::Left => 0,
				Align::Center => spare / 2,
				Align::Right => spare,
			};
		self.output.extend(std::iter::repeat_n(' ', indent));
		self.output.push_str(&self.line[..trimmed]);
		if hyphen {
			self.output.push('-');
		}
		self.output.push('\n');
		self.style.left = self.next_left;
	}

	fn boundary(&mut self, blank: usize) {
		if !self.line.is_empty() {
			if self.field_end != 0 || !self.line.bytes().all(|b| b == b' ') {
				self.emit(self.line.len(), self.length, false);
			} else {
				self.gap += 1;
			}
			self.line.clear();
			self.length = 0;
		}
		self.space = false;
		self.marker = false;
		self.line_break = None;
		self.field_end = 0;
		if !self.output.is_empty() {
			self.gap = self.gap.max(blank);
		}
	}

	fn push(&mut self, c: char) {
		if self.length > 0 && self.length + self.style.left >= self.style.end {
			if let Some(Break { byte: split, width, hyphen }) = self.line_break.take() {
				self.emit(split, width, hyphen);
				self.line.drain(..split);
				self.length -= width;
				self.field_end = self.field_end.saturating_sub(split);
				if self.length > 0 && self.length + self.style.left >= self.style.end {
					self.boundary(0);
				}
			} else {
				self.boundary(0);
			}
		}
		self.line.push(c);
		self.length += 1;
	}

	const fn break_here(&mut self) {
		if !self.line.is_empty() {
			self.line_break =
				Some(Break { byte: self.line.len(), width: self.length, hyphen: false });
		}
	}

	/// Lynx's `LY_SOFT_HYPHEN`: an invisible split point that prints `-` when
	/// the line breaks there. It needs part of a word since the previous split
	/// and room for the hyphen.
	fn soft_hyphen(&mut self) {
		let word = self.line_break.map_or(0, |b| b.byte);
		if self.length + self.style.left < self.style.end
			&& self.line[word..].chars().any(|c| !matches!(c, ' ' | '-'))
		{
			self.line_break =
				Some(Break { byte: self.line.len(), width: self.length, hyphen: true });
		}
	}

	const fn marker_space(&mut self) {
		self.space = true;
		self.marker = true;
	}

	fn field_space(&mut self) {
		self.push(' ');
		self.field_end = self.line.len();
	}

	fn flush_space(&mut self) {
		if std::mem::take(&mut self.space) {
			if self.length + self.style.left >= self.style.end {
				self.boundary(0);
			} else {
				self.push(' ');
				if !self.marker {
					self.break_here();
				}
			}
		}
		self.marker = false;
	}

	fn text(&mut self, text: &str) {
		let mut chars = text.chars().peekable();
		while let Some(c) = chars.next() {
			if matches!(c, ' ' | '\n' | '\t' | '\r') {
				self.space = !self.line.is_empty();
				continue;
			}
			if c.is_ascii_control() || is_invisible(c) {
				continue;
			}
			// A joiner that joins nothing (at a heading's edge) is dropped,
			// as in Markdown.
			if c == '\u{200D}'
				&& (self.space
					|| self.line.is_empty()
					|| self.line.ends_with(' ')
					|| chars
						.peek()
						.is_none_or(|&next| matches!(next, ' ' | '\n' | '\t' | '\r')))
			{
				continue;
			}
			self.flush_space();
			if c == '\u{ad}' {
				self.soft_hyphen();
			} else {
				self.push(if c == '\u{a0}' { ' ' } else { c });
			}
		}
	}

	fn literal_newline(&mut self) {
		let blank = self.line.is_empty();
		self.boundary(0);
		self.gap += usize::from(blank);
	}

	fn literal(&mut self, text: &str) {
		self.flush_space();
		for c in text.chars() {
			match c {
				'\n' => self.literal_newline(),
				// The browser's last predefined tab stop is column 176.
				'\t' if self.length >= 176 => self.literal_newline(),
				'\t' => {
					for _ in 0..8 - self.length % 8 {
						self.push(' ');
					}
				},
				'\u{ad}' => {},
				'\u{a0}' => self.push(' '),
				c if !c.is_ascii_control() && !is_invisible(c) => self.push(c),
				_ => {},
			}
		}
	}

	fn separator(&mut self) {
		if self.line.is_empty() {
			self.push(' ');
		} else {
			self.space = true;
		}
	}
}

fn attr<'a>(tag: &'a Element, key: &str) -> &'a str {
	tag.attr(key).unwrap_or_default()
}

fn flag(tag: &Element, key: &str) -> bool {
	tag.has_attr(key)
}

const fn alignment(value: &str) -> Option<Align> {
	if value.eq_ignore_ascii_case("center") {
		Some(Align::Center)
	} else if value.eq_ignore_ascii_case("right") {
		Some(Align::Right)
	} else if value.eq_ignore_ascii_case("left") || value.eq_ignore_ascii_case("justify") {
		Some(Align::Left)
	} else {
		None
	}
}

fn align(tag: &Element, style: Style) -> Style {
	Style { align: alignment(attr(tag, "align")).unwrap_or(style.align), ..style }
}

fn selected_nodes<'a>(
	nodes: &'a [Node],
	dropped: &'a [bool],
	range: Range<usize>,
) -> impl Iterator<Item = (usize, &'a Node)> {
	let mut i = range.start;
	std::iter::from_fn(move || {
		while i < range.end {
			let index = i;
			let node = &nodes[index];
			if !dropped.get(index).copied().unwrap_or(false) {
				i += 1;
				return Some((index, node));
			}
			i = match node {
				Node::Text(_) => i + 1,
				Node::Tag(tag) => tag.children.end,
			};
		}
		None
	})
}

struct Reader<'a> {
	dom:           &'a [Node],
	dropped:       &'a [bool],
	/// End of the selection root; image lookahead never reads past it.
	root_end:      usize,
	/// Inside a `pre` that holds a `code` element, outside that element:
	/// toolbars and gutters here are not code.
	pre_code:      bool,
	/// Arena index of an ordered item's own visible number, which its list
	/// marker already shows.
	skip:          Option<usize>,
	layout:        Layout,
	lists:         lists::Lists,
	forms:         forms::Forms,
	last_pre:      bool,
	pre:           bool,
	pre_first:     bool,
	parent:        &'a str,
	division:      Option<Align>,
	anchor:        bool,
	toolbar:       bool,
	orphan_option: String,
	table_grid:    Option<bool>,
	tabs:          HashMap<&'a str, usize>,
	quotes:        usize,
}

/// Lay out the selected HTML nodes as plain text at the given column width.
pub fn write(nodes: &[Node], selection: &Selection, width: usize) -> String {
	let mut reader = Reader {
		dom:           nodes,
		dropped:       &selection.dropped,
		root_end:      selection.root.end,
		pre_code:      false,
		skip:          None,
		layout:        Layout::new(width.clamp(1, 1024)),
		lists:         lists::Lists::default(),
		forms:         forms::Forms::scan(nodes, selection),
		last_pre:      false,
		pre:           false,
		pre_first:     false,
		parent:        "",
		division:      None,
		anchor:        false,
		toolbar:       false,
		orphan_option: String::new(),
		table_grid:    None,
		tabs:          HashMap::new(),
		quotes:        0,
	};
	reader.nodes(selection.root.clone());
	if !reader.orphan_option.is_empty() {
		reader.layout.text(" ");
		reader.layout.text(&reader.orphan_option);
	}
	reader.layout.boundary(0);
	if reader.layout.output.is_empty() {
		reader.layout.output.push('\n');
	}
	reader.layout.output
}

#[cfg(test)]
fn dump(html: &str) -> Result<String, String> {
	let nodes = crate::dom::parse_stdin(html)?;
	let selection = Selection {
		root:             0..nodes.len(),
		dropped:          vec![false; nodes.len()],
		recoverable_only: false,
	};
	Ok(write(&nodes, &selection, 250))
}

#[cfg(test)]
#[test]
fn shares_the_markdown_writers_word_rules() {
	// Separated labels, Unicode scripts, an image whose alt the caption
	// repeats, and a decoded Cloudflare address.
	assert_eq!(
		dump(
			"<p><time>May 1</time><span class=b>2 min</span> x<sup>2</sup> <img alt=\"Chart\" \
			 src=\"/c.png\">Chart <span class=\"__cf_email__\" \
			 data-cfemail=\"422a2b023a6c2b2d\">[email protected]</span></p>"
		)
		.unwrap()
		.trim(),
		"May 1 2 min x² Chart hi@x.io"
	);
	// An item's own number, an edge joiner and a CSS-drawn separator.
	assert_eq!(
		dump("<ol><li><span>1</span>Vercel</li></ol>")
			.unwrap()
			.trim(),
		"1. Vercel"
	);
	assert_eq!(
		dump("<p>\u{200d}Gdk<span class=\"sep\"></span>get\u{200d}</p>")
			.unwrap()
			.trim(),
		"Gdk get"
	);
	// A code block's language toolbar, copy button and line numbers are not
	// text.
	assert_eq!(
		dump(
			"<div><div>lua<button>Copy</button></div><pre><code>local x</code><div \
			 class=\"line-numbers-wrapper\"><span class=\"line-number\">1</span></div></pre></div>"
		)
		.unwrap()
		.trim(),
		"local x"
	);
}

#[cfg(test)]
#[test]
fn renders_only_the_selected_range_and_skips_whole_dropped_subtrees() {
	let nodes = crate::dom::parse("outside<main>keep<aside>hidden</aside> tail</main>").unwrap();
	let selection = Selection {
		root:             2..nodes.len(),
		dropped:          vec![false, false, false, true, false, false],
		recoverable_only: true,
	};
	assert_eq!(write(&nodes, &selection, 250), "   keep tail\n");
}

impl Reader<'_> {
	fn is_skipped(&self, index: usize) -> bool {
		self.dropped.get(index).copied().unwrap_or(false)
	}

	/// Write a range of sibling nodes. The word-level rules shared with the
	/// Markdown writer apply here: line-number gutters and code-block
	/// toolbars are skipped, and adjacent elements that CSS keeps apart get a
	/// space.
	fn nodes(&mut self, range: Range<usize>) {
		let dom = self.dom;
		let parent_tag = match range.start.checked_sub(1).and_then(|i| dom.get(i)) {
			Some(Node::Tag(tag)) if tag.children == range => Some(tag),
			_ => None,
		};
		let layout = parent_tag.is_some_and(is_layout);
		let previous_parent =
			std::mem::replace(&mut self.parent, parent_tag.map_or("", |tag| tag.name()));
		let mut previous: Option<&Node> = None;
		let mut i = range.start;
		while i < range.end {
			if self.is_skipped(i) {
				i = match &dom[i] {
					Node::Text(_) => i + 1,
					Node::Tag(tag) => tag.children.end,
				};
				continue;
			}
			let node = &dom[i];
			if let Node::Tag(tag) = node
				&& (is_gutter(tag)
					|| self.skip == Some(i)
					|| (self.pre && is_code_decoration(tag))
					|| (self.pre_code && tag.name() != "code" && !contains_code(dom, self.dropped, tag)))
			{
				i = tag.children.end;
				continue;
			}
			if !self.pre
				&& !self.layout.space
				&& self.parent != "option"
				&& let Some(previous) = previous
				&& word_boundary(
					dom,
					self.dropped,
					previous,
					node,
					layout,
					self.layout.line.chars().next_back(),
				) {
				self.layout.space = true;
			}
			previous = Some(node);
			match node {
				Node::Text(text) => {
					if self.parent == "option" {
						self.orphan_option.push_str(text);
					} else if self.pre {
						let text = if std::mem::take(&mut self.pre_first) {
							text.strip_prefix('\n').unwrap_or(text)
						} else {
							text
						};
						self.layout.literal(text);
					} else {
						self.layout.text(text);
						if text.bytes().any(|b| !b.is_ascii_whitespace()) {
							self.last_pre = false;
						}
					}
					i += 1;
				},
				Node::Tag(tag) => {
					i = tag.children.end;
					if !self.pre
						&& pre_follows(dom, self.dropped, i..range.end)
						&& let Some(label) = chrome_label(dom, self.dropped, tag)
					{
						// A code-block toolbar: a language label is not text
						// (Markdown makes it the fence's info string).
						if !label.is_empty() && !is_lang(&label) {
							self.layout.boundary(0);
							self.layout.text(&label);
							self.layout.boundary(0);
						}
						continue;
					}
					if self.pre_code && tag.name() == "code" {
						self.pre_code = false;
						self.element(tag);
						self.pre_code = true;
					} else {
						self.element(tag);
					}
				},
			}
		}
		self.parent = previous_parent;
	}

	fn element(&mut self, tag: &Element) {
		let tag_name = tag.name();
		let adjacent_pre = std::mem::take(&mut self.last_pre);
		let children = tag.children.clone();
		let old = self.layout.style;
		let body = self.layout.body();
		let address = self.layout.address();
		if let Some(email) = tag.attr("data-cfemail").and_then(cf_email) {
			self.layout.text(&email);
			return;
		}
		if is_admonition(tag)
			&& admonition_title(self.dom, self.dropped, tag).is_none()
			&& let Some(kind) = admonition_kind(tag)
		{
			self.layout.boundary(1);
			self.layout.text(kind);
			self.layout.boundary(0);
		}
		let (before, after, style) = match tag_name {
			"title" | "script" | "style" | "base" => return,
			"meta" => return self.refresh(tag),
			"head" => {
				self.nodes(children);
				if self.toolbar {
					self.layout.boundary(1);
				}
				return;
			},
			"link" => return self.toolbar_link(tag),
			"body" | "section" | "main" | "article" | "footer" | "header" | "aside" | "nav"
				if self.toolbar =>
			{
				self.layout.boundary(1);
				return self.nodes(children);
			},
			"a" => {
				let old_anchor = std::mem::replace(&mut self.anchor, flag(tag, "href"));
				self.nodes(children);
				self.anchor = old_anchor;
				return;
			},
			"wbr" => {
				if !self.layout.space {
					self.layout.break_here();
				}
				return;
			},
			"hy" | "shy" => return,
			"tab" => return self.tab(tag.index()),
			"br" => {
				if self.break_empty_marker() {
					return;
				}
				self.layout.boundary(0);
				return;
			},
			"hr" => {
				self.layout.boundary(0);
				self.layout.gap = self.layout.gap.saturating_sub(1);
				let available = old.end.saturating_sub(old.left);
				let width = attr(tag, "width")
					.strip_suffix('%')
					.and_then(|s| {
						s[..s.bytes().take_while(u8::is_ascii_digit).count()]
							.parse::<usize>()
							.ok()
					})
					.filter(|p| (1..=100).contains(p))
					.map_or_else(|| available.saturating_sub(5), |p| (available * p / 100).max(1));
				self
					.layout
					.style(align(tag, Style { align: Align::Center, ..old }));
				for _ in 0..width {
					self.layout.push('_');
				}
				self.layout.boundary(usize::from(!self.pre));
				self.layout.style(old);
				return;
			},
			"img" => return self.image(tag),
			"embed" | "applet" => {
				self.media_separator();
				self
					.layout
					.text(
						tag.attr("alt")
							.unwrap_or(if tag_name == "embed" { "[EMBED]" } else { "" }),
					);
				self.layout.space = !self.layout.line.ends_with(' ');
				self.nodes(children);
				if tag_name == "applet" {
					self.layout.space = true;
				}
				return;
			},
			"object" if flag(tag, "declare") || !attr(tag, "name").trim().is_empty() => return,
			"object" if !attr(tag, "usemap").is_empty() => {
				self.image(tag);
				if selected_nodes(self.dom, self.dropped, children.clone())
					.any(|(_, n)| matches!(n, Node::Tag(t) if t.name() == "map"))
				{
					self.nodes(children);
				}
				return;
			},
			"math" => {
				if !children.is_empty() {
					self.layout.boundary(0);
					self.layout.text("[MATH: ");
					self.nodes(children);
					self.layout.text(" :MATH]");
					self.layout.boundary(0);
				}
				return;
			},
			"input" => {
				self.input(tag);
				return;
			},
			"select" => {
				self.orphan_option.clear();
				self.select(tag);
				return;
			},
			"textarea" => {
				self.textarea(tag);
				return;
			},
			"button" => return self.button(tag),
			"pre" | "xmp" | "listing" | "plaintext" => {
				self.layout.boundary(0);
				if adjacent_pre {
					self.layout.gap = 0;
				}
				self
					.layout
					.style(Style { left: 0, end: self.layout.columns, align: Align::Left });
				let was_pre = std::mem::replace(&mut self.pre, true);
				let was_code =
					std::mem::replace(&mut self.pre_code, contains_code(self.dom, self.dropped, tag));
				self.pre_first = tag_name == "pre";
				self.nodes(children);
				self.pre = was_pre;
				self.pre_code = was_code;
				if tag_name == "pre" || !self.layout.line.is_empty() {
					self.layout.literal_newline();
				}
				// A style change adds one blank line. Adjacent literal blocks
				// cancel only that synthetic gap, never an explicit newline.
				self.last_pre = self.layout.gap == 0 && !self.layout.output.is_empty();
				self.layout.boundary(1);
				self.layout.style(old);
				return;
			},
			"table" => return self.table(tag),
			"ul" | "ol" | "menu" | "dir" | "dl" | "dlc" => return self.list(tag),
			"li" | "lh" | "dt" | "dd" => return self.list_item(tag),
			"h1" | "h2" | "h3" | "h4" | "h5" | "h6"
				if self.lists.has_markers()
					&& matches!(self.parent, "ul" | "ol" | "menu" | "dir" | "li") =>
			{
				return self.list_heading(tag);
			},
			"h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
				let level = tag_name.as_bytes()[1] - b'1';
				let mut style = Style {
					left:  2 * level.saturating_sub(1) as usize,
					end:   self.layout.columns,
					align: if level == 0 {
						Align::Center
					} else {
						Align::Left
					},
				};
				let value = attr(tag, "align");
				if let Some(align) = if value.is_empty() {
					self.division
				} else {
					alignment(value)
				} {
					style = Style { left: 0, end: self.layout.columns.saturating_sub(3), align };
				}
				(1, 1, style)
			},
			"p" if !self.lists.is_empty() => return self.list_paragraph(tag),
			"div"
				if !self.lists.is_empty()
					&& !attr(tag, "align").eq_ignore_ascii_case("center")
					&& !attr(tag, "align").eq_ignore_ascii_case("right") =>
			{
				return self.list_paragraph(tag);
			},
			"p" => (usize::from(old != address && !self.pre), 0, align(tag, old)),
			"div" | "center" => {
				let style = if tag_name == "center" {
					Style { align: Align::Center, ..body }
				} else {
					align(tag, body)
				};
				let enclosing = self.division.replace(style.align);
				let gap = usize::from(enclosing != Some(style.align) || old.left != style.left);
				self.layout.boundary(gap);
				self.layout.style(style);
				self.nodes(children);
				self.layout.boundary(gap);
				self.layout.style(old);
				self.division = enclosing;
				return;
			},
			"fieldset" | "legend" | "noframes" | "marquee" | "banner" | "fig" => (1, 1, body),
			"frame" | "iframe" => {
				let frame = tag_name == "frame";
				let src = attr(tag, "src");
				if !src.is_empty() {
					self.layout.boundary(usize::from(!frame));
					self.layout.text(if frame { "FRAME: " } else { "IFRAME: " });
					self
						.layout
						.text(tag.attr("name").filter(|n| !n.is_empty()).unwrap_or(src));
					self.layout.boundary(0);
				}
				self.nodes(children);
				self.layout.boundary(usize::from(!frame));
				return;
			},
			"blockquote" | "bq" | "note" | "fn" => (1, 1, self.layout.quote()),
			"caption" | "credit" => (1, 1, body),
			"address" => {
				if self.layout.output.is_empty() && self.layout.line.is_empty() {
					self.layout.gap = 2;
				}
				(2, 1, address)
			},
			"q" => {
				self
					.layout
					.text(if self.quotes % 2 == 0 { "\"" } else { "`" });
				self.quotes += 1;
				self.nodes(children);
				self.quotes -= 1;
				self
					.layout
					.text(if self.quotes % 2 == 0 { "\"" } else { "'" });
				return;
			},
			"sub" | "sup" => {
				// The same rendering as Markdown: `τ²`, `1st`, `x^(n + 1)`.
				let inner = self.inner(tag);
				let body = inner.split_whitespace().collect::<Vec<_>>().join(" ");
				let before = if self.layout.space {
					None
				} else {
					self.layout.line.chars().next_back()
				};
				self
					.layout
					.text(&script_text(&body, tag_name == "sup", before));
				return;
			},
			"del" | "ins" | "s" | "strike" => {
				let (prefix, suffix) = match tag_name {
					"ins" => ("[INS: ", " :INS] "),
					_ => ("[DEL: ", " :DEL] "),
				};
				self.layout.text(prefix);
				self.nodes(children);
				self.layout.text(suffix);
				return;
			},
			"form" => {
				self.nodes(children);
				self.layout.boundary(0);
				return;
			},
			_ => return self.nodes(children),
		};
		self.layout.boundary(before);
		self.layout.style(style);
		match tag_name {
			"caption" => self.layout.text("CAPTION: "),
			"credit" => self.layout.text("CREDIT: "),
			"fn" => self.layout.text("FOOTNOTE: "),
			"note" => {
				let label = [attr(tag, "class"), attr(tag, "role")]
					.into_iter()
					.find_map(|kind| {
						["WARNING", "CAUTION"]
							.into_iter()
							.find(|s| kind.eq_ignore_ascii_case(s))
					});
				self.layout.text(label.unwrap_or("NOTE"));
				self.layout.text(": ");
			},
			_ => {},
		}
		self.nodes(children);
		self.layout.boundary(after);
		self.layout.style(old);
	}

	fn inner(&self, tag: &Element) -> String {
		let mut text = String::new();
		let mut i = tag.children.start;
		while i < tag.children.end {
			if self.is_skipped(i) {
				i = match &self.dom[i] {
					Node::Text(_) => i + 1,
					Node::Tag(el) => el.children.end,
				};
				continue;
			}
			match &self.dom[i] {
				Node::Text(raw) => text.push_str(raw),
				Node::Tag(el) => match el.name() {
					"script" | "style" | "head" | "option" | "td" | "th" | "tr" => {
						i = el.children.end;
						continue;
					},
					"br" => text.push('\n'),
					"img" => text.push_str(attr(el, "alt")),
					_ => {},
				},
			}
			i += 1;
		}
		text
	}
}
