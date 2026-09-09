//! Stub file descriptor polling utilities for platforms without poll support.

use std::{io, time::Duration};

use crate::openfiles::OpenFile;

/// Stub implementation that always returns an unsupported error.
///
/// Timeout-based reading is not supported on this platform.
pub fn poll_for_input(_file: &OpenFile, _timeout: Duration) -> io::Result<bool> {
	Err(io::Error::new(
		io::ErrorKind::Unsupported,
		"poll-based timeout is not supported on this platform",
	))
}
