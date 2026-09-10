//! Shared OOXML archive, XML, and Markdown helpers.

use std::{
	collections::{BTreeMap, HashSet},
	io::Cursor,
	path::{Component, Path, PathBuf},
	str,
};

use omp_ar::{Archive as ArArchive, Format, Limits};
use quick_xml::{
	Reader, XmlVersion,
	escape::{resolve_predefined_entity, unescape},
	events::{BytesRef, BytesStart, BytesText},
};

const MAX_ARCHIVE_MEMBER_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTITY_EXPANSIONS: usize = 1_000_000;

pub(super) struct Archive<'a> {
	archive: ArArchive<Cursor<&'a [u8]>>,
	entries: BTreeMap<String, String>,
}

impl<'a> Archive<'a> {
	pub(super) fn open(bytes: &'a [u8]) -> Result<Self, String> {
		let limits = Limits::DEFAULT.with_max_member_size(MAX_ARCHIVE_MEMBER_BYTES);
		let archive = ArArchive::from_bytes_with_format_and_limits(bytes, Format::Zip, limits)
			.map_err(|error| format!("invalid ZIP container: {error}"))?;
		let mut entries = BTreeMap::new();
		for entry in archive.entries().filter(|entry| !entry.is_directory()) {
			if entry.size() > MAX_ARCHIVE_MEMBER_BYTES {
				return Err(format!(
					"Archive member '{}' is too large to extract in memory ({} bytes > {} byte limit)",
					entry.path(),
					entry.size(),
					MAX_ARCHIVE_MEMBER_BYTES
				));
			}
			let Some(path) = normalize_part_name(entry.path()) else {
				continue;
			};
			entries.insert(path, entry.path().to_owned());
		}
		Ok(Self { archive, entries })
	}

	pub(super) fn paths(&self) -> impl Iterator<Item = &str> {
		self.entries.keys().map(String::as_str)
	}

	pub(super) fn contains(&self, path: &str) -> bool {
		self.entries.contains_key(path)
	}

	pub(super) fn read(&mut self, path: &str) -> Result<Option<Vec<u8>>, String> {
		let Some(source_path) = self.entries.get(path) else {
			return Ok(None);
		};
		self
			.archive
			.read(source_path)
			.map(Some)
			.map_err(|error| format!("could not read {path}: {error}"))
	}

	pub(super) fn read_xml(&mut self, path: &str) -> Result<Option<Vec<u8>>, String> {
		let Some(bytes) = self.read(path)? else {
			return Ok(None);
		};
		validate_entity_expansion_cap(&bytes)?;
		Ok(Some(bytes))
	}
}

pub(super) fn attachment_name(path: &str, ordinal: usize, used: &mut HashSet<String>) -> String {
	let source = Path::new(path)
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("");
	let mut name = source
		.chars()
		.take(120)
		.map(|character| {
			if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
				character
			} else {
				'_'
			}
		})
		.collect::<String>();
	if name.is_empty() || matches!(name.as_str(), "." | "..") {
		name = format!("image-{ordinal}");
	}
	if used.insert(name.clone()) {
		return name;
	}
	let (stem, extension) = name.rsplit_once('.').unwrap_or((name.as_str(), ""));
	for duplicate in 2.. {
		let candidate = if extension.is_empty() {
			format!("{stem}-{duplicate}")
		} else {
			format!("{stem}-{duplicate}.{extension}")
		};
		if used.insert(candidate.clone()) {
			return candidate;
		}
	}
	unreachable!("duplicate ordinal space is unbounded")
}

pub(super) fn image_media_type(path: &str, bytes: &[u8]) -> &'static str {
	if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
		return "image/png";
	}
	if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
		return "image/jpeg";
	}
	if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
		return "image/gif";
	}
	if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
		return "image/webp";
	}
	match Path::new(path)
		.extension()
		.and_then(|extension| extension.to_str())
		.unwrap_or("")
		.to_ascii_lowercase()
		.as_str()
	{
		"bmp" => "image/bmp",
		"emf" => "image/emf",
		"svg" => "image/svg+xml",
		"tif" | "tiff" => "image/tiff",
		"wmf" => "image/wmf",
		_ => "application/octet-stream",
	}
}

fn normalize_part_name(name: &str) -> Option<String> {
	let name = name.replace('\\', "/");
	normalize_path(Path::new(name.trim_start_matches('/')))
}

fn normalize_path(path: &Path) -> Option<String> {
	let mut normalized = PathBuf::new();
	for component in path.components() {
		match component {
			Component::Normal(part) => normalized.push(part),
			Component::CurDir => {},
			Component::ParentDir => {
				if !normalized.pop() {
					return None;
				}
			},
			Component::RootDir | Component::Prefix(_) => return None,
		}
	}
	let normalized = normalized.to_str()?.replace('\\', "/");
	(!normalized.is_empty()).then_some(normalized)
}

fn validate_entity_expansion_cap(xml: &[u8]) -> Result<(), String> {
	let mut expansions = 0usize;
	let mut index = 0usize;
	while let Some(relative) = xml[index..].iter().position(|byte| *byte == b'&') {
		let start = index + relative;
		let Some(end) = xml[start + 1..].iter().position(|byte| *byte == b';') else {
			break;
		};
		expansions += 1;
		if expansions > MAX_ENTITY_EXPANSIONS {
			return Err(format!(
				"invalid XML: entity expansion count exceeds {MAX_ENTITY_EXPANSIONS}"
			));
		}
		index = start + end + 2;
	}
	Ok(())
}

pub(super) fn decode_xml_bytes(bytes: &[u8]) -> Result<String, String> {
	let (bom, skip) = xutf::detect_bom(bytes);
	match bom {
		xutf::Bom::None | xutf::Bom::Utf8 => str::from_utf8(&bytes[skip..])
			.map(str::to_owned)
			.map_err(|error| error.to_string()),
		_ => {
			let decoded = xutf::from_bytes::<xutf::Utf8>(bytes);
			String::from_utf8(decoded).map_err(|error| error.to_string())
		},
	}
}

pub(super) fn xml_reader(xml: &[u8]) -> Reader<&[u8]> {
	let mut reader = Reader::from_reader(xml);
	reader.config_mut().trim_text(false);
	reader
}

pub(super) fn attribute(
	_reader: &Reader<&[u8]>,
	start: &BytesStart<'_>,
	wanted: &[u8],
) -> Result<Option<String>, String> {
	for attribute in start.attributes().with_checks(false) {
		let attribute = attribute.map_err(|error| format!("invalid XML: {error}"))?;
		let wanted = wanted.rsplit(|byte| *byte == b':').next().unwrap_or(wanted);
		if local_name(attribute.key.as_ref()).as_bytes() == wanted {
			return attribute
				.normalized_value(XmlVersion::Implicit1_0)
				.map(|value| Some(value.into_owned()))
				.map_err(|error| format!("invalid XML: {error}"));
		}
	}
	Ok(None)
}

pub(super) fn decode_text(text: &BytesText<'_>) -> Result<String, String> {
	let decoded = text.xml_content(XmlVersion::Implicit1_0);
	unescape(&decoded)
		.map(|text| text.into_owned())
		.map_err(|error| format!("invalid XML: {error}"))
}

pub(super) fn decode_reference(reference: &BytesRef<'_>) -> Result<String, String> {
	if let Some(character) = reference
		.resolve_char_ref()
		.map_err(|error| format!("invalid XML: {error}"))?
	{
		return Ok(character.to_string());
	}
	let name = reference.xml_content(XmlVersion::Implicit1_0);
	resolve_predefined_entity(&name)
		.map(str::to_owned)
		.ok_or_else(|| format!("invalid XML: unknown entity '&{name};'"))
}

pub(super) fn local_name(name: &str) -> &str {
	name.rsplit(':').next().unwrap_or(name)
}

/// Formats a Markdown link destination without allowing structural injection.
pub(super) fn format_url(url: &str) -> String {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	let mut escaped = String::with_capacity(url.len());
	for character in url.chars() {
		match character {
			'<' => escaped.push_str("%3C"),
			'>' => escaped.push_str("%3E"),
			'|' => escaped.push_str("%7C"),
			character if character.is_control() => {
				let mut bytes = [0; 4];
				for byte in character.encode_utf8(&mut bytes).bytes() {
					escaped.push('%');
					escaped.push(HEX[(byte >> 4) as usize] as char);
					escaped.push(HEX[(byte & 0x0f) as usize] as char);
				}
			},
			character => escaped.push(character),
		}
	}
	if escaped
		.chars()
		.any(|character| character.is_whitespace() || matches!(character, '(' | ')'))
	{
		format!("<{escaped}>")
	} else {
		escaped
	}
}

pub(super) fn render_markdown_table(mut rows: Vec<Vec<String>>) -> String {
	let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
	for row in &mut rows {
		row.resize(columns, String::new());
	}
	let mut rows = rows.into_iter();
	let header = rows.next().unwrap_or_default();
	let mut lines = Vec::new();
	lines.push(format!("| {} |", header.join(" | ")));
	lines.push(format!("| {} |", vec!["---"; columns].join(" | ")));
	lines.extend(rows.map(|row| format!("| {} |", row.join(" | "))));
	lines.join("\n")
}
