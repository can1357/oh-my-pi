//! Worktree writes that do not follow symlinks.
//!
//! `open` and `create_dir_all` follow every directory component. A tracked path
//! whose worktree entry — or any parent — is a symlink would otherwise be
//! written or removed outside the repository. Git restores the link itself and
//! replaces a symlink that stands where a directory must be; these helpers do
//! the same, from a directory descriptor so a later component cannot escape.

use std::{ffi::CString, io, path::Path};

use crate::Result;

/// Bytes to place at a worktree path. Symlink targets are the raw blob, never
/// a smudge-filter conversion.
pub(super) enum MaterializedEntry<'a> {
	File { bytes: &'a [u8], executable: bool },
	Symlink { target: &'a [u8], enabled: bool },
}

/// Write `entry` at repo-relative `path` under `root`.
///
/// A symlink in a parent component is replaced with a real directory before
/// the leaf is created, and an existing symlink at the leaf is unlinked rather
/// than opened. Link-target bytes are stored as given.
pub(super) fn materialize_worktree_entry(
	root: &Path,
	path: &str,
	entry: MaterializedEntry<'_>,
) -> Result<()> {
	let parts = split_relative(path)?;
	#[cfg(unix)]
	{
		unix::materialize(root, &parts, entry)
	}
	#[cfg(not(unix))]
	{
		portable::materialize(root, &parts, entry)
	}
}

/// Unlink the file or symlink at repo-relative `path` without following it or
/// any parent. A real directory is an error, matching `remove_file`.
pub(super) fn unlink_worktree_leaf(root: &Path, path: &str) -> Result<()> {
	let parts = split_relative(path)?;
	#[cfg(unix)]
	{
		unix::unlink_leaf(root, &parts)
	}
	#[cfg(not(unix))]
	{
		portable::unlink_leaf(root, &parts)
	}
}

/// Remove the leaf at repo-relative `path`, then prune empty parents. A real
/// directory leaf is removed only when empty. Missing leaves and parents are
/// left alone, and all removals stay relative to open no-follow directories.
pub(super) fn remove_worktree_path(root: &Path, path: &str) -> Result<()> {
	let parts = split_relative(path)?;
	#[cfg(unix)]
	{
		unix::remove_path(root, &parts)
	}
	#[cfg(not(unix))]
	{
		portable::remove_path(root, &parts)
	}
}

/// Create repo-relative `path` as a real directory, replacing a symlink that
/// blocks it or any parent. An existing real directory is left untouched.
pub(super) fn ensure_worktree_directory(root: &Path, path: &str) -> Result<()> {
	let parts = split_relative(path)?;
	#[cfg(unix)]
	{
		unix::ensure_directory(root, &parts)
	}
	#[cfg(not(unix))]
	{
		portable::ensure_directory(root, &parts)
	}
}

fn split_relative(path: &str) -> io::Result<Vec<&str>> {
	if path.is_empty() || path.as_bytes().first() == Some(&b'/') {
		return Err(invalid_path(path));
	}
	let mut parts = Vec::new();
	for part in path.split('/') {
		if part.is_empty() || part == "." {
			continue;
		}
		if part == ".." || part.contains('\0') {
			return Err(invalid_path(path));
		}
		parts.push(part);
	}
	if parts.is_empty() {
		return Err(invalid_path(path));
	}
	Ok(parts)
}

fn invalid_path(path: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, format!("unsafe worktree path: {path}"))
}

fn c_name(name: &str) -> io::Result<CString> {
	CString::new(name.as_bytes()).map_err(|_| invalid_path(name))
}

#[cfg(unix)]
mod unix {
	use std::{
		ffi::{CStr, CString},
		fs::File,
		io::{self, Write},
		os::{
			fd::{AsRawFd, FromRawFd, OwnedFd},
			unix::fs::{OpenOptionsExt, PermissionsExt},
		},
		path::Path,
	};

	use super::{MaterializedEntry, c_name};

	pub(super) fn materialize(
		root: &Path,
		parts: &[&str],
		entry: MaterializedEntry<'_>,
	) -> crate::Result<()> {
		with_leaf(root, parts, |dir, leaf| match entry {
			MaterializedEntry::Symlink { target, enabled: true } => create_symlink(dir, leaf, target),
			MaterializedEntry::Symlink { target, enabled: false } => {
				write_file(dir, leaf, target, false)
			},
			MaterializedEntry::File { bytes, executable } => write_file(dir, leaf, bytes, executable),
		})
	}

	pub(super) fn unlink_leaf(root: &Path, parts: &[&str]) -> crate::Result<()> {
		let (leaf, parents) = parts.split_last().ok_or_else(invalid)?;
		let Some(dir) = removal_parent(root, parents)? else {
			return Ok(());
		};
		let leaf = c_name(leaf)?;
		match symlink_kind(&dir, &leaf)? {
			Kind::Missing => Ok(()),
			Kind::Directory => Err(io::Error::from_raw_os_error(libc::EISDIR).into()),
			Kind::Other => unlink_at(&dir, &leaf).map_err(Into::into),
		}
	}

	pub(super) fn remove_path(root: &Path, parts: &[&str]) -> crate::Result<()> {
		let (leaf, parents) = parts.split_last().ok_or_else(invalid)?;
		let mut directories = Vec::with_capacity(parents.len() + 1);
		directories.push(open_root(root)?);
		for parent in parents {
			let name = c_name(parent)?;
			let dir = directories.last().expect("the root is always open");
			match open_subdir(dir, &name) {
				Ok(child) => directories.push(child),
				Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
				Err(_) if is_symlink(dir, &name)? => {
					unlink_at(dir, &name)?;
					return Ok(());
				},
				Err(err) if err.raw_os_error() == Some(libc::ENOTDIR) => return Ok(()),
				Err(err) => return Err(err.into()),
			}
		}
		let leaf = c_name(leaf)?;
		{
			let dir = directories.last().expect("the root is always open");
			match symlink_kind(dir, &leaf)? {
				Kind::Missing => return Ok(()),
				Kind::Directory => {
					if remove_dir_at(dir, &leaf).is_err() {
						return Ok(());
					}
				},
				Kind::Other => unlink_at(dir, &leaf)?,
			}
		}
		for parent in parents.iter().rev() {
			drop(directories.pop());
			let dir = directories.last().expect("the root remains open");
			if remove_dir_at(dir, &c_name(parent)?).is_err() {
				break;
			}
		}
		Ok(())
	}

	pub(super) fn ensure_directory(root: &Path, parts: &[&str]) -> crate::Result<()> {
		with_leaf(root, parts, |dir, leaf| ensure_subdir(dir, leaf).map(drop))
	}

	fn with_leaf<T>(
		root: &Path,
		parts: &[&str],
		op: impl FnOnce(&OwnedFd, &CStr) -> io::Result<T>,
	) -> crate::Result<T> {
		let (leaf, parents) = parts.split_last().ok_or_else(invalid)?;
		let mut dir = open_root(root)?;
		for parent in parents {
			dir = ensure_subdir(&dir, &c_name(parent)?)?;
		}
		op(&dir, &c_name(leaf)?).map_err(Into::into)
	}

	fn invalid() -> io::Error {
		io::Error::new(io::ErrorKind::InvalidInput, "unsafe worktree path")
	}

	fn open_root(root: &Path) -> io::Result<OwnedFd> {
		let file = std::fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
			.open(root)?;
		Ok(OwnedFd::from(file))
	}

	fn ensure_subdir(parent: &OwnedFd, name: &CStr) -> io::Result<OwnedFd> {
		match open_subdir(parent, name) {
			Ok(child) => Ok(child),
			Err(err) if err.kind() == io::ErrorKind::NotFound => {
				mkdir_at(parent, name)?;
				open_subdir(parent, name)
			},
			Err(_) if is_symlink(parent, name)? => {
				unlink_at(parent, name)?;
				mkdir_at(parent, name)?;
				open_subdir(parent, name)
			},
			Err(err) => Err(err),
		}
	}

	/// Find a leaf's real parent without creating anything. A symlink parent is
	/// unlinked, since following it could remove a file outside the worktree;
	/// a missing or non-directory parent means the leaf is already absent.
	fn removal_parent(root: &Path, parents: &[&str]) -> io::Result<Option<OwnedFd>> {
		let mut dir = open_root(root)?;
		for parent in parents {
			let name = c_name(parent)?;
			match open_subdir(&dir, &name) {
				Ok(child) => dir = child,
				Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
				Err(_) if is_symlink(&dir, &name)? => {
					unlink_at(&dir, &name)?;
					return Ok(None);
				},
				Err(err) if err.raw_os_error() == Some(libc::ENOTDIR) => return Ok(None),
				Err(err) => return Err(err),
			}
		}
		Ok(Some(dir))
	}

	fn write_file(dir: &OwnedFd, leaf: &CStr, bytes: &[u8], executable: bool) -> io::Result<()> {
		let (fd, existed) = create_file(dir, leaf, executable)?;
		let mut file = File::from(fd);
		file.write_all(bytes)?;
		if existed {
			// Keep private files private and preserve read/write bits. Only the
			// executable state follows the index. New files already got their
			// mode from openat, so the process umask remains in effect.
			let mode = file.metadata()?.permissions().mode() & 0o7777;
			let desired = if executable {
				mode | ((mode & 0o444) >> 2)
			} else {
				mode & !0o111
			};
			if desired != mode {
				file.set_permissions(std::fs::Permissions::from_mode(desired))?;
			}
		}
		Ok(())
	}

	fn is_symlink(parent: &OwnedFd, name: &CStr) -> io::Result<bool> {
		Ok(matches!(stat_mode(parent, name)?, Some(mode) if (mode & libc::S_IFMT) == libc::S_IFLNK))
	}

	fn symlink_kind(parent: &OwnedFd, name: &CStr) -> io::Result<Kind> {
		Ok(match stat_mode(parent, name)? {
			None => Kind::Missing,
			Some(mode) if (mode & libc::S_IFMT) == libc::S_IFDIR => Kind::Directory,
			Some(_) => Kind::Other,
		})
	}

	fn stat_mode(parent: &OwnedFd, name: &CStr) -> io::Result<Option<libc::mode_t>> {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		let rc = retry(|| {
			// SAFETY: `name` is a NUL-terminated path component, `parent` is an
			// open directory, and `stat` is a valid out-buffer for this call.
			unsafe {
				libc::fstatat(
					parent.as_raw_fd(),
					name.as_ptr(),
					stat.as_mut_ptr(),
					libc::AT_SYMLINK_NOFOLLOW,
				)
			}
		});
		match rc {
			Ok(_) => {
				// SAFETY: fstatat succeeded, so `stat` is initialized.
				Ok(Some(unsafe { stat.assume_init() }.st_mode))
			},
			Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
			Err(err) => Err(err),
		}
	}

	fn open_subdir(parent: &OwnedFd, name: &CStr) -> io::Result<OwnedFd> {
		openat(
			parent,
			name,
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
			0,
		)
	}

	fn create_file(parent: &OwnedFd, name: &CStr, executable: bool) -> io::Result<(OwnedFd, bool)> {
		let flags =
			libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_CLOEXEC;
		let existed =
			stat_mode(parent, name)?.is_some_and(|mode| (mode & libc::S_IFMT) == libc::S_IFREG);
		let mode = if executable { 0o777 } else { 0o666 };
		match openat(parent, name, flags, mode) {
			Ok(file) => Ok((file, existed)),
			Err(err) if nofollow_hit(&err) || is_symlink(parent, name).unwrap_or(false) => {
				unlink_at(parent, name)?;
				openat(parent, name, flags, mode).map(|file| (file, false))
			},
			Err(err) => Err(err),
		}
	}

	fn create_symlink(parent: &OwnedFd, name: &CStr, target: &[u8]) -> io::Result<()> {
		match unlink_at(parent, name) {
			Ok(()) => {},
			Err(err) if err.kind() == io::ErrorKind::NotFound => {},
			Err(err) => return Err(err),
		}
		let target = CString::new(target)
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "symlink target contains NUL"))?;
		retry(|| {
			// SAFETY: both strings are NUL-terminated and `parent` is an open
			// directory.
			unsafe { libc::symlinkat(target.as_ptr(), parent.as_raw_fd(), name.as_ptr()) }
		})
		.map(|_| ())
	}

	fn unlink_at(parent: &OwnedFd, name: &CStr) -> io::Result<()> {
		retry(|| {
			// SAFETY: `name` is a NUL-terminated component of `parent`. The flag
			// is 0, so a directory is not removed and a symlink is not followed.
			unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) }
		})
		.map(|_| ())
	}

	fn remove_dir_at(parent: &OwnedFd, name: &CStr) -> io::Result<()> {
		retry(|| {
			// SAFETY: `name` is a NUL-terminated component of `parent`.
			// AT_REMOVEDIR removes only an empty directory and never follows a
			// symlink at the leaf.
			unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
		})
		.map(|_| ())
	}

	fn mkdir_at(parent: &OwnedFd, name: &CStr) -> io::Result<()> {
		match retry(|| {
			// SAFETY: `name` is a NUL-terminated component of `parent`.
			unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o777) }
		}) {
			Ok(_) => Ok(()),
			Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Ok(()),
			Err(err) => Err(err),
		}
	}

	fn openat(
		parent: &OwnedFd,
		name: &CStr,
		flags: libc::c_int,
		mode: libc::c_uint,
	) -> io::Result<OwnedFd> {
		let fd = retry(|| {
			// SAFETY: `name` is a NUL-terminated component of `parent`. `mode` is
			// only read when `flags` contains `O_CREAT`, which callers set then.
			unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, mode) }
		})?;
		// SAFETY: `openat` returned a new descriptor that this call owns.
		Ok(unsafe { OwnedFd::from_raw_fd(fd) })
	}

	fn retry(mut op: impl FnMut() -> libc::c_int) -> io::Result<libc::c_int> {
		loop {
			let rc = op();
			if rc >= 0 {
				return Ok(rc);
			}
			let err = io::Error::last_os_error();
			if err.kind() != io::ErrorKind::Interrupted {
				return Err(err);
			}
		}
	}

	fn nofollow_hit(err: &io::Error) -> bool {
		matches!(err.raw_os_error(), Some(code) if code == libc::ELOOP)
	}

	enum Kind {
		Missing,
		Directory,
		Other,
	}
}

#[cfg(not(unix))]
mod portable {
	#[cfg(windows)]
	use std::os::windows::io::AsRawHandle;
	use std::{
		io::{self, Write},
		path::Path,
	};

	use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
	#[cfg(windows)]
	use cap_std::fs::OpenOptionsExt;
	use cap_std::{
		ambient_authority,
		fs::{Dir, OpenOptions},
	};
	#[cfg(windows)]
	use windows_sys::Win32::Storage::FileSystem::{
		DELETE, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
		FileDispositionInfo, SetFileInformationByHandle,
	};

	use super::MaterializedEntry;

	pub(super) fn materialize(
		root: &Path,
		parts: &[&str],
		entry: MaterializedEntry<'_>,
	) -> crate::Result<()> {
		let (leaf, parents) = parts.split_last().expect("split rejects an empty path");
		let dir = ensure_parents(root, parents)?;
		let bytes = match entry {
			MaterializedEntry::File { bytes, .. } => bytes,
			MaterializedEntry::Symlink { target, .. } => target,
		};
		write_file(&dir, leaf, bytes)?;
		Ok(())
	}

	pub(super) fn unlink_leaf(root: &Path, parts: &[&str]) -> crate::Result<()> {
		let (leaf, parents) = parts.split_last().expect("split rejects an empty path");
		let Some(dir) = removal_parent(root, parents)? else {
			return Ok(());
		};
		match dir.symlink_metadata(leaf) {
			Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
				Err(io::Error::new(io::ErrorKind::IsADirectory, "worktree leaf is a directory").into())
			},
			Ok(_) => remove_file(&dir, leaf).map_err(Into::into),
			Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(err.into()),
		}
	}

	pub(super) fn remove_path(root: &Path, parts: &[&str]) -> crate::Result<()> {
		let (leaf, parents) = parts.split_last().expect("split rejects an empty path");
		let mut directories = Vec::with_capacity(parents.len() + 1);
		directories.push(open_root(root)?);
		for parent in parents {
			let dir = directories.last().expect("the root is always open");
			match dir.open_dir_nofollow(parent) {
				Ok(child) => directories.push(child),
				Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
				Err(err) => match dir.symlink_metadata(parent) {
					Ok(meta) if meta.file_type().is_symlink() => {
						remove_file(dir, parent)?;
						return Ok(());
					},
					Ok(_) => return Ok(()),
					Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
					Err(_) => return Err(err.into()),
				},
			}
		}
		{
			let dir = directories.last().expect("the root is always open");
			match dir.symlink_metadata(leaf) {
				Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
					if remove_dir(dir, leaf).is_err() {
						return Ok(());
					}
				},
				Ok(_) => remove_file(dir, leaf)?,
				Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
				Err(err) => return Err(err.into()),
			}
		}
		for parent in parents.iter().rev() {
			drop(directories.pop());
			let dir = directories.last().expect("the root remains open");
			if remove_dir(dir, parent).is_err() {
				break;
			}
		}
		Ok(())
	}

	pub(super) fn ensure_directory(root: &Path, parts: &[&str]) -> crate::Result<()> {
		let (leaf, parents) = parts.split_last().expect("split rejects an empty path");
		let dir = ensure_parents(root, parents)?;
		ensure_subdir(&dir, leaf)?;
		Ok(())
	}

	fn open_root(root: &Path) -> io::Result<Dir> {
		Dir::open_ambient_dir(root, ambient_authority())
	}

	fn ensure_parents(root: &Path, parents: &[&str]) -> io::Result<Dir> {
		let mut dir = open_root(root)?;
		for parent in parents {
			dir = ensure_subdir(&dir, parent)?;
		}
		Ok(dir)
	}

	fn ensure_subdir(parent: &Dir, name: &str) -> io::Result<Dir> {
		match parent.open_dir_nofollow(name) {
			Ok(child) => Ok(child),
			Err(err) if err.kind() == io::ErrorKind::NotFound => create_and_open(parent, name),
			Err(_) if is_symlink(parent, name)? => {
				remove_file(parent, name)?;
				create_and_open(parent, name)
			},
			Err(err) => Err(err),
		}
	}

	fn create_and_open(parent: &Dir, name: &str) -> io::Result<Dir> {
		match parent.create_dir(name) {
			Ok(()) => {},
			Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {},
			Err(err) => return Err(err),
		}
		parent.open_dir_nofollow(name)
	}

	fn removal_parent(root: &Path, parents: &[&str]) -> io::Result<Option<Dir>> {
		let mut dir = open_root(root)?;
		for parent in parents {
			match dir.open_dir_nofollow(parent) {
				Ok(child) => dir = child,
				Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
				Err(err) => match dir.symlink_metadata(parent) {
					Ok(meta) if meta.file_type().is_symlink() => {
						remove_file(&dir, parent)?;
						return Ok(None);
					},
					Ok(_) => return Ok(None),
					Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
					Err(_) => return Err(err),
				},
			}
		}
		Ok(Some(dir))
	}

	fn write_file(dir: &Dir, leaf: &str, bytes: &[u8]) -> io::Result<()> {
		if is_symlink(dir, leaf)? {
			remove_file(dir, leaf)?;
		}
		let mut options = OpenOptions::new();
		options
			.write(true)
			.create(true)
			.truncate(true)
			.follow(FollowSymlinks::No);
		#[cfg(windows)]
		options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
		let mut file = dir.open_with(leaf, &options)?;
		file.write_all(bytes)
	}

	fn is_symlink(dir: &Dir, name: &str) -> io::Result<bool> {
		match dir.symlink_metadata(name) {
			Ok(meta) => Ok(meta.file_type().is_symlink()),
			Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
			Err(err) => Err(err),
		}
	}

	#[cfg(windows)]
	fn open_delete(dir: &Dir, name: &str) -> io::Result<cap_std::fs::File> {
		let mut options = OpenOptions::new();
		options.access_mode(DELETE);
		options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
		options.follow(FollowSymlinks::No);
		dir.open_with(name, &options)
	}

	#[cfg(windows)]
	fn remove_file(dir: &Dir, name: &str) -> io::Result<()> {
		let file = open_delete(dir, name)?;
		let meta = file.metadata()?;
		if meta.is_dir() && !meta.file_type().is_symlink() {
			return Err(io::Error::new(io::ErrorKind::IsADirectory, "worktree leaf is a directory"));
		}
		delete_open(file)
	}

	#[cfg(not(windows))]
	fn remove_file(dir: &Dir, name: &str) -> io::Result<()> {
		dir.remove_file(name)
	}

	#[cfg(windows)]
	fn remove_dir(dir: &Dir, name: &str) -> io::Result<()> {
		let file = open_delete(dir, name)?;
		let meta = file.metadata()?;
		if !meta.is_dir() || meta.file_type().is_symlink() {
			return Err(io::Error::new(io::ErrorKind::NotADirectory, "not a real directory"));
		}
		delete_open(file)
	}

	#[cfg(not(windows))]
	fn remove_dir(dir: &Dir, name: &str) -> io::Result<()> {
		dir.remove_dir(name)
	}

	#[cfg(windows)]
	fn delete_open(file: cap_std::fs::File) -> io::Result<()> {
		let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
		// SAFETY: `file` is a live handle opened with DELETE access, and the
		// disposition pointer and size describe the local value exactly.
		let result = unsafe {
			SetFileInformationByHandle(
				file.as_raw_handle(),
				FileDispositionInfo,
				(&raw const disposition).cast(),
				size_of::<FILE_DISPOSITION_INFO>() as u32,
			)
		};
		if result == 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(())
		}
	}
}
