//! Getting a Chromium-family app's web content into its accessibility tree
//! before a session first reads it.
//!
//! Chrome and Electron 23 and later build the tree of their web content for
//! an assistive client that queries the application's `AXRole`, and publish it
//! over IPC a few hundred milliseconds later; a read before that sees an empty
//! page. Older Electron builds it only once `AXManualAccessibility` is set, so
//! omp writes that flag only to an Electron window whose web content did not
//! appear: it switches on the app's full screen-reader mode, which costs the
//! app work on every page change until it quits, and Electron 38 reads it back
//! as `false` whatever its state, so no client can tell who switched it on.

use std::{
	cell::RefCell,
	collections::{HashSet, VecDeque},
	time::{Duration, Instant},
};

use objc2_application_services::AXUIElement;
use objc2_core_foundation::{CFBoolean, CFString, Type};

use super::{copy_elements_optional, copy_string};
use crate::desktop::{control, error::CoreResult, macos::process};

const MANUAL_ACCESSIBILITY: &str = "AXManualAccessibility";
/// How long a window has to publish its web content, per attempt, before the
/// read that asked for it goes ahead anyway.
const READY_WAIT: Duration = Duration::from_millis(1_000);
const READY_POLL: Duration = Duration::from_millis(20);
/// The shortest AX messaging timeout a search request gets; zero would mean
/// the system default.
const MIN_REQUEST_TIMEOUT: Duration = Duration::from_millis(10);
/// Bounds the per-poll search for a web area: Chrome's and Electron's sit a
/// few groups below the window, after the browser's own toolbar.
const READY_SEARCH_NODES: usize = 400;
const READY_SEARCH_DEPTH: usize = 16;

/// A process, told apart from a later one that reuses its pid by its start
/// time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct Process {
	pid:     libc::pid_t,
	started: (u64, u64),
}

impl Process {
	fn of(pid: libc::pid_t) -> Option<Self> {
		let info = pi_builtins::proc_sys::bsdinfo(pid)?;
		Some(Self { pid, started: (info.pbi_start_tvsec, info.pbi_start_tvusec) })
	}
}

thread_local! {
	/// The apps this thread's session has read. Each session runs on its own
	/// worker thread.
	static READ: RefCell<HashSet<Process>> = RefCell::new(HashSet::new());
}

/// Which web-content activation an app answers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
	/// Not Chromium-based: nothing to wait for.
	Other,
	/// Chrome and its forks, which ignore `AXManualAccessibility`.
	Chromium,
	/// Electron, whose releases before 23 need `AXManualAccessibility`.
	Electron,
}

/// Queries the application's `AXRole`, which switches on the web
/// accessibility of Chrome and Electron 23 and later.
pub(super) fn activate(app: &AXUIElement) {
	let _ = copy_string(app, "AXRole");
}

/// On this session's first read of a Chromium-family `pid`, waits at most
/// [`READY_WAIT`] for `window` to show web content; an Electron window that
/// shows none gets `AXManualAccessibility` and as long again. Fails only when
/// the call is cancelled, which leaves the next read to wait.
pub(super) fn before_first_read(
	pid: libc::pid_t,
	app: &AXUIElement,
	window: &AXUIElement,
) -> CoreResult<()> {
	let Some(process) = Process::of(pid) else {
		return Ok(());
	};
	if READ.with(|read| read.borrow().contains(&process)) {
		return Ok(());
	}
	let family = if process::is_electron(pid) {
		Family::Electron
	} else if process::is_chromium(pid) {
		Family::Chromium
	} else {
		Family::Other
	};
	await_web_content(family, || wait_for_web_content(window), || enable_manual(app))?;
	READ.with(|read| read.borrow_mut().insert(process));
	Ok(())
}

/// Waits for web content where `family` builds it, through `wait` (whether it
/// appeared in time). An Electron window that showed none is switched on
/// through `enable` and waited for once more, unless the call was cancelled
/// meanwhile: the flag outlives the call. A cancel during a wait's last
/// request ends it empty rather than cancelled, so the call checks once more
/// before the app counts as read.
fn await_web_content(
	family: Family,
	mut wait: impl FnMut() -> CoreResult<bool>,
	enable: impl FnOnce(),
) -> CoreResult<()> {
	if family == Family::Other {
		return Ok(());
	}
	if !wait()? && family == Family::Electron {
		control::check()?;
		enable();
		wait()?;
	}
	control::check()
}

/// Sets `AXManualAccessibility`. Electron before 23 answers the write with an
/// error even when it took it, so the result is not read.
fn enable_manual(app: &AXUIElement) {
	let attribute = CFString::from_static_str(MANUAL_ACCESSIBILITY);
	// SAFETY: The retained element, attribute, and singleton CFBoolean remain
	// valid for the synchronous setter call.
	let _ = unsafe { app.set_attribute_value(&attribute, CFBoolean::new(true)) };
}

/// Polls `window` for a web area with content until [`READY_WAIT`] has
/// passed; whether one appeared.
fn wait_for_web_content(window: &AXUIElement) -> CoreResult<bool> {
	let deadline = Instant::now() + READY_WAIT;
	loop {
		if has_web_content(window, deadline)? {
			return Ok(true);
		}
		let left = deadline.saturating_duration_since(Instant::now());
		if left.is_zero() {
			return Ok(false);
		}
		control::wait(READY_POLL.min(left))?;
	}
}

/// Searches `window` for a web area with children, giving each request at
/// most the time left until `deadline`.
fn has_web_content(window: &AXUIElement, deadline: Instant) -> CoreResult<bool> {
	let mut queue = VecDeque::from([(window.retain(), 0)]);
	let mut visited = 0;
	while let Some((element, depth)) = queue.pop_front() {
		visited += 1;
		if visited > READY_SEARCH_NODES || !budget(&element, deadline)? {
			return Ok(false);
		}
		let children = copy_elements_optional(&element, "AXChildren").unwrap_or_default();
		if !children.is_empty() {
			if !budget(&element, deadline)? {
				return Ok(false);
			}
			if copy_string(&element, "AXRole").as_deref() == Some("AXWebArea") {
				return Ok(true);
			}
		}
		if depth < READY_SEARCH_DEPTH {
			queue.extend(children.into_iter().map(|child| (child, depth + 1)));
		}
	}
	Ok(false)
}

/// Gives `element`'s next request the time left until `deadline`; `false`
/// when too little is left to send one.
fn budget(element: &AXUIElement, deadline: Instant) -> CoreResult<bool> {
	control::check()?;
	let left = deadline.saturating_duration_since(Instant::now());
	if left < MIN_REQUEST_TIMEOUT {
		return Ok(false);
	}
	// SAFETY: The retained element is valid for the timeout update.
	let _ = unsafe { element.set_messaging_timeout(left.as_secs_f32()) };
	Ok(true)
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::{Family, Process, READY_POLL, await_web_content};
	use crate::desktop::{
		control::{self, CancellationSource},
		error::{CoreResult, ErrorCode},
	};

	/// Runs [`await_web_content`] on a window whose content appears on the
	/// `appears`-th wait (never when 0): its result, the waits and the flag
	/// writes.
	fn run(family: Family, appears: usize) -> (CoreResult<()>, usize, usize) {
		let (waits, writes) = (Cell::new(0), Cell::new(0));
		let result = await_web_content(
			family,
			|| {
				waits.set(waits.get() + 1);
				Ok(waits.get() == appears)
			},
			|| writes.set(writes.get() + 1),
		);
		(result, waits.get(), writes.get())
	}

	#[test]
	fn a_chromium_window_is_waited_for_and_never_written_to() {
		assert!(matches!(run(Family::Chromium, 1), (Ok(()), 1, 0)));
		assert!(matches!(run(Family::Chromium, 0), (Ok(()), 1, 0)));
	}

	#[test]
	fn electron_gets_the_flag_only_when_its_content_never_appeared() {
		assert!(matches!(run(Family::Electron, 1), (Ok(()), 1, 0)));
		assert!(matches!(run(Family::Electron, 0), (Ok(()), 2, 1)));
	}

	#[test]
	fn other_apps_are_neither_waited_for_nor_written_to() {
		assert!(matches!(run(Family::Other, 1), (Ok(()), 0, 0)));
	}

	#[test]
	fn a_live_process_is_known_by_its_pid_and_start_time() {
		let pid = std::process::id().cast_signed();
		let process = Process::of(pid).expect("own process");
		assert_eq!(process.pid, pid);
		assert_ne!(process.started, (0, 0));
		assert_eq!(Process::of(pid), Some(process));
		assert_eq!(Process::of(-1), None);
	}

	#[test]
	fn a_wait_cancelled_before_the_content_appeared_writes_nothing() {
		// The cancel lands between polls, where the wait sleeps on the token.
		let source = CancellationSource::default();
		let writes = Cell::new(0);
		let result = control::with_token_for_test(&source.token(), || {
			await_web_content(
				Family::Electron,
				|| {
					source.cancel();
					control::wait(READY_POLL)?;
					Ok(false)
				},
				|| writes.set(writes.get() + 1),
			)
		});
		assert_eq!(result.map_err(|error| error.code), Err(ErrorCode::Cancelled));
		assert_eq!(writes.get(), 0);
	}

	#[test]
	fn a_call_cancelled_as_its_wait_ran_out_writes_nothing() {
		// The cancel lands during the wait's last request, which then ends
		// empty rather than cancelled.
		let source = CancellationSource::default();
		let writes = Cell::new(0);
		let result = control::with_token_for_test(&source.token(), || {
			await_web_content(
				Family::Electron,
				|| {
					source.cancel();
					Ok(false)
				},
				|| writes.set(writes.get() + 1),
			)
		});
		assert_eq!(result.map_err(|error| error.code), Err(ErrorCode::Cancelled));
		assert_eq!(writes.get(), 0);
	}

	#[test]
	fn a_chromium_wait_cancelled_as_it_ran_out_fails_so_the_next_read_waits() {
		let source = CancellationSource::default();
		let result = control::with_token_for_test(&source.token(), || {
			await_web_content(
				Family::Chromium,
				|| {
					source.cancel();
					Ok(false)
				},
				|| panic!("Chrome is never written to"),
			)
		});
		assert_eq!(result.map_err(|error| error.code), Err(ErrorCode::Cancelled));
	}
}
