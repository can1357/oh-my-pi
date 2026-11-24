//! The shell's time zone, as the utility builtins see it.

use jiff::tz::TimeZone;

use crate::host::Host;

/// The time zone the shell's `TZ` selects, resolved as glibc's `tzset` does:
/// unset means the system zone, a leading `:` is dropped, empty means UTC, and
/// a value that is neither an IANA name nor a POSIX TZ string falls back to
/// UTC.
///
/// Read from the shell environment, never the host process's, so `TZ=… date`
/// works at the prompt. Shared by builtins that format or parse shell-local
/// times.
pub(crate) fn shell_time_zone(host: &Host) -> TimeZone {
	let Some(value) = host.var("TZ") else {
		return TimeZone::system();
	};
	let value = value.strip_prefix(':').unwrap_or(value);
	if value.is_empty() {
		return TimeZone::UTC;
	}
	TimeZone::get(value)
		.or_else(|_| TimeZone::posix(value))
		.unwrap_or(TimeZone::UTC)
}

/// `datetime` plus `nanos` as a `SystemTime`, or `None` where the platform
/// cannot represent it (Windows `SystemTime` starts in 1601).
#[cfg(test)]
pub(crate) fn system_time_at(
	datetime: chrono::DateTime<chrono::Utc>,
	nanos: u64,
) -> Option<std::time::SystemTime> {
	let seconds = std::time::Duration::from_secs(datetime.timestamp().unsigned_abs());
	let base = if datetime.timestamp() >= 0 {
		std::time::SystemTime::UNIX_EPOCH.checked_add(seconds)
	} else {
		std::time::SystemTime::UNIX_EPOCH.checked_sub(seconds)
	};
	base?.checked_add(std::time::Duration::from_nanos(nanos))
}
