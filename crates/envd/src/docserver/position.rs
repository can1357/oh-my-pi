use bytes::Bytes;
use omp_core::Str;
use omp_proto::lsp::{Position, PositionEncoding, Range};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// An LSP replacement edit.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
	/// Range replaced by `new_text`.
	pub range:    Range,
	/// UTF-8 replacement text.
	pub new_text: Str,
}

/// Converts an LSP position to a UTF-8 byte offset.
pub fn position_to_offset(
	encoding: PositionEncoding,
	text: &str,
	position: Position,
) -> Result<usize, PositionError> {
	let (start, end) = line_bounds(text, position.line)
		.ok_or(PositionError::LineOutOfBounds { line: position.line })?;
	let line = &text[start..end];
	let target = position.character as usize;
	let mut units = 0usize;
	for (relative, character) in line.char_indices() {
		if units == target {
			return Ok(start + relative);
		}
		let width = character_width(encoding, character);
		if target < units + width {
			return Err(PositionError::InsideCodePoint { position });
		}
		units += width;
	}
	if units == target {
		Ok(end)
	} else {
		Err(PositionError::CharacterOutOfBounds { position })
	}
}

/// Converts a UTF-8-boundary byte offset to an LSP position.
pub fn offset_to_position(
	encoding: PositionEncoding,
	text: &str,
	offset: usize,
) -> Result<Position, PositionError> {
	if offset > text.len() {
		return Err(PositionError::ByteOffsetOutOfBounds { offset });
	}
	if !text.is_char_boundary(offset) {
		return Err(PositionError::NotUtf8Boundary { offset });
	}

	let mut line = 0u32;
	let mut line_start = 0usize;
	let bytes = text.as_bytes();
	let mut cursor = 0usize;
	while cursor < bytes.len() {
		let delimiter = match bytes[cursor] {
			b'\r' if bytes.get(cursor + 1) == Some(&b'\n') => Some(2usize),
			b'\r' | b'\n' => Some(1usize),
			_ => None,
		};
		if let Some(width) = delimiter {
			if offset <= cursor {
				return position_in_line(encoding, text, line, line_start, offset);
			}
			if offset < cursor + width {
				return Err(PositionError::InsideLineEnding { offset });
			}
			cursor += width;
			line = line.checked_add(1).ok_or(PositionError::LineOverflow)?;
			line_start = cursor;
			if offset == cursor {
				return Ok(Position { line, character: 0 });
			}
			continue;
		}
		cursor += 1;
	}
	position_in_line(encoding, text, line, line_start, offset)
}

/// Converts a half-open LSP range to UTF-8 byte offsets.
pub fn range_to_offsets(
	encoding: PositionEncoding,
	text: &str,
	range: Range,
) -> Result<(usize, usize), PositionError> {
	let start = position_to_offset(encoding, text, range.start)?;
	let end = position_to_offset(encoding, text, range.end)?;
	if start > end {
		return Err(PositionError::ReversedRange { start, end });
	}
	Ok((start, end))
}

/// Converts a half-open UTF-8 byte range to LSP positions.
pub fn offsets_to_range(
	encoding: PositionEncoding,
	text: &str,
	start: usize,
	end: usize,
) -> Result<Range, PositionError> {
	if start > end {
		return Err(PositionError::ReversedRange { start, end });
	}
	Ok(Range {
		start: offset_to_position(encoding, text, start)?,
		end:   offset_to_position(encoding, text, end)?,
	})
}

const fn character_width(encoding: PositionEncoding, character: char) -> usize {
	match encoding {
		PositionEncoding::Utf8 => character.len_utf8(),
		PositionEncoding::Utf16 => character.len_utf16(),
		PositionEncoding::Utf32 => 1,
	}
}

fn position_in_line(
	encoding: PositionEncoding,
	text: &str,
	line: u32,
	line_start: usize,
	offset: usize,
) -> Result<Position, PositionError> {
	let character = text[line_start..offset]
		.chars()
		.try_fold(0usize, |count, character| count.checked_add(character_width(encoding, character)))
		.ok_or(PositionError::CharacterOverflow)?;
	let character = u32::try_from(character).map_err(|_| PositionError::CharacterOverflow)?;
	Ok(Position { line, character })
}

/// Applies simultaneous, non-overlapping LSP edits to UTF-8 text.
pub fn apply_text_edits(
	text: &str,
	edits: &[TextEdit],
	encoding: PositionEncoding,
) -> Result<Bytes, PositionError> {
	let mut resolved = Vec::with_capacity(edits.len());
	for (index, edit) in edits.iter().enumerate() {
		let (start, end) = range_to_offsets(encoding, text, edit.range)?;
		resolved.push((start, end, index, edit.new_text.as_str()));
	}
	resolved.sort_by_key(|&(start, end, index, _)| (start, end, index));

	let mut previous: Option<(usize, usize)> = None;
	for &(start, end, ..) in &resolved {
		if let Some((previous_start, previous_end)) = previous
			&& (start < previous_end
				|| (start == previous_start && (start == end || previous_start == previous_end)))
		{
			return Err(PositionError::OverlappingEdits);
		}
		previous = Some((start, end));
	}

	let removed = resolved
		.iter()
		.try_fold(0usize, |total, (start, end, ..)| total.checked_add(end - start))
		.ok_or(PositionError::OutputTooLarge)?;
	let inserted = resolved
		.iter()
		.try_fold(0usize, |total, (_, _, _, replacement)| total.checked_add(replacement.len()))
		.ok_or(PositionError::OutputTooLarge)?;
	let capacity = text
		.len()
		.checked_sub(removed)
		.and_then(|length| length.checked_add(inserted))
		.ok_or(PositionError::OutputTooLarge)?;
	let mut output = Vec::with_capacity(capacity);
	let mut cursor = 0usize;
	for (start, end, _, replacement) in resolved {
		output.extend_from_slice(&text.as_bytes()[cursor..start]);
		output.extend_from_slice(replacement.as_bytes());
		cursor = end;
	}
	output.extend_from_slice(&text.as_bytes()[cursor..]);
	Ok(Bytes::from(output))
}

fn line_bounds(text: &str, wanted: u32) -> Option<(usize, usize)> {
	let bytes = text.as_bytes();
	let mut line = 0u32;
	let mut start = 0usize;
	let mut cursor = 0usize;
	loop {
		if line == wanted {
			while cursor < bytes.len() && bytes[cursor] != b'\r' && bytes[cursor] != b'\n' {
				cursor += 1;
			}
			return Some((start, cursor));
		}
		if cursor >= bytes.len() {
			return None;
		}
		match bytes[cursor] {
			b'\r' => {
				cursor += 1;
				if bytes.get(cursor) == Some(&b'\n') {
					cursor += 1;
				}
			},
			b'\n' => cursor += 1,
			_ => {
				cursor += 1;
				continue;
			},
		}
		line = line.checked_add(1)?;
		start = cursor;
	}
}

/// A checked position or edit failure.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum PositionError {
	/// The requested line does not exist.
	#[error("LSP line {line} is out of bounds")]
	LineOutOfBounds {
		/// Requested zero-based line.
		line: u32,
	},
	/// The character lies beyond the end of its line.
	#[error("LSP position {position} is beyond the end of its line")]
	CharacterOutOfBounds {
		/// Requested LSP position.
		position: Position,
	},
	/// The character offset splits a multi-unit Unicode scalar value.
	#[error("LSP position {position} splits an encoded character")]
	InsideCodePoint {
		/// Position that splits the encoded character.
		position: Position,
	},
	/// The byte offset lies beyond the document.
	#[error("byte offset {offset} is out of bounds")]
	ByteOffsetOutOfBounds {
		/// Requested byte offset.
		offset: usize,
	},
	/// The byte offset is not a UTF-8 boundary.
	#[error("byte offset {offset} is not a UTF-8 boundary")]
	NotUtf8Boundary {
		/// Requested byte offset.
		offset: usize,
	},
	/// The byte offset lies between CR and LF in a CRLF delimiter.
	#[error("byte offset {offset} lies inside a line ending")]
	InsideLineEnding {
		/// Requested byte offset.
		offset: usize,
	},
	/// The range has its end before its start.
	#[error("text range is reversed ({start}..{end})")]
	ReversedRange {
		/// Inclusive byte start.
		start: usize,
		/// Exclusive byte end.
		end:   usize,
	},
	/// Two edits target overlapping or ambiguous ranges.
	#[error("text edits overlap")]
	OverlappingEdits,
	/// A position line cannot fit in the LSP representation.
	#[error("LSP line number overflow")]
	LineOverflow,
	/// A position character cannot fit in the LSP representation.
	#[error("LSP character number overflow")]
	CharacterOverflow,
	/// The edited output is too large to address.
	#[error("edited output is too large")]
	OutputTooLarge,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn converts_all_position_encodings() {
		let text = "a😀z\r\nβ";
		assert_eq!(offset_to_position(PositionEncoding::Utf8, text, 5).unwrap(), Position {
			line:      0,
			character: 5,
		});
		assert_eq!(offset_to_position(PositionEncoding::Utf16, text, 5).unwrap(), Position {
			line:      0,
			character: 3,
		});
		assert_eq!(offset_to_position(PositionEncoding::Utf32, text, 5).unwrap(), Position {
			line:      0,
			character: 2,
		});
		assert_eq!(
			position_to_offset(PositionEncoding::Utf16, text, Position { line: 1, character: 1 },)
				.unwrap(),
			text.len()
		);
		assert!(matches!(
			position_to_offset(PositionEncoding::Utf16, text, Position { line: 0, character: 2 },),
			Err(PositionError::InsideCodePoint { .. })
		));
	}

	#[test]
	fn applies_edits_in_original_coordinates() {
		let edits = [
			TextEdit {
				range:    Range {
					start: Position { line: 0, character: 1 },
					end:   Position { line: 0, character: 3 },
				},
				new_text: Str::new("X"),
			},
			TextEdit {
				range:    Range {
					start: Position { line: 1, character: 0 },
					end:   Position { line: 1, character: 1 },
				},
				new_text: Str::new("Y"),
			},
		];
		assert_eq!(
			apply_text_edits("a😀z\nβ", &edits, PositionEncoding::Utf16).unwrap(),
			Bytes::from_static(b"aXz\nY")
		);
	}

	#[test]
	fn applies_the_same_server_edit_in_every_encoding() {
		for (encoding, end_character) in
			[(PositionEncoding::Utf8, 5), (PositionEncoding::Utf16, 3), (PositionEncoding::Utf32, 2)]
		{
			let edit = TextEdit {
				range:    Range {
					start: Position { line: 0, character: 1 },
					end:   Position { line: 0, character: end_character },
				},
				new_text: Str::new("!"),
			};
			assert_eq!(
				apply_text_edits("a😀z", &[edit], encoding).unwrap(),
				Bytes::from_static(b"a!z")
			);
		}
	}
}
