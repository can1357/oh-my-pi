//! Incremental synthesis of leaked in-band reasoning blocks.

use std::mem;

use bytes::{Buf, Bytes, BytesMut};
use omp_catalog::{
	id::{ThinkingPolicyId, WirePolicyId},
	policy::LeakedThinkingHealer,
};
use omp_core::{Str, sf};

use super::{RecoveryError, Stage};
use crate::receipt::{ReasonId, RecoveryKind, RecoveryRecord};

#[derive(Clone, Copy, Debug)]
struct Pattern {
	id:                 &'static str,
	open:               &'static [u8],
	close:              &'static [u8],
	trim_final_newline: bool,
}

const THINK: Pattern = Pattern {
	id:                 "think",
	open:               b"<think>",
	close:              b"</think>",
	trim_final_newline: false,
};
const THINKING: Pattern = Pattern {
	id:                 "thinking",
	open:               b"<thinking>",
	close:              b"</thinking>",
	trim_final_newline: false,
};
const SCRATCHPAD: Pattern = Pattern {
	id:                 "scratchpad",
	open:               b"<scratchpad>",
	close:              b"</scratchpad>",
	trim_final_newline: false,
};
const FENCED: Pattern = Pattern {
	id:                 "fenced-thinking",
	open:               b"```thinking\n",
	close:              b"```",
	trim_final_newline: false,
};
const GEMINI: Pattern = Pattern {
	id:                 "gemini-thinking",
	open:               b"```thinking\n",
	close:              b"```",
	trim_final_newline: true,
};
const GEMMA: Pattern = Pattern {
	id:                 "gemma-thought",
	open:               b"<|channel>thought\n",
	close:              b"<channel|>",
	trim_final_newline: false,
};
const ANTHROPIC: Pattern = Pattern {
	id:                 "anthropic-thinking",
	open:               b"<antml:thinking>",
	close:              b"</antml:thinking>",
	trim_final_newline: false,
};
const HARMONY_LONG: Pattern = Pattern {
	id:                 "harmony-analysis",
	open:               b"<\x7cstart\x7c>assistant<\x7cchannel\x7c>analysis<\x7cmessage\x7c>",
	close:              b"<\x7cend\x7c>",
	trim_final_newline: false,
};
const HARMONY_SHORT: Pattern = Pattern {
	id:                 "harmony-analysis",
	open:               b"<\x7cchannel\x7c>analysis<\x7cmessage\x7c>",
	close:              b"<\x7cend\x7c>",
	trim_final_newline: false,
};

const GENERIC_PATTERNS: &[Pattern] = &[THINK, THINKING, SCRATCHPAD, FENCED];
const THINK_PATTERNS: &[Pattern] = &[THINK, THINKING, SCRATCHPAD, FENCED];
const KIMI_PATTERNS: &[Pattern] = &[THINK];
const DSML_PATTERNS: &[Pattern] = &[THINK];
const GEMINI_PATTERNS: &[Pattern] = &[GEMINI];
const ANTHROPIC_PATTERNS: &[Pattern] = &[ANTHROPIC, THINKING];
const GEMMA_PATTERNS: &[Pattern] = &[GEMMA];
const HARMONY_PATTERNS: &[Pattern] = &[HARMONY_LONG, HARMONY_SHORT];
const NO_PATTERNS: &[Pattern] = &[];

/// Catalog-selected in-band reasoning syntax.
///
/// This value is produced while lowering a catalog policy. It is never inferred
/// from provider or model names at request time.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DialectThinking {
	/// No dialect-specific reasoning envelope.
	#[default]
	None,
	/// Generic XML and common token envelopes.
	Generic,
	/// Anthropic owned-dialect reasoning tags.
	Anthropic,
	/// Gemini fenced reasoning.
	Gemini,
	/// Gemma thought-channel tokens.
	Gemma,
	/// Harmony analysis-channel tokens.
	Harmony,
}

/// Catalog evidence and limits for leaked-thinking synthesis.
#[derive(Clone, Debug)]
pub struct ThinkingRecoveryConfig {
	/// Interned wire policy which selected this stage.
	pub wire_policy:     WirePolicyId,
	/// Interned reasoning policy, when one exists.
	pub thinking_policy: Option<ThinkingPolicyId>,
	/// Catalog-selected generic healer.
	pub healer:          LeakedThinkingHealer,
	/// Catalog-selected dialect reasoning syntax.
	pub dialect:         DialectThinking,
	/// Attempt number written to recovery receipts.
	pub attempt:         u32,
	/// Maximum bytes retained for one reasoning block.
	pub max_block_bytes: usize,
}

/// Incremental output from leaked-thinking synthesis.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ThinkingEvent {
	/// Ordinary user-visible text.
	Text(Bytes),
	/// A synthesized canonical reasoning block began.
	ThinkingStart,
	/// Synthesized canonical reasoning content.
	ThinkingDelta(Bytes),
	/// The synthesized reasoning block ended.
	ThinkingEnd,
	/// Typed evidence for the synthesis action.
	RecoveryApplied {
		/// Interned wire policy which authorized recovery.
		wire_policy:     WirePolicyId,
		/// Interned reasoning policy which authorized classification.
		thinking_policy: Option<ThinkingPolicyId>,
		/// Receipt-ready recovery record.
		record:          RecoveryRecord,
	},
}

#[derive(Debug)]
enum State {
	Visible,
	Code { ticks: usize, fenced: bool },
	Thinking { pattern: Pattern, searched: usize, input_bytes: usize },
}

/// Incremental leaked-thinking classifier with bounded retention.
#[derive(Debug)]
pub struct LeakedThinkingStage {
	config:      ThinkingRecoveryConfig,
	patterns:    &'static [Pattern],
	buffer:      BytesMut,
	state:       State,
	line_indent: i16,
}

impl LeakedThinkingStage {
	/// Creates a stage from catalog policy, without inspecting a model name.
	pub fn new(config: ThinkingRecoveryConfig) -> Self {
		let patterns = match config.dialect {
			DialectThinking::Generic => GENERIC_PATTERNS,
			DialectThinking::Anthropic => ANTHROPIC_PATTERNS,
			DialectThinking::Gemini => GEMINI_PATTERNS,
			DialectThinking::Gemma => GEMMA_PATTERNS,
			DialectThinking::Harmony => HARMONY_PATTERNS,
			DialectThinking::None => match config.healer {
				LeakedThinkingHealer::None => NO_PATTERNS,
				LeakedThinkingHealer::Thinking => THINK_PATTERNS,
				LeakedThinkingHealer::Kimi => KIMI_PATTERNS,
				LeakedThinkingHealer::Dsml => DSML_PATTERNS,
				LeakedThinkingHealer::Qwen => NO_PATTERNS,
			},
		};
		Self { config, patterns, buffer: BytesMut::new(), state: State::Visible, line_indent: 0 }
	}

	fn consume(
		&mut self,
		final_chunk: bool,
		emit: &mut dyn FnMut(ThinkingEvent),
	) -> Result<(), RecoveryError> {
		loop {
			match &mut self.state {
				State::Thinking { pattern, searched, input_bytes } => {
					let start = searched.saturating_sub(pattern.close.len().saturating_sub(1));
					if let Some(relative) = find(&self.buffer[start..], pattern.close) {
						let at = start + relative;
						let emit_bytes = at.saturating_sub(usize::from(
							pattern.trim_final_newline
								&& self.buffer.get(at.wrapping_sub(1)) == Some(&b'\n'),
						));
						if emit_bytes != 0 {
							emit(ThinkingEvent::ThinkingDelta(self.buffer.split_to(emit_bytes).freeze()));
						}
						if at > emit_bytes {
							self.buffer.advance(at - emit_bytes);
						}
						self.buffer.advance(pattern.close.len());
						*input_bytes = input_bytes.saturating_add(at + pattern.close.len());
						if *input_bytes > self.config.max_block_bytes {
							return Err(RecoveryError::LimitExceeded {
								stage: "thinking",
								limit: self.config.max_block_bytes,
							});
						}
						let recovered_bytes = *input_bytes;
						let recovered_pattern = *pattern;
						emit(ThinkingEvent::ThinkingEnd);
						self.emit_recovery(recovered_pattern, recovered_bytes, emit);
						self.state = State::Visible;
						continue;
					}
					if input_bytes.saturating_add(self.buffer.len()) > self.config.max_block_bytes {
						return Err(RecoveryError::LimitExceeded {
							stage: "thinking",
							limit: self.config.max_block_bytes,
						});
					}
					if final_chunk {
						let amount = self.buffer.len();
						if amount != 0 {
							emit(ThinkingEvent::ThinkingDelta(self.buffer.split().freeze()));
						}
						*input_bytes = input_bytes.saturating_add(amount);
						let recovered_bytes = *input_bytes;
						let recovered_pattern = *pattern;
						emit(ThinkingEvent::ThinkingEnd);
						self.emit_recovery(recovered_pattern, recovered_bytes, emit);
						self.state = State::Visible;
						return Ok(());
					}
					let overlap = suffix_overlap(&self.buffer, pattern.close);
					let trim_hold = usize::from(
						pattern.trim_final_newline
							&& self
								.buffer
								.get(self.buffer.len().saturating_sub(overlap + 1))
								== Some(&b'\n'),
					);
					let hold = overlap.saturating_add(trim_hold);
					let amount = self.buffer.len().saturating_sub(hold);
					if amount != 0 {
						emit(ThinkingEvent::ThinkingDelta(self.buffer.split_to(amount).freeze()));
						*input_bytes = input_bytes.saturating_add(amount);
					}
					*searched = self.buffer.len();
					return Ok(());
				},
				State::Code { ticks, fenced } => {
					let ticks = *ticks;
					let fenced = *fenced;
					let valid = valid_prefix(&self.buffer, final_chunk)?;
					if fenced {
						if let Some(end) = fence_close_end(&self.buffer[..valid], ticks, final_chunk) {
							self.emit_text(end, emit);
							self.state = State::Visible;
							continue;
						}
						if final_chunk {
							self.emit_text(valid, emit);
							self.state = State::Visible;
							return Ok(());
						}
						if let Some(last_nl) =
							self.buffer[..valid].iter().rposition(|byte| *byte == b'\n')
						{
							self.emit_text(last_nl + 1, emit);
						}
						return Ok(());
					}
					if let Some(at) = exact_backtick_run(&self.buffer[..valid], ticks)
						&& (final_chunk || at + ticks < valid)
					{
						self.emit_text(at + ticks, emit);
						self.state = State::Visible;
						continue;
					}
					let hold = if final_chunk {
						0
					} else {
						trailing_backticks(&self.buffer[..valid])
					};
					self.emit_text(valid.saturating_sub(hold), emit);
					if final_chunk {
						self.state = State::Visible;
					}
					return Ok(());
				},
				State::Visible => {},
			}

			let valid = valid_prefix(&self.buffer, final_chunk)?;
			if valid == 0 {
				return Ok(());
			}
			match visible_hit(&self.buffer[..valid], self.patterns, final_chunk) {
				VisibleHit::None => {
					self.emit_text(valid, emit);
					return Ok(());
				},
				VisibleHit::Hold(at) => {
					self.emit_text(at, emit);
					return Ok(());
				},
				VisibleHit::Code { at, ticks } => {
					let fenced = ticks >= 3 && (0..=3).contains(&self.line_indent);
					self.emit_text(at + ticks, emit);
					self.state = State::Code { ticks, fenced };
				},
				VisibleHit::Tag { at, pattern } => {
					self.emit_text(at, emit);
					self.buffer.advance(pattern.open.len());
					emit(ThinkingEvent::ThinkingStart);
					self.state =
						State::Thinking { pattern, searched: 0, input_bytes: pattern.open.len() };
				},
			}
		}
	}

	fn emit_text(&mut self, amount: usize, emit: &mut dyn FnMut(ThinkingEvent)) {
		if amount == 0 {
			return;
		}
		let bytes = self.buffer.split_to(amount).freeze();
		self.line_indent = trailing_indent(&bytes, self.line_indent);
		emit(ThinkingEvent::Text(bytes));
	}

	fn emit_recovery(
		&self,
		pattern: Pattern,
		input_bytes: usize,
		emit: &mut dyn FnMut(ThinkingEvent),
	) {
		let thinking = self
			.config
			.thinking_policy
			.as_ref()
			.map_or("none", |policy| policy.as_str());
		let rule = ReasonId(sf!(
			"thinking-leak/{}/{thinking}/{}",
			self.config.wire_policy.as_str(),
			pattern.id
		));
		emit(ThinkingEvent::RecoveryApplied {
			wire_policy:     self.config.wire_policy.clone(),
			thinking_policy: self.config.thinking_policy.clone(),
			record:          RecoveryRecord {
				attempt: self.config.attempt,
				kind: RecoveryKind::ThinkingClassification,
				rule,
				input_bytes: input_bytes as u64,
				steps: 1,
			},
		});
	}
}

impl Stage<Bytes, ThinkingEvent> for LeakedThinkingStage {
	fn push(
		&mut self,
		input: Bytes,
		emit: &mut dyn FnMut(ThinkingEvent),
	) -> Result<(), RecoveryError> {
		self.buffer.extend_from_slice(&input);
		self.consume(false, emit)
	}

	fn finish(&mut self, emit: &mut dyn FnMut(ThinkingEvent)) -> Result<(), RecoveryError> {
		self.consume(true, emit)
	}
}

#[derive(Clone, Copy)]
enum VisibleHit {
	None,
	Hold(usize),
	Code { at: usize, ticks: usize },
	Tag { at: usize, pattern: Pattern },
}

fn visible_hit(buffer: &[u8], patterns: &[Pattern], final_chunk: bool) -> VisibleHit {
	let mut index = 0;
	while index < buffer.len() {
		for &pattern in patterns {
			if buffer[index..].starts_with(pattern.open) {
				return VisibleHit::Tag { at: index, pattern };
			}
			if !final_chunk
				&& pattern.open.len() > buffer.len() - index
				&& pattern.open.starts_with(&buffer[index..])
			{
				return VisibleHit::Hold(index);
			}
		}
		if buffer[index] == b'`' {
			let ticks = buffer[index..]
				.iter()
				.take_while(|byte| **byte == b'`')
				.count();
			if !final_chunk && index + ticks == buffer.len() {
				return VisibleHit::Hold(index);
			}
			return VisibleHit::Code { at: index, ticks };
		}
		index += 1;
	}
	VisibleHit::None
}
fn suffix_overlap(input: &[u8], tag: &[u8]) -> usize {
	let max = input.len().min(tag.len().saturating_sub(1));
	(1..=max)
		.rev()
		.find(|&length| input.ends_with(&tag[..length]))
		.unwrap_or(0)
}

fn valid_prefix(buffer: &[u8], final_chunk: bool) -> Result<usize, RecoveryError> {
	match Str::from_utf8(buffer) {
		Ok(_) => Ok(buffer.len()),
		Err(error) if error.error_len().is_none() && !final_chunk => Ok(error.valid_up_to()),
		Err(_) => Err(RecoveryError::InvalidInput {
			stage:  "thinking",
			reason: sf!("input is not valid UTF-8"),
		}),
	}
}
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	(haystack.len() >= needle.len())
		.then(|| {
			haystack
				.windows(needle.len())
				.position(|window| window == needle)
		})
		.flatten()
}
fn exact_backtick_run(buffer: &[u8], ticks: usize) -> Option<usize> {
	let mut index = 0;
	while index < buffer.len() {
		if buffer[index] != b'`' {
			index += 1;
			continue;
		}
		let run = buffer[index..]
			.iter()
			.take_while(|byte| **byte == b'`')
			.count();
		if run == ticks {
			return Some(index);
		}
		index += run;
	}
	None
}
fn trailing_backticks(buffer: &[u8]) -> usize {
	buffer
		.iter()
		.rev()
		.take_while(|byte| **byte == b'`')
		.count()
}
fn trailing_indent(text: &[u8], prior: i16) -> i16 {
	let start = text
		.iter()
		.rposition(|byte| *byte == b'\n')
		.map_or(0, |at| at + 1);
	if start == 0 && prior < 0 {
		return prior;
	}
	let line = &text[start..];
	if line.iter().all(|byte| *byte == b' ') {
		prior.max(0).saturating_add(line.len() as i16)
	} else {
		-1
	}
}
fn fence_close_end(buffer: &[u8], ticks: usize, final_chunk: bool) -> Option<usize> {
	let mut line_start = 0;
	while line_start < buffer.len() {
		let line_end = buffer[line_start..]
			.iter()
			.position(|byte| *byte == b'\n')
			.map_or(buffer.len(), |at| line_start + at + 1);
		if line_end == buffer.len() && !final_chunk {
			return None;
		}
		let line = &buffer[line_start..line_end];
		let indent = line.iter().take_while(|byte| **byte == b' ').count();
		if indent <= 3 {
			let rest = &line[indent..];
			let run = rest.iter().take_while(|byte| **byte == b'`').count();
			if run >= ticks && rest[run..].iter().all(|byte| byte.is_ascii_whitespace()) {
				return Some(line_end);
			}
		}
		line_start = line_end;
	}
	None
}

/// Strips standalone leaked reasoning-fence opener lines from structured
/// thinking deltas.
///
/// The visible-channel healers above split leaked ```` ```thinking ````
/// fences out of the *text* stream; they never run over parts a provider
/// already flags as thinking. Gemini thought summaries occasionally emit a
/// bare ```` ```thinking ```` / ```` ``````thinking ```` opener line as a
/// between-summary delimiter, which otherwise reaches display and
/// persisted transcripts verbatim as fence spam.
///
/// Only a *standalone* opener line — nothing but ≤3 lead spaces, a run of ≥3
/// backticks, and the info string `thinking` or `reasoning` — is dropped.
/// Language-tagged code fences, bare closers, and inline mentions pass
/// through so legitimate fenced code inside the reasoning survives.
///
/// Streaming-safe: deltas may split a line anywhere. A trailing partial line
/// is held only while it remains a viable opener prefix; every held line is
/// classified strictly on its newline or on [`ThinkingFenceStripper::flush`]
/// before it is dropped.
#[derive(Debug, Default)]
pub struct ThinkingFenceStripper {
	/// Buffered content of the current line still being classified.
	carry:       String,
	/// The current line is known not to be an opener; bytes pass through
	/// until its newline.
	passthrough: bool,
}

impl ThinkingFenceStripper {
	/// Consumes one thinking delta and returns the sanitized text to emit.
	pub fn push(&mut self, chunk: &str) -> String {
		let mut output = String::with_capacity(chunk.len());
		for character in chunk.chars() {
			if self.passthrough {
				output.push(character);
				if character == '\n' {
					self.passthrough = false;
				}
				continue;
			}
			if character == '\n' {
				if !is_fence_opener_line(&self.carry) {
					output.push_str(&self.carry);
					output.push('\n');
				}
				self.carry.clear();
				continue;
			}
			self.carry.push(character);
			if !could_be_fence_opener_prefix(&self.carry) {
				output.push_str(&self.carry);
				self.carry.clear();
				self.passthrough = true;
			}
		}
		output
	}

	/// Drains any held partial line at block end.
	pub fn flush(&mut self) -> String {
		self.passthrough = false;
		let carry = mem::take(&mut self.carry);
		if is_fence_opener_line(&carry) {
			String::new()
		} else {
			carry
		}
	}
}

/// Splits a candidate line into its backtick run and info-string remainder.
///
/// Returns `None` when more than three lead spaces or interior structure rule
/// the line out as a fence opener. Tolerates a trailing CR from a split CRLF.
fn fence_opener_parts(line: &str) -> Option<(usize, &str)> {
	let line = line.strip_suffix('\r').unwrap_or(line);
	let trimmed = line.trim_start_matches(' ');
	if line.len() - trimmed.len() > 3 {
		return None;
	}
	let rest = trimmed.trim_start_matches('`');
	Some((trimmed.len() - rest.len(), rest))
}

/// A complete standalone reasoning-fence opener line.
fn is_fence_opener_line(line: &str) -> bool {
	let Some((ticks, rest)) = fence_opener_parts(line) else {
		return false;
	};
	if ticks < 3 {
		return false;
	}
	let word = rest.trim_end_matches([' ', '\t']);
	word.eq_ignore_ascii_case("thinking") || word.eq_ignore_ascii_case("reasoning")
}

/// Whether a partial line could still grow into a standalone opener.
fn could_be_fence_opener_prefix(line: &str) -> bool {
	let Some((ticks, rest)) = fence_opener_parts(line) else {
		return false;
	};
	if rest.is_empty() {
		// Still consuming lead spaces or the backtick run.
		return true;
	}
	if ticks < 3 {
		return false;
	}
	let word = rest.trim_end_matches([' ', '\t']);
	if word.len() > "reasoning".len() {
		return false;
	}
	let lowered = word.to_ascii_lowercase();
	"thinking".starts_with(&lowered) || "reasoning".starts_with(&lowered)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn config(dialect: DialectThinking) -> ThinkingRecoveryConfig {
		ThinkingRecoveryConfig {
			wire_policy: WirePolicyId::new("wire"),
			thinking_policy: Some(ThinkingPolicyId::new("thought")),
			healer: LeakedThinkingHealer::None,
			dialect,
			attempt: 1,
			max_block_bytes: 1024,
		}
	}
	fn scan(
		input: &[u8],
		dialect: DialectThinking,
		split: usize,
	) -> (Vec<u8>, Vec<u8>, usize, usize, usize) {
		let mut stage = LeakedThinkingStage::new(config(dialect));
		let mut visible = Vec::new();
		let mut thinking = Vec::new();
		let mut starts = 0;
		let mut ends = 0;
		let mut recoveries = 0;
		let mut collect = |event| match event {
			ThinkingEvent::Text(bytes) => visible.extend_from_slice(&bytes),
			ThinkingEvent::ThinkingStart => starts += 1,
			ThinkingEvent::ThinkingDelta(bytes) => thinking.extend_from_slice(&bytes),
			ThinkingEvent::ThinkingEnd => ends += 1,
			ThinkingEvent::RecoveryApplied { .. } => recoveries += 1,
		};
		stage
			.push(Bytes::copy_from_slice(&input[..split]), &mut collect)
			.unwrap();
		stage
			.push(Bytes::copy_from_slice(&input[split..]), &mut collect)
			.unwrap();
		stage.finish(&mut collect).unwrap();
		(visible, thinking, starts, ends, recoveries)
	}

	#[test]
	fn gemma_and_gemini_are_split_invariant() {
		for (dialect, input) in [
			(DialectThinking::Gemma, b"<|channel>thought\nprivate<channel|>visible".as_slice()),
			(DialectThinking::Gemini, b"```thinking\nprivate\n```visible".as_slice()),
		] {
			let expected = scan(input, dialect, input.len());
			for split in 0..=input.len() {
				assert_eq!(scan(input, dialect, split), expected, "split {split}");
			}
		}
	}

	#[test]
	fn markdown_literals_are_not_classified() {
		let input = b"```md\n<think>literal</think>\n```\nafter";
		let (visible, thinking, starts, ends, recoveries) =
			scan(input, DialectThinking::Generic, input.len());
		assert_eq!(visible, input);
		assert!(thinking.is_empty());
		assert_eq!((starts, ends, recoveries), (0, 0, 0));
	}

	fn strip_whole(input: &str) -> String {
		let mut stripper = ThinkingFenceStripper::default();
		let mut output = stripper.push(input);
		output.push_str(&stripper.flush());
		output
	}

	#[test]
	fn standalone_thinking_fence_openers_are_dropped() {
		assert_eq!(strip_whole("```thinking\nplan first\n"), "plan first\n");
		assert_eq!(strip_whole("``````thinking\nplan\n"), "plan\n");
		assert_eq!(strip_whole("   ```REASONING \t\nplan\n"), "plan\n");
		assert_eq!(strip_whole("a\n```thinking\r\nb"), "a\nb");
		// An unterminated opener held at block end is dropped by flush.
		assert_eq!(strip_whole("plan\n```thinking"), "plan\n");
	}

	#[test]
	fn legitimate_fences_and_inline_mentions_survive() {
		assert_eq!(strip_whole("```rs\nfn main() {}\n```\n"), "```rs\nfn main() {}\n```\n");
		assert_eq!(strip_whole("```\nplain fence\n"), "```\nplain fence\n");
		assert_eq!(strip_whole("use ```thinking fences\n"), "use ```thinking fences\n");
		assert_eq!(strip_whole("```thinking more prose\n"), "```thinking more prose\n");
		assert_eq!(strip_whole("    ```thinking\n"), "    ```thinking\n");
	}

	#[test]
	fn fence_stripping_is_split_invariant() {
		let input = "intro\n```thinking\nplan\n```rs\ncode\n```\ntail";
		let expected = strip_whole(input);
		for split in 0..=input.len() {
			if !input.is_char_boundary(split) {
				continue;
			}
			let mut stripper = ThinkingFenceStripper::default();
			let mut output = stripper.push(&input[..split]);
			output.push_str(&stripper.push(&input[split..]));
			output.push_str(&stripper.flush());
			assert_eq!(output, expected, "split {split}");
		}
	}
}
