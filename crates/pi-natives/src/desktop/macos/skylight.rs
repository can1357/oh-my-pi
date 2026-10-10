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
/// `kCPSUserGenerated`: lets `AppKit` install the requested native key window.
const CPS_USER_GENERATED: u32 = 0x200;
/// `kCPSNoWindows`: changes the front process without raising its windows.
const CPS_NO_WINDOWS: u32 = 0x400;
/// Covers delayed AX/AppKit activation after the synchronous action returns.
/// The lease is joined before returning; it never continues fighting the user.
const BACKGROUND_SETTLE: Duration = Duration::from_millis(200);
/// Upper bound on waiting for a foreground activation to become observable.
const ACTIVATION_TIMEOUT: Duration = Duration::from_millis(400);
const ACTIVATION_POLL: Duration = Duration::from_millis(10);
/// How recent a mouse click or ⌘/⌃ chord must be for a target activation to
/// count as the user's own switch. Measured on a VM: ⌘-Tab activates the chosen
/// app about 3 ms after ⌘ is released, at most one poll after the guard last
/// saw ⌘ held.
const USER_SWITCH_WINDOW: Duration = Duration::from_millis(250);
/// Keeps the target frontmost until it has consumed foreground input.
const FOREGROUND_SETTLE: Duration = Duration::from_millis(40);

unsafe extern "C" {
	fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
	fn CGEventSourceFlagsState(state: i32) -> u64;
	fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
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
/// Writes the process holding keyboard focus and a status byte.
type SLPSGetKeyFocusProcessFn = unsafe extern "C" fn(*mut ProcessSerialNumber, *mut u8) -> i32;
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
	set_window_location: CGEventSetWindowLocationFn,
	main_connection:     CGSMainConnectionIDFn,
}

#[derive(Clone, Copy)]
struct ForegroundSpi {
	set_front:     SLPSSetFrontProcessWithOptionsFn,
	get_front:     SLPSGetFrontProcessFn,
	/// Differs from the front process while a panel of another process, such
	/// as Spotlight or a launcher, has the keyboard.
	get_key_focus: Option<SLPSGetKeyFocusProcessFn>,
	post_record:   SLPSPostEventRecordToFn,
	psn:           PsnLookup,
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
	let post_to_pid: SLEventPostToPidFn = symbol(c"SLEventPostToPid")?;
	Some(RequiredSpi {
		post_to_pid,
		public_post_to_pid: symbol::<SLEventPostToPidFn>(c"CGEventPostToPid")
			.filter(|public| *public as usize != post_to_pid as usize),
		set_integer: symbol(c"SLEventSetIntegerValueField")?,
		set_window_location: symbol(c"CGEventSetWindowLocation")?,
		main_connection: symbol(c"CGSMainConnectionID")?,
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
		get_key_focus: symbol(c"SLPSGetKeyFocusProcess"),
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

/// This process's `WindowServer` connection, which `AppKit` stamps on the
/// window events it builds as their window context.
pub(super) fn sender_connection() -> CoreResult<i64> {
	let spi = required()?;
	// SAFETY: The no-argument connection query was resolved with its exact
	// signature.
	Ok(i64::from(unsafe { (spi.main_connection)() }))
}

/// The 248-byte focus event record addressed to window `wid`.
fn focus_record(wid: u32) -> [u8; EVENT_RECORD_LENGTH] {
	let mut record = [0u8; EVENT_RECORD_LENGTH];
	record[0x04] = EVENT_RECORD_LENGTH_BYTE;
	record[0x08] = EVENT_RECORD_KIND;
	record[WINDOW_ID_OFFSET..WINDOW_ID_OFFSET + 4].copy_from_slice(&wid.to_le_bytes());
	record[FOCUS_MARKER_OFFSET] = FOCUS_MARKER;
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

/// `kCGEventSourceStateHIDSystemState`: input from hardware. Events posted to a
/// pid, as background input is, leave it unchanged.
const HID_SYSTEM_STATE: i32 = 1;
/// Left, right and other mouse button down and up (`CGEventType`).
const MOUSE_BUTTON_EVENTS: [u32; 6] = [1, 2, 3, 4, 25, 26];
/// `kCGEventFlagsChanged`: a modifier key went down or up.
const FLAGS_CHANGED: u32 = 12;
/// ⌘ and ⌃ (`kCGEventFlagMaskCommand | Control`). ⌥ is left out: it types
/// characters on German, Polish, French and Nordic layouts, and alone it
/// picks no app (⌥-click counts as a click).
const SWITCH_MODIFIERS: u64 = 0x0010_0000 | 0x0004_0000;
/// Longest gap between two samples that cannot hide a whole ⌘/⌃ chord: a
/// ⌘-Tab holds ⌘ about 100 ms. Across a longer gap (the poll blocked in an AX
/// probe, or descheduled) any modifier change may have been one.
const UNSEEN_CHORD_GAP: Duration = Duration::from_millis(40);

/// What one poll reads of how the user could be switching apps. Typing, Shift
/// and Caps Lock pick no app, so none of them appear here.
#[derive(Clone, Copy)]
struct SwitchSignals {
	/// HID counters of `MOUSE_BUTTON_EVENTS`.
	buttons:    [u32; 6],
	/// When a mouse button last went down or up.
	last_click: Option<Instant>,
	/// A switch modifier is held now.
	chord:      bool,
	/// HID counter of modifier key changes, including Shift's.
	modifiers:  u32,
	/// The process that has the keyboard.
	key_focus:  Option<ProcessSerialNumber>,
}

impl SwitchSignals {
	const fn new(
		buttons: [u32; 6],
		last_click: Option<Instant>,
		flags: u64,
		modifiers: u32,
		key_focus: Option<ProcessSerialNumber>,
	) -> Self {
		Self { buttons, last_click, chord: flags & SWITCH_MODIFIERS != 0, modifiers, key_focus }
	}

	fn read(spi: &ForegroundSpi, now: Instant) -> Self {
		// SAFETY: HIDSystemState and these public CGEventType values are defined
		// by CGEventSource.h / CGEventTypes.h; these are read-only queries.
		let buttons = MOUSE_BUTTON_EVENTS.map(|event_type| unsafe {
			CGEventSourceCounterForEventType(HID_SYSTEM_STATE, event_type)
		});
		let last_click = MOUSE_BUTTON_EVENTS
			.into_iter()
			// SAFETY: as above.
			.map(|event_type| unsafe {
				CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, event_type)
			})
			.filter_map(|seconds| Duration::try_from_secs_f64(seconds).ok())
			.min()
			.and_then(|since| now.checked_sub(since));
		// SAFETY: as above.
		let flags = unsafe { CGEventSourceFlagsState(HID_SYSTEM_STATE) };
		// SAFETY: as above.
		let modifiers = unsafe { CGEventSourceCounterForEventType(HID_SYSTEM_STATE, FLAGS_CHANGED) };
		let key_focus = spi.get_key_focus.and_then(|get_key_focus| {
			let mut psn = ProcessSerialNumber::default();
			let mut status = 0u8;
			// SAFETY: Both out-pointers are writable for the synchronous call,
			// which writes the 8-byte PSN and one status byte.
			(unsafe { get_key_focus(&mut psn, &mut status) } == 0).then_some(psn)
		});
		Self::new(buttons, last_click, flags, modifiers, key_focus)
	}
}

/// How the user, rather than an app, changed the front app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserSwitch {
	/// A hardware mouse button went down or up anywhere: on another app's
	/// window, the Dock, the app switcher, a Spotlight result, or the user's
	/// own app just before the target came forward.
	Click,
	/// ⌘ or ⌃ was held: ⌘-Tab, ⌘-H, Spaces, launcher hotkeys.
	Chord,
	/// Another process's panel had the keyboard, as Spotlight's does while the
	/// user types an app name and presses Return.
	Panel,
}

/// Answers "did the user switch apps on purpose since T, and how?" for an
/// action between the user's app and the `target`, whose own focus grabs are
/// not the user's doing. Clicks are timed exactly from the HID state. A chord
/// or panel is seen while it lasts; a chord that began and ended between two
/// samples further apart than `UNSEEN_CHORD_GAP` is assumed from the modifier
/// counter.
struct UserSwitchWatch {
	user:      ProcessSerialNumber,
	target:    ProcessSerialNumber,
	buttons:   [u32; 6],
	modifiers: u32,
	sampled:   Instant,
	click:     Option<Instant>,
	chord:     Option<Instant>,
	panel:     Option<Instant>,
}

impl UserSwitchWatch {
	/// Starts with the user's app in front at `now`; a click up to `lookback`
	/// earlier still counts.
	fn new(
		user: ProcessSerialNumber,
		target: ProcessSerialNumber,
		signals: SwitchSignals,
		now: Instant,
		lookback: Duration,
	) -> Self {
		let mut watch = Self {
			user,
			target,
			buttons: signals.buttons,
			modifiers: signals.modifiers,
			sampled: now,
			click: signals
				.last_click
				.filter(|at| now.saturating_duration_since(*at) <= lookback),
			chord: None,
			panel: None,
		};
		watch.observe_held(signals, user, now);
		watch
	}

	fn observe(&mut self, signals: SwitchSignals, front: ProcessSerialNumber, now: Instant) {
		if signals.buttons != self.buttons {
			self.buttons = signals.buttons;
			self.click = Some(signals.last_click.unwrap_or(now));
		}
		if signals.modifiers != self.modifiers
			&& now.saturating_duration_since(self.sampled) > UNSEEN_CHORD_GAP
		{
			self.chord = Some(now);
		}
		self.modifiers = signals.modifiers;
		self.sampled = now;
		self.observe_held(signals, front, now);
	}

	fn observe_held(&mut self, signals: SwitchSignals, front: ProcessSerialNumber, now: Instant) {
		if signals.chord {
			self.chord = Some(now);
		}
		if signals
			.key_focus
			.is_some_and(|focus| focus != front && focus != self.user && focus != self.target)
		{
			self.panel = Some(now);
		}
	}

	/// The latest switch seen at or after `start`.
	fn since(&self, start: Instant) -> Option<UserSwitch> {
		[
			(self.click, UserSwitch::Click),
			(self.chord, UserSwitch::Chord),
			(self.panel, UserSwitch::Panel),
		]
		.into_iter()
		.filter_map(|(at, how)| at.filter(|at| *at >= start).map(|at| (at, how)))
		.max_by_key(|(at, _)| *at)
		.map(|(_, how)| how)
	}
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
	user:     UserSwitchWatch,
	disarmed: bool,
}

impl BackgroundFocusLease {
	fn new(
		previous: ProcessSerialNumber,
		target: ProcessSerialNumber,
		key: u32,
		signals: SwitchSignals,
		now: Instant,
	) -> Self {
		let user = UserSwitchWatch::new(previous, target, signals, now, USER_SWITCH_WINDOW);
		Self { previous, target, key, user, disarmed: false }
	}

	fn observe(
		&mut self,
		front: ProcessSerialNumber,
		key: Option<u32>,
		signals: SwitchSignals,
		now: Instant,
	) -> FocusDecision {
		self.user.observe(signals, front, now);
		// The target came forward right after a user switch: the user picked it.
		// Otherwise it activated itself, even while the user kept typing.
		let picked = now
			.checked_sub(USER_SWITCH_WINDOW)
			.and_then(|start| self.user.since(start))
			.is_some();
		if self.disarmed
			|| (front != self.previous && front != self.target)
			|| (front == self.previous && key.is_some_and(|key| key != self.key))
			|| (front == self.target && picked)
		{
			self.disarmed = true;
			return FocusDecision::Disarm;
		}
		if front == self.target {
			FocusDecision::Restore
		} else {
			FocusDecision::Observe
		}
	}

	/// Whether, after a restore, the target is in front again at the end of
	/// the action without the user having switched to it.
	fn reactivated(
		&mut self,
		restored: bool,
		front: ProcessSerialNumber,
		signals: SwitchSignals,
		now: Instant,
	) -> bool {
		restored
			&& front == self.target
			&& self.observe(front, None, signals, now) == FocusDecision::Restore
	}
}

/// Contains asynchronous self-activation during background input and its
/// bounded post-action settle, without a process-lived observer or run loop.
/// A third app, a changed prior key window, or the target coming forward right
/// after a click, a ⌘/⌃ chord or a Spotlight-style panel permanently disarms
/// the lease; typing does not. Only the addressed target can be sent back
/// behind the original front app; unrelated activations are never undone.
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
	let now = Instant::now();
	let mut lease = BackgroundFocusLease::new(
		previous.psn,
		target,
		previous_key,
		SwitchSignals::read(spi, now),
		now,
	);
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
					let now = Instant::now();
					match lease.observe(front.psn, key, SwitchSignals::read(spi, now), now) {
						FocusDecision::Disarm => return Ok(()),
						FocusDecision::Observe => {},
						FocusDecision::Restore => {
							// Re-check immediately before changing focus: an AX probe
							// may have raced a newer application or user switch.
							if front_process(spi.get_front).is_some_and(|front| front.psn == target) {
								let now = Instant::now();
								match lease.observe(target, None, SwitchSignals::read(spi, now), now) {
									FocusDecision::Disarm => return Ok(()),
									FocusDecision::Observe => {},
									FocusDecision::Restore => {
										set_front(spi, previous.psn, previous_key)?;
										restored = true;
										if !post_record(
											spi.post_record,
											previous.psn,
											&focus_record(previous_key),
										) {
											return Err(DesktopError::input_failed(
												"background key-window restoration was rejected",
											));
										}
									},
								}
							}
						},
					}
					if stop.load(Ordering::Acquire) {
						let now = Instant::now();
						if front_process(spi.get_front).is_some_and(|front| {
							lease.reactivated(restored, front.psn, SwitchSignals::read(spi, now), now)
						}) {
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

/// The front process as `WindowServer` reports it.
pub(super) fn front_pid() -> Option<pid_t> {
	front_process(FOREGROUND.as_ref()?.get_front)?.pid
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

	const PREVIOUS: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 7 };
	const TARGET: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 8 };
	const THIRD: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 9 };
	// HID flag states as a USB keyboard reports them on macOS.
	const NO_MODIFIERS: u64 = 0x100;
	const SHIFT: u64 = 0x2_0102;
	const CAPS_LOCK: u64 = 0x1_0100;
	const FN: u64 = 0x80_0100;
	const COMMAND: u64 = 0x10_0108;
	const OPTION: u64 = 0x8_0120;
	const CONTROL: u64 = 0x4_0101;

	/// Signals after `clicks` hardware clicks (left down and up), timed between
	/// polls, with no key focus reading.
	fn input(clicks: u32, flags: u64) -> SwitchSignals {
		SwitchSignals::new([clicks, clicks, 0, 0, 0, 0], None, flags, 0, None)
	}

	/// Signals after `count` modifier key changes, none held now.
	fn modifier_changes(count: u32) -> SwitchSignals {
		SwitchSignals::new([0; 6], None, NO_MODIFIERS, count, None)
	}

	/// Signals after one click at `at`, timed by the HID state.
	fn clicked_at(at: Instant) -> SwitchSignals {
		SwitchSignals::new([1, 1, 0, 0, 0, 0], Some(at), NO_MODIFIERS, 0, None)
	}

	/// Signals with no clicks or modifiers while `process` has the keyboard.
	fn keyboard_in(process: ProcessSerialNumber) -> SwitchSignals {
		SwitchSignals::new([0; 6], None, NO_MODIFIERS, 0, Some(process))
	}

	fn ms(millis: u64) -> Duration {
		Duration::from_millis(millis)
	}

	/// A lease started at `start`, the user's last hardware click at
	/// `last_click`.
	fn lease_at(start: Instant, last_click: Option<Instant>) -> BackgroundFocusLease {
		let signals = SwitchSignals::new([0; 6], last_click, NO_MODIFIERS, 0, None);
		BackgroundFocusLease::new(PREVIOUS, TARGET, 42, signals, start)
	}

	#[test]
	fn user_switch_watch_names_how_the_user_switched_since_a_time() {
		let t0 = Instant::now();
		let watch = |signals| UserSwitchWatch::new(PREVIOUS, TARGET, signals, t0, ms(250));
		// Typing, Shift, Caps Lock, the Globe key and ⌥ switch nothing.
		for flags in [NO_MODIFIERS, SHIFT, CAPS_LOCK, FN, OPTION] {
			assert_eq!(watch(input(0, flags)).since(t0), None, "flags {flags:#x}");
		}
		for flags in [COMMAND, CONTROL] {
			assert_eq!(watch(input(0, flags)).since(t0), Some(UserSwitch::Chord), "flags {flags:#x}");
		}
		assert_eq!(watch(keyboard_in(THIRD)).since(t0), Some(UserSwitch::Panel));
		// The keyboard in either app of the action is not another panel.
		assert_eq!(watch(keyboard_in(PREVIOUS)).since(t0), None);
		assert_eq!(watch(keyboard_in(TARGET)).since(t0), None);

		// A click is timed by the HID state, not by when a poll saw it.
		assert_eq!(watch(clicked_at(t0)).since(t0), Some(UserSwitch::Click));
		let mut later = watch(input(0, NO_MODIFIERS));
		later.observe(clicked_at(t0 + ms(5)), PREVIOUS, t0 + ms(40));
		assert_eq!(later.since(t0 + ms(5)), Some(UserSwitch::Click));
		assert_eq!(later.since(t0 + ms(6)), None, "the click came before");
		// A click older than the lookback when watching starts does not count.
		let started = UserSwitchWatch::new(PREVIOUS, TARGET, clicked_at(t0), t0 + ms(251), ms(250));
		assert_eq!(started.since(t0), None);

		// Modifier changes between polls are typing; across a gap long enough to
		// hide a whole ⌘-Tab they may have been a chord.
		let mut polled = watch(input(0, NO_MODIFIERS));
		polled.observe(modifier_changes(2), PREVIOUS, t0 + UNSEEN_CHORD_GAP);
		assert_eq!(polled.since(t0), None);
		let mut blocked = watch(input(0, NO_MODIFIERS));
		blocked.observe(modifier_changes(0), PREVIOUS, t0 + ms(500));
		assert_eq!(blocked.since(t0), None, "no modifier changed");
		blocked.observe(modifier_changes(2), PREVIOUS, t0 + ms(1000));
		assert_eq!(blocked.since(t0 + ms(1000)), Some(UserSwitch::Chord));

		// The latest switch names the reason; one before `start` does not count.
		let mut both = watch(input(0, COMMAND));
		both.observe(keyboard_in(THIRD), PREVIOUS, t0 + ms(30));
		assert_eq!(both.since(t0), Some(UserSwitch::Panel));
		assert_eq!(both.since(t0 + ms(31)), None);
	}

	#[test]
	fn user_focus_changes_permanently_disarm_background_restoration() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(TARGET, None, idle, t0), FocusDecision::Restore);
		assert_eq!(guard.observe(THIRD, None, idle, t0 + ms(10)), FocusDecision::Disarm);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20)), FocusDecision::Disarm);

		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(PREVIOUS, Some(43), idle, t0 + ms(10)), FocusDecision::Disarm);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20)), FocusDecision::Disarm);
	}

	#[test]
	fn typing_through_a_target_self_activation_keeps_the_users_app_in_front() {
		let t0 = Instant::now();
		// A capital letter's Shift, Caps Lock, the Globe key, or ⌥ typing a
		// character on a German, Polish, French or Nordic layout.
		for flags in [NO_MODIFIERS, SHIFT, CAPS_LOCK, FN, OPTION] {
			let mut guard = lease_at(t0, None);
			assert_eq!(
				guard.observe(PREVIOUS, Some(42), input(0, flags), t0 + ms(10)),
				FocusDecision::Observe
			);
			// The target activates itself while the key is held.
			assert_eq!(
				guard.observe(TARGET, None, input(0, flags), t0 + ms(20)),
				FocusDecision::Restore,
				"flags {flags:#x}"
			);
			// It may do so again later in the same lease.
			assert_eq!(
				guard.observe(PREVIOUS, Some(42), input(0, NO_MODIFIERS), t0 + ms(30)),
				FocusDecision::Observe
			);
			assert_eq!(
				guard.observe(TARGET, None, input(0, SHIFT), t0 + ms(40)),
				FocusDecision::Restore
			);
		}

		// Shift pressed and released between two polls, 9 ms before the target
		// came forward (a traced failure).
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), modifier_changes(0), t0 + ms(10)),
			FocusDecision::Observe
		);
		assert_eq!(
			guard.observe(TARGET, None, modifier_changes(2), t0 + ms(22)),
			FocusDecision::Restore
		);

		// A chord or click that ended longer ago than the switch window picked
		// nothing the target's activation follows from.
		let late = t0 + USER_SWITCH_WINDOW + ms(1);
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(PREVIOUS, Some(42), input(1, COMMAND), t0), FocusDecision::Observe);
		assert_eq!(guard.observe(TARGET, None, input(1, NO_MODIFIERS), late), FocusDecision::Restore);
		let mut guard = lease_at(t0 + ms(50), Some(t0));
		assert_eq!(guard.observe(TARGET, None, input(0, NO_MODIFIERS), late), FocusDecision::Restore);

		// The keyboard in the user's app, or taken by the target itself, is no
		// user switch either.
		for holder in [PREVIOUS, TARGET] {
			let mut guard = lease_at(t0, None);
			assert_eq!(
				guard.observe(PREVIOUS, Some(42), keyboard_in(holder), t0 + ms(10)),
				FocusDecision::Observe
			);
			assert_eq!(
				guard.observe(TARGET, None, keyboard_in(TARGET), t0 + ms(20)),
				FocusDecision::Restore
			);
		}
	}

	#[test]
	fn a_click_chord_or_spotlight_right_before_the_target_comes_forward_is_the_users_switch() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// ⌘-Tab: ⌘ held at the last poll, released just before the target came
		// forward (13 ms apart on a VM).
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), input(0, COMMAND), t0 + ms(100)),
			FocusDecision::Observe
		);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(113)), FocusDecision::Disarm);
		assert_eq!(
			guard.observe(TARGET, None, idle, t0 + ms(1000)),
			FocusDecision::Disarm,
			"a switch disarms the lease for good"
		);

		// ⌘ or ⌃ still held as the target comes forward (⌘-H, Spaces,
		// launchers).
		for flags in [COMMAND, CONTROL] {
			let mut guard = lease_at(t0, None);
			assert_eq!(
				guard.observe(TARGET, None, input(0, flags), t0 + ms(10)),
				FocusDecision::Disarm,
				"flags {flags:#x}"
			);
		}

		// A whole ⌘-Tab between two polls while one was blocked in an AX probe:
		// ⌘ was never seen held, but its press and release were counted.
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), modifier_changes(0), t0 + ms(10)),
			FocusDecision::Observe
		);
		assert_eq!(
			guard.observe(TARGET, None, modifier_changes(2), t0 + ms(510)),
			FocusDecision::Disarm
		);

		// A click on the Dock or another window, seen by the poll that also sees
		// the target in front (a click seen earlier is in the test below).
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(TARGET, None, input(1, NO_MODIFIERS), t0 + ms(10)),
			FocusDecision::Disarm
		);

		// A click just before the action began, or a chord held as it began.
		let mut guard = lease_at(t0 + ms(50), Some(t0));
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(60)), FocusDecision::Disarm);
		let mut guard = BackgroundFocusLease::new(PREVIOUS, TARGET, 42, input(0, COMMAND), t0);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(10)), FocusDecision::Disarm);

		// Spotlight: its panel has the keyboard while the user's app stays in
		// front, then Return brings the target forward (about 10 ms later on a
		// VM).
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), keyboard_in(THIRD), t0 + ms(500)),
			FocusDecision::Observe
		);
		assert_eq!(
			guard.observe(TARGET, None, keyboard_in(TARGET), t0 + ms(525)),
			FocusDecision::Disarm
		);
	}

	#[test]
	fn a_click_in_the_users_app_right_before_the_target_comes_forward_leaves_the_target_in_front() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// The user clicks a link in their app that opens in the target, during
		// the action: the target stays in front for good.
		let mut guard = lease_at(t0, None);
		let click = clicked_at(t0 + ms(5));
		assert_eq!(guard.observe(PREVIOUS, Some(42), click, t0 + ms(10)), FocusDecision::Observe);
		assert_eq!(guard.observe(TARGET, None, click, t0 + ms(100)), FocusDecision::Disarm);
		assert_eq!(guard.observe(TARGET, None, click, t0 + ms(1000)), FocusDecision::Disarm);
		// The same click just before the action began.
		let mut guard = BackgroundFocusLease::new(PREVIOUS, TARGET, 42, clicked_at(t0), t0 + ms(50));
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(60)), FocusDecision::Disarm);
		// Without the click, typing in the user's app still restores it.
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(PREVIOUS, Some(42), idle, t0 + ms(10)), FocusDecision::Observe);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(100)), FocusDecision::Restore);
	}

	#[test]
	fn the_target_back_in_front_at_the_end_is_an_error_only_without_a_user_switch() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// It reactivated itself after the restore: input may have landed there.
		assert!(lease_at(t0, None).reactivated(true, TARGET, idle, t0 + ms(10)));
		// The user switched to it just as the action ended.
		assert!(!lease_at(t0, None).reactivated(true, TARGET, input(0, COMMAND), t0 + ms(10)));
		assert!(!lease_at(t0, None).reactivated(true, TARGET, keyboard_in(THIRD), t0 + ms(10)));
		// Nothing was restored, or another app is in front.
		assert!(!lease_at(t0, None).reactivated(false, TARGET, idle, t0 + ms(10)));
		assert!(!lease_at(t0, None).reactivated(true, THIRD, idle, t0 + ms(10)));
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
}
