//! Event-driven XI2 Escape observation. Wayland has no portable physical-key
//! monitor and uses the host interrupt/native cancellation path instead.
use std::{
	os::{fd::AsRawFd, unix::net::UnixStream},
	thread::{self, JoinHandle},
};

use x11rb::{
	connection::Connection,
	protocol::{
		Event,
		xinput::{ConnectionExt as _, Device, DeviceType, XIEventMask},
		xproto::{ConnectionExt as _, Mapping},
	},
	rust_connection::RustConnection,
};

use super::{CoreResult, DesktopError, EmergencyStop};

pub(super) struct EscapeMonitor {
	stop:   Option<UnixStream>,
	thread: Option<JoinHandle<()>>,
}

impl EscapeMonitor {
	pub(super) fn start(emergency: EmergencyStop) -> CoreResult<Option<Self>> {
		let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
			|| std::env::var("XDG_SESSION_TYPE")
				.is_ok_and(|value| value.eq_ignore_ascii_case("wayland"));
		if wayland {
			return Ok(None);
		}
		let (stop, stopped) = UnixStream::pair().map_err(failed)?;
		let (ready, receive) = flume::bounded(1);
		let worker = thread::Builder::new()
			.name("desktop-escape".into())
			.spawn(move || {
				let result = X11::new().map(|monitor| {
					let _ = ready.send(Ok(()));
					monitor.run(&stopped, &emergency);
				});
				if let Err(error) = result {
					let _ = ready.send(Err(error));
				}
			})
			.map_err(failed)?;
		let monitor = Self { stop: Some(stop), thread: Some(worker) };
		receive.recv().map_err(failed)??;
		Ok(Some(monitor))
	}
}

impl Drop for EscapeMonitor {
	fn drop(&mut self) {
		self.stop.take();
		if let Some(worker) = self.thread.take()
			&& worker.thread().id() != thread::current().id()
		{
			let _ = worker.join();
		}
	}
}

fn failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::permission_denied(format!(
		"cannot monitor physical emergency Escape: {error}; no input was authorized"
	))
}

fn poll(descriptors: &mut [libc::pollfd]) -> std::io::Result<()> {
	loop {
		// SAFETY: all descriptors are borrowed live for this blocking call.
		if unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as libc::nfds_t, -1) } >= 0
		{
			return Ok(());
		}
		let error = std::io::Error::last_os_error();
		if error.kind() != std::io::ErrorKind::Interrupted {
			return Err(error);
		}
	}
}

struct X11 {
	conn:   RustConnection,
	escape: u8,
}
impl X11 {
	fn new() -> CoreResult<Self> {
		let (conn, screen) = x11rb::connect(None).map_err(failed)?;
		conn
			.xinput_xi_query_version(2, 0)
			.map_err(failed)?
			.reply()
			.map_err(failed)?;
		let setup = conn.setup();
		let escape = escape_keycode(&conn)?;
		conn
			.xinput_xi_select_events(setup.roots[screen].root, &[x11rb::protocol::xinput::EventMask {
				deviceid: Device::ALL_MASTER.into(),
				mask:     vec![XIEventMask::RAW_KEY_PRESS],
			}])
			.map_err(failed)?
			.check()
			.map_err(failed)?;
		conn.flush().map_err(failed)?;
		Ok(Self { conn, escape })
	}

	fn run(mut self, stopped: &UnixStream, emergency: &EmergencyStop) {
		let mut descriptors = [
			libc::pollfd { fd: stopped.as_raw_fd(), events: libc::POLLIN, revents: 0 },
			libc::pollfd {
				fd:      self.conn.stream().as_raw_fd(),
				events:  libc::POLLIN,
				revents: 0,
			},
		];
		loop {
			loop {
				let event = match self.conn.poll_for_event() {
					Ok(Some(event)) => event,
					Ok(None) => break,
					Err(_) => {
						emergency.cancel();
						return;
					},
				};
				match step(&mut self.escape, &event, || escape_keycode(&self.conn).ok()) {
					Step::Next => {},
					Step::Escape(source) => {
						let devices = self
							.conn
							.xinput_xi_query_device(source)
							.ok()
							.and_then(|cookie| cookie.reply().ok());
						let Some(devices) = devices else {
							emergency.cancel();
							return;
						};
						if devices.infos.iter().any(|device| {
							let name = String::from_utf8_lossy(&device.name);
							device.type_ == DeviceType::SLAVE_KEYBOARD
								&& !name.contains("XTEST")
								&& !name.starts_with("OMP MPX ")
						}) {
							emergency.escape();
						}
					},
					Step::Stop => {
						emergency.cancel();
						return;
					},
				}
			}
			if poll(&mut descriptors).is_err() {
				emergency.cancel();
				return;
			}
			if descriptors[0].revents != 0 {
				return;
			}
			if descriptors[1].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
				emergency.cancel();
				return;
			}
		}
	}
}

/// What the monitor does with one X event.
enum Step {
	Next,
	/// The Escape keycode was pressed on this source device.
	Escape(u16),
	Stop,
}

/// `keymap` reads the Escape keycode of the current core keymap.
fn step(escape: &mut u8, event: &Event, keymap: impl FnOnce() -> Option<u8>) -> Step {
	match event {
		Event::XinputRawKeyPress(event) if event.detail == u32::from(*escape) => {
			Step::Escape(event.sourceid)
		},
		// Xorg sends the core keymap again each time the core keyboard switches
		// source device, as the takeover's own first XTEST key does after the
		// user typed; only a keymap without Escape ends the stop.
		Event::MappingNotify(event) if event.request == Mapping::KEYBOARD => match keymap() {
			Some(keycode) => {
				*escape = keycode;
				Step::Next
			},
			None => Step::Stop,
		},
		_ => Step::Next,
	}
}

fn escape_keycode(conn: &RustConnection) -> CoreResult<u8> {
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
	let width = usize::from(mapping.keysyms_per_keycode);
	if width == 0 {
		return Err(failed("the X11 keyboard map is empty"));
	}
	mapping
		.keysyms
		.chunks(width)
		.position(|row| row.contains(&0xff1b))
		.and_then(|row| setup.min_keycode.checked_add(u8::try_from(row).ok()?))
		.ok_or_else(|| failed("the X11 keymap has no Escape key"))
}

#[cfg(test)]
mod tests {
	use x11rb::protocol::{xinput::RawKeyPressEvent, xproto::MappingNotifyEvent};

	use super::*;

	#[test]
	fn a_core_keymap_switch_keeps_the_escape_stop_on_the_new_keymap() {
		let mapping =
			|request| Event::MappingNotify(MappingNotifyEvent { request, ..Default::default() });
		let press = |detail| {
			Event::XinputRawKeyPress(RawKeyPressEvent { detail, sourceid: 8, ..Default::default() })
		};
		let mut escape = 9;

		assert!(matches!(step(&mut escape, &mapping(Mapping::KEYBOARD), || Some(66)), Step::Next));
		assert!(matches!(step(&mut escape, &press(9), || None), Step::Next));
		assert!(matches!(step(&mut escape, &press(66), || None), Step::Escape(8)));
		assert!(matches!(step(&mut escape, &mapping(Mapping::MODIFIER), || None), Step::Next));
		assert!(matches!(step(&mut escape, &mapping(Mapping::KEYBOARD), || None), Step::Stop));
	}
}
