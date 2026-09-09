/// Stub implementation of a pipe reader.
#[derive(Clone)]
pub(crate) struct PipeReader {}

impl PipeReader {
	/// Tries to clone the reader.
	pub fn try_clone(&self) -> std::io::Result<Self> {
		Ok((*self).clone())
	}
}

impl From<PipeReader> for std::process::Stdio {
	fn from(_reader: PipeReader) -> Self {
		Self::null()
	}
}

impl std::io::Read for PipeReader {
	fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
		Ok(0)
	}
}

/// Stub implementation o a pipe writer.
#[derive(Clone)]
pub(crate) struct PipeWriter {}

impl PipeWriter {
	/// Tries to clone the writer.
	pub fn try_clone(&self) -> std::io::Result<Self> {
		Ok((*self).clone())
	}
}

impl From<PipeWriter> for std::process::Stdio {
	fn from(_writer: PipeWriter) -> Self {
		Self::null()
	}
}

impl std::io::Write for PipeWriter {
	fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
		Ok(0)
	}

	fn flush(&mut self) -> std::io::Result<()> {
		Ok(())
	}
}

pub(crate) fn pipe() -> std::io::Result<(PipeReader, PipeWriter)> {
	Ok((PipeReader {}, PipeWriter {}))
}
