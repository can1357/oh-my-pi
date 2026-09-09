//! Linux FICLONE-based copy-on-write tree materialisation.
//!
//! This backend recursively builds a writable directory tree at `merged` from
//! `lower`. Directories and symlinks are recreated, while regular files are
//! cloned with the Linux `FICLONE` ioctl so filesystems such as btrfs, XFS,
//! OCFS2, and bcachefs can share extents until either side is modified. There
//! is no mount or kernel state to undo, so [`stop`](IsolationBackend::stop) is
//! a recursive remove.

use std::path::Path;

use async_trait::async_trait;

#[cfg(not(target_os = "linux"))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct LinuxReflinkBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&LinuxReflinkBackend
}

#[async_trait]
impl IsolationBackend for LinuxReflinkBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::LinuxReflink
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(target_os = "linux")]
		{
			ProbeResult::available()
		}
		#[cfg(not(target_os = "linux"))]
		{
			ProbeResult::unavailable("Linux FICLONE reflink isolation is only available on Linux")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::start(lower, merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("Linux FICLONE reflink isolation is only available on Linux"))
		}
	}

	fn clone_tree(&self, lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::clone_tree(lower, merged, skip)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (lower, merged, skip);
			Err(IsoError::unavailable("Linux FICLONE reflink isolation is only available on Linux"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::stop(merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(target_os = "linux")]
mod imp {
	use std::{
		ffi::CString,
		fs::{self, File, OpenOptions},
		os::{
			fd::AsRawFd,
			unix::{
				ffi::OsStrExt,
				fs::{MetadataExt, PermissionsExt},
			},
		},
		path::{Path, PathBuf},
	};

	use crate::{IsoError, IsoResult};

	// `libc::Ioctl` is `c_int` on musl and `c_ulong` on glibc; the constant fits
	// both.
	const FICLONE: libc::Ioctl = 0x4004_9409;

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		prepare_destination(merged)?;

		let result = recursive_reflink(&lower, merged, None);
		if result.is_err() {
			let _ = fs::remove_dir_all(merged);
		}
		result
	}

	pub fn clone_tree(lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		prepare_destination(merged)?;
		let result = recursive_reflink(&lower, merged, Some(skip));
		if result.is_err() {
			let _ = fs::remove_dir_all(merged);
		}
		result
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		match fs::remove_dir_all(merged) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!(
				"unable to remove reflink tree {}: {err}",
				merged.display()
			))),
		}
	}

	fn canonical_existing_dir(path: &Path) -> IsoResult<PathBuf> {
		let resolved = if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
		};
		let meta = fs::metadata(&resolved).map_err(|err| {
			IsoError::other(format!("invalid reflink source {}: {err}", resolved.display()))
		})?;
		if !meta.is_dir() {
			return Err(IsoError::other(format!(
				"reflink source {} is not a directory",
				resolved.display()
			)));
		}
		Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
	}

	fn prepare_destination(merged: &Path) -> IsoResult<()> {
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("create parent of {}: {err}", merged.display()))
			})?;
		}
		match fs::symlink_metadata(merged) {
			Ok(meta) if meta.is_dir() => fs::remove_dir_all(merged).map_err(|err| {
				IsoError::other(format!(
					"unable to clear {} before reflink clone: {err}",
					merged.display()
				))
			})?,
			Ok(_) => fs::remove_file(merged).map_err(|err| {
				IsoError::other(format!(
					"unable to clear {} before reflink clone: {err}",
					merged.display()
				))
			})?,
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
			Err(err) => {
				return Err(IsoError::other(format!(
					"unable to inspect {} before reflink clone: {err}",
					merged.display()
				)));
			},
		}
		Ok(())
	}

	fn recursive_reflink(
		src: &Path,
		dst: &Path,
		skip: Option<&[&std::ffi::OsStr]>,
	) -> IsoResult<()> {
		let meta = fs::symlink_metadata(src)
			.map_err(|err| IsoError::other(format!("symlink_metadata {}: {err}", src.display())))?;
		fs::create_dir(dst)
			.map_err(|err| IsoError::other(format!("create {}: {err}", dst.display())))?;

		let entries = fs::read_dir(src)
			.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?;
		for entry in entries {
			let entry = entry
				.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
			if skip.is_some_and(|names| names.contains(&entry.file_name().as_os_str())) {
				continue;
			}
			let file_type = entry.file_type().map_err(|err| {
				IsoError::other(format!("file_type {}: {err}", entry.path().display()))
			})?;
			let src_path = entry.path();
			let dst_path = dst.join(entry.file_name());
			if file_type.is_symlink() {
				clone_symlink(&src_path, &dst_path)?;
			} else if file_type.is_dir() {
				recursive_reflink(&src_path, &dst_path, None)?;
			} else if file_type.is_file() {
				clone_file(&src_path, &dst_path)?;
			} else {
				return Err(IsoError::other(format!(
					"unsupported file type in reflink source: {}",
					src_path.display()
				)));
			}
		}

		preserve_permissions(dst, &meta)?;
		let _ = set_times_nofollow(dst, &meta);
		Ok(())
	}

	fn clone_symlink(src: &Path, dst: &Path) -> IsoResult<()> {
		let target = fs::read_link(src)
			.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
		std::os::unix::fs::symlink(target, dst)
			.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))?;
		if let Ok(meta) = fs::symlink_metadata(src) {
			let _ = set_times_nofollow(dst, &meta);
		}
		Ok(())
	}

	fn clone_file(src: &Path, dst: &Path) -> IsoResult<()> {
		let meta = fs::symlink_metadata(src)
			.map_err(|err| IsoError::other(format!("symlink_metadata {}: {err}", src.display())))?;
		let src_file = File::open(src)
			.map_err(|err| IsoError::other(format!("open {}: {err}", src.display())))?;
		let dst_file = OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(dst)
			.map_err(|err| IsoError::other(format!("create {}: {err}", dst.display())))?;

		// SAFETY: both file descriptors are valid for the duration of the call.
		// FICLONE copies metadata into `dst_file` and does not retain either fd.
		let rc = unsafe { libc::ioctl(dst_file.as_raw_fd(), FICLONE, src_file.as_raw_fd()) };
		if rc != 0 {
			let err = std::io::Error::last_os_error();
			let _ = fs::remove_file(dst);
			return Err(map_clone_error(src, dst, err));
		}

		preserve_permissions(dst, &meta)?;
		let _ = set_times_nofollow(dst, &meta);
		Ok(())
	}

	fn map_clone_error(src: &Path, dst: &Path, err: std::io::Error) -> IsoError {
		if let Some(code) = err.raw_os_error()
			&& matches!(
				code,
				libc::EXDEV | libc::EOPNOTSUPP | libc::ENOTTY | libc::EINVAL | libc::ENOSYS
			) {
			return IsoError::unavailable(format!(
				"FICLONE unsupported for {} -> {}: {err}",
				src.display(),
				dst.display()
			));
		}
		IsoError::other(format!("FICLONE {} -> {}: {err}", src.display(), dst.display()))
	}

	fn preserve_permissions(path: &Path, meta: &fs::Metadata) -> IsoResult<()> {
		let mode = meta.permissions().mode();
		fs::set_permissions(path, fs::Permissions::from_mode(mode))
			.map_err(|err| IsoError::other(format!("set permissions on {}: {err}", path.display())))
	}

	fn set_times_nofollow(path: &Path, meta: &fs::Metadata) -> std::io::Result<()> {
		let times = [
			libc::timespec { tv_sec: meta.atime() as _, tv_nsec: meta.atime_nsec() as libc::c_long },
			libc::timespec { tv_sec: meta.mtime() as _, tv_nsec: meta.mtime_nsec() as libc::c_long },
		];
		let c_path = CString::new(path.as_os_str().as_bytes())?;
		// SAFETY: `c_path` and `times` live until the syscall returns; the
		// kernel does not retain either pointer. AT_SYMLINK_NOFOLLOW preserves
		// symlink timestamps instead of mutating the link target.
		let rc = unsafe {
			libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW)
		};
		if rc == 0 {
			Ok(())
		} else {
			Err(std::io::Error::last_os_error())
		}
	}
}
