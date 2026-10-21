//! The user's own keys and clicks in the apps a desktop session works in.
//!
//! A user who steps into an app the agent drives changes what the agent last
//! read there. Input aimed at an app the user has used since the session last
//! read it waits for them to pause, then fails without sending, so the agent
//! reads the window again before acting; input already being sent stops at the
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
	"read the window again (win.ax(), win.observe() or win.screenshot()) before acting on it";

struct App {
	name:    String,
	/// When the process started; a later process reusing its id starts later.
	started: Option<u64>,
	/// The user's key presses and clicks since the session first touched it.
	inputs:  u64,
	/// When the user last pressed a key or clicked there, until a read shows it.
	unread:  Option<Instant>,
}

/// A process that takes input for a watched app's windows, such as the
/// service that draws its Open or Save panel.
struct Route {
	app:     libc::pid_t,
	/// When the process started, so a later process reusing its id takes none
	/// of the app's input.
	started: Option<u64>,
}

#[derive(Default)]
struct State {
	apps:   HashMap<libc::pid_t, App>,
	/// Processes that take input for a watched app's windows, by id. A
	/// process takes one app's input at a time: the latest route wins.
	routes: HashMap<libc::pid_t, Route>,
}

/// When process `pid` started, or `None` when that cannot be told.
type Started = fn(libc::pid_t) -> Option<u64>;

/// The user's input into each app this session has read or sent input to,
/// shared by the tap thread and the session worker.
pub(crate) struct UserInputs(
	Mutex<State>,
	/// Tells a route's process from a later one under the same id.
	Started,
);

impl Default for UserInputs {
	fn default() -> Self {
		Self::new(crate::desktop::macos::process_started)
	}
}

impl UserInputs {
	fn new(started: Started) -> Self {
		Self(Mutex::default(), started)
	}

	/// Starts recording the user's input into `pid`, which started at
	/// `started`. Input into an app before the session first reads it or acts
	/// on it is not the agent's concern, nor is a former process's under the
	/// same id.
	fn touch(&self, pid: libc::pid_t, started: Option<u64>, name: impl FnOnce() -> String) {
		if self
			.0
			.lock()
			.apps
			.get(&pid)
			.is_some_and(|app| app.started == started)
		{
			return;
		}
		let name = name();
		let mut state = self.0.lock();
		state
			.apps
			.insert(pid, App { name, started, inputs: 0, unread: None });
		state.routes.retain(|_, route| route.app != pid);
	}

	/// Counts the user's input into `input` as input into the watched `app`
	/// while `input` is the process it is now.
	fn route(&self, input: libc::pid_t, app: libc::pid_t) {
		if input != app {
			let started = (self.1)(input);
			self.0.lock().routes.insert(input, Route { app, started });
		}
	}

	/// The user pressed a key or clicked in `pid` at `at`.
	pub(super) fn record(&self, pid: libc::pid_t, at: Instant) {
		let mut state = self.0.lock();
		let route = state
			.routes
			.get(&pid)
			.map(|route| (route.app, route.started));
		let pid = match route {
			Some((app, started)) if started == (self.1)(pid) => app,
			// Another process now has the route's id: its input is its own.
			Some(_) => {
				state.routes.remove(&pid);
				pid
			},
			None => pid,
		};
		if let Some(app) = state.apps.get_mut(&pid) {
			app.inputs += 1;
			app.unread = Some(at);
		}
	}

	/// A read of one of `pid`'s windows that began at `started` reached the
	/// caller. It shows the user's input only if they had paused for [`QUIET`]
	/// by then.
	fn read(&self, pid: libc::pid_t, started: Instant) {
		if let Some(app) = self.0.lock().apps.get_mut(&pid)
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
				self.0.lock().apps.get(&pid).map_or((0, None), |app| {
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

/// The current input call sends its input to process `pid`, such as the
/// service that draws its window's Open panel: the user's input there counts
/// as input into the watched app.
pub(crate) fn input_goes_to(pid: libc::pid_t) {
	WATCH.with_borrow(|watch| {
		if let Some(watch) = watch {
			watch.inputs.route(pid, watch.pid);
		}
	});
}

/// Before a key or pointer press, or an accessibility action or write, of the
/// current input call: refuses once the user has pressed a key or clicked in
/// its app since the call was admitted, so at most the press already under way
/// lands after theirs.
pub(crate) fn check_press() -> CoreResult<()> {
	WATCH.with_borrow(|watch| {
		let Some(watch) = watch else {
			return Ok(());
		};
		match watch.inputs.0.lock().apps.get(&watch.pid) {
			Some(app) if app.inputs != watch.baseline => Err(DesktopError::user_intervened(format!(
				"the user pressed a key or clicked in {} during this input; input sent before that \
				 may already have landed, and nothing more was sent; {READ_AGAIN}",
				app.name,
			))),
			_ => Ok(()),
		}
	})
}

enum Tap {
	/// Not started yet, or the tap could not be created at the last try.
	Stopped(fn(Arc<UserInputs>) -> CoreResult<UserInputMonitor>),
	Running(#[allow(dead_code, reason = "dropping it stops the tap")] UserInputMonitor),
	/// Tests feed events through [`Listener::record_for_test`].
	#[cfg(test)]
	Simulated,
}

/// The session's record of the user's input and the tap that feeds it. The
/// tap starts when the session first reads or acts on an app and stops when
/// the session's worker drops this. Without event-listening access it starts
/// but sees nothing: nothing is recorded and no input waits.
pub(crate) struct Listener {
	inputs: Arc<UserInputs>,
	tap:    Tap,
}

impl Default for Listener {
	fn default() -> Self {
		Self { inputs: Arc::default(), tap: Tap::Stopped(UserInputMonitor::start) }
	}
}

impl Listener {
	/// Whether the tap runs, starting it if it does not yet.
	pub(crate) fn listening(&mut self) -> bool {
		if let Tap::Stopped(start) = self.tap
			&& let Ok(tap) = start(Arc::clone(&self.inputs))
		{
			self.tap = Tap::Running(tap);
		}
		!matches!(self.tap, Tap::Stopped(_))
	}

	/// Records the user's input into `pid`, which started at `started`, from
	/// now on.
	pub(crate) fn touch(
		&self,
		pid: libc::pid_t,
		started: Option<u64>,
		name: impl FnOnce() -> String,
	) {
		self.inputs.touch(pid, started, name);
	}

	/// Counts the user's input into process `input` as input into `app`.
	pub(crate) fn route(&self, input: libc::pid_t, app: libc::pid_t) {
		self.inputs.route(input, app);
	}

	/// A read of one of `pid`'s windows that began at `started` reached the
	/// caller.
	pub(crate) fn read(&self, pid: libc::pid_t, started: Instant) {
		self.inputs.read(pid, started);
	}

	/// Admits input to `pid`, waiting at most until shortly before the run or
	/// the request must end; cancelling the operation ends the wait.
	pub(crate) fn admit(&self, pid: libc::pid_t, token: &OperationToken) -> CoreResult<InputWatch> {
		self
			.inputs
			.admit(pid, token.deadline(), Instant::now, |duration| token.wait(duration))
	}

	#[cfg(test)]
	pub(crate) fn simulated() -> Self {
		Self { inputs: Arc::default(), tap: Tap::Simulated }
	}

	/// A listener whose tap never starts, for tests of elements no real app
	/// owns.
	#[cfg(test)]
	pub(crate) fn off() -> Self {
		Self {
			inputs: Arc::default(),
			tap:    Tap::Stopped(|_| Err(DesktopError::permission_denied("no tap in tests"))),
		}
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
			.apps
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
		inputs.touch(7, Some(1), || "TextEdit".to_string());
		inputs.touch(9, Some(1), || "Notes".to_string());
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
		inputs.touch(7, Some(1), || "TextEdit".to_string());
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
		inputs.touch(7, Some(1), || "TextEdit".to_string());
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

	#[test]
	fn input_into_a_process_drawing_the_apps_panel_counts_as_input_into_the_app() {
		let inputs = Arc::new(UserInputs::new(panel_started));
		let start = Instant::now();
		let at = |seconds| start + Duration::from_secs(seconds);
		inputs.touch(7, Some(1), || "TextEdit".to_string());
		inputs.touch(8, Some(1), || "Preview".to_string());
		let watch = inputs
			.admit(7, None, || start, |_| panic!("no wait"))
			.unwrap();
		// TextEdit's Save panel is drawn by process 70, which takes the input.
		input_goes_to(70);
		// The user clicks another app's panel, then the one the keys go to.
		inputs.record(71, at(0));
		assert!(check_press().is_ok());
		inputs.record(70, at(0));
		assert_eq!(check_press().unwrap_err().code, ErrorCode::UserIntervened);
		drop(watch);
		assert_eq!(state(&inputs, 8), Some((0, None)));
		// Later input waits for a read of TextEdit's window after the pause.
		assert!(
			inputs
				.admit(7, None, || at(6), |_| panic!("no wait"))
				.is_err()
		);
		inputs.read(7, at(6));
		assert!(
			inputs
				.admit(7, None, || at(6), |_| panic!("no wait"))
				.is_ok()
		);
	}

	#[test]
	fn a_new_process_reusing_a_watched_id_starts_unwatched() {
		let inputs = Arc::new(UserInputs::new(panel_started));
		let start = Instant::now();
		inputs.touch(7, Some(100), || "TextEdit".to_string());
		inputs.route(70, 7);
		// TextEdit quits; Notes starts under id 7, and the user types in it
		// before the session first reads it.
		inputs.record(7, start);
		inputs.touch(7, Some(200), || "Notes".to_string());
		assert_eq!(state(&inputs, 7), Some((0, None)));
		assert!(
			inputs
				.admit(7, None, || start, |_| panic!("no wait"))
				.is_ok()
		);
		// The old app's panel service no longer routes into the new process.
		inputs.record(70, start);
		assert_eq!(state(&inputs, 7), Some((0, None)));
	}

	thread_local! {
		/// When the test's panel process started, for [`panel_started`].
		static PANEL_STARTED: Cell<Option<u64>> = const { Cell::new(None) };
	}

	fn panel_started(_: libc::pid_t) -> Option<u64> {
		PANEL_STARTED.get()
	}

	#[test]
	fn a_new_process_reusing_a_panels_id_takes_none_of_the_apps_input() {
		let inputs = UserInputs::new(panel_started);
		let start = Instant::now();
		let at = |seconds| start + Duration::from_secs(seconds);
		inputs.touch(7, Some(1), || "TextEdit".to_string());
		// Process 70, started at 100, draws TextEdit's Save panel.
		PANEL_STARTED.set(Some(100));
		inputs.route(70, 7);
		inputs.record(70, at(0));
		assert_eq!(state(&inputs, 7), Some((1, Some(at(0)))));
		// It exits, and Calculator starts under id 70; the user types there.
		PANEL_STARTED.set(Some(200));
		inputs.record(70, at(1));
		assert_eq!(state(&inputs, 7), Some((1, Some(at(0)))));
		// Once the session uses Calculator, that input is Calculator's own.
		inputs.touch(70, Some(200), || "Calculator".to_string());
		inputs.record(70, at(2));
		assert_eq!(state(&inputs, 70), Some((1, Some(at(2)))));
		assert_eq!(state(&inputs, 7), Some((1, Some(at(0)))));
	}

	#[test]
	fn the_wait_ends_before_the_native_request_times_out() {
		let source = super::super::CancellationSource::default();
		source.set_deadline(Some(Instant::now() + Duration::from_secs(300)));
		let token = source
			.token()
			.replying_by(Instant::now() + Duration::from_millis(400));
		let mut listener = Listener::simulated();
		assert!(listener.listening());
		listener.touch(7, Some(1), || "TextEdit".to_string());
		listener.record_for_test(7, Instant::now());
		let error = listener.admit(7, &token).err().unwrap();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(error.message.contains("still using TextEdit"), "{}", error.message);
	}
}
