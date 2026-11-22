//! One run's output that never reaches its own stdout (what crosses its
//! pipes, what it redirects into files), readable during and after the run.
//!
//! `cargo build 2>&1 | tail -5` shows nothing until `cargo` exits: `tail`
//! holds its input back. With [`PipeTaps`] on a run (see
//! [`ShellRunOptions::pipe_taps`](crate::ShellRunOptions)), every `|` the run
//! spawns is mirrored through the engine's pipe tap
//! ([`crate::bash::Host::pipe_tap`]), and the bytes `cargo` has
//! written so far stay readable here as stream 1.
//!
//! `cargo build > build.log 2>&1` prints nothing at all. The tap is told of
//! every regular file a redirection opens for writing
//! ([`crate::bash::PipeTap::file`]) and lists it as a stream too, read from
//! the file itself: nothing is copied.
//!
//! On a run that also folds a [`RunTrace`](crate::bash::trace::RunTrace),
//! each stream names its writer's node in the trace
//! ([`PipeStreamInfo::node`]): the run links the two through
//! [`PipeTaps::open_pipe`] and [`PipeTaps::add_file`]. Without a trace (the
//! [`PipeTap`] impl) streams name none.

use std::{
	collections::VecDeque,
	fs::{self, File},
	io::{self, Read, Seek, SeekFrom},
	path::{Path, PathBuf},
	sync::Arc,
	time::SystemTime,
};

use bstr::{BStr, ByteSlice};
use parking_lot::Mutex;

use crate::bash::{PipeMirror, PipeTap, TapSite, trace::viz::model::NodeKey};

/// Bytes kept per stream: its most recent output.
const RETAINED_BYTES: usize = 1 << 20;
/// Streams one run keeps, open and finished together; pipes past this many
/// open ones stay untapped.
const MAX_STREAMS: usize = 16;
/// Finished streams one run keeps, newest first, so a loop of short
/// pipelines (`for f in *; do cat "$f" | wc -l; done`) holds a few, not all.
const MAX_FINISHED_STREAMS: usize = 4;
/// Redirected files one run keeps, newest first, so a loop writing a file per
/// item (`for f in *; do sort "$f" > "$f.sorted"; done`) holds a few.
const MAX_FILES: usize = 8;

/// The tapped pipes and redirected files of one shell run, numbered together
/// from 1 in the order the run opened them.
#[derive(Default)]
pub struct PipeTaps {
	inner: Mutex<TapsInner>,
}

#[derive(Default)]
struct TapsInner {
	/// Ids handed out so far; the next stream is `opened + 1`.
	opened:  u32,
	streams: Vec<Arc<PipeStream>>,
	/// Files the run redirected output into, oldest first.
	files:   Vec<FileStream>,
	/// [`PipeTaps::end`] was called: the run writes its files no more.
	ended:   bool,
}

/// One file a command of the run redirected its output into.
#[derive(Clone)]
struct FileStream {
	id:      u32,
	command: String,
	path:    PathBuf,
	node:    Option<NodeKey>,
}

/// One tapped pipe: the producing and consuming stages and the tail of what
/// crossed it.
pub struct PipeStream {
	id:       u32,
	producer: String,
	consumer: String,
	node:     Option<NodeKey>,
	state:    Mutex<StreamState>,
}

struct StreamState {
	/// The last [`RETAINED_BYTES`] bytes written.
	tail:     VecDeque<u8>,
	/// Every byte ever written, retained or not.
	total:    u64,
	open:     bool,
	/// When the last bytes were written; when the pipe opened before any.
	modified: SystemTime,
}

/// A tapped pipe or redirected file as [`PipeTaps::list`] reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipeStreamInfo {
	pub id:       u32,
	/// Source text of the stage writing into the pipe, or of the command
	/// whose redirection opened the file.
	pub producer: String,
	/// Source text of the stage reading from the pipe, or the file's
	/// absolute path.
	pub consumer: String,
	/// Bytes written so far, including those no longer retained; a file's
	/// size now.
	pub total:    u64,
	/// Whether bytes may still arrive; for a file, whether the run goes on.
	pub open:     bool,
	/// The stream is a redirected file, read from disk.
	pub file:     bool,
	/// Trace key of the stage writing into the pipe, or of the command whose
	/// redirection opened the file; `None` without a trace to resolve it in.
	pub node:     Option<NodeKey>,
	/// When it was last written: a pipe's last write (its opening before
	/// any), a file's modification time (the epoch when unreadable).
	pub modified: SystemTime,
}

/// Retained bytes of one stream, as stream offsets `start..end`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipeStreamRead {
	pub start: u64,
	pub end:   u64,
	pub data:  Vec<u8>,
	pub open:  bool,
}

impl PipeTaps {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Every retained stream, oldest first.
	#[must_use]
	pub fn list(&self) -> Vec<PipeStreamInfo> {
		let (streams, files, ended) = {
			let inner = self.inner.lock();
			(inner.streams.clone(), inner.files.clone(), inner.ended)
		};
		let mut list: Vec<PipeStreamInfo> = streams
			.iter()
			.map(|stream| {
				let state = stream.state.lock();
				PipeStreamInfo {
					id:       stream.id,
					producer: stream.producer.clone(),
					consumer: stream.consumer.clone(),
					total:    state.total,
					open:     state.open,
					file:     false,
					node:     stream.node,
					modified: state.modified,
				}
			})
			.collect();
		list.extend(files.into_iter().map(|file| {
			let meta = fs::metadata(&file.path).ok();
			PipeStreamInfo {
				id:       file.id,
				total:    meta.as_ref().map_or(0, fs::Metadata::len),
				modified: meta
					.and_then(|meta| meta.modified().ok())
					.unwrap_or(SystemTime::UNIX_EPOCH),
				producer: file.command,
				consumer: file.path.to_string_lossy().into_owned(),
				open:     !ended,
				file:     true,
				node:     file.node,
			}
		}));
		list.sort_unstable_by_key(|stream| stream.id);
		list
	}

	/// The run ended: its redirected files report closed from now on. Pipes
	/// close on their own, when their last writer or reader goes.
	pub fn end(&self) {
		self.inner.lock().ended = true;
	}

	/// Retained bytes of stream `id` from stream offset `from` on (clamped to
	/// what is still retained), or all of them without `from`. `None` for an
	/// id this run never opened or no longer keeps.
	///
	/// A file's retained bytes are its last [`RETAINED_BYTES`]; a `from` past
	/// its end means it was rewritten since, and reads them all again. A file
	/// that is gone or unreadable reads as empty.
	#[must_use]
	pub fn read(&self, id: u32, from: Option<u64>) -> Option<PipeStreamRead> {
		let stream = {
			let inner = self.inner.lock();
			if let Some(file) = inner.files.iter().find(|file| file.id == id) {
				let (path, open) = (file.path.clone(), !inner.ended);
				drop(inner);
				return Some(read_file(&path, from, open));
			}
			inner
				.streams
				.iter()
				.find(|stream| stream.id == id)
				.cloned()?
		};
		let state = stream.state.lock();
		let retained_from = state.total - state.tail.len() as u64;
		let start = from.map_or(retained_from, |from| from.clamp(retained_from, state.total));
		let skip = usize::try_from(start - retained_from).unwrap_or(usize::MAX);
		Some(PipeStreamRead {
			start,
			end: state.total,
			data: state.tail.iter().skip(skip).copied().collect(),
			open: state.open,
		})
	}

	/// Tap a new pipe from stage `producer` to stage `consumer` (their source
	/// text), written by the trace node `node`: [`PipeTap::open`] with the
	/// writer's node already resolved. `None` once every slot is taken by an
	/// open stream.
	pub fn open_pipe(
		&self,
		producer: &BStr,
		consumer: &BStr,
		node: Option<NodeKey>,
	) -> Option<Arc<dyn PipeMirror>> {
		let mut inner = self.inner.lock();
		let mut finished = inner
			.streams
			.iter()
			.filter(|stream| !stream.state.lock().open)
			.count();
		// Make room by dropping the oldest finished streams: a slot for the new
		// stream, and room for it to finish without exceeding
		// MAX_FINISHED_STREAMS.
		while finished > 0 && (inner.streams.len() >= MAX_STREAMS || finished >= MAX_FINISHED_STREAMS)
		{
			let oldest = inner
				.streams
				.iter()
				.position(|stream| !stream.state.lock().open)?;
			inner.streams.remove(oldest);
			finished -= 1;
		}
		if inner.streams.len() >= MAX_STREAMS {
			return None;
		}
		inner.opened += 1;
		let stream = Arc::new(PipeStream {
			id: inner.opened,
			producer: producer.to_string(),
			consumer: consumer.to_string(),
			node,
			state: Mutex::new(StreamState {
				tail:     VecDeque::new(),
				total:    0,
				open:     true,
				modified: SystemTime::now(),
			}),
		});
		inner.streams.push(Arc::clone(&stream));
		Some(stream)
	}

	/// List the regular file at the absolute `path` that a redirection of
	/// `command` (its source text), trace node `node`, opened:
	/// [`PipeTap::file`] with the writer's node already resolved. A path
	/// listed before stays its first stream.
	pub fn add_file(&self, command: &BStr, path: &BStr, node: Option<NodeKey>) {
		let path = path.to_path_lossy().into_owned();
		// The engine's file may be a provider's (a URL path, a mount): only a
		// file of the host's own filesystem can be read back here.
		if !fs::metadata(&path).is_ok_and(|meta| meta.is_file()) {
			return;
		}
		let mut inner = self.inner.lock();
		// A file redirected into again (`>>` in a loop) stays the one stream.
		if inner.files.iter().any(|file| file.path == path) {
			return;
		}
		if inner.files.len() >= MAX_FILES {
			inner.files.remove(0);
		}
		inner.opened += 1;
		let id = inner.opened;
		inner
			.files
			.push(FileStream { id, command: command.to_string(), path, node });
	}
}

/// The last [`RETAINED_BYTES`] of the file at `path` from offset `from` on.
fn read_file(path: &Path, from: Option<u64>, open: bool) -> PipeStreamRead {
	let read = || -> io::Result<(u64, Vec<u8>)> {
		let mut file = File::open(path)?;
		let len = file.metadata()?.len();
		let retained_from = len.saturating_sub(RETAINED_BYTES as u64);
		let start = from
			.filter(|&from| from <= len)
			.map_or(retained_from, |from| from.max(retained_from));
		file.seek(SeekFrom::Start(start))?;
		let mut data = Vec::new();
		// Bounded by the size read above: a file growing meanwhile is caught
		// up on by the next read.
		file.take(len - start).read_to_end(&mut data)?;
		Ok((start, data))
	};
	let (start, data) = read().unwrap_or_default();
	PipeStreamRead { start, end: start + data.len() as u64, data, open }
}

/// Streams of a run without a trace: no stream names its writer's node.
impl PipeTap for PipeTaps {
	fn open(&self, producer: TapSite<'_>, consumer: &BStr) -> Option<Arc<dyn PipeMirror>> {
		self.open_pipe(producer.text, consumer, None)
	}

	fn file(&self, command: TapSite<'_>, path: &BStr) {
		self.add_file(command.text, path, None);
	}
}

impl PipeMirror for PipeStream {
	fn write(&self, bytes: &[u8]) {
		let mut state = self.state.lock();
		state.total += bytes.len() as u64;
		state.modified = SystemTime::now();
		let kept = &bytes[bytes.len().saturating_sub(RETAINED_BYTES)..];
		let overflow = (state.tail.len() + kept.len()).saturating_sub(RETAINED_BYTES);
		state.tail.drain(..overflow);
		state.tail.extend(kept);
	}

	fn close(&self) {
		self.state.lock().open = false;
	}
}

impl std::fmt::Debug for PipeTaps {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let inner = self.inner.lock();
		f.debug_struct("PipeTaps")
			.field("streams", &inner.streams.len())
			.field("files", &inner.files.len())
			.finish()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn finish(taps: &PipeTaps, bytes: &[u8]) -> u32 {
		let mirror = taps
			.open_pipe(BStr::new("producer"), BStr::new("consumer"), None)
			.expect("a free slot");
		mirror.write(bytes);
		mirror.close();
		taps.list().last().expect("the stream just opened").id
	}

	// Failure mode: a long-running producer grows the retained copy without
	// bound, or a reader resuming from its last offset gets bytes twice.
	#[test]
	fn keeps_the_newest_bytes_and_resumes_from_an_offset() {
		let taps = PipeTaps::new();
		let mirror = taps
			.open_pipe(BStr::new("yes"), BStr::new("head"), None)
			.expect("a free slot");
		mirror.write(&vec![b'a'; RETAINED_BYTES]);
		mirror.write(b"tail");

		let all = taps.read(1, None).expect("stream 1");
		assert_eq!(all.start, 4);
		assert_eq!(all.end, RETAINED_BYTES as u64 + 4);
		assert_eq!(all.data.len(), RETAINED_BYTES);
		assert!(all.data.ends_with(b"tail"));
		assert!(all.open);

		let since = taps.read(1, Some(all.end - 2)).expect("stream 1");
		assert_eq!(since.data, b"il");
		// An offset older than the retained bytes starts at the oldest kept.
		assert_eq!(taps.read(1, Some(0)).expect("stream 1").start, 4);
	}

	// Failure mode: a log read by offset repeats or drops lines once its file
	// is rewritten, or a command appending to one log lists it once per write.
	#[test]
	fn reads_a_redirected_file_from_disk_and_again_once_it_is_rewritten() {
		let dir = tempfile::tempdir().expect("log directory");
		let path = dir.path().join("build.log");
		fs::write(&path, "one\ntwo\n").expect("write log");
		let name = path.to_string_lossy().into_owned();
		let taps = PipeTaps::new();
		taps.add_file(BStr::new("make > build.log"), BStr::new(&name), None);
		taps.add_file(BStr::new("make >> build.log"), BStr::new(&name), None);

		assert_eq!(taps.list(), [PipeStreamInfo {
			id:       1,
			producer: "make > build.log".into(),
			consumer: name,
			total:    8,
			open:     true,
			file:     true,
			node:     None,
			modified: fs::metadata(&path)
				.and_then(|meta| meta.modified())
				.expect("log mtime"),
		}]);
		let all = taps.read(1, None).expect("stream 1");
		assert_eq!((all.start, all.end, all.data.as_slice()), (0, 8, b"one\ntwo\n".as_slice()));

		let mut log = File::options().append(true).open(&path).expect("open log");
		io::Write::write_all(&mut log, b"three\n").expect("append");
		assert_eq!(taps.read(1, Some(all.end)).expect("stream 1").data, b"three\n");

		// Shorter than the reader's offset: the file is a new one.
		fs::write(&path, "new\n").expect("rewrite log");
		let reread = taps.read(1, Some(14)).expect("stream 1");
		assert_eq!((reread.start, reread.data.as_slice()), (0, b"new\n".as_slice()));

		taps.end();
		assert!(!taps.list()[0].open);
		assert!(!taps.read(1, None).expect("stream 1").open);
	}

	// Failure mode: `2>/dev/null`, a directory or a provider's path the host
	// cannot read back shows up as a stream that never carries anything.
	#[test]
	fn lists_only_regular_host_files() {
		let dir = tempfile::tempdir().expect("directory");
		let taps = PipeTaps::new();
		for path in ["/dev/null", "skill://notes/out.txt", &dir.path().to_string_lossy()] {
			taps.add_file(BStr::new("cmd"), BStr::new(path), None);
		}
		assert!(taps.list().is_empty(), "listed: {:?}", taps.list());
	}

	// Failure mode: a loop of short pipelines either exhausts memory or, once
	// full, stops tapping the pipeline that is running now.
	#[test]
	fn drops_old_finished_streams_but_keeps_tapping_new_ones() {
		let taps = PipeTaps::new();
		let ids: Vec<u32> = (0..10).map(|_| finish(&taps, b"x")).collect();
		let kept: Vec<u32> = taps.list().iter().map(|stream| stream.id).collect();
		assert_eq!(kept, ids[ids.len() - MAX_FINISHED_STREAMS..]);
		assert!(taps.read(ids[0], None).is_none());
	}

	// Failure mode: open streams get evicted while still being read, or the
	// run spawns relays without limit.
	#[test]
	fn leaves_pipes_untapped_once_every_slot_is_open() {
		let taps = PipeTaps::new();
		let open: Vec<_> = (0..MAX_STREAMS)
			.map(|_| {
				taps
					.open_pipe(BStr::new("a"), BStr::new("b"), None)
					.expect("a free slot")
			})
			.collect();
		assert!(
			taps
				.open_pipe(BStr::new("a"), BStr::new("b"), None)
				.is_none()
		);
		open[0].close();
		assert!(
			taps
				.open_pipe(BStr::new("a"), BStr::new("b"), None)
				.is_some()
		);
		assert_eq!(taps.list().len(), MAX_STREAMS);
	}
}
