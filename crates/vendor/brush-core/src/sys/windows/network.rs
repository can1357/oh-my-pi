pub(crate) fn get_hostname() -> std::io::Result<std::ffi::OsString> {
	crate::sys::hostname::get()
}
