//! Conversions between `SystemTime` and the `(seconds, nanoseconds)` epoch pairs the
//! wire and the file list carry. Shared by the file list, the attribute code
//! (`meta`, `tree`), option parsing (`--stop-at`), and protocol setup (checksum seed).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The current time in whole seconds since the epoch (0 for a clock before it).
pub(crate) fn unix_now() -> i64 {
	SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// `(seconds, nanoseconds)` of `time` since the epoch, nanoseconds always in `0..1e9`
/// (a pre-epoch fraction borrows a second).
pub(crate) fn split_time(time: SystemTime) -> (i64, u32) {
	match time.duration_since(UNIX_EPOCH) {
		Ok(after) => (after.as_secs() as i64, after.subsec_nanos()),
		Err(before) => {
			let before = before.duration();
			let secs = -(before.as_secs() as i64);
			match before.subsec_nanos() {
				0 => (secs, 0),
				nanos => (secs - 1, 1_000_000_000 - nanos),
			}
		},
	}
}

/// The `SystemTime` `secs` seconds plus `nsec` nanoseconds (clamped to `0..1e9`) after
/// the epoch; `None` when the platform cannot represent it.
pub(crate) fn system_time(secs: i64, nsec: i64) -> Option<SystemTime> {
	let base = if secs >= 0 {
		UNIX_EPOCH.checked_add(Duration::from_secs(secs.unsigned_abs()))
	} else {
		UNIX_EPOCH.checked_sub(Duration::from_secs(secs.unsigned_abs()))
	};
	let nsec = nsec.clamp(0, 999_999_999) as u64;
	base.and_then(|t| t.checked_add(Duration::from_nanos(nsec)))
}
