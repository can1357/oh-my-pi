//! Shared XI2 raw-input observation for takeover admission and emergency
//! Escape.
use std::{
	io::{Read, Write},
	os::{fd::AsRawFd, unix::net::UnixStream},
	sync::Arc,
	thread::{self, JoinHandle},
};

use parking_lot::Mutex;
use x11rb::{
	connection::Connection,
	protocol::{
		Event,
		xinput::{ConnectionExt as _, Device, DeviceType, EventMask, XIEventMask},
		xproto::ConnectionExt as _,
	},
	rust_connection::RustConnection,
	wrapper::ConnectionExt as _,
};

use crate::desktop::error::{CoreResult, DesktopError};

const DEVICE_PREFIX: &str = "OMP MPX ";
const DRAIN: u8 = 1;
const HELD: u8 = 2;

pub(crate) struct Listener {
	stop:    Option<Mutex<UnixStream>>,
	thread:  Option<JoinHandle<()>>,
	failure: Arc<Mutex<Option<DesktopError>>>,
	#[cfg(test)]
	client:  u32,
}

impl Listener {
	pub(crate) fn connect(display: Option<&str>) -> CoreResult<RustConnection> {
		let (conn, screen) = x11rb::connect(display).map_err(failed)?;
		// XI 2.0 omits raw events while another client grabs a device (menus,
		// launchers); XI 2.2 observes those presses too.
		let version = conn
			.xinput_xi_query_version(2, 2)
			.map_err(failed)?
			.reply()
			.map_err(failed)?;
		if (version.major_version, version.minor_version) < (2, 2) {
			return Err(failed("XI 2.2 is required to observe input during grabs"));
		}
		conn
			.xinput_xi_select_events(conn.setup().roots[screen].root, &[
				EventMask {
					deviceid: Device::ALL_MASTER.into(),
					mask:     vec![
						XIEventMask::RAW_KEY_PRESS
							| XIEventMask::RAW_KEY_RELEASE
							| XIEventMask::RAW_BUTTON_PRESS,
					],
				},
				EventMask { deviceid: Device::ALL.into(), mask: vec![XIEventMask::HIERARCHY] },
			])
			.map_err(failed)?
			.check()
			.map_err(failed)?;
		conn.flush().map_err(failed)?;
		Ok(conn)
	}

	pub(crate) fn start(
		conn: RustConnection,
		name: &str,
		mut event: impl FnMut(&RustConnection, Event) -> CoreResult<()> + Send + 'static,
		on_failure: impl FnOnce() + Send + 'static,
	) -> CoreResult<Self> {
		let (stop, stopped) = UnixStream::pair().map_err(failed)?;
		let failure = Arc::new(Mutex::new(None));
		#[cfg(test)]
		let client = {
			use x11rb::protocol::xproto::ConnectionExt as _;
			let resource = conn.generate_id().map_err(failed)?;
			conn
				.create_pixmap(1, resource, conn.setup().roots[0].root, 1, 1)
				.map_err(failed)?
				.check()
				.map_err(failed)?;
			resource
		};
		let state = Arc::clone(&failure);
		let thread = thread::Builder::new()
			.name(name.into())
			.spawn(move || {
				if let Err(error) = run(&conn, &stopped, |next| event(&conn, next)) {
					*state.lock() = Some(error);
					on_failure();
				}
			})
			.map_err(failed)?;
		Ok(Self {
			stop: Some(Mutex::new(stop)),
			thread: Some(thread),
			failure,
			#[cfg(test)]
			client,
		})
	}

	pub(crate) fn check(&self) -> CoreResult<()> {
		if let Some(error) = self.failure.lock().as_ref() {
			return Err(error.clone());
		}
		if self.thread.as_ref().is_some_and(JoinHandle::is_finished) {
			return Err(failed("the input listener stopped"));
		}
		Ok(())
	}

	/// Orders a server round trip and drains its preceding events on the
	/// listener thread before the caller reads the activity counter.
	pub(crate) fn sync(&self) -> CoreResult<()> {
		self.request(DRAIN).map(drop)
	}

	/// Reads the server's current core-device state, including holds that
	/// predate observation, without maintaining another down/up model.
	pub(crate) fn inputs_held(&self) -> CoreResult<bool> {
		self.request(HELD).map(|held| held != 0)
	}

	fn request(&self, command: u8) -> CoreResult<u8> {
		self.check()?;
		let mut pipe = self.stop.as_ref().expect("live listener").lock();
		pipe.write_all(&[command]).map_err(failed)?;
		let mut reply = [0];
		pipe.read_exact(&mut reply).map_err(failed)?;
		self.check()?;
		Ok(reply[0])
	}

	#[cfg(test)]
	pub(crate) fn disconnect(&mut self, conn: &RustConnection) {
		use x11rb::protocol::xproto::ConnectionExt as _;
		conn
			.kill_client(self.client)
			.expect("disconnect listener")
			.check()
			.expect("client exists");
		self
			.thread
			.take()
			.expect("listener running")
			.join()
			.expect("listener exits");
	}
}

impl Drop for Listener {
	fn drop(&mut self) {
		self.stop.take();
		if let Some(worker) = self.thread.take()
			&& worker.thread().id() != thread::current().id()
		{
			let _ = worker.join();
		}
	}
}

fn run(
	conn: &RustConnection,
	mut stopped: &UnixStream,
	mut event: impl FnMut(Event) -> CoreResult<()>,
) -> CoreResult<()> {
	let mut descriptors =
		[libc::pollfd { fd: stopped.as_raw_fd(), events: libc::POLLIN, revents: 0 }, libc::pollfd {
			fd:      conn.stream().as_raw_fd(),
			events:  libc::POLLIN,
			revents: 0,
		}];
	loop {
		while let Some(next) = conn.poll_for_event().map_err(failed)? {
			event(next)?;
		}
		// SAFETY: both descriptors are borrowed live for this blocking call.
		if unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as libc::nfds_t, -1) } < 0
		{
			let error = std::io::Error::last_os_error();
			if error.kind() == std::io::ErrorKind::Interrupted {
				continue;
			}
			return Err(failed(error));
		}
		if descriptors[0].revents & libc::POLLIN != 0 {
			let mut command = [0];
			if stopped.read(&mut command).map_err(failed)? == 0 {
				return Ok(());
			}
			conn.sync().map_err(failed)?;
			let held = command[0] == HELD && inputs_held(conn)?;
			while let Some(next) = conn.poll_for_event().map_err(failed)? {
				event(next)?;
			}
			stopped.write_all(&[u8::from(held)]).map_err(failed)?;
		} else if descriptors[0].revents != 0 {
			return Ok(());
		}
		if descriptors[1].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
			return Err(failed("the X11 connection closed"));
		}
	}
}

fn inputs_held(conn: &RustConnection) -> CoreResult<bool> {
	let keys = conn
		.query_keymap()
		.map_err(failed)?
		.reply()
		.map_err(failed)?;
	if keys.keys.iter().any(|byte| *byte != 0) {
		return Ok(true);
	}
	buttons_held(conn)
}

pub(super) fn buttons_held(conn: &RustConnection) -> CoreResult<bool> {
	let root = conn.setup().roots[0].root;
	let pointer = conn
		.xinput_xi_get_client_pointer(x11rb::NONE)
		.map_err(failed)?
		.reply()
		.map_err(failed)?;
	if !pointer.set {
		return Err(failed("the core pointer is unavailable"));
	}
	let pointer = conn
		.xinput_xi_query_pointer(root, pointer.deviceid)
		.map_err(failed)?
		.reply()
		.map_err(failed)?;
	Ok(pointer.buttons.iter().any(|mask| *mask != 0))
}

fn failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("cannot watch the user's X11 input: {error}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Source {
	User,
	/// The core XTEST devices carry both our takeover and remote users' input.
	Xtest,
	/// MPX and other masters' XTEST devices do not follow the user's focus.
	Other,
}

pub(crate) fn source_of(conn: &RustConnection, device: u16) -> CoreResult<Source> {
	let reply = conn
		.xinput_xi_query_device(device)
		.map_err(failed)?
		.reply()
		.map_err(failed)?;
	let info = reply
		.infos
		.first()
		.ok_or_else(|| failed("the input device disappeared"))?;
	Ok(classify(info.type_, &info.name))
}

fn classify(kind: DeviceType, name: &[u8]) -> Source {
	if !matches!(kind, DeviceType::SLAVE_KEYBOARD | DeviceType::SLAVE_POINTER)
		|| name.starts_with(DEVICE_PREFIX.as_bytes())
	{
		Source::Other
	} else if name.starts_with(b"Virtual core XTEST ") {
		Source::Xtest
	} else if name.windows(5).any(|part| part == b"XTEST") {
		Source::Other
	} else {
		Source::User
	}
}
