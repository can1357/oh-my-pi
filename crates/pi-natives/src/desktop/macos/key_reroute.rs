//! Sends the user's keys back to their own app while a background action's
//! target holds the keyboard without the user choosing it.
//!
//! A target can take the keyboard in the middle of a background action: it
//! activates itself (a button that calls `activate`, Chrome opening a
//! ⌘-clicked link), or one of its menus or popovers takes key focus while the
//! user's app stays in front. Until the focus guard sends it back, every key
//! the user types goes to the target. For the length of one guarded action
//! this module watches `WindowServer`'s focus notifications and taps the keys
//! delivered to the target; a key the user typed while the target holds the
//! keyboard uninvited is posted to the user's app instead and the original is
//! dropped. A theft that outlasts the action behind the user's app, as an
//! open menu does, keeps being repaired until the keyboard comes back, the
//! target comes in front, the next action starts, or 30 s pass.
//!
//! A key's repeats and release go to the app its press went to, even after
//! the theft ends: `WindowServer` can still deliver them to the target, which
//! would otherwise get a release without its press. The taps stay until every
//! key pressed into the user's app has come up; a newer action's taps on the
//! same target take those keys over, and the theft too while the target still
//! holds the keyboard. A theft no notification reports, from before the
//! action or while the focus tap was disabled, is found by reading who holds
//! the keyboard as the action starts and when the tap is re-enabled.
//!
//! Only keys typed on a keyboard are moved, never keys a process posted. Keys
//! are never moved when the user chose the target or switched to another app
//! (a mouse button pressed, a ⌘ or ⌃ held, or another process's panel taking
//! the keyboard, as Spotlight's does), and no key pressed while secure
//! keyboard entry is on is moved.
use std::{
	ffi::c_void,
	ptr,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use libc::pid_t;
use parking_lot::Mutex;

use super::skylight;
use crate::desktop::control::{self, SYNTHETIC_EVENT_TAG};

type Ref = *mut c_void;
type ConstRef = *const c_void;
type Callback = unsafe extern "C" fn(Ref, u32, Ref, Ref) -> Ref;

/// `kCGAnnotatedSessionEventTap`: sees the notifications `WindowServer` sends
/// to processes.
const ANNOTATED_SESSION: u32 = 2;
const HEAD_INSERT: u32 = 0;
const TAIL_APPEND: u32 = 1;
const ACTIVE_FILTER: u32 = 0;
const LISTEN_ONLY: u32 = 1;
const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
/// `WindowServer`'s process notification event.
const PROCESS_NOTIFICATION: u32 = 21;
const TAP_DISABLED_BY_TIMEOUT: u32 = 0xffff_fffe;
const TAP_DISABLED_BY_USER_INPUT: u32 = 0xffff_ffff;
const FIELD_SOURCE_PID: u32 = 41;
/// `kCGEventSourceUserData`: [`SYNTHETIC_EVENT_TAG`] on events this process
/// posts to the HID stream.
const FIELD_SOURCE_USER_DATA: u32 = 42;
/// `kCGKeyboardEventAutorepeat`: non-zero on a held key's repeats.
const FIELD_AUTOREPEAT: u32 = 8;
/// `kCGKeyboardEventKeycode`.
const FIELD_KEYCODE: u32 = 9;
/// The process a notification is delivered to.
const FIELD_RECIPIENT_PID: u32 = 40;
/// Which notification it is.
const FIELD_NOTIFICATION: u32 = 64;
/// The process it is about: the new front app, or the process that took or
/// gave back the keyboard.
const FIELD_SUBJECT_PID: u32 = 73;
/// A new front process.
const NEW_FRONT: i64 = 2;
/// Another process took the recipient's key focus.
const KEY_FOCUS_TAKEN: i64 = 0x4000;
/// The recipient got its key focus back.
const KEY_FOCUS_RETURNED: i64 = 0x8000;
/// `kCGEventSourceStateHIDSystemState`.
const HID_SYSTEM_STATE: i32 = 1;
/// Left, right and other mouse button down and up.
const MOUSE_BUTTON_EVENTS: [u32; 6] = [1, 2, 3, 4, 25, 26];
/// ⌘ and ⌃: ⌘-Tab, ⌘-H, Spaces and launcher hotkeys pick an app with them.
const SWITCH_MODIFIERS: u64 = 0x0010_0000 | 0x0004_0000;
/// How recent a ⌘ or ⌃ must be for an app coming forward to count as the
/// user's switch: ⌘-Tab activates its app a few milliseconds after ⌘ is
/// released.
const CHORD_WINDOW: Duration = Duration::from_millis(250);

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
	fn CGEventTapCreateForPid(
		pid: pid_t,
		place: u32,
		options: u32,
		mask: u64,
		callback: Callback,
		user: Ref,
	) -> Ref;
	fn CGEventTapEnable(tap: Ref, enable: bool);
	fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
	fn CGEventGetFlags(event: Ref) -> u64;
	fn CGEventPostToPid(pid: pid_t, event: Ref);
	fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
	fn CGEventSourceFlagsState(state: i32) -> u64;
	fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
}
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
	fn IsSecureEventInputEnabled() -> u8;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	static kCFRunLoopCommonModes: Ref;
	static kCFRunLoopDefaultMode: Ref;
	fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
	fn CFRunLoopGetCurrent() -> ConstRef;
	fn CFRunLoopAddSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopRemoveSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopRunInMode(mode: Ref, seconds: f64, return_after_source: u8) -> i32;
	fn CFRelease(object: ConstRef);
}

/// Who holds the user's keyboard, as far as this action is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Holder {
	/// The user's app, or an app other than the target.
	Elsewhere,
	/// The target took it without the user choosing it.
	Stolen { buttons: [u32; 6] },
	/// The user chose the target or another process: nothing is moved for the
	/// rest of the action.
	UserChose,
	/// This action's repair is over (a newer action took over, or 30 s passed
	/// after the action): nothing more is moved, except the repeats and
	/// releases of keys whose press already was.
	Ended,
}

/// Which part of a keystroke an event is, for pairing a release with its
/// press.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stroke {
	Press,
	/// An auto-repeat of a key held down.
	Repeat,
	Release,
}

impl Stroke {
	/// A modifier key's flags change: its press when that key's
	/// device-dependent flag (`IOLLEvent.h`) is set, its release otherwise.
	/// `None` for caps lock and fn, whose events are routed one by one.
	const fn of_modifier(code: i64, flags: u64) -> Option<Self> {
		let bit = match code {
			59 => 0x1,    // left ⌃
			56 => 0x2,    // left ⇧
			60 => 0x4,    // right ⇧
			55 => 0x8,    // left ⌘
			54 => 0x10,   // right ⌘
			58 => 0x20,   // left ⌥
			61 => 0x40,   // right ⌥
			62 => 0x2000, // right ⌃
			_ => return None,
		};
		Some(if flags & bit == 0 {
			Self::Release
		} else {
			Self::Press
		})
	}
}

/// One key event delivered to the target.
#[derive(Clone, Copy, Debug)]
struct Key {
	/// Typed on a keyboard: no process posted it, this one included.
	physical: bool,
	code:     i64,
	stroke:   Option<Stroke>,
}

/// A key the user pressed through a target's tap and has not released.
#[derive(Clone, Copy, Debug)]
struct Held {
	target:    pid_t,
	code:      i64,
	/// The user's app its press was posted to; `None` when it went to the
	/// target.
	to:        Option<pid_t>,
	/// Since when the key has read up without its release reaching the tap.
	lifted_at: Option<Instant>,
}

/// What every action's taps share: the latest armed action and its target,
/// whether the target holds the keyboard uninvited as that action sees it,
/// and the keys pressed through any target's tap that have not come up.
#[derive(Debug)]
struct Registry {
	latest: (u64, pid_t),
	/// The latest action's [`Holder::Stolen`] mouse buttons while its target
	/// holds the keyboard uninvited, for a newer action on the same target to
	/// take over: the target already has the keyboard then, so no
	/// notification tells the newer action.
	stolen: Option<[u32; 6]>,
	held:   Vec<Held>,
}

static REGISTRY: Mutex<Registry> =
	Mutex::new(Registry { latest: (0, -1), stolen: None, held: Vec::new() });

/// Numbers armed actions.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// How long a held key may read up before its release is taken to have gone
/// around the target's tap: the release reaches the tap within milliseconds
/// of the key state changing.
const RELEASE_GRACE: Duration = Duration::from_millis(100);

/// Forgets the target's held keys that `is_down` has read up for
/// [`RELEASE_GRACE`]: their release reached an app without passing its tap.
fn forget_lifted(held: &mut Vec<Held>, target: pid_t, is_down: impl Fn(i64) -> bool, now: Instant) {
	held.retain_mut(|held| {
		if held.target != target {
			return true;
		}
		if is_down(held.code) {
			held.lifted_at = None;
			return true;
		}
		let since = *held.lifted_at.get_or_insert(now);
		now.saturating_duration_since(since) < RELEASE_GRACE
	});
}

/// When the user last held ⌘ or ⌃, from the flags changes the session tap
/// sees.
#[derive(Clone, Copy, Debug)]
struct Chord {
	held: bool,
	/// When ⌘ or ⌃ was last down. Its release counts: ⌘-Tab picks its app
	/// as ⌘ comes up, however long it was held.
	last: Option<Instant>,
}

impl Chord {
	/// From the modifiers held as the action starts.
	const fn new(flags: u64, now: Instant) -> Self {
		let held = flags & SWITCH_MODIFIERS != 0;
		Self { held, last: if held { Some(now) } else { None } }
	}

	const fn flags_changed(&mut self, flags: u64, now: Instant) {
		let held = flags & SWITCH_MODIFIERS != 0;
		if held || self.held {
			self.last = Some(now);
		}
		self.held = held;
	}

	/// The latest time ⌘ or ⌃ was down, as of `now`; `held_now` is the
	/// system's current modifier state, in case a flags change was missed.
	const fn last(&self, held_now: bool, now: Instant) -> Option<Instant> {
		if held_now || self.held {
			Some(now)
		} else {
			self.last
		}
	}
}

/// What the user did with the mouse and the switch modifiers, read when a
/// notification or key arrives.
#[derive(Clone, Copy, Debug)]
struct UserSignals {
	buttons:    [u32; 6],
	last_chord: Option<Instant>,
}

/// The theft bookkeeping for one action: the user's app, the target, the
/// mouse buttons as they were when the action started, and which armed
/// action it is.
#[derive(Debug)]
struct Theft {
	user:       pid_t,
	target:     pid_t,
	buttons:    [u32; 6],
	holder:     Holder,
	generation: u64,
}

impl Theft {
	const fn new(user: pid_t, target: pid_t, buttons: [u32; 6], generation: u64) -> Self {
		Self { user, target, buttons, holder: Holder::Elsewhere, generation }
	}

	/// Whether the user picked an app: a mouse button went down or up since
	/// the action started, or since the theft once there is one, or ⌘/⌃ was
	/// held within the chord window.
	fn user_acted(&self, signals: UserSignals, now: Instant) -> bool {
		let since = match self.holder {
			Holder::Stolen { buttons } => buttons,
			_ => self.buttons,
		};
		signals.buttons != since
			|| signals
				.last_chord
				.is_some_and(|at| now.saturating_duration_since(at) <= CHORD_WINDOW)
	}

	fn take(&mut self, signals: UserSignals, now: Instant) {
		self.holder = if self.user_acted(signals, now) {
			Holder::UserChose
		} else {
			Holder::Stolen { buttons: signals.buttons }
		};
	}

	/// The target holds the keyboard: a theft, unless the user picked it. A
	/// theft already under way stays one unless the user picks the target now,
	/// as ⌘-Tab, a ⌃ launcher hotkey or a click does while its menu has the
	/// keyboard.
	fn target_holds(&mut self, signals: UserSignals, now: Instant) {
		if !self.stolen() || self.user_acted(signals, now) {
			self.take(signals, now);
		}
	}

	/// Whether `focus` is a panel of another process, such as Spotlight's or
	/// a launcher's, which the user opened to pick an app.
	const fn is_panel(&self, focus: pid_t, front: pid_t) -> bool {
		focus != front && focus != self.user && focus != self.target
	}

	/// Updates the holder from one `WindowServer` notification.
	fn notify(
		&mut self,
		notification: i64,
		recipient: pid_t,
		subject: pid_t,
		signals: UserSignals,
		now: Instant,
	) {
		if matches!(self.holder, Holder::UserChose | Holder::Ended) {
			return;
		}
		match notification {
			NEW_FRONT if subject == self.target => self.target_holds(signals, now),
			// The user switched to an app other than theirs: the target taking
			// the keyboard later must not send their keys to the app they left.
			NEW_FRONT if subject != self.user && self.user_acted(signals, now) => {
				self.holder = Holder::UserChose;
			},
			NEW_FRONT => self.holder = Holder::Elsewhere,
			KEY_FOCUS_TAKEN if recipient == self.user && subject == self.target => {
				self.take(signals, now);
			},
			// Another process's panel took the keyboard from the user's app, or
			// from the target holding it: Spotlight or a launcher, which the user
			// opened to pick an app.
			KEY_FOCUS_TAKEN
				if (recipient == self.user || (recipient == self.target && self.stolen()))
					&& subject != self.user
					&& subject != self.target =>
			{
				self.holder = Holder::UserChose;
			},
			KEY_FOCUS_RETURNED if recipient == self.user => self.holder = Holder::Elsewhere,
			_ => {},
		}
	}

	/// After the focus tap was disabled, when `WindowServer` notifications
	/// may have been missed: the holder from who has the keyboard now, the
	/// `front` process or the `key_focus` one within it. With `key_focus`
	/// unknown, only a target in front is known to hold the keyboard; the
	/// holder otherwise stands, as a target menu may still have it from
	/// behind the user's app.
	fn resync(
		&mut self,
		front: pid_t,
		key_focus: Option<pid_t>,
		signals: UserSignals,
		now: Instant,
	) {
		if matches!(self.holder, Holder::UserChose | Holder::Ended) {
			return;
		}
		let Some(focus) = key_focus else {
			if front == self.target {
				self.target_holds(signals, now);
			}
			return;
		};
		if self.is_panel(focus, front) {
			self.holder = Holder::UserChose;
		} else if front == self.target || focus == self.target {
			self.target_holds(signals, now);
		} else {
			self.holder = Holder::Elsewhere;
		}
	}

	/// Makes this the latest action, unless a newer one already is. A newer
	/// action on the same target takes over its predecessor's theft, which
	/// no notification repeats while the target keeps the keyboard. With no
	/// theft to take over, the holder is read from `holders`, the front and
	/// key focus processes as the action starts: a target menu left open
	/// after an earlier repair gave up repeats no notification either.
	fn register(
		&mut self,
		registry: &mut Registry,
		holders: Option<(pid_t, Option<pid_t>)>,
		signals: UserSignals,
		now: Instant,
	) {
		if registry.latest.0 >= self.generation {
			return;
		}
		if registry.latest.1 == self.target
			&& let Some(buttons) = registry.stolen
		{
			self.holder = Holder::Stolen { buttons };
		} else if let Some((front, key_focus)) = holders {
			self.resync(front, key_focus, signals, now);
		}
		registry.latest = (self.generation, self.target);
		self.publish(registry);
	}

	/// Shares whether this, the latest action, sees its target holding the
	/// keyboard uninvited ([`Registry::stolen`]).
	const fn publish(&self, registry: &mut Registry) {
		if registry.latest.0 == self.generation {
			registry.stolen = match self.holder {
				Holder::Stolen { buttons } => Some(buttons),
				_ => None,
			};
		}
	}

	const fn stolen(&self) -> bool {
		matches!(self.holder, Holder::Stolen { .. })
	}

	/// Whether a key the user typed now goes to their app instead of the
	/// target. A mouse button since the theft means the user is now working
	/// in the target, which keeps its keys from then on.
	fn reroutes(&mut self, secure: bool, buttons: [u32; 6]) -> bool {
		let Holder::Stolen { buttons: at_theft } = self.holder else {
			return false;
		};
		if buttons != at_theft {
			self.holder = Holder::UserChose;
			return false;
		}
		!secure
	}

	/// Where a key event delivered to the target goes: `Some(app)` posts it
	/// there and drops the original, `None` lets it through. Only keys typed
	/// on a keyboard move: a key a process posted, this one or an automation
	/// tool, is meant for the target. A held key's repeats and release go
	/// where its press went, whoever holds the keyboard by then; a key first
	/// seen repeating counts as pressed then. Everything else is decided by
	/// [`Self::reroutes`]. Once a newer action taps the same target, its taps
	/// decide alone.
	fn route(
		&mut self,
		registry: &mut Registry,
		key: Key,
		secure: bool,
		buttons: [u32; 6],
	) -> Option<pid_t> {
		let (latest, latest_target) = registry.latest;
		if latest != self.generation {
			if latest_target == self.target {
				return None;
			}
			self.end();
		}
		if !key.physical {
			return None;
		}
		let fresh = self.reroutes(secure, buttons).then_some(self.user);
		self.publish(registry);
		let target = self.target;
		let held = registry
			.held
			.iter()
			.position(|held| held.target == target && held.code == key.code);
		match (key.stroke, held) {
			(Some(Stroke::Release), Some(index)) => registry.held.swap_remove(index).to,
			(Some(Stroke::Repeat), Some(index)) => registry.held[index].to,
			(Some(Stroke::Press | Stroke::Repeat), held) => {
				if let Some(index) = held {
					registry.held.swap_remove(index);
				}
				registry
					.held
					.push(Held { target, code: key.code, to: fresh, lifted_at: None });
				fresh
			},
			_ => fresh,
		}
	}

	/// Stops moving keys pressed from now on.
	const fn end(&mut self) {
		self.holder = Holder::Ended;
	}

	/// After the action, `lingered` ago: the repair goes on only for a target
	/// that holds the keyboard from behind the user's app, as an open menu
	/// does, and for at most [`LINGER_MAX`]. A target in `front` is in plain
	/// sight, and the user's keys are theirs to aim.
	fn linger(&mut self, front: Option<pid_t>, lingered: Duration) {
		if front == Some(self.target) || lingered >= LINGER_MAX {
			self.end();
		}
	}

	/// Whether the taps can go: the target no longer holds the keyboard
	/// uninvited, and every key pressed through it into a user's app has come
	/// up.
	fn settled(&self, held: &[Held]) -> bool {
		!self.stolen()
			&& !held
				.iter()
				.any(|held| held.target == self.target && held.to.is_some())
	}
}

/// Whether secure keyboard entry is on: a password field or a terminal with
/// secure keyboard entry has the keyboard.
fn secure_entry() -> bool {
	// SAFETY: a read-only query of the system keyboard state.
	unsafe { IsSecureEventInputEnabled() != 0 }
}

fn mouse_buttons() -> [u32; 6] {
	// SAFETY: HIDSystemState and these CGEventType values are defined by
	// CGEventSource.h / CGEventTypes.h; read-only queries.
	MOUSE_BUTTON_EVENTS
		.map(|event_type| unsafe { CGEventSourceCounterForEventType(HID_SYSTEM_STATE, event_type) })
}

/// Whether the key with this virtual key code is down.
fn key_down(code: i64) -> bool {
	// SAFETY: a read-only query of the system keyboard state.
	u16::try_from(code).is_ok_and(|code| unsafe { CGEventSourceKeyState(HID_SYSTEM_STATE, code) })
}

struct TapContext {
	theft:     Theft,
	chord:     Chord,
	focus_tap: Ref,
	key_tap:   Ref,
}

impl TapContext {
	fn signals(&self, now: Instant) -> UserSignals {
		let held_now = modifier_flags() & SWITCH_MODIFIERS != 0;
		UserSignals { buttons: mouse_buttons(), last_chord: self.chord.last(held_now, now) }
	}
}

fn modifier_flags() -> u64 {
	// SAFETY: HIDSystemState is defined by CGEventSource.h; a read-only query.
	unsafe { CGEventSourceFlagsState(HID_SYSTEM_STATE) }
}

fn field(event: Ref, field: u32) -> i64 {
	// SAFETY: documented read-only CGEvent integer fields of a live event.
	unsafe { CGEventGetIntegerValueField(event, field) }
}

fn pid_field(event: Ref, name: u32) -> pid_t {
	pid_t::try_from(field(event, name)).unwrap_or(-1)
}

unsafe extern "C" fn observe_focus(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: the reroute thread keeps this context alive until both taps are
	// invalidated; both callbacks run on that thread's run loop.
	let context = unsafe { &mut *user.cast::<TapContext>() };
	if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER_INPUT {
		// SAFETY: the tap outlives its callbacks.
		unsafe { CGEventTapEnable(context.focus_tap, true) };
		// Notifications sent while the tap was off are lost: read who has the
		// keyboard now instead of waiting for the next one.
		if let Some((front, key_focus)) = skylight::keyboard_holders() {
			let now = Instant::now();
			let signals = context.signals(now);
			context.theft.resync(front, key_focus, signals, now);
			context.theft.publish(&mut REGISTRY.lock());
		}
		return event;
	}
	if event.is_null() {
		return event;
	}
	let now = Instant::now();
	if kind == FLAGS_CHANGED {
		if field(event, FIELD_SOURCE_PID) == 0 {
			// SAFETY: a read-only query of a live event.
			context
				.chord
				.flags_changed(unsafe { CGEventGetFlags(event) }, now);
		}
		return event;
	}
	if kind == PROCESS_NOTIFICATION {
		let signals = context.signals(now);
		context.theft.notify(
			field(event, FIELD_NOTIFICATION),
			pid_field(event, FIELD_RECIPIENT_PID),
			pid_field(event, FIELD_SUBJECT_PID),
			signals,
			now,
		);
		context.theft.publish(&mut REGISTRY.lock());
	}
	event
}

unsafe extern "C" fn route_key(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: as in `observe_focus`.
	let context = unsafe { &mut *user.cast::<TapContext>() };
	if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER_INPUT {
		// SAFETY: the tap outlives its callbacks.
		unsafe { CGEventTapEnable(context.key_tap, true) };
		return event;
	}
	if event.is_null() || !matches!(kind, KEY_DOWN | KEY_UP | FLAGS_CHANGED) {
		return event;
	}
	let code = field(event, FIELD_KEYCODE);
	let stroke = match kind {
		KEY_DOWN if field(event, FIELD_AUTOREPEAT) != 0 => Some(Stroke::Repeat),
		KEY_DOWN => Some(Stroke::Press),
		KEY_UP => Some(Stroke::Release),
		// SAFETY: a read-only query of a live event.
		_ => Stroke::of_modifier(code, unsafe { CGEventGetFlags(event) }),
	};
	let source = (field(event, FIELD_SOURCE_PID), field(event, FIELD_SOURCE_USER_DATA));
	let physical = typed_by_user(source.0, source.1);
	// A key a process posted always passes, before the per-key system reads.
	if !physical {
		return event;
	}
	let key = Key { physical, code, stroke };
	let secure = secure_entry();
	let buttons = mouse_buttons();
	let Some(to) = context
		.theft
		.route(&mut REGISTRY.lock(), key, secure, buttons)
	else {
		return event;
	};
	// SAFETY: the event is live for this callback; posting copies it to the
	// user's app, and returning null drops the original.
	unsafe { CGEventPostToPid(to, event) };
	ptr::null_mut()
}

/// Whether a key event was typed on a keyboard: no process posted it, and it
/// does not carry omp's [`SYNTHETIC_EVENT_TAG`], as in the escape-key watch.
const fn typed_by_user(source_pid: i64, source_user_data: i64) -> bool {
	source_pid == 0 && source_user_data != SYNTHETIC_EVENT_TAG
}

/// How long the repair outlives its action while the target still holds the
/// keyboard behind the user's app: a menu it opened keeps the keyboard until
/// it closes.
const LINGER_MAX: Duration = Duration::from_secs(30);
/// How often the tap thread checks whether its action ended or a newer one
/// took over.
const SLICE_SECONDS: f64 = 0.05;

/// Moves the user's keys back while its action runs, and after it while the
/// target still holds the keyboard uninvited (up to [`LINGER_MAX`], or until
/// the next armed action) or a key pressed into the user's app is still down.
/// Dropping it marks the action ended; the tap thread then stops on its own.
pub(super) struct KeyReroute {
	ended: Arc<AtomicBool>,
}

impl KeyReroute {
	/// Starts watching for the target taking the user's keyboard. `None` when
	/// the taps cannot be created (no Accessibility permission, or the target
	/// exited): the action then runs as before, without key repair.
	pub(super) fn arm(user: pid_t, target: pid_t) -> Option<Self> {
		// The user is typing a password or into a secure terminal: their keys
		// are never tapped, even after the target takes the keyboard and secure
		// entry goes off with their app.
		if user == target || secure_entry() {
			return None;
		}
		let generation = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
		let ended = Arc::new(AtomicBool::new(false));
		let action_ended = Arc::clone(&ended);
		let (ready, receive) = flume::bounded(1);
		thread::Builder::new()
			.name("desktop-key-reroute".into())
			.spawn(move || {
				let mut context = TapContext {
					theft:     Theft::new(user, target, mouse_buttons(), generation),
					chord:     Chord::new(modifier_flags(), Instant::now()),
					focus_tap: ptr::null_mut(),
					key_tap:   ptr::null_mut(),
				};
				let user_data: Ref = ptr::from_mut(&mut context).cast();
				// SAFETY: listen-only session tap and an active tap on the
				// target's keys; `context` outlives both through invalidation.
				let (focus_tap, key_tap) = unsafe {
					(
						CGEventTapCreate(
							ANNOTATED_SESSION,
							TAIL_APPEND,
							LISTEN_ONLY,
							(1 << PROCESS_NOTIFICATION) | (1 << FLAGS_CHANGED),
							observe_focus,
							user_data,
						),
						CGEventTapCreateForPid(
							target,
							HEAD_INSERT,
							ACTIVE_FILTER,
							(1 << KEY_DOWN) | (1 << KEY_UP) | (1 << FLAGS_CHANGED),
							route_key,
							user_data,
						),
					)
				};
				context.focus_tap = focus_tap;
				context.key_tap = key_tap;
				// SAFETY: run-loop sources for the taps that were created.
				let sources = unsafe {
					[focus_tap, key_tap].map(|tap| {
						if tap.is_null() {
							ptr::null_mut()
						} else {
							CFMachPortCreateRunLoopSource(ptr::null_mut(), tap, 0)
						}
					})
				};
				let complete = sources.iter().all(|source| !source.is_null());
				// SAFETY: every object below was created above and is released
				// exactly once; the run loop holds the sources while it runs.
				unsafe {
					let run_loop = CFRunLoopGetCurrent();
					if complete {
						for source in sources {
							CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
						}
						CGEventTapEnable(focus_tap, true);
						CGEventTapEnable(key_tap, true);
						// Listed so a host exiting mid-action closes them too.
						control::add_live_tap(focus_tap);
						control::add_live_tap(key_tap);
						// From here this action's taps decide for its target, and
						// older actions stop moving new keys. Read after the taps
						// are on, so a later change still arrives as a notification.
						let holders = skylight::keyboard_holders();
						let now = Instant::now();
						let signals = context.signals(now);
						context
							.theft
							.register(&mut REGISTRY.lock(), holders, signals, now);
						let _ = ready.send(true);
						let mut ended_at = None;
						loop {
							CFRunLoopRunInMode(kCFRunLoopDefaultMode, SLICE_SECONDS, 0);
							let now = Instant::now();
							let front = if action_ended.load(Ordering::Acquire) {
								skylight::keyboard_holders().map(|(front, _)| front)
							} else {
								None
							};
							let mut registry = REGISTRY.lock();
							let (latest, latest_target) = registry.latest;
							if latest != generation {
								// A newer action's taps on this target take over
								// its held keys.
								if latest_target == target {
									break;
								}
								context.theft.end();
							}
							if latest == generation && !action_ended.load(Ordering::Acquire) {
								continue;
							}
							let at = *ended_at.get_or_insert(now);
							context
								.theft
								.linger(front, now.saturating_duration_since(at));
							context.theft.publish(&mut registry);
							forget_lifted(&mut registry.held, target, key_down, now);
							if context.theft.settled(&registry.held) {
								registry.held.retain(|held| held.target != target);
								break;
							}
						}
						for source in sources {
							CFRunLoopRemoveSource(run_loop, source, kCFRunLoopCommonModes);
						}
					} else {
						let _ = ready.send(false);
					}
					for source in sources {
						if !source.is_null() {
							CFRelease(source);
						}
					}
					for tap in [focus_tap, key_tap] {
						if !tap.is_null() {
							control::invalidate_live_tap(tap);
							CFRelease(tap);
						}
					}
				}
			})
			.ok()?;
		receive.recv().unwrap_or(false).then_some(Self { ended })
	}
}

impl Drop for KeyReroute {
	fn drop(&mut self) {
		self.ended.store(true, Ordering::Release);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const USER: pid_t = 100;
	const TARGET: pid_t = 200;
	const SPOTLIGHT: pid_t = 300;
	const BUTTONS: [u32; 6] = [5, 5, 0, 0, 0, 0];
	const CLICKED: [u32; 6] = [6, 5, 0, 0, 0, 0];

	fn quiet() -> UserSignals {
		UserSignals { buttons: BUTTONS, last_chord: None }
	}

	fn theft() -> Theft {
		Theft::new(USER, TARGET, BUTTONS, 1)
	}

	const Q: i64 = 12;
	const LEFT_SHIFT: i64 = 56;
	const OTHER_USER: pid_t = 500;
	const OTHER_TARGET: pid_t = 600;
	/// Posted to the user's app.
	const MOVED: Option<pid_t> = Some(USER);
	/// Let through to the target.
	const KEPT: Option<pid_t> = None;

	fn user_key(code: i64, stroke: Stroke) -> Key {
		Key { physical: true, code, stroke: Some(stroke) }
	}

	/// A key a process posted: this one, or an automation tool.
	fn posted_key(code: i64, stroke: Stroke) -> Key {
		Key { physical: false, code, stroke: Some(stroke) }
	}

	/// Registers `theft` as its action starts, the user's app holding the
	/// keyboard.
	fn register(theft: &mut Theft, registry: &mut Registry) {
		theft.register(registry, Some((USER, Some(USER))), quiet(), Instant::now());
	}

	/// One action's theft, the latest armed action in its registry.
	struct Rig {
		theft:    Theft,
		registry: Registry,
	}

	impl Rig {
		fn new() -> Self {
			let registry = Registry { latest: (0, -1), stolen: None, held: Vec::new() };
			let mut rig = Self { theft: theft(), registry };
			register(&mut rig.theft, &mut rig.registry);
			rig
		}

		/// One notification, as the focus tap handles it.
		fn notify(&mut self, notification: i64, recipient: pid_t, subject: pid_t) {
			self
				.theft
				.notify(notification, recipient, subject, quiet(), Instant::now());
			self.theft.publish(&mut self.registry);
		}

		fn steal(&mut self) {
			self.notify(KEY_FOCUS_TAKEN, USER, TARGET);
		}

		fn give_back(&mut self) {
			self.notify(KEY_FOCUS_RETURNED, USER, USER);
		}

		fn key_with(&mut self, code: i64, stroke: Stroke, secure: bool) -> Option<pid_t> {
			self
				.theft
				.route(&mut self.registry, user_key(code, stroke), secure, BUTTONS)
		}

		fn key(&mut self, code: i64, stroke: Stroke) -> Option<pid_t> {
			self.key_with(code, stroke, false)
		}

		fn settled(&self) -> bool {
			self.theft.settled(&self.registry.held)
		}
	}

	#[test]
	fn a_release_follows_its_moved_press_after_the_user_gets_focus_back() {
		let mut rig = Rig::new();
		rig.steal();
		assert_eq!(rig.key(Q, Stroke::Press), MOVED);
		rig.give_back();
		assert!(!rig.settled(), "the taps must outlive the theft while q is down");
		assert_eq!(rig.key(Q, Stroke::Repeat), MOVED);
		assert_eq!(rig.key(Q, Stroke::Release), MOVED);
		assert!(rig.settled());
		// The next keystroke is the target's again.
		assert_eq!(rig.key(Q, Stroke::Press), KEPT);
		assert_eq!(rig.key(Q, Stroke::Release), KEPT);
	}

	#[test]
	fn a_release_follows_its_press_into_the_target_after_a_theft_starts() {
		let mut rig = Rig::new();
		assert_eq!(rig.key(Q, Stroke::Press), KEPT);
		rig.steal();
		assert_eq!(rig.key(Q, Stroke::Repeat), KEPT);
		assert_eq!(rig.key(Q, Stroke::Release), KEPT);
		// A release whose press the tap never saw is decided like a press.
		assert_eq!(rig.key(Q, Stroke::Release), MOVED);
	}

	#[test]
	fn a_key_first_seen_repeating_counts_as_pressed_then() {
		// Q went down into the user's app before the action; its repeats reach
		// the target once it takes the keyboard.
		let mut rig = Rig::new();
		rig.steal();
		assert_eq!(rig.key(Q, Stroke::Repeat), MOVED);
		rig.give_back();
		assert!(!rig.settled());
		assert_eq!(rig.key(Q, Stroke::Release), MOVED);
		assert!(rig.settled());
	}

	#[test]
	fn a_modifier_release_follows_its_moved_press() {
		assert_eq!(Stroke::of_modifier(LEFT_SHIFT, 0x0002_0102), Some(Stroke::Press));
		assert_eq!(Stroke::of_modifier(LEFT_SHIFT, 0x0000_0100), Some(Stroke::Release));
		// Right shift still down: the flag stays, the left key's bit does not.
		assert_eq!(Stroke::of_modifier(LEFT_SHIFT, 0x0002_0104), Some(Stroke::Release));
		assert_eq!(Stroke::of_modifier(57, 0x0001_0100), None, "caps lock");
		let mut rig = Rig::new();
		rig.steal();
		assert_eq!(rig.key(LEFT_SHIFT, Stroke::Press), MOVED);
		rig.give_back();
		assert_eq!(rig.key(LEFT_SHIFT, Stroke::Release), MOVED);
	}

	#[test]
	fn after_the_linger_or_a_newer_action_elsewhere_only_held_keys_move() {
		for supersede in [false, true] {
			let mut rig = Rig::new();
			rig.steal();
			assert_eq!(rig.key(Q, Stroke::Press), MOVED);
			if supersede {
				rig.registry.latest = (2, OTHER_TARGET);
			} else {
				rig.theft.end();
			}
			rig.steal();
			assert_eq!(rig.key(LEFT_SHIFT, Stroke::Press), KEPT);
			assert!(!rig.settled());
			assert_eq!(rig.key(Q, Stroke::Release), MOVED);
			assert!(rig.settled());
		}
	}

	#[test]
	fn a_newer_action_on_the_same_target_takes_over_the_held_keys() {
		let mut old = Rig::new();
		old.steal();
		assert_eq!(old.key(Q, Stroke::Press), MOVED);
		// The user is in another app when the next action, on the same target,
		// starts; the target takes the keyboard again.
		let mut newer = Theft::new(OTHER_USER, TARGET, BUTTONS, 2);
		let mut registry = old.registry;
		register(&mut newer, &mut registry);
		newer.notify(KEY_FOCUS_TAKEN, OTHER_USER, TARGET, quiet(), Instant::now());
		let mut route = |theft: &mut Theft, code, stroke| {
			theft.route(&mut registry, user_key(code, stroke), false, BUTTONS)
		};
		let mut old = old.theft;
		// The newer tap sees keys first: Q's release goes where its press went,
		// fresh keys to the newer action's user.
		assert_eq!(route(&mut newer, Q, Stroke::Release), MOVED);
		assert_eq!(route(&mut newer, LEFT_SHIFT, Stroke::Press), Some(OTHER_USER));
		// The older tap lets everything through.
		assert_eq!(route(&mut old, LEFT_SHIFT, Stroke::Release), KEPT);
		assert_eq!(route(&mut old, Q, Stroke::Press), KEPT);
		assert_eq!(route(&mut newer, LEFT_SHIFT, Stroke::Release), Some(OTHER_USER));
		newer.notify(KEY_FOCUS_RETURNED, OTHER_USER, OTHER_USER, quiet(), Instant::now());
		assert!(newer.settled(&registry.held));
	}

	#[test]
	fn a_newer_action_on_the_same_target_takes_over_a_theft_in_progress() {
		// The target's menu still has the keyboard after the last action when
		// the next one on it starts: no notification repeats the theft.
		let mut old = Rig::new();
		old.steal();
		let mut newer = Theft::new(USER, TARGET, BUTTONS, 2);
		let mut registry = old.registry;
		register(&mut newer, &mut registry);
		let mut old = old.theft;
		assert_eq!(registry.latest, (2, TARGET));
		assert_eq!(newer.route(&mut registry, user_key(Q, Stroke::Press), false, BUTTONS), MOVED);
		assert_eq!(old.route(&mut registry, user_key(Q, Stroke::Release), false, BUTTONS), KEPT);
		assert_eq!(newer.route(&mut registry, user_key(Q, Stroke::Release), false, BUTTONS), MOVED);
		// Without a theft in progress, or for another target, there is none to
		// take over.
		for (given_back, target) in [(true, TARGET), (false, OTHER_TARGET)] {
			let mut old = Rig::new();
			old.steal();
			if given_back {
				old.give_back();
			}
			let mut newer = Theft::new(USER, target, BUTTONS, 2);
			register(&mut newer, &mut old.registry);
			assert_eq!(newer.holder, Holder::Elsewhere, "target {target}");
			assert_eq!(old.registry.stolen, None);
		}
		// An older action registering late changes nothing.
		let mut rig = Rig::new();
		rig.registry.latest = (5, OTHER_TARGET);
		register(&mut rig.theft, &mut rig.registry);
		assert_eq!(rig.registry.latest, (5, OTHER_TARGET));
	}

	#[test]
	fn a_newer_action_reads_a_theft_the_last_repair_gave_up_on() {
		// The target's menu kept the keyboard through the last action's 30 s
		// linger: the next action on it gets no notification of the theft.
		let mut old = Rig::new();
		old.steal();
		old.theft.linger(Some(USER), LINGER_MAX);
		old.theft.publish(&mut old.registry);
		assert_eq!(old.registry.stolen, None);
		let mut newer = Theft::new(USER, TARGET, BUTTONS, 2);
		let mut registry = old.registry;
		newer.register(&mut registry, Some((USER, Some(TARGET))), quiet(), Instant::now());
		assert_eq!(registry.stolen, Some(BUTTONS));
		assert_eq!(newer.route(&mut registry, user_key(Q, Stroke::Press), false, BUTTONS), MOVED);
	}

	#[test]
	fn the_holder_is_read_again_after_the_focus_tap_was_disabled() {
		let now = Instant::now();
		// The target took the keyboard, by menu or by coming forward, while the
		// tap was off.
		for (front, key_focus) in [(USER, Some(TARGET)), (TARGET, None), (TARGET, Some(TARGET))] {
			let mut theft = theft();
			theft.resync(front, key_focus, quiet(), now);
			assert!(theft.reroutes(false, BUTTONS), "front {front}, focus {key_focus:?}");
			// It still has it: the theft stands.
			theft.resync(front, key_focus, quiet(), now);
			assert!(theft.stolen());
		}
		// The keyboard came back to the user's app, or the user went to another.
		for (front, key_focus) in [(USER, Some(USER)), (OTHER_USER, Some(OTHER_USER))] {
			let mut theft = theft();
			theft.notify(KEY_FOCUS_TAKEN, USER, TARGET, quiet(), now);
			theft.resync(front, key_focus, quiet(), now);
			assert_eq!(theft.holder, Holder::Elsewhere, "front {front}, focus {key_focus:?}");
		}
		// A click before the target came, or another process's panel in the
		// user's app, is the user's choice.
		let clicked = UserSignals { buttons: CLICKED, last_chord: None };
		let mut theft = theft();
		theft.resync(TARGET, None, clicked, now);
		assert_eq!(theft.holder, Holder::UserChose);
		let mut theft = self::theft();
		theft.resync(USER, Some(SPOTLIGHT), quiet(), now);
		assert_eq!(theft.holder, Holder::UserChose);
	}

	#[test]
	fn a_theft_stands_when_the_key_focus_cannot_be_read() {
		let now = Instant::now();
		// The target's menu may still have the keyboard behind the front app.
		for front in [USER, OTHER_USER] {
			let mut theft = theft();
			theft.notify(KEY_FOCUS_TAKEN, USER, TARGET, quiet(), now);
			theft.resync(front, None, quiet(), now);
			assert!(theft.stolen(), "front {front}");
		}
		// Nor does an unread key focus make a theft behind the user's app.
		let mut theft = theft();
		theft.resync(USER, None, quiet(), now);
		assert_eq!(theft.holder, Holder::Elsewhere);
	}

	#[test]
	fn keys_a_process_posts_to_the_target_are_never_moved() {
		// An automation tool's shortcut for the target, while it holds the
		// keyboard, stays the target's, and leaves the user's held key alone.
		let mut rig = Rig::new();
		rig.steal();
		assert_eq!(rig.key(Q, Stroke::Press), MOVED);
		let mut posted = |code, stroke| {
			rig.theft
				.route(&mut rig.registry, posted_key(code, stroke), false, BUTTONS)
		};
		assert_eq!(posted(LEFT_SHIFT, Stroke::Press), KEPT);
		assert_eq!(posted(Q, Stroke::Press), KEPT);
		assert_eq!(posted(Q, Stroke::Release), KEPT);
		assert_eq!(rig.key(Q, Stroke::Release), MOVED);
	}

	#[test]
	fn no_key_pressed_during_secure_entry_moves_but_a_moved_press_keeps_its_release() {
		let mut rig = Rig::new();
		rig.steal();
		assert_eq!(rig.key_with(Q, Stroke::Press, true), KEPT);
		assert_eq!(rig.key_with(Q, Stroke::Repeat, true), KEPT);
		assert_eq!(rig.key_with(Q, Stroke::Release, true), KEPT);
		assert_eq!(rig.key(LEFT_SHIFT, Stroke::Press), MOVED);
		assert_eq!(rig.key_with(LEFT_SHIFT, Stroke::Release, true), MOVED);
	}

	#[test]
	fn the_agents_own_keys_never_take_a_held_keys_release() {
		let mut rig = Rig::new();
		rig.steal();
		let mut own = |stroke| {
			rig.theft
				.route(&mut rig.registry, posted_key(Q, stroke), false, BUTTONS)
		};
		assert_eq!(own(Stroke::Press), KEPT);
		assert_eq!(own(Stroke::Release), KEPT);
		let mut rig = Rig::new();
		rig.steal();
		assert_eq!(rig.key(Q, Stroke::Press), MOVED);
		assert_eq!(
			rig.theft
				.route(&mut rig.registry, posted_key(Q, Stroke::Release), false, BUTTONS),
			KEPT
		);
		rig.give_back();
		assert_eq!(rig.key(Q, Stroke::Release), MOVED);
	}

	#[test]
	fn a_release_that_went_around_the_tap_is_forgotten_after_the_grace() {
		let t0 = Instant::now();
		let ms = Duration::from_millis;
		let held = |target| Held { target, code: Q, to: MOVED, lifted_at: None };
		let mut keys = vec![held(TARGET), held(OTHER_TARGET)];
		forget_lifted(&mut keys, TARGET, |_| true, t0);
		forget_lifted(&mut keys, TARGET, |_| false, t0 + ms(10));
		forget_lifted(&mut keys, TARGET, |_| false, t0 + ms(9) + RELEASE_GRACE);
		assert_eq!(keys.len(), 2, "the release may still be on its way");
		forget_lifted(&mut keys, TARGET, |_| false, t0 + ms(10) + RELEASE_GRACE);
		assert_eq!(keys.len(), 1);
		assert_eq!(keys[0].target, OTHER_TARGET, "another target's keys are its taps' to forget");
	}

	#[test]
	fn a_switch_modifier_counts_while_held_and_when_released() {
		const COMMAND: u64 = 0x0010_0108;
		const CONTROL: u64 = 0x0004_0101;
		const SHIFT: u64 = 0x0002_0102;
		const NONE: u64 = 0x100;
		let t0 = Instant::now();
		let ms = Duration::from_millis;
		// ⌘ held 600 ms for a ⌘-Tab; the target comes forward 5 ms after ⌘ is
		// released.
		let mut chord = Chord::new(NONE, t0);
		chord.flags_changed(COMMAND, t0);
		chord.flags_changed(NONE, t0 + ms(600));
		let mut theft = theft();
		let at = t0 + ms(605);
		let signals = UserSignals { buttons: BUTTONS, last_chord: chord.last(false, at) };
		theft.notify(NEW_FRONT, 1, TARGET, signals, at);
		assert!(!theft.reroutes(false, BUTTONS));
		// ⌃ already held as the action starts, or held without a flags change
		// seen: it is down now.
		assert_eq!(Chord::new(CONTROL, t0).last(false, t0 + ms(900)), Some(t0 + ms(900)));
		assert_eq!(Chord::new(NONE, t0).last(true, t0 + ms(50)), Some(t0 + ms(50)));
		// Shift is no switch.
		let mut shift = Chord::new(NONE, t0);
		shift.flags_changed(SHIFT, t0);
		shift.flags_changed(NONE, t0 + ms(5));
		assert_eq!(shift.last(false, t0 + ms(10)), None);
	}

	#[test]
	fn target_coming_forward_unasked_reroutes_the_users_keys() {
		let mut theft = theft();
		theft.notify(NEW_FRONT, 1, TARGET, quiet(), Instant::now());
		assert!(theft.reroutes(false, BUTTONS));
	}

	#[test]
	fn target_menu_taking_key_focus_reroutes_the_users_keys() {
		let mut theft = theft();
		theft.notify(KEY_FOCUS_TAKEN, USER, TARGET, quiet(), Instant::now());
		assert!(theft.reroutes(false, BUTTONS));
	}

	#[test]
	fn nothing_moves_before_a_theft_or_after_the_user_gets_focus_back() {
		let mut theft = theft();
		assert!(!theft.reroutes(false, BUTTONS));
		theft.notify(KEY_FOCUS_TAKEN, USER, TARGET, quiet(), Instant::now());
		theft.notify(KEY_FOCUS_RETURNED, USER, USER, quiet(), Instant::now());
		assert!(!theft.reroutes(false, BUTTONS));
		theft.notify(NEW_FRONT, 1, TARGET, quiet(), Instant::now());
		theft.notify(NEW_FRONT, 1, USER, quiet(), Instant::now());
		assert!(!theft.reroutes(false, BUTTONS));
	}

	#[test]
	fn a_click_before_the_target_comes_forward_is_the_users_choice() {
		let mut theft = theft();
		let clicked = UserSignals { buttons: CLICKED, last_chord: None };
		theft.notify(NEW_FRONT, 1, TARGET, clicked, Instant::now());
		assert!(!theft.reroutes(false, CLICKED));
		// Sticky: a later return and theft move nothing either.
		theft.notify(NEW_FRONT, 1, USER, clicked, Instant::now());
		theft.notify(NEW_FRONT, 1, TARGET, clicked, Instant::now());
		assert!(!theft.reroutes(false, CLICKED));
	}

	#[test]
	fn a_recent_command_or_control_is_the_users_switch() {
		let now = Instant::now();
		let mut theft = theft();
		let tabbed = UserSignals { buttons: BUTTONS, last_chord: Some(now) };
		theft.notify(NEW_FRONT, 1, TARGET, tabbed, now + Duration::from_millis(5));
		assert!(!theft.reroutes(false, BUTTONS));
		let mut stale = self::theft();
		stale.notify(NEW_FRONT, 1, TARGET, tabbed, now + CHORD_WINDOW + Duration::from_millis(1));
		assert!(stale.reroutes(false, BUTTONS));
	}

	#[test]
	fn a_switch_to_another_app_keeps_a_later_theft_from_moving_keys() {
		let now = Instant::now();
		let later = now + CHORD_WINDOW + Duration::from_millis(1);
		let tabbed = UserSignals { buttons: BUTTONS, last_chord: Some(now) };
		// The user ⌘-Tabs from their app to another; the target comes forward
		// after the chord window: their keys must not go to the app they left.
		let mut theft = theft();
		theft.notify(NEW_FRONT, 1, OTHER_USER, tabbed, now);
		theft.notify(NEW_FRONT, 1, TARGET, quiet(), later);
		assert!(!theft.reroutes(false, BUTTONS));
		// Switching back to their own app, or another app coming forward on
		// its own, leaves a later theft repaired.
		for (front, signals) in [(USER, tabbed), (OTHER_USER, quiet())] {
			let mut theft = self::theft();
			theft.notify(NEW_FRONT, 1, front, signals, now);
			theft.notify(NEW_FRONT, 1, TARGET, quiet(), later);
			assert!(theft.reroutes(false, BUTTONS), "front {front}");
		}
	}

	#[test]
	fn a_click_while_stolen_hands_the_target_its_keys() {
		let mut theft = theft();
		theft.notify(NEW_FRONT, 1, TARGET, quiet(), Instant::now());
		assert!(!theft.reroutes(false, CLICKED));
		assert!(!theft.reroutes(false, CLICKED));
		assert_eq!(theft.holder, Holder::UserChose);
	}

	#[test]
	fn another_panel_taking_the_keyboard_is_the_users_choice() {
		let mut theft = theft();
		theft.notify(KEY_FOCUS_TAKEN, USER, SPOTLIGHT, quiet(), Instant::now());
		theft.notify(NEW_FRONT, 1, TARGET, quiet(), Instant::now());
		assert!(!theft.reroutes(false, BUTTONS));
	}

	#[test]
	fn no_key_moves_during_secure_entry() {
		let mut theft = theft();
		theft.notify(NEW_FRONT, 1, TARGET, quiet(), Instant::now());
		assert!(!theft.reroutes(true, BUTTONS));
		assert!(theft.reroutes(false, BUTTONS));
	}

	#[test]
	fn notifications_to_other_recipients_or_about_other_apps_leave_a_theft_alone() {
		let mut theft = theft();
		theft.notify(KEY_FOCUS_TAKEN, USER, TARGET, quiet(), Instant::now());
		theft.notify(KEY_FOCUS_RETURNED, SPOTLIGHT, SPOTLIGHT, quiet(), Instant::now());
		theft.notify(KEY_FOCUS_TAKEN, SPOTLIGHT, TARGET, quiet(), Instant::now());
		assert!(theft.reroutes(false, BUTTONS));
	}

	#[test]
	fn picking_the_target_while_it_holds_the_keyboard_ends_the_theft() {
		let now = Instant::now();
		let tabbed = UserSignals { buttons: BUTTONS, last_chord: Some(now) };
		let clicked = UserSignals { buttons: CLICKED, last_chord: None };
		// Its menu has the keyboard; the user ⌘-Tabs, uses a ⌃ launcher hotkey
		// or clicks to bring it forward, and types into it.
		for signals in [tabbed, clicked] {
			let mut rig = Rig::new();
			rig.steal();
			rig.theft.notify(NEW_FRONT, 1, TARGET, signals, now);
			assert_eq!(rig.key(Q, Stroke::Press), KEPT);
		}
		// Spotlight's panel takes the keyboard from the target's menu.
		let mut rig = Rig::new();
		rig.steal();
		rig.notify(KEY_FOCUS_TAKEN, TARGET, SPOTLIGHT);
		assert_eq!(rig.key(Q, Stroke::Press), KEPT);
		// The target coming forward on its own keeps the theft.
		let mut rig = Rig::new();
		rig.steal();
		rig.notify(NEW_FRONT, 1, TARGET);
		assert_eq!(rig.key(Q, Stroke::Press), MOVED);

		// The same, read back after the focus tap was disabled.
		for (front, focus, signals) in
			[(TARGET, None, tabbed), (TARGET, None, clicked), (TARGET, Some(SPOTLIGHT), quiet())]
		{
			let mut theft = theft();
			theft.notify(KEY_FOCUS_TAKEN, USER, TARGET, quiet(), now);
			theft.resync(front, focus, signals, now);
			assert_eq!(theft.holder, Holder::UserChose, "focus {focus:?}");
		}
		let mut theft = theft();
		theft.notify(KEY_FOCUS_TAKEN, USER, TARGET, quiet(), now);
		theft.resync(TARGET, None, quiet(), now);
		assert!(theft.stolen());
	}

	#[test]
	fn the_repair_lingers_only_behind_the_users_app_and_for_at_most_30_s() {
		let linger = |front, lingered| {
			let mut theft = theft();
			theft.notify(KEY_FOCUS_TAKEN, USER, TARGET, quiet(), Instant::now());
			theft.linger(front, lingered);
			theft.stolen()
		};
		// A menu left open behind the user's app.
		assert!(linger(Some(USER), Duration::from_secs(1)));
		assert!(linger(None, Duration::from_secs(1)), "front unknown");
		// The target in front after the action, or 30 s on.
		assert!(!linger(Some(TARGET), Duration::ZERO));
		assert!(!linger(Some(USER), LINGER_MAX));
	}

	#[test]
	fn only_keys_no_process_posted_are_typed_by_the_user() {
		assert!(typed_by_user(0, 0));
		assert!(!typed_by_user(0, SYNTHETIC_EVENT_TAG), "omp's own HID keys");
		assert!(!typed_by_user(4321, 0), "an automation tool's keys");
		assert!(!typed_by_user(4321, SYNTHETIC_EVENT_TAG));
	}
}
