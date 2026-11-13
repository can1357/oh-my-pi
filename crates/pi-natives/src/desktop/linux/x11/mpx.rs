//! Focus-free real input on X11 via an `XInput2` MPX virtual master pair.
//!
//! X11 has one core pointer and one core keyboard focus, which is why `XTest`
//! cannot reach a background window and why the toolkits that ignore
//! `send_event` (GTK, Qt, VCL, Chromium) drop `XSendEvent`. MPX adds a second
//! master pointer/keyboard pair: its pointer is warped independently of the
//! user's (`XIWarpPointer`) and its keyboard carries its own focus
//! (`XISetFocus`). Events from uinput slaves attached to it are real,
//! non-synthetic XI2 events. Core events are disabled: core-protocol WMs
//! otherwise mistake virtual-device focus for a user activation.
//!
//! A master pair, once added, stays for the X server's lifetime. Removing a
//! master makes running Qt 6.5+ xcb clients delete that master's child
//! devices twice and crash (QTBUG-146876), and adding and removing masters per
//! action crashes mutter 42 and `LibreOffice` VCL. So a session takes a pair
//! no live session holds, or adds one up to a two-pair cap, and records itself
//! as the holder in a property of the master pointer; when it ends it unplugs
//! its uinput slaves and marks the pair free for the next session. Holders are
//! named after their process incarnation, so a killed holder's pair is reused.
//! At the cap, the existing XSendEvent/refusal path handles further sessions.
//! The pool uses at most eight persistent device slots, rather than growing
//! into Xorg's 40-slot device limit; active sessions also need uinput slaves.

use std::{
	fs, io,
	sync::atomic::{AtomicU16, Ordering},
	time::{Duration, Instant},
};

use x11rb::{
	CURRENT_TIME, NONE,
	connection::Connection,
	protocol::{
		Event,
		xinput::{
			self, ConnectionExt as _, Device, DeviceType, EventMode, HierarchyChange,
			HierarchyChangeData, HierarchyChangeDataAddMaster, HierarchyChangeDataAttachSlave,
			XIChangePropertyAux, XIDeviceInfo, XIEventMask, XIGetPropertyItems,
		},
		xkb::{self, ConnectionExt as _},
		xproto::{Atom, AtomEnum, ConnectionExt as _, ModMask, PropMode, Window},
	},
	rust_connection::RustConnection,
};

use super::{
	input::button_detail,
	keymap::{self, KeyStep, Keymap},
	uinput::{UInputDevice, X_KEYCODE_OFFSET},
	wm::{Atoms, Wm, refusal},
};
use crate::desktop::{
	backend::{Modifiers, MouseButton},
	control,
	error::{CoreResult, DesktopError},
	keys::KeyName,
};

/// udev + xf86-input-libinput hot-add the uinput slave on a real Xorg;
/// servers without hotplug never do, which the timeout covers.
const SLAVE_BIND_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the server gets to report an emitted pointer event back.
const POINTER_CONFIRM_TIMEOUT: Duration = Duration::from_secs(1);
/// How long the server gets to report every key release of a run back.
const KEY_CONFIRM_TIMEOUT: Duration = Duration::from_millis(1500);
/// Press → release hold, so toolkits see two distinct frames.
const PRESS_HOLD: Duration = Duration::from_millis(12);
/// Release → next press gap of a multi-click; well under the 250 ms GTK
/// double-click threshold.
const CLICK_GAP: Duration = Duration::from_millis(35);
/// Lets the toolkit arm its drag threshold before the first motion.
const DRAG_ARM: Duration = Duration::from_millis(40);
const DRAG_STEP_DELAY: Duration = Duration::from_millis(8);
/// Longest relative motion per drag step, so toolkits see a continuous glide.
const DRAG_STEP_MAX_PX: f64 = 16.0;
const DRAG_RELEASE_SETTLE: Duration = Duration::from_millis(20);
const SCROLL_DETENT_DELAY: Duration = Duration::from_millis(35);
const KEY_DELAY: Duration = Duration::from_millis(10);
/// Lets the toolkit translate the last key before the next action.
const KEY_SETTLE: Duration = Duration::from_millis(30);
/// X keycode of evdev `KEY_UNKNOWN`: `NoSymbol` in every evdev keymap.
const WARM_UP_KEYCODE: u8 = 240 + X_KEYCODE_OFFSET;
/// Gives clients time to process the hierarchy change after the warm-up.
const WARM_UP_SETTLE: Duration = Duration::from_millis(120);
/// Master names that encode an owner incarnation (see [`Owner`]). omp
/// versions that removed pairs also remove every `v1.` master whose creator
/// has died, which is now a held pair's normal state; new pairs are `v2.`.
const OWNER_PREFIX: &str = "OMP MPX v2.";
/// Two pairs leave room for real-device hotplug even after concurrent sessions.
const MAX_PAIRS: usize = 2;
/// Master pointer property naming the session that holds the pair.
#[cfg(test)]
const HOLDER_PROPERTY: &str = "_OMP_MPX_HOLDER";
/// How long a session's end waits for the server to drop its unplugged slaves.
const UNPLUG_TIMEOUT: Duration = Duration::from_secs(1);
/// Holder property value of a pair no session holds.
const HOLDER_FREE: &[u8] = b"free";

static NONCE: AtomicU16 = AtomicU16::new(1);

#[cfg(test)]
type ReleaseEvents = std::cell::RefCell<Box<dyn FnMut() -> Option<Event> + Send>>;

pub(super) struct Mpx {
	conn:            RustConnection,
	root:            Window,
	atoms:           Atoms,
	/// Bottom-right screen corner: the virtual cursor rests there between
	/// actions, where its sprite is all but off-screen.
	park:            (i16, i16),
	name:            String,
	master_pointer:  u16,
	master_keyboard: u16,
	pointer:         UInputDevice,
	pointer_slave:   u16,
	keyboard:        Option<VirtualKeyboard>,
	/// A timeout can leave kernel events in flight. Never retarget that pair
	/// to another window after an uncertain dispatch.
	uncertain:       bool,
	/// Whether the current call already sent a key, button, wheel or motion
	/// event, which turns a later refusal into a partial delivery.
	sent:            bool,
	/// Replaces only raw-event polling in typing regressions; emission, keymap,
	/// focus, error mapping and the session gate still run normally.
	#[cfg(test)]
	release_events:  Option<ReleaseEvents>,
}

/// The uinput keyboard slave, created on the first keyboard or modifier use
/// so pointer-only sessions never pay for a second hotplug.
struct VirtualKeyboard {
	device: UInputDevice,
	slave:  u16,
}

/// A slave a call sends through and the master of this pair it must sit on.
#[derive(Clone, Copy)]
struct Route {
	slave:  u16,
	master: u16,
	/// The slave's name after the session's: the server gives a freed id to
	/// the next device plugged in.
	suffix: &'static str,
	device: &'static str,
}

/// Where the server holds a routed slave.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Seat {
	Ours,
	/// Enabled, on another master (`Some`) or floating (`None`).
	Moved(Option<u16>),
	Disabled,
	/// Not listed under its id and name.
	Gone,
}

impl Seat {
	fn describe(self) -> String {
		match self {
			Self::Ours => "on omp's master pair".to_owned(),
			Self::Moved(Some(master)) => format!(
				"attached to another master (device {master}), such as the user's core pointer or \
				 keyboard"
			),
			Self::Moved(None) => "floating".to_owned(),
			Self::Disabled => "disabled".to_owned(),
			Self::Gone => "no longer listed by the X server".to_owned(),
		}
	}
}

/// A raw XI2 event the server reports once it has processed a slave event.
#[derive(Clone, Copy)]
enum Raw {
	ButtonPress(u8),
	ButtonRelease(u8),
	Motion,
	/// A wheel detent: raw motion on the scroll valuators (libinput) or a
	/// legacy wheel button (evdev driver).
	Wheel,
	KeyPress(u8),
	KeyRelease(u8),
}

/// Counts the server's raw key releases against the releases a run sent, in
/// order: a release that is not the next one sent is not counted, so a lost
/// key stops the count however many keys follow it.
struct ReleaseOrder<'a> {
	/// The run's steps from the next release still expected on.
	steps:   &'a [KeyStep],
	matched: usize,
}

impl<'a> ReleaseOrder<'a> {
	const fn new(steps: &'a [KeyStep]) -> Self {
		Self { steps, matched: 0 }
	}

	fn observe(&mut self, keycode: u32) {
		let Some(at) = self.steps.iter().position(|step| !step.press) else {
			return;
		};
		if u32::from(self.steps[at].keycode) == keycode {
			self.steps = &self.steps[at + 1..];
			self.matched += 1;
		}
	}

	fn done(&self) -> bool {
		self.steps.iter().all(|step| step.press)
	}
}

impl Mpx {
	pub(super) fn create() -> CoreResult<Self> {
		let (conn, screen) = x11rb::connect(None).map_err(mpx_failed)?;
		let (root, park) = {
			let info = &conn.setup().roots[screen];
			let corner = |size: u16| i16::try_from(size.saturating_sub(1)).unwrap_or(i16::MAX);
			(info.root, (corner(info.width_in_pixels), corner(info.height_in_pixels)))
		};
		let version = conn
			.xinput_xi_query_version(2, 2)
			.map_err(mpx_failed)?
			.reply()
			.map_err(mpx_failed)?;
		if (version.major_version, version.minor_version) < (2, 2) {
			return Err(DesktopError::input_failed(format!(
				"XI2-MPX needs XInput 2.2; the server offers {}.{}",
				version.major_version, version.minor_version
			)));
		}
		let atoms = Atoms::intern(&conn)?;
		let holder = atoms.mpx_holder;
		let owner = Owner::current();
		let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
		let name = owner.as_ref().map_or_else(
			|| format!("{OWNER_PREFIX}unidentified.{}.{nonce:x}", std::process::id()),
			|owner| owner.master_name(nonce),
		);
		// Prove hotplug before touching the hierarchy: a pair once added stays,
		// so a server that never binds the slave must not get one.
		let pointer_name = format!("{name} uinput pointer");
		let mut pointer = UInputDevice::pointer(&pointer_name)?;
		let pointer_slave = wait_for_slave(&conn, &pointer_name, DeviceType::SLAVE_POINTER)?;
		let (master_pointer, master_keyboard) =
			claim_pair(&conn, holder, &name, owner.as_ref(), root, park)?;
		if let Err(error) = attach(&conn, pointer_slave, master_pointer).and_then(|()| {
			select_raw(
				&conn,
				root,
				pointer_slave,
				XIEventMask::RAW_BUTTON_PRESS
					| XIEventMask::RAW_BUTTON_RELEASE
					| XIEventMask::RAW_MOTION,
			)
		}) {
			pointer.destroy();
			release_pair(&conn, holder, root, park, master_pointer, master_keyboard, &[(
				pointer_slave,
				&pointer_name,
			)]);
			return Err(error);
		}
		set_flat_acceleration(&conn, pointer_slave);
		let mpx = Self {
			conn,
			root,
			atoms,
			park,
			name,
			master_pointer,
			master_keyboard,
			pointer,
			pointer_slave,
			keyboard: None,
			uncertain: false,
			sent: false,
			#[cfg(test)]
			release_events: None,
		};
		mpx.park();
		Ok(mpx)
	}

	pub(super) fn click(
		&mut self,
		target: Window,
		(x, y): (i16, i16),
		button: MouseButton,
		count: u32,
		modifiers: Modifiers,
	) -> CoreResult<()> {
		let detail = button_detail(button);
		let count = count.max(1);
		self.gesture(target, modifiers, &[], Some(detail), true, |this| {
			this.warp(x, y)?;
			this.drain();
			let mut confirmed = true;
			for index in 0..count {
				this.check_target(target, x, y)?;
				this.button(detail, true)?;
				let mut finish = || -> CoreResult<bool> {
					let pressed = this.wait_raw(this.pointer_slave, Raw::ButtonPress(detail), 1)?;
					control::wait(PRESS_HOLD)?;
					this.button(detail, false)?;
					let released = this.wait_raw(this.pointer_slave, Raw::ButtonRelease(detail), 1)?;
					Ok(pressed && released)
				};
				// The last press is out: a cancel no longer cuts its click short.
				confirmed &= if index + 1 == count {
					control::cleanup(finish)?
				} else {
					finish()?
				};
				if index + 1 < count {
					control::wait(CLICK_GAP)?;
				}
			}
			Ok(confirmed)
		})
	}

	/// One held drag: press at `path[0]`, glide through the waypoints with
	/// real relative motion (a warp generates no motion events), pin the exact
	/// end point, release.
	pub(super) fn drag(
		&mut self,
		target: Window,
		path: &[(i16, i16)],
		button: MouseButton,
		modifiers: Modifiers,
		keys: &[KeyName],
	) -> CoreResult<()> {
		let (Some(&start), Some(&end)) = (path.first(), path.last()) else {
			return Err(DesktopError::input_failed("drag path is empty"));
		};
		let steps = relative_steps(path);
		let detail = button_detail(button);
		self.gesture(target, modifiers, keys, Some(detail), true, |this| {
			this.warp(start.0, start.1)?;
			this.drain();
			this.check_target(target, start.0, start.1)?;
			this.button(detail, true)?;
			let mut confirmed = this.wait_raw(this.pointer_slave, Raw::ButtonPress(detail), 1)?;
			control::wait(DRAG_ARM)?;
			this.drain();
			for (index, &(dx, dy)) in steps.iter().enumerate() {
				this.motion(dx, dy)?;
				control::sent_gap_wait(DRAG_STEP_DELAY, index + 1 == steps.len())?;
			}
			// Every step is out: the end and the release follow even after a
			// cancel.
			confirmed &= control::cleanup(|| -> CoreResult<bool> {
				// The end warp must not overtake a relative step still in flight.
				let moved = this.wait_raw(this.pointer_slave, Raw::Motion, steps.len())?;
				this.warp(end.0, end.1)?;
				control::wait(DRAG_RELEASE_SETTLE)?;
				this.drain();
				this.button(detail, false)?;
				let released = this.wait_raw(this.pointer_slave, Raw::ButtonRelease(detail), 1)?;
				Ok(moved && released)
			})?;
			Ok(confirmed)
		})
	}

	/// Wheel detents over `(x, y)`; `dy > 0` scrolls down and `dx > 0` right,
	/// matching X buttons 5 and 7. libinput turns the detents into the XI2
	/// smooth-scroll events GTK reads.
	pub(super) fn scroll(
		&mut self,
		target: Window,
		(x, y): (i16, i16),
		dx: f64,
		dy: f64,
	) -> CoreResult<()> {
		let detents = wheel_detents(dx, dy);
		self.gesture(target, Modifiers::default(), &[], None, true, |this| {
			this.warp(x, y)?;
			let Some((&(horizontal, value), earlier)) = detents.split_last() else {
				return Ok(true);
			};
			for &(horizontal, value) in earlier {
				this.check_target(target, x, y)?;
				this.wheel(horizontal, value)?;
				control::wait(SCROLL_DETENT_DELAY)?;
			}
			this.drain();
			this.check_target(target, x, y)?;
			this.wheel(horizontal, value)?;
			// The last detent is out: its confirmation is not cancelled.
			control::cleanup(|| this.wait_raw(this.pointer_slave, Raw::Wheel, 1))
		})
	}

	/// Hover at `(x, y)` with one real device motion event: the pointer is
	/// warped a pixel away and moved onto the point, since whether a warp
	/// reports motion varies across Xorg versions. The virtual cursor stays on
	/// the point.
	pub(super) fn hover(&mut self, target: Window, (x, y): (i16, i16)) -> CoreResult<()> {
		let step: i16 = if x > 0 { 1 } else { -1 };
		self.gesture(target, Modifiers::default(), &[], None, false, |this| {
			this.check_target(target, x - step, y)?;
			this.warp(x - step, y)?;
			this.drain();
			this.motion(i32::from(step), 0)?;
			// The motion is out: its confirmation and the final warp follow.
			control::cleanup(|| {
				let confirmed = this.wait_raw(this.pointer_slave, Raw::Motion, 1)?;
				this.warp(x, y)?;
				Ok(confirmed)
			})
		})
	}

	pub(super) fn hold_keys(
		&mut self,
		target: Window,
		keys: &[KeyName],
		duration: Duration,
	) -> CoreResult<()> {
		self.gesture(target, Modifiers::default(), keys, None, false, |_| {
			control::wait(duration)?;
			Ok(true)
		})
	}

	pub(super) fn hold_mouse(
		&mut self,
		target: Window,
		(x, y): (i16, i16),
		button: MouseButton,
		keys: &[KeyName],
		duration: Duration,
	) -> CoreResult<()> {
		let detail = button_detail(button);
		self.gesture(target, Modifiers::default(), keys, Some(detail), true, |this| {
			this.warp(x, y)?;
			this.drain();
			this.check_target(target, x, y)?;
			this.button(detail, true)?;
			let mut confirmed = this.wait_raw(this.pointer_slave, Raw::ButtonPress(detail), 1)?;
			control::wait(duration)?;
			this.drain();
			this.button(detail, false)?;
			confirmed &= this.wait_raw(this.pointer_slave, Raw::ButtonRelease(detail), 1)?;
			Ok(confirmed)
		})
	}

	pub(super) fn type_text(&mut self, target: Window, text: &str) -> CoreResult<()> {
		self.begin(false)?;
		let steps = self.keyboard_keymap()?.plan_text(text)?;
		self.deliver_keys(target, &steps)
	}

	pub(super) fn key_chord(&mut self, target: Window, keys: &[KeyName]) -> CoreResult<()> {
		self.begin(false)?;
		let steps = self.keyboard_keymap()?.plan_chord(keys)?;
		self.deliver_keys(target, &steps)
	}

	fn deliver_keys(&mut self, target: Window, steps: &[KeyStep]) -> CoreResult<()> {
		self.focus(target)?;
		let result = self.emit_keys(steps);
		if result.is_err() {
			self.uncertain = true;
		}
		self.route_held(false)?;
		result?;
		control::settle(KEY_SETTLE);
		Ok(())
	}

	/// Runs a pointer gesture with `modifiers` held on the virtual keyboard,
	/// always releasing the button and modifiers. With `park_after`, the
	/// cursor is parked only once the server confirmed every event (`body`
	/// returned `true`): parking earlier could move it before an in-flight
	/// uinput event lands, delivering that event to whatever sits under the
	/// park position.
	fn gesture(
		&mut self,
		target: Window,
		modifiers: Modifiers,
		keys: &[KeyName],
		button: Option<u8>,
		park_after: bool,
		body: impl FnOnce(&mut Self) -> CoreResult<bool>,
	) -> CoreResult<()> {
		self.begin(true)?;
		self.thaw();
		let held = self.press_keys(target, modifiers, keys)?;
		let result = body(self);
		let cancelled = control::check().is_err();
		let (released_button, released_keys) = control::cleanup(|| {
			let released_button = button.map_or(Ok(()), |button| self.pointer.button(button, false));
			let released_keys = if cancelled {
				self.release_keys_unconfirmed(&held)
			} else {
				self.release_keys(&held)
			};
			(released_button, released_keys)
		});
		let result =
			result.and_then(|confirmed| released_button.map(|()| confirmed && released_keys));
		self.uncertain = !matches!(result, Ok(true));
		// Parking warps the virtual master itself, so it stays off the user's
		// devices even when the route check below finds a slave moved.
		if park_after && matches!(result, Ok(true)) {
			self.park();
		}
		if self.sent {
			self.route_held(true)?;
		}
		match result {
			Ok(true) => Ok(()),
			Ok(false) => Err(DesktopError::input_failed(
				"the X server did not confirm virtual input or key release; delivery is uncertain, so \
				 do not retry blindly; inspect the desktop first",
			)),
			Err(error) => Err(error),
		}
	}

	fn press_keys(
		&mut self,
		target: Window,
		modifiers: Modifiers,
		keys: &[KeyName],
	) -> CoreResult<Vec<u8>> {
		if keys.is_empty() && !(modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.meta)
		{
			return Ok(Vec::new());
		}
		let keymap = self.keyboard_keymap()?;
		let mut keycodes = keymap.held_keycodes(keys)?;
		for code in keymap.modifier_keycodes(modifiers)? {
			if !keycodes.contains(&code) {
				keycodes.push(code);
			}
		}
		self.focus(target)?;
		let presses: Vec<KeyStep> = keycodes
			.iter()
			.map(|&keycode| KeyStep { keycode, press: true })
			.collect();
		// Modifiers and buttons travel through separate uinput devices, so the
		// press is only sent once the server has the modifiers down.
		if let Err(error) = self.emit_keys(&presses) {
			self.uncertain = true;
			let cancelled = control::check().is_err();
			control::cleanup(|| {
				if cancelled {
					self.release_keys_unconfirmed(&keycodes)
				} else {
					self.release_keys(&keycodes)
				}
			});
			return Err(error);
		}
		Ok(keycodes)
	}

	/// Cancellation retires the devices after cleanup, so never wait for raw
	/// events for keys that `run_steps` may already have released.
	fn release_keys_unconfirmed(&mut self, keycodes: &[u8]) -> bool {
		let Some(keyboard) = self.keyboard.as_mut() else {
			return keycodes.is_empty();
		};
		let mut released = true;
		for &keycode in keycodes.iter().rev() {
			released &= keyboard.device.key(keycode, false).is_ok();
		}
		released
	}

	fn release_keys(&mut self, keycodes: &[u8]) -> bool {
		if keycodes.is_empty() {
			return true;
		}
		let releases: Vec<KeyStep> = keycodes
			.iter()
			.rev()
			.map(|&keycode| KeyStep { keycode, press: false })
			.collect();
		self.emit_keys(&releases).is_ok()
	}

	/// Emits `steps` through the keyboard slave and waits until the server
	/// reports each release, in order, or with no release the last press.
	/// Every release is counted: when the server stalls, the kernel drops the
	/// oldest queued uinput events, and the run's last key, or an earlier
	/// transition of the same key, still arrives. Once the last press is out,
	/// a cancel no longer fails the call: the releases and the server's
	/// report follow anyway.
	fn emit_keys(&mut self, steps: &[KeyStep]) -> CoreResult<()> {
		self.drain();
		self.sent = true;
		let keyboard = self
			.keyboard
			.as_mut()
			.ok_or_else(|| DesktopError::internal("virtual keyboard used before it was attached"))?;
		let slave = keyboard.slave;
		let last_press = steps.iter().rposition(|step| step.press);
		let mut index = 0;
		keymap::run_steps(steps, |step| {
			if index > 0 {
				if last_press.is_none_or(|last| index > last) {
					control::settle(KEY_DELAY);
				} else {
					control::wait(KEY_DELAY)?;
				}
			}
			index += 1;
			keyboard.device.key(step.keycode, step.press)
		})?;
		let releases = steps.iter().filter(|step| !step.press).count();
		if releases == 0 {
			let Some(last) = steps.last() else {
				return Ok(());
			};
			return control::cleanup(|| self.wait_raw(slave, Raw::KeyPress(last.keycode), 1))?
				.ok_or_else(|| {
					DesktopError::input_failed(format!(
						"the X server did not confirm the virtual keyboard's last key within {}ms; the \
						 keys may not have been delivered",
						KEY_CONFIRM_TIMEOUT.as_millis()
					))
				});
		}
		let confirmed = control::cleanup(|| self.wait_releases(slave, steps));
		if confirmed == releases {
			return Ok(());
		}
		Err(DesktopError::input_failed(format!(
			"the X server confirmed {confirmed} of the virtual keyboard's {releases} key releases \
			 within {}ms, so keys were lost or are still on their way, and background input stays \
			 off for this session; read the target before sending more",
			KEY_CONFIRM_TIMEOUT.as_millis()
		)))
	}

	/// How many of the releases in `steps` the server reported from `device`,
	/// in order, within [`KEY_CONFIRM_TIMEOUT`].
	fn wait_releases(&self, device: u16, steps: &[KeyStep]) -> usize {
		let deadline = Instant::now() + KEY_CONFIRM_TIMEOUT;
		let mut order = ReleaseOrder::new(steps);
		while !order.done() {
			if Instant::now() >= deadline {
				break;
			}
			#[cfg(test)]
			let event = if let Some(events) = &self.release_events {
				events.borrow_mut()()
					.ok_or(x11rb::errors::ConnectionError::UnknownError)
					.map(Some)
			} else {
				self.conn.poll_for_event()
			};
			#[cfg(not(test))]
			let event = self.conn.poll_for_event();
			if Instant::now() >= deadline {
				break;
			}
			match event {
				Ok(Some(Event::XinputRawKeyRelease(raw)))
					if raw.deviceid == device || raw.sourceid == device =>
				{
					order.observe(raw.detail);
				},
				Ok(Some(_)) => {},
				Ok(None) => {
					std::thread::sleep(Duration::from_millis(2));
				},
				Err(_) => break,
			}
		}
		order.matched
	}

	/// Points the virtual keyboard's own focus at `window`; the core focus is
	/// untouched. Retried once: a freshly mapped toplevel can miss the first.
	fn focus(&self, window: Window) -> CoreResult<()> {
		for attempt in 0..2 {
			control::check()?;
			if let Ok(cookie) =
				self
					.conn
					.xinput_xi_set_focus(window, CURRENT_TIME, self.master_keyboard)
			{
				let _ = cookie.check();
			}
			let focused = self
				.conn
				.xinput_xi_get_focus(self.master_keyboard)
				.ok()
				.and_then(|cookie| cookie.reply().ok())
				.map(|reply| reply.focus);
			if focused == Some(window) {
				return Ok(());
			}
			if attempt == 0 {
				control::wait(Duration::from_millis(30))?;
			}
		}
		Err(refusal(
			self.sent,
			format_args!("window {window} cannot take the virtual keyboard focus (not viewable)"),
			DesktopError::background_unavailable,
		))
	}

	/// Takes the virtual keyboard's focus off `target`, or the window around
	/// or inside it holding that focus. Xorg sends a window core `FocusIn` only
	/// for the first keyboard to focus it, so a virtual focus left there hides
	/// a takeover's activation of `target` from the window manager. A focus on
	/// an unrelated window hides nothing and stays, as do `None` and
	/// `PointerRoot`.
	pub(super) fn release_focus(&self, target: Window) -> CoreResult<()> {
		let focused = self
			.conn
			.xinput_xi_get_focus(self.master_keyboard)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.map(|reply| reply.focus);
		let wm = Wm { conn: &self.conn, root: self.root, atoms: &self.atoms };
		// None and PointerRoot (0 and 1) are no window.
		let holds_target = focused.is_some_and(|window| {
			window > 1 && (wm.is_within(window, target) || wm.is_within(target, window))
		});
		if !holds_target {
			return Ok(());
		}
		control::check()?;
		if let Ok(cookie) = self
			.conn
			.xinput_xi_set_focus(NONE, CURRENT_TIME, self.master_keyboard)
		{
			let _ = cookie.check();
		}
		Ok(())
	}

	pub(super) const fn inhibit(&mut self) {
		self.uncertain = true;
	}

	/// Starts one call: refuses while a prior call left delivery uncertain,
	/// puts the slaves it sends through back on the pair
	/// ([`Self::restore_route`]), and clears [`Self::sent`].
	fn begin(&mut self, pointer: bool) -> CoreResult<()> {
		control::check()?;
		if self.uncertain {
			return Err(DesktopError::background_unavailable(
				"the virtual input device could not confirm isolated delivery of a prior action and \
				 cannot be retargeted; no input was sent",
			));
		}
		self.restore_route(pointer)?;
		self.sent = false;
		Ok(())
	}

	/// The slaves a call sends through: the pointer's for a pointer gesture,
	/// and the keyboard's once it exists.
	fn routes(&self, pointer: bool) -> [Option<Route>; 2] {
		#[cfg(test)]
		if self.release_events.is_some() {
			return [None, None];
		}
		[
			pointer.then_some(Route {
				slave:  self.pointer_slave,
				master: self.master_pointer,
				suffix: " uinput pointer",
				device: "pointer",
			}),
			self.keyboard.as_ref().map(|keyboard| Route {
				slave:  keyboard.slave,
				master: self.master_keyboard,
				suffix: " uinput keyboard",
				device: "keyboard",
			}),
		]
	}

	/// Where the server holds each routed slave, asked in one round trip.
	fn seats(&self, routes: &[Option<Route>; 2]) -> CoreResult<[Option<Seat>; 2]> {
		let mut cookies = [None, None];
		for (cookie, route) in cookies.iter_mut().zip(routes) {
			if let Some(route) = route {
				*cookie = Some(
					self
						.conn
						.xinput_xi_query_device(route.slave)
						.map_err(mpx_failed)?,
				);
			}
		}
		let mut seats = [None; 2];
		for ((seat, cookie), route) in seats.iter_mut().zip(cookies).zip(routes) {
			if let (Some(cookie), Some(route)) = (cookie, route) {
				// A freed id answers `BadDevice`.
				let infos = cookie.reply().map_or_default(|reply| reply.infos);
				*seat = Some(seat_of(infos.first(), &self.name, route));
			}
		}
		Ok(seats)
	}

	/// Puts the slaves a call sends through back on the pair. Xorg moves them
	/// on its own: it floats a slave it disables (every device while another
	/// VT is active, or `xinput disable`) and attaches it to the core pointer
	/// or keyboard when it enables it again, where its input reaches the
	/// user's focused window and is still confirmed. Refuses, with nothing
	/// sent, while a slave is disabled or gone or does not stay attached.
	fn restore_route(&mut self, pointer: bool) -> CoreResult<()> {
		let routes = self.routes(pointer);
		let seats = self.seats(&routes)?;
		if seats
			.iter()
			.all(|seat| matches!(seat, None | Some(Seat::Ours)))
		{
			return Ok(());
		}
		let mut keyboard_moved = false;
		for (route, seat) in routes.iter().zip(seats) {
			let (Some(route), Some(seat)) = (route, seat) else {
				continue;
			};
			let why = match seat {
				Seat::Ours => continue,
				Seat::Moved(_) => match attach(&self.conn, route.slave, route.master) {
					Ok(()) => {
						keyboard_moved |= route.master == self.master_keyboard;
						continue;
					},
					Err(error) => {
						format!("is {} and could not be re-attached ({})", seat.describe(), error.message)
					},
				},
				Seat::Disabled => "is disabled: the X server disables every input device while \
				                   another virtual terminal is active, and `xinput disable` does too"
					.to_owned(),
				Seat::Gone => format!("is {}", seat.describe()),
			};
			return Err(route_lost(route, &why));
		}
		for (route, seat) in routes.iter().zip(self.seats(&routes)?) {
			if let (Some(route), Some(seat)) = (route, seat)
				&& seat != Seat::Ours
			{
				return Err(route_lost(
					route,
					&format!("is {} again right after it was re-attached", seat.describe()),
				));
			}
		}
		if keyboard_moved && let Some(mut keyboard) = self.keyboard.take() {
			// The warm-up key would reach the last call's target, and the
			// call that follows focuses its own.
			unfocus(&self.conn, self.master_keyboard);
			let warmed = self.warm_up(&mut keyboard.device, keyboard.slave);
			self.keyboard = Some(keyboard);
			warmed?;
		}
		Ok(())
	}

	/// After a call that sent input: its events may all be confirmed, yet a
	/// slave the server moved off the pair while it ran sent the rest to the
	/// user's focused window or nowhere, which is no success.
	fn route_held(&self, pointer: bool) -> CoreResult<()> {
		let routes = self.routes(pointer);
		for (route, seat) in routes.iter().zip(self.seats(&routes)?) {
			if let (Some(route), Some(seat)) = (route, seat)
				&& seat != Seat::Ours
			{
				return Err(DesktopError::input_failed(format!(
					"omp's virtual {} left its master pair while this action ran (it is now {}), so \
					 input sent after that may have reached the user's focused window or no window; \
					 inspect the desktop before retrying",
					route.device,
					seat.describe()
				)));
			}
		}
		Ok(())
	}

	fn check_target(&self, target: Window, x: i16, y: i16) -> CoreResult<()> {
		control::check()?;
		Wm { conn: &self.conn, root: self.root, atoms: &self.atoms }
			.check_pointer_target(target, x, y, self.sent)
	}

	fn button(&mut self, detail: u8, press: bool) -> CoreResult<()> {
		self.sent = true;
		self.pointer.button(detail, press)
	}

	fn motion(&mut self, dx: i32, dy: i32) -> CoreResult<()> {
		self.sent = true;
		self.pointer.motion(dx, dy)
	}

	fn wheel(&mut self, horizontal: bool, value: i32) -> CoreResult<()> {
		self.sent = true;
		self.pointer.wheel(horizontal, value)
	}

	fn keyboard_keymap(&mut self) -> CoreResult<Keymap> {
		let slave = self.ensure_keyboard()?.slave;
		// The desktop can reconfigure a hot-plugged device between actions.
		Keymap::device(&self.conn, slave)
	}

	fn ensure_keyboard(&mut self) -> CoreResult<&mut VirtualKeyboard> {
		let keyboard = match self.keyboard.take() {
			Some(keyboard) => keyboard,
			None => self.create_keyboard()?,
		};
		Ok(self.keyboard.insert(keyboard))
	}

	fn create_keyboard(&self) -> CoreResult<VirtualKeyboard> {
		let device_name = format!("{} uinput keyboard", self.name);
		let mut device = UInputDevice::keyboard(&device_name)?;
		let slave = wait_for_slave(&self.conn, &device_name, DeviceType::SLAVE_KEYBOARD)?;
		attach(&self.conn, slave, self.master_keyboard)?;
		select_raw(
			&self.conn,
			self.root,
			slave,
			XIEventMask::RAW_KEY_PRESS | XIEventMask::RAW_KEY_RELEASE,
		)?;
		// The first events of a fresh keyboard were observed to vanish while
		// the master switches to the slave's keymap.
		self.warm_up(&mut device, slave)?;
		Ok(VirtualKeyboard { device, slave })
	}

	/// Pushes a symbol-less key through the whole pipeline of a keyboard
	/// just attached to the pair, before real text.
	fn warm_up(&self, device: &mut UInputDevice, slave: u16) -> CoreResult<()> {
		self.drain();
		let pressed = device
			.key(WARM_UP_KEYCODE, true)
			.and_then(|()| control::wait(KEY_DELAY));
		let released = control::cleanup(|| device.key(WARM_UP_KEYCODE, false));
		pressed.and(released)?;
		if !self.wait_raw(slave, Raw::KeyRelease(WARM_UP_KEYCODE), 1)? {
			return Err(DesktopError::input_failed("virtual keyboard warm-up was not confirmed"));
		}
		control::wait(WARM_UP_SETTLE)
	}

	/// Moves only the virtual master; synced so a following uinput event
	/// (a separate kernel pipeline) cannot overtake it.
	fn warp(&self, x: i16, y: i16) -> CoreResult<()> {
		control::check()?;
		warp_master(&self.conn, self.root, self.master_pointer, (x, y))
	}

	fn park(&self) {
		let _ = self.warp(self.park.0, self.park.1);
	}

	/// Releases the virtual pointer if a WM's synchronous grab left it frozen;
	/// otherwise a press would queue forever.
	fn thaw(&self) {
		if let Ok(cookie) = self.conn.xinput_xi_allow_events(
			CURRENT_TIME,
			self.master_pointer,
			EventMode::ASYNC_DEVICE,
			0,
			self.root,
		) {
			let _ = cookie.check();
		}
	}

	/// Discards queued events so a confirmation matches only new ones.
	fn drain(&self) {
		while let Ok(Some(_)) = self.conn.poll_for_event() {}
	}

	/// Waits until the server has reported `count` raw events of `kind` from
	/// `device`, i.e. processed the matching uinput events.
	fn wait_raw(&self, device: u16, kind: Raw, count: usize) -> CoreResult<bool> {
		let timeout = match kind {
			Raw::KeyPress(_) | Raw::KeyRelease(_) => KEY_CONFIRM_TIMEOUT,
			_ => POINTER_CONFIRM_TIMEOUT,
		};
		let deadline = Instant::now() + timeout;
		let mut seen = 0;
		while seen < count {
			control::check()?;
			if Instant::now() >= deadline {
				return Ok(false);
			}
			match self.conn.poll_for_event() {
				Ok(Some(event)) => {
					if raw_matches(&event, device, kind) {
						seen += 1;
					}
				},
				Ok(None) => {
					if Instant::now() >= deadline {
						return Ok(false);
					}
					control::wait(Duration::from_millis(2))?;
				},
				Err(_) => return Ok(false),
			}
		}
		Ok(true)
	}
}

impl Drop for Mpx {
	fn drop(&mut self) {
		// A cancelled or timed-out call can leave events of the slaves in flight;
		// park and free the pair only once the server has dropped them, so a late
		// motion or release never lands at the park corner or under the next
		// holder.
		let pointer_name = format!("{} uinput pointer", self.name);
		let keyboard_name = format!("{} uinput keyboard", self.name);
		let mut slaves = vec![(self.pointer_slave, pointer_name.as_str())];
		if let Some(mut keyboard) = self.keyboard.take() {
			keyboard.device.destroy();
			slaves.push((keyboard.slave, keyboard_name.as_str()));
		}
		self.pointer.destroy();
		release_pair(
			&self.conn,
			self.atoms.mpx_holder,
			self.root,
			self.park,
			self.master_pointer,
			self.master_keyboard,
			&slaves,
		);
	}
}

fn mpx_failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("XI2-MPX request failed: {error}"))
}

fn raw_matches(event: &Event, device: u16, kind: Raw) -> bool {
	let (raw, matches) = match (event, kind) {
		(Event::XinputRawButtonPress(raw), Raw::ButtonPress(button))
		| (Event::XinputRawButtonRelease(raw), Raw::ButtonRelease(button)) => {
			(raw, raw.detail == u32::from(button))
		},
		(Event::XinputRawMotion(raw), Raw::Motion | Raw::Wheel) => (raw, true),
		(Event::XinputRawButtonPress(raw), Raw::Wheel) => (raw, (4..=7).contains(&raw.detail)),
		(Event::XinputRawKeyPress(raw), Raw::KeyPress(keycode))
		| (Event::XinputRawKeyRelease(raw), Raw::KeyRelease(keycode)) => {
			return (raw.deviceid == device || raw.sourceid == device)
				&& raw.detail == u32::from(keycode);
		},
		_ => return false,
	};
	matches && (raw.deviceid == device || raw.sourceid == device)
}

/// Relative motion deltas that walk `path` from its first point, splitting
/// each segment into steps of about [`DRAG_STEP_MAX_PX`]. Deltas are taken
/// between rounded absolute points, so they sum exactly to the path's end.
fn relative_steps(path: &[(i16, i16)]) -> Vec<(i32, i32)> {
	let mut steps = Vec::new();
	let Some(&(start_x, start_y)) = path.first() else {
		return steps;
	};
	let (mut last_x, mut last_y) = (i32::from(start_x), i32::from(start_y));
	for &[(from_x, from_y), (to_x, to_y)] in path.array_windows() {
		let (from_x, from_y) = (f64::from(from_x), f64::from(from_y));
		let (to_x, to_y) = (f64::from(to_x), f64::from(to_y));
		let length = (to_x - from_x).hypot(to_y - from_y);
		let count = (length / DRAG_STEP_MAX_PX).ceil().max(1.0) as u32;
		for index in 1..=count {
			let t = f64::from(index) / f64::from(count);
			let x = (to_x - from_x).mul_add(t, from_x).round() as i32;
			let y = (to_y - from_y).mul_add(t, from_y).round() as i32;
			if (x, y) != (last_x, last_y) {
				steps.push((x - last_x, y - last_y));
				(last_x, last_y) = (x, y);
			}
		}
	}
	steps
}

/// One `(horizontal, evdev value)` per wheel detent. evdev `REL_WHEEL` is
/// positive up and `REL_HWHEEL` positive right.
fn wheel_detents(dx: f64, dy: f64) -> Vec<(bool, i32)> {
	let vertical = dy.abs().round() as usize;
	let horizontal = dx.abs().round() as usize;
	let mut detents = Vec::with_capacity(vertical + horizontal);
	detents.extend(std::iter::repeat_n((false, if dy > 0.0 { -1 } else { 1 }), vertical));
	detents.extend(std::iter::repeat_n((true, if dx > 0.0 { 1 } else { -1 }), horizontal));
	detents
}

fn hierarchy_len(payload_bytes: usize) -> u16 {
	u16::try_from((4 + payload_bytes).div_ceil(4)).unwrap_or(u16::MAX)
}

fn query_devices(conn: &RustConnection) -> CoreResult<Vec<XIDeviceInfo>> {
	Ok(conn
		.xinput_xi_query_device(Device::ALL)
		.map_err(mpx_failed)?
		.reply()
		.map_err(mpx_failed)?
		.infos)
}

fn add_master(conn: &RustConnection, name: &str) -> CoreResult<()> {
	let change = HierarchyChange {
		len:  hierarchy_len(4 + name.len()),
		data: HierarchyChangeData::AddMaster(HierarchyChangeDataAddMaster {
			// Core events make core-protocol WMs activate and raise the target.
			// Legacy clients must use semantic actions, synthetic delivery where
			// supported, or explicit takeover instead.
			send_core: false,
			enable:    true,
			name:      name.as_bytes().to_vec(),
		}),
	};
	conn
		.xinput_xi_change_hierarchy(&[change])
		.map_err(mpx_failed)?
		.check()
		.map_err(mpx_failed)
}

fn find_masters(conn: &RustConnection, name: &str) -> CoreResult<(u16, u16)> {
	let devices = query_devices(conn)?;
	let find = |suffix: &str, type_: DeviceType| {
		let wanted = format!("{name} {suffix}");
		devices
			.iter()
			.find(|info| info.type_ == type_ && info.name == wanted.as_bytes())
			.map(|info| info.deviceid)
	};
	match (
		find("pointer", DeviceType::MASTER_POINTER),
		find("keyboard", DeviceType::MASTER_KEYBOARD),
	) {
		(Some(pointer), Some(keyboard)) => Ok((pointer, keyboard)),
		_ => Err(DesktopError::input_failed("XIChangeHierarchy did not create the MPX master pair")),
	}
}

/// Polls until the server hot-added the uinput device `name` as a slave
/// (attached to the core master, or floating).
fn wait_for_slave(conn: &RustConnection, name: &str, type_: DeviceType) -> CoreResult<u16> {
	let deadline = Instant::now() + SLAVE_BIND_TIMEOUT;
	loop {
		control::check()?;
		if let Some(id) = query_devices(conn)?
			.iter()
			.find(|info| {
				info.name == name.as_bytes()
					&& (info.type_ == type_ || info.type_ == DeviceType::FLOATING_SLAVE)
			})
			.map(|info| info.deviceid)
		{
			return Ok(id);
		}
		if Instant::now() >= deadline {
			return Err(DesktopError::input_failed(format!(
				"uinput device '{name}' never became an X input slave (no udev/libinput hotplug on \
				 this server)"
			)));
		}
		control::wait(Duration::from_millis(50))?;
	}
}

fn attach(conn: &RustConnection, slave: u16, master: u16) -> CoreResult<()> {
	let change = HierarchyChange {
		len:  2,
		data: HierarchyChangeData::AttachSlave(HierarchyChangeDataAttachSlave {
			deviceid: slave,
			master,
		}),
	};
	conn
		.xinput_xi_change_hierarchy(&[change])
		.map_err(mpx_failed)?
		.check()
		.map_err(mpx_failed)
}

/// Where `info`, the server's answer for `route`'s slave id, holds it; the
/// slaves are named after `session`. A device of another name under that id
/// is a later device the freed id went to.
fn seat_of(info: Option<&XIDeviceInfo>, session: &str, route: &Route) -> Seat {
	let Some(info) = info.filter(|info| {
		info.deviceid == route.slave
			&& info.name.strip_prefix(session.as_bytes()) == Some(route.suffix.as_bytes())
	}) else {
		return Seat::Gone;
	};
	if !info.enabled {
		Seat::Disabled
	} else if info.type_ == DeviceType::FLOATING_SLAVE {
		Seat::Moved(None)
	} else if info.attachment == route.master {
		Seat::Ours
	} else {
		Seat::Moved(Some(info.attachment))
	}
}

fn route_lost(route: &Route, why: &str) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"the background input route is lost: omp's virtual {} {why}; no input was sent",
		route.device
	))
}

fn select_raw(
	conn: &RustConnection,
	root: Window,
	device: u16,
	mask: XIEventMask,
) -> CoreResult<()> {
	conn
		.xinput_xi_select_events(root, &[xinput::EventMask {
			deviceid: device,
			mask:     vec![mask],
		}])
		.map_err(mpx_failed)?
		.check()
		.map_err(mpx_failed)
}

/// Pins libinput's pointer acceleration to flat at speed 0, so relative drag
/// steps map 1:1 onto cursor movement. Best effort: the properties exist
/// only under xf86-input-libinput; the drag pins its end point regardless.
fn set_flat_acceleration(conn: &RustConnection, slave: u16) {
	let atom = |name: &str| {
		conn
			.intern_atom(true, name.as_bytes())
			.ok()?
			.reply()
			.ok()
			.map(|reply| reply.atom)
			.filter(|&atom| atom != NONE)
	};
	if let Some(profile) = atom("libinput Accel Profile Enabled")
		&& let Some(reply) = conn
			.xinput_xi_get_property(slave, false, profile, AtomEnum::ANY.into(), 0, 16)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
		&& let XIGetPropertyItems::Data8(values) = &reply.items
		&& (2..=8).contains(&values.len())
	{
		// Profile order is (adaptive, flat[, custom]).
		let mut flat = vec![0u8; values.len()];
		flat[1] = 1;
		if let Ok(cookie) = conn.xinput_xi_change_property(
			slave,
			PropMode::REPLACE,
			profile,
			reply.type_,
			flat.len() as u32,
			&XIChangePropertyAux::Data8(flat),
		) {
			let _ = cookie.check();
		}
	}
	if let Some(speed) = atom("libinput Accel Speed")
		&& let Some(reply) = conn
			.xinput_xi_get_property(slave, false, speed, AtomEnum::ANY.into(), 0, 1)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
		&& matches!(&reply.items, XIGetPropertyItems::Data32(values) if values.len() == 1)
		&& let Ok(cookie) = conn.xinput_xi_change_property(
			slave,
			PropMode::REPLACE,
			speed,
			reply.type_,
			1,
			&XIChangePropertyAux::Data32(vec![0.0f32.to_bits()]),
		) {
		let _ = cookie.check();
	}
}

/// Takes a master pair for the session named `name`: one no live session
/// holds, else a new one. Runs under a server grab, so two sessions never
/// take the same pair. The other pairs of killed holders are parked, unfocused
/// and freed on the way, since their cursor and focus stay where they died.
fn claim_pair(
	conn: &RustConnection,
	holder: Atom,
	name: &str,
	owner: Option<&Owner>,
	root: Window,
	park: (i16, i16),
) -> CoreResult<(u16, u16)> {
	struct Grab<'a>(&'a RustConnection);
	impl Drop for Grab<'_> {
		fn drop(&mut self) {
			if let Ok(cookie) = self.0.ungrab_server() {
				let _ = cookie.check();
			}
		}
	}
	conn
		.grab_server()
		.map_err(mpx_failed)?
		.check()
		.map_err(mpx_failed)?;
	let _grab = Grab(conn);
	let xtest = conn
		.intern_atom(true, b"XTEST Device")
		.map_err(mpx_failed)?
		.reply()
		.map_err(mpx_failed)?
		.atom;
	let mut taken = None;
	let mut pairs = 0;
	let devices = query_devices(conn)?;
	for info in devices
		.iter()
		.filter(|info| info.type_ == DeviceType::MASTER_POINTER)
	{
		let Ok(pointer) = std::str::from_utf8(&info.name) else {
			continue;
		};
		// `v1.` pairs belong to older omp releases, which may still remove them:
		// never taken, and not counted, or two left by killed old processes
		// would use up the cap until the X server exits.
		if !pointer.starts_with(OWNER_PREFIX) {
			continue;
		}
		pairs += 1;
		let value = read_holder(conn, holder, info.deviceid);
		if !is_claimable(value.as_deref(), pointer, owner, process_start) {
			continue;
		}
		if devices.iter().any(|slave| {
			[info.deviceid, info.attachment].contains(&slave.attachment)
				&& matches!(slave.type_, DeviceType::SLAVE_POINTER | DeviceType::SLAVE_KEYBOARD)
				&& !is_xtest_slave(conn, xtest, slave.deviceid)
		}) {
			// A dead holder's focus must not linger while its slaves unplug,
			// even though that pair is not safe for the next holder yet.
			if value.as_deref() != Some(HOLDER_FREE) {
				unfocus(conn, info.attachment);
			}
			continue;
		}
		if taken.is_none() {
			taken = Some((info.deviceid, info.attachment));
		} else if value.as_deref() != Some(HOLDER_FREE) {
			release_pair(conn, holder, root, park, info.deviceid, info.attachment, &[]);
		}
	}
	let pair = if let Some(pair) = taken {
		unfocus(conn, pair.1);
		pair
	} else {
		if pairs >= MAX_PAIRS {
			return Err(DesktopError::input_busy(format!(
				"XI2-MPX pair limit ({MAX_PAIRS}) reached; no reusable pair is free"
			)));
		}
		add_master(conn, name)?;
		find_masters(conn, name)?
	};
	// Locks and sticky-key latches belong to the previous holder, not this
	// session. Address the pair's keyboard explicitly, never the core one.
	if !conn
		.xkb_use_extension(1, 0)
		.map_err(mpx_failed)?
		.reply()
		.map_err(mpx_failed)?
		.supported
	{
		return Err(mpx_failed("XKB 1.0 is unavailable"));
	}
	conn
		.xkb_latch_lock_state(
			pair.1,
			255u8.into(),
			ModMask::default(),
			true,
			xkb::Group::M1,
			255u8.into(),
			true,
			0,
		)
		.map_err(mpx_failed)?
		.check()
		.map_err(mpx_failed)?;
	write_holder(conn, holder, pair.0, name.as_bytes())?;
	Ok(pair)
}

/// The server marks its XTEST slaves with a read-only property; names do not
/// distinguish another application's devices from ours.
fn is_xtest_slave(conn: &RustConnection, xtest: Atom, slave: u16) -> bool {
	if xtest == NONE {
		return false;
	}
	conn
		.xinput_xi_get_property(slave, false, xtest, AtomEnum::INTEGER.into(), 0, 1)
		.ok()
		.and_then(|cookie| cookie.reply().ok())
		.is_some_and(|reply| matches!(reply.items, XIGetPropertyItems::Data8(value) if value == [1]))
}

/// Hands a pair back: its cursor parked, its keyboard focusing nothing, free
/// for the next session. Removing it instead would crash Qt 6.5+ clients
/// (module docs).
fn release_pair(
	conn: &RustConnection,
	holder: Atom,
	root: Window,
	park: (i16, i16),
	master_pointer: u16,
	master_keyboard: u16,
	slaves: &[(u16, &str)],
) {
	if !wait_unplugged(conn, slaves) {
		// A timed-out teardown must never be reclaimed, even after its holder
		// dies.
		unfocus(conn, master_keyboard);
		let _ = write_holder(conn, holder, master_pointer, b"unplug-timeout");
		return;
	}
	let _ = warp_master(conn, root, master_pointer, park);
	unfocus(conn, master_keyboard);
	let _ = write_holder(conn, holder, master_pointer, HOLDER_FREE);
	let _ = conn.flush();
}

fn unfocus(conn: &RustConnection, master_keyboard: u16) {
	if let Ok(cookie) = conn.xinput_xi_set_focus(NONE, CURRENT_TIME, master_keyboard) {
		let _ = cookie.check();
	}
}

fn warp_master(
	conn: &RustConnection,
	root: Window,
	master_pointer: u16,
	(x, y): (i16, i16),
) -> CoreResult<()> {
	conn
		.xinput_xi_warp_pointer(
			NONE,
			root,
			0,
			0,
			0,
			0,
			i32::from(x) << 16,
			i32::from(y) << 16,
			master_pointer,
		)
		.map_err(mpx_failed)?
		.check()
		.map_err(mpx_failed)
}

/// Waits, bounded, until the server no longer lists `slaves`: kernel hot-unplug
/// is asynchronous, and events written before it may still be delivered. A
/// slave is the device listed under both its id and its name: the server
/// gives a freed id to the next device plugged in.
fn wait_unplugged(conn: &RustConnection, slaves: &[(u16, &str)]) -> bool {
	let deadline = Instant::now() + UNPLUG_TIMEOUT;
	loop {
		let Ok(devices) = query_devices(conn) else {
			return false;
		};
		if !devices.iter().any(|info| {
			slaves
				.iter()
				.any(|&(id, name)| info.deviceid == id && info.name == name.as_bytes())
		}) {
			return true;
		}
		if Instant::now() >= deadline {
			return false;
		}
		std::thread::sleep(Duration::from_millis(20));
	}
}

/// The holder property of a master pointer; `None` when it has none.
fn read_holder(conn: &RustConnection, holder: Atom, master_pointer: u16) -> Option<Vec<u8>> {
	let reply = conn
		.xinput_xi_get_property(master_pointer, false, holder, AtomEnum::ANY.into(), 0, 64)
		.ok()?
		.reply()
		.ok()?;
	match reply.items {
		XIGetPropertyItems::Data8(value) if reply.type_ != NONE => Some(value),
		_ => None,
	}
}

fn write_holder(
	conn: &RustConnection,
	holder: Atom,
	master_pointer: u16,
	value: &[u8],
) -> CoreResult<()> {
	conn
		.xinput_xi_change_property(
			master_pointer,
			PropMode::REPLACE,
			holder,
			AtomEnum::STRING.into(),
			value.len() as u32,
			&XIChangePropertyAux::Data8(value.to_vec()),
		)
		.map_err(mpx_failed)?
		.check()
		.map_err(mpx_failed)
}

/// Whether a session of `current` may take a v2 pair. Older omp releases can
/// remove v1 masters even while held, so those pairs are never adopted.
/// Holders whose death cannot be proven keep their pair.
fn is_claimable(
	holder: Option<&[u8]>,
	pointer: &str,
	current: Option<&Owner>,
	start_of: impl FnOnce(u32) -> io::Result<u64>,
) -> bool {
	if !pointer.starts_with(OWNER_PREFIX) {
		return false;
	}
	let holder = match holder {
		Some(value) if value == HOLDER_FREE => return true,
		Some(value) => std::str::from_utf8(value).ok().and_then(Owner::from_name),
		None => Owner::from_pointer_name(pointer),
	};
	holder
		.zip(current)
		.is_some_and(|(holder, current)| holder.is_stale_for(current, start_of))
}

/// Process incarnation encoded in a master's name: an identity domain (boot,
/// PID namespace, user) plus PID and start time, so PID reuse and foreign
/// machines or namespaces sharing the X server are told apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Owner {
	domain: u64,
	pid:    u32,
	start:  u64,
}

impl Owner {
	/// `None` when procfs cannot identify this process (a foreign PID
	/// namespace): such masters use a name recovery never matches.
	fn current() -> Option<Self> {
		let pid = std::process::id();
		let stat = fs::read_to_string("/proc/self/stat").ok()?;
		if stat.split_whitespace().next()?.parse::<u32>().ok()? != pid {
			return None;
		}
		let start = start_ticks(&stat)?;
		if process_start(pid).ok()? != start {
			return None;
		}
		let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
		let namespace = fs::read_link("/proc/self/ns/pid").ok()?;
		// SAFETY: geteuid has no preconditions and cannot fail.
		let euid = unsafe { libc::geteuid() };
		let mut seed = Vec::with_capacity(96);
		seed.extend_from_slice(boot.trim().as_bytes());
		seed.push(0);
		seed.extend_from_slice(namespace.as_os_str().as_encoded_bytes());
		seed.push(0);
		seed.extend_from_slice(&euid.to_be_bytes());
		Some(Self { domain: xxhash_rust::xxh64::xxh64(&seed, 0), pid, start })
	}

	fn master_name(&self, nonce: u16) -> String {
		format!("{OWNER_PREFIX}{:016x}.{:x}.{:x}.{nonce:x}", self.domain, self.pid, self.start)
	}

	/// The owner a session or master name (`master_name`) encodes.
	fn from_name(name: &str) -> Option<Self> {
		let mut parts = name.strip_prefix(OWNER_PREFIX)?.split('.');
		let domain = u64::from_str_radix(parts.next()?, 16).ok()?;
		let pid = u32::from_str_radix(parts.next()?, 16).ok()?;
		let start = u64::from_str_radix(parts.next()?, 16).ok()?;
		let _nonce = u16::from_str_radix(parts.next()?, 16).ok()?;
		(parts.next().is_none() && pid != 0).then_some(Self { domain, pid, start })
	}

	fn from_pointer_name(name: &str) -> Option<Self> {
		Self::from_name(name.strip_suffix(" pointer")?)
	}

	/// Whether this master's owner is provably gone. Foreign domains and
	/// unreadable processes are kept: their liveness cannot be proven.
	fn is_stale_for(&self, current: &Self, start_of: impl FnOnce(u32) -> io::Result<u64>) -> bool {
		if self.domain != current.domain {
			return false;
		}
		if self.pid == current.pid {
			return self.start != current.start;
		}
		match start_of(self.pid) {
			Ok(start) => start != self.start,
			Err(error) => error.kind() == io::ErrorKind::NotFound,
		}
	}
}

/// Fields of a `/proc/<pid>/stat` line from `state` (field 3) on; the command
/// name before them may contain spaces and parentheses.
fn stat_fields(stat: &str) -> Option<std::str::SplitWhitespace<'_>> {
	Some(stat.rsplit_once(')')?.1.split_whitespace())
}

/// `starttime` (field 22) of a `/proc/<pid>/stat` line.
fn start_ticks(stat: &str) -> Option<u64> {
	stat_fields(stat)?.nth(19)?.parse().ok()
}

/// Start time of process `pid`. A zombie counts as gone: it owns nothing
/// anymore, and one its parent never reaps would pin its masters forever.
fn process_start(pid: u32) -> io::Result<u64> {
	let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
	if matches!(stat_fields(&stat).and_then(|mut fields| fields.next()), Some("Z" | "X")) {
		return Err(io::ErrorKind::NotFound.into());
	}
	start_ticks(&stat)
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed /proc stat"))
}

#[cfg(test)]
mod tests {
	use x11rb::protocol::{
		xinput::{HierarchyChangeDataDetachSlave, HierarchyMask},
		xproto::{
			ChangeWindowAttributesAux, CreateWindowAux, EventMask as CoreEventMask, InputFocus,
			WindowClass,
		},
	};

	use super::*;

	const OWNER: Owner = Owner { domain: 0xfeed_beef, pid: 4242, start: 777 };

	#[test]
	fn owner_name_round_trips_at_integer_limits() {
		let owner = Owner { domain: u64::MAX, pid: u32::MAX, start: u64::MAX };
		let pointer = format!("{} pointer", owner.master_name(u16::MAX));
		assert_eq!(Owner::from_pointer_name(&pointer), Some(owner));
		assert!(format!("{} uinput keyboard", owner.master_name(u16::MAX)).len() < 80);
		assert_eq!(Owner::from_pointer_name("OMP MPX 4242.1 pointer"), None);
		// omp versions that removed pairs reap dead creators' `v1.` masters.
		assert!(!pointer.starts_with("OMP MPX v1."), "new pairs stay out of that reaper");
		let legacy = pointer.replacen(OWNER_PREFIX, "OMP MPX v1.", 1);
		assert_eq!(Owner::from_pointer_name(&legacy), None, "v1 pairs are never adopted");
	}

	#[test]
	fn only_provably_dead_owners_are_stale() {
		let peer = |pid, start| Owner { pid, start, ..OWNER };
		let gone = |_| Err(io::Error::from(io::ErrorKind::NotFound));
		let denied = |_| Err(io::Error::from(io::ErrorKind::PermissionDenied));
		assert!(peer(99, 5).is_stale_for(&OWNER, gone));
		assert!(peer(99, 5).is_stale_for(&OWNER, |_| Ok(6)), "reused pid");
		assert!(!peer(99, 5).is_stale_for(&OWNER, |_| Ok(5)), "live peer session");
		assert!(!peer(99, 5).is_stale_for(&OWNER, denied), "unverifiable");
		assert!(!OWNER.is_stale_for(&OWNER, gone), "this process");
		assert!(peer(OWNER.pid, 1).is_stale_for(&OWNER, gone), "earlier incarnation of our pid");
		let foreign = Owner { domain: 1, ..peer(99, 5) };
		assert!(!foreign.is_stale_for(&OWNER, gone), "other machine or namespace");
	}

	#[test]
	fn a_pair_is_taken_only_when_free_or_its_holder_is_provably_gone() {
		let gone = |_| Err(io::Error::from(io::ErrorKind::NotFound));
		let live = |_| Ok(5);
		let only_peer_lives = |pid| {
			if pid == 99 {
				Ok(5)
			} else {
				Err(io::ErrorKind::NotFound.into())
			}
		};
		let peer = Owner { pid: 99, start: 5, ..OWNER }.master_name(1);
		let creator = format!("{} pointer", Owner { pid: 98, start: 5, ..OWNER }.master_name(1));
		assert!(is_claimable(Some(HOLDER_FREE), &creator, Some(&OWNER), live), "released");
		assert!(
			!is_claimable(Some(peer.as_bytes()), &creator, Some(&OWNER), only_peer_lives),
			"the holder, not the dead creator, decides"
		);
		assert!(is_claimable(Some(peer.as_bytes()), &creator, Some(&OWNER), gone), "dead holder");
		assert!(
			!is_claimable(Some(b"OMP MPX 7.1"), &creator, Some(&OWNER), gone),
			"unidentifiable holder"
		);
		assert!(!is_claimable(Some(peer.as_bytes()), &creator, None, gone), "we cannot prove death");
		// An older omp can remove v1 masters even while a new session holds them.
		let legacy = creator.replacen(OWNER_PREFIX, "OMP MPX v1.", 1);
		assert!(!is_claimable(None, &legacy, Some(&OWNER), gone), "dead v1 creator");
		assert!(!is_claimable(Some(HOLDER_FREE), &legacy, Some(&OWNER), gone), "free v1 pair");
		assert!(!is_claimable(None, &legacy, Some(&OWNER), live), "live v1 creator");
	}

	/// The server `DISPLAY` names: connection, root and park corner.
	fn display() -> (RustConnection, Window, (i16, i16)) {
		let (conn, screen) = x11rb::connect(None).unwrap();
		let info = &conn.setup().roots[screen];
		let corner = |size: u16| i16::try_from(size - 1).unwrap();
		let (root, park) = (info.root, (corner(info.width_in_pixels), corner(info.height_in_pixels)));
		conn.xinput_xi_query_version(2, 2).unwrap().reply().unwrap();
		(conn, root, park)
	}

	#[test]
	#[ignore = "needs an isolated X server"]
	fn the_pair_pool_refuses_growth_at_its_limit_but_reuses_a_released_pair() {
		let (conn, root, park) = display();
		// Killed older omp processes can leave pairs that they may still reap.
		// They must neither be adopted nor consume the new pool's slots.
		for name in ["OMP MPX v1.pool-test-1", "OMP MPX v1.pool-test-2"] {
			if find_masters(&conn, name).is_err() {
				add_master(&conn, name).unwrap();
			}
		}
		let holder = conn
			.intern_atom(false, HOLDER_PROPERTY.as_bytes())
			.unwrap()
			.reply()
			.unwrap()
			.atom;
		let owner = Owner::current().unwrap();
		let mut pairs = Vec::new();
		for nonce in 1..=2 {
			pairs.push(
				claim_pair(&conn, holder, &owner.master_name(nonce), Some(&owner), root, park).unwrap(),
			);
		}
		let before = query_devices(&conn).unwrap().len();
		let refused = claim_pair(&conn, holder, &owner.master_name(3), Some(&owner), root, park);
		assert_eq!(refused.unwrap_err().code, crate::desktop::error::ErrorCode::InputBusy);
		assert_eq!(query_devices(&conn).unwrap().len(), before, "refusal adds no devices");
		let pair = pairs[0];
		release_pair(&conn, holder, root, park, pair.0, pair.1, &[]);
		let xtest = conn
			.intern_atom(true, b"XTEST Device")
			.unwrap()
			.reply()
			.unwrap()
			.atom;
		let foreign = query_devices(&conn)
			.unwrap()
			.into_iter()
			.find(|info| {
				info.type_ == DeviceType::SLAVE_KEYBOARD && !is_xtest_slave(&conn, xtest, info.deviceid)
			})
			.expect("the isolated server has a non-XTEST keyboard");
		attach(&conn, foreign.deviceid, pair.1).unwrap();
		assert!(
			claim_pair(&conn, holder, &owner.master_name(4), Some(&owner), root, park).is_err(),
			"a released pair carrying someone else's keyboard is not safe to retarget"
		);
		attach(&conn, foreign.deviceid, foreign.attachment).unwrap();
		assert_eq!(
			claim_pair(&conn, holder, &owner.master_name(4), Some(&owner), root, park).unwrap(),
			pair,
			"a free pair remains usable at the cap"
		);
		for (pointer, keyboard) in pairs {
			release_pair(&conn, holder, root, park, pointer, keyboard, &[]);
		}
	}

	#[test]
	#[ignore = "needs an isolated X server"]
	fn a_teardown_timeout_does_not_publish_a_reusable_pair() {
		let (conn, root, park) = display();
		let holder = conn
			.intern_atom(false, HOLDER_PROPERTY.as_bytes())
			.unwrap()
			.reply()
			.unwrap()
			.atom;
		let owner = Owner::current().unwrap();
		let pair =
			claim_pair(&conn, holder, &owner.master_name(1), Some(&owner), root, park).unwrap();
		// An XTEST slave stays present until X exits, modeling delayed
		// hot-unplug.
		let slave = query_devices(&conn)
			.unwrap()
			.into_iter()
			.find(|info| info.type_ == DeviceType::SLAVE_POINTER && info.attachment == pair.0)
			.unwrap();
		let slave_name = String::from_utf8(slave.name.clone()).unwrap();
		assert!(
			wait_unplugged(&conn, &[(slave.deviceid, "a device that previously used this id")]),
			"a replacement with the same id is not the unplugged slave"
		);
		conn
			.xinput_xi_set_focus(root, CURRENT_TIME, pair.1)
			.unwrap()
			.check()
			.unwrap();
		release_pair(&conn, holder, root, park, pair.0, pair.1, &[(slave.deviceid, &slave_name)]);
		assert_eq!(
			conn
				.xinput_xi_get_focus(pair.1)
				.unwrap()
				.reply()
				.unwrap()
				.focus,
			NONE,
			"a retired pair must not retain its target's virtual focus"
		);
		let value = read_holder(&conn, holder, pair.0).unwrap();
		assert!(
			!is_claimable(
				Some(&value),
				&format!("{} pointer", owner.master_name(1)),
				Some(&owner),
				|_| Err(io::ErrorKind::NotFound.into())
			),
			"the pair stays unavailable even after its holder dies"
		);
		// The XTEST slave belongs to this disposable fixture, not a real
		// unplugging device; restore the slot for the other live tests.
		release_pair(&conn, holder, root, park, pair.0, pair.1, &[]);
	}

	/// Removing a master crashes running Qt 6.5+ clients, so a session hands
	/// its pair to the next one instead, its slaves gone first. Needs Xorg
	/// with uinput hotplug and a writable `/dev/uinput`; run with `--ignored`.
	#[test]
	#[ignore = "needs Xorg with uinput hotplug"]
	fn a_session_hands_its_pair_to_the_next_without_removing_it() {
		let (conn, ..) = display();
		let devices = || -> Vec<u16> {
			query_devices(&conn)
				.unwrap()
				.iter()
				.map(|info| info.deviceid)
				.collect()
		};
		let first = Mpx::create().unwrap();
		let (pair, slave) = (first.master_pointer, first.pointer_slave);
		assert!(
			conn
				.xkb_use_extension(1, 0)
				.unwrap()
				.reply()
				.unwrap()
				.supported
		);
		let core_before = conn
			.xkb_get_state(xkb::ID::USE_CORE_KBD.into())
			.unwrap()
			.reply()
			.unwrap();
		conn
			.xkb_latch_lock_state(
				first.master_keyboard,
				255u8.into(),
				ModMask::LOCK,
				true,
				xkb::Group::M1,
				255u8.into(),
				true,
				0,
			)
			.unwrap()
			.check()
			.unwrap();
		let locked = conn
			.xkb_get_state(first.master_keyboard)
			.unwrap()
			.reply()
			.unwrap();
		assert_eq!(locked.locked_mods, ModMask::LOCK);
		drop(first);
		let after = devices();
		assert!(after.contains(&pair), "the pair outlives its session");
		assert!(!after.contains(&slave), "its slave is gone before the pair is free");
		let second = Mpx::create().unwrap();
		assert_eq!(second.master_pointer, pair, "the next session takes the free pair");
		let state = conn
			.xkb_get_state(second.master_keyboard)
			.unwrap()
			.reply()
			.unwrap();
		assert_eq!(state.locked_mods, ModMask::default());
		assert_eq!(state.latched_mods, ModMask::default());
		let core_after = conn
			.xkb_get_state(xkb::ID::USE_CORE_KBD.into())
			.unwrap()
			.reply()
			.unwrap();
		assert_eq!(core_after.locked_mods, core_before.locked_mods, "core keyboard is untouched");
		assert_eq!(core_after.latched_mods, core_before.latched_mods, "core latches are untouched");
	}

	/// Pairs whose holders were killed get parked and freed by the next claim,
	/// whichever one it takes. Fixture pairs are reused on subsequent runs.
	#[test]
	#[ignore = "needs an isolated X server"]
	fn a_killed_holders_pair_is_parked_and_freed() {
		let (conn, root, park) = display();
		let holder = conn
			.intern_atom(false, HOLDER_PROPERTY.as_bytes())
			.unwrap()
			.reply()
			.unwrap()
			.atom;
		let owner = Owner::current().unwrap();
		let dead = Owner { pid: u32::MAX - 1, start: u64::from(std::process::id()), ..owner };
		let pairs: Vec<(u16, u16)> = (1..=2)
			.map(|nonce| {
				claim_pair(&conn, holder, &owner.master_name(nonce), Some(&owner), root, park).unwrap()
			})
			.collect();
		for &(pointer, _) in &pairs {
			write_holder(&conn, holder, pointer, dead.master_name(1).as_bytes()).unwrap();
			warp_master(&conn, root, pointer, (100, 100)).unwrap();
		}
		// Model a killed holder whose uinput slave has not disappeared yet.
		let xtest = conn
			.intern_atom(true, b"XTEST Device")
			.unwrap()
			.reply()
			.unwrap()
			.atom;
		let slave = query_devices(&conn)
			.unwrap()
			.into_iter()
			.find(|info| {
				info.type_ == DeviceType::SLAVE_KEYBOARD && !is_xtest_slave(&conn, xtest, info.deviceid)
			})
			.expect("the isolated server has a non-XTEST keyboard");
		attach(&conn, slave.deviceid, pairs[0].1).unwrap();
		conn
			.xinput_xi_set_focus(root, CURRENT_TIME, pairs[0].1)
			.unwrap()
			.check()
			.unwrap();
		let other =
			claim_pair(&conn, holder, &owner.master_name(3), Some(&owner), root, park).unwrap();
		assert_eq!(other, pairs[1], "the lingering slave still prevents reuse");
		let focus = conn
			.xinput_xi_get_focus(pairs[0].1)
			.unwrap()
			.reply()
			.unwrap()
			.focus;
		attach(&conn, slave.deviceid, slave.attachment).unwrap();
		release_pair(&conn, holder, root, park, other.0, other.1, &[]);
		assert_eq!(focus, NONE, "a dead holder's focus clears before its slave disappears");
		let session =
			claim_pair(&conn, holder, &owner.master_name(3), Some(&owner), root, park).unwrap();
		for (pointer, _) in pairs
			.into_iter()
			.filter(|&(pointer, _)| pointer != session.0)
		{
			assert_eq!(read_holder(&conn, holder, pointer).as_deref(), Some(HOLDER_FREE));
			let at = conn
				.xinput_xi_query_pointer(root, pointer)
				.unwrap()
				.reply()
				.unwrap();
			assert_eq!((at.root_x >> 16, at.root_y >> 16), (i32::from(park.0), i32::from(park.1)));
		}
		release_pair(&conn, holder, root, park, session.0, session.1, &[]);
	}

	/// Without hotplug the slave never binds; `main` added a pair, waited and
	/// removed it. Needs a server without uinput hotplug, such as Xvfb, and a
	/// writable `/dev/uinput`.
	#[test]
	#[ignore = "needs Xvfb and a writable /dev/uinput"]
	fn a_server_that_never_binds_the_slave_gets_no_pair() {
		let (conn, root, _) = display();
		conn
			.xinput_xi_select_events(root, &[xinput::EventMask {
				deviceid: Device::ALL.into(),
				mask:     vec![XIEventMask::HIERARCHY],
			}])
			.unwrap()
			.check()
			.unwrap();
		assert!(Mpx::create().is_err());
		conn.get_input_focus().unwrap().reply().unwrap();
		while let Some(event) = conn.poll_for_event().unwrap() {
			if let Event::XinputHierarchy(event) = event {
				assert!(
					!event
						.flags
						.intersects(HierarchyMask::MASTER_ADDED | HierarchyMask::MASTER_REMOVED),
					"hierarchy changed: {:?}",
					event.flags
				);
			}
		}
	}

	#[test]
	fn a_slave_counts_as_routed_only_on_its_own_master_under_its_own_name() {
		let route = Route { slave: 12, master: 20, suffix: " uinput keyboard", device: "keyboard" };
		let info = |attachment, type_, enabled, name: &str| XIDeviceInfo {
			deviceid: 12,
			type_,
			attachment,
			enabled,
			name: name.as_bytes().to_vec(),
			classes: Vec::new(),
		};
		let ours = "OMP MPX v2.a uinput keyboard";
		let seat = |info: XIDeviceInfo| seat_of(Some(&info), "OMP MPX v2.a", &route);
		assert_eq!(seat(info(20, DeviceType::SLAVE_KEYBOARD, true, ours)), Seat::Ours);
		assert_eq!(
			seat(info(3, DeviceType::SLAVE_KEYBOARD, true, ours)),
			Seat::Moved(Some(3)),
			"re-enabled onto the core keyboard"
		);
		assert_eq!(seat(info(0, DeviceType::FLOATING_SLAVE, true, ours)), Seat::Moved(None));
		assert_eq!(seat(info(0, DeviceType::FLOATING_SLAVE, false, ours)), Seat::Disabled);
		assert_eq!(
			seat(info(20, DeviceType::SLAVE_KEYBOARD, true, "OMP MPX v2.b uinput keyboard")),
			Seat::Gone,
			"a later device under the freed id"
		);
		assert_eq!(seat_of(None, "OMP MPX v2.a", &route), Seat::Gone);
	}

	/// Two override-redirect windows selecting XI2 key and button presses of
	/// every master: the target the virtual keyboard focuses, and the user's
	/// window holding the core keyboard focus.
	fn input_windows(conn: &RustConnection, root: Window) -> (Window, Window) {
		let window = |x| {
			let window = conn.generate_id().unwrap();
			conn
				.create_window(
					0,
					window,
					root,
					x,
					100,
					80,
					80,
					0,
					WindowClass::INPUT_OUTPUT,
					0,
					&CreateWindowAux::new().override_redirect(1),
				)
				.unwrap();
			conn.map_window(window).unwrap();
			conn
				.xinput_xi_select_events(window, &[xinput::EventMask {
					deviceid: Device::ALL_MASTER.into(),
					mask:     vec![XIEventMask::KEY_PRESS | XIEventMask::BUTTON_PRESS],
				}])
				.unwrap()
				.check()
				.unwrap();
			window
		};
		let (target, user) = (window(100), window(300));
		conn
			.set_input_focus(InputFocus::PARENT, user, CURRENT_TIME)
			.unwrap()
			.check()
			.unwrap();
		(target, user)
	}

	/// Presses since the last call: `(keys at target, keys at user, buttons at
	/// target)`.
	fn landed(conn: &RustConnection, target: Window, user: Window) -> (usize, usize, usize) {
		conn.get_input_focus().unwrap().reply().unwrap();
		let mut landed = (0, 0, 0);
		while let Some(event) = conn.poll_for_event().unwrap() {
			match event {
				Event::XinputKeyPress(press) if press.event == target => landed.0 += 1,
				Event::XinputKeyPress(press) if press.event == user => landed.1 += 1,
				Event::XinputButtonPress(press) if press.event == target => landed.2 += 1,
				_ => {},
			}
		}
		landed
	}

	fn core_master(conn: &RustConnection, type_: DeviceType) -> u16 {
		query_devices(conn)
			.unwrap()
			.into_iter()
			.find(|info| info.type_ == type_ && info.name.starts_with(b"Virtual core "))
			.unwrap()
			.deviceid
	}

	/// What `xinput float` sends.
	fn float(conn: &RustConnection, slave: u16) {
		let change = HierarchyChange {
			len:  2,
			data: HierarchyChangeData::DetachSlave(HierarchyChangeDataDetachSlave { deviceid: slave }),
		};
		conn
			.xinput_xi_change_hierarchy(&[change])
			.unwrap()
			.check()
			.unwrap();
	}

	/// What `xinput disable` and `enable` send.
	fn set_enabled(conn: &RustConnection, slave: u16, enabled: bool) {
		let property = conn
			.intern_atom(true, b"Device Enabled")
			.unwrap()
			.reply()
			.unwrap()
			.atom;
		conn
			.xinput_xi_change_property(
				slave,
				PropMode::REPLACE,
				property,
				AtomEnum::INTEGER.into(),
				1,
				&XIChangePropertyAux::Data8(vec![u8::from(enabled)]),
			)
			.unwrap()
			.check()
			.unwrap();
	}

	/// Xorg floats a slave it disables and attaches it to the core devices
	/// when it enables it again (a VT round trip does both), where its keys
	/// reach the user's focused window and are still confirmed. Needs Xorg with
	/// uinput hotplug; run with `--ignored`.
	#[test]
	#[ignore = "needs Xorg with uinput hotplug"]
	fn a_slave_the_server_moved_is_put_back_before_input() {
		let (conn, root, _) = display();
		let (target, user) = input_windows(&conn, root);
		let mut mpx = Mpx::create().unwrap();
		mpx.type_text(target, "x").unwrap();
		assert_eq!(landed(&conn, target, user), (1, 0, 0));
		let keyboard = mpx.keyboard.as_ref().unwrap().slave;
		let core_keyboard = core_master(&conn, DeviceType::MASTER_KEYBOARD);

		attach(&conn, keyboard, core_keyboard).unwrap();
		mpx.type_text(target, "x").unwrap();
		assert_eq!(landed(&conn, target, user), (1, 0, 0), "on the core keyboard");

		float(&conn, keyboard);
		mpx.type_text(target, "x").unwrap();
		assert_eq!(landed(&conn, target, user), (1, 0, 0), "floated");

		set_enabled(&conn, keyboard, false);
		let refused = mpx.type_text(target, "x").unwrap_err();
		assert_eq!(
			refused.code,
			crate::desktop::error::ErrorCode::BackgroundUnavailable,
			"{}",
			refused.message
		);
		set_enabled(&conn, keyboard, true);
		assert_eq!(landed(&conn, target, user), (0, 0, 0), "nothing sent while disabled");
		mpx.type_text(target, "x").unwrap();
		assert_eq!(landed(&conn, target, user), (1, 0, 0), "enabled again");

		attach(&conn, mpx.pointer_slave, core_master(&conn, DeviceType::MASTER_POINTER)).unwrap();
		mpx.click(target, (140, 140), MouseButton::Left, 1, Modifiers::default())
			.unwrap();
		assert_eq!(landed(&conn, target, user), (0, 0, 1), "pointer on the core pointer");
	}

	/// Root property whose change tells a [`move_on_first_event`] mover that
	/// the call it watched has returned.
	const MOVER_STOP: &[u8] = b"_OMP_TEST_MOVER_STOP";

	/// Another client, standing in for the server's re-enable: attaches
	/// `slave` to `master` on the first raw event the slave sends, or returns
	/// `false` once [`stop_mover`] says the call ended without one.
	fn move_on_first_event(
		slave: u16,
		master: u16,
		mask: XIEventMask,
	) -> std::thread::JoinHandle<bool> {
		let (mover, root, _) = display();
		let stop = mover
			.intern_atom(false, MOVER_STOP)
			.unwrap()
			.reply()
			.unwrap()
			.atom;
		mover
			.change_window_attributes(
				root,
				&ChangeWindowAttributesAux::new().event_mask(CoreEventMask::PROPERTY_CHANGE),
			)
			.unwrap()
			.check()
			.unwrap();
		mover
			.xinput_xi_select_events(root, &[xinput::EventMask {
				deviceid: slave,
				mask:     vec![mask],
			}])
			.unwrap()
			.check()
			.unwrap();
		std::thread::spawn(move || {
			loop {
				match mover.wait_for_event().unwrap() {
					Event::XinputRawKeyPress(_)
					| Event::XinputRawMotion(_)
					| Event::XinputRawButtonPress(_) => {
						attach(&mover, slave, master).unwrap();
						return true;
					},
					Event::PropertyNotify(event) if event.atom == stop => return false,
					_ => {},
				}
			}
		})
	}

	fn stop_mover(conn: &RustConnection, root: Window) {
		let stop = conn
			.intern_atom(false, MOVER_STOP)
			.unwrap()
			.reply()
			.unwrap()
			.atom;
		conn
			.change_property(PropMode::REPLACE, root, stop, AtomEnum::STRING, 8, 1, b"1")
			.unwrap()
			.check()
			.unwrap();
	}

	/// A slave moved while a call runs: every event is confirmed, but the ones
	/// after the move went to the user's devices. Keys through
	/// `deliver_keys`, wheel detents through `gesture`. Needs Xorg with uinput
	/// hotplug; run with `--ignored`.
	#[test]
	#[ignore = "needs Xorg with uinput hotplug"]
	fn a_call_whose_slave_moved_while_it_ran_does_not_report_success() {
		let (conn, root, _) = display();
		let (target, user) = input_windows(&conn, root);
		let mut mpx = Mpx::create().unwrap();
		mpx.type_text(target, "x").unwrap();
		landed(&conn, target, user);
		let keyboard = mpx.keyboard.as_ref().unwrap().slave;
		let core_keyboard = core_master(&conn, DeviceType::MASTER_KEYBOARD);
		let mover = move_on_first_event(keyboard, core_keyboard, XIEventMask::RAW_KEY_PRESS);
		let result = mpx.type_text(target, &"x".repeat(40));
		stop_mover(&conn, root);
		assert!(mover.join().unwrap(), "the keyboard was moved during the call");
		let (at_target, at_user, _) = landed(&conn, target, user);
		assert!(
			at_user > 0,
			"the keys after the move reached the user's window: {at_target}/{at_user}"
		);
		let error = result.unwrap_err();
		assert_eq!(error.code, crate::desktop::error::ErrorCode::InputFailed, "{}", error.message);
		mpx.type_text(target, "x").unwrap();
		assert_eq!(landed(&conn, target, user), (1, 0, 0), "the next call puts it back");

		let core_pointer = core_master(&conn, DeviceType::MASTER_POINTER);
		let mover = move_on_first_event(
			mpx.pointer_slave,
			core_pointer,
			XIEventMask::RAW_MOTION | XIEventMask::RAW_BUTTON_PRESS,
		);
		let result = mpx.scroll(target, (140, 140), 0.0, 10.0);
		stop_mover(&conn, root);
		assert!(mover.join().unwrap(), "the pointer was moved during the call");
		let error = result.unwrap_err();
		assert_eq!(error.code, crate::desktop::error::ErrorCode::InputFailed, "{}", error.message);
		mpx.scroll(target, (140, 140), 0.0, 1.0).unwrap();
	}

	#[test]
	fn start_ticks_survives_parentheses_in_the_command_name() {
		let stat = "12 (a) b (c)) S 1 12 12 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 98765 0";
		assert_eq!(start_ticks(stat), Some(98765));
	}

	#[test]
	fn drag_steps_are_bounded_and_land_exactly_on_the_end() {
		let steps = relative_steps(&[(10, 10), (10, 10), (60, 22), (58, 22)]);
		assert!(
			steps
				.iter()
				.all(|&(dx, dy)| f64::from(dx).hypot(f64::from(dy)) <= DRAG_STEP_MAX_PX)
		);
		assert!(steps.iter().all(|&step| step != (0, 0)));
		let end = steps
			.iter()
			.fold((10, 10), |(x, y), &(dx, dy)| (x + dx, y + dy));
		assert_eq!(end, (58, 22));
	}

	/// Uses an isolated X server for real keymap planning and XI focus. Only
	/// the kernel write endpoint and the server's raw-event stream are replaced.
	fn typing_fixture() -> Mpx {
		// Xvfb resets when its last client disconnects. Keep one connection
		// across fixtures so a new case cannot race that reset.
		static SERVER: std::sync::LazyLock<RustConnection> =
			std::sync::LazyLock::new(|| x11rb::connect(None).unwrap().0);
		std::sync::LazyLock::force(&SERVER);
		let (conn, screen) = x11rb::connect(None).unwrap();
		let root = conn.setup().roots[screen].root;
		let atoms = Atoms::intern(&conn).unwrap();
		let keyboard = conn
			.xinput_xi_query_device(Device::ALL_MASTER)
			.unwrap()
			.reply()
			.unwrap()
			.infos
			.into_iter()
			.find(|info| info.type_ == DeviceType::MASTER_KEYBOARD)
			.unwrap()
			.deviceid;
		Mpx {
			conn,
			root,
			atoms,
			park: (0, 0),
			name: String::new(),
			master_pointer: 0,
			master_keyboard: keyboard,
			pointer: UInputDevice::test_sink(),
			pointer_slave: 0,
			keyboard: Some(VirtualKeyboard { device: UInputDevice::test_sink(), slave: keyboard }),
			uncertain: false,
			sent: false,
			release_events: None,
		}
	}

	fn release(deviceid: u16, sourceid: u16, detail: u32) -> Event {
		Event::XinputRawKeyRelease(xinput::RawKeyReleaseEvent {
			deviceid,
			sourceid,
			detail,
			..Default::default()
		})
	}

	#[test]
	#[ignore = "requires an isolated X11 display (run under xvfb-run)"]
	fn typing_loss_fails_and_inhibits_the_next_call() {
		use crate::desktop::error::ErrorCode;
		// Complete delivery, resync noise, lost repeat, middle/first loss, and
		// another slave's matching release must all reach the caller correctly.
		for (text, indices, foreign, succeeds) in [
			("abc", vec![0, 1, 2], false, true),
			("abc", vec![0, 0, 1, 2], false, true),
			("aa", vec![0], false, false),
			("abc", vec![0, 2], false, false),
			("abc", vec![1, 2], false, false),
			("abc", vec![0, 1, 2], true, false),
		] {
			let mut mpx = typing_fixture();
			let codes: Vec<u32> = mpx
				.keyboard_keymap()
				.unwrap()
				.plan_text(text)
				.unwrap()
				.iter()
				.filter(|step| !step.press)
				.map(|step| u32::from(step.keycode))
				.collect();
			let device = mpx.master_keyboard;
			let mut events: std::collections::VecDeque<_> = indices
				.into_iter()
				.enumerate()
				.map(|(at, index)| {
					if foreign && at == 1 {
						release(device + 100, device + 100, codes[index])
					} else if at % 2 == 0 {
						release(device, device + 100, codes[index])
					} else {
						release(device + 100, device, codes[index])
					}
				})
				.collect();
			mpx.release_events = Some(std::cell::RefCell::new(Box::new(move || events.pop_front())));
			let result = mpx.type_text(mpx.root, text);
			if succeeds {
				result.unwrap();
				assert!(!mpx.uncertain);
			} else {
				let error = result.unwrap_err();
				assert_eq!(error.code, ErrorCode::InputFailed);
				assert!(error.message.contains("key releases"));
				assert!(mpx.uncertain);
				assert_eq!(
					mpx.type_text(mpx.root, text).unwrap_err().code,
					ErrorCode::BackgroundUnavailable
				);
			}
		}
	}

	#[test]
	#[ignore = "requires an isolated X11 display (run under xvfb-run)"]
	fn typing_deadline_bounds_busy_events_and_rejects_late_releases() {
		use crate::desktop::error::ErrorCode;
		let mut mpx = typing_fixture();
		let code = mpx
			.keyboard_keymap()
			.unwrap()
			.plan_text("a")
			.unwrap()
			.into_iter()
			.find(|step| !step.press)
			.unwrap()
			.keycode;
		let device = mpx.master_keyboard;
		let mut started = None;
		mpx.release_events = Some(std::cell::RefCell::new(Box::new(move || {
			let started = started.get_or_insert_with(Instant::now);
			// Never an empty queue: even the right key from another slave
			// must not extend the deadline. The real release arrives too late.
			let source = if started.elapsed() < KEY_CONFIRM_TIMEOUT + Duration::from_millis(100) {
				device + 100
			} else {
				device
			};
			Some(release(source, source, u32::from(code)))
		})));
		let started = Instant::now();
		assert_eq!(mpx.type_text(mpx.root, "a").unwrap_err().code, ErrorCode::InputFailed);
		assert!(started.elapsed() < KEY_CONFIRM_TIMEOUT + Duration::from_secs(1));
		assert_eq!(mpx.type_text(mpx.root, "a").unwrap_err().code, ErrorCode::BackgroundUnavailable);
	}

	#[test]
	fn wheel_detents_follow_x_button_directions() {
		// X: dy > 0 is button 5 (down) = REL_WHEEL -1; dx > 0 is button 7
		// (right) = REL_HWHEEL +1.
		assert_eq!(wheel_detents(0.0, 2.0), vec![(false, -1), (false, -1)]);
		assert_eq!(wheel_detents(0.0, -1.0), vec![(false, 1)]);
		assert_eq!(wheel_detents(1.0, 0.0), vec![(true, 1)]);
		assert_eq!(wheel_detents(-1.0, 0.0), vec![(true, -1)]);
		assert!(wheel_detents(0.2, -0.4).is_empty());
	}
}
