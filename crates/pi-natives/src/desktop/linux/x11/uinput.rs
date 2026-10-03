//! Minimal `/dev/uinput` device used as an `XInput2` slave for the MPX virtual
//! master pair. Only the kernel ABI subset the pointer and keyboard slaves
//! need is implemented.

use std::{
	fs::{File, OpenOptions},
	io::Write,
	os::fd::AsRawFd,
};

use crate::desktop::error::{CoreResult, DesktopError};

/// evdev keycodes are X keycodes minus this offset (X reserves 0..=7).
pub(super) const X_KEYCODE_OFFSET: u8 = 8;
/// Highest evdev key the keyboard slave advertises: the whole `KEY_*` block
/// below the `BTN_*` range, so libinput classifies the device as a keyboard
/// and every keycode an X keymap can address is emittable.
const MAX_KEYBOARD_CODE: u16 = 0xff;

pub(super) struct UInputDevice {
	file:    File,
	created: bool,
}

impl UInputDevice {
	/// Relative pointer with the three standard buttons and both wheels.
	pub(super) fn pointer(name: &str) -> CoreResult<Self> {
		let file = open_uinput()?;
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
		Self::create(file, name, 0x0104)
	}

	/// Keyboard advertising every evdev key code an X keycode maps to.
	pub(super) fn keyboard(name: &str) -> CoreResult<Self> {
		let file = open_uinput()?;
		let fd = file.as_raw_fd();
		ioctl_int(fd, ui_set_evbit(), EV_KEY)?;
		for code in 1..=MAX_KEYBOARD_CODE {
			ioctl_int(fd, ui_set_keybit(), code)?;
		}
		Self::create(file, name, 0x0105)
	}

	fn create(file: File, name: &str, product: u16) -> CoreResult<Self> {
		let fd = file.as_raw_fd();
		let mut setup = UInputSetup {
			id:             InputId { bustype: 0x03, vendor: 0x1d6b, product, version: 1 },
			name:           [0; 80],
			ff_effects_max: 0,
		};
		let bytes = name.as_bytes();
		let len = bytes.len().min(setup.name.len().saturating_sub(1));
		setup.name[..len].copy_from_slice(&bytes[..len]);
		ioctl_ptr(fd, ui_dev_setup(), &setup)?;
		ioctl_none(fd, ui_dev_create())?;
		Ok(Self { file, created: true })
	}

	/// Press or release X button 1..=3.
	pub(super) fn button(&mut self, button: u8, press: bool) -> CoreResult<()> {
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

	/// One relative motion frame; a zero delta on both axes emits nothing.
	pub(super) fn motion(&mut self, dx: i32, dy: i32) -> CoreResult<()> {
		if dx == 0 && dy == 0 {
			return Ok(());
		}
		if dx != 0 {
			self.emit(EV_REL, REL_X, dx)?;
		}
		if dy != 0 {
			self.emit(EV_REL, REL_Y, dy)?;
		}
		self.sync()
	}

	/// One wheel frame. evdev convention: `REL_WHEEL` positive scrolls up,
	/// `REL_HWHEEL` positive scrolls right.
	pub(super) fn wheel(&mut self, horizontal: bool, value: i32) -> CoreResult<()> {
		self.emit(EV_REL, if horizontal { REL_HWHEEL } else { REL_WHEEL }, value)?;
		self.sync()
	}

	/// Press or release the key at X keycode `keycode`.
	pub(super) fn key(&mut self, keycode: u8, press: bool) -> CoreResult<()> {
		let code = evdev_code(keycode).ok_or_else(|| {
			DesktopError::input_failed(format!("X keycode {keycode} has no evdev counterpart"))
		})?;
		self.emit(EV_KEY, code, i32::from(press))?;
		self.sync()
	}

	/// Unplug the device now; dropping it afterwards is a no-op.
	pub(super) fn destroy(&mut self) {
		if self.created {
			self.created = false;
			let _ = ioctl_none(self.file.as_raw_fd(), ui_dev_destroy());
		}
	}

	fn emit(&mut self, type_: u16, code: u16, value: i32) -> CoreResult<()> {
		let event = InputEvent { time: libc::timeval { tv_sec: 0, tv_usec: 0 }, type_, code, value };
		// SAFETY: InputEvent is a C-compatible plain-data kernel ABI struct and
		// the slice is bounded to its exact size.
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
		self.destroy();
	}
}

/// Whether this process may create uinput devices at all.
pub(super) fn accessible() -> bool {
	OpenOptions::new().write(true).open("/dev/uinput").is_ok()
}

/// X keycode → evdev key code; X keycodes below 8 have no evdev counterpart.
pub(super) fn evdev_code(keycode: u8) -> Option<u16> {
	keycode.checked_sub(X_KEYCODE_OFFSET).map(u16::from)
}

fn open_uinput() -> CoreResult<File> {
	OpenOptions::new()
		.write(true)
		.open("/dev/uinput")
		.map_err(|error| DesktopError::input_failed(format!("open /dev/uinput: {error}")))
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
