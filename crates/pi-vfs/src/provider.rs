//! The injectable filesystem provider trait.

use std::{
	ffi::{OsStr, OsString},
	fmt, io,
	path::{Path, PathBuf},
	sync::Arc,
};

use async_trait::async_trait;

use crate::{
	canonicalize::{Resolver, canonicalize},
	dir::ReadDir,
	error::{invalid_argument, not_a_directory, permission_denied, unsupported},
	file::{COPY_CHUNK, File},
	metadata::Metadata,
	options::{CanonicalizeOptions, OpenOptions},
	path::parent_path,
	types::{FileTime, NodeKind, Permissions, StatFs, SymlinkKind},
};

/// An asynchronous filesystem backend.
///
/// Providers receive every path verbatim — host paths and full
/// `scheme://authority/...` URLs alike — and own the [`File`], [`Metadata`],
/// and [`ReadDir`] values they return. Only `open`, `metadata`, and
/// `read_dir` are required; operations a provider cannot perform keep their
/// default, which is either a generic implementation on top of the required
/// operations or a real `Unsupported` error.
#[async_trait]
pub trait FileSystem: Send + Sync + fmt::Debug + 'static {
	/// Strong host capability: `true` promises that `path` and everything
	/// below it are ordinary host filesystem objects with no virtual
	/// descendants or interposition, so the facade may serve every operation
	/// on (and recursive operations under) `path` directly from the host —
	/// including fd-based traversal, native walkers, and recursive
	/// remove/copy that never re-check children. Return `false` for URLs and
	/// for ancestors of anything virtual. The default (`false`) is always
	/// safe.
	fn is_native_local(&self, _path: &Path) -> bool {
		false
	}

	/// The absolute host path a provider path is an alias of (e.g.
	/// `skill://name/SKILL.md` stored at `/home/u/.skills/name/SKILL.md`),
	/// for `realpath`/`readlink` style reporting. `Ok(None)` for pure virtual
	/// nodes and for paths that are not aliases. This is information, not a
	/// capability: operations on `path` still go through the provider.
	async fn backing_path(&self, _path: &Path) -> io::Result<Option<PathBuf>> {
		Ok(None)
	}

	/// The provider to use for cleaning up the caller's own artifacts (temp
	/// files, spill directories) after its run was cancelled; same namespace
	/// and policies, but no cancellation it would otherwise inherit. `None`
	/// (default) reuses this provider.
	fn for_cleanup(&self) -> Option<Arc<dyn FileSystem>> {
		None
	}

	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File>;

	/// Metadata following symlinks.
	async fn metadata(&self, path: &Path) -> io::Result<Metadata>;

	/// Metadata of the path itself; the default suits providers without
	/// symbolic links.
	async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
		self.metadata(path).await
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir>;

	async fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
		let file = self.open(path, OpenOptions::new().read(true)).await?;
		let mut contents = Vec::new();
		file.read_to_end_async(&mut contents).await?;
		file.close_async().await?;
		Ok(contents)
	}

	async fn write(&self, path: &Path, contents: &[u8]) -> io::Result<()> {
		let file = self
			.open(path, OpenOptions::new().write(true).create(true).truncate(true))
			.await?;
		file.write_all_async(contents).await?;
		file.close_async().await
	}

	/// Default: `EINVAL` for existing paths (nothing is a symlink).
	async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
		self.symlink_metadata(path).await?;
		Err(invalid_argument())
	}

	/// uucore-compatible canonicalization; the default resolves through
	/// `symlink_metadata`/`read_link`/`metadata`.
	async fn canonicalize(&self, path: &Path, options: &CanonicalizeOptions) -> io::Result<PathBuf> {
		canonicalize(&ProviderResolver(self), path, options).await
	}

	async fn create_dir(&self, _path: &Path, _mode: Option<u32>) -> io::Result<()> {
		Err(unsupported("create_dir"))
	}

	/// Default: `create_dir` on each missing ancestor.
	async fn create_dir_all(&self, path: &Path, mode: Option<u32>) -> io::Result<()> {
		match self.create_dir(path, mode).await {
			Ok(()) => return Ok(()),
			Err(err) if err.kind() == io::ErrorKind::NotFound => {},
			Err(err) => return existing_dir_or(self, path, err).await,
		}
		match parent_path(path) {
			Some(parent) if !parent.as_os_str().is_empty() => {
				self.create_dir_all(parent, mode).await?;
			},
			_ => return Err(io::Error::new(io::ErrorKind::NotFound, "failed to create whole tree")),
		}
		match self.create_dir(path, mode).await {
			Ok(()) => Ok(()),
			Err(err) => existing_dir_or(self, path, err).await,
		}
	}

	async fn remove_file(&self, _path: &Path) -> io::Result<()> {
		Err(unsupported("remove_file"))
	}

	async fn remove_dir(&self, _path: &Path) -> io::Result<()> {
		Err(unsupported("remove_dir"))
	}

	/// Default: depth-first `remove_file`/`remove_dir`; a symlink is removed
	/// itself, a non-directory is `ENOTDIR` (std semantics).
	async fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
		let file_type = self.symlink_metadata(path).await?.file_type();
		if file_type.is_symlink() {
			return self.remove_file(path).await;
		}
		if !file_type.is_dir() {
			return Err(not_a_directory());
		}
		let entries = self.read_dir(path).await?.collect::<io::Result<Vec<_>>>()?;
		for entry in entries {
			let child = entry.path();
			let is_dir = match entry.known_file_type() {
				Some(file_type) => file_type.is_dir(),
				None => self.symlink_metadata(&child).await?.is_dir(),
			};
			if is_dir {
				self.remove_dir_all(&child).await?;
			} else {
				self.remove_file(&child).await?;
			}
		}
		self.remove_dir(path).await
	}

	/// Must not copy: moves between backends are `EXDEV`
	/// ([`crate::crosses_devices`]).
	async fn rename(&self, _from: &Path, _to: &Path) -> io::Result<()> {
		Err(unsupported("rename"))
	}

	/// Default: streams contents, then copies permission bits when the
	/// provider supports them. Returns the byte count.
	async fn copy(&self, from: &Path, to: &Path) -> io::Result<u64> {
		let metadata = self.metadata(from).await?;
		if !metadata.is_file() {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"the source path is neither a regular file nor a symlink to a regular file",
			));
		}
		let source = self.open(from, OpenOptions::new().read(true)).await?;
		let target = self
			.open(to, OpenOptions::new().write(true).create(true).truncate(true))
			.await?;
		let mut chunk = vec![0; COPY_CHUNK];
		let mut copied = 0u64;
		loop {
			let n = match source.read_async(&mut chunk).await {
				Ok(0) => break,
				Ok(n) => n,
				Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
				Err(err) => return Err(err),
			};
			target.write_all_async(&chunk[..n]).await?;
			copied += n as u64;
		}
		target.close_async().await?;
		source.close_async().await?;
		match self.set_permissions(to, metadata.permissions()).await {
			Err(err) if err.kind() != io::ErrorKind::Unsupported => Err(err),
			_ => Ok(copied),
		}
	}

	async fn hard_link(&self, _original: &Path, _link: &Path) -> io::Result<()> {
		Err(unsupported("hard_link"))
	}

	async fn symlink(&self, _target: &Path, _link: &Path, _kind: SymlinkKind) -> io::Result<()> {
		Err(unsupported("symlink"))
	}

	/// Follows symlinks.
	async fn set_permissions(&self, _path: &Path, _permissions: Permissions) -> io::Result<()> {
		Err(unsupported("set_permissions"))
	}

	async fn set_times(
		&self,
		_path: &Path,
		_accessed: FileTime,
		_modified: FileTime,
		_follow: bool,
	) -> io::Result<()> {
		Err(unsupported("set_times"))
	}

	async fn chown(
		&self,
		_path: &Path,
		_uid: Option<u32>,
		_gid: Option<u32>,
		_follow: bool,
	) -> io::Result<()> {
		Err(unsupported("chown"))
	}

	/// `access(2)`; all flags `false` checks existence. The default judges
	/// the permission bits of [`FileSystem::metadata`].
	async fn access(&self, path: &Path, read: bool, write: bool, execute: bool) -> io::Result<()> {
		let mode = self.metadata(path).await?.permissions().mode();
		let denied = (read && mode & 0o444 == 0)
			|| (write && mode & 0o222 == 0)
			|| (execute && mode & 0o111 == 0);
		if denied {
			Err(permission_denied())
		} else {
			Ok(())
		}
	}

	async fn stat_fs(&self, _path: &Path) -> io::Result<StatFs> {
		Err(unsupported("statfs"))
	}

	async fn list_xattr(&self, _path: &Path, _follow: bool) -> io::Result<Vec<OsString>> {
		Err(unsupported("listxattr"))
	}

	/// `Ok(None)` when the attribute is absent.
	async fn get_xattr(
		&self,
		_path: &Path,
		_name: &OsStr,
		_follow: bool,
	) -> io::Result<Option<Vec<u8>>> {
		Err(unsupported("getxattr"))
	}

	async fn set_xattr(
		&self,
		_path: &Path,
		_name: &OsStr,
		_value: &[u8],
		_follow: bool,
	) -> io::Result<()> {
		Err(unsupported("setxattr"))
	}

	async fn remove_xattr(&self, _path: &Path, _name: &OsStr, _follow: bool) -> io::Result<()> {
		Err(unsupported("removexattr"))
	}

	async fn make_node(&self, _path: &Path, _kind: NodeKind, _mode: u32) -> io::Result<()> {
		Err(unsupported("mknod"))
	}
}

/// `Ok` when `path` already is a directory (`mkdir -p` semantics), else `err`.
async fn existing_dir_or<P: FileSystem + ?Sized>(
	fs: &P,
	path: &Path,
	err: io::Error,
) -> io::Result<()> {
	match fs.metadata(path).await {
		Ok(metadata) if metadata.is_dir() => Ok(()),
		_ => Err(err),
	}
}

/// Resolves canonicalization steps through a provider.
struct ProviderResolver<'a, P: ?Sized>(&'a P);

impl<P: FileSystem + ?Sized> Resolver for ProviderResolver<'_, P> {
	async fn symlink_target(&self, path: &Path) -> io::Result<Option<PathBuf>> {
		if self.0.symlink_metadata(path).await?.is_symlink() {
			self.0.read_link(path).await.map(Some)
		} else {
			Ok(None)
		}
	}

	async fn exists(&self, path: &Path) -> bool {
		self.0.metadata(path).await.is_ok()
	}

	async fn require_dir(&self, path: &Path) -> io::Result<()> {
		if self.0.metadata(path).await?.is_dir() {
			Ok(())
		} else {
			Err(not_a_directory())
		}
	}
}
