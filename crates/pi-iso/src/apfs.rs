//! macOS APFS clonefile-based isolation.
//!
//! `clonefile(2)` recursively reflinks an entire directory tree in a single
//! syscall. Both paths share the same on-disk blocks until either side is
//! modified; the kernel handles per-block copy-on-write. The destination is
//! a fully independent directory tree from the caller's perspective — there
//! is no mount to undo, so [`stop`](IsolationBackend::stop) is a recursive
//! remove.

use std::path::{Path, PathBuf};

use async_trait::async_trait;

#[cfg(not(target_os = "macos"))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct ApfsBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&ApfsBackend
}

#[async_trait]
impl IsolationBackend for ApfsBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Apfs
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(target_os = "macos")]
		{
			ProbeResult::available()
		}
		#[cfg(not(target_os = "macos"))]
		{
			ProbeResult::unavailable("APFS clonefile isolation is only available on macOS")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		self.start_with_exclusions(lower, merged, &[])
	}

	fn start_with_exclusions(
		&self,
		lower: &Path,
		merged: &Path,
		exclude_paths: &[PathBuf],
	) -> IsoResult<()> {
		#[cfg(target_os = "macos")]
		{
			imp::start(lower, merged, exclude_paths)
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (lower, merged, exclude_paths);
			Err(IsoError::unavailable("APFS clonefile isolation is only available on macOS"))
		}
	}

	fn clone_tree(&self, lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		#[cfg(target_os = "macos")]
		{
			imp::clone_tree(lower, merged, skip)
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (lower, merged, skip);
			Err(IsoError::unavailable("APFS clonefile isolation is only available on macOS"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "macos")]
		{
			imp::stop(merged)
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(target_os = "macos")]
mod imp {
	use std::{
		fs,
		os::unix::fs::DirBuilderExt as _,
		path::{Path, PathBuf},
	};

	use crate::{
		IsoError, IsoResult,
		cow::{self, CLONE_NOFOLLOW},
		tree,
	};

	/// Classifies a failed `clonefile` of `src` to `dst`.
	fn clone_error(src: &Path, dst: &Path, err: &std::io::Error) -> IsoError {
		if cow::is_unsupported(err) {
			return IsoError::unavailable(format!(
				"APFS clonefile unsupported on this volume ({err}); {} -> {}",
				src.display(),
				dst.display()
			));
		}
		IsoError::other(format!("clonefile {} -> {}: {err}", src.display(), dst.display()))
	}

	pub fn start(lower: &Path, merged: &Path, exclude_paths: &[PathBuf]) -> IsoResult<()> {
		let lower = tree::canonical_existing_dir(lower, "clone source", IsoError::other)?;
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("unable to create parent of {}: {err}", merged.display()))
			})?;
		}
		// `clonefile` refuses to overwrite. Drop any stale tree first.
		if merged.exists() {
			fs::remove_dir_all(merged).map_err(|err| {
				IsoError::other(format!("unable to clear {} before clone: {err}", merged.display()))
			})?;
		}

		if exclude_paths.is_empty() {
			// A directory source clones the whole tree in one call.
			return cow::clonefile(&lower, merged, 0).map_err(|err| clone_error(&lower, merged, &err));
		}

		let result = clone_excluding(&lower, merged, &lower, exclude_paths);
		if result.is_err() {
			let _ = fs::remove_dir_all(merged);
		}
		result
	}

	/// Clone all unaffected branches with one `clonefile` call, descending only
	/// through ancestor directories needed to omit an excluded subtree.
	fn clone_excluding(
		src_dir: &Path,
		dst_dir: &Path,
		root: &Path,
		exclude_paths: &[PathBuf],
	) -> IsoResult<()> {
		let source_permissions = fs::metadata(src_dir)
			.map_err(|err| IsoError::other(format!("metadata {}: {err}", src_dir.display())))?
			.permissions();
		// Ancestors of an excluded subtree cannot use clonefile wholesale. Make
		// each manually materialized directory private before writing children,
		// then restore the source mode only after its contents are complete.
		let mut builder = fs::DirBuilder::new();
		builder.mode(0o700);
		builder
			.create(dst_dir)
			.map_err(|err| IsoError::other(format!("create {}: {err}", dst_dir.display())))?;
		for entry in fs::read_dir(src_dir)
			.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src_dir.display())))?
		{
			let entry = entry
				.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src_dir.display())))?;
			let src = entry.path();
			let relative = src.strip_prefix(root).map_err(|_| {
				IsoError::other(format!(
					"clone path {} escaped source root {}",
					src.display(),
					root.display()
				))
			})?;
			if tree::is_excluded_subtree(relative, exclude_paths) {
				continue;
			}
			let file_type = entry
				.file_type()
				.map_err(|err| IsoError::other(format!("file_type {}: {err}", src.display())))?;
			if !(file_type.is_file() || file_type.is_dir() || file_type.is_symlink()) {
				continue;
			}
			let dst = dst_dir.join(entry.file_name());
			if file_type.is_dir()
				&& exclude_paths
					.iter()
					.any(|excluded| excluded.starts_with(relative))
			{
				clone_excluding(&src, &dst, root, exclude_paths)?;
			} else {
				cow::clonefile(&src, &dst, CLONE_NOFOLLOW)
					.map_err(|err| clone_error(&src, &dst, &err))?;
			}
		}
		fs::set_permissions(dst_dir, source_permissions).map_err(|err| {
			IsoError::other(format!("set permissions on {}: {err}", dst_dir.display()))
		})?;
		Ok(())
	}

	pub fn clone_tree(lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		let lower = tree::canonical_existing_dir(lower, "clone source", IsoError::other)?;
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("unable to create parent of {}: {err}", merged.display()))
			})?;
		}
		if merged.exists() {
			if fs::read_dir(merged)
				.map_err(|err| IsoError::other(format!("read_dir {}: {err}", merged.display())))?
				.next()
				.is_some()
			{
				return Err(IsoError::other(format!(
					"clone destination {} is not empty",
					merged.display()
				)));
			}
		} else {
			fs::create_dir(merged)
				.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
		}

		let result = (|| {
			for entry in fs::read_dir(&lower)
				.map_err(|err| IsoError::other(format!("read_dir {}: {err}", lower.display())))?
			{
				let entry = entry.map_err(|err| {
					IsoError::other(format!("dir entry in {}: {err}", lower.display()))
				})?;
				if skip.contains(&entry.file_name().as_os_str()) {
					continue;
				}
				// `clonefile` only accepts regular files, directories, and
				// symlinks as a top-level source (EINVAL otherwise). Sockets,
				// fifos, and devices are process-owned ephemera — skip them, as
				// the recursive walkers on other platforms do.
				let file_type = entry.file_type().map_err(|err| {
					IsoError::other(format!("file_type {}: {err}", entry.path().display()))
				})?;
				if !(file_type.is_file() || file_type.is_dir() || file_type.is_symlink()) {
					continue;
				}
				let src = entry.path();
				let dst = merged.join(entry.file_name());
				cow::clonefile(&src, &dst, CLONE_NOFOLLOW)
					.map_err(|err| clone_error(&src, &dst, &err))?;
			}
			Ok(())
		})();
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
				"unable to remove cloned tree {}: {err}",
				merged.display()
			))),
		}
	}
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
	use std::{
		ffi::OsStr,
		fs,
		os::unix::{
			ffi::OsStrExt,
			fs::{PermissionsExt, symlink},
		},
		path::PathBuf,
	};

	use super::*;

	#[test]
	fn clone_tree_skips_top_level_entry_and_preserves_symlink() {
		let nonce = format!(
			"pi-iso-clone-tree-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		);
		let root = std::env::temp_dir().join(nonce);
		let lower = root.join("lower");
		let merged = root.join("merged");
		fs::create_dir_all(lower.join("nested")).unwrap();
		fs::create_dir_all(lower.join(".git")).unwrap();
		fs::write(lower.join("file"), "file").unwrap();
		fs::write(lower.join("nested/child"), "child").unwrap();
		fs::write(lower.join(".git/config"), "skip").unwrap();
		symlink("file", lower.join("link")).unwrap();
		// Special files at the checkout root (debug sockets, fifos) are
		// rejected by `clonefile` with EINVAL and must be skipped, not fatal.
		let fifo = std::ffi::CString::new(lower.join("debug.fifo").as_os_str().as_bytes()).unwrap();
		// SAFETY: `fifo` is a valid NUL-terminated path that outlives the call.
		assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

		let result = backend().clone_tree(&lower, &merged, &[OsStr::new(".git")]);
		if matches!(result, Err(crate::IsoError::Unavailable(_))) {
			let _ = fs::remove_dir_all(root);
			return;
		}
		result.unwrap();
		assert!(!merged.join(".git").exists());
		assert!(fs::symlink_metadata(merged.join("debug.fifo")).is_err());
		assert_eq!(fs::read_to_string(merged.join("file")).unwrap(), "file");
		assert_eq!(fs::read_to_string(merged.join("nested/child")).unwrap(), "child");
		assert_eq!(fs::read_link(merged.join("link")).unwrap(), std::path::Path::new("file"));
		assert!(
			fs::symlink_metadata(merged.join("link"))
				.unwrap()
				.file_type()
				.is_symlink()
		);
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn filtered_clone_preserves_private_directory_and_file_modes() {
		let nonce = format!(
			"pi-iso-apfs-filtered-mode-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		);
		let root = std::env::temp_dir().join(nonce);
		let lower = root.join("lower");
		let merged = root.join("merged");
		let private = lower.join("private");
		let ancestor = private.join("ancestor");
		let retained = ancestor.join("retain.txt");
		fs::create_dir_all(ancestor.join("discard")).unwrap();
		fs::write(&retained, "private\n").unwrap();
		fs::set_permissions(&retained, fs::Permissions::from_mode(0o600)).unwrap();
		for directory in [&lower, &private, &ancestor] {
			fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
		}

		let result = backend()
			.start_with_exclusions(&lower, &merged, &[PathBuf::from("private/ancestor/discard")]);
		if matches!(result, Err(crate::IsoError::Unavailable(_))) {
			let _ = fs::remove_dir_all(root);
			return;
		}
		result.unwrap();

		let mode = |path: &std::path::Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode(&lower), 0o700);
		assert_eq!(mode(&merged), 0o700);
		assert_eq!(mode(&merged.join("private/ancestor")), 0o700);
		assert_eq!(mode(&retained), 0o600);
		assert_eq!(mode(&merged.join("private/ancestor/retain.txt")), 0o600);
		assert!(!merged.join("private/ancestor/discard").exists());
		fs::remove_dir_all(root).unwrap();
	}
}
