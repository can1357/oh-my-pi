// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Utilities for reading files as chunks.

// spell-checker:ignore ELEMS
#![allow(dead_code)]
// Ignores non-used warning for `borrow_buffer` in `Chunk`

use std::{
	io::{ErrorKind, Read},
	ops::Range,
	sync::mpsc::SyncSender,
};

use memchr::memchr_iter;
use self_cell::self_cell;
use uucore::error::{UResult, USimpleError};

use crate::{
	GeneralBigDecimalParseResult, GlobalSettings, Line, SortMode, numeric_str_cmp::NumInfo,
};

const ALLOC_CHUNK_SIZE: usize = 64 * 1024;
const MAX_TOKEN_BUFFER_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOKEN_BUFFER_ELEMS: usize = MAX_TOKEN_BUFFER_BYTES / size_of::<Range<usize>>();

self_cell!(
	 /// The chunk that is passed around between threads.
	 pub struct Chunk {
		  owner: Vec<u8>,

		  #[covariant]
		  dependent: ChunkContents,
	 }

	 impl {Debug}
);

#[derive(Debug)]
pub struct ChunkContents<'a> {
	pub lines:           Vec<Line<'a>>,
	pub line_data:       LineData<'a>,
	pub token_buffer:    Vec<Range<usize>>,
	pub line_count_hint: usize,
}

#[derive(Debug, Default)]
pub struct LineData<'a> {
	pub selections:           Vec<&'a [u8]>,
	pub num_infos:            Vec<NumInfo>,
	pub parsed_floats:        Vec<GeneralBigDecimalParseResult>,
	pub line_num_floats:      Vec<Option<f64>>,
	/// Arena buffer holding all collation sort keys concatenated.
	pub collation_key_buffer: Vec<u8>,
	/// End offsets into `collation_key_buffer` for each line's sort key.
	pub collation_key_ends:   Vec<usize>,
}

impl LineData<'_> {
	/// Get the collation sort key for a line at the given index.
	pub fn collation_key(&self, index: usize) -> &[u8] {
		let start = if index == 0 {
			0
		} else {
			self.collation_key_ends[index - 1]
		};
		let end = self.collation_key_ends[index];
		&self.collation_key_buffer[start..end]
	}
}

impl Chunk {
	/// Destroy this chunk and return its components to be reused.
	pub fn recycle(mut self) -> RecycledChunk {
		let mut recycled_contents = self.with_dependent_mut(|_, contents| {
			contents.lines.clear();
			contents.line_data.selections.clear();
			contents.line_data.num_infos.clear();
			contents.line_data.parsed_floats.clear();
			contents.line_data.line_num_floats.clear();
			contents.line_data.collation_key_buffer.clear();
			contents.line_data.collation_key_ends.clear();
			contents.token_buffer.clear();
			let lines = unsafe {
				// SAFETY: It is safe to (temporarily) transmute to a vector of lines with a
				// longer lifetime, because the vector is empty.
				// Transmuting is necessary to make recycling possible. See https://github.com/rust-lang/rfcs/pull/2802
				// for a rfc to make this unnecessary. Its example is similar to the code here.
				std::mem::transmute::<Vec<Line<'_>>, Vec<Line<'static>>>(std::mem::take(
					&mut contents.lines,
				))
			};
			let selections = unsafe {
				// SAFETY: (same as above) It is safe to (temporarily) transmute to a vector of
				// &str with a longer lifetime, because the vector is empty.
				std::mem::transmute::<Vec<&'_ [u8]>, Vec<&'static [u8]>>(std::mem::take(
					&mut contents.line_data.selections,
				))
			};
			RecycledChunk {
				lines,
				selections,
				num_infos: std::mem::take(&mut contents.line_data.num_infos),
				parsed_floats: std::mem::take(&mut contents.line_data.parsed_floats),
				line_num_floats: std::mem::take(&mut contents.line_data.line_num_floats),
				collation_key_buffer: std::mem::take(&mut contents.line_data.collation_key_buffer),
				collation_key_ends: std::mem::take(&mut contents.line_data.collation_key_ends),
				token_buffer: std::mem::take(&mut contents.token_buffer),
				line_count_hint: contents.line_count_hint,
				// buffer is set below after we consume `self`
				buffer: Vec::new(),
			}
		});
		recycled_contents.buffer = self.into_owner();
		recycled_contents
	}

	pub fn lines(&self) -> &Vec<Line<'_>> {
		&self.borrow_dependent().lines
	}

	pub fn line_data(&self) -> &LineData<'_> {
		&self.borrow_dependent().line_data
	}
}

pub struct RecycledChunk {
	lines:                Vec<Line<'static>>,
	selections:           Vec<&'static [u8]>,
	num_infos:            Vec<NumInfo>,
	parsed_floats:        Vec<GeneralBigDecimalParseResult>,
	line_num_floats:      Vec<Option<f64>>,
	collation_key_buffer: Vec<u8>,
	collation_key_ends:   Vec<usize>,
	token_buffer:         Vec<Range<usize>>,
	line_count_hint:      usize,
	buffer:               Vec<u8>,
}

impl RecycledChunk {
	pub fn new(capacity: usize) -> Self {
		Self {
			lines:                Vec::new(),
			selections:           Vec::new(),
			num_infos:            Vec::new(),
			parsed_floats:        Vec::new(),
			line_num_floats:      Vec::new(),
			collation_key_buffer: Vec::new(),
			collation_key_ends:   Vec::new(),
			token_buffer:         Vec::new(),
			line_count_hint:      0,
			buffer:               vec![0; capacity],
		}
	}
}

/// Read a chunk, parse lines and send them.
///
/// No empty chunk will be sent. If we reach the end of the input, `false` is
/// returned. However, if this function returns `true`, it is not guaranteed
/// that there is still input left: If the input fits _exactly_ into a buffer,
/// we will only notice that there's nothing more to read at the next
/// invocation. In case there is no input left, nothing will be sent.
///
/// # Arguments
///
/// (see also `read_to_chunk` for a more detailed documentation)
///
/// * `sender`: The sender to send the lines to the sorter.
/// * `recycled_chunk`: The recycled chunk, as returned by `Chunk::recycle`.
///   (i.e. `buffer.len()` should be equal to `buffer.capacity()`)
/// * `max_buffer_size`: How big `buffer` can be.
/// * `carry_over`: The bytes that must be carried over in between invocations.
/// * `file`: The current file.
/// * `next_files`: What `file` should be updated to next.
/// * `separator`: The line separator.
/// * `settings`: The global settings.
#[allow(clippy::too_many_arguments)]
pub fn read<T: Read>(
	sender: &SyncSender<Chunk>,
	recycled_chunk: RecycledChunk,
	max_buffer_size: Option<usize>,
	carry_over: &mut Vec<u8>,
	file: &mut T,
	next_files: &mut impl Iterator<Item = UResult<T>>,
	separator: u8,
	settings: &GlobalSettings,
) -> UResult<bool> {
	let RecycledChunk {
		lines,
		selections,
		num_infos,
		parsed_floats,
		line_num_floats,
		collation_key_buffer,
		collation_key_ends,
		mut token_buffer,
		mut line_count_hint,
		mut buffer,
	} = recycled_chunk;
	if buffer.len() < carry_over.len() {
		// Separate carry_over and copy them to avoid cost of 0 fill buffer
		buffer.extend_from_slice(&carry_over[buffer.len()..]);
	}
	buffer[..carry_over.len()].copy_from_slice(carry_over);
	let (read, should_continue) =
		read_to_buffer(file, next_files, &mut buffer, max_buffer_size, carry_over.len(), separator)?;
	carry_over.clear();
	carry_over.extend_from_slice(&buffer[read..]);

	if read != 0 {
		let payload: UResult<Chunk> = Chunk::try_new(buffer, |buffer| {
			let selections = unsafe {
				// SAFETY: It is safe to transmute to an empty vector of selections with shorter
				// lifetime. It was only temporarily transmuted to a Vec<Line<'static>> to
				// make recycling possible.
				std::mem::transmute::<Vec<&'static [u8]>, Vec<&'_ [u8]>>(selections)
			};
			let mut lines = unsafe {
				// SAFETY: (same as above) It is safe to transmute to a vector of lines with
				// shorter lifetime, because it was only temporarily transmuted to a
				// Vec<Line<'static>> to make recycling possible.
				std::mem::transmute::<Vec<Line<'static>>, Vec<Line<'_>>>(lines)
			};
			let read = &buffer[..read];
			let mut line_data = LineData {
				selections,
				num_infos,
				parsed_floats,
				line_num_floats,
				collation_key_buffer,
				collation_key_ends,
			};
			parse_lines(
				read,
				&mut lines,
				&mut line_data,
				&mut token_buffer,
				&mut line_count_hint,
				separator,
				settings,
			);
			Ok(ChunkContents { lines, line_data, token_buffer, line_count_hint })
		});
		sender.send(payload?).unwrap();
	}
	Ok(should_continue)
}

/// Split `read` into `Line`s, and add them to `lines`.
fn parse_lines<'a>(
	read: &'a [u8],
	lines: &mut Vec<Line<'a>>,
	line_data: &mut LineData<'a>,
	token_buffer: &mut Vec<Range<usize>>,
	line_count_hint: &mut usize,
	separator: u8,
	settings: &GlobalSettings,
) {
	let read = read.strip_suffix(&[separator]).unwrap_or(read);

	assert!(lines.is_empty());
	assert!(line_data.selections.is_empty());
	assert!(line_data.num_infos.is_empty());
	assert!(line_data.parsed_floats.is_empty());
	assert!(line_data.line_num_floats.is_empty());
	assert!(line_data.collation_key_buffer.is_empty());
	assert!(line_data.collation_key_ends.is_empty());
	token_buffer.clear();
	const SMALL_CHUNK_BYTES: usize = 64 * 1024;
	let mut estimated = (*line_count_hint).max(1);
	let mut exact_line_count = None;
	if *line_count_hint == 0 || read.len() <= SMALL_CHUNK_BYTES {
		let count = if read.is_empty() {
			1
		} else {
			memchr_iter(separator, read).count() + 1
		};
		exact_line_count = Some(count);
		estimated = count;
	} else if estimated == 1 {
		const LINE_LEN_HINT: usize = 128;
		estimated = (read.len() / LINE_LEN_HINT).clamp(1, 1024);
	}
	lines.reserve(estimated);
	if settings.precomputed.selections_per_line > 0 {
		line_data
			.selections
			.reserve(estimated.saturating_mul(settings.precomputed.selections_per_line));
	}
	if settings.precomputed.num_infos_per_line > 0 {
		line_data
			.num_infos
			.reserve(estimated.saturating_mul(settings.precomputed.num_infos_per_line));
	}
	if settings.precomputed.floats_per_line > 0 {
		line_data
			.parsed_floats
			.reserve(estimated.saturating_mul(settings.precomputed.floats_per_line));
	}
	if settings.mode == SortMode::Numeric {
		line_data.line_num_floats.reserve(estimated);
	}
	let mut start = 0usize;
	let mut index = 0usize;
	for sep_idx in memchr_iter(separator, read) {
		let line = &read[start..sep_idx];
		lines.push(Line::create(line, index, line_data, token_buffer, settings));
		index += 1;
		start = sep_idx + 1;
	}
	let line = &read[start..];
	lines.push(Line::create(line, index, line_data, token_buffer, settings));
	*line_count_hint = exact_line_count.unwrap_or(index + 1);
}

/// Read from `file` into `buffer`.
///
/// This function makes sure that at least two lines are read (unless we reach
/// EOF and there's no next file), growing the buffer if necessary.
/// The last line is likely to not have been fully read into the buffer. Its
/// bytes must be copied to the front of the buffer for the next invocation so
/// that it can be continued to be read (see the return values and
/// `start_offset`).
///
/// # Arguments
///
/// * `file`: The file to start reading from.
/// * `next_files`: When `file` reaches EOF, it is updated to
///   `next_files.next()` if that is `Some`, and this function continues
///   reading.
/// * `buffer`: The buffer that is filled with bytes. Its contents will mostly
///   be overwritten (see `start_offset` as well). It will be grown up to
///   `max_buffer_size` if necessary, but it will always grow to read at least
///   two lines.
/// * `max_buffer_size`: Grow the buffer to at most this length. If None, the
///   buffer will not grow, unless needed to read at least two lines.
/// * `start_offset`: The amount of bytes at the start of `buffer` that were
///   carried over from the previous read and should not be overwritten.
/// * `separator`: The byte that separates lines.
///
/// # Returns
///
/// * The amount of bytes in `buffer` that can now be interpreted as lines. The
///   remaining bytes must be copied to the start of the buffer for the next
///   invocation, if another invocation is necessary, which is determined by the
///   other return value.
/// * Whether this function should be called again.
fn read_to_buffer<T: Read>(
	file: &mut T,
	next_files: &mut impl Iterator<Item = UResult<T>>,
	buffer: &mut Vec<u8>,
	max_buffer_size: Option<usize>,
	start_offset: usize,
	separator: u8,
) -> UResult<(usize, bool)> {
	let mut read_target = &mut buffer[start_offset..];
	let mut last_file_empty = true;
	let mut newline_search_offset = 0;
	let mut found_newline = false;
	loop {
		match file.read(read_target) {
			Ok(0) => {
				if read_target.is_empty() {
					// chunk is full
					if let Some(max_buffer_size) = max_buffer_size
						&& max_buffer_size > buffer.len()
					{
						// we can grow the buffer
						let prev_len = buffer.len();
						buffer.resize(prev_len + ALLOC_CHUNK_SIZE, 0);
						read_target = &mut buffer[prev_len..];
						continue;
					}

					let mut sep_iter =
						memchr_iter(separator, &buffer[newline_search_offset..buffer.len()]).rev();
					newline_search_offset = buffer.len();
					if let Some(last_line_end) = sep_iter.next() {
						if found_newline || sep_iter.next().is_some() {
							// We read enough lines.
							// We want to include the separator here, because it shouldn't be carried over.
							return Ok((last_line_end + 1, true));
						}
						found_newline = true;
					}

					// We need to read more lines
					let len = buffer.len();
					buffer.resize(len + ALLOC_CHUNK_SIZE, 0);
					read_target = &mut buffer[len..];
				} else {
					// This file has been fully read.
					let mut leftover_len = read_target.len();
					if !last_file_empty {
						// The file was not empty.
						let read_len = buffer.len() - leftover_len;
						if buffer[read_len - 1] != separator {
							// The file did not end with a separator. We have to insert one.
							buffer[read_len] = separator;
							leftover_len -= 1;
						}
						let read_len = buffer.len() - leftover_len;
						read_target = &mut buffer[read_len..];
					}
					if let Some(next_file) = next_files.next() {
						// There is another file.
						last_file_empty = true;
						*file = next_file?;
					} else {
						// This was the last file.
						let read_len = buffer.len() - leftover_len;
						return Ok((read_len, false));
					}
				}
			},
			Ok(n) => {
				read_target = &mut read_target[n..];
				last_file_empty = false;
			},
			Err(e) if e.kind() == ErrorKind::Interrupted => {
				// retry
			},
			Err(e) => return Err(USimpleError::new(2, e.to_string())),
		}
	}
}

/// Parse a buffer into a `ChunkContents` suitable for `Chunk::try_new`.
/// Used by the WASI single-threaded sort path.
#[cfg(target_os = "wasi")]
pub fn parse_into_chunk<'a>(
	buffer: &'a [u8],
	separator: u8,
	settings: &GlobalSettings,
) -> ChunkContents<'a> {
	let mut lines = Vec::new();
	let mut line_data = LineData::default();
	let mut token_buffer = Vec::new();
	let mut line_count_hint = 0;
	parse_lines(
		buffer,
		&mut lines,
		&mut line_data,
		&mut token_buffer,
		&mut line_count_hint,
		separator,
		settings,
	);
	ChunkContents { lines, line_data, token_buffer, line_count_hint }
}
