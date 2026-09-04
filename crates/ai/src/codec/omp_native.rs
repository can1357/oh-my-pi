//! Typed projection for OMP's internal bidirectional inference RPC.
//!
//! The protobuf types remain the sole wire schema. This module validates turn
//! envelopes, frames protobuf messages, and projects server events without
//! owning transport, authentication, retry, or conversation storage.

use std::collections::BTreeMap;

use bytes::{BufMut as _, Bytes, BytesMut};
use omp_core::{Str, encoding::base64, sf};
use omp_proto::{
	inference::v1::{self as pb, part_start, turn_error, turn_event, turn_request, usage},
	prost::Message as _,
	thread::v1 as thread_pb,
};

use crate::{
	codec::{
		Decoder, ProviderControlEvent, ProviderStateEvent, RawCompletion, RawEvent, ToolInputKind,
		UnvalidatedToolCall,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason, UsageUpdate},
	id::ToolCallId,
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{ConnectEnvelopeKind, Frame},
};

/// Hard bound for one internal turn protobuf message.
pub const MAX_TURN_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Validated first-frame input of an OMP turn.
#[derive(Clone, Copy, Debug)]
pub enum OmpTurnInputRef<'a> {
	/// A full stateless thread or context reseed.
	Seed(&'a pb::Seed),
	/// An optimistic incremental mutation against an expected revision.
	Incremental(&'a pb::Incremental),
}

/// Borrowed, structurally validated OMP turn-open envelope.
#[derive(Clone, Copy, Debug)]
pub struct OmpTurnOpenRef<'a> {
	/// Client-minted idempotency key.
	pub turn_id:  &'a str,
	/// Seed or incremental input.
	pub input:    OmpTurnInputRef<'a>,
	/// Canonical chat parameters serialized by the gateway protocol.
	pub params:   Option<&'a pb::ChatParams>,
	/// Optional declared in-turn executor.
	pub executor: Option<&'a pb::Executor>,
}

/// Why a pending turn transaction did not commit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OmpRollbackCause {
	/// A typed terminal upstream or gateway error was received.
	TerminalError,
	/// The event stream ended without a terminal outcome.
	TruncatedStream,
	/// The client cancelled by dropping its stream.
	ClientCancelled,
}

/// Atomic disposition of an internal OMP turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OmpTurnDisposition {
	/// The request has not reached a terminal frame.
	Pending,
	/// The authoritative output committed with its resulting revision.
	Committed {
		/// Revision produced by the committed outcome.
		revision: Option<thread_pb::Revision>,
	},
	/// The optimistic precondition failed before any mutation.
	Conflict {
		/// Current revision observed by the gateway.
		actual: Option<thread_pb::Revision>,
	},
	/// Every staged append and truncation was discarded.
	RolledBack {
		/// Terminal condition that caused the rollback.
		cause: OmpRollbackCause,
	},
}

/// Secret-free transactional receipt for one internal OMP turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OmpTurnReceipt {
	/// Whether admission was observed.
	pub accepted:    bool,
	/// Whether this was a committed idempotent replay.
	pub replay:      bool,
	/// Atomic terminal disposition.
	pub disposition: OmpTurnDisposition,
}

impl Default for OmpTurnReceipt {
	fn default() -> Self {
		Self { accepted: false, replay: false, disposition: OmpTurnDisposition::Pending }
	}
}

impl OmpTurnReceipt {
	/// Applies a typed server event to the transaction receipt.
	pub fn observe(&mut self, event: &pb::TurnEvent) {
		let Some(event) = event.event.as_ref() else {
			return;
		};
		match event {
			turn_event::Event::Accepted(accepted) => {
				self.accepted = true;
				self.replay = accepted.replay;
			},
			turn_event::Event::Outcome(outcome) => {
				self.disposition = OmpTurnDisposition::Committed { revision: outcome.revision.clone() };
			},
			turn_event::Event::Error(error) if error.kind() == turn_error::Kind::Conflict => {
				self.disposition = OmpTurnDisposition::Conflict { actual: error.actual.clone() };
			},
			turn_event::Event::Error(_) => {
				self.disposition =
					OmpTurnDisposition::RolledBack { cause: OmpRollbackCause::TerminalError };
			},
			_ => {},
		}
	}

	/// Marks transport EOF before a terminal event and records atomic rollback.
	pub fn truncate(&mut self) {
		if matches!(self.disposition, OmpTurnDisposition::Pending) {
			self.disposition =
				OmpTurnDisposition::RolledBack { cause: OmpRollbackCause::TruncatedStream };
		}
	}

	/// Marks structural client cancellation and records atomic rollback.
	pub fn cancel(&mut self) {
		if matches!(self.disposition, OmpTurnDisposition::Pending) {
			self.disposition =
				OmpTurnDisposition::RolledBack { cause: OmpRollbackCause::ClientCancelled };
		}
	}
}

/// Validates the first turn frame before any I/O or context mutation.
pub fn validate_turn_open(request: &pb::TurnRequest) -> Result<OmpTurnOpenRef<'_>, Error> {
	if request.turn_id.is_empty() {
		return Err(protocol_error("omp_turn_id_missing", ErrorPhase::Encoding));
	}
	let input = match request.input.as_ref() {
		Some(turn_request::Input::Seed(seed)) => {
			if seed.thread.is_none() {
				return Err(protocol_error("omp_seed_thread_missing", ErrorPhase::Encoding));
			}
			OmpTurnInputRef::Seed(seed)
		},
		Some(turn_request::Input::Incremental(incremental)) => {
			let context = incremental.context.as_ref().ok_or_else(|| {
				protocol_error("omp_incremental_context_missing", ErrorPhase::Encoding)
			})?;
			if context.context_id.is_empty() || context.expected.is_none() {
				return Err(protocol_error(
					"omp_incremental_precondition_missing",
					ErrorPhase::Encoding,
				));
			}
			let delta = incremental
				.delta
				.as_ref()
				.ok_or_else(|| protocol_error("omp_incremental_delta_missing", ErrorPhase::Encoding))?;
			if delta.truncate_to.is_some_and(|head| {
				head
					> context
						.expected
						.as_ref()
						.map_or(0, |revision| revision.head)
			}) {
				return Err(protocol_error(
					"omp_incremental_truncate_after_expected_head",
					ErrorPhase::Encoding,
				));
			}
			OmpTurnInputRef::Incremental(incremental)
		},
		None => return Err(protocol_error("omp_turn_input_missing", ErrorPhase::Encoding)),
	};
	Ok(OmpTurnOpenRef {
		turn_id: &request.turn_id,
		input,
		params: request.params.as_ref(),
		executor: request.executor.as_ref(),
	})
}

/// Encodes one protobuf client frame with the gRPC/Connect five-byte envelope.
pub fn encode_turn_frame(frame: &pb::TurnFrame) -> Result<Bytes, Error> {
	if frame.frame.is_none() {
		return Err(protocol_error("omp_turn_frame_empty", ErrorPhase::Encoding));
	}
	let size = frame.encoded_len();
	if size > MAX_TURN_MESSAGE_BYTES {
		return Err(protocol_error("omp_turn_frame_too_large", ErrorPhase::Encoding));
	}
	let mut output = BytesMut::with_capacity(size + 5);
	output.put_u8(0);
	output.put_u32(size as u32);
	frame
		.encode(&mut output)
		.map_err(|_| protocol_error("omp_turn_frame_encode_failed", ErrorPhase::Encoding))?;
	Ok(output.freeze())
}

/// Incremental protobuf event projector for an OMP turn stream.
#[derive(Debug, Default)]
pub struct OmpNativeDecoder {
	parts:    BTreeMap<u32, OmpOpenPart>,
	blocks:   u32,
	terminal: bool,
	receipt:  OmpTurnReceipt,
}

#[derive(Debug)]
enum OmpOpenPart {
	Text(BlockKind),
	Tool { id: ToolCallId, name: Str, arguments: BytesMut },
}

impl OmpNativeDecoder {
	/// Creates empty transactional projection state.
	pub fn new() -> Self {
		Self::default()
	}

	/// Borrows the exact transactional receipt accumulated so far.
	pub const fn receipt(&self) -> &OmpTurnReceipt {
		&self.receipt
	}

	/// Decodes and projects one complete protobuf message payload.
	pub fn push_message(
		&mut self,
		payload: &[u8],
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		if self.terminal {
			return Ok(());
		}
		if payload.len() > MAX_TURN_MESSAGE_BYTES {
			return Err(protocol_error("omp_turn_event_too_large", ErrorPhase::Streaming));
		}
		let event = pb::TurnEvent::decode(payload)
			.map_err(|_| protocol_error("omp_turn_event_decode_failed", ErrorPhase::Streaming))?;
		self.receipt.observe(&event);
		self.project(event, emit)
	}

	/// Ends a stream, recording and emitting rollback if no terminal event
	/// arrived.
	pub fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) {
		if !self.terminal {
			self.receipt.truncate();
			self.terminal = true;
			emit(RawEvent::Control(ProviderControlEvent::RolledBack { revision: None }));
			emit(RawEvent::Failure(protocol_error(
				"omp_turn_stream_truncated",
				ErrorPhase::Streaming,
			)));
		}
	}

	/// Cancels a stream structurally, recording rollback without pretending it
	/// is retryable.
	pub fn cancel(&mut self, emit: &mut dyn FnMut(RawEvent)) {
		if !self.terminal {
			self.receipt.cancel();
			self.terminal = true;
			emit(RawEvent::Control(ProviderControlEvent::Cancelled));
			let mut error = protocol_error("omp_turn_cancelled", ErrorPhase::Streaming);
			error.kind = ErrorKind::Cancelled;
			emit(RawEvent::Failure(error));
		}
	}

	fn project(
		&mut self,
		event: pb::TurnEvent,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		let event = event
			.event
			.ok_or_else(|| protocol_error("omp_turn_event_empty", ErrorPhase::Streaming))?;
		match event {
			turn_event::Event::Accepted(accepted) => {
				emit(RawEvent::Control(ProviderControlEvent::Accepted { replay: accepted.replay }));
			},
			turn_event::Event::PartStart(part) => self.part_start(part, emit)?,
			turn_event::Event::PartDelta(part) => self.part_delta(part, emit)?,
			turn_event::Event::PartEnd(part) => self.part_end(part, emit)?,
			turn_event::Event::Outcome(outcome) => self.outcome(outcome, emit),
			turn_event::Event::Error(error) => self.failure(error, emit),
			turn_event::Event::InvokeCancel(cancel) => {
				emit(RawEvent::Control(ProviderControlEvent::Cancel {
					call: ToolCallId::new(cancel.invocation_id),
				}));
			},
			turn_event::Event::Attempt(_) | turn_event::Event::Invoke(_) => {},
		}
		Ok(())
	}

	fn part_start(
		&mut self,
		part: pb::PartStart,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		let kind = match part.kind() {
			part_start::Kind::Text => BlockKind::Text,
			part_start::Kind::Thinking => BlockKind::Thinking,
			part_start::Kind::ToolCall => BlockKind::ToolCall,
			part_start::Kind::Unspecified => {
				return Err(protocol_error("omp_part_kind_unspecified", ErrorPhase::Streaming));
			},
		};
		self.blocks = self.blocks.saturating_add(1);
		if kind == BlockKind::ToolCall {
			if part.tool_call_id.is_empty() || part.tool_name.is_empty() {
				return Err(protocol_error("omp_tool_identity_missing", ErrorPhase::Streaming));
			}
			let id = ToolCallId::new(part.tool_call_id);
			let name = Str::new(part.tool_name);
			self.parts.insert(part.index, OmpOpenPart::Tool {
				id:        id.clone(),
				name:      name.clone(),
				arguments: BytesMut::new(),
			});
			emit(RawEvent::Chat(ChatEvent::ToolCallStarted { index: part.index, id, name }));
		} else {
			self.parts.insert(part.index, OmpOpenPart::Text(kind));
			emit(RawEvent::Chat(ChatEvent::BlockStarted { index: part.index, kind }));
		}
		Ok(())
	}

	fn part_delta(
		&mut self,
		part: pb::PartDelta,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		match self.parts.get_mut(&part.index) {
			Some(OmpOpenPart::Text(BlockKind::Text)) => {
				let text = Str::from_utf8(&part.chunk)
					.map_err(|_| protocol_error("omp_text_delta_invalid_utf8", ErrorPhase::Streaming))?;
				emit(RawEvent::Chat(ChatEvent::TextDelta { index: part.index, text }));
			},
			Some(OmpOpenPart::Text(BlockKind::Thinking)) => {
				let text = Str::from_utf8(&part.chunk).map_err(|_| {
					protocol_error("omp_thinking_delta_invalid_utf8", ErrorPhase::Streaming)
				})?;
				emit(RawEvent::Chat(ChatEvent::ThinkingDelta { index: part.index, text }));
			},
			Some(OmpOpenPart::Tool { arguments, .. }) => {
				arguments.extend_from_slice(&part.chunk);
				emit(RawEvent::Chat(ChatEvent::ToolArgumentsDelta {
					index: part.index,
					bytes: part.chunk,
				}));
			},
			_ => return Err(protocol_error("omp_part_delta_without_start", ErrorPhase::Streaming)),
		}
		Ok(())
	}

	fn part_end(&mut self, part: pb::PartEnd, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let open = self
			.parts
			.remove(&part.index)
			.ok_or_else(|| protocol_error("omp_part_end_without_start", ErrorPhase::Streaming))?;
		if let OmpOpenPart::Tool { id, name, arguments } = open {
			emit(RawEvent::ToolCallComplete {
				index: part.index,
				call:  UnvalidatedToolCall {
					id,
					name,
					input_kind: ToolInputKind::Json,
					arguments: arguments.freeze(),
				},
			});
		}
		Ok(())
	}

	fn outcome(&mut self, outcome: pb::Outcome, emit: &mut dyn FnMut(RawEvent)) {
		self.terminal = true;
		let usage = outcome
			.usage
			.as_ref()
			.map_or_else(Usage::default, proto_usage);
		emit(RawEvent::Chat(ChatEvent::Usage(UsageUpdate { usage, final_update: true })));
		let reason = match outcome.stop() {
			pb::StopReason::StopEndTurn => FinishReason::Stop,
			pb::StopReason::StopToolUse => FinishReason::ToolCalls,
			pb::StopReason::StopMaxTokens => FinishReason::Length,
			pb::StopReason::StopContentFilter => FinishReason::ContentFilter,
			pb::StopReason::StopUnspecified => FinishReason::Other(sf!("unspecified")),
		};
		if let Some(revision) = outcome.revision.as_ref() {
			emit(RawEvent::ProviderState(ProviderStateEvent::Checkpoint {
				id:   Some(revision_id(revision)),
				data: Bytes::from(revision.encode_to_vec()),
			}));
		}
		emit(RawEvent::Completion(RawCompletion { reason, blocks: self.blocks, usage }));
	}

	fn failure(&mut self, failure: pb::TurnError, emit: &mut dyn FnMut(RawEvent)) {
		self.terminal = true;
		let (kind, code) = match failure.kind() {
			turn_error::Kind::Conflict => (ErrorKind::SessionConflict, "omp_turn_conflict"),
			turn_error::Kind::NeedFull => (ErrorKind::SessionExpired, "omp_turn_need_full"),
			turn_error::Kind::Unsupported => (ErrorKind::CapabilityMismatch, "omp_turn_unsupported"),
			turn_error::Kind::Auth => (ErrorKind::Authentication, "omp_turn_auth"),
			turn_error::Kind::RateLimited => (ErrorKind::RateLimited, "omp_turn_rate_limited"),
			turn_error::Kind::Overloaded => (ErrorKind::ResourceExhausted, "omp_turn_overloaded"),
			turn_error::Kind::InvokeTimeout => {
				(ErrorKind::DeadlineExceeded, "omp_turn_invoke_timeout")
			},
			turn_error::Kind::EmptyOutput => (ErrorKind::EmptyOutput, "omp_turn_empty_output"),
			turn_error::Kind::ContextOverflow => {
				(ErrorKind::ContextOverflow, "omp_turn_context_overflow")
			},
			turn_error::Kind::PayloadRejected => {
				(ErrorKind::PayloadRejected, "omp_turn_payload_rejected")
			},
			turn_error::Kind::Upstream | turn_error::Kind::Unspecified => {
				(ErrorKind::Protocol, "omp_turn_upstream")
			},
		};
		if failure.kind() == turn_error::Kind::Conflict {
			let actual_revision = failure
				.actual
				.as_ref()
				.map_or_else(|| sf!("missing"), revision_id);
			emit(RawEvent::Control(ProviderControlEvent::RevisionConflict { actual_revision }));
		} else {
			emit(RawEvent::Control(ProviderControlEvent::RolledBack { revision: None }));
		}
		let mut error = protocol_error(code, ErrorPhase::Streaming).code(Str::new(code));
		error.kind = kind;
		emit(RawEvent::Failure(error));
	}
}

fn revision_id(revision: &thread_pb::Revision) -> Str {
	let token = base64::encode(&revision.token).into_string();
	sf!("{}:{token}", revision.head)
}

impl Decoder for OmpNativeDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let Frame::Connect(envelope) = frame else {
			return Err(protocol_error("omp_turn_unexpected_frame", ErrorPhase::Streaming));
		};
		if envelope.is_compressed() {
			return Err(protocol_error("omp_turn_compression_not_negotiated", ErrorPhase::Streaming));
		}
		match envelope.kind {
			ConnectEnvelopeKind::Message => self.push_message(&envelope.payload, emit),
			ConnectEnvelopeKind::EndStream => {
				Self::finish(self, emit);
				Ok(())
			},
		}
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		Self::finish(self, emit);
		Ok(())
	}
}

fn proto_usage(usage: &pb::Usage) -> Usage {
	Usage {
		input_tokens: usage.input_tokens,
		output_tokens: usage.output_tokens,
		reasoning_tokens: usage.reasoning_tokens.unwrap_or(0),
		cache_read_tokens: usage.cache_read_tokens,
		cache_write_tokens: usage.cache_write_tokens,
		source: match usage.accuracy() {
			usage::Accuracy::Exact => UsageSource::Provider,
			usage::Accuracy::Estimated => UsageSource::Estimated,
			usage::Accuracy::Mixed => UsageSource::Mixed,
			usage::Accuracy::Unspecified => UsageSource::Provider,
		},
		..Usage::default()
	}
}

fn protocol_error(reason: &'static str, phase: ErrorPhase) -> Error {
	Error::new(ErrorKind::Protocol, phase, RetryAction::Never, ExecutionReceipt::default())
		.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {

	use omp_proto::inference::v1::turn_frame;

	use super::*;

	fn revision(head: u64, token: &[u8]) -> thread_pb::Revision {
		thread_pb::Revision { head, token: Bytes::copy_from_slice(token) }
	}

	#[test]
	fn seed_and_incremental_envelopes_validate() {
		let seed = pb::TurnRequest {
			turn_id: "turn-seed".into(),
			input: Some(turn_request::Input::Seed(pb::Seed {
				context_id: "ctx-seed".into(),
				thread:     Some(Default::default()),
			})),
			..Default::default()
		};
		assert!(matches!(validate_turn_open(&seed).expect("seed").input, OmpTurnInputRef::Seed(_)));

		let incremental = pb::TurnRequest {
			turn_id: "turn-current".into(),
			input: Some(turn_request::Input::Incremental(pb::Incremental {
				context: Some(pb::ContextRef {
					context_id: "ctx".into(),
					expected:   Some(revision(0, b"")),
				}),
				delta:   Some(pb::ThreadDelta { truncate_to: None, append: Vec::new() }),
			})),
			..Default::default()
		};
		assert!(matches!(
			validate_turn_open(&incremental).expect("incremental").input,
			OmpTurnInputRef::Incremental(_)
		));
	}

	#[test]
	fn replay_conflict_rollback_and_cancel_are_explicit() {
		let mut receipt = OmpTurnReceipt::default();
		receipt.observe(&pb::TurnEvent {
			event: Some(turn_event::Event::Accepted(pb::Accepted { replay: true })),
		});
		assert!(receipt.accepted && receipt.replay);
		receipt.observe(&pb::TurnEvent {
			event: Some(turn_event::Event::Outcome(pb::Outcome {
				revision: Some(revision(1, b"one")),
				..Default::default()
			})),
		});
		assert!(matches!(receipt.disposition, OmpTurnDisposition::Committed { .. }));

		let mut conflict = OmpTurnReceipt::default();
		conflict.observe(&pb::TurnEvent {
			event: Some(turn_event::Event::Error(pb::TurnError {
				kind: turn_error::Kind::Conflict as i32,
				actual: Some(revision(2, b"two")),
				..Default::default()
			})),
		});
		assert!(matches!(conflict.disposition, OmpTurnDisposition::Conflict { .. }));

		let mut rollback = OmpTurnReceipt { accepted: true, ..Default::default() };
		rollback.truncate();
		assert_eq!(rollback.disposition, OmpTurnDisposition::RolledBack {
			cause: OmpRollbackCause::TruncatedStream,
		});
		let mut cancelled = OmpTurnReceipt { accepted: true, ..Default::default() };
		cancelled.cancel();
		assert_eq!(cancelled.disposition, OmpTurnDisposition::RolledBack {
			cause: OmpRollbackCause::ClientCancelled,
		});
	}

	#[test]
	fn empty_output_failure_preserves_machine_readable_identity() {
		let mut decoder = OmpNativeDecoder::new();
		let mut events = Vec::new();
		decoder.failure(
			pb::TurnError { kind: turn_error::Kind::EmptyOutput as i32, ..Default::default() },
			&mut |event| events.push(event),
		);

		assert!(events.into_iter().any(|event| matches!(
			event,
			RawEvent::Failure(Error { kind: ErrorKind::EmptyOutput, .. })
		)));
	}

	#[test]
	fn protobuf_framing_is_bounded_and_exact() {
		let frame = pb::TurnFrame {
			frame: Some(turn_frame::Frame::Open(pb::TurnRequest {
				turn_id: "turn".into(),
				input: Some(turn_request::Input::Seed(pb::Seed {
					context_id: String::new(),
					thread:     Some(Default::default()),
				})),
				..Default::default()
			})),
		};
		let encoded = encode_turn_frame(&frame).expect("frame");
		assert_eq!(encoded[0], 0);
		assert_eq!(
			u32::from_be_bytes(encoded[1..5].try_into().expect("length")) as usize,
			encoded.len() - 5
		);
		assert_eq!(pb::TurnFrame::decode(&encoded[5..]).expect("payload"), frame);
	}
}
