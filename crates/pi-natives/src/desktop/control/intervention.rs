//! The user's own keys and clicks in the apps a desktop session works in.
//!
//! A user who steps into an app the agent drives changes what the agent last
//! read there. Input aimed at an app the user has used since the session last
//! read it waits for them to pause, then fails without sending, so the agent
//! reads the window again before acting; keys already being typed stop at the
//! user's first key or click.
use std::{
	cell::RefCell,
	collections::HashMap,
	marker::PhantomData,
	rc::Rc,
	sync::Arc,
	time::{Duration, Instant},
};

use parking_lot::Mutex;

use super::{OperationToken, macos::UserInputMonitor};
use crate::desktop::error::{CoreResult, DesktopError};

/// How long the user leaves an app alone before a read of it shows what they
/// left there.
const QUIET: Duration = Duration::from_secs(5);
/// Time left before the run's deadline for the refusal to reach the caller.
const DEADLINE_MARGIN: Duration = Duration::from_millis(250);
const READ_AGAIN: &str =
	"read the window again (win.ax(), win.observe() or a screenshot) before acting on it";

struct App {
	name:   String,
	/// The user's key presses and clicks since the session first touched it.
	inputs: u64,
	/// When the user last pressed a key or clicked there, until a read shows it.
	unread: Option<Instant>,
}

/// The user's input into each app this session has read or sent input to,
/// shared by the tap thread and the session worker.
#[derive(Default)]
pub(crate) struct UserInputs(Mutex<HashMap<libc::pid_t, App>>);

impl UserInputs {
	/// Starts recording the user's input into `pid`. Input into an app before
	/// the session first reads it or acts on it is not the agent's concern.
	fn touch(&self, pid: libc::pid_t, name: impl FnOnce() -> String) {
		self
			.0
			.lock()
			.entry(pid)
			.or_insert_with(|| App { name: name(), inputs: 0, unread: None });
	}

	/// The user pressed a key or clicked in `pid` at `at`.
	pub(super) fn record(&self, pid: libc::pid_t, at: Instant) {
		if let Some(app) = self.0.lock().get_mut(&pid) {
			app.inputs += 1;
			app.unread = Some(at);
		}
	}

	/// A read of one of `pid`'s windows that began at `started` succeeded. It
	/// shows the user's input only if they had paused for [`QUIET`] by then.
	fn read(&self, pid: libc::pid_t, started: Instant) {
		if let Some(app) = self.0.lock().get_mut(&pid)
			&& app
				.unread
				.is_some_and(|last| started.saturating_duration_since(last) >= QUIET)
		{
			app.unread = None;
		}
	}

	/// Admits input to `pid` and watches its key presses ([`check_press`]).
	/// Input to an app holding input no read has shown waits until the user
	/// has paused for [`QUIET`], or until shortly before `deadline` (for one
	/// quiet period without one), then fails without sending anything.
	fn admit(
		self: &Arc<Self>,
		pid: libc::pid_t,
		deadline: Option<Instant>,
		now: impl Fn() -> Instant,
		mut wait: impl FnMut(Duration) -> CoreResult<()>,
	) -> CoreResult<InputWatch> {
		let limit = deadline.map_or_else(
			|| now() + QUIET,
			|deadline| deadline.checked_sub(DEADLINE_MARGIN).unwrap_or(deadline),
		);
		loop {
			let (baseline, unread) =
				self.0.lock().get(&pid).map_or((0, None), |app| {
					(app.inputs, app.unread.map(|last| (last, app.name.clone())))
				});
			let Some((last, name)) = unread else {
				return Ok(InputWatch::enter(Arc::clone(self), pid, baseline));
			};
			let now = now();
			let idle = now.saturating_duration_since(last);
			if idle >= QUIET {
				return Err(DesktopError::user_intervened(format!(
					"the user was using {name} (last input {:.1} s ago); nothing was sent; {READ_AGAIN}",
					idle.as_secs_f64(),
				)));
			}
			if now >= limit {
				return Err(DesktopError::user_intervened(format!(
					"the user is still using {name} (last input {:.1} s ago); nothing was sent; once \
					 they pause, {READ_AGAIN}",
					idle.as_secs_f64(),
				)));
			}
			wait((last + QUIET).min(limit).saturating_duration_since(now))?;
		}
	}
}

/// What the current thread's input call compares before each key press.
struct Watch {
	inputs:   Arc<UserInputs>,
	pid:      libc::pid_t,
	baseline: u64,
}

thread_local! {
	static WATCH: RefCell<Option<Watch>> = const { RefCell::new(None) };
}

/// Keeps an admitted input call's watch current on this thread until dropped.
pub(crate) struct InputWatch {
	previous: Option<Watch>,
	_thread:  PhantomData<Rc<()>>,
}

impl InputWatch {
	fn enter(inputs: Arc<UserInputs>, pid: libc::pid_t, baseline: u64) -> Self {
		let previous =
			WATCH.with_borrow_mut(|current| current.replace(Watch { inputs, pid, baseline }));
		Self { previous, _thread: PhantomData }
	}
}

impl Drop for InputWatch {
	fn drop(&mut self) {
		WATCH.with_borrow_mut(|current| *current = self.previous.take());
	}
}

/// Before a key press of the current input call: refuses once the user has
/// pressed a key or clicked in its app since the call was admitted, so at most
/// the press already under way lands after theirs.
pub(crate) fn check_press() -> CoreResult<()> {
	WATCH.with_borrow(|watch| {
		let Some(watch) = watch else {
			return Ok(());
		};
		match watch.inputs.0.lock().get(&watch.pid) {
			Some(app) if app.inputs != watch.baseline => Err(DesktopError::user_intervened(format!(
				"the user pressed a key or clicked in {} during this input; keys sent before that may \
				 already have landed, and nothing more was sent; {READ_AGAIN}",
				app.name,
			))),
			_ => Ok(()),
		}
	})
}

/// The session's record of the user's input and the tap that feeds it. The
/// tap starts when the session first reads or acts on an app and stops when
/// the session's worker drops this. Without event-listening access it cannot
/// start: nothing is recorded and no input waits.
pub(crate) struct Listener {
	inputs: Arc<UserInputs>,
	tap:    Option<UserInputMonitor>,
	start:  fn(Arc<UserInputs>) -> CoreResult<UserInputMonitor>,
}

impl Default for Listener {
	fn default() -> Self {
		Self { inputs: Arc::default(), tap: None, start: UserInputMonitor::start }
	}
}

impl Listener {
	/// Records the user's input into `pid` from now on.
	pub(crate) fn touch(&mut self, pid: libc::pid_t, name: impl FnOnce() -> String) {
		if self.tap.is_none() {
			self.tap = (self.start)(Arc::clone(&self.inputs)).ok();
		}
		self.inputs.touch(pid, name);
	}

	/// A read of one of `pid`'s windows that began at `started` succeeded.
	pub(crate) fn read(&self, pid: libc::pid_t, started: Instant) {
		self.inputs.read(pid, started);
	}

	/// Admits input to `pid`, waiting at most until shortly before the run's
	/// deadline; cancelling the operation ends the wait.
	pub(crate) fn admit(&self, pid: libc::pid_t, token: &OperationToken) -> CoreResult<InputWatch> {
		self
			.inputs
			.admit(pid, token.deadline(), Instant::now, |duration| token.wait(duration))
	}

	#[cfg(test)]
	pub(crate) fn without_tap() -> Self {
		Self { start: |_| Err(DesktopError::permission_denied("no tap in tests")), ..Self::default() }
	}

	#[cfg(test)]
	pub(crate) fn record_for_test(&self, pid: libc::pid_t, at: Instant) {
		self.inputs.record(pid, at);
	}
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;
	use crate::desktop::error::ErrorCode;

	fn state(inputs: &UserInputs, pid: libc::pid_t) -> Option<(u64, Option<Instant>)> {
		inputs
			.0
			.lock()
			.get(&pid)
			.map(|app| (app.inputs, app.unread))
	}

	#[test]
	fn the_users_input_needs_a_read_after_they_pause_in_that_app_only() {
		let inputs = UserInputs::default();
		let start = Instant::now();
		let at = |seconds| start + Duration::from_secs(seconds);
		// Before the session touches TextEdit, its user's input is theirs alone.
		inputs.record(7, start);
		inputs.touch(7, || "TextEdit".to_string());
		inputs.touch(9, || "Notes".to_string());
		assert_eq!(state(&inputs, 7), Some((0, None)));
		inputs.record(7, at(1));
		assert_eq!(state(&inputs, 7), Some((1, Some(at(1)))));
		assert_eq!(state(&inputs, 9), Some((0, None)));
		// A read begun before the input, or under 5 s after it, does not show it.
		inputs.read(7, start);
		inputs.read(7, at(5));
		assert_eq!(state(&inputs, 7), Some((1, Some(at(1)))));
		inputs.read(7, at(6));
		assert_eq!(state(&inputs, 7), Some((1, None)));
		// Another app's read clears nothing here.
		inputs.record(7, at(10));
		inputs.read(9, at(20));
		assert_eq!(state(&inputs, 7), Some((2, Some(at(10)))));
	}

	#[test]
	fn input_waits_for_the_user_to_pause_then_fails_until_a_read() {
		let inputs = Arc::new(UserInputs::default());
		let start = Instant::now();
		let at = |seconds| start + Duration::from_secs(seconds);
		inputs.touch(7, || "TextEdit".to_string());
		inputs.record(7, at(0));
		let clock = Cell::new(at(1));
		let mut waits = Vec::new();
		let error = inputs
			.admit(
				7,
				Some(at(60)),
				|| clock.get(),
				|duration| {
					// The user types once more while the first wait runs.
					if waits.is_empty() {
						inputs.record(7, at(3));
					}
					waits.push(duration);
					clock.set(clock.get() + duration);
					Ok(())
				},
			)
			.err()
			.unwrap();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert_eq!(waits, [Duration::from_secs(4), Duration::from_secs(3)]);
		assert!(
			error
				.message
				.contains("using TextEdit (last input 5.0 s ago)")
		);
		assert!(error.message.contains("nothing was sent"));
		// The refusal leaves the input unread until a read after the pause.
		assert_eq!(state(&inputs, 7), Some((2, Some(at(3)))));
		assert!(
			inputs
				.admit(7, None, || at(9), |_| panic!("no wait"))
				.is_err()
		);
		inputs.read(7, at(9));
		assert!(
			inputs
				.admit(7, None, || at(9), |_| panic!("no wait"))
				.is_ok()
		);
	}

	#[test]
	fn the_runs_deadline_ends_the_wait_for_a_user_still_typing() {
		let inputs = Arc::new(UserInputs::default());
		let start = Instant::now();
		inputs.touch(7, || "TextEdit".to_string());
		inputs.record(7, start);
		let clock = Cell::new(start + Duration::from_secs(1));
		let mut waits = Vec::new();
		let error = inputs
			.admit(
				7,
				Some(start + Duration::from_secs(3)),
				|| clock.get(),
				|duration| {
					waits.push(duration);
					clock.set(clock.get() + duration);
					Ok(())
				},
			)
			.err()
			.unwrap();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert_eq!(waits, [Duration::from_millis(1_750)]);
		assert!(error.message.contains("still using TextEdit"));
	}
}
