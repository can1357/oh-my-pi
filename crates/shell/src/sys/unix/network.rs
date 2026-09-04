use std::{ffi, io};

use crate::sys::hostname;
pub(crate) fn get_hostname() -> io::Result<ffi::OsString> {
	hostname::get()
}
