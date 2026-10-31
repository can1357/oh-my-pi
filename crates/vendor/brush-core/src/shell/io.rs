//! I/O support for shell instances.

use crate::{error, extensions, ioutils, openfiles};

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
		if let Some(mut trace_file) = trace_file {
			let line = format!("{prefix}{}\n", command.as_ref());
			let _ = trace_file.write_all_async(line.as_bytes()).await;
		}
	}

	/// Displays the given error to the user, using the shell's error display
	/// mechanisms.
	///
	/// # Arguments
	///
	/// * `file` - The file to write the error to.
	/// * `err` - The error to display.
	pub async fn display_error(
		&self,
		file: &mut openfiles::OpenFile,
		err: &error::Error,
	) -> Result<(), error::Error> {
		use crate::extensions::ErrorFormatter as _;
		let str = self.error_formatter.format_error(err, self);
		file.write_all_async(str.as_bytes()).await?;

		Ok(())
	}

	/// Displays the error `kind` makes of the text `parts` join to, writing
	/// that text a stride at a time.
	///
	/// The formatter builds a whole message in one `format!`, and an error
	/// can quote text as long as a script made it: a refused array element
	/// carrying a 64 MiB value held the worker 28.1 ms in that `format!`, and
	/// 79.0 ms under load, with stderr on `/dev/null`. So the formatter is
	/// handed the same error around a one-character stand-in, and the message
	/// written is its text before the stand-in, `parts` a stride at a time,
	/// and its text after: the formatter's own framing around the text it
	/// would have quoted. A formatter that does not quote the error's text
	/// as it stands is handed the whole error instead.
	///
	/// What the write itself fails with is not an error of the run's, as it
	/// is not for [`Self::display_error`]: it stops the message and is
	/// otherwise ignored.
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way.
	pub async fn display_error_around(
		&self,
		file: &mut openfiles::OpenFile,
		params: &crate::ExecutionParameters,
		kind: fn(String) -> error::ErrorKind,
		parts: &[&str],
	) -> Result<(), error::Error> {
		use crate::extensions::ErrorFormatter as _;
		const STAND_IN: char = '\u{1}';

		let framed = self.error_formatter.format_error(&kind(STAND_IN.to_string()).into(), self);
		let Some((before, after)) = framed.split_once(STAND_IN).filter(|(_, after)| !after.contains(STAND_IN))
		else {
			let mut text = String::new();
			for part in parts {
				crate::interp::push_str_in_strides(params, &mut text, part).await?;
			}
			let _ = self.display_error(file, &kind(text).into()).await;
			return Ok(());
		};

		if file.write_all_async(before.as_bytes()).await.is_err() {
			return Ok(());
		}
		for part in parts {
			for stride in part.as_bytes().chunks(crate::interp::BYTE_CHECKPOINT_STRIDE) {
				crate::interp::stride_checkpoint(params).await?;
				if file.write_all_async(stride).await.is_err() {
					return Ok(());
				}
			}
		}
		let _ = file.write_all_async(after.as_bytes()).await;
		Ok(())
	}
}
