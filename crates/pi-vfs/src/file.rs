//! Open file handles: host files and provider-owned handles.

#[cfg(unix)]
use std::time::Duration;
use std::{
	fmt,
	io::{self, Read, Seek, SeekFrom, Write},
	sync::Arc,
};

use async_trait::async_trait;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::{
	error::unsupported,
	metadata::Metadata,
	native,
	runtime::{CloseTicket, CloseTracker, Scope, block_on, offload, park_on},
	types::{FileId, FileTime, Permissions},
};

/// Chunk size for whole-file reads and copies through provider handles.
pub(crate) const COPY_CHUNK: usize = 64 * 1024;

/// A provider's open file.
///
/// The handle owns its cursor; every method takes `&self` because
/// [`File::try_clone`] shares one handle (and therefore one position) between
/// clones, like `dup`. [`FileHandle::close`] runs exactly once, when the last
/// clone is closed or dropped.
#[async_trait]
pub trait FileHandle: Send + Sync + fmt::Debug + 'static {
	/// Reads at the cursor; `Ok(0)` is end of file.
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize>;

	/// Writes at the cursor (at end of file for append handles).
	async fn write(&self, buf: &[u8]) -> io::Result<usize>;

	/// Moves the cursor; unseekable streams return an error.
	async fn seek(&self, pos: SeekFrom) -> io::Result<u64>;

	async fn metadata(&self) -> io::Result<Metadata>;

	/// Pushes buffered writes to the provider; errors must surface here.
	async fn flush(&self) -> io::Result<()> {
		Ok(())
	}

	async fn set_len(&self, _size: u64) -> io::Result<()> {
		Err(unsupported("set_len"))
	}

	async fn set_permissions(&self, _permissions: Permissions) -> io::Result<()> {
		Err(unsupported("set_permissions"))
	}

	async fn set_times(&self, _accessed: FileTime, _modified: FileTime) -> io::Result<()> {
		Err(unsupported("set_times"))
	}

	async fn sync_all(&self) -> io::Result<()> {
		self.flush().await
	}

	async fn sync_data(&self) -> io::Result<()> {
		self.sync_all().await
	}

	/// Whether another process holds a conflicting advisory write lock.
	async fn is_locked(&self) -> io::Result<bool> {
		Err(unsupported("lock query"))
	}

	/// Commits and releases the handle. Never cancelled.
	async fn close(&self) -> io::Result<()> {
		self.flush().await
	}
}

/// An open file: a host [`std::fs::File`] or a provider [`FileHandle`].
///
/// Implements [`Read`], [`Write`], and [`Seek`] (also for `&File`) plus
/// `*_async` equivalents. Synchronous I/O on provider handles is for blocking
/// workers and foreign threads; async code must use the `*_async` methods.
pub struct File {
	repr:        Repr,
	/// Cancellation of the facade that opened this host file: once it fires,
	/// reads fail with [`crate::cancelled`]. Provider files keep theirs in
	/// [`Shared`].
	read_cancel: Option<HostCancel>,
}

/// How reads of a host file opened through a cancellable facade observe its
/// token.
#[derive(Clone)]
struct HostCancel {
	token: CancellationToken,
	/// Reads of the file can block for as long as no data arrives (see
	/// [`reads_can_block`]): such a read first waits for readiness in short
	/// slices, checking the token.
	#[cfg(unix)]
	poll:  bool,
}

impl HostCancel {
	#[cfg_attr(not(unix), allow(clippy::missing_const_for_fn, reason = "const only off Unix"))]
	fn for_file(token: CancellationToken, file: &std::fs::File) -> Self {
		#[cfg(not(unix))]
		let _ = file;
		Self {
			token,
			// A failed `fstat` leaves reads as they were: unpolled.
			#[cfg(unix)]
			poll: file.metadata().is_ok_and(|meta| reads_can_block(&meta)),
		}
	}
}

/// How long one readiness wait lasts before cancellation is checked again.
#[cfg(unix)]
pub const POLL_SLICE: Duration = Duration::from_millis(100);

/// Whether one read of a host file with `meta` can block until data arrives,
/// so a cancellable read must first wait for readiness.
///
/// True for a pipe, FIFO, terminal, socket or device, but not for a regular
/// file or the null device. A read of the null device returns EOF at once,
/// yet `poll` never reports it readable on macOS and the BSDs, so a readiness
/// wait would last until cancellation.
#[cfg(unix)]
pub fn reads_can_block(meta: &std::fs::Metadata) -> bool {
	use std::os::unix::fs::{FileTypeExt, MetadataExt};
	let kind = meta.file_type();
	!(kind.is_file() || kind.is_char_device() && *NULL_DEVICE_RDEV == Some(meta.rdev()))
}

/// [`reads_can_block`] for an open descriptor; `true` when `fstat` fails.
#[cfg(unix)]
pub fn fd_reads_can_block(fd: std::os::fd::BorrowedFd<'_>) -> bool {
	use std::os::fd::AsRawFd;
	let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `stat` is valid for writes of one `struct stat`; `fd` is borrowed
	// from a live descriptor for the call.
	if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
		return true;
	}
	// SAFETY: a successful `fstat` filled the whole struct.
	let stat = unsafe { stat.assume_init() };
	let kind = stat.st_mode & libc::S_IFMT;
	#[allow(clippy::unnecessary_cast, reason = "`dev_t` is `i32` on macOS")]
	let rdev = stat.st_rdev as u64;
	!(kind == libc::S_IFREG || kind == libc::S_IFCHR && *NULL_DEVICE_RDEV == Some(rdev))
}

/// The device id of `/dev/null`; `None` when it cannot be stat'd, so no file
/// counts as the null device.
#[cfg(unix)]
static NULL_DEVICE_RDEV: std::sync::LazyLock<Option<u64>> = std::sync::LazyLock::new(|| {
	use std::os::unix::fs::MetadataExt;
	std::fs::metadata("/dev/null").ok().map(|meta| meta.rdev())
});

/// Waits until a read of `fd` would not block, checking `is_cancelled` every
/// [`POLL_SLICE`]; fails with [`crate::cancelled`] once it is.
#[cfg(unix)]
pub fn wait_readable(
	fd: std::os::fd::BorrowedFd<'_>,
	is_cancelled: impl Fn() -> bool,
) -> io::Result<()> {
	loop {
		if is_cancelled() {
			return Err(crate::cancelled());
		}
		match readable_within(fd, POLL_SLICE) {
			Ok(true) => return Ok(()),
			Ok(false) => {},
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
			Err(error) => return Err(error),
		}
	}
}

/// Waits up to `timeout` for a read of `fd` not to block; `false` once
/// `timeout` passed.
///
/// A read does not block once data, EOF or an error is pending. A zero
/// `timeout` checks without waiting. A signal ends the wait with
/// [`io::ErrorKind::Interrupted`].
///
/// This is `poll(POLLIN)`, except on macOS, where `poll` and kqueue report a
/// FIFO's data but never its end: once every writer has closed, a read returns
/// EOF at once, yet the FIFO never polls readable, so a builtin `cat < fifo`
/// waited until it was cancelled. `select` reports it.
#[cfg(unix)]
pub fn readable_within(fd: std::os::fd::BorrowedFd<'_>, timeout: Duration) -> io::Result<bool> {
	cfg_select! {
		target_os = "macos" => select_readable(fd, timeout),
		_ => poll_readable(fd, timeout),
	}
}

/// [`readable_within`] by `poll`.
#[cfg(all(unix, not(target_os = "macos")))]
fn poll_readable(fd: std::os::fd::BorrowedFd<'_>, timeout: Duration) -> io::Result<bool> {
	use std::os::fd::AsRawFd;
	let mut pfd = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
	// Rounded up, so a wait shorter than a millisecond does not spin.
	let timeout_ms = i32::try_from(timeout.as_micros().div_ceil(1000)).unwrap_or(i32::MAX);
	// SAFETY: one `pollfd` valid for the call; `fd` is borrowed from a live
	// descriptor for the whole call.
	match unsafe { libc::poll(&mut pfd, 1, timeout_ms) } {
		..0 => Err(io::Error::last_os_error()),
		ready => Ok(ready > 0),
	}
}

/// [`readable_within`] by `select`, in its `_DARWIN_UNLIMITED_SELECT` form:
/// the plain one fails with `EINVAL` for a descriptor at or above
/// `FD_SETSIZE`, which a busy host process reaches.
#[cfg(target_os = "macos")]
fn select_readable(fd: std::os::fd::BorrowedFd<'_>, timeout: Duration) -> io::Result<bool> {
	use std::os::fd::AsRawFd;

	unsafe extern "C" {
		/// `select` for sets of any length: a set is a bitmap of 32-bit words,
		/// descriptor `n` at bit `n % 32` of word `n / 32`, and the call reads
		/// as many words as `nfds` bits need.
		#[link_name = "select$DARWIN_EXTSN"]
		fn select_unlimited(
			nfds: libc::c_int,
			readfds: *mut u32,
			writefds: *mut u32,
			errorfds: *mut u32,
			timeout: *mut libc::timeval,
		) -> libc::c_int;
	}
	/// Words of a set holding `FD_SETSIZE` (1024) descriptors.
	const INLINE_WORDS: usize = 32;
	/// The longest wait `select` accepts; above it, it fails with `EINVAL`.
	const MAX_SECS: u64 = 100_000_000;

	let raw = fd.as_raw_fd();
	// A borrowed descriptor is never negative.
	let index = raw.unsigned_abs() as usize;
	let (word, bit) = (index / 32, index % 32);
	let mut inline = [0_u32; INLINE_WORDS];
	let mut heap = Vec::new();
	let set = if word < INLINE_WORDS {
		&mut inline[..=word]
	} else {
		heap.resize(word + 1, 0);
		heap.as_mut_slice()
	};
	set[word] = 1 << bit;
	let mut timeval = libc::timeval {
		tv_sec:  libc::time_t::try_from(timeout.as_secs().min(MAX_SECS)).unwrap_or(libc::time_t::MAX),
		// Below one million, so it fits.
		tv_usec: timeout.subsec_micros().cast_signed(),
	};
	// SAFETY: `set` holds the `raw + 1` bits `nfds` names, the other sets are
	// absent, and `timeval` is valid for the call; `fd` is borrowed from a live
	// descriptor for the whole call.
	let ready = unsafe {
		select_unlimited(
			raw + 1,
			set.as_mut_ptr(),
			std::ptr::null_mut(),
			std::ptr::null_mut(),
			&mut timeval,
		)
	};
	if ready < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(ready > 0)
	}
}

/// Bytes one [`HostReader::read_to_end`] step reads into, at most; the
/// buffer's spare capacity is zeroed one step at a time, never all at once.
const READ_STEP: usize = 256 * 1024;

/// A host file whose reads first check the opening facade's cancellation, so
/// std's read loops (`read_to_end`) stop as well as single reads.
struct HostReader<'a> {
	file:   &'a std::fs::File,
	cancel: &'a HostCancel,
}

impl HostReader<'_> {
	fn check(&self) -> io::Result<()> {
		if self.cancel.token.is_cancelled() {
			Err(crate::cancelled())
		} else {
			Ok(())
		}
	}

	/// Waits until a read would not block, checking the token between slices.
	/// A descriptor in non-blocking mode (`dd iflag=nonblock`) does not wait:
	/// its read must return at once, and on Linux a FIFO with no writer
	/// reports no readiness although such a read returns EOF.
	#[cfg(unix)]
	fn wait_readable(&self) -> io::Result<()> {
		use std::os::fd::{AsFd, AsRawFd};
		// SAFETY: the descriptor belongs to the file borrowed for this call.
		let flags = unsafe { libc::fcntl(self.file.as_raw_fd(), libc::F_GETFL) };
		if flags >= 0 && flags & libc::O_NONBLOCK != 0 {
			return Ok(());
		}
		wait_readable(self.file.as_fd(), || self.cancel.token.is_cancelled())
	}

	/// Bytes left between the file position and the end, when the file has a
	/// length (`None` for pipes and devices, which report 0).
	fn remaining(&self) -> Option<usize> {
		let len = self.file.metadata().ok()?.len();
		let position = host(self.file).stream_position().ok()?;
		usize::try_from(len.saturating_sub(position))
			.ok()
			.filter(|&n| n > 0)
	}
}

impl Read for HostReader<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		self.check()?;
		#[cfg(unix)]
		if self.cancel.poll {
			self.wait_readable()?;
		}
		host(self.file).read(buf)
	}

	/// Like std's `impl Read for &File`, reserves the bytes left in the file
	/// first, so a whole-file read takes one allocation of the right size
	/// instead of growing by doubling.
	fn read_to_end(&mut self, buf: &mut Vec<u8>) -> io::Result<usize> {
		if let Some(remaining) = self.remaining() {
			buf.try_reserve_exact(remaining)
				.map_err(|_| io::Error::from(io::ErrorKind::OutOfMemory))?;
		}
		let start = buf.len();
		loop {
			if buf.len() == buf.capacity() {
				// A full buffer may sit exactly at EOF: probe before growing it.
				let mut probe = [0; 32];
				match self.read(&mut probe) {
					Ok(0) => return Ok(buf.len() - start),
					Ok(n) => buf.extend_from_slice(&probe[..n]),
					Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
					Err(error) => return Err(error),
				}
				continue;
			}
			let filled = buf.len();
			let step = (buf.capacity() - filled).min(READ_STEP);
			buf.resize(filled + step, 0);
			match self.read(&mut buf[filled..]) {
				Ok(0) => {
					buf.truncate(filled);
					return Ok(filled - start);
				},
				Ok(n) => buf.truncate(filled + n),
				Err(error) if error.kind() == io::ErrorKind::Interrupted => buf.truncate(filled),
				Err(error) => {
					buf.truncate(filled);
					return Err(error);
				},
			}
		}
	}

	fn read_to_string(&mut self, buf: &mut String) -> io::Result<usize> {
		let mut bytes = Vec::new();
		self.read_to_end(&mut bytes)?;
		append_utf8(buf, bytes)
	}
}

enum Repr {
	Native(std::fs::File),
	Virtual(Arc<Shared>),
}

struct Shared {
	/// `None` only after the handle has been closed.
	handle:  Option<Arc<dyn FileHandle>>,
	runtime: Option<Handle>,
	cancel:  Option<CancellationToken>,
	closes:  Option<Arc<CloseTracker>>,
}

impl Shared {
	fn handle(&self) -> &dyn FileHandle {
		match &self.handle {
			Some(handle) => &**handle,
			None => unreachable!("provider file handle used after close"),
		}
	}

	async fn guard<T>(&self, fut: impl Future<Output = io::Result<T>> + Send) -> io::Result<T> {
		Scope::guard(self.cancel.as_ref(), fut).await
	}

	fn run<T>(&self, fut: impl Future<Output = io::Result<T>>) -> io::Result<T> {
		block_on(self.runtime.as_ref(), Scope::guard(self.cancel.as_ref(), fut))
	}
}

impl Drop for Shared {
	fn drop(&mut self) {
		let Some(handle) = self.handle.take() else {
			return;
		};
		// Never block here: a drop may run on a runtime thread whose reactor the
		// provider needs. Closes go to the runtime and are tracked for
		// `drain_closes`; only a thread with no runtime at all closes inline.
		if let Some(runtime) = Handle::try_current().ok().or_else(|| self.runtime.clone()) {
			let ticket = CloseTicket::new(self.closes.clone());
			runtime.spawn(async move {
				let result = handle.close().await;
				ticket.finish(result);
			});
		} else {
			let result = park_on(handle.close());
			if let Some(closes) = &self.closes {
				closes.record(result);
			}
		}
	}
}

impl fmt::Debug for File {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match &self.repr {
			Repr::Native(file) => f.debug_tuple("File::Native").field(file).finish(),
			Repr::Virtual(shared) => match &shared.handle {
				Some(handle) => f.debug_tuple("File::Virtual").field(handle).finish(),
				None => f.write_str("File::Virtual(<closed>)"),
			},
		}
	}
}

impl From<std::fs::File> for File {
	fn from(file: std::fs::File) -> Self {
		Self { repr: Repr::Native(file), read_cancel: None }
	}
}

/// `&std::fs::File` implements the std I/O traits; returning it by value
/// gives the method call a mutable receiver without `mut` bindings.
const fn host(file: &std::fs::File) -> &std::fs::File {
	file
}

async fn read_to_end_handle(handle: &dyn FileHandle, buf: &mut Vec<u8>) -> io::Result<usize> {
	let start = buf.len();
	let mut chunk = vec![0; COPY_CHUNK];
	loop {
		match handle.read(&mut chunk).await {
			Ok(0) => return Ok(buf.len() - start),
			Ok(n) => buf.extend_from_slice(&chunk[..n]),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(err),
		}
	}
}

async fn write_all_handle(handle: &dyn FileHandle, mut buf: &[u8]) -> io::Result<()> {
	while !buf.is_empty() {
		match handle.write(buf).await {
			Ok(0) => {
				return Err(io::Error::new(io::ErrorKind::WriteZero, "failed to write whole buffer"));
			},
			Ok(n) => buf = &buf[n..],
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(err),
		}
	}
	Ok(())
}

fn append_utf8(buf: &mut String, bytes: Vec<u8>) -> io::Result<usize> {
	let text = String::from_utf8(bytes).map_err(|_| {
		io::Error::new(io::ErrorKind::InvalidData, "stream did not contain valid UTF-8")
	})?;
	buf.push_str(&text);
	Ok(text.len())
}

impl File {
	/// Wraps a provider handle. The current tokio runtime (if any) is captured
	/// to drive synchronous I/O and deferred closes from foreign threads.
	pub fn from_handle(handle: impl FileHandle) -> Self {
		Self::from_arc(Arc::new(handle))
	}

	/// Wraps a shared provider handle; see [`File::from_handle`].
	pub fn from_arc(handle: Arc<dyn FileHandle>) -> Self {
		Self {
			repr:        Repr::Virtual(Arc::new(Shared {
				handle:  Some(handle),
				runtime: Handle::try_current().ok(),
				cancel:  None,
				closes:  None,
			})),
			read_cancel: None,
		}
	}

	/// Attaches a facade's cancellation token and close tracker to a freshly
	/// opened file. A host file only takes the token, for its reads.
	pub(crate) fn bind(mut self, scope: &Scope) -> Self {
		if let Repr::Native(file) = &self.repr {
			self.read_cancel = scope
				.cancel
				.clone()
				.map(|token| HostCancel::for_file(token, file));
			return self;
		}
		if let Repr::Virtual(shared) = &mut self.repr
			&& let Some(shared) = Arc::get_mut(shared)
		{
			if shared.cancel.is_none() {
				shared.cancel.clone_from(&scope.cancel);
			}
			if shared.closes.is_none() {
				shared.closes.clone_from(&scope.closes);
			}
		}
		self
	}

	/// [`Self::bind`] for a host file whose type the opener already knows
	/// (`poll`: not a regular file), so binding takes no `fstat`.
	#[cfg(unix)]
	pub(crate) fn bind_host(mut self, token: CancellationToken, poll: bool) -> Self {
		if matches!(self.repr, Repr::Native(_)) {
			self.read_cancel = Some(HostCancel { token, poll });
		}
		self
	}

	/// The host file, for fd-level fast paths (mmap, `lseek`, ...).
	pub const fn native(&self) -> Option<&std::fs::File> {
		match &self.repr {
			Repr::Native(file) => Some(file),
			Repr::Virtual(_) => None,
		}
	}

	pub fn into_native(self) -> Result<std::fs::File, Self> {
		match self.repr {
			Repr::Native(file) => Ok(file),
			repr @ Repr::Virtual(_) => Err(Self { repr, read_cancel: self.read_cancel }),
		}
	}

	pub const fn is_native(&self) -> bool {
		matches!(self.repr, Repr::Native(_))
	}

	/// A second handle sharing this one's position (`dup`).
	pub fn try_clone(&self) -> io::Result<Self> {
		Ok(Self {
			repr:        match &self.repr {
				Repr::Native(file) => Repr::Native(file.try_clone()?),
				Repr::Virtual(shared) => Repr::Virtual(Arc::clone(shared)),
			},
			read_cancel: self.read_cancel.clone(),
		})
	}

	/// Whether the facade that opened this file has been cancelled. For
	/// callers that work on the descriptor directly (`splice`, `mmap`) and so
	/// bypass the reads that fail once it is.
	pub fn is_cancelled(&self) -> bool {
		match &self.repr {
			Repr::Native(_) => self
				.read_cancel
				.as_ref()
				.is_some_and(|cancel| cancel.token.is_cancelled()),
			Repr::Virtual(shared) => shared
				.cancel
				.as_ref()
				.is_some_and(CancellationToken::is_cancelled),
		}
	}

	/// Reads the host file `file` (this handle's own), through [`HostReader`]
	/// when the facade that opened it is cancellable.
	fn read_host<T>(
		&self,
		file: &std::fs::File,
		read: impl FnOnce(&mut dyn Read) -> io::Result<T>,
	) -> io::Result<T> {
		match &self.read_cancel {
			Some(cancel) => read(&mut HostReader { file, cancel }),
			None => read(&mut host(file)),
		}
	}

	pub fn metadata(&self) -> io::Result<Metadata> {
		match &self.repr {
			Repr::Native(file) => native::file_metadata(file),
			Repr::Virtual(shared) => shared.run(shared.handle().metadata()),
		}
	}

	pub fn set_len(&self, size: u64) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.set_len(size),
			Repr::Virtual(shared) => shared.run(shared.handle().set_len(size)),
		}
	}

	pub fn set_permissions(&self, permissions: Permissions) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => native::file_set_permissions(file, permissions),
			Repr::Virtual(shared) => shared.run(shared.handle().set_permissions(permissions)),
		}
	}

	/// `futimens`: [`FileTime::Omit`] leaves a timestamp, [`FileTime::Now`]
	/// uses the filesystem clock.
	pub fn set_times(
		&self,
		accessed: impl Into<FileTime>,
		modified: impl Into<FileTime>,
	) -> io::Result<()> {
		let (accessed, modified) = (accessed.into(), modified.into());
		match &self.repr {
			Repr::Native(file) => native::file_set_times(file, accessed, modified),
			Repr::Virtual(shared) => shared.run(shared.handle().set_times(accessed, modified)),
		}
	}

	pub fn sync_all(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.sync_all(),
			Repr::Virtual(shared) => shared.run(shared.handle().sync_all()),
		}
	}

	pub fn sync_data(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.sync_data(),
			Repr::Virtual(shared) => shared.run(shared.handle().sync_data()),
		}
	}

	/// Identity of the open object; `Unsupported` when the provider has none.
	pub fn file_id(&self) -> io::Result<FileId> {
		match &self.repr {
			Repr::Native(file) => native::file_id_of(file),
			Repr::Virtual(_) => self
				.metadata()?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
		}
	}

	/// Whether another process holds a conflicting advisory write lock
	/// (`F_GETLK`).
	pub fn is_locked(&self) -> io::Result<bool> {
		match &self.repr {
			Repr::Native(file) => native::file_is_locked(file),
			Repr::Virtual(shared) => shared.run(shared.handle().is_locked()),
		}
	}

	/// Closes this handle and reports errors that dropping would lose. The last
	/// clone closes the provider handle; earlier clones only flush it.
	pub fn close(self) -> io::Result<()> {
		match self.repr {
			Repr::Native(file) => native::close(file),
			Repr::Virtual(shared) => match Arc::try_unwrap(shared) {
				Ok(mut shared) => {
					let handle = shared.handle.take();
					match handle {
						Some(handle) => block_on(shared.runtime.as_ref(), handle.close()),
						None => Ok(()),
					}
				},
				Err(shared) => shared.run(shared.handle().flush()),
			},
		}
	}

	/// A synchronous read that also fails with [`crate::cancelled`] once
	/// `cancel` fires, for a reader whose cancellation is narrower than that of
	/// the facade that opened the file (a `timeout` operand reading a redirect
	/// its outer command opened). A provider read is raced against `cancel`; a
	/// host read checks it first, then reads as [`Read::read`] does.
	pub fn read_until_cancelled(
		&self,
		buf: &mut [u8],
		cancel: &CancellationToken,
	) -> io::Result<usize> {
		if cancel.is_cancelled() {
			return Err(crate::cancelled());
		}
		match &self.repr {
			Repr::Native(file) => self.read_host(file, |reader| reader.read(buf)),
			Repr::Virtual(shared) => shared.run(Scope::guard(Some(cancel), shared.handle().read(buf))),
		}
	}

	pub async fn read_async(&self, buf: &mut [u8]) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => self.read_host(file, |reader| reader.read(buf)),
			Repr::Virtual(shared) => shared.guard(shared.handle().read(buf)).await,
		}
	}

	pub async fn write_async(&self, buf: &[u8]) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).write(buf),
			Repr::Virtual(shared) => shared.guard(shared.handle().write(buf)).await,
		}
	}

	pub async fn write_all_async(&self, buf: &[u8]) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => host(file).write_all(buf),
			Repr::Virtual(shared) => shared.guard(write_all_handle(shared.handle(), buf)).await,
		}
	}

	/// A host file bound to a token is read off the runtime worker (see
	/// [`offload`]): the read never yields while it reads (`/dev/zero` never
	/// ends) or waits for data, so on the worker it would hold the very task
	/// that cancels it.
	pub async fn read_to_end_async(&self, buf: &mut Vec<u8>) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => match &self.read_cancel {
				Some(cancel) => {
					let (file, cancel) = (file.try_clone()?, cancel.clone());
					let (bytes, result) = offload(move || {
						let mut bytes = Vec::new();
						let result = HostReader { file: &file, cancel: &cancel }.read_to_end(&mut bytes);
						Ok((bytes, result))
					})
					.await?;
					if buf.is_empty() {
						*buf = bytes;
					} else {
						buf.extend_from_slice(&bytes);
					}
					result
				},
				None => host(file).read_to_end(buf),
			},
			Repr::Virtual(shared) => shared.guard(read_to_end_handle(shared.handle(), buf)).await,
		}
	}

	/// See [`Self::read_to_end_async`].
	pub async fn read_to_string_async(&self, buf: &mut String) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) if self.read_cancel.is_none() => host(file).read_to_string(buf),
			_ => {
				let mut bytes = Vec::new();
				self.read_to_end_async(&mut bytes).await?;
				append_utf8(buf, bytes)
			},
		}
	}

	pub async fn flush_async(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(_) => Ok(()),
			Repr::Virtual(shared) => shared.guard(shared.handle().flush()).await,
		}
	}

	pub async fn seek_async(&self, pos: SeekFrom) -> io::Result<u64> {
		match &self.repr {
			Repr::Native(file) => host(file).seek(pos),
			Repr::Virtual(shared) => shared.guard(shared.handle().seek(pos)).await,
		}
	}

	pub async fn metadata_async(&self) -> io::Result<Metadata> {
		match &self.repr {
			Repr::Native(file) => native::file_metadata(file),
			Repr::Virtual(shared) => shared.guard(shared.handle().metadata()).await,
		}
	}

	pub async fn set_len_async(&self, size: u64) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.set_len(size),
			Repr::Virtual(shared) => shared.guard(shared.handle().set_len(size)).await,
		}
	}

	pub async fn set_permissions_async(&self, permissions: Permissions) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => native::file_set_permissions(file, permissions),
			Repr::Virtual(shared) => {
				shared
					.guard(shared.handle().set_permissions(permissions))
					.await
			},
		}
	}

	pub async fn set_times_async(
		&self,
		accessed: impl Into<FileTime>,
		modified: impl Into<FileTime>,
	) -> io::Result<()> {
		let (accessed, modified) = (accessed.into(), modified.into());
		match &self.repr {
			Repr::Native(file) => native::file_set_times(file, accessed, modified),
			Repr::Virtual(shared) => {
				shared
					.guard(shared.handle().set_times(accessed, modified))
					.await
			},
		}
	}

	pub async fn sync_all_async(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.sync_all(),
			Repr::Virtual(shared) => shared.guard(shared.handle().sync_all()).await,
		}
	}

	pub async fn sync_data_async(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.sync_data(),
			Repr::Virtual(shared) => shared.guard(shared.handle().sync_data()).await,
		}
	}

	pub async fn is_locked_async(&self) -> io::Result<bool> {
		match &self.repr {
			Repr::Native(file) => native::file_is_locked(file),
			Repr::Virtual(shared) => shared.guard(shared.handle().is_locked()).await,
		}
	}

	/// Async [`File::close`].
	pub async fn close_async(self) -> io::Result<()> {
		match self.repr {
			Repr::Native(file) => native::close(file),
			Repr::Virtual(shared) => match Arc::try_unwrap(shared) {
				Ok(mut shared) => match shared.handle.take() {
					Some(handle) => handle.close().await,
					None => Ok(()),
				},
				Err(shared) => shared.guard(shared.handle().flush()).await,
			},
		}
	}
}

impl Read for &File {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => self.read_host(file, |reader| reader.read(buf)),
			Repr::Virtual(shared) => shared.run(shared.handle().read(buf)),
		}
	}

	fn read_to_end(&mut self, buf: &mut Vec<u8>) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => self.read_host(file, |reader| reader.read_to_end(buf)),
			Repr::Virtual(shared) => shared.run(read_to_end_handle(shared.handle(), buf)),
		}
	}

	fn read_to_string(&mut self, buf: &mut String) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => self.read_host(file, |reader| reader.read_to_string(buf)),
			Repr::Virtual(_) => {
				let mut bytes = Vec::new();
				self.read_to_end(&mut bytes)?;
				append_utf8(buf, bytes)
			},
		}
	}
}

impl Write for &File {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).write(buf),
			Repr::Virtual(shared) => shared.run(shared.handle().write(buf)),
		}
	}

	fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => host(file).write_all(buf),
			Repr::Virtual(shared) => shared.run(write_all_handle(shared.handle(), buf)),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(_) => Ok(()),
			Repr::Virtual(shared) => shared.run(shared.handle().flush()),
		}
	}
}

impl Seek for &File {
	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		match &self.repr {
			Repr::Native(file) => host(file).seek(pos),
			Repr::Virtual(shared) => shared.run(shared.handle().seek(pos)),
		}
	}
}

impl Read for File {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		(&*self).read(buf)
	}

	fn read_to_end(&mut self, buf: &mut Vec<u8>) -> io::Result<usize> {
		(&*self).read_to_end(buf)
	}

	fn read_to_string(&mut self, buf: &mut String) -> io::Result<usize> {
		(&*self).read_to_string(buf)
	}
}

impl Write for File {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		(&*self).write(buf)
	}

	fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
		(&*self).write_all(buf)
	}

	fn flush(&mut self) -> io::Result<()> {
		(&*self).flush()
	}
}

impl Seek for File {
	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		(&*self).seek(pos)
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::os::fd::AsFd;

	use super::*;

	/// The null device reads as EOF at once, but `poll` never reports it
	/// readable on macOS and the BSDs, so a cancellable read of it must not
	/// wait for readiness: there `timeout 1 cat /dev/null` waited for the limit
	/// and exited 124. A file bound to a token after its open and one the
	/// scoped open typed both read it without polling; `/dev/zero` still polls.
	#[test]
	fn cancellable_reads_of_the_null_device_never_poll() {
		let null = std::fs::File::open("/dev/null").unwrap();
		let zero = std::fs::File::open("/dev/zero").unwrap();
		let token = CancellationToken::new();
		assert!(!HostCancel::for_file(token.clone(), &null).poll, "bound after the open");
		assert!(HostCancel::for_file(token.clone(), &zero).poll);

		let opened = crate::BlockingFs::native()
			.with_cancellation(token)
			.open("/dev/null")
			.unwrap();
		let poll = opened.read_cancel.as_ref().map(|cancel| cancel.poll);
		assert_eq!(poll, Some(false), "typed by the scoped open");
	}

	/// Of the null device, `/dev/zero`, a regular file and a pipe, only the
	/// reads of `/dev/zero` and the pipe can block, by metadata and by
	/// descriptor alike.
	#[test]
	fn readiness_predicates_exempt_regular_files_and_the_null_device() {
		let null = std::fs::File::open("/dev/null").unwrap();
		let zero = std::fs::File::open("/dev/zero").unwrap();
		let regular = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
		let (pipe, _writer) = std::io::pipe().unwrap();

		for (file, blocks) in [(&null, false), (&regular, false), (&zero, true)] {
			assert_eq!(reads_can_block(&file.metadata().unwrap()), blocks, "{file:?}");
			assert_eq!(fd_reads_can_block(file.as_fd()), blocks, "{file:?}");
		}
		assert!(fd_reads_can_block(pipe.as_fd()));
	}
}
