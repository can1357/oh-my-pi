//! Deterministic within-attempt and cross-turn repetition guards.

use std::collections::VecDeque;

use omp_core::Str;
use serde_json::Value;

use super::{RecoveryError, Stage};
use crate::{
	call::OpaqueJson,
	id::ToolCallId,
	receipt::{ReasonId, RecoveryKind, RecoveryRecord},
};
const EXACT_TAIL_BYTES: usize = 4 * 1024;
const EXACT_MAX_PERIOD_BYTES: usize = 1024;
const EXACT_SCAN_STRIDE_BYTES: usize = 128;
const EXACT_SHORT_MAX_PERIOD_BYTES: usize = 60;
const EXACT_SHORT_MIN_REPEATED_BYTES: usize = 180;
const EXACT_LONG_MIN_REPEATED_BYTES: usize = 1024;

/// Recoverable HTTP/2 or idle-stream failure classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StreamRecoveryKind {
	/// Peer reset the HTTP/2 stream before ordinary output committed.
	Http2Reset,
	/// A successful handshake produced no decodable event within the watchdog.
	FirstEventStall,
	/// The stream stalled after tool results but before a new model event.
	PostToolIdleStall,
}

/// Classifies reset/stall evidence without inspecting provider names.
pub fn classify_stream_recovery(
	code: Option<&str>,
	committed: bool,
	saw_event: bool,
	pending_tool_results: bool,
) -> Option<StreamRecoveryKind> {
	if committed {
		return None;
	}
	if code.is_some_and(|code| {
		code.eq_ignore_ascii_case("NGHTTP2_INTERNAL_ERROR")
			|| code.eq_ignore_ascii_case("NGHTTP2_REFUSED_STREAM")
			|| code.eq_ignore_ascii_case("h2_reset")
	}) {
		return Some(StreamRecoveryKind::Http2Reset);
	}
	if !saw_event {
		return Some(StreamRecoveryKind::FirstEventStall);
	}
	pending_tool_results.then_some(StreamRecoveryKind::PostToolIdleStall)
}

/// Corrective prompt for a detected thinking loop.
pub const fn thinking_loop_redirect() -> Str {
	Str::new_static(
		"<system-interrupt reason=\"thinking_loop_detected\">Loop guard interrupted prior turn. \
		 Stop narrating intended actions; issue one concrete tool call, choose the most boring \
		 viable option, or finish now.</system-interrupt>",
	)
}
/// Corrective prompt injected before another turn in a repeated tool loop.
pub const fn tool_loop_redirect() -> Str {
	Str::new_static(
		"<system-interrupt reason=\"tool_loop_detected\">The same tool call and result repeated \
		 without textual progress. Do not issue that call again with equivalent arguments. Choose a \
		 different concrete action or finish with the available result.</system-interrupt>",
	)
}

/// Whether provisional output is still hidden from the consumer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputVisibility {
	/// Output is owned by a semantic gate and may be discarded safely.
	Gated,
	/// Ordinary output has reached the consumer.
	Committed,
}

/// Retry consequence of a detected loop.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoopDisposition {
	/// The gate may discard the attempt and semantic policy may retry it.
	RetryEligible,
	/// The committed partial response must surface as an error without retry.
	SurfaceCommitted,
}

impl From<OutputVisibility> for LoopDisposition {
	fn from(value: OutputVisibility) -> Self {
		match value {
			OutputVisibility::Gated => Self::RetryEligible,
			OutputVisibility::Committed => Self::SurfaceCommitted,
		}
	}
}

/// Stable loop category consumed by semantic and session layers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoopKind {
	/// The same output unit repeated within one provider attempt.
	WithinAttempt,
	/// Equivalent tool call/result observations recurred across committed turns.
	CrossTurnTool,
	/// Reasoning continued without semantic progress.
	ReasoningStall,
}

/// Bounded evidence accompanying a loop decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoopEvidence {
	/// Stable loop category.
	pub kind:        LoopKind,
	/// Stable non-secret fingerprint of the repeated unit.
	pub fingerprint: u64,
	/// Consecutive observations that established the loop.
	pub repetitions: u32,
	/// Total bytes examined for this decision.
	pub input_bytes: u64,
}

/// A loop detection and its required retry behavior.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoopSignal {
	/// Bounded deterministic evidence.
	pub evidence:    LoopEvidence,
	/// Whether retry remains legal.
	pub disposition: LoopDisposition,
}

/// Configuration for within-attempt repetition detection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RepetitionLimits {
	/// Consecutive equivalent units required to declare a loop.
	pub consecutive_limit: u32,
	/// Maximum normalized bytes retained for exact collision checking.
	pub max_unit_bytes:    usize,
	/// Maximum history entries retained.
	pub history_limit:     usize,
}

impl Default for RepetitionLimits {
	fn default() -> Self {
		Self { consecutive_limit: 4, max_unit_bytes: 16 * 1024, history_limit: 32 }
	}
}

#[derive(Clone, Debug)]
struct Unit {
	normalized:  Str,
	fingerprint: u64,
}

/// Detects repeated text, reasoning, or tool signatures during one attempt.
#[derive(Debug)]
pub struct AttemptRepetitionGuard {
	limits:           RepetitionLimits,
	history:          VecDeque<Unit>,
	consecutive:      u32,
	input_bytes:      u64,
	exact_tail:       Vec<u8>,
	exact_since_scan: usize,
}

impl AttemptRepetitionGuard {
	/// Creates a bounded guard.
	pub const fn new(limits: RepetitionLimits) -> Self {
		Self {
			limits,
			history: VecDeque::new(),
			consecutive: 0,
			input_bytes: 0,
			exact_tail: Vec::new(),
			exact_since_scan: 0,
		}
	}

	/// Observes one semantic output unit.
	pub fn observe(&mut self, unit: &str, visibility: OutputVisibility) -> Option<LoopSignal> {
		self.input_bytes = self.input_bytes.saturating_add(unit.len() as u64);
		if let Some(signal) = self.observe_exact(unit, visibility, false) {
			return Some(signal);
		}
		let normalized = normalize_unit(unit, self.limits.max_unit_bytes)?;
		let fingerprint = stable_hash(normalized.as_bytes());
		let repeated = self.history.back().is_some_and(|previous| {
			previous.fingerprint == fingerprint && previous.normalized.as_str() == normalized
		});
		self.consecutive = if repeated {
			self.consecutive.saturating_add(1)
		} else {
			1
		};
		self
			.history
			.push_back(Unit { normalized: Str::new(normalized), fingerprint });
		while self.history.len() > self.limits.history_limit {
			self.history.pop_front();
		}
		let cycle = repeated_cycle(&self.history, self.limits.consecutive_limit);
		let (repetitions, evidence_fingerprint) = cycle.unwrap_or((self.consecutive, fingerprint));
		(repetitions >= self.limits.consecutive_limit).then(|| LoopSignal {
			evidence:    LoopEvidence {
				kind: LoopKind::WithinAttempt,
				fingerprint: evidence_fingerprint,
				repetitions,
				input_bytes: self.input_bytes,
			},
			disposition: visibility.into(),
		})
	}

	/// Observes only byte-exact suffix cycles, independent of provider family or
	/// chunk boundaries.
	pub fn observe_exact_cycle(
		&mut self,
		unit: &str,
		visibility: OutputVisibility,
	) -> Option<LoopSignal> {
		self.input_bytes = self.input_bytes.saturating_add(unit.len() as u64);
		self.observe_exact(unit, visibility, false)
	}

	/// Forces the final exact-cycle scan when a stream ends before the cadence
	/// threshold.
	pub fn finish_exact_cycle(&self, visibility: OutputVisibility) -> Option<LoopSignal> {
		self.exact_signal(visibility)
	}

	fn observe_exact(
		&mut self,
		unit: &str,
		visibility: OutputVisibility,
		force: bool,
	) -> Option<LoopSignal> {
		push_exact_tail(&mut self.exact_tail, unit.as_bytes());
		self.exact_since_scan = self.exact_since_scan.saturating_add(unit.len());
		if !force
			&& self.exact_since_scan < EXACT_SCAN_STRIDE_BYTES
			&& unit.len() < EXACT_SCAN_STRIDE_BYTES
		{
			return None;
		}
		self.exact_since_scan = 0;
		self.exact_signal(visibility)
	}

	fn exact_signal(&self, visibility: OutputVisibility) -> Option<LoopSignal> {
		let (period, repetitions) = exact_suffix_cycle(&self.exact_tail)?;
		let unit = &self.exact_tail[self.exact_tail.len() - period..];
		Some(LoopSignal {
			evidence:    LoopEvidence {
				kind: LoopKind::WithinAttempt,
				fingerprint: stable_hash(unit),
				repetitions,
				input_bytes: self.input_bytes,
			},
			disposition: visibility.into(),
		})
	}

	/// Clears state before a new provider attempt.
	pub fn reset(&mut self) {
		self.history.clear();
		self.consecutive = 0;
		self.input_bytes = 0;
		self.exact_tail.clear();
		self.exact_since_scan = 0;
	}
}

impl<'a> Stage<(&'a str, OutputVisibility), LoopSignal> for AttemptRepetitionGuard {
	fn push(
		&mut self,
		(unit, visibility): (&'a str, OutputVisibility),
		emit: &mut dyn FnMut(LoopSignal),
	) -> Result<(), RecoveryError> {
		if let Some(signal) = self.observe(unit, visibility) {
			emit(signal);
		}
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(LoopSignal)) -> Result<(), RecoveryError> {
		Ok(())
	}
}

/// One authorized tool call plus its real caller-supplied result.
#[derive(Clone, Debug)]
pub struct ToolExchangeObservation {
	/// Authorized call identity; excluded from semantic equivalence.
	pub call_id:   ToolCallId,
	/// Declared tool name.
	pub name:      Str,
	/// Schema-valid call arguments.
	pub arguments: OpaqueJson,
	/// Caller-supplied tool result.
	pub result:    OpaqueJson,
	/// Whether the executor reported an error.
	pub is_error:  bool,
}

/// Cross-turn input recorded by session and consumed by semantic recovery.
#[derive(Clone, Debug, Default)]
pub struct TurnRecoveryObservation {
	/// Ordered authorized call/result exchanges committed in the turn.
	pub tool_exchanges:        Vec<ToolExchangeObservation>,
	/// Whether visible assistant output made progress besides repeated calls.
	pub made_textual_progress: bool,
}

/// Bounded cross-turn loop configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CrossTurnLimits {
	/// Equivalent consecutive turns required to stop the loop.
	pub consecutive_limit:   u32,
	/// Number of committed turn fingerprints retained.
	pub history_limit:       usize,
	/// Maximum canonical structural bytes retained per turn.
	pub max_canonical_bytes: usize,
}

impl Default for CrossTurnLimits {
	fn default() -> Self {
		Self { consecutive_limit: 3, history_limit: 16, max_canonical_bytes: 256 * 1024 }
	}
}

/// Detects repeated call/result cycles across committed session turns.
#[derive(Debug)]
pub struct CrossTurnLoopGuard {
	limits:  CrossTurnLimits,
	history: VecDeque<u64>,
	last:    Option<(u64, Vec<u8>, u32)>,
}

impl CrossTurnLoopGuard {
	/// Creates a cross-turn guard.
	pub const fn new(limits: CrossTurnLimits) -> Self {
		Self { limits, history: VecDeque::new(), last: None }
	}

	/// Consumes one committed turn observation.
	pub fn observe(&mut self, observation: &TurnRecoveryObservation) -> Option<LoopSignal> {
		if observation.made_textual_progress || observation.tool_exchanges.is_empty() {
			self.last = None;
			return None;
		}
		let (fingerprint, canonical) =
			fingerprint_turn(observation, self.limits.max_canonical_bytes)?;
		let repetitions = match self.last.as_ref() {
			Some((previous, previous_canonical, count))
				if *previous == fingerprint && previous_canonical == &canonical =>
			{
				count.saturating_add(1)
			},
			_ => 1,
		};
		let input_bytes = canonical.len() as u64;
		self.last = Some((fingerprint, canonical, repetitions));
		self.history.push_back(fingerprint);
		while self.history.len() > self.limits.history_limit {
			self.history.pop_front();
		}
		(repetitions >= self.limits.consecutive_limit).then_some(LoopSignal {
			evidence:    LoopEvidence {
				kind: LoopKind::CrossTurnTool,
				fingerprint,
				repetitions,
				input_bytes,
			},
			disposition: LoopDisposition::SurfaceCommitted,
		})
	}

	/// Returns retained fingerprints for append-only session persistence.
	pub fn fingerprints(&self) -> impl ExactSizeIterator<Item = u64> + '_ {
		self.history.iter().copied()
	}
}

impl Stage<TurnRecoveryObservation, LoopSignal> for CrossTurnLoopGuard {
	fn push(
		&mut self,
		observation: TurnRecoveryObservation,
		emit: &mut dyn FnMut(LoopSignal),
	) -> Result<(), RecoveryError> {
		if let Some(signal) = self.observe(&observation) {
			emit(signal);
		}
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(LoopSignal)) -> Result<(), RecoveryError> {
		Ok(())
	}
}

/// Converts a loop signal to bounded receipt evidence.
pub fn recovery_record(attempt: u32, signal: &LoopSignal) -> RecoveryRecord {
	let (kind, rule) = match signal.evidence.kind {
		LoopKind::WithinAttempt => (RecoveryKind::WithinAttemptRepetition, "loop.within-attempt"),
		LoopKind::CrossTurnTool => (RecoveryKind::CrossTurnToolLoop, "loop.cross-turn-tool"),
		LoopKind::ReasoningStall => (RecoveryKind::ReasoningStall, "loop.reasoning-stall"),
	};
	RecoveryRecord {
		attempt,
		kind,
		rule: ReasonId(Str::new(rule)),
		input_bytes: signal.evidence.input_bytes,
		steps: signal.evidence.repetitions,
	}
}

fn fingerprint_turn(observation: &TurnRecoveryObservation, limit: usize) -> Option<(u64, Vec<u8>)> {
	let mut encoded = Vec::with_capacity(limit.min(4096));
	for exchange in &observation.tool_exchanges {
		push_field(exchange.name.as_bytes(), &mut encoded, limit)?;
		write_canonical_value(exchange.arguments.as_value(), &mut encoded, limit)?;
		write_canonical_value(exchange.result.as_value(), &mut encoded, limit)?;
		push_bounded(&[u8::from(exchange.is_error)], &mut encoded, limit)?;
	}
	Some((stable_hash(&encoded), encoded))
}

fn write_canonical_value(value: &Value, output: &mut Vec<u8>, limit: usize) -> Option<()> {
	match value {
		Value::Null => push_bounded(b"n", output, limit),
		Value::Bool(value) => push_bounded(if *value { b"t" } else { b"f" }, output, limit),
		Value::Number(value) => {
			push_bounded(b"d", output, limit)?;
			push_field(value.to_string().as_bytes(), output, limit)
		},
		Value::String(value) => {
			push_bounded(b"s", output, limit)?;
			push_field(value.as_bytes(), output, limit)
		},
		Value::Array(values) => {
			push_bounded(b"a", output, limit)?;
			push_bounded(&(values.len() as u64).to_le_bytes(), output, limit)?;
			if output.len().saturating_add(values.len()) > limit {
				return None;
			}
			for value in values {
				write_canonical_value(value, output, limit)?;
			}
			Some(())
		},
		Value::Object(values) => {
			let mut keys: Vec<_> = values
				.keys()
				.filter(|key| !is_intent_metadata(key))
				.collect();
			keys.sort_unstable();
			push_bounded(b"o", output, limit)?;
			push_bounded(&(keys.len() as u64).to_le_bytes(), output, limit)?;
			let minimum_key_bytes = keys.len().checked_mul(8)?;
			if output.len().saturating_add(minimum_key_bytes) > limit {
				return None;
			}
			for key in keys {
				push_field(key.as_bytes(), output, limit)?;
				write_canonical_value(&values[key], output, limit)?;
			}
			Some(())
		},
	}
}

fn is_intent_metadata(key: &str) -> bool {
	matches!(key, "i" | "__intent")
}

fn push_field(bytes: &[u8], output: &mut Vec<u8>, limit: usize) -> Option<()> {
	push_bounded(&(bytes.len() as u64).to_le_bytes(), output, limit)?;
	push_bounded(bytes, output, limit)
}

fn push_bounded(bytes: &[u8], output: &mut Vec<u8>, limit: usize) -> Option<()> {
	(output.len().saturating_add(bytes.len()) <= limit).then(|| output.extend_from_slice(bytes))
}
fn repeated_cycle(history: &VecDeque<Unit>, threshold: u32) -> Option<(u32, u64)> {
	let length = history.len();
	for period in 1..=length / 2 {
		let mut repetitions = 1_u32;
		while (repetitions as usize + 1) * period <= length {
			let right_start = length - repetitions as usize * period;
			let left_start = right_start - period;
			let same = (0..period).all(|offset| {
				let left = history.get(left_start + offset).expect("index is bounded");
				let right = history.get(right_start + offset).expect("index is bounded");
				left.fingerprint == right.fingerprint && left.normalized == right.normalized
			});
			if !same {
				break;
			}
			repetitions += 1;
		}
		if repetitions >= threshold {
			let mut fingerprint = 0xcbf29ce484222325_u64;
			for offset in 0..period {
				let unit = history
					.get(length - period + offset)
					.expect("index is bounded");
				fingerprint ^= unit.fingerprint;
				fingerprint = fingerprint.wrapping_mul(0x100000001b3);
			}
			return Some((repetitions, fingerprint));
		}
	}
	None
}

fn push_exact_tail(tail: &mut Vec<u8>, delta: &[u8]) {
	if delta.len() >= EXACT_TAIL_BYTES {
		tail.clear();
		tail.extend_from_slice(&delta[delta.len() - EXACT_TAIL_BYTES..]);
		return;
	}
	let overflow = tail
		.len()
		.saturating_add(delta.len())
		.saturating_sub(EXACT_TAIL_BYTES);
	if overflow != 0 {
		tail.copy_within(overflow.., 0);
		tail.truncate(tail.len() - overflow);
	}
	tail.extend_from_slice(delta);
}

fn exact_suffix_cycle(tail: &[u8]) -> Option<(usize, u32)> {
	let max_period = EXACT_MAX_PERIOD_BYTES.min(tail.len() / 3);
	for period in 2..=max_period {
		let unit = &tail[tail.len() - period..];
		if !unit
			.iter()
			.any(|byte| byte.is_ascii_alphabetic() || !byte.is_ascii())
		{
			continue;
		}
		let mut repetitions = 1_usize;
		let mut end = tail.len() - period;
		while end >= period && &tail[end - period..end] == unit {
			repetitions += 1;
			end -= period;
		}
		let (minimum_repetitions, minimum_bytes) = if period <= EXACT_SHORT_MAX_PERIOD_BYTES {
			(4, EXACT_SHORT_MIN_REPEATED_BYTES)
		} else {
			(3, EXACT_LONG_MIN_REPEATED_BYTES)
		};
		if repetitions >= minimum_repetitions && period.saturating_mul(repetitions) >= minimum_bytes {
			return Some((period, repetitions as u32));
		}
	}
	None
}

fn normalize_unit(unit: &str, limit: usize) -> Option<String> {
	let mut normalized = String::with_capacity(unit.len().min(limit));
	for word in unit.split_ascii_whitespace() {
		if !normalized.is_empty() {
			normalized.push(' ');
		}
		normalized.push_str(word);
		if normalized.len() > limit {
			return None;
		}
	}
	(!normalized.is_empty()).then_some(normalized)
}

pub(crate) fn stable_hash(bytes: &[u8]) -> u64 {
	let mut hash = 0xcbf29ce484222325_u64;
	for byte in bytes {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x100000001b3);
	}
	hash
}

#[cfg(test)]
mod tests {
	use std::str;

	use omp_core::sf;
	use serde_json::json;

	use super::*;

	#[test]
	fn h2_reset_and_stalls_only_recover_before_commit() {
		assert_eq!(
			classify_stream_recovery(Some("NGHTTP2_REFUSED_STREAM"), false, false, false),
			Some(StreamRecoveryKind::Http2Reset)
		);
		assert_eq!(
			classify_stream_recovery(None, false, false, false),
			Some(StreamRecoveryKind::FirstEventStall)
		);
		assert_eq!(classify_stream_recovery(None, true, false, true), None);
		assert!(thinking_loop_redirect().contains("thinking_loop_detected"));
	}

	#[test]
	fn committed_loops_surface_and_gated_loops_may_retry() {
		let limits = RepetitionLimits { consecutive_limit: 2, ..RepetitionLimits::default() };
		let mut guard = AttemptRepetitionGuard::new(limits);
		assert!(guard.observe("same", OutputVisibility::Gated).is_none());
		assert_eq!(
			guard
				.observe(" same ", OutputVisibility::Gated)
				.unwrap()
				.disposition,
			LoopDisposition::RetryEligible
		);
		guard.reset();
		guard.observe("same", OutputVisibility::Committed);
		assert_eq!(
			guard
				.observe("same", OutputVisibility::Committed)
				.unwrap()
				.disposition,
			LoopDisposition::SurfaceCommitted
		);
	}

	#[test]
	fn repeated_multi_unit_cycle_is_detected() {
		let limits = RepetitionLimits { consecutive_limit: 3, ..RepetitionLimits::default() };
		let mut guard = AttemptRepetitionGuard::new(limits);
		for unit in ["alpha", "beta", "alpha", "beta", "alpha"] {
			assert!(guard.observe(unit, OutputVisibility::Gated).is_none());
		}
		assert!(guard.observe("beta", OutputVisibility::Gated).is_some());
	}

	#[test]
	fn long_exact_cycle_is_detected_across_token_sized_deltas() {
		const CYCLE: &str = "% shipped. 100% delivered. 100% verified. 100% validated. 100% \
		                     approved. 100% accepted. 100% merged. 100% deployed. 100% live. 100% \
		                     operational. 100% successful. 100% excellent. 100% perfect. 100% \
		                     final. 100% absolute. 100% total. 100% whole. 100% full. 100% entire. \
		                     100% complete. 100% done. 100% finished. 100";
		let runaway = format!("Healthy lead sentence. {}", CYCLE.repeat(6));
		let mut guard = AttemptRepetitionGuard::new(RepetitionLimits::default());
		let mut detected = None;
		for chunk in runaway.as_bytes().chunks(23) {
			let chunk = str::from_utf8(chunk).expect("ASCII fixture");
			if let Some(signal) = guard.observe(chunk, OutputVisibility::Gated) {
				detected = Some(signal);
				break;
			}
		}
		let signal = detected.expect("long exact response cycle must terminate");
		assert_eq!(signal.evidence.kind, LoopKind::WithinAttempt);
		assert_eq!(signal.disposition, LoopDisposition::RetryEligible);
	}

	#[test]
	fn semantic_json_order_does_not_hide_cross_turn_loop() {
		let limits = CrossTurnLimits { consecutive_limit: 2, ..CrossTurnLimits::default() };
		let make = |arguments| TurnRecoveryObservation {
			tool_exchanges:        vec![ToolExchangeObservation {
				call_id:   ToolCallId::new("ignored"),
				name:      sf!("search"),
				arguments: OpaqueJson::new(arguments),
				result:    OpaqueJson::new(json!({"ok":true})),
				is_error:  false,
			}],
			made_textual_progress: false,
		};
		let mut guard = CrossTurnLoopGuard::new(limits);
		assert!(guard.observe(&make(json!({"a":1,"b":2}))).is_none());
		assert_eq!(
			guard
				.observe(&make(json!({"b":2,"a":1})))
				.unwrap()
				.disposition,
			LoopDisposition::SurfaceCommitted
		);
	}

	#[test]
	fn intent_metadata_is_recursively_excluded_from_cross_turn_fingerprints() {
		let limits = CrossTurnLimits { consecutive_limit: 2, ..CrossTurnLimits::default() };
		let make = |arguments, result| TurnRecoveryObservation {
			tool_exchanges:        vec![ToolExchangeObservation {
				call_id:   ToolCallId::new("ignored"),
				name:      sf!("search"),
				arguments: OpaqueJson::new(arguments),
				result:    OpaqueJson::new(result),
				is_error:  false,
			}],
			made_textual_progress: false,
		};
		let first = make(
			json!({
				"query": "rust",
				"i": "Finding the first answer",
				"nested": {"value": 1, "__intent": "Inspecting one source"},
				"items": [{"value": 2, "i": "Reading the first item"}]
			}),
			json!({"ok": true, "details": {"i": "First receipt"}}),
		);
		let second = make(
			json!({
				"query": "rust",
				"i": "Trying a different stated purpose",
				"nested": {"value": 1, "__intent": "Inspecting another source"},
				"items": [{"value": 2, "i": "Reading another item"}]
			}),
			json!({"ok": true, "details": {"i": "Second receipt"}}),
		);
		let mut guard = CrossTurnLoopGuard::new(limits);
		assert!(guard.observe(&first).is_none());
		let signal = guard
			.observe(&second)
			.expect("intent-only differences must remain the same semantic exchange");
		assert_eq!(signal.evidence.kind, LoopKind::CrossTurnTool);
		assert_eq!(signal.evidence.repetitions, 2);
	}

	#[test]
	fn exact_cycle_completed_after_the_last_cadence_scan_is_caught_at_stream_end() {
		// The bounded scan cadence (every EXACT_SCAN_STRIDE_BYTES) can leave the
		// final repetitions unscanned when the stream ends; the forced final
		// check must still terminate the runaway.
		let unit: String = ('a'..='z').chain('A'..='S').collect();
		assert_eq!(unit.len(), 45);
		let prelude = "prelude prose, not looped: ";
		assert_eq!(prelude.len(), 27);
		let runaway = format!("{prelude}{}", unit.repeat(4));
		assert_eq!(runaway.len(), 207);
		let mut guard = AttemptRepetitionGuard::new(RepetitionLimits::default());
		for chunk in runaway.as_bytes().chunks(9) {
			let chunk = str::from_utf8(chunk).expect("ASCII fixture");
			assert!(
				guard
					.observe_exact_cycle(chunk, OutputVisibility::Gated)
					.is_none(),
				"cycle must not be detectable before it completes"
			);
		}
		let signal = guard
			.finish_exact_cycle(OutputVisibility::Gated)
			.expect("stream end must force one final exact scan");
		assert_eq!(signal.evidence.kind, LoopKind::WithinAttempt);
		assert_eq!(signal.evidence.repetitions, 4);
		assert_eq!(signal.disposition, LoopDisposition::RetryEligible);
	}

	#[test]
	fn digit_and_punctuation_cycles_are_legitimate_output() {
		// Runs of digits, whitespace, or punctuation are common in tabular, hex,
		// and numeric output; only units carrying a letter (or non-ASCII, e.g.
		// emoji) count as runaway cycles.
		let numeric = "0123456789".repeat(30);
		let mut guard = AttemptRepetitionGuard::new(RepetitionLimits::default());
		assert!(
			guard
				.observe_exact_cycle(&numeric, OutputVisibility::Gated)
				.is_none()
		);
		assert!(guard.finish_exact_cycle(OutputVisibility::Gated).is_none());

		let emoji = "\u{1F30A} ".repeat(120);
		let mut guard = AttemptRepetitionGuard::new(RepetitionLimits::default());
		assert!(
			guard
				.observe_exact_cycle(&emoji, OutputVisibility::Gated)
				.is_some(),
			"pictographic runaway must still be caught"
		);
	}
}
