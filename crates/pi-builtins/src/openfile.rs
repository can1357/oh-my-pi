//! Descriptors: the public [`Fd`] a host hands an extra, and the crate's
//! shareable [`OpenFile`] handle the extras do their I/O through.

// Parts serve only the feature-gated utility modules (`sed`, `tail`); a build
// without them legitimately leaves those unused.
#![allow(dead_code, reason = "consumed by the feature-gated utility modules")]

use std::{
	io::{self, IsTerminal as _, Read, Write},
	path::Path,
	sync::Arc,
};

/// Descriptor number of standard input.
pub(crate) const STDIN_FD: i32 = 0;
/// Descriptor number of standard output.
pub(crate) const STDOUT_FD: i32 = 1;
/// Descriptor number of standard error.
pub(crate) const STDERR_FD: i32 = 2;

/// One descriptor of an [`Invocation`](crate::extras::Invocation): what the
/// extra reads from or writes to.
///
/// The extras inspect the handle themselves (`fstat`, `isatty`), so a
/// regular file block-buffers output, a pipe or terminal line-buffers it, a
/// closed reader ends the extra like SIGPIPE, two descriptors onto one pipe
/// (`2>&1`) share one writer, and a read on a pipe or terminal stays
/// cancellable.
#[derive(Debug, Default)]
pub enum Fd {
	/// A closed descriptor: reads see end of input, writes are discarded.
	#[default]
	Closed,
	/// An operating-system handle: a regular file, either end of a pipe, a
	/// terminal, a socket, or the null device.
	File(std::fs::File),
	/// A file owned by a `pi_vfs` provider, with no native handle.
	Vfs(pi_vfs::File),
}

impl Fd {
	/// Another handle onto the same open file (a duplicated descriptor, or a
	/// provider clone).
	///
	/// # Errors
	///
	/// The duplication error.
	pub fn try_clone(&self) -> io::Result<Self> {
		Ok(match self {
			Self::Closed => Self::Closed,
			Self::File(file) => Self::File(file.try_clone()?),
			Self::Vfs(file) => Self::Vfs(file.try_clone()?),
		})
	}

	/// Whether the descriptor is closed.
	#[must_use]
	pub const fn is_closed(&self) -> bool {
		matches!(self, Self::Closed)
	}
}

impl From<std::fs::File> for Fd {
	fn from(file: std::fs::File) -> Self {
		Self::File(file)
	}
}

impl From<pi_vfs::File> for Fd {
	/// A provider file reporting a native handle becomes [`Fd::File`], so
	/// the extras see what that handle is; anything else stays virtual.
	fn from(file: pi_vfs::File) -> Self {
		match file.into_native() {
			Ok(native) => Self::File(native),
			Err(file) => Self::Vfs(file),
		}
	}
}

#[cfg(any(unix, windows))]
impl From<std::io::PipeReader> for Fd {
	fn from(reader: std::io::PipeReader) -> Self {
		Self::File(pipe_file(reader))
	}
}

#[cfg(any(unix, windows))]
impl From<std::io::PipeWriter> for Fd {
	fn from(writer: std::io::PipeWriter) -> Self {
		Self::File(pipe_file(writer))
	}
}

/// A pipe end as the `std::fs::File` owning its handle.
#[cfg(unix)]
fn pipe_file(end: impl Into<std::os::fd::OwnedFd>) -> std::fs::File {
	std::fs::File::from(end.into())
}

/// A pipe end as the `std::fs::File` owning its handle.
#[cfg(windows)]
fn pipe_file(end: impl Into<std::os::windows::io::OwnedHandle>) -> std::fs::File {
	std::fs::File::from(end.into())
}

/// An in-process stream an [`OpenFile`] can carry: the wrappers the host puts
/// around a descriptor (emulated SIGPIPE) and the in-memory streams of tests.
pub(crate) trait Stream: Read + Write + Send {
	/// The native descriptor the stream writes through, when it wraps one.
	#[cfg(unix)]
	fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
		None
	}

	/// Whether the stream writes into a pipe whose reader has exited; see
	/// [`OpenFile::reader_gone`].
	fn reader_gone(&self) -> bool {
		false
	}
}

/// An open file as the extras use it. Every variant is a shared handle, so
/// clones are cheap and infallible and all of them reach the same open file:
/// output written through any clone lands in order with the others.
#[derive(Clone)]
pub(crate) enum OpenFile {
	/// A native handle (regular file, pipe end, terminal, device).
	File(Arc<std::fs::File>),
	/// A `pi_vfs` provider file without a native handle.
	Vfs(Arc<pi_vfs::File>),
	/// An in-process stream.
	Stream(SharedStream),
}

/// An in-process [`Stream`] behind a lock, shared by every clone.
#[derive(Clone)]
pub(crate) struct SharedStream(Arc<parking_lot::Mutex<Box<dyn Stream>>>);

impl OpenFile {
	/// Wraps an in-process stream.
	pub fn stream(stream: Box<dyn Stream>) -> Self {
		Self::Stream(SharedStream(Arc::new(parking_lot::Mutex::new(stream))))
	}

	/// The open file behind `fd`; `None` when it is closed.
	pub fn from_fd(fd: Fd) -> Option<Self> {
		match fd {
			Fd::Closed => None,
			Fd::File(file) => Some(file.into()),
			Fd::Vfs(file) => Some(file.into()),
		}
	}

	/// Another handle to the open file; see [`OpenFile`].
	///
	/// # Errors
	///
	/// None: every variant is shared. The `Result` matches the `try_clone`
	/// of the handles it stands in for.
	pub fn try_clone(&self) -> io::Result<Self> {
		Ok(self.clone())
	}

	/// A descriptor of the same open file to hand a command: a duplicated
	/// native handle, or a provider clone.
	///
	/// # Errors
	///
	/// The duplication error; [`io::ErrorKind::Unsupported`] for an in-process
	/// stream, which no command can be given.
	pub fn to_fd(&self) -> io::Result<Fd> {
		match self {
			Self::File(file) => file.try_clone().map(Fd::File),
			Self::Vfs(file) => file.try_clone().map(Fd::Vfs),
			Self::Stream(_) => Err(io::Error::new(io::ErrorKind::Unsupported, "in-process stream")),
		}
	}

	/// The provider file behind this open file, if any.
	pub fn as_vfs(&self) -> Option<&pi_vfs::File> {
		if let Self::Vfs(file) = self { Some(file) } else { None }
	}

	/// The native descriptor, when there is one; `None` for a provider file
	/// and for a stream that wraps no descriptor.
	#[cfg(unix)]
	pub fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
		use std::os::fd::AsRawFd as _;

		match self {
			Self::File(file) => Some(file.as_raw_fd()),
			Self::Vfs(_) => None,
			Self::Stream(stream) => stream.0.lock().raw_fd(),
		}
	}

	/// Borrows the native descriptor.
	///
	/// # Errors
	///
	/// [`io::ErrorKind::Unsupported`] for a provider file or a stream with no
	/// descriptor.
	#[cfg(unix)]
	pub fn try_borrow_as_fd(&self) -> io::Result<std::os::fd::BorrowedFd<'_>> {
		let fd = self
			.raw_fd()
			.ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "no native descriptor"))?;
		// SAFETY: the descriptor belongs to a handle `self` keeps alive (a
		// shared native file, or the one a shared stream wraps), so it stays
		// open for the borrow's lifetime.
		Ok(unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) })
	}

	/// Whether the open file is the write end of a pipe whose reader has
	/// exited, as GNU `tail -f` checks while idle. Never blocks or writes data.
	///
	/// A native FIFO is polled for `POLLRDBAND`, which a pipe's write end
	/// never reports, so only a missing reader wakes it. A provider FIFO (an
	/// engine pipe) takes a zero-length write, which fails with
	/// [`io::ErrorKind::BrokenPipe`] once nobody reads.
	pub fn reader_gone(&self) -> bool {
		match self {
			Self::File(file) => native_reader_gone(file),
			Self::Vfs(file) => {
				file.metadata().is_ok_and(|metadata| metadata.file_type().is_fifo())
					&& (&**file).write(&[]).is_err_and(|error| error.kind() == io::ErrorKind::BrokenPipe)
			},
			Self::Stream(stream) => stream.0.lock().reader_gone(),
		}
	}

	/// Whether the open file is a terminal.
	pub fn is_terminal(&self) -> bool {
		match self {
			Self::File(file) => file.is_terminal(),
			Self::Vfs(_) => false,
			#[cfg(unix)]
			Self::Stream(_) => self.try_borrow_as_fd().is_ok_and(|fd| fd.is_terminal()),
			#[cfg(not(unix))]
			Self::Stream(_) => false,
		}
	}
}

impl From<std::fs::File> for OpenFile {
	fn from(file: std::fs::File) -> Self {
		Self::File(Arc::new(file))
	}
}

impl From<pi_vfs::File> for OpenFile {
	/// A provider file that turns out to be a native handle is kept as one.
	fn from(file: pi_vfs::File) -> Self {
		match file.into_native() {
			Ok(native) => native.into(),
			Err(file) => Self::Vfs(Arc::new(file)),
		}
	}
}

#[cfg(any(unix, windows))]
impl From<std::io::PipeReader> for OpenFile {
	fn from(reader: std::io::PipeReader) -> Self {
		pipe_file(reader).into()
	}
}

#[cfg(any(unix, windows))]
impl From<std::io::PipeWriter> for OpenFile {
	fn from(writer: std::io::PipeWriter) -> Self {
		pipe_file(writer).into()
	}
}

impl Read for OpenFile {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::File(file) => (&**file).read(buf),
			Self::Vfs(file) => (&**file).read(buf),
			Self::Stream(stream) => stream.0.lock().read(buf),
		}
	}
}

impl Write for OpenFile {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Self::File(file) => (&**file).write(buf),
			Self::Vfs(file) => (&**file).write(buf),
			Self::Stream(stream) => stream.0.lock().write(buf),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::File(file) => (&**file).flush(),
			Self::Vfs(file) => (&**file).flush(),
			Self::Stream(stream) => stream.0.lock().flush(),
		}
	}
}

/// [`OpenFile::reader_gone`] for a native handle.
#[cfg(unix)]
fn native_reader_gone(file: &std::fs::File) -> bool {
	use std::os::fd::AsFd as _;

	use nix::{
		poll::{PollFd, PollFlags, PollTimeout, poll},
		sys::stat::{SFlag, fstat},
	};

	let fd = file.as_fd();
	let is_fifo = fstat(fd)
		.is_ok_and(|stat| SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT == SFlag::S_IFIFO);
	if !is_fifo {
		return false;
	}
	// POLLRDBAND like GNU tail/tee: never ready on a pipe's write end, so
	// only a missing reader wakes it.
	let mut fds = [PollFd::new(fd, PollFlags::POLLRDBAND)];
	matches!(poll(&mut fds, PollTimeout::ZERO), Ok(n) if n > 0) && widowed(fds[0].revents())
}

/// [`OpenFile::reader_gone`] for a native handle: unknown off Unix.
#[cfg(not(unix))]
const fn native_reader_gone(_file: &std::fs::File) -> bool {
	false
}

/// Whether `poll` revents on a pipe's write end report that no reader is
/// left. Linux sets POLLERR; Darwin and most other Unices set POLLHUP
/// instead, so accept any of POLLERR | POLLHUP | POLLNVAL like GNU
/// `iopoll()`. Unrecognized bits (`None`) also count as broken.
#[cfg(unix)]
fn widowed(revents: Option<nix::poll::PollFlags>) -> bool {
	use nix::poll::PollFlags;

	revents.is_none_or(|revents| revents.intersects(PollFlags::POLLERR | PollFlags::POLLHUP | PollFlags::POLLNVAL))
}

/// Opens the null device for reading and writing: the stand-in for a closed
/// descriptor.
///
/// # Errors
///
/// The open error.
pub(crate) fn null() -> io::Result<OpenFile> {
	let path = if cfg!(windows) { "NUL" } else { "/dev/null" };
	let file = std::fs::File::options().read(true).write(true).open(path)?;
	Ok(file.into())
}

/// Whether reads of `file` are input a command was handed on purpose (a pipe,
/// FIFO, socket, provider file, or in-process stream) rather than a terminal,
/// a regular file, or a device.
pub(crate) fn is_piped_input(file: &OpenFile) -> bool {
	match file {
		OpenFile::Vfs(_) | OpenFile::Stream(_) => true,
		OpenFile::File(file) => is_pipe(file),
	}
}

#[cfg(unix)]
fn is_pipe(file: &std::fs::File) -> bool {
	use std::os::unix::fs::FileTypeExt as _;

	file.metadata().is_ok_and(|metadata| {
		let kind = metadata.file_type();
		kind.is_fifo() || kind.is_socket()
	})
}

#[cfg(windows)]
fn is_pipe(file: &std::fs::File) -> bool {
	use std::os::windows::io::AsRawHandle as _;

	use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType};

	// SAFETY: the handle is owned by `file`, which outlives the call.
	unsafe { GetFileType(file.as_raw_handle()) == FILE_TYPE_PIPE }
}

#[cfg(not(any(unix, windows)))]
const fn is_pipe(_file: &std::fs::File) -> bool {
	false
}

/// What a `/dev` or `/proc` path names when it stands for one of this
/// process's own descriptors: an extra runs inside the host process, so such
/// a path must be answered from the invocation's descriptors, not the host's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DescriptorPath {
	/// Descriptor `n`: `/dev/stdin` (0), `/dev/stdout` (1), `/dev/stderr`
	/// (2), `/dev/fd/n`, or `/proc/{self,thread-self,<own pid>}/fd/n`.
	Fd(i32),
	/// The controlling terminal, `/dev/tty`.
	Terminal,
}

impl DescriptorPath {
	/// What the absolute `path` names, `None` unless it is one of the
	/// spellings above (`.` and repeated `/` are allowed between names).
	pub fn parse(path: &Path) -> Option<Self> {
		let text = path.to_str()?;
		if !text.starts_with('/') {
			return None;
		}
		let names: Vec<&str> = text.split('/').filter(|name| !name.is_empty() && *name != ".").collect();
		if names.contains(&"..") {
			return None;
		}
		let number = |name: &str| -> Option<i32> {
			if name.is_empty() || name.len() > 10 || !name.chars().all(|ch| ch.is_ascii_digit()) {
				return None;
			}
			name.parse().ok()
		};
		let own_process = |name: &str| {
			matches!(name, "self" | "thread-self")
				|| number(name).and_then(|pid| u32::try_from(pid).ok()) == Some(std::process::id())
		};
		match names.as_slice() {
			["dev", "stdin"] => Some(Self::Fd(STDIN_FD)),
			["dev", "stdout"] => Some(Self::Fd(STDOUT_FD)),
			["dev", "stderr"] => Some(Self::Fd(STDERR_FD)),
			["dev", "tty"] => Some(Self::Terminal),
			["dev", "fd", fd] => number(fd).map(Self::Fd),
			["proc", process, "fd", fd] if own_process(process) => number(fd).map(Self::Fd),
			_ => None,
		}
	}
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use super::DescriptorPath::{self, Fd, Terminal};

	fn parse(path: &str) -> Option<DescriptorPath> {
		DescriptorPath::parse(Path::new(path))
	}

	#[test]
	fn descriptor_paths_name_this_process_only() {
		let own = std::process::id();
		for (path, expected) in [
			("/dev/stdin", Fd(0)),
			("/dev/stdout", Fd(1)),
			("/dev/stderr", Fd(2)),
			("/dev/tty", Terminal),
			("/dev/fd/63", Fd(63)),
			("//dev/./fd/7", Fd(7)),
			("/proc/self/fd/3", Fd(3)),
			("/proc/thread-self/fd/4", Fd(4)),
			(&format!("/proc/{own}/fd/5"), Fd(5)),
		] {
			assert_eq!(parse(path), Some(expected), "{path}");
		}
		for path in ["dev/stdin", "/dev/fd", "/dev/fd/-1", "/dev/fd/x", "/proc/1/fd/3", "/dev/null"] {
			if path == "/proc/1/fd/3" && own == 1 {
				continue;
			}
			assert_eq!(parse(path), None, "{path}");
		}
	}

	// Failure mode: Darwin reports a widowed pipe write end as
	// POLLHUP|POLLRDBAND without POLLERR, so `tail -f log | head -n1`
	// kept following on macOS after head exited.
	#[cfg(unix)]
	#[test]
	fn widowed_accepts_darwin_and_linux_revents() {
		use nix::poll::PollFlags;

		use super::widowed;

		assert!(widowed(Some(PollFlags::POLLHUP | PollFlags::POLLRDBAND)));
		assert!(widowed(Some(PollFlags::POLLERR)));
		assert!(!widowed(Some(PollFlags::POLLRDBAND)));
	}

	#[cfg(unix)]
	#[test]
	fn native_pipe_reader_gone_once_the_reader_closes() {
		let (reader, writer) = std::io::pipe().unwrap();
		let writer = super::OpenFile::from(writer);
		assert!(!writer.reader_gone());
		drop(reader);
		assert!(writer.reader_gone());
		assert!(!super::OpenFile::from(tempfile::tempfile().unwrap()).reader_gone());
	}

	#[cfg(unix)]
	#[test]
	fn pipes_count_as_piped_input_and_files_do_not() {
		let (reader, _writer) = std::io::pipe().unwrap();
		assert!(super::is_piped_input(&super::OpenFile::from(reader)));
		let file = tempfile::tempfile().unwrap();
		assert!(!super::is_piped_input(&super::OpenFile::from(file)));
	}
}
