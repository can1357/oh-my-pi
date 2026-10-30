//! Asynchronous standard-stream plumbing for async utilities.
//!
//! An async utility body runs as a task on the runtime, so it must never make
//! a blocking call on a descriptor or a virtual filesystem provider. Output
//! therefore lands in an in-memory buffer ([`AsyncOut`]) that the host drains
//! at unit boundaries, and input is read through a [`Source`]. Both reach
//! native descriptors through readiness-driven I/O:
//!
//! - A descriptor inherited from the shell (stdin, stdout, stderr) shares its
//!   open file description with the shell and with other pipeline stages, so
//!   `O_NONBLOCK` is never set on it. A private duplicate is registered with
//!   the reactor instead, and every syscall on it is preceded by a zero-timeout
//!   readiness check, so it cannot block.
//! - A descriptor this module opens itself (a FIFO operand) owns its
//!   description: it is opened `O_NONBLOCK` and read until `WouldBlock`.
//! - Regular files, never-blocking devices and in-process streams are read and
//!   written inline: no readiness exists for them and they never wait for
//!   another process.
//! - Off unix, where anonymous pipes have no readiness API, Windows pipes run
//!   their reads and writes on the blocking pool behind the same async API.

// The module is API consumed by the feature-gated utility modules; a build with
// no utility features enabled legitimately uses none of it.
#![allow(dead_code, reason = "consumed by the feature-gated utility modules")]

#[cfg(unix)]
use std::os::fd::{AsFd, OwnedFd};
use std::{
	io::{self, Read, Write},
	path::Path,
	sync::Arc,
};

use brush_core::openfiles::OpenFile;
use parking_lot::Mutex;

use crate::host::OutputGate;

/// Pending bytes at which a regular-file destination is drained before the
/// utility ends.
const FILE_DRAIN_THRESHOLD: usize = 64 * 1024;

/// Largest buffer a drained batch hands back for reuse.
const RECYCLED_CAPACITY: usize = 1024 * 1024;

/// Largest read [`Source::read_to_end`] makes at once.
const READ_CHUNK: usize = 64 * 1024;

/// Memory-backed output of an async utility: `Write` appends to a buffer that
/// never touches the descriptor, and the host delivers it with
/// [`AsyncOut::drain`].
///
/// Clones share the buffer, so handles for stdout and stderr onto one
/// destination (`2>&1`) keep write order. The emulated-SIGPIPE and
/// cancellation rules of the descriptor-backed writers hold: once the command
/// is cancelled, writes and pending bytes are dropped; once a drain hit a
/// closed reader, stderr output is discarded and stdout writes fail.
#[derive(Clone)]
pub(crate) struct AsyncOut {
	shared: Arc<Shared>,
}

struct Shared {
	pending:      Mutex<Vec<u8>>,
	sink:         Sink,
	/// The destination as a plain file, for duplicating and terminal checks
	/// without waiting on a drain in progress.
	handle:       OpenFile,
	regular_file: bool,
	gate:         OutputGate,
}

enum Sink {
	/// A provider file, written through its async API; the lock keeps
	/// concurrent drains in order.
	Provider(tokio::sync::Mutex<()>),
	/// A descriptor or in-process stream, opened on the first drain; the lock
	/// keeps concurrent drains in order.
	Native(tokio::sync::Mutex<Native>),
}

/// How a native destination is written, decided on the first drain.
enum Native {
	/// Not classified yet.
	Unopened,
	/// A regular file, never-blocking device or in-process stream, written
	/// inline.
	Inline(OpenFile),
	/// A descriptor written once the reactor reports it writable.
	#[cfg(unix)]
	Descriptor(descriptor::Descriptor),
	/// A pipe written on the blocking pool.
	#[cfg(windows)]
	Blocking(OpenFile),
}

impl Native {
	/// Classifies `handle`: inline for a regular file, a device that never
	/// blocks or an in-process stream; otherwise a reactor-driven descriptor
	/// (a blocking-pool pipe on Windows). Needs a runtime to register with.
	fn open(handle: &OpenFile, regular_file: bool) -> Self {
		#[cfg(unix)]
		{
			if !regular_file
				&& let Ok(fd) = handle.try_borrow_as_fd()
				&& pi_vfs::fd_reads_can_block(fd)
				&& let Ok(owned) = fd.try_clone_to_owned()
				&& let Ok(descriptor) = descriptor::Descriptor::gated(owned)
			{
				return Self::Descriptor(descriptor);
			}
			Self::Inline(handle.clone())
		}
		#[cfg(windows)]
		{
			if regular_file { Self::Inline(handle.clone()) } else { Self::Blocking(handle.clone()) }
		}
		#[cfg(not(any(unix, windows)))]
		{
			let _ = regular_file;
			Self::Inline(handle.clone())
		}
	}

	/// Writes all of `bytes`; hands them back for reuse.
	async fn write_all(&mut self, bytes: Vec<u8>) -> (Vec<u8>, io::Result<()>) {
		match self {
			Self::Unopened => (bytes, Ok(())),
			Self::Inline(file) => {
				let result = file.write_all(&bytes).and_then(|()| file.flush());
				(bytes, result)
			},
			#[cfg(unix)]
			Self::Descriptor(descriptor) => {
				let result = descriptor.write_all(&bytes).await;
				(bytes, result)
			},
			#[cfg(windows)]
			Self::Blocking(file) => {
				let mut file = file.clone();
				match tokio::task::spawn_blocking(move || {
					let result = file.write_all(&bytes).and_then(|()| file.flush());
					(bytes, result)
				})
				.await
				{
					Ok(done) => done,
					Err(error) => (Vec::new(), Err(io::Error::other(error))),
				}
			},
		}
	}
}

impl AsyncOut {
	/// Output delivered to a provider file through its async API.
	pub fn provider(file: pi_vfs::File, gate: OutputGate) -> Self {
		Self::new(Sink::Provider(tokio::sync::Mutex::new(())), OpenFile::Vfs(file), false, gate)
	}

	/// Output delivered to `handle`, a native descriptor or in-process stream.
	pub fn native(handle: OpenFile, regular_file: bool, gate: OutputGate) -> Self {
		Self::new(Sink::Native(tokio::sync::Mutex::new(Native::Unopened)), handle, regular_file, gate)
	}

	fn new(sink: Sink, handle: OpenFile, regular_file: bool, gate: OutputGate) -> Self {
		Self {
			shared: Arc::new(Shared { pending: Mutex::default(), sink, handle, regular_file, gate }),
		}
	}

	/// Whether `self` and `other` are handles onto one buffer.
	pub fn same_as(&self, other: &Self) -> bool {
		Arc::ptr_eq(&self.shared, &other.shared)
	}

	/// Duplicates the destination as a raw [`OpenFile`]; pending bytes are not
	/// carried over.
	pub fn dup_file(&self) -> OpenFile {
		self.shared.handle.clone()
	}

	/// Whether the destination is a terminal.
	pub fn is_terminal(&self) -> bool {
		self.shared.handle.is_terminal()
	}

	/// Delivers the pending bytes: all of them when `full` or when the
	/// destination is not a regular file, else only once 64 KiB are pending.
	/// Returns at once when nothing is due.
	///
	/// A closed reader surfaces as [`io::ErrorKind::BrokenPipe`] and flips the
	/// SIGPIPE state; a cancelled command drops the bytes silently.
	pub async fn drain(&self, full: bool) -> io::Result<()> {
		if !self.shared.due(full) {
			return Ok(());
		}
		match &self.shared.sink {
			Sink::Provider(order) => self.shared.drain_provider(order).await,
			Sink::Native(native) => self.shared.drain_native(native).await,
		}
	}
}

impl Shared {
	fn due(&self, full: bool) -> bool {
		let pending = self.pending.lock().len();
		pending > 0 && (full || !self.regular_file || pending >= FILE_DRAIN_THRESHOLD)
	}

	fn append(&self, buf: &[u8]) -> io::Result<()> {
		if self.gate.discards() {
			return Ok(());
		}
		if self.gate.fails() {
			return Err(io::ErrorKind::BrokenPipe.into());
		}
		self.pending.lock().extend_from_slice(buf);
		Ok(())
	}

	/// Hands a delivered batch's allocation back for the next one.
	fn recycle(&self, mut bytes: Vec<u8>) {
		if bytes.capacity() > RECYCLED_CAPACITY {
			return;
		}
		let mut pending = self.pending.lock();
		if pending.is_empty() && pending.capacity() < bytes.capacity() {
			bytes.clear();
			*pending = bytes;
		}
	}

	async fn drain_provider(&self, order: &tokio::sync::Mutex<()>) -> io::Result<()> {
		let _order = order.lock().await;
		let bytes = std::mem::take(&mut *self.pending.lock());
		let Some(file) = self.handle.as_vfs() else {
			return Ok(());
		};
		if bytes.is_empty() || self.gate.discards() {
			self.recycle(bytes);
			return Ok(());
		}
		let result = async {
			file.write_all_async(&bytes).await?;
			file.flush_async().await
		}
		.await;
		if let Err(error) = &result {
			self.gate.record(error);
		}
		self.recycle(bytes);
		result
	}

	async fn drain_native(&self, native: &tokio::sync::Mutex<Native>) -> io::Result<()> {
		let mut native = native.lock().await;
		let bytes = std::mem::take(&mut *self.pending.lock());
		if bytes.is_empty() {
			return Ok(());
		}
		if self.gate.discards() {
			self.recycle(bytes);
			return Ok(());
		}
		if matches!(*native, Native::Unopened) {
			*native = Native::open(&self.handle, self.regular_file);
		}
		let (bytes, result) = native.write_all(bytes).await;
		if let Err(error) = &result {
			self.gate.record(error);
		}
		self.recycle(bytes);
		result
	}
}

impl Write for AsyncOut {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.shared.append(buf)?;
		Ok(buf.len())
	}

	fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
		self.shared.append(buf)
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// An input read without blocking the runtime: a provider file, a native descriptor (readiness-driven), a regular file (inline reads), or an in-process stream.
///
/// Dropping the future of a pending read cancels it; nothing is left running.
pub(crate) struct Source {
	repr:     Repr,
	metadata: Option<pi_vfs::Metadata>,
}

enum Repr {
	/// A provider file, or a native regular file, read through the file's
	/// async API.
	File(pi_vfs::File),
	/// A never-blocking native descriptor or an in-process stream, read
	/// inline.
	Inline(OpenFile),
	/// A descriptor read once the reactor reports it readable.
	#[cfg(unix)]
	Descriptor(descriptor::Descriptor),
	/// A pipe read on the blocking pool.
	#[cfg(windows)]
	Blocking(Blocking),
}

impl Source {
	fn new(repr: Repr, metadata: Option<pi_vfs::Metadata>) -> Self {
		Self { repr, metadata }
	}

	/// Opens `path` on `fs` for reading (FIFOs open without waiting for a writer).
	///
	/// # Errors
	///
	/// The open error.
	pub async fn open(fs: &pi_vfs::Fs, path: &Path) -> io::Result<Self> {
		if !fs.is_native_local(path) {
			let file = fs.open(path).await?;
			let metadata = file.metadata_async().await.ok();
			return Ok(Self::new(Repr::File(file), metadata));
		}
		let metadata = fs.metadata(path).await.ok();
		let special = metadata
			.as_ref()
			.map(pi_vfs::Metadata::file_type)
			.filter(|kind| !kind.is_file() && !kind.is_dir());
		match special {
			Some(kind) => Self::open_special(fs, path, kind.is_fifo(), metadata).await,
			None => Ok(Self::new(Repr::File(fs.open(path).await?), metadata)),
		}
	}

	/// Opens a native path that is neither a regular file nor a directory.
	async fn open_special(
		fs: &pi_vfs::Fs,
		path: &Path,
		fifo: bool,
		metadata: Option<pi_vfs::Metadata>,
	) -> io::Result<Self> {
		#[cfg(unix)]
		{
			// A FIFO opened `O_NONBLOCK` does not wait for a writer. Where the
			// path is an alias of a descriptor the shell passed, opening it
			// duplicates that descriptor instead of making a new description,
			// and `O_NONBLOCK` would leak to the shell.
			let owned_description = fifo && !aliases_descriptor(path);
			let file = if owned_description {
				let mut options = pi_vfs::OpenOptions::new();
				options.read(true).custom_flags(libc::O_NONBLOCK);
				fs.open_with(path, &options).await?
			} else {
				fs.open(path).await?
			};
			let file = file
				.into_native()
				.map_err(|_| io::Error::from(io::ErrorKind::Unsupported))?;
			let fd = OwnedFd::from(file);
			let descriptor = if owned_description {
				descriptor::Descriptor::nonblocking(fd)
			} else if pi_vfs::fd_reads_can_block(fd.as_fd()) {
				descriptor::Descriptor::gated(fd)
			} else {
				Err(fd)
			};
			let repr = match descriptor {
				Ok(descriptor) => Repr::Descriptor(descriptor),
				Err(fd) => Repr::Inline(OpenFile::File(std::fs::File::from(fd))),
			};
			Ok(Self::new(repr, metadata))
		}
		#[cfg(not(unix))]
		{
			let _ = fifo;
			let file = fs.open(path).await?;
			#[cfg(windows)]
			{
				let native = file
					.into_native()
					.map_err(|_| io::Error::from(io::ErrorKind::Unsupported))?;
				return Ok(Self::new(Repr::Blocking(Blocking::new(OpenFile::File(native))), metadata));
			}
			#[cfg(not(windows))]
			{
				Ok(Self::new(Repr::File(file), metadata))
			}
		}
	}

	/// Reads a descriptor handed in by the shell (stdin): a provider file
	/// through its async API, a descriptor that can block through the
	/// reactor on a private duplicate (the shared description's flags stay
	/// untouched), anything else inline. A descriptor that can block needs a
	/// runtime to register with.
	///
	/// # Errors
	///
	/// The error of duplicating the file.
	pub fn inherited(file: &OpenFile) -> io::Result<Self> {
		if let Some(file) = file.as_vfs() {
			return Ok(Self::new(Repr::File(file.try_clone()?), None));
		}
		#[cfg(unix)]
		if let Ok(fd) = file.try_borrow_as_fd()
			&& pi_vfs::fd_reads_can_block(fd)
			&& let Ok(descriptor) = descriptor::Descriptor::gated(fd.try_clone_to_owned()?)
		{
			return Ok(Self::new(Repr::Descriptor(descriptor), None));
		}
		#[cfg(windows)]
		if !matches!(file, OpenFile::Stream(_))
			&& !matches!(file, OpenFile::File(native) if native.metadata().is_ok_and(|meta| meta.is_file()))
		{
			return Ok(Self::new(Repr::Blocking(Blocking::new(file.try_clone()?)), None));
		}
		Ok(Self::new(Repr::Inline(file.try_clone()?), None))
	}

	/// Reads up to `buf.len()` bytes; 0 at end of input.
	///
	/// # Errors
	///
	/// The read error.
	pub async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		// File and inline reads never suspend: spend the task's coop budget so
		// a long read loop still yields and its cancellation takes effect.
		tokio::task::coop::consume_budget().await;
		match &mut self.repr {
			Repr::File(file) => file.read_async(buf).await,
			Repr::Inline(file) => loop {
				match file.read(buf) {
					Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
					result => return result,
				}
			},
			#[cfg(unix)]
			Repr::Descriptor(descriptor) => descriptor.read(buf).await,
			#[cfg(windows)]
			Repr::Blocking(pipe) => pipe.read(buf).await,
		}
	}

	/// Reads the rest into `buf`; `io::ErrorKind::OutOfMemory` past `limit` bytes.
	///
	/// Returns the bytes appended. On an error, or when the future is dropped,
	/// `buf` keeps what was read within the limit.
	///
	/// # Errors
	///
	/// [`io::ErrorKind::OutOfMemory`] past `limit`, else the read error.
	pub async fn read_to_end(&mut self, buf: &mut Vec<u8>, limit: usize) -> io::Result<usize> {
		let hint = self
			.metadata
			.as_ref()
			.map_or(0, |meta| usize::try_from(meta.len()).unwrap_or(usize::MAX))
			.min(limit);
		buf.try_reserve(hint)
			.map_err(|_| io::Error::from(io::ErrorKind::OutOfMemory))?;
		let mut chunk = vec![0; READ_CHUNK.min(limit.saturating_add(1))];
		let mut total = 0;
		loop {
			let count = self.read(&mut chunk).await?;
			if count == 0 {
				return Ok(total);
			}
			let room = limit - total;
			if count > room {
				buf.extend_from_slice(&chunk[..room]);
				return Err(io::Error::new(io::ErrorKind::OutOfMemory, "input exceeds the size limit"));
			}
			buf.extend_from_slice(&chunk[..count]);
			total += count;
		}
	}

	/// Size and type reported at open, when known.
	pub fn metadata(&self) -> Option<&pi_vfs::Metadata> {
		self.metadata.as_ref()
	}
}

/// Whether `path` names one of the shell's descriptors in a way that opening
/// it duplicates the descriptor rather than reopening the object (macOS and
/// the BSDs; Linux reopens through `/proc`).
#[cfg(unix)]
fn aliases_descriptor(path: &Path) -> bool {
	!cfg!(any(target_os = "linux", target_os = "android"))
		&& ["/dev/fd", "/dev/stdin", "/dev/stdout", "/dev/stderr"]
			.iter()
			.any(|alias| path.starts_with(alias))
}

/// A pipe read on the blocking pool, where the platform has no readiness API.
#[cfg(windows)]
struct Blocking {
	file:    Option<OpenFile>,
	scratch: Vec<u8>,
}

#[cfg(windows)]
impl Blocking {
	fn new(file: OpenFile) -> Self {
		Self { file: Some(file), scratch: Vec::new() }
	}

	async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let Some(mut file) = self.file.take() else {
			return Err(io::Error::other("input lost to an abandoned read"));
		};
		let mut scratch = std::mem::take(&mut self.scratch);
		scratch.resize(buf.len().min(READ_CHUNK), 0);
		let (file, scratch, result) = tokio::task::spawn_blocking(move || {
			let result = file.read(&mut scratch);
			(file, scratch, result)
		})
		.await
		.map_err(io::Error::other)?;
		self.file = Some(file);
		let count = result?;
		buf[..count].copy_from_slice(&scratch[..count]);
		self.scratch = scratch;
		Ok(count)
	}
}

#[cfg(unix)]
mod descriptor {
	//! Readiness-driven I/O on native descriptors.

	use std::{
		io,
		os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd},
		time::Duration,
	};

	use tokio::io::unix::AsyncFd;

	/// Bytes written at once when a descriptor's free space is unknown: what
	/// a pipe accepts atomically.
	const ATOMIC_WRITE: usize = if cfg!(any(target_os = "linux", target_os = "android")) { 4096 } else { 512 };

	/// How often a read waiting on a named FIFO rechecks it on Apple
	/// platforms, whose kqueue never reports that a FIFO's last writer closed
	/// (`EVFILT_READ` stays silent; `poll` sees it).
	#[cfg(target_vendor = "apple")]
	const FIFO_EOF_RECHECK: Duration = Duration::from_millis(25);

	/// A descriptor registered with the reactor.
	pub(super) struct Descriptor {
		afd:   AsyncFd<OwnedFd>,
		/// The open file description is shared (or left blocking): every
		/// syscall is preceded by a zero-timeout readiness check, so it cannot
		/// block and `O_NONBLOCK` is never needed.
		gated: bool,
		/// The reactor never reports this descriptor's end of input (a named
		/// FIFO on an Apple platform); waits recheck it periodically.
		eof_unreported: bool,
	}

	impl Descriptor {
		/// Registers `fd`, whose description may be shared with other
		/// processes: its flags stay as they are. Hands `fd` back when the
		/// reactor cannot watch it (a device without `poll` support, which is
		/// always ready).
		pub fn gated(fd: OwnedFd) -> Result<Self, OwnedFd> {
			Self::register(fd, true)
		}

		/// Registers `fd`, whose description this process opened `O_NONBLOCK`.
		pub fn nonblocking(fd: OwnedFd) -> Result<Self, OwnedFd> {
			Self::register(fd, false)
		}

		fn register(fd: OwnedFd, gated: bool) -> Result<Self, OwnedFd> {
			let eof_unreported = is_named_fifo(fd.as_fd());
			match AsyncFd::try_new(fd) {
				Ok(afd) => Ok(Self { afd, gated, eof_unreported }),
				Err(error) => Err(error.into_parts().0),
			}
		}

		/// Reads up to `buf.len()` bytes, waiting for readiness.
		pub async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
			loop {
				let mut guard = if self.eof_unreported {
					match self.readable_or_recheck().await? {
						Some(guard) => guard,
						None => {
							if readable_now(self.afd.get_ref().as_fd())? {
								match sys_read(self.afd.get_ref().as_raw_fd(), buf) {
									Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
									Err(error) if error.kind() == io::ErrorKind::WouldBlock => {},
									result => return result,
								}
							}
							continue;
						},
					}
				} else {
					self.afd.readable().await?
				};
				if self.gated && !readable_now(self.afd.get_ref().as_fd())? {
					guard.clear_ready();
					continue;
				}
				match guard.try_io(|afd| sys_read(afd.get_ref().as_raw_fd(), buf)) {
					Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {},
					Ok(result) => return result,
					Err(_would_block) => {},
				}
			}
		}

		/// Readiness, or `None` once the recheck interval passed without it.
		#[cfg(target_vendor = "apple")]
		async fn readable_or_recheck(
			&self,
		) -> io::Result<Option<tokio::io::unix::AsyncFdReadyGuard<'_, OwnedFd>>> {
			tokio::select! {
				guard = self.afd.readable() => guard.map(Some),
				() = tokio::time::sleep(FIFO_EOF_RECHECK) => Ok(None),
			}
		}

		/// Readiness; every other platform's reactor reports end of input.
		#[cfg(not(target_vendor = "apple"))]
		async fn readable_or_recheck(
			&self,
		) -> io::Result<Option<tokio::io::unix::AsyncFdReadyGuard<'_, OwnedFd>>> {
			self.afd.readable().await.map(Some)
		}

		/// Writes all of `buf`, waiting for room: at most the free space of a
		/// pipe at a time, so a gated write never blocks.
		pub async fn write_all(&self, mut buf: &[u8]) -> io::Result<()> {
			while !buf.is_empty() {
				let mut guard = self.afd.writable().await?;
				let fd = self.afd.get_ref().as_fd();
				if self.gated && !writable_now(fd)? {
					guard.clear_ready();
					continue;
				}
				let room = if self.gated {
					free_space(fd).unwrap_or(ATOMIC_WRITE).clamp(1, buf.len())
				} else {
					buf.len()
				};
				match guard.try_io(|afd| sys_write(afd.get_ref().as_raw_fd(), &buf[..room])) {
					Ok(Ok(0)) => return Err(io::ErrorKind::WriteZero.into()),
					Ok(Ok(written)) => buf = &buf[written..],
					Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {},
					Ok(Err(error)) => return Err(error),
					Err(_would_block) => {},
				}
			}
			Ok(())
		}
	}

	fn sys_read(fd: i32, buf: &mut [u8]) -> io::Result<usize> {
		// SAFETY: `buf` is valid for writes of `buf.len()` bytes and `fd` is a
		// live descriptor owned by the caller's `AsyncFd` for the call.
		let count = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
		usize::try_from(count).map_err(|_| io::Error::last_os_error())
	}

	fn sys_write(fd: i32, buf: &[u8]) -> io::Result<usize> {
		// SAFETY: `buf` is valid for reads of `buf.len()` bytes and `fd` is a
		// live descriptor owned by the caller's `AsyncFd` for the call.
		let count = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
		usize::try_from(count).map_err(|_| io::Error::last_os_error())
	}

	/// Whether `fd` is a FIFO with a name on an Apple platform (an anonymous
	/// pipe has no links), whose writer's close kqueue never reports.
	#[cfg(target_vendor = "apple")]
	fn is_named_fifo(fd: BorrowedFd<'_>) -> bool {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `stat` is valid for writes of one `struct stat`; `fd` is
		// borrowed from a live descriptor for the call.
		if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
			return false;
		}
		// SAFETY: a successful `fstat` filled the whole struct.
		let stat = unsafe { stat.assume_init() };
		stat.st_mode & libc::S_IFMT == libc::S_IFIFO && stat.st_nlink > 0
	}

	/// Every other platform's reactor reports a FIFO's end of input.
	#[cfg(not(target_vendor = "apple"))]
	const fn is_named_fifo(_fd: BorrowedFd<'_>) -> bool {
		false
	}

	/// Whether a read of `fd` would not block (data, end of input or an error
	/// is pending), checked without waiting.
	fn readable_now(fd: BorrowedFd<'_>) -> io::Result<bool> {
		loop {
			match pi_vfs::readable_within(fd, Duration::ZERO) {
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
				result => return result,
			}
		}
	}

	/// Whether a write to `fd` would not block, checked without waiting.
	fn writable_now(fd: BorrowedFd<'_>) -> io::Result<bool> {
		let mut pollfd = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLOUT, revents: 0 };
		loop {
			// SAFETY: one `pollfd` valid for the call; `fd` is borrowed from a
			// live descriptor for the whole call.
			match unsafe { libc::poll(&raw mut pollfd, 1, 0) } {
				..0 => {
					let error = io::Error::last_os_error();
					if error.kind() != io::ErrorKind::Interrupted {
						return Err(error);
					}
				},
				ready => return Ok(ready > 0),
			}
		}
	}

	/// Bytes a pipe accepts without blocking (its capacity less what is
	/// queued); `None` for other descriptors and when the platform does not
	/// say.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	fn free_space(fd: BorrowedFd<'_>) -> Option<usize> {
		// SAFETY: `F_GETPIPE_SZ` takes no argument; `fd` is borrowed from a live
		// descriptor for the call.
		let capacity = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETPIPE_SZ) };
		let mut queued: libc::c_int = 0;
		// SAFETY: `FIONREAD` writes one `c_int` through the pointer, which is
		// valid for the call; `fd` is borrowed from a live descriptor.
		let status = unsafe { libc::ioctl(fd.as_raw_fd(), libc::FIONREAD, &raw mut queued) };
		if capacity < 0 || status < 0 {
			return None;
		}
		usize::try_from(capacity.saturating_sub(queued).max(0)).ok()
	}

	/// Bytes a pipe accepts without blocking (its block size less what is
	/// queued); `None` for other descriptors and when the platform does not
	/// say.
	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	fn free_space(fd: BorrowedFd<'_>) -> Option<usize> {
		use std::mem::MaybeUninit;

		let mut stat = MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `stat` is valid for writes of one `struct stat`; `fd` is
		// borrowed from a live descriptor for the call.
		if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
			return None;
		}
		// SAFETY: a successful `fstat` filled the whole struct.
		let stat = unsafe { stat.assume_init() };
		if stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
			return None;
		}
		let block = usize::try_from(stat.st_blksize).ok().filter(|&block| block > 0)?;
		let queued = usize::try_from(stat.st_size).ok()?;
		Some(block.saturating_sub(queued))
	}
}

#[cfg(all(test, unix))]
mod tests {
	use super::*;

	/// Reading a pipe on a current-thread runtime waits for its writer
	/// without holding the only thread.
	#[tokio::test(flavor = "current_thread")]
	async fn pipe_read_to_end_waits_for_a_later_writer() {
		let (reader, mut writer) = std::io::pipe().unwrap();
		let mut source = Source::inherited(&OpenFile::from(reader)).unwrap();
		let mut bytes = Vec::new();
		let read = source.read_to_end(&mut bytes, usize::MAX);
		let write = async {
			tokio::task::yield_now().await;
			writer.write_all(b"late").unwrap();
			drop(writer);
		};
		let (count, ()) = tokio::join!(read, write);
		assert_eq!(count.unwrap(), 4);
		assert_eq!(bytes, b"late");
	}

	/// Past the limit the read fails and keeps what fits.
	#[tokio::test(flavor = "current_thread")]
	async fn read_to_end_stops_at_the_limit() {
		let (reader, mut writer) = std::io::pipe().unwrap();
		writer.write_all(b"abcdef").unwrap();
		drop(writer);
		let mut source = Source::inherited(&OpenFile::from(reader)).unwrap();
		let mut bytes = Vec::new();
		let error = source.read_to_end(&mut bytes, 4).await.unwrap_err();
		assert_eq!(error.kind(), io::ErrorKind::OutOfMemory);
		assert_eq!(bytes, b"abcd");
	}

	/// A FIFO opens without a writer and reads what one sends later.
	#[tokio::test(flavor = "current_thread")]
	async fn fifo_opens_without_waiting_for_a_writer() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("fifo");
		let fs = pi_vfs::Fs::native();
		fs.make_node(&path, pi_vfs::NodeKind::Fifo, 0o600).await.unwrap();
		let mut source = Source::open(&fs, &path).await.unwrap();
		let mut bytes = Vec::new();
		let read = source.read_to_end(&mut bytes, usize::MAX);
		let write = async {
			tokio::task::yield_now().await;
			let mut writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
			writer.write_all(b"fifo").unwrap();
		};
		let (count, ()) = tokio::join!(read, write);
		assert_eq!(count.unwrap(), 4);
		assert_eq!(bytes, b"fifo");
	}
}

