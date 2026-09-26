use std::{
	os::{fd::AsFd, unix::net::UnixStream},
	time::Duration,
};

use ashpd::desktop::{
	PersistMode, Session,
	remote_desktop::{DeviceType, RemoteDesktop},
};
use futures::StreamExt;
use reis::{
	ei,
	event::{Device, DeviceCapability, EiEvent, Keymap},
	tokio::EiConvertEventStream,
};

use super::xkb::{KeyStroke, KeyboardLayout};
use crate::desktop::{
	backend::{Modifiers, MouseButton, PointerEvent},
	error::{CoreResult, DesktopError},
	keys::KeyName,
};

const DEVICE_DISCOVERY_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Copy)]
struct DiscoveryTargets {
	pointer:  bool,
	keyboard: bool,
}

impl DiscoveryTargets {
	const ALL: Self = Self { pointer: true, keyboard: true };

	const fn is_complete(self, pointer: bool, keyboard: bool) -> bool {
		(!self.pointer || pointer) && (!self.keyboard || keyboard)
	}
}

struct EiDevice {
	device: Device,
	resumed: bool,
	layout: Option<KeyboardLayout>,
}

type RemoteDesktopSession = Session<'static, RemoteDesktop<'static>>;

struct PortalSession {
	runtime: &'static tokio::runtime::Runtime,
	session: RemoteDesktopSession,
}

pub(super) struct Libei {
	context:        ei::Context,
	devices:        Vec<EiDevice>,
	connection:     Option<reis::event::Connection>,
	sequence:       u32,
	runtime:        &'static tokio::runtime::Runtime,
	events:         Option<EiConvertEventStream>,
	portal_session: Option<PortalSession>,
}

#[allow(
	clippy::non_send_fields_in_send_ty,
	reason = "EiConvertEventStream's only non-Send field is a callback map that stays empty"
)]
// SAFETY: the reis event stream is exclusively owned. Its sole non-`Send`
// field is a private callback map which remains empty because
// `EiConvertEventStream` exposes no callback-registration API.
unsafe impl Send for Libei {}

impl Drop for Libei {
	fn drop(&mut self) {
		let serial = self.serial();
		for device in &self.devices {
			if device.resumed {
				device.device.device().stop_emulating(serial);
			}
		}
		let _ = self.context.flush();
		let Some(portal) = self.portal_session.take() else {
			return;
		};
		close_session(portal.runtime, &portal.session);
	}
}

/// Closes a `RemoteDesktop` portal session, bounded by `CLOSE_TIMEOUT` so an
/// unresponsive `xdg-desktop-portal` cannot hang teardown indefinitely.
fn close_session(runtime: &tokio::runtime::Runtime, session: &RemoteDesktopSession) {
	let _ = runtime.block_on(async {
		tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.close()).await
	});
}

impl Libei {
	pub(super) fn new() -> CoreResult<Self> {
		let runtime = super::portal::portal_runtime()?;
		let (context, portal_session, targets) = match ei::Context::connect_to_env() {
			Ok(Some(context)) => (context, None, DiscoveryTargets::ALL),
			Ok(None) => {
				let (context, session, targets) = Self::portal_context(runtime)?;
				(context, Some(session), targets)
			},
			Err(err) => return Err(DesktopError::permission_denied(format!("LIBEI_SOCKET: {err}"))),
		};
		let mut backend = Self {
			context,
			devices: Vec::new(),
			connection: None,
			sequence: 1,
			runtime,
			events: None,
			portal_session,
		};
		let (connection, mut events) = runtime
			.block_on(async {
				tokio::time::timeout(Duration::from_secs(5), backend.context
					.handshake_tokio("omp-computer", ei::handshake::ContextType::Sender)).await
			})
			.map_err(|_| DesktopError::input_failed("libei handshake timed out"))?
			.map_err(|err| DesktopError::input_failed(format!("libei handshake: {err}")))?;
		backend.connection = Some(connection);
		backend.discover_devices(runtime, &mut events, targets)?;
		backend.events = Some(events);
		if !backend.has_capability(DeviceCapability::PointerAbsolute)
			&& !backend.has_capability(DeviceCapability::Keyboard)
		{
			return Err(DesktopError::permission_denied(
				"RemoteDesktop portal granted no libei keyboard or pointer devices",
			));
		}
		Ok(backend)
	}

	fn portal_context(
		runtime: &'static tokio::runtime::Runtime,
	) -> CoreResult<(ei::Context, PortalSession, DiscoveryTargets)> {
		let (fd, session, targets) = runtime
			.block_on(async {
				let portal = RemoteDesktop::new()
					.await
					.map_err(|err| format!("RemoteDesktop portal unavailable: {err}"))?;
				let session = portal
					.create_session()
					.await
					.map_err(|err| format!("RemoteDesktop CreateSession: {err}"))?;
				let fd = async {
					portal
						.select_devices(
							&session,
							DeviceType::Keyboard | DeviceType::Pointer,
							None,
							PersistMode::DoNot,
						)
						.await
						.map_err(|err| format!("RemoteDesktop SelectDevices: {err}"))?;
					let response = portal
						.start(&session, None)
						.await
						.map_err(|err| format!("RemoteDesktop Start: {err}"))?
						.response()
						.map_err(|err| format!("RemoteDesktop permission: {err}"))?;
					let devices = response.devices();
					let targets = DiscoveryTargets {
						pointer:  devices.contains(DeviceType::Pointer),
						keyboard: devices.contains(DeviceType::Keyboard),
					};
					portal
						.connect_to_eis(&session)
						.await
						.map(|fd| (fd, targets))
						.map_err(|err| format!("RemoteDesktop ConnectToEIS: {err}"))
				}
				.await;
				match fd {
					Ok((fd, targets)) => Ok((fd, session, targets)),
					Err(err) => {
						// Already inside `runtime.block_on`, so the `close_session`
						// helper (itself a `block_on`) would abort with a
						// nested-runtime panic; bound this consent-denied close
						// inline instead.
						let _ =
							tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.close()).await;
						Err(err)
					},
				}
			})
			.map_err(DesktopError::permission_denied)?;
		let context = match ei::Context::new(UnixStream::from(fd)) {
			Ok(context) => context,
			Err(err) => {
				close_session(runtime, &session);
				return Err(DesktopError::input_failed(format!("libei portal socket: {err}")));
			},
		};
		Ok((context, PortalSession { runtime, session }, targets))
	}

	fn discover_devices(
		&mut self,
		runtime: &tokio::runtime::Runtime,
		events: &mut EiConvertEventStream,
		targets: DiscoveryTargets,
	) -> CoreResult<()> {
		if targets.is_complete(false, false) {
			return Ok(());
		}
		runtime.block_on(async {
			let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
			let mut drain_deadline = None;
			loop {
				let until = drain_deadline.unwrap_or(deadline).min(deadline);
				let event = match tokio::time::timeout_at(until, events.next()).await {
					Ok(Some(event)) => event.map_err(|err| {
						DesktopError::input_failed(format!("libei device discovery: {err}"))
					})?,
					Ok(None) => return Err(DesktopError::input_failed("libei disconnected during discovery")),
					Err(_) => break,
				};
				self.handle_event(event)?;
				// Drain the initial burst even after the first matching devices:
				// other monitors and initial modifier state can follow.
				if drain_deadline.is_none() && targets.is_complete(
					self.has_capability(DeviceCapability::PointerAbsolute),
					self.has_capability(DeviceCapability::Keyboard),
				) {
					drain_deadline = Some(tokio::time::Instant::now() + DEVICE_DISCOVERY_DRAIN_TIMEOUT);
				}
			}
			self.flush()
		})
	}

	fn serial(&self) -> u32 {
		self.connection.as_ref().map_or(0, reis::event::Connection::serial)
	}

	fn has_capability(&self, capability: DeviceCapability) -> bool {
		self.devices.iter().any(|device| device.resumed && device.device.has_capability(capability))
	}

	fn handle_event(&mut self, event: EiEvent) -> CoreResult<()> {
		match event {
			EiEvent::SeatAdded(event) => {
				event.seat.bind_capabilities(&[
					DeviceCapability::PointerAbsolute, DeviceCapability::Pointer,
					DeviceCapability::Button, DeviceCapability::Scroll, DeviceCapability::Keyboard,
				]);
			},
			EiEvent::DeviceAdded(event) => {
				let layout = event.device.keymap().and_then(read_keymap);
				self.devices.push(EiDevice { device: event.device, resumed: false, layout });
			},
			EiEvent::DeviceResumed(event) => {
				let serial = self.serial();
				if let Some(device) = self.devices.iter_mut().find(|device| device.device == event.device) {
					device.resumed = true;
					// An emulation transaction lasts until pause/disconnect, not
					// one command. Mutter can discard frames stopped in the same
					// batch; modifiers also need their own keyboard emulating.
					device.device.device().start_emulating(serial, self.sequence);
					self.sequence = self.sequence.wrapping_add(1);
				}
			},
			EiEvent::DevicePaused(event) => {
				if let Some(device) = self.devices.iter_mut().find(|device| device.device == event.device) {
					device.resumed = false;
				}
			},
			EiEvent::DeviceRemoved(event) => self.devices.retain(|device| device.device != event.device),
			EiEvent::SeatRemoved(event) => self.devices.retain(|device| device.device.seat() != &event.seat),
			EiEvent::KeyboardModifiers(event) => {
				if let Some(device) = self.devices.iter_mut().find(|device| device.device == event.device)
					&& let Some(layout) = device.layout.as_mut()
				{
					layout.update_modifiers(event.depressed, event.latched, event.locked, event.group);
				}
			},
			EiEvent::Disconnected(event) => {
				self.devices.clear();
				return Err(DesktopError::input_failed(format!("libei disconnected: {}", event.explanation)));
			},
			_ => {},
		}
		self.flush()
	}

	fn refresh_devices(&mut self) -> CoreResult<()> {
		let mut events = self.events.take().ok_or_else(|| {
			DesktopError::input_failed("libei event stream is unavailable")
		})?;
		let runtime = self.runtime;
		let result = runtime.block_on(async {
			for _ in 0..256 {
				match tokio::time::timeout(Duration::from_millis(1), events.next()).await {
					Ok(Some(event)) => self.handle_event(event.map_err(|err| {
						DesktopError::input_failed(format!("libei device state: {err}"))
					})?)?,
					Ok(None) => return Err(DesktopError::input_failed("libei disconnected")),
					Err(_) => return Ok(()),
				}
			}
			Err(DesktopError::input_failed("libei device state did not settle; no input was sent"))
		});
		self.events = Some(events);
		result
	}

	fn flush(&self) -> CoreResult<()> {
		self.context.flush().map_err(|err| {
			DesktopError::input_failed(format!(
				"libei transport failed: {err}; delivery may be partial, do not retry blindly"
			))
		})
	}

	fn timestamp() -> CoreResult<u64> {
		let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
		// SAFETY: `time` is writable timespec storage; CLOCK_MONOTONIC is a
		// supported Linux clock and clock_gettime retains no pointer.
		if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &raw mut time) } != 0 {
			return Err(DesktopError::input_failed(format!(
				"libei monotonic clock: {}", std::io::Error::last_os_error()
			)));
		}
		Ok((time.tv_sec as u64).saturating_mul(1_000_000)
			.saturating_add(time.tv_nsec as u64 / 1_000))
	}

	fn send_key(
		device: &EiDevice,
		keyboard: &ei::Keyboard,
		keycode: u32,
		pressed: bool,
		serial: u32,
		time: &mut u64,
	) {
		keyboard.key(keycode, if pressed {
			ei::keyboard::KeyState::Press
		} else {
			ei::keyboard::KeyState::Released
		});
		device.device.device().frame(serial, *time);
		*time = time.saturating_add(1);
	}

	pub(super) fn pointer(&mut self, event: PointerEvent) -> CoreResult<()> {
		self.refresh_devices()?;
		// Preflight the complete gesture, before moving or holding anything.
		// In particular, an invalid later drag point must not leave a button
		// or modifier held after returning an error.
		let (modifiers, button) = match &event {
			PointerEvent::Click { modifiers, button, .. } | PointerEvent::Drag { modifiers, button, .. } => {
				(*modifiers, Some(match button {
					MouseButton::Left => 0x110, MouseButton::Right => 0x111, MouseButton::Middle => 0x112,
				}))
			},
			_ => (Modifiers::default(), None),
		};
		let scroll_units = match &event {
			PointerEvent::Scroll { dx, dy, .. } => Some((discrete_detents(*dx)?, discrete_detents(*dy)?)),
			_ => None,
		};
		if matches!(&event, PointerEvent::Drag { path, .. } if path.is_empty()) {
			return Err(DesktopError::input_failed("libei drag path is empty"));
		}
		let device = self.devices.iter().find(|device| {
			device.resumed
				&& device.device.has_capability(DeviceCapability::PointerAbsolute)
				&& (button.is_none() || device.device.has_capability(DeviceCapability::Button))
				&& (scroll_units.is_none() || device.device.has_capability(DeviceCapability::Scroll))
				&& match &event {
					PointerEvent::Click { x, y, .. } | PointerEvent::Move { x, y }
					| PointerEvent::Scroll { x, y, .. } => device_contains(&device.device, *x, *y),
					PointerEvent::Drag { path, .. } => path.iter().all(|&(x, y)| device_contains(&device.device, x, y)),
				}
		}).ok_or_else(|| DesktopError::input_failed(
			"no resumed libei pointer provides the required capabilities and covers every gesture point; no input was sent",
		))?;
		let pointer = device.device.interface::<ei::PointerAbsolute>().ok_or_else(|| {
			DesktopError::input_failed("libei absolute pointer interface is unavailable")
		})?;
		let button_interface = if button.is_some() {
			Some(device.device.interface::<ei::Button>().ok_or_else(|| {
				DesktopError::input_failed("libei button interface is unavailable")
			})?)
		} else { None };
		let scroll_interface = if scroll_units.is_some() {
			Some(device.device.interface::<ei::Scroll>().ok_or_else(|| {
				DesktopError::input_failed("libei scroll interface is unavailable")
			})?)
		} else { None };
		let keyboard = if modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.meta {
			let keyboard = self.devices.iter().find(|keyboard| {
				keyboard.resumed && keyboard.device.seat() == device.device.seat()
					&& keyboard.device.has_capability(DeviceCapability::Keyboard)
			}).ok_or_else(|| DesktopError::permission_denied(
				"no resumed libei keyboard on the pointer's seat can hold the gesture's modifiers",
			))?;
			Some((keyboard, keyboard.device.interface::<ei::Keyboard>().ok_or_else(|| {
				DesktopError::input_failed("libei keyboard interface is unavailable")
			})?))
		} else { None };
		let serial = self.serial();
		let mut time = Self::timestamp()?;
		if let Some((keyboard, interface)) = &keyboard {
			for (enabled, code) in modifier_keys(modifiers) {
				if enabled { Self::send_key(keyboard, interface, code, true, serial, &mut time); }
			}
		}
		let move_to = |x: f64, y: f64, time: &mut u64| {
			pointer.motion_absolute(x as f32, y as f32);
			device.device.device().frame(serial, *time);
			*time = time.saturating_add(1);
		};
		match event {
			PointerEvent::Move { x, y } | PointerEvent::Scroll { x, y, .. } => move_to(x, y, &mut time),
			PointerEvent::Click { x, y, count, .. } => {
				move_to(x, y, &mut time);
				if let (Some(code), Some(interface)) = (button, &button_interface) {
					for _ in 0..count.max(1) {
						interface.button(code, ei::button::ButtonState::Press);
						device.device.device().frame(serial, time);
						time = time.saturating_add(1);
						interface.button(code, ei::button::ButtonState::Released);
						device.device.device().frame(serial, time);
						time = time.saturating_add(1);
					}
				}
			},
			PointerEvent::Drag { path, .. } => {
				move_to(path[0].0, path[0].1, &mut time);
				if let (Some(code), Some(interface)) = (button, &button_interface) {
					interface.button(code, ei::button::ButtonState::Press);
					device.device.device().frame(serial, time);
					time = time.saturating_add(1);
					for &(x, y) in path.iter().skip(1) { move_to(x, y, &mut time); }
					interface.button(code, ei::button::ButtonState::Released);
					device.device.device().frame(serial, time);
					time = time.saturating_add(1);
				}
			},
		}
		if let (Some((dx, dy)), Some(interface)) = (scroll_units, scroll_interface) {
			interface.scroll_discrete(dx, dy);
			device.device.device().frame(serial, time);
			time = time.saturating_add(1);
		}
		if let Some((keyboard, interface)) = &keyboard {
			for (enabled, code) in modifier_keys(modifiers).into_iter().rev() {
				if enabled { Self::send_key(keyboard, interface, code, false, serial, &mut time); }
			}
		}
		self.flush()
	}

	pub(super) fn key_chord(&mut self, keys: &[KeyName]) -> CoreResult<()> {
		self.refresh_devices()?;
		let device = self.devices.iter_mut().find(|device| {
			device.resumed && device.device.has_capability(DeviceCapability::Keyboard)
		}).ok_or_else(|| DesktopError::permission_denied("no resumed libei keyboard is available"))?;
		let mut codes = Vec::with_capacity(keys.len());
		for &key in keys {
			let stroke = match key {
				KeyName::Char(character) => char_stroke(device.layout.as_mut(), character)?,
				_ => KeyStroke { keycode: evdev_keycode(key)?, modifiers: Vec::new() },
			};
			for code in stroke.modifiers.into_iter().chain(std::iter::once(stroke.keycode)) {
				if !codes.contains(&code) { codes.push(code); }
			}
		}
		let interface = device.device.interface::<ei::Keyboard>().ok_or_else(|| {
			DesktopError::input_failed("libei keyboard interface is unavailable")
		})?;
		let serial = self.connection.as_ref().map_or(0, reis::event::Connection::serial);
		let mut time = Self::timestamp()?;
		for &code in &codes { Self::send_key(device, &interface, code, true, serial, &mut time); }
		for &code in codes.iter().rev() { Self::send_key(device, &interface, code, false, serial, &mut time); }
		self.flush()
	}

	pub(super) fn type_text(&mut self, text: &str) -> CoreResult<()> {
		self.refresh_devices()?;
		let device = self.devices.iter_mut().find(|device| {
			device.resumed && device.device.has_capability(DeviceCapability::Keyboard)
		}).ok_or_else(|| DesktopError::permission_denied("no resumed libei keyboard is available"))?;
		let strokes = text.chars().map(|character| char_stroke(device.layout.as_mut(), character))
			.collect::<CoreResult<Vec<_>>>()?;
		let interface = device.device.interface::<ei::Keyboard>().ok_or_else(|| {
			DesktopError::input_failed("libei keyboard interface is unavailable")
		})?;
		let serial = self.connection.as_ref().map_or(0, reis::event::Connection::serial);
		let mut time = Self::timestamp()?;
		for stroke in strokes {
			for &modifier in &stroke.modifiers {
				Self::send_key(device, &interface, modifier, true, serial, &mut time);
			}
			Self::send_key(device, &interface, stroke.keycode, true, serial, &mut time);
			Self::send_key(device, &interface, stroke.keycode, false, serial, &mut time);
			for &modifier in stroke.modifiers.iter().rev() {
				Self::send_key(device, &interface, modifier, false, serial, &mut time);
			}
		}
		self.flush()
	}
}

fn modifier_keys(modifiers: Modifiers) -> [(bool, u32); 4] {
	[(modifiers.ctrl, 29), (modifiers.alt, 56), (modifiers.shift, 42), (modifiers.meta, 125)]
}

fn device_contains(device: &Device, x: f64, y: f64) -> bool {
	device.regions().iter().any(|region| {
		x.is_finite() && y.is_finite()
			&& x >= f64::from(region.x) && y >= f64::from(region.y)
			&& x < f64::from(region.x) + f64::from(region.width)
			&& y < f64::from(region.y) + f64::from(region.height)
	})
}

/// Wheel detents → libei discrete scroll units (120 per detent).
fn discrete_detents(value: f64) -> CoreResult<i32> {
	let units = (value * 120.0).round();
	if !units.is_finite() || units < f64::from(i32::MIN) || units > f64::from(i32::MAX) {
		return Err(DesktopError::input_failed(format!("scroll delta {value} is out of range")));
	}
	Ok(units as i32)
}

fn read_keymap(keymap: &Keymap) -> Option<KeyboardLayout> {
	if keymap.type_ != ei::keyboard::KeymapType::Xkb || keymap.size == 0 || keymap.size > 16 * 1024 * 1024 {
		return None;
	}
	let fd = keymap.fd.as_fd().try_clone_to_owned().ok()?;
	KeyboardLayout::from_fd(fd, keymap.size as usize)
}

/// Resolves only through the active XKB group. Falling back to a key from a
/// different group would emit the wrong glyph because libei cannot request a
/// portable compositor group switch, so printable misses are reported.
fn char_stroke(layout: Option<&mut KeyboardLayout>, character: char) -> CoreResult<KeyStroke> {
	if let Some(layout) = layout {
		if character.is_ascii()
			&& layout.can_use_us_ascii_fast_path()
			&& let Some((keycode, shift)) = evdev_char(character)
		{
			return Ok(KeyStroke { keycode, modifiers: if shift { vec![42] } else { Vec::new() } });
		}
		if let Some(stroke) = layout.resolve_char(character) {
			return Ok(stroke);
		}
		if character.is_control()
			&& let Some((keycode, shift)) = evdev_char(character)
		{
			return Ok(KeyStroke { keycode, modifiers: if shift { vec![42] } else { Vec::new() } });
		}
		return Err(DesktopError::input_failed(format!(
			"libei cannot type character {character:?} in active XKB group {}",
			layout.active_group()
		)));
	}
	if character.is_control() && let Some((keycode, shift)) = evdev_char(character) {
		return Ok(KeyStroke { keycode, modifiers: if shift { vec![42] } else { Vec::new() } });
	}
	Err(DesktopError::input_failed(format!(
		"libei cannot type character {character:?}: no usable XKB keymap was announced"
	)))
}

fn evdev_keycode(key: KeyName) -> CoreResult<u32> {
	let code = match key {
		KeyName::Ctrl => 29,
		KeyName::Alt => 56,
		KeyName::Shift => 42,
		KeyName::Meta => 125,
		KeyName::Enter => 28,
		KeyName::Escape => 1,
		KeyName::Tab => 15,
		KeyName::Space => 57,
		KeyName::Backspace => 14,
		KeyName::Delete => 111,
		KeyName::Insert => 110,
		KeyName::Home => 102,
		KeyName::End => 107,
		KeyName::PageUp => 104,
		KeyName::PageDown => 109,
		KeyName::Up => 103,
		KeyName::Down => 108,
		KeyName::Left => 105,
		KeyName::Right => 106,
		KeyName::CapsLock => 58,
		KeyName::NumLock => 69,
		KeyName::PrintScreen => 99,
		KeyName::F1 => 59,
		KeyName::F2 => 60,
		KeyName::F3 => 61,
		KeyName::F4 => 62,
		KeyName::F5 => 63,
		KeyName::F6 => 64,
		KeyName::F7 => 65,
		KeyName::F8 => 66,
		KeyName::F9 => 67,
		KeyName::F10 => 68,
		KeyName::F11 => 87,
		KeyName::F12 => 88,
		KeyName::F13 => 183,
		KeyName::F14 => 184,
		KeyName::F15 => 185,
		KeyName::F16 => 186,
		KeyName::F17 => 187,
		KeyName::F18 => 188,
		KeyName::F19 => 189,
		KeyName::F20 => 190,
		KeyName::F21 => 191,
		KeyName::F22 => 192,
		KeyName::F23 => 193,
		KeyName::F24 => 194,
		KeyName::Char(character) => evdev_char(character).map(|(code, _)| code).ok_or_else(|| {
			DesktopError::input_failed(format!("no evdev keycode for {character:?}"))
		})?,
	};
	Ok(code)
}

fn evdev_char(character: char) -> Option<(u32, bool)> {
	let lower = character.to_ascii_lowercase();
	let code = match lower {
		'a'..='z' => [
			30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47,
			17, 45, 21, 44,
		][(lower as u8 - b'a') as usize],
		'1'..='9' => 2 + u32::from(lower as u8 - b'1'),
		'0' => 11,
		' ' => 57,
		'\n' | '\r' => 28,
		'\t' => 15,
		'-' | '_' => 12,
		'=' | '+' => 13,
		'[' | '{' => 26,
		']' | '}' => 27,
		'\\' | '|' => 43,
		';' | ':' => 39,
		'\'' | '"' => 40,
		'`' | '~' => 41,
		',' | '<' => 51,
		'.' | '>' => 52,
		'/' | '?' => 53,
		'!' => 2,
		'@' => 3,
		'#' => 4,
		'$' => 5,
		'%' => 6,
		'^' => 7,
		'&' => 8,
		'*' => 9,
		'(' => 10,
		')' => 11,
		_ => return None,
	};
	let shift = character.is_ascii_uppercase()
		|| matches!(
			character,
			'_' | '+'
				| '{' | '}'
				| '|' | ':'
				| '"' | '~'
				| '<' | '>'
				| '?' | '!'
				| '@' | '#'
				| '$' | '%'
				| '^' | '&'
				| '*' | '('
				| ')'
		);
	Some((code, shift))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn printable_text_without_a_keymap_never_assumes_us_layout() {
		assert!(char_stroke(None, 'a').is_err());
		assert!(char_stroke(None, '@').is_err());
		assert_eq!(char_stroke(None, '\n').unwrap().keycode, 28);
	}

	#[test]
	fn scroll_detents_preserve_direction_and_reject_overflow() {
		assert_eq!(discrete_detents(2.0).unwrap(), 240);
		assert_eq!(discrete_detents(-0.5).unwrap(), -60);
		assert!(discrete_detents(f64::INFINITY).is_err());
		assert!(discrete_detents(f64::from(i32::MAX)).is_err());
	}

	#[test]
	fn discovery_waits_for_every_granted_device() {
		let targets = DiscoveryTargets { pointer: true, keyboard: true };

		assert!(!targets.is_complete(false, true));
		assert!(targets.is_complete(true, true));
	}
}
