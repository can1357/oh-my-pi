//! Event-driven XI2 Escape observation. Wayland has no portable physical-key
//! monitor and uses the host interrupt/native cancellation path instead.
use std::collections::HashMap;

use x11rb::{
	connection::Connection,
	protocol::{
		Event,
		xinput::ConnectionExt as _,
		xproto::{ConnectionExt as _, Mapping},
	},
	rust_connection::RustConnection,
};

use super::{CoreResult, DesktopError, EmergencyStop};
use crate::desktop::linux::x11::listener::{Listener, Source, source_of};

pub(super) struct EscapeMonitor {
	_listener: Listener,
}

impl EscapeMonitor {
	pub(super) fn start(emergency: EmergencyStop) -> CoreResult<Option<Self>> {
		let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
			|| std::env::var("XDG_SESSION_TYPE")
				.is_ok_and(|value| value.eq_ignore_ascii_case("wayland"));
		if wayland {
			return Ok(None);
		}
		let conn = Listener::connect(None).map_err(failed)?;
		require_escape(&conn)?;
		let mut escapes = HashMap::new();
		let mut sources = HashMap::new();
		let failure = emergency.clone();
		let listener = Listener::start(
			conn,
			"desktop-escape",
			move |conn, event| {
				if let Event::XinputHierarchy(_) = &event {
					escapes.clear();
					sources.clear();
				}
				// Escape is physical-only: core XTEST also carries our own Escape.
				// Activity observation separately subtracts our own XTEST presses.
				if let Event::XinputRawKeyPress(press) = &event {
					let source = match sources.entry(press.sourceid) {
						std::collections::hash_map::Entry::Occupied(entry) => *entry.get(),
						std::collections::hash_map::Entry::Vacant(entry) => {
							*entry.insert(source_of(conn, press.sourceid)?)
						},
					};
					if source != Source::User {
						return Ok(());
					}
				}
				match step(&mut escapes, &event, |device| device_escape(conn, device)) {
					Step::Next => Ok(()),
					Step::Escape => {
						emergency.escape();
						Ok(())
					},
					Step::Stop => Err(failed("cannot read the input device's keymap")),
				}
			},
			move || failure.cancel(),
		)
		.map_err(failed)?;
		Ok(Some(Self { _listener: listener }))
	}
}

fn failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::permission_denied(format!(
		"cannot monitor physical emergency Escape: {error}; no input was authorized"
	))
}

fn require_escape(conn: &RustConnection) -> CoreResult<()> {
	let setup = conn.setup();
	let mapping = conn
		.get_keyboard_mapping(
			setup.min_keycode,
			setup
				.max_keycode
				.saturating_sub(setup.min_keycode)
				.saturating_add(1),
		)
		.map_err(failed)?
		.reply()
		.map_err(failed)?;
	if mapping.keysyms_per_keycode == 0 {
		return Err(failed("the X11 keyboard map is empty"));
	}
	escape_in(setup.min_keycode, mapping.keysyms_per_keycode, &mapping.keysyms)
		.ok_or_else(|| failed("the X11 keymap has no Escape key"))?;
	Ok(())
}

/// What the monitor does with one X event.
enum Step {
	Next,
	/// Escape was pressed on the source keyboard.
	Escape,
	Stop,
}

/// A raw press reports its keycode in the source device's keymap, so Escape
/// is looked up there: the core keymap follows whichever device typed last,
/// and takeover's next XTEST key can switch it before a user's press is read.
/// `read` reads a device's Escape keycode; failing to read it stops.
fn step(
	escapes: &mut HashMap<u16, Option<u8>>,
	event: &Event,
	read: impl FnOnce(u16) -> CoreResult<Option<u8>>,
) -> Step {
	match event {
		Event::XinputRawKeyPress(event) => {
			let escape = match escapes.get(&event.sourceid) {
				Some(&escape) => escape,
				None => match read(event.sourceid) {
					Ok(escape) => *escapes.entry(event.sourceid).or_insert(escape),
					Err(_) => return Step::Stop,
				},
			};
			if escape.is_some_and(|escape| event.detail == u32::from(escape)) {
				Step::Escape
			} else {
				Step::Next
			}
		},
		// Xorg sends the core keymap again each time the core keyboard switches
		// source device, as the takeover's own first XTEST key does after the
		// user typed; a device's own keymap may have changed with it.
		Event::MappingNotify(event) if event.request == Mapping::KEYBOARD => {
			escapes.clear();
			Step::Next
		},
		_ => Step::Next,
	}
}

/// The Escape keycode of `device`'s own keymap, `None` when it has none.
fn device_escape(conn: &RustConnection, device: u16) -> CoreResult<Option<u8>> {
	let setup = conn.setup();
	let mapping = conn
		.xinput_get_device_key_mapping(
			u8::try_from(device).map_err(failed)?,
			setup.min_keycode,
			setup
				.max_keycode
				.saturating_sub(setup.min_keycode)
				.saturating_add(1),
		)
		.map_err(failed)?
		.reply()
		.map_err(failed)?;
	Ok(escape_in(setup.min_keycode, mapping.keysyms_per_keycode, &mapping.keysyms))
}

fn escape_in(min_keycode: u8, keysyms_per_keycode: u8, keysyms: &[u32]) -> Option<u8> {
	let width = usize::from(keysyms_per_keycode);
	if width == 0 {
		return None;
	}
	keysyms
		.chunks(width)
		.position(|row| row.contains(&0xff1b))
		.and_then(|row| min_keycode.checked_add(u8::try_from(row).ok()?))
}

#[cfg(test)]
mod tests {
	use x11rb::protocol::{xinput::RawKeyPressEvent, xproto::MappingNotifyEvent};

	use super::*;

	#[test]
	fn escape_is_read_in_the_pressing_devices_keymap() {
		let press = |sourceid, detail| {
			Event::XinputRawKeyPress(RawKeyPressEvent { detail, sourceid, ..Default::default() })
		};
		let keyboard = Event::MappingNotify(MappingNotifyEvent {
			request: Mapping::KEYBOARD,
			..Default::default()
		});
		// The user's keyboard (8) puts Escape on 9, XTEST (4) on 66.
		let keymaps = |device| Ok(Some(if device == 8 { 9 } else { 66 }));
		let unreadable = |_| Err(failed("no keymap"));
		let mut escapes = HashMap::new();

		assert!(matches!(step(&mut escapes, &press(4, 66), keymaps), Step::Escape));
		assert!(matches!(step(&mut escapes, &keyboard, keymaps), Step::Next));
		assert!(matches!(step(&mut escapes, &press(8, 9), keymaps), Step::Escape));
		assert!(matches!(step(&mut escapes, &press(8, 66), unreadable), Step::Next), "cached");
		assert!(matches!(step(&mut escapes, &keyboard, unreadable), Step::Next));
		assert!(matches!(step(&mut escapes, &press(8, 9), |_| Ok(None)), Step::Next));
		assert!(matches!(step(&mut escapes, &keyboard, unreadable), Step::Next));
		assert!(matches!(step(&mut escapes, &press(8, 9), unreadable), Step::Stop));
	}
}
