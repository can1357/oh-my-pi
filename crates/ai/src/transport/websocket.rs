//! Bounded WebSocket wire framing and fragmented-message assembly.

use bytes::{Bytes, BytesMut};
use smallvec::SmallVec;

use super::frame::{
	DEFAULT_MAX_FRAME_BYTES, FramerState, FramingError, FramingProtocol, IncrementalFramer,
	Utf8Field, validate_utf8,
};

/// WebSocket frame opcode.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum WebSocketOpcode {
	/// Continuation of a fragmented data message.
	Continuation = 0x0,
	/// UTF-8 text data.
	Text         = 0x1,
	/// Binary data.
	Binary       = 0x2,
	/// Connection close control message.
	Close        = 0x8,
	/// Ping control message.
	Ping         = 0x9,
	/// Pong control message.
	Pong         = 0xa,
}

impl TryFrom<u8> for WebSocketOpcode {
	type Error = FramingError;

	fn try_from(value: u8) -> Result<Self, Self::Error> {
		match value {
			0x0 => Ok(Self::Continuation),
			0x1 => Ok(Self::Text),
			0x2 => Ok(Self::Binary),
			0x8 => Ok(Self::Close),
			0x9 => Ok(Self::Ping),
			0xa => Ok(Self::Pong),
			opcode => Err(FramingError::InvalidWebSocketOpcode { opcode }),
		}
	}
}

/// One decoded WebSocket frame supplied by a WebSocket library.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebSocketFragment {
	/// Whether this frame completes its message.
	pub fin:     bool,
	/// Frame opcode.
	pub opcode:  WebSocketOpcode,
	/// Unmasked frame payload.
	pub payload: Bytes,
}

/// One complete WebSocket message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebSocketMessage {
	/// Complete validated UTF-8 text message, retained as zero-copy bytes.
	Text(Bytes),
	/// Complete binary message.
	Binary(Bytes),
	/// Close message with optional status and UTF-8 reason bytes.
	Close {
		/// RFC 6455 status code, absent for an empty close payload.
		code:   Option<u16>,
		/// Validated UTF-8 reason without the status prefix.
		reason: Bytes,
	},
	/// Ping control message.
	Ping(Bytes),
	/// Pong control message.
	Pong(Bytes),
}

/// Whether incoming wire frames are expected to carry a masking key.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum WebSocketMasking {
	/// Accept unmasked server-to-client frames and reject masked frames.
	#[default]
	Unmasked,
	/// Require masked client-to-server frames.
	Masked,
	/// Accept either form, for deterministic cassette replay.
	Either,
}

/// Bounded incremental WebSocket wire decoder and message assembler.
#[derive(Debug)]
pub struct WebSocketDecoder {
	wire:              BytesMut,
	message:           BytesMut,
	message_opcode:    Option<WebSocketOpcode>,
	max_message_bytes: usize,
	masking:           WebSocketMasking,
	state:             FramerState,
	emitted:           usize,
	closed:            bool,
	pending_error:     Option<FramingError>,
}

impl Default for WebSocketDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl WebSocketDecoder {
	/// Creates a server-frame decoder with the default 16 MiB message bound.
	pub fn new() -> Self {
		Self::with_config(DEFAULT_MAX_FRAME_BYTES, WebSocketMasking::Unmasked)
	}

	/// Creates a decoder with explicit message size and masking policy.
	pub fn with_config(max_message_bytes: usize, masking: WebSocketMasking) -> Self {
		Self {
			wire: BytesMut::new(),
			message: BytesMut::new(),
			message_opcode: None,
			max_message_bytes: max_message_bytes.max(1),
			masking,
			state: FramerState::Open,
			emitted: 0,
			closed: false,
			pending_error: None,
		}
	}

	/// Feeds raw RFC 6455 wire bytes and emits complete messages.
	pub fn push(&mut self, chunk: Bytes) -> Result<SmallVec<WebSocketMessage, 4>, FramingError> {
		<Self as IncrementalFramer>::push(self, chunk)
	}

	/// Supplies one already-deframed WebSocket fragment.
	pub fn push_fragment(
		&mut self,
		fragment: WebSocketFragment,
	) -> Result<SmallVec<WebSocketMessage, 4>, FramingError> {
		if let Some(error) = self.pending_error.take() {
			return Err(error);
		}
		self.state.ensure_open(FramingProtocol::WebSocket)?;
		if self.closed {
			return self.fail(FramingError::AfterEnd { protocol: FramingProtocol::WebSocket });
		}
		let mut output = SmallVec::new();
		if let Some(message) = self.assemble(fragment)? {
			self.emitted += 1;
			output.push(message);
		}
		Ok(output)
	}

	/// Validates that the wire stream ended on a message boundary.
	pub fn finish(&mut self) -> Result<SmallVec<WebSocketMessage, 4>, FramingError> {
		<Self as IncrementalFramer>::finish(self)
	}

	/// Cancels parsing and releases retained bytes.
	pub fn cancel(&mut self) {
		<Self as IncrementalFramer>::cancel(self);
	}

	/// Returns raw and fragmented payload bytes currently retained.
	pub fn buffered_len(&self) -> usize {
		self.wire.len().saturating_add(self.message.len())
	}

	/// Returns whether a close message was received.
	pub const fn is_closed(&self) -> bool {
		self.closed
	}

	fn append_wire(&mut self, chunk: Bytes) {
		if chunk.is_empty() {
			return;
		}
		if self.wire.is_empty() {
			self.wire = chunk
				.try_into_mut()
				.unwrap_or_else(|chunk| BytesMut::from(chunk.as_ref()));
		} else {
			self.wire.extend_from_slice(&chunk);
		}
	}

	fn assemble(
		&mut self,
		fragment: WebSocketFragment,
	) -> Result<Option<WebSocketMessage>, FramingError> {
		let control = matches!(
			fragment.opcode,
			WebSocketOpcode::Close | WebSocketOpcode::Ping | WebSocketOpcode::Pong
		);
		if control {
			if !fragment.fin || fragment.payload.len() > 125 {
				return self.fail(FramingError::InvalidWebSocketControl);
			}
			return match fragment.opcode {
				WebSocketOpcode::Close => self.decode_close(fragment.payload).map(Some),
				WebSocketOpcode::Ping => Ok(Some(WebSocketMessage::Ping(fragment.payload))),
				WebSocketOpcode::Pong => Ok(Some(WebSocketMessage::Pong(fragment.payload))),
				_ => unreachable!("control opcode checked"),
			};
		}

		match (self.message_opcode, fragment.opcode) {
			(None, WebSocketOpcode::Text | WebSocketOpcode::Binary) if fragment.fin => {
				if fragment.payload.len() > self.max_message_bytes {
					return self.limit(fragment.payload.len());
				}
				self
					.complete_data(fragment.opcode, fragment.payload)
					.map(Some)
			},
			(None, WebSocketOpcode::Text | WebSocketOpcode::Binary) => {
				if fragment.payload.len() > self.max_message_bytes {
					return self.limit(fragment.payload.len());
				}
				self.message_opcode = Some(fragment.opcode);
				self.message.extend_from_slice(&fragment.payload);
				Ok(None)
			},
			(Some(opcode), WebSocketOpcode::Continuation) => {
				let observed = self.message.len().saturating_add(fragment.payload.len());
				if observed > self.max_message_bytes {
					return self.limit(observed);
				}
				self.message.extend_from_slice(&fragment.payload);
				if !fragment.fin {
					return Ok(None);
				}
				let payload = self.message.split().freeze();
				self.message_opcode = None;
				self.complete_data(opcode, payload).map(Some)
			},
			_ => self.fail(FramingError::InvalidWebSocketOpcode { opcode: fragment.opcode as u8 }),
		}
	}

	fn complete_data(
		&mut self,
		opcode: WebSocketOpcode,
		payload: Bytes,
	) -> Result<WebSocketMessage, FramingError> {
		match opcode {
			WebSocketOpcode::Text => {
				if let Err(error) =
					validate_utf8(&payload, FramingProtocol::WebSocket, Utf8Field::WebSocketText)
				{
					return self.fail(error);
				}
				Ok(WebSocketMessage::Text(payload))
			},
			WebSocketOpcode::Binary => Ok(WebSocketMessage::Binary(payload)),
			_ => self.fail(FramingError::InvalidWebSocketOpcode { opcode: opcode as u8 }),
		}
	}

	fn decode_close(&mut self, payload: Bytes) -> Result<WebSocketMessage, FramingError> {
		if payload.len() == 1 {
			return self.fail(FramingError::InvalidWebSocketClose);
		}
		let (code, reason) = if payload.is_empty() {
			(None, Bytes::new())
		} else {
			let code = u16::from_be_bytes([payload[0], payload[1]]);
			if !valid_close_code(code) {
				return self.fail(FramingError::InvalidWebSocketClose);
			}
			let reason = payload.slice(2..);
			if let Err(error) =
				validate_utf8(&reason, FramingProtocol::WebSocket, Utf8Field::WebSocketCloseReason)
			{
				return self.fail(error);
			}
			(Some(code), reason)
		};
		self.closed = true;
		Ok(WebSocketMessage::Close { code, reason })
	}

	fn limit<T>(&mut self, observed: usize) -> Result<T, FramingError> {
		let error = FramingError::LimitExceeded {
			protocol: FramingProtocol::WebSocket,
			limit: self.max_message_bytes,
			observed,
		};
		self.fail(error)
	}

	fn fail<T>(&mut self, error: FramingError) -> Result<T, FramingError> {
		self.wire.clear();
		self.message.clear();
		self.message_opcode = None;
		self.state = FramerState::Failed;
		Err(error)
	}

	fn terminal(
		&mut self,
		error: FramingError,
		output: SmallVec<WebSocketMessage, 4>,
	) -> Result<SmallVec<WebSocketMessage, 4>, FramingError> {
		self.wire.clear();
		self.message.clear();
		self.message_opcode = None;
		self.state = FramerState::Failed;
		if output.is_empty() {
			Err(error)
		} else {
			self.pending_error = Some(error);
			Ok(output)
		}
	}
}

impl IncrementalFramer for WebSocketDecoder {
	type Frame = WebSocketMessage;

	fn push(&mut self, chunk: Bytes) -> Result<SmallVec<Self::Frame, 4>, FramingError> {
		if let Some(error) = self.pending_error.take() {
			return Err(error);
		}
		self.state.ensure_open(FramingProtocol::WebSocket)?;
		if self.closed && !chunk.is_empty() {
			return self.fail(FramingError::AfterEnd { protocol: FramingProtocol::WebSocket });
		}
		self.append_wire(chunk);
		let mut output = SmallVec::new();
		loop {
			if self.wire.len() < 2 {
				break;
			}
			let first = self.wire[0];
			let second = self.wire[1];
			if first & 0x70 != 0 {
				return self
					.terminal(FramingError::InvalidWebSocketOpcode { opcode: first & 0x0f }, output);
			}
			let fin = first & 0x80 != 0;
			let opcode = match WebSocketOpcode::try_from(first & 0x0f) {
				Ok(opcode) => opcode,
				Err(error) => return self.terminal(error, output),
			};
			let masked = second & 0x80 != 0;
			if matches!(self.masking, WebSocketMasking::Unmasked) && masked
				|| matches!(self.masking, WebSocketMasking::Masked) && !masked
			{
				return self.terminal(FramingError::InvalidWebSocketControl, output);
			}
			let short_len = usize::from(second & 0x7f);
			let (payload_len, mut header_len): (usize, usize) = match short_len {
				0..=125 => (short_len, 2),
				126 => {
					if self.wire.len() < 4 {
						break;
					}
					let encoded = u16::from_be_bytes([self.wire[2], self.wire[3]]);
					let len = usize::from(encoded);
					if len < 126 {
						let error = FramingError::NonCanonicalWebSocketLength {
							encoded_bytes: 2,
							payload:       u64::from(encoded),
						};
						return self.terminal(error, output);
					}
					(len, 4)
				},
				127 => {
					if self.wire.len() < 10 {
						break;
					}
					let encoded = u64::from_be_bytes(self.wire[2..10].try_into().expect("eight bytes"));
					if encoded & (1 << 63) != 0 {
						return self.terminal(FramingError::InvalidWebSocketControl, output);
					}
					if u16::try_from(encoded).is_ok() {
						let error = FramingError::NonCanonicalWebSocketLength {
							encoded_bytes: 8,
							payload:       encoded,
						};
						return self.terminal(error, output);
					}
					let Ok(len) = usize::try_from(encoded) else {
						let error = FramingError::LimitExceeded {
							protocol: FramingProtocol::WebSocket,
							limit:    self.max_message_bytes,
							observed: usize::MAX,
						};
						return self.terminal(error, output);
					};
					(len, 10)
				},
				_ => unreachable!(),
			};
			if payload_len > self.max_message_bytes {
				let error = FramingError::LimitExceeded {
					protocol: FramingProtocol::WebSocket,
					limit:    self.max_message_bytes,
					observed: payload_len,
				};
				return self.terminal(error, output);
			}
			if masked {
				header_len += 4;
			}
			let frame_len = header_len.saturating_add(payload_len);
			if self.wire.len() < frame_len {
				break;
			}
			let frame = self.wire.split_to(frame_len).freeze();
			let payload = if masked {
				let key = &frame[header_len - 4..header_len];
				let mut unmasked = BytesMut::with_capacity(payload_len);
				unmasked.resize(payload_len, 0);
				for (index, byte) in unmasked.iter_mut().enumerate() {
					*byte = frame[header_len + index] ^ key[index & 3];
				}
				unmasked.freeze()
			} else {
				frame.slice(header_len..)
			};
			match self.assemble(WebSocketFragment { fin, opcode, payload }) {
				Ok(Some(message)) => {
					self.emitted += 1;
					output.push(message);
				},
				Ok(None) => {},
				Err(error) => return self.terminal(error, output),
			}
			if self.closed {
				if !self.wire.is_empty() {
					let error = FramingError::AfterEnd { protocol: FramingProtocol::WebSocket };
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
		self.state.ensure_open(FramingProtocol::WebSocket)?;
		if self.wire.is_empty() && self.message_opcode.is_none() {
			self.state = FramerState::Finished;
			return Ok(SmallVec::new());
		}
		let available = self.buffered_len();
		self.fail(FramingError::UnexpectedEof {
			protocol: FramingProtocol::WebSocket,
			declared: available.saturating_add(1),
			available,
			first_frame: self.emitted == 0,
		})
	}

	fn cancel(&mut self) {
		self.wire.clear();
		self.message.clear();
		self.message_opcode = None;
		self.pending_error = None;
		self.state = FramerState::Cancelled;
	}

	fn buffered_len(&self) -> usize {
		self.wire.len().saturating_add(self.message.len())
	}
}

const fn valid_close_code(code: u16) -> bool {
	matches!(code, 1000..=1014 | 3000..=4999) && !matches!(code, 1004..=1006)
}
