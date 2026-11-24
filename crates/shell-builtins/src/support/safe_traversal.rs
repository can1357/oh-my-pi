//! Descriptor-relative directory traversal used by recursive removal.

#![cfg(unix)]

use std::{
	ffi::{CStr, CString, OsStr, OsString},
	io,
	mem::MaybeUninit,
	os::{
		fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd},
		unix::ffi::{OsStrExt, OsStringExt},
	},
	path::{Component, Path, PathBuf},
};

#[cfg(any(target_os = "linux", target_os = "android"))]
use rustix::fs::RawDir;
use rustix::fs::{AtFlags, CWD, Mode, OFlags};

/// Selects whether descriptor-relative operations follow a final symlink.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SymlinkBehavior {
	/// Follow the final symbolic link.
	#[default]
	Follow,
	/// Operate on the symbolic link itself.
	NoFollow,
}

/// An owned directory descriptor for race-resistant relative operations.
#[derive(Debug)]
pub(crate) struct DirFd {
	fd: OwnedFd,
}

impl DirFd {
	/// Opens a directory with one `openat` that refuses a final symbolic link.
	///
	/// `symlink_behavior` is not consulted: the descriptor is always opened with
	/// `O_NOFOLLOW`, so only the final component is checked and symlinks in
	/// earlier components are followed. `rm` passes [`SymlinkBehavior::Follow`]
	/// and depends on exactly this behavior. Use [`DirFd::open_walk`] when no
	/// earlier component may be a symlink.
	pub(crate) fn open(path: &Path, symlink_behavior: SymlinkBehavior) -> io::Result<Self> {
		let _ = symlink_behavior;
		let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW;
		let fd = rustix::fs::openat(CWD, path, flags, Mode::empty()).map_err(io::Error::from)?;
		Ok(Self { fd })
	}

	/// Opens a directory by walking each component from an already-open parent.
	///
	/// Intermediate components are opened with `O_NOFOLLOW`. `symlink_behavior`
	/// applies only to the final component, so a symlink swapped into the walk
	/// cannot redirect it. This is the walk the no-follow write seam builds on.
	pub(crate) fn open_walk(path: &Path, symlink_behavior: SymlinkBehavior) -> io::Result<Self> {
		if path.as_os_str().is_empty() {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty directory path"));
		}
		let path = system_dir_prefix(path);
		let components: Vec<Component> = path.components().collect();
		let rooted = components.first() == Some(&Component::RootDir);
		let mut current = if rooted {
			open_start(OsStr::new("/"), SymlinkBehavior::Follow)?
		} else {
			open_start(OsStr::new("."), SymlinkBehavior::NoFollow)?
		};
		for (offset, component) in components.iter().enumerate().skip(usize::from(rooted)) {
			let behavior = if offset + 1 == components.len() {
				symlink_behavior
			} else {
				SymlinkBehavior::NoFollow
			};
			current = match *component {
				Component::CurDir => current,
				Component::ParentDir => {
					current.open_child(OsStr::new(".."), SymlinkBehavior::NoFollow)?
				},
				Component::Normal(name) => current.open_child(name, behavior)?,
				Component::RootDir | Component::Prefix(_) => {
					return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid directory path"));
				},
			};
		}
		Ok(current)
	}

	/// Opens a child directory relative to this descriptor.
	///
	/// `symlink_behavior` is not consulted: the child is always opened with
	/// `O_NOFOLLOW`, so a symlink is refused. `rm` passes
	/// [`SymlinkBehavior::Follow`] and relies on that refusal.
	pub(crate) fn open_subdir(
		&self,
		name: &OsStr,
		symlink_behavior: SymlinkBehavior,
	) -> io::Result<Self> {
		validate_name(name)?;
		let _ = symlink_behavior;
		let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW;
		let fd = rustix::fs::openat(&self.fd, name, flags, Mode::empty()).map_err(io::Error::from)?;
		Ok(Self { fd })
	}

	/// Opens a child directory and honors `symlink_behavior` for that component.
	fn open_child(&self, name: &OsStr, symlink_behavior: SymlinkBehavior) -> io::Result<Self> {
		validate_name(name)?;
		let fd = rustix::fs::openat(&self.fd, name, dir_flags(symlink_behavior), Mode::empty())
			.map_err(io::Error::from)?;
		Ok(Self { fd })
	}

	/// Stats this directory through its open descriptor.
	pub(crate) fn stat(&self) -> io::Result<libc::stat> {
		let mut stat = MaybeUninit::<libc::stat>::uninit();
		// SAFETY: the descriptor is valid and `stat` points to writable storage.
		let result = unsafe { libc::fstat(self.fd.as_raw_fd(), stat.as_mut_ptr()) };
		if result == 0 {
			// SAFETY: successful `fstat` initialized the entire stat structure.
			Ok(unsafe { stat.assume_init() })
		} else {
			Err(io::Error::last_os_error())
		}
	}

	/// Stats a child relative to this descriptor.
	pub(crate) fn stat_at(
		&self,
		name: &OsStr,
		symlink_behavior: SymlinkBehavior,
	) -> io::Result<libc::stat> {
		let name = os_str_to_cstring(name)?;
		let mut stat = MaybeUninit::<libc::stat>::uninit();
		let flags = if symlink_behavior == SymlinkBehavior::NoFollow {
			libc::AT_SYMLINK_NOFOLLOW
		} else {
			0
		};
		// SAFETY: the descriptor and C string are valid; `stat` points to writable
		// storage.
		let result =
			unsafe { libc::fstatat(self.fd.as_raw_fd(), name.as_ptr(), stat.as_mut_ptr(), flags) };
		if result == 0 {
			// SAFETY: successful `fstatat` initialized the entire stat structure.
			Ok(unsafe { stat.assume_init() })
		} else {
			Err(io::Error::last_os_error())
		}
	}

	/// Lists child names, excluding `.` and `..`, without resolving another
	/// path.
	pub(crate) fn read_dir(&self) -> io::Result<Vec<OsString>> {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		{
			self.read_dir_raw()
		}
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		{
			self.read_dir_libc()
		}
	}

	#[cfg(any(target_os = "linux", target_os = "android"))]
	fn read_dir_raw(&self) -> io::Result<Vec<OsString>> {
		let duplicate = rustix::io::dup(&self.fd).map_err(io::Error::from)?;
		let mut buffer = [MaybeUninit::<u8>::uninit(); 8192];
		let mut directory = RawDir::new(duplicate, &mut buffer);
		let mut entries = Vec::new();
		while let Some(entry) = directory.next() {
			let entry = entry.map_err(io::Error::from)?;
			let bytes = entry.file_name().to_bytes();
			if bytes != b"." && bytes != b".." {
				entries.push(OsString::from_vec(bytes.to_vec()));
			}
		}
		Ok(entries)
	}

	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	fn read_dir_libc(&self) -> io::Result<Vec<OsString>> {
		let duplicate = rustix::io::dup(&self.fd).map_err(io::Error::from)?;
		let raw = duplicate.into_raw_fd();
		// SAFETY: `raw` is an owned directory descriptor; `fdopendir` consumes it on
		// success.
		let directory = unsafe { libc::fdopendir(raw) };
		if directory.is_null() {
			let error = io::Error::last_os_error();
			// SAFETY: `fdopendir` failed and therefore did not consume `raw`.
			drop(unsafe { OwnedFd::from_raw_fd(raw) });
			return Err(error);
		}

		let mut entries = Vec::new();
		loop {
			set_errno_zero();
			// SAFETY: `directory` is live until `closedir` below.
			let entry = unsafe { libc::readdir(directory) };
			if entry.is_null() {
				let error = io::Error::last_os_error();
				// SAFETY: `directory` is a valid DIR pointer and is closed exactly once.
				unsafe { libc::closedir(directory) };
				return if error.raw_os_error() == Some(0) {
					Ok(entries)
				} else {
					Err(error)
				};
			}
			// SAFETY: `d_name` is a NUL-terminated array owned by the live directory
			// stream.
			let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
			if name != b"." && name != b".." {
				entries.push(OsString::from_vec(name.to_vec()));
			}
		}
	}

	/// Removes a child file or empty child directory relative to this
	/// descriptor.
	pub(crate) fn unlink_at(&self, name: &OsStr, is_dir: bool) -> io::Result<()> {
		validate_name(name)?;
		let flags = if is_dir {
			AtFlags::REMOVEDIR
		} else {
			AtFlags::empty()
		};
		rustix::fs::unlinkat(&self.fd, name, flags).map_err(io::Error::from)
	}
}

fn dir_flags(symlink_behavior: SymlinkBehavior) -> OFlags {
	let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
	if symlink_behavior == SymlinkBehavior::NoFollow {
		flags | OFlags::NOFOLLOW
	} else {
		flags
	}
}

fn open_start(name: &OsStr, symlink_behavior: SymlinkBehavior) -> io::Result<DirFd> {
	let fd = rustix::fs::openat(CWD, name, dir_flags(symlink_behavior), Mode::empty())
		.map_err(io::Error::from)?;
	Ok(DirFd { fd })
}

/// Rewrites macOS's fixed `/tmp`, `/var` and `/etc` links so a no-follow walk
/// does not stop on the operating system's own directories.
fn system_dir_prefix(path: &Path) -> PathBuf {
	#[cfg(target_os = "macos")]
	{
		for (logical, physical) in [
			(Path::new("/tmp"), Path::new("/private/tmp")),
			(Path::new("/var"), Path::new("/private/var")),
			(Path::new("/etc"), Path::new("/private/etc")),
		] {
			if path == logical {
				return physical.to_path_buf();
			}
			if let Ok(suffix) = path.strip_prefix(logical) {
				return physical.join(suffix);
			}
		}
	}
	path.to_path_buf()
}

fn validate_name(name: &OsStr) -> io::Result<()> {
	let bytes = name.as_bytes();
	if bytes.is_empty() || bytes.contains(&0) || bytes.contains(&b'/') {
		Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid directory component"))
	} else {
		Ok(())
	}
}

fn os_str_to_cstring(name: &OsStr) -> io::Result<CString> {
	CString::new(name.as_bytes())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn set_errno_zero() {
	#[cfg(target_vendor = "apple")]
	// SAFETY: the returned pointer is thread-local and valid for one integer write.
	unsafe {
		*libc::__error() = 0;
	}
	#[cfg(not(target_vendor = "apple"))]
	// SAFETY: the returned pointer is thread-local and valid for one integer write.
	unsafe {
		*libc::__errno_location() = 0;
	}
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	#[test]
	fn traverses_and_unlinks_temp_tree_by_descriptor() {
		let root = tempfile::tempdir().unwrap();
		fs::create_dir(root.path().join("child")).unwrap();
		fs::write(root.path().join("child/file"), b"data").unwrap();

		let root_fd = DirFd::open(root.path(), SymlinkBehavior::NoFollow).unwrap();
		assert_eq!(root_fd.read_dir().unwrap(), [OsString::from("child")]);
		let child = root_fd
			.open_subdir(OsStr::new("child"), SymlinkBehavior::NoFollow)
			.unwrap();
		let stat = child
			.stat_at(OsStr::new("file"), SymlinkBehavior::NoFollow)
			.unwrap();
		assert_eq!(stat.st_size, 4);
		child.unlink_at(OsStr::new("file"), false).unwrap();
		drop(child);
		root_fd.unlink_at(OsStr::new("child"), true).unwrap();
		assert!(root_fd.read_dir().unwrap().is_empty());
	}

	#[test]
	fn nofollow_walk_refuses_an_intermediate_symlink() {
		let root = tempfile::tempdir().unwrap();
		let outside = tempfile::tempdir().unwrap();
		let secret = outside.path().join("secret");
		fs::write(&secret, b"untouched").unwrap();
		fs::create_dir(outside.path().join("nested")).unwrap();
		std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
		let opened = DirFd::open_walk(&root.path().join("link/nested"), SymlinkBehavior::NoFollow);
		assert!(opened.is_err(), "walk followed a symlink out of the root");
		assert_eq!(fs::read(&secret).unwrap(), b"untouched");
	}

	#[test]
	fn swapped_child_symlink_is_refused_after_the_parent_is_open() {
		let root = tempfile::tempdir().unwrap();
		let outside = tempfile::tempdir().unwrap();
		let secret = outside.path().join("secret");
		fs::write(&secret, b"untouched").unwrap();
		fs::create_dir(root.path().join("real")).unwrap();
		let parent = DirFd::open(root.path(), SymlinkBehavior::NoFollow).unwrap();
		fs::rename(root.path().join("real"), root.path().join("real.bak")).unwrap();
		std::os::unix::fs::symlink(outside.path(), root.path().join("real")).unwrap();
		let opened = parent.open_subdir(OsStr::new("real"), SymlinkBehavior::NoFollow);
		assert!(opened.is_err(), "open followed a link swapped in after the parent open");
		assert_eq!(fs::read(&secret).unwrap(), b"untouched");
	}

	#[test]
	fn walk_follows_only_the_final_symlink() {
		let root = tempfile::tempdir().unwrap();
		let target = root.path().join("target");
		fs::create_dir(&target).unwrap();
		fs::write(target.join("marker"), b"ok").unwrap();
		std::os::unix::fs::symlink(&target, root.path().join("link")).unwrap();
		let opened = DirFd::open_walk(&root.path().join("link"), SymlinkBehavior::Follow).unwrap();
		assert_eq!(opened.read_dir().unwrap(), [OsString::from("marker")]);
		assert!(DirFd::open_walk(&root.path().join("link"), SymlinkBehavior::NoFollow).is_err());
		fs::create_dir(target.join("inner")).unwrap();
		std::os::unix::fs::symlink(&target, root.path().join("mid")).unwrap();
		assert!(DirFd::open_walk(&root.path().join("mid/inner"), SymlinkBehavior::Follow).is_err());
	}

	/// `rm` passes `Follow` to `open` and `open_subdir` and has always received
	/// a single `O_NOFOLLOW` open: earlier symlinks are followed, a final or
	/// child symlink is refused. Pin that so a change to the walk cannot alter
	/// `rm`.
	#[test]
	fn open_and_open_subdir_keep_the_contract_rm_depends_on() {
		let root = tempfile::tempdir().unwrap();
		let target = root.path().join("target");
		fs::create_dir(&target).unwrap();
		fs::create_dir(target.join("inner")).unwrap();
		std::os::unix::fs::symlink(&target, root.path().join("link")).unwrap();
		// A symlink in an earlier component is followed whatever the argument says.
		for behavior in [SymlinkBehavior::Follow, SymlinkBehavior::NoFollow] {
			let opened = DirFd::open(&root.path().join("link/inner"), behavior).unwrap();
			assert!(opened.read_dir().unwrap().is_empty());
		}
		// A final symlink is refused whatever the argument says.
		for behavior in [SymlinkBehavior::Follow, SymlinkBehavior::NoFollow] {
			assert!(DirFd::open(&root.path().join("link"), behavior).is_err());
		}
		// A child symlink is refused by `open_subdir` whatever the argument says.
		let parent = DirFd::open(root.path(), SymlinkBehavior::NoFollow).unwrap();
		for behavior in [SymlinkBehavior::Follow, SymlinkBehavior::NoFollow] {
			assert!(parent.open_subdir(OsStr::new("link"), behavior).is_err());
			assert!(parent.open_subdir(OsStr::new("target"), behavior).is_ok());
		}
	}
}
