//! Allocation-free preflight validation for extension-host protobuf frames.
//!
//! The validators in this module inspect borrowed encoded bytes before `prost`
//! decodes them. They enforce transport, length, repetition,
//! streaming-argument, and TML limits without constructing a protobuf message.

use strum::IntoStaticStr;
use thiserror::Error;

/// Largest encoded extension-host frame accepted by the protocol (64 MiB).
pub const FRAME_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Largest individual length-delimited field accepted by the generic preflight.
pub const FIELD_MAX_BYTES: usize = FRAME_MAX_BYTES;
/// Largest number of length-delimited fields accepted in one protobuf message.
pub const LENGTH_DELIMITED_MAX_COUNT: usize = 4_096;
/// Default ceiling for a repeated length-delimited protobuf field.
pub const REPEATED_MAX_COUNT: usize = 1_024;
/// Largest protobuf message nesting depth inspected by the preflight.
pub const PROTOBUF_MAX_DEPTH: usize = 32;

/// Largest number of declarations in one registration collection.
pub const DECLARATION_MAX_COUNT: usize = 256;
/// Largest number of examples declared for one tool.
pub const TOOL_EXAMPLE_MAX_COUNT: usize = 256;
/// Largest number of segments in a streaming argument pull path.
pub const PULL_PATH_MAX_SEGMENTS: usize = 128;
/// Largest UTF-8 byte length of one pull path segment or alias.
pub const PULL_NAME_MAX_BYTES: usize = 1_024;
/// Largest number of aliases in one streaming argument pull.
pub const PULL_ALIAS_MAX_COUNT: usize = 16;
/// Largest byte length of a streaming argument expected-shape label.
pub const PULL_EXPECTED_MAX_BYTES: usize = 256;
/// Largest decoded prefix carried by one streaming argument reply.
pub const PULL_CHUNK_MAX_BYTES: usize = 64 * 1024;
/// Largest result payload chunk accepted from an extension worker.
///
/// Keeping result frames at the same fixed granularity as cursor replies lets
/// the host apply filesystem backpressure without retaining the result in RAM.
pub const RESULT_CHUNK_MAX_BYTES: usize = 64 * 1024;
/// Largest TML source accepted by an extension-facing UI frame.
pub const TML_MAX_BYTES: usize = 262_144;
/// Largest syntactic nesting depth accepted in TML source.
pub const TML_MAX_DEPTH: usize = 64;

/// A connection-level failure found before protobuf decoding.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum FrameBoundsError {
	/// The complete encoded frame exceeds [`FRAME_MAX_BYTES`].
	#[error("encoded frame is {actual} bytes; limit is {limit}")]
	FrameTooLarge {
		/// Encoded frame size.
		actual: usize,
		/// Maximum accepted frame size.
		limit:  usize,
	},
	/// A protobuf key or value contains an unterminated or overflowing varint.
	#[error("malformed protobuf varint at byte {offset}")]
	MalformedVarint {
		/// Byte offset where the varint starts.
		offset: usize,
	},
	/// A protobuf key used reserved field number zero or exceeded the wire
	/// range.
	#[error("invalid protobuf field {field} at byte {offset}")]
	InvalidFieldNumber {
		/// Byte offset where the key starts.
		offset: usize,
		/// Decoded invalid field number.
		field:  u64,
	},
	/// A protobuf key used a reserved wire type.
	#[error("invalid protobuf wire type {wire_type} at byte {offset}")]
	InvalidWireType {
		/// Byte offset where the key starts.
		offset:    usize,
		/// Decoded reserved wire type.
		wire_type: u8,
	},
	/// A length prefix cannot be represented by this process.
	#[error("protobuf length {declared} at byte {offset} is not representable")]
	LengthOverflow {
		/// Byte offset where the length starts.
		offset:   usize,
		/// Decoded length that cannot be represented.
		declared: u64,
	},
	/// A fixed-width or length-delimited value extends past its containing
	/// message.
	#[error("protobuf value at byte {offset} needs {needed} bytes; {remaining} remain")]
	Truncated {
		/// Byte offset where the value starts.
		offset:    usize,
		/// Number of bytes declared or required.
		needed:    usize,
		/// Number of bytes available in the containing message.
		remaining: usize,
	},
	/// One length-delimited field exceeds its applicable byte ceiling.
	#[error("{message} field {field} is {actual} bytes; limit is {limit}")]
	FieldTooLarge {
		/// Protobuf message containing the field.
		message: &'static str,
		/// Protobuf field number.
		field:   u32,
		/// Encoded field payload size.
		actual:  usize,
		/// Maximum accepted payload size.
		limit:   usize,
	},
	/// One message contains too many length-delimited fields.
	#[error("{message} has {actual} length-delimited fields; limit is {limit}")]
	TooManyLengthDelimitedFields {
		/// Protobuf message containing the fields.
		message: &'static str,
		/// Number of fields observed.
		actual:  usize,
		/// Maximum accepted field count.
		limit:   usize,
	},
	/// One repeated field exceeds its applicable element ceiling.
	#[error("{message} field {field} has {actual} values; limit is {limit}")]
	TooManyRepeatedValues {
		/// Protobuf message containing the repeated field.
		message: &'static str,
		/// Protobuf field number.
		field:   u32,
		/// Number of values observed.
		actual:  usize,
		/// Maximum accepted value count.
		limit:   usize,
	},
	/// Nested protobuf messages exceed [`PROTOBUF_MAX_DEPTH`].
	#[error("protobuf nesting depth is {actual}; limit is {limit}")]
	ProtobufTooDeep {
		/// First nesting depth beyond the limit.
		actual: usize,
		/// Maximum accepted nesting depth.
		limit:  usize,
	},

	/// `PullRequest.chunk_bytes` exceeds [`PULL_CHUNK_MAX_BYTES`].
	#[error("PullRequest.chunk_bytes is {actual}; limit is {limit}")]
	PullChunkTooLarge {
		/// Requested chunk size.
		actual: u64,
		/// Maximum accepted chunk size.
		limit:  usize,
	},
	/// A TML source exceeds [`TML_MAX_BYTES`].
	#[error("TML source is {actual} bytes; limit is {limit}")]
	TmlTooLarge {
		/// Encoded TML source size.
		actual: usize,
		/// Maximum accepted source size.
		limit:  usize,
	},
	/// A TML source exceeds [`TML_MAX_DEPTH`].
	#[error("TML depth is {actual}; limit is {limit}")]
	TmlTooDeep {
		/// First nesting depth beyond the limit.
		actual: usize,
		/// Maximum accepted nesting depth.
		limit:  usize,
	},
}

/// Validates an encoded `omp.toolhost.v1.HostFrame` before `prost` decoding.
///
/// The scan is allocation-free and bounded by the encoded frame size. Any
/// failure is a connection-level protocol error; callers must not decode the
/// rejected bytes.
pub fn validate_host_frame(encoded: &[u8]) -> Result<(), FrameBoundsError> {
	validate_frame(encoded, MessageKind::HostFrame)
}

/// Validates an encoded `omp.toolhost.v1.WorkerFrame` before `prost` decoding.
///
/// The scan is allocation-free and bounded by the encoded frame size. Any
/// failure is a connection-level protocol error; callers must not decode the
/// rejected bytes.
pub fn validate_worker_frame(encoded: &[u8]) -> Result<(), FrameBoundsError> {
	validate_frame(encoded, MessageKind::WorkerFrame)
}

fn validate_frame(encoded: &[u8], kind: MessageKind) -> Result<(), FrameBoundsError> {
	if encoded.len() > FRAME_MAX_BYTES {
		return Err(FrameBoundsError::FrameTooLarge {
			actual: encoded.len(),
			limit:  FRAME_MAX_BYTES,
		});
	}
	scan_message(encoded, kind, 0)
}

/// Protobuf message vocabulary labelling preflight bounds errors.
///
/// The strum-emitted string (via `into_str`) is the wire-facing message name
/// reported in [`FrameBoundsError`] diagnostics.
#[derive(Clone, Copy, IntoStaticStr)]
#[strum(const_into_str)]
enum MessageKind {
	HostFrame,
	WorkerFrame,
	#[strum(serialize = "LifecycleHostEnvelope")]
	LifecycleHost,
	#[strum(serialize = "LifecycleWorkerEnvelope")]
	LifecycleWorker,
	AdmitExtensions,
	SetAvailability,

	#[strum(serialize = "ArgumentHostEnvelope")]
	ArgumentHost,
	#[strum(serialize = "ArgumentWorkerEnvelope")]
	ArgumentWorker,
	#[strum(serialize = "HookHostEnvelope")]
	HookHost,
	#[strum(serialize = "HookWorkerEnvelope")]
	HookWorker,
	#[strum(serialize = "ProjectionHostEnvelope")]
	ProjectionHost,
	#[strum(serialize = "ProjectionWorkerEnvelope")]
	ProjectionWorker,
	#[strum(serialize = "UiHostEnvelope")]
	UiHost,
	#[strum(serialize = "UiWorkerEnvelope")]
	UiWorker,
	#[strum(serialize = "ContextHostEnvelope")]
	ContextHost,
	#[strum(serialize = "ContextWorkerEnvelope")]
	ContextWorker,
	#[strum(serialize = "ResultWorkerEnvelope")]
	ResultWorker,
	RegisterTools,
	ToolDecl,
	ToolExample,
	ToolResultStart,
	ToolResultChunk,
	PullRequest,
	PullReply,
	ArgIssue,
	Subscribe,
	Dispatch,
	SubscriptionSpec,
	When,

	UiEffect,
	UiRequest,
	UiDispatchResult,
	UiResponse,
	UiDispatch,

	MountSlot,
	PatchNode,
	SetStatus,
	ShowOverlay,
	Dialog,
	RenderedView,
	RegisterUi,
	ContextView,
	ThreadProjectionRequest,
	CompactionRequest,
	ContextPatch,
	Prune,
	Reorder,

	Replace,
	Insert,
	PromptContribution,
	RegisterSlots,
	FetchedItem,
	MessageRef,
	#[strum(serialize = "omp.thread.v1.Item")]
	ThreadItem,
	#[strum(serialize = "omp.thread.v1.Message")]
	ThreadMessage,
	#[strum(serialize = "omp.thread.v1.Part")]
	ThreadPart,
	#[strum(serialize = "omp.thread.v1.ToolResult")]
	ThreadToolResult,
	#[strum(serialize = "omp.inference.v1.ValueMap")]
	ValueMap,
	#[strum(serialize = "omp.inference.v1.ValueMap.fields entry")]
	ValueMapEntry,
	#[strum(serialize = "omp.inference.v1.Value")]
	Value,
	#[strum(serialize = "omp.inference.v1.ValueList")]
	ValueList,

	Tml,
	Generic,
}

#[derive(Clone, Copy)]
enum LengthRule {
	Bytes(usize),
	Message(MessageKind),
	RepeatedBytes { max_count: usize, max_bytes: usize },
	RepeatedMessage { max_count: usize, kind: MessageKind },
	PackedVarints(usize),
	TmlSource,
}

fn scan_message(encoded: &[u8], kind: MessageKind, depth: usize) -> Result<(), FrameBoundsError> {
	if depth > PROTOBUF_MAX_DEPTH {
		return Err(FrameBoundsError::ProtobufTooDeep { actual: depth, limit: PROTOBUF_MAX_DEPTH });
	}

	let mut cursor = Cursor::new(encoded);
	let mut length_count = 0_usize;
	let mut field_counts = [0_usize; 32];
	while !cursor.is_empty() {
		let key_offset = cursor.offset();
		let key = cursor.varint()?;
		let field64 = key >> 3;
		if field64 == 0 || field64 > 0x1fff_ffff {
			return Err(FrameBoundsError::InvalidFieldNumber { offset: key_offset, field: field64 });
		}
		let field = field64 as u32;
		let wire_type = (key & 7) as u8;
		match wire_type {
			0 => {
				let value = cursor.varint()?;
				if matches!(kind, MessageKind::PullRequest)
					&& field == 6
					&& value > PULL_CHUNK_MAX_BYTES as u64
				{
					return Err(FrameBoundsError::PullChunkTooLarge {
						actual: value,
						limit:  PULL_CHUNK_MAX_BYTES,
					});
				}
			},
			1 => cursor.skip_fixed(8)?,
			2 => {
				length_count += 1;
				if length_count > LENGTH_DELIMITED_MAX_COUNT {
					return Err(FrameBoundsError::TooManyLengthDelimitedFields {
						message: kind.into_str(),
						actual:  length_count,
						limit:   LENGTH_DELIMITED_MAX_COUNT,
					});
				}
				let length_offset = cursor.offset();
				let declared = cursor.varint()?;
				let length = usize::try_from(declared)
					.map_err(|_| FrameBoundsError::LengthOverflow { offset: length_offset, declared })?;
				let payload = cursor.take(length)?;
				let count = if (field as usize) < field_counts.len() {
					field_counts[field as usize] += 1;
					field_counts[field as usize]
				} else {
					1
				};
				apply_length_rule(kind, field, count, payload, depth)?;
			},
			5 => cursor.skip_fixed(4)?,
			_ => {
				return Err(FrameBoundsError::InvalidWireType { offset: key_offset, wire_type });
			},
		}
	}
	Ok(())
}

fn apply_length_rule(
	kind: MessageKind,
	field: u32,
	count: usize,
	payload: &[u8],
	depth: usize,
) -> Result<(), FrameBoundsError> {
	let rule = length_rule(kind, field).unwrap_or(LengthRule::Bytes(FIELD_MAX_BYTES));
	match rule {
		LengthRule::Bytes(limit) => check_field_bytes(kind, field, payload.len(), limit),
		LengthRule::Message(child) => {
			check_field_bytes(kind, field, payload.len(), FIELD_MAX_BYTES)?;
			scan_message(payload, child, depth + 1)
		},
		LengthRule::RepeatedBytes { max_count, max_bytes } => {
			check_repeated(kind, field, count, max_count)?;
			check_field_bytes(kind, field, payload.len(), max_bytes)
		},
		LengthRule::RepeatedMessage { max_count, kind: child } => {
			check_repeated(kind, field, count, max_count)?;
			check_field_bytes(kind, field, payload.len(), FIELD_MAX_BYTES)?;
			scan_message(payload, child, depth + 1)
		},
		LengthRule::PackedVarints(limit) => {
			check_field_bytes(kind, field, payload.len(), FIELD_MAX_BYTES)?;
			let mut packed = Cursor::new(payload);
			let mut values = 0_usize;
			while !packed.is_empty() {
				packed.varint()?;
				values += 1;
				check_repeated(kind, field, values, limit)?;
			}
			Ok(())
		},
		LengthRule::TmlSource => {
			if payload.len() > TML_MAX_BYTES {
				return Err(FrameBoundsError::TmlTooLarge {
					actual: payload.len(),
					limit:  TML_MAX_BYTES,
				});
			}
			scan_tml_depth(payload)
		},
	}
}

const fn check_field_bytes(
	kind: MessageKind,
	field: u32,
	actual: usize,
	limit: usize,
) -> Result<(), FrameBoundsError> {
	if actual > limit {
		Err(FrameBoundsError::FieldTooLarge { message: kind.into_str(), field, actual, limit })
	} else {
		Ok(())
	}
}

const fn check_repeated(
	kind: MessageKind,
	field: u32,
	actual: usize,
	limit: usize,
) -> Result<(), FrameBoundsError> {
	if actual > limit {
		Err(FrameBoundsError::TooManyRepeatedValues {
			message: kind.into_str(),
			field,
			actual,
			limit,
		})
	} else {
		Ok(())
	}
}

const fn length_rule(kind: MessageKind, field: u32) -> Option<LengthRule> {
	use LengthRule::{Bytes, Message, PackedVarints, RepeatedBytes, RepeatedMessage, TmlSource};
	use MessageKind as M;
	match (kind, field) {
		(M::HostFrame, 2..=4) => Some(Message(M::Generic)),
		(M::HostFrame, 5) => Some(Message(M::LifecycleHost)),
		(M::HostFrame, 6) => Some(Message(M::ArgumentHost)),
		(M::HostFrame, 7) => Some(Message(M::HookHost)),
		(M::HostFrame, 8) => Some(Message(M::ProjectionHost)),
		(M::HostFrame, 9) => Some(Message(M::UiHost)),
		(M::HostFrame, 10) => Some(Message(M::ContextHost)),
		(M::HostFrame, 11..=14) => Some(Message(M::Generic)),
		(M::HostFrame, 15) => Some(Message(M::ValueMap)),

		(M::WorkerFrame, 2) => Some(Message(M::Generic)),
		(M::WorkerFrame, 3) => Some(Message(M::RegisterTools)),
		(M::WorkerFrame, 4..=9) => Some(Message(M::Generic)),
		(M::WorkerFrame, 10) => Some(Message(M::LifecycleWorker)),
		(M::WorkerFrame, 11) => Some(Message(M::ArgumentWorker)),
		(M::WorkerFrame, 12) => Some(Message(M::HookWorker)),
		(M::WorkerFrame, 13) => Some(Message(M::ProjectionWorker)),
		(M::WorkerFrame, 14) => Some(Message(M::UiWorker)),
		(M::WorkerFrame, 15) => Some(Message(M::ValueMap)),

		(M::WorkerFrame, 16) => Some(Message(M::ContextWorker)),
		(M::WorkerFrame, 17..=21) => Some(Message(M::Generic)),
		(M::WorkerFrame, 22) => Some(Message(M::ResultWorker)),

		(M::LifecycleHost, 1) => Some(Message(M::AdmitExtensions)),
		(M::LifecycleWorker, 1) => Some(Message(M::SetAvailability)),
		(M::AdmitExtensions | M::SetAvailability, 1) => {
			Some(RepeatedMessage { max_count: DECLARATION_MAX_COUNT, kind: M::Generic })
		},
		(M::ArgumentHost, 1..=3) => Some(Message(M::Generic)),
		(M::ArgumentHost, 4) => Some(Message(M::PullReply)),
		(M::ArgumentWorker, 1) => Some(Message(M::PullRequest)),
		(M::ArgumentWorker, 2) => Some(Message(M::Generic)),

		(M::HookHost, 1) => Some(Message(M::Dispatch)),
		(M::HookHost, 2..=4) => Some(Message(M::Generic)),
		(M::HookWorker, 1) => Some(Message(M::Subscribe)),
		(M::HookWorker, 2..=6) => Some(Message(M::Generic)),
		(M::Subscribe, 1) => Some(PackedVarints(REPEATED_MAX_COUNT)),
		(M::Subscribe, 2) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::SubscriptionSpec })
		},

		(M::Dispatch, 7) => Some(PackedVarints(REPEATED_MAX_COUNT)),
		(M::SubscriptionSpec, 5) => Some(Message(M::When)),
		(M::When, 1..=4) => {
			Some(RepeatedBytes { max_count: REPEATED_MAX_COUNT, max_bytes: FIELD_MAX_BYTES })
		},

		(M::ProjectionHost, 1..=3) => Some(Message(M::Generic)),
		(M::ProjectionWorker, 1..=2) => Some(Message(M::Generic)),
		(M::ProjectionWorker, 3) => Some(Message(M::RenderedView)),

		(M::UiHost, 1) => Some(Message(M::UiResponse)),
		(M::UiHost, 2) => Some(Message(M::UiDispatch)),

		(M::UiWorker, 1) => Some(Message(M::RegisterUi)),
		(M::UiWorker, 2) => Some(Message(M::UiEffect)),
		(M::UiWorker, 3) => Some(Message(M::UiRequest)),
		(M::UiWorker, 4) => Some(Message(M::UiDispatchResult)),
		(M::UiResponse, 1..=7) | (M::UiDispatch, 1..=5) => Some(Message(M::Generic)),
		(M::UiEffect, 1) => Some(Message(M::MountSlot)),
		(M::UiEffect, 3) => Some(Message(M::PatchNode)),
		(M::UiEffect, 4) => Some(Message(M::SetStatus)),
		(M::UiEffect, 2 | 5..=13) => Some(Message(M::Generic)),
		(M::PatchNode, 4) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::Generic })
		},

		(M::UiRequest, 2) => Some(Message(M::ShowOverlay)),
		(M::UiRequest, 5) => Some(Message(M::Dialog)),
		(M::UiRequest, 3..=4 | 6..=8) => Some(Message(M::Generic)),
		(M::UiDispatchResult, 1 | 3) => Some(Message(M::Generic)),
		(M::UiDispatchResult, 2) => Some(Message(M::RenderedView)),
		(M::UiDispatchResult, 4) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::Generic })
		},
		(M::MountSlot | M::PatchNode, 3) | (M::SetStatus, 1) => Some(Message(M::Tml)),
		(M::ShowOverlay, 2) | (M::Dialog, 3) | (M::RenderedView, 1) => Some(Message(M::Tml)),
		(M::ShowOverlay, 3) => Some(Message(M::ValueMap)),

		(M::Tml, 1) => Some(TmlSource),
		(M::RegisterUi, 1..=4) => {
			Some(RepeatedMessage { max_count: DECLARATION_MAX_COUNT, kind: M::Generic })
		},

		(M::ContextHost, 1) => Some(Message(M::ThreadProjectionRequest)),
		(M::ContextHost, 2) => Some(Message(M::CompactionRequest)),
		(M::ContextHost, 3..=4) => Some(Message(M::Generic)),
		(M::ContextHost, 5) => Some(Message(M::FetchedItem)),
		(M::ContextWorker, 1) => Some(Message(M::ContextPatch)),
		(M::ContextWorker, 2) => Some(Message(M::Generic)),
		(M::ContextWorker, 3) => Some(Message(M::PromptContribution)),
		(M::ContextWorker, 4) => Some(Message(M::RegisterSlots)),
		(M::ContextWorker, 5) => Some(Message(M::Generic)),
		(M::ThreadProjectionRequest, 1) => Some(Message(M::ContextView)),
		(M::ContextView, 6) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::MessageRef })
		},

		(M::ContextView, 7) => Some(Message(M::Generic)),
		(M::CompactionRequest, 8..=9) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::MessageRef })
		},

		(M::ContextPatch, 1) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::Prune })
		},

		(M::ContextPatch, 2) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::Replace })
		},
		(M::ContextPatch, 3) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::Insert })
		},
		(M::ContextPatch, 4) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::Reorder })
		},

		(M::Replace, 1) => {
			Some(RepeatedBytes { max_count: REPEATED_MAX_COUNT, max_bytes: FIELD_MAX_BYTES })
		},
		(M::Prune | M::Reorder, 1) => {
			Some(RepeatedBytes { max_count: REPEATED_MAX_COUNT, max_bytes: FIELD_MAX_BYTES })
		},
		(M::Replace | M::PromptContribution, 2) | (M::Insert, 1) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::ThreadPart })
		},

		(M::RegisterSlots, 1) => {
			Some(RepeatedMessage { max_count: DECLARATION_MAX_COUNT, kind: M::Generic })
		},
		(M::FetchedItem, 1) => Some(Message(M::ThreadItem)),
		(M::MessageRef, 19) => {
			Some(RepeatedBytes { max_count: REPEATED_MAX_COUNT, max_bytes: FIELD_MAX_BYTES })
		},

		(M::RegisterTools, 1) => {
			Some(RepeatedMessage { max_count: DECLARATION_MAX_COUNT, kind: M::ToolDecl })
		},
		(M::RegisterTools, 3..=5) => {
			Some(RepeatedMessage { max_count: DECLARATION_MAX_COUNT, kind: M::Generic })
		},
		(M::ToolDecl, 1 | 3) => Some(Message(M::Generic)),
		(M::ToolDecl, 6) => {
			Some(RepeatedBytes { max_count: DECLARATION_MAX_COUNT, max_bytes: FIELD_MAX_BYTES })
		},
		(M::ToolDecl, 9) => {
			Some(RepeatedMessage { max_count: TOOL_EXAMPLE_MAX_COUNT, kind: M::ToolExample })
		},
		(M::ToolExample, 1) => Some(Bytes(FIELD_MAX_BYTES)),
		(M::ResultWorker, 1) => Some(Message(M::ToolResultStart)),
		(M::ResultWorker, 2) => Some(Message(M::ToolResultChunk)),
		(M::ResultWorker, 3) => Some(Message(M::Generic)),
		(M::ToolResultStart, 2) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::ThreadPart })
		},
		(M::ToolResultStart, 4) => Some(Message(M::ArgIssue)),
		(M::ToolResultChunk, 2) => Some(Bytes(RESULT_CHUNK_MAX_BYTES)),
		(M::ArgIssue, 1) => {
			Some(RepeatedBytes { max_count: PULL_PATH_MAX_SEGMENTS, max_bytes: PULL_NAME_MAX_BYTES })
		},
		(M::PullRequest, 2) => {
			Some(RepeatedBytes { max_count: PULL_PATH_MAX_SEGMENTS, max_bytes: PULL_NAME_MAX_BYTES })
		},
		(M::PullRequest, 3) => Some(Bytes(PULL_NAME_MAX_BYTES)),
		(M::PullRequest, 4) => {
			Some(RepeatedBytes { max_count: PULL_ALIAS_MAX_COUNT, max_bytes: PULL_NAME_MAX_BYTES })
		},
		(M::PullRequest, 5) => Some(Bytes(PULL_EXPECTED_MAX_BYTES)),
		(M::PullReply, 2) => Some(Bytes(PULL_CHUNK_MAX_BYTES)),
		(M::PullReply, 4) => Some(Message(M::ArgIssue)),

		(M::ThreadItem, 2) => Some(Message(M::ThreadMessage)),
		(M::ThreadItem, 3) => Some(Message(M::Generic)),
		(M::ThreadItem, 4) => Some(Message(M::ThreadToolResult)),
		(M::ThreadMessage, 2) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::ThreadPart })
		},
		(M::ThreadPart, 2..=5) => Some(Message(M::Generic)),
		(M::ThreadToolResult, 2) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::ThreadPart })
		},
		(M::ThreadToolResult, 5) => Some(Message(M::Value)),
		(M::ValueMap, 1) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::ValueMapEntry })
		},
		(M::ValueMapEntry, 2) => Some(Message(M::Value)),
		(M::Value, 6) => Some(Message(M::ValueList)),
		(M::Value, 7) => Some(Message(M::ValueMap)),
		(M::ValueList, 1) => {
			Some(RepeatedMessage { max_count: REPEATED_MAX_COUNT, kind: M::Value })
		},

		(_, 15) => Some(Message(M::ValueMap)),

		_ => None,
	}
}

fn scan_tml_depth(source: &[u8]) -> Result<(), FrameBoundsError> {
	let mut at = 0_usize;
	let mut depth = 0_usize;
	while at < source.len() {
		let Some(relative) = source[at..].iter().position(|&byte| byte == b'<') else {
			break;
		};
		at += relative;
		if source[at..].starts_with(b"<!--") {
			let Some(end) = find_bytes(&source[at + 4..], b"-->") else {
				break;
			};
			at += 4 + end + 3;
			continue;
		}
		let mut cursor = at + 1;
		let closing = source.get(cursor) == Some(&b'/');
		if closing {
			cursor += 1;
		}
		if !source.get(cursor).is_some_and(u8::is_ascii_alphabetic) {
			at += 1;
			continue;
		}
		cursor += 1;
		while source
			.get(cursor)
			.is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
		{
			cursor += 1;
		}
		if !source
			.get(cursor)
			.is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>' || *byte == b'/')
		{
			at += 1;
			continue;
		}
		let Some(close) = tag_close(source, cursor) else {
			break;
		};
		let self_closing = source[cursor..close]
			.iter()
			.rev()
			.find(|byte| !byte.is_ascii_whitespace())
			== Some(&b'/');
		if closing {
			depth = depth.saturating_sub(1);
		} else if !self_closing {
			depth += 1;
			if depth > TML_MAX_DEPTH {
				return Err(FrameBoundsError::TmlTooDeep { actual: depth, limit: TML_MAX_DEPTH });
			}
		}
		at = close + 1;
	}
	Ok(())
}

const fn tag_close(source: &[u8], mut at: usize) -> Option<usize> {
	while at < source.len() {
		match source[at] {
			b'>' => return Some(at),
			quote @ (b'\'' | b'"') => {
				at += 1;
				while at < source.len() && source[at] != quote {
					at += 1;
				}
				if at == source.len() {
					return None;
				}
			},
			_ => {},
		}
		at += 1;
	}
	None
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	if needle.is_empty() {
		return Some(0);
	}
	haystack
		.windows(needle.len())
		.position(|window| window == needle)
}

struct Cursor<'a> {
	remaining: &'a [u8],
	offset:    usize,
}

impl<'a> Cursor<'a> {
	const fn new(encoded: &'a [u8]) -> Self {
		Self { remaining: encoded, offset: 0 }
	}

	const fn is_empty(&self) -> bool {
		self.remaining.is_empty()
	}

	const fn offset(&self) -> usize {
		self.offset
	}

	fn varint(&mut self) -> Result<u64, FrameBoundsError> {
		let start = self.offset;
		let mut value = 0_u64;
		for shift in (0..70).step_by(7) {
			let Some((&byte, rest)) = self.remaining.split_first() else {
				return Err(FrameBoundsError::MalformedVarint { offset: start });
			};
			self.remaining = rest;
			self.offset += 1;
			if shift == 63 && byte > 1 {
				return Err(FrameBoundsError::MalformedVarint { offset: start });
			}
			value |= u64::from(byte & 0x7f) << shift;
			if byte & 0x80 == 0 {
				return Ok(value);
			}
		}
		Err(FrameBoundsError::MalformedVarint { offset: start })
	}

	const fn take(&mut self, length: usize) -> Result<&'a [u8], FrameBoundsError> {
		if self.remaining.len() < length {
			return Err(FrameBoundsError::Truncated {
				offset:    self.offset,
				needed:    length,
				remaining: self.remaining.len(),
			});
		}
		let (value, rest) = self.remaining.split_at(length);
		self.remaining = rest;
		self.offset += length;
		Ok(value)
	}

	fn skip_fixed(&mut self, length: usize) -> Result<(), FrameBoundsError> {
		self.take(length).map(|_| ())
	}
}
