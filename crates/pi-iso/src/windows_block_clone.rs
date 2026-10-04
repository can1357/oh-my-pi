//! Windows block-clone based isolation.
//!
//! [`cow::clone_file`](crate::cow::clone_file) asks `ReFS` (including Dev
//! Drive) to share file extents copy-on-write between a source file and a
//! destination file; other filesystems such as NTFS reject it, which surfaces
//! as [`IsoError::unavailable`](crate::IsoError). The backend
//! recursively materializes the directory tree and block-clones each regular
//! file. There is no mount/session state to undo, so
//! [`stop`](IsolationBackend::stop) is a recursive remove.

use std::path::Path;

use async_trait::async_trait;

#[cfg(not(windows))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct WindowsBlockCloneBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&WindowsBlockCloneBackend
}

#[async_trait]
impl IsolationBackend for WindowsBlockCloneBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::WindowsBlockClone
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(windows)]
		{
			ProbeResult::available()
		}
		#[cfg(not(windows))]
		{
			ProbeResult::unavailable("Windows block-clone isolation is only available on Windows")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(windows)]
		{
			imp::start(lower, merged)
		}
		#[cfg(not(windows))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("Windows block-clone isolation is only available on Windows"))
		}
	}

	fn clone_tree(&self, lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		#[cfg(windows)]
		{
			imp::clone_tree(lower, merged, skip)
		}
		#[cfg(not(windows))]
		{
			let _ = (lower, merged, skip);
			Err(IsoError::unavailable("Windows block-clone isolation is only available on Windows"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(windows)]
		{
			imp::stop(merged)
		}
		#[cfg(not(windows))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(windows)]
mod imp {
	use std::{
		fs::{self, OpenOptions},
		io,
		os::windows::{
			fs::{FileTypeExt, OpenOptionsExt},
			io::AsRawHandle,
		},
		path::{Path, PathBuf},
	};

	use windows_sys::Win32::{
		Foundation::FILETIME,
		Storage::FileSystem::{
			FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, SetFileTime,
		},
	};

	use crate::{IsoError, IsoResult, cow};

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		prepare_destination(merged)?;

		let result = recursive_block_clone(&lower, merged);
		if result.is_err() {
			let _ = remove_path(merged);
		}
		result
	}

	pub fn clone_tree(lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		prepare_destination(merged)?;
		let result = (|| {
			fs::create_dir_all(merged)
				.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
			clone_dir_contents(&lower, merged, Some(skip))?;
			copy_metadata_best_effort(&lower, merged);
			Ok(())
		})();
		if result.is_err() {
			let _ = remove_path(merged);
		}
		result
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		remove_path(merged).map_err(|err| {
			IsoError::other(format!("unable to remove block-cloned tree {}: {err}", merged.display()))
		})
	}

	fn canonical_existing_dir(path: &Path) -> IsoResult<PathBuf> {
		let resolved = if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
		};
		let meta = fs::metadata(&resolved).map_err(|err| {
			IsoError::other(format!("invalid block-clone source {}: {err}", resolved.display()))
		})?;
		if !meta.is_dir() {
			return Err(IsoError::other(format!(
				"block-clone source {} is not a directory",
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
		remove_path(merged).map_err(|err| {
			IsoError::other(format!("unable to clear {} before block clone: {err}", merged.display()))
		})?;
		Ok(())
	}

	fn remove_path(path: &Path) -> io::Result<()> {
		let meta = match fs::symlink_metadata(path) {
			Ok(meta) => meta,
			Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
			Err(err) => return Err(err),
		};
		let file_type = meta.file_type();
		if file_type.is_dir() && !file_type.is_symlink() {
			for entry in fs::read_dir(path)? {
				remove_path(&entry?.path())?;
			}
			clear_readonly(path, &meta);
			fs::remove_dir(path)
		} else {
			clear_readonly(path, &meta);
			fs::remove_file(path)
		}
	}

	fn clear_readonly(path: &Path, meta: &fs::Metadata) {
		if meta.file_type().is_symlink() {
			return;
		}
		let mut permissions = meta.permissions();
		if permissions.readonly() {
			// This backend only removes a temporary Windows block-clone tree;
			// clearing the readonly file attribute is required so removal can
			// proceed.
			#[allow(
				clippy::permissions_set_readonly_false,
				reason = "Windows block-clone cleanup must clear the readonly file attribute before \
				          deletion"
			)]
			permissions.set_readonly(false);
			let _ = fs::set_permissions(path, permissions);
		}
	}

	fn recursive_block_clone(lower: &Path, merged: &Path) -> IsoResult<()> {
		fs::create_dir_all(merged)
			.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
		clone_dir_contents(lower, merged, None)?;
		copy_metadata_best_effort(lower, merged);
		Ok(())
	}

	fn clone_dir_contents(
		src: &Path,
		dst: &Path,
		skip: Option<&[&std::ffi::OsStr]>,
	) -> IsoResult<()> {
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
				copy_metadata_best_effort(&src_path, &dst_path);
			} else if file_type.is_dir() {
				fs::create_dir_all(&dst_path)
					.map_err(|err| IsoError::other(format!("create {}: {err}", dst_path.display())))?;
				clone_dir_contents(&src_path, &dst_path, None)?;
				copy_metadata_best_effort(&src_path, &dst_path);
			} else if file_type.is_file() {
				clone_regular_file(&src_path, &dst_path)?;
				copy_metadata_best_effort(&src_path, &dst_path);
			} else {
				return Err(IsoError::other(format!(
					"unsupported filesystem entry for block clone: {}",
					src_path.display()
				)));
			}
		}
		Ok(())
	}

	fn clone_symlink(src: &Path, dst: &Path) -> IsoResult<()> {
		let target = fs::read_link(src)
			.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
		let file_type = fs::symlink_metadata(src)
			.map_err(|err| IsoError::other(format!("symlink_metadata {}: {err}", src.display())))?
			.file_type();
		let res = if file_type.is_symlink_dir() {
			std::os::windows::fs::symlink_dir(target, dst)
		} else {
			std::os::windows::fs::symlink_file(target, dst)
		};
		res.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))
	}

	fn clone_regular_file(src: &Path, dst: &Path) -> IsoResult<()> {
		let Err(err) = cow::clone_file(src, dst) else {
			return Ok(());
		};
		if cow::is_unsupported(&err) {
			Err(IsoError::unavailable(format!(
				"Windows block clone unsupported for {} -> {}: {err}",
				src.display(),
				dst.display()
			)))
		} else {
			Err(IsoError::other(format!("block clone {} -> {}: {err}", src.display(), dst.display())))
		}
	}

	fn copy_metadata_best_effort(src: &Path, dst: &Path) {
		let Ok(meta) = fs::symlink_metadata(src) else {
			return;
		};
		set_times_best_effort(dst, &meta);
		if !meta.file_type().is_symlink() {
			let _ = fs::set_permissions(dst, meta.permissions());
		}
	}

	fn set_times_best_effort(path: &Path, meta: &fs::Metadata) {
		let created = meta.created().ok().and_then(system_time_to_filetime);
		let accessed = meta.accessed().ok().and_then(system_time_to_filetime);
		let modified = meta.modified().ok().and_then(system_time_to_filetime);
		if created.is_none() && accessed.is_none() && modified.is_none() {
			return;
		}

		let mut opts = OpenOptions::new();
		opts.write(true);
		opts.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
		let Ok(file) = opts.open(path) else { return };
		// SAFETY: `file` owns the HANDLE for the duration of the call. The
		// optional FILETIME pointers either reference stack locals that outlive
		// the call or are null when the corresponding timestamp is unavailable.
		let _ = unsafe {
			SetFileTime(
				file.as_raw_handle() as _,
				created
					.as_ref()
					.map_or(std::ptr::null(), |ft| ft as *const FILETIME),
				accessed
					.as_ref()
					.map_or(std::ptr::null(), |ft| ft as *const FILETIME),
				modified
					.as_ref()
					.map_or(std::ptr::null(), |ft| ft as *const FILETIME),
			)
		};
	}

	fn system_time_to_filetime(time: std::time::SystemTime) -> Option<FILETIME> {
		let dur = time.duration_since(std::time::UNIX_EPOCH).ok()?;
		// Windows FILETIME = 100-ns ticks since 1601-01-01.
		const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
		let ticks = EPOCH_DIFF_100NS
			.checked_add(dur.as_secs().checked_mul(10_000_000)?)?
			.checked_add(u64::from(dur.subsec_nanos() / 100))?;
		Some(FILETIME {
			dwLowDateTime:  (ticks & 0xffff_ffff) as u32,
			dwHighDateTime: (ticks >> 32) as u32,
		})
	}
}
