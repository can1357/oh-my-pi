//! Bounded incremental Connect protocol envelope framing.

use bytes::{Bytes, BytesMut};
use smallvec::SmallVec;

use super::frame::{
	DEFAULT_MAX_FRAME_BYTES, FramerState, FramingError, FramingProtocol, IncrementalFramer,
};

const HEADER_BYTES: usize = 5;
const FLAG_COMPRESSED: u8 = 0x01;
const FLAG_END_STREAM: u8 = 0x02;
const ALLOWED_FLAGS: u8 = FLAG_COMPRESSED | FLAG_END_STREAM;

/// Semantic kind of a Connect envelope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectEnvelopeKind {
	/// Protobuf message payload.
	Message,
	/// Connect end-stream JSON metadata payload.
	EndStream,
}

/// One complete Connect protocol envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectEnvelope {
	/// Original Connect flags byte.
	pub flags:   u8,
	/// Envelope semantic kind.
	pub kind:    ConnectEnvelopeKind,
	/// Payload bytes, excluding the five-byte envelope prefix.
	pub payload: Bytes,
}

impl ConnectEnvelope {
	/// Returns whether the message payload uses negotiated compression.
	pub const fn is_compressed(&self) -> bool {
		self.flags & FLAG_COMPRESSED != 0
	}
}

/// Bounded incremental decoder for Connect's flags-plus-length envelopes.
#[derive(Debug)]
pub struct ConnectDecoder {
	buffer:            BytesMut,
	max_payload_bytes: usize,
	expected_envelope: Option<(u8, usize)>,
	state:             FramerState,
	emitted:           usize,
	ended:             bool,
	pending_error:     Option<FramingError>,
}

impl Default for ConnectDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl ConnectDecoder {
	/// Creates a decoder with the default 16 MiB payload bound.
	pub fn new() -> Self {
		Self::with_max_payload_bytes(DEFAULT_MAX_FRAME_BYTES)
	}

	/// Creates a decoder with an explicit maximum payload size.
	pub fn with_max_payload_bytes(max_payload_bytes: usize) -> Self {
		Self {
			buffer:            BytesMut::new(),
			max_payload_bytes: max_payload_bytes.max(1),
			expected_envelope: None,
			state:             FramerState::Open,
			emitted:           0,
			ended:             false,
			pending_error:     None,
		}
	}

	/// Feeds one byte chunk and emits complete Connect envelopes.
	pub fn push(&mut self, chunk: Bytes) -> Result<SmallVec<ConnectEnvelope, 4>, FramingError> {
		<Self as IncrementalFramer>::push(self, chunk)
	}

	/// Validates that input ended on an envelope boundary.
	pub fn finish(&mut self) -> Result<SmallVec<ConnectEnvelope, 4>, FramingError> {
		<Self as IncrementalFramer>::finish(self)
	}

	/// Cancels parsing and releases retained bytes.
	pub fn cancel(&mut self) {
		<Self as IncrementalFramer>::cancel(self);
	}

	/// Returns retained bytes belonging to an incomplete envelope.
	pub fn buffered_len(&self) -> usize {
		self.buffer.len()
	}

	/// Returns whether an end-stream envelope was consumed.
	pub const fn is_ended(&self) -> bool {
		self.ended
	}

	fn append(&mut self, chunk: Bytes) {
		if chunk.is_empty() {
			return;
		}
		if self.buffer.is_empty() {
			self.buffer = chunk
				.try_into_mut()
				.unwrap_or_else(|chunk| BytesMut::from(chunk.as_ref()));
		} else {
			self.buffer.extend_from_slice(&chunk);
		}
	}

	fn terminal(
		&mut self,
		error: FramingError,
		output: SmallVec<ConnectEnvelope, 4>,
	) -> Result<SmallVec<ConnectEnvelope, 4>, FramingError> {
		self.buffer.clear();
		self.expected_envelope = None;
		self.state = FramerState::Failed;
		if output.is_empty() {
			Err(error)
		} else {
			self.pending_error = Some(error);
			Ok(output)
		}
	}
}

impl IncrementalFramer for ConnectDecoder {
	type Frame = ConnectEnvelope;

	fn push(&mut self, chunk: Bytes) -> Result<SmallVec<Self::Frame, 4>, FramingError> {
		if let Some(error) = self.pending_error.take() {
			return Err(error);
		}
		self.state.ensure_open(FramingProtocol::Connect)?;
		if self.ended && !chunk.is_empty() {
			return self.terminal(
				FramingError::AfterEnd { protocol: FramingProtocol::Connect },
				SmallVec::new(),
			);
		}
		self.append(chunk);
		let mut output = SmallVec::new();
		loop {
			if self.buffer.len() < HEADER_BYTES {
				break;
			}
			let (flags, payload_len) = if let Some(expected) = self.expected_envelope {
				expected
			} else {
				let flags = self.buffer[0];
				if flags & !ALLOWED_FLAGS != 0
					|| flags & FLAG_END_STREAM != 0 && flags != FLAG_END_STREAM
				{
					let error = FramingError::InvalidFlags { protocol: FramingProtocol::Connect, flags };
					return self.terminal(error, output);
				}
				let payload_len = usize::try_from(u32::from_be_bytes([
					self.buffer[1],
					self.buffer[2],
					self.buffer[3],
					self.buffer[4],
				]))
				.expect("u32 fits usize");
				if payload_len > self.max_payload_bytes {
					let error = FramingError::LimitExceeded {
						protocol: FramingProtocol::Connect,
						limit:    self.max_payload_bytes,
						observed: payload_len,
					};
					return self.terminal(error, output);
				}
				self.expected_envelope = Some((flags, payload_len));
				(flags, payload_len)
			};
			let envelope_len = HEADER_BYTES + payload_len;
			if self.buffer.len() < envelope_len {
				break;
			}
			let envelope = self.buffer.split_to(envelope_len).freeze();
			self.expected_envelope = None;
			let kind = if flags & FLAG_END_STREAM == 0 {
				ConnectEnvelopeKind::Message
			} else {
				ConnectEnvelopeKind::EndStream
			};
			let payload = envelope.slice(HEADER_BYTES..);
			output.push(ConnectEnvelope { flags, kind, payload });
			self.emitted += 1;
			if kind == ConnectEnvelopeKind::EndStream {
				self.ended = true;
				if !self.buffer.is_empty() {
					let error = FramingError::AfterEnd { protocol: FramingProtocol::Connect };
					return self.terminal(error, output);
				}
				break;
			}
		}
		Ok(output)
	}

	fn finish(&mut self) -> Result<SmallVec<Self::Frame, 4>, FramingError> {
		if let Some(error) = self.pending_error.take() {
			return Err(error);
		}
		if self.state == FramerState::Finished {
			return Ok(SmallVec::new());
		}
		self.state.ensure_open(FramingProtocol::Connect)?;
		if self.buffer.is_empty() {
			self.state = FramerState::Finished;
			return Ok(SmallVec::new());
		}
		let first_frame = self.emitted == 0;
		let error = if self.buffer.len() < HEADER_BYTES {
			FramingError::UnexpectedEof {
				protocol: FramingProtocol::Connect,
				declared: HEADER_BYTES,
				available: self.buffer.len(),
				first_frame,
			}
		} else {
			let declared = self.expected_envelope.map_or_else(
				|| {
					usize::try_from(u32::from_be_bytes([
						self.buffer[1],
						self.buffer[2],
						self.buffer[3],
						self.buffer[4],
					]))
					.expect("u32 fits usize")
				},
				|(_, payload_len)| payload_len,
			);
			FramingError::UnexpectedEof {
				protocol: FramingProtocol::Connect,
				declared,
				available: self.buffer.len() - HEADER_BYTES,
				first_frame,
			}
		};
		self.terminal(error, SmallVec::new())
	}

	fn cancel(&mut self) {
		self.buffer.clear();
		self.expected_envelope = None;
		self.pending_error = None;
		self.state = FramerState::Cancelled;
	}

	fn buffered_len(&self) -> usize {
		self.buffer.len()
	}
}
