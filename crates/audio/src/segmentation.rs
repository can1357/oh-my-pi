//! Streaming Markdown-to-speech normalization and bounded segmentation.

use std::{mem, sync::LazyLock};

use omp_core::Str;
use regex::Regex;

const FIRST_SEGMENT_MIN: usize = 12;
const FIRST_CLAUSE_MIN: usize = 40;
const FIRST_FORCED_MAX: usize = 140;
const MIN_SEGMENT: usize = 24;
const SOFT_CLAUSE_LEN: usize = 160;
const MAX_SEGMENT: usize = 280;

static IMAGE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"!\[([^\]]*)\]\([^()]*(?:\([^()]*\)[^()]*)*\)").expect("image regex")
});
static LINK: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"\[([^\]]+)\]\([^()]*(?:\([^()]*\)[^()]*)*\)").expect("link regex")
});
static URL: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r#"(?i)\b(?:https?://|www\.)[^\s<>()\"'\]]+"#).expect("URL regex"));
static INLINE_CODE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"`{1,2}([^`]+)`{1,2}").expect("inline-code regex"));
static HTML: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"</?[A-Za-z][^<>]*>").expect("HTML regex"));
static PATH: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r#"(^|[\s(\"'`])((?:~|\.{1,2})?/?[\w.@+-]+(?:/[\w.@+-]+){2,}/?)"#)
		.expect("path regex")
});
static SPEAKABLE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]").expect("speakable regex"));

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BlockMode {
	LineStart,
	Prose,
	Swallow,
	Code,
}

/// Incremental transform from streamed assistant Markdown to speakable clauses.
#[derive(Debug)]
pub struct SpeakableStream {
	mode:          BlockMode,
	after_swallow: BlockMode,
	prefix:        String,
	fence:         [char; 3],
	code_line:     String,
	buffer:        String,
	spoke:         bool,
}

impl Default for SpeakableStream {
	fn default() -> Self {
		Self::new()
	}
}

impl SpeakableStream {
	/// Creates an empty stream.
	pub const fn new() -> Self {
		Self {
			mode:          BlockMode::LineStart,
			after_swallow: BlockMode::LineStart,
			prefix:        String::new(),
			fence:         ['`'; 3],
			code_line:     String::new(),
			buffer:        String::new(),
			spoke:         false,
		}
	}

	/// Consumes a raw streamed delta and returns every newly-ready segment.
	pub fn push(&mut self, delta: &str) -> Vec<Str> {
		let mut output = Vec::new();
		for ch in delta.chars() {
			self.consume(ch, &mut output);
		}
		self.extract(&mut output);
		output
	}

	/// Drains all remaining prose at message end.
	pub fn flush(&mut self) -> Vec<Str> {
		let mut output = Vec::new();
		if self.mode == BlockMode::LineStart && !self.prefix.is_empty() && !is_rule(&self.prefix) {
			self.buffer.push_str(&self.prefix);
		}
		self.prefix.clear();
		self.mode = BlockMode::LineStart;
		self.drain(&mut output);
		output
	}

	/// Drains a complete or substantial fragment while generation is idle.
	pub fn flush_idle(&mut self) -> Vec<Str> {
		let pending = self.buffer.trim_end();
		let complete = pending.chars().next_back().is_some_and(|ch| {
			matches!(ch, '.' | '?' | '!' | '…' | ')' | ']' | '"' | '\'' | '»' | '”' | '’')
		});
		if !complete && pending.chars().count() < MIN_SEGMENT {
			return Vec::new();
		}
		let mut output = Vec::new();
		self.drain(&mut output);
		output
	}

	fn consume(&mut self, ch: char, output: &mut Vec<Str>) {
		match self.mode {
			BlockMode::LineStart => self.consume_line_start(ch, output),
			BlockMode::Prose => {
				if ch == '\n' {
					self.hard_break(output);
				} else {
					self.buffer.push(ch);
				}
			},
			BlockMode::Swallow => {
				if ch == '\n' {
					self.mode = self.after_swallow;
				}
			},
			BlockMode::Code => self.consume_code(ch),
		}
	}

	fn consume_line_start(&mut self, ch: char, output: &mut Vec<Str>) {
		if ch == '\n' {
			if !self.prefix.is_empty() && !is_rule(&self.prefix) {
				self.buffer.push_str(&self.prefix);
			}
			self.prefix.clear();
			self.hard_break(output);
			return;
		}
		self.prefix.push(ch);
		match classify_prefix(&self.prefix) {
			PrefixDecision::Undecided => {},
			PrefixDecision::Prose => {
				self.buffer.push_str(&self.prefix);
				self.prefix.clear();
				self.mode = BlockMode::Prose;
			},
			PrefixDecision::Marker(number) => {
				if let Some(number) = number {
					use std::fmt::Write as _;
					let _ = write!(self.buffer, "{number}, ");
				}
				self.prefix.clear();
				self.mode = BlockMode::Prose;
			},
			PrefixDecision::Swallow => {
				self.prefix.clear();
				self.after_swallow = BlockMode::LineStart;
				self.mode = BlockMode::Swallow;
			},
			PrefixDecision::Fence(fence) => {
				self.fence = [fence; 3];
				self.prefix.clear();
				self.after_swallow = BlockMode::Code;
				self.mode = BlockMode::Swallow;
			},
		}
	}

	fn consume_code(&mut self, ch: char) {
		if ch == '\n' {
			let closing = self
				.code_line
				.trim_start()
				.starts_with(self.fence.iter().collect::<String>().as_str());
			self.code_line.clear();
			self.mode = if closing {
				BlockMode::LineStart
			} else {
				BlockMode::Code
			};
		} else if self.code_line.chars().count() < 3 {
			self.code_line.push(ch);
		}
	}

	fn hard_break(&mut self, output: &mut Vec<Str>) {
		self.extract(output);
		self.emit_buffer(output);
		self.mode = BlockMode::LineStart;
		self.prefix.clear();
	}

	fn extract(&mut self, output: &mut Vec<Str>) {
		loop {
			let length = self.buffer.chars().count();
			if length == 0 {
				break;
			}
			let cut = if self.spoke {
				find_sentence_cut(&self.buffer, MIN_SEGMENT)
					.or_else(|| {
						(length >= SOFT_CLAUSE_LEN)
							.then(|| last_clause_cut(&self.buffer, MIN_SEGMENT, SOFT_CLAUSE_LEN))
							.flatten()
					})
					.or_else(|| (length >= MAX_SEGMENT).then(|| forced_cut(&self.buffer, MAX_SEGMENT)))
			} else {
				find_sentence_cut(&self.buffer, FIRST_SEGMENT_MIN)
					.or_else(|| {
						(length >= FIRST_CLAUSE_MIN)
							.then(|| find_clause_cut(&self.buffer, FIRST_CLAUSE_MIN))
							.flatten()
					})
					.or_else(|| {
						(length >= FIRST_FORCED_MAX).then(|| forced_cut(&self.buffer, FIRST_FORCED_MAX))
					})
			};
			let Some(cut) = cut else { break };
			self.emit_prefix(cut, output);
		}
	}

	fn drain(&mut self, output: &mut Vec<Str>) {
		self.extract(output);
		self.emit_buffer(output);
	}

	fn emit_prefix(&mut self, byte_cut: usize, output: &mut Vec<Str>) {
		let tail = self.buffer.split_off(byte_cut.min(self.buffer.len()));
		let raw = mem::replace(&mut self.buffer, tail);
		self.emit(raw.as_str(), output);
	}

	fn emit_buffer(&mut self, output: &mut Vec<Str>) {
		let raw = mem::take(&mut self.buffer);
		self.emit(raw.as_str(), output);
	}

	fn emit(&mut self, raw: &str, output: &mut Vec<Str>) {
		let normalized = normalize_speakable(raw);
		if !normalized.is_empty() {
			self.spoke = true;
			output.push(Str::from(normalized));
		}
	}
}

#[derive(Clone, Copy)]
enum PrefixDecision {
	Undecided,
	Prose,
	Marker(Option<u16>),
	Swallow,
	Fence(char),
}

fn classify_prefix(prefix: &str) -> PrefixDecision {
	if prefix == "|" {
		return PrefixDecision::Swallow;
	}
	if prefix.starts_with("```") {
		return PrefixDecision::Fence('`');
	}
	if prefix.starts_with("~~~") {
		return PrefixDecision::Fence('~');
	}
	if heading_marker(prefix) || bullet_marker(prefix) {
		return PrefixDecision::Marker(None);
	}
	if let Some(number) = numbered_marker(prefix) {
		return PrefixDecision::Marker(Some(number));
	}
	if prefix.starts_with('>') && prefix.chars().any(char::is_whitespace) {
		return PrefixDecision::Marker(None);
	}
	if undecided_prefix(prefix) {
		PrefixDecision::Undecided
	} else {
		PrefixDecision::Prose
	}
}

fn heading_marker(prefix: &str) -> bool {
	let hashes = prefix.chars().take_while(|ch| *ch == '#').count();
	(1..=6).contains(&hashes) && prefix.chars().nth(hashes).is_some_and(char::is_whitespace)
}

fn bullet_marker(prefix: &str) -> bool {
	let mut chars = prefix.chars();
	matches!(chars.next(), Some('-' | '*' | '+')) && chars.next().is_some_and(char::is_whitespace)
}

fn numbered_marker(prefix: &str) -> Option<u16> {
	let digits = prefix.chars().take_while(char::is_ascii_digit).count();
	if !(1..=3).contains(&digits) {
		return None;
	}
	let mut rest = prefix[digits..].chars();
	if matches!(rest.next(), Some('.' | ')')) && rest.next().is_some_and(char::is_whitespace) {
		prefix[..digits].parse().ok()
	} else {
		None
	}
}

fn undecided_prefix(prefix: &str) -> bool {
	let trimmed = prefix.trim_end_matches(char::is_whitespace);
	if trimmed.len() != prefix.len() {
		return false;
	}
	let chars = trimmed.chars().count();
	trimmed.chars().all(|ch| ch == '#') && chars <= 6
		|| matches!(trimmed, "-" | "*" | "+" | "--" | "**" | "__" | "`" | "``" | "~" | "~~")
		|| trimmed.chars().all(|character| character.is_ascii_digit()) && chars <= 3
		|| (chars <= 4
			&& trimmed.strip_suffix(['.', ')']).is_some_and(|value| {
				!value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
			})) || trimmed.chars().all(|ch| ch == '>')
}

fn is_rule(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.chars().count() >= 3
		&& (trimmed.chars().all(|ch| ch == '-')
			|| trimmed.chars().all(|ch| ch == '*')
			|| trimmed.chars().all(|ch| ch == '_'))
}

/// Normalizes one complete Markdown fragment without segmenting it.
pub fn normalize_speakable(raw: &str) -> String {
	let value = IMAGE.replace_all(raw, "$1");
	let value = LINK.replace_all(&value, "$1");
	let value = URL.replace_all(&value, |captures: &regex::Captures<'_>| {
		let url = captures.get(0).map_or("", |matched| matched.as_str());
		let without_scheme = url
			.split_once("://")
			.map_or(url, |(_, remainder)| remainder)
			.strip_prefix("www.")
			.unwrap_or_else(|| {
				url.split_once("://")
					.map_or(url, |(_, remainder)| remainder)
			});
		without_scheme
			.split(['/', '?', '#'])
			.next()
			.unwrap_or(without_scheme)
			.to_owned()
	});
	let value = INLINE_CODE.replace_all(&value, "$1");
	let value = HTML.replace_all(&value, " ");
	let value = PATH.replace_all(&value, |captures: &regex::Captures<'_>| {
		let lead = captures.get(1).map_or("", |matched| matched.as_str());
		let path = captures.get(2).map_or("", |matched| matched.as_str());
		let basename = path
			.trim_end_matches('/')
			.rsplit('/')
			.next()
			.unwrap_or(path);
		format!("{lead}{basename}")
	});
	let mut output = String::with_capacity(value.len());
	let mut whitespace = false;
	for ch in value.chars() {
		if ch.is_whitespace() {
			whitespace = true;
			continue;
		}
		if whitespace && !output.is_empty() {
			output.push(' ');
		}
		whitespace = false;
		if !matches!(ch, '*' | '_' | '~' | '`') {
			output.push(ch);
		}
	}
	let output = output.trim().to_owned();
	if SPEAKABLE.is_match(&output) {
		output
	} else {
		String::new()
	}
}

fn find_sentence_cut(text: &str, minimum_chars: usize) -> Option<usize> {
	let mut chars = 0;
	let mut ticks = 0;
	let mut candidate = None;
	for (index, ch) in text.char_indices() {
		chars += 1;
		if ch == '`' {
			ticks += 1;
		}
		if matches!(ch, '.' | '?' | '!' | '…') && chars >= minimum_chars && ticks % 2 == 0 {
			candidate = Some(index + ch.len_utf8());
			continue;
		}
		if candidate.is_some() && ch.is_whitespace() {
			let cut = index + ch.len_utf8();
			if !is_abbreviation(text[..index].trim_end()) {
				return Some(cut);
			}
			candidate = None;
		}
	}
	None
}

fn is_abbreviation(head: &str) -> bool {
	let last = head.split_whitespace().next_back().unwrap_or_default();
	matches!(
		last.to_ascii_lowercase().as_str(),
		"e.g." | "i.e." | "etc." | "vs." | "mr." | "mrs." | "ms." | "dr." | "st." | "no."
	)
}

fn find_clause_cut(text: &str, minimum_chars: usize) -> Option<usize> {
	let mut chars = 0;
	let mut candidate = None;
	for (index, ch) in text.char_indices() {
		chars += 1;
		if matches!(ch, ',' | ';' | ':' | '—' | '–') && chars >= minimum_chars {
			candidate = Some(index + ch.len_utf8());
		} else if candidate.is_some() && ch.is_whitespace() {
			return Some(index + ch.len_utf8());
		}
	}
	None
}

fn last_clause_cut(text: &str, minimum_chars: usize, maximum_chars: usize) -> Option<usize> {
	let mut best = None;
	let mut chars = 0;
	let mut punctuation = None;
	for (index, ch) in text.char_indices() {
		chars += 1;
		if chars > maximum_chars {
			break;
		}
		if matches!(ch, ',' | ';' | ':' | '—' | '–') && chars >= minimum_chars {
			punctuation = Some(index + ch.len_utf8());
		} else if punctuation.is_some() && ch.is_whitespace() {
			best = Some(index + ch.len_utf8());
			punctuation = None;
		}
	}
	best
}

fn forced_cut(text: &str, maximum_chars: usize) -> usize {
	let boundary = text
		.char_indices()
		.nth(maximum_chars)
		.map_or(text.len(), |(index, _)| index);
	text[..boundary]
		.char_indices()
		.rev()
		.find_map(|(index, ch)| ch.is_whitespace().then_some(index + ch.len_utf8()))
		.filter(|cut| *cut > 0)
		.unwrap_or(boundary)
}
