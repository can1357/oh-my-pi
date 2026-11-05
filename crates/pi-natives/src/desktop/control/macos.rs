//! Listen-only event taps: physical Escape for operation and durable task
//! ownership, and the user's own keys and clicks in the apps a session uses.
use std::{
	ffi::c_void,
	ptr,
	sync::{
		Arc,
		atomic::{AtomicU32, Ordering},
	},
	thread::{self, JoinHandle},
	time::Instant,
};

use parking_lot::Mutex;

use super::{CoreResult, DesktopError, EmergencyStop, intervention::UserInputs};
use crate::desktop::macos::front_pid;

pub(crate) const SYNTHETIC_EVENT_TAG: i64 = 0x7069_6465_736b;
const SOURCE_USER_DATA: u32 = 42;
const SOURCE_UNIX_PID: u32 = 41;
/// `kCGEventTargetUnixProcessID`: the process `WindowServer` routes the event
/// to, filled in at the annotated session tap. Verified on a macOS VM for
/// hardware key presses and left clicks, from a USB keyboard and a VNC pointer;
/// right and other clicks were not exercised.
const TARGET_UNIX_PID: u32 = 40;
const KEYBOARD_KEYCODE: u32 = 9;
const LEFT_MOUSE_DOWN: u32 = 1;
const RIGHT_MOUSE_DOWN: u32 = 3;
const KEY_DOWN: u32 = 10;
const OTHER_MOUSE_DOWN: u32 = 25;
const SESSION_TAP: u32 = 1;
const ANNOTATED_SESSION_TAP: u32 = 2;
type Ref = *mut c_void;
type ConstRef = *const c_void;
type Callback = unsafe extern "C" fn(Ref, u32, Ref, Ref) -> Ref;

#[repr(C)]
struct SourceContext {
	version:     isize,
	info:        Ref,
	retain:      Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	release:     Option<unsafe extern "C" fn(ConstRef)>,
	description: Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	equal:       Option<unsafe extern "C" fn(ConstRef, ConstRef) -> bool>,
	hash:        Option<unsafe extern "C" fn(ConstRef) -> usize>,
	schedule:    Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	cancel:      Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	perform:     Option<unsafe extern "C" fn(Ref)>,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
	fn CGEventTapCreate(
		tap: u32,
		place: u32,
		options: u32,
		mask: u64,
		callback: Callback,
		user: Ref,
	) -> Ref;
	fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
	fn CGEventGetFlags(event: Ref) -> u64;
	fn CGEventTapEnable(tap: Ref, enable: bool);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	static kCFRunLoopDefaultMode: Ref;
	fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
	fn CFMachPortInvalidate(port: Ref);
	fn CFRunLoopGetCurrent() -> ConstRef;
	fn CFRunLoopAddSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopRemoveSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopSourceCreate(allocator: Ref, order: isize, context: *mut SourceContext) -> Ref;
	fn CFRunLoopSourceSignal(source: Ref);
	fn CFRunLoopRun();
	fn CFRunLoopStop(run_loop: ConstRef);
	fn CFRunLoopWakeUp(run_loop: ConstRef);
	fn CFRetain(object: ConstRef) -> ConstRef;
	fn CFRelease(object: ConstRef);
}

struct TapContext<C> {
	inner: C,
	tap:   Ref,
}

/// The ports of this process's live taps, so the process can invalidate them
/// before it exits ([`close_taps`]).
struct LiveTaps(Mutex<Live>);

struct Live {
	ports:  Vec<usize>,
	/// The process closed its taps: it is exiting, and a tap that starts after
	/// that is invalidated as it is listed.
	closed: bool,
}

static LIVE_TAPS: LiveTaps = LiveTaps::new();

impl LiveTaps {
	const fn new() -> Self {
		Self(Mutex::new(Live { ports: Vec::new(), closed: false }))
	}

	/// Lists `port`, or invalidates it at once after [`Self::close`].
	///
	/// # Safety
	/// `port` must be a live `CFMachPort`.
	unsafe fn add(&self, port: Ref) {
		let mut live = self.0.lock();
		if live.closed {
			// SAFETY: forwarded caller contract.
			unsafe { CFMachPortInvalidate(port) };
		} else {
			live.ports.push(port as usize);
		}
	}

	/// Removes `port` and invalidates it under the same lock as
	/// [`Self::close`], so neither touches a port the other may release.
	///
	/// # Safety
	/// `port` must be a live `CFMachPort`.
	unsafe fn invalidate(&self, port: Ref) {
		let mut live = self.0.lock();
		live.ports.retain(|&live| live != port as usize);
		// SAFETY: forwarded caller contract.
		unsafe { CFMachPortInvalidate(port) };
	}

	fn close(&self) {
		let mut live = self.0.lock();
		live.closed = true;
		for port in live.ports.drain(..) {
			// SAFETY: a port is listed only while its tap thread holds it, and
			// that thread unlists it under this lock before releasing it.
			unsafe { CFMachPortInvalidate(port as Ref) };
		}
	}
}

/// Invalidates every event tap this process still holds; for a process
/// about to exit, after which no tap here sees input again. A tap whose
/// process exits or is killed with it still valid makes `WindowServer`
/// deliver the key it was routing at that moment again to the app the user
/// types in, often many times; a tap invalidated first never did (measured on
/// macOS 26.5 with helper processes exiting during the user's typing). The
/// host calls this from its exit handler: Bun's `process.exit` runs no native
/// exit hook. Nothing helps a process killed outright.
pub(super) fn close_taps() {
	LIVE_TAPS.close();
}

/// Lists `port`, a tap made elsewhere in the desktop backend, among the taps
/// [`close_taps`] invalidates, or invalidates it at once if they are already
/// closed. Its thread must later unlist it through [`invalidate_live_tap`]
/// before releasing it.
///
/// # Safety
/// `port` must be a live `CFMachPort`.
pub(crate) unsafe fn add_live_tap(port: Ref) {
	// SAFETY: forwarded caller contract.
	unsafe { LIVE_TAPS.add(port) };
}

/// Unlists and invalidates `port`, which may never have been listed.
///
/// # Safety
/// `port` must be a live `CFMachPort`.
pub(crate) unsafe fn invalidate_live_tap(port: Ref) {
	// SAFETY: forwarded caller contract.
	unsafe { LIVE_TAPS.invalidate(port) };
}

const fn physical_escape(kind: u32, key: i64, pid: i64, tag: i64) -> bool {
	kind == KEY_DOWN && key == 53 && pid == 0 && tag != SYNTHETIC_EVENT_TAG
}

const FLAGS_CHANGED: u32 = 12;
const COMMAND_FLAG: u64 = 0x0010_0000;
const CONTROL_FLAG: u64 = 0x0004_0000;
const SECONDARY_FN_FLAG: u64 = 0x0080_0000;

/// Mouse presses (left, right, other `CGEventType`s): the one list both the
/// takeover monitor and the HID press counters classify presses by.
pub(crate) const POINTER_PRESS_TYPES: [u32; 3] = [1, 3, 25];

pub(crate) const fn is_pointer_press(kind: u32) -> bool {
	let mut i = 0;
	while i < POINTER_PRESS_TYPES.len() {
		if POINTER_PRESS_TYPES[i] == kind {
			return true;
		}
		i += 1;
	}
	false
}

/// F1-F20, home of Mission Control, Launchpad, Show Desktop and the
/// Control-F keyboard-focus shortcuts (menu bar, Dock, status menus).
const fn function_key(key: i64) -> bool {
	matches!(
		key,
		122 | 120
			| 99
			| 118
			| 96
			| 97
			| 98
			| 100
			| 101
			| 109
			| 103
			| 111
			| 105
			| 107
			| 113
			| 106
			| 64
			| 79
			| 80
			| 90
	)
}

/// The arrows and the Help, Home, End, Page Up, Page Down and Forward Delete
/// keys, which carry the fn flag whenever they are typed.
const fn navigation_key(key: i64) -> bool {
	matches!(key, 114..=117 | 119 | 121 | 123..=126)
}

/// Shift, Option and Caps Lock: modifiers that only change the characters
/// typed. Command and Control start shortcuts, and a Globe (fn) press or a
/// double Command or Control press can itself open the emoji picker or start
/// Dictation.
const fn typing_modifier(key: i64) -> bool {
	matches!(key, 56 | 60 | 58 | 61 | 57)
}

/// Whether a key press is plain typing: no Command or Control, not a function
/// key, and fn only on the keys that always carry it. Shift and Option type
/// characters. Anything else may be a shortcut that picks an app, window,
/// Space or menu, so only this allowlist counts as typing.
const fn plain_typing(key: i64, flags: u64) -> bool {
	flags & (COMMAND_FLAG | CONTROL_FLAG) == 0
		&& !function_key(key)
		&& (flags & SECONDARY_FN_FLAG == 0 || navigation_key(key))
}

/// The event types the takeover monitor's tap listens to: every pointer
/// press, then key presses and modifier changes.
pub(crate) const MONITORED_TYPES: [u32; 5] = [
	POINTER_PRESS_TYPES[0],
	POINTER_PRESS_TYPES[1],
	POINTER_PRESS_TYPES[2],
	KEY_DOWN,
	FLAGS_CHANGED,
];

const fn monitor_mask() -> u64 {
	let mut mask = 0;
	let mut i = 0;
	while i < MONITORED_TYPES.len() {
		mask |= 1 << MONITORED_TYPES[i];
		i += 1;
	}
	mask
}

/// Events of each [`MONITORED_TYPES`] type the takeover monitor has seen and
/// classified, among those `WindowServer`'s HID counters also count (see
/// [`seen_index`]).
static SEEN: [AtomicU32; 5] = [const { AtomicU32::new(0) }; 5];

/// Where an event the tap sees goes in [`SEEN`]: only hardware input (no
/// source pid) and omp's own tagged events, which omp posts only to the HID
/// event tap, so every seen event is one the HID counters count too. Another
/// process's event may have been posted to the session, which the tap sees
/// but the HID counters skip; counting it would let it stand in for a user
/// click still in the tap's queue. One posted to the HID tap leaves the
/// monitor behind instead, which only stands the hand-back down.
const fn seen_index(kind: u32, pid: i64, tag: i64) -> Option<usize> {
	if pid != 0 && tag != SYNTHETIC_EVENT_TAG {
		return None;
	}
	let mut i = 0;
	while i < MONITORED_TYPES.len() {
		if MONITORED_TYPES[i] == kind {
			return Some(i);
		}
		i += 1;
	}
	None
}

/// [`SEEN`] now. Next to `WindowServer`'s HID counters for the same types, it
/// tells whether the monitor has caught up with every event counted so far,
/// since the tap's callback trails `WindowServer`.
pub(crate) fn monitor_seen() -> [u32; 5] {
	SEEN.each_ref().map(|seen| seen.load(Ordering::Acquire))
}

/// What a physical event means for takeover's hand-back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserInput {
	/// A mouse press, any key press that is not plain typing (Command-Tab,
	/// Control-Up, Control-F2, F3, a Globe shortcut), or a Command, Control or
	/// Globe modifier on its own: it may pick an app, window, Space or menu,
	/// or open system UI, so the hand-back stands down.
	Choice,
	/// Plain typing, which reaches the takeover target only because takeover
	/// holds the front.
	Typing,
}

/// The rule for each type the takeover monitor's tap listens to; `None` for a
/// type without one.
const fn classify(kind: u32, key: i64, flags: u64) -> Option<UserInput> {
	match kind {
		kind if is_pointer_press(kind) => Some(UserInput::Choice),
		KEY_DOWN if plain_typing(key, flags) => Some(UserInput::Typing),
		KEY_DOWN => Some(UserInput::Choice),
		FLAGS_CHANGED if typing_modifier(key) => Some(UserInput::Typing),
		FLAGS_CHANGED => Some(UserInput::Choice),
		_ => None,
	}
}

// A type added to `MONITORED_TYPES` fails the build until it has a rule.
const _: () = {
	let mut i = 0;
	while i < MONITORED_TYPES.len() {
		assert!(classify(MONITORED_TYPES[i], 0, 0).is_some(), "a monitored type has no rule");
		i += 1;
	}
};

const fn user_input(kind: u32, key: i64, flags: u64, pid: i64, tag: i64) -> Option<UserInput> {
	if pid != 0 || tag == SYNTHETIC_EVENT_TAG {
		return None;
	}
	match classify(kind, key, flags) {
		Some(input) => Some(input),
		// Not a type the tap listens to, so it never counts toward `SEEN`.
		None if seen_index(kind, pid, tag).is_none() => None,
		// A type the tap listens to without a rule still counts toward `SEEN`,
		// so the monitor would look caught up with it; read as no input, the
		// hand-back would take the front back over the user's pick.
		None => Some(UserInput::Choice),
	}
}

/// Now in nanoseconds of `CLOCK_UPTIME_RAW`: the clock `WindowServer` compares
/// a front-process request's timestamp with, and the one the takeover monitor
/// stamps the user's typing with, so the two compare directly.
pub(crate) fn uptime_ns() -> u64 {
	let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `time` is writable for the call, which retains no pointer.
	unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &raw mut time) };
	u64::try_from(time.tv_sec).unwrap_or(0) * 1_000_000_000
		+ u64::try_from(time.tv_nsec).unwrap_or(0)
}

unsafe extern "C" fn observe(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: the monitor thread retains this stack context through
	// invalidation.
	let context = unsafe { &*(user.cast::<TapContext<EmergencyStop>>()) };
	if kind == u32::MAX || kind == u32::MAX - 1 {
		context.inner.cancel();
		// SAFETY: the event tap remains alive until this callback returns.
		unsafe {
			CGEventTapEnable(context.tap, true);
		}
		return event;
	}
	if !event.is_null() {
		// SAFETY: documented read-only CGEvent fields.
		let (key, pid, tag, flags) = unsafe {
			(
				CGEventGetIntegerValueField(event, KEYBOARD_KEYCODE),
				CGEventGetIntegerValueField(event, SOURCE_UNIX_PID),
				CGEventGetIntegerValueField(event, SOURCE_USER_DATA),
				CGEventGetFlags(event),
			)
		};
		match user_input(kind, key, flags, pid, tag) {
			Some(UserInput::Choice) => {
				super::USER_CHOICES.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
			},
			Some(UserInput::Typing) => {
				super::LAST_USER_TYPING.store(uptime_ns(), std::sync::atomic::Ordering::Release);
			},
			None => {},
		}
		// After the classification above, so a reader that sees this count
		// also sees what the event meant.
		if let Some(index) = seen_index(kind, pid, tag) {
			SEEN[index].fetch_add(1, Ordering::AcqRel);
		}
		if physical_escape(kind, key, pid, tag) {
			context.inner.escape();
		}
	}
	event
}

/// Whether an event came from someone other than this process: the user's
/// hardware, or a tool such as dictation that posts for them under its own
/// process id.
const fn foreign(tag: i64, source_pid: i64, own_pid: i64) -> bool {
	tag != SYNTHETIC_EVENT_TAG && source_pid != own_pid
}

/// The event types the user-input monitor's tap listens to: key presses and
/// every pointer press.
const USER_INPUT_MASK: u64 =
	(1 << KEY_DOWN) | (1 << LEFT_MOUSE_DOWN) | (1 << RIGHT_MOUSE_DOWN) | (1 << OTHER_MOUSE_DOWN);

/// Where a foreign event the annotated tap names no target for lands.
enum Untargeted {
	/// The front process, which takes the keyboard.
	Front,
	/// Nowhere: a click without a target names no app.
	Dropped,
}

/// The rule for each type the user-input tap listens to; `None` for a type
/// without one.
const fn untargeted(kind: u32) -> Option<Untargeted> {
	match kind {
		KEY_DOWN => Some(Untargeted::Front),
		LEFT_MOUSE_DOWN | RIGHT_MOUSE_DOWN | OTHER_MOUSE_DOWN => Some(Untargeted::Dropped),
		_ => None,
	}
}

// A type added to `USER_INPUT_MASK` fails the build until it has a rule.
const _: () = {
	let mut kind = 0;
	while kind < 64 {
		assert!(
			USER_INPUT_MASK & (1 << kind) == 0 || untargeted(kind).is_some(),
			"a user-input type has no rule"
		);
		kind += 1;
	}
};

/// The process a foreign key press or click lands in: the target the
/// annotated tap names, else what [`untargeted`] says for its type, and the
/// front process for a type without a rule.
fn input_target(
	kind: u32,
	target: i64,
	front: impl FnOnce() -> Option<libc::pid_t>,
) -> Option<libc::pid_t> {
	if let Ok(pid) = libc::pid_t::try_from(target)
		&& pid > 0
	{
		return Some(pid);
	}
	match untargeted(kind) {
		Some(Untargeted::Front) => front(),
		Some(Untargeted::Dropped) => None,
		// Not a type the tap listens to, since each of those has a rule: counted
		// against the front process, it at worst has the agent read that app
		// again, where dropping it would let the agent act on what the user changed.
		None => front(),
	}
}

unsafe extern "C" fn observe_user(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: the monitor thread retains this stack context through
	// invalidation.
	let context = unsafe { &*(user.cast::<TapContext<Arc<UserInputs>>>()) };
	if kind == u32::MAX || kind == u32::MAX - 1 {
		// SAFETY: the event tap remains alive until this callback returns.
		unsafe {
			CGEventTapEnable(context.tap, true);
		}
		return event;
	}
	if !event.is_null() {
		// SAFETY: documented read-only CGEvent fields.
		let (tag, source, target) = unsafe {
			(
				CGEventGetIntegerValueField(event, SOURCE_USER_DATA),
				CGEventGetIntegerValueField(event, SOURCE_UNIX_PID),
				CGEventGetIntegerValueField(event, TARGET_UNIX_PID),
			)
		};
		if foreign(tag, source, i64::from(std::process::id()))
			&& let Some(pid) = input_target(kind, target, front_pid)
		{
			context.inner.record(pid, Instant::now());
		}
	}
	event
}

unsafe extern "C" fn stop_loop(_: Ref) {
	// SAFETY: this callback runs on the monitor's own run loop.
	unsafe {
		CFRunLoopStop(CFRunLoopGetCurrent());
	}
}

/// A listen-only event tap running on its own thread's run loop until drop.
struct TapThread {
	thread:      Option<JoinHandle<()>>,
	run_loop:    usize,
	stop_source: usize,
}

impl TapThread {
	fn start<C: Send + 'static>(
		thread_name: &'static str,
		label: &'static str,
		location: u32,
		mask: u64,
		inner: C,
		callback: Callback,
	) -> CoreResult<Self> {
		let (ready, receive) = flume::bounded(1);
		let worker = thread::Builder::new()
			.name(thread_name.into())
			.spawn(move || {
				let mut context = TapContext { inner, tap: ptr::null_mut() };
				// SAFETY: listen-only tap; context stays live until invalidation.
				let tap = unsafe {
					CGEventTapCreate(location, 0, 1, mask, callback, ptr::from_mut(&mut context).cast())
				};
				if tap.is_null() {
					let _ = ready.send(None);
					return;
				}
				context.tap = tap;
				let mut stop_context = SourceContext {
					version:     0,
					info:        ptr::null_mut(),
					retain:      None,
					release:     None,
					description: None,
					equal:       None,
					hash:        None,
					schedule:    None,
					cancel:      None,
					perform:     Some(stop_loop),
				};
				// SAFETY: valid create-rule tap and version-zero run-loop context.
				let (source, stop_source) = unsafe {
					(
						CFMachPortCreateRunLoopSource(ptr::null_mut(), tap, 0),
						CFRunLoopSourceCreate(ptr::null_mut(), -1, &raw mut stop_context),
					)
				};
				if source.is_null() || stop_source.is_null() {
					// SAFETY: release exactly the objects successfully created
					// above.
					unsafe {
						if !source.is_null() {
							CFRelease(source);
						}
						if !stop_source.is_null() {
							CFRelease(stop_source);
						}
						CFMachPortInvalidate(tap);
						CFRelease(tap);
					}
					let _ = ready.send(None);
					return;
				}
				// SAFETY: all sources remain retained throughout the loop; the
				// owner gets separate retains for its signal/wakeup
				// request.
				unsafe {
					let run_loop = CFRunLoopGetCurrent();
					CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopAddSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					CGEventTapEnable(tap, true);
					LIVE_TAPS.add(tap);
					let _ =
						ready.send(Some((CFRetain(run_loop) as usize, CFRetain(stop_source) as usize)));
					CFRunLoopRun();
					CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopRemoveSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					LIVE_TAPS.invalidate(tap);
					CFRelease(source);
					CFRelease(stop_source);
					CFRelease(tap);
				}
			})
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot start {label} monitor: {error}"))
			})?;
		let Some((run_loop, stop_source)) = receive.recv().ok().flatten() else {
			let _ = worker.join();
			return Err(DesktopError::permission_denied(format!(
				"cannot start the {label} monitor: macOS refused its event tap, so no input was sent; \
				 check Accessibility for the app that launched omp"
			)));
		};
		Ok(Self { thread: Some(worker), run_loop, stop_source })
	}
}

impl Drop for TapThread {
	fn drop(&mut self) {
		// SAFETY: these retains belong to this owner. A signaled source remains
		// pending even when stop races the first CFRunLoopRun call.
		unsafe {
			CFRunLoopSourceSignal(self.stop_source as Ref);
			CFRunLoopWakeUp(self.run_loop as ConstRef);
			CFRelease(self.stop_source as ConstRef);
			CFRelease(self.run_loop as ConstRef);
		}
		if let Some(worker) = self.thread.take()
			&& worker.thread().id() != thread::current().id()
		{
			let _ = worker.join();
		}
	}
}

pub(super) struct EscapeMonitor {
	_tap: TapThread,
}

impl EscapeMonitor {
	pub(super) fn start(emergency: EmergencyStop) -> CoreResult<Self> {
		let tap = TapThread::start(
			"desktop-escape",
			"emergency Escape",
			SESSION_TAP,
			monitor_mask(),
			emergency,
			observe,
		)?;
		Ok(Self { _tap: tap })
	}
}

/// Records every foreign key press and click by the process it lands in, at
/// the annotated session tap where `WindowServer` has named that process. It
/// listens during background input and between calls, not only during
/// takeover like the Escape monitor.
pub(super) struct UserInputMonitor {
	_tap: TapThread,
}

impl UserInputMonitor {
	pub(super) fn start(inputs: Arc<UserInputs>) -> CoreResult<Self> {
		let tap = TapThread::start(
			"desktop-user-input",
			"user input",
			ANNOTATED_SESSION_TAP,
			USER_INPUT_MASK,
			inputs,
			observe_user,
		)?;
		Ok(Self { _tap: tap })
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `CFMachPortContext`, version 0.
	#[repr(C)]
	struct PortContext {
		version:     isize,
		info:        Ref,
		retain:      Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
		release:     Option<unsafe extern "C" fn(ConstRef)>,
		description: Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	}

	#[link(name = "CoreFoundation", kind = "framework")]
	unsafe extern "C" {
		fn CFMachPortCreate(
			allocator: Ref,
			callback: unsafe extern "C" fn(Ref, Ref, isize, Ref),
			context: *mut PortContext,
			should_free_info: *mut bool,
		) -> Ref;
		fn CFMachPortIsValid(port: Ref) -> bool;
	}

	unsafe extern "C" fn ignore(_: Ref, _: Ref, _: isize, _: Ref) {}

	/// A plain mach port standing in for a tap's, which needs event-listening
	/// access to create.
	fn port() -> Ref {
		let mut context = PortContext {
			version:     0,
			info:        ptr::null_mut(),
			retain:      None,
			release:     None,
			description: None,
		};
		// SAFETY: a version-zero context copied at creation and a no-op
		// callback.
		let port =
			unsafe { CFMachPortCreate(ptr::null_mut(), ignore, &raw mut context, ptr::null_mut()) };
		assert!(!port.is_null());
		port
	}

	#[test]
	fn closing_invalidates_every_live_tap_and_none_its_thread_already_ended() {
		let taps = LiveTaps::new();
		let (live, ended) = (port(), port());
		// SAFETY: live ports created above.
		unsafe {
			taps.add(live);
			taps.add(ended);
		}
		// SAFETY: `ended` is a live port, released below.
		unsafe { taps.invalidate(ended) };
		let other = port();
		taps.close();
		// SAFETY: live ports created above.
		unsafe {
			assert!(!CFMachPortIsValid(live), "a live tap outlived close");
			assert!(!CFMachPortIsValid(ended));
			assert!(CFMachPortIsValid(other), "close touched a port it was never given");
		}
		assert!(taps.0.lock().ports.is_empty());
		// A tap thread ending after close finds its port already gone.
		// SAFETY: still a live (invalid) CFMachPort.
		unsafe { taps.invalidate(live) };
		// SAFETY: create-rule objects from `port`.
		unsafe {
			for port in [live, ended, other] {
				CFRelease(port);
			}
		}
	}

	#[test]
	fn a_tap_that_starts_after_closing_is_invalidated_as_it_is_listed() {
		let taps = LiveTaps::new();
		taps.close();
		let late = port();
		// SAFETY: a live port created above, released below.
		unsafe {
			taps.add(late);
			assert!(!CFMachPortIsValid(late), "a tap started after close stayed live");
		}
		assert!(taps.0.lock().ports.is_empty());
		// SAFETY: still a live (invalid) CFMachPort, then its create-rule
		// release.
		unsafe {
			taps.invalidate(late);
			CFRelease(late);
		}
	}

	#[test]
	fn only_physical_escape_cancels() {
		assert!(physical_escape(KEY_DOWN, 53, 0, 0));
		assert!(!physical_escape(KEY_DOWN, 53, 0, SYNTHETIC_EVENT_TAG));
		assert!(!physical_escape(KEY_DOWN, 53, 42, 0));
		assert!(!physical_escape(KEY_DOWN, 0, 0, 0));
		assert!(!physical_escape(11, 53, 0, 0));
	}

	#[test]
	fn the_users_and_their_tools_input_is_foreign_and_this_processs_is_not() {
		let own = 900;
		// Hardware input carries no source process.
		assert!(foreign(0, 0, own));
		// A dictation tool posts under its own process id.
		assert!(foreign(0, 4242, own));
		// Anything this process posts carries its tag, whoever relays it.
		assert!(!foreign(SYNTHETIC_EVENT_TAG, 0, own));
		assert!(!foreign(SYNTHETIC_EVENT_TAG, 4242, own));
		// An untagged event this process posted is still its own.
		assert!(!foreign(0, own, own));
	}

	#[test]
	fn foreign_input_lands_in_its_annotated_target_or_a_key_in_the_front_process() {
		let unread = || -> Option<libc::pid_t> { panic!("the front process is not read") };
		assert_eq!(input_target(KEY_DOWN, 77, unread), Some(77));
		assert_eq!(input_target(LEFT_MOUSE_DOWN, 77, unread), Some(77));
		assert_eq!(input_target(KEY_DOWN, 0, || Some(12)), Some(12));
		assert_eq!(input_target(KEY_DOWN, 0, || None), None);
		assert_eq!(input_target(LEFT_MOUSE_DOWN, 0, unread), None);
		assert_eq!(input_target(RIGHT_MOUSE_DOWN, -1, unread), None);
		assert_eq!(input_target(OTHER_MOUSE_DOWN, 0, unread), None);
		// A type without a rule counts against the front process rather than
		// being dropped.
		assert_eq!(input_target(11, 0, || Some(12)), Some(12));
	}

	#[test]
	fn clicks_and_command_shortcuts_choose_while_plain_typing_does_not() {
		for kind in [LEFT_MOUSE_DOWN, RIGHT_MOUSE_DOWN, OTHER_MOUSE_DOWN] {
			assert_eq!(user_input(kind, 0, 0, 0, 0), Some(UserInput::Choice));
			assert_eq!(user_input(kind, 0, 0, 0, SYNTHETIC_EVENT_TAG), None);
			assert_eq!(user_input(kind, 0, 0, 42, 0), None);
		}
		// Command-Tab and Command-Space pick an app; Shift-typing does not.
		assert_eq!(user_input(KEY_DOWN, 48, COMMAND_FLAG, 0, 0), Some(UserInput::Choice));
		assert_eq!(user_input(KEY_DOWN, 49, COMMAND_FLAG | 0x2_0000, 0, 0), Some(UserInput::Choice));
		assert_eq!(user_input(KEY_DOWN, 0, 0x2_0000, 0, 0), Some(UserInput::Typing));
		assert_eq!(user_input(KEY_DOWN, 0, 0, 0, 0), Some(UserInput::Typing));
		assert_eq!(user_input(FLAGS_CHANGED, 56, 0x2_0000, 0, 0), Some(UserInput::Typing));
		// omp's own keys and those another process posts are not the user's.
		assert_eq!(user_input(KEY_DOWN, 48, COMMAND_FLAG, 0, SYNTHETIC_EVENT_TAG), None);
		assert_eq!(user_input(KEY_DOWN, 0, 0, 42, 0), None);
		// Releases mean nothing on their own.
		for kind in [11, 2, 4, 26] {
			assert_eq!(user_input(kind, 48, COMMAND_FLAG, 0, 0), None);
		}
	}

	#[test]
	fn only_plain_typing_types_and_every_other_shortcut_chooses() {
		// Arrow keydowns carry the fn and numeric-pad flags.
		let fn_pad = SECONDARY_FN_FLAG | 0x0020_0000;
		for arrow in 123..=126 {
			// Control-Up and its kin: Mission Control and Space switches.
			let control = user_input(KEY_DOWN, arrow, CONTROL_FLAG | fn_pad, 0, 0);
			assert_eq!(control, Some(UserInput::Choice));
			assert_eq!(user_input(KEY_DOWN, arrow, fn_pad, 0, 0), Some(UserInput::Typing));
			let word = user_input(KEY_DOWN, arrow, fn_pad | 0x8_0000, 0, 0);
			assert_eq!(word, Some(UserInput::Typing), "Option-arrow moves by word");
		}
		for key in [115, 119, 116, 121, 117] {
			assert_eq!(user_input(KEY_DOWN, key, SECONDARY_FN_FLAG, 0, 0), Some(UserInput::Typing));
		}
		// Control-1 through Control-9 switch Desktops; Control-F2 and Control-F8
		// focus the menu bar and status menus; F3 and F4 open Mission Control and
		// Launchpad; Globe-F toggles full screen; any other Control chord may be
		// an app's or the system's shortcut too.
		for (key, flags) in [
			(18, CONTROL_FLAG),
			(25, CONTROL_FLAG),
			(120, CONTROL_FLAG | SECONDARY_FN_FLAG),
			(100, CONTROL_FLAG | SECONDARY_FN_FLAG),
			(99, SECONDARY_FN_FLAG),
			(118, 0),
			(3, SECONDARY_FN_FLAG),
			(0, CONTROL_FLAG),
		] {
			assert_eq!(user_input(KEY_DOWN, key, flags, 0, 0), Some(UserInput::Choice), "{key}");
		}
		// Letters, Shift and Option characters, Return and Delete are typing.
		for (key, flags) in [(0, 0), (0, 0x2_0000), (0, 0x8_0000), (36, 0), (51, 0)] {
			assert_eq!(user_input(KEY_DOWN, key, flags, 0, 0), Some(UserInput::Typing), "{key}");
		}
		assert_eq!(user_input(KEY_DOWN, 126, CONTROL_FLAG, 0, SYNTHETIC_EVENT_TAG), None);
	}

	#[test]
	fn only_shift_option_and_caps_lock_are_typing_modifiers() {
		// Shift, Option and Caps Lock change the characters typed.
		for key in [56, 60, 58, 61, 57] {
			assert_eq!(user_input(FLAGS_CHANGED, key, 0, 0, 0), Some(UserInput::Typing), "{key}");
		}
		// Globe on its own opens the emoji picker or starts Dictation, a double
		// Command or Control press can start Dictation, and both start shortcuts.
		for key in [63, 55, 54, 59, 62] {
			assert_eq!(user_input(FLAGS_CHANGED, key, 0, 0, 0), Some(UserInput::Choice), "{key}");
		}
		assert_eq!(user_input(FLAGS_CHANGED, 63, SECONDARY_FN_FLAG, 0, SYNTHETIC_EVENT_TAG), None);
	}

	#[test]
	fn the_monitor_counts_only_events_the_hid_counters_count() {
		for kind in [LEFT_MOUSE_DOWN, RIGHT_MOUSE_DOWN, OTHER_MOUSE_DOWN, 10, 12] {
			// Hardware input and omp's own HID-tap posts.
			let index = seen_index(kind, 0, 0);
			assert!(index.is_some(), "{kind}");
			assert_eq!(seen_index(kind, 4242, SYNTHETIC_EVENT_TAG), index);
			// Another process's event, perhaps posted to the session, which the
			// HID counters skip: it must not cover a click still queued.
			assert_eq!(seen_index(kind, 4242, 0), None);
		}
		assert_eq!(seen_index(11, 0, 0), None, "key releases are not watched");
	}

	/// `CGEventType` values from `CGEventTypes.h`, spelled out here rather
	/// than taken from the lists under test.
	const LEFT_MOUSE_DOWN: u32 = 1;
	const RIGHT_MOUSE_DOWN: u32 = 3;
	const OTHER_MOUSE_DOWN: u32 = 25;

	#[test]
	fn the_monitor_sees_and_counts_every_mouse_button_press() {
		for kind in [LEFT_MOUSE_DOWN, RIGHT_MOUSE_DOWN, OTHER_MOUSE_DOWN, 10, 12] {
			assert_ne!(monitor_mask() & (1 << kind), 0, "the tap listens for {kind}");
			assert!(seen_index(kind, 0, 0).is_some(), "{kind} counts toward the monitor's progress");
		}
		for kind in [LEFT_MOUSE_DOWN, RIGHT_MOUSE_DOWN, OTHER_MOUSE_DOWN] {
			assert_eq!(user_input(kind, 0, 0, 0, 0), Some(UserInput::Choice), "{kind}");
		}
		// Releases, moves, drags and scrolling are neither choices nor watched.
		for kind in [2, 4, 26, 5, 6, 7, 27, 22] {
			assert_eq!(monitor_mask() & (1 << kind), 0, "{kind}");
			assert_eq!(seen_index(kind, 0, 0), None, "{kind}");
			assert_eq!(user_input(kind, 0, 0, 0, 0), None, "{kind}");
		}
	}
}
