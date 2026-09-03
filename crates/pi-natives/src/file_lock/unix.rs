use std::{
	fs::{File, OpenOptions},
	io,
	os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
};

/// Unix lock held by a persistent sidecar's open file description.
pub struct PlatformFileLock {
	file: Option<File>,
}

pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	let file = OpenOptions::new()
		.read(true)
		.write(true)
		.create(true)
		.truncate(false)
		.mode(0o600)
		.open(path)?;
	// SAFETY: `file` owns a live descriptor for the duration of this call. The
	// non-blocking operation only changes the advisory lock attached to that open
	// file description.
	let status = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
	if status == 0 {
		return Ok(Some(PlatformFileLock { file: Some(file) }));
	}
	let error = io::Error::last_os_error();
	if error.kind() == io::ErrorKind::WouldBlock {
		return Ok(None);
	}
	Err(error)
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.file.take());
		Ok(())
	}
}
