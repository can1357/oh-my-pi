//! Filesystem utilities

use std::{
	borrow::Cow,
	path::{Path, PathBuf},
};
#[cfg(windows)]
use std::env;
#[cfg(any(windows, test))]
use std::{ffi::OsStr, path::Component};

#[cfg(windows)]
use std::os::windows::ffi::{OsStrExt, OsStringExt};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{GetLongPathNameW, GetShortPathNameW};

/// Normalizes shell-facing path aliases before `std::fs` sees them.
#[allow(clippy::missing_const_for_fn, reason = "Windows implementation allocates")]
pub fn normalize_shell_path(path: &Path) -> Cow<'_, Path> {
	#[cfg(windows)]
	{
		translate_unix_drive_path(path)
			.or_else(|| translate_unix_tmp_path(path, env::temp_dir))
			.map_or(Cow::Borrowed(path), Cow::Owned)
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
	query_path_name(path, GetLongPathNameW)
}

/// Non-Windows: no 8.3 short names, return unchanged.
#[cfg(not(windows))]
pub fn expand_to_long_path(path: &Path) -> PathBuf {
	path.to_path_buf()
}

/// Return the existing Windows 8.3 spelling without resolving symlinks or junctions.
/// If no short spelling is available, preserve the input.
#[cfg(windows)]
pub fn get_short_path(path: &Path) -> PathBuf {
	query_path_name(path, GetShortPathNameW)
}

/// Non-Windows: preserve the input path.
#[cfg(not(windows))]
pub fn get_short_path(path: &Path) -> PathBuf {
	path.to_path_buf()
}

/// Both Win32 name queries preserve symlinks and junctions, unlike canonicalize.
#[cfg(windows)]
fn query_path_name(
	path: &Path,
	query: unsafe extern "system" fn(*const u16, *mut u16, u32) -> u32,
) -> PathBuf {
	// Encode straight from the wide form: Windows `OsStr` is UTF-16 and may
	// not round-trip through UTF-8, so a `to_str()` detour would silently skip
	// expansion for those paths — exactly the identity split this function
	// exists to avoid.
	let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();

	// First call with a null buffer returns the required size (including the
	// terminating NUL); the fill call returns the length excluding the NUL.
	// Both APIs return 0 on failure (e.g. nonexistent path), in which case
	// the input is returned unchanged.
	let needed = unsafe { query(wide.as_ptr(), std::ptr::null_mut(), 0) };
	if needed == 0 {
		return path.to_path_buf();
	}
	let mut buf = vec![0u16; needed as usize];
	loop {
		let written = unsafe { query(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
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
		// The result grew between the sizing call and the fill call:
		// `written` is the new required size (including the NUL). Grow and
		// retry rather than returning partial/zero-padded garbage.
		buf.resize(written, 0);
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
		pattern_drive_alias_root_impl(starts_with_forward_slash, first, second, third, env::temp_dir)
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
	temp_dir: impl FnOnce() -> PathBuf,
) -> Option<(PathBuf, usize)> {
	if !starts_with_forward_slash || !first.is_empty() {
		return None;
	}

	// A bare `/tmp` glob root maps to the system temp dir, matching the
	// non-pattern rewrite in `normalize_shell_path`.
	if second == Some("tmp") {
		return Some((temp_dir(), 2));
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

/// Maps the POSIX `/tmp` tree onto the Windows system temporary directory.
///
/// A bare `/tmp` under Win32 is drive-relative (`<cwd-drive>:\tmp`), not a
/// scratch root; MSYS/Cygwin tools instead mount it at `%TEMP%`. Rewriting it
/// here — the single boundary every shell path passes through — keeps the
/// in-process builtins, `ls`, and redirections agreeing with those external
/// tools instead of scattering files across a drive-root `tmp`.
///
/// `.`/`..` are collapsed against the logical POSIX path first, clamping at the
/// root, so `/tmp/../tmp/f` resolves like `/tmp/f` instead of appending the raw
/// remainder onto the nested `%TEMP%` (which would escape into a sibling dir).
/// A `..` that climbs out of `/tmp` yields a non-`/tmp` path, i.e. no rewrite.
#[cfg(any(windows, test))]
fn translate_unix_tmp_path(path: &Path, temp_dir: impl FnOnce() -> PathBuf) -> Option<PathBuf> {
	let mut components = path.components();
	if components.next() != Some(Component::RootDir) {
		return None;
	}

	let mut logical: Vec<&OsStr> = Vec::new();
	for component in components {
		match component {
			Component::CurDir => {}
			Component::ParentDir => {
				logical.pop();
			},
			Component::Normal(part) => logical.push(part),
			// A second root or a drive prefix cannot appear in a POSIX operand.
			Component::RootDir | Component::Prefix(_) => return None,
		}
	}

	let mut tail = logical.into_iter();
	if tail.next() != Some(OsStr::new("tmp")) {
		return None;
	}

	let mut native = temp_dir();
	native.extend(tail);
	Some(native)
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

/// A handle on a directory, as a process holds the one it works in: the
/// shell keeps one so that a name read from a directory that has been
/// removed, renamed or moved reaches what the kernel reaches, which no name
/// of that directory can. A system that gives no such handle (Windows, and
/// the stubs) never makes one, and the shell reads names as it spells them.
#[derive(Debug)]
pub struct DirHandle {
	#[cfg(unix)]
	fd: std::os::fd::OwnedFd,
}

impl DirHandle {
	/// Opens `path` as a handle, if this system gives one and `path` can be
	/// opened; `None` otherwise. A directory it opens that the user may not
	/// search is an error: `chdir` would refuse it, and the shell enters only
	/// what the kernel would let it work in. It is asked of the directory
	/// opened, not of the name, which may reach another one by then.
	#[cfg(unix)]
	pub fn open(path: &Path) -> std::io::Result<Option<Self>> {
		use std::os::fd::{FromRawFd, OwnedFd};
		let Ok(name) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else { return Ok(None) };
		// SAFETY: `name` is a C string that lives across the call, and the
		// descriptor it answers with is owned by the `OwnedFd` made of it.
		let fd = unsafe { libc::open(name.as_ptr(), Self::FLAGS) };
		if fd < 0 {
			return Ok(None);
		}
		// SAFETY: `open` made `fd`, which nothing else owns.
		let opened = Self { fd: unsafe { OwnedFd::from_raw_fd(fd) } };
		opened.searchable()?;
		Ok(Some(opened))
	}

	/// Opens `path` as a handle, if this system gives one.
	#[cfg(not(unix))]
	pub fn open(path: &Path) -> std::io::Result<Option<Self>> {
		let _ = path;
		Ok(None)
	}

	/// Whether the user may search this directory, as `chdir` asks.
	#[cfg(unix)]
	fn searchable(&self) -> std::io::Result<()> {
		use std::os::fd::AsRawFd;
		// SAFETY: this handle is open for the whole call and the name is a C
		// string literal.
		let answered = unsafe { libc::faccessat(self.fd.as_raw_fd(), c".".as_ptr(), libc::X_OK, libc::AT_EACCESS) };
		if answered < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
	}

	/// Opens `name`, read from this directory, as a handle of its own, as
	/// `chdir` reads it from the directory a process holds.
	#[cfg(unix)]
	pub fn open_at(&self, name: &Path) -> std::io::Result<Self> {
		use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
		let name = std::ffi::CString::new(name.as_os_str().as_encoded_bytes())
			.map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
		// SAFETY: this handle is open for the whole call, `name` is a C
		// string that lives across it, and the descriptor it answers with is
		// owned by the `OwnedFd` made of it.
		let fd = unsafe { libc::openat(self.fd.as_raw_fd(), name.as_ptr(), Self::FLAGS) };
		if fd < 0 {
			return Err(std::io::Error::last_os_error());
		}
		// SAFETY: `openat` made `fd`, which nothing else owns.
		let opened = Self { fd: unsafe { OwnedFd::from_raw_fd(fd) } };
		// A directory the user may not search is one `chdir` refuses, which
		// `O_PATH` does not: the directory opened is asked about once it is
		// known to be one, so that a file is still not a directory.
		opened.searchable()?;
		Ok(opened)
	}

	/// Opens `name`, read from this directory, as a handle of its own.
	#[cfg(not(unix))]
	pub fn open_at(&self, name: &Path) -> std::io::Result<Self> {
		let _ = name;
		Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
	}

	/// The name this directory has now, as the kernel knows it. `None` where
	/// it has been removed, which `getcwd` reports as a failure, or where
	/// this system does not say.
	#[cfg(target_os = "linux")]
	pub fn path(&self) -> Option<PathBuf> {
		use std::os::{fd::AsRawFd, linux::fs::MetadataExt};
		let name = std::fs::read_link(format!("/proc/self/fd/{}", self.fd.as_raw_fd())).ok()?;
		// `/proc` names a directory that has been removed with a ` (deleted)`
		// suffix, which a directory may also be named: the name is kept only
		// when it still reaches this very directory.
		let named = std::fs::metadata(&name).ok()?;
		// SAFETY: this handle is open for the whole call, and the buffer is
		// written by the kernel and read only where it answers that it did.
		let mut held = std::mem::MaybeUninit::<libc::stat>::uninit();
		let answered = unsafe { libc::fstat(self.fd.as_raw_fd(), held.as_mut_ptr()) };
		if answered < 0 {
			return None;
		}
		// SAFETY: `fstat` answered that it wrote the whole structure.
		let held = unsafe { held.assume_init() };
		(named.st_dev() == held.st_dev && named.st_ino() == held.st_ino).then_some(name)
	}

	/// The name this directory has now, as the kernel knows it.
	#[cfg(target_os = "macos")]
	pub fn path(&self) -> Option<PathBuf> {
		use std::os::{fd::AsRawFd, unix::ffi::OsStringExt};
		let mut buffer = [0u8; libc::PATH_MAX as usize];
		// SAFETY: this handle is open for the whole call, and the buffer
		// takes the `PATH_MAX` bytes `F_GETPATH` writes.
		let answered = unsafe {
			libc::fcntl(self.fd.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr().cast::<i8>())
		};
		if answered < 0 {
			return None;
		}
		let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
		let name = PathBuf::from(std::ffi::OsString::from_vec(buffer[..end].to_vec()));
		// A directory that has been removed keeps the name it had, which
		// reaches nothing: the shell reports that as `getcwd` does.
		std::fs::metadata(&name).is_ok().then_some(name)
	}

	/// The name this directory has now, as the kernel knows it.
	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	pub fn path(&self) -> Option<PathBuf> {
		None
	}

	/// What the handle is opened with: the directory itself and not the
	/// reading of it, which a directory the user may not search still gives.
	#[cfg(target_os = "linux")]
	const FLAGS: i32 = libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC;
	/// What the handle is opened with.
	#[cfg(all(unix, not(target_os = "linux")))]
	const FLAGS: i32 = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
}

pub use super::platform::fs::*;

#[cfg(test)]
mod tests {
	use super::*;
	#[cfg(windows)]
	use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

	/// A directory the user may not search is refused as `chdir` refuses it,
	/// whether it is opened by name or read from a directory held, so that
	/// the shell never holds one it could not work in.
	#[cfg(unix)]
	#[test]
	fn an_unsearchable_directory_is_not_held() {
		use std::os::unix::fs::PermissionsExt as _;
		// SAFETY: `geteuid` has no preconditions.
		if unsafe { libc::geteuid() } == 0 {
			return;
		}
		let dir = tempfile::tempdir().expect("scratch directory");
		let locked = dir.path().join("locked");
		std::fs::create_dir(&locked).expect("directory");
		std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).expect("mode");
		let by_name = DirHandle::open(&locked).map(|handle| handle.is_some());
		let parent = DirHandle::open(dir.path()).expect("searchable").expect("held");
		let read = parent.open_at(Path::new("locked")).map(|_| ());
		std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).expect("mode");
		assert_eq!(by_name.map_err(|error| error.kind()), Err(std::io::ErrorKind::PermissionDenied));
		assert_eq!(read.map_err(|error| error.kind()), Err(std::io::ErrorKind::PermissionDenied));
	}

	/// A short-spelled path expands back to the long spelling of the same
	/// directory. Uses a fresh long-named directory so the input really has a
	/// distinct 8.3 alias; skips on volumes that do not generate short names.
	#[cfg(windows)]
	#[test]
	fn expand_to_long_path_resolves_short_names() {
		const LONG_NAME: &str = "brush-core-long-name-probe";
		let root = tempfile::tempdir().expect("tempdir");
		let long = root.path().join(LONG_NAME);
		std::fs::create_dir(&long).expect("create long-named dir");

		let wide: Vec<u16> = long.as_os_str().encode_wide().chain(Some(0)).collect();
		let needed = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
		assert!(needed > 0, "GetShortPathNameW failed for {}", long.display());
		let mut buf = vec![0u16; needed as usize];
		let written = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
		assert!(written > 0, "GetShortPathNameW fill failed for {}", long.display());
		buf.truncate(written as usize);
		let short = PathBuf::from(std::ffi::OsString::from_wide(&buf));
		if short.file_name() == long.file_name() {
			return;
		}

		let expanded = expand_to_long_path(&short);
		assert_eq!(expanded.file_name(), Some(OsStr::new(LONG_NAME)), "from {}", short.display());
		// Same result as expanding the long spelling: one identity, no `\\?\`
		// prefix, no symlink resolution.
		assert_eq!(expanded, expand_to_long_path(&long));
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
	fn unix_tmp_alias_maps_onto_system_temp_dir() {
		let temp = PathBuf::from(r"C:\Users\Adam\AppData\Local\Temp");
		assert_eq!(
			translate_unix_tmp_path(Path::new("/tmp"), || temp.clone()).as_deref(),
			Some(temp.as_path()),
		);
		assert_eq!(
			translate_unix_tmp_path(Path::new("/tmp/probe/sub"), || temp.clone()).as_deref(),
			Some(temp.join("probe").join("sub").as_path()),
		);
		// Only the `/tmp` component aliases; `/tmpfile` and `/var/tmp` do not.
		assert_eq!(translate_unix_tmp_path(Path::new("/tmpfile"), || temp.clone()), None);
		assert_eq!(translate_unix_tmp_path(Path::new("/var/tmp"), || temp.clone()), None);
		// `.`/`..` collapse against the logical root before substitution.
		assert_eq!(
			translate_unix_tmp_path(Path::new("/tmp/../tmp/f"), || temp.clone()).as_deref(),
			Some(temp.join("f").as_path()),
		);
		assert_eq!(
			translate_unix_tmp_path(Path::new("/tmp/probe/../sub"), || temp.clone()).as_deref(),
			Some(temp.join("sub").as_path()),
		);
		// A `..` that climbs out of `/tmp` is no longer a tmp path.
		assert_eq!(translate_unix_tmp_path(Path::new("/tmp/.."), || temp.clone()), None);
		assert_eq!(translate_unix_tmp_path(Path::new("/tmp/../var/f"), || temp.clone()), None);
	}

	#[test]
	fn pattern_drive_alias_roots_report_consumed_components() {
		assert_eq!(
			pattern_drive_alias_root_impl(true, "", Some("d"), Some("project"), || PathBuf::from(r"C:\Temp")),
			Some((PathBuf::from("D:/"), 2)),
		);
		assert_eq!(
			pattern_drive_alias_root_impl(true, "", Some("mnt"), Some("d"), || PathBuf::from(r"C:\Temp")),
			Some((PathBuf::from("D:/"), 3)),
		);
	}

	#[test]
	fn pattern_drive_alias_roots_require_forward_slash_prefix() {
		let tmp = || PathBuf::from(r"C:\Temp");
		assert_eq!(pattern_drive_alias_root_impl(false, "", Some("d"), Some("logs"), tmp), None);
		assert_eq!(
			pattern_drive_alias_root_impl(false, "", Some("mnt"), Some("d"), || PathBuf::from(r"C:\Temp")),
			None,
		);
		assert_eq!(
			pattern_drive_alias_root_impl(true, "", Some("mnt"), Some("data"), || PathBuf::from(r"C:\Temp")),
			None,
		);
	}

	#[test]
	fn pattern_tmp_root_maps_to_system_temp() {
		let temp = PathBuf::from(r"C:\Users\Adam\AppData\Local\Temp");
		assert_eq!(
			pattern_drive_alias_root_impl(true, "", Some("tmp"), Some("a"), || temp.clone()),
			Some((temp.clone(), 2)),
		);
		// `/tmpfile` is not the tmp alias; it falls through to plain root handling.
		assert_eq!(
			pattern_drive_alias_root_impl(true, "", Some("tmpfile"), None, || temp.clone()),
			None,
		);
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
