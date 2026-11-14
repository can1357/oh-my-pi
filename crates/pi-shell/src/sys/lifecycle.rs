//! Lifecycle of one spawned external, shared by its `ExtProc` (which polls
//! its pumps) and its waiter: exit observation, output drain, abandonment
//! (the `ExtProc` dropped before the engine collected the exit) and the
//! TERM → KILL escalation.
//!
//! The transitions are platform-neutral and tested everywhere; the platform
//! spawners perform the side effects a transition asks for, while holding
//! the [`Tracker`] lock where a signal must not race the reap.

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll, Waker},
	time::{Duration, Instant},
};

use parking_lot::{Mutex, MutexGuard};

use crate::bash::{ExitStatus, ProcEvent, Signal};

/// State of one external.
#[derive(Debug, Default)]
pub struct Lifecycle {
	/// Exit status, once the waiter has observed it (the process may still be
	/// an unreaped zombie).
	status:    Option<ExitStatus>,
	/// [`Lifecycle::poll`] handed the status to the engine.
	collected: bool,
	/// A stop or continue the waiter observed that [`Lifecycle::poll_event`]
	/// has not reported yet (the later of two unseen ones).
	#[cfg_attr(not(unix), expect(dead_code, reason = "stop/continue events are unix job control"))]
	change:    Option<ProcEvent>,
	/// Output pumps that have not reached end of file yet: the command is
	/// complete only once its output has been delivered.
	draining:  usize,
	waker:     Option<Waker>,
	/// The `ExtProc` was dropped: whoever observes the exit last reaps.
	abandoned: bool,
	term_sent: bool,
	kill_due:  Option<Instant>,
	kill_sent: bool,
}

/// What dropping the `ExtProc` must do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Abandon {
	/// The engine collected the exit: reap it now (Unix) or just release it.
	Exited,
	/// The process exited, but the engine dropped it without collecting the
	/// exit (a cancel racing the exit): what it left in its scope is
	/// abandoned like a running process's. Send TERM to the scope when
	/// `term`, reap the process (Unix), and sweep the scope at `sweep_at`.
	Orphaned {
		/// TERM still has to be sent.
		term:     bool,
		/// When the stragglers are killed.
		sweep_at: Instant,
	},
	/// Still running: send TERM now when `term` (it was not sent before) and
	/// KILL at `kill_at` unless it exits first.
	Escalate {
		/// TERM still has to be sent.
		term:    bool,
		/// KILL deadline.
		kill_at: Instant,
	},
}

impl Lifecycle {
	/// A process whose output flows through `draining` pumps.
	pub const fn new(draining: usize) -> Self {
		Self {
			status: None,
			collected: false,
			change: None,
			draining,
			waker: None,
			abandoned: false,
			term_sent: false,
			kill_due: None,
			kill_sent: false,
		}
	}

	/// Ready once the process has exited and its output pumps have drained.
	pub fn poll(&mut self, cx: &Context<'_>) -> Poll<ExitStatus> {
		match self.status {
			Some(status) if self.draining == 0 => {
				self.collected = true;
				Poll::Ready(status)
			},
			_ => {
				self.set_waker(cx.waker());
				Poll::Pending
			},
		}
	}

	/// [`Lifecycle::poll`], reporting first a stop or continue observed
	/// since the last call (once each); an exit makes it moot.
	#[cfg_attr(not(unix), expect(dead_code, reason = "stop/continue events are unix job control"))]
	pub fn poll_event(&mut self, cx: &Context<'_>) -> Poll<ProcEvent> {
		if self.status.is_none()
			&& let Some(change) = self.change.take()
		{
			return Poll::Ready(change);
		}
		self.poll(cx).map(ProcEvent::Exited)
	}

	/// The waiter observed a stop or continue of the running process.
	/// Returns the waker to wake (outside the lock).
	#[cfg_attr(not(unix), expect(dead_code, reason = "stop/continue events are unix job control"))]
	pub const fn changed(&mut self, change: ProcEvent) -> Option<Waker> {
		self.change = Some(change);
		self.waker.take()
	}

	/// Wake `waker` at the next transition.
	fn set_waker(&mut self, waker: &Waker) {
		if !self.waker.as_ref().is_some_and(|w| w.will_wake(waker)) {
			self.waker = Some(waker.clone());
		}
	}

	/// The waiter observed the exit. Returns the waker to wake (outside the
	/// lock) and whether the waiter must reap now because the `ExtProc` is
	/// gone.
	pub const fn exited(&mut self, status: ExitStatus) -> (Option<Waker>, bool) {
		self.status = Some(status);
		self.kill_due = None;
		let waker = if self.draining == 0 {
			self.waker.take()
		} else {
			None
		};
		(waker, self.abandoned)
	}

	/// An output pump reached end of file.
	pub const fn drained(&mut self) -> Option<Waker> {
		self.draining = self.draining.saturating_sub(1);
		if self.draining == 0 && self.status.is_some() {
			self.waker.take()
		} else {
			None
		}
	}

	/// `sig` was sent to the process's group or job.
	pub const fn signalled(&mut self, sig: Signal) {
		match sig {
			Signal::Term => self.term_sent = true,
			Signal::Kill => {
				self.kill_sent = true;
				self.kill_due = None;
			},
			_ => {},
		}
	}

	/// Schedule KILL at `at` (keeps an earlier deadline); no-op once exited
	/// or killed.
	pub fn schedule_kill(&mut self, at: Instant) {
		if self.status.is_some() || self.kill_sent {
			return;
		}
		self.kill_due = Some(self.kill_due.map_or(at, |due| due.min(at)));
	}

	/// The `ExtProc` is dropped at `now`.
	pub fn abandon(&mut self, now: Instant, grace: Duration) -> Abandon {
		self.abandoned = true;
		if self.collected {
			return Abandon::Exited;
		}
		let term = !self.term_sent && !self.kill_sent;
		self.term_sent = true;
		let kill_at = now + grace;
		if self.status.is_some() {
			return Abandon::Orphaned { term, sweep_at: kill_at };
		}
		self.schedule_kill(kill_at);
		Abandon::Escalate { term, kill_at: self.kill_due.unwrap_or(kill_at) }
	}

	/// The `ExtProc` of a detached external ([`crate::bash::Lineage::detached`])
	/// is dropped: unlike [`Lifecycle::abandon`] nothing is signalled, the
	/// process runs on and whoever observes its exit reaps it. Returns
	/// whether it has exited already (reap it now).
	pub const fn release(&mut self) -> bool {
		self.abandoned = true;
		self.status.is_some()
	}

	/// Whether the exit has been observed.
	#[cfg_attr(
		not(target_os = "linux"),
		expect(dead_code, reason = "only Linux externals observe their own exit (pidfd)")
	)]
	pub const fn has_exited(&self) -> bool {
		self.status.is_some()
	}

	/// Pending KILL deadline; `None` once exited, killed or never scheduled.
	pub const fn kill_due(&self) -> Option<Instant> {
		if self.status.is_some() {
			None
		} else {
			self.kill_due
		}
	}

	/// Whether KILL must be sent at `now`; marks it sent.
	pub fn take_kill(&mut self, now: Instant) -> bool {
		match self.kill_due() {
			Some(due) if due <= now => {
				self.kill_due = None;
				self.kill_sent = true;
				true
			},
			_ => false,
		}
	}

	/// Whether KILL was sent (by the escalation or [`Lifecycle::signalled`]).
	#[cfg(test)]
	pub const fn kill_sent(&self) -> bool {
		self.kill_sent
	}

	/// Output pumps that have not drained yet.
	#[cfg(all(test, unix))]
	pub const fn draining(&self) -> usize {
		self.draining
	}
}

/// The lifecycle plus the input-pump cancellation shared by an `ExtProc`
/// (whose `poll_wait` polls the pumps) and its waiter.
#[derive(Debug)]
pub struct Tracker {
	life:   Mutex<Lifecycle>,
	cancel: AtomicBool,
}

impl Tracker {
	/// Tracker of a process with `draining` output pumps.
	pub fn new(draining: usize) -> Arc<Self> {
		Arc::new(Self {
			life:   Mutex::new(Lifecycle::new(draining)),
			cancel: AtomicBool::new(false),
		})
	}

	/// Lock the lifecycle. Signals that must not hit a reaped (recycled)
	/// process are sent while holding it: reaping happens only after the
	/// exit is recorded under this lock.
	pub fn lock(&self) -> MutexGuard<'_, Lifecycle> {
		self.life.lock()
	}

	/// [`Lifecycle::poll`].
	pub fn poll(&self, cx: &Context<'_>) -> Poll<ExitStatus> {
		self.life.lock().poll(cx)
	}

	/// [`Lifecycle::poll_event`].
	#[cfg_attr(not(unix), expect(dead_code, reason = "stop/continue events are unix job control"))]
	pub fn poll_event(&self, cx: &Context<'_>) -> Poll<ProcEvent> {
		self.life.lock().poll_event(cx)
	}

	/// [`Lifecycle::changed`], waking the poller.
	#[cfg_attr(not(unix), expect(dead_code, reason = "stop/continue events are unix job control"))]
	pub fn changed(&self, change: ProcEvent) {
		let waker = self.life.lock().changed(change);
		if let Some(w) = waker {
			w.wake();
		}
	}

	/// [`Lifecycle::exited`], waking the poller; returns whether to reap.
	/// Input pumps stop: nothing reads the child's stdin any more (a
	/// grandchild still reading it loses the rest, by design).
	pub fn exited(&self, status: ExitStatus) -> bool {
		self.cancel_pumps();
		let (waker, reap) = self.life.lock().exited(status);
		if let Some(w) = waker {
			w.wake();
		}
		reap
	}

	/// [`Lifecycle::drained`], waking the poller.
	pub fn drained(&self) {
		let waker = self.life.lock().drained();
		if let Some(w) = waker {
			w.wake();
		}
	}

	/// Stop the input pumps (the process is done or never started). They
	/// are polled by the `ExtProc`, which drops them at its next poll: the
	/// first cancel wakes it, also while output still drains.
	pub fn cancel_pumps(&self) {
		if self.cancel.swap(true, Ordering::SeqCst) {
			return;
		}
		let waker = self.life.lock().waker.clone();
		if let Some(w) = waker {
			w.wake();
		}
	}

	/// Whether input pumps must stop. `waker` (the poller's) is registered
	/// first, so a cancel that this answer misses wakes it.
	pub fn pumps_cancelled(&self, waker: &Waker) -> bool {
		self.life.lock().set_waker(waker);
		self.cancel.load(Ordering::SeqCst)
	}
}

#[cfg(test)]
mod tests {
	use std::{sync::Arc, task::Wake};

	use super::*;

	struct Flag(AtomicBool);

	impl Wake for Flag {
		fn wake(self: Arc<Self>) {
			self.0.store(true, Ordering::SeqCst);
		}
	}

	fn waker() -> (Arc<Flag>, Waker) {
		let flag = Arc::new(Flag(AtomicBool::new(false)));
		(Arc::clone(&flag), Waker::from(flag))
	}

	#[test]
	fn completion_waits_for_exit_and_every_output_pump() {
		let mut life = Lifecycle::new(2);
		let (flag, w) = waker();
		let cx = Context::from_waker(&w);
		assert_eq!(life.poll(&cx), Poll::Pending);
		assert!(life.drained().is_none(), "one pump still draining");
		let (wake, reap) = life.exited(ExitStatus::Exited(3));
		assert!(wake.is_none() && !reap, "output pending, ExtProc alive");
		assert_eq!(life.poll(&cx), Poll::Pending);
		life.drained().expect("last drain wakes").wake();
		assert!(flag.0.load(Ordering::SeqCst));
		assert_eq!(life.poll(&cx), Poll::Ready(ExitStatus::Exited(3)));
	}

	#[test]
	fn drop_after_collect_reaps_and_drop_before_exit_escalates_once() {
		let now = Instant::now();
		let grace = Duration::from_secs(2);
		let (_, w) = waker();
		let mut done = Lifecycle::new(0);
		done.exited(ExitStatus::Exited(0));
		assert_eq!(done.poll(&Context::from_waker(&w)), Poll::Ready(ExitStatus::Exited(0)));
		assert_eq!(done.abandon(now, grace), Abandon::Exited);

		let mut running = Lifecycle::new(0);
		running.signalled(Signal::Term);
		assert_eq!(
			running.abandon(now, grace),
			Abandon::Escalate { term: false, kill_at: now + grace },
			"TERM already sent by the engine's cancel is not repeated"
		);
		assert!(!running.take_kill(now + grace / 2), "grace not over");
		assert!(running.take_kill(now + grace));
		assert!(!running.take_kill(now + grace * 2), "KILL is sent once");
		assert!(running.kill_sent());
	}

	/// A cancel's drop can land just after the TERM it sent ended the
	/// process: the engine never saw the exit, so what the process left in
	/// its scope is swept as if it had exited during the grace.
	#[test]
	fn exit_the_engine_never_collected_still_sweeps_after_the_grace() {
		let now = Instant::now();
		let grace = Duration::from_secs(2);
		let mut life = Lifecycle::new(0);
		life.signalled(Signal::Term);
		life.exited(ExitStatus::Signaled(Signal::Term));
		assert_eq!(life.abandon(now, grace), Abandon::Orphaned {
			term:     false,
			sweep_at: now + grace,
		});
		assert!(!life.take_kill(now + grace), "the exited process itself is never KILLed");
	}

	#[test]
	fn exit_during_grace_cancels_kill_and_tells_the_waiter_to_reap() {
		let now = Instant::now();
		let mut life = Lifecycle::new(0);
		let Abandon::Escalate { term, .. } = life.abandon(now, Duration::from_millis(10)) else {
			panic!("running process escalates");
		};
		assert!(term);
		let (_, reap) = life.exited(ExitStatus::Signaled(Signal::Term));
		assert!(reap, "the ExtProc is gone: the waiter reaps");
		assert_eq!(life.kill_due(), None);
		assert!(!life.take_kill(now + Duration::from_secs(1)));
	}

	#[test]
	fn earlier_kill_deadline_wins_and_explicit_kill_clears_it() {
		let now = Instant::now();
		let mut life = Lifecycle::new(0);
		life.schedule_kill(now + Duration::from_secs(5));
		life.schedule_kill(now + Duration::from_secs(1));
		assert_eq!(life.kill_due(), Some(now + Duration::from_secs(1)));
		life.signalled(Signal::Kill);
		assert_eq!(life.kill_due(), None);
		life.schedule_kill(now);
		assert_eq!(life.kill_due(), None, "nothing to escalate after KILL");
	}
}
