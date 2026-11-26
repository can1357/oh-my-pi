//! CommonMark writer (with GFM tables and strikethrough) for a selected HTML
//! subtree.
//!
//! One walk over the selection: inline content accumulates in a paragraph
//! buffer with HTML whitespace collapsing, and block structure (blockquotes,
//! list items, definitions) is carried as a stack of line prefixes applied as
//! each line is written. The writer never emits front matter; the reader adds
//! title and metadata itself.
//!
//! Besides element semantics, the writer honours a few page conventions that
//! no selection mask can express: heading permalinks are dropped, links that
//! wrap whole cards keep their blocks, class-named headings (`md-h1`,
//! `heading-h2`, `role="heading"`, `p.rubric`, `emu-clause` depth) become
//! headings, admonitions become labelled blockquotes, code-block toolbars and
//! line-number gutters stay out of code, Cloudflare-obfuscated addresses are
//! decoded, and decorative images are omitted.

use std::{fmt::Write as _, mem, ops::Range};

use unicode_width::UnicodeWidthStr;
use url::Url;

use crate::{
	dom::{Element, Node},
	select::Selection,
};

/// Render the selected nodes as Markdown.
///
/// Links and image sources resolve against `base`. Links to `javascript:`,
/// `vbscript:` or `data:` targets keep only their text, a `data:` image keeps
/// only its alt text (`![alt]`), an image without informative alt text
/// (spacers, tracking pixels, file names, separator bars, an alt that repeats
/// the text right after it) is omitted, an image URL over 512 bytes keeps only
/// its alt text, and `images = false` omits images entirely. A `pre` that
/// links somewhere and holds neither code markup nor diff or mail lines is a
/// preformatted document (RFCs, man pages): its lines become hard-broken
/// paragraph lines that keep their links. Subtrees flagged in
/// `selection.dropped` are skipped; `script`, `style`, `head`, `title` and
/// `template` (except declarative shadow roots) never contribute text.
#[must_use]
pub fn write(nodes: &[Node], selection: &Selection, base: Option<&Url>, images: bool) -> String {
	let root = selection.root.start..selection.root.end.min(nodes.len());
	let mut writer = Writer {
		nodes,
		dropped: &selection.dropped,
		root_end: root.end,
		base,
		images,
		out: String::new(),
		inline: String::new(),
		pending_space: false,
		pending_break: false,
		open_start: 0,
		open_end: usize::MAX,
		last_char: None,
		pending_close: None,
		skip: None,
		prefix: Vec::new(),
		blank: None,
		fresh: true,
		inline_only: 0,
		plain: false,
		in_cell: false,
		in_link: false,
		in_heading: false,
		block_link: None,
		notes: Vec::new(),
		active: [false; STYLES],
		lang: None,
		chrome_lang: None,
		after_image: false,
		last_level: 0,
		clause_depth: 0,
	};
	writer.children(root);
	writer.finish()
}

/// Longest image URL worth writing; longer ones embed their payload.
const IMAGE_URL_MAX_LEN: usize = 512;

/// Longest name cell of a property table (`c2coff`, `timeout (ms)`).
const PROPERTY_NAME_MAX_CHARS: usize = 80;

/// Width or height, in CSS pixels, below which an image is an icon, avatar
/// or rule.
const ICON_MAX_PX: f32 = 48.0;

/// Zero-width joiner: joins emoji sequences, invisible elsewhere.
const ZWJ: char = '\u{200D}';

/// Nodes scanned ahead for an image's repeated alt text or an element's first
/// character; enough for a heading or a label, bounded for huge siblings.
const LOOKAHEAD_NODES: usize = 64;

/// List and definition markers; the first line of an item carries the marker,
/// later lines indent by its width.
#[derive(Clone, Copy)]
enum Marker {
	Bullet,
	Number(u64),
	Colon,
}

impl Marker {
	/// Indent of an item's continuation lines. A definition indents by its
	/// `: ` marker so lists and later paragraphs stay inside it; a definition
	/// nested in another adds no indent (see `Writer::item`), so nesting never
	/// reaches the four columns of an indented code block.
	const fn width(self) -> usize {
		match self {
			Self::Bullet | Self::Colon => 2,
			Self::Number(n) => match n.checked_ilog10() {
				Some(digits) => digits as usize + 3,
				None => 3,
			},
		}
	}
}

enum Prefix {
	Quote,
	Item { width: usize, marker: Option<Marker>, definition: bool },
}

#[derive(Clone, Copy)]
enum Style {
	Strong,
	Em,
	Del,
	Quote,
}

const STYLES: usize = 4;

impl Style {
	const fn markers(self) -> (&'static str, &'static str) {
		match self {
			Self::Strong => ("**", "**"),
			Self::Em => ("*", "*"),
			Self::Del => ("~~", "~~"),
			Self::Quote => ("\"", "\""),
		}
	}
}

/// Emphasis markers whose closer ends in punctuation: CommonMark cannot close
/// them before a letter or digit (`**SF.**Multiple`), so they are removed if
/// one follows directly.
#[derive(Clone, Copy)]
struct Markers {
	open:     usize,
	open_len: usize,
	close:    usize,
	end:      usize,
}

/// Paragraph-buffer state saved when an inline opener is pushed, restored if
/// the element turns out empty.
#[derive(Clone, Copy)]
struct Mark {
	len:        usize,
	space:      bool,
	brk:        bool,
	open_start: usize,
	open_end:   usize,
	after:      usize,
}

/// Table rows and the facts that decide how the table is written.
#[derive(Default)]
struct Shape<'a> {
	rows:    Vec<Vec<&'a Element>>,
	caption: Option<&'a Element>,
	/// Any `th` cell.
	header:  bool,
	/// Nested tables, block-level cell content, or content outside cells.
	layout:  bool,
}

struct Writer<'a> {
	nodes:         &'a [Node],
	dropped:       &'a [bool],
	/// End of the selection root; lookahead never reads past it.
	root_end:      usize,
	base:          Option<&'a Url>,
	images:        bool,
	out:           String,
	/// Inline Markdown of the paragraph being built.
	inline:        String,
	pending_space: bool,
	pending_break: bool,
	/// Start of the run of openers that `inline` currently ends with.
	open_start:    usize,
	/// End of that run, or `usize::MAX` once content follows.
	open_end:      usize,
	/// Last visible character of the paragraph, before escaping.
	last_char:     Option<char>,
	/// Emphasis that a following letter or digit would leave unclosed.
	pending_close: Option<Markers>,
	/// Arena index of an element not to write: an ordered item's own
	/// visible number, which the list marker already shows.
	skip:          Option<usize>,
	prefix:        Vec<Prefix>,
	/// Prefix depth of a blank line owed before the next written line.
	blank:         Option<usize>,
	/// Nothing written since the output or the current item began.
	fresh:         bool,
	/// Depth of contexts (links, headings, styles, table cells) where block
	/// elements collapse to spaces.
	inline_only:   usize,
	/// Unmarked text for text-grid cells: no escapes, no markup.
	plain:         bool,
	/// GFM table cell: line breaks become `<br>`.
	in_cell:       bool,
	in_link:       bool,
	/// Inside a heading or a definition term, where permalinks are dropped.
	in_heading:    bool,
	/// Target of a link wrapping block content, waiting for the first heading
	/// or paragraph inside it.
	block_link:    Option<String>,
	/// Sidenotes lifted out of a heading or term, written after it.
	notes:         Vec<&'a Element>,
	active:        [bool; STYLES],
	/// Code language from an enclosing `div`.
	lang:          Option<String>,
	/// Code language from a toolbar right before the next `pre`.
	chrome_lang:   Option<String>,
	/// No text since the last image: the next image needs a separating space
	/// (`<a><img alt="Fire"></a><a><img alt="Fire"></a>` reads "Fire Fire").
	after_image:   bool,
	/// Level of the last heading written (0 before any).
	last_level:    usize,
	/// Nesting depth of ecmarkup clauses, whose headings are all `h1`.
	clause_depth:  usize,
}

impl<'a> Writer<'a> {
	const fn siblings(&self, range: Range<usize>) -> Siblings<'a> {
		siblings(self.nodes, self.dropped, range)
	}

	const fn descendants(&self, range: Range<usize>) -> Descendants<'a> {
		descendants(self.nodes, self.dropped, range)
	}

	fn finish(mut self) -> String {
		self.flush();
		let len = self.out.trim_end_matches('\n').len();
		self.out.truncate(len);
		if !self.out.is_empty() {
			self.out.push('\n');
		}
		self.out
	}

	// ── Lines and blocks ──────────────────────────────────────────────────

	fn write_prefix(&mut self, depth: usize, blank: bool) {
		for entry in &mut self.prefix[..depth] {
			match entry {
				Prefix::Quote => self.out.push_str("> "),
				Prefix::Item { width, marker, .. } => {
					let start = self.out.len();
					if !blank && let Some(marker) = marker.take() {
						match marker {
							Marker::Bullet => self.out.push_str("- "),
							Marker::Colon => self.out.push_str(": "),
							Marker::Number(n) => {
								let _ = write!(self.out, "{n}. ");
							},
						}
					}
					while self.out.len() - start < *width {
						self.out.push(' ');
					}
				},
			}
		}
	}

	fn trim_spaces(&mut self) {
		let len = self.out.trim_end_matches(' ').len();
		self.out.truncate(len);
	}

	/// Write one output line under the current prefixes.
	fn line(&mut self, parts: &[&str]) {
		if let Some(depth) = self.blank.take() {
			self.write_prefix(depth, true);
			self.trim_spaces();
			self.out.push('\n');
		}
		self.write_prefix(self.prefix.len(), false);
		for part in parts {
			self.out.push_str(part);
		}
		if parts.iter().all(|part| part.is_empty()) {
			self.trim_spaces();
		}
		self.out.push('\n');
		self.fresh = false;
	}

	/// Owe a blank line before the next written line.
	fn gap(&mut self) {
		if !self.fresh {
			let depth = self.prefix.len();
			self.blank = Some(self.blank.map_or(depth, |owed| owed.min(depth)));
		}
	}

	const fn reset_inline(&mut self) {
		self.pending_space = false;
		self.pending_break = false;
		self.open_end = usize::MAX;
		self.last_char = None;
		self.pending_close = None;
	}

	/// Write the paragraph buffer, if it holds anything. A paragraph of a lone
	/// separator glyph (`|`, `·`, a detached quote mark) is dropped, and the
	/// first real paragraph of a block link carries its target.
	fn flush(&mut self) {
		self.reset_inline();
		if self.inline.is_empty() {
			return;
		}
		let mut buffer = mem::take(&mut self.inline);
		let text = buffer.trim_matches(is_ws);
		// The only content of a definition is a value ("—" for "not
		// provided"), not a separator.
		let item_value =
			self.fresh && matches!(self.prefix.last(), Some(Prefix::Item { definition: true, .. }));
		if !text.chars().all(char::is_whitespace) && (item_value || !is_separator(text)) {
			let target = if text.starts_with("![") || !text.chars().any(char::is_alphanumeric) {
				None
			} else {
				self.block_link.take()
			};
			match target {
				Some(target) => {
					let mut linked = String::with_capacity(text.len() + target.len() + 4);
					linked.push('[');
					linked.push_str(text);
					linked.push_str("](");
					push_destination(&mut linked, &target);
					linked.push(')');
					for line in linked.split('\n') {
						self.paragraph_line(line);
					}
				},
				None => {
					for line in text.split('\n') {
						self.paragraph_line(line);
					}
				},
			}
		}
		buffer.clear();
		self.inline = buffer;
	}

	/// Write a paragraph line, escaping what would open a block at its start.
	fn paragraph_line(&mut self, line: &str) {
		let bytes = line.as_bytes();
		let split = match bytes.first() {
			Some(b'#' | b'>' | b'+' | b'-' | b'=') => Some(0),
			Some(b'0'..=b'9') => {
				let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
				(digits <= 9
					&& matches!(bytes.get(digits), Some(b'.' | b')'))
					&& matches!(bytes.get(digits + 1), None | Some(b' ')))
				.then_some(digits)
			},
			_ => None,
		};
		match split {
			Some(at) => self.line(&[&line[..at], "\\", &line[at..]]),
			None => self.line(&[line]),
		}
	}

	fn block(&mut self, el: &'a Element) {
		self.flush();
		self.gap();
		self.content(el);
		self.flush();
		self.gap();
	}

	// ── Inline buffer ─────────────────────────────────────────────────────

	const fn space(&mut self) {
		if !self.pending_break {
			self.pending_space = true;
		}
	}

	/// Settle pending whitespace or a line break before content is pushed.
	fn before_content(&mut self) {
		if self.pending_break {
			self.pending_break = false;
			self.pending_space = false;
			if !self.inline.is_empty() && !self.inline.ends_with('\n') {
				self
					.inline
					.push_str(if self.in_cell { "<br>" } else { "\\\n" });
			}
		} else if self.pending_space {
			self.pending_space = false;
			if !self.inline.is_empty() && !self.inline.ends_with([' ', '\n']) {
				if self.inline.len() == self.open_end {
					// Leading whitespace inside an opener moves before it.
					if self.open_start > 0 && !self.inline[..self.open_start].ends_with([' ', '\n']) {
						self.inline.insert(self.open_start, ' ');
					}
				} else {
					self.inline.push(' ');
				}
			}
		}
		self.open_end = usize::MAX;
	}

	fn open(&mut self, marker: &str) -> Mark {
		let mut mark = Mark {
			len:        self.inline.len(),
			space:      self.pending_space,
			brk:        self.pending_break,
			open_start: self.open_start,
			open_end:   self.open_end,
			after:      0,
		};
		self.before_content();
		let start = self.inline.len();
		if !self.plain {
			self.inline.push_str(marker);
		}
		if mark.open_end != start {
			self.open_start = start;
		}
		self.open_end = self.inline.len();
		mark.after = self.inline.len();
		mark
	}

	/// Close an opener; an element with no content leaves nothing behind.
	fn close(&mut self, mark: Mark, marker: &str) -> bool {
		if self.inline.len() == mark.after {
			self.inline.truncate(mark.len);
			self.pending_space |= mark.space;
			self.pending_break |= mark.brk;
			self.open_start = mark.open_start;
			self.open_end = mark.open_end;
			return false;
		}
		if !self.plain {
			self.inline.push_str(marker);
		}
		true
	}

	fn text(&mut self, text: &str) {
		let mut chars = text.char_indices().peekable();
		while let Some((at, ch)) = chars.next() {
			if is_ws(ch) {
				self.space();
				continue;
			}
			if is_invisible(ch) {
				continue;
			}
			if ch == ZWJ
				&& (self.pending_space
					|| self.last_char.is_none()
					|| chars.peek().is_none_or(|&(_, next)| is_ws(next)))
			{
				// A joiner that joins nothing (at a heading's edge).
				continue;
			}
			self.before_content();
			if let Some(close) = self.pending_close.take()
				&& self.inline.len() == close.end
				&& ch.is_alphanumeric()
			{
				self.unwrap_markers(close);
			}
			if !self.plain {
				let escape = match ch {
					'\\' | '`' | '*' | '[' | ']' | '<' | '~' => true,
					// Intraword underscores cannot open emphasis.
					'_' => {
						!(self
							.inline
							.chars()
							.next_back()
							.is_some_and(char::is_alphanumeric)
							&& chars
								.peek()
								.is_some_and(|&(_, next)| next.is_alphanumeric()))
					},
					'&' => entity_like(&text[at + 1..]),
					_ => false,
				};
				if escape {
					self.inline.push('\\');
				}
			}
			self.inline.push(ch);
			self.last_char = Some(ch);
			self.after_image = false;
		}
	}

	fn br(&mut self) {
		if self.plain || (self.inline_only > 0 && !self.in_cell) {
			self.space();
		} else if self.pending_break && self.inline_only == 0 {
			// Two breaks in a row separate paragraphs.
			self.flush();
			self.gap();
		} else {
			self.pending_break = true;
			self.pending_space = false;
		}
	}

	// ── Elements ──────────────────────────────────────────────────────────

	fn children(&mut self, range: Range<usize>) {
		self.children_in(range, false);
	}

	/// Write an element's children; `layout` marks a flex or grid container.
	fn content(&mut self, el: &'a Element) {
		self.children_in(el.children.clone(), is_layout(el));
	}

	fn children_in(&mut self, range: Range<usize>, layout: bool) {
		let mut siblings = self.siblings(range);
		let mut previous: Option<&'a Node> = None;
		while let Some(node) = siblings.next() {
			if let Node::Tag(el) = node
				&& (is_skipped(el) || self.skip == Some(el.index()))
			{
				continue;
			}
			if let Some(previous) = previous
				&& !self.pending_space
				&& !self.pending_break
				&& word_boundary(self.nodes, self.dropped, previous, node, layout, self.last_char)
			{
				self.space();
			}
			previous = Some(node);
			let el = match node {
				Node::Text(text) => {
					self.text(text);
					continue;
				},
				Node::Tag(el) => el,
			};
			if self.inline_only == 0
				&& next_is_pre(siblings.clone())
				&& let Some(label) = chrome_label(self.nodes, self.dropped, el)
			{
				// A code-block toolbar: its label names the language, or (a
				// file name) stays as a caption; its buttons never show.
				if is_lang(&label) {
					self.chrome_lang = Some(label.to_ascii_lowercase());
				} else if !label.is_empty() {
					self.flush();
					self.gap();
					self.text(&label);
					self.flush();
					self.gap();
				}
				continue;
			}
			self.element(el);
		}
	}

	fn node(&mut self, node: &'a Node) {
		match node {
			Node::Text(text) => self.text(text),
			Node::Tag(el) => self.element(el),
		}
	}

	fn element(&mut self, el: &'a Element) {
		if is_skipped(el) || is_gutter(el) {
			return;
		}
		if let Some(email) = el.attr("data-cfemail").and_then(cf_email) {
			return self.text(&email);
		}
		if has_class(el, "sidenote") || has_class(el, "marginnote") {
			return self.sidenote(el);
		}
		let name = el.name();
		if name == "label" && has_class(el, "margin-toggle") {
			return;
		}
		if self.inline_only > 0 && is_block(name) {
			if is_preformatted(name) {
				return self.code_span(el);
			}
			self.space();
			self.content(el);
			self.space();
			return;
		}
		if self.inline_only == 0 {
			if let Some(level) = self.heading_level(el) {
				return self.heading(el, level);
			}
			if is_admonition(el) {
				return self.admonition(el);
			}
			if !is_preformatted(name) && is_block(name) && is_code_like(el, self.nodes) {
				return self.pre(el);
			}
		}
		match name {
			"br" => self.br(),
			"img" => self.image(el),
			"a" => self.link(el),
			"strong" | "b" => self.styled(el, Style::Strong),
			"em" | "i" => self.styled(el, Style::Em),
			"del" | "s" | "strike" => self.styled(el, Style::Del),
			"sub" => self.script(el, false),
			"sup" => self.script(el, true),
			"q" => self.styled(el, Style::Quote),
			"code" | "kbd" | "samp" | "tt" => self.code_span(el),
			"select" => self.select(el),
			name if is_preformatted(name) => self.pre(el),
			"hr" => {
				self.flush();
				self.gap();
				self.line(&["* * *"]);
				self.gap();
			},
			"ul" | "ol" | "menu" | "dir" => self.list(el),
			"li" => {
				self.flush();
				self.gap();
				self.item(el, Marker::Bullet, false);
			},
			"dl" => self.definitions(el),
			"dt" | "summary" => self.term(el),
			"dd" => {
				self.flush();
				self.gap();
				self.item(el, Marker::Colon, false);
			},
			"blockquote" => {
				self.flush();
				self.gap();
				self.prefix.push(Prefix::Quote);
				self.content(el);
				self.flush();
				self.prefix.pop();
				self.gap();
			},
			"table" => self.table(el),
			"emu-clause" | "emu-annex" | "emu-intro" => {
				self.clause_depth += 1;
				self.block(el);
				self.clause_depth -= 1;
			},
			"div" => match code_lang(el, false) {
				Some(lang) => {
					let outer = self.lang.replace(lang);
					self.block(el);
					self.lang = outer;
				},
				None => self.block(el),
			},
			name if is_block(name) => self.block(el),
			_ => self.content(el),
		}
	}

	/// Heading level of an element written as a heading, if any: `h1`–`h6`
	/// (an ecmarkup clause `h1` takes its clause depth), `role="heading"` with
	/// `aria-level`, `heading-hN`/`md-hN` class names, and Sphinx's
	/// `p.rubric` one level below the last heading.
	fn heading_level(&self, el: &Element) -> Option<usize> {
		let name = el.name();
		if let [b'h', digit @ b'1'..=b'6'] = name.as_bytes() {
			let level = usize::from(digit - b'0');
			return Some(if level == 1 && self.clause_depth > 0 {
				self.clause_depth.min(6)
			} else {
				level
			});
		}
		if el
			.attr("role")
			.is_some_and(|role| role.trim().eq_ignore_ascii_case("heading"))
		{
			return Some(
				el.attr("aria-level")
					.and_then(|level| level.trim().parse().ok())
					.filter(|level| (1..=6).contains(level))
					.unwrap_or(2),
			);
		}
		let class_level = el.attr("class").and_then(|class| {
			class.split_ascii_whitespace().find_map(|token| {
				let digits = token
					.strip_prefix("heading-h")
					.or_else(|| token.strip_prefix("md-h"))?;
				match digits.as_bytes() {
					[digit @ b'1'..=b'6'] => Some(usize::from(digit - b'0')),
					_ => None,
				}
			})
		});
		if class_level.is_some() {
			return class_level;
		}
		(name == "p" && has_class(el, "rubric")).then(|| (self.last_level + 1).clamp(2, 6))
	}

	fn styled(&mut self, el: &'a Element, style: Style) {
		let index = style as usize;
		// Nested emphasis of the same kind adds no markers; quotes nest.
		let emit = matches!(style, Style::Quote) || !self.active[index];
		let (open, close) = style.markers();
		let mark = emit.then(|| self.open(open));
		let outer = mem::replace(&mut self.active[index], true);
		self.inline_only += 1;
		self.content(el);
		self.inline_only -= 1;
		self.active[index] = outer;
		let Some(mark) = mark else {
			return;
		};
		let close_at = self.inline.len();
		if !self.close(mark, close) || self.plain || matches!(style, Style::Quote) {
			return;
		}
		// CommonMark flanking: an opener after a letter cannot start with
		// punctuation, and a closer after punctuation cannot touch a letter.
		// Leading whitespace moved before the opener shifts it by one byte.
		let mut open_at = mark.after - open.len();
		if !self.inline[open_at..].starts_with(open) {
			open_at += 1;
		}
		let markers = Markers {
			open:     open_at,
			open_len: open.len(),
			close:    close_at,
			end:      self.inline.len(),
		};
		let before = self.inline[..markers.open].chars().next_back();
		let first = self.inline[open_at + open.len()..].chars().next();
		let last = self.inline[..close_at].chars().next_back();
		let punctuation = |ch: Option<char>| ch.is_some_and(|ch| !ch.is_alphanumeric() && !is_ws(ch));
		if before.is_some_and(char::is_alphanumeric) && punctuation(first) {
			self.unwrap_markers(markers);
		} else if punctuation(last) {
			self.pending_close = Some(markers);
		}
	}

	/// Remove an emphasis pair, keeping its content.
	fn unwrap_markers(&mut self, markers: Markers) {
		self.inline.replace_range(markers.close..markers.end, "");
		self
			.inline
			.replace_range(markers.open..markers.open + markers.open_len, "");
	}

	/// Superscript or subscript: Unicode digits and signs when every
	/// character has one (`τ²`), an ordinal suffix as plain text (`1st`), and
	/// otherwise `^x` / `_x`, parenthesised when the content has spaces.
	fn script(&mut self, el: &'a Element, sup: bool) {
		let mark = self.open("");
		let before = self.inline[..mark.after].chars().next_back();
		self.inline_only += 1;
		self.content(el);
		self.inline_only -= 1;
		if !self.close(mark, "") {
			return;
		}
		let body = self.inline.split_off(mark.after);
		self.inline.push_str(&script_text(&body, sup, before));
	}

	/// A Tufte-style side or margin note: parenthesised in prose, written
	/// after the block when it sits in a heading or term.
	fn sidenote(&mut self, el: &'a Element) {
		if self.in_heading {
			self.notes.push(el);
			return;
		}
		self.space();
		let mark = self.open("(");
		self.inline_only += 1;
		self.content(el);
		self.inline_only -= 1;
		self.close(mark, ")");
	}

	fn write_notes(&mut self) {
		for note in mem::take(&mut self.notes) {
			self.flush();
			self.gap();
			self.sidenote(note);
			self.flush();
			self.gap();
		}
	}

	fn link(&mut self, el: &'a Element) {
		let href = el.attr("href");
		if !self.in_link && (self.in_heading || has_permalink_class(el)) && self.is_glyph_only(el) {
			// A heading permalink (`¶`, `#`, an icon, a zero-width space).
			return;
		}
		if self.in_heading
			&& (el
				.attr("aria-hidden")
				.is_some_and(|value| value.trim().eq_ignore_ascii_case("true")))
		{
			return;
		}
		if self.in_heading
			&& (has_permalink_class(el) || href.is_some_and(|href| href.trim_start().starts_with('#')))
		{
			// A heading that links to its own anchor or back to the table of
			// contents reads as plain text.
			return self.content(el);
		}
		let target = if self.in_link {
			None
		} else {
			href.and_then(|href| self.link_target(el, href))
		};
		if !self.in_link && self.inline_only == 0 && !self.plain && self.has_block(el) {
			// A card: keep its blocks, with the link on its heading or first
			// paragraph.
			self.flush();
			self.gap();
			let outer = mem::replace(&mut self.block_link, target);
			self.in_link = true;
			self.content(el);
			self.flush();
			self.in_link = false;
			self.block_link = outer;
			self.gap();
			return;
		}
		let Some(target) = target else {
			return self.content(el);
		};
		let mark = self.open("[");
		self.in_link = true;
		self.inline_only += 1;
		self.content(el);
		self.inline_only -= 1;
		self.in_link = false;
		if self.close(mark, "](") && !self.plain {
			push_destination(&mut self.inline, &target);
			self.inline.push(')');
		}
	}

	/// Resolve a link target, decoding Cloudflare's obfuscated `mailto:`.
	fn link_target(&self, el: &Element, href: &str) -> Option<String> {
		if let Some(at) = href.find("/cdn-cgi/l/email-protection") {
			let email = href[at..]
				.split_once('#')
				.and_then(|(_, hex)| cf_email(hex))
				.or_else(|| {
					self
						.descendants(el.children.clone())
						.find_map(|node| match node {
							Node::Tag(tag) => tag.attr("data-cfemail").and_then(cf_email),
							Node::Text(_) => None,
						})
				});
			return email.map(|email| format!("mailto:{email}"));
		}
		self.target(href)
	}

	/// Whether a link holds block-level elements.
	fn has_block(&self, el: &Element) -> bool {
		self
			.descendants(el.children.clone())
			.any(|node| matches!(node, Node::Tag(tag) if is_block(tag.name())))
	}

	/// Whether a link shows nothing but a permalink glyph or no text at all;
	/// an image with alt text counts as content.
	fn is_glyph_only(&self, el: &Element) -> bool {
		let mut text = String::new();
		self.collect_text(el.children.clone(), &mut text, false);
		let text = text.trim_matches(is_ws);
		if text.is_empty() {
			return !self.descendants(el.children.clone()).any(|node| {
				matches!(node, Node::Tag(img) if img.name() == "img"
					&& img.attr("alt").is_some_and(|alt| !alt.trim().is_empty()))
			});
		}
		text
			.chars()
			.all(|ch| matches!(ch, '¶' | '#' | '§' | '🔗' | '⚓' | '¤' | '†') || is_ws(ch))
	}

	fn image(&mut self, el: &'a Element) {
		if !self.images {
			return;
		}
		let Some(alt) = image_alt(self.nodes, self.dropped, self.root_end, el) else {
			// An image without alt text is kept only as running content of
			// the article (a diagram between paragraphs), never as a link,
			// heading, cell or emphasis decoration.
			if self.inline_only == 0
				&& !self.plain
				&& !self.in_link
				&& self.inline.trim_matches(is_ws).is_empty()
				&& el.attr("alt").is_none_or(|alt| alt.trim().is_empty())
				&& is_content_image(el)
				&& self.stands_alone(el)
				&& let Some(src) = self.image_src(el)
			{
				self.before_content();
				self.inline.push_str("![](");
				push_destination(&mut self.inline, &src);
				self.inline.push(')');
				self.after_image = true;
			}
			return;
		};
		if self.plain {
			self.space();
			self.text(alt);
			self.space();
			return;
		}
		let src = self.image_src(el);
		if self.after_image {
			self.space();
		}
		self.before_content();
		self.inline.push_str("![");
		self.text(alt);
		self.inline.push(']');
		if let Some(src) = src {
			self.inline.push('(');
			push_destination(&mut self.inline, &src);
			self.inline.push(')');
		}
		self.after_image = true;
	}

	/// Whether no text follows an element before the next block boundary:
	/// with nothing before it either, it is a block of its own.
	fn stands_alone(&self, el: &Element) -> bool {
		let mut index = el.children.end;
		let mut steps = 0;
		while index < self.root_end.min(self.nodes.len()) && steps < LOOKAHEAD_NODES {
			steps += 1;
			let node = &self.nodes[index];
			if self.dropped.get(index).copied().unwrap_or(false) {
				index = match node {
					Node::Text(_) => index + 1,
					Node::Tag(tag) => tag.children.end.max(index + 1),
				};
				continue;
			}
			match node {
				Node::Text(text) if text.chars().all(|ch| is_ws(ch) || is_invisible(ch)) => index += 1,
				Node::Text(_) => return false,
				Node::Tag(tag) if is_block(tag.name()) || tag.name() == "br" => return true,
				Node::Tag(tag) if is_skipped(tag) => index = tag.children.end.max(index + 1),
				Node::Tag(_) => index += 1,
			}
		}
		true
	}

	/// Resolved image source. An image URL carrying an inline payload (a
	/// badge with an embedded base64 logo) is bloat, like a `data:` image:
	/// `None`, so only the alt text is kept.
	fn image_src(&self, el: &Element) -> Option<String> {
		["src", "data-src", "data-original", "data-lazy-src"]
			.iter()
			.find_map(|key| el.attr(key).and_then(|value| self.target(value)))
			.filter(|src| src.len() <= IMAGE_URL_MAX_LEN)
	}

	/// Resolve a link or image target; `None` for targets a reader cannot use.
	fn target(&self, href: &str) -> Option<String> {
		let href = href.trim_matches(is_ws);
		if href.is_empty()
			|| href == "#"
			|| ["javascript:", "vbscript:", "data:"]
				.iter()
				.any(|scheme| has_scheme(href, scheme))
		{
			return None;
		}
		if href.starts_with('#') {
			return Some(href.to_owned());
		}
		if let Some(base) = self.base
			&& let Ok(url) = base.join(href)
		{
			return Some(url.into());
		}
		Some(href.replace(['\t', '\n', '\r'], ""))
	}

	fn code_span(&mut self, el: &'a Element) {
		let mut raw = String::new();
		self.collect_text(el.children.clone(), &mut raw, false);
		let mut code = String::with_capacity(raw.len());
		let mut space = false;
		for ch in raw.chars() {
			if is_ws(ch) {
				space = true;
			} else {
				if space && !code.is_empty() {
					code.push(' ');
				}
				space = false;
				code.push(ch);
			}
		}
		if raw.starts_with(is_ws) {
			self.space();
		}
		if !code.is_empty() {
			self.before_content();
			if self.plain {
				self.inline.push_str(&code);
			} else {
				let ticks = longest_run(&code, '`') + 1;
				let pad = code.starts_with('`') || code.ends_with('`');
				push_repeated(&mut self.inline, '`', ticks);
				if pad {
					self.inline.push(' ');
				}
				self.inline.push_str(&code);
				if pad {
					self.inline.push(' ');
				}
				push_repeated(&mut self.inline, '`', ticks);
			}
			self.last_char = code.chars().next_back();
		}
		if raw.ends_with(is_ws) {
			self.space();
		}
	}

	/// Concatenate descendant text; line breaks and block boundaries become
	/// newlines (`pre`) or spaces.
	fn collect_text(&self, range: Range<usize>, out: &mut String, pre: bool) {
		let separator = if pre { '\n' } else { ' ' };
		for node in self.siblings(range) {
			match node {
				Node::Text(text) => push_visible(out, text),
				Node::Tag(el) if is_skipped(el) => {},
				Node::Tag(el) if el.name() == "br" => out.push(separator),
				Node::Tag(el) if is_block(el.name()) => {
					if !out.is_empty() && !out.ends_with(separator) {
						out.push(separator);
					}
					self.collect_text(el.children.clone(), out, pre);
					if !out.is_empty() && !out.ends_with(separator) {
						out.push(separator);
					}
				},
				Node::Tag(el) => self.collect_text(el.children.clone(), out, pre),
			}
		}
	}

	/// Text of a code block: toolbars, copy buttons, hidden decorations and
	/// line-number gutters are left out, and once the block holds a `code`
	/// element, only content leading to code counts.
	fn code_text(&self, range: Range<usize>, out: &mut String, code_only: bool) {
		for node in self.siblings(range) {
			match node {
				Node::Text(text) => push_visible(out, text),
				Node::Tag(el) if is_skipped(el) || is_code_decoration(el) => {},
				Node::Tag(el) if el.name() == "br" => out.push('\n'),
				Node::Tag(el) if el.name() == "code" => self.code_text(el.children.clone(), out, false),
				Node::Tag(el) if code_only && !contains_code(self.nodes, self.dropped, el) => {},
				Node::Tag(el) if is_block(el.name()) => {
					if !out.is_empty() && !out.ends_with('\n') {
						out.push('\n');
					}
					self.code_text(el.children.clone(), out, code_only);
					if !out.is_empty() && !out.ends_with('\n') {
						out.push('\n');
					}
				},
				Node::Tag(el) => self.code_text(el.children.clone(), out, code_only),
			}
		}
	}

	fn pre(&mut self, el: &'a Element) {
		let chrome = self.chrome_lang.take();
		let lang = code_lang(el, true)
			.or_else(|| {
				self
					.descendants(el.children.clone())
					.find_map(|node| match node {
						Node::Tag(code) if code.name() == "code" => Some(code_lang(code, true)),
						_ => None,
					})?
			})
			.or_else(|| self.lang.clone())
			.or(chrome);
		let mut code = String::new();
		self.code_text(el.children.clone(), &mut code, contains_code(self.nodes, self.dropped, el));
		if code.contains('\r') {
			code = code.replace("\r\n", "\n").replace('\r', "\n");
		}
		if lang.is_none() && !looks_like_code(&code) && self.is_linked_document(el) {
			return self.preformatted_document(el);
		}
		self.flush();
		self.gap();
		let first = code.find(|ch: char| !is_ws(ch));
		if let Some(first) = first {
			let start = code[..first].rfind('\n').map_or(0, |newline| newline + 1);
			let body = code[start..].trim_end();
			let fence = "`".repeat(longest_run(body, '`').max(2) + 1);
			self.line(&[fence.as_str(), lang.as_deref().unwrap_or_default()]);
			for line in body.split('\n') {
				self.line(&[line]);
			}
			self.line(&[fence.as_str()]);
			self.gap();
		}
	}

	/// Whether a `pre` links somewhere and holds no code markup.
	fn is_linked_document(&self, el: &'a Element) -> bool {
		let mut linked = false;
		for node in self.descendants(el.children.clone()) {
			if let Node::Tag(tag) = node {
				match tag.name() {
					"code" | "kbd" | "samp" | "var" => return false,
					"a" if tag
						.attr("href")
						.and_then(|href| self.target(href))
						.is_some() =>
					{
						linked = true;
					},
					_ => {},
				}
			}
		}
		linked
	}

	/// Write a preformatted document line by line: each line ends in a hard
	/// break, leading spaces become no-break spaces (indentation that
	/// CommonMark would otherwise strip or read as code), links stay links and
	/// blank lines separate paragraphs.
	fn preformatted_document(&mut self, el: &'a Element) {
		let mut text = String::new();
		let mut column = 0;
		self.document_text(el.children.clone(), &mut text, &mut column);
		self.flush();
		self.gap();
		let mut paragraph = Vec::new();
		for line in text.split('\n') {
			let line = line.trim_end_matches(is_ws);
			if line.is_empty() {
				self.document_paragraph(&mut paragraph);
				continue;
			}
			let body = line.trim_start_matches(' ');
			let mut out = String::with_capacity(line.len() * 2);
			for _ in body.len()..line.len() {
				out.push('\u{a0}');
			}
			out.push_str(body);
			paragraph.push(out);
		}
		self.document_paragraph(&mut paragraph);
	}

	fn document_paragraph(&mut self, lines: &mut Vec<String>) {
		if lines.is_empty() {
			return;
		}
		let last = lines.len() - 1;
		for (index, mut line) in lines.drain(..).enumerate() {
			if index < last {
				line.push('\\');
			}
			self.paragraph_line(&line);
		}
		self.gap();
	}

	/// Inline Markdown of preformatted content with its line breaks: text is
	/// escaped, tabs expand to 8-column stops and links keep their targets.
	fn document_text(&self, range: Range<usize>, out: &mut String, column: &mut usize) {
		for node in self.siblings(range) {
			match node {
				Node::Text(text) => push_document_text(out, text, column),
				Node::Tag(el) if is_skipped(el) => {},
				Node::Tag(el) if el.name() == "br" => {
					out.push('\n');
					*column = 0;
				},
				Node::Tag(el) if el.name() == "a" => {
					let Some(target) = el.attr("href").and_then(|href| self.target(href)) else {
						self.document_text(el.children.clone(), out, column);
						continue;
					};
					let mut label = String::new();
					self.document_text(el.children.clone(), &mut label, column);
					if label.trim_matches(is_ws).is_empty() {
						out.push_str(&label);
					} else {
						out.push('[');
						out.push_str(&label);
						out.push_str("](");
						push_destination(out, &target);
						out.push(')');
					}
				},
				Node::Tag(el) if el.name() == "img" => {
					let alt = el.attr("alt").unwrap_or_default().trim_matches(is_ws);
					push_document_text(out, alt, column);
				},
				Node::Tag(el) if is_block(el.name()) => {
					if !out.is_empty() && !out.ends_with('\n') {
						out.push('\n');
						*column = 0;
					}
					self.document_text(el.children.clone(), out, column);
					if !out.is_empty() && !out.ends_with('\n') {
						out.push('\n');
						*column = 0;
					}
				},
				Node::Tag(el) => self.document_text(el.children.clone(), out, column),
			}
		}
	}

	fn heading(&mut self, el: &'a Element, level: usize) {
		self.flush();
		self.gap();
		let target = self.block_link.take();
		let outer = mem::replace(&mut self.in_heading, true);
		// A heading is already strong: bold inside it adds only markers.
		let strong = mem::replace(&mut self.active[Style::Strong as usize], true);
		self.inline_only += 1;
		self.content(el);
		self.inline_only -= 1;
		self.active[Style::Strong as usize] = strong;
		self.in_heading = outer;
		self.reset_inline();
		let mut buffer = mem::take(&mut self.inline);
		let text = buffer.trim_matches(is_ws);
		if text.is_empty() {
			self.block_link = target;
		} else {
			let hashes = &"######"[..level];
			// A card's link goes on its heading, unless it only points at the
			// heading's own anchor.
			if let Some(target) = target.filter(|target| !target.starts_with('#')) {
				let mut destination = String::new();
				push_destination(&mut destination, &target);
				self.line(&[hashes, " [", text, "](", &destination, ")"]);
			} else {
				// A trailing `#` run would read as a closing sequence.
				let body = text.trim_end_matches('#');
				if body.len() < text.len() {
					self.line(&[hashes, " ", body, "\\", &text[body.len()..]]);
				} else {
					self.line(&[hashes, " ", text]);
				}
			}
			self.last_level = level;
			self.gap();
		}
		buffer.clear();
		self.inline = buffer;
		self.write_notes();
	}

	fn select(&mut self, el: &'a Element) {
		let mut first = None;
		let mut chosen = None;
		for node in self.descendants(el.children.clone()) {
			if let Node::Tag(option) = node
				&& option.name() == "option"
			{
				first.get_or_insert(option);
				if option.has_attr("selected") {
					chosen = Some(option);
					break;
				}
			}
		}
		if let Some(option) = chosen.or(first) {
			self.space();
			self.content(option);
			self.space();
		}
	}

	// ── Admonitions ───────────────────────────────────────────────────────

	/// Write an admonition as a blockquote opened by its bold label: the
	/// title child when it has one, otherwise the admonition kind.
	fn admonition(&mut self, el: &'a Element) {
		self.flush();
		self.gap();
		self.prefix.push(Prefix::Quote);
		let title = admonition_title(self.nodes, self.dropped, el);
		if let Some(title) = title {
			self.styled(title, Style::Strong);
			let initial = self
				.inline
				.strip_prefix("**")
				.and_then(|rest| rest.chars().next());
			if let Some(ch) = initial.filter(|ch| ch.is_lowercase()) {
				let upper: String = ch.to_uppercase().collect();
				self.inline.replace_range(2..2 + ch.len_utf8(), &upper);
			}
			self.flush();
			self.gap();
		} else if let Some(kind) = admonition_kind(el) {
			self.inline.push_str("**");
			self.inline.push_str(kind);
			self.inline.push_str("**");
			self.flush();
			self.gap();
		}
		for node in self.siblings(el.children.clone()) {
			match node {
				Node::Tag(tag) if title.is_some_and(|title| std::ptr::eq(title, tag)) => {},
				Node::Tag(tag) if class_contains(tag, &["close"]) => {},
				_ => self.node(node),
			}
		}
		self.flush();
		self.prefix.pop();
		self.gap();
	}

	// ── Lists ─────────────────────────────────────────────────────────────

	fn list(&mut self, el: &'a Element) {
		let ordered = el.name() == "ol";
		let reversed = ordered && el.has_attr("reversed");
		let mut next: i64 = el
			.attr("start")
			.and_then(|start| start.trim().parse().ok())
			.unwrap_or_else(|| {
				if reversed {
					self
						.siblings(el.children.clone())
						.filter(|node| matches!(node, Node::Tag(li) if li.name() == "li"))
						.count() as i64
				} else {
					1
				}
			});
		self.flush();
		let in_item = matches!(self.prefix.last(), Some(Prefix::Item { .. }));
		if in_item && (!ordered || next == 1) {
			// A sublist directly under its item's text stays tight.
			if !self.fresh {
				self.blank = None;
			}
		} else {
			self.gap();
		}
		let begin = self.out.len();
		let mut width = 0;
		for node in self.siblings(el.children.clone()) {
			match node {
				Node::Tag(li) if li.name() == "li" => {
					if ordered
						&& let Some(value) = li.attr("value").and_then(|value| value.trim().parse().ok())
					{
						next = value;
					}
					let marker = if ordered {
						Marker::Number(next.clamp(0, 999_999_999) as u64)
					} else {
						Marker::Bullet
					};
					width = marker.width();
					let outer = self.skip;
					if ordered {
						self.skip = own_number(self.nodes, self.dropped, li, next).or(outer);
					}
					self.item(li, marker, self.out.len() > begin);
					self.skip = outer;
					next += if reversed { -1 } else { 1 };
				},
				// Stray content after an item continues that item.
				_ if self.out.len() > begin => {
					self
						.prefix
						.push(Prefix::Item { width, marker: None, definition: false });
					self.node(node);
					self.flush();
					self.prefix.pop();
				},
				_ => self.node(node),
			}
		}
		self.flush();
		self.gap();
	}

	/// Write a list item or definition; `tight` drops the blank line before it.
	fn item(&mut self, el: &'a Element, marker: Marker, tight: bool) {
		self.flush();
		let saved = (self.fresh, self.blank);
		let written = self.out.len();
		if tight {
			self.blank = None;
		}
		self.fresh = true;
		let definition = matches!(marker, Marker::Colon);
		let nested = definition
			&& self
				.prefix
				.iter()
				.any(|entry| matches!(entry, Prefix::Item { definition: true, .. }));
		let width = if nested { 0 } else { marker.width() };
		self
			.prefix
			.push(Prefix::Item { width, marker: Some(marker), definition });
		self.content(el);
		self.flush();
		self.prefix.pop();
		if self.out.len() == written {
			(self.fresh, self.blank) = saved;
		} else {
			self.gap();
		}
	}

	fn definitions(&mut self, el: &'a Element) {
		self.flush();
		self.gap();
		let begin = self.out.len();
		self.entries(el.children.clone(), begin);
		self.flush();
		self.gap();
	}

	fn entries(&mut self, range: Range<usize>, begin: usize) {
		for node in self.siblings(range) {
			match node {
				Node::Tag(dd) if dd.name() == "dd" => {
					self.item(dd, Marker::Colon, self.out.len() > begin);
				},
				// HTML allows `div` wrappers around groups of terms and details.
				Node::Tag(div) if div.name() == "div" => self.entries(div.children.clone(), begin),
				_ => self.node(node),
			}
		}
	}

	fn term(&mut self, el: &'a Element) {
		self.flush();
		self.gap();
		let outer = mem::replace(&mut self.in_heading, true);
		self.styled(el, Style::Strong);
		self.in_heading = outer;
		self.flush();
		self.gap();
		self.write_notes();
	}

	// ── Tables ────────────────────────────────────────────────────────────

	/// Write a table: as a GFM pipe table when its cells are inline and it is
	/// rectangular once header column spans are expanded, as a text grid in a
	/// fence when body cells span rows or columns, and flattened to blocks
	/// when it lays out the page. Full-width rows before or after the grid
	/// (notes, "see also") become paragraphs; rows with no text are dropped.
	fn table(&mut self, el: &'a Element) {
		let mut shape = Shape::default();
		self.scan_table(el.children.clone(), &mut shape);
		shape.rows.retain(|row| !row.is_empty());
		self.flush();
		self.gap();
		let rows = &shape.rows;
		let width = |row: &[&Element]| row.iter().map(|cell| span(cell, "colspan")).sum::<usize>();
		let columns = rows.iter().map(|row| width(row)).max().unwrap_or(0);
		let full = |row: &[&Element]| {
			columns >= 2
				&& row.len() == 1
				&& (span(row[0], "colspan") >= columns
					|| row[0]
						.attr("colspan")
						.is_some_and(|value| value.trim().ends_with('%')))
		};
		let header_row = |row: &[&Element]| row.iter().all(|cell| cell.name() == "th");
		let start = rows.iter().position(|row| !full(row) || header_row(row));
		if shape.layout
			&& let Some(first) = rows.iter().position(|row| !full(row))
			&& self.is_property_table(&rows[first..])
		{
			for row in &rows[..first] {
				self.row_blocks(row);
			}
			for row in &rows[first..] {
				self.term(row[0]);
				self.item(row[1], Marker::Colon, true);
			}
			self.flush();
			self.gap();
			return;
		}
		let (Some(start), false) = (start, shape.layout) else {
			self.content(el);
			self.flush();
			self.gap();
			return;
		};
		let end = rows
			.iter()
			.rposition(|row| !full(row))
			.map_or(start, |last| last.max(start))
			+ 1;
		let body = &rows[start..end];
		// Column spans become empty cells; only row spans need a grid.
		let spans = body.iter().flatten().any(|cell| span(cell, "rowspan") > 1);
		let ragged = body.iter().any(|row| !full(row) && width(row) != columns);
		if !(shape.header || (body.len() >= 2 && columns >= 2 && !spans && !ragged)) {
			self.content(el);
			self.flush();
			self.gap();
			return;
		}
		for row in &rows[..start] {
			self.row_blocks(row);
		}
		if let Some(caption) = shape.caption {
			self.block(caption);
		}
		if spans || ragged {
			self.grid(body);
		} else {
			self.pipe_table(body, columns);
		}
		self.flush();
		self.gap();
		for row in &rows[end..] {
			self.row_blocks(row);
		}
	}

	/// Whether rows form a property table: at least two rows of exactly two
	/// cells, a short inline name and a description that may hold blocks
	/// (but no nested table). Such a table is written as definitions.
	fn is_property_table(&self, rows: &[Vec<&'a Element>]) -> bool {
		rows.len() >= 2
			&& rows.iter().all(|row| {
				let [name, description] = row.as_slice() else {
					return false;
				};
				let mut text = String::new();
				self.collect_text(name.children.clone(), &mut text, false);
				let text = text.trim_matches(is_ws);
				span(name, "colspan") == 1
					&& span(description, "colspan") == 1
					&& span(name, "rowspan") == 1
					&& span(description, "rowspan") == 1
					&& !text.is_empty()
					&& text.chars().count() <= PROPERTY_NAME_MAX_CHARS
					&& !self.block_content(name)
					&& !self
						.descendants(description.children.clone())
						.any(|node| matches!(node, Node::Tag(tag) if tag.name() == "table"))
			})
	}

	fn row_blocks(&mut self, row: &[&'a Element]) {
		for &cell in row {
			self.block(cell);
		}
	}

	fn scan_table(&self, range: Range<usize>, shape: &mut Shape<'a>) {
		for node in self.siblings(range) {
			match node {
				Node::Text(text) => shape.layout |= !text.chars().all(is_ws),
				Node::Tag(el) if is_skipped(el) => {},
				Node::Tag(el) => match el.name() {
					"tr" => {
						let mut row = Vec::new();
						self.scan_row(el.children.clone(), &mut row, shape);
						shape.rows.push(row);
					},
					"caption" if shape.caption.is_none() => shape.caption = Some(el),
					"colgroup" | "col" => {},
					"td" | "th" | "table" | "caption" => shape.layout = true,
					_ => self.scan_table(el.children.clone(), shape),
				},
			}
		}
	}

	fn scan_row(&self, range: Range<usize>, row: &mut Vec<&'a Element>, shape: &mut Shape<'a>) {
		for node in self.siblings(range) {
			match node {
				Node::Text(text) => shape.layout |= !text.chars().all(is_ws),
				Node::Tag(el) if is_skipped(el) => {},
				Node::Tag(el) => match el.name() {
					"td" | "th" => {
						shape.header |= el.name() == "th";
						shape.layout |= self.block_content(el);
						row.push(el);
					},
					"tr" | "table" | "caption" => shape.layout = true,
					_ => self.scan_row(el.children.clone(), row, shape),
				},
			}
		}
	}

	/// Whether a cell holds more than one paragraph of inline content.
	fn block_content(&self, cell: &Element) -> bool {
		let mut paragraphs = 0;
		for node in self.descendants(cell.children.clone()) {
			if let Node::Tag(el) = node {
				match el.name() {
					"p" => {
						paragraphs += 1;
						if paragraphs > 1 {
							return true;
						}
					},
					"table" | "ul" | "ol" | "dl" | "menu" | "dir" | "li" | "dt" | "dd" | "pre"
					| "xmp" | "listing" | "plaintext" | "blockquote" | "h1" | "h2" | "h3" | "h4"
					| "h5" | "h6" | "hr" | "details" | "figure" => return true,
					_ => {},
				}
			}
		}
		false
	}

	/// Render a cell's content on one line: Markdown for a pipe table, plain
	/// text for a grid.
	fn cell(&mut self, cell: &'a Element, plain: bool) -> String {
		let outer_plain = mem::replace(&mut self.plain, plain);
		let outer_cell = mem::replace(&mut self.in_cell, !plain);
		self.inline_only += 1;
		self.content(cell);
		self.inline_only -= 1;
		self.plain = outer_plain;
		self.in_cell = outer_cell;
		self.reset_inline();
		let text = mem::take(&mut self.inline);
		let trimmed = text.trim_matches(is_ws);
		if trimmed.len() == text.len() {
			text
		} else {
			trimmed.to_owned()
		}
	}

	/// Write rows as a pipe table `columns` wide: a spanning cell is followed
	/// by empty cells, and short rows are padded.
	fn pipe_table(&mut self, rows: &[Vec<&'a Element>], columns: usize) {
		let mut cells: Vec<Vec<String>> = Vec::with_capacity(rows.len());
		for (index, row) in rows.iter().enumerate() {
			let mut texts = Vec::with_capacity(columns);
			for &cell in row {
				texts.push(self.cell(cell, false));
				texts.extend((1..span(cell, "colspan")).map(|_| String::new()));
			}
			texts.resize(columns.max(texts.len()), String::new());
			if index == 0 || texts.iter().any(|text| !text.is_empty()) {
				cells.push(texts);
			}
		}
		if cells.iter().flatten().all(String::is_empty) {
			return;
		}
		// A column empty in every row (icons, row controls) is dropped.
		let width = cells.iter().map(Vec::len).max().unwrap_or(0);
		let empty: Vec<bool> = (0..width)
			.map(|column| {
				cells
					.iter()
					.all(|row| row.get(column).is_none_or(String::is_empty))
			})
			.collect();
		if empty.contains(&true) {
			for row in &mut cells {
				let mut column = 0;
				row.retain(|_| {
					column += 1;
					!empty[column - 1]
				});
			}
		}
		let mut line = String::new();
		for (index, row) in cells.iter().enumerate() {
			line.clear();
			for cell in row {
				line.push_str("| ");
				for ch in cell.chars() {
					if ch == '|' {
						line.push('\\');
					}
					line.push(ch);
				}
				line.push(' ');
			}
			line.push('|');
			self.line(&[line.as_str()]);
			if index == 0 {
				line.clear();
				for _ in row {
					line.push_str("| --- ");
				}
				line.push('|');
				self.line(&[line.as_str()]);
			}
		}
	}

	/// Lay out a table with spanning cells as aligned plain text in a fence.
	fn grid(&mut self, rows: &[Vec<&'a Element>]) {
		// Each slot holds its text and how many columns it spans; 0 marks a
		// slot covered by a column span to its left.
		let mut grid: Vec<Vec<(String, usize)>> = Vec::with_capacity(rows.len());
		let mut pending: Vec<usize> = Vec::new();
		for row in rows {
			let mut slots = Vec::new();
			let mut column = 0;
			for &cell in row {
				while pending.get(column).is_some_and(|&left| left > 0) {
					pending[column] -= 1;
					slots.push((String::new(), 1));
					column += 1;
				}
				let colspan = span(cell, "colspan").min(1000);
				let rowspan = span(cell, "rowspan").min(65534);
				slots.push((self.cell(cell, true), colspan));
				slots.extend((1..colspan).map(|_| (String::new(), 0)));
				if pending.len() < column + colspan {
					pending.resize(column + colspan, 0);
				}
				pending[column..column + colspan].fill(rowspan - 1);
				column += colspan;
			}
			while column < pending.len() {
				pending[column] = pending[column].saturating_sub(1);
				slots.push((String::new(), 1));
				column += 1;
			}
			grid.push(slots);
		}
		if grid.iter().flatten().all(|(text, _)| text.is_empty()) {
			return;
		}
		let columns = grid.iter().map(Vec::len).max().unwrap_or(0);
		let mut widths = vec![0; columns];
		for slots in &grid {
			for (column, (text, span)) in slots.iter().enumerate() {
				if *span == 1 {
					widths[column] = widths[column].max(text.width());
				}
			}
		}
		let header = rows[0].iter().all(|cell| cell.name() == "th");
		let fence = "`".repeat(
			grid
				.iter()
				.flatten()
				.map(|(text, _)| longest_run(text, '`'))
				.max()
				.unwrap_or(0)
				.max(2)
				+ 1,
		);
		self.line(&[fence.as_str()]);
		let mut line = String::new();
		for (index, slots) in grid.iter().enumerate() {
			line.clear();
			let mut column = 0;
			while column < slots.len() {
				let (text, span) = &slots[column];
				let span = (*span).max(1);
				let end = (column + span).min(columns);
				let width = widths[column..end].iter().sum::<usize>() + 2 * (end - column - 1);
				line.push_str(text);
				push_repeated(&mut line, ' ', width.saturating_sub(text.width()) + 2);
				column += span;
			}
			self.line(&[line.trim_end_matches(' ')]);
			if index == 0 && header {
				line.clear();
				for &width in &widths {
					push_repeated(&mut line, '-', width);
					line.push_str("  ");
				}
				self.line(&[line.trim_end_matches(' ')]);
			}
		}
		self.line(&[fence.as_str()]);
	}
}

// ── Rules shared with the text writer ─────────────────────────────────────
//
// Both writers render the same words: an image, a toolbar label or a word
// boundary is decided once, here.

const fn siblings<'a>(nodes: &'a [Node], dropped: &'a [bool], range: Range<usize>) -> Siblings<'a> {
	Siblings { nodes, dropped, next: range.start, end: range.end }
}

const fn descendants<'a>(
	nodes: &'a [Node],
	dropped: &'a [bool],
	range: Range<usize>,
) -> Descendants<'a> {
	Descendants { nodes, dropped, next: range.start, end: range.end }
}

/// Alt text an image is written with, or `None` when it describes nothing:
/// missing, decorative (see `is_decorative_alt`), or repeated by the text
/// right after the image (an icon beside its own label or heading).
pub(super) fn image_alt<'e>(
	nodes: &[Node],
	dropped: &[bool],
	root_end: usize,
	el: &'e Element,
) -> Option<&'e str> {
	let alt = el.attr("alt")?.trim_matches(is_ws);
	(!alt.is_empty()
		&& !is_decorative_alt(alt)
		&& !repeats_next_text(nodes, dropped, root_end, el, alt))
	.then_some(alt)
}

fn repeats_next_text(
	nodes: &[Node],
	dropped: &[bool],
	root_end: usize,
	el: &Element,
	alt: &str,
) -> bool {
	let want = collapse_lower(alt);
	let mut seen = String::new();
	let mut index = el.children.end;
	let mut steps = 0;
	while index < root_end.min(nodes.len()) && seen.len() <= want.len() && steps < LOOKAHEAD_NODES {
		steps += 1;
		let node = &nodes[index];
		let skip = dropped.get(index).copied().unwrap_or(false)
			|| matches!(node, Node::Tag(tag) if is_skipped(tag));
		index = match node {
			Node::Text(text) => {
				if !skip {
					if text.starts_with(is_ws) && !seen.is_empty() && !seen.ends_with(' ') {
						seen.push(' ');
					}
					seen.push_str(&collapse_lower(text));
				}
				index + 1
			},
			Node::Tag(tag) if skip => tag.children.end.max(index + 1),
			Node::Tag(tag) if tag.name() == "img" => break,
			Node::Tag(_) => {
				if !seen.ends_with(' ') && !seen.is_empty() {
					seen.push(' ');
				}
				index + 1
			},
		};
	}
	let seen = seen.trim_start();
	!want.is_empty()
		&& seen.starts_with(want.as_str())
		&& seen[want.len()..]
			.chars()
			.next()
			.is_none_or(|ch| !ch.is_alphanumeric())
}

/// Whether an element holds a `code` element.
pub(super) fn contains_code(nodes: &[Node], dropped: &[bool], el: &Element) -> bool {
	descendants(nodes, dropped, el.children.clone())
		.any(|node| matches!(node, Node::Tag(tag) if tag.name() == "code"))
}

/// Label of a code-block toolbar placed right before a `pre`: an element
/// holding a button (copy) and at most a few words of text (the language or
/// file name). Buttons, screen-reader text and hidden decorations do not count
/// as label.
pub(super) fn chrome_label(nodes: &[Node], dropped: &[bool], el: &Element) -> Option<String> {
	if !matches!(el.name(), "div" | "span" | "header") {
		return None;
	}
	let mut label = String::new();
	let mut button = false;
	chrome_text(nodes, dropped, el.children.clone(), &mut label, &mut button);
	// Selection drops controls; a dropped copy button still marks a toolbar.
	button = button
		|| nodes[el.children.clone()]
			.iter()
			.any(|node| matches!(node, Node::Tag(tag) if tag.name() == "button"));
	let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
	(button && label.len() <= 40 && label.split(' ').count() <= 3).then_some(label)
}

fn chrome_text(
	nodes: &[Node],
	dropped: &[bool],
	range: Range<usize>,
	out: &mut String,
	button: &mut bool,
) {
	for node in siblings(nodes, dropped, range) {
		match node {
			Node::Text(text) => push_visible(out, text),
			Node::Tag(tag) if tag.name() == "button" => *button = true,
			Node::Tag(tag)
				if is_skipped(tag) || has_class(tag, "sr-only") || is_code_decoration(tag) => {},
			Node::Tag(tag) => {
				out.push(' ');
				chrome_text(nodes, dropped, tag.children.clone(), out, button);
				out.push(' ');
			},
		}
	}
}

/// Whether the first element after `range.start` among the siblings up to
/// `range.end` (past whitespace) is a `pre`.
pub(super) fn pre_follows(nodes: &[Node], dropped: &[bool], range: Range<usize>) -> bool {
	next_is_pre(siblings(nodes, dropped, range))
}

/// Whether a word boundary that CSS draws falls between adjacent siblings
/// `previous` and `next`, written with no whitespace between them. `last` is
/// the character written before `next`; `layout` marks a flex or grid
/// container, where every child, a bare text run included, is its own item.
///
/// Between elements, a boundary falls in a flex or grid container, at a
/// `time`, between differently named or classed elements (a badge after a
/// label, a classifier after a name), at a lowercase-or-digit to uppercase
/// step (`v10.6.0` + `N-API`), and after an empty classed element (a
/// separator CSS draws, `<span class="sep"></span>`). Same-kind runs
/// (`<span>Hel</span><span>lo</span>`), sub/superscripts, code paths
/// (`gemm.` + `mm_fp4`, `f` + `(`), punctuation boundaries and CJK text never
/// get a space.
pub(super) fn word_boundary(
	nodes: &[Node],
	dropped: &[bool],
	previous: &Node,
	next: &Node,
	layout: bool,
	last: Option<char>,
) -> bool {
	match (previous, next) {
		(Node::Tag(a), Node::Tag(b)) => {
			if !is_inline_item(a) || !is_inline_item(b) {
				return false;
			}
			let first = first_char(nodes, dropped, b);
			boundary_chars(last, first)
				&& (layout
					|| a.name() == "time"
					|| b.name() == "time"
					|| a.name() != b.name()
					|| a.attr("class") != b.attr("class")
					|| (last.is_some_and(|ch| ch.is_lowercase() || ch.is_ascii_digit())
						&& first.is_some_and(char::is_uppercase))
					|| is_css_separator(nodes, dropped, a))
		},
		(Node::Text(_), Node::Tag(b)) => {
			layout && is_inline_item(b) && boundary_chars(last, first_char(nodes, dropped, b))
		},
		(Node::Tag(a), Node::Text(text)) => {
			boundary_chars(last, text.chars().find(|&ch| !is_invisible(ch)))
				&& is_inline_item(a)
				&& (layout || is_css_separator(nodes, dropped, a))
		},
		(Node::Text(_), Node::Text(_)) => false,
	}
}

/// Elements that sit inside a line: block boundaries already separate words
/// (and table cells keep their own layout in the text writer), breaks are
/// breaks, and scripts attach to their base (`x²`).
fn is_inline_item(el: &Element) -> bool {
	!is_block(el.name()) && !is_skipped(el) && !matches!(el.name(), "br" | "wbr" | "sub" | "sup")
}

/// Whether the characters on both sides of a boundary are word characters
/// that a missing space would glue: letters, digits, closing punctuation and
/// dashes before it; letters, digits, currency, `#`, `@`, `~` and dashes after
/// it; never CJK, which is written without spaces.
fn boundary_chars(last: Option<char>, first: Option<char>) -> bool {
	let (Some(last), Some(first)) = (last, first) else {
		return false;
	};
	if [last, first].into_iter().any(is_cjk) {
		return false;
	}
	(last.is_alphanumeric() || ")]}%!?,;\"'”’—–".contains(last))
		&& (first.is_alphanumeric() || "$€£¥#@~≈±—–".contains(first))
}

/// An empty element with a class: a separator or icon that CSS draws.
fn is_css_separator(nodes: &[Node], dropped: &[bool], el: &Element) -> bool {
	el.has_attr("class")
		&& !matches!(el.name(), "img" | "input" | "br" | "wbr" | "hr")
		&& first_char(nodes, dropped, el).is_none()
		&& !descendants(nodes, dropped, el.children.clone())
			.any(|node| matches!(node, Node::Tag(tag) if tag.name() == "img"))
}

/// Arena index of an ordered item's leading element whose text is the item's
/// own number (`<li><span>3</span>…` in a list numbered by CSS), which the
/// list marker already shows.
pub(super) fn own_number(
	nodes: &[Node],
	dropped: &[bool],
	li: &Element,
	number: i64,
) -> Option<usize> {
	let first = siblings(nodes, dropped, li.children.clone()).find(|node| match node {
		Node::Text(text) => !text.chars().all(|ch| is_ws(ch) || is_invisible(ch)),
		Node::Tag(tag) => !is_skipped(tag),
	})?;
	let Node::Tag(tag) = first else {
		return None;
	};
	if is_block(tag.name()) {
		return None;
	}
	let mut text = String::new();
	for node in descendants(nodes, dropped, tag.children.clone()) {
		if let Node::Text(part) = node {
			push_visible(&mut text, part);
		}
	}
	let text = text.trim_matches(is_ws);
	let digits = text.strip_suffix(['.', ')']).unwrap_or(text);
	(!digits.is_empty() && digits.parse::<i64>().ok() == Some(number)).then(|| tag.index())
}

/// First visible character inside an element, within the lookahead bound.
fn first_char(nodes: &[Node], dropped: &[bool], el: &Element) -> Option<char> {
	descendants(nodes, dropped, el.children.clone())
		.take(LOOKAHEAD_NODES)
		.find_map(|node| match node {
			Node::Text(text) => text.chars().find(|&ch| !is_ws(ch) && !is_invisible(ch)),
			Node::Tag(_) => None,
		})
}

/// Title child of an admonition: its first element when its class names a
/// title or heading, or when it is an inline label of at most three words
/// that opens the admonition (GitHub's `<span><svg/>Tip</span>`).
pub(super) fn admonition_title<'n>(
	nodes: &'n [Node],
	dropped: &'n [bool],
	el: &Element,
) -> Option<&'n Element> {
	let first = siblings(nodes, dropped, el.children.clone()).find(|node| match node {
		Node::Text(text) => !text.chars().all(is_ws),
		Node::Tag(tag) => !is_skipped(tag),
	});
	let title = siblings(nodes, dropped, el.children.clone()).find_map(|node| match node {
		Node::Tag(tag) if !is_skipped(tag) => Some(tag),
		_ => None,
	})?;
	if class_contains(title, &["title", "heading"]) {
		return Some(title);
	}
	let opens = matches!(first, Some(Node::Tag(tag)) if std::ptr::eq(tag, title));
	let mut text = String::new();
	for node in descendants(nodes, dropped, title.children.clone()) {
		if let Node::Text(part) = node {
			push_visible(&mut text, part);
		}
	}
	let words = text.split_whitespace().count();
	(opens && matches!(title.name(), "span" | "strong" | "b") && (1..=3).contains(&words))
		.then_some(title)
}

/// Whether an image without alt text is content (a diagram, a photo):
/// not hidden from assistive technology, not named or classed as an icon,
/// logo, avatar, emoji, sprite, badge, spacer or rule, and not sized as an
/// icon or a rule (`width`/`height` attributes or inline style under 48px).
fn is_content_image(el: &Element) -> bool {
	const DECORATIVE: [&str; 12] = [
		"icon",
		"icons",
		"logo",
		"avatar",
		"emoji",
		"sprite",
		"badge",
		"spacer",
		"pixel",
		"separator",
		"divider",
		"favicon",
	];
	let decorative_word = |value: &str| {
		value
			.split(|ch: char| !ch.is_ascii_alphanumeric())
			.any(|word| {
				DECORATIVE
					.iter()
					.any(|token| word.eq_ignore_ascii_case(token))
			})
	};
	let small = |value: &str| {
		let digits = value.trim().trim_end_matches("px");
		digits.parse::<f32>().is_ok_and(|px| px < ICON_MAX_PX)
	};
	!el.attr("aria-hidden")
		.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
		&& !el
			.attr("role")
			.is_some_and(|role| matches!(role.trim(), "presentation" | "none"))
		&& !el.attr("class").is_some_and(decorative_word)
		&& !el.attr("src").is_some_and(decorative_word)
		&& !["width", "height"].iter().any(|key| {
			el.attr(key).is_some_and(small) || style_value(el, key).is_some_and(|v| small(&v))
		})
}

/// Superscript or subscript text: Unicode digits and signs when every
/// character has one (`τ²`), an ordinal suffix after a digit as plain text
/// (`1st`), and otherwise `^x` / `_x`, parenthesised when the content has
/// spaces. `before` is the character written before it.
pub(super) fn script_text(body: &str, sup: bool, before: Option<char>) -> String {
	if let Some(mapped) = body
		.chars()
		.map(|ch| script_char(ch, sup))
		.collect::<Option<String>>()
	{
		return mapped;
	}
	if sup
		&& before.is_some_and(|ch| ch.is_ascii_digit())
		&& body.len() <= 3
		&& body.bytes().all(|byte| byte.is_ascii_lowercase())
	{
		return body.to_owned();
	}
	let mut out = String::with_capacity(body.len() + 3);
	out.push(if sup { '^' } else { '_' });
	if body.contains(' ') {
		out.push('(');
		out.push_str(body);
		out.push(')');
	} else {
		out.push_str(body);
	}
	out
}

/// Sibling nodes of a range, skipping dropped subtrees.
#[derive(Clone)]
struct Siblings<'a> {
	nodes:   &'a [Node],
	dropped: &'a [bool],
	next:    usize,
	end:     usize,
}

impl<'a> Iterator for Siblings<'a> {
	type Item = &'a Node;

	fn next(&mut self) -> Option<&'a Node> {
		while self.next < self.end {
			let index = self.next;
			let node = &self.nodes[index];
			self.next = match node {
				Node::Text(_) => index + 1,
				Node::Tag(el) => el.children.end.max(index + 1),
			};
			if !self.dropped.get(index).copied().unwrap_or(false) {
				return Some(node);
			}
		}
		None
	}
}

/// All nodes of a range in document order, skipping dropped subtrees.
struct Descendants<'a> {
	nodes:   &'a [Node],
	dropped: &'a [bool],
	next:    usize,
	end:     usize,
}

impl<'a> Iterator for Descendants<'a> {
	type Item = &'a Node;

	fn next(&mut self) -> Option<&'a Node> {
		while self.next < self.end {
			let index = self.next;
			let node = &self.nodes[index];
			if self.dropped.get(index).copied().unwrap_or(false) {
				self.next = match node {
					Node::Text(_) => index + 1,
					Node::Tag(el) => el.children.end.max(index + 1),
				};
				continue;
			}
			self.next = index + 1;
			return Some(node);
		}
		None
	}
}

const fn is_ws(ch: char) -> bool {
	matches!(ch, ' ' | '\t' | '\n' | '\r' | '\x0C')
}

/// Zero-width characters that only steer line breaking or anchor icons.
pub(super) const fn is_invisible(ch: char) -> bool {
	matches!(ch, '\u{200B}' | '\u{2060}' | '\u{FEFF}')
}

/// Han, kana and full-width forms: scripts written without spaces.
const fn is_cjk(ch: char) -> bool {
	matches!(ch,
		'\u{3000}'..='\u{30FF}'
			| '\u{3400}'..='\u{4DBF}'
			| '\u{4E00}'..='\u{9FFF}'
			| '\u{F900}'..='\u{FAFF}'
			| '\u{FF00}'..='\u{FFEF}')
}

fn push_visible(out: &mut String, text: &str) {
	out.extend(text.chars().filter(|&ch| !is_invisible(ch)));
}

/// Lowercase text with whitespace runs collapsed to single spaces.
fn collapse_lower(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for word in text.split(is_ws).filter(|word| !word.is_empty()) {
		if !out.is_empty() {
			out.push(' ');
		}
		out.extend(
			word
				.chars()
				.filter(|&ch| !is_invisible(ch))
				.flat_map(char::to_lowercase),
		);
	}
	if text.ends_with(is_ws) && !out.is_empty() {
		out.push(' ');
	}
	out
}

/// Whether a paragraph is only a separator glyph or a detached quote mark.
fn is_separator(text: &str) -> bool {
	let mut count = 0;
	for ch in text.chars().filter(|&ch| ch != '\\' && !is_ws(ch)) {
		count += 1;
		if count > 3
			|| !matches!(
				ch,
				'|' | '·'
					| '•'
					| '‧'
					| '∙'
					| '/'
					| '“'
					| '”'
					| '„'
					| '"'
					| '\''
					| '‘'
					| '’'
					| '«'
					| '»'
					| '–'
					| '—'
					| '-'
					| '‐'
					| ':'
			) {
			return false;
		}
	}
	count > 0
}

fn has_class(el: &Element, token: &str) -> bool {
	el.attr("class")
		.is_some_and(|class| class.split_ascii_whitespace().any(|class| class == token))
}

/// Whether any class token contains one of `needles` (lowercase), ignoring
/// case.
fn class_contains(el: &Element, needles: &[&str]) -> bool {
	el.attr("class").is_some_and(|class| {
		class.split_ascii_whitespace().any(|token| {
			let token = token.to_ascii_lowercase();
			needles.iter().any(|needle| token.contains(needle))
		})
	})
}

/// Class names that heading and definition-term permalinks use across
/// documentation generators (Docusaurus, Sphinx, `VitePress`, mandoc, docutils,
/// GitHub, `AnchorJS`).
fn has_permalink_class(el: &Element) -> bool {
	el.attr("class").is_some_and(|class| {
		class.split_ascii_whitespace().any(|token| {
			matches!(
				token,
				"hash-link"
					| "headerlink"
					| "header-anchor"
					| "header-link"
					| "heading-anchor"
					| "heading-link"
					| "anchor"
					| "anchor-link"
					| "anchorjs-link"
					| "permalink"
					| "toc-backref"
			)
		})
	})
}

/// Whether an element's class or style makes it a flex or grid container.
pub(super) fn is_layout(el: &Element) -> bool {
	el.attr("class").is_some_and(|class| {
		class.split_ascii_whitespace().any(|token| {
			matches!(
				token.rsplit(':').next().unwrap_or(token),
				"flex"
					| "inline-flex"
					| "grid"
					| "inline-grid"
					| "contents"
					| "d-flex"
					| "d-inline-flex"
					| "d-grid"
			)
		})
	}) || style_value(el, "display").is_some_and(|display| {
		matches!(display.as_str(), "flex" | "inline-flex" | "grid" | "inline-grid" | "contents")
	})
}

/// Lowercase value of an inline style property.
fn style_value(el: &Element, property: &str) -> Option<String> {
	el.attr("style")?.split(';').find_map(|declaration| {
		let (name, value) = declaration.split_once(':')?;
		name.trim().eq_ignore_ascii_case(property).then(|| {
			value
				.split('!')
				.next()
				.unwrap_or_default()
				.trim()
				.to_ascii_lowercase()
		})
	})
}

/// Whether a block element is laid out as code without being a `pre`:
/// `white-space: pre` (Tailwind `whitespace-pre`) or a highlight.js listing,
/// holding line breaks of its own.
fn is_code_like(el: &Element, nodes: &[Node]) -> bool {
	let preformatted = has_class(el, "whitespace-pre")
		|| style_value(el, "white-space").is_some_and(|value| value == "pre")
		|| el.attr("class").is_some_and(|class| {
			class
				.split_ascii_whitespace()
				.any(|token| token == "hljs" || token.starts_with("hljs-"))
		});
	if !preformatted {
		return false;
	}
	let mut index = el.children.start;
	while index < el.children.end {
		match &nodes[index] {
			Node::Text(text) if text.contains('\n') => return true,
			Node::Text(_) => index += 1,
			Node::Tag(tag) => index = tag.children.end.max(index + 1),
		}
	}
	false
}

/// Line-number gutters of code listings.
pub(super) fn is_gutter(el: &Element) -> bool {
	el.attr("class").is_some_and(|class| {
		class.split_ascii_whitespace().any(|token| {
			let token = token.to_ascii_lowercase();
			[
				"line-number",
				"linenumber",
				"line-numbers-wrapper",
				"line-numbers-rows",
				"lineno",
				"linenos",
			]
			.iter()
			.any(|name| {
				token == *name
					|| token
						.strip_suffix(name)
						.is_some_and(|rest| rest.ends_with(['-', '_']))
			})
		})
	})
}

/// Parts of a code block that are not code: buttons, hidden decorations and
/// line-number gutters.
pub(super) fn is_code_decoration(el: &Element) -> bool {
	el.name() == "button"
		|| el
			.attr("aria-hidden")
			.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
		|| is_gutter(el)
}

/// Whether the next element sibling (past whitespace) is a `pre`.
fn next_is_pre(mut siblings: Siblings<'_>) -> bool {
	siblings
		.find_map(|node| match node {
			Node::Text(text) if text.chars().all(is_ws) => None,
			Node::Text(_) => Some(false),
			Node::Tag(tag) => Some(tag.name() == "pre"),
		})
		.unwrap_or(false)
}

/// Whether preformatted text is code rather than a document: Markdown fences
/// inside it, or diff, mail-quote or hunk lines at the margin.
fn looks_like_code(text: &str) -> bool {
	if longest_run(text, '`') >= 3 {
		return true;
	}
	let mut lines = 0;
	let mut marked = 0;
	for line in text.lines().filter(|line| !line.trim().is_empty()) {
		lines += 1;
		if line.starts_with(['+', '-', '>', '@']) {
			marked += 1;
		}
	}
	marked >= 3 && marked * 10 >= lines
}

/// Code language named by an element: `language-x`, `lang-x`,
/// `highlight-source-x`, `highlight-x` classes, on code elements also `tab-x`
/// and a word beside a `highlight` class, then the `data-language`,
/// `data-lang` and `syntax` attributes.
fn code_lang(el: &Element, code: bool) -> Option<String> {
	let class = el.attr("class").unwrap_or_default();
	let from_class = class.split_ascii_whitespace().find_map(|token| {
		["language-", "lang-", "highlight-source-", "highlight-"]
			.iter()
			.find_map(|prefix| token.strip_prefix(prefix))
			.or_else(|| {
				if code {
					token.strip_prefix("tab-")
				} else {
					None
				}
			})
			.filter(|lang| is_lang(lang))
	});
	let lang = from_class
		.or_else(|| {
			["data-language", "data-lang", "syntax"]
				.iter()
				.find_map(|key| el.attr(key).map(str::trim))
				.filter(|lang| is_lang(lang))
		})
		.or_else(|| {
			if !code
				|| !class
					.split_ascii_whitespace()
					.any(|token| token == "highlight")
			{
				return None;
			}
			class.split_ascii_whitespace().find(|token| {
				is_lang(token)
					&& token
						.bytes()
						.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'+')
					&& !matches!(
						*token,
						"highlight"
							| "notranslate"
							| "chroma"
							| "hljs"
							| "prettyprint"
							| "shiki"
							| "code"
							| "source"
							| "block"
							| "snippet"
							| "highlighter"
							| "rouge"
							| "linenums"
							| "nohighlight"
							| "codehilite"
					)
			})
		})?;
	Some(lang.to_ascii_lowercase())
}

/// Whether a word can be a fence info string naming a language.
pub(super) fn is_lang(lang: &str) -> bool {
	!lang.is_empty()
		&& lang.len() <= 24
		&& lang
			.chars()
			.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '#' | '-' | '_' | '.'))
		&& !lang.eq_ignore_ascii_case("default")
		&& !lang.eq_ignore_ascii_case("none")
}

/// Admonition kinds and their labels.
const ADMONITIONS: [(&str, &str); 13] = [
	("note", "Note"),
	("notice", "Notice"),
	("tip", "Tip"),
	("hint", "Hint"),
	("info", "Info"),
	("important", "Important"),
	("warning", "Warning"),
	("caution", "Caution"),
	("danger", "Danger"),
	("error", "Error"),
	("success", "Success"),
	("attention", "Attention"),
	("seealso", "See also"),
];

/// Whether an element is an admonition: an `admonition` / `theme-admonition`
/// class (Sphinx, `MkDocs`, Docusaurus, PEPs) or an `aside` classed with an
/// admonition kind (Slate).
pub(super) fn is_admonition(el: &Element) -> bool {
	if !matches!(el.name(), "div" | "aside" | "section") {
		return false;
	}
	el.attr("class").is_some_and(|class| {
		class.split_ascii_whitespace().any(|token| {
			matches!(token, "admonition" | "theme-admonition" | "markdown-alert")
				|| (el.name() == "aside" && ADMONITIONS.iter().any(|(kind, _)| *kind == token))
		})
	})
}

/// Label of an admonition's kind from its class (`warning` → "Warning").
pub(super) fn admonition_kind(el: &Element) -> Option<&'static str> {
	el.attr("class")?
		.split_ascii_whitespace()
		.find_map(|token| {
			let token = token
				.strip_prefix("theme-admonition-")
				.or_else(|| token.strip_prefix("markdown-alert-"))
				.unwrap_or(token);
			ADMONITIONS
				.iter()
				.find(|(kind, _)| *kind == token)
				.map(|(_, label)| *label)
		})
}

/// Whether alt text describes nothing: a generic word, a file name, a
/// separator bar or bare punctuation.
fn is_decorative_alt(alt: &str) -> bool {
	let lower = alt.to_lowercase();
	if matches!(
		lower.as_str(),
		"image"
			| "img"
			| "photo"
			| "picture"
			| "icon"
			| "logo"
			| "screenshot"
			| "graphic"
			| "thumbnail"
			| "placeholder"
			| "spacer"
	) || !alt.chars().any(char::is_alphanumeric)
		|| ["--", "==", "__", "**"]
			.iter()
			.any(|rule| alt.starts_with(rule) || alt.ends_with(rule))
		|| lower
			.split(|ch: char| !ch.is_alphanumeric())
			.any(|word| matches!(word, "separator" | "divider" | "spacer"))
		|| lower
			.split(|ch: char| !ch.is_alphanumeric())
			.rfind(|word| !word.is_empty())
			.is_some_and(|word| matches!(word, "logo" | "icon" | "avatar"))
	{
		return true;
	}
	if alt.contains(char::is_whitespace) {
		return false;
	}
	lower.rsplit_once('.').is_some_and(|(_, extension)| {
		matches!(
			extension,
			"png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "avif" | "bmp" | "ico" | "tif" | "tiff"
		)
	}) || (alt.contains('_')
		&& alt
			.chars()
			.all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-')))
}

/// Decode a Cloudflare-obfuscated address: hex bytes `XORed` with the first.
pub(super) fn cf_email(hex: &str) -> Option<String> {
	let hex = hex.trim();
	if hex.len() < 4 || hex.len() % 2 != 0 {
		return None;
	}
	let byte = |at: usize| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok();
	let key = byte(0)?;
	let bytes = (2..hex.len())
		.step_by(2)
		.map(|at| byte(at).map(|byte| byte ^ key))
		.collect::<Option<Vec<u8>>>()?;
	String::from_utf8(bytes)
		.ok()
		.filter(|email| email.contains('@') && !email.contains(char::is_control))
}

/// Unicode superscript or subscript form of a digit or sign.
const fn script_char(ch: char, sup: bool) -> Option<char> {
	const SUP: [char; 15] =
		['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', '⁺', '⁻', '⁼', '⁽', '⁾'];
	const SUB: [char; 15] =
		['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉', '₊', '₋', '₌', '₍', '₎'];
	let index = match ch {
		'0'..='9' => ch as usize - '0' as usize,
		'+' => 10,
		'-' | '−' => 11,
		'=' => 12,
		'(' => 13,
		')' => 14,
		_ => return None,
	};
	Some(if sup { SUP[index] } else { SUB[index] })
}

/// Elements whose content is never page text.
fn is_skipped(el: &Element) -> bool {
	match el.name() {
		"script" | "style" | "head" | "title" | "svg" | "iframe" | "frame" | "frameset" | "input"
		| "datalist" | "map" => true,
		// Declarative shadow roots are rendered content; other templates are
		// inert.
		"template" => !matches!(el.attr("shadowrootmode"), Some("open" | "closed")),
		_ => false,
	}
}

fn is_block(name: &str) -> bool {
	matches!(
		name,
		"address"
			| "article"
			| "aside"
			| "blockquote"
			| "body"
			| "caption"
			| "center"
			| "dd"
			| "details"
			| "dialog"
			| "dir"
			| "div"
			| "dl"
			| "dt"
			| "fieldset"
			| "figcaption"
			| "figure"
			| "footer"
			| "form"
			| "h1"
			| "h2"
			| "h3"
			| "h4"
			| "h5"
			| "h6"
			| "header"
			| "hgroup"
			| "hr"
			| "html"
			| "legend"
			| "li"
			| "listing"
			| "main"
			| "menu"
			| "nav"
			| "noframes"
			| "ol"
			| "p"
			| "plaintext"
			| "pre"
			| "search"
			| "section"
			| "summary"
			| "table"
			| "tbody"
			| "td"
			| "tfoot"
			| "th"
			| "thead"
			| "tr"
			| "ul"
			| "xmp"
	)
}

fn is_preformatted(name: &str) -> bool {
	matches!(name, "pre" | "xmp" | "listing" | "plaintext")
}

/// Whether `href` starts with `scheme`, ignoring case and the tabs and
/// newlines URL parsing strips.
fn has_scheme(href: &str, scheme: &str) -> bool {
	let mut chars = href.chars().filter(|ch| !matches!(ch, '\t' | '\n' | '\r'));
	scheme.chars().all(|expected| {
		chars
			.next()
			.is_some_and(|ch| ch.eq_ignore_ascii_case(&expected))
	})
}

/// Append preformatted text escaped for a Markdown paragraph, keeping line
/// breaks and expanding tabs.
fn push_document_text(out: &mut String, text: &str, column: &mut usize) {
	let mut chars = text.char_indices().peekable();
	while let Some((at, ch)) = chars.next() {
		match ch {
			'\n' => {
				out.push('\n');
				*column = 0;
				continue;
			},
			'\r' => {
				if chars.peek().is_none_or(|&(_, next)| next != '\n') {
					out.push('\n');
					*column = 0;
				}
				continue;
			},
			'\t' => {
				let spaces = 8 - *column % 8;
				push_repeated(out, ' ', spaces);
				*column += spaces;
				continue;
			},
			ch if is_invisible(ch) => continue,
			'\\' | '`' | '*' | '_' | '[' | ']' | '<' | '~' => out.push('\\'),
			'&' if entity_like(&text[at + 1..]) => out.push('\\'),
			_ => {},
		}
		out.push(ch);
		*column += 1;
	}
}

/// Whether `rest`, following an `&`, would read as a character reference.
fn entity_like(rest: &str) -> bool {
	let body = rest.strip_prefix('#').unwrap_or(rest);
	let name = body.bytes().take_while(u8::is_ascii_alphanumeric).count();
	name > 0 && body.as_bytes().get(name) == Some(&b';')
}

fn push_destination(out: &mut String, target: &str) {
	let mut depth = 0i32;
	let mut balanced = true;
	for ch in target.chars() {
		match ch {
			'(' => depth += 1,
			')' => {
				depth -= 1;
				balanced &= depth >= 0;
			},
			_ => {},
		}
	}
	if balanced
		&& depth == 0
		&& !target.contains(|ch: char| ch == ' ' || ch == '<' || ch == '>' || ch.is_control())
	{
		out.push_str(target);
		return;
	}
	out.push('<');
	for ch in target.chars() {
		match ch {
			'<' => out.push_str("%3C"),
			'>' => out.push_str("%3E"),
			ch if ch.is_control() => {},
			ch => out.push(ch),
		}
	}
	out.push('>');
}

fn longest_run(text: &str, target: char) -> usize {
	let mut longest = 0;
	let mut run = 0;
	for ch in text.chars() {
		if ch == target {
			run += 1;
			longest = longest.max(run);
		} else {
			run = 0;
		}
	}
	longest
}

fn push_repeated(out: &mut String, ch: char, count: usize) {
	out.extend(std::iter::repeat_n(ch, count));
}

fn span(cell: &Element, attr: &str) -> usize {
	cell
		.attr(attr)
		.and_then(|value| value.trim().parse::<usize>().ok())
		.filter(|&n| n > 0)
		.unwrap_or(1)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::dom::parse;

	fn render(html: &str, base: Option<&str>, images: bool) -> String {
		let nodes = parse(html).unwrap();
		let selection = Selection {
			root:             0..nodes.len(),
			dropped:          vec![false; nodes.len()],
			recoverable_only: false,
		};
		let base = base.map(|base| Url::parse(base).unwrap());
		write(&nodes, &selection, base.as_ref(), images)
	}

	fn md(html: &str) -> String {
		render(html, None, true)
	}

	#[test]
	fn whitespace_only_paragraphs_do_not_emit_lines() {
		assert_eq!(
			md("<h3>Heading</h3><p>&nbsp;</p><p>4&nbsp;GB</p><p>&nbsp;&nbsp;</p><p>End</p>"),
			"### Heading\n\n4\u{a0}GB\n\nEnd\n",
		);
	}

	#[test]
	fn nested_and_ordered_lists() {
		assert_eq!(
			md("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol \
			    start=\"3\"><li>x</li><li>y</li></ol>"),
			"- a\n  - b\n- c\n\n3. x\n4. y\n",
		);
		assert_eq!(
			md("<blockquote><p>q</p><ol><li><p>one</p><p>more</p></li></ol></blockquote>"),
			"> q\n>\n> 1. one\n>\n>    more\n",
		);
	}

	#[test]
	fn rectangular_inline_table_is_gfm() {
		assert_eq!(
			md("<table><tr><th>Name</th><th>Qty</th></tr><tr><td>a|b</td><td><b>1</b></td></tr></\
			    table>"),
			"| Name | Qty |\n| --- | --- |\n| a\\|b | **1** |\n",
		);
		// Data rows without header cells still form a table.
		assert_eq!(
			md("<table><tr><td>Brand</td><td>Wakefit</td></tr><tr><td>Country</td><td>India</td></\
			    tr></table>"),
			"| Brand | Wakefit |\n| --- | --- |\n| Country | India |\n",
		);
	}

	#[test]
	fn header_span_and_full_width_rows_keep_a_pipe_table() {
		assert_eq!(
			md("<table><tr><th \
			    colspan=\"2\">Parameters</th></tr><tr><td><p><code>a</code></p></td><td><p>A \
			    thing.</p></td></tr><tr><td>b</td><td>B</td></tr><tr><td><a \
			    href=\"javascript:x\"><img src=\"/i.png\"></a></td><td></td></tr><tr><td \
			    colspan=\"100%\"><p>See more.</p></td></tr></table>"),
			"| Parameters |  |\n| --- | --- |\n| `a` | A thing. |\n| b | B |\n\nSee more.\n",
		);
	}

	#[test]
	fn layout_table_flattens_to_blocks() {
		assert_eq!(
			md("<table><tr><td><p>One</p><p>Two</p></td><td>Three</td></tr></table>"),
			"One\n\nTwo\n\nThree\n",
		);
		assert_eq!(
			md("<table><tr><td>Outer</td><td><table><tr><th>A</th></tr><tr><td>1</td></tr></table></\
			    td></tr></table>"),
			"Outer\n\n| A |\n| --- |\n| 1 |\n",
		);
	}

	#[test]
	fn spanning_table_is_a_text_grid() {
		assert_eq!(
			md("<table><tr><th>A</th><th>B</th></tr><tr><td \
			    rowspan=\"2\">x</td><td>1</td></tr><tr><td>22</td></tr></table>"),
			"```\nA  B\n-  --\nx  1\n   22\n```\n",
		);
	}

	#[test]
	fn escapes_metacharacters() {
		assert_eq!(
			md("<p>1. Not a list *star* snake_case a_ [x] &lt;tag&gt; AT&amp;T &amp;copy; \
			    back\\slash</p><p>- dash</p><h2>Issue #</h2>"),
			"1\\. Not a list \\*star\\* snake_case a\\_ \\[x\\] \\<tag> AT&T \\&copy; \
			 back\\\\slash\n\n\\- dash\n\n## Issue \\#\n",
		);
		assert_eq!(md("<p>a<b> bold </b>c <i></i>d</p>"), "a **bold** c d\n");
	}

	#[test]
	fn separator_paragraphs_are_dropped() {
		assert_eq!(md("<p>Lauren</p><p>|</p><p>April</p><p>“</p>"), "Lauren\n\nApril\n");
	}

	#[test]
	fn fences_outrun_backticks() {
		assert_eq!(
			md("<pre><code class=\"language-rust\">let a = \"```\";\n</code></pre><p>Use \
			    <code>a`b</code> here</p>"),
			"````rust\nlet a = \"```\";\n````\n\nUse ``a`b`` here\n",
		);
		assert_eq!(
			md("<div class=\"highlight highlight-source-shell\"><pre>\nls\n  -la</pre></div>"),
			"```shell\nls\n  -la\n```\n",
		);
	}

	#[test]
	fn code_blocks_drop_chrome_and_find_their_language() {
		assert_eq!(
			md("<div class=\"code-block\"><div \
			    class=\"code-block__chrome\"><span>lua</span><button>Copy</button></\
			    div><pre><code>local x\u{200b} = 1</code><div class=\"line-numbers-wrapper\" \
			    aria-hidden=\"true\"><span class=\"line-number\">1</span></div></pre></div><pre \
			    class=\"highlight python tab-python\">print(1)</pre><pre \
			    syntax=\"Bash\">ls</pre><pre><div \
			    class=\"toolbar\">Code<button>Copy</button></div><code>x = 1</code></pre><div \
			    class=\"whitespace-pre\">a\n  b</div>"),
			"```lua\nlocal x = 1\n```\n\n```python\nprint(1)\n```\n\n```bash\nls\n```\n\n```\nx = \
			 1\n```\n\n```\na\n  b\n```\n",
		);
	}

	#[test]
	fn diff_in_a_linked_pre_stays_code() {
		assert_eq!(
			md("<pre>Patch:\n- old\n+ new\n- gone\n<a href=\"/l\">ref</a></pre>"),
			"```\nPatch:\n- old\n+ new\n- gone\nref\n```\n",
		);
	}

	#[test]
	fn data_uri_image_keeps_only_alt() {
		let html = "<p><img src=\"DATA:image/png;base64,AAAA\" alt=\"Chart\" \
		            title=\"caption\"></p><p><img src=\"/a.png\" alt=\"A\"></p>";
		assert_eq!(
			render(html, Some("https://example.com/post"), true),
			"![Chart]\n\n![A](https://example.com/a.png)\n",
		);
		assert_eq!(render(html, Some("https://example.com/post"), false), "");
	}

	#[test]
	fn images_without_alt_are_omitted() {
		assert_eq!(md("<p>a <img src=\"/s.gif\"> b <img src=\"/x.png\" alt=\" \"></p>"), "a b\n");
	}

	#[test]
	fn decorative_images_are_omitted() {
		assert_eq!(
			md("<p><img src=\"/bar.gif\" alt=\"--- separator bar ---\"><img src=\"/a.png\" \
			    alt=\"ipad_apple_pencil\"><img src=\"/b.png\" alt=\"image\"><img src=\"/c.png\" \
			    alt=\"+\"> ok</p><div><img src=\"/i.svg\" alt=\"Speech API\"><h5>Speech \
			    API</h5></div>"),
			"ok\n\n##### Speech API\n",
		);
	}

	#[test]
	fn cloudflare_email_is_decoded() {
		assert_eq!(
			md("<p>Email <a href=\"/cdn-cgi/l/email-protection#422a2b023a6c2b2d\"><span \
			    class=\"__cf_email__\" \
			    data-cfemail=\"422a2b023a6c2b2d\">[email&#160;protected]</span></a></p>"),
			"Email [hi@x.io](mailto:hi@x.io)\n",
		);
	}

	#[test]
	fn nested_definitions_never_indent_into_code() {
		assert_eq!(
			md("<dl><dt>outer</dt><dd><p>One.</p><dl><dt>inner</dt><dd><p>Two.</p><p>Three.</p></\
			    dd></dl></dd></dl>"),
			"**outer**\n: One.\n\n  **inner**\n  : Two.\n\n  Three.\n",
		);
	}

	#[test]
	fn definition_keeps_its_list_and_paragraphs() {
		assert_eq!(
			md("<dl><dt>T</dt><dd><ul><li>a</li><li>b</li></ul><p>more</p></dd></dl>"),
			"**T**\n: - a\n  - b\n\n  more\n",
		);
	}

	#[test]
	fn heading_permalinks_are_dropped() {
		assert_eq!(
			md("<h2 id=\"a\">Title<a class=\"hash-link\" href=\"#a\">\u{200b}</a></h2><h2><a \
			    href=\"#b\">#</a>B</h2><h3><a class=\"toc-backref\" \
			    href=\"#toc\"><b>C</b></a></h3><h4>D<a class=\"headerlink\" \
			    href=\"#d\">¶</a></h4><dl><dt id=\"q\"><a class=\"permalink\" \
			    href=\"#q\"><code>q</code></a><span \
			    class=\"classifier\">required</span></dt><dd>d</dd></dl>"),
			"## Title\n\n## B\n\n### C\n\n#### D\n\n**`q` required**\n: d\n",
		);
	}

	#[test]
	fn block_links_keep_their_blocks() {
		assert_eq!(
			render(
				"<a href=\"/x\"><div><h5>Card</h5><p>Body text</p></div></a><a href=\"#h\"><h2 \
				 id=\"h\">Self</h2></a><a href=\"/y\"><div>Alpha</div><div>Beta</div></a>",
				Some("https://e.com/"),
				true,
			),
			"##### [Card](https://e.com/x)\n\nBody text\n\n## Self\n\n[Alpha](https://e.com/y)\n\nBeta\n",
		);
	}

	#[test]
	fn adjacent_labels_get_a_space() {
		assert_eq!(
			md("<p><time>August 18, 2022</time><span class=\"ml-3\">2 min read</span></p><div \
			    class=\"flex\"><span>text</span><span>Yes</span></div><p>foo<b>bar</b> <span \
			    class=\"a\">x</span><span class=\"a\">y</span> \
			    <strong>tested</strong><span>partial</span>, <span>中</span><b>文</b></p>"),
			"August 18, 2022 2 min read\n\ntext Yes\n\nfoo**bar** xy **tested** partial, 中**文**\n",
		);
		// Code paths and calls stay glued.
		assert_eq!(
			md("<p><span class=\"pre\">gemm.</span><span class=\"name\">mm_fp4</span><span \
			    class=\"paren\">(</span><em class=\"param\">a</em></p>"),
			"gemm.mm_fp4(*a*\n",
		);
	}

	#[test]
	fn emphasis_that_cannot_flank_is_unwrapped() {
		assert_eq!(
			md("<p>with <b><tt>SF.</tt></b>Multiple and foo<b>(x)</b> and <b>ok.</b> end</p>"),
			"with `SF.`Multiple and foo(x) and **ok.** end\n",
		);
	}

	#[test]
	fn scripts_read_as_text() {
		assert_eq!(
			md("<p>τ<sup>2</sup>-bench HLE<sup>[1]</sup> +0<sub>𝔽</sub> 1<sup>st</sup> x<sup>n + \
			    1</sup> H<sub>2</sub>O</p>"),
			"τ²-bench HLE^\\[1\\] +0_𝔽 1st x^(n + 1) H₂O\n",
		);
	}

	#[test]
	fn heading_conventions() {
		assert_eq!(
			md("<div class=\"md-h1 heading-h1\">1. Intro</div><p \
			    class=\"rubric\">Notes</p><emu-clause><h1>A</h1><emu-clause><h1>B</h1></\
			    emu-clause></emu-clause><h2>Kernel<label class=\"margin-toggle\">⊕</label><span \
			    class=\"sidenote\">aside text</span></h2><p>memory,<span \
			    class=\"sidenote\">Global.</span> more</p>"),
			"# 1. Intro\n\n## Notes\n\n# A\n\n## B\n\n## Kernel\n\n(aside text)\n\nmemory, (Global.) \
			 more\n",
		);
	}

	#[test]
	fn admonitions_are_labelled_blockquotes() {
		assert_eq!(
			md("<div class=\"theme-admonition theme-admonition-tip admonition_x\"><div \
			    class=\"admonitionHeading_y\"><span><svg></svg></span>tip</div><div \
			    class=\"admonitionContent_z\"><p>Use it.</p></div></div><aside \
			    class=\"warning\">Keep secret.</aside>"),
			"> **Tip**\n>\n> Use it.\n\n> **Warning**\n>\n> Keep secret.\n",
		);
	}

	#[test]
	fn linked_preformatted_document_keeps_lines_and_links() {
		assert_eq!(
			md("<pre>Title\n   1.  See <a href=\"#s2\">Section 2</a> *now*\n\nNext</pre>"),
			"Title\\\n\u{a0}\u{a0}\u{a0}1.  See [Section 2](#s2) \\*now\\*\n\nNext\n",
		);
		// Code with links stays a code block.
		assert_eq!(
			md("<pre><code>use <a href=\"/std\">std</a>;</code></pre>"),
			"```\nuse std;\n```\n",
		);
	}

	#[test]
	fn links_resolve_against_base() {
		assert_eq!(
			render(
				"<p><a href=\"../guide\">Guide</a> <a href=\"#top\">Top</a> <a \
				 href=\"javascript:void(0)\">Run</a> <a href=\"/x\"> </a>end</p>",
				Some("https://example.com/docs/page"),
				true,
			),
			"[Guide](https://example.com/guide) [Top](#top) Run end\n",
		);
	}

	#[test]
	fn skips_dropped_subtrees_and_inert_text() {
		let nodes = parse(
			"<p>keep</p><div><p>gone</p></div><script>bad()</script><template><p>tpl</p></\
			 template><p>end</p>",
		)
		.unwrap();
		let mut dropped = vec![false; nodes.len()];
		let div = nodes
			.iter()
			.position(|node| matches!(node, Node::Tag(el) if el.name() == "div"))
			.unwrap();
		dropped[div] = true;
		let selection = Selection { root: 0..nodes.len(), dropped, recoverable_only: false };
		assert_eq!(write(&nodes, &selection, None, true), "keep\n\nend\n");
	}

	#[test]
	fn content_images_without_alt_stand_alone() {
		assert_eq!(
			md("<p>Before.</p><img class=\"align-center\" src=\"/bp.png\"><p>After.</p><img \
			    src=\"/hline.jpg\" style=\"width: 320px; height: 5px;\"><a href=\"/\"><img \
			    src=\"/home.png\"></a><img src=\"/icons/x.svg\"><img class=\"bottom-logo\" \
			    src=\"/b.png\"><img alt=\"Spark icon\" src=\"/spark.svg\">"),
			"Before.\n\n![](/bp.png)\n\nAfter.\n",
		);
	}

	#[test]
	fn css_drawn_boundaries_separate_words() {
		assert_eq!(
			md("<div class=\"api_metadata\"><span>Added in: v10.6.0</span><span><b>N-API Version: \
			    </b>4</span></div><div><span>Input from</span><strong>—</strong><small>Per \
			    1M</small></div><p><span class=\"a\">9.2k</span><span class=\"b\">~160 \
			    ms</span></p><h4 class=\"inline-flex\">Extended<span>Score</span></h4><h1><a \
			    href=\"/g\">Gdk</a><span class=\"sep\"></span><a href=\"/e\">Event</a><span \
			    class=\"sep\"></span>get</h1>"),
			"Added in: v10.6.0 **N-API Version:** 4\n\nInput from **—** Per 1M\n\n9.2k \\~160 \
			 ms\n\n#### Extended Score\n\n# [Gdk](/g) [Event](/e) get\n",
		);
	}

	#[test]
	fn joiners_that_join_nothing_are_dropped() {
		assert_eq!(
			md("<h3>\u{200d}What happened</h3><p>Final\u{200d}</p><p>🐱\u{200d}💻 ok</p>"),
			"### What happened\n\nFinal\n\n🐱\u{200d}💻 ok\n",
		);
	}

	#[test]
	fn ordered_items_drop_their_own_number() {
		assert_eq!(
			md("<ol class=\"list-none\"><li class=\"flex\"><span>1</span><a \
			    href=\"/v\">Vercel</a></li><li><span>2.</span>Two</li><li><b>7</b> seven</li></ol>"),
			"1. [Vercel](/v)\n2. Two\n3. **7** seven\n",
		);
	}

	#[test]
	fn dash_only_definition_is_a_value() {
		assert_eq!(md("<dl><dt>Knowledge</dt><dd>—</dd></dl>"), "**Knowledge**\n: —\n");
	}

	#[test]
	fn column_spans_and_empty_columns_keep_a_pipe_table() {
		assert_eq!(
			md("<table><thead><tr><th></th><th>Filename</th><th>Size</th></tr></\
			    thead><tr><td><svg></svg></td><td colspan=\"2\"><a \
			    href=\"/up\">../</a></td></tr><tr><td><svg></svg></td><td>a.svg</td><td>7 \
			    kB</td></tr></table>"),
			"| Filename | Size |\n| --- | --- |\n| [../](/up) |  |\n| a.svg | 7 kB |\n",
		);
	}

	#[test]
	fn property_tables_become_definitions() {
		assert_eq!(
			md("<table class=\"properties\"><tr><th colspan=\"2\">Parameters</th></tr><tr><td><code>\
			    c2coff</code></td><td><p><code>string</code></p><p>Enables search.</p></td></\
			    tr><tr><td><code>cx</code></td><td><p><code>string</code></p><p>The ID.</p></td></\
			    tr></table>"),
			"Parameters\n\n**`c2coff`**\n: `string`\n\n  Enables search.\n\n**`cx`**\n: \
			 `string`\n\n  The ID.\n",
		);
	}

	#[test]
	fn toolbar_with_a_dropped_button_names_the_language() {
		let nodes = parse(
			"<div><span \
			 class=\"font-mono\">typescript</span><button>Copy</button></div><pre><code>let x = \
			 1;</code></pre>",
		)
		.unwrap();
		let dropped: Vec<bool> = nodes
			.iter()
			.map(|node| matches!(node, Node::Tag(el) if el.name() == "button"))
			.collect();
		let selection = Selection { root: 0..nodes.len(), dropped, recoverable_only: false };
		assert_eq!(write(&nodes, &selection, None, true), "```typescript\nlet x = 1;\n```\n");
	}

	#[test]
	fn github_alert_is_a_labelled_blockquote() {
		assert_eq!(
			md("<div class=\"markdown-alert tip\"><span><svg></svg>Tip</span><p>Use it.</p></div>"),
			"> **Tip**\n>\n> Use it.\n",
		);
	}
}
