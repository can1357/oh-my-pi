use omp_core::{Str, StrMut};
use smallvec::SmallVec;
use smol_bitmap::SmolBitmap;

use super::{MdTheme, ordinal_marker};
use crate::{
	Icon,
	frame::{Color, Style},
	latex, markup,
	rich::RichSink,
};

const ESCAPABLE: &str = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

#[derive(Clone, Copy)]
enum HtmlList {
	Ordered(u64),
	Unordered,
}

#[derive(Default)]
struct HtmlState {
	lists:         SmallVec<HtmlList, 4>,
	open_items:    SmolBitmap,
	at_line_start: bool,
	has_content:   bool,
}

enum CodeText<'a> {
	Borrowed(&'a str),
	Owned(Str),
}

impl CodeText<'_> {
	fn as_str(&self) -> &str {
		match self {
			Self::Borrowed(text) => text,
			Self::Owned(text) => text.as_str(),
		}
	}
}

fn emit_text(sink: &mut dyn RichSink, style: Style, text: &str) {
	let mut parts = text.split('\n').peekable();
	while let Some(part) = parts.next() {
		sink.run(style, part);
		if parts.peek().is_some() {
			sink.newline();
		}
	}
}

/// Renders one run of inline markdown into a rich-text sink.
pub fn parse_inline(text: &str, theme: &MdTheme, base: Style, sink: &mut dyn RichSink) {
	let mut html = HtmlState { at_line_start: true, ..HtmlState::default() };
	render_range(text, theme, base, &mut html, sink);
}

fn render_range(
	text: &str,
	theme: &MdTheme,
	style: Style,
	html: &mut HtmlState,
	sink: &mut dyn RichSink,
) {
	let mut offset = 0;
	let mut plain_start = 0;
	let mut decoded = String::new();

	while offset < text.len() {
		let tail = &text[offset..];

		if let Some((expr, consumed)) = math_span(tail) {
			flush_plain_marked(&text[plain_start..offset], style, html, sink);
			push_math(expr, style, sink);
			html.has_content = true;
			html.at_line_start = false;
			offset += consumed;
			plain_start = offset;
			continue;
		}

		if let Some(escaped) = escaped_punctuation(tail) {
			flush_plain_marked(&text[plain_start..offset], style, html, sink);
			sink.run(style, escaped);
			html.has_content = true;
			html.at_line_start = false;
			offset += 1 + escaped.len();
			plain_start = offset;
			continue;
		}

		if tail.starts_with('`') {
			if let Some((code, consumed)) = code_span(tail) {
				flush_plain_marked(&text[plain_start..offset], style, html, sink);
				if let Some(rgb) = exact_hex_color(code.as_str(), false) {
					push_swatch(sink, style, rgb, code.as_str());
				} else {
					let code_style = style
						.fg(theme.code.foreground_color())
						.bg(theme.code.background_color());
					emit_text(sink, code_style, code.as_str());
				}
				html.has_content = true;
				html.at_line_start = false;
				offset += consumed;
				plain_start = offset;
				continue;
			}
			// unmatched opener: the whole backtick string stays literal, and
			// its tail must not pair with a shorter closer (CommonMark
			// backtick-string rule)
			offset += byte_run(tail.as_bytes(), 0, b'`');
			continue;
		}

		if (tail.starts_with('[') || tail.starts_with("!["))
			&& let Some(link) = markdown_link(tail)
		{
			flush_plain_marked(&text[plain_start..offset], style, html, sink);
			let link_style = style
				.fg(theme.link.foreground_color())
				.underline()
				.link(link.href);
			let mut label_html = HtmlState { at_line_start: true, ..HtmlState::default() };
			render_range(link.label, theme, link_style, &mut label_html, sink);
			let label_matches = link.label == link.href
				|| link
					.href
					.strip_prefix("mailto:")
					.is_some_and(|href| link.label == href);
			if !label_matches {
				sink.run(style, " ");
				sink.run(style.dim(), "(");
				sink.run(style.dim(), link.href);
				sink.run(style.dim(), ")");
			}
			html.has_content = true;
			html.at_line_start = false;
			offset += link.consumed;
			plain_start = offset;
			continue;
		}

		if tail.starts_with('<') {
			// `<ico:name/>` icon: the charset picks the glyph. Checked before
			// autolinks because `ico:…` also parses as an absolute-URI scheme.
			if let Some((name, consumed)) = markup::ico_tag(tail) {
				flush_plain_marked(&text[plain_start..offset], style, html, sink);
				sink.run(style, theme.charset.icon_named(name).unwrap_or(name));
				html.has_content = true;
				html.at_line_start = false;
				offset += consumed;
				plain_start = offset;
				continue;
			}
			if let Some((label, consumed)) = angle_autolink(tail) {
				flush_plain_marked(&text[plain_start..offset], style, html, sink);
				let target = if label.contains('@') {
					let mut target = StrMut::with_capacity("mailto:".len() + label.len());
					target.push_str("mailto:");
					target.push_str(label);
					CodeText::Owned(target.freeze())
				} else {
					CodeText::Borrowed(label)
				};
				flush_plain(
					label,
					style
						.fg(theme.link.foreground_color())
						.underline()
						.link(target.as_str()),
					sink,
				);
				html.has_content = true;
				html.at_line_start = false;
				offset += consumed;
				plain_start = offset;
				continue;
			}
			if let Some((inner, consumed)) = html_code_span(tail) {
				flush_plain_marked(&text[plain_start..offset], style, html, sink);
				let changed = decode_entities(inner, &mut decoded);
				let code = if changed { decoded.as_str() } else { inner };
				if let Some(rgb) = exact_hex_color(code, false) {
					push_swatch(sink, style, rgb, code);
				} else {
					let code_style = style
						.fg(theme.code.foreground_color())
						.bg(theme.code.background_color());
					emit_text(sink, code_style, code);
				}
				html.has_content = true;
				html.at_line_start = false;
				offset += consumed;
				plain_start = offset;
				continue;
			}
			if let Some(comment_end) = tail
				.strip_prefix("<!--")
				.and_then(|comment| comment.find("-->").map(|end| end + 7))
			{
				flush_plain_marked(&text[plain_start..offset], style, html, sink);
				offset += comment_end;
				plain_start = offset;
				continue;
			}

			if let Some((inner, attrs, consumed)) = html_span(tail) {
				flush_plain_marked(&text[plain_start..offset], style, html, sink);
				render_range(inner, theme, span_style(style, attrs, theme), html, sink);
				offset += consumed;
				plain_start = offset;
				continue;
			}

			if let Some((tag, consumed)) = html_tag(tail) {
				flush_plain_marked(&text[plain_start..offset], style, html, sink);
				render_html_tag(tag, style, theme, html, sink);
				offset += consumed;
				plain_start = offset;
				continue;
			}
		}

		if tail.starts_with("~~")
			&& let Some((inner, consumed)) = strict_strikethrough(tail)
		{
			flush_plain_marked(&text[plain_start..offset], style, html, sink);
			render_range(inner, theme, style.strikethrough(), html, sink);
			offset += consumed;
			plain_start = offset;
			continue;
		}

		if matches!(tail.as_bytes().first(), Some(b'*' | b'_'))
			&& let Some(span) = emphasis_span(text, offset)
		{
			flush_plain_marked(&text[plain_start..offset], style, html, sink);
			let nested_style = match span.strength {
				3 => style
					.fg(theme.strong.foreground_color())
					.bold()
					.fg(theme.emphasis.foreground_color())
					.italic(),
				2 => style.fg(theme.strong.foreground_color()).bold(),
				_ => style.fg(theme.emphasis.foreground_color()).italic(),
			};
			render_range(&text[span.inner_start..span.inner_end], theme, nested_style, html, sink);
			offset = span.consumed_end;
			plain_start = offset;
			continue;
		}

		if let Some(consumed) = bare_autolink_len(text, offset) {
			flush_plain_marked(&text[plain_start..offset], style, html, sink);
			let target = &text[offset..offset + consumed];
			flush_plain(
				target,
				style
					.fg(theme.link.foreground_color())
					.underline()
					.link(target),
				sink,
			);
			html.has_content = true;
			html.at_line_start = false;
			offset += consumed;
			plain_start = offset;
			continue;
		}

		offset += tail.chars().next().map_or(1, char::len_utf8);
	}

	flush_plain_marked(&text[plain_start..], style, html, sink);
}

/// The Markdown math span at `text`'s start — `$$…$$`, `\[…\]`, `\(…\)`,
/// or `$…$` under the anti-currency rule — with its consumed length.
pub fn math_span(text: &str) -> Option<(&str, usize)> {
	latex::math_span(text)
}

fn push_math(expr: &str, style: Style, sink: &mut dyn RichSink) {
	latex::latex_inline(expr, style, sink);
}

fn escaped_punctuation(text: &str) -> Option<&str> {
	let rest = text.strip_prefix('\\')?;
	let ch = rest.chars().next()?;
	ESCAPABLE.contains(ch).then(|| &rest[..ch.len_utf8()])
}

/// Total byte length of the inline code span opening at `text`'s start,
/// both delimiter runs included; `None` when the run is unmatched.
pub(super) fn code_span_len(text: &str) -> Option<usize> {
	code_span(text).map(|(_, consumed)| consumed)
}
fn code_span(text: &str) -> Option<(CodeText<'_>, usize)> {
	let opening = byte_run(text.as_bytes(), 0, b'`');
	let mut cursor = opening;
	while cursor < text.len() {
		let relative = text[cursor..].find('`')?;
		let start = cursor + relative;
		let run = byte_run(text.as_bytes(), start, b'`');
		if run == opening {
			let raw = &text[opening..start];
			return Some((normalize_code_text(raw), start + opening));
		}
		cursor = start + run;
	}
	None
}

fn normalize_code_text(text: &str) -> CodeText<'_> {
	let strip_spaces =
		text.starts_with(' ') && text.ends_with(' ') && text.chars().any(|ch| !ch.is_whitespace());
	if !strip_spaces && !text.contains('\n') && !text.contains('\r') {
		return CodeText::Borrowed(text);
	}
	let inner = if strip_spaces {
		&text[1..text.len() - 1]
	} else {
		text
	};
	let mut normalized = StrMut::with_capacity(inner.len());
	let mut chars = inner.chars().peekable();
	while let Some(ch) = chars.next() {
		match ch {
			'\r' => {
				if chars.peek() == Some(&'\n') {
					chars.next();
				}
				normalized.push(' ');
			},
			'\n' => normalized.push(' '),
			_ => normalized.push(ch),
		}
	}
	CodeText::Owned(normalized.freeze())
}

struct MarkdownLink<'a> {
	label:    &'a str,
	href:     &'a str,
	consumed: usize,
}

fn markdown_link(text: &str) -> Option<MarkdownLink<'_>> {
	let label_open = usize::from(text.starts_with('!')) + 1;
	if text.as_bytes().get(label_open - 1) != Some(&b'[') {
		return None;
	}
	let label_close = matching_bracket(text, label_open, b'[', b']')?;
	if text.as_bytes().get(label_close + 1) != Some(&b'(') {
		return None;
	}
	let destination_open = label_close + 2;
	let destination_close = matching_bracket(text, destination_open, b'(', b')')?;
	let raw_destination = text[destination_open..destination_close].trim();
	let href = link_destination(raw_destination)?;
	Some(MarkdownLink {
		label: &text[label_open..label_close],
		href,
		consumed: destination_close + 1,
	})
}

const fn matching_bracket(text: &str, start: usize, open: u8, close: u8) -> Option<usize> {
	let bytes = text.as_bytes();
	let mut depth = 0_u16;
	let mut offset = start;
	while offset < bytes.len() {
		match bytes[offset] {
			b'\\' => offset = offset.saturating_add(2),
			byte if byte == open => {
				depth = depth.saturating_add(1);
				offset += 1;
			},
			byte if byte == close => {
				if depth == 0 {
					return Some(offset);
				}
				depth -= 1;
				offset += 1;
			},
			_ => offset += 1,
		}
	}
	None
}

fn link_destination(raw: &str) -> Option<&str> {
	if let Some(angle) = raw.strip_prefix('<') {
		let end = angle.find('>')?;
		return Some(&angle[..end]);
	}
	let mut depth = 0_u16;
	for (offset, ch) in raw.char_indices() {
		match ch {
			'(' => depth = depth.saturating_add(1),
			')' if depth > 0 => depth -= 1,
			ch if ch.is_whitespace() && depth == 0 => return Some(&raw[..offset]),
			_ => {},
		}
	}
	(!raw.is_empty()).then_some(raw)
}

fn angle_autolink(text: &str) -> Option<(&str, usize)> {
	let end = text.find('>')?;
	let label = &text[1..end];
	if label.is_empty() || label.chars().any(|ch| ch.is_whitespace() || ch == '<') {
		return None;
	}
	let is_url = ["http://", "https://", "ftp://"]
		.iter()
		.any(|prefix| starts_ascii_case_insensitive(label, prefix));
	let is_email = label.split_once('@').is_some_and(|(local, domain)| {
		!local.is_empty() && !domain.is_empty() && !domain.contains('@')
	});
	(is_url || is_email).then_some((label, end + 1))
}

fn html_code_span(text: &str) -> Option<(&str, usize)> {
	let open_end = html_tag_end(text)?;
	let open = &text[..open_end];
	let tag = parsed_html_tag(open)?;
	if tag.name != "code" || tag.closing || tag.self_closing {
		return None;
	}
	let close_start = find_ascii_case_insensitive(&text[open_end..], "</code>")? + open_end;
	Some((&text[open_end..close_start], close_start + "</code>".len()))
}

fn html_span(text: &str) -> Option<(&str, &str, usize)> {
	let open_end = html_tag_end(text)?;
	let open = parsed_html_tag(&text[..open_end])?;
	if !open.name.eq_ignore_ascii_case("span") || open.closing || open.self_closing {
		return None;
	}
	let attrs = html_attrs(open);
	let mut depth = 1_u32;
	let mut cursor = open_end;
	while let Some(relative) = text[cursor..].find('<') {
		let start = cursor + relative;
		let Some((tag, consumed)) = html_tag(&text[start..]) else {
			cursor = start + 1;
			continue;
		};
		if tag.name.eq_ignore_ascii_case("span") {
			if tag.closing {
				depth -= 1;
				if depth == 0 {
					return Some((&text[open_end..start], attrs, start + consumed));
				}
			} else if !tag.self_closing {
				depth += 1;
			}
		}
		cursor = start + consumed;
	}
	None
}

fn html_attrs(tag: ParsedHtmlTag<'_>) -> &str {
	let inner = tag
		.raw
		.strip_prefix('<')
		.and_then(|raw| raw.strip_suffix('>'))
		.unwrap_or_default()
		.trim();
	let body = inner.strip_prefix('/').unwrap_or(inner).trim_start();
	let attrs = body.get(tag.name.len()..).unwrap_or_default().trim();
	attrs.strip_suffix('/').unwrap_or(attrs).trim()
}

fn span_style(mut style: Style, attrs: &str, theme: &MdTheme) -> Style {
	for (key, value) in (AttrIter { rest: attrs }) {
		if key.eq_ignore_ascii_case("fg") {
			if let Some(color) = value.and_then(|value| span_color(value, theme)) {
				style = style.fg(color);
			}
		} else if key.eq_ignore_ascii_case("bg") || key.eq_ignore_ascii_case("on") {
			if let Some(color) = value.and_then(|value| span_color(value, theme)) {
				style = style.bg(color);
			}
		} else if value.is_none() {
			if key.eq_ignore_ascii_case("bold") {
				style = style.bold();
			} else if key.eq_ignore_ascii_case("dim") {
				style = style.dim();
			} else if key.eq_ignore_ascii_case("italic") {
				style = style.italic();
			} else if key.eq_ignore_ascii_case("underline") {
				style = style.underline();
			} else if key.eq_ignore_ascii_case("strike") {
				style = style.strikethrough();
			} else if key.eq_ignore_ascii_case("reverse") {
				style = style.reverse();
			} else if let Some(color) = theme.semantic_color(key) {
				style = style.fg(color);
			} else if let Some(color) = Color::parse(key) {
				// bare CSS color names color the foreground, like `<span cyan>`
				style = style.fg(color);
			}
		}
	}
	style
}

fn span_color(value: &str, theme: &MdTheme) -> Option<Color> {
	theme.semantic_color(value).or_else(|| Color::parse(value))
}

/// Zero-allocation scanner for HTML-style `key`, `key=value`, and quoted
/// `key="value"` attributes.
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
		let key_end = self.rest.find(|ch: char| ch == '=' || ch.is_whitespace());
		let (key, after) = match key_end {
			Some(end) => (&self.rest[..end], &self.rest[end..]),
			None => (self.rest, ""),
		};
		if let Some(after_eq) = after.strip_prefix('=') {
			for quote in ['"', '\''] {
				if let Some(quoted) = after_eq.strip_prefix(quote) {
					let end = quoted.find(quote).unwrap_or(quoted.len());
					self.rest = quoted.get(end + 1..).unwrap_or_default();
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

struct ParsedHtmlTag<'a> {
	name:         &'a str,
	closing:      bool,
	self_closing: bool,
	raw:          &'a str,
}

fn html_tag(text: &str) -> Option<(ParsedHtmlTag<'_>, usize)> {
	let end = html_tag_end(text)?;
	let raw = &text[..end];
	let tag = parsed_html_tag(raw)?;
	is_recognized_html_tag(tag.name).then_some((tag, end))
}

fn html_tag_end(text: &str) -> Option<usize> {
	let mut quote = None;
	for (offset, ch) in text.char_indices().skip(1) {
		if let Some(expected) = quote {
			if ch == expected {
				quote = None;
			}
		} else if matches!(ch, '\'' | '"') {
			quote = Some(ch);
		} else if ch == '>' {
			return Some(offset + 1);
		}
	}
	None
}

fn parsed_html_tag(raw: &str) -> Option<ParsedHtmlTag<'_>> {
	let inner = raw.strip_prefix('<')?.strip_suffix('>')?;
	let trimmed = inner.trim();
	let (closing, body) = if let Some(body) = trimmed.strip_prefix('/') {
		(true, body.trim_start())
	} else {
		(false, trimmed)
	};
	let name_len = body
		.bytes()
		.take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-'))
		.count();
	if name_len == 0 {
		return None;
	}
	Some(ParsedHtmlTag {
		name: &body[..name_len],
		closing,
		self_closing: body.trim_end().ends_with('/'),
		raw,
	})
}

fn is_recognized_html_tag(name: &str) -> bool {
	["br", "p", "span", "text", "code", "li", "ul", "ol", "blockquote"]
		.iter()
		.any(|known| name.eq_ignore_ascii_case(known))
}

fn render_html_tag(
	tag: ParsedHtmlTag<'_>,
	style: Style,
	theme: &MdTheme,
	state: &mut HtmlState,
	sink: &mut dyn RichSink,
) {
	if tag.name.eq_ignore_ascii_case("span")
		|| tag.name.eq_ignore_ascii_case("text")
		|| tag.name.eq_ignore_ascii_case("code")
	{
		return;
	}
	if tag.name.eq_ignore_ascii_case("br") {
		sink.newline();
		state.at_line_start = true;
		return;
	}
	if tag.name.eq_ignore_ascii_case("p") || tag.name.eq_ignore_ascii_case("blockquote") {
		if tag.closing || (state.has_content && !state.at_line_start) {
			sink.newline();
			state.at_line_start = true;
		}
		return;
	}
	if tag.name.eq_ignore_ascii_case("ol") || tag.name.eq_ignore_ascii_case("ul") {
		if tag.closing {
			state.lists.pop();
			state.open_items.set(state.lists.len(), false);
		} else if !tag.self_closing {
			let list_depth = state.lists.len();
			if list_depth > 0 && state.open_items.get(list_depth - 1) && !state.at_line_start {
				sink.newline();
				state.at_line_start = true;
			}
			if tag.name.eq_ignore_ascii_case("ol") {
				state
					.lists
					.push(HtmlList::Ordered(html_ordered_start(tag.raw)));
			} else {
				state.lists.push(HtmlList::Unordered);
			}
			state.open_items.set(list_depth, false);
		}
		return;
	}
	if tag.name.eq_ignore_ascii_case("li") {
		if tag.closing {
			if !state.at_line_start {
				sink.newline();
			}
			state.at_line_start = true;
			return;
		}
		let list_depth = state.lists.len();
		if list_depth > 0 {
			let item_index = list_depth - 1;
			if state.open_items.get(item_index) && !state.at_line_start {
				sink.newline();
			}
			state.open_items.set(item_index, true);
		} else if state.has_content && !state.at_line_start {
			sink.newline();
		}
		let indent = state.lists.len().saturating_sub(1);
		for _ in 0..indent {
			sink.run(style, "  ");
		}
		if let Some(HtmlList::Ordered(next)) = state.lists.last_mut() {
			let marker = ordinal_marker(*next);
			sink.run(style, marker.as_str());
			*next = next.saturating_add(1);
		} else {
			sink.run(style, theme.charset.icon(Icon::Bullet));
			sink.run(style, " ");
		}
		state.at_line_start = false;
		state.has_content = true;
	}
}

fn html_ordered_start(tag: &str) -> u64 {
	let mut search = tag;
	while let Some(index) = find_ascii_case_insensitive(search, "start") {
		let after_name = &search[index + 5..];
		let after_space = after_name.trim_start();
		let Some(value) = after_space.strip_prefix('=') else {
			search = &after_name[1.min(after_name.len())..];
			continue;
		};
		let value = value.trim_start();
		let value = if let Some(inner) = value.strip_prefix('\'').or_else(|| value.strip_prefix('"'))
		{
			let end = inner
				.find('\'')
				.or_else(|| inner.find('"'))
				.unwrap_or(inner.len());
			&inner[..end]
		} else {
			let end = value.bytes().take_while(u8::is_ascii_digit).count();
			&value[..end]
		};
		return value.parse().unwrap_or(1);
	}
	1
}

fn strict_strikethrough(text: &str) -> Option<(&str, usize)> {
	let rest = text.strip_prefix("~~")?;
	let first = rest.chars().next()?;
	if first.is_whitespace() || first == '~' {
		return None;
	}
	let mut offset = 0;
	while offset < rest.len() {
		let relative = rest[offset..].find("~~")?;
		let end = offset + relative;
		let after = end + 2;
		if rest.as_bytes().get(after) != Some(&b'~') {
			let inner = &rest[..end];
			if valid_strike_content(inner) {
				return Some((inner, end + 4));
			}
		}
		offset = end + 1;
	}
	None
}

fn valid_strike_content(text: &str) -> bool {
	if text.is_empty() {
		return false;
	}
	let mut chars = text.char_indices();
	let mut last_atom_escaped = false;
	let mut last_char = None;
	while let Some((_, ch)) = chars.next() {
		if ch == '\\' {
			let Some((_, escaped)) = chars.next() else {
				return false;
			};
			if matches!(escaped, '\n' | '\r') {
				return false;
			}
			last_atom_escaped = true;
			last_char = Some(escaped);
		} else {
			last_atom_escaped = false;
			last_char = Some(ch);
		}
	}
	last_atom_escaped || last_char.is_some_and(|ch| !ch.is_whitespace() && ch != '~' && ch != '\\')
}

struct EmphasisSpan {
	inner_start:  usize,
	inner_end:    usize,
	consumed_end: usize,
	strength:     usize,
}

fn emphasis_span(text: &str, start: usize) -> Option<EmphasisSpan> {
	let marker = *text.as_bytes().get(start)?;
	let run = byte_run(text.as_bytes(), start, marker);
	let (_, can_open) = delimiter_flanking(text, start, run, marker);
	if !can_open {
		return None;
	}
	let strengths = if run.is_multiple_of(2) {
		[2, 3, 1]
	} else {
		[3, 2, 1]
	};
	for strength in strengths {
		if run < strength {
			continue;
		}
		if let Some((inner_end, consumed_end)) =
			emphasis_close(text, start + strength, marker, strength)
		{
			if inner_end <= start + strength {
				continue;
			}
			let leftover = run - strength;
			if leftover > 0 {
				let inner = &text[start + strength..inner_end];
				if emphasis_span(inner, 0).is_none_or(|nested| nested.strength != leftover) {
					continue;
				}
			}
			return Some(EmphasisSpan {
				inner_start: start + strength,
				inner_end,
				consumed_end,
				strength,
			});
		}
	}
	None
}

fn emphasis_close(
	text: &str,
	mut offset: usize,
	marker: u8,
	strength: usize,
) -> Option<(usize, usize)> {
	while offset < text.len() {
		let marker_offset = text[offset..].bytes().position(|byte| byte == marker)?;
		let run_start = offset + marker_offset;
		if let Some(code_offset) = text[offset..run_start].find('`') {
			let code_start = offset + code_offset;
			if let Some((_, consumed)) = code_span(&text[code_start..]) {
				offset = code_start + consumed;
				continue;
			}
		}
		if preceded_by_odd_backslashes(text, run_start) {
			offset = run_start + 1;
			continue;
		}
		let run = byte_run(text.as_bytes(), run_start, marker);
		let (can_close, _) = delimiter_flanking(text, run_start, run, marker);
		let compatible = run >= strength && (strength != 1 || run % 2 == 1);
		if can_close && compatible {
			let close_start = run_start + run - strength;
			return Some((close_start, close_start + strength));
		}
		offset = run_start + run;
	}
	None
}

fn preceded_by_odd_backslashes(text: &str, offset: usize) -> bool {
	text.as_bytes()[..offset]
		.iter()
		.rev()
		.take_while(|byte| **byte == b'\\')
		.count()
		% 2 == 1
}

fn delimiter_flanking(text: &str, start: usize, run: usize, marker: u8) -> (bool, bool) {
	let previous = text[..start].chars().next_back();
	let next = text[start + run..].chars().next();
	let previous_whitespace = previous.is_none_or(char::is_whitespace);
	let next_whitespace = next.is_none_or(char::is_whitespace);
	let previous_punctuation = previous.is_some_and(is_punctuation);
	let next_punctuation = next.is_some_and(is_punctuation);
	let left_flanking =
		!next_whitespace && (!next_punctuation || previous_whitespace || previous_punctuation);
	let right_flanking =
		!previous_whitespace && (!previous_punctuation || next_whitespace || next_punctuation);
	if marker == b'_' {
		(
			right_flanking && (!left_flanking || next_punctuation),
			left_flanking && (!right_flanking || previous_punctuation),
		)
	} else {
		(right_flanking, left_flanking)
	}
}

fn is_punctuation(ch: char) -> bool {
	ch.is_ascii_punctuation() || (!ch.is_alphanumeric() && !ch.is_whitespace())
}

fn bare_autolink_len(text: &str, start: usize) -> Option<usize> {
	if let Some(length) = bare_scheme_autolink_len(text, start) {
		return Some(length);
	}
	bare_email_autolink_len(text, start)
}

fn bare_scheme_autolink_len(text: &str, start: usize) -> Option<usize> {
	let tail = &text[start..];
	let scheme_len = if starts_ascii_case_insensitive(tail, "www.") {
		4
	} else if starts_ascii_case_insensitive(tail, "https://") {
		8
	} else if starts_ascii_case_insensitive(tail, "http://") {
		7
	} else if starts_ascii_case_insensitive(tail, "ftp://") {
		6
	} else {
		return None;
	};
	let boundary = text[..start].chars().next_back();
	if boundary.is_some_and(|ch| !ch.is_whitespace() && !matches!(ch, '*' | '_' | '~' | '(')) {
		return None;
	}
	let mut end = tail.len();
	for (offset, ch) in tail.char_indices().skip(1) {
		if ch.is_whitespace() || ch == '<' || ch.is_control() {
			end = offset;
			break;
		}
	}
	end = trim_autolink_end(&tail[..end]);
	(end > scheme_len).then_some(end)
}

fn trim_autolink_end(candidate: &str) -> usize {
	let mut end = candidate.len();
	while let Some(ch) = candidate[..end].chars().next_back() {
		if matches!(ch, '?' | '!' | '.' | ',' | ':' | ';') {
			end -= ch.len_utf8();
		} else {
			break;
		}
	}
	loop {
		let value = &candidate[..end];
		if !value.ends_with(')') {
			break;
		}
		let opens = value.bytes().filter(|byte| *byte == b'(').count();
		let closes = value.bytes().filter(|byte| *byte == b')').count();
		if closes <= opens {
			break;
		}
		end -= 1;
	}
	end
}

fn bare_email_autolink_len(text: &str, start: usize) -> Option<usize> {
	let first = text[start..].chars().next()?;
	if !first.is_ascii_alphanumeric() {
		return None;
	}
	if text[..start]
		.chars()
		.next_back()
		.is_some_and(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '+' | '-'))
	{
		return None;
	}
	let tail = &text[start..];
	let mut end = tail.len();
	for (offset, ch) in tail.char_indices() {
		if ch.is_whitespace() || matches!(ch, '<' | '>' | '(' | ')' | '[' | ']') {
			end = offset;
			break;
		}
	}
	while tail[..end]
		.chars()
		.next_back()
		.is_some_and(|ch| matches!(ch, '.' | ',' | ':' | ';' | '!' | '?'))
	{
		end -= 1;
	}
	valid_email(&tail[..end]).then_some(end)
}

fn valid_email(text: &str) -> bool {
	let Some((local, domain)) = text.split_once('@') else {
		return false;
	};
	if local.is_empty()
		|| domain.is_empty()
		|| local
			.bytes()
			.any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-')))
		|| domain
			.bytes()
			.any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
	{
		return false;
	}
	let Some((_, suffix)) = domain.rsplit_once('.') else {
		return false;
	};
	!suffix.is_empty()
}

fn flush_plain_marked(text: &str, style: Style, html: &mut HtmlState, sink: &mut dyn RichSink) {
	flush_plain(text, style, sink);
	if !text.trim().is_empty() {
		html.has_content = true;
	}
	if !text.is_empty() {
		html.at_line_start = text.ends_with('\n');
	}
}

fn flush_plain(text: &str, style: Style, sink: &mut dyn RichSink) {
	let mut offset = 0;
	let mut literal_start = 0;
	while offset < text.len() {
		let tail = &text[offset..];
		if tail.starts_with('&')
			&& let Some((entity, consumed)) = decoded_entity(tail)
		{
			emit_text(sink, style, &text[literal_start..offset]);
			match entity {
				DecodedEntity::Text(value) => sink.run(style, value),
				DecodedEntity::Char(value) => {
					let mut encoded = [0_u8; 4];
					sink.run(style, value.encode_utf8(&mut encoded));
				},
				DecodedEntity::Empty => {},
			}
			offset += consumed;
			literal_start = offset;
			continue;
		}
		if tail.starts_with('#')
			&& let Some((consumed, rgb)) = prose_hex_color(text, offset)
		{
			emit_text(sink, style, &text[literal_start..offset]);
			push_swatch(sink, style, rgb, &text[offset..offset + consumed]);
			offset += consumed;
			literal_start = offset;
			continue;
		}
		offset += tail.chars().next().map_or(1, char::len_utf8);
	}
	emit_text(sink, style, &text[literal_start..]);
}

enum DecodedEntity {
	Text(&'static str),
	Char(char),
	Empty,
}
fn decoded_entity(text: &str) -> Option<(DecodedEntity, usize)> {
	let end = text.find(';')?;
	let body = &text[1..end];
	let entity = if body.eq_ignore_ascii_case("amp") {
		DecodedEntity::Text("&")
	} else if body.eq_ignore_ascii_case("lt") {
		DecodedEntity::Text("<")
	} else if body.eq_ignore_ascii_case("gt") {
		DecodedEntity::Text(">")
	} else if body.eq_ignore_ascii_case("quot") {
		DecodedEntity::Text("\"")
	} else if body.eq_ignore_ascii_case("apos") {
		DecodedEntity::Text("'")
	} else if body.eq_ignore_ascii_case("nbsp") {
		// Decode to a plain space; the run survives because prose whitespace
		// is never collapsed.
		DecodedEntity::Text(" ")
	} else if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
		if hex.is_empty() || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
			return None;
		}
		match u32::from_str_radix(hex, 16).ok().and_then(char::from_u32) {
			Some(value) => DecodedEntity::Char(value),
			None => DecodedEntity::Empty,
		}
	} else {
		let decimal = body.strip_prefix('#')?;
		if decimal.is_empty() || !decimal.bytes().all(|byte| byte.is_ascii_digit()) {
			return None;
		}
		match decimal.parse::<u32>().ok().and_then(char::from_u32) {
			Some(value) => DecodedEntity::Char(value),
			None => DecodedEntity::Empty,
		}
	};
	Some((entity, end + 1))
}

fn decode_entities(text: &str, output: &mut String) -> bool {
	let Some(first) = text.char_indices().find_map(|(offset, ch)| {
		(ch == '&' && decoded_entity(&text[offset..]).is_some()).then_some(offset)
	}) else {
		return false;
	};
	output.clear();
	output.push_str(&text[..first]);
	let mut offset = first;
	while offset < text.len() {
		if text.as_bytes()[offset] == b'&'
			&& let Some((entity, consumed)) = decoded_entity(&text[offset..])
		{
			match entity {
				DecodedEntity::Text(value) => output.push_str(value),
				DecodedEntity::Char(value) => output.push(value),
				DecodedEntity::Empty => {},
			}
			offset += consumed;
			continue;
		}
		let ch = text[offset..].chars().next().unwrap_or_default();
		output.push(ch);
		offset += ch.len_utf8();
	}
	true
}

fn prose_hex_color(text: &str, offset: usize) -> Option<(usize, Color)> {
	if text[..offset]
		.chars()
		.next_back()
		.is_some_and(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '#' | '&'))
	{
		return None;
	}
	let tail = text[offset..].strip_prefix('#')?;
	if is_uuid_prefix(tail) {
		return None;
	}
	let digits = tail.bytes().take_while(u8::is_ascii_hexdigit).count();
	if tail
		.as_bytes()
		.get(digits)
		.is_some_and(u8::is_ascii_hexdigit)
	{
		return None;
	}
	let hex = &tail[..digits];
	let rgb = classify_hex_color(hex, true)?;
	Some((digits + 1, rgb))
}

fn exact_hex_color(text: &str, strict: bool) -> Option<Color> {
	let value = text.trim();
	let hex = value.strip_prefix('#')?;
	if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
		return None;
	}
	classify_hex_color(hex, strict)
}

fn classify_hex_color(hex: &str, strict: bool) -> Option<Color> {
	if !matches!(hex.len(), 3 | 6 | 8)
		|| strict
			&& hex.len() == 3
			&& !hex
				.bytes()
				.any(|byte| matches!(byte, b'a'..=b'f' | b'A'..=b'F'))
	{
		return None;
	}
	let (red, green, blue) = if hex.len() == 3 {
		let mut digits = hex.bytes().map(hex_nibble);
		let red = digits.next()??;
		let green = digits.next()??;
		let blue = digits.next()??;
		(red * 17, green * 17, blue * 17)
	} else {
		(
			u8::from_str_radix(&hex[0..2], 16).ok()?,
			u8::from_str_radix(&hex[2..4], 16).ok()?,
			u8::from_str_radix(&hex[4..6], 16).ok()?,
		)
	};
	Some(Color::Rgb(red, green, blue))
}

const fn hex_nibble(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

fn is_uuid_prefix(text: &str) -> bool {
	const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
	let bytes = text.as_bytes();
	let mut offset = 0;
	for (index, length) in GROUPS.into_iter().enumerate() {
		if bytes
			.get(offset..offset + length)
			.is_none_or(|group| !group.iter().all(u8::is_ascii_hexdigit))
		{
			return false;
		}
		offset += length;
		if index + 1 < GROUPS.len() {
			if bytes.get(offset) != Some(&b'-') {
				return false;
			}
			offset += 1;
		}
	}
	true
}

fn push_swatch(sink: &mut dyn RichSink, style: Style, color: Color, token: &str) {
	let contrast = match color {
		Color::Rgb(red, green, blue)
			if u32::from(red) * 299 + u32::from(green) * 587 + u32::from(blue) * 114 >= 128_000 =>
		{
			Color::Rgb(0, 0, 0)
		},
		Color::Rgb(..) => Color::Rgb(255, 255, 255),
		_ => style.foreground_color(),
	};
	sink.run(style.fg(color), "■");
	sink.run(style, " ");
	sink.run(style.fg(contrast).bg(color), token);
}

fn byte_run(bytes: &[u8], start: usize, byte: u8) -> usize {
	bytes[start..]
		.iter()
		.take_while(|value| **value == byte)
		.count()
}

fn starts_ascii_case_insensitive(text: &str, prefix: &str) -> bool {
	text
		.get(..prefix.len())
		.is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn find_ascii_case_insensitive(text: &str, needle: &str) -> Option<usize> {
	if needle.is_empty() {
		return Some(0);
	}
	text
		.as_bytes()
		.windows(needle.len())
		.position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{frame::with_link_url, rich::RichText};

	fn theme() -> MdTheme {
		MdTheme {
			base: Style::new().fg(Color::Indexed(7)),
			heading: Style::new().fg(Color::Indexed(6)),
			strong: Style::new().fg(Color::Indexed(1)).bold(),
			emphasis: Style::new().fg(Color::Indexed(2)).italic(),
			code: Style::new().fg(Color::Indexed(3)),
			code_block: Style::new().fg(Color::Indexed(3)).dim(),
			code_border: Style::new().fg(Color::Indexed(3)).dim(),
			quote: Style::new().fg(Color::Indexed(4)).italic(),
			bullet: Style::new().fg(Color::Indexed(5)),
			link: Style::new().fg(Color::Indexed(6)).underline(),
			rule: Style::new().dim(),
			..MdTheme::default()
		}
	}

	fn render(text: &str) -> RichText {
		let mut output = RichText::default();
		parse_inline(text, &theme(), theme().base, &mut output);
		output
	}

	fn plain(text: &str) -> String {
		render(text).row_text(0).to_owned()
	}

	fn first_style(text: &RichText) -> Style {
		text.row_runs(0).next().expect("rendered run").0
	}
	fn link_url(style: Style) -> Option<String> {
		style.link.and_then(|id| with_link_url(id, str::to_owned))
	}

	#[test]
	fn backslash_escapes_markdown_punctuation() {
		assert_eq!(plain(r"\*literal\* and \$5"), "*literal* and $5");
		assert_eq!(plain(r"\a"), r"\a");
	}

	#[test]
	fn nested_emphasis_composes_styles() {
		let line = render("***both*** and **bold _italic_**");
		assert_eq!(line.row_text(0), "both and bold italic");
		assert_eq!(first_style(&line), Style::new().fg(Color::Indexed(2)).bold().italic());
		assert!(line.row_runs(0).any(|(style, text)| {
			text == "italic" && style == Style::new().fg(Color::Indexed(2)).bold().italic()
		}));
	}

	#[test]
	fn html_span_attributes_compose_with_inline_markdown() {
		let line = render("**a <span err bold>b</span>**");
		assert_eq!(line.row_text(0), "a b");
		let (style, _) = line
			.row_runs(0)
			.find(|(_, text)| *text == "b")
			.expect("styled span body");
		assert_eq!(style, Style::new().fg(crate::Theme::default().err).bold());

		let nested = render("<span accent>plain **strong**</span>");
		assert_eq!(nested.row_text(0), "plain strong");
		assert!(nested.row_runs(0).any(|(style, text)| {
			text == "strong" && style == Style::new().fg(theme().strong.foreground_color()).bold()
		}));
	}

	#[test]
	fn html_span_supports_background_css_colors_and_unknown_attributes() {
		let line = render("<span on=accent fg=black mystery=ignored>x</span>");
		assert_eq!(line.row_text(0), "x");
		assert_eq!(
			first_style(&line),
			Style::new()
				.fg(Color::Rgb(0, 0, 0))
				.bg(crate::Theme::default().accent)
		);

		let nested = render("<span fg=red><span bold>z</span></span>");
		assert_eq!(nested.row_text(0), "z");
		assert_eq!(first_style(&nested), Style::new().fg(Color::Rgb(0xff, 0, 0)).bold());

		let hex = render("<span fg=#f00>h</span>");
		assert_eq!(first_style(&hex), theme().base.fg(Color::Rgb(0xff, 0, 0)));

		let flags = render("<span dim italic underline strike reverse>y</span>");
		assert_eq!(
			first_style(&flags),
			theme()
				.base
				.dim()
				.italic()
				.underline()
				.strikethrough()
				.reverse()
		);
	}

	#[test]
	fn intraword_underscores_stay_literal() {
		assert_eq!(plain("allowed_openai_params"), "allowed_openai_params");
		assert!(
			render("allowed_openai_params")
				.row_runs(0)
				.all(|(style, _)| style == theme().base)
		);
	}

	#[test]
	fn strict_strikethrough_accepts_only_closed_non_space_runs() {
		let accepted = render("~~valid~~");
		assert_eq!(accepted.row_text(0), "valid");
		assert!(
			accepted
				.row_runs(0)
				.all(|(style, _)| style == theme().base.strikethrough())
		);
		let escaped = render(r"~~a\*b~~");
		assert_eq!(escaped.row_text(0), "a*b");
		assert!(
			escaped
				.row_runs(0)
				.all(|(style, _)| style == theme().base.strikethrough())
		);
		for rejected in ["~~ space~~", "~~space ~~", "~~~~", "~~x~~~"] {
			assert_eq!(plain(rejected), rejected);
		}
		// no strikethrough, but the escape itself still resolves (marked's
		// escape tokenizer runs on the literal text)
		let escaped_close = render(r"~~x\~~");
		assert_eq!(escaped_close.row_text(0), "~~x~~");
		assert!(
			escaped_close
				.row_runs(0)
				.all(|(style, _)| style == theme().base)
		);
	}

	#[test]
	fn code_spans_match_delimiter_runs_and_strip_one_space() {
		let line = render("` code ` and ``a ` b``");
		assert_eq!(line.row_text(0), "code and a ` b");
		assert_eq!(first_style(&line), theme().code);
		assert_eq!(plain("``unclosed`"), "``unclosed`");
	}

	#[test]
	fn links_autolinks_and_boundaries_match_visible_output() {
		let explicit = render("[docs](https://example.com)");
		assert_eq!(explicit.row_text(0), "docs (https://example.com)");
		let label_style = explicit
			.row_runs(0)
			.find_map(|(style, text)| (text == "docs").then_some(style))
			.expect("link label run");
		assert_eq!(link_url(label_style).as_deref(), Some("https://example.com"));
		assert!(
			explicit
				.row_runs(0)
				.filter(|(_, text)| *text != "docs")
				.all(|(style, _)| style.link.is_none())
		);
		assert_eq!(plain("[https://x](https://x)"), "https://x");
		assert_eq!(plain("![diagram](image.png)"), "diagram (image.png)");
		assert_eq!(plain("https://example.com."), "https://example.com.");
		let linked = render("https://example.com.");
		assert_eq!(
			first_style(&linked),
			theme()
				.base
				.fg(theme().link.foreground_color())
				.underline()
				.link("https://example.com")
		);
		assert_eq!(linked.row_runs(0).last().expect("punctuation").0, theme().base);
		let blocked = render("foohttp://bar.com/x");
		assert!(blocked.row_runs(0).all(|(style, _)| style == theme().base));
		assert_eq!(plain("<http://x>"), "http://x");
		assert_eq!(link_url(first_style(&render("<http://x>"))).as_deref(), Some("http://x"));
		assert_eq!(link_url(first_style(&render("<a@b.com>"))).as_deref(), Some("mailto:a@b.com"));
	}

	#[test]
	fn mailto_comparison_omits_only_equivalent_destinations() {
		assert_eq!(plain("[a@b.com](mailto:a@b.com)"), "a@b.com");
		assert_eq!(
			plain("[Email me](mailto:test@example.com)"),
			"Email me (mailto:test@example.com)"
		);
	}

	#[test]
	fn math_respects_currency_heuristic_and_paren_delimiters() {
		assert_eq!(plain("$5 and $10"), "$5 and $10");
		assert_eq!(plain("$x^2$"), "x²");
		assert_eq!(plain(r"\(x^2\)"), "x²");
		assert_eq!(plain(r"\$x$"), "$x$");
		assert_eq!(math_span(r"\(x \\) y\) end"), Some((r"x \\) y", 11)));
		assert_eq!(math_span(r"$$a \$$ b$$"), Some((r"a \$$ b", 11)));
	}

	#[test]
	fn prose_and_codespan_hex_swatches_follow_strictness_rules() {
		let prose = render("#C5FFD6 #fff");
		assert_eq!(prose.row_text(0), "■ #C5FFD6 ■ #fff");
		assert_eq!(first_style(&prose), theme().base.fg(Color::Rgb(0xc5, 0xff, 0xd6)));
		assert!(prose.row_runs(0).any(|(style, text)| {
			text == "#C5FFD6"
				&& style
					== theme()
						.base
						.fg(Color::Rgb(0, 0, 0))
						.bg(Color::Rgb(0xc5, 0xff, 0xd6))
		}));
		let dark = render("#000080");
		assert!(dark.row_runs(0).any(|(style, text)| {
			text == "#000080"
				&& style
					== theme()
						.base
						.fg(Color::Rgb(255, 255, 255))
						.bg(Color::Rgb(0, 0, 0x80))
		}));
		let line_background = Color::Rgb(9, 8, 7);
		let mut painted_theme = theme();
		painted_theme.base = painted_theme.base.bg(line_background);
		let mut painted = RichText::default();
		parse_inline("before #C5FFD6 after", &painted_theme, painted_theme.base, &mut painted);
		let after = painted
			.row_runs(0)
			.find(|(_, text)| text.ends_with(" after"))
			.expect("trailing prose");
		assert_eq!(after.0.background_color(), line_background);
		assert_eq!(plain("#123 #6C5E"), "#123 #6C5E");
		assert_eq!(plain("`#123`"), "■ #123");
		assert_eq!(
			plain("#6635765d-4a44-4a5e-a536-a8b72b0395b5"),
			"#6635765d-4a44-4a5e-a536-a8b72b0395b5"
		);
	}

	#[test]
	fn entities_decode_and_code_html_collapses() {
		assert_eq!(plain("&lt;x&gt; &amp; &#x41;"), "<x> & A");
		let line = render("before <code>&lt;x&gt;</code> after");
		assert_eq!(line.row_text(0), "before <x> after");
		assert!(
			line
				.row_runs(0)
				.any(|(style, text)| text == "<x>" && style == theme().code)
		);
	}
}
