use std::{ffi, io};
pub(crate) fn get_hostname() -> io::Result<ffi::OsString> {
	Ok("".into())
}
