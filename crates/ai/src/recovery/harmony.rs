//! Bounded whole-attempt repair and detection for leaked Harmony channels.
//!
//! Harmony mitigation is intentionally catalog-selected. The stage accepts
//! only complete, exactly framed `analysis` and `final` channel messages as
//! repairable. Unframed control tokens and fused plain-text routing signals
//! reject the provisional attempt instead of guessing where content ends.

use std::collections::{BTreeMap, BTreeSet};

use omp_catalog::id::WirePolicyId;
use omp_core::{Str, sf};

use crate::{
	event::{BlockKind, ChatEvent},
	receipt::{ReasonId, RecoveryKind, RecoveryRecord},
};

const END: &str = "<|end|>";
const CONTROL_TOKENS: &[&str] =
	&["<|start|>", "<|end|>", "<|channel|>", "<|message|>", "<|call|>", "<|return|>"];
const HEADERS: &[(&str, BlockKind, &str)] = &[
	("<|start|>assistant<|channel|>analysis<|message|>", BlockKind::Thinking, "analysis"),
	("<|channel|>analysis<|message|>", BlockKind::Thinking, "analysis"),
	("<|start|>assistant<|channel|>final<|message|>", BlockKind::Text, "final"),
	("<|channel|>final<|message|>", BlockKind::Text, "final"),
];

/// A provable Harmony leak which cannot be repaired without inventing a
/// boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HarmonyLeak {
	/// Receipt-ready typed evidence for the rejected attempt.
	pub recovery: RecoveryRecord,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Segment {
	kind: BlockKind,
	text: Str,
}

#[derive(Clone, Debug)]
struct Repair {
	segments: Vec<Segment>,
	records:  Vec<RecoveryRecord>,
}

/// Normalizes exactly framed Harmony channels in a complete provisional
/// attempt, preserving every byte outside proven protocol envelopes.
///
/// The caller must keep the attempt behind a whole-attempt visibility gate.
/// Returning [`HarmonyLeak`] means the provisional events must be discarded
/// and the provider attempt may be retried.
pub fn normalize_attempt(
	events: Vec<ChatEvent>,
	wire_policy: &WirePolicyId<str>,
	attempt: u32,
) -> Result<(Vec<ChatEvent>, Vec<RecoveryRecord>), HarmonyLeak> {
	let mut text = BTreeMap::<u32, String>::new();
	let mut thinking = BTreeMap::<u32, String>::new();
	let mut kinds = BTreeMap::<u32, BlockKind>::new();
	for event in &events {
		match event {
			ChatEvent::BlockStarted { index, kind } => {
				kinds.insert(*index, *kind);
			},
			ChatEvent::TextDelta { index, text: delta } => {
				text.entry(*index).or_default().push_str(delta.as_str());
			},
			ChatEvent::ThinkingDelta { index, text: delta } => {
				thinking.entry(*index).or_default().push_str(delta.as_str());
			},
			_ => {},
		}
	}

	for content in thinking.values() {
		if let Some(rule) = detect_unrepairable(content) {
			return Err(leak_record(wire_policy, attempt, rule, content.len()));
		}
	}

	let mut repairs = BTreeMap::<u32, Repair>::new();
	for (index, content) in &text {
		if let Some(repair) = normalize_text(content, wire_policy, attempt)? {
			repairs.insert(*index, repair);
		}
	}
	if repairs.is_empty() {
		return Ok((events, Vec::new()));
	}

	let mut indexes = BTreeSet::new();
	indexes.extend(kinds.keys().copied());
	indexes.extend(text.keys().copied());
	for event in &events {
		if let Some(index) = event_index(event) {
			indexes.insert(index);
		}
	}
	let mut remap = BTreeMap::<u32, (u32, u32)>::new();
	let mut next = 0_u32;
	for index in indexes {
		let count = repairs.get(&index).map_or(1, |repair| {
			u32::try_from(repair.segments.len())
				.unwrap_or(u32::MAX)
				.max(1)
		});
		remap.insert(index, (next, count));
		next = next.saturating_add(count);
	}
	drop(text);
	drop(thinking);
	drop(kinds);

	let mut emitted_repairs = BTreeSet::new();
	let mut output = Vec::with_capacity(events.len().saturating_add(repairs.len()));
	let mut records = Vec::new();
	for event in events {
		match event {
			ChatEvent::BlockStarted { index, kind: BlockKind::Text }
				if repairs.contains_key(&index) =>
			{
				emit_repair(index, &repairs, &remap, &mut emitted_repairs, &mut output, &mut records);
			},
			ChatEvent::TextDelta { index, .. } if repairs.contains_key(&index) => {
				emit_repair(index, &repairs, &remap, &mut emitted_repairs, &mut output, &mut records);
			},
			ChatEvent::BlockStarted { index, kind } => {
				output.push(ChatEvent::BlockStarted { index: remapped(index, &remap), kind });
			},
			ChatEvent::TextDelta { index, text } => {
				output.push(ChatEvent::TextDelta { index: remapped(index, &remap), text });
			},
			ChatEvent::ThinkingDelta { index, text } => {
				output.push(ChatEvent::ThinkingDelta { index: remapped(index, &remap), text });
			},
			ChatEvent::ToolCallStarted { index, id, name } => {
				output.push(ChatEvent::ToolCallStarted { index: remapped(index, &remap), id, name });
			},
			ChatEvent::ToolArgumentsDelta { index, bytes } => {
				output.push(ChatEvent::ToolArgumentsDelta { index: remapped(index, &remap), bytes });
			},
			ChatEvent::ToolCallReady { index, call } => {
				output.push(ChatEvent::ToolCallReady { index: remapped(index, &remap), call });
			},
			ChatEvent::Artifact { index, artifact } => {
				output.push(ChatEvent::Artifact { index: remapped(index, &remap), artifact });
			},
			ChatEvent::Completed(mut completion) => {
				completion.blocks = next;
				output.push(ChatEvent::Completed(completion));
			},
			event => output.push(event),
		}
	}
	Ok((output, records))
}

fn emit_repair(
	index: u32,
	repairs: &BTreeMap<u32, Repair>,
	remap: &BTreeMap<u32, (u32, u32)>,
	emitted: &mut BTreeSet<u32>,
	output: &mut Vec<ChatEvent>,
	records: &mut Vec<RecoveryRecord>,
) {
	if !emitted.insert(index) {
		return;
	}
	let Some(repair) = repairs.get(&index) else {
		return;
	};
	let base = remapped(index, remap);
	for (offset, segment) in repair.segments.iter().enumerate() {
		let mapped = base.saturating_add(u32::try_from(offset).unwrap_or(u32::MAX));
		output.push(ChatEvent::BlockStarted { index: mapped, kind: segment.kind });
		if segment.text.is_empty() {
			continue;
		}
		match segment.kind {
			BlockKind::Text => {
				output.push(ChatEvent::TextDelta { index: mapped, text: segment.text.clone() });
			},
			BlockKind::Thinking => {
				output.push(ChatEvent::ThinkingDelta { index: mapped, text: segment.text.clone() });
			},
			BlockKind::ToolCall | BlockKind::Artifact => {},
		}
	}
	records.extend(repair.records.iter().cloned());
}

fn normalize_text(
	input: &str,
	wire_policy: &WirePolicyId<str>,
	attempt: u32,
) -> Result<Option<Repair>, HarmonyLeak> {
	let fences = fence_ranges(input);
	let mut cursor = 0;
	let mut segments = Vec::new();
	let mut records = Vec::new();
	while let Some((at, header, kind, channel)) = next_header(input, cursor, &fences) {
		push_segment(&mut segments, BlockKind::Text, &input[cursor..at]);
		let body_start = at + header.len();
		let Some(relative_end) = input[body_start..].find(END) else {
			return Err(leak_record(
				wire_policy,
				attempt,
				"unterminated-channel",
				input.len().saturating_sub(at),
			));
		};
		let body_end = body_start + relative_end;
		if inside_fence(&fences, body_end) {
			return Err(leak_record(
				wire_policy,
				attempt,
				"ambiguous-channel-boundary",
				input.len().saturating_sub(at),
			));
		}
		push_segment(&mut segments, kind, &input[body_start..body_end]);
		let consumed = body_end + END.len() - at;
		records.push(RecoveryRecord {
			attempt,
			kind: RecoveryKind::HarmonyLeakRepair,
			rule: ReasonId(sf!("harmony/{}/{channel}", wire_policy.as_str())),
			input_bytes: consumed as u64,
			steps: 1,
		});
		cursor = body_end + END.len();
	}
	push_segment(&mut segments, BlockKind::Text, &input[cursor..]);
	if records.is_empty() {
		if let Some(rule) = detect_unrepairable(input) {
			return Err(leak_record(wire_policy, attempt, rule, input.len()));
		}
		return Ok(None);
	}
	for segment in &segments {
		if let Some(rule) = detect_unrepairable(segment.text.as_str()) {
			return Err(leak_record(wire_policy, attempt, rule, segment.text.len()));
		}
	}
	if segments.is_empty() {
		segments.push(Segment { kind: BlockKind::Text, text: Str::new_static("") });
	}
	Ok(Some(Repair { segments, records }))
}

fn push_segment(segments: &mut Vec<Segment>, kind: BlockKind, text: &str) {
	if text.is_empty() {
		return;
	}
	if let Some(last) = segments.last_mut()
		&& last.kind == kind
	{
		let mut joined = String::with_capacity(last.text.len().saturating_add(text.len()));
		joined.push_str(last.text.as_str());
		joined.push_str(text);
		last.text = Str::new(joined);
		return;
	}
	segments.push(Segment { kind, text: Str::new(text) });
}

fn next_header(
	input: &str,
	from: usize,
	fences: &[(usize, usize)],
) -> Option<(usize, &'static str, BlockKind, &'static str)> {
	let mut best: Option<(usize, &'static str, BlockKind, &'static str)> = None;
	for &(header, kind, channel) in HEADERS {
		let mut search = from;
		while let Some(relative) = input[search..].find(header) {
			let at = search + relative;
			if !inside_fence(fences, at) {
				if best.as_ref().is_none_or(|(prior, ..)| at < *prior) {
					best = Some((at, header, kind, channel));
				}
				break;
			}
			search = at + header.len();
		}
	}
	best
}

fn detect_unrepairable(input: &str) -> Option<&'static str> {
	let fences = fence_ranges(input);
	for token in CONTROL_TOKENS {
		let mut search = 0;
		while let Some(relative) = input[search..].find(token) {
			let at = search + relative;
			if !inside_fence(&fences, at) {
				return Some("unframed-control-token");
			}
			search = at + token.len();
		}
	}
	let mut search = 0;
	while let Some(relative) = input[search..].find("to=functions.") {
		let at = search + relative;
		if !inside_fence(&fences, at) && marker_name_end(input, at).is_some() {
			let mut before_start = at.saturating_sub(64);
			while !input.is_char_boundary(before_start) {
				before_start += 1;
			}
			let mut after_end = input.len().min(at.saturating_add(240));
			while !input.is_char_boundary(after_end) {
				after_end -= 1;
			}
			let before = &input[before_start..at];
			let after = &input[at..after_end];
			let channel = before
				.split_ascii_whitespace()
				.next_back()
				.is_some_and(|word| {
					matches!(
						word,
						"analysis"
							| "commentary" | "final"
							| "assistant" | "user"
							| "system" | "developer"
							| "tool"
					)
				});
			let glitch = before.ends_with("changedFiles ")
				|| before.ends_with("RTLU ")
				|| before.ends_with("Jsii ")
				|| before.ends_with("Jsii_commentary ")
				|| before.ends_with("Japgolly ");
			let cascade = after
				.find(" code")
				.is_some_and(|code| after[code.saturating_add(5)..].contains("to=functions."));
			let fake_result = after
				.find("code_output")
				.is_some_and(|code| after[code..].contains("\nCell "));
			if channel || glitch || cascade || fake_result {
				return Some("shadow-routing-signal");
			}
		}
		search = at + "to=functions.".len();
	}
	None
}

fn marker_name_end(input: &str, at: usize) -> Option<usize> {
	let start = at + "to=functions.".len();
	let mut chars = input[start..].char_indices();
	let (_, first) = chars.next()?;
	if !(first == '_' || first.is_ascii_alphabetic()) {
		return None;
	}
	let mut end = start + first.len_utf8();
	for (offset, character) in chars {
		if !(character == '_' || character.is_ascii_alphanumeric()) {
			break;
		}
		end = start + offset + character.len_utf8();
	}
	Some(end)
}

fn fence_ranges(input: &str) -> Vec<(usize, usize)> {
	let mut ranges = Vec::new();
	let mut open = None;
	let mut line_start = 0;
	while line_start <= input.len() {
		let line_end = input[line_start..]
			.find('\n')
			.map_or(input.len(), |relative| line_start + relative);
		let line = &input[line_start..line_end];
		let trimmed = line.trim_start_matches([' ', '\t']);
		if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
			if let Some(start) = open.take() {
				ranges.push((start, line_end));
			} else {
				open = Some(line_start);
			}
		}
		if line_end == input.len() {
			break;
		}
		line_start = line_end + 1;
	}
	if let Some(start) = open {
		ranges.push((start, input.len()));
	}
	ranges
}

fn inside_fence(ranges: &[(usize, usize)], at: usize) -> bool {
	ranges.iter().any(|(start, end)| at >= *start && at < *end)
}

fn leak_record(
	wire_policy: &WirePolicyId<str>,
	attempt: u32,
	rule: &'static str,
	input_bytes: usize,
) -> HarmonyLeak {
	HarmonyLeak {
		recovery: RecoveryRecord {
			attempt,
			kind: RecoveryKind::HarmonyLeakDetection,
			rule: ReasonId(sf!("harmony/{}/{rule}", wire_policy.as_str())),
			input_bytes: input_bytes as u64,
			steps: 0,
		},
	}
}

const fn event_index(event: &ChatEvent) -> Option<u32> {
	match event {
		ChatEvent::BlockStarted { index, .. }
		| ChatEvent::TextDelta { index, .. }
		| ChatEvent::ThinkingDelta { index, .. }
		| ChatEvent::ToolCallStarted { index, .. }
		| ChatEvent::ToolArgumentsDelta { index, .. }
		| ChatEvent::ToolCallReady { index, .. }
		| ChatEvent::Artifact { index, .. } => Some(*index),
		ChatEvent::Started(_)
		| ChatEvent::Usage(_)
		| ChatEvent::WorkflowAction(_)
		| ChatEvent::WorkflowResume(_)
		| ChatEvent::WorkflowCancelled { .. }
		| ChatEvent::Completed(_) => None,
	}
}

fn remapped(index: u32, remap: &BTreeMap<u32, (u32, u32)>) -> u32 {
	remap.get(&index).map_or(index, |(base, _)| *base)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		event::{Completion, FinishReason},
		receipt::{ExecutionReceipt, Usage},
	};

	fn policy() -> WirePolicyId {
		WirePolicyId::new("codex")
	}

	fn attempt(text: &str) -> Vec<ChatEvent> {
		vec![
			ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
			ChatEvent::TextDelta { index: 0, text: Str::new(text) },
			ChatEvent::Completed(Completion {
				reason:  FinishReason::Stop,
				blocks:  1,
				usage:   Usage::default(),
				receipt: Box::new(ExecutionReceipt::default()),
			}),
		]
	}

	fn projected(events: &[ChatEvent]) -> Vec<(BlockKind, String)> {
		let mut kinds = BTreeMap::new();
		let mut out = BTreeMap::<u32, String>::new();
		for event in events {
			match event {
				ChatEvent::BlockStarted { index, kind } => {
					kinds.insert(*index, *kind);
				},
				ChatEvent::TextDelta { index, text } | ChatEvent::ThinkingDelta { index, text } => {
					out.entry(*index).or_default().push_str(text.as_str());
				},
				_ => {},
			}
		}
		out.into_iter()
			.map(|(index, text)| (kinds[&index], text))
			.collect()
	}

	#[test]
	fn exact_analysis_and_final_channels_preserve_surrounding_content() {
		let source = concat!(
			"prefix ",
			"<|start|>assistant<|channel|>analysis<|message|>private<|end|>",
			" between ",
			"<|channel|>final<|message|>answer<|end|>",
			" suffix"
		);
		let (events, records) = normalize_attempt(attempt(source), &policy(), 2).unwrap();
		assert_eq!(projected(&events), vec![
			(BlockKind::Text, "prefix ".into()),
			(BlockKind::Thinking, "private".into()),
			(BlockKind::Text, " between answer suffix".into()),
		]);
		assert_eq!(records.len(), 2);
		assert!(records.iter().all(|record| record.attempt == 2));
		assert!(
			records
				.iter()
				.all(|record| record.kind == RecoveryKind::HarmonyLeakRepair)
		);
	}

	#[test]
	fn channel_recognition_is_invariant_to_provider_delta_boundaries() {
		let source = concat!(
			"before ",
			"<",
			"|start|>assistant<|channel|>analysis<|message|>private<|end|>",
			" after"
		);
		let expected = normalize_attempt(attempt(source), &policy(), 0)
			.map(|(events, _)| projected(&events))
			.unwrap();
		for split in 0..=source.len() {
			if !source.is_char_boundary(split) {
				continue;
			}
			let mut events = attempt("");
			events.remove(1);
			events.insert(1, ChatEvent::TextDelta { index: 0, text: Str::new(&source[..split]) });
			events.insert(2, ChatEvent::TextDelta { index: 0, text: Str::new(&source[split..]) });
			let actual = normalize_attempt(events, &policy(), 0)
				.map(|(events, _)| projected(&events))
				.unwrap();
			assert_eq!(actual, expected, "split {split}");
		}
	}

	#[test]
	fn code_examples_and_bare_markers_remain_verbatim() {
		let source = "```text\n<|channel|>analysis<|message|>example<|end|>\n```\nDocs mention \
		              to=functions.edit.";
		let (events, records) = normalize_attempt(attempt(source), &policy(), 0).unwrap();
		assert!(records.is_empty());
		assert_eq!(projected(&events), vec![(BlockKind::Text, source.into())]);
	}

	#[test]
	fn unframed_control_or_fused_shadow_routing_rejects_attempt() {
		for source in [
			"visible <|channel|>analysis without a message boundary",
			"valid prefix analysis to=functions.edit code junk",
		] {
			let leak = normalize_attempt(attempt(source), &policy(), 1).unwrap_err();
			assert_eq!(leak.recovery.kind, RecoveryKind::HarmonyLeakDetection);
			assert_eq!(leak.recovery.attempt, 1);
		}
	}

	#[test]
	fn unterminated_exact_channel_is_not_repaired() {
		let source = "keep <|channel|>final<|message|>partial";
		let leak = normalize_attempt(attempt(source), &policy(), 0).unwrap_err();
		assert!(
			leak
				.recovery
				.rule
				.0
				.as_str()
				.ends_with("/unterminated-channel")
		);
	}
}
