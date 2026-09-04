//! DOCX to Markdown conversion.

use std::{
	collections::{HashMap, HashSet},
	iter, mem,
};

use omp_core::Str;
use quick_xml::{Reader, XmlVersion, events::Event};

use super::{
	Attachment, Conversion, MarkitError,
	ooxml::{
		Archive, attachment_name, decode_reference, decode_xml_bytes, format_url, image_media_type,
	},
};

const FORMAT: &str = "docx";
const MAX_XML_DEPTH: usize = 256;
const MAX_XML_CONTENT_NODES: usize = 2_000_000;
const MAX_TABLE_GRID_SLOTS: usize = 1_000_000;

#[derive(Clone, Debug, Default)]
struct Node {
	name:     String,
	attrs:    HashMap<String, String>,
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

	fn child(&self, name: &str) -> Option<&Self> {
		self.children.iter().find_map(|child| match child {
			Content::Element(node) if local(&node.name) == name => Some(node),
			_ => None,
		})
	}

	fn elements(&self) -> impl Iterator<Item = &Self> {
		self.children.iter().filter_map(|child| match child {
			Content::Element(node) => Some(node),
			Content::Text(_) => None,
		})
	}
}

#[derive(Clone, Copy, Debug, Default)]
struct Formatting {
	bold:   bool,
	italic: bool,
	strike: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct ToggleFormatting {
	bold:   bool,
	italic: bool,
	strike: bool,
}

impl ToggleFormatting {
	const fn apply(self, base: Formatting) -> Formatting {
		Formatting {
			bold:   base.bold ^ self.bold,
			italic: base.italic ^ self.italic,
			strike: base.strike ^ self.strike,
		}
	}
}

#[derive(Clone, Copy, Debug)]
enum OutlineLevel {
	Level(usize),
	NotHeading,
}

#[derive(Clone, Debug, Default)]
struct Style {
	name:                 String,
	based_on:             Option<String>,
	numbering:            Option<(String, usize)>,
	numbering_suppressed: bool,
	outline_level:        Option<OutlineLevel>,
	formatting:           ToggleFormatting,
}

#[derive(Clone, Debug)]
struct Relationship {
	target:   String,
	external: bool,
	rel_type: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NumberFormat {
	Bullet,
	Decimal,
	LowerAlpha,
	UpperAlpha,
	LowerRoman,
	UpperRoman,
}

#[derive(Clone, Debug)]
struct NumberLevel {
	format:     NumberFormat,
	suppressed: bool,
	start:      usize,
	pattern:    Option<String>,
	legal:      bool,
}

impl Default for NumberLevel {
	fn default() -> Self {
		Self {
			format:     NumberFormat::Decimal,
			suppressed: false,
			start:      1,
			pattern:    None,
			legal:      false,
		}
	}
}

struct Context {
	relationships: HashMap<String, Relationship>,
	drawing_text:  HashMap<String, String>,
	styles:        HashMap<String, Style>,
	doc_defaults:  Formatting,
	numbering:     HashMap<(String, usize), NumberLevel>,
	counters:      HashMap<(String, usize), usize>,
}

/// Converts an Office Open XML word-processing document to deterministic
/// Markdown.
pub(super) fn convert(bytes: &[u8], extract_media: bool) -> Result<Conversion, MarkitError> {
	let mut archive =
		Archive::open(bytes).map_err(|error| MarkitError::conversion(FORMAT, error))?;
	let root_relationships = read_member(&mut archive, "_rels/.rels")?
		.map(|xml| parse_relationships(&xml))
		.transpose()?
		.unwrap_or_default();
	let main_part = root_relationships
		.iter()
		.filter(|(_, relationship)| {
			!relationship.external && relationship.rel_type.ends_with("/officeDocument")
		})
		.min_by_key(|(id, _)| id.as_str())
		.and_then(|(_, relationship)| resolve_part_path("", &relationship.target))
		.unwrap_or_else(|| "word/document.xml".to_owned());
	let document = read_member(&mut archive, &main_part)?.ok_or_else(|| {
		MarkitError::conversion(FORMAT, format!("Invalid DOCX: missing {main_part}"))
	})?;
	let relationships = read_member(&mut archive, &relationships_part(&main_part))?
		.map(|xml| parse_relationships(&xml))
		.transpose()?
		.unwrap_or_default();
	let attachments = if extract_media {
		extract_attachments(&mut archive, &main_part, &relationships)?
	} else {
		Vec::new()
	};
	let drawing_text = read_drawing_text(&mut archive, &main_part, &relationships)?;
	let styles_part = related_part(&relationships, &main_part, "/styles", "styles.xml");
	let (styles, doc_defaults) = read_member(&mut archive, &styles_part)?
		.map(|xml| parse_styles(&xml))
		.transpose()?
		.unwrap_or_default();
	let numbering_part = related_part(&relationships, &main_part, "/numbering", "numbering.xml");
	let numbering = read_member(&mut archive, &numbering_part)?
		.map(|xml| parse_numbering(&xml))
		.transpose()?
		.unwrap_or_default();

	let root = parse_xml(&document)?;
	let body = descendant(&root, "body")
		.ok_or_else(|| MarkitError::conversion(FORMAT, "Invalid DOCX: missing document body"))?;
	let mut context = Context {
		relationships,
		drawing_text,
		styles,
		doc_defaults,
		numbering,
		counters: HashMap::new(),
	};
	let mut blocks = Vec::new();
	render_block_children(body, &mut context, &mut blocks)?;
	render_notes(&mut archive, &main_part, &mut context, &mut blocks)?;
	Ok(Conversion {
		text: Str::new(blocks.join("\n\n").trim_end()),
		note: None,
		title: None,
		attachments,
	})
}

fn extract_attachments(
	archive: &mut Archive<'_>,
	main_part: &str,
	relationships: &HashMap<String, Relationship>,
) -> Result<Vec<Attachment>, MarkitError> {
	let mut images = relationships
		.iter()
		.filter(|(_, relationship)| {
			!relationship.external && relationship.rel_type.ends_with("/image")
		})
		.collect::<Vec<_>>();
	images.sort_by_key(|(left, _)| *left);
	let mut used = HashSet::new();
	let mut attachments = Vec::with_capacity(images.len());
	for (ordinal, (_, relationship)) in images.into_iter().enumerate() {
		let Some(path) = resolve_part_path(main_part, &relationship.target) else {
			continue;
		};
		let Some(bytes) = archive
			.read(&path)
			.map_err(|error| MarkitError::conversion(FORMAT, error))?
		else {
			continue;
		};
		let name = attachment_name(&path, ordinal + 1, &mut used);
		attachments.push(Attachment {
			name:       name.into(),
			media_type: image_media_type(&path, &bytes).into(),
			bytes:      bytes.into(),
		});
	}
	Ok(attachments)
}

fn read_member(archive: &mut Archive<'_>, path: &str) -> Result<Option<String>, MarkitError> {
	let Some(bytes) = archive
		.read_xml(path)
		.map_err(|error| MarkitError::conversion(FORMAT, error))?
	else {
		return Ok(None);
	};
	let text = decode_xml_bytes(&bytes).map_err(|error| {
		MarkitError::conversion(FORMAT, format!("{path} is not valid UTF text: {error}"))
	})?;
	Ok(Some(text))
}

fn relationships_part(part: &str) -> String {
	let (directory, file) = part.rsplit_once('/').unwrap_or(("", part));
	if directory.is_empty() {
		format!("_rels/{file}.rels")
	} else {
		format!("{directory}/_rels/{file}.rels")
	}
}

fn resolve_part_path(base_part: &str, target: &str) -> Option<String> {
	if target.contains("://") || target.starts_with('#') {
		return None;
	}
	let mut parts = Vec::new();
	if !target.starts_with('/')
		&& let Some((directory, _)) = base_part.rsplit_once('/')
	{
		parts.extend(directory.split('/').filter(|part| !part.is_empty()));
	}
	let normalized_target = target.trim_start_matches('/').replace('\\', "/");
	for part in normalized_target.split('/') {
		match part {
			"" | "." => {},
			".." => {
				parts.pop()?;
			},
			part => parts.push(part),
		}
	}
	(!parts.is_empty()).then(|| parts.join("/"))
}

fn related_part(
	relationships: &HashMap<String, Relationship>,
	base_part: &str,
	type_suffix: &str,
	fallback: &str,
) -> String {
	relationships
		.iter()
		.filter(|(_, relationship)| {
			!relationship.external && relationship.rel_type.ends_with(type_suffix)
		})
		.min_by_key(|(id, _)| id.as_str())
		.and_then(|(_, relationship)| resolve_part_path(base_part, &relationship.target))
		.or_else(|| resolve_part_path(base_part, fallback))
		.unwrap_or_else(|| fallback.to_owned())
}

fn read_drawing_text(
	archive: &mut Archive<'_>,
	base_part: &str,
	relationships: &HashMap<String, Relationship>,
) -> Result<HashMap<String, String>, MarkitError> {
	let mut output = HashMap::new();
	for (id, relationship) in relationships {
		if relationship.external {
			continue;
		}
		let kind = if relationship.rel_type.ends_with("/chart") {
			Some("chart")
		} else if relationship.rel_type.ends_with("/diagramData") {
			Some("diagram")
		} else {
			None
		};
		let Some(kind) = kind else {
			continue;
		};
		let Some(part) = resolve_part_path(base_part, &relationship.target) else {
			continue;
		};
		let Some(xml) = read_member(archive, &part)? else {
			continue;
		};
		let Ok(root) = parse_xml(&xml) else {
			continue;
		};
		let rendered = if kind == "chart" {
			render_chart_xml(&root)
		} else {
			render_diagram_xml(&root)
		};
		if !rendered.is_empty() {
			output.insert(id.clone(), rendered);
		}
	}
	Ok(output)
}

fn render_chart_xml(root: &Node) -> String {
	let mut blocks = Vec::new();
	if let Some(title) = descendant(root, "title") {
		let text = drawing_text(title);
		if !text.is_empty() {
			blocks.push(format!("**{}**", escape_markdown(&text)));
		}
	}
	let mut series_nodes = Vec::new();
	descendants(root, "ser", &mut series_nodes);
	let mut categories = Vec::new();
	let mut series = Vec::new();
	for node in series_nodes {
		let name = node
			.child("tx")
			.and_then(|node| descendant(node, "v"))
			.map(drawing_text)
			.unwrap_or_default();
		let current_categories = node.child("cat").map(drawing_values).unwrap_or_default();
		if categories.is_empty() {
			categories = current_categories;
		}
		let values = node.child("val").map(drawing_values).unwrap_or_default();
		series.push((name, values));
	}
	if !categories.is_empty() && !series.is_empty() {
		let mut rows = Vec::with_capacity(categories.len() + 1);
		let mut header = vec![String::new()];
		header.extend(series.iter().map(|(name, _)| chart_cell(name)));
		rows.push(header);
		for (index, category) in categories.into_iter().enumerate() {
			let mut row = vec![chart_cell(&category)];
			row.extend(
				series
					.iter()
					.map(|(_, values)| chart_cell(values.get(index).map_or("", String::as_str))),
			);
			rows.push(row);
		}
		let width = rows[0].len();
		let mut lines = Vec::with_capacity(rows.len() + 1);
		lines.push(format!("| {} |", rows[0].join(" | ")));
		lines.push(format!("| {} |", vec!["---"; width].join(" | ")));
		lines.extend(
			rows
				.iter()
				.skip(1)
				.map(|row| format!("| {} |", row.join(" | "))),
		);
		blocks.push(lines.join("\n"));
	}
	blocks.join("\n\n")
}

fn render_diagram_xml(root: &Node) -> String {
	let mut points = Vec::new();
	descendants(root, "pt", &mut points);
	points
		.into_iter()
		.filter_map(|point| point.child("t").map(drawing_text))
		.filter(|text| !text.is_empty())
		.map(|text| format!("- {}", escape_markdown(&text)))
		.collect::<Vec<_>>()
		.join("\n")
}

fn drawing_values(node: &Node) -> Vec<String> {
	let mut values = Vec::new();
	descendants(node, "v", &mut values);
	values
		.into_iter()
		.map(drawing_text)
		.filter(|text| !text.is_empty())
		.collect()
}

fn drawing_text(node: &Node) -> String {
	let mut text_nodes = Vec::new();
	descendants(node, "t", &mut text_nodes);
	if text_nodes.is_empty() && matches!(local(&node.name), "t" | "v") {
		text_nodes.push(node);
	}
	let mut parts = Vec::new();
	for node in text_nodes {
		let mut text = String::new();
		append_text(node, &mut text);
		let text = normalize_run_whitespace(&text).trim().to_owned();
		if !text.is_empty() {
			parts.push(text);
		}
	}
	parts.join(" ")
}

fn chart_cell(value: &str) -> String {
	escape_markdown(value)
		.replace('|', "\\|")
		.replace('\n', "<br>")
}

fn parse_xml(xml: &str) -> Result<Node, MarkitError> {
	let mut reader = Reader::from_str(xml);
	reader.config_mut().trim_text(false);
	let mut stack = vec![Node { name: "root".into(), ..Node::default() }];
	let mut content_nodes = 0usize;
	loop {
		match reader.read_event() {
			Ok(Event::Start(event)) => {
				if stack.len() >= MAX_XML_DEPTH {
					return Err(MarkitError::conversion(
						FORMAT,
						format!("XML nesting exceeds {MAX_XML_DEPTH} levels"),
					));
				}
				stack.push(event_node(&event, &reader)?);
			},
			Ok(Event::Empty(event)) => {
				let node = event_node(&event, &reader)?;
				count_xml_content_node(&mut content_nodes)?;
				stack
					.last_mut()
					.expect("root exists")
					.children
					.push(Content::Element(node));
			},
			Ok(Event::End(_)) => {
				if stack.len() == 1 {
					return Err(MarkitError::conversion(FORMAT, "unexpected XML closing tag"));
				}
				count_xml_content_node(&mut content_nodes)?;
				let node = stack.pop().expect("length checked");
				stack
					.last_mut()
					.expect("root exists")
					.children
					.push(Content::Element(node));
			},
			Ok(Event::Text(event)) => {
				let decoded = event
					.xml_content(XmlVersion::Implicit1_0)
					.map_err(|error| MarkitError::conversion(FORMAT, error.to_string()))?;
				let text = quick_xml::escape::unescape(&decoded)
					.map_err(|error| MarkitError::conversion(FORMAT, error.to_string()))?;
				count_xml_content_node(&mut content_nodes)?;
				stack
					.last_mut()
					.expect("root exists")
					.children
					.push(Content::Text(text.into_owned()));
			},
			Ok(Event::GeneralRef(event)) => {
				let text =
					decode_reference(&event).map_err(|error| MarkitError::conversion(FORMAT, error))?;
				count_xml_content_node(&mut content_nodes)?;
				stack
					.last_mut()
					.expect("root exists")
					.children
					.push(Content::Text(text));
			},
			Ok(Event::CData(event)) => {
				let text = event
					.decode()
					.map_err(|error| MarkitError::conversion(FORMAT, error.to_string()))?;
				count_xml_content_node(&mut content_nodes)?;
				stack
					.last_mut()
					.expect("root exists")
					.children
					.push(Content::Text(text.into_owned()));
			},
			Ok(Event::Eof) => break,
			Ok(_) => {},
			Err(error) => return Err(MarkitError::conversion(FORMAT, error.to_string())),
		}
	}
	if stack.len() != 1 {
		return Err(MarkitError::conversion(FORMAT, "unterminated XML element"));
	}
	Ok(stack.pop().expect("root exists"))
}

fn count_xml_content_node(count: &mut usize) -> Result<(), MarkitError> {
	*count = count.saturating_add(1);
	if *count > MAX_XML_CONTENT_NODES {
		Err(MarkitError::conversion(
			FORMAT,
			format!("XML content exceeds {MAX_XML_CONTENT_NODES} node limit"),
		))
	} else {
		Ok(())
	}
}

fn event_node(
	event: &quick_xml::events::BytesStart<'_>,
	reader: &Reader<&[u8]>,
) -> Result<Node, MarkitError> {
	let name = String::from_utf8_lossy(event.name().as_ref()).into_owned();
	let mut attrs = HashMap::new();
	for attribute in event.attributes().with_checks(false) {
		let attribute =
			attribute.map_err(|error| MarkitError::conversion(FORMAT, error.to_string()))?;
		let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
		let value = attribute
			.decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
			.map_err(|error| MarkitError::conversion(FORMAT, error.to_string()))?
			.into_owned();
		attrs.insert(key.clone(), value.clone());
		attrs.entry(local(&key).to_owned()).or_insert(value);
	}
	Ok(Node { name, attrs, children: Vec::new() })
}

fn local(name: &str) -> &str {
	name.rsplit_once(':').map_or(name, |(_, local)| local)
}

fn descendant<'a>(node: &'a Node, name: &str) -> Option<&'a Node> {
	if local(&node.name) == name {
		return Some(node);
	}
	node.elements().find_map(|child| descendant(child, name))
}

fn descendants<'a>(node: &'a Node, name: &'a str, output: &mut Vec<&'a Node>) {
	for child in node.elements() {
		if local(&child.name) == name {
			output.push(child);
		}
		descendants(child, name, output);
	}
}

fn parse_relationships(xml: &str) -> Result<HashMap<String, Relationship>, MarkitError> {
	let root = parse_xml(xml)?;
	let mut nodes = Vec::new();
	descendants(&root, "Relationship", &mut nodes);
	Ok(nodes
		.into_iter()
		.filter_map(|node| {
			Some((node.attr("Id")?.to_owned(), Relationship {
				target:   node.attr("Target")?.to_owned(),
				external: node
					.attr("TargetMode")
					.is_some_and(|mode| mode.eq_ignore_ascii_case("external")),
				rel_type: node.attr("Type").unwrap_or("").to_owned(),
			}))
		})
		.collect())
}

fn parse_styles(xml: &str) -> Result<(HashMap<String, Style>, Formatting), MarkitError> {
	let root = parse_xml(xml)?;
	let doc_defaults = descendant(&root, "docDefaults")
		.and_then(|node| descendant(node, "rPr"))
		.map(parse_direct_formatting)
		.unwrap_or_default();
	let mut nodes = Vec::new();
	descendants(&root, "style", &mut nodes);
	let mut styles = HashMap::new();
	for node in nodes {
		let Some(id) = node.attr("styleId") else {
			continue;
		};
		let name = node
			.child("name")
			.and_then(|node| node.attr("val"))
			.unwrap_or(id)
			.to_owned();
		let outline_level = node
			.child("pPr")
			.and_then(|properties| properties.child("outlineLvl"))
			.and_then(|outline| outline.attr("val"))
			.and_then(|value| value.parse::<usize>().ok())
			.map(|level| {
				if level < 9 {
					OutlineLevel::Level(level + 1)
				} else {
					OutlineLevel::NotHeading
				}
			});
		styles.insert(id.to_owned(), Style {
			name,
			based_on: node
				.child("basedOn")
				.and_then(|node| node.attr("val"))
				.map(str::to_owned),
			numbering: (node.attr("type") == Some("paragraph"))
				.then(|| numbering_reference(node.child("pPr")))
				.flatten(),
			numbering_suppressed: node
				.child("pPr")
				.and_then(|properties| properties.child("numPr"))
				.and_then(|numbering| numbering.child("numId"))
				.and_then(|id| id.attr("val"))
				== Some("0"),
			outline_level,
			formatting: node
				.child("rPr")
				.map(parse_toggle_formatting)
				.unwrap_or_default(),
		});
	}
	Ok((styles, doc_defaults))
}

fn parse_toggle_formatting(properties: &Node) -> ToggleFormatting {
	ToggleFormatting {
		bold:   property_enabled(properties.child("b")),
		italic: property_enabled(properties.child("i")),
		strike: property_enabled(properties.child("strike"))
			|| property_enabled(properties.child("dstrike")),
	}
}

fn parse_direct_formatting(properties: &Node) -> Formatting {
	Formatting {
		bold:   property_enabled(properties.child("b")),
		italic: property_enabled(properties.child("i")),
		strike: property_enabled(properties.child("strike"))
			|| property_enabled(properties.child("dstrike")),
	}
}

fn parse_numbering(xml: &str) -> Result<HashMap<(String, usize), NumberLevel>, MarkitError> {
	let root = parse_xml(xml)?;
	let mut abstracts = HashMap::<String, HashMap<usize, NumberLevel>>::new();
	let mut abstract_nodes = Vec::new();
	descendants(&root, "abstractNum", &mut abstract_nodes);
	for node in abstract_nodes {
		let Some(id) = node.attr("abstractNumId") else {
			continue;
		};
		let mut levels = HashMap::new();
		for level in node.elements().filter(|node| local(&node.name) == "lvl") {
			let index = level
				.attr("ilvl")
				.and_then(|value| value.parse().ok())
				.unwrap_or(0);
			levels.insert(index, parse_number_level(level));
		}
		abstracts.insert(id.to_owned(), levels);
	}
	let mut result = HashMap::new();
	let mut number_nodes = Vec::new();
	descendants(&root, "num", &mut number_nodes);
	for node in number_nodes {
		let (Some(id), Some(abstract_id)) = (
			node.attr("numId"),
			node
				.child("abstractNumId")
				.and_then(|node| node.attr("val")),
		) else {
			continue;
		};
		if let Some(levels) = abstracts.get(abstract_id) {
			for (&level, kind) in levels {
				result.insert((id.to_owned(), level), kind.clone());
			}
			for override_node in node
				.elements()
				.filter(|node| local(&node.name) == "lvlOverride")
			{
				let level = override_node
					.attr("ilvl")
					.and_then(|value| value.parse().ok())
					.unwrap_or(0);
				if let Some(override_level) = override_node.child("lvl") {
					result.insert((id.to_owned(), level), parse_number_level(override_level));
				}
				if let Some(start) = override_node
					.child("startOverride")
					.and_then(|node| node.attr("val"))
					.and_then(parse_number_start)
					&& let Some(definition) = result.get_mut(&(id.to_owned(), level))
				{
					definition.start = start;
				}
			}
		}
	}
	Ok(result)
}

fn parse_number_level(level: &Node) -> NumberLevel {
	let raw_format = level
		.child("numFmt")
		.and_then(|node| node.attr("val"))
		.unwrap_or("bullet");
	let format = match raw_format {
		"bullet" => NumberFormat::Bullet,
		"lowerLetter" => NumberFormat::LowerAlpha,
		"upperLetter" => NumberFormat::UpperAlpha,
		"lowerRoman" => NumberFormat::LowerRoman,
		"upperRoman" => NumberFormat::UpperRoman,
		_ => NumberFormat::Decimal,
	};
	NumberLevel {
		format,
		suppressed: raw_format == "none",
		start: level
			.child("start")
			.and_then(|node| node.attr("val"))
			.and_then(parse_number_start)
			.unwrap_or(1),
		pattern: level
			.child("lvlText")
			.and_then(|node| node.attr("val"))
			.map(str::to_owned),
		legal: property_enabled(level.child("isLgl")),
	}
}

fn parse_number_start(value: &str) -> Option<usize> {
	value
		.parse::<i64>()
		.ok()
		.map(|value| value.clamp(0, i32::MAX as i64) as usize)
}

fn numbering_reference(properties: Option<&Node>) -> Option<(String, usize)> {
	let num = properties?.child("numPr")?;
	let id = num.child("numId")?.attr("val")?;
	if id == "0" {
		return None;
	}
	let level = num
		.child("ilvl")
		.and_then(|node| node.attr("val"))
		.and_then(|value| value.parse().ok())
		.unwrap_or(0);
	Some((id.to_owned(), level))
}

fn render_block_children(
	node: &Node,
	context: &mut Context,
	output: &mut Vec<String>,
) -> Result<(), MarkitError> {
	let mut list_block: Option<(bool, usize)> = None;
	for child in node.elements() {
		let child = if local(&child.name) == "AlternateContent" {
			match alternate_branch(child) {
				Some(branch) => branch,
				None => continue,
			}
		} else {
			child
		};
		match local(&child.name) {
			"p" => {
				let list = paragraph_numbering(child, context).map(|(id, level)| {
					let definition = context
						.numbering
						.get(&(id, level))
						.cloned()
						.unwrap_or_default();
					(definition.format != NumberFormat::Bullet, level)
				});
				let continues_list = match (list_block, list) {
					(Some((root_kind, root_level)), Some((kind, level))) => {
						level > root_level || (level == root_level && kind == root_kind)
					},
					_ => false,
				};
				if let Some(paragraph) = render_paragraph(child, context, false) {
					if continues_list {
						if let Some(previous) = output.last_mut() {
							previous.push('\n');
							previous.push_str(&paragraph);
						} else {
							output.push(paragraph);
						}
					} else {
						output.push(paragraph);
					}
				}
				list_block = list;
			},
			"tbl" => {
				let table = render_table(child, context)?;
				if !table.is_empty() {
					output.push(table);
				}
				list_block = None;
			},
			"sdt" | "sdtContent" | "customXml" | "Choice" | "Fallback" => {
				render_block_children(child, context, output)?;
				list_block = None;
			},
			_ => {},
		}
	}
	Ok(())
}

fn alternate_branch(node: &Node) -> Option<&Node> {
	node
		.elements()
		.find(|child| local(&child.name) == "Choice")
		.or_else(|| {
			node
				.elements()
				.find(|child| local(&child.name) == "Fallback")
		})
}

fn paragraph_numbering(node: &Node, context: &Context) -> Option<(String, usize)> {
	let properties = node.child("pPr");
	let style_id = properties
		.and_then(|node| node.child("pStyle"))
		.and_then(|node| node.attr("val"));
	let inherited =
		resolve_style_numbering(style_id.and_then(|id| context.styles.get(id)), &context.styles);
	let direct = properties.and_then(|properties| properties.child("numPr"));
	let direct_id = direct
		.and_then(|num| num.child("numId"))
		.and_then(|node| node.attr("val"));
	if direct_id == Some("0") {
		return None;
	}
	let id = direct_id
		.map(str::to_owned)
		.or_else(|| inherited.as_ref().map(|(id, _)| id.clone()))?;
	let level = direct
		.and_then(|num| num.child("ilvl"))
		.and_then(|node| node.attr("val"))
		.and_then(|value| value.parse().ok())
		.or_else(|| inherited.map(|(_, level)| level))
		.unwrap_or(0);
	if context
		.numbering
		.get(&(id.clone(), level))
		.is_some_and(|definition| definition.suppressed)
	{
		None
	} else {
		Some((id, level))
	}
}

fn resolve_style_numbering(
	style: Option<&Style>,
	styles: &HashMap<String, Style>,
) -> Option<(String, usize)> {
	let mut style = style;
	let mut visited = HashSet::new();
	while let Some(current) = style {
		if current.numbering_suppressed {
			return None;
		}
		if let Some(numbering) = &current.numbering {
			return Some(numbering.clone());
		}
		let Some(base) = current.based_on.as_deref() else {
			break;
		};
		if !visited.insert(base) {
			break;
		}
		style = styles.get(base);
	}
	None
}

fn resolve_style_formatting(
	style_id: Option<&str>,
	styles: &HashMap<String, Style>,
	base: Formatting,
) -> Formatting {
	let mut chain = Vec::new();
	let mut current = style_id;
	let mut visited = HashSet::new();
	while let Some(id) = current {
		if !visited.insert(id) {
			break;
		}
		let Some(style) = styles.get(id) else {
			break;
		};
		chain.push(style.formatting);
		current = style.based_on.as_deref();
	}
	chain
		.into_iter()
		.rev()
		.fold(base, |base, toggles| toggles.apply(base))
}

fn resolve_heading(
	properties: Option<&Node>,
	style_id: Option<&str>,
	styles: &HashMap<String, Style>,
) -> Option<usize> {
	if let Some(level) = properties
		.and_then(|properties| properties.child("outlineLvl"))
		.and_then(|node| node.attr("val"))
		.and_then(|value| value.parse::<usize>().ok())
	{
		return (level < 9).then_some(level + 1);
	}
	let mut current = style_id;
	let mut visited = HashSet::new();
	while let Some(id) = current {
		if !visited.insert(id) {
			break;
		}
		let Some(style) = styles.get(id) else {
			return heading_level(id);
		};
		if let Some(outline_level) = style.outline_level {
			return match outline_level {
				OutlineLevel::Level(level) => Some(level),
				OutlineLevel::NotHeading => None,
			};
		}
		if let Some(level) = heading_level(&style.name).or_else(|| heading_level(id)) {
			return Some(level);
		}
		current = style.based_on.as_deref();
	}
	None
}

fn next_list_marker(context: &mut Context, id: &str, level: usize) -> (bool, String, String) {
	let definition = context
		.numbering
		.get(&(id.to_owned(), level))
		.cloned()
		.unwrap_or_default();
	if definition.format == NumberFormat::Bullet {
		return (false, "-".to_owned(), String::new());
	}
	let counter = context
		.counters
		.entry((id.to_owned(), level))
		.or_insert_with(|| definition.start.saturating_sub(1));
	*counter = counter.saturating_add(1);
	let value = *counter;
	let default_label = format_number(value, definition.format);
	let label = definition.pattern.as_deref().map_or_else(
		|| format!("{default_label}."),
		|pattern| format_number_pattern(pattern, id, context, definition.legal),
	);
	let standard_decimal =
		definition.format == NumberFormat::Decimal && definition.pattern.is_none();
	let marker = if standard_decimal {
		label.clone()
	} else {
		format!("- {}", escape_markdown(&label))
	};
	(true, marker, label)
}

fn format_number_pattern(pattern: &str, id: &str, context: &Context, legal: bool) -> String {
	let mut output = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();
	while let Some(character) = chars.next() {
		if character == '%'
			&& let Some(digit @ '1'..='9') = chars.peek().copied()
		{
			chars.next();
			let level = digit as usize - '1' as usize;
			let definition = context
				.numbering
				.get(&(id.to_owned(), level))
				.cloned()
				.unwrap_or_default();
			let value = context
				.counters
				.get(&(id.to_owned(), level))
				.copied()
				.unwrap_or(definition.start);
			let format = if legal {
				NumberFormat::Decimal
			} else {
				definition.format
			};
			output.push_str(&format_number(value, format));
		} else if !character.is_control() {
			output.push(character);
		}
	}
	output
}

fn format_number(value: usize, format: NumberFormat) -> String {
	match format {
		NumberFormat::Bullet | NumberFormat::Decimal => value.to_string(),
		NumberFormat::LowerAlpha => alpha_number(value, false),
		NumberFormat::UpperAlpha => alpha_number(value, true),
		NumberFormat::LowerRoman => roman_number(value).to_ascii_lowercase(),
		NumberFormat::UpperRoman => roman_number(value),
	}
}

fn alpha_number(mut value: usize, uppercase: bool) -> String {
	if value == 0 {
		return "0".to_owned();
	}
	let mut reversed = Vec::new();
	while value > 0 {
		value -= 1;
		let base = if uppercase { b'A' } else { b'a' };
		reversed.push((base + (value % 26) as u8) as char);
		value /= 26;
	}
	reversed.into_iter().rev().collect()
}

fn roman_number(mut value: usize) -> String {
	if value == 0 || value > 3999 {
		return value.to_string();
	}
	let mut output = String::new();
	for (number, numeral) in [
		(1000, "M"),
		(900, "CM"),
		(500, "D"),
		(400, "CD"),
		(100, "C"),
		(90, "XC"),
		(50, "L"),
		(40, "XL"),
		(10, "X"),
		(9, "IX"),
		(5, "V"),
		(4, "IV"),
		(1, "I"),
	] {
		while value >= number {
			output.push_str(numeral);
			value -= number;
		}
	}
	output
}

fn render_paragraph(node: &Node, context: &mut Context, in_table: bool) -> Option<String> {
	let properties = node.child("pPr");
	let style_id = properties
		.and_then(|node| node.child("pStyle"))
		.and_then(|node| node.attr("val"));
	let base = resolve_style_formatting(style_id, &context.styles, context.doc_defaults);
	let numbering = paragraph_numbering(node, context);
	let heading = (!in_table)
		.then(|| resolve_heading(properties, style_id, &context.styles))
		.flatten();
	let inline_base = if heading.is_some() {
		Formatting::default()
	} else {
		base
	};
	let mut text = render_inline(node, context, inline_base).trim().to_owned();
	if heading.is_some() {
		text = text.replace("  \n", " ");
	}
	if text.is_empty() && numbering.is_none() {
		return None;
	}
	if let Some((id, level)) = numbering {
		let (ordered, marker, label) = next_list_marker(context, &id, level);
		context
			.counters
			.retain(|(counter_id, depth), _| counter_id != &id || *depth <= level);
		if let Some(heading) = heading {
			if ordered {
				text = format!("{label} {text}");
			}
			return Some(format!("{} {}", "#".repeat(heading.min(6)), text.replace("\\.", ".")));
		}
		return Some(format!("{}{} {}", "  ".repeat(level.min(32)), marker, text));
	}
	if in_table {
		return Some(text);
	}
	Some(match heading {
		Some(level) => format!("{} {}", "#".repeat(level.min(6)), text.replace("\\.", ".")),
		None => text,
	})
}

fn heading_level(name: &str) -> Option<usize> {
	let compact = name
		.chars()
		.filter(|ch| !ch.is_whitespace())
		.flat_map(char::to_lowercase)
		.collect::<String>();
	if compact == "title" {
		return Some(1);
	}
	compact
		.strip_prefix("heading")?
		.parse::<usize>()
		.ok()
		.filter(|level| (1..=9).contains(level))
}

#[derive(Default)]
struct FieldFrame {
	instruction: String,
	result:      String,
	in_result:   bool,
}

fn render_inline(node: &Node, context: &Context, base: Formatting) -> String {
	let mut output = String::new();
	let mut fields = Vec::new();
	render_inline_into(node, context, base, &mut fields, &mut output);
	while let Some(frame) = fields.pop() {
		push_inline_piece(&mut output, &mut fields, &frame.result);
	}
	output
}

fn render_inline_into(
	node: &Node,
	context: &Context,
	base: Formatting,
	fields: &mut Vec<FieldFrame>,
	output: &mut String,
) {
	for child in node.elements() {
		let child = if local(&child.name) == "AlternateContent" {
			match alternate_branch(child) {
				Some(branch) => branch,
				None => continue,
			}
		} else {
			child
		};
		match local(&child.name) {
			"pPr" | "rPr" | "del" | "moveFrom" => {},
			"r" => render_run(child, context, base, fields, output),
			"hyperlink" => {
				let mut label = render_inline(child, context, base);
				let target = child
					.attr("id")
					.and_then(|id| context.relationships.get(id))
					.map(|relationship| relationship.target.clone())
					.or_else(|| child.attr("anchor").map(|anchor| format!("#{anchor}")));
				if let Some(target) = target {
					if label.trim().is_empty() {
						label = escape_markdown(&target);
					}
					push_inline_piece(output, fields, &format!("[{label}]({})", format_url(&target)));
				} else {
					push_inline_piece(output, fields, &label);
				}
			},
			"fldSimple" => {
				let result = render_inline(child, context, base);
				let rendered = render_field(child.attr("instr").unwrap_or(""), result);
				push_inline_piece(output, fields, &rendered);
			},
			"bookmarkStart" => {
				if let Some(name) = child.attr("name")
					&& name != "_GoBack"
				{
					push_inline_piece(
						output,
						fields,
						&format!("<a id=\"{}\"></a>", escape_html_attribute(name)),
					);
				}
			},
			"ins" | "moveTo" | "smartTag" | "sdt" | "sdtContent" | "customXml" | "bdo" | "dir"
			| "Choice" | "Fallback" => {
				render_inline_into(child, context, base, fields, output);
			},
			_ => {},
		}
	}
}

fn push_inline_piece(output: &mut String, fields: &mut [FieldFrame], piece: &str) {
	if let Some(field) = fields.last_mut() {
		if field.in_result {
			append_inline_piece(&mut field.result, piece);
		}
	} else {
		append_inline_piece(output, piece);
	}
}

fn append_inline_piece(output: &mut String, piece: &str) {
	let piece = if !piece.starts_with("  \n")
		&& output.chars().next_back().is_some_and(char::is_whitespace)
	{
		piece.trim_start_matches(char::is_whitespace)
	} else {
		piece
	};
	output.push_str(piece);
}

fn render_run(
	run: &Node,
	context: &Context,
	base: Formatting,
	fields: &mut Vec<FieldFrame>,
	output: &mut String,
) {
	let properties = run.child("rPr");
	let character_style = properties
		.and_then(|properties| properties.child("rStyle"))
		.and_then(|style| style.attr("val"));
	let mut formatting = resolve_style_formatting(character_style, &context.styles, base);
	if let Some(properties) = properties {
		if let Some(value) = property_value(properties.child("b")) {
			formatting.bold = value;
		}
		if let Some(value) = property_value(properties.child("i")) {
			formatting.italic = value;
		}
		let strike = property_value(properties.child("strike"));
		let double_strike = property_value(properties.child("dstrike"));
		if strike.is_some() || double_strike.is_some() {
			formatting.strike = strike.unwrap_or(false) || double_strike.unwrap_or(false);
		}
	}
	for child in run.elements() {
		let child = if local(&child.name) == "AlternateContent" {
			match alternate_branch(child) {
				Some(branch) => branch,
				None => continue,
			}
		} else {
			child
		};
		match local(&child.name) {
			"t" => {
				let mut text = String::new();
				append_text(child, &mut text);
				if child.attr("space") != Some("preserve") {
					text = text.trim_matches([' ', '\t', '\r', '\n']).to_owned();
				}
				let rendered = render_formatted_text(&normalize_run_whitespace(&text), formatting);
				push_inline_piece(output, fields, &rendered);
			},
			"tab" | "ptab" => push_inline_piece(output, fields, " "),
			"br" | "cr" => push_inline_piece(output, fields, "  \n"),
			"noBreakHyphen" => push_inline_piece(output, fields, "‑"),
			"softHyphen" => push_inline_piece(output, fields, "\u{ad}"),
			"footnoteReference" => {
				if let Some(id) = child.attr("id") {
					push_inline_piece(output, fields, &format!("[^fn{id}]"));
				}
			},
			"endnoteReference" => {
				if let Some(id) = child.attr("id") {
					push_inline_piece(output, fields, &format!("[^en{id}]"));
				}
			},
			"drawing" | "pict" | "object" => {
				let image = render_drawing(child, context);
				push_inline_piece(output, fields, &image);
			},
			"fldChar" => match child.attr("fldCharType") {
				Some("begin") => fields.push(FieldFrame::default()),
				Some("separate") => {
					if let Some(field) = fields.last_mut() {
						field.in_result = true;
					}
				},
				Some("end") => {
					if let Some(field) = fields.pop() {
						let rendered = render_field(&field.instruction, field.result);
						push_inline_piece(output, fields, &rendered);
					}
				},
				_ => {},
			},
			"instrText" => {
				if let Some(field) = fields.last_mut() {
					let mut instruction = String::new();
					append_text(child, &mut instruction);
					field.instruction.push_str(&instruction);
				}
			},
			_ => {},
		}
	}
}

fn render_formatted_text(text: &str, formatting: Formatting) -> String {
	let mut rendered = escape_markdown_preserving_breaks(text);
	if formatting.strike && !rendered.trim().is_empty() {
		rendered = wrap_inline(rendered, "~~");
	}
	if formatting.italic && !rendered.trim().is_empty() {
		rendered = wrap_inline(rendered, "*");
	}
	if formatting.bold && !rendered.trim().is_empty() {
		rendered = wrap_inline(rendered, "**");
	}
	rendered
}

fn render_drawing(node: &Node, context: &Context) -> String {
	if let Some(text_box) = descendant(node, "txbxContent") {
		let mut paragraphs = Vec::new();
		let mut nodes = Vec::new();
		descendants(text_box, "p", &mut nodes);
		for paragraph in nodes {
			let text = render_inline(paragraph, context, context.doc_defaults);
			if !text.trim().is_empty() {
				paragraphs.push(text.trim().to_owned());
			}
		}
		if !paragraphs.is_empty() {
			return paragraphs.join("  \n");
		}
	}
	let related_text_id = descendant(node, "chart")
		.and_then(|node| node.attr("id"))
		.or_else(|| descendant(node, "relIds").and_then(|node| node.attr("dm")));
	if let Some(text) = related_text_id.and_then(|id| context.drawing_text.get(id)) {
		return text.clone();
	}
	let alt = descendant(node, "docPr")
		.and_then(|node| node.attr("descr").or_else(|| node.attr("title")))
		.unwrap_or("");
	if let Some(object) = descendant(node, "OLEObject") {
		if !alt.trim().is_empty() {
			return escape_markdown(alt.trim());
		}
		let program = object.attr("ProgID").unwrap_or("object");
		return escape_markdown(&format!("Embedded object: {program}"));
	}
	let relationship_id = descendant(node, "blip")
		.and_then(|node| node.attr("embed").or_else(|| node.attr("link")))
		.or_else(|| descendant(node, "imagedata").and_then(|node| node.attr("id")));
	if let Some(relationship) = relationship_id.and_then(|id| context.relationships.get(id))
		&& relationship.external
	{
		return format!("![{}]({})", escape_markdown(alt.trim()), format_url(&relationship.target));
	}
	if !alt.trim().is_empty() {
		return escape_markdown(alt.trim());
	}
	"<!-- image -->".to_owned()
}

fn render_field(instruction: &str, result: String) -> String {
	let Some(target) = hyperlink_field_target(instruction) else {
		return result;
	};
	if result.trim().is_empty() {
		return result;
	}
	format!("[{result}]({})", format_url(&target))
}

fn hyperlink_field_target(instruction: &str) -> Option<String> {
	let tokens = field_tokens(instruction);
	if !tokens
		.first()
		.is_some_and(|token| token.eq_ignore_ascii_case("HYPERLINK"))
	{
		return None;
	}
	let mut url = None;
	let mut anchor = None;
	let mut index = 1;
	while index < tokens.len() {
		let token = &tokens[index];
		if let Some(switch) = token.strip_prefix('\\') {
			if matches!(switch.to_ascii_lowercase().as_str(), "l" | "o" | "t")
				&& let Some(argument) = tokens.get(index + 1)
				&& !argument.starts_with('\\')
			{
				if switch.eq_ignore_ascii_case("l") {
					anchor = Some(argument.clone());
				}
				index += 1;
			}
		} else if url.is_none() {
			url = Some(token.clone());
		}
		index += 1;
	}
	match (url, anchor) {
		(Some(url), Some(anchor)) => Some(format!("{url}#{anchor}")),
		(Some(url), None) => Some(url),
		(None, Some(anchor)) => Some(format!("#{anchor}")),
		(None, None) => None,
	}
}

fn field_tokens(instruction: &str) -> Vec<String> {
	let mut tokens = Vec::new();
	let mut chars = instruction.chars().peekable();
	while chars.peek().is_some() {
		while chars
			.peek()
			.is_some_and(|character| character.is_whitespace())
		{
			chars.next();
		}
		let Some(first) = chars.next() else {
			break;
		};
		let mut token = String::new();
		if first == '"' {
			while let Some(character) = chars.next() {
				match character {
					'"' => break,
					'\\' if chars.peek().is_some_and(|next| matches!(next, '"' | '\\')) => {
						if let Some(escaped) = chars.next() {
							token.push(escaped);
						}
					},
					character => token.push(character),
				}
			}
		} else {
			token.push(first);
			while let Some(character) = chars.peek() {
				if character.is_whitespace() {
					break;
				}
				token.push(*character);
				chars.next();
			}
		}
		if !token.is_empty() {
			tokens.push(token);
		}
	}
	tokens
}

fn escape_html_attribute(value: &str) -> String {
	value
		.replace('&', "&amp;")
		.replace('"', "&quot;")
		.replace('<', "&lt;")
}

fn wrap_inline(value: String, delimiter: &str) -> String {
	let start = value.len() - value.trim_start_matches(char::is_whitespace).len();
	let end = value.trim_end_matches(char::is_whitespace).len();
	if start >= end {
		return value;
	}
	format!("{}{delimiter}{}{delimiter}{}", &value[..start], &value[start..end], &value[end..])
}

fn property_value(node: Option<&Node>) -> Option<bool> {
	let node = node?;
	Some(!matches!(
		node.attr("val").map(str::to_ascii_lowercase).as_deref(),
		Some("0" | "false" | "off" | "none")
	))
}

fn property_enabled(node: Option<&Node>) -> bool {
	property_value(node).unwrap_or(false)
}

fn append_text(node: &Node, output: &mut String) {
	for child in &node.children {
		match child {
			Content::Text(text) => output.push_str(text),
			Content::Element(node) => append_text(node, output),
		}
	}
}

fn render_table(table: &Node, context: &mut Context) -> Result<String, MarkitError> {
	let mut row_nodes = Vec::new();
	collect_table_children(table, "tr", &mut row_nodes);
	check_table_grid_budget(&row_nodes, MAX_TABLE_GRID_SLOTS)?;
	let mut rows = Vec::<Vec<String>>::new();
	let mut active_merges = HashSet::new();
	for &row in &row_nodes {
		let properties = row.child("trPr");
		let before = grid_filler(properties, "gridBefore");
		let after = grid_filler(properties, "gridAfter");
		let mut cells = vec![String::new(); before];
		let mut next_merges = HashSet::new();
		let mut column = before;
		let mut last_horizontal_origin: Option<usize> = None;
		let mut cell_nodes = Vec::new();
		collect_table_children(row, "tc", &mut cell_nodes);
		for cell in cell_nodes {
			let properties = cell.child("tcPr");
			let span = table_grid_span(cell);
			let vertical_merge = properties.and_then(|node| node.child("vMerge"));
			let merge_continues =
				vertical_merge.is_some_and(|node| node.attr("val") != Some("restart"));
			let horizontal_merge = properties.and_then(|node| node.child("hMerge"));
			let horizontal_continues =
				horizontal_merge.is_some_and(|node| node.attr("val") != Some("restart"));
			let content = render_table_cell(cell, context)?;

			if horizontal_continues {
				if let Some(origin_index) = last_horizontal_origin {
					let origin: &mut String = &mut cells[origin_index];
					if !content.is_empty() {
						if !origin.is_empty() {
							origin.push_str("<br>");
						}
						origin.push_str(&content);
					}
					cells.extend(iter::repeat_n(String::new(), span));
				} else {
					last_horizontal_origin = Some(cells.len());
					cells.push(content);
					cells.extend(iter::repeat_n(String::new(), span - 1));
				}
			} else if merge_continues && active_merges.contains(&column) {
				last_horizontal_origin = None;
				cells.extend(iter::repeat_n(String::new(), span));
				for merged_column in column..column.saturating_add(span) {
					next_merges.insert(merged_column);
				}
			} else {
				last_horizontal_origin = Some(cells.len());
				cells.push(content);
				cells.extend(iter::repeat_n(String::new(), span - 1));
				if vertical_merge.is_some() {
					for merged_column in column..column.saturating_add(span) {
						next_merges.insert(merged_column);
					}
				}
			}
			column = column.saturating_add(span);
		}
		cells.extend(iter::repeat_n(String::new(), after));
		rows.push(cells);
		active_merges = next_merges;
	}
	let width = rows.iter().map(Vec::len).max().unwrap_or(0);
	if width == 0 {
		return Ok(String::new());
	}
	for row in &mut rows {
		row.resize(width, String::new());
	}
	let mut lines = Vec::with_capacity(rows.len() + 1);
	lines.push(format!("| {} |", rows[0].join(" | ")));
	lines.push(format!("| {} |", vec!["---"; width].join(" | ")));
	lines.extend(
		rows
			.iter()
			.skip(1)
			.map(|row| format!("| {} |", row.join(" | "))),
	);
	Ok(lines.join("\n"))
}

fn collect_table_children<'a>(node: &'a Node, wanted: &str, output: &mut Vec<&'a Node>) {
	for child in node.elements() {
		match local(&child.name) {
			name if name == wanted => output.push(child),
			"sdt" | "sdtContent" | "customXml" => collect_table_children(child, wanted, output),
			_ => {},
		}
	}
}

fn grid_filler(properties: Option<&Node>, name: &str) -> usize {
	properties
		.and_then(|properties| properties.child(name))
		.and_then(|node| node.attr("val"))
		.and_then(|value| value.parse().ok())
		.unwrap_or(0)
		.min(1000)
}

fn table_grid_span(cell: &Node) -> usize {
	cell
		.child("tcPr")
		.and_then(|properties| properties.child("gridSpan"))
		.and_then(|node| node.attr("val"))
		.and_then(|value| value.parse::<usize>().ok())
		.unwrap_or(1)
		.clamp(1, 1000)
}

fn check_table_grid_budget(rows: &[&Node], limit: usize) -> Result<(), MarkitError> {
	let mut maximum_width = 0usize;
	for (row_index, row) in rows.iter().enumerate() {
		let properties = row.child("trPr");
		let mut width = grid_filler(properties, "gridBefore")
			.checked_add(grid_filler(properties, "gridAfter"))
			.ok_or_else(|| table_grid_limit_error(limit))?;
		let mut cells = Vec::new();
		collect_table_children(row, "tc", &mut cells);
		for cell in cells {
			width = width
				.checked_add(table_grid_span(cell))
				.ok_or_else(|| table_grid_limit_error(limit))?;
		}
		maximum_width = maximum_width.max(width);
		let materialized = (row_index + 1)
			.checked_mul(maximum_width)
			.ok_or_else(|| table_grid_limit_error(limit))?;
		if materialized > limit {
			return Err(table_grid_limit_error(limit));
		}
	}
	Ok(())
}

fn table_grid_limit_error(limit: usize) -> MarkitError {
	MarkitError::conversion(FORMAT, format!("DOCX table grid exceeds {limit} slot limit"))
}

fn render_table_cell(cell: &Node, context: &mut Context) -> Result<String, MarkitError> {
	let mut blocks = Vec::new();
	render_block_children(cell, context, &mut blocks)?;
	Ok(blocks
		.join("<br>")
		.replace('\n', "<br>")
		.replace('|', "\\|"))
}
fn render_notes(
	archive: &mut Archive<'_>,
	main_part: &str,
	context: &mut Context,
	output: &mut Vec<String>,
) -> Result<(), MarkitError> {
	let body = output.join("\n\n");
	let mut definitions = Vec::<(String, String, usize)>::new();
	let mut seen = HashSet::new();
	for (type_suffix, fallback, root_name, note_name, prefix) in [
		("/footnotes", "footnotes.xml", "footnotes", "footnote", "fn"),
		("/endnotes", "endnotes.xml", "endnotes", "endnote", "en"),
	] {
		let part = related_part(&context.relationships, main_part, type_suffix, fallback);
		let Some(xml) = read_member(archive, &part)? else {
			continue;
		};
		let root = parse_xml(&xml)?;
		let Some(notes) = descendant(&root, root_name) else {
			continue;
		};
		let note_relationships = read_member(archive, &relationships_part(&part))?
			.map(|xml| parse_relationships(&xml))
			.transpose()?
			.unwrap_or_default();
		let document_relationships = mem::replace(&mut context.relationships, note_relationships);
		for note in notes
			.elements()
			.filter(|node| local(&node.name) == note_name)
		{
			if matches!(
				note.attr("type"),
				Some("separator" | "continuationSeparator" | "continuationNotice")
			) {
				continue;
			}
			let Some(id) = note.attr("id") else {
				continue;
			};
			let markdown_id = format!("{prefix}{id}");
			if !seen.insert(markdown_id.clone()) {
				continue;
			}
			let mut blocks = Vec::new();
			render_block_children(note, context, &mut blocks)?;
			if !blocks.is_empty() {
				let sequence = definitions.len();
				definitions.push((
					markdown_id.clone(),
					format_note_definition(&markdown_id, &blocks),
					sequence,
				));
			}
		}
		context.relationships = document_relationships;
	}
	definitions.sort_by_key(|(id, _, sequence)| {
		(body.find(&format!("[^{id}]")).unwrap_or(usize::MAX), *sequence)
	});
	output.extend(definitions.into_iter().map(|(_, definition, _)| definition));
	Ok(())
}

fn format_note_definition(id: &str, blocks: &[String]) -> String {
	let mut body = blocks.join("\n\n");
	body = body.replace('\n', "\n    ");
	format!("[^{id}]: {body}")
}

fn escape_markdown_preserving_breaks(value: &str) -> String {
	value
		.split("  \n")
		.map(escape_markdown)
		.collect::<Vec<_>>()
		.join("  \n")
}

fn normalize_run_whitespace(value: &str) -> String {
	value
		.split("  \n")
		.map(|segment| {
			let mut normalized = String::with_capacity(segment.len());
			let mut whitespace = false;
			for character in segment.chars() {
				if character.is_whitespace() {
					if !whitespace {
						normalized.push(' ');
						whitespace = true;
					}
				} else {
					normalized.push(character);
					whitespace = false;
				}
			}
			normalized
		})
		.collect::<Vec<_>>()
		.join("  \n")
}

fn escape_markdown(value: &str) -> String {
	let mut output = value
		.replace('\\', "\\\\")
		.replace('*', "\\*")
		.replace('_', "\\_")
		.replace('[', "\\[")
		.replace(']', "\\]");
	let leading_whitespace = output.len() - output.trim_start_matches(char::is_whitespace).len();
	let escape_at = {
		let content = &output[leading_whitespace..];
		if let Some(dot) = content.find('.')
			&& !content[..dot].is_empty()
			&& content[..dot]
				.chars()
				.all(|character| character.is_ascii_digit())
			&& content[dot + 1..]
				.chars()
				.next()
				.is_some_and(char::is_whitespace)
		{
			Some(leading_whitespace + dot)
		} else if ["-", "+", ">"]
			.into_iter()
			.any(|marker| marker_followed_by_whitespace(content, marker))
		{
			Some(leading_whitespace)
		} else if content.starts_with('#') {
			let count = content
				.chars()
				.take_while(|character| *character == '#')
				.count();
			((1..=6).contains(&count)
				&& content[count..]
					.chars()
					.next()
					.is_some_and(char::is_whitespace))
			.then_some(leading_whitespace)
		} else {
			None
		}
	};
	if let Some(index) = escape_at {
		output.insert(index, '\\');
	}
	output
}

fn marker_followed_by_whitespace(content: &str, marker: &str) -> bool {
	content
		.strip_prefix(marker)
		.and_then(|rest| rest.chars().next())
		.is_some_and(char::is_whitespace)
}

#[cfg(test)]
mod tests {
	use omp_ar::zip::Writer;

	use super::{
		MAX_XML_CONTENT_NODES, MAX_XML_DEPTH, check_table_grid_budget, collect_table_children,
		convert, count_xml_content_node, descendant, parse_xml,
	};

	fn docx(parts: &[(&str, &str)]) -> Vec<u8> {
		let mut archive = Writer::new(Vec::new());
		for (name, contents) in parts {
			archive.add_file(name, contents.as_bytes()).unwrap();
		}
		archive.finish().unwrap()
	}

	#[test]
	fn renders_headings_lists_links_breaks_and_tables_in_document_order() {
		let bytes = docx(&[
			(
				"word/styles.xml",
				r#"<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style><w:style w:type="paragraph" w:styleId="BaseList"><w:name w:val="Base List"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="DerivedList"><w:name w:val="Derived List"/><w:basedOn w:val="BaseList"/></w:style></w:styles>"#,
			),
			(
				"word/numbering.xml",
				r#"<w:numbering xmlns:w="w"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#,
			),
			(
				"word/_rels/document.xml.rels",
				r#"<Relationships><Relationship Id="rId1" Target="https://example.com/a b" TargetMode="External"/></Relationships>"#,
			),
			(
				"word/document.xml",
				r#"<w:document xmlns:w="w" xmlns:r="r"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>1. Title &amp; * one</w:t></w:r></w:p><w:p><w:r><w:t>- prose</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="DerivedList"/></w:pPr><w:r><w:t>Item</w:t></w:r></w:p><w:p><w:hyperlink r:id="rId1"><w:r><w:t>Example</w:t><w:br/><w:t>site</w:t></w:r></w:hyperlink></w:p><w:p><w:hyperlink w:anchor="bookmark"><w:r><w:t>Jump</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>x|y</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#,
			),
		]);
		let markdown = convert(&bytes, false).unwrap();
		assert_eq!(
			markdown.as_str(),
			"# 1. Title & \\* one\n\n\\- prose\n\n- Item\n\n[Example  \nsite](<https://example.com/a \
			 b>)\n\n[Jump](#bookmark)\n\n| A | B |\n| --- | --- |\n| x\\|y | 2 |"
		);
	}

	#[test]
	fn matches_pi_turndown_escape_contract() {
		for (input, expected) in [
			("\\", "\\\\"),
			("*", "\\*"),
			("- dash", "\\- dash"),
			("-dash", "-dash"),
			("+ plus", "\\+ plus"),
			("=== title", "=== title"),
			("# heading", "\\# heading"),
			("`code`", "`code`"),
			("~~~lang", "~~~lang"),
			("[link]", "\\[link\\]"),
			("> quote", "\\> quote"),
			("_word_", "\\_word\\_"),
			("12. item", "12\\. item"),
			("mid-dash", "mid-dash"),
		] {
			assert_eq!(super::escape_markdown(input), expected);
		}
		assert_eq!(super::format_url("https://e/x y(a)|<b>\n"), "<https://e/x y(a)%7C%3Cb%3E%0A>");
	}

	#[test]
	fn discovers_related_parts_and_renders_notes_fields_changes_bookmarks_and_images() {
		let bytes = docx(&[
			(
				"_rels/.rels",
				r#"<Relationships><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="docs/main.xml"/></Relationships>"#,
			),
			(
				"docs/_rels/main.xml.rels",
				r#"<Relationships>
					<Relationship Id="fn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="notes/foot.xml"/>
					<Relationship Id="en" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="notes/end.xml"/>
					<Relationship Id="pic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/pic.png" TargetMode="External"/>
				</Relationships>"#,
			),
			(
				"docs/main.xml",
				r#"<w:document xmlns:w="w" xmlns:r="r" xmlns:a="a" xmlns:wp="wp"><w:body>
					<w:p><w:bookmarkStart w:name="spot"/><w:r><w:t>Target</w:t></w:r></w:p>
					<w:p><w:fldSimple w:instr="HYPERLINK &quot;https://e.com/a b&quot;"><w:r><w:t>Simple</w:t></w:r></w:fldSimple></w:p>
					<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://e.com/c" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Complex</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
					<w:p><w:moveFrom><w:r><w:t>Old</w:t></w:r></w:moveFrom><w:moveTo><w:r><w:t>New</w:t></w:r></w:moveTo><w:del><w:r><w:t>Gone</w:t></w:r></w:del><w:ins><w:r><w:t>Kept</w:t></w:r></w:ins></w:p>
					<w:p><w:r><w:drawing><wp:docPr descr="Diagram"/><a:blip r:link="pic"/></w:drawing></w:r></w:p>
					<w:p><w:r><w:t>Notes</w:t><w:endnoteReference w:id="3"/><w:footnoteReference w:id="2"/></w:r></w:p>
				</w:body></w:document>"#,
			),
			(
				"docs/notes/foot.xml",
				r#"<w:footnotes xmlns:w="w"><w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:t>skip</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Foot</w:t></w:r></w:p></w:footnote></w:footnotes>"#,
			),
			(
				"docs/notes/end.xml",
				r#"<w:endnotes xmlns:w="w"><w:endnote w:id="3"><w:p><w:r><w:t>End</w:t></w:r></w:p></w:endnote></w:endnotes>"#,
			),
		]);
		assert_eq!(
			convert(&bytes, false).unwrap().as_str(),
			"<a id=\"spot\"></a>Target\n\n[Simple](<https://e.com/a b>)\n\n[Complex](https://e.com/c)\n\nNewKept\n\n![Diagram](https://example.com/pic.png)\n\nNotes[^en3][^fn2]\n\n[^en3]: End\n\n[^fn2]: Foot"
		);
	}

	#[test]
	fn resolves_style_chains_outline_levels_run_toggles_and_xml_space() {
		let bytes = docx(&[
			(
				"word/styles.xml",
				r#"<w:styles xmlns:w="w">
					<w:style w:type="paragraph" w:styleId="Base"><w:rPr><w:b/></w:rPr></w:style>
					<w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="Base"/><w:rPr><w:i/></w:rPr></w:style>
					<w:style w:type="character" w:styleId="FlipBold"><w:rPr><w:b/></w:rPr></w:style>
					<w:style w:type="paragraph" w:styleId="HeadBase"><w:name w:val="Heading 2"/><w:rPr><w:b/></w:rPr></w:style>
					<w:style w:type="paragraph" w:styleId="HeadDerived"><w:basedOn w:val="HeadBase"/></w:style>
				</w:styles>"#,
			),
			(
				"word/document.xml",
				r#"<w:document xmlns:w="w"><w:body>
					<w:p><w:pPr><w:pStyle w:val="Derived"/></w:pPr><w:r><w:t>Styled</w:t></w:r></w:p>
					<w:p><w:pPr><w:pStyle w:val="Derived"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FlipBold"/></w:rPr><w:t>Changed</w:t></w:r></w:p>
					<w:p><w:pPr><w:pStyle w:val="HeadDerived"/></w:pPr><w:r><w:t>Title</w:t><w:br w:type="page"/><w:t>next</w:t></w:r></w:p>
					<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>Outline</w:t></w:r></w:p>
					<w:p><w:r><w:t>lead</w:t></w:r><w:r><w:t> discarded </w:t></w:r><w:r><w:t xml:space="preserve"> kept </w:t></w:r><w:r><w:t>tail</w:t></w:r></w:p>
					<w:p><w:r><w:t>Page</w:t><w:br w:type="page"/><w:t>Break</w:t></w:r></w:p>
				</w:body></w:document>"#,
			),
		]);
		assert_eq!(
			convert(&bytes, false).unwrap().as_str(),
			"***Styled***\n\n*Changed*\n\n## Title next\n\n### Outline\n\nleaddiscarded kept \
			 tail\n\nPage  \nBreak"
		);
	}

	#[test]
	fn merges_partial_numbering_and_preserves_instance_counters_across_interruptions() {
		let bytes = docx(&[
			(
				"word/styles.xml",
				r#"<w:styles xmlns:w="w">
					<w:style w:type="paragraph" w:styleId="List"><w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr></w:style>
					<w:style w:type="paragraph" w:styleId="Head"><w:name w:val="Heading 1"/><w:pPr><w:numPr><w:numId w:val="8"/></w:numPr></w:pPr></w:style>
				</w:styles>"#,
			),
			(
				"word/numbering.xml",
				r#"<w:numbering xmlns:w="w">
					<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:start w:val="3"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/><w:start w:val="4"/><w:lvlText w:val="%1.%2)"/></w:lvl></w:abstractNum>
					<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
					<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="none"/></w:lvl></w:abstractNum>
					<w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="8"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="9"><w:abstractNumId w:val="2"/></w:num>
				</w:numbering>"#,
			),
			(
				"word/document.xml",
				r#"<w:document xmlns:w="w"><w:body>
					<w:p><w:pPr><w:pStyle w:val="List"/><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>Child</w:t></w:r></w:p>
					<w:p><w:r><w:t>Interruption</w:t></w:r></w:p>
					<w:p><w:pPr><w:pStyle w:val="List"/><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>Child two</w:t></w:r></w:p>
					<w:p><w:pPr><w:pStyle w:val="Head"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p>
					<w:p><w:pPr><w:numPr><w:numId w:val="9"/></w:numPr></w:pPr><w:r><w:t>Not a list</w:t></w:r></w:p>
				</w:body></w:document>"#,
			),
		]);
		assert_eq!(
			convert(&bytes, false).unwrap().as_str(),
			"  - 3.d) Child\n\nInterruption\n\n  - 3.e) Child two\n\n# 1. Intro\n\nNot a list"
		);
	}

	#[test]
	fn preserves_table_grid_positions_merges_wrappers_and_cell_pipes() {
		let bytes = docx(&[(
			"word/document.xml",
			r#"<w:document xmlns:w="w"><w:body><w:tbl>
				<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr><w:sdt><w:sdtContent><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>A|B</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc></w:tr>
				<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>V</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc></w:tr>
				<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>E</w:t></w:r></w:p></w:tc></w:tr>
				<w:tr><w:tc><w:tcPr><w:hMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>H</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:hMerge/></w:tcPr><w:p><w:r><w:t>I</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>J</w:t></w:r></w:p></w:tc></w:tr>
			</w:tbl></w:body></w:document>"#,
		)]);
		assert_eq!(
			convert(&bytes, false).unwrap().as_str(),
			"|  | A\\|B |  | C |\n| --- | --- | --- | --- |\n| V | D |  |  |\n|  | E |  |  |\n| \
			 H<br>I |  | J |  |"
		);
	}

	#[test]
	fn extracts_text_boxes_charts_smartart_and_embedded_object_identity() {
		let bytes = docx(&[
			(
				"word/_rels/document.xml.rels",
				r#"<Relationships>
					<Relationship Id="chart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/>
					<Relationship Id="diagram1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="diagrams/data1.xml"/>
				</Relationships>"#,
			),
			(
				"word/charts/chart1.xml",
				r#"<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:title><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:v>Q1</c:v></c:tx><c:cat><c:strRef><c:strCache><c:pt><c:v>Jan</c:v></c:pt><c:pt><c:v>Feb</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt><c:v>10</c:v></c:pt><c:pt><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>"#,
			),
			(
				"word/diagrams/data1.xml",
				r#"<dgm:dataModel xmlns:dgm="dgm"><dgm:ptLst><dgm:pt><dgm:t>One</dgm:t></dgm:pt><dgm:pt><dgm:t>Two</dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>"#,
			),
			(
				"word/document.xml",
				r#"<w:document xmlns:w="w" xmlns:r="r" xmlns:c="c" xmlns:dgm="dgm" xmlns:o="o"><w:body>
					<w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>
					<w:p><w:r><w:drawing><c:chart r:id="chart1"/></w:drawing></w:r></w:p>
					<w:p><w:r><w:drawing><dgm:relIds r:dm="diagram1"/></w:drawing></w:r></w:p>
					<w:p><w:r><w:object><o:OLEObject ProgID="Excel.Sheet"/></w:object></w:r></w:p>
				</w:body></w:document>"#,
			),
		]);
		assert_eq!(
			convert(&bytes, false).unwrap().as_str(),
			"Box text\n\n**Sales**\n\n|  | Q1 |\n| --- | --- |\n| Jan | 10 |\n| Feb | 20 |\n\n- \
			 One\n- Two\n\nEmbedded object: Excel.Sheet"
		);
	}

	#[test]
	fn relationship_selection_is_deterministic_and_ignores_external_parts() {
		let bytes = docx(&[
			(
				"_rels/.rels",
				r#"<Relationships>
					<Relationship Id="z" Type="x/officeDocument" Target="word/z.xml"/>
					<Relationship Id="0" Type="x/officeDocument" Target="word/external.xml" TargetMode="External"/>
					<Relationship Id="a" Type="x/officeDocument" Target="word/a.xml"/>
				</Relationships>"#,
			),
			(
				"word/_rels/a.xml.rels",
				r#"<Relationships>
					<Relationship Id="z" Type="x/styles" Target="zstyles.xml"/>
					<Relationship Id="0" Type="x/styles" Target="external-styles.xml" TargetMode="External"/>
					<Relationship Id="a" Type="x/styles" Target="astyles.xml"/>
				</Relationships>"#,
			),
			(
				"word/a.xml",
				r#"<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:pStyle w:val="H"/></w:pPr><w:r><w:t>Chosen</w:t></w:r></w:p></w:body></w:document>"#,
			),
			(
				"word/z.xml",
				r#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Wrong main</w:t></w:r></w:p></w:body></w:document>"#,
			),
			(
				"word/external.xml",
				r#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>External main</w:t></w:r></w:p></w:body></w:document>"#,
			),
			(
				"word/astyles.xml",
				r#"<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="H"><w:name w:val="Heading 2"/></w:style></w:styles>"#,
			),
			(
				"word/zstyles.xml",
				r#"<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="H"><w:name w:val="Heading 1"/></w:style></w:styles>"#,
			),
			(
				"word/external-styles.xml",
				r#"<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="H"><w:name w:val="Heading 3"/></w:style></w:styles>"#,
			),
		]);
		assert_eq!(convert(&bytes, false).unwrap().as_str(), "## Chosen");
	}

	#[test]
	fn alternate_content_uses_one_branch_and_corrupt_xml_is_typed_error() {
		let bytes = docx(&[(
			"word/document.xml",
			r#"<w:document xmlns:w="w" xmlns:mc="mc"><w:body><mc:AlternateContent><mc:Choice Requires="w"><w:p><w:r><w:t>Choice</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:body></w:document>"#,
		)]);
		assert_eq!(convert(&bytes, false).unwrap().as_str(), "Choice");
		let malformed = docx(&[("word/document.xml", "<w:document><w:body>")]);
		assert!(convert(&malformed, false).is_err());
		let mut count = MAX_XML_CONTENT_NODES - 1;
		count_xml_content_node(&mut count).unwrap();
		assert!(count_xml_content_node(&mut count).is_err());
		let deeply_nested = "<w:p>".repeat(MAX_XML_DEPTH);
		assert!(parse_xml(&deeply_nested).is_err());
		let table_xml = parse_xml(
			r#"<w:tbl xmlns:w="w"><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr></w:tc></w:tr><w:tr><w:tc/></w:tr></w:tbl>"#,
		)
		.unwrap();
		let table = descendant(&table_xml, "tbl").unwrap();
		let mut rows = Vec::new();
		collect_table_children(table, "tr", &mut rows);
		check_table_grid_budget(&rows, 4).unwrap();
		assert!(check_table_grid_budget(&rows, 3).is_err());
	}
}
