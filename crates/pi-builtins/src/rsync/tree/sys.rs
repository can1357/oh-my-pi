//! Thin, allocation-light wrappers over the `*at()` syscalls the confined tree
//! layer needs. Every function takes a directory (`None` = the process cwd)
//! plus a single name, retries `EINTR`, and reports failures as raw OS errors
//! so callers can print upstream's `strerror (errno)` text.

use std::{
	ffi::{CStr, CString, OsString},
	io,
	os::{
		fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd},
		unix::ffi::OsStringExt,
	},
	time::UNIX_EPOCH,
};

use pi_vfs::{FileTime, FileType, Metadata, Permissions};

use crate::rsync::time::{split_time, system_time};

/// Flags for a directory fd used only as `*at()` authority or for traversal:
/// no read permission is needed on Linux (`O_PATH`) or macOS (`O_SEARCH`).
#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) const TRAVERSE: libc::c_int = libc::O_PATH | libc::O_DIRECTORY;
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) const TRAVERSE: libc::c_int = libc::O_SEARCH;
#[cfg(not(any(
	target_os = "linux",
	target_os = "android",
	target_os = "macos",
	target_os = "ios"
)))]
pub(crate) const TRAVERSE: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY;

/// A raw OS error.
pub(crate) fn errno(code: i32) -> io::Error {
	io::Error::from_raw_os_error(code)
}

/// Whether `code` is how `O_NOFOLLOW` reports that it hit a symlink
/// (ELOOP on Linux/macOS, EMLINK on FreeBSD, EFTYPE on NetBSD/OpenBSD).
pub(crate) fn nofollow_hit(code: i32) -> bool {
	#[cfg(any(target_os = "freebsd", target_os = "dragonfly"))]
	if code == libc::EMLINK {
		return true;
	}
	#[cfg(any(target_os = "netbsd", target_os = "openbsd"))]
	if code == libc::EFTYPE {
		return true;
	}
	code == libc::ELOOP
}

/// NUL-terminated copy of one name; an interior NUL is `EINVAL`.
pub(crate) fn cstr(bytes: &[u8]) -> io::Result<CString> {
	CString::new(bytes).map_err(|_| errno(libc::EINVAL))
}

fn dirfd(dir: Option<BorrowedFd<'_>>) -> RawFd {
	dir.map_or(libc::AT_FDCWD, |fd| fd.as_raw_fd())
}

/// Runs `f` until it stops failing with `EINTR`.
fn retry<T: Copy + PartialEq + From<i8>>(mut f: impl FnMut() -> T) -> io::Result<T> {
	loop {
		let ret = f();
		if ret != T::from(-1) {
			return Ok(ret);
		}
		let err = io::Error::last_os_error();
		if err.raw_os_error() != Some(libc::EINTR) {
			return Err(err);
		}
	}
}

fn check(ret: io::Result<libc::c_int>) -> io::Result<()> {
	ret.map(|_| ())
}

/// `openat(dir, name, flags | O_CLOEXEC, mode)`.
pub(crate) fn openat(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	flags: libc::c_int,
	mode: u32,
) -> io::Result<OwnedFd> {
	let fd = retry(|| {
		// SAFETY: `name` is a valid NUL-terminated string and the dirfd is
		// either AT_FDCWD or a live borrowed descriptor.
		unsafe {
			libc::openat(dirfd(dir), name.as_ptr(), flags | libc::O_CLOEXEC, mode as libc::c_uint)
		}
	})?;
	// SAFETY: openat returned a fresh descriptor that nothing else owns.
	Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// `fstatat(dir, name, nofollow ? AT_SYMLINK_NOFOLLOW : 0)`.
pub(crate) fn fstatat(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	nofollow: bool,
) -> io::Result<libc::stat> {
	let flags = if nofollow { libc::AT_SYMLINK_NOFOLLOW } else { 0 };
	let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
	retry(|| {
		// SAFETY: `st` points to writable storage for one `stat`.
		unsafe { libc::fstatat(dirfd(dir), name.as_ptr(), st.as_mut_ptr(), flags) }
	})?;
	// SAFETY: fstatat succeeded, so it initialised `st`.
	Ok(unsafe { st.assume_init() })
}

/// `fstat(fd)`.
pub(crate) fn fstat(fd: BorrowedFd<'_>) -> io::Result<libc::stat> {
	let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
	retry(|| {
		// SAFETY: `st` points to writable storage for one `stat`; `fd` is live.
		unsafe { libc::fstat(fd.as_raw_fd(), st.as_mut_ptr()) }
	})?;
	// SAFETY: fstat succeeded, so it initialised `st`.
	Ok(unsafe { st.assume_init() })
}

/// `readlinkat(dir, name)`; the whole target, however long.
pub(crate) fn readlinkat(dir: Option<BorrowedFd<'_>>, name: &CStr) -> io::Result<Vec<u8>> {
	let target = match dir {
		Some(fd) => rustix::fs::readlinkat(fd, name, Vec::new()),
		None => rustix::fs::readlinkat(rustix::fs::CWD, name, Vec::new()),
	}?;
	Ok(target.into_bytes())
}

/// `mkdirat(dir, name, mode)`.
pub(crate) fn mkdirat(dir: Option<BorrowedFd<'_>>, name: &CStr, mode: u32) -> io::Result<()> {
	check(retry(|| {
		// SAFETY: valid C string and dirfd.
		unsafe { libc::mkdirat(dirfd(dir), name.as_ptr(), mode as libc::mode_t) }
	}))
}

/// `unlinkat(dir, name, rmdir ? AT_REMOVEDIR : 0)`.
pub(crate) fn unlinkat(dir: Option<BorrowedFd<'_>>, name: &CStr, rmdir: bool) -> io::Result<()> {
	let flags = if rmdir { libc::AT_REMOVEDIR } else { 0 };
	check(retry(|| {
		// SAFETY: valid C string and dirfd.
		unsafe { libc::unlinkat(dirfd(dir), name.as_ptr(), flags) }
	}))
}

/// `renameat(old_dir, old, new_dir, new)`.
pub(crate) fn renameat(
	old_dir: Option<BorrowedFd<'_>>,
	old: &CStr,
	new_dir: Option<BorrowedFd<'_>>,
	new: &CStr,
) -> io::Result<()> {
	check(retry(|| {
		// SAFETY: valid C strings and dirfds.
		unsafe { libc::renameat(dirfd(old_dir), old.as_ptr(), dirfd(new_dir), new.as_ptr()) }
	}))
}

/// `linkat(old_dir, old, new_dir, new, 0)`: never follows a symlink `old`.
pub(crate) fn linkat(
	old_dir: Option<BorrowedFd<'_>>,
	old: &CStr,
	new_dir: Option<BorrowedFd<'_>>,
	new: &CStr,
) -> io::Result<()> {
	check(retry(|| {
		// SAFETY: valid C strings and dirfds.
		unsafe { libc::linkat(dirfd(old_dir), old.as_ptr(), dirfd(new_dir), new.as_ptr(), 0) }
	}))
}

/// `symlinkat(target, dir, name)`.
pub(crate) fn symlinkat(target: &CStr, dir: Option<BorrowedFd<'_>>, name: &CStr) -> io::Result<()> {
	check(retry(|| {
		// SAFETY: valid C strings and dirfd.
		unsafe { libc::symlinkat(target.as_ptr(), dirfd(dir), name.as_ptr()) }
	}))
}

/// `fchmodat(dir, name, mode, nofollow ? AT_SYMLINK_NOFOLLOW : 0)`.
pub(crate) fn fchmodat(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	mode: u32,
	nofollow: bool,
) -> io::Result<()> {
	let flags = if nofollow { libc::AT_SYMLINK_NOFOLLOW } else { 0 };
	check(retry(|| {
		// SAFETY: valid C string and dirfd.
		unsafe { libc::fchmodat(dirfd(dir), name.as_ptr(), mode as libc::mode_t, flags) }
	}))
}

/// `fchmod(fd, mode)`.
pub(crate) fn fchmod(fd: BorrowedFd<'_>, mode: u32) -> io::Result<()> {
	check(retry(|| {
		// SAFETY: `fd` is a live descriptor.
		unsafe { libc::fchmod(fd.as_raw_fd(), mode as libc::mode_t) }
	}))
}

/// `fchownat(dir, name, uid, gid, nofollow ? AT_SYMLINK_NOFOLLOW : 0)`; `None`
/// leaves that id unchanged.
pub(crate) fn fchownat(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	uid: Option<u32>,
	gid: Option<u32>,
	nofollow: bool,
) -> io::Result<()> {
	let flags = if nofollow { libc::AT_SYMLINK_NOFOLLOW } else { 0 };
	let uid = uid.map_or(libc::uid_t::MAX, |id| id as libc::uid_t);
	let gid = gid.map_or(libc::gid_t::MAX, |id| id as libc::gid_t);
	check(retry(|| {
		// SAFETY: valid C string and dirfd.
		unsafe { libc::fchownat(dirfd(dir), name.as_ptr(), uid, gid, flags) }
	}))
}

fn timespec(time: FileTime) -> libc::timespec {
	let (secs, nsec) = match time {
		FileTime::Omit => (0, libc::UTIME_OMIT),
		FileTime::Now => (0, libc::UTIME_NOW),
		FileTime::At(at) => {
			let (secs, nsec) = split_time(at);
			(secs, nsec as _)
		},
	};
	// SAFETY: timespec is plain old data; zeroing covers any padding fields.
	let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
	ts.tv_sec = secs as libc::time_t;
	ts.tv_nsec = nsec as _;
	ts
}

/// `utimensat(dir, name, [atime, mtime], nofollow ? AT_SYMLINK_NOFOLLOW : 0)`.
pub(crate) fn utimensat(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	atime: FileTime,
	mtime: FileTime,
	nofollow: bool,
) -> io::Result<()> {
	let times = [timespec(atime), timespec(mtime)];
	let flags = if nofollow { libc::AT_SYMLINK_NOFOLLOW } else { 0 };
	check(retry(|| {
		// SAFETY: `times` holds exactly two timespecs; valid C string and dirfd.
		unsafe { libc::utimensat(dirfd(dir), name.as_ptr(), times.as_ptr(), flags) }
	}))
}

/// `mknodat(dir, name, mode, dev)`.
pub(crate) fn mknodat(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	mode: u32,
	dev: u64,
) -> io::Result<()> {
	check(retry(|| {
		// SAFETY: valid C string and dirfd.
		unsafe { libc::mknodat(dirfd(dir), name.as_ptr(), mode as libc::mode_t, dev as libc::dev_t) }
	}))
}

/// `mkfifoat(dir, name, mode)`.
pub(crate) fn mkfifoat(dir: Option<BorrowedFd<'_>>, name: &CStr, mode: u32) -> io::Result<()> {
	check(retry(|| {
		// SAFETY: valid C string and dirfd.
		unsafe { libc::mkfifoat(dirfd(dir), name.as_ptr(), mode as libc::mode_t) }
	}))
}

/// Names in the directory `fd` (opened for reading), without `.` and `..`.
pub(crate) fn read_dir(fd: OwnedFd) -> io::Result<Vec<OsString>> {
	let mut dir = rustix::fs::Dir::new(fd)?;
	let mut names = Vec::new();
	while let Some(entry) = dir.read() {
		let entry = entry?;
		let name = entry.file_name().to_bytes();
		if name == b"." || name == b".." {
			continue;
		}
		names.push(OsString::from_vec(name.to_vec()));
	}
	Ok(names)
}

/// `st_mode` of a `stat` as `u32`.
pub(crate) fn st_mode(st: &libc::stat) -> u32 {
	st.st_mode as u32
}

/// `st_uid` of a `stat`.
pub(crate) fn st_uid(st: &libc::stat) -> u32 {
	st.st_uid as u32
}

/// Whether a `stat` describes a symlink / directory / regular file / FIFO.
pub(crate) fn is_lnk(st: &libc::stat) -> bool {
	st_mode(st) & (libc::S_IFMT as u32) == libc::S_IFLNK as u32
}

/// See [`is_lnk`].
pub(crate) fn is_dir(st: &libc::stat) -> bool {
	st_mode(st) & (libc::S_IFMT as u32) == libc::S_IFDIR as u32
}

/// See [`is_lnk`].
pub(crate) fn is_reg(st: &libc::stat) -> bool {
	st_mode(st) & (libc::S_IFMT as u32) == libc::S_IFREG as u32
}

/// See [`is_lnk`].
pub(crate) fn is_fifo(st: &libc::stat) -> bool {
	st_mode(st) & (libc::S_IFMT as u32) == libc::S_IFIFO as u32
}

/// Builds VFS metadata from a raw `stat` (every field, nanosecond times, and
/// the host identity, so it compares equal with host-side metadata).
pub(crate) fn metadata(st: &libc::stat) -> Metadata {
	let mode = st_mode(st);
	// Unix `SystemTime` spans every `time_t`, so the epoch fallback is unreachable.
	let unix_time = |secs: i64, nsec: i64| system_time(secs, nsec).unwrap_or(UNIX_EPOCH);
	let meta = Metadata::new(FileType::from_mode(mode), st.st_size as u64, Permissions::from_mode(mode))
		.with_modified(unix_time(st.st_mtime as i64, st.st_mtime_nsec as i64))
		.with_accessed(unix_time(st.st_atime as i64, st.st_atime_nsec as i64))
		.with_changed(unix_time(st.st_ctime as i64, st.st_ctime_nsec as i64))
		.with_native_id(st.st_dev as u64, st.st_ino as u64)
		.with_nlink(st.st_nlink as u64)
		.with_owner(st.st_uid as u32, st.st_gid as u32)
		.with_rdev(st.st_rdev as u64)
		.with_blocks(st.st_blocks as u64, st.st_blksize as u64);
	#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
	let meta = meta.with_created(unix_time(st.st_birthtime as i64, st.st_birthtime_nsec as i64));
	meta
}

/// Creates a unix socket named `name` in the directory `dir` by binding a
/// listener and closing it, the way upstream creates sockets where `mknod`
/// cannot. The bound address is `name` relative to `dir`, so the socket's
/// full path may exceed `sun_path` (104/108 bytes) exactly as upstream's
/// cwd-relative bind allows; `name` itself must fit.
///
/// macOS binds relative to a per-thread working directory
/// (`pthread_fchdir_np`), restored before returning, so the process cwd is
/// never touched. Linux reaches the directory through its `/proc/self/fd`
/// link. Elsewhere `fallback` (the full path) is bound.
pub(crate) fn bind_socket_at(
	dir: BorrowedFd<'_>,
	name: &CStr,
	fallback: &std::path::Path,
) -> io::Result<()> {
	use std::os::unix::net::UnixListener;
	#[cfg(any(target_os = "macos", target_os = "ios"))]
	{
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
		unsafe extern "C" {
			fn pthread_fchdir_np(fd: libc::c_int) -> libc::c_int;
		}
		/// Restores the process cwd for this thread on every exit path.
		struct ThreadCwd;
		impl Drop for ThreadCwd {
			fn drop(&mut self) {
				// SAFETY: -1 drops the per-thread cwd; always valid.
				unsafe { pthread_fchdir_np(-1) };
			}
		}
		let _ = fallback;
		// SAFETY: `dir` is a live directory descriptor.
		if unsafe { pthread_fchdir_np(dir.as_raw_fd()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		let _restore = ThreadCwd;
		drop(UnixListener::bind(OsStr::from_bytes(name.to_bytes()))?);
		Ok(())
	}
	#[cfg(any(target_os = "linux", target_os = "android"))]
	{
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
		let _ = fallback;
		let mut path = format!("/proc/self/fd/{}/", dir.as_raw_fd()).into_bytes();
		path.extend_from_slice(name.to_bytes());
		drop(UnixListener::bind(OsStr::from_bytes(&path))?);
		Ok(())
	}
	#[cfg(not(any(
		target_os = "macos",
		target_os = "ios",
		target_os = "linux",
		target_os = "android"
	)))]
	{
		let _ = (dir, name);
		drop(UnixListener::bind(fallback)?);
		Ok(())
	}
}

/// Opens `/` for traversal.
pub(crate) fn open_root_dir() -> io::Result<OwnedFd> {
	openat(None, c"/", TRAVERSE, 0)
}

/// What an xattr call operates on: an open descriptor, or a path (with or
/// without following a final symlink).
#[derive(Clone, Copy)]
pub(crate) enum XattrAt<'a> {
	Fd(BorrowedFd<'a>),
	Path { path: &'a CStr, nofollow: bool },
}

/// "No such attribute" (ENOATTR on the BSDs/macOS, ENODATA on Linux).
fn no_attr(code: i32) -> bool {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	return code == libc::ENODATA;
	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	return code == libc::ENOATTR;
}

/// Bounded retries when an attribute grows between the size probe and the
/// read (`ERANGE`).
const XATTR_RETRIES: usize = 8;

#[cfg(any(target_os = "linux", target_os = "android"))]
mod xattr_raw {
	use super::*;

	pub(super) unsafe fn get(
		at: XattrAt<'_>,
		name: &CStr,
		buf: *mut libc::c_void,
		size: usize,
	) -> isize {
		// SAFETY (caller): `buf` is null with `size == 0`, or valid for `size` bytes.
		unsafe {
			match at {
				XattrAt::Fd(fd) => libc::fgetxattr(fd.as_raw_fd(), name.as_ptr(), buf, size),
				XattrAt::Path { path, nofollow: true } => {
					libc::lgetxattr(path.as_ptr(), name.as_ptr(), buf, size)
				},
				XattrAt::Path { path, nofollow: false } => {
					libc::getxattr(path.as_ptr(), name.as_ptr(), buf, size)
				},
			}
		}
	}

	pub(super) unsafe fn list(at: XattrAt<'_>, buf: *mut libc::c_char, size: usize) -> isize {
		// SAFETY (caller): `buf` is null with `size == 0`, or valid for `size` bytes.
		unsafe {
			match at {
				XattrAt::Fd(fd) => libc::flistxattr(fd.as_raw_fd(), buf, size),
				XattrAt::Path { path, nofollow: true } => libc::llistxattr(path.as_ptr(), buf, size),
				XattrAt::Path { path, nofollow: false } => libc::listxattr(path.as_ptr(), buf, size),
			}
		}
	}

	pub(super) fn set(at: XattrAt<'_>, name: &CStr, value: &[u8]) -> libc::c_int {
		let (ptr, len) = (value.as_ptr().cast::<libc::c_void>(), value.len());
		// SAFETY: `value` is valid for `len` bytes; C strings are NUL-terminated.
		unsafe {
			match at {
				XattrAt::Fd(fd) => libc::fsetxattr(fd.as_raw_fd(), name.as_ptr(), ptr, len, 0),
				XattrAt::Path { path, nofollow: true } => {
					libc::lsetxattr(path.as_ptr(), name.as_ptr(), ptr, len, 0)
				},
				XattrAt::Path { path, nofollow: false } => {
					libc::setxattr(path.as_ptr(), name.as_ptr(), ptr, len, 0)
				},
			}
		}
	}

	pub(super) fn remove(at: XattrAt<'_>, name: &CStr) -> libc::c_int {
		// SAFETY: NUL-terminated C strings and a live descriptor.
		unsafe {
			match at {
				XattrAt::Fd(fd) => libc::fremovexattr(fd.as_raw_fd(), name.as_ptr()),
				XattrAt::Path { path, nofollow: true } => {
					libc::lremovexattr(path.as_ptr(), name.as_ptr())
				},
				XattrAt::Path { path, nofollow: false } => {
					libc::removexattr(path.as_ptr(), name.as_ptr())
				},
			}
		}
	}
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod xattr_raw {
	use super::*;

	fn options(at: XattrAt<'_>) -> libc::c_int {
		match at {
			XattrAt::Path { nofollow: true, .. } => libc::XATTR_NOFOLLOW,
			_ => 0,
		}
	}

	pub(super) unsafe fn get(
		at: XattrAt<'_>,
		name: &CStr,
		buf: *mut libc::c_void,
		size: usize,
	) -> isize {
		let opts = options(at);
		// SAFETY (caller): `buf` is null with `size == 0`, or valid for `size` bytes.
		unsafe {
			match at {
				XattrAt::Fd(fd) => libc::fgetxattr(fd.as_raw_fd(), name.as_ptr(), buf, size, 0, 0),
				XattrAt::Path { path, .. } => {
					libc::getxattr(path.as_ptr(), name.as_ptr(), buf, size, 0, opts)
				},
			}
		}
	}

	pub(super) unsafe fn list(at: XattrAt<'_>, buf: *mut libc::c_char, size: usize) -> isize {
		let opts = options(at);
		// SAFETY (caller): `buf` is null with `size == 0`, or valid for `size` bytes.
		unsafe {
			match at {
				XattrAt::Fd(fd) => libc::flistxattr(fd.as_raw_fd(), buf, size, 0),
				XattrAt::Path { path, .. } => libc::listxattr(path.as_ptr(), buf, size, opts),
			}
		}
	}

	pub(super) fn set(at: XattrAt<'_>, name: &CStr, value: &[u8]) -> libc::c_int {
		let opts = options(at);
		let (ptr, len) = (value.as_ptr().cast::<libc::c_void>(), value.len());
		// SAFETY: `value` is valid for `len` bytes; C strings are NUL-terminated.
		unsafe {
			match at {
				XattrAt::Fd(fd) => libc::fsetxattr(fd.as_raw_fd(), name.as_ptr(), ptr, len, 0, 0),
				XattrAt::Path { path, .. } => {
					libc::setxattr(path.as_ptr(), name.as_ptr(), ptr, len, 0, opts)
				},
			}
		}
	}

	pub(super) fn remove(at: XattrAt<'_>, name: &CStr) -> libc::c_int {
		let opts = options(at);
		// SAFETY: NUL-terminated C strings and a live descriptor.
		unsafe {
			match at {
				XattrAt::Fd(fd) => libc::fremovexattr(fd.as_raw_fd(), name.as_ptr(), 0),
				XattrAt::Path { path, .. } => libc::removexattr(path.as_ptr(), name.as_ptr(), opts),
			}
		}
	}
}

#[cfg(not(any(
	target_os = "linux",
	target_os = "android",
	target_os = "macos",
	target_os = "ios"
)))]
mod xattr_raw {
	use super::*;

	pub(super) unsafe fn get(_: XattrAt<'_>, _: &CStr, _: *mut libc::c_void, _: usize) -> isize {
		-1
	}

	pub(super) unsafe fn list(_: XattrAt<'_>, _: *mut libc::c_char, _: usize) -> isize {
		-1
	}

	pub(super) fn set(_: XattrAt<'_>, _: &CStr, _: &[u8]) -> libc::c_int {
		-1
	}

	pub(super) fn remove(_: XattrAt<'_>, _: &CStr) -> libc::c_int {
		-1
	}
}

/// Whether this platform has an xattr API at all.
const HAVE_XATTRS: bool = cfg!(any(
	target_os = "linux",
	target_os = "android",
	target_os = "macos",
	target_os = "ios"
));

fn no_xattrs() -> io::Error {
	errno(libc::EOPNOTSUPP)
}

/// One attribute's value; `Ok(None)` when it does not exist.
pub(crate) fn xattr_get(at: XattrAt<'_>, name: &CStr) -> io::Result<Option<Vec<u8>>> {
	if !HAVE_XATTRS {
		return Err(no_xattrs());
	}
	for _ in 0..XATTR_RETRIES {
		// SAFETY: a null buffer with size 0 asks for the value's size.
		let size = unsafe { xattr_raw::get(at, name, std::ptr::null_mut(), 0) };
		if size < 0 {
			let err = io::Error::last_os_error();
			return match err.raw_os_error() {
				Some(code) if no_attr(code) => Ok(None),
				_ => Err(err),
			};
		}
		let mut buf = vec![0u8; size as usize];
		// SAFETY: `buf` is valid for `buf.len()` bytes.
		let got = unsafe { xattr_raw::get(at, name, buf.as_mut_ptr().cast(), buf.len()) };
		if got >= 0 {
			buf.truncate(got as usize);
			return Ok(Some(buf));
		}
		let err = io::Error::last_os_error();
		match err.raw_os_error() {
			Some(libc::ERANGE) => continue,
			Some(code) if no_attr(code) => return Ok(None),
			_ => return Err(err),
		}
	}
	Err(errno(libc::ERANGE))
}

/// Every attribute name.
pub(crate) fn xattr_list(at: XattrAt<'_>) -> io::Result<Vec<OsString>> {
	if !HAVE_XATTRS {
		return Err(no_xattrs());
	}
	for _ in 0..XATTR_RETRIES {
		// SAFETY: a null buffer with size 0 asks for the list's size.
		let size = unsafe { xattr_raw::list(at, std::ptr::null_mut(), 0) };
		if size < 0 {
			return Err(io::Error::last_os_error());
		}
		if size == 0 {
			return Ok(Vec::new());
		}
		let mut buf = vec![0u8; size as usize];
		// SAFETY: `buf` is valid for `buf.len()` bytes.
		let got = unsafe { xattr_raw::list(at, buf.as_mut_ptr().cast(), buf.len()) };
		if got >= 0 {
			buf.truncate(got as usize);
			return Ok(buf
				.split(|&b| b == 0)
				.filter(|name| !name.is_empty())
				.map(|name| OsString::from_vec(name.to_vec()))
				.collect());
		}
		let err = io::Error::last_os_error();
		if err.raw_os_error() != Some(libc::ERANGE) {
			return Err(err);
		}
	}
	Err(errno(libc::ERANGE))
}

/// Creates or replaces one attribute.
pub(crate) fn xattr_set(at: XattrAt<'_>, name: &CStr, value: &[u8]) -> io::Result<()> {
	if !HAVE_XATTRS {
		return Err(no_xattrs());
	}
	if xattr_raw::set(at, name, value) < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
}

/// Removes one attribute.
pub(crate) fn xattr_remove(at: XattrAt<'_>, name: &CStr) -> io::Result<()> {
	if !HAVE_XATTRS {
		return Err(no_xattrs());
	}
	if xattr_raw::remove(at, name) < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
}

/// Creation time (`ATTR_CMN_CRTIME`) of `dir/name`, seconds.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn crtime_at(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	nofollow: bool,
) -> io::Result<Option<i64>> {
	#[repr(C, packed(4))]
	struct CrtimeBuf {
		length: u32,
		crtime: libc::timespec,
	}
	let mut attrs = crtime_attrlist();
	// SAFETY: plain old data; getattrlistat fills it.
	let mut buf: CrtimeBuf = unsafe { std::mem::zeroed() };
	let options = if nofollow { libc::FSOPT_NOFOLLOW } else { 0 };
	retry(|| {
		// SAFETY: `attrs` and `buf` are live, correctly sized buffers.
		unsafe {
			libc::getattrlistat(
				dirfd(dir),
				name.as_ptr(),
				(&raw mut attrs).cast(),
				(&raw mut buf).cast(),
				std::mem::size_of::<CrtimeBuf>(),
				options as libc::c_ulong,
			)
		}
	})?;
	let crtime = buf.crtime;
	Ok(Some(crtime.tv_sec as i64))
}

/// Sets the creation time of `dir/name` (nanoseconds zero, as upstream).
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn set_crtime_at(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	crtime: i64,
	nofollow: bool,
) -> io::Result<()> {
	let mut attrs = crtime_attrlist();
	// SAFETY: timespec is plain old data.
	let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
	ts.tv_sec = crtime as libc::time_t;
	let options = if nofollow { libc::FSOPT_NOFOLLOW } else { 0 };
	check(retry(|| {
		// SAFETY: `attrs` and `ts` are live, correctly sized buffers.
		unsafe {
			libc::setattrlistat(
				dirfd(dir),
				name.as_ptr(),
				(&raw mut attrs).cast(),
				(&raw mut ts).cast(),
				std::mem::size_of::<libc::timespec>(),
				options,
			)
		}
	}))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn crtime_attrlist() -> libc::attrlist {
	// SAFETY: attrlist is plain old data; zero is "no attributes".
	let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
	attrs.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
	attrs.commonattr = libc::ATTR_CMN_CRTIME;
	attrs
}

/// Birth time of `dir/name` via `statx`, when the filesystem records one.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) fn crtime_at(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	nofollow: bool,
) -> io::Result<Option<i64>> {
	use rustix::fs::{AtFlags, StatxFlags};
	let flags = if nofollow { AtFlags::SYMLINK_NOFOLLOW } else { AtFlags::empty() };
	let result = match dir {
		Some(fd) => rustix::fs::statx(fd, name, flags, StatxFlags::BTIME),
		None => rustix::fs::statx(rustix::fs::CWD, name, flags, StatxFlags::BTIME),
	};
	match result {
		Ok(stx) if stx.stx_mask & StatxFlags::BTIME.bits() != 0 => Ok(Some(stx.stx_btime.tv_sec)),
		Ok(_) => Ok(None),
		Err(err) if err == rustix::io::Errno::NOSYS => Ok(None),
		Err(err) => Err(err.into()),
	}
}

/// No creation-time support on this platform.
#[cfg(not(any(
	target_os = "linux",
	target_os = "android",
	target_os = "macos",
	target_os = "ios"
)))]
pub(crate) fn crtime_at(
	dir: Option<BorrowedFd<'_>>,
	name: &CStr,
	nofollow: bool,
) -> io::Result<Option<i64>> {
	fstatat(dir, name, nofollow).map(|_| None)
}
