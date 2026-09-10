//! `PowerPoint` Open XML to deterministic Markdown conversion.

use std::{
	collections::{HashMap, HashSet},
	fmt::Display,
	str,
};

use omp_core::{IntoStr, Str};
use quick_xml::{
	Reader,
	events::{BytesStart, Event},
};

use super::{
	Attachment, Conversion, MarkitError,
	ooxml::{
		Archive, attachment_name, attribute, decode_reference, decode_text, decode_xml_bytes,
		format_url, image_media_type, local_name, render_markdown_table, xml_reader,
	},
};

const FORMAT: &str = "pptx";
const MAX_TABLE_CELLS: usize = 1_000_000;
const OFFICE_DOCUMENT_REL: &str = "/officeDocument";
const SLIDE_REL: &str = "/slide";
const NOTES_REL: &str = "/notesSlide";

/// Converts a PPTX document to Markdown in presentation order.
pub(super) fn convert(bytes: &[u8], extract_media: bool) -> Result<Conversion, MarkitError> {
	let (text, attachments) = convert_inner(bytes, extract_media).map_err(failure)?;
	Ok(Conversion { text: Str::new(text), note: None, title: None, attachments })
}

fn convert_inner(bytes: &[u8], extract_media: bool) -> Result<(String, Vec<Attachment>), String> {
	let mut archive = Archive::open(bytes)?;
	let root_relationships = read_member(&mut archive, "_rels/.rels")?
		.map(|xml| parse_relationships(xml.as_bytes()))
		.transpose()?
		.unwrap_or_default();
	let presentation_path = root_relationships
		.iter()
		.filter(|(_, relationship)| {
			relationship.kind.ends_with(OFFICE_DOCUMENT_REL) && !relationship.external
		})
		.min_by(|(left, _), (right, _)| left.cmp(right))
		.and_then(|(_, relationship)| resolve_part("", &relationship.target))
		.unwrap_or_else(|| "ppt/presentation.xml".to_owned());
	let presentation = read_member(&mut archive, &presentation_path)?
		.ok_or_else(|| "Invalid PPTX: missing presentation.xml".to_owned())?;
	let slide_ids = presentation_slide_ids(presentation.as_bytes())?;
	let presentation_relationships = read_member(
		&mut archive,
		&relationships_part(&presentation_path),
	)?
	.map(|xml| parse_relationships(xml.as_bytes()))
	.transpose()?
	.unwrap_or_default();

	let mut slide_paths = slide_ids
		.iter()
		.filter_map(|id| presentation_relationships.get(id))
		.filter(|relationship| !relationship.external)
		.filter_map(|relationship| resolve_part(&presentation_path, &relationship.target))
		.collect::<Vec<_>>();
	if slide_paths.is_empty() {
		slide_paths = fallback_slide_paths(&archive);
	}

	let mut slide_relationships = Vec::with_capacity(slide_paths.len());
	for slide_path in &slide_paths {
		let relationships = read_member(&mut archive, &relationships_part(slide_path))?
			.map(|xml| parse_relationships(xml.as_bytes()))
			.transpose()?
			.unwrap_or_default();
		slide_relationships.push(relationships);
	}
	let slide_numbers = slide_paths
		.iter()
		.enumerate()
		.map(|(index, path)| (path.as_str(), index + 1))
		.collect::<HashMap<_, _>>();
	let mut targeted_slides = HashSet::new();
	for (slide_path, relationships) in slide_paths.iter().zip(&slide_relationships) {
		for relationship in relationships.values() {
			if !relationship.external
				&& relationship.kind.ends_with(SLIDE_REL)
				&& let Some(target) = resolve_part(slide_path, &relationship.target)
				&& slide_numbers.contains_key(target.as_str())
			{
				targeted_slides.insert(target);
			}
		}
	}

	let mut sections = Vec::with_capacity(slide_paths.len());
	let mut image_count = 0usize;
	let mut attachments = Vec::new();
	let mut attachment_names = HashSet::new();
	let mut extracted_paths = HashSet::new();
	for (index, (slide_path, relationships)) in
		slide_paths.iter().zip(&slide_relationships).enumerate()
	{
		let Some(slide_xml) = read_member(&mut archive, slide_path)? else {
			continue;
		};
		let slide = parse_slide(slide_xml.as_bytes())?;
		if !slide.has_shape_tree {
			continue;
		}

		let mut lines = vec![format!("<!-- Slide {} -->", index + 1)];
		if targeted_slides.contains(slide_path) {
			lines.push(format!("<a id=\"slide-{}\"></a>", index + 1));
		}
		let has_title = slide.items.iter().any(
			|item| matches!(item, SlideItem::Shape(shape) if shape.is_title() && !shape.is_empty()),
		);
		let mut used_fallback_title = false;
		for item in slide.items {
			match item {
				SlideItem::Shape(shape) => {
					if shape.is_chrome() || shape.is_empty() {
						continue;
					}
					let heading = shape.is_title() || (!has_title && !used_fallback_title);
					if heading {
						used_fallback_title = true;
					}
					let rendered =
						render_shape(&shape, relationships, slide_path, &slide_numbers, heading);
					if !rendered.is_empty() {
						lines.push(rendered);
					}
				},
				SlideItem::Picture(picture) => {
					let Some(relationship_id) = picture.relationship_id.as_deref() else {
						continue;
					};
					let Some(relationship) = relationships.get(relationship_id) else {
						continue;
					};
					let alt = picture
						.description
						.or(picture.name)
						.filter(|value| !value.trim().is_empty());
					let internal_path = (!relationship.external)
						.then(|| resolve_part(slide_path, &relationship.target))
						.flatten();
					if !relationship.external
						&& !internal_path
							.as_deref()
							.is_some_and(|target| archive.contains(target))
					{
						continue;
					}
					image_count += 1;
					let alt = alt.unwrap_or_else(|| format!("image_{image_count}"));
					if extract_media
						&& let Some(path) = internal_path.as_deref()
						&& extracted_paths.insert(path.to_owned())
						&& let Some(bytes) = archive.read(path)?
					{
						let name = attachment_name(path, image_count, &mut attachment_names);
						attachments.push(Attachment {
							name:       name.into(),
							media_type: image_media_type(path, &bytes).into(),
							bytes:      bytes.into(),
						});
					}
					if relationship.external {
						lines.push(format!(
							"![{}]({})",
							escape_alt(&alt),
							format_url(&relationship.target)
						));
					} else {
						lines.push(format!(
							"<!-- image: {} (slide {}) -->",
							sanitize_comment(&alt),
							index + 1
						));
					}
				},
				SlideItem::Table(rows) => lines.push(render_markdown_table(rows)),
			}
		}

		let notes_path = relationships
			.iter()
			.filter(|(_, relationship)| {
				relationship.kind.ends_with(NOTES_REL) && !relationship.external
			})
			.min_by(|(left, _), (right, _)| left.cmp(right))
			.and_then(|(_, relationship)| resolve_part(slide_path, &relationship.target))
			.or_else(|| {
				let conventional = slide_path.replace("slides/slide", "notesSlides/notesSlide");
				archive.contains(&conventional).then_some(conventional)
			});
		if let Some(notes_path) = notes_path
			&& let Some(notes_xml) = read_member(&mut archive, &notes_path)?
		{
			let notes_relationships =
				read_member(&mut archive, &relationships_part(&notes_path))?
					.map(|xml| parse_relationships(xml.as_bytes()))
					.transpose()?
					.unwrap_or_default();
			let notes = parse_notes(notes_xml.as_bytes())?
				.into_iter()
				.map(|shape| {
					render_shape(&shape, &notes_relationships, &notes_path, &slide_numbers, false)
				})
				.filter(|text| !text.is_empty())
				.collect::<Vec<_>>();
			if !notes.is_empty() {
				lines.push("\n### Notes:".to_owned());
				lines.push(notes.join("\n"));
			}
		}

		sections.push(lines.join("\n"));
	}

	Ok((sections.join("\n\n").trim().to_owned(), attachments))
}
fn read_member(archive: &mut Archive<'_>, path: &str) -> Result<Option<String>, String> {
	let Some(bytes) = archive.read_xml(path)? else {
		return Ok(None);
	};
	decode_xml_bytes(&bytes)
		.map(Some)
		.map_err(|error| format!("{path} is not valid UTF text: {error}"))
}

fn fallback_slide_paths(archive: &Archive<'_>) -> Vec<String> {
	let mut slides = archive
		.paths()
		.filter_map(|name| {
			let number = name
				.strip_prefix("ppt/slides/slide")?
				.strip_suffix(".xml")?
				.parse::<u64>()
				.ok()?;
			Some((number, name.to_owned()))
		})
		.collect::<Vec<_>>();
	slides.sort_unstable_by_key(|(number, _)| *number);
	slides.into_iter().map(|(_, path)| path).collect()
}

fn presentation_slide_ids(xml: &[u8]) -> Result<Vec<String>, String> {
	let mut reader = xml_reader(xml);
	let mut buffer = Vec::new();
	let mut ids = Vec::new();
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) | Event::Empty(element)
				if local_name(element.name().as_ref()) == "sldId" =>
			{
				if let Some(id) = attribute(&reader, &element, b"id")? {
					ids.push(id);
				}
			},
			Event::Eof => break,
			_ => {},
		}
		buffer.clear();
	}
	Ok(ids)
}

#[derive(Clone)]
struct Relationship {
	target:   String,
	kind:     String,
	external: bool,
}

fn parse_relationships(xml: &[u8]) -> Result<HashMap<String, Relationship>, String> {
	let mut reader = xml_reader(xml);
	let mut buffer = Vec::new();
	let mut relationships = HashMap::new();
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) | Event::Empty(element)
				if local_name(element.name().as_ref()) == "Relationship" =>
			{
				if let (Some(id), Some(target)) =
					(attribute(&reader, &element, b"Id")?, attribute(&reader, &element, b"Target")?)
				{
					let kind = attribute(&reader, &element, b"Type")?.unwrap_or_default();
					let external = attribute(&reader, &element, b"TargetMode")?
						.is_some_and(|mode| mode.eq_ignore_ascii_case("external"));
					relationships
						.entry(id)
						.or_insert(Relationship { target, kind, external });
				}
			},
			Event::Eof => break,
			_ => {},
		}
		buffer.clear();
	}
	Ok(relationships)
}

#[derive(Default)]
struct ParsedSlide {
	has_shape_tree: bool,
	items:          Vec<SlideItem>,
}

enum SlideItem {
	Shape(Shape),
	Picture(Picture),
	Table(Vec<Vec<String>>),
}

#[derive(Default)]
struct Shape {
	paragraphs:   Vec<Paragraph>,
	placeholder:  Option<String>,
	level_styles: HashMap<usize, ParaProps>,
}

impl Shape {
	fn is_empty(&self) -> bool {
		self
			.paragraphs
			.iter()
			.all(|paragraph| paragraph.fragments.iter().all(Fragment::is_empty))
	}

	fn is_title(&self) -> bool {
		matches!(self.placeholder.as_deref(), Some("title" | "ctrTitle"))
	}

	fn is_chrome(&self) -> bool {
		matches!(self.placeholder.as_deref(), Some("sldImg" | "sldNum" | "hdr" | "ftr" | "dt"))
	}
}

struct Picture {
	relationship_id: Option<String>,
	name:            Option<String>,
	description:     Option<String>,
}

#[derive(Default)]
struct Paragraph {
	fragments:  Vec<Fragment>,
	level:      usize,
	properties: ParaProps,
}

#[derive(Clone)]
enum Fragment {
	Text { text: String, style: StyleDelta, hyperlink: Option<String> },
	Break,
}

impl Fragment {
	const fn is_empty(&self) -> bool {
		matches!(self, Self::Break) || matches!(self, Self::Text { text, .. } if text.is_empty())
	}
}

#[derive(Clone, Copy, Default)]
struct TextStyle {
	bold:   bool,
	italic: bool,
	strike: bool,
}

#[derive(Clone, Copy, Default)]
struct StyleDelta {
	bold:   Option<bool>,
	italic: Option<bool>,
	strike: Option<bool>,
}

impl StyleDelta {
	fn apply(self, base: TextStyle) -> TextStyle {
		TextStyle {
			bold:   self.bold.unwrap_or(base.bold),
			italic: self.italic.unwrap_or(base.italic),
			strike: self.strike.unwrap_or(base.strike),
		}
	}

	fn overlay(self, over: Self) -> Self {
		Self {
			bold:   over.bold.or(self.bold),
			italic: over.italic.or(self.italic),
			strike: over.strike.or(self.strike),
		}
	}
}

#[derive(Clone, Copy, Default)]
struct ParaProps {
	bullet: Bullet,
	style:  StyleDelta,
}

#[derive(Clone, Copy, Default)]
enum Bullet {
	#[default]
	Inherit,
	None,
	Char,
	Auto {
		start: u64,
		kind:  NumberKind,
		wrap:  NumberWrap,
	},
}

#[derive(Clone, Copy)]
enum NumberKind {
	Decimal,
	LowerAlpha,
	UpperAlpha,
	LowerRoman,
	UpperRoman,
}
#[derive(Clone, Copy)]
enum NumberWrap {
	Period,
	ParenRight,
	ParenBoth,
	Plain,
}

fn parse_slide(xml: &[u8]) -> Result<ParsedSlide, String> {
	let mut reader = xml_reader(xml);
	let mut buffer = Vec::new();
	let mut slide = ParsedSlide::default();
	let mut in_shape_tree = 0usize;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) if local_name(element.name().as_ref()) == "spTree" => {
				slide.has_shape_tree = true;
				in_shape_tree += 1;
			},
			Event::End(element) if local_name(element.name().as_ref()) == "spTree" => {
				in_shape_tree = in_shape_tree.saturating_sub(1);
			},
			Event::Start(element)
				if in_shape_tree > 0
					&& (local_name(element.name().as_ref()) == "sp"
						|| local_name(element.name().as_ref()) == "cxnSp") =>
			{
				slide
					.items
					.push(SlideItem::Shape(parse_shape(&mut reader)?));
			},
			Event::Start(element)
				if in_shape_tree > 0 && local_name(element.name().as_ref()) == "pic" =>
			{
				slide
					.items
					.push(SlideItem::Picture(parse_picture(&mut reader)?));
			},
			Event::Start(element)
				if in_shape_tree > 0 && local_name(element.name().as_ref()) == "graphicFrame" =>
			{
				if let Some(table) = parse_graphic_frame(&mut reader)? {
					slide.items.push(SlideItem::Table(table));
				}
			},
			Event::Eof => break,
			_ => {},
		}
		buffer.clear();
	}
	Ok(slide)
}

fn parse_notes(xml: &[u8]) -> Result<Vec<Shape>, String> {
	let slide = parse_slide(xml)?;
	Ok(slide
		.items
		.into_iter()
		.filter_map(|item| match item {
			SlideItem::Shape(shape) if !shape.is_chrome() && !shape.is_empty() => Some(shape),
			_ => None,
		})
		.collect())
}

fn parse_shape(reader: &mut Reader<&[u8]>) -> Result<Shape, String> {
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	let mut shape = Shape::default();
	let mut in_text_body = false;
	let mut in_list_style = false;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) => {
				depth += 1;
				let qualified_name = element.name();
				let name = local_name(qualified_name.as_ref());
				if name == "ph" && shape.placeholder.is_none() {
					shape.placeholder =
						attribute(reader, &element, b"type")?.or_else(|| Some("body".to_owned()));
				} else if name == "txBody" {
					in_text_body = true;
				} else if in_text_body && name == "lstStyle" {
					in_list_style = true;
				} else if in_list_style {
					if let Some(level) = level_property_number(name) {
						shape
							.level_styles
							.insert(level, parse_para_properties(reader)?);
						depth -= 1;
					}
				} else if in_text_body && name == "p" {
					shape.paragraphs.push(parse_paragraph(reader)?);
					depth -= 1;
				}
			},
			Event::Empty(element)
				if local_name(element.name().as_ref()) == "ph" && shape.placeholder.is_none() =>
			{
				shape.placeholder =
					attribute(reader, &element, b"type")?.or_else(|| Some("body".to_owned()));
			},
			Event::End(element) => {
				let qualified_name = element.name();
				let name = local_name(qualified_name.as_ref());
				if name == "lstStyle" {
					in_list_style = false;
				}
				if name == "txBody" {
					in_text_body = false;
				}
				if depth == 1 {
					break;
				}
				depth -= 1;
			},
			Event::Eof => return Err("unexpected end of XML inside shape".to_owned()),
			_ => {},
		}
		buffer.clear();
	}
	Ok(shape)
}

fn level_property_number(name: &str) -> Option<usize> {
	let middle = name.strip_prefix("lvl")?.strip_suffix("pPr")?;
	let level = middle.parse::<usize>().ok()?;
	(1..=9).contains(&level).then_some(level - 1)
}

fn parse_paragraph(reader: &mut Reader<&[u8]>) -> Result<Paragraph, String> {
	let mut paragraph = Paragraph::default();
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) => {
				depth += 1;
				match local_name(element.name().as_ref()) {
					"pPr" => {
						paragraph.level = attribute(reader, &element, b"lvl")?
							.and_then(|value| value.parse().ok())
							.unwrap_or(0);
						paragraph.properties = parse_para_properties(reader)?;
						depth -= 1;
					},
					"r" | "fld" => {
						paragraph
							.fragments
							.extend(parse_run(reader, paragraph.properties.style)?);
						depth -= 1;
					},
					"br" => {
						paragraph.fragments.push(Fragment::Break);
						skip_element(reader, "break")?;
						depth -= 1;
					},
					_ => {},
				}
			},
			Event::Empty(element) if local_name(element.name().as_ref()) == "br" => {
				paragraph.fragments.push(Fragment::Break);
			},
			Event::End(_) => {
				if depth == 1 {
					break;
				}
				depth -= 1;
			},
			Event::Eof => return Err("unexpected end of XML inside paragraph".to_owned()),
			_ => {},
		}
		buffer.clear();
	}
	Ok(paragraph)
}

fn parse_para_properties(reader: &mut Reader<&[u8]>) -> Result<ParaProps, String> {
	let mut properties = ParaProps::default();
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) => {
				depth += 1;
				apply_para_property(reader, &element, &mut properties)?;
			},
			Event::Empty(element) => apply_para_property(reader, &element, &mut properties)?,
			Event::End(_) => {
				if depth == 1 {
					break;
				}
				depth -= 1;
			},
			Event::Eof => {
				return Err("unexpected end of XML inside paragraph properties".to_owned());
			},
			_ => {},
		}
		buffer.clear();
	}
	Ok(properties)
}

fn apply_para_property(
	reader: &Reader<&[u8]>,
	element: &BytesStart<'_>,
	properties: &mut ParaProps,
) -> Result<(), String> {
	match local_name(element.name().as_ref()) {
		"buNone" => properties.bullet = Bullet::None,
		"buChar" => properties.bullet = Bullet::Char,
		"buAutoNum" => {
			let scheme = attribute(reader, element, b"type")?.unwrap_or_default();
			let kind = if scheme.starts_with("alphaLc") {
				NumberKind::LowerAlpha
			} else if scheme.starts_with("alphaUc") {
				NumberKind::UpperAlpha
			} else if scheme.starts_with("romanLc") {
				NumberKind::LowerRoman
			} else if scheme.starts_with("romanUc") {
				NumberKind::UpperRoman
			} else {
				NumberKind::Decimal
			};
			let wrap = if scheme.ends_with("ParenBoth") {
				NumberWrap::ParenBoth
			} else if scheme.ends_with("ParenR") {
				NumberWrap::ParenRight
			} else if scheme.ends_with("Plain") {
				NumberWrap::Plain
			} else {
				NumberWrap::Period
			};
			let start = attribute(reader, element, b"startAt")?
				.and_then(|value| value.parse::<i64>().ok())
				.map_or(1, |value| value.clamp(1, 32767) as u64);
			properties.bullet = Bullet::Auto { start, kind, wrap };
		},
		"defRPr" => properties.style = properties.style.overlay(parse_style(reader, element)?),
		_ => {},
	}
	Ok(())
}

fn parse_run(reader: &mut Reader<&[u8]>, base: StyleDelta) -> Result<Vec<Fragment>, String> {
	let mut fragments = Vec::new();
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	let mut delta = StyleDelta::default();
	let mut hyperlink = None;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) => {
				depth += 1;
				match local_name(element.name().as_ref()) {
					"rPr" => delta = delta.overlay(parse_style(reader, &element)?),
					"hlinkClick" => hyperlink = attribute(reader, &element, b"id")?,
					"t" => {
						let text = read_element_text(reader)?;
						fragments.push(Fragment::Text {
							text,
							style: base.overlay(delta),
							hyperlink: hyperlink.clone(),
						});
						depth -= 1;
					},
					"br" => {
						fragments.push(Fragment::Break);
						skip_element(reader, "break")?;
						depth -= 1;
					},
					_ => {},
				}
			},
			Event::Empty(element) => match local_name(element.name().as_ref()) {
				"rPr" => delta = delta.overlay(parse_style(reader, &element)?),
				"hlinkClick" => hyperlink = attribute(reader, &element, b"id")?,
				"br" => fragments.push(Fragment::Break),
				_ => {},
			},
			Event::End(_) => {
				if depth == 1 {
					break;
				}
				depth -= 1;
			},
			Event::Eof => return Err("unexpected end of XML inside text run".to_owned()),
			_ => {},
		}
		buffer.clear();
	}
	Ok(fragments)
}

fn parse_style(reader: &Reader<&[u8]>, element: &BytesStart<'_>) -> Result<StyleDelta, String> {
	let on_off = |name| -> Result<Option<bool>, String> {
		Ok(attribute(reader, element, name)?
			.map(|value| matches!(value.as_str(), "1" | "true" | "on")))
	};
	Ok(StyleDelta {
		bold:   on_off(b"b")?,
		italic: on_off(b"i")?,
		strike: attribute(reader, element, b"strike")?
			.map(|value| matches!(value.as_str(), "sngStrike" | "dblStrike")),
	})
}

fn parse_picture(reader: &mut Reader<&[u8]>) -> Result<Picture, String> {
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	let mut relationship_id = None;
	let mut name = None;
	let mut description = None;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) => {
				depth += 1;
				if local_name(element.name().as_ref()) == "blip" {
					relationship_id =
						attribute(reader, &element, b"embed")?.or(attribute(reader, &element, b"link")?);
				} else if local_name(element.name().as_ref()) == "cNvPr" {
					name = name.or(attribute(reader, &element, b"name")?);
					description = description.or(attribute(reader, &element, b"descr")?);
				}
			},
			Event::Empty(element) => {
				if local_name(element.name().as_ref()) == "blip" {
					relationship_id =
						attribute(reader, &element, b"embed")?.or(attribute(reader, &element, b"link")?);
				} else if local_name(element.name().as_ref()) == "cNvPr" {
					name = name.or(attribute(reader, &element, b"name")?);
					description = description.or(attribute(reader, &element, b"descr")?);
				}
			},
			Event::End(_) => {
				if depth == 1 {
					break;
				}
				depth -= 1;
			},
			Event::Eof => return Err("unexpected end of XML inside picture".to_owned()),
			_ => {},
		}
		buffer.clear();
	}
	Ok(Picture { relationship_id, name, description })
}

fn parse_graphic_frame(reader: &mut Reader<&[u8]>) -> Result<Option<Vec<Vec<String>>>, String> {
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	let mut table = None;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) => {
				depth += 1;
				if local_name(element.name().as_ref()) == "tbl" {
					table = Some(parse_table(reader)?);
					depth -= 1;
				}
			},
			Event::End(_) => {
				if depth == 1 {
					break;
				}
				depth -= 1;
			},
			Event::Eof => return Err("unexpected end of XML inside graphic frame".to_owned()),
			_ => {},
		}
		buffer.clear();
	}
	Ok(table.filter(|rows| !rows.is_empty()))
}

#[derive(Default)]
struct TableCell {
	text:     String,
	col_span: usize,
	row_span: usize,
	covered:  bool,
}

fn parse_table(reader: &mut Reader<&[u8]>) -> Result<Vec<Vec<String>>, String> {
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	let mut source_rows = Vec::new();
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) => {
				depth += 1;
				if local_name(element.name().as_ref()) == "tr" {
					source_rows.push(parse_table_row(reader)?);
					depth -= 1;
				}
			},
			Event::End(_) => {
				if depth == 1 {
					break;
				}
				depth -= 1;
			},
			Event::Eof => return Err("unexpected end of XML inside table".to_owned()),
			_ => {},
		}
		buffer.clear();
	}
	expand_table(source_rows)
}

fn parse_table_row(reader: &mut Reader<&[u8]>) -> Result<Vec<TableCell>, String> {
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	let mut cells = Vec::new();
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) => {
				depth += 1;
				if local_name(element.name().as_ref()) == "tc" {
					cells.push(parse_table_cell(reader, &element)?);
					depth -= 1;
				}
			},
			Event::End(_) => {
				if depth == 1 {
					break;
				}
				depth -= 1;
			},
			Event::Eof => return Err("unexpected end of XML inside table row".to_owned()),
			_ => {},
		}
		buffer.clear();
	}
	Ok(cells)
}

fn parse_table_cell(
	reader: &mut Reader<&[u8]>,
	start: &BytesStart<'_>,
) -> Result<TableCell, String> {
	let col_span = positive_span(attribute(reader, start, b"gridSpan")?)?;
	let row_span = positive_span(attribute(reader, start, b"rowSpan")?)?;
	let covered =
		bool_attribute(reader, start, b"hMerge")? || bool_attribute(reader, start, b"vMerge")?;
	if col_span
		.checked_mul(row_span)
		.is_none_or(|area| area > MAX_TABLE_CELLS)
	{
		return Err(format!("PPTX table span exceeds {MAX_TABLE_CELLS} cell limit"));
	}
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	let mut paragraphs = Vec::new();
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(element) => {
				depth += 1;
				if local_name(element.name().as_ref()) == "p" {
					paragraphs.push(parse_paragraph(reader)?);
					depth -= 1;
				}
			},
			Event::End(_) => {
				if depth == 1 {
					break;
				}
				depth -= 1;
			},
			Event::Eof => return Err("unexpected end of XML inside table cell".to_owned()),
			_ => {},
		}
		buffer.clear();
	}
	let text = paragraphs
		.into_iter()
		.map(|paragraph| {
			render_fragments(
				&paragraph.fragments,
				&HashMap::new(),
				"",
				&HashMap::new(),
				TextStyle::default(),
			)
		})
		.filter(|text| !text.is_empty())
		.collect::<Vec<_>>()
		.join("<br>");
	Ok(TableCell { text, col_span, row_span, covered })
}

fn expand_table(source_rows: Vec<Vec<TableCell>>) -> Result<Vec<Vec<String>>, String> {
	let mut rows: Vec<Vec<String>> = Vec::new();
	let mut occupied: HashSet<(usize, usize)> = HashSet::new();
	for (row_index, source_row) in source_rows.into_iter().enumerate() {
		if row_index >= MAX_TABLE_CELLS {
			return Err("PPTX table exceeds cell limit".to_owned());
		}
		if rows.len() <= row_index {
			rows.resize_with(row_index + 1, Vec::new);
		}
		let mut column = 0usize;
		for cell in source_row {
			while occupied.contains(&(row_index, column)) {
				column += 1;
			}
			if cell.covered {
				if rows[row_index].len() <= column {
					rows[row_index].resize(column + 1, String::new());
				}
				column += 1;
				continue;
			}
			let end_row = row_index
				.checked_add(cell.row_span)
				.ok_or_else(|| "PPTX table span overflow".to_owned())?;
			let end_column = column
				.checked_add(cell.col_span)
				.ok_or_else(|| "PPTX table span overflow".to_owned())?;
			if end_row
				.checked_mul(end_column)
				.is_none_or(|area| area > MAX_TABLE_CELLS)
			{
				return Err("PPTX table exceeds cell limit".to_owned());
			}
			if rows.len() < end_row {
				rows.resize_with(end_row, Vec::new);
			}
			for (row, values) in rows.iter_mut().enumerate().take(end_row).skip(row_index) {
				if values.len() < end_column {
					values.resize(end_column, String::new());
				}
				for col in column..end_column {
					occupied.insert((row, col));
				}
			}
			rows[row_index][column] = cell.text;
			column = end_column;
		}
	}
	Ok(rows)
}

fn render_shape(
	shape: &Shape,
	relationships: &HashMap<String, Relationship>,
	base_part: &str,
	slide_numbers: &HashMap<&str, usize>,
	heading: bool,
) -> String {
	let mut counters = [0u64; 9];
	let mut started = [false; 9];
	let mut lines = Vec::new();
	for paragraph in &shape.paragraphs {
		let level = paragraph.level.min(8);
		let inherited = shape.level_styles.get(&level).copied().unwrap_or_default();
		let bullet = match paragraph.properties.bullet {
			Bullet::Inherit => inherited.bullet,
			bullet => bullet,
		};
		let base = inherited.style.apply(TextStyle::default());
		let text =
			render_fragments(&paragraph.fragments, relationships, base_part, slide_numbers, base);
		if text.is_empty() {
			continue;
		}
		let indent = "  ".repeat(level);
		let line = match bullet {
			Bullet::Char => format!("{indent}- {text}"),
			Bullet::Auto { start, kind, wrap } => {
				let number = if started[level] {
					counters[level].saturating_add(1)
				} else {
					started[level] = true;
					start
				};
				counters[level] = number;
				for deeper in started.iter_mut().skip(level + 1) {
					*deeper = false;
				}
				let label = number_label(kind, wrap, number);
				if matches!((kind, wrap), (NumberKind::Decimal, NumberWrap::Period)) {
					format!("{indent}{label} {text}")
				} else {
					format!("{indent}- {label} {text}")
				}
			},
			Bullet::None | Bullet::Inherit => text,
		};
		lines.push(line);
	}
	let text = lines.join("\n");
	if heading && !text.is_empty() {
		format!("# {text}")
	} else {
		text
	}
}

fn render_fragments(
	fragments: &[Fragment],
	relationships: &HashMap<String, Relationship>,
	base_part: &str,
	slide_numbers: &HashMap<&str, usize>,
	base_style: TextStyle,
) -> String {
	let mut rendered = String::new();
	for fragment in fragments {
		match fragment {
			Fragment::Break => rendered.push_str("  \n"),
			Fragment::Text { text, style, hyperlink } => {
				let style = style.apply(base_style);
				let mut value = text.clone();
				if style.strike {
					value = format!("~~{value}~~");
				}
				if style.bold {
					value = format!("**{value}**");
				}
				if style.italic {
					value = format!("_{value}_");
				}
				if let Some(id) = hyperlink
					&& let Some(relationship) = relationships.get(id)
				{
					let destination = if !relationship.external && relationship.kind.ends_with(SLIDE_REL)
					{
						resolve_part(base_part, &relationship.target).and_then(|path| {
							slide_numbers
								.get(path.as_str())
								.map(|number| format!("#slide-{number}"))
						})
					} else {
						Some(relationship.target.clone())
					};
					if let Some(destination) = destination {
						value = format!("[{value}]({})", format_url(&destination));
					}
				}
				rendered.push_str(&value);
			},
		}
	}
	rendered
}

fn number_label(kind: NumberKind, wrap: NumberWrap, number: u64) -> String {
	let ordinal = match kind {
		NumberKind::Decimal => number.to_string(),
		NumberKind::LowerAlpha => alpha_ordinal(number, false),
		NumberKind::UpperAlpha => alpha_ordinal(number, true),
		NumberKind::LowerRoman => roman_ordinal(number).to_ascii_lowercase(),
		NumberKind::UpperRoman => roman_ordinal(number),
	};
	match wrap {
		NumberWrap::Period => format!("{ordinal}."),
		NumberWrap::ParenRight => format!("{ordinal})"),
		NumberWrap::ParenBoth => format!("({ordinal})"),
		NumberWrap::Plain => ordinal,
	}
}

fn alpha_ordinal(mut number: u64, uppercase: bool) -> String {
	let mut bytes = Vec::new();
	while number > 0 {
		number -= 1;
		bytes.push((if uppercase { b'A' } else { b'a' }) + (number % 26) as u8);
		number /= 26;
	}
	bytes.reverse();
	String::from_utf8(bytes).unwrap_or_default()
}

fn roman_ordinal(mut number: u64) -> String {
	let mut output = String::new();
	for (value, symbol) in [
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
		while number >= value {
			output.push_str(symbol);
			number -= value;
		}
	}
	output
}

fn relationships_part(part: &str) -> String {
	let (directory, file) = part.rsplit_once('/').unwrap_or(("", part));
	if directory.is_empty() {
		format!("_rels/{file}.rels")
	} else {
		format!("{directory}/_rels/{file}.rels")
	}
}

fn resolve_part(base_part: &str, target: &str) -> Option<String> {
	let mut parts = if target.starts_with('/') {
		Vec::new()
	} else {
		base_part
			.rsplit_once('/')
			.map(|(directory, _)| {
				directory
					.split('/')
					.filter(|part| !part.is_empty())
					.map(str::to_owned)
					.collect::<Vec<_>>()
			})
			.unwrap_or_default()
	};
	let target = target.replace('\\', "/");
	for part in target.trim_start_matches('/').split('/') {
		match part {
			"" | "." => {},
			".." => {
				parts.pop()?;
			},
			_ => parts.push(part.to_owned()),
		}
	}
	(!parts.is_empty()).then(|| parts.join("/"))
}

fn positive_span(value: Option<String>) -> Result<usize, String> {
	match value {
		Some(value) => value
			.parse::<usize>()
			.map(|value| value.max(1))
			.map_err(|_| "invalid PPTX table span".to_owned()),
		None => Ok(1),
	}
}

fn bool_attribute(
	reader: &Reader<&[u8]>,
	element: &BytesStart<'_>,
	name: &[u8],
) -> Result<bool, String> {
	Ok(attribute(reader, element, name)?
		.is_some_and(|value| matches!(value.as_str(), "1" | "true" | "on")))
}

fn read_element_text(reader: &mut Reader<&[u8]>) -> Result<String, String> {
	let mut buffer = Vec::new();
	let mut text = String::new();
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Text(part) => text.push_str(&decode_text(&part)?),
			Event::GeneralRef(part) => text.push_str(&decode_reference(&part)?),
			Event::CData(part) => text.push_str(&part),
			Event::End(_) => break,
			Event::Eof => return Err("unexpected end of XML inside text element".to_owned()),
			_ => {},
		}
		buffer.clear();
	}
	Ok(text)
}

fn skip_element(reader: &mut Reader<&[u8]>, label: &str) -> Result<(), String> {
	let mut buffer = Vec::new();
	let mut depth = 1usize;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(_) => depth += 1,
			Event::End(_) => {
				depth -= 1;
				if depth == 0 {
					return Ok(());
				}
			},
			Event::Eof => return Err(format!("unexpected end of XML inside {label}")),
			_ => {},
		}
		buffer.clear();
	}
}

fn sanitize_comment(value: &str) -> String {
	value.replace("--", "—")
}

fn escape_alt(value: &str) -> String {
	value.replace(']', "\\]")
}

fn xml_error(error: impl Display) -> String {
	format!("invalid PPTX XML: {error}")
}
fn failure(error: impl IntoStr) -> MarkitError {
	MarkitError::conversion(FORMAT, error)
}

#[cfg(test)]
mod tests {
	use omp_ar::zip::Writer;

	use super::{convert, format_url};

	fn pptx(parts: &[(&str, &str)]) -> Vec<u8> {
		let mut archive = Writer::new(Vec::new());
		for (name, contents) in parts {
			archive.add_file(name, contents.as_bytes()).unwrap();
		}
		archive.finish().unwrap()
	}

	fn pptx_bytes(parts: &[(&str, &[u8])]) -> Vec<u8> {
		let mut archive = Writer::new(Vec::new());
		for (name, contents) in parts {
			archive.add_file(name, contents).unwrap();
		}
		archive.finish().unwrap()
	}

	fn utf16le(text: &str) -> Vec<u8> {
		let mut bytes = vec![0xff, 0xfe];
		for unit in text.encode_utf16() {
			bytes.extend_from_slice(&unit.to_le_bytes());
		}
		bytes
	}

	fn base_parts<'a>(slide: &'a str, slide_rels: &'a str) -> [(&'a str, &'a str); 4] {
		[
			(
				"ppt/presentation.xml",
				r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>"#,
			),
			(
				"ppt/_rels/presentation.xml.rels",
				r#"<Relationships><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/></Relationships>"#,
			),
			("ppt/slides/slide1.xml", slide),
			("ppt/slides/_rels/slide1.xml.rels", slide_rels),
		]
	}

	#[test]
	fn preserves_tree_order_and_renders_rich_text_lists_links_and_breaks() {
		let slide = r#"<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>
		<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Kicker</a:t></a:r></a:p></p:txBody></p:sp>
		<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr b="1"/><a:t>Rich</a:t></a:r><a:br/><a:r><a:rPr i="1"><a:hlinkClick r:id="rId9"/></a:rPr><a:t>title</a:t></a:r></a:p></p:txBody></p:sp>
		<p:cxnSp><p:txBody><a:p><a:pPr lvl="1"><a:buAutoNum type="alphaLcParenR" startAt="3"/></a:pPr><a:r><a:t>Connector item</a:t></a:r></a:p></p:txBody></p:cxnSp>
		</p:spTree></p:cSld></p:sld>"#;
		let rels = r#"<Relationships><Relationship Id="rId9" Type="x/hyperlink" Target="https://example.com/a b(c)|&lt;x&gt;" TargetMode="External"/></Relationships>"#;
		let markdown = convert(&pptx(&base_parts(slide, rels)), false).unwrap();
		assert_eq!(
			markdown.as_str(),
			"<!-- Slide 1 -->\nKicker\n# **Rich**  \n[_title_](<https://example.com/a \
			 b(c)%7C%3Cx%3E>)\n  - c) Connector item"
		);
	}

	#[test]
	fn keeps_images_tables_and_notes_in_relationship_order_semantics() {
		let slide = r#"<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>
		<p:sp><p:txBody><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>
		<p:pic><p:nvPicPr><p:cNvPr name="Picture 1" descr="Meaningful alt"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
		<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>Wide</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc vMerge="1"><a:txBody><a:p/></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Tail</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
		<p:pic><p:nvPicPr><p:cNvPr descr="Remote alt"/></p:nvPicPr><p:blipFill><a:blip r:link="rId4"/></p:blipFill></p:pic>
		</p:spTree></p:cSld></p:sld>"#;
		let rels = r#"<Relationships><Relationship Id="rId2" Type="x/image" Target="../media/p.png"/><Relationship Id="rId3" Type="x/notesSlide" Target="../odd/notes.xml"/><Relationship Id="rId4" Type="x/image" Target="https://example.com/image(a).png|raw" TargetMode="External"/></Relationships>"#;
		let notes = r#"<p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>chrome</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Speaker text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>"#;
		let mut parts = base_parts(slide, rels).to_vec();
		parts.push(("ppt/media/p.png", "png"));
		parts.push(("ppt/odd/notes.xml", notes));
		let markdown = convert(&pptx(&parts), false).unwrap();
		assert_eq!(markdown.as_str(), "<!-- Slide 1 -->\n# Title\n<!-- image: Meaningful alt (slide 1) -->\n| Wide |  |\n| --- | --- |\n|  | Tail |\n![Remote alt](<https://example.com/image(a).png%7Craw>)\n\n### Notes:\nSpeaker text");
	}

	#[test]
	fn formats_markdown_destinations_without_structure_injection() {
		assert_eq!(format_url("https://example.com/<x>|a\nb"), "https://example.com/%3Cx%3E%7Ca%0Ab");
		assert_eq!(format_url("a b(c)"), "<a b(c)>");
	}

	#[test]
	fn numbers_fallback_image_names_once_and_sanitizes_comments() {
		let slide = r#"<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>
		<p:pic><p:nvPicPr><p:cNvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>
		<p:pic><p:nvPicPr><p:cNvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
		<p:pic><p:nvPicPr><p:cNvPr descr="close --> inject"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic>
		</p:spTree></p:cSld></p:sld>"#;
		let rels = r#"<Relationships>
		<Relationship Id="rId1" Type="x/image" Target="../media/one.png"/>
		<Relationship Id="rId2" Type="x/image" Target="../media/two.png"/>
		<Relationship Id="rId3" Type="x/image" Target="../media/three.png"/>
		</Relationships>"#;
		let mut parts = base_parts(slide, rels).to_vec();
		parts.push(("ppt/media/one.png", "one"));
		parts.push(("ppt/media/two.png", "two"));
		parts.push(("ppt/media/three.png", "three"));
		let markdown = convert(&pptx(&parts), false).unwrap();
		assert_eq!(
			markdown.as_str(),
			"<!-- Slide 1 -->\n<!-- image: image_1 (slide 1) -->\n<!-- image: image_2 (slide 1) \
			 -->\n<!-- image: close —> inject (slide 1) -->"
		);
	}

	#[test]
	fn rejects_pathological_table_spans_without_allocating_them() {
		let slide = r#"<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:graphicFrame><a:tbl><a:tr><a:tc gridSpan="2000000000" rowSpan="2000000000"><a:txBody><a:p/></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame></p:spTree></p:cSld></p:sld>"#;
		let error = convert(&pptx(&base_parts(slide, "<Relationships/>")), false).unwrap_err();
		assert!(error.to_string().contains("table span exceeds"));
	}

	#[test]
	fn converts_utf16_encoded_slide_member() {
		let slide = utf16le(
			r#"<?xml version="1.0" encoding="UTF-16"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Héllo</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#,
		);
		let bytes = pptx_bytes(&[
			(
				"ppt/presentation.xml",
				br#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>"#,
			),
			(
				"ppt/_rels/presentation.xml.rels",
				br#"<Relationships><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/></Relationships>"#,
			),
			("ppt/slides/slide1.xml", &slide),
			("ppt/slides/_rels/slide1.xml.rels", br#"<Relationships/>"#),
		]);

		let markdown = convert(&bytes, false).expect("UTF-16 PPTX should convert");
		assert_eq!(markdown.as_str(), "<!-- Slide 1 -->\n# Héllo");
	}
}
