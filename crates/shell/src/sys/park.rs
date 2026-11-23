//! Parking the engine thread until the shell may make progress.
//!
//! A [`Parker`] is a drive loop's blocking primitive: [`Parker::waker`] is the
//! waker the loop hands the engine, [`Parker::park`] blocks until that waker
//! is woken (or the timeout passes).
//!
//! On Linux it also waits for the exits of externals spawned with
//! [`Exits::Park`](crate::sys::Exits::Park): the parked thread blocks in
//! `poll(2)` on an eventfd (the waker) plus a pidfd per awaited external, so an
//! exit wakes the engine thread directly, as bash's blocking `waitpid` does.
//! With a waiter thread per external the exit wakes the waiter, which wakes the
//! engine thread: two more thread switches per external, and a third to hand
//! the waiter its next pid. A signal handler that runs during the park ends
//! it too (`poll` fails with `EINTR` whatever `SA_RESTART` says). Elsewhere
//! the thread parks (`thread::park_timeout`) and externals keep their waiter
//! threads.

use std::{
	sync::{
		Arc,
		atomic::{AtomicU8, Ordering},
	},
	task::Waker,
	thread::{self, Thread},
	time::Duration,
};

/// Neither parked nor woken since the last park.
const EMPTY: u8 = 0;
/// Parked (in `poll`, or `thread::park_timeout`).
const PARKED: u8 = 1;
/// Woken while not parked: the next park returns at once.
const NOTIFIED: u8 = 2;

/// Blocks the thread that created it until its [`waker`](Parker::waker) is
/// woken, an awaited external exits (Linux), or a timeout passes. Only that
/// thread may [`park`](Parker::park).
pub struct Parker {
	bell:  Arc<Bell>,
	waker: Waker,
	/// Reused per park: the poll set (eventfd first, then the pidfds) and
	/// the pid of each pidfd.
	#[cfg(target_os = "linux")]
	fds:   Vec<libc::pollfd>,
	#[cfg(target_os = "linux")]
	pids:  Vec<i32>,
	#[cfg(target_os = "linux")]
	ready: Vec<Waker>,
}

/// The waker's side of a [`Parker`].
struct Bell {
	/// Linux: written only while the parker sits in `poll`. Created at the
	/// first park, not with the parker: `obash` creates its parker before
	/// it takes over the fds it inherited, by listing every open fd. `None`
	/// (no eventfd could be created; other platforms): the thread is
	/// unparked.
	#[cfg(target_os = "linux")]
	fd:     std::sync::OnceLock<Option<std::os::fd::OwnedFd>>,
	thread: Thread,
	state:  AtomicU8,
}

impl std::task::Wake for Bell {
	fn wake(self: Arc<Self>) {
		self.ring();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.ring();
	}
}

impl Bell {
	/// End the current park, or make the next one return at once. A
	/// syscall only when the thread is actually parked.
	fn ring(&self) {
		if self.state.swap(NOTIFIED, Ordering::AcqRel) != PARKED {
			return;
		}
		#[cfg(target_os = "linux")]
		if let Some(Some(fd)) = self.fd.get() {
			use std::os::fd::AsRawFd;
			let one: u64 = 1;
			// SAFETY: writes 8 bytes from a live u64 to our eventfd; a full
			// counter (EAGAIN) still leaves the fd readable.
			unsafe { libc::write(fd.as_raw_fd(), (&raw const one).cast(), 8) };
			return;
		}
		self.thread.unpark();
	}

	/// Park the thread itself (no eventfd).
	fn park_thread(&self, timeout: Duration) {
		if self
			.state
			.compare_exchange(EMPTY, PARKED, Ordering::AcqRel, Ordering::Acquire)
			.is_ok()
		{
			thread::park_timeout(timeout);
		}
		self.state.store(EMPTY, Ordering::Release);
	}

	/// The eventfd, created on first use; `None` when none could be.
	#[cfg(target_os = "linux")]
	fn fd(&self) -> Option<std::os::fd::RawFd> {
		use std::os::fd::AsRawFd;
		self
			.fd
			.get_or_init(exits::open_bell)
			.as_ref()
			.map(AsRawFd::as_raw_fd)
	}

	/// Whether the parker counts as one that waits for exits: until its
	/// eventfd turned out impossible.
	#[cfg(target_os = "linux")]
	fn counted(&self) -> bool {
		!matches!(self.fd.get(), Some(None))
	}
}

impl Parker {
	/// A parker for the calling thread.
	pub fn new() -> Self {
		#[cfg(target_os = "linux")]
		exits::parker_new();
		let bell = Arc::new(Bell {
			#[cfg(target_os = "linux")]
			fd: std::sync::OnceLock::new(),
			thread: thread::current(),
			state: AtomicU8::new(EMPTY),
		});
		Self {
			waker: Waker::from(Arc::clone(&bell)),
			bell,
			#[cfg(target_os = "linux")]
			fds: Vec::new(),
			#[cfg(target_os = "linux")]
			pids: Vec::new(),
			#[cfg(target_os = "linux")]
			ready: Vec::new(),
		}
	}

	/// The waker that ends a park (or makes the next one return at once).
	pub const fn waker(&self) -> &Waker {
		&self.waker
	}

	/// Block until the waker is woken, an awaited external exits or a signal
	/// handler runs (Linux), or `timeout` passes. May return early: the
	/// caller rechecks what it waits for. First advances the output work of
	/// externals whose `ExtProc` is gone
	/// ([`NativeSpawner::poll_orphans`](crate::sys::NativeSpawner::poll_orphans)),
	/// which wakes this parker when it can go on.
	pub fn park(&mut self, timeout: Duration) {
		self.poll_orphans();
		#[cfg(target_os = "linux")]
		if let Some(fd) = self.bell.fd() {
			self.park_poll(fd, timeout);
			return;
		}
		self.bell.park_thread(timeout);
	}

	/// `poll` on the eventfd `fd` and the pidfds of the awaited externals;
	/// wake the external of each pidfd that became readable.
	#[cfg(target_os = "linux")]
	fn park_poll(&mut self, fd: std::os::fd::RawFd, timeout: Duration) {
		let bell = &*self.bell;
		if bell
			.state
			.compare_exchange(EMPTY, PARKED, Ordering::AcqRel, Ordering::Acquire)
			.is_err()
		{
			bell.state.store(EMPTY, Ordering::Release);
			return;
		}
		self.fds.clear();
		self.pids.clear();
		self
			.fds
			.push(libc::pollfd { fd, events: libc::POLLIN, revents: 0 });
		exits::poll_set(&mut self.fds, &mut self.pids);
		let ms =
			libc::c_int::try_from(timeout.as_nanos().div_ceil(1_000_000)).unwrap_or(libc::c_int::MAX);
		let n = poll(&mut self.fds, ms);
		// A ring after `poll` returned writes the eventfd once more: the next
		// park returns at once and drains it (spurious, never lost).
		bell.state.store(EMPTY, Ordering::Release);
		if n <= 0 {
			// Timeout, a signal handler ran (EINTR), or an error: the caller
			// rechecks either way.
			return;
		}
		if self.fds[0].revents != 0 {
			let mut count: u64 = 0;
			// SAFETY: reads 8 bytes into a live u64 from our non-blocking
			// eventfd.
			unsafe { libc::read(fd, (&raw mut count).cast(), 8) };
		}
		exits::take_ready(&self.fds[1..], &self.pids, &mut self.ready);
		for w in self.ready.drain(..) {
			w.wake();
		}
	}

	/// Advance retained output work of gone `ExtProc`s with this parker's
	/// waker (no runtime drives it here).
	fn poll_orphans(&self) {
		super::pump::orphan::poll(&std::task::Context::from_waker(&self.waker));
	}

	/// Wake the awaited externals that have exited, without blocking: a
	/// drive loop calls it between steps, so a background external's exit
	/// is noticed while the engine thread never parks (a busy foreground).
	/// Also advances the output work of gone `ExtProc`s.
	pub fn poll_exits(&mut self) {
		self.poll_orphans();
		#[cfg(target_os = "linux")]
		if self.bell.counted() {
			self.fds.clear();
			self.pids.clear();
			exits::poll_set(&mut self.fds, &mut self.pids);
			if !self.fds.is_empty() && poll(&mut self.fds, 0) > 0 {
				exits::take_ready(&self.fds, &self.pids, &mut self.ready);
				for w in self.ready.drain(..) {
					w.wake();
				}
			}
		}
	}
}

/// `poll(2)` on `fds` for up to `ms` milliseconds: the number of ready fds,
/// 0 on timeout, negative on error (`EINTR`: a signal handler ran).
#[cfg(target_os = "linux")]
fn poll(fds: &mut [libc::pollfd], ms: libc::c_int) -> libc::c_int {
	// SAFETY: `fds` is a valid, writable array of `fds.len()` pollfds.
	unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, ms) }
}

impl Default for Parker {
	fn default() -> Self {
		Self::new()
	}
}

#[cfg(target_os = "linux")]
impl Drop for Parker {
	fn drop(&mut self) {
		if self.bell.counted() {
			exits::parker_gone();
		}
	}
}

/// Externals the parkers of this process wait for (Linux).
#[cfg(target_os = "linux")]
pub mod exits {
	use std::{
		os::fd::{FromRawFd, OwnedFd, RawFd},
		task::Waker,
	};

	use parking_lot::Mutex;

	/// An awaited external: its pid, pidfd and the waker to wake at its exit.
	struct Exit {
		pid:   i32,
		fd:    RawFd,
		waker: Waker,
	}

	/// The awaited externals and the number of live parkers that wait for
	/// exits (under one lock: an external is registered only while a parker
	/// that will wait for it exists).
	struct Registry {
		exits:   Vec<Exit>,
		parkers: usize,
	}

	static REGISTRY: Mutex<Registry> = Mutex::new(Registry { exits: Vec::new(), parkers: 0 });

	/// A new parker: it waits for exits until its eventfd fails.
	pub(super) fn parker_new() {
		REGISTRY.lock().parkers += 1;
	}

	/// A parker's eventfd (first park). Without one the parker no longer
	/// waits for exits ([`parker_gone`]).
	pub(super) fn open_bell() -> Option<OwnedFd> {
		// SAFETY: plain syscall; the result is checked.
		let fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
		if fd < 0 {
			parker_gone();
			return None;
		}
		// SAFETY: a successful eventfd returned a descriptor we own.
		Some(unsafe { OwnedFd::from_raw_fd(fd) })
	}

	/// A parker stops waiting for exits (dropped, or without an eventfd).
	/// When it was the last, the externals awaiting it are woken: their next
	/// poll hands them to a waiter thread.
	pub(super) fn parker_gone() {
		let orphaned = {
			let mut reg = REGISTRY.lock();
			reg.parkers -= 1;
			if reg.parkers > 0 {
				return;
			}
			std::mem::take(&mut reg.exits)
		};
		for e in orphaned {
			e.waker.wake();
		}
	}

	/// Append a pollfd per awaited external to `fds`, its pid to `pids`.
	pub(super) fn poll_set(fds: &mut Vec<libc::pollfd>, pids: &mut Vec<i32>) {
		let reg = REGISTRY.lock();
		for e in &reg.exits {
			fds.push(libc::pollfd { fd: e.fd, events: libc::POLLIN, revents: 0 });
			pids.push(e.pid);
		}
	}

	/// Unregister the externals whose pidfd in `fds` became readable; their
	/// wakers go to `ready` (woken by the caller, outside the lock).
	pub(super) fn take_ready(fds: &[libc::pollfd], pids: &[i32], ready: &mut Vec<Waker>) {
		let mut reg = REGISTRY.lock();
		for (pfd, &pid) in fds.iter().zip(pids) {
			if pfd.revents == 0 {
				continue;
			}
			if let Some(i) = reg
				.exits
				.iter()
				.position(|e| e.pid == pid && e.fd == pfd.fd)
			{
				ready.push(reg.exits.swap_remove(i).waker);
			}
		}
	}

	/// Have the next park wake `waker` once pidfd `fd` of `pid` is readable
	/// (the process exited). `false` when no parker waits for exits: the
	/// caller needs a waiter thread.
	pub fn await_exit(pid: i32, fd: RawFd, waker: &Waker) -> bool {
		let mut reg = REGISTRY.lock();
		if reg.parkers == 0 {
			return false;
		}
		if let Some(e) = reg.exits.iter_mut().find(|e| e.pid == pid) {
			// `Waker::clone_from` keeps the old one when it wakes the same task.
			e.waker.clone_from(waker);
		} else {
			reg.exits.push(Exit { pid, fd, waker: waker.clone() });
		}
		true
	}

	/// Stop waiting for `pid` (before its pidfd closes).
	pub fn forget(pid: i32) {
		let mut reg = REGISTRY.lock();
		if let Some(i) = reg.exits.iter().position(|e| e.pid == pid) {
			reg.exits.swap_remove(i);
		}
	}
}
