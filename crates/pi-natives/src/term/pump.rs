//! Off-thread terminal output pump: the [`Device`](super::Device) sink for a
//! real terminal.
//!
//! A write to a terminal from the UI thread blocks it until the terminal
//! drains, so a slow or occluded emulator froze the TUI for the length of a
//! repaint. [`Pump`] moves that work to a dedicated thread:
//!
//! - The encoder appends UTF-8 straight into one pooled byte buffer
//!   ([`Pump::enqueue`]), so output order is one queue.
//! - Unix: the worker writes it in bounded chunks to an independently opened,
//!   nonblocking handle to the same TTY, so stdout's own file-status flags are
//!   never touched and a stalled write can be cancelled.
//! - Windows: the worker `WriteFile`s it to the stdout console in writes of at
//!   most 16 KiB cut between ops (`ConPTY` viewport tracking, see
//!   [`chunks`](super::chunks)), re-asserting the UTF-8 codepages first; a
//!   write the console host holds is cancelled with `CancelSynchronousIo`.
//! - [`Pump::pending`] is the exact count of accepted bytes not yet written.
//!   Crossing the drain threshold, or a fatal write error, runs the drain
//!   callback.
//! - [`Pump::stop`] wakes both the queue wait and a `POLLOUT` wait, then joins
//!   the worker: nothing is written after it returns.

#[cfg(unix)]
use std::os::{
	fd::{AsRawFd, FromRawFd, OwnedFd},
	unix::net::UnixStream,
};
use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread::JoinHandle,
	time::{Duration, Instant},
};

use napi::{Error, Result};
use parking_lot::{Condvar, Mutex};

use super::device::DrainFn;

#[cfg(unix)]
const MAX_TTY_WRITE_CHUNK_BYTES: usize = 16 * 1024;
// At most two normal-sized buffers survive a drain. A large repaint must not
// permanently enlarge either reusable buffer.
const MAX_RETAINED_BYTES: usize = 256 * 1024;

/// Where drain-threshold crossings and fatal write errors are reported;
/// `None` when the owner asked for no notification.
struct DrainNotifier(Option<DrainFn>);

impl DrainNotifier {
	fn notify(&self) {
		if let Some(on_drain) = &self.0 {
			on_drain();
		}
	}
}

/// Empty a written buffer for reuse, retiring an oversized allocation.
fn recycle(buffer: &mut Vec<u8>) {
	buffer.clear();
	if buffer.capacity() > MAX_RETAINED_BYTES {
		buffer.shrink_to(0);
	}
}

#[derive(Default)]
struct Queue {
	/// Encoded output the worker has not taken yet.
	back:    Vec<u8>,
	/// End offset in `back` of every op: the console writer's only cut points.
	#[cfg(windows)]
	marks:   Vec<usize>,
	/// Accepted bytes not yet written: `back` plus the worker's unwritten
	/// remainder.
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
			queue.back = Vec::new();
			#[cfg(windows)]
			{
				queue.marks = Vec::new();
			}
			self.cv.notify_all();
			crossed
		};
		// A fatal write must wake the owner even if there never was
		// backpressure.
		if failed || crossed {
			notifier.notify();
		}
	}
}

#[cfg(unix)]
fn reopen_tty(fd: i32) -> std::io::Result<OwnedFd> {
	let mut original = std::mem::MaybeUninit::<libc::stat>::uninit();
	// SAFETY: fd is only inspected; original is valid storage for fstat.
	if unsafe { libc::fstat(fd, original.as_mut_ptr()) } != 0 {
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: fstat succeeded.
	let original = unsafe { original.assume_init() };
	let mut name = [0 as libc::c_char; libc::PATH_MAX as usize];
	// SAFETY: name is valid writable storage. ttyname_r rejects non-TTYs.
	let rc = unsafe { libc::ttyname_r(fd, name.as_mut_ptr(), name.len()) };
	if rc != 0 {
		return Err(std::io::Error::from_raw_os_error(rc));
	}
	// SAFETY: successful ttyname_r NUL-terminates name.
	let path = unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) };
	// Reopening a clone-device master would allocate a *different* PTY even
	// though its stat identity matches. Only actual terminal destinations work.
	if matches!(path.to_bytes(), b"/dev/ptmx" | b"/dev/pts/ptmx") {
		return Err(std::io::Error::new(
			std::io::ErrorKind::InvalidInput,
			"PTY masters cannot be reopened",
		));
	}
	// A dup shares O_NONBLOCK with stdout. Opening its actual TTY path gives
	// this worker independent status flags; never substitute /dev/tty.
	// SAFETY: name is a valid C string; flags require no variadic mode argument.
	let opened = unsafe {
		libc::open(
			name.as_ptr(),
			libc::O_WRONLY | libc::O_NONBLOCK | libc::O_NOCTTY | libc::O_CLOEXEC,
		)
	};
	if opened < 0 {
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: open returned a new descriptor, uniquely owned here.
	let owned = unsafe { OwnedFd::from_raw_fd(opened) };
	let mut reopened = std::mem::MaybeUninit::<libc::stat>::uninit();
	// SAFETY: owned is live and reopened is valid fstat storage.
	if unsafe { libc::fstat(owned.as_raw_fd(), reopened.as_mut_ptr()) } != 0 {
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: fstat succeeded.
	let reopened = unsafe { reopened.assume_init() };
	if original.st_dev != reopened.st_dev
		|| original.st_ino != reopened.st_ino
		|| original.st_rdev != reopened.st_rdev
	{
		return Err(std::io::Error::new(
			std::io::ErrorKind::InvalidInput,
			"TTY destination changed while reopening",
		));
	}
	Ok(owned)
}

/// Fallback for a TTY that cannot be reopened (a PTY master, a TTY whose
/// device name does not resolve inside a sandbox): a close-on-exec duplicate.
/// It shares the original's file-status flags, so on a blocking descriptor
/// the worker is a blocking writer whose stalled write `stop` cannot cancel —
/// the in-process write it replaces blocked the event loop instead.
#[cfg(unix)]
fn dup_tty(fd: i32) -> std::io::Result<OwnedFd> {
	// SAFETY: isatty only inspects the descriptor.
	if unsafe { libc::isatty(fd) } == 0 {
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: F_DUPFD_CLOEXEC returns a new descriptor or fails; fd is only
	// duplicated.
	let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
	if duplicate < 0 {
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: fcntl returned a new descriptor, uniquely owned here.
	Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

fn cancelled_error() -> std::io::Error {
	std::io::ErrorKind::ConnectionAborted.into()
}

#[cfg(unix)]
fn wait_writable(fd: i32, cancel_fd: i32, inner: &Inner) -> std::io::Result<()> {
	let mut fds = [libc::pollfd { fd, events: libc::POLLOUT, revents: 0 }, libc::pollfd {
		fd:      cancel_fd,
		events:  libc::POLLIN,
		revents: 0,
	}];
	loop {
		if inner.cancelled.load(Ordering::Acquire) {
			return Err(cancelled_error());
		}
		// SAFETY: fds contains two valid poll entries; the worker owns both.
		let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, -1) };
		if result > 0 {
			if fds[1].revents != 0 || inner.cancelled.load(Ordering::Acquire) {
				return Err(cancelled_error());
			}
			if fds[0].revents & libc::POLLNVAL != 0 {
				return Err(std::io::Error::from_raw_os_error(libc::EBADF));
			}
			if fds[0].revents & (libc::POLLERR | libc::POLLHUP) != 0 {
				return Err(std::io::ErrorKind::BrokenPipe.into());
			}
			if fds[0].revents & libc::POLLOUT != 0 {
				return Ok(());
			}
		} else if result < 0 {
			let err = std::io::Error::last_os_error();
			if err.kind() != std::io::ErrorKind::Interrupted {
				return Err(err);
			}
		}
	}
}

#[cfg(unix)]
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

#[cfg(unix)]
fn write_all(
	fd: i32,
	cancel_fd: i32,
	inner: &Inner,
	buf: &[u8],
	notifier: &DrainNotifier,
) -> std::io::Result<()> {
	write_all_with(
		|chunk| loop {
			if inner.cancelled.load(Ordering::Acquire) {
				return Err(cancelled_error());
			}
			// SAFETY: chunk is initialized storage and fd is worker-owned and
			// nonblocking. No original stdout descriptor flags are shared.
			let rc = unsafe { libc::write(fd, chunk.as_ptr().cast(), chunk.len()) };
			if rc >= 0 {
				return Ok(rc as usize);
			}
			let err = std::io::Error::last_os_error();
			if err.kind() == std::io::ErrorKind::WouldBlock {
				wait_writable(fd, cancel_fd, inner)?;
				continue;
			}
			return Err(err);
		},
		buf,
		|bytes| inner.progress(bytes, notifier),
	)
}

#[cfg(unix)]
fn pump_loop(fd: OwnedFd, cancel: UnixStream, inner: &Inner, notifier: DrainNotifier) {
	let mut front = Vec::new();
	loop {
		{
			let mut queue = inner.queue.lock();
			while queue.back.is_empty() && !inner.cancelled.load(Ordering::Acquire) {
				inner.cv.wait(&mut queue);
			}
			if inner.cancelled.load(Ordering::Acquire) {
				drop(queue);
				inner.finish(false, &notifier);
				return;
			}
			std::mem::swap(&mut queue.back, &mut front);
		}
		// Progress is reported per write, so only bytes the terminal has not
		// accepted remain outstanding, including across partial writes.
		if write_all(fd.as_raw_fd(), cancel.as_raw_fd(), inner, &front, &notifier).is_err() {
			inner.finish(!inner.cancelled.load(Ordering::Acquire), &notifier);
			return;
		}
		recycle(&mut front);
	}
}

/// Dedicated, cancellable terminal writer. The destination must be a
/// terminal: a TTY (independently reopened when possible) or the Windows
/// stdout console; pipes and files are deliberately rejected.
pub(super) struct Pump {
	inner:  Arc<Inner>,
	thread: Option<JoinHandle<()>>,
	#[cfg(unix)]
	cancel: Option<UnixStream>,
}

impl Pump {
	/// Start a writer on the TTY behind `fd`. `on_drain` runs on the worker
	/// thread when the pending count crosses from above `drain_threshold` to
	/// at/below it, and on fatal writes even below the threshold.
	///
	/// # Errors
	/// Fails when `fd` is not a TTY, or when the cancellation socket or the
	/// worker thread cannot be created.
	#[cfg(unix)]
	pub(super) fn start(fd: i32, drain_threshold: u32, on_drain: Option<DrainFn>) -> Result<Self> {
		let output = reopen_tty(fd)
			.or_else(|err| {
				log::debug!("tty fd {fd} cannot be reopened ({err}); writing through a duplicate");
				dup_tty(fd)
			})
			.map_err(|err| Error::from_reason(format!("opening tty fd {fd} failed: {err}")))?;
		// UnixStream::pair owns close-on-exec endpoints. Closing the sender
		// wakes poll without writes, SIGPIPE, or a potentially full wake pipe.
		let (cancel_read, cancel_write) = UnixStream::pair()
			.map_err(|err| Error::from_reason(format!("tty cancellation socket failed: {err}")))?;
		let inner = Arc::new(Inner::new(drain_threshold));
		let thread_inner = Arc::clone(&inner);
		let notifier = DrainNotifier(on_drain);
		let thread = std::thread::Builder::new()
			.name("term-pump".into())
			.spawn(move || pump_loop(output, cancel_read, &thread_inner, notifier))
			.map_err(|err| Error::from_reason(format!("terminal pump thread spawn failed: {err}")))?;
		// Every descriptor is RAII-owned, including inside a failed spawn.
		Ok(Self { inner, thread: Some(thread), cancel: Some(cancel_write) })
	}

	/// Start a writer on this process's stdout console, with `on_drain` as
	/// for the unix [`start`](Self::start).
	///
	/// # Errors
	/// Fails when stdout is not a console, or when the worker thread cannot
	/// be created.
	#[cfg(windows)]
	pub(super) fn console(drain_threshold: u32, on_drain: Option<DrainFn>) -> Result<Self> {
		let console = win::Console::stdout()
			.map_err(|err| Error::from_reason(format!("opening the stdout console failed: {err}")))?;
		let inner = Arc::new(Inner::new(drain_threshold));
		let thread_inner = Arc::clone(&inner);
		let notifier = DrainNotifier(on_drain);
		let thread = std::thread::Builder::new()
			.name("term-pump".into())
			.spawn(move || win::pump_loop(&console, &thread_inner, &notifier))
			.map_err(|err| Error::from_reason(format!("terminal pump thread spawn failed: {err}")))?;
		Ok(Self { inner, thread: Some(thread) })
	}

	/// Run `fill` against the pooled buffer (and, for the console writer, its
	/// op-end offsets) under the queue lock, then account for and publish
	/// whatever it appended. Returns the pending byte count. A dead or stopped
	/// pump accepts nothing and never runs `fill`.
	pub(super) fn enqueue(&self, fill: impl FnOnce(&mut Vec<u8>, Option<&mut Vec<usize>>)) -> usize {
		let mut queue = self.inner.queue.lock();
		if self.inner.dead.load(Ordering::Acquire) || self.inner.cancelled.load(Ordering::Acquire) {
			return queue.pending;
		}
		let start = queue.back.len();
		#[cfg(unix)]
		fill(&mut queue.back, None);
		#[cfg(windows)]
		{
			let Queue { back, marks, .. } = &mut *queue;
			fill(back, Some(marks));
		}
		let added = queue.back.len() - start;
		if added != 0 {
			queue.pending += added;
			self.inner.cv.notify_all();
		}
		// Publish accounting before releasing the queue: the worker cannot
		// subtract newly accepted bytes before they have been counted.
		queue.pending
	}

	/// Accepted bytes not yet written.
	pub(super) fn pending(&self) -> usize {
		self.inner.queue.lock().pending
	}

	/// True after a terminal write failed; all pending output is dropped.
	pub(super) fn dead(&self) -> bool {
		self.inner.dead.load(Ordering::Acquire)
	}

	/// Wait for queued output until the deadline. False on timeout or failure.
	pub(super) fn flush_sync(&self, timeout_ms: u32) -> bool {
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

	/// Drain until the deadline, then cancel and join. Never detaches a writer
	/// or leaves old output running after return. An already running drain
	/// callback may still complete; owners must ignore callbacks from a
	/// stopped pump.
	pub(super) fn stop(&mut self, flush_timeout_ms: u32) {
		let Some(thread) = self.thread.take() else {
			return;
		};
		self.flush_sync(flush_timeout_ms);
		{
			let _queue = self.inner.queue.lock();
			self.inner.cancelled.store(true, Ordering::Release);
			self.inner.cv.notify_all();
		}
		#[cfg(unix)]
		drop(self.cancel.take());
		#[cfg(windows)]
		win::cancel_until_finished(&thread);
		let _ = thread.join();
	}
}

/// The Windows console writer.
#[cfg(windows)]
mod win {
	use std::{
		io, os::windows::io::AsRawHandle, sync::atomic::Ordering, thread::JoinHandle, time::Duration,
	};

	use windows_sys::Win32::{
		Foundation::{HANDLE, INVALID_HANDLE_VALUE},
		Storage::FileSystem::WriteFile,
		System::{
			Console::{
				CONSOLE_MODE, ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode, GetStdHandle,
				STD_OUTPUT_HANDLE, SetConsoleMode,
			},
			IO::CancelSynchronousIo,
		},
	};

	use super::{DrainNotifier, Inner, cancelled_error, recycle};
	use crate::term::{
		chunks::{MAX_CONSOLE_WRITE_BYTES, write_chunked},
		console::ensure_utf8,
	};

	/// The process's stdout console handle; never closed here.
	pub(super) struct Console(HANDLE);

	// SAFETY: a console handle is a process-wide kernel object reference with
	// no thread affinity; the console API may be called on it from any thread.
	unsafe impl Send for Console {}

	impl Console {
		/// The stdout console, with VT processing on (the runtime enables it at
		/// startup; a console that lost it would print escapes as text).
		pub(super) fn stdout() -> io::Result<Self> {
			// SAFETY: takes a plain handle id and returns the process's own
			// handle.
			let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
			if handle.is_null() || handle == INVALID_HANDLE_VALUE {
				return Err(io::ErrorKind::NotFound.into());
			}
			let mut mode: CONSOLE_MODE = 0;
			// SAFETY: `handle` is the live stdout handle and `mode` is a valid
			// out-pointer for the duration of the call.
			if unsafe { GetConsoleMode(handle, &raw mut mode) } == 0 {
				return Err(io::Error::new(io::ErrorKind::InvalidInput, "stdout is not a console"));
			}
			if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING == 0 {
				// SAFETY: `handle` is the live stdout console; the mode is a plain
				// flag word. Failure leaves the console as is.
				unsafe { SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) };
			}
			Ok(Self(handle))
		}

		/// Write all of `bytes`, reporting progress per `WriteFile`.
		fn write(&self, mut bytes: &[u8], inner: &Inner, notifier: &DrainNotifier) -> io::Result<()> {
			while !bytes.is_empty() {
				if inner.cancelled.load(Ordering::Acquire) {
					return Err(cancelled_error());
				}
				let len = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
				let mut written = 0u32;
				// SAFETY: `bytes` is initialized for `len` bytes, `written` is a
				// valid out-pointer, and the write is synchronous (no OVERLAPPED).
				let ok = unsafe {
					WriteFile(self.0, bytes.as_ptr(), len, &raw mut written, std::ptr::null_mut())
				};
				if ok == 0 {
					return Err(io::Error::last_os_error());
				}
				if written == 0 {
					return Err(io::ErrorKind::WriteZero.into());
				}
				let written = written as usize;
				bytes = &bytes[written..];
				inner.progress(written, notifier);
			}
			Ok(())
		}
	}

	pub(super) fn pump_loop(console: &Console, inner: &Inner, notifier: &DrainNotifier) {
		let mut front = Vec::new();
		let mut marks = Vec::new();
		loop {
			{
				let mut queue = inner.queue.lock();
				while queue.back.is_empty() && !inner.cancelled.load(Ordering::Acquire) {
					inner.cv.wait(&mut queue);
				}
				if inner.cancelled.load(Ordering::Acquire) {
					drop(queue);
					inner.finish(false, notifier);
					return;
				}
				std::mem::swap(&mut queue.back, &mut front);
				std::mem::swap(&mut queue.marks, &mut marks);
			}
			// Console-sharing children may have flipped the codepage.
			ensure_utf8();
			let written = write_chunked(&front, &marks, MAX_CONSOLE_WRITE_BYTES, |chunk| {
				console.write(chunk, inner, notifier)
			});
			if written.is_err() {
				inner.finish(!inner.cancelled.load(Ordering::Acquire), notifier);
				return;
			}
			recycle(&mut front);
			marks.clear();
		}
	}

	/// Cancel the `WriteFile` the console host may be holding (a `QuickEdit`
	/// selection pauses console output) until the worker exits. A cancel that
	/// lands before the worker enters its write is a no-op, so it repeats.
	pub(super) fn cancel_until_finished(thread: &JoinHandle<()>) {
		while !thread.is_finished() {
			// SAFETY: the thread handle stays valid until the JoinHandle is
			// joined; cancelling I/O the thread is not performing is a no-op.
			unsafe { CancelSynchronousIo(thread.as_raw_handle()) };
			std::thread::sleep(Duration::from_millis(1));
		}
	}
}

impl Drop for Pump {
	fn drop(&mut self) {
		self.stop(0);
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::sync::atomic::AtomicUsize;

	use super::{super::Device, *};

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
			let opened = unsafe {
				libc::openpty(
					&mut master,
					&mut slave,
					std::ptr::null_mut(),
					std::ptr::null_mut(),
					std::ptr::null_mut(),
				)
			};
			assert_eq!(opened, 0, "openpty: {}", std::io::Error::last_os_error());
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
			// SAFETY: slave is a live, test-owned TTY and attrs is initialized.
			let set = unsafe { libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &attrs) };
			assert_eq!(set, 0);
			for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
				// SAFETY: these are live, test-owned descriptors.
				assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) }, 0);
			}
			// The test's reads must have deadlines even if the writer fails.
			let flags = flags(master.as_raw_fd());
			// SAFETY: master is test-owned, unrelated to stdout.
			let set =
				unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) };
			assert_eq!(set, 0);
			Self { master, slave }
		}

		fn writer(&self, threshold: u32) -> (Pump, Arc<AtomicUsize>) {
			let calls = Arc::new(AtomicUsize::new(0));
			let writer =
				Pump::start(self.slave.as_raw_fd(), threshold, Some(counter(&calls))).unwrap();
			(writer, calls)
		}
	}

	fn counter(calls: &Arc<AtomicUsize>) -> DrainFn {
		let calls = Arc::clone(calls);
		Box::new(move || {
			calls.fetch_add(1, Ordering::AcqRel);
		})
	}

	fn flags(fd: i32) -> i32 {
		// SAFETY: callers pass a live test-owned descriptor.
		let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
		assert!(flags >= 0);
		flags
	}

	fn push(writer: &Pump, bytes: &[u8]) -> usize {
		writer.enqueue(|buffer, _| buffer.extend_from_slice(bytes))
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
		// SAFETY: the slave fd is live and owned by this test's PTY.
		let set = unsafe {
			libc::fcntl(pty.slave.as_raw_fd(), libc::F_SETFL, original_flags & !libc::O_NONBLOCK)
		};
		assert_eq!(set, 0);
		assert_ne!(flags(output.as_raw_fd()) & libc::O_NONBLOCK, 0);
		let (mut writer, _) = pty.writer(0);
		assert_eq!(flags(pty.slave.as_raw_fd()), original_flags);
		let cancel = writer.cancel.as_ref().unwrap().as_raw_fd();
		// SAFETY: the cancel fd stays live until `writer.stop` below.
		let fd_flags = unsafe { libc::fcntl(cancel, libc::F_GETFD) };
		assert_ne!(fd_flags & libc::FD_CLOEXEC, 0);
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

	/// A PTY master cannot be reopened (it would allocate a new PTY): the pump
	/// writes through a duplicate instead of leaving the terminal unwritten.
	#[cfg(target_os = "linux")]
	#[test]
	fn an_unreopenable_tty_is_written_through_a_duplicate() {
		let pty = Pty::new();
		let mut writer = Pump::start(pty.master.as_raw_fd(), 0, None).unwrap();
		push(&writer, b"via dup");
		assert!(writer.flush_sync(2_000));
		writer.stop(0);
		let mut buf = [0u8; 16];
		// SAFETY: buf is writable; the slave is a live raw TTY holding the bytes
		// written above.
		let read = unsafe { libc::read(pty.slave.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
		assert_eq!(&buf[..read as usize], b"via dup");
	}

	#[test]
	fn writes_fifo_and_drains_before_stop() {
		let pty = Pty::new();
		let (mut writer, _) = pty.writer(0);
		assert_eq!(push(&writer, b"hi "), 3);
		push(&writer, "界🚀".as_bytes());
		writer.stop(2_000);
		assert_eq!(writer.pending(), 0);
		assert_eq!(read_exact_output(pty.master.as_raw_fd(), 10), "hi 界🚀".as_bytes());
		assert_eq!(push(&writer, b"!"), 0);
		let mut extra = Vec::new();
		read_available(pty.master.as_raw_fd(), &mut extra);
		assert!(extra.is_empty());
	}

	#[test]
	fn stalled_stop_cancels_joins_and_never_resumes_old_output() {
		let pty = Pty::new();
		let (mut writer, _) = pty.writer(1024);
		let frame = vec![b'x'; 1024 * 1024];
		assert_eq!(push(&writer, &frame), frame.len());
		wait_until(|| writer.pending() > 0 && writer.pending() < frame.len());
		assert!(!writer.flush_sync(10));
		let start = Instant::now();
		writer.stop(20);
		assert!(start.elapsed() < Duration::from_secs(1), "stop did not cancel a stalled PTY");
		assert_eq!(writer.pending(), 0);
		assert!(!writer.dead());
		assert!(writer.thread.is_none());
		assert!(writer.cancel.is_none());

		// Bytes already accepted by the kernel are allowed; a detached old
		// worker would resume as soon as these bytes are read.
		let mut accepted = Vec::new();
		read_available(pty.master.as_raw_fd(), &mut accepted);
		assert!(!accepted.is_empty());
		assert!(accepted.len() < frame.len());
		assert!(accepted.iter().all(|&byte| byte == b'x'));
		let (mut replacement, _) = pty.writer(0);
		push(&replacement, b"new");
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
			assert_eq!(writer.pending(), 0);
		}
	}

	#[test]
	fn backpressure_tracks_partial_progress_then_flush_wakes_on_drain() {
		let pty = Pty::new();
		let (mut writer, notifications) = pty.writer(1024);
		let frame = vec![b'x'; 512 * 1024];
		let queued = push(&writer, &frame);
		assert_eq!(queued, frame.len());
		wait_until(|| writer.pending() > 0 && writer.pending() < queued);
		assert!(!writer.dead());
		assert!(!writer.flush_sync(10));
		let master = pty.master;
		let reader = std::thread::spawn(move || {
			let output = read_exact_output(master.as_raw_fd(), frame.len());
			// Keep the master alive until the writer has flushed and stopped.
			(master, output)
		});
		assert!(writer.flush_sync(3_000));
		assert_eq!(writer.pending(), 0);
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
			push(&writer, b"x");
		}
		assert!(writer.flush_sync(3_000));
		assert_eq!(writer.pending(), 0);
		writer.stop(0);
		let (_master, output) = reader.join().unwrap();
		assert_eq!(output, vec![b'x'; WRITES]);
	}

	#[test]
	fn dead_terminal_drops_backlog_and_notifies_even_below_threshold() {
		let pty = Pty::new();
		let (mut writer, notifications) = pty.writer(u32::MAX);
		drop(pty.master);
		push(&writer, b"x");
		wait_until(|| writer.dead());
		assert_eq!(writer.pending(), 0);
		assert!(!writer.flush_sync(100));
		// Dead writes must not run the encoder or resurrect the queue.
		assert_eq!(writer.enqueue(|_, _| panic!("dead enqueue ran the encoder")), 0);
		writer.stop(100);
		assert_eq!(notifications.load(Ordering::Acquire), 1);
		assert_eq!(writer.inner.queue.lock().back.capacity(), 0);
	}

	#[test]
	fn notifications_are_threshold_crossings_and_unconditional_on_failure() {
		let inner = Inner::new(10);
		let calls = Arc::new(AtomicUsize::new(0));
		let notifier = DrainNotifier(Some(counter(&calls)));
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

	#[test]
	fn normal_buffers_are_reused_and_oversized_buffers_are_retired() {
		let mut buffer = Vec::with_capacity(1024);
		buffer.extend_from_slice(b"abc");
		let allocation = buffer.as_ptr();
		recycle(&mut buffer);
		assert_eq!(buffer.as_ptr(), allocation);
		assert!(buffer.is_empty());

		buffer.reserve(MAX_RETAINED_BYTES + 1);
		recycle(&mut buffer);
		assert_eq!(buffer.capacity(), 0);
	}

	#[test]
	fn enqueue_counts_exactly_the_bytes_appended() {
		let writer = Pump { inner: Arc::new(Inner::new(0)), thread: None, cancel: None };
		assert_eq!(push(&writer, b"a"), 1);
		assert_eq!(push(&writer, b""), 1);
		assert_eq!(push(&writer, "界🚀".as_bytes()), 8);
		assert_eq!(writer.pending(), 8);
		assert_eq!(writer.inner.queue.lock().back, "a界🚀".as_bytes());
	}

	#[test]
	fn device_output_reaches_the_terminal_in_emission_order() {
		let pty = Pty::new();
		let mut device = Device::tty(pty.slave.as_raw_fd(), 0, None);
		assert!(!device.is_capture());
		let expected = "\x1b[?25l\x1b[?2026h\x1b[?7l\x1b[3;7Ha界🚀\x1b[K\x1b[?7h\x1b[?2026l";
		let pending = device.emit(|batch| {
			batch
				.frame_begin(true, false)
				.move_to(3, 7)
				.text("a界")
				.text("🚀")
				.erase_line_to_end()
				.frame_end();
		});
		assert_eq!(pending, expected.len());
		assert_eq!(device.cursor_visible(), Some(false));
		assert!(device.flush_sync(2_000));
		assert_eq!(device.pending(), 0);
		assert!(device.take_output().is_empty());
		assert_eq!(read_exact_output(pty.master.as_raw_fd(), expected.len()), expected.as_bytes());

		device.restore();
		device.stop(2_000);
		assert!(!device.dead());
		let restore = concat!(
			"\x1b[?2026l\x1b[?7h\x1b[?1l\x1b>\x1b[?2004l\x1b[?5522l",
			"\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?2031l\x1b[?25h",
		);
		assert_eq!(read_exact_output(pty.master.as_raw_fd(), restore.len()), restore.as_bytes());
		// A stopped device accepts nothing and never runs the encoder.
		assert_eq!(device.emit(|_| panic!("stopped device ran the encoder")), 0);
	}
}
