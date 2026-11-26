//! Probe rules for the reader: which secondary URLs stand in for a page, and
//! when a response to one of them is usable.

use std::borrow::Cow;

use url::Url;

use crate::wall::MIN_RENDERED_CHARS;

/// Network read bound for any fetched body.
pub const MAX_BYTES: usize = 50 * 1024 * 1024;
/// `Accept` of a page fetch.
pub const ACCEPT_HTML: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
/// `Accept` of a content-negotiation probe.
pub const ACCEPT_MARKDOWN: &str = "text/markdown, text/plain;q=0.9, text/html;q=0.8";
/// Most llms.txt candidates probed for one page.
const MAX_LLMS_CANDIDATES: usize = 6;
/// Most feed alternates probed for one page.
pub const MAX_FEED_PROBES: usize = 2;
/// Feed items rendered from a feed alternate or a feed response.
pub const FEED_ITEMS: usize = 10;
/// A feed body this short holds no items worth reading.
const MIN_FEED_CHARS: usize = 200;
/// A wrapper page around a document renders to at most this many lines.
const WRAPPER_MAX_LINES: usize = 300;

/// First value of a header, by case-insensitive name.
pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
	headers
		.iter()
		.find(|(key, _)| key.eq_ignore_ascii_case(name))
		.map(|(_, value)| value.as_str())
}

/// Lowercased MIME type without parameters.
pub fn mime(content_type: &str) -> String {
	content_type
		.split(';')
		.next()
		.unwrap_or_default()
		.trim()
		.to_ascii_lowercase()
}

/// True when a body starts like an HTML document rather than Markdown or text,
/// past a byte-order mark and leading comments.
pub fn looks_like_html(content: &str) -> bool {
	let head = without_leading_comments(content.trim_start_matches('\u{feff}')).as_bytes();
	let head = &head[..head.len().min(16)];
	[b"<!doctype".as_slice(), b"<html", b"<head", b"<body"]
		.iter()
		.any(|tag| head.len() >= tag.len() && head[..tag.len()].eq_ignore_ascii_case(tag))
}

/// True for an HTML media type: a probe for Markdown or llms.txt answered with
/// it got the site's app shell or error page, not the file.
pub fn is_html_mime(mime: &str) -> bool {
	matches!(mime, "text/html" | "application/xhtml+xml")
}

/// Text without the HTML comments it opens with: metadata a renderer hides
/// (documentation alternates open with a JSON comment).
fn without_leading_comments(text: &str) -> &str {
	let mut rest = text.trim_start();
	while let Some(comment) = rest.strip_prefix("<!--") {
		let Some(end) = comment.find("-->") else {
			break;
		};
		rest = comment[end + 3..].trim_start();
	}
	rest
}

/// A Markdown source as a reader sees it.
///
/// Drops leading HTML comments, the `{% … %}` tags of a Markdoc document, and
/// the inline HTML wrappers ([`WRAPPER_TAGS`]) that carry no Markdown meaning.
pub fn markdown_body(text: &str) -> Cow<'_, str> {
	let text = without_leading_comments(text);
	let text = if is_markdoc(text) {
		Cow::Owned(strip_markdoc(text))
	} else {
		Cow::Borrowed(text)
	};
	let stripped = strip_wrapper_tags(&text);
	stripped.map_or(text, Cow::Owned)
}

/// HTML elements a Markdown source wraps text in for styling or scripting
/// only: their text reads the same without them. Elements Markdown embeds on
/// purpose (`br`, `details`, `summary`, `sub`, `sup`, `kbd`, tables, images,
/// links) are not listed; custom elements (`devsite-*`) count as wrappers.
const WRAPPER_TAGS: [&str; 24] = [
	"abbr", "article", "aside", "bdi", "bdo", "big", "center", "cite", "data", "dfn", "div",
	"figure", "font", "footer", "header", "ins", "label", "mark", "nav", "section", "small", "span",
	"time", "var",
];

/// The end (exclusive) of a wrapper tag opening at `start` in `line`, or
/// `None` when no wrapper tag starts there.
fn wrapper_tag_end(line: &str, start: usize) -> Option<usize> {
	let bytes = line.as_bytes();
	let mut i = start + 1;
	if bytes.get(i) == Some(&b'/') {
		i += 1;
	}
	let name_start = i;
	if !bytes.get(i).is_some_and(u8::is_ascii_alphabetic) {
		return None;
	}
	while bytes
		.get(i)
		.is_some_and(|&b| b.is_ascii_alphanumeric() || b == b'-')
	{
		i += 1;
	}
	let name = &line[name_start..i];
	// `<https://…>` autolinks and `<T>` placeholders are not tags.
	if !bytes
		.get(i)
		.is_some_and(|&b| b.is_ascii_whitespace() || matches!(b, b'>' | b'/'))
	{
		return None;
	}
	let wrapper = name.contains('-')
		|| WRAPPER_TAGS
			.iter()
			.any(|tag| name.eq_ignore_ascii_case(tag));
	if !wrapper {
		return None;
	}
	let mut quote = None;
	while let Some(&b) = bytes.get(i) {
		match (quote, b) {
			(None, b'"' | b'\'') => quote = Some(b),
			(Some(q), _) if b == q => quote = None,
			(None, b'>') => return Some(i + 1),
			_ => {},
		}
		i += 1;
	}
	None
}

/// Markdown with its wrapper tags removed and their text kept, outside fenced,
/// indented and inline code; a line holding only such tags is dropped. `None`
/// when there is none.
fn strip_wrapper_tags(text: &str) -> Option<String> {
	if !text.contains('<') {
		return None;
	}
	let mut out = String::with_capacity(text.len());
	let mut changed = false;
	for_each_line(text, |line, code| {
		let indented = line.starts_with('\t') || line.starts_with("    ");
		if code || indented || !line.contains('<') {
			out.push_str(line);
			return;
		}
		let bytes = line.as_bytes();
		let mut kept = String::with_capacity(line.len());
		let (mut from, mut i, mut tags) = (0, 0, false);
		while i < bytes.len() {
			match bytes[i] {
				b'`' => {
					let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
					let close = "`".repeat(run);
					i = line[i + run..]
						.find(&close)
						.map_or(bytes.len(), |at| i + run + at + run);
				},
				b'<' => match wrapper_tag_end(line, i) {
					Some(end) => {
						kept.push_str(&line[from..i]);
						from = end;
						i = end;
						tags = true;
					},
					None => i += 1,
				},
				_ => i += 1,
			}
		}
		if !tags {
			out.push_str(line);
			return;
		}
		changed = true;
		kept.push_str(&line[from..]);
		if kept.trim().is_empty() {
			return;
		}
		out.push_str(&kept);
	});
	changed.then_some(out)
}

/// Call `each` with every line of `text` and whether it belongs to a fenced
/// code block (fence lines included).
fn for_each_line(text: &str, mut each: impl FnMut(&str, bool)) {
	let mut fence: Option<(u8, usize)> = None;
	for line in text.split_inclusive('\n') {
		let trimmed = line.trim_start();
		let marker = trimmed
			.as_bytes()
			.first()
			.copied()
			.filter(|&b| matches!(b, b'`' | b'~'));
		let run = marker.map_or(0, |m| trimmed.bytes().take_while(|&b| b == m).count());
		match (fence, marker) {
			(None, Some(m)) if run >= 3 => {
				fence = Some((m, run));
				each(line, true);
			},
			(Some((m, open)), Some(close))
				if close == m && run >= open && trimmed[run..].trim().is_empty() =>
			{
				fence = None;
				each(line, true);
			},
			(Some(_), _) => each(line, true),
			(None, _) => each(line, false),
		}
	}
}

/// Byte offset of the next Markdoc tag (`{% name … %}`, `{% /name %}`, `{%
/// name /%}` or an annotation `{% #id .class key=value %}`) in `line` at or
/// after `from`, outside inline code, and its end.
fn next_markdoc_tag(line: &str, from: usize) -> Option<(usize, usize)> {
	let bytes = line.as_bytes();
	let mut i = from;
	while i < bytes.len() {
		match bytes[i] {
			b'`' => {
				let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
				let close = "`".repeat(run);
				i = line[i + run..]
					.find(&close)
					.map_or(bytes.len(), |at| i + run + at + run);
			},
			b'{' if bytes.get(i + 1) == Some(&b'%') => {
				let end = line[i + 2..].find("%}")? + i + 4;
				let inner = line[i + 2..end - 2].trim();
				let first = inner.trim_start_matches('/').chars().next();
				// Liquid and Jinja tags in prose read the same; the document-level
				// closing-tag check keeps them apart.
				if first.is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '#' | '.')) {
					return Some((i, end));
				}
				i = end;
			},
			_ => i += 1,
		}
	}
	None
}

/// True when Markdown outside code uses Markdoc tags with a `{% /name %}`
/// closing tag or a self-closing `{% name /%}`: Jinja and Liquid write `{%
/// endname %}`, so their tags, often quoted as examples, are kept.
fn is_markdoc(text: &str) -> bool {
	if !text.contains("{%") {
		return false;
	}
	let mut found = false;
	for_each_line(text, |line, code| {
		if found || code {
			return;
		}
		let mut from = 0;
		while let Some((start, end)) = next_markdoc_tag(line, from) {
			let inner = line[start + 2..end - 2].trim();
			if inner.starts_with('/') || inner.ends_with('/') {
				found = true;
				return;
			}
			from = end;
		}
	});
	found
}

/// Markdown with its Markdoc tags removed outside code; a line holding only
/// tags is dropped.
fn strip_markdoc(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for_each_line(text, |line, code| {
		if code {
			out.push_str(line);
			return;
		}
		let mut kept = String::with_capacity(line.len());
		let mut from = 0;
		let mut tags = false;
		while let Some((start, end)) = next_markdoc_tag(line, from) {
			kept.push_str(&line[from..start]);
			from = end;
			tags = true;
		}
		if !tags {
			out.push_str(line);
			return;
		}
		kept.push_str(&line[from..]);
		if kept.trim().is_empty() {
			return;
		}
		let newline = kept.ends_with('\n');
		out.push_str(kept.trim_end());
		if newline {
			out.push('\n');
		}
	});
	out
}

/// Collapse blank-line runs and trim. Never shortens content otherwise.
pub fn finalize(content: &str) -> String {
	let mut out = String::with_capacity(content.len());
	let mut newlines = 0;
	for c in content.trim().chars() {
		if c == '\n' {
			newlines += 1;
			if newlines > 2 {
				continue;
			}
		} else {
			newlines = 0;
		}
		out.push(c);
	}
	out
}

/// Trimmed character count above `min`.
pub fn longer_than(content: &str, min: usize) -> bool {
	content.trim().chars().nth(min).is_some()
}

/// Pretty-print JSON with two-space indentation, keeping key order; `None` when
/// invalid.
pub fn pretty_json(text: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
	serde_json::to_string_pretty(&value).ok()
}

/// Lowercased extension of a file name (`.tar.gz` kept whole), or empty.
fn extname(name: &str) -> String {
	let base = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
	if base.ends_with(".tar.gz") {
		return ".tar.gz".to_owned();
	}
	match base.rfind('.') {
		Some(dot) if dot > 0 => base[dot..].to_owned(),
		_ => String::new(),
	}
}

/// File extension of a payload: the `Content-Disposition` filename when it has
/// one, else the URL path.
pub fn extension_hint(url: &Url, content_disposition: Option<&str>) -> String {
	if let Some(disposition) = content_disposition {
		let lower = disposition.to_ascii_lowercase();
		if let Some(at) = lower.find("filename") {
			let rest = disposition[at + "filename".len()..]
				.trim_start_matches('*')
				.trim_start();
			if let Some(value) = rest.strip_prefix('=') {
				let value = value.trim_start().trim_start_matches(['"', '\'']);
				let end = value.find(['"', '\'', ';', '\n']).unwrap_or(value.len());
				let ext = extname(&value[..end]);
				if !ext.is_empty() {
					return ext;
				}
			}
		}
	}
	extname(url.path())
}

/// llms.txt candidates scoped to the page: its directory and each ancestor
/// directory, nearest first; the site root's well-known files for the homepage.
pub fn llms_candidates(url: &Url) -> Vec<Url> {
	let path = url.path();
	let make = |path: String| {
		let mut candidate = url.clone();
		candidate.set_path(&path);
		candidate.set_query(None);
		candidate.set_fragment(None);
		candidate
	};
	if path == "/" {
		return ["/.well-known/llms.txt", "/llms.txt", "/llms.md"]
			.into_iter()
			.map(|p| make(p.to_owned()))
			.collect();
	}
	let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
	let depth = if path.ends_with('/') {
		segments.len()
	} else {
		segments.len().saturating_sub(1).max(1)
	};
	let mut out = Vec::new();
	for depth in (1..=depth.min(segments.len())).rev() {
		let scope = format!("/{}/", segments[..depth].join("/"));
		out.push(make(format!("{scope}llms.txt")));
		out.push(make(format!("{scope}llms.md")));
		if out.len() >= MAX_LLMS_CANDIDATES {
			break;
		}
	}
	out
}

/// True when Markdown is a site's "not found" page served with a success
/// status.
pub fn is_soft_404(markdown: &str) -> bool {
	let mut lines = markdown.lines().map(str::trim).filter(|l| !l.is_empty());
	let mut title = None;
	if let Some(first) = lines.clone().next()
		&& first == "---"
	{
		lines.next();
		for line in lines.by_ref() {
			if line == "---" {
				break;
			}
			if let Some(value) = line.strip_prefix("title:") {
				title = Some(value.trim().trim_matches(['"', '\'']));
			}
		}
	}
	let heading = lines
		.find(|l| l.starts_with('#'))
		.map(|l| l.trim_start_matches('#').trim());
	[title, heading].into_iter().flatten().any(|text| {
		let lower = text.to_ascii_lowercase();
		lower.starts_with("404")
			|| lower == "not found"
			|| lower.contains("page not found")
			|| lower.contains("page does not exist")
			|| lower.contains("page doesn't exist")
	})
}

/// A markdown alternate or llms.txt body that can stand in for the page.
pub fn usable_markdown(text: &str) -> bool {
	longer_than(text, MIN_RENDERED_CHARS) && !looks_like_html(text) && !is_soft_404(text)
}

/// A feed body worth rendering.
pub fn usable_feed(text: &str) -> bool {
	longer_than(text, MIN_FEED_CHARS)
}

/// True when most lines are short: a wrapper page around a linked document.
pub fn is_mostly_short_lines(content: &str) -> bool {
	let (mut lines, mut short) = (0usize, 0usize);
	for line in content.lines().map(str::trim).filter(|l| !l.is_empty()) {
		lines += 1;
		if line.chars().nth(39).is_none() {
			short += 1;
		}
	}
	lines > 10 && short * 10 > lines * 7
}

/// The linked document a short, short-lined rendering wraps: the first
/// document link the rendering kept.
pub fn wrapped_document<'a>(rendered: &str, links: &'a [Url]) -> Option<&'a Url> {
	if rendered.lines().count() > WRAPPER_MAX_LINES || !is_mostly_short_lines(rendered) {
		return None;
	}
	links.iter().find(|link| rendered.contains(link.as_str()))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn url(s: &str) -> Url {
		Url::parse(s).unwrap()
	}

	#[test]
	fn llms_candidates_scope_to_the_page() {
		let got = |u: &str| {
			llms_candidates(&url(u))
				.iter()
				.map(|u| u.path().to_owned())
				.collect::<Vec<_>>()
		};
		assert_eq!(got("https://x.test/"), ["/.well-known/llms.txt", "/llms.txt", "/llms.md"]);
		assert_eq!(got("https://x.test/docs/api/page?q=1"), [
			"/docs/api/llms.txt",
			"/docs/api/llms.md",
			"/docs/llms.txt",
			"/docs/llms.md"
		]);
		assert_eq!(got("https://x.test/pricing/"), ["/pricing/llms.txt", "/pricing/llms.md"]);
		assert_eq!(got("https://x.test/page"), ["/page/llms.txt", "/page/llms.md"]);
	}

	#[test]
	fn soft_404_markdown() {
		assert!(is_soft_404("---\ntitle: \"Page Not Found\"\n---\n# Releases\n"));
		assert!(is_soft_404("# 404 - Not found\n\nbody"));
		assert!(!is_soft_404("# Handling 404 errors\n\nbody"));
	}

	#[test]
	fn markdoc_tags_are_stripped_outside_code_only() {
		let doc = "<!--\n{\"title\": \"Array\"}\n-->\n\n## Docs  {% id=\"docs\" %}\n\n{% table \
		           %}\n* {% icon name=\"id\" /%}Model code\n{% /table %}\n\n```jinja\n{% if x %}{% \
		           endif %}\n```\n\nUse `{% raw %}` here.\n";
		assert_eq!(
			markdown_body(doc),
			"## Docs\n\n* Model code\n\n```jinja\n{% if x %}{% endif %}\n```\n\nUse `{% raw %}` \
			 here.\n"
		);
		// Jinja quoted in prose has no Markdoc closing tag and stays.
		let jinja = "Write {% for item in items %} and {% endfor %} around the loop.";
		assert_eq!(markdown_body(jinja), jinja);
	}

	#[test]
	fn inline_html_wrappers_are_stripped_keeping_their_text() {
		let doc = "<div class=\"note\">\nSet <var class=\"edit\" translate=\"no\">INPUT_URI</var> to \
		           the <span title='a > b'>bucket</span>.\n</div>\n\n<devsite-selector>Pick \
		           one</devsite-selector>\n\nPress <kbd>Ctrl</kbd>, see x<sup>2</sup><br>and \
		           <https://x.test> for Vec<T>.\n\n<details><summary>More</summary>Hidden</details>\n\n\
		           Use `<span>` in code.\n\n```html\n<div><span>kept</span></div>\n```\n\n    \
		           <span>indented code</span>\n";
		assert_eq!(
			markdown_body(doc),
			"Set INPUT_URI to the bucket.\n\nPick one\n\nPress <kbd>Ctrl</kbd>, see \
			 x<sup>2</sup><br>and <https://x.test> for \
			 Vec<T>.\n\n<details><summary>More</summary>Hidden</details>\n\nUse `<span>` in \
			 code.\n\n```html\n<div><span>kept</span></div>\n```\n\n    <span>indented \
			 code</span>\n"
		);
		assert!(matches!(markdown_body("# Plain\n\nNo tags < here.\n"), Cow::Borrowed(_)));
	}

	#[test]
	fn helpers() {
		assert!(looks_like_html("  <!DOCTYPE html><html>"));
		assert!(looks_like_html("\u{feff}<!-- built --> <!doctype html>"));
		assert!(is_html_mime("text/html") && !is_html_mime("text/markdown"));
		assert!(!looks_like_html("# <html>"));
		assert_eq!(finalize("\n a\n\n\n\nb \n"), "a\n\nb");
		assert_eq!(
			pretty_json(r#"{"b":1,"a":[2]}"#).unwrap(),
			"{\n  \"b\": 1,\n  \"a\": [\n    2\n  ]\n}"
		);
		assert_eq!(extension_hint(&url("https://x.test/f.PDF"), None), ".pdf");
		assert_eq!(
			extension_hint(&url("https://x.test/dl"), Some("attachment; filename=\"Report.tar.gz\"")),
			".tar.gz"
		);
		assert_eq!(extension_hint(&url("https://x.test/"), None), "");
	}
}
