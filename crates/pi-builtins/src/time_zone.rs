//! The shell's time zone, as the utility builtins see it.

use jiff::tz::TimeZone;

use crate::host::Host;

/// The time zone the shell's `TZ` selects, resolved as glibc's `tzset` does:
/// unset means the system zone, a leading `:` is dropped, empty means UTC, and
/// a value that is neither an IANA name nor a POSIX TZ string falls back to
/// UTC.
///
/// Read from the shell environment, never the host process's, so `TZ=… date`
/// works at the prompt. Shared by `date`, `ls`, `touch`, `du --time`, and
/// `uptime`.
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
