use std::{
	cell::Cell,
	ffi::c_void,
	ptr,
	sync::{
		LazyLock,
		atomic::{AtomicBool, AtomicU32, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use core_graphics::{
	event::{CGEvent, CGEventType},
	event_source::{CGEventSource, CGEventSourceStateID},
	geometry::CGPoint,
};
use foreign_types::ForeignType;
use libc::pid_t;
use objc2_app_kit::NSRunningApplication;
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use parking_lot::Mutex;

use super::{
	super::{
		control,
		error::{CoreResult, DesktopError, ErrorCode},
		types::DesktopFocusReturn,
	},
	ax, capture,
	key_reroute::KeyReroute,
	permission, process,
	release::Route,
	release_guard,
	route::{self, Routes, symbol},
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
/// Covers delayed AX/AppKit activation after the synchronous action returns:
/// its end is the action's last act on its target ([`note_send`]), so the
/// guard watches the whole [`ACTION_REFLEX`] after it, and an app left in
/// front then still fails the action. The lease is joined before returning;
/// it never continues fighting the user.
const BACKGROUND_SETTLE: Duration = ACTION_REFLEX;
/// Upper bound on waiting for a foreground activation to become observable.
const ACTIVATION_TIMEOUT: Duration = Duration::from_millis(400);
const ACTIVATION_POLL: Duration = Duration::from_millis(10);
/// How long before an app came forward a click, ⌘/⌃ chord or panel counts as
/// the user's switch to it. Measured on a VM: ⌘-Tab activates the chosen app
/// about 3 ms after ⌘ is released.
const USER_SWITCH_WINDOW: Duration = Duration::from_millis(250);
/// How soon after one of the action's own sends another app coming forward is
/// the action's doing, to be sent back: Finder's ⌘O brings `TextEdit` forward
/// 100-220 ms after the key. Another app coming forward later is the user's or
/// unrelated; the target is sent back however late, unless the user picked it.
const ACTION_REFLEX: Duration = Duration::from_millis(500);
/// How often the switch sampler shows the lease the front app, ⌘/⌃, clicks
/// and the keyboard's process: well inside the ~100 ms a ⌘-Tab holds ⌘, on a
/// thread no AX probe blocks.
const SWITCH_SAMPLE: Duration = Duration::from_millis(5);
/// Keeps the target frontmost until it has consumed foreground input.
const FOREGROUND_SETTLE: Duration = Duration::from_millis(40);
/// `SLSSetFrontProcessWithInfo`'s result when a user key press or click was
/// dispatched after the request's timestamp.
const EXPIRED_FRONT_REQUEST: i32 = -13066;

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
type SLSSetFrontProcessWithInfoFn =
	unsafe extern "C" fn(*const ProcessSerialNumber, u32, u32, *const c_void) -> i32;

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
	routes:              &'static Routes,
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
	conditional:   Option<ConditionalFront>,
}

/// The front-process request `WindowServer` refuses when the user pressed a
/// key or clicked after the request's timestamp.
#[derive(Clone, Copy)]
struct ConditionalFront {
	set_front:     SLSSetFrontProcessWithInfoFn,
	/// `kSLSSetFrontProcessRequestTimestampKey`, a process-lived `CFString`.
	timestamp_key: *const CFString,
}

// SAFETY: `timestamp_key` points at an immutable, process-lived CFString
// constant exported by SkyLight.
unsafe impl Send for ConditionalFront {}
// SAFETY: as above; the pointee is never mutated.
unsafe impl Sync for ConditionalFront {}

/// The front process as `WindowServer` reports it. Unlike
/// `NSWorkspace.frontmostApplication`, this does not depend on an `AppKit`
/// run loop in this process observing activation changes.
#[derive(Clone, Copy)]
struct FrontProcess {
	psn: ProcessSerialNumber,
	pid: Option<pid_t>,
}

/// When a guarded action last sent its target input, or its own step
/// returned ([`note_send`]).
static LAST_SEND: Mutex<Option<Instant>> = Mutex::new(None);

/// Records that the action just acted on its target: an app coming forward
/// within [`ACTION_REFLEX`] of it is the action's doing.
fn note_send() {
	*LAST_SEND.lock() = Some(Instant::now());
}

fn psn_pid(psn: &ProcessSerialNumber) -> Option<pid_t> {
	(*PROCESS_PID).and_then(|get_pid| {
		let mut pid: pid_t = 0;
		// SAFETY: Both pointers are valid for the synchronous lookup and the
		// symbol has the exact GetProcessPID ABI.
		(unsafe { get_pid(psn, &mut pid) } == 0 && pid > 0).then_some(pid)
	})
}

/// An application's name and pid for an error message.
fn app_label(pid: Option<pid_t>) -> String {
	let Some(pid) = pid else {
		return "an unidentified process".to_string();
	};
	NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.localizedName())
		.map_or_else(|| format!("process {pid}"), |name| format!("{name} (pid {pid})"))
}

static REQUIRED: LazyLock<Option<RequiredSpi>> = LazyLock::new(resolve_required);
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
			"skylight-spi-missing: required SkyLight background input symbols are unavailable",
		)
	})
}

fn resolve_required() -> Option<RequiredSpi> {
	Some(RequiredSpi {
		routes:              route::routes()?,
		set_window_location: symbol(c"CGEventSetWindowLocation")?,
		main_connection:     symbol(c"CGSMainConnectionID")?,
	})
}

fn resolve_foreground() -> Option<ForegroundSpi> {
	route::load_skylight()?;
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
		conditional: resolve_conditional_front(),
	})
}

fn resolve_conditional_front() -> Option<ConditionalFront> {
	let key: *const *const CFString = symbol(c"kSLSSetFrontProcessRequestTimestampKey")?;
	// SAFETY: the exported symbol is a `CFStringRef` variable that SkyLight
	// initializes before any of its functions can be called.
	let timestamp_key = unsafe { key.read() };
	if timestamp_key.is_null() {
		return None;
	}
	Some(ConditionalFront { set_front: symbol(c"SLSSetFrontProcessWithInfo")?, timestamp_key })
}

fn event_ptr(event: &CGEvent) -> *mut c_void {
	event.as_ptr().cast()
}

/// Stamps raw `SkyLight` integer event fields onto `event`.
pub(super) fn set_fields(event: &CGEvent, fields: &[(u32, i64)]) -> CoreResult<()> {
	let routes = required()?.routes;
	let ptr = event_ptr(event);
	for &(field, value) in fields {
		// SAFETY: The event is alive for the call.
		unsafe { routes.set_field(ptr, field, value) };
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

/// Posts a pointer event through `SkyLight` alone (see [`Routes::routed`]).
pub(super) fn post_routed(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Routed(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.routed(pid, event) };
		mark_sent();
		Ok(())
	})
}

/// [`post_routed`] for an event that only makes a window key, outside its
/// frame: no input of the call has reached the target yet
/// ([`reporting_partial`]).
pub(super) fn post_activation(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Routed(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.routed(pid, event) };
		Ok(())
	})
}

/// Posts a background pointer event through `SkyLight` and, where it is a
/// separate function, the public per-pid queue (see [`Routes::public`]).
pub(super) fn post_dual(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Dual(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.routed(pid, event) };
		mark_sent();
		control::check()?;
		// SAFETY: as above.
		unsafe { routes.public(pid, event) };
		Ok(())
	})
}

/// Posts a keyboard event on the authenticated `SkyLight` route (see
/// [`Routes::keyboard`]).
pub(super) fn post_keyboard(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Keyboard(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.keyboard(pid, event) };
		mark_sent();
		Ok(())
	})
}

/// Posts `event`, tagged as synthetic, through `post` on `route`, telling the
/// input request's release helper what it holds. `post` receives a live
/// event, retained for the synchronous call.
fn post_to_pid(
	route: Route,
	event: &CGEvent,
	post: impl FnOnce(&Routes, *mut c_void) -> CoreResult<()>,
) -> CoreResult<()> {
	control::check()?;
	event.set_integer_value_field(
		core_graphics::event::EventField::EVENT_SOURCE_USER_DATA,
		control::SYNTHETIC_EVENT_TAG,
	);
	let routes = required()?.routes;
	release_guard::post(route, event, || post(routes, event_ptr(event)))?;
	note_send();
	Ok(())
}

thread_local! {
	/// Whether the background call running on this thread has posted input
	/// to its target ([`reporting_partial`]).
	static SENT: Cell<bool> = const { Cell::new(false) };
}

fn mark_sent() {
	SENT.with(|sent| sent.set(true));
}

/// Runs one background call's `action`. A `BackgroundUnavailable` it returns
/// after it posted input becomes `InputFailed`: the tool reruns only
/// `BackgroundUnavailable` in takeover, which would repeat input that landed.
pub(super) fn reporting_partial<T>(action: impl FnOnce() -> CoreResult<T>) -> CoreResult<T> {
	let outer = SENT.with(|sent| sent.replace(false));
	let result = action();
	let sent = SENT.with(|sent| sent.replace(outer || sent.get()));
	partial(sent, result)
}

fn partial<T>(sent: bool, result: CoreResult<T>) -> CoreResult<T> {
	match result {
		Err(error) if sent && error.code == ErrorCode::BackgroundUnavailable => {
			let reason = [", so nothing was sent", "; nothing was sent", " so nothing was sent"]
				.into_iter()
				.find_map(|unsent| error.message.strip_suffix(unsent))
				.unwrap_or(&error.message);
			Err(DesktopError::input_failed(format!(
				"{reason}; earlier input of this call may already have landed, so inspect the target \
				 before retrying"
			)))
		},
		result => result,
	}
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
	Some(FrontProcess { psn, pid: psn_pid(&psn) })
}

/// The front process and the process that has the keyboard, by pid: `None`
/// when `WindowServer` cannot name the front one, and no keyboard holder when
/// it cannot name that one.
pub(super) fn keyboard_holders() -> Option<(pid_t, Option<pid_t>)> {
	let spi = FOREGROUND.as_ref()?;
	let front = front_process(spi.get_front)?.pid?;
	let focus = spi.get_key_focus.and_then(|get_key_focus| {
		let mut psn = ProcessSerialNumber::default();
		let mut status = 0u8;
		// SAFETY: Both out-pointers are writable for the synchronous call, which
		// writes the 8-byte PSN and one status byte.
		(unsafe { get_key_focus(&mut psn, &mut status) } == 0)
			.then(|| psn_pid(&psn))
			.flatten()
	});
	Some((front, focus))
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

/// How many presses of `event_type` the HID system has counted. Hardware
/// mouse presses ([`control::POINTER_PRESS_TYPES`]) are how a user picks a
/// window, while typing in their own window is not. Presses posted to the HID
/// event tap advance these counters, omp's own included; events posted to a
/// pid do not.
fn hid_counter(event_type: u32) -> u32 {
	// SAFETY: HIDSystemState (1) and these public CGEventType values are
	// defined by CGEventSource.h / CGEventTypes.h; this is a read-only query.
	unsafe { CGEventSourceCounterForEventType(1, event_type) }
}

/// Physical activity is a conservative veto, not proof of which app the user
/// chose. A source that updates HID counters for synthetic events can also veto
/// restoration; yielding control is safer than fighting a deliberate switch.
fn activation_activity() -> [u32; 5] {
	// Pointer presses, key press, and modifiers can change activation: the
	// types the takeover monitor watches, pointer presses first.
	control::MONITORED_TYPES.map(hid_counter)
}

/// `WindowServer`'s HID counters for the types the takeover monitor watches,
/// next to how many of each the monitor has seen. Both count omp's own HID
/// posts too.
#[derive(Clone, Copy, Debug)]
struct MonitorProgress {
	counted: [u32; 5],
	seen:    [u32; 5],
}

impl MonitorProgress {
	fn now() -> Self {
		// Counted first: an event counted after this read cannot make the
		// monitor look behind.
		let counted = activation_activity();
		Self { counted, seen: control::monitor_seen() }
	}

	/// Whether the monitor has seen, since `baseline`, at least as many events
	/// of every type as `WindowServer` counted: none of them is still in the
	/// tap's queue. A tap without Input Monitoring sees nothing, so it never
	/// catches up once anything is counted.
	fn caught_up_since(self, baseline: Self) -> bool {
		(0..self.seen.len()).all(|i| {
			self.seen[i].wrapping_sub(baseline.seen[i])
				>= self.counted[i].wrapping_sub(baseline.counted[i])
		})
	}
}

/// How long takeover's hand-back waits for the monitor to catch up before it
/// leaves the front application as it is.
const MONITOR_CATCH_UP: Duration = Duration::from_millis(50);

/// Waits up to [`MONITOR_CATCH_UP`] for the takeover monitor to have seen
/// every event `WindowServer` counted since `baseline`.
fn monitor_settled(baseline: MonitorProgress) -> bool {
	let deadline = Instant::now() + MONITOR_CATCH_UP;
	loop {
		if MonitorProgress::now().caught_up_since(baseline) {
			return true;
		}
		if Instant::now() >= deadline || control::wait(Duration::from_millis(2)).is_err() {
			return false;
		}
	}
}

/// Whether the user picked something since takeover began: a click or a
/// shortcut the monitor classified as a choice. With Input Monitoring the
/// monitor sees every key and press, and its count is complete once it has
/// caught up with all `WindowServer` counted (`settled`), whichever of omp's
/// own presses are still on their way; until then the user may have chosen.
/// Without it the tap sees nothing, which leaves the HID press counters net
/// of omp's own presses (`counters_show_press`); keys are then known only to
/// `WindowServer`, which refuses the hand-back for those after its timestamp.
fn takeover_user_chose(
	monitor_sees_input: bool,
	settled: impl FnOnce() -> bool,
	choices_changed: impl FnOnce() -> bool,
	counters_show_press: impl FnOnce() -> bool,
) -> bool {
	if monitor_sees_input {
		!settled() || choices_changed()
	} else {
		counters_show_press()
	}
}

/// Pointer presses omp posted to the HID event tap ([`note_hid_post`]).
static OWN_POINTER_PRESSES: AtomicU32 = AtomicU32::new(0);

/// Counts `event_type` as omp's own pointer press when it is one; called just
/// before the event is posted to the HID event tap, so a reader never sees
/// the HID counter move ahead of this count.
pub(super) fn note_hid_post(event_type: CGEventType) {
	if control::is_pointer_press(event_type as u32) {
		OWN_POINTER_PRESSES.fetch_add(1, Ordering::AcqRel);
	}
}

/// The HID pointer-press counters next to omp's own presses posted to the HID
/// event tap, so a baseline taken before omp's own clicks still tells the
/// user's presses apart from them.
#[derive(Clone, Copy, Debug)]
struct PointerPresses {
	hid: [u32; 3],
	own: u32,
}

impl PointerPresses {
	fn now() -> Self {
		// Own first: a press of omp's posted between the two reads then looks
		// like the user's, which only stands the hand-back down.
		let own = OWN_POINTER_PRESSES.load(Ordering::Acquire);
		Self { hid: control::POINTER_PRESS_TYPES.map(hid_counter), own }
	}

	/// Whether the HID counters show more presses since `baseline` than omp
	/// posted: one of them, at least, is the user's.
	fn user_pressed_since(self, baseline: Self) -> bool {
		let hid =
			(0..3).fold(0u32, |sum, i| sum.wrapping_add(self.hid[i].wrapping_sub(baseline.hid[i])));
		hid > self.own.wrapping_sub(baseline.own)
	}
}

/// `kCGEventSourceStateHIDSystemState`: input from hardware. Events posted to a
/// pid, as background input is, leave it unchanged.
const HID_SYSTEM_STATE: i32 = 1;
/// Left, right and other mouse button down and up (`CGEventType`).
const MOUSE_BUTTON_EVENTS: [u32; 6] = [1, 2, 3, 4, 25, 26];
/// ⌘ and ⌃ (`kCGEventFlagMaskCommand | Control`). ⌥ is left out: it types
/// characters on German, Polish, French and Nordic layouts, and alone it
/// picks no app (⌥-click counts as a click).
const SWITCH_MODIFIERS: u64 = 0x0010_0000 | 0x0004_0000;
/// How soon after a click [`ClickPlacer`] still places it where the pointer is.
const CLICK_PLACE: Duration = Duration::from_millis(30);

/// The HID counters of `MOUSE_BUTTON_EVENTS`.
fn hid_buttons() -> [u32; 6] {
	MOUSE_BUTTON_EVENTS.map(|event_type| {
		// SAFETY: HIDSystemState and these public CGEventType values are
		// defined by CGEventSource.h / CGEventTypes.h; a read-only query.
		unsafe { CGEventSourceCounterForEventType(HID_SYSTEM_STATE, event_type) }
	})
}

/// How long ago a mouse button last went down or up.
fn since_last_click() -> Option<Duration> {
	MOUSE_BUTTON_EVENTS
		.into_iter()
		// SAFETY: as in `hid_buttons`.
		.map(|event_type| unsafe {
			CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, event_type)
		})
		.filter_map(|seconds| Duration::try_from_secs_f64(seconds).ok())
		.min()
}

/// What one reading sees of how the user could be switching apps. Typing,
/// Shift and Caps Lock pick no app, so none of them appear here.
#[derive(Clone, Copy)]
struct SwitchSignals {
	/// HID counters of `MOUSE_BUTTON_EVENTS`.
	buttons:     [u32; 6],
	/// When a mouse button last went down or up.
	last_click:  Option<Instant>,
	/// A switch modifier is held now.
	chord:       bool,
	/// The process that has the keyboard.
	key_focus:   Option<ProcessSerialNumber>,
	/// When the action last acted on its target ([`note_send`]).
	last_send:   Option<Instant>,
	/// The latest click landed on the user's own app, as [`ClickPlacer`]
	/// placed it: menus and Dock tiles over a window count as theirs, not the
	/// window's.
	in_user_app: bool,
}

impl SwitchSignals {
	const fn new(
		buttons: [u32; 6],
		last_click: Option<Instant>,
		flags: u64,
		key_focus: Option<ProcessSerialNumber>,
	) -> Self {
		Self {
			buttons,
			last_click,
			chord: flags & SWITCH_MODIFIERS != 0,
			key_focus,
			last_send: None,
			in_user_app: false,
		}
	}

	/// These signals after the action acted on its target at `at`.
	const fn sent_at(self, at: Instant) -> Self {
		Self { last_send: Some(at), ..self }
	}

	/// These signals with their latest click placed in the user's own app.
	#[cfg(test)]
	const fn in_user_app(self) -> Self {
		Self { in_user_app: true, ..self }
	}

	/// Reads the signals at `now`, with whether `placer` has placed the latest
	/// click in the user's own app. Nothing here waits on an AX probe.
	fn read(spi: &ForegroundSpi, now: Instant, placer: &ClickPlacer) -> Self {
		let buttons = hid_buttons();
		let last_click = since_last_click().and_then(|since| now.checked_sub(since));
		// SAFETY: HIDSystemState is defined by CGEventSource.h; a read-only
		// query.
		let flags = unsafe { CGEventSourceFlagsState(HID_SYSTEM_STATE) };
		let key_focus = spi.get_key_focus.and_then(|get_key_focus| {
			let mut psn = ProcessSerialNumber::default();
			let mut status = 0u8;
			// SAFETY: Both out-pointers are writable for the synchronous call,
			// which writes the 8-byte PSN and one status byte.
			(unsafe { get_key_focus(&mut psn, &mut status) } == 0).then_some(psn)
		});
		let mut signals = Self::new(buttons, last_click, flags, key_focus);
		signals.in_user_app = placer.in_user_app(buttons);
		let last_send = *LAST_SEND.lock();
		match last_send {
			Some(at) => signals.sent_at(at),
			None => signals,
		}
	}
}

/// The click that left the HID button counters at `buttons`, and whether it
/// landed on the user's own app.
#[derive(Clone, Copy)]
struct ClickPlace {
	buttons:     [u32; 6],
	in_user_app: bool,
}

/// Places the user's clicks by the accessibility hit-test the pointer's
/// position gets, on a thread of its own: the hit-test can block for an AX
/// probe's half-second timeout, and the switch sampler must never wait on it.
/// A reading the placement has not reached yet counts the click as outside
/// the user's app; [`UserSwitchWatch`] takes that back once it arrives.
struct ClickPlacer {
	/// The user's app.
	user:   Option<pid_t>,
	latest: Mutex<Option<ClickPlace>>,
}

impl ClickPlacer {
	const fn new(user: Option<pid_t>) -> Self {
		Self { user, latest: Mutex::new(None) }
	}

	/// Places the latest click unless it is placed already: one within
	/// [`CLICK_PLACE`] where the pointer is now, an older one nowhere. Blocks
	/// for as long as the hit-test does.
	fn place(&self) {
		let Some(user) = self.user else {
			return;
		};
		let buttons = hid_buttons();
		if self
			.latest
			.lock()
			.is_some_and(|place| place.buttons == buttons)
		{
			return;
		}
		let in_user_app =
			since_last_click().is_some_and(|since| since <= CLICK_PLACE) && pointer_over(user);
		*self.latest.lock() = Some(ClickPlace { buttons, in_user_app });
	}

	/// Whether the click that left the button counters at `buttons` has been
	/// placed in the user's own app.
	fn in_user_app(&self, buttons: [u32; 6]) -> bool {
		self
			.latest
			.lock()
			.is_some_and(|place| place.buttons == buttons && place.in_user_app)
	}
}

/// How the user, rather than an app, changed the front app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserSwitch {
	/// A hardware mouse button went down or up outside the user's own app: on
	/// the target's or another app's window, the Dock, the app switcher or a
	/// Spotlight result.
	Click,
	/// ⌘ or ⌃ was held: ⌘-Tab, ⌘-H, Spaces, launcher hotkeys.
	Chord,
	/// Another process's panel had the keyboard, as Spotlight's does while the
	/// user types an app name and presses Return.
	Panel,
}

/// Whether [`UserSwitchWatch`]'s latest button change, counted as a click
/// outside the user's app, may still be placed in their app.
#[derive(Clone, Copy)]
enum ClickPlacement {
	Settled,
	/// [`ClickPlacer`] may place the change in the user's app only some
	/// readings later; `previous` is the click to put back then.
	Pending {
		previous: Option<Instant>,
	},
}

/// Answers "did the user switch to this app on purpose, and how?" for an
/// action between the user's app and the `target`, whose own focus grabs are
/// not the user's doing. It sees every reading of the switch sampler, which
/// no AX probe blocks, so a whole ⌘-Tab or launcher pick between two of the
/// observer's polls is still seen when it happened. Clicks are timed exactly
/// from the HID state.
struct UserSwitchWatch {
	user:      ProcessSerialNumber,
	target:    ProcessSerialNumber,
	buttons:   [u32; 6],
	click:     Option<Instant>,
	placement: ClickPlacement,
	chord:     Option<Instant>,
	/// The other process last seen holding the keyboard, and when.
	panel:     Option<(ProcessSerialNumber, Instant)>,
	/// The one seen before it: Spotlight's panel, once the app picked from it
	/// takes the keyboard a moment before `WindowServer` lists it in front.
	before:    Option<(ProcessSerialNumber, Instant)>,
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
			click: signals
				.last_click
				.filter(|at| !signals.in_user_app && now.saturating_duration_since(*at) <= lookback),
			placement: if signals.in_user_app {
				ClickPlacement::Settled
			} else {
				ClickPlacement::Pending { previous: None }
			},
			chord: None,
			panel: None,
			before: None,
		};
		watch.observe_held(signals, user, now);
		watch
	}

	fn observe(&mut self, signals: SwitchSignals, front: ProcessSerialNumber, now: Instant) {
		if signals.buttons != self.buttons {
			self.buttons = signals.buttons;
			// A click in the user's own app, menus included, picks no app: the
			// target activating itself right after is still sent back.
			self.placement = ClickPlacement::Settled;
			if !signals.in_user_app {
				self.placement = ClickPlacement::Pending { previous: self.click };
				self.click = Some(signals.last_click.unwrap_or(now));
			}
		} else if signals.in_user_app
			&& let ClickPlacement::Pending { previous } = self.placement
		{
			// Placed in the user's app after a reading had counted it.
			self.placement = ClickPlacement::Settled;
			self.click = previous;
		}
		self.observe_held(signals, front, now);
	}

	fn observe_held(&mut self, signals: SwitchSignals, front: ProcessSerialNumber, now: Instant) {
		if signals.chord {
			self.chord = Some(now);
		}
		// The keyboard in a process other than the front app and the action's
		// two apps: a panel such as Spotlight's or a launcher's, which takes the
		// keyboard while the user's app stays in front.
		if let Some(focus) = signals.key_focus
			&& focus != front
			&& focus != self.user
			&& focus != self.target
		{
			if self.panel.is_some_and(|(psn, _)| psn != focus) {
				self.before = self.panel;
			}
			self.panel = Some((focus, now));
		}
	}

	/// The latest switch that picked `front`, which came forward at `came`: a
	/// click from [`USER_SWITCH_WINDOW`] before on, which may be on `front`
	/// itself, or a ⌘/⌃ chord or panel in that window up to `came`. A ⌃ or ⌘
	/// key once `front` is in front is typing there, not a switch to it. A
	/// process that had the keyboard just before coming forward is that app
	/// taking focus a moment before `WindowServer` lists it in front, not a
	/// panel it was picked from.
	fn picked(&self, came: Instant, front: ProcessSerialNumber) -> Option<UserSwitch> {
		let start = came.checked_sub(USER_SWITCH_WINDOW);
		let end = came + SWITCH_SAMPLE;
		let after_start = |at: &Instant| start.is_none_or(|start| *at >= start);
		let before_came = |at: &Instant| after_start(at) && *at <= end;
		let panel = [self.panel, self.before]
			.into_iter()
			.flatten()
			.filter(|(psn, at)| *psn != front && before_came(at))
			.map(|(_, at)| at)
			.max();
		[
			(self.click.filter(after_start), UserSwitch::Click),
			(self.chord.filter(before_came), UserSwitch::Chord),
			(panel, UserSwitch::Panel),
		]
		.into_iter()
		.filter_map(|(at, how)| at.map(|at| (at, how)))
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
	previous:    ProcessSerialNumber,
	target:      ProcessSerialNumber,
	/// The user's key window; `None` when the front app showed no window.
	key:         Option<u32>,
	user:        UserSwitchWatch,
	/// When the action started, its first act on the target.
	started:     Instant,
	/// The app in front, when it came forward, and whether that came within
	/// [`ACTION_REFLEX`] of one of the action's acts on its target.
	front_since: Option<(ProcessSerialNumber, Instant, bool)>,
	disarmed:    bool,
	/// The user came to the target ([`TargetVisit`]).
	visited:     bool,
}

impl BackgroundFocusLease {
	fn new(
		previous: ProcessSerialNumber,
		target: ProcessSerialNumber,
		key: Option<u32>,
		signals: SwitchSignals,
		now: Instant,
	) -> Self {
		let user = UserSwitchWatch::new(previous, target, signals, now, USER_SWITCH_WINDOW);
		Self {
			previous,
			target,
			key,
			user,
			started: now,
			front_since: None,
			disarmed: false,
			visited: false,
		}
	}

	/// When `front` came forward, first seen at `now`, and whether it came
	/// within [`ACTION_REFLEX`] of the action's latest act on its target: what
	/// makes an app other than the target the action's doing.
	fn came_forward(
		&mut self,
		front: ProcessSerialNumber,
		signals: SwitchSignals,
		now: Instant,
	) -> (Instant, bool) {
		match self.front_since {
			Some((psn, came, caused)) if psn == front => (came, caused),
			_ => {
				let sent = signals
					.last_send
					.map_or(self.started, |at| at.max(self.started));
				let caused = now.saturating_duration_since(sent) <= ACTION_REFLEX;
				self.front_since = Some((front, now, caused));
				(now, caused)
			},
		}
	}

	fn observe(
		&mut self,
		front: ProcessSerialNumber,
		key: Option<u32>,
		signals: SwitchSignals,
		now: Instant,
	) -> FocusDecision {
		self.user.observe(signals, front, now);
		let (came, caused) = self.came_forward(front, signals, now);
		// The target coming forward with no switch of the user's just before is
		// the target activating itself, however long after the action's last
		// act, even while the user kept typing. Another app is the action's
		// doing only when it came right after one of the action's acts on its
		// target, as `TextEdit` does after Finder's ⌘O; any other app coming
		// forward is the user's (a slow launch, a Space swipe, an ⌥ or F-key
		// switcher) or unrelated, and the guard stands down. The switch sampler
		// sees every app as it comes forward, however long the observer's AX
		// probes block it.
		let action_brought =
			(front == self.target || caused) && self.user.picked(came, front).is_none();
		if self.disarmed
			|| (front == self.previous && key.is_some_and(|key| Some(key) != self.key))
			|| (front != self.previous && !action_brought)
		{
			// The target in front now is the user's: they acted there, or the
			// lease no longer sends it back.
			self.visited |= front == self.target;
			self.disarmed = true;
			return FocusDecision::Disarm;
		}
		if front == self.previous {
			FocusDecision::Observe
		} else {
			FocusDecision::Restore
		}
	}

	/// Whether an app the action brought forward is in front at the end of the
	/// action without the user having switched to it: it came back after a
	/// hand-back, or macOS refused every hand-back while the user typed.
	fn left_in_front(
		&mut self,
		front: ProcessSerialNumber,
		signals: SwitchSignals,
		now: Instant,
	) -> bool {
		front != self.previous && self.observe(front, None, signals, now) == FocusDecision::Restore
	}
}

/// Whether the pointer is over a surface of `pid`, hit-tested the way a click
/// there lands: a menu, the menu bar or a Dock tile over the target's window
/// is not the target, while the pointer sprite and transparent overlays that
/// let clicks through do not count.
fn pointer_over(pid: pid_t) -> bool {
	let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
		return false;
	};
	let Ok(event) = CGEvent::new(source) else {
		return false;
	};
	let point = event.location();
	ax::point_owner(point.x, point.y).is_some_and(|owner| owner.pid == pid)
}

/// Whether the user has come to the background target since its guard
/// began: the target came forward right after a click, chord or panel of
/// theirs, or was in front after the guard stood down. A hand-back macOS
/// refuses for typing is none. Later steps of the input must stop then, even
/// once the user has left the target again.
#[derive(Clone, Copy)]
pub(super) struct TargetVisit<'a>(&'a AtomicBool);

static NO_VISIT: AtomicBool = AtomicBool::new(false);

impl TargetVisit<'_> {
	/// For input into the application already in front, which no guard
	/// watches.
	pub(super) fn none() -> TargetVisit<'static> {
		TargetVisit(&NO_VISIT)
	}

	pub(super) fn happened(self) -> bool {
		self.0.load(Ordering::Acquire)
	}
}

/// [`with_background_watch`] for an action that has no later steps to stop.
pub(super) fn with_background_guard<T>(
	pid: pid_t,
	action: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
	with_background_watch(pid, |_| action())
}

/// Contains asynchronous self-activation during background input and its
/// bounded post-action settle, without a process-lived observer or run loop.
/// The target, whenever it comes forward without the user picking it, and a
/// third app the action brings forward (Finder's ⌘O opening a document in
/// `TextEdit`) within [`ACTION_REFLEX`] of one of the action's acts on the
/// target, are sent back behind the original front app. A changed prior key
/// window, an app coming forward right after a click, a ⌘/⌃ chord or a
/// Spotlight-style panel, or a third app coming forward later permanently
/// disarms the lease; typing does not, even where macOS
/// refuses a hand-back because of it. `action` gets the [`TargetVisit`] the
/// guard records, which keeps being watched after the lease disarms.
pub(super) fn with_background_watch<T>(
	pid: pid_t,
	action: impl FnOnce(TargetVisit<'_>) -> CoreResult<T>,
) -> CoreResult<T> {
	let action = |visit: TargetVisit<'_>| reporting_partial(|| action(visit));
	control::check()?;
	let spi = FOREGROUND.as_ref().ok_or_else(|| {
		DesktopError::background_unavailable(
			"the focus-restoration SPI is unavailable, so background input could not keep the user's \
			 focus; nothing was sent",
		)
	})?;
	let previous = front_process(spi.get_front).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot establish the current front process before background input; nothing was sent",
		)
	})?;
	if previous.pid == Some(pid) {
		return action(TargetVisit::none());
	}
	let target = process_psn(spi.psn, pid, 0).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot resolve the background target process; nothing was sent",
		)
	})?;
	let previous_key = restoration_key_in_front(
		previous,
		|| previous.pid.and_then(restoration_key),
		|| front_process(spi.get_front),
	)?;
	// A click just before the action is placed before the guard starts; later
	// ones on the placer's own thread.
	let placer = ClickPlacer::new(previous.pid);
	placer.place();
	let now = Instant::now();
	let lease = Mutex::new(BackgroundFocusLease::new(
		previous.psn,
		target,
		previous_key,
		SwitchSignals::read(spi, now, &placer),
		now,
	));
	// Sends the user's keys back to their app while the target holds the
	// keyboard uninvited, until the guard below has put their app back.
	let _reroute = previous.pid.and_then(|user| KeyReroute::arm(user, pid));
	let stopped = AtomicBool::new(false);
	let visited = AtomicBool::new(false);
	let start_failed = |error: std::io::Error| {
		DesktopError::background_unavailable(format!(
			"could not start the background focus guard: {error}; nothing was sent"
		))
	};
	thread::scope(|scope| {
		let visit = &visited;
		let lease = &lease;
		let placer = &placer;
		let desktop =
			WindowServerDesktop { spi, previous, key: previous_key, placer, stopped: &stopped };
		let observer = thread::Builder::new()
			.name("desktop-focus-lease".to_string())
			.spawn_scoped(scope, move || guard_focus(lease, &desktop, visit))
			.map_err(start_failed)?;
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
		// Shows the lease every front app and switch as it happens, apart from
		// the observer, whose AX probes can block it for up to half a second,
		// until the action ends.
		let stopped = &stopped;
		thread::Builder::new()
			.name("desktop-switch-sampler".to_string())
			.spawn_scoped(scope, move || {
				while !stopped.load(Ordering::Acquire) {
					let now = Instant::now();
					if let Some(front) = front_process(spi.get_front) {
						// The placement taken after the front app: one that has
						// arrived meanwhile is used already.
						let signals = SwitchSignals::read(spi, now, placer);
						sample_switches(lease, front.psn, signals, now, visit);
					}
					thread::sleep(SWITCH_SAMPLE);
				}
			})
			.map_err(start_failed)?;
		// Places each click for the readings, apart from the sampler, which
		// its AX hit-test must never hold up.
		thread::Builder::new()
			.name("desktop-click-placer".to_string())
			.spawn_scoped(scope, move || {
				while !stopped.load(Ordering::Acquire) {
					placer.place();
					thread::sleep(SWITCH_SAMPLE);
				}
			})
			.map_err(start_failed)?;
		let result = run_then_settle(
			|| {
				let result = action(TargetVisit(&visited));
				// An AX step's app can come forward as the step returns.
				note_send();
				result
			},
			BACKGROUND_SETTLE,
		);
		drop(stop);
		let cleanup = observer.join().unwrap_or_else(|_| {
			Err(DesktopError::input_failed("background focus guard terminated unexpectedly"))
		});
		after_cleanup(result, cleanup)
	})
}

/// What the background guard's observer reads from `WindowServer` and asks of
/// it.
trait GuardedDesktop {
	/// The front process; `None` when `WindowServer` cannot tell.
	fn front(&self) -> Option<ProcessSerialNumber>;
	/// The user's app's key window, read while that app is in front.
	fn user_key(&self) -> Option<u32>;
	fn now(&self) -> Instant;
	fn signals(&self, now: Instant) -> SwitchSignals;
	/// [`control::uptime_ns`].
	fn event_clock(&self) -> u64;
	/// Puts the user's app back in front unless they pressed a key or clicked
	/// after `since` ([`set_front_unless_user_acted`]).
	fn hand_back(&self, since: u64) -> CoreResult<FrontRequest>;
	/// Makes `key` the user's key window again; false if `WindowServer` rejected
	/// it.
	fn restore_key(&self, key: u32) -> bool;
	/// The name and pid of the app `psn`, for an error message.
	fn describe(&self, psn: ProcessSerialNumber) -> String;
	/// Whether the action and its settle are over.
	fn stopped(&self) -> bool;
	/// Waits one poll, or until the action ends.
	fn wait(&self);
}

struct WindowServerDesktop<'a> {
	spi:      &'a ForegroundSpi,
	/// The user's app.
	previous: FrontProcess,
	/// Its key window; `None` when it showed no window.
	key:      Option<u32>,
	placer:   &'a ClickPlacer,
	stopped:  &'a AtomicBool,
}

impl GuardedDesktop for WindowServerDesktop<'_> {
	fn front(&self) -> Option<ProcessSerialNumber> {
		front_process(self.spi.get_front).map(|front| front.psn)
	}

	fn user_key(&self) -> Option<u32> {
		self.previous.pid.and_then(ax::key_window_id)
	}

	fn now(&self) -> Instant {
		Instant::now()
	}

	fn signals(&self, now: Instant) -> SwitchSignals {
		SwitchSignals::read(self.spi, now, self.placer)
	}

	fn event_clock(&self) -> u64 {
		control::uptime_ns()
	}

	fn hand_back(&self, since: u64) -> CoreResult<FrontRequest> {
		set_front_unless_user_acted(self.spi, self.previous.psn, self.key.unwrap_or(0), since)
	}

	fn restore_key(&self, key: u32) -> bool {
		post_record(self.spi.post_record, self.previous.psn, &focus_record(key))
	}

	fn describe(&self, psn: ProcessSerialNumber) -> String {
		app_label(psn_pid(&psn))
	}

	fn stopped(&self) -> bool {
		self.stopped.load(Ordering::Acquire)
	}

	fn wait(&self) {
		thread::park_timeout(ACTIVATION_POLL);
	}
}

/// One switch-sampler reading of the front app: the lease sees every app as
/// it comes forward and every user switch as it happens, however long the
/// observer's AX probes block it, and `visit` records whether the user came
/// to the target. Only the observer sends apps back.
fn sample_switches(
	lease: &Mutex<BackgroundFocusLease>,
	front: ProcessSerialNumber,
	signals: SwitchSignals,
	now: Instant,
	visit: &AtomicBool,
) {
	let mut lease = lease.lock();
	lease.observe(front, None, signals, now);
	visit.store(lease.visited, Ordering::Release);
}

/// The guard's observer: polls the front process until the action and its
/// settle end, sending an app the action brought forward back behind the
/// user's app while the lease is armed, and publishing in `visit` whether the
/// user came to the target.
fn guard_focus(
	lease: &Mutex<BackgroundFocusLease>,
	desktop: &impl GuardedDesktop,
	visit: &AtomicBool,
) -> CoreResult<()> {
	let (previous, user_key) = {
		let lease = lease.lock();
		(lease.previous, lease.key)
	};
	let observe = |front, key| {
		let now = desktop.now();
		let signals = desktop.signals(now);
		lease.lock().observe(front, key, signals, now)
	};
	loop {
		// Once disarmed, nothing is sent back any more, but the lease keeps
		// watching for the user coming to the target.
		let disarmed = lease.lock().disarmed;
		match desktop.front() {
			None if disarmed => {},
			None => {
				return Err(DesktopError::input_failed(
					"lost the front process during background input",
				));
			},
			Some(front) => {
				let key = if !disarmed && front == previous {
					desktop.user_key()
				} else {
					None
				};
				if observe(front, key) == FocusDecision::Restore {
					// Re-check immediately before changing focus: an AX probe may
					// have raced a newer application or user switch.
					// `WindowServer` then refuses the hand-back if the user
					// pressed a key or clicked after the re-check began. The
					// refusal does not say which, and typing picks no app, so the
					// guard asks again on its next poll; there a click, ⌘/⌃ chord
					// or panel that chose the app disarms the lease instead.
					let handed_back = request_after_check(
						|| desktop.event_clock(),
						|| {
							desktop.front() == Some(front)
								&& observe(front, None) == FocusDecision::Restore
						},
						|since| desktop.hand_back(since),
					)?;
					// A hand-back puts the user's key window back too. Otherwise the
					// re-check observed instead (a disarm it recorded stops the
					// hand-backs from the next poll), or `WindowServer` refused.
					if handed_back == Some(FrontRequest::Done)
						&& let Some(key) = user_key
						&& !desktop.restore_key(key)
					{
						return Err(DesktopError::input_failed(
							"background key-window restoration was rejected",
						));
					}
				}
			},
		}
		visit.store(lease.lock().visited, Ordering::Release);
		if desktop.stopped() {
			let now = desktop.now();
			let signals = desktop.signals(now);
			let left = desktop
				.front()
				.filter(|front| lease.lock().left_in_front(*front, signals, now));
			if let Some(front) = left {
				return Err(DesktopError::input_failed(format!(
					"{} came forward during the background action and is still in front of {}: it came \
					 back after focus restoration or macOS refused to send it back while the user \
					 typed; input may already have landed there; inspect the desktop before sending \
					 more",
					desktop.describe(front),
					desktop.describe(previous),
				)));
			}
			return Ok(());
		}
		desktop.wait();
	}
}

/// Runs a guarded action, then the settle during which the guard still sends
/// back an app the action brought forward, or takeover still holds the front
/// for its input. The settle follows a failed action too: an AX action can
/// report an error and still activate its app, as `AXOpen` on a file in
/// Chrome's Open panel fails with -25205 within 20 ms and Chrome comes to the
/// front some 20 ms later. A cancel during the settle leaves the action's
/// result as it was ([`control::settle`]).
fn run_then_settle<T>(action: impl FnOnce() -> CoreResult<T>, settle: Duration) -> CoreResult<T> {
	let result = action();
	control::settle(settle);
	result
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

/// What a front-process request through [`set_front_unless_user_acted`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrontRequest {
	Done,
	/// `WindowServer` refused it: the user pressed a key or clicked after its
	/// timestamp. Which one, and whether it chose an app, the caller decides.
	UserActed,
}

/// Runs `request` with a timestamp taken from `now` before `still_ours`
/// confirms the hand-back is still wanted; `None` when it no longer is.
/// `WindowServer` refuses the request if the user pressed a key or clicked
/// after that timestamp, so input arriving between the check and the request
/// vetoes it as well.
fn request_after_check(
	now: impl FnOnce() -> u64,
	still_ours: impl FnOnce() -> bool,
	request: impl FnOnce(u64) -> CoreResult<FrontRequest>,
) -> CoreResult<Option<FrontRequest>> {
	let since = now();
	if !still_ours() {
		return Ok(None);
	}
	request(since).map(Some)
}

/// How many timestamps takeover's hand-back tries while the user keeps typing.
const TAKEOVER_HAND_BACK_TRIES: usize = 3;

/// Takeover's hand-back through [`request_after_check`], asked again with a
/// fresh timestamp while `WindowServer` refuses it and `typed_since` shows the
/// takeover monitor saw the user type after the refused timestamp. Such
/// typing reached the target only because takeover held the front.
///
/// The monitor's tap trails `WindowServer`, so a retry also needs `settled`:
/// the monitor has classified every key, modifier and press `WindowServer`
/// counted. It is asked before the monitor's typing is trusted and again
/// after each retry's timestamp, so a choice still in the tap's queue (the
/// arrow of a Control-Up after its Control) cannot be outrun. A refusal the
/// monitor cannot account for (a choice, input it has not caught up with, or
/// no monitor at all) stands, as does any try `still_ours` rejects.
fn hand_back_through_typing(
	mut now: impl FnMut() -> u64,
	mut still_ours: impl FnMut() -> bool,
	mut typed_since: impl FnMut(u64) -> bool,
	mut settled: impl FnMut() -> bool,
	mut request: impl FnMut(u64) -> CoreResult<FrontRequest>,
) -> CoreResult<Option<FrontRequest>> {
	let mut asked = 0;
	let mut handed = request_after_check(&mut now, &mut still_ours, |since| {
		asked = since;
		request(since)
	})?;
	for _ in 1..TAKEOVER_HAND_BACK_TRIES {
		if handed != Some(FrontRequest::UserActed) || !(settled() && typed_since(asked)) {
			break;
		}
		handed = request_after_check(
			&mut now,
			|| settled() && still_ours(),
			|since| {
				asked = since;
				request(since)
			},
		)?;
	}
	Ok(handed)
}

/// Makes `psn` the front process unless the user pressed a key or clicked
/// after `since` ([`control::uptime_ns`]). `WindowServer` decides on its own
/// event clock, so polling delays cannot hide that input. It counts keys and
/// clicks posted to the HID event tap, takeover input included, but not
/// events posted to a process. Where the conditional request is unavailable,
/// the front process changes unconditionally.
fn set_front_unless_user_acted(
	spi: &ForegroundSpi,
	psn: ProcessSerialNumber,
	wid: u32,
	since: u64,
) -> CoreResult<FrontRequest> {
	let Some(conditional) = spi.conditional else {
		return set_front(spi, psn, wid).map(|()| FrontRequest::Done);
	};
	control::check()?;
	let timestamp = CFNumber::new_i64(i64::try_from(since).unwrap_or(i64::MAX));
	// SAFETY: `timestamp_key` is SkyLight's process-lived CFString constant.
	let key = unsafe { &*conditional.timestamp_key };
	let info = CFDictionary::<CFString, CFNumber>::from_slices(&[key], &[&*timestamp]);
	// SAFETY: The PSN was resolved from WindowServer and `info` stays alive
	// for the synchronous call. kCPSNoWindows changes only the front process.
	let status =
		unsafe { (conditional.set_front)(&psn, wid, CPS_NO_WINDOWS, ptr::from_ref(&*info).cast()) };
	front_request(status)
}

fn front_request(status: i32) -> CoreResult<FrontRequest> {
	match status {
		0 => Ok(FrontRequest::Done),
		EXPIRED_FRONT_REQUEST => Ok(FrontRequest::UserActed),
		_ => Err(DesktopError::input_failed(
			"WindowServer rejected front-process restoration/activation",
		)),
	}
}

/// What the user's front application gets back after input elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserKey {
	Window(u32),
	/// It provably shows no window, as Finder after a click on the desktop or
	/// an app that just closed its last window: only the front process is
	/// restored.
	Windowless,
}

impl UserKey {
	const fn window(self) -> Option<u32> {
		match self {
			Self::Window(id) => Some(id),
			Self::Windowless => None,
		}
	}
}

/// The front application `pid`'s [`UserKey`]; `None` when neither its key
/// window nor its windowlessness can be established.
fn restoration_key(pid: pid_t) -> Option<UserKey> {
	restorable_key(
		ax::key_window_id(pid),
		|| ax::window_records(pid).map(|records| records.iter().any(|record| record.id.is_some())),
		|| capture::has_onscreen_window(pid),
	)
}

/// The background guard's restoration window for the user's app `previous`,
/// read by `probe`, refused when `front` shows another app once the probe
/// ends: an AX probe can block for half a second, longer than a switch counts
/// as the user's when the guard starts, and an app the user picked meanwhile
/// is not one for the guard to send back.
fn restoration_key_in_front(
	previous: FrontProcess,
	probe: impl FnOnce() -> Option<UserKey>,
	front: impl FnOnce() -> Option<FrontProcess>,
) -> CoreResult<Option<u32>> {
	let key = probe().ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot establish the user's key window for background focus restoration; nothing was \
			 sent",
		)
	})?;
	let now = front();
	if now.is_none_or(|now| now.psn != previous.psn) {
		return Err(DesktopError::background_unavailable(format!(
			"the front application changed from {} to {} while background input was being prepared; \
			 no input was sent; inspect the desktop and retry",
			app_label(previous.pid),
			now.map_or_else(|| "an unknown process".to_string(), |now| app_label(now.pid)),
		)));
	}
	Ok(key.window())
}

/// [`restoration_key`]'s decision: an app with no key window counts as
/// windowless only when both its accessibility windows (Finder's unmappable
/// desktop entry aside) and `WindowServer`'s on-screen list show none of its
/// windows. An unreadable answer from either refuses.
fn restorable_key(
	key: Option<u32>,
	ax_lists_window: impl FnOnce() -> Option<bool>,
	shows_window: impl FnOnce() -> Option<bool>,
) -> Option<UserKey> {
	if let Some(key) = key {
		return Some(UserKey::Window(key));
	}
	(ax_lists_window() == Some(false) && shows_window() == Some(false))
		.then_some(UserKey::Windowless)
}

/// Makes `wid` the frontmost key window, runs `action`, then restores the
/// previous front process (or, within one process, its previous key window).
///
/// `action` receives whether focus actually moved, so keyboard delivery can
/// give a just-activated surface time to arm its input handling. A target that
/// already is the key window of the front process is not re-activated:
/// re-activating it can clear Chromium's renderer focus. The window is made
/// key without being raised; callers that need it unobstructed raise it.
/// `return_focus` restores even after user input during the action; see
/// [`hands_focus_back`].
pub(super) fn with_foreground<T>(
	pid: pid_t,
	wid: u32,
	return_focus: bool,
	action: impl FnOnce(bool) -> CoreResult<T>,
) -> CoreResult<T> {
	control::check()?;
	let choices = control::user_choices();
	// Read with `choices`, before takeover posts anything: a click of the
	// user's at any later point is then a choice the monitor counts once it has
	// caught up with `WindowServer`, or a press beyond takeover's own.
	let presses = PointerPresses::now();
	let progress = MonitorProgress::now();
	let monitor_sees_input = permission::listen_events();
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
		let result = run_then_settle(|| action(false), FOREGROUND_SETTLE);
		report_focus_return(false, previous.pid);
		return result;
	}
	let previous_pid = previous.pid.ok_or_else(|| {
		DesktopError::input_failed(
			"cannot identify the previous application for takeover restoration; no input was sent",
		)
	})?;
	let previous_key = restoration_key(previous_pid)
		.ok_or_else(|| {
			DesktopError::input_failed(
				"cannot identify the previous key window for takeover restoration; no input was sent",
			)
		})?
		.window();
	let handed_back = Cell::new(false);
	let restore = || {
		// Keys the user types while takeover holds the front land in the target
		// without them choosing it, so only a click or a shortcut of theirs, or
		// a switch elsewhere, leaves the front application alone.
		let user_chose = || {
			takeover_user_chose(
				monitor_sees_input,
				|| monitor_settled(progress),
				|| control::user_choices() != choices,
				|| PointerPresses::now().user_pressed_since(presses),
			)
		};
		let still_ours = || {
			let now = if front_process(spi.get_front).is_some_and(|front| front.psn == target) {
				FocusAfterTakeover::Target
			} else {
				FocusAfterTakeover::Elsewhere
			};
			hands_focus_back(return_focus, user_chose(), now)
		};
		if !still_ours() {
			return Ok(());
		}
		// The action and its settle are over, so takeover's own keys and
		// clicks, which `WindowServer` counts like the user's, came before this
		// timestamp; user input after it refuses the hand-back, and the
		// make-key records below are then never posted.
		let request = hand_back_through_typing(
			control::uptime_ns,
			still_ours,
			|since| control::last_user_typing() >= since,
			|| monitor_settled(progress),
			|since| set_front_unless_user_acted(spi, previous.psn, previous_key.unwrap_or(0), since),
		)?;
		if request != Some(FrontRequest::Done) {
			return Ok(());
		}
		// A previous app that showed no window gets only its front status back.
		let Some(previous_key) = previous_key else {
			handed_back.set(true);
			return Ok(());
		};
		if !rekey_unless_user_chose(
			|| ax::focused_window_id(previous_pid),
			previous_key,
			user_chose,
			|| make_exact_window_key(spi, previous.psn, previous_key),
		)? {
			// The user picked another window of their own app, which is front.
			handed_back.set(true);
			return Ok(());
		}
		await_window_focused(spi, previous_pid, previous_key, previous.psn)?;
		handed_back.set(true);
		Ok(())
	};
	let prepare = set_front(spi, target, wid)
		.and_then(|()| make_exact_window_key(spi, target, wid))
		.and_then(|()| await_window_focused(spi, pid, wid, target));
	let result = if let Err(error) = prepare {
		after_cleanup(Err(error), control::cleanup(restore))
	} else {
		let result = run_then_settle(|| action(true), FOREGROUND_SETTLE);
		after_cleanup(result, control::cleanup(restore))
	};
	report_focus_return(handed_back.get(), previous.pid);
	result
}

/// Records for the host where a takeover left focus, read from `WindowServer`
/// after restoration.
fn report_focus_return(handed_back: bool, previous: Option<pid_t>) {
	let pid = |pid: pid_t| u32::try_from(pid).ok();
	control::report_focus_return(DesktopFocusReturn {
		handed_back,
		previous_pid: previous.and_then(pid),
		front_pid: front_pid().and_then(pid),
	});
}

/// Where focus sits when a takeover ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FocusAfterTakeover {
	/// The target process is front, whichever of its windows is key.
	Target,
	/// Another process is front: the user's own app again, or a third app.
	Elsewhere,
}

/// Whether a takeover hands focus back to the app the user was in.
///
/// An explicit takeover yields to a click or shortcut of the user's during the
/// action (`user_chose`), so a window they picked keeps focus where it went;
/// typing is no choice, since it lands in the target without the user picking
/// it. Otherwise it hands focus back whichever of the target's windows is key:
/// a document the action opened or a sheet it closed is not the user's
/// choice. A returning takeover (the host's rerun of a refused background
/// action) hands focus back even after such a choice: the user was working in
/// their own app when the agent took the screen. Neither overwrites a process
/// the user switched to, which is either their own app already or a
/// deliberately chosen third app.
const fn hands_focus_back(return_focus: bool, user_chose: bool, now: FocusAfterTakeover) -> bool {
	match now {
		FocusAfterTakeover::Elsewhere => false,
		FocusAfterTakeover::Target => return_focus || !user_chose,
	}
}

/// Makes `previous_key` key again after takeover handed the front back,
/// unless it already is or the user chose something meanwhile; `false` when
/// the user did. Returning to an app often reinstates its original key window
/// by itself, and re-making an already-key Chromium window can clear the
/// user's renderer focus, just as reactivating an already-key input target
/// can. `user_chose` is read after the key-window probe, right before the
/// records: a window the user clicked while the probe ran stays theirs.
fn rekey_unless_user_chose(
	key_window: impl FnOnce() -> Option<u32>,
	previous_key: u32,
	user_chose: impl FnOnce() -> bool,
	make_key: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<bool> {
	if key_window() == Some(previous_key) {
		return Ok(true);
	}
	if user_chose() {
		return Ok(false);
	}
	make_key().map(|()| true)
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

/// The front process's pid as `WindowServer` reports it.
pub(in crate::desktop) fn front_pid() -> Option<pid_t> {
	front_process(FOREGROUND.as_ref()?.get_front)?.pid
}

type SLSWindowQueryWindowsFn = unsafe extern "C" fn(i32, &CFArray, u32) -> *mut CFType;
type SLSWindowQueryResultCopyWindowsFn = unsafe extern "C" fn(&CFType) -> *mut CFType;
type SLSWindowIteratorAdvanceFn = unsafe extern "C" fn(&CFType) -> bool;
type SLSWindowIteratorGetIdFn = unsafe extern "C" fn(&CFType) -> u32;

#[derive(Clone, Copy)]
struct WindowQuerySpi {
	connection: CGSMainConnectionIDFn,
	query:      SLSWindowQueryWindowsFn,
	windows:    SLSWindowQueryResultCopyWindowsFn,
	advance:    SLSWindowIteratorAdvanceFn,
	window_id:  SLSWindowIteratorGetIdFn,
	parent_id:  SLSWindowIteratorGetIdFn,
}

static WINDOW_QUERY: LazyLock<Option<WindowQuerySpi>> = LazyLock::new(|| {
	route::load_skylight()?;
	Some(WindowQuerySpi {
		connection: symbol(c"CGSMainConnectionID")?,
		query:      symbol(c"SLSWindowQueryWindows")?,
		windows:    symbol(c"SLSWindowQueryResultCopyWindows")?,
		advance:    symbol(c"SLSWindowIteratorAdvance")?,
		window_id:  symbol(c"SLSWindowIteratorGetWindowID")?,
		parent_id:  symbol(c"SLSWindowIteratorGetParentID")?,
	})
});

/// The window `wid` is a child of in `WindowServer`, such as the window a
/// sheet or an inline editor's overlay is attached to; `None` for a top-level
/// window or when the query is unavailable.
pub(super) fn window_parent(wid: u32) -> Option<u32> {
	let spi = WINDOW_QUERY.as_ref()?;
	let number = CFNumber::new_i64(i64::from(wid));
	let windows = CFArray::from_objects(&[&*number]);
	// SAFETY: The no-argument connection query has its exact signature.
	let connection = unsafe { (spi.connection)() } as i32;
	// SAFETY: `windows` holds one CFNumber window id and outlives the call; the
	// result is a create-rule object or null.
	let query = retained(unsafe { (spi.query)(connection, windows.as_opaque(), 0) })?;
	// SAFETY: `query` is a live window query; the result is create-rule or null.
	let iterator = retained(unsafe { (spi.windows)(&query) })?;
	// SAFETY: `iterator` stays retained across every iterator call.
	while unsafe { (spi.advance)(&iterator) } {
		// SAFETY: As above; the iterator was advanced onto a window.
		if unsafe { (spi.window_id)(&iterator) } == wid {
			// SAFETY: As above.
			return Some(unsafe { (spi.parent_id)(&iterator) }).filter(|&parent| parent != 0);
		}
	}
	None
}

type SLSConnectionGetPIDFn = unsafe extern "C" fn(u32, *mut pid_t) -> i32;

#[derive(Clone, Copy)]
struct WindowOwnerSpi {
	connection: CGSMainConnectionIDFn,
	owner:      SLSGetWindowOwnerFn,
	pid:        SLSConnectionGetPIDFn,
}

static WINDOW_OWNER: LazyLock<Option<WindowOwnerSpi>> = LazyLock::new(|| {
	route::load_skylight()?;
	Some(WindowOwnerSpi {
		connection: symbol(c"CGSMainConnectionID")?,
		owner:      symbol(c"SLSGetWindowOwner")?,
		pid:        symbol(c"SLSConnectionGetPID")?,
	})
});

/// The process that owns window `wid` in `WindowServer`, including the
/// windows a remote-view service keeps off the window list, such as the one
/// `openAndSavePanelService` draws an application's Open panel in.
pub(super) fn window_owner_pid(wid: u32) -> Option<pid_t> {
	let spi = WINDOW_OWNER.as_ref()?;
	let mut owner = 0u32;
	// SAFETY: The connection query takes no arguments, and `owner` is writable
	// for the exact window-owner signature.
	if unsafe { (spi.owner)((spi.connection)(), wid, &mut owner) } != 0 || owner == 0 {
		return None;
	}
	let mut pid: pid_t = 0;
	// SAFETY: `pid` is writable for the exact connection-pid signature.
	(unsafe { (spi.pid)(owner, &mut pid) } == 0 && pid > 0).then_some(pid)
}

/// Takes ownership of a create-rule `CFType` pointer, which may be null.
fn retained(pointer: *mut CFType) -> Option<CFRetained<CFType>> {
	// SAFETY: Every caller passes the +1 result of a copy or create call.
	ptr::NonNull::new(pointer).map(|pointer| unsafe { CFRetained::from_raw(pointer) })
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
/// sent. A front process alone is not proof of the exact key window. The
/// refusal names what held focus instead, so the caller can address it.
fn await_window_focused(
	spi: &ForegroundSpi,
	pid: pid_t,
	wid: u32,
	target: ProcessSerialNumber,
) -> CoreResult<()> {
	let deadline = Instant::now() + ACTIVATION_TIMEOUT;
	loop {
		let focused = ax::focused_window_id(pid);
		let front = front_process(spi.get_front);
		let target_front = front.is_some_and(|front| front.psn == target);
		if focused == Some(wid) && target_front {
			return Ok(());
		}
		if Instant::now() >= deadline {
			let seen = if target_front {
				KeyWindowSeen::Focused(ax::focused_window_label(pid))
			} else {
				let pid = front.and_then(|front| front.pid);
				KeyWindowSeen::Front { pid, name: pid.and_then(process::application_name) }
			};
			return Err(DesktopError::input_failed(unconfirmed_key_window(wid, &seen)));
		}
		control::wait(ACTIVATION_POLL)?;
	}
}

/// What held focus when a window could not be confirmed as the frontmost key
/// window.
#[derive(Debug, PartialEq, Eq)]
enum KeyWindowSeen {
	/// Another process stayed in front.
	Front { pid: Option<pid_t>, name: Option<String> },
	/// The target's process came to the front with this focused window, if any.
	Focused(Option<ax::WindowLabel>),
}

fn unconfirmed_key_window(wid: u32, seen: &KeyWindowSeen) -> String {
	let held = match seen {
		KeyWindowSeen::Front { pid: Some(pid), name: Some(name) } => {
			format!("{name} (pid {pid}) stayed the front application")
		},
		KeyWindowSeen::Front { pid: Some(pid), name: None } => {
			format!("pid {pid} stayed the front application")
		},
		KeyWindowSeen::Front { pid: None, .. } => {
			"the front application could not be identified".to_owned()
		},
		KeyWindowSeen::Focused(None) => "its application reports no focused window".to_owned(),
		KeyWindowSeen::Focused(Some(window)) => {
			let title = window.title.as_ref().map(|title| format!(" \"{title}\""));
			let kind = window.kind.as_ref().map(|kind| format!(" ({kind})"));
			let (title, kind) = (title.unwrap_or_default(), kind.unwrap_or_default());
			match window.id {
				Some(id) => format!("its application's focused window is window {id}{title}{kind}"),
				None => format!("its application's focused window{title}{kind} has no window id"),
			}
		},
	};
	format!("window {wid} could not be confirmed as the exact frontmost key window: {held}")
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

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;
	use crate::desktop::error::ErrorCode;

	const PREVIOUS: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 7 };
	const TARGET: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 8 };
	const THIRD: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 9 };
	const SPOTLIGHT: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 10 };
	// HID flag states as a USB keyboard reports them on macOS.
	const NO_MODIFIERS: u64 = 0x100;
	const SHIFT: u64 = 0x2_0102;
	const CAPS_LOCK: u64 = 0x1_0100;
	const FN: u64 = 0x80_0100;
	const COMMAND: u64 = 0x10_0108;
	const OPTION: u64 = 0x8_0120;
	const CONTROL: u64 = 0x4_0101;

	/// Signals after `clicks` hardware clicks (left down and up), timed between
	/// readings, with no key focus reading.
	fn input(clicks: u32, flags: u64) -> SwitchSignals {
		SwitchSignals::new([clicks, clicks, 0, 0, 0, 0], None, flags, None)
	}

	/// Signals after one click at `at`, timed by the HID state.
	fn clicked_at(at: Instant) -> SwitchSignals {
		SwitchSignals::new([1, 1, 0, 0, 0, 0], Some(at), NO_MODIFIERS, None)
	}

	/// Signals with no clicks or modifiers while `process` has the keyboard.
	fn keyboard_in(process: ProcessSerialNumber) -> SwitchSignals {
		SwitchSignals::new([0; 6], None, NO_MODIFIERS, Some(process))
	}

	fn ms(millis: u64) -> Duration {
		Duration::from_millis(millis)
	}

	/// A lease started at `start`, the user's last hardware click at
	/// `last_click`.
	fn lease_at(start: Instant, last_click: Option<Instant>) -> BackgroundFocusLease {
		let signals = SwitchSignals::new([0; 6], last_click, NO_MODIFIERS, None);
		BackgroundFocusLease::new(PREVIOUS, TARGET, Some(42), signals, start)
	}

	/// Feeds the switch sampler's `(front, signals, at)` readings to a lease the
	/// observer shares; returns whether they published a visit to the target.
	fn sample_all(
		lease: &Mutex<BackgroundFocusLease>,
		readings: &[(ProcessSerialNumber, SwitchSignals, Instant)],
	) -> bool {
		let visit = AtomicBool::new(false);
		for &(front, signals, at) in readings {
			sample_switches(lease, front, signals, at, &visit);
		}
		visit.load(Ordering::Acquire)
	}

	#[test]
	fn user_switch_watch_names_how_the_user_picked_an_app() {
		let t0 = Instant::now();
		let watch = |signals| UserSwitchWatch::new(PREVIOUS, TARGET, signals, t0, ms(250));
		// Typing, Shift, Caps Lock, the Globe key and ⌥ switch nothing.
		for flags in [NO_MODIFIERS, OPTION] {
			assert_eq!(watch(input(0, flags)).picked(t0, TARGET), None, "flags {flags:#x}");
		}
		assert_eq!(watch(input(0, COMMAND)).picked(t0, TARGET), Some(UserSwitch::Chord));
		assert_eq!(watch(keyboard_in(THIRD)).picked(t0, TARGET), Some(UserSwitch::Panel));
		// The keyboard in either app of the action is not another panel.
		assert_eq!(watch(keyboard_in(PREVIOUS)).picked(t0, TARGET), None);
		assert_eq!(watch(keyboard_in(TARGET)).picked(t0, TARGET), None);
		// Nor is the keyboard in the app coming forward: it takes focus a moment
		// before `WindowServer` lists it in front.
		assert_eq!(watch(keyboard_in(THIRD)).picked(t0, THIRD), None);

		// A click is timed by the HID state, not by when a reading saw it, and
		// counts from the switch window before the app came on, even on it.
		let mut clicked = watch(input(0, NO_MODIFIERS));
		clicked.observe(clicked_at(t0 + ms(5)), PREVIOUS, t0 + ms(40));
		assert_eq!(clicked.picked(t0, TARGET), Some(UserSwitch::Click));
		assert_eq!(clicked.picked(t0 + ms(255), TARGET), Some(UserSwitch::Click));
		assert_eq!(clicked.picked(t0 + ms(256), TARGET), None, "the click came too long before");
		// A click older than the lookback when watching starts does not count.
		let started = UserSwitchWatch::new(PREVIOUS, TARGET, clicked_at(t0), t0 + ms(251), ms(250));
		assert_eq!(started.picked(t0 + ms(251), TARGET), None);

		// A ⌘/⌃ counts in the switch window up to the app coming forward, not
		// once it is in front: a ⌃A or ⌘S then is typing there.
		let mut chord = watch(input(0, NO_MODIFIERS));
		chord.observe(input(0, COMMAND), PREVIOUS, t0 + ms(100));
		assert_eq!(chord.picked(t0 + ms(100), TARGET), Some(UserSwitch::Chord));
		assert_eq!(chord.picked(t0 + ms(350), TARGET), Some(UserSwitch::Chord));
		assert_eq!(chord.picked(t0 + ms(351), TARGET), None, "the chord came too long before");
		assert_eq!(chord.picked(t0 + ms(90), TARGET), None, "the chord came after the app");

		// The latest switch names the reason.
		let mut both = watch(input(0, COMMAND));
		both.observe(keyboard_in(THIRD), PREVIOUS, t0 + ms(30));
		assert_eq!(both.picked(t0 + ms(30), TARGET), Some(UserSwitch::Panel));
		assert_eq!(both.picked(t0 + ms(10), TARGET), Some(UserSwitch::Chord));

		// Spotlight's panel, then the app picked from it taking the keyboard just
		// before it is listed in front: the panel sighting is kept.
		let mut spotlight = watch(input(0, NO_MODIFIERS));
		spotlight.observe(keyboard_in(SPOTLIGHT), PREVIOUS, t0 + ms(100));
		spotlight.observe(keyboard_in(THIRD), PREVIOUS, t0 + ms(110));
		assert_eq!(spotlight.picked(t0 + ms(115), THIRD), Some(UserSwitch::Panel));
	}

	#[test]
	fn a_refusal_after_the_call_posted_input_is_never_offered_for_a_rerun() {
		let refused = || -> CoreResult<()> {
			Err(DesktopError::background_unavailable(
				"window 41 did not become its application's key window; nothing was sent",
			))
		};
		// Before anything went out: the tool may rerun it in takeover.
		assert_eq!(reporting_partial(refused).unwrap_err().code, ErrorCode::BackgroundUnavailable);
		// `win.type("hello")` sent "he", then the next key was refused.
		let error = reporting_partial(|| {
			mark_sent();
			refused()
		})
		.unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(!error.message.contains("nothing was sent"), "{}", error.message);
		assert!(error.message.contains("may already have landed"), "{}", error.message);
		// A nested call's input counts for the call around it.
		let nested = reporting_partial(|| {
			reporting_partial(|| {
				mark_sent();
				Ok(())
			})?;
			refused()
		});
		assert_eq!(nested.unwrap_err().code, ErrorCode::InputFailed);
		// The next call starts unsent, and other codes pass through.
		assert_eq!(reporting_partial(refused).unwrap_err().code, ErrorCode::BackgroundUnavailable);
		let cancelled = reporting_partial(|| -> CoreResult<()> {
			mark_sent();
			Err(DesktopError::cancelled("stopped"))
		});
		assert_eq!(cancelled.unwrap_err().code, ErrorCode::Cancelled);
	}

	#[test]
	fn user_focus_changes_permanently_disarm_background_restoration() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// The user clicks a third app forward.
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(TARGET, None, idle, t0), FocusDecision::Restore);
		assert_eq!(
			guard.observe(THIRD, None, input(1, NO_MODIFIERS), t0 + ms(10)),
			FocusDecision::Disarm
		);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20)), FocusDecision::Disarm);

		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(PREVIOUS, Some(43), idle, t0 + ms(10)), FocusDecision::Disarm);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20)), FocusDecision::Disarm);
	}

	#[test]
	fn a_third_app_the_action_brings_forward_is_sent_back_like_the_target() {
		// Finder's ⌘O opens a file in TextEdit, which comes forward 100-220 ms
		// later while the user types on, with no click, chord or panel.
		let t0 = Instant::now();
		for flags in [NO_MODIFIERS, SHIFT, OPTION] {
			let mut guard = lease_at(t0, None);
			assert_eq!(
				guard.observe(PREVIOUS, Some(42), input(0, flags), t0 + ms(10)),
				FocusDecision::Observe
			);
			assert_eq!(
				guard.observe(THIRD, None, input(0, flags), t0 + ms(220)),
				FocusDecision::Restore,
				"flags {flags:#x}"
			);
			assert_eq!(
				guard.observe(PREVIOUS, Some(42), input(0, flags), t0 + ms(240)),
				FocusDecision::Observe
			);
		}
		// The third app holding the keyboard as it comes forward is no panel.
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(THIRD, None, keyboard_in(THIRD), t0 + ms(20)),
			FocusDecision::Restore
		);
		// A third app the user ⌘-Tabs or Spotlights to stays.
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), input(0, COMMAND), t0 + ms(100)),
			FocusDecision::Observe
		);
		assert_eq!(
			guard.observe(THIRD, None, input(0, NO_MODIFIERS), t0 + ms(113)),
			FocusDecision::Disarm
		);
		let mut guard = lease_at(t0, None);
		let spotlight = ProcessSerialNumber { high: 0, low: 10 };
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), keyboard_in(spotlight), t0 + ms(100)),
			FocusDecision::Observe
		);
		assert_eq!(
			guard.observe(THIRD, None, keyboard_in(THIRD), t0 + ms(116)),
			FocusDecision::Disarm
		);
		// The app picked from Spotlight takes the keyboard just before it is
		// listed in front: the panel sighting before it still counts.
		let lease = Mutex::new(lease_at(t0, None));
		sample_all(&lease, &[
			(PREVIOUS, keyboard_in(spotlight), t0 + ms(100)),
			(PREVIOUS, keyboard_in(THIRD), t0 + ms(110)),
			(THIRD, keyboard_in(THIRD), t0 + ms(115)),
		]);
		assert_eq!(
			lease
				.lock()
				.observe(THIRD, None, keyboard_in(THIRD), t0 + ms(120)),
			FocusDecision::Disarm
		);
	}

	#[test]
	fn the_target_is_sent_back_however_late_but_another_app_only_right_after_an_act() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// Finder's ⌘O sent at 800 ms brings TextEdit forward 200 ms later.
		let opened = idle.sent_at(t0 + ms(800));
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(THIRD, None, opened, t0 + ms(1000)), FocusDecision::Restore);
		// The target activating itself 20 ms after the action's last key.
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(TARGET, None, opened, t0 + ms(820)), FocusDecision::Restore);
		// The target activating itself long after the action's last act, as
		// after a click in the user's busy app 700 ms into a held key: it is
		// sent back too, and so is an ⌥ or F-key switch to it, which shows no
		// click or ⌘/⌃.
		for signals in [idle, input(0, OPTION)] {
			let lease = Mutex::new(lease_at(t0, None));
			let late = signals.sent_at(t0 + ms(100));
			let visited =
				sample_all(&lease, &[(PREVIOUS, idle, t0 + ms(300)), (TARGET, late, t0 + ms(1400))]);
			assert!(!visited);
			let mut lease = lease.lock();
			assert_eq!(lease.observe(TARGET, None, late, t0 + ms(1500)), FocusDecision::Restore);
			assert!(lease.left_in_front(TARGET, late, t0 + ms(1600)));
		}
		// A cold launch from the Dock the user clicked well before, a Space swipe
		// or an ⌥ or F-key switcher to another app, or an unrelated alert: an app
		// other than the target coming forward long after the action's last act
		// is the user's or not the action's, and the guard stands down, leaving
		// it in front without failing the action.
		for signals in [clicked_at(t0 + ms(100)), input(0, OPTION)] {
			let lease = Mutex::new(lease_at(t0, None));
			let late = signals.sent_at(t0 + ms(100));
			let visited =
				sample_all(&lease, &[(PREVIOUS, idle, t0 + ms(300)), (THIRD, late, t0 + ms(1400))]);
			assert!(!visited);
			let mut lease = lease.lock();
			assert_eq!(lease.observe(THIRD, None, late, t0 + ms(1500)), FocusDecision::Disarm);
			assert!(!lease.left_in_front(THIRD, late, t0 + ms(1600)));
		}
		// The window is counted from when the app came forward, not from when a
		// later reading saw it: a hand-back refused for typing is asked again.
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(THIRD, None, opened, t0 + ms(1000)), FocusDecision::Restore);
		assert_eq!(guard.observe(THIRD, None, opened, t0 + ms(1600)), FocusDecision::Restore);
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

		// Shift or ⌥ pressed and released while the observer was blocked for
		// 500 ms in an AX probe, then the target activates itself right after
		// the action's click at 490 ms.
		let idle = input(0, NO_MODIFIERS);
		let clicked_by_action = idle.sent_at(t0 + ms(490));
		for flags in [SHIFT, OPTION] {
			let lease = Mutex::new(lease_at(t0, None));
			sample_all(&lease, &[
				(PREVIOUS, input(0, flags), t0 + ms(400)),
				(PREVIOUS, idle, t0 + ms(480)),
				(TARGET, clicked_by_action, t0 + ms(505)),
			]);
			assert_eq!(
				lease.lock().observe(TARGET, None, idle, t0 + ms(510)),
				FocusDecision::Restore,
				"flags {flags:#x}"
			);
		}
		// ⌘C early in the same stall: the chord is 400 ms old when the target
		// comes.
		let lease = Mutex::new(lease_at(t0, None));
		sample_all(&lease, &[
			(PREVIOUS, input(0, COMMAND), t0 + ms(100)),
			(PREVIOUS, idle, t0 + ms(110)),
			(TARGET, clicked_by_action, t0 + ms(505)),
		]);
		assert_eq!(lease.lock().observe(TARGET, None, idle, t0 + ms(510)), FocusDecision::Restore);

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

		// A whole ⌘-Tab while the observer was blocked in an AX probe: it never
		// saw ⌘ held, but the sampler did until its release.
		let lease = Mutex::new(lease_at(t0, None));
		sample_all(&lease, &[
			(PREVIOUS, input(0, COMMAND), t0 + ms(400)),
			(PREVIOUS, input(0, COMMAND), t0 + ms(500)),
			(TARGET, idle, t0 + ms(505)),
		]);
		assert_eq!(lease.lock().observe(TARGET, None, idle, t0 + ms(510)), FocusDecision::Disarm);

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
		let mut guard = BackgroundFocusLease::new(PREVIOUS, TARGET, Some(42), input(0, COMMAND), t0);
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
	fn a_click_placed_in_the_users_app_does_not_let_the_target_keep_the_front() {
		let t0 = Instant::now();
		// The user clicks in their own app, a menu of it included, and the
		// target activates itself right after: it is sent back.
		let mut guard = lease_at(t0, None);
		let own = clicked_at(t0 + ms(5)).in_user_app();
		assert_eq!(guard.observe(PREVIOUS, Some(42), own, t0 + ms(10)), FocusDecision::Observe);
		assert_eq!(guard.observe(TARGET, None, own, t0 + ms(100)), FocusDecision::Restore);
		// The same click just before the action began.
		let mut guard = BackgroundFocusLease::new(
			PREVIOUS,
			TARGET,
			Some(42),
			clicked_at(t0).in_user_app(),
			t0 + ms(50),
		);
		// A later reading still counts that click, now too old to place.
		assert_eq!(guard.observe(TARGET, None, clicked_at(t0), t0 + ms(60)), FocusDecision::Restore);
		// A click outside the user's app, or one no reading placed in time,
		// may be the one that picked the target: it stays in front.
		let mut guard = lease_at(t0, None);
		let click = clicked_at(t0 + ms(5));
		assert_eq!(guard.observe(PREVIOUS, Some(42), click, t0 + ms(10)), FocusDecision::Observe);
		assert_eq!(guard.observe(TARGET, None, click, t0 + ms(100)), FocusDecision::Disarm);
		assert_eq!(guard.observe(TARGET, None, click, t0 + ms(1000)), FocusDecision::Disarm);
	}

	#[test]
	fn a_click_placed_in_the_users_app_after_a_reading_counted_it_still_sends_the_target_back() {
		// The click placer's AX hit-test, off the switch sampler, is still
		// running when a reading first sees the user's click in their own app:
		// that reading counts it as a click elsewhere. The placement arrives with
		// the target activating itself.
		let t0 = Instant::now();
		let click = clicked_at(t0 + ms(5));
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(PREVIOUS, Some(42), click, t0 + ms(10)), FocusDecision::Observe);
		let placed = click.in_user_app();
		assert_eq!(guard.observe(TARGET, None, placed, t0 + ms(60)), FocusDecision::Restore);
		// A click elsewhere before it still counts once it is taken back.
		let mut guard = lease_at(t0, None);
		let own = SwitchSignals::new([2, 2, 0, 0, 0, 0], Some(t0 + ms(40)), NO_MODIFIERS, None);
		assert_eq!(guard.observe(PREVIOUS, Some(42), click, t0 + ms(10)), FocusDecision::Observe);
		assert_eq!(guard.observe(PREVIOUS, Some(42), own, t0 + ms(45)), FocusDecision::Observe);
		let placed = own.in_user_app();
		assert_eq!(guard.observe(TARGET, None, placed, t0 + ms(60)), FocusDecision::Disarm);
	}

	#[test]
	fn the_switch_sampler_sees_what_a_blocked_observer_misses() {
		// The observer polls at 10 ms and next at 700 ms, after an AX probe's
		// 0.5 s timeout; by then any switch during the stall is older than the
		// switch window, so only the sampler's readings can show it.
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		let late = t0 + ms(700);
		let after = |readings: &[(ProcessSerialNumber, SwitchSignals, Instant)]| {
			let lease = Mutex::new(lease_at(t0, None));
			let decision = lease.lock().observe(PREVIOUS, Some(42), idle, t0 + ms(10));
			assert_eq!(decision, FocusDecision::Observe);
			let visited = sample_all(&lease, readings);
			(lease, visited)
		};
		// Readings after one click at 15 ms, with `flags` held.
		let since_click =
			|flags| SwitchSignals::new([1, 1, 0, 0, 0, 0], Some(t0 + ms(15)), flags, None);
		let clicked = since_click(NO_MODIFIERS);

		// The user clicked the target forward.
		let (lease, _) = after(&[(TARGET, clicked, t0 + ms(20))]);
		assert_eq!(lease.lock().observe(TARGET, None, clicked, late), FocusDecision::Disarm);
		// The target coming forward long after the click is the action's doing.
		let (lease, _) = after(&[(PREVIOUS, clicked, t0 + ms(20)), (TARGET, clicked, t0 + ms(400))]);
		assert_eq!(lease.lock().observe(TARGET, None, clicked, late), FocusDecision::Restore);

		// An ⌥-Space launcher took the keyboard, and the user typed the
		// target's name and pressed Return.
		let (lease, _) = after(&[
			(PREVIOUS, keyboard_in(THIRD), t0 + ms(105)),
			(PREVIOUS, keyboard_in(THIRD), t0 + ms(400)),
			(TARGET, keyboard_in(TARGET), t0 + ms(405)),
		]);
		assert_eq!(
			lease
				.lock()
				.observe(TARGET, None, keyboard_in(TARGET), late),
			FocusDecision::Disarm
		);
		// An app the action brings forward can take the keyboard a moment before
		// `WindowServer` lists it in front: that is no panel it was picked from.
		let (lease, _) = after(&[
			(PREVIOUS, keyboard_in(THIRD), t0 + ms(400)),
			(THIRD, keyboard_in(THIRD), t0 + ms(405)),
		]);
		assert_eq!(
			lease.lock().observe(THIRD, None, keyboard_in(THIRD), late),
			FocusDecision::Restore
		);

		// The user clicked the target forward and ⌘-Tabbed back to their app:
		// the observer never saw the target in front, but the visit stands.
		let (lease, visited) = after(&[
			(TARGET, clicked, t0 + ms(20)),
			(TARGET, since_click(COMMAND), t0 + ms(300)),
			(PREVIOUS, clicked, t0 + ms(305)),
		]);
		assert!(visited, "the sampler publishes the visit");
		assert_eq!(lease.lock().observe(PREVIOUS, Some(42), clicked, late), FocusDecision::Disarm);
		assert!(lease.lock().visited);
		// The target's own activation, gone again before the observer's next
		// poll, is no visit.
		let (lease, visited) = after(&[(TARGET, idle, t0 + ms(20)), (PREVIOUS, idle, t0 + ms(40))]);
		assert!(!visited);
		assert_eq!(lease.lock().observe(PREVIOUS, Some(42), idle, late), FocusDecision::Observe);
	}

	#[test]
	fn an_app_the_action_left_in_front_at_the_end_is_an_error_only_without_a_user_switch() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// The target, or a third app the action opened something in, is in
		// front: input may have landed there.
		assert!(lease_at(t0, None).left_in_front(TARGET, idle, t0 + ms(10)));
		assert!(lease_at(t0, None).left_in_front(THIRD, idle, t0 + ms(10)));
		// The user switched to it just as the action ended.
		assert!(!lease_at(t0, None).left_in_front(TARGET, input(0, COMMAND), t0 + ms(10)));
		assert!(!lease_at(t0, None).left_in_front(TARGET, keyboard_in(THIRD), t0 + ms(10)));
		// The user's app is in front.
		assert!(!lease_at(t0, None).left_in_front(PREVIOUS, idle, t0 + ms(10)));
	}

	#[test]
	fn a_window_appearing_in_a_windowless_front_app_is_a_user_focus_change() {
		// Finder in front after a click on the desktop: no key window to restore.
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		let lease = || BackgroundFocusLease::new(PREVIOUS, TARGET, None, idle, t0);
		let mut guard = lease();
		assert_eq!(guard.observe(PREVIOUS, None, idle, t0 + ms(10)), FocusDecision::Observe);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20)), FocusDecision::Restore);

		// The user opened a Finder window meanwhile: hands off.
		let mut guard = lease();
		assert_eq!(guard.observe(PREVIOUS, Some(43), idle, t0 + ms(10)), FocusDecision::Disarm);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20)), FocusDecision::Disarm);
	}

	#[test]
	fn a_visit_to_the_target_is_kept_after_the_user_leaves_it() {
		let t0 = Instant::now();
		let clicked = input(1, NO_MODIFIERS);
		// The user clicks the target, then goes back to their app.
		let mut guard = lease_at(t0, None);
		guard.observe(TARGET, None, clicked, t0 + ms(10));
		guard.observe(PREVIOUS, Some(42), clicked, t0 + ms(20));
		assert!(guard.visited);
		// After the user clicks a third app forward the lease stands down, yet
		// still sees the user come to the target.
		let mut guard = lease_at(t0, None);
		guard.observe(THIRD, None, clicked, t0 + ms(10));
		assert!(!guard.visited);
		guard.observe(TARGET, None, clicked, t0 + ms(500));
		assert!(guard.visited);
		// The target's own activation, sent back even while the user types, is
		// not a visit.
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(TARGET, None, input(0, SHIFT), t0 + ms(10)), FocusDecision::Restore);
		assert!(!guard.visited);
	}

	#[test]
	fn only_a_provably_windowless_front_app_is_restored_without_a_key_window() {
		let unread = || -> Option<bool> { panic!("a known key window needs no window scan") };
		assert_eq!(restorable_key(Some(42), unread, unread), Some(UserKey::Window(42)));
		// TextEdit after closing its last document; Finder after a desktop click
		// lists only its unmappable desktop, which counts as no window.
		assert_eq!(restorable_key(None, || Some(false), || Some(false)), Some(UserKey::Windowless));
		// Windows that AX or WindowServer reports, or an unreadable answer,
		// refuse.
		assert_eq!(restorable_key(None, || Some(true), || Some(false)), None);
		assert_eq!(restorable_key(None, || Some(false), || Some(true)), None);
		assert_eq!(restorable_key(None, || None, || Some(false)), None);
		assert_eq!(restorable_key(None, || Some(false), || None), None);
	}

	#[test]
	fn a_failed_action_still_settles_under_the_guard() {
		// AXOpen in Chrome's Open panel fails with -25205, then Chrome comes
		// forward: the guard must still be watching.
		let started = Instant::now();
		let result: CoreResult<()> = run_then_settle(
			|| Err(DesktopError::ax_failed("AX action 'AXOpen' failed (AXError(-25205))")),
			BACKGROUND_SETTLE,
		);
		assert!(started.elapsed() >= BACKGROUND_SETTLE);
		let error = result.expect_err("the action failed");
		assert_eq!(
			(error.code, error.message.as_str()),
			(ErrorCode::AxFailed, "AX action 'AXOpen' failed (AXError(-25205))")
		);
	}

	#[test]
	fn a_cancel_once_the_input_is_out_keeps_it_through_the_settle() {
		// Escape or an abort arriving once takeover's keys are out.
		let source = control::CancellationSource::default();
		let token = source.token();
		let result = control::with_token_for_test(&token, || {
			run_then_settle(
				|| {
					source.cancel();
					Ok(7)
				},
				FOREGROUND_SETTLE,
			)
		});
		assert_eq!(result.ok(), Some(7));
		assert!(token.check().is_err(), "the cancel still stops what follows");
	}

	/// The guard's view of a desktop where the target has just come forward over
	/// the user's app. `WindowServer` puts the user's app back, except that the
	/// first request is refused for input the user gives after the guard's
	/// check, which leaves `refused_for` as the signals the next poll reads.
	/// Polls are 10 ms apart; an app comes forward of itself at `arrives`; the
	/// action and its settle end at `end`.
	struct FakeDesktop {
		clock:       Cell<Instant>,
		end:         Instant,
		front:       Cell<ProcessSerialNumber>,
		arrives:     Cell<Option<(Instant, ProcessSerialNumber)>>,
		signals:     Cell<SwitchSignals>,
		refused_for: Cell<Option<SwitchSignals>>,
		hand_backs:  Cell<usize>,
		keys:        std::cell::RefCell<Vec<u32>>,
	}

	impl GuardedDesktop for FakeDesktop {
		fn front(&self) -> Option<ProcessSerialNumber> {
			Some(self.front.get())
		}

		fn user_key(&self) -> Option<u32> {
			Some(42)
		}

		fn now(&self) -> Instant {
			self.clock.get()
		}

		fn signals(&self, _now: Instant) -> SwitchSignals {
			self.signals.get()
		}

		fn event_clock(&self) -> u64 {
			7
		}

		fn hand_back(&self, _since: u64) -> CoreResult<FrontRequest> {
			self.hand_backs.set(self.hand_backs.get() + 1);
			if let Some(after) = self.refused_for.take() {
				self.signals.set(after);
				return Ok(FrontRequest::UserActed);
			}
			self.front.set(PREVIOUS);
			Ok(FrontRequest::Done)
		}

		fn restore_key(&self, key: u32) -> bool {
			self.keys.borrow_mut().push(key);
			true
		}

		fn describe(&self, psn: ProcessSerialNumber) -> String {
			format!("app {}", psn.low)
		}

		fn stopped(&self) -> bool {
			self.clock.get() >= self.end
		}

		fn wait(&self) {
			let now = self.clock.get() + ACTIVATION_POLL;
			self.clock.set(now);
			if let Some((at, app)) = self.arrives.get()
				&& now >= at
			{
				self.arrives.set(None);
				self.front.set(app);
			}
		}
	}

	#[test]
	fn the_guard_asks_again_after_a_refusal_for_typing_but_not_for_a_switch() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// The target came forward 20 ms into the action while the user typed;
		// `WindowServer` refuses the guard's first hand-back for `input` the user
		// gave after the guard's check.
		let run = |input: SwitchSignals| {
			let desktop = FakeDesktop {
				clock:       Cell::new(t0 + ms(20)),
				end:         t0 + ms(120),
				front:       Cell::new(TARGET),
				arrives:     Cell::new(None),
				signals:     Cell::new(idle),
				refused_for: Cell::new(Some(input)),
				hand_backs:  Cell::new(0),
				keys:        std::cell::RefCell::default(),
			};
			let lease = Mutex::new(lease_at(t0, None));
			let visit = AtomicBool::new(false);
			let result = guard_focus(&lease, &desktop, &visit);
			assert!(result.is_ok(), "the guard ends without an error");
			let visited = visit.load(Ordering::Acquire);
			(desktop.front.get(), desktop.hand_backs.get(), desktop.keys.into_inner(), visited)
		};
		// A key, a capital letter's Shift, a ⌃A or ⌘S, or a panel opened once
		// the target is in front picks no app: the guard asks again and the
		// user's app and key window are back.
		for typing in [idle, input(0, SHIFT), input(0, OPTION), input(0, CONTROL), keyboard_in(THIRD)]
		{
			let (front, hand_backs, keys, visited) = run(typing);
			assert!(front == PREVIOUS, "the user's app is back in front");
			assert_eq!((hand_backs, keys, visited), (2, vec![42], false));
		}
		// A click after the check, into the target, say, chose it: it stays in
		// front, and later steps of the input see the visit.
		let (front, hand_backs, keys, visited) = run(clicked_at(t0 + ms(21)));
		assert!(front == TARGET, "the target the user chose stays in front");
		assert_eq!((hand_backs, keys, visited), (1, vec![], true));
	}

	#[test]
	fn an_app_never_handed_back_before_the_action_ends_fails_it() {
		// The target, or a third app the action opened something in, came
		// forward on the action's last poll, and `WindowServer` refused the
		// hand-back for the user's typing: it keeps the user's keystrokes.
		let t0 = Instant::now();
		for brought in [TARGET, THIRD] {
			let desktop = FakeDesktop {
				clock:       Cell::new(t0 + ms(20)),
				end:         t0 + ms(20),
				front:       Cell::new(brought),
				arrives:     Cell::new(None),
				signals:     Cell::new(input(0, NO_MODIFIERS)),
				refused_for: Cell::new(Some(input(0, SHIFT))),
				hand_backs:  Cell::new(0),
				keys:        std::cell::RefCell::default(),
			};
			let lease = Mutex::new(lease_at(t0, None));
			let result = guard_focus(&lease, &desktop, &AtomicBool::new(false));
			assert_eq!(desktop.hand_backs.get(), 1, "the guard asked once");
			let error = result.expect_err("the app is still in front");
			assert_eq!(error.code, ErrorCode::InputFailed, "process {}", brought.low);
			let names = format!("app {} came forward during the background action", brought.low);
			assert!(error.message.starts_with(&names), "{}", error.message);
			assert!(error.message.contains("still in front of app 7"), "{}", error.message);
		}
	}

	#[test]
	fn an_app_the_last_act_brings_forward_late_in_its_reflex_is_sent_back_before_the_guard_ends() {
		// The action's last act on its target, Finder's ⌘O say, returns at
		// `sent`, and `TextEdit` comes forward just inside the action reflex
		// after it, while the guard settles.
		let t0 = Instant::now();
		let sent = t0 + ms(100);
		let desktop = FakeDesktop {
			clock:       Cell::new(sent),
			end:         sent + BACKGROUND_SETTLE,
			front:       Cell::new(PREVIOUS),
			arrives:     Cell::new(Some((sent + ACTION_REFLEX - ms(10), THIRD))),
			signals:     Cell::new(input(0, NO_MODIFIERS).sent_at(sent)),
			refused_for: Cell::new(None),
			hand_backs:  Cell::new(0),
			keys:        std::cell::RefCell::default(),
		};
		let lease = Mutex::new(lease_at(t0, None));
		let result = guard_focus(&lease, &desktop, &AtomicBool::new(false));
		assert!(result.is_ok(), "the guard sent it back before it ended");
		assert_eq!((desktop.hand_backs.get(), desktop.keys.into_inner()), (1, vec![42]));
		assert!(desktop.front.get() == PREVIOUS, "the user's app is back in front");
	}

	#[test]
	fn an_app_picked_while_the_restoration_window_is_read_refuses_the_guard() {
		// The user picked another app, or the target itself, while the AX read
		// of their key window stalled for half a second: the guard starts too
		// late to see that switch, so it refuses before any input.
		let process = |psn: ProcessSerialNumber| FrontProcess { psn, pid: None };
		for picked in [THIRD, TARGET] {
			let front = Cell::new(PREVIOUS);
			let result = restoration_key_in_front(
				process(PREVIOUS),
				|| {
					front.set(picked);
					Some(UserKey::Window(42))
				},
				|| Some(process(front.get())),
			);
			assert_eq!(
				result.expect_err("the front app changed").code,
				ErrorCode::BackgroundUnavailable,
				"process {}",
				picked.low
			);
		}
		let key = |user_key| {
			restoration_key_in_front(process(PREVIOUS), || user_key, || Some(process(PREVIOUS)))
		};
		assert_eq!(key(Some(UserKey::Window(42))).ok(), Some(Some(42)));
		assert_eq!(key(Some(UserKey::Windowless)).ok(), Some(None));
		assert_eq!(
			key(None).expect_err("no restoration window").code,
			ErrorCode::BackgroundUnavailable
		);
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
	fn the_hand_back_timestamp_precedes_the_last_check() {
		use std::cell::RefCell;
		let steps = RefCell::new(Vec::new());
		let handed = request_after_check(
			|| {
				steps.borrow_mut().push("clock");
				7
			},
			|| {
				steps.borrow_mut().push("check");
				true
			},
			|since| {
				steps.borrow_mut().push("request");
				assert_eq!(since, 7, "the request carries the timestamp taken before the check");
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::UserActed)));
		assert_eq!(*steps.borrow(), ["clock", "check", "request"]);

		let unwanted =
			request_after_check(|| 7, || false, |_| panic!("no request once the check fails"));
		assert_eq!(unwanted.ok(), Some(None));
	}

	#[test]
	fn a_front_request_the_user_overtook_is_their_choice_not_an_error() {
		assert_eq!(front_request(0).ok(), Some(FrontRequest::Done));
		assert_eq!(front_request(EXPIRED_FRONT_REQUEST).ok(), Some(FrontRequest::UserActed));
		assert_eq!(
			front_request(-1)
				.expect_err("other failures stay errors")
				.code,
			ErrorCode::InputFailed
		);
	}

	#[test]
	fn a_user_click_before_the_hand_back_stands_out_from_takeovers_own_presses() {
		// Baseline taken before takeover's action posts anything.
		let before = PointerPresses { hid: [7, 2, u32::MAX], own: u32::MAX };
		// Takeover's own left click, counted by the HID counters too.
		let own_click = PointerPresses { hid: [8, 2, u32::MAX], own: 0 };
		assert!(!own_click.user_pressed_since(before));
		// A press noted but not yet counted by the HID counters.
		assert!(!PointerPresses { hid: [7, 2, u32::MAX], own: 0 }.user_pressed_since(before));
		// The user's click after the action, before the cleanup runs and before
		// the monitor counts it.
		let user_click = PointerPresses { hid: [8, 2, 0], own: 0 };
		assert!(user_click.user_pressed_since(before));
		assert!(PointerPresses { hid: [7, 3, u32::MAX], own: u32::MAX }.user_pressed_since(before));
	}

	#[test]
	fn only_pointer_presses_posted_to_the_hid_tap_count_as_omps() {
		let before = OWN_POINTER_PRESSES.load(Ordering::Acquire);
		for kind in [
			CGEventType::LeftMouseDown,
			CGEventType::RightMouseDown,
			CGEventType::OtherMouseDown,
			CGEventType::LeftMouseUp,
			CGEventType::MouseMoved,
			CGEventType::KeyDown,
			CGEventType::ScrollWheel,
		] {
			note_hid_post(kind);
		}
		assert_eq!(
			OWN_POINTER_PRESSES
				.load(Ordering::Acquire)
				.wrapping_sub(before),
			3
		);
	}

	#[test]
	fn takeover_hands_back_through_the_users_typing_but_not_their_click() {
		use std::cell::Cell;
		// The monitor saw the user type after each refused timestamp, and
		// nothing else changed: a fresh timestamp is asked for until it goes
		// through.
		let clock = Cell::new(0);
		let stamps = std::cell::RefCell::new(Vec::new());
		let handed = hand_back_through_typing(
			|| {
				clock.set(clock.get() + 1);
				clock.get()
			},
			|| true,
			|since| since <= 1,
			|| true,
			|since| {
				stamps.borrow_mut().push(since);
				Ok(if since < 2 {
					FrontRequest::UserActed
				} else {
					FrontRequest::Done
				})
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::Done)));
		assert_eq!(*stamps.borrow(), [1, 2]);

		// A click after the refusal: the target stays the user's.
		let clicked = Cell::new(false);
		let requests = Cell::new(0);
		let handed = hand_back_through_typing(
			|| 1,
			|| !clicked.get(),
			|_| true,
			|| true,
			|_| {
				requests.set(requests.get() + 1);
				clicked.set(true);
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(None));
		assert_eq!(requests.get(), 1);

		// A refusal the monitor has seen no typing for (a click or shortcut it
		// has not counted yet, or no monitor at all) stands after one request.
		let requests = Cell::new(0);
		let handed = hand_back_through_typing(
			|| 5,
			|| true,
			|_| false,
			|| true,
			|_| {
				requests.set(requests.get() + 1);
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::UserActed)));
		assert_eq!(requests.get(), 1);

		// Typing never pauses: a bounded number of requests, then it gives up.
		let requests = Cell::new(0);
		let handed = hand_back_through_typing(
			|| 1,
			|| true,
			|_| true,
			|| true,
			|_| {
				requests.set(requests.get() + 1);
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::UserActed)));
		assert_eq!(requests.get(), TAKEOVER_HAND_BACK_TRIES);
	}

	#[test]
	fn a_typing_retry_waits_for_the_monitor_to_classify_everything_counted() {
		use std::cell::{Cell, RefCell};
		// The monitor still has the arrow of a Control-Up queued: the typing it
		// saw (the Control) does not earn a retry.
		let requests = Cell::new(0);
		let handed = hand_back_through_typing(
			|| 1,
			|| true,
			|_| true,
			|| false,
			|_| {
				requests.set(requests.get() + 1);
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::UserActed)));
		assert_eq!(requests.get(), 1);

		// The retry's own check waits for the monitor again after taking its
		// timestamp, and only then reads the user's choices.
		let steps = RefCell::new(Vec::new());
		let settles = Cell::new(0);
		let handed = hand_back_through_typing(
			|| {
				steps.borrow_mut().push("clock");
				1
			},
			|| {
				steps.borrow_mut().push("choices");
				true
			},
			|_| true,
			|| {
				steps.borrow_mut().push("settled");
				settles.set(settles.get() + 1);
				settles.get() < 2
			},
			|_| {
				steps.borrow_mut().push("request");
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(None));
		assert_eq!(*steps.borrow(), ["clock", "choices", "request", "settled", "clock", "settled"]);
	}

	#[test]
	fn the_monitor_catches_up_once_it_has_seen_what_window_server_counted() {
		let baseline =
			MonitorProgress { counted: [4, 0, 0, 90, 30], seen: [2, 0, 0, u32::MAX, 7] };
		let caught_up = MonitorProgress { counted: [5, 0, 0, 92, 31], seen: [3, 0, 0, 1, 8] };
		assert!(caught_up.caught_up_since(baseline));
		// The Control-Up arrow is counted but not yet through the tap.
		let behind = MonitorProgress { counted: [5, 0, 0, 93, 31], seen: [3, 0, 0, 1, 8] };
		assert!(!behind.caught_up_since(baseline));
		// Takeover's own press and the user's click: the HID counters show one
		// more press, the user's, counted ahead of omp's still pending press,
		// and the monitor has not classified it yet.
		let click = MonitorProgress { counted: [5, 0, 0, 92, 31], seen: [2, 0, 0, 1, 8] };
		assert!(!click.caught_up_since(baseline));
		// Events only the tap sees (posted to the session) never hold it back.
		let ahead = MonitorProgress { counted: [4, 0, 0, 90, 30], seen: [2, 0, 0, 3, 7] };
		assert!(ahead.caught_up_since(baseline));
	}

	#[test]
	fn a_user_click_counted_ahead_of_takeovers_own_pending_press_still_counts() {
		// With Input Monitoring, the monitor's count decides only once it has
		// seen all `WindowServer` counted: a queued click or Control-Up counts
		// as the user's choice, before any hand-back timestamp is taken.
		assert!(takeover_user_chose(true, || false, || panic!(), || panic!()));
		assert!(takeover_user_chose(true, || true, || true, || panic!()));
		assert!(!takeover_user_chose(true, || true, || false, || panic!()));
		// Without it the tap sees nothing; the HID counters net of omp's own
		// presses are all there is.
		assert!(!takeover_user_chose(false, || panic!(), || panic!(), || false));
		assert!(takeover_user_chose(false, || panic!(), || panic!(), || true));
	}

	#[test]
	fn the_key_window_is_restored_only_if_the_user_chose_nothing_during_the_probe() {
		use std::cell::Cell;
		let (previous_key, clicked) = (7, 9);
		// The user clicks another window of their app while the probe runs.
		let chose = Cell::new(false);
		let made = Cell::new(false);
		let rekeyed = rekey_unless_user_chose(
			|| {
				chose.set(true);
				Some(clicked)
			},
			previous_key,
			|| chose.get(),
			|| {
				made.set(true);
				Ok(())
			},
		);
		assert_eq!(rekeyed.ok(), Some(false));
		assert!(!made.get(), "no make-key records over the user's click");

		let rekeyed = rekey_unless_user_chose(|| Some(clicked), previous_key, || false, || Ok(()));
		assert_eq!(rekeyed.ok(), Some(true));
		let rekeyed = rekey_unless_user_chose(
			|| Some(previous_key),
			previous_key,
			|| panic!("an already-key window needs no check"),
			|| panic!("nor records"),
		);
		assert_eq!(rekeyed.ok(), Some(true));
	}

	#[test]
	fn an_unconfirmed_key_window_names_what_held_focus_instead() {
		let focused = |id, title: Option<&str>, kind: &str| {
			KeyWindowSeen::Focused(Some(ax::WindowLabel {
				id,
				title: title.map(str::to_owned),
				kind: Some(kind.to_owned()),
			}))
		};
		let refusal = |wid, seen| unconfirmed_key_window(wid, &seen);
		let prefix = "could not be confirmed as the exact frontmost key window: ";
		// Calendar's untitled recurring-event alert held key over its window 66.
		assert_eq!(
			refusal(66, focused(Some(93), None, "AXDialog")),
			format!("window 66 {prefix}its application's focused window is window 93 (AXDialog)")
		);
		assert_eq!(
			refusal(186, focused(Some(191), Some("Go to Folder"), "AXSheet")),
			format!(
				"window 186 {prefix}its application's focused window is window 191 \"Go to Folder\" \
				 (AXSheet)"
			)
		);
		assert_eq!(
			refusal(186, focused(None, Some("Open"), "AXSheet")),
			format!(
				"window 186 {prefix}its application's focused window \"Open\" (AXSheet) has no window \
				 id"
			)
		);
		assert_eq!(
			refusal(66, KeyWindowSeen::Focused(None)),
			format!("window 66 {prefix}its application reports no focused window")
		);
		assert_eq!(
			refusal(66, KeyWindowSeen::Front { pid: Some(367), name: Some("iTerm2".to_owned()) }),
			format!("window 66 {prefix}iTerm2 (pid 367) stayed the front application")
		);
		assert_eq!(
			refusal(66, KeyWindowSeen::Front { pid: Some(367), name: None }),
			format!("window 66 {prefix}pid 367 stayed the front application")
		);
		assert_eq!(
			refusal(66, KeyWindowSeen::Front { pid: None, name: None }),
			format!("window 66 {prefix}the front application could not be identified")
		);
	}

	#[test]
	fn a_returning_takeover_hands_focus_back_after_typing_but_not_over_a_third_app() {
		use FocusAfterTakeover::{Elsewhere, Target};
		// The user clicked or pressed a shortcut while the target was front: a
		// returning takeover still hands focus back, an explicit one yields.
		assert!(hands_focus_back(true, true, Target));
		assert!(!hands_focus_back(false, true, Target));
		// With no such choice both hand focus back, whichever of the target's
		// windows the action left key (a document it opened, a sheet it closed).
		assert!(hands_focus_back(true, false, Target));
		assert!(hands_focus_back(false, false, Target));
		// A process the user switched to keeps focus either way.
		for (return_focus, user_chose) in [(true, true), (true, false), (false, false)] {
			assert!(!hands_focus_back(return_focus, user_chose, Elsewhere));
		}
	}
}
