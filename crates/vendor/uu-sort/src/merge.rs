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
	path::PathBuf,
	process::{Child, ChildStdin, ChildStdout, Command, Stdio},
	rc::Rc,
	sync::mpsc::{Receiver, Sender, SyncSender, channel, sync_channel},
	thread::{self, JoinHandle},
};

use compare::Compare;
use uucore::error::{FromIo, UResult};

use crate::{
	GlobalSettings, Output, SortError,
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
) -> UResult<()> {
	let mut copy: Option<PathBuf> = None;
	if let Some(Ok(output_path)) = output.map(|path| pi_uutils_ctx::resolve(path).canonicalize()) {
		for file in files {
			if let Ok(file_path) = pi_uutils_ctx::resolve(file.as_os_str()).canonicalize()
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
/// intermediate files will be used. If `settings.compress_prog` is `Some`,
/// intermediate files will be compressed with it.
pub fn merge(
	files: &mut [OsString],
	settings: &GlobalSettings,
	output: Output,
	tmp_dir: &mut TmpDirWrapper,
) -> UResult<()> {
	replace_output_file_in_input_files(files, output.as_output_name(), tmp_dir)?;
	let files = files
		.iter()
		.map(|file| open(file).map(|file| PlainMergeInput { inner: file }));
	if settings.compress_prog.is_none() {
		merge_with_file_limit::<_, _, WriteablePlainTmpFile>(files, settings, output, tmp_dir)
	} else {
		merge_with_file_limit::<_, _, WriteableCompressedTmpFile>(files, settings, output, tmp_dir)
	}
}

// Merge already sorted `MergeInput`s.
pub fn merge_with_file_limit<
	M: MergeInput + 'static,
	F: ExactSizeIterator<Item = UResult<M>>,
	Tmp: WriteableTmpFile + 'static,
>(
	files: F,
	settings: &GlobalSettings,
	output: Output,
	tmp_dir: &mut TmpDirWrapper,
) -> UResult<()> {
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
					Tmp::create(tmp_dir.next_file()?, settings.compress_prog.as_deref())?;
				merger.write_all_to(settings, tmp_file.as_write())?;
				temporary_files.push(tmp_file.finished_writing()?);
			}
		}
		// Merge any remaining files that didn't get merged in a full batch above.
		if !batch.is_empty() {
			assert!(batch.len() < batch_size);
			let merger = merge_without_limit(batch.into_iter(), settings)?;

			let mut tmp_file = Tmp::create(tmp_dir.next_file()?, settings.compress_prog.as_deref())?;
			merger.write_all_to(settings, tmp_file.as_write())?;
			temporary_files.push(tmp_file.finished_writing()?);
		}
		merge_with_file_limit::<_, _, Tmp>(
			temporary_files
				.into_iter()
				.map(Box::new(|c: Tmp::Closed| c.reopen())
					as Box<dyn FnMut(Tmp::Closed) -> UResult<<Tmp::Closed as ClosedTmpFile>::Reopened>>),
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
fn merge_without_limit<M: MergeInput + 'static, F: Iterator<Item = UResult<M>>>(
	files: F,
	settings: &GlobalSettings,
) -> UResult<FileMerger<'_>> {
	let (request_sender, request_receiver) = channel();
	let mut reader_files = Vec::with_capacity(files.size_hint().0);
	let mut loaded_receivers = Vec::with_capacity(files.size_hint().0);
	for (file_number, file) in files.enumerate() {
		let (sender, receiver) = sync_channel(2);
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
	sender:     SyncSender<Chunk>,
	carry_over: Vec<u8>,
}

/// The function running on the reader thread.
fn reader(
	recycled_receiver: &Receiver<(usize, RecycledChunk)>,
	files: &mut [Option<ReaderFile<impl MergeInput>>],
	settings: &GlobalSettings,
	separator: u8,
) -> UResult<()> {
	for (file_idx, recycled_chunk) in recycled_receiver {
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
	reader_join_handle: JoinHandle<UResult<()>>,
}

impl FileMerger<'_> {
	/// Write the merged contents to the output file.
	fn write_all(self, settings: &GlobalSettings, output: Output) -> UResult<()> {
		let mut out = output.into_write();
		self.write_all_to(settings, &mut out)
	}

	fn write_all_to(mut self, settings: &GlobalSettings, out: &mut impl Write) -> UResult<()> {
		while self
			.write_next(settings, out)
			.map_err_context(|| "write failed".into())?
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
fn check_child_success(mut child: Child, program: &str) -> UResult<()> {
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
	fn create(file: (File, PathBuf), compress_prog: Option<&str>) -> UResult<Self>;
	/// Closes the temporary file.
	fn finished_writing(self) -> UResult<Self::Closed>;
	fn as_write(&mut self) -> &mut Self::InnerWrite;
}
/// A temporary file that is (temporarily) closed, but can be reopened.
pub trait ClosedTmpFile {
	type Reopened: MergeInput;
	/// Reopens the temporary file.
	fn reopen(self) -> UResult<Self::Reopened>;
}
/// A pre-sorted input for merging.
pub trait MergeInput: Send {
	type InnerRead: Read;
	/// Cleans this `MergeInput` up.
	/// Implementations may delete the backing file.
	fn finished_reading(self) -> UResult<()>;
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

	fn create((file, path): (File, PathBuf), _: Option<&str>) -> UResult<Self> {
		Ok(Self { file: BufWriter::new(file), path })
	}

	fn finished_writing(self) -> UResult<Self::Closed> {
		Ok(ClosedPlainTmpFile { path: self.path })
	}

	fn as_write(&mut self) -> &mut Self::InnerWrite {
		&mut self.file
	}
}
impl ClosedTmpFile for ClosedPlainTmpFile {
	type Reopened = PlainTmpMergeInput;

	fn reopen(self) -> UResult<Self::Reopened> {
		Ok(PlainTmpMergeInput {
			file: File::open(&self.path).map_err(|error| SortError::OpenTmpFileFailed { error })?,
			path: self.path,
		})
	}
}
impl MergeInput for PlainTmpMergeInput {
	type InnerRead = File;

	fn finished_reading(self) -> UResult<()> {
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
	path:          PathBuf,
	compress_prog: String,
	child:         Child,
	child_stdin:   BufWriter<ChildStdin>,
}
pub struct ClosedCompressedTmpFile {
	path:          PathBuf,
	compress_prog: String,
}
pub struct CompressedTmpMergeInput {
	path:          PathBuf,
	compress_prog: String,
	child:         Child,
	child_stdout:  ChildStdout,
}
impl WriteableTmpFile for WriteableCompressedTmpFile {
	type Closed = ClosedCompressedTmpFile;
	type InnerWrite = BufWriter<ChildStdin>;

	fn create((file, path): (File, PathBuf), compress_prog: Option<&str>) -> UResult<Self> {
		let compress_prog = compress_prog.unwrap();
		let mut command = Command::new(compress_prog);
		command.stdin(Stdio::piped()).stdout(file);
		let mut child = command
			.spawn()
			.map_err(|err| SortError::CompressProgExecutionFailed {
				prog:  compress_prog.to_owned(),
				error: err,
			})?;
		let child_stdin = child.stdin.take().unwrap();
		Ok(Self {
			path,
			compress_prog: compress_prog.to_owned(),
			child,
			child_stdin: BufWriter::new(child_stdin),
		})
	}

	fn finished_writing(self) -> UResult<Self::Closed> {
		drop(self.child_stdin);
		check_child_success(self.child, &self.compress_prog)?;
		Ok(ClosedCompressedTmpFile { path: self.path, compress_prog: self.compress_prog })
	}

	fn as_write(&mut self) -> &mut Self::InnerWrite {
		&mut self.child_stdin
	}
}
impl ClosedTmpFile for ClosedCompressedTmpFile {
	type Reopened = CompressedTmpMergeInput;

	fn reopen(self) -> UResult<Self::Reopened> {
		let mut command = Command::new(&self.compress_prog);
		// mirroring what is done for ClosedPlainTmpFile
		let file = File::open(&self.path).map_err(|error| SortError::OpenTmpFileFailed { error })?;
		command.stdin(file).stdout(Stdio::piped()).arg("-d");
		let mut child = command
			.spawn()
			.map_err(|err| SortError::CompressProgExecutionFailed {
				prog:  self.compress_prog.clone(),
				error: err,
			})?;
		let child_stdout = child.stdout.take().unwrap();
		Ok(CompressedTmpMergeInput {
			path: self.path,
			compress_prog: self.compress_prog,
			child,
			child_stdout,
		})
	}
}
impl MergeInput for CompressedTmpMergeInput {
	type InnerRead = ChildStdout;

	fn finished_reading(self) -> UResult<()> {
		// Explicitly close stdout before waiting on the child process.
		#[allow(clippy::drop_non_drop)]
		drop(self.child_stdout);
		check_child_success(self.child, &self.compress_prog)?;
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

	fn finished_reading(self) -> UResult<()> {
		Ok(())
	}

	fn as_read(&mut self) -> &mut Self::InnerRead {
		&mut self.inner
	}
}
