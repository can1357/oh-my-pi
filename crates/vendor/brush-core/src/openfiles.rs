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
		};

		Ok(result)
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
			};
			Ok(stdio)
		}
	}

	pub(crate) fn is_dir(&self) -> bool {
		match self {
			Self::Stdin(_) | Self::Stdout(_) | Self::Stderr(_) => false,
			Self::File(file) => file.metadata().is_ok_and(|m| m.is_dir()),
			Self::PipeReader(_) | Self::PipeWriter(_) | Self::Stream(_) => false,
		}
	}

	/// Checks if the open file is associated with a terminal.
	pub fn is_terminal(&self) -> bool {
		match self {
			Self::Stdin(f) => f.is_terminal(),
			Self::Stdout(f) => f.is_terminal(),
			Self::Stderr(f) => f.is_terminal(),
			Self::File(f) => f.is_terminal(),
			Self::PipeReader(_) | Self::PipeWriter(_) | Self::Stream(_) => false,
		}
	}
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
