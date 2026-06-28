//! I/O support for shell instances.

use std::io::Write;

use crate::{error, extensions, ioutils};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {
	/// Returns a value that can be used to write to the shell's currently
	/// configured standard output stream using `write!` et al.
	pub fn stdout(&self) -> impl std::io::Write + 'static {
		self.open_files.try_stdout().cloned().unwrap_or_else(|| {
			ioutils::FailingReaderWriter::new("standard output not available").into()
		})
	}

	/// Returns a value that can be used to write to the shell's currently
	/// configured standard error stream using `write!` et al.
	pub fn stderr(&self) -> impl std::io::Write + 'static {
		self.open_files.try_stderr().cloned().unwrap_or_else(|| {
			ioutils::FailingReaderWriter::new("standard error not available").into()
		})
	}

	/// Outputs `set -x` style trace output for a command. Intentionally does not
	/// return a result or error to avoid risk that a caller treats an error as
	/// fatal. Tracing failure should generally always be ignored to avoid
	/// interfering with execution flows.
	///
	/// # Arguments
	///
	/// * `command` - The command to trace.
	pub(crate) async fn trace_command<S: AsRef<str>>(
		&mut self,
		params: &crate::interp::ExecutionParameters,
		command: S,
	) {
		// Expand the PS4 prompt variable to get our prefix.
		let mut prefix = self
			.as_mut()
			.expand_prompt_var("PS4", "")
			.await
			.unwrap_or_default();

		// Add additional depth-based prefixes using the first character of PS4.
		let additional_depth = self.call_stack.script_source_depth() + self.depth;
		if let Some(c) = prefix.chars().next() {
			for _ in 0..additional_depth {
				prefix.insert(0, c);
			}
		}

		// Resolve which file descriptor to use for tracing. We default to stderr,
		// but if BASH_XTRACEFD is set and refers to a valid file descriptor, use that
		// instead.
		let trace_file = if let Some((_, xtracefd_var)) = self.env.get("BASH_XTRACEFD")
			&& let Ok(fd) = xtracefd_var
				.value()
				.to_cow_str(self)
				.parse::<super::ShellFd>()
			&& let Some(file) = self.open_files.try_fd(fd)
		{
			Some(file.clone())
		} else {
			params.try_stderr(self)
		};

		// If we have a valid trace file, write to it.
		if let Some(trace_file) = trace_file
			&& let Ok(mut trace_file) = trace_file.try_clone()
		{
			let _ = writeln!(trace_file, "{prefix}{}", command.as_ref());
		}
	}

	/// Displays the given error to the user, using the shell's error display
	/// mechanisms.
	///
	/// # Arguments
	///
	/// * `file_table` - The open file table to use for any file descriptor
	///   references.
	/// * `err` - The error to display.
	pub fn display_error(
		&self,
		file: &mut impl std::io::Write,
		err: &error::Error,
	) -> Result<(), error::Error> {
		use crate::extensions::ErrorFormatter as _;
		let str = self.error_formatter.format_error(err, self);
		write!(file, "{str}")?;

		Ok(())
	}
}
