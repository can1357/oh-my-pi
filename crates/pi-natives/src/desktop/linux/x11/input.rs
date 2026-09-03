use std::{
	fs::{File, OpenOptions},
	io::Write,
	os::fd::AsRawFd,
	sync::Arc,
	thread,
	time::{Duration, Instant},
};

use x11rb::{
	CURRENT_TIME,
	connection::Connection,
	protocol::{
		xinput::{
			ChangeMode, ConnectionExt as _, Device, DeviceType, EventMode, GrabMode22, GrabOwner,
			GrabType, HierarchyChange, HierarchyChangeData, HierarchyChangeDataAddMaster,
			HierarchyChangeDataAttachSlave, HierarchyChangeDataRemoveMaster, XIEventMask,
		},
		xproto::{
			AtomEnum, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ButtonPressEvent,
			CLIENT_MESSAGE_EVENT, ClientMessageData, ClientMessageEvent, ConnectionExt as _,
			EventMask, GrabMode, KEY_PRESS_EVENT, KEY_RELEASE_EVENT, KeyButMask, KeyPressEvent,
			MOTION_NOTIFY_EVENT, Motion, MotionNotifyEvent, Window,
		},
		xtest::ConnectionExt as _,
	},
	rust_connection::RustConnection,
};
use xkeysym::Keysym;

use crate::desktop::{
	backend::{DeliveryMode, Modifiers, MouseButton, PointerEvent},
	error::{CoreResult, DesktopError},
	keys::KeyName,
	types::Target,
};

const CLICK_DELAY: Duration = Duration::from_millis(12);
const MPX_SETTLE: Duration = Duration::from_millis(100);

pub struct X11Input {
	conn:                Arc<RustConnection>,
	root:                Window,
	min_keycode:         u8,
	keysyms_per_keycode: u8,
	keysyms:             Vec<u32>,
	mpx_probe:           bool,
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
		let setup = conn.setup();
		let min_keycode = setup.min_keycode;
		let count = setup
			.max_keycode
			.saturating_sub(min_keycode)
			.saturating_add(1);
		let mapping = conn
			.get_keyboard_mapping(min_keycode, count)
			.map_err(input_failed)?
			.reply()
			.map_err(input_failed)?;
		let mpx_probe = mpx_cheap_probe(&conn);
		Ok(Self {
			conn,
			root,
			min_keycode,
			keysyms_per_keycode: mapping.keysyms_per_keycode,
			keysyms: mapping.keysyms,
			mpx_probe,
		})
	}

	pub(crate) fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		match (target, mode) {
			(Target::Desktop, _) => self.pointer_xtest(&event),
			(Target::Window(id), DeliveryMode::Foreground) => {
				let window = parse_window(id)?;
				self.with_foreground(window, |this| this.pointer_xtest(&event))
			},
			(Target::Window(id), DeliveryMode::Background) => {
				let window = parse_window(id)?;
				let filtering = self.send_event_filtering_toolkit(window);
				if filtering && self.mpx_probe && self.pointer_mpx(window, &event).is_ok() {
					return Ok(());
				}
				if filtering {
					return Err(background_unavailable(
						id,
						event_kind(&event),
						"GTK/Qt/Chromium/Firefox filters XSendEvent and the XI2-MPX real-input \
						 transport is unavailable",
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
		match (target, mode) {
			(Target::Desktop, _) => self.type_text_xtest(text),
			(Target::Window(id), DeliveryMode::Foreground) => {
				let window = parse_window(id)?;
				self.with_foreground(window, |this| this.type_text_xtest(text))
			},
			(Target::Window(id), DeliveryMode::Background) => {
				let window = parse_window(id)?;
				if self.send_event_filtering_toolkit(window) {
					return Err(background_unavailable(
						id,
						"text",
						"the target toolkit filters synthetic key events; its dedicated MPX pointer \
						 cannot safely redirect keyboard focus",
					));
				}
				for ch in text.chars() {
					self.send_key(window, KeyName::Char(ch), true)?;
					self.send_key(window, KeyName::Char(ch), false)?;
				}
				self.conn.flush().map_err(input_failed)
			},
		}
	}

	pub(crate) fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
	) -> CoreResult<()> {
		match (target, mode) {
			(Target::Desktop, _) => self.chord_xtest(keys),
			(Target::Window(id), DeliveryMode::Foreground) => {
				let window = parse_window(id)?;
				self.with_foreground(window, |this| this.chord_xtest(keys))
			},
			(Target::Window(id), DeliveryMode::Background) => {
				let window = parse_window(id)?;
				if self.send_event_filtering_toolkit(window) {
					return Err(background_unavailable(
						id,
						"key",
						"the target toolkit filters XSendEvent keyboard input",
					));
				}
				let mut pressed = Vec::with_capacity(keys.len());
				for &key in keys {
					if let Err(error) = self.send_key(window, key, true) {
						for &held in pressed.iter().rev() {
							let _ = self.send_key(window, held, false);
						}
						return Err(error);
					}
					pressed.push(key);
				}
				let mut first_error = None;
				for &key in pressed.iter().rev() {
					if let Err(error) = self.send_key(window, key, false)
						&& first_error.is_none()
					{
						first_error = Some(error);
					}
				}
				self.conn.flush().map_err(input_failed)?;
				first_error.map_or(Ok(()), Err)
			},
		}
	}

	pub(crate) fn raise_window(&self, window: Window) -> CoreResult<()> {
		self.activate(window)
	}

	fn pointer_send_event(&self, window: Window, event: &PointerEvent) -> CoreResult<()> {
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
					thread::sleep(Duration::from_millis(8));
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

	fn pointer_xtest(&self, event: &PointerEvent) -> CoreResult<()> {
		match event {
			PointerEvent::Click { x, y, button, count, .. } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				self.xtest_motion(x, y)?;
				let detail = button_detail(*button);
				for _ in 0..(*count).max(1) {
					self.xtest_button(detail, true)?;
					thread::sleep(CLICK_DELAY);
					self.xtest_button(detail, false)?;
				}
			},
			PointerEvent::Move { x, y } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				self.xtest_motion(x, y)?;
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
					thread::sleep(Duration::from_millis(8));
				}
				self.xtest_button(detail, false)?;
			},
			PointerEvent::Scroll { x, y, dx, dy } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				self.xtest_motion(x, y)?;
				self.scroll_xtest(*dx, *dy)?;
			},
		}
		self.conn.flush().map_err(input_failed)
	}

	fn pointer_mpx(&self, window: Window, event: &PointerEvent) -> CoreResult<()> {
		if matches!(
			 event,
			 PointerEvent::Click { modifiers, .. } | PointerEvent::Drag { modifiers, .. }
				  if modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.meta
		) {
			return Err(DesktopError::input_failed(
				"XI2-MPX modifier gestures require a dedicated keyboard slave",
			));
		}
		let previous_focus = self.active_window();
		let mut session = MpxSession::create(&self.conn, self.root)?;
		let result = match event {
			PointerEvent::Click { x, y, button, count, .. } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				session.warp(x, y)?;
				session.grab_button(window, button_detail(*button))?;
				for _ in 0..(*count).max(1) {
					session.emit_button(button_detail(*button), true)?;
					thread::sleep(CLICK_DELAY);
					session.replay(window)?;
					session.emit_button(button_detail(*button), false)?;
				}
				Ok(())
			},
			PointerEvent::Drag { path, button, .. } => {
				let Some(&(x, y)) = path.first() else {
					return Err(DesktopError::input_failed("drag path is empty"));
				};
				let (x, y) = validate_xtest_point(x, y)?;
				session.warp(x, y)?;
				session.grab_button(window, button_detail(*button))?;
				session.emit_button(button_detail(*button), true)?;
				thread::sleep(CLICK_DELAY);
				session.replay(window)?;
				for &(next_x, next_y) in path.iter().skip(1) {
					let (next_x, next_y) = validate_xtest_point(next_x, next_y)?;
					session.warp(next_x, next_y)?;
				}
				session.emit_button(button_detail(*button), false)
			},
			PointerEvent::Scroll { x, y, dx, dy } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				session.warp(x, y)?;
				session.emit_scroll(*dx, *dy)
			},
			PointerEvent::Move { x, y } => {
				let (x, y) = validate_xtest_point(*x, *y)?;
				session.warp(x, y)
			},
		};
		session.finish();
		if let Some(previous) = previous_focus
			&& self.active_window() != Some(previous)
		{
			let _ = self.activate(previous);
		}
		result
	}

	fn with_foreground<T>(
		&mut self,
		window: Window,
		body: impl FnOnce(&mut Self) -> CoreResult<T>,
	) -> CoreResult<T> {
		let previous = self.active_window();
		self.activate(window)?;
		thread::sleep(Duration::from_millis(45));
		let result = body(self);
		if let Some(previous) = previous
			&& previous != window
		{
			let _ = self.activate(previous);
		}
		result
	}

	fn active_window(&self) -> Option<Window> {
		let atom = self.intern("_NET_ACTIVE_WINDOW").ok()?;
		self
			.conn
			.get_property(false, self.root, atom, AtomEnum::WINDOW, 0, 1)
			.ok()?
			.reply()
			.ok()?
			.value32()?
			.next()
	}

	fn activate(&self, window: Window) -> CoreResult<()> {
		let atom = self.intern("_NET_ACTIVE_WINDOW")?;
		let event = ClientMessageEvent {
			response_type: CLIENT_MESSAGE_EVENT,
			format: 32,
			sequence: 0,
			window,
			type_: atom,
			data: ClientMessageData::from([2, CURRENT_TIME, 0, 0, 0]),
		};
		self
			.conn
			.send_event(
				false,
				self.root,
				EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
				event,
			)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)?;
		self.conn.flush().map_err(input_failed)
	}

	fn type_text_xtest(&self, text: &str) -> CoreResult<()> {
		for ch in text.chars() {
			let key = KeyName::Char(ch);
			self.xtest_key(key, true)?;
			self.xtest_key(key, false)?;
		}
		self.conn.flush().map_err(input_failed)
	}

	fn chord_xtest(&self, keys: &[KeyName]) -> CoreResult<()> {
		let mut pressed = Vec::with_capacity(keys.len());
		for &key in keys {
			if let Err(error) = self.xtest_key(key, true) {
				for &held in pressed.iter().rev() {
					let _ = self.xtest_key(held, false);
				}
				return Err(error);
			}
			pressed.push(key);
		}
		let mut first_error = None;
		for &key in pressed.iter().rev() {
			if let Err(error) = self.xtest_key(key, false)
				&& first_error.is_none()
			{
				first_error = Some(error);
			}
		}
		self.conn.flush().map_err(input_failed)?;
		first_error.map_or(Ok(()), Err)
	}

	fn xtest_key(&self, key: KeyName, press: bool) -> CoreResult<()> {
		let keycode = self.keycode(key)?;
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

	fn send_key(&self, window: Window, key: KeyName, press: bool) -> CoreResult<()> {
		let keycode = self.keycode(key)?;
		let event = KeyPressEvent {
			response_type: if press {
				KEY_PRESS_EVENT
			} else {
				KEY_RELEASE_EVENT
			},
			detail:        keycode,
			sequence:      0,
			time:          CURRENT_TIME,
			root:          self.root,
			event:         window,
			child:         0,
			root_x:        0,
			root_y:        0,
			event_x:       0,
			event_y:       0,
			state:         KeyButMask::default(),
			same_screen:   true,
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

	fn keycode(&self, key: KeyName) -> CoreResult<u8> {
		let keysym = keysym_for_key(key);
		let width = usize::from(self.keysyms_per_keycode);
		if width == 0 {
			return Err(DesktopError::input_failed("X11 keyboard map has zero keysyms per keycode"));
		}
		for (row, keysyms) in self.keysyms.chunks_exact(width).enumerate() {
			if keysyms.iter().take(2).any(|&candidate| candidate == keysym) {
				return self
					.min_keycode
					.checked_add(
						u8::try_from(row)
							.map_err(|_| DesktopError::input_failed("X11 keymap is too large"))?,
					)
					.ok_or_else(|| DesktopError::input_failed("X11 keycode overflow"));
			}
		}
		Err(DesktopError::input_failed(format!("X11 keymap has no keycode for keysym {keysym:#x}")))
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
		self
			.conn
			.xtest_fake_input(MOTION_NOTIFY_EVENT, 0, CURRENT_TIME, self.root, x, y, 0)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)
	}

	fn xtest_button(&self, detail: u8, press: bool) -> CoreResult<()> {
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

	fn send_event_filtering_toolkit(&self, window: Window) -> bool {
		let class = self
			.conn
			.get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.map(|reply| String::from_utf8_lossy(&reply.value).to_ascii_lowercase())
			.unwrap_or_default();
		["gtk", "gdk", "qt", "chrome", "chromium", "firefox", "mozilla"]
			.iter()
			.any(|needle| class.contains(needle))
	}

	fn intern(&self, name: &str) -> CoreResult<u32> {
		self
			.conn
			.intern_atom(false, name.as_bytes())
			.map_err(input_failed)?
			.reply()
			.map(|reply| reply.atom)
			.map_err(input_failed)
	}
}

fn input_failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("X11 input request failed: {error}"))
}

fn background_unavailable(window: &str, kind: &str, reason: &str) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"window {window} drops background {kind} events: {reason}; retry with \
		 delivery:\"foreground\" or use ax actions"
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

const fn button_detail(button: MouseButton) -> u8 {
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

fn keysym_for_key(key: KeyName) -> u32 {
	let keysym = match key {
		KeyName::Ctrl => Keysym::Control_L,
		KeyName::Alt => Keysym::Alt_L,
		KeyName::Shift => Keysym::Shift_L,
		KeyName::Meta => Keysym::Super_L,
		KeyName::Enter => Keysym::Return,
		KeyName::Escape => Keysym::Escape,
		KeyName::Tab => Keysym::Tab,
		KeyName::Space => Keysym::space,
		KeyName::Backspace => Keysym::BackSpace,
		KeyName::Delete => Keysym::Delete,
		KeyName::Insert => Keysym::Insert,
		KeyName::Home => Keysym::Home,
		KeyName::End => Keysym::End,
		KeyName::PageUp => Keysym::Prior,
		KeyName::PageDown => Keysym::Next,
		KeyName::Up => Keysym::Up,
		KeyName::Down => Keysym::Down,
		KeyName::Left => Keysym::Left,
		KeyName::Right => Keysym::Right,
		KeyName::CapsLock => Keysym::Caps_Lock,
		KeyName::NumLock => Keysym::Num_Lock,
		KeyName::PrintScreen => Keysym::Print,
		KeyName::F1 => Keysym::F1,
		KeyName::F2 => Keysym::F2,
		KeyName::F3 => Keysym::F3,
		KeyName::F4 => Keysym::F4,
		KeyName::F5 => Keysym::F5,
		KeyName::F6 => Keysym::F6,
		KeyName::F7 => Keysym::F7,
		KeyName::F8 => Keysym::F8,
		KeyName::F9 => Keysym::F9,
		KeyName::F10 => Keysym::F10,
		KeyName::F11 => Keysym::F11,
		KeyName::F12 => Keysym::F12,
		KeyName::F13 => Keysym::F13,
		KeyName::F14 => Keysym::F14,
		KeyName::F15 => Keysym::F15,
		KeyName::F16 => Keysym::F16,
		KeyName::F17 => Keysym::F17,
		KeyName::F18 => Keysym::F18,
		KeyName::F19 => Keysym::F19,
		KeyName::F20 => Keysym::F20,
		KeyName::F21 => Keysym::F21,
		KeyName::F22 => Keysym::F22,
		KeyName::F23 => Keysym::F23,
		KeyName::F24 => Keysym::F24,
		KeyName::Char(ch) => {
			return match ch {
				'\n' | '\r' => Keysym::Return.raw(),
				'\t' => Keysym::Tab.raw(),
				_ => Keysym::from_char(ch).raw(),
			};
		},
	};
	keysym.raw()
}

fn mpx_cheap_probe(conn: &RustConnection) -> bool {
	if OpenOptions::new().write(true).open("/dev/uinput").is_err() {
		return false;
	}
	if std::env::var("DISPLAY").ok().as_deref().is_none() {
		return false;
	}
	if x_server_exe_name().as_deref() == Some("Xvfb") {
		return false;
	}
	conn
		.xinput_xi_query_version(2, 2)
		.ok()
		.and_then(|cookie| cookie.reply().ok())
		.is_some()
}

fn x_server_exe_name() -> Option<String> {
	let display = std::env::var("DISPLAY").ok()?;
	let number = display.split(':').nth(1)?.split('.').next()?;
	let lock = std::fs::read_to_string(format!("/tmp/.X{number}-lock")).ok()?;
	let pid = lock.trim().parse::<u32>().ok()?;
	std::fs::read_link(format!("/proc/{pid}/exe"))
		.ok()?
		.file_name()?
		.to_str()
		.map(str::to_owned)
}

struct MpxSession<'a> {
	conn:            &'a RustConnection,
	root:            Window,
	master_pointer:  u16,
	master_keyboard: u16,
	slave:           u16,
	uinput:          UInputDevice,
	grabbed:         Option<(Window, u8)>,
	finished:        bool,
}

impl<'a> MpxSession<'a> {
	fn create(conn: &'a RustConnection, root: Window) -> CoreResult<Self> {
		let name = format!("OMP MPX {}", std::process::id());
		let change = HierarchyChange {
			len:  hierarchy_len(4 + name.len()),
			data: HierarchyChangeData::AddMaster(HierarchyChangeDataAddMaster {
				send_core: false,
				enable:    true,
				name:      name.as_bytes().to_vec(),
			}),
		};
		conn
			.xinput_xi_change_hierarchy(&[change])
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)?;
		conn.flush().map_err(input_failed)?;
		let reply = conn
			.xinput_xi_query_device(Device::ALL)
			.map_err(input_failed)?
			.reply()
			.map_err(input_failed)?;
		let master_pointer = reply
			.infos
			.iter()
			.find(|info| {
				info.name == format!("{name} pointer").as_bytes()
					&& info.type_ == DeviceType::MASTER_POINTER
			})
			.map(|info| info.deviceid)
			.ok_or_else(|| {
				DesktopError::input_failed("XIChangeHierarchy did not create the MPX master pointer")
			})?;
		let master_keyboard = reply
			.infos
			.iter()
			.find(|info| {
				info.name == format!("{name} keyboard").as_bytes()
					&& info.type_ == DeviceType::MASTER_KEYBOARD
			})
			.map(|info| info.deviceid)
			.ok_or_else(|| {
				DesktopError::input_failed("XIChangeHierarchy did not create the MPX master keyboard")
			})?;
		let device_name = format!("{name} uinput pointer");
		let uinput = UInputDevice::create(&device_name)?;
		let deadline = Instant::now() + Duration::from_secs(3);
		let slave = loop {
			let devices = conn
				.xinput_xi_query_device(Device::ALL)
				.map_err(input_failed)?
				.reply()
				.map_err(input_failed)?;
			if let Some(id) = devices
				.infos
				.iter()
				.find(|info| info.name == device_name.as_bytes())
				.map(|info| info.deviceid)
			{
				break id;
			}
			if Instant::now() >= deadline {
				return Err(DesktopError::input_failed(
					"uinput slave did not appear in XI2 device hierarchy",
				));
			}
			thread::sleep(Duration::from_millis(50));
		};
		let attach = HierarchyChange {
			len:  2,
			data: HierarchyChangeData::AttachSlave(HierarchyChangeDataAttachSlave {
				deviceid: slave,
				master:   master_pointer,
			}),
		};
		conn
			.xinput_xi_change_hierarchy(&[attach])
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)?;
		conn.flush().map_err(input_failed)?;
		thread::sleep(MPX_SETTLE);
		Ok(Self {
			conn,
			root,
			master_pointer,
			master_keyboard,
			slave,
			uinput,
			grabbed: None,
			finished: false,
		})
	}

	fn warp(&self, x: i16, y: i16) -> CoreResult<()> {
		self
			.conn
			.xinput_xi_warp_pointer(
				0,
				self.root,
				0,
				0,
				0,
				0,
				i32::from(x) << 16,
				i32::from(y) << 16,
				self.master_pointer,
			)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)
	}

	fn grab_button(&mut self, window: Window, button: u8) -> CoreResult<()> {
		let mask = [u32::from(XIEventMask::BUTTON_PRESS | XIEventMask::BUTTON_RELEASE)];
		let reply = self
			.conn
			.xinput_xi_passive_grab_device(
				CURRENT_TIME,
				window,
				0,
				u32::from(button),
				self.master_pointer,
				GrabType::BUTTON,
				GrabMode22::SYNC,
				GrabMode::ASYNC,
				GrabOwner::from(false),
				&mask,
				&[0x8000_0000],
			)
			.map_err(input_failed)?
			.reply()
			.map_err(input_failed)?;
		if !reply.modifiers.is_empty() {
			return Err(DesktopError::input_failed("XI2 device-specific shield grab was rejected"));
		}
		self.grabbed = Some((window, button));
		Ok(())
	}

	fn replay(&self, window: Window) -> CoreResult<()> {
		thread::sleep(Duration::from_millis(10));
		self
			.conn
			.xinput_xi_allow_events(
				CURRENT_TIME,
				self.master_pointer,
				EventMode::REPLAY_DEVICE,
				0,
				window,
			)
			.map_err(input_failed)?
			.check()
			.map_err(input_failed)
	}

	fn emit_button(&mut self, button: u8, press: bool) -> CoreResult<()> {
		self.uinput.button(button, press)
	}

	fn emit_scroll(&mut self, dx: f64, dy: f64) -> CoreResult<()> {
		self.uinput.scroll(dx, dy)
	}

	fn finish(mut self) {
		self.cleanup();
		self.finished = true;
	}

	fn cleanup(&mut self) {
		if let Some((window, button)) = self.grabbed.take()
			&& let Ok(cookie) = self.conn.xinput_xi_passive_ungrab_device(
				window,
				u32::from(button),
				self.master_pointer,
				GrabType::BUTTON,
				&[0x8000_0000],
			) {
			let _ = cookie.check();
		}
		let remove = HierarchyChange {
			len:  3,
			data: HierarchyChangeData::RemoveMaster(HierarchyChangeDataRemoveMaster {
				deviceid:        self.master_pointer,
				return_mode:     ChangeMode::FLOAT,
				return_pointer:  0,
				return_keyboard: 0,
			}),
		};
		if let Ok(cookie) = self.conn.xinput_xi_change_hierarchy(&[remove]) {
			let _ = cookie.check();
		}
		let _ = self.conn.flush();
		let _ = (self.master_keyboard, self.slave);
	}
}

impl Drop for MpxSession<'_> {
	fn drop(&mut self) {
		if !self.finished {
			self.cleanup();
		}
	}
}

fn hierarchy_len(payload_bytes: usize) -> u16 {
	u16::try_from((4 + payload_bytes).div_ceil(4)).unwrap_or(u16::MAX)
}

struct UInputDevice {
	file: File,
}

impl UInputDevice {
	fn create(name: &str) -> CoreResult<Self> {
		let file = OpenOptions::new()
			.write(true)
			.open("/dev/uinput")
			.map_err(|error| DesktopError::input_failed(format!("open /dev/uinput: {error}")))?;
		let fd = file.as_raw_fd();
		for event in [EV_KEY, EV_REL] {
			ioctl_int(fd, ui_set_evbit(), event)?;
		}
		for key in [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE] {
			ioctl_int(fd, ui_set_keybit(), key)?;
		}
		for rel in [REL_X, REL_Y, REL_WHEEL, REL_HWHEEL] {
			ioctl_int(fd, ui_set_relbit(), rel)?;
		}
		let mut setup = UInputSetup {
			id:             InputId { bustype: 0x03, vendor: 0x1d6b, product: 0x0104, version: 1 },
			name:           [0; 80],
			ff_effects_max: 0,
		};
		let bytes = name.as_bytes();
		let len = bytes.len().min(setup.name.len().saturating_sub(1));
		setup.name[..len].copy_from_slice(&bytes[..len]);
		ioctl_ptr(fd, ui_dev_setup(), &setup)?;
		ioctl_none(fd, ui_dev_create())?;
		Ok(Self { file })
	}

	fn button(&mut self, button: u8, press: bool) -> CoreResult<()> {
		let code = match button {
			1 => BTN_LEFT,
			2 => BTN_MIDDLE,
			3 => BTN_RIGHT,
			_ => {
				return Err(DesktopError::input_failed(format!("unsupported uinput button {button}")));
			},
		};
		self.emit(EV_KEY, code, i32::from(press))?;
		self.sync()
	}

	fn scroll(&mut self, dx: f64, dy: f64) -> CoreResult<()> {
		if dx.round() != 0.0 {
			self.emit(EV_REL, REL_HWHEEL, -(dx.round() as i32))?;
		}
		if dy.round() != 0.0 {
			self.emit(EV_REL, REL_WHEEL, -(dy.round() as i32))?;
		}
		self.sync()
	}

	fn emit(&mut self, type_: u16, code: u16, value: i32) -> CoreResult<()> {
		let event = InputEvent { time: libc::timeval { tv_sec: 0, tv_usec: 0 }, type_, code, value };
		// SAFETY: InputEvent is a C-compatible plain-data kernel ABI struct and the
		// slice is bounded to its exact size.
		let bytes = unsafe {
			std::slice::from_raw_parts(
				(&event as *const InputEvent).cast::<u8>(),
				std::mem::size_of::<InputEvent>(),
			)
		};
		self
			.file
			.write_all(bytes)
			.map_err(|error| DesktopError::input_failed(format!("write /dev/uinput: {error}")))
	}

	fn sync(&mut self) -> CoreResult<()> {
		self.emit(EV_SYN, SYN_REPORT, 0)
	}
}

impl Drop for UInputDevice {
	fn drop(&mut self) {
		let _ = ioctl_none(self.file.as_raw_fd(), ui_dev_destroy());
	}
}

#[repr(C)]
struct InputId {
	bustype: u16,
	vendor:  u16,
	product: u16,
	version: u16,
}
#[repr(C)]
struct UInputSetup {
	id:             InputId,
	name:           [u8; 80],
	ff_effects_max: u32,
}
#[repr(C)]
struct InputEvent {
	time:  libc::timeval,
	type_: u16,
	code:  u16,
	value: i32,
}

const EV_SYN: u16 = 0;
const EV_KEY: u16 = 1;
const EV_REL: u16 = 2;
const SYN_REPORT: u16 = 0;
const REL_X: u16 = 0;
const REL_Y: u16 = 1;
const REL_HWHEEL: u16 = 6;
const REL_WHEEL: u16 = 8;
const BTN_LEFT: u16 = 272;
const BTN_RIGHT: u16 = 273;
const BTN_MIDDLE: u16 = 274;

// `libc::Ioctl` is `c_ulong` on glibc but `c_int` on musl; the wrapping cast
// mirrors how C truncates request codes on 32-bit-int ABIs.
const fn ioc(dir: u64, type_: u64, nr: u64, size: u64) -> libc::Ioctl {
	((dir << 30) | (type_ << 8) | nr | (size << 16)) as libc::Ioctl
}
const fn ui_set_evbit() -> libc::Ioctl {
	ioc(1, b'U' as u64, 100, std::mem::size_of::<libc::c_int>() as u64)
}
const fn ui_set_keybit() -> libc::Ioctl {
	ioc(1, b'U' as u64, 101, std::mem::size_of::<libc::c_int>() as u64)
}
const fn ui_set_relbit() -> libc::Ioctl {
	ioc(1, b'U' as u64, 102, std::mem::size_of::<libc::c_int>() as u64)
}
const fn ui_dev_create() -> libc::Ioctl {
	ioc(0, b'U' as u64, 1, 0)
}
const fn ui_dev_destroy() -> libc::Ioctl {
	ioc(0, b'U' as u64, 2, 0)
}
const fn ui_dev_setup() -> libc::Ioctl {
	ioc(1, b'U' as u64, 3, std::mem::size_of::<UInputSetup>() as u64)
}

fn ioctl_int(fd: libc::c_int, request: libc::Ioctl, value: u16) -> CoreResult<()> {
	// SAFETY: fd is an open uinput descriptor and this request takes an integer
	// argument by value.
	let result = unsafe { libc::ioctl(fd, request, libc::c_ulong::from(value)) };
	if result < 0 {
		Err(DesktopError::input_failed(format!(
			"uinput ioctl failed: {}",
			std::io::Error::last_os_error()
		)))
	} else {
		Ok(())
	}
}
fn ioctl_none(fd: libc::c_int, request: libc::Ioctl) -> CoreResult<()> {
	// SAFETY: fd is an open uinput descriptor and this request takes no third
	// argument.
	let result = unsafe { libc::ioctl(fd, request) };
	if result < 0 {
		Err(DesktopError::input_failed(format!(
			"uinput ioctl failed: {}",
			std::io::Error::last_os_error()
		)))
	} else {
		Ok(())
	}
}
fn ioctl_ptr(fd: libc::c_int, request: libc::Ioctl, setup: &UInputSetup) -> CoreResult<()> {
	// SAFETY: setup points to a valid UInputSetup for the duration of the ioctl.
	let result = unsafe { libc::ioctl(fd, request, setup as *const UInputSetup) };
	if result < 0 {
		Err(DesktopError::input_failed(format!(
			"uinput setup failed: {}",
			std::io::Error::last_os_error()
		)))
	} else {
		Ok(())
	}
}
