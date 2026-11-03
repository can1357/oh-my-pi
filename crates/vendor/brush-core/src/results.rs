//! Encapsulation of execution results.

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

use tokio_util::sync::CancellationToken;

use crate::{error, processes};

/// Represents the result of executing a command or similar item.
#[derive(Default)]
pub struct ExecutionResult {
	/// The control flow transition to apply after execution.
	pub next_control_flow: ExecutionControlFlow,
	/// The exit code resulting from execution.
	pub exit_code:         ExecutionExitCode,
}

impl ExecutionResult {
	/// Returns a new `ExecutionResult` with the given exit code.
	///
	/// # Arguments
	///
	/// * `exit_code` - The exit code of the command.
	pub fn new(exit_code: u8) -> Self {
		Self { exit_code: exit_code.into(), ..Self::default() }
	}

	/// Returns a new `ExecutionResult` with an exit code of 0.
	pub const fn success() -> Self {
		Self {
			next_control_flow: ExecutionControlFlow::Normal,
			exit_code:         ExecutionExitCode::Success,
		}
	}

	/// Returns a new `ExecutionResult` with a general error exit code.
	pub const fn general_error() -> Self {
		Self {
			next_control_flow: ExecutionControlFlow::Normal,
			exit_code:         ExecutionExitCode::GeneralError,
		}
	}

	/// Returns whether the command was successful.
	pub const fn is_success(&self) -> bool {
		self.exit_code.is_success()
	}

	/// Returns whether the execution result indicates normal control flow.
	/// Returns `false` if there is any control flow transition requested.
	pub const fn is_normal_flow(&self) -> bool {
		matches!(self.next_control_flow, ExecutionControlFlow::Normal)
	}

	/// Returns whether the execution result indicates a loop break.
	pub const fn is_break(&self) -> bool {
		matches!(self.next_control_flow, ExecutionControlFlow::BreakLoop { .. })
	}

	/// Returns whether the execution result indicates a loop continue.
	pub const fn is_continue(&self) -> bool {
		matches!(self.next_control_flow, ExecutionControlFlow::ContinueLoop { .. })
	}

	/// Returns whether the execution result indicates an early return
	/// from a function or script, an exit from the shell, or an abandoned
	/// command (see [`ExecutionControlFlow::DiscardCommand`]). Returns `false`
	/// otherwise, including loop breaks or continues.
	pub const fn is_return_or_exit(&self) -> bool {
		matches!(
			self.next_control_flow,
			ExecutionControlFlow::ReturnFromFunctionOrScript
				| ExecutionControlFlow::ExitShell
				| ExecutionControlFlow::DiscardCommand
		)
	}
}

impl From<ExecutionExitCode> for ExecutionResult {
	fn from(exit_code: ExecutionExitCode) -> Self {
		Self { next_control_flow: ExecutionControlFlow::Normal, exit_code }
	}
}

impl From<ExecutionWaitResult> for ExecutionResult {
	fn from(wait_result: ExecutionWaitResult) -> Self {
		match wait_result {
			ExecutionWaitResult::Completed(result) => result,
			// TODO(jobs): We need to job-manage the stopped process.
			ExecutionWaitResult::Stopped(_, signal) => Self::new(128_u8.saturating_add(signal)),
		}
	}
}

impl From<std::process::Output> for ExecutionResult {
	fn from(output: std::process::Output) -> Self {
		if let Some(code) = output.status.code() {
			#[expect(clippy::cast_sign_loss)]
			return Self::new((code & 0xff) as u8);
		}

		#[cfg(unix)]
		if let Some(signal) = output.status.signal() {
			#[expect(clippy::cast_sign_loss)]
			return Self::new((signal & 0xff) as u8 + 128);
		}

		tracing::error!("unhandled process exit");
		Self::new(127)
	}
}

/// Represents an exit code from execution.
#[derive(Clone, Copy, Default)]
pub enum ExecutionExitCode {
	/// Indicates successful execution.
	#[default]
	Success,
	/// Indicates a general error.
	GeneralError,
	/// Indicates invalid usage.
	InvalidUsage,
	/// Cannot execute the command.
	CannotExecute,
	/// Indicates a command or similar item was not found.
	NotFound,
	/// Indicates execution was interrupted.
	Interrupted,
	/// Indicates a broken pipe (SIGPIPE) was encountered.
	BrokenPipe,
	/// Indicates unimplemented functionality was encountered.
	Unimplemented,
	/// A custom exit code.
	Custom(u8),
	/// A status above 255, from 256 to 383: Bash's `wait_for` returns 128
	/// plus the `WSTOPSIG` value of the status of a stopped job's first
	/// process, which is its exit status once it has exited. A foreground
	/// job keeps it whole in `$?`; `wait`, `fg` and `return` pass it through
	/// `builtin_status`, which keeps only 256. A process exit keeps the low
	/// 8 bits.
	StoppedJob(u16),
}

impl ExecutionExitCode {
	/// Returns whether the exit code indicates success.
	pub const fn is_success(&self) -> bool {
		matches!(self, Self::Success)
	}

	/// The status `$?` shows: 0 to 383.
	pub fn status(&self) -> u16 {
		match self {
			Self::StoppedJob(status) => *status,
			code => u16::from(u8::from(code)),
		}
	}

	/// The status of a stopped job, 128 plus `word` (see
	/// [`ExecutionExitCode::StoppedJob`]).
	pub fn stopped_job(word: u8) -> Self {
		match 128 + u16::from(word) {
			status @ 0..=255 => Self::from(u8::try_from(status).unwrap_or(u8::MAX)),
			status => Self::StoppedJob(status),
		}
	}

	/// The exit status a builtin returns for `status`, as Bash's
	/// `builtin_status` maps the values above 256: 257 and 258 (its syntax
	/// and usage sentinels) are 2, every other one is 1.
	pub fn from_builtin_status(status: u32) -> Self {
		match status {
			0..=255 => Self::from(u8::try_from(status).unwrap_or(u8::MAX)),
			256 => Self::StoppedJob(256),
			257 | 258 => Self::InvalidUsage,
			_ => Self::GeneralError,
		}
	}
}

impl From<u16> for ExecutionExitCode {
	/// Takes a status `$?` holds (see [`ExecutionExitCode::status`]) as a
	/// builtin returns it (see [`ExecutionExitCode::from_builtin_status`]).
	fn from(status: u16) -> Self {
		Self::from_builtin_status(u32::from(status))
	}
}

impl From<ExecutionExitCode> for u16 {
	fn from(code: ExecutionExitCode) -> Self {
		code.status()
	}
}

impl From<u8> for ExecutionExitCode {
	fn from(code: u8) -> Self {
		match code {
			0 => Self::Success,
			1 => Self::GeneralError,
			2 => Self::InvalidUsage,
			99 => Self::Unimplemented,
			126 => Self::CannotExecute,
			127 => Self::NotFound,
			130 => Self::Interrupted,
			141 => Self::BrokenPipe,
			code => Self::Custom(code),
		}
	}
}

impl From<ExecutionExitCode> for u8 {
	fn from(code: ExecutionExitCode) -> Self {
		Self::from(&code)
	}
}

impl From<&ExecutionExitCode> for u8 {
	fn from(code: &ExecutionExitCode) -> Self {
		match code {
			ExecutionExitCode::Success => 0,
			ExecutionExitCode::GeneralError => 1,
			ExecutionExitCode::InvalidUsage => 2,
			ExecutionExitCode::Unimplemented => 99,
			ExecutionExitCode::CannotExecute => 126,
			ExecutionExitCode::NotFound => 127,
			ExecutionExitCode::Interrupted => 130,
			ExecutionExitCode::BrokenPipe => 141,
			ExecutionExitCode::Custom(code) => *code,
			ExecutionExitCode::StoppedJob(status) => status.to_le_bytes()[0],
		}
	}
}

/// Represents a control flow transition to apply.
#[derive(Clone, Copy, Default)]
pub enum ExecutionControlFlow {
	/// Continue normal execution.
	#[default]
	Normal,
	/// Break out of an enclosing loop.
	BreakLoop {
		/// Identifies which level of nested loops to break out of. 0 indicates
		/// the innermost loop, 1 indicates the next outer loop, and so on.
		levels: usize,
	},
	/// Continue to the next iteration of an enclosing loop.
	ContinueLoop {
		/// Identifies which level of nested loops to continue. 0 indicates the
		/// innermost loop, 1 indicates the next outer loop, and so on.
		levels: usize,
	},
	/// Return from the current function or script.
	ReturnFromFunctionOrScript,
	/// Exit the shell.
	ExitShell,
	/// Abandon the command being run, as Bash's `jump_to_top_level
	/// (DISCARD)` does: every enclosing command ends, functions and loops
	/// included, up to the program text it was read from (a line of the
	/// script, `eval`, `source` or a trap handler), which goes on with its
	/// next command; in a subshell the subshell ends.
	DiscardCommand,
}

impl ExecutionControlFlow {
	/// Attempts to decrement the loop levels for `BreakLoop` or `ContinueLoop`.
	/// If the levels reach zero, transitions to `Normal`. If the control flow is
	/// not a loop break or continue, no changes are made.
	#[must_use]
	pub const fn try_decrement_loop_levels(&self) -> Self {
		match self {
			Self::BreakLoop { levels: 0 } | Self::ContinueLoop { levels: 0 } => Self::Normal,
			Self::BreakLoop { levels } => Self::BreakLoop { levels: *levels - 1 },
			Self::ContinueLoop { levels } => Self::ContinueLoop { levels: *levels - 1 },
			control_flow => *control_flow,
		}
	}
}

/// Represents the result of spawning an execution; captures both execution
/// that immediately returns as well as execution that starts a process
/// asynchronously.
pub enum ExecutionSpawnResult {
	/// Indicates that the execution completed.
	Completed(ExecutionResult),
	/// Indicates that a process was started and had not yet completed.
	StartedProcess(processes::ChildProcess),
	/// Indicates that a task was started to handle the execution asynchronously.
	StartedTask(tokio::task::JoinHandle<Result<ExecutionResult, error::Error>>),
}

impl From<ExecutionResult> for ExecutionSpawnResult {
	fn from(result: ExecutionResult) -> Self {
		Self::Completed(result)
	}
}

/// What Bash keeps of how a waited command ended, besides its result.
#[derive(Clone, Copy, Debug, Default)]
pub struct WaitedStatus {
	/// How an external process ended; `None` for a command that ran in the
	/// shell, one that stopped, and one that cancellation killed.
	pub process:   Option<processes::ProcessStatus>,
	/// The `WSTOPSIG` value of the command's wait status, which Bash's
	/// `wait_for` adds to 128 for a stopped job whose first process has
	/// ended: the exit status of a process that exited, 0 for one a signal
	/// killed (see [`processes::ProcessStatus::stop_signal_word`]), the
	/// status of a command the shell ran itself, which Bash would have run as
	/// a child that exits with it, and 0 for one that stopped or that
	/// cancellation killed.
	pub stop_word: u8,
}

impl ExecutionSpawnResult {
	/// Waits for the command to complete without a cancellation token.
	pub async fn wait(self) -> Result<ExecutionWaitResult, error::Error> {
		self.wait_with_cancel(None).await
	}

	/// Waits for the command to complete.
	///
	/// If a cancellation token is provided and triggered, the process will be killed.
	pub async fn wait_with_cancel(
		self,
		cancel_token: Option<CancellationToken>,
	) -> Result<ExecutionWaitResult, error::Error> {
		Ok(self.wait_with_status(cancel_token).await?.0)
	}

	/// Waits like [`Self::wait_with_cancel`], and also returns what Bash
	/// keeps of how the command ended (see [`WaitedStatus`]).
	pub async fn wait_with_status(
		self,
		cancel_token: Option<CancellationToken>,
	) -> Result<(ExecutionWaitResult, WaitedStatus), error::Error> {
		let completed = |result: ExecutionResult| {
			let stop_word = u8::from(result.exit_code);
			(ExecutionWaitResult::Completed(result), WaitedStatus { process: None, stop_word })
		};
		let result = match self {
			Self::StartedProcess(mut child) => {
				// Wait for the process to exit or for a relevant signal, whichever happens
				// first.
				match child.wait(cancel_token).await? {
					processes::ProcessWaitResult::Completed(output) => {
						let status = processes::ProcessStatus::from_exit_status(&output.status);
						let waited = WaitedStatus { process: Some(status), stop_word: status.stop_signal_word() };
						(ExecutionWaitResult::Completed(ExecutionResult::from(output)), waited)
					},
					processes::ProcessWaitResult::Stopped(signal) => {
						(ExecutionWaitResult::Stopped(child, signal), WaitedStatus::default())
					},
					processes::ProcessWaitResult::Cancelled => {
						(ExecutionWaitResult::Completed(ExecutionResult::new(130)), WaitedStatus::default())
					},
				}
			},
			Self::Completed(result) => completed(result),
			Self::StartedTask(join_handle) => completed(join_handle.await??),
		};

		Ok(result)
	}
	pub(crate) async fn poll(self) -> Result<ExecutionWaitResult, error::Error> {
		let result = match self {
			Self::StartedProcess(child) => ExecutionWaitResult::Stopped(child, 0),
			Self::Completed(result) => ExecutionWaitResult::Completed(result),
			Self::StartedTask(join_handle) => {
				// TODO(jobs): This isn't right.
				let result = join_handle.await?;
				ExecutionWaitResult::Completed(result?)
			},
		};

		Ok(result)
	}
}

/// Represents the result of waiting for an execution to complete.
pub enum ExecutionWaitResult {
	/// Indicates that the execution completed.
	Completed(ExecutionResult),
	/// Indicates that the execution was stopped, with the `WSTOPSIG`.
	Stopped(processes::ChildProcess, u8),
}
