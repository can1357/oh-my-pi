//! File descriptor utilities.

use std::iter;

use crate::{
	ShellFd, error,
	openfiles::{self, OpenFile},
};

/// Stub implementation for platforms that do not support enumerating file
/// descriptors.
pub fn try_iter_open_fds() -> impl Iterator<Item = (ShellFd, OpenFile)> {
	iter::empty()
}

/// Stub implementation for platforms that do not support opening file
/// descriptors.
pub fn try_get_file_for_open_fd(_fd: ShellFd) -> Option<OpenFile> {
	None
}
