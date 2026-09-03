use std::{
	os::unix::net::UnixStream,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use ashpd::desktop::{
	PersistMode, Session,
	remote_desktop::{DeviceType, RemoteDesktop},
};
use futures::StreamExt;
use reis::{
	ei,
	event::{Device, DeviceCapability, EiEvent},
	tokio::EiConvertEventStream,
};

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
	serial: u32,
}

type RemoteDesktopSession = Session<'static, RemoteDesktop<'static>>;

struct PortalSession {
	runtime: &'static tokio::runtime::Runtime,
	session: RemoteDesktopSession,
}

pub(super) struct Libei {
	context:        ei::Context,
	pointer:        Option<EiDevice>,
	keyboard:       Option<EiDevice>,
	sequence:       u32,
	portal_session: Option<PortalSession>,
}

impl Drop for Libei {
	fn drop(&mut self) {
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
		let mut backend =
			Self { context, pointer: None, keyboard: None, sequence: 1, portal_session };
		let (_connection, mut events) = runtime
			.block_on(
				backend
					.context
					.handshake_tokio("omp-computer", ei::handshake::ContextType::Sender),
			)
			.map_err(|err| DesktopError::input_failed(format!("libei handshake: {err}")))?;
		backend.discover_devices(runtime, &mut events, targets)?;
		if backend.pointer.is_none() && backend.keyboard.is_none() {
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
						// helper (itself a `block_on`) would abort with a nested-runtime
						// panic; bound this consent-denied close inline instead.
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
		runtime.block_on(async {
			let mut pending_pointer = None;
			let mut pending_keyboard = None;
			let mut drain_deadline = None;
			for _ in 0..128 {
				let event = if let Some(deadline) = drain_deadline {
					match tokio::time::timeout_at(deadline, events.next()).await {
						Ok(event) => event,
						Err(_) => break,
					}
				} else {
					events.next().await
				}
				.ok_or_else(|| {
					DesktopError::input_failed("libei disconnected during device discovery")
				})?
				.map_err(|err| DesktopError::input_failed(format!("libei device discovery: {err}")))?;
				match event {
					EiEvent::SeatAdded(event) => {
						event.seat.bind_capabilities(&[
							DeviceCapability::PointerAbsolute,
							DeviceCapability::Pointer,
							DeviceCapability::Button,
							DeviceCapability::Scroll,
							DeviceCapability::Keyboard,
						]);
						self.context.flush().map_err(|err| {
							DesktopError::input_failed(format!("libei bind seat: {err}"))
						})?;
					},
					EiEvent::DeviceAdded(event) => {
						if event
							.device
							.has_capability(DeviceCapability::PointerAbsolute)
						{
							pending_pointer = Some(event.device.clone());
						}
						if event.device.has_capability(DeviceCapability::Keyboard) {
							pending_keyboard = Some(event.device);
						}
					},
					EiEvent::DeviceResumed(event) => {
						if pending_pointer.as_ref() == Some(&event.device) {
							self.pointer =
								Some(EiDevice { device: event.device.clone(), serial: event.serial });
						}
						if pending_keyboard.as_ref() == Some(&event.device) {
							self.keyboard = Some(EiDevice { device: event.device, serial: event.serial });
						}
					},
					EiEvent::Disconnected(event) => {
						return Err(DesktopError::input_failed(format!(
							"libei disconnected: {}",
							event.explanation
						)));
					},
					_ => {},
				}
				if targets.is_complete(self.pointer.is_some(), self.keyboard.is_some()) {
					break;
				}
				if drain_deadline.is_none() && (self.pointer.is_some() || self.keyboard.is_some()) {
					drain_deadline = Some(tokio::time::Instant::now() + DEVICE_DISCOVERY_DRAIN_TIMEOUT);
				}
			}
			Ok(())
		})
	}

	fn timestamp() -> u64 {
		SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_micros()
			.min(u128::from(u64::MAX)) as u64
	}

	fn begin(device: &EiDevice, sequence: u32) {
		device
			.device
			.device()
			.start_emulating(device.serial, sequence);
	}

	fn finish(&self, device: &EiDevice) {
		device.device.device().stop_emulating(device.serial);
		let _ = self.context.flush();
	}

	fn move_absolute(device: &EiDevice, x: f64, y: f64, time: u64) -> CoreResult<()> {
		let in_region = device.device.regions().iter().any(|region| {
			x >= f64::from(region.x)
				&& y >= f64::from(region.y)
				&& x < f64::from(region.x.saturating_add(region.width))
				&& y < f64::from(region.y.saturating_add(region.height))
		});
		if !in_region {
			return Err(DesktopError::input_failed(format!(
				"libei coordinate ({x},{y}) is outside every announced device region"
			)));
		}
		let pointer = device
			.device
			.interface::<ei::PointerAbsolute>()
			.ok_or_else(|| {
				DesktopError::input_failed("libei device has no absolute pointer interface")
			})?;
		pointer.motion_absolute(x as f32, y as f32);
		device.device.device().frame(device.serial, time);
		Ok(())
	}

	fn send_modifiers(
		device: &EiDevice,
		modifiers: Modifiers,
		pressed: bool,
		time: &mut u64,
	) -> CoreResult<()> {
		for (enabled, key) in
			[(modifiers.ctrl, 29), (modifiers.alt, 56), (modifiers.shift, 42), (modifiers.meta, 125)]
		{
			if enabled {
				Self::send_key(device, key, pressed, *time)?;
				*time = time.saturating_add(1);
			}
		}
		Ok(())
	}

	fn send_key(device: &EiDevice, keycode: u32, pressed: bool, time: u64) -> CoreResult<()> {
		let keyboard = device
			.device
			.interface::<ei::Keyboard>()
			.ok_or_else(|| DesktopError::input_failed("libei device has no keyboard interface"))?;
		keyboard.key(
			keycode,
			if pressed {
				ei::keyboard::KeyState::Press
			} else {
				ei::keyboard::KeyState::Released
			},
		);
		device.device.device().frame(device.serial, time);
		Ok(())
	}

	pub(super) fn pointer(&mut self, event: PointerEvent) -> CoreResult<()> {
		let device = self.pointer.as_ref().ok_or_else(|| {
			DesktopError::permission_denied("RemoteDesktop portal did not provide a libei pointer")
		})?;
		let sequence = self.sequence;
		self.sequence = self.sequence.wrapping_add(1);
		Self::begin(device, sequence);
		let mut time = Self::timestamp();
		let result = (|| -> CoreResult<()> {
			match event {
				PointerEvent::Move { x, y } => Self::move_absolute(device, x, y, time),
				PointerEvent::Click { x, y, button, count, modifiers } => {
					Self::move_absolute(device, x, y, time)?;
					let keyboard = self.keyboard.as_ref();
					if let Some(keyboard) = keyboard {
						Self::send_modifiers(keyboard, modifiers, true, &mut time)?;
					}
					let button_interface = device.device.interface::<ei::Button>().ok_or_else(|| {
						DesktopError::input_failed("libei device has no button interface")
					})?;
					let code = match button {
						MouseButton::Left => 0x110,
						MouseButton::Right => 0x111,
						MouseButton::Middle => 0x112,
					};
					for _ in 0..count.max(1) {
						button_interface.button(code, ei::button::ButtonState::Press);
						device.device.device().frame(device.serial, time);
						time = time.saturating_add(1);
						button_interface.button(code, ei::button::ButtonState::Released);
						device.device.device().frame(device.serial, time);
						time = time.saturating_add(1);
					}
					if let Some(keyboard) = keyboard {
						Self::send_modifiers(keyboard, modifiers, false, &mut time)?;
					}
					Ok(())
				},
				PointerEvent::Drag { path, button, modifiers } => {
					let Some(&(x, y)) = path.first() else {
						return Err(DesktopError::input_failed("libei drag path is empty"));
					};
					Self::move_absolute(device, x, y, time)?;
					time = time.saturating_add(1);
					let keyboard = self.keyboard.as_ref();
					if let Some(keyboard) = keyboard {
						Self::send_modifiers(keyboard, modifiers, true, &mut time)?;
					}
					let button_interface = device.device.interface::<ei::Button>().ok_or_else(|| {
						DesktopError::input_failed("libei device has no button interface")
					})?;
					let code = match button {
						MouseButton::Left => 0x110,
						MouseButton::Right => 0x111,
						MouseButton::Middle => 0x112,
					};
					button_interface.button(code, ei::button::ButtonState::Press);
					device.device.device().frame(device.serial, time);
					time = time.saturating_add(1);
					for &(x, y) in path.iter().skip(1) {
						Self::move_absolute(device, x, y, time)?;
						time = time.saturating_add(1);
					}
					button_interface.button(code, ei::button::ButtonState::Released);
					device.device.device().frame(device.serial, time);
					time = time.saturating_add(1);
					if let Some(keyboard) = keyboard {
						Self::send_modifiers(keyboard, modifiers, false, &mut time)?;
					}
					Ok(())
				},
				PointerEvent::Scroll { x, y, dx, dy } => {
					Self::move_absolute(device, x, y, time)?;
					time = time.saturating_add(1);
					let scroll = device.device.interface::<ei::Scroll>().ok_or_else(|| {
						DesktopError::input_failed("libei device has no scroll interface")
					})?;
					scroll.scroll(dx as f32, dy as f32);
					device.device.device().frame(device.serial, time);
					Ok(())
				},
			}
		})();
		self.finish(device);
		result
	}

	pub(super) fn key_chord(&mut self, keys: &[KeyName]) -> CoreResult<()> {
		let device = self.keyboard.as_ref().ok_or_else(|| {
			DesktopError::permission_denied("RemoteDesktop portal did not provide a libei keyboard")
		})?;
		let mut codes = Vec::with_capacity(keys.len());
		for &key in keys {
			codes.push(evdev_keycode(key)?);
		}
		let sequence = self.sequence;
		self.sequence = self.sequence.wrapping_add(1);
		Self::begin(device, sequence);
		let mut time = Self::timestamp();
		for &code in &codes {
			Self::send_key(device, code, true, time)?;
			time = time.saturating_add(1);
		}
		for &code in codes.iter().rev() {
			Self::send_key(device, code, false, time)?;
			time = time.saturating_add(1);
		}
		self.finish(device);
		Ok(())
	}

	pub(super) fn type_text(&mut self, text: &str) -> CoreResult<()> {
		let device = self.keyboard.as_ref().ok_or_else(|| {
			DesktopError::permission_denied("RemoteDesktop portal did not provide a libei keyboard")
		})?;
		let strokes: Vec<_> = text
			.chars()
			.map(|character| {
				evdev_char(character).ok_or_else(|| {
					DesktopError::input_failed(format!(
						"libei cannot type character {character:?} with the announced evdev keymap"
					))
				})
			})
			.collect::<CoreResult<_>>()?;
		let sequence = self.sequence;
		self.sequence = self.sequence.wrapping_add(1);
		Self::begin(device, sequence);
		let mut time = Self::timestamp();
		for (code, shift) in strokes {
			if shift {
				Self::send_key(device, 42, true, time)?;
				time = time.saturating_add(1);
			}
			Self::send_key(device, code, true, time)?;
			time = time.saturating_add(1);
			Self::send_key(device, code, false, time)?;
			time = time.saturating_add(1);
			if shift {
				Self::send_key(device, 42, false, time)?;
				time = time.saturating_add(1);
			}
		}
		self.finish(device);
		Ok(())
	}
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
	fn discovery_waits_for_every_granted_device() {
		let targets = DiscoveryTargets { pointer: true, keyboard: true };

		assert!(!targets.is_complete(false, true));
		assert!(targets.is_complete(true, true));
	}
}
