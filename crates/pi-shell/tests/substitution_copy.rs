//! `$(<file)` used to copy a file into a pipe that the caller drains on the
//! same runtime. These pin the ways that copy took a thread nothing could get
//! back — a Tokio worker parked inside `write`, a blocking-pool slot a
//! cancellation could not reclaim, a worker parked reading a stream with no
//! descriptor to show — that it streams rather than buffering a whole side,
//! and that it leaves the handles it is given exactly as it found them.
#![cfg(unix)]

use std::{
	future::Future,
	sync::{
		Arc, Mutex,
		atomic::{AtomicUsize, Ordering},
		mpsc,
	},
	time::Duration,
};

use async_trait::async_trait;
use brush_core::openfiles::{OpenFile, copy_async};
use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs `work` on a runtime with one worker and a blocking pool of exactly
/// `blocking_threads`, giving up after `limit`.
///
/// One worker is what turns a held worker into a stall instead of a slowdown.
/// A small blocking pool is what makes a thread the copy never gives back
/// visible: on a host-sized pool the same bug only shows under load, and the
/// Windows Node-API runtime this shell also runs under configures eight.
///
/// A run that never finishes leaves its thread behind on purpose: a parked
/// worker cannot be taken back.
fn on_single_worker<T: Send + 'static>(
	blocking_threads: usize,
	limit: Duration,
	work: impl Future<Output = T> + Send + 'static,
) -> Option<T> {
	let (result_tx, result_rx) = mpsc::sync_channel(1);
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(1)
			.max_blocking_threads(blocking_threads)
			.enable_all()
			.build()
			.expect("runtime");
		let _ = result_tx.send(runtime.block_on(work));
	});
	result_rx.recv_timeout(limit).ok()
}

async fn run(command: &str, cwd: &std::path::Path, deadline: Duration) -> pi_shell::ShellRunResult {
	Shell::new(None)
		.run(
			ShellRunOptions {
				command: command.to_owned(),
				cwd: Some(cwd.to_string_lossy().into_owned()),
				..Default::default()
			},
			None,
			CancelToken::with_timeout(Some(deadline)),
		)
		.await
		.expect("run")
}

fn scratch_file(dir: &std::path::Path, name: &str, bytes: usize) -> std::path::PathBuf {
	let path = dir.join(name);
	std::fs::write(&path, vec![b'x'; bytes]).expect("fixture file");
	path
}

/// A cancelled copy used to keep its blocking-pool thread until the descriptor
/// it was parked on unblocked — which, for a pipe nobody writes to, is never.
/// The next copy then had no thread to run on, so one abandoned `$(<fifo)`
/// disabled every later substitution.
#[test]
fn a_cancelled_copy_does_not_keep_the_thread_the_next_one_needs() {
	let outcome = on_single_worker(1, Duration::from_secs(10), async {
		let (idle_reader, idle_writer) = std::io::pipe().expect("pipe");
		let stalled = tokio::spawn(copy_async(
			OpenFile::from(idle_reader),
			OpenFile::from(tempfile::tempfile().expect("sink")),
		));
		// Let the copy reach its first read before taking it away.
		tokio::time::sleep(Duration::from_millis(100)).await;
		stalled.abort();
		let aborted = stalled.await.expect_err("aborted").is_cancelled();

		let (closed_reader, closed_writer) = std::io::pipe().expect("pipe");
		drop(closed_writer);
		let next = tokio::time::timeout(
			Duration::from_secs(1),
			copy_async(
				OpenFile::from(closed_reader),
				OpenFile::from(tempfile::tempfile().expect("sink")),
			),
		)
		.await;

		drop(idle_writer);
		(aborted, next.is_ok())
	})
	.expect("the runtime answered");

	assert_eq!(outcome, (true, true), "(the copy was abortable, the next copy ran)");
}

/// Two substitutions of a FIFO with an idle writer are cancelled by their own
/// deadlines. Whatever they were waiting on must not outlive them: an ordinary
/// substitution right afterwards has to work.
#[test]
fn abandoned_fifo_substitutions_leave_later_commands_alone() {
	let dir = tempfile::tempdir().expect("temp dir");
	let root = dir.path().to_path_buf();
	for name in ["idle0", "idle1"] {
		pi_vfs::BlockingFs::native()
			.make_node(root.join(name), pi_vfs::NodeKind::Fifo, 0o600)
			.expect("fifo");
	}
	scratch_file(&root, "small", 1 << 20);

	// Each writer opens its FIFO so the shell's own open succeeds, then never
	// writes: the read is what has to be given up.
	let writers: Vec<_> = ["idle0", "idle1"]
		.iter()
		.map(|name| {
			let (release_tx, release_rx) = mpsc::channel::<()>();
			let path = root.join(name);
			let handle = std::thread::spawn(move || {
				let _open = std::fs::OpenOptions::new()
					.write(true)
					.open(path)
					.expect("open fifo");
				let _ = release_rx.recv();
			});
			(release_tx, handle)
		})
		.collect();

	let cwd = root.clone();
	let outcome = on_single_worker(2, Duration::from_secs(20), async move {
		let first = run("value=$(<idle0)", &cwd, Duration::from_millis(350)).await;
		let second = run("value=$(<idle1)", &cwd, Duration::from_millis(350)).await;
		let third =
			run("value=$(<small); test ${#value} -eq 1048576", &cwd, Duration::from_secs(5)).await;
		(first.timed_out, second.timed_out, third.timed_out, third.exit_code)
	})
	.expect("the runtime answered");

	for (release, handle) in writers {
		let _ = release.send(());
		handle.join().expect("writer thread");
	}

	assert_eq!(
		outcome,
		(true, true, false, Some(0)),
		"(both idle reads gave up, the ordinary substitution still ran)"
	);
}

/// A non-async builtin stage of a pipeline already holds a blocking thread, and
/// the substitution inside it needs its own I/O. Offloading that copy made the
/// two fight over the same pool; an `eval` with a substitution piped into a
/// command is something a person types.
#[test]
fn a_substitution_inside_a_pipeline_builtin_completes() {
	let dir = tempfile::tempdir().expect("temp dir");
	let root = dir.path().to_path_buf();
	scratch_file(&root, "small", 1 << 20);

	let outcome = on_single_worker(1, Duration::from_secs(20), async move {
		let nested = run("eval 'value=$(<small)' | /bin/cat", &root, Duration::from_secs(5)).await;
		let after =
			run("value=$(<small); test ${#value} -eq 1048576", &root, Duration::from_secs(5)).await;
		(nested.timed_out, nested.exit_code, after.timed_out, after.exit_code)
	})
	.expect("the runtime answered");

	assert_eq!(
		outcome,
		(false, Some(0), false, Some(0)),
		"(the nested substitution ran, and left the next one able to run)"
	);
}

/// A FIFO source is read through the reactor rather than in place. The bytes a
/// writer sends in pieces must still all arrive, in order, and end at its
/// close.
#[test]
fn a_fifo_substitution_reads_every_byte() {
	const PIECES: usize = 16;
	const PIECE: usize = 64 * 1024;

	let dir = tempfile::tempdir().expect("temp dir");
	let root = dir.path().to_path_buf();
	let path = root.join("stream");
	pi_vfs::BlockingFs::native()
		.make_node(&path, pi_vfs::NodeKind::Fifo, 0o600)
		.expect("fifo");

	let writer = std::thread::spawn(move || {
		let mut fifo = std::fs::OpenOptions::new()
			.write(true)
			.open(&path)
			.expect("open fifo");
		for _ in 0..PIECES {
			std::io::Write::write_all(&mut fifo, &vec![b'x'; PIECE]).expect("write piece");
		}
	});

	let command = format!("value=$(<stream); test ${{#value}} -eq {}", PIECES * PIECE);
	let outcome = on_single_worker(1, Duration::from_secs(30), async move {
		let result = run(&command, &root, Duration::from_secs(20)).await;
		(result.timed_out, result.exit_code)
	})
	.expect("the runtime answered");

	writer.join().expect("writer thread");
	assert_eq!(outcome, (false, Some(0)), "(the whole stream arrived)");
}

/// `/dev/null` is a character device, so it is read on a thread of its own
/// rather than in place — a character device can be a terminal, and a terminal
/// waits for a person. An empty one still has to read as empty.
#[test]
fn a_character_device_substitution_reads_as_empty() {
	let dir = tempfile::tempdir().expect("temp dir");
	let root = dir.path().to_path_buf();

	let outcome = on_single_worker(1, Duration::from_secs(20), async move {
		let result =
			run("value=$(</dev/null); test -z \"$value\"", &root, Duration::from_secs(10)).await;
		(result.timed_out, result.exit_code)
	})
	.expect("the runtime answered");

	assert_eq!(outcome, (false, Some(0)), "(an empty character device read as empty)");
}

/// Reads one chunk, then waits for a permit before reading any more.
#[derive(Debug)]
struct GatedSource {
	bytes:  Arc<Vec<u8>>,
	offset: AtomicUsize,
	reads:  AtomicUsize,
	gate:   Arc<tokio::sync::Semaphore>,
}

#[async_trait]
impl pi_vfs::FileHandle for GatedSource {
	async fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
		if self.reads.fetch_add(1, Ordering::SeqCst) > 0 {
			self.gate.acquire().await.expect("gate").forget();
		}
		let offset = self.offset.load(Ordering::SeqCst);
		let count = buf.len().min(self.bytes.len().saturating_sub(offset));
		buf[..count].copy_from_slice(&self.bytes[offset..offset + count]);
		self.offset.store(offset + count, Ordering::SeqCst);
		Ok(count)
	}

	async fn write(&self, _buf: &[u8]) -> std::io::Result<usize> {
		Err(pi_vfs::unsupported("write"))
	}

	async fn seek(&self, _to: std::io::SeekFrom) -> std::io::Result<u64> {
		Err(pi_vfs::unsupported("seek"))
	}

	async fn metadata(&self) -> std::io::Result<pi_vfs::Metadata> {
		Err(pi_vfs::unsupported("metadata"))
	}
}

/// A copy with a provider-backed source and a native destination has to stream.
/// Reading the whole source before writing anything is not only slower to first
/// byte and larger in memory — with a source that produces its rest only after
/// its consumer has seen the start, it never finishes at all.
#[test]
fn a_virtual_source_reaches_a_native_pipe_before_it_is_fully_read() {
	const CHUNK: usize = 64 * 1024;

	let bytes = Arc::new(vec![b'q'; 4 * CHUNK]);
	let gate = Arc::new(tokio::sync::Semaphore::new(0));
	let drained = Arc::new(Mutex::new(Vec::new()));

	let (first_bytes_tx, first_bytes_rx) = mpsc::sync_channel::<()>(1);
	let (reader, writer) = std::io::pipe().expect("pipe");
	let collected = drained.clone();
	// Drain on its own thread: the point under test is the copy, not the drain.
	let drain = std::thread::spawn(move || {
		let mut reader = reader;
		let mut buf = vec![0u8; CHUNK];
		let mut announced = false;
		loop {
			let read = std::io::Read::read(&mut reader, &mut buf).expect("drain read");
			if read == 0 {
				break;
			}
			collected
				.lock()
				.expect("drained")
				.extend_from_slice(&buf[..read]);
			if !announced {
				announced = true;
				let _ = first_bytes_tx.send(());
			}
		}
	});

	let source = pi_vfs::File::from_handle(GatedSource {
		bytes:  bytes.clone(),
		offset: AtomicUsize::new(0),
		reads:  AtomicUsize::new(0),
		gate:   gate.clone(),
	});
	let released = gate.clone();
	let copied = on_single_worker(1, Duration::from_secs(20), async move {
		let copy = tokio::spawn(copy_async(OpenFile::from(source), OpenFile::from(writer)));
		// Only reached if the first chunk left the copy before the source was
		// read to its end.
		tokio::task::spawn_blocking(move || {
			first_bytes_rx
				.recv_timeout(Duration::from_secs(10))
				.expect("first bytes");
			released.add_permits(usize::MAX >> 4);
		})
		.await
		.expect("gate task");
		copy.await.expect("copy task").is_ok()
	})
	.expect("the copy streamed its first chunk");

	drain.join().expect("drain thread");
	assert!(copied, "the copy finished");
	assert_eq!(
		drained.lock().expect("drained").as_slice(),
		bytes.as_slice(),
		"every byte arrived, in order"
	);
}

/// A stream that answers `read` from a prefix first and a pipe afterwards.
///
/// `shows_descriptor` decides whether it lets a caller borrow the pipe's
/// descriptor. Neither answer licenses reading that descriptor instead of
/// calling `read`: showing one does not make the prefix go away, and hiding one
/// does not make the pipe stop waiting.
#[derive(Debug)]
struct PrefixedStream {
	prefix:           std::io::Cursor<Vec<u8>>,
	pipe:             Arc<Mutex<std::io::PipeReader>>,
	shows_descriptor: bool,
}

impl Clone for PrefixedStream {
	fn clone(&self) -> Self {
		Self {
			prefix:           self.prefix.clone(),
			pipe:             self.pipe.clone(),
			shows_descriptor: self.shows_descriptor,
		}
	}
}

impl std::io::Read for PrefixedStream {
	fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		let from_prefix = std::io::Read::read(&mut self.prefix, buf)?;
		if from_prefix > 0 {
			return Ok(from_prefix);
		}
		std::io::Read::read(&mut *self.pipe.lock().expect("pipe"), buf)
	}
}

impl std::io::Write for PrefixedStream {
	fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
		Err(std::io::ErrorKind::Unsupported.into())
	}

	fn flush(&mut self) -> std::io::Result<()> {
		Ok(())
	}
}

impl brush_core::openfiles::Stream for PrefixedStream {
	fn clone_box(&self) -> Box<dyn brush_core::openfiles::Stream> {
		Box::new(self.clone())
	}

	fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, brush_core::Error> {
		Err(std::io::Error::from(std::io::ErrorKind::Unsupported).into())
	}

	fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, brush_core::Error> {
		if !self.shows_descriptor {
			return Err(std::io::Error::from(std::io::ErrorKind::Unsupported).into());
		}
		// SAFETY: the descriptor belongs to `self.pipe`, which this stream keeps
		// alive, and the borrow cannot outlive `self`.
		Ok(unsafe {
			use std::os::fd::AsRawFd as _;
			std::os::fd::BorrowedFd::borrow_raw(self.pipe.lock().expect("pipe").as_raw_fd())
		})
	}
}

/// A stream with no descriptor to show, reading from a pipe whose writer comes
/// late.
///
/// Refusing `try_borrow_as_fd` says nothing about whether a `read` can wait:
/// reading such a stream in place parked the runtime's only worker, and the
/// task meant to feed it never ran. The sleep here runs on that same worker,
/// so it finishes only if the read left the worker alone.
#[test]
fn a_stream_with_no_descriptor_does_not_park_the_worker() {
	let (reader, mut writer) = std::io::pipe().expect("pipe");
	let source = PrefixedStream {
		prefix:           std::io::Cursor::new(Vec::new()),
		pipe:             Arc::new(Mutex::new(reader)),
		shows_descriptor: false,
	};

	let copied = on_single_worker(1, Duration::from_secs(20), async move {
		let copy = tokio::spawn(copy_async(
			OpenFile::Stream(Box::new(source)),
			OpenFile::from(tempfile::tempfile().expect("sink")),
		));
		tokio::time::sleep(Duration::from_millis(100)).await;
		// Only reached if the read left the worker free for this timer.
		std::io::Write::write_all(&mut writer, b"late").expect("write");
		drop(writer);
		copy.await.expect("copy task").is_ok()
	})
	.expect("the stream read held the runtime's only worker");

	assert!(copied, "the copy finished once its writer arrived");
}

/// A stream answers `read` for itself. Reading its descriptor instead skipped
/// everything the stream had already buffered.
#[test]
fn a_stream_keeps_its_own_read_contract() {
	let (reader, mut writer) = std::io::pipe().expect("pipe");
	std::io::Write::write_all(&mut writer, b"tail").expect("write");
	drop(writer);
	let source = PrefixedStream {
		prefix:           std::io::Cursor::new(b"prefix-".to_vec()),
		pipe:             Arc::new(Mutex::new(reader)),
		shows_descriptor: true,
	};

	let sink = tempfile::tempfile().expect("sink");
	let mut inspect = sink.try_clone().expect("sink handle");
	on_single_worker(1, Duration::from_secs(20), async move {
		copy_async(OpenFile::Stream(Box::new(source)), OpenFile::from(sink)).await
	})
	.expect("the runtime answered")
	.expect("copy");

	std::io::Seek::rewind(&mut inspect).expect("rewind");
	let mut got = String::new();
	std::io::Read::read_to_string(&mut inspect, &mut got).expect("read back");
	assert_eq!(got, "prefix-tail", "the stream's own prefix came through");
}

/// `std::io::Stdin` holds a line of input of its own. Reading its descriptor
/// instead lost whatever had already been buffered out of the pipe.
#[test]
fn a_buffered_standard_input_is_not_bypassed() {
	use std::os::fd::AsRawFd as _;

	let (reader, mut writer) = std::io::pipe().expect("pipe");
	std::io::Write::write_all(&mut writer, b"one\ntwo\n").expect("write");
	drop(writer);
	// SAFETY: replaces this test process's own standard input; nextest gives
	// each test a process of its own.
	assert_eq!(unsafe { libc::dup2(reader.as_raw_fd(), 0) }, 0);
	drop(reader);

	let mut first = String::new();
	std::io::BufRead::read_line(&mut std::io::stdin().lock(), &mut first).expect("first line");
	assert_eq!(first, "one\n", "the first line went into stdin's own buffer");

	let sink = tempfile::tempfile().expect("sink");
	let mut inspect = sink.try_clone().expect("sink handle");
	on_single_worker(1, Duration::from_secs(20), async move {
		copy_async(OpenFile::from(std::io::stdin()), OpenFile::from(sink)).await
	})
	.expect("the runtime answered")
	.expect("copy");

	std::io::Seek::rewind(&mut inspect).expect("rewind");
	let mut got = String::new();
	std::io::Read::read_to_string(&mut inspect, &mut got).expect("read back");
	assert_eq!(got, "two\n", "the buffered remainder came through");
}

/// Nothing a copy does may be visible through another descriptor duplicated
/// from the same `open`, **while it runs** and not only once it is over.
/// Setting `O_NONBLOCK` to poll one was: a child process holding the shell's
/// standard input saw `EAGAIN`, a second copy of the same handle failed
/// `WouldBlock`, and an abandoned copy left the flag behind.
#[test]
fn a_copy_leaves_the_descriptors_status_flags_alone() {
	fn flags(fd: &impl std::os::fd::AsRawFd) -> libc::c_int {
		// SAFETY: `F_GETFL` only reads, and the descriptor is open.
		unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) }
	}

	let (reader, mut writer) = std::io::pipe().expect("pipe");
	let observer = reader.try_clone().expect("second descriptor");
	let before = flags(&observer);
	assert_eq!(before, flags(&reader), "both descriptors start on the same description");

	let watched = observer.try_clone().expect("third descriptor");
	let sink = tempfile::tempfile().expect("sink");
	let during = on_single_worker(1, Duration::from_secs(20), async move {
		let copy = tokio::spawn(copy_async(OpenFile::from(reader), OpenFile::from(sink)));
		// The writer is still open, so the copy is waiting on the pipe here.
		tokio::time::sleep(Duration::from_millis(100)).await;
		let during = flags(&watched);
		std::io::Write::write_all(&mut writer, b"payload").expect("write");
		drop(writer);
		copy.await.expect("copy task").expect("copy");
		during
	})
	.expect("the runtime answered");

	assert_eq!(during, before, "the copy did not change the shared description while it ran");
	assert_eq!(flags(&observer), before, "nor did it leave anything behind");
	assert_eq!(during & libc::O_NONBLOCK, 0, "no other holder of this pipe sees EAGAIN");
}

/// A side that can wait for a peer runs on a thread of its own, and an
/// abandoned copy cannot take that thread back. Unbounded, that is the wedge
/// at a third address: 128 cancelled copies left 128 threads alive and
/// `std::thread::spawn` eventually panics. The bound has to refuse rather than
/// queue — queueing behind a read that may never end is the deadlock again.
#[test]
fn peer_waiting_copies_are_refused_at_their_bound() {
	let limit = brush_core::openfiles::DETACHED_SIDE_LIMIT;
	let mut writers = Vec::with_capacity(limit + 1);
	let mut readers = Vec::with_capacity(limit);
	for _ in 0..limit {
		let (reader, writer) = std::io::pipe().expect("pipe");
		writers.push(writer);
		readers.push(reader);
	}
	let (extra_reader, extra_writer) = std::io::pipe().expect("pipe");
	writers.push(extra_writer);

	let refusal = on_single_worker(1, Duration::from_secs(60), async move {
		let abandoned: Vec<_> = readers
			.into_iter()
			.map(|reader| {
				tokio::spawn(copy_async(
					OpenFile::from(reader),
					OpenFile::from(tempfile::tempfile().expect("sink")),
				))
			})
			.collect();
		// Let every copy reach its first read, then walk away from all of them.
		tokio::time::sleep(Duration::from_millis(200)).await;
		for task in &abandoned {
			task.abort();
		}
		for task in abandoned {
			let _ = task.await;
		}

		copy_async(OpenFile::from(extra_reader), OpenFile::from(tempfile::tempfile().expect("sink")))
			.await
			.err()
			.map(|error| error.kind())
	})
	.expect("the runtime answered");

	drop(writers);
	assert_eq!(
		refusal,
		Some(std::io::ErrorKind::ResourceBusy),
		"the copy past the bound is refused, not spawned"
	);
}

/// Sets `O_NONBLOCK` on a descriptor this test owns, which is the one thing
/// `copy_async` must never do to a handle it is given.
fn make_non_blocking(fd: &impl std::os::fd::AsRawFd) {
	// SAFETY: the descriptor is open and belongs to the caller.
	unsafe {
		let flags = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
		assert!(flags >= 0, "F_GETFL");
		assert_eq!(libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK), 0);
	}
}

/// A caller may hand the shell a descriptor that is **already** non-blocking.
/// `EAGAIN` from it means "not yet", not "failed": returning it made
/// `$(</dev/stdin)` on a non-blocking pipe fail where a blocking one waits.
#[test]
fn an_already_non_blocking_input_waits_instead_of_failing() {
	let (reader, mut writer) = std::io::pipe().expect("pipe");
	make_non_blocking(&reader);

	let sink = tempfile::tempfile().expect("sink");
	let mut inspect = sink.try_clone().expect("sink handle");
	on_single_worker(1, Duration::from_secs(20), async move {
		let copy = tokio::spawn(copy_async(OpenFile::from(reader), OpenFile::from(sink)));
		// The first read finds nothing; a blocking handle would wait here.
		tokio::time::sleep(Duration::from_millis(50)).await;
		std::io::Write::write_all(&mut writer, b"late").expect("write");
		drop(writer);
		copy.await.expect("copy task")
	})
	.expect("the runtime answered")
	.expect("the copy waited for its writer");

	std::io::Seek::rewind(&mut inspect).expect("rewind");
	let mut got = String::new();
	std::io::Read::read_to_string(&mut inspect, &mut got).expect("read back");
	assert_eq!(got, "late", "what arrived late still arrived");
}

/// The same on the writing side: a non-blocking pipe that fills has to be
/// waited on, not reported as an error after one buffer's worth.
#[test]
fn an_already_non_blocking_output_waits_instead_of_failing() {
	const BYTES: usize = 1 << 20;

	let dir = tempfile::tempdir().expect("temp dir");
	let path = scratch_file(dir.path(), "payload", BYTES);
	let source = std::fs::File::open(&path).expect("source");
	let (reader, writer) = std::io::pipe().expect("pipe");
	make_non_blocking(&writer);

	// Drains late, so the pipe fills first and the write finds it full.
	let drain = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(50));
		let mut reader = reader;
		let mut drained = Vec::new();
		std::io::Read::read_to_end(&mut reader, &mut drained).expect("drain");
		drained.len()
	});

	on_single_worker(1, Duration::from_secs(30), async move {
		copy_async(OpenFile::from(source), OpenFile::from(writer)).await
	})
	.expect("the runtime answered")
	.expect("the copy waited for its drain");

	assert_eq!(drain.join().expect("drain thread"), BYTES, "every byte went through");
}

/// Replaces the behavioural half of two scratch probes that pinned the
/// previous mechanism and are therefore gone: a destination that closes while
/// the copy is running must surface the error, a copy abandoned while it waits
/// must end at once and leave the descriptor as it was, and two copies of one
/// descriptor must both run without taking the worker. The mechanism half of
/// those probes — that a pending copy sets `O_NONBLOCK`, and that a retained
/// descriptor then reads `WouldBlock` — is what this change removed.
#[test]
fn a_destination_that_closes_mid_copy_surfaces_the_error() {
	const BYTES: usize = 8 << 20;

	let dir = tempfile::tempdir().expect("temp dir");
	let path = scratch_file(dir.path(), "payload", BYTES);
	let source = std::fs::File::open(&path).expect("source");
	let (reader, writer) = std::io::pipe().expect("pipe");

	// Takes one buffer and goes away, so the copy finds the far end gone.
	let peer = std::thread::spawn(move || {
		let mut reader = reader;
		let mut taken = vec![0u8; 4096];
		let read = std::io::Read::read(&mut reader, &mut taken).expect("peer read");
		drop(reader);
		read
	});

	let outcome = on_single_worker(1, Duration::from_secs(30), async move {
		copy_async(OpenFile::from(source), OpenFile::from(writer))
			.await
			.map_err(|error| error.kind())
	})
	.expect("the runtime answered");

	assert!(peer.join().expect("peer thread") > 0, "the peer took something first");
	assert_eq!(
		outcome,
		Err(std::io::ErrorKind::BrokenPipe),
		"a destination that went away is an error, not a silent stop"
	);
}

/// Abandoning a copy that is waiting has to end the wait for the caller at
/// once — the thread it leaves behind is the documented cost, not a delay the
/// caller sees — and it must leave the descriptor exactly as it was.
#[test]
fn an_abandoned_copy_ends_at_once_and_leaves_its_descriptor_alone() {
	fn flags(fd: &impl std::os::fd::AsRawFd) -> libc::c_int {
		// SAFETY: `F_GETFL` only reads, and the descriptor is open.
		unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) }
	}

	let (reader, writer) = std::io::pipe().expect("pipe");
	let observer = reader.try_clone().expect("second descriptor");
	let before = flags(&observer);

	let elapsed = on_single_worker(1, Duration::from_secs(20), async move {
		let copy = tokio::spawn(copy_async(
			OpenFile::from(reader),
			OpenFile::from(tempfile::tempfile().expect("sink")),
		));
		tokio::time::sleep(Duration::from_millis(50)).await;
		let started = std::time::Instant::now();
		copy.abort();
		assert!(copy.await.expect_err("aborted").is_cancelled());
		started.elapsed()
	})
	.expect("the runtime answered");

	drop(writer);
	assert!(elapsed < Duration::from_millis(100), "the caller waited {elapsed:?} for the abort");
	assert_eq!(flags(&observer), before, "the abandoned copy left the description as it was");
}

/// Two copies of one descriptor, both waiting, must both finish and neither
/// may take the worker: the timer below runs on it.
#[test]
fn two_copies_of_one_descriptor_both_run() {
	let (reader, mut writer) = std::io::pipe().expect("pipe");
	let second = reader.try_clone().expect("second descriptor");

	let (fired, bytes) = on_single_worker(1, Duration::from_secs(20), async move {
		let first = tokio::spawn(copy_async(
			OpenFile::from(reader),
			OpenFile::from(tempfile::tempfile().expect("sink")),
		));
		let other = tokio::spawn(copy_async(
			OpenFile::from(second),
			OpenFile::from(tempfile::tempfile().expect("sink")),
		));
		let heartbeat = tokio::spawn(async {
			tokio::time::sleep(Duration::from_millis(40)).await;
			true
		});
		let fired = heartbeat.await.expect("heartbeat");
		std::io::Write::write_all(&mut writer, b"shared").expect("write");
		drop(writer);
		let outcomes = (first.await.expect("first"), other.await.expect("other"));
		(fired, outcomes.0.is_ok() && outcomes.1.is_ok())
	})
	.expect("the runtime answered");

	assert!(fired, "a timer on the same worker still ran while both copies waited");
	assert!(bytes, "both copies of the one descriptor finished");
}

/// A `poll` that can never succeed must end the copy, not be read as
/// readiness. With the soft descriptor limit lowered under it, `poll` fails
/// with `EINVAL` on every call; treating that as "ready" turned the copy into
/// a loop that made a quarter of a million read attempts in a tenth of a
/// second and as many again after its caller had walked away.
#[test]
fn a_polling_failure_ends_the_copy() {
	/// Replaces the soft descriptor limit and returns what was there.
	fn set_descriptor_limit(soft: u64) -> libc::rlimit {
		// SAFETY: `getrlimit`/`setrlimit` touch only the `rlimit` they are
		// given, and nextest gives this test a process of its own.
		unsafe {
			let mut saved = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
			assert_eq!(libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut saved), 0);
			let replaced = libc::rlimit { rlim_cur: soft, rlim_max: saved.rlim_max };
			assert_eq!(libc::setrlimit(libc::RLIMIT_NOFILE, &raw const replaced), 0);
			saved
		}
	}

	// Everything this test needs a descriptor for is opened before the limit
	// goes down, because afterwards nothing else can be — the runtime included.
	let (reader, writer) = std::io::pipe().expect("pipe");
	make_non_blocking(&reader);
	let sink = tempfile::tempfile().expect("sink");

	let outcome = on_single_worker(1, Duration::from_secs(20), async move {
		let saved = set_descriptor_limit(0);
		let outcome = copy_async(OpenFile::from(reader), OpenFile::from(sink))
			.await
			.map_err(|error| error.kind());
		// SAFETY: as above; restores what this test lowered.
		unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const saved) };
		outcome
	})
	.expect("the copy spun instead of ending");

	drop(writer);
	assert!(outcome.is_err(), "a polling failure is surfaced, not retried for ever: {outcome:?}");
}

/// The scratch socket probe also checked that a payload arrives whole through
/// EOF, which the replacement above does not; this is that half.
#[test]
fn a_socket_source_delivers_its_payload_through_eof() {
	const BYTES: usize = 512 * 1024;

	let (near, far) = std::os::unix::net::UnixStream::pair().expect("socket pair");
	let sender = std::thread::spawn(move || {
		let mut far = far;
		std::io::Write::write_all(&mut far, &vec![b'q'; BYTES]).expect("send");
		drop(far);
	});

	let sink = tempfile::tempfile().expect("sink");
	let mut inspect = sink.try_clone().expect("sink handle");
	on_single_worker(1, Duration::from_secs(30), async move {
		copy_async(
			OpenFile::from(std::fs::File::from(std::os::fd::OwnedFd::from(near))),
			OpenFile::from(sink),
		)
		.await
	})
	.expect("the runtime answered")
	.expect("copy");

	sender.join().expect("sender thread");
	std::io::Seek::rewind(&mut inspect).expect("rewind");
	let mut got = Vec::new();
	std::io::Read::read_to_end(&mut inspect, &mut got).expect("read back");
	assert_eq!(got, vec![b'q'; BYTES], "every byte arrived, and the copy ended at EOF");
}

/// The scratch shared-descriptor probe also cancelled one copy while the other
/// stayed pending; this is that half. Abandoning one must leave the other
/// waiting and able to finish.
#[test]
fn cancelling_one_copy_leaves_the_other_pending() {
	let (reader, mut writer) = std::io::pipe().expect("pipe");
	let second = reader.try_clone().expect("second descriptor");

	let survived = on_single_worker(1, Duration::from_secs(20), async move {
		let abandoned = tokio::spawn(copy_async(
			OpenFile::from(reader),
			OpenFile::from(tempfile::tempfile().expect("sink")),
		));
		let kept = tokio::spawn(copy_async(
			OpenFile::from(second),
			OpenFile::from(tempfile::tempfile().expect("sink")),
		));
		tokio::time::sleep(Duration::from_millis(50)).await;
		abandoned.abort();
		assert!(abandoned.await.expect_err("aborted").is_cancelled());
		assert!(!kept.is_finished(), "the other copy is still waiting");
		std::io::Write::write_all(&mut writer, b"shared").expect("write");
		drop(writer);
		kept.await.expect("kept").is_ok()
	})
	.expect("the runtime answered");

	assert!(survived, "the copy that was not cancelled finished");
}
