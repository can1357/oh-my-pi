//! Filesystem utilities for Windows.

use std::{
	ffi::OsStr,
	path::{Path, PathBuf},
	sync::LazyLock,
};
use std::os::windows::{
	fs::OpenOptionsExt,
	io::AsRawHandle,
};

use crate::error;
// Selectively re-export items from stubs that we don't override.
pub(crate) use crate::sys::stubs::fs::MetadataExt;
use windows_sys::Win32::{
	Foundation::HANDLE,
	Storage::FileSystem::{
		BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, GetFileInformationByHandle,
	},
};

/// Cached list of executable extensions from the `PATHEXT` environment
/// variable. Each entry retains its leading dot (e.g. `".exe"`) and is stored
/// lowercased so case-insensitive comparisons can be done without allocating.
///
/// NOTE: This is cached for the process lifetime. Changes to `PATHEXT` made
/// inside the running shell are not reflected here. Bash itself has no
/// `PATHEXT` semantics, so this is generally acceptable for now.
static PATHEXT_EXTENSIONS: LazyLock<Vec<String>> = LazyLock::new(|| {
	let fallback = || {
		[".com", ".exe", ".bat", ".cmd"]
			.into_iter()
			.map(|ext| ext.to_string())
			.collect::<Vec<_>>()
	};

	let Some(value) = std::env::var_os("PATHEXT") else {
		return fallback();
	};

	let extensions = value
		.to_string_lossy()
		.split(';')
		.filter_map(|entry| {
			let entry = entry.trim();
			if entry.is_empty() {
				None
			} else if entry.starts_with('.') {
				Some(entry.to_ascii_lowercase())
			} else {
				Some(format!(".{}", entry.to_ascii_lowercase()))
			}
		})
		.collect::<Vec<_>>();

	if extensions.is_empty() {
		fallback()
	} else {
		extensions
	}
});

/// Returns the stem of a PATHEXT entry (with any leading `.` removed).
///
/// `PATHEXT` canonically stores entries like `.EXE`, but tolerant parsing
/// accepts entries without the leading dot too.
fn pathext_entry_stem(entry: &str) -> &str {
	entry.strip_prefix('.').unwrap_or(entry)
}

/// Returns true if the path's extension is in the PATHEXT list.
///
/// Performs case-insensitive comparison against the cached PATHEXT entries
/// without allocating.
fn has_executable_extension(path: &Path) -> bool {
	path.extension().is_some_and(|ext| {
		PATHEXT_EXTENSIONS
			.iter()
			.any(|e| ext.eq_ignore_ascii_case(pathext_entry_stem(e)))
	})
}

/// Returns true if `path` is, by itself, an existing executable file.
///
/// Used both for the initial check in [`resolve_executable`] and for
/// [`PathExt::executable`].
fn is_executable_file(path: &Path) -> bool {
	has_executable_extension(path) && path.is_file()
}

/// Resolves an owned path to the actual on-disk executable file, if any.
///
/// If the path is already a file with a `PATHEXT` extension, it is returned
/// unchanged (no allocation). Otherwise, each `PATHEXT` extension is appended
/// in turn and the first existing file is returned.
pub fn resolve_executable(path: PathBuf) -> Option<PathBuf> {
	if is_executable_file(&path) {
		return Some(path);
	}
	// Try appending each PATHEXT extension.
	for ext in PATHEXT_EXTENSIONS.iter() {
		let mut name = path.as_os_str().to_owned();
		name.push(ext);
		let candidate = PathBuf::from(name);
		if candidate.is_file() {
			return Some(candidate);
		}
	}
	None
}

impl crate::sys::fs::PathExt for Path {
	fn readable(&self) -> bool {
		std::fs::OpenOptions::new().read(true).open(self).is_ok()
	}

	fn writable(&self) -> bool {
		std::fs::OpenOptions::new().write(true).open(self).is_ok()
	}

	fn executable(&self) -> bool {
		if is_executable_file(self) {
			return true;
		}
		// Try each PATHEXT extension without allocating a separate PathBuf
		// per candidate until one exists.
		PATHEXT_EXTENSIONS.iter().any(|ext| {
			let mut name = self.as_os_str().to_owned();
			name.push(ext);
			Self::new(&name).is_file()
		})
	}

	fn exists_and_is_block_device(&self) -> bool {
		false
	}

	fn exists_and_is_char_device(&self) -> bool {
		false
	}

	fn exists_and_is_fifo(&self) -> bool {
		false
	}

	fn exists_and_is_socket(&self) -> bool {
		false
	}

	fn exists_and_is_setgid(&self) -> bool {
		false
	}

	fn exists_and_is_setuid(&self) -> bool {
		false
	}

	fn exists_and_is_sticky_bit(&self) -> bool {
		false
	}

	fn get_device_and_inode(&self) -> Result<(u64, u64), crate::error::Error> {
		let file = std::fs::OpenOptions::new()
			.access_mode(0)
			.custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
			.open(self)?;
		let mut info = BY_HANDLE_FILE_INFORMATION {
			// SAFETY: `BY_HANDLE_FILE_INFORMATION` is a plain C output buffer for
			// `GetFileInformationByHandle`; all fields are overwritten before any
			// successful read from the structure below.
			..unsafe { std::mem::zeroed() }
		};

		let succeeded = {
			// SAFETY: `file.as_raw_handle()` is a live file handle owned by `file`
			// for the duration of the call, and `info` points to initialized writable
			// storage for the API's output structure.
			(unsafe {
				GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut info)
			}) != 0
		};
		if !succeeded {
			return Err(std::io::Error::last_os_error().into());
		}

		let file_index = (u64::from(info.nFileIndexHigh) << 32)
			| u64::from(info.nFileIndexLow);
		Ok((u64::from(info.dwVolumeSerialNumber), file_index))
	}
}

/// Splits a platform-specific PATH-like value into individual paths.
///
/// On Windows, entries are parsed with [`std::env::split_paths`] and then have
/// surrounding double quotes removed. Quoted PATH entries are common on Windows
/// and must resolve to the unquoted directory when searching for executables.
pub fn split_paths<T: AsRef<OsStr> + ?Sized>(
	s: &T,
) -> impl Iterator<Item = PathBuf> + '_ {
	std::env::split_paths(s).map(trim_surrounding_path_quotes)
}

fn trim_surrounding_path_quotes(path: PathBuf) -> PathBuf {
	PathBuf::from(path.to_string_lossy().trim_matches('"').to_string())
}

/// Opens a null file that will discard all I/O.
pub fn open_null_file() -> Result<std::fs::File, error::Error> {
	let f = std::fs::File::options()
		.read(true)
		.write(true)
		.open("NUL")?;
	Ok(f)
}

/// Gives the platform an opportunity to handle a special file path (e.g.
/// `/dev/null`).
pub fn try_open_special_file(path: &Path) -> Option<Result<std::fs::File, std::io::Error>> {
	if path.ends_with("dev/null") && path.is_absolute() {
		Some(open_null_file().map_err(std::io::Error::other))
	} else {
		None
	}
}

/// Returns the default paths where executables are typically found on Windows.
pub(crate) fn get_default_executable_search_paths() -> Vec<PathBuf> {
	default_system_paths()
}

/// Returns the default paths where standard system utilities are found on
/// Windows.
pub fn get_default_standard_utils_paths() -> Vec<PathBuf> {
	default_system_paths()
}

fn default_system_paths() -> Vec<PathBuf> {
	let mut paths = Vec::new();
	if let Some(system32) = system32_path() {
		paths.push(system32.clone());
		if let Some(system_root) = system32.parent() {
			paths.push(system_root.to_path_buf());
		}
		paths.push(system32.join("Wbem"));
		paths.push(system32.join("WindowsPowerShell").join("v1.0"));
	}
	if paths.is_empty()
		&& let Some(env_path) = std::env::var_os("PATH")
	{
		paths.extend(std::env::split_paths(&env_path));
	}
	if let Ok(userprofile) = std::env::var("USERPROFILE") {
		paths.push(
			PathBuf::from(userprofile)
				.join("AppData")
				.join("Local")
				.join("Microsoft")
				.join("WindowsApps"),
		);
	}
	paths
}

fn system32_path() -> Option<PathBuf> {
	let system_root = std::env::var_os("SystemRoot")?;
	Some(PathBuf::from(system_root).join("System32"))
}

/// Returns the path to the system-wide shell profile script.
///
/// On Windows, no system profile is loaded by default.
pub const fn get_system_profile_path() -> Option<&'static Path> {
	None
}

/// Returns the path to the system-wide shell rc script.
///
/// On Windows, no system rc file is loaded by default.
pub const fn get_system_rc_path() -> Option<&'static Path> {
	None
}

/// Returns the platform default for case-insensitive pathname expansion.
///
/// On Windows, filesystems are typically case-insensitive, so this returns
/// `true`.
pub const fn default_case_insensitive_path_expansion() -> bool {
	true
}

/// Path separator characters on Windows.
const PATH_SEPARATORS: [char; 2] = ['/', '\\'];

/// Returns true if the string contains a path separator character.
///
/// On Windows, both `/` and `\` are considered path separators.
pub fn contains_path_separator(s: &str) -> bool {
	s.contains(PATH_SEPARATORS)
}

/// Returns true if the string ends with a path separator character.
///
/// On Windows, both `/` and `\` are considered path separators.
pub fn ends_with_path_separator(s: &str) -> bool {
	s.ends_with(PATH_SEPARATORS)
}

/// Returns the string with a trailing path separator removed, if present.
///
/// On Windows, both `/` and `\` are considered path separators.
pub fn strip_path_separator_suffix(s: &str) -> &str {
	s.strip_suffix(PATH_SEPARATORS).unwrap_or(s)
}

/// Finds the byte index of the last path separator in the string.
///
/// On Windows, both `/` and `\` are considered path separators.
pub fn rfind_path_separator(s: &str) -> Option<usize> {
	s.rfind(PATH_SEPARATORS)
}

/// Splits a string on path separator characters, returning an iterator of
/// components.
///
/// On Windows, both `/` and `\` are used as separators.
pub fn split_path_for_pattern(s: &str) -> impl Iterator<Item = &str> {
	s.split(PATH_SEPARATORS)
}

/// Returns the root path for an absolute pattern, if the first component
/// indicates one.
///
/// On Windows, recognizes both a leading separator (empty first component from
/// splitting a path like `/foo`) and a drive-letter prefix like `C:` as
/// absolute.
///
/// TODO(windows): UNC paths like `\\server\share\foo` are not yet handled
/// specially; they split into `["", "", "server", "share", "foo"]`, and the
/// leading empty component causes them to be treated as if they were rooted
/// at `/`, which drops the server/share portion. Supporting UNC requires
/// peeking further into the component list.
pub fn pattern_path_root(first_component: &str) -> Option<PathBuf> {
	if first_component.is_empty() {
		// Leading separator, e.g. `/foo` split into ["", "foo"].
		Some(PathBuf::from("/"))
	} else if first_component.len() == 2
		&& first_component.as_bytes()[0].is_ascii_alphabetic()
		&& first_component.as_bytes()[1] == b':'
	{
		// Drive letter prefix, e.g. `c:/foo` split into ["c:", "foo"].
		let mut root = String::with_capacity(3);
		root.push_str(first_component);
		root.push('/');
		Some(PathBuf::from(root))
	} else {
		None
	}
}

/// Pushes a component onto a path for pattern expansion.
///
/// On Windows, `PathBuf::push` has special drive-letter and root-replacement
/// semantics that conflict with shell path construction (e.g. pushing `C:foo`
/// onto `D:\bar` replaces the whole path). This function always appends the
/// component as a child, operating on the underlying `OsString` so non-UTF-8
/// content in the path is preserved and no reallocation is needed.
pub fn push_path_for_pattern(path: &mut PathBuf, component: &str) {
	// Separator characters are ASCII, and WTF-8-encoded OsStr bytes are a
	// superset of UTF-8, so checking the last byte directly is safe.
	let bytes = path.as_os_str().as_encoded_bytes();
	let needs_sep = !bytes.is_empty() && !matches!(bytes.last(), Some(b'/' | b'\\'));

	let buf = path.as_mut_os_string();
	if needs_sep {
		buf.push("/");
	}
	buf.push(component);
}

/// Normalizes path separators for shell output.
///
/// On Windows, replaces `\` with `/` since backslash is the shell escape
/// character.
pub fn normalize_path_separators(s: &str) -> std::borrow::Cow<'_, str> {
	if s.contains('\\') {
		std::borrow::Cow::Owned(s.replace('\\', "/"))
	} else {
		std::borrow::Cow::Borrowed(s)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn trim_surrounding_path_quotes_removes_quoted_windows_path() {
		assert_eq!(
			trim_surrounding_path_quotes(PathBuf::from(r#""C:\Program Files\Brush""#)),
			PathBuf::from(r"C:\Program Files\Brush"),
		);
		assert_eq!(
			trim_surrounding_path_quotes(PathBuf::from(r"C:\Windows\System32")),
			PathBuf::from(r"C:\Windows\System32"),
		);
	}

	#[test]
	fn path_separator_helpers_both_slashes() {
		assert!(contains_path_separator("foo/bar"));
		assert!(contains_path_separator(r"foo\bar"));
		assert!(contains_path_separator(r"mixed/and\back"));
		assert!(!contains_path_separator("foobar"));

		assert!(ends_with_path_separator("foo/"));
		assert!(ends_with_path_separator(r"foo\"));
		assert!(!ends_with_path_separator("foo"));

		assert_eq!(strip_path_separator_suffix("foo/"), "foo");
		assert_eq!(strip_path_separator_suffix(r"foo\"), "foo");
		assert_eq!(strip_path_separator_suffix("foo"), "foo");

		assert_eq!(rfind_path_separator("a/b/c"), Some(3));
		assert_eq!(rfind_path_separator(r"a\b\c"), Some(3));
		assert_eq!(rfind_path_separator(r"a/b\c"), Some(3));
		assert_eq!(rfind_path_separator("abc"), None);
	}

	#[test]
	fn split_path_for_pattern_both_slashes() {
		let parts: Vec<_> = split_path_for_pattern("a/b/c").collect();
		assert_eq!(parts, vec!["a", "b", "c"]);

		let parts: Vec<_> = split_path_for_pattern(r"a\b\c").collect();
		assert_eq!(parts, vec!["a", "b", "c"]);

		let parts: Vec<_> = split_path_for_pattern(r"a/b\c").collect();
		assert_eq!(parts, vec!["a", "b", "c"]);

		let parts: Vec<_> = split_path_for_pattern("/a/b").collect();
		assert_eq!(parts, vec!["", "a", "b"]);
	}

	#[test]
	fn pattern_path_root_leading_separator() {
		assert_eq!(pattern_path_root(""), Some(PathBuf::from("/")));
	}

	#[test]
	fn pattern_path_root_drive_letters() {
		assert_eq!(pattern_path_root("c:"), Some(PathBuf::from("c:/")));
		assert_eq!(pattern_path_root("C:"), Some(PathBuf::from("C:/")));
		assert_eq!(pattern_path_root("Z:"), Some(PathBuf::from("Z:/")));
	}

	#[test]
	fn pattern_path_root_rejects_non_drive_two_char_prefix() {
		// "1:" is not a valid drive letter — must be alphabetic.
		assert_eq!(pattern_path_root("1:"), None);
		// Longer drive-like strings are not treated as roots.
		assert_eq!(pattern_path_root("cd"), None);
		assert_eq!(pattern_path_root("c:\\"), None);
		assert_eq!(pattern_path_root("foo"), None);
	}

	#[test]
	fn push_path_for_pattern_appends_with_forward_slash() {
		let mut p = PathBuf::from(r"C:\Users\reuben");
		push_path_for_pattern(&mut p, "foo");
		// Forward slash is used as the appended separator, yielding mixed
		// separators — acceptable because `normalize_path_separators` is
		// applied downstream before display.
		assert_eq!(p, PathBuf::from(r"C:\Users\reuben/foo"));
	}

	#[test]
	fn push_path_for_pattern_no_double_separator() {
		let mut p = PathBuf::from("C:/Users/reuben/");
		push_path_for_pattern(&mut p, "foo");
		assert_eq!(p, PathBuf::from("C:/Users/reuben/foo"));

		let mut p = PathBuf::from(r"C:\Users\reuben\");
		push_path_for_pattern(&mut p, "foo");
		assert_eq!(p, PathBuf::from(r"C:\Users\reuben\foo"));
	}

	#[test]
	fn push_path_for_pattern_onto_drive_root() {
		let mut p = PathBuf::from("c:/");
		push_path_for_pattern(&mut p, "foo");
		assert_eq!(p, PathBuf::from("c:/foo"));
	}

	#[test]
	fn push_path_for_pattern_onto_empty() {
		let mut p = PathBuf::new();
		push_path_for_pattern(&mut p, "foo");
		// Empty path stays un-prefixed — we only add a separator between
		// existing content and the new component.
		assert_eq!(p, PathBuf::from("foo"));
	}

	#[test]
	fn normalize_path_separators_converts_backslashes() {
		use std::borrow::Cow;
		// Already-forward-slashed input is borrowed (no allocation).
		assert!(matches!(normalize_path_separators("c:/foo/bar"), Cow::Borrowed("c:/foo/bar")));
		// Mixed or backslashed input becomes owned and fully forward-slashed.
		let normalized = normalize_path_separators(r"c:\foo\bar");
		assert_eq!(normalized.as_ref(), "c:/foo/bar");
		let normalized = normalize_path_separators(r"c:\foo/bar");
		assert_eq!(normalized.as_ref(), "c:/foo/bar");
	}

	#[test]
	fn default_case_insensitive_is_true() {
		assert!(default_case_insensitive_path_expansion());
	}

	#[test]
	fn has_executable_extension_is_case_insensitive() {
		// Force the PATHEXT cache for this test's defaults.
		assert!(has_executable_extension(Path::new("foo.exe")));
		assert!(has_executable_extension(Path::new("foo.EXE")));
		assert!(has_executable_extension(Path::new("foo.Cmd")));
		assert!(!has_executable_extension(Path::new("foo.txt")));
		assert!(!has_executable_extension(Path::new("foo")));
	}

	#[test]
	fn pathext_entry_stem_strips_dot() {
		assert_eq!(pathext_entry_stem(".exe"), "exe");
		assert_eq!(pathext_entry_stem(".cmd"), "cmd");
		// Tolerant: entries without a leading dot are returned as-is.
		assert_eq!(pathext_entry_stem("exe"), "exe");
		assert_eq!(pathext_entry_stem(""), "");
	}

	#[test]
	fn resolve_executable_for_nonexistent_returns_none() {
		// A path that cannot exist on any test host.
		let path = PathBuf::from(r"C:\__brush_test_definitely_missing__");
		assert!(resolve_executable(path).is_none());
	}
}
