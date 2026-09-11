//! Sloppy payload parsing: XML tag surface → internal op stream →
//! [`super::types::Operation`]s, including every parse-time recovery.
//! Port of `packages/coding-agent/src/edit/sloppy.ts` lines 1–1650.

use std::{
	collections::{HashMap, HashSet},
	sync::LazyLock,
};

use regex::Regex;

use super::{
	apply::{
		closest_desired_block, diff_shaped_candidates, is_diff_shaped, locate, normalize_text,
		parse_pattern,
	},
	types::{InlineSloppyRegion, Operation, OperationRewrite, SloppySection, markers},
};
use crate::error::EditError;

const OPENER: &str = markers::OPEN;
const REWRITE_HEADER: &str = markers::PUT;
const SELECT_OPEN: &str = markers::SELECT_OPEN;
const SELECT_CLOSE: &str = markers::SELECT_CLOSE;
const SELECT_DIVIDER: &str = markers::SELECT_DIVIDER;
const GAP: &str = markers::GAP;
const ADD_LINE: &str = markers::ADD;
const REMOVE_LINE: &str = markers::REMOVE;

const LITERAL_OPEN: &str = "\0V8LITOPEN\0";
const LITERAL_CLOSE: &str = "\0V8LITCLOSE\0";
const LITERAL_DIVIDER: &str = "\0V8LITDIV\0";

macro_rules! regex {
	($name:ident, $pattern:literal) => {
		static $name: LazyLock<Regex> = LazyLock::new(|| {
			Regex::new($pattern).expect(concat!("valid ", stringify!($name), " regex"))
		});
	};
}

regex!(EDIT_OPEN_RE, r"(?iu)^<SM:EDIT\b([^>\n]*?)/?>$");
regex!(
	PATH_ATTRIBUTE_RE,
	r#"(?iu)(?:path|file)\s*=\s*(?:\"([^\"\n]*)\"|'([^'\n]*)'|([^\s\"'>]+))"#
);
regex!(ALL_ATTRIBUTE_RE, r#"(?iu)\ball\b(?:\s*=\s*(?:\"([^\"\n]*)\"|'([^'\n]*)'|([^\s\"'>]+)))?"#);
regex!(INLINE_TAG_RE, r"(?iu)^<(SM:FIND|SM:PUT)>(.*)</(SM:FIND|SM:PUT)>$");
regex!(BLOCK_TAG_RE, r"(?iu)^<(/?)(SM:FIND|SM:PUT)\s*(/?)>$");
regex!(ENVELOPE_WORDS_RE, r"(?iu)^\s*(?:Begin|End)(?:\s+of)?\s+(?:patch|edits?|file)\b");
regex!(
	ENVELOPE_LINE_RE,
	r"(?iu)^\*{3}\s*(?:(?:Begin|End)(?:\s+of)?\s+(?:patch|edits?|file)|Abort|Update File:|Add File:|Delete File:)"
);
regex!(ENVELOPE_END_RE, r"(?iu)^\*{3}\s*End\b");
regex!(FENCE_LINE_RE, r"^\s*(?:```|~~~)");
regex!(ORDINAL_OPENER_RE, r"^«[1-9]\d*$");
regex!(OUTER_FENCE_RE, r"(?iu)^```(?:text|xml|html|typescript|ts|tsx|javascript|js)?\s*$");
regex!(GLUED_CONTROL_RE, r"^[ \t]*(«\*?|»)([ \t]+\S.*)$");
regex!(SHOWING_LINES_RE, r"(?iu)^\[(?:Showing lines\b|(?:…|\.\.\.)\d+ln elided\b).*\]$");
regex!(ELIDED_LINE_RE, r"^\d+(?:-\d+)?:\s*(?:…|\.\.\.)\s*$");
regex!(NUMBERED_LINE_RE, r"^\s*\d+\s*[:|]");
regex!(NUMBERED_LITERAL_RE, r#"^\s*\d+\s*[:|]\s*(?:\d|[\"'`])"#);
regex!(SELECTION_ONLY_RE, r"^\x{27EA}([^\x{27EA}\x{27EB}]*)\x{27EB}$");
regex!(REFERENCE_RE, r"^»([1-9]\d*)$");
regex!(BARE_DESIRED_RE, r"\x{27EA}[^\x{27EA}\x{27EB}\x{2502}\n…]+\x{27EB}");
regex!(BARE_DESIRED_CAPTURE_RE, r"\x{27EA}([^\x{27EA}\x{27EB}\x{2502}\n…]+)\x{27EB}");
regex!(UNICODE_TOKEN_RE, r"[\p{L}\p{N}_$]+");
regex!(
	STRAY_DIVIDER_RE,
	r"\x{27EA}([^\x{27EA}\x{27EB}\x{2502}\n]*)\x{27EB}([^\x{27EA}\x{27EB}\x{2502}\n]*)\x{27EB}"
);
regex!(
	DIRECTIVE_RE,
	r"^\x{27EA}([^\x{27EA}\x{27EB}\x{2502}]+)\x{2502}([^\x{27EA}\x{27EB}\x{2502}]*)\x{27EB}$"
);
regex!(EMPTY_SELECTION_TAIL_RE, r"(?:^|\n)[ \t]*\x{27EA}\x{27EB}[ \t]*$");

#[derive(Debug)]
enum TagLine {
	Open { path: Option<String>, all: bool },
	CloseEdit,
	Find { inline: Option<String> },
	CloseFind,
	Put { inline: Option<String> },
	ClosePut,
}

#[derive(Debug)]
struct CompiledSection {
	path: String,
	ir:   Vec<String>,
}

fn parse_error(message: impl Into<String>) -> EditError {
	EditError::parse(message)
}

fn js_len(text: &str) -> usize {
	text.encode_utf16().count()
}

fn parse_tag_line(line: &str) -> Option<TagLine> {
	let trimmed = line.trim();
	if !trimmed.starts_with('<') {
		return None;
	}
	if trimmed.eq_ignore_ascii_case("</SM:EDIT>") {
		return Some(TagLine::CloseEdit);
	}

	if let Some(captures) = EDIT_OPEN_RE.captures(trimmed) {
		let attrs = captures.get(1).map_or("", |capture| capture.as_str());
		let path = PATH_ATTRIBUTE_RE.captures(attrs).and_then(|values| {
			(1..=3)
				.find_map(|index| {
					values
						.get(index)
						.map(|value| value.as_str().trim().to_owned())
				})
				.filter(|value| !value.is_empty())
		});
		let all = ALL_ATTRIBUTE_RE.captures(attrs).is_some_and(|values| {
			let value = (1..=3).find_map(|index| values.get(index).map(|item| item.as_str()));
			!value.is_some_and(|item| item.eq_ignore_ascii_case("false") || item == "0")
		});
		return Some(TagLine::Open { path, all });
	}

	if let Some(captures) = INLINE_TAG_RE.captures(trimmed) {
		let open = captures.get(1)?.as_str();
		let close = captures.get(3)?.as_str();
		if open.eq_ignore_ascii_case(close) {
			let inline = captures
				.get(2)
				.map_or(String::new(), |value| value.as_str().to_owned());
			return Some(if open.eq_ignore_ascii_case("SM:FIND") {
				TagLine::Find { inline: Some(inline) }
			} else {
				TagLine::Put { inline: Some(inline) }
			});
		}
	}

	let captures = BLOCK_TAG_RE.captures(trimmed)?;
	let find = captures.get(2)?.as_str().eq_ignore_ascii_case("SM:FIND");
	if captures.get(1).is_some_and(|value| value.as_str() == "/") {
		return Some(if find {
			TagLine::CloseFind
		} else {
			TagLine::ClosePut
		});
	}
	let inline = captures
		.get(3)
		.is_some_and(|value| value.as_str() == "/")
		.then(String::new);
	Some(if find {
		TagLine::Find { inline }
	} else {
		TagLine::Put { inline }
	})
}

fn envelope_words(line: &str) -> bool {
	ENVELOPE_WORDS_RE.is_match(line)
}

fn envelope_line(line: &str) -> bool {
	ENVELOPE_LINE_RE.is_match(line)
}

/// Remove foreign patch envelopes and the noise following end sentinels.
pub fn strip_envelope_noise(lines: Vec<&str>) -> Vec<String> {
	let mut result = Vec::new();
	let mut skipping = false;
	let mut index = 0;
	while index < lines.len() {
		let mut line = lines[index].to_owned();
		if line.trim() == "***" && index + 1 < lines.len() && envelope_words(lines[index + 1]) {
			line = format!("*** {}", lines[index + 1].trim());
			index += 1;
		}
		if envelope_line(line.trim()) {
			skipping = ENVELOPE_END_RE.is_match(line.trim());
			index += 1;
			continue;
		}
		if skipping {
			if matches!(parse_tag_line(&line), Some(TagLine::Open { .. })) {
				skipping = false;
				result.push(line);
			}
			index += 1;
			continue;
		}
		result.push(line);
		index += 1;
	}
	result
}

fn trim_blank(buffer: &[String]) -> Vec<String> {
	let start = buffer
		.iter()
		.position(|line| !line.trim().is_empty())
		.unwrap_or(buffer.len());
	let end = buffer
		.iter()
		.rposition(|line| !line.trim().is_empty())
		.map_or(start, |index| index + 1);
	buffer[start..end].to_vec()
}

fn flush_compiled(
	sections: &mut Vec<CompiledSection>,
	all: bool,
	find_lines: &mut Vec<String>,
	put_lines: &mut Option<Vec<String>>,
) {
	let find = trim_blank(find_lines);
	let put = put_lines.as_deref().map(trim_blank);
	find_lines.clear();
	*put_lines = None;
	if find.is_empty() && put.as_ref().is_none_or(Vec::is_empty) {
		return;
	}
	if sections.is_empty() {
		sections.push(CompiledSection { path: String::new(), ir: Vec::new() });
	}
	let ir = &mut sections.last_mut().expect("section exists").ir;
	ir.push(format!("{OPENER}{}", if all { "*" } else { "" }));
	if find.is_empty() {
		if let Some(put) = put {
			ir.extend(put);
		}
		return;
	}
	ir.extend(find);
	if let Some(put) = put {
		ir.push(REWRITE_HEADER.to_owned());
		ir.extend(put);
	}
}

fn compile_tag_surface(lines: &[String]) -> (Vec<CompiledSection>, bool) {
	#[derive(Clone, Copy, PartialEq, Eq)]
	enum State {
		Idle,
		Find,
		Between,
		Put,
	}

	let mut sections = Vec::new();
	let mut saw_tags = false;
	let mut all = false;
	let mut state = State::Idle;
	let mut find_lines = Vec::new();
	let mut put_lines: Option<Vec<String>> = None;

	for line in lines {
		let Some(tag) = parse_tag_line(line) else {
			match state {
				State::Put => put_lines
					.as_mut()
					.expect("put buffer exists")
					.push(line.clone()),
				State::Find => find_lines.push(line.clone()),
				State::Between if !line.trim().is_empty() => find_lines.push(line.clone()),
				State::Idle if !line.trim().is_empty() => {
					state = State::Find;
					find_lines.push(line.clone());
				},
				State::Idle | State::Between => {},
			}
			continue;
		};
		saw_tags = true;
		match tag {
			TagLine::Open { path, all: next_all } => {
				flush_compiled(&mut sections, all, &mut find_lines, &mut put_lines);
				state = State::Idle;
				if let Some(path) = path {
					sections.push(CompiledSection { path, ir: Vec::new() });
				}
				all = next_all;
			},
			TagLine::CloseEdit => {
				flush_compiled(&mut sections, all, &mut find_lines, &mut put_lines);
				state = State::Idle;
				all = false;
			},
			TagLine::Find { inline } => {
				flush_compiled(&mut sections, all, &mut find_lines, &mut put_lines);
				state = State::Find;
				if let Some(inline) = inline {
					find_lines.push(inline);
					state = State::Between;
				}
			},
			TagLine::CloseFind => {
				if state == State::Find {
					state = State::Between;
				}
			},
			TagLine::Put { inline } => {
				put_lines = Some(Vec::new());
				state = State::Put;
				if let Some(inline) = inline {
					put_lines.as_mut().expect("put buffer exists").push(inline);
					flush_compiled(&mut sections, all, &mut find_lines, &mut put_lines);
					state = State::Idle;
				}
			},
			TagLine::ClosePut => {
				flush_compiled(&mut sections, all, &mut find_lines, &mut put_lines);
				state = State::Idle;
			},
		}
	}
	flush_compiled(&mut sections, all, &mut find_lines, &mut put_lines);
	(sections, saw_tags)
}

/// Split a tagged sloppy payload into ordered, same-path-coalesced sections.
pub fn split_sloppy_sections(input: &str) -> Vec<SloppySection> {
	let mut lines = strip_envelope_noise(input.split('\n').collect());
	while lines.first().is_some_and(|line| line.trim().is_empty()) {
		lines.remove(0);
	}
	if !matches!(
		parse_tag_line(lines.first().map_or("", String::as_str)),
		Some(TagLine::Open { path: Some(_), .. })
	) {
		return Vec::new();
	}
	let (sections, _) = compile_tag_surface(&lines);
	let mut bodies: HashMap<String, Vec<String>> = HashMap::new();
	let mut paths = Vec::new();
	for section in sections {
		if section.path.is_empty() || section.ir.is_empty() {
			continue;
		}
		if !bodies.contains_key(&section.path) {
			paths.push(section.path.clone());
		}
		bodies.entry(section.path).or_default().extend(section.ir);
	}
	paths
		.into_iter()
		.map(|path| SloppySection { body: bodies.remove(&path).unwrap_or_default().join("\n"), path })
		.collect()
}

/// Extract pathful sloppy payloads embedded in prose, using UTF-16 offsets.
pub fn extract_inline_sloppy_regions(text: &str) -> Vec<InlineSloppyRegion> {
	if !text.contains("<SM:EDIT") {
		return Vec::new();
	}
	let lines: Vec<&str> = text.split('\n').collect();
	let mut starts = Vec::with_capacity(lines.len());
	let mut position = 0;
	for line in &lines {
		starts.push(position);
		position += line.encode_utf16().count() + 1;
	}
	let text_length = text.encode_utf16().count();
	let line_end =
		|index: usize| (starts[index] + lines[index].encode_utf16().count() + 1).min(text_length);
	let mut regions = Vec::new();
	let mut in_fence = false;
	let mut index = 0;
	while index < lines.len() {
		let line = lines[index];
		if FENCE_LINE_RE.is_match(line) {
			in_fence = !in_fence;
			index += 1;
			continue;
		}
		let opener = (!in_fence).then(|| parse_tag_line(line)).flatten();
		if !matches!(opener, Some(TagLine::Open { path: Some(_), .. })) {
			index += 1;
			continue;
		}
		#[derive(Clone, Copy)]
		enum Block {
			Outside,
			Find,
			Put,
		}
		let mut last = index;
		let mut block = Block::Outside;
		let mut scan = index + 1;
		while scan < lines.len() {
			let Some(tag) = parse_tag_line(lines[scan]) else {
				if matches!(block, Block::Outside) {
					if lines[scan].trim().is_empty() {
						scan += 1;
						continue;
					}
					break;
				}
				last = scan;
				scan += 1;
				continue;
			};
			block = match tag {
				TagLine::Find { inline: None } => Block::Find,
				TagLine::Put { inline: None } => Block::Put,
				_ => Block::Outside,
			};
			last = scan;
			scan += 1;
		}
		let payload = lines[index..=last].join("\n");
		if !split_sloppy_sections(&payload).is_empty() {
			regions.push(InlineSloppyRegion { start: starts[index], end: line_end(last), payload });
		}
		index = scan.max(last + 1);
	}
	regions
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenerKind {
	Single,
	All,
}

fn parse_opener(line: &str) -> Option<OpenerKind> {
	match line.trim() {
		"«" => Some(OpenerKind::Single),
		"«*" => Some(OpenerKind::All),
		_ => None,
	}
}

fn is_ordinal_opener(line: &str) -> bool {
	ORDINAL_OPENER_RE.is_match(line.trim())
}

/// Normalize the taught XML surface or legacy IR into a canonical op stream.
pub fn normalize_input(input: &str) -> String {
	let mut lines = strip_envelope_noise(input.split('\n').collect());
	while lines.first().is_some_and(|line| line.trim().is_empty()) {
		lines.remove(0);
	}
	if lines
		.first()
		.is_some_and(|line| OUTER_FENCE_RE.is_match(line.trim()))
	{
		lines.remove(0);
		while lines.last().is_some_and(|line| line.trim().is_empty()) {
			lines.pop();
		}
		if lines.last().is_some_and(|line| line.trim() == "```") {
			lines.pop();
		}
	}
	if lines.iter().any(|line| parse_tag_line(line).is_some()) {
		lines = compile_tag_surface(&lines)
			.0
			.into_iter()
			.flat_map(|section| section.ir)
			.collect();
	} else {
		lines = lines
			.into_iter()
			.flat_map(|line| {
				GLUED_CONTROL_RE.captures(&line).map_or_else(
					|| vec![line.clone()],
					|captures| vec![captures[1].to_owned(), captures[2].to_owned()],
				)
			})
			.collect();
	}
	while lines.first().is_some_and(|line| line.trim().is_empty()) {
		lines.remove(0);
	}
	while lines.last().is_some_and(|line| line.trim().is_empty()) {
		lines.pop();
	}
	lines.join("\n")
}

fn normalize_block(lines: &[String], rewrite: bool) -> String {
	let mut cleaned: Vec<String> = lines
		.iter()
		.filter(|line| {
			let trimmed = line.trim();
			!SHOWING_LINES_RE.is_match(trimmed) && !ELIDED_LINE_RE.is_match(trimmed)
		})
		.cloned()
		.collect();
	if !rewrite {
		for line in &mut cleaned {
			if line.trim().is_empty() {
				line.clear();
			}
		}
	}
	while cleaned.last().is_some_and(|line| line.trim().is_empty()) {
		cleaned.pop();
	}
	let has_non_blank = cleaned.iter().any(|line| !line.trim().is_empty());
	let numbered_lines = has_non_blank
		&& cleaned
			.iter()
			.filter(|line| !line.trim().is_empty())
			.all(|line| NUMBERED_LINE_RE.is_match(line));
	let numbered_literals = has_non_blank
		&& cleaned
			.iter()
			.filter(|line| !line.trim().is_empty())
			.all(|line| NUMBERED_LITERAL_RE.is_match(line));
	let all_non_blank_plus = has_non_blank
		&& cleaned
			.iter()
			.filter(|line| !line.trim().is_empty())
			.all(|line| line.starts_with('+'));
	if numbered_lines && !numbered_literals {
		for line in &mut cleaned {
			*line = NUMBERED_LINE_RE.replace(line, "").into_owned();
		}
	}
	if rewrite {
		if cleaned.first().is_some_and(|line| line.trim() == "//") {
			cleaned.remove(0);
		}
		if cleaned
			.iter()
			.any(|line| marker_line_content(line, REMOVE_LINE).is_some())
			&& cleaned
				.iter()
				.any(|line| marker_line_content(line, ADD_LINE).is_some())
		{
			cleaned.retain(|line| marker_line_content(line, REMOVE_LINE).is_none());
		}
		for line in &mut cleaned {
			if let Some(stripped) = marker_line_content(line, ADD_LINE) {
				*line = stripped;
			}
		}
		let has_old = cleaned
			.iter()
			.any(|line| line.starts_with('-') && !line.starts_with("---"));
		let has_new = cleaned
			.iter()
			.any(|line| line.starts_with('+') && !line.starts_with("+++"));
		if has_old && has_new {
			return cleaned
				.into_iter()
				.filter(|line| !line.starts_with('-') && !line.starts_with("+++"))
				.map(|line| line.strip_prefix('+').unwrap_or(&line).to_owned())
				.collect::<Vec<_>>()
				.join("\n");
		}
		if all_non_blank_plus {
			return cleaned
				.into_iter()
				.map(|line| line.strip_prefix('+').unwrap_or(&line).to_owned())
				.collect::<Vec<_>>()
				.join("\n");
		}
	}
	cleaned.join("\n")
}

fn recover_missing_separator(lines: &[String], content: &str) -> Option<(String, String)> {
	if is_diff_shaped(&lines.join("\n")) {
		return None;
	}
	let mut candidates = Vec::new();
	for split in 1..lines.len() {
		let mut remainder_start = split;
		while lines
			.get(remainder_start)
			.is_some_and(|line| line.trim().is_empty())
		{
			remainder_start += 1;
		}
		if remainder_start >= lines.len() {
			continue;
		}
		let pattern = normalize_block(&lines[..split], false);
		let rewrite = normalize_block(&lines[remainder_start..], true);
		if js_len(&pattern) < 4 || rewrite.replace(GAP, "").trim().is_empty() {
			continue;
		}
		if rewrite
			.split('\n')
			.any(|line| !line.trim().is_empty() && line.trim().replace(GAP, "").is_empty())
		{
			continue;
		}
		let occurrences: Vec<usize> = content.match_indices(&pattern).map(|(at, _)| at).collect();
		if occurrences.len() != 1 {
			continue;
		}
		let through_first_rewrite = normalize_block(&lines[..=remainder_start], false);
		if content[occurrences[0]..].starts_with(&through_first_rewrite) {
			continue;
		}
		if !candidates
			.iter()
			.any(|candidate: &(String, String)| candidate.0 == pattern && candidate.1 == rewrite)
		{
			candidates.push((pattern, rewrite));
		}
	}
	(candidates.len() == 1).then(|| candidates.remove(0))
}

fn recover_alternating_separators(lines: &[String], content: &str) -> Option<Vec<String>> {
	if lines.iter().any(|line| line.trim() == REWRITE_HEADER) {
		return None;
	}
	let headers: Vec<usize> = lines
		.iter()
		.enumerate()
		.filter_map(|(index, line)| parse_opener(line).map(|_| index))
		.collect();
	if headers.len() < 2 || !headers.len().is_multiple_of(2) || headers[0] != 0 {
		return None;
	}
	let normalized_content = normalize_text(content).text;
	let mut recovered = Vec::new();
	for pair in (0..headers.len()).step_by(2) {
		let match_start = headers[pair];
		let rewrite_start = headers[pair + 1];
		let next = headers.get(pair + 2).copied().unwrap_or(lines.len());
		let match_lines = &lines[match_start + 1..rewrite_start];
		let rewrite_lines = &lines[rewrite_start + 1..next];
		let normalized_match = normalize_text(&normalize_block(match_lines, false)).text;
		let normalized_rewrite = normalize_text(&normalize_block(rewrite_lines, true)).text;
		if normalized_match.is_empty()
			|| normalized_rewrite.is_empty()
			|| rewrite_lines.iter().any(|line| line.contains(SELECT_OPEN))
			|| !normalized_content.contains(&normalized_match)
			|| normalized_content.contains(&normalized_rewrite)
		{
			return None;
		}
		recovered.push(lines[match_start].clone());
		recovered.extend_from_slice(match_lines);
		recovered.push(REWRITE_HEADER.to_owned());
		recovered.extend_from_slice(rewrite_lines);
	}
	Some(recovered)
}

fn recover_bracket_pairs(lines: &[String], content: &str) -> Option<Vec<String>> {
	let mut items = Vec::new();
	let mut open = None;
	for (index, line) in lines.iter().enumerate() {
		let trimmed = line.trim();
		if parse_opener(line).is_some() {
			if open.is_some() {
				return None;
			}
			open = Some(index);
		} else if trimmed == REWRITE_HEADER {
			items.push((open?, index));
			open = None;
		} else if open.is_none() && !trimmed.is_empty() {
			return None;
		}
	}
	if open.is_some() || items.len() < 2 || !items.len().is_multiple_of(2) {
		return None;
	}
	let normalized_content = normalize_text(content).text;
	let mut recovered = Vec::new();
	for pair in (0..items.len()).step_by(2) {
		let first = items[pair];
		let second = items[pair + 1];
		let match_lines = &lines[first.0 + 1..first.1];
		let rewrite_lines = &lines[second.0 + 1..second.1];
		let normalized_match = normalize_text(&normalize_block(match_lines, false)).text;
		let normalized_rewrite = normalize_text(&normalize_block(rewrite_lines, true)).text;
		if normalized_match.is_empty()
			|| normalized_rewrite.is_empty()
			|| rewrite_lines.iter().any(|line| line.contains(SELECT_OPEN))
			|| !normalized_content.contains(&normalized_match)
			|| normalized_content.contains(&normalized_rewrite)
		{
			return None;
		}
		recovered.push(lines[first.0].clone());
		recovered.extend_from_slice(match_lines);
		recovered.push(REWRITE_HEADER.to_owned());
		recovered.extend_from_slice(rewrite_lines);
	}
	Some(recovered)
}

fn has_inline_selection(pattern: &str) -> bool {
	let mut selected = false;
	for character in pattern.chars() {
		match character.to_string().as_str() {
			SELECT_OPEN => selected = true,
			SELECT_CLOSE => selected = false,
			SELECT_DIVIDER if selected => return true,
			_ => {},
		}
	}
	false
}

fn validate_selection_markers(pattern: &str, operation_number: usize) -> Result<(), EditError> {
	let opens = pattern.matches(SELECT_OPEN).count();
	let closes = pattern.matches(SELECT_CLOSE).count();
	if opens == closes {
		return Ok(());
	}
	Err(parse_error(if opens > closes {
		format!("Operation {operation_number} has an unclosed selection marker ⟪; add closing ⟫.")
	} else {
		format!(
			"Operation {operation_number} has an unmatched closing selection marker ⟫; add opening ⟪."
		)
	}))
}

fn resolve_literal_dividers(selected: &str, operation_number: usize) -> (String, String, String) {
	let dividers: Vec<usize> = selected
		.match_indices(SELECT_DIVIDER)
		.map(|(at, _)| at)
		.collect();
	let advice = format!(
		"Selections containing literal {SELECT_DIVIDER} are ambiguous; state those lines with a \
		 {REWRITE_HEADER} block rewrite instead."
	);
	let last = *dividers.last().expect("called with multiple dividers");
	if last + SELECT_DIVIDER.len() == selected.len() {
		return (
			selected[..last].to_owned(),
			String::new(),
			format!(
				"Note: operation {operation_number}'s selection contained {} {SELECT_DIVIDER} \
				 characters and ended with one; it was read as a deletion of the selected text with \
				 the inner {SELECT_DIVIDER}s literal. {advice}",
				dividers.len()
			),
		);
	}
	if dividers.len() % 2 == 1 {
		let middle = dividers[(dividers.len() - 1) / 2];
		return (
			selected[..middle].to_owned(),
			selected[middle + SELECT_DIVIDER.len()..].to_owned(),
			format!(
				"Note: operation {operation_number}'s selection contained {} {SELECT_DIVIDER} \
				 characters; the middle one was read as the divider and the others as literal text. \
				 {advice}",
				dividers.len()
			),
		);
	}
	(
		selected.to_owned(),
		String::new(),
		format!(
			"Note: operation {operation_number}'s selection contained {} {SELECT_DIVIDER} characters \
			 with no unambiguous divider; it was read as a deletion of the selected text. {advice}",
			dividers.len()
		),
	)
}

fn parse_inline_pattern(
	pattern: &str,
	operation_number: usize,
) -> Result<(String, Vec<String>, Vec<String>), EditError> {
	validate_selection_markers(pattern, operation_number)?;
	let mut pattern_text = String::new();
	let mut replacements = Vec::new();
	let mut notes = Vec::new();
	let mut saw_bare = false;
	let mut saw_inline = false;
	let mut index = 0;
	while index < pattern.len() {
		if pattern[index..].starts_with(SELECT_CLOSE) {
			return Err(parse_error(format!(
				"Operation {operation_number} has an unmatched closing selection marker ⟫; add \
				 opening ⟪."
			)));
		}
		if !pattern[index..].starts_with(SELECT_OPEN) {
			let character = pattern[index..]
				.chars()
				.next()
				.expect("character at boundary");
			pattern_text.push(character);
			index += character.len_utf8();
			continue;
		}
		let selected_start = index + SELECT_OPEN.len();
		let close_relative = pattern[selected_start..]
			.find(SELECT_CLOSE)
			.expect("validated close marker");
		let close = selected_start + close_relative;
		let selected = &pattern[selected_start..close];
		if selected.contains(SELECT_OPEN) {
			return Err(parse_error(format!(
				"Operation {operation_number} has nested selection markers; use one selection per \
				 replacement."
			)));
		}
		if let Some(divider) = selected.find(SELECT_DIVIDER) {
			saw_inline = true;
			if selected[divider + SELECT_DIVIDER.len()..].contains(SELECT_DIVIDER) {
				let (old, desired, note) = resolve_literal_dividers(selected, operation_number);
				pattern_text.push_str(SELECT_OPEN);
				pattern_text.push_str(&old);
				pattern_text.push_str(SELECT_CLOSE);
				replacements.push(desired);
				notes.push(note);
			} else {
				pattern_text.push_str(SELECT_OPEN);
				pattern_text.push_str(&selected[..divider]);
				pattern_text.push_str(SELECT_CLOSE);
				replacements.push(selected[divider + SELECT_DIVIDER.len()..].to_owned());
			}
		} else {
			saw_bare = true;
			pattern_text.push_str(&pattern[index..close + SELECT_CLOSE.len()]);
		}
		index = close + SELECT_CLOSE.len();
	}
	if saw_bare && saw_inline {
		return Err(parse_error(format!(
			"Operation {operation_number} mixes inline and bare selections. Use \
			 {SELECT_OPEN}old{SELECT_DIVIDER}new{SELECT_CLOSE} for every selection, or use a \
			 {REWRITE_HEADER} rewrite for all bare selections."
		)));
	}
	Ok((pattern_text, replacements, notes))
}

fn relocate_selection_lines(pattern_text: &str) -> String {
	let mut lines: Vec<String> = pattern_text.split('\n').map(str::to_owned).collect();
	let mut index = 1;
	while index < lines.len() {
		let previous = lines[index - 1].clone();
		let Some(captures) = SELECTION_ONLY_RE.captures(lines[index].trim()) else {
			index += 1;
			continue;
		};
		if previous.contains(SELECT_OPEN) || previous.contains(GAP) || previous.trim().is_empty() {
			index += 1;
			continue;
		}
		let old = normalize_text(captures.get(1).map_or("", |value| value.as_str())).text;
		if old.is_empty() {
			index += 1;
			continue;
		}
		let normalized = normalize_text(&previous);
		let Some(first) = normalized.text.find(&old) else {
			index += 1;
			continue;
		};
		if normalized.text[first + old.len()..].contains(&old) || normalized.text == old {
			index += 1;
			continue;
		}
		let raw_start = normalized.starts.get(first).copied().unwrap_or(0);
		let raw_end = normalized
			.ends
			.get(first + old.len() - 1)
			.copied()
			.unwrap_or(previous.len());
		lines[index - 1] =
			format!("{}{}{}", &previous[..raw_start], lines[index].trim(), &previous[raw_end..]);
		lines.remove(index);
		index = index.saturating_sub(1).max(1);
	}
	lines.join("\n")
}

fn pattern_reference(pattern: &str) -> Option<String> {
	pattern.split('\n').find_map(|line| {
		REFERENCE_RE
			.captures(line.trim())
			.map(|captures| captures[1].to_owned())
	})
}

fn has_bare_desired(pattern_text: &str) -> bool {
	BARE_DESIRED_RE.is_match(pattern_text)
}

fn embed_bare_desired(pattern_text: &str) -> String {
	BARE_DESIRED_CAPTURE_RE
		.replace_all(pattern_text, "⟪…│$1⟫")
		.into_owned()
}

fn expand_echoed_line_selection(pattern_text: &str, rewrite_text: &str) -> Option<String> {
	let rewrite_lines: Vec<&str> = rewrite_text
		.split('\n')
		.filter(|line| !line.trim().is_empty())
		.collect();
	if rewrite_lines.len() != 1 {
		return None;
	}
	let mut lines: Vec<String> = pattern_text.split('\n').map(str::to_owned).collect();
	let index = lines.iter().position(|line| line.contains(SELECT_OPEN))?;
	let line = lines[index].clone();
	if line.contains(GAP) {
		return None;
	}
	let open = line.find(SELECT_OPEN)?;
	let close = line[open + SELECT_OPEN.len()..].find(SELECT_CLOSE)? + open + SELECT_OPEN.len();
	if line[open + SELECT_OPEN.len()..]
		.matches(SELECT_OPEN)
		.count()
		> 0 || lines
		.iter()
		.enumerate()
		.any(|(at, entry)| at != index && entry.contains(SELECT_OPEN))
	{
		return None;
	}
	let prefix = &line[..open];
	let suffix = &line[close + SELECT_CLOSE.len()..];
	if prefix.trim().is_empty() || suffix.contains(SELECT_CLOSE) {
		return None;
	}
	let selected = &line[open + SELECT_OPEN.len()..close];
	if selected.contains(SELECT_DIVIDER)
		|| !normalize_text(rewrite_lines[0])
			.text
			.starts_with(&normalize_text(prefix).text)
	{
		return None;
	}
	lines[index] = format!("{SELECT_OPEN}{prefix}{selected}{suffix}{SELECT_CLOSE}");
	Some(lines.join("\n"))
}

/// Strip a full-line marker while retaining indentation.
pub fn marker_line_content(line: &str, marker: &str) -> Option<String> {
	let indent_len = line.len() - line.trim_start_matches([' ', '\t']).len();
	line[indent_len..]
		.starts_with(marker)
		.then(|| format!("{}{}", &line[..indent_len], &line[indent_len + marker.len()..]))
}

/// Whether a pattern contains any full-line add/remove markers.
pub fn has_marker_lines(pattern_text: &str) -> bool {
	(pattern_text.contains(ADD_LINE) || pattern_text.contains(REMOVE_LINE))
		&& pattern_text.split('\n').any(|line| {
			marker_line_content(line, ADD_LINE).is_some()
				|| marker_line_content(line, REMOVE_LINE).is_some()
		})
}

pub(crate) fn missing_unmarked_lines(content: &str, source_pattern_text: &str) -> Vec<String> {
	let haystack = normalize_text(content).text;
	let mut missing = Vec::new();
	for line in source_pattern_text.split('\n') {
		if marker_line_content(line, ADD_LINE).is_some()
			|| marker_line_content(line, REMOVE_LINE).is_some()
			|| line.contains(SELECT_OPEN)
			|| line.contains(SELECT_CLOSE)
		{
			continue;
		}
		let fragments: Vec<String> = line
			.split(GAP)
			.map(|fragment| normalize_text(fragment).text)
			.filter(|fragment| !fragment.is_empty())
			.collect();
		if !fragments.is_empty()
			&& fragments
				.iter()
				.any(|fragment| !haystack.contains(fragment))
		{
			missing.push(line.trim().to_owned());
		}
	}
	missing
}

fn is_near_variant(anchor: &str, added: &str) -> bool {
	if anchor.contains(SELECT_OPEN) || anchor.trim().is_empty() {
		return false;
	}
	let left = anchor.trim();
	let right = added.trim();
	if left == right || js_len(left) < 4 || js_len(right) < 4 {
		return false;
	}

	let tokens = |line: &str| {
		let mut counts = HashMap::new();
		for token in UNICODE_TOKEN_RE.find_iter(line).map(|item| item.as_str()) {
			*counts.entry(token.to_owned()).or_insert(0usize) += 1;
		}
		counts
	};
	let left_tokens = tokens(left);
	let right_tokens = tokens(right);
	let left_total: usize = left_tokens.values().sum();
	let right_total: usize = right_tokens.values().sum();
	if left_total == 0 || right_total == 0 {
		return false;
	}
	let shared: usize = left_tokens
		.iter()
		.map(|(token, count)| (*count).min(right_tokens.get(token).copied().unwrap_or(0)))
		.sum();
	(2.0 * shared as f64) / (left_total + right_total) as f64 >= 0.8
}

fn encode_literal_markers(text: &str) -> String {
	text
		.replace(SELECT_OPEN, LITERAL_OPEN)
		.replace(SELECT_CLOSE, LITERAL_CLOSE)
		.replace(SELECT_DIVIDER, LITERAL_DIVIDER)
}

fn decode_literal_markers(text: &str) -> String {
	text
		.replace(LITERAL_OPEN, SELECT_OPEN)
		.replace(LITERAL_CLOSE, SELECT_CLOSE)
		.replace(LITERAL_DIVIDER, SELECT_DIVIDER)
}

fn wrap_trailing_anchor(out: &mut [String], added: &[String]) -> bool {
	let Some(previous) = out.last().cloned() else {
		return false;
	};
	let close = previous.rfind(SELECT_CLOSE);
	let (head, tail) =
		close.map_or(("", previous.as_str()), |at| previous.split_at(at + SELECT_CLOSE.len()));
	if tail.trim().is_empty()
		|| tail.contains(GAP)
		|| tail.contains(SELECT_DIVIDER)
		|| tail.contains(SELECT_OPEN)
	{
		return false;
	}
	*out.last_mut().expect("non-empty output") = format!(
		"{head}{SELECT_OPEN}{tail}{SELECT_DIVIDER}{tail}\n{}{SELECT_CLOSE}",
		added.join("\n")
	);
	true
}

fn embed_marker_lines(pattern_text: &str) -> String {
	if !has_marker_lines(pattern_text) {
		return pattern_text.to_owned();
	}
	let lines: Vec<&str> = pattern_text.split('\n').collect();
	let mut out: Vec<String> = Vec::new();
	let mut index = 0;
	while index < lines.len() {
		let mut removed = Vec::new();
		while index < lines.len() {
			let Some(line) = marker_line_content(lines[index], REMOVE_LINE) else {
				break;
			};
			removed.push(line);
			index += 1;
		}
		let mut added = Vec::new();
		while index < lines.len() {
			let Some(line) = marker_line_content(lines[index], ADD_LINE) else {
				break;
			};
			added.push(encode_literal_markers(&line));
			index += 1;
		}
		if !removed.is_empty() {
			out.push(format!(
				"{SELECT_OPEN}{}{SELECT_DIVIDER}{}{SELECT_CLOSE}",
				removed.join("\n"),
				added.join("\n")
			));
			continue;
		}
		if added.is_empty() {
			out.push(lines[index].to_owned());
			index += 1;
			continue;
		}
		if added.len() == 1
			&& out
				.last()
				.is_some_and(|anchor| is_near_variant(anchor, &added[0]))
		{
			let anchor = out.pop().expect("checked anchor");
			out.push(format!("{SELECT_OPEN}{anchor}{SELECT_DIVIDER}{}{SELECT_CLOSE}", added[0]));
			continue;
		}
		let next = lines.get(index).copied();
		let mut lookahead = index;
		while lines
			.get(lookahead)
			.is_some_and(|line| line.trim().is_empty())
		{
			lookahead += 1;
		}
		let gap_below = lines.get(lookahead).is_some_and(|line| line.trim() == GAP);
		if let Some(next) = next {
			if gap_below && wrap_trailing_anchor(&mut out, &added) {
				out.push(next.to_owned());
			} else {
				out.push(format!(
					"{SELECT_OPEN}{SELECT_DIVIDER}{}\n{SELECT_CLOSE}{next}",
					added.join("\n")
				));
			}
			index += 1;
		} else {
			out.push(format!("{SELECT_OPEN}{SELECT_DIVIDER}{}\n{SELECT_CLOSE}", added.join("\n")));
		}
	}
	out.join("\n")
}

fn recover_stray_close_divider(pattern_text: &str) -> Option<String> {
	let opens = pattern_text.matches(SELECT_OPEN).count();
	let closes = pattern_text.matches(SELECT_CLOSE).count();
	if closes <= opens {
		return None;
	}

	let repaired = STRAY_DIVIDER_RE
		.replace_all(pattern_text, "⟪$1│$2⟫")
		.into_owned();
	if repaired == pattern_text
		|| repaired.matches(SELECT_OPEN).count() != repaired.matches(SELECT_CLOSE).count()
	{
		None
	} else {
		Some(repaired)
	}
}

fn recover_directive_rewrite(
	pattern_text: &str,
	rewrite_text: &str,
	all: bool,
	operation_number: usize,
) -> Result<Option<Operation>, EditError> {
	let lines: Vec<&str> = rewrite_text
		.split('\n')
		.map(str::trim)
		.filter(|line| !line.is_empty())
		.collect();
	if lines.is_empty() {
		return Ok(None);
	}
	let mut unique = Vec::<(String, String)>::new();
	let mut seen = HashSet::new();
	for line in lines {
		let Some(directive) = DIRECTIVE_RE.captures(line) else {
			return Ok(None);
		};
		if seen.insert(directive[1].to_owned()) {
			unique.push((directive[1].to_owned(), directive[2].to_owned()));
		}
	}
	unique.sort_by_key(|entry| std::cmp::Reverse(js_len(&entry.0)));
	let mut segments = vec![(pattern_text.to_owned(), false)];
	let mut matched_any = false;
	for (old, next) in unique {
		let mut rewritten = Vec::new();
		for (segment, locked) in segments {
			if locked {
				rewritten.push((segment, true));
				continue;
			}
			let mut from = 0;
			while let Some(relative) = segment[from..].find(&old) {
				let at = from + relative;
				if at > from {
					rewritten.push((segment[from..at].to_owned(), false));
				}
				rewritten
					.push((format!("{SELECT_OPEN}{old}{SELECT_DIVIDER}{next}{SELECT_CLOSE}"), true));
				matched_any = true;
				from = at + old.len();
			}
			if from < segment.len() {
				rewritten.push((segment[from..].to_owned(), false));
			}
		}
		segments = rewritten;
	}
	if !matched_any {
		return Ok(None);
	}
	let marked: String = segments.into_iter().map(|segment| segment.0).collect();
	let mut operation = create_operation_text(&marked, "", all, operation_number, false)?;
	operation.recovery_note = Some(format!(
		"Note: operation {operation_number}'s REWRITE listed ⟪old│new⟫ directives; they were \
		 applied to every occurrence inside the MATCH. Put selections in the MATCH itself, or state \
		 the final text in REWRITE."
	));
	Ok(Some(operation))
}

fn recover_mixed_rewrite_forms(
	source_pattern_text: &str,
	rewrite_text: &str,
	all: bool,
	operation_number: usize,
) -> Result<Operation, EditError> {
	let (inline_pattern, replacements, inline_notes) =
		parse_inline_pattern(source_pattern_text, operation_number)?;
	let mut current = String::new();
	let mut desired = String::new();
	let mut replacement_index = 0;
	let mut index = 0;
	while let Some(relative) = inline_pattern[index..].find(SELECT_OPEN) {
		let open = index + relative;
		let close = inline_pattern[open + SELECT_OPEN.len()..]
			.find(SELECT_CLOSE)
			.expect("inline pattern was validated")
			+ open + SELECT_OPEN.len();
		let between = &inline_pattern[index..open];
		let selected = &inline_pattern[open + SELECT_OPEN.len()..close];
		current.push_str(between);
		current.push_str(selected);
		desired.push_str(between);
		desired.push_str(
			replacements
				.get(replacement_index)
				.map_or(selected, String::as_str),
		);
		replacement_index += 1;
		index = close + SELECT_CLOSE.len();
	}
	current.push_str(&inline_pattern[index..]);
	desired.push_str(&inline_pattern[index..]);
	let normalized_rewrite = normalize_text(rewrite_text).text;
	let normalized_desired = normalize_text(&desired).text;
	let rewrite_lines: Vec<String> = rewrite_text
		.split('\n')
		.map(|line| normalize_text(line).text)
		.filter(|line| !line.is_empty())
		.collect();
	let echoes_desired = !rewrite_lines.is_empty()
		&& rewrite_lines.len() == replacements.len()
		&& rewrite_lines
			.iter()
			.zip(&replacements)
			.all(|(line, replacement)| *line == normalize_text(replacement).text);
	let redundant = normalized_rewrite.is_empty()
		|| normalized_rewrite == normalized_desired
		|| normalized_rewrite == normalize_text(&current).text
		|| normalized_desired.contains(&normalized_rewrite)
		|| echoes_desired;
	let mixed = format!(
		"Note: operation {operation_number} combined \
		 {SELECT_OPEN}current{SELECT_DIVIDER}desired{SELECT_CLOSE} replacements with a \
		 {REWRITE_HEADER} REWRITE"
	);
	if redundant {
		let mut operation =
			create_operation_text(source_pattern_text, "", all, operation_number, false)?;
		let mut notes = inline_notes;
		notes.push(format!(
			"{mixed}; the REWRITE only restated the inline result and was ignored. Use one form per \
			 operation."
		));
		operation.recovery_note = Some(notes.join("\n"));
		Ok(operation)
	} else {
		let mut operation =
			create_operation_text(&current, rewrite_text, all, operation_number, true)?;
		let mut notes = inline_notes;
		notes.push(format!(
			"{mixed}; the {REWRITE_HEADER} REWRITE was applied as the final text for the match. Use \
			 one form per operation."
		));
		operation.recovery_note = Some(notes.join("\n"));
		Ok(operation)
	}
}

fn create_operation_text(
	source_pattern_text: &str,
	rewrite_text: &str,
	all: bool,
	operation_number: usize,
	has_explicit_rewrite: bool,
) -> Result<Operation, EditError> {
	let mut embedded = embed_marker_lines(source_pattern_text);
	if let Some(repaired) = recover_stray_close_divider(&embedded) {
		let mut operation = create_operation_text(
			&repaired,
			rewrite_text,
			all,
			operation_number,
			has_explicit_rewrite,
		)?;
		source_pattern_text.clone_into(&mut operation.source_pattern_text);
		let note = format!(
			"Note: operation {operation_number} wrote {SELECT_CLOSE} where the {SELECT_DIVIDER} \
			 divider belongs; {SELECT_OPEN}old{SELECT_CLOSE}new{SELECT_CLOSE} was read as \
			 {SELECT_OPEN}old{SELECT_DIVIDER}new{SELECT_CLOSE}."
		);
		operation.recovery_note = Some(
			operation
				.recovery_note
				.map_or_else(|| note.clone(), |prior| format!("{note}\n{prior}")),
		);
		return Ok(operation);
	}
	if !has_explicit_rewrite && has_bare_desired(&embedded) {
		embedded = embed_bare_desired(&embedded);
	}
	if !has_inline_selection(&embedded)
		&& has_explicit_rewrite
		&& let Some(operation) =
			recover_directive_rewrite(&embedded, rewrite_text, all, operation_number)?
	{
		return Ok(operation);
	}
	if has_inline_selection(&embedded) {
		if has_explicit_rewrite {
			return recover_mixed_rewrite_forms(&embedded, rewrite_text, all, operation_number);
		}
		let (inline_pattern, replacements, notes) =
			parse_inline_pattern(&embedded, operation_number)?;
		if replacements.len() == 1
			&& replacements[0].is_empty()
			&& let Some(tail) = EMPTY_SELECTION_TAIL_RE.find(&inline_pattern)
		{
			let remainder = &inline_pattern[..tail.start()];
			if !normalize_text(remainder).text.is_empty() {
				return Ok(Operation {
					pattern_text: remainder.to_owned(),
					source_pattern_text: source_pattern_text.to_owned(),
					rewrite: OperationRewrite::Explicit { text: String::new() },
					all,
					assumed_deletion: false,
					desired_state: false,
					recovery_note: (!notes.is_empty()).then(|| notes.join("\n")),
					whitespace_matched: false,
				});
			}
		}
		if let Some(reference) = pattern_reference(&inline_pattern) {
			return Err(parse_error(format!(
				"{REWRITE_HEADER}{reference} is valid only inside an inline replacement or REWRITE, \
				 never MATCH."
			)));
		}
		return Ok(Operation {
			pattern_text: relocate_selection_lines(&inline_pattern),
			source_pattern_text: source_pattern_text.to_owned(),
			rewrite: OperationRewrite::Inline { replacements },
			all,
			assumed_deletion: false,
			desired_state: false,
			recovery_note: (!notes.is_empty()).then(|| notes.join("\n")),
			whitespace_matched: false,
		});
	}
	if let Some(reference) = pattern_reference(source_pattern_text) {
		return Err(parse_error(format!(
			"{REWRITE_HEADER}{reference} is valid only in REWRITE, never MATCH."
		)));
	}
	if !rewrite_text.trim().is_empty()
		&& let Some(echoed) = expand_echoed_line_selection(source_pattern_text, rewrite_text)
	{
		return Ok(Operation {
			pattern_text: echoed,
			source_pattern_text: source_pattern_text.to_owned(),
			rewrite: OperationRewrite::Explicit { text: rewrite_text.to_owned() },
			all,
			assumed_deletion: false,
			desired_state: false,
			recovery_note: Some(format!(
				"Note: operation {operation_number}'s REWRITE restated the whole selection-bearing \
				 line, so the full line was replaced. A REWRITE after a bare selection replaces only \
				 the selected span; state just the span's new text, or select the whole line."
			)),
			whitespace_matched: false,
		});
	}
	Ok(Operation {
		pattern_text: source_pattern_text.to_owned(),
		source_pattern_text: source_pattern_text.to_owned(),
		rewrite: OperationRewrite::Explicit { text: rewrite_text.to_owned() },
		all,
		assumed_deletion: false,
		desired_state: false,
		recovery_note: None,
		whitespace_matched: false,
	})
}

/// Build and validate one operation from its pattern and rewrite.
pub fn create_operation(
	source_pattern_text: &str,
	rewrite: OperationRewrite,
	all: bool,
	_content: &str,
	operation_number: usize,
) -> Result<Operation, EditError> {
	match rewrite {
		OperationRewrite::Explicit { text } => {
			create_operation_text(source_pattern_text, &text, all, operation_number, true)
		},
		OperationRewrite::Inline { replacements } => Ok(Operation {
			pattern_text: source_pattern_text.to_owned(),
			source_pattern_text: source_pattern_text.to_owned(),
			rewrite: OperationRewrite::Inline { replacements },
			all,
			assumed_deletion: false,
			desired_state: false,
			recovery_note: None,
			whitespace_matched: false,
		}),
	}
}

fn finish_operation(
	lines: &[String],
	end_index: usize,
	pattern_lines: &[String],
	rewrite_lines: &[String],
	reference_separator: Option<&str>,
	all: bool,
	operations: &mut Vec<Operation>,
) -> Result<(), EditError> {
	let source = normalize_block(pattern_lines, false);
	let rewrite = normalize_block(rewrite_lines, true);
	if let Some(reference) = reference_separator.filter(|_| rewrite.trim().is_empty()) {
		if !has_inline_selection(&source) {
			let mut corrected = lines.to_vec();
			if let Some(separator_index) = corrected[..end_index]
				.iter()
				.rposition(|line| line.trim() == reference)
			{
				REWRITE_HEADER.clone_into(&mut corrected[separator_index]);
				corrected.insert(end_index, "{final text}".to_owned());
			}
			return Err(parse_error(format!(
				"{reference} after <SM:FIND> reads as the <SM:PUT> separator, leaving <SM:PUT> \
				 empty.\nCopy-ready corrected payload (fill in the final text):\n{}",
				ir_to_xml(&corrected.iter().map(String::as_str).collect::<Vec<_>>())
			)));
		}
		operations.push(create_operation_text(&source, "", all, operations.len() + 1, false)?);
		return Ok(());
	}
	if !has_inline_selection(&source) && !has_marker_lines(&source) {
		let mut body = rewrite_lines.to_vec();
		while body.first().is_some_and(|line| line.trim().is_empty()) {
			body.remove(0);
		}
		while body.last().is_some_and(|line| line.trim().is_empty()) {
			body.pop();
		}
		let add_only = !normalize_text(&source).text.is_empty()
			&& body
				.iter()
				.any(|line| marker_line_content(line, ADD_LINE).is_some())
			&& body
				.iter()
				.all(|line| line.trim().is_empty() || marker_line_content(line, ADD_LINE).is_some());
		if add_only {
			let insertion: Vec<String> = body
				.iter()
				.map(|line| {
					if line.trim().is_empty() {
						ADD_LINE.to_owned()
					} else {
						line.clone()
					}
				})
				.collect();
			let number = operations.len() + 1;
			let mut operation = create_operation_text(
				&format!("{source}\n{}", insertion.join("\n")),
				"",
				all,
				number,
				false,
			)?;
			let note = format!(
				"Note: operation {number}'s REWRITE contained only {ADD_LINE} add lines; they were \
				 inserted after the kept MATCH. A <SM:PUT> replaces the <SM:FIND> match with its \
				 stated final text — to insert, restate the kept lines plus the new lines in <SM:PUT>."
			);
			operation.recovery_note = Some(
				operation
					.recovery_note
					.map_or_else(|| note.clone(), |prior| format!("{note}\n{prior}")),
			);
			operations.push(operation);
			return Ok(());
		}
	}
	let number = operations.len() + 1;
	operations.push(create_operation_text(&source, &rewrite, all, number, true)?);
	Ok(())
}

fn finish_pattern(
	lines: &[String],
	end_index: usize,
	content: &str,
	pattern_lines: &[String],
	all: bool,
	operations: &mut Vec<Operation>,
	pending: &mut Vec<(usize, String)>,
) -> Result<(), EditError> {
	let source = normalize_block(pattern_lines, false);
	let number = operations.len() + 1;
	if has_inline_selection(&source) || has_marker_lines(&source) || has_bare_desired(&source) {
		operations.push(create_operation_text(&source, "", all, number, false)?);
		return Ok(());
	}
	if let Some((pattern, rewrite)) = recover_missing_separator(pattern_lines, content) {
		operations.push(create_operation_text(&pattern, &rewrite, all, number, true)?);
		return Ok(());
	}
	let mut diff_fallback = None;
	for candidate in diff_shaped_candidates(&source) {
		let Ok(mut operation) = create_operation_text(&candidate, "", all, number, false) else {
			continue;
		};
		operation.recovery_note = Some(format!(
			"Note: operation {number} was written as a unified diff and was applied as inline \
			 changes; state edits as <SM:FIND>/<SM:PUT> pairs instead."
		));
		let located = parse_pattern(&operation.pattern_text, number)
			.and_then(|pattern| locate(content, &pattern, &operation, number, "", &[], true));
		if located.is_ok() {
			operations.push(operation);
			return Ok(());
		}
		diff_fallback.get_or_insert(operation);
	}
	if let Some(operation) = diff_fallback {
		operations.push(operation);
		return Ok(());
	}
	if !source.contains(GAP) {
		let mut desired = create_operation_text(&source, &source, all, number, true)?;
		desired.desired_state = true;
		if let Ok(pattern) = parse_pattern(&desired.pattern_text, number) {
			match locate(content, &pattern, &desired, number, "", &[], true) {
				Ok(located) => {
					if let Some(matched) = located.first() {
						let matched_normalized =
							normalize_text(&content[matched.match_start..matched.match_end]).text;
						let matched_units: Vec<u16> = matched_normalized.encode_utf16().collect();
						let mut neighbors_duplicate = false;
						if matched_units.len() >= 8 {
							let before: Vec<u16> = normalize_text(&content[..matched.match_start])
								.text
								.encode_utf16()
								.collect();
							let after: Vec<u16> = normalize_text(&content[matched.match_end..])
								.text
								.encode_utf16()
								.collect();
							for overlap in (8..=matched_units.len()).rev() {
								if before.ends_with(&matched_units[..overlap])
									|| after.starts_with(&matched_units[matched_units.len() - overlap..])
								{
									neighbors_duplicate = true;
									break;
								}
							}
						}
						if neighbors_duplicate {
							desired.recovery_note = Some(format!(
								"Note: operation {number} stated desired text without markers; the \
								 closest matching block was replaced with it. State the current text in \
								 <SM:FIND> and the new text in <SM:PUT>."
							));
							operations.push(desired);
							return Ok(());
						}
					}
				},
				Err(ambiguity) if ambiguity.to_string().contains(" is ambiguous: ") => {
					let mut every = desired.clone();
					every.all = true;
					if let Ok(mut matches) = locate(content, &pattern, &every, number, "", &[], true)
						&& matches.len() == 2
					{
						matches.sort_by_key(|candidate| candidate.match_start);
						let first = &matches[0];
						let second = &matches[1];
						if content[first.match_end..second.match_start]
							.trim()
							.is_empty()
						{
							let span_start = content[..first.match_start]
								.rfind('\n')
								.map_or(0, |at| at + 1);
							let span = &content[span_start..second.match_end];
							let replacement = &content[span_start..first.match_end];
							let mut collapse =
								create_operation_text(span, replacement, false, number, true)?;
							collapse.recovery_note = Some(format!(
								"Note: operation {number} stated desired text that currently appears \
								 twice back-to-back; the duplicate copy was collapsed."
							));
							operations.push(collapse);
							return Ok(());
						}
					}
				},
				Err(_) => {},
			}
		}
		if let Some(closest) = closest_desired_block(content, &source) {
			operations.push(Operation {
				pattern_text:        closest,
				source_pattern_text: source.clone(),
				rewrite:             OperationRewrite::Explicit { text: source.clone() },
				all:                 false,
				assumed_deletion:    false,
				desired_state:       false,
				recovery_note:       Some(format!(
					"Note: operation {number} stated desired text without markers; the closest \
					 matching block was replaced with it. State the current text in <SM:FIND> and the \
					 new text in <SM:PUT>."
				)),
				whitespace_matched:  false,
			});
			return Ok(());
		}
	}
	let normalized_pattern = normalize_text(&source).text;
	let context_echo = if !normalized_pattern.is_empty()
		&& normalize_text(content).text.contains(&normalized_pattern)
	{
		"\nIts lines already exist in the file unchanged — if this operation only restated context, \
		 delete it; anchors belong inside the operation that edits them."
	} else {
		""
	};
	let mut corrected = lines[..end_index].to_vec();
	corrected.push(REWRITE_HEADER.to_owned());
	corrected.push("{new text}".to_owned());
	corrected.extend_from_slice(&lines[end_index..]);
	let needs_separator = format!(
		"Operation {number} has <SM:FIND> but no <SM:PUT>.{context_echo}\nCopy-ready corrected \
		 payload (fill in the new text):\n{}",
		ir_to_xml(&corrected.iter().map(String::as_str).collect::<Vec<_>>())
	);
	if !source.contains('\n') || js_len(&normalized_pattern) < 24 {
		return Err(parse_error(needs_separator));
	}
	let mut operation = create_operation_text(&source, "", all, number, true)?;
	operation.assumed_deletion = true;
	pending.push((operations.len(), needs_separator));
	operations.push(operation);
	Ok(())
}

/// Parse a canonical or taught sloppy payload into operations.
pub fn parse_operations(input: &str, content: &str) -> Result<Vec<Operation>, EditError> {
	let payload = normalize_input(input);
	let mut lines: Vec<String> = payload.split('\n').map(str::to_owned).collect();
	if parse_opener(lines.first().map_or("", String::as_str)).is_none()
		&& (lines.iter().any(|line| line.trim() == REWRITE_HEADER)
			|| payload.contains(SELECT_OPEN)
			|| payload.contains(SELECT_CLOSE)
			|| has_marker_lines(&payload))
	{
		lines.insert(0, OPENER.to_owned());
	}
	lines = recover_alternating_separators(&lines, content).unwrap_or(lines);
	lines = recover_bracket_pairs(&lines, content).unwrap_or(lines);
	#[derive(Clone, Copy, PartialEq, Eq)]
	enum State {
		Outside,
		Pattern,
		Rewrite,
	}
	let mut operations = Vec::new();
	let mut state = State::Outside;
	let mut all = false;
	let mut pattern_lines = Vec::new();
	let mut rewrite_lines = Vec::new();
	let mut reference_separator: Option<String> = None;
	let mut pending = Vec::new();

	for index in 0..lines.len() {
		let line = &lines[index];
		let parsed_opener = parse_opener(line);
		let trimmed = line.trim();
		let register_reference = REFERENCE_RE.captures(trimmed);
		if is_ordinal_opener(line) {
			return Err(parse_error(format!(
				"{trimmed} is not a valid opener. Use a <SM:FIND> that matches once — add context \
				 only the intended match has — or <SM:EDIT all> to change every match."
			)));
		}
		if trimmed == format!("{OPENER}{REWRITE_HEADER}") {
			if state == State::Pattern
				&& pattern_lines
					.iter()
					.any(|line: &String| !line.trim().is_empty())
			{
				state = State::Rewrite;
			}
			continue;
		}
		if parsed_opener.is_none()
			&& (trimmed.starts_with(OPENER)
				|| (trimmed.starts_with(REWRITE_HEADER)
					&& trimmed != REWRITE_HEADER
					&& register_reference.is_none()))
		{
			let json = serde_json::to_string(trimmed).expect("string serialization cannot fail");
			return Err(parse_error(format!(
				"Invalid control line {json}; use only {OPENER}, {OPENER}*, {REWRITE_HEADER}, or \
				 {REWRITE_HEADER}N in REWRITE."
			)));
		}
		if state == State::Outside {
			if let Some(opener) = parsed_opener {
				all = opener == OpenerKind::All;
				pattern_lines.clear();
				rewrite_lines.clear();
				reference_separator = None;
				state = State::Pattern;
			} else if !trimmed.is_empty() {
				return Err(parse_error(format!(
					"Expected an <SM:EDIT> or <SM:FIND> tag on input line {}.",
					index + 1
				)));
			}
			continue;
		}
		if state == State::Pattern {
			let accumulated = pattern_lines.join("\n");
			let balanced =
				accumulated.matches(SELECT_OPEN).count() == accumulated.matches(SELECT_CLOSE).count();
			if trimmed == REWRITE_HEADER
				|| (trimmed == "***"
					&& balanced
					&& pattern_lines.iter().any(|line| !line.trim().is_empty()))
				|| (trimmed == SELECT_CLOSE
					&& balanced
					&& pattern_lines.iter().any(|line| !line.trim().is_empty()))
			{
				state = State::Rewrite;
			} else if register_reference.is_some() && balanced {
				if !pattern_lines.iter().any(|line| !line.trim().is_empty()) {
					return Err(parse_error(format!(
						"{trimmed} is valid only in REWRITE, never MATCH."
					)));
				}
				state = State::Rewrite;
				reference_separator = Some(trimmed.to_owned());
			} else if let Some(opener) = parsed_opener {
				if pattern_lines.iter().any(|line| !line.trim().is_empty()) {
					finish_pattern(
						&lines,
						index,
						content,
						&pattern_lines,
						all,
						&mut operations,
						&mut pending,
					)?;
				}
				all = opener == OpenerKind::All;
				pattern_lines.clear();
				rewrite_lines.clear();
				reference_separator = None;
			} else {
				pattern_lines.push(line.clone());
			}
			continue;
		}
		if let Some(opener) = parsed_opener {
			finish_operation(
				&lines,
				index,
				&pattern_lines,
				&rewrite_lines,
				reference_separator.as_deref(),
				all,
				&mut operations,
			)?;
			all = opener == OpenerKind::All;
			pattern_lines.clear();
			rewrite_lines.clear();
			reference_separator = None;
			state = State::Pattern;
		} else if trimmed == "***" {
		} else if trimmed == REWRITE_HEADER {
			let next_content = lines[index + 1..]
				.iter()
				.find(|entry| !entry.trim().is_empty());
			if next_content.is_some_and(|next| parse_opener(next).is_none()) {
				return Err(parse_error(format!(
					"Operation {} has a second {REWRITE_HEADER} line.",
					operations.len() + 1
				)));
			}
		} else if trimmed == SELECT_CLOSE
			&& rewrite_lines.join("\n").matches(SELECT_OPEN).count()
				== rewrite_lines.join("\n").matches(SELECT_CLOSE).count()
		{
		} else {
			rewrite_lines.push(line.clone());
		}
	}
	match state {
		State::Rewrite => finish_operation(
			&lines,
			lines.len(),
			&pattern_lines,
			&rewrite_lines,
			reference_separator.as_deref(),
			all,
			&mut operations,
		)?,
		State::Pattern => finish_pattern(
			&lines,
			lines.len(),
			content,
			&pattern_lines,
			all,
			&mut operations,
			&mut pending,
		)?,
		State::Outside => {},
	}
	if operations.is_empty() {
		return Err(parse_error("Empty patch. Provide at least one <SM:FIND>/<SM:PUT> pair."));
	}
	for (index, operation) in operations.iter().enumerate() {
		let rewrites: Vec<&str> = match &operation.rewrite {
			OperationRewrite::Explicit { text } => vec![text],
			OperationRewrite::Inline { replacements } => {
				replacements.iter().map(String::as_str).collect()
			},
		};
		for rewrite in rewrites {
			for line in rewrite.split('\n') {
				if let Some(reference) = REFERENCE_RE.captures(line.trim())
					&& reference[1]
						.parse::<usize>()
						.is_ok_and(|number| number > index)
				{
					return Err(parse_error(format!(
						"{REWRITE_HEADER}{} must reference an earlier operation, not self/forward.",
						&reference[1]
					)));
				}
			}
		}
	}
	for (index, message) in pending {
		let normalized_pattern = normalize_text(&operations[index].pattern_text).text;
		let justified = operations.iter().enumerate().any(|(other_index, other)| {
			if other_index == index {
				return false;
			}
			let rewrites: Vec<&str> = match &other.rewrite {
				OperationRewrite::Explicit { text } => vec![text],
				OperationRewrite::Inline { replacements } => {
					replacements.iter().map(String::as_str).collect()
				},
			};
			rewrites.iter().any(|rewrite| {
				normalize_text(rewrite).text.contains(&normalized_pattern)
					|| rewrite
						.split('\n')
						.any(|line| line.trim() == format!("{REWRITE_HEADER}{}", index + 1))
			})
		});
		if !justified {
			return Err(parse_error(message));
		}
	}
	Ok(operations)
}

fn render_inline_pattern(pattern_text: &str, replacements: &[String]) -> String {
	let mut rendered = String::new();
	let mut replacement_index = 0;
	let mut index = 0;
	while index < pattern_text.len() {
		let Some(relative) = pattern_text[index..].find(SELECT_OPEN) else {
			rendered.push_str(&pattern_text[index..]);
			break;
		};
		let open = index + relative;
		rendered.push_str(&pattern_text[index..open]);
		let close = pattern_text[open + SELECT_OPEN.len()..]
			.find(SELECT_CLOSE)
			.map_or(pattern_text.len(), |at| at + open + SELECT_OPEN.len());
		rendered.push_str(&pattern_text[open..close]);
		rendered.push_str(SELECT_DIVIDER);
		rendered.push_str(&decode_literal_markers(
			replacements
				.get(replacement_index)
				.map_or("", String::as_str),
		));
		rendered.push_str(SELECT_CLOSE);
		replacement_index += 1;
		index = (close + SELECT_CLOSE.len()).min(pattern_text.len());
	}
	rendered
}

fn operation_pattern(operation: &Operation, pattern_text: Option<&str>) -> String {
	let pattern = pattern_text.unwrap_or(&operation.pattern_text);
	match &operation.rewrite {
		OperationRewrite::Inline { replacements } if pattern != operation.pattern_text => {
			render_inline_pattern(pattern, replacements)
		},
		OperationRewrite::Inline { .. } => operation.source_pattern_text.clone(),
		OperationRewrite::Explicit { .. } => pattern.to_owned(),
	}
}

/// Render canonical IR lines as the taught XML surface.
pub fn ir_to_xml(lines: &[&str]) -> String {
	#[derive(Clone, Copy, PartialEq, Eq)]
	enum State {
		Idle,
		Find,
		Put,
	}
	fn close(state: &mut State, out: &mut Vec<String>) {
		match state {
			State::Find => out.extend(["</SM:FIND>".to_owned(), "</SM:EDIT>".to_owned()]),
			State::Put => out.extend(["</SM:PUT>".to_owned(), "</SM:EDIT>".to_owned()]),
			State::Idle => {},
		}
		*state = State::Idle;
	}
	let mut out = Vec::new();
	let mut state = State::Idle;
	for line in lines {
		if parse_opener(line).is_some() {
			close(&mut state, &mut out);
			out.push(
				if line.trim() == format!("{OPENER}*") {
					"<SM:EDIT all>"
				} else {
					"<SM:EDIT>"
				}
				.to_owned(),
			);
			out.push("<SM:FIND>".to_owned());
			state = State::Find;
		} else if line.trim() == REWRITE_HEADER && state == State::Find {
			out.push("</SM:FIND>".to_owned());
			out.push("<SM:PUT>".to_owned());
			state = State::Put;
		} else {
			out.push((*line).to_owned());
		}
	}
	close(&mut state, &mut out);
	out.join("\n")
}

/// Render one operation as a copy-ready sloppy payload.
pub fn operation_payload(
	operation: &Operation,
	target: &str,
	pattern_text: Option<&str>,
) -> String {
	let open = if target == "*" {
		"<SM:EDIT all>"
	} else {
		"<SM:EDIT>"
	};
	let pattern = operation_pattern(operation, pattern_text);
	match &operation.rewrite {
		OperationRewrite::Inline { .. } => {
			format!("{open}\n<SM:FIND>\n{pattern}\n</SM:FIND>\n</SM:EDIT>")
		},
		OperationRewrite::Explicit { text } => {
			let put = if text.is_empty() {
				"<SM:PUT></SM:PUT>".to_owned()
			} else {
				format!("<SM:PUT>\n{text}\n</SM:PUT>")
			};
			format!("{open}\n<SM:FIND>\n{pattern}\n</SM:FIND>\n{put}\n</SM:EDIT>")
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn marker_lines_keep_indentation() {
		assert_eq!(marker_line_content("  ＋value", ADD_LINE).as_deref(), Some("  value"));
		assert!(has_marker_lines("anchor\n  －old"));
	}

	#[test]
	fn xml_round_trip_to_ir() {
		let sections = split_sloppy_sections(
			"<SM:EDIT path=\"a.ts\" all>\n<SM:FIND>x</SM:FIND>\n<SM:PUT>y</SM:PUT>\n</SM:EDIT>",
		);
		assert_eq!(sections, vec![SloppySection {
			path: "a.ts".into(), body: "«*\nx\n»\ny".into()
		}]);
	}

	#[test]
	fn operation_payload_restores_inline_desired_text() {
		let operation = parse_operations("«\nconst \u{27ea}old\u{2502}new\u{27eb};", "const old;\n")
			.unwrap()
			.remove(0);
		assert_eq!(
			operation_payload(&operation, "*", None),
			"<SM:EDIT all>\n<SM:FIND>\nconst \u{27ea}old\u{2502}new\u{27eb};\n</SM:FIND>\n</SM:EDIT>"
		);
	}
}
