//! Filesystem probes that answer with the failing `errno` (zsh/files,
//! zsh/stat, zsh/attr, zsh/mapfile): every [`Fs`] operation a module
//! builtin or special parameter needs, including the mutations, as one
//! serializable request ([`FsReq`]) and answer ([`FsAns`] or [`FsErr`]).
//!
//! A builtin issues them as [`Probe::Fs`](super::proc::Probe::Fs) with a
//! sequence number: it re-runs from scratch after each answer, so its n-th
//! request is answered from the cache on every later run, and the same
//! request made twice (`mkdir a a`) is two distinct probes.

use std::{
	io,
	task::{Context, Poll},
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use super::{
	Cx,
	proc::{Live, Scratch, Vproc},
};
use crate::bash::{
	diag,
	event::WaitKey,
	fs::{DirIter, File, Fs, FsOp, FsPending, FsPoll, OpenFlags, PwEntry, PwQuery, Stat},
};

/// A filesystem request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FsReq {
	/// `stat` (`follow`) or `lstat`.
	Stat { path: BString, follow: bool },
	/// `fstat` of an engine fd.
	FdStat { fd: i32 },
	/// `access(path, W_OK)`-style check; `mode` bits 1 = read, 2 = write,
	/// 4 = execute.
	Access { path: BString, mode: u8 },
	/// `readlink`.
	ReadLink { path: BString },
	/// The entry names of a directory (no `.` or `..`), in listing order.
	ReadDir { path: BString },
	/// `mkdir` with exactly `mode`.
	Mkdir { path: BString, mode: u32 },
	/// `rmdir`.
	Rmdir { path: BString },
	/// `unlink`.
	Unlink { path: BString },
	/// `rename`.
	Rename { from: BString, to: BString },
	/// `symlink(target, path)`.
	Symlink { target: BString, path: BString },
	/// `link(from, to)`.
	Link { from: BString, to: BString },
	/// `chmod`.
	Chmod { path: BString, mode: u32 },
	/// `chown` (`follow`) or `lchown`.
	Chown { path: BString, uid: Option<u32>, gid: Option<u32>, follow: bool },
	/// `sync`.
	Sync,
	/// `getxattr`.
	GetXattr { path: BString, name: BString, follow: bool },
	/// `setxattr`.
	SetXattr { path: BString, name: BString, value: BString, follow: bool },
	/// `removexattr`.
	RemoveXattr { path: BString, name: BString, follow: bool },
	/// `listxattr`.
	ListXattr { path: BString, follow: bool },
	/// The whole contents of a file (zsh/mapfile's `get_contents`).
	ReadFile { path: BString },
	/// zsh/mapfile's `setpmmapfile`: open `path` read-write, creating it
	/// with `mode`; a non-empty `data` then replaces the contents (an empty
	/// one leaves an existing file as it was: zsh's zero-length `mmap`
	/// fails).
	MapWrite { path: BString, data: BString, mode: u32 },
	/// A user or group database lookup.
	UserDb(PwQuery),
}

/// The answer to a successful [`FsReq`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FsAns {
	/// The operation was done.
	Done,
	/// `stat`/`lstat`/`fstat` metadata.
	Stat(Stat),
	/// A link target or attribute value.
	Bytes(BString),
	/// Directory entries or attribute names.
	Names(Vec<BString>),
	/// User or group database entries.
	Users(Vec<PwEntry>),
}

/// A failed [`FsReq`]: the C `errno` (0 when the host error has none) and
/// the `strerror` text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsErr {
	pub errno: i32,
	pub text:  BString,
}

/// What a probe of an [`FsReq`] yields.
pub type FsResult = Result<FsAns, FsErr>;

/// An [`FsReq`] in flight ([`Live::Fs`]).
pub struct FsLive {
	/// The pending operation.
	pub fut:        Box<dyn FsPending<FsAns>>,
	/// [`FsReq::idempotent`] of its request.
	pub idempotent: bool,
}

impl FsErr {
	/// The `errno` and text of `err`.
	pub fn of(err: &io::Error) -> Self {
		let text = BString::from(diag::strerror(err).as_bytes());
		Self { errno: errno_of(err, &text), text }
	}

	/// The error as an [`io::Error`] (for `zsh_errmsg`).
	pub fn io(&self) -> io::Error {
		#[cfg(unix)]
		if self.errno != 0 {
			return io::Error::from_raw_os_error(self.errno);
		}
		io::Error::other(self.text.to_string())
	}

	/// Whether this is `errno` `code`.
	pub const fn is(&self, code: i32) -> bool {
		self.errno == code
	}
}

/// The C `errno` of `err` (0: unknown).
fn errno_of(err: &io::Error, text: &[u8]) -> i32 {
	// Off Unix a raw code is a host (Win32) code, not an errno: only the
	// kind says which POSIX errno the error stands for.
	#[cfg(unix)]
	if let Some(code) = err.raw_os_error() {
		return code;
	}
	#[cfg(unix)]
	{
		use io::ErrorKind as K;
		match err.kind() {
			K::NotFound => libc::ENOENT,
			K::PermissionDenied => libc::EACCES,
			K::AlreadyExists => libc::EEXIST,
			K::IsADirectory => libc::EISDIR,
			K::NotADirectory => libc::ENOTDIR,
			K::DirectoryNotEmpty => libc::ENOTEMPTY,
			K::InvalidInput => libc::EINVAL,
			K::Unsupported => libc::ENOTSUP,
			K::CrossesDevices => libc::EXDEV,
			K::ReadOnlyFilesystem => libc::EROFS,
			K::StorageFull => libc::ENOSPC,
			K::WouldBlock => libc::EAGAIN,
			K::Interrupted => libc::EINTR,
			K::TooManyLinks => libc::EMLINK,
			K::OutOfMemory => libc::ENOMEM,
			K::BrokenPipe => libc::EPIPE,
			_ if text == b"Input/output error" => libc::EIO,
			_ if text == b"Too many levels of symbolic links" => libc::ELOOP,
			_ if text == b"Bad file descriptor" => libc::EBADF,
			_ => 0,
		}
	}
	#[cfg(not(unix))]
	{
		use io::ErrorKind as K;
		match err.kind() {
			K::NotFound => posix::ENOENT,
			K::PermissionDenied => posix::EACCES,
			K::AlreadyExists => posix::EEXIST,
			K::IsADirectory => posix::EISDIR,
			K::NotADirectory => posix::ENOTDIR,
			K::DirectoryNotEmpty => posix::ENOTEMPTY,
			K::InvalidInput => posix::EINVAL,
			K::Unsupported => posix::ENOTSUP,
			K::CrossesDevices => posix::EXDEV,
			K::ReadOnlyFilesystem => posix::EROFS,
			K::StorageFull => posix::ENOSPC,
			K::WouldBlock => posix::EAGAIN,
			K::Interrupted => posix::EINTR,
			K::TooManyLinks => posix::EMLINK,
			K::OutOfMemory => posix::ENOMEM,
			K::NotSeekable => posix::ESPIPE,
			K::BrokenPipe => posix::EPIPE,
			_ if text == b"Input/output error" => posix::EIO,
			_ if text == b"Bad file descriptor" => posix::EBADF,
			_ => 0,
		}
	}
}

/// The Linux `errno` numbers (what `$errnos` names off Unix) of the errors
/// the engine reports.
#[cfg(not(unix))]
pub mod posix {
	pub const ENOENT: i32 = 2;
	pub const EINTR: i32 = 4;
	pub const EIO: i32 = 5;
	pub const EBADF: i32 = 9;
	pub const EAGAIN: i32 = 11;
	pub const ENOMEM: i32 = 12;
	pub const EACCES: i32 = 13;
	pub const EEXIST: i32 = 17;
	pub const EXDEV: i32 = 18;
	pub const ENOTDIR: i32 = 20;
	pub const EISDIR: i32 = 21;
	pub const EINVAL: i32 = 22;
	pub const ENOSPC: i32 = 28;
	pub const ESPIPE: i32 = 29;
	pub const EROFS: i32 = 30;
	pub const EMLINK: i32 = 31;
	pub const EPIPE: i32 = 32;
	pub const ENOTEMPTY: i32 = 39;
	pub const ENOTSUP: i32 = 95;

	/// glibc's `strerror` texts by Linux errno number (0 is "Success"):
	/// every number `$errnos` names, as the Linux build prints it.
	const TEXTS: [&str; 134] = [
		"Success",
		"Operation not permitted",
		"No such file or directory",
		"No such process",
		"Interrupted system call",
		"Input/output error",
		"No such device or address",
		"Argument list too long",
		"Exec format error",
		"Bad file descriptor",
		"No child processes",
		"Resource temporarily unavailable",
		"Cannot allocate memory",
		"Permission denied",
		"Bad address",
		"Block device required",
		"Device or resource busy",
		"File exists",
		"Invalid cross-device link",
		"No such device",
		"Not a directory",
		"Is a directory",
		"Invalid argument",
		"Too many open files in system",
		"Too many open files",
		"Inappropriate ioctl for device",
		"Text file busy",
		"File too large",
		"No space left on device",
		"Illegal seek",
		"Read-only file system",
		"Too many links",
		"Broken pipe",
		"Numerical argument out of domain",
		"Numerical result out of range",
		"Resource deadlock avoided",
		"File name too long",
		"No locks available",
		"Function not implemented",
		"Directory not empty",
		"Too many levels of symbolic links",
		"Unknown error 41",
		"No message of desired type",
		"Identifier removed",
		"Channel number out of range",
		"Level 2 not synchronized",
		"Level 3 halted",
		"Level 3 reset",
		"Link number out of range",
		"Protocol driver not attached",
		"No CSI structure available",
		"Level 2 halted",
		"Invalid exchange",
		"Invalid request descriptor",
		"Exchange full",
		"No anode",
		"Invalid request code",
		"Invalid slot",
		"Unknown error 58",
		"Bad font file format",
		"Device not a stream",
		"No data available",
		"Timer expired",
		"Out of streams resources",
		"Machine is not on the network",
		"Package not installed",
		"Object is remote",
		"Link has been severed",
		"Advertise error",
		"Srmount error",
		"Communication error on send",
		"Protocol error",
		"Multihop attempted",
		"RFS specific error",
		"Bad message",
		"Value too large for defined data type",
		"Name not unique on network",
		"File descriptor in bad state",
		"Remote address changed",
		"Can not access a needed shared library",
		"Accessing a corrupted shared library",
		".lib section in a.out corrupted",
		"Attempting to link in too many shared libraries",
		"Cannot exec a shared library directly",
		"Invalid or incomplete multibyte or wide character",
		"Interrupted system call should be restarted",
		"Streams pipe error",
		"Too many users",
		"Socket operation on non-socket",
		"Destination address required",
		"Message too long",
		"Protocol wrong type for socket",
		"Protocol not available",
		"Protocol not supported",
		"Socket type not supported",
		"Operation not supported",
		"Protocol family not supported",
		"Address family not supported by protocol",
		"Address already in use",
		"Cannot assign requested address",
		"Network is down",
		"Network is unreachable",
		"Network dropped connection on reset",
		"Software caused connection abort",
		"Connection reset by peer",
		"No buffer space available",
		"Transport endpoint is already connected",
		"Transport endpoint is not connected",
		"Cannot send after transport endpoint shutdown",
		"Too many references: cannot splice",
		"Connection timed out",
		"Connection refused",
		"Host is down",
		"No route to host",
		"Operation already in progress",
		"Operation now in progress",
		"Stale file handle",
		"Structure needs cleaning",
		"Not a XENIX named type file",
		"No XENIX semaphores available",
		"Is a named type file",
		"Remote I/O error",
		"Disk quota exceeded",
		"No medium found",
		"Wrong medium type",
		"Operation canceled",
		"Required key not available",
		"Key has expired",
		"Key has been revoked",
		"Key was rejected by service",
		"Owner died",
		"State not recoverable",
		"Operation not possible due to RF-kill",
		"Memory page has hardware error",
	];

	/// The `strerror` text of Linux errno `num`, glibc's `Unknown error N`
	/// for a number outside the table.
	pub fn text(num: i32) -> std::borrow::Cow<'static, str> {
		match usize::try_from(num).ok().and_then(|i| TEXTS.get(i)) {
			Some(t) => std::borrow::Cow::Borrowed(t),
			None => std::borrow::Cow::Owned(format!("Unknown error {num}")),
		}
	}
}

impl FsReq {
	/// Whether running it twice is harmless (a suspend may drop it while it
	/// is pending and issue it again after a restore).
	pub const fn idempotent(&self) -> bool {
		matches!(
			self,
			Self::Stat { .. }
				| Self::FdStat { .. }
				| Self::Access { .. }
				| Self::ReadLink { .. }
				| Self::ReadDir { .. }
				| Self::ReadFile { .. }
				| Self::GetXattr { .. }
				| Self::ListXattr { .. }
				| Self::UserDb(_)
				| Self::Sync
				| Self::Chmod { .. }
				| Self::Chown { .. }
		)
	}

	/// The operation named while it is pending.
	const fn op(&self) -> FsOp {
		match self {
			Self::Stat { .. } | Self::FdStat { .. } => FsOp::Stat,
			Self::Access { .. } => FsOp::Access,
			Self::ReadLink { .. } => FsOp::ReadLink,
			Self::ReadDir { .. } => FsOp::ReadDir,
			Self::ReadFile { .. } => FsOp::Open,
			Self::Mkdir { .. } => FsOp::Mkdir,
			Self::Rmdir { .. } => FsOp::Rmdir,
			Self::Unlink { .. } => FsOp::Unlink,
			Self::Rename { .. } => FsOp::Rename,
			Self::Symlink { .. } => FsOp::Symlink,
			Self::Link { .. } => FsOp::Link,
			Self::Chmod { .. } => FsOp::Chmod,
			Self::Chown { .. } => FsOp::Chown,
			Self::Sync => FsOp::Sync,
			Self::GetXattr { .. }
			| Self::SetXattr { .. }
			| Self::RemoveXattr { .. }
			| Self::ListXattr { .. } => FsOp::Xattr,
			Self::MapWrite { .. } => FsOp::Write,
			Self::UserDb(_) => FsOp::UserDb,
		}
	}

	/// The path named while it is pending.
	fn path(&self) -> BString {
		match self {
			Self::Stat { path, .. }
			| Self::Access { path, .. }
			| Self::ReadLink { path }
			| Self::ReadDir { path }
			| Self::ReadFile { path }
			| Self::Mkdir { path, .. }
			| Self::Rmdir { path }
			| Self::Unlink { path }
			| Self::Symlink { path, .. }
			| Self::Chmod { path, .. }
			| Self::Chown { path, .. }
			| Self::GetXattr { path, .. }
			| Self::SetXattr { path, .. }
			| Self::RemoveXattr { path, .. }
			| Self::ListXattr { path, .. }
			| Self::MapWrite { path, .. } => path.clone(),
			Self::Rename { from, .. } | Self::Link { from, .. } => from.clone(),
			Self::FdStat { fd } => BString::from(format!("/dev/fd/{fd}")),
			Self::Sync | Self::UserDb(_) => BString::default(),
		}
	}
}

/// Perform `req` (or continue it); `Err` is the wait key while it is
/// pending. The caller caches the answer.
pub fn perform(
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	req: &FsReq,
) -> Result<FsResult, WaitKey> {
	if let FsReq::FdStat { fd } = req {
		return Ok(fd_stat(vp, *fd));
	}
	let polled = match &mut sc.live {
		Live::Fs(live) => live.fut.poll(tcx),
		_ => match start(cx.host.fs(), req) {
			FsPoll::Ready(r) => Poll::Ready(r),
			FsPoll::Pending(mut fut) => {
				let polled = fut.poll(tcx);
				if polled.is_pending() {
					sc.live = Live::Fs(Box::new(FsLive { fut, idempotent: req.idempotent() }));
				}
				polled
			},
		},
	};
	match polled {
		Poll::Ready(r) => Ok(r.map_err(|e| FsErr::of(&e))),
		Poll::Pending => Err(WaitKey::Fs { op: req.op(), path: req.path() }),
	}
}

/// `fstat` of the engine fd `fd`: the host object's metadata, else (an
/// engine pipe or capture) the synthesized one `[[ -p /dev/fd/N ]]` sees;
/// `EBADF` when it is not open.
fn fd_stat(vp: &Vproc, fd: i32) -> FsResult {
	let ebadf = || FsErr::of(&io::Error::other(crate::bash::fd::BadFd));
	let Some(handle) = vp.fds.get(fd) else {
		return Err(ebadf());
	};
	match handle.stat() {
		Some(Ok(st)) => Ok(FsAns::Stat(st)),
		Some(Err(e)) if e.kind() != io::ErrorKind::Unsupported => Err(FsErr::of(&e)),
		_ => super::probe::fd_stat(vp, fd)
			.map(FsAns::Stat)
			.ok_or_else(ebadf),
	}
}

/// Start `req` on `fs`.
fn start(fs: &mut dyn Fs, req: &FsReq) -> FsPoll<FsAns> {
	let done = |()| FsAns::Done;
	match req {
		FsReq::Stat { path, follow } => map(fs.stat(BStr::new(path), *follow), FsAns::Stat),
		FsReq::FdStat { .. } => FsPoll::Ready(Err(io::ErrorKind::InvalidInput.into())),
		FsReq::Access { path, mode } => {
			use crate::bash::fs::Access;
			let mut want = Access::EXISTS;
			for (bit, a) in [(1, Access::READ), (2, Access::WRITE), (4, Access::EXEC)] {
				if mode & bit != 0 {
					want = want.with(a);
				}
			}
			map(fs.access(BStr::new(path), want), done)
		},
		FsReq::ReadLink { path } => map(fs.readlink(BStr::new(path)), FsAns::Bytes),
		FsReq::ReadDir { path } => {
			FsPoll::Pending(Box::new(ListDir::Opening(Some(fs.read_dir(BStr::new(path))))))
		},
		FsReq::ReadFile { path } => {
			let open = fs.open(BStr::new(path), OpenFlags::READ, 0);
			FsPoll::Pending(Box::new(ReadAll { open: Some(open), file: None, data: Vec::new() }))
		},
		FsReq::Mkdir { path, mode } => map(fs.mkdir(BStr::new(path), *mode), done),
		FsReq::Rmdir { path } => map(fs.rmdir(BStr::new(path)), done),
		FsReq::Unlink { path } => map(fs.unlink(BStr::new(path)), done),
		FsReq::Rename { from, to } => map(fs.rename(BStr::new(from), BStr::new(to)), done),
		FsReq::Symlink { target, path } => map(fs.symlink(BStr::new(target), BStr::new(path)), done),
		FsReq::Link { from, to } => map(fs.link(BStr::new(from), BStr::new(to)), done),
		FsReq::Chmod { path, mode } => map(fs.chmod(BStr::new(path), *mode), done),
		FsReq::Chown { path, uid, gid, follow } => {
			map(fs.chown(BStr::new(path), *uid, *gid, *follow), done)
		},
		FsReq::Sync => map(fs.sync(), done),
		FsReq::GetXattr { path, name, follow } => {
			map(fs.getxattr(BStr::new(path), BStr::new(name), *follow), FsAns::Bytes)
		},
		FsReq::SetXattr { path, name, value, follow } => {
			map(fs.setxattr(BStr::new(path), BStr::new(name), value, *follow), done)
		},
		FsReq::RemoveXattr { path, name, follow } => {
			map(fs.removexattr(BStr::new(path), BStr::new(name), *follow), done)
		},
		FsReq::ListXattr { path, follow } => {
			map(fs.listxattr(BStr::new(path), *follow), FsAns::Names)
		},
		FsReq::MapWrite { path, data, mode } => {
			let mut flags = OpenFlags::READ
				.with(OpenFlags::WRITE)
				.with(OpenFlags::CREATE);
			if !data.is_empty() {
				flags = flags.with(OpenFlags::TRUNC);
			}
			let open = fs.open(BStr::new(path), flags, *mode);
			FsPoll::Pending(Box::new(WriteAll {
				open: Some(open),
				file: None,
				data: data.clone(),
				done: 0,
			}))
		},
		FsReq::UserDb(q) => map(fs.user_db(q), FsAns::Users),
	}
}

/// `poll` with its answer converted by `f`.
fn map<T: Send + 'static>(poll: FsPoll<T>, f: fn(T) -> FsAns) -> FsPoll<FsAns> {
	match poll {
		FsPoll::Ready(r) => FsPoll::Ready(r.map(f)),
		FsPoll::Pending(inner) => FsPoll::Pending(Box::new(Mapped { inner, f })),
	}
}

/// A pending operation whose answer is converted.
struct Mapped<T> {
	inner: Box<dyn FsPending<T>>,
	f:     fn(T) -> FsAns,
}

impl<T> FsPending<FsAns> for Mapped<T> {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<FsAns>> {
		self.inner.poll(cx).map(|r| r.map(self.f))
	}

	fn reissuable(&self) -> bool {
		self.inner.reissuable()
	}
}

/// A directory listing in progress.
enum ListDir {
	/// `read_dir` asked (taken once answered).
	Opening(Option<FsPoll<Box<dyn DirIter>>>),
	/// Pending `read_dir`.
	Waiting(Box<dyn FsPending<Box<dyn DirIter>>>),
	/// Reading entries.
	Reading(Box<dyn DirIter>, Vec<BString>),
}

impl FsPending<FsAns> for ListDir {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<FsAns>> {
		loop {
			match self {
				Self::Opening(open) => match open.take() {
					Some(FsPoll::Ready(Ok(dir))) => *self = Self::Reading(dir, Vec::new()),
					Some(FsPoll::Ready(Err(e))) => return Poll::Ready(Err(e)),
					Some(FsPoll::Pending(p)) => *self = Self::Waiting(p),
					None => return Poll::Ready(Err(io::ErrorKind::Other.into())),
				},
				Self::Waiting(p) => match p.poll(cx) {
					Poll::Ready(Ok(dir)) => *self = Self::Reading(dir, Vec::new()),
					Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
					Poll::Pending => return Poll::Pending,
				},
				Self::Reading(dir, names) => match dir.poll_next(cx) {
					Poll::Ready(Some(Ok(entry))) => {
						if entry.name != "." && entry.name != ".." {
							names.push(entry.name);
						}
					},
					Poll::Ready(Some(Err(e))) => return Poll::Ready(Err(e)),
					Poll::Ready(None) => return Poll::Ready(Ok(FsAns::Names(std::mem::take(names)))),
					Poll::Pending => return Poll::Pending,
				},
			}
		}
	}
}

/// A whole-file read in progress.
struct ReadAll {
	/// The `open` (taken once answered).
	open: Option<FsPoll<Box<dyn File>>>,
	file: Option<Box<dyn File>>,
	data: Vec<u8>,
}

impl FsPending<FsAns> for ReadAll {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<FsAns>> {
		loop {
			if let Some(file) = &mut self.file {
				let mut buf = [0u8; 8192];
				match file.poll_read(cx, &mut buf) {
					Poll::Ready(Ok(0)) => {
						return Poll::Ready(Ok(FsAns::Bytes(BString::from(std::mem::take(
							&mut self.data,
						)))));
					},
					Poll::Ready(Ok(n)) => self.data.extend_from_slice(&buf[..n]),
					Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
					Poll::Pending => return Poll::Pending,
				}
				continue;
			}
			match self.open.take() {
				Some(FsPoll::Ready(Ok(file))) => self.file = Some(file),
				Some(FsPoll::Ready(Err(e))) => return Poll::Ready(Err(e)),
				Some(FsPoll::Pending(mut p)) => match p.poll(cx) {
					Poll::Ready(Ok(file)) => self.file = Some(file),
					Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
					Poll::Pending => {
						self.open = Some(FsPoll::Pending(p));
						return Poll::Pending;
					},
				},
				None => return Poll::Ready(Err(io::ErrorKind::Other.into())),
			}
		}
	}
}

/// zsh/mapfile's write in progress.
struct WriteAll {
	/// The `open` (taken once answered).
	open: Option<FsPoll<Box<dyn File>>>,
	file: Option<Box<dyn File>>,
	data: BString,
	/// Bytes written so far.
	done: usize,
}

impl FsPending<FsAns> for WriteAll {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<FsAns>> {
		loop {
			if let Some(file) = &mut self.file {
				if self.done < self.data.len() {
					match file.poll_write(cx, &self.data[self.done..]) {
						Poll::Ready(Ok(0)) => return Poll::Ready(Err(io::ErrorKind::WriteZero.into())),
						Poll::Ready(Ok(n)) => self.done += n,
						Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
						Poll::Pending => return Poll::Pending,
					}
					continue;
				}
				return file.poll_flush(cx).map(|r| r.map(|()| FsAns::Done));
			}
			match self.open.take() {
				Some(FsPoll::Ready(Ok(file))) => self.file = Some(file),
				Some(FsPoll::Ready(Err(e))) => return Poll::Ready(Err(e)),
				Some(FsPoll::Pending(mut p)) => match p.poll(cx) {
					Poll::Ready(Ok(file)) => self.file = Some(file),
					Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
					Poll::Pending => {
						self.open = Some(FsPoll::Pending(p));
						return Poll::Pending;
					},
				},
				None => return Poll::Ready(Err(io::ErrorKind::Other.into())),
			}
		}
	}

	fn reissuable(&self) -> bool {
		false
	}
}
