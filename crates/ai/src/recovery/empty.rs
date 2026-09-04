//! Deterministic empty-completion classification.

use omp_catalog::id::WirePolicyId;
use omp_core::{Str, sf};

use super::{RecoveryError, Stage};
use crate::{
	event::ChatEvent,
	receipt::{ReasonId, RecoveryKind, RecoveryRecord},
};

/// Structural evidence for a provider stop that may have ended prematurely.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct UnexpectedStopEvidence {
	/// Provider reported an ordinary end-turn stop.
	pub end_turn:        bool,
	/// At least one non-whitespace visible text block exists.
	pub visible_text:    bool,
	/// At least one signed non-whitespace thinking block exists.
	pub signed_thinking: bool,
	/// The turn emitted a tool call and therefore stopped actionably.
	pub tool_call:       bool,
}

/// Returns whether the secondary unexpected-stop classifier should run.
pub const fn is_unexpected_stop_candidate(evidence: UnexpectedStopEvidence) -> bool {
	evidence.end_turn && !evidence.tool_call && (evidence.visible_text || evidence.signed_thinking)
}

/// Builds the bounded retry guidance injected after a classified unexpected
/// stop.
pub fn unexpected_stop_guidance(retry: u32, maximum: u32) -> Str {
	sf!(
		"<system-injection>\nYou said you would continue with a tool call or action but stopped. \
		 Continue now.\nAttempt #{retry}/{maximum}\n</system-injection>"
	)
}

/// Why a successful provider completion carried no usable public answer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EmptyCompletionKind {
	/// No content-bearing event occurred.
	NoContent,
	/// Text blocks contained only Unicode whitespace.
	WhitespaceOnly,
	/// Reasoning was emitted but no visible text, tool call, or artifact
	/// followed.
	ThinkingOnly,
	/// Blocks began but produced no content.
	EmptyBlocks,
}

/// Empty-completion classification with receipt-ready evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmptyCompletion {
	/// Stable semantic classification.
	pub kind:      EmptyCompletionKind,
	/// Whether any ordinary output was already emitted and therefore committed.
	pub committed: bool,
	/// Typed recovery evidence.
	pub recovery:  RecoveryRecord,
}

/// Input to the empty-completion observer before authoritative completion is
/// constructed.
#[derive(Debug)]
pub enum EmptyInput {
	/// One non-terminal canonical event.
	Event(Box<ChatEvent>),
	/// The provider attempt ended successfully; the response layer may now build
	/// its terminal.
	Completed,
}

/// Output from the transparent empty-completion observer.
#[derive(Debug)]
pub enum EmptyEvent {
	/// Original event forwarded unchanged.
	Event(Box<ChatEvent>),
	/// Terminal empty-completion classification.
	Empty(EmptyCompletion),
}

/// Transparent stream observer which classifies successful empty completions.
#[derive(Debug)]
pub struct EmptyCompletionStage {
	wire_policy:             WirePolicyId,
	attempt:                 u32,
	saw_block:               bool,
	saw_text:                bool,
	saw_non_whitespace_text: bool,
	saw_thinking:            bool,
	saw_tool_or_artifact:    bool,
	committed:               bool,
	completed:               bool,
}

impl EmptyCompletionStage {
	/// Creates an observer with catalog policy evidence.
	pub const fn new(wire_policy: WirePolicyId, attempt: u32) -> Self {
		Self {
			wire_policy,
			attempt,
			saw_block: false,
			saw_text: false,
			saw_non_whitespace_text: false,
			saw_thinking: false,
			saw_tool_or_artifact: false,
			committed: false,
			completed: false,
		}
	}

	const fn reset(&mut self) {
		self.saw_block = false;
		self.saw_text = false;
		self.saw_non_whitespace_text = false;
		self.saw_thinking = false;
		self.saw_tool_or_artifact = false;
		self.committed = false;
		self.completed = false;
	}

	const fn classification(&self) -> Option<EmptyCompletionKind> {
		if self.saw_tool_or_artifact || self.saw_non_whitespace_text {
			return None;
		}
		if self.saw_thinking {
			return Some(EmptyCompletionKind::ThinkingOnly);
		}
		if self.saw_text {
			return Some(EmptyCompletionKind::WhitespaceOnly);
		}
		if self.saw_block {
			return Some(EmptyCompletionKind::EmptyBlocks);
		}
		Some(EmptyCompletionKind::NoContent)
	}
}

impl Stage<EmptyInput, EmptyEvent> for EmptyCompletionStage {
	fn push(
		&mut self,
		input: EmptyInput,
		emit: &mut dyn FnMut(EmptyEvent),
	) -> Result<(), RecoveryError> {
		if self.completed {
			return Err(RecoveryError::InvalidInput {
				stage:  "empty-completion",
				reason: sf!("event arrived after completion"),
			});
		}
		match input {
			EmptyInput::Completed => {
				self.completed = true;
				if let Some(kind) = self.classification() {
					emit(EmptyEvent::Empty(EmptyCompletion {
						kind,
						committed: self.committed,
						recovery: RecoveryRecord {
							attempt:     self.attempt,
							kind:        RecoveryKind::EmptyOutput,
							rule:        ReasonId(sf!(
								"empty-completion/{}/{}",
								self.wire_policy.as_str(),
								kind.as_str()
							)),
							input_bytes: 0,
							steps:       0,
						},
					}));
				}
			},
			EmptyInput::Event(event) => {
				if matches!(*event, ChatEvent::Completed(_)) {
					return Err(RecoveryError::InvalidInput {
						stage:  "empty-completion",
						reason: sf!(
							"authoritative completion must be constructed after empty classification",
						),
					});
				}
				self.committed |= event.commits_output();
				match event.as_ref() {
					ChatEvent::BlockStarted { .. } => {
						self.saw_block = true;
					},
					ChatEvent::TextDelta { text, .. } => {
						self.saw_text = true;
						self.saw_non_whitespace_text |=
							text.chars().any(|character| !character.is_whitespace());
					},
					ChatEvent::ThinkingDelta { text, .. } => {
						self.saw_thinking |= text.chars().any(|character| !character.is_whitespace());
					},
					ChatEvent::ToolCallReady { .. } | ChatEvent::Artifact { .. } => {
						self.saw_tool_or_artifact = true;
					},
					_ => {},
				}
				emit(EmptyEvent::Event(event));
			},
		}
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(EmptyEvent)) -> Result<(), RecoveryError> {
		if self.completed {
			self.reset();
			Ok(())
		} else {
			Err(RecoveryError::Incomplete { stage: "empty-completion" })
		}
	}
}

impl EmptyCompletionKind {
	const fn as_str(self) -> &'static str {
		match self {
			Self::NoContent => "no-content",
			Self::WhitespaceOnly => "whitespace-only",
			Self::ThinkingOnly => "thinking-only",
			Self::EmptyBlocks => "empty-blocks",
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::event::BlockKind;

	#[test]
	fn unexpected_stop_candidate_excludes_tool_calls_and_unsigned_thinking() {
		assert!(is_unexpected_stop_candidate(UnexpectedStopEvidence {
			end_turn: true,
			visible_text: true,
			..UnexpectedStopEvidence::default()
		}));
		assert!(!is_unexpected_stop_candidate(UnexpectedStopEvidence {
			end_turn: true,
			signed_thinking: true,
			tool_call: true,
			..UnexpectedStopEvidence::default()
		}));
		assert!(unexpected_stop_guidance(1, 3).contains("Attempt #1/3"));
	}

	#[test]
	fn terminal_only_completion_is_empty_but_not_precommitted() {
		let mut stage = EmptyCompletionStage::new(WirePolicyId::new("wire"), 1);
		let mut output = Vec::new();
		stage
			.push(EmptyInput::Completed, &mut |event| output.push(event))
			.unwrap();
		let empty = output
			.into_iter()
			.find_map(|event| match event {
				EmptyEvent::Empty(empty) => Some(empty),
				EmptyEvent::Event(_) => None,
			})
			.unwrap();
		assert_eq!(empty.kind, EmptyCompletionKind::NoContent);
		assert!(!empty.committed);
		stage.finish(&mut |_| {}).unwrap();
	}

	#[test]
	fn empty_open_block_does_not_commit_but_whitespace_delta_does() {
		let mut empty_block = EmptyCompletionStage::new(WirePolicyId::new("wire"), 1);
		let mut output = Vec::new();
		empty_block
			.push(
				EmptyInput::Event(Box::new(ChatEvent::BlockStarted {
					index: 0,
					kind:  BlockKind::Thinking,
				})),
				&mut |event| output.push(event),
			)
			.unwrap();
		empty_block
			.push(EmptyInput::Completed, &mut |event| output.push(event))
			.unwrap();
		assert!(output.into_iter().any(|event| matches!(
			event,
			EmptyEvent::Empty(EmptyCompletion {
				kind: EmptyCompletionKind::EmptyBlocks,
				committed: false,
				..
			})
		)));

		let mut whitespace = EmptyCompletionStage::new(WirePolicyId::new("wire"), 1);
		let mut output = Vec::new();
		whitespace
			.push(
				EmptyInput::Event(Box::new(ChatEvent::TextDelta { index: 0, text: sf!(" \n") })),
				&mut |event| output.push(event),
			)
			.unwrap();
		whitespace
			.push(EmptyInput::Completed, &mut |event| output.push(event))
			.unwrap();
		assert!(output.into_iter().any(|event| matches!(
			event,
			EmptyEvent::Empty(EmptyCompletion {
				kind: EmptyCompletionKind::WhitespaceOnly,
				committed: true,
				..
			})
		)));
	}

	#[test]
	fn visible_text_is_not_empty() {
		let mut stage = EmptyCompletionStage::new(WirePolicyId::new("wire"), 1);
		let mut output = Vec::new();
		stage
			.push(
				EmptyInput::Event(Box::new(ChatEvent::TextDelta { index: 0, text: sf!("answer") })),
				&mut |event| output.push(event),
			)
			.unwrap();
		stage
			.push(EmptyInput::Completed, &mut |event| output.push(event))
			.unwrap();
		assert!(
			output
				.into_iter()
				.all(|event| matches!(event, EmptyEvent::Event(_)))
		);
	}
}
