//! Shared incremental transport framing contracts.

use std::io::Cursor;

use bytes::Bytes;
use smallvec::SmallVec;
use thiserror::Error;
use xutf::BufReadCharsExt as _;

use super::{
	connect::ConnectEnvelope, eventstream::EventStreamMessage, sse::SseEvent,
	websocket::WebSocketMessage,
};

/// Default maximum size of one framed transport record.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Transport protocol whose framing failed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FramingProtocol {
	/// Bounded unframed unary payload.
	Raw,
	/// Bounded pass-through response chunks for streamed binary media.
	RawChunks,

	/// Server-Sent Events.
	Sse,
	/// Newline-delimited JSON.
	Ndjson,
	/// WebSocket messages.
	WebSocket,
	/// Connect protocol envelopes.
	Connect,
	/// AWS `EventStream` messages.
	AwsEventStream,
}

/// A field whose bytes must contain well-formed UTF-8.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Utf8Field {
	/// An SSE event name.
	SseEventName,
	/// An SSE event identifier.
	SseEventId,
	/// A WebSocket text message.
	WebSocketText,
	/// A WebSocket close reason.
	WebSocketCloseReason,
	/// An AWS `EventStream` string header.
	EventStreamHeader,
}

/// CRC-bearing portion of an AWS `EventStream` message.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CrcScope {
	/// The eight-byte `EventStream` prelude.
	Prelude,
	/// The complete `EventStream` message except its trailing CRC.
	Message,
}

/// Typed corruption and lifecycle failures produced by transport framers.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum FramingError {
	/// A chunk was supplied after normal end-of-stream.
	#[error("{protocol:?} input arrived after end-of-stream")]
	AfterEnd {
		/// Protocol receiving the late input.
		protocol: FramingProtocol,
	},
	/// The consumer cancelled the framing stream.
	#[error("{protocol:?} framing was cancelled")]
	Cancelled {
		/// Cancelled protocol.
		protocol: FramingProtocol,
	},
	/// A frame exceeded its configured memory bound.
	#[error("{protocol:?} frame exceeded {limit} bytes (observed {observed})")]
	LimitExceeded {
		/// Protocol whose frame exceeded the bound.
		protocol: FramingProtocol,
		/// Configured frame limit.
		limit:    usize,
		/// Observed or declared frame size.
		observed: usize,
	},
	/// End-of-stream cut a declared or delimited frame short.
	#[error("{protocol:?} stream ended with {available} of {declared} required bytes")]
	UnexpectedEof {
		/// Protocol whose frame was truncated.
		protocol:    FramingProtocol,
		/// Total bytes required for the incomplete frame.
		declared:    usize,
		/// Bytes available for that frame.
		available:   usize,
		/// Whether no complete frame had yet been emitted.
		first_frame: bool,
	},
	/// Reserved or structurally invalid flag bits were present.
	#[error("{protocol:?} envelope has invalid flags {flags:#04x}")]
	InvalidFlags {
		/// Protocol whose flags were invalid.
		protocol: FramingProtocol,
		/// Invalid flags byte.
		flags:    u8,
	},
	/// A message opcode violated WebSocket fragmentation rules.
	#[error("invalid WebSocket opcode or fragmentation transition ({opcode:#04x})")]
	InvalidWebSocketOpcode {
		/// Offending opcode.
		opcode: u8,
	},
	/// A WebSocket payload length used a longer-than-minimal encoding.
	#[error("non-canonical WebSocket payload length {payload} encoded in {encoded_bytes} bytes")]
	NonCanonicalWebSocketLength {
		/// Number of extended length bytes used on the wire.
		encoded_bytes: u8,
		/// Decoded payload length.
		payload:       u64,
	},
	/// A WebSocket control message violated its fixed framing rules.
	#[error("invalid WebSocket control frame")]
	InvalidWebSocketControl,
	/// A WebSocket close payload was structurally invalid.
	#[error("invalid WebSocket close payload")]
	InvalidWebSocketClose,
	/// A textual field was not well-formed UTF-8.
	#[error("{protocol:?} {field:?} is not valid UTF-8")]
	InvalidUtf8 {
		/// Protocol carrying the text.
		protocol: FramingProtocol,
		/// Textual field that failed validation.
		field:    Utf8Field,
	},
	/// An AWS `EventStream` CRC did not match the encoded bytes.
	#[error(
		"AWS EventStream {scope:?} CRC mismatch: expected {expected:#010x}, actual {actual:#010x}"
	)]
	CrcMismatch {
		/// CRC-bearing region.
		scope:    CrcScope,
		/// CRC stored in the message.
		expected: u32,
		/// CRC calculated from the message bytes.
		actual:   u32,
	},
	/// AWS `EventStream` lengths could not describe a valid message.
	#[error("invalid AWS EventStream lengths: total={total}, headers={headers}")]
	InvalidEventStreamLengths {
		/// Declared total message length.
		total:   usize,
		/// Declared headers length.
		headers: usize,
	},
	/// An AWS `EventStream` header was malformed.
	#[error("invalid AWS EventStream header at byte {offset}")]
	InvalidEventStreamHeader {
		/// Byte offset within the encoded header block.
		offset: usize,
	},
	/// An AWS `EventStream` header used an unknown value type.
	#[error("unknown AWS EventStream header value type {kind}")]
	UnknownEventStreamHeaderType {
		/// Unknown header type tag.
		kind: u8,
	},
}

/// One protocol-neutral frame emitted by a concrete framer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Frame {
	/// Complete bounded unframed unary payload.
	Raw(Bytes),

	/// Server-Sent Event.
	Sse(SseEvent),
	/// Newline-delimited JSON record.
	Ndjson(Bytes),
	/// Complete WebSocket message.
	WebSocket(WebSocketMessage),
	/// Connect protocol envelope.
	Connect(ConnectEnvelope),
	/// AWS `EventStream` message.
	EventStream(Box<EventStreamMessage>),
}

/// Common lifecycle contract for bounded incremental byte framers.
pub trait IncrementalFramer {
	/// Concrete frame emitted by this protocol.
	type Frame;

	/// Feeds one transport chunk and returns every newly completed frame.
	fn push(&mut self, chunk: Bytes) -> Result<SmallVec<Self::Frame, 4>, FramingError>;

	/// Ends input, emitting any protocol-defined final record or a truncation
	/// error.
	fn finish(&mut self) -> Result<SmallVec<Self::Frame, 4>, FramingError>;

	/// Cancels parsing and releases retained bytes.
	fn cancel(&mut self);

	/// Returns retained bytes belonging to an incomplete frame.
	fn buffered_len(&self) -> usize;
}

/// Bounded pass-through framer for streaming binary bodies without aggregation.
#[derive(Clone, Debug)]
pub struct RawChunkFramer {
	max_chunk_bytes: usize,
	state:           FramerState,
}

impl RawChunkFramer {
	/// Creates a pass-through framer with an explicit per-chunk bound.
	pub fn new(max_chunk_bytes: usize) -> Self {
		Self { max_chunk_bytes: max_chunk_bytes.max(1), state: FramerState::Open }
	}

	/// Emits a non-empty network chunk as one zero-copy raw payload.
	pub fn push(&mut self, chunk: Bytes) -> Result<SmallVec<Bytes, 4>, FramingError> {
		<Self as IncrementalFramer>::push(self, chunk)
	}

	/// Completes the stream without producing an aggregate payload.
	pub fn finish(&mut self) -> Result<SmallVec<Bytes, 4>, FramingError> {
		<Self as IncrementalFramer>::finish(self)
	}

	/// Cancels the stream.
	pub fn cancel(&mut self) {
		<Self as IncrementalFramer>::cancel(self);
	}

	/// Returns zero because this framer never retains payload bytes.
	pub const fn buffered_len(&self) -> usize {
		0
	}
}

impl IncrementalFramer for RawChunkFramer {
	type Frame = Bytes;

	fn push(&mut self, chunk: Bytes) -> Result<SmallVec<Self::Frame, 4>, FramingError> {
		self.state.ensure_open(FramingProtocol::RawChunks)?;
		if chunk.len() > self.max_chunk_bytes {
			self.state = FramerState::Failed;
			return Err(FramingError::LimitExceeded {
				protocol: FramingProtocol::RawChunks,
				limit:    self.max_chunk_bytes,
				observed: chunk.len(),
			});
		}
		let mut output = SmallVec::new();
		if !chunk.is_empty() {
			output.push(chunk);
		}
		Ok(output)
	}

	fn finish(&mut self) -> Result<SmallVec<Self::Frame, 4>, FramingError> {
		if self.state == FramerState::Finished {
			return Ok(SmallVec::new());
		}
		self.state.ensure_open(FramingProtocol::RawChunks)?;
		self.state = FramerState::Finished;
		Ok(SmallVec::new())
	}

	fn cancel(&mut self) {
		self.state = FramerState::Cancelled;
	}

	fn buffered_len(&self) -> usize {
		0
	}
}

/// Internal lifecycle shared by concrete framing state machines.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum FramerState {
	#[default]
	Open,
	Finished,
	Cancelled,
	Failed,
}

impl FramerState {
	pub(crate) const fn ensure_open(self, protocol: FramingProtocol) -> Result<(), FramingError> {
		match self {
			Self::Open => Ok(()),
			Self::Finished | Self::Failed => Err(FramingError::AfterEnd { protocol }),
			Self::Cancelled => Err(FramingError::Cancelled { protocol }),
		}
	}
}

pub(crate) fn validate_utf8(
	bytes: &[u8],
	protocol: FramingProtocol,
	field: Utf8Field,
) -> Result<(), FramingError> {
	let mut input = Cursor::new(bytes);
	for decoded in input.chars() {
		if decoded.is_err() {
			return Err(FramingError::InvalidUtf8 { protocol, field });
		}
	}
	Ok(())
}
