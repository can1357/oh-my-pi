//! Helpers shared by the backends that materialize `merged` as a real
//! directory tree (rcopy, Linux reflink, Windows block clone) and by the
//! backends that validate a `lower` source directory.

use std::{
	ffi::OsStr,
	fs::{self, FileType},
	io,
	path::{Path, PathBuf},
};

use crate::{IsoError, IsoResult};

/// Resolves `path` against the current directory, checks that it is a
/// directory, and canonicalizes it when possible. `what` names the source in
/// error messages; `make_err` picks the error class, since some backends
/// report a bad source as unavailable so the caller falls back.
pub fn canonical_existing_dir(
	path: &Path,
	what: &str,
	make_err: fn(String) -> IsoError,
) -> IsoResult<PathBuf> {
	let resolved = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
	let meta = fs::metadata(&resolved)
		.map_err(|err| make_err(format!("invalid {what} {}: {err}", resolved.display())))?;
	if !meta.is_dir() {
		return Err(make_err(format!("{what} {} is not a directory", resolved.display())));
	}
	Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
}

/// Creates `merged`'s parent and clears whatever is at `merged` with `remove`,
/// so the walk starts from a fresh destination. `what` names the backend in
/// the error message.
pub fn prepare_destination(
	merged: &Path,
	what: &str,
	remove: impl FnOnce(&Path) -> io::Result<()>,
) -> IsoResult<()> {
	if let Some(parent) = merged.parent() {
		fs::create_dir_all(parent)
			.map_err(|err| IsoError::other(format!("create parent of {}: {err}", merged.display())))?;
	}
	remove(merged).map_err(|err| {
		IsoError::other(format!("unable to clear {} before {what}: {err}", merged.display()))
	})
}

/// Removes the directory tree, file, or symlink at `path`; a missing path is
/// not an error.
pub fn remove_existing(path: &Path) -> io::Result<()> {
	let result = match fs::symlink_metadata(path) {
		Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
		Ok(_) => fs::remove_file(path),
		Err(err) => Err(err),
	};
	match result {
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
		other => other,
	}
}

/// Recreates the symlink `src` at `dst` with the same target. `file_type` is
/// `src`'s own (unfollowed) type; Windows needs it to pick a directory or
/// file link.
pub fn copy_symlink(src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
	let target = fs::read_link(src)
		.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
	#[cfg(unix)]
	let res = {
		let _ = file_type;
		std::os::unix::fs::symlink(target, dst)
	};
	#[cfg(windows)]
	let res = if std::os::windows::fs::FileTypeExt::is_symlink_dir(&file_type) {
		std::os::windows::fs::symlink_dir(target, dst)
	} else {
		std::os::windows::fs::symlink_file(target, dst)
	};
	#[cfg(not(any(unix, windows)))]
	let res: io::Result<()> = {
		let _ = (target, file_type);
		Err(io::Error::new(io::ErrorKind::Unsupported, "symlink copy unsupported on this platform"))
	};
	res.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))
}

/// Per-entry actions of [`copy_dir_contents`].
pub trait TreeCopy {
	/// Recreates the symlink `src` at `dst`.
	fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Copies any entry that is neither a directory nor a symlink.
	fn file(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Runs after the directory `dst` has been filled from `src`.
	fn finish_dir(&self, src: &Path, dst: &Path) -> IsoResult<()>;
}

/// Copies the entries of the directory `src` into the existing directory
/// `dst`, recursing into subdirectories. Top-level entries named in `skip` are
/// left out; the dispatch uses the directory listing's file types, so
/// symlinks are never followed.
pub fn copy_dir_contents(
	src: &Path,
	dst: &Path,
	skip: &[&OsStr],
	copy: &impl TreeCopy,
) -> IsoResult<()> {
	let entries = fs::read_dir(src)
		.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?;
	for entry in entries {
		let entry =
			entry.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
		let name = entry.file_name();
		if skip.contains(&name.as_os_str()) {
			continue;
		}
		let src_path = entry.path();
		let file_type = entry
			.file_type()
			.map_err(|err| IsoError::other(format!("file_type {}: {err}", src_path.display())))?;
		let dst_path = dst.join(&name);
		if file_type.is_symlink() {
			copy.symlink(&src_path, &dst_path, file_type)?;
		} else if file_type.is_dir() {
			fs::create_dir_all(&dst_path)
				.map_err(|err| IsoError::other(format!("create {}: {err}", dst_path.display())))?;
			copy_dir_contents(&src_path, &dst_path, &[], copy)?;
			copy.finish_dir(&src_path, &dst_path)?;
		} else {
			copy.file(&src_path, &dst_path, file_type)?;
		}
	}
	Ok(())
}
