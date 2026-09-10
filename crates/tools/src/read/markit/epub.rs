//! EPUB to deterministic Markdown conversion.

use std::collections::BTreeMap;

use html_to_markdown_rs::{ConversionOptions, PreprocessingOptions, TierStrategy};
use omp_core::{IntoStr, Str};
use quick_xml::{Reader, XmlVersion, events::Event};

use super::{
	MarkitError,
	ooxml::{Archive, decode_xml_bytes},
};

const FORMAT: &str = "epub";
const MAX_XML_DEPTH: usize = 256;
const MAX_XML_NODES: usize = 2_000_000;

#[derive(Clone, Debug, Default)]
struct Node {
	name:     String,
	attrs:    BTreeMap<String, String>,
	children: Vec<Content>,
}

#[derive(Clone, Debug)]
enum Content {
	Element(Node),
	Text(String),
}

impl Node {
	fn attr(&self, name: &str) -> Option<&str> {
		self
			.attrs
			.get(name)
			.or_else(|| self.attrs.get(local(name)))
			.map(String::as_str)
	}

	fn elements(&self) -> impl Iterator<Item = &Self> {
		self.children.iter().filter_map(|child| match child {
			Content::Element(node) => Some(node),
			Content::Text(_) => None,
		})
	}

	fn text(&self) -> String {
		let mut text = String::new();
		collect_text(self, &mut text);
		collapse_whitespace(&text)
	}
}

#[derive(Clone, Debug, Default)]
struct Metadata {
	title:       Option<String>,
	creators:    Vec<String>,
	language:    Option<String>,
	publisher:   Option<String>,
	date:        Option<String>,
	description: Option<String>,
}

#[derive(Debug)]
struct ManifestItem {
	path: Option<String>,
}

#[derive(Debug, Default)]
struct Package {
	metadata: Metadata,
	manifest: BTreeMap<String, ManifestItem>,
	spine:    Vec<String>,
}

/// Converts an EPUB package to Markdown in its declared reading order.
pub(super) fn convert(bytes: &[u8]) -> Result<(Str, Option<Str>), MarkitError> {
	let mut archive = Archive::open(bytes).map_err(failure)?;
	let container = read_xml_member(&mut archive, "META-INF/container.xml")?
		.ok_or_else(|| failure("Invalid EPUB: missing container.xml"))?;
	let opf_path = parse_container(&container)?;
	let opf_xml = read_xml_member(&mut archive, &opf_path)?
		.ok_or_else(|| failure("Invalid EPUB: missing content.opf"))?;
	let package = parse_package(&opf_xml, &opf_path)?;
	let title = package.metadata.title.clone().map(Str::new);

	let mut sections = metadata_sections(&package.metadata);
	let options = epub_html_options();
	let mut declared_parts = 0usize;
	let mut readable_parts = 0usize;
	for idref in &package.spine {
		let Some(item) = package.manifest.get(idref) else {
			continue;
		};
		declared_parts += 1;
		let Some(path) = item.path.as_deref() else {
			continue;
		};
		let Some(xhtml) = read_xml_member(&mut archive, path)? else {
			continue;
		};
		readable_parts += 1;
		let cleaned = normalize_table_cells(&strip_script_and_style(strip_xml_declaration(&xhtml)));
		let converted = html_to_markdown_rs::convert(&cleaned, options.clone())
			.map_err(|error| failure(format!("{path}: {error}")))?;
		let markdown = normalize_converted_markdown(&converted.content.unwrap_or_default());
		let markdown = markdown.trim();
		if !markdown.is_empty() {
			sections.push(markdown.to_owned());
		}
	}
	if declared_parts > 0 && readable_parts == 0 {
		return Err(failure("Invalid EPUB: no spine document could be read"));
	}

	Ok((Str::new(sections.join("\n\n").trim()), title))
}

fn epub_html_options() -> ConversionOptions {
	ConversionOptions {
		bullets: "-".into(),
		autolinks: false,
		compact_tables: true,
		escape_asterisks: true,
		escape_underscores: true,
		extract_metadata: false,
		preprocessing: PreprocessingOptions { enabled: false, ..Default::default() },
		tier_strategy: TierStrategy::Tier2,
		..Default::default()
	}
}

fn parse_container(xml: &str) -> Result<String, MarkitError> {
	let root = parse_xml(xml)?;
	let mut rootfiles = Vec::new();
	descendants(&root, "rootfile", &mut rootfiles);
	rootfiles
		.first()
		.and_then(|node| node.attr("full-path"))
		.map(str::to_owned)
		.ok_or_else(|| failure("Invalid EPUB: missing rootfile path"))
}

fn parse_package(xml: &str, opf_path: &str) -> Result<Package, MarkitError> {
	let root = parse_xml(xml)?;
	let Some(package_node) = descendant(&root, "package") else {
		return Ok(Package::default());
	};
	let metadata = child(package_node, "metadata")
		.map(parse_metadata)
		.unwrap_or_default();

	let mut manifest = BTreeMap::new();
	if let Some(manifest_node) = child(package_node, "manifest") {
		for item in manifest_node
			.elements()
			.filter(|node| local(&node.name) == "item")
		{
			let (Some(id), Some(href)) = (item.attr("id"), item.attr("href")) else {
				continue;
			};
			let path = package_member_path(opf_path, href).ok();
			manifest.insert(id.to_owned(), ManifestItem { path });
		}
	}

	let mut spine = Vec::new();
	if let Some(spine_node) = child(package_node, "spine") {
		for itemref in spine_node
			.elements()
			.filter(|node| local(&node.name) == "itemref")
		{
			if let Some(idref) = itemref.attr("idref") {
				spine.push(idref.to_owned());
			}
		}
	}

	Ok(Package { metadata, manifest, spine })
}

fn parse_metadata(metadata: &Node) -> Metadata {
	let values = |name: &str| {
		metadata
			.elements()
			.filter(|node| local(&node.name) == name)
			.map(Node::text)
			.filter(|value| !value.is_empty())
			.collect::<Vec<_>>()
	};
	let first = |name: &str| values(name).into_iter().next();
	Metadata {
		title:       first("title"),
		creators:    values("creator"),
		language:    first("language"),
		publisher:   first("publisher"),
		date:        first("date"),
		description: first("description"),
	}
}

fn package_member_path(opf_path: &str, href: &str) -> Result<String, MarkitError> {
	let (href, _) = href.split_once('#').unwrap_or((href, ""));
	let href = href.split_once('?').map_or(href, |(path, _)| path);
	if href.is_empty() {
		return Ok(opf_path.to_owned());
	}

	let mut segments = Vec::new();
	if !href.starts_with('/')
		&& let Some((directory, _)) = opf_path.rsplit_once('/')
	{
		segments.extend(
			directory
				.split('/')
				.filter(|segment| !segment.is_empty())
				.map(str::to_owned),
		);
	}
	for raw in href.split('/') {
		match raw {
			"" | "." => {},
			".." => {
				segments.pop();
			},
			raw => {
				let decoded = decode_uri_component(raw);
				if decoded.contains(['/', '\\']) || matches!(decoded.as_str(), "." | "..") {
					return Err(failure(format!(
						"Invalid EPUB: unsafe encoded package path segment '{raw}'"
					)));
				}
				segments.push(decoded);
			},
		}
	}
	Ok(segments.join("/"))
}

fn decode_uri_component(component: &str) -> String {
	let bytes = component.as_bytes();
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut index = 0usize;
	while index < bytes.len() {
		if bytes[index] == b'%'
			&& let Some(hex) = component.get(index + 1..index + 3)
			&& hex.bytes().all(|byte| byte.is_ascii_hexdigit())
			&& let Ok(byte) = u8::from_str_radix(hex, 16)
		{
			decoded.push(byte);
			index += 3;
		} else {
			decoded.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8_lossy(&decoded).into_owned()
}

fn strip_xml_declaration(xml: &str) -> &str {
	let trimmed = xml.trim_start();
	let Some(declaration) = trimmed.strip_prefix("<?xml") else {
		return xml;
	};
	if !declaration
		.as_bytes()
		.first()
		.is_some_and(u8::is_ascii_whitespace)
	{
		return xml;
	}
	declaration
		.find("?>")
		.map_or(xml, |end| &declaration[end + 2..])
}

fn strip_script_and_style(html: &str) -> String {
	let mut output = String::with_capacity(html.len());
	let mut rest = html;
	loop {
		let script = find_ascii_case_insensitive(rest, "<script").map(|index| (index, "script"));
		let style = find_ascii_case_insensitive(rest, "<style").map(|index| (index, "style"));
		let next = match (script, style) {
			(Some(script), Some(style)) => Some(if script.0 <= style.0 { script } else { style }),
			(Some(script), None) => Some(script),
			(None, Some(style)) => Some(style),
			(None, None) => None,
		};
		let Some((start, element)) = next else {
			output.push_str(rest);
			break;
		};
		let closing = format!("</{element}>");
		let Some(close) = find_ascii_case_insensitive(&rest[start..], &closing) else {
			output.push_str(rest);
			break;
		};
		output.push_str(&rest[..start]);
		rest = &rest[start + close + closing.len()..];
	}
	output
}

fn find_ascii_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
	haystack
		.as_bytes()
		.windows(needle.len())
		.position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn normalize_table_cells(html: &str) -> String {
	let mut output = String::with_capacity(html.len());
	let mut rest = html;
	loop {
		let td = find_cell_start(rest, "td").map(|index| (index, "td"));
		let th = find_cell_start(rest, "th").map(|index| (index, "th"));
		let next = match (td, th) {
			(Some(td), Some(th)) => Some(if td.0 <= th.0 { td } else { th }),
			(Some(td), None) => Some(td),
			(None, Some(th)) => Some(th),
			(None, None) => None,
		};
		let Some((start, tag)) = next else {
			output.push_str(rest);
			break;
		};
		let Some(open_end) = rest[start..].find('>').map(|index| start + index + 1) else {
			output.push_str(rest);
			break;
		};
		let closing = format!("</{tag}>");
		let Some(close_start) =
			find_ascii_case_insensitive(&rest[open_end..], &closing).map(|index| open_end + index)
		else {
			output.push_str(rest);
			break;
		};
		output.push_str(&rest[..open_end]);
		output.push_str(&join_cell_paragraphs(&rest[open_end..close_start]));
		output.push_str(&rest[close_start..close_start + closing.len()]);
		rest = &rest[close_start + closing.len()..];
	}
	output
}

fn find_cell_start(html: &str, tag: &str) -> Option<usize> {
	let needle = format!("<{tag}");
	let mut offset = 0usize;
	while let Some(relative) = find_ascii_case_insensitive(&html[offset..], &needle) {
		let index = offset + relative;
		let boundary = html.as_bytes().get(index + needle.len()).copied();
		if boundary.is_some_and(|byte| byte == b'>' || byte.is_ascii_whitespace()) {
			return Some(index);
		}
		offset = index + needle.len();
	}
	None
}

fn join_cell_paragraphs(inner: &str) -> String {
	let leading = inner.len() - inner.trim_start_matches(char::is_whitespace).len();
	let after_leading = &inner[leading..];
	let mut body = if after_leading
		.get(..3)
		.is_some_and(|tag| tag.eq_ignore_ascii_case("<p>"))
	{
		&after_leading[3..]
	} else {
		inner
	};
	let trimmed_end = body.trim_end_matches(char::is_whitespace);
	if trimmed_end
		.get(trimmed_end.len().saturating_sub(4)..)
		.is_some_and(|tag| tag.eq_ignore_ascii_case("</p>"))
	{
		body = &trimmed_end[..trimmed_end.len() - 4];
	}

	let mut output = String::with_capacity(body.len());
	let mut rest = body;
	while let Some(close) = find_ascii_case_insensitive(rest, "</p>") {
		let after_close = &rest[close + 4..];
		let whitespace =
			after_close.len() - after_close.trim_start_matches(char::is_whitespace).len();
		let after_whitespace = &after_close[whitespace..];
		if after_whitespace
			.get(..3)
			.is_some_and(|tag| tag.eq_ignore_ascii_case("<p>"))
		{
			output.push_str(&rest[..close]);
			output.push(' ');
			rest = &after_whitespace[3..];
		} else {
			output.push_str(&rest[..close + 4]);
			rest = after_close;
		}
	}
	output.push_str(rest);
	output
}

fn normalize_converted_markdown(markdown: &str) -> String {
	markdown
		.lines()
		.map(|line| {
			if line.trim_start().starts_with('|') {
				line.replace("\\|", "|")
			} else {
				line.to_owned()
			}
		})
		.collect::<Vec<_>>()
		.join("\n")
}

fn metadata_sections(metadata: &Metadata) -> Vec<String> {
	let mut lines = Vec::new();
	if let Some(title) = metadata.title.as_deref() {
		lines.push(format!("**Title:** {title}"));
	}
	if !metadata.creators.is_empty() {
		lines.push(format!("**Authors:** {}", metadata.creators.join(", ")));
	}
	for (label, value) in [
		("Language", metadata.language.as_deref()),
		("Publisher", metadata.publisher.as_deref()),
		("Date", metadata.date.as_deref()),
		("Description", metadata.description.as_deref()),
	] {
		if let Some(value) = value {
			lines.push(format!("**{label}:** {value}"));
		}
	}
	if lines.is_empty() {
		Vec::new()
	} else {
		vec![lines.join("\n")]
	}
}

fn parse_xml(xml: &str) -> Result<Node, MarkitError> {
	let mut reader = Reader::from_str(xml);
	reader.config_mut().trim_text(false);
	let mut stack = vec![Node { name: "root".to_owned(), ..Node::default() }];
	let mut nodes = 0usize;
	loop {
		match reader.read_event() {
			Ok(Event::Start(event)) => {
				if stack.len() > MAX_XML_DEPTH {
					return Err(failure(format!("XML element nesting exceeds {MAX_XML_DEPTH}")));
				}
				bump_xml_nodes(&mut nodes)?;
				stack.push(event_node(&event)?);
			},
			Ok(Event::Empty(event)) => {
				bump_xml_nodes(&mut nodes)?;
				let node = event_node(&event)?;
				stack
					.last_mut()
					.expect("XML root exists")
					.children
					.push(Content::Element(node));
			},
			Ok(Event::End(_)) => {
				if stack.len() == 1 {
					return Err(failure("unexpected XML closing tag"));
				}
				let node = stack.pop().expect("XML element exists");
				stack
					.last_mut()
					.expect("XML root exists")
					.children
					.push(Content::Element(node));
			},
			Ok(Event::Text(event)) => {
				bump_xml_nodes(&mut nodes)?;
				let decoded = event.xml_content(XmlVersion::Implicit1_0);
				let text =
					quick_xml::escape::unescape(&decoded).map_err(|error| failure(error.to_string()))?;
				stack
					.last_mut()
					.expect("XML root exists")
					.children
					.push(Content::Text(text.into_owned()));
			},
			Ok(Event::GeneralRef(event)) => {
				bump_xml_nodes(&mut nodes)?;
				let text = if let Some(character) = event
					.resolve_char_ref()
					.map_err(|error| failure(error.to_string()))?
				{
					character.to_string()
				} else {
					let name = event.as_ref();
					quick_xml::escape::resolve_predefined_entity(name)
						.map_or_else(|| format!("&{name};"), str::to_owned)
				};
				stack
					.last_mut()
					.expect("XML root exists")
					.children
					.push(Content::Text(text));
			},
			Ok(Event::CData(event)) => {
				bump_xml_nodes(&mut nodes)?;
				let text = event.as_ref().to_owned();
				stack
					.last_mut()
					.expect("XML root exists")
					.children
					.push(Content::Text(text));
			},
			Ok(Event::Eof) => break,
			Ok(_) => {},
			Err(error) => return Err(failure(error.to_string())),
		}
	}
	if stack.len() != 1 {
		return Err(failure("unterminated XML element"));
	}
	Ok(stack.pop().expect("XML root exists"))
}

fn bump_xml_nodes(nodes: &mut usize) -> Result<(), MarkitError> {
	*nodes += 1;
	if *nodes > MAX_XML_NODES {
		return Err(failure(format!("XML node count exceeds {MAX_XML_NODES}")));
	}
	Ok(())
}

fn event_node(event: &quick_xml::events::BytesStart<'_>) -> Result<Node, MarkitError> {
	let name = event.name().as_ref().to_owned();
	let mut attrs = BTreeMap::new();
	for attribute in event.attributes().with_checks(false) {
		let attribute = attribute.map_err(|error| failure(error.to_string()))?;
		let key = attribute.key.as_ref().to_owned();
		let value = attribute
			.normalized_value(XmlVersion::Implicit1_0)
			.map_err(|error| failure(error.to_string()))?
			.into_owned();
		attrs.insert(key.clone(), value.clone());
		attrs.entry(local(&key).to_owned()).or_insert(value);
	}
	Ok(Node { name, attrs, children: Vec::new() })
}

fn read_xml_member(archive: &mut Archive<'_>, path: &str) -> Result<Option<String>, MarkitError> {
	archive
		.read_xml(path)
		.map_err(failure)?
		.map(|bytes| {
			decode_epub_xml_bytes(&bytes)
				.map_err(|error| failure(format!("'{path}' is not valid XML text: {error}")))
		})
		.transpose()
}

fn decode_epub_xml_bytes(bytes: &[u8]) -> Result<String, String> {
	match decode_xml_bytes(bytes) {
		Ok(text) => Ok(text),
		Err(utf_error) => {
			let Some(label) = declared_xml_encoding(bytes) else {
				return Err(utf_error);
			};
			let Some(encoding) = encoding_rs::Encoding::for_label(label.as_bytes()) else {
				return Err(format!("unsupported declared encoding '{label}'"));
			};
			if encoding == encoding_rs::UTF_8 {
				return Err(utf_error);
			}
			let (decoded, ..) = encoding.decode(bytes);
			Ok(decoded.into_owned())
		},
	}
}

fn declared_xml_encoding(bytes: &[u8]) -> Option<String> {
	let head = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]);
	let index = head.find("encoding")?;
	let rest = head[index + "encoding".len()..].trim_start();
	let rest = rest.strip_prefix('=')?.trim_start();
	let quote = rest
		.chars()
		.next()
		.filter(|character| matches!(character, '"' | '\''))?;
	let value = &rest[quote.len_utf8()..];
	let end = value.find(quote)?;
	Some(value[..end].to_owned())
}

fn collect_text(node: &Node, output: &mut String) {
	for child in &node.children {
		match child {
			Content::Text(text) => {
				output.push_str(text);
				output.push(' ');
			},
			Content::Element(node) => collect_text(node, output),
		}
	}
}

fn collapse_whitespace(value: &str) -> String {
	value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn child<'a>(node: &'a Node, name: &str) -> Option<&'a Node> {
	node.elements().find(|child| local(&child.name) == name)
}

fn descendant<'a>(node: &'a Node, name: &str) -> Option<&'a Node> {
	if local(&node.name) == name {
		return Some(node);
	}
	node.elements().find_map(|child| descendant(child, name))
}

fn descendants<'a>(node: &'a Node, name: &str, output: &mut Vec<&'a Node>) {
	for child in node.elements() {
		if local(&child.name) == name {
			output.push(child);
		}
		descendants(child, name, output);
	}
}

fn local(name: &str) -> &str {
	name.rsplit_once(':').map_or(name, |(_, local)| local)
}

fn failure(message: impl IntoStr) -> MarkitError {
	MarkitError::conversion(FORMAT, message)
}

#[cfg(test)]
mod tests {
	use omp_ar::zip::Writer;

	use super::*;

	fn zip(entries: &[(&str, &str)]) -> Vec<u8> {
		let entries = entries
			.iter()
			.map(|(path, content)| (*path, content.as_bytes()))
			.collect::<Vec<_>>();
		zip_bytes(&entries)
	}

	fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
		let mut writer = Writer::new(Vec::new());
		for (path, content) in entries {
			writer.add_file(path, content).expect("fixture member adds");
		}
		writer.finish().expect("fixture archive finishes")
	}

	#[test]
	fn package_hrefs_follow_epub_uri_resolution() {
		assert_eq!(
			package_member_path("OPS/package.opf", "../Text/chapter%201.xhtml?cache=1#opening",)
				.expect("valid package URI"),
			"Text/chapter 1.xhtml"
		);
		assert_eq!(
			package_member_path("OPS/package.opf", "/Text/./chapter.xhtml")
				.expect("absolute package URI"),
			"Text/chapter.xhtml"
		);
		assert!(package_member_path("OPS/package.opf", "%2e%2e/secret.xhtml").is_err());
		assert!(package_member_path("OPS/package.opf", "Text%2Fsecret.xhtml").is_err());
		assert_eq!(
			package_member_path("OPS/package.opf", "../../../root.xhtml")
				.expect("above-root traversal clamps"),
			"root.xhtml"
		);
	}

	#[test]
	fn namespaced_package_reads_percent_encoded_spine_member() {
		let bytes = zip(&[
			(
				"META-INF/container.xml",
				r#"<c:container xmlns:c="urn:oasis:names:tc:opendocument:xmlns:container"><c:rootfiles><c:rootfile c:full-path="OPS/package.opf"/></c:rootfiles></c:container>"#,
			),
			(
				"OPS/package.opf",
				r#"<package xmlns="http://www.idpf.org/2007/opf" xmlns:d="http://purl.org/dc/elements/1.1/"><metadata><d:title>Resolved Book</d:title></metadata><manifest><item id="chapter" href="../Text/chapter%201.xhtml?cache=1#opening" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>"#,
			),
			(
				"Text/chapter 1.xhtml",
				"<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><h1>Opening</h1><p>Resolved \
				 chapter.</p></body></html>",
			),
		]);

		let (text, title) = convert(&bytes).expect("EPUB conversion succeeds");
		assert_eq!(title.as_deref(), Some("Resolved Book"));
		assert!(text.contains("# Opening"));
		assert!(text.contains("Resolved chapter."));
	}

	#[test]
	fn declared_legacy_xhtml_encoding_is_decoded() {
		let container =
			br#"<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#;
		let package = br#"<package><manifest><item id="chapter" href="chapter.xhtml"/></manifest><spine><itemref idref="chapter"/></spine></package>"#;
		let chapter = b"<?xml version=\"1.0\" encoding=\"windows-1252\"?><html><body><p>caf\xe9</p></body></html>";
		let bytes = zip_bytes(&[
			("META-INF/container.xml", container),
			("package.opf", package),
			("chapter.xhtml", chapter),
		]);

		let (text, _) = convert(&bytes).expect("declared XHTML encoding converts");
		assert_eq!(text.as_str(), "caf\u{e9}");
	}

	#[test]
	fn missing_spine_members_degrade_only_while_content_remains() {
		let bytes = zip(&[
			(
				"META-INF/container.xml",
				r#"<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#,
			),
			(
				"package.opf",
				r#"<package><manifest><item id="missing" href="missing.xhtml"/><item id="good" href="good.xhtml"/></manifest><spine><itemref idref="missing"/><itemref idref="good"/></spine></package>"#,
			),
			("good.xhtml", "<html><body><p>Remaining chapter.</p></body></html>"),
		]);
		let (text, _) = convert(&bytes).expect("remaining spine content converts");
		assert_eq!(text.as_str(), "Remaining chapter.");

		let bytes = zip(&[
			(
				"META-INF/container.xml",
				r#"<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#,
			),
			(
				"package.opf",
				r#"<package><manifest><item id="missing" href="missing.xhtml"/></manifest><spine><itemref idref="missing"/></spine></package>"#,
			),
		]);
		let error = convert(&bytes).expect_err("an entirely unreadable spine fails");
		assert_eq!(
			error.to_string(),
			"epub conversion failed: Invalid EPUB: no spine document could be read"
		);
	}

	#[test]
	fn deeply_nested_package_xml_hits_the_safety_limit() {
		let mut container = "<container>".to_owned();
		container.push_str(&"<x>".repeat(MAX_XML_DEPTH));
		container.push_str(r#"<rootfiles><rootfile full-path="package.opf"/></rootfiles>"#);
		container.push_str(&"</x>".repeat(MAX_XML_DEPTH));
		container.push_str("</container>");
		let bytes = zip(&[("META-INF/container.xml", &container)]);

		let error = convert(&bytes).expect_err("excessive XML depth fails");
		assert!(
			error
				.to_string()
				.contains("XML element nesting exceeds 256")
		);
	}

	#[test]
	fn xml_node_budget_has_a_hard_boundary() {
		let mut nodes = MAX_XML_NODES;
		let error = bump_xml_nodes(&mut nodes).expect_err("node budget is enforced");
		assert!(error.to_string().contains("XML node count exceeds 2000000"));
	}
}
