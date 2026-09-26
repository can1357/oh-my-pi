//! X11 input routing.
//!
//! - Desktop targets drive the user's real pointer and keyboard through
//!   `XTest`.
//! - Background window targets prefer the XI2-MPX virtual master pair (real
//!   XI2-only input on independent devices), refusing when the point is covered
//!   by another window. Without MPX they fall back to
//!   `XSendEvent`, except for toolkits known to drop synthetic events, which
//!   get an explicit `background_unavailable` instead of a silent no-op.
//! - Foreground (`takeover`) activates the target, confirms the WM made it the
//!   active, focused window, injects through `XTest`, then restores the user's
//!   pointer position and previously active window.

use std::{
	cell::Cell,
	sync::Arc,
	thread,
	time::{Duration, Instant},
};

use x11rb::{
	CURRENT_TIME, NONE,
	connection::Connection,
	protocol::{
		xinput::ConnectionExt as _,
		xproto::{
			AtomEnum, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ButtonPressEvent, ConnectionExt as _,
			EventMask, InputFocus, KEY_PRESS_EVENT, KEY_RELEASE_EVENT, KeyButMask, KeyPressEvent,
			MOTION_NOTIFY_EVENT, Motion, MotionNotifyEvent, Window,
		},
		xtest::ConnectionExt as _,
	},
	rust_connection::RustConnection,
};

use super::{
	keymap::{self, KeyStep, Keymap},
	mpx::Mpx,
	toolkit, uinput,
	wm::{Atoms, FocusSnapshot, Wm},
};
use crate::desktop::{
	backend::{DeliveryMode, Modifiers, MouseButton, PointerEvent},
	error::{CoreResult, DesktopError},
	keys::KeyName,
	types::Target,
};

const CLICK_DELAY: Duration = Duration::from_millis(12);
/// Release → next press of an `XTest` multi-click. Chromium synthesizes
/// `dblclick` only when the first pair reached it before the second.
const MULTI_CLICK_GAP: Duration = Duration::from_millis(50);
const DRAG_STEP_DELAY: Duration = Duration::from_millis(8);
/// Activation budget of a foreground pointer action.
const FOREGROUND_POINTER_SETTLE: Duration = Duration::from_millis(800);
/// Keyboard input needs the input focus, which GTK/VCL toplevels accept a
/// beat after being raised.
const FOREGROUND_KEYBOARD_SETTLE: Duration = Duration::from_millis(1500);
const FOREGROUND_POLL: Duration = Duration::from_millis(15);
/// Time the target gets to consume the injected events before the user's
/// pointer and window are restored: a toolkit that reads the pointer while
/// handling a release, or an input method committing text, must still see
/// the state the action left.
const FOREGROUND_RESTORE_SETTLE: Duration = Duration::from_millis(150);
/// Bound on re-activating the user's window after a foreground action.
const FOREGROUND_RESTORE_BUDGET: Duration = Duration::from_millis(400);

pub struct X11Input {
	conn:            Arc<RustConnection>,
	root:            Window,
	atoms:           Atoms,
	keymap:          Keymap,
	takeover_target: Option<Window>,
	takeover_pointer: Cell<Option<(i16, i16)>>,
	/// Session-lived virtual master pair, created on first background use.
	mpx:             Option<Mpx>,
	/// Why the XI2-MPX route is unusable. Set once, so a host that cannot
	/// hot-plug devices is not re-probed (and its hierarchy not churned) on
	/// every action.
	mpx_unavailable: Option<String>,
}

/// Keyboard input to plan against a keymap.
#[derive(Clone, Copy)]
enum Keys<'a> {
	Text(&'a str),
	Chord(&'a [KeyName]),
}

impl Keys<'_> {
	const fn kind(self) -> &'static str {
		match self {
			Self::Text(_) => "text",
			Self::Chord(_) => "key",
		}
	}

	fn plan(self, keymap: &Keymap) -> CoreResult<Vec<KeyStep>> {
		match self {
			Self::Text(text) => keymap.plan_text(text),
			Self::Chord(keys) => keymap.plan_chord(keys),
		}
	}
}

impl X11Input {
	pub(crate) fn new(conn: Arc<RustConnection>, root: Window) -> CoreResult<Self> {
		conn
			.xtest_get_version(2, 2)
			.map_err(input_failed)?
			.reply()
			.map_err(|error| {
				DesktopError::input_failed(format!("XTEST extension is unavailable: {error}"))
			})?;
		let keymap = Keymap::core(&conn)?;
		let atoms = Atoms::intern(&conn)?;
		let mpx_unavailable = mpx_probe(&conn).err();
		Ok(Self {
			conn, root, atoms, keymap, takeover_target: None,
			takeover_pointer: Cell::new(None), mpx: None, mpx_unavailable,
		})
	}

	pub(crate) fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		if matches!(target, Target::Desktop) || mode == DeliveryMode::Foreground {
			self.keymap = Keymap::core(&self.conn)?;
		}
		match (target, mode) {
			(Target::Desktop, _) => self.pointer_xtest(&event),
			(Target::Window(id), DeliveryMode::Foreground) => {
				let window = parse_window(id)?;
				pointer_endpoint(&event)?;
				self.with_foreground(window, FOREGROUND_POINTER_SETTLE, |this| {
					this.pointer_xtest(&event)
				})
			},
			(Target::Window(id), DeliveryMode::Background) => {
				let window = parse_window(id)?;
				if self.requires_core_events(window) {
					if self.drops_synthetic_input(window) {
						return Err(background_unavailable(id, event_kind(&event),
							"its toolkit needs core input, which cannot preserve MPX focus isolation"));
					}
					return self.pointer_send_event(window, &event);
				}
				let reason = match ensure_mpx(&mut self.mpx, &mut self.mpx_unavailable) {
					Ok(mpx) => {
						let wm = Wm { conn: &self.conn, root: self.root, atoms: &self.atoms };
						return pointer_mpx(wm, mpx, window, &event);
					},
					Err(reason) => reason,
				};
				if self.drops_synthetic_input(window) {
					return Err(background_unavailable(
						id,
						event_kind(&event),
						&format!(
							"its toolkit filters XSendEvent and the XI2-MPX real-input route is \
							 unavailable ({reason})"
						),
					));
				}
				self.pointer_send_event(window, &event)
			},
		}
	}

	pub(crate) fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.keys(target, Keys::Text(text), mode)
	}

	pub(crate) fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.keys(target, Keys::Chord(keys), mode)
	}

	/// Persistent activation: the target stays active afterwards.
	pub(crate) fn raise_window(&self, window: Window) -> CoreResult<()> {
		let wm = self.wm();
		wm.request_activation(window, wm.active_window())
	}

	fn wm(&self) -> Wm<'_> {
		Wm { conn: &self.conn, root: self.root, atoms: &self.atoms }
	}

	fn keys(&mut self, target: &Target, keys: Keys<'_>, mode: DeliveryMode) -> CoreResult<()> {
		self.keymap = Keymap::core(&self.conn)?;
		match (target, mode) {
			(Target::Desktop, _) => {
				let steps = keys.plan(&self.keymap)?;
				self.xtest_steps(&steps)
			},
			(Target::Window(id), DeliveryMode::Foreground) => {
				let window = parse_window(id)?;
				let steps = keys.plan(&self.keymap)?;
				self
					.with_foreground(window, FOREGROUND_KEYBOARD_SETTLE, |this| this.xtest_steps(&steps))
			},
			(Target::Window(id), DeliveryMode::Background) => {
				let window = parse_window(id)?;
				self.background_keys(id, window, keys)
			},
		}
	}

	fn background_keys(&mut self, id: &str, window: Window, keys: Keys<'_>) -> CoreResult<()> {
		if self.requires_core_events(window) {
			if self.drops_synthetic_input(window) {
				return Err(background_unavailable(id, keys.kind(),
					"its toolkit needs core input, which cannot preserve MPX focus isolation"));
			}
			let steps = keys.plan(&self.keymap)?;
			return self.send_key_steps(window, &steps);
		}
		let reason = match ensure_mpx(&mut self.mpx, &mut self.mpx_unavailable) {
			Ok(mpx) => {
				let wm = Wm { conn: &self.conn, root: self.root, atoms: &self.atoms };
				let pid = wm.owning_pid(window);
				if let Some(pid) = pid
					&& let Some(popup) = wm.grab_popup_of(pid)
				{
					return Err(background_unavailable(id, keys.kind(), &format!(
						"popup {popup} may hold an input grab; background input cannot safely \
						 substitute the user's core keyboard"
					)));
				}
				let snapshot = FocusSnapshot::capture(wm);
				let result = match keys {
					Keys::Text(text) => mpx.type_text(window, text),
					Keys::Chord(chord) => mpx.key_chord(window, chord),
				};
				let isolation = snapshot.check(wm, window);
				if isolation.is_err() {
					mpx.inhibit();
				}
				return result.and(isolation);
			},
			Err(reason) => reason,
		};
		if self.drops_synthetic_input(window) {
			return Err(background_unavailable(
				id,
				keys.kind(),
				&format!(
					"its toolkit filters XSendEvent keyboard input and the XI2-MPX virtual keyboard is \
					 unavailable ({reason})"
				),
			));
		}
		let steps = keys.plan(&self.keymap)?;
		self.send_key_steps(window, &steps)
	}

	/// Activates `window`, confirms the WM made it the active window holding
	/// the core focus, runs `body`, then restores the user's pointer position
	/// and previously active window. Fails without sending input when the
	/// activation is never confirmed.
	fn with_foreground<T>(
		&mut self,
		window: Window,
		budget: Duration,
		body: impl FnOnce(&mut Self) -> CoreResult<T>,
	) -> CoreResult<T> {
		let wm = self.wm();
		let ewmh = wm.tracks_active_window();
		let previous_active = wm.active_window();
		let previous_focus = wm.input_focus();
		let pointer = self.core_pointer();
		if let Err(error) = self.activate_confirmed(window, ewmh, previous_active, budget) {
			self.restore_activation(window, ewmh, previous_active, previous_focus);
			return Err(error);
		}
		self.takeover_target = Some(window);
		self.takeover_pointer.set(None);
		let result = body(self);
		self.takeover_target = None;
		let pointer_after = self.takeover_pointer.take();
		thread::sleep(FOREGROUND_RESTORE_SETTLE);
		// A physical motion during the action is the user's new position.
		// Keyboard-only actions never warp the pointer, even during restore.
		if let Some(pointer) = pointer
			&& pointer_after.is_some()
			&& self.core_pointer() == pointer_after
		{
			self.restore_core_pointer(pointer);
		}
		self.restore_activation(window, ewmh, previous_active, previous_focus);
		result
	}

	fn activate_confirmed(
		&self,
		window: Window,
		ewmh: bool,
		previous_active: Option<Window>,
		budget: Duration,
	) -> CoreResult<()> {
		let wm = self.wm();
		// Already active and focused: re-activating pops open menus down.
		if wm.is_focused(window, ewmh) {
			return Ok(());
		}
		wm.request_activation(window, previous_active)?;
		let start = Instant::now();
		let retry_at = start + budget.mul_f32(0.4);
		let mut retried = false;
		loop {
			if wm.is_focused(window, ewmh) {
				return Ok(());
			}
			let now = Instant::now();
			if now >= start + budget {
				break;
			}
			if !retried && now >= retry_at {
				retried = true;
				let _ = wm.request_activation(window, wm.active_window());
			}
			thread::sleep(FOREGROUND_POLL);
		}
		Err(DesktopError::input_failed(format!(
			"window {window} did not become the active, focused window within {}ms (it may be \
			 minimized, on another workspace, or blocked by a modal dialog); no input was sent",
			budget.as_millis()
		)))
	}

	/// Re-activates the window that was active before a foreground action
	/// (or restores the core focus when no EWMH WM tracks activation).
	fn restore_activation(
		&self,
		window: Window,
		ewmh: bool,
		previous_active: Option<Window>,
		previous_focus: Option<(Window, InputFocus)>,
	) {
		let wm = self.wm();
		if ewmh {
			let Some(previous) = previous_active.filter(|&previous| previous != window) else {
				return;
			};
			// Never overwrite a deliberate switch to a third window.
			if wm.active_window() != Some(window)
				|| !wm.input_focus().is_some_and(|(focus, _)| wm.is_within(focus, window))
			{
				return;
			}
			let _ = wm.request_activation(previous, Some(window));
			let deadline = Instant::now() + FOREGROUND_RESTORE_BUDGET;
			while Instant::now() < deadline && wm.active_window() == Some(window) {
				thread::sleep(FOREGROUND_POLL);
			}
			return;
		}
		if let Some((focus, revert)) = previous_focus
			&& focus > 1
			&& wm.input_focus().is_some_and(|(now, _)| wm.is_within(now, window))
			&& let Ok(cookie) = self.conn.set_input_focus(revert, focus, CURRENT_TIME)
		{
			let _ = cookie.check();
		}
	}

	/// Core pointer position on this screen.
	fn core_pointer(&self) -> Option<(i16, i16)> {
		let reply = self.conn.query_pointer(self.root).ok()?.reply().ok()?;
		reply.same_screen.then_some((reply.root_x, reply.root_y))
	}

	/// Puts the user's pointer back. The warp reports ordinary crossing and
	/// motion, like the user moving the mouse away after the click. Best
	/// effort: the input already landed, so a failed warp must not fail the
	/// action and invite a duplicate retry.
	fn restore_core_pointer(&self, (x, y): (i16, i16)) {
		if self.core_pointer() == Some((x, y)) {
			return;
		}
		if let Ok(cookie) = self.conn.warp_pointer(NONE, self.root, 0, 0, 0, 0, x, y) {
			let _ = cookie.check();
		}
		let _ = self.conn.flush();
	}

	fn pointer_send_event(&self, window: Window, event: &PointerEvent) -> CoreResult<()> {
		// Validate every drag waypoint before a synthetic press can be sent.
		pointer_endpoint(event)?;
		match event {
			PointerEvent::Click { x, y, button, count, modifiers } => {
				let (root_x, root_y, event_x, event_y) = self.coordinates(window, *x, *y)?;
				let detail = button_detail(*button);
				let mut state = modifier_mask(*modifiers);
				for _ in 0..(*count).max(1) {
					self.send_button(window, detail, true, root_x, root_y, event_x, event_y, state)?;
					if let Some(mask) = button_mask(detail) {
						state |= mask;
					}
					thread::sleep(CLICK_DELAY);
					self.send_button(window, detail, false, root_x, root_y, event_x, event_y, state)?;
					if let Some(mask) = button_mask(detail) {
						state = KeyButMask::from(u16::from(state) & !u16::from(mask));
					}
					thread::sleep(CLICK_DELAY);
				}
			},
			PointerEvent::Move { x, y } => {
				let (root_x, root_y, event_x, event_y) = self.coordinates(window, *x, *y)?;
				self.send_motion(window, root_x, root_y, event_x, event_y, KeyButMask::default())?;
			},
			PointerEvent::Drag { path, button, modifiers } => {
				let Some(&(first_x, first_y)) = path.first() else {
					return Err(DesktopError::input_failed("drag path is empty"));
				};
				let detail = button_detail(*button);
				let (root_x, root_y, event_x, event_y) = self.coordinates(window, first_x, first_y)?;
				let mut state = modifier_mask(*modifiers);
				self.send_button(window, detail, true, root_x, root_y, event_x, event_y, state)?;
				if let Some(mask) = button_mask(detail) {
					state |= mask;
				}
				for &(x, y) in path.iter().skip(1) {
					let (root_x, root_y, event_x, event_y) = self.coordinates(window, x, y)?;
					self.send_motion(window, root_x, root_y, event_x, event_y, state)?;
					thread::sleep(DRAG_STEP_DELAY);
				}
				let &(last_x, last_y) = path.last().unwrap_or(&(first_x, first_y));
				let (root_x, root_y, event_x, event_y) = self.coordinates(window, last_x, last_y)?;
				self.send_button(window, detail, false, root_x, root_y, event_x, event_y, state)?;
			},
			PointerEvent::Scroll { x, y, dx, dy } => {
				let (root_x, root_y, event_x, event_y) = self.coordinates(window, *x, *y)?;
				self.scroll_send_event(window, root_x, root_y, event_x, event_y, *dx, *dy)?;
			},
		}
		self.conn.flush().map_err(input_failed)
	}

	/// Real `XTest` pointer input, with the gesture's modifiers held on the core
	/// keyboard and every modifier and button released on all exit paths.
	fn pointer_xtest(&self, event: &PointerEvent) -> CoreResult<()> {
		let (modifiers, button) = match event {
			PointerEvent::Click { modifiers, button, .. }
			| PointerEvent::Drag { modifiers, button, .. } => (*modifiers, Some(button_detail(*button))),
			PointerEvent::Move { .. } | PointerEvent::Scroll { .. } => (Modifiers::default(), None),
		};
		let modifier_keycodes = self.keymap.modifier_keycodes(modifiers)?;
		self.check_released_keys(modifier_keycodes.iter().copied())?;
		let mut pressed = Vec::with_capacity(modifier_keycodes.len());
		let mut result = Ok(());
		for &keycode in &modifier_keycodes {
			pressed.push(keycode);
			if let Err(error) = self.xtest_key(keycode, true) {
				result = Err(error);
				break;
			}
		}
		if result.is_ok() {
			result = self.xtest_gesture(event);
			if result.is_err()
				&& let Some(detail) = button
			{
				let _ = self.xtest_button(detail, false);
			}
		}
		for &keycode in pressed.iter().rev() {
			let released = self.xtest_key(keycode, false);
			if result.is_ok() {
				result = released;
			}
		}
		let flushed = self.conn.flush().map_err(input_failed);
		result.and(flushed)
	}

	fn xtest_gesture(&self, event: &PointerEvent) -> CoreResult<()> {
		match event {
			PointerEvent::Click { x, y, button, count, .. } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				self.xtest_motion(x, y)?;
				let detail = button_detail(*button);
				for index in 0..(*count).max(1) {
					if index > 0 {
						thread::sleep(MULTI_CLICK_GAP);
					}
					self.xtest_button(detail, true)?;
					thread::sleep(CLICK_DELAY);
					self.xtest_button(detail, false)?;
				}
				Ok(())
			},
			PointerEvent::Move { x, y } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				self.xtest_motion(x, y)
			},
			PointerEvent::Drag { path, button, .. } => {
				let Some(&(first_x, first_y)) = path.first() else {
					return Err(DesktopError::input_failed("drag path is empty"));
				};
				let (x, y) = validate_xtest_point(first_x, first_y)?;
				self.xtest_motion(x, y)?;
				let detail = button_detail(*button);
				self.xtest_button(detail, true)?;
				for &(x, y) in path.iter().skip(1) {
					let (x, y) = validate_xtest_point(x, y)?;
					self.xtest_motion(x, y)?;
					thread::sleep(DRAG_STEP_DELAY);
				}
				self.xtest_button(detail, false)
			},
			PointerEvent::Scroll { x, y, dx, dy } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				self.xtest_motion(x, y)?;
				self.scroll_xtest(*dx, *dy)
			},
		}
	}

	fn xtest_steps(&self, steps: &[KeyStep]) -> CoreResult<()> {
		self.check_released_keys(steps.iter().filter(|step| step.press).map(|step| step.keycode))?;
		keymap::run_steps(steps, |step| self.xtest_key(step.keycode, step.press))?;
		self.conn.flush().map_err(input_failed)
	}

	/// Synthetic key events carrying the core modifier state each transition
	/// would have produced, so `ctrl+a` arrives as Control-qualified `a`.
	fn send_key_steps(&self, window: Window, steps: &[KeyStep]) -> CoreResult<()> {
		let mut state = 0u16;
		keymap::run_steps(steps, |step| {
			self.send_key(window, step.keycode, step.press, KeyButMask::from(state))?;
			let mask = self.keymap.modifier_mask(step.keycode);
			if step.press {
				state |= mask;
			} else {
				state &= !mask;
			}
			Ok(())
		})?;
		self.conn.flush().map_err(input_failed)
	}

	fn xtest_key(&self, keycode: u8, press: bool) -> CoreResult<()> {
		if press {
			self.check_takeover_focus()?;
		}
		self
			.conn
			.xtest_fake_input(
				if press {
					KEY_PRESS_EVENT
				} else {
					KEY_RELEASE_EVENT
				},
				keycode,
				CURRENT_TIME,
				self.root,
				0,
				0,
				0,
			)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)
	}

	fn send_key(
		&self,
		window: Window,
		keycode: u8,
		press: bool,
		state: KeyButMask,
	) -> CoreResult<()> {
		let event = KeyPressEvent {
			response_type: if press {
				KEY_PRESS_EVENT
			} else {
				KEY_RELEASE_EVENT
			},
			detail: keycode,
			sequence: 0,
			time: CURRENT_TIME,
			root: self.root,
			event: window,
			child: 0,
			root_x: 0,
			root_y: 0,
			event_x: 0,
			event_y: 0,
			state,
			same_screen: true,
		};
		self
			.conn
			.send_event(
				false,
				window,
				if press {
					EventMask::KEY_PRESS
				} else {
					EventMask::KEY_RELEASE
				},
				event,
			)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)
	}

	fn coordinates(&self, window: Window, x: f64, y: f64) -> CoreResult<(i16, i16, i16, i16)> {
		let root_x = checked_i16(x, "x")?;
		let root_y = checked_i16(y, "y")?;
		let translated = self
			.conn
			.translate_coordinates(self.root, window, root_x, root_y)
			.map_err(input_failed)?
			.reply()
			.map_err(input_failed)?;
		Ok((root_x, root_y, translated.dst_x, translated.dst_y))
	}

	fn send_button(
		&self,
		window: Window,
		detail: u8,
		press: bool,
		root_x: i16,
		root_y: i16,
		event_x: i16,
		event_y: i16,
		state: KeyButMask,
	) -> CoreResult<()> {
		let event = ButtonPressEvent {
			response_type: if press {
				BUTTON_PRESS_EVENT
			} else {
				BUTTON_RELEASE_EVENT
			},
			detail,
			sequence: 0,
			time: CURRENT_TIME,
			root: self.root,
			event: window,
			child: 0,
			root_x,
			root_y,
			event_x,
			event_y,
			state,
			same_screen: true,
		};
		self
			.conn
			.send_event(
				false,
				window,
				if press {
					EventMask::BUTTON_PRESS
				} else {
					EventMask::BUTTON_RELEASE
				},
				event,
			)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)
	}

	fn send_motion(
		&self,
		window: Window,
		root_x: i16,
		root_y: i16,
		event_x: i16,
		event_y: i16,
		state: KeyButMask,
	) -> CoreResult<()> {
		let event = MotionNotifyEvent {
			response_type: MOTION_NOTIFY_EVENT,
			detail: Motion::NORMAL,
			sequence: 0,
			time: CURRENT_TIME,
			root: self.root,
			event: window,
			child: 0,
			root_x,
			root_y,
			event_x,
			event_y,
			state,
			same_screen: true,
		};
		self
			.conn
			.send_event(false, window, EventMask::POINTER_MOTION, event)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)
	}

	fn scroll_send_event(
		&self,
		window: Window,
		root_x: i16,
		root_y: i16,
		event_x: i16,
		event_y: i16,
		dx: f64,
		dy: f64,
	) -> CoreResult<()> {
		for (detail, count) in scroll_buttons(dx, dy) {
			for _ in 0..count {
				self.send_button(
					window,
					detail,
					true,
					root_x,
					root_y,
					event_x,
					event_y,
					KeyButMask::default(),
				)?;
				self.send_button(
					window,
					detail,
					false,
					root_x,
					root_y,
					event_x,
					event_y,
					KeyButMask::default(),
				)?;
			}
		}
		Ok(())
	}

	fn scroll_xtest(&self, dx: f64, dy: f64) -> CoreResult<()> {
		for (detail, count) in scroll_buttons(dx, dy) {
			for _ in 0..count {
				self.xtest_button(detail, true)?;
				self.xtest_button(detail, false)?;
			}
		}
		Ok(())
	}

	fn xtest_motion(&self, x: i16, y: i16) -> CoreResult<()> {
		self.check_takeover_focus()?;
		if self.takeover_target.is_some() {
			self.takeover_pointer.set(Some((x, y)));
		}
		self
			.conn
			.xtest_fake_input(MOTION_NOTIFY_EVENT, 0, CURRENT_TIME, self.root, x, y, 0)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)
	}

	fn xtest_button(&self, detail: u8, press: bool) -> CoreResult<()> {
		if press {
			self.check_takeover_focus()?;
			if let Some(window) = self.takeover_target {
				let (x, y) = self.core_pointer().ok_or_else(|| {
					DesktopError::input_failed("cannot verify the takeover pointer position")
				})?;
				self.wm().check_pointer_target(window, x, y)?;
			}
		}
		self
			.conn
			.xtest_fake_input(
				if press {
					BUTTON_PRESS_EVENT
				} else {
					BUTTON_RELEASE_EVENT
				},
				detail,
				CURRENT_TIME,
				self.root,
				0,
				0,
				0,
			)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)
	}

	fn check_released_keys(&self, keycodes: impl IntoIterator<Item = u8>) -> CoreResult<()> {
		let state = self.conn.query_keymap().map_err(input_failed)?.reply().map_err(input_failed)?;
		if keycodes.into_iter().any(|code| state.keys[usize::from(code / 8)] & (1 << (code % 8)) != 0) {
			return Err(DesktopError::input_failed(
				"a requested key is already physically held; refusing to release the user's key",
			));
		}
		Ok(())
	}

	fn check_takeover_focus(&self) -> CoreResult<()> {
		if let Some(window) = self.takeover_target {
			let wm = self.wm();
			if !wm.is_focused(window, wm.tracks_active_window()) {
				return Err(DesktopError::input_failed(
					"takeover target lost focus during input; remaining input was cancelled",
				));
			}
		}
		Ok(())
	}

	fn requires_core_events(&self, window: Window) -> bool {
		let class = self.conn
			.get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024)
			.ok().and_then(|cookie| cookie.reply().ok())
			.map(|reply| String::from_utf8_lossy(&reply.value).into_owned())
			.unwrap_or_default();
		toolkit::requires_core_events(&class, self.wm().owning_pid(window))
	}

	/// Whether the client behind `window` is known to drop `XSendEvent`
	/// input, judged from its `WM_CLASS` and its process's toolkit.
	fn drops_synthetic_input(&self, window: Window) -> bool {
		let class = self
			.conn
			.get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.map(|reply| String::from_utf8_lossy(&reply.value).into_owned())
			.unwrap_or_default();
		toolkit::class_drops_synthetic(&class)
			|| self
				.wm()
				.owning_pid(window)
				.is_some_and(toolkit::process_drops_synthetic)
	}
}

/// The session's MPX pair, created on first use; `Err` carries why the route
/// is unavailable. A creation failure is remembered for the session.
fn ensure_mpx<'a>(
	slot: &'a mut Option<Mpx>,
	unavailable: &mut Option<String>,
) -> Result<&'a mut Mpx, String> {
	if let Some(reason) = unavailable {
		return Err(reason.clone());
	}
	let mpx = match slot.take() {
		Some(mpx) => mpx,
		None => Mpx::create().map_err(|error| unavailable.insert(error.message).clone())?,
	};
	Ok(slot.insert(mpx))
}

/// Delivers a background pointer event through the virtual master pointer,
/// refusing up front when the point is not on the target, and checking for
/// focus side effects without reactivating or raising the user's windows.
fn pointer_mpx(wm: Wm<'_>, mpx: &mut Mpx, window: Window, event: &PointerEvent) -> CoreResult<()> {
	let path = match event {
		PointerEvent::Click { x, y, .. }
		| PointerEvent::Move { x, y }
		| PointerEvent::Scroll { x, y, .. } => vec![validate_xtest_point(*x, *y)?],
		PointerEvent::Drag { path, .. } => path
			.iter()
			.map(|&(x, y)| validate_xtest_point(x, y))
			.collect::<CoreResult<Vec<_>>>()?,
	};
	let &(x, y) = path
		.first()
		.ok_or_else(|| DesktopError::input_failed("drag path is empty"))?;
	wm.check_pointer_target(window, x, y)?;
	let snapshot = FocusSnapshot::capture(wm);
	let result = match event {
		PointerEvent::Click { button, count, modifiers, .. } => {
			mpx.click(window, (x, y), *button, *count, *modifiers)
		},
		PointerEvent::Move { .. } => mpx.hover(window, (x, y)),
		PointerEvent::Drag { button, modifiers, .. } => mpx.drag(window, &path, *button, *modifiers),
		PointerEvent::Scroll { dx, dy, .. } => mpx.scroll(window, (x, y), *dx, *dy),
	};
	let isolation = snapshot.check(wm, window);
	if isolation.is_err() {
		mpx.inhibit();
	}
	result.and(isolation)
}

/// Cheap up-front check (no device creation) for hosts where the MPX route
/// can never work, so they skip straight to the synthetic fallback instead
/// of paying the slave-bind timeout.
fn mpx_probe(conn: &RustConnection) -> Result<(), String> {
	// XI2 requests require the version handshake on this connection; the
	// foreground pointer restore uses them too.
	let version = conn
		.xinput_xi_query_version(2, 2)
		.ok()
		.and_then(|cookie| cookie.reply().ok());
	if toolkit::kde_x11_uinput_hotplug_is_unsafe_from_env() {
		return Err(
			"uinput hot-plug is disabled on KDE Plasma X11, where it can crash the session".to_owned(),
		);
	}
	if !uinput::accessible() {
		return Err("/dev/uinput is not writable by this process".to_owned());
	}
	if let Some(server) = toolkit::x_server_exe_name()
		&& matches!(server.as_str(), "Xvfb" | "Xtigervnc" | "Xvnc")
	{
		return Err(format!("{server} cannot hot-plug uinput devices"));
	}
	if String::from_utf8_lossy(&conn.setup().vendor)
		.to_ascii_lowercase()
		.contains("tigervnc")
	{
		return Err("TigerVNC servers cannot hot-plug uinput devices".to_owned());
	}
	match version {
		Some(version) if (version.major_version, version.minor_version) >= (2, 2) => Ok(()),
		_ => Err("the X server lacks XInput 2.2".to_owned()),
	}
}

fn pointer_endpoint(event: &PointerEvent) -> CoreResult<(i16, i16)> {
	match event {
		PointerEvent::Click { x, y, .. } | PointerEvent::Move { x, y }
		| PointerEvent::Scroll { x, y, .. } => validate_xtest_point(*x, *y),
		PointerEvent::Drag { path, .. } => {
			let mut last = None;
			for &(x, y) in path {
				last = Some(validate_xtest_point(x, y)?);
			}
			last.ok_or_else(|| DesktopError::input_failed("drag path is empty"))
		}
	}
}

fn input_failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("X11 input request failed: {error}"))
}

fn background_unavailable(window: &str, kind: &str, reason: &str) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"window {window} drops background {kind} events: {reason}; retry with takeover:true or use \
		 ax actions"
	))
}

fn parse_window(id: &str) -> CoreResult<Window> {
	id.parse::<u32>()
		.map_err(|_| DesktopError::window_not_found(format!("invalid X11 window id {id}")))
}

fn checked_i16(value: f64, axis: &str) -> CoreResult<i16> {
	if !value.is_finite()
		|| value.round() < f64::from(i16::MIN)
		|| value.round() > f64::from(i16::MAX)
	{
		return Err(DesktopError::invalid_coordinate_frame(format!(
			"X11 {axis} coordinate {value} exceeds the signed 16-bit protocol range"
		)));
	}
	Ok(value.round() as i16)
}

pub fn validate_xtest_point(x: f64, y: f64) -> CoreResult<(i16, i16)> {
	Ok((checked_i16(x, "x")?, checked_i16(y, "y")?))
}

pub(super) const fn button_detail(button: MouseButton) -> u8 {
	match button {
		MouseButton::Left => 1,
		MouseButton::Middle => 2,
		MouseButton::Right => 3,
	}
}

const fn button_mask(detail: u8) -> Option<KeyButMask> {
	match detail {
		1 => Some(KeyButMask::BUTTON1),
		2 => Some(KeyButMask::BUTTON2),
		3 => Some(KeyButMask::BUTTON3),
		_ => None,
	}
}

fn modifier_mask(modifiers: Modifiers) -> KeyButMask {
	let mut mask = KeyButMask::default();
	if modifiers.shift {
		mask |= KeyButMask::SHIFT;
	}
	if modifiers.ctrl {
		mask |= KeyButMask::CONTROL;
	}
	if modifiers.alt {
		mask |= KeyButMask::MOD1;
	}
	if modifiers.meta {
		mask |= KeyButMask::MOD4;
	}
	mask
}

fn scroll_buttons(dx: f64, dy: f64) -> Vec<(u8, u32)> {
	let mut result = Vec::with_capacity(2);
	let vertical = dy.abs().round() as u32;
	if vertical > 0 {
		result.push((if dy < 0.0 { 4 } else { 5 }, vertical));
	}
	let horizontal = dx.abs().round() as u32;
	if horizontal > 0 {
		result.push((if dx < 0.0 { 6 } else { 7 }, horizontal));
	}
	result
}

const fn event_kind(event: &PointerEvent) -> &'static str {
	match event {
		PointerEvent::Click { .. } => "click",
		PointerEvent::Move { .. } => "move",
		PointerEvent::Drag { .. } => "drag",
		PointerEvent::Scroll { .. } => "scroll",
	}
}
