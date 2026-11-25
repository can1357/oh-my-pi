use std::{
	borrow::Cow,
	cell::RefCell,
	io::{self, IsTerminal, Read, Seek, SeekFrom, Write},
	rc::Rc,
	sync::{Arc, atomic::{AtomicBool, Ordering}},
};

use omp_vfs::{File, Metadata};

use crate::{host::{Stdin, StreamWriter}, openfile::{Fd, OpenFile}};

use super::{PStr, PipeChild, Sv, Value, bad_fd};

/// Open resource, not including the handle's own read or write buffers.
pub(super) enum Device {
	File(File),
	Stdin(Stdin),
	Stdout { writer: StreamWriter, file: OpenFile },
	Descriptor { file: OpenFile, read_cancel: Option<Arc<AtomicBool>>, poll: bool, command: Option<PipeChild> },
	Scalar(ScalarFile),
	InPlace(Rc<RefCell<Vec<u8>>>),
}

impl Device {
	/// Wrap a shell fd or pipe end and classify whether reads might block.
	pub(super) fn descriptor(file: OpenFile, read_cancel: Option<Arc<AtomicBool>>, command: Option<PipeChild>) -> Self {
		#[cfg(unix)]
		let poll = read_cancel.is_some() && file.try_borrow_as_fd().is_ok_and(omp_vfs::fd_reads_can_block);
		#[cfg(windows)]
		let poll = read_cancel.is_some() && matches!(&file, OpenFile::File(file) if crate::openfile::is_pipe(file));
		#[cfg(not(any(unix, windows)))]
		let poll = false;
		Self::Descriptor { file, read_cancel, poll, command }
	}

	/// Block until a read would not block, failing with the alarm error once
	/// `deadline` passes. Devices whose reads never block return at once.
	pub(super) fn wait_input(&self, deadline: &super::ReadDeadline) -> io::Result<()> {
		#[cfg(unix)]
		{
			let blocking = match self {
				Self::Descriptor { poll, .. } => *poll,
				Self::Stdin(_) => true,
				_ => false,
			};
			if !blocking {
				return Ok(());
			}
			let cancelled = || deadline.cancel.load(Ordering::Relaxed);
			let due = || std::time::Instant::now() >= deadline.at;
			let waited = self.with_fd(|fd| {
				if !omp_vfs::fd_reads_can_block(fd) {
					return Ok(());
				}
				omp_vfs::wait_readable(fd, || cancelled() || due())
			});
			match waited {
				Err(_) if cancelled() => Err(omp_vfs::cancelled()),
				Err(_) if due() => Err(super::alarm_error()),
				// No pollable descriptor or a failed poll: the read reports the real result.
				_ => Ok(()),
			}
		}
		#[cfg(not(unix))]
		{
			let _ = deadline;
			Ok(())
		}
	}

	/// Read directly from a descriptor, bypassing PerlIO buffering.
	pub(super) fn sysread(&mut self, out: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::Scalar(_) | Self::InPlace(_) => Err(bad_fd()),
			_ if out.is_empty() => Ok(0),
			_ => self.read(out),
		}
	}

	/// Write directly to a descriptor, bypassing PerlIO buffering.
	pub(super) fn syswrite(&mut self, bytes: &[u8]) -> io::Result<usize> {
		match self {
			Self::Scalar(_) | Self::InPlace(_) => Err(bad_fd()),
			Self::Stdout { file, .. } => file.write(bytes),
			// A blocking descriptor write completes in full (perl's syswrite on a blocking pipe);
			// cancellable writes come back in pipe-sized pieces, so keep going.
			Self::Descriptor { .. } => {
				let mut done = 0;
				while done < bytes.len() {
					match self.write(&bytes[done..]) {
						Ok(0) => break,
						Ok(n) => done += n,
						Err(e) if done == 0 => return Err(e),
						Err(_) => break,
					}
				}
				Ok(done)
			},
			_ => self.write(bytes),
		}
	}

	#[cfg(unix)]
	pub(super) fn with_fd<T>(&self, f: impl FnOnce(std::os::fd::BorrowedFd<'_>) -> io::Result<T>) -> io::Result<T> {
		use std::os::fd::AsFd as _;
		match self {
			Self::File(file) => f(file.native().ok_or_else(bad_fd)?.as_fd()),
			Self::Stdin(stdin) => f(stdin.file().try_borrow_as_fd()?),
			Self::Stdout { file, .. } | Self::Descriptor { file, .. } => f(file.try_borrow_as_fd()?),
			Self::Scalar(_) | Self::InPlace(_) => Err(bad_fd()),
		}
	}

	/// Duplicate a descriptor for inheritance by a Host command.
	pub(super) fn child_fd(&self) -> io::Result<Fd> {
		match self {
			Self::File(file) => file.try_clone().map(Fd::from),
			Self::Stdin(stdin) => stdin.file().to_fd(),
			Self::Stdout { file, .. } | Self::Descriptor { file, .. } => file.to_fd(),
			Self::Scalar(_) | Self::InPlace(_) => Err(io::ErrorKind::Unsupported.into()),
		}
	}

	pub(super) fn child(&self) -> Option<&PipeChild> {
		match self { Self::Descriptor { command, .. } => command.as_ref(), _ => None }
	}

	/// Copies the underlying file description, including its current offset,
	/// but not this handle's buffering. In-memory FILEs have no descriptor.
	pub(super) fn duplicate(&self, cancel: Arc<AtomicBool>) -> io::Result<Self> {
		let duplicate = |file: &OpenFile| {
			let file = if matches!(file, OpenFile::Stream(_)) {
				// A host-injected stream has no OS descriptor, but all its
				// clones reach the same sink, like ordinary dup'd handles.
				file.clone()
			} else {
				OpenFile::from_fd(file.to_fd()?).ok_or_else(bad_fd)?
			};
			Ok(Self::descriptor(file, Some(cancel), None))
		};
		match self {
			Self::File(file) => Ok(Self::File(file.try_clone()?)),
			Self::Stdin(stdin) => duplicate(stdin.file()),
			Self::Stdout { file, .. } | Self::Descriptor { file, .. } => duplicate(file),
			Self::Scalar(_) | Self::InPlace(_) => Err(bad_fd()),
		}
	}

	/// Perform `fstat` on the open device rather than re-resolving a path.
	pub(super) fn metadata(&self) -> io::Result<Metadata> {
		match self {
			Self::File(file) => file.metadata(),
			Self::Stdin(stdin) => metadata(stdin.file()),
			Self::Stdout { file, .. } | Self::Descriptor { file, .. } => metadata(file),
			Self::Scalar(_) | Self::InPlace(_) => Err(bad_fd()),
		}
	}

	/// Native descriptor number if the provider exposes one.
	pub(super) fn fileno(&self) -> Option<i32> {
		#[cfg(unix)]
		{
			use std::os::fd::AsRawFd;
			match self {
				Self::File(file) => file.native().map(AsRawFd::as_raw_fd),
				Self::Stdin(stdin) => stdin.file().raw_fd(),
				Self::Stdout { file, .. } | Self::Descriptor { file, .. } => file.raw_fd(),
				Self::Scalar(_) | Self::InPlace(_) => None,
			}
		}
		#[cfg(not(unix))]
		{
			None
		}
	}

	/// Physical terminal status for `-t`.
	pub(super) fn terminal(&self) -> bool {
		match self {
			Self::File(file) => file.native().is_some_and(IsTerminal::is_terminal),
			Self::Stdin(stdin) => stdin.file().is_terminal(),
			Self::Stdout { writer, .. } => writer.is_terminal(),
			Self::Descriptor { file, .. } => file.is_terminal(),
			Self::Scalar(_) | Self::InPlace(_) => false,
		}
	}

	/// Resize an ordinary file without changing the seek position.
	pub(super) fn set_len(&mut self, len: u64) -> io::Result<()> {
		match self {
			Self::File(file) => file.set_len(len),
			Self::Stdout { file, .. } | Self::Descriptor { file, .. } => match file {
				OpenFile::File(file) => file.set_len(len),
				OpenFile::Vfs(file) => file.set_len(len),
				OpenFile::Stream(_) => Err(bad_fd()),
			},
			_ => Err(bad_fd()),
		}
	}

	/// Close the device and wait for its child, if any, after releasing the pipe.
	pub(super) fn close(self) -> io::Result<Option<i32>> {
		match self {
			Self::File(file) => file.close().map(|_| None),
			Self::Descriptor { file, command, .. } => {
				drop(file);
				command.and_then(|child| child.status(true)).transpose()
			},
			_ => Ok(None),
		}
	}
}

impl Read for Device {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		match self {
			Self::File(file) => file.read(buf),
			Self::Stdin(stdin) => stdin.read(buf),
			Self::Scalar(scalar) => scalar.read(buf),
			Self::Descriptor { file, read_cancel, poll, .. } => {
				if let Some(flag) = read_cancel {
					let cancelled = || flag.load(Ordering::Relaxed);
					if cancelled() {
						return Err(omp_vfs::cancelled());
					}
					#[cfg(unix)]
					if *poll {
						omp_vfs::wait_readable(file.try_borrow_as_fd()?, cancelled)?;
					}
					#[cfg(windows)]
					if *poll && let OpenFile::File(file) = &*file {
						omp_vfs::wait_pipe_readable(file, cancelled)?;
					}
				}
				file.read(buf)
			},
			Self::Stdout { file, .. } => file.read(buf),
			Self::InPlace(_) => Err(bad_fd()),
		}
	}
}

impl Write for Device {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Self::File(file) => file.write(buf),
			Self::Stdout { writer, .. } => writer.write(buf),
			Self::Descriptor { file, read_cancel, poll, .. } => write_descriptor(file, read_cancel.as_deref(), *poll, buf),
			Self::Scalar(scalar) => scalar.write(buf),
			Self::InPlace(out) => out.try_borrow_mut().map_err(|_| bad_fd())?.write(buf),
			Self::Stdin(stdin) => stdin.file().clone().write(buf),
		}
	}

	fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
		match self {
			Self::File(file) => file.write_all(buf),
			Self::Stdout { writer, .. } => writer.write_all(buf),
			Self::Descriptor { file, read_cancel, poll, .. } => {
				let (cancel, poll) = (read_cancel.as_deref(), *poll);
				let mut rest = buf;
				while !rest.is_empty() {
					match write_descriptor(file, cancel, poll, rest) {
						Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
						Ok(n) => rest = &rest[n..],
						Err(e) if e.kind() == io::ErrorKind::Interrupted && !cancel.is_some_and(|c| c.load(Ordering::Relaxed)) => {},
						Err(e) => return Err(e),
					}
				}
				Ok(())
			},
			Self::Scalar(scalar) => scalar.write(buf).map(|_| ()),
			Self::InPlace(out) => out.try_borrow_mut().map_err(|_| bad_fd())?.write_all(buf),
			Self::Stdin(stdin) => stdin.file().clone().write_all(buf),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::File(file) => file.flush(),
			Self::Stdout { writer, .. } => writer.flush(),
			Self::Descriptor { file, .. } => file.flush(),
			_ => Ok(()),
		}
	}
}

/// Largest write that cannot block once a pipe polls writable (POSIX `PIPE_BUF`).
#[cfg(unix)]
const PIPE_CHUNK: usize = if cfg!(target_os = "linux") { 4096 } else { 512 };

/// Write to a shell descriptor. Pipes, sockets and terminals (`poll`) are written in
/// `PIPE_CHUNK` pieces after waiting for writability in short slices, so a reader that
/// never drains a full pipe cannot hold the shell past cancellation.
fn write_descriptor(file: &mut OpenFile, cancel: Option<&AtomicBool>, poll: bool, buf: &[u8]) -> io::Result<usize> {
	#[cfg(unix)]
	if poll && let Some(cancel) = cancel && !nonblocking(file) {
		use nix::poll::{PollFd, PollFlags, PollTimeout};
		loop {
			if cancel.load(Ordering::Relaxed) {
				return Err(omp_vfs::cancelled());
			}
			let ready = {
				let mut fds = [PollFd::new(file.try_borrow_as_fd()?, PollFlags::POLLOUT)];
				match nix::poll::poll(&mut fds, PollTimeout::from(50u16)) {
					Ok(n) => n > 0,
					Err(nix::errno::Errno::EINTR) => false,
					Err(e) => return Err(io::Error::from_raw_os_error(e as i32)),
				}
			};
			// Ready includes POLLERR/POLLHUP: the write reports EPIPE itself.
			if ready {
				return file.write(&buf[..buf.len().min(PIPE_CHUNK)]);
			}
		}
	}
	let _ = (cancel, poll);
	file.write(buf)
}

/// Whether the descriptor is in O_NONBLOCK mode (writes then report EAGAIN themselves).
#[cfg(unix)]
fn nonblocking(file: &OpenFile) -> bool {
	use nix::fcntl::{FcntlArg, OFlag, fcntl};
	file.try_borrow_as_fd().ok()
		.and_then(|fd| fcntl(fd, FcntlArg::F_GETFL).ok())
		.is_some_and(|flags| OFlag::from_bits_retain(flags).contains(OFlag::O_NONBLOCK))
}

impl Seek for Device {
	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		match self {
			Self::File(file) => file.seek(pos),
			Self::Stdin(stdin) => seek(stdin.file(), pos),
			Self::Stdout { file, .. } | Self::Descriptor { file, .. } => seek(file, pos),
			Self::Scalar(scalar) => scalar.seek(pos),
			Self::InPlace(_) => Err(io::ErrorKind::NotSeekable.into()),
		}
	}
}

/// Stat a host-provided open descriptor.
pub(super) fn metadata(file: &OpenFile) -> io::Result<Metadata> {
	match file {
		OpenFile::File(file) => Metadata::from_file(file),
		OpenFile::Vfs(file) => file.metadata(),
		OpenFile::Stream(_) => Err(bad_fd()),
	}
}

fn seek(file: &OpenFile, pos: SeekFrom) -> io::Result<u64> {
	match file {
		OpenFile::File(file) => (&**file).seek(pos),
		OpenFile::Vfs(file) => (&**file).seek(pos),
		OpenFile::Stream(_) => Err(io::ErrorKind::NotSeekable.into()),
	}
}

/// PerlIO's scalar layer stores bytes in the original SV, not in a copy.
pub(super) struct ScalarFile {
	sv: Sv,
	pos: u64,
	append: bool,
}

impl ScalarFile {
	/// Validate or truncate the existing SV and set the initial file position.
	pub(super) fn new(sv: Sv, truncate: bool, append: bool) -> io::Result<Self> {
		let pos = {
			let mut value = sv.try_value_mut().map_err(|_| bad_fd())?;
			if truncate {
				if !value.is_undef() {
					*value = Value::Str(PStr::default());
				}
			} else if let Value::Str(s) = &*value && s.utf8 {
				*value = Value::Str(PStr::new(s.downgraded().ok_or_else(wide_scalar)?, false));
			}
			if append { scalar_bytes(&value)?.len() as u64 } else { 0 }
		};
		Ok(Self { sv, pos, append })
	}

	/// Current cursor in the scalar, in its physical byte storage.
	pub(super) fn position(&self) -> u64 {
		self.pos
	}

	/// Test EOF without exposing the backing SV or freezing its contents.
	pub(super) fn eof(&self) -> io::Result<bool> {
		self.with_value(|value| Ok(self.pos >= scalar_bytes(value)?.len() as u64))
	}

	fn with_value<T>(&self, f: impl FnOnce(&Value) -> io::Result<T>) -> io::Result<T> {
		if self.sv.is_weak() { f(&self.sv.get()) } else {
			let value = self.sv.try_value().map_err(|_| bad_fd())?;
			f(&value)
		}
	}
}

fn wide_scalar() -> io::Error {
	io::Error::from_raw_os_error(libc::EINVAL)
}

fn scalar_bytes(value: &Value) -> io::Result<Cow<'_, [u8]>> {
	match value {
		Value::Undef => Ok(Cow::Borrowed(b"")),
		Value::Str(s) if !s.utf8 => Ok(Cow::Borrowed(&s.bytes)),
		Value::Str(s) => Ok(Cow::Owned(s.downgraded().ok_or_else(wide_scalar)?)),
		_ => {
			let s = value.to_pstr();
			Ok(Cow::Owned(if s.utf8 { s.downgraded().ok_or_else(wide_scalar)? } else { s.bytes }))
		},
	}
}

impl ScalarFile {
	fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
		let start = usize::try_from(self.pos).unwrap_or(usize::MAX);
		let n = self.with_value(|value| {
			let bytes = scalar_bytes(value)?;
			let rest = bytes.get(start..).unwrap_or_default();
			let n = rest.len().min(out.len());
			out[..n].copy_from_slice(&rest[..n]);
			Ok(n)
		})?;
		self.pos += n as u64;
		Ok(n)
	}

	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		let mut value = self.sv.try_value_mut().map_err(|_| bad_fd())?;
		if !matches!(&*value, Value::Str(s) if !s.utf8) {
			*value = Value::Str(PStr::new(scalar_bytes(&value)?.into_owned(), false));
		}
		let Value::Str(s) = &mut *value else { return Err(bad_fd()) };
		let start = if self.append { s.bytes.len() } else { usize::try_from(self.pos).map_err(io::Error::other)? };
		let end = start.checked_add(buf.len()).ok_or(io::ErrorKind::OutOfMemory)?;
		// A write after a seek far past the end must not zero-fill a script-sized gap.
		if end > s.bytes.len() && crate::perl::limits::check_len(end, "string").is_err() {
			return Err(io::Error::from_raw_os_error(libc::ENOMEM));
		}
		if end > s.bytes.len() {
			s.bytes.try_reserve(end - s.bytes.len()).map_err(io::Error::other)?;
			if start > s.bytes.len() {
				s.bytes.resize(start, 0);
			}
			let overlap = s.bytes.len() - start;
			s.bytes[start..].copy_from_slice(&buf[..overlap]);
			s.bytes.extend_from_slice(&buf[overlap..]);
		} else {
			s.bytes[start..end].copy_from_slice(buf);
		}
		self.pos = end as u64;
		self.sv.pos.set(None);
		Ok(buf.len())
	}

	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		self.pos = match pos {
			SeekFrom::Start(n) => Some(n),
			SeekFrom::Current(n) => self.pos.checked_add_signed(n),
			SeekFrom::End(n) => self.with_value(|value| Ok((scalar_bytes(value)?.len() as u64).checked_add_signed(n)))?,
		}.ok_or(io::ErrorKind::InvalidInput)?;
		Ok(self.pos)
	}
}
