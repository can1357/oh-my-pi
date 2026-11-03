//! I/O support for shell instances.

use crate::{
	ExecutionExitCode, ExecutionResult, error, extensions, ioutils, openfiles, traps::SignalDisposition,
};

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

	/// Outputs `set -x` style trace output for a command. A failed write is
	/// ignored, except a write to a pipe with no reader, which raises SIGPIPE
	/// (see [`Self::raise_sigpipe`]).
	///
	/// # Arguments
	///
	/// * `command` - The command to trace.
	///
	/// # Errors
	///
	/// The broken-pipe error when SIGPIPE killed the shell: the caller runs
	/// nothing more.
	pub(crate) async fn trace_command<S: AsRef<str>>(
		&mut self,
		params: &crate::interp::ExecutionParameters,
		command: S,
	) -> Result<(), error::Error> {
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
			if let Err(err) = trace_file.write_all_async(line.as_bytes()).await
				&& err.kind() == std::io::ErrorKind::BrokenPipe
			{
				return self.raise_sigpipe(err);
			}
		}
		Ok(())
	}

	/// Applies SIGPIPE to this shell after one of its own writes (`err`)
	/// found a pipe with no reader, as the kernel applies it to a Bash
	/// process, per the shell's disposition: the default action kills the
	/// shell (see [`Self::wrote_to_broken_pipe`]) and returns `err`; an
	/// ignored SIGPIPE does nothing; a caught one leaves its handler pending
	/// (see [`Self::run_pending_sigpipe_trap`]).
	pub(crate) fn raise_sigpipe(&mut self, err: std::io::Error) -> Result<(), error::Error> {
		match self.traps.sigpipe_disposition() {
			SignalDisposition::Default => {
				self.note_broken_pipe_write();
				Err(err.into())
			},
			SignalDisposition::Ignored => Ok(()),
			SignalDisposition::Caught => {
				self.sigpipe_trap_pending = true;
				Ok(())
			},
		}
	}

	/// Runs the handler of a caught SIGPIPE that a write raised, once the
	/// pipeline whose command wrote has ended, as Bash runs a pending trap
	/// after the command (in `params`, the context without its redirections).
	///
	/// Returns the handler's result when it exits the shell or returns from
	/// a function (`trap 'exit 7' PIPE`): the caller ends with it, as the
	/// handler's `exit` or `return` acts at the point the trap ran.
	pub(crate) async fn run_pending_sigpipe_trap(
		&mut self,
		params: &crate::interp::ExecutionParameters,
	) -> Result<Option<ExecutionResult>, error::Error> {
		if !std::mem::take(&mut self.sigpipe_trap_pending) {
			return Ok(None);
		}
		#[cfg(unix)]
		{
			let signal = crate::traps::TrapSignal::Signal(crate::sys::signal::Signal::SIGPIPE);
			let result = self.invoke_trap_handler(signal, params).await?;
			if result.is_return_or_exit() {
				return Ok(Some(result));
			}
		}
		Ok(None)
	}

	/// Returns whether this shell ignores SIGPIPE (`trap '' PIPE`): the
	/// commands it runs, builtins standing in for programs included, inherit
	/// that, so a write to a pipe with no reader fails with an error instead
	/// of killing them.
	pub fn ignores_sigpipe(&self) -> bool {
		self.traps.sigpipe_disposition() == SignalDisposition::Ignored
	}

	/// Returns the outcome a subshell leaves for its parent: `outcome`, unless
	/// a write of the subshell's own found a pipe with no reader and killed
	/// it, which leaves the SIGPIPE status whatever it went on to compute.
	pub(crate) fn subshell_outcome(
		&self,
		outcome: Result<ExecutionResult, error::Error>,
	) -> Result<ExecutionResult, error::Error> {
		if self.wrote_to_broken_pipe {
			Ok(ExecutionResult::broken_pipe_exit())
		} else {
			outcome
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

	/// Forgets a broken-pipe write, so the shell runs commands again, and a
	/// pending caught SIGPIPE whose handler has not run.
	///
	/// An embedder that runs one top-level command after another in this
	/// shell calls this before each, as each starts in a live shell. Nothing
	/// inside a run calls it: a trap handler, an `eval` or a `mapfile`
	/// callback run in a killed shell stays dead, as no command runs in a Bash
	/// process after SIGPIPE kills it.
	pub const fn forget_broken_pipe_write(&mut self) {
		self.wrote_to_broken_pipe = false;
		self.sigpipe_trap_pending = false;
	}

	/// Forgets the SIGPIPE death of a command that stands in for a separate
	/// program: that program's process took it with it (see
	/// `commands::execute_builtin_command`). A caught SIGPIPE pending from a
	/// write of the shell's own before the command (a `set -x` line) stays
	/// pending, so its handler runs when the command ends.
	pub(crate) const fn forget_child_death(&mut self) {
		self.wrote_to_broken_pipe = false;
	}

	/// Ends a command that failed with `err`: reports `err` on `stderr`, when
	/// given, and returns the result the command leaves.
	///
	/// `writer` is the process that reports the error when Bash runs the
	/// command; an error from launching an external command is the child's,
	/// whatever `writer` says. The error acts on that process: a fatal error
	/// ends this shell only when the shell itself is the writer, while a
	/// child or subshell leaves only its exit status. When `err` is a write
	/// of the writer's own to a pipe with no reader, or reporting `err` is,
	/// SIGPIPE acts on the writer per its disposition: a child or subshell
	/// inherits an ignored SIGPIPE, and resets a caught one to the default
	/// action. The default action kills the writer: a killed child or
	/// subshell leaves status 141; a killed shell exits with it (see
	/// [`ExecutionResult::broken_pipe_exit`]) and runs nothing more. Nothing
	/// reports the broken pipe itself then. Otherwise the error's own result
	/// comes back, after a caught SIGPIPE's handler is left pending.
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
		let disposition = match writer {
			DiagnosticWriter::Shell => self.traps.sigpipe_disposition(),
			DiagnosticWriter::Subshell | DiagnosticWriter::Child if self.ignores_sigpipe() => {
				SignalDisposition::Ignored
			},
			DiagnosticWriter::Subshell | DiagnosticWriter::Child => SignalDisposition::Default,
		};
		let mut raised = err.is_broken_pipe();
		if !(raised && disposition == SignalDisposition::Default)
			&& let Some(stderr) = stderr
		{
			raised |= self
				.display_error(stderr, &err)
				.await
				.is_err_and(|write_err| write_err.is_broken_pipe());
		}
		let own_write_failed = err.is_broken_pipe();
		if raised {
			match disposition {
				SignalDisposition::Default => {
					return match writer {
						DiagnosticWriter::Child | DiagnosticWriter::Subshell => {
							ExecutionExitCode::BrokenPipe.into()
						},
						DiagnosticWriter::Shell => {
							self.note_broken_pipe_write();
							ExecutionResult::broken_pipe_exit()
						},
					};
				},
				SignalDisposition::Ignored => {},
				// A child or subshell resets a caught SIGPIPE, so only this
				// shell's own write can leave its handler pending.
				SignalDisposition::Caught => self.sigpipe_trap_pending = true,
			}
		}
		let mut result = err.into_result(self);
		// A write that failed without killing its writer is a write error.
		if own_write_failed {
			result.exit_code = ExecutionExitCode::GeneralError;
		}
		match writer {
			DiagnosticWriter::Shell => result,
			DiagnosticWriter::Child | DiagnosticWriter::Subshell => result.exit_code.into(),
		}
	}
}
