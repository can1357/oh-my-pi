//! `sort` builtin: sort, merge, or check lines of text.
//!
//! Ported from uutils coreutils 0.8.0.

// Although these links don't always seem to describe reality, check out the
// POSIX and GNU specs: https://pubs.opengroup.org/onlinepubs/9699919799/utilities/sort.html
// https://www.gnu.org/software/coreutils/manual/html_node/sort-invocation.html

use std::{
	process::{Child, Stdio},
	thread,
};

use crate::host::ChildEnv;

/// The `--compress-program` used for external-sort temporary files, together
/// with the shell context its children inherit.
///
/// External sorting pipes every spilled chunk through this program and back, so
/// the children are spawned from deep inside the temp-file abstraction, far from
/// the `Host`. Carrying an owned [`ChildEnv`] here is what keeps them resolving
/// the shell's `PATH`, running in the shell's working directory, and reporting
/// on the command's stderr instead of the host process's.
#[derive(Clone)]
pub struct Compressor {
	prog: String,
	env:  ChildEnv,
}

impl Compressor {
	/// Spawns the compressor, with `stdin`/`stdout` as given and stderr piped
	/// back to the command's own standard error.
	fn spawn(
		&self,
		stdin: impl Into<Stdio>,
		stdout: impl Into<Stdio>,
		decompress: bool,
	) -> SortResult<(Child, thread::JoinHandle<()>)> {
		let mut command = self.env.command(&self.prog);
		command.stdin(stdin).stdout(stdout);
		if decompress {
			command.arg("-d");
		}
		let mut child = command
			.spawn()
			.map_err(|err| SortError::CompressProgExecutionFailed {
				prog:  self.prog.clone(),
				error: err,
			})?;
		// Piped by `ChildEnv::command`, so this is always present.
		let stderr = child.stderr.take().expect("compressor stderr is piped");
		let forwarder = self.env.forward_stderr(stderr);
		Ok((child, forwarder))
	}
}

mod buffer_hint {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Heuristics for determining buffer size for external sorting.
use std::ffi::OsString;

// Heuristics to size the external sort buffer without overcommit memory.
pub(crate) fn automatic_buffer_size(files: &[OsString]) -> usize {
	let file_hint = file_size_hint(files);
	let mem_hint = available_memory_hint();

	// Prefer the tighter bound when both hints exist, otherwise fall back to
	// whichever hint is available.
	match (file_hint, mem_hint) {
		(Some(file), Some(mem)) => file.min(mem),
		(Some(file), None) => file,
		(None, Some(mem)) => mem,
		(None, None) => super::FALLBACK_AUTOMATIC_BUF_SIZE,
	}
}

fn file_size_hint(files: &[OsString]) -> Option<usize> {
	// Estimate total bytes across real files; non-regular inputs are skipped.
	let mut total_bytes: u128 = 0;

	for file in files {
		if file == super::STDIN_FILE {
			continue;
		}

		let Ok(metadata) = std::fs::metadata(file) else {
			continue;
		};

		if !metadata.is_file() {
			continue;
		}

		total_bytes = total_bytes.saturating_add(metadata.len() as u128);

		if total_bytes >= (super::MAX_AUTOMATIC_BUF_SIZE as u128) * 8 {
			break;
		}
	}

	if total_bytes == 0 {
		return None;
	}

	let desired_bytes = desired_file_buffer_bytes(total_bytes);
	Some(clamp_hint(desired_bytes))
}

fn available_memory_hint() -> Option<usize> {
	#[cfg(target_os = "linux")]
	if let Some(bytes) = uucore::parser::parse_size::available_memory_bytes() {
		return Some(clamp_hint(bytes / 4));
	}

	physical_memory_bytes().map(|bytes| clamp_hint(bytes / 4))
}

fn clamp_hint(bytes: u128) -> usize {
	let min = super::MIN_AUTOMATIC_BUF_SIZE as u128;
	let max = super::MAX_AUTOMATIC_BUF_SIZE as u128;
	let clamped = bytes.clamp(min, max);
	clamped.min(usize::MAX as u128) as usize
}

fn desired_file_buffer_bytes(total_bytes: u128) -> u128 {
	if total_bytes == 0 {
		return 0;
	}

	let max = super::MAX_AUTOMATIC_BUF_SIZE as u128;

	if total_bytes <= max {
		return total_bytes.saturating_mul(12).clamp(total_bytes, max);
	}

	let quarter = total_bytes / 4;
	quarter.max(max)
}

fn physical_memory_bytes() -> Option<u128> {
	#[cfg(all(
		target_family = "unix",
		not(target_os = "redox"),
		any(target_os = "linux", target_os = "android")
	))]
	{
		physical_memory_bytes_unix()
	}

	#[cfg(any(
		not(target_family = "unix"),
		target_os = "redox",
		not(any(target_os = "linux", target_os = "android"))
	))]
	{
		// No portable or safe API is available here to detect total physical memory.
		None
	}
}

#[cfg(all(
	target_family = "unix",
	not(target_os = "redox"),
	any(target_os = "linux", target_os = "android")
))]
fn physical_memory_bytes_unix() -> Option<u128> {
	use nix::unistd::{SysconfVar, sysconf};

	let pages = match sysconf(SysconfVar::_PHYS_PAGES) {
		Ok(Some(pages)) if pages > 0 => u128::try_from(pages).ok()?,
		_ => return None,
	};

	let page_size = match sysconf(SysconfVar::PAGE_SIZE) {
		Ok(Some(page_size)) if page_size > 0 => u128::try_from(page_size).ok()?,
		_ => return None,
	};

	Some(pages.saturating_mul(page_size))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn desired_buffer_matches_total_when_small() {
		let six_mebibytes = 6 * 1024 * 1024;
		let expected = ((six_mebibytes as u128) * 12)
			.clamp(six_mebibytes as u128, super::super::MAX_AUTOMATIC_BUF_SIZE as u128);
		assert_eq!(desired_file_buffer_bytes(six_mebibytes as u128), expected);
	}

	#[test]
	fn desired_buffer_caps_at_max_for_large_inputs() {
		let large = 256 * 1024 * 1024; // 256 MiB
		assert_eq!(
			desired_file_buffer_bytes(large as u128),
			super::super::MAX_AUTOMATIC_BUF_SIZE as u128
		);
	}
}

}
mod check {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Check if a file is ordered

use std::{cmp::Ordering, ffi::OsStr, io::Read, iter, thread};

use flume::{Receiver, Sender};
use itertools::Itertools;

use super::{
	AtomicOrdering, GlobalSettings, SortError, SortResult,
	chunks::{self, Chunk, RecycledChunk},
	compare_by, open,
};

/// Check if the file at `path` is ordered.
///
/// # Returns
///
/// The code we should exit with.
pub fn check(path: &OsStr, settings: &GlobalSettings) -> SortResult<()> {
	let max_allowed_cmp = if settings.unique {
		// If `unique` is enabled, the previous line must compare _less_ to the next
		// one.
		Ordering::Less
	} else {
		// Otherwise, the line previous line must compare _less or equal_ to the next
		// one.
		Ordering::Equal
	};
	let file = open(path)?;
	let (recycled_sender, recycled_receiver) = flume::bounded(2);
	let (loaded_sender, loaded_receiver) = flume::bounded(2);
	thread::spawn({
		let settings = settings.clone();
		move || reader(file, &recycled_receiver, &loaded_sender, &settings)
	});
	for _ in 0..2 {
		let _ = recycled_sender.send(RecycledChunk::new(if settings.buffer_size < 100 * 1024 {
			// when the buffer size is smaller than 100KiB we choose it instead of the
			// default. this improves testability.
			settings.buffer_size
		} else {
			100 * 1024
		}));
	}

	let mut prev_chunk: Option<Chunk> = None;
	let mut line_idx = 0;
	while let Ok(chunk) = loaded_receiver.recv() {
		line_idx += 1;
		if let Some(prev_chunk) = prev_chunk.take() {
			// Check if the first element of the new chunk is greater than the last
			// element from the previous chunk
			let prev_last = prev_chunk.lines().last().unwrap();
			let new_first = chunk.lines().first().unwrap();

			if compare_by(prev_last, new_first, settings, prev_chunk.line_data(), chunk.line_data())
				> max_allowed_cmp
			{
				return Err(
					SortError::Disorder {
						file:        path.to_owned(),
						line_number: line_idx,
						line:        String::from_utf8_lossy(new_first.line).into_owned(),
						silent:      settings.check_silent,
					}
					.into(),
				);
			}
			let _ = recycled_sender.send(prev_chunk.recycle());
		}

		for (a, b) in chunk.lines().iter().tuple_windows() {
			line_idx += 1;
			if compare_by(a, b, settings, chunk.line_data(), chunk.line_data()) > max_allowed_cmp {
				return Err(
					SortError::Disorder {
						file:        path.to_owned(),
						line_number: line_idx,
						line:        String::from_utf8_lossy(b.line).into_owned(),
						silent:      settings.check_silent,
					}
					.into(),
				);
			}
		}

		prev_chunk = Some(chunk);
	}
	Ok(())
}

/// The function running on the reader thread.
fn reader(
	mut file: Box<dyn Read + Send>,
	receiver: &Receiver<RecycledChunk>,
	sender: &Sender<Chunk>,
	settings: &GlobalSettings,
) -> SortResult<()> {
	let mut carry_over = vec![];
	while let Ok(recycled_chunk) = receiver.recv() {
		if settings.cancel.load(AtomicOrdering::Relaxed) {
			break;
		}
		let should_continue = chunks::read(
			sender,
			recycled_chunk,
			None,
			&mut carry_over,
			&mut file,
			&mut iter::empty(),
			settings.line_ending.into(),
			settings,
		)?;
		if !should_continue {
			break;
		}
	}
	Ok(())
}

}
mod chunks {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Utilities for reading files as chunks.

#![allow(dead_code, reason = "Chunk's self-referential storage exposes upstream recycling accessors")]

use std::{
	io::{ErrorKind, Read},
	ops::Range,
};

use flume::Sender;
use memchr::memchr_iter;
use self_cell::self_cell;

use super::{
	GeneralBigDecimalParseResult, GlobalSettings, Line, SortMode, SortError, SortResult, numeric_str_cmp::NumInfo,
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
	sender: &Sender<Chunk>,
	recycled_chunk: RecycledChunk,
	max_buffer_size: Option<usize>,
	carry_over: &mut Vec<u8>,
	file: &mut T,
	next_files: &mut impl Iterator<Item = SortResult<T>>,
	separator: u8,
	settings: &GlobalSettings,
) -> SortResult<bool> {
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
		let payload: SortResult<Chunk> = Chunk::try_new(buffer, |buffer| {
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
		// The upstream unwrap would panic with `SendError` when the receiver has
		// disconnected.
		// The receiver goes away when the consumer thread (sorter, merger, or
		// checker) stops early after hitting an error or a closed output. Stop
		// reading gracefully; the real error is reported by that other thread.
		if sender.send(payload?).is_err() {
			return Ok(false);
		}
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
	next_files: &mut impl Iterator<Item = SortResult<T>>,
	buffer: &mut Vec<u8>,
	max_buffer_size: Option<usize>,
	start_offset: usize,
	separator: u8,
) -> SortResult<(usize, bool)> {
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
			Err(e) => return Err(SortError::message(e.to_string())),
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

#[cfg(test)]
mod tests {
	use std::iter;

	use super::*;

	/// Regression test for issue #6736: when the receiving end of the chunk
	/// channel has disconnected (the consumer thread stopped early), `read`
	/// must stop gracefully and report end-of-input instead of panicking on
	/// `SendError`.
	#[test]
	fn read_stops_gracefully_when_receiver_disconnected() {
		let (sender, receiver) = flume::bounded::<Chunk>(1);
		drop(receiver);

		let settings = GlobalSettings::default();
		let mut carry_over = Vec::new();
		let mut input: &[u8] = b"c\na\nb\n";

		let should_continue = read(
			&sender,
			RecycledChunk::new(64 * 1024),
			None,
			&mut carry_over,
			&mut input,
			&mut iter::empty::<SortResult<&[u8]>>(),
			b'\n',
			&settings,
		)
		.expect("read must not error on a disconnected receiver");

		assert!(!should_continue);
	}
}

}
mod custom_str_cmp {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Custom string comparisons.
//!
//! The goal is to compare strings without transforming them first (i.e. not
//! allocating new strings)

use std::cmp::Ordering;

fn filter_char(c: u8, ignore_non_printing: bool, ignore_non_dictionary: bool) -> bool {
	if ignore_non_dictionary && !(c.is_ascii_alphanumeric() || c.is_ascii_whitespace()) {
		return false;
	}
	if ignore_non_printing && (c.is_ascii_control() || !c.is_ascii()) {
		return false;
	}
	true
}

fn cmp_chars(a: u8, b: u8, ignore_case: bool) -> Ordering {
	if ignore_case {
		a.to_ascii_uppercase().cmp(&b.to_ascii_uppercase())
	} else {
		a.cmp(&b)
	}
}

pub fn custom_str_cmp(
	a: &[u8],
	b: &[u8],
	ignore_non_printing: bool,
	ignore_non_dictionary: bool,
	ignore_case: bool,
) -> Ordering {
	if !(ignore_case || ignore_non_dictionary || ignore_non_printing) {
		// There are no custom settings. Fall back to the default strcmp, which is
		// faster.
		return a.cmp(b);
	}
	let mut a_chars = a
		.iter()
		.filter(|&&c| filter_char(c, ignore_non_printing, ignore_non_dictionary));
	let mut b_chars = b
		.iter()
		.filter(|&&c| filter_char(c, ignore_non_printing, ignore_non_dictionary));
	loop {
		let a_char = a_chars.next();
		let b_char = b_chars.next();
		match (a_char, b_char) {
			(None, None) => return Ordering::Equal,
			(Some(_), None) => return Ordering::Greater,
			(None, Some(_)) => return Ordering::Less,
			(Some(a_char), Some(b_char)) => {
				let ordering = cmp_chars(*a_char, *b_char, ignore_case);
				if ordering != Ordering::Equal {
					return ordering;
				}
			},
		}
	}
}

}
mod ext_sort {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! External sort: sort large inputs that may not fit in memory.
//!
//! On most platforms this uses a multi-threaded chunked approach with
//! temporary files. On WASI (no threads) we fall back to an in-memory sort.

#[cfg(not(target_os = "wasi"))]
mod threaded {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Threaded external sort: read input in chunks, sort them in a background
//! thread, and spill to temporary files when memory is exceeded.

use std::{
	cmp::Ordering,
	fs::File,
	io::{Read, Write},
	path::PathBuf,
	thread,
};

use flume::{Receiver, Sender};
use itertools::Itertools;

use super::super::{
	Compressor, GlobalSettings, Line, OpenFile, Output, SortError, SortResult,
	chunks::{self, Chunk, RecycledChunk},
	compare_by, merge,
	merge::{WriteableCompressedTmpFile, WriteablePlainTmpFile, WriteableTmpFile},
	print_sorted, sort_by, strip_errno,
	tmp_dir::TmpDirWrapper,
	AtomicOrdering,
};

// Note: update `test_sort::test_start_buffer` if this size is changed
// Fixed to 8 KiB (equivalent to `std::sys::io::DEFAULT_BUF_SIZE` on most
// targets)
const DEFAULT_BUF_SIZE: usize = 8 * 1024;

/// Sort files by using auxiliary files for storing intermediate chunks (if
/// needed), and output the result.
///
/// Two threads cooperate: one reads input and writes temporary chunk files,
/// while the other sorts each chunk in memory. Once all chunks are written,
/// they are merged back together for final output.
pub fn ext_sort(
	files: &mut impl Iterator<Item = SortResult<Box<dyn Read + Send>>>,
	settings: &GlobalSettings,
	output: Output,
	tmp_dir: &mut TmpDirWrapper,
	mut stderr: OpenFile,
) -> SortResult<()> {
	let (sorted_sender, sorted_receiver) = flume::bounded(1);
	let (recycled_sender, recycled_receiver) = flume::bounded(1);
	let sorter_handle = thread::spawn({
		let settings = settings.clone();
		move || sorter(&recycled_receiver, &sorted_sender, &settings)
	});

	// Test if compression program exists and works, disable if not. The probe
	// must resolve the program exactly as the real spawns will — against the
	// shell's `PATH` and working directory, not the host process's — or a
	// compressor installed only for the shell would be wrongly rejected.
	let mut effective_settings = settings.clone();
	if let Some(compress) = &settings.compress {
		let mut probe = compress.env.command(&compress.prog);
		probe
			.stdin(std::process::Stdio::null())
			.stdout(std::process::Stdio::null())
			.stderr(std::process::Stdio::null());
		match probe.spawn() {
			Ok(mut child) => {
				// Kill the test process immediately
				let _ = child.kill();
			},
			Err(err) => {
				// Print the error and disable compression
				let _ = writeln!(
					stderr,
					"sort: could not run compress program '{}': {}",
					compress.prog,
					strip_errno(&err)
				);
				effective_settings.compress = None;
			},
		}
	}

	let result = if effective_settings.compress.is_some() {
		reader_writer::<_, WriteableCompressedTmpFile>(
			files,
			&effective_settings,
			&sorted_receiver,
			recycled_sender,
			output,
			tmp_dir,
		)
	} else {
		reader_writer::<_, WriteablePlainTmpFile>(
			files,
			&effective_settings,
			&sorted_receiver,
			recycled_sender,
			output,
			tmp_dir,
		)
	};

	// Drop our end of the sorted-chunk channel so a still-running sorter (e.g.
	// after `reader_writer` bailed on an I/O error) unblocks its pending send and
	// exits, instead of deadlocking the join below.
	drop(sorted_receiver);

	// Surface a sorter-thread panic (e.g. a comparator or Rayon panic inside
	// `sort_by`) as an error. `chunks::read` now reports the sorter's
	// disconnection as end-of-input (issue #6736), so without joining here a
	// discarded panic would masquerade as a successful short read and let `sort`
	// exit 0 with truncated or empty output.
	match sorter_handle.join() {
		Ok(()) => result,
		Err(_) => result
			.and(Err(SortError::message("sort: sorter thread terminated unexpectedly".to_string()))),
	}
}

fn reader_writer<
	F: Iterator<Item = SortResult<Box<dyn Read + Send>>>,
	Tmp: WriteableTmpFile + 'static,
>(
	files: F,
	settings: &GlobalSettings,
	receiver: &Receiver<Chunk>,
	sender: Sender<Chunk>,
	output: Output,
	tmp_dir: &mut TmpDirWrapper,
) -> SortResult<()> {
	let separator = settings.line_ending.into();

	// Cap oversized buffer requests to avoid unnecessary allocations and give the
	// automatic heuristic room to grow when the user does not provide an explicit
	// value.
	let mut buffer_size = match settings.buffer_size {
		size if size <= 512 * 1024 * 1024 => size,
		size => size / 2,
	};
	if !settings.buffer_size_is_explicit {
		buffer_size = buffer_size.max(8 * 1024 * 1024);
	}
	let read_result: ReadResult<Tmp> =
		read_write_loop(files, tmp_dir, separator, buffer_size, settings, receiver, sender)?;
	match read_result {
		ReadResult::WroteChunksToFile { tmp_files } => {
			merge::merge_with_file_limit::<_, _, Tmp>(
				tmp_files.into_iter().map(merge::ClosedTmpFile::reopen),
				settings,
				output,
				tmp_dir,
			)?;
		},
		ReadResult::SortedSingleChunk(chunk) => {
			if settings.unique {
				print_sorted(
					chunk.lines().iter().dedup_by(|a, b| {
						compare_by(a, b, settings, chunk.line_data(), chunk.line_data())
							== Ordering::Equal
					}),
					settings,
					output,
				)?;
			} else {
				print_sorted(chunk.lines().iter(), settings, output)?;
			}
		},
		ReadResult::SortedTwoChunks([a, b]) => {
			let merged_iter = a.lines().iter().map(|line| (line, &a)).merge_by(
				b.lines().iter().map(|line| (line, &b)),
				|(line_a, a), (line_b, b)| {
					compare_by(line_a, line_b, settings, a.line_data(), b.line_data())
						!= Ordering::Greater
				},
			);
			if settings.unique {
				print_sorted(
					merged_iter
						.dedup_by(|(line_a, a), (line_b, b)| {
							compare_by(line_a, line_b, settings, a.line_data(), b.line_data())
								== Ordering::Equal
						})
						.map(|(line, _)| line),
					settings,
					output,
				)?;
			} else {
				print_sorted(merged_iter.map(|(line, _)| line), settings, output)?;
			}
		},
		ReadResult::EmptyInput => {
			// don't output anything
		},
	}
	Ok(())
}

/// The function that is executed on the sorter thread.
fn sorter(receiver: &Receiver<Chunk>, sender: &Sender<Chunk>, settings: &GlobalSettings) {
	while let Ok(mut payload) = receiver.recv() {
		if settings.cancel.load(AtomicOrdering::Relaxed) {
			return;
		}
		payload.with_dependent_mut(|_, contents| {
			sort_by(&mut contents.lines, settings, &contents.line_data);
		});
		if sender.send(payload).is_err() {
			// The receiver has gone away, likely because the other thread hit an error.
			// We stop silently because the actual error is printed by the other thread.
			return;
		}
	}
}

/// Describes how we read the chunks from the input.
enum ReadResult<I: WriteableTmpFile> {
	/// The input was empty. Nothing was read.
	EmptyInput,
	/// The input fits into a single Chunk, which was kept in memory.
	SortedSingleChunk(Chunk),
	/// The input fits into two chunks, which were kept in memory.
	SortedTwoChunks([Chunk; 2]),
	/// The input was read into multiple chunks, which were written to auxiliary
	/// files.
	WroteChunksToFile { tmp_files: Vec<I::Closed> },
}
/// The function that is executed on the reader/writer thread.
fn read_write_loop<I: WriteableTmpFile>(
	mut files: impl Iterator<Item = SortResult<Box<dyn Read + Send>>>,
	tmp_dir: &mut TmpDirWrapper,
	separator: u8,
	buffer_size: usize,
	settings: &GlobalSettings,
	receiver: &Receiver<Chunk>,
	sender: Sender<Chunk>,
) -> SortResult<ReadResult<I>> {
	let mut file = files.next().unwrap()?;

	let mut carry_over = vec![];
	// kick things off with two reads
	for _ in 0..2 {
		let should_continue = chunks::read(
			&sender,
			RecycledChunk::new(buffer_size.min(DEFAULT_BUF_SIZE)),
			Some(buffer_size),
			&mut carry_over,
			&mut file,
			&mut files,
			separator,
			settings,
		)?;

		if !should_continue {
			drop(sender);
			// We have already read the whole input. Since we are in our first two reads,
			// this means that we can fit the whole input into memory. Bypass writing below
			// and handle this case in a more straightforward way.
			return Ok(if let Ok(first_chunk) = receiver.recv() {
				if let Ok(second_chunk) = receiver.recv() {
					ReadResult::SortedTwoChunks([first_chunk, second_chunk])
				} else {
					ReadResult::SortedSingleChunk(first_chunk)
				}
			} else {
				ReadResult::EmptyInput
			});
		}
	}

	let mut sender_option = Some(sender);
	let mut tmp_files = vec![];
	loop {
		let Ok(chunk) = receiver.recv() else {
			return Ok(ReadResult::WroteChunksToFile { tmp_files });
		};

		let tmp_file =
			write::<I>(&chunk, tmp_dir.next_file()?, settings.compress.as_ref(), separator)?;
		tmp_files.push(tmp_file);

		let recycled_chunk = chunk.recycle();

		if let Some(sender) = &sender_option {
			let should_continue = chunks::read(
				sender,
				recycled_chunk,
				None,
				&mut carry_over,
				&mut file,
				&mut files,
				separator,
				settings,
			)?;
			if !should_continue {
				sender_option = None;
			}
		}
	}
}

/// Write the lines in `chunk` to `file`, separated by `separator`.
/// `compress` optionally pipes file contents through `--compress-program`.
fn write<I: WriteableTmpFile>(
	chunk: &Chunk,
	file: (File, PathBuf),
	compress: Option<&Compressor>,
	separator: u8,
) -> SortResult<I::Closed> {
	let mut tmp_file = I::create(file, compress)?;
	write_lines(chunk.lines(), tmp_file.as_write(), separator);
	tmp_file.finished_writing()
}

fn write_lines<T: Write>(lines: &[Line], writer: &mut T, separator: u8) {
	for s in lines {
		writer.write_all(s.line).unwrap();
		writer.write_all(&[separator]).unwrap();
	}
}

#[cfg(test)]
mod tests {
	use std::io::{Cursor, Read};

	use super::*;

	/// External (multi-chunk) sort must run to completion and emit fully sorted
	/// output. Regression guard for #6760: `ext_sort` now joins the sorter
	/// thread after `read_write_loop`. A tiny explicit buffer forces spilling
	/// to temporary files, so the join runs on the `WroteChunksToFile` path —
	/// it must surface sorted output rather than deadlock or truncate.
	#[test]
	fn ext_sort_spills_to_files_and_sorts() {
		let input: String = (0..200u32).rev().map(|i| format!("{i:04}\n")).collect();

		let settings =
			GlobalSettings { buffer_size: 64, buffer_size_is_explicit: true, ..Default::default() };

		let out_dir = tempfile::tempdir().expect("temp dir");
		let out_path = out_dir.path().join("sorted.txt");

		let mut files =
			std::iter::once(Ok(Box::new(Cursor::new(input.into_bytes())) as Box<dyn Read + Send>));
		let output = Output::new(Some(out_path.as_os_str()), None).expect("open output");
		let mut tmp_dir = TmpDirWrapper::new(std::env::temp_dir());

		ext_sort(
			&mut files,
			&settings,
			output,
			&mut tmp_dir,
			crate::host::Host::for_test("sort", "", "/").0.stderr_clone(),
		)
		.expect("ext_sort succeeds");

		let sorted = std::fs::read_to_string(&out_path).expect("read output");
		let expected: String = (0..200u32).map(|i| format!("{i:04}\n")).collect();
		assert_eq!(sorted, expected);
	}
}

}
#[cfg(not(target_os = "wasi"))]
pub use threaded::ext_sort;

#[cfg(target_os = "wasi")]
mod wasi {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! WASI single-threaded sort: read all input into memory, sort, and output.
//! Threads are not available on WASI, so we bypass the chunked/threaded path.

use std::{cmp::Ordering, io::Read};

use itertools::Itertools;

use super::super::{
	GlobalSettings, Output, SortError, SortResult,
	chunks::{self, Chunk},
	compare_by, print_sorted, sort_by,
	tmp_dir::TmpDirWrapper,
};

/// Sort files by reading all input into memory, sorting in a single thread, and
/// outputting directly.
pub fn ext_sort(
	files: &mut impl Iterator<Item = SortResult<Box<dyn Read + Send>>>,
	settings: &GlobalSettings,
	output: Output,
	_tmp_dir: &mut TmpDirWrapper,
) -> SortResult<()> {
	let separator = settings.line_ending.into();
	// Read all input into memory at once. Unlike the threaded path which uses
	// chunked buffered reads, WASI has no threads so we accept the memory cost.
	// Note: there is no size limit here — WASI targets are expected to handle
	// moderately sized inputs; very large files may cause OOM.
	let mut input = Vec::new();
	for file in files {
		file?.read_to_end(&mut input)?;
	}
	if input.is_empty() {
		return Ok(());
	}
	let mut chunk = Chunk::try_new(input, |buffer| {
		Ok::<_, SortError>(chunks::parse_into_chunk(buffer, separator, settings))
	})?;
	chunk.with_dependent_mut(|_, contents| {
		sort_by(&mut contents.lines, settings, &contents.line_data);
	});
	if settings.unique {
		print_sorted(
			chunk.lines().iter().dedup_by(|a, b| {
				compare_by(a, b, settings, chunk.line_data(), chunk.line_data()) == Ordering::Equal
			}),
			settings,
			output,
		)?;
	} else {
		print_sorted(chunk.lines().iter(), settings, output)?;
	}
	Ok(())
}

}
#[cfg(target_os = "wasi")]
// `self::` needed to disambiguate from the `wasi` crate
pub use self::wasi::ext_sort;

}
mod merge {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
//! Merge already sorted files.
//!
//! We achieve performance by splitting the tasks of sorting and writing, and
//! reading and parsing between two threads. The threads communicate over
//! channels. There's one channel per file in the direction reader -> sorter,
//! but only one channel from the sorter back to the reader. The channels to the
//! sorter are used to send the read chunks. The sorter reads the next chunk
//! from the channel whenever it needs the next chunk after running out of lines
//! from the previous read of the file. The channel back from the sorter to the
//! reader has two purposes: To allow the reader to reuse memory allocations and
//! to tell the reader which file to read from next.

use std::{
	cmp::Ordering,
	ffi::{OsStr, OsString},
	fs::{self, File},
	io::{BufWriter, Read, Write},
	iter,
	path::{Path, PathBuf},
	process::{Child, ChildStdin, ChildStdout, Stdio},
	rc::Rc,
	thread::{self, JoinHandle},
};

use compare::Compare;
use flume::{Receiver, Sender};

use super::{
	AtomicOrdering, Compressor, GlobalSettings, Output, SortError, SortResult,
	chunks::{self, Chunk, RecycledChunk},
	compare_by, current_open_fd_count, fd_soft_limit, open,
	tmp_dir::TmpDirWrapper,
};

/// If the output file occurs in the input files as well, copy the contents of
/// the output file and replace its occurrences in the inputs with that copy.
fn replace_output_file_in_input_files(
	files: &mut [OsString],
	output: Option<&OsStr>,
	tmp_dir: &mut TmpDirWrapper,
) -> SortResult<()> {
	let mut copy: Option<PathBuf> = None;
	if let Some(Ok(output_path)) = output.map(|path| Path::new(path).canonicalize()) {
		for file in files {
			if let Ok(file_path) = Path::new(file.as_os_str()).canonicalize()
				&& file_path == output_path
			{
				if let Some(copy) = &copy {
					*file = copy.clone().into_os_string();
				} else {
					let (_file, copy_path) = tmp_dir.next_file()?;
					fs::copy(file_path, &copy_path)
						.map_err(|error| SortError::OpenTmpFileFailed { error })?;
					*file = copy_path.clone().into_os_string();
					copy = Some(copy_path);
				}
			}
		}
	}
	Ok(())
}

/// Determine the effective merge batch size, enforcing a minimum and respecting
/// the file-descriptor soft limit after reserving stdio/output and a safety
/// margin.
fn effective_merge_batch_size(settings: &GlobalSettings) -> usize {
	const MIN_BATCH_SIZE: usize = 2;
	const RESERVED_TMP_OUTPUT: usize = 1;
	const RESERVED_CTRL_C: usize = 2;
	const RESERVED_RANDOM_SOURCE: usize = 1;
	const SAFETY_MARGIN: usize = 1;
	let mut batch_size = settings.merge_batch_size.max(MIN_BATCH_SIZE);

	if let Some(limit) = fd_soft_limit() {
		let open_fds = current_open_fd_count().unwrap_or(3);
		let mut reserved = RESERVED_TMP_OUTPUT + RESERVED_CTRL_C + SAFETY_MARGIN;
		if settings.salt.is_some() {
			reserved = reserved.saturating_add(RESERVED_RANDOM_SOURCE);
		}
		let available_inputs = limit.saturating_sub(open_fds.saturating_add(reserved));
		if available_inputs >= MIN_BATCH_SIZE {
			batch_size = batch_size.min(available_inputs);
		} else {
			batch_size = MIN_BATCH_SIZE;
		}
	}

	batch_size
}

/// Merge pre-sorted `Box<dyn Read>`s.
///
/// If `settings.merge_batch_size` is greater than the length of `files`,
/// intermediate files will be used. If `settings.compress` is `Some`,
/// intermediate files will be compressed with it.
pub fn merge(
	files: &mut [OsString],
	settings: &GlobalSettings,
	output: Output,
	tmp_dir: &mut TmpDirWrapper,
) -> SortResult<()> {
	replace_output_file_in_input_files(files, output.as_output_name(), tmp_dir)?;
	let files = files
		.iter()
		.map(|file| open(file).map(|file| PlainMergeInput { inner: file }));
	if settings.compress.is_none() {
		merge_with_file_limit::<_, _, WriteablePlainTmpFile>(files, settings, output, tmp_dir)
	} else {
		merge_with_file_limit::<_, _, WriteableCompressedTmpFile>(files, settings, output, tmp_dir)
	}
}

// Merge already sorted `MergeInput`s.
pub fn merge_with_file_limit<
	M: MergeInput + 'static,
	F: ExactSizeIterator<Item = SortResult<M>>,
	Tmp: WriteableTmpFile + 'static,
>(
	files: F,
	settings: &GlobalSettings,
	output: Output,
	tmp_dir: &mut TmpDirWrapper,
) -> SortResult<()> {
	let batch_size = effective_merge_batch_size(settings);
	debug_assert!(batch_size >= 2);

	if files.len() <= batch_size {
		let merger = merge_without_limit(files, settings);
		merger?.write_all(settings, output)
	} else {
		let mut temporary_files = vec![];
		let mut batch = Vec::with_capacity(batch_size);
		for file in files {
			batch.push(file);
			if batch.len() >= batch_size {
				assert_eq!(batch.len(), batch_size);
				let merger = merge_without_limit(batch.into_iter(), settings)?;
				batch = Vec::with_capacity(batch_size);

				let mut tmp_file =
					Tmp::create(tmp_dir.next_file()?, settings.compress.as_ref())?;
				merger.write_all_to(settings, tmp_file.as_write())?;
				temporary_files.push(tmp_file.finished_writing()?);
			}
		}
		// Merge any remaining files that didn't get merged in a full batch above.
		if !batch.is_empty() {
			assert!(batch.len() < batch_size);
			let merger = merge_without_limit(batch.into_iter(), settings)?;

			let mut tmp_file = Tmp::create(tmp_dir.next_file()?, settings.compress.as_ref())?;
			merger.write_all_to(settings, tmp_file.as_write())?;
			temporary_files.push(tmp_file.finished_writing()?);
		}
		merge_with_file_limit::<_, _, Tmp>(
			temporary_files
				.into_iter()
				.map(Box::new(|c: Tmp::Closed| c.reopen())
					as Box<dyn FnMut(Tmp::Closed) -> SortResult<<Tmp::Closed as ClosedTmpFile>::Reopened>>),
			settings,
			output,
			tmp_dir,
		)
	}
}

/// Merge files without limiting how many files are concurrently open.
///
/// It is the responsibility of the caller to ensure that `files` yields only
/// as many files as we are allowed to open concurrently.
fn merge_without_limit<M: MergeInput + 'static, F: Iterator<Item = SortResult<M>>>(
	files: F,
	settings: &GlobalSettings,
) -> SortResult<FileMerger<'_>> {
	let (request_sender, request_receiver) = flume::unbounded();
	let mut reader_files = Vec::with_capacity(files.size_hint().0);
	let mut loaded_receivers = Vec::with_capacity(files.size_hint().0);
	for (file_number, file) in files.enumerate() {
		let (sender, receiver) = flume::bounded(2);
		loaded_receivers.push(receiver);
		reader_files.push(Some(ReaderFile { file: file?, sender, carry_over: vec![] }));
		// Send the initial chunk to trigger a read for each file
		request_sender
			.send((file_number, RecycledChunk::new(8 * 1024)))
			.unwrap();
	}

	// Send the second chunk for each file
	for file_number in 0..reader_files.len() {
		request_sender
			.send((file_number, RecycledChunk::new(8 * 1024)))
			.unwrap();
	}

	let reader_join_handle = thread::spawn({
		let settings = settings.clone();
		move || reader(&request_receiver, &mut reader_files, &settings, settings.line_ending.into())
	});

	let mut mergeable_files = vec![];

	for (file_number, receiver) in loaded_receivers.into_iter().enumerate() {
		if let Ok(chunk) = receiver.recv() {
			mergeable_files.push(MergeableFile {
				current_chunk: Rc::new(chunk),
				file_number,
				line_idx: 0,
				receiver,
			});
		}
	}

	Ok(FileMerger {
		heap: binary_heap_plus::BinaryHeap::from_vec_cmp(mergeable_files, FileComparator {
			settings,
		}),
		request_sender,
		prev: None,
		reader_join_handle,
	})
}
/// The struct on the reader thread representing an input file
struct ReaderFile<M: MergeInput> {
	file:       M,
	sender:     Sender<Chunk>,
	carry_over: Vec<u8>,
}

/// The function running on the reader thread.
fn reader(
	recycled_receiver: &Receiver<(usize, RecycledChunk)>,
	files: &mut [Option<ReaderFile<impl MergeInput>>],
	settings: &GlobalSettings,
	separator: u8,
) -> SortResult<()> {
	while let Ok((file_idx, recycled_chunk)) = recycled_receiver.recv() {
		if settings.cancel.load(AtomicOrdering::Relaxed) {
			break;
		}
		if let Some(ReaderFile { file, sender, carry_over }) = &mut files[file_idx] {
			let should_continue = chunks::read(
				sender,
				recycled_chunk,
				None,
				carry_over,
				file.as_read(),
				&mut iter::empty(),
				separator,
				settings,
			)?;
			if !should_continue {
				// Remove the file from the list by replacing it with `None`.
				let ReaderFile { file, .. } = files[file_idx].take().unwrap();
				// Depending on the kind of the `MergeInput`, this may delete the file:
				file.finished_reading()?;
			}
		}
	}
	Ok(())
}
/// The struct on the main thread representing an input file
pub struct MergeableFile {
	current_chunk: Rc<Chunk>,
	line_idx:      usize,
	receiver:      Receiver<Chunk>,
	file_number:   usize,
}

/// A struct to keep track of the previous line we encountered.
///
/// This is required for deduplication purposes.
struct PreviousLine {
	chunk:       Rc<Chunk>,
	line_idx:    usize,
	file_number: usize,
}

/// Merges files together. This is **not** an iterator because of lifetime
/// problems.
struct FileMerger<'a> {
	heap:               binary_heap_plus::BinaryHeap<MergeableFile, FileComparator<'a>>,
	request_sender:     Sender<(usize, RecycledChunk)>,
	prev:               Option<PreviousLine>,
	reader_join_handle: JoinHandle<SortResult<()>>,
}

impl FileMerger<'_> {
	/// Write the merged contents to the output file.
	fn write_all(self, settings: &GlobalSettings, output: Output) -> SortResult<()> {
		let mut out = output.into_write();
		self.write_all_to(settings, &mut out)
	}

	fn write_all_to(mut self, settings: &GlobalSettings, out: &mut impl Write) -> SortResult<()> {
		while self
			.write_next(settings, out)
			.map_err(|error| SortError::WriteFailed {
				path: OsString::from("standard output"),
				error,
			})?
		{}
		drop(self.request_sender);
		self.reader_join_handle.join().unwrap()
	}

	fn write_next(
		&mut self,
		settings: &GlobalSettings,
		out: &mut impl Write,
	) -> std::io::Result<bool> {
		if let Some(file) = self.heap.peek() {
			let prev = self.prev.replace(PreviousLine {
				chunk:       file.current_chunk.clone(),
				line_idx:    file.line_idx,
				file_number: file.file_number,
			});

			file.current_chunk.with_dependent(|_, contents| {
				let current_line = &contents.lines[file.line_idx];
				if settings.unique
					&& let Some(prev) = &prev
				{
					let cmp = compare_by(
						&prev.chunk.lines()[prev.line_idx],
						current_line,
						settings,
						prev.chunk.line_data(),
						file.current_chunk.line_data(),
					);
					if cmp == Ordering::Equal {
						return Ok(());
					}
				}
				current_line.print(out, settings)
			})?;

			let was_last_line_for_file = file.current_chunk.lines().len() == file.line_idx + 1;

			if was_last_line_for_file {
				if let Ok(next_chunk) = file.receiver.recv() {
					let mut file = self.heap.peek_mut().unwrap();
					file.current_chunk = Rc::new(next_chunk);
					file.line_idx = 0;
				} else {
					self.heap.pop();
				}
			} else {
				// This will cause the comparison to use a different line and the heap to
				// readjust.
				self.heap.peek_mut().unwrap().line_idx += 1;
			}

			if let Some(prev) = prev
				&& let Ok(prev_chunk) = Rc::try_unwrap(prev.chunk)
			{
				// If nothing is referencing the previous chunk anymore, this means that the
				// previous line was the last line of the chunk. We can recycle the chunk.
				self
					.request_sender
					.send((prev.file_number, prev_chunk.recycle()))
					.ok();
			}
		}
		Ok(!self.heap.is_empty())
	}
}

/// Compares files by their current line.
struct FileComparator<'a> {
	settings: &'a GlobalSettings,
}

impl Compare<MergeableFile> for FileComparator<'_> {
	fn compare(&self, a: &MergeableFile, b: &MergeableFile) -> Ordering {
		let mut cmp = compare_by(
			&a.current_chunk.lines()[a.line_idx],
			&b.current_chunk.lines()[b.line_idx],
			self.settings,
			a.current_chunk.line_data(),
			b.current_chunk.line_data(),
		);
		if cmp == Ordering::Equal {
			// To make sorting stable, we need to consider the file number as well,
			// as lines from a file with a lower number are to be considered "earlier".
			cmp = a.file_number.cmp(&b.file_number);
		}
		// BinaryHeap is a max heap. We use it as a min heap, so we need to reverse the
		// ordering.
		cmp.reverse()
	}
}

/// Wait for the child to exit and check its exit code.
fn check_child_success(mut child: Child, program: &str) -> SortResult<()> {
	if matches!(child.wait().map(|e| e.code()), Ok(Some(0) | None) | Err(_)) {
		Ok(())
	} else {
		Err(SortError::CompressProgTerminatedAbnormally { prog: program.to_owned() }.into())
	}
}

/// A temporary file that can be written to.
pub trait WriteableTmpFile: Sized {
	type Closed: ClosedTmpFile;
	type InnerWrite: Write;
	fn create(file: (File, PathBuf), compress: Option<&Compressor>) -> SortResult<Self>;
	/// Closes the temporary file.
	fn finished_writing(self) -> SortResult<Self::Closed>;
	fn as_write(&mut self) -> &mut Self::InnerWrite;
}
/// A temporary file that is (temporarily) closed, but can be reopened.
pub trait ClosedTmpFile {
	type Reopened: MergeInput;
	/// Reopens the temporary file.
	fn reopen(self) -> SortResult<Self::Reopened>;
}
/// A pre-sorted input for merging.
pub trait MergeInput: Send {
	type InnerRead: Read;
	/// Cleans this `MergeInput` up.
	/// Implementations may delete the backing file.
	fn finished_reading(self) -> SortResult<()>;
	fn as_read(&mut self) -> &mut Self::InnerRead;
}

pub struct WriteablePlainTmpFile {
	path: PathBuf,
	file: BufWriter<File>,
}
pub struct ClosedPlainTmpFile {
	path: PathBuf,
}
pub struct PlainTmpMergeInput {
	path: PathBuf,
	file: File,
}
impl WriteableTmpFile for WriteablePlainTmpFile {
	type Closed = ClosedPlainTmpFile;
	type InnerWrite = BufWriter<File>;

	fn create((file, path): (File, PathBuf), _: Option<&Compressor>) -> SortResult<Self> {
		Ok(Self { file: BufWriter::new(file), path })
	}

	fn finished_writing(self) -> SortResult<Self::Closed> {
		Ok(ClosedPlainTmpFile { path: self.path })
	}

	fn as_write(&mut self) -> &mut Self::InnerWrite {
		&mut self.file
	}
}
impl ClosedTmpFile for ClosedPlainTmpFile {
	type Reopened = PlainTmpMergeInput;

	fn reopen(self) -> SortResult<Self::Reopened> {
		Ok(PlainTmpMergeInput {
			file: File::open(&self.path).map_err(|error| SortError::OpenTmpFileFailed { error })?,
			path: self.path,
		})
	}
}
impl MergeInput for PlainTmpMergeInput {
	type InnerRead = File;

	fn finished_reading(self) -> SortResult<()> {
		// we ignore failures to delete the temporary file,
		// because there is a race at the end of the execution and the whole
		// temporary directory might already be gone.
		let _ = fs::remove_file(self.path);
		Ok(())
	}

	fn as_read(&mut self) -> &mut Self::InnerRead {
		&mut self.file
	}
}

pub struct WriteableCompressedTmpFile {
	path:        PathBuf,
	compress:    Compressor,
	child:       Child,
	child_stdin: BufWriter<ChildStdin>,
	/// Drains the compressor's stderr onto the command's; joined once the child
	/// has exited so its diagnostics land before we report a result.
	forwarder:   thread::JoinHandle<()>,
}
pub struct ClosedCompressedTmpFile {
	path:     PathBuf,
	compress: Compressor,
}
pub struct CompressedTmpMergeInput {
	path:         PathBuf,
	compress:     Compressor,
	child:        Child,
	child_stdout: ChildStdout,
	forwarder:    thread::JoinHandle<()>,
}
impl WriteableTmpFile for WriteableCompressedTmpFile {
	type Closed = ClosedCompressedTmpFile;
	type InnerWrite = BufWriter<ChildStdin>;

	fn create((file, path): (File, PathBuf), compress: Option<&Compressor>) -> SortResult<Self> {
		let compress = compress
			.expect("WriteableCompressedTmpFile is only selected when a compressor is configured")
			.clone();
		let (mut child, forwarder) = compress.spawn(Stdio::piped(), file, false)?;
		let child_stdin = child.stdin.take().expect("compressor stdin is piped");
		Ok(Self {
			path,
			compress,
			child,
			child_stdin: BufWriter::new(child_stdin),
			forwarder,
		})
	}

	fn finished_writing(self) -> SortResult<Self::Closed> {
		drop(self.child_stdin);
		let result = check_child_success(self.child, &self.compress.prog);
		let _ = self.forwarder.join();
		result?;
		Ok(ClosedCompressedTmpFile { path: self.path, compress: self.compress })
	}

	fn as_write(&mut self) -> &mut Self::InnerWrite {
		&mut self.child_stdin
	}
}
impl ClosedTmpFile for ClosedCompressedTmpFile {
	type Reopened = CompressedTmpMergeInput;

	fn reopen(self) -> SortResult<Self::Reopened> {
		// mirroring what is done for ClosedPlainTmpFile
		let file = File::open(&self.path).map_err(|error| SortError::OpenTmpFileFailed { error })?;
		let (mut child, forwarder) = self.compress.spawn(file, Stdio::piped(), true)?;
		let child_stdout = child.stdout.take().expect("compressor stdout is piped");
		Ok(CompressedTmpMergeInput {
			path: self.path,
			compress: self.compress,
			child,
			child_stdout,
			forwarder,
		})
	}
}
impl MergeInput for CompressedTmpMergeInput {
	type InnerRead = ChildStdout;

	fn finished_reading(self) -> SortResult<()> {
		// Explicitly close stdout before waiting on the child process.
		#[allow(clippy::drop_non_drop)]
		drop(self.child_stdout);
		let result = check_child_success(self.child, &self.compress.prog);
		let _ = self.forwarder.join();
		result?;
		let _ = fs::remove_file(self.path);
		Ok(())
	}

	fn as_read(&mut self) -> &mut Self::InnerRead {
		&mut self.child_stdout
	}
}

pub struct PlainMergeInput<R: Read + Send> {
	inner: R,
}
impl<R: Read + Send> MergeInput for PlainMergeInput<R> {
	type InnerRead = R;

	fn finished_reading(self) -> SortResult<()> {
		Ok(())
	}

	fn as_read(&mut self) -> &mut Self::InnerRead {
		&mut self.inner
	}
}

}
mod numeric_str_cmp {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Fast comparison for strings representing a base 10 number without precision
//! loss.
//!
//! To be able to short-circuit when comparing, [`NumInfo`] must be passed along
//! with each number to [`numeric_str_cmp`]. [`NumInfo`] is generally obtained
//! by calling [`NumInfo::parse`] and should be cached. It is allowed to
//! arbitrarily modify the exponent afterward, which is equivalent to shifting
//! the decimal point.
//!
//! More specifically, exponent can be understood so that the original number is
//! in `(1..10)*10^exponent`. From that follows the constraints of this
//! algorithm: It is able to compare numbers in
//! ±(1*10^[`i64::MIN`]..10*10^[`i64::MAX`]).

use std::{cmp::Ordering, ops::Range};

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Clone)]
enum Sign {
	Negative,
	Positive,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct NumInfo {
	exponent: i64,
	sign:     Sign,
}
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct NumInfoParseSettings {
	pub accept_si_units:     bool,
	pub thousands_separator: Option<u8>,
	pub decimal_pt:          Option<u8>,
}

impl Default for NumInfoParseSettings {
	fn default() -> Self {
		Self {
			accept_si_units:     false,
			thousands_separator: None,
			decimal_pt:          Some(b'.'),
		}
	}
}

impl NumInfo {
	/// Parse [`NumInfo`] for this number.
	/// Also returns the range of num that should be passed to
	/// [`numeric_str_cmp`] later.
	///
	/// Leading zeros will be excluded from the returned range. If the number
	/// consists of only zeros, an empty range (idx..idx) is returned so that
	/// idx is the char after the last zero. If the input is not a number (which
	/// has to be treated as zero), the returned empty range will be 0..0.
	#[allow(clippy::cognitive_complexity)]
	pub fn parse(num: &[u8], parse_settings: &NumInfoParseSettings) -> (Self, Range<usize>) {
		let mut exponent = -1;
		let mut had_decimal_pt = false;
		let mut had_digit = false;
		let mut start = None;
		let mut sign = Sign::Positive;

		let mut first_char = true;

		for (idx, &char) in num.iter().enumerate() {
			if first_char && char.is_ascii_whitespace() {
				continue;
			}

			if first_char && char == b'-' {
				sign = Sign::Negative;
				first_char = false;
				continue;
			}
			first_char = false;

			if matches!(
				 parse_settings.thousands_separator,
				 Some(c) if c == char
			) {
				continue;
			}

			if Self::is_invalid_char(char, &mut had_decimal_pt, parse_settings) {
				return if let Some(start) = start {
					let has_si_unit = parse_settings.accept_si_units
						&& matches!(
							char,
							b'K' | b'k' | b'M' | b'G' | b'T' | b'P' | b'E' | b'Z' | b'Y' | b'R' | b'Q'
						);
					(Self { exponent, sign }, start..if has_si_unit { idx + 1 } else { idx })
				} else {
					(
						Self { sign: Sign::Positive, exponent: 0 },
						if had_digit {
							// In this case there were only zeroes.
							// For debug output to work properly, we have to match the character after the
							// last zero.
							idx..idx
						} else {
							// This was no number at all.
							// For debug output to work properly, we have to match 0..0.
							0..0
						},
					)
				};
			}
			if Some(char) == parse_settings.decimal_pt {
				continue;
			}
			had_digit = true;
			if start.is_none() && char == b'0' {
				if had_decimal_pt {
					// We're parsing a number whose first nonzero digit is after the decimal point.
					exponent -= 1;
				} else {
					// Skip leading zeroes
					continue;
				}
			}
			if !had_decimal_pt {
				exponent += 1;
			}
			if start.is_none() && char != b'0' {
				start = Some(idx);
			}
		}
		if let Some(start) = start {
			(Self { exponent, sign }, start..num.len())
		} else {
			(
				Self { sign: Sign::Positive, exponent: 0 },
				if had_digit {
					// In this case there were only zeroes.
					// For debug output to work properly, we have to claim to match the end of the
					// number.
					num.len()..num.len()
				} else {
					// This was no number at all.
					// For debug output to work properly, we have to claim to match the start of the
					// number.
					0..0
				},
			)
		}
	}

	fn is_invalid_char(
		c: u8,
		had_decimal_pt: &mut bool,
		parse_settings: &NumInfoParseSettings,
	) -> bool {
		if Some(c) == parse_settings.decimal_pt {
			if *had_decimal_pt {
				// this is a decimal pt but we already had one, so it is invalid
				true
			} else {
				*had_decimal_pt = true;
				false
			}
		} else {
			!c.is_ascii_digit()
		}
	}
}

fn get_unit(unit: Option<u8>) -> u8 {
	if let Some(unit) = unit {
		match unit {
			b'K' | b'k' => 1,
			b'M' => 2,
			b'G' => 3,
			b'T' => 4,
			b'P' => 5,
			b'E' => 6,
			b'Z' => 7,
			b'Y' => 8,
			b'R' => 9,
			b'Q' => 10,
			_ => 0,
		}
	} else {
		0
	}
}

/// Compare two numbers according to the rules of human numeric comparison.
/// The SI-Unit takes precedence over the actual value (i.e. 2000M < 1G).
pub fn human_numeric_str_cmp(
	(a, a_info): (&[u8], &NumInfo),
	(b, b_info): (&[u8], &NumInfo),
) -> Ordering {
	// 1. Sign
	if a_info.sign != b_info.sign {
		return a_info.sign.cmp(&b_info.sign);
	}
	// 2. Unit
	let a_unit = get_unit(a.iter().next_back().copied());
	let b_unit = get_unit(b.iter().next_back().copied());
	let ordering = a_unit.cmp(&b_unit);
	if ordering == Ordering::Equal {
		// 3. Number
		numeric_str_cmp((a, a_info), (b, b_info))
	} else if a_info.sign == Sign::Negative {
		ordering.reverse()
	} else {
		ordering
	}
}

/// Compare two numbers as strings without parsing them as a number first. This
/// should be more performant and can handle numbers more precisely. [`NumInfo`]
/// is needed to provide a fast path for most numbers.
#[inline(always)]
pub fn numeric_str_cmp((a, a_info): (&[u8], &NumInfo), (b, b_info): (&[u8], &NumInfo)) -> Ordering {
	// check for a difference in the sign
	if a_info.sign != b_info.sign {
		return a_info.sign.cmp(&b_info.sign);
	}

	// check for a difference in the exponent
	let ordering = if a_info.exponent != b_info.exponent && !a.is_empty() && !b.is_empty() {
		a_info.exponent.cmp(&b_info.exponent)
	} else {
		// walk the characters from the front until we find a difference
		let mut a_chars = a.iter().copied().filter(u8::is_ascii_digit);
		let mut b_chars = b.iter().copied().filter(u8::is_ascii_digit);
		loop {
			let a_next = a_chars.next();
			let b_next = b_chars.next();
			match (a_next, b_next) {
				(None, None) => break Ordering::Equal,
				(Some(c), None) => {
					break if c == b'0' && a_chars.all(|c| c == b'0') {
						Ordering::Equal
					} else {
						Ordering::Greater
					};
				},
				(None, Some(c)) => {
					break if c == b'0' && b_chars.all(|c| c == b'0') {
						Ordering::Equal
					} else {
						Ordering::Less
					};
				},
				(Some(a_char), Some(b_char)) => {
					let ord = a_char.cmp(&b_char);
					if ord != Ordering::Equal {
						break ord;
					}
				},
			}
		}
	};

	if a_info.sign == Sign::Negative {
		ordering.reverse()
	} else {
		ordering
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_exp() {
		let n = b"1";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Positive }, 0..1)
		);
		let n = b"100";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 2, sign: Sign::Positive }, 0..3)
		);
		let n = b"1,000";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings {
				thousands_separator: Some(b','),
				..Default::default()
			}),
			(NumInfo { exponent: 3, sign: Sign::Positive }, 0..5)
		);
		let n = b"1,000";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Positive }, 0..1)
		);
		let n = b"1000.00";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 3, sign: Sign::Positive }, 0..7)
		);
	}
	#[test]
	fn parses_negative_exp() {
		let n = b"0.00005";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: -5, sign: Sign::Positive }, 6..7)
		);
		let n = b"00000.00005";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: -5, sign: Sign::Positive }, 10..11)
		);
	}

	#[test]
	fn parses_sign() {
		let n = b"5";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Positive }, 0..1)
		);
		let n = b"-5";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Negative }, 1..2)
		);
		let n = b"    -5";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Negative }, 5..6)
		);
	}

	fn test_helper(a: &[u8], b: &[u8], expected: Ordering) {
		let (a_info, a_range) = NumInfo::parse(a, &NumInfoParseSettings::default());
		let (b_info, b_range) = NumInfo::parse(b, &NumInfoParseSettings::default());
		let ordering =
			numeric_str_cmp((&a[a_range.clone()], &a_info), (&b[b_range.clone()], &b_info));
		assert_eq!(ordering, expected);
		let ordering = numeric_str_cmp((&b[b_range], &b_info), (&a[a_range], &a_info));
		assert_eq!(ordering, expected.reverse());
	}
	#[test]
	fn test_single_digit() {
		test_helper(b"1", b"2", Ordering::Less);
		test_helper(b"0", b"0", Ordering::Equal);
	}
	#[test]
	fn test_minus() {
		test_helper(b"-1", b"-2", Ordering::Greater);
		test_helper(b"-0", b"-0", Ordering::Equal);
	}
	#[test]
	fn test_different_len() {
		test_helper(b"-20", b"-100", Ordering::Greater);
		test_helper(b"10.0", b"2.000000", Ordering::Greater);
	}
	#[test]
	fn test_decimal_digits() {
		test_helper(b"20.1", b"20.2", Ordering::Less);
		test_helper(b"20.1", b"20.15", Ordering::Less);
		test_helper(b"-20.1", b"+20.15", Ordering::Less);
		test_helper(b"-20.1", b"-20", Ordering::Less);
	}
	#[test]
	fn test_trailing_zeroes() {
		test_helper(b"20.00000", b"20.1", Ordering::Less);
		test_helper(b"20.00000", b"20.0", Ordering::Equal);
	}
	#[test]
	fn test_invalid_digits() {
		test_helper(b"foo", b"bar", Ordering::Equal);
		test_helper(b"20.1", b"a", Ordering::Greater);
		test_helper(b"-20.1", b"a", Ordering::Less);
		test_helper(b"a", b"0.15", Ordering::Less);
	}
	#[test]
	fn test_multiple_decimal_pts() {
		test_helper(b"10.0.0", b"50.0.0", Ordering::Less);
		test_helper(b"0.1.", b"0.2.0", Ordering::Less);
		test_helper(b"1.1.", b"0", Ordering::Greater);
		test_helper(b"1.1.", b"-0", Ordering::Greater);
	}
	#[test]
	fn test_leading_decimal_pts() {
		test_helper(b".0", b".0", Ordering::Equal);
		test_helper(b".1", b".0", Ordering::Greater);
		test_helper(b".02", b"0", Ordering::Greater);
	}
	#[test]
	fn test_leading_zeroes() {
		test_helper(b"000000.0", b".0", Ordering::Equal);
		test_helper(b"0.1", b"0000000000000.0", Ordering::Greater);
		test_helper(b"-01", b"-2", Ordering::Greater);
	}

	#[test]
	fn minus_zero() {
		// This matches GNU sort behavior.
		test_helper(b"-0", b"0", Ordering::Equal);
		test_helper(b"-0x", b"0", Ordering::Equal);
	}
	#[test]
	fn double_minus() {
		test_helper(b"--1", b"0", Ordering::Equal);
	}
	#[test]
	fn single_minus() {
		let info = NumInfo::parse(b"-", &NumInfoParseSettings::default());
		assert_eq!(info, (NumInfo { exponent: 0, sign: Sign::Positive }, 0..0));
	}
	#[test]
	fn invalid_with_unit() {
		let info = NumInfo::parse(b"-K", &NumInfoParseSettings {
			accept_si_units: true,
			..Default::default()
		});
		assert_eq!(info, (NumInfo { exponent: 0, sign: Sign::Positive }, 0..0));
	}
}

}
mod tmp_dir {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{fs::File, path::PathBuf};

use tempfile::TempDir;

use super::{SortError, SortResult};

/// A wrapper around [`TempDir`] that handles the allocation of new temporary
/// files in the temporary directory.
///
/// The directory is only created once the first file is requested. Cleanup
/// happens automatically when the [`TempDir`] is dropped.
///
/// The host owns signal handling; `TempDir` cleanup remains scoped to this
/// invocation through its `Drop` implementation.
pub struct TmpDirWrapper {
	temp_dir:    Option<TempDir>,
	parent_path: PathBuf,
	size:        usize,
}

impl TmpDirWrapper {
	pub fn new(path: PathBuf) -> Self {
		Self { parent_path: path, size: 0, temp_dir: None }
	}

	fn init_tmp_dir(&mut self) -> SortResult<()> {
		assert!(self.temp_dir.is_none());
		assert_eq!(self.size, 0);
		self.temp_dir = Some(
			tempfile::Builder::new()
				.prefix("uutils_sort")
				.tempdir_in(&self.parent_path)
				.map_err(|_| SortError::TmpFileCreationFailed { path: self.parent_path.clone() })?,
		);
		Ok(())
	}

	pub fn next_file(&mut self) -> SortResult<(File, PathBuf)> {
		if self.temp_dir.is_none() {
			self.init_tmp_dir()?;
		}

		let file_name = self.size.to_string();
		self.size += 1;
		let path = self.temp_dir.as_ref().unwrap().path().join(file_name);
		Ok((File::create(&path).map_err(|error| SortError::OpenTmpFileFailed { error })?, path))
	}
}

}

#[cfg(not(target_os = "wasi"))]
use std::num::NonZero;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::{
	cmp::Ordering,
	ffi::{OsStr, OsString},
	fs::{File, OpenOptions},
	hash::{Hash, Hasher},
	io::{BufRead, BufReader, BufWriter, Read, Write},
	num::IntErrorKind,
	ops::Range,
	path::{Path, PathBuf},
	sync::{Arc, OnceLock, atomic::{AtomicBool, Ordering as AtomicOrdering}},
};

use bigdecimal::BigDecimal;
use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use chunks::LineData;
use clap::{Arg, ArgAction, ArgMatches, Command, CommandFactory, FromArgMatches, builder::ValueParser};
use custom_str_cmp::custom_str_cmp;
use ext_sort::ext_sort;
use foldhash::{HashMap, SharedSeed, fast::FoldHasher};
use numeric_str_cmp::{NumInfo, NumInfoParseSettings, human_numeric_str_cmp, numeric_str_cmp};
use rand::{RngExt as _, rng};
#[cfg(not(target_os = "wasi"))]
use rayon::slice::ParallelSliceMut;
use thiserror::Error;
use uucore::i18n::collator::{compute_sort_key_utf8, locale_cmp};
use uucore::{
	display::Quotable,
	extendedbigdecimal::ExtendedBigDecimal,
	i18n,
	i18n::{datetime::get_locale_months, decimal::locale_decimal_separator},
	line_ending::LineEnding,
	parser::{
		num_parser::{ExtendedParser, ExtendedParserError},
		parse_size::{ParseSizeError, Parser},
		shortcut_value_parser::ShortcutValueParser,
	},
	posix::{MODERN, TRADITIONAL},
	version_cmp::version_cmp,
};

use crate::{
	host::{Host, Utility, format_usage, rayon_global_pool_available, util},
	sort::{buffer_hint::automatic_buffer_size, tmp_dir::TmpDirWrapper},
};

type SortResult<T> = Result<T, SortError>;

fn strip_errno(error: &std::io::Error) -> String {
	error
		.raw_os_error()
		.map_or_else(|| error.to_string(), |code| std::io::Error::from_raw_os_error(code).to_string())
}

macro_rules! show_error {
	($stderr:expr, $($args:tt)+) => {{
		let _ = writeln!($stderr, "sort: {}", format_args!($($args)+));
	}};
}

// English argument and help text from the upstream locale resources.
const SORT_ABOUT: &str = "Display sorted concatenation of all FILE(s). With no FILE, or when FILE \
                          is -, read standard input.";
const SORT_USAGE: &str = "sort [OPTION]... [FILE]...";
const SORT_AFTER_HELP: &str =
	"The key format is FIELD[.CHAR][OPTIONS][,FIELD[.CHAR]][OPTIONS].\n\nFields by default are \
	 separated by the first whitespace after a non-whitespace character. Use -t to specify a \
	 custom separator.\nIn the default case, whitespace is appended at the beginning of each \
	 field. Custom separators however are not included in fields.\n\nFIELD and CHAR both start at \
	 1 (i.e. they are 1-indexed). If there is no end specified after a comma, the end will be the \
	 end of the line.\nIf CHAR is set 0, it means the end of the field. CHAR defaults to 1 for the \
	 start position and to 0 for the end position.\n\nValid options are: MbdfhnRrV. They override \
	 the global options for this key.";

// Map the formerly localized field-spec parse message keys to their English
// text.
fn field_spec_msg(key: &str) -> &'static str {
	match key {
		"sort-invalid-number-at-field-start" => "invalid number at field start",
		"sort-invalid-number-after-dash" => "invalid number after '-'",
		"sort-invalid-number-after-dot" => "invalid number after '.'",
		"sort-invalid-number-after-comma" => "invalid number after ','",
		"sort-field-number-is-zero" => "field number is zero",
		"sort-character-offset-is-zero" => "character offset is zero",
		"sort-stray-character-field-spec" => "stray character in field spec",
		_ => "invalid field specification",
	}
}

fn materialize_stdin(
	host: &mut Host,
	files: &mut [OsString],
	tmp_dir: &mut TmpDirWrapper,
) -> SortResult<()> {
	let mut stdin = Some(&mut host.stdin);
	for file in files.iter_mut().filter(|file| file.as_os_str() == OsStr::new(STDIN_FILE)) {
		let (mut temp, path) = tmp_dir.next_file()?;
		if let Some(reader) = stdin.take() {
			std::io::copy(reader, &mut temp)
				.map_err(|error| SortError::ReadFailed { path: PathBuf::from(STDIN_FILE), error })?;
		}
		*file = path.into_os_string();
	}
	Ok(())
}

mod options {
	pub mod modes {
		pub const SORT: &str = "sort";

		pub const HUMAN_NUMERIC: &str = "human-numeric-sort";
		pub const MONTH: &str = "month-sort";
		pub const NUMERIC: &str = "numeric-sort";
		pub const GENERAL_NUMERIC: &str = "general-numeric-sort";
		pub const VERSION: &str = "version-sort";
		pub const RANDOM: &str = "random-sort";
	}

	pub mod check {
		pub const CHECK: &str = "check";
		pub const CHECK_SILENT: &str = "check-silent";
		pub const SILENT: &str = "silent";
		pub const QUIET: &str = "quiet";
		pub const DIAGNOSE_FIRST: &str = "diagnose-first";
	}

	pub const HELP: &str = "help";
	pub const VERSION: &str = "version";
	pub const DICTIONARY_ORDER: &str = "dictionary-order";
	pub const MERGE: &str = "merge";
	pub const DEBUG: &str = "debug";
	pub const IGNORE_CASE: &str = "ignore-case";
	pub const IGNORE_LEADING_BLANKS: &str = "ignore-leading-blanks";
	pub const IGNORE_NONPRINTING: &str = "ignore-nonprinting";
	pub const OUTPUT: &str = "output";
	pub const REVERSE: &str = "reverse";
	pub const STABLE: &str = "stable";
	pub const UNIQUE: &str = "unique";
	pub const KEY: &str = "key";
	pub const SEPARATOR: &str = "field-separator";
	pub const ZERO_TERMINATED: &str = "zero-terminated";
	pub const PARALLEL: &str = "parallel";
	pub const FILES0_FROM: &str = "files0-from";
	pub const BUF_SIZE: &str = "buffer-size";
	pub const TMP_DIR: &str = "temporary-directory";
	pub const COMPRESS_PROG: &str = "compress-program";
	pub const BATCH_SIZE: &str = "batch-size";
	pub const RANDOM_SOURCE: &str = "random-source";

	pub const FILES: &str = "files";
}

const DECIMAL_PT: u8 = b'.';

fn locale_decimal_pt() -> u8 {
	match locale_decimal_separator().as_bytes().first().copied() {
		Some(b'.') => b'.',
		Some(b',') => b',',
		_ => DECIMAL_PT,
	}
}

const NEGATIVE: &u8 = &b'-';
const POSITIVE: &u8 = &b'+';

// The automatic buffer heuristics clamp to this range to avoid
// over-committing memory on constrained systems while still keeping
// reasonably large chunks for typical workloads.
const MIN_AUTOMATIC_BUF_SIZE: usize = 512 * 1024; // 512 KiB
const FALLBACK_AUTOMATIC_BUF_SIZE: usize = 32 * 1024 * 1024; // 32 MiB
const MAX_AUTOMATIC_BUF_SIZE: usize = 1024 * 1024 * 1024; // 1 GiB

#[derive(Debug, Error)]
pub enum SortError {
	#[error("{0}")]
	Message(String),

	#[error("write failed: {}: {}", .path.maybe_quote(), strip_errno(.error))]
	WriteFailed { path: OsString, error: std::io::Error },

	#[error("{}", format_disorder(.file, .line_number, .line, .silent))]
	Disorder { file: OsString, line_number: usize, line: String, silent: bool },

	#[error("open failed: {}: {}", .path.maybe_quote(), strip_errno(.error))]
	OpenFailed { path: PathBuf, error: std::io::Error },

	#[error("cannot read: {}: {}", .path.maybe_quote(), strip_errno(.error))]
	ReadFailed { path: PathBuf, error: std::io::Error },

	#[error("failed to open temporary file: {}", strip_errno(.error))]
	OpenTmpFileFailed { error: std::io::Error },

	#[error("could not run compress program '{}': {}", .prog, strip_errno(.error))]
	CompressProgExecutionFailed { prog: String, error: std::io::Error },

	#[error("{} terminated abnormally", .prog.quote())]
	CompressProgTerminatedAbnormally { prog: String },

	#[error("cannot create temporary file in {}:", .path.quote())]
	TmpFileCreationFailed { path: PathBuf },

	#[error("extra operand {}\nfile operands cannot be combined with --files0-from\nTry 'sort --help' for more information.", .file.quote())]
	FileOperandsCombined { file: PathBuf },


	#[error("multiple output files specified")]
	MultipleOutputFiles,

	#[error("when reading file names from standard input, no file name of '-' allowed")]
	MinusInStdIn,

	#[error("no input from {}", .file.quote())]
	EmptyInputFile { file: PathBuf },

	#[error("{}:{}: invalid zero-length file name", .file.maybe_quote(), .line_num)]
	ZeroLengthFileName { file: PathBuf, line_num: usize },
}

impl SortError {
	fn message(message: impl Into<String>) -> Self {
		Self::Message(message.into())
	}

	fn code(&self) -> i32 {
		if matches!(self, Self::Disorder { .. }) { 1 } else { 2 }
	}
}

// refs are required because this fn is used by thiserror macro
#[expect(clippy::trivially_copy_pass_by_ref)]
fn format_disorder(file: &OsString, line_number: &usize, line: &String, silent: &bool) -> String {
	if *silent {
		String::new()
	} else {
		format!("{}:{}: disorder: {}", file.maybe_quote(), line_number, line)
	}
}

#[derive(Eq, Ord, PartialEq, PartialOrd, Clone, Copy, Debug)]
enum SortMode {
	Numeric,
	HumanNumeric,
	GeneralNumeric,
	Month,
	Version,
	Random,
	Default,
}

/// Return the length of the byte slice while ignoring embedded NULs (used for
/// debug underline alignment).
fn count_non_null_bytes(bytes: &[u8]) -> usize {
	bytes.iter().filter(|&&c| c != b'\0').count()
}

pub struct Output {
	file:   Option<(OsString, File)>,
	stdout: Option<OpenFile>,
}

impl Output {
	fn new(name: Option<impl AsRef<OsStr>>, stdout: Option<OpenFile>) -> SortResult<Self> {
		let file = if let Some(name) = name {
			let path = Path::new(name.as_ref());
			// This is different from `File::create()` because we don't truncate the output
			// yet. This allows using the output file as an input file.
			let file = OpenOptions::new()
				.write(true)
				.create(true)
				.open(path)
				.map_err(|error| SortError::OpenFailed { path: path.to_owned(), error })?;
			Some((name.as_ref().to_owned(), file))
		} else {
			None
		};
		Ok(Self { file, stdout })
	}

	fn into_write(mut self) -> BufWriter<Box<dyn Write>> {
		BufWriter::new(match self.file {
			Some((_name, file)) => {
				// truncate the file
				let _ = file.set_len(0);
				Box::new(file)
			},
			None => Box::new(self.stdout.take().expect("stdout is present")),
		})
	}

	fn as_output_name(&self) -> Option<&OsStr> {
		match &self.file {
			Some((name, _file)) => Some(name.as_os_str()),
			None => None,
		}
	}
}

#[derive(Clone)]
pub struct GlobalSettings {
	mode:                    SortMode,
	debug:                   bool,
	ignore_leading_blanks:   bool,
	ignore_case:             bool,
	dictionary_order:        bool,
	ignore_non_printing:     bool,
	merge:                   bool,
	reverse:                 bool,
	stable:                  bool,
	unique:                  bool,
	check:                   bool,
	check_silent:            bool,
	salt:                    Option<[u8; 16]>,
	random_source:           Option<PathBuf>,
	selectors:               Vec<FieldSelector>,
	separator:               Option<u8>,
	threads:                 String,
	line_ending:             LineEnding,
	buffer_size:             usize,
	buffer_size_is_explicit: bool,
	/// `--compress-program`: the program plus the shell context its children
	/// must inherit (working directory, exported environment, stderr).
	compress:                Option<Compressor>,
	merge_batch_size:        usize,
	numeric_locale:          NumericLocaleSettings,
	precomputed:             Precomputed,
	cancel:                  Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug)]
struct NumericLocaleSettings {
	thousands_sep: Option<u8>,
	decimal_pt:    Option<u8>,
}

impl Default for NumericLocaleSettings {
	fn default() -> Self {
		Self { thousands_sep: None, decimal_pt: Some(DECIMAL_PT) }
	}
}

impl NumericLocaleSettings {
	fn num_info_settings(self, accept_si_units: bool) -> NumInfoParseSettings {
		NumInfoParseSettings {
			accept_si_units,
			thousands_separator: self.thousands_sep,
			decimal_pt: self.decimal_pt,
		}
	}
}

/// Data needed for sorting. Should be computed once before starting to sort
/// by calling `GlobalSettings::init_precomputed`.
#[derive(Clone, Debug, Default)]
struct Precomputed {
	needs_tokens:                    bool,
	num_infos_per_line:              usize,
	floats_per_line:                 usize,
	selections_per_line:             usize,
	fast_lexicographic:              bool,
	fast_locale_collation:           bool,
	fast_ascii_insensitive:          bool,
	tokenize_blank_thousands_sep:    bool,
	tokenize_allow_unit_after_blank: bool,
}

impl GlobalSettings {
	/// Parse a SIZE string into a number of bytes.
	/// A size string comprises an integer and an optional unit.
	/// The unit may be k, K, m, M, g, G, t, T, P, E, Z, Y (powers of 1024), or b
	/// which is 1. Default is K.
	fn parse_byte_count(input: &str) -> Result<usize, ParseSizeError> {
		// GNU sort (8.32)   valid: 1b,        k, K, m, M, g, G, t, T, P, E, Z, Y
		// GNU sort (8.32) invalid:  b, B, 1B,                         p, e, z, y
		let size = Parser::default()
			.with_allow_list(&[
				"b", "k", "K", "m", "M", "g", "G", "t", "T", "P", "E", "Z", "Y", "R", "Q", "%",
			])
			.with_default_unit("K")
			.with_b_byte_count(true)
			.parse(input.trim())?;

		usize::try_from(size).map_err(|_| {
			ParseSizeError::SizeTooBig(format!("Buffer size {size} does not fit in address space"))
		})
	}

	/// Precompute some data needed for sorting.
	/// This function **must** be called before starting to sort, and
	/// `GlobalSettings` may not be altered afterwards.
	///
	/// When i18n-collator is enabled, `disable_fast_lexicographic` should be set
	/// to true if we're in a UTF-8 locale (to force locale-aware collation
	/// instead of byte comparison).
	fn init_precomputed(&mut self, disable_fast_lexicographic: bool) {
		self.precomputed.needs_tokens = self.selectors.iter().any(|s| s.needs_tokens);
		self.precomputed.selections_per_line =
			self.selectors.iter().filter(|s| s.needs_selection).count();
		self.precomputed.num_infos_per_line = self
			.selectors
			.iter()
			.filter(|s| matches!(s.settings.mode, SortMode::Numeric | SortMode::HumanNumeric))
			.count();
		self.precomputed.floats_per_line = self
			.selectors
			.iter()
			.filter(|s| matches!(s.settings.mode, SortMode::GeneralNumeric))
			.count();

		let uses_numeric = self
			.selectors
			.iter()
			.any(|s| matches!(s.settings.mode, SortMode::Numeric | SortMode::HumanNumeric));
		let uses_human_numeric = self
			.selectors
			.iter()
			.any(|s| matches!(s.settings.mode, SortMode::HumanNumeric));
		self.precomputed.tokenize_blank_thousands_sep = self.separator.is_none()
			&& uses_numeric
			&& self.numeric_locale.thousands_sep == Some(b' ');
		self.precomputed.tokenize_allow_unit_after_blank =
			self.precomputed.tokenize_blank_thousands_sep && uses_human_numeric;

		self.precomputed.fast_lexicographic =
			!disable_fast_lexicographic && self.can_use_fast_lexicographic();
		self.precomputed.fast_locale_collation =
			disable_fast_lexicographic && self.can_use_fast_lexicographic();
		self.precomputed.fast_ascii_insensitive = self.can_use_fast_ascii_insensitive();
	}

	/// Returns true when the fast lexicographic path can be used safely.
	/// Note: When i18n-collator is enabled, the caller must have already
	/// determined whether locale-aware collation is needed (via checking if
	/// we're in a UTF-8 locale). This check is performed in uumain() before
	/// init_precomputed() is called.
	fn can_use_fast_lexicographic(&self) -> bool {
		self.mode == SortMode::Default
			&& !self.ignore_case
			&& !self.dictionary_order
			&& !self.ignore_non_printing
			&& !self.ignore_leading_blanks
			&& self.selectors.len() == 1
			&& {
				let selector = &self.selectors[0];
				!selector.needs_selection
					&& matches!(selector.settings.mode, SortMode::Default)
					&& !selector.settings.ignore_case
					&& !selector.settings.dictionary_order
					&& !selector.settings.ignore_non_printing
					&& !selector.settings.ignore_blanks
			}
	}

	/// Returns true when the ASCII case-insensitive fast path is valid.
	fn can_use_fast_ascii_insensitive(&self) -> bool {
		self.mode == SortMode::Default
			&& self.ignore_case
			&& !self.dictionary_order
			&& !self.ignore_non_printing
			&& !self.ignore_leading_blanks
			&& self.selectors.len() == 1
			&& {
				let selector = &self.selectors[0];
				!selector.needs_selection
					&& matches!(selector.settings.mode, SortMode::Default)
					&& selector.settings.ignore_case
					&& !selector.settings.dictionary_order
					&& !selector.settings.ignore_non_printing
					&& !selector.settings.ignore_blanks
			}
	}
}

impl Default for GlobalSettings {
	fn default() -> Self {
		Self {
			mode:                    SortMode::Default,
			debug:                   false,
			ignore_leading_blanks:   false,
			ignore_case:             false,
			dictionary_order:        false,
			ignore_non_printing:     false,
			merge:                   false,
			reverse:                 false,
			stable:                  false,
			unique:                  false,
			check:                   false,
			check_silent:            false,
			salt:                    None,
			random_source:           None,
			selectors:               vec![],
			separator:               None,
			threads:                 String::new(),
			line_ending:             LineEnding::Newline,
			buffer_size:             FALLBACK_AUTOMATIC_BUF_SIZE,
			buffer_size_is_explicit: false,
			compress:                None,
			merge_batch_size:        default_merge_batch_size(),
			numeric_locale:          NumericLocaleSettings::default(),
			cancel:                  Arc::new(AtomicBool::new(false)),
			precomputed:             Precomputed::default(),
		}
	}
}

#[derive(Clone, PartialEq, Debug)]
struct KeySettings {
	mode:                SortMode,
	ignore_blanks:       bool,
	ignore_case:         bool,
	dictionary_order:    bool,
	ignore_non_printing: bool,
	reverse:             bool,
}

impl From<&GlobalSettings> for KeySettings {
	fn from(settings: &GlobalSettings) -> Self {
		Self {
			mode:                settings.mode,
			ignore_blanks:       settings.ignore_leading_blanks,
			ignore_case:         settings.ignore_case,
			ignore_non_printing: settings.ignore_non_printing,
			reverse:             settings.reverse,
			dictionary_order:    settings.dictionary_order,
		}
	}
}

impl Default for KeySettings {
	fn default() -> Self {
		Self::from(&GlobalSettings::default())
	}
}

#[derive(Clone, Copy, Debug, Default)]
struct ModeFlags {
	numeric:         bool,
	general_numeric: bool,
	human_numeric:   bool,
	month:           bool,
	version:         bool,
	random:          bool,
}

impl ModeFlags {
	fn from_mode(mode: SortMode) -> Self {
		let mut flags = Self::default();
		match mode {
			SortMode::Numeric => flags.numeric = true,
			SortMode::GeneralNumeric => flags.general_numeric = true,
			SortMode::HumanNumeric => flags.human_numeric = true,
			SortMode::Month => flags.month = true,
			SortMode::Version => flags.version = true,
			SortMode::Random => flags.random = true,
			SortMode::Default => {},
		}
		flags
	}

	fn to_mode(self) -> SortMode {
		if self.numeric {
			SortMode::Numeric
		} else if self.general_numeric {
			SortMode::GeneralNumeric
		} else if self.human_numeric {
			SortMode::HumanNumeric
		} else if self.month {
			SortMode::Month
		} else if self.random {
			SortMode::Random
		} else if self.version {
			SortMode::Version
		} else {
			SortMode::Default
		}
	}
}

fn ordering_opts_string(
	flags: ModeFlags,
	dictionary_order: bool,
	ignore_non_printing: bool,
	ignore_case: bool,
) -> String {
	let mut opts = String::new();
	if dictionary_order {
		opts.push('d');
	}
	if ignore_case {
		opts.push('f');
	}
	if flags.general_numeric {
		opts.push('g');
	}
	if flags.human_numeric {
		opts.push('h');
	}
	if !dictionary_order && ignore_non_printing {
		opts.push('i');
	}
	if flags.month {
		opts.push('M');
	}
	if flags.numeric {
		opts.push('n');
	}
	if flags.random {
		opts.push('R');
	}
	if flags.version {
		opts.push('V');
	}
	opts
}

fn ordering_incompatible(
	flags: ModeFlags,
	dictionary_order: bool,
	ignore_non_printing: bool,
) -> bool {
	let mode_count = u8::from(flags.numeric)
		+ u8::from(flags.general_numeric)
		+ u8::from(flags.human_numeric)
		+ u8::from(flags.month);

	// Multiple numeric/month modes are incompatible
	if mode_count > 1 {
		return true;
	}

	// A numeric/month mode combined with
	// version/random/dictionary/ignore_non_printing is incompatible
	if mode_count == 1 {
		return flags.version || flags.random || dictionary_order || ignore_non_printing;
	}

	false
}

fn incompatible_options_error(opts: &str) -> SortError {
	SortError::message(format!("options '-{opts}' are incompatible"))
}
enum Selection<'a> {
	AsBigDecimal(GeneralBigDecimalParseResult),
	WithNumInfo(&'a [u8], NumInfo),
	Str(&'a [u8]),
}

type Field = Range<usize>;

#[derive(Clone, Debug)]
pub struct Line<'a> {
	line:  &'a [u8],
	index: usize,
}

impl<'a> Line<'a> {
	/// Creates a new `Line`.
	///
	/// If additional data is needed for sorting it is added to `line_data`.
	/// `token_buffer` allows to reuse the allocation for tokens.
	fn create(
		line: &'a [u8],
		index: usize,
		line_data: &mut LineData<'a>,
		token_buffer: &mut Vec<Field>,
		settings: &GlobalSettings,
	) -> Self {
				if settings.precomputed.fast_locale_collation {
			compute_sort_key_utf8(line, &mut line_data.collation_key_buffer);
			line_data
				.collation_key_ends
				.push(line_data.collation_key_buffer.len());
			return Self { line, index };
		}

		let needs_line_data = settings.precomputed.needs_tokens
			|| settings.precomputed.selections_per_line > 0
			|| settings.precomputed.num_infos_per_line > 0
			|| settings.precomputed.floats_per_line > 0
			|| settings.mode == SortMode::Numeric;
		if !needs_line_data {
			return Self { line, index };
		}
		token_buffer.clear();
		if settings.precomputed.needs_tokens {
			tokenize(line, settings.separator, token_buffer, &settings.precomputed);
		}
		if settings.mode == SortMode::Numeric {
			// exclude inf, nan, scientific notation
			let line_num_float = (!line.iter().any(u8::is_ascii_alphabetic))
				.then(|| std::str::from_utf8(line).ok())
				.flatten()
				.and_then(|s| s.parse::<f64>().ok());
			line_data.line_num_floats.push(line_num_float);
		}
		for (selector, selection) in settings.selectors.iter().map(|selector| {
			(selector, selector.get_selection(line, token_buffer, settings.numeric_locale))
		}) {
			match selection {
				Selection::AsBigDecimal(parsed_float) => line_data.parsed_floats.push(parsed_float),
				Selection::WithNumInfo(str, num_info) => {
					line_data.num_infos.push(num_info);
					line_data.selections.push(str);
				},
				Selection::Str(str) => {
					if selector.needs_selection {
						line_data.selections.push(str);
					}
				},
			}
		}
		Self { line, index }
	}

	fn print(&self, writer: &mut impl Write, settings: &GlobalSettings) -> std::io::Result<()> {
		if settings.debug {
			self.write_debug(settings, writer)?;
		} else {
			writer.write_all(self.line)?;
			writer.write_all(&[settings.line_ending.into()])?;
		}
		Ok(())
	}

	/// Writes indicators for the selections this line matched. The original line
	/// content is NOT expected to be already printed.
	fn write_debug(
		&self,
		settings: &GlobalSettings,
		writer: &mut impl Write,
	) -> std::io::Result<()> {
		// We do not consider this function performance critical, as debug output is
		// only useful for small files, which are not a performance problem in any
		// case. Therefore there aren't any special performance optimizations here.

		let line = self
			.line
			.iter()
			.copied()
			.map(|c| if c == b'\t' { b'>' } else { c })
			.collect::<Vec<_>>();

		writer.write_all(&line)?;
		writeln!(writer)?;

		let mut fields = vec![];
		tokenize(self.line, settings.separator, &mut fields, &settings.precomputed);
		for selector in &settings.selectors {
			let mut selection = selector.get_range(self.line, Some(&fields));
			match selector.settings.mode {
				SortMode::Numeric | SortMode::HumanNumeric => {
					// find out which range is used for numeric comparisons
					let mut parse_settings = settings
						.numeric_locale
						.num_info_settings(selector.settings.mode == SortMode::HumanNumeric);
					// Debug annotations should ignore thousands separators to match GNU output.
					parse_settings.thousands_separator = None;
					let (_, num_range) = NumInfo::parse(&self.line[selection.clone()], &parse_settings);
					let initial_selection = selection.clone();

					// Shorten selection to num_range.
					selection.start += num_range.start;
					selection.end = selection.start + num_range.len();

					if num_range == (0..0) {
						// This was not a valid number.
						// Report no match at the first non-whitespace character.
						let leading_whitespace = self.line[selection.clone()]
							.iter()
							.position(|c| !c.is_ascii_whitespace())
							.unwrap_or(0);
						selection.start += leading_whitespace;
						selection.end += leading_whitespace;
					} else {
						// include a trailing si unit
						if selector.settings.mode == SortMode::HumanNumeric
							&& let Some(
								b'k' | b'K' | b'M' | b'G' | b'T' | b'P' | b'E' | b'Z' | b'Y' | b'R' | b'Q',
							) = self.line[selection.end..initial_selection.end].first()
						{
							selection.end += 1;
						}

						// include leading zeroes, a leading minus or a leading decimal point
						while let Some(b'-' | b'0' | b'.') =
							self.line[initial_selection.start..selection.start].last()
						{
							selection.start -= 1;
						}
					}
				},
				SortMode::GeneralNumeric => {
					let initial_selection = &self.line[selection.clone()];
					let decimal_pt = locale_decimal_pt();
					let leading = get_leading_gen(initial_selection, decimal_pt);

					// Shorten selection to leading.
					selection.start += leading.start;
					selection.end = selection.start + leading.len();
				},
				SortMode::Month => {
					let initial_selection = &self.line[selection.clone()];
					let first_non_blank = initial_selection
						.iter()
						.position(|c| !c.is_ascii_whitespace())
						.unwrap_or(initial_selection.len());

					let (parsed, match_len) = month_parse(initial_selection);

					if parsed == Month::Unknown {
						// We failed to parse a month, which is equivalent to matching nothing.
						// Add the "no match for key" marker to the first non-whitespace character.
						selection.start += first_non_blank;
						selection.end = selection.start;
					} else {
						// We parsed a month. Use the actual match byte length.
						selection.start += first_non_blank;
						selection.end = selection.start + match_len;
					}
				},
				_ => {},
			}

			// Don't let embedded NUL bytes influence column alignment in the
			// debug underline output, since they are often filtered out (e.g.
			// via `tr -d '\0'`) before inspection.
			let select = &line[..selection.start];
			let indent = count_non_null_bytes(select);
			write!(writer, "{}", " ".repeat(indent))?;

			if selection.is_empty() {
				writeln!(writer, "^ no match for key")?;
			} else {
				let select = &line[selection];
				let underline_len = count_non_null_bytes(select);
				writeln!(writer, "{}", "_".repeat(underline_len))?;
			}
		}

		if settings.mode != SortMode::Random
			&& !settings.stable
			&& !settings.unique
			&& (settings.dictionary_order
				|| settings.ignore_leading_blanks
				|| settings.ignore_case
				|| settings.ignore_non_printing
				|| settings.mode != SortMode::Default
				|| settings
					.selectors
					.last()
					.is_none_or(|selector| selector != &FieldSelector::default()))
		{
			// A last resort comparator is in use, underline the whole line.
			if self.line.is_empty() {
				writeln!(writer, "^ no match for key")?;
			} else {
				writeln!(writer, "{}", "_".repeat(self.line.len()))?;
			}
		}
		Ok(())
	}
}

/// Tokenize a line into fields. The result is stored into `token_buffer`.
fn tokenize(
	line: &[u8],
	separator: Option<u8>,
	token_buffer: &mut Vec<Field>,
	precomputed: &Precomputed,
) {
	assert!(token_buffer.is_empty());
	if let Some(separator) = separator {
		tokenize_with_separator(line, separator, token_buffer);
	} else {
		tokenize_default(
			line,
			token_buffer,
			precomputed.tokenize_blank_thousands_sep,
			precomputed.tokenize_allow_unit_after_blank,
		);
	}
}

/// By default fields are separated by the first whitespace after
/// non-whitespace. Whitespace is included in fields at the start.
/// The result is stored into `token_buffer`.
fn tokenize_default(
	line: &[u8],
	token_buffer: &mut Vec<Field>,
	blank_thousands_sep: bool,
	allow_unit_after_blank: bool,
) {
	token_buffer.push(0..0);
	// pretend that there was whitespace in front of the line
	let mut previous_was_whitespace = true;
	for (idx, char) in line.iter().enumerate() {
		let is_whitespace = char.is_ascii_whitespace();
		let treat_as_separator = if is_whitespace {
			if blank_thousands_sep && *char == b' ' {
				!is_blank_thousands_sep(line, idx, allow_unit_after_blank)
			} else {
				true
			}
		} else {
			false
		};

		if treat_as_separator {
			if !previous_was_whitespace {
				token_buffer.last_mut().unwrap().end = idx;
				token_buffer.push(idx..0);
			}
			previous_was_whitespace = true;
		} else {
			previous_was_whitespace = false;
		}
	}
	token_buffer.last_mut().unwrap().end = line.len();
}

fn is_blank_thousands_sep(line: &[u8], idx: usize, allow_unit_after_blank: bool) -> bool {
	if line.get(idx) != Some(&b' ') {
		return false;
	}

	let prev_is_digit = idx
		.checked_sub(1)
		.and_then(|prev_idx| line.get(prev_idx))
		.is_some_and(u8::is_ascii_digit);
	if !prev_is_digit {
		return false;
	}

	let next = line.get(idx + 1).copied();
	match next {
		Some(c) if c.is_ascii_digit() => true,
		Some(b'K' | b'k' | b'M' | b'G' | b'T' | b'P' | b'E' | b'Z' | b'Y' | b'R' | b'Q')
			if allow_unit_after_blank =>
		{
			true
		},
		_ => false,
	}
}

/// Split between separators. These separators are not included in fields.
/// The result is stored into `token_buffer`.
fn tokenize_with_separator(line: &[u8], separator: u8, token_buffer: &mut Vec<Field>) {
	let separator_indices = line
		.iter()
		.enumerate()
		.filter_map(|(i, &c)| if c == separator { Some(i) } else { None });
	let mut start = 0;
	for sep_idx in separator_indices {
		token_buffer.push(start..sep_idx);
		start = sep_idx + 1;
	}
	if start < line.len() {
		token_buffer.push(start..line.len());
	}
}

#[derive(Clone, PartialEq, Debug)]
struct KeyPosition {
	/// 1-indexed, 0 is invalid.
	field:         usize,
	/// 1-indexed, 0 is end of field.
	char:          usize,
	ignore_blanks: bool,
}

impl Default for KeyPosition {
	fn default() -> Self {
		Self { field: 1, char: 1, ignore_blanks: false }
	}
}

fn bad_field_spec(spec: &str, msg_key: &str) -> SortError {
	SortError::message(format!(
		"{}: invalid field specification {}",
		field_spec_msg(msg_key),
		spec.quote()
	))
}

fn invalid_count_error(msg_key: &str, input: &str) -> SortError {
	SortError::message(format!(
		"{}: invalid count at start of {}",
		field_spec_msg(msg_key),
		input.quote()
	))
}

fn parse_field_count<'a>(input: &'a str, msg_key: &str) -> SortResult<(usize, &'a str)> {
	let bytes = input.as_bytes();
	let mut idx = 0;
	while idx < bytes.len() && bytes[idx].is_ascii_digit() {
		idx += 1;
	}
	if idx == 0 {
		return Err(invalid_count_error(msg_key, input));
	}
	let (num_str, rest) = input.split_at(idx);
	let value = match num_str.parse::<usize>() {
		Ok(v) => v,
		Err(e) if *e.kind() == IntErrorKind::PosOverflow => usize::MAX,
		Err(_) => return Err(invalid_count_error(msg_key, input)),
	};
	Ok((value, rest))
}

fn is_ordering_option_char(byte: u8) -> bool {
	matches!(byte, b'b' | b'd' | b'f' | b'g' | b'h' | b'i' | b'M' | b'n' | b'R' | b'r' | b'V')
}

fn parse_ordering_options<'a>(
	input: &'a str,
	settings: &mut KeySettings,
	flags: &mut ModeFlags,
) -> (&'a str, bool) {
	let mut ignore_blanks = false;
	let bytes = input.as_bytes();
	let mut idx = 0;
	while idx < bytes.len() {
		match bytes[idx] {
			b'b' => ignore_blanks = true,
			b'd' => {
				settings.dictionary_order = true;
				settings.ignore_non_printing = false;
			},
			b'f' => settings.ignore_case = true,
			b'g' => flags.general_numeric = true,
			b'h' => flags.human_numeric = true,
			b'i' => {
				if !settings.dictionary_order {
					settings.ignore_non_printing = true;
				}
			},
			b'M' => flags.month = true,
			b'n' => flags.numeric = true,
			b'R' => flags.random = true,
			b'r' => settings.reverse = true,
			b'V' => flags.version = true,
			_ => break,
		}
		idx += 1;
	}
	(&input[idx..], ignore_blanks)
}

#[derive(Clone, PartialEq, Debug, Default)]
struct FieldSelector {
	from:            KeyPosition,
	to:              Option<KeyPosition>,
	settings:        KeySettings,
	needs_tokens:    bool,
	// Whether this selector operates on a sub-slice of a line.
	// Selections are therefore not needed when this selector matches the whole line
	// or the sort mode is general-numeric.
	needs_selection: bool,
}

impl FieldSelector {
	fn parse(key: &str, global_settings: &GlobalSettings) -> SortResult<Self> {
		let has_options = key.as_bytes().iter().copied().any(is_ordering_option_char);
		let mut settings = if has_options {
			KeySettings::default()
		} else {
			KeySettings::from(global_settings)
		};
		let mut flags = if has_options {
			ModeFlags::default()
		} else {
			ModeFlags::from_mode(settings.mode)
		};

		let mut from_ignore_blanks = if has_options {
			false
		} else {
			settings.ignore_blanks
		};
		let mut to_ignore_blanks = if has_options {
			false
		} else {
			settings.ignore_blanks
		};

		let (from_field, mut rest) = parse_field_count(key, "sort-invalid-number-at-field-start")?;
		if from_field == 0 {
			return Err(bad_field_spec(key, "sort-field-number-is-zero"));
		}

		let mut from_char = 1;
		if let Some(stripped) = rest.strip_prefix('.') {
			let (char_idx, rest_after) = parse_field_count(stripped, "sort-invalid-number-after-dot")?;
			if char_idx == 0 {
				return Err(bad_field_spec(key, "sort-character-offset-is-zero"));
			}
			from_char = char_idx;
			rest = rest_after;
		}

		let (rest_after_opts, ignore_blanks) =
			parse_ordering_options(rest, &mut settings, &mut flags);
		if ignore_blanks {
			from_ignore_blanks = true;
		}

		let mut to = None;
		if let Some(rest_after_comma) = rest_after_opts.strip_prefix(',') {
			let (to_field, mut rest) =
				parse_field_count(rest_after_comma, "sort-invalid-number-after-comma")?;
			if to_field == 0 {
				return Err(bad_field_spec(key, "sort-field-number-is-zero"));
			}

			let mut to_char = 0;
			if let Some(stripped) = rest.strip_prefix('.') {
				let (char_idx, rest_after) =
					parse_field_count(stripped, "sort-invalid-number-after-dot")?;
				to_char = char_idx;
				rest = rest_after;
			}

			let (rest, ignore_blanks_end) = parse_ordering_options(rest, &mut settings, &mut flags);
			if ignore_blanks_end {
				to_ignore_blanks = true;
			}
			if !rest.is_empty() {
				return Err(bad_field_spec(key, "sort-stray-character-field-spec"));
			}
			to = Some(KeyPosition {
				field:         to_field,
				char:          to_char,
				ignore_blanks: to_ignore_blanks,
			});
		} else if !rest_after_opts.is_empty() {
			return Err(bad_field_spec(key, "sort-stray-character-field-spec"));
		}

		if ordering_incompatible(flags, settings.dictionary_order, settings.ignore_non_printing) {
			let opts = ordering_opts_string(
				flags,
				settings.dictionary_order,
				settings.ignore_non_printing,
				settings.ignore_case,
			);
			return Err(incompatible_options_error(&opts));
		}

		settings.mode = flags.to_mode();

		let from = KeyPosition {
			field:         from_field,
			char:          from_char,
			ignore_blanks: from_ignore_blanks,
		};
		Self::new(from, to, settings).map_err(|msg| SortError::message(msg))
	}

	fn new(
		from: KeyPosition,
		to: Option<KeyPosition>,
		settings: KeySettings,
	) -> Result<Self, String> {
		if from.char == 0 {
			Err("invalid character index 0 for the start position of a field".to_string())
		} else {
			Ok(Self {
				needs_selection: (from.field != 1
					|| from.char != 1
					|| to.is_some()
					|| matches!(settings.mode, SortMode::Numeric | SortMode::HumanNumeric)
					|| from.ignore_blanks)
					&& !matches!(settings.mode, SortMode::GeneralNumeric),
				needs_tokens: from.field != 1 || from.char == 0 || to.is_some(),
				from,
				to,
				settings,
			})
		}
	}

	/// Get the selection that corresponds to this selector for the line.
	/// If `needs_fields` returned false, tokens may be empty.
	fn get_selection<'a>(
		&self,
		line: &'a [u8],
		tokens: &[Field],
		numeric_locale: NumericLocaleSettings,
	) -> Selection<'a> {
		// `get_range` expects `None` when we don't need tokens and would get confused
		// by an empty vector.
		let tokens = if self.needs_tokens {
			Some(tokens)
		} else {
			None
		};
		let mut range_str = &line[self.get_range(line, tokens)];
		if self.settings.mode == SortMode::Numeric || self.settings.mode == SortMode::HumanNumeric {
			// Parse NumInfo for this number.
			let (info, num_range) = NumInfo::parse(
				range_str,
				&numeric_locale.num_info_settings(self.settings.mode == SortMode::HumanNumeric),
			);
			// Shorten the range to what we need to pass to numeric_str_cmp later.
			range_str = &range_str[num_range];
			Selection::WithNumInfo(range_str, info)
		} else if self.settings.mode == SortMode::GeneralNumeric {
			// Parse this number as BigDecimal, as this is the requirement for general
			// numeric sorting.
			let decimal_pt = locale_decimal_pt();
			Selection::AsBigDecimal(general_bd_parse(
				&range_str[get_leading_gen(range_str, decimal_pt)],
				decimal_pt,
			))
		} else {
			// This is not a numeric sort, so we don't need a NumCache.
			Selection::Str(range_str)
		}
	}

	/// Look up the range in the line that corresponds to this selector.
	/// If `needs_fields` returned false, tokens must be None.
	fn get_range(&self, line: &[u8], tokens: Option<&[Field]>) -> Range<usize> {
		enum Resolution {
			// The start index of the resolved character, inclusive
			StartOfChar(usize),
			// The end index of the resolved character, exclusive.
			// This is only returned if the character index is 0.
			EndOfChar(usize),
			// The resolved character would be in front of the first character
			TooLow,
			// The resolved character would be after the last character
			TooHigh,
		}

		/// Get the index for this line given the [`KeyPosition`]
		fn resolve_index(
			line: &[u8],
			tokens: Option<&[Field]>,
			position: &KeyPosition,
		) -> Resolution {
			if matches!(tokens, Some(tokens) if tokens.len() < position.field) {
				Resolution::TooHigh
			} else if position.char == 0 {
				let end = tokens.unwrap()[position.field - 1].end;
				if end == 0 {
					Resolution::TooLow
				} else {
					Resolution::EndOfChar(end)
				}
			} else {
				let mut idx = if position.field == 1 {
					// The first field always starts at 0.
					// We don't need tokens for this case.
					0
				} else {
					tokens.unwrap()[position.field - 1].start
				};
				// strip blanks if needed
				if position.ignore_blanks {
					idx += line[idx..]
						.iter()
						.enumerate()
						.find(|(_, c)| !c.is_ascii_whitespace())
						.map_or(line[idx..].len(), |(idx, _)| idx);
				}
				// apply the character index
				idx += line[idx..]
					.iter()
					.enumerate()
					.nth(position.char - 1)
					.map_or(line[idx..].len(), |(idx, _)| idx);
				if idx >= line.len() {
					Resolution::TooHigh
				} else {
					Resolution::StartOfChar(idx)
				}
			}
		}

		match resolve_index(line, tokens, &self.from) {
			Resolution::StartOfChar(from) => {
				let to = self.to.as_ref().map(|to| resolve_index(line, tokens, to));

				let mut range = match to {
					Some(Resolution::StartOfChar(mut to)) => {
						// We need to include the character at `to`.
						to += 1;
						from..to
					},
					Some(Resolution::EndOfChar(to)) => from..to,
					// If `to` was not given or the match would be after the end of the line,
					// match everything until the end of the line.
					None | Some(Resolution::TooHigh) => from..line.len(),
					// If `to` is before the start of the line, report no match.
					// This can happen if the line starts with a separator.
					Some(Resolution::TooLow) => 0..0,
				};
				if range.start > range.end {
					range.end = range.start;
				}
				range
			},
			Resolution::TooLow | Resolution::EndOfChar(_) => {
				unreachable!(
					"This should only happen if the field start index is 0, but that should already \
					 have caused an error."
				)
			},
			// While for comparisons it's only important that this is an empty slice,
			// to produce accurate debug output we need to match an empty slice at the end of the line.
			Resolution::TooHigh => line.len()..line.len(),
		}
	}
}

fn detect_numeric_locale() -> NumericLocaleSettings {
	let numeric_locale = i18n::get_numeric_locale();
	let locale = &numeric_locale.0;
	let encoding = numeric_locale.1;
	let is_c_locale = encoding == i18n::UEncoding::Ascii && locale.to_string() == "und";

	if is_c_locale {
		return NumericLocaleSettings { decimal_pt: Some(DECIMAL_PT), thousands_sep: None };
	}

	let grouping = i18n::decimal::locale_grouping_separator();
	NumericLocaleSettings {
		decimal_pt:    Some(locale_decimal_pt()),
		// Upstream GNU coreutils ignore multibyte thousands separators
		// (FIXME in C source). We keep the same single-byte behavior.
		thousands_sep: match grouping.as_bytes() {
			[b] => Some(*b),
			// ICU returns NBSP as UTF-8 (0xC2 0xA0). In non-UTF8 locales like ISO-8859-1,
			// the input byte is 0xA0, so map it to a single-byte separator.
			[0xc2, 0xa0] if encoding != i18n::UEncoding::Utf8 => Some(0xa0),
			_ => None,
		},
	}
}
/// Creates an `Arg` for a sort mode flag.
fn make_sort_mode_arg(mode: &'static str, short: char, help: String) -> Arg {
	Arg::new(mode)
		.short(short)
		.long(mode)
		.help(help)
		.action(ArgAction::SetTrue)
}

#[cfg(all(
	unix,
	not(any(
		target_os = "redox",
		target_os = "fuchsia",
		target_os = "haiku",
		target_os = "solaris",
		target_os = "illumos"
	))
))]
fn get_rlimit() -> SortResult<usize> {
	use nix::sys::resource::{RLIM_INFINITY, Resource, getrlimit};

	let (rlim_cur, _rlim_max) = getrlimit(Resource::RLIMIT_NOFILE)
		.map_err(|_| SortError::message("Failed to fetch rlimit"))?;
	if rlim_cur == RLIM_INFINITY {
		return Err(SortError::message("Failed to fetch rlimit"));
	}
	usize::try_from(rlim_cur).map_err(|_| SortError::message("Failed to fetch rlimit"))
}

#[cfg(all(
	unix,
	not(any(
		target_os = "redox",
		target_os = "fuchsia",
		target_os = "haiku",
		target_os = "solaris",
		target_os = "illumos"
	))
))]
pub(crate) fn fd_soft_limit() -> Option<usize> {
	get_rlimit().ok()
}

#[cfg(any(
	not(unix),
	target_os = "redox",
	target_os = "fuchsia",
	target_os = "haiku",
	target_os = "solaris",
	target_os = "illumos"
))]
pub(crate) fn fd_soft_limit() -> Option<usize> {
	None
}

#[cfg(unix)]
pub(crate) fn current_open_fd_count() -> Option<usize> {
	use nix::libc;

	fn count_dir(path: &str) -> Option<usize> {
		let entries = std::fs::read_dir(path).ok()?;
		let mut count = 0usize;
		for entry in entries.flatten() {
			let name = entry.file_name();
			let name = name.to_string_lossy();
			if name.parse::<usize>().is_ok() {
				count = count.saturating_add(1);
			}
		}
		Some(count)
	}

	if let Some(count) = count_dir("/proc/self/fd").or_else(|| count_dir("/dev/fd")) {
		return Some(count);
	}

	let limit = fd_soft_limit()?;
	if limit > 16_384 {
		return None;
	}

	let mut count = 0usize;
	for fd in 0..limit {
		let fd = fd as libc::c_int;
		// Probe with libc::fcntl because the fd may be invalid.
		if unsafe { libc::fcntl(fd, libc::F_GETFD) } != -1 {
			count = count.saturating_add(1);
		}
	}
	Some(count)
}

#[cfg(not(unix))]
pub(crate) fn current_open_fd_count() -> Option<usize> {
	None
}

const STDIN_FILE: &str = "-";

/// Legacy `+POS1 [-POS2]` syntax is permitted unless `_POSIX2_VERSION` is in
/// the [TRADITIONAL, MODERN) range (matches GNU behaviour).
fn allows_traditional_usage() -> bool {
	!matches!(uucore::posix::posix_version(), Some(ver) if (TRADITIONAL..MODERN).contains(&ver))
}

#[derive(Debug, Clone)]
struct LegacyKeyPart {
	field:    usize,
	char_pos: usize,
	opts:     String,
}

#[derive(Debug, Clone)]
struct LegacyKeyWarning {
	arg_index:  usize,
	key_index:  Option<usize>,
	from_field: usize,
	to_field:   Option<usize>,
	to_char:    Option<usize>,
}

impl LegacyKeyWarning {
	fn legacy_key_display(&self) -> String {
		match self.to_field {
			Some(to) => format!("+{} -{to}", self.from_field),
			None => format!("+{}", self.from_field),
		}
	}

	fn replacement_key_display(&self) -> String {
		let start_field = self.from_field.saturating_add(1);
		match self.to_field {
			Some(to_field) => {
				let end_field = match self.to_char {
					Some(0) | None => to_field.max(1),
					Some(_) => to_field.saturating_add(1),
				};
				format!("{start_field},{end_field}")
			},
			None => start_field.to_string(),
		}
	}
}

#[derive(Default)]
struct GlobalOptionFlags {
	keys_specified:        bool,
	ignore_leading_blanks: bool,
	dictionary_order:      bool,
	ignore_case:           bool,
	ignore_non_printing:   bool,
	reverse:               bool,
	mode_numeric:          bool,
	mode_general:          bool,
	mode_human:            bool,
	mode_month:            bool,
	mode_random:           bool,
	mode_version:          bool,
}

impl GlobalOptionFlags {
	fn from_matches(matches: &ArgMatches) -> Self {
		let sort_value = matches
			.get_one::<String>(options::modes::SORT)
			.map(String::as_str);
		Self {
			keys_specified:        matches.contains_id(options::KEY),
			ignore_leading_blanks: matches.get_flag(options::IGNORE_LEADING_BLANKS),
			dictionary_order:      matches.get_flag(options::DICTIONARY_ORDER),
			ignore_case:           matches.get_flag(options::IGNORE_CASE),
			ignore_non_printing:   matches.get_flag(options::IGNORE_NONPRINTING),
			reverse:               matches.get_flag(options::REVERSE),
			mode_human:            matches.get_flag(options::modes::HUMAN_NUMERIC)
				|| sort_value == Some("human-numeric"),
			mode_month:            matches.get_flag(options::modes::MONTH)
				|| sort_value == Some("month"),
			mode_general:          matches.get_flag(options::modes::GENERAL_NUMERIC)
				|| sort_value == Some("general-numeric"),
			mode_numeric:          matches.get_flag(options::modes::NUMERIC)
				|| sort_value == Some("numeric"),
			mode_version:          matches.get_flag(options::modes::VERSION)
				|| sort_value == Some("version"),
			mode_random:           matches.get_flag(options::modes::RANDOM)
				|| sort_value == Some("random"),
		}
	}
}

fn parse_usize_or_max(num: &str) -> Option<usize> {
	match num.parse::<usize>() {
		Ok(v) => Some(v),
		Err(e) if *e.kind() == IntErrorKind::PosOverflow => Some(usize::MAX),
		Err(_) => None,
	}
}

fn parse_legacy_part(spec: &str) -> Option<LegacyKeyPart> {
	let idx = spec.chars().take_while(char::is_ascii_digit).count();
	if idx == 0 {
		return None;
	}

	let field = parse_usize_or_max(&spec[..idx])?;
	let mut char_pos = 0;
	let mut rest = &spec[idx..];

	if let Some(stripped) = rest.strip_prefix('.') {
		let char_idx = stripped.chars().take_while(char::is_ascii_digit).count();
		if char_idx == 0 {
			return None;
		}
		char_pos = parse_usize_or_max(&stripped[..char_idx])?;
		rest = &stripped[char_idx..];
	}

	Some(LegacyKeyPart { field, char_pos, opts: rest.to_string() })
}

/// Convert legacy +POS1 [-POS2] into a `-k` key specification using saturating
/// arithmetic.
fn legacy_key_to_k(from: &LegacyKeyPart, to: Option<&LegacyKeyPart>) -> String {
	let start_field = from.field.saturating_add(1);
	let start_char = from.char_pos.saturating_add(1);

	let mut keydef = format!(
		"{start_field}{}{}",
		if from.char_pos == 0 {
			String::new()
		} else {
			format!(".{start_char}")
		},
		from.opts,
	);

	if let Some(to) = to {
		let end_field = if to.char_pos == 0 {
			// When the end character index is zero, GNU keeps the field number as-is.
			// Clamp to 1 to avoid generating an invalid field 0.
			to.field.max(1)
		} else {
			to.field.saturating_add(1)
		};

		keydef.push(',');
		keydef.push_str(&end_field.to_string());
		if to.char_pos != 0 {
			keydef.push('.');
			keydef.push_str(&to.char_pos.to_string());
		}
		keydef.push_str(&to.opts);
	}

	keydef
}

/// Preprocess argv to handle legacy +POS1 [-POS2] syntax by converting it into
/// -k forms before clap sees the arguments.
fn preprocess_legacy_args<I>(args: I) -> (Vec<OsString>, Vec<LegacyKeyWarning>)
where
	I: IntoIterator,
	I::Item: Into<OsString>,
{
	if !allows_traditional_usage() {
		return (args.into_iter().map(Into::into).collect(), Vec::new());
	}

	let mut processed = Vec::new();
	let mut legacy_warnings = Vec::new();
	let mut iter = args.into_iter().map(Into::into).peekable();

	while let Some(arg) = iter.next() {
		if arg == "--" {
			processed.push(arg);
			processed.extend(iter);
			break;
		}

		if starts_with_plus(&arg) {
			let as_str = arg.to_string_lossy();
			if let Some(from_spec) = as_str.strip_prefix('+')
				&& let Some(from) = parse_legacy_part(from_spec)
			{
				let mut to_part = None;

				let next_candidate = iter.peek().map(|next| next.to_string_lossy().to_string());

				if let Some(next_str) = next_candidate
					&& let Some(stripped) = next_str.strip_prefix('-')
					&& stripped.starts_with(|c: char| c.is_ascii_digit())
				{
					let next_arg = iter.next().unwrap();
					if let Some(parsed) = parse_legacy_part(stripped) {
						to_part = Some(parsed);
					} else {
						processed.push(arg);
						processed.push(next_arg);
						continue;
					}
				}

				let keydef = legacy_key_to_k(&from, to_part.as_ref());
				let arg_index = processed.len();
				legacy_warnings.push(LegacyKeyWarning {
					arg_index,
					key_index: None,
					from_field: from.field,
					to_field: to_part.as_ref().map(|p| p.field),
					to_char: to_part.as_ref().map(|p| p.char_pos),
				});
				processed.push(OsString::from(format!("-k{keydef}")));
				continue;
			}
		}

		processed.push(arg);
	}

	(processed, legacy_warnings)
}

fn starts_with_plus(arg: &OsStr) -> bool {
	#[cfg(unix)]
	{
		arg.as_bytes().first() == Some(&b'+')
	}
	#[cfg(not(unix))]
	{
		arg.to_string_lossy().starts_with('+')
	}
}

fn index_legacy_warnings(processed_args: &[OsString], legacy_warnings: &mut [LegacyKeyWarning]) {
	if legacy_warnings.is_empty() {
		return;
	}

	let mut index_by_arg = HashMap::default();
	for (warning_idx, warning) in legacy_warnings.iter().enumerate() {
		index_by_arg.insert(warning.arg_index, warning_idx);
	}

	let mut key_index = 0usize;
	let mut i = 0usize;
	while i < processed_args.len() {
		let arg = &processed_args[i];
		if arg == OsStr::new("--") {
			break;
		}

		let mut matched_key = false;
		if arg == OsStr::new("-k") || arg == OsStr::new("--key") {
			if i + 1 < processed_args.len() {
				key_index = key_index.saturating_add(1);
				matched_key = true;
				i += 2;
			} else {
				i += 1;
			}
		} else {
			let as_str = arg.to_string_lossy();
			if let Some(spec) = as_str.strip_prefix("-k") {
				if !spec.is_empty() {
					key_index = key_index.saturating_add(1);
					matched_key = true;
				}
			} else if let Some(spec) = as_str.strip_prefix("--key=")
				&& !spec.is_empty()
			{
				key_index = key_index.saturating_add(1);
				matched_key = true;
			}
			i += 1;
		}

		if matched_key && let Some(&warning_idx) = index_by_arg.get(&i.saturating_sub(1)) {
			legacy_warnings[warning_idx].key_index = Some(key_index);
		}
	}
}

#[cfg(target_os = "linux")]
const LINUX_BATCH_DIVISOR: usize = 4;
#[cfg(target_os = "linux")]
const LINUX_BATCH_MIN: usize = 32;
#[cfg(target_os = "linux")]
const LINUX_BATCH_MAX: usize = 256;

fn default_merge_batch_size() -> usize {
	#[cfg(target_os = "linux")]
	{
		// Adjust merge batch size dynamically based on available file descriptors.
		match fd_soft_limit() {
			Some(limit) => {
				let usable_limit = limit.saturating_div(LINUX_BATCH_DIVISOR);
				usable_limit.clamp(LINUX_BATCH_MIN, LINUX_BATCH_MAX)
			},
			None => 64,
		}
	}

	#[cfg(not(target_os = "linux"))]
	{
		64
	}
}

#[cfg(not(unix))]
fn locale_failed_to_set() -> bool {
	use std::env;
	env::var_os("LC_ALL").as_deref() == Some(OsStr::new("missing"))
}

#[cfg(unix)]
fn locale_failed_to_set() -> bool {
	use nix::libc;
	unsafe { libc::setlocale(libc::LC_COLLATE, c"".as_ptr()).is_null() }
}

fn key_zero_width(selector: &FieldSelector) -> bool {
	let Some(to) = &selector.to else {
		return false;
	};
	if to.field < selector.from.field {
		return true;
	}
	if to.field == selector.from.field {
		return to.char != 0 && to.char < selector.from.char;
	}
	false
}

fn key_spans_multiple_fields(selector: &FieldSelector) -> bool {
	if !matches!(
		selector.settings.mode,
		SortMode::Numeric | SortMode::HumanNumeric | SortMode::GeneralNumeric
	) {
		return false;
	}
	match &selector.to {
		None => true,
		Some(to) => to.field > selector.from.field,
	}
}

fn key_leading_blanks_significant(selector: &FieldSelector) -> bool {
	selector.settings.mode == SortMode::Default
		&& !selector.from.ignore_blanks
		&& !selector.settings.ignore_blanks
}

fn emit_debug_warnings(
	host: &mut Host,
	settings: &GlobalSettings,
	flags: &GlobalOptionFlags,
	legacy_warnings: &[LegacyKeyWarning],
) {
	if locale_failed_to_set() {
		show_error!(&mut host.stderr, "{}", "failed to set locale");
	}

	let (locale, encoding) = i18n::get_collating_locale();

	if matches!(encoding, i18n::UEncoding::Utf8) {
		let locale_as_posix = format!("{}.UTF-8", locale.to_string().replace('-', "_"));
		show_error!(&mut host.stderr, "{}", format!("text ordering performed using ‘{locale_as_posix}’ sorting rules"));
	} else {
		show_error!(&mut host.stderr, "{}", "text ordering performed using simple byte comparison");
	}

	for (key_index, selector) in (1..).zip(settings.selectors.iter()) {
		if let Some(legacy) = legacy_warnings
			.iter()
			.find(|warning| warning.key_index == Some(key_index))
		{
			show_error!(&mut host.stderr, 
				"{}",
				format!(
					"obsolescent key '{}' used; consider '-k {}' instead",
					legacy.legacy_key_display(),
					legacy.replacement_key_display()
				)
			);
		}

		if key_zero_width(selector) {
			show_error!(&mut host.stderr, "{}", format!("key {key_index} has zero width and will be ignored"));
			continue;
		}

		if flags.keys_specified && key_spans_multiple_fields(selector) {
			show_error!(&mut host.stderr, "{}", format!("key {key_index} is numeric and spans multiple fields"));
		} else if flags.keys_specified && key_leading_blanks_significant(selector) {
			show_error!(&mut host.stderr, 
				"{}",
				format!(
					"leading blanks are significant in key {key_index}; consider also specifying 'b'"
				)
			);
		}
	}

	let numeric_used = settings.selectors.iter().any(|selector| {
		matches!(
			selector.settings.mode,
			SortMode::Numeric | SortMode::HumanNumeric | SortMode::GeneralNumeric
		)
	});

	let mut suppress_decimal_warning = false;
	if numeric_used {
		if let Some(sep) = settings.separator {
			match sep {
				b'.' => {
					show_error!(&mut host.stderr, "{}", "field separator '.' is treated as a decimal point in numbers");
					suppress_decimal_warning = true;
				},
				b'-' => {
					show_error!(&mut host.stderr, "{}", "field separator '-' is treated as a minus sign in numbers");
				},
				b'+' => {
					show_error!(&mut host.stderr, "{}", "field separator '+' is treated as a plus sign in numbers");
				},
				_ => {},
			}
		}

		if !suppress_decimal_warning {
			show_error!(&mut host.stderr, "{}", "numbers use '.' as a decimal point in this locale");
		}
	}

	let uses_reverse = settings
		.selectors
		.iter()
		.any(|selector| selector.settings.reverse);
	let uses_blanks = settings
		.selectors
		.iter()
		.any(|selector| selector.settings.ignore_blanks || selector.from.ignore_blanks);
	let uses_dictionary = settings
		.selectors
		.iter()
		.any(|selector| selector.settings.dictionary_order);
	let uses_case = settings
		.selectors
		.iter()
		.any(|selector| selector.settings.ignore_case);
	let uses_non_printing = settings
		.selectors
		.iter()
		.any(|selector| selector.settings.ignore_non_printing);

	let uses_mode = |mode| {
		settings
			.selectors
			.iter()
			.any(|selector| selector.settings.mode == mode)
	};

	let reverse_unused = flags.reverse && !uses_reverse;
	let last_resort_active =
		settings.mode != SortMode::Random && !settings.stable && !settings.unique;
	let reverse_ignored = reverse_unused && !last_resort_active;
	let reverse_last_resort_warning = reverse_unused && last_resort_active;

	let mut ignored_opts = String::new();
	if flags.ignore_leading_blanks && !uses_blanks {
		ignored_opts.push('b');
	}
	if flags.dictionary_order && !uses_dictionary {
		ignored_opts.push('d');
	}
	if flags.ignore_case && !uses_case {
		ignored_opts.push('f');
	}
	if flags.ignore_non_printing && !uses_non_printing {
		ignored_opts.push('i');
	}
	if flags.mode_general && !uses_mode(SortMode::GeneralNumeric) {
		ignored_opts.push('g');
	}
	if flags.mode_human && !uses_mode(SortMode::HumanNumeric) {
		ignored_opts.push('h');
	}
	if flags.mode_month && !uses_mode(SortMode::Month) {
		ignored_opts.push('M');
	}
	if flags.mode_numeric && !uses_mode(SortMode::Numeric) {
		ignored_opts.push('n');
	}
	if flags.mode_random && !uses_mode(SortMode::Random) {
		ignored_opts.push('R');
	}
	if reverse_ignored {
		ignored_opts.push('r');
	}
	if flags.mode_version && !uses_mode(SortMode::Version) {
		ignored_opts.push('V');
	}

	if ignored_opts.len() == 1 {
		show_error!(&mut host.stderr, "{}", format!("option '-{ignored_opts}' is ignored"));
	} else if ignored_opts.len() > 1 {
		show_error!(&mut host.stderr, "{}", format!("options '-{ignored_opts}' are ignored"));
	}

	if reverse_last_resort_warning {
		show_error!(&mut host.stderr, "{}", "option '-r' only applies to last-resort comparison");
	}
}

/// Parsed `sort` invocation.
pub(crate) struct Sort {
	matches:         ArgMatches,
	legacy_warnings: Vec<LegacyKeyWarning>,
}

impl FromArgMatches for Sort {
	fn from_arg_matches(matches: &ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { matches: matches.clone(), legacy_warnings: Vec::new() })
	}

	fn update_from_arg_matches(&mut self, matches: &ArgMatches) -> Result<(), clap::Error> {
		self.matches = matches.clone();
		self.legacy_warnings.clear();
		Ok(())
	}
}

impl CommandFactory for Sort {
	fn command() -> Command {
		uu_app()
	}

	fn command_for_update() -> Command {
		uu_app()
	}
}

impl clap::Parser for Sort {
	fn try_parse_from<I, T>(itr: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = T>,
		T: Into<OsString> + Clone,
	{
		let args: Vec<OsString> = itr.into_iter().map(Into::into).collect();
		let (processed_args, mut legacy_warnings) = preprocess_legacy_args(args);
		if !legacy_warnings.is_empty() {
			index_legacy_warnings(&processed_args, &mut legacy_warnings);
		}
		let matches = uu_app().try_get_matches_from(processed_args)?;
		Ok(Self { matches, legacy_warnings })
	}
}

impl Utility for Sort {
	const NAME: &'static str = "sort";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		match uu_sort(host, &self.matches, &self.legacy_warnings) {
			Ok(()) => host.exit_code(),
			Err(err) => {
				let code = err.code();
				let rendered = err.to_string();
				if !rendered.is_empty() {
					let _ = writeln!(host.stderr, "sort: {rendered}");
				}
				code
			},
		}
	}
}

#[allow(clippy::cognitive_complexity)]
fn uu_sort(host: &mut Host, matches: &ArgMatches, legacy_warnings: &[LegacyKeyWarning]) -> SortResult<()> {
	let mut settings = GlobalSettings {
		numeric_locale: detect_numeric_locale(),
		cancel: host.cancel_flag(),
		..Default::default()
	};
	// Prevent -o/--output to be specified multiple times
	if let Some(mut outputs) = matches.get_many::<OsString>(options::OUTPUT)
		&& let Some(first) = outputs.next()
		&& outputs.any(|out| out != first)
	{
		return Err(SortError::MultipleOutputFiles.into());
	}

	settings.debug = matches.get_flag(options::DEBUG);
	if let Some(path) = matches.get_one::<OsString>(options::RANDOM_SOURCE) {
		settings.random_source = Some(host.resolve(path));
	}

	// check whether user specified a zero terminated list of files for input,
	// otherwise read files from args
	let mut files: Vec<OsString> = if matches.contains_id(options::FILES0_FROM) {
		let files0_arg = matches
			.get_one::<OsString>(options::FILES0_FROM)
			.cloned()
			.unwrap_or_default();
		let files0_from = host.resolve(&files0_arg);

		// Cannot combine FILES with FILES0_FROM
		if let Some(s) = matches.get_one::<OsString>(options::FILES) {
			return Err(SortError::FileOperandsCombined { file: s.into() }.into());
		}

		let mut files = Vec::new();

		// sort errors with "cannot open: [...]" instead of "cannot read: [...]" here
		let reader: Box<dyn Read + Send> = if files0_arg == OsStr::new(STDIN_FILE) {
			let mut bytes = Vec::new();
			host.stdin
				.read_to_end(&mut bytes)
				.map_err(|error| SortError::ReadFailed { path: PathBuf::from(STDIN_FILE), error })?;
			Box::new(std::io::Cursor::new(bytes))
		} else {
			open_with_open_failed_error(&files0_from)?
		};
		let buf_reader = BufReader::new(reader);
		for (line_num, line_res) in buf_reader.split(b'\0').enumerate() {
			let line =
				line_res.map_err(|error| SortError::ReadFailed { path: files0_from.clone(), error })?;
			let f =
				std::str::from_utf8(&line).expect("Could not parse string from zero terminated input.");
			match f {
				STDIN_FILE => {
					return Err(SortError::MinusInStdIn.into());
				},
				"" => {
					return Err(
						SortError::ZeroLengthFileName { file: files0_from, line_num: line_num + 1 }
							.into(),
					);
				},
				_ => {},
			}

			files.push(host.resolve(OsStr::new(f)).into_os_string());
		}
		if files.is_empty() {
			return Err(SortError::EmptyInputFile { file: files0_from }.into());
		}
		files
	} else {
		matches
			.get_many::<OsString>(options::FILES)
			.map(|values| {
				values
					.map(|file| {
						if file == OsStr::new(STDIN_FILE) {
							file.clone()
						} else {
							host.resolve(file).into_os_string()
						}
					})
					.collect()
			})
			.unwrap_or_default()
	};

	let mut mode_flags = ModeFlags {
		human_numeric:   matches.get_flag(options::modes::HUMAN_NUMERIC),
		month:           matches.get_flag(options::modes::MONTH),
		general_numeric: matches.get_flag(options::modes::GENERAL_NUMERIC),
		numeric:         matches.get_flag(options::modes::NUMERIC),
		version:         matches.get_flag(options::modes::VERSION),
		random:          matches.get_flag(options::modes::RANDOM),
	};
	if let Some(sort_arg) = matches.get_one::<String>(options::modes::SORT) {
		match sort_arg.as_str() {
			"human-numeric" => mode_flags.human_numeric = true,
			"month" => mode_flags.month = true,
			"general-numeric" => mode_flags.general_numeric = true,
			"numeric" => mode_flags.numeric = true,
			"version" => mode_flags.version = true,
			"random" => mode_flags.random = true,
			_ => {},
		}
	}

	let dictionary_order = matches.get_flag(options::DICTIONARY_ORDER);
	let ignore_non_printing = matches.get_flag(options::IGNORE_NONPRINTING);
	let ignore_case = matches.get_flag(options::IGNORE_CASE);

	if !matches.contains_id(options::KEY)
		&& ordering_incompatible(mode_flags, dictionary_order, ignore_non_printing)
	{
		let opts =
			ordering_opts_string(mode_flags, dictionary_order, ignore_non_printing, ignore_case);
		return Err(incompatible_options_error(&opts));
	}

	settings.mode = mode_flags.to_mode();
	if mode_flags.random {
		settings.salt = Some(get_rand_string());
	}

	settings.dictionary_order = dictionary_order;
	settings.ignore_non_printing = ignore_non_printing;
	settings.ignore_case = ignore_case;
	if matches.contains_id(options::PARALLEL) {
		// "0" is default - threads = num of cores
		settings.threads = matches
			.get_one::<String>(options::PARALLEL)
			.map_or_else(|| "0".to_string(), String::from);
		#[cfg(not(target_os = "wasi"))]
		{
			if rayon_global_pool_available() {
				let num_threads = match settings.threads.parse::<usize>() {
					Ok(0) | Err(_) => std::thread::available_parallelism().map_or(1, NonZero::get),
					Ok(n) => n,
				};
				let _ = rayon::ThreadPoolBuilder::new()
					.num_threads(num_threads)
					.build_global();
			}
		}
	}

	if let Some(size_str) = matches.get_one::<String>(options::BUF_SIZE) {
		settings.buffer_size = GlobalSettings::parse_byte_count(size_str).map_err(|e| {
			SortError::message(format_error_message(&e, size_str, options::BUF_SIZE))
		})?;
		settings.buffer_size_is_explicit = true;
	} else {
		settings.buffer_size = automatic_buffer_size(&files);
		settings.buffer_size_is_explicit = false;
	}

	let tmp_base = matches
		.get_one::<String>(options::TMP_DIR)
		.map(PathBuf::from)
		.or_else(|| host.var("TMPDIR").map(PathBuf::from))
		.unwrap_or_else(|| PathBuf::from("/tmp"));
	let mut tmp_dir = TmpDirWrapper::new(host.resolve(tmp_base));

	settings.compress = matches
		.get_one::<String>(options::COMPRESS_PROG)
		.map(|prog| Compressor { prog: prog.clone(), env: host.child_env() });

	if let Some(n_merge) = matches.get_one::<String>(options::BATCH_SIZE) {
		match n_merge.parse::<usize>() {
			Ok(parsed_value) => {
				if parsed_value < 2 {
					show_error!(&mut host.stderr, "{}", format!("invalid --batch-size argument '{n_merge}'"));
					return Err(SortError::message("minimum --batch-size argument is '2'"));
				}
				settings.merge_batch_size = parsed_value;
			},
			Err(e) => {
				let error_message = if *e.kind() == IntErrorKind::PosOverflow {
					let batch_too_large = format!("--batch-size argument {} too large", n_merge.quote());

					#[cfg(target_os = "linux")]
					{
						show_error!(&mut host.stderr, "{batch_too_large}");

						format!("maximum --batch-size argument with current rlimit is {}", {
							let Some(rlimit) = fd_soft_limit() else {
								return Err(SortError::message("Failed to fetch rlimit"));
							};
							rlimit
						})
					}
					#[cfg(not(target_os = "linux"))]
					{
						batch_too_large
					}
				} else {
					format!("invalid --batch-size argument '{n_merge}'")
				};

				return Err(SortError::message(error_message));
			},
		}
	}

	settings.line_ending = LineEnding::from_zero_flag(matches.get_flag(options::ZERO_TERMINATED));
	settings.merge = matches.get_flag(options::MERGE);

	settings.check = matches.contains_id(options::check::CHECK);
	if settings.check && matches.get_flag(options::check::CHECK_SILENT) {
		return Err(incompatible_options_error("cC"));
	}
	if matches.get_flag(options::check::CHECK_SILENT)
		|| matches!(
			matches
				.get_one::<String>(options::check::CHECK)
				.map(String::as_str),
			Some(options::check::SILENT | options::check::QUIET)
		) {
		settings.check_silent = true;
		settings.check = true;
	}

	if matches.contains_id(options::OUTPUT) && settings.check {
		let opts = if settings.check_silent { "Co" } else { "co" };
		return Err(incompatible_options_error(opts));
	}

	settings.ignore_leading_blanks = matches.get_flag(options::IGNORE_LEADING_BLANKS);

	settings.reverse = matches.get_flag(options::REVERSE);
	settings.stable = matches.get_flag(options::STABLE);
	settings.unique = matches.get_flag(options::UNIQUE);

	if files.is_empty() {
		/* if no file, default to stdin */
		files.push(OsString::from(STDIN_FILE));
	} else if settings.check && files.len() != 1 {
		return Err(SortError::message(format!("extra operand {} not allowed with -c", files[1].quote())));
	}

	if let Some(arg) = matches.get_one::<OsString>(options::SEPARATOR) {
		let mut separator = arg.to_str().ok_or_else(|| {
			SortError::message(format!("separator is not valid unicode: {}", arg.quote()))
		})?;
		if separator == "\\0" {
			separator = "\0";
		}
		// This rejects non-ASCII codepoints, but perhaps we don't have to.
		// On the other hand GNU accepts any single byte, valid unicode or not.
		// (Supporting multi-byte chars would require changes in
		// tokenize_with_separator().)
		let &[sep_char] = separator.as_bytes() else {
			return Err(SortError::message(format!("separator must be exactly one character long: {}", separator.quote())));
		};
		settings.separator = Some(sep_char);
	}

	if let Some(values) = matches.get_many::<String>(options::KEY) {
		for value in values {
			let selector = FieldSelector::parse(value, &settings)?;
			settings.selectors.push(selector);
		}
	}

	if !matches.contains_id(options::KEY) {
		// add a default selector matching the whole line
		let key_settings = KeySettings::from(&settings);
		settings.selectors.push(
			FieldSelector::new(
				KeyPosition {
					field:         1,
					char:          1,
					ignore_blanks: key_settings.ignore_blanks,
				},
				None,
				key_settings,
			)
			.unwrap(),
		);
	}

	let needs_random = settings.mode == SortMode::Random
		|| settings
			.selectors
			.iter()
			.any(|selector| selector.settings.mode == SortMode::Random);
	if needs_random {
		settings.salt = Some(match settings.random_source.as_deref() {
			Some(path) => salt_from_random_source(path)?,
			None => get_rand_string(),
		});
	}

	materialize_stdin(host, &mut files, &mut tmp_dir)?;

	// Verify that we can open all input files. They are reopened later to avoid
	// holding every descriptor while the output file is prepared.
	for file in &files {
		open(file)?;
	}

	let output_path = matches
		.get_one::<OsString>(options::OUTPUT)
		.map(|path| host.resolve(path).into_os_string());
	let output = Output::new(output_path.as_ref(), Some(host.stdout_clone()))?;

	if settings.debug {
		let global_flags = GlobalOptionFlags::from_matches(matches);
		emit_debug_warnings(host, &settings, &global_flags, legacy_warnings);
	}

	// Initialize locale collation if needed (UTF-8 locales)
	// This MUST happen before init_precomputed() to avoid the performance
	// regression
	let needs_locale_collation = i18n::collator::init_locale_collation();

	settings.init_precomputed(needs_locale_collation);

	exec(&mut files, &settings, output, &mut tmp_dir, host.stderr_clone())
}

fn uu_app() -> Command {
	Command::new("sort")
		.version("0.8.0")
		.about(SORT_ABOUT)
		.after_help(SORT_AFTER_HELP)
		.override_usage(format_usage(SORT_USAGE))
		.infer_long_args(true)
		.disable_help_flag(true)
		.disable_version_flag(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::HELP)
				.long(options::HELP)
				.help("Print help information.")
				.action(ArgAction::Help),
		)
		.arg(
			Arg::new(options::VERSION)
				.long(options::VERSION)
				.help("Print version information.")
				.action(ArgAction::Version),
		)
		.arg(
			Arg::new(options::modes::SORT)
				.long(options::modes::SORT)
				.value_parser(ShortcutValueParser::new([
					"general-numeric",
					"human-numeric",
					"month",
					"numeric",
					"version",
					"random",
				])),
		)
		.arg(make_sort_mode_arg(
			options::modes::HUMAN_NUMERIC,
			'h',
			"compare according to human readable sizes, eg 1M > 100k".to_owned(),
		))
		.arg(make_sort_mode_arg(
			options::modes::MONTH,
			'M',
			"compare according to month name abbreviation".to_owned(),
		))
		.arg(make_sort_mode_arg(
			options::modes::NUMERIC,
			'n',
			"compare according to string numerical value".to_owned(),
		))
		.arg(make_sort_mode_arg(
			options::modes::GENERAL_NUMERIC,
			'g',
			"compare according to string general numerical value".to_owned(),
		))
		.arg(make_sort_mode_arg(
			options::modes::VERSION,
			'V',
			"Sort by SemVer version number, eg 1.12.2 > 1.1.2".to_owned(),
		))
		.arg(make_sort_mode_arg(options::modes::RANDOM, 'R', "shuffle in random order".to_owned()))
		.arg(
			Arg::new(options::RANDOM_SOURCE)
				.long(options::RANDOM_SOURCE)
				.help("use FILE as a source of random data")
				.value_name("FILE")
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::FilePath),
		)
		.arg(
			Arg::new(options::DICTIONARY_ORDER)
				.short('d')
				.long(options::DICTIONARY_ORDER)
				.help("consider only blanks and alphanumeric characters")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MERGE)
				.short('m')
				.long(options::MERGE)
				.help("merge already sorted files; do not sort")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::check::CHECK)
				.short('c')
				.long(options::check::CHECK)
				.require_equals(true)
				.num_args(0..)
				.value_parser(ShortcutValueParser::new([
					options::check::SILENT,
					options::check::QUIET,
					options::check::DIAGNOSE_FIRST,
				]))
				.help("check for sorted input; do not sort"),
		)
		.arg(
			Arg::new(options::check::CHECK_SILENT)
				.short('C')
				.long(options::check::CHECK_SILENT)
				.help(
					"exit successfully if the given file is already sorted, and exit with status 1 \
					 otherwise.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::IGNORE_CASE)
				.short('f')
				.long(options::IGNORE_CASE)
				.help("fold lower case to upper case characters")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::IGNORE_NONPRINTING)
				.short('i')
				.long(options::IGNORE_NONPRINTING)
				.help("ignore nonprinting characters")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::IGNORE_LEADING_BLANKS)
				.short('b')
				.long(options::IGNORE_LEADING_BLANKS)
				.help("ignore leading blanks when finding sort keys in each line")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OUTPUT)
				.short('o')
				.long(options::OUTPUT)
				.help("write output to FILENAME instead of stdout")
				.value_parser(ValueParser::os_string())
				.value_name("FILENAME")
				.value_hint(clap::ValueHint::FilePath)
				.num_args(1)
				.allow_hyphen_values(true)
				// To detect multiple occurrences and raise an error
				.action(ArgAction::Append),
		)
		.arg(
			Arg::new(options::REVERSE)
				.short('r')
				.long(options::REVERSE)
				.help("reverse the output")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::STABLE)
				.short('s')
				.long(options::STABLE)
				.help("stabilize sort by disabling last-resort comparison")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::UNIQUE)
				.short('u')
				.long(options::UNIQUE)
				.help("output only the first of an equal run")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KEY)
				.short('k')
				.long(options::KEY)
				.help("sort by a key")
				.action(ArgAction::Append)
				.num_args(1),
		)
		.arg(
			Arg::new(options::SEPARATOR)
				.short('t')
				.long(options::SEPARATOR)
				.help("custom separator for -k")
				.value_parser(ValueParser::os_string()),
		)
		.arg(
			Arg::new(options::ZERO_TERMINATED)
				.short('z')
				.long(options::ZERO_TERMINATED)
				.help("line delimiter is NUL, not newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PARALLEL)
				.long(options::PARALLEL)
				.help("change the number of threads running concurrently to NUM_THREADS")
				.value_name("NUM_THREADS"),
		)
		.arg(
			Arg::new(options::BUF_SIZE)
				.short('S')
				.long(options::BUF_SIZE)
				.help("sets the maximum SIZE of each segment in number of sorted items")
				.value_name("SIZE"),
		)
		.arg(
			Arg::new(options::TMP_DIR)
				.short('T')
				.long(options::TMP_DIR)
				.help("use DIR for temporaries, not $TMPDIR or /tmp")
				.value_name("DIR")
				.value_hint(clap::ValueHint::DirPath),
		)
		.arg(
			Arg::new(options::COMPRESS_PROG)
				.long(options::COMPRESS_PROG)
				.help(
					"compress temporary files with PROG, decompress with PROG -d; PROG has to take \
					 input from stdin and output to stdout",
				)
				.value_name("PROG")
				.value_hint(clap::ValueHint::CommandName),
		)
		.arg(
			Arg::new(options::BATCH_SIZE)
				.long(options::BATCH_SIZE)
				.help("Merge at most N_MERGE inputs at once.")
				.value_name("N_MERGE"),
		)
		.arg(
			Arg::new(options::FILES0_FROM)
				.long(options::FILES0_FROM)
				.help("read input from the files specified by NUL-terminated NUL_FILE")
				.value_name("NUL_FILE")
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::FilePath),
		)
		.arg(
			Arg::new(options::DEBUG)
				.long(options::DEBUG)
				.help("underline the parts of the line that are actually used for sorting")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FILES)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::FilePath),
		)
}

/// Creates the `sort` builtin registration.
pub(crate) fn sort_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sort, SE>()
}

fn exec(
	files: &mut [OsString],
	settings: &GlobalSettings,
	output: Output,
	tmp_dir: &mut TmpDirWrapper,
	stderr: OpenFile,
) -> SortResult<()> {
	if settings.merge {
		merge::merge(files, settings, output, tmp_dir)
	} else if settings.check {
		if files.len() > 1 {
			Err(SortError::message("only one file allowed with -c"))
		} else {
			check::check(files.first().unwrap(), settings)
		}
	} else {
		let mut lines = files.iter().map(open);
		ext_sort(&mut lines, settings, output, tmp_dir, stderr)
	}
}

fn sort_by<'a>(unsorted: &mut Vec<Line<'a>>, settings: &GlobalSettings, line_data: &LineData<'a>) {
	let cmp = |a: &Line<'a>, b: &Line<'a>| compare_by(a, b, settings, line_data, line_data);
	// WASI does not support threads, so use non-parallel sort to avoid
	// rayon's thread pool which triggers an unreachable trap. Windows can also
	// force sequential sort when pi-natives could not safely configure Rayon's
	// process-global worker pool under commit pressure.
	if settings.stable || settings.unique {
		#[cfg(not(target_os = "wasi"))]
		if rayon_global_pool_available() {
			unsorted.par_sort_by(cmp);
		} else {
			unsorted.sort_by(cmp);
		}
		#[cfg(target_os = "wasi")]
		unsorted.sort_by(cmp);
	} else {
		#[cfg(not(target_os = "wasi"))]
		if rayon_global_pool_available() {
			unsorted.par_sort_unstable_by(cmp);
		} else {
			unsorted.sort_unstable_by(cmp);
		}
		#[cfg(target_os = "wasi")]
		unsorted.sort_unstable_by(cmp);
	}
}

fn compare_by<'a>(
	a: &Line<'a>,
	b: &Line<'a>,
	global_settings: &GlobalSettings,
	a_line_data: &LineData<'a>,
	b_line_data: &LineData<'a>,
) -> Ordering {
	if global_settings.precomputed.fast_lexicographic {
		let cmp = a.line.cmp(b.line);
		return if global_settings.reverse {
			cmp.reverse()
		} else {
			cmp
		};
	}

		if global_settings.precomputed.fast_locale_collation {
		let a_key = a_line_data.collation_key(a.index);
		let b_key = b_line_data.collation_key(b.index);
		let cmp = a_key.cmp(b_key);
		return if global_settings.reverse {
			cmp.reverse()
		} else {
			cmp
		};
	}

	if global_settings.precomputed.fast_ascii_insensitive {
		let cmp = ascii_case_insensitive_cmp(a.line, b.line);
		if cmp != Ordering::Equal || a.line == b.line {
			return if global_settings.reverse {
				cmp.reverse()
			} else {
				cmp
			};
		}
	}

	let mut selection_index = 0;
	let mut num_info_index = 0;
	let mut parsed_float_index = 0;

	if let (Some(Some(a_f64)), Some(Some(b_f64))) =
		(a_line_data.line_num_floats.get(a.index), b_line_data.line_num_floats.get(b.index))
	{
		// we don't use total_cmp() because it always sorts -0 before 0
		if let Some(cmp) = a_f64.partial_cmp(b_f64) {
			// don't trust `Ordering::Equal` if lines are not fully equal
			if cmp != Ordering::Equal || a.line == b.line {
				return if global_settings.reverse {
					cmp.reverse()
				} else {
					cmp
				};
			}
		}
	}

	for selector in &global_settings.selectors {
		let (a_str, b_str) = if selector.needs_selection {
			let selections = (
				a_line_data.selections
					[a.index * global_settings.precomputed.selections_per_line + selection_index],
				b_line_data.selections
					[b.index * global_settings.precomputed.selections_per_line + selection_index],
			);
			selection_index += 1;
			selections
		} else {
			// We can select the whole line.
			(a.line, b.line)
		};

		let settings = &selector.settings;

		let cmp: Ordering = match settings.mode {
			SortMode::Random => {
				// check if the two strings are equal
				if custom_str_cmp(
					a_str,
					b_str,
					settings.ignore_non_printing,
					settings.dictionary_order,
					settings.ignore_case,
				) == Ordering::Equal
				{
					Ordering::Equal
				} else {
					// Only if they are not equal compare by the hash
					random_shuffle(a_str, b_str, &global_settings.salt.unwrap())
				}
			},
			SortMode::Numeric => {
				let a_num_info = &a_line_data.num_infos
					[a.index * global_settings.precomputed.num_infos_per_line + num_info_index];
				let b_num_info = &b_line_data.num_infos
					[b.index * global_settings.precomputed.num_infos_per_line + num_info_index];
				num_info_index += 1;
				numeric_str_cmp((a_str, a_num_info), (b_str, b_num_info))
			},
			SortMode::HumanNumeric => {
				let a_num_info = &a_line_data.num_infos
					[a.index * global_settings.precomputed.num_infos_per_line + num_info_index];
				let b_num_info = &b_line_data.num_infos
					[b.index * global_settings.precomputed.num_infos_per_line + num_info_index];
				num_info_index += 1;
				human_numeric_str_cmp((a_str, a_num_info), (b_str, b_num_info))
			},
			SortMode::GeneralNumeric => {
				let a_float = &a_line_data.parsed_floats
					[a.index * global_settings.precomputed.floats_per_line + parsed_float_index];
				let b_float = &b_line_data.parsed_floats
					[b.index * global_settings.precomputed.floats_per_line + parsed_float_index];
				parsed_float_index += 1;
				general_numeric_compare(a_float, b_float)
			},
			SortMode::Month => month_compare(a_str, b_str),
			SortMode::Version => version_cmp(a_str, b_str),
			SortMode::Default => {
				// Locale collation only applies when no custom filtering flags
				// alter the compared byte sequences.
				if settings.ignore_case || settings.dictionary_order || settings.ignore_non_printing {
					custom_str_cmp(
						a_str,
						b_str,
						settings.ignore_non_printing,
						settings.dictionary_order,
						settings.ignore_case,
					)
				} else {
					locale_cmp(a_str, b_str)
				}
			},
		};
		if cmp != Ordering::Equal {
			return if settings.reverse { cmp.reverse() } else { cmp };
		}
	}

	// Call "last resort compare" if all selectors returned Equal
	let cmp = if global_settings.mode == SortMode::Random
		|| global_settings.stable
		|| global_settings.unique
	{
		Ordering::Equal
	} else {
		a.line.cmp(b.line)
	};

	if global_settings.reverse {
		cmp.reverse()
	} else {
		cmp
	}
}

/// Compare two byte slices in ASCII case-insensitive order without allocating.
/// We upper each byte on the fly so that binary input (including `NUL`) stays
/// untouched and we avoid locale-sensitive routines such as `strcasecmp`.
fn ascii_case_insensitive_cmp(a: &[u8], b: &[u8]) -> Ordering {
	#[inline]
	fn fold(byte: u8) -> u8 {
		byte.to_ascii_uppercase()
	}

	for (lhs, rhs) in a.iter().copied().zip(b.iter().copied()) {
		let l = fold(lhs);
		let r = fold(rhs);
		if l != r {
			return l.cmp(&r);
		}
	}

	a.len().cmp(&b.len())
}

// This function cleans up the initial comparison done by leading_num_common for
// a general numeric compare. In contrast to numeric compare, GNU general
// numeric/FP sort *should* recognize positive signs and scientific notation, so
// we strip those lines only after the end of the following numeric string.
// For example, 5e10KFD would be 5e10 or 5x10^10 and +10000HFKJFK would become
// 10000.
#[allow(clippy::cognitive_complexity)]
fn get_leading_gen(inp: &[u8], decimal_pt: u8) -> Range<usize> {
	let trimmed = inp.trim_ascii_start();
	let leading_whitespace_len = inp.len() - trimmed.len();

	// check for inf, -inf and nan
	const ALLOWED_PREFIXES: &[&[u8]] = &[b"inf", b"-inf", b"nan"];
	for &allowed_prefix in ALLOWED_PREFIXES {
		if trimmed.len() >= allowed_prefix.len()
			&& trimmed[..allowed_prefix.len()].eq_ignore_ascii_case(allowed_prefix)
		{
			return leading_whitespace_len..(leading_whitespace_len + allowed_prefix.len());
		}
	}
	// Make this iter peekable to see if next char is numeric
	let mut char_indices = itertools::peek_nth(trimmed.iter().enumerate());

	let first = char_indices.peek();

	if matches!(first, Some((_, NEGATIVE | POSITIVE))) {
		char_indices.next();
	}

	let mut had_e_notation = false;
	let mut had_decimal_pt = false;
	let mut had_hex_notation: bool = false;
	while let Some((idx, &c)) = char_indices.next() {
		if had_hex_notation && c.is_ascii_hexdigit() {
			continue;
		}

		if c.is_ascii_digit() {
			if c == b'0' && matches!(char_indices.peek(), Some((_, b'x' | b'X'))) {
				had_hex_notation = true;
				char_indices.next();
			}
			continue;
		}

		if c == decimal_pt && !had_decimal_pt && !had_e_notation {
			had_decimal_pt = true;
			continue;
		}
		let is_decimal_e = (c == b'e' || c == b'E') && !had_hex_notation;
		let is_hex_e = (c == b'p' || c == b'P') && had_hex_notation;
		if (is_decimal_e || is_hex_e) && !had_e_notation {
			// we can only consume the 'e' if what follow is either a digit, or a sign
			// followed by a digit.
			if let Some(&(_, &next_char)) = char_indices.peek() {
				if (next_char == b'+' || next_char == b'-')
					&& matches!(
						 char_indices.peek_nth(1),
						 Some((_, c)) if c.is_ascii_digit()
					) {
					// Consume the sign. The following digits will be consumed by the main loop.
					char_indices.next();
					had_e_notation = true;
					continue;
				}
				if next_char.is_ascii_digit() {
					had_e_notation = true;
					continue;
				}
			}
		}
		return leading_whitespace_len..(leading_whitespace_len + idx);
	}
	leading_whitespace_len..inp.len()
}

#[derive(Clone, PartialEq, PartialOrd, Debug)]
pub enum GeneralBigDecimalParseResult {
	Invalid,
	Nan,
	MinusInfinity,
	Number(BigDecimal),
	Infinity,
}

/// Parse the beginning string into a [`GeneralBigDecimalParseResult`].
/// Using a [`GeneralBigDecimalParseResult`] instead of [`ExtendedBigDecimal`]
/// is necessary to correctly order floats.
#[inline(always)]
fn general_bd_parse(a: &[u8], decimal_pt: u8) -> GeneralBigDecimalParseResult {
	let parsed_bytes = (decimal_pt != DECIMAL_PT).then(|| {
		a.iter()
			.map(|&b| if b == decimal_pt { DECIMAL_PT } else { b })
			.collect::<Vec<_>>()
	});
	let input = parsed_bytes.as_deref().unwrap_or(a);

	// The string should be valid ASCII to be parsed.
	let Ok(a) = std::str::from_utf8(input) else {
		return GeneralBigDecimalParseResult::Invalid;
	};

	// Parse digits, and fold in recoverable errors
	let ebd = match ExtendedBigDecimal::extended_parse(a) {
		Err(ExtendedParserError::NotNumeric) => return GeneralBigDecimalParseResult::Invalid,
		Err(
			ExtendedParserError::PartialMatch(ebd, _)
			| ExtendedParserError::Overflow(ebd)
			| ExtendedParserError::Underflow(ebd),
		)
		| Ok(ebd) => ebd,
	};

	match ebd {
		ExtendedBigDecimal::BigDecimal(bd) => GeneralBigDecimalParseResult::Number(bd),
		ExtendedBigDecimal::Infinity => GeneralBigDecimalParseResult::Infinity,
		ExtendedBigDecimal::MinusInfinity => GeneralBigDecimalParseResult::MinusInfinity,
		// Minus zero and zero are equal
		ExtendedBigDecimal::MinusZero => GeneralBigDecimalParseResult::Number(0.into()),
		ExtendedBigDecimal::Nan | ExtendedBigDecimal::MinusNan => GeneralBigDecimalParseResult::Nan,
	}
}

/// Compares two floats, with errors and non-numerics assumed to be -inf.
/// Stops coercing at the first non-numeric char.
/// We explicitly need to convert to f64 in this case.
fn general_numeric_compare(
	a: &GeneralBigDecimalParseResult,
	b: &GeneralBigDecimalParseResult,
) -> Ordering {
	a.partial_cmp(b).unwrap()
}

/// Generate a 128-bit salt from a uniform RNG distribution.
fn get_rand_string() -> [u8; SALT_LEN] {
	rng().sample(rand::distr::StandardUniform)
}

const SALT_LEN: usize = 16; // 128-bit salt
const MAX_BYTES: usize = 1024 * 1024; // Read cap: 1 MiB
const BUF_LEN: usize = 8192; // 8 KiB read buffer
const U64_LEN: usize = 8;
const RANDOM_SOURCE_TAG: &[u8] = b"uutils-sort-random-source"; // Domain separation tag

/// Create a 128-bit salt by hashing up to 1 MiB from the given file.
fn salt_from_random_source(path: &Path) -> SortResult<[u8; SALT_LEN]> {
	let mut reader = open_with_open_failed_error(path)?;
	let mut buf = [0u8; BUF_LEN];
	let mut total = 0usize;
	// freeze seed for --random-source
	let mut hasher = FoldHasher::with_seed(1, SharedSeed::global_fixed());

	loop {
		let n = reader
			.read(&mut buf)
			.map_err(|error| SortError::ReadFailed { path: path.to_owned(), error })?;
		if n == 0 {
			break;
		}
		let remaining = MAX_BYTES.saturating_sub(total);
		if remaining == 0 {
			break;
		}
		let take = n.min(remaining);
		hasher.write(&buf[..take]);
		total = total.saturating_add(take);
		if take < n {
			break;
		}
	}

	let first = hasher.finish();
	// freeze seed for --random-source
	let mut second_hasher = FoldHasher::with_seed(2, SharedSeed::global_fixed());
	second_hasher.write(RANDOM_SOURCE_TAG);
	second_hasher.write_u64(first);
	let second = second_hasher.finish();

	let mut out = [0u8; SALT_LEN];
	out[..U64_LEN].copy_from_slice(&first.to_le_bytes());
	out[U64_LEN..].copy_from_slice(&second.to_le_bytes());
	Ok(out)
}

fn get_hash<T: Hash>(t: &T) -> u64 {
	// Is reproducibility of get_hash itself needed for --random-source ?
	let mut s = FoldHasher::with_seed(0, SharedSeed::global_fixed());
	t.hash(&mut s);
	s.finish()
}

fn random_shuffle(a: &[u8], b: &[u8], salt: &[u8]) -> Ordering {
	let da = get_hash(&(a, salt));
	let db = get_hash(&(b, salt));
	da.cmp(&db)
}

#[derive(Eq, Ord, PartialEq, PartialOrd, Clone, Copy)]
enum Month {
	Unknown,
	January,
	February,
	March,
	April,
	May,
	June,
	July,
	August,
	September,
	October,
	November,
	December,
}

/// Cached locale month lookup table.
/// Each entry is (uppercased_name, month_value).
type MonthTable = Vec<(Vec<u8>, Month)>;

fn get_locale_month_table() -> Option<&'static MonthTable> {
	static TABLE: OnceLock<Option<MonthTable>> = OnceLock::new();

	TABLE
		.get_or_init(|| {
			let months = get_locale_months()?;
			let all_months = [
				Month::January,
				Month::February,
				Month::March,
				Month::April,
				Month::May,
				Month::June,
				Month::July,
				Month::August,
				Month::September,
				Month::October,
				Month::November,
				Month::December,
			];
			let table: Vec<(Vec<u8>, Month)> = months
				.iter()
				.zip(all_months.iter())
				.map(|(name, &month)| (name.clone(), month))
				.collect();
			Some(table)
		})
		.as_ref()
}

/// Parse the beginning string into a Month, returning [`Month::Unknown`] on
/// errors. Also returns the byte length consumed from the input (after leading
/// blanks).
///
/// The stored locale month names have blanks stripped and are uppercased.
/// Comparison against input is case-insensitive but NOT blank-insensitive:
/// the input must match the stored name exactly (after leading blank trimming).
fn month_parse(line: &[u8]) -> (Month, usize) {
	let line = line.trim_ascii_start();

	// Try locale-specific month names, keeping the longest match.
	// This handles cases where one name is a prefix of another
	// (e.g., Japanese "1" vs "10", "11", "12").
	if let Some(table) = get_locale_month_table() {
		let mut best = None;
		for (name, month) in table {
			if line.len() >= name.len()
				&& line[..name.len()].eq_ignore_ascii_case(name)
				&& best.as_ref().is_none_or(|&(len, _)| name.len() > len)
			{
				best = Some((name.len(), *month));
			}
		}
		if let Some((len, month)) = best {
			return (month, len);
		}
	}

	// Fall back to English 3-letter abbreviations
	match line.get(..3).map(<[u8]>::to_ascii_uppercase).as_deref() {
		Some(b"JAN") => (Month::January, 3),
		Some(b"FEB") => (Month::February, 3),
		Some(b"MAR") => (Month::March, 3),
		Some(b"APR") => (Month::April, 3),
		Some(b"MAY") => (Month::May, 3),
		Some(b"JUN") => (Month::June, 3),
		Some(b"JUL") => (Month::July, 3),
		Some(b"AUG") => (Month::August, 3),
		Some(b"SEP") => (Month::September, 3),
		Some(b"OCT") => (Month::October, 3),
		Some(b"NOV") => (Month::November, 3),
		Some(b"DEC") => (Month::December, 3),
		_ => (Month::Unknown, 0),
	}
}

fn month_compare(a: &[u8], b: &[u8]) -> Ordering {
	let ma = month_parse(a).0;
	let mb = month_parse(b).0;

	ma.cmp(&mb)
}

fn print_sorted<'a, T: Iterator<Item = &'a Line<'a>>>(
	iter: T,
	settings: &GlobalSettings,
	output: Output,
) -> SortResult<()> {
	let output_name = output
		.as_output_name()
		.unwrap_or(OsStr::new("standard output"))
		.to_owned();

	let mut writer = output.into_write();
	for line in iter {
		line.print(&mut writer, settings)
			.map_err(|error| SortError::WriteFailed { path: output_name.clone(), error })?;
	}
	writer
		.flush()
		.map_err(|error| SortError::WriteFailed { path: output_name, error })?;
	Ok(())
}

fn open(path: impl AsRef<OsStr>) -> SortResult<Box<dyn Read + Send>> {
	let path = Path::new(path.as_ref());
	match File::open(path) {
		Ok(file) => Ok(Box::new(file)),
		Err(error) => Err(SortError::ReadFailed { path: path.to_owned(), error }),
	}
}

fn open_with_open_failed_error(path: impl AsRef<OsStr>) -> SortResult<Box<dyn Read + Send>> {
	// On error, returns an OpenFailed error instead of a ReadFailed error
	let path = Path::new(path.as_ref());
	match File::open(path) {
		Ok(file) => Ok(Box::new(file)),
		Err(error) => Err(SortError::OpenFailed { path: path.to_owned(), error }),
	}
}

fn format_error_message(error: &ParseSizeError, s: &str, option: &str) -> String {
	// NOTE:
	// GNU's sort echos affected flag, -S or --buffer-size, depending on user's
	// selection
	match error {
		ParseSizeError::InvalidSuffix(_) => {
			format!("invalid suffix in --{option} argument {}", s.quote())
		},
		ParseSizeError::ParseFailure(_) | ParseSizeError::PhysicalMem(_) => {
			format!("invalid --{option} argument {}", s.quote())
		},
		ParseSizeError::SizeTooBig(_) => {
			format!("--{option} argument {} too large", s.quote())
		},
	}
}

#[cfg(test)]
mod tests {

	use super::*;
	use crate::host::run_util;

	fn tokenize_helper(line: &[u8], separator: Option<u8>) -> Vec<Field> {
		let mut buffer = vec![];
		let precomputed = Precomputed::default();
		tokenize(line, separator, &mut buffer, &precomputed);
		buffer
	}

	#[test]
	fn test_random_shuffle() {
		let a = b"Ted";
		let b = b"Ted";
		let c = get_rand_string();

		assert_eq!(Ordering::Equal, random_shuffle(a, b, &c));
	}

	#[test]
	fn test_month_compare() {
		let a = b"JaN";
		let b = b"OCt";

		assert_eq!(Ordering::Less, month_compare(a, b));
	}
	#[test]
	fn test_version_compare() {
		let a = b"1.2.3-alpha2";
		let b = b"1.4.0";

		assert_eq!(Ordering::Less, version_cmp(a, b));
	}

	#[test]
	fn test_random_compare() {
		let a = b"9";
		let b = b"9";
		let c = get_rand_string();

		assert_eq!(Ordering::Equal, random_shuffle(a, b, &c));
	}

	#[test]
	fn test_tokenize_fields() {
		let line = b"foo bar b    x";
		assert_eq!(tokenize_helper(line, None), vec![0..3, 3..7, 7..9, 9..14]);
	}

	#[test]
	fn test_tokenize_fields_leading_whitespace() {
		let line = b"    foo bar b    x";
		assert_eq!(tokenize_helper(line, None), vec![0..7, 7..11, 11..13, 13..18]);
	}

	#[test]
	fn test_tokenize_fields_custom_separator() {
		let line = b"aaa foo bar b    x";
		assert_eq!(tokenize_helper(line, Some(b'a')), vec![0..0, 1..1, 2..2, 3..9, 10..18]);
	}

	#[test]
	fn test_tokenize_fields_trailing_custom_separator() {
		let line = b"a";
		assert_eq!(tokenize_helper(line, Some(b'a')), vec![0..0]);
		let line = b"aa";
		assert_eq!(tokenize_helper(line, Some(b'a')), vec![0..0, 1..1]);
		let line = b"..a..a";
		assert_eq!(tokenize_helper(line, Some(b'a')), vec![0..2, 3..5]);
	}

	#[test]
	#[cfg(target_pointer_width = "64")]
	fn test_line_size() {
		// We should make sure to not regress the size of the Line struct because
		// it is unconditional overhead for every line we sort.
		assert_eq!(size_of::<Line>(), 24);
	}

	#[test]
	fn test_parse_byte_count() {
		let valid_input = [
			("0", 0),
			("50K", 50 * 1024),
			("50k", 50 * 1024),
			("1M", 1024 * 1024),
			("100M", 100 * 1024 * 1024),
			#[cfg(not(target_pointer_width = "32"))]
			("1000G", 1000 * 1024 * 1024 * 1024),
			#[cfg(not(target_pointer_width = "32"))]
			("10T", 10 * 1024 * 1024 * 1024 * 1024),
			("1b", 1),
			("1024b", 1024),
			("1024Mb", 1024 * 1024 * 1024), // NOTE: This might not be how GNU `sort` behaves for 'Mb'
			("1", 1024),                    // K is default
			("50", 50 * 1024),
			("K", 1024),
			("k", 1024),
			("m", 1024 * 1024),
			#[cfg(not(target_pointer_width = "32"))]
			("E", 1024 * 1024 * 1024 * 1024 * 1024 * 1024),
		];
		for (input, expected_output) in &valid_input {
			assert_eq!(GlobalSettings::parse_byte_count(input), Ok(*expected_output));
		}

		// SizeTooBig
		let invalid_input = ["500E", "1Y"];
		for input in &invalid_input {
			assert!(GlobalSettings::parse_byte_count(input).is_err());
		}

		// ParseFailure
		let invalid_input = ["nonsense", "1B", "B", "b", "p", "e", "z", "y"];
		for input in &invalid_input {
			assert!(GlobalSettings::parse_byte_count(input).is_err());
		}
	}
	#[test]
	fn sorts_standard_input() {
		let (code, capture) = run_util::<Sort>(&[], "beta\nalpha\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "alpha\nbeta\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn check_mode_preserves_disorder_statuses() {
		let (code, capture) = run_util::<Sort>(&["-c"], "beta\nalpha\n", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("disorder"));

		let (code, capture) = run_util::<Sort>(&["-C"], "beta\nalpha\n", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn output_may_also_be_an_input() {
		let dir = tempfile::tempdir().expect("temp dir");
		let path = dir.path().join("values");
		std::fs::write(&path, "beta\nalpha\n").expect("fixture");
		let (code, capture) =
			run_util::<Sort>(&["-o", "values", "values"], "", dir.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(std::fs::read_to_string(path).expect("output"), "alpha\nbeta\n");
	}

}
