//! macOS directory reads:
//!
//! - Minimal listings use `__getdirentries64` with a buffer of at least
//!   `GETDIRENTRIES64_EXTENDED_BUFSIZE`; the kernel then stores an EOF flag in
//!   the buffer's last four bytes, so a directory that fits in the buffer takes
//!   exactly one listing call instead of a second call returning 0. On APFS
//!   this also beats `getattrlistbulk(NAME|OBJTYPE)` by ~25%.
//! - Full listings use `getattrlistbulk`, which returns names, types, mtimes,
//!   and sizes without per-entry stat calls. The parent's listing also returns
//!   each subdirectory's entry count, so the child's listing stops once it has
//!   seen that many entries rather than issuing a final empty call.

use std::{
	ffi::{c_char, c_int},
	io,
	mem::MaybeUninit,
	os::fd::{OwnedFd, RawFd},
};

use super::{
	aligned_buf, is_dot_or_dot_dot, le16, le32, le64,
	unix::{Scratch, nanos, openat_plain, type_of_dt, type_of_mode},
};
use crate::fs::{Detail, FileInfo, FileType, Listing, Stamp};

/// Directory opens and listings contend in the kernel: on APFS throughput
/// peaks at 4–6 threads and collapses beyond 8.
pub(super) const WORKERS: usize = 4;

const LIST_BUF: usize = 128 << 10;

// struct dirent (64-bit inode layout) field offsets.
const DIRENT_INO: usize = 0;
const DIRENT_RECLEN: usize = 16;
const DIRENT_NAMLEN: usize = 18;
const DIRENT_TYPE: usize = 20;
const DIRENT_NAME: usize = 21;

const GETDIRENTRIES64_EOF: u32 = 1;

// getattrlistbulk record layout: u32 length, the 20-byte returned
// attribute_set_t (common, vol, dir, file, fork), then each returned
// attribute in bitmap order, 4-byte aligned. getattrlistbulk rejects
// requests without ATTR_CMN_RETURNED_ATTRS (EINVAL) and omits attributes
// that do not apply to an entry, so later offsets depend on the set.
const BULK_RETURNED_COMMON: usize = 4;
const BULK_RETURNED_DIR: usize = 12;
const BULK_RETURNED_FILE: usize = 16;
const BULK_NAME_REF: usize = 24;
const BULK_OBJ_TYPE: usize = 32;
const BULK_MOD_TIME: usize = 36;
const BULK_MIN_LEN: usize = 52;

const VREG: u32 = 1;
const VDIR: u32 = 2;
const VLNK: u32 = 5;

const WANT_COMMON: u32 = libc::ATTR_CMN_NAME | libc::ATTR_CMN_OBJTYPE | libc::ATTR_CMN_MODTIME;

unsafe extern "C" {
	fn __getdirentries64(
		fd: c_int,
		buf: *mut c_char,
		nbytes: libc::size_t,
		basep: *mut libc::off_t,
	) -> libc::ssize_t;
}

pub(super) fn openat(dir: RawFd, path: *const c_char, flags: c_int) -> io::Result<OwnedFd> {
	openat_plain(dir, path, flags)
}

fn eio() -> io::Error {
	io::Error::from_raw_os_error(libc::EIO)
}

pub(super) fn list(
	s: &mut Scratch,
	dir: RawFd,
	detail: Detail,
	children: u32,
	out: &mut Listing,
) -> io::Result<()> {
	let Scratch { buf, cname } = s;
	let buf = aligned_buf(buf, LIST_BUF);
	match detail {
		Detail::Minimal => list_dirents(buf, cname, dir, out),
		Detail::Full => list_bulk(buf, dir, children, out),
	}
}

fn list_dirents(
	buf: &mut [u8],
	cname: &mut Vec<u8>,
	dir: RawFd,
	out: &mut Listing,
) -> io::Result<()> {
	let mut base: libc::off_t = 0;
	loop {
		// SAFETY: `buf` is writable for its whole length and `base` is a valid
		// out-pointer.
		let n = unsafe { __getdirentries64(dir, buf.as_mut_ptr().cast(), buf.len(), &raw mut base) };
		if n < 0 {
			let err = io::Error::last_os_error();
			if err.kind() == io::ErrorKind::Interrupted {
				continue;
			}
			return Err(err);
		}
		let n = n as usize;
		if n == 0 {
			return Ok(());
		}
		let mut off = 0;
		while off + DIRENT_NAME <= n {
			let rec = &buf[off..n];
			let reclen = le16(rec, DIRENT_RECLEN) as usize;
			if reclen < DIRENT_NAME || reclen > rec.len() {
				return Err(eio());
			}
			off += reclen;
			let namlen = le16(rec, DIRENT_NAMLEN) as usize;
			if DIRENT_NAME + namlen > reclen || le64(rec, DIRENT_INO) == 0 {
				continue;
			}
			let name = &rec[DIRENT_NAME..DIRENT_NAME + namlen];
			if is_dot_or_dot_dot(name) {
				continue;
			}
			let dt = rec[DIRENT_TYPE];
			let file_type = match type_of_dt(dt) {
				Some(file_type) => file_type,
				None
					if dt == libc::DT_UNKNOWN
						&& let Some(file_type) = stat_type(dir, cname, name) =>
				{
					file_type
				},
				None => continue,
			};
			out.push(name, file_type, None, None, 0);
		}
		let flags = u32::from_le_bytes(*buf.last_chunk().expect("listing buffer holds the EOF flag"));
		if flags & GETDIRENTRIES64_EOF != 0 {
			return Ok(());
		}
	}
}

fn list_bulk(buf: &mut [u8], dir: RawFd, count: u32, out: &mut Listing) -> io::Result<()> {
	let mut attrs = libc::attrlist {
		bitmapcount: libc::ATTR_BIT_MAP_COUNT,
		reserved:    0,
		commonattr:  libc::ATTR_CMN_RETURNED_ATTRS | WANT_COMMON,
		volattr:     0,
		dirattr:     libc::ATTR_DIR_ENTRYCOUNT,
		fileattr:    libc::ATTR_FILE_DATALENGTH,
		forkattr:    0,
	};
	let mut seen = 0u32;
	loop {
		// SAFETY: `attrs` and `buf` are valid for the call; the kernel writes at
		// most `buf.len()` bytes.
		let n = unsafe {
			libc::getattrlistbulk(
				dir,
				(&raw mut attrs).cast(),
				buf.as_mut_ptr().cast(),
				buf.len(),
				u64::from(libc::FSOPT_NOFOLLOW),
			)
		};
		if n < 0 {
			let err = io::Error::last_os_error();
			if err.kind() == io::ErrorKind::Interrupted {
				continue;
			}
			return Err(err);
		}
		if n == 0 {
			return Ok(());
		}
		let mut off = 0;
		for _ in 0..n {
			if off + BULK_MIN_LEN > buf.len() {
				return Err(eio());
			}
			let rec = &buf[off..];
			let reclen = le32(rec, 0) as usize;
			if reclen < BULK_MIN_LEN || reclen > rec.len() {
				return Err(eio());
			}
			let rec = &rec[..reclen];
			off += reclen;
			if le32(rec, BULK_RETURNED_COMMON) & WANT_COMMON != WANT_COMMON {
				continue;
			}
			let name_ref = le32(rec, BULK_NAME_REF).cast_signed() as isize;
			let name_len = le32(rec, BULK_NAME_REF + 4) as usize;
			let Some(name_off) = BULK_NAME_REF
				.checked_add_signed(name_ref)
				.filter(|&off| off >= BULK_MIN_LEN && name_len > 0 && off + name_len <= reclen)
			else {
				return Err(eio());
			};
			let mut name = &rec[name_off..name_off + name_len];
			if let [rest @ .., 0] = name {
				name = rest;
			}
			if name.is_empty() || is_dot_or_dot_dot(name) {
				continue;
			}
			let file_type = match le32(rec, BULK_OBJ_TYPE) {
				VREG => FileType::File,
				VDIR => FileType::Dir,
				VLNK => FileType::Symlink,
				_ => continue,
			};
			let mtime = nanos(le64(rec, BULK_MOD_TIME) as i64, le64(rec, BULK_MOD_TIME + 8) as i64);
			let mut size = None;
			let mut children = 0;
			let mut cursor = BULK_MIN_LEN;
			if le32(rec, BULK_RETURNED_DIR) & libc::ATTR_DIR_ENTRYCOUNT != 0 && cursor + 4 <= name_off
			{
				children = le32(rec, cursor);
				cursor += 4;
			}
			if le32(rec, BULK_RETURNED_FILE) & libc::ATTR_FILE_DATALENGTH != 0
				&& cursor + 8 <= name_off
				&& file_type == FileType::File
			{
				size = Some(le64(rec, cursor));
			}
			out.push(name, file_type, size, Some(mtime), children);
		}
		seen = seen.saturating_add(n as u32);
		if count > 0 && seen >= count {
			return Ok(());
		}
	}
}

/// Resolves an entry whose listing reported `DT_UNKNOWN`.
fn stat_type(dir: RawFd, cname: &mut Vec<u8>, name: &[u8]) -> Option<FileType> {
	cname.clear();
	cname.extend_from_slice(name);
	cname.push(0);
	let mut st = MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `cname` is NUL-terminated and `st` is a valid out-pointer.
	if unsafe {
		libc::fstatat(dir, cname.as_ptr().cast(), st.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
	} != 0
	{
		return None;
	}
	// SAFETY: `fstatat` succeeded and filled `st`.
	type_of_mode(unsafe { st.assume_init_ref() }.st_mode)
}

pub(super) fn stat_path(path: *const c_char, follow: bool) -> io::Result<FileInfo> {
	let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
	let mut st = MaybeUninit::<libc::stat>::uninit();
	loop {
		// SAFETY: `path` is NUL-terminated and `st` is a valid out-pointer.
		if unsafe { libc::fstatat(libc::AT_FDCWD, path, st.as_mut_ptr(), flags) } == 0 {
			// SAFETY: `fstatat` succeeded and filled `st`.
			return Ok(info_of(unsafe { st.assume_init_ref() }));
		}
		let err = io::Error::last_os_error();
		if err.kind() != io::ErrorKind::Interrupted {
			return Err(err);
		}
	}
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
			dev:   u64::from(st.st_dev as u32),
			ino:   st.st_ino,
			mtime: nanos(st.st_mtime, st.st_mtime_nsec),
			ctime: nanos(st.st_ctime, st.st_ctime_nsec),
		},
	}
}

/// Admits APFS. HFS+ keeps 1-second timestamps; network and FUSE
/// filesystems may not update directory times promptly.
pub(super) fn fine_timestamps(fd: RawFd) -> bool {
	let mut fs = MaybeUninit::<libc::statfs>::uninit();
	// SAFETY: `fs` is a valid out-pointer.
	if unsafe { libc::fstatfs(fd, fs.as_mut_ptr()) } != 0 {
		return false;
	}
	// SAFETY: `fstatfs` succeeded and filled `fs`.
	let fs = unsafe { fs.assume_init_ref() };
	fs.f_fstypename.map(|c| c as u8).starts_with(b"apfs\0")
}
