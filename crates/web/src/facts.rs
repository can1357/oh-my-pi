//! Page facts gathered in one pass over the document arena: head metadata,
//! alternate representations, refresh redirects, structured data and text
//! statistics the judge and the reader decide on.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use url::Url;

use crate::dom::{Element, Node};

/// Extensions of documents a wrapper page links to that the converters read.
const DOCUMENT_EXTENSIONS: [&str; 5] = [".pdf", ".docx", ".pptx", ".xlsx", ".epub"];
/// Most linked documents kept, in document order.
const MAX_DOCUMENT_LINKS: usize = 20;

/// Kind of alternate representation a page advertises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlternateKind {
	/// A Markdown rendering of the page (`type` mentions `markdown`).
	Markdown,
	/// An RSS or Atom feed scoped to the page.
	Feed,
}

/// A page-specific `<link rel="alternate">`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alternate {
	/// What the alternate holds.
	pub kind: AlternateKind,
	/// Absolute target.
	pub href: Url,
}

/// A `Refresh` redirect from a header or `<meta http-equiv="refresh">`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refresh {
	/// Seconds the page asks to wait before leaving.
	pub delay_secs: u32,
	/// Absolute target.
	pub url:        Url,
}

/// Everything the reader and the judge learn about a page without rendering it.
#[derive(Debug, Clone, Default)]
pub struct Facts {
	/// `<title>` text, else `og:title`, whitespace collapsed.
	pub title:          Option<String>,
	/// Resolved `<base href>`.
	pub base:           Option<Url>,
	/// Resolved `<link rel="canonical">`.
	pub canonical:      Option<Url>,
	/// Meta description, else Open Graph or Twitter description.
	pub description:    Option<String>,
	/// Meta author, else the first JSON-LD author name.
	pub author:         Option<String>,
	/// Publication date as written by the page.
	pub published:      Option<String>,
	/// `og:type`.
	pub og_type:        Option<String>,
	/// Page-specific Markdown and feed alternates, site-wide and comment feeds
	/// excluded.
	pub alternates:     Vec<Alternate>,
	/// Meta refresh redirect to another URL.
	pub refresh:        Option<Refresh>,
	/// Parsed `application/ld+json` blocks, as written.
	pub json_ld:        Vec<serde_json::Value>,
	/// Parsed application state: JSON data scripts (`__NEXT_DATA__`) and
	/// `window.__STATE__ = {…}` style assignments.
	pub state_blobs:    Vec<serde_json::Value>,
	/// Linked PDF and office documents (deduplicated, at most 20).
	pub document_links: Vec<Url>,
	/// Non-whitespace characters of visible text (outside script, style,
	/// template, noscript, svg and the title).
	pub text_chars:     usize,
	/// The part of `text_chars` inside links.
	pub link_chars:     usize,
	/// Bytes of inline script text.
	pub script_bytes:   usize,
}

/// Raw hrefs and meta values held until the document base is known.
#[derive(Default)]
struct Pending<'a> {
	base:          Option<&'a str>,
	canonical:     Option<&'a str>,
	alternates:    Vec<(&'a str, String)>,
	documents:     Vec<&'a str>,
	refresh:       Option<&'a str>,
	og_title:      Option<&'a str>,
	fallback_desc: Option<&'a str>,
}

/// Gather page facts in one pass over `nodes`. Relative URLs resolve against
/// `<base href>` when present, else `page_url`.
pub fn collect(nodes: &[Node], page_url: &Url) -> Facts {
	let mut facts = Facts::default();
	let mut pending = Pending::default();
	// End indices of open `<a>` elements.
	let mut links: Vec<usize> = Vec::new();
	let mut i = 0;
	while i < nodes.len() {
		while links.last().is_some_and(|&end| end <= i) {
			links.pop();
		}
		let tag = match &nodes[i] {
			Node::Text(text) => {
				let visible = text.chars().filter(|c| !c.is_whitespace()).count();
				facts.text_chars += visible;
				if !links.is_empty() {
					facts.link_chars += visible;
				}
				i += 1;
				continue;
			},
			Node::Tag(tag) => tag,
		};
		match tag.name() {
			"script" => {
				let body = text_of(nodes, tag);
				facts.script_bytes += body.len();
				script(&mut facts, tag, &body);
				i = tag.children.end;
				continue;
			},
			"title" => {
				if facts.title.is_none() {
					facts.title = collapse(&text_of(nodes, tag));
				}
				i = tag.children.end;
				continue;
			},
			"style" | "template" | "noscript" | "svg" => {
				i = tag.children.end;
				continue;
			},
			"base" => {
				if pending.base.is_none() {
					pending.base = tag.attr("href").map(str::trim).filter(|s| !s.is_empty());
				}
			},
			"link" => link(&mut pending, tag),
			"meta" => meta(&mut facts, &mut pending, tag),
			"a" => {
				if let Some(href) = tag.attr("href").map(str::trim).filter(|s| !s.is_empty())
					&& has_document_extension(href)
				{
					pending.documents.push(href);
				}
				links.push(tag.children.end);
			},
			_ => {},
		}
		i += 1;
	}
	resolve(&mut facts, pending, page_url);
	facts
}

/// Parse a `Refresh` header or meta refresh value (`5; url=/next`).
/// Returns `None` without a target: a bare delay only reloads the page.
pub fn parse_refresh(value: &str, base: &Url) -> Option<Refresh> {
	let value = value.trim_start();
	let digits = value
		.find(|c: char| !c.is_ascii_digit())
		.unwrap_or(value.len());
	let rest = value[digits..].trim_start_matches(|c: char| c.is_ascii_digit() || c == '.');
	if digits == 0 && rest.len() == value.len() {
		return None;
	}
	let delay_secs = if digits == 0 {
		0
	} else {
		value[..digits].parse().unwrap_or(u32::MAX)
	};
	let mut rest = rest.trim_start();
	rest = rest.strip_prefix([';', ',']).unwrap_or(rest).trim_start();
	if rest
		.get(..3)
		.is_some_and(|key| key.eq_ignore_ascii_case("url"))
		&& let Some(target) = rest[3..].trim_start().strip_prefix('=')
	{
		rest = target.trim_start();
	}
	let target = match rest.chars().next() {
		Some(quote @ ('"' | '\'')) => {
			let inner = &rest[1..];
			inner.find(quote).map_or(inner, |end| &inner[..end])
		},
		_ => rest,
	}
	.trim();
	if target.is_empty() {
		return None;
	}
	Some(Refresh { delay_secs, url: base.join(target).ok()? })
}

fn text_of(nodes: &[Node], tag: &Element) -> String {
	let mut out = String::new();
	for node in &nodes[tag.children.clone()] {
		if let Node::Text(text) = node {
			out.push_str(text);
		}
	}
	out
}

fn collapse(text: &str) -> Option<String> {
	let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
	(!collapsed.is_empty()).then_some(collapsed)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
	value.map(str::trim).filter(|s| !s.is_empty())
}

fn link<'a>(pending: &mut Pending<'a>, tag: &'a Element) {
	let Some(href) = nonempty(tag.attr("href")) else {
		return;
	};
	let rel = tag.attr("rel").unwrap_or_default();
	for token in rel.split_ascii_whitespace() {
		if token.eq_ignore_ascii_case("canonical") && pending.canonical.is_none() {
			pending.canonical = Some(href);
		} else if token.eq_ignore_ascii_case("alternate") {
			pending
				.alternates
				.push((href, tag.attr("type").unwrap_or_default().to_ascii_lowercase()));
		}
	}
}

fn meta<'a>(facts: &mut Facts, pending: &mut Pending<'a>, tag: &'a Element) {
	let Some(content) = nonempty(tag.attr("content")) else {
		return;
	};
	if tag
		.attr("http-equiv")
		.is_some_and(|v| v.trim().eq_ignore_ascii_case("refresh"))
	{
		pending.refresh.get_or_insert(content);
		return;
	}
	let Some(key) = nonempty(
		tag.attr("name")
			.or_else(|| tag.attr("property"))
			.or_else(|| tag.attr("itemprop")),
	) else {
		return;
	};
	let set = |slot: &mut Option<String>| {
		if slot.is_none() {
			*slot = collapse(content);
		}
	};
	match key.to_ascii_lowercase().as_str() {
		"description" => facts.description = collapse(content),
		"og:description" | "twitter:description" => {
			pending.fallback_desc.get_or_insert(content);
		},
		"og:title" => {
			pending.og_title.get_or_insert(content);
		},
		"og:type" => set(&mut facts.og_type),
		"author" | "dc.creator" | "dc:creator" | "parsely-author" | "sailthru.author" => {
			set(&mut facts.author);
		},
		"article:author" if !content.starts_with("http") => set(&mut facts.author),
		"article:published_time"
		| "og:published_time"
		| "datepublished"
		| "date"
		| "dc.date"
		| "dc.date.issued"
		| "dcterms.created"
		| "pubdate"
		| "publish-date"
		| "parsely-pub-date"
		| "sailthru.date" => set(&mut facts.published),
		_ => {},
	}
}

/// Matches the first statement of a script assigning an object literal to a
/// global (`window.__INITIAL_STATE__ = {`), capturing the name.
static STATE_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^\s*(?:(?:window|self|globalThis)\.|(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*\{",
	)
	.expect("state assignment regex")
});

fn script(facts: &mut Facts, tag: &Element, body: &str) {
	let kind = tag
		.attr("type")
		.unwrap_or_default()
		.trim()
		.to_ascii_lowercase();
	let id = tag.attr("id").unwrap_or_default();
	if kind == "application/ld+json" {
		facts.json_ld.extend(parse_json(body));
	} else if kind == "application/json" || id == "__NEXT_DATA__" || id == "__NUXT_DATA__" {
		facts.state_blobs.extend(parse_json(body));
	} else if (kind.is_empty() || kind.contains("javascript") || kind == "module")
		&& let Some(captures) = STATE_ASSIGNMENT.captures(body)
		&& is_state_name(&captures[1])
	{
		// Parse one value starting at the brace and ignore the rest of the
		// script.
		let start = captures.get(0).map_or(0, |m| m.end() - 1);
		if let Some(Ok(value)) = serde_json::Deserializer::from_str(&body[start..])
			.into_iter::<Value>()
			.next()
		{
			facts.state_blobs.push(value);
		}
	}
}

fn is_state_name(name: &str) -> bool {
	name.starts_with("__")
		|| name.contains("Initial")
		|| name.ends_with("State")
		|| name.ends_with("Data")
}

/// Parse a JSON data block, tolerating the HTML comment and CDATA wrappers
/// older pages put around inline data.
fn parse_json(body: &str) -> Option<Value> {
	let mut text = body.trim();
	for (open, close) in [("<!--", "-->"), ("//<![CDATA[", "//]]>"), ("<![CDATA[", "]]>")] {
		if let Some(inner) = text.strip_prefix(open) {
			text = inner.strip_suffix(close).unwrap_or(inner).trim();
		}
	}
	serde_json::from_str(text).ok()
}

fn has_document_extension(href: &str) -> bool {
	let path = href.split(['?', '#']).next().unwrap_or(href);
	let path = path.as_bytes();
	DOCUMENT_EXTENSIONS.iter().any(|ext| {
		path.len() > ext.len() && path[path.len() - ext.len()..].eq_ignore_ascii_case(ext.as_bytes())
	})
}

fn resolve(facts: &mut Facts, pending: Pending<'_>, page_url: &Url) {
	facts.base = pending.base.and_then(|href| page_url.join(href).ok());
	let base = facts.base.as_ref().unwrap_or(page_url);
	facts.canonical = pending.canonical.and_then(|href| base.join(href).ok());
	facts.refresh = pending.refresh.and_then(|value| parse_refresh(value, base));
	if facts.title.is_none() {
		facts.title = pending.og_title.and_then(collapse);
	}
	if facts.description.is_none() {
		facts.description = pending.fallback_desc.and_then(collapse);
	}

	// Alternates must describe the requested page, not a site-wide index.
	let page_path = page_url
		.path()
		.strip_suffix('/')
		.unwrap_or_else(|| page_url.path());
	for (href, kind) in pending.alternates {
		if is_site_wide_feed(href) {
			continue;
		}
		let Ok(target) = base.join(href) else {
			continue;
		};
		let path = target.path();
		let page_specific = path == page_path
			|| (!page_path.is_empty()
				&& path
					.strip_prefix(page_path)
					.is_some_and(|rest| rest.starts_with('/') || rest.starts_with('.')));
		if !page_specific {
			continue;
		}
		let kind = if kind.contains("markdown") {
			AlternateKind::Markdown
		} else if !page_path.is_empty()
			&& (kind.contains("rss") || kind.contains("atom") || kind.contains("feed"))
		{
			AlternateKind::Feed
		} else {
			continue;
		};
		facts.alternates.push(Alternate { kind, href: target });
	}

	for href in pending.documents {
		if facts.document_links.len() >= MAX_DOCUMENT_LINKS {
			break;
		}
		if let Ok(target) = base.join(href)
			&& !facts.document_links.contains(&target)
		{
			facts.document_links.push(target);
		}
	}

	if facts.author.is_none() || facts.published.is_none() {
		for object in facts.json_ld.iter().flat_map(ld_objects) {
			if facts.author.is_none() {
				facts.author = ld_author(object);
			}
			if facts.published.is_none() {
				facts.published = object
					.get("datePublished")
					.and_then(Value::as_str)
					.and_then(collapse);
			}
		}
	}
}

/// Site-wide, wiki-change and comment feeds never stand in for one page.
fn is_site_wide_feed(href: &str) -> bool {
	static FEED_PATH: LazyLock<Regex> =
		LazyLock::new(|| Regex::new(r"/feed(?:/|$|\?)|/comments?/").expect("feed path regex"));
	href.contains("RecentChanges")
		|| href.contains("Special:")
		|| href.contains("action=feed")
		|| FEED_PATH.is_match(href)
}

/// Top-level JSON-LD objects, including the members of an array or `@graph`.
fn ld_objects(value: &Value) -> Vec<&Value> {
	let roots: Vec<&Value> = match value {
		Value::Array(items) => items.iter().collect(),
		other => vec![other],
	};
	let mut out = Vec::new();
	for root in roots {
		if root.is_object() {
			out.push(root);
		}
		if let Some(Value::Array(graph)) = root.get("@graph") {
			out.extend(graph.iter().filter(|item| item.is_object()));
		}
	}
	out
}

fn ld_author(object: &Value) -> Option<String> {
	let author = object.get("author")?;
	let first = match author {
		Value::Array(items) => items.first()?,
		other => other,
	};
	match first {
		Value::String(name) => collapse(name),
		Value::Object(_) => first.get("name").and_then(Value::as_str).and_then(collapse),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::dom::parse;

	fn facts(html: &str, url: &str) -> Facts {
		collect(&parse(html).unwrap(), &Url::parse(url).unwrap())
	}

	#[test]
	fn head_metadata_resolves_against_base() {
		let f = facts(
			r#"<html><head><title> A
			title </title><base href="https://cdn.test/docs/"><link rel="canonical" href="page">
			<meta name="description" content="Desc"><meta property="og:type" content="article">
			<meta name="author" content="Ada"><meta property="article:published_time" content="2024-01-02">
			<meta http-equiv="Refresh" content="0; URL='next.html'"></head><body></body></html>"#,
			"https://example.test/docs/page",
		);
		assert_eq!(f.title.as_deref(), Some("A title"));
		assert_eq!(f.base.unwrap().as_str(), "https://cdn.test/docs/");
		assert_eq!(f.canonical.unwrap().as_str(), "https://cdn.test/docs/page");
		assert_eq!(f.description.as_deref(), Some("Desc"));
		assert_eq!(f.og_type.as_deref(), Some("article"));
		assert_eq!(f.author.as_deref(), Some("Ada"));
		assert_eq!(f.published.as_deref(), Some("2024-01-02"));
		assert_eq!(f.refresh.unwrap(), Refresh {
			delay_secs: 0,
			url:        Url::parse("https://cdn.test/docs/next.html").unwrap(),
		});
	}

	#[test]
	fn alternates_are_page_specific() {
		let head = r#"<link rel="alternate" type="application/rss+xml" href="/blog/rss.xml">
			<link rel="alternate" type="text/markdown" href="/llms.txt">
			<link rel="alternate" type="text/markdown" href="/guide/index.txt">
			<link rel="alternate" type="application/rss+xml" href="/guide/comments/feed.xml">
			<link rel="alternate" type="application/atom+xml" href="/guide.atom">"#;
		let f = facts(head, "https://example.test/guide/");
		let got: Vec<(AlternateKind, &str)> = f
			.alternates
			.iter()
			.map(|a| (a.kind, a.href.as_str()))
			.collect();
		assert_eq!(got, [
			(AlternateKind::Markdown, "https://example.test/guide/index.txt"),
			(AlternateKind::Feed, "https://example.test/guide.atom"),
		]);
		// The homepage has no page-specific alternate at all.
		assert!(facts(head, "https://example.test/").alternates.is_empty());
	}

	#[test]
	fn text_stats_and_structured_data() {
		let f = facts(
			r#"<body><p>one two</p><a href="/files/report.PDF?dl=1">get it</a><a href="/files/report.PDF?dl=1">again</a>
			<script type="application/ld+json">{"@graph":[{"@type":"Article","author":{"name":"Grace"},"datePublished":"2023"}]}</script>
			<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
			<script>window.__INITIAL_STATE__ = {"a":[1,2]}; boot();</script>
			<style>p{}</style></body>"#,
			"https://example.test/a",
		);
		assert_eq!(f.text_chars, "onetwogetitagain".len());
		assert_eq!(f.link_chars, "getitagain".len());
		assert_eq!(f.document_links.len(), 1);
		assert_eq!(f.document_links[0].as_str(), "https://example.test/files/report.PDF?dl=1");
		assert_eq!(f.author.as_deref(), Some("Grace"));
		assert_eq!(f.published.as_deref(), Some("2023"));
		assert_eq!(f.json_ld.len(), 1);
		assert_eq!(f.state_blobs, [
			serde_json::json!({"props": {}}),
			serde_json::json!({"a": [1, 2]})
		]);
		assert!(f.script_bytes > 0);
	}

	#[test]
	fn refresh_values() {
		let base = Url::parse("https://example.test/a/b").unwrap();
		assert_eq!(parse_refresh("5", &base), None);
		assert_eq!(parse_refresh("3;url=/c", &base).unwrap().delay_secs, 3);
		assert_eq!(
			parse_refresh("0, \"x\"", &base).unwrap().url.as_str(),
			"https://example.test/a/x"
		);
		assert_eq!(parse_refresh("nope", &base), None);
	}
}
