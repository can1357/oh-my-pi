//! Bounded incremental newline-delimited JSON framing.

use bytes::{Bytes, BytesMut};
use smallvec::SmallVec;

use super::frame::{
	DEFAULT_MAX_FRAME_BYTES, FramerState, FramingError, FramingProtocol, IncrementalFramer,
};

/// Bounded incremental newline-delimited JSON decoder.
#[derive(Debug)]
pub struct NdjsonDecoder {
	buffer:          BytesMut,
	scan:            usize,
	max_frame_bytes: usize,
	state:           FramerState,
	pending_error:   Option<FramingError>,
}

impl Default for NdjsonDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl NdjsonDecoder {
	/// Creates a decoder with the default 16 MiB record bound.
	pub fn new() -> Self {
		Self::with_max_frame_bytes(DEFAULT_MAX_FRAME_BYTES)
	}

	/// Creates a decoder with an explicit maximum record size.
	pub fn with_max_frame_bytes(max_frame_bytes: usize) -> Self {
		Self {
			buffer:          BytesMut::new(),
			scan:            0,
			max_frame_bytes: max_frame_bytes.max(1),
			state:           FramerState::Open,
			pending_error:   None,
		}
	}

	/// Feeds one byte chunk and returns complete non-empty records.
	pub fn push(&mut self, chunk: Bytes) -> Result<SmallVec<Bytes, 4>, FramingError> {
		<Self as IncrementalFramer>::push(self, chunk)
	}

	/// Ends input and emits a non-empty final record without requiring a
	/// newline.
	pub fn finish(&mut self) -> Result<SmallVec<Bytes, 4>, FramingError> {
		<Self as IncrementalFramer>::finish(self)
	}

	/// Cancels parsing and releases retained bytes.
	pub fn cancel(&mut self) {
		<Self as IncrementalFramer>::cancel(self);
	}

	/// Returns retained bytes belonging to the incomplete record.
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

	fn terminal(
		&mut self,
		error: FramingError,
		output: SmallVec<Bytes, 4>,
	) -> Result<SmallVec<Bytes, 4>, FramingError> {
		self.buffer.clear();
		self.scan = 0;
		self.state = FramerState::Failed;
		if output.is_empty() {
			Err(error)
		} else {
			self.pending_error = Some(error);
			Ok(output)
		}
	}
}

impl IncrementalFramer for NdjsonDecoder {
	type Frame = Bytes;

	fn push(&mut self, chunk: Bytes) -> Result<SmallVec<Self::Frame, 4>, FramingError> {
		if let Some(error) = self.pending_error.take() {
			return Err(error);
		}
		self.state.ensure_open(FramingProtocol::Ndjson)?;
		self.append(chunk);
		let mut output = SmallVec::new();
		loop {
			let Some(relative) = self.buffer[self.scan..]
				.iter()
				.position(|byte| *byte == b'\n')
			else {
				self.scan = self.buffer.len();
				break;
			};
			let newline = self.scan + relative;
			let encoded_len = newline + 1;
			let payload_len =
				newline.saturating_sub(usize::from(newline != 0 && self.buffer[newline - 1] == b'\r'));
			if payload_len > self.max_frame_bytes {
				let error = FramingError::LimitExceeded {
					protocol: FramingProtocol::Ndjson,
					limit:    self.max_frame_bytes,
					observed: payload_len,
				};
				return self.terminal(error, output);
			}
			let mut record = self.buffer.split_to(encoded_len).freeze();
			self.scan = 0;
			record.truncate(record.len() - 1);
			if record.last() == Some(&b'\r') {
				record.truncate(record.len() - 1);
			}
			if !record.is_empty() {
				output.push(record);
			}
		}
		if self.buffer.len() > self.max_frame_bytes {
			let observed = self.buffer.len();
			let error = FramingError::LimitExceeded {
				protocol: FramingProtocol::Ndjson,
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
		if self.state == FramerState::Finished {
			return Ok(SmallVec::new());
		}
		self.state.ensure_open(FramingProtocol::Ndjson)?;
		let mut output = SmallVec::new();
		if !self.buffer.is_empty() {
			let mut record = self.buffer.split().freeze();
			if record.last() == Some(&b'\r') {
				record.truncate(record.len() - 1);
			}
			if !record.is_empty() {
				output.push(record);
			}
		}
		self.scan = 0;
		self.state = FramerState::Finished;
		Ok(output)
	}

	fn cancel(&mut self) {
		self.buffer.clear();
		self.scan = 0;
		self.pending_error = None;
		self.state = FramerState::Cancelled;
	}

	fn buffered_len(&self) -> usize {
		self.buffer.len()
	}
}
