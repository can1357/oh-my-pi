//! Canonical generative chat events and execution-authorization semantics.

use std::time;

use bytes::Bytes;
use omp_core::Str;

use crate::{
	answer::{Artifact, ResponseMeta},
	call::OpaqueJson,
	id::ToolCallId,
	receipt::{ExecutionReceipt, Usage},
};

/// Canonical content-block category.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlockKind {
	/// User-visible text.
	Text,
	/// Model reasoning or a reasoning summary.
	Thinking,
	/// A model-requested tool invocation.
	ToolCall,
	/// Generated media or other artifact.
	Artifact,
}

/// Fully assembled and schema-validated tool invocation.
#[derive(Clone, Debug)]
pub struct ToolCall {
	/// Stable call identity.
	pub id:        ToolCallId,
	/// Declared tool name.
	pub name:      Str,
	/// Opaque validated JSON arguments.
	pub arguments: OpaqueJson,
}

/// Incremental usage observation within a response stream.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UsageUpdate {
	/// Cumulative usage observed through this event.
	pub usage:        Usage,
	/// Whether no later usage correction is expected for this attempt.
	pub final_update: bool,
}

/// Why a chat attempt completed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FinishReason {
	/// The model reached a natural stop.
	Stop,
	/// The configured output-token limit was reached.
	Length,
	/// The response completed after emitting tool calls.
	ToolCalls,
	/// A content or safety filter stopped output.
	ContentFilter,
	/// The caller cancelled generation.
	Cancelled,
	/// A provider-specific reason was normalized but remains named.
	Other(Str),
}

/// Final chat stream completion metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Completion {
	/// Normalized finish reason.
	pub reason:  FinishReason,
	/// Number of canonical content blocks emitted.
	pub blocks:  u32,
	/// Final attempt usage.
	pub usage:   Usage,
	/// Authoritative final accounting after every attempt, recovery, adjustment,
	/// and telemetry merge. Boxed because the accounting record is much larger
	/// than every other completion field.
	pub receipt: Box<ExecutionReceipt>,
}

/// Wire response vocabulary expected by a provider workflow action.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkflowResponseKind {
	/// One provider-native action result closes the invocation.
	Action,
	/// Canonical incremental invocation frames and a terminal completion.
	Invoke,
}

/// Provider-requested action that must be answered on the live chat session.
#[derive(Clone, Debug)]
pub struct WorkflowAction {
	/// Provider correlation identity.
	pub invocation:    Str,
	/// Canonical transcript call identity; absent for pure control actions.
	pub call:          Option<ToolCallId>,
	/// Executor dispatch name.
	pub name:          Str,
	/// Exact provider action arguments.
	pub arguments:     Bytes,
	/// Provider completion deadline relative to this event.
	pub timeout:       Option<time::Duration>,
	/// Response vocabulary accepted by the requesting provider.
	pub response_kind: WorkflowResponseKind,
}

/// Provider reconnect cursor surfaced independently of generated output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowResume {
	/// Stable provider workflow identity.
	pub workflow_id:   Str,
	/// Stable provider session identity.
	pub session_id:    Str,
	/// Last fully decoded provider event.
	pub last_event_id: Option<Str>,
}

/// Provider-native response to one workflow action.
#[derive(Clone, Debug)]
pub struct WorkflowActionResponse {
	/// Provider correlation identity for this action.
	pub invocation: Str,
	/// Provider-native action response payload.
	pub response:   Bytes,
	/// Whether the provider should treat the response as an error.
	pub is_error:   bool,
}

/// Incremental input for one live invocation.
#[derive(Clone, Debug)]
pub struct InvokeInput {
	/// Provider correlation identity for this invocation.
	pub invocation: Str,
	/// Lossless canonical invocation payload.
	pub payload:    Bytes,
}

/// Terminal completion for one live invocation.
#[derive(Clone, Debug)]
pub struct InvokeComplete {
	/// Provider correlation identity for this completed invocation.
	pub invocation: Str,
	/// Lossless canonical completion payload.
	pub payload:    Bytes,
}

/// One live response sent back through the provider session that requested it.
#[derive(Clone, Debug)]
pub enum WorkflowResponse {
	/// Provider-native action response.
	WorkflowActionResponse(WorkflowActionResponse),
	/// Incremental canonical invocation frame.
	InvokeInput(InvokeInput),
	/// Terminal canonical invocation frame.
	InvokeComplete(InvokeComplete),
}

impl WorkflowResponse {
	/// Borrows the provider correlation identity.
	pub const fn invocation(&self) -> &Str {
		match self {
			Self::WorkflowActionResponse(response) => &response.invocation,
			Self::InvokeInput(input) => &input.invocation,
			Self::InvokeComplete(completion) => &completion.invocation,
		}
	}

	/// Returns whether this response closes its invocation.
	pub const fn is_terminal(&self) -> bool {
		matches!(self, Self::WorkflowActionResponse(_) | Self::InvokeComplete(_))
	}
}

/// Canonical chat stream vocabulary.
///
/// There is deliberately no restart or rollback event. Once ordinary output is
/// visible, later failures surface as stream errors.
#[derive(Debug)]
pub enum ChatEvent {
	/// Response handshake metadata.
	Started(ResponseMeta),
	/// A canonical content block began.
	BlockStarted {
		/// Stable content-block index.
		index: u32,
		/// Canonical block category.
		kind:  BlockKind,
	},
	/// User-visible text delta.
	TextDelta {
		/// Stable content-block index.
		index: u32,
		/// Incremental visible text.
		text:  Str,
	},
	/// Reasoning or reasoning-summary delta.
	ThinkingDelta {
		/// Stable content-block index.
		index: u32,
		/// Incremental reasoning text.
		text:  Str,
	},
	/// A tool call began, before its arguments are complete.
	ToolCallStarted {
		/// Stable content-block index.
		index: u32,
		/// Stable tool-call identity.
		id:    ToolCallId,
		/// Tool name.
		name:  Str,
	},
	/// Incomplete tool argument bytes for display or telemetry only.
	ToolArgumentsDelta {
		/// Stable content-block index.
		index: u32,
		/// Incremental unvalidated argument bytes.
		bytes: Bytes,
	},
	/// Fully assembled, validated tool call; the sole execution authorization.
	ToolCallReady {
		/// Stable content-block index.
		index: u32,
		/// Validated executable tool call.
		call:  ToolCall,
	},
	/// Generated canonical artifact.
	Artifact {
		/// Stable content-block index.
		index:    u32,
		/// Generated artifact.
		artifact: Artifact,
	},
	/// Incremental usage observation.
	Usage(UsageUpdate),
	/// Provider requests an action whose response must use this live session.
	WorkflowAction(WorkflowAction),
	/// Provider publishes a reconnect cursor without ending the turn.
	WorkflowResume(WorkflowResume),
	/// Provider cancelled one live invocation.
	WorkflowCancelled {
		/// Provider correlation identity.
		invocation: Str,
	},
	/// Successful terminal completion.
	Completed(Completion),
}

impl ChatEvent {
	/// Returns an executable tool call only for `ToolCallReady`.
	pub const fn authorized_tool_call(&self) -> Option<&ToolCall> {
		match self {
			Self::ToolCallReady { call, .. } => Some(call),
			_ => None,
		}
	}

	/// Returns whether this event belongs to the live provider control plane.
	pub const fn is_workflow_control(&self) -> bool {
		matches!(
			self,
			Self::WorkflowAction(_) | Self::WorkflowResume(_) | Self::WorkflowCancelled { .. }
		)
	}

	/// Returns whether this event is ordinary output that commits the stream.
	pub fn commits_output(&self) -> bool {
		match self {
			Self::TextDelta { text, .. } | Self::ThinkingDelta { text, .. } => !text.is_empty(),
			Self::ToolArgumentsDelta { bytes, .. } => !bytes.is_empty(),
			Self::ToolCallStarted { .. }
			| Self::ToolCallReady { .. }
			| Self::Artifact { .. }
			| Self::Completed(_) => true,
			Self::Started(_)
			| Self::BlockStarted { .. }
			| Self::Usage(_)
			| Self::WorkflowAction(_)
			| Self::WorkflowResume(_)
			| Self::WorkflowCancelled { .. } => false,
		}
	}
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;
	use omp_core::sf;
	use serde_json::json;

	use super::{ChatEvent, ToolCall};
	use crate::{call::OpaqueJson, id::ToolCallId};

	#[test]
	fn only_nonempty_deltas_or_actionable_output_commit() {
		assert!(!ChatEvent::BlockStarted { index: 0, kind: super::BlockKind::Text }.commits_output());
		assert!(!ChatEvent::TextDelta { index: 0, text: sf!("") }.commits_output());
		assert!(ChatEvent::TextDelta { index: 0, text: sf!("  \n") }.commits_output());
		assert!(ChatEvent::ThinkingDelta { index: 0, text: sf!("thinking") }.commits_output());
	}

	#[test]
	fn only_ready_tool_calls_authorize_execution() {
		let started = ChatEvent::ToolCallStarted {
			index: 0,
			id:    ToolCallId::from("call"),
			name:  sf!("lookup"),
		};
		let partial =
			ChatEvent::ToolArgumentsDelta { index: 0, bytes: Bytes::from_static(b"{\"q\":") };
		assert!(started.authorized_tool_call().is_none());
		assert!(partial.authorized_tool_call().is_none());
		let ready = ChatEvent::ToolCallReady {
			index: 0,
			call:  ToolCall {
				id:        ToolCallId::from("call"),
				name:      sf!("lookup"),
				arguments: OpaqueJson::new(json!({"q": "rust"})),
			},
		};
		assert_eq!(ready.authorized_tool_call().map(|call| call.name.as_str()), Some("lookup"));
	}
}
