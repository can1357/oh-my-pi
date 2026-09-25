//! Host filesystem operations. Everything here is synchronous: the facades
//! call it directly, without futures or boxing.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::{
	fs,
	future::{Future, ready},
	io,
	path::{Path, PathBuf},
};

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
	options.to_std().open(path).map(File::from)
}

pub(crate) fn metadata(path: &Path) -> io::Result<Metadata> {
	fs::metadata(path).map(Metadata::from)
}

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
