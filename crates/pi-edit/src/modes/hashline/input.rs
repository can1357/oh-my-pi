//! Top-level parser for hashline file sections.

use std::{
	cell::OnceCell,
	collections::HashMap,
	path::{Path, PathBuf},
	sync::LazyLock,
};

use regex::Regex;

use super::{
	clipboard::has_clipboard_edit,
	format::{HL_FILE_HASH_EXAMPLES, HL_FILE_HASH_LENGTH},
	messages::{
		ABORT_MARKER, BEGIN_PATCH_MARKER, CLIPBOARD_INTERLEAVED_SECTIONS, END_PATCH_MARKER,
		json_quote,
	},
	parser::parse_patch,
	tokenizer::{Token, Tokenizer, header_path_has_orphan_bracket},
	types::{Cursor, Edit, FileOp, PasteTarget},
};
use crate::error::EditError;

/// Envelope and abort sentinels recognized when nested inside a header row.
const ENVELOPE_MARKERS: [&str; 3] = [BEGIN_PATCH_MARKER, END_PATCH_MARKER, ABORT_MARKER];

static APPLY_PATCH_PATH_NOISE_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
	r"(?i)^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*",
).expect("valid regex")
});
static RECOVERY_TAG_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"#([0-9A-Fa-f]{4})\s*$").expect("valid regex"));
static UNIFIED_HUNK_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@").expect("valid regex"));

/// Parsed edits, optional file operation, and parser warnings for one section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
	pub edits:    Vec<Edit>,
	pub file_op:  Option<FileOp>,
	pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct RawSection {
	path:        String,
	file_hash:   Option<String>,
	diff:        String,
	interleaved: bool,
}

/// One target file section with a lazily memoized parsed body.
#[derive(Debug)]
pub struct PatchSection {
	pub path:      String,
	pub file_hash: Option<String>,
	pub diff:      String,
	parsed:        OnceCell<Result<Parsed, String>>,
	interleaved:   bool,
}
impl PatchSection {
	/// Construct a section from its authored path, optional tag, and body.
	pub const fn new(path: String, file_hash: Option<String>, diff: String) -> Self {
		Self { path, file_hash, diff, parsed: OnceCell::new(), interleaved: false }
	}

	fn from_raw(raw: RawSection) -> Self {
		Self {
			path:        raw.path,
			file_hash:   raw.file_hash,
			diff:        raw.diff,
			parsed:      OnceCell::new(),
			interleaved: raw.interleaved,
		}
	}

	/// Parse and memoize this section's body.
	pub fn parse(&self) -> Result<&Parsed, EditError> {
		let result = self.parsed.get_or_init(|| {
			let mut parsed = parse_patch(&self.diff).map_err(|error| error.to_string())?;
			if self.interleaved && has_clipboard_edit(&parsed.edits) {
				return Err(CLIPBOARD_INTERLEAVED_SECTIONS.to_string());
			}
			if let Some(FileOp::Move { dest }) = &mut parsed.file_op {
				*dest = normalize_hashline_path(dest, None);
			}
			Ok(parsed)
		});
		match result {
			Ok(parsed) => Ok(parsed),
			Err(message) => Err(EditError::parse(message.clone())),
		}
	}

	/// Return the parsed low-level edits.
	pub fn edits(&self) -> Result<&[Edit], EditError> {
		Ok(&self.parse()?.edits)
	}

	/// Return the optional whole-file operation.
	pub fn file_op(&self) -> Result<Option<&FileOp>, EditError> {
		Ok(self.parse()?.file_op.as_ref())
	}

	/// Return parser recovery warnings.
	pub fn warnings(&self) -> Result<&[String], EditError> {
		Ok(&self.parse()?.warnings)
	}

	/// Whether any edit targets concrete source content.
	pub fn has_anchor_scoped_edit(&self) -> Result<bool, EditError> {
		Ok(self.edits()?.iter().any(|edit| match edit {
			Edit::Delete { .. } | Edit::Cut { .. } | Edit::Block { .. } => true,
			Edit::Paste { at: PasteTarget::Span { .. }, .. } => true,
			Edit::Paste { at: PasteTarget::Gap { cursor }, .. } | Edit::Insert { cursor, .. } => {
				matches!(cursor, Cursor::BeforeAnchor(_) | Cursor::AfterAnchor(_))
			},
		}))
	}

	/// Collect concrete anchor lines in ascending order without duplicates.
	pub fn collect_anchor_lines(&self) -> Result<Vec<u32>, EditError> {
		let mut lines = Vec::new();
		for edit in self.edits()? {
			match edit {
				Edit::Delete { anchor, .. } | Edit::Block { anchor, .. } => lines.push(anchor.line),
				Edit::Cut { range, .. } | Edit::Paste { at: PasteTarget::Span { range }, .. } => {
					lines.extend(range.start.line..=range.end.line);
				},
				Edit::Paste { at: PasteTarget::Gap { cursor }, .. } | Edit::Insert { cursor, .. } => {
					if let Cursor::BeforeAnchor(anchor) | Cursor::AfterAnchor(anchor) = cursor {
						lines.push(anchor.line);
					}
				},
			}
		}
		lines.sort_unstable();
		lines.dedup();
		Ok(lines)
	}

	#[must_use]
	/// Rebind this section to another path while preserving its cached parse.
	pub fn with_path(&self, path: &str) -> Self {
		let next = Self {
			path:        path.to_string(),
			file_hash:   self.file_hash.clone(),
			diff:        self.diff.clone(),
			parsed:      OnceCell::new(),
			interleaved: self.interleaved,
		};
		if let Some(parsed) = self.parsed.get() {
			let _ = next.parsed.set(parsed.clone());
		}
		next
	}
}

/// A parsed multi-file hashline patch.
#[derive(Debug)]
pub struct Patch {
	pub sections: Vec<PatchSection>,
}
/// Optional context for section splitting and headerless streaming recovery.
#[derive(Default)]
pub struct SplitOptions<'a> {
	/// Working directory used to shorten absolute header paths.
	pub cwd:  Option<&'a Path>,
	/// Target path used when a streaming body has no header yet.
	pub path: Option<&'a str>,
}
impl Patch {
	/// Split and coalesce authored file sections.
	pub fn parse(input: &str, options: &SplitOptions<'_>) -> Result<Self, EditError> {
		let raw = merge_same_path_sections(split_raw_sections(input, options)?)?;
		Ok(Self { sections: raw.into_iter().map(PatchSection::from_raw).collect() })
	}

	/// Parse exactly the first section, rejecting an empty patch.
	pub fn parse_single(input: &str, options: &SplitOptions<'_>) -> Result<PatchSection, EditError> {
		Self::parse(input, options)?
			.sections
			.into_iter()
			.next()
			.ok_or_else(|| EditError::parse("Patch input did not produce any sections."))
	}
}

/// Whether any input row is a recognizable hashline operation header.
pub fn contains_recognizable_hashline_operations(input: &str) -> bool {
	let tokenizer = Tokenizer::new();
	input
		.lines()
		.any(|line| tokenizer.is_op(line.trim_end_matches('\r')))
}

fn unquote(path: &str) -> &str {
	if path.len() >= 2
		&& ((path.starts_with('"') && path.ends_with('"'))
			|| (path.starts_with('\'') && path.ends_with('\'')))
	{
		&path[1..path.len() - 1]
	} else {
		path
	}
}
fn normalize_hashline_path(raw: &str, cwd: Option<&Path>) -> String {
	let cleaned = APPLY_PATCH_PATH_NOISE_RE
		.replace(unquote(raw.trim()), "")
		.into_owned();
	let path = Path::new(&cleaned);
	let Some(cwd) = cwd else {
		return cleaned;
	};
	if !path.is_absolute() {
		return cleaned;
	}
	let path = lexical_normalize(path);
	let cwd = lexical_normalize(cwd);
	if let Ok(relative) = path.strip_prefix(&cwd) {
		let text = relative
			.to_string_lossy()
			.replace(std::path::MAIN_SEPARATOR, "/");
		return if text.is_empty() { ".".into() } else { text };
	}
	cleaned
}

fn lexical_normalize(path: &Path) -> PathBuf {
	use std::path::Component;
	let mut normalized = PathBuf::new();
	for component in path.components() {
		match component {
			Component::CurDir => {},
			Component::ParentDir => {
				normalized.pop();
			},
			other => normalized.push(other.as_os_str()),
		}
	}
	normalized
}

fn parse_header_line(line: &str, cwd: Option<&Path>) -> Result<Option<RawSection>, EditError> {
	let trimmed = unbracket_envelope_markers(line.trim_end());
	if !trimmed.starts_with('[') {
		return Ok(None);
	}
	let tokenizer = Tokenizer::new();
	if let Token::Header { path, file_hash, .. } = tokenizer.tokenize(trimmed, 0) {
		let path = normalize_hashline_path(&path, cwd);
		if path.is_empty() {
			return Err(EditError::parse("Input header \"[]\" is empty; provide a file path."));
		}
		return Ok(Some(RawSection { path, file_hash, diff: String::new(), interleaved: false }));
	}
	if let Some(recovered) = recover_header(trimmed, cwd) {
		return Ok(Some(recovered));
	}
	Err(EditError::parse(format!(
		"Input header must be [PATH] or [PATH#TAG] with a {HL_FILE_HASH_LENGTH}-hex content-hash \
		 tag; got {}.",
		json_quote(trimmed)
	)))
}

fn recover_header(line: &str, cwd: Option<&Path>) -> Option<RawSection> {
	let body = line.strip_prefix('[')?.strip_suffix(']')?.trim();
	let body = APPLY_PATCH_PATH_NOISE_RE.replace(body, "").into_owned();
	if body.is_empty() {
		return None;
	}
	let (path_text, file_hash) = if let Some(captures) = RECOVERY_TAG_RE.captures(&body) {
		let whole = captures.get(0)?;
		(&body[..whole.start()], Some(captures[1].to_ascii_uppercase()))
	} else {
		(body.trim_end(), None)
	};
	if path_text.contains('#') || header_path_has_orphan_bracket(path_text) {
		return None;
	}
	let path = normalize_hashline_path(path_text, cwd);
	(!path.is_empty()).then_some(RawSection {
		path,
		file_hash,
		diff: String::new(),
		interleaved: false,
	})
}

/// Unwrap leading bracketed `apply_patch` envelope markers from a row.
///
/// Models that mix `apply_patch` framing into hashline nest the sentinel in the
/// section header (`[*** Begin Patch] [src/a.ts#1A2B]`, or unclosed as
/// `[*** Begin Patch [src/a.ts#1A2B]`) or put it alone on a bracketed row
/// (`[*** End Patch]`). Bare sentinel rows are already consumed by the
/// tokenizer, so unwrapping the bracketed shape routes it down the same path —
/// otherwise the whole row parses as one header and the edit targets a file
/// called `Begin Patch] [src/a.ts`. A row carrying no such group comes back
/// unchanged; a row that is nothing but one comes back as the bare marker for
/// the tokenizer to classify.
fn unbracket_envelope_markers(line: &str) -> &str {
	let mut rest = line;
	loop {
		let Some(inner) = rest.strip_prefix('[').map(str::trim_start) else {
			return rest;
		};
		let Some(marker) = ENVELOPE_MARKERS
			.iter()
			.find(|marker| inner.starts_with(**marker))
		else {
			return rest;
		};
		let tail = inner[marker.len()..].trim_start();
		let tail = tail.strip_prefix(']').unwrap_or(tail).trim_start();
		if tail.is_empty() {
			return marker;
		}
		rest = tail;
	}
}

fn strip_leading_blanks(input: &str) -> String {
	let input = input.strip_prefix('\u{feff}').unwrap_or(input);
	let tokenizer = Tokenizer::new();
	let mut lines: Vec<&str> = input.split('\n').collect();
	while lines.first().is_some_and(|line| {
		let clean = unbracket_envelope_markers(line.trim_end_matches('\r'));
		clean.trim().is_empty() || matches!(tokenizer.tokenize(clean, 0), Token::EnvelopeBegin { .. })
	}) {
		lines.remove(0);
	}
	lines.join("\n")
}

fn split_raw_sections(
	input: &str,
	options: &SplitOptions<'_>,
) -> Result<Vec<RawSection>, EditError> {
	let input = normalize_fallback(input, options)?;
	let stripped = strip_leading_blanks(&input);
	let lines: Vec<&str> = stripped
		.split('\n')
		.map(|line| line.strip_suffix('\r').unwrap_or(line))
		.collect();
	let first = lines.first().copied().unwrap_or("");
	if parse_header_line(first, options.cwd)?.is_none() {
		if is_unified_header(first.trim_end()) {
			return Err(EditError::parse(
				"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. File sections \
				 start with `[path#HASH]`; use `replace`, `delete`, or `insert` ops.",
			));
		}
		let preview: String = first.chars().take(120).collect();
		return Err(EditError::parse(format!(
			"input must begin with \"[PATH#HASH]\" on the first non-blank line for anchored edits; \
			 got: {}. Example: \"[src/foo.ts#{}]\" then edit ops.",
			json_quote(&preview),
			HL_FILE_HASH_EXAMPLES[0]
		)));
	}
	let tokenizer = Tokenizer::new();
	let mut sections = Vec::new();
	let mut current: Option<RawSection> = None;
	let mut body = Vec::new();
	for line in lines {
		let clean = unbracket_envelope_markers(line.trim_end());
		match tokenizer.tokenize(clean, 0) {
			Token::EnvelopeEnd { .. } | Token::Abort { .. } => break,
			Token::EnvelopeBegin { .. } => continue,
			_ => {},
		}
		if clean.starts_with('[')
			&& let Some(header) = parse_header_line(clean, options.cwd)?
		{
			flush_section(&mut sections, &mut current, &mut body);
			current = Some(header);
			continue;
		}
		body.push(line.to_string());
	}
	flush_section(&mut sections, &mut current, &mut body);
	Ok(sections)
}
fn normalize_fallback(input: &str, options: &SplitOptions<'_>) -> Result<String, EditError> {
	let stripped = input.strip_prefix('\u{feff}').unwrap_or(input);
	for line in stripped.lines() {
		if parse_header_line(line, options.cwd)?.is_some() {
			return Ok(input.to_string());
		}
	}
	let Some(path) = options.path else {
		return Ok(input.to_string());
	};
	if !contains_recognizable_hashline_operations(input) {
		return Ok(input.to_string());
	}
	let path = normalize_hashline_path(path, options.cwd);
	if path.is_empty() {
		return Ok(input.to_string());
	}
	Ok(format!("[{path}]\n{input}"))
}
fn flush_section(
	sections: &mut Vec<RawSection>,
	current: &mut Option<RawSection>,
	body: &mut Vec<String>,
) {
	let Some(mut section) = current.take() else {
		body.clear();
		return;
	};
	if body.iter().any(|line| !line.trim().is_empty()) {
		section.diff = body.join("\n");
		sections.push(section);
	}
	body.clear();
}
fn merge_same_path_sections(sections: Vec<RawSection>) -> Result<Vec<RawSection>, EditError> {
	let mut result: Vec<RawSection> = Vec::new();
	let mut positions = HashMap::<String, usize>::new();
	let mut previous: Option<String> = None;
	for section in sections {
		if let Some(&index) = positions.get(&section.path) {
			let existing = &mut result[index];
			if let (Some(first), Some(second)) = (&existing.file_hash, &section.file_hash)
				&& first != second
			{
				return Err(EditError::parse(format!(
					"Conflicting hashline snapshot tags for {}: #{first} and #{second}. Re-read the \
					 file and retry with one current header.",
					section.path
				)));
			}
			if existing.file_hash.is_none() {
				existing.file_hash = section.file_hash;
			}
			if previous.as_deref() != Some(&section.path) {
				existing.interleaved = true;
			}
			existing.diff.push('\n');
			existing.diff.push_str(&section.diff);
			previous = Some(section.path);
			continue;
		}
		positions.insert(section.path.clone(), result.len());
		previous = Some(section.path.clone());
		result.push(section);
	}
	Ok(result)
}
fn is_unified_header(line: &str) -> bool {
	UNIFIED_HUNK_RE.is_match(line)
}
