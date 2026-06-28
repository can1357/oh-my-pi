//! File descriptor utilities.

use crate::{ShellFd, openfiles};

/// Makes a best-effort attempt to iterate over all open file descriptors for
/// the current process.
pub fn try_iter_open_fds() -> impl Iterator<Item = (ShellFd, openfiles::OpenFile)> {
	vec![
		(openfiles::OpenFiles::STDIN_FD, openfiles::OpenFile::Stdin(std::io::stdin())),
		(openfiles::OpenFiles::STDOUT_FD, openfiles::OpenFile::Stdout(std::io::stdout())),
		(openfiles::OpenFiles::STDERR_FD, openfiles::OpenFile::Stderr(std::io::stderr())),
	]
	.into_iter()
}

/// Attempts to retrieve an `OpenFile` representation for the given already-open
/// file descriptor. Returns `None` if the descriptor cannot be mapped to a
/// standard stream.
pub fn try_get_file_for_open_fd(fd: ShellFd) -> Option<openfiles::OpenFile> {
	match fd {
		openfiles::OpenFiles::STDIN_FD => Some(openfiles::OpenFile::Stdin(std::io::stdin())),
		openfiles::OpenFiles::STDOUT_FD => Some(openfiles::OpenFile::Stdout(std::io::stdout())),
		openfiles::OpenFiles::STDERR_FD => Some(openfiles::OpenFile::Stderr(std::io::stderr())),
		_ => None,
	}
}
