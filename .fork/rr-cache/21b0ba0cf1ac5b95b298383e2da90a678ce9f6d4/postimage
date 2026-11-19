//! Off-thread terminal output pump.
//!
//! A terminal write on the JS thread blocks the event loop until the terminal
//! drains, so a slow or occluded emulator froze the TUI for the length of a
//! repaint. [`TtyWriter`] moves that work to a dedicated thread:
//!
//! - JS copies each string's UTF-16 into a pooled batch ([`TtyWriter::write`]);
//!   no UTF-8 sizing or transcoding happens on its thread.
//! - The worker transcodes one bounded chunk at a time and writes it through
//!   its own handle to the terminal (see [`sys`]):
//!   - unix: an independently opened, nonblocking descriptor for the same TTY,
//!     so stdout's own file-status flags are never touched.
//!   - Windows: a duplicate of the console handle. Each chunk is one
//!     `WriteFile` of at most 16 KiB, below the size at which `ConPTY` hosts
//!     lose viewport tracking, preceded by a repair of the UTF-8 console code
//!     pages that console-sharing children flip.
//! - [`TtyWriter::pending`] is a conservative UTF-8 bound (three bytes per
//!   queued code unit), tightened as chunks are encoded and written. Crossing
//!   the drain threshold, or a fatal write error, notifies JS.
//! - [`TtyWriter::stop`] wakes the queue wait, cancels a blocked write (unix: a
//!   `POLLOUT` wait; Windows: `CancelSynchronousIo`), and joins the worker:
//!   nothing is written after it returns. The one exception is a Windows
//!   console that refuses to abort a `WriteFile`; that single chunk completes
//!   on the detached worker, like bytes a unix kernel had already accepted.

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread::JoinHandle,
	time::{Duration, Instant},
};

use napi::{
	Error, JsString, Result, Status,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use parking_lot::{Condvar, Mutex};

use crate::js;

/// Also the per-`WriteFile` cap for `ConPTY` hosts, which lose viewport
/// tracking on larger writes (`MAX_CONPTY_WRITE_CHUNK_BYTES` in pi-tui's
/// terminal.ts).
const MAX_TTY_WRITE_CHUNK_BYTES: usize = 16 * 1024;
// At most two normal-sized UTF-16 batches survive a drain. A large repaint or
// a burst of tiny writes must not permanently enlarge either reusable buffer.
const MAX_RETAINED_UNITS: usize = 256 * 1024;
const MAX_RETAINED_FRAMES: usize = 4096;

type DrainCallback = ThreadsafeFunction<(), (), (), Status, false, true>;

enum DrainNotifier {
	Js(DrainCallback),
	#[cfg(test)]
	Test(Arc<std::sync::atomic::AtomicUsize>),
}

impl DrainNotifier {
	fn notify(&self) {
		match self {
			Self::Js(callback) => {
				// Weak TSFN: does not keep the event loop alive. An unlimited NAPI
				// queue makes this nonblocking without dropping threshold edges.
				let _ = callback.call((), ThreadsafeFunctionCallMode::NonBlocking);
			},
			#[cfg(test)]
			Self::Test(count) => {
				count.fetch_add(1, Ordering::AcqRel);
			},
		}
	}
}

#[derive(Default)]
struct Batch {
	units: Vec<u16>,
	/// Each write is an independent JS string: never join its trailing high
	/// surrogate to the next string's leading low surrogate.
	ends:  Vec<usize>,
}

impl Batch {
	fn clear(&mut self) {
		self.units.clear();
		self.ends.clear();
		if self.units.capacity() > MAX_RETAINED_UNITS {
			self.units = Vec::new();
		}
		if self.ends.capacity() > MAX_RETAINED_FRAMES {
			self.ends = Vec::new();
		}
	}
}

#[derive(Default)]
struct Queue {
	back:    Batch,
	pending: usize,
}

struct Inner {
	queue:           Mutex<Queue>,
	/// All predicate changes and condvar waits hold queue, including stop and
	/// partial progress, so neither idle stop nor flush can lose a wakeup.
	cv:              Condvar,
	cancelled:       AtomicBool,
	dead:            AtomicBool,
	drain_threshold: usize,
}

impl Inner {
	fn new(drain_threshold: u32) -> Self {
		Self {
			queue:           Mutex::new(Queue::default()),
			cv:              Condvar::new(),
			cancelled:       AtomicBool::new(false),
			dead:            AtomicBool::new(false),
			drain_threshold: drain_threshold as usize,
		}
	}

	fn progress(&self, bytes: usize, notifier: &DrainNotifier) {
		if bytes == 0 {
			return;
		}
		let crossed = {
			let mut queue = self.queue.lock();
			let before = queue.pending;
			queue.pending -= bytes;
			if queue.pending == 0 {
				self.cv.notify_all();
			}
			before > self.drain_threshold && queue.pending <= self.drain_threshold
		};
		if crossed {
			notifier.notify();
		}
	}

	fn finish(&self, failed: bool, notifier: &DrainNotifier) {
		let crossed = {
			let mut queue = self.queue.lock();
			if failed {
				self.dead.store(true, Ordering::Release);
			}
			let crossed = queue.pending > self.drain_threshold;
			queue.pending = 0;
			queue.back = Batch::default();
			self.cv.notify_all();
			crossed
		};
		// A fatal write must wake JS even if there never was backpressure.
		if failed || crossed {
			notifier.notify();
		}
	}
}

const fn pending_number(bytes: usize) -> f64 {
	// JS numbers represent every practical queue size exactly. Do not clamp
	// a large queue to u32::MAX: that would cease to be an upper bound.
	if bytes as u128 > (1u128 << 53) - 1 {
		f64::INFINITY
	} else {
		bytes as f64
	}
}

#[derive(Default)]
struct EncodeCursor {
	unit:    usize,
	frame:   usize,
	/// End of the current surrogate-free UTF-16 span.
	bmp_end: usize,
}

/// Fill one bounded output buffer, coalescing independent small writes without
/// coalescing their Unicode boundaries. Returns (UTF-16 units read, UTF-8
/// bytes).
fn encode_chunk(batch: &Batch, cursor: &mut EncodeCursor, output: &mut [u8]) -> (usize, usize) {
	let start = cursor.unit;
	let mut written = 0;
	while cursor.frame < batch.ends.len() && output.len() - written >= char::MAX_LEN_UTF8 {
		let frame_end = batch.ends[cursor.frame];
		if cursor.unit == frame_end {
			cursor.frame += 1;
			continue;
		}
		if cursor.unit >= cursor.bmp_end {
			let end = (cursor.unit + MAX_TTY_WRITE_CHUNK_BYTES).min(frame_end);
			if batch.units[cursor.unit..end]
				.iter()
				.any(|unit| unit & 0xf800 == 0xd800)
			{
				// xutf is permissive on malformed surrogates and its mixed-pair
				// path is slower than std. Decode only this independent string;
				// the output budget bounds work without splitting a valid pair.
				let mut decoder =
					char::decode_utf16(batch.units[cursor.unit..frame_end].iter().copied());
				while output.len() - written >= char::MAX_LEN_UTF8 {
					let Some(decoded) = decoder.next() else { break };
					let ch = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
					cursor.unit += ch.len_utf16();
					written += ch.encode_utf8(&mut output[written..]).len();
				}
				continue;
			}
			cursor.bmp_end = end;
		}
		let (read, bytes) = xutf::transcode_into::<xutf::Utf16, xutf::Utf8>(
			&batch.units[cursor.unit..cursor.bmp_end],
			&mut output[written..],
			xutf::AsciiCase::Preserve,
		);
		cursor.unit += read;
		written += bytes;
	}
	(cursor.unit - start, written)
}

fn cancelled_error() -> std::io::Error {
	std::io::ErrorKind::ConnectionAborted.into()
}

fn write_all_with(
	mut write: impl FnMut(&[u8]) -> std::io::Result<usize>,
	buf: &[u8],
	mut on_progress: impl FnMut(usize),
) -> std::io::Result<()> {
	let mut offset = 0;
	while offset < buf.len() {
		let end = (offset + MAX_TTY_WRITE_CHUNK_BYTES).min(buf.len());
		match write(&buf[offset..end]) {
			Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
			Ok(written) => {
				offset += written;
				on_progress(written);
			},
			Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {},
			Err(err) => return Err(err),
		}
	}
	Ok(())
}

fn pump_loop(output: sys::Output, inner: &Inner, notifier: DrainNotifier) {
	let mut front = Batch::default();
	let mut buf = [0u8; MAX_TTY_WRITE_CHUNK_BYTES];
	loop {
		{
			let mut queue = inner.queue.lock();
			while queue.back.units.is_empty() && !inner.cancelled.load(Ordering::Acquire) {
				inner.cv.wait(&mut queue);
			}
			if inner.cancelled.load(Ordering::Acquire) {
				drop(queue);
				inner.finish(false, &notifier);
				return;
			}
			std::mem::swap(&mut queue.back, &mut front);
		}
		let mut cursor = EncodeCursor::default();
		while cursor.unit < front.units.len() {
			if inner.cancelled.load(Ordering::Acquire) {
				inner.finish(false, &notifier);
				return;
			}
			let (units, bytes) = encode_chunk(&front, &mut cursor, &mut buf);
			// UTF-16 needs at most three UTF-8 bytes per code unit. Once encoded,
			// only actual bytes remain outstanding, including partial writes.
			inner.progress(units * 3 - bytes, &notifier);
			let written = write_all_with(
				|chunk| {
					if inner.cancelled.load(Ordering::Acquire) {
						return Err(cancelled_error());
					}
					output.write(chunk)
				},
				&buf[..bytes],
				|bytes| inner.progress(bytes, &notifier),
			);
			if written.is_err() {
				inner.finish(!inner.cancelled.load(Ordering::Acquire), &notifier);
				return;
			}
		}
		front.clear();
	}
}

/// Platform terminal handles. Each backend provides `open(fd)`, returning the
/// worker's `Output` and the stopping side's `Cancel`; `Output::write` makes
/// one write attempt that blocks until the terminal accepts bytes or
/// `Cancel::stop` aborts it.
#[cfg(unix)]
mod sys {
	use std::{
		io,
		os::{
			fd::{AsRawFd, FromRawFd, OwnedFd},
			unix::net::UnixStream,
		},
		thread::JoinHandle,
	};

	use super::cancelled_error;

	/// Worker side: the reopened TTY and the cancellation socket's read end.
	pub(super) struct Output {
		tty:    OwnedFd,
		cancel: UnixStream,
	}

	/// Stopping side: the cancellation socket's write end. Closing it wakes a
	/// `POLLOUT` wait without writes, `SIGPIPE`, or a potentially full pipe.
	pub(super) struct Cancel(pub(super) UnixStream);

	pub(super) fn open(fd: i32) -> io::Result<(Output, Cancel)> {
		let tty = reopen_tty(fd)?;
		// UnixStream::pair owns close-on-exec endpoints.
		let (cancel, stop) = UnixStream::pair()?;
		Ok((Output { tty, cancel }, Cancel(stop)))
	}

	impl Output {
		pub(super) fn write(&self, chunk: &[u8]) -> io::Result<usize> {
			loop {
				// SAFETY: chunk is initialized storage and the descriptor is
				// worker-owned and nonblocking. No original stdout flags are
				// shared.
				let rc =
					unsafe { libc::write(self.tty.as_raw_fd(), chunk.as_ptr().cast(), chunk.len()) };
				if rc >= 0 {
					return Ok(rc as usize);
				}
				let err = io::Error::last_os_error();
				if err.kind() != io::ErrorKind::WouldBlock {
					return Err(err);
				}
				self.wait_writable()?;
			}
		}

		fn wait_writable(&self) -> io::Result<()> {
			let mut fds = [
				libc::pollfd { fd: self.tty.as_raw_fd(), events: libc::POLLOUT, revents: 0 },
				libc::pollfd { fd: self.cancel.as_raw_fd(), events: libc::POLLIN, revents: 0 },
			];
			loop {
				// SAFETY: fds contains two valid poll entries; the worker owns
				// both.
				let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, -1) };
				if result > 0 {
					// The peer closes on stop: POLLHUP even if it raced this poll.
					if fds[1].revents != 0 {
						return Err(cancelled_error());
					}
					if fds[0].revents & libc::POLLNVAL != 0 {
						return Err(io::Error::from_raw_os_error(libc::EBADF));
					}
					if fds[0].revents & (libc::POLLERR | libc::POLLHUP) != 0 {
						return Err(io::ErrorKind::BrokenPipe.into());
					}
					if fds[0].revents & libc::POLLOUT != 0 {
						return Ok(());
					}
				} else if result < 0 {
					let err = io::Error::last_os_error();
					if err.kind() != io::ErrorKind::Interrupted {
						return Err(err);
					}
				}
			}
		}
	}

	impl Cancel {
		/// Abort a blocked write and join the worker.
		pub(super) fn stop(self, thread: JoinHandle<()>) {
			drop(self.0);
			let _ = thread.join();
		}
	}

	pub(super) fn reopen_tty(fd: i32) -> io::Result<OwnedFd> {
		let mut original = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: fd is only inspected; original is valid storage for fstat.
		if unsafe { libc::fstat(fd, original.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: fstat succeeded.
		let original = unsafe { original.assume_init() };
		// SAFETY: isatty only inspects the caller-owned descriptor.
		if unsafe { libc::isatty(fd) } != 1 {
			return Err(io::Error::last_os_error());
		}
		let mut name = [0 as libc::c_char; libc::PATH_MAX as usize];
		#[cfg(target_os = "macos")]
		{
			// ttyname_r scans the device-name cache on Darwin and can return
			// ERANGE for a newly allocated PTY even with PATH_MAX storage.
			// F_GETPATH asks the kernel for this descriptor's path instead;
			// open/fstat below still reject non-TTY or mismatched devices.
			// SAFETY: fd is inspected and name provides PATH_MAX writable bytes.
			if unsafe { libc::fcntl(fd, libc::F_GETPATH, name.as_mut_ptr()) } == -1 {
				return Err(io::Error::last_os_error());
			}
		}
		#[cfg(not(target_os = "macos"))]
		{
			// SAFETY: name is valid writable storage. ttyname_r rejects non-TTYs.
			let rc = unsafe { libc::ttyname_r(fd, name.as_mut_ptr(), name.len()) };
			if rc != 0 {
				return Err(io::Error::from_raw_os_error(rc));
			}
		}
		// SAFETY: successful ttyname_r NUL-terminates name.
		let path = unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) };
		// Reopening a clone-device master would allocate a *different* PTY even
		// though its stat identity matches. Only actual terminal destinations
		// work.
		if matches!(path.to_bytes(), b"/dev/ptmx" | b"/dev/pts/ptmx") {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "PTY masters cannot be reopened"));
		}
		// A dup shares O_NONBLOCK with stdout. Opening its actual TTY path gives
		// this worker independent status flags; never substitute /dev/tty.
		// SAFETY: name is a valid C string; flags require no variadic mode
		// argument.
		let opened = unsafe {
			libc::open(
				name.as_ptr(),
				libc::O_WRONLY | libc::O_NONBLOCK | libc::O_NOCTTY | libc::O_CLOEXEC,
			)
		};
		if opened < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: open returned a new descriptor, uniquely owned here.
		let owned = unsafe { OwnedFd::from_raw_fd(opened) };
		let mut reopened = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: owned is live and reopened is valid fstat storage.
		if unsafe { libc::fstat(owned.as_raw_fd(), reopened.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: fstat succeeded.
		let reopened = unsafe { reopened.assume_init() };
		if original.st_dev != reopened.st_dev
			|| original.st_ino != reopened.st_ino
			|| original.st_rdev != reopened.st_rdev
		{
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"TTY destination changed while reopening",
			));
		}
		Ok(owned)
	}
}

#[cfg(windows)]
mod sys {
	use std::{
		io,
		os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
		sync::atomic::{AtomicU32, Ordering},
		thread::JoinHandle,
		time::{Duration, Instant},
	};

	use windows_sys::Win32::{
		Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, FALSE, INVALID_HANDLE_VALUE},
		Storage::FileSystem::WriteFile,
		System::{
			Console::{
				GetConsoleCP, GetConsoleMode, GetConsoleOutputCP, GetStdHandle, STD_ERROR_HANDLE,
				STD_OUTPUT_HANDLE, SetConsoleCP, SetConsoleOutputCP,
			},
			IO::CancelSynchronousIo,
			Threading::GetCurrentProcess,
		},
	};

	const CP_UTF8: u32 = 65001;

	/// How long `stop` keeps cancelling a `WriteFile` before detaching the
	/// worker. It checks the cancelled flag before every write, so a write that
	/// ignores cancellation is its last.
	const CANCEL_TIMEOUT: Duration = Duration::from_millis(500);

	/// Last foreign output code page reported, so a child that keeps flipping
	/// it warns once.
	static WARNED_CODE_PAGE: AtomicU32 = AtomicU32::new(0);

	/// Worker side: a duplicate of the console handle, so closing or replacing
	/// the process's stdout cannot invalidate a blocked write.
	pub(super) struct Output(OwnedHandle);

	/// Stopping side: synchronous writes are aborted through the worker's
	/// thread handle, so there is nothing to hold.
	pub(super) struct Cancel;

	pub(super) fn open(fd: i32) -> io::Result<(Output, Cancel)> {
		let which = match fd {
			1 => STD_OUTPUT_HANDLE,
			2 => STD_ERROR_HANDLE,
			_ => {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					"only fds 1 and 2 have console handles",
				));
			},
		};
		// SAFETY: plain query.
		let handle = unsafe { GetStdHandle(which) };
		if handle == INVALID_HANDLE_VALUE {
			return Err(io::Error::last_os_error());
		}
		if handle.is_null() {
			return Err(io::Error::new(io::ErrorKind::NotFound, "no standard handle"));
		}
		let mut mode = 0;
		// Consoles only, as unix accepts only TTYs: pipes (mintty, redirection)
		// and files are rejected.
		// SAFETY: handle is a live standard handle and mode is valid storage.
		if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
			return Err(io::Error::last_os_error());
		}
		let mut owned = std::ptr::null_mut();
		// SAFETY: both process handles are the current-process pseudo handle,
		// and owned is valid storage for the new handle.
		let ok = unsafe {
			DuplicateHandle(
				GetCurrentProcess(),
				handle,
				GetCurrentProcess(),
				&mut owned,
				0,
				FALSE,
				DUPLICATE_SAME_ACCESS,
			)
		};
		if ok == 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: DuplicateHandle returned a new handle, uniquely owned here.
		Ok((Output(unsafe { OwnedHandle::from_raw_handle(owned) }), Cancel))
	}

	impl Output {
		pub(super) fn write(&self, chunk: &[u8]) -> io::Result<usize> {
			ensure_utf8_code_pages();
			let mut written = 0;
			// SAFETY: the handle is worker-owned and live; chunk is initialized
			// and at most MAX_TTY_WRITE_CHUNK_BYTES long; no OVERLAPPED, so the
			// write is synchronous and CancelSynchronousIo can abort it.
			let ok = unsafe {
				WriteFile(
					self.0.as_raw_handle(),
					chunk.as_ptr(),
					chunk.len() as u32,
					&mut written,
					std::ptr::null_mut(),
				)
			};
			if ok == 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(written as usize)
		}
	}

	impl Cancel {
		/// Abort a blocked write and join the worker. A cancel that lands just
		/// before the worker's next `WriteFile` finds nothing to abort, so it
		/// repeats until the worker sees the cancelled flag and exits.
		#[expect(clippy::unused_self, reason = "the unix variant closes its wake socket")]
		pub(super) fn stop(self, thread: JoinHandle<()>) {
			let deadline = Instant::now() + CANCEL_TIMEOUT;
			while !thread.is_finished() {
				if Instant::now() >= deadline {
					log::warn!("tty writer: console write ignored cancellation; detaching worker");
					return;
				}
				// SAFETY: the thread handle stays live until join or drop. With no
				// synchronous I/O pending, this fails harmlessly.
				unsafe { CancelSynchronousIo(thread.as_raw_handle()) };
				std::thread::sleep(Duration::from_millis(1));
			}
			let _ = thread.join();
		}
	}

	/// Re-assert the UTF-8 console code pages before a write.
	///
	/// `WriteFile` bytes are decoded with the console's *current* output code
	/// page. Children sharing the console (bash commands, MCP/LSP servers, eval
	/// kernels) can change it: PHP >= 7.1 CLI switches it to match
	/// `internal_encoding` and skips the restore when killed (php.net request
	/// #73716). From then on every non-ASCII glyph renders as OEM mojibake
	/// (`Γöé` for `│`). A reading of 0 means no console and is left alone.
	fn ensure_utf8_code_pages() {
		// SAFETY: plain console calls without pointers.
		unsafe {
			let output = GetConsoleOutputCP();
			if output != 0 && output != CP_UTF8 {
				SetConsoleOutputCP(CP_UTF8);
				if WARNED_CODE_PAGE.swap(output, Ordering::Relaxed) != output {
					log::warn!(
						"console output code page {output} set by a child process; restored UTF-8"
					);
				}
			}
			let input = GetConsoleCP();
			if input != 0 && input != CP_UTF8 {
				SetConsoleCP(CP_UTF8);
			}
		}
	}
}

struct Worker {
	thread: JoinHandle<()>,
	cancel: sys::Cancel,
}

/// Dedicated, cancellable terminal writer. The destination must be a TTY that
/// can be independently reopened (unix) or a console (Windows); pipes and
/// files are deliberately rejected.
#[napi]
pub struct TtyWriter {
	inner:  Arc<Inner>,
	/// `None` once stopped.
	worker: Option<Worker>,
}

impl TtyWriter {
	fn start(fd: i32, drain_threshold: u32, notifier: DrainNotifier) -> Result<Self> {
		let (output, cancel) = sys::open(fd)
			.map_err(|err| Error::from_reason(format!("opening tty fd {fd} failed: {err}")))?;
		let inner = Arc::new(Inner::new(drain_threshold));
		let thread_inner = Arc::clone(&inner);
		let thread = std::thread::Builder::new()
			.name("tty-writer".into())
			.spawn(move || pump_loop(output, &thread_inner, notifier))
			.map_err(|err| Error::from_reason(format!("tty writer thread spawn failed: {err}")))?;
		// Every handle is RAII-owned, including inside a failed spawn.
		Ok(Self { inner, worker: Some(Worker { thread, cancel }) })
	}

	fn enqueue(&self, fill: impl FnOnce(&mut Vec<u16>) -> Result<()>) -> Result<f64> {
		let mut queue = self.inner.queue.lock();
		if self.inner.dead.load(Ordering::Acquire) || self.inner.cancelled.load(Ordering::Acquire) {
			return Ok(pending_number(queue.pending));
		}
		let start = queue.back.units.len();
		if let Err(err) = fill(&mut queue.back.units) {
			queue.back.units.truncate(start);
			return Err(err);
		}
		let end = queue.back.units.len();
		if end != start {
			let Some(pending) = (end - start)
				.checked_mul(3)
				.and_then(|n| queue.pending.checked_add(n))
			else {
				queue.back.units.truncate(start);
				return Err(Error::from_reason("TTY pending byte bound overflow"));
			};
			queue.back.ends.push(end);
			queue.pending = pending;
			self.inner.cv.notify_all();
		}
		// Publish accounting before releasing the queue: the worker cannot
		// subtract newly accepted units before they have been counted.
		Ok(pending_number(queue.pending))
	}
}

#[napi]
impl TtyWriter {
	/// Start a writer on its own handle to the terminal. onDrain runs when the
	/// pending bound crosses from above drainThreshold to at/below it, and on
	/// fatal writes even below the threshold. It does not retain the event loop.
	#[napi(constructor)]
	pub fn new(
		fd: i32,
		drain_threshold: u32,
		#[napi(ts_arg_type = "() => void")] on_drain: DrainCallback,
	) -> Result<Self> {
		Self::start(fd, drain_threshold, DrainNotifier::Js(on_drain))
	}

	/// Copy UTF-16 into pooled storage without UTF-8 sizing or transcoding on
	/// JS's thread. Returns a conservative pending UTF-8 byte upper bound.
	#[napi]
	pub fn write(&self, data: JsString) -> Result<f64> {
		self.enqueue(|units| js::utf16_append(data, units).map(|_| ()))
	}

	/// Conservative UTF-8 bytes not yet written (tightened by the worker).
	#[napi]
	pub fn pending(&self) -> f64 {
		pending_number(self.inner.queue.lock().pending)
	}

	/// True after a terminal write failed; all pending output is dropped.
	#[napi(getter)]
	pub fn dead(&self) -> bool {
		self.inner.dead.load(Ordering::Acquire)
	}

	/// Wait for queued output until the deadline. False on timeout or failure.
	#[napi]
	pub fn flush_sync(&self, timeout_ms: u32) -> bool {
		let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms));
		let mut queue = self.inner.queue.lock();
		while queue.pending != 0 && !self.inner.dead.load(Ordering::Acquire) {
			let now = Instant::now();
			if now >= deadline {
				return false;
			}
			self.inner.cv.wait_for(&mut queue, deadline - now);
		}
		queue.pending == 0 && !self.inner.dead.load(Ordering::Acquire)
	}

	/// Drain until the deadline, then cancel and join. Nothing is written after
	/// return, except one chunk a Windows console refused to abort. Already
	/// queued JS callbacks may still run; callers must ignore callbacks from a
	/// stopped writer.
	#[napi]
	pub fn stop(&mut self, flush_timeout_ms: u32) {
		let Some(worker) = self.worker.take() else {
			return;
		};
		self.flush_sync(flush_timeout_ms);
		{
			let _queue = self.inner.queue.lock();
			self.inner.cancelled.store(true, Ordering::Release);
			self.inner.cv.notify_all();
		}
		worker.cancel.stop(worker.thread);
	}
}

impl Drop for TtyWriter {
	fn drop(&mut self) {
		self.stop(0);
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		os::{
			fd::{AsRawFd, FromRawFd, OwnedFd},
			unix::net::UnixStream,
		},
		sync::atomic::AtomicUsize,
	};

	use super::{sys::reopen_tty, *};

	struct Pty {
		master: OwnedFd,
		slave:  OwnedFd,
	}

	impl Pty {
		fn new() -> Self {
			let mut master = -1;
			let mut slave = -1;
			// SAFETY: both outputs point to valid storage. No optional name,
			// termios, or window-size pointers are passed.
			assert_eq!(
				unsafe {
					libc::openpty(
						&mut master,
						&mut slave,
						std::ptr::null_mut(),
						std::ptr::null_mut(),
						std::ptr::null_mut(),
					)
				},
				0,
				"openpty: {}",
				std::io::Error::last_os_error()
			);
			// SAFETY: openpty succeeded and returned two newly owned fds.
			let (master, slave) =
				unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
			let mut attrs = std::mem::MaybeUninit::<libc::termios>::uninit();
			// SAFETY: slave is a live TTY and attrs is valid output storage.
			assert_eq!(unsafe { libc::tcgetattr(slave.as_raw_fd(), attrs.as_mut_ptr()) }, 0);
			// SAFETY: tcgetattr succeeded.
			let mut attrs = unsafe { attrs.assume_init() };
			// SAFETY: attrs is initialized, and this test owns the PTY.
			unsafe { libc::cfmakeraw(&mut attrs) };
			assert_eq!(unsafe { libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &attrs) }, 0);
			for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
				// SAFETY: these are live, test-owned descriptors.
				assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) }, 0);
			}
			// The test's reads must have deadlines even if the writer fails.
			let flags = flags(master.as_raw_fd());
			// SAFETY: master is test-owned, unrelated to stdout.
			assert_eq!(
				unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) },
				0
			);
			Self { master, slave }
		}

		fn writer(&self, threshold: u32) -> (TtyWriter, Arc<AtomicUsize>) {
			let calls = Arc::new(AtomicUsize::new(0));
			let writer = TtyWriter::start(
				self.slave.as_raw_fd(),
				threshold,
				DrainNotifier::Test(Arc::clone(&calls)),
			)
			.unwrap();
			(writer, calls)
		}
	}

	fn flags(fd: i32) -> i32 {
		// SAFETY: callers pass a live test-owned descriptor.
		let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
		assert!(flags >= 0);
		flags
	}

	fn push(writer: &TtyWriter, units: &[u16]) -> f64 {
		writer
			.enqueue(|back| {
				back.extend_from_slice(units);
				Ok(())
			})
			.unwrap()
	}

	fn wait_until(mut ready: impl FnMut() -> bool) {
		let deadline = Instant::now() + Duration::from_secs(3);
		while !ready() {
			assert!(Instant::now() < deadline, "timed out waiting for worker");
			std::thread::sleep(Duration::from_millis(1));
		}
	}

	fn read_available(fd: i32, output: &mut Vec<u8>) {
		let mut buf = [0u8; 16 * 1024];
		loop {
			// SAFETY: fd is a live nonblocking PTY master; buf is writable.
			let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
			if n > 0 {
				output.extend_from_slice(&buf[..n as usize]);
				continue;
			}
			if n == 0 {
				return;
			}
			let err = std::io::Error::last_os_error();
			if err.kind() == std::io::ErrorKind::Interrupted {
				continue;
			}
			if err.kind() == std::io::ErrorKind::WouldBlock || err.raw_os_error() == Some(libc::EIO) {
				return;
			}
			panic!("PTY read: {err}");
		}
	}

	fn read_exact_output(fd: i32, expected: usize) -> Vec<u8> {
		let mut output = Vec::with_capacity(expected);
		wait_until(|| {
			read_available(fd, &mut output);
			output.len() >= expected
		});
		output
	}

	#[test]
	fn reopening_preserves_original_flags_and_sets_close_on_exec() {
		let pty = Pty::new();
		let original_flags = flags(pty.slave.as_raw_fd());
		let output = reopen_tty(pty.slave.as_raw_fd()).unwrap();
		assert_eq!(flags(pty.slave.as_raw_fd()), original_flags);
		assert_eq!(flags(output.as_raw_fd()) & libc::O_NONBLOCK, libc::O_NONBLOCK);
		// SAFETY: output is live and owned for the entire inspection.
		assert_ne!(unsafe { libc::fcntl(output.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
		// Changing the original's flags cannot turn the worker into a blocking
		// writer (which is exactly what dup-based implementations permit).
		assert_eq!(
			unsafe {
				libc::fcntl(pty.slave.as_raw_fd(), libc::F_SETFL, original_flags & !libc::O_NONBLOCK)
			},
			0
		);
		assert_ne!(flags(output.as_raw_fd()) & libc::O_NONBLOCK, 0);
		let (mut writer, _) = pty.writer(0);
		assert_eq!(flags(pty.slave.as_raw_fd()), original_flags);
		let cancel = writer.worker.as_ref().unwrap().cancel.0.as_raw_fd();
		assert_ne!(unsafe { libc::fcntl(cancel, libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
		writer.stop(0);
		assert_eq!(flags(pty.slave.as_raw_fd()), original_flags);
	}

	#[test]
	fn rejects_non_tty_and_invalid_descriptors() {
		let (socket, _peer) = UnixStream::pair().unwrap();
		assert!(reopen_tty(socket.as_raw_fd()).is_err());
		assert!(reopen_tty(-1).is_err());
		#[cfg(target_os = "linux")]
		{
			let pty = Pty::new();
			assert!(reopen_tty(pty.master.as_raw_fd()).is_err());
		}
	}

	#[test]
	fn writes_fifo_and_drains_before_stop() {
		let pty = Pty::new();
		let (mut writer, _) = pty.writer(0);
		push(&writer, &[b'h' as u16, b'i' as u16, b' ' as u16]);
		push(&writer, &[0x754c, 0xd83d, 0xde80]);
		writer.stop(2_000);
		assert_eq!(writer.pending(), 0.0);
		assert_eq!(read_exact_output(pty.master.as_raw_fd(), 10), "hi 界🚀".as_bytes());
		assert_eq!(push(&writer, &[b'!' as u16]), 0.0);
		let mut extra = Vec::new();
		read_available(pty.master.as_raw_fd(), &mut extra);
		assert!(extra.is_empty());
	}

	#[test]
	fn stalled_stop_cancels_joins_and_never_resumes_old_output() {
		let pty = Pty::new();
		let (mut writer, _) = pty.writer(1024);
		let frame = vec![b'x' as u16; 1024 * 1024];
		assert_eq!(push(&writer, &frame), (frame.len() * 3) as f64);
		wait_until(|| writer.pending() > 0.0 && writer.pending() < (frame.len() * 3) as f64);
		assert!(!writer.flush_sync(10));
		let start = Instant::now();
		writer.stop(20);
		assert!(start.elapsed() < Duration::from_secs(1), "stop did not cancel a stalled PTY");
		assert_eq!(writer.pending(), 0.0);
		assert!(!writer.dead());
		assert!(writer.worker.is_none());

		// Bytes already accepted by the kernel are allowed; a detached old
		// worker would resume as soon as these bytes are read.
		let mut accepted = Vec::new();
		read_available(pty.master.as_raw_fd(), &mut accepted);
		assert!(!accepted.is_empty());
		assert!(accepted.len() < frame.len());
		assert!(accepted.iter().all(|&byte| byte == b'x'));
		let (mut replacement, _) = pty.writer(0);
		push(&replacement, &[b'n' as u16, b'e' as u16, b'w' as u16]);
		assert!(replacement.flush_sync(1_000));
		assert_eq!(read_exact_output(pty.master.as_raw_fd(), 3), b"new");
		replacement.stop(0);
		writer.stop(0);
	}

	#[test]
	fn idle_stop_cannot_lose_a_queue_wakeup() {
		let pty = Pty::new();
		for _ in 0..64 {
			let (mut writer, _) = pty.writer(0);
			// Exercise stop both before and after the worker reaches its wait.
			std::thread::yield_now();
			writer.stop(0);
			assert_eq!(writer.pending(), 0.0);
		}
	}

	#[test]
	fn backpressure_tracks_partial_progress_then_flush_wakes_on_drain() {
		let pty = Pty::new();
		let (mut writer, notifications) = pty.writer(1024);
		let units = vec![b'x' as u16; 512 * 1024];
		let bound = push(&writer, &units);
		wait_until(|| writer.pending() > 0.0 && writer.pending() < bound);
		assert!(!writer.dead());
		assert!(!writer.flush_sync(10));
		let master = pty.master;
		let reader = std::thread::spawn(move || {
			let output = read_exact_output(master.as_raw_fd(), units.len());
			// Keep the master alive until the writer has flushed and stopped.
			(master, output)
		});
		assert!(writer.flush_sync(3_000));
		assert_eq!(writer.pending(), 0.0);
		writer.stop(0);
		let (_master, output) = reader.join().unwrap();
		assert_eq!(output, vec![b'x'; 512 * 1024]);
		assert!(notifications.load(Ordering::Acquire) >= 1);
	}

	#[test]
	fn rapid_small_writes_do_not_underflow_accounting() {
		const WRITES: usize = 10_000;
		let pty = Pty::new();
		let (mut writer, _) = pty.writer(64);
		let master = pty.master;
		let reader = std::thread::spawn(move || {
			let output = read_exact_output(master.as_raw_fd(), WRITES);
			(master, output)
		});
		for _ in 0..WRITES {
			push(&writer, &[b'x' as u16]);
		}
		assert!(writer.flush_sync(3_000));
		assert_eq!(writer.pending(), 0.0);
		writer.stop(0);
		let (_master, output) = reader.join().unwrap();
		assert_eq!(output, vec![b'x'; WRITES]);
	}

	#[test]
	fn dead_terminal_drops_backlog_and_notifies_even_below_threshold() {
		let pty = Pty::new();
		let (mut writer, notifications) = pty.writer(u32::MAX);
		drop(pty.master);
		push(&writer, &[b'x' as u16]);
		wait_until(|| writer.dead());
		assert_eq!(writer.pending(), 0.0);
		assert!(!writer.flush_sync(100));
		// Dead writes must not read the JS string or resurrect the queue.
		assert_eq!(
			writer
				.enqueue(|_| panic!("dead enqueue read input"))
				.unwrap(),
			0.0
		);
		writer.stop(100);
		assert_eq!(notifications.load(Ordering::Acquire), 1);
		assert_eq!(writer.inner.queue.lock().back.units.capacity(), 0);
	}

	#[test]
	fn notifications_are_threshold_crossings_and_unconditional_on_failure() {
		let inner = Inner::new(10);
		let calls = Arc::new(AtomicUsize::new(0));
		let notifier = DrainNotifier::Test(Arc::clone(&calls));
		inner.queue.lock().pending = 30;
		inner.progress(19, &notifier);
		assert_eq!(calls.load(Ordering::Acquire), 0);
		inner.progress(1, &notifier);
		assert_eq!(calls.load(Ordering::Acquire), 1);
		inner.progress(10, &notifier);
		assert_eq!(calls.load(Ordering::Acquire), 1);
		inner.queue.lock().pending = 15;
		inner.progress(5, &notifier);
		assert_eq!(calls.load(Ordering::Acquire), 2);
		inner.finish(true, &notifier);
		assert!(inner.dead.load(Ordering::Acquire));
		assert_eq!(calls.load(Ordering::Acquire), 3);
		assert_eq!(inner.queue.lock().pending, 0);
	}

	#[test]
	fn bounded_writes_preserve_partial_offsets_and_exact_progress() {
		let input = vec![b'x'; MAX_TTY_WRITE_CHUNK_BYTES * 2 + 7];
		let mut output = Vec::new();
		let mut progress = Vec::new();
		let mut interrupted = false;
		write_all_with(
			|chunk| {
				assert!(chunk.len() <= MAX_TTY_WRITE_CHUNK_BYTES);
				if !interrupted {
					interrupted = true;
					return Err(std::io::ErrorKind::Interrupted.into());
				}
				let written = chunk.len().min(137);
				output.extend_from_slice(&chunk[..written]);
				Ok(written)
			},
			&input,
			|bytes| progress.push(bytes),
		)
		.unwrap();
		assert_eq!(output, input);
		assert_eq!(progress.iter().sum::<usize>(), input.len());
		assert!(progress.iter().all(|&bytes| bytes <= 137));
	}

	#[test]
	fn write_zero_and_failures_do_not_claim_unwritten_bytes() {
		let mut progress = 0;
		let err = write_all_with(|_| Ok(0), b"abc", |n| progress += n).unwrap_err();
		assert_eq!(err.kind(), std::io::ErrorKind::WriteZero);
		assert_eq!(progress, 0);
		let mut first = true;
		let err = write_all_with(
			|chunk| {
				if first {
					first = false;
					assert_eq!(chunk, b"abc");
					Ok(1)
				} else {
					assert_eq!(chunk, b"bc");
					Err(std::io::ErrorKind::BrokenPipe.into())
				}
			},
			b"abc",
			|n| progress += n,
		)
		.unwrap_err();
		assert_eq!(err.kind(), std::io::ErrorKind::BrokenPipe);
		assert_eq!(progress, 1);
	}

	fn encoded_frames(frames: &[&[u16]], chunk_size: usize) -> Vec<u8> {
		let mut batch = Batch::default();
		for frame in frames {
			batch.units.extend_from_slice(frame);
			batch.ends.push(batch.units.len());
		}
		let mut cursor = EncodeCursor::default();
		let mut buffer = vec![0u8; chunk_size];
		let mut output = Vec::new();
		let mut consumed = 0;
		while cursor.unit < batch.units.len() {
			let (units, bytes) = encode_chunk(&batch, &mut cursor, &mut buffer);
			assert!(units > 0 && bytes > 0);
			assert!(bytes <= chunk_size);
			assert!(bytes <= units * 3);
			consumed += units;
			output.extend_from_slice(&buffer[..bytes]);
		}
		assert_eq!(consumed, batch.units.len());
		output
	}

	#[test]
	fn unicode_invalid_surrogates_and_independent_writes_match_js_replacement() {
		let valid: Vec<u16> = "ASCII \0 é 界 🚀 tail".encode_utf16().collect();
		let invalid = [0xd800, b'a' as u16, 0xdc00, 0xdbff, 0xdfff, 0xd800, 0xd800, 0xdc00];
		let high = [0xd83d];
		let low = [0xde80];
		let frames: [&[u16]; 6] = [&valid, &invalid, &high, &low, &[], &valid];
		let expected: String = frames
			.iter()
			.map(|frame| String::from_utf16_lossy(frame))
			.collect();
		for chunk_size in [4, 5, 7, MAX_TTY_WRITE_CHUNK_BYTES] {
			assert_eq!(encoded_frames(&frames, chunk_size), expected.as_bytes());
		}
	}

	#[test]
	fn surrogate_pairs_survive_input_and_output_chunk_boundaries() {
		let mut frame = vec![b'x' as u16; MAX_TTY_WRITE_CHUNK_BYTES - 1];
		frame.extend_from_slice(&[0xd83d, 0xde80, 0xd800, b'!' as u16]);
		frame.extend(std::iter::repeat_n(0x754c, MAX_TTY_WRITE_CHUNK_BYTES));
		frame.extend_from_slice(&[0xd83d, 0xde80, 0xdc00]);
		let expected = String::from_utf16_lossy(&frame);
		for chunk_size in [7, MAX_TTY_WRITE_CHUNK_BYTES] {
			assert_eq!(encoded_frames(&[&frame], chunk_size), expected.as_bytes());
		}
	}

	#[test]
	fn normal_buffers_are_reused_and_oversized_buffers_are_retired() {
		let mut batch = Batch { units: Vec::with_capacity(1024), ends: Vec::with_capacity(16) };
		batch.units.extend_from_slice(&[1, 2, 3]);
		batch.ends.push(3);
		let units = batch.units.as_ptr();
		let ends = batch.ends.as_ptr();
		batch.clear();
		assert_eq!(batch.units.as_ptr(), units);
		assert_eq!(batch.ends.as_ptr(), ends);
		assert!(batch.units.is_empty() && batch.ends.is_empty());

		batch.units.reserve(MAX_RETAINED_UNITS + 1);
		batch.ends.reserve(MAX_RETAINED_FRAMES + 1);
		batch.clear();
		assert_eq!(batch.units.capacity(), 0);
		assert_eq!(batch.ends.capacity(), 0);
	}

	#[test]
	fn enqueue_failures_preserve_prior_frames_and_pending_bound() {
		let writer = TtyWriter { inner: Arc::new(Inner::new(0)), worker: None };
		assert_eq!(push(&writer, &[b'a' as u16]), 3.0);
		assert!(
			writer
				.enqueue(|back| {
					back.extend_from_slice(&[0xd800, 0xdc00]);
					Err(Error::from_reason("copy failed"))
				})
				.is_err()
		);
		assert_eq!(writer.pending(), 3.0);
		let queue = writer.inner.queue.lock();
		assert_eq!(queue.back.units, [b'a' as u16]);
		assert_eq!(queue.back.ends, [1]);
	}

	#[test]
	#[cfg(target_pointer_width = "64")]
	fn pending_bounds_are_not_truncated_to_u32() {
		assert_eq!(pending_number(u32::MAX as usize + 1), u32::MAX as f64 + 1.0);
		assert_eq!(pending_number(usize::MAX), f64::INFINITY);
	}
}
