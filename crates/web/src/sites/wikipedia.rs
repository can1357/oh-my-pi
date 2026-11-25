//! Wikipedia (`*.wikipedia.org/wiki/…`): the lead summary from the REST API,
//! then the article's sections from the mobile-html rendering.

use std::{fmt::Write as _, ops::Range};

use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, segment, str_of};
use crate::dom::{self, Node};

/// Registry entry.
pub const SITE: Site = Site { name: "wikipedia", open };

const METHOD: &str = "wikipedia";
/// A paragraph shorter than this is furniture, not prose.
const MIN_PARAGRAPH: usize = 20;
/// Sections left out of the article body.
const SKIPPED: &[&str] = &["References", "External links", "See also", "Notes", "Further reading"];

fn open(url: &Url, _: &Context) -> Option<Action> {
	let host = url.host_str()?;
	let lang = host.strip_suffix(".wikipedia.org")?;
	if lang.is_empty()
		|| !lang
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
	{
		return None;
	}
	let title = url
		.path()
		.strip_prefix("/wiki/")
		.filter(|title| !title.is_empty())?;
	let title = decode(title);
	let summary_url = format!("https://{host}/api/rest_v1/page/summary/{}", segment(&title));
	let content_url = format!("https://{host}/api/rest_v1/page/mobile-html/{}", segment(&title));
	fetch(Fetch::get(summary_url), move |reply, _| {
		let mut md = String::new();
		if reply.ok() {
			let summary = reply.json_value()?;
			let _ = write!(md, "# {}\n\n", str_of(&summary, "title").unwrap_or_default());
			if let Some(description) = str_of(&summary, "description") {
				let _ = write!(md, "*{description}*\n\n");
			}
			let _ = write!(md, "{}\n\n---\n\n", str_of(&summary, "extract").unwrap_or_default());
		}
		fetch(Fetch::get(content_url), move |reply, _| {
			if let Some(html) = reply.body_text() {
				md.push_str(&sections(&html));
			}
			if md.is_empty() {
				return None;
			}
			Done::new(md, METHOD)
				.note("Fetched via Wikipedia API")
				.finish()
		})
	})
}

/// The section headings and paragraphs of a rendered article, in document
/// order, with the sections in [`SKIPPED`] left out.
fn sections(html: &str) -> String {
	let Ok(nodes) = dom::parse(html) else {
		return String::new();
	};
	let mut out = String::new();
	for index in 0..nodes.len() {
		let Node::Tag(section) = &nodes[index] else {
			continue;
		};
		if section.name() != "section" {
			continue;
		}
		let range = section.children.clone();
		if let Some((name, heading_range)) = heading(&nodes, range.clone()) {
			let text = text_content(&nodes, heading_range);
			let text = text.trim();
			if SKIPPED.contains(&text) {
				continue;
			}
			if !text.is_empty() {
				let level = if name == "h2" { "##" } else { "###" };
				let _ = write!(out, "{level} {text}\n\n");
			}
		}
		for paragraph in &nodes[range] {
			let Node::Tag(tag) = paragraph else {
				continue;
			};
			if tag.name() != "p" {
				continue;
			}
			let text = text_content(&nodes, tag.children.clone());
			if text.trim().chars().count() > MIN_PARAGRAPH {
				let _ = write!(out, "{}\n\n", text.trim());
			}
		}
	}
	out
}

/// The first `h2`, `h3` or `h4` in `range`, with its own descendants.
fn heading(nodes: &[Node], range: Range<usize>) -> Option<(&str, Range<usize>)> {
	nodes[range].iter().find_map(|node| match node {
		Node::Tag(tag) if matches!(tag.name(), "h2" | "h3" | "h4") => {
			Some((tag.name(), tag.children.clone()))
		},
		_ => None,
	})
}

/// The concatenated text of the nodes in `range`.
fn text_content(nodes: &[Node], range: Range<usize>) -> String {
	let mut text = String::new();
	for node in &nodes[range] {
		if let Node::Text(chunk) = node {
			text.push_str(chunk);
		}
	}
	text
}

/// Percent-decode a URL component (UTF-8, `%XX`).
fn decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%'
			&& i + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
		{
			out.push(high << 4 | low);
			i += 3;
			continue;
		}
		out.push(bytes[i]);
		i += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
	(byte as char)
		.to_digit(16)
		.and_then(|digit| u8::try_from(digit).ok())
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn an_article_reads_the_summary_and_its_sections() {
		let html = concat!(
			"<html><body>",
			"<section id=\"0\"><h2>History</h2>",
			"<p>Computers have a long and storied history of development.</p><p>Short.</p></section>",
			"<section id=\"1\"><h2>References</h2>",
			"<p>Some reference text that is definitely longer than twenty characters.</p></section>",
			"<section id=\"2\"><h3>Design</h3><p>Notes with <a href=\"/wiki/Chip\">chips</a> inside \
			 them for length.</p></section>",
			"</body></html>"
		);
		let mut requests = Vec::new();
		let done = run("https://en.wikipedia.org/wiki/Computer", |request| {
			requests.push(request.url.clone());
			if request.url.contains("/summary/") {
				Fetched::json(&json!({ "title": "Computer", "description": "Machine for processing data", "extract": "A computer is a machine." }))
			} else {
				Fetched::text("text/html", html)
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://en.wikipedia.org/api/rest_v1/page/summary/Computer",
			"https://en.wikipedia.org/api/rest_v1/page/mobile-html/Computer"
		]);
		assert_eq!(done.method, "wikipedia");
		assert_eq!(done.notes, ["Fetched via Wikipedia API"]);
		assert_eq!(
			done.markdown,
			"# Computer\n\n*Machine for processing data*\n\nA computer is a machine.\n\n---\n\n## \
			 History\n\nComputers have a long and storied history of development.\n\n### \
			 Design\n\nNotes with chips inside them for length.\n\n"
		);
	}

	#[test]
	fn a_second_language_and_a_percent_encoded_title_are_its_own() {
		let mut requests = Vec::new();
		let done = run("https://de.wikipedia.org/wiki/C%2B%2B", |request| {
			requests.push(request.url.clone());
			Fetched::status(404)
		});
		assert_eq!(done, None);
		assert_eq!(requests, [
			"https://de.wikipedia.org/api/rest_v1/page/summary/C%2B%2B",
			"https://de.wikipedia.org/api/rest_v1/page/mobile-html/C%2B%2B"
		]);

		let done = run("https://de.wikipedia.org/wiki/C%2B%2B", |request| {
			if request.url.contains("/summary/") {
				Fetched::json(&json!({ "title": "C++", "extract": "Eine Programmiersprache." }))
			} else {
				Fetched::text(
					"text/html",
					"<section><h2>Geschichte</h2><p>Eine lange Geschichte dieser Sprache.</p></section>",
				)
			}
		})
		.unwrap();
		assert_eq!(
			done.markdown,
			"# C++\n\nEine Programmiersprache.\n\n---\n\n## Geschichte\n\nEine lange Geschichte \
			 dieser Sprache.\n\n"
		);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://en.wikipedia.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.com/wiki/Computer", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://en.wikipedia.org/wiki/Computer", |_| Fetched::status(404)), None);
	}
}
