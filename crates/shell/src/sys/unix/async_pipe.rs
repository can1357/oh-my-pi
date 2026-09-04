//! Async pipe reading utilities for Unix.

use std::{fs, io, os::unix::io::OwnedFd};

use tokio::net::unix::pipe::Receiver;

pub(crate) struct AsyncPipeReader(Receiver);

impl AsyncPipeReader {
	pub(crate) fn new(reader: io::PipeReader) -> io::Result<Self> {
		Ok(Self(Receiver::from_file(fs::File::from(OwnedFd::from(reader)))?))
	}

	pub(crate) async fn read_to_string(&mut self) -> io::Result<String> {
		use tokio::io::AsyncReadExt;
		let mut s = String::new();
		self.0.read_to_string(&mut s).await?;
		Ok(s)
	}
}
