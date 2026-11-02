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
		// A cancelled run traces nothing more. A `PS4` whose command
		// substitution turns `-x` back on recurses without end, as in Bash; once
		// the run is cancelled, every level must unwind at once instead of
		// expanding `PS4` again and writing an ever longer trace line.
		if params.is_cancelled() {
			return;
		}
		// Bash turns `-x` off while it expands PS4 (print_cmd.c:
		// `indirection_level_string`). A command substitution in PS4 otherwise
		// inherits xtrace and recursively expands the same PS4.
		let xtrace = self.options().print_commands_and_arguments;
		self.options_mut().print_commands_and_arguments = false;
		let prefix = self.as_mut().expand_prompt_var("PS4", "", params).await;
		self.options_mut().print_commands_and_arguments = xtrace;
		let mut prefix = prefix.unwrap_or_default();

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
	/// mechanisms. An error caused by running out of file descriptors is
	/// shown with the process's open-file limit.
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

		// The error that abandoned the command was reported where it
		// happened, however many builtins have wrapped it since; there is
		// nothing more to show.
		if err.already_reported() {
			return Ok(());
		}

		let restated = err.with_open_file_limit();
		let str = self
			.error_formatter
			.format_error(restated.as_ref().unwrap_or(err), self);
		file.write_all_async(str.as_bytes()).await?;

		Ok(())
	}

	/// Reports `err`, an error that abandons the rest of the command line it
	/// occurred in (a word that failed to expand, or a function, `source` or
	/// `eval` that would nest too deep), on `stderr`, the standard error in
	/// effect where it happened, as Bash does, unless `report` is false.
	/// Returns the error that carries the abandonment on to the end of the
	/// line without being reported again (see
	/// [`error::Error::abandons_command`]). An error already carried that way
	/// (see [`error::Error::already_reported`]), wrapped by a builtin or not,
	/// passes through unreported. A report that cannot be written, whatever
	/// the write fails with (a closed or full standard error, or any other
	/// error), leaves the error unreported, as in Bash: no other standard
	/// error gets it. Writing the report needs no new descriptor, since a copy
	/// of an open file shares its descriptor, so a process that has run out of
	/// descriptors still reports it.
	pub(crate) async fn report_abandonment(
		&self,
		stderr: &mut openfiles::OpenFile,
		report: bool,
		err: error::Error,
	) -> error::Error {
		if err.already_reported() {
			return err;
		}
		if report {
			let _ = self.display_error(stderr, &err).await;
		}
		err.into_abandonment()
	}
}
