//! Unix host operations.

use std::{
	ffi::{CString, OsStr, OsString},
	fs, io,
	os::{
		fd::{AsRawFd, IntoRawFd, RawFd},
		unix::{
			ffi::OsStrExt,
			fs::{DirBuilderExt, MetadataExt, PermissionsExt},
		},
	},
	path::Path,
	time::UNIX_EPOCH,
};

use crate::{
	error::nul_in_path,
	metadata::Metadata,
	types::{FileId, FileKind, FileTime, NodeKind, Permissions, StatFs, SymlinkKind},
};

fn cstr(path: &Path) -> io::Result<CString> {
	CString::new(path.as_os_str().as_bytes()).map_err(|_| nul_in_path())
}

fn cvt(ret: libc::c_int) -> io::Result<()> {
	if ret == -1 {
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

pub(crate) fn set_dir_mode(builder: &mut fs::DirBuilder, mode: Option<u32>) {
	if let Some(mode) = mode {
		builder.mode(mode);
	}
}

pub(crate) fn symlink(target: &Path, link: &Path, _kind: SymlinkKind) -> io::Result<()> {
	std::os::unix::fs::symlink(target, link)
}

pub(crate) fn set_permissions(path: &Path, permissions: Permissions) -> io::Result<()> {
	fs::set_permissions(path, fs::Permissions::from_mode(permissions.mode()))
}

pub(crate) fn file_set_permissions(file: &fs::File, permissions: Permissions) -> io::Result<()> {
	file.set_permissions(fs::Permissions::from_mode(permissions.mode()))
}

fn timespec(time: FileTime) -> libc::timespec {
	// SAFETY: `timespec` is a plain C struct (some targets add private padding
	// fields); all-zero is a valid value and the public fields are set below.
	let mut spec: libc::timespec = unsafe { std::mem::zeroed() };
	match time {
		FileTime::Omit => spec.tv_nsec = libc::UTIME_OMIT,
		FileTime::Now => spec.tv_nsec = libc::UTIME_NOW,
		FileTime::At(time) => {
			let (secs, nanos) = match time.duration_since(UNIX_EPOCH) {
				Ok(after) => (after.as_secs() as i64, i64::from(after.subsec_nanos())),
				Err(before) => {
					let before = before.duration();
					match before.subsec_nanos() {
						0 => (-(before.as_secs() as i64), 0),
						nanos => (-(before.as_secs() as i64) - 1, 1_000_000_000 - i64::from(nanos)),
					}
				},
			};
			spec.tv_sec = secs as libc::time_t;
			spec.tv_nsec = nanos as _;
		},
	}
	spec
}

pub(crate) fn set_times(
	path: &Path,
	accessed: FileTime,
	modified: FileTime,
	follow: bool,
) -> io::Result<()> {
	let path = cstr(path)?;
	let times = [timespec(accessed), timespec(modified)];
	let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
	// SAFETY: `path` is NUL-terminated and `times` holds the two entries
	// `utimensat` reads.
	cvt(unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), flags) })
}

pub(crate) fn file_set_times(
	file: &fs::File,
	accessed: FileTime,
	modified: FileTime,
) -> io::Result<()> {
	let times = [timespec(accessed), timespec(modified)];
	// SAFETY: `file` owns a valid descriptor and `times` holds two entries.
	cvt(unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) })
}

pub(crate) fn chown(
	path: &Path,
	uid: Option<u32>,
	gid: Option<u32>,
	follow: bool,
) -> io::Result<()> {
	if follow {
		std::os::unix::fs::chown(path, uid, gid)
	} else {
		std::os::unix::fs::lchown(path, uid, gid)
	}
}

/// `access(2)` with the real ids, like the shell's historical test
/// operators.
pub(crate) fn access(path: &Path, read: bool, write: bool, execute: bool) -> io::Result<()> {
	let mut mode = libc::F_OK;
	if read {
		mode |= libc::R_OK;
	}
	if write {
		mode |= libc::W_OK;
	}
	if execute {
		mode |= libc::X_OK;
	}
	let path = cstr(path)?;
	// SAFETY: `path` is NUL-terminated.
	cvt(unsafe { libc::access(path.as_ptr(), mode) })
}

fn stat(path: &Path, follow: bool) -> io::Result<fs::Metadata> {
	if follow {
		fs::metadata(path)
	} else {
		fs::symlink_metadata(path)
	}
}

pub(crate) fn file_id(path: &Path, follow: bool) -> io::Result<FileId> {
	let meta = stat(path, follow)?;
	Ok(FileId::native(meta.dev(), meta.ino()))
}

pub(crate) fn file_id_of(file: &fs::File) -> io::Result<FileId> {
	let meta = file.metadata()?;
	Ok(FileId::native(meta.dev(), meta.ino()))
}

pub(crate) fn link_count(path: &Path, follow: bool) -> io::Result<u64> {
	Ok(stat(path, follow)?.nlink())
}

pub(crate) fn allocated_size(path: &Path) -> io::Result<u64> {
	Ok(fs::metadata(path)?.blocks() * 512)
}

pub(crate) fn file_metadata(file: &fs::File) -> io::Result<Metadata> {
	file.metadata().map(Metadata::from)
}

pub(crate) fn file_is_locked(file: &fs::File) -> io::Result<bool> {
	// SAFETY: `flock` is a plain C struct; zero is valid before the fields
	// below are set.
	let mut lock: libc::flock = unsafe { std::mem::zeroed() };
	lock.l_type = libc::F_WRLCK as _;
	lock.l_whence = libc::SEEK_SET as _;
	lock.l_start = 0;
	lock.l_len = 0;
	// SAFETY: `file` owns a valid descriptor and `lock` is writable for
	// F_GETLK.
	cvt(unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &raw mut lock) })?;
	Ok(lock.l_type != libc::F_UNLCK as libc::c_short)
}

/// Closes the descriptor and reports the error `Drop` would discard.
pub(crate) fn close(file: fs::File) -> io::Result<()> {
	let fd = file.into_raw_fd();
	// SAFETY: `fd` was just released from an owned `File`, so this is its only
	// close.
	match cvt(unsafe { libc::close(fd) }) {
		// The descriptor is released even when close is interrupted.
		Err(err) if err.kind() == io::ErrorKind::Interrupted => Ok(()),
		result => result,
	}
}

pub(crate) fn list_xattr(path: &Path, follow: bool) -> io::Result<Vec<OsString>> {
	let names = if follow {
		xattr::list_deref(path)?
	} else {
		xattr::list(path)?
	};
	Ok(names.collect())
}

pub(crate) fn get_xattr(path: &Path, name: &OsStr, follow: bool) -> io::Result<Option<Vec<u8>>> {
	if follow {
		xattr::get_deref(path, name)
	} else {
		xattr::get(path, name)
	}
}

pub(crate) fn set_xattr(path: &Path, name: &OsStr, value: &[u8], follow: bool) -> io::Result<()> {
	if follow {
		xattr::set_deref(path, name, value)
	} else {
		xattr::set(path, name, value)
	}
}

pub(crate) fn remove_xattr(path: &Path, name: &OsStr, follow: bool) -> io::Result<()> {
	if follow {
		xattr::remove_deref(path, name)
	} else {
		xattr::remove(path, name)
	}
}

pub(crate) fn make_node(path: &Path, kind: NodeKind, mode: u32) -> io::Result<()> {
	let path = cstr(path)?;
	let perm = mode & 0o7777;
	let (format, dev) = match kind {
		NodeKind::Fifo => {
			// SAFETY: `path` is NUL-terminated.
			return cvt(unsafe { libc::mkfifo(path.as_ptr(), perm as libc::mode_t) });
		},
		NodeKind::Regular => (FileKind::File, 0),
		NodeKind::Socket => (FileKind::Socket, 0),
		NodeKind::CharDevice(dev) => (FileKind::CharDevice, dev),
		NodeKind::BlockDevice(dev) => (FileKind::BlockDevice, dev),
	};
	let mode = (format.mode_bits() | perm) as libc::mode_t;
	// SAFETY: `path` is NUL-terminated.
	cvt(unsafe { libc::mknod(path.as_ptr(), mode, dev as libc::dev_t) })
}

/// Where a `statfs` call gets its target.
enum Target<'a> {
	Path(&'a Path),
	Fd(RawFd),
}

pub(crate) fn stat_fs(path: &Path) -> io::Result<StatFs> {
	statfs_impl(&Target::Path(path))
}

pub(crate) fn fstat_fs(file: &fs::File) -> io::Result<StatFs> {
	statfs_impl(&Target::Fd(file.as_raw_fd()))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn statfs_impl(target: &Target<'_>) -> io::Result<StatFs> {
	// SAFETY: `statfs` is a plain C output struct fully written on success.
	let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
	let dev = match target {
		Target::Path(path) => {
			let c = cstr(path)?;
			// SAFETY: `c` is NUL-terminated and `buf` is writable.
			cvt(unsafe { libc::statfs(c.as_ptr(), &raw mut buf) })?;
			fs::metadata(path).ok().map(|meta| meta.dev())
		},
		Target::Fd(fd) => {
			// SAFETY: `fd` is a descriptor owned by the caller and `buf` is writable.
			cvt(unsafe { libc::fstatfs(*fd, &raw mut buf) })?;
			// SAFETY: `stat` is a plain C output struct fully written on success.
			let mut st: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: as above.
			(unsafe { libc::fstat(*fd, &raw mut st) } == 0).then_some(st.st_dev as u64)
		},
	};
	// SAFETY: `fsid_t` is two C ints on every Linux libc.
	let fsid: [u32; 2] = unsafe { std::mem::transmute(buf.f_fsid) };
	Ok(StatFs {
		fs_type:          Some(buf.f_type as i64),
		fs_type_name:     dev.and_then(mount_fs_type),
		block_size:       buf.f_bsize as u64,
		io_size:          buf.f_frsize as u64,
		blocks:           buf.f_blocks as u64,
		blocks_free:      buf.f_bfree as u64,
		blocks_available: buf.f_bavail as u64,
		files:            buf.f_files as u64,
		files_free:       buf.f_ffree as u64,
		fsid:             Some(u64::from(fsid[0]) | (u64::from(fsid[1]) << 32)),
		name_max:         Some(buf.f_namelen as u64),
	})
}

/// Filesystem type of the mount holding device `dev`, from
/// `/proc/self/mountinfo` (the last matching mount wins, as it shadows).
#[cfg(any(target_os = "linux", target_os = "android"))]
fn mount_fs_type(dev: u64) -> Option<String> {
	let major = ((dev >> 32) & 0xffff_f000) | ((dev >> 8) & 0x0fff);
	let minor = ((dev >> 12) & 0xffff_ff00) | (dev & 0x00ff);
	let wanted = format!("{major}:{minor}");
	let mountinfo = fs::read_to_string("/proc/self/mountinfo").ok()?;
	mountinfo
		.lines()
		.rev()
		.filter(|line| line.split(' ').nth(2) == Some(wanted.as_str()))
		.find_map(|line| {
			line
				.split_once(" - ")?
				.1
				.split(' ')
				.next()
				.map(str::to_owned)
		})
}

#[cfg(target_vendor = "apple")]
fn statfs_impl(target: &Target<'_>) -> io::Result<StatFs> {
	// SAFETY: `statfs` is a plain C output struct fully written on success.
	let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
	let name_max = match target {
		Target::Path(path) => {
			let c = cstr(path)?;
			// SAFETY: `c` is NUL-terminated and `buf` is writable.
			cvt(unsafe { libc::statfs(c.as_ptr(), &raw mut buf) })?;
			// SAFETY: `c` is NUL-terminated.
			unsafe { libc::pathconf(c.as_ptr(), libc::_PC_NAME_MAX) }
		},
		Target::Fd(fd) => {
			// SAFETY: `fd` is a descriptor owned by the caller and `buf` is writable.
			cvt(unsafe { libc::fstatfs(*fd, &raw mut buf) })?;
			// SAFETY: plain query on a valid descriptor.
			unsafe { libc::fpathconf(*fd, libc::_PC_NAME_MAX) }
		},
	};
	// SAFETY: `f_fstypename` is a NUL-terminated C string written by `statfs`.
	let name = unsafe { std::ffi::CStr::from_ptr(buf.f_fstypename.as_ptr()) };
	// SAFETY: `fsid_t` is two C ints.
	let fsid: [u32; 2] = unsafe { std::mem::transmute(buf.f_fsid) };
	Ok(StatFs {
		fs_type:          Some(i64::from(buf.f_type)),
		fs_type_name:     Some(name.to_string_lossy().into_owned()),
		block_size:       u64::from(buf.f_bsize),
		io_size:          buf.f_iosize as u64,
		blocks:           buf.f_blocks,
		blocks_free:      buf.f_bfree,
		blocks_available: buf.f_bavail,
		files:            buf.f_files,
		files_free:       buf.f_ffree,
		fsid:             Some(u64::from(fsid[0]) | (u64::from(fsid[1]) << 32)),
		name_max:         u64::try_from(name_max).ok(),
	})
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
fn statfs_impl(target: &Target<'_>) -> io::Result<StatFs> {
	// SAFETY: `statvfs` is a plain C output struct fully written on success.
	let mut buf: libc::statvfs = unsafe { std::mem::zeroed() };
	match target {
		Target::Path(path) => {
			let c = cstr(path)?;
			// SAFETY: `c` is NUL-terminated and `buf` is writable.
			cvt(unsafe { libc::statvfs(c.as_ptr(), &raw mut buf) })?;
		},
		Target::Fd(fd) => {
			// SAFETY: `fd` is a descriptor owned by the caller and `buf` is writable.
			cvt(unsafe { libc::fstatvfs(*fd, &raw mut buf) })?;
		},
	}
	Ok(StatFs {
		fs_type:          None,
		fs_type_name:     None,
		block_size:       buf.f_bsize as u64,
		io_size:          buf.f_frsize as u64,
		blocks:           buf.f_blocks as u64,
		blocks_free:      buf.f_bfree as u64,
		blocks_available: buf.f_bavail as u64,
		files:            buf.f_files as u64,
		files_free:       buf.f_ffree as u64,
		fsid:             Some(buf.f_fsid as u64),
		name_max:         Some(buf.f_namemax as u64),
	})
}
