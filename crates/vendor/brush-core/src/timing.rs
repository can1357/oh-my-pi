//! Command timing

use crate::error;

struct StopwatchTime {
	now:             std::time::SystemTime,
	self_user:       std::time::Duration,
	self_system:     std::time::Duration,
	children_user:   std::time::Duration,
	children_system: std::time::Duration,
}

impl StopwatchTime {
	#[allow(clippy::unchecked_time_subtraction)]
	fn minus(&self, other: &Self) -> Result<StopwatchTiming, error::Error> {
		let user = (self.self_user - other.self_user) + (self.children_user - other.children_user);
		let system =
			(self.self_system - other.self_system) + (self.children_system - other.children_system);

		Ok(StopwatchTiming { wall: self.now.duration_since(other.now)?, user, system })
	}
}

pub(crate) struct Stopwatch {
	start: StopwatchTime,
}

impl Stopwatch {
	pub fn stop(&self) -> Result<StopwatchTiming, error::Error> {
		let end = get_current_stopwatch_time()?;
		end.minus(&self.start)
	}
}
pub(crate) struct StopwatchTiming {
	pub wall:   std::time::Duration,
	pub user:   std::time::Duration,
	pub system: std::time::Duration,
}

pub(crate) fn start_timing() -> Result<Stopwatch, error::Error> {
	Ok(Stopwatch { start: get_current_stopwatch_time()? })
}

fn get_current_stopwatch_time() -> Result<StopwatchTime, error::Error> {
	let now = std::time::SystemTime::now();
	let (self_user, self_system) = crate::sys::resource::get_self_user_and_system_time()?;
	let (children_user, children_system) =
		crate::sys::resource::get_children_user_and_system_time()?;

	Ok(StopwatchTime { now, self_user, self_system, children_user, children_system })
}

/// Format the given duration in a non-POSIX-y way.
///
/// # Arguments
///
/// * `duration` - The duration to format.
pub fn format_duration_non_posixly(duration: &std::time::Duration) -> String {
	let minutes = duration.as_secs() / 60;
	let seconds = duration.as_secs() % 60;
	let millis = duration.subsec_millis();
	format!("{minutes}m{seconds}.{millis:03}s")
}

/// Format the given duration in a POSIX-y way.
///
/// # Arguments
///
/// * `duration` - The duration to format.
pub fn format_duration_posixly(duration: &std::time::Duration) -> String {
	let seconds = duration.as_secs();
	let ten_millis = duration.subsec_millis() / 10;
	format!("{seconds}.{ten_millis:02}")
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;

	#[test]
	fn test_format_time() {
		assert_eq!(format_duration_non_posixly(&Duration::from_millis(0)), "0m0.000s");
		assert_eq!(format_duration_non_posixly(&Duration::from_millis(1)), "0m0.001s");
		assert_eq!(format_duration_non_posixly(&Duration::from_millis(123)), "0m0.123s");
		assert_eq!(format_duration_non_posixly(&Duration::from_millis(1234)), "0m1.234s");
		assert_eq!(format_duration_non_posixly(&Duration::from_millis(12345)), "0m12.345s");
		assert_eq!(format_duration_non_posixly(&Duration::from_millis(123_456)), "2m3.456s");
		assert_eq!(format_duration_non_posixly(&Duration::from_millis(1_234_567)), "20m34.567s");

		assert_eq!(format_duration_non_posixly(&Duration::from_micros(1)), "0m0.000s");
		assert_eq!(format_duration_non_posixly(&Duration::from_micros(999)), "0m0.000s");
		assert_eq!(format_duration_non_posixly(&Duration::from_micros(1001)), "0m0.001s");
	}
}
