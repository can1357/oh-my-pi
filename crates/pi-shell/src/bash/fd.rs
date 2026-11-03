//! Engine file descriptors: refcounted fd objects shared by `dup`, subshell
//! fd tables and host callouts.

use std::{
	fmt, io,
	sync::Arc,
	task::{Context, Poll},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::bash::{
	fs::{File, FileKind},
	host::{OsHandle, StdFd},
	mem::MemFile,
};

/// Shared handle to one engine fd object.
///
/// Handed to hosts in [`ToolCall::stdio`](crate::bash::ToolCall::stdio) and
/// [`Invocation::stdio`](crate::bash::Invocation::stdio) so a callout or native
/// task reads and writes the same object the shell does (a pipe, a redirected
/// file, the shell's own stdout). Every operation is non-blocking; poll with
/// the waker of the task doing the I/O. `Send + Sync`.
#[derive(Clone)]
pub struct FdRef(Arc<FdObj>);

pub struct FdObj {
	state:  Mutex<FdState>,
	origin: FdOrigin,
}

enum FdState {
	Open(Box<dyn File>),
	/// An engine memory object (pipe end, document, capture): it keeps its
	/// type so externalize can image it and restore rebuild it.
	Mem(MemFile),
	/// The object could not survive a restore: reads hit EOF, writes `EBADF`.
	Lost,
	Closed,
}

/// Where an fd object came from; decides how it is rebuilt by `restore`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FdOrigin {
	/// The shell's own standard stream, re-acquired with
	/// [`Host::stdio`](crate::bash::Host::stdio).
	Std(StdFd),
	/// A host-supplied file (per-run stdio, a redirection target); lost on
	/// restore.
	Host,
	/// An in-memory object (pipe, here-document, capture); imaged by
	/// externalize and rebuilt by restore.
	Mem,
	/// No object.
	Closed,
}

/// Error of I/O on a closed or lost fd (`EBADF`).
#[derive(Debug, thiserror::Error)]
#[error("Bad file descriptor")]
pub struct BadFd;

fn bad_fd() -> io::Error {
	io::Error::other(BadFd)
}

impl FdState {
	fn file(&mut self) -> Option<&mut dyn File> {
		match self {
			Self::Open(f) => Some(f.as_mut()),
			Self::Mem(m) => Some(m as &mut dyn File),
			Self::Lost | Self::Closed => None,
		}
	}

	fn file_ref(&self) -> Option<&dyn File> {
		match self {
			Self::Open(f) => Some(f.as_ref()),
			Self::Mem(m) => Some(m as &dyn File),
			Self::Lost | Self::Closed => None,
		}
	}
}

impl FdRef {
	pub(crate) fn open(file: Box<dyn File>, origin: FdOrigin) -> Self {
		Self(Arc::new(FdObj { state: Mutex::new(FdState::Open(file)), origin }))
	}

	/// An fd for an engine memory object.
	pub(crate) fn mem(file: impl Into<MemFile>) -> Self {
		Self(Arc::new(FdObj { state: Mutex::new(FdState::Mem(file.into())), origin: FdOrigin::Mem }))
	}

	/// Identity of the fd object (shared by every slot holding this handle).
	pub(crate) fn key(&self) -> usize {
		Arc::as_ptr(&self.0).addr()
	}

	/// `f` applied to the memory object this fd holds, if it holds one.
	pub(crate) fn with_mem<R>(&self, f: impl FnOnce(&MemFile) -> R) -> Option<R> {
		match &*self.0.state.lock() {
			FdState::Mem(m) => Some(f(m)),
			FdState::Open(_) | FdState::Lost | FdState::Closed => None,
		}
	}

	/// A handle on a host file outside any shell, for tests that hand engine
	/// objects to a host directly (the sys spawner's pump tests).
	pub fn from_file(file: Box<dyn File>) -> Self {
		Self::open(file, FdOrigin::Host)
	}

	pub(crate) fn closed() -> Self {
		Self(Arc::new(FdObj { state: Mutex::new(FdState::Closed), origin: FdOrigin::Closed }))
	}

	pub(crate) fn lost(origin: FdOrigin) -> Self {
		Self(Arc::new(FdObj { state: Mutex::new(FdState::Lost), origin }))
	}

	pub(crate) fn origin(&self) -> FdOrigin {
		self.0.origin
	}

	/// Reposition (`read` gives back what it over-read on seekable files).
	pub fn seek(&self, pos: crate::bash::fs::SeekFrom) -> io::Result<u64> {
		match self.0.state.lock().file() {
			Some(f) => f.seek(pos),
			None => Err(bad_fd()),
		}
	}

	/// Put `bytes` back in front of this object's unread data: a host read
	/// them out for an external that exited without consuming them
	/// (`crate::sys`'s shared input feeds), so the next reader (another
	/// external, a builtin) sees them as with one kernel pipe. A memory
	/// pipe's read end pushes them ahead of what it buffers (beyond its
	/// capacity if need be) and wakes its waiters; another seekable object
	/// seeks back by their length.
	///
	/// # Errors
	///
	/// `Unsupported` (or the object's seek error) for any other object, and
	/// `EBADF` for a closed or lost one: the bytes are lost.
	pub fn unread(&self, bytes: &[u8]) -> io::Result<()> {
		if bytes.is_empty() {
			return Ok(());
		}
		let mut state = self.0.state.lock();
		if let FdState::Mem(MemFile::PipeRead(r)) = &*state {
			r.unread(bytes);
			return Ok(());
		}
		let back =
			i64::try_from(bytes.len()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
		match state.file() {
			Some(f) => f.seek(crate::bash::fs::SeekFrom::Current(-back)).map(drop),
			None => Err(bad_fd()),
		}
	}

	/// A new handle to a duplicate of the underlying object (a pipe end
	/// keeps the pipe open while any duplicate lives).
	pub fn dup(&self) -> io::Result<Self> {
		match &*self.0.state.lock() {
			FdState::Open(f) => Ok(Self::open(f.dup()?, self.0.origin)),
			FdState::Mem(m) => Ok(Self::mem(m.dup_end())),
			FdState::Lost | FdState::Closed => Err(bad_fd()),
		}
	}

	/// Whether two handles refer to the same fd object.
	pub fn same(&self, other: &Self) -> bool {
		Arc::ptr_eq(&self.0, &other.0)
	}

	/// Read into `buf`; `Ok(0)` at end of file (also for closed or lost fds).
	pub fn poll_read(&self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_read(cx, buf),
			None => Poll::Ready(Ok(0)),
		}
	}

	/// Write a prefix of `buf`; closed and lost fds fail with "Bad file
	/// descriptor".
	pub fn poll_write(&self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_write(cx, buf),
			None => Poll::Ready(Err(bad_fd())),
		}
	}

	/// Flush buffered writes.
	pub fn poll_flush(&self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		match self.0.state.lock().file() {
			Some(f) => f.poll_flush(cx),
			None => Poll::Ready(Ok(())),
		}
	}

	/// Kind of the underlying object; `None` when closed or lost.
	pub fn kind(&self) -> Option<FileKind> {
		self.0.state.lock().file_ref().map(File::kind)
	}

	/// OS handle an external can inherit directly.
	pub fn os_handle(&self) -> Option<OsHandle> {
		self.0.state.lock().file_ref().and_then(File::os_handle)
	}

	/// Whether the object is a command substitution's capture, whose bytes
	/// the engine takes as shell text.
	pub fn is_capture(&self) -> bool {
		matches!(&*self.0.state.lock(), FdState::Mem(MemFile::Capture(_)))
	}

	/// Whether the object is usable (not closed, not lost).
	pub fn is_open(&self) -> bool {
		matches!(&*self.0.state.lock(), FdState::Open(_) | FdState::Mem(_))
	}
}

impl fmt::Debug for FdRef {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("FdRef")
			.field("origin", &self.0.origin)
			.field("open", &self.is_open())
			.finish()
	}
}

/// Per-vproc fd table.
#[derive(Clone, Debug, Default)]
pub struct FdTable {
	slots: Vec<Option<FdRef>>,
}

impl FdTable {
	pub(crate) fn get(&self, fd: i32) -> Option<&FdRef> {
		usize::try_from(fd)
			.ok()
			.and_then(|i| self.slots.get(i))
			.and_then(Option::as_ref)
	}

	/// The handle for `fd`, or a closed handle.
	pub(crate) fn handle(&self, fd: i32) -> FdRef {
		self.get(fd).cloned().unwrap_or_else(FdRef::closed)
	}

	pub(crate) fn set(&mut self, fd: i32, r: Option<FdRef>) {
		let Ok(i) = usize::try_from(fd) else {
			return;
		};
		if self.slots.len() <= i {
			self.slots.resize(i + 1, None);
		}
		self.slots[i] = r;
	}

	/// Every slot, for the frames blob.
	pub(crate) fn slots(&self) -> &[Option<FdRef>] {
		&self.slots
	}

	/// The lowest closed fd ≥ `from` (`{var}>` allocates from 10).
	pub(crate) fn lowest_free(&self, from: i32) -> i32 {
		(from..i32::MAX)
			.find(|&fd| self.get(fd).is_none())
			.unwrap_or(from)
	}

	pub(crate) fn iter(&self) -> impl Iterator<Item = (i32, &FdRef)> {
		self
			.slots
			.iter()
			.enumerate()
			.filter_map(|(i, s)| s.as_ref().map(|r| (i as i32, r)))
	}
}
