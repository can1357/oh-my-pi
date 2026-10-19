//! Private executable/request storage shared by macOS desktop helper processes.

use std::{
	ffi::{CString, OsStr},
	fs::{self, OpenOptions},
	io::Write,
	os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
	path::PathBuf,
};

use super::error::{CoreResult, DesktopError};

/// Owns a private helper directory and removes it after its process is reaped.
pub(crate) struct HelperDirectory(PathBuf);

impl HelperDirectory {
	/// Creates an owner-only temporary directory for one native helper.
	pub(crate) fn create(prefix: &str) -> CoreResult<Self> {
		let template = std::env::temp_dir().join(format!("{prefix}-XXXXXX"));
		let mut bytes = CString::new(template.as_os_str().as_bytes())
			.map_err(|_| DesktopError::internal("invalid native helper temporary directory"))?
			.into_bytes_with_nul();
		// SAFETY: mkdtemp receives a writable, terminated template and atomically
		// creates the private directory, replacing its trailing X characters.
		if unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) }.is_null() {
			return Err(failed(std::io::Error::last_os_error()));
		}
		bytes.pop();
		Ok(Self(PathBuf::from(OsStr::from_bytes(&bytes))))
	}

	/// Writes a new executable or request owned only by the current user.
	pub(crate) fn write(&self, name: &str, bytes: &[u8], mode: u32) -> CoreResult<PathBuf> {
		let path = self.0.join(name);
		let mut file = OpenOptions::new()
			.write(true)
			.create_new(true)
			.mode(mode)
			.open(&path)
			.map_err(failed)?;
		file.write_all(bytes).map_err(failed)?;
		Ok(path)
	}
}

impl Drop for HelperDirectory {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.0);
	}
}

fn failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::internal(format!("native desktop helper initialization failed: {error}"))
}
