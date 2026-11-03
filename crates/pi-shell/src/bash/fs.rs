//! The pollable filesystem seam.
//!
//! Every filesystem operation returns [`FsPoll`]: `Ready` when the answer
//! needs no wait (in memory, cached, a local-disk syscall), `Pending` with a
//! [`FsPending`] future otherwise. The engine never expects a synchronous
//! answer: on `Pending` it parks the virtual process with
//! [`WaitKey::Fs`](crate::bash::WaitKey::Fs) and keeps running the others.
//!
//! **No method of [`Fs`], [`FsPending`], [`DirIter`] or [`File`] may block the
//! calling thread.** A host whose backing store can stall (network, a VFS
//! future) returns `Pending` and wakes the waker of the `Context` it was polled
//! with — the engine's [`Shell::wake`](crate::bash::Shell::wake) waker.

pub use std::io::SeekFrom;
use std::{
	io,
	task::{Context, Poll},
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use crate::bash::host::OsHandle;

/// Length of the `scheme://` root of `path` when it is a URL path: an RFC
/// 3986 scheme of at least two characters (so `C://x` stays a Windows drive
/// path) followed by `://`.
///
/// The engine treats a URL path as absolute (redirections, `cd`, `source`,
/// command names with a slash), and `..` never climbs above its root (`cd`);
/// a relative name under a URL working directory joins it with `/`. What it
/// names is up to the host's [`Fs`]: a virtual filesystem serves `skill://x`,
/// an OS filesystem refuses it as not found.
pub fn url_root_len(path: &[u8]) -> Option<usize> {
	let colon = path.iter().position(|&b| b == b':')?;
	if colon < 2 || !path[0].is_ascii_alphabetic() {
		return None;
	}
	if !path[1..colon]
		.iter()
		.all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
	{
		return None;
	}
	path[colon..].starts_with(b"://").then_some(colon + 3)
}

/// Result of starting a filesystem operation.
pub enum FsPoll<T> {
	/// The answer is available now.
	Ready(io::Result<T>),
	/// The answer arrives later; poll it with the engine waker. Dropping it
	/// requests cancellation.
	Pending(Box<dyn FsPending<T>>),
}

/// An in-flight filesystem operation.
pub trait FsPending<T>: Send {
	/// Poll for the result; must not block.
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>>;

	/// Whether dropping this operation and issuing it again later is
	/// invisible to everyone else: a suspend drops such operations and a
	/// restore re-issues them; others are left running and a snapshot
	/// reports them lost. A FIFO open is not: it is a rendezvous with the
	/// other end.
	fn reissuable(&self) -> bool {
		true
	}
}

/// Filesystem as the engine sees it.
///
/// Paths are absolute and normalized (the engine applies its per-vproc cwd
/// and resolves `..` logically unless `set -P`). A `scheme://` name (an RFC
/// 3986 scheme of two or more characters) counts as absolute and reaches the
/// filesystem as written, relative names under such a working directory join
/// it with `/` ([`url_root_len`]).
///
/// Device paths (`/dev/null`, `/dev/fd/N`, `/dev/tcp/…`, host devices) are
/// ordinary [`Fs::open`] results with the matching [`FileKind`].
pub trait Fs {
	/// Open a file (redirections, `source`, here-document spill).
	fn open(&mut self, path: &BStr, flags: OpenFlags, mode: u32) -> FsPoll<Box<dyn File>>;
	/// `stat`/`lstat` (`test -f`, PATH search, glob).
	fn stat(&mut self, path: &BStr, follow: bool) -> FsPoll<Stat>;
	/// `access(2)` (`test -r/-w/-x`, PATH search).
	fn access(&mut self, path: &BStr, mode: Access) -> FsPoll<()>;
	/// Open a directory for listing (glob, `cd -P`, completion of PATH hash).
	fn read_dir(&mut self, path: &BStr) -> FsPoll<Box<dyn DirIter>>;
	/// Read a symlink's target.
	fn readlink(&mut self, path: &BStr) -> FsPoll<BString>;
	/// Canonical physical path (`pwd -P`, `cd -P`).
	fn realpath(&mut self, path: &BStr) -> FsPoll<BString>;
	/// Create a FIFO or temp file (`<( )` on Windows, here-document spill).
	fn mkfifo_or_temp(&mut self, purpose: TempPurpose) -> FsPoll<TempNode>;
	/// Validate a `cd` target; the engine itself owns the cwd.
	fn chdir_check(&mut self, path: &BStr) -> FsPoll<()>;
}

/// Directory listing iterator.
pub trait DirIter: Send {
	/// Next entry, `None` at the end; must not block.
	fn poll_next(&mut self, cx: &mut Context<'_>) -> Poll<Option<io::Result<DirEntry>>>;
}

/// An open file, pipe, terminal or device.
///
/// Reads and writes are partial and pollable; the engine keeps the progress
/// of a partially written buffer in its frames, so a write interrupted by a
/// snapshot resumes after restore.
///
/// Direction contract: a zero-length read or write in a direction the object
/// cannot do fails with `Unsupported` (like `EBADF` on an fd opened the other
/// way); in a direction it can do, it moves nothing and returns `Ok(0)` or
/// `Pending`. Hosts probe this to give an external a one-way OS pipe for an
/// engine-only fd (`/dev/fd/63` of `cat <(…)` must be openable by path).
pub trait File: Send {
	/// Read into `buf`; `Ok(0)` is end of file. Must not block.
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>>;
	/// Write a prefix of `buf`. Must not block.
	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>>;
	/// Flush buffered writes (called before the engine closes the fd).
	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>>;
	/// Reposition (`<>` redirections, `read -N` on regular files).
	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64>;
	/// What kind of object this is.
	fn kind(&self) -> FileKind;
	/// OS handle to give an external directly; `None` makes the host pump.
	fn os_handle(&self) -> Option<OsHandle>;
	/// Duplicate (`n>&m` into an external, `exec 3>&1`).
	fn dup(&self) -> io::Result<Box<dyn File>>;
}

/// Kind of an open [`File`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::VariantNames)]
#[strum(serialize_all = "lowercase")]
pub enum FileKind {
	/// Regular file.
	Regular,
	/// Pipe or FIFO.
	Pipe,
	/// Terminal.
	Tty,
	/// Device (`/dev/null`, a host device).
	Device,
	/// Socket (`/dev/tcp`).
	Socket,
}

crate::bash::packed_names::packed_names!(FileKind);

/// Open flags of [`Fs::open`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OpenFlags(u16);

impl OpenFlags {
	/// Append on every write.
	pub const APPEND: Self = Self(1 << 4);
	/// Create if missing.
	pub const CREATE: Self = Self(1 << 2);
	/// Fail if it exists (`set -o noclobber`).
	pub const EXCL: Self = Self(1 << 5);
	/// Open for reading.
	pub const READ: Self = Self(1);
	/// Truncate to zero length.
	pub const TRUNC: Self = Self(1 << 3);
	/// Open for writing.
	pub const WRITE: Self = Self(1 << 1);

	/// Union of two flag sets.
	pub const fn with(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}

	/// Whether every flag of `other` is set.
	pub const fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}

	/// Whether the open changes the filesystem (create, truncate, append,
	/// exclusive). Such opens are never dropped by a suspend.
	pub const fn is_mutating(self) -> bool {
		self.0 & (Self::CREATE.0 | Self::TRUNC.0 | Self::APPEND.0 | Self::EXCL.0) != 0
	}
}

/// `access(2)` mode of [`Fs::access`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Access(u8);

impl Access {
	/// Executable / searchable.
	pub const EXEC: Self = Self(1 << 2);
	/// Existence only.
	pub const EXISTS: Self = Self(0);
	/// Readable.
	pub const READ: Self = Self(1);
	/// Writable.
	pub const WRITE: Self = Self(1 << 1);

	/// Union of two modes.
	pub const fn with(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}

	/// Whether every bit of `other` is requested.
	pub const fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}
}

/// File type in [`Stat`] and [`DirEntry`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::VariantNames)]
#[strum(serialize_all = "lowercase")]
pub enum StatKind {
	/// Regular file.
	File,
	/// Directory.
	Dir,
	/// Symbolic link (only with `follow = false`).
	Symlink,
	/// FIFO.
	Fifo,
	/// Socket.
	Socket,
	/// Character device.
	CharDev,
	/// Block device.
	BlockDev,
}

crate::bash::packed_names::packed_names!(StatKind);

/// File metadata (`test` operators, PATH search, glob).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Stat {
	/// File type.
	pub kind:     StatKind,
	/// Permission and mode bits (`0o7777` incl. setuid/setgid/sticky).
	pub mode:     u32,
	/// Size in bytes.
	pub size:     u64,
	/// Owner uid.
	pub uid:      u32,
	/// Owner gid.
	pub gid:      u32,
	/// Device id (`-ef`).
	pub dev:      u64,
	/// Inode (`-ef`).
	pub ino:      u64,
	/// Link count.
	pub nlink:    u64,
	/// Modification time, ns since the Unix epoch (`-nt`, `-ot`).
	pub mtime_ns: i64,
	/// Access time, ns since the Unix epoch (`-N`).
	pub atime_ns: i64,
	/// Status-change time, ns since the Unix epoch (`GLOBSORT=ctime`). On
	/// Windows the creation time.
	pub ctime_ns: i64,
	/// Allocated 512-byte blocks, as `st_blocks` (`GLOBSORT=blocks`). On
	/// Windows `ceil(size / 512)`.
	pub blocks:   u64,
}

/// One directory entry.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DirEntry {
	/// Entry name (no slash).
	pub name: BString,
	/// File type when the listing provides it cheaply.
	pub kind: Option<StatKind>,
}

/// Why the engine needs a FIFO or temp file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TempPurpose {
	/// Process substitution; `output` for `>( )`.
	ProcSub {
		/// `>( )` rather than `<( )`.
		output: bool,
	},
	/// Here-document too large for a pipe.
	HereDoc,
}

/// A created FIFO or temp file.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TempNode {
	/// Absolute path to hand to the consumer.
	pub path: BString,
	/// A FIFO rather than a regular temp file.
	pub fifo: bool,
}

/// Filesystem operation named in [`WaitKey::Fs`](crate::bash::WaitKey::Fs) and
/// in `Blocked` events.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::VariantNames)]
#[strum(serialize_all = "snake_case")]
pub enum FsOp {
	/// [`Fs::open`]
	Open,
	/// [`Fs::stat`]
	Stat,
	/// [`Fs::access`]
	Access,
	/// [`Fs::read_dir`]
	ReadDir,
	/// [`DirIter::poll_next`]
	DirNext,
	/// [`Fs::readlink`]
	ReadLink,
	/// [`Fs::realpath`]
	RealPath,
	/// [`Fs::mkfifo_or_temp`]
	MkTemp,
	/// [`Fs::chdir_check`]
	ChdirCheck,
}

crate::bash::packed_names::packed_names!(FsOp);
