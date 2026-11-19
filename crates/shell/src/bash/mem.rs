//! In-memory fd objects: pipes between virtual processes, here-document
//! buffers and command-substitution captures.
//!
//! All are [`File`]s, so externals reach them through the host's pumps and
//! callouts through [`FdRef`](crate::bash::FdRef). None of them ever blocks: a
//! full pipe or an empty one returns `Pending` and wakes the waiters registered
//! by the other end.
//!
//! An fd holds one as a [`MemFile`], which keeps its type: externalize
//! images the shared state once per object ([`MemImage`], contents inline:
//! a pipe holds at most [`PIPE_CAPACITY`] bytes) and restore rebuilds it
//! ([`MemObj`]) and hands out the ends the restored fds held.

use std::{
	collections::VecDeque,
	io,
	sync::Arc,
	task::{Context, Poll, Waker},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::bash::{
	fs::{File, FileKind, SeekFrom},
	host::{OsHandle, PipeMirror},
};

/// Capacity of a [`pipe`] in bytes (bash and Linux use 64 KiB).
pub const PIPE_CAPACITY: usize = 64 << 10;

/// The shared state of a [`pipe`].
#[derive(Default)]
pub struct PipeState {
	buf:     VecDeque<u8>,
	readers: usize,
	writers: usize,
	/// Tasks waiting for data (readers) or room (writers).
	waiters: Vec<Waker>,
	/// Gets a copy of every byte written ([`tapped_pipe`]); closed and
	/// dropped once the last writer or the last reader is gone. Not imaged:
	/// a restored pipe is untapped.
	mirror:  Option<Arc<dyn PipeMirror>>,
}

impl PipeState {
	/// The pipe stopped carrying bytes: no writer can add any, or no reader
	/// takes them.
	fn close_mirror(&mut self) {
		if let Some(mirror) = self.mirror.take() {
			mirror.close();
		}
	}

	fn wait(&mut self, w: &Waker) {
		if !self.waiters.iter().any(|x| x.will_wake(w)) {
			self.waiters.push(w.clone());
		}
	}

	fn wake_all(&mut self) {
		for w in self.waiters.drain(..) {
			w.wake();
		}
	}
}

/// Read end of a [`pipe`].
pub struct PipeReader(Arc<Mutex<PipeState>>);

/// Write end of a [`pipe`].
pub struct PipeWriter(Arc<Mutex<PipeState>>);

/// A new in-memory pipe of [`PIPE_CAPACITY`] bytes.
///
/// Reads return EOF once every writer is gone; writes fail with
/// `BrokenPipe` once every reader is gone (the engine turns that into a
/// virtual `SIGPIPE`, status 141).
pub fn pipe() -> (PipeReader, PipeWriter) {
	let state = Arc::new(Mutex::new(PipeState { readers: 1, writers: 1, ..PipeState::default() }));
	(PipeReader(Arc::clone(&state)), PipeWriter(state))
}

/// A [`pipe`] whose written bytes are also handed to `mirror`
/// ([`Host::pipe_tap`](crate::bash::Host::pipe_tap)), which is closed once the
/// last writer or the last reader is gone.
pub fn tapped_pipe(mirror: Arc<dyn PipeMirror>) -> (PipeReader, PipeWriter) {
	let state = Arc::new(Mutex::new(PipeState {
		readers: 1,
		writers: 1,
		mirror: Some(mirror),
		..PipeState::default()
	}));
	(PipeReader(Arc::clone(&state)), PipeWriter(state))
}

impl PipeReader {
	/// Push `bytes` back ahead of the buffered data (beyond the capacity if
	/// need be) and wake the waiters
	/// ([`FdRef::unread`](crate::bash::FdRef::unread)).
	pub fn unread(&self, bytes: &[u8]) {
		let mut s = self.0.lock();
		for &b in bytes.iter().rev() {
			s.buf.push_front(b);
		}
		s.wake_all();
	}
}

impl Drop for PipeReader {
	fn drop(&mut self) {
		let mut s = self.0.lock();
		s.readers -= 1;
		if s.readers == 0 {
			s.close_mirror();
		}
		s.wake_all();
	}
}

impl Drop for PipeWriter {
	fn drop(&mut self) {
		let mut s = self.0.lock();
		s.writers -= 1;
		if s.writers == 0 {
			s.close_mirror();
		}
		s.wake_all();
	}
}

fn unsupported<T>() -> Poll<io::Result<T>> {
	Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
}

impl File for PipeReader {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		let mut s = self.0.lock();
		if s.buf.is_empty() {
			if s.writers == 0 {
				return Poll::Ready(Ok(0));
			}
			// A zero-length read too waits while a writer may still write:
			// it is how readiness is asked (`read -t 0`, `zselect`), and an
			// empty pipe is not ready.
			s.wait(cx.waker());
			return Poll::Pending;
		}
		let n = buf.len().min(s.buf.len());
		let (front, back) = s.buf.as_slices();
		let split = n.min(front.len());
		buf[..split].copy_from_slice(&front[..split]);
		buf[split..n].copy_from_slice(&back[..n - split]);
		s.buf.drain(..n);
		s.wake_all();
		Poll::Ready(Ok(n))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
		unsupported()
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(espipe())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		self.0.lock().readers += 1;
		Ok(Box::new(Self(Arc::clone(&self.0))))
	}
}

impl File for PipeWriter {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		unsupported()
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		let mut s = self.0.lock();
		if s.readers == 0 {
			return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
		}
		let room = PIPE_CAPACITY.saturating_sub(s.buf.len());
		if room == 0 {
			s.wait(cx.waker());
			return Poll::Pending;
		}
		let n = room.min(buf.len());
		s.buf.extend(&buf[..n]);
		if let Some(mirror) = &s.mirror {
			mirror.write(&buf[..n]);
		}
		s.wake_all();
		Poll::Ready(Ok(n))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(espipe())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		self.0.lock().writers += 1;
		Ok(Box::new(Self(Arc::clone(&self.0))))
	}
}

/// A read-only in-memory document (here-documents, here-strings) with a
/// shared read position, so duplicated fds and `read` see one offset.
pub struct MemBuf {
	data: Arc<[u8]>,
	pos:  Arc<Mutex<usize>>,
}

impl MemBuf {
	/// A document over `data`.
	pub fn new(data: impl Into<Arc<[u8]>>) -> Self {
		Self { data: data.into(), pos: Arc::new(Mutex::new(0)) }
	}
}

impl File for MemBuf {
	fn poll_read(&mut self, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		let mut pos = self.pos.lock();
		let rest = self.data.get(*pos..).unwrap_or_default();
		let n = rest.len().min(buf.len());
		buf[..n].copy_from_slice(&rest[..n]);
		*pos += n;
		Poll::Ready(Ok(n))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Err(io::Error::other(crate::bash::fd::BadFd)))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
		let mut pos = self.pos.lock();
		let len = self.data.len() as i64;
		let next = match to {
			SeekFrom::Start(n) => i64::try_from(n).unwrap_or(i64::MAX),
			SeekFrom::End(d) => len + d,
			SeekFrom::Current(d) => *pos as i64 + d,
		};
		*pos = usize::try_from(next).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
		Ok(*pos as u64)
	}

	fn kind(&self) -> FileKind {
		FileKind::Regular
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self { data: Arc::clone(&self.data), pos: Arc::clone(&self.pos) }))
	}
}

/// A write-only growing buffer: the stdout of a command substitution.
#[derive(Clone, Default)]
pub struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
	/// Take everything written so far.
	pub fn take(&self) -> Vec<u8> {
		std::mem::take(&mut *self.0.lock())
	}

	/// Identity of the shared buffer.
	pub fn key(&self) -> usize {
		Arc::as_ptr(&self.0).addr()
	}

	/// Image of the shared buffer.
	pub fn image(&self) -> MemImage {
		MemImage::Capture { data: self.0.lock().clone() }
	}
}

/// One end of an engine memory object, as an fd holds it.
pub enum MemFile {
	/// Read end of a [`pipe`].
	PipeRead(PipeReader),
	/// Write end of a [`pipe`].
	PipeWrite(PipeWriter),
	/// A here-document.
	Buf(MemBuf),
	/// A command substitution's stdout.
	Capture(Capture),
}

/// Which end of a memory object an fd holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemEnd {
	/// A pipe's read end.
	Read,
	/// A pipe's write end.
	Write,
	/// The object itself (a document or a capture).
	Whole,
}

/// The shared state of a memory object, for the frames image.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemImage {
	/// Unread pipe contents (at most [`PIPE_CAPACITY`] bytes).
	Pipe {
		/// Buffered bytes.
		buf:     Vec<u8>,
		/// A vproc waited on the pipe (for data or room): the restored pipe
		/// wakes the engine on its next change, as the original would have.
		waiting: bool,
	},
	/// A document and its shared read offset.
	Buf {
		/// The document.
		data: Vec<u8>,
		/// Read offset.
		pos:  usize,
	},
	/// Captured output so far.
	Capture {
		/// The bytes.
		data: Vec<u8>,
	},
}

impl MemFile {
	/// Identity of the shared state (equal for every end and duplicate of
	/// one object) and the end this is.
	pub fn key(&self) -> (usize, MemEnd) {
		match self {
			Self::PipeRead(r) => (Arc::as_ptr(&r.0).addr(), MemEnd::Read),
			Self::PipeWrite(w) => (Arc::as_ptr(&w.0).addr(), MemEnd::Write),
			Self::Buf(b) => (Arc::as_ptr(&b.pos).addr(), MemEnd::Whole),
			Self::Capture(c) => (c.key(), MemEnd::Whole),
		}
	}

	/// Image of the shared state.
	pub fn image(&self) -> MemImage {
		match self {
			Self::PipeRead(PipeReader(s)) | Self::PipeWrite(PipeWriter(s)) => {
				let s = s.lock();
				MemImage::Pipe {
					buf:     s.buf.iter().copied().collect(),
					waiting: !s.waiters.is_empty(),
				}
			},
			Self::Buf(b) => MemImage::Buf { data: b.data.to_vec(), pos: *b.pos.lock() },
			Self::Capture(c) => c.image(),
		}
	}

	/// Another handle to the same end (a pipe end counts it).
	pub fn dup_end(&self) -> Self {
		match self {
			Self::PipeRead(r) => {
				r.0.lock().readers += 1;
				Self::PipeRead(PipeReader(Arc::clone(&r.0)))
			},
			Self::PipeWrite(w) => {
				w.0.lock().writers += 1;
				Self::PipeWrite(PipeWriter(Arc::clone(&w.0)))
			},
			Self::Buf(b) => Self::Buf(MemBuf { data: Arc::clone(&b.data), pos: Arc::clone(&b.pos) }),
			Self::Capture(c) => Self::Capture(c.clone()),
		}
	}

	fn file(&mut self) -> &mut dyn File {
		match self {
			Self::PipeRead(r) => r,
			Self::PipeWrite(w) => w,
			Self::Buf(b) => b,
			Self::Capture(c) => c,
		}
	}

	fn file_ref(&self) -> &dyn File {
		match self {
			Self::PipeRead(r) => r,
			Self::PipeWrite(w) => w,
			Self::Buf(b) => b,
			Self::Capture(c) => c,
		}
	}
}

impl File for MemFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		self.file().poll_read(cx, buf)
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.file().poll_write(cx, buf)
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		self.file().poll_flush(cx)
	}

	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		self.file().seek(pos)
	}

	fn kind(&self) -> FileKind {
		self.file_ref().kind()
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.dup_end()))
	}
}

impl From<PipeReader> for MemFile {
	fn from(r: PipeReader) -> Self {
		Self::PipeRead(r)
	}
}

impl From<PipeWriter> for MemFile {
	fn from(w: PipeWriter) -> Self {
		Self::PipeWrite(w)
	}
}

impl From<MemBuf> for MemFile {
	fn from(b: MemBuf) -> Self {
		Self::Buf(b)
	}
}

impl From<Capture> for MemFile {
	fn from(c: Capture) -> Self {
		Self::Capture(c)
	}
}

/// A memory object rebuilt from its [`MemImage`]; hands out the ends the
/// restored fds held (a pipe counts its readers and writers from them).
pub enum MemObj {
	Pipe(Arc<Mutex<PipeState>>),
	Buf(MemBuf),
	Capture(Capture),
}

impl MemObj {
	/// Rebuild from an image; a pipe starts without ends.
	pub fn rebuild(img: MemImage, engine: &Waker) -> Self {
		match img {
			MemImage::Pipe { buf, waiting } => {
				let waiters = if waiting {
					vec![engine.clone()]
				} else {
					Vec::new()
				};
				Self::Pipe(Arc::new(Mutex::new(PipeState {
					buf: buf.into(),
					waiters,
					..PipeState::default()
				})))
			},
			MemImage::Buf { data, pos } => {
				Self::Buf(MemBuf { data: data.into(), pos: Arc::new(Mutex::new(pos)) })
			},
			MemImage::Capture { data } => Self::Capture(Capture(Arc::new(Mutex::new(data)))),
		}
	}

	/// A new handle to `end`; `None` when the object has no such end.
	pub fn end(&self, end: MemEnd) -> Option<MemFile> {
		match (self, end) {
			(Self::Pipe(s), MemEnd::Read) => {
				s.lock().readers += 1;
				Some(MemFile::PipeRead(PipeReader(Arc::clone(s))))
			},
			(Self::Pipe(s), MemEnd::Write) => {
				s.lock().writers += 1;
				Some(MemFile::PipeWrite(PipeWriter(Arc::clone(s))))
			},
			(Self::Buf(b), MemEnd::Whole) => {
				Some(MemFile::Buf(MemBuf { data: Arc::clone(&b.data), pos: Arc::clone(&b.pos) }))
			},
			(Self::Capture(c), MemEnd::Whole) => Some(MemFile::Capture(c.clone())),
			_ => None,
		}
	}

	/// The capture this object is, if it is one.
	pub fn capture(&self) -> Option<Capture> {
		match self {
			Self::Capture(c) => Some(c.clone()),
			Self::Pipe(_) | Self::Buf(_) => None,
		}
	}
}

impl File for Capture {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Err(io::Error::other(crate::bash::fd::BadFd)))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.0.lock().extend_from_slice(buf);
		Poll::Ready(Ok(buf.len()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(espipe())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn cx() -> Context<'static> {
		Context::from_waker(Waker::noop())
	}

	#[test]
	fn pipe_eof_after_last_writer_and_epipe_after_last_reader() {
		let (mut r, mut w) = pipe();
		let w2 = w.dup().unwrap();
		assert!(matches!(w.poll_write(&mut cx(), b"ab"), Poll::Ready(Ok(2))));
		drop(w);
		let mut buf = [0; 4];
		assert!(matches!(r.poll_read(&mut cx(), &mut buf), Poll::Ready(Ok(2))));
		assert!(r.poll_read(&mut cx(), &mut buf).is_pending(), "a duplicated writer keeps it open");
		drop(w2);
		assert!(matches!(r.poll_read(&mut cx(), &mut buf), Poll::Ready(Ok(0))));
		let (r, mut w) = pipe();
		drop(r);
		let Poll::Ready(Err(err)) = w.poll_write(&mut cx(), b"x") else {
			panic!("expected EPIPE");
		};
		assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
	}

	#[test]
	fn full_pipe_pends_and_partially_writes() {
		let (_r, mut w) = pipe();
		let big = vec![7u8; PIPE_CAPACITY + 10];
		assert!(matches!(w.poll_write(&mut cx(), &big), Poll::Ready(Ok(n)) if n == PIPE_CAPACITY));
		assert!(w.poll_write(&mut cx(), b"x").is_pending());
	}

	#[test]
	fn membuf_dups_share_the_offset() {
		let mut a = MemBuf::new(&b"hello"[..]);
		let mut b = a.dup().unwrap();
		let mut buf = [0; 2];
		let _ = a.poll_read(&mut cx(), &mut buf);
		let _ = b.poll_read(&mut cx(), &mut buf);
		assert_eq!(&buf, b"ll");
		assert_eq!(a.seek(SeekFrom::Current(-1)).unwrap(), 3);
	}
}

/// `ESPIPE`: a pipe cannot seek.
fn espipe() -> io::Error {
	#[cfg(unix)]
	return io::Error::from_raw_os_error(29);
	#[cfg(not(unix))]
	return io::Error::from(io::ErrorKind::NotSeekable);
}
