#[cfg(not(target_os = "linux"))]
use std::fs::TryLockError;
use std::{
	fs::{File, OpenOptions},
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
	Ok(lock_exclusive(&file)?.then(|| PlatformFileLock { file: Some(file) }))
}

#[cfg(target_os = "linux")]
fn lock_exclusive(file: &File) -> io::Result<bool> {
	match whole_file_lock(file, libc::F_OFD_SETLK, libc::F_WRLCK as libc::c_short) {
		Ok(_) => Ok(true),
		Err(error) if matches!(error.raw_os_error(), Some(libc::EAGAIN | libc::EACCES)) => Ok(false),
		Err(error) => Err(error),
	}
}

#[cfg(not(target_os = "linux"))]
fn lock_exclusive(file: &File) -> io::Result<bool> {
	match file.try_lock() {
		Ok(()) => Ok(true),
		Err(TryLockError::WouldBlock) => Ok(false),
		Err(TryLockError::Error(error)) => Err(error),
	}
}

#[cfg(target_os = "linux")]
const PROBE_COMMAND: libc::c_int = libc::F_OFD_GETLK;
#[cfg(not(any(target_os = "linux", target_os = "android")))]
const PROBE_COMMAND: libc::c_int = libc::F_GETLK;

/// `flock(2)` has no query, but macOS and the BSDs keep `flock` and `fcntl`
/// locks on one per-vnode list, and `F_GETLK` returns the first lock there
/// that conflicts with the query, `flock` ones included (XNU `lf_getblock`;
/// their owner reads back as pid -1). Querying a whole-file read lock therefore
/// observes an exclusive holder without locking anything, so a concurrent
/// `try_acquire` never meets the probe. A missing sidecar means nobody ever
/// locked the path.
#[cfg(not(target_os = "android"))]
pub fn is_held(path: &str) -> io::Result<bool> {
	let file = match OpenOptions::new().read(true).open(path) {
		Ok(file) => file,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
		Err(error) => return Err(error),
	};
	let conflicting = whole_file_lock(&file, PROBE_COMMAND, libc::F_RDLCK as libc::c_short)?;
	Ok(conflicting != libc::F_UNLCK as libc::c_short)
}

/// Android runs a Linux kernel, which keeps `flock` locks apart from `fcntl`
/// ones, so `F_GETLK` cannot see a holder; report the probe as unsupported.
#[cfg(target_os = "android")]
pub fn is_held(_path: &str) -> io::Result<bool> {
	Err(io::ErrorKind::Unsupported.into())
}

#[cfg(not(target_os = "android"))]
fn whole_file_lock(
	file: &File,
	command: libc::c_int,
	lock_type: libc::c_short,
) -> io::Result<libc::c_short> {
	use std::os::fd::AsRawFd;

	// SAFETY: an all-zero `flock` is valid. Zero `l_whence` is `SEEK_SET`, zero
	// `l_start`/`l_len` from there covers the whole file, and zero `l_pid` is
	// what the `F_OFD_*` commands require.
	let mut lock: libc::flock = unsafe { std::mem::zeroed() };
	lock.l_type = lock_type;
	// SAFETY: `file` owns a live descriptor and `lock` is a valid `flock` for
	// the duration of the call.
	if unsafe { libc::fcntl(file.as_raw_fd(), command, &raw mut lock) } == -1 {
		return Err(io::Error::last_os_error());
	}
	Ok(lock.l_type)
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.file.take());
		Ok(())
	}
}
