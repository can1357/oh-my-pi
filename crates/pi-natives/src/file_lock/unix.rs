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

/// `flock(2)` has no query, but macOS and the BSDs keep `flock` and `fcntl`
/// locks on one per-vnode list, and `F_GETLK` returns the first lock there
/// that conflicts with the query, `flock` ones included (XNU `lf_getblock`;
/// their owner reads back as pid -1). Querying a whole-file read lock therefore
/// observes an exclusive holder without locking anything, so a concurrent
/// `try_acquire` never meets the probe. A missing sidecar means nobody ever
/// locked the path.
#[cfg(not(target_os = "android"))]
pub fn is_held(path: &str) -> io::Result<bool> {
	use std::os::fd::AsRawFd;

	let file = match OpenOptions::new().read(true).open(path) {
		Ok(file) => file,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
		Err(error) => return Err(error),
	};
	// SAFETY: an all-zero `flock` is valid. Zero `l_whence` is `SEEK_SET`, and
	// zero `l_start`/`l_len` from there covers the whole file.
	let mut query: libc::flock = unsafe { std::mem::zeroed() };
	query.l_type = libc::F_RDLCK;
	// SAFETY: `file` owns a live descriptor and `query` is a valid `flock` for
	// the duration of the call; `F_GETLK` only reads lock state into it.
	if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &raw mut query) } == -1 {
		return Err(io::Error::last_os_error());
	}
	Ok(query.l_type != libc::F_UNLCK as libc::c_short)
}

/// Android runs a Linux kernel, which keeps `flock` locks apart from `fcntl`
/// ones, so `F_GETLK` cannot see a holder; report the probe as unsupported.
#[cfg(target_os = "android")]
pub fn is_held(_path: &str) -> io::Result<bool> {
	Err(io::ErrorKind::Unsupported.into())
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.file.take());
		Ok(())
	}
}
