//! Raw Server-Sent Events framing used by `.oms` journals.
//!
//! The committing boundary is the blank line after a frame. Canonical output
//! orders fields as comment, `event`, `id`, `by`, `prior`, then `data`.

use std::{io::Write as _, ops::Range, str::FromStr as _};

use memchr::memchr;
use omp_core::{Str, UlidParseError};
use thiserror::Error;

use crate::{Entry, Kind, KindError};

/// Maximum inline JSON payload size: one mebibyte.
pub const DATA_HARD_CAP: usize = 1 << 20;

/// One decoded complete frame and its byte span.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
	/// Decoded entry.
	pub entry: Entry,
	/// Frame bytes, including the committing blank line.
	pub span:  Range<usize>,
}

/// Failure to encode or decode an SSE frame.
#[derive(Debug, Error)]
pub enum SseError {
	/// The mandatory `id` field is absent.
	#[error("journal frame is missing `id`")]
	MissingId,
	/// The mandatory `event` field is absent.
	#[error("journal frame is missing `event`")]
	MissingEvent,
	/// The mandatory `data` field is absent.
	#[error("journal frame is missing `data`")]
	MissingData,
	/// A frame is not UTF-8.
	#[error("journal frame is not UTF-8")]
	InvalidUtf8 {
		/// UTF-8 decoder failure.
		#[source]
		source: std::str::Utf8Error,
	},
	/// The `id` field is not a ULID.
	#[error("journal frame `id` is invalid")]
	InvalidId {
		/// ULID parse failure.
		#[source]
		source: UlidParseError,
	},
	/// The `by` field is not a ULID.
	#[error("journal frame `by` is invalid")]
	InvalidCause {
		/// ULID parse failure.
		#[source]
		source: UlidParseError,
	},
	/// The `prior` field is not a ULID.
	#[error("journal frame `prior` is invalid")]
	InvalidPrior {
		/// ULID parse failure.
		#[source]
		source: UlidParseError,
	},
	/// The `event` field is not a versioned kind.
	#[error("journal frame `event` is invalid")]
	InvalidKind {
		/// Kind parse failure.
		#[source]
		source: KindError,
	},
	/// The `event` field is outside the exact closed vocabulary.
	#[error("journal frame kind {kind} is not in the closed revision-1 vocabulary")]
	UnknownKind {
		/// Unsupported versioned kind.
		kind: Kind,
	},
	/// The JSON payload is invalid.
	#[error("journal frame `data` is invalid JSON")]
	InvalidData {
		/// JSON decoder failure.
		#[source]
		source: serde_json::Error,
	},
	/// The JSON payload contains a physical line break.
	#[error("journal frame `data` must occupy one physical line")]
	MultilineData,
	/// The optional label contains a physical line break.
	#[error("journal frame label must occupy one physical line")]
	MultilineLabel,
	/// The JSON payload exceeds the hard cap.
	#[error("journal frame `data` is {len} bytes; maximum is 1048576")]
	DataTooLarge {
		/// Payload byte length.
		len: usize,
	},
}

/// Encodes one entry in canonical field order.
///
/// # Errors
///
/// Returns [`SseError`] when the label or payload cannot be represented in a
/// single frame, the payload is invalid JSON, or it exceeds the hard cap.
pub fn encode(entry: &Entry, output: &mut Vec<u8>) -> Result<(), SseError> {
	validate_label(entry.label.as_deref())?;
	validate_data(entry.data.as_str())?;
	if !entry.kind.is_known() {
		return Err(SseError::UnknownKind { kind: entry.kind.clone() });
	}
	if let Some(label) = &entry.label {
		let _ = writeln!(output, ": {label}");
	}
	let _ = writeln!(output, "event: {}", entry.kind);
	let _ = writeln!(output, "id: {}", entry.id);
	if let Some(by) = entry.by {
		let _ = writeln!(output, "by: {by}");
	}
	if let Some(prior) = entry.prior {
		let _ = writeln!(output, "prior: {prior}");
	}
	let _ = write!(output, "data: {}\n\n", entry.data);
	Ok(())
}

/// Validates one inline JSON payload.
///
/// # Errors
///
/// Returns [`SseError`] for oversized, multiline, or malformed JSON.
pub fn validate_data(data: &str) -> Result<(), SseError> {
	if data.len() > DATA_HARD_CAP {
		return Err(SseError::DataTooLarge { len: data.len() });
	}
	if data.bytes().any(|byte| matches!(byte, b'\r' | b'\n')) {
		return Err(SseError::MultilineData);
	}
	serde_json::from_str::<serde::de::IgnoredAny>(data)
		.map(|_| ())
		.map_err(|source| SseError::InvalidData { source })
}

fn validate_label(label: Option<&str>) -> Result<(), SseError> {
	if label.is_some_and(|value| value.bytes().any(|byte| matches!(byte, b'\r' | b'\n'))) {
		return Err(SseError::MultilineLabel);
	}
	Ok(())
}

/// Single-pass scanner over complete blank-line-committed frames.
#[derive(Debug)]
pub struct Scanner<'a> {
	bytes:  &'a [u8],
	offset: usize,
}

impl<'a> Scanner<'a> {
	/// Creates a scanner over an SSE byte buffer.
	#[must_use]
	pub const fn new(bytes: &'a [u8]) -> Self {
		Self { bytes, offset: 0 }
	}

	/// Returns the byte immediately after the last complete frame.
	#[must_use]
	pub const fn offset(&self) -> usize {
		self.offset
	}

	/// Returns whether bytes remain after the last complete frame.
	#[must_use]
	pub const fn has_torn_tail(&self) -> bool {
		self.offset < self.bytes.len()
	}

	/// Decodes the next complete frame, stopping before a torn tail.
	///
	/// # Errors
	///
	/// Returns [`SseError`] when a complete frame is malformed.
	#[allow(clippy::should_implement_trait, reason = "scanner reports typed frame errors")]
	pub fn next(&mut self) -> Option<Result<Frame, SseError>> {
		loop {
			let start = self.offset;
			let end = complete_block_end(self.bytes, start)?;
			self.offset = end;
			let raw = &self.bytes[start..end];
			if raw == b"\n" || raw == b"\r\n" {
				continue;
			}
			return Some(parse_frame(raw).map(|entry| Frame { entry, span: start..end }));
		}
	}
}

fn complete_block_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut cursor = start;
	loop {
		let relative = memchr(b'\n', &bytes[cursor..])?;
		let newline = cursor + relative;
		let line = &bytes[cursor..newline];
		cursor = newline + 1;
		if line.is_empty() || line == b"\r" {
			return Some(cursor);
		}
	}
}

fn parse_frame(raw: &[u8]) -> Result<Entry, SseError> {
	let text = std::str::from_utf8(raw).map_err(|source| SseError::InvalidUtf8 { source })?;
	let mut id = None;
	let mut kind = None;
	let mut by = None;
	let mut prior = None;
	let mut label = None;
	let mut data = None::<String>;

	for line in text.lines() {
		if line.is_empty() {
			break;
		}
		if let Some(comment) = line.strip_prefix(':') {
			if label.is_none() {
				label = Some(Str::new(comment.strip_prefix(' ').unwrap_or(comment)));
			}
			continue;
		}
		let Some((field, value)) = line.split_once(':') else {
			continue;
		};
		let value = value.strip_prefix(' ').unwrap_or(value);
		match field {
			"id" => {
				id = Some(
					value
						.parse()
						.map_err(|source| SseError::InvalidId { source })?,
				);
			},
			"event" => {
				kind = Some(Kind::from_str(value).map_err(|source| SseError::InvalidKind { source })?);
			},
			"by" => {
				by = Some(
					value
						.parse()
						.map_err(|source| SseError::InvalidCause { source })?,
				);
			},
			"prior" => {
				prior = Some(
					value
						.parse()
						.map_err(|source| SseError::InvalidPrior { source })?,
				);
			},
			"data" => {
				if let Some(existing) = &mut data {
					existing.push('\n');
					existing.push_str(value);
				} else {
					data = Some(value.to_owned());
				}
			},
			_ => {},
		}
	}

	let data = data.ok_or(SseError::MissingData)?;
	if data.len() > DATA_HARD_CAP {
		return Err(SseError::DataTooLarge { len: data.len() });
	}
	serde_json::from_str::<serde::de::IgnoredAny>(&data)
		.map_err(|source| SseError::InvalidData { source })?;
	let kind = kind.ok_or(SseError::MissingEvent)?;
	if !kind.is_known() {
		return Err(SseError::UnknownKind { kind });
	}
	Ok(Entry { id: id.ok_or(SseError::MissingId)?, kind, by, prior, label, data: Str::new(data) })
}
