//! Confined filesystem access for one side of a transfer.
//!
//! Every access the generator, receiver, sender, and metadata code make below
//! a transfer root goes through a [`Tree`], mirroring rsync 3.5's hardened
//! resolver (NEWS 3.5.0: CVE-2026-53785/53793/53795/53796/53797/53799/53800).
//!
//! **Native unix trees** hold a directory fd for the root and resolve every
//! relative path one element at a time with `openat(O_NOFOLLOW)` on a stack of
//! held directory fds:
//!
//! - a real subdirectory is pushed; `.` stays put;
//! - an in-tree directory symlink is followed by reading its target and walking
//!   that on the same stack: absolute targets are refused (`ELOOP`), a `..` in a
//!   target pops to the already-held parent and never above the root (`ELOOP`),
//!   and at most 40 symlinks are expanded per resolution;
//! - the caller's own path may not be absolute or contain `..` (`EINVAL`);
//! - a non-directory in the middle of the parent chain is `ELOOP` (only the
//!   last parent element reports `ENOTDIR`), as upstream's resolver reports it.
//!
//! The parent directory is resolved that way and the operation is then issued
//! with the `*at()` call on the held parent fd and the leaf name, never
//! following a final symlink unless the method says so. A rename or hard link
//! between two trees resolves each side in its own tree (CVE-2026-53795).
//! `--insecure-links` keeps the held root fd but lets the kernel resolve the
//! whole relative path (legacy path semantics).
//!
//! **Path-based trees** (virtual `BlockingFs` providers everywhere, and every
//! native tree on Windows, which has no `openat`) offer the same API: each
//! element is checked with no-follow metadata (`symlink_metadata`; reparse
//! points are symlinks) and in-tree directory symlinks are expanded with the
//! same rules, then the operation is issued on the resulting path. Unlike the
//! fd walk this leaves a window between the check and the use in which a
//! component can be swapped; that residual is inherent to path-based access.

#[cfg(unix)]
pub(crate) mod sys;

#[cfg(unix)]
use std::{
	ffi::CString,
	os::{
		fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd},
		unix::ffi::OsStrExt,
	},
};
use std::{
	ffi::{OsStr, OsString},
	fmt,
	hash::{BuildHasher, Hasher},
	io,
	path::{Path, PathBuf},
	sync::{
		Arc, LazyLock,
		atomic::{AtomicU64, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

use pi_vfs::{BlockingFs, DirOptions, FileTime, Metadata, NodeKind, OpenOptions, Permissions};

use crate::rsync::consts::MAXPATHLEN;
use crate::rsync::paths::{self, is_absolute_bytes, is_separator};
use crate::rsync::time::split_time;

/// Policy for a transfer tree.
#[derive(Clone, Debug, Default)]
pub(crate) struct TreeOpts {
	/// --insecure-links: legacy path-based follows.
	pub insecure_links: bool,
	/// The operator named this root (3.5 rule: follow a symlinked root only if owned by root or us).
	pub operator_named: bool,
	/// --confine-root.
	pub confine: Option<PathBuf>,
}

/// Symlink expansions allowed in one resolution (upstream SECURE_OPEN_MAXSYMLINKS).
const MAX_SYMLINKS: u32 = 40;
/// Directory levels held open at once in one resolution (upstream DS_MAXDEPTH).
const MAX_DEPTH: usize = 1024;
/// The mkstemp placeholder upstream appends to temp names.
const TMPNAME_SUFFIX: &[u8] = b".XXXXXX";
/// Upper bound of the `make_unique` counter.
const MAX_UNIQUE_NUMBER: u32 = 999_999;
/// Names tried by the `make_unique` counter.
const MAX_UNIQUE_LOOP: u32 = 100;
/// Random names tried by `create_temp`.
const TEMP_TRIES: usize = 100;
/// Upstream `NAME_MAX`.
const NAME_MAX: usize = 255;

/// Portable OS errors with errno semantics.
mod err {
	use std::io;

	#[cfg(unix)]
	mod code {
		pub(super) const INVAL: i32 = libc::EINVAL;
		pub(super) const NOTDIR: i32 = libc::ENOTDIR;
		pub(super) const EXIST: i32 = libc::EEXIST;
		pub(super) const XDEV: i32 = libc::EXDEV;
		pub(super) const NAMETOOLONG: i32 = libc::ENAMETOOLONG;
		pub(super) const NOMEM: i32 = libc::ENOMEM;
		pub(super) const NOTSUP: i32 = libc::EOPNOTSUPP;
	}

	#[cfg(not(unix))]
	mod code {
		pub(super) const INVAL: i32 = 87; // ERROR_INVALID_PARAMETER
		pub(super) const NOTDIR: i32 = 267; // ERROR_DIRECTORY
		pub(super) const EXIST: i32 = 183; // ERROR_ALREADY_EXISTS
		pub(super) const NAMETOOLONG: i32 = 206; // ERROR_FILENAME_EXCED_RANGE
		pub(super) const NOMEM: i32 = 8; // ERROR_NOT_ENOUGH_MEMORY
		pub(super) const NOTSUP: i32 = 50; // ERROR_NOT_SUPPORTED
	}

	pub(super) fn invalid() -> io::Error {
		io::Error::from_raw_os_error(code::INVAL)
	}

	pub(super) fn not_dir() -> io::Error {
		io::Error::from_raw_os_error(code::NOTDIR)
	}

	pub(super) fn exists() -> io::Error {
		io::Error::from_raw_os_error(code::EXIST)
	}

	#[cfg(unix)]
	pub(super) fn cross_device() -> io::Error {
		io::Error::from_raw_os_error(code::XDEV)
	}

	pub(super) fn too_long() -> io::Error {
		io::Error::from_raw_os_error(code::NAMETOOLONG)
	}

	pub(super) fn no_mem() -> io::Error {
		io::Error::from_raw_os_error(code::NOMEM)
	}

	pub(super) fn unsupported() -> io::Error {
		io::Error::from_raw_os_error(code::NOTSUP)
	}

	pub(super) fn looped() -> io::Error {
		crate::rsync::paths::loop_error()
	}

	pub(super) fn is_dir() -> io::Error {
		#[cfg(unix)]
		return io::Error::from_raw_os_error(libc::EISDIR);
		#[cfg(not(unix))]
		return io::Error::from(io::ErrorKind::IsADirectory);
	}
}

/// The non-empty elements of a relative path.
fn elements(bytes: &[u8]) -> Vec<&[u8]> {
	bytes.split(|&b| is_separator(b)).filter(|el| !el.is_empty()).collect()
}

/// A transfer root through which every filesystem access of one side goes. Native trees
/// hold a directory fd and resolve every relative path component by component with
/// O_NOFOLLOW (in-tree directory symlinks followed per 3.5.0 rules); virtual trees go
/// through BlockingFs. Cheap to clone; Send + Sync.
#[derive(Clone)]
pub(crate) struct Tree {
	inner: Arc<Inner>,
}

struct Inner {
	root: PathBuf,
	opts: TreeOpts,
	fs: BlockingFs,
	/// The shell's creation mask, applied exactly to directories and nodes
	/// created through a native tree.
	mask: Option<u32>,
	backend: Backend,
}

enum Backend {
	/// Held root directory fd (unix).
	#[cfg(unix)]
	Native(OwnedFd),
	/// Path-based access through `BlockingFs`; `native` = host paths.
	Paths { native: bool },
}

impl fmt::Debug for Tree {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let backend = match &self.inner.backend {
			#[cfg(unix)]
			Backend::Native(fd) => format!("fd {}", fd.as_raw_fd()),
			Backend::Paths { native: true } => "host paths".to_owned(),
			Backend::Paths { native: false } => "provider paths".to_owned(),
		};
		f.debug_struct("Tree")
			.field("root", &self.inner.root)
			.field("backend", &backend)
			.field("opts", &self.inner.opts)
			.finish()
	}
}

/// A held directory: the tree's root (borrowed) or one opened by a walk.
#[cfg(unix)]
enum Dir<'a> {
	Borrowed(BorrowedFd<'a>),
	Owned(OwnedFd),
}

#[cfg(unix)]
impl Dir<'_> {
	fn fd(&self) -> BorrowedFd<'_> {
		match self {
			Self::Borrowed(fd) => *fd,
			Self::Owned(fd) => fd.as_fd(),
		}
	}

	fn some(&self) -> Option<BorrowedFd<'_>> {
		Some(self.fd())
	}
}

/// A resolved parent directory plus the leaf name to operate on.
#[cfg(unix)]
struct Located<'a> {
	dir: Dir<'a>,
	name: CString,
	/// The leaf sits directly in the root (no parent element).
	top_level: bool,
}

/// The held-fd stack of one native resolution.
#[cfg(unix)]
struct Walk<'a> {
	anchor: BorrowedFd<'a>,
	stack: Vec<OwnedFd>,
	hops: u32,
}

#[cfg(unix)]
impl<'a> Walk<'a> {
	const fn new(anchor: BorrowedFd<'a>) -> Self {
		Self { anchor, stack: Vec::new(), hops: MAX_SYMLINKS }
	}

	fn cur(&self) -> BorrowedFd<'_> {
		self.stack.last().map_or(self.anchor, AsFd::as_fd)
	}

	/// Walks `parts` as directories. A non-directory before the last part
	/// reports `ELOOP`, like upstream's resolver.
	fn walk(&mut self, parts: &[&[u8]]) -> io::Result<()> {
		for (i, part) in parts.iter().enumerate() {
			if let Err(error) = self.descend(part) {
				if i + 1 < parts.len() && error.kind() == io::ErrorKind::NotADirectory {
					return Err(err::looped());
				}
				return Err(error);
			}
		}
		Ok(())
	}

	/// One element: `.` stays, `..` pops (never above the anchor), a real
	/// directory is pushed, an in-tree directory symlink is expanded.
	fn descend(&mut self, part: &[u8]) -> io::Result<()> {
		match part {
			b"." => return Ok(()),
			b".." => return self.stack.pop().map(drop).ok_or_else(err::looped),
			_ => {},
		}
		let name = sys::cstr(part)?;
		let cur = self.cur();
		let opened = sys::openat(Some(cur), &name, sys::TRAVERSE | libc::O_NOFOLLOW, 0);
		let error = match opened {
			Ok(fd) => {
				if self.stack.len() + 1 >= MAX_DEPTH {
					return Err(err::no_mem());
				}
				self.stack.push(fd);
				return Ok(());
			},
			Err(error) => error,
		};
		let code = error.raw_os_error().unwrap_or(0);
		if code != libc::ENOTDIR && !sys::nofollow_hit(code) {
			return Err(error);
		}
		let target = match sys::readlinkat(Some(self.cur()), &name) {
			Ok(target) => target,
			Err(probe) if probe.raw_os_error() == Some(libc::EINVAL) => return Err(error),
			Err(probe) => return Err(probe),
		};
		if target.is_empty() || target.len() >= MAXPATHLEN - 1 || target[0] == b'/' {
			return Err(err::looped());
		}
		if self.hops == 0 {
			return Err(err::looped());
		}
		self.hops -= 1;
		for el in target.split(|&b| b == b'/').filter(|el| !el.is_empty()) {
			self.descend(el)?;
		}
		Ok(())
	}

	fn into_dir(mut self) -> Dir<'a> {
		match self.stack.pop() {
			Some(fd) => Dir::Owned(fd),
			None => Dir::Borrowed(self.anchor),
		}
	}
}

impl Tree {
	/// Opens a transfer root. Native unix roots are opened as a directory fd:
	/// an operator-named root (or one under `--confine-root`) through the
	/// trusted-owner walk, so a symlinked root is followed only when owned by
	/// root or us (else upstream's refusal, see
	/// [`paths::is_untrusted_symlink`]); other roots with a plain follow.
	/// Path-based roots get the same checks by metadata.
	pub(crate) fn open(fs: &BlockingFs, root: &Path, opts: &TreeOpts) -> io::Result<Self> {
		let mask = fs.creation_mask();
		let walk_root = !opts.insecure_links && (opts.operator_named || opts.confine.is_some());
		#[cfg(unix)]
		if fs.is_native_local(root) {
			let fd = if walk_root {
				paths::open_operator_dir(
					root,
					false,
					opts.confine.as_deref(),
					&paths::trusted_owner,
				)?
			} else {
				let bytes = root.as_os_str().as_bytes();
				let bytes = if bytes.is_empty() { &b"."[..] } else { bytes };
				sys::openat(None, &sys::cstr(bytes)?, sys::TRAVERSE, 0)?
			};
			return Ok(Self::build(root.to_path_buf(), opts.clone(), fs, mask, Backend::Native(fd)));
		}
		let native = fs.is_native_local(root);
		if walk_root {
			paths::virtual_owner_walk(fs, root, &paths::trusted_owner)?;
			if let Some(confine) = &opts.confine {
				let resolved = fs.canonicalize(root)?;
				let confine = fs.canonicalize(confine).unwrap_or_else(|_| confine.clone());
				if !paths::within_confine(&resolved, &confine) {
					return Err(err::looped());
				}
			}
		}
		if !fs.metadata(root)?.is_dir() {
			return Err(err::not_dir());
		}
		Ok(Self::build(root.to_path_buf(), opts.clone(), fs, mask, Backend::Paths { native }))
	}

	fn build(
		root: PathBuf,
		opts: TreeOpts,
		fs: &BlockingFs,
		mask: Option<u32>,
		backend: Backend,
	) -> Self {
		Self { inner: Arc::new(Inner { root, opts, fs: fs.clone(), mask, backend }) }
	}

	/// The root as given (or as resolved, for a path-based subtree).
	pub(crate) fn root(&self) -> &Path {
		&self.inner.root
	}

	fn insecure(&self) -> bool {
		self.inner.opts.insecure_links
	}

	/// Host paths on Windows (where owner/xattr semantics differ).
	#[cfg(windows)]
	fn windows_native(&self) -> bool {
		matches!(self.inner.backend, Backend::Paths { native: true })
	}

	/// Validated elements of a caller-supplied relative path.
	fn checked<'p>(&self, rel: &'p Path) -> io::Result<Vec<&'p [u8]>> {
		let bytes = paths::os_bytes(rel.as_os_str())?;
		if is_absolute_bytes(bytes) {
			return Err(err::invalid());
		}
		let parts = elements(bytes);
		if parts.iter().any(|el| *el == b"..") {
			return Err(err::invalid());
		}
		Ok(parts)
	}

	// ----- native resolution -------------------------------------------------

	#[cfg(unix)]
	fn native_root(&self) -> Option<BorrowedFd<'_>> {
		match &self.inner.backend {
			Backend::Native(fd) => Some(fd.as_fd()),
			Backend::Paths { .. } => None,
		}
	}

	/// The held parent of `rel` and its leaf (`.` for the root itself).
	#[cfg(unix)]
	fn locate<'a>(&self, root: BorrowedFd<'a>, rel: &Path) -> io::Result<Located<'a>> {
		if self.insecure() {
			let bytes = rel.as_os_str().as_bytes();
			let top_level = !bytes.contains(&b'/');
			let bytes = if bytes.is_empty() { &b"."[..] } else { bytes };
			return Ok(Located { dir: Dir::Borrowed(root), name: sys::cstr(bytes)?, top_level });
		}
		let parts = self.checked(rel)?;
		let Some((leaf, parents)) = parts.split_last() else {
			return Ok(Located { dir: Dir::Borrowed(root), name: sys::cstr(b".")?, top_level: true });
		};
		let mut walk = Walk::new(root);
		walk.walk(parents)?;
		Ok(Located { dir: walk.into_dir(), name: sys::cstr(leaf)?, top_level: parents.is_empty() })
	}

	/// `rel` itself resolved as a directory (in-tree symlinks followed).
	#[cfg(unix)]
	fn native_dir<'a>(&self, root: BorrowedFd<'a>, rel: &Path) -> io::Result<Dir<'a>> {
		if self.insecure() {
			let bytes = rel.as_os_str().as_bytes();
			if bytes.is_empty() {
				return Ok(Dir::Borrowed(root));
			}
			return sys::openat(Some(root), &sys::cstr(bytes)?, sys::TRAVERSE, 0).map(Dir::Owned);
		}
		let parts = self.checked(rel)?;
		let mut walk = Walk::new(root);
		walk.walk(&parts)?;
		Ok(walk.into_dir())
	}

	// ----- path-based resolution --------------------------------------------

	fn join_raw(&self, rel: &Path) -> PathBuf {
		pi_vfs::join_path(&self.inner.root, rel)
	}

	fn build_path<B: AsRef<[u8]>>(&self, resolved: &[B]) -> io::Result<PathBuf> {
		let mut path = self.inner.root.clone();
		for el in resolved {
			path = pi_vfs::join_path(&path, Path::new(paths::bytes_os(el.as_ref())?));
		}
		Ok(path)
	}

	/// The path of `rel` with its parent elements checked and resolved.
	fn path_of(&self, rel: &Path) -> io::Result<PathBuf> {
		if self.insecure() {
			return Ok(self.join_raw(rel));
		}
		let parts = self.checked(rel)?;
		let Some((leaf, parents)) = parts.split_last() else {
			return Ok(self.inner.root.clone());
		};
		let mut resolved = self.path_walk(parents)?;
		resolved.push(leaf.to_vec());
		self.build_path(&resolved)
	}

	/// The path of `rel` resolved as a directory.
	fn dir_path_of(&self, rel: &Path) -> io::Result<PathBuf> {
		if self.insecure() {
			return Ok(self.join_raw(rel));
		}
		let parts = self.checked(rel)?;
		let resolved = self.path_walk(&parts)?;
		self.build_path(&resolved)
	}

	fn path_walk(&self, parts: &[&[u8]]) -> io::Result<Vec<Vec<u8>>> {
		let mut resolved = Vec::new();
		let mut hops = MAX_SYMLINKS;
		for (i, part) in parts.iter().enumerate() {
			if let Err(error) = self.path_descend(part, &mut resolved, &mut hops) {
				if i + 1 < parts.len() && error.kind() == io::ErrorKind::NotADirectory {
					return Err(err::looped());
				}
				return Err(error);
			}
		}
		Ok(resolved)
	}

	fn path_descend(&self, part: &[u8], resolved: &mut Vec<Vec<u8>>, hops: &mut u32) -> io::Result<()> {
		match part {
			b"." => return Ok(()),
			b".." => return resolved.pop().map(drop).ok_or_else(err::looped),
			_ => {},
		}
		if resolved.len() + 1 >= MAX_DEPTH {
			return Err(err::no_mem());
		}
		resolved.push(part.to_vec());
		let path = self.build_path(resolved)?;
		let meta = self.inner.fs.symlink_metadata(&path);
		let meta = match meta {
			Ok(meta) if meta.is_dir() => return Ok(()),
			Ok(meta) => meta,
			Err(error) => {
				resolved.pop();
				return Err(error);
			},
		};
		resolved.pop();
		if !meta.is_symlink() {
			return Err(err::not_dir());
		}
		let target = self.inner.fs.read_link(&path)?;
		let target = paths::os_bytes(target.as_os_str())?;
		if target.is_empty() || target.len() >= MAXPATHLEN - 1 || is_absolute_bytes(target) {
			return Err(err::looped());
		}
		if *hops == 0 {
			return Err(err::looped());
		}
		*hops -= 1;
		for el in elements(target) {
			self.path_descend(el, resolved, hops)?;
		}
		Ok(())
	}

	// ----- queries ------------------------------------------------------------

	/// Metadata of `rel` itself (a final symlink is not followed).
	pub(crate) fn lstat(&self, rel: &Path) -> io::Result<Metadata> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			return Ok(sys::metadata(&sys::fstatat(at.dir.some(), &at.name, true)?));
		}
		self.inner.fs.symlink_metadata(self.path_of(rel)?)
	}

	/// Metadata of `rel`, following a final symlink.
	pub(crate) fn stat(&self, rel: &Path) -> io::Result<Metadata> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			return Ok(sys::metadata(&sys::fstatat(at.dir.some(), &at.name, false)?));
		}
		self.inner.fs.metadata(self.path_of(rel)?)
	}

	/// Entry names of the directory `rel` (without `.`/`..`, unsorted).
	pub(crate) fn read_dir(&self, rel: &Path) -> io::Result<Vec<OsString>> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let dir = self.native_dir(root, rel)?;
			let fd = sys::openat(dir.some(), c".", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
			return sys::read_dir(fd);
		}
		self.inner
			.fs
			.read_dir(self.dir_path_of(rel)?)?
			.map(|entry| entry.map(|entry| entry.file_name()))
			.collect()
	}

	/// The target of the symlink `rel`.
	pub(crate) fn read_link(&self, rel: &Path) -> io::Result<PathBuf> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			use std::os::unix::ffi::OsStringExt;
			let at = self.locate(root, rel)?;
			let target = sys::readlinkat(at.dir.some(), &at.name)?;
			return Ok(PathBuf::from(OsString::from_vec(target)));
		}
		self.inner.fs.read_link(self.path_of(rel)?)
	}

	// ----- file opens ---------------------------------------------------------

	/// Opens `rel` for reading. Without `follow` a final symlink is refused
	/// (`ELOOP`) and a directory is `EISDIR`; with it (`-L`, `-k`,
	/// `--copy-unsafe-links`) the final symlink is followed wherever it leads.
	pub(crate) fn open_read(&self, rel: &Path, follow: bool) -> io::Result<pi_vfs::File> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			let mut flags = libc::O_RDONLY | libc::O_NOCTTY;
			if !follow {
				flags |= libc::O_NOFOLLOW;
			}
			let fd = sys::openat(at.dir.some(), &at.name, flags, 0)?;
			if !follow && sys::is_dir(&sys::fstat(fd.as_fd())?) {
				return Err(err::is_dir());
			}
			return Ok(pi_vfs::File::from(std::fs::File::from(fd)));
		}
		let path = self.path_of(rel)?;
		if !follow {
			let meta = self.inner.fs.symlink_metadata(&path)?;
			if meta.is_symlink() {
				return Err(err::looped());
			}
			if meta.is_dir() {
				return Err(err::is_dir());
			}
		}
		self.inner.fs.open(&path)
	}

	/// Opens `rel` for writing without following a final symlink; `create`
	/// makes it (mode 0600, as upstream's in-place receiver) when missing.
	pub(crate) fn open_write(
		&self,
		rel: &Path,
		create: bool,
		truncate: bool,
	) -> io::Result<pi_vfs::File> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			let mut flags = libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_NOCTTY;
			if create {
				flags |= libc::O_CREAT;
			}
			if truncate {
				flags |= libc::O_TRUNC;
			}
			let fd = sys::openat(at.dir.some(), &at.name, flags, 0o600)?;
			return Ok(pi_vfs::File::from(std::fs::File::from(fd)));
		}
		let path = self.path_of(rel)?;
		if let Ok(meta) = self.inner.fs.symlink_metadata(&path)
			&& meta.is_symlink()
		{
			return Err(err::looped());
		}
		let mut options = OpenOptions::new();
		options.write(true).create(create).truncate(truncate).mode(0o600);
		self.inner.fs.open_with(&path, &options)
	}

	/// mkstemp-style temp file in `dir` with upstream get_tmpname naming:
	/// `.<name>.XXXXXX`, or `<name>.XXXXXX` (the `--temp-dir` spelling) when
	/// `dotted` is false. Created `O_CREAT|O_EXCL|O_NOFOLLOW`
	/// with `mode | S_IWUSR`, then that mode is applied exactly (a failure to
	/// apply it is ignored, as upstream does without `-p`). Returns the path of
	/// the new file relative to this tree.
	pub(crate) fn create_temp_with(
		&self,
		dir: &Path,
		name: &OsStr,
		mode: u32,
		dotted: bool,
	) -> io::Result<(PathBuf, pi_vfs::File)> {
		let dir_bytes = paths::os_bytes(dir.as_os_str())?;
		let dir_len = if dir_bytes.is_empty() { 0 } else { dir_bytes.len() + 1 };
		let mut template = temp_template(paths::os_bytes(name)?, dir_len, dotted)?;
		let perms = (mode | 0o200) & 0o7777;
		let suffix_at = template.len() - 6;

		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let parent = self.native_dir(root, dir)?;
			for _ in 0..TEMP_TRIES {
				random_suffix(&mut template[suffix_at..]);
				let name = sys::cstr(&template)?;
				let flags = libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW;
				match sys::openat(parent.some(), &name, flags, perms) {
					Ok(fd) => {
						let _ = sys::fchmod(fd.as_fd(), perms);
						let file = pi_vfs::File::from(std::fs::File::from(fd));
						return Ok((dir.join(paths::bytes_os(&template)?), file));
					},
					Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {},
					Err(error) => return Err(error),
				}
			}
			return Err(err::exists());
		}

		let parent = self.dir_path_of(dir)?;
		for _ in 0..TEMP_TRIES {
			random_suffix(&mut template[suffix_at..]);
			let leaf = paths::bytes_os(&template)?;
			let mut options = OpenOptions::new();
			options.read(true).write(true).create_new(true).mode(perms);
			match self.inner.fs.open_with(pi_vfs::join_path(&parent, Path::new(leaf)), &options) {
				Ok(file) => {
					let _ = file.set_permissions(Permissions::from_mode(perms));
					return Ok((dir.join(leaf), file));
				},
				Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
				Err(error) => return Err(error),
			}
		}
		Err(err::exists())
	}

	/// Upstream get_tmpname with `make_unique`: `.<name>.<counter>` that does
	/// not exist yet in `dir` (for links, devices and specials created beside
	/// their final name). Fails with `EEXIST` after 100 tries.
	pub(crate) fn unique_temp_name(
		&self,
		dir: &Path,
		name: &OsStr,
		dotted: bool,
	) -> io::Result<PathBuf> {
		static LIMIT: LazyLock<u32> = LazyLock::new(|| {
			let limit = std::process::id().saturating_add(MAX_UNIQUE_LOOP);
			if limit > MAX_UNIQUE_NUMBER || limit < MAX_UNIQUE_LOOP {
				MAX_UNIQUE_LOOP
			} else {
				limit
			}
		});
		let limit = *LIMIT;
		let dir_bytes = paths::os_bytes(dir.as_os_str())?;
		let dir_len = if dir_bytes.is_empty() { 0 } else { dir_bytes.len() + 1 };
		let template = temp_template(paths::os_bytes(name)?, dir_len, dotted)?;
		let base = &template[..template.len() - TMPNAME_SUFFIX.len()];
		for counter in limit - MAX_UNIQUE_LOOP..limit {
			let mut suffix = format!(".{counter}").into_bytes();
			suffix.truncate(TMPNAME_SUFFIX.len());
			let mut candidate = base.to_vec();
			candidate.extend_from_slice(&suffix);
			let rel = dir.join(paths::bytes_os(&candidate)?);
			if self.stat(&rel).is_err() {
				return Ok(rel);
			}
		}
		Err(err::exists())
	}

	// ----- creation -----------------------------------------------------------

	/// Creates the directory `rel` (mode subject to the creation mask).
	pub(crate) fn mkdir(&self, rel: &Path, mode: u32) -> io::Result<()> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			sys::mkdirat(at.dir.some(), &at.name, mode & 0o7777)?;
			self.apply_mask(&at, mode);
			return Ok(());
		}
		self.inner.fs.create_dir_with(self.path_of(rel)?, &DirOptions::new().mode(mode & 0o7777))
	}

	/// Upstream make_path, each component confined (CVE-2026-53785): creates
	/// the missing directories of `rel` (its
	/// parents only with `drop_name`), deepest existing one first, and returns
	/// how many were created. A leading `/` or `./` is skipped. An existing
	/// non-directory at the deepest level fails with `EEXIST`, as upstream.
	pub(crate) fn make_path_count(&self, rel: &Path, mode: u32, drop_name: bool) -> io::Result<usize> {
		let mut bytes = paths::os_bytes(rel.as_os_str())?;
		while bytes.first().is_some_and(|&b| is_separator(b)) {
			bytes = &bytes[1..];
		}
		while bytes.len() >= 2 && bytes[0] == b'.' && is_separator(bytes[1]) {
			bytes = &bytes[2..];
		}
		if drop_name {
			match bytes.iter().rposition(|&b| is_separator(b)) {
				None | Some(0) => return Ok(0),
				Some(end) => bytes = &bytes[..end],
			}
		}
		if bytes.is_empty() {
			return Ok(0);
		}
		// Ends of every prefix that names a directory, shallowest first.
		let mut ends: Vec<usize> =
			(1..bytes.len()).filter(|&i| is_separator(bytes[i]) && !is_separator(bytes[i - 1])).collect();
		ends.push(bytes.len());
		let prefix = |k: usize| -> io::Result<PathBuf> { Ok(PathBuf::from(paths::bytes_os(&bytes[..ends[k]])?)) };

		let mut created = 0;
		let mut existing = ends.len();
		loop {
			let path = prefix(existing - 1)?;
			match self.mkdir(&path, mode) {
				Ok(()) => {
					created = 1;
					break;
				},
				Err(error) if error.kind() == io::ErrorKind::NotFound => {
					existing -= 1;
					if existing == 0 {
						break;
					}
				},
				Err(error) => {
					if error.kind() != io::ErrorKind::AlreadyExists
						|| self.stat(&path).is_ok_and(|meta| !meta.is_dir())
					{
						return Err(error);
					}
					break;
				},
			}
		}
		for k in existing..ends.len() {
			self.mkdir(&prefix(k)?, mode)?;
			created += 1;
		}
		Ok(created)
	}

	/// Creates the symlink `rel` -> `target` (stored verbatim; on Windows `/`
	/// becomes `\`).
	pub(crate) fn symlink(&self, target: &Path, rel: &Path) -> io::Result<()> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			return sys::symlinkat(&sys::cstr(target.as_os_str().as_bytes())?, at.dir.some(), &at.name);
		}
		#[cfg(windows)]
		let converted = PathBuf::from(target.to_str().ok_or_else(paths::bad_name)?.replace('/', "\\"));
		#[cfg(windows)]
		let target = converted.as_path();
		self.inner.fs.symlink(target, self.path_of(rel)?)
	}

	/// Creates a device, FIFO, socket, or empty regular file at `rel`.
	/// Where `mknod` cannot make a socket (macOS, the BSDs) a top-level one is
	/// bound relative to the held root, so long destination paths work; a
	/// nested one cannot be created race-free and fails with `EOPNOTSUPP`
	/// (upstream 3.5 behavior) unless `--insecure-links`.
	pub(crate) fn mknod(&self, rel: &Path, kind: NodeKind, mode: u32) -> io::Result<()> {
		let perm = mode & 0o7777;
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			let dir = at.dir.some();
			match kind {
				NodeKind::Regular => {
					let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW;
					drop(sys::openat(dir, &at.name, flags, perm)?);
				},
				NodeKind::Fifo => {
					if sys::mknodat(dir, &at.name, libc::S_IFIFO as u32 | perm, 0).is_err() {
						sys::mkfifoat(dir, &at.name, perm)?;
					}
				},
				NodeKind::Socket => {
					if sys::mknodat(dir, &at.name, libc::S_IFSOCK as u32 | perm, 0).is_err() {
						if !at.top_level && !self.insecure() {
							return Err(err::unsupported());
						}
						let path = self.inner.root.join(OsStr::from_bytes(at.name.as_bytes()));
						sys::bind_socket_at(at.dir.fd(), &at.name, &path)?;
						chmod_nofollow(at.dir.fd(), &at.name, perm)?;
					}
				},
				NodeKind::CharDevice(rdev) => {
					sys::mknodat(dir, &at.name, libc::S_IFCHR as u32 | perm, rdev)?;
				},
				NodeKind::BlockDevice(rdev) => {
					sys::mknodat(dir, &at.name, libc::S_IFBLK as u32 | perm, rdev)?;
				},
			}
			self.apply_mask(&at, perm);
			return Ok(());
		}
		self.inner.fs.make_node(self.path_of(rel)?, kind, perm)
	}

	/// Sets the exact mode `mode & !mask` on a node just created, keeping
	/// special bits the kernel set (inherited setgid). Best effort.
	#[cfg(unix)]
	fn apply_mask(&self, at: &Located<'_>, mode: u32) {
		let Some(mask) = self.inner.mask else {
			return;
		};
		let Ok(st) = sys::fstatat(at.dir.some(), &at.name, true) else {
			return;
		};
		let current = sys::st_mode(&st) & 0o7777;
		let wanted = (current & 0o7000) | (mode & 0o777 & !mask);
		if current != wanted {
			let _ = chmod_nofollow(at.dir.fd(), &at.name, wanted);
		}
	}

	/// Hard-links `from` (in its own tree) to `to` in this one; each side is
	/// resolved in its own tree. A symlink `from` is linked, not followed.
	pub(crate) fn hard_link(&self, from: (&Tree, &Path), to: &Path) -> io::Result<()> {
		#[cfg(unix)]
		match (from.0.native_root(), self.native_root()) {
			(Some(src_root), Some(dst_root)) => {
				let src = from.0.locate(src_root, from.1)?;
				let dst = self.locate(dst_root, to)?;
				return sys::linkat(src.dir.some(), &src.name, dst.dir.some(), &dst.name);
			},
			(None, None) => {},
			_ => return Err(err::cross_device()),
		}
		self.inner.fs.hard_link(from.0.path_of(from.1)?, self.path_of(to)?)
	}

	/// Renames `from` (in its own tree, e.g. a `--temp-dir` tree) to `to` in
	/// this one; each side is resolved in its own tree (CVE-2026-53795).
	pub(crate) fn rename(&self, from: (&Tree, &Path), to: &Path) -> io::Result<()> {
		#[cfg(unix)]
		match (from.0.native_root(), self.native_root()) {
			(Some(src_root), Some(dst_root)) => {
				let src = from.0.locate(src_root, from.1)?;
				let dst = self.locate(dst_root, to)?;
				return sys::renameat(src.dir.some(), &src.name, dst.dir.some(), &dst.name);
			},
			(None, None) => {},
			_ => return Err(err::cross_device()),
		}
		self.inner.fs.rename(from.0.path_of(from.1)?, self.path_of(to)?)
	}

	/// Removes the non-directory `rel`.
	pub(crate) fn unlink(&self, rel: &Path) -> io::Result<()> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			return sys::unlinkat(at.dir.some(), &at.name, false);
		}
		self.inner.fs.remove_file(self.path_of(rel)?)
	}

	/// Removes the empty directory `rel`.
	pub(crate) fn rmdir(&self, rel: &Path) -> io::Result<()> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			return sys::unlinkat(at.dir.some(), &at.name, true);
		}
		self.inner.fs.remove_dir(self.path_of(rel)?)
	}

	// ----- attributes ---------------------------------------------------------

	/// Never follows a final symlink (lchmod semantics; Unsupported where impossible).
	pub(crate) fn chmod(&self, rel: &Path, mode: u32) -> io::Result<()> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			return chmod_nofollow(at.dir.fd(), &at.name, mode & 0o7777);
		}
		let path = self.path_of(rel)?;
		if self.inner.fs.symlink_metadata(&path)?.is_symlink() {
			return Err(err::unsupported());
		}
		self.inner.fs.set_permissions(&path, Permissions::from_mode(mode & 0o7777))
	}

	/// Changes owner and/or group (`None` keeps it); `follow` selects
	/// `chown` over `lchown`. A silent no-op on Windows host paths.
	pub(crate) fn chown(
		&self,
		rel: &Path,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			return sys::fchownat(at.dir.some(), &at.name, uid, gid, !follow);
		}
		#[cfg(windows)]
		if self.windows_native() {
			return Ok(());
		}
		self.inner.fs.chown(self.path_of(rel)?, uid, gid, follow)
	}

	/// Sets access/modification times with full precision; `None` leaves a
	/// time unchanged. Without `follow` a symlink's own times are set.
	pub(crate) fn set_times(
		&self,
		rel: &Path,
		atime: Option<FileTime>,
		mtime: Option<FileTime>,
		follow: bool,
	) -> io::Result<()> {
		let (atime, mtime) = (atime.unwrap_or_default(), mtime.unwrap_or_default());
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			return sys::utimensat(at.dir.some(), &at.name, atime, mtime, !follow);
		}
		self.inner.fs.set_times(self.path_of(rel)?, atime, mtime, follow)
	}

	/// macOS creation time (-N); Unsupported elsewhere.
	///
	/// Also supported on Windows host paths (the file's creation time).
	pub(crate) fn set_crtime(&self, rel: &Path, crtime: i64, follow: bool) -> io::Result<()> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			#[cfg(any(target_os = "macos", target_os = "ios"))]
			return sys::set_crtime_at(at.dir.some(), &at.name, crtime, !follow);
			#[cfg(not(any(target_os = "macos", target_os = "ios")))]
			{
				let _ = (at, crtime, follow);
				return Err(err::unsupported());
			}
		}
		#[cfg(windows)]
		if self.windows_native() {
			return set_creation_time(&self.path_of(rel)?, crtime, follow);
		}
		let _ = (rel, crtime, follow);
		Err(err::unsupported())
	}

	/// Creation time in seconds, `None` where the filesystem keeps none.
	pub(crate) fn crtime(&self, rel: &Path, follow: bool) -> io::Result<Option<i64>> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let at = self.locate(root, rel)?;
			return sys::crtime_at(at.dir.some(), &at.name, !follow);
		}
		let path = self.path_of(rel)?;
		let meta = if follow {
			self.inner.fs.metadata(&path)?
		} else {
			self.inner.fs.symlink_metadata(&path)?
		};
		Ok(meta.created().ok().map(|time| split_time(time).0))
	}

	// ----- extended attributes ------------------------------------------------

	/// Runs `f` on an xattr handle for `rel` pinned without following the
	/// final element (unless `follow`): the inode is held by an fd, or on
	/// Linux reached through its `/proc/self/fd` magic link; macOS falls back
	/// to a path-based `XATTR_NOFOLLOW` call for objects it cannot open.
	#[cfg(unix)]
	fn with_xattr_at<T>(
		&self,
		root: BorrowedFd<'_>,
		rel: &Path,
		follow: bool,
		f: impl FnOnce(sys::XattrAt<'_>) -> io::Result<T>,
	) -> io::Result<T> {
		let at = self.locate(root, rel)?;
		let nofollow = if follow { 0 } else { libc::O_NOFOLLOW };
		#[cfg(any(target_os = "linux", target_os = "android"))]
		{
			static PROC_FD: LazyLock<bool> = LazyLock::new(|| Path::new("/proc/self/fd").is_dir());
			if *PROC_FD {
				let fd = sys::openat(at.dir.some(), &at.name, libc::O_PATH | nofollow, 0)?;
				let proc = sys::cstr(format!("/proc/self/fd/{}", fd.as_raw_fd()).as_bytes())?;
				return f(sys::XattrAt::Path { path: &proc, nofollow: false });
			}
			let flags = libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOCTTY | nofollow;
			let fd = sys::openat(at.dir.some(), &at.name, flags, 0)?;
			f(sys::XattrAt::Fd(fd.as_fd()))
		}
		#[cfg(any(target_os = "macos", target_os = "ios"))]
		{
			let st = sys::fstatat(at.dir.some(), &at.name, !follow)?;
			let openable = sys::is_reg(&st)
				|| sys::is_dir(&st)
				|| sys::is_fifo(&st)
				|| (sys::is_lnk(&st) && !follow);
			if openable {
				// O_SYMLINK opens a symlink itself instead of following it.
				let pin = if follow { 0 } else { libc::O_SYMLINK };
				let flags = libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOCTTY | pin;
				if let Ok(fd) = sys::openat(at.dir.some(), &at.name, flags, 0) {
					return f(sys::XattrAt::Fd(fd.as_fd()));
				}
			}
			let _ = nofollow;
			let path = self.join_raw(rel);
			let path = sys::cstr(path.as_os_str().as_bytes())?;
			f(sys::XattrAt::Path { path: &path, nofollow: !follow })
		}
		#[cfg(not(any(
			target_os = "linux",
			target_os = "android",
			target_os = "macos",
			target_os = "ios"
		)))]
		{
			let flags = libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOCTTY | nofollow;
			let fd = sys::openat(at.dir.some(), &at.name, flags, 0)?;
			f(sys::XattrAt::Fd(fd.as_fd()))
		}
	}

	/// Xattr access is unsupported on Windows host paths.
	fn xattrs_unsupported(&self) -> bool {
		#[cfg(windows)]
		return self.windows_native();
		#[cfg(not(windows))]
		return false;
	}

	/// Names of `rel`'s extended attributes.
	pub(crate) fn list_xattr(&self, rel: &Path, follow: bool) -> io::Result<Vec<OsString>> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			return self.with_xattr_at(root, rel, follow, sys::xattr_list);
		}
		if self.xattrs_unsupported() {
			return Err(err::unsupported());
		}
		self.inner.fs.list_xattr(self.path_of(rel)?, follow)
	}

	/// One attribute's value; `Ok(None)` when it is absent.
	pub(crate) fn get_xattr(
		&self,
		rel: &Path,
		name: &OsStr,
		follow: bool,
	) -> io::Result<Option<Vec<u8>>> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let name = sys::cstr(name.as_bytes())?;
			return self.with_xattr_at(root, rel, follow, |at| sys::xattr_get(at, &name));
		}
		if self.xattrs_unsupported() {
			return Err(err::unsupported());
		}
		self.inner.fs.get_xattr(self.path_of(rel)?, name, follow)
	}

	/// Creates or replaces one attribute.
	pub(crate) fn set_xattr(
		&self,
		rel: &Path,
		name: &OsStr,
		value: &[u8],
		follow: bool,
	) -> io::Result<()> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let name = sys::cstr(name.as_bytes())?;
			return self.with_xattr_at(root, rel, follow, |at| sys::xattr_set(at, &name, value));
		}
		if self.xattrs_unsupported() {
			return Err(err::unsupported());
		}
		self.inner.fs.set_xattr(self.path_of(rel)?, name, value, follow)
	}

	/// Removes one attribute.
	pub(crate) fn remove_xattr(&self, rel: &Path, name: &OsStr, follow: bool) -> io::Result<()> {
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let name = sys::cstr(name.as_bytes())?;
			return self.with_xattr_at(root, rel, follow, |at| sys::xattr_remove(at, &name));
		}
		if self.xattrs_unsupported() {
			return Err(err::unsupported());
		}
		self.inner.fs.remove_xattr(self.path_of(rel)?, name, follow)
	}

	/// Runs `f` with an O_NOFOLLOW-pinned raw fd of `rel` (for ACL syscalls); Unsupported on virtual trees.
	///
	/// The fd is `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY`: a FIFO never
	/// blocks, and a final symlink fails with `ELOOP`. Only the Apple ACL
	/// backend (`acl::platform`) needs it; Linux ACLs go through xattrs.
	#[cfg(any(target_vendor = "apple", all(unix, test)))]
	pub(crate) fn with_fd<T>(
		&self,
		rel: &Path,
		f: impl FnOnce(BorrowedFd<'_>) -> io::Result<T>,
	) -> io::Result<T> {
		let Some(root) = self.native_root() else {
			return Err(err::unsupported());
		};
		let at = self.locate(root, rel)?;
		let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY;
		let fd = sys::openat(at.dir.some(), &at.name, flags, 0)?;
		f(fd.as_fd())
	}

	/// A tree rooted at `rel` below this one (for per-operand sender roots, alt-dest dirs).
	pub(crate) fn subtree(&self, rel: &Path) -> io::Result<Tree> {
		let mut opts = self.inner.opts.clone();
		opts.operator_named = false;
		#[cfg(unix)]
		if let Some(root) = self.native_root() {
			let fd = match self.native_dir(root, rel)? {
				Dir::Owned(fd) => fd,
				Dir::Borrowed(fd) => sys::openat(Some(fd), c".", sys::TRAVERSE, 0)?,
			};
			let path = self.join_raw(rel);
			return Ok(Self::build(path, opts, &self.inner.fs, self.inner.mask, Backend::Native(fd)));
		}
		let path = self.dir_path_of(rel)?;
		if !self.inner.fs.metadata(&path)?.is_dir() {
			return Err(err::not_dir());
		}
		let native = matches!(self.inner.backend, Backend::Paths { native: true });
		Ok(Self::build(path, opts, &self.inner.fs, self.inner.mask, Backend::Paths { native }))
	}
}

/// chmod of `dir/name` that never follows a final symlink: a regular file,
/// directory, or (on Linux) FIFO is pinned with `O_NOFOLLOW` and changed
/// with `fchmod`; a symlink gets `fchmodat(AT_SYMLINK_NOFOLLOW)` (lchmod;
/// `EOPNOTSUPP` where the platform cannot); anything else falls back to
/// `fchmodat(AT_SYMLINK_NOFOLLOW)`. On macOS a FIFO is never opened (that
/// would make us a reader); an ungrantable setgid is retried without it.
#[cfg(unix)]
fn chmod_nofollow(dir: BorrowedFd<'_>, name: &std::ffi::CStr, mode: u32) -> io::Result<()> {
	let st = sys::fstatat(Some(dir), name, true)?;
	if sys::is_lnk(&st) {
		return sys::fchmodat(Some(dir), name, mode, true);
	}
	let fifo = sys::is_fifo(&st);
	if sys::is_reg(&st) || sys::is_dir(&st) || fifo {
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		if fifo {
			return match sys::fchmodat(Some(dir), name, mode, true) {
				Err(error)
					if error.raw_os_error() == Some(libc::EPERM)
						&& mode & libc::S_ISGID as u32 != 0 =>
				{
					sys::fchmodat(Some(dir), name, mode & !(libc::S_ISGID as u32), true)
				},
				other => other,
			};
		}
		let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY;
		match sys::openat(Some(dir), name, flags, 0) {
			Ok(fd) => return sys::fchmod(fd.as_fd(), mode),
			Err(error) if error.raw_os_error().is_some_and(sys::nofollow_hit) => return Err(error),
			Err(_) => {},
		}
	}
	sys::fchmodat(Some(dir), name, mode, true)
}

/// Sets a Windows file's creation time without following a final reparse
/// point unless `follow`.
#[cfg(windows)]
fn set_creation_time(path: &Path, crtime: i64, follow: bool) -> io::Result<()> {
	use std::os::windows::fs::{FileTimesExt, OpenOptionsExt};
	const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
	const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
	const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
	let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
	if !follow {
		flags |= FILE_FLAG_OPEN_REPARSE_POINT;
	}
	let file = std::fs::OpenOptions::new()
		.access_mode(FILE_WRITE_ATTRIBUTES)
		.custom_flags(flags)
		.open(path)?;
	let created = crate::rsync::time::system_time(crtime, 0).ok_or_else(err::invalid)?;
	file.set_times(std::fs::FileTimes::new().set_created(created))
}

/// Upstream get_tmpname's basename for `name`: `.<name>.XXXXXX` (no leading
/// dot when `dotted` is false, the `--temp-dir` spelling; a leading dot of
/// `name` is not doubled). `dir_len` is the length of the directory part
/// including its slash (0 for none). The name is shortened so the result fits
/// `NAME_MAX` and `MAXPATHLEN`, without leaving half a multi-byte character
/// or a dot right before the suffix.
pub(crate) fn temp_template(name: &[u8], dir_len: usize, dotted: bool) -> io::Result<Vec<u8>> {
	let mut f = name;
	let mut length = dir_len;
	let mut out = Vec::with_capacity(NAME_MAX + 1);
	if dotted {
		if f.first() == Some(&b'.') {
			f = &f[1..];
		}
		out.push(b'.');
		length += 1;
	}
	let suffix = TMPNAME_SUFFIX.len() as isize;
	let maxname = (MAXPATHLEN as isize - length as isize - suffix).min(NAME_MAX as isize - 1 - suffix);
	if maxname < 0 {
		return Err(err::too_long());
	}
	let maxname = maxname as usize;
	if maxname > 0 {
		let added = if f.len() >= maxname { maxname - 1 } else { f.len() };
		out.extend_from_slice(&f[..added]);
		let mut end = out.len();
		if f.get(added).is_some_and(|&b| b & 0x80 != 0) {
			while end > 0 && out[end - 1] & 0x80 != 0 {
				end -= 1;
			}
		}
		if end > 0 && out[end - 1] == b'.' {
			end -= 1;
		}
		out.truncate(end);
	} else {
		// No room for the name: the suffix's dot replaces the leading one.
		out.pop();
	}
	out.extend_from_slice(TMPNAME_SUFFIX);
	Ok(out)
}

/// Fills `buf` with mkstemp letters (`[A-Za-z0-9]`) from a per-call random
/// seed. Uniqueness, not secrecy, is what matters: the create is `O_EXCL`.
fn random_suffix(buf: &mut [u8]) {
	const LETTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
	hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
	hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
	let mut value = hasher.finish();
	for slot in buf {
		*slot = LETTERS[(value % LETTERS.len() as u64) as usize];
		value /= LETTERS.len() as u64;
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn temp_template_naming() {
		assert_eq!(temp_template(b"file", 0, true).unwrap(), b".file.XXXXXX");
		assert_eq!(temp_template(b".bashrc", 4, true).unwrap(), b".bashrc.XXXXXX");
		assert_eq!(temp_template(b"foo.", 0, true).unwrap(), b".foo.XXXXXX");
		assert_eq!(temp_template(b".", 0, true).unwrap(), b".XXXXXX");
		assert_eq!(temp_template(b"file", 0, false).unwrap(), b"file.XXXXXX");
	}

	#[test]
	fn temp_template_truncates_long_names_to_name_max() {
		let long = vec![b'a'; 300];
		let got = temp_template(&long, 0, true).unwrap();
		assert_eq!(got.len(), 1 + 246 + 7);
		assert!(got.len() <= NAME_MAX);
		assert_eq!(&got[..1], b".");
		assert!(got[1..247].iter().all(|&b| b == b'a'));
		assert!(got.ends_with(b".XXXXXX"));

		// Never cut a multi-byte character in half.
		let mut name = vec![b'a'; 245];
		name.extend_from_slice("é".as_bytes());
		name.extend_from_slice(b"bbb");
		let got = temp_template(&name, 0, true).unwrap();
		assert_eq!(got.len(), 1 + 245 + 7);

		// A dot left at the cut is dropped.
		let mut name = vec![b'a'; 245];
		name.extend_from_slice(b".tail");
		let got = temp_template(&name, 0, true).unwrap();
		assert_eq!(got.len(), 1 + 245 + 7);

		// A deep directory leaves less room (MAXPATHLEN).
		let got = temp_template(&long, MAXPATHLEN - 20, true).unwrap();
		assert_eq!(got.len(), 1 + (20 - 1 - 7 - 1) + 7);
		assert!(temp_template(b"x", MAXPATHLEN, true).is_err());
	}

	#[test]
	fn random_suffix_uses_mkstemp_letters() {
		let mut a = *b"XXXXXX";
		let mut b = *b"XXXXXX";
		random_suffix(&mut a);
		random_suffix(&mut b);
		assert!(a.iter().chain(b.iter()).all(u8::is_ascii_alphanumeric));
		assert_ne!(a, b);
	}

	#[test]
	fn absolute_spellings() {
		assert!(is_absolute_bytes(b"/x"));
		assert!(!is_absolute_bytes(b"x/y"));
		assert_eq!(is_absolute_bytes(b"C:\\x"), cfg!(windows));
		assert_eq!(is_absolute_bytes(b"\\x"), cfg!(windows));
		assert_eq!(elements(b"a//b/./c/"), vec![&b"a"[..], b"b", b".", b"c"]);
	}

	/// Tests that run against the host filesystem through the path-based
	/// backend (every platform) or the fd backend (unix).
	fn tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let real = std::fs::canonicalize(dir.path()).unwrap();
		(dir, real)
	}

	fn open_tree(root: &Path, opts: &TreeOpts) -> Tree {
		Tree::open(&BlockingFs::native(), root, opts).unwrap()
	}

	#[test]
	fn basic_mutations_inside_the_tree() {
		let (_guard, base) = tempdir();
		let tree = open_tree(&base, &TreeOpts::default());
		assert_eq!(tree.make_path_count(Path::new("a/b/c/file"), 0o755, true).unwrap(), 3);
		assert!(base.join("a/b/c").is_dir());
		assert_eq!(tree.make_path_count(Path::new("a/b/x/y/z"), 0o755, true).unwrap(), 2);
		assert_eq!(tree.make_path_count(Path::new("a/b"), 0o755, false).unwrap(), 0);
		tree.mkdir(Path::new("d"), 0o755).unwrap();
		{
			let mut file = tree.open_write(Path::new("a/b/c/file"), true, true).unwrap();
			std::io::Write::write_all(&mut file, b"hello").unwrap();
		}
		assert_eq!(std::fs::read(base.join("a/b/c/file")).unwrap(), b"hello");
		let text = std::io::read_to_string(tree.open_read(Path::new("a/b/c/file"), false).unwrap()).unwrap();
		assert_eq!(text, "hello");
		tree.rename((&tree, Path::new("a/b/c/file")), Path::new("d/moved")).unwrap();
		assert!(base.join("d/moved").is_file());
		tree.hard_link((&tree, Path::new("d/moved")), Path::new("d/linked")).unwrap();
		#[cfg(unix)]
		assert_eq!(tree.lstat(Path::new("d/linked")).unwrap().nlink(), Some(2));
		tree.unlink(Path::new("d/moved")).unwrap();
		assert!(!base.join("d/moved").exists());
		let mut names = tree.read_dir(Path::new("d")).unwrap();
		names.sort();
		assert_eq!(names, vec![OsString::from("linked")]);
		tree.unlink(Path::new("d/linked")).unwrap();
		tree.rmdir(Path::new("d")).unwrap();
		assert!(!base.join("d").exists());
		assert!(tree.lstat(Path::new("")).unwrap().is_dir());
		let err = tree.lstat(Path::new("../x")).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
		assert!(tree.lstat(Path::new("/etc")).is_err());
		let err = tree.open_read(Path::new("a"), false).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::IsADirectory);
	}

	#[test]
	fn create_temp_names_and_mode() {
		let (_guard, base) = tempdir();
		let tree = open_tree(&base, &TreeOpts::default());
		std::fs::create_dir(base.join("sub")).unwrap();
		let (rel, file) =
			tree.create_temp_with(Path::new("sub"), OsStr::new("target.txt"), 0o640, true).unwrap();
		drop(file);
		let name = rel.file_name().unwrap().to_str().unwrap().to_owned();
		assert_eq!(rel.parent(), Some(Path::new("sub")));
		assert!(name.starts_with(".target.txt."), "{name}");
		assert_eq!(name.len(), ".target.txt.".len() + 6);
		assert!(base.join(&rel).is_file());
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			let mode = std::fs::metadata(base.join(&rel)).unwrap().permissions().mode();
			assert_eq!(mode & 0o7777, 0o640 | 0o200);
		}
		let long = "n".repeat(300);
		let (rel, _file) = tree.create_temp_with(Path::new(""), OsStr::new(&long), 0o600, true).unwrap();
		let name = rel.file_name().unwrap().len();
		assert_eq!(name, 1 + 246 + 7);
		let unique = tree.unique_temp_name(Path::new("sub"), OsStr::new("link"), true).unwrap();
		let unique = unique.file_name().unwrap().to_str().unwrap().to_owned();
		assert!(unique.starts_with(".link."), "{unique}");
		assert!(unique[6..].bytes().all(|b| b.is_ascii_digit()), "{unique}");
	}

	#[cfg(unix)]
	mod native {
		use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

		use super::*;

		fn opts_insecure() -> TreeOpts {
			TreeOpts { insecure_links: true, ..TreeOpts::default() }
		}

		#[test]
		fn planted_parent_symlink_is_refused_and_outside_untouched() {
			let (_guard, base) = tempdir();
			let dest = base.join("dest");
			let outside = base.join("outside");
			std::fs::create_dir(&dest).unwrap();
			std::fs::create_dir(&outside).unwrap();
			std::fs::write(outside.join("victim"), b"keep").unwrap();
			symlink(&outside, dest.join("evil")).unwrap();
			symlink("../outside", dest.join("rel_evil")).unwrap();
			let tree = open_tree(&dest, &TreeOpts::default());
			for parent in ["evil", "rel_evil"] {
				let p = |leaf: &str| PathBuf::from(format!("{parent}/{leaf}"));
				let eloop = |r: io::Result<()>| assert_eq!(r.unwrap_err().raw_os_error(), Some(libc::ELOOP));
				eloop(tree.unlink(&p("victim")));
				eloop(tree.mkdir(&p("newdir"), 0o755));
				eloop(tree.symlink(Path::new("x"), &p("newlink")));
				eloop(tree.chmod(&p("victim"), 0o777));
				eloop(tree.set_times(&p("victim"), Some(FileTime::Now), Some(FileTime::Now), false));
				eloop(tree.make_path_count(&p("deeper/file"), 0o755, true).map(drop));
				eloop(tree.rename((&tree, Path::new("nonexistent")), &p("victim")));
				assert_eq!(tree.open_write(&p("victim"), true, true).unwrap_err().raw_os_error(), Some(libc::ELOOP));
				let err = tree
					.create_temp_with(&PathBuf::from(parent), OsStr::new("x"), 0o600, true)
					.unwrap_err();
				assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
			}
			assert_eq!(std::fs::read(outside.join("victim")).unwrap(), b"keep");
			assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
			let mode = std::fs::metadata(outside.join("victim")).unwrap().permissions().mode();
			assert_ne!(mode & 0o777, 0o777);

			// --insecure-links restores the legacy follow.
			let legacy = open_tree(&dest, &opts_insecure());
			legacy.mkdir(Path::new("evil/newdir"), 0o755).unwrap();
			assert!(outside.join("newdir").is_dir());
			legacy.unlink(Path::new("evil/victim")).unwrap();
			assert!(!outside.join("victim").exists());
		}

		#[test]
		fn in_tree_directory_symlinks_are_followed() {
			let (_guard, base) = tempdir();
			std::fs::create_dir_all(base.join("real/inner")).unwrap();
			symlink("real", base.join("alias")).unwrap();
			symlink("..", base.join("real/inner/up")).unwrap();
			let tree = open_tree(&base, &TreeOpts::default());
			tree.mkdir(Path::new("alias/made"), 0o755).unwrap();
			assert!(base.join("real/made").is_dir());
			assert!(tree.stat(Path::new("real/inner/up/made")).unwrap().is_dir());
			let mut names = tree.read_dir(Path::new("alias")).unwrap();
			names.sort();
			assert_eq!(names, vec![OsString::from("inner"), OsString::from("made")]);
			// The leaf symlink itself is not followed by lstat.
			assert!(tree.lstat(Path::new("alias")).unwrap().is_symlink());
			let sub = tree.subtree(Path::new("alias/inner")).unwrap();
			assert!(sub.lstat(Path::new("up")).unwrap().is_symlink());
			// `up` climbs out of the subtree's anchor: refused there.
			let err = sub.mkdir(Path::new("up/x"), 0o755).unwrap_err();
			assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
			// Absolute in-tree symlinks are refused too.
			symlink(base.join("real"), base.join("abs")).unwrap();
			let err = tree.mkdir(Path::new("abs/x"), 0o755).unwrap_err();
			assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
			// A file in the middle of the chain reports ELOOP, at the end ENOTDIR.
			std::fs::write(base.join("real/f"), b"").unwrap();
			assert_eq!(tree.lstat(Path::new("real/f/x/y")).unwrap_err().raw_os_error(), Some(libc::ELOOP));
			assert_eq!(tree.lstat(Path::new("real/f/x")).unwrap_err().raw_os_error(), Some(libc::ENOTDIR));
		}

		#[test]
		fn cross_tree_rename_is_confined_on_both_sides() {
			let (_guard, base) = tempdir();
			for dir in ["dest", "tmp", "outside"] {
				std::fs::create_dir(base.join(dir)).unwrap();
			}
			let dest = open_tree(&base.join("dest"), &TreeOpts::default());
			let tmp = open_tree(&base.join("tmp"), &TreeOpts::default());
			let (rel, file) = tmp.create_temp_with(Path::new(""), OsStr::new("f"), 0o644, false).unwrap();
			drop(file);
			// Destination parent flipped to a symlink: refused.
			symlink(base.join("outside"), base.join("dest/sub")).unwrap();
			let err = dest.rename((&tmp, &rel), Path::new("sub/f")).unwrap_err();
			assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
			assert_eq!(std::fs::read_dir(base.join("outside")).unwrap().count(), 0);
			// Source parent flipped to a symlink: refused as well.
			std::fs::write(base.join("outside/secret"), b"s").unwrap();
			symlink(base.join("outside"), base.join("tmp/flip")).unwrap();
			let err = dest.rename((&tmp, Path::new("flip/secret")), Path::new("got")).unwrap_err();
			assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
			assert!(base.join("outside/secret").exists());
			// The legitimate move works.
			dest.rename((&tmp, &rel), Path::new("f")).unwrap();
			assert!(base.join("dest/f").is_file());
			let err = dest.hard_link((&tmp, Path::new("flip/secret")), Path::new("h")).unwrap_err();
			assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
		}

		#[test]
		fn set_times_keeps_nanoseconds_without_following() {
			let (_guard, base) = tempdir();
			std::fs::write(base.join("file"), b"").unwrap();
			symlink("file", base.join("link")).unwrap();
			let tree = open_tree(&base, &TreeOpts::default());
			let at = |secs: u64, nanos: u32| {
				FileTime::At(UNIX_EPOCH + std::time::Duration::new(secs, nanos))
			};
			tree.set_times(Path::new("file"), Some(at(1_000_000_000, 123_456_789)), Some(at(1_500_000_000, 987_654_321)), false).unwrap();
			let meta = std::fs::symlink_metadata(base.join("file")).unwrap();
			assert_eq!((meta.mtime(), meta.mtime_nsec()), (1_500_000_000, 987_654_321));
			assert_eq!((meta.atime(), meta.atime_nsec()), (1_000_000_000, 123_456_789));
			tree.set_times(Path::new("link"), None, Some(at(1_200_000_000, 111)), false).unwrap();
			let link = std::fs::symlink_metadata(base.join("link")).unwrap();
			assert_eq!((link.mtime(), link.mtime_nsec()), (1_200_000_000, 111));
			let file = std::fs::symlink_metadata(base.join("file")).unwrap();
			assert_eq!(file.mtime(), 1_500_000_000);
			let via_tree = tree.lstat(Path::new("file")).unwrap();
			assert_eq!((via_tree.mtime(), via_tree.mtime_nsec()), (Some(1_500_000_000), Some(987_654_321)));
		}

		#[test]
		fn chmod_never_follows_a_symlink() {
			let (_guard, base) = tempdir();
			std::fs::write(base.join("file"), b"").unwrap();
			std::fs::set_permissions(base.join("file"), std::fs::Permissions::from_mode(0o600)).unwrap();
			symlink("file", base.join("link")).unwrap();
			let tree = open_tree(&base, &TreeOpts::default());
			let _ = tree.chmod(Path::new("link"), 0o777);
			let mode = std::fs::metadata(base.join("file")).unwrap().permissions().mode();
			assert_eq!(mode & 0o7777, 0o600);
			tree.chmod(Path::new("file"), 0o640).unwrap();
			let mode = std::fs::metadata(base.join("file")).unwrap().permissions().mode();
			assert_eq!(mode & 0o7777, 0o640);
			tree.chmod(Path::new(""), 0o750).unwrap();
			let mode = std::fs::metadata(&base).unwrap().permissions().mode();
			assert_eq!(mode & 0o7777, 0o750);
		}

		#[test]
		fn operator_named_root_symlink_trust() {
			let (_guard, base) = tempdir();
			std::fs::create_dir(base.join("disk")).unwrap();
			symlink("disk", base.join("backup")).unwrap();
			let opts = TreeOpts { operator_named: true, ..TreeOpts::default() };
			// Our own symlinked root is followed.
			let tree = Tree::open(&BlockingFs::native(), &base.join("backup"), &opts).unwrap();
			tree.mkdir(Path::new("x"), 0o755).unwrap();
			assert!(base.join("disk/x").is_dir());
			// A root that refuses our uid (the trust seam) is refused.
			let only_root = |uid: u32| uid == 0;
			let err = paths::open_operator_dir(&base.join("backup"), false, None, &only_root).unwrap_err();
			assert!(paths::is_untrusted_symlink(&err));
			// --confine-root refuses a root outside it.
			let confined = TreeOpts { confine: Some(base.join("elsewhere")), ..opts };
			std::fs::create_dir(base.join("elsewhere")).unwrap();
			let err = Tree::open(&BlockingFs::native(), &base.join("backup"), &confined).unwrap_err();
			assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
		}

		#[test]
		fn special_files_and_with_fd() {
			let (_guard, base) = tempdir();
			let tree = open_tree(&base, &TreeOpts::default());
			tree.mknod(Path::new("fifo"), NodeKind::Fifo, 0o600).unwrap();
			assert!(tree.lstat(Path::new("fifo")).unwrap().file_type().is_fifo());
			// with_fd must not block on a FIFO.
			let mode = tree.with_fd(Path::new("fifo"), |fd| Ok(sys::st_mode(&sys::fstat(fd)?))).unwrap();
			assert_eq!(mode & libc::S_IFMT as u32, libc::S_IFIFO as u32);
			tree.symlink(Path::new("fifo"), Path::new("link")).unwrap();
			let err = tree.with_fd(Path::new("link"), |_| Ok(())).unwrap_err();
			assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
			assert_eq!(tree.read_link(Path::new("link")).unwrap(), Path::new("fifo"));
			let err = tree.open_read(Path::new("link"), false).unwrap_err();
			assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
			tree.mknod(Path::new("plain"), NodeKind::Regular, 0o644).unwrap();
			assert!(base.join("plain").is_file());
		}

		/// B18: a top-level socket under a root whose full path exceeds
		/// `sun_path` is still created (upstream binds relative to its cwd).
		#[test]
		fn socket_under_long_root_path() {
			let (_guard, base) = tempdir();
			let root = base.join("a".repeat(120));
			std::fs::create_dir(&root).unwrap();
			assert!(root.join("sk0").as_os_str().len() > 108);
			let tree = open_tree(&root, &TreeOpts::default());
			tree.mknod(Path::new("sk0"), NodeKind::Socket, 0o640).unwrap();
			let meta = std::fs::symlink_metadata(root.join("sk0")).unwrap();
			assert!(std::os::unix::fs::FileTypeExt::is_socket(&meta.file_type()));
			assert_eq!(meta.permissions().mode() & 0o777, 0o640);
			// The process working directory is untouched.
			assert_ne!(std::env::current_dir().unwrap(), root);
			std::fs::create_dir(root.join("sub")).unwrap();
			match tree.mknod(Path::new("sub/sk1"), NodeKind::Socket, 0o600) {
				Ok(()) => assert!(cfg!(any(target_os = "linux", target_os = "android"))),
				Err(err) => assert_eq!(err.raw_os_error(), Some(libc::EOPNOTSUPP)),
			}
			// --insecure-links restores the legacy nested bind.
			let legacy = open_tree(&root, &opts_insecure());
			legacy.mknod(Path::new("sub/sk2"), NodeKind::Socket, 0o600).unwrap();
			assert!(root.join("sub/sk2").exists());
		}

		#[cfg(target_os = "macos")]
		#[test]
		fn crtime_round_trip() {
			let (_guard, base) = tempdir();
			std::fs::write(base.join("file"), b"").unwrap();
			let tree = open_tree(&base, &TreeOpts::default());
			tree.set_crtime(Path::new("file"), 1_000_000_000, false).unwrap();
			assert_eq!(tree.crtime(Path::new("file"), false).unwrap(), Some(1_000_000_000));
		}

		#[cfg(any(target_os = "macos", target_os = "linux"))]
		#[test]
		fn xattrs_on_a_held_inode() {
			let (_guard, base) = tempdir();
			std::fs::write(base.join("file"), b"").unwrap();
			let tree = open_tree(&base, &TreeOpts::default());
			let name = OsStr::new("user.rsync.test");
			match tree.set_xattr(Path::new("file"), name, b"value", false) {
				// Filesystems without user xattrs (tmpfs on old kernels).
				Err(err) if err.raw_os_error() == Some(libc::EOPNOTSUPP) => return,
				other => other.unwrap(),
			}
			assert_eq!(tree.get_xattr(Path::new("file"), name, false).unwrap(), Some(b"value".to_vec()));
			assert!(tree.list_xattr(Path::new("file"), false).unwrap().iter().any(|n| n == name));
			tree.remove_xattr(Path::new("file"), name, false).unwrap();
			assert_eq!(tree.get_xattr(Path::new("file"), name, false).unwrap(), None);
		}
	}
}
