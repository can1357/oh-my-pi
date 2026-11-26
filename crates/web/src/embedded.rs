use std::collections::HashSet;

use serde_json::Value;

use crate::{
	dom::{self, Node},
	facts::Facts,
};

const MIN_BODY_CHARS: usize = 200;
/// Words an Open Graph description needs to summarize a page.
const MIN_SUMMARY_WORDS: usize = 6;

struct Content<'a> {
	title: Option<&'a str>,
	body:  &'a str,
}

impl Content<'_> {
	fn markdown(&self, fallback_title: Option<&str>) -> String {
		match self.title.or(fallback_title) {
			Some(title) => format!("# {}\n\n{}", title.trim(), self.body),
			None => self.body.to_owned(),
		}
	}
}

fn substantial(text: &str) -> bool {
	text.len() >= MIN_BODY_CHARS && text.chars().nth(MIN_BODY_CHARS - 1).is_some()
}

fn text<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
	object
		.get(key)?
		.as_str()
		.map(str::trim)
		.filter(|s| !s.is_empty())
}

fn schema_content(value: &Value, article: bool) -> Option<Content<'_>> {
	if let Some(values) = value.as_array() {
		return values
			.iter()
			.find_map(|child| schema_content(child, article));
	}
	let matches_type = |kind: &Value| {
		let kind = kind.as_str().unwrap_or_default();
		let kind = kind.rsplit(['/', '#']).next().unwrap_or(kind);
		if article {
			matches!(
				kind,
				"Article"
					| "NewsArticle"
					| "BlogPosting"
					| "TechArticle"
					| "ScholarlyArticle"
					| "Report"
			)
		} else {
			matches!(
				kind,
				"VideoObject"
					| "AudioObject"
					| "PodcastEpisode"
					| "SoftwareSourceCode"
					| "SoftwareApplication"
			)
		}
	};
	if value.get("@type").is_some_and(|kind| {
		kind
			.as_array()
			.map_or_else(|| matches_type(kind), |kinds| kinds.iter().any(matches_type))
	}) {
		let title = text(value, "headline").or_else(|| text(value, "name"));
		let body_fields: &[_] = if article {
			&["articleBody"]
		} else {
			&["transcript", "description"]
		};
		if let Some(body) = body_fields
			.iter()
			.find_map(|key| text(value, key).filter(|s| substantial(s)))
		{
			return Some(Content { title, body });
		}
	}
	["@graph", "mainEntity"]
		.iter()
		.find_map(|key| schema_content(value.get(key)?, article))
}

fn prose(s: &str) -> bool {
	// Generic Next.js fields also carry IDs, URLs, tokens, and serialized data.
	// Require prose-like word boundaries rather than treating arbitrary strings
	// as content.
	substantial(s)
		&& !s.starts_with(['{', '['])
		&& s
			.split_whitespace()
			.filter(|word| word.chars().any(char::is_alphabetic))
			.nth(19)
			.is_some()
}

fn state_content<'a>(value: &'a Value, parent_title: Option<&'a str>) -> Option<Content<'a>> {
	if let Some(values) = value.as_array() {
		return values
			.iter()
			.find_map(|child| state_content(child, parent_title));
	}
	let value_map = value.as_object()?;
	let title = text(value, "headline")
		.or_else(|| text(value, "title"))
		.or_else(|| text(value, "name"))
		.or(parent_title);
	if let Some(body) = ["articleBody", "body", "content", "text", "description"]
		.iter()
		.find_map(|key| text(value, key).filter(|s| prose(s)))
	{
		return Some(Content { title, body });
	}
	value_map
		.values()
		.find_map(|child| state_content(child, title))
}

/// The Open Graph title and the first description `accept` takes.
fn open_graph(nodes: &[Node], accept: impl Fn(&str) -> bool) -> Option<Content<'_>> {
	let mut title = None;
	let mut body = None;
	for node in nodes {
		let Node::Tag(tag) = node else { continue };
		if tag.name() != "meta" {
			continue;
		}
		let Some(content) = tag.attr("content").map(str::trim).filter(|s| !s.is_empty()) else {
			continue;
		};
		match tag.attr("property").or_else(|| tag.attr("name")) {
			Some("og:title") if title.is_none() => title = Some(content),
			Some("og:description") if body.is_none() && accept(content) => body = Some(content),
			_ => {},
		}
	}
	Some(Content { title, body: body? })
}

/// Recover substantial Markdown content for a script-rendered page without
/// executing its scripts.
pub fn extract(nodes: &[Node], facts: &Facts) -> Option<String> {
	let content = facts
		.json_ld
		.iter()
		.find_map(|value| schema_content(value, true))
		.or_else(|| {
			facts
				.json_ld
				.iter()
				.find_map(|value| schema_content(value, false))
		})
		.or_else(|| {
			facts.state_blobs.iter().find_map(|value| {
				let page_props = value
					.pointer("/props/pageProps")
					.or_else(|| value.get("pageProps"))?;
				state_content(page_props, None)
			})
		})
		.or_else(|| open_graph(nodes, substantial));
	if let Some(content) = content {
		return Some(content.markdown(facts.title.as_deref()));
	}
	// A shell whose only server-side content is its FAQ markup.
	let entries = faq(facts);
	let chars: usize = entries.iter().map(|(q, a)| q.len() + a.len()).sum();
	(chars >= MIN_BODY_CHARS).then(|| {
		let title = facts
			.title
			.as_deref()
			.map(str::trim)
			.filter(|t| !t.is_empty());
		let mut out = title.map_or_else(String::new, |t| format!("# {t}\n\n"));
		out.push_str(&faq_markdown(&entries, 2));
		out
	})
}

/// Question and answer pairs of the page's JSON-LD `FAQPage` blocks, in order,
/// each question once; answers are plain text.
pub fn faq(facts: &Facts) -> Vec<(String, String)> {
	fn is_type(value: &Value, name: &str) -> bool {
		let matches = |kind: &Value| {
			kind
				.as_str()
				.is_some_and(|kind| kind.rsplit(['/', '#']).next() == Some(name))
		};
		value.get("@type").is_some_and(|kind| {
			kind
				.as_array()
				.map_or_else(|| matches(kind), |kinds| kinds.iter().any(matches))
		})
	}
	fn walk(
		value: &Value,
		depth: usize,
		seen: &mut HashSet<String>,
		out: &mut Vec<(String, String)>,
	) {
		if depth == 0 {
			return;
		}
		if let Some(values) = value.as_array() {
			for value in values {
				walk(value, depth - 1, seen, out);
			}
			return;
		}
		if is_type(value, "FAQPage") {
			let questions = value.get("mainEntity");
			let questions = questions
				.and_then(Value::as_array)
				.map_or_else(|| questions.into_iter().collect::<Vec<_>>(), |all| all.iter().collect());
			for question in questions {
				let Some(name) = text(question, "name").map(plain_text) else {
					continue;
				};
				let answer = question.get("acceptedAnswer").map(|answer| {
					answer
						.as_array()
						.and_then(|all| all.first())
						.unwrap_or(answer)
				});
				let Some(answer) = answer
					.and_then(|answer| text(answer, "text"))
					.map(plain_text)
				else {
					continue;
				};
				if !name.is_empty() && !answer.is_empty() && seen.insert(name.clone()) {
					out.push((name, answer));
				}
			}
			return;
		}
		if let Some(graph) = value.get("@graph") {
			walk(graph, depth - 1, seen, out);
		}
	}
	let mut seen = HashSet::new();
	let mut out = Vec::new();
	for value in &facts.json_ld {
		walk(value, 4, &mut seen, &mut out);
	}
	out
}

/// Markdown for FAQ entries, questions as headings at `level`.
pub fn faq_markdown(entries: &[(String, String)], level: usize) -> String {
	let mut out = String::new();
	for (question, answer) in entries {
		if !out.is_empty() {
			out.push_str("\n\n");
		}
		out.push_str(&"#".repeat(level));
		out.push(' ');
		out.push_str(question);
		out.push_str("\n\n");
		out.push_str(answer);
	}
	out
}

/// Text of a JSON-LD string that may hold HTML markup, whitespace-collapsed.
fn plain_text(value: &str) -> String {
	let mut out = String::new();
	let mut push = |text: &str| {
		for word in text.split_whitespace() {
			if !out.is_empty() {
				out.push(' ');
			}
			out.push_str(word);
		}
	};
	if !value.contains('<') {
		push(value);
		return out;
	}
	for node in dom::parse(value).unwrap_or_default() {
		if let Node::Text(text) = node {
			push(&text);
		}
	}
	out
}

/// A script shell's Open Graph or meta description summary when [`extract`]
/// finds no content: too short to stand in for the page while a browser can
/// render it, but better than nothing.
pub fn summary(nodes: &[Node], facts: &Facts) -> Option<String> {
	let sentence = |text: &str| {
		text
			.split_whitespace()
			.filter(|word| word.chars().any(char::is_alphabetic))
			.nth(MIN_SUMMARY_WORDS - 1)
			.is_some()
			&& !crate::wall::is_block_page(text)
	};
	open_graph(nodes, sentence)
		.or_else(|| {
			let body = facts.description.as_deref().filter(|text| sentence(text))?;
			Some(Content { title: None, body })
		})
		.map(|content| content.markdown(facts.title.as_deref()))
}

#[cfg(test)]
mod tests {
	use url::Url;

	use super::*;
	use crate::{dom::parse, facts::collect};

	#[test]
	fn json_ld_article_beats_secondary_metadata() {
		let body = "Readers arrive at the lake before sunrise. They cross the bridge to watch the \
		            herons lift from the reeds as the tide turns. The bridge was closed last winter \
		            when the final storm swept away its wooden deck, but volunteers rebuilt it from \
		            salvaged planks in spring.";
		let data = serde_json::json!({
			"@graph": [{ "@type": ["Thing", "https://schema.org/NewsArticle"], "headline": "A bridge restored", "articleBody": body }]
		});
		let html =
			format!(r#"<title>Shell title</title><script type="application/ld+json">{data}</script>"#);
		let nodes = parse(&html).unwrap();
		let facts = collect(&nodes, &Url::parse("https://example.test/article").unwrap());
		assert_eq!(extract(&nodes, &facts), Some(format!("# A bridge restored\n\n{body}")));
	}

	#[test]
	fn next_page_props_prose_takes_precedence_over_open_graph() {
		let body = "The community archive preserves letters describing the harbor and its early \
		            repair crews. Its volunteers sorted the collection by year, recorded who sent \
		            each letter, and digitized the pages so local researchers could compare changes \
		            over time.";
		let og_description =
			"An Open Graph description about a separate part of the project. ".repeat(4);
		let data = serde_json::json!({
			"props": { "pageProps": {
				"description": "x".repeat(300),
				"article": { "title": "The harbor archive", "text": body }
			} }
		});
		let html = format!(
			r#"<meta property="og:title" content="Overview">
			<meta property="og:description" content="{og_description}">
			<script id="__NEXT_DATA__" type="application/json">{data}</script>"#
		);
		let nodes = parse(&html).unwrap();
		let facts = collect(&nodes, &Url::parse("https://example.test/archive").unwrap());
		assert_eq!(extract(&nodes, &facts), Some(format!("# The harbor archive\n\n{body}")));
	}

	#[test]
	fn shell_metadata_without_substantial_content_does_not_prevent_fallback() {
		let html = r#"<meta property="og:title" content="Shell title"><meta property="og:description" content="Loading…">
		<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"text":"Please wait"}}}</script>"#;
		let nodes = parse(html).unwrap();
		let facts = collect(&nodes, &Url::parse("https://example.test/shell").unwrap());
		assert_eq!(extract(&nodes, &facts), None);
		assert_eq!(summary(&nodes, &facts), None);
	}

	#[test]
	fn a_meta_description_summarizes_a_shell_without_open_graph() {
		let html = r#"<title>Rules</title><meta name="description" content="Make the model run faster, then speed up how it is served.">"#;
		let nodes = parse(html).unwrap();
		let facts = collect(&nodes, &Url::parse("https://example.test/rules").unwrap());
		assert_eq!(
			summary(&nodes, &facts).as_deref(),
			Some("# Rules\n\nMake the model run faster, then speed up how it is served.")
		);
	}

	#[test]
	fn faq_page_json_ld_yields_each_question_once() {
		let answer = "Yes, the menu is served every day of the week, including weekend brunch, from \
		              noon until late in the evening, and every dish can also be ordered for \
		              takeaway at the counter or through the booking page.";
		let data = serde_json::json!({ "@type": "FAQPage", "mainEntity": [
			{ "@type": "Question", "name": "Is it served daily?", "acceptedAnswer": { "@type": "Answer", "text": format!("<p>{answer}</p>") } }
		] });
		let html = format!(
			r#"<title>Menu</title><div id="root"></div><script type="application/ld+json">{data}</script><script type="application/ld+json">{data}</script>"#
		);
		let nodes = parse(&html).unwrap();
		let facts = collect(&nodes, &Url::parse("https://example.test/menu").unwrap());
		assert_eq!(faq(&facts), [("Is it served daily?".to_owned(), answer.to_owned())]);
		assert_eq!(
			extract(&nodes, &facts),
			Some(format!("# Menu\n\n## Is it served daily?\n\n{answer}"))
		);
	}

	#[test]
	fn a_short_open_graph_description_is_only_a_summary() {
		let html = r#"<title>Account</title><meta property="og:title" content="Account settings">
		<meta property="og:description" content="Manage members, billing and security for the workspace">"#;
		let nodes = parse(html).unwrap();
		let facts = collect(&nodes, &Url::parse("https://example.test/account").unwrap());
		assert_eq!(extract(&nodes, &facts), None);
		assert_eq!(
			summary(&nodes, &facts).as_deref(),
			Some("# Account settings\n\nManage members, billing and security for the workspace")
		);
	}
}
