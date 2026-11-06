//! The engine's filesystem over pi-vfs.
//!
//! [`VfsFs`] routes every path by [`pi_vfs::Fs::is_native_local`]:
//!
//! - **Native-local paths** go to [`crate::sys::StdFs`], so host files, FIFOs,
//!   devices and terminals behave exactly as under obash: `Ready` answers from
//!   local syscalls, a `Pending` FIFO open, readiness-gated pipe I/O and OS
//!   handles that externals inherit directly.
//! - **Provider paths** (URLs, descriptor overlays) run the `pi_vfs::Fs`
//!   operation as a task on the tokio runtime given to [`VfsFs::new`] and
//!   return `Pending`; the task's completion wakes the waker the engine polled
//!   with. Dropping the pending operation aborts the task.
//!
//! An open provider file is a [`File`] over [`pi_vfs::File`] whose reads,
//! writes and flushes are owned-buffer tasks on the same runtime. A provider
//! may still hand back a host file from `open`; that file becomes a
//! [`StdFile`] like any native-local open.
//!
//! # Stat mapping
//!
//! [`pi_vfs::Metadata`] → [`Stat`]: `kind` from the file type (an unknown
//! type is a character device, as `StdFs` classifies what it cannot name),
//! `mode` the low `0o7777` bits of `st_mode`, `size` the length. Fields a
//! provider leaves out:
//!
//! - `uid`/`gid`: the process's effective ids, so `test -O`/`-G` hold for the
//!   provider's own objects, consistent with the provider `access` default that
//!   judges the owner permission bits;
//! - `dev`/`ino`: a synthetic identity, `dev` = [`u64::MAX`] and `ino` a hash
//!   of the path asked for, so `-ef` holds for the same spelling and not for
//!   two different unidentified objects (it misses aliases through symlinks);
//! - `nlink`: 1; `blocks`: `ceil(size / 512)`;
//! - times: a missing mtime is the epoch, a missing atime or ctime is the mtime
//!   (so `test -N` is false and ctime sorts like mtime).
//!
//! # Provider file choices
//!
//! - `kind()` is fixed at open from the file's metadata: regular files are
//!   [`FileKind::Regular`], FIFOs [`FileKind::Pipe`], sockets
//!   [`FileKind::Socket`], anything else (and a file whose metadata fails)
//!   [`FileKind::Device`]. A regular provider file whose position cannot be
//!   read at open (`seek(Current(0))` fails) is a [`FileKind::Device`]: it is a
//!   stream the engine must not read ahead in, since it cannot seek back.
//! - `seek` never waits: the adapter tracks the position of the open file
//!   description (probed at open, advanced by every read and write it reports)
//!   and records the target as a pending absolute seek, which the next read or
//!   write applies on the runtime before its own I/O (and which is applied in
//!   the background when the last duplicate closes). Its error, if any, is that
//!   read's or write's error. `SeekFrom::End` and a relative seek once the
//!   position is unknown (after an `O_APPEND` write, or on a non-regular file)
//!   fail with [`io::ErrorKind::NotSeekable`].
//! - `dup` shares the open file description, as `dup(2)` does: the same
//!   [`pi_vfs::File`] (whose provider cursor is shared anyway) and the same
//!   position bookkeeping, so a seek made through one duplicate (the `read`
//!   builtin giving back what it read past the delimiter) is seen by the next
//!   read through another.
//! - `os_handle` is `None`: the host pumps provider files for externals.
//! - A write moves at most 1 MiB per call and reports only what the provider
//!   wrote. Dropping a file aborts a read in flight; a write or flush in flight
//!   finishes in the background.
//!
//! # Running out of descriptors
//!
//! An open that fails with `EMFILE` names the soft limit it ran into and
//! says to raise `ulimit -n` before starting the process (the engine prints
//! the error as the redirection's diagnostic). The shell's own `ulimit -n`
//! only reaches the externals it spawns, so the hint points before the
//! start.
//!
//! # Temp nodes
//!
//! [`Fs::mkfifo_or_temp`] names no directory, so it always creates the FIFO
//! or temp file on the host (`StdFs`, the host temp directory), whatever the
//! provider serves.

use std::{
	future::Future,
	hash::{DefaultHasher, Hash, Hasher},
	io,
	path::{Path, PathBuf},
	pin::Pin,
	sync::Arc,
	task::{Context, Poll, ready},
};

use bstr::{BStr, BString};
use parking_lot::{Mutex, RwLock};
use pi_vfs::FileKind as VfsKind;
use tokio::{
	runtime::Handle,
	task::{JoinError, JoinHandle},
};

use crate::{
	bash::{
		DirEntry, DirIter, File, FileKind, Fs, FsPending, FsPoll, OpenFlags, OsHandle, Stat,
		fs::{Access, SeekFrom, StatKind, TempNode, TempPurpose},
	},
	sys::{StdFile, StdFs},
};

/// Most bytes one provider read or write moves.
const MAX_CHUNK: usize = 1 << 20;

/// `dev` of the synthetic identity given to provider objects without one.
const SYNTHETIC_DEV: u64 = u64::MAX;

/// The engine's [`Fs`] over a [`pi_vfs::Fs`].
///
/// Clones share the filesystem slot: [`VfsFs::set_filesystem`] on any clone
/// (installing a per-run [`pi_vfs::Fs::with_cancellation`] view, say) applies
/// to operations every clone starts afterwards.
#[derive(Clone)]
pub struct VfsFs {
	fs: Arc<RwLock<pi_vfs::Fs>>,
	rt: Handle,
}

impl VfsFs {
	/// Serve `fs`, running provider operations on `rt`.
	pub fn new(fs: pi_vfs::Fs, rt: Handle) -> Self {
		Self { fs: Arc::new(RwLock::new(fs)), rt }
	}

	/// The filesystem operations start on.
	pub fn filesystem(&self) -> pi_vfs::Fs {
		self.fs.read().clone()
	}

	/// Replace the filesystem for operations started from now on (operations
	/// in flight keep the one they started with).
	pub fn set_filesystem(&self, fs: pi_vfs::Fs) {
		*self.fs.write() = fs;
	}

	/// Whether `path` is a plain host object of the current filesystem
	/// ([`pi_vfs::Fs::is_native_local`]): never a URL or a descriptor overlay.
	pub fn is_native_local(&self, path: &BStr) -> bool {
		host_path(path).is_ok_and(|host| self.fs.read().is_native_local(host))
	}

	/// `native()` for a native-local `path`; otherwise `provider` run on the
	/// runtime with the current filesystem and the host spelling of `path`.
	fn route<T, F>(
		&self,
		path: &BStr,
		native: impl FnOnce() -> FsPoll<T>,
		provider: impl FnOnce(pi_vfs::Fs, PathBuf) -> F,
	) -> FsPoll<T>
	where
		T: Send + 'static,
		F: Future<Output = io::Result<T>> + Send + 'static,
	{
		let host = match host_path(path) {
			Ok(host) => host,
			Err(err) => return FsPoll::Ready(Err(err)),
		};
		let current = self.fs.read();
		if current.is_native_local(host) {
			drop(current);
			return native();
		}
		let fs = pi_vfs::Fs::clone(&current);
		drop(current);
		FsPoll::Pending(Box::new(Spawned(self.rt.spawn(provider(fs, host.to_path_buf())))))
	}
}

impl Fs for VfsFs {
	fn open(&mut self, path: &BStr, flags: OpenFlags, mode: u32) -> FsPoll<Box<dyn File>> {
		let rt = self.rt.clone();
		self.route(
			path,
			|| match StdFs::default().open(path, flags, mode) {
				FsPoll::Ready(Err(err)) => FsPoll::Ready(Err(name_the_limit(err))),
				opened => opened,
			},
			move |fs, path| async move {
				let file = fs
					.open_with(&path, &open_options(flags, mode))
					.await
					.map_err(name_the_limit)?;
				Ok(engine_file(file, rt, flags).await)
			},
		)
	}

	fn stat(&mut self, path: &BStr, follow: bool) -> FsPoll<Stat> {
		self.route(
			path,
			|| StdFs::default().stat(path, follow),
			move |fs, path| async move {
				let meta = if follow {
					fs.metadata(&path).await?
				} else {
					fs.symlink_metadata(&path).await?
				};
				Ok(stat_of(&meta, &path))
			},
		)
	}

	fn access(&mut self, path: &BStr, mode: Access) -> FsPoll<()> {
		self.route(
			path,
			|| StdFs::default().access(path, mode),
			move |fs, path| async move {
				fs.access(
					&path,
					mode.contains(Access::READ),
					mode.contains(Access::WRITE),
					mode.contains(Access::EXEC),
				)
				.await
			},
		)
	}

	fn read_dir(&mut self, path: &BStr) -> FsPoll<Box<dyn DirIter>> {
		self.route(
			path,
			|| StdFs::default().read_dir(path),
			|fs, path| async move {
				// A provider listing is in memory once `read_dir` answers; only
				// the types it listed are used, since asking for the others
				// would be a provider call per entry.
				let entries: Vec<io::Result<DirEntry>> = fs
					.read_dir(&path)
					.await?
					.map(|entry| {
						entry.map(|entry| DirEntry {
							name: os_bytes(entry.file_name().as_os_str()),
							kind: entry.known_file_type().and_then(|t| listed_kind(t.kind())),
						})
					})
					.collect();
				Ok(Box::new(Listing(entries.into_iter())) as Box<dyn DirIter>)
			},
		)
	}

	fn readlink(&mut self, path: &BStr) -> FsPoll<BString> {
		self.route(
			path,
			|| StdFs::default().readlink(path),
			|fs, path| async move { Ok(os_bytes(fs.read_link(&path).await?.as_os_str())) },
		)
	}

	fn realpath(&mut self, path: &BStr) -> FsPoll<BString> {
		self.route(
			path,
			|| StdFs::default().realpath(path),
			|fs, path| async move { Ok(os_bytes(fs.canonicalize(&path).await?.as_os_str())) },
		)
	}

	fn mkfifo_or_temp(&mut self, purpose: TempPurpose) -> FsPoll<TempNode> {
		StdFs::default().mkfifo_or_temp(purpose)
	}

	fn chdir_check(&mut self, path: &BStr) -> FsPoll<()> {
		self.route(
			path,
			|| StdFs::default().chdir_check(path),
			|fs, path| async move {
				if !fs.metadata(&path).await?.is_dir() {
					return Err(io::ErrorKind::NotADirectory.into());
				}
				fs.access(&path, false, false, true).await
			},
		)
	}

	fn unlink(&mut self, path: &BStr) -> FsPoll<()> {
		self.route(
			path,
			|| StdFs::default().unlink(path),
			|fs, path| async move { fs.remove_file(&path).await },
		)
	}

	fn rename(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		let to_host = match host_path(to) {
			Ok(t) => t.to_path_buf(),
			Err(err) => return FsPoll::Ready(Err(err)),
		};
		self.route(
			from,
			|| StdFs::default().rename(from, to),
			|fs, from| async move { fs.rename(&from, &to_host).await },
		)
	}

	fn symlink(&mut self, target: &BStr, path: &BStr) -> FsPoll<()> {
		let target_host = match host_path(target) {
			Ok(t) => t.to_path_buf(),
			Err(err) => return FsPoll::Ready(Err(err)),
		};
		self.route(
			path,
			|| StdFs::default().symlink(target, path),
			|fs, path| async move { fs.symlink(&target_host, &path).await },
		)
	}

	fn link(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		let to_host = match host_path(to) {
			Ok(t) => t.to_path_buf(),
			Err(err) => return FsPoll::Ready(Err(err)),
		};
		self.route(
			from,
			|| StdFs::default().link(from, to),
			|fs, from| async move { fs.hard_link(&from, &to_host).await },
		)
	}

	fn lock(&mut self, path: &BStr) -> FsPoll<Box<dyn File>> {
		// Record locks are an OS-descriptor feature: only native files have them.
		self.route(
			path,
			|| StdFs::default().lock(path),
			|_, _| async move { Err(io::ErrorKind::Unsupported.into()) },
		)
	}

	fn mkdir(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		self.route(
			path,
			|| StdFs::default().mkdir(path, mode),
			move |fs, path| async move {
				fs.create_dir_with(&path, &pi_vfs::DirOptions::new().mode(mode))
					.await
			},
		)
	}

	fn rmdir(&mut self, path: &BStr) -> FsPoll<()> {
		self.route(
			path,
			|| StdFs::default().rmdir(path),
			|fs, path| async move { fs.remove_dir(&path).await },
		)
	}

	fn chmod(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		self.route(
			path,
			|| StdFs::default().chmod(path, mode),
			move |fs, path| async move {
				fs.set_permissions(&path, pi_vfs::Permissions::from_mode(mode & 0o7777))
					.await
			},
		)
	}

	fn chown(
		&mut self,
		path: &BStr,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> FsPoll<()> {
		self.route(
			path,
			|| StdFs::default().chown(path, uid, gid, follow),
			move |fs, path| async move { fs.chown(&path, uid, gid, follow).await },
		)
	}

	fn sync(&mut self) -> FsPoll<()> {
		// Providers persist each write themselves: only host buffers wait.
		StdFs::default().sync()
	}

	fn getxattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<BString> {
		let name_os = match xattr_name(name) {
			Ok(n) => n,
			Err(err) => return FsPoll::Ready(Err(err)),
		};
		self.route(
			path,
			|| StdFs::default().getxattr(path, name, follow),
			move |fs, path| async move {
				match fs.get_xattr(&path, &name_os, follow).await? {
					Some(value) => Ok(BString::from(value)),
					None => Err(no_such_attribute()),
				}
			},
		)
	}

	fn setxattr(&mut self, path: &BStr, name: &BStr, value: &[u8], follow: bool) -> FsPoll<()> {
		let name_os = match xattr_name(name) {
			Ok(n) => n,
			Err(err) => return FsPoll::Ready(Err(err)),
		};
		let owned = value.to_vec();
		self.route(
			path,
			|| StdFs::default().setxattr(path, name, value, follow),
			move |fs, path| async move { fs.set_xattr(&path, &name_os, &owned, follow).await },
		)
	}

	fn removexattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<()> {
		let name_os = match xattr_name(name) {
			Ok(n) => n,
			Err(err) => return FsPoll::Ready(Err(err)),
		};
		self.route(
			path,
			|| StdFs::default().removexattr(path, name, follow),
			move |fs, path| async move { fs.remove_xattr(&path, &name_os, follow).await },
		)
	}

	fn listxattr(&mut self, path: &BStr, follow: bool) -> FsPoll<Vec<BString>> {
		self.route(
			path,
			|| StdFs::default().listxattr(path, follow),
			move |fs, path| async move {
				Ok(fs
					.list_xattr(&path, follow)
					.await?
					.iter()
					.map(|n| os_bytes(n))
					.collect())
			},
		)
	}

	fn user_db(
		&mut self,
		query: &crate::bash::fs::PwQuery,
	) -> FsPoll<Vec<crate::bash::fs::PwEntry>> {
		// The account database is the host's whatever filesystem is mounted.
		StdFs::default().user_db(query)
	}
}

/// An extended attribute name as the provider API takes it.
fn xattr_name(name: &BStr) -> io::Result<std::ffi::OsString> {
	<[u8] as bstr::ByteSlice>::to_os_str(name)
		.map(std::ffi::OsStr::to_os_string)
		.map_err(|_| io::ErrorKind::InvalidInput.into())
}

/// `ENOATTR`: a provider reported no attribute of that name.
fn no_such_attribute() -> io::Error {
	#[cfg(any(target_os = "macos", target_os = "ios"))]
	return io::Error::from_raw_os_error(libc::ENOATTR);
	#[cfg(all(unix, not(any(target_os = "macos", target_os = "ios"))))]
	return io::Error::from_raw_os_error(libc::ENODATA);
	#[cfg(not(unix))]
	return io::ErrorKind::NotFound.into();
}

/// `err`, with the open-file limit named when it is `EMFILE` (see the module
/// docs); any other error unchanged.
fn name_the_limit(err: io::Error) -> io::Error {
	#[cfg(unix)]
	if err.raw_os_error() == Some(libc::EMFILE)
		&& let Ok((Some(limit), _)) = crate::sys::rlimit::get(crate::bash::Rlimit::Nofile)
	{
		return io::Error::new(err.kind(), DescriptorLimit { limit });
	}
	err
}

/// `EMFILE` under a soft open-file limit of `limit`.
#[cfg(unix)]
#[derive(Debug, thiserror::Error)]
#[error(
	"Too many open files (this process reached its limit of {limit} open files; raise `ulimit -n` \
	 before starting it)"
)]
struct DescriptorLimit {
	limit: u64,
}

/// Engine path → host path, byte for byte on Unix.
#[cfg(unix)]
#[allow(clippy::unnecessary_wraps, reason = "only Windows rejects a path")]
fn host_path(path: &BStr) -> io::Result<&Path> {
	use std::os::unix::ffi::OsStrExt;
	Ok(Path::new(std::ffi::OsStr::from_bytes(path)))
}

/// Engine path → host path (UTF-8 required).
#[cfg(not(unix))]
fn host_path(path: &BStr) -> io::Result<&Path> {
	use bstr::ByteSlice;
	path
		.to_path()
		.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

/// Host path or name → engine bytes.
fn os_bytes(s: &std::ffi::OsStr) -> BString {
	BString::from(s.as_encoded_bytes())
}

fn open_options(flags: OpenFlags, mode: u32) -> pi_vfs::OpenOptions {
	let mut options = pi_vfs::OpenOptions::new();
	options
		.read(flags.contains(OpenFlags::READ))
		.write(flags.contains(OpenFlags::WRITE))
		.append(flags.contains(OpenFlags::APPEND))
		.truncate(flags.contains(OpenFlags::TRUNC))
		.create(flags.contains(OpenFlags::CREATE))
		.create_new(flags.contains(OpenFlags::EXCL))
		.mode(mode);
	options
}

/// A provider operation running on the runtime; dropping it aborts it.
struct Spawned<T>(JoinHandle<io::Result<T>>);

impl<T: Send + 'static> FsPending<T> for Spawned<T> {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
		Pin::new(&mut self.0).poll(cx).map(joined)
	}
}

impl<T> Drop for Spawned<T> {
	fn drop(&mut self) {
		self.0.abort();
	}
}

/// A task's result; a panicked or aborted task (the runtime shut down) is an
/// I/O error.
fn joined<T>(result: Result<io::Result<T>, JoinError>) -> io::Result<T> {
	result.unwrap_or_else(|err| Err(io::Error::other(err)))
}

/// A provider listing, collected when the listing answered.
struct Listing(std::vec::IntoIter<io::Result<DirEntry>>);

impl DirIter for Listing {
	fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<Option<io::Result<DirEntry>>> {
		Poll::Ready(self.0.next())
	}
}

/// Stat type of a pi-vfs kind; unknown types read as character devices.
const fn stat_kind(kind: VfsKind) -> StatKind {
	match listed_kind(kind) {
		Some(kind) => kind,
		None => StatKind::CharDev,
	}
}

/// Stat type of a listed pi-vfs kind; `None` when the listing does not know.
const fn listed_kind(kind: VfsKind) -> Option<StatKind> {
	Some(match kind {
		VfsKind::File => StatKind::File,
		VfsKind::Dir => StatKind::Dir,
		VfsKind::Symlink => StatKind::Symlink,
		VfsKind::Fifo => StatKind::Fifo,
		VfsKind::Socket => StatKind::Socket,
		VfsKind::CharDevice => StatKind::CharDev,
		VfsKind::BlockDevice => StatKind::BlockDev,
		VfsKind::Unknown => return None,
	})
}

/// Nanoseconds since the epoch of a `(seconds, nanoseconds)` timestamp.
fn time_ns(secs: i64, nsec: Option<i64>) -> i64 {
	secs
		.saturating_mul(1_000_000_000)
		.saturating_add(nsec.unwrap_or(0))
}

/// The effective uid and gid of this process.
#[cfg(unix)]
fn owner() -> (u32, u32) {
	// SAFETY: `geteuid` and `getegid` always succeed and touch no memory.
	unsafe { (libc::geteuid(), libc::getegid()) }
}

/// No owner ids off Unix.
#[cfg(not(unix))]
const fn owner() -> (u32, u32) {
	(0, 0)
}

/// [`Stat`] of provider metadata for `path` (see the module docs for the
/// fields a provider may leave out).
fn stat_of(meta: &pi_vfs::Metadata, path: &Path) -> Stat {
	let size = meta.len();
	let (dev, ino) = meta.dev().zip(meta.ino()).unwrap_or_else(|| {
		let mut hasher = DefaultHasher::new();
		path.hash(&mut hasher);
		(SYNTHETIC_DEV, hasher.finish())
	});
	let (euid, egid) = owner();
	let mtime_ns = meta
		.mtime()
		.map_or(0, |secs| time_ns(secs, meta.mtime_nsec()));
	Stat {
		kind: stat_kind(meta.file_type().kind()),
		mode: meta.mode() & 0o7777,
		size,
		uid: meta.uid().unwrap_or(euid),
		gid: meta.gid().unwrap_or(egid),
		dev,
		ino,
		nlink: meta.nlink().unwrap_or(1),
		mtime_ns,
		atime_ns: meta
			.atime()
			.map_or(mtime_ns, |secs| time_ns(secs, meta.atime_nsec())),
		ctime_ns: meta
			.ctime()
			.map_or(mtime_ns, |secs| time_ns(secs, meta.ctime_nsec())),
		blocks: meta.blocks().unwrap_or_else(|| size.div_ceil(512)),
		rdev: meta.rdev().unwrap_or(0),
		blksize: meta.blksize().unwrap_or(4096),
	}
}

/// The engine file for a file `open` returned: a host file as [`StdFile`],
/// a provider file as [`VfsFile`] (its kind and position read now).
async fn engine_file(file: pi_vfs::File, rt: Handle, flags: OpenFlags) -> Box<dyn File> {
	let file = match file.into_native() {
		Ok(native) => return Box::new(StdFile::new(native)),
		Err(file) => file,
	};
	let mut kind = match file.metadata_async().await.map(|m| m.file_type().kind()) {
		Ok(VfsKind::File) => FileKind::Regular,
		Ok(VfsKind::Fifo) => FileKind::Pipe,
		Ok(VfsKind::Socket) => FileKind::Socket,
		_ => FileKind::Device,
	};
	let pos = if kind == FileKind::Regular {
		file.seek_async(SeekFrom::Current(0)).await.ok()
	} else {
		None
	};
	if pos.is_none() {
		kind = FileKind::Device;
	}
	let desc = Description {
		file: Arc::new(file),
		rt,
		kind,
		read: flags.contains(OpenFlags::READ),
		write: flags.contains(OpenFlags::WRITE) || flags.contains(OpenFlags::APPEND),
		append: flags.contains(OpenFlags::APPEND),
		cursor: Mutex::new(Cursor { pos, seek: None }),
	};
	Box::new(VfsFile::new(Arc::new(desc)))
}

/// One open file description of a provider file, shared by its duplicates.
struct Description {
	file:   Arc<pi_vfs::File>,
	rt:     Handle,
	kind:   FileKind,
	/// Opened for reading.
	read:   bool,
	/// Opened for writing (or appending).
	write:  bool,
	/// Every write goes to the end (`O_APPEND`).
	append: bool,
	cursor: Mutex<Cursor>,
}

/// Position bookkeeping of a [`Description`].
struct Cursor {
	/// Offset the engine has reached (bytes handed out or written), when
	/// known.
	pos:  Option<u64>,
	/// Seek the provider has not applied yet; the next read or write applies
	/// it first.
	seek: Option<u64>,
}

impl Description {
	/// Run `op` on the runtime, after any pending seek.
	fn spawn<T, F>(&self, op: impl FnOnce(Arc<pi_vfs::File>) -> F) -> JoinHandle<io::Result<T>>
	where
		T: Send + 'static,
		F: Future<Output = io::Result<T>> + Send + 'static,
	{
		let seek = self.cursor.lock().seek.take();
		let file = Arc::clone(&self.file);
		let op = op(Arc::clone(&file));
		self.rt.spawn(async move {
			if let Some(to) = seek {
				file.seek_async(SeekFrom::Start(to)).await?;
			}
			op.await
		})
	}

	/// Account for `n` bytes the engine has read or written.
	fn advance(&self, n: usize, wrote: bool) {
		let mut cursor = self.cursor.lock();
		cursor.pos = if wrote && self.append {
			None
		} else {
			cursor
				.pos
				.zip(u64::try_from(n).ok())
				.and_then(|(pos, n)| pos.checked_add(n))
		};
	}
}

impl Drop for Description {
	/// A seek the engine made (giving back read-ahead) still moves the
	/// provider's cursor, which other handles of the provider file may share.
	fn drop(&mut self) {
		if let Some(to) = self.cursor.get_mut().seek.take() {
			let file = Arc::clone(&self.file);
			drop(
				self
					.rt
					.spawn(async move { file.seek_async(SeekFrom::Start(to)).await }),
			);
		}
	}
}

/// A provider operation in flight on a [`VfsFile`].
enum Op {
	Read(JoinHandle<io::Result<Vec<u8>>>),
	Write(JoinHandle<io::Result<usize>>),
	Flush(JoinHandle<io::Result<()>>),
}

/// A provider file as an engine [`File`].
struct VfsFile {
	desc:     Arc<Description>,
	op:       Option<Op>,
	/// Bytes a provider read returned beyond the buffer the engine polled
	/// with last (it polled again with a smaller one); the provider's cursor
	/// is past them.
	ahead:    Vec<u8>,
	/// How much of `ahead` was handed out.
	ahead_at: usize,
}

impl VfsFile {
	const fn new(desc: Arc<Description>) -> Self {
		Self { desc, op: None, ahead: Vec::new(), ahead_at: 0 }
	}

	/// Hand out read-ahead into `buf`.
	fn take_ahead(&mut self, buf: &mut [u8]) -> usize {
		let rest = &self.ahead[self.ahead_at..];
		let n = rest.len().min(buf.len());
		buf[..n].copy_from_slice(&rest[..n]);
		self.ahead_at += n;
		self.desc.advance(n, false);
		n
	}

	/// Wait for the operation in flight, whatever it is, keeping a read's
	/// bytes as read-ahead and accounting for a write's.
	fn settle(&mut self, cx: &mut Context<'_>) -> Poll<()> {
		let Some(op) = &mut self.op else {
			return Poll::Ready(());
		};
		match op {
			Op::Read(task) => {
				if let Ok(data) = ready!(poll_task(task, cx)) {
					self.ahead = data;
					self.ahead_at = 0;
				}
			},
			Op::Write(task) => {
				if let Ok(n) = ready!(poll_task(task, cx)) {
					self.desc.advance(n, true);
				}
			},
			Op::Flush(task) => drop(ready!(poll_task(task, cx))),
		}
		self.op = None;
		Poll::Ready(())
	}

	/// Give read-ahead back to the provider before writing: seek back to the
	/// position the engine reached.
	fn drop_ahead(&mut self) {
		if self.ahead_at < self.ahead.len() {
			let mut cursor = self.desc.cursor.lock();
			if let Some(pos) = cursor.pos {
				cursor.seek = Some(pos);
			}
		}
		self.ahead.clear();
		self.ahead_at = 0;
	}
}

fn poll_task<T>(task: &mut JoinHandle<io::Result<T>>, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
	Pin::new(task).poll(cx).map(joined)
}

/// Zero-length I/O: nothing in a direction the file was opened for,
/// `Unsupported` in the other (the engine's direction probe).
fn probe(allowed: bool) -> Poll<io::Result<usize>> {
	Poll::Ready(if allowed {
		Ok(0)
	} else {
		Err(io::ErrorKind::Unsupported.into())
	})
}

impl File for VfsFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		if buf.is_empty() {
			return probe(self.desc.read);
		}
		loop {
			if self.ahead_at < self.ahead.len() {
				return Poll::Ready(Ok(self.take_ahead(buf)));
			}
			match &mut self.op {
				Some(Op::Read(task)) => {
					let data = ready!(poll_task(task, cx));
					self.op = None;
					match data {
						Ok(data) => {
							self.ahead = data;
							self.ahead_at = 0;
							if self.ahead.is_empty() {
								return Poll::Ready(Ok(0));
							}
						},
						Err(err) => return Poll::Ready(Err(err)),
					}
				},
				Some(_) => ready!(self.settle(cx)),
				None => {
					let len = buf.len().min(MAX_CHUNK);
					self.op = Some(Op::Read(self.desc.spawn(|file| async move {
						let mut data = vec![0; len];
						let n = file.read_async(&mut data).await?;
						data.truncate(n);
						Ok(data)
					})));
				},
			}
		}
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if buf.is_empty() {
			return probe(self.desc.write);
		}
		loop {
			match &mut self.op {
				Some(Op::Write(task)) => {
					let written = ready!(poll_task(task, cx));
					self.op = None;
					if let Ok(n) = written {
						self.desc.advance(n, true);
					}
					return Poll::Ready(written);
				},
				Some(_) => ready!(self.settle(cx)),
				None => {
					self.drop_ahead();
					let data = buf[..buf.len().min(MAX_CHUNK)].to_vec();
					self.op = Some(Op::Write(
						self
							.desc
							.spawn(|file| async move { file.write_async(&data).await }),
					));
				},
			}
		}
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		loop {
			match &mut self.op {
				Some(Op::Flush(task)) => {
					let flushed = ready!(poll_task(task, cx));
					self.op = None;
					return Poll::Ready(flushed);
				},
				Some(_) => ready!(self.settle(cx)),
				None => {
					let file = Arc::clone(&self.desc.file);
					self.op =
						Some(Op::Flush(self.desc.rt.spawn(async move { file.flush_async().await })));
				},
			}
		}
	}

	/// Records the target for the next read or write; see the module docs.
	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		match &self.op {
			Some(Op::Read(task)) => task.abort(),
			Some(Op::Write(_) | Op::Flush(_)) => return Err(io::ErrorKind::WouldBlock.into()),
			None => {},
		}
		let mut cursor = self.desc.cursor.lock();
		let to = match pos {
			SeekFrom::Start(to) => to,
			SeekFrom::Current(by) => cursor
				.pos
				.ok_or(io::ErrorKind::NotSeekable)?
				.checked_add_signed(by)
				.ok_or(io::ErrorKind::InvalidInput)?,
			SeekFrom::End(_) => return Err(io::ErrorKind::NotSeekable.into()),
		};
		cursor.pos = Some(to);
		cursor.seek = Some(to);
		drop(cursor);
		self.op = None;
		self.ahead.clear();
		self.ahead_at = 0;
		Ok(to)
	}

	fn kind(&self) -> FileKind {
		self.desc.kind
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self::new(Arc::clone(&self.desc))))
	}
}

impl Drop for VfsFile {
	fn drop(&mut self) {
		if let Some(Op::Read(task)) = &self.op {
			task.abort();
		}
	}
}
