//! Host filesystem operations. Everything here is synchronous: the facades
//! call it directly, without futures or boxing.

mod held_sqlite;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::{
	fs,
	future::{Future, ready},
	io::{self, Read, Write},
	path::{Path, PathBuf},
};

pub use self::held_sqlite::held_by_sqlite;
#[cfg(unix)]
pub(crate) use self::unix::{
	access, allocated_size, chown, close, file_id, file_id_of, file_is_locked, file_metadata,
	file_set_permissions, file_set_times, fstat_fs, get_xattr, link_count, list_xattr, make_node,
	remove_xattr, set_dir_mode, set_permissions, set_times, set_xattr, stat_fs, symlink,
};
#[cfg(windows)]
pub(crate) use self::windows::{
	HandleInfo, access, allocated_size, chown, close, file_id, file_id_of, file_is_locked,
	file_metadata, file_set_permissions, file_set_times, fstat_fs, get_xattr, link_count,
	list_xattr, make_node, remove_xattr, set_dir_mode, set_permissions, set_times, set_xattr,
	stat_fs, symlink,
};
use crate::{
	canonicalize::{Resolver, canonicalize},
	dir::ReadDir,
	error::not_a_directory,
	file::File,
	metadata::Metadata,
	options::{CanonicalizeOptions, OpenOptions},
	runtime::park_on,
};

pub(crate) fn open(path: &Path, options: &OpenOptions) -> io::Result<File> {
	held_sqlite::open(path, options).map(File::from)
}

pub(crate) fn read(path: &Path) -> io::Result<Vec<u8>> {
	let mut options = OpenOptions::new();
	options.read(true);
	let mut contents = Vec::new();
	held_sqlite::open(path, &options)?.read_to_end(&mut contents)?;
	Ok(contents)
}

pub(crate) fn write(path: &Path, contents: &[u8]) -> io::Result<()> {
	let mut options = OpenOptions::new();
	options.write(true).create(true).truncate(true);
	held_sqlite::open(path, &options)?.write_all(contents)
}

pub(crate) fn copy(from: &Path, to: &Path) -> io::Result<u64> {
	if held_by_sqlite(from) || held_by_sqlite(to) {
		return Err(held_sqlite::busy());
	}
	fs::copy(from, to)
}

// Windows path stats carry handle identity when the object can be opened for
// attribute queries, so identity comparisons (`same_file`, rotation detection)
// work the way the unix dev/ino pair does.
#[cfg(windows)]
pub(crate) fn metadata(path: &Path) -> io::Result<Metadata> {
	windows::path_metadata(path, true)
}

#[cfg(windows)]
pub(crate) fn symlink_metadata(path: &Path) -> io::Result<Metadata> {
	windows::path_metadata(path, false)
}

#[cfg(not(windows))]
pub(crate) fn metadata(path: &Path) -> io::Result<Metadata> {
	fs::metadata(path).map(Metadata::from)
}

#[cfg(not(windows))]
pub(crate) fn symlink_metadata(path: &Path) -> io::Result<Metadata> {
	fs::symlink_metadata(path).map(Metadata::from)
}

pub(crate) fn read_dir(path: &Path) -> io::Result<ReadDir> {
	fs::read_dir(path).map(ReadDir::native)
}

pub(crate) fn create_dir(path: &Path, mode: Option<u32>, recursive: bool) -> io::Result<()> {
	let mut builder = fs::DirBuilder::new();
	builder.recursive(recursive);
	set_dir_mode(&mut builder, mode);
	builder.create(path)
}

/// Canonicalization steps against the host; every future is immediately
/// ready.
struct NativeResolver;

fn symlink_target(path: &Path) -> io::Result<Option<PathBuf>> {
	if fs::symlink_metadata(path)?.file_type().is_symlink() {
		fs::read_link(path).map(Some)
	} else {
		Ok(None)
	}
}

fn require_dir(path: &Path) -> io::Result<()> {
	if fs::metadata(path)?.is_dir() {
		Ok(())
	} else {
		Err(not_a_directory())
	}
}

impl Resolver for NativeResolver {
	fn symlink_target(
		&self,
		path: &Path,
	) -> impl Future<Output = io::Result<Option<PathBuf>>> + Send {
		ready(symlink_target(path))
	}

	fn exists(&self, path: &Path) -> impl Future<Output = bool> + Send {
		ready(path.exists())
	}

	fn require_dir(&self, path: &Path) -> impl Future<Output = io::Result<()>> + Send {
		ready(require_dir(path))
	}
}

/// uucore-compatible canonicalization of a host path. Relative paths are
/// taken relative to the process working directory, as uucore does.
pub(crate) fn canonicalize_with(path: &Path, options: CanonicalizeOptions) -> io::Result<PathBuf> {
	let absolute;
	let path = if path.is_absolute() {
		path
	} else {
		absolute = std::env::current_dir()?.join(path);
		absolute.as_path()
	};
	park_on(canonicalize(&NativeResolver, path, &options))
}
