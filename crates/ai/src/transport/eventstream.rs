//! Bounded incremental AWS `EventStream` framing with CRC and header
//! validation.

use std::ops;

use bytes::{Bytes, BytesMut};
use omp_core::Str;
use smallvec::SmallVec;

use super::frame::{
	CrcScope, DEFAULT_MAX_FRAME_BYTES, FramerState, FramingError, FramingProtocol,
	IncrementalFramer, Utf8Field, validate_utf8,
};

const PRELUDE_BYTES: usize = 12;
const MESSAGE_OVERHEAD_BYTES: usize = 16;
const DEFAULT_MAX_HEADERS_BYTES: usize = 128 * 1024;

/// One typed AWS `EventStream` header value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventStreamHeaderValue {
	/// Boolean value.
	Bool(bool),
	/// Signed byte value.
	Byte(i8),
	/// Big-endian signed 16-bit value.
	Int16(i16),
	/// Big-endian signed 32-bit value.
	Int32(i32),
	/// Big-endian signed 64-bit value.
	Int64(i64),
	/// Length-prefixed opaque bytes.
	ByteArray(Bytes),
	/// Length-prefixed validated UTF-8 string.
	String(Str),
	/// Milliseconds since the Unix epoch.
	Timestamp(i64),
	/// RFC 4122 UUID bytes.
	Uuid([u8; 16]),
}

impl EventStreamHeaderValue {
	/// Borrows this value when it is a string header.
	pub fn as_str(&self) -> Option<&str> {
		match self {
			Self::String(value) => Some(value.as_str()),
			_ => None,
		}
	}
}

/// One validated AWS `EventStream` header.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventStreamHeader {
	/// Header name.
	pub name:  Str,
	/// Typed header value.
	pub value: EventStreamHeaderValue,
}

/// One complete CRC-validated AWS `EventStream` message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventStreamMessage {
	/// Ordered typed headers.
	pub headers: SmallVec<EventStreamHeader, 8>,
	/// Message payload excluding framing and CRC bytes.
	pub payload: Bytes,
}

impl EventStreamMessage {
	/// Returns the last header with the exact requested name.
	///
	/// AWS headers are normally unique. Choosing the last duplicate preserves
	/// the overwrite semantics of a decoded header map without discarding wire
	/// order.
	pub fn header(&self, name: &str) -> Option<&EventStreamHeaderValue> {
		self
			.headers
			.iter()
			.rev()
			.find(|header| header.name.as_str() == name)
			.map(|header| &header.value)
	}

	/// Returns the last exact-name string header.
	pub fn string_header(&self, name: &str) -> Option<&str> {
		self.header(name).and_then(EventStreamHeaderValue::as_str)
	}
}

/// Bounded incremental AWS `EventStream` decoder.
#[derive(Debug)]
pub struct EventStreamDecoder {
	buffer:            BytesMut,
	max_message_bytes: usize,
	max_headers_bytes: usize,
	expected_message:  Option<(usize, usize)>,
	state:             FramerState,
	emitted:           usize,
	pending_error:     Option<FramingError>,
}

impl Default for EventStreamDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl EventStreamDecoder {
	/// Creates a decoder with 16 MiB message and 128 KiB header bounds.
	pub fn new() -> Self {
		Self::with_limits(DEFAULT_MAX_FRAME_BYTES, DEFAULT_MAX_HEADERS_BYTES)
	}

	/// Creates a decoder with explicit total-message and header-block bounds.
	pub fn with_limits(max_message_bytes: usize, max_headers_bytes: usize) -> Self {
		Self {
			buffer: BytesMut::new(),
			max_message_bytes: max_message_bytes.max(MESSAGE_OVERHEAD_BYTES),
			max_headers_bytes,
			expected_message: None,
			state: FramerState::Open,
			emitted: 0,
			pending_error: None,
		}
	}

	/// Feeds one byte chunk and emits complete validated messages.
	pub fn push(&mut self, chunk: Bytes) -> Result<SmallVec<EventStreamMessage, 4>, FramingError> {
		<Self as IncrementalFramer>::push(self, chunk)
	}

	/// Validates that input ended on a complete message boundary.
	pub fn finish(&mut self) -> Result<SmallVec<EventStreamMessage, 4>, FramingError> {
		<Self as IncrementalFramer>::finish(self)
	}

	/// Cancels parsing and releases retained bytes.
	pub fn cancel(&mut self) {
		<Self as IncrementalFramer>::cancel(self);
	}

	/// Returns retained bytes belonging to an incomplete message.
	pub fn buffered_len(&self) -> usize {
		self.buffer.len()
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

	fn inspect_prelude(&self) -> Result<(usize, usize), FramingError> {
		let total = usize::try_from(u32::from_be_bytes(
			self.buffer[..4].try_into().expect("four-byte total length"),
		))
		.expect("u32 fits usize");
		let headers = usize::try_from(u32::from_be_bytes(
			self.buffer[4..8]
				.try_into()
				.expect("four-byte headers length"),
		))
		.expect("u32 fits usize");
		if total < MESSAGE_OVERHEAD_BYTES || headers > total.saturating_sub(MESSAGE_OVERHEAD_BYTES) {
			return Err(FramingError::InvalidEventStreamLengths { total, headers });
		}
		if total > self.max_message_bytes {
			return Err(FramingError::LimitExceeded {
				protocol: FramingProtocol::AwsEventStream,
				limit:    self.max_message_bytes,
				observed: total,
			});
		}
		if headers > self.max_headers_bytes {
			return Err(FramingError::LimitExceeded {
				protocol: FramingProtocol::AwsEventStream,
				limit:    self.max_headers_bytes,
				observed: headers,
			});
		}
		let expected = u32::from_be_bytes(
			self.buffer[8..12]
				.try_into()
				.expect("four-byte prelude CRC"),
		);
		let actual = crc32fast::hash(&self.buffer[..8]);
		if expected != actual {
			return Err(FramingError::CrcMismatch { scope: CrcScope::Prelude, expected, actual });
		}
		Ok((total, headers))
	}

	fn terminal(
		&mut self,
		error: FramingError,
		output: SmallVec<EventStreamMessage, 4>,
	) -> Result<SmallVec<EventStreamMessage, 4>, FramingError> {
		self.buffer.clear();
		self.expected_message = None;
		self.state = FramerState::Failed;
		if output.is_empty() {
			Err(error)
		} else {
			self.pending_error = Some(error);
			Ok(output)
		}
	}
}

impl IncrementalFramer for EventStreamDecoder {
	type Frame = EventStreamMessage;

	fn push(&mut self, chunk: Bytes) -> Result<SmallVec<Self::Frame, 4>, FramingError> {
		if let Some(error) = self.pending_error.take() {
			return Err(error);
		}
		self.state.ensure_open(FramingProtocol::AwsEventStream)?;
		self.append(chunk);
		let mut output = SmallVec::new();
		loop {
			if self.buffer.len() < PRELUDE_BYTES {
				break;
			}
			let (total, headers_len) = if let Some(expected) = self.expected_message {
				expected
			} else {
				let expected = match self.inspect_prelude() {
					Ok(lengths) => lengths,
					Err(error) => return self.terminal(error, output),
				};
				self.expected_message = Some(expected);
				expected
			};
			if self.buffer.len() < total {
				break;
			}
			let message = self.buffer.split_to(total).freeze();
			self.expected_message = None;
			let crc_offset = total - 4;
			let expected = u32::from_be_bytes(
				message[crc_offset..]
					.try_into()
					.expect("four-byte message CRC"),
			);
			let actual = crc32fast::hash(&message[..crc_offset]);
			if expected != actual {
				let error = FramingError::CrcMismatch { scope: CrcScope::Message, expected, actual };
				return self.terminal(error, output);
			}
			let headers_end = PRELUDE_BYTES + headers_len;
			let headers = match parse_headers(&message, PRELUDE_BYTES, headers_end) {
				Ok(headers) => headers,
				Err(error) => return self.terminal(error, output),
			};
			let payload = message.slice(headers_end..crc_offset);
			output.push(EventStreamMessage { headers, payload });
			self.emitted += 1;
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
		self.state.ensure_open(FramingProtocol::AwsEventStream)?;
		if self.buffer.is_empty() {
			self.state = FramerState::Finished;
			return Ok(SmallVec::new());
		}
		let declared = self
			.expected_message
			.map_or(PRELUDE_BYTES, |(total, _)| total);
		let available = self.buffer.len();
		let error = FramingError::UnexpectedEof {
			protocol: FramingProtocol::AwsEventStream,
			declared,
			available,
			first_frame: self.emitted == 0,
		};
		self.terminal(error, SmallVec::new())
	}

	fn cancel(&mut self) {
		self.buffer.clear();
		self.expected_message = None;
		self.pending_error = None;
		self.state = FramerState::Cancelled;
	}

	fn buffered_len(&self) -> usize {
		self.buffer.len()
	}
}

fn parse_headers(
	message: &Bytes,
	start: usize,
	end: usize,
) -> Result<SmallVec<EventStreamHeader, 8>, FramingError> {
	let mut headers = SmallVec::new();
	let mut cursor = start;
	while cursor < end {
		let header_offset = cursor - start;
		let name_len = usize::from(take_u8(message, &mut cursor, end, header_offset)?);
		if name_len == 0 || cursor.saturating_add(name_len) > end {
			return Err(FramingError::InvalidEventStreamHeader { offset: header_offset });
		}
		let name_bytes = &message[cursor..cursor + name_len];
		validate_utf8(name_bytes, FramingProtocol::AwsEventStream, Utf8Field::EventStreamHeader)?;
		let name = Str::from_utf8(name_bytes).map_err(|_| FramingError::InvalidUtf8 {
			protocol: FramingProtocol::AwsEventStream,
			field:    Utf8Field::EventStreamHeader,
		})?;
		cursor += name_len;
		let kind = take_u8(message, &mut cursor, end, header_offset)?;
		let value = match kind {
			0 => EventStreamHeaderValue::Bool(true),
			1 => EventStreamHeaderValue::Bool(false),
			2 => {
				EventStreamHeaderValue::Byte(take_u8(message, &mut cursor, end, header_offset)? as i8)
			},
			3 => EventStreamHeaderValue::Int16(i16::from_be_bytes(take_array::<2>(
				message,
				&mut cursor,
				end,
				header_offset,
			)?)),
			4 => EventStreamHeaderValue::Int32(i32::from_be_bytes(take_array::<4>(
				message,
				&mut cursor,
				end,
				header_offset,
			)?)),
			5 => EventStreamHeaderValue::Int64(i64::from_be_bytes(take_array::<8>(
				message,
				&mut cursor,
				end,
				header_offset,
			)?)),
			6 => {
				let len = usize::from(u16::from_be_bytes(take_array::<2>(
					message,
					&mut cursor,
					end,
					header_offset,
				)?));
				let range = take_range(&mut cursor, end, len, header_offset)?;
				EventStreamHeaderValue::ByteArray(message.slice(range))
			},
			7 => {
				let len = usize::from(u16::from_be_bytes(take_array::<2>(
					message,
					&mut cursor,
					end,
					header_offset,
				)?));
				let range = take_range(&mut cursor, end, len, header_offset)?;
				let bytes = &message[range];
				validate_utf8(bytes, FramingProtocol::AwsEventStream, Utf8Field::EventStreamHeader)?;
				EventStreamHeaderValue::String(Str::from_utf8(bytes).map_err(|_| {
					FramingError::InvalidUtf8 {
						protocol: FramingProtocol::AwsEventStream,
						field:    Utf8Field::EventStreamHeader,
					}
				})?)
			},
			8 => EventStreamHeaderValue::Timestamp(i64::from_be_bytes(take_array::<8>(
				message,
				&mut cursor,
				end,
				header_offset,
			)?)),
			9 => EventStreamHeaderValue::Uuid(take_array::<16>(
				message,
				&mut cursor,
				end,
				header_offset,
			)?),
			kind => return Err(FramingError::UnknownEventStreamHeaderType { kind }),
		};
		headers.push(EventStreamHeader { name, value });
	}
	Ok(headers)
}

const fn take_u8(
	message: &[u8],
	cursor: &mut usize,
	end: usize,
	offset: usize,
) -> Result<u8, FramingError> {
	if *cursor >= end {
		return Err(FramingError::InvalidEventStreamHeader { offset });
	}
	let value = message[*cursor];
	*cursor += 1;
	Ok(value)
}

fn take_array<const N: usize>(
	message: &[u8],
	cursor: &mut usize,
	end: usize,
	offset: usize,
) -> Result<[u8; N], FramingError> {
	let range = take_range(cursor, end, N, offset)?;
	Ok(message[range]
		.try_into()
		.expect("range has exact requested length"))
}

fn take_range(
	cursor: &mut usize,
	end: usize,
	len: usize,
	offset: usize,
) -> Result<ops::Range<usize>, FramingError> {
	let next = cursor
		.checked_add(len)
		.filter(|next| *next <= end)
		.ok_or(FramingError::InvalidEventStreamHeader { offset })?;
	let range = *cursor..next;
	*cursor = next;
	Ok(range)
}
