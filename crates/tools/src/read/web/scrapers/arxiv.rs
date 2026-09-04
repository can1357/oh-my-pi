//! arXiv Atom API renderer.

use std::path::Path;

#[cfg(test)]
use omp_tool::Severity;
use omp_tool::{Diag, DiagKind};
use quick_xml::{
	Reader,
	escape::{resolve_xml_entity, unescape},
	events::{Event, attributes},
};
use url::Url;

use super::super::{
	super::markit,
	types::{HttpClient, HttpRequest, RenderResult, WebError},
};

const API: &str = "https://export.arxiv.org/api/query?id_list=";

#[derive(Clone, Copy, Eq, PartialEq)]
enum Capture {
	Title,
	Summary,
	Published,
	Author,
}

#[derive(Default)]
struct Entry {
	title:          String,
	summary:        String,
	published:      String,
	authors:        Vec<String>,
	categories:     Vec<String>,
	pdf_link:       Option<String>,
	title_seen:     bool,
	summary_seen:   bool,
	published_seen: bool,
}

/// Returns whether `url` is a supported arXiv paper URL.
pub(super) fn matches(url: &Url) -> bool {
	paper_id(url).is_some()
}

/// Renders arXiv paper metadata from the Atom API.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(target) = paper_target(url) else {
		return Ok(None);
	};
	let Ok(response) = client
		.get(HttpRequest::new(format!("{API}{}", target.id)))
		.await
	else {
		return Ok(None);
	};
	if !response.is_success()
		|| response.content_type.as_deref() == Some("application/pdf")
		|| response.body.starts_with(b"%PDF-")
	{
		return Ok(None);
	}

	let Some(entry) = parse_entry(response.body.as_ref()) else {
		return Ok(None);
	};
	let title = normalized_title(&entry.title);
	let summary = entry.summary.trim();
	let published = entry.published.trim().split('T').next().unwrap_or_default();

	let mut markdown = format!(
		"# {}\n\n",
		if title.is_empty() {
			"arXiv Paper"
		} else {
			&title
		}
	);
	if !entry.authors.is_empty() {
		markdown.push_str("**Authors:** ");
		markdown.push_str(&entry.authors.join(", "));
		markdown.push('\n');
	}
	if !published.is_empty() {
		markdown.push_str("**Published:** ");
		markdown.push_str(published);
		markdown.push('\n');
	}
	if !entry.categories.is_empty() {
		markdown.push_str("**Categories:** ");
		markdown.push_str(&entry.categories.join(", "));
		markdown.push('\n');
	}
	markdown.push_str("**arXiv:** ");
	markdown.push_str(target.id);
	markdown.push_str("\n\n---\n\n## Abstract\n\n");
	markdown.push_str(if summary.is_empty() {
		"No abstract available."
	} else {
		summary
	});
	markdown.push_str("\n\n");

	let mut diags = Vec::new();
	if target.pdf
		&& let Some(pdf_link) = entry.pdf_link
	{
		diags.push(Diag::info(DiagKind::Provenance, "Fetching PDF for full content"));
		if let Ok(pdf) = client.get(HttpRequest::new(pdf_link)).await
			&& pdf.is_success()
			&& let Ok(Some(converted)) = markit::convert_cached(
				client,
				markit::DocumentMetadata {
					path:       Path::new("paper.pdf"),
					media_type: Some("application/pdf"),
				},
				&pdf.body,
				markit::ConversionOptions::default(),
			)
			.await && converted.conversion.text.encode_utf16().count() > 500
		{
			markdown.push_str("---\n\n## Full Paper\n\n");
			markdown.push_str(&converted.conversion.text);
			markdown.push('\n');
			diags.push(Diag::info(DiagKind::Provenance, "PDF converted via markit"));
		}
	}

	let mut result = RenderResult::markdown(&markdown, "arxiv");
	if diags.is_empty() {
		result
			.diags
			.insert(0, Diag::info(DiagKind::Provenance, "Fetched via arXiv API"));
	} else {
		result.diags.extend(diags);
	}
	Ok(Some(result))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PaperTarget<'a> {
	id:  &'a str,
	pdf: bool,
}

fn paper_target(url: &Url) -> Option<PaperTarget<'_>> {
	if url.host_str()? != "arxiv.org" {
		return None;
	}

	let path = url.path();
	let abs = path.find("/abs/").map(|index| (index, "abs", "/abs/"));
	let pdf = path.find("/pdf/").map(|index| (index, "pdf", "/pdf/"));
	let (index, kind, marker) = match (abs, pdf) {
		(Some(abs), Some(pdf)) => {
			if abs.0 <= pdf.0 {
				abs
			} else {
				pdf
			}
		},
		(Some(target), None) | (None, Some(target)) => target,
		(None, None) => return None,
	};
	let candidate = &path[index + marker.len()..];
	if candidate.is_empty() {
		return None;
	}

	let id = candidate
		.strip_suffix(".pdf")
		.filter(|base| !base.is_empty())
		.unwrap_or(candidate);
	Some(PaperTarget { id, pdf: kind == "pdf" || path.contains(".pdf") })
}

fn paper_id(url: &Url) -> Option<&str> {
	paper_target(url).map(|target| target.id)
}

fn normalized_title(title: &str) -> String {
	let mut words = title.split_whitespace();
	let Some(first) = words.next() else {
		return String::new();
	};
	let mut normalized = String::with_capacity(title.len());
	normalized.push_str(first);
	for word in words {
		normalized.push(' ');
		normalized.push_str(word);
	}
	normalized
}

fn parse_entry(xml: &[u8]) -> Option<Entry> {
	let mut reader = Reader::from_reader(xml);
	let mut entry = Entry::default();
	let mut in_entry = false;
	let mut in_author = false;
	let mut capture = None;
	let mut author = String::new();

	loop {
		let Ok(event) = reader.read_event() else {
			return in_entry.then(|| finish_entry(entry, capture, &author));
		};
		match event {
			Event::Start(element) => {
				let name = element.local_name();
				match name.as_ref() {
					b"entry" if !in_entry => in_entry = true,
					b"author" if in_entry => in_author = true,
					b"title" if in_entry && !entry.title_seen => {
						entry.title_seen = true;
						capture = Some(Capture::Title);
					},
					b"summary" if in_entry && !entry.summary_seen => {
						entry.summary_seen = true;
						capture = Some(Capture::Summary);
					},
					b"published" if in_entry && !entry.published_seen => {
						entry.published_seen = true;
						capture = Some(Capture::Published);
					},
					b"name" if in_entry && in_author => {
						author.clear();
						capture = Some(Capture::Author);
					},
					b"category" if in_entry => append_category(&reader, &element, &mut entry),
					b"link" if in_entry => append_pdf_link(&reader, &element, &mut entry),
					_ => {},
				}
			},
			Event::Empty(element) => match element.local_name().as_ref() {
				b"entry" if !in_entry => return Some(entry),
				b"title" if in_entry => entry.title_seen = true,
				b"summary" if in_entry => entry.summary_seen = true,
				b"published" if in_entry => entry.published_seen = true,
				b"category" if in_entry => append_category(&reader, &element, &mut entry),
				b"link" if in_entry => append_pdf_link(&reader, &element, &mut entry),
				_ => {},
			},
			Event::Text(text) => {
				let decoded = text.decode().ok()?;
				let decoded = unescape(&decoded).ok()?;
				append_capture(capture, &decoded, &mut entry, &mut author);
			},
			Event::GeneralRef(reference) => {
				let name = reference.decode().ok()?;
				let decoded = decode_reference(&name);
				append_capture(capture, &decoded, &mut entry, &mut author);
			},
			Event::CData(text) => {
				let decoded = text.decode().ok()?;
				append_capture(capture, &decoded, &mut entry, &mut author);
			},
			Event::End(element) if in_entry => match element.local_name().as_ref() {
				b"name" if capture == Some(Capture::Author) => {
					push_author(&mut entry, &author);
					capture = None;
				},
				b"author" => in_author = false,
				b"title" if capture == Some(Capture::Title) => capture = None,
				b"summary" if capture == Some(Capture::Summary) => capture = None,
				b"published" if capture == Some(Capture::Published) => capture = None,
				b"entry" => return Some(finish_entry(entry, capture, &author)),
				_ => {},
			},
			Event::Eof => return in_entry.then(|| finish_entry(entry, capture, &author)),
			_ => {},
		}
	}
}

fn finish_entry(mut entry: Entry, capture: Option<Capture>, author: &str) -> Entry {
	if capture == Some(Capture::Author) {
		push_author(&mut entry, author);
	}
	entry
}

fn push_author(entry: &mut Entry, author: &str) {
	let author = author.trim();
	if !author.is_empty() {
		entry.authors.push(author.to_owned());
	}
}

fn decode_reference(name: &str) -> String {
	let (digits, radix) =
		if let Some(digits) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
			(digits, 16)
		} else if let Some(digits) = name.strip_prefix('#') {
			(digits, 10)
		} else {
			let lower;
			let normalized = if resolve_named_entity(name).is_some() {
				name
			} else {
				lower = name.to_ascii_lowercase();
				&lower
			};
			return resolve_named_entity(normalized)
				.map_or_else(|| format!("&{name};"), ToOwned::to_owned);
		};

	let syntactically_valid = !digits.is_empty()
		&& digits.bytes().all(|byte| {
			if radix == 16 {
				byte.is_ascii_hexdigit()
			} else {
				byte.is_ascii_digit()
			}
		});
	if !syntactically_valid {
		return format!("&{name};");
	}
	u32::from_str_radix(digits, radix)
		.ok()
		.filter(|codepoint| *codepoint != 0)
		.and_then(char::from_u32)
		.unwrap_or('\u{fffd}')
		.to_string()
}

fn resolve_named_entity(name: &str) -> Option<&'static str> {
	resolve_xml_entity(name).or(match name {
		"AElig" => Some("Æ"),
		"Aacute" => Some("Á"),
		"Acirc" => Some("Â"),
		"Agrave" => Some("À"),
		"Aring" => Some("Å"),
		"Atilde" => Some("Ã"),
		"Auml" => Some("Ä"),
		"Ccedil" => Some("Ç"),
		"ETH" => Some("Ð"),
		"Eacute" => Some("É"),
		"Ecirc" => Some("Ê"),
		"Egrave" => Some("È"),
		"Euml" => Some("Ë"),
		"Iacute" => Some("Í"),
		"Icirc" => Some("Î"),
		"Igrave" => Some("Ì"),
		"Iuml" => Some("Ï"),
		"Ntilde" => Some("Ñ"),
		"Oacute" => Some("Ó"),
		"Ocirc" => Some("Ô"),
		"Ograve" => Some("Ò"),
		"Oslash" => Some("Ø"),
		"Otilde" => Some("Õ"),
		"Ouml" => Some("Ö"),
		"THORN" => Some("Þ"),
		"Uacute" => Some("Ú"),
		"Ucirc" => Some("Û"),
		"Ugrave" => Some("Ù"),
		"Uuml" => Some("Ü"),
		"Yacute" => Some("Ý"),
		"aacute" => Some("á"),
		"acirc" => Some("â"),
		"aelig" => Some("æ"),
		"agrave" => Some("à"),
		"aring" => Some("å"),
		"atilde" => Some("ã"),
		"auml" => Some("ä"),
		"brvbar" => Some("¦"),
		"bull" => Some("•"),
		"ccedil" => Some("ç"),
		"cedil" => Some("¸"),
		"cent" => Some("¢"),
		"copy" => Some("©"),
		"curren" => Some("¤"),
		"deg" => Some("°"),
		"divide" => Some("÷"),
		"eacute" => Some("é"),
		"ecirc" => Some("ê"),
		"egrave" => Some("è"),
		"emsp" => Some("\u{2003}"),
		"ensp" => Some("\u{2002}"),
		"eth" => Some("ð"),
		"euml" => Some("ë"),
		"euro" => Some("€"),
		"frac12" => Some("½"),
		"frac14" => Some("¼"),
		"frac34" => Some("¾"),
		"hellip" => Some("…"),
		"iacute" => Some("í"),
		"icirc" => Some("î"),
		"iexcl" => Some("¡"),
		"igrave" => Some("ì"),
		"iquest" => Some("¿"),
		"iuml" => Some("ï"),
		"laquo" => Some("«"),
		"ldquo" => Some("“"),
		"lsquo" => Some("‘"),
		"macr" => Some("¯"),
		"mdash" => Some("—"),
		"micro" => Some("µ"),
		"middot" => Some("·"),
		"nbsp" => Some("\u{a0}"),
		"ndash" => Some("–"),
		"ntilde" => Some("ñ"),
		"oacute" => Some("ó"),
		"ocirc" => Some("ô"),
		"ograve" => Some("ò"),
		"ordf" => Some("ª"),
		"ordm" => Some("º"),
		"oslash" => Some("ø"),
		"otilde" => Some("õ"),
		"ouml" => Some("ö"),
		"para" => Some("¶"),
		"plusmn" => Some("±"),
		"pound" => Some("£"),
		"raquo" => Some("»"),
		"rdquo" => Some("”"),
		"reg" => Some("®"),
		"rsquo" => Some("’"),
		"sect" => Some("§"),
		"shy" => Some("\u{ad}"),
		"sup1" => Some("¹"),
		"sup2" => Some("²"),
		"sup3" => Some("³"),
		"szlig" => Some("ß"),
		"thinsp" => Some("\u{2009}"),
		"thorn" => Some("þ"),
		"times" => Some("×"),
		"trade" => Some("™"),
		"uacute" => Some("ú"),
		"ucirc" => Some("û"),
		"ugrave" => Some("ù"),
		"uml" => Some("¨"),
		"uuml" => Some("ü"),
		"yacute" => Some("ý"),
		"yen" => Some("¥"),
		"yuml" => Some("ÿ"),
		_ => None,
	})
}

fn decode_entities(input: &str) -> String {
	let mut output = String::with_capacity(input.len());
	let mut rest = input;
	while let Some(start) = rest.find('&') {
		output.push_str(&rest[..start]);
		rest = &rest[start..];
		let Some(end) = rest.find(';') else {
			output.push_str(rest);
			return output;
		};
		let name = &rest[1..end];
		if !is_reference_name(name) {
			output.push('&');
			rest = &rest[1..];
			continue;
		}
		output.push_str(&decode_reference(name));
		rest = &rest[end + 1..];
	}
	output.push_str(rest);
	output
}

fn is_reference_name(name: &str) -> bool {
	if let Some(digits) = name.strip_prefix('#') {
		if let Some(hex) = digits
			.strip_prefix('x')
			.or_else(|| digits.strip_prefix('X'))
		{
			return !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
		}
		return !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit());
	}
	let mut bytes = name.bytes();
	bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
		&& bytes.all(|byte| byte.is_ascii_alphanumeric())
}

fn decode_attribute(
	reader: &Reader<&[u8]>,
	attribute: &attributes::Attribute<'_>,
) -> Option<String> {
	let value = reader.decoder().decode(attribute.value.as_ref()).ok()?;
	Some(decode_entities(&value))
}

fn append_category(
	reader: &Reader<&[u8]>,
	element: &quick_xml::events::BytesStart<'_>,
	entry: &mut Entry,
) {
	for attribute in element.attributes().flatten() {
		if attribute.key.local_name().as_ref() != b"term" {
			continue;
		}
		let Some(term) = decode_attribute(reader, &attribute) else {
			continue;
		};
		if !term.is_empty() {
			entry.categories.push(term);
		}
	}
}

fn append_pdf_link(
	reader: &Reader<&[u8]>,
	element: &quick_xml::events::BytesStart<'_>,
	entry: &mut Entry,
) {
	let mut is_pdf = false;
	let mut href = None;
	for attribute in element.attributes().flatten() {
		let Some(value) = decode_attribute(reader, &attribute) else {
			continue;
		};
		match attribute.key.local_name().as_ref() {
			b"title" => is_pdf = value == "pdf",
			b"href" => href = Some(value),
			_ => {},
		}
	}
	if is_pdf && entry.pdf_link.is_none() {
		entry.pdf_link = href.filter(|value| !value.is_empty());
	}
}

fn append_capture(capture: Option<Capture>, text: &str, entry: &mut Entry, author: &mut String) {
	match capture {
		Some(Capture::Title) => entry.title.push_str(text),
		Some(Capture::Summary) => entry.summary.push_str(text),
		Some(Capture::Published) => entry.published.push_str(text),
		Some(Capture::Author) => author.push_str(text),
		None => {},
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		future::{Future, ready},
	};

	use bytes::Bytes;
	use parking_lot::Mutex;
	use smallvec::SmallVec;

	use super::*;
	use crate::read::web::types::HttpResponse;

	const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title> A &amp; &#x3B1;
      paper title </title>
    <summary>First&nbsp;&lt;line&gt; &#38; &#x3B1; &copy;.</summary>
    <published>2025-01-02T03:04:05Z</published>
    <author><name>Ada &amp; Alan</name></author>
    <author><name>Grace Hopper</name></author>
    <category term="cs.AI&amp;ML"/>
    <category term="cs.LG"/>
    <link title="pdf" href="https://arxiv.org/pdf/2501.01234.pdf?download=1&amp;x=2"/>
  </entry>
</feed>"#;

	struct FakeClient {
		requests:  Mutex<Vec<HttpRequest>>,
		responses: Mutex<VecDeque<Result<HttpResponse, WebError>>>,
	}

	impl FakeClient {
		fn new(responses: impl IntoIterator<Item = Result<HttpResponse, WebError>>) -> Self {
			Self {
				requests:  Mutex::new(Vec::new()),
				responses: Mutex::new(responses.into_iter().collect()),
			}
		}
	}

	impl HttpClient for FakeClient {
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
					.expect("unexpected HTTP request"),
			)
		}
	}

	fn response(status: u16, content_type: &str, body: impl Into<Bytes>) -> HttpResponse {
		HttpResponse {
			final_url: "https://export.arxiv.org/api/query".into(),
			status,
			content_type: Some(content_type.into()),
			headers: SmallVec::new(),
			body: body.into(),
		}
	}

	#[test]
	fn normalizes_pi_abs_pdf_legacy_and_versioned_routes() {
		for (url, expected, pdf) in [
			("https://arxiv.org/abs/2501.0123", "2501.0123", false),
			("https://arxiv.org/abs/2501.01234v2", "2501.01234v2", false),
			("https://arxiv.org/pdf/2501.01234v12.pdf", "2501.01234v12", true),
			("https://arxiv.org/abs/hep-th/9901001", "hep-th/9901001", false),
			("https://arxiv.org/pdf/math.GT/0309136.pdf", "math.GT/0309136", true),
			("https://arxiv.org/abs/custom/id.pdf", "custom/id", true),
			("https://arxiv.org/archive/abs/custom-id", "custom-id", false),
			("https://arxiv.org/pdf/.pdf", ".pdf", true),
		] {
			let parsed = Url::parse(url).unwrap();
			assert_eq!(paper_target(&parsed), Some(PaperTarget { id: expected, pdf }));
			assert_eq!(paper_id(&parsed), Some(expected));
		}

		for url in [
			"https://arxiv.org/html/2501.01234",
			"https://export.arxiv.org/abs/2501.01234",
			"https://arxiv.org/abs/",
		] {
			assert!(!matches(&Url::parse(url).unwrap()), "{url}");
		}
	}

	#[tokio::test]
	async fn abs_route_renders_decoded_atom_metadata_and_abstract_exactly() {
		let client = FakeClient::new([Ok(response(200, "application/atom+xml", FEED))]);
		let url = Url::parse("https://arxiv.org/abs/2501.01234v2").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			client.requests.lock()[0].url.as_str(),
			"https://export.arxiv.org/api/query?id_list=2501.01234v2"
		);
		assert_eq!(
			result.content.as_str(),
			"# A & α paper title\n\n**Authors:** Ada & Alan, Grace Hopper\n**Published:** \
			 2025-01-02\n**Categories:** cs.AI&ML, cs.LG\n**arXiv:** 2501.01234v2\n\n---\n\n## \
			 Abstract\n\nFirst\u{a0}<line> & α ©."
		);
		assert_eq!(result.content_type.as_deref(), Some("text/markdown"));
		assert_eq!(result.method.as_str(), "arxiv");
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
	}

	#[tokio::test]
	async fn pdf_route_fetches_link_and_keeps_metadata_when_conversion_fails() {
		let client = FakeClient::new([
			Ok(response(200, "application/atom+xml", FEED)),
			Ok(response(200, "application/pdf", Bytes::from_static(b"not a PDF"))),
		]);
		let url = Url::parse("https://arxiv.org/pdf/2501.01234v3.pdf").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		let requests = client.requests.lock();
		assert_eq!(requests.len(), 2);
		assert_eq!(
			requests[0].url.as_str(),
			"https://export.arxiv.org/api/query?id_list=2501.01234v3"
		);
		assert_eq!(requests[1].url.as_str(), "https://arxiv.org/pdf/2501.01234.pdf?download=1&x=2");
		assert_eq!(
			result.content.as_str(),
			"# A & α paper title\n\n**Authors:** Ada & Alan, Grace Hopper\n**Published:** \
			 2025-01-02\n**Categories:** cs.AI&ML, cs.LG\n**arXiv:** 2501.01234v3\n\n---\n\n## \
			 Abstract\n\nFirst\u{a0}<line> & α ©."
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
	}

	#[tokio::test]
	async fn missing_metadata_uses_pi_fallbacks() {
		let feed = "<feed><entry><title> \n </title><summary> </summary></entry></feed>";
		let client = FakeClient::new([Ok(response(200, "application/atom+xml", feed))]);
		let result = render(&client, &Url::parse("https://arxiv.org/abs/2501.01234").unwrap())
			.await
			.unwrap()
			.unwrap();
		assert_eq!(
			result.content.as_str(),
			"# arXiv Paper\n\n**arXiv:** 2501.01234\n\n---\n\n## Abstract\n\nNo abstract available."
		);
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
	}

	#[tokio::test]
	async fn malformed_feeds_follow_pi_tolerant_dom_semantics() {
		let client = FakeClient::new([Ok(response(200, "application/atom+xml", "<feed/>"))]);
		assert!(
			render(&client, &Url::parse("https://arxiv.org/abs/2501.01234").unwrap())
				.await
				.unwrap()
				.is_none()
		);

		for (feed, expected) in [
			(
				"<feed><entry/>",
				"# arXiv Paper\n\n**arXiv:** 2501.01234\n\n---\n\n## Abstract\n\nNo abstract \
				 available.",
			),
			(
				"<feed><entry><title>unfinished</title>",
				"# unfinished\n\n**arXiv:** 2501.01234\n\n---\n\n## Abstract\n\nNo abstract available.",
			),
			(
				"<feed><entry><summary>&bogus;</summary></entry></feed>",
				"# arXiv Paper\n\n**arXiv:** 2501.01234\n\n---\n\n## Abstract\n\n&bogus;",
			),
		] {
			let client = FakeClient::new([Ok(response(200, "application/atom+xml", feed))]);
			let result = render(&client, &Url::parse("https://arxiv.org/abs/2501.01234").unwrap())
				.await
				.unwrap()
				.unwrap();
			assert_eq!(result.content.as_str(), expected);
		}

		let client = FakeClient::new([Err(WebError::request("offline"))]);
		assert!(
			render(&client, &Url::parse("https://arxiv.org/abs/2501.01234").unwrap())
				.await
				.unwrap()
				.is_none()
		);

		for response in [
			response(503, "application/atom+xml", FEED),
			response(200, "application/pdf", FEED),
			response(200, "application/octet-stream", Bytes::from_static(b"%PDF-1.7")),
		] {
			let client = FakeClient::new([Ok(response)]);
			assert!(
				render(&client, &Url::parse("https://arxiv.org/abs/2501.01234").unwrap())
					.await
					.unwrap()
					.is_none()
			);
		}
	}
}
