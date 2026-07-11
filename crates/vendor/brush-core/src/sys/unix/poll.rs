//! File descriptor polling utilities for timeout support.

use std::{
	os::fd::BorrowedFd,
	time::{Duration, Instant},
};

use nix::poll::{PollFd, PollFlags, PollTimeout, poll};

use crate::openfiles::OpenFile;

/// Polls an open file for input readability with a timeout.
///
/// Returns `Ok(true)` if data is available for reading, `Ok(false)` if the
/// timeout elapsed without data becoming available.
///
/// For regular files, always returns `Ok(true)` immediately since they're
/// always "ready" (matching bash behavior where `-t` has no effect on regular
/// files).
///
/// # Arguments
///
/// * `file` - The open file to poll.
/// * `timeout` - Maximum time to wait. Use `Duration::ZERO` to check without
///   blocking.
///
/// # Errors
///
/// Returns an error if polling fails or the file descriptor cannot be borrowed.
pub fn poll_for_input(file: &OpenFile, timeout: Duration) -> std::io::Result<bool> {
	let fd = file
		.try_borrow_as_fd()
		.map_err(|e| std::io::Error::other(e.to_string()))?;

	// Regular files are always ready - timeout has no effect (bash behavior).
	if is_regular_file(fd) {
		return Ok(true);
	}

	// The null device reads as immediate EOF, but on macOS/BSD `poll()` never
	// reports `/dev/null` as readable. Without this shortcut a `read` builtin
	// with no `-t` deadline polls it forever (the harness wires stdin to
	// `/dev/null`). Treat it as ready and let the caller's `read` observe EOF,
	// matching `read </dev/null` in real bash (instant EOF, exit 1).
	if is_null_device(fd) {
		return Ok(true);
	}

	// Convert timeout to deadline for accurate time tracking across EINTR retries.
	let deadline = if timeout.is_zero() {
		// For zero timeout, use current instant so first check sees zero remaining.
		Some(Instant::now())
	} else {
		Some(Instant::now() + timeout)
	};

	poll_fd_for_input(fd, deadline)
}

/// Polls a file descriptor for input readability with a deadline.
///
/// Returns `Ok(true)` if data is available, `Ok(false)` if deadline passed.
///
/// # Arguments
///
/// * `fd` - File descriptor to poll
/// * `deadline` - Optional deadline; `None` indicates no deadline.
fn poll_fd_for_input(fd: BorrowedFd<'_>, deadline: Option<Instant>) -> std::io::Result<bool> {
	let mut poll_fds = [PollFd::new(fd, PollFlags::POLLIN)];
	let mut first_iteration = true;

	loop {
		// Calculate remaining time on each iteration to handle EINTR correctly.
		let timeout_ms = match deadline {
			Some(d) => {
				let remaining = d.saturating_duration_since(Instant::now());
				// On first iteration, always do at least one poll even with zero timeout.
				// This allows `-t 0` to check if input is immediately available.
				if remaining.is_zero() && !first_iteration {
					return Ok(false); // Deadline passed after initial poll.
				}
				i32::try_from(remaining.as_millis()).unwrap_or(i32::MAX)
			},
			None => -1, // Block indefinitely.
		};
		first_iteration = false;
		let poll_timeout = PollTimeout::try_from(timeout_ms).unwrap_or(PollTimeout::MAX);

		match poll(&mut poll_fds, poll_timeout) {
			Ok(0) => return Ok(false), // Timeout
			Ok(_) => {
				let revents = poll_fds[0].revents().unwrap_or(PollFlags::empty());
				// POLLIN means data available. POLLHUP/POLLERR without POLLIN means
				// EOF/error - return true so caller reads and gets the proper result.
				return Ok(
					revents.intersects(PollFlags::POLLIN | PollFlags::POLLHUP | PollFlags::POLLERR)
				);
			},
			Err(nix::errno::Errno::EINTR) => (), // Retry on signal with recalculated timeout.
			Err(e) => return Err(std::io::Error::from_raw_os_error(e as i32)),
		}
	}
}

/// Checks if a file descriptor refers to a regular file.
///
/// Regular files are always "ready" for reading (poll has no effect).
///
/// # Arguments
///
/// * `fd` - File descriptor to check
fn is_regular_file(fd: BorrowedFd<'_>) -> bool {
	match nix::sys::stat::fstat(fd) {
		Ok(stat) => {
			use nix::sys::stat::{SFlag, mode_t};
			mode_t::try_from(stat.st_mode)
				.is_ok_and(|mode| SFlag::from_bits_truncate(mode).contains(SFlag::S_IFREG))
		},
		Err(_) => false,
	}
}

/// Checks if a file descriptor refers to the null device (`/dev/null`).
///
/// Reading the null device yields immediate EOF, so callers can treat it as
/// always "ready" instead of polling — which never reports readable on
/// macOS/BSD and would otherwise spin indefinitely.
///
/// # Arguments
///
/// * `fd` - File descriptor to check
fn is_null_device(fd: BorrowedFd<'_>) -> bool {
	use nix::sys::stat::{SFlag, fstat, mode_t};
	let Ok(st) = fstat(fd) else { return false };
	// `/dev/null` is a character special device; the rdev compare distinguishes
	// it from other char devices (ttys, /dev/zero, …) so we never short-circuit
	// a fd that genuinely needs polling.
	let is_char_device = mode_t::try_from(st.st_mode)
		.is_ok_and(|mode| SFlag::from_bits_truncate(mode).contains(SFlag::S_IFCHR));
	is_char_device && null_device_rdev().is_some_and(|rdev| st.st_rdev == rdev)
}

/// Returns the device id (`st_rdev`) of `/dev/null`, resolved once and cached.
///
/// `None` when `/dev/null` cannot be stat'd, in which case
/// [`is_null_device`] conservatively reports `false`.
fn null_device_rdev() -> Option<libc::dev_t> {
	use std::sync::OnceLock;
	static RDEV: OnceLock<Option<libc::dev_t>> = OnceLock::new();
	*RDEV.get_or_init(|| nix::sys::stat::stat("/dev/null").ok().map(|st| st.st_rdev))
}

#[cfg(test)]
mod tests {
	use std::{os::fd::AsFd, time::Duration};

	use super::*;

	#[test]
	fn null_device_polls_ready() {
		// Regression: on macOS `poll(/dev/null, POLLIN)` times out forever, so a
		// `read` with no `-t` deadline hangs. `poll_for_input` must report ready.
		let Ok(null) = crate::openfiles::null() else { return };
		let ready = poll_for_input(&null, Duration::from_millis(50));
		assert!(matches!(ready, Ok(true)));
	}

	#[test]
	fn null_device_detection_is_specific() {
		let Ok(null) = std::fs::File::open("/dev/null") else { return };
		assert!(is_null_device(null.as_fd()));

		// A regular file is not the null device.
		let Ok(tmp) = tempfile::NamedTempFile::new() else { return };
		assert!(!is_null_device(tmp.as_file().as_fd()));
	}
}
