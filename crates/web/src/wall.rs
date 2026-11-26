//! Bot-wall and script-shell detection: transport-level walls from status,
//! headers and body markers, and page-level verdicts from the rendering.

use crate::{
	dom::{self, Node},
	facts::Facts,
	strategy::header,
};

/// Statuses sites answer a user agent they refuse with (999 is `LinkedIn`'s),
/// whatever the body says: the next user agent may be served the page.
pub const BLOCKED_STATUSES: [u16; 4] = [403, 429, 503, 999];

/// A challenge interstitial carries no content (Reddit's is about 8 KB); a
/// larger page is no wall.
const CHALLENGE_PAGE_MAX_CHARS: usize = 64 * 1024;
/// A rendering longer than this is content, whatever wall wording it quotes.
const BLOCK_PAGE_MAX_CHARS: usize = 2048;
/// A rendering longer than this is content, whatever JavaScript wording it
/// quotes.
const JS_GATE_MAX_CHARS: usize = 1024;
/// A rendering this short holds no content.
pub const MIN_RENDERED_CHARS: usize = 100;
/// Inline script volume that marks a page as an application shell.
const APP_SCRIPT_BYTES: usize = 1024;

/// Wording of a page that shows nothing until JavaScript runs.
pub const JS_GATE_PHRASES: [&str; 6] = [
	"enable javascript",
	"javascript required",
	"javascript is required",
	"turn on javascript",
	"please enable javascript",
	"browser not supported",
];

/// Bot-wall wording of a block page, with the wall it names.
const BLOCK_PAGE_PHRASES: [(&str, &str); 6] = [
	("blocked by network security", "network security block"),
	("verify you are human", "human verification"),
	("are you a robot", "human verification"),
	("access to this page has been denied", "access denied page"),
	// Discourse's and older Cloudflare interstitials.
	("checking your browser", "browser check"),
	("please enable js and disable any ad blocker", "DataDome"),
];

/// Mount points script-rendered applications fill in.
const APP_MOUNT_IDS: [&str; 8] =
	["root", "app", "__next", "__nuxt", "___gatsby", "svelte", "react-root", "main-app"];

/// What a fetched page turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
	/// The page has content.
	Ok,
	/// A bot protection's challenge or block page, named.
	Wall(String),
	/// An application shell that shows nothing until its scripts run.
	JsShell,
	/// The page renders to nothing.
	Empty,
}

impl Verdict {
	/// Stable name reported to callers.
	pub const fn as_str(&self) -> &'static str {
		match self {
			Self::Ok => "ok",
			Self::Wall(_) => "wall",
			Self::JsShell => "js-shell",
			Self::Empty => "empty",
		}
	}
}

/// At most `max` characters.
fn chars_at_most(text: &str, max: usize) -> bool {
	text.len() <= max || text.chars().nth(max).is_none()
}

/// Name the bot protection whose challenge or block page an HTML response is.
///
/// A 2xx page counts only from Cloudflare's header or a live challenge form,
/// since an article can quote any marker as text; vendor markers in the body
/// count on an error status. Pass an empty body to judge headers alone.
pub fn http(status: u16, headers: &[(String, String)], body: &str) -> Option<String> {
	let content_type = header(headers, "content-type")?;
	if !content_type.to_ascii_lowercase().contains("html") {
		return None;
	}
	if header(headers, "cf-mitigated").is_some_and(|v| v.trim().eq_ignore_ascii_case("challenge")) {
		return Some("Cloudflare".to_owned());
	}
	if !body.is_empty()
		&& chars_at_most(body, CHALLENGE_PAGE_MAX_CHARS)
		&& let Ok(nodes) = dom::parse(body)
		&& has_challenge_form(&nodes)
	{
		return Some("JavaScript challenge".to_owned());
	}
	if (200..300).contains(&status) {
		return None;
	}
	let name = if body.contains("_cf_chl_opt") {
		"Cloudflare"
	} else if body.contains("captcha-delivery.com") {
		"DataDome"
	} else if body.contains("px-captcha") {
		"PerimeterX"
	} else if body.contains("blocked by network security") {
		"network security block"
	} else if body.contains("<title>Checking your browser") {
		"browser check"
	} else {
		return None;
	};
	Some(name.to_owned())
}

/// True when a short rendering is a wall's block page or a JavaScript gate
/// rather than content: what a remote reader is served by a wall.
pub fn is_block_page(text: &str) -> bool {
	let text = text.trim();
	if !chars_at_most(text, BLOCK_PAGE_MAX_CHARS) {
		return false;
	}
	let lower = text.to_lowercase();
	BLOCK_PAGE_PHRASES
		.iter()
		.any(|(phrase, _)| lower.contains(phrase))
		|| JS_GATE_PHRASES.iter().any(|phrase| lower.contains(phrase))
}

/// Judge a rendered page: a wall's block page, a script shell, nothing, or
/// content.
pub fn page(nodes: &[Node], facts: &Facts, rendered: &str) -> Verdict {
	if facts.text_chars + facts.script_bytes <= CHALLENGE_PAGE_MAX_CHARS && has_challenge_form(nodes)
	{
		return Verdict::Wall("JavaScript challenge".to_owned());
	}
	let text = rendered.trim();
	if chars_at_most(text, BLOCK_PAGE_MAX_CHARS) {
		let lower = text.to_lowercase();
		if let Some((_, name)) = BLOCK_PAGE_PHRASES
			.iter()
			.find(|(phrase, _)| lower.contains(phrase))
		{
			return Verdict::Wall((*name).to_owned());
		}
		if chars_at_most(text, JS_GATE_MAX_CHARS - 1)
			&& JS_GATE_PHRASES.iter().any(|phrase| lower.contains(phrase))
		{
			return Verdict::JsShell;
		}
	}
	if chars_at_most(text, MIN_RENDERED_CHARS) {
		return if is_app_shell(nodes, facts) || noscript_gate(nodes) {
			Verdict::JsShell
		} else {
			Verdict::Empty
		};
	}
	Verdict::Ok
}

/// True when the page holds an `<input name="js_challenge">` field outside
/// `<template>`. Markup quoted in comments, scripts, raw-text elements or
/// attributes is text in the arena, so it never counts.
fn has_challenge_form(nodes: &[Node]) -> bool {
	let mut i = 0;
	while i < nodes.len() {
		if let Node::Tag(tag) = &nodes[i] {
			match tag.name() {
				"template" => {
					i = tag.children.end;
					continue;
				},
				"input"
					if tag
						.attr("name")
						.is_some_and(|name| name.trim() == "js_challenge") =>
				{
					return true;
				},
				_ => {},
			}
		}
		i += 1;
	}
	false
}

/// True when a `<noscript>` fallback asks for JavaScript: the page shows its
/// content only to scripts (crates.io's `SvelteKit` shell).
fn noscript_gate(nodes: &[Node]) -> bool {
	nodes.iter().any(|node| {
		let Node::Tag(tag) = node else { return false };
		tag.name() == "noscript"
			&& nodes[tag.children.clone()].iter().any(|child| {
				let Node::Text(text) = child else {
					return false;
				};
				let lower = text.to_lowercase();
				JS_GATE_PHRASES.iter().any(|phrase| lower.contains(phrase))
			})
	})
}

/// A page that loads its content by script: much inline script, an external
/// script, or an application mount point.
fn is_app_shell(nodes: &[Node], facts: &Facts) -> bool {
	facts.script_bytes >= APP_SCRIPT_BYTES
		|| nodes.iter().any(|node| match node {
			Node::Tag(tag) => {
				(tag.name() == "script" && tag.has_attr("src"))
					|| tag.attr("id").is_some_and(|id| APP_MOUNT_IDS.contains(&id))
					|| tag.name() == "app-root"
			},
			Node::Text(_) => false,
		})
}

#[cfg(test)]
mod tests {
	use url::Url;

	use super::*;
	use crate::facts::collect;

	fn html(headers: &[(&str, &str)]) -> Vec<(String, String)> {
		let mut out = vec![("Content-Type".to_owned(), "text/html; charset=utf-8".to_owned())];
		out.extend(
			headers
				.iter()
				.map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
		);
		out
	}

	#[test]
	fn challenge_forms_count_only_as_fields() {
		for form in [
			"<input type=hidden name='js_challenge'>",
			"<INPUT TYPE=hidden NAME=js_challenge>",
			r#"<input type="hidden" name="js&#95;challenge">"#,
		] {
			let body = format!("<html><body><form>{form}</form></body></html>");
			assert_eq!(
				http(200, &html(&[]), &body).as_deref(),
				Some("JavaScript challenge"),
				"{form}"
			);
		}
		let quoted = r#"<article><pre>&lt;input name="js_challenge"&gt; _cf_chl_opt px-captcha</pre>
			<!-- <input name="js_challenge"> -->
			<script>const s = '</scripture><input name="js_challenge">';</script>
			<textarea><input name="js_challenge"></textarea><xmp><input name="js_challenge"></xmp>
			<template><input name="js_challenge"></template>
			<input-example name="js_challenge"></input-example><input data-name="js_challenge">
			<div data-example='<input name="js_challenge">'></div></article>"#;
		assert_eq!(http(200, &html(&[]), quoted), None);
	}

	#[test]
	fn header_and_error_markers() {
		assert_eq!(
			http(403, &html(&[("cf-mitigated", "challenge")]), "").as_deref(),
			Some("Cloudflare")
		);
		assert_eq!(http(403, &html(&[]), "x captcha-delivery.com").as_deref(), Some("DataDome"));
		assert_eq!(http(200, &html(&[]), "x captcha-delivery.com"), None);
		assert_eq!(http(403, &[], "_cf_chl_opt"), None);
		assert_eq!(http(403, &html(&[]), "<h1>403 Forbidden</h1>"), None);
	}

	#[test]
	fn page_verdicts() {
		let url = Url::parse("https://example.test/").unwrap();
		let judge = |html: &str, rendered: &str| {
			let nodes = dom::parse(html).unwrap();
			let facts = collect(&nodes, &url);
			page(&nodes, &facts, rendered)
		};
		assert_eq!(judge("<div id=root></div><script>start()</script>", ""), Verdict::JsShell);
		assert_eq!(judge("<p>Hi</p>", "Hi"), Verdict::Empty);
		assert_eq!(
			judge("<p>x</p>", "Please enable JavaScript to view this site."),
			Verdict::JsShell
		);
		assert_eq!(
			judge("<p>x</p>", "You've been blocked by network security."),
			Verdict::Wall("network security block".to_owned())
		);
		let long = "Readers enable javascript in settings. ".repeat(40);
		assert_eq!(judge("<p>x</p>", &long), Verdict::Ok);
		assert_eq!(
			judge(
				"<body><noscript>It is necessary to enable JavaScript.</noscript><div></div></body>",
				""
			),
			Verdict::JsShell
		);
		assert_eq!(
			judge("<p>x</p>", "Please enable JS and disable any ad blocker"),
			Verdict::Wall("DataDome".to_owned())
		);
		assert_eq!(
			judge("<p>x</p>", "Checking your browser... This should only take a few seconds."),
			Verdict::Wall("browser check".to_owned())
		);
		let check = "<html><head><title>Checking your browser...</title></head></html>";
		assert_eq!(http(403, &html(&[]), check).as_deref(), Some("browser check"));
	}
}
