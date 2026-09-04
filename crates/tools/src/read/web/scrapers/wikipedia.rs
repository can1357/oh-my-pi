//! Wikipedia article renderer backed by the public REST API.

#[cfg(test)]
use omp_core::sf;
#[cfg(test)]
use omp_tool::Severity;
use omp_tool::{Diag, DiagKind};
use serde::Deserialize;
use url::Url;

use crate::read::web::types::{HttpClient, HttpRequest, RenderResult, WebError};

const WIKIPEDIA_SUFFIX: &str = ".wikipedia.org";
const SKIPPED_SECTIONS: [&str; 5] =
	["References", "External links", "See also", "Notes", "Further reading"];

#[derive(Debug)]
struct ArticleTarget {
	language: String,
	title:    String,
}

#[derive(Deserialize)]
struct Summary {
	title:       String,
	description: Option<String>,
	extract:     String,
}

#[derive(Default)]
struct Section {
	heading:      Option<Heading>,
	heading_open: bool,
	paragraph:    Option<String>,
	paragraphs:   Vec<String>,
}

struct Heading {
	level: u8,
	text:  String,
}

/// Returns whether `url` is a localized Wikipedia article URL.
pub(super) fn matches(url: &Url) -> bool {
	parse_target(url).is_some()
}

/// Renders a localized Wikipedia article through the summary and mobile HTML
/// APIs.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(target) = parse_target(url) else {
		return Ok(None);
	};

	let encoded_title = encode_component(&target.title);
	let api_root = format!("https://{}.wikipedia.org/api/rest_v1/page", target.language);
	let summary_url = format!("{api_root}/summary/{encoded_title}");
	let content_url = format!("{api_root}/mobile-html/{encoded_title}");
	let mut markdown = String::new();

	if let Ok(summary_response) = client.get(HttpRequest::new(summary_url)).await
		&& summary_response.is_success()
		&& let Ok(summary) = serde_json::from_slice::<Summary>(&summary_response.body)
	{
		markdown.push_str("# ");
		markdown.push_str(&summary.title);
		markdown.push_str("\n\n");
		if let Some(description) = summary
			.description
			.as_deref()
			.filter(|value| !value.is_empty())
		{
			markdown.push('*');
			markdown.push_str(description);
			markdown.push_str("*\n\n");
		}
		markdown.push_str(&summary.extract);
		markdown.push_str("\n\n---\n\n");
	}

	if let Ok(content_response) = client.get(HttpRequest::new(content_url)).await
		&& content_response.is_success()
	{
		append_sections(&content_response.text(), &mut markdown);
	}

	if markdown.is_empty() {
		return Ok(None);
	}

	let mut result = RenderResult::markdown(&markdown, "wikipedia");
	result
		.diags
		.insert(0, Diag::info(DiagKind::Provenance, "Fetched via Wikipedia API"));
	Ok(Some(result))
}

fn parse_target(url: &Url) -> Option<ArticleTarget> {
	let host = url.host_str()?;
	let language = host.strip_suffix(WIKIPEDIA_SUFFIX)?;
	if language.is_empty()
		|| !language
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
	{
		return None;
	}

	let (_, encoded_title) = url.path().split_once("/wiki/")?;
	if encoded_title.is_empty() {
		return None;
	}
	let title = decode_component(encoded_title)?;
	Some(ArticleTarget { language: language.to_owned(), title })
}

fn append_sections(html: &str, markdown: &mut String) {
	let sections = parse_sections(html);
	for section in sections {
		let heading_text = section.heading.as_ref().map(|heading| heading.text.trim());
		if heading_text.is_some_and(|heading| SKIPPED_SECTIONS.contains(&heading)) {
			continue;
		}

		if let Some(heading) = section.heading {
			let text = heading.text.trim();
			if !text.is_empty() {
				markdown.push_str(if heading.level == 2 { "## " } else { "### " });
				markdown.push_str(text);
				markdown.push_str("\n\n");
			}
		}

		for paragraph in section.paragraphs {
			let text = paragraph.trim();
			if text.encode_utf16().count() > 20 {
				markdown.push_str(text);
				markdown.push_str("\n\n");
			}
		}
	}
}

fn parse_sections(html: &str) -> Vec<Section> {
	let mut sections = Vec::<Section>::new();
	let mut active = Vec::<usize>::new();
	let mut cursor = 0;
	let mut ignored_depth = 0_usize;

	while cursor < html.len() {
		let Some(relative_tag) = html[cursor..].find('<') else {
			if ignored_depth == 0 {
				append_text(&html[cursor..], &active, &mut sections);
			}
			break;
		};
		let tag_start = cursor + relative_tag;
		if ignored_depth == 0 && tag_start > cursor {
			append_text(&html[cursor..tag_start], &active, &mut sections);
		}

		if html[tag_start..].starts_with("<!--") {
			cursor = html[tag_start + 4..]
				.find("-->")
				.map_or(html.len(), |end| tag_start + 4 + end + 3);
			continue;
		}

		let Some(relative_end) = find_tag_end(&html[tag_start + 1..]) else {
			if ignored_depth == 0 {
				append_text(&html[tag_start..], &active, &mut sections);
			}
			break;
		};
		let tag_end = tag_start + 1 + relative_end;
		let raw_tag = html[tag_start + 1..tag_end].trim();
		cursor = tag_end + 1;
		if raw_tag.is_empty() || raw_tag.starts_with('!') || raw_tag.starts_with('?') {
			continue;
		}

		let closing = raw_tag.starts_with('/');
		let tag_body = raw_tag.trim_start_matches('/').trim_start();
		let tag_name_end = tag_body
			.find(|character: char| {
				character.is_ascii_whitespace() || character == '/' || character == '>'
			})
			.unwrap_or(tag_body.len());
		let tag_name = &tag_body[..tag_name_end];
		let self_closing = raw_tag.trim_end().ends_with('/');

		if tag_name.eq_ignore_ascii_case("script") || tag_name.eq_ignore_ascii_case("style") {
			if closing {
				ignored_depth = ignored_depth.saturating_sub(1);
			} else if !self_closing {
				ignored_depth += 1;
			}
			continue;
		}
		if ignored_depth != 0 {
			continue;
		}

		if closing {
			close_tag(tag_name, &mut active, &mut sections);
		} else {
			open_tag(tag_name, &mut active, &mut sections);
			if self_closing {
				close_tag(tag_name, &mut active, &mut sections);
			}
		}
	}

	for section in &mut sections {
		finish_paragraph(section);
	}
	sections
}

fn open_tag(tag: &str, active: &mut Vec<usize>, sections: &mut Vec<Section>) {
	if tag.eq_ignore_ascii_case("section") {
		let index = sections.len();
		sections.push(Section::default());
		active.push(index);
		return;
	}

	let heading_level = if tag.eq_ignore_ascii_case("h2") {
		Some(2)
	} else if tag.eq_ignore_ascii_case("h3") || tag.eq_ignore_ascii_case("h4") {
		Some(3)
	} else {
		None
	};
	if let Some(level) = heading_level {
		for &index in active.iter() {
			let section = &mut sections[index];
			if section.heading.is_none() {
				section.heading = Some(Heading { level, text: String::new() });
				section.heading_open = true;
			}
		}
		return;
	}

	if tag.eq_ignore_ascii_case("p") {
		for &index in active.iter() {
			finish_paragraph(&mut sections[index]);
			sections[index].paragraph = Some(String::new());
		}
	}
}

fn close_tag(tag: &str, active: &mut Vec<usize>, sections: &mut [Section]) {
	if tag.eq_ignore_ascii_case("h2")
		|| tag.eq_ignore_ascii_case("h3")
		|| tag.eq_ignore_ascii_case("h4")
	{
		for &index in active.iter() {
			sections[index].heading_open = false;
		}
	} else if tag.eq_ignore_ascii_case("p") {
		for &index in active.iter() {
			finish_paragraph(&mut sections[index]);
		}
	} else if tag.eq_ignore_ascii_case("section")
		&& let Some(index) = active.pop()
	{
		finish_paragraph(&mut sections[index]);
		sections[index].heading_open = false;
	}
}

fn append_text(text: &str, active: &[usize], sections: &mut [Section]) {
	if text.is_empty() || active.is_empty() {
		return;
	}
	let decoded = decode_entities(text);
	for &index in active {
		let section = &mut sections[index];
		if section.heading_open
			&& let Some(heading) = &mut section.heading
		{
			heading.text.push_str(&decoded);
		}
		if let Some(paragraph) = &mut section.paragraph {
			paragraph.push_str(&decoded);
		}
	}
}

fn finish_paragraph(section: &mut Section) {
	if let Some(paragraph) = section.paragraph.take() {
		section.paragraphs.push(paragraph);
	}
}

fn find_tag_end(input: &str) -> Option<usize> {
	let mut quote = None;
	for (index, character) in input.char_indices() {
		match (quote, character) {
			(Some(expected), found) if expected == found => quote = None,
			(None, '\'' | '"') => quote = Some(character),
			(None, '>') => return Some(index),
			_ => {},
		}
	}
	None
}

fn decode_component(input: &str) -> Option<String> {
	let bytes = input.as_bytes();
	let mut output = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%' {
			let high = hex(*bytes.get(index + 1)?)?;
			let low = hex(*bytes.get(index + 2)?)?;
			output.push((high << 4) | low);
			index += 3;
		} else {
			output.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8(output).ok()
}

fn encode_component(input: &str) -> String {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	let mut output = String::with_capacity(input.len());
	for byte in input.bytes() {
		if byte.is_ascii_alphanumeric()
			|| matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
		{
			output.push(char::from(byte));
		} else {
			output.push('%');
			output.push(char::from(HEX[usize::from(byte >> 4)]));
			output.push(char::from(HEX[usize::from(byte & 0x0f)]));
		}
	}
	output
}

fn decode_entities(input: &str) -> String {
	let mut output = String::with_capacity(input.len());
	let mut rest = input;
	while let Some(start) = rest.find('&') {
		output.push_str(&rest[..start]);
		rest = &rest[start..];
		let Some(end) = rest.find(';').filter(|end| *end <= 16) else {
			output.push('&');
			rest = &rest[1..];
			continue;
		};
		let entity = &rest[1..end];
		if let Some(decoded) = decode_entity(entity) {
			output.push(decoded);
			rest = &rest[end + 1..];
		} else {
			output.push('&');
			rest = &rest[1..];
		}
	}
	output.push_str(rest);
	output
}

fn decode_entity(entity: &str) -> Option<char> {
	match entity {
		"amp" => Some('&'),
		"lt" => Some('<'),
		"gt" => Some('>'),
		"quot" => Some('"'),
		"apos" | "#39" | "#039" | "#x27" | "#X27" => Some('\''),
		"nbsp" => Some('\u{a0}'),
		value if value.starts_with("#x") || value.starts_with("#X") => {
			char::from_u32(u32::from_str_radix(&value[2..], 16).ok()?)
		},
		value if value.starts_with('#') => char::from_u32(value[1..].parse().ok()?),
		_ => None,
	}
}

const fn hex(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		future::{Future, ready},
	};

	use bytes::Bytes;
	use omp_core::Str;
	use parking_lot::Mutex;
	use smallvec::SmallVec;

	use super::*;
	use crate::read::web::types::HttpResponse;

	#[derive(Default)]
	struct CannedClient {
		requests:  Mutex<Vec<HttpRequest>>,
		responses: Mutex<VecDeque<Result<HttpResponse, WebError>>>,
	}

	impl CannedClient {
		fn with_responses(responses: impl IntoIterator<Item = HttpResponse>) -> Self {
			Self {
				requests:  Mutex::new(Vec::new()),
				responses: Mutex::new(responses.into_iter().map(Ok).collect()),
			}
		}

		fn requested_urls(&self) -> Vec<String> {
			self
				.requests
				.lock()
				.iter()
				.map(|request| request.url.to_string())
				.collect()
		}
	}

	impl HttpClient for CannedClient {
		fn get(
			&self,
			request: HttpRequest,
		) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
			self.requests.lock().push(request);
			ready(
				self
					.responses
					.lock()
					.pop_front()
					.unwrap_or_else(|| Err(WebError::request("no canned response remains"))),
			)
		}
	}

	fn response(status: u16, content_type: &str, body: &'static str) -> HttpResponse {
		HttpResponse {
			final_url: sf!("https://en.wikipedia.org/wiki/Canonical_title"),
			status,
			content_type: Some(Str::new(content_type)),
			headers: SmallVec::new(),
			body: Bytes::from_static(body.as_bytes()),
		}
	}

	#[test]
	fn matches_localized_article_urls_only() {
		for target in [
			"https://en.wikipedia.org/wiki/Rust_(programming_language)",
			"https://zh_cn.wikipedia.org/wiki/Rust",
		] {
			assert!(matches(&Url::parse(target).expect("fixture URL parses")), "{target}");
		}
		for target in [
			"https://en.m.wikipedia.org/wiki/Rust_(programming_language)",
			"https://wikipedia.org/wiki/Rust",
			"https://en.wikipedia.org/",
			"https://en.wikipedia.org/w/index.php?title=Rust",
			"https://en.wiktionary.org/wiki/Rust",
			"https://en.wikipedia.org/wiki/",
		] {
			assert!(!matches(&Url::parse(target).expect("fixture URL parses")), "{target}");
		}
	}

	#[tokio::test]
	async fn renders_summary_canonical_title_body_and_metadata_exactly() {
		let client = CannedClient::with_responses([
			response(
				200,
				"application/json",
				r#"{"title":"Canonical C++","description":"General-purpose programming language","extract":"C++ is a compiled language."}"#,
			),
			response(
				200,
				"text/html",
				"<section><h2>History</h2><p>C++ was designed by <a \
				 href=\"/wiki/Bjarne_Stroustrup\">Bjarne \
				 Stroustrup</a>.</p></section><section><h3>Use</h3><p>It is widely used in systems \
				 software.</p></section><section><h2>References</h2><p>This terminal section must be \
				 omitted from the projection.</p></section>",
			),
		]);
		let target = Url::parse("https://en.wikipedia.org/wiki/C%2B%2B").expect("fixture URL parses");

		let result = render(&client, &target)
			.await
			.expect("Wikipedia rendering succeeds")
			.expect("fixture produces content");

		assert_eq!(
			result.content.as_str(),
			"# Canonical C++\n\n*General-purpose programming language*\n\nC++ is a compiled \
			 language.\n\n---\n\n## History\n\nC++ was designed by Bjarne Stroustrup.\n\n### \
			 Use\n\nIt is widely used in systems software."
		);
		assert_eq!(result.content_type.as_deref(), Some("text/markdown"));
		assert_eq!(result.method.as_str(), "wikipedia");
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
		assert_eq!(client.requested_urls(), vec![
			String::from("https://en.wikipedia.org/api/rest_v1/page/summary/C%2B%2B"),
			String::from("https://en.wikipedia.org/api/rest_v1/page/mobile-html/C%2B%2B"),
		]);
	}

	#[tokio::test]
	async fn keeps_exact_summary_only_projection_when_mobile_html_fails() {
		let client = CannedClient::with_responses([
			response(
				200,
				"application/json",
				r#"{"title":"Redirect target","extract":"The canonical summary survives."}"#,
			),
			response(503, "text/plain", "temporarily unavailable"),
		]);
		let target =
			Url::parse("https://en.wikipedia.org/wiki/Redirect_source").expect("fixture URL parses");

		let result = render(&client, &target)
			.await
			.expect("summary fallback succeeds")
			.expect("summary remains useful");

		assert_eq!(
			result.content.as_str(),
			"# Redirect target\n\nThe canonical summary survives.\n\n---"
		);
		assert_eq!(result.method.as_str(), "wikipedia");
		assert_eq!(client.requested_urls(), vec![
			String::from("https://en.wikipedia.org/api/rest_v1/page/summary/Redirect_source",),
			String::from("https://en.wikipedia.org/api/rest_v1/page/mobile-html/Redirect_source",),
		]);
	}

	#[tokio::test]
	async fn keeps_article_body_when_summary_is_unavailable() {
		let client = CannedClient::with_responses([
			response(
				404,
				"application/json",
				r#"{"type":"https://mediawiki.org/wiki/HyperSwitch/errors/not_found"}"#,
			),
			response(
				200,
				"text/html",
				"<section><h2>Available section</h2><p>The mobile article body remains available \
				 without its summary.</p></section>",
			),
		]);
		let target = Url::parse("https://fr.wikipedia.org/wiki/Article").expect("fixture URL parses");

		let result = render(&client, &target)
			.await
			.expect("partial Wikipedia rendering succeeds")
			.expect("mobile article body produces content");

		assert_eq!(
			result.content.as_str(),
			"## Available section\n\nThe mobile article body remains available without its summary."
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
	}

	#[tokio::test]
	async fn returns_none_for_non_article_url_without_fetching() {
		let client = CannedClient::default();
		let target =
			Url::parse("https://en.wikipedia.org/w/index.php?title=Rust").expect("fixture URL parses");

		assert_eq!(
			render(&client, &target)
				.await
				.expect("non-match is not an error"),
			None
		);
		assert!(client.requested_urls().is_empty());
	}
}
