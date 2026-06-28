//! Async pipe reading utilities for non-Unix platforms.
//!
//! Uses `spawn_blocking` internally for the I/O operation only,
//! not for the entire subshell execution.

use std::io::{self, Read};

pub(crate) struct AsyncPipeReader {
	inner: Option<std::io::PipeReader>,
}

impl AsyncPipeReader {
	pub(crate) fn new(fd: std::io::PipeReader) -> io::Result<Self> {
		Ok(Self { inner: Some(fd) })
	}

	pub(crate) async fn read_to_string(&mut self) -> io::Result<String> {
		let Some(reader) = self.inner.take() else {
			return Ok(String::new());
		};

		tokio::task::spawn_blocking(move || {
			let mut s = String::new();
			{ reader }.read_to_string(&mut s)?;
			Ok(s)
		})
		.await
		.map_err(io::Error::other)?
	}
}
