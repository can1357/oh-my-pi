//! Incremental reasoning-progress and stall detection.

use std::{
	collections::{BTreeSet, VecDeque},
	sync::LazyLock,
};

use omp_core::Str;
use regex::Regex;

use super::{
	RecoveryError, Stage,
	repetition::{
		LoopDisposition, LoopEvidence, LoopKind, LoopSignal, OutputVisibility, stable_hash,
	},
};

/// Bounds for reasoning stall detection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReasoningLimits {
	/// Consecutive equivalent deltas that declare a direct repetition loop.
	pub repeated_delta_limit:  u32,
	/// Substantial semantic segments required before similarity may declare a
	/// stall.
	pub no_progress_limit:     u32,
	/// Consecutive low-novelty, anchor-free segments that declare a
	/// progress-lexicon stall: reworded filler that recycles recent vocabulary
	/// and names nothing new. Calibrated against 536k real reasoning blocks
	/// (longest legitimate run observed: 7).
	pub low_novelty_run_limit: u32,
	/// Maximum retained normalized bytes per delta.
	pub max_delta_bytes:       usize,
}

impl Default for ReasoningLimits {
	fn default() -> Self {
		Self {
			repeated_delta_limit:  4,
			no_progress_limit:     12,
			low_novelty_run_limit: 8,
			max_delta_bytes:       16 * 1024,
		}
	}
}

/// Incremental input to the reasoning guard.
#[derive(Clone, Debug)]
pub struct ReasoningObservation<'a> {
	/// Reasoning text received in this increment.
	pub delta:             &'a str,
	/// An external semantic transition, such as producing answer text or a valid
	/// tool call.
	pub semantic_progress: bool,
	/// Current output visibility at the recovery boundary.
	pub visibility:        OutputVisibility,
}

/// Bounded state machine detecting direct repeats and semantically repetitive
/// reasoning segments.
///
/// Two semantic shapes are recognized over completed paragraphs: near-duplicate
/// segments (high word-trigram
/// overlap with cosmetic wording drift) and progress-lexicon stalls (segments
/// that keep reshuffling the recent vocabulary without naming any new concrete
/// reference, so trigrams never match yet nothing advances).
#[derive(Debug)]
pub struct ReasoningStallGuard {
	limits:          ReasoningLimits,
	last:            Option<(u64, Str)>,
	repeated:        u32,
	input_bytes:     u64,
	pending:         String,
	segments_seen:   u32,
	low_novelty_run: u32,
	segments:        VecDeque<SemanticSegment>,
}

#[derive(Debug)]
struct SemanticSegment {
	/// Word-trigram shingles of the normalized segment.
	shingles: BTreeSet<u64>,
	/// Hashed unigram vocabulary of the normalized segment.
	words:    BTreeSet<u64>,
	/// Hashed canonical concrete references (paths, identifiers, code spans).
	anchors:  BTreeSet<u64>,
}

const SEGMENT_CHAR_CAP: usize = 700;
const SEGMENT_MIN_NORMALIZED_BYTES: usize = 60;
const SEGMENT_WINDOW: usize = 16;
/// Recent segments whose pooled vocabulary and anchors form the novelty
/// baseline for progress-lexicon stall detection.
const LEX_NOVELTY_WINDOW: usize = 8;
/// Novelty (fraction of a segment's words unseen across the recent window) at
/// or below which a segment counts as recycling earlier wording: `1/5`.
const LEX_STALL_NOVELTY_FLOOR_RECIPROCAL: usize = 5;

/// A concrete reference the model is actually reasoning about: a code span, a
/// file extension or dotted member, a multi-segment path, or a
/// snake/camel/Pascal identifier. Bare digits, abbreviations, and decimals are
/// excluded so numbered or punctuated filler is not self-anchoring.
static CONCRETE_ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b",
	)
	.expect("concrete-anchor regex")
});

impl ReasoningStallGuard {
	/// Creates a reasoning guard with fixed memory bounds.
	pub const fn new(limits: ReasoningLimits) -> Self {
		Self {
			limits,
			last: None,
			repeated: 0,
			input_bytes: 0,
			pending: String::new(),
			segments_seen: 0,
			low_novelty_run: 0,
			segments: VecDeque::new(),
		}
	}

	/// Observes one delta and emits at most one stable loop decision.
	pub fn observe(&mut self, observation: ReasoningObservation<'_>) -> Option<LoopSignal> {
		self.input_bytes = self
			.input_bytes
			.saturating_add(observation.delta.len() as u64);
		if observation.semantic_progress {
			self.clear_progress_state();
			return None;
		}
		let direct = normalize_reasoning(observation.delta, self.limits.max_delta_bytes);
		let direct_signal = direct.and_then(|normalized| {
			let fingerprint = stable_hash(normalized.as_bytes());
			let exact_repeat = self.last.as_ref().is_some_and(|(previous_hash, previous)| {
				*previous_hash == fingerprint && previous.as_str() == normalized
			});
			self.repeated = if exact_repeat {
				self.repeated.saturating_add(1)
			} else {
				1
			};
			self.last = Some((fingerprint, Str::new(normalized)));
			(self.repeated >= self.limits.repeated_delta_limit).then_some((fingerprint, self.repeated))
		});
		if let Some((fingerprint, repetitions)) = direct_signal {
			return Some(self.signal(fingerprint, repetitions, observation.visibility));
		}
		self.pending.push_str(observation.delta);
		while let Some(end) = completed_segment_end(&self.pending) {
			let segment = self.pending.drain(..end).collect::<String>();
			trim_segment_separator(&mut self.pending);
			if let Some((fingerprint, repetitions)) = self.consume_segment(&segment) {
				return Some(self.signal(fingerprint, repetitions, observation.visibility));
			}
		}
		while self.pending.len() > SEGMENT_CHAR_CAP {
			let end = floor_char_boundary(&self.pending, SEGMENT_CHAR_CAP);
			let segment = self.pending.drain(..end).collect::<String>();
			if let Some((fingerprint, repetitions)) = self.consume_segment(&segment) {
				return Some(self.signal(fingerprint, repetitions, observation.visibility));
			}
		}
		None
	}

	fn consume_segment(&mut self, raw: &str) -> Option<(u64, u32)> {
		let normalized = normalize_semantic_segment(raw, self.limits.max_delta_bytes)?;
		if normalized.len() < SEGMENT_MIN_NORMALIZED_BYTES {
			return None;
		}
		let fingerprint = stable_hash(normalized.as_bytes());
		let shingles = trigram_shingles(&normalized);
		let cluster = self
			.segments
			.iter()
			.filter(|previous| semantic_similarity(&shingles, &previous.shingles))
			.count()
			.saturating_add(1) as u32;

		// Progress-lexicon stall: recycled recent vocabulary with no new concrete
		// reference. Only a *new* anchor breaks the run, so filler that keeps
		// name-dropping one fixed path or identifier is still caught while
		// genuine per-target work naming a fresh file or symbol is spared.
		let words = normalized
			.split(' ')
			.map(|word| stable_hash(word.as_bytes()))
			.collect::<BTreeSet<u64>>();
		let anchors = concrete_anchors(raw);
		let recent = || self.segments.iter().rev().take(LEX_NOVELTY_WINDOW);
		let unseen = words
			.iter()
			.filter(|word| recent().all(|previous| !previous.words.contains(word)))
			.count();
		let new_anchor = anchors
			.iter()
			.any(|anchor| recent().all(|previous| !previous.anchors.contains(anchor)));
		let low_novelty = recent().next().is_some()
			&& unseen.saturating_mul(LEX_STALL_NOVELTY_FLOOR_RECIPROCAL) <= words.len();
		self.low_novelty_run = if low_novelty && !new_anchor {
			self.low_novelty_run.saturating_add(1)
		} else {
			0
		};

		self.segments_seen = self.segments_seen.saturating_add(1);
		self
			.segments
			.push_back(SemanticSegment { shingles, words, anchors });
		while self.segments.len() > SEGMENT_WINDOW {
			self.segments.pop_front();
		}
		if self.segments_seen < self.limits.no_progress_limit {
			return None;
		}
		if cluster >= self.limits.repeated_delta_limit {
			return Some((fingerprint, cluster));
		}
		(self.low_novelty_run >= self.limits.low_novelty_run_limit)
			.then_some((fingerprint, self.low_novelty_run))
	}

	fn finish_semantic(&mut self, visibility: OutputVisibility) -> Option<LoopSignal> {
		if self.pending.is_empty() {
			return None;
		}
		let segment = std::mem::take(&mut self.pending);
		self
			.consume_segment(&segment)
			.map(|(fingerprint, repetitions)| self.signal(fingerprint, repetitions, visibility))
	}

	fn signal(
		&self,
		fingerprint: u64,
		repetitions: u32,
		visibility: OutputVisibility,
	) -> LoopSignal {
		LoopSignal {
			evidence:    LoopEvidence {
				kind: LoopKind::ReasoningStall,
				fingerprint,
				repetitions,
				input_bytes: self.input_bytes,
			},
			disposition: LoopDisposition::from(visibility),
		}
	}

	fn clear_progress_state(&mut self) {
		self.last = None;
		self.repeated = 0;
		self.pending.clear();
		self.segments_seen = 0;
		self.low_novelty_run = 0;
		self.segments.clear();
	}

	/// Clears attempt-local state while retaining configuration.
	pub fn reset(&mut self) {
		self.clear_progress_state();
		self.input_bytes = 0;
	}
}

fn normalize_reasoning(input: &str, limit: usize) -> Option<String> {
	let mut output = String::with_capacity(input.len().min(limit));
	for word in input.split_ascii_whitespace() {
		if !output.is_empty() {
			output.push(' ');
		}
		output.push_str(word);
		if output.len() > limit {
			return None;
		}
	}
	(!output.is_empty()).then_some(output)
}

fn normalize_semantic_segment(input: &str, limit: usize) -> Option<String> {
	let mut output = String::with_capacity(input.len().min(limit));
	for line in input.lines() {
		let line = line.trim();
		if line.starts_with('#') || is_emphasis_title(line) {
			continue;
		}
		for word in line
			.split(|character: char| !character.is_ascii_alphanumeric())
			.filter(|word| word.bytes().any(|byte| byte.is_ascii_alphabetic()))
		{
			if !output.is_empty() {
				output.push(' ');
			}
			output.extend(word.chars().flat_map(char::to_lowercase));
			if output.len() > limit {
				return None;
			}
		}
	}
	(!output.is_empty()).then_some(output)
}

/// Canonical concrete references in a raw segment, skipping title lines the
/// semantic normalizer also drops. Case-folded with code-span backticks removed
/// so `Foo`, Foo, and FOO are one anchor and cannot masquerade as "new".
fn concrete_anchors(raw: &str) -> BTreeSet<u64> {
	raw.lines()
		.map(str::trim)
		.filter(|line| !line.starts_with('#') && !is_emphasis_title(line))
		.flat_map(|line| CONCRETE_ANCHOR.find_iter(line))
		.map(|found| {
			let anchor = found
				.as_str()
				.chars()
				.filter(|character| *character != '`')
				.flat_map(char::to_lowercase)
				.collect::<String>();
			stable_hash(anchor.as_bytes())
		})
		.collect()
}

fn is_emphasis_title(line: &str) -> bool {
	(line.starts_with("**") && line.ends_with("**"))
		|| (line.starts_with("***") && line.ends_with("***"))
}

fn trigram_shingles(normalized: &str) -> BTreeSet<u64> {
	let words: Vec<_> = normalized.split(' ').collect();
	if words.len() < 3 {
		return std::iter::once(iter_shingle_hash(&words)).collect();
	}
	words.windows(3).map(iter_shingle_hash).collect()
}

fn iter_shingle_hash(words: &[&str]) -> u64 {
	let mut bytes = Vec::new();
	for word in words {
		bytes.extend_from_slice(word.as_bytes());
		bytes.push(0);
	}
	stable_hash(&bytes)
}

fn semantic_similarity(left: &BTreeSet<u64>, right: &BTreeSet<u64>) -> bool {
	if left.is_empty() || right.is_empty() {
		return false;
	}
	let intersection = left.intersection(right).count();
	let union = left
		.len()
		.saturating_add(right.len())
		.saturating_sub(intersection);
	intersection.saturating_mul(5) >= union.saturating_mul(4)
}

fn completed_segment_end(input: &str) -> Option<usize> {
	let bytes = input.as_bytes();
	for first in 0..bytes.len() {
		if bytes[first] != b'\n' {
			continue;
		}
		let mut next = first + 1;
		while next < bytes.len() && matches!(bytes[next], b' ' | b'\t' | b'\r') {
			next += 1;
		}
		if bytes.get(next) == Some(&b'\n') {
			return Some(first);
		}
	}
	None
}

fn trim_segment_separator(input: &mut String) {
	let amount = input
		.bytes()
		.take_while(|byte| byte.is_ascii_whitespace())
		.count();
	input.drain(..amount);
}

const fn floor_char_boundary(input: &str, mut end: usize) -> usize {
	while !input.is_char_boundary(end) {
		end -= 1;
	}
	end
}
impl<'a> Stage<ReasoningObservation<'a>, LoopSignal> for ReasoningStallGuard {
	fn push(
		&mut self,
		input: ReasoningObservation<'a>,
		emit: &mut dyn FnMut(LoopSignal),
	) -> Result<(), RecoveryError> {
		if let Some(signal) = self.observe(input) {
			emit(signal);
		}
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(LoopSignal)) -> Result<(), RecoveryError> {
		if let Some(signal) = self.finish_semantic(OutputVisibility::Gated) {
			emit(signal);
		}
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reasoning_stall_obeys_commit_boundary() {
		let limits = ReasoningLimits { repeated_delta_limit: 2, ..ReasoningLimits::default() };
		let mut guard = ReasoningStallGuard::new(limits);
		assert!(
			guard
				.observe(ReasoningObservation {
					delta:             "I should inspect",
					semantic_progress: false,
					visibility:        OutputVisibility::Gated,
				})
				.is_none()
		);
		let gated = guard
			.observe(ReasoningObservation {
				delta:             "I should inspect",
				semantic_progress: false,
				visibility:        OutputVisibility::Gated,
			})
			.unwrap();
		assert_eq!(gated.disposition, LoopDisposition::RetryEligible);
		guard.reset();
		guard.observe(ReasoningObservation {
			delta:             "again",
			semantic_progress: false,
			visibility:        OutputVisibility::Committed,
		});
		let committed = guard
			.observe(ReasoningObservation {
				delta:             "again",
				semantic_progress: false,
				visibility:        OutputVisibility::Committed,
			})
			.unwrap();
		assert_eq!(committed.disposition, LoopDisposition::SurfaceCommitted);
	}

	#[test]
	fn novel_reasoning_segments_do_not_trip_the_guard() {
		let limits = ReasoningLimits {
			repeated_delta_limit: 3,
			no_progress_limit: 4,
			..ReasoningLimits::default()
		};
		let mut guard = ReasoningStallGuard::new(limits);
		for paragraph in [
			"First I will compare the parser boundary with the documented contract and identify \
			 which invariant is currently violated.",
			"Next I will inspect the event projection order to determine whether committed output \
			 can overtake a recovered tool call.",
			"Then I will trace ownership through the session journal and verify that replay observes \
			 the same canonical arguments.",
			"Finally I will review resource limits and make sure incomplete buffers resolve \
			 deterministically when the stream finishes.",
			"A separate pass will check receipt evidence so every applied recovery remains \
			 attributable to the selected wire policy.",
		] {
			assert!(
				guard
					.observe(ReasoningObservation {
						delta:             &format!("{paragraph}\n\n"),
						semantic_progress: false,
						visibility:        OutputVisibility::Gated,
					})
					.is_none(),
				"novel reasoning must not be treated as a stall"
			);
		}
	}

	#[test]
	fn near_duplicate_segments_trip_by_trigram_cluster() {
		let limits = ReasoningLimits {
			repeated_delta_limit: 3,
			no_progress_limit: 4,
			..ReasoningLimits::default()
		};
		let mut guard = ReasoningStallGuard::new(limits);
		let mut signal = None;
		for suffix in ["carefully", "thoroughly", "diligently", "rigorously"] {
			signal = guard.observe(ReasoningObservation {
				delta:             &format!(
					"I am now checking the implementation to ensure the final result is safe complete \
					 correct and ready for delivery {suffix}.\n\n"
				),
				semantic_progress: false,
				visibility:        OutputVisibility::Gated,
			});
		}
		let signal = signal.expect("near-duplicate segments must terminate the stall");
		assert_eq!(signal.evidence.kind, LoopKind::ReasoningStall);
		assert_eq!(signal.evidence.repetitions, 4);
	}

	#[test]
	fn repetitive_semantic_segments_trip_after_bounded_evidence() {
		let limits = ReasoningLimits {
			repeated_delta_limit: 3,
			no_progress_limit: 4,
			low_novelty_run_limit: 3,
			..ReasoningLimits::default()
		};
		let mut guard = ReasoningStallGuard::new(limits);
		let paragraphs = [
			"I am now carefully checking the implementation to ensure the final result is safe \
			 complete correct and ready for delivery with every detail verified.",
			"I am now carefully checking the implementation to ensure the final result is safe \
			 complete correct and ready for delivery with all details verified.",
			"I am now carefully checking the implementation to ensure the final result is safe \
			 complete correct and ready for delivery while every detail is verified.",
			"I am now carefully checking the implementation to ensure the final result is safe \
			 complete correct and ready for delivery and each detail verified.",
		];
		let mut signal = None;
		for paragraph in paragraphs {
			signal = guard.observe(ReasoningObservation {
				delta:             &format!("{paragraph}\n\n"),
				semantic_progress: false,
				visibility:        OutputVisibility::Gated,
			});
		}
		let signal = signal.expect("repetitive semantic segments must terminate the stall");
		assert_eq!(signal.evidence.kind, LoopKind::ReasoningStall);
		assert_eq!(signal.disposition, LoopDisposition::RetryEligible);
		assert_eq!(signal.evidence.repetitions, 3, "three low-novelty segments follow the first");
	}

	#[test]
	fn a_new_concrete_anchor_resets_the_low_novelty_run() {
		let limits = ReasoningLimits {
			repeated_delta_limit: 3,
			no_progress_limit: 4,
			low_novelty_run_limit: 3,
			..ReasoningLimits::default()
		};
		let mut guard = ReasoningStallGuard::new(limits);
		let paragraphs = [
			"I am now carefully checking the implementation to ensure the final result is safe \
			 complete correct and ready for delivery with every detail verified.",
			"I am now carefully checking the implementation to ensure the final result is safe \
			 complete correct and ready for delivery with all details verified.",
			"I am now carefully checking the implementation in src/codec/schema.rs to ensure the \
			 final result is safe complete correct and ready for delivery.",
			"I am now carefully checking the implementation to ensure the final result is safe \
			 complete correct and ready for delivery and each detail verified.",
		];
		for paragraph in paragraphs {
			assert!(
				guard
					.observe(ReasoningObservation {
						delta:             &format!("{paragraph}\n\n"),
						semantic_progress: false,
						visibility:        OutputVisibility::Gated,
					})
					.is_none(),
				"a segment naming a fresh reference is real work, not a stall"
			);
		}
	}

	#[test]
	fn explicit_semantic_progress_breaks_the_stall() {
		let limits = ReasoningLimits { repeated_delta_limit: 2, ..ReasoningLimits::default() };
		let mut guard = ReasoningStallGuard::new(limits);
		guard.observe(ReasoningObservation {
			delta:             "same",
			semantic_progress: false,
			visibility:        OutputVisibility::Gated,
		});
		assert!(
			guard
				.observe(ReasoningObservation {
					delta:             "same",
					semantic_progress: true,
					visibility:        OutputVisibility::Gated,
				})
				.is_none()
		);
		assert!(
			guard
				.observe(ReasoningObservation {
					delta:             "same",
					semantic_progress: false,
					visibility:        OutputVisibility::Gated,
				})
				.is_none()
		);
	}
}
