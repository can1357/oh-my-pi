//! Event-driven settle after desktop input.
//!
//! Each touched application gets an `AXObserver` on the worker thread's own
//! run loop for the duration of the wait. The wait ends once no counted
//! notification has arrived for the quiet window, or at the cap.

use std::{
	cell::{Cell, RefCell},
	collections::HashMap,
	ffi::c_void,
	hash::{Hash, Hasher},
	ptr::{self, NonNull},
	thread,
	time::{Duration, Instant},
};

use objc2_application_services::{AXError, AXObserver, AXUIElement};
use objc2_core_foundation::{
	CFRetained, CFRunLoop, CFRunLoopRunResult, CFRunLoopSource, CFString, CFType,
};

use super::super::{control::OperationToken, error::CoreResult, types::UiQuiet};

/// Notifications that mean the UI is still changing. `AXValueChanged` is
/// excluded: caret blinks, progress indicators and clocks emit it forever.
const NOTIFICATIONS: [&str; 10] = [
	TITLE_CHANGED,
	"AXLayoutChanged",
	"AXFocusedWindowChanged",
	"AXFocusedUIElementChanged",
	"AXElementBusyChanged",
	"AXMenuOpened",
	"AXSheetCreated",
	"AXWindowCreated",
	"AXCreated",
	"AXUIElementDestroyed",
];
/// Counted only when the element's title really changed; apps re-announce
/// unchanged titles while redrawing.
const TITLE_CHANGED: &str = "AXTitleChanged";
/// Longest single run-loop wait, so cancellation is observed promptly.
const CANCEL_POLL: Duration = Duration::from_millis(50);
/// Bounds each registration call and title read against a hung application.
const MESSAGING_TIMEOUT: Duration = Duration::from_millis(500);
/// Private run-loop mode: only this wait's observer sources run in it.
const RUN_LOOP_MODE: &str = "pi.desktop.uiQuiet";

/// Counted notifications handled by one run-loop step.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Step {
	events: u32,
	/// Arrival time of the newest counted notification in this step.
	last:   Option<Instant>,
}

/// Waits until `quiet` has passed since the newest counted notification,
/// giving up `cap` after `start`. The quiet window first opens at `ready`, when
/// the observers are installed, so registration time never counts as quiet
/// and callbacks queued meanwhile are handled first; if registration used up
/// the cap, the wait ends unsettled. `step` waits for notifications up to the
/// given budget; `check` reports cancellation before every quiet test.
#[allow(clippy::too_many_arguments, reason = "the clock, step and check are injected for tests")]
fn quiet_loop(
	start: Instant,
	ready: Instant,
	quiet: Duration,
	cap: Duration,
	watched: u32,
	now: impl Fn() -> Instant,
	mut step: impl FnMut(Duration) -> Step,
	check: impl Fn() -> CoreResult<()>,
) -> CoreResult<UiQuiet> {
	let cap_at = start + cap;
	let mut last = ready;
	let mut events = 0u32;
	loop {
		check()?;
		let at = now();
		let quiet_at = last + quiet;
		let timed_out = at < quiet_at;
		if !timed_out || at >= cap_at {
			let waited = at.saturating_duration_since(start).as_millis();
			return Ok(UiQuiet {
				waited_ms: u32::try_from(waited).unwrap_or(u32::MAX),
				events,
				timed_out,
				watched,
			});
		}
		let budget = (quiet_at.min(cap_at) - at).min(CANCEL_POLL);
		let handled = step(budget);
		events = events.saturating_add(handled.events);
		if let Some(arrived) = handled.last {
			last = last.max(arrived);
		}
	}
}

/// AX messaging timeout for a call starting at `at` that must end by
/// `deadline`: the time left, at most [`MESSAGING_TIMEOUT`]. `None` once the
/// deadline has passed; AX reads a zero timeout as "use the global default"
/// (seconds), so it is never returned.
fn messaging_timeout(deadline: Instant, at: Instant) -> Option<Duration> {
	deadline
		.checked_duration_since(at)
		.filter(|left| !left.is_zero())
		.map(|left| left.min(MESSAGING_TIMEOUT))
}

/// Adds `names` in order until `deadline`, handing `add` each name with the
/// messaging timeout that keeps the call inside the deadline. Stops at the
/// deadline, keeping what was added so far. Whether any `add` succeeded.
fn add_until(
	deadline: Instant,
	names: &[&str],
	now: impl Fn() -> Instant,
	mut add: impl FnMut(&str, Duration) -> bool,
) -> bool {
	let mut added = false;
	for name in names {
		let Some(timeout) = messaging_timeout(deadline, now()) else {
			break;
		};
		added |= add(name, timeout);
	}
	added
}

/// Last title seen per element, so a title notification counts only when the
/// title actually changed.
struct TitleMemo<K> {
	titles: HashMap<K, String>,
}

impl<K: Eq + Hash> TitleMemo<K> {
	fn new() -> Self {
		Self { titles: HashMap::new() }
	}

	/// Whether a title notification for `key` whose element now reads `title`
	/// counts. An absent title never counts.
	fn counts(&mut self, key: K, title: Option<String>) -> bool {
		let Some(title) = title else {
			return false;
		};
		if self.titles.get(&key) == Some(&title) {
			return false;
		}
		self.titles.insert(key, title);
		true
	}
}

/// CF identity of a notified element (`CFEqual`/`CFHash`).
struct ElementKey(CFRetained<AXUIElement>);

impl PartialEq for ElementKey {
	fn eq(&self, other: &Self) -> bool {
		*self.0 == *other.0
	}
}

impl Eq for ElementKey {}

impl Hash for ElementKey {
	fn hash<H: Hasher>(&self, state: &mut H) {
		(*self.0).hash(state);
	}
}

/// State the observer callback updates; lives on the waiting thread.
struct Shared {
	title_changed: CFRetained<CFString>,
	titles:        RefCell<TitleMemo<ElementKey>>,
	events:        Cell<u32>,
	last:          Cell<Option<Instant>>,
	/// End of the wait; title reads never run past it.
	deadline:      Instant,
}

impl Shared {
	fn take(&self) -> Step {
		Step { events: self.events.replace(0), last: self.last.take() }
	}
}

struct Registration {
	source:    CFRetained<CFRunLoopSource>,
	_observer: CFRetained<AXObserver>,
}

/// Observer sources installed on the current run loop in the private mode.
/// Dropping removes every source before releasing the observers and the
/// callback state they point at.
struct Observers {
	run_loop:      CFRetained<CFRunLoop>,
	mode:          CFRetained<CFString>,
	registrations: Vec<Registration>,
	shared:        Box<Shared>,
}

impl Observers {
	fn new(run_loop: CFRetained<CFRunLoop>, deadline: Instant) -> Self {
		Self {
			run_loop,
			mode: CFString::from_str(RUN_LOOP_MODE),
			registrations: Vec::new(),
			shared: Box::new(Shared {
				title_changed: CFString::from_str(TITLE_CHANGED),
				titles: RefCell::new(TitleMemo::new()),
				events: Cell::new(0),
				last: Cell::new(None),
				deadline,
			}),
		}
	}

	fn refcon(&self) -> *mut c_void {
		ptr::from_ref::<Shared>(&*self.shared).cast_mut().cast()
	}

	fn add(&mut self, registration: Registration) {
		self
			.run_loop
			.add_source(Some(&registration.source), Some(&self.mode));
		self.registrations.push(registration);
	}

	fn step(&self, budget: Duration) -> Step {
		let result = CFRunLoop::run_in_mode(Some(&self.mode), budget.as_secs_f64(), true);
		if result == CFRunLoopRunResult::Finished {
			// Every source was invalidated (all watched apps quit); keep the
			// timing without spinning.
			thread::sleep(budget);
		}
		self.shared.take()
	}
}

impl Drop for Observers {
	fn drop(&mut self) {
		for registration in self.registrations.drain(..) {
			self
				.run_loop
				.remove_source(Some(&registration.source), Some(&self.mode));
		}
	}
}

/// Observes `pids` until their UI has been quiet for `quiet`, capped at `cap`.
/// Processes that cannot be observed are skipped; nothing observable returns
/// at once with `watched: 0`.
pub(super) fn wait_for_quiet(
	pids: &[u32],
	quiet: Duration,
	cap: Duration,
	token: &OperationToken,
) -> CoreResult<UiQuiet> {
	let start = Instant::now();
	let deadline = start + cap;
	let mut unique = pids.to_vec();
	unique.sort_unstable();
	unique.dedup();
	if unique.is_empty() {
		return Ok(UiQuiet::unwatched());
	}
	let Some(run_loop) = CFRunLoop::current() else {
		return Ok(UiQuiet::unwatched());
	};
	let mut observers = Observers::new(run_loop, deadline);
	for pid in unique {
		token.check()?;
		// First contact with an app costs an AX round trip per notification;
		// the cap bounds registration too.
		if Instant::now() >= deadline {
			break;
		}
		if let Some(registration) = register(pid, observers.refcon(), deadline) {
			observers.add(registration);
		}
	}
	if observers.registrations.is_empty() {
		return Ok(UiQuiet::unwatched());
	}
	let watched = u32::try_from(observers.registrations.len()).unwrap_or(u32::MAX);
	quiet_loop(
		start,
		Instant::now(),
		quiet,
		cap,
		watched,
		Instant::now,
		|budget| observers.step(budget),
		|| token.check(),
	)
}

/// Creates an observer for `pid` with every notification it accepts before
/// `deadline`. `None` when the process cannot be observed at all in time.
fn register(pid: u32, refcon: *mut c_void, deadline: Instant) -> Option<Registration> {
	let pid = libc::pid_t::try_from(pid).ok().filter(|pid| *pid > 0)?;
	// SAFETY: AXUIElementCreateApplication accepts any process id and returns
	// a +1 retained element.
	let app = unsafe { AXUIElement::new_application(pid) };
	let mut raw: *mut AXObserver = ptr::null_mut();
	// SAFETY: `on_notification` has the AXObserverCallback ABI and `raw` is a
	// writable out pointer.
	let error = unsafe { AXObserver::create(pid, Some(on_notification), NonNull::from(&mut raw)) };
	if error != AXError::Success {
		return None;
	}
	// SAFETY: A successful AXObserverCreate returns its observer at +1.
	let observer = unsafe { CFRetained::from_raw(NonNull::new(raw)?) };
	let registered = add_until(deadline, &NOTIFICATIONS, Instant::now, |name, timeout| {
		// SAFETY: The retained application element is valid for the timeout
		// update.
		let _ = unsafe { app.set_messaging_timeout(timeout.as_secs_f32()) };
		let name = CFString::from_str(name);
		// SAFETY: `refcon` points at the boxed `Shared` owned by `Observers`,
		// which removes this observer's source before dropping it; the
		// callback only runs inside this thread's run loop in the private
		// mode.
		let error = unsafe { observer.add_notification(&app, &name, refcon) };
		error == AXError::Success
	});
	if !registered {
		return None;
	}
	// SAFETY: The retained observer is valid; the getter returns its source
	// retained by the binding.
	let source = unsafe { observer.run_loop_source() };
	Some(Registration { source, _observer: observer })
}

unsafe extern "C-unwind" fn on_notification(
	_observer: NonNull<AXObserver>,
	element: NonNull<AXUIElement>,
	notification: NonNull<CFString>,
	refcon: *mut c_void,
) {
	// SAFETY: `refcon` is the `Shared` registered in `register`, alive while
	// the source can run (see `Observers`).
	let shared = unsafe { &*refcon.cast_const().cast::<Shared>() };
	// SAFETY: AX passes a valid notification name for the callback's duration.
	let notification = unsafe { notification.as_ref() };
	if *notification == *shared.title_changed {
		// SAFETY: AX passes a valid element for the callback's duration;
		// retaining keeps it as the memo key.
		let element = unsafe { CFRetained::retain(element) };
		let title = copy_title(&element, shared.deadline);
		if !shared
			.titles
			.borrow_mut()
			.counts(ElementKey(element), title)
		{
			return;
		}
	}
	shared.events.set(shared.events.get().saturating_add(1));
	shared.last.set(Some(Instant::now()));
}

/// The element's title, read only while time is left before `deadline`.
fn copy_title(element: &AXUIElement, deadline: Instant) -> Option<String> {
	let timeout = messaging_timeout(deadline, Instant::now())?;
	// SAFETY: The retained element is valid for the timeout update.
	let _ = unsafe { element.set_messaging_timeout(timeout.as_secs_f32()) };
	let attribute = CFString::from_str("AXTitle");
	let mut output: *const CFType = ptr::null();
	// SAFETY: `output` is writable and receives a create-rule retained CF
	// object on success.
	let error = unsafe { element.copy_attribute_value(&attribute, NonNull::from(&mut output)) };
	if error != AXError::Success {
		return None;
	}
	let pointer = NonNull::new(output.cast_mut())?;
	// SAFETY: AXUIElementCopyAttributeValue returns a +1 object on success.
	let value: CFRetained<CFType> = unsafe { CFRetained::from_raw(pointer) };
	value
		.downcast::<CFString>()
		.ok()
		.map(|title| title.to_string())
}

#[cfg(test)]
mod tests {
	use std::{
		cell::Cell,
		time::{Duration, Instant},
	};

	use super::{
		CANCEL_POLL, MESSAGING_TIMEOUT, NOTIFICATIONS, Step, TitleMemo, add_until, quiet_loop,
	};
	use crate::desktop::error::{CoreResult, DesktopError, ErrorCode};

	const QUIET: Duration = Duration::from_millis(250);
	const CAP: Duration = Duration::from_millis(5000);

	/// Fake clock plus scripted notification arrivals (offsets from start).
	struct Script {
		start:  Instant,
		clock:  Cell<Instant>,
		events: Vec<Duration>,
		next:   Cell<usize>,
	}

	impl Script {
		fn new(events: Vec<Duration>) -> Self {
			let start = Instant::now();
			Self { start, clock: Cell::new(start), events, next: Cell::new(0) }
		}

		fn now(&self) -> Instant {
			self.clock.get()
		}

		/// Advances to the next scripted arrival inside `budget`, or by the
		/// whole budget.
		fn step(&self, budget: Duration) -> Step {
			assert!(budget <= CANCEL_POLL && !budget.is_zero(), "budget {budget:?}");
			let deadline = self.clock.get() + budget;
			match self.events.get(self.next.get()) {
				Some(offset) if self.start + *offset <= deadline => {
					let at = self.start + *offset;
					self.clock.set(at);
					self.next.set(self.next.get() + 1);
					Step { events: 1, last: Some(at) }
				},
				_ => {
					self.clock.set(deadline);
					Step::default()
				},
			}
		}

		fn run(&self, check: impl Fn() -> CoreResult<()>) -> CoreResult<super::UiQuiet> {
			self.run_from(self.start, check)
		}

		/// Observers became ready `registration` after the wait started.
		fn run_registered(&self, registration: Duration) -> CoreResult<super::UiQuiet> {
			self.clock.set(self.start + registration);
			self.run_from(self.start + registration, || Ok(()))
		}

		fn run_from(
			&self,
			ready: Instant,
			check: impl Fn() -> CoreResult<()>,
		) -> CoreResult<super::UiQuiet> {
			quiet_loop(
				self.start,
				ready,
				QUIET,
				CAP,
				1,
				|| self.now(),
				|budget| self.step(budget),
				check,
			)
		}
	}

	fn ms(millis: u64) -> Duration {
		Duration::from_millis(millis)
	}

	#[test]
	fn idle_app_returns_after_exactly_the_quiet_window() {
		let script = Script::new(Vec::new());
		let result = script.run(|| Ok(())).unwrap();
		assert_eq!(result.waited_ms, 250);
		assert_eq!(result.events, 0);
		assert!(!result.timed_out);
		assert_eq!(result.watched, 1);
	}

	#[test]
	fn events_extend_the_wait_to_last_event_plus_quiet() {
		let script = Script::new(vec![ms(100), ms(300), ms(420)]);
		let result = script.run(|| Ok(())).unwrap();
		assert_eq!(result.waited_ms, 670);
		assert_eq!(result.events, 3);
		assert!(!result.timed_out);
	}

	#[test]
	fn continuous_events_end_at_the_cap() {
		let script = Script::new((1..=100).map(|i| ms(i * 100)).collect());
		let result = script.run(|| Ok(())).unwrap();
		assert_eq!(result.waited_ms, 5000);
		assert_eq!(result.events, 50);
		assert!(result.timed_out);
	}

	#[test]
	fn registration_time_is_not_counted_as_quiet() {
		// Registering took 300 ms; a notification queued meanwhile is handled at
		// the first step.
		let script = Script::new(vec![ms(300)]);
		let result = script.run_registered(ms(300)).unwrap();
		assert_eq!(result.waited_ms, 550);
		assert_eq!(result.events, 1);
		assert!(!result.timed_out);
	}

	#[test]
	fn registration_that_spends_the_cap_ends_unsettled() {
		let script = Script::new(Vec::new());
		let result = script.run_registered(CAP).unwrap();
		assert_eq!(result.waited_ms, 5000);
		assert_eq!(result.events, 0);
		assert!(result.timed_out);
	}

	#[test]
	fn cancellation_returns_the_cancelled_error() {
		let script = Script::new(Vec::new());
		let checks = Cell::new(0);
		let error = script
			.run(|| {
				checks.set(checks.get() + 1);
				if checks.get() > 2 {
					Err(DesktopError::cancelled("cancelled"))
				} else {
					Ok(())
				}
			})
			.unwrap_err();
		assert_eq!(error.code, ErrorCode::Cancelled);
		assert_eq!(script.now() - script.start, ms(100));
	}

	#[test]
	fn unchanged_or_absent_titles_are_not_counted() {
		let mut memo = TitleMemo::new();
		assert!(memo.counts(1, Some("Inbox".into())));
		assert!(!memo.counts(1, Some("Inbox".into())));
		assert!(!memo.counts(1, None));
		assert!(memo.counts(2, Some("Inbox".into())));
		assert!(memo.counts(1, Some("Inbox (3)".into())));
		assert!(!memo.counts(1, Some("Inbox (3)".into())));
	}

	/// Registers every notification against a hung app: each call takes its
	/// whole timeout and `fail` lists the calls that are refused.
	fn register_hung(cap: Duration, fail: &[usize]) -> (bool, Vec<Duration>, Duration) {
		let start = Instant::now();
		let clock = Cell::new(start);
		let mut timeouts = Vec::new();
		let added = add_until(
			start + cap,
			&NOTIFICATIONS,
			|| clock.get(),
			|_, timeout| {
				clock.set(clock.get() + timeout);
				timeouts.push(timeout);
				!fail.contains(&(timeouts.len() - 1))
			},
		);
		(added, timeouts, clock.get() - start)
	}

	#[test]
	fn registration_stops_at_the_cap() {
		let (added, timeouts, spent) = register_hung(ms(1200), &[]);
		assert!(added);
		assert_eq!(timeouts, vec![MESSAGING_TIMEOUT, MESSAGING_TIMEOUT, ms(200)]);
		assert_eq!(spent, ms(1200));
	}

	#[test]
	fn registration_without_time_left_adds_nothing() {
		let (added, timeouts, spent) = register_hung(Duration::ZERO, &[]);
		assert!(!added);
		assert!(timeouts.is_empty());
		assert_eq!(spent, Duration::ZERO);
	}

	#[test]
	fn registration_keeps_what_succeeded_before_the_cap() {
		let (added, timeouts, _) = register_hung(ms(1200), &[0, 2]);
		assert!(added);
		assert_eq!(timeouts.len(), 3);
		let (added, ..) = register_hung(ms(1200), &[0, 1, 2]);
		assert!(!added);
	}

	#[test]
	fn a_responsive_app_registers_every_notification() {
		let start = Instant::now();
		let mut names = Vec::new();
		let added = add_until(
			start + CAP,
			&NOTIFICATIONS,
			|| start,
			|name, timeout| {
				assert_eq!(timeout, MESSAGING_TIMEOUT);
				names.push(name.to_owned());
				true
			},
		);
		assert!(added);
		assert_eq!(names, NOTIFICATIONS);
	}
}
