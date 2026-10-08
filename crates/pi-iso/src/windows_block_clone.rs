//! Windows block-clone based isolation.
//!
//! [`cow`](crate::cow) asks `ReFS` (including Dev
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
		fs::{self, File, FileTimes, FileType, OpenOptions},
		io,
		os::windows::fs::{FileTimesExt, OpenOptionsExt},
		path::Path,
	};

	use windows_sys::Win32::Storage::FileSystem::{
		FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_WRITE_ATTRIBUTES,
	};

	use crate::{
		IsoError, IsoResult, cow,
		tree::{self, TreeCopy},
	};

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		clone_tree(lower, merged, &[])
	}

	pub fn clone_tree(lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		let lower = tree::canonical_existing_dir(lower, "block-clone source", IsoError::other)?;
		tree::prepare_destination(merged, "block clone", remove_path)?;
		let result = (|| {
			fs::create_dir_all(merged)
				.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
			tree::copy_dir_contents(&lower, merged, skip, &BlockClone)?;
			BlockClone.finish_dir(&lower, merged)
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

	fn remove_path(path: &Path) -> io::Result<()> {
		match fs::symlink_metadata(path) {
			Ok(meta) => remove_entry(path, &meta),
			Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(err),
		}
	}

	/// Removes `path`, which `meta` describes. Children are described by their
	/// directory entries, whose metadata comes from the directory listing
	/// without opening each child.
	fn remove_entry(path: &Path, meta: &fs::Metadata) -> io::Result<()> {
		let file_type = meta.file_type();
		if file_type.is_dir() && !file_type.is_symlink() {
			for entry in fs::read_dir(path)? {
				let entry = entry?;
				remove_entry(&entry.path(), &entry.metadata()?)?;
			}
			clear_readonly(path, meta);
			fs::remove_dir(path)
		} else {
			clear_readonly(path, meta);
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

	struct BlockClone;

	impl TreeCopy for BlockClone {
		fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
			tree::copy_symlink(src, dst, file_type)?;
			copy_path_metadata_best_effort(src, dst);
			Ok(())
		}

		fn file(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
			if !file_type.is_file() {
				return Err(IsoError::other(format!(
					"unsupported filesystem entry for block clone: {}",
					src.display()
				)));
			}
			clone_regular_file(src, dst)
		}

		fn finish_dir(&self, src: &Path, dst: &Path) -> IsoResult<()> {
			copy_path_metadata_best_effort(src, dst);
			Ok(())
		}
	}

	/// Clones the regular file `src` into the fresh tree, then gives the clone
	/// `src`'s timestamps and attributes through the handles the clone used.
	fn clone_regular_file(src: &Path, dst: &Path) -> IsoResult<()> {
		let (src_file, dst_file) = cow::clone_new(src, dst).map_err(|err| {
			if cow::is_unsupported(&err) {
				IsoError::unavailable(format!(
					"Windows block clone unsupported for {} -> {}: {err}",
					src.display(),
					dst.display()
				))
			} else {
				IsoError::other(format!("block clone {} -> {}: {err}", src.display(), dst.display()))
			}
		})?;
		if let Ok(meta) = src_file.metadata() {
			copy_metadata_best_effort(&dst_file, &meta);
		}
		Ok(())
	}

	/// Copies the timestamps and attributes of the directory or symlink `src`
	/// onto `dst`, opening each entry itself rather than a link's target.
	fn copy_path_metadata_best_effort(src: &Path, dst: &Path) {
		let Ok(meta) = fs::symlink_metadata(src) else {
			return;
		};
		let Ok(dst) = OpenOptions::new()
			.access_mode(FILE_WRITE_ATTRIBUTES)
			.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
			.open(dst)
		else {
			return;
		};
		copy_metadata_best_effort(&dst, &meta);
	}

	/// Gives the open `dst` the timestamps and, unless `meta` describes a
	/// symlink, the attributes in `meta`.
	fn copy_metadata_best_effort(dst: &File, meta: &fs::Metadata) {
		let mut times = FileTimes::new();
		if let Ok(created) = meta.created() {
			times = times.set_created(created);
		}
		if let Ok(accessed) = meta.accessed() {
			times = times.set_accessed(accessed);
		}
		if let Ok(modified) = meta.modified() {
			times = times.set_modified(modified);
		}
		let _ = dst.set_times(times);
		if !meta.file_type().is_symlink() {
			let _ = dst.set_permissions(meta.permissions());
		}
	}
}
