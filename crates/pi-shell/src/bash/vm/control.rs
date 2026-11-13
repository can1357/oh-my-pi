//! The control word, the engine waker, and the handles hosts drive them with.
//!
//! One `Ctl` per shell. Requests from any thread set bits in an atomic word
//! that the dispatch loop loads before every op (the safepoint check), and
//! bump the wake counter so a host waiting after `Step::Blocked` or
//! `Step::Paused` steps again. The same counter is the engine waker: every
//! `Task`, `ExtProc`, `FsPending` and `File` is polled with a `Context` built
//! from it.

use std::{
	io,
	sync::{
		Arc,
		atomic::{AtomicU8, AtomicU32, AtomicU64, Ordering},
	},
	task::{Context, Poll, Wake, Waker},
};

use parking_lot::Mutex;

use crate::bash::{
	ids::JobId,
	signal::{SigTarget, Signal},
};

pub const PAUSE: u32 = 1;
pub const RESUME: u32 = 1 << 1;
pub const CANCEL: u32 = 1 << 2;
pub const SUSPEND: u32 = 1 << 3;
pub const SIGNAL: u32 = 1 << 4;

/// Shared control state of one shell.
pub struct Ctl {
	word:       AtomicU32,
	cancel_sig: AtomicU8,
	/// Bumped by every wake and request.
	wakes:      AtomicU64,
	/// `wakes` when the shell last returned `Blocked`/`Paused`.
	parked:     AtomicU64,
	waiters:    Mutex<Vec<Waker>>,
	signals:    Mutex<Vec<(SigTarget, Signal)>>,
}

impl Ctl {
	pub(crate) fn new() -> Arc<Self> {
		Arc::new(Self {
			word:       AtomicU32::new(0),
			cancel_sig: AtomicU8::new(Signal::Term as u8),
			wakes:      AtomicU64::new(0),
			parked:     AtomicU64::new(0),
			waiters:    Mutex::new(Vec::new()),
			signals:    Mutex::new(Vec::new()),
		})
	}

	/// The safepoint check: non-zero when a request is pending.
	#[inline]
	pub(crate) fn word(&self) -> u32 {
		self.word.load(Ordering::Relaxed)
	}

	/// Take all pending request bits.
	pub(crate) fn take(&self) -> u32 {
		self.word.swap(0, Ordering::Acquire)
	}

	pub(crate) fn cancel_signal(&self) -> Signal {
		Signal::from_repr(self.cancel_sig.load(Ordering::Acquire)).unwrap_or(Signal::Term)
	}

	pub(crate) fn take_signals(&self) -> Vec<(SigTarget, Signal)> {
		std::mem::take(&mut *self.signals.lock())
	}

	#[inline]
	pub(crate) fn wakes(&self) -> u64 {
		self.wakes.load(Ordering::Acquire)
	}

	/// Record that the shell parked at wake count `at`.
	pub(crate) fn park(&self, at: u64) {
		self.parked.store(at, Ordering::Release);
	}

	/// Set request bits and wake the host. Not a wake of blocked vprocs:
	/// a pause/resume (the fault injector, a snapshot) must not change which
	/// vproc runs next. Requests that concern blocked vprocs (signals,
	/// cancel) unblock them where they are applied.
	pub(crate) fn request(&self, set: u32, clear: u32) {
		let _ = self
			.word
			.update(Ordering::AcqRel, Ordering::Acquire, |w| (w | set) & !clear);
		self.wake_waiters();
	}

	pub(crate) fn request_cancel(&self, sig: Signal) {
		self.cancel_sig.store(sig as u8, Ordering::Release);
		self.request(CANCEL, 0);
	}

	pub(crate) fn notify(&self) {
		self.wakes.fetch_add(1, Ordering::AcqRel);
		self.wake_waiters();
	}

	fn wake_waiters(&self) {
		let waiters = std::mem::take(&mut *self.waiters.lock());
		for w in waiters {
			w.wake();
		}
	}

	/// A restored shell continues the wake count of the externalized one,
	/// so the blocked vprocs' `at` marks keep their meaning.
	pub(crate) fn restore_wakes(&self, wakes: u64) {
		self.wakes.store(wakes, Ordering::Release);
	}

	/// Ready once the wake count moved past `since` or a request is pending.
	fn poll_since(&self, since: u64, cx: &Context<'_>) -> Poll<()> {
		if self.wakes() != since || self.word() != 0 {
			return Poll::Ready(());
		}
		{
			let mut waiters = self.waiters.lock();
			if !waiters.iter().any(|w| w.will_wake(cx.waker())) {
				waiters.push(cx.waker().clone());
			}
		}
		// A wake between the check and the registration is caught here.
		if self.wakes() != since || self.word() != 0 {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

impl Wake for Ctl {
	fn wake(self: Arc<Self>) {
		self.notify();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.notify();
	}
}

/// Thread-safe control of one shell (`Send + Sync`, cheap to clone).
///
/// Requests take effect at the next safepoint (before the next IR op of any
/// virtual process), or at the next [`Shell::step`](crate::bash::Shell::step)
/// when none is running.
#[derive(Clone)]
pub struct ControlHandle(pub(crate) Arc<Ctl>);

impl ControlHandle {
	/// Pause the whole shell: virtual processes park at their next safepoint,
	/// externals are stopped and tasks paused; `step` returns `Paused` until
	/// [`ControlHandle::resume`].
	pub fn pause(&self) {
		self.0.request(PAUSE, RESUME);
	}

	/// Pause one job. Jobs (background lists and pipelines) are not tracked
	/// yet: no process belongs to a job and this pauses nothing.
	pub fn pause_job(&self, job: JobId) {
		self
			.0
			.signals
			.lock()
			.push((SigTarget::Job(job), Signal::Stop));
		self.0.request(SIGNAL, 0);
	}

	/// Undo [`ControlHandle::pause`].
	pub fn resume(&self) {
		self.0.request(RESUME, PAUSE);
	}

	/// Cancel everything the shell runs except detached (`nohup`) trees and
	/// the background jobs the root's earlier scripts left running. `TERM`
	/// runs traps then unwinds (status 143), `KILL` unwinds without traps
	/// (137), `INT` follows bash's SIGINT semantics (130). Externals receive
	/// the signal; every cancelled script reports `Done` with that status.
	/// The shell stays usable.
	pub fn cancel(&self, sig: Signal) {
		self.0.request_cancel(sig);
	}

	/// Deliver a signal on the virtual signal bus (the `kill` builtin uses
	/// the same path).
	pub fn signal(&self, target: SigTarget, sig: Signal) {
		self.0.signals.lock().push((target, sig));
		self.0.request(SIGNAL, 0);
	}

	/// Ask the next `step` to drain to a global safepoint and return
	/// `SuspendReady` (see [`crate::bash::snapshot`] for the exact conditions).
	pub fn request_suspend(&self) {
		self.0.request(SUSPEND, 0);
	}

	/// Ready when stepping the shell may make progress again: an engine waker
	/// fired or a control request arrived since the shell last returned
	/// `Blocked` or `Paused`.
	///
	/// Hosts await this (e.g. through `std::future::poll_fn`) instead of
	/// spinning on `step`.
	pub fn poll_runnable(&self, cx: &mut Context<'_>) -> Poll<()> {
		self.0.poll_since(self.0.parked.load(Ordering::Acquire), cx)
	}
}

/// Readiness token of an [`IoPoll::WouldBlock`]: resolves once an engine
/// waker fires after the failed attempt; the callout then retries.
#[derive(Clone)]
pub struct WakeToken {
	pub(crate) ctl: Arc<Ctl>,
	pub(crate) at:  u64,
}

impl WakeToken {
	/// Ready after any engine wake since the token was issued (spurious
	/// readiness is possible; retry the operation).
	pub fn poll(&self, cx: &mut Context<'_>) -> Poll<()> {
		self.ctl.poll_since(self.at, cx)
	}
}

impl std::fmt::Debug for WakeToken {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("WakeToken").field("at", &self.at).finish()
	}
}

/// Result of a non-blocking fd operation of a host callout
/// ([`ShellApi`](crate::bash::ShellApi)).
#[derive(Debug)]
pub enum IoPoll<T> {
	/// Completed (or failed).
	Ready(io::Result<T>),
	/// Not possible now; await the token, then retry.
	WouldBlock(WakeToken),
}

/// The waker handed to everything the engine polls.
pub fn engine_waker(ctl: &Arc<Ctl>) -> Waker {
	Waker::from(Arc::clone(ctl))
}
