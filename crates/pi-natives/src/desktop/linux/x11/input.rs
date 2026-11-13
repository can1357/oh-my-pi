//! X11 input routing.
//!
//! - Desktop targets drive the user's real pointer and keyboard through
//!   `XTest`.
//! - Background window targets prefer the XI2-MPX virtual master pair (real
//!   XI2-only input on independent devices), refusing when the point is covered
//!   by another window. Without MPX they fall back to `XSendEvent`, except for
//!   toolkits known to drop synthetic events, which get an explicit
//!   `background_unavailable` instead of a silent no-op.
//! - Foreground (`takeover`) activates the target, confirms the WM made it the
//!   active, focused window, injects through `XTest`, then restores the user's
//!   pointer position and previously active window.

use std::{
	cell::Cell,
	sync::Arc,
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
	activity::UserActivity,
	keymap::{self, KeyStep, Keymap},
	mpx::Mpx,
	toolkit, uinput,
	wm::{Atoms, FocusSnapshot, Wm},
};
use crate::desktop::{
	backend::{DeliveryMode, ElementInput, Modifiers, MouseButton, PointerEvent},
	control,
	error::{CoreResult, DesktopError, ErrorCode},
	keys::KeyName,
	linux::{CLICK_DELAY, pace_clicks},
	types::Target,
};

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
/// Why background keys, typed or held, cannot reach a Qt window.
const QT_CORE_KEYBOARD: &str =
	"its Qt toolkit reads core keyboard events, which the XI2-MPX virtual keyboard does not send";

pub struct X11Input {
	conn:             Arc<RustConnection>,
	root:             Window,
	atoms:            Atoms,
	keymap:           Keymap,
	takeover_target:  Option<Window>,
	takeover_pointer: Cell<Option<(i16, i16)>>,
	/// The user's press count a takeover in progress started from.
	takeover_presses: Option<u64>,
	/// The press count [`Self::admit_takeover`] let the request's takeover
	/// start from, before the worker took the input lease.
	admitted:         Option<u64>,
	/// The user's own presses, watched from the session's first capture or
	/// takeover ([`Self::watch_user`]).
	activity:         Option<UserActivity>,
	/// The display `activity` listens on; `None` is `DISPLAY`'s.
	display:          Option<String>,
	/// XI2 could not report the user's presses; not asked again.
	activity_failed:  Option<DesktopError>,
	/// Session-lived virtual master pair, created on first background use.
	mpx:              Option<Mpx>,
	/// Why the XI2-MPX route is unusable. Set once, so a host that cannot
	/// hot-plug devices is not re-probed (and its hierarchy not churned) on
	/// every action.
	mpx_unavailable:  Option<String>,
}

/// Keyboard input to plan against a keymap.
#[derive(Clone, Copy)]
enum Keys<'a> {
	Text(&'a str),
	Chord(&'a [KeyName]),
	Hold(&'a [KeyName], Duration),
}

impl Keys<'_> {
	const fn duration(self) -> Duration {
		if let Self::Hold(_, duration) = self {
			duration
		} else {
			Duration::ZERO
		}
	}

	const fn kind(self) -> &'static str {
		match self {
			Self::Text(_) => "text",
			Self::Chord(_) | Self::Hold(..) => "key",
		}
	}

	fn plan(self, keymap: &Keymap) -> CoreResult<Vec<KeyStep>> {
		match self {
			Self::Text(text) => keymap.plan_text(text),
			Self::Chord(keys) | Self::Hold(keys, _) => keymap.plan_chord(keys),
		}
	}
}

impl X11Input {
	pub(crate) fn new(
		conn: Arc<RustConnection>,
		root: Window,
		display: Option<String>,
	) -> CoreResult<Self> {
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
			conn,
			root,
			atoms,
			keymap,
			takeover_target: None,
			takeover_pointer: Cell::new(None),
			takeover_presses: None,
			admitted: None,
			activity: None,
			display,
			activity_failed: None,
			mpx: None,
			mpx_unavailable,
		})
	}

	pub(crate) fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		if matches!(target, Target::Desktop | Target::Display(_)) || mode != DeliveryMode::Background
		{
			self.keymap = Keymap::xtest(&self.conn)?;
		}
		match (target, mode) {
			(Target::Desktop | Target::Display(_), _) => self.pointer_xtest(&event),
			(Target::Window(id), DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus) => {
				let window = parse_window(id)?;
				pointer_endpoint(&event)?;
				// Takeover presses through the same grab: refuse rather than
				// report a press the popup took.
				if let Some(popup) = self.popup_outside(window, &event)? {
					return Err(DesktopError::input_failed(format!(
						"window {id}: {}; no input was sent",
						popup_press_reason(popup)
					)));
				}
				self.with_foreground(window, FOREGROUND_POINTER_SETTLE, |this| {
					this.pointer_xtest(&event)
				})
			},
			(Target::Window(id), DeliveryMode::Background) => {
				let window = parse_window(id)?;
				if let Some(popup) = self.popup_outside(window, &event)? {
					return Err(background_unavailable(
						id,
						event_kind(&event),
						&popup_press_reason(popup),
					));
				}
				if self.requires_core_events(window) {
					if self.drops_synthetic_input(window) {
						return Err(background_unavailable(
							id,
							event_kind(&event),
							"its toolkit needs core input, which cannot preserve MPX focus isolation",
						));
					}
					return self.pointer_send_event(window, &event);
				}
				// Qt reads modifiers off the XI2 pointer events; other held keys
				// only as core key events.
				let holds_keys = matches!(
					&event,
					PointerEvent::Hold { keys, .. } | PointerEvent::Drag { keys, .. }
						if keys.iter().any(|key| !key.is_modifier())
				);
				if holds_keys && self.reads_core_keyboard(window) {
					return Err(background_unavailable(id, event_kind(&event), QT_CORE_KEYBOARD));
				}
				let reason = match ensure_mpx(&mut self.mpx, &mut self.mpx_unavailable) {
					Ok(mpx) => {
						let wm = Wm { conn: &self.conn, root: self.root, atoms: &self.atoms };
						let result = pointer_mpx(wm, mpx, window, &event);
						if control::check().is_err() {
							// Retire cancelled devices, never replay uncertain queued
							// input. A later explicit operation takes a pair again
							// with fresh slaves.
							self.mpx = None;
						}
						return result;
					},
					Err(reason) => {
						control::check()?;
						reason
					},
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

	/// Takeover keys into `window`, with `prepare` run inside the takeover
	/// once the user's window is recorded, so an activation `prepare` causes,
	/// such as an AT-SPI focus request, is handed back with the takeover.
	pub(crate) fn foreground_keys_after(
		&mut self,
		window: Window,
		input: &ElementInput,
		prepare: impl FnOnce() -> CoreResult<()>,
	) -> CoreResult<()> {
		self.keymap = Keymap::core(&self.conn)?;
		let keys = match input {
			ElementInput::Text(text) => Keys::Text(text),
			ElementInput::Chord(keys) => Keys::Chord(keys),
		};
		let steps = keys.plan(&self.keymap)?;
		self.with_foreground(window, FOREGROUND_KEYBOARD_SETTLE, |this| {
			this.check_user()?;
			prepare()?;
			this.xtest_steps(&steps, keys.duration())
		})
	}

	pub(crate) fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: Duration,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.keys(target, Keys::Hold(keys, duration), mode)
	}

	/// Persistent activation: the target stays active afterwards.
	pub(crate) fn raise_window(&self, window: Window) -> CoreResult<()> {
		if let Some(mpx) = &self.mpx {
			mpx.release_focus(window)?;
		}
		let wm = self.wm();
		wm.request_activation(window, wm.active_window(), || Ok(()))
	}

	/// Starts watching the user's presses, so the session's first takeover
	/// knows whether they were just typing.
	pub(super) fn watch_user(&mut self) -> CoreResult<&UserActivity> {
		if let Some(error) = &self.activity_failed {
			return Err(error.clone());
		}
		if self.activity.is_none() {
			match UserActivity::start(self.display.as_deref()) {
				Ok(activity) => self.activity = Some(activity),
				Err(error) => {
					self.activity_failed = Some(error.clone());
					return Err(error);
				},
			}
		}
		Ok(self.activity.as_ref().expect("listener started"))
	}

	/// Waits until the user has paused ([`UserActivity::admit`]), before the
	/// worker takes the input lease for a window or element takeover.
	pub(crate) fn admit_takeover(&mut self) -> CoreResult<()> {
		self.admitted = None;
		self.admitted = Some(self.watch_user()?.admit()?);
		Ok(())
	}

	/// Whether the user has pressed nothing since [`Self::admit_takeover`].
	pub(crate) fn takeover_admitted(&mut self) -> CoreResult<bool> {
		let Some(baseline) = self.admitted else {
			return Ok(false);
		};
		match self.watch_user()?.check_admission(baseline) {
			Ok(()) => Ok(true),
			Err(error) if error.code == ErrorCode::UserIntervened => Ok(false),
			Err(error) => Err(error),
		}
	}

	fn wm(&self) -> Wm<'_> {
		Wm { conn: &self.conn, root: self.root, atoms: &self.atoms }
	}

	/// The topmost popup of `window`'s process that may hold the pointer grab,
	/// when `event` would press outside every such popup: the toolkit hands
	/// that press to the popup, which closes and takes it, and the window never
	/// gets it. An earlier session can leave such a menu open. Plain moves pass.
	fn popup_outside(&self, window: Window, event: &PointerEvent) -> CoreResult<Option<Window>> {
		let (x, y) = match event {
			PointerEvent::Move { .. } => return Ok(None),
			PointerEvent::Click { x, y, .. }
			| PointerEvent::Hold { x, y, .. }
			| PointerEvent::Scroll { x, y, .. } => (*x, *y),
			PointerEvent::Drag { path, .. } => match path.first() {
				Some(&point) => point,
				None => return Ok(None),
			},
		};
		let (x, y) = validate_xtest_point(x, y)?;
		let wm = self.wm();
		let Some(pid) = wm.owning_pid(window) else {
			return Ok(None);
		};
		let popups = wm.grab_popups_of(pid);
		if popups.iter().any(|&popup| wm.contains_point(popup, x, y)) {
			return Ok(None);
		}
		Ok(popups.first().copied())
	}

	fn keys(&mut self, target: &Target, keys: Keys<'_>, mode: DeliveryMode) -> CoreResult<()> {
		// `XSendEvent` keys are read in the core map, `XTest` keys in its
		// device's.
		self.keymap = if matches!(target, Target::Window(_)) && mode == DeliveryMode::Background {
			Keymap::core(&self.conn)?
		} else {
			Keymap::xtest(&self.conn)?
		};
		match (target, mode) {
			(Target::Desktop | Target::Display(_), _) => {
				let steps = keys.plan(&self.keymap)?;
				self.xtest_steps(&steps, keys.duration())
			},
			(Target::Window(id), DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus) => {
				let window = parse_window(id)?;
				let steps = keys.plan(&self.keymap)?;
				self.with_foreground(window, FOREGROUND_KEYBOARD_SETTLE, |this| {
					this.xtest_steps(&steps, keys.duration())
				})
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
				return Err(background_unavailable(
					id,
					keys.kind(),
					"its toolkit needs core input, which cannot preserve MPX focus isolation",
				));
			}
			let steps = keys.plan(&self.keymap)?;
			return self.send_key_steps(window, &steps, keys.duration());
		}
		let pid = self.wm().owning_pid(window);
		// Empty text plans no keys, so it stays the no-op it is everywhere.
		if pid.is_some_and(toolkit::process_reads_core_keyboard) && !matches!(keys, Keys::Text("")) {
			return Err(background_unavailable(id, keys.kind(), QT_CORE_KEYBOARD));
		}
		let reason = match ensure_mpx(&mut self.mpx, &mut self.mpx_unavailable) {
			Ok(mpx) => {
				let wm = Wm { conn: &self.conn, root: self.root, atoms: &self.atoms };
				if let Some(pid) = pid
					&& let Some(popup) = wm.grab_popup_of(pid)
				{
					return Err(background_unavailable(
						id,
						keys.kind(),
						&format!(
							"popup {popup} may hold an input grab; background input cannot safely \
							 substitute the user's core keyboard"
						),
					));
				}
				let snapshot = FocusSnapshot::capture(wm);
				let result = match keys {
					Keys::Text(text) => mpx.type_text(window, text),
					Keys::Chord(chord) => mpx.key_chord(window, chord),
					Keys::Hold(keys, duration) => mpx.hold_keys(window, keys, duration),
				};
				let isolation = snapshot.check(wm, window);
				if isolation.is_err() {
					mpx.inhibit();
				}
				if control::check().is_err() {
					self.mpx = None;
				}
				return isolated(result, isolation);
			},
			Err(reason) => {
				control::check()?;
				reason
			},
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
		self.send_key_steps(window, &steps, keys.duration())
	}

	/// Starts from the worker's admission ([`Self::admit_takeover`]), failing
	/// if the user pressed a key or button since (without one, as when tests
	/// drive this directly, waits for the user to pause here), activates
	/// `window`, confirms the WM made it the active window holding the core
	/// focus, runs `body` until the user presses a key or button, then restores
	/// the user's pointer position and previously active window. Fails without
	/// sending input when the activation is never confirmed.
	fn with_foreground<T>(
		&mut self,
		window: Window,
		budget: Duration,
		body: impl FnOnce(&mut Self) -> CoreResult<T>,
	) -> CoreResult<T> {
		let presses = match self.admitted {
			Some(baseline) => {
				self.watch_user()?.check_admission(baseline)?;
				baseline
			},
			None => self.watch_user()?.admit()?,
		};
		// The activation's core `FocusIn` reaches the target and its window
		// manager only when no other keyboard focuses it.
		if let Some(mpx) = &self.mpx {
			mpx.release_focus(window)?;
		}
		let wm = self.wm();
		let ewmh = wm.tracks_active_window();
		let previous_active = wm.active_window();
		let previous_focus = wm.input_focus();
		let pointer = self.core_pointer();
		self.takeover_presses = Some(presses);
		if let Err(error) = self.activate_confirmed(window, ewmh, previous_active, budget) {
			return self.finish_takeover(Err(error), |this| {
				control::cleanup(|| {
					this.restore_activation(window, ewmh, previous_active, previous_focus);
				});
			});
		}
		self.takeover_target = Some(window);
		self.takeover_pointer.set(None);
		#[cfg(test)]
		named_change_tests::before_body();
		let result = body(self);
		self.takeover_target = None;
		let pointer_after = self.takeover_pointer.take();
		self.finish_takeover(result, |this| {
			control::settle(FOREGROUND_RESTORE_SETTLE);
			control::cleanup(|| {
				// A physical motion during the action is the user's new position.
				// Keyboard-only actions never warp the pointer, even during
				// restore.
				if let Some(pointer) = pointer
					&& pointer_after.is_some()
					&& this.core_pointer() == pointer_after
					&& this.check_user().is_ok()
					&& super::listener::buttons_held(&this.conn).is_ok_and(|held| !held)
				{
					this.restore_core_pointer(pointer);
				}
				this.restore_activation(window, ewmh, previous_active, previous_focus);
			});
		})
	}

	/// The successful body is not final until focus has been handed back.
	fn finish_takeover<T>(
		&mut self,
		result: CoreResult<T>,
		hand_back: impl FnOnce(&Self),
	) -> CoreResult<T> {
		hand_back(self);
		let intervened = self.check_user();
		self.takeover_presses = None;
		result.and_then(|value| intervened.map(|()| value))
	}

	fn activate_confirmed(
		&self,
		window: Window,
		ewmh: bool,
		previous_active: Option<Window>,
		budget: Duration,
	) -> CoreResult<()> {
		control::check()?;
		self.check_user()?;
		let wm = self.wm();
		// Already active and focused: re-activating pops open menus down.
		if wm.is_focused(window, ewmh) {
			return Ok(());
		}
		wm.request_activation(window, previous_active, || self.check_user())?;
		let start = Instant::now();
		let retry_at = start + budget.mul_f32(0.4);
		let mut retried = false;
		loop {
			// The request is out: a cancel or press still lets the WM finish
			// it, so the hand-back sees the move and undoes it.
			if let Err(error) = control::check().and_then(|()| self.check_user()) {
				wm.await_activation(window);
				return Err(error);
			}
			if wm.is_focused(window, ewmh) {
				return Ok(());
			}
			let now = Instant::now();
			if now >= start + budget {
				break;
			}
			if !retried && now >= retry_at {
				retried = true;
				let _ = wm.request_activation(window, wm.active_window(), || self.check_user());
			}
			// A cancel is handled at the top of the loop.
			let _ = control::wait(FOREGROUND_POLL);
		}
		Err(DesktopError::input_failed(format!(
			"window {window} did not become the active, focused window within {}ms (it may be \
			 minimized, on another workspace, or blocked by a modal dialog); no input was sent",
			budget.as_millis()
		)))
	}

	/// Restores the previous WM activation and core focus while the target
	/// still holds the keyboard; EWMH activation can lag the actual focus.
	fn restore_activation(
		&self,
		window: Window,
		ewmh: bool,
		previous_active: Option<Window>,
		previous_focus: Option<(Window, InputFocus)>,
	) {
		let wm = self.wm();
		// Core focus says where keys land. A newer switch away from the
		// target belongs to the user, regardless of the WM's property.
		if !wm
			.input_focus()
			.is_some_and(|(focus, _)| wm.is_within(focus, window))
		{
			return;
		}
		if ewmh && let Some(previous) = previous_active.filter(|&previous| previous != window) {
			let _ = wm.restore_activation(previous, window);
			let deadline = Instant::now() + FOREGROUND_RESTORE_BUDGET;
			while Instant::now() < deadline
				&& (wm.active_window() == Some(window) || wm.is_focused(window, false))
			{
				let _ = control::wait(FOREGROUND_POLL);
			}
		}
		if let Some((focus, revert)) = previous_focus
			&& focus > 1
			&& wm
				.input_focus()
				.is_some_and(|(now, _)| wm.is_within(now, window))
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

	fn pointer_send_event(&mut self, window: Window, event: &PointerEvent) -> CoreResult<()> {
		pointer_endpoint(event)?;
		let keys = match event {
			PointerEvent::Hold { keys, .. } | PointerEvent::Drag { keys, .. } => keys.as_slice(),
			_ => &[],
		};
		// `XSendEvent` keys are read in the core map; an earlier `XTest` call
		// left the `XTest` keyboard's.
		if !keys.is_empty() {
			self.keymap = Keymap::core(&self.conn)?;
		}
		let codes = self.keymap.held_keycodes(keys)?;
		let mut state = 0u16;
		keymap::with_held_codes(
			&codes,
			|step| {
				self.send_key(window, step.keycode, step.press, KeyButMask::from(state))?;
				let mask = self.keymap.modifier_mask(step.keycode);
				if step.press {
					state |= mask;
				} else {
					state &= !mask;
				}
				Ok(())
			},
			|| self.pointer_send_event_body(window, event),
		)
	}

	fn pointer_send_event_body(&self, window: Window, event: &PointerEvent) -> CoreResult<()> {
		match event {
			PointerEvent::Click { x, y, button, count, modifiers } => {
				let (root_x, root_y, event_x, event_y) = self.coordinates(window, *x, *y)?;
				let detail = button_detail(*button);
				let mut state = modifier_mask(*modifiers);
				let count = (*count).max(1);
				for index in 0..count {
					let sent = index + 1 == count;
					control::check()?;
					let pressed =
						self.send_button(window, detail, true, root_x, root_y, event_x, event_y, state);
					if let Some(mask) = button_mask(detail) {
						state |= mask;
					}
					let held = pressed.and_then(|()| control::sent_gap_wait(CLICK_DELAY, sent));
					let released = control::cleanup(|| {
						self.send_button(window, detail, false, root_x, root_y, event_x, event_y, state)
					});
					held.and(released)?;
					if let Some(mask) = button_mask(detail) {
						state = KeyButMask::from(u16::from(state) & !u16::from(mask));
					}
					control::sent_gap_wait(CLICK_DELAY, sent)?;
				}
			},
			PointerEvent::Hold { x, y, button, keys, duration } => {
				let (rx, ry, ex, ey) = self.coordinates(window, *x, *y)?;
				let detail = button_detail(*button);
				let state = modifier_mask(control::key_modifiers(keys));
				control::bounded_hold(*duration, |down| {
					self.send_button(window, detail, down, rx, ry, ex, ey, state)
				})?;
			},
			PointerEvent::Move { x, y } => {
				let (root_x, root_y, event_x, event_y) = self.coordinates(window, *x, *y)?;
				self.send_motion(window, root_x, root_y, event_x, event_y, KeyButMask::default())?;
			},
			PointerEvent::Drag { path, button, modifiers, keys } => {
				let Some(&(first_x, first_y)) = path.first() else {
					return Err(DesktopError::input_failed("drag path is empty"));
				};
				let detail = button_detail(*button);
				let (root_x, root_y, event_x, event_y) = self.coordinates(window, first_x, first_y)?;
				let mut state = modifier_mask(*modifiers) | modifier_mask(control::key_modifiers(keys));
				control::check()?;
				let pressed =
					self.send_button(window, detail, true, root_x, root_y, event_x, event_y, state);
				if let Some(mask) = button_mask(detail) {
					state |= mask;
				}
				let mut last = (root_x, root_y, event_x, event_y);
				let moved = (|| {
					pressed?;
					let final_point = path.len().saturating_sub(2);
					for (index, &(x, y)) in path.iter().skip(1).enumerate() {
						control::check()?;
						last = self.coordinates(window, x, y)?;
						self.send_motion(window, last.0, last.1, last.2, last.3, state)?;
						control::sent_gap_wait(DRAG_STEP_DELAY, index == final_point)?;
					}
					Ok(())
				})();
				let released = control::cleanup(|| {
					self.send_button(window, detail, false, last.0, last.1, last.2, last.3, state)
				});
				moved.and(released)?;
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
		let modifiers = match event {
			PointerEvent::Click { modifiers, .. } | PointerEvent::Drag { modifiers, .. } => *modifiers,
			PointerEvent::Move { .. } | PointerEvent::Scroll { .. } | PointerEvent::Hold { .. } => {
				Modifiers::default()
			},
		};
		let mut modifier_keycodes = self.keymap.modifier_keycodes(modifiers)?;
		if let PointerEvent::Hold { keys, .. } | PointerEvent::Drag { keys, .. } = event {
			for code in self.keymap.held_keycodes(keys)? {
				if !modifier_keycodes.contains(&code) {
					modifier_keycodes.push(code);
				}
			}
		}
		self.check_released_keys(modifier_keycodes.iter().copied())?;
		let mut pressed = Vec::with_capacity(modifier_keycodes.len());
		let mut result = Ok(());
		for &keycode in &modifier_keycodes {
			if let Err(error) = control::check() {
				result = Err(error);
				break;
			}
			pressed.push(keycode);
			if let Err(error) = self.xtest_key(keycode, true) {
				result = Err(error);
				break;
			}
		}
		if result.is_ok() {
			result = self.xtest_gesture(event);
		}
		for &keycode in pressed.iter().rev() {
			let released = control::cleanup(|| self.xtest_key(keycode, false));
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
				pace_clicks(*count, |pressed| self.xtest_button(detail, pressed))
			},
			PointerEvent::Hold { x, y, button, duration, .. } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				self.xtest_motion(x, y)?;
				let detail = button_detail(*button);
				control::bounded_hold(*duration, |down| self.xtest_button(detail, down))
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
				control::check()?;
				let dragged = (|| {
					self.xtest_button(detail, true)?;
					let final_point = path.len().saturating_sub(2);
					for (index, &(x, y)) in path.iter().skip(1).enumerate() {
						let (x, y) = validate_xtest_point(x, y)?;
						self.xtest_motion(x, y)?;
						control::sent_gap_wait(DRAG_STEP_DELAY, index == final_point)?;
					}
					Ok(())
				})();
				let released = control::cleanup(|| self.xtest_button(detail, false));
				dragged.and(released)
			},
			PointerEvent::Scroll { x, y, dx, dy } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				self.xtest_motion(x, y)?;
				self.scroll_xtest(*dx, *dy)
			},
		}
	}

	fn xtest_steps(&self, steps: &[KeyStep], duration: Duration) -> CoreResult<()> {
		self.check_released_keys(
			steps
				.iter()
				.filter(|step| step.press)
				.map(|step| step.keycode),
		)?;
		keymap::run_steps_with_hold(steps, duration, |step| {
			self.xtest_key(step.keycode, step.press)
		})?;
		self.conn.flush().map_err(input_failed)
	}

	/// Synthetic key events carrying the core modifier state each transition
	/// would have produced, so `ctrl+a` arrives as Control-qualified `a`.
	fn send_key_steps(
		&self,
		window: Window,
		steps: &[KeyStep],
		duration: Duration,
	) -> CoreResult<()> {
		let mut state = 0u16;
		keymap::run_steps_with_hold(steps, duration, |step| {
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
		// A release always goes out: a cancel stops only the next press.
		if press {
			control::check()?;
			self.check_takeover_focus()?;
		}
		self.send_xtest(press, || {
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
		})
	}

	/// Sends one XTEST event, counting a press as this session's own before
	/// it can reach the user-activity listener.
	fn send_xtest(&self, press: bool, send: impl FnOnce() -> CoreResult<()>) -> CoreResult<()> {
		let activity = self.activity.as_ref().filter(|_| press);
		if let Some(activity) = activity {
			activity.sending(false);
		}
		let result = send();
		if result.is_err()
			&& let Some(activity) = activity
		{
			activity.sending(true);
		}
		result
	}

	fn send_key(
		&self,
		window: Window,
		keycode: u8,
		press: bool,
		state: KeyButMask,
	) -> CoreResult<()> {
		if press {
			control::check()?;
		}
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
		control::check()?;
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
		control::check()?;
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
				control::check()?;
				let pressed = self.send_button(
					window,
					detail,
					true,
					root_x,
					root_y,
					event_x,
					event_y,
					KeyButMask::default(),
				);
				let released = control::cleanup(|| {
					self.send_button(
						window,
						detail,
						false,
						root_x,
						root_y,
						event_x,
						event_y,
						KeyButMask::default(),
					)
				});
				pressed.and(released)?;
			}
		}
		Ok(())
	}

	fn scroll_xtest(&self, dx: f64, dy: f64) -> CoreResult<()> {
		for (detail, count) in scroll_buttons(dx, dy) {
			for _ in 0..count {
				control::check()?;
				let pressed = self.xtest_button(detail, true);
				let released = control::cleanup(|| self.xtest_button(detail, false));
				pressed.and(released)?;
			}
		}
		Ok(())
	}

	fn xtest_motion(&self, x: i16, y: i16) -> CoreResult<()> {
		control::check()?;
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
		control::check()?;
		if press {
			self.check_takeover_focus()?;
			if let Some(window) = self.takeover_target {
				let (x, y) = self.core_pointer().ok_or_else(|| {
					DesktopError::input_failed("cannot verify the takeover pointer position")
				})?;
				// The takeover already moved the core pointer, and maybe clicked.
				self.wm().check_pointer_target(window, x, y, true)?;
			}
		}
		self.send_xtest(press, || {
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
		})
	}

	fn check_released_keys(&self, keycodes: impl IntoIterator<Item = u8>) -> CoreResult<()> {
		let state = self
			.conn
			.query_keymap()
			.map_err(input_failed)?
			.reply()
			.map_err(input_failed)?;
		if keycodes
			.into_iter()
			.any(|code| state.keys[usize::from(code / 8)] & (1 << (code % 8)) != 0)
		{
			return Err(DesktopError::input_failed(
				"a requested key is already physically held; refusing to release the user's key",
			));
		}
		Ok(())
	}

	fn check_takeover_focus(&self) -> CoreResult<()> {
		self.check_user()?;
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

	/// Refuses the rest of a takeover once the user has pressed a key or
	/// button since it was admitted: the target holds the keyboard.
	fn check_user(&self) -> CoreResult<()> {
		match (&self.activity, self.takeover_presses) {
			(Some(activity), Some(baseline)) => activity.check(baseline),
			_ => Ok(()),
		}
	}

	/// Whether `window`'s process takes keys only as core events
	/// ([`toolkit::process_reads_core_keyboard`]).
	fn reads_core_keyboard(&self, window: Window) -> bool {
		self
			.wm()
			.owning_pid(window)
			.is_some_and(toolkit::process_reads_core_keyboard)
	}

	fn requires_core_events(&self, window: Window) -> bool {
		let class = self
			.conn
			.get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.map_or_default(|reply| String::from_utf8_lossy_owned(reply.value));
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
			.map_or_default(|reply| String::from_utf8_lossy_owned(reply.value));
		toolkit::class_drops_synthetic(&class)
			|| self
				.wm()
				.owning_pid(window)
				.is_some_and(toolkit::process_drops_synthetic)
	}
}

/// The session's MPX pair, created on first use; `Err` carries why the route
/// is unavailable. Capability failures, but not contention, are remembered.
fn ensure_mpx<'a>(
	slot: &'a mut Option<Mpx>,
	unavailable: &mut Option<String>,
) -> Result<&'a mut Mpx, String> {
	if let Some(reason) = unavailable {
		return Err(reason.clone());
	}
	let mpx = match slot.take() {
		Some(mpx) => mpx,
		None => Mpx::create().map_err(|error| {
			if error.code == ErrorCode::InputBusy || control::check().is_err() {
				error.message
			} else {
				unavailable.insert(error.message).clone()
			}
		})?,
	};
	Ok(slot.insert(mpx))
}

/// Delivers a background pointer event through the virtual master pointer,
/// refusing up front when the point is not on the target, and checking for
/// focus side effects without reactivating or raising the user's windows.
fn pointer_mpx(wm: Wm<'_>, mpx: &mut Mpx, window: Window, event: &PointerEvent) -> CoreResult<()> {
	let path = match event {
		PointerEvent::Click { x, y, .. }
		| PointerEvent::Hold { x, y, .. }
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
	wm.check_pointer_target(window, x, y, false)?;
	let snapshot = FocusSnapshot::capture(wm);
	let result = match event {
		PointerEvent::Click { button, count, modifiers, .. } => {
			mpx.click(window, (x, y), *button, *count, *modifiers)
		},
		PointerEvent::Move { .. } => mpx.hover(window, (x, y)),
		PointerEvent::Drag { button, modifiers, keys, .. } => {
			mpx.drag(window, &path, *button, *modifiers, keys)
		},
		PointerEvent::Hold { button, keys, duration, .. } => {
			mpx.hold_mouse(window, (x, y), *button, keys, *duration)
		},
		PointerEvent::Scroll { dx, dy, .. } => mpx.scroll(window, (x, y), *dx, *dy),
	};
	let isolation = snapshot.check(wm, window);
	if isolation.is_err() {
		mpx.inhibit();
	}
	isolated(result, isolation)
}

/// Joins an MPX call's result with its focus-isolation check. A clean refusal
/// yields to an isolation failure: the call then already disturbed focus, so
/// it is not a refusal the host may rerun in takeover.
fn isolated(result: CoreResult<()>, isolation: CoreResult<()>) -> CoreResult<()> {
	match result {
		Err(error) if error.code == ErrorCode::BackgroundUnavailable => isolation.and(Err(error)),
		result => result.and(isolation),
	}
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
		PointerEvent::Click { x, y, .. }
		| PointerEvent::Hold { x, y, .. }
		| PointerEvent::Move { x, y }
		| PointerEvent::Scroll { x, y, .. } => validate_xtest_point(*x, *y),
		PointerEvent::Drag { path, .. } => {
			let mut last = None;
			for &(x, y) in path {
				last = Some(validate_xtest_point(x, y)?);
			}
			last.ok_or_else(|| DesktopError::input_failed("drag path is empty"))
		},
	}
}

fn input_failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("X11 input request failed: {error}"))
}

fn background_unavailable(window: &str, kind: &str, reason: &str) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"window {window} drops background {kind} events: {reason}; no input was sent"
	))
}

fn popup_press_reason(popup: Window) -> String {
	format!(
		"popup {popup} of its app may hold the pointer grab, and a press outside it would only \
		 close it; target window {popup} to press inside it, or close it first"
	)
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
		PointerEvent::Hold { .. } => "mouse hold",
		PointerEvent::Scroll { .. } => "scroll",
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	#[ignore = "needs an isolated Xorg display with uinput hotplug"]
	fn temporary_pair_contention_does_not_disable_mpx_for_the_session() {
		let first = Mpx::create().unwrap();
		let _second = Mpx::create().unwrap();
		let mut slot = None;
		let mut unavailable = None;
		assert!(ensure_mpx(&mut slot, &mut unavailable).is_err(), "both pairs are held");
		drop(first);
		assert!(
			ensure_mpx(&mut slot, &mut unavailable).is_ok(),
			"a later action takes the freed pair"
		);
	}

	#[test]
	fn a_refusal_that_disturbed_focus_is_not_rerunnable() {
		let refused = || Err(DesktopError::background_unavailable("covered; no input was sent"));
		let disturbed = || Err(DesktopError::input_failed("focus moved"));

		let error = isolated(refused(), disturbed()).unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert_eq!(error.message, "focus moved");

		assert_eq!(isolated(refused(), Ok(())).unwrap_err().code, ErrorCode::BackgroundUnavailable);
		let failed = isolated(Err(DesktopError::input_failed("lost")), disturbed()).unwrap_err();
		assert_eq!(failed.message, "lost");
		assert_eq!(isolated(Ok(()), disturbed()).unwrap_err().message, "focus moved");
	}

	/// Starts its own `Xvfb`: `cargo test -p pi-natives -- --ignored
	/// typing_user`.
	#[test]
	#[ignore = "starts Xvfb"]
	fn a_takeover_refuses_a_typing_user_but_not_its_own_keys() {
		use std::{
			io::{BufRead, BufReader},
			process::{Child, Command, Stdio},
		};

		use x11rb::{
			protocol::xproto::{CreateWindowAux, WindowClass},
			wrapper::ConnectionExt as _,
		};

		use crate::desktop::{control::CancellationSource, keys::parse_key};

		struct Server(Child);
		impl Drop for Server {
			fn drop(&mut self) {
				let _ = self.0.kill();
				let _ = self.0.wait();
			}
		}
		let mut server = Server(
			Command::new("Xvfb")
				.args(["-displayfd", "1", "-screen", "0", "320x240x24", "-nolisten", "tcp"])
				.stdout(Stdio::piped())
				.stderr(Stdio::null())
				.spawn()
				.expect("Xvfb starts"),
		);
		let mut number = String::new();
		BufReader::new(server.0.stdout.take().expect("Xvfb stdout"))
			.read_line(&mut number)
			.expect("Xvfb reports its display");
		let display = format!(":{}", number.trim());
		let connect = || x11rb::connect(Some(&display)).expect("connect").0;
		// The target app, which counts the key presses it gets.
		let app = connect();
		let root = app.setup().roots[0].root;
		let target = app.generate_id().expect("id");
		app.create_window(
			x11rb::COPY_DEPTH_FROM_PARENT,
			target,
			root,
			0,
			0,
			100,
			100,
			0,
			WindowClass::INPUT_OUTPUT,
			x11rb::COPY_FROM_PARENT,
			&CreateWindowAux::new().event_mask(EventMask::KEY_PRESS),
		)
		.expect("window");
		app.map_window(target).expect("map");
		app.sync().expect("sync");
		let keys_received = || {
			app.sync().expect("sync");
			std::iter::from_fn(|| app.poll_for_event().expect("event"))
				.filter(|event| matches!(event, x11rb::protocol::Event::KeyPress(_)))
				.count()
		};
		let conn = Arc::new(connect());
		let mut input = X11Input::new(Arc::clone(&conn), root, Some(display.clone())).expect("input");
		let user = connect();
		let modifier = input
			.keymap
			.plan_chord(&[parse_key("shift").expect("modifier")])
			.expect("modifier plan")[0]
			.keycode;
		// Both holds predate observation; the button is beyond the five
		// buttons exposed in the core QueryPointer mask.
		for (event, detail) in [(KEY_PRESS_EVENT, modifier), (BUTTON_PRESS_EVENT, 8)] {
			user
				.xtest_fake_input(event, detail, CURRENT_TIME, root, 0, 0, 0)
				.expect("hold before watching")
				.check()
				.expect("held");
		}
		let activity = input.watch_user().expect("watching");
		assert_eq!(activity.check_admission(0).unwrap_err().code, ErrorCode::UserIntervened);
		user
			.xtest_fake_input(KEY_RELEASE_EVENT, modifier, CURRENT_TIME, root, 0, 0, 0)
			.expect("release modifier")
			.check()
			.expect("released");
		assert_eq!(activity.check_admission(0).unwrap_err().code, ErrorCode::UserIntervened);
		user
			.xtest_fake_input(BUTTON_RELEASE_EVENT, 8, CURRENT_TIME, root, 0, 0, 0)
			.expect("release button")
			.check()
			.expect("released");
		activity.check_admission(0).expect("all inputs released");
		let id = Target::Window(target.to_string());
		let key = [parse_key("a").expect("key")];

		input
			.key_chord(&id, &key, DeliveryMode::Foreground)
			.expect("takeover, user idle");
		assert!(keys_received() >= 1, "the takeover's key reached the target");
		// The user types through another XTEST client, as x11vnc does, while
		// it holds a grab: XI 2.0 listeners miss precisely these presses.
		let code = input.keymap.plan_chord(&key).expect("plan")[0].keycode;
		let error = input
			.with_foreground(target, Duration::from_secs(2), |input| {
				let grabbed = user
					.grab_keyboard(
						false,
						target,
						CURRENT_TIME,
						x11rb::protocol::xproto::GrabMode::ASYNC,
						x11rb::protocol::xproto::GrabMode::ASYNC,
					)
					.expect("grab")
					.reply()
					.expect("grab reply");
				assert_eq!(grabbed.status, x11rb::protocol::xproto::GrabStatus::SUCCESS);
				for event in [KEY_PRESS_EVENT, KEY_RELEASE_EVENT] {
					user
						.xtest_fake_input(event, code, CURRENT_TIME, root, 0, 0, 0)
						.expect("type");
				}
				user.sync().expect("sync");
				user
					.ungrab_keyboard(CURRENT_TIME)
					.expect("ungrab")
					.check()
					.expect("ungrabbed");
				keys_received();
				assert_eq!(input.xtest_key(code, true).unwrap_err().code, ErrorCode::UserIntervened);
				// A final successful body result must still report the intervention
				// after settle and focus hand-back, not overwrite it with success.
				Ok(())
			})
			.expect_err("user input stops an active takeover");
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert_eq!(keys_received(), 0, "no further agent key reached the target");

		let source = CancellationSource::default();
		source.set_deadline(Some(Instant::now()));
		let error = control::with_token_for_test(&source.token(), || {
			input.key_chord(&id, &key, DeliveryMode::Foreground)
		})
		.expect_err("the user is typing");
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert_eq!(keys_received(), 0, "nothing reached the target");
		// Read in order after the session's own press, which did not count.
		assert_eq!(input.activity.as_ref().expect("watching").presses(), 1);

		// The body has already succeeded when the user resumes during hand-back.
		input.takeover_presses = Some(1);
		let completed = Ok(());
		let error = input
			.finish_takeover(completed, |_| {
				for event in [KEY_PRESS_EVENT, KEY_RELEASE_EVENT] {
					user
						.xtest_fake_input(event, code, CURRENT_TIME, root, 0, 0, 0)
						.expect("user resumes after body");
				}
				user.sync().expect("user press reached the server");
			})
			.expect_err("hand-back intervention cannot report success");
		assert_eq!(error.code, ErrorCode::UserIntervened);
		keys_received();

		// A WM can leave its active property at the previous window after
		// our request has already moved core focus to the takeover target.
		let previous = app.generate_id().expect("previous window");
		app.create_window(
			x11rb::COPY_DEPTH_FROM_PARENT,
			previous,
			root,
			110,
			0,
			100,
			100,
			0,
			WindowClass::INPUT_OUTPUT,
			x11rb::COPY_FROM_PARENT,
			&CreateWindowAux::new().event_mask(EventMask::KEY_PRESS),
		)
		.expect("previous window");
		app.map_window(previous).expect("map previous");
		app.change_property32(
			x11rb::protocol::xproto::PropMode::REPLACE,
			root,
			input.atoms.net_active_window,
			AtomEnum::WINDOW,
			&[previous],
		)
		.expect("lagging WM property");
		app.set_input_focus(InputFocus::PARENT, previous, CURRENT_TIME)
			.expect("previous focus");
		app.sync().expect("previous is focused");
		let error = input
			.with_foreground::<()>(target, Duration::ZERO, |_| {
				panic!("unconfirmed activation must not run the body")
			})
			.expect_err("the WM never confirms activation");
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert_eq!(input.wm().input_focus(), Some((previous, InputFocus::PARENT)));
		assert!(input.takeover_presses.is_none());
		for event in [KEY_PRESS_EVENT, KEY_RELEASE_EVENT] {
			user
				.xtest_fake_input(event, code, CURRENT_TIME, root, 0, 0, 0)
				.expect("user resumes after activation error");
		}
		user.sync().expect("user input reached the server");
		app.sync().expect("user input delivered");
		let recipients: Vec<_> = std::iter::from_fn(|| app.poll_for_event().expect("event"))
			.filter_map(|event| match event {
				x11rb::protocol::Event::KeyPress(event) => Some(event.event),
				_ => None,
			})
			.collect();
		assert_eq!(recipients, [previous], "the user's key must not reach the takeover target");
		// A newer core-focus switch away from the target is not ours to undo.
		input.restore_activation(target, true, Some(root), Some((root, InputFocus::PARENT)));
		assert_eq!(input.wm().input_focus(), Some((previous, InputFocus::PARENT)));
		app.delete_property(root, input.atoms.net_active_window)
			.expect("stop tracking activation");
		app.sync().expect("property removed");
		// Lost observation refuses further input, even without user presses.
		input.activity = None;
		input.watch_user().expect("fresh listener");
		let error = input
			.with_foreground(target, Duration::from_secs(2), |input| {
				input.activity.as_mut().expect("watching").disconnect(&conn);
				input.xtest_key(code, true)
			})
			.expect_err("lost listener stops active takeover");
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert_eq!(keys_received(), 0);
		assert_eq!(
			input
				.key_chord(&id, &key, DeliveryMode::Foreground)
				.unwrap_err()
				.code,
			ErrorCode::InputFailed
		);
		assert_eq!(keys_received(), 0);

		// Inspection may try observation and fail, but a later takeover cannot
		// move focus or send input without a listener.
		let mut unwatched =
			X11Input::new(Arc::clone(&conn), root, Some("invalid-display".into())).expect("input");
		assert!(unwatched.watch_user().is_err());
		let focus = input.wm().input_focus();
		assert_eq!(
			unwatched
				.key_chord(&id, &key, DeliveryMode::Foreground)
				.unwrap_err()
				.code,
			ErrorCode::InputFailed
		);
		assert_eq!(input.wm().input_focus(), focus);
		assert_eq!(keys_received(), 0);
	}

	/// A press outside the open popups of the window's process is refused,
	/// in the background and in takeover; inside one of them, with no popup,
	/// or a plain move, it goes on. Starts its own `Xvfb`: `cargo test -p
	/// pi-natives -- --ignored open_popup`.
	#[test]
	#[ignore = "starts Xvfb"]
	fn a_press_outside_an_open_popup_is_refused() {
		use std::{
			io::{BufRead, BufReader},
			process::{Child, Command, Stdio},
		};

		use x11rb::{
			protocol::{
				Event,
				xproto::{CreateWindowAux, PropMode, WindowClass},
			},
			wrapper::ConnectionExt as _,
		};

		struct Reaped(Child);
		impl Drop for Reaped {
			fn drop(&mut self) {
				let _ = self.0.kill();
				let _ = self.0.wait();
			}
		}
		let mut server = Reaped(
			Command::new("Xvfb")
				.args(["-displayfd", "1", "-screen", "0", "320x240x24", "-nolisten", "tcp"])
				.stdout(Stdio::piped())
				.stderr(Stdio::null())
				.spawn()
				.expect("Xvfb starts"),
		);
		let mut number = String::new();
		BufReader::new(server.0.stdout.take().expect("Xvfb stdout"))
			.read_line(&mut number)
			.expect("Xvfb reports its display");
		let display = format!(":{}", number.trim());
		let (conn, screen) = x11rb::connect(Some(&display)).expect("connect to Xvfb");
		let root = conn.setup().roots[screen].root;
		let net_wm_pid = conn
			.intern_atom(false, b"_NET_WM_PID")
			.unwrap()
			.reply()
			.unwrap()
			.atom;
		// The app's window at (0, 0) 200x200, and its menu at (20, 20) 50x50.
		let window = |x: i16, size: u16, popup: bool| {
			let window = conn.generate_id().unwrap();
			conn
				.create_window(
					0,
					window,
					root,
					x,
					x,
					size,
					size,
					0,
					WindowClass::INPUT_OUTPUT,
					0,
					&CreateWindowAux::new()
						.override_redirect(u32::from(popup))
						.event_mask(EventMask::BUTTON_PRESS),
				)
				.unwrap()
				.check()
				.unwrap();
			conn
				.change_property32(PropMode::REPLACE, window, net_wm_pid, AtomEnum::CARDINAL, &[
					std::process::id(),
				])
				.unwrap()
				.check()
				.unwrap();
			conn.map_window(window).unwrap().check().unwrap();
			window
		};
		let app = window(0, 200, false);
		let presses = |window: Window| {
			conn.sync().unwrap();
			let mut count = 0;
			while let Some(event) = conn.poll_for_event().unwrap() {
				count +=
					usize::from(matches!(event, Event::ButtonPress(press) if press.event == window));
			}
			count
		};
		let (input_conn, _) = x11rb::connect(Some(&display)).expect("connect to Xvfb");
		let mut input = X11Input::new(Arc::new(input_conn), root, Some(display)).unwrap();
		// `XSendEvent`, so no MPX device lands on an ambient `DISPLAY`.
		input.mpx_unavailable = Some("test".to_owned());
		let target = Target::Window(app.to_string());
		let click = |x: f64, y: f64| PointerEvent::Click {
			x,
			y,
			button: MouseButton::Left,
			count: 1,
			modifiers: Modifiers::default(),
		};
		input
			.pointer(&target, click(150.0, 150.0), DeliveryMode::Background)
			.expect("no popup is open");
		assert_eq!(presses(app), 1);

		let popup = window(20, 50, true);
		let error = input
			.pointer(&target, click(150.0, 150.0), DeliveryMode::Background)
			.expect_err("a press outside the open popup");
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		assert!(error.message.contains(&format!("popup {popup}")), "{}", error.message);
		assert_eq!(presses(app), 0, "nothing was sent");
		let error = input
			.pointer(&target, click(150.0, 150.0), DeliveryMode::ForegroundReturnFocus)
			.expect_err("a takeover press outside the open popup");
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(error.message.contains(&format!("popup {popup}")), "{}", error.message);
		assert_eq!(presses(app), 0, "nothing was sent in takeover");

		// A submenu over its menu: a press in the menu is inside the grab.
		let submenu = window(60, 50, true);
		input
			.pointer(&Target::Window(popup.to_string()), click(30.0, 30.0), DeliveryMode::Background)
			.expect("a press inside the menu under a submenu");
		assert_eq!(presses(popup), 1);
		input
			.pointer(
				&Target::Window(submenu.to_string()),
				click(100.0, 100.0),
				DeliveryMode::Background,
			)
			.expect("a press inside the submenu");
		assert_eq!(presses(submenu), 1);
		input
			.pointer(&target, PointerEvent::Move { x: 150.0, y: 150.0 }, DeliveryMode::Background)
			.expect("a plain move");
	}
}

#[cfg(test)]
pub(super) mod named_change_tests;
