use std::{
	fs::{File, OpenOptions, TryLockError},
	io,
	os::unix::fs::OpenOptionsExt,
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
	// The lock is attached to this open file description (`flock(2)`).
	match file.try_lock() {
		Ok(()) => Ok(Some(PlatformFileLock { file: Some(file) })),
		Err(TryLockError::WouldBlock) => Ok(None),
		Err(TryLockError::Error(error)) => Err(error),
	}
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.file.take());
		Ok(())
	}
}
