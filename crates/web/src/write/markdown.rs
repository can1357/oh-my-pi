//! CommonMark writer (with GFM tables and strikethrough) for a selected HTML
//! subtree.
//!
//! One walk over the selection: inline content accumulates in a paragraph
//! buffer with HTML whitespace collapsing, and block structure (blockquotes,
//! list items, definitions) is carried as a stack of line prefixes applied as
//! each line is written. The writer never emits front matter; the reader adds
//! title and metadata itself.

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
/// only its alt text (`![alt]`), an image without alt text (spacers, tracking
/// pixels, decoration) is omitted, an image URL over 512 bytes keeps only its
/// alt text, and `images = false` omits images entirely. A `pre` that links
/// somewhere and holds no code is a preformatted document (RFCs, man pages):
/// its lines become hard-broken paragraph lines that keep their links.
/// Subtrees flagged in `selection.dropped` are skipped; `script`, `style`,
/// `head`, `title` and `template` (except declarative shadow roots) never
/// contribute text.
#[must_use]
pub fn write(nodes: &[Node], selection: &Selection, base: Option<&Url>, images: bool) -> String {
	let mut writer = Writer {
		nodes,
		dropped: &selection.dropped,
		base,
		images,
		out: String::new(),
		inline: String::new(),
		pending_space: false,
		pending_break: false,
		open_start: 0,
		open_end: usize::MAX,
		prefix: Vec::new(),
		blank: None,
		fresh: true,
		inline_only: 0,
		plain: false,
		in_cell: false,
		in_link: false,
		active: [false; STYLES],
		lang: None,
		after_image: false,
	};
	let root = selection.root.start..selection.root.end.min(nodes.len());
	writer.children(root);
	writer.finish()
}

/// Longest image URL worth writing; longer ones embed their payload.
const IMAGE_URL_MAX_LEN: usize = 512;

/// List and definition markers; the first line of an item carries the marker,
/// later lines indent by its width.
#[derive(Clone, Copy)]
enum Marker {
	Bullet,
	Number(u64),
	Colon,
}

impl Marker {
	/// Indent of an item's continuation lines. A definition (`: `) is not a
	/// CommonMark container, so its continuation stays unindented: four
	/// columns of nested definitions would read as an indented code block.
	const fn width(self) -> usize {
		match self {
			Self::Bullet => 2,
			Self::Colon => 0,
			Self::Number(n) => match n.checked_ilog10() {
				Some(digits) => digits as usize + 3,
				None => 3,
			},
		}
	}
}

enum Prefix {
	Quote,
	Item { width: usize, marker: Option<Marker> },
}

#[derive(Clone, Copy)]
enum Style {
	Strong,
	Em,
	Del,
	Sub,
	Sup,
	Quote,
}

const STYLES: usize = 6;

impl Style {
	const fn markers(self) -> (&'static str, &'static str) {
		match self {
			Self::Strong => ("**", "**"),
			Self::Em => ("*", "*"),
			Self::Del => ("~~", "~~"),
			Self::Sub => ("<sub>", "</sub>"),
			Self::Sup => ("<sup>", "</sup>"),
			Self::Quote => ("\"", "\""),
		}
	}
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
	active:        [bool; STYLES],
	/// Code language from an enclosing `div` class.
	lang:          Option<&'a str>,
	/// No text since the last image: the next image needs a separating space
	/// (`<a><img alt="Fire"></a><a><img alt="Fire"></a>` reads "Fire Fire").
	after_image:   bool,
}

impl<'a> Writer<'a> {
	const fn siblings(&self, range: Range<usize>) -> Siblings<'a> {
		Siblings {
			nodes:   self.nodes,
			dropped: self.dropped,
			next:    range.start,
			end:     range.end,
		}
	}

	const fn descendants(&self, range: Range<usize>) -> Descendants<'a> {
		Descendants {
			nodes:   self.nodes,
			dropped: self.dropped,
			next:    range.start,
			end:     range.end,
		}
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
				Prefix::Item { width, marker } => {
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
	}

	/// Write the paragraph buffer, if it holds anything.
	fn flush(&mut self) {
		self.reset_inline();
		if self.inline.is_empty() {
			return;
		}
		let mut buffer = mem::take(&mut self.inline);
		let text = buffer.trim_matches(is_ws);
		for line in text.split('\n') {
			self.paragraph_line(line);
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
		self.children(el.children.clone());
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
			self.before_content();
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
		for node in self.siblings(range) {
			self.node(node);
		}
	}

	fn node(&mut self, node: &'a Node) {
		match node {
			Node::Text(text) => self.text(text),
			Node::Tag(el) => self.element(el),
		}
	}

	fn element(&mut self, el: &'a Element) {
		if is_skipped(el) {
			return;
		}
		let name = el.name();
		if self.inline_only > 0 && is_block(name) {
			if is_preformatted(name) {
				return self.code_span(el);
			}
			self.space();
			self.children(el.children.clone());
			self.space();
			return;
		}
		match name {
			"br" => self.br(),
			"img" => self.image(el),
			"a" => self.link(el),
			"strong" | "b" => self.styled(el, Style::Strong),
			"em" | "i" => self.styled(el, Style::Em),
			"del" | "s" | "strike" => self.styled(el, Style::Del),
			"sub" => self.styled(el, Style::Sub),
			"sup" => self.styled(el, Style::Sup),
			"q" => self.styled(el, Style::Quote),
			"code" | "kbd" | "samp" | "tt" => self.code_span(el),
			"select" => self.select(el),
			name if is_preformatted(name) => self.pre(el),
			"h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
				self.heading(el, usize::from(name.as_bytes()[1] - b'0'));
			},
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
				self.children(el.children.clone());
				self.flush();
				self.prefix.pop();
				self.gap();
			},
			"table" => self.table(el),
			"div" => match class_lang(el) {
				Some(lang) => {
					let outer = self.lang.replace(lang);
					self.block(el);
					self.lang = outer;
				},
				None => self.block(el),
			},
			name if is_block(name) => self.block(el),
			_ => self.children(el.children.clone()),
		}
	}

	fn styled(&mut self, el: &'a Element, style: Style) {
		let index = style as usize;
		// Nested emphasis of the same kind adds no markers; quotes nest.
		let emit = matches!(style, Style::Quote) || !self.active[index];
		let (open, close) = style.markers();
		let mark = emit.then(|| self.open(open));
		let outer = mem::replace(&mut self.active[index], true);
		self.inline_only += 1;
		self.children(el.children.clone());
		self.inline_only -= 1;
		self.active[index] = outer;
		if let Some(mark) = mark {
			self.close(mark, close);
		}
	}

	fn link(&mut self, el: &'a Element) {
		let target = if self.in_link {
			None
		} else {
			el.attr("href").and_then(|href| self.target(href))
		};
		let Some(target) = target else {
			return self.children(el.children.clone());
		};
		let mark = self.open("[");
		self.in_link = true;
		self.inline_only += 1;
		self.children(el.children.clone());
		self.inline_only -= 1;
		self.in_link = false;
		if self.close(mark, "](") && !self.plain {
			push_destination(&mut self.inline, &target);
			self.inline.push(')');
		}
	}

	fn image(&mut self, el: &'a Element) {
		if !self.images {
			return;
		}
		let alt = el.attr("alt").unwrap_or_default().trim_matches(is_ws);
		if alt.is_empty() {
			return;
		}
		if self.plain {
			self.space();
			self.text(alt);
			self.space();
			return;
		}
		// An image URL carrying an inline payload (a badge with an embedded
		// base64 logo) is bloat, like a `data:` image: keep only the alt text.
		let src = ["src", "data-src", "data-original", "data-lazy-src"]
			.iter()
			.find_map(|key| el.attr(key).and_then(|value| self.target(value)))
			.filter(|src| src.len() <= IMAGE_URL_MAX_LEN);
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
				Node::Text(text) => out.push_str(text),
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

	fn pre(&mut self, el: &'a Element) {
		if self.lang.is_none() && class_lang(el).is_none() && self.is_linked_document(el) {
			return self.preformatted_document(el);
		}
		let mut code = String::new();
		self.collect_text(el.children.clone(), &mut code, true);
		if code.contains('\r') {
			code = code.replace("\r\n", "\n").replace('\r', "\n");
		}
		let lang = class_lang(el)
			.or_else(|| {
				self
					.descendants(el.children.clone())
					.find_map(|node| match node {
						Node::Tag(code) if code.name() == "code" => Some(class_lang(code)),
						_ => None,
					})?
			})
			.or(self.lang)
			.unwrap_or_default();
		self.flush();
		self.gap();
		let first = code.find(|ch: char| !is_ws(ch));
		if let Some(first) = first {
			let start = code[..first].rfind('\n').map_or(0, |newline| newline + 1);
			let body = code[start..].trim_end();
			let fence = "`".repeat(longest_run(body, '`').max(2) + 1);
			self.line(&[fence.as_str(), lang]);
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
		self.inline_only += 1;
		self.children(el.children.clone());
		self.inline_only -= 1;
		self.reset_inline();
		let mut buffer = mem::take(&mut self.inline);
		let text = buffer.trim_matches(is_ws);
		if !text.is_empty() {
			let hashes = &"######"[..level];
			// A trailing `#` run would read as a closing sequence.
			let body = text.trim_end_matches('#');
			if body.len() < text.len() {
				self.line(&[hashes, " ", body, "\\", &text[body.len()..]]);
			} else {
				self.line(&[hashes, " ", text]);
			}
			self.gap();
		}
		buffer.clear();
		self.inline = buffer;
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
			self.children(option.children.clone());
			self.space();
		}
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
					self.item(li, marker, self.out.len() > begin);
					next += if reversed { -1 } else { 1 };
				},
				// Stray content after an item continues that item.
				_ if self.out.len() > begin => {
					self.prefix.push(Prefix::Item { width, marker: None });
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
		self
			.prefix
			.push(Prefix::Item { width: marker.width(), marker: Some(marker) });
		self.children(el.children.clone());
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
		self.styled(el, Style::Strong);
		self.flush();
		self.gap();
	}

	// ── Tables ────────────────────────────────────────────────────────────

	fn table(&mut self, el: &'a Element) {
		let mut shape = Shape::default();
		self.scan_table(el.children.clone(), &mut shape);
		shape.rows.retain(|row| !row.is_empty());
		let rows = &shape.rows;
		let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
		let spans = rows
			.iter()
			.flatten()
			.any(|cell| span(cell, "colspan") > 1 || span(cell, "rowspan") > 1);
		let rectangular = !spans && rows.iter().all(|row| row.len() == columns);
		self.flush();
		self.gap();
		if shape.layout
			|| rows.is_empty()
			|| (!shape.header && (rows.len() < 2 || columns < 2 || !rectangular))
		{
			self.children(el.children.clone());
		} else {
			if let Some(caption) = shape.caption {
				self.block(caption);
			}
			if rectangular {
				self.pipe_table(rows);
			} else {
				self.grid(rows);
			}
		}
		self.flush();
		self.gap();
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
		self.children(cell.children.clone());
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

	fn pipe_table(&mut self, rows: &[Vec<&'a Element>]) {
		let cells: Vec<Vec<String>> = rows
			.iter()
			.map(|row| row.iter().map(|&cell| self.cell(cell, false)).collect())
			.collect();
		if cells.iter().flatten().all(String::is_empty) {
			return;
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

/// Sibling nodes of a range, skipping dropped subtrees.
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

/// Code language from a `language-x`, `lang-x` or `highlight-source-x` class.
fn class_lang(el: &Element) -> Option<&str> {
	el.attr("class")?
		.split_ascii_whitespace()
		.find_map(|class| {
			["language-", "lang-", "highlight-source-"]
				.iter()
				.find_map(|prefix| class.strip_prefix(prefix))
				.filter(|lang| !lang.is_empty() && !lang.contains('`'))
		})
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
			md("<table><tr><th>A</th><th>B</th></tr><tr><td colspan=\"2\">wide \
			    *x*</td></tr><tr><td>1</td><td>22</td></tr></table>"),
			"```\nA  B\n-  --\nwide *x*\n1  22\n```\n",
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
	fn nested_definitions_never_indent_into_code() {
		assert_eq!(
			md("<dl><dt>outer</dt><dd><p>One.</p><dl><dt>inner</dt><dd><p>Two.</p><p>Three.</p></\
			    dd></dl></dd></dl>"),
			"**outer**\n: One.\n\n**inner**\n: Two.\n\nThree.\n",
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
}
