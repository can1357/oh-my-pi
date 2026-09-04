//! Process management utilities

pub(crate) type ProcessId = i32;

/// Provides access to a child process.
pub struct Child {
	inner: process::Child,
}

pub(crate) use std::process::{ExitStatus, Output};
use std::{io, process};

impl Child {
	/// Returns the process ID of the child process, if available.
	pub fn id(&self) -> Option<u32> {
		None
	}

	/// Asynchronously waits for the child process to exit.
	pub async fn wait(&mut self) -> io::Result<ExitStatus> {
		self.inner.wait()
	}

	/// Asynchronously waits for the child process to exit and collects its
	/// output.
	pub async fn wait_with_output(self) -> io::Result<Output> {
		self.inner.wait_with_output()
	}
}

pub(crate) fn spawn(mut command: process::Command) -> io::Result<Child> {
	let child = command.spawn()?;
	Ok(Child { inner: child })
}
