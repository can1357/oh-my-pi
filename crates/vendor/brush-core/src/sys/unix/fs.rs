//! Filesystem utilities.

use std::{
	os::unix::ffi::OsStringExt,
	path::{Path, PathBuf},
};

use crate::error;

#[cfg(target_os = "android")]
// _PATH_DEFPATH in https://android.googlesource.com/platform/bionic/+/refs/heads/main/libc/include/paths.h
const ANDROID_DEFPATH: &str = "/product/bin:/apex/com.android.runtime/bin:/apex/com.android.art/\
                               bin:/apex/com.android.virt/bin:/system_ext/bin:/system/bin:/system/\
                               xbin:/odm/bin:/vendor/bin:/vendor/xbin";

/// Splits a platform-specific PATH-like value into individual paths.
///
/// On Unix, this delegates to [`std::env::split_paths`].
pub fn split_paths<T: AsRef<std::ffi::OsStr> + ?Sized>(s: &T) -> std::env::SplitPaths<'_> {
	std::env::split_paths(s)
}

pub(crate) fn get_default_executable_search_paths() -> Vec<PathBuf> {
	#[cfg(target_os = "android")]
	{
		std::env::split_paths(ANDROID_DEFPATH).collect()
	}
	#[cfg(not(target_os = "android"))]
	{
		// standard hard-coded defaults for executable search path
		vec![
			"/usr/local/sbin".into(),
			"/usr/local/bin".into(),
			"/usr/sbin".into(),
			"/usr/bin".into(),
			"/sbin".into(),
			"/bin".into(),
		]
	}
}

/// Retrieves the platform-specific set of paths that should contain standard
/// system utilities. Used by `command -p`, for example.
pub fn get_default_standard_utils_paths() -> Vec<PathBuf> {
	//
	// Try to call confstr(_CS_PATH). If that fails, can't find a string value, or
	// finds an empty string, then we'll fall back to hard-coded defaults.
	//

	if let Ok(Some(cs_path)) = confstr_cs_path()
		&& !cs_path.as_os_str().is_empty()
	{
		return split_paths(&cs_path).collect();
	}

	#[cfg(target_os = "android")]
	{
		std::env::split_paths(ANDROID_DEFPATH).collect()
	}
	#[cfg(not(target_os = "android"))]
	{
		// standard hard-coded defaults
		vec![
			"/bin".into(),
			"/usr/bin".into(),
			"/sbin".into(),
			"/usr/sbin".into(),
			"/etc".into(),
			"/usr/etc".into(),
		]
	}
}

#[allow(clippy::unnecessary_wraps)]
fn confstr_cs_path() -> Result<Option<PathBuf>, std::io::Error> {
	#[cfg(target_os = "android")]
	{
		Ok(Some(PathBuf::from(ANDROID_DEFPATH)))
	}
	#[cfg(not(target_os = "android"))]
	{
		let value = confstr(nix::libc::_CS_PATH)?;

		if let Some(value) = value {
			let value_str = PathBuf::from(value);
			Ok(Some(value_str))
		} else {
			Ok(None)
		}
	}
}

/// A wrapper for [`nix::libc::confstr`]. Returns a value for the default PATH
/// variable which indicates where all the POSIX.2 standard utilities can be
/// found.
///
/// N.B. We would strongly prefer to use a safe API exposed (in an idiomatic
/// way) by nix or similar. Until that exists, we accept the need to make the
/// unsafe call directly.
#[cfg(not(target_os = "android"))]
fn confstr(name: nix::libc::c_int) -> Result<Option<std::ffi::OsString>, std::io::Error> {
	// SAFETY:
	// Calling `confstr` with a null pointer and size 0 is a documented way to query
	// the required size of the buffer to hold the value associated with `name`. It
	// should not end up causing any undefined behavior.
	let required_size = unsafe { nix::libc::confstr(name, std::ptr::null_mut(), 0) };

	// When confstr returns 0, it either means there's no value associated with
	// _CS_PATH, or _CS_PATH is considered invalid (and not present) on this
	// platform. In both cases, we treat it as a non-existent value and return
	// None.
	if required_size == 0 {
		return Ok(None);
	}

	let mut buffer = Vec::<u8>::with_capacity(required_size);

	// SAFETY:
	// We are calling `confstr` with a valid pointer and size that we obtained from
	// the allocated buffer. Writing `c_char` (i8 or u8 depending on the platform)
	// into `Vec<u8>` is fine, as i8 and u8 have compatible representations, and
	// Rust does not support platforms where `c_char` is not 8-bit wide.
	let final_size =
		unsafe { nix::libc::confstr(name, buffer.as_mut_ptr().cast(), buffer.capacity()) };

	if final_size == 0 {
		return Err(std::io::Error::last_os_error());
	}

	// Per the docs on `confstr`, it *may* return a size larger than the provided
	// buffer. In our usage we wouldn't expect to see this, as we've first queried
	// the required size. However, we defensively check for this case and return an
	// error if it happens.
	if final_size > buffer.capacity() {
		return Err(std::io::Error::other("confstr needed more space than advertised"));
	}

	// SAFETY:
	// We are trusting `confstr` to have written exactly `final_size` bytes into the
	// buffer. We have checked above that it didn't return a value *larger* than
	// the capacity of the buffer, and also checked for known error cases. Note
	// that the returned length should include the null terminator.
	unsafe { buffer.set_len(final_size) };

	// The last byte is a null terminator. We assert that it is.
	if !matches!(buffer.pop(), Some(0)) {
		return Err(std::io::Error::other("confstr did not null-terminate the returned string"));
	}

	Ok(Some(std::ffi::OsString::from_vec(buffer)))
}

/// Opens a null file that will discard all I/O.
pub fn open_null_file() -> Result<std::fs::File, error::Error> {
	let f = std::fs::File::options()
		.read(true)
		.write(true)
		.open("/dev/null")?;

	Ok(f)
}

/// Gives the platform an opportunity to handle a special file path (e.g.
/// `/dev/null`).
pub const fn try_open_special_file(_path: &Path) -> Option<Result<std::fs::File, std::io::Error>> {
	None
}

/// Returns the path to the system-wide shell profile script.
pub fn get_system_profile_path() -> Option<&'static Path> {
	Some(Path::new("/etc/profile"))
}

/// Returns the path to the system-wide shell rc script.
pub fn get_system_rc_path() -> Option<&'static Path> {
	Some(Path::new("/etc/bash.bashrc"))
}

/// Returns true if the string contains a path separator character.
///
/// On Unix, only `/` is considered a path separator.
pub fn contains_path_separator(s: &str) -> bool {
	s.contains('/')
}

/// Returns true if the string ends with a path separator character.
///
/// On Unix, only `/` is considered a path separator.
pub fn ends_with_path_separator(s: &str) -> bool {
	s.ends_with('/')
}

/// Returns the string with a trailing path separator removed, if present.
///
/// On Unix, only `/` is considered a path separator.
pub fn strip_path_separator_suffix(s: &str) -> &str {
	s.strip_suffix('/').unwrap_or(s)
}

/// Returns the platform default for case-insensitive pathname expansion.
///
/// On Unix, filesystems are typically case-sensitive, so this returns `false`.
pub const fn default_case_insensitive_path_expansion() -> bool {
	false
}

/// Finds the byte index of the last path separator in the string.
///
/// On Unix, only `/` is considered a path separator.
pub fn rfind_path_separator(s: &str) -> Option<usize> {
	s.rfind('/')
}

/// Splits a string on path separator characters, returning an iterator of
/// components.
///
/// On Unix, only `/` is used as a separator.
pub fn split_path_for_pattern(s: &str) -> impl Iterator<Item = &str> {
	s.split('/')
}

/// Returns the root path for an absolute pattern, if the first component
/// indicates one.
///
/// On Unix, an empty first component (from splitting a path like `/foo`)
/// indicates an absolute path rooted at `/`.
pub fn pattern_path_root(first_component: &str) -> Option<PathBuf> {
	if first_component.is_empty() {
		Some(PathBuf::from("/"))
	} else {
		None
	}
}

/// Pushes a component onto a path for pattern expansion.
///
/// On Unix, this delegates directly to `PathBuf::push`.
pub fn push_path_for_pattern(path: &mut std::path::PathBuf, component: &str) {
	path.push(component);
}

/// Normalizes path separators for shell output.
///
/// On Unix, this is a no-op since paths already use `/`.
pub const fn normalize_path_separators(s: &str) -> std::borrow::Cow<'_, str> {
	std::borrow::Cow::Borrowed(s)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn path_separator_helpers() {
		assert!(contains_path_separator("foo/bar"));
		assert!(!contains_path_separator("foobar"));
		// Backslashes are not separators on Unix.
		assert!(!contains_path_separator(r"foo\bar"));

		assert!(ends_with_path_separator("foo/"));
		assert!(!ends_with_path_separator("foo"));
		assert!(!ends_with_path_separator(r"foo\"));

		assert_eq!(strip_path_separator_suffix("foo/"), "foo");
		assert_eq!(strip_path_separator_suffix("foo"), "foo");
		assert_eq!(strip_path_separator_suffix(r"foo\"), r"foo\");

		assert_eq!(rfind_path_separator("a/b/c"), Some(3));
		assert_eq!(rfind_path_separator("abc"), None);
	}

	#[test]
	fn split_path_for_pattern_basic() {
		let parts: Vec<_> = split_path_for_pattern("a/b/c").collect();
		assert_eq!(parts, vec!["a", "b", "c"]);

		let parts: Vec<_> = split_path_for_pattern("/a/b").collect();
		assert_eq!(parts, vec!["", "a", "b"]);

		// Backslashes are not split on Unix.
		let parts: Vec<_> = split_path_for_pattern(r"a\b").collect();
		assert_eq!(parts, vec![r"a\b"]);
	}

	#[test]
	fn pattern_path_root_absolute() {
		assert_eq!(pattern_path_root(""), Some(PathBuf::from("/")));
	}

	#[test]
	fn pattern_path_root_relative() {
		assert_eq!(pattern_path_root("foo"), None);
		// Drive-letter syntax is not recognized on Unix.
		assert_eq!(pattern_path_root("c:"), None);
	}

	#[test]
	fn push_path_for_pattern_appends_child() {
		let mut p = PathBuf::from("/home/reuben");
		push_path_for_pattern(&mut p, "foo");
		assert_eq!(p, PathBuf::from("/home/reuben/foo"));
	}

	#[test]
	fn normalize_path_separators_is_noop() {
		use std::borrow::Cow;
		assert!(matches!(normalize_path_separators("/foo/bar"), Cow::Borrowed("/foo/bar")));
	}

	#[test]
	fn default_case_insensitive_is_false() {
		assert!(!default_case_insensitive_path_expansion());
	}
}
