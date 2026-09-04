//! Allocation-conscious incremental UTF-8 and delimiter scanners.

use bytes::{Bytes, BytesMut};
use omp_core::{Str, sf};

use super::{DiagnosticContext, RecoveryError, Stage};

const UTF8_TAIL: usize = 3;

/// Incremental UTF-8 validator which never splits a scalar value.
#[derive(Debug)]
pub struct Utf8Scanner {
	pending:          BytesMut,
	max_pending:      usize,
	diagnostic_bytes: usize,
}

impl Default for Utf8Scanner {
	fn default() -> Self {
		Self::new(UTF8_TAIL, 128)
	}
}

impl Utf8Scanner {
	/// Creates a validator with explicit retained-tail and diagnostic bounds.
	pub fn new(max_pending: usize, diagnostic_bytes: usize) -> Self {
		Self {
			pending: BytesMut::with_capacity(max_pending.min(UTF8_TAIL)),
			max_pending,
			diagnostic_bytes,
		}
	}

	fn consume(
		&mut self,
		final_chunk: bool,
		emit: &mut dyn FnMut(Bytes),
	) -> Result<(), RecoveryError> {
		if self.pending.is_empty() {
			return Ok(());
		}
		match Str::from_utf8(&self.pending) {
			Ok(_) => {
				let bytes = self.pending.split().freeze();
				emit(bytes);
				Ok(())
			},
			Err(error) => {
				let valid = error.valid_up_to();
				if valid != 0 {
					emit(self.pending.split_to(valid).freeze());
				}
				if error.error_len().is_some() || final_chunk {
					let diagnostic = DiagnosticContext::capture(&self.pending, self.diagnostic_bytes);
					return Err(RecoveryError::InvalidInput {
						stage:  "utf8-scanner",
						reason: sf!("invalid UTF-8 ({} bytes retained)", diagnostic.input_bytes()),
					});
				}
				if self.pending.len() > self.max_pending {
					return Err(RecoveryError::LimitExceeded {
						stage: "utf8-scanner",
						limit: self.max_pending,
					});
				}
				Ok(())
			},
		}
	}
}

impl Stage<Bytes, Bytes> for Utf8Scanner {
	fn push(&mut self, input: Bytes, emit: &mut dyn FnMut(Bytes)) -> Result<(), RecoveryError> {
		self.pending.extend_from_slice(&input);
		self.consume(false, emit)
	}

	fn finish(&mut self, emit: &mut dyn FnMut(Bytes)) -> Result<(), RecoveryError> {
		self.consume(true, emit)
	}
}

/// Stable identifier for one delimiter rule.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct DelimiterId(pub &'static str);

/// One fixed open/close delimiter pair.
#[derive(Clone, Copy, Debug)]
pub struct Delimiter {
	/// Stable rule identifier.
	pub id:    DelimiterId,
	/// Opening byte sequence.
	pub open:  &'static [u8],
	/// Closing byte sequence.
	pub close: &'static [u8],
}

/// Output from an incremental delimiter scanner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TagEvent {
	/// Bytes proven not to begin a configured block.
	Text(Bytes),
	/// One complete delimited block, including delimiters.
	Block {
		/// Identifier of the matched delimiter rule.
		id:  DelimiterId,
		/// Complete matched bytes including both delimiters.
		raw: Bytes,
	},
}

#[derive(Debug)]
enum State {
	Visible,
	Block { delimiter: usize, searched: usize },
}

/// Incremental multi-pattern delimiter scanner.
///
/// Consumed prefixes are removed immediately. Search resumes only at the
/// previous possible delimiter overlap, so arbitrarily fragmented input is
/// amortized linear rather than repeatedly reparsing the full prefix.
#[derive(Debug)]
pub struct TagScanner {
	delimiters:      &'static [Delimiter],
	buffer:          BytesMut,
	state:           State,
	max_block_bytes: usize,
	bytes_examined:  u64,
}

impl TagScanner {
	/// Creates a scanner for catalog-selected delimiters.
	pub fn new(delimiters: &'static [Delimiter], max_block_bytes: usize) -> Self {
		assert!(
			delimiters
				.iter()
				.all(|rule| !rule.open.is_empty() && !rule.close.is_empty())
		);
		Self {
			delimiters,
			buffer: BytesMut::new(),
			state: State::Visible,
			max_block_bytes,
			bytes_examined: 0,
		}
	}

	/// Returns a monotonic work counter useful for enforcing amortization tests.
	pub const fn bytes_examined(&self) -> u64 {
		self.bytes_examined
	}

	fn consume(
		&mut self,
		final_chunk: bool,
		emit: &mut dyn FnMut(TagEvent),
	) -> Result<(), RecoveryError> {
		loop {
			match self.state {
				State::Visible => {
					let valid = valid_utf8_prefix(&self.buffer, final_chunk)?;
					let Some((at, rule)) = self.earliest_open(valid) else {
						let hold = if final_chunk {
							0
						} else {
							suffix_overlap_any(&self.buffer[..valid], self.delimiters)
						};
						let amount = valid.saturating_sub(hold);
						if amount != 0 {
							emit(TagEvent::Text(self.buffer.split_to(amount).freeze()));
						}
						return Ok(());
					};
					if at != 0 {
						emit(TagEvent::Text(self.buffer.split_to(at).freeze()));
					}
					self.state =
						State::Block { delimiter: rule, searched: self.delimiters[rule].open.len() };
				},
				State::Block { delimiter, searched } => {
					let rule = self.delimiters[delimiter];
					if self.buffer.len() > self.max_block_bytes {
						return Err(RecoveryError::LimitExceeded {
							stage: "tag-scanner",
							limit: self.max_block_bytes,
						});
					}
					let start = searched.saturating_sub(rule.close.len().saturating_sub(1));
					if let Some(relative) =
						find(&self.buffer[start..], rule.close, &mut self.bytes_examined)
					{
						let end = start + relative + rule.close.len();
						let raw = self.buffer.split_to(end).freeze();
						emit(TagEvent::Block { id: rule.id, raw });
						self.state = State::Visible;
						continue;
					}
					if final_chunk {
						if !self.buffer.is_empty() {
							emit(TagEvent::Text(self.buffer.split().freeze()));
						}
						self.state = State::Visible;
						return Ok(());
					}
					self.state = State::Block { delimiter, searched: self.buffer.len() };
					return Ok(());
				},
			}
		}
	}

	fn earliest_open(&mut self, valid: usize) -> Option<(usize, usize)> {
		let mut earliest = None;
		for (index, rule) in self.delimiters.iter().enumerate() {
			if let Some(at) = find(&self.buffer[..valid], rule.open, &mut self.bytes_examined)
				&& earliest.is_none_or(|(best, _)| at < best)
			{
				earliest = Some((at, index));
			}
		}
		earliest
	}
}

impl Stage<Bytes, TagEvent> for TagScanner {
	fn push(&mut self, input: Bytes, emit: &mut dyn FnMut(TagEvent)) -> Result<(), RecoveryError> {
		self.buffer.extend_from_slice(&input);
		self.consume(false, emit)
	}

	fn finish(&mut self, emit: &mut dyn FnMut(TagEvent)) -> Result<(), RecoveryError> {
		self.consume(true, emit)
	}
}

fn valid_utf8_prefix(input: &[u8], final_chunk: bool) -> Result<usize, RecoveryError> {
	match Str::from_utf8(input) {
		Ok(_) => Ok(input.len()),
		Err(error) if error.error_len().is_none() && !final_chunk => Ok(error.valid_up_to()),
		Err(_) => Err(RecoveryError::InvalidInput {
			stage:  "tag-scanner",
			reason: sf!("input is not valid UTF-8"),
		}),
	}
}

fn find(haystack: &[u8], needle: &[u8], examined: &mut u64) -> Option<usize> {
	if haystack.len() < needle.len() {
		return None;
	}
	for (at, window) in haystack.windows(needle.len()).enumerate() {
		*examined = examined.saturating_add(1);
		if window == needle {
			return Some(at);
		}
	}
	None
}

fn suffix_overlap_any(input: &[u8], delimiters: &[Delimiter]) -> usize {
	delimiters
		.iter()
		.map(|rule| suffix_overlap(input, rule.open))
		.max()
		.unwrap_or(0)
}

fn suffix_overlap(input: &[u8], tag: &[u8]) -> usize {
	let max = input.len().min(tag.len().saturating_sub(1));
	(1..=max)
		.rev()
		.find(|&length| input.ends_with(&tag[..length]))
		.unwrap_or(0)
}

#[cfg(test)]
mod tests {
	use super::*;

	static TAGS: &[Delimiter] =
		&[Delimiter { id: DelimiterId("think"), open: b"<think>", close: b"</think>" }];

	fn scan(parts: &[&[u8]]) -> Vec<TagEvent> {
		let mut scanner = TagScanner::new(TAGS, 1024);
		let mut out = Vec::new();
		for part in parts {
			scanner
				.push(Bytes::copy_from_slice(part), &mut |event| out.push(event))
				.unwrap();
		}
		scanner.finish(&mut |event| out.push(event)).unwrap();
		out
	}

	#[test]
	fn delimiter_scans_identically_across_utf8_and_marker_splits() {
		let input = "前<think>理🙂</think>后".as_bytes();
		let whole = scan(&[input]);
		for split in 0..=input.len() {
			assert_eq!(scan(&[&input[..split], &input[split..]]), whole, "split {split}");
		}
		let bytewise: Vec<&[u8]> = input.chunks(1).collect();
		assert_eq!(scan(&bytewise), whole);
	}

	#[test]
	fn incomplete_block_is_literal_text() {
		assert_eq!(scan(&[b"x<think>y"]), vec![
			TagEvent::Text(Bytes::from_static(b"x")),
			TagEvent::Text(Bytes::from_static(b"<think>y"))
		]);
	}
}
