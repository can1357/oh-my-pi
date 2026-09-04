//! File descriptor utilities.

use std::io;

use crate::{
	ShellFd,
	openfiles::{self, OpenFile},
};

/// Makes a best-effort attempt to iterate over all open file descriptors for
/// the current process.
pub fn try_iter_open_fds() -> impl Iterator<Item = (ShellFd, OpenFile)> {
	vec![
		(openfiles::OpenFiles::STDIN_FD, OpenFile::Stdin(std::io::stdin())),
		(openfiles::OpenFiles::STDOUT_FD, OpenFile::Stdout(std::io::stdout())),
		(openfiles::OpenFiles::STDERR_FD, OpenFile::Stderr(std::io::stderr())),
	]
	.into_iter()
}

/// Attempts to retrieve an `OpenFile` representation for the given already-open
/// file descriptor. Returns `None` if the descriptor cannot be mapped to a
/// standard stream.
pub fn try_get_file_for_open_fd(fd: ShellFd) -> Option<OpenFile> {
	match fd {
		openfiles::OpenFiles::STDIN_FD => Some(OpenFile::Stdin(io::stdin())),
		openfiles::OpenFiles::STDOUT_FD => Some(OpenFile::Stdout(io::stdout())),
		openfiles::OpenFiles::STDERR_FD => Some(OpenFile::Stderr(io::stderr())),
		_ => None,
	}
}
