//! Filesystem utilities

use std::{
	borrow::Cow,
	path::{Path, PathBuf},
};

#[cfg(windows)]
use std::os::windows::ffi::{OsStrExt, OsStringExt};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{GetLongPathNameW, GetShortPathNameW};

/// Normalizes shell-facing path aliases before `std::fs` sees them.
#[allow(clippy::missing_const_for_fn, reason = "Windows implementation allocates")]
pub fn normalize_shell_path(path: &Path) -> Cow<'_, Path> {
	#[cfg(windows)]
	{
		translate_unix_drive_path(path).map_or(Cow::Borrowed(path), Cow::Owned)
	}
	#[cfg(not(windows))]
	{
		Cow::Borrowed(path)
	}
}

/// Expand 8.3 short-name components (e.g. `ADMINI~1`) in `path` to their long
/// form, leaving the path otherwise unchanged.
#[cfg(windows)]
pub fn expand_to_long_path(path: &Path) -> PathBuf {
	expand_to_long_path_impl(path)
}

/// Non-Windows: no 8.3 short names, return unchanged.
#[cfg(not(windows))]
pub fn expand_to_long_path(path: &Path) -> PathBuf {
	path.to_path_buf()
}

/// Windows implementation using `GetLongPathNameW`, which resolves short-name
/// aliases but — unlike `std::fs::canonicalize` — does **not** resolve symlinks
/// or junctions, so `cd` into a symlink keeps the symlink spelling (the
/// shell's existing behavior). A path with no short names is returned
/// unchanged; on failure the input is returned as-is.
#[cfg(windows)]
fn expand_to_long_path_impl(path: &Path) -> PathBuf {
	// Encode straight from the wide form: Windows `OsStr` is UTF-16 and may
	// not round-trip through UTF-8, so a `to_str()` detour would silently skip
	// expansion for those paths — exactly the identity split this function
	// exists to avoid.
	let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();

	// First call with a null buffer returns the required size (including the
	// terminating NUL); the fill call returns the length excluding the NUL.
	// GetLongPathNameW returns 0 on failure (e.g. nonexistent path), in which
	// case the input is returned unchanged.
	let needed = unsafe { GetLongPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
	if needed == 0 {
		return path.to_path_buf();
	}
	let mut buf = vec![0u16; needed as usize];
	loop {
		let written =
			unsafe { GetLongPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
		if written == 0 {
			return path.to_path_buf();
		}
		let written = written as usize;
		if written <= buf.len() {
			// `written` excludes the NUL; drop any trailing padding so
			// `from_wide` (which does not stop at a NUL) sees only the path.
			buf.truncate(written);
			break;
		}
		// The long form grew between the sizing call and the fill call:
		// `written` is the new required size (including the NUL). Grow and
		// retry rather than returning partial/zero-padded garbage.
		buf = vec![0u16; written];
	}
	PathBuf::from(std::ffi::OsString::from_wide(&buf))
}

/// Returns a Windows drive root for a shell pattern that starts with an MSYS/WSL drive alias.
#[allow(clippy::missing_const_for_fn, reason = "Windows implementation allocates")]
pub fn pattern_drive_alias_root(
	starts_with_forward_slash: bool,
	first: &str,
	second: Option<&str>,
	third: Option<&str>,
) -> Option<(PathBuf, usize)> {
	#[cfg(windows)]
	{
		pattern_drive_alias_root_impl(starts_with_forward_slash, first, second, third)
	}
	#[cfg(not(windows))]
	{
		let _ = (starts_with_forward_slash, first, second, third);
		None
	}
}

#[cfg(any(windows, test))]
fn pattern_drive_alias_root_impl(
	starts_with_forward_slash: bool,
	first: &str,
	second: Option<&str>,
	third: Option<&str>,
) -> Option<(PathBuf, usize)> {
	if !starts_with_forward_slash || !first.is_empty() {
		return None;
	}

	if let Some(drive) = second
		&& is_ascii_drive_component(drive)
	{
		return Some((drive_root_path(drive.as_bytes()[0]), 2));
	}

	if let (Some(mount), Some(drive)) = (second, third)
		&& mount.eq_ignore_ascii_case("mnt")
		&& is_ascii_drive_component(drive)
	{
		return Some((drive_root_path(drive.as_bytes()[0]), 3));
	}

	None
}

#[cfg(any(windows, test))]
fn drive_root_path(drive: u8) -> PathBuf {
	let mut root = String::with_capacity(3);
	root.push(char::from(drive).to_ascii_uppercase());
	root.push(':');
	root.push('/');
	PathBuf::from(root)
}

#[cfg(any(windows, test))]
const fn is_ascii_drive_component(value: &str) -> bool {
	value.len() == 1 && value.as_bytes()[0].is_ascii_alphabetic()
}

#[cfg(any(windows, test))]
fn translate_unix_drive_path(path: &Path) -> Option<PathBuf> {
	let raw = path.to_str()?;
	let bytes = raw.as_bytes();
	let (drive, tail) = drive_alias_parts(bytes)?;

	// `tail` is a suffix of the valid UTF-8 `raw` beginning at an ASCII `/`
	// boundary, so it is itself valid UTF-8. Translate separators per `char` —
	// iterating bytes would split multibyte scalars (e.g. `José` → `JosÃ©`).
	let tail = std::str::from_utf8(tail).ok()?;
	let mut native = String::with_capacity(3 + tail.len());
	native.push(char::from(drive).to_ascii_uppercase());
	native.push(':');
	native.push('\\');
	for ch in tail.chars() {
		native.push(if ch == '/' || ch == '\\' { '\\' } else { ch });
	}
	Some(PathBuf::from(native))
}

#[cfg(any(windows, test))]
fn drive_alias_parts(bytes: &[u8]) -> Option<(u8, &[u8])> {
	if bytes.len() >= 2
		&& bytes[0] == b'/'
		&& bytes[1].is_ascii_alphabetic()
		&& bytes.get(2).is_none_or(|byte| *byte == b'/')
	{
		let tail = if bytes.len() > 2 { &bytes[3..] } else { &[] };
		return Some((bytes[1], tail));
	}

	if bytes.len() >= 6
		&& bytes[0] == b'/'
		&& bytes[1..4].eq_ignore_ascii_case(b"mnt")
		&& bytes[4] == b'/'
		&& bytes[5].is_ascii_alphabetic()
		&& bytes.get(6).is_none_or(|byte| *byte == b'/')
	{
		let tail = if bytes.len() > 6 { &bytes[7..] } else { &[] };
		return Some((bytes[5], tail));
	}

	None
}

pub use super::platform::fs::*;

/// Extension trait for path-related filesystem operations.
pub trait PathExt {
	/// Returns true if the path exists and is readable by the current user.
	fn readable(&self) -> bool;
	/// Returns true if the path exists and is writable by the current user.
	fn writable(&self) -> bool;
	/// Returns true if the path exists and is executable by the current user.
	///
	/// On Windows, this returns true if *either* the path itself is a file with
	/// a `PATHEXT` extension *or* appending some `PATHEXT` extension resolves
	/// to an existing file. To recover the actual on-disk path in the
	/// latter case, use [`resolve_executable`] which takes ownership
	/// and avoids copies on platforms where no resolution is needed.
	fn executable(&self) -> bool;

	/// Returns true if the path exists and is a block device.
	fn exists_and_is_block_device(&self) -> bool;
	/// Returns true if the path exists and is a character device.
	fn exists_and_is_char_device(&self) -> bool;
	/// Returns true if the path exists and is a FIFO (named pipe).
	fn exists_and_is_fifo(&self) -> bool;
	/// Returns true if the path exists and is a socket.
	fn exists_and_is_socket(&self) -> bool;
	/// Returns true if the path exists and has the setgid bit set.
	fn exists_and_is_setgid(&self) -> bool;
	/// Returns true if the path exists and has the setuid bit set.
	fn exists_and_is_setuid(&self) -> bool;
	/// Returns true if the path exists and has the sticky bit set.
	fn exists_and_is_sticky_bit(&self) -> bool;

	/// Returns the device ID and inode number for the path.
	fn get_device_and_inode(&self) -> Result<(u64, u64), crate::error::Error>;
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `GetShortPathNameW` is the deterministic inverse of
	/// `GetLongPathNameW`: compute the short form of the temp dir, feed it in,
	/// and assert the long form comes back. This actually exercises 8.3
	/// expansion (and fails if the expansion is reverted) on any host, even
	/// one whose own paths are already long-form.
	#[cfg(windows)]
	#[test]
	fn expand_to_long_path_resolves_short_names() {
		let long = std::env::temp_dir();
		let wide: Vec<u16> = long.as_os_str().encode_wide().chain(Some(0)).collect();
		let needed = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
		assert!(needed > 0, "GetShortPathNameW failed for {}", long.display());
		let mut buf = vec![0u16; needed as usize];
		let written = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
		assert!(written > 0, "GetShortPathNameW fill failed for {}", long.display());
		buf.truncate(written as usize);
		let short = PathBuf::from(std::ffi::OsString::from_wide(&buf));

		// Both spellings must collapse to the identical long-form string;
		// `canonicalize` is deliberately avoided here because it adds a
		// `\\?\` extended prefix and resolves symlinks — neither is part of
		// the identity this function stores.
		let expanded = expand_to_long_path(&short);
		assert_eq!(expand_to_long_path(&long), expanded);

		let short_name_segment = |seg: std::path::Component<'_>| {
			let s = seg.as_os_str().to_string_lossy();
			if let Some(tilde) = s.find('~') {
				let after = &s[tilde + 1..];
				!after.is_empty() && after.chars().all(|c| c.is_ascii_digit())
			} else {
				false
			}
		};
		assert!(
			!expanded.components().any(short_name_segment),
			"expand_to_long_path left an 8.3 short segment: {} -> {}",
			short.display(),
			expanded.display()
		);
	}

	#[test]
	fn unix_drive_aliases_translate_to_windows_roots() {
		assert_eq!(translate_unix_drive_path(Path::new("/c")).as_deref(), Some(Path::new("C:\\")));
		assert_eq!(
			translate_unix_drive_path(Path::new("/d/project/app")).as_deref(),
			Some(Path::new("D:\\project\\app")),
		);
		assert_eq!(
			translate_unix_drive_path(Path::new("/D/project")).as_deref(),
			Some(Path::new("D:\\project")),
		);
	}

	#[test]
	fn wsl_mount_drive_aliases_translate_to_windows_roots() {
		assert_eq!(
			translate_unix_drive_path(Path::new("/mnt/d/project")).as_deref(),
			Some(Path::new("D:\\project")),
		);
		assert_eq!(
			translate_unix_drive_path(Path::new("/MNT/c")).as_deref(),
			Some(Path::new("C:\\")),
		);
	}

	#[test]
	fn drive_alias_tail_preserves_non_ascii_components() {
		assert_eq!(
			translate_unix_drive_path(Path::new("/c/Users/José/file")).as_deref(),
			Some(Path::new("C:\\Users\\José\\file")),
		);
		assert_eq!(
			translate_unix_drive_path(Path::new("/mnt/d/项目/データ")).as_deref(),
			Some(Path::new("D:\\项目\\データ")),
		);
	}

	#[test]
	fn pattern_drive_alias_roots_report_consumed_components() {
		assert_eq!(
			pattern_drive_alias_root_impl(true, "", Some("d"), Some("project")),
			Some((PathBuf::from("D:/"), 2)),
		);
		assert_eq!(
			pattern_drive_alias_root_impl(true, "", Some("mnt"), Some("d")),
			Some((PathBuf::from("D:/"), 3)),
		);
	}

	#[test]
	fn pattern_drive_alias_roots_require_forward_slash_prefix() {
		assert_eq!(pattern_drive_alias_root_impl(false, "", Some("d"), Some("logs")), None);
		assert_eq!(
			pattern_drive_alias_root_impl(false, "", Some("mnt"), Some("d")),
			None,
		);
		assert_eq!(pattern_drive_alias_root_impl(true, "", Some("mnt"), Some("data")), None);
	}

	#[test]
	fn non_drive_absolute_paths_are_left_native() {
		assert_eq!(translate_unix_drive_path(Path::new("/")).as_deref(), None);
		assert_eq!(translate_unix_drive_path(Path::new("/dev/null")).as_deref(), None);
		assert_eq!(translate_unix_drive_path(Path::new("/mnt/data")).as_deref(), None);
		assert_eq!(translate_unix_drive_path(Path::new("relative/path")).as_deref(), None);
		assert_eq!(translate_unix_drive_path(Path::new("\\d\\logs")).as_deref(), None);
		assert_eq!(translate_unix_drive_path(Path::new("\\mnt\\d\\logs")).as_deref(), None);
	}
}
