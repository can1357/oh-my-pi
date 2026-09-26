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
//! The pair lives for the whole desktop session: adding and removing masters
//! churns the `XInput` hierarchy, which crashes mutter 42 and `LibreOffice` VCL
//! when it happens per action. Masters are named after their owning process
//! incarnation so a later session can remove the ones a killed process left
//! behind (an orphaned master keeps drawing a second cursor).

use std::{
	fs, io,
	sync::atomic::{AtomicU16, Ordering},
	thread,
	time::{Duration, Instant},
};

use x11rb::{
	CURRENT_TIME, NONE,
	connection::Connection,
	protocol::{
		Event,
		xinput::{
			self, ChangeMode, ConnectionExt as _, Device, DeviceType, EventMode, HierarchyChange,
			HierarchyChangeData, HierarchyChangeDataAddMaster, HierarchyChangeDataAttachSlave,
			HierarchyChangeDataRemoveMaster, XIChangePropertyAux, XIDeviceInfo, XIEventMask,
			XIGetPropertyItems,
		},
		xproto::{AtomEnum, ConnectionExt as _, PropMode, Window},
	},
	rust_connection::RustConnection,
};

use super::{
	input::button_detail,
	keymap::{self, KeyStep, Keymap},
	uinput::{UInputDevice, X_KEYCODE_OFFSET},
	wm::{Atoms, Wm},
};
use crate::desktop::{
	backend::{Modifiers, MouseButton},
	error::{CoreResult, DesktopError},
	keys::KeyName,
};

/// udev + xf86-input-libinput hot-add the uinput slave on a real Xorg;
/// servers without hotplug never do, which the timeout covers.
const SLAVE_BIND_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the server gets to report an emitted pointer event back.
const POINTER_CONFIRM_TIMEOUT: Duration = Duration::from_secs(1);
/// How long the server gets to report the last emitted key back.
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
/// Master names that encode an owner incarnation (see [`Owner`]).
const OWNER_PREFIX: &str = "OMP MPX v1.";

static NONCE: AtomicU16 = AtomicU16::new(1);

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
}

/// The uinput keyboard slave, created on the first keyboard or modifier use
/// so pointer-only sessions never pay for a second hotplug.
struct VirtualKeyboard {
	device: UInputDevice,
	slave:  u16,
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
		let owner = Owner::current();
		if let Some(owner) = &owner {
			reap_orphans(&conn, owner);
		}
		let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
		let name = owner.as_ref().map_or_else(
			|| format!("OMP MPX {}.{nonce:x}", std::process::id()),
			|owner| owner.master_name(nonce),
		);
		// The non-X resource first: a late uinput failure must not leave a
		// fresh master pair behind.
		let pointer_name = format!("{name} uinput pointer");
		let pointer = UInputDevice::pointer(&pointer_name)?;
		add_master(&conn, &name)?;
		let (master_pointer, master_keyboard) = find_masters(&conn, &name)?;
		let pointer_slave = match wait_for_slave(&conn, &pointer_name, DeviceType::SLAVE_POINTER)
			.and_then(|slave| attach(&conn, slave, master_pointer).map(|()| slave))
			.and_then(|slave| {
				select_raw(
					&conn,
					root,
					slave,
					XIEventMask::RAW_BUTTON_PRESS
						| XIEventMask::RAW_BUTTON_RELEASE
						| XIEventMask::RAW_MOTION,
				)
				.map(|()| slave)
			}) {
			Ok(slave) => slave,
			Err(error) => {
				remove_master(&conn, master_pointer);
				return Err(error);
			},
		};
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
		self.gesture(target, modifiers, Some(detail), true, |this| {
			this.warp(x, y)?;
			this.drain();
			let mut confirmed = true;
			for index in 0..count {
				this.check_target(target, x, y)?;
				this.pointer.button(detail, true)?;
				confirmed &= this.wait_raw(this.pointer_slave, Raw::ButtonPress(detail), 1);
				thread::sleep(PRESS_HOLD);
				this.pointer.button(detail, false)?;
				confirmed &= this.wait_raw(this.pointer_slave, Raw::ButtonRelease(detail), 1);
				if index + 1 < count {
					thread::sleep(CLICK_GAP);
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
	) -> CoreResult<()> {
		let (Some(&start), Some(&end)) = (path.first(), path.last()) else {
			return Err(DesktopError::input_failed("drag path is empty"));
		};
		let steps = relative_steps(path);
		let detail = button_detail(button);
		self.gesture(target, modifiers, Some(detail), true, |this| {
			this.warp(start.0, start.1)?;
			this.drain();
			this.check_target(target, start.0, start.1)?;
			this.pointer.button(detail, true)?;
			let mut confirmed = this.wait_raw(this.pointer_slave, Raw::ButtonPress(detail), 1);
			thread::sleep(DRAG_ARM);
			this.drain();
			for &(dx, dy) in &steps {
				this.pointer.motion(dx, dy)?;
				thread::sleep(DRAG_STEP_DELAY);
			}
			// The end warp must not overtake a relative step still in flight.
			confirmed &= this.wait_raw(this.pointer_slave, Raw::Motion, steps.len());
			this.warp(end.0, end.1)?;
			thread::sleep(DRAG_RELEASE_SETTLE);
			this.drain();
			this.pointer.button(detail, false)?;
			confirmed &= this.wait_raw(this.pointer_slave, Raw::ButtonRelease(detail), 1);
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
		self.gesture(target, Modifiers::default(), None, true, |this| {
			this.warp(x, y)?;
			let Some((&(horizontal, value), earlier)) = detents.split_last() else {
				return Ok(true);
			};
			for &(horizontal, value) in earlier {
				this.check_target(target, x, y)?;
				this.pointer.wheel(horizontal, value)?;
				thread::sleep(SCROLL_DETENT_DELAY);
			}
			this.drain();
			this.check_target(target, x, y)?;
			this.pointer.wheel(horizontal, value)?;
			Ok(this.wait_raw(this.pointer_slave, Raw::Wheel, 1))
		})
	}

	/// Hover at `(x, y)` with one real device motion event: the pointer is
	/// warped a pixel away and moved onto the point, since whether a warp
	/// reports motion varies across Xorg versions. The virtual cursor stays on
	/// the point.
	pub(super) fn hover(&mut self, target: Window, (x, y): (i16, i16)) -> CoreResult<()> {
		let step: i16 = if x > 0 { 1 } else { -1 };
		self.gesture(target, Modifiers::default(), None, false, |this| {
			this.check_target(target, x - step, y)?;
			this.warp(x - step, y)?;
			this.drain();
			this.pointer.motion(i32::from(step), 0)?;
			let confirmed = this.wait_raw(this.pointer_slave, Raw::Motion, 1);
			this.warp(x, y)?;
			Ok(confirmed)
		})
	}

	pub(super) fn type_text(&mut self, target: Window, text: &str) -> CoreResult<()> {
		self.check_ready()?;
		let steps = self.keyboard_keymap()?.plan_text(text)?;
		self.deliver_keys(target, &steps)
	}

	pub(super) fn key_chord(&mut self, target: Window, keys: &[KeyName]) -> CoreResult<()> {
		self.check_ready()?;
		let steps = self.keyboard_keymap()?.plan_chord(keys)?;
		self.deliver_keys(target, &steps)
	}

	fn deliver_keys(&mut self, target: Window, steps: &[KeyStep]) -> CoreResult<()> {
		self.focus(target)?;
		if let Err(error) = self.emit_keys(steps) {
			self.uncertain = true;
			return Err(error);
		}
		thread::sleep(KEY_SETTLE);
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
		button: Option<u8>,
		park_after: bool,
		body: impl FnOnce(&mut Self) -> CoreResult<bool>,
	) -> CoreResult<()> {
		self.check_ready()?;
		self.thaw();
		let held = self.hold_modifiers(target, modifiers)?;
		let result = body(self);
		let released_button = button.map_or(Ok(()), |button| self.pointer.button(button, false));
		let released_keys = self.release_keys(&held);
		let result = result.and_then(|confirmed| released_button.map(|()| confirmed && released_keys));
		self.uncertain = !matches!(result, Ok(true));
		match result {
			Ok(true) => {
				if park_after {
					self.park();
				}
				Ok(())
			},
			Ok(false) => Err(DesktopError::input_failed(
				"the X server did not confirm virtual input or key release; delivery is uncertain, \
				 so do not retry blindly; use ax actions or takeover:true for subsequent input",
			)),
			Err(error) => Err(error),
		}
	}

	fn hold_modifiers(&mut self, target: Window, modifiers: Modifiers) -> CoreResult<Vec<u8>> {
		if !(modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.meta) {
			return Ok(Vec::new());
		}
		let keycodes = self.keyboard_keymap()?.modifier_keycodes(modifiers)?;
		self.focus(target)?;
		let presses: Vec<KeyStep> = keycodes
			.iter()
			.map(|&keycode| KeyStep { keycode, press: true })
			.collect();
		// Modifiers and buttons travel through separate uinput devices, so the
		// press is only sent once the server has the modifiers down.
		if let Err(error) = self.emit_keys(&presses) {
			self.uncertain = true;
			self.release_keys(&keycodes);
			return Err(error);
		}
		Ok(keycodes)
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
	/// reports the last one.
	fn emit_keys(&mut self, steps: &[KeyStep]) -> CoreResult<()> {
		self.drain();
		let keyboard = self
			.keyboard
			.as_mut()
			.ok_or_else(|| DesktopError::internal("virtual keyboard used before it was attached"))?;
		let slave = keyboard.slave;
		keymap::run_steps(steps, |step| {
			keyboard.device.key(step.keycode, step.press)?;
			thread::sleep(KEY_DELAY);
			Ok(())
		})?;
		let Some(last) = steps.last() else {
			return Ok(());
		};
		let raw = if last.press {
			Raw::KeyPress(last.keycode)
		} else {
			Raw::KeyRelease(last.keycode)
		};
		if self.wait_raw(slave, raw, 1) {
			Ok(())
		} else {
			Err(DesktopError::input_failed(format!(
				"the X server did not confirm the virtual keyboard's last key within {}ms; the keys \
				 may not have been delivered",
				KEY_CONFIRM_TIMEOUT.as_millis()
			)))
		}
	}

	/// Points the virtual keyboard's own focus at `window`; the core focus is
	/// untouched. Retried once: a freshly mapped toplevel can miss the first.
	fn focus(&self, window: Window) -> CoreResult<()> {
		for attempt in 0..2 {
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
				thread::sleep(Duration::from_millis(30));
			}
		}
		Err(DesktopError::background_unavailable(format!(
			"window {window} cannot take the virtual keyboard focus (not viewable); retry with \
			 takeover:true or use ax actions"
		)))
	}

	pub(super) fn inhibit(&mut self) {
		self.uncertain = true;
	}

	fn check_ready(&self) -> CoreResult<()> {
		if self.uncertain {
			return Err(DesktopError::background_unavailable(
				"the virtual input device could not confirm isolated delivery of a prior action \
				 and cannot be retargeted; use ax actions or takeover:true",
			));
		}
		Ok(())
	}

	fn check_target(&self, target: Window, x: i16, y: i16) -> CoreResult<()> {
		Wm { conn: &self.conn, root: self.root, atoms: &self.atoms }
			.check_pointer_target(target, x, y)
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
		// the master switches to the slave's keymap; push a symbol-less key
		// through the whole pipeline before real text.
		self.drain();
		if let Err(error) = device.key(WARM_UP_KEYCODE, true) {
			let _ = device.key(WARM_UP_KEYCODE, false);
			return Err(error);
		}
		thread::sleep(KEY_DELAY);
		device.key(WARM_UP_KEYCODE, false)?;
		if !self.wait_raw(slave, Raw::KeyRelease(WARM_UP_KEYCODE), 1) {
			return Err(DesktopError::input_failed("virtual keyboard warm-up was not confirmed"));
		}
		thread::sleep(WARM_UP_SETTLE);
		Ok(VirtualKeyboard { device, slave })
	}

	/// Moves only the virtual master; synced so a following uinput event
	/// (a separate kernel pipeline) cannot overtake it.
	fn warp(&self, x: i16, y: i16) -> CoreResult<()> {
		self
			.conn
			.xinput_xi_warp_pointer(
				NONE,
				self.root,
				0,
				0,
				0,
				0,
				i32::from(x) << 16,
				i32::from(y) << 16,
				self.master_pointer,
			)
			.map_err(mpx_failed)?
			.check()
			.map_err(mpx_failed)
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
	fn wait_raw(&self, device: u16, kind: Raw, count: usize) -> bool {
		let timeout = match kind {
			Raw::KeyPress(_) | Raw::KeyRelease(_) => KEY_CONFIRM_TIMEOUT,
			_ => POINTER_CONFIRM_TIMEOUT,
		};
		let deadline = Instant::now() + timeout;
		let mut seen = 0;
		while seen < count {
			if Instant::now() >= deadline {
				return false;
			}
			match self.conn.poll_for_event() {
				Ok(Some(event)) => {
					if raw_matches(&event, device, kind) {
						seen += 1;
					}
				},
				Ok(None) => {
					if Instant::now() >= deadline {
						return false;
					}
					thread::sleep(Duration::from_millis(2));
				},
				Err(_) => return false,
			}
		}
		true
	}
}

impl Drop for Mpx {
	fn drop(&mut self) {
		// Unplug the slaves first so the removal never hands a live slave back
		// to the user's core devices.
		if let Some(mut keyboard) = self.keyboard.take() {
			keyboard.device.destroy();
		}
		self.pointer.destroy();
		remove_master(&self.conn, self.master_pointer);
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
	for segment in path.windows(2) {
		let (from_x, from_y) = (f64::from(segment[0].0), f64::from(segment[0].1));
		let (to_x, to_y) = (f64::from(segment[1].0), f64::from(segment[1].1));
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
		(Some(pointer), None) => {
			remove_master(conn, pointer);
			Err(DesktopError::input_failed("XIChangeHierarchy did not create the MPX master keyboard"))
		},
		_ => {
			Err(DesktopError::input_failed("XIChangeHierarchy did not create the MPX master pointer"))
		},
	}
}

/// Polls until the server hot-added the uinput device `name` as a slave
/// (attached to the core master, or floating).
fn wait_for_slave(conn: &RustConnection, name: &str, type_: DeviceType) -> CoreResult<u16> {
	let deadline = Instant::now() + SLAVE_BIND_TIMEOUT;
	loop {
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
		thread::sleep(Duration::from_millis(50));
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

/// Removes a master pair without ever attaching a pending virtual slave to
/// the user's core devices. Kernel hot-unplug is asynchronous.
fn remove_master(conn: &RustConnection, master_pointer: u16) {
	if let Ok(devices) = query_devices(conn)
		&& let Some(pointer) = devices.iter().find(|device| device.deviceid == master_pointer)
		&& let Ok(cookie) = conn.xinput_xi_set_focus(NONE, CURRENT_TIME, pointer.attachment)
	{
		let _ = cookie.check();
	}
	let change = HierarchyChange {
		len:  3,
		data: HierarchyChangeData::RemoveMaster(HierarchyChangeDataRemoveMaster {
			deviceid: master_pointer,
			return_mode: ChangeMode::FLOAT,
			return_pointer: 0,
			return_keyboard: 0,
		}),
	};
	if let Ok(cookie) = conn.xinput_xi_change_hierarchy(&[change]) {
		let _ = cookie.check();
	}
	let _ = conn.flush();
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

/// Removes masters left behind by dead incarnations of this user's processes
/// on this machine. Runs under a server grab so no device id is reused
/// between enumeration and removal.
fn reap_orphans(conn: &RustConnection, owner: &Owner) {
	struct Grab<'a>(&'a RustConnection);
	impl Drop for Grab<'_> {
		fn drop(&mut self) {
			if let Ok(cookie) = self.0.ungrab_server() {
				let _ = cookie.check();
			}
		}
	}
	if conn
		.grab_server()
		.ok()
		.and_then(|cookie| cookie.check().ok())
		.is_none()
	{
		return;
	}
	let _grab = Grab(conn);
	let Ok(devices) = query_devices(conn) else {
		return;
	};
	for info in devices
		.iter()
		.filter(|info| info.type_ == DeviceType::MASTER_POINTER)
	{
		let Some(candidate) = std::str::from_utf8(&info.name)
			.ok()
			.and_then(Owner::from_pointer_name)
		else {
			continue;
		};
		if candidate.is_stale_for(owner, process_start) {
			remove_master(conn, info.deviceid);
		}
	}
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

	fn from_pointer_name(name: &str) -> Option<Self> {
		let mut parts = name
			.strip_prefix(OWNER_PREFIX)?
			.strip_suffix(" pointer")?
			.split('.');
		let domain = u64::from_str_radix(parts.next()?, 16).ok()?;
		let pid = u32::from_str_radix(parts.next()?, 16).ok()?;
		let start = u64::from_str_radix(parts.next()?, 16).ok()?;
		let _nonce = u16::from_str_radix(parts.next()?, 16).ok()?;
		(parts.next().is_none() && pid != 0).then_some(Self { domain, pid, start })
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
	use super::*;

	const OWNER: Owner = Owner { domain: 0xfeed_beef, pid: 4242, start: 777 };

	#[test]
	fn owner_name_round_trips_at_integer_limits() {
		let owner = Owner { domain: u64::MAX, pid: u32::MAX, start: u64::MAX };
		let pointer = format!("{} pointer", owner.master_name(u16::MAX));
		assert_eq!(Owner::from_pointer_name(&pointer), Some(owner));
		assert!(format!("{} uinput keyboard", owner.master_name(u16::MAX)).len() < 80);
		assert_eq!(Owner::from_pointer_name("OMP MPX 4242.1 pointer"), None);
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
