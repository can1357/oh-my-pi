//! The OS side of pumps and relays: our private end of a pipe (or, on Unix,
//! of a socket pair) as pollable I/O, and a one-shot timer, both waking the
//! polling task without blocking it.
//!
//! - **Unix**: our end is non-blocking (it is ours alone: close-on-exec and
//!   never handed to a child, so `O_NONBLOCK` on its open file description
//!   affects nobody else). I/O that would wait registers the task's waker with
//!   the process-wide readiness poller ([`ready::watch`]). The timer is a
//!   `timerfd` (Linux) or a kqueue timer (BSD, macOS), watched the same way.
//! - **Windows**: anonymous pipes cannot do overlapped I/O, so a pump pipe is
//!   a private named-pipe instance: our server end is overlapped, the child's
//!   client end is an ordinary synchronous handle. One read or write is in
//!   flight at a time, into a buffer this end owns; its completion event is
//!   watched by a thread-pool wait (`RegisterWaitForSingleObject`), whose
//!   callback only wakes the stored waker. The timer is such a wait with a
//!   timeout. No engine future is ever polled outside the task polling it.
//!
//! [`ready::watch`]: crate::sys::ready::watch

use std::{
	fs, io,
	task::{Context, Poll},
	time::{Duration, Instant},
};

pub use self::imp::{OsPipe, Timer};
#[cfg(unix)]
pub use self::imp::socket_pair;

/// A pipe between a pump and a child: our end, and the child's end (`true`
/// = the child reads).
pub fn pipe(child_reads: bool) -> io::Result<(OsPipe, fs::File)> {
	imp::pipe(child_reads)
}

impl OsPipe {
	/// Read into `buf`; `Ok(0)` at end of file (every writer closed).
	pub fn poll_read(&mut self, cx: &Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		self.0.poll_read(cx, buf)
	}

	/// Write a prefix of `buf`; fails once the child's end is closed.
	pub fn poll_write(&mut self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.0.poll_write(cx, buf)
	}

	/// Ready once every byte accepted by [`OsPipe::poll_write`] is in the
	/// pipe (Windows completes writes in the background; Unix writes are
	/// immediate).
	pub fn poll_flush(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
		self.0.poll_flush(cx)
	}

	/// Bytes waiting to be read: in the pipe, plus (Windows) those a
	/// finished read holds for the next [`OsPipe::poll_read`].
	#[cfg_attr(
		unix,
		allow(clippy::needless_pass_by_ref_mut, reason = "Windows collects a finished read")
	)]
	pub fn available(&mut self) -> io::Result<usize> {
		self.0.available()
	}

	/// Close our end at once; the bytes an unfinished write had accepted but
	/// not put into the pipe come back (only Windows writes in the
	/// background; elsewhere this is empty).
	pub fn close(self) -> Vec<u8> {
		self.0.close()
	}
}

impl Timer {
	/// A timer due `after` from now.
	pub fn after(after: Duration) -> Self {
		Self(imp::TimerImp::new(Instant::now() + after))
	}

	/// Ready once due. A timer the OS cannot arm is due at once, so a wait
	/// bounded by it ends early rather than never.
	pub fn poll(&mut self, cx: &Context<'_>) -> Poll<()> {
		self.0.poll(cx)
	}
}

#[cfg(unix)]
mod imp {
	use std::{
		fs,
		io::{self, Read, Write},
		os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		ptr,
		task::{Context, Poll},
		time::{Duration, Instant},
	};

	use crate::sys::ready;

	/// Our non-blocking end of a pump pipe or socket pair.
	pub struct OsPipe(pub(super) UnixEnd);

	/// A one-shot timer.
	pub struct Timer(pub(super) TimerImp);

	pub struct UnixEnd {
		/// Readiness waits, one per direction (a socket pair end is pumped
		/// both ways). Declared first: forgotten by the readiness thread
		/// before the descriptor closes.
		read_watch:  Option<ready::Watch>,
		write_watch: Option<ready::Watch>,
		file:        fs::File,
	}

	pub fn pipe(child_reads: bool) -> io::Result<(OsPipe, fs::File)> {
		let (r, w) = io::pipe()?;
		let (ours, theirs) = if child_reads {
			(OwnedFd::from(w), OwnedFd::from(r))
		} else {
			(OwnedFd::from(r), OwnedFd::from(w))
		};
		Ok((OsPipe(UnixEnd::new(ours)?), fs::File::from(theirs)))
	}

	/// A socket pair for a duplex pump: our end, and the child's.
	pub fn socket_pair() -> io::Result<(OsPipe, fs::File)> {
		let (ours, theirs) = std::os::unix::net::UnixStream::pair()?;
		Ok((OsPipe(UnixEnd::new(OwnedFd::from(ours))?), fs::File::from(OwnedFd::from(theirs))))
	}

	impl OsPipe {
		/// Shut down one direction of a socket pair end (`shutdown(2)`):
		/// the child reads end of file, or its writes fail.
		pub fn shutdown(&self, how: std::net::Shutdown) {
			let how = match how {
				std::net::Shutdown::Read => libc::SHUT_RD,
				std::net::Shutdown::Write => libc::SHUT_WR,
				std::net::Shutdown::Both => libc::SHUT_RDWR,
			};
			// SAFETY: plain syscall on our open descriptor.
			unsafe { libc::shutdown(self.0.file.as_raw_fd(), how) };
		}
	}

	impl UnixEnd {
		fn new(fd: OwnedFd) -> io::Result<Self> {
			let raw = fd.as_raw_fd();
			// SAFETY: fcntl on a descriptor we own. Its open file description
			// is ours alone (close-on-exec, never handed to a child).
			let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };
			// SAFETY: as above.
			if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(Self { read_watch: None, write_watch: None, file: fs::File::from(fd) })
		}

		pub fn poll_read(&mut self, cx: &Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			let Self { read_watch, file, .. } = self;
			let fd = file.as_raw_fd();
			poll_io(cx, fd, ready::READ, read_watch, || (&*file).read(buf))
		}

		pub fn poll_write(&mut self, cx: &Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			let Self { write_watch, file, .. } = self;
			let fd = file.as_raw_fd();
			poll_io(cx, fd, ready::WRITE, write_watch, || (&*file).write(buf))
		}

		#[allow(
			clippy::unused_self,
			clippy::needless_pass_by_ref_mut,
			reason = "same shape as the Windows end, which writes behind"
		)]
		pub const fn poll_flush(&mut self, _cx: &Context<'_>) -> Poll<io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		pub fn available(&self) -> io::Result<usize> {
			let mut n: libc::c_int = 0;
			// SAFETY: FIONREAD stores the byte count into `n` for our open
			// descriptor.
			if unsafe { libc::ioctl(self.file.as_raw_fd(), libc::FIONREAD as _, &raw mut n) } < 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(usize::try_from(n).unwrap_or(0))
		}

		pub fn close(self) -> Vec<u8> {
			drop(self);
			Vec::new()
		}
	}

	/// Run `op` on the non-blocking `fd`; on `WouldBlock` register the
	/// waker for `events` (replacing the earlier wait, so only the latest
	/// waker is kept) and try once more, as readiness may have come before
	/// the registration did.
	fn poll_io(
		cx: &Context<'_>,
		fd: RawFd,
		events: i16,
		watch: &mut Option<ready::Watch>,
		mut op: impl FnMut() -> io::Result<usize>,
	) -> Poll<io::Result<usize>> {
		let mut registered = false;
		loop {
			match op() {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
				r => {
					*watch = None;
					return Poll::Ready(r);
				},
			}
			if registered {
				return Poll::Pending;
			}
			*watch = None;
			match ready::watch(fd, events, cx.waker()) {
				Ok(w) => *watch = Some(w),
				Err(e) => return Poll::Ready(Err(e)),
			}
			registered = true;
		}
	}

	pub struct TimerImp {
		/// Declared first: forgotten before the timer descriptor closes.
		watch:    Option<ready::Watch>,
		fd:       Option<OwnedFd>,
		deadline: Instant,
	}

	impl TimerImp {
		pub const fn new(deadline: Instant) -> Self {
			Self { watch: None, fd: None, deadline }
		}

		pub fn poll(&mut self, cx: &Context<'_>) -> Poll<()> {
			if Instant::now() >= self.deadline {
				self.watch = None;
				return Poll::Ready(());
			}
			if self.fd.is_none() {
				match arm(self.deadline) {
					Ok(fd) => self.fd = Some(fd),
					Err(_) => return Poll::Ready(()),
				}
			}
			let Some(fd) = self.fd.as_ref().map(AsRawFd::as_raw_fd) else {
				return Poll::Ready(());
			};
			self.watch = None;
			match ready::watch(fd, ready::READ, cx.waker()) {
				Ok(w) => self.watch = Some(w),
				Err(_) => return Poll::Ready(()),
			}
			if Instant::now() >= self.deadline {
				Poll::Ready(())
			} else {
				Poll::Pending
			}
		}
	}

	/// Time left until `deadline`, rounded up so the OS timer never fires
	/// before the [`Instant`] check agrees.
	fn left(deadline: Instant) -> Duration {
		deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1)
	}

	/// A descriptor that turns readable at `deadline` (`timerfd`).
	#[cfg(any(target_os = "linux", target_os = "android"))]
	fn arm(deadline: Instant) -> io::Result<OwnedFd> {
		let left = left(deadline);
		// SAFETY: plain syscall; the descriptor it returns is ours.
		let fd = unsafe {
			libc::timerfd_create(libc::CLOCK_MONOTONIC, libc::TFD_CLOEXEC | libc::TFD_NONBLOCK)
		};
		if fd < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh descriptor nobody else owns.
		let fd = unsafe { OwnedFd::from_raw_fd(fd) };
		let spec = libc::itimerspec {
			it_interval: libc::timespec { tv_sec: 0, tv_nsec: 0 },
			it_value:    libc::timespec {
				tv_sec:  left.as_secs() as _,
				tv_nsec: left.subsec_nanos() as _,
			},
		};
		// SAFETY: `spec` is valid; the old value is not wanted.
		if unsafe { libc::timerfd_settime(fd.as_raw_fd(), 0, &raw const spec, ptr::null_mut()) } < 0
		{
			return Err(io::Error::last_os_error());
		}
		Ok(fd)
	}

	/// A descriptor that turns readable at `deadline`: a kqueue holding one
	/// timer event (a kqueue polls readable while it has pending events).
	#[cfg(any(
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly"
	))]
	fn arm(deadline: Instant) -> io::Result<OwnedFd> {
		let left = left(deadline);
		// SAFETY: plain syscall; the descriptor it returns is ours.
		let kq = unsafe { libc::kqueue() };
		if kq < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh descriptor nobody else owns.
		let kq = unsafe { OwnedFd::from_raw_fd(kq) };
		// SAFETY: fcntl on our descriptor (a kqueue is not inherited by a fork;
		// close-on-exec keeps it out of an exec'd child as well).
		unsafe { libc::fcntl(kq.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
		// SAFETY: `kevent` is plain data; zero is a valid value of every field.
		let mut ev: libc::kevent = unsafe { std::mem::zeroed() };
		ev.ident = 1;
		ev.filter = libc::EVFILT_TIMER;
		ev.flags = libc::EV_ADD | libc::EV_ONESHOT;
		// Milliseconds, the default unit.
		ev.data = left.as_millis().min(i32::MAX as u128) as _;
		// SAFETY: one valid change, no event list, no timeout.
		if unsafe { libc::kevent(kq.as_raw_fd(), &raw const ev, 1, ptr::null_mut(), 0, ptr::null()) }
			< 0
		{
			return Err(io::Error::last_os_error());
		}
		Ok(kq)
	}

	/// No pollable timer here: the timer is due at once.
	#[cfg(not(any(
		target_os = "linux",
		target_os = "android",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly"
	)))]
	fn arm(_deadline: Instant) -> io::Result<OwnedFd> {
		Err(io::ErrorKind::Unsupported.into())
	}
}

#[cfg(windows)]
mod imp {
	use std::{
		ffi::c_void,
		fs, io,
		os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
		ptr,
		sync::{
			Arc,
			atomic::{AtomicU32, Ordering},
		},
		task::{Context, Poll, Waker},
		time::Instant,
	};

	use parking_lot::Mutex;
	use windows_sys::Win32::{
		Foundation::{
			ERROR_BROKEN_PIPE, ERROR_IO_INCOMPLETE, ERROR_IO_PENDING, ERROR_PIPE_NOT_CONNECTED,
			GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
		},
		Storage::FileSystem::{
			CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_READ_ATTRIBUTES,
			FILE_WRITE_ATTRIBUTES, OPEN_EXISTING, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND, ReadFile,
			WriteFile,
		},
		System::{
			IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
			Pipes::{
				CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
				PIPE_WAIT, PeekNamedPipe,
			},
			Threading::{
				CreateEventW, INFINITE, RegisterWaitForSingleObject, UnregisterWaitEx,
				WT_EXECUTEINWAITTHREAD, WT_EXECUTEONLYONCE,
			},
		},
	};

	/// Pipe buffer size, and the size of one read or write in flight.
	const BUF: usize = 64 << 10;

	/// Our overlapped end of a pump pipe.
	pub struct OsPipe(pub(super) WinEnd);

	/// A one-shot timer.
	pub struct Timer(pub(super) TimerImp);

	fn owned(h: HANDLE) -> io::Result<OwnedHandle> {
		if h.is_null() || h == INVALID_HANDLE_VALUE {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh, valid handle nobody else owns.
		Ok(unsafe { OwnedHandle::from_raw_handle(h.cast()) })
	}

	fn raw(h: &OwnedHandle) -> HANDLE {
		h.as_raw_handle().cast()
	}

	fn is_os(e: &io::Error, code: u32) -> bool {
		e.raw_os_error() == Some(code as i32)
	}

	/// The writer is gone: end of file for a reader.
	fn hung_up(e: &io::Error) -> bool {
		is_os(e, ERROR_BROKEN_PIPE) || is_os(e, ERROR_PIPE_NOT_CONNECTED)
	}

	pub fn pipe(child_reads: bool) -> io::Result<(OsPipe, fs::File)> {
		static SEQ: AtomicU32 = AtomicU32::new(0);
		let name = format!(
			r"\\.\pipe\obash-pump-{}-{}",
			std::process::id(),
			SEQ.fetch_add(1, Ordering::Relaxed)
		);
		let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
		let access = if child_reads {
			PIPE_ACCESS_OUTBOUND
		} else {
			PIPE_ACCESS_INBOUND
		};
		// SAFETY: `wide` is NUL-terminated; null security attributes (not
		// inheritable: the server end stays ours).
		let server = owned(unsafe {
			CreateNamedPipeW(
				wide.as_ptr(),
				access | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
				PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
				1,
				BUF as u32,
				BUF as u32,
				0,
				ptr::null(),
			)
		})?;
		// The access `CreatePipe` gives its ends: the child can query and set
		// the pipe state of its own end.
		let desired = if child_reads {
			GENERIC_READ | FILE_WRITE_ATTRIBUTES
		} else {
			GENERIC_WRITE | FILE_READ_ATTRIBUTES
		};
		// SAFETY: as above; opens the client end of the instance just created,
		// synchronous (no FILE_FLAG_OVERLAPPED), as children expect.
		let client = owned(unsafe {
			CreateFileW(
				wide.as_ptr(),
				desired,
				0,
				ptr::null(),
				OPEN_EXISTING,
				0,
				ptr::null_mut(),
			)
		})?;
		Ok((OsPipe(WinEnd::new(server)?), fs::File::from(client)))
	}

	/// The waker a thread-pool wait callback wakes.
	#[derive(Default)]
	struct Slot(Mutex<Option<Waker>>);

	impl Slot {
		fn set(&self, waker: &Waker) {
			let mut slot = self.0.lock();
			if !slot.as_ref().is_some_and(|w| w.will_wake(waker)) {
				*slot = Some(waker.clone());
			}
		}

		fn wake(&self) {
			let waker = self.0.lock().take();
			if let Some(w) = waker {
				w.wake();
			}
		}
	}

	/// Thread-pool wait callback: wake the slot's waker. Runs on the OS wait
	/// thread (`WT_EXECUTEINWAITTHREAD`) and does nothing else.
	unsafe extern "system" fn on_signal(context: *mut c_void, _timed_out: bool) {
		// SAFETY: `context` is the `Slot` a `Registered` keeps alive until it
		// has unregistered the wait and every callback has returned.
		let slot = unsafe { &*context.cast::<Slot>() };
		slot.wake();
	}

	/// A registered thread-pool wait on an object, waking a [`Slot`].
	struct Registered {
		wait:    HANDLE,
		context: *const Slot,
	}

	// SAFETY: the wait handle is a process-wide registration usable from any
	// thread; `context` points at a `Slot` (`Sync`) this registration owns
	// a reference count of.
	unsafe impl Send for Registered {}

	impl Registered {
		/// Wake `slot` whenever `object` is signaled, or once after `timeout`
		/// ms with `once`.
		fn new(object: HANDLE, slot: &Arc<Slot>, timeout: u32, once: bool) -> io::Result<Self> {
			let context = Arc::into_raw(Arc::clone(slot));
			let mut flags = WT_EXECUTEINWAITTHREAD;
			if once {
				flags |= WT_EXECUTEONLYONCE;
			}
			let mut wait: HANDLE = ptr::null_mut();
			// SAFETY: `object` is open for the registration's lifetime (its
			// owner drops the registration first); `context` stays valid until
			// `Drop` unregistered the wait and waited for its callbacks.
			let ok = unsafe {
				RegisterWaitForSingleObject(
					&raw mut wait,
					object,
					Some(on_signal),
					context.cast(),
					timeout,
					flags,
				)
			};
			if ok == 0 {
				let e = io::Error::last_os_error();
				// SAFETY: from `Arc::into_raw` above; never handed out.
				drop(unsafe { Arc::from_raw(context) });
				return Err(e);
			}
			Ok(Self { wait, context })
		}
	}

	impl Drop for Registered {
		fn drop(&mut self) {
			// SAFETY: our registration; INVALID_HANDLE_VALUE returns only once
			// every running callback has returned.
			unsafe { UnregisterWaitEx(self.wait, INVALID_HANDLE_VALUE) };
			// SAFETY: from `Arc::into_raw` in `new`; no callback can use it now.
			drop(unsafe { Arc::from_raw(self.context) });
		}
	}

	/// The operation in flight on a [`WinEnd`].
	#[derive(Clone, Copy, PartialEq, Eq)]
	enum Op {
		Idle,
		Reading,
		/// A write of the first `len` bytes of the buffer.
		Writing {
			len: usize,
		},
	}

	/// What an operation in flight uses, at a stable address (boxed) until
	/// it completed or was cancelled and waited for.
	struct Io {
		ov:    OVERLAPPED,
		/// Auto-reset completion event: the thread-pool wait consumes each
		/// signal; results are read with `GetOverlappedResult(.., FALSE)`.
		event: OwnedHandle,
		buf:   Box<[u8]>,
	}

	// SAFETY: the OVERLAPPED's raw handle is a process-wide event handle; the
	// structure is only touched by its owner and the kernel.
	unsafe impl Send for Io {}

	pub struct WinEnd {
		/// Declared first: unregistered (waiting out its callback) before the
		/// event and the pipe close. `Drop` also cancels the I/O in flight.
		wait:   Option<Registered>,
		slot:   Arc<Slot>,
		io:     Box<Io>,
		op:     Op,
		/// A finished read's bytes not handed out yet: `io.buf[start..end]`.
		start:  usize,
		end:    usize,
		eof:    bool,
		handle: OwnedHandle,
	}

	impl WinEnd {
		fn new(handle: OwnedHandle) -> io::Result<Self> {
			// SAFETY: auto-reset, initially unsignaled, anonymous event.
			let event = owned(unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) })?;
			let io = Box::new(Io {
				ov: OVERLAPPED::default(),
				event,
				buf: vec![0; BUF].into_boxed_slice(),
			});
			Ok(Self {
				wait: None,
				slot: Arc::default(),
				io,
				op: Op::Idle,
				start: 0,
				end: 0,
				eof: false,
				handle,
			})
		}

		/// A fresh OVERLAPPED for the next operation.
		fn reset(&mut self) -> *mut OVERLAPPED {
			self.io.ov = OVERLAPPED { hEvent: raw(&self.io.event), ..OVERLAPPED::default() };
			&raw mut self.io.ov
		}

		/// The result of the operation in flight; `None` while it runs.
		fn finished(&self) -> Option<io::Result<usize>> {
			let mut n = 0u32;
			// SAFETY: the OVERLAPPED of the operation in flight on our handle;
			// no wait (the event belongs to the thread-pool wait).
			if unsafe { GetOverlappedResult(raw(&self.handle), &raw const self.io.ov, &raw mut n, 0) }
				!= 0
			{
				return Some(Ok(n as usize));
			}
			let e = io::Error::last_os_error();
			if is_os(&e, ERROR_IO_INCOMPLETE) {
				None
			} else {
				Some(Err(e))
			}
		}

		/// Ready with the result of the operation in flight; else the waker
		/// is stored for the completion callback.
		fn poll_op(&mut self, cx: &Context<'_>) -> Poll<io::Result<usize>> {
			if let Some(r) = self.finished() {
				return Poll::Ready(r);
			}
			if self.wait.is_none() {
				match Registered::new(raw(&self.io.event), &self.slot, INFINITE, false) {
					Ok(w) => self.wait = Some(w),
					Err(e) => return Poll::Ready(Err(e)),
				}
			}
			self.slot.set(cx.waker());
			// Completed before the waker was stored: its callback found none.
			match self.finished() {
				Some(r) => Poll::Ready(r),
				None => Poll::Pending,
			}
		}

		/// Start a read into the buffer: `Some` when it completed at once.
		fn start_read(&mut self) -> io::Result<Option<usize>> {
			let ov = self.reset();
			let cap = self.io.buf.len() as u32;
			// SAFETY: buffer and OVERLAPPED live in `self.io` (boxed) until the
			// read completes; `Drop` cancels it and waits for it first.
			let ok = unsafe {
				ReadFile(raw(&self.handle), self.io.buf.as_mut_ptr(), cap, ptr::null_mut(), ov)
			};
			self.started(ok)
		}

		/// Start writing the first `len` bytes of the buffer.
		fn start_write(&mut self, len: usize) -> io::Result<Option<usize>> {
			let ov = self.reset();
			// SAFETY: as in `start_read`.
			let ok = unsafe {
				WriteFile(raw(&self.handle), self.io.buf.as_ptr(), len as u32, ptr::null_mut(), ov)
			};
			self.started(ok)
		}

		fn started(&self, ok: windows_sys::core::BOOL) -> io::Result<Option<usize>> {
			if ok != 0 {
				// Completed synchronously; the count is in the OVERLAPPED.
				return match self.finished() {
					Some(r) => r.map(Some),
					None => Ok(None),
				};
			}
			let e = io::Error::last_os_error();
			if is_os(&e, ERROR_IO_PENDING) {
				Ok(None)
			} else {
				Err(e)
			}
		}

		/// Take a finished read's result into `start..end` / `eof`.
		fn took(&mut self, r: io::Result<usize>) -> io::Result<()> {
			self.op = Op::Idle;
			match r {
				// A zero-byte write on the other end completes a read with
				// nothing: not the end of the stream.
				Ok(n) => {
					self.start = 0;
					self.end = n;
					Ok(())
				},
				Err(e) if hung_up(&e) => {
					self.eof = true;
					Ok(())
				},
				Err(e) => Err(e),
			}
		}

		pub fn poll_read(&mut self, cx: &Context<'_>, out: &mut [u8]) -> Poll<io::Result<usize>> {
			loop {
				if self.start < self.end {
					let n = out.len().min(self.end - self.start);
					out[..n].copy_from_slice(&self.io.buf[self.start..self.start + n]);
					self.start += n;
					return Poll::Ready(Ok(n));
				}
				if self.eof || out.is_empty() {
					return Poll::Ready(Ok(0));
				}
				let r = match self.op {
					Op::Idle => match self.start_read() {
						Ok(Some(n)) => Ok(n),
						Ok(None) => {
							self.op = Op::Reading;
							continue;
						},
						Err(e) => Err(e),
					},
					Op::Reading => std::task::ready!(self.poll_op(cx)),
					Op::Writing { .. } => return Poll::Ready(Err(io::ErrorKind::Unsupported.into())),
				};
				if let Err(e) = self.took(r) {
					return Poll::Ready(Err(e));
				}
			}
		}

		/// Wait for the write in flight; a partial one is resubmitted.
		fn poll_settle(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			loop {
				let Op::Writing { len } = self.op else {
					return Poll::Ready(Ok(()));
				};
				let r = std::task::ready!(self.poll_op(cx));
				self.op = Op::Idle;
				let n = r?;
				if n >= len {
					return Poll::Ready(Ok(()));
				}
				self.io.buf.copy_within(n..len, 0);
				if self.start_write(len - n)?.is_none() {
					self.op = Op::Writing { len: len - n };
				}
			}
		}

		/// Write behind: the bytes are copied and accepted at once, and the
		/// next write (or flush) waits for them to be in the pipe.
		pub fn poll_write(&mut self, cx: &Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
			if let Err(e) = std::task::ready!(self.poll_settle(cx)) {
				return Poll::Ready(Err(e));
			}
			if self.op == Op::Reading {
				return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
			}
			if data.is_empty() {
				return Poll::Ready(Ok(0));
			}
			let n = data.len().min(self.io.buf.len());
			self.io.buf[..n].copy_from_slice(&data[..n]);
			Poll::Ready(match self.start_write(n) {
				Ok(Some(done)) if done < n => {
					// Short synchronous write: the rest stays in flight.
					self.io.buf.copy_within(done..n, 0);
					match self.start_write(n - done) {
						Ok(None) => {
							self.op = Op::Writing { len: n - done };
							Ok(n)
						},
						Ok(Some(_)) => Ok(n),
						Err(e) => Err(e),
					}
				},
				Ok(Some(_)) => Ok(n),
				Ok(None) => {
					self.op = Op::Writing { len: n };
					Ok(n)
				},
				Err(e) => Err(e),
			})
		}

		pub fn poll_flush(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			self.poll_settle(cx)
		}

		pub fn available(&mut self) -> io::Result<usize> {
			if self.op == Op::Reading
				&& let Some(r) = self.finished()
			{
				self.took(r)?;
			}
			let mut waiting = 0u32;
			// SAFETY: a zero-size peek on our open pipe handle takes no buffer
			// and reports the bytes waiting.
			let ok = unsafe {
				PeekNamedPipe(
					raw(&self.handle),
					ptr::null_mut(),
					0,
					ptr::null_mut(),
					&raw mut waiting,
					ptr::null_mut(),
				)
			};
			if ok == 0 {
				let e = io::Error::last_os_error();
				if !hung_up(&e) {
					return Err(e);
				}
				waiting = 0;
			}
			Ok(self.end - self.start + waiting as usize)
		}

		/// Stop the operation in flight and wait for it to end (cancellation
		/// of pipe I/O completes at once); the bytes it moved.
		fn cancel(&mut self) -> usize {
			// No callback may run once we wait on the event ourselves.
			self.wait = None;
			// SAFETY: the operation in flight on our handle.
			unsafe { CancelIoEx(raw(&self.handle), &raw const self.io.ov) };
			let mut n = 0u32;
			// SAFETY: waits for that operation; nobody else waits on its event.
			let ok = unsafe {
				GetOverlappedResult(raw(&self.handle), &raw const self.io.ov, &raw mut n, 1)
			};
			self.op = Op::Idle;
			if ok == 0 { 0 } else { n as usize }
		}

		pub fn close(mut self) -> Vec<u8> {
			match self.op {
				Op::Writing { len } => {
					let sent = self.cancel().min(len);
					self.io.buf[sent..len].to_vec()
				},
				Op::Reading | Op::Idle => Vec::new(),
			}
		}
	}

	impl Drop for WinEnd {
		fn drop(&mut self) {
			if self.op != Op::Idle {
				self.cancel();
			}
		}
	}

	pub struct TimerImp {
		/// Declared first: unregistered before the event closes.
		wait:     Option<Registered>,
		slot:     Arc<Slot>,
		/// Never signaled: the registered wait ends by its timeout.
		event:    Option<OwnedHandle>,
		deadline: Instant,
	}

	impl TimerImp {
		pub fn new(deadline: Instant) -> Self {
			Self { wait: None, slot: Arc::default(), event: None, deadline }
		}

		pub fn poll(&mut self, cx: &Context<'_>) -> Poll<()> {
			let now = Instant::now();
			if now >= self.deadline {
				return Poll::Ready(());
			}
			self.slot.set(cx.waker());
			if self.wait.is_none() {
				// SAFETY: manual-reset, unsignaled, anonymous event.
				let Ok(event) = owned(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) }) else {
					return Poll::Ready(());
				};
				// Rounded up, so the wake never comes before the deadline.
				let ms = (self.deadline - now).as_millis().saturating_add(1).min(u128::from(INFINITE - 1));
				match Registered::new(raw(&event), &self.slot, ms as u32, true) {
					Ok(w) => {
						self.event = Some(event);
						self.wait = Some(w);
					},
					Err(_) => return Poll::Ready(()),
				}
			}
			if Instant::now() >= self.deadline {
				Poll::Ready(())
			} else {
				Poll::Pending
			}
		}
	}
}
