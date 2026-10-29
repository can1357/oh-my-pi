//! Filesystem layer every walk and search reads through: directory listings,
//! file contents, and change stamps.
//!
//! [`Fs::Native`] is the host filesystem with per-platform fast paths
//! (`native/`); [`Fs::Provider`] adapts a [`pi_vfs::Fs`] provider
//! (`provider.rs`), such as an in-memory tree or a `scheme://` URL namespace.
//! Walkers, ignore loading, the listing cache, and the searches only ever talk
//! to an [`Fs`], so no tool bypasses the layer with its own I/O.
//!
//! Work happens on a [`Session`]: per-thread scratch that makes steady-state
//! listing and stat calls allocation-free. Walkers hold one session per
//! worker. Directories are opened once ([`Session::open_dir`], then
//! [`Session::open_child`] relative to the parent) and files are opened once
//! ([`Session::open_file_at`], which also stats them) and then read into a
//! reusable buffer ([`File::read_into`]) or streamed ([`File::read`]).
//!
//! ```ignore
//! let fs = Fs::native();
//! let mut s = fs.session();
//! let dir = s.open_dir(Path::new("/repo")).await?;
//! let listing = s.list(&dir, Detail::Minimal, 0).await?;
//! for record in listing.records() {
//!     println!("{:?} {:?}", listing.name(record), record.file_type);
//! }
//! ```

mod native;
mod provider;
mod root;
#[cfg(any(windows, test))]
mod wtf8;

use std::{
	borrow::Cow,
	ffi::OsStr,
	io,
	path::{Path, PathBuf},
};

pub use root::{absolute, canonical, resolve_dir};

/// Kind of a listed entry. Special files (devices, FIFOs, sockets) are never
/// reported by listings; on Windows every reparse point is a [`Self::Symlink`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FileType {
	/// A regular file.
	File,
	/// A directory.
	Dir,
	/// A symbolic link (never followed by a listing).
	Symlink,
}

/// How much metadata listings collect.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Detail {
	/// Names and entry types only: one bulk listing call per directory and no
	/// per-entry metadata syscalls.
	#[default]
	Minimal,
	/// Also modification times for every entry and sizes for regular files.
	/// macOS and Windows return these from the bulk listing; Linux and
	/// providers pay one metadata call per entry.
	Full,
}

/// Identity of a file or directory, regardless of the path reaching it.
///
/// Device and inode on Unix, volume serial and file index on Windows, and
/// the provider's own ids otherwise. Provider and host ids live in separate
/// namespaces (`native`), so they never compare equal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FileId {
	/// Device (Unix) or volume serial number (Windows).
	pub dev:    u64,
	/// Inode (Unix) or file index (Windows).
	pub ino:    u64,
	/// The id comes from the host, not a provider.
	pub native: bool,
}

/// One version of a file or directory.
///
/// Adding, removing, or renaming a directory's entries moves its mtime and
/// ctime, and replacing it changes its inode. Listing caches compare stamps to
/// decide whether a listing is still current.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Stamp {
	/// Device or volume serial number.
	pub dev:   u64,
	/// Inode or file index (Windows path queries: creation time).
	pub ino:   u64,
	/// Modification time, Unix nanoseconds.
	pub mtime: i64,
	/// Status-change time, Unix nanoseconds.
	pub ctime: i64,
}

impl Stamp {
	/// The newer of the two timestamps.
	pub const fn latest(&self) -> i64 {
		if self.mtime > self.ctime {
			self.mtime
		} else {
			self.ctime
		}
	}
}

/// Metadata of a file opened by [`Session::open_file_at`] or found by
/// [`Session::stat`].
#[derive(Clone, Copy, Debug)]
pub struct FileInfo {
	/// `None` for special files (devices, FIFOs, sockets).
	pub file_type: Option<FileType>,
	/// Byte size.
	pub size:      u64,
	/// Change stamp (also carries the modification time).
	pub stamp:     Stamp,
}

/// One listing entry; its name lives in the owning [`Listing`].
#[derive(Clone, Copy, Debug)]
pub struct Record {
	pub(crate) name_off: u32,
	pub(crate) name_len: u32,
	/// A subdirectory's entry count when the listing reports it (macOS full
	/// listings), else 0. Passed back to [`Session::list`] for the child, it
	/// lets the child's listing stop without a final empty read.
	pub children:        u32,
	/// Entry kind as listed (symlinks unresolved).
	pub file_type:       FileType,
	/// Regular-file size, when the listing carries it.
	pub size:            Option<u64>,
	/// Modification time in Unix nanoseconds, when the listing carries it.
	pub mtime:           Option<i64>,
}

/// One directory's entries, without `.` and `..` and without special files.
/// Names are raw bytes (`OsStr` encoded bytes: exact on Unix, WTF-8 on
/// Windows and for provider names).
#[derive(Clone, Debug, Default)]
pub struct Listing {
	pub(crate) records: Vec<Record>,
	pub(crate) names:   Vec<u8>,
}

impl Listing {
	/// Entries in listing order.
	pub fn records(&self) -> &[Record] {
		&self.records
	}

	/// The name of `record`, which must come from this listing.
	pub fn name(&self, record: &Record) -> &[u8] {
		let start = record.name_off as usize;
		&self.names[start..start + record.name_len as usize]
	}

	/// Number of entries.
	pub const fn len(&self) -> usize {
		self.records.len()
	}

	/// The directory has no listed entries.
	pub const fn is_empty(&self) -> bool {
		self.records.is_empty()
	}

	/// Approximate heap footprint in bytes, for cache budgets.
	pub const fn heap_size(&self) -> usize {
		self.names.len() + self.records.len() * size_of::<Record>()
	}

	pub(crate) fn clear(&mut self) {
		self.records.clear();
		self.names.clear();
	}

	pub(crate) fn push(
		&mut self,
		name: &[u8],
		file_type: FileType,
		size: Option<u64>,
		mtime: Option<i64>,
		children: u32,
	) {
		self.push_with(|names| names.extend_from_slice(name), file_type, size, mtime, children);
	}

	/// [`Self::push`] with the name appended to the arena by `write_name`.
	pub(crate) fn push_with(
		&mut self,
		write_name: impl FnOnce(&mut Vec<u8>),
		file_type: FileType,
		size: Option<u64>,
		mtime: Option<i64>,
		children: u32,
	) {
		let name_off = self.names.len();
		write_name(&mut self.names);
		self.records.push(Record {
			name_off: name_off as u32,
			name_len: (self.names.len() - name_off) as u32,
			children,
			file_type,
			size,
			mtime,
		});
	}
}

/// A filesystem walks and searches read through. Cheap to clone.
#[derive(Clone, Debug)]
pub enum Fs {
	/// The host filesystem through direct syscalls.
	Native,
	/// A provider (or any facade path that is not plain host storage), read
	/// through its [`pi_vfs::Fs`] methods.
	Provider(pi_vfs::Fs),
}

impl Fs {
	/// The host filesystem.
	pub const fn native() -> Self {
		Self::Native
	}

	/// The layer that serves `root` and everything below it on `fs`:
	/// [`Self::Native`] when `fs.is_native_local(root)`, else
	/// [`Self::Provider`].
	pub fn new(fs: &pi_vfs::Fs, root: &Path) -> Self {
		if fs.is_native_local(root) {
			Self::Native
		} else {
			Self::Provider(fs.clone())
		}
	}

	/// Whether this is [`Self::Native`].
	pub const fn is_native(&self) -> bool {
		matches!(self, Self::Native)
	}

	/// A fresh per-thread session. Cheap: scratch buffers grow on first use.
	pub fn session(&self) -> Session {
		let imp = match self {
			Self::Native => Imp::Native(native::Scratch::default()),
			Self::Provider(fs) => Imp::Provider(fs.clone()),
		};
		Session { listing: Listing::default(), imp }
	}

	/// Parallelism past which concurrent listing costs more than it gains:
	/// 4 on macOS (APFS contention), 8 on Linux, 4 elsewhere and for
	/// providers.
	pub const fn workers(&self) -> usize {
		match self {
			Self::Native => native::WORKERS,
			Self::Provider(_) => 4,
		}
	}

	/// Absolute spelling of the walk-relative `rel` (`/`-separated raw
	/// names; empty for `root` itself) below `root`. Host paths join with
	/// the platform separator; URL roots join segment by segment with
	/// [`pi_vfs::child_path`], which percent-encodes raw names.
	pub fn join(&self, root: &Path, rel: &[u8]) -> PathBuf {
		let mut path = root.to_path_buf();
		if rel.is_empty() {
			return path;
		}
		if pi_vfs::is_virtual_path(root) {
			for segment in rel
				.split(|&b| b == b'/')
				.filter(|segment| !segment.is_empty())
			{
				path = pi_vfs::child_path(&path, &os_name(segment));
			}
		} else {
			path.push(os_name(rel));
		}
		path
	}
}

/// `bytes` (raw `OsStr` encoded bytes: exact on Unix, WTF-8 on Windows) as an
/// [`OsStr`]. On Windows `/` becomes `\`.
#[cfg(unix)]
pub(crate) fn os_name(bytes: &[u8]) -> Cow<'_, OsStr> {
	use std::os::unix::ffi::OsStrExt;
	Cow::Borrowed(OsStr::from_bytes(bytes))
}

/// `bytes` (raw `OsStr` encoded bytes: exact on Unix, WTF-8 on Windows) as an
/// [`OsStr`]. On Windows `/` becomes `\`.
#[cfg(windows)]
pub(crate) fn os_name(bytes: &[u8]) -> Cow<'_, OsStr> {
	use std::os::windows::ffi::OsStringExt;
	if let Ok(name) = std::str::from_utf8(bytes)
		&& !name.contains('/')
	{
		return Cow::Borrowed(OsStr::new(name));
	}
	let mut wide = Vec::with_capacity(bytes.len());
	wtf8::push_wide(&mut wide, bytes);
	Cow::Owned(std::ffi::OsString::from_wide(&wide))
}

/// An open directory. Native: a descriptor/handle closed on drop. Provider:
/// the directory's path.
#[derive(Debug)]
pub struct Dir {
	repr: DirRepr,
}

#[derive(Debug)]
enum DirRepr {
	Native(native::Handle),
	Provider(PathBuf),
}

/// An open regular file, read with [`File::read_into`] or streamed through
/// [`File::read`]. Closed on drop.
#[derive(Debug)]
pub struct File {
	repr: FileRepr,
	size: u64,
	/// Stream position of [`File::read`].
	pos:  u64,
}

#[derive(Debug)]
enum FileRepr {
	Native(native::Handle),
	Provider(pi_vfs::File),
}

impl File {
	/// Size reported when the file was opened.
	pub const fn size(&self) -> u64 {
		self.size
	}

	/// Replaces `buf`'s contents with up to `limit` leading bytes of the file.
	/// Reads stop at the size reported at open time or at end of file: a read
	/// that returns exactly the remaining size is taken as end of file (no
	/// confirming zero-length read); files reporting size 0 (pseudo files)
	/// and short reads keep reading until end of file or `limit`.
	pub async fn read_into(&mut self, buf: &mut Vec<u8>, limit: u64) -> io::Result<()> {
		match &mut self.repr {
			FileRepr::Native(handle) => {
				fill(buf, self.size, limit, |buf, end| native::read_append(handle, buf, end))
			},
			FileRepr::Provider(file) => {
				if self.pos != 0 {
					file.seek_async(io::SeekFrom::Start(0)).await?;
					self.pos = 0;
				}
				let window = Fill::new(buf, self.size, limit);
				while let Some(end) = window.next(buf) {
					let len = buf.len();
					buf.resize(end, 0);
					let read = file.read_async(&mut buf[len..]).await;
					buf.truncate(len + *read.as_ref().unwrap_or(&0));
					if !Fill::more(read)? {
						break;
					}
				}
				self.pos = buf.len() as u64;
				Ok(())
			},
		}
	}
}

/// The read loop of [`File::read_into`], shared by its sync (native) and
/// async (provider) arms.
struct Fill {
	bound: usize,
}

impl Fill {
	/// Clears `buf` and reserves for up to `limit` bytes of a file whose size
	/// at open time was `size` (0: empty or a pseudo file, read to end of
	/// file).
	fn new(buf: &mut Vec<u8>, size: u64, limit: u64) -> Self {
		buf.clear();
		let limit = usize::try_from(limit).unwrap_or(usize::MAX);
		let bound = if size > 0 {
			usize::try_from(size).unwrap_or(usize::MAX).min(limit)
		} else {
			limit
		};
		buf.reserve(if size > 0 { bound } else { bound.min(4096) });
		Self { bound }
	}

	/// End of the next read window (growing `buf`), `None` once full.
	fn next(&self, buf: &mut Vec<u8>) -> Option<usize> {
		if buf.len() >= self.bound {
			return None;
		}
		if buf.len() == buf.capacity() {
			let grown = buf
				.capacity()
				.saturating_mul(2)
				.saturating_add(4096)
				.min(self.bound);
			buf.reserve(grown - buf.len());
		}
		Some(buf.capacity().min(self.bound))
	}

	/// Whether to keep reading after a read returned `read` (0 is end of
	/// file; interrupted reads retry).
	fn more(read: io::Result<usize>) -> io::Result<bool> {
		match read {
			Ok(0) => Ok(false),
			Ok(_) => Ok(true),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => Ok(true),
			Err(err) => Err(err),
		}
	}
}

/// Fills `buf` through `read` until end of file or `limit` bytes, given the
/// `size` reported at open time; see [`File::read_into`]. `read(buf, end)`
/// appends at most `end - buf.len()` bytes and returns the count (0 at end of
/// file).
fn fill(
	buf: &mut Vec<u8>,
	size: u64,
	limit: u64,
	mut read: impl FnMut(&mut Vec<u8>, usize) -> io::Result<usize>,
) -> io::Result<()> {
	let window = Fill::new(buf, size, limit);
	while let Some(end) = window.next(buf) {
		if !Fill::more(read(buf, end))? {
			break;
		}
	}
	Ok(())
}

/// Sequential reads of a native [`File`], executed inline (see
/// [`File::native_reader`]).
pub struct NativeReader<'a> {
	handle: &'a native::Handle,
	pos:    &'a mut u64,
}

impl io::Read for NativeReader<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let n = native::read_at(self.handle, buf, *self.pos)?;
		*self.pos += n as u64;
		Ok(n)
	}
}

impl File {
	/// Reads the next bytes of the file into `buf`, returning the count (0 at
	/// end of file).
	pub async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let n = match &mut self.repr {
			FileRepr::Native(handle) => native::read_at(handle, buf, self.pos)?,
			FileRepr::Provider(file) => file.read_async(buf).await?,
		};
		self.pos += n as u64;
		Ok(n)
	}

	/// A synchronous reader continuing at the stream position, for native
	/// files (plain syscalls, like every native operation); `None` for
	/// provider files, which are only read asynchronously.
	pub const fn native_reader(&mut self) -> Option<NativeReader<'_>> {
		match &self.repr {
			FileRepr::Native(handle) => Some(NativeReader { handle, pos: &mut self.pos }),
			FileRepr::Provider(_) => None,
		}
	}
}

/// Marker error behind [`is_not_regular`].
#[derive(Debug)]
struct NotRegular;

impl std::fmt::Display for NotRegular {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str("not a regular file")
	}
}

impl std::error::Error for NotRegular {}

/// The error for opening a directory or special file as a regular file.
pub(crate) fn not_regular() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, NotRegular)
}

/// Whether `err` is the error [`Session::open_file_at`] and
/// [`Session::open_file`] return for directories and special files.
pub fn is_not_regular(err: &io::Error) -> bool {
	err.get_ref().is_some_and(|inner| inner.is::<NotRegular>())
}

/// Per-thread filesystem operations. Slices returned by a method stay valid
/// until the next call of the same method.
pub struct Session {
	listing: Listing,
	imp:     Imp,
}

enum Imp {
	Native(native::Scratch),
	Provider(pi_vfs::Fs),
}

/// A directory from another kind of [`Fs`] than the session's.
fn foreign_dir() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, "directory belongs to another filesystem")
}

impl Session {
	/// Opens the directory at an absolute path, following symlinks.
	pub async fn open_dir(&mut self, path: &Path) -> io::Result<Dir> {
		let repr = match &mut self.imp {
			Imp::Native(s) => DirRepr::Native(native::open_dir(s, path)?),
			Imp::Provider(fs) => DirRepr::Provider(provider::open_dir(fs, path).await?),
		};
		Ok(Dir { repr })
	}

	/// Opens the subdirectory `name` of `parent` without following a symlink
	/// that replaced it since `parent` was listed.
	pub async fn open_child(&mut self, parent: &Dir, name: &[u8]) -> io::Result<Dir> {
		let repr = match (&mut self.imp, &parent.repr) {
			(Imp::Native(s), DirRepr::Native(h)) => DirRepr::Native(native::open_child(s, h, name)?),
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				DirRepr::Provider(provider::open_child(fs, path, name).await?)
			},
			_ => return Err(foreign_dir()),
		};
		Ok(Dir { repr })
	}

	/// Lists every entry of `dir` except `.` and `..`, skipping special files
	/// and entries that vanish between listing and their metadata lookup.
	/// `children` is the entry count from the parent's listing (0 when
	/// unknown); readers may use it to end early. Provider listings reject
	/// names that are not a single path component with
	/// [`io::ErrorKind::InvalidData`]. A native handle reads from its current
	/// position (no rewind syscall), so list each [`Dir`] once; open it again
	/// to list it again.
	pub async fn list(&mut self, dir: &Dir, detail: Detail, children: u32) -> io::Result<&Listing> {
		list_with(&mut self.imp, dir, detail, children, &mut self.listing).await?;
		Ok(&self.listing)
	}

	/// [`Self::list`] into a caller-owned listing (cleared first), so callers
	/// can keep it while using the session again.
	pub(crate) async fn list_into(
		&mut self,
		dir: &Dir,
		detail: Detail,
		children: u32,
		out: &mut Listing,
	) -> io::Result<()> {
		list_with(&mut self.imp, dir, detail, children, out).await
	}

	/// Opens the regular file `name` (one component) in `dir`, following
	/// symlinks, and describes it. Fails for directories and special files
	/// (see [`is_not_regular`]); FIFOs never block the open.
	pub async fn open_file_at(&mut self, dir: &Dir, name: &[u8]) -> io::Result<(File, FileInfo)> {
		let (repr, info) = match (&mut self.imp, &dir.repr) {
			(Imp::Native(s), DirRepr::Native(h)) => {
				let (handle, info) = native::open_file_at(s, h, name)?;
				(FileRepr::Native(handle), info)
			},
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				let (file, info) = provider::open_file(fs, &provider::child(path, name)).await?;
				(FileRepr::Provider(file), info)
			},
			_ => return Err(foreign_dir()),
		};
		Ok((File { repr, size: info.size, pos: 0 }, info))
	}

	/// [`Self::open_file_at`] for an absolute path.
	pub async fn open_file(&mut self, path: &Path) -> io::Result<(File, FileInfo)> {
		let (repr, info) = match &mut self.imp {
			Imp::Native(s) => {
				let (handle, info) = native::open_file(s, path)?;
				(FileRepr::Native(handle), info)
			},
			Imp::Provider(fs) => {
				let (file, info) = provider::open_file(fs, path).await?;
				(FileRepr::Provider(file), info)
			},
		};
		Ok((File { repr, size: info.size, pos: 0 }, info))
	}

	/// Describes the file or directory at an absolute path, following a final
	/// symlink only when `follow` is set.
	pub async fn stat(&mut self, path: &Path, follow: bool) -> io::Result<FileInfo> {
		match &mut self.imp {
			Imp::Native(s) => native::stat(s, path, follow),
			Imp::Provider(fs) => provider::stat(fs, path, follow).await,
		}
	}

	/// Stamps an open directory.
	pub async fn stat_dir(&mut self, dir: &Dir) -> io::Result<Stamp> {
		match (&mut self.imp, &dir.repr) {
			(Imp::Native(_), DirRepr::Native(h)) => native::stat_dir(h),
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				provider::stat(fs, path, true).await.map(|info| info.stamp)
			},
			_ => Err(foreign_dir()),
		}
	}

	/// Identity of the file or directory at an absolute path, following
	/// symlinks. Walkers compare identities to stop symlink cycles and to
	/// stay on one filesystem.
	pub async fn identify(&mut self, path: &Path) -> io::Result<FileId> {
		match &mut self.imp {
			Imp::Native(s) => native::identify(s, path),
			Imp::Provider(fs) => provider::identify(fs, path).await,
		}
	}

	/// Identity of an open directory.
	pub async fn identify_dir(&mut self, dir: &Dir) -> io::Result<FileId> {
		match (&mut self.imp, &dir.repr) {
			(Imp::Native(_), DirRepr::Native(h)) => native::identify_dir(h),
			(Imp::Provider(fs), DirRepr::Provider(path)) => provider::identify(fs, path).await,
			_ => Err(foreign_dir()),
		}
	}

	/// Whether every change to a directory on `dir`'s filesystem (whose stamp
	/// is `stamp`) yields a different stamp: timestamps are fine-grained and
	/// maintained locally (APFS; ext4, XFS, Btrfs, tmpfs, F2FS, ZFS,
	/// bcachefs; NTFS, `ReFS`). Always false for providers. Listing caches rely
	/// on it.
	pub fn stable_stamps(&mut self, dir: &Dir, stamp: &Stamp) -> bool {
		match (&self.imp, &dir.repr) {
			(Imp::Native(_), DirRepr::Native(h)) => native::stable_stamps(h, stamp),
			_ => false,
		}
	}
}

async fn list_with(
	imp: &mut Imp,
	dir: &Dir,
	detail: Detail,
	children: u32,
	out: &mut Listing,
) -> io::Result<()> {
	out.clear();
	match (imp, &dir.repr) {
		(Imp::Native(s), DirRepr::Native(h)) => native::list(s, h, detail, children, out),
		(Imp::Provider(fs), DirRepr::Provider(path)) => provider::list(fs, path, detail, out).await,
		_ => Err(foreign_dir()),
	}
}

#[cfg(test)]
mod tests;
