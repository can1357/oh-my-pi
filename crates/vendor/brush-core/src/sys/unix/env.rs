//! Environment variable retrieval for Unix platforms.

/// Retrieves environment variables from the host process.
///
/// This is a best-effort passthrough to [`std::env::vars()`], skipping entries
/// whose key or value is not valid Unicode: a corrupt entry carries no usable
/// meaning, and a naive [`std::env::vars()`] call panics on the first one
/// before any command can run.
pub(crate) fn get_host_env_vars() -> impl Iterator<Item = (String, String)> {
	std::env::vars_os().filter_map(|(key, value)| {
		let key = key.into_string().ok()?;
		let value = value.into_string().ok()?;
		Some((key, value))
	})
}

#[cfg(test)]
mod tests {
	use std::os::unix::ffi::OsStrExt;

	use super::*;

	/// Regression for oh-my-pi #8925: `std::env::vars()` panics on a key or
	/// value that is not valid Unicode (e.g. the corrupt `GHOSTTY_BIN_DIR`
	/// delivered by cmux/Ghostty, bytes `9d d9 50`). Shells that call this to
	/// inherit the host environment must skip such entries, never crash.
	#[test]
	fn get_host_env_vars_skips_non_utf8_entries() {
		// SAFETY: the corrupt + sentinel keys are unique to this test and the
		// environment is not contended elsewhere in this process.
		unsafe {
			std::env::set_var("OMP_TEST_BAD_VALUE_8925", std::ffi::OsStr::from_bytes(&[0x9d, 0xd9, 0x50]));
			std::env::set_var(std::ffi::OsStr::from_bytes(b"\xffOMP_TEST_BAD_KEY_8925"), "value");
			std::env::set_var("OMP_TEST_KEEP_8925", "kept");
		}

		let entries: Vec<(String, String)> = get_host_env_vars().collect();

		assert!(
			!entries.iter().any(|(key, _)| key == "OMP_TEST_BAD_VALUE_8925"),
			"a non-UTF-8 value must be skipped"
		);
		assert!(
			!entries.iter().any(|(key, _)| key.contains("OMP_TEST_BAD_KEY")),
			"a non-UTF-8 key must be skipped"
		);
		assert!(
			entries.iter().any(|(key, value)| key == "OMP_TEST_KEEP_8925" && value == "kept"),
			"valid entries must still be returned"
		);

		// SAFETY: reads are done; restore the host environment.
		unsafe {
			std::env::remove_var("OMP_TEST_BAD_VALUE_8925");
			std::env::remove_var(std::ffi::OsStr::from_bytes(b"\xffOMP_TEST_BAD_KEY_8925"));
			std::env::remove_var("OMP_TEST_KEEP_8925");
		}
	}
}
