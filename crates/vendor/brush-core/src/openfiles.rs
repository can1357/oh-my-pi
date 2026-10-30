//! Managing files open within a shell instance.

use std::{collections::HashMap, io::IsTerminal, process::Stdio};

use crate::{ShellFd, error, ioutils, sys};

/// A trait representing a stream that can be read from and written to.
/// This is used for custom stream implementations in `OpenFile`.
///
/// Types that implement this trait are expected to be cloneable via the
/// `clone_box` function.
pub trait Stream: std::io::Read + std::io::Write + Send + Sync {
	/// Clones the stream into a boxed trait object.
	fn clone_box(&self) -> Box<dyn Stream>;

	/// Converts the stream into an `OwnedFd`. Returns an error if the operation
	/// is not supported or if it fails.
	#[cfg(unix)]
	fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, error::Error>;

	/// Borrows the stream as a `BorrowedFd`. Returns an error if the operation
	/// is not supported or if it fails.
	#[cfg(unix)]
	fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, error::Error>;

	/// Whether this stream's `read` and `write` can wait without end for a peer
	/// that may never come — a pipe with no writer, a socket, a terminal.
	///
	/// A stream that waits only on storage, or not at all, may answer `false`;
	/// its I/O then runs in place, on the caller's thread. The default is the
	/// safe answer: a stream that can wait and is read in place on a runtime
	/// worker takes that worker from every other task on the runtime, with no
	/// way to get it back. Refusing [`Stream::try_borrow_as_fd`] says nothing
	/// about this — a stream with no descriptor to show can still be a pipe.
	///
	/// Answering `false` is a promise the shell cannot check, and the cost of
	/// breaking it is measured: a stream that answered `false` and then waited
	/// held the only worker until an outside rescue at 400 ms, and one that
	/// answered honestly but took 250 ms in a single `read` delayed a 20 ms
	/// timer to 250 ms. Answer `false` only where a call returns in a time you
	/// would be willing to block a scheduler for.
	fn may_wait_for_peer(&self) -> bool {
		true
	}
}

/// Represents a file open in a shell context.
pub enum OpenFile {
	/// The original standard input this process was started with.
	Stdin(std::io::Stdin),
	/// The original standard output this process was started with.
	Stdout(std::io::Stdout),
	/// The original standard error this process was started with.
	Stderr(std::io::Stderr),
	/// A file open for reading or writing.
	File(std::fs::File),
	/// A read end of a pipe.
	PipeReader(std::io::PipeReader),
	/// A write end of a pipe.
	PipeWriter(std::io::PipeWriter),
	/// A custom stream.
	Stream(Box<dyn Stream>),
	/// A file owned by an injected virtual filesystem provider. Handles the
	/// provider reports as native are unwrapped into [`OpenFile::File`] on
	/// conversion, so this variant never carries a native descriptor.
	Vfs(pi_vfs::File),
}

#[cfg(feature = "serde")]
impl serde::Serialize for OpenFile {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: serde::Serializer,
	{
		match self {
			Self::Stdin(_) => serializer.serialize_str("stdin"),
			Self::Stdout(_) => serializer.serialize_str("stdout"),
			Self::Stderr(_) => serializer.serialize_str("stderr"),
			Self::File(_) => serializer.serialize_str("file"),
			Self::PipeReader(_) => serializer.serialize_str("pipe_reader"),
			Self::PipeWriter(_) => serializer.serialize_str("pipe_writer"),
			Self::Stream(_) => serializer.serialize_str("stream"),
			Self::Vfs(_) => serializer.serialize_str("vfs"),
		}
	}
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for OpenFile {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		match String::deserialize(deserializer)?.as_str() {
			"stdin" => return Ok(std::io::stdin().into()),
			"stdout" => return Ok(std::io::stdout().into()),
			"stderr" => return Ok(std::io::stderr().into()),
			"file" => (),
			"pipe_reader" => (),
			"pipe_writer" => (),
			"stream" => (),
			"vfs" => (),
			_ => return Err(serde::de::Error::custom("invalid open file")),
		}

		// TODO(serde): Figure out something better to do with open pipes and files.
		null().map_err(serde::de::Error::custom)
	}
}

/// Returns an open file that will discard all I/O.
pub fn null() -> Result<OpenFile, error::Error> {
	let file = sys::fs::open_null_file()?;
	Ok(OpenFile::File(file))
}

impl Clone for OpenFile {
	fn clone(&self) -> Self {
		// If we fail to clone the open file for any reason, we return a special file
		// that discards all I/O. This allows us to avoid fatally erroring out.
		self.try_clone().unwrap_or_else(|_err| {
			ioutils::FailingReaderWriter::new("failed to duplicate open file").into()
		})
	}
}

impl std::fmt::Display for OpenFile {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Stdin(_) => write!(f, "stdin"),
			Self::Stdout(_) => write!(f, "stdout"),
			Self::Stderr(_) => write!(f, "stderr"),
			Self::File(_) => write!(f, "file"),
			Self::PipeReader(_) => write!(f, "pipe reader"),
			Self::PipeWriter(_) => write!(f, "pipe writer"),
			Self::Stream(_) => write!(f, "stream"),
			Self::Vfs(_) => write!(f, "virtual file"),
		}
	}
}

impl OpenFile {
	/// Tries to duplicate the open file.
	pub fn try_clone(&self) -> Result<Self, std::io::Error> {
		let result = match self {
			Self::Stdin(_) => std::io::stdin().into(),
			Self::Stdout(_) => std::io::stdout().into(),
			Self::Stderr(_) => std::io::stderr().into(),
			Self::File(f) => f.try_clone()?.into(),
			Self::PipeReader(f) => f.try_clone()?.into(),
			Self::PipeWriter(f) => f.try_clone()?.into(),
			Self::Stream(s) => Self::Stream(s.clone_box()),
			Self::Vfs(f) => Self::Vfs(f.try_clone()?),
		};

		Ok(result)
	}

	/// Returns the virtual filesystem handle backing this open file, if any.
	pub const fn as_vfs(&self) -> Option<&pi_vfs::File> {
		match self {
			Self::Vfs(file) => Some(file),
			_ => None,
		}
	}

	/// Converts the open file into an `OwnedFd`.
	#[cfg(unix)]
	pub(crate) fn try_clone_to_owned(self) -> Result<std::os::fd::OwnedFd, error::Error> {
		use std::os::fd::AsFd as _;

		match self {
			Self::Stdin(f) => Ok(f.as_fd().try_clone_to_owned()?),
			Self::Stdout(f) => Ok(f.as_fd().try_clone_to_owned()?),
			Self::Stderr(f) => Ok(f.as_fd().try_clone_to_owned()?),
			Self::File(f) => Ok(f.into()),
			Self::PipeReader(r) => Ok(std::os::fd::OwnedFd::from(r)),
			Self::PipeWriter(w) => Ok(std::os::fd::OwnedFd::from(w)),
			Self::Stream(s) => s.try_clone_to_owned(),
			Self::Vfs(_) => Err(error::ErrorKind::VirtualFileHasNoNativeFd.into()),
		}
	}

	/// Borrows the open file as a `BorrowedFd`.
	///
	/// # Errors
	///
	/// Returns an error if the operation is not supported for the underlying
	/// file type.
	#[cfg(unix)]
	pub fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, error::Error> {
		use std::os::fd::AsFd as _;

		match self {
			Self::Stdin(f) => Ok(f.as_fd()),
			Self::Stdout(f) => Ok(f.as_fd()),
			Self::Stderr(f) => Ok(f.as_fd()),
			Self::File(f) => Ok(f.as_fd()),
			Self::PipeReader(r) => Ok(r.as_fd()),
			Self::PipeWriter(w) => Ok(w.as_fd()),
			Self::Stream(s) => s.try_borrow_as_fd(),
			Self::Vfs(_) => Err(error::ErrorKind::VirtualFileHasNoNativeFd.into()),
		}
	}

	pub(crate) fn into_stdio(self) -> Result<Stdio, error::Error> {
		#[cfg(unix)]
		{
			let owned_fd = self.try_clone_to_owned()?;
			Ok(Stdio::from(std::fs::File::from(owned_fd)))
		}

		#[cfg(not(unix))]
		{
			let stdio = match self {
				Self::Stdin(_) => Stdio::inherit(),
				Self::Stdout(_) => Stdio::inherit(),
				Self::Stderr(_) => Stdio::inherit(),
				Self::File(f) => f.into(),
				Self::PipeReader(f) => f.into(),
				Self::PipeWriter(f) => f.into(),
				Self::Stream(_) => return Err(error::ErrorKind::CannotConvertToNativeFd.into()),
				Self::Vfs(_) => return Err(error::ErrorKind::VirtualFileHasNoNativeFd.into()),
			};
			Ok(stdio)
		}
	}

	pub(crate) async fn is_dir(&self) -> bool {
		match self {
			Self::Stdin(_) | Self::Stdout(_) | Self::Stderr(_) => false,
			Self::File(file) => file.metadata().is_ok_and(|m| m.is_dir()),
			Self::Vfs(file) => file.metadata_async().await.is_ok_and(|m| m.is_dir()),
			Self::PipeReader(_) | Self::PipeWriter(_) | Self::Stream(_) => false,
		}
	}

	/// Reads from the open file without blocking the async runtime on a
	/// virtual filesystem provider. Other kinds read as [`std::io::Read`] does.
	///
	/// # Errors
	///
	/// Returns the underlying read error.
	pub async fn read_async(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		match self {
			Self::Vfs(file) => file.read_async(buf).await,
			other => std::io::Read::read(other, buf),
		}
	}

	/// Reads the rest of the open file into `buf`, awaiting virtual filesystem
	/// providers instead of blocking the async runtime on them.
	///
	/// # Errors
	///
	/// Returns the underlying read error.
	pub async fn read_to_end_async(&mut self, buf: &mut Vec<u8>) -> std::io::Result<usize> {
		match self {
			Self::Vfs(file) => file.read_to_end_async(buf).await,
			other => std::io::Read::read_to_end(other, buf),
		}
	}

	/// Writes all of `buf`, awaiting virtual filesystem providers instead of
	/// blocking the async runtime on them. Other kinds write as
	/// [`std::io::Write::write_all`] does.
	///
	/// # Errors
	///
	/// Returns the underlying write error.
	pub async fn write_all_async(&mut self, buf: &[u8]) -> std::io::Result<()> {
		match self {
			Self::Vfs(file) => file.write_all_async(buf).await,
			other => std::io::Write::write_all(other, buf),
		}
	}

	/// Flushes the open file, awaiting virtual filesystem providers instead of
	/// blocking the async runtime on them.
	///
	/// # Errors
	///
	/// Returns the underlying flush error.
	pub async fn flush_async(&mut self) -> std::io::Result<()> {
		match self {
			Self::Vfs(file) => file.flush_async().await,
			other => std::io::Write::flush(other),
		}
	}

	/// Checks if the open file is associated with a terminal.
	///
	/// A custom stream that wraps a real descriptor (a guard around a terminal
	/// fd, say) reports what that descriptor is; streams without one are never
	/// terminals.
	pub fn is_terminal(&self) -> bool {
		match self {
			Self::Stdin(f) => f.is_terminal(),
			Self::Stdout(f) => f.is_terminal(),
			Self::Stderr(f) => f.is_terminal(),
			Self::File(f) => f.is_terminal(),
			Self::PipeReader(_) | Self::PipeWriter(_) => false,
			#[cfg(unix)]
			Self::Stream(s) => s.try_borrow_as_fd().is_ok_and(|fd| fd.is_terminal()),
			#[cfg(not(unix))]
			Self::Stream(_) => false,
			Self::Vfs(_) => false,
		}
	}

	/// Reports whether this handle's I/O awaits rather than parking the thread
	/// that runs it.
	///
	/// Only a provider-backed virtual file does; every other variant reads and
	/// writes with blocking `std::io`. Handles a provider reports as native are
	/// unwrapped into [`OpenFile::File`] on conversion, so `Vfs` is exactly the
	/// awaiting set.
	pub const fn is_virtual(&self) -> bool {
		matches!(self, Self::Vfs(_))
	}
}

/// How much a streaming copy moves between a read and a write.
const COPY_CHUNK_BYTES: usize = 64 * 1024;

/// One end of a copy, classified by what its I/O waits for.
///
/// Nothing here reaches around [`OpenFile`] to a raw descriptor. Every read and
/// write goes through the handle's own [`std::io::Read`] and
/// [`std::io::Write`], so a handle that buffers (`std::io::Stdin` holds a line
/// of input) or transforms (a [`Stream`] may) keeps its contract; and no
/// descriptor's status flags are ever changed, so nothing a copy does is
/// visible through a descriptor duplicated from the same `open` — a child
/// process holding the shell's standard input among them.
enum CopySide {
	/// A provider-backed file. Its `*_async` methods await.
	Awaits(OpenFile),
	/// Waits only on storage: a read or a write returns without a peer having
	/// to do anything. Run in place.
	Plain(OpenFile),
	/// Can wait without end for a peer that may never come. Run on a thread of
	/// its own.
	Detached(Detached),
}

impl CopySide {
	fn classify(file: OpenFile) -> std::io::Result<Self> {
		if file.is_virtual() {
			return Ok(Self::Awaits(file));
		}
		if waits_for_peer(&file) {
			Detached::new(file).map(Self::Detached)
		} else {
			Ok(Self::Plain(file))
		}
	}

	async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		match self {
			Self::Awaits(file) => file.read_async(buf).await,
			Self::Plain(file) => std::io::Read::read(file, buf),
			Self::Detached(detached) => detached.read(buf).await,
		}
	}

	async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
		match self {
			Self::Awaits(file) => file.write_all_async(buf).await,
			Self::Plain(file) => std::io::Write::write_all(file, buf),
			Self::Detached(detached) => detached.write_all(buf).await,
		}
	}

	async fn flush(&mut self) -> std::io::Result<()> {
		match self {
			Self::Awaits(file) => file.flush_async().await,
			Self::Plain(file) => std::io::Write::flush(file),
			Self::Detached(detached) => detached.flush().await,
		}
	}
}

/// Whether a handle's `read` and `write` can wait for a peer that may never
/// come, rather than only for storage.
///
/// A [`Stream`] answers for itself and is never inspected further: its
/// descriptor, if it has one, is not what its `read` does. Everything else is
/// classified by what its descriptor is; a handle that will not show one is
/// taken to be able to wait, because that is the answer that cannot wedge a
/// runtime.
fn waits_for_peer(file: &OpenFile) -> bool {
	if let OpenFile::Stream(stream) = file {
		return stream.may_wait_for_peer();
	}

	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd as _;

		let Ok(borrowed) = file.try_borrow_as_fd() else {
			return true;
		};
		// SAFETY: `fstat` writes only the `stat` it is given, and the descriptor
		// stays open for as long as `file` is borrowed.
		let mut stat: nix::libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: as above.
		if unsafe { nix::libc::fstat(borrowed.as_raw_fd(), &raw mut stat) } != 0 {
			return true;
		}
		!matches!(stat.st_mode & nix::libc::S_IFMT, nix::libc::S_IFREG | nix::libc::S_IFDIR)
	}

	#[cfg(not(unix))]
	{
		!matches!(file, OpenFile::File(_))
	}
}

/// How many copy sides may be waiting on a peer at once, across the process.
///
/// This is the bound, and it is deliberate. A side that can wait for a peer
/// which may never come runs on a thread of its own, and a cancelled copy
/// cannot take that thread back: the read it is parked in ends only when the
/// peer acts, and no portable call interrupts it. Left unbounded, repeated
/// abandoned `$(<fifo)` runs fill the process's thread table and
/// `std::thread::spawn` panics. At the limit a copy is **refused** with
/// [`std::io::ErrorKind::ResourceBusy`] rather than queued: queueing behind a
/// read that may never end is the same deadlock one address further out, which
/// is what Tokio's blocking pool already proved.
///
/// The number is chosen to be far above any real shell's concurrent
/// peer-waiting reads and far below the process's thread limit. A copy whose
/// sides are a regular file, a provider-backed file, or anything else that
/// cannot wait for a peer takes no thread and is never refused; `$(<file)` on
/// an ordinary file is in that set.
pub const DETACHED_SIDE_LIMIT: usize = 64;

/// Live detached threads. Released by the thread itself, not by [`Detached`],
/// because an abandoned copy's thread outlives the struct that started it.
static DETACHED_SIDES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Holds one place under [`DETACHED_SIDE_LIMIT`] for as long as its thread runs.
struct DetachedPermit;

impl DetachedPermit {
	fn acquire() -> Option<Self> {
		DETACHED_SIDES
			.try_update(
				std::sync::atomic::Ordering::AcqRel,
				std::sync::atomic::Ordering::Acquire,
				|live| (live < DETACHED_SIDE_LIMIT).then_some(live + 1),
			)
			.ok()
			.map(|_previous| Self)
	}
}

impl Drop for DetachedPermit {
	fn drop(&mut self) {
		DETACHED_SIDES.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
	}
}

/// Which way a handle has to become ready.
#[derive(Clone, Copy)]
enum Readiness {
	Readable,
	Writable,
}

/// Waits, on a detached thread, until `file` can make progress again.
///
/// A caller may hand the shell a descriptor that is **already** `O_NONBLOCK`,
/// and this code deliberately never changes a descriptor's flags. `EAGAIN`
/// from such a handle means "not yet", not "failed": returning it would make
/// `$(</dev/stdin)` on a non-blocking pipe fail where a blocking one waits.
/// So the thread that is allowed to block does — on readiness, with `poll`,
/// which reads no flag and changes none.
///
/// A handle that reports not-ready and will not show a descriptor cannot be
/// polled; it is retried after a short sleep, which is slower than readiness
/// but keeps the contract. Nothing in this repository is such a handle.
///
/// # Errors
///
/// Returns the polling failure. Treating one as readiness turns a descriptor
/// that can never become ready into a loop that cannot be cancelled: with
/// `RLIMIT_NOFILE` lowered under it, `poll` failed with `EINVAL` on every call
/// and the copy made a quarter of a million read attempts in a tenth of a
/// second, and as many again after its caller had walked away. `EINTR` is the
/// one failure that means "ask again".
#[cfg_attr(not(unix), expect(unused_variables, reason = "no poll off Unix: only the sleep runs"))]
fn wait_until_ready(file: &OpenFile, readiness: Readiness) -> std::io::Result<()> {
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd as _;

		if let Ok(borrowed) = file.try_borrow_as_fd() {
			let mut waited = nix::libc::pollfd {
				fd:      borrowed.as_raw_fd(),
				events:  match readiness {
					Readiness::Readable => nix::libc::POLLIN,
					Readiness::Writable => nix::libc::POLLOUT,
				},
				revents: 0,
			};
			loop {
				// SAFETY: one `pollfd` is passed with a length of one, the
				// descriptor is open for as long as `file` is borrowed, and a
				// negative timeout waits without end.
				let ready = unsafe { nix::libc::poll(&raw mut waited, 1, -1) };
				if ready >= 0 {
					return Ok(());
				}
				let failure = std::io::Error::last_os_error();
				if failure.kind() != std::io::ErrorKind::Interrupted {
					return Err(failure);
				}
			}
		}
	}

	std::thread::sleep(std::time::Duration::from_millis(1));
	Ok(())
}

/// A handle whose blocking I/O runs on a thread of its own.
///
/// Deliberately not Tokio's blocking pool. That pool is a bound shared with
/// every other blocking task in the process, and a cancelled copy cannot give
/// its slot back: a read from a pipe nobody writes to holds one for ever, so a
/// few abandoned `$(<fifo)` runs disable every later copy, and a substitution
/// nested inside a non-async pipeline stage deadlocks against the stage already
/// holding a slot. This has a bound of its own instead — see
/// [`DETACHED_SIDE_LIMIT`] — so the failure at it is a refusal rather than a
/// deadlock, a panic, or an exhausted process.
///
/// The thread ends when the operation it is in returns, or when this struct
/// drops and its request channel closes; an abandoned copy leaves one thread
/// parked on a descriptor rather than a runtime worker.
struct Detached {
	requests: std::sync::mpsc::Sender<DetachedRequest>,
	replies:  tokio::sync::mpsc::UnboundedReceiver<std::io::Result<DetachedReply>>,
	/// Handed to the thread and back, so neither side allocates per chunk.
	scratch:  Option<Vec<u8>>,
}

enum DetachedRequest {
	Read(Vec<u8>),
	Write(Vec<u8>),
	Flush,
}

enum DetachedReply {
	Read(Vec<u8>, usize),
	Wrote(Vec<u8>),
	Flushed,
}

impl Detached {
	fn new(mut file: OpenFile) -> std::io::Result<Self> {
		let Some(permit) = DetachedPermit::acquire() else {
			return Err(std::io::Error::new(
				std::io::ErrorKind::ResourceBusy,
				format!(
					"{DETACHED_SIDE_LIMIT} reads or writes are already waiting on a peer that may \
					 never answer"
				),
			));
		};
		let (requests, incoming) = std::sync::mpsc::channel::<DetachedRequest>();
		let (outgoing, replies) = tokio::sync::mpsc::unbounded_channel();
		std::thread::spawn(move || {
			// Held until this thread ends, which is after the operation it is
			// in returns — not when the copy that started it is abandoned.
			let _permit = permit;
			while let Ok(request) = incoming.recv() {
				let reply = match request {
					DetachedRequest::Read(mut buf) => loop {
						match std::io::Read::read(&mut file, &mut buf) {
							Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
							Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
								if let Err(failure) = wait_until_ready(&file, Readiness::Readable) {
									break Err(failure);
								}
							},
							Ok(read) => break Ok(DetachedReply::Read(buf, read)),
							Err(error) => break Err(error),
						}
					},
					// Not `write_all`: it cannot resume after a handle says it
					// is not ready, so the loop belongs here.
					DetachedRequest::Write(buf) => {
						let mut written = 0;
						loop {
							match std::io::Write::write(&mut file, &buf[written..]) {
								Ok(0) => break Err(std::io::ErrorKind::WriteZero.into()),
								Ok(wrote) => {
									written += wrote;
									if written == buf.len() {
										break Ok(DetachedReply::Wrote(buf));
									}
								},
								Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
								Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
									if let Err(failure) = wait_until_ready(&file, Readiness::Writable)
									{
										break Err(failure);
									}
								},
								Err(error) => break Err(error),
							}
						}
					},
					DetachedRequest::Flush => loop {
						match std::io::Write::flush(&mut file) {
							Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
							Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
								if let Err(failure) = wait_until_ready(&file, Readiness::Writable) {
									break Err(failure);
								}
							},
							other => break other.map(|()| DetachedReply::Flushed),
						}
					},
				};
				if outgoing.send(reply).is_err() {
					break;
				}
			}
		});
		Ok(Self { requests, replies, scratch: Some(Vec::new()) })
	}

	/// The thread stopped without answering, which happens only if the handle's
	/// own code panicked.
	fn gone() -> std::io::Error {
		std::io::Error::other("the detached copy thread stopped")
	}

	async fn exchange(&mut self, request: DetachedRequest) -> std::io::Result<DetachedReply> {
		self.requests.send(request).map_err(|_| Self::gone())?;
		self.replies.recv().await.ok_or_else(Self::gone)?
	}

	async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		let mut scratch = self.scratch.take().unwrap_or_default();
		scratch.resize(buf.len(), 0);
		let DetachedReply::Read(scratch, read) = self.exchange(DetachedRequest::Read(scratch)).await?
		else {
			return Err(Self::gone());
		};
		buf[..read].copy_from_slice(&scratch[..read]);
		self.scratch = Some(scratch);
		Ok(read)
	}

	async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
		let mut scratch = self.scratch.take().unwrap_or_default();
		scratch.clear();
		scratch.extend_from_slice(buf);
		let DetachedReply::Wrote(scratch) = self.exchange(DetachedRequest::Write(scratch)).await?
		else {
			return Err(Self::gone());
		};
		self.scratch = Some(scratch);
		Ok(())
	}

	async fn flush(&mut self) -> std::io::Result<()> {
		self.exchange(DetachedRequest::Flush).await.map(|_reply| ())
	}
}

/// Reads everything `file` holds, without holding a runtime worker.
///
/// Same classification as [`copy_async`], for a caller that wants the bytes
/// rather than another handle to put them in.
///
/// # Errors
///
/// Returns the first read error.
pub async fn read_to_end_detached(file: OpenFile) -> std::io::Result<Vec<u8>> {
	let mut side = CopySide::classify(file)?;
	let mut buf = vec![0u8; COPY_CHUNK_BYTES];
	let mut contents = Vec::new();
	loop {
		// A read from a regular file awaits nothing; without this a large file
		// would hold its worker from the first byte to the last.
		tokio::task::coop::consume_budget().await;
		match side.read(&mut buf).await {
			Ok(0) => break,
			Ok(read) => contents.extend_from_slice(&buf[..read]),
			Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
			Err(error) => return Err(error),
		}
	}
	Ok(contents)
}

/// Copies everything readable from `reader` into `writer` without holding a
/// runtime worker.
///
/// Both ends are classified once and then streamed a chunk at a time, so the
/// copy holds one chunk whatever its ends are. A side that can wait for a peer
/// which may never come runs on a thread of its own; the rest run in place,
/// where the only wait is on storage.
///
/// The problem this shape exists for: `$(<file)` used to copy into a pipe that
/// a task on the same runtime drains. A blocking write into that pipe parks
/// whichever thread runs it until the drain makes room, and the drain cannot
/// run while a worker is parked. Tokio's blocking pool is not the answer — a
/// cancelled copy keeps its slot until its descriptor unblocks, which may be
/// never — and neither is polling the descriptor, because `O_NONBLOCK` lives on
/// the open file description that every `dup` of it shares, so setting it is
/// visible to a child process and to every other copy of that handle.
///
/// # Errors
///
/// Returns the first read or write error.
pub async fn copy_async(reader: OpenFile, writer: OpenFile) -> std::io::Result<()> {
	let mut reader = CopySide::classify(reader)?;
	let mut writer = CopySide::classify(writer)?;
	let mut buf = vec![0u8; COPY_CHUNK_BYTES];
	loop {
		// A copy between two regular files awaits nothing; without this it would
		// hold its worker for the whole file.
		tokio::task::coop::consume_budget().await;
		let read = match reader.read(&mut buf).await {
			Ok(0) => break,
			Ok(read) => read,
			Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
			Err(error) => return Err(error),
		};
		writer.write_all(&buf[..read]).await?;
	}
	writer.flush().await
}

impl From<std::io::Stdin> for OpenFile {
	/// Creates an `OpenFile` from standard input.
	fn from(stdin: std::io::Stdin) -> Self {
		Self::Stdin(stdin)
	}
}

impl From<std::io::Stdout> for OpenFile {
	/// Creates an `OpenFile` from standard output.
	fn from(stdout: std::io::Stdout) -> Self {
		Self::Stdout(stdout)
	}
}

impl From<std::io::Stderr> for OpenFile {
	/// Creates an `OpenFile` from standard error.
	fn from(stderr: std::io::Stderr) -> Self {
		Self::Stderr(stderr)
	}
}

impl From<std::fs::File> for OpenFile {
	fn from(file: std::fs::File) -> Self {
		Self::File(file)
	}
}

impl From<pi_vfs::File> for OpenFile {
	/// Native handles become [`OpenFile::File`], keeping descriptor
	/// inheritance and the platform fast paths; provider handles stay virtual.
	fn from(file: pi_vfs::File) -> Self {
		match file.into_native() {
			Ok(native) => Self::File(native),
			Err(virtual_file) => Self::Vfs(virtual_file),
		}
	}
}

impl From<std::io::PipeReader> for OpenFile {
	fn from(reader: std::io::PipeReader) -> Self {
		Self::PipeReader(reader)
	}
}

impl From<std::io::PipeWriter> for OpenFile {
	fn from(writer: std::io::PipeWriter) -> Self {
		Self::PipeWriter(writer)
	}
}

impl std::io::Read for OpenFile {
	fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		match self {
			Self::Stdin(f) => f.read(buf),
			Self::Stdout(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotReadable("stdout")))
			},
			Self::Stderr(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotReadable("stderr")))
			},
			Self::File(f) => f.read(buf),
			Self::PipeReader(reader) => reader.read(buf),
			Self::PipeWriter(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotReadable("pipe writer")))
			},
			Self::Stream(s) => s.read(buf),
			Self::Vfs(f) => f.read(buf),
		}
	}
}

impl std::io::Write for OpenFile {
	fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
		match self {
			Self::Stdin(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotWritable("stdin")))
			},
			Self::Stdout(f) => f.write(buf),
			Self::Stderr(f) => f.write(buf),
			Self::File(f) => f.write(buf),
			Self::PipeReader(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotWritable("pipe reader")))
			},
			Self::PipeWriter(writer) => writer.write(buf),
			Self::Stream(s) => s.write(buf),
			Self::Vfs(f) => f.write(buf),
		}
	}

	fn flush(&mut self) -> std::io::Result<()> {
		match self {
			Self::Stdin(_) => Ok(()),
			Self::Stdout(f) => f.flush(),
			Self::Stderr(f) => f.flush(),
			Self::File(f) => f.flush(),
			Self::PipeReader(_) => Ok(()),
			Self::PipeWriter(writer) => writer.flush(),
			Self::Stream(s) => s.flush(),
			Self::Vfs(f) => f.flush(),
		}
	}
}

/// Tristate representing the an `OpenFile` entry in an `OpenFiles` structure.
pub enum OpenFileEntry<'a> {
	/// File descriptor is present and has a valid associated `OpenFile`.
	Open(&'a OpenFile),
	/// File descriptor is explicitly marked as not being mapped to any
	/// `OpenFile`.
	NotPresent,
	/// File descriptor is not specified in any way; it may be provided by a
	/// parent context of some kind.
	NotSpecified,
}

/// Represents the open files in a shell context.
#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct OpenFiles {
	/// Maps shell file descriptors to open files.
	files: HashMap<ShellFd, Option<OpenFile>>,
}

impl OpenFiles {
	/// First file descriptor available for non-stdio files.
	const FIRST_NON_STDIO_FD: ShellFd = 3;
	/// Maximum file descriptor number allowed.
	const MAX_FD: ShellFd = 1024;
	/// File descriptor used for standard error.
	pub const STDERR_FD: ShellFd = 2;
	/// File descriptor used for standard input.
	pub const STDIN_FD: ShellFd = 0;
	/// File descriptor used for standard output.
	pub const STDOUT_FD: ShellFd = 1;

	/// Creates a new `OpenFiles` instance populated with stdin, stdout, and
	/// stderr from the host environment.
	pub(crate) fn new() -> Self {
		Self {
			files: HashMap::from([
				(Self::STDIN_FD, Some(std::io::stdin().into())),
				(Self::STDOUT_FD, Some(std::io::stdout().into())),
				(Self::STDERR_FD, Some(std::io::stderr().into())),
			]),
		}
	}

	/// Updates the open files from the provided iterator of (fd number,
	/// `OpenFile`) pairs. Any existing entries for the provided file
	/// descriptors will be overwritten.
	///
	/// # Arguments
	///
	/// * `files`: An iterator of (fd number, `OpenFile`) pairs to update the
	///   open files with.
	pub fn update_from(&mut self, files: impl Iterator<Item = (ShellFd, OpenFile)>) {
		for (fd, file) in files {
			let _ = self.files.insert(fd, Some(file));
		}
	}

	/// Retrieves the file backing standard input in this context.
	pub fn try_stdin(&self) -> Option<&OpenFile> {
		self.files.get(&Self::STDIN_FD).and_then(|f| f.as_ref())
	}

	/// Retrieves the file backing standard output in this context.
	pub fn try_stdout(&self) -> Option<&OpenFile> {
		self.files.get(&Self::STDOUT_FD).and_then(|f| f.as_ref())
	}

	/// Retrieves the file backing standard error in this context.
	pub fn try_stderr(&self) -> Option<&OpenFile> {
		self.files.get(&Self::STDERR_FD).and_then(|f| f.as_ref())
	}

	/// Tries to remove an open file by its file descriptor. If the file
	/// descriptor is not used, `None` will be returned; otherwise, the removed
	/// file will be returned.
	///
	/// Arguments:
	///
	/// * `fd`: The file descriptor to remove.
	pub fn remove_fd(&mut self, fd: ShellFd) -> Option<OpenFile> {
		self.files.insert(fd, None).and_then(|f| f)
	}

	/// Tries to lookup the `OpenFile` associated with a file descriptor.
	/// Returns `None` if the file descriptor is not present.
	///
	/// Arguments:
	///
	/// * `fd`: The file descriptor to lookup.
	pub fn try_fd(&self, fd: ShellFd) -> Option<&OpenFile> {
		self.files.get(&fd).and_then(|f| f.as_ref())
	}

	/// Tries to lookup the `OpenFile` associated with a file descriptor. Returns
	/// an `OpenFileEntry` representing the state of the file descriptor.
	///
	/// Arguments:
	///
	/// * `fd`: The file descriptor to lookup.
	pub fn fd_entry(&self, fd: ShellFd) -> OpenFileEntry<'_> {
		self
			.files
			.get(&fd)
			.map_or(OpenFileEntry::NotSpecified, |opt_file| match opt_file {
				Some(f) => OpenFileEntry::Open(f),
				None => OpenFileEntry::NotPresent,
			})
	}

	/// Checks if the given file descriptor is in use.
	pub fn contains_fd(&self, fd: ShellFd) -> bool {
		self.files.contains_key(&fd)
	}

	/// Associates the given file descriptor with the provided file. If the file
	/// descriptor is already in use, the previous file will be returned;
	/// otherwise, `None` will be returned.
	///
	/// Arguments:
	///
	/// * `fd`: The file descriptor to associate with the file.
	/// * `file`: The file to associate with the file descriptor.
	pub fn set_fd(&mut self, fd: ShellFd, file: OpenFile) -> Option<OpenFile> {
		self.files.insert(fd, Some(file)).and_then(|f| f)
	}

	/// Iterates over all file descriptors.
	pub fn iter_fds(&self) -> impl Iterator<Item = (ShellFd, &OpenFile)> {
		self
			.files
			.iter()
			.filter_map(|(fd, file)| file.as_ref().map(|f| (*fd, f)))
	}

	/// Adds a new open file, returning the assigned file descriptor.
	///
	/// # Arguments
	///
	/// * `file`: The open file to add.
	pub fn add(&mut self, file: OpenFile) -> Result<ShellFd, error::Error> {
		// Start searching for free file descriptors after the standard ones.
		let mut fd = Self::FIRST_NON_STDIO_FD;
		while self.files.contains_key(&fd) {
			if fd >= Self::MAX_FD {
				return Err(error::ErrorKind::TooManyOpenFiles.into());
			}

			fd += 1;
		}

		self.files.insert(fd, Some(file));
		Ok(fd)
	}
}

impl<I> From<I> for OpenFiles
where
	I: Iterator<Item = (ShellFd, OpenFile)>,
{
	fn from(iter: I) -> Self {
		let files = iter.map(|(fd, file)| (fd, Some(file))).collect();
		Self { files }
	}
}

/// A path that names one of the calling process's own descriptors, or its
/// controlling terminal, rather than a file.
///
/// Opening such a path for real reaches the *process's* descriptor table. A
/// shell embedded in a larger host shares that process, so `/dev/stdin` would
/// be the host's terminal rather than the command's input. Callers resolve
/// these paths against the shell's descriptors instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DescriptorPath {
	/// `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, or `N` under `/dev/fd`,
	/// `/proc/self/fd`, `/proc/thread-self/fd`, or `/proc/<this pid>/fd`.
	Fd(ShellFd),
	/// `/dev/tty`.
	Terminal,
}

impl DescriptorPath {
	/// Classifies an absolute path; `None` for every other path, including
	/// relative paths and the descriptor directories themselves.
	pub fn parse(path: &std::path::Path) -> Option<Self> {
		use std::path::Component;

		let mut components = path.components();
		if components.next() != Some(Component::RootDir) {
			return None;
		}
		let mut names = [""; 4];
		let mut len = 0;
		for component in components {
			let Component::Normal(name) = component else {
				return None;
			};
			*names.get_mut(len)? = name.to_str()?;
			len += 1;
		}

		match names[..len] {
			["dev", "stdin"] => Some(Self::Fd(OpenFiles::STDIN_FD)),
			["dev", "stdout"] => Some(Self::Fd(OpenFiles::STDOUT_FD)),
			["dev", "stderr"] => Some(Self::Fd(OpenFiles::STDERR_FD)),
			["dev", "tty"] => Some(Self::Terminal),
			["dev", "fd", fd] | ["proc", "self" | "thread-self", "fd", fd] => decimal(fd).map(Self::Fd),
			["proc", pid, "fd", fd] if decimal::<u32>(pid) == Some(std::process::id()) => {
				decimal(fd).map(Self::Fd)
			},
			_ => None,
		}
	}

	/// The error opening this path fails with in a process that lacks the
	/// descriptor (`ENOENT`) or has no controlling terminal (`ENXIO`).
	pub fn unavailable_error(self) -> std::io::Error {
		#[cfg(unix)]
		{
			let errno = match self {
				Self::Fd(_) => nix::errno::Errno::ENOENT,
				Self::Terminal => nix::errno::Errno::ENXIO,
			};
			std::io::Error::from_raw_os_error(errno as i32)
		}
		#[cfg(not(unix))]
		{
			std::io::Error::from(std::io::ErrorKind::NotFound)
		}
	}
}

/// Parses an unsigned decimal path component, as the kernel spells
/// descriptor numbers and pids; signs and other text are not numbers here.
fn decimal<T: std::str::FromStr>(name: &str) -> Option<T> {
	if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	name.parse().ok()
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

		for path in [
			"/dev/fd",
			"/dev/fd/-1",
			"/dev/fd/+3",
			"/dev/fd/3/x",
			"/dev/null",
			"dev/stdin",
			"/dev/../dev/stdin",
			&format!("/proc/{}/fd/3", own.wrapping_add(1)),
		] {
			assert_eq!(parse(path), None, "{path}");
		}
	}
}
