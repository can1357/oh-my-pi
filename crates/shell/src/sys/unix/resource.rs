//! Resource utilities

use std::time;

use nix::sys::{resource, resource::UsageWho, time::TimeVal};

use crate::error;

/// Returns the user and system CPU time used by the current process;
/// expressed as a tuple containing user time and system time, in that order.
pub fn get_self_user_and_system_time() -> Result<(time::Duration, time::Duration), error::Error> {
	let usage = resource::getrusage(UsageWho::RUSAGE_SELF)?;
	Ok((convert_rusage_time(usage.user_time()), convert_rusage_time(usage.system_time())))
}

/// Returns the user and system CPU time used by child processes; expressed
/// as a tuple containing user time and system time, in that order.
pub fn get_children_user_and_system_time() -> Result<(time::Duration, time::Duration), error::Error>
{
	let usage = resource::getrusage(UsageWho::RUSAGE_CHILDREN)?;
	Ok((convert_rusage_time(usage.user_time()), convert_rusage_time(usage.system_time())))
}

const fn convert_rusage_time(time: TimeVal) -> time::Duration {
	#[allow(clippy::cast_sign_loss, reason = "rusage times are non-negative")]
	#[allow(clippy::cast_possible_truncation, reason = "microseconds fit in u32")]
	time::Duration::new(time.tv_sec() as u64, time.tv_usec() as u32 * 1000)
}
