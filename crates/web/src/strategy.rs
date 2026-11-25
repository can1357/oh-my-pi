//! Probe rules for the reader: which secondary URLs stand in for a page, and
//! when a response to one of them is usable.

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

/// True when a body starts like an HTML document rather than Markdown or text.
pub fn looks_like_html(content: &str) -> bool {
	let head = content.trim_start().as_bytes();
	let head = &head[..head.len().min(16)];
	[b"<!doctype".as_slice(), b"<html", b"<head", b"<body"]
		.iter()
		.any(|tag| head.len() >= tag.len() && head[..tag.len()].eq_ignore_ascii_case(tag))
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
	fn helpers() {
		assert!(looks_like_html("  <!DOCTYPE html><html>"));
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
