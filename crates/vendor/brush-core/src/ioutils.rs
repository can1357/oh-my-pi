//! Internal I/O utilities.

use crate::openfiles;

/// Error type for `FailingReaderWriter`.
#[derive(Clone, Debug, thiserror::Error)]
enum ReaderWriterError {
	/// I/O read error.
	#[error("I/O read error: {0}")]
	Read(&'static str),
	/// I/O write error.
	#[error("I/O write error: {0}")]
	Write(&'static str),
	/// I/O flush error.
	#[error("I/O flush error: {0}")]
	Flush(&'static str),
}

/// Marks a `FailingReaderWriter` error that stands for descriptor exhaustion:
/// its file could not be duplicated because this process, or the system, had
/// no descriptor left.
#[derive(Clone, Debug, thiserror::Error)]
#[error(transparent)]
struct DescriptorsExhausted(ReaderWriterError);

/// Whether `err` reports that this process, or the system, ran out of file
/// descriptors, directly or through a file that could not be duplicated for
/// that reason. Any other failure, such as a closed descriptor or a full
/// device, is not exhaustion.
pub(crate) fn is_descriptor_exhaustion(err: &std::io::Error) -> bool {
	#[cfg(unix)]
	if matches!(err.raw_os_error(), Some(libc::EMFILE | libc::ENFILE)) {
		return true;
	}
	err.get_ref()
		.is_some_and(|inner| inner.is::<DescriptorsExhausted>())
}

/// An implementation of `std::io::Read` and `std::io::Write` that always fails.
///
/// Also implements `openfiles::Stream` for use with `openfiles::OpenFile`.
/// Useful for providing a valid stream that gracefully fails all operations in
/// cases where no real I/O is possible.
#[derive(Clone)]
pub(crate) struct FailingReaderWriter {
	message:               &'static str,
	descriptors_exhausted: bool,
}

impl FailingReaderWriter {
	/// Creates a new `FailingReaderWriter` with the given error message.
	///
	/// # Arguments
	///
	/// * `message` - The error message to use for all operations.
	pub const fn new(message: &'static str) -> Self {
		Self { message, descriptors_exhausted: false }
	}

	/// Stands for a file that could not be duplicated, failing with `err`.
	/// Its operations report descriptor exhaustion when `err` did.
	pub(crate) fn duplicate_failed(err: &std::io::Error) -> Self {
		Self {
			message:               "failed to duplicate open file",
			descriptors_exhausted: is_descriptor_exhaustion(err),
		}
	}

	fn error(&self, err: ReaderWriterError) -> std::io::Error {
		if self.descriptors_exhausted {
			std::io::Error::other(DescriptorsExhausted(err))
		} else {
			std::io::Error::other(err)
		}
	}
}

impl openfiles::Stream for FailingReaderWriter {
	fn clone_box(&self) -> Box<dyn openfiles::Stream> {
		Box::new(self.clone())
	}

	#[cfg(unix)]
	fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, crate::error::Error> {
		Err(crate::error::ErrorKind::CannotConvertToNativeFd.into())
	}

	#[cfg(unix)]
	fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, crate::error::Error> {
		Err(crate::error::ErrorKind::CannotConvertToNativeFd.into())
	}
}

impl std::io::Read for FailingReaderWriter {
	fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
		Err(self.error(ReaderWriterError::Read(self.message)))
	}
}

impl std::io::Write for FailingReaderWriter {
	fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
		Err(self.error(ReaderWriterError::Write(self.message)))
	}

	fn flush(&mut self) -> std::io::Result<()> {
		Err(self.error(ReaderWriterError::Flush(self.message)))
	}
}

impl From<FailingReaderWriter> for openfiles::OpenFile {
	fn from(frw: FailingReaderWriter) -> Self {
		Self::Stream(Box::new(frw))
	}
}
