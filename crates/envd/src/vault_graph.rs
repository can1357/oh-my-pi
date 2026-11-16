//! Native markdown graph queries for a configured `vault://` root.
//!
//! These reads stay inside [`VaultService`]'s symlink confinement and never
//! start the Obsidian CLI. A query returns one compact JSON document: note
//! metadata, one heading section, backlinks, a tag match, or the link map of
//! a single note.

use omp_ast::block::{BlockRangeOptions, block_range_at};
use omp_core::{CowBytes, Str};
use serde::Serialize;

use crate::vault::{VaultError, VaultService};

/// Files visited by one graph walk.
const FILE_LIMIT: usize = 512;
/// Bytes of note text one graph walk may read.
const BYTE_LIMIT: usize = 4 * 1024 * 1024;
/// Bytes of one note a graph query may read.
const NOTE_LIMIT: usize = 256 * 1024;
/// Matching notes returned by a backlink or tag query.
const RESULT_LIMIT: usize = 64;
/// Direct children read from one directory before the walk reports truncation.
const DIRECTORY_LIMIT: usize = 1_000;

/// Bounds for one native vault graph query.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GraphLimits {
	/// Maximum notes the walk opens.
	pub(crate) files:   usize,
	/// Maximum note bytes the walk reads.
	pub(crate) bytes:   usize,
	/// Maximum bytes of one note.
	pub(crate) note:    usize,
	/// Maximum matching rows in the JSON result.
	pub(crate) results: usize,
}

impl GraphLimits {
	/// Bounds used by `vault://` reads.
	pub(crate) const fn production() -> Self {
		Self { files: FILE_LIMIT, bytes: BYTE_LIMIT, note: NOTE_LIMIT, results: RESULT_LIMIT }
	}
}

/// Native `vault://?op=` query. These names are not Obsidian CLI operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum VaultNativeQuery {
	/// Title, tags, outgoing links, and headings of one note.
	Info,
	/// Body of one heading section.
	Section,
	/// Notes that link to one note.
	Backlinks,
	/// Notes carrying a frontmatter or inline tag.
	Tag,
	/// Outgoing links and backlinks of one note.
	Map,
}

/// One ATX heading.
#[derive(Clone, Debug, Eq, PartialEq)]
struct Heading {
	level: u8,
	text:  Str,
	line:  u32,
}

/// Links, tags, and headings parsed from one note.
#[derive(Clone, Debug, Eq, PartialEq)]
struct ParsedNote {
	title:    Str,
	tags:     Vec<Str>,
	links:    Vec<Str>,
	headings: Vec<Heading>,
}

/// A note opened by the walk.
struct ScannedNote {
	path:  Str,
	title: Str,
	tags:  Vec<Str>,
	links: Vec<Str>,
}

/// Notes collected under a vault prefix, plus whether a bound stopped the walk.
struct Scan {
	notes:     Vec<ScannedNote>,
	truncated: bool,
}

/// Reads one native graph query and returns its JSON document.
pub(crate) async fn vault_query(
	service: &VaultService,
	vault: &str,
	path: &str,
	query: VaultNativeQuery,
	heading: Option<&str>,
	tag: Option<&str>,
	limits: GraphLimits,
) -> Result<CowBytes<'static>, VaultError> {
	match query {
		VaultNativeQuery::Info => info(service, vault, path, limits).await,
		VaultNativeQuery::Section => {
			section(service, vault, path, heading.unwrap_or(""), limits).await
		},
		VaultNativeQuery::Backlinks => backlinks(service, vault, path, limits).await,
		VaultNativeQuery::Tag => tags(service, vault, path, tag.unwrap_or(""), limits).await,
		VaultNativeQuery::Map => map(service, vault, path, limits).await,
	}
}

async fn info(
	service: &VaultService,
	vault: &str,
	path: &str,
	limits: GraphLimits,
) -> Result<CowBytes<'static>, VaultError> {
	let text = read_note(service, vault, path, limits.note, "info").await?;
	let note = parse_note(path, &text);
	encode(&InfoJson {
		op: "info",
		path,
		title: note.title.as_str(),
		bytes: text.len(),
		tags: note.tags.iter().map(Str::as_str).collect(),
		links: note.links.iter().map(Str::as_str).collect(),
		headings: note
			.headings
			.iter()
			.map(|heading| HeadingJson {
				level: heading.level,
				text:  heading.text.as_str(),
				line:  heading.line,
			})
			.collect(),
		truncated: false,
	})
}

async fn section(
	service: &VaultService,
	vault: &str,
	path: &str,
	heading: &str,
	limits: GraphLimits,
) -> Result<CowBytes<'static>, VaultError> {
	let text = read_note(service, vault, path, limits.note, "section").await?;
	let note = parse_note(path, &text);
	let Some(found) = note
		.headings
		.iter()
		.find(|item| item.text.as_str() == heading)
	else {
		return Err(VaultError::HeadingMissing {
			path:    Str::new(path),
			heading: Str::new(heading),
		});
	};
	let (start_line, end_line) = section_span(path, &text, found, &note.headings);
	encode(&SectionJson {
		op: "section",
		path,
		heading,
		start_line,
		end_line,
		text: line_slice(&text, start_line, end_line),
	})
}

async fn backlinks(
	service: &VaultService,
	vault: &str,
	path: &str,
	limits: GraphLimits,
) -> Result<CowBytes<'static>, VaultError> {
	require_note(service, vault, path, "backlinks").await?;
	let scan = scan(service, vault, "", limits).await?;
	let (notes, truncated) = matching_notes(&scan, limits.results, |note| {
		note.path.as_str() != path && note.links.iter().any(|link| links_to(link, path))
	});
	encode(&LinkJson { op: "backlinks", path, tag: None, notes, truncated })
}

async fn tags(
	service: &VaultService,
	vault: &str,
	path: &str,
	tag: &str,
	limits: GraphLimits,
) -> Result<CowBytes<'static>, VaultError> {
	let scan = scan(service, vault, path, limits).await?;
	let (notes, truncated) =
		matching_notes(&scan, limits.results, |note| note.tags.iter().any(|item| item == tag));
	encode(&LinkJson { op: "tag", path, tag: Some(tag), notes, truncated })
}

async fn map(
	service: &VaultService,
	vault: &str,
	path: &str,
	limits: GraphLimits,
) -> Result<CowBytes<'static>, VaultError> {
	let text = read_note(service, vault, path, limits.note, "map").await?;
	let note = parse_note(path, &text);
	let scan = scan(service, vault, "", limits).await?;
	let (backlinks, truncated) = matching_notes(&scan, limits.results, |item| {
		item.path.as_str() != path && item.links.iter().any(|link| links_to(link, path))
	});
	encode(&MapJson {
		op: "map",
		path,
		links: note.links.iter().map(Str::as_str).collect(),
		backlinks,
		truncated,
	})
}

async fn require_note(
	service: &VaultService,
	vault: &str,
	path: &str,
	query: &'static str,
) -> Result<(), VaultError> {
	if path.is_empty() {
		return Err(VaultError::GraphPath { query });
	}
	match service.list(vault, path, 1).await {
		Err(VaultError::NotDirectory { .. }) => Ok(()),
		Ok(_) => Err(VaultError::GraphPath { query }),
		Err(error) => Err(error),
	}
}

async fn read_note(
	service: &VaultService,
	vault: &str,
	path: &str,
	limit: usize,
	query: &'static str,
) -> Result<String, VaultError> {
	if path.is_empty() || !path.ends_with(".md") {
		return Err(VaultError::GraphPath { query });
	}
	let bytes = service.read(vault, path, limit).await?;
	std::str::from_utf8(bytes.as_ref())
		.map(str::to_owned)
		.map_err(|_| VaultError::GraphUtf8 { path: Str::new(path) })
}

async fn scan(
	service: &VaultService,
	vault: &str,
	prefix: &str,
	limits: GraphLimits,
) -> Result<Scan, VaultError> {
	if !prefix.is_empty() {
		match service.list(vault, prefix, 1).await {
			Err(VaultError::NotDirectory { .. }) => {
				return scan_file(service, vault, prefix, limits).await;
			},
			Ok(_) => {},
			Err(error) => return Err(error),
		}
	}
	let mut pending = vec![prefix.to_owned()];
	let mut notes = Vec::new();
	let mut truncated = false;
	let mut files = 0usize;
	let mut bytes = 0usize;
	while let Some(directory) = pending.pop() {
		let (entries, directory_truncated) = service.list(vault, &directory, DIRECTORY_LIMIT).await?;
		truncated |= directory_truncated;
		for entry in entries {
			if entry.name.as_str().starts_with('.') {
				continue;
			}
			let relative = join_relative(&directory, entry.name.as_str());
			if entry.directory {
				pending.push(relative);
				continue;
			}
			if !relative.ends_with(".md") {
				continue;
			}
			if files == limits.files || bytes >= limits.bytes {
				return Ok(finish(notes, true));
			}
			match read_note(service, vault, &relative, limits.note, "tag").await {
				Ok(text) => {
					files += 1;
					bytes = bytes.saturating_add(text.len());
					let parsed = parse_note(&relative, &text);
					notes.push(ScannedNote {
						path:  Str::new(relative),
						title: parsed.title,
						tags:  parsed.tags,
						links: parsed.links,
					});
					if bytes > limits.bytes {
						return Ok(finish(notes, true));
					}
				},
				Err(
					VaultError::Limit { .. } | VaultError::Escape { .. } | VaultError::GraphUtf8 { .. },
				) => {
					files += 1;
					truncated = true;
				},
				Err(VaultError::NotFile { .. } | VaultError::SymlinkTarget { .. }) => {
					truncated = true;
				},
				Err(error) => return Err(error),
			}
		}
	}
	Ok(finish(notes, truncated))
}

fn finish(mut notes: Vec<ScannedNote>, truncated: bool) -> Scan {
	notes.sort_unstable_by(|left, right| left.path.cmp(&right.path));
	Scan { notes, truncated }
}

async fn scan_file(
	service: &VaultService,
	vault: &str,
	path: &str,
	limits: GraphLimits,
) -> Result<Scan, VaultError> {
	let text = read_note(service, vault, path, limits.note, "tag").await?;
	let parsed = parse_note(path, &text);
	Ok(Scan {
		notes:     vec![ScannedNote {
			path:  Str::new(path),
			title: parsed.title,
			tags:  parsed.tags,
			links: parsed.links,
		}],
		truncated: false,
	})
}

fn matching_notes<'a>(
	scan: &'a Scan,
	limit: usize,
	mut keep: impl FnMut(&ScannedNote) -> bool,
) -> (Vec<NoteJson<'a>>, bool) {
	let mut notes = Vec::new();
	let mut truncated = scan.truncated;
	for note in &scan.notes {
		if !keep(note) {
			continue;
		}
		if notes.len() == limit {
			truncated = true;
			break;
		}
		notes.push(NoteJson { path: note.path.as_str(), title: note.title.as_str() });
	}
	(notes, truncated)
}

fn join_relative(directory: &str, name: &str) -> String {
	if directory.is_empty() {
		name.to_owned()
	} else {
		let mut joined = String::with_capacity(directory.len() + 1 + name.len());
		joined.push_str(directory);
		joined.push('/');
		joined.push_str(name);
		joined
	}
}

fn parse_note(relative: &str, text: &str) -> ParsedNote {
	let (front_title, mut tags, body_start) = parse_frontmatter(text);
	let body = &text[body_start..];
	let body_line = text[..body_start]
		.bytes()
		.filter(|byte| *byte == b'\n')
		.count() as u32;
	let mut links = Vec::new();
	let mut headings = Vec::new();
	let mut fenced = false;
	for (offset, line) in body.split('\n').enumerate() {
		if is_fence(line) {
			fenced = !fenced;
			continue;
		}
		if fenced {
			continue;
		}
		let line_number = body_line + offset as u32 + 1;
		if let Some((level, heading_text)) = atx_heading(line) {
			scan_markup(heading_text, &mut links, &mut tags);
			headings.push(Heading { level, text: Str::new(heading_text), line: line_number });
		} else {
			scan_markup(line, &mut links, &mut tags);
		}
	}
	let title = front_title.unwrap_or_else(|| {
		headings
			.iter()
			.find(|heading| heading.level == 1)
			.map(|heading| heading.text.clone())
			.unwrap_or_else(|| Str::new(stem(relative)))
	});
	ParsedNote { title, tags, links, headings }
}

fn parse_frontmatter(text: &str) -> (Option<Str>, Vec<Str>, usize) {
	let Some(rest) = text
		.strip_prefix("---\n")
		.or_else(|| text.strip_prefix("---\r\n"))
	else {
		return (None, Vec::new(), 0);
	};
	let line_ending_len = if text.as_bytes().get(3) == Some(&b'\r') {
		5
	} else {
		4
	};
	let Some(close) = rest.find("\n---") else {
		return (None, Vec::new(), 0);
	};
	let block = &rest[..close];
	let mut title = None;
	let mut tags = Vec::new();
	let mut listing = false;
	for line in block.split('\n') {
		let trimmed = line.trim();
		if listing {
			if let Some(item) = trimmed.strip_prefix("- ") {
				push_unique(&mut tags, unquote(item.trim()));
				continue;
			}
			if trimmed.is_empty() {
				listing = false;
				continue;
			}
			listing = false;
		}
		let Some((key, value)) = trimmed.split_once(':') else {
			continue;
		};
		let value = value.trim();
		match key.trim() {
			"title" if title.is_none() && !value.is_empty() => title = Some(Str::new(unquote(value))),
			"tag" | "tags" if value.is_empty() => listing = true,
			"tag" | "tags" => {
				let inner = value.trim_start_matches('[').trim_end_matches(']');
				for part in inner.split(',') {
					let part = unquote(part.trim());
					if !part.is_empty() {
						push_unique(&mut tags, part);
					}
				}
			},
			_ => {},
		}
	}
	let consumed = line_ending_len + close + "\n---".len();
	let after = text[consumed..]
		.strip_prefix("\r\n")
		.or_else(|| text[consumed..].strip_prefix('\n'));
	let body = after
		.map(|rest| text.len() - rest.len())
		.unwrap_or(consumed);
	(title, tags, body)
}

fn atx_heading(line: &str) -> Option<(u8, &str)> {
	let trimmed = line.trim_end();
	let bytes = trimmed.as_bytes();
	let mut index = 0;
	while index < bytes.len() && index < 3 && bytes[index] == b' ' {
		index += 1;
	}
	if index >= bytes.len() || bytes[index] != b'#' {
		return None;
	}
	let mut level = 0u8;
	while index < bytes.len() && bytes[index] == b'#' {
		level = level.saturating_add(1);
		index += 1;
		if level > 6 {
			return None;
		}
	}
	if level == 0 || index >= bytes.len() || bytes[index] != b' ' {
		return None;
	}
	let text = trimmed[index + 1..].trim().trim_end_matches('#').trim();
	(!text.is_empty()).then_some((level, text))
}

fn is_fence(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

fn scan_markup(line: &str, links: &mut Vec<Str>, tags: &mut Vec<Str>) {
	let bytes = line.as_bytes();
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'`' {
			if let Some(end) = bytes[index + 1..].iter().position(|byte| *byte == b'`') {
				index = index + 1 + end + 1;
				continue;
			}
		}
		if bytes[index] == b'[' && bytes.get(index + 1) == Some(&b'[') {
			if let Some(end) = find_pair(bytes, index + 2) {
				if let Some(target) = wiki_target(&line[index + 2..end]) {
					push_unique(links, target);
				}
				index = end + 2;
				continue;
			}
		}
		if bytes[index] == b']' && bytes.get(index + 1) == Some(&b'(') {
			if let Some(end) = bytes[index + 2..].iter().position(|byte| *byte == b')') {
				let close = index + 2 + end;
				if let Some(target) = markdown_target(&line[index + 2..close]) {
					push_unique(links, target);
				}
				index = close + 1;
				continue;
			}
		}
		if bytes[index] == b'#' && tag_boundary(bytes, index) {
			if let Some((tag, next)) = read_tag(line, index + 1) {
				push_unique(tags, tag);
				index = next;
				continue;
			}
		}
		index += 1;
	}
}

fn find_pair(bytes: &[u8], start: usize) -> Option<usize> {
	let mut index = start;
	while index + 1 < bytes.len() {
		if bytes[index] == b']' && bytes[index + 1] == b']' {
			return Some(index);
		}
		index += 1;
	}
	None
}

fn wiki_target(inner: &str) -> Option<&str> {
	let target = inner.split('|').next()?.split('#').next()?.trim();
	(!target.is_empty()).then_some(target)
}

fn markdown_target(inner: &str) -> Option<&str> {
	let target = inner.split_whitespace().next()?.split('#').next()?.trim();
	if target.is_empty() || target.contains("://") || target.starts_with('/') {
		return None;
	}
	target.ends_with(".md").then_some(target)
}

fn tag_boundary(bytes: &[u8], index: usize) -> bool {
	index == 0 || bytes[index - 1].is_ascii_whitespace()
}

fn read_tag(line: &str, start: usize) -> Option<(&str, usize)> {
	let bytes = line.as_bytes();
	if start >= bytes.len() || !bytes[start].is_ascii_alphabetic() {
		return None;
	}
	let mut end = start + 1;
	while end < bytes.len() {
		let byte = bytes[end];
		if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'/') {
			end += 1;
		} else {
			break;
		}
	}
	let mut stop = end;
	while stop > start && bytes[stop - 1] == b'/' {
		stop -= 1;
	}
	(stop > start).then_some((&line[start..stop], end))
}

fn push_unique(values: &mut Vec<Str>, text: &str) {
	if text.is_empty() || values.iter().any(|value| value.as_str() == text) {
		return;
	}
	values.push(Str::new(text));
}

fn unquote(value: &str) -> &str {
	let bytes = value.as_bytes();
	if bytes.len() >= 2
		&& ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
			|| (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
	{
		&value[1..value.len() - 1]
	} else {
		value
	}
}

fn stem(relative: &str) -> &str {
	let name = relative.rsplit('/').next().unwrap_or(relative);
	name.strip_suffix(".md").unwrap_or(name)
}

fn links_to(target: &str, relative: &str) -> bool {
	let target = normalize_target(target);
	let without = relative.strip_suffix(".md").unwrap_or(relative);
	if target == without {
		return true;
	}
	if target.contains('/') {
		return false;
	}
	target == without.rsplit('/').next().unwrap_or(without)
}

fn normalize_target(target: &str) -> &str {
	let target = target.trim().strip_prefix("./").unwrap_or(target.trim());
	target.strip_suffix(".md").unwrap_or(target)
}

fn section_span(relative: &str, text: &str, heading: &Heading, headings: &[Heading]) -> (u32, u32) {
	let parsed = block_range_at(BlockRangeOptions {
		code: text.to_owned(),
		lang: None,
		path: Some(relative.to_owned()),
		line: heading.line,
	});
	if let Ok(Some(range)) = parsed {
		if range.start_line == heading.line && range.end_line >= heading.line {
			return (range.start_line, range.end_line);
		}
	}
	let end = headings
		.iter()
		.skip_while(|item| item.line <= heading.line)
		.find(|item| item.level <= heading.level)
		.map(|item| item.line.saturating_sub(1).max(heading.line))
		.unwrap_or_else(|| line_count(text));
	(heading.line, end)
}

fn line_count(text: &str) -> u32 {
	if text.is_empty() {
		return 0;
	}
	let breaks = text.bytes().filter(|byte| *byte == b'\n').count() as u32;
	if text.ends_with('\n') {
		breaks
	} else {
		breaks + 1
	}
}

fn line_slice(text: &str, start: u32, end: u32) -> String {
	let mut out = String::new();
	for (index, line) in text.split('\n').enumerate() {
		let number = index as u32 + 1;
		if number < start {
			continue;
		}
		if number > end {
			break;
		}
		if !out.is_empty() {
			out.push('\n');
		}
		out.push_str(line);
	}
	out
}

fn encode(value: &impl Serialize) -> Result<CowBytes<'static>, VaultError> {
	serde_json::to_vec(value)
		.map(CowBytes::from)
		.map_err(|source| VaultError::GraphEncode { source })
}

#[derive(Serialize)]
struct InfoJson<'a> {
	op:        &'static str,
	path:      &'a str,
	title:     &'a str,
	bytes:     usize,
	tags:      Vec<&'a str>,
	links:     Vec<&'a str>,
	headings:  Vec<HeadingJson<'a>>,
	truncated: bool,
}

#[derive(Serialize)]
struct HeadingJson<'a> {
	level: u8,
	text:  &'a str,
	line:  u32,
}

#[derive(Serialize)]
struct SectionJson<'a> {
	op:         &'static str,
	path:       &'a str,
	heading:    &'a str,
	start_line: u32,
	end_line:   u32,
	text:       String,
}

#[derive(Serialize)]
struct NoteJson<'a> {
	path:  &'a str,
	title: &'a str,
}

#[derive(Serialize)]
struct LinkJson<'a> {
	op:        &'static str,
	path:      &'a str,
	tag:       Option<&'a str>,
	notes:     Vec<NoteJson<'a>>,
	truncated: bool,
}

#[derive(Serialize)]
struct MapJson<'a> {
	op:        &'static str,
	path:      &'a str,
	links:     Vec<&'a str>,
	backlinks: Vec<NoteJson<'a>>,
	truncated: bool,
}

#[cfg(test)]
mod tests {
	use std::fs;

	use omp_ext::workspace_trust::WorkspaceTrust;
	use serde_json::Value;

	use super::*;
	use crate::vault::VaultPaths;

	const NOTE: &str = "\
---
title: Alpha
tags: [omp, vault]
---
# Alpha

See [[Beta|the other]] and [gamma](folder/gamma.md).

## Setup

Do the work. #ship

```
#notag [[Hidden]]
```

## Later

After.
";

	#[test]
	fn parser_reads_frontmatter_links_tags_and_headings() {
		let note = parse_note("folder/alpha.md", NOTE);
		assert_eq!(note.title.as_str(), "Alpha");
		assert_eq!(note.tags.iter().map(Str::as_str).collect::<Vec<_>>(), ["omp", "vault", "ship"]);
		assert_eq!(note.links.iter().map(Str::as_str).collect::<Vec<_>>(), [
			"Beta",
			"folder/gamma.md"
		]);
		assert_eq!(note.headings.len(), 3);
		assert!(links_to("Beta", "notes/Beta.md"));
		assert!(links_to("folder/gamma.md", "folder/gamma.md"));
		assert!(!links_to("Beta", "notes/Gamma.md"));
	}

	#[test]
	fn section_span_stops_before_the_next_same_level_heading() {
		let note = parse_note("alpha.md", NOTE);
		let setup = note
			.headings
			.iter()
			.find(|heading| heading.text.as_str() == "Setup")
			.unwrap();
		let (start, end) = section_span("alpha.md", NOTE, setup, &note.headings);
		let text = line_slice(NOTE, start, end);
		assert!(text.contains("Do the work."));
		assert!(!text.contains("## Later"));
	}

	fn service(root_files: &[(&str, &str)]) -> (tempfile::TempDir, VaultService) {
		let temp = tempfile::tempdir().expect("tempdir");
		let root = temp.path().join("notes");
		fs::create_dir_all(&root).expect("vault root");
		for (relative, body) in root_files {
			let path = root.join(relative);
			if let Some(parent) = path.parent() {
				fs::create_dir_all(parent).expect("parent");
			}
			fs::write(path, body).expect("note");
		}
		fs::write(
			temp.path().join("vaults.toml"),
			format!("[vaults]\nNotes = {:?}\n", root.display().to_string()),
		)
		.expect("vault config");
		let service = VaultService::load_layered(
			&VaultPaths {
				user:    temp.path().join("vaults.toml"),
				project: temp.path().join("missing"),
				root:    temp.path().to_path_buf(),
			},
			WorkspaceTrust::Untrusted,
		)
		.expect("vault service");
		(temp, service)
	}

	fn limits(files: usize) -> GraphLimits {
		GraphLimits { files, bytes: BYTE_LIMIT, note: NOTE_LIMIT, results: 2 }
	}

	#[tokio::test]
	async fn queries_return_compact_json_without_the_whole_note() {
		let (_temp, service) = service(&[
			(
				"alpha.md",
				"# Alpha\n\nSee [[beta]] and #omp.\n\n## Setup\n\nOnly this.\n\n## Other\n\nNo.\n",
			),
			("beta.md", "# Beta\n\nBack to [[alpha]].\n"),
			("folder/gamma.md", "---\ntags:\n  - omp\n---\n# Gamma\n"),
		]);
		let info =
			vault_query(&service, "Notes", "alpha.md", VaultNativeQuery::Info, None, None, limits(8))
				.await
				.expect("info");
		let info: Value = serde_json::from_slice(info.as_ref()).expect("info json");
		assert_eq!(info["title"], "Alpha");
		assert_eq!(info["tags"][0], "omp");
		assert_eq!(info["links"][0], "beta");
		assert!(info["text"].is_null());

		let section = vault_query(
			&service,
			"Notes",
			"alpha.md",
			VaultNativeQuery::Section,
			Some("Setup"),
			None,
			limits(8),
		)
		.await
		.expect("section");
		let section: Value = serde_json::from_slice(section.as_ref()).expect("section json");
		assert!(section["text"].as_str().unwrap().contains("Only this."));
		assert!(!section["text"].as_str().unwrap().contains("## Other"));

		let backlinks = vault_query(
			&service,
			"Notes",
			"alpha.md",
			VaultNativeQuery::Backlinks,
			None,
			None,
			limits(8),
		)
		.await
		.expect("backlinks");
		let backlinks: Value = serde_json::from_slice(backlinks.as_ref()).expect("backlinks json");
		assert_eq!(backlinks["notes"][0]["path"], "beta.md");

		let tagged =
			vault_query(&service, "Notes", "", VaultNativeQuery::Tag, None, Some("omp"), limits(8))
				.await
				.expect("tag");
		let tagged: Value = serde_json::from_slice(tagged.as_ref()).expect("tag json");
		let paths: Vec<_> = tagged["notes"]
			.as_array()
			.unwrap()
			.iter()
			.map(|note| note["path"].as_str().unwrap())
			.collect();
		assert_eq!(paths, ["alpha.md", "folder/gamma.md"]);

		let map =
			vault_query(&service, "Notes", "alpha.md", VaultNativeQuery::Map, None, None, limits(8))
				.await
				.expect("map");
		let map: Value = serde_json::from_slice(map.as_ref()).expect("map json");
		assert_eq!(map["links"][0], "beta");
		assert_eq!(map["backlinks"][0]["path"], "beta.md");
	}

	#[tokio::test]
	async fn file_bound_marks_the_result_truncated() {
		let (_temp, service) = service(&[("a.md", "[[b]]\n"), ("b.md", "[[a]]\n")]);
		let backlinks =
			vault_query(&service, "Notes", "b.md", VaultNativeQuery::Backlinks, None, None, limits(1))
				.await
				.expect("bounded backlinks");
		let backlinks: Value = serde_json::from_slice(backlinks.as_ref()).expect("json");
		assert_eq!(backlinks["truncated"], true);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn escaping_symlink_is_not_parsed() {
		let (temp, service) = service(&[("inside.md", "# Inside\n\n[[secret]]\n")]);
		let outside = temp.path().join("outside.md");
		fs::write(&outside, "# Secret\n\n#classified\n").expect("outside");
		std::os::unix::fs::symlink(&outside, temp.path().join("notes").join("secret.md"))
			.expect("symlink");
		let tagged = vault_query(
			&service,
			"Notes",
			"",
			VaultNativeQuery::Tag,
			None,
			Some("classified"),
			limits(8),
		)
		.await
		.expect("tag");
		let tagged: Value = serde_json::from_slice(tagged.as_ref()).expect("json");
		assert!(tagged["notes"].as_array().unwrap().is_empty());
		assert_eq!(tagged["truncated"], true);
	}
}
