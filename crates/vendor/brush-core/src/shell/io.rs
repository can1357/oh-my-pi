//! I/O support for shell instances.

use crate::{ExecutionExitCode, ExecutionResult, error, extensions, ioutils, openfiles};

/// The process that writes a diagnostic when Bash runs the command.
#[derive(Clone, Copy)]
pub(crate) enum DiagnosticWriter {
	/// The shell that reports the error.
	Shell,
	/// A subshell of the reporting shell (a pipeline stage, `( … )`), whose
	/// error the reporting shell displays on its behalf.
	Subshell,
	/// The child Bash forks for an external command, before it executes it.
	Child,
}

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
	/// fatal. A failed trace write is ignored, except a write to a pipe with no
	/// reader, which kills a Bash shell: see [`Self::note_broken_pipe_write`].
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
			if trace_file
				.write_all_async(line.as_bytes())
				.await
				.is_err_and(|err| err.kind() == std::io::ErrorKind::BrokenPipe)
			{
				self.note_broken_pipe_write();
			}
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
		let restated = err.with_open_file_limit();
		let str = self
			.error_formatter
			.format_error(restated.as_ref().unwrap_or(err), self);
		file.write_all_async(str.as_bytes()).await?;

		Ok(())
	}

	/// Returns whether this shell wrote to a pipe with no reader, which kills
	/// a Bash shell; this one then runs nothing more.
	pub(crate) const fn wrote_to_broken_pipe(&self) -> bool {
		self.wrote_to_broken_pipe
	}

	/// Records that a write of this shell's own (a builtin's output, a
	/// diagnostic, a trace line) found a pipe with no reader.
	pub(crate) const fn note_broken_pipe_write(&mut self) {
		self.wrote_to_broken_pipe = true;
	}

	/// Forgets a broken-pipe write, so the shell runs commands again.
	///
	/// A command that stands in for a separate program takes the write with it
	/// (see `commands::execute_builtin_command`). An embedder that runs one
	/// top-level command after another in this shell calls this before each,
	/// as each starts in a live shell. Nothing inside a run calls it: a trap
	/// handler, an `eval` or a `mapfile` callback run in a killed shell stays
	/// dead, as no command runs in a Bash process after SIGPIPE kills it.
	pub const fn forget_broken_pipe_write(&mut self) {
		self.wrote_to_broken_pipe = false;
	}

	/// Returns whether Bash runs command `name` in a child process of its own:
	/// `name` is neither a function nor a builtin of the shell's own. A builtin
	/// that stands in for a separate program (see
	/// [`crate::builtins::Registration::program`]) counts as one.
	pub(crate) fn runs_as_separate_program(&self, name: &str) -> bool {
		self.funcs.get(name).is_none()
			&& !self
				.builtins
				.get(name)
				.is_some_and(|builtin| !builtin.disabled && !builtin.program)
	}

	/// Ends a command that failed with `err`: reports `err` on `stderr`, when
	/// given, and returns the result the command leaves.
	///
	/// `writer` is the process that writes the diagnostic when Bash runs the
	/// command; an error from launching an external command is the child's,
	/// whatever `writer` says. The error's own result comes back unless a
	/// write found a pipe with no reader, which kills the writing process
	/// with SIGPIPE: either `err` is that write of the shell's own, or
	/// reporting `err` on `stderr` is. A killed child leaves status 141; a
	/// killed shell or subshell exits with it (see
	/// [`ExecutionResult::broken_pipe_exit`]), and a killed shell runs
	/// nothing more. Nothing reports the broken pipe itself.
	pub(crate) async fn conclude_error(
		&mut self,
		err: error::Error,
		stderr: Option<&mut openfiles::OpenFile>,
		writer: DiagnosticWriter,
	) -> ExecutionResult {
		let writer = if err.is_reported_by_child() {
			DiagnosticWriter::Child
		} else {
			writer
		};
		let killed = err.is_broken_pipe()
			|| match stderr {
				Some(stderr) => self
					.display_error(stderr, &err)
					.await
					.is_err_and(|write_err| write_err.is_broken_pipe()),
				None => false,
			};
		if !killed {
			return err.into_result(self);
		}
		match writer {
			DiagnosticWriter::Child => ExecutionExitCode::BrokenPipe.into(),
			DiagnosticWriter::Subshell => ExecutionResult::broken_pipe_exit(),
			DiagnosticWriter::Shell => {
				self.note_broken_pipe_write();
				ExecutionResult::broken_pipe_exit()
			},
		}
	}
}
