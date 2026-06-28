//! Signal processing utilities

use crate::error;

/// Returns the user and system CPU time used by the current process.
///
/// This is a stub implementation that returns zero durations.
pub fn get_self_user_and_system_time()
-> Result<(std::time::Duration, std::time::Duration), error::Error> {
	Ok((std::time::Duration::ZERO, std::time::Duration::ZERO))
}

/// Returns the user and system CPU time used by child processes.
///
/// This is a stub implementation that returns zero durations.
pub fn get_children_user_and_system_time()
-> Result<(std::time::Duration, std::time::Duration), error::Error> {
	Ok((std::time::Duration::ZERO, std::time::Duration::ZERO))
}
