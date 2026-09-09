//! Async pipe reading utilities for Unix.

use std::{io, os::unix::io::OwnedFd};

use tokio::net::unix::pipe;

pub(crate) struct AsyncPipeReader(pipe::Receiver);

impl AsyncPipeReader {
	pub(crate) fn new(reader: std::io::PipeReader) -> io::Result<Self> {
		Ok(Self(pipe::Receiver::from_file(std::fs::File::from(OwnedFd::from(reader)))?))
	}

	pub(crate) async fn read_to_string(&mut self) -> io::Result<String> {
		use tokio::io::AsyncReadExt;
		let mut s = String::new();
		self.0.read_to_string(&mut s).await?;
		Ok(s)
	}
}
