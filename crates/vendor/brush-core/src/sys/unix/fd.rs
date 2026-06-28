//! File descriptor utilities.

use std::os::fd::RawFd;

use crate::{ShellFd, error, openfiles};

cfg_if::cfg_if! {
	 if #[cfg(any(target_os = "linux", target_os = "android"))] {
		  const FD_DIR_PATH: &str = "/proc/self/fd";
	 } else if #[cfg(any(
				target_os = "freebsd",
				target_os = "macos",
				target_os = "netbsd",
				target_os = "openbsd"
		  ))] {
		  const FD_DIR_PATH: &str = "/dev/fd";
	 } else {
		  /// Returns an iterator over all open file descriptors for the shell.
		  pub fn iter_fds()
		  -> Result<impl Iterator<Item = (ShellFd, openfiles::OpenFile)>, error::Error> {
				Ok(std::iter::empty())
		  }
	 }
}

/// Makes a best-effort attempt to iterate over all open file descriptors
/// for the current process.
///
/// If the platform does not support enumerating file descriptors, an empty
/// iterator is returned. This function will skip any file descriptors that
/// cannot be opened.
#[cfg(any(
	target_os = "linux",
	target_os = "android",
	target_os = "freebsd",
	target_os = "macos",
	target_os = "netbsd",
	target_os = "openbsd"
))]
pub fn try_iter_open_fds() -> impl Iterator<Item = (ShellFd, openfiles::OpenFile)> {
	std::fs::read_dir(FD_DIR_PATH)
		.into_iter()
		.flatten()
		.filter_map(Result::ok)
		.filter_map(|entry| {
			let fd: RawFd = entry.file_name().to_str()?.parse().ok()?;

			// SAFETY:
			// We are trying to open the file descriptor we found listed
			// in the filesystem, but there's a risk that it's not the same one
			// that we enumerated or that it's since been closed. For the purposes
			// of this function, either of those outcomes are acceptable. We
			// simply skip any fds that we can't open, and the function's purpose
			// is to make a best-effort attempt to open all available fds.
			let file = unsafe { open_file_by_fd(fd) }.ok()?;

			Some((fd, file))
		})
}

/// Attempts to retrieve an `OpenFile` representation for the given already-open
/// file descriptor.
///
/// If the file descriptor cannot be opened, `None` is returned. Note that there
/// is no guarantee that the returned file matches the original file descriptor,
/// as the fd may have been closed and potentially re-used in the meantime.
///
/// # Arguments
///
/// * `fd` - The file descriptor to open.
pub fn try_get_file_for_open_fd(fd: RawFd) -> Option<openfiles::OpenFile> {
	// SAFETY:
	// We are trying to open the file descriptor provided by the caller. There's a
	// risk that the fd is invalid or has been closed since it was enumerated. For
	// the purposes of this function, we simply return None if we can't open it.
	// There's also a risk that the fd has been closed and re-used for a different
	// file; again, for the purposes of this function, we accept that
	// risk and document it as part of the function's contract.
	unsafe { open_file_by_fd(fd).ok() }
}

unsafe fn open_file_by_fd(fd: RawFd) -> Result<openfiles::OpenFile, error::Error> {
	// SAFETY: We are creating a BorrowedFd from a file descriptor. Callers
	// typically enumerate available file descriptors from procfs, devfs, or
	// similar, but there's still a risk that the fd has become invalid or closed
	// since then -- or that this function gets used incorrectly.
	let borrowed_fd = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
	let owned_fd = borrowed_fd.try_clone_to_owned()?;
	Ok(std::fs::File::from(owned_fd).into())
}
