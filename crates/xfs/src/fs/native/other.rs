//! Portable Unix fallback for platforms without a dedicated fast path:
//! `readdir` listings with one `fstatat` per entry (`d_type` is not portable)
//! and second-granularity timestamps.

use std::{
	ffi::{CStr, c_char, c_int},
	io,
	mem::MaybeUninit,
	os::fd::{OwnedFd, RawFd},
};

use super::{
	is_dot_or_dot_dot,
	unix::{Scratch, nanos, openat_plain, type_of_mode},
};
use crate::fs::{Detail, FileInfo, FileType, Listing, Stamp};

pub(super) const WORKERS: usize = 4;

pub(super) fn openat(dir: RawFd, path: *const c_char, flags: c_int) -> io::Result<OwnedFd> {
	openat_plain(dir, path, flags)
}

/// Reads every entry of `dir` into `out`. `readdir` cannot report errors
/// portably (errno access differs per libc), so an error ends the listing.
pub(super) fn list(
	_s: &mut Scratch,
	dir: RawFd,
	detail: Detail,
	_children: u32,
	out: &mut Listing,
) -> io::Result<()> {
	// SAFETY: duplicating a descriptor this call borrows.
	let dup = unsafe { libc::dup(dir) };
	if dup < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `dup` is a fresh directory descriptor; on success the stream owns
	// it.
	let stream = unsafe { libc::fdopendir(dup) };
	if stream.is_null() {
		let err = io::Error::last_os_error();
		// SAFETY: `fdopendir` failed, so `dup` is still ours to close.
		unsafe { libc::close(dup) };
		return Err(err);
	}
	// SAFETY: `stream` is a valid directory stream; the duplicate shares the
	// original's offset, so rewind before reading.
	unsafe { libc::rewinddir(stream) };
	loop {
		// SAFETY: `stream` is a valid directory stream.
		let entry = unsafe { libc::readdir(stream) };
		if entry.is_null() {
			break;
		}
		// SAFETY: `readdir` returned a valid entry whose name is NUL-terminated.
		let cname = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
		let name = cname.to_bytes();
		if name.is_empty() || is_dot_or_dot_dot(name) {
			continue;
		}
		let Ok(st) = fstatat(dir, cname.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) else {
			continue;
		};
		let Some(file_type) = type_of_mode(st.st_mode) else {
			continue;
		};
		let (size, mtime) = match detail {
			Detail::Minimal => (None, None),
			Detail::Full => (
				(file_type == FileType::File).then_some(st.st_size as u64),
				Some(nanos(st.st_mtime as i64, 0)),
			),
		};
		out.push(name, file_type, size, mtime, 0);
	}
	// SAFETY: `stream` is valid and closed exactly once (closing `dup`).
	unsafe { libc::closedir(stream) };
	Ok(())
}

fn fstatat(dir: RawFd, path: *const c_char, flags: c_int) -> io::Result<libc::stat> {
	let mut st = MaybeUninit::<libc::stat>::uninit();
	loop {
		// SAFETY: `path` is NUL-terminated and `st` is a valid out-pointer.
		if unsafe { libc::fstatat(dir, path, st.as_mut_ptr(), flags) } == 0 {
			// SAFETY: `fstatat` succeeded and filled `st`.
			return Ok(unsafe { st.assume_init() });
		}
		let err = io::Error::last_os_error();
		if err.kind() != io::ErrorKind::Interrupted {
			return Err(err);
		}
	}
}

pub(super) fn stat_path(path: *const c_char, follow: bool) -> io::Result<FileInfo> {
	let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
	fstatat(libc::AT_FDCWD, path, flags).map(|st| info_of(&st))
}

pub(super) fn stat_fd(fd: RawFd) -> io::Result<FileInfo> {
	let mut st = MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `st` is a valid out-pointer.
	if unsafe { libc::fstat(fd, st.as_mut_ptr()) } != 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `fstat` succeeded and filled `st`.
	Ok(info_of(unsafe { st.assume_init_ref() }))
}

fn info_of(st: &libc::stat) -> FileInfo {
	FileInfo {
		file_type: type_of_mode(st.st_mode),
		size:      st.st_size as u64,
		stamp:     Stamp {
			dev:   st.st_dev as u64,
			ino:   st.st_ino as u64,
			mtime: nanos(st.st_mtime as i64, 0),
			ctime: nanos(st.st_ctime as i64, 0),
		},
	}
}

/// Second-granularity timestamps cannot tell quick successive changes apart.
pub(super) const fn fine_timestamps(_fd: RawFd) -> bool {
	false
}
