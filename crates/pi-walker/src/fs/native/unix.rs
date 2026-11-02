//! Unix descriptors: relative `openat` opens, positional file reads, and the
//! per-device stable-stamp verdicts. Listing and stat syscalls come from the
//! platform's `sys` module.

use std::{
	ffi::{c_char, c_int},
	io,
	os::{
		fd::{AsRawFd, OwnedFd, RawFd},
		unix::ffi::OsStrExt,
	},
	path::Path,
};

use parking_lot::RwLock;

use super::sys;
use crate::fs::{Detail, FileId, FileInfo, FileType, Listing, Stamp, not_regular};

/// An open directory or file descriptor, closed on drop.
pub(crate) type Handle = OwnedFd;

/// See [`crate::fs::Fs::workers`].
pub(crate) const WORKERS: usize = sys::WORKERS;

const DIR_FLAGS: c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
/// `O_NONBLOCK`: a FIFO posing as a regular file must not block the open
/// before `fstat` rejects it.
const FILE_FLAGS: c_int = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK;

/// Largest single read: macOS rejects reads above `INT_MAX` bytes.
const MAX_READ: usize = 0x7fff_f000;

/// Per-session syscall scratch.
#[derive(Default)]
pub(crate) struct Scratch {
	/// Bulk listing buffer (8-aligned).
	pub(super) buf:   Vec<u64>,
	/// NUL-terminated name for `*at` syscalls.
	pub(super) cname: Vec<u8>,
}

impl Scratch {
	/// `name` NUL-terminated in the scratch, valid until the next call.
	pub(super) fn cstr(&mut self, name: &[u8]) -> io::Result<*const c_char> {
		if memchr::memchr(0, name).is_some() {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"));
		}
		self.cname.clear();
		self.cname.extend_from_slice(name);
		self.cname.push(0);
		Ok(self.cname.as_ptr().cast())
	}
}

/// Entry type of a `d_type` value; `None` for special files and `DT_UNKNOWN`.
pub(super) const fn type_of_dt(dt: u8) -> Option<FileType> {
	match dt {
		libc::DT_REG => Some(FileType::File),
		libc::DT_DIR => Some(FileType::Dir),
		libc::DT_LNK => Some(FileType::Symlink),
		_ => None,
	}
}

/// Entry type of an `st_mode`; `None` for special files.
pub(super) const fn type_of_mode(mode: libc::mode_t) -> Option<FileType> {
	match mode & libc::S_IFMT {
		libc::S_IFREG => Some(FileType::File),
		libc::S_IFDIR => Some(FileType::Dir),
		libc::S_IFLNK => Some(FileType::Symlink),
		_ => None,
	}
}

/// Unix nanoseconds of a `(seconds, nanoseconds)` timestamp.
pub(super) const fn nanos(sec: i64, nsec: i64) -> i64 {
	sec.saturating_mul(1_000_000_000).saturating_add(nsec)
}

/// `openat` retrying `EINTR`, for platforms without extra open flags.
#[allow(dead_code, reason = "Linux opens through its own O_NOATIME-aware wrapper")]
pub(super) fn openat_plain(dir: RawFd, path: *const c_char, flags: c_int) -> io::Result<OwnedFd> {
	use std::os::fd::FromRawFd;
	loop {
		// SAFETY: `path` is a NUL-terminated string the caller keeps alive; the
		// flags never include `O_CREAT`, so no mode argument is read.
		let fd = unsafe { libc::openat(dir, path, flags) };
		if fd >= 0 {
			// SAFETY: `openat` returned a fresh descriptor this call owns.
			return Ok(unsafe { OwnedFd::from_raw_fd(fd) });
		}
		let err = io::Error::last_os_error();
		if err.kind() != io::ErrorKind::Interrupted {
			return Err(err);
		}
	}
}

pub(crate) fn open_dir(s: &mut Scratch, path: &Path) -> io::Result<Handle> {
	let path = s.cstr(path.as_os_str().as_bytes())?;
	sys::openat(libc::AT_FDCWD, path, DIR_FLAGS)
}

pub(crate) fn open_child(s: &mut Scratch, parent: &Handle, name: &[u8]) -> io::Result<Handle> {
	let name = s.cstr(name)?;
	sys::openat(parent.as_raw_fd(), name, DIR_FLAGS | libc::O_NOFOLLOW)
}

pub(crate) fn list(
	s: &mut Scratch,
	dir: &Handle,
	detail: Detail,
	children: u32,
	out: &mut Listing,
) -> io::Result<()> {
	sys::list(s, dir.as_raw_fd(), detail, children, out)
}

pub(crate) fn open_file_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
) -> io::Result<(Handle, FileInfo)> {
	open_file_in(s, dir.as_raw_fd(), name)
}

pub(crate) fn open_file(s: &mut Scratch, path: &Path) -> io::Result<(Handle, FileInfo)> {
	open_file_in(s, libc::AT_FDCWD, path.as_os_str().as_bytes())
}

fn open_file_in(s: &mut Scratch, dir: RawFd, name: &[u8]) -> io::Result<(Handle, FileInfo)> {
	let name = s.cstr(name)?;
	let fd = sys::openat(dir, name, FILE_FLAGS)?;
	let info = sys::stat_fd(fd.as_raw_fd())?;
	if info.file_type != Some(FileType::File) {
		return Err(not_regular());
	}
	Ok((fd, info))
}

/// Appends the file's bytes at offset `buf.len()` into `buf`'s spare
/// capacity, up to length `end`; returns the count read (0 at end of file).
pub(crate) fn read_append(h: &Handle, buf: &mut Vec<u8>, end: usize) -> io::Result<usize> {
	let len = buf.len();
	let spare = buf.spare_capacity_mut();
	let want = end.saturating_sub(len).min(spare.len()).min(MAX_READ);
	// SAFETY: `pread` writes at most `want <= spare.len()` bytes into `spare`.
	let n =
		unsafe { libc::pread(h.as_raw_fd(), spare.as_mut_ptr().cast(), want, len as libc::off_t) };
	let n = usize::try_from(n).map_err(|_| io::Error::last_os_error())?;
	// SAFETY: `pread` initialized the first `n <= want` spare bytes.
	unsafe { buf.set_len(len + n) };
	Ok(n)
}

/// Reads into `buf` at file offset `off`.
pub(crate) fn read_at(h: &Handle, buf: &mut [u8], off: u64) -> io::Result<usize> {
	let want = buf.len().min(MAX_READ);
	// SAFETY: `buf` is writable for `want` bytes.
	let n = unsafe { libc::pread(h.as_raw_fd(), buf.as_mut_ptr().cast(), want, off as libc::off_t) };
	usize::try_from(n).map_err(|_| io::Error::last_os_error())
}

pub(crate) fn stat(s: &mut Scratch, path: &Path, follow: bool) -> io::Result<FileInfo> {
	let path = s.cstr(path.as_os_str().as_bytes())?;
	sys::stat_path(path, follow)
}

pub(crate) fn stat_dir(h: &Handle) -> io::Result<Stamp> {
	sys::stat_fd(h.as_raw_fd()).map(|info| info.stamp)
}

pub(crate) fn identify(s: &mut Scratch, path: &Path) -> io::Result<FileId> {
	stat(s, path, true).map(|info| id_of(&info.stamp))
}

pub(crate) fn identify_dir(h: &Handle) -> io::Result<FileId> {
	stat_dir(h).map(|stamp| id_of(&stamp))
}

const fn id_of(stamp: &Stamp) -> FileId {
	FileId { dev: stamp.dev, ino: stamp.ino, native: true }
}

/// Stable-stamp verdicts per device: stamps carry real device numbers, so a
/// filesystem is classified once per process.
static STABLE: RwLock<Vec<(u64, bool)>> = RwLock::new(Vec::new());

pub(crate) fn stable_stamps(h: &Handle, stamp: &Stamp) -> bool {
	if let Some(&(_, ok)) = STABLE.read().iter().find(|(dev, _)| *dev == stamp.dev) {
		return ok;
	}
	let ok = sys::fine_timestamps(h.as_raw_fd());
	let mut memo = STABLE.write();
	if !memo.iter().any(|(dev, _)| *dev == stamp.dev) {
		memo.push((stamp.dev, ok));
	}
	ok
}
