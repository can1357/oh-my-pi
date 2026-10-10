use std::{
	ffi::{CStr, c_void},
	mem,
	os::raw::{c_char, c_int, c_uint},
	ptr,
	sync::{
		LazyLock,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use core_graphics::{event::CGEvent, geometry::CGPoint};
use foreign_types::ForeignType;
use libc::pid_t;

use super::{
	super::{
		control,
		error::{CoreResult, DesktopError},
	},
	ax,
};

const EVENT_RECORD_LENGTH: usize = 248;
const EVENT_RECORD_LENGTH_BYTE: u8 = 0xf8;
const EVENT_RECORD_KIND: u8 = 0x0d;
const WINDOW_ID_OFFSET: usize = 0x3c;
const FOCUS_MARKER_OFFSET: usize = 0x8a;
const FOCUS_MARKER: u8 = 0x01;
const DEFOCUS_MARKER: u8 = 0x02;
/// `kCPSUserGenerated`: lets `AppKit` install the requested native key window.
const CPS_USER_GENERATED: u32 = 0x200;
/// `kCPSNoWindows`: changes the front process without raising its windows.
const CPS_NO_WINDOWS: u32 = 0x400;
/// Lets `AppKit` update key-window routing after focus records, and lets the
/// target consume queued input before its focus is handed back.
const FOCUS_SETTLE: Duration = Duration::from_millis(50);
/// Covers delayed AX/AppKit activation after the synchronous action returns.
/// The lease is joined before returning; it never continues fighting the user.
const BACKGROUND_SETTLE: Duration = Duration::from_millis(200);
/// Upper bound on waiting for a foreground activation to become observable.
const ACTIVATION_TIMEOUT: Duration = Duration::from_millis(400);
const ACTIVATION_POLL: Duration = Duration::from_millis(10);
/// Keeps the target frontmost until it has consumed foreground input.
const FOREGROUND_SETTLE: Duration = Duration::from_millis(40);

unsafe extern "C" {
	fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct ProcessSerialNumber {
	high: u32,
	low:  u32,
}

type SLEventPostToPidFn = unsafe extern "C" fn(pid_t, *mut c_void);
type SLEventSetIntegerValueFieldFn = unsafe extern "C" fn(*mut c_void, u32, i64);
type SLPSPostEventRecordToFn = unsafe extern "C" fn(*const ProcessSerialNumber, *const u8) -> i32;
type SLPSGetFrontProcessFn = unsafe extern "C" fn(*mut ProcessSerialNumber) -> i32;
type CGSMainConnectionIDFn = unsafe extern "C" fn() -> u32;
type SLSGetWindowOwnerFn = unsafe extern "C" fn(u32, u32, *mut u32) -> i32;
type SLSGetConnectionPSNFn = unsafe extern "C" fn(u32, *mut ProcessSerialNumber) -> i32;
type GetProcessForPIDFn = unsafe extern "C" fn(pid_t, *mut ProcessSerialNumber) -> i32;
type GetProcessPIDFn = unsafe extern "C" fn(*const ProcessSerialNumber, *mut pid_t) -> i32;
type CGEventSetWindowLocationFn = unsafe extern "C" fn(*mut c_void, CGPoint);
type SLPSSetFrontProcessWithOptionsFn =
	unsafe extern "C" fn(*const ProcessSerialNumber, u32, u32) -> i32;
type SLEventSetAuthenticationMessageFn = unsafe extern "C" fn(*mut c_void, *mut c_void);
type ObjcGetClassFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type SelRegisterNameFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type ClassRespondsToSelectorFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool;
type AuthenticationFactoryFn =
	unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, c_int, c_uint) -> *mut c_void;

#[derive(Clone, Copy)]
struct PsnLookup {
	main_connection:     Option<CGSMainConnectionIDFn>,
	get_window_owner:    Option<SLSGetWindowOwnerFn>,
	get_connection_psn:  Option<SLSGetConnectionPSNFn>,
	get_process_for_pid: Option<GetProcessForPIDFn>,
}

impl PsnLookup {
	fn can_resolve(self) -> bool {
		(self.main_connection.is_some()
			&& self.get_window_owner.is_some()
			&& self.get_connection_psn.is_some())
			|| self.get_process_for_pid.is_some()
	}
}

#[derive(Clone, Copy)]
struct RequiredSpi {
	post_to_pid:         SLEventPostToPidFn,
	/// `CGEventPostToPid` when it is a separate implementation; `None` where
	/// it re-exports `SLEventPostToPid` (as on macOS 26), since posting
	/// through both would then deliver every event twice.
	public_post_to_pid:  Option<SLEventPostToPidFn>,
	set_integer:         SLEventSetIntegerValueFieldFn,
	post_record:         SLPSPostEventRecordToFn,
	get_front:           SLPSGetFrontProcessFn,
	set_window_location: CGEventSetWindowLocationFn,
	psn:                 PsnLookup,
}

#[derive(Clone, Copy)]
struct ForegroundSpi {
	set_front:   SLPSSetFrontProcessWithOptionsFn,
	get_front:   SLPSGetFrontProcessFn,
	post_record: SLPSPostEventRecordToFn,
	psn:         PsnLookup,
}

#[derive(Clone, Copy)]
struct AuthenticationSpi {
	set_message:       SLEventSetAuthenticationMessageFn,
	objc_get_class:    ObjcGetClassFn,
	sel_register_name: SelRegisterNameFn,
	class_responds:    ClassRespondsToSelectorFn,
	factory:           AuthenticationFactoryFn,
}

/// The front process as `WindowServer` reports it. Unlike
/// `NSWorkspace.frontmostApplication`, this does not depend on an `AppKit`
/// run loop in this process observing activation changes.
#[derive(Clone, Copy)]
struct FrontProcess {
	psn: ProcessSerialNumber,
	pid: Option<pid_t>,
}

static REQUIRED: LazyLock<Option<RequiredSpi>> = LazyLock::new(resolve_required);
static AUTHENTICATION: LazyLock<Option<AuthenticationSpi>> = LazyLock::new(resolve_authentication);
static FOREGROUND: LazyLock<Option<ForegroundSpi>> = LazyLock::new(resolve_foreground);
static PROCESS_PID: LazyLock<Option<GetProcessPIDFn>> = LazyLock::new(|| symbol(c"GetProcessPID"));

pub(super) fn is_available() -> bool {
	required().is_ok() && takeover_available()
}

pub(super) fn takeover_available() -> bool {
	FOREGROUND.is_some() && PROCESS_PID.is_some()
}

fn required() -> CoreResult<&'static RequiredSpi> {
	REQUIRED.as_ref().ok_or_else(|| {
		DesktopError::background_unavailable(
			"skylight-spi-missing: required SkyLight background input symbols are unavailable; retry \
			 with takeover:true or use ax actions",
		)
	})
}

fn resolve_required() -> Option<RequiredSpi> {
	ensure_skylight_loaded()?;
	let psn = PsnLookup {
		main_connection:     Some(symbol(c"CGSMainConnectionID")?),
		get_window_owner:    symbol(c"SLSGetWindowOwner"),
		get_connection_psn:  symbol(c"SLSGetConnectionPSN"),
		get_process_for_pid: symbol(c"GetProcessForPID"),
	};
	if !psn.can_resolve() {
		return None;
	}
	let post_to_pid: SLEventPostToPidFn = symbol(c"SLEventPostToPid")?;
	Some(RequiredSpi {
		post_to_pid,
		public_post_to_pid: symbol::<SLEventPostToPidFn>(c"CGEventPostToPid")
			.filter(|public| *public as usize != post_to_pid as usize),
		set_integer: symbol(c"SLEventSetIntegerValueField")?,
		post_record: symbol(c"SLPSPostEventRecordTo")?,
		get_front: symbol(c"_SLPSGetFrontProcess")?,
		set_window_location: symbol(c"CGEventSetWindowLocation")?,
		psn,
	})
}

fn resolve_foreground() -> Option<ForegroundSpi> {
	ensure_skylight_loaded()?;
	let psn = PsnLookup {
		main_connection:     symbol(c"CGSMainConnectionID"),
		get_window_owner:    symbol(c"SLSGetWindowOwner"),
		get_connection_psn:  symbol(c"SLSGetConnectionPSN"),
		get_process_for_pid: symbol(c"GetProcessForPID"),
	};
	if !psn.can_resolve() {
		return None;
	}
	Some(ForegroundSpi {
		set_front: symbol(c"_SLPSSetFrontProcessWithOptions")?,
		get_front: symbol(c"_SLPSGetFrontProcess")?,
		post_record: symbol(c"SLPSPostEventRecordTo")?,
		psn,
	})
}

pub(super) fn ensure_skylight_loaded() -> Option<()> {
	static LOADED: LazyLock<bool> = LazyLock::new(|| {
		let path = c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";
		// SAFETY: `path` is a static NUL-terminated framework path; the handle is
		// intentionally process-lived.
		!unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL) }.is_null()
	});
	if *LOADED { Some(()) } else { None }
}

pub(super) fn symbol<T: Copy>(name: &CStr) -> Option<T> {
	// SAFETY: `name` is NUL-terminated and RTLD_DEFAULT is valid for
	// process-wide lookup.
	let raw = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
	if raw.is_null() {
		return None;
	}
	// SAFETY: Every callsite requests the exact C signature documented in its
	// function-pointer alias.
	Some(unsafe { mem::transmute_copy::<*mut c_void, T>(&raw) })
}

fn event_ptr(event: &CGEvent) -> *mut c_void {
	event.as_ptr().cast()
}

/// Stamps raw `SkyLight` integer event fields onto `event`.
pub(super) fn set_fields(event: &CGEvent, fields: &[(u32, i64)]) -> CoreResult<()> {
	let spi = required()?;
	let ptr = event_ptr(event);
	for &(field, value) in fields {
		// SAFETY: The event is alive for the call and `set_integer` passed the
		// atomic exact-signature probe.
		unsafe { (spi.set_integer)(ptr, field, value) };
	}
	Ok(())
}

/// Stamps a window-local point, measured from the window's top-left including
/// its title bar, for hit-testing a pid-addressed pointer event.
pub(super) fn set_window_location(event: &CGEvent, location: CGPoint) -> CoreResult<()> {
	let spi = required()?;
	// SAFETY: The event is alive for the call and the setter passed the atomic
	// exact-signature probe.
	unsafe { (spi.set_window_location)(event_ptr(event), location) };
	Ok(())
}

/// Posts a pointer event through `SkyLight` alone, without the keyboard
/// authentication envelope, which would route it past the session event tap
/// Chromium's window handler listens on.
pub(super) fn post_routed(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	control::check()?;
	event.set_integer_value_field(
		core_graphics::event::EventField::EVENT_SOURCE_USER_DATA,
		control::SYNTHETIC_EVENT_TAG,
	);
	let spi = required()?;
	// SAFETY: `event` remains retained for the synchronous post and
	// `post_to_pid` was atomically resolved with its exact ABI.
	unsafe { (spi.post_to_pid)(pid, event_ptr(event)) };
	Ok(())
}

/// Posts a background pointer event through `SkyLight`, then through the
/// public per-pid queue only where `CGEventPostToPid` is a separate function.
/// Where it is not, a second post would deliver the event twice. The separate
/// public post is kept as it was; its benefit there is unmeasured.
pub(super) fn post_dual(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	let spi = required()?;
	post_routed(pid, event)?;
	if let Some(public_post_to_pid) = spi.public_post_to_pid {
		control::check()?;
		// SAFETY: `event` remains retained for the synchronous post and the
		// symbol was resolved with the `SLEventPostToPid` ABI it shares.
		unsafe { public_post_to_pid(pid, event_ptr(event)) };
	}
	Ok(())
}

pub(super) fn post_keyboard(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	control::check()?;
	event.set_integer_value_field(
		core_graphics::event::EventField::EVENT_SOURCE_USER_DATA,
		control::SYNTHETIC_EVENT_TAG,
	);
	let spi = required()?;
	attach_keyboard_authentication(pid, event);
	// The authenticated SkyLight route reaches Chromium and AppKit. Posting the
	// same event through the public per-pid queue as well would deliver every
	// key twice. SAFETY: `event` remains retained and the exact symbol is part
	// of the required atomic probe.
	unsafe { (spi.post_to_pid)(pid, event_ptr(event)) };
	Ok(())
}

/// The 248-byte focus (`FOCUS_MARKER`) or defocus (`DEFOCUS_MARKER`) event
/// record addressed to window `wid`.
fn focus_record(wid: u32, marker: u8) -> [u8; EVENT_RECORD_LENGTH] {
	let mut record = [0u8; EVENT_RECORD_LENGTH];
	record[0x04] = EVENT_RECORD_LENGTH_BYTE;
	record[0x08] = EVENT_RECORD_KIND;
	record[WINDOW_ID_OFFSET..WINDOW_ID_OFFSET + 4].copy_from_slice(&wid.to_le_bytes());
	record[FOCUS_MARKER_OFFSET] = marker;
	record
}

/// One of the paired records (`kind` 0x01, then 0x02) that make window `wid`
/// the native key window of its process.
fn make_key_record(wid: u32, kind: u8) -> [u8; EVENT_RECORD_LENGTH] {
	let mut record = [0u8; EVENT_RECORD_LENGTH];
	record[0x04] = EVENT_RECORD_LENGTH_BYTE;
	record[0x08] = kind;
	record[0x20..0x30].fill(0xff);
	record[0x3a] = 0x10;
	record[WINDOW_ID_OFFSET..WINDOW_ID_OFFSET + 4].copy_from_slice(&wid.to_le_bytes());
	record
}

fn post_record(
	post: SLPSPostEventRecordToFn,
	psn: ProcessSerialNumber,
	record: &[u8; EVENT_RECORD_LENGTH],
) -> bool {
	// SAFETY: The PSN and the complete 248-byte record live through the
	// synchronous SPI call.
	unsafe { post(&psn, record.as_ptr()) == 0 }
}

fn front_process(get_front: SLPSGetFrontProcessFn) -> Option<FrontProcess> {
	let mut psn = ProcessSerialNumber::default();
	// SAFETY: `psn` is writable and exactly the 8-byte PSN record expected by
	// this SPI.
	if unsafe { get_front(&mut psn) } != 0 {
		return None;
	}
	let pid = (*PROCESS_PID).and_then(|get_pid| {
		let mut pid: pid_t = 0;
		// SAFETY: Both pointers are valid for the synchronous lookup and the
		// symbol has the exact GetProcessPID ABI.
		(unsafe { get_pid(&psn, &mut pid) } == 0 && pid > 0).then_some(pid)
	});
	Some(FrontProcess { psn, pid })
}

/// Joins the action and its cleanup without hiding a failed restoration or
/// encouraging an unsafe blind retry of an action that may already have landed.
pub(super) fn after_cleanup<T>(result: CoreResult<T>, cleanup: CoreResult<()>) -> CoreResult<T> {
	match (result, cleanup) {
		(result, Ok(())) => result,
		(Ok(_), Err(error)) => Err(DesktopError::input_failed(format!(
			"input may already have been delivered, but restoration failed: {error}; inspect the \
			 desktop before retrying"
		))),
		(Err(action), Err(cleanup)) => Err(DesktopError::input_failed(format!(
			"{action}; restoration also failed: {cleanup}; inspect the desktop before retrying"
		))),
	}
}

/// Hardware mouse presses (left, right, other `CGEventType`s): a click is how a
/// user picks a window, while typing in their own window is not. Events posted
/// to a pid do not advance these counters.
const POINTER_PRESS_TYPES: [u32; 3] = [1, 3, 25];

fn hid_counter(event_type: u32) -> u32 {
	// SAFETY: HIDSystemState (1) and these public CGEventType values are
	// defined by CGEventSource.h / CGEventTypes.h; this is a read-only query.
	unsafe { CGEventSourceCounterForEventType(1, event_type) }
}

/// Physical activity is a conservative veto, not proof of which app the user
/// chose. A source that updates HID counters for synthetic events can also veto
/// restoration; yielding control is safer than fighting a deliberate switch.
fn activation_activity() -> [u32; 5] {
	// Pointer presses, key press, and modifiers can change activation.
	let [left, right, other] = POINTER_PRESS_TYPES;
	[left, right, other, 10, 12].map(hid_counter)
}

fn pointer_presses() -> [u32; 3] {
	POINTER_PRESS_TYPES.map(hid_counter)
}

#[derive(Debug, PartialEq, Eq)]
enum FocusDecision {
	Observe,
	Restore,
	Disarm,
}

/// Once the user changes the front app/window, later target activations cannot
/// resurrect this action's old focus claim.
struct BackgroundFocusLease {
	previous: ProcessSerialNumber,
	target:   ProcessSerialNumber,
	key:      u32,
	activity: [u32; 5],
	disarmed: bool,
}

impl BackgroundFocusLease {
	fn observe(
		&mut self,
		front: ProcessSerialNumber,
		key: Option<u32>,
		activity: [u32; 5],
	) -> FocusDecision {
		if self.disarmed
			|| (front != self.previous && front != self.target)
			|| (front == self.previous && key.is_some_and(|key| key != self.key))
			|| (front == self.target && activity != self.activity)
		{
			self.disarmed = true;
			return FocusDecision::Disarm;
		}
		if front == self.target {
			FocusDecision::Restore
		} else {
			// Input while the user's original window is still frontmost is not
			// a focus change. Remember it so a later app reflex can be contained.
			self.activity = activity;
			FocusDecision::Observe
		}
	}
}

/// Contains asynchronous self-activation during background input and its
/// bounded post-action settle, without a process-lived observer or run loop.
/// A third app, changed prior key window, or new hardware input permanently
/// disarms the lease. Only the addressed target can be sent back behind the
/// original front app; unlike cua's wildcard suppressor, unrelated activations
/// are never undone.
pub(super) fn with_background_guard<T>(
	pid: pid_t,
	action: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
	control::check()?;
	let spi = FOREGROUND.as_ref().ok_or_else(|| {
		DesktopError::background_unavailable(
			"focus-restoration SPI is unavailable; use ax actions that do not activate the app or \
			 takeover:true",
		)
	})?;
	let previous = front_process(spi.get_front).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot establish the current front process before background input; retry with \
			 takeover:true",
		)
	})?;
	if previous.pid == Some(pid) {
		return action();
	}
	let target = process_psn(spi.psn, pid, 0).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot resolve the background target process; retry with takeover:true or use ax actions",
		)
	})?;
	let previous_key = previous.pid.and_then(ax::key_window_id).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot establish the user's key window for background focus restoration; retry with \
			 takeover:true or use ax actions",
		)
	})?;
	let mut lease = BackgroundFocusLease {
		previous: previous.psn,
		target,
		key: previous_key,
		activity: activation_activity(),
		disarmed: false,
	};
	let stopped = AtomicBool::new(false);
	thread::scope(|scope| {
		let stop = &stopped;
		let observer = thread::Builder::new()
			.name("desktop-focus-lease".to_string())
			.spawn_scoped(scope, move || -> CoreResult<()> {
				let mut restored = false;
				loop {
					let Some(front) = front_process(spi.get_front) else {
						return Err(DesktopError::input_failed(
							"lost the front process during background input",
						));
					};
					let key = if front.psn == previous.psn {
						previous.pid.and_then(ax::key_window_id)
					} else {
						None
					};
					match lease.observe(front.psn, key, activation_activity()) {
						FocusDecision::Disarm => return Ok(()),
						FocusDecision::Observe => {},
						FocusDecision::Restore => {
							// Re-check immediately before changing focus: an AX probe
							// may have raced a newer application or hardware event.
							if front_process(spi.get_front).is_some_and(|front| front.psn == target)
								&& activation_activity() == lease.activity
							{
								set_front(spi, previous.psn, previous_key)?;
								restored = true;
								if !post_record(
									spi.post_record,
									previous.psn,
									&focus_record(previous_key, FOCUS_MARKER),
								) {
									return Err(DesktopError::input_failed(
										"background key-window restoration was rejected",
									));
								}
							}
						},
					}
					if stop.load(Ordering::Acquire) {
						if restored
							&& front_process(spi.get_front).is_some_and(|front| front.psn == target)
						{
							return Err(DesktopError::input_failed(
								"the background target reactivated after focus restoration; input may \
								 already have landed; inspect the desktop and use takeover:true or ax \
								 actions",
							));
						}
						return Ok(());
					}
					thread::park_timeout(ACTIVATION_POLL);
				}
			})
			.map_err(|error| {
				DesktopError::background_unavailable(format!(
					"could not start the background focus guard: {error}; retry with takeover:true or \
					 use ax actions"
				))
			})?;
		struct StopObserver<'a> {
			stopped: &'a AtomicBool,
			thread:  thread::Thread,
		}
		impl Drop for StopObserver<'_> {
			fn drop(&mut self) {
				self.stopped.store(true, Ordering::Release);
				self.thread.unpark();
			}
		}
		let stop = StopObserver { stopped: &stopped, thread: observer.thread().clone() };
		let result = action().and_then(|value| control::wait(BACKGROUND_SETTLE).map(|()| value));
		drop(stop);
		let cleanup = observer.join().unwrap_or_else(|_| {
			Err(DesktopError::input_failed("background focus guard terminated unexpectedly"))
		});
		after_cleanup(result, cleanup)
	})
}

fn set_front(spi: &ForegroundSpi, psn: ProcessSerialNumber, wid: u32) -> CoreResult<()> {
	control::check()?;
	// SAFETY: The PSN was resolved from WindowServer. kCPSNoWindows changes
	// only the front process; no activate-all-windows fallback is permitted.
	if unsafe { (spi.set_front)(&psn, wid, CPS_NO_WINDOWS) } != 0 {
		return Err(DesktopError::input_failed(
			"WindowServer rejected front-process restoration/activation",
		));
	}
	Ok(())
}

/// Makes `wid` its process's key window without raising it or changing the
/// front process, runs `action`, then hands keyboard focus back.
///
/// A background process has no key window, so it drops pid-routed keystrokes,
/// and Chromium ignores clicks on a window that is not active. The focus
/// records that fix this also defocus the key window of the front process,
/// which would otherwise stop receiving the user's typing until they click it
/// again. Nothing is posted when the target already is the key window of the
/// front process.
pub(super) fn with_focus_without_raise<T>(
	pid: pid_t,
	wid: u32,
	action: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
	control::check()?;
	let presses = pointer_presses();
	let spi = required()?;
	let previous = front_process(spi.get_front).ok_or_else(|| {
		DesktopError::background_unavailable(format!(
			"window {wid} could not resolve the front process for background input; retry with \
			 takeover:true or use ax actions",
		))
	})?;
	let target = process_psn(spi.psn, pid, wid).ok_or_else(|| {
		DesktopError::background_unavailable(format!(
			"window {wid} could not resolve its process serial number for background input; retry \
			 with takeover:true or use ax actions",
		))
	})?;
	let previous_key = previous.pid.and_then(ax::key_window_id).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot identify the previous key window to restore; retry with takeover:true or use ax \
			 actions",
		)
	})?;
	if previous.psn == target && previous_key == wid {
		return action();
	}
	// The defocus record names the window losing key status; within one process
	// that distinguishes it from the target.
	control::check()?;
	let defocus = focus_record(previous_key, DEFOCUS_MARKER);
	let defocused = post_record(spi.post_record, previous.psn, &defocus);
	let focused = post_record(spi.post_record, target, &focus_record(wid, FOCUS_MARKER));
	if !defocused || !focused {
		return after_cleanup(
			Err(DesktopError::background_unavailable(format!(
				"window {wid} rejected the 248-byte SkyLight focus-without-raise record; retry with \
				 takeover:true or use ax actions",
			))),
			control::cleanup(|| {
				restore_focus_after_without_raise(spi, previous, previous_key, target, wid, presses)
			}),
		);
	}
	let result = control::wait(FOCUS_SETTLE)
		.and_then(|()| action())
		.and_then(|value| control::wait(FOCUS_SETTLE).map(|()| value));
	after_cleanup(
		result,
		control::cleanup(|| {
			restore_focus_after_without_raise(spi, previous, previous_key, target, wid, presses)
		}),
	)
}

/// Reverses [`with_focus_without_raise`]: defocuses the target and hands key
/// status back to `previous_key` in the previous front process. A target that
/// activated itself in response to the input (a link opening in a browser) is
/// first sent back behind the previous front process, without raising either;
/// a third application that took focus meanwhile is left alone, and so is a
/// key window the user picked in the previous front process (see
/// [`hands_back`]).
fn restore_focus_after_without_raise(
	spi: &RequiredSpi,
	previous: FrontProcess,
	previous_key: u32,
	target: ProcessSerialNumber,
	wid: u32,
	presses: [u32; 3],
) -> CoreResult<()> {
	let front = front_process(spi.get_front).ok_or_else(|| {
		DesktopError::input_failed("cannot establish current focus for background restoration")
	})?;
	// The asynchronous guard handles cross-process self-activation. Do not
	// second-guess its hardware-activity veto or take focus from another app.
	if front.psn != previous.psn {
		return Ok(());
	}
	let key = previous.pid.and_then(ax::key_window_id);
	if !hands_back(previous.psn == target, key, previous_key, wid, pointer_presses() != presses) {
		return Ok(());
	}
	if !front_process(spi.get_front).is_some_and(|front| front.psn == previous.psn) {
		return Ok(());
	}
	let defocused = post_record(spi.post_record, target, &focus_record(wid, DEFOCUS_MARKER));
	let focused =
		post_record(spi.post_record, previous.psn, &focus_record(previous_key, FOCUS_MARKER));
	if !defocused || !focused {
		return Err(DesktopError::input_failed("background focus restoration records were rejected"));
	}
	Ok(())
}

/// Whether focus goes back to `previous_key`, given the previous front
/// process's key window now. Another window there was the user's choice. The
/// target itself is still key after the focus record within one process, so
/// there only a hardware click marks it as the user's choice. Typing in their
/// own window never stops the hand-back: background input watches no keys.
const fn hands_back(
	same_process: bool,
	key: Option<u32>,
	previous_key: u32,
	wid: u32,
	clicked: bool,
) -> bool {
	match key {
		Some(key) if key == previous_key => true,
		Some(key) if same_process && key == wid => !clicked,
		Some(_) => false,
		None => true,
	}
}

/// Makes `wid` the frontmost key window, runs `action`, then restores the
/// previous front process (or, within one process, its previous key window).
///
/// `action` receives whether focus actually moved, so keyboard delivery can
/// give a just-activated surface time to arm its input handling. A target that
/// already is the key window of the front process is not re-activated:
/// re-activating it can clear Chromium's renderer focus. The window is made
/// key without being raised; callers that need it unobstructed raise it.
pub(super) fn with_foreground<T>(
	pid: pid_t,
	wid: u32,
	action: impl FnOnce(bool) -> CoreResult<T>,
) -> CoreResult<T> {
	control::check()?;
	let activity = control::user_activity();
	let spi = FOREGROUND.as_ref().ok_or_else(|| {
		DesktopError::input_failed("exact-window takeover SPI is unavailable; no input was sent")
	})?;
	let previous = front_process(spi.get_front).ok_or_else(|| {
		DesktopError::input_failed(
			"cannot identify the front process for takeover restoration; no input was sent",
		)
	})?;
	let target = process_psn(spi.psn, pid, wid).ok_or_else(|| {
		DesktopError::input_failed("cannot resolve the exact takeover target; no input was sent")
	})?;
	let focused = ax::focused_window_id(pid);
	if preserves_exact_existing_focus(Some(previous.psn), target, focused, wid) {
		return action(false).and_then(|value| control::wait(FOREGROUND_SETTLE).map(|()| value));
	}
	let previous_pid = previous.pid.ok_or_else(|| {
		DesktopError::input_failed(
			"cannot identify the previous application for takeover restoration; no input was sent",
		)
	})?;
	let previous_key = ax::key_window_id(previous_pid).ok_or_else(|| {
		DesktopError::input_failed(
			"cannot identify the previous key window for takeover restoration; no input was sent",
		)
	})?;
	let restore = |preparation_failed: bool| {
		if control::user_activity() != activity {
			return Ok(());
		}
		let front = front_process(spi.get_front).ok_or_else(|| {
			DesktopError::input_failed("cannot establish current focus for takeover restoration")
		})?;
		// A user-selected third app or sibling window must not be overwritten.
		if front.psn != target {
			return Ok(());
		}
		if ax::focused_window_id(pid)
			.is_some_and(|key| key != wid && (!preparation_failed || Some(key) != focused))
		{
			return Ok(());
		}
		if control::user_activity() != activity
			|| !front_process(spi.get_front).is_some_and(|front| front.psn == target)
		{
			return Ok(());
		}
		set_front(spi, previous.psn, previous_key)?;
		// Returning to an app often reinstates its original key window by
		// itself. Re-making an already-key Chromium window can clear the user's
		// renderer focus, just as reactivating an already-key input target can.
		if ax::focused_window_id(previous_pid) != Some(previous_key) {
			make_exact_window_key(spi, previous.psn, previous_key)?;
		}
		await_window_focused(spi, previous_pid, previous_key, previous.psn)
	};
	let prepare = set_front(spi, target, wid)
		.and_then(|()| make_exact_window_key(spi, target, wid))
		.and_then(|()| await_window_focused(spi, pid, wid, target));
	if let Err(error) = prepare {
		return after_cleanup(Err(error), control::cleanup(|| restore(true)));
	}
	let result = action(true).and_then(|value| control::wait(FOREGROUND_SETTLE).map(|()| value));
	after_cleanup(result, control::cleanup(|| restore(false)))
}

pub(super) fn require_front_window(pid: pid_t, wid: u32) -> CoreResult<()> {
	control::check()?;
	if is_front_window(pid, wid) {
		Ok(())
	} else {
		Err(DesktopError::input_failed(format!(
			"takeover window {wid} lost exact keyboard focus; stopped input, which may be partial; \
			 inspect the target before retrying"
		)))
	}
}

pub(super) fn is_front_window(pid: pid_t, wid: u32) -> bool {
	FOREGROUND.as_ref().is_some_and(|spi| {
		front_process(spi.get_front).is_some_and(|front| front.pid == Some(pid))
			&& ax::focused_window_id(pid) == Some(wid)
	})
}

/// Read-only focus identity used to verify non-activating Space operations.
pub(super) fn front_window_context() -> Option<(pid_t, u32)> {
	let spi = FOREGROUND.as_ref()?;
	let pid = front_process(spi.get_front)?.pid?;
	Some((pid, ax::key_window_id(pid)?))
}

/// Whether the target already is the key window of the front process.
fn preserves_exact_existing_focus(
	previous: Option<ProcessSerialNumber>,
	target: ProcessSerialNumber,
	focused: Option<u32>,
	wid: u32,
) -> bool {
	previous == Some(target) && focused == Some(wid)
}

/// Makes exactly `wid` the native key window of its front process without
/// raising it.
///
/// `AXFocusedWindow` can change without `AppKit` making the matching
/// `NSWindow` key, and menu validation and first-responder installation follow
/// the latter. This marks the front-process request as user generated and
/// posts the paired make-key records for the one window.
fn make_exact_window_key(
	spi: &ForegroundSpi,
	target: ProcessSerialNumber,
	wid: u32,
) -> CoreResult<()> {
	control::check()?;
	// SAFETY: Target PSN is valid and kCPSUserGenerated only changes how the
	// request is attributed.
	if unsafe { (spi.set_front)(&target, wid, CPS_USER_GENERATED) } != 0 {
		return Err(DesktopError::input_failed(format!(
			"window {wid} rejected exact key-window activation"
		)));
	}
	for kind in [0x01, 0x02] {
		if !post_record(spi.post_record, target, &make_key_record(wid, kind)) {
			return Err(DesktopError::input_failed(format!(
				"window {wid} rejected its make-key record"
			)));
		}
	}
	Ok(())
}

/// Waits until `wid` is its application's focused window.
///
/// Global HID input goes to whichever window is key, so a target that still
/// reports another focused window at the deadline refuses before any input is
/// sent. A front process alone is not proof of the exact key window.
fn await_window_focused(
	spi: &ForegroundSpi,
	pid: pid_t,
	wid: u32,
	target: ProcessSerialNumber,
) -> CoreResult<()> {
	let deadline = Instant::now() + ACTIVATION_TIMEOUT;
	loop {
		let focused = ax::focused_window_id(pid);
		let target_front = front_process(spi.get_front).is_some_and(|front| front.psn == target);
		if focused == Some(wid) && target_front {
			return Ok(());
		}
		if Instant::now() >= deadline {
			return Err(DesktopError::input_failed(format!(
				"window {wid} could not be confirmed as the exact frontmost key window",
			)));
		}
		control::wait(ACTIVATION_POLL)?;
	}
}

fn process_psn(lookup: PsnLookup, pid: pid_t, wid: u32) -> Option<ProcessSerialNumber> {
	if let (Some(main_connection), Some(get_window_owner), Some(get_connection_psn)) =
		(lookup.main_connection, lookup.get_window_owner, lookup.get_connection_psn)
	{
		// SAFETY: The no-argument connection query was resolved with its exact
		// signature.
		let main_connection = unsafe { main_connection() };
		let mut owner_connection = 0u32;
		// SAFETY: `owner_connection` is writable for the synchronous lookup.
		if unsafe { get_window_owner(main_connection, wid, &mut owner_connection) } == 0
			&& owner_connection != 0
		{
			let mut psn = ProcessSerialNumber::default();
			// SAFETY: `psn` is writable and has the exact 8-byte layout required
			// by the SPI.
			if unsafe { get_connection_psn(owner_connection, &mut psn) } == 0 {
				return Some(psn);
			}
		}
	}
	let fallback = lookup.get_process_for_pid?;
	let mut psn = ProcessSerialNumber::default();
	// SAFETY: `psn` is writable and `fallback` was resolved with the exact
	// GetProcessForPID ABI.
	if unsafe { fallback(pid, &mut psn) } == 0 {
		Some(psn)
	} else {
		None
	}
}

fn resolve_authentication() -> Option<AuthenticationSpi> {
	Some(AuthenticationSpi {
		set_message:       symbol(c"SLEventSetAuthenticationMessage")?,
		objc_get_class:    symbol(c"objc_getClass")?,
		sel_register_name: symbol(c"sel_registerName")?,
		class_responds:    symbol(c"class_respondsToSelector")?,
		factory:           symbol(c"objc_msgSend")?,
	})
}

fn attach_keyboard_authentication(pid: pid_t, event: &CGEvent) {
	let Some(spi) = AUTHENTICATION.as_ref() else {
		return;
	};
	// SAFETY: Both C strings are static; runtime lookup functions have their
	// exact Objective-C ABI.
	let class = unsafe { (spi.objc_get_class)(c"SLSEventAuthenticationMessage".as_ptr()) };
	// SAFETY: The selector C string is static and NUL-terminated.
	let selector =
		unsafe { (spi.sel_register_name)(c"messageWithEventRecord:pid:version:".as_ptr()) };
	if class.is_null() || selector.is_null() {
		return;
	}
	// SAFETY: This guard is required because macOS 14 has the class but lacks
	// the macOS 15+ factory selector.
	if !unsafe { (spi.class_responds)(class, selector) } {
		return;
	}
	// __CGEvent stores its SLSEventRecord pointer after CFRuntimeBase and a
	// padded u32.
	let event_raw = event_ptr(event);
	let mut record = ptr::null_mut();
	for offset in [24usize, 32, 16] {
		// SAFETY: These are the known pointer-aligned candidate slots in
		// __CGEvent; read_unaligned avoids alignment assumptions.
		let candidate =
			unsafe { ptr::read_unaligned(event_raw.cast::<u8>().add(offset).cast::<*mut c_void>()) };
		if !candidate.is_null() {
			record = candidate;
			break;
		}
	}
	if record.is_null() {
		return;
	}
	// SAFETY: Class response was checked before invoking this exact factory
	// signature.
	let message = unsafe { (spi.factory)(class, selector, record, pid, 0) };
	if message.is_null() {
		return;
	}
	// SAFETY: The event and autoreleased authentication object are alive for the
	// synchronous attachment.
	unsafe { (spi.set_message)(event_raw, message) };
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn user_focus_changes_permanently_disarm_background_restoration() {
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let third = ProcessSerialNumber { high: 0, low: 9 };
		let lease =
			|| BackgroundFocusLease { previous, target, key: 42, activity: [0; 5], disarmed: false };
		let mut guard = lease();
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Restore);
		assert_eq!(guard.observe(third, None, [0; 5]), FocusDecision::Disarm);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Disarm);

		let mut guard = lease();
		assert_eq!(guard.observe(previous, Some(43), [0; 5]), FocusDecision::Disarm);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Disarm);

		let mut guard = lease();
		assert_eq!(guard.observe(target, None, [1; 5]), FocusDecision::Disarm);
	}

	#[test]
	fn typing_in_the_original_window_does_not_claim_a_user_focus_switch() {
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let mut guard =
			BackgroundFocusLease { previous, target, key: 42, activity: [0; 5], disarmed: false };
		assert_eq!(guard.observe(previous, Some(42), [1; 5]), FocusDecision::Observe);
		assert_eq!(guard.observe(target, None, [1; 5]), FocusDecision::Restore);
	}

	#[test]
	fn only_the_exact_key_window_of_the_front_process_skips_activation() {
		let target = ProcessSerialNumber { high: 0, low: 7 };
		let other = ProcessSerialNumber { high: 0, low: 8 };
		assert!(preserves_exact_existing_focus(Some(target), target, Some(42), 42));
		assert!(!preserves_exact_existing_focus(Some(other), target, Some(42), 42));
		assert!(!preserves_exact_existing_focus(Some(target), target, Some(41), 42));
		assert!(!preserves_exact_existing_focus(Some(target), target, None, 42));
		assert!(!preserves_exact_existing_focus(None, target, Some(42), 42));
	}

	#[test]
	fn focus_hand_back_yields_only_to_a_window_the_user_picked() {
		let (user, target) = (7, 42);
		// Typing in their own app moves no window: focus goes back to it.
		assert!(hands_back(false, Some(user), user, target, false));
		assert!(hands_back(true, Some(user), user, target, true), "a click in their own window");
		assert!(hands_back(true, None, user, target, false));
		// A sibling target still key after the focus record is ours to hand back,
		// unless the user clicked it.
		assert!(hands_back(true, Some(target), user, target, false));
		assert!(!hands_back(true, Some(target), user, target, true));
		assert!(!hands_back(true, Some(9), user, target, false), "another window the user picked");
		assert!(!hands_back(false, Some(9), user, target, false));
	}
}
