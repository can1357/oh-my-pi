//! Stub file descriptor polling utilities for platforms without poll support.

use std::time::Duration;

use crate::openfiles::OpenFile;

/// Stub implementation that always returns an unsupported error.
///
/// Timeout-based reading is not supported on this platform.
pub fn poll_for_input(_file: &OpenFile, _timeout: Duration) -> std::io::Result<bool> {
	Err(std::io::Error::new(
		std::io::ErrorKind::Unsupported,
		"poll-based timeout is not supported on this platform",
	))
}
