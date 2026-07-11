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
	sync::mpsc::{Receiver, SyncSender},
	thread,
};

use itertools::Itertools;
use uucore::error::{UResult, strip_errno};

use crate::{
	GlobalSettings, Line, Output,
	chunks::{self, Chunk, RecycledChunk},
	compare_by, merge,
	merge::{WriteableCompressedTmpFile, WriteablePlainTmpFile, WriteableTmpFile},
	print_sorted, sort_by,
	tmp_dir::TmpDirWrapper,
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
	files: &mut impl Iterator<Item = UResult<Box<dyn Read + Send>>>,
	settings: &GlobalSettings,
	output: Output,
	tmp_dir: &mut TmpDirWrapper,
) -> UResult<()> {
	let (sorted_sender, sorted_receiver) = std::sync::mpsc::sync_channel(1);
	let (recycled_sender, recycled_receiver) = std::sync::mpsc::sync_channel(1);
	thread::spawn({
		let settings = settings.clone();
		move || sorter(&recycled_receiver, &sorted_sender, &settings)
	});

	// Test if compression program exists and works, disable if not
	let mut effective_settings = settings.clone();
	if let Some(ref prog) = settings.compress_prog {
		// Test the compression program by trying to spawn it
		match std::process::Command::new(prog)
			.stdin(std::process::Stdio::null())
			.stdout(std::process::Stdio::null())
			.stderr(std::process::Stdio::null())
			.spawn()
		{
			Ok(mut child) => {
				// Kill the test process immediately
				let _ = child.kill();
			},
			Err(err) => {
				// Print the error and disable compression
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"sort: could not run compress program '{prog}': {}",
					strip_errno(&err)
				);
				effective_settings.compress_prog = None;
			},
		}
	}

	if effective_settings.compress_prog.is_some() {
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
	}
}

fn reader_writer<
	F: Iterator<Item = UResult<Box<dyn Read + Send>>>,
	Tmp: WriteableTmpFile + 'static,
>(
	files: F,
	settings: &GlobalSettings,
	receiver: &Receiver<Chunk>,
	sender: SyncSender<Chunk>,
	output: Output,
	tmp_dir: &mut TmpDirWrapper,
) -> UResult<()> {
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
fn sorter(receiver: &Receiver<Chunk>, sender: &SyncSender<Chunk>, settings: &GlobalSettings) {
	while let Ok(mut payload) = receiver.recv() {
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
	mut files: impl Iterator<Item = UResult<Box<dyn Read + Send>>>,
	tmp_dir: &mut TmpDirWrapper,
	separator: u8,
	buffer_size: usize,
	settings: &GlobalSettings,
	receiver: &Receiver<Chunk>,
	sender: SyncSender<Chunk>,
) -> UResult<ReadResult<I>> {
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
			write::<I>(&chunk, tmp_dir.next_file()?, settings.compress_prog.as_deref(), separator)?;
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
/// `compress_prog` is used to optionally compress file contents.
fn write<I: WriteableTmpFile>(
	chunk: &Chunk,
	file: (File, PathBuf),
	compress_prog: Option<&str>,
	separator: u8,
) -> UResult<I::Closed> {
	let mut tmp_file = I::create(file, compress_prog)?;
	write_lines(chunk.lines(), tmp_file.as_write(), separator);
	tmp_file.finished_writing()
}

fn write_lines<T: Write>(lines: &[Line], writer: &mut T, separator: u8) {
	for s in lines {
		writer.write_all(s.line).unwrap();
		writer.write_all(&[separator]).unwrap();
	}
}
