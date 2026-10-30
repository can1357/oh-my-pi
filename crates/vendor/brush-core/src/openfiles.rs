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

/// One end of a copy, classified by what its I/O waits on.
enum CopySide {
	/// A provider-backed file. Its `*_async` methods await.
	Virtual(OpenFile),
	/// A descriptor that can wait without end for something no storage
	/// controller will deliver — a pipe, a FIFO, a socket, a terminal. Driven
	/// by the reactor with `O_NONBLOCK` set, so waiting on it is an ordinary
	/// pending future that a drop or a cancellation ends at once.
	#[cfg(unix)]
	Polled(PolledFd),
	/// Everything else: a regular file, or a handle with no descriptor. Its
	/// reads and writes wait on storage and return.
	Plain(OpenFile),
}

impl CopySide {
	fn classify(file: OpenFile) -> Self {
		if file.is_virtual() {
			return Self::Virtual(file);
		}
		#[cfg(unix)]
		{
			match PolledFd::new(file) {
				Ok(polled) => Self::Polled(polled),
				Err(file) => Self::Plain(file),
			}
		}
		#[cfg(not(unix))]
		{
			Self::Plain(file)
		}
	}

	async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		match self {
			Self::Virtual(file) => file.read_async(buf).await,
			#[cfg(unix)]
			Self::Polled(polled) => polled.read(buf).await,
			Self::Plain(file) => std::io::Read::read(file, buf),
		}
	}

	async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
		match self {
			Self::Virtual(file) => file.write_all_async(buf).await,
			#[cfg(unix)]
			Self::Polled(polled) => polled.write_all(buf).await,
			Self::Plain(file) => std::io::Write::write_all(file, buf),
		}
	}

	async fn flush(&mut self) -> std::io::Result<()> {
		match self {
			Self::Virtual(file) => file.flush_async().await,
			// A descriptor holds nothing back; every `write` reached the kernel.
			#[cfg(unix)]
			Self::Polled(_) => Ok(()),
			Self::Plain(file) => std::io::Write::flush(file),
		}
	}
}

/// Lends a raw descriptor to the reactor without owning it.
#[cfg(unix)]
struct RawDescriptor(std::os::fd::RawFd);

#[cfg(unix)]
impl std::os::fd::AsRawFd for RawDescriptor {
	fn as_raw_fd(&self) -> std::os::fd::RawFd {
		self.0
	}
}

/// A descriptor the reactor polls, with `O_NONBLOCK` set for as long as the
/// copy runs.
///
/// `O_NONBLOCK` lives on the open file description, which `dup` shares, so
/// setting it is visible through every descriptor duplicated from the same
/// `open`. It is therefore restored on drop, and only set when this copy found
/// it clear.
#[cfg(unix)]
struct PolledFd {
	/// Registered with the reactor; deregistered when this field drops, which
	/// is before `file` closes the descriptor.
	poll:    tokio::io::unix::AsyncFd<RawDescriptor>,
	/// The flags to put back, when this copy was the one that changed them.
	restore: Option<nix::libc::c_int>,
	/// Holds the descriptor open. Declared last so it closes last, after the
	/// reactor registration above and the flag restore below.
	#[expect(dead_code, reason = "held for the descriptor's lifetime, never read")]
	file:    OpenFile,
}

#[cfg(unix)]
impl Drop for PolledFd {
	fn drop(&mut self) {
		if let Some(flags) = self.restore {
			// SAFETY: `self.file` still holds the descriptor open, and `F_SETFL`
			// is given the flags the matching `F_GETFL` returned.
			unsafe { nix::libc::fcntl(self.poll.get_ref().0, nix::libc::F_SETFL, flags) };
		}
	}
}

#[cfg(unix)]
impl PolledFd {
	/// Takes `file` when its descriptor is one the reactor can poll, and hands
	/// it back when it is not.
	///
	/// A regular file is never offered: `epoll_ctl` refuses it, and its reads
	/// wait only on storage. Some character devices carry no `poll` either
	/// (`/dev/null` among them), so a registration failure also hands `file`
	/// back rather than failing the copy.
	fn new(file: OpenFile) -> Result<Self, OpenFile> {
		use std::os::fd::AsRawFd as _;

		let Ok(borrowed) = file.try_borrow_as_fd() else {
			return Err(file);
		};
		let raw = borrowed.as_raw_fd();
		if !waits_without_end(raw) {
			return Err(file);
		}

		// SAFETY: `raw` stays open for the life of `file`, and `F_GETFL` only reads.
		let flags = unsafe { nix::libc::fcntl(raw, nix::libc::F_GETFL) };
		if flags < 0 {
			return Err(file);
		}
		let restore = if flags & nix::libc::O_NONBLOCK == 0 {
			// SAFETY: as above; `F_SETFL` sets only the status flags.
			let set = unsafe { nix::libc::fcntl(raw, nix::libc::F_SETFL, flags | nix::libc::O_NONBLOCK) };
			if set < 0 {
				return Err(file);
			}
			Some(flags)
		} else {
			None
		};

		match tokio::io::unix::AsyncFd::new(RawDescriptor(raw)) {
			Ok(poll) => Ok(Self { poll, restore, file }),
			Err(_) => {
				if let Some(flags) = restore {
					// SAFETY: as above.
					unsafe { nix::libc::fcntl(raw, nix::libc::F_SETFL, flags) };
				}
				Err(file)
			},
		}
	}

	async fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
		self
			.poll
			.async_io(tokio::io::Interest::READABLE, |descriptor| {
				// SAFETY: `descriptor` is open and `buf` is writable for `buf.len()` bytes.
				let read = unsafe { nix::libc::read(descriptor.0, buf.as_mut_ptr().cast(), buf.len()) };
				if read < 0 {
					return Err(std::io::Error::last_os_error());
				}
				#[expect(clippy::cast_sign_loss, reason = "read is not negative here")]
				Ok(read as usize)
			})
			.await
	}

	async fn write_all(&self, mut buf: &[u8]) -> std::io::Result<()> {
		while !buf.is_empty() {
			let written = self
				.poll
				.async_io(tokio::io::Interest::WRITABLE, |descriptor| {
					// SAFETY: `descriptor` is open and `buf` is readable for `buf.len()` bytes.
					let written =
						unsafe { nix::libc::write(descriptor.0, buf.as_ptr().cast(), buf.len()) };
					if written < 0 {
						return Err(std::io::Error::last_os_error());
					}
					#[expect(clippy::cast_sign_loss, reason = "written is not negative here")]
					Ok(written as usize)
				})
				.await?;
			if written == 0 {
				return Err(std::io::ErrorKind::WriteZero.into());
			}
			buf = &buf[written..];
		}
		Ok(())
	}
}

/// Whether a descriptor is of a kind that can wait for a peer that may never
/// come: a pipe, a FIFO, a socket, or a character device such as a terminal.
#[cfg(unix)]
fn waits_without_end(raw: std::os::fd::RawFd) -> bool {
	// SAFETY: `fstat` writes only the `stat` it is given, and `raw` is open.
	let mut stat: nix::libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: as above.
	if unsafe { nix::libc::fstat(raw, &raw mut stat) } != 0 {
		return false;
	}
	matches!(
		stat.st_mode & nix::libc::S_IFMT,
		nix::libc::S_IFIFO | nix::libc::S_IFSOCK | nix::libc::S_IFCHR
	)
}

/// Copies everything readable from `reader` into `writer` without holding a
/// runtime worker, and without taking a thread that a cancellation cannot get
/// back.
///
/// Both ends are classified once and then streamed a chunk at a time, so the
/// copy holds one chunk whatever its ends are. A descriptor that can wait for a
/// peer which may never come is driven by the reactor; everything else reads
/// and writes in place, where the only wait is on storage.
///
/// The problem this shape exists for: `$(<file)` copies into a pipe that a task
/// on the same runtime drains. A blocking write into that pipe parks whichever
/// thread runs it until the drain makes room, and the drain cannot run while a
/// worker is parked. Moving the copy to the blocking pool only moves the
/// deadlock onto a smaller bound — a cancelled copy keeps its pool thread until
/// its descriptor unblocks, which may be never — so the pipe end is polled
/// instead and no thread is taken at all.
///
/// # Errors
///
/// Returns the first read or write error.
pub async fn copy_async(reader: OpenFile, writer: OpenFile) -> std::io::Result<()> {
	let mut reader = CopySide::classify(reader);
	let mut writer = CopySide::classify(writer);
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
