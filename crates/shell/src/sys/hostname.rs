#[cfg(unix)]
use std::{ffi, io};

#[cfg(unix)]
pub(crate) fn get() -> io::Result<ffi::OsString> {
	nix::unistd::gethostname().map_err(io::Error::from)
}

#[cfg(windows)]
use std::{ffi, io};

#[cfg(windows)]
pub(crate) fn get() -> io::Result<ffi::OsString> {
	use std::os::windows::ffi::OsStringExt as _;

	use windows_sys::Win32::System::SystemInformation::GetComputerNameW;

	let mut buffer = [0_u16; 256];
	let mut length = buffer.len() as u32;
	// SAFETY: `buffer` contains `length` writable UTF-16 code units.
	if unsafe { GetComputerNameW(buffer.as_mut_ptr(), &mut length) } == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(ffi::OsString::from_wide(&buffer[..length as usize]))
}
