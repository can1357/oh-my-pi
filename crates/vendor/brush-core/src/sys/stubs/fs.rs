//! Filesystem utilities (stubs).

use crate::error;

pub(crate) trait MetadataExt {
	fn gid(&self) -> u32 {
		0
	}

	fn uid(&self) -> u32 {
		0
	}
}

impl MetadataExt for std::fs::Metadata {}

pub(crate) fn get_default_executable_search_paths() -> Vec<std::path::PathBuf> {
	vec![]
}

/// Returns the default paths where standard Unix utilities are typically
/// installed. This is a stub implementation that returns an empty vector.
pub fn get_default_standard_utils_paths() -> Vec<std::path::PathBuf> {
	vec![]
}

/// Opens a null file that will discard all I/O.
///
/// This is a stub implementation that returns an error.
pub fn open_null_file() -> Result<std::fs::File, error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("opening null file").into())
}

/// Gives the platform an opportunity to handle a special file path (e.g.
/// `/dev/null`).
//
// This is a stub implementation that returns no result.
pub fn try_open_special_file(
	_path: &std::path::Path,
) -> Option<Result<std::fs::File, std::io::Error>> {
	None
}

/// Returns the path to the system-wide shell profile script.
///
/// Stub implementation that returns `None`.
pub fn get_system_profile_path() -> Option<&'static std::path::Path> {
	None
}

/// Returns the path to the system-wide shell rc script.
///
/// Stub implementation that returns `None`.
pub fn get_system_rc_path() -> Option<&'static std::path::Path> {
	None
}

/// Returns the platform default for case-insensitive pathname expansion.
///
/// In the stub implementation, this returns `false`.
pub const fn default_case_insensitive_path_expansion() -> bool {
	false
}

/// Returns true if the string contains a path separator character.
///
/// In the stub implementation, only `/` is considered a path separator.
pub fn contains_path_separator(s: &str) -> bool {
	s.contains('/')
}

/// Returns true if the string ends with a path separator character.
///
/// In the stub implementation, only `/` is considered a path separator.
pub fn ends_with_path_separator(s: &str) -> bool {
	s.ends_with('/')
}

/// Returns the string with a trailing path separator removed, if present.
///
/// In the stub implementation, only `/` is considered a path separator.
pub fn strip_path_separator_suffix(s: &str) -> &str {
	s.strip_suffix('/').unwrap_or(s)
}

/// Finds the byte index of the last path separator in the string.
///
/// In the stub implementation, only `/` is considered a path separator.
pub fn rfind_path_separator(s: &str) -> Option<usize> {
	s.rfind('/')
}

/// Splits a string on path separator characters, returning an iterator of
/// components.
///
/// In the stub implementation, only `/` is used as a separator.
pub fn split_path_for_pattern(s: &str) -> impl Iterator<Item = &str> {
	s.split('/')
}

/// Returns the root path for an absolute pattern, if the first component
/// indicates one.
///
/// In the stub implementation, an empty first component indicates an absolute
/// path.
pub fn pattern_path_root(first_component: &str) -> Option<std::path::PathBuf> {
	if first_component.is_empty() {
		Some(std::path::PathBuf::from("/"))
	} else {
		None
	}
}

/// Pushes a component onto a path for pattern expansion.
///
/// In the stub implementation, this delegates directly to `PathBuf::push`.
pub fn push_path_for_pattern(path: &mut std::path::PathBuf, component: &str) {
	path.push(component);
}

/// Normalizes path separators for shell output.
///
/// In the stub implementation, this is a no-op.
pub const fn normalize_path_separators(s: &str) -> std::borrow::Cow<'_, str> {
	std::borrow::Cow::Borrowed(s)
}

/// Resolves an owned path to the actual on-disk executable file, if any.
///
/// In the stub implementation, returns the path unchanged if it is
/// executable (per the stub `PathExt`, which considers every path
/// executable).
pub fn resolve_executable(path: std::path::PathBuf) -> Option<std::path::PathBuf> {
	use crate::sys::fs::PathExt;
	if path.as_path().executable() {
		Some(path)
	} else {
		None
	}
}
