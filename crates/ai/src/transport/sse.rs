//! Bounded incremental Server-Sent Events framing.

use bytes::{Bytes, BytesMut};
use omp_core::Str;
use smallvec::SmallVec;

use super::frame::{
	DEFAULT_MAX_FRAME_BYTES, FramerState, FramingError, FramingProtocol, IncrementalFramer,
	Utf8Field, validate_utf8,
};

/// One assembled Server-Sent Event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SseEvent {
	/// Optional `event:` field; an empty field selects the default event type.
	pub name: Option<Str>,
	/// All `data:` fields joined with one line feed.
	pub data: Bytes,
}

/// Bounded incremental Server-Sent Events decoder.
#[derive(Debug)]
pub struct SseDecoder {
	buffer:          BytesMut,
	scan:            usize,
	line_start:      usize,
	max_frame_bytes: usize,
	last_event_id:   Option<Str>,
	retry_ms:        Option<u64>,
	state:           FramerState,
	done_sentinel:   bool,
	pending_error:   Option<FramingError>,
}

impl Default for SseDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl SseDecoder {
	/// Creates a decoder with the default 16 MiB event bound.
	pub fn new() -> Self {
		Self::with_max_frame_bytes(DEFAULT_MAX_FRAME_BYTES)
	}

	/// Creates a decoder with an explicit maximum encoded event size.
	pub fn with_max_frame_bytes(max_frame_bytes: usize) -> Self {
		Self {
			buffer:          BytesMut::new(),
			scan:            0,
			line_start:      0,
			max_frame_bytes: max_frame_bytes.max(1),
			last_event_id:   None,
			retry_ms:        None,
			state:           FramerState::Open,
			done_sentinel:   false,
			pending_error:   None,
		}
	}

	/// Creates a decoder for already-captured replay bytes.
	pub(crate) fn for_replay() -> Self {
		Self::new()
	}

	/// Feeds a byte chunk and emits every newly completed event.
	pub fn push(&mut self, chunk: Bytes) -> Result<SmallVec<SseEvent, 4>, FramingError> {
		<Self as IncrementalFramer>::push(self, chunk)
	}

	/// Ends the stream and dispatches a final unterminated event, if present.
	pub fn finish(&mut self) -> Result<SmallVec<SseEvent, 4>, FramingError> {
		<Self as IncrementalFramer>::finish(self)
	}

	/// Cancels the stream and releases incomplete bytes.
	pub fn cancel(&mut self) {
		<Self as IncrementalFramer>::cancel(self);
	}

	/// Returns bytes retained for the incomplete event.
	pub fn buffered_len(&self) -> usize {
		self.buffer.len()
	}

	/// Returns the most recently accepted `id:` field.
	pub fn last_event_id(&self) -> Option<&str> {
		self.last_event_id.as_ref().map(Str::as_str)
	}

	/// Returns the most recently accepted non-negative `retry:` value.
	pub const fn retry_ms(&self) -> Option<u64> {
		self.retry_ms
	}

	/// Returns whether the terminal `[DONE]` sentinel was consumed.
	pub const fn is_done(&self) -> bool {
		self.done_sentinel
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

	fn next_event_len(&mut self) -> Option<usize> {
		while self.scan < self.buffer.len() {
			let index = self.scan;
			self.scan += 1;
			if self.buffer[index] != b'\n' {
				continue;
			}
			let line_end = if index > self.line_start && self.buffer[index - 1] == b'\r' {
				index - 1
			} else {
				index
			};
			if line_end == self.line_start {
				return Some(index + 1);
			}
			self.line_start = index + 1;
		}
		None
	}

	fn take_event(&mut self, len: usize) -> Result<Option<SseEvent>, FramingError> {
		let frame = self.buffer.split_to(len).freeze();
		self.scan = 0;
		self.line_start = 0;
		self.parse_event(frame)
	}

	fn parse_event(&mut self, frame: Bytes) -> Result<Option<SseEvent>, FramingError> {
		let mut data: SmallVec<(usize, usize), 4> = SmallVec::new();
		let mut name = None;
		let mut cursor = 0;

		while cursor < frame.len() {
			let newline = frame[cursor..]
				.iter()
				.position(|byte| *byte == b'\n')
				.map_or(frame.len(), |offset| cursor + offset);
			let end = if newline > cursor && frame[newline - 1] == b'\r' {
				newline - 1
			} else {
				newline
			};
			if end == cursor {
				break;
			}
			let line = &frame[cursor..end];
			if line.first() != Some(&b':') {
				let colon = line.iter().position(|byte| *byte == b':');
				let (field, mut value_start) = match colon {
					Some(offset) => (&line[..offset], cursor + offset + 1),
					None => (line, end),
				};
				if value_start < end && frame[value_start] == b' ' {
					value_start += 1;
				}
				let value = &frame[value_start..end];
				match field {
					b"data" => data.push((value_start, end)),
					b"event" => {
						validate_utf8(value, FramingProtocol::Sse, Utf8Field::SseEventName)?;
						if !value.is_empty() {
							name = Some(Str::from_utf8(value).map_err(|_| FramingError::InvalidUtf8 {
								protocol: FramingProtocol::Sse,
								field:    Utf8Field::SseEventName,
							})?);
						}
					},
					b"id" if !value.contains(&0) => {
						validate_utf8(value, FramingProtocol::Sse, Utf8Field::SseEventId)?;
						self.last_event_id =
							Some(Str::from_utf8(value).map_err(|_| FramingError::InvalidUtf8 {
								protocol: FramingProtocol::Sse,
								field:    Utf8Field::SseEventId,
							})?);
					},
					b"retry" => {
						if let Some(parsed) = parse_decimal(value) {
							self.retry_ms = Some(parsed);
						}
					},
					_ => {},
				}
			}
			cursor = newline.saturating_add(1);
		}

		let event = match data.as_slice() {
			[] => return Ok(None),
			&[(start, end)] => SseEvent { name, data: frame.slice(start..end) },
			ranges => {
				let payload_len = ranges
					.iter()
					.map(|(start, end)| end - start)
					.sum::<usize>()
					.saturating_add(ranges.len() - 1);
				let mut payload = BytesMut::with_capacity(payload_len);
				for (index, &(start, end)) in ranges.iter().enumerate() {
					if index != 0 {
						payload.extend_from_slice(b"\n");
					}
					payload.extend_from_slice(&frame[start..end]);
				}
				SseEvent { name, data: payload.freeze() }
			},
		};
		if event.data.as_ref() == b"[DONE]" {
			self.done_sentinel = true;
			self.state = FramerState::Finished;
			self.buffer.clear();
			return Ok(None);
		}
		Ok(Some(event))
	}

	fn fail(&mut self) {
		self.buffer.clear();
		self.scan = 0;
		self.line_start = 0;
		self.state = FramerState::Failed;
	}

	fn terminal(
		&mut self,
		error: FramingError,
		output: SmallVec<SseEvent, 4>,
	) -> Result<SmallVec<SseEvent, 4>, FramingError> {
		self.fail();
		if output.is_empty() {
			Err(error)
		} else {
			self.pending_error = Some(error);
			Ok(output)
		}
	}
}

impl IncrementalFramer for SseDecoder {
	type Frame = SseEvent;

	fn push(&mut self, chunk: Bytes) -> Result<SmallVec<Self::Frame, 4>, FramingError> {
		if let Some(error) = self.pending_error.take() {
			return Err(error);
		}
		if self.done_sentinel {
			return Ok(SmallVec::new());
		}
		self.state.ensure_open(FramingProtocol::Sse)?;
		self.append(chunk);
		let mut output = SmallVec::new();
		while let Some(len) = self.next_event_len() {
			if len > self.max_frame_bytes {
				let error = FramingError::LimitExceeded {
					protocol: FramingProtocol::Sse,
					limit:    self.max_frame_bytes,
					observed: len,
				};
				return self.terminal(error, output);
			}
			match self.take_event(len) {
				Ok(Some(event)) => output.push(event),
				Ok(None) if self.done_sentinel => break,
				Ok(None) => {},
				Err(error) => return self.terminal(error, output),
			}
		}
		if self.buffer.len() > self.max_frame_bytes {
			let observed = self.buffer.len();
			let error = FramingError::LimitExceeded {
				protocol: FramingProtocol::Sse,
				limit: self.max_frame_bytes,
				observed,
			};
			return self.terminal(error, output);
		}
		Ok(output)
	}

	fn finish(&mut self) -> Result<SmallVec<Self::Frame, 4>, FramingError> {
		if let Some(error) = self.pending_error.take() {
			return Err(error);
		}
		if self.done_sentinel || self.state == FramerState::Finished {
			return Ok(SmallVec::new());
		}
		self.state.ensure_open(FramingProtocol::Sse)?;
		let mut output = SmallVec::new();
		if !self.buffer.is_empty() {
			let len = self.buffer.len();
			match self.take_event(len) {
				Ok(Some(event)) => output.push(event),
				Ok(None) => {},
				Err(error) => {
					self.fail();
					return Err(error);
				},
			}
		}
		if !self.done_sentinel {
			self.state = FramerState::Finished;
		}
		Ok(output)
	}

	fn cancel(&mut self) {
		self.buffer.clear();
		self.scan = 0;
		self.line_start = 0;
		self.pending_error = None;
		self.state = FramerState::Cancelled;
	}

	fn buffered_len(&self) -> usize {
		self.buffer.len()
	}
}

fn parse_decimal(bytes: &[u8]) -> Option<u64> {
	if bytes.is_empty() {
		return None;
	}
	bytes.iter().try_fold(0_u64, |value, byte| {
		byte
			.is_ascii_digit()
			.then_some(*byte - b'0')
			.and_then(|digit| value.checked_mul(10)?.checked_add(u64::from(digit)))
	})
}
