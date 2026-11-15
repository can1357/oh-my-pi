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

/// What [`unlink_worktree_leaf`] did with the final path component.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Leaf {
	/// Nothing was at the path inside the repository.
	Missing,
	/// A file or symlink was unlinked. A symlink is removed, not followed.
	Removed,
	/// A real directory is in the way. The caller decides whether to remove it.
	Directory,
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
/// any parent. Symlink parents are replaced with real directories first, so
/// the removal cannot land outside `root`.
pub(super) fn unlink_worktree_leaf(root: &Path, path: &str) -> Result<Leaf> {
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

/// Create every parent of repo-relative `path` as a real directory, replacing
/// a symlink that blocks one. The final component is left untouched.
pub(super) fn ensure_real_parents(root: &Path, path: &str) -> Result<()> {
	let parts = split_relative(path)?;
	let Some((_, parents)) = parts.split_last() else {
		return Ok(());
	};
	if parents.is_empty() {
		return Ok(());
	}
	#[cfg(unix)]
	{
		unix::ensure_parents(root, parents)
	}
	#[cfg(not(unix))]
	{
		portable::ensure_parents(root, parents)
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

	pub(super) fn unlink_leaf(root: &Path, parts: &[&str]) -> crate::Result<super::Leaf> {
		let (leaf, parents) = parts.split_last().ok_or_else(|| invalid())?;
		let Some(dir) = removal_parent(root, parents)? else {
			return Ok(super::Leaf::Missing);
		};
		let leaf = c_name(leaf)?;
		match symlink_kind(&dir, &leaf)? {
			Kind::Missing => Ok(super::Leaf::Missing),
			Kind::Directory => Ok(super::Leaf::Directory),
			Kind::Other => {
				unlink_at(&dir, &leaf)?;
				Ok(super::Leaf::Removed)
			},
		}
	}

	pub(super) fn ensure_parents(root: &Path, parents: &[&str]) -> crate::Result<()> {
		let mut dir = open_root(root)?;
		for parent in parents {
			dir = ensure_subdir(&dir, &c_name(parent)?)?;
		}
		Ok(())
	}

	fn with_leaf<T>(
		root: &Path,
		parts: &[&str],
		op: impl FnOnce(&OwnedFd, &CStr) -> io::Result<T>,
	) -> crate::Result<T> {
		let (leaf, parents) = parts.split_last().ok_or_else(|| invalid())?;
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
	use std::{fs, io, path::Path};

	use super::MaterializedEntry;

	pub(super) fn materialize(
		root: &Path,
		parts: &[&str],
		entry: MaterializedEntry<'_>,
	) -> crate::Result<()> {
		let (leaf, parents) = parts.split_last().expect("split rejects an empty path");
		let dir = parents_path(root, parents)?;
		let path = dir.join(leaf);
		if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
			fs::remove_file(&path)?;
		}
		match entry {
			MaterializedEntry::Symlink { target, .. } => {
				if fs::symlink_metadata(&path).is_ok() {
					fs::remove_file(&path)?;
				}
				fs::write(path, target)?;
			},
			MaterializedEntry::File { bytes, .. } => fs::write(path, bytes)?,
		}
		Ok(())
	}

	pub(super) fn unlink_leaf(root: &Path, parts: &[&str]) -> crate::Result<super::Leaf> {
		let (leaf, parents) = parts.split_last().expect("split rejects an empty path");
		let Some(dir) = removal_parent_path(root, parents)? else {
			return Ok(super::Leaf::Missing);
		};
		let path = dir.join(leaf);
		match fs::symlink_metadata(&path) {
			Ok(meta) if meta.is_dir() => Ok(super::Leaf::Directory),
			Ok(_) => {
				fs::remove_file(path)?;
				Ok(super::Leaf::Removed)
			},
			Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(super::Leaf::Missing),
			Err(err) => Err(crate::Error::Io(err)),
		}
	}

	pub(super) fn ensure_parents(root: &Path, parents: &[&str]) -> crate::Result<()> {
		parents_path(root, parents)?;
		Ok(())
	}

	fn removal_parent_path(root: &Path, parents: &[&str]) -> io::Result<Option<std::path::PathBuf>> {
		let mut dir = root.to_path_buf();
		for parent in parents {
			dir.push(parent);
			match fs::symlink_metadata(&dir) {
				Ok(meta) if meta.file_type().is_symlink() => {
					fs::remove_file(&dir)?;
					return Ok(None);
				},
				Ok(meta) if meta.is_dir() => {},
				Ok(_) => return Ok(None),
				Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
				Err(err) => return Err(err),
			}
		}
		Ok(Some(dir))
	}

	fn parents_path(root: &Path, parents: &[&str]) -> io::Result<std::path::PathBuf> {
		let mut dir = root.to_path_buf();
		for parent in parents {
			dir.push(parent);
			ensure_real_dir(&dir)?;
		}
		Ok(dir)
	}

	fn ensure_real_dir(path: &Path) -> io::Result<()> {
		match fs::symlink_metadata(path) {
			Ok(meta) if meta.file_type().is_symlink() => {
				fs::remove_file(path)?;
				fs::create_dir(path)
			},
			Ok(meta) if meta.is_dir() => Ok(()),
			Ok(_) => {
				Err(io::Error::new(io::ErrorKind::AlreadyExists, "parent path is not a directory"))
			},
			Err(err) if err.kind() == io::ErrorKind::NotFound => fs::create_dir(path),
			Err(err) => Err(err),
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		fs,
		os::unix::fs::{PermissionsExt, symlink},
		path::{Path, PathBuf},
		process::Command,
	};

	use super::super::GitRepo;
	use crate::types::{ApplyOptions, ResetMode, RestoreOptions};

	fn git(dir: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.arg("-C")
			.arg(dir)
			.args(args)
			.output()
			.expect("run git");
		assert!(
			output.status.success(),
			"git {args:?} failed: {}",
			String::from_utf8_lossy(&output.stderr)
		);
		String::from_utf8(output.stdout)
			.expect("utf-8")
			.trim_end()
			.to_owned()
	}

	fn init() -> (tempfile::TempDir, PathBuf) {
		let temp = tempfile::tempdir().expect("tempdir");
		let outside = temp.path().join("outside");
		fs::create_dir(&outside).expect("outside");
		let repo = temp.path().join("repo");
		fs::create_dir(&repo).expect("repo");
		git(&repo, &["init", "-q", "-b", "main"]);
		git(&repo, &["config", "user.name", "Test"]);
		git(&repo, &["config", "user.email", "test@example.com"]);
		git(&repo, &["config", "core.autocrlf", "false"]);
		(temp, outside)
	}

	fn repo_path(temp: &tempfile::TempDir) -> PathBuf {
		temp.path().join("repo")
	}

	fn commit_file(repo: &Path, path: &str, bytes: &str) {
		let absolute = repo.join(path);
		if let Some(parent) = absolute.parent() {
			fs::create_dir_all(parent).expect("parents");
		}
		fs::write(absolute, bytes).expect("write");
		git(repo, &["add", path]);
		git(repo, &["commit", "-qm", path]);
	}

	fn replace_with_link(path: &Path, target: &Path) {
		if path.exists() || fs::symlink_metadata(path).is_ok() {
			if fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
				fs::remove_dir_all(path).expect("remove dir");
			} else {
				fs::remove_file(path).expect("remove file");
			}
		}
		symlink(target, path).expect("symlink");
	}

	#[test]
	fn restore_replaces_a_retargeted_symlink_without_writing_through_it() {
		let (temp, outside) = init();
		let repo = repo_path(&temp);
		let victim = outside.join("victim.txt");
		fs::write(&victim, "secret").expect("victim");
		fs::write(repo.join("original.txt"), "inside\n").expect("original");
		symlink("original.txt", repo.join("link")).expect("link");
		git(&repo, &["add", "original.txt", "link"]);
		git(&repo, &["commit", "-qm", "link"]);
		replace_with_link(&repo.join("link"), &victim);

		GitRepo::require(&repo)
			.expect("repo")
			.restore(&RestoreOptions { files: vec!["link".into()], ..RestoreOptions::default() })
			.expect("restore");

		assert_eq!(fs::read_to_string(&victim).expect("victim"), "secret");
		assert_eq!(
			fs::read_link(repo.join("link")).expect("readlink"),
			PathBuf::from("original.txt")
		);
	}

	#[test]
	fn restore_does_not_smudge_a_symlink_target() {
		let (temp, _) = init();
		let repo = repo_path(&temp);
		let smudge = temp.path().join("smudge.sh");
		fs::write(&smudge, "#!/bin/sh\nsed 's/safe/SMUDGED/g'\n").expect("smudge");
		fs::set_permissions(&smudge, fs::Permissions::from_mode(0o755)).expect("chmod");
		git(&repo, &["config", "filter.corrupt.clean", "cat"]);
		git(&repo, &["config", "filter.corrupt.smudge", smudge.to_str().expect("utf-8")]);
		git(&repo, &["config", "filter.corrupt.required", "true"]);
		fs::write(repo.join(".gitattributes"), "link filter=corrupt\ntext.txt filter=corrupt\n")
			.expect("attrs");
		symlink("safe-target", repo.join("link")).expect("link");
		fs::write(repo.join("text.txt"), "safe\n").expect("text");
		git(&repo, &["add", ".gitattributes", "link", "text.txt"]);
		git(&repo, &["commit", "-qm", "filtered"]);
		fs::write(repo.join("text.txt"), "dirty\n").expect("dirty text");
		replace_with_link(&repo.join("link"), &temp.path().join("missing-target"));

		let handle = GitRepo::require(&repo).expect("repo");
		handle
			.restore(&RestoreOptions {
				files: vec!["link".into(), "text.txt".into()],
				..RestoreOptions::default()
			})
			.expect("restore");

		assert_eq!(fs::read_link(repo.join("link")).expect("readlink"), PathBuf::from("safe-target"));
		assert_eq!(
			fs::read_to_string(repo.join("text.txt")).expect("text"),
			"SMUDGED\n",
			"the smudge filter must still run for a regular file"
		);
	}

	#[test]
	fn restore_replaces_a_symlinked_parent_instead_of_writing_outside() {
		let (temp, outside) = init();
		let repo = repo_path(&temp);
		commit_file(&repo, "dir/file.txt", "index-bytes\n");
		let linked = outside.join("linked");
		fs::create_dir(&linked).expect("linked");
		fs::write(linked.join("file.txt"), "victim\n").expect("victim");
		replace_with_link(&repo.join("dir"), &linked);

		GitRepo::require(&repo)
			.expect("repo")
			.restore(&RestoreOptions {
				files: vec!["dir/file.txt".into()],
				..RestoreOptions::default()
			})
			.expect("restore");

		assert_eq!(fs::read_to_string(linked.join("file.txt")).expect("outside"), "victim\n");
		assert!(
			!fs::symlink_metadata(repo.join("dir"))
				.expect("dir")
				.file_type()
				.is_symlink()
		);
		assert_eq!(fs::read_to_string(repo.join("dir/file.txt")).expect("restored"), "index-bytes\n");
	}

	#[test]
	fn restore_replaces_an_intermediate_symlink_instead_of_writing_outside() {
		let (temp, outside) = init();
		let repo = repo_path(&temp);
		commit_file(&repo, "dir/nested/deep.txt", "deep-bytes\n");
		let linked = outside.join("linked");
		fs::create_dir(&linked).expect("linked");
		fs::write(linked.join("deep.txt"), "victim\n").expect("victim");
		replace_with_link(&repo.join("dir/nested"), &linked);

		GitRepo::require(&repo)
			.expect("repo")
			.restore(&RestoreOptions {
				files: vec!["dir/nested/deep.txt".into()],
				..RestoreOptions::default()
			})
			.expect("restore");

		assert_eq!(fs::read_to_string(linked.join("deep.txt")).expect("outside"), "victim\n");
		assert!(
			!fs::symlink_metadata(repo.join("dir/nested"))
				.expect("nested")
				.file_type()
				.is_symlink()
		);
		assert_eq!(
			fs::read_to_string(repo.join("dir/nested/deep.txt")).expect("restored"),
			"deep-bytes\n"
		);
	}

	#[test]
	fn cherry_pick_replaces_a_symlink_with_a_file_without_writing_through() {
		let (temp, outside) = init();
		let repo = repo_path(&temp);
		let victim = outside.join("victim.txt");
		fs::write(&victim, "secret").expect("victim");
		symlink(&victim, repo.join("link")).expect("link");
		git(&repo, &["add", "link"]);
		git(&repo, &["commit", "-qm", "symlink"]);
		git(&repo, &["checkout", "-qb", "other"]);
		fs::remove_file(repo.join("link")).expect("unlink");
		fs::write(repo.join("link"), "picked\n").expect("file");
		git(&repo, &["add", "link"]);
		git(&repo, &["commit", "-qm", "file"]);
		git(&repo, &["checkout", "-q", "main"]);

		GitRepo::require(&repo)
			.expect("repo")
			.cherry_pick("other")
			.expect("cherry-pick");

		assert_eq!(fs::read_to_string(&victim).expect("victim"), "secret");
		assert!(
			!fs::symlink_metadata(repo.join("link"))
				.expect("link")
				.file_type()
				.is_symlink()
		);
		assert_eq!(fs::read_to_string(repo.join("link")).expect("picked"), "picked\n");
	}

	#[test]
	fn apply_patch_does_not_write_a_new_file_through_a_symlinked_parent() {
		let (temp, outside) = init();
		let repo = repo_path(&temp);
		commit_file(&repo, "dir/file.txt", "kept\n");
		fs::write(repo.join("dir/extra.txt"), "added\n").expect("extra");
		git(&repo, &["add", "dir/extra.txt"]);
		git(&repo, &["commit", "-qm", "add extra"]);
		let patch = git(&repo, &["diff", "--no-ext-diff", "HEAD~1", "HEAD"]);
		git(&repo, &["reset", "--hard", "-q", "HEAD~1"]);
		let linked = outside.join("linked");
		fs::create_dir(&linked).expect("linked");
		fs::write(linked.join("file.txt"), "victim\n").expect("victim");
		replace_with_link(&repo.join("dir"), &linked);

		GitRepo::require(&repo)
			.expect("repo")
			.apply_patch(&patch, &ApplyOptions::default())
			.expect("apply");

		assert!(!linked.join("extra.txt").exists(), "patch wrote through the parent symlink");
		assert_eq!(fs::read_to_string(linked.join("file.txt")).expect("outside"), "victim\n");
		assert_eq!(fs::read_to_string(repo.join("dir/extra.txt")).expect("added"), "added\n");
	}

	#[test]
	fn apply_patch_does_not_delete_through_a_symlinked_parent() {
		let (temp, outside) = init();
		let repo = repo_path(&temp);
		commit_file(&repo, "dir/file.txt", "gone\n");
		git(&repo, &["rm", "-q", "dir/file.txt"]);
		git(&repo, &["commit", "-qm", "delete"]);
		let patch = git(&repo, &["diff", "--no-ext-diff", "HEAD~1", "HEAD"]);
		git(&repo, &["reset", "--hard", "-q", "HEAD~1"]);
		let linked = outside.join("linked");
		fs::create_dir(&linked).expect("linked");
		fs::write(linked.join("file.txt"), "gone\n").expect("victim");
		replace_with_link(&repo.join("dir"), &linked);

		GitRepo::require(&repo)
			.expect("repo")
			.apply_patch(&patch, &ApplyOptions::default())
			.expect("apply");

		assert_eq!(fs::read_to_string(linked.join("file.txt")).expect("outside"), "gone\n");
	}

	#[test]
	fn hard_reset_does_not_delete_through_a_symlinked_parent() {
		let (temp, outside) = init();
		let repo = repo_path(&temp);
		commit_file(&repo, "dir/file.txt", "tracked\n");
		git(&repo, &["checkout", "-qb", "deleted"]);
		git(&repo, &["rm", "-q", "dir/file.txt"]);
		git(&repo, &["commit", "-qm", "delete"]);
		git(&repo, &["checkout", "-q", "main"]);
		let linked = outside.join("linked");
		fs::create_dir(&linked).expect("linked");
		fs::write(linked.join("file.txt"), "victim\n").expect("victim");
		replace_with_link(&repo.join("dir"), &linked);

		GitRepo::require(&repo)
			.expect("repo")
			.reset(ResetMode::Hard, Some("deleted"))
			.expect("reset");

		assert_eq!(fs::read_to_string(linked.join("file.txt")).expect("outside"), "victim\n");
	}
}
