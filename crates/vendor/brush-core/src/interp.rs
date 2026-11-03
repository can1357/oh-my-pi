use std::{
	collections::VecDeque,
	io::Write,
	path::{Path, PathBuf},
	sync::{Arc, atomic::AtomicBool},
};

use brush_parser::ast::{self, CommandPrefixOrSuffixItem};
use itertools::Itertools;

use tokio_util::sync::CancellationToken;

use crate::{
	ShellFd,
	arithmetic::{self, ExpandAndEvaluate},
	commands::{self, CommandArg},
	env::{EnvironmentLookup, EnvironmentScope, valid_variable_name},
	error, expansion, extendedtests, extensions, ioutils, jobs, openfiles,
	openfiles::{OpenFile, OpenFiles},
	pipetap::{self, PipeTap},
	results::{ExecutionControlFlow, ExecutionExitCode, ExecutionResult, ExecutionSpawnResult, ExecutionWaitResult},
	shell::Shell,
	sys, timing,
	traps::JobSignals,
	variables::{ArrayLiteral, ShellValue, ShellValueLiteral, ShellValueUnsetType, ShellVariable},
};

/// Encapsulates the context of execution in a command pipeline.
struct PipelineExecutionContext<'a, SE: extensions::ShellExtensions> {
	/// The shell in which the command should be executed.
	shell:            commands::ShellForCommand<'a, SE>,
	/// Process group ID for spawned processes.
	process_group_id: Option<i32>,
	/// Whether this command is part of a multi-command pipeline.
	in_pipeline:       bool,
}

/// Information about an expanded external command launch.
pub struct ExternalCommandInfo<'a> {
	/// Shell command name before path resolution.
	pub command_name:    &'a str,
	/// Resolved executable path used for the process launch.
	pub executable_path: &'a str,
	/// Expanded process arguments, excluding `argv[0]`.
	pub args:            Vec<&'a str>,
}

/// Marker strings written around a launched command's output.
#[derive(Clone)]
pub struct ExternalCommandOutputMarkers {
	/// Marker written immediately before the process is spawned.
	pub start_marker:      String,
	/// Prefix for the completion marker; the numeric exit code is inserted
	/// between this prefix and [`Self::end_marker_suffix`].
	pub end_marker_prefix: String,
	/// Suffix for the completion marker.
	pub end_marker_suffix: String,
}

/// Optional hook used by embedders that need to identify output boundaries
/// for individual external command launches.
pub trait ExternalCommandOutputMarker: Send + Sync {
	/// Returns markers for this external command, or `None` to leave its
	/// output unmarked.
	fn markers_for_external_command(
		&self,
		info: ExternalCommandInfo<'_>,
	) -> Option<ExternalCommandOutputMarkers>;
}

/// Optional hook invoked after each external command is spawned.
///
/// It reports the OS identity of the child so embedders can scope
/// process-tree teardown (cancellation cleanup) to exactly the processes a
/// given run launched, rather than diffing the whole host process tree. That
/// cannot distinguish children of concurrent runs sharing one host process.
///
/// It is not called for reparented launches (`detach_reparent`): those
/// deliberately escape the shell's descendant tree (e.g. `nohup cmd &`) and
/// must survive teardown, so they are intentionally left unowned.
pub trait SpawnObserver: Send + Sync {
	/// Reports a freshly spawned external child. `pgid` is the child's process
	/// group id when known (always its own pid under `NewProcessGroup`).
	fn on_spawn(&self, pid: i32, pgid: Option<i32>);
}

/// Parameters for execution.
#[derive(Clone, Default)]
pub struct ExecutionParameters {
	/// The open files tracked by the current context.
	open_files:               openfiles::OpenFiles,
	/// Policy for how to manage spawned external processes.
	pub process_group_policy: ProcessGroupPolicy,
	/// Whether external commands spawned in this context should reparent out of
	/// the shell's descendant tree (double-fork on Unix) so they survive the
	/// host's descendant-walk teardown. Set for the operand of a transparent
	/// background wrapper such as `nohup cmd &`.
	pub detach_reparent: bool,
	/// Optional cancellation token shared with callers.
	cancel_token:             Option<CancellationToken>,
	/// Optional command-output marker hook.
	command_output_marker:    Option<Arc<dyn ExternalCommandOutputMarker>>,
	/// Whether command-output marking was disabled by shell syntax that can
	/// consume or redirect command output.
	command_output_disabled:  bool,
	/// Whether `errexit` (exit on error) behavior should be
	/// suppressed in this execution context. Defaults to `false`.
	pub suppress_errexit:     bool,
	/// Whether the program run in this context continues the input line the
	/// program before it ran, as each later segment of one line does when an
	/// embedding shell runs the segments of `a; b` one at a time. Its first
	/// complete command then starts no new input line, so the shell forgets
	/// no reported job before it (see
	/// [`jobs::JobManager::remove_reported_jobs`]). A program it runs in turn,
	/// such as an `eval` string, reads lines of its own. Defaults to `false`.
	pub continues_input_line: bool,
	/// Whether this runs under the `command` builtin, as Bash's
	/// `executing_command_builtin` records: a failed assignment statement
	/// then abandons the command being run instead of exiting a POSIX-mode
	/// shell (`do_assignment_statements`). Defaults to `false`.
	pub executing_command_builtin: bool,
	/// Optional hook reporting spawned external children for scoped teardown.
	spawn_observer:           Option<Arc<dyn SpawnObserver>>,
	/// Optional hook mirroring the bytes that cross pipeline pipes.
	pipe_tap:                 Option<Arc<dyn PipeTap>>,
	/// Optional flag a command raises when it reports an error yet goes on,
	/// so its exit status does not show the failure.
	reported_error:           Option<Arc<AtomicBool>>,
	/// Whether redirections to a FIFO are left for the external command's
	/// child to make (see [`DeferredRedirect`]). Set for a background external
	/// command, whose parent spawns it before going on.
	defer_fifo_redirects:     bool,
	/// The redirections left for the child, in order.
	deferred_redirects:       Vec<DeferredRedirect>,
	/// Whether this context's own cancellation goes unreported; see
	/// [`ExecutionParameters::set_quiet_cancellation`].
	quiet_cancellation:       bool,
}

/// A redirection a background external command's child makes itself, after
/// the parent has spawned it. Opening a FIFO waits for its other end, which
/// may be the next command (`/bin/cat < f & echo hi > f`), so the parent must
/// not wait for it, as bash does not: bash opens it in the forked child. The
/// child runs these through `/bin/sh -c 'exec "$@" …'` and becomes the
/// command, so `$!`, `wait`, `kill` and `jobs` see its real pid.
///
/// Once one redirection is deferred, each later one that sets or reads a
/// descriptor a deferred one sets or reads is deferred too, so the child makes
/// them all in the order written: in `/bin/echo x >f >/dev/null &` the second
/// open replaces the first in the child, and the parent never opens the FIFO.
#[derive(Clone)]
pub(crate) enum DeferredRedirect {
	/// `fd OP path`; `options` reopen it in the parent if the redirections
	/// must be made there after all.
	Open { fd: ShellFd, op: &'static str, path: String, options: pi_vfs::OpenOptions },
	/// `fd>&from`.
	Duplicate { fd: ShellFd, from: ShellFd },
	/// `fd>&-`.
	Close { fd: ShellFd },
}

impl DeferredRedirect {
	/// The descriptor this redirection sets.
	const fn fd(&self) -> ShellFd {
		match self {
			Self::Open { fd, .. } | Self::Duplicate { fd, .. } | Self::Close { fd } => *fd,
		}
	}

	/// Whether this redirection sets or reads `fd`.
	const fn touches(&self, fd: ShellFd) -> bool {
		self.fd() == fd || matches!(self, Self::Duplicate { from, .. } if *from == fd)
	}
}

/// The highest descriptor a POSIX `sh` redirection is sure to accept.
const MAX_DEFERRED_FD: ShellFd = 9;

impl ExecutionParameters {
	/// The redirections left for an external command's child to make; see
	/// [`DeferredRedirect`].
	pub(crate) fn deferred_redirects(&self) -> &[DeferredRedirect] {
		&self.deferred_redirects
	}

	/// Whether the child sets `fd` itself, so what this process holds there is
	/// not what the command reads or writes.
	pub(crate) fn sets_deferred(&self, fd: ShellFd) -> bool {
		self.deferred_redirects.iter().any(|redirect| redirect.fd() == fd)
	}

	/// Whether a deferred redirection sets or reads `fd`, so a later
	/// redirection of `fd` must be made after it.
	fn touches_deferred(&self, fd: ShellFd) -> bool {
		self.deferred_redirects.iter().any(|redirect| redirect.touches(fd))
	}

	/// Whether a deferred redirection reads `fd` before any of them sets it, so
	/// the child's duplication (or the parent's, if they are made there after
	/// all) takes the descriptor this process holds now: `>f 1>&2 2>err` and
	/// the move `>f 1>&3-` each read fd 2 or 3 as it is before `2>err` or the
	/// close of fd 3.
	fn reads_deferred_source(&self, fd: ShellFd) -> bool {
		self.deferred_redirects
			.iter()
			.find(|redirect| redirect.touches(fd))
			.is_some_and(|redirect| matches!(redirect, DeferredRedirect::Duplicate { from, .. } if *from == fd))
	}

	/// Leaves `redirect` for the child. The null device stands in for its
	/// descriptor here until then, except where a deferred duplication still
	/// reads the descriptor this process holds.
	fn defer(&mut self, redirect: DeferredRedirect) -> Result<(), error::Error> {
		let fd = redirect.fd();
		if !self.reads_deferred_source(fd) {
			self.open_files.set_fd(fd, openfiles::null()?);
		}
		self.deferred_redirects.push(redirect);
		Ok(())
	}

	/// Leaves the end of this context unreported once its token has fired:
	/// the errors that stop the commands still running (`interrupted`, or a
	/// builtin's own `mapfile: interrupted`) are not printed. `timeout` sets
	/// this for its operand, which GNU `timeout` kills without a word; the
	/// status reports the timeout.
	pub fn set_quiet_cancellation(&mut self, quiet: bool) {
		self.quiet_cancellation = quiet;
	}

	/// Whether an error that ends a command in this context is printed: not
	/// once the context was cancelled with its cancellation set to go
	/// unreported.
	pub(crate) fn reports_errors(&self) -> bool {
		!(self.quiet_cancellation && self.is_cancelled())
	}

	/// Assigns a cancellation token for this execution.
	pub fn set_cancel_token(&mut self, token: CancellationToken) {
		self.cancel_token = Some(token);
	}

	/// Returns the cancellation token, if present.
	pub fn cancel_token(&self) -> Option<CancellationToken> {
		self.cancel_token.clone()
	}

	/// Returns true when cancellation has been requested.
	pub fn is_cancelled(&self) -> bool {
		self
			.cancel_token
			.as_ref()
			.is_some_and(CancellationToken::is_cancelled)
	}

	/// Assigns an external-command output marker hook for this execution.
	pub fn set_command_output_marker(&mut self, marker: Arc<dyn ExternalCommandOutputMarker>) {
		self.command_output_marker = Some(marker);
		self.command_output_disabled = false;
	}

	/// Disables external-command output marking for this execution branch.
	pub const fn disable_command_output_marking(&mut self) {
		self.command_output_disabled = true;
	}

	/// Returns the active output marker hook, if marking is still safe.
	pub fn command_output_marker(&self) -> Option<&Arc<dyn ExternalCommandOutputMarker>> {
		if self.command_output_disabled {
			return None;
		}
		self.command_output_marker.as_ref()
	}

	/// Assigns a spawn-observer hook for this execution.
	pub fn set_spawn_observer(&mut self, observer: Arc<dyn SpawnObserver>) {
		self.spawn_observer = Some(observer);
	}

	/// Returns the active spawn-observer hook, if any.
	pub fn spawn_observer(&self) -> Option<&Arc<dyn SpawnObserver>> {
		self.spawn_observer.as_ref()
	}

	/// Assigns a hook that mirrors every pipeline pipe of this execution.
	pub fn set_pipe_tap(&mut self, tap: Arc<dyn PipeTap>) {
		self.pipe_tap = Some(tap);
	}

	/// Returns the active pipe-tap hook, if any.
	pub fn pipe_tap(&self) -> Option<&Arc<dyn PipeTap>> {
		self.pipe_tap.as_ref()
	}

	/// Assigns the flag commands raise when they report an error yet go on.
	pub fn set_reported_error(&mut self, flag: Arc<AtomicBool>) {
		self.reported_error = Some(flag);
	}

	/// Returns the flag commands raise when they report an error yet go on,
	/// if any.
	pub fn reported_error(&self) -> Option<&Arc<AtomicBool>> {
		self.reported_error.as_ref()
	}

	/// Returns the standard input file; usable with `write!` et al.
	///
	/// # Arguments
	///
	/// * `shell` - The shell context.
	pub fn stdin(&self, shell: &Shell<impl extensions::ShellExtensions>) -> OpenFile {
		self.try_stdin(shell).unwrap_or_else(|| {
			ioutils::FailingReaderWriter::new("standard input not available").into()
		})
	}

	/// Tries to retrieve the standard input file. Returns `None` if not set.
	///
	/// # Arguments
	///
	/// * `shell` - The shell context.
	pub fn try_stdin(&self, shell: &Shell<impl extensions::ShellExtensions>) -> Option<OpenFile> {
		self.try_fd(shell, openfiles::OpenFiles::STDIN_FD)
	}

	/// Returns the standard output file; usable with `write!` et al. In the
	/// event that no such file is available, returns a valid implementation of
	/// `std::io::Write` that fails all I/O requests.
	///
	///
	/// # Arguments
	///
	/// * `shell` - The shell context.
	pub fn stdout(&self, shell: &Shell<impl extensions::ShellExtensions>) -> OpenFile {
		self.try_stdout(shell).unwrap_or_else(|| {
			ioutils::FailingReaderWriter::new("standard output not available").into()
		})
	}

	/// Tries to retrieve the standard output file. Returns `None` if not set.
	///
	/// # Arguments
	///
	/// * `shell` - The shell context.
	pub fn try_stdout(&self, shell: &Shell<impl extensions::ShellExtensions>) -> Option<OpenFile> {
		self.try_fd(shell, openfiles::OpenFiles::STDOUT_FD)
	}

	/// Returns the standard error file; usable with `write!` et al. In the event
	/// that no such file is available, returns a valid implementation of
	/// `std::io::Write` that fails all I/O requests.
	///
	/// # Arguments
	///
	/// * `shell` - The shell context.
	pub fn stderr(&self, shell: &Shell<impl extensions::ShellExtensions>) -> OpenFile {
		self.try_stderr(shell).unwrap_or_else(|| {
			ioutils::FailingReaderWriter::new("standard error not available").into()
		})
	}

	/// Tries to retrieve the standard error file. Returns `None` if not set.
	///
	/// # Arguments
	///
	/// * `shell` - The shell context.
	pub fn try_stderr(&self, shell: &Shell<impl extensions::ShellExtensions>) -> Option<OpenFile> {
		self.try_fd(shell, openfiles::OpenFiles::STDERR_FD)
	}

	/// Returns the file descriptor with the given number. Returns `None`
	/// if the file descriptor is not open.
	///
	/// # Arguments
	///
	/// * `shell` - The shell context.
	/// * `fd` - The file descriptor number to retrieve.
	pub fn try_fd(
		&self,
		shell: &Shell<impl extensions::ShellExtensions>,
		fd: ShellFd,
	) -> Option<openfiles::OpenFile> {
		match self.open_files.fd_entry(fd) {
			openfiles::OpenFileEntry::Open(f) => Some(f.clone()),
			openfiles::OpenFileEntry::NotPresent => None,
			openfiles::OpenFileEntry::NotSpecified => {
				// We didn't have this fd specified one way or the other; we fallback
				// to what's represented in the shell's open files.
				shell.persistent_open_files().try_fd(fd).cloned()
			},
		}
	}

	/// Sets the given file descriptor to the provided open file.
	///
	/// # Arguments
	///
	/// * `fd` - The file descriptor number to set.
	/// * `file` - The open file to set.
	pub fn set_fd(&mut self, fd: ShellFd, file: openfiles::OpenFile) {
		self.open_files.set_fd(fd, file);
	}

	/// Iterates over all open file descriptors in this context.
	///
	/// # Arguments
	///
	/// * `shell` - The shell context.
	pub fn iter_fds(
		&self,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> impl Iterator<Item = (ShellFd, openfiles::OpenFile)> {
		#[allow(clippy::needless_collect)]
		let all_fds: Vec<_> = self
			.open_fds(shell)
			.map(|(fd, file)| (fd, file.clone()))
			.collect();

		all_fds.into_iter()
	}

	/// Like [`Self::iter_fds`], but borrows each open file instead of
	/// duplicating it, so a caller that wants a few descriptors pays for only
	/// those.
	///
	/// # Arguments
	///
	/// * `shell` - The shell context.
	pub fn open_fds<'a>(
		&'a self,
		shell: &'a Shell<impl extensions::ShellExtensions>,
	) -> impl Iterator<Item = (ShellFd, &'a openfiles::OpenFile)> {
		let shell_fds = shell
			.persistent_open_files()
			.iter_fds()
			.filter(|(fd, _)| !self.open_files.contains_fd(*fd));
		self.open_files.iter_fds().chain(shell_fds)
	}
}

fn ensure_not_cancelled(params: &ExecutionParameters) -> Result<(), error::Error> {
	if params.is_cancelled() {
		return Err(error::ErrorKind::Interrupted.into());
	}
	Ok(())
}


#[derive(Clone, Debug, Default)]
/// Policy for how to manage spawned external processes.
pub enum ProcessGroupPolicy {
	/// Place the process in a new process group.
	#[default]
	NewProcessGroup,
	/// Place the process in the same process group as its parent.
	SameProcessGroup,
}

#[async_trait::async_trait]
pub trait Execute {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error>;
}

#[async_trait::async_trait]
trait ExecuteInPipeline<SE: extensions::ShellExtensions> {
	async fn execute_in_pipeline(
		&self,
		context: PipelineExecutionContext<'_, SE>,
		params: ExecutionParameters,
	) -> Result<ExecutionSpawnResult, error::Error>;
}

#[async_trait::async_trait]
impl Execute for ast::Program {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		let mut result = ExecutionResult::success();

		// A program this one runs in turn (`eval`, `source`) reads lines of
		// its own, so only this program's first line continues the caller's.
		let continues_input_line = params.continues_input_line;
		let own_params;
		let params = if continues_input_line {
			let mut fresh = params.clone();
			fresh.continues_input_line = false;
			own_params = fresh;
			&own_params
		} else {
			params
		};

		// Complete commands are separated by newlines: each starts an input line.
		for (index, command) in self.complete_commands.iter().enumerate() {
			ensure_not_cancelled(params)?;
			// As Bash does before it reads each input line, forget the ended
			// jobs a listing reported.
			if index > 0 || !continues_input_line {
				shell.jobs_mut().remove_reported_jobs();
			}
			// Execute the command and handle any errors without immediately propagating
			// them. This allows interactive shells to continue executing subsequent
			// commands even after errors.
			match command.execute(shell, params).await {
				Ok(exec_result) => result = exec_result,
				Err(err) => {
					// Display the error and convert to an execution result.
					if params.reports_errors() {
						let _ = shell.display_error(&mut params.stderr(shell), &err).await;
					}
					result = err.into_result(shell);
				},
			}

			// An abandoned command (`DISCARD`) ends here, where Bash's
			// `reader_loop` and `parse_and_execute` catch the jump: the text
			// goes on with its next command. In a subshell the jump ends the
			// subshell instead.
			if matches!(result.next_control_flow, ExecutionControlFlow::DiscardCommand) && !shell.is_subshell() {
				result.next_control_flow = ExecutionControlFlow::Normal;
			}

			// Update status
			shell.set_last_exit_status(result.exit_code.into());

			// Check if we should stop executing subsequent commands
			if !result.is_normal_flow() {
				break;
			}
		}

		Ok(result)
	}
}

#[async_trait::async_trait]
impl Execute for ast::CompoundList {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		let mut result = ExecutionResult::success();

		for ast::CompoundListItem(ao_list, sep) in &self.0 {
			ensure_not_cancelled(params)?;
			let run_async = matches!(sep, ast::SeparatorOperator::Async);

			if run_async {
				let job = spawn_async_ao_list_as_job(ao_list, shell, params).await?;
				let job_formatted = job.to_pid_style_string();

				if shell.options().interactive && !shell.is_subshell() {
					params
						.stderr(shell)
						.write_all_async(format!("{job_formatted}\n").as_bytes())
						.await?;
				}

				result = ExecutionResult::success();
			} else {
				result = ao_list.execute(shell, params).await?;

				// Update status
				shell.set_last_exit_status(result.exit_code.into());

				// A trapped signal `kill` sent to this background job runs its
				// trap now that the command has returned; an `exit` in the trap
				// ends the job.
				if let Some(trap_result) = shell.run_pending_job_trap(params).await?
					&& !trap_result.is_normal_flow()
				{
					result = trap_result;
				}
			}

			if !result.is_normal_flow() {
				break;
			}
		}

		Ok(result)
	}
}

async fn spawn_async_ao_list_as_job<'a, SE: extensions::ShellExtensions>(
	ao_list: &ast::AndOrList,
	shell: &'a mut Shell<SE>,
	params: &ExecutionParameters,
) -> Result<&'a jobs::Job, error::Error> {
	let mut async_params = params.clone();
	async_params.disable_command_output_marking();

	// Redirect stdin to null, per spec.
	if let Ok(null) = openfiles::null() {
		async_params.set_fd(openfiles::OpenFiles::STDIN_FD, null);
	}

	let direct_pipeline =
		background_process_pipeline_for_async_job(ao_list, shell, &async_params).await?;
	let job = if let Some((pipeline, detach_reparent)) = direct_pipeline {
		// A transparent background wrapper (e.g. `nohup cmd &`) was unwrapped to its
		// operand. Reparent that operand out of the shell's descendant tree so it
		// survives the host's descendant-walk teardown — the persistence agents
		// reach for `nohup` expecting.
		async_params.detach_reparent = detach_reparent;
		// The parent spawns this command before going on, so it must not wait for
		// a FIFO's other end; see `DeferredRedirect`.
		let mut direct_params = async_params.clone();
		direct_params.defer_fifo_redirects = true;
		match try_spawn_pipeline_as_job(&pipeline, ao_list.to_string(), shell, &direct_params).await? {
			Some(job) => job,
			None => spawn_async_ao_list_in_task(ao_list, shell, &async_params)?,
		}
	} else {
		spawn_async_ao_list_in_task(ao_list, shell, &async_params)?
	};

	shell.set_last_background_pid(job.last_pid());
	let job_control = shell.options().enable_job_control;
	Ok(shell.jobs_mut().add_as_current(job, job_control))
}

enum BackgroundProcessPipeline {
	Direct,
	Wrapper(ast::Pipeline),
	Internal,
}

async fn background_process_pipeline_for_async_job<SE: extensions::ShellExtensions>(
	ao_list: &ast::AndOrList,
	shell: &mut Shell<SE>,
	params: &ExecutionParameters,
) -> Result<Option<(ast::Pipeline, bool)>, error::Error> {
	if !ao_list.additional.is_empty() {
		return Ok(None);
	}

	let mut pipeline = ao_list.first.clone();
	let mut detach_reparent = false;
	for _ in 0..8 {
		match classify_background_process_pipeline(&pipeline, shell, params).await? {
			BackgroundProcessPipeline::Direct => return Ok(Some((pipeline, detach_reparent))),
			BackgroundProcessPipeline::Wrapper(unwrapped) => {
				// Unwrapping a transparent background wrapper (`nohup`) means the
				// operand should reparent away from the shell when finally spawned.
				detach_reparent = true;
				pipeline = unwrapped;
			},
			BackgroundProcessPipeline::Internal => return Ok(None),
		}
	}

	Ok(None)
}

async fn classify_background_process_pipeline<SE: extensions::ShellExtensions>(
	pipeline: &ast::Pipeline,
	shell: &mut Shell<SE>,
	params: &ExecutionParameters,
) -> Result<BackgroundProcessPipeline, error::Error> {
	if pipeline.bang {
		return Ok(BackgroundProcessPipeline::Internal);
	}

	if pipeline.seq.len() > 1 {
		// Inspect literal command names only: probing expanded command words
		// here could run substitutions twice or mutate the parent shell before
		// each stage executes in its own pipeline subshell.
		for command in &pipeline.seq {
			let ast::Command::Simple(simple_cmd) = command else {
				return Ok(BackgroundProcessPipeline::Internal);
			};
			let Some(word) = simple_cmd.word_or_name.as_ref() else {
				return Ok(BackgroundProcessPipeline::Internal);
			};
			let name = word.value.as_str();
			if name.is_empty()
				|| !name.chars().all(|c| c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+'))
				|| shell.aliases().contains_key(name)
				|| shell.builtins().get(name).is_some_and(|registration| !registration.disabled)
				|| shell.funcs().get(name).is_some()
			{
				return Ok(BackgroundProcessPipeline::Internal);
			}
		}
		return Ok(BackgroundProcessPipeline::Direct);
	}

	let [ast::Command::Simple(simple_cmd)] = pipeline.seq.as_slice() else {
		return Ok(BackgroundProcessPipeline::Internal);
	};
	let Some(command_word) = simple_cmd.word_or_name.as_ref() else {
		return Ok(BackgroundProcessPipeline::Internal);
	};

	let expanded = expansion::full_expand_and_split_word(shell, params, command_word).await?;
	let [command_name] = expanded.as_slice() else {
		return Ok(BackgroundProcessPipeline::Internal);
	};

	if shell.aliases().contains_key(command_name) {
		return Ok(BackgroundProcessPipeline::Internal);
	}
	if let Some(registration) = shell.builtins().get(command_name.as_str())
		&& !registration.disabled
	{
		return if registration.transparent_background_wrapper {
			Ok(unwrap_transparent_background_wrapper(pipeline)
				.map_or(BackgroundProcessPipeline::Internal, BackgroundProcessPipeline::Wrapper))
		} else {
			Ok(BackgroundProcessPipeline::Internal)
		};
	}
	if shell.funcs().get(command_name.as_str()).is_some() {
		return Ok(BackgroundProcessPipeline::Internal);
	}

	Ok(BackgroundProcessPipeline::Direct)
}

fn unwrap_transparent_background_wrapper(pipeline: &ast::Pipeline) -> Option<ast::Pipeline> {
	let [ast::Command::Simple(simple_cmd)] = pipeline.seq.as_slice() else {
		return None;
	};
	let mut unwrapped = simple_cmd.clone();
	let suffix = unwrapped.suffix.as_mut()?;
	let mut operand_index = suffix
		.0
		.iter()
		.position(|item| matches!(item, CommandPrefixOrSuffixItem::Word(_)))?;
	// A leading `--` only terminates the wrapper's own options
	// (`nohup -- cmd &`): drop it and take the next word as the operand.
	if let CommandPrefixOrSuffixItem::Word(word) = &suffix.0[operand_index]
		&& word.value == "--"
	{
		suffix.0.remove(operand_index);
		operand_index = suffix
			.0
			.iter()
			.position(|item| matches!(item, CommandPrefixOrSuffixItem::Word(_)))?;
	}
	let CommandPrefixOrSuffixItem::Word(operand_word) = suffix.0.remove(operand_index) else {
		return None;
	};

	unwrapped.word_or_name = Some(operand_word);
	if suffix.0.is_empty() {
		unwrapped.suffix = None;
	}

	Some(ast::Pipeline {
		timed: pipeline.timed.clone(),
		bang: pipeline.bang,
		seq: vec![ast::Command::Simple(unwrapped)],
	})
}

async fn try_spawn_pipeline_as_job<SE: extensions::ShellExtensions>(
	pipeline: &ast::Pipeline,
	command_line: String,
	shell: &Shell<SE>,
	params: &ExecutionParameters,
) -> Result<Option<jobs::Job>, error::Error> {
	let mut subshell = shell.clone();
	subshell.options_mut().interactive = false;

	let spawn_results = spawn_pipeline_processes(pipeline, &mut subshell, params).await?;
	let mut tasks = VecDeque::new();

	for spawn_result in spawn_results {
		if let ExecutionWaitResult::Stopped(child, _signal) = spawn_result.poll().await? {
			tasks.push_back(jobs::JobTask::External(child));
		}
	}

	if tasks.is_empty() {
		return Ok(None);
	}

	Ok(Some(jobs::Job::new(tasks, command_line, jobs::JobState::Running)))
}

fn spawn_async_ao_list_in_task<SE: extensions::ShellExtensions>(
	ao_list: &ast::AndOrList,
	shell: &Shell<SE>,
	params: &ExecutionParameters,
) -> Result<jobs::Job, error::Error> {
	// Clone the inputs.
	let mut cloned_shell = shell.clone();
	let mut cloned_params = params.clone();
	let cloned_ao_list = ao_list.clone();

	// Mark the child shell as not interactive; we don't want it messing with the
	// terminal too much.
	cloned_shell.options_mut().interactive = false;

	// Let the job flag its own task for cancellation: the interpreter checks
	// these parameters between commands and loop iterations, so `kill %N` also
	// stops a body that never yields (a loop of synchronous builtins). It is a
	// child of the run's token, so cancelling the run (a tool abort) stops the
	// job too; a run that completes never cancels its token, so a job still
	// outlives the command line that started it.
	let cancellation = params
		.cancel_token()
		.map_or_else(CancellationToken::new, |token| token.child_token());
	cloned_params.set_cancel_token(cancellation.clone());

	// Traps the job sets decide what `kill` does to it.
	let job_signals = Arc::new(JobSignals::default());
	cloned_shell
		.traps_mut()
		.attach_job_signals(Arc::clone(&job_signals));

	let task = async move {
		cloned_ao_list
			.execute(&mut cloned_shell, &cloned_params)
			.await
	};

	jobs::Job::spawn_in_process(task, ao_list.to_string(), cancellation, job_signals)
}

#[async_trait::async_trait]
impl Execute for ast::AndOrList {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		let has_operators = !self.additional.is_empty();

		// For the first command, suppress errexit if there are more commands after it
		let mut first_params = params.clone();
		if has_operators {
			first_params.suppress_errexit = true;
		}

		let mut result = self.first.execute(shell, &first_params).await?;

		for (index, next_ao) in self.additional.iter().enumerate() {
			ensure_not_cancelled(params)?;
			// Check for non-normal control flow.
			if !result.is_normal_flow() {
				break;
			}

			let (is_and, pipeline) = match next_ao {
				ast::AndOr::And(p) => (true, p),
				ast::AndOr::Or(p) => (false, p),
			};

			// If we short-circuit, then we don't break out of the whole loop
			// but we skip evaluating the current pipeline. We'll then continue
			// on and possibly evaluate a subsequent one (depending on the
			// operator before it).
			if is_and {
				if !result.is_success() {
					continue;
				}
			} else if result.is_success() {
				continue;
			}

			// For the last command in the chain, use original params (errexit not
			// suppressed) For earlier commands, suppress errexit
			let mut params = params.clone();

			let is_last = index == self.additional.len() - 1;
			if !is_last {
				params.suppress_errexit = true;
			}

			result = pipeline.execute(shell, &params).await?;
		}

		Ok(result)
	}
}

#[async_trait::async_trait]
impl Execute for ast::Pipeline {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		// Capture current timing if so requested.
		let stopwatch = self
			.timed
			.is_some()
			.then(timing::start_timing)
			.transpose()?;

		let mut params = params.clone();

		// If this pipeline is negated, suppress errexit for commands within it
		if self.bang {
			params.suppress_errexit = true;
		}

		// With `lastpipe` the last command runs in this shell, and Bash freezes
		// its job list for the whole pipeline (`freeze_jobs_list` in
		// `execute_pipeline`): nothing in it forgets a reported job, and
		// `wait -n` returns at once.
		let frozen_before = runs_last_command_in_shell(self, shell).then(|| shell.jobs_mut().freeze());

		// Spawn all the processes required for the pipeline, connecting outputs/inputs
		// with pipes as needed, then wait for them. Waiting also has a side
		// effect of updating pipeline status.
		let waited = async {
			let spawn_results = spawn_pipeline_processes(self, shell, &params).await?;
			wait_for_pipeline_processes_and_update_status(self, spawn_results, shell, &params).await
		}
		.await;
		let last_in_shell = frozen_before.is_some();
		if let Some(frozen) = frozen_before {
			shell.jobs_mut().set_frozen(frozen);
		}
		let mut result = waited?;
		// Every stage of a pipeline of two or more runs in a subshell, the
		// last one too unless `lastpipe` runs it in this shell: what it asks
		// of the control flow (`exit`, `return`, `break`, an abandoned
		// command) ends that subshell alone.
		if self.seq.len() > 1 && !last_in_shell {
			result.next_control_flow = ExecutionControlFlow::Normal;
		}

		// Virtual files the pipeline's redirections opened close in the
		// background once dropped. Settle them so the next command observes
		// committed contents, and so a failed commit fails this pipeline.
		if let Err(close_error) = shell.filesystem().drain_closes().await {
			let close_error = error::Error::from(close_error);
			let _ = shell.display_error(&mut params.stderr(shell), &close_error).await;
			result.exit_code = ExecutionExitCode::GeneralError;
		}

		// Invert the exit code if requested.
		if self.bang {
			result.exit_code = ExecutionExitCode::from(if result.is_success() { 1_u8 } else { 0 });
		}

		// Update exit status.
		shell.set_last_exit_status(result.exit_code.into());

		// Fire the ERR trap if the pipeline failed in a non-conditional context.
		// We reuse `suppress_errexit` here because bash suppresses the ERR trap in
		// exactly the same contexts it suppresses errexit (conditionals, `!`-prefixed
		// pipelines, etc.).
		if !result.is_success() && !params.suppress_errexit && !self.bang {
			if shell.traps().handles(crate::traps::TrapSignal::Err) {
				shell
					.invoke_trap_handler(crate::traps::TrapSignal::Err, &params)
					.await?;
			}
		}

		// Apply errexit if not suppressed (and not negated)
		if !params.suppress_errexit && !self.bang {
			shell.apply_errexit_if_enabled(&mut result);
		}

		// If requested, report timing.
		if let (Some(timed), Some(stopwatch)) = (&self.timed, &stopwatch)
			&& let Some(mut stderr) = params.try_fd(shell, openfiles::OpenFiles::STDERR_FD)
		{
			let timing = stopwatch.stop()?;
			let report = if timed.is_posix_output() {
				std::format!(
					"real {}\nuser {}\nsys {}\n",
					timing::format_duration_posixly(&timing.wall),
					timing::format_duration_posixly(&timing.user),
					timing::format_duration_posixly(&timing.system),
				)
			} else {
				std::format!(
					"\nreal\t{}\nuser\t{}\nsys\t{}\n",
					timing::format_duration_non_posixly(&timing.wall),
					timing::format_duration_non_posixly(&timing.user),
					timing::format_duration_non_posixly(&timing.system),
				)
			};
			stderr.write_all_async(report.as_bytes()).await?;
		}

		Ok(result)
	}
}

async fn spawn_pipeline_processes(
	pipeline: &ast::Pipeline,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<VecDeque<ExecutionSpawnResult>, error::Error> {
	ensure_not_cancelled(params)?;
	let pipeline_len = pipeline.seq.len();
	let mut pipe_readers = vec![];
	let mut pipe_writers = vec![];
	let mut spawn_results = VecDeque::new();
	let mut process_group_id: Option<i32> = None;

	// Create pipes to use between commands, but only bother doing so if there's
	// more than one command. Pipe `i` carries stage `i` into stage `i + 1`
	// (opened in that order, so a tap sees the stages left to right); the
	// stage loop pops both lists from the back.
	if pipeline_len > 1 {
		// Bash forks every command of such a pipeline, and forgets the ended
		// jobs that were reported when it installs the job (`stop_pipeline`);
		// with `lastpipe` the table is frozen and nothing is forgotten.
		shell.jobs_mut().remove_reported_jobs();
		let pipes = pipeline
			.seq
			.iter()
			.tuple_windows()
			.map(|(producer, consumer)| pipetap::pipe(params.pipe_tap(), producer, consumer))
			.collect::<Result<Vec<_>, _>>()?;
		for (reader, writer) in pipes.into_iter().rev() {
			pipe_readers.push(Some(reader));
			pipe_writers.push(Some(writer));
		}
		// Push `None` to the readers; it will be popped off by the *first* command,
		// which will mean that command gets its stdin from the execution parameters'
		// current stdin.
		pipe_readers.push(None);
	}

	for (current_pipeline_index, command) in pipeline.seq.iter().enumerate() {
		ensure_not_cancelled(params)?;
		//
		// We run a command directly in the current shell if either of the following is
		// true:
		//     * There's only one command in the pipeline.
		//     * This is the *last* command in the pipeline, the lastpipe option is
		//       enabled, and job monitoring is disabled.
		// Otherwise, we spawn a separate subshell for each command in the pipeline.
		//

		let run_in_current_shell = pipeline_len == 1
			|| (current_pipeline_index == pipeline_len - 1 && runs_last_command_in_shell(pipeline, shell));

		// Set up parameters appropriate for this command.
		let mut cmd_params = params.clone();
		if pipeline_len > 1 {
			cmd_params.disable_command_output_marking();
		}


		// Install pipes.
		if let Some(Some(reader)) = pipe_readers.pop() {
			cmd_params.open_files.set_fd(OpenFiles::STDIN_FD, reader);
		}
		if let Some(Some(writer)) = pipe_writers.pop() {
			cmd_params.open_files.set_fd(OpenFiles::STDOUT_FD, writer);
		}

		let pipeline_context = if !run_in_current_shell {
			// Make sure that all commands in the pipeline are in the same process group.
			if current_pipeline_index > 0 {
				cmd_params.process_group_policy = ProcessGroupPolicy::SameProcessGroup;
			}

			PipelineExecutionContext {
				shell: commands::ShellForCommand::OwnedShell {
					target: Box::new(shell.clone()),
					parent: shell,
				},
				process_group_id,
				in_pipeline: pipeline_len > 1,
			}
		} else {
			PipelineExecutionContext {
				shell: commands::ShellForCommand::ParentShell(shell),
				process_group_id,
				in_pipeline: pipeline_len > 1,
			}
		};

		let spawn_result = command
			.execute_in_pipeline(pipeline_context, cmd_params)
			.await?;

		// Update the process group ID if something was spawned.
		if let ExecutionSpawnResult::StartedProcess(child) = &spawn_result {
			if process_group_id.is_none() {
				process_group_id = child.pgid();
			}
		}

		spawn_results.push_back(spawn_result);
	}

	Ok(spawn_results)
}

/// Whether the last command of a pipeline of two or more runs in the shell
/// itself: the `lastpipe` option is on and job control is off.
fn runs_last_command_in_shell(
	pipeline: &ast::Pipeline,
	shell: &Shell<impl extensions::ShellExtensions>,
) -> bool {
	pipeline.seq.len() > 1
		&& shell.options().run_last_pipeline_cmd_in_current_shell
		&& !shell.options().enable_job_control
}

/// Bash's `REAP` after a loop's test or body (`reap_dead_jobs`): forgets the
/// ended jobs that were reported, except in an interactive shell with job
/// control, which reports them at its next prompt instead.
fn reap_reported_jobs(shell: &mut Shell<impl extensions::ShellExtensions>) {
	if !(shell.options().interactive && shell.options().enable_job_control) {
		shell.jobs_mut().remove_reported_jobs();
	}
}

/// How long a pipeline stage that did not stop itself may still take to end
/// before the stop of another stage stops the pipeline without it (see
/// `wait_for_pipeline_processes_and_update_status`).
const STOPPED_STAGE_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

async fn wait_for_pipeline_processes_and_update_status(
	pipeline: &ast::Pipeline,
	mut process_spawn_results: VecDeque<ExecutionSpawnResult>,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
) -> Result<ExecutionResult, error::Error> {
	ensure_not_cancelled(params)?;
	let mut result = ExecutionResult::success();
	let mut stopped_children = vec![];
	let mut last_failure_exit_code: Option<ExecutionExitCode> = None;
	let mut statuses = Vec::with_capacity(process_spawn_results.len());
	// The `WSTOPSIG` value of the first stage's wait status (see
	// `ExecutionSpawnResult::wait_with_stop_word`).
	let mut first_stage_word = None;

	// Use the exact external member set as the stop scope for a multi-process
	// pipeline. A process group remains an additional scope because a detached
	// pipe-input stage can leave the recorded group while still belonging to
	// the pipeline. A lone process needs no shared scope: its wait checks its
	// own PID.
	let external_pid = |result: &ExecutionSpawnResult| match result {
		ExecutionSpawnResult::StartedProcess(child) => child.pid(),
		ExecutionSpawnResult::Completed(_) | ExecutionSpawnResult::StartedTask(_) => None,
	};
	if process_spawn_results.iter().filter_map(external_pid).nth(1).is_some() {
		let pipeline_pids: Arc<[_]> = process_spawn_results.iter().filter_map(external_pid).collect();
		for result in &mut process_spawn_results {
			if let ExecutionSpawnResult::StartedProcess(child) = result {
				child.set_stop_pids(Arc::clone(&pipeline_pids));
			}
		}
	}

	let external_pids: Vec<_> = process_spawn_results.iter().filter_map(external_pid).collect();
	let mut stop = jobs::PipelineStop {
		first_pid: external_pids.first().copied(),
		last_pid: external_pids.last().copied(),
		// Taken before any stage is reaped, so the job keeps the group of a
		// stage that ends before the pipeline stops.
		signal_targets: jobs::signal_targets(process_spawn_results.iter().filter_map(|result| match result {
			ExecutionSpawnResult::StartedProcess(child) => Some(child),
			ExecutionSpawnResult::Completed(_) | ExecutionSpawnResult::StartedTask(_) => None,
		})),
		..jobs::PipelineStop::default()
	};
	let stage_count = process_spawn_results.len();

	// The stages seen stopped, each with its `WSTOPSIG`. A wait ends when any
	// stage of the pipeline stops (a wait on one stage consumes the stops of
	// all of them), and the pipeline then counts as stopped: the stages left
	// are not waited for. A stage that stopped is stopped; one that did not
	// gets a short grace to end, since a stop usually follows the end of the
	// stage before it (the pipe it read closed) and Bash's `wait_for` would
	// have collected that end. Bash waits on while a process of the job runs,
	// which would hang here when an earlier stage blocks writing to a later
	// one that stopped.
	let mut stopped_pids: Vec<(sys::process::ProcessId, u8)> = Vec::new();
	// The signal that stopped the pipeline, once one did.
	let mut pipeline_stop: Option<u8> = None;
	for index in 0..stage_count {
		let Some(stage) = process_spawn_results.pop_front() else {
			break;
		};
		ensure_not_cancelled(params)?;
		let pid = external_pid(&stage);
		// The stage's own stop signal, when it stopped rather than still ran.
		// When the shell itself got SIGTSTP, no stage reported a stop and all
		// of them stopped.
		let stopped_itself = |stopped_pids: &[(sys::process::ProcessId, u8)], signal: u8| {
			if stopped_pids.is_empty() {
				return Some(signal);
			}
			let pid = pid?;
			stopped_pids
				.iter()
				.rev()
				.find(|&&(stopped, _)| stopped == pid)
				.map(|&(_, signal)| signal)
		};
		let stage = match (pipeline_stop, stage) {
			(None, stage) => match stage.wait_with_stop_word(params.cancel_token()).await? {
				(ExecutionWaitResult::Stopped(mut child, signal), _) => {
					pipeline_stop = Some(signal);
					stopped_pids.extend(child.take_reported_stops());
					Err(child)
				},
				completed => Ok(completed),
			},
			(Some(_), ExecutionSpawnResult::StartedProcess(child)) => Err(child),
			(Some(_), stage) => Ok((stage.poll().await?, 0)),
		};
		let (wait_result, word, own_stop) = match stage {
			Ok((wait_result, word)) => (wait_result, word, None),
			Err(mut child) => {
				let signal = pipeline_stop.unwrap_or(0);
				match stopped_itself(&stopped_pids, signal) {
					Some(own) => (ExecutionWaitResult::Stopped(child, own), 0, Some(own)),
					None => match child.finish_within(STOPPED_STAGE_GRACE).await? {
						Some(output) => {
							let word = jobs::stop_signal_word(&output);
							(ExecutionWaitResult::Completed(ExecutionResult::from(output)), word, None)
						},
						None => (ExecutionWaitResult::Stopped(child, signal), 0, None),
					},
				}
			},
		};
		if index == 0 {
			// A first stage that still runs has no status Bash would know
			// yet; the signal that stopped the pipeline stands in for it.
			first_stage_word = Some(match &wait_result {
				ExecutionWaitResult::Completed(_) => word,
				ExecutionWaitResult::Stopped(_, signal) => *signal,
			});
		}

		match wait_result {
			ExecutionWaitResult::Completed(current_result) => {
				result = current_result;
				statuses.push(result.exit_code.status());
				stop.ended_pids.extend(pid);
				if index == 0 {
					stop.first_word = Some(word);
				}
				if index + 1 == stage_count {
					stop.last_status = Some(result.exit_code);
				}

				// Track the last failure for pipefail option
				if !result.is_success() {
					last_failure_exit_code = Some(result.exit_code);
				}
			},
			ExecutionWaitResult::Stopped(child, _) => {
				stop.stopped.extend(pid.zip(own_stop));
				stopped_children.push(jobs::JobTask::External(child));
			},
		}
	}

	if stopped_children.is_empty() {
		// Apply pipefail semantics if enabled
		if shell.options().return_last_failure_from_pipeline
			&& let Some(failure_exit_code) = last_failure_exit_code
		{
			result.exit_code = failure_exit_code;
		}
		*shell.last_pipeline_statuses_mut() = statuses;
	} else {
		// A stopped job's status is what Bash's `wait_for` returns: 128 plus
		// the `WSTOPSIG` value of its first process's status, which is the
		// signal that stopped it, or its exit status once it has exited (0
		// for a signal that killed it). `PIPESTATUS` keeps its value, since
		// `setjstatus` runs only for a job that ended.
		result = ExecutionExitCode::stopped_job(first_stage_word.unwrap_or(0)).into();
	}
	shell.set_last_exit_status(result.exit_code.status());

	if shell.options().interactive {
		sys::terminal::move_self_to_foreground()?;
	}

	// If there were stopped jobs, then encapsulate the pipeline as a managed job
	// and hand it off to the job manager.
	if !stopped_children.is_empty() {
		let job_control = shell.options().enable_job_control;
		let interactive = shell.options().interactive;
		let mut job = jobs::Job::new(stopped_children, pipeline.to_string(), jobs::JobState::Stopped);
		job.record_pipeline_stop(stop);
		let job = shell.jobs_mut().add_as_current(job, job_control);

		// Bash running a script prints nothing for a job that stopped
		// (`notify_of_job_status`); `jobs` shows it.
		if interactive {
			let formatted = job.to_string();

			// N.B. We use the '\r' to overwrite any ^Z output.
			params
				.stderr(shell)
				.write_all_async(format!("\r{formatted}\n").as_bytes())
				.await?;
		}
	}

	Ok(result)
}

#[async_trait::async_trait]
impl<SE: extensions::ShellExtensions> ExecuteInPipeline<SE> for ast::Command {
	async fn execute_in_pipeline(
		&self,
		mut pipeline_context: PipelineExecutionContext<'_, SE>,
		mut params: ExecutionParameters,
	) -> Result<ExecutionSpawnResult, error::Error> {
		ensure_not_cancelled(&params)?;
		if pipeline_context.shell.options().do_not_execute_commands {
			return Ok(ExecutionSpawnResult::Completed(ExecutionResult::success()));
		}

		// Updates the shell with information about the currently executing command.
		pipeline_context.shell.set_current_cmd(self);

		match self {
			Self::Simple(simple) => simple.execute_in_pipeline(pipeline_context, params).await,
			Self::Compound(compound, redirects) => {
				params.disable_command_output_marking();

				// Each stage of a multi-command pipeline runs in its own
				// subshell (`pipeline_context.shell` is already an owned
				// clone). Execute compound stages as concurrent tasks rather
				// than inline: inline execution serializes the pipeline —
				// downstream stages are not even spawned until this stage
				// completes — and deadlocks outright once a stage fills the
				// connecting pipe's buffer with no reader running.
				let in_pipeline = pipeline_context.in_pipeline;
				match pipeline_context.shell {
					commands::ShellForCommand::OwnedShell { target, .. } if in_pipeline => {
						let mut shell = *target;
						let compound = compound.clone();
						let redirects = redirects.clone();
						let mut params = params;
						Ok(ExecutionSpawnResult::StartedTask(tokio::spawn(async move {
							if let Some(redirects) = &redirects {
								for redirect in &redirects.0 {
									setup_redirect(&mut shell, &mut params, redirect).await?;
								}
							}
							compound.execute(&mut shell, &params).await
						})))
					},
					mut shell => {
						// Set up any additional redirects.
						if let Some(redirects) = redirects {
							for redirect in &redirects.0 {
								setup_redirect(&mut shell, &mut params, redirect).await?;
							}
						}

						Ok(compound.execute(&mut shell, &params).await?.into())
					},
				}
			},
			Self::Function(func) => {
				params.disable_command_output_marking();
				Ok(func
					.execute(&mut pipeline_context.shell, &params)
					.await?
					.into())
			},
			Self::ExtendedTest(e, redirects) => {
				// Set up any additional redirects.
				if let Some(redirects) = redirects {
					for redirect in &redirects.0 {
						setup_redirect(&mut pipeline_context.shell, &mut params, redirect).await?;
					}
				}

				// Evaluate the extended test expression.
				let result = if extendedtests::eval_extended_test_expr(
					&e.expr,
					&mut pipeline_context.shell,
					&params,
				)
				.await?
				{
					0
				} else {
					1
				};
				Ok(ExecutionResult::new(result).into())
			},
		}
	}
}

enum WhileOrUntil {
	While,
	Until,
}

#[async_trait::async_trait]
impl Execute for ast::CompoundCommand {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		match self {
			Self::BraceGroup(ast::BraceGroupCommand { list, .. }) => list.execute(shell, params).await,
			Self::Subshell(ast::SubshellCommand { list, .. }) => {
				// Bash forks a subshell, and forgets the ended jobs a listing
				// reported when it starts a child.
				shell.jobs_mut().remove_reported_jobs();
				// Clone off a new subshell, and run the body of the subshell there.
				// TODO(source-info): Do we need to reset the line number?
				let mut subshell = shell.clone();

				// Handle errors within the subshell context to prevent fatal errors
				// from propagating to the parent shell.
				let subshell_result = match list.execute(&mut subshell, params).await {
					Ok(result) => result,
					Err(error) => {
						// Display the error to stderr, but prevent fatal error propagation
						if params.reports_errors() {
							let mut stderr = params.stderr(shell);
							let _ = shell.display_error(&mut stderr, &error).await;
						}

						// Convert error to result in subshell context
						error.into_result(&subshell)
					},
				};

				// Preserve the subshell's exit code, but don't honor any of its requests to
				// exit the shell, break out of loops, etc.
				Ok(ExecutionResult::from(subshell_result.exit_code))
			},
			Self::ForClause(f) => f.execute(shell, params).await,
			Self::CaseClause(c) => c.execute(shell, params).await,
			Self::IfClause(i) => i.execute(shell, params).await,
			Self::WhileClause(w) => (WhileOrUntil::While, w).execute(shell, params).await,
			Self::UntilClause(u) => (WhileOrUntil::Until, u).execute(shell, params).await,
			Self::Arithmetic(a) => a.execute(shell, params).await,
			Self::ArithmeticForClause(a) => a.execute(shell, params).await,
			Self::Coprocess(c) => c.execute(shell, params).await,
		}
	}
}

#[async_trait::async_trait]
impl Execute for ast::CoprocessCommand {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		if shell.options().do_not_execute_commands {
			return Ok(ExecutionResult::success());
		}

		// Resolve the name of the variable that will receive the coprocess's file
		// descriptors.
		let name = self
			.name
			.as_ref()
			.map_or_else(|| "COPROC".to_string(), |w| w.to_string());

		if !valid_variable_name(&name) {
			params
				.stderr(shell)
				.write_all_async(format!("coproc {name}: not a valid identifier\n").as_bytes())
				.await?;
			return Ok(ExecutionExitCode::GeneralError.into());
		}

		// Set up the pipes that we'll use to communicate with the coprocess.
		let (stdin_reader, stdin_writer) = ioutils::pipe("coprocess")?;
		let (stdout_reader, stdout_writer) = ioutils::pipe("coprocess")?;

		// Allocate new fds in the (parent) shell for the read end of the coprocess's
		// stdout and the write end of the coprocess's stdin.
		let stdout_fd = shell.open_files_mut().add(stdout_reader.into())?;
		let stdin_fd = shell.open_files_mut().add(stdin_writer.into())?;

		// Crete a subshell that the coprocess will own and run in.
		let mut child_shell = shell.clone();
		child_shell.options_mut().interactive = false;

		// Setup redirection for the coprocess's shell's stdin/stdout.
		let mut child_params = params.clone();
		child_params
			.open_files
			.set_fd(OpenFiles::STDIN_FD, stdin_reader.into());
		child_params
			.open_files
			.set_fd(OpenFiles::STDOUT_FD, stdout_writer.into());

		let body = self.body.clone();
		let cancel_token = child_params.cancel_token();
		// Give the coprocess its own cancellation flag so `kill %N` ends it at its
		// next interpreter check, even when the body never yields; a child of the
		// run's token, as for a background job.
		let cancellation = cancel_token
			.as_ref()
			.map_or_else(CancellationToken::new, CancellationToken::child_token);
		child_params.set_cancel_token(cancellation.clone());
		// Traps the coprocess sets decide what `kill` does to it.
		let job_signals = Arc::new(JobSignals::default());
		child_shell
			.traps_mut()
			.attach_job_signals(Arc::clone(&job_signals));
		let task = async move {
			let pipeline_context = PipelineExecutionContext {
				shell:            commands::ShellForCommand::ParentShell(&mut child_shell),
				process_group_id: None,
				in_pipeline:       false,
			};
			let spawn_result = body
				.execute_in_pipeline(pipeline_context, child_params)
				.await?;
			match spawn_result.wait_with_cancel(cancel_token).await? {
				ExecutionWaitResult::Completed(result) => Ok::<_, error::Error>(result),
				ExecutionWaitResult::Stopped(_, signal) => {
					Ok(ExecutionResult::new(128_u8.saturating_add(signal)))
				},
			}
		};

		let job_control = shell.options().enable_job_control;
		let job = shell.jobs_mut().add_as_current(
			jobs::Job::spawn_in_process(task, format!("coproc {name}"), cancellation, job_signals)?,
			job_control,
		);
		let pid = job.last_pid();
		shell.set_last_background_pid(pid);

		// Fill out the fd variable.
		let arr_value = ShellValue::from(vec![stdout_fd.to_string(), stdin_fd.to_string()]);
		shell
			.env_mut()
			.set_global(name.clone(), ShellVariable::new(arr_value))?;

		// The coprocess's pid, which `$!` also holds, goes in a separate variable
		// with the _PID suffix.
		let pid_name = format!("{name}_PID");
		let pid = pid.map_or_else(String::new, |pid| pid.to_string());
		shell
			.env_mut()
			.set_global(pid_name, ShellVariable::new(pid))?;

		Ok(ExecutionResult::success())
	}
}

#[async_trait::async_trait]
impl Execute for ast::ForClauseCommand {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		let mut result = ExecutionResult::success();

		// If we were given explicit words to iterate over, then expand them all, with
		// splitting enabled.
		let mut expanded_values = vec![];
		if let Some(unexpanded_values) = &self.values {
			for value in unexpanded_values {
				let mut expanded = expansion::full_expand_and_split_word(shell, params, value).await?;
				expanded_values.append(&mut expanded);
			}
		} else {
			// Otherwise, we use the current positional parameters.
			expanded_values.extend_from_slice(shell.current_shell_args());
		}

		for value in expanded_values {
			ensure_not_cancelled(params)?;
			if shell.options().print_commands_and_arguments {
				if let Some(unexpanded_values) = &self.values {
					shell
						.trace_command(
							params,
							std::format!(
								"for {} in {}",
								self.variable_name,
								unexpanded_values.iter().join(" ")
							),
						)
						.await;
				} else {
					shell
						.trace_command(params, std::format!("for {}", self.variable_name))
						.await;
				}
			}

			// Update the variable.
			shell.env_mut().update_or_add(
				&self.variable_name,
				ShellValueLiteral::Scalar(value),
				|_| Ok(()),
				EnvironmentLookup::Anywhere,
				EnvironmentScope::Global,
			)?;

			result = self.body.list.execute(shell, params).await?;
			if result.is_return_or_exit() {
				break;
			}
			// Bash forgets the reported jobs after each pass of the body (`REAP`
			// in `execute_for_command`); a `for` with no word runs no pass.
			reap_reported_jobs(shell);

			let is_break = result.is_break();

			result.next_control_flow = result.next_control_flow.try_decrement_loop_levels();

			if is_break || result.is_continue() {
				break;
			}
		}

		shell.set_last_exit_status(result.exit_code.into());
		Ok(result)
	}
}

#[async_trait::async_trait]
impl Execute for ast::CaseClauseCommand {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		// N.B. One would think it makes sense to trace the expanded value being
		// switched on, but that's not it.
		if shell.options().print_commands_and_arguments {
			shell
				.trace_command(params, std::format!("case {} in", self.value))
				.await;
		}

		let expanded_value = expansion::basic_expand_word(shell, params, &self.value).await?;
		let mut result: ExecutionResult = ExecutionResult::success();
		let mut force_execute_next_case = false;

		for case in &self.cases {
			ensure_not_cancelled(params)?;
			if force_execute_next_case {
				force_execute_next_case = false;
			} else {
				let mut matches = false;
				for pattern in &case.patterns {
					let expanded_pattern = expansion::basic_expand_pattern(shell, params, pattern)
						.await?
						.set_extended_globbing(shell.options().extended_globbing)
						.set_case_insensitive(shell.options().case_insensitive_conditionals);

					if expanded_pattern.exactly_matches(expanded_value.as_str())? {
						matches = true;
						break;
					}
				}

				if !matches {
					continue;
				}
			}

			result = if let Some(case_cmd) = &case.cmd {
				case_cmd.execute(shell, params).await?
			} else {
				ExecutionResult::success()
			};

			// Check for early return (return/exit) or loop control flow (break/continue)
			if !result.is_normal_flow() {
				break;
			}

			match case.post_action {
				ast::CaseItemPostAction::ExitCase => break,
				ast::CaseItemPostAction::UnconditionallyExecuteNextCaseItem => {
					force_execute_next_case = true;
				},
				ast::CaseItemPostAction::ContinueEvaluatingCases => (),
			}
		}

		shell.set_last_exit_status(result.exit_code.into());

		Ok(result)
	}
}

#[async_trait::async_trait]
impl Execute for ast::IfClauseCommand {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		// Execute condition with errexit suppressed
		let mut condition_params = params.clone();
		condition_params.suppress_errexit = true;
		let condition = self.condition.execute(shell, &condition_params).await?;

		// Check if the condition itself resulted in non-normal control flow.
		if !condition.is_normal_flow() {
			return Ok(condition);
		}

		if condition.is_success() {
			return self.then.execute(shell, params).await;
		}

		if let Some(elses) = &self.elses {
			for else_clause in elses {
				ensure_not_cancelled(params)?;
				match &else_clause.condition {
					Some(else_condition) => {
						let else_condition_result =
							else_condition.execute(shell, &condition_params).await?;

						// Check if the elif condition caused non-normal control flow.
						if !else_condition_result.is_normal_flow() {
							return Ok(else_condition_result);
						}

						if else_condition_result.is_success() {
							return else_clause.body.execute(shell, params).await;
						}
					},
					None => {
						return else_clause.body.execute(shell, params).await;
					},
				}
			}
		}

		// If we got down here, then no branch was taken; we make sure to
		// reset the last exit status to success and then return success.
		let result = ExecutionResult::success();
		shell.set_last_exit_status(result.exit_code.into());

		Ok(result)
	}
}

#[async_trait::async_trait]
impl Execute for (WhileOrUntil, &ast::WhileOrUntilClauseCommand) {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		let is_while = match self.0 {
			WhileOrUntil::While => true,
			WhileOrUntil::Until => false,
		};
		let test_condition = &self.1.0;
		let body = &self.1.1;

		let mut result = ExecutionResult::success();

		// Execute loop condition with errexit suppressed
		let mut condition_params = params.clone();
		condition_params.suppress_errexit = true;

		loop {
			ensure_not_cancelled(params)?;
			let condition_result = test_condition.execute(shell, &condition_params).await?;
			// Bash forgets the reported jobs after each test (`REAP` in
			// `execute_while_or_until`), unless the test returned or exited.
			if !condition_result.is_return_or_exit() {
				reap_reported_jobs(shell);
			}

			// Update status for condition
			shell.set_last_exit_status(condition_result.exit_code.into());

			if !condition_result.is_normal_flow() {
				result = condition_result;

				// If the condition has break/continue, the while/until loop itself
				// consumes one level. We need to decrement the level before returning.
				result.next_control_flow = result.next_control_flow.try_decrement_loop_levels();
				break;
			}

			if condition_result.is_success() != is_while {
				break;
			}

			result = body.list.execute(shell, params).await?;
			if result.is_return_or_exit() {
				break;
			}

			let is_break = result.is_break();

			result.next_control_flow = result.next_control_flow.try_decrement_loop_levels();

			if is_break || result.is_continue() {
				break;
			}
		}

		shell.set_last_exit_status(result.exit_code.into());
		Ok(result)
	}
}

#[async_trait::async_trait]
impl Execute for ast::ArithmeticCommand {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		let value = self.expr.eval(shell, params, true).await?;
		let result = if value != 0 {
			ExecutionResult::success()
		} else {
			ExecutionResult::general_error()
		};

		shell.set_last_exit_status(result.exit_code.into());

		Ok(result)
	}
}

#[async_trait::async_trait]
impl Execute for ast::ArithmeticForClauseCommand {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		ensure_not_cancelled(params)?;
		let mut result = ExecutionResult::success();
		if let Some(initializer) = &self.initializer {
			initializer.eval(shell, params, true).await?;
		}

		loop {
			ensure_not_cancelled(params)?;
			// An empty condition (e.g., `for (( ; ; ))`) means "always true".
			let condition_holds = match &self.condition {
				Some(condition) if !condition.value.is_empty() => {
					condition.eval(shell, params, true).await? != 0
				},
				_ => true,
			};
			// Bash forgets the reported jobs after each test (`REAP` in
			// `execute_arith_for_command`), the one that ends the loop too.
			reap_reported_jobs(shell);
			if !condition_holds {
				break;
			}

			result = self.body.list.execute(shell, params).await?;
			if result.is_return_or_exit() {
				break;
			}

			let is_break = result.is_break();

			result.next_control_flow = result.next_control_flow.try_decrement_loop_levels();

			if is_break || result.is_continue() {
				break;
			}

			if let Some(updater) = &self.updater {
				updater.eval(shell, params, true).await?;
			}
		}

		shell.set_last_exit_status(result.exit_code.into());
		Ok(result)
	}
}

#[async_trait::async_trait]
impl Execute for ast::FunctionDefinition {
	async fn execute(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		_params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		let func_name = self.fname.value.clone();

		// In POSIX mode, function names can't shadow special builtins.
		if shell.options().posix_mode
			&& shell
				.builtins()
				.get(&func_name)
				.is_some_and(|r| r.special_builtin)
		{
			return Err(
				error::Error::from(error::ErrorKind::FunctionNameShadowsSpecialBuiltin {
					name: func_name,
				})
				.into_fatal(),
			);
		}

		// The function definition's source context should be the same as the current
		// frame so we directly pass that through.
		let source_info = shell
			.call_stack()
			.current_frame()
			.map_or_else(crate::SourceInfo::default, |frame| frame.adjusted_source_info());
		shell.define_func(func_name, self.clone(), &source_info);

		let result = ExecutionResult::success();
		shell.set_last_exit_status(result.exit_code.into());

		Ok(result)
	}
}

#[async_trait::async_trait]
#[allow(clippy::too_many_lines)]
impl<SE: extensions::ShellExtensions> ExecuteInPipeline<SE> for ast::SimpleCommand {
	async fn execute_in_pipeline(
		&self,
		mut context: PipelineExecutionContext<'_, SE>,
		mut params: ExecutionParameters,
	) -> Result<ExecutionSpawnResult, error::Error> {
		ensure_not_cancelled(&params)?;
		let prefix_iter = self.prefix.as_ref().map(|s| s.0.iter()).unwrap_or_default();
		let suffix_iter = self.suffix.as_ref().map(|s| s.0.iter()).unwrap_or_default();
		let cmd_name_items = self
			.word_or_name
			.as_ref()
			.map(|won| CommandPrefixOrSuffixItem::Word(won.clone()));

		// Bash expands every command word first (`expand_word_list_internal`),
		// so an expansion error stops before an assignment or a redirection
		// takes effect. The prefix assignments wait until after the words.
		let mut pending_assignments: Vec<&ast::Assignment> = vec![];
		let mut args: Vec<CommandArg> = vec![];

		// Capture the status change count before expansion, so we can detect
		// if expansion (e.g., command substitution) set an exit status.
		let status_change_count_before_expansion = context.shell.last_exit_status_change_count();

		let items: Vec<&CommandPrefixOrSuffixItem> =
			prefix_iter.chain(cmd_name_items.iter()).chain(suffix_iter).collect();
		// An assignment word is a prefix assignment where the parser found it
		// before the command name; after a command name that expands to
		// nothing it is still a word (`$empty a=1` runs `a=1`).
		let prefix_len = self.prefix.as_ref().map_or(0, |prefix| prefix.0.len());
		let command_takes_assignments = takes_assignment_arguments(&context.shell, &items);
		for (index, &item) in items.iter().enumerate() {
			ensure_not_cancelled(&params)?;
			match item {
				CommandPrefixOrSuffixItem::IoRedirect(_) => {},
				CommandPrefixOrSuffixItem::ProcessSubstitution(kind, subshell_command) => {
					params.disable_command_output_marking();
					let (installed_fd_num, substitution_file) =
						setup_process_substitution(&mut context.shell, &params, kind, subshell_command)?;

					params
						.open_files
						.set_fd(installed_fd_num, substitution_file);

					args.push(CommandArg::String(std::format!("/dev/fd/{installed_fd_num}")));
				},
				CommandPrefixOrSuffixItem::AssignmentWord(assignment, word) => {
					if index < prefix_len {
						pending_assignments.push(assignment);
					} else if command_takes_assignments {
						// A declaration builtin receives this as an
						// assignment argument; it is a command word, so it
						// expands before any prefix assignment value.
						forget_reported_jobs_for_compound_assignment(&mut context.shell, assignment);
						let expanded = expand_assignment(&mut context.shell, &params, assignment).await?;
						args.push(CommandArg::Assignment(expanded));
					} else {
						let mut next_args =
							expansion::full_expand_and_split_word(&mut context.shell, &params, word)
								.await?
								.into_iter()
								.map(CommandArg::String)
								.collect();
						args.append(&mut next_args);
					}
				},
				CommandPrefixOrSuffixItem::Word(arg) => {
					let mut next_args =
						expansion::full_expand_and_split_word(&mut context.shell, &params, arg).await?;

					if args.is_empty()
						&& let Some(cmd_name) = next_args.first()
						&& let Some(alias_value) = context.shell.aliases().get(cmd_name.as_str())
					{
						//
						// TODO(#57): This is a total hack; aliases are supposed to be
						// handled much earlier in the process.
						//
						let mut alias_pieces: Vec<_> = alias_value
							.split_ascii_whitespace()
							.map(|i| i.to_owned())
							.collect();

						next_args.remove(0);
						alias_pieces.append(&mut next_args);

						next_args = alias_pieces;
					}

					let mut next_args = next_args.into_iter().map(CommandArg::String).collect();
					args.append(&mut next_args);
				},
			}
		}
		// Then each prefix assignment in turn, expanded and assigned once
		// (`do_assignment_statements`): with a command name into its temporary
		// environment (`assign_in_env`), else into the shell
		// (`do_word_assignment`). Only then the redirections.
		let has_command = matches!(args.first(), Some(CommandArg::String(_)));
		let mut temporary_environment = None;
		if has_command {
			// In POSIX mode an assignment error before a special builtin
			// exits a non-interactive shell, and otherwise abandons the
			// command being run (`DISCARD` in `do_assignment_statements`).
			let posix_mode = context.shell.options().posix_mode;
			let special_builtin = posix_mode
				&& args.first().is_some_and(|name| is_special_builtin(&context.shell, &name.to_string()));
			context.shell.env_mut().push_scope(EnvironmentScope::Command);
			for &assignment in &pending_assignments {
				if let Err(err) = apply_temporary_assignment(&mut context.shell, &params, assignment).await {
					let _ = context.shell.env_mut().pop_scope(EnvironmentScope::Command);
					let err = if special_builtin { err.into_fatal() } else { err };
					let mut stderr = params.stderr(&context.shell);
					let _ = context.shell.display_error(&mut stderr, &err).await;
					let mut result = err.into_result(&context.shell);
					if posix_mode && result.is_normal_flow() {
						result.next_control_flow = ExecutionControlFlow::DiscardCommand;
					}
					return Ok(result.into());
				}
			}
			// A redirection does not see the temporary environment
			// (`expanding_redir` keeps `find_variable` out of it).
			temporary_environment = Some(context.shell.env_mut().pop_scope_variables(EnvironmentScope::Command)?);
		} else {
			for &assignment in &pending_assignments {
				forget_reported_jobs_for_compound_assignment(&mut context.shell, assignment);
				// Apply the assignment. Don't mark as fatal - let errors be handled
				// at the program level so multiple complete_commands can execute independently.
				let applied = apply_assignment(
					assignment,
					&mut context.shell,
					&params,
					false,
					None,
					EnvironmentScope::Global,
				)
				.await;
				// An assignment statement that cannot assign (a readonly
				// variable) abandons the command being run, and exits a
				// non-interactive POSIX-mode shell unless it runs under
				// `command` (`do_assignment_statements`).
				if let Err(err) = applied {
					if !matches!(err.kind(), error::ErrorKind::ReadonlyVariable) {
						return Err(err);
					}
					let mut stderr = params.stderr(&context.shell);
					let _ = context.shell.display_error(&mut stderr, &err).await;
					let mut result = err.into_result(&context.shell);
					result.next_control_flow = if context.shell.options().posix_mode
						&& !context.shell.options().interactive
						&& !params.executing_command_builtin
					{
						ExecutionControlFlow::ExitShell
					} else {
						ExecutionControlFlow::DiscardCommand
					};
					return Ok(result.into());
				}
			}
			// Bash runs a null command in a child when one of its redirections
			// reads standard input, which installs a job.
			if null_command_forks(&items) {
				context.shell.jobs_mut().remove_reported_jobs();
			}
		}
		for &item in &items {
			let CommandPrefixOrSuffixItem::IoRedirect(redirect) = item else {
				continue;
			};
			if let Err(error) = setup_redirect(&mut context.shell, &mut params, redirect).await {
				return fail_simple_command_redirect(&mut context.shell, &params, &error, &args).await;
			}
		}
		if let Some(variables) = temporary_environment {
			context.shell.env_mut().push_scope_variables(EnvironmentScope::Command, variables);
		}

		// If we have a command, then execute it.
		if let Some(CommandArg::String(cmd_name)) = args.first().cloned() {
			let mut stderr = params.stderr(&context.shell);
			// The token that leaves this command's end unreported, if any; see
			// `ExecutionParameters::set_quiet_cancellation`.
			let quiet_token = params.quiet_cancellation.then(|| params.cancel_token()).flatten();

			let (owned_shell, parent_shell) = match context.shell {
				commands::ShellForCommand::ParentShell(shell) => (None, shell),
				commands::ShellForCommand::OwnedShell { target, parent } => (Some(target), parent),
			};

			let shell = if let Some(owned_shell) = owned_shell {
				commands::ShellForCommand::OwnedShell { target: owned_shell, parent: parent_shell }
			} else {
				commands::ShellForCommand::ParentShell(parent_shell)
			};

			let context =
				PipelineExecutionContext {
					shell,
					process_group_id: context.process_group_id,
					in_pipeline: context.in_pipeline,
				};

			match execute_command(context, params, cmd_name, args).await {
				Ok(result) => Ok(result),
				Err(err) => {
					if !quiet_token.as_ref().is_some_and(CancellationToken::is_cancelled) {
						let _ = parent_shell.display_error(&mut stderr, &err).await;
					}

					let result = err.into_result(parent_shell);
					Ok(result.into())
				},
			}
		} else {
			// Assignment-only statements clear $_ (set to empty string).
			// This matches bash behavior where assignments don't have a "last
			// argument".
			context.shell.update_last_arg_variable(None);

			// We need to set the last exit status to indicate assignment success,
			// but only if there was no status set during expansion. We use the
			// status count captured before expansion to detect if command
			// substitution (or other expansion) set an exit status.
			if status_change_count_before_expansion == context.shell.last_exit_status_change_count() {
				context.shell.set_last_exit_status(0);
			}

			// Return the last exit status we have; in some cases, an expansion
			// might result in a non-zero exit status stored in the shell.
			Ok(ExecutionResult::from(ExecutionExitCode::from(context.shell.last_exit_status())).into())
		}
	}
}

/// Bash reads the text of a compound array assignment (`name=(...)`) with
/// its parser when it performs the assignment (`parse_string_to_word_list`),
/// even an empty one, and reading text forgets the ended jobs that were
/// reported (`notify_and_cleanup` in `shell_getc`). That happens for an
/// assignment statement and for an argument of `declare`, `local` and the
/// other declaration builtins; a compound assignment before a command name
/// is kept as it is written instead.
fn forget_reported_jobs_for_compound_assignment(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	assignment: &ast::Assignment,
) {
	if matches!(assignment.value, ast::AssignmentValue::Array(_)) {
		shell.jobs_mut().remove_reported_jobs();
	}
}

/// Whether Bash runs a simple command with no command name in a child
/// (`execute_null_command`): when one of its redirections targets standard
/// input with `<`, `<>`, a word duplication or a close (`0<&$fd`, `0>&$fd`,
/// `<&-`). Duplicating a number (`<&3`) and a here-document do not count.
fn null_command_forks(items: &[&CommandPrefixOrSuffixItem]) -> bool {
	items.iter().any(|item| {
		let CommandPrefixOrSuffixItem::IoRedirect(ast::IoRedirect::File(fd, kind, target)) = item else {
			return false;
		};
		let reads = matches!(
			kind,
			ast::IoFileRedirectKind::Read
				| ast::IoFileRedirectKind::ReadAndWrite
				| ast::IoFileRedirectKind::DuplicateInput
		);
		if fd.unwrap_or(if reads { 0 } else { 1 }) != 0 {
			return false;
		}
		match (kind, target) {
			(ast::IoFileRedirectKind::Read | ast::IoFileRedirectKind::ReadAndWrite, _) => true,
			(
				ast::IoFileRedirectKind::DuplicateInput | ast::IoFileRedirectKind::DuplicateOutput,
				ast::IoFileRedirectTarget::Duplicate(word),
			) => !word.value.bytes().all(|byte| byte.is_ascii_digit()),
			_ => false,
		}
	})
}

/// Finishes a simple command whose redirection failed. Every word and prefix
/// assignment has already taken effect, as Bash's `expand_words` does before
/// the redirections. A command Bash runs as a child was forked before that
/// child failed the redirection, which installs a job and so forgets the
/// ended jobs that were reported (`stop_pipeline`); a builtin or function
/// fails in the shell itself. In POSIX mode a special builtin's failure
/// exits a non-interactive shell (`execute_simple_command`).
async fn fail_simple_command_redirect(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	error: &error::Error,
	args: &[CommandArg],
) -> Result<ExecutionSpawnResult, error::Error> {
	let words: Vec<String> = args.iter().map(ToString::to_string).collect();
	if !words.is_empty() && commands::command_starts_child(shell, &words) {
		shell.jobs_mut().remove_reported_jobs();
	}
	let mut stderr = params.stderr(shell);
	shell.display_error(&mut stderr, error).await?;
	let mut result = ExecutionResult::general_error();
	if shell.options().posix_mode
		&& !shell.options().interactive
		&& words.first().is_some_and(|name| is_special_builtin(shell, name))
	{
		result.next_control_flow = ExecutionControlFlow::ExitShell;
	}
	Ok(result.into())
}

/// Whether `name` runs an enabled special builtin.
fn is_special_builtin(shell: &Shell<impl extensions::ShellExtensions>, name: &str) -> bool {
	shell.builtins().get(name).is_some_and(|builtin| !builtin.disabled && builtin.special_builtin)
}

/// Whether the assignment words among this command's arguments are
/// assignments, as Bash's `fix_assignment_words` decides before it expands
/// any word: the first word after the prefix assignments, past any
/// `command` words in POSIX mode, must name a declaration builtin as it is
/// written. So `command export x=$v` (outside POSIX mode), `builtin export
/// x=$v` and `"export" x=$v` expand and split `x=$v` as any other word,
/// and the builtin assigns what it receives.
fn takes_assignment_arguments(
	shell: &Shell<impl extensions::ShellExtensions>,
	items: &[&CommandPrefixOrSuffixItem],
) -> bool {
	let mut words = items
		.iter()
		.filter(|item| !matches!(item, CommandPrefixOrSuffixItem::IoRedirect(_)))
		.skip_while(|item| matches!(item, CommandPrefixOrSuffixItem::AssignmentWord(..)))
		.map(|item| match item {
			CommandPrefixOrSuffixItem::Word(word) | CommandPrefixOrSuffixItem::AssignmentWord(_, word) => {
				Some(word.value.as_str())
			},
			_ => None,
		});
	let mut name = words.next().flatten();
	if shell.options().posix_mode {
		while name == Some("command") {
			name = words.next().flatten();
		}
	} else if let Some(alias) = name.and_then(|name| shell.aliases().get(name)) {
		// brush expands an alias as the command name is expanded.
		name = alias.split_ascii_whitespace().next();
	}
	name.is_some_and(|name| {
		shell.builtins().get(name).is_some_and(|builtin| !builtin.disabled && builtin.declaration_builtin)
	})
}

/// Puts one prefix assignment into the temporary environment of the command
/// it precedes, as Bash's `assign_in_env` does: a readonly variable is
/// refused before its value is expanded; without POSIX mode that is
/// reported and the command runs on (`tempenv_assign_error`). The temporary
/// variable is a plain exported string: the expanded value, or for `+=` on
/// a variable the command sees, that variable's value with the expanded
/// value appended as an assignment to it appends it (`make_variable_value`
/// with `ASS_APPEND`: integer addition for an integer variable, the string
/// joined otherwise). The variable itself is left as it is.
async fn apply_temporary_assignment(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	assignment: &ast::Assignment,
) -> Result<(), error::Error> {
	let name = match &assignment.name {
		ast::AssignmentName::VariableName(name) | ast::AssignmentName::ArrayElementName(name, _) => name,
	};
	if shell.env().get(name).is_some_and(|(_, variable)| variable.is_readonly()) {
		let error = error::Error::from(error::ErrorKind::ReadonlyVariable);
		if shell.options().posix_mode {
			return Err(error);
		}
		let mut stderr = params.stderr(shell);
		shell.display_error(&mut stderr, &error).await?;
		return Ok(());
	}
	let (ast::AssignmentName::VariableName(name), ast::AssignmentValue::Scalar(word)) =
		(&assignment.name, &assignment.value)
	else {
		// Ensure it's tagged as exported and created in the command scope.
		return apply_assignment(
			assignment,
			shell,
			params,
			true,
			Some(EnvironmentScope::Command),
			EnvironmentScope::Command,
		)
		.await;
	};
	let value = expansion::basic_expand_assignment_word(shell, params, word).await?;
	if shell.options().print_commands_and_arguments {
		let op = if assignment.append { "+=" } else { "=" };
		shell.trace_command(params, std::format!("{name}{op}{value}")).await;
	}
	let value = match shell.env().get(name) {
		Some((_, existing)) if assignment.append => {
			let mut appended = existing.clone();
			appended.assign(ShellValueLiteral::Scalar(value), true)?;
			appended.value().to_cow_str(shell).into_owned()
		},
		_ => value,
	};
	let mut variable = ShellVariable::new(ShellValue::String(value));
	variable.export();
	shell.env_mut().add(name, variable, EnvironmentScope::Command)
}

/// Ends a special builtin's temporary environment in POSIX mode as Bash's
/// `merge_temporary_env` does (`push_posix_temp_var`): each variable in it
/// is then assigned in the shell, as an assignment statement would, and
/// stays exported.
fn merge_temporary_environment<SE: extensions::ShellExtensions>(shell: &mut Shell<SE>) -> Result<(), error::Error> {
	let variables = shell.env_mut().pop_scope_variables(EnvironmentScope::Command)?;
	for (name, mut variable) in variables {
		let value = match variable.value() {
			ShellValue::String(value) => ShellValueLiteral::Scalar(value.clone()),
			_ => {
				variable.export();
				shell.env_mut().add(name, variable, EnvironmentScope::Global)?;
				continue;
			},
		};
		shell.env_mut().update_or_add(
			name,
			value,
			|variable| {
				variable.export();
				Ok(())
			},
			EnvironmentLookup::Anywhere,
			EnvironmentScope::Global,
		)?;
	}
	Ok(())
}

/// Runs the command; the caller has pushed its temporary environment scope
/// and put the prefix assignments in it, and the command pops it when it
/// has run.
async fn execute_command<SE: extensions::ShellExtensions>(
	mut context: PipelineExecutionContext<'_, SE>,
	params: ExecutionParameters,
	cmd_name: String,
	args: Vec<CommandArg>,
) -> Result<ExecutionSpawnResult, error::Error> {
	if context.shell.options().print_commands_and_arguments {
		context
			.shell
			.trace_command(&params, args.iter().map(|arg| arg.quote_for_tracing()).join(" "))
			.await;
	}
	let merge = context.shell.options().posix_mode && is_special_builtin(&context.shell, &cmd_name);

	// Construct the command struct.
	let mut cmd = commands::SimpleCommand::new(context.shell, params, cmd_name, args);
	cmd.process_group_id = context.process_group_id;
	cmd.in_pipeline = context.in_pipeline;

	// Arrange to pop off that ephemeral environment scope.
	let post_execute: fn(&mut Shell<SE>) -> Result<(), error::Error> = if merge {
		merge_temporary_environment
	} else {
		|shell| shell.env_mut().pop_scope(EnvironmentScope::Command)
	};
	cmd.post_execute = Some(post_execute);

	// Run through any pre-execution hooks as best effort.
	let _ = commands::on_preexecute(&mut cmd).await;

	// Execute
	// TODO(jobs): do we need to move self back to foreground on error here?
	cmd.execute().await
}

async fn expand_assignment(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	assignment: &ast::Assignment,
) -> Result<ast::Assignment, error::Error> {
	let value = expand_assignment_value(shell, params, &assignment.value).await?;
	Ok(ast::Assignment {
		name: basic_expand_assignment_name(shell, params, &assignment.name).await?,
		value,
		append: assignment.append,
		loc: assignment.loc.clone(),
	})
}

async fn basic_expand_assignment_name(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	name: &ast::AssignmentName,
) -> Result<ast::AssignmentName, error::Error> {
	match name {
		ast::AssignmentName::VariableName(name) => {
			let expanded = expansion::basic_expand_word(shell, params, name).await?;
			Ok(ast::AssignmentName::VariableName(expanded))
		},
		ast::AssignmentName::ArrayElementName(name, index) => {
			let expanded_name = expansion::basic_expand_word(shell, params, name).await?;
			let expanded_index = expansion::basic_expand_word(shell, params, index).await?;
			Ok(ast::AssignmentName::ArrayElementName(expanded_name, expanded_index))
		},
	}
}

async fn expand_assignment_value(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	value: &ast::AssignmentValue,
) -> Result<ast::AssignmentValue, error::Error> {
	let expanded = match value {
		ast::AssignmentValue::Scalar(s) => {
			let expanded_word = expansion::basic_expand_assignment_word(shell, params, s).await?;
			ast::AssignmentValue::Scalar(ast::Word::from(expanded_word))
		},
		ast::AssignmentValue::Array(arr) => {
			let mut expanded_values = vec![];
			for (key, value) in arr {
				if let Some(k) = key {
					let expanded_key = expansion::basic_expand_assignment_word(shell, params, k)
						.await?
						.into();
					let expanded_value = expansion::basic_expand_assignment_word(shell, params, value)
						.await?
						.into();
					expanded_values.push((Some(expanded_key), expanded_value));
				} else {
					// Array elements are treated as regular words, not assignments
					let split_expanded_value =
						expansion::full_expand_and_split_word(shell, params, value).await?;
					for expanded_value in split_expanded_value {
						expanded_values.push((None, expanded_value.into()));
					}
				}
			}

			ast::AssignmentValue::Array(expanded_values)
		},
	};

	Ok(expanded)
}

#[expect(clippy::too_many_lines)]
async fn apply_assignment(
	assignment: &ast::Assignment,
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	mut export: bool,
	required_scope: Option<EnvironmentScope>,
	creation_scope: EnvironmentScope,
) -> Result<(), error::Error> {
	// Figure out if we are trying to assign to a variable or assign to an element
	// of an existing array.
	let mut array_index;
	let variable_name = match &assignment.name {
		ast::AssignmentName::VariableName(name) => {
			array_index = None;
			name
		},
		ast::AssignmentName::ArrayElementName(name, index) => {
			let expanded = expansion::basic_expand_word(shell, params, index).await?;
			array_index = Some(expanded);
			name
		},
	};

	// Expand the values.
	let new_value = match &assignment.value {
		ast::AssignmentValue::Scalar(unexpanded_value) => {
			let value =
				expansion::basic_expand_assignment_word(shell, params, unexpanded_value).await?;
			ShellValueLiteral::Scalar(value)
		},
		ast::AssignmentValue::Array(unexpanded_values) => {
			let mut elements = vec![];
			for (unexpanded_key, unexpanded_value) in unexpanded_values {
				let key = match unexpanded_key {
					Some(unexpanded_key) => Some(
						expansion::basic_expand_assignment_word(shell, params, unexpanded_key).await?,
					),
					None => None,
				};

				if key.is_some() {
					let value =
						expansion::basic_expand_assignment_word(shell, params, unexpanded_value).await?;
					elements.push((key, value));
				} else {
					// Array elements are treated as regular words, not assignments
					let values =
						expansion::full_expand_and_split_word(shell, params, unexpanded_value).await?;
					for value in values {
						elements.push((None, value));
					}
				}
			}
			ShellValueLiteral::Array(ArrayLiteral(elements))
		},
	};

	if shell.options().print_commands_and_arguments {
		let op = if assignment.append { "+=" } else { "=" };
		shell
			.trace_command(params, std::format!("{}{op}{new_value}", assignment.name))
			.await;
	}

	// See if we need to eval an array index.
	if let Some(idx) = &array_index {
		let will_be_indexed_array = if let Some((_, existing_value)) = shell.env().get(variable_name)
		{
			matches!(
				existing_value.value(),
				ShellValue::IndexedArray(_) | ShellValue::Unset(ShellValueUnsetType::IndexedArray)
			)
		} else {
			true
		};

		if will_be_indexed_array {
			array_index = Some(
				arithmetic::expand_and_eval(shell, params, idx.as_str(), false)
					.await?
					.to_string(),
			);
		}
	}

	// Read option before taking mutable borrow on env.
	let export_variables_on_modification = shell.options().export_variables_on_modification;

	// See if we can find an existing value associated with the variable.
	if let Some((existing_value_scope, existing_value)) =
		shell.env_mut().get_mut(variable_name.as_str())
	{
		if required_scope.is_none() || Some(existing_value_scope) == required_scope {
			if let Some(array_index) = array_index {
				match new_value {
					ShellValueLiteral::Scalar(s) => {
						existing_value.assign_at_index(array_index, s, assignment.append)?;
					},
					ShellValueLiteral::Array(_) => {
						return Err(error::ErrorKind::AssigningListToArrayMember.into());
					},
				}
			} else {
				if !export
					&& export_variables_on_modification
					&& !matches!(new_value, ShellValueLiteral::Array(_))
				{
					export = true;
				}

				existing_value.assign(new_value, assignment.append)?;
			}

			if export {
				existing_value.export();
			}

			// That's it!
			return Ok(());
		}
	}

	// If we fell down here, then we need to add it.
	let new_value = if let Some(array_index) = array_index {
		match new_value {
			ShellValueLiteral::Scalar(s) => {
				ShellValue::indexed_array_from_literals(ArrayLiteral(vec![(Some(array_index), s)]))
			},
			ShellValueLiteral::Array(_) => {
				return Err(error::ErrorKind::AssigningListToArrayMember.into());
			},
		}
	} else {
		match new_value {
			ShellValueLiteral::Scalar(s) => {
				export = export || shell.options().export_variables_on_modification;
				ShellValue::String(s)
			},
			ShellValueLiteral::Array(values) => ShellValue::indexed_array_from_literals(values),
		}
	};

	let mut new_var = ShellVariable::new(new_value);

	if export {
		new_var.export();
	}

	shell.env_mut().add(variable_name, new_var, creation_scope)
}

#[expect(clippy::too_many_lines)]
pub(crate) async fn setup_redirect(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &'_ mut ExecutionParameters,
	redirect: &ast::IoRedirect,
) -> Result<(), error::Error> {
	params.disable_command_output_marking();
	match redirect {
		ast::IoRedirect::OutputAndError(f, append) => {
			let mut expanded_fields = expansion::full_expand_and_split_word(shell, params, f).await?;
			if expanded_fields.len() != 1 {
				return Err(error::ErrorKind::InvalidRedirection.into());
			}

			let expanded_file_path = expanded_fields.remove(0);
			setup_redirect_output_and_error_to(shell, params, &expanded_file_path, *append).await?;
		},

		ast::IoRedirect::File(specified_fd_num, kind, target) => {
			match target {
				ast::IoFileRedirectTarget::Filename(f) => {
					let mut options = pi_vfs::OpenOptions::new();

					let mut expanded_fields =
						expansion::full_expand_and_split_word(shell, params, f).await?;

					if expanded_fields.len() != 1 {
						return Err(error::ErrorKind::InvalidRedirection.into());
					}

					let expanded_file_path: PathBuf =
						shell.absolute_path(Path::new(expanded_fields.remove(0).as_str()));

					let default_fd_if_unspecified = get_default_fd_for_redirect_kind(kind);
					match kind {
						ast::IoFileRedirectKind::Read => {
							options.read(true);
						},
						ast::IoFileRedirectKind::Write => {
							if shell
								.options()
								.disallow_overwriting_regular_files_via_output_redirection
							{
								// First check to see if the path points to an existing regular
								// file.
								if !shell.filesystem().is_file(&expanded_file_path).await {
									options.create(true);
								} else {
									options.create_new(true);
								}
								options.write(true);
							} else {
								options.create(true);
								options.write(true);
								options.truncate(true);
							}
						},
						ast::IoFileRedirectKind::Append => {
							options.create(true);
							options.append(true);
						},
						ast::IoFileRedirectKind::ReadAndWrite => {
							options.create(true);
							options.read(true);
							options.write(true);
						},
						ast::IoFileRedirectKind::Clobber => {
							options.create(true);
							options.write(true);
							options.truncate(true);
						},
						ast::IoFileRedirectKind::DuplicateInput => {
							options.read(true);
						},
						ast::IoFileRedirectKind::DuplicateOutput => {
							options.create(true);
							options.write(true);
						},
					}

					let fd_num = specified_fd_num.unwrap_or(default_fd_if_unspecified);

					let follows = params.touches_deferred(fd_num);
					if params.defer_fifo_redirects
						&& let Some(op) = deferred_open_operator(kind)
						&& let Some(redirect) = child_open(
							shell,
							fd_num,
							op,
							&expanded_file_path,
							&options,
							follows,
							// Opening a FIFO for reading and writing never waits.
							!matches!(kind, ast::IoFileRedirectKind::ReadAndWrite),
						) {
						params.defer(redirect)?;
						return Ok(());
					}
					if follows {
						materialize_deferred_redirects(shell, params).await?;
					}

					let opened_file = shell
						.open_file(&options, &expanded_file_path, params)
						.await
						.map_err(|err| {
							error::ErrorKind::RedirectionFailure(
								expanded_file_path.to_string_lossy().to_string(),
								err,
							)
						})?;

					params.open_files.set_fd(fd_num, opened_file);
				},

				ast::IoFileRedirectTarget::Fd(fd) => {
					let default_fd_if_unspecified = match kind {
						ast::IoFileRedirectKind::DuplicateInput => 0,
						ast::IoFileRedirectKind::DuplicateOutput => 1,
						_ => {
							return Err(error::ErrorKind::InternalError(format!(
								"unexpected redirect kind for file descriptor target: {kind:?}"
							))
							.into());
						},
					};

					let fd_num = specified_fd_num.unwrap_or(default_fd_if_unspecified);

					let touched = params.touches_deferred(fd_num) || params.touches_deferred(*fd);
					if touched && fd_num <= MAX_DEFERRED_FD && *fd <= MAX_DEFERRED_FD {
						params.defer(DeferredRedirect::Duplicate { fd: fd_num, from: *fd })?;
						return Ok(());
					}
					if touched {
						materialize_deferred_redirects(shell, params).await?;
					}

					if let Some(f) = params.try_fd(shell, *fd) {
						let target_file = f.try_clone()?;

						params.open_files.set_fd(fd_num, target_file);
					} else {
						return Err(error::ErrorKind::BadFileDescriptor(*fd).into());
					}
				},

				ast::IoFileRedirectTarget::Duplicate(word) => {
					let default_fd_if_unspecified = match kind {
						ast::IoFileRedirectKind::DuplicateInput => 0,
						ast::IoFileRedirectKind::DuplicateOutput => 1,
						_ => {
							return Err(error::ErrorKind::InternalError(format!(
								"unexpected redirect kind for duplicate target: {kind:?}"
							))
							.into());
						},
					};

					let fd_num = specified_fd_num.unwrap_or(default_fd_if_unspecified);

					let mut expanded_fields =
						expansion::full_expand_and_split_word(shell, params, word).await?;

					if expanded_fields.len() != 1 {
						return Err(error::ErrorKind::InvalidRedirection.into());
					}

					let mut expanded = expanded_fields.remove(0);

					let dash = if expanded.ends_with('-') {
						expanded.pop();
						true
					} else {
						false
					};

					let source = (!expanded.is_empty() && expanded.chars().all(|c| c.is_ascii_digit()))
						.then(|| expanded.parse::<ShellFd>().ok())
						.flatten();
					let touched = params.touches_deferred(fd_num)
						|| source.is_some_and(|source| params.touches_deferred(source));
					if touched && fd_num <= MAX_DEFERRED_FD {
						// The child makes it after the deferred redirections: a
						// duplication, a move (`N>&M-`, which `sh` spells `N>&M M>&-`)
						// or a close (`N>&-`).
						match source {
							Some(from) if from <= MAX_DEFERRED_FD => {
								params.defer(DeferredRedirect::Duplicate { fd: fd_num, from })?;
								if dash {
									params.defer(DeferredRedirect::Close { fd: from })?;
								}
								return Ok(());
							},
							None if dash && expanded.is_empty() => {
								params.defer(DeferredRedirect::Close { fd: fd_num })?;
								return Ok(());
							},
							_ => {},
						}
					}
					// `>&file` defers through `setup_redirect_output_and_error_to`.
					if touched && (source.is_some() || dash && expanded.is_empty()) {
						materialize_deferred_redirects(shell, params).await?;
					}

					if expanded.is_empty() {
						// Nothing to do
					} else if expanded.chars().all(|c: char| c.is_ascii_digit()) {
						let source_fd_num = expanded
							.parse::<ShellFd>()
							.map_err(|_| error::ErrorKind::InvalidRedirection)?;

						// Duplicate the fd.
						let target_file = if let Some(f) = params.try_fd(shell, source_fd_num) {
							f.try_clone()?
						} else {
							return Err(error::ErrorKind::BadFileDescriptor(source_fd_num).into());
						};

						params.open_files.set_fd(fd_num, target_file);
					} else if fd_num == 1 && !dash {
						// Special case for compatibility: redirect stdout and stderr to the file
						// given by `expanded`.
						setup_redirect_output_and_error_to(
							shell, params, &expanded, false, /* append? */
						)
						.await?;
					} else {
						return Err(error::ErrorKind::InvalidRedirection.into());
					}

					if dash {
						// Close the specified fd. Ignore it if it's not valid.
						params.open_files.remove_fd(fd_num);
					}
				},

				ast::IoFileRedirectTarget::ProcessSubstitution(substitution_kind, subshell_cmd) => {
					match kind {
						ast::IoFileRedirectKind::Read
						| ast::IoFileRedirectKind::Write
						| ast::IoFileRedirectKind::Append
						| ast::IoFileRedirectKind::ReadAndWrite
						| ast::IoFileRedirectKind::Clobber => {
							let (substitution_fd, substitution_file) =
								setup_process_substitution(shell, params, substitution_kind, subshell_cmd)?;

							let target_file = substitution_file.try_clone()?;
							params.open_files.set_fd(substitution_fd, substitution_file);

							let fd_num =
								specified_fd_num.unwrap_or_else(|| get_default_fd_for_redirect_kind(kind));
							if params.touches_deferred(fd_num) || params.touches_deferred(substitution_fd) {
								materialize_deferred_redirects(shell, params).await?;
							}

							params.open_files.set_fd(fd_num, target_file);
						},
						_ => {
							return Err(error::ErrorKind::InternalError(format!(
								"process substitution used with invalid redirect kind: {kind:?}"
							))
							.into());
						},
					}
				},
			}
		},

		ast::IoRedirect::HereDocument(fd_num, io_here) => {
			// If not specified, default to stdin (fd 0).
			let fd_num = fd_num.unwrap_or(0);

			// Expand if required.
			let io_here_doc = if io_here.requires_expansion {
				expansion::basic_expand_heredoc_word(shell, params, &io_here.doc).await?
			} else {
				io_here.doc.flatten()
			};

			let f = setup_open_file_with_contents("here-document", io_here_doc.as_str())?;
			if params.touches_deferred(fd_num) {
				materialize_deferred_redirects(shell, params).await?;
			}

			params.open_files.set_fd(fd_num, f);
		},

		ast::IoRedirect::HereString(fd_num, word) => {
			// If not specified, default to stdin (fd 0).
			let fd_num = fd_num.unwrap_or(0);

			let mut expanded_word = expansion::basic_expand_word(shell, params, word).await?;
			expanded_word.push('\n');

			let f = setup_open_file_with_contents("here-string", expanded_word.as_str())?;
			if params.touches_deferred(fd_num) {
				materialize_deferred_redirects(shell, params).await?;
			}

			params.open_files.set_fd(fd_num, f);
		},
	}

	Ok(())
}

/// Sets up redirection of both stdout and stderr to the same file, given by
/// `file_path`.
///
/// # Arguments
///
/// * `shell` - The shell instance.
/// * `params` - The execution parameters to modify.
/// * `file_path` - The path to the file to redirect output and error to.
/// * `append` - Whether to append. If `false`, the file will be truncated.
async fn setup_redirect_output_and_error_to(
	shell: &Shell<impl extensions::ShellExtensions>,
	params: &mut ExecutionParameters,
	file_path: &str,
	append: bool,
) -> Result<(), error::Error> {
	let abs_file_path: PathBuf = shell.absolute_path(Path::new(file_path));

	let mut file_options = pi_vfs::OpenOptions::new();
	file_options
		.create(true)
		.write(true)
		.truncate(!append)
		.append(append);

	let follows =
		params.touches_deferred(OpenFiles::STDOUT_FD) || params.touches_deferred(OpenFiles::STDERR_FD);
	if params.defer_fifo_redirects
		&& let Some(redirect) = child_open(
			shell,
			OpenFiles::STDOUT_FD,
			if append { ">>" } else { ">" },
			&abs_file_path,
			&file_options,
			follows,
			true,
		) {
		params.defer(redirect)?;
		params.defer(DeferredRedirect::Duplicate {
			fd:   OpenFiles::STDERR_FD,
			from: OpenFiles::STDOUT_FD,
		})?;
		return Ok(());
	}
	if follows {
		materialize_deferred_redirects(shell, params).await?;
	}

	let stdout_file = shell
		.open_file(&file_options, &abs_file_path, params)
		.await
		.map_err(|err| {
			error::ErrorKind::RedirectionFailure(abs_file_path.to_string_lossy().to_string(), err)
		})?;

	let stderr_file = stdout_file.try_clone()?;

	params.open_files.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.open_files.set_fd(OpenFiles::STDERR_FD, stderr_file);

	Ok(())
}

/// The `sh` operator that repeats an open of `kind` in the child; `None` for
/// kinds that are not plain opens.
const fn deferred_open_operator(kind: &ast::IoFileRedirectKind) -> Option<&'static str> {
	match kind {
		ast::IoFileRedirectKind::Read => Some("<"),
		ast::IoFileRedirectKind::Write | ast::IoFileRedirectKind::Clobber => Some(">"),
		ast::IoFileRedirectKind::Append => Some(">>"),
		ast::IoFileRedirectKind::ReadAndWrite => Some("<>"),
		ast::IoFileRedirectKind::DuplicateInput | ast::IoFileRedirectKind::DuplicateOutput => None,
	}
}

/// What a background external command's child does in place of this process
/// opening `path` on `fd` with the `sh` operator `op` (see
/// [`DeferredRedirect`]), or `None` when this process opens it.
///
/// With `follows`, the open sets or reads a descriptor that a deferred
/// redirection sets or reads, so the child makes it after that one, if it
/// can: a descriptor path as the duplication it names, any other host path as
/// the same open. Only this process can open a provider path or the terminal,
/// or report an exclusive create (`noclobber`) of an existing file; nor can
/// `sh` set a descriptor above 9. Without `follows`, the open is deferred only
/// when it would wait for a FIFO's other end (`may_wait`: it is not
/// read-write).
fn child_open(
	shell: &Shell<impl extensions::ShellExtensions>,
	fd: ShellFd,
	op: &'static str,
	path: &Path,
	options: &pi_vfs::OpenOptions,
	follows: bool,
	may_wait: bool,
) -> Option<DeferredRedirect> {
	if fd > MAX_DEFERRED_FD {
		return None;
	}
	let open = || {
		path.to_str()
			.map(|path| DeferredRedirect::Open { fd, op, path: path.to_owned(), options: options.clone() })
	};
	if !follows {
		return if may_wait && is_native_fifo(shell, path) { open() } else { None };
	}
	match openfiles::DescriptorPath::parse(path) {
		Some(openfiles::DescriptorPath::Fd(from)) => {
			(from <= MAX_DEFERRED_FD).then_some(DeferredRedirect::Duplicate { fd, from })
		},
		Some(openfiles::DescriptorPath::Terminal) => None,
		None if options.is_create_new() || !shell.filesystem().is_native_local(path) => None,
		None => open(),
	}
}

/// Whether `path` names a FIFO on the host that a child process opens as the
/// same FIFO. A descriptor path (`/dev/stdout`, `/dev/fd/N`, `/proc/self/fd/N`)
/// does not qualify even when it reaches a pipe: it names a descriptor of
/// whichever process opens it, and the child's is the placeholder.
fn is_native_fifo(shell: &Shell<impl extensions::ShellExtensions>, path: &Path) -> bool {
	#[cfg(unix)]
	{
		use std::os::unix::fs::FileTypeExt;
		openfiles::DescriptorPath::parse(path).is_none()
			&& !path.starts_with("/proc")
			&& shell.filesystem().is_native_local(path)
			&& std::fs::metadata(path).is_ok_and(|meta| meta.file_type().is_fifo())
			// A symlink to a descriptor path (or `/dev/../dev/stdout`) resolves
			// under `/proc`, or fails to resolve when it reaches a pipe.
			&& std::fs::canonicalize(path).is_ok_and(|real| !real.starts_with("/proc"))
	}
	#[cfg(not(unix))]
	{
		let _ = (shell, path);
		false
	}
}

/// Makes the deferred redirections in the parent after all, in order, when a
/// later redirection depends on them or the command turns out not to be an
/// external one; the open of a FIFO then waits there, as it did before.
pub(crate) async fn materialize_deferred_redirects(
	shell: &Shell<impl extensions::ShellExtensions>,
	params: &mut ExecutionParameters,
) -> Result<(), error::Error> {
	for redirect in std::mem::take(&mut params.deferred_redirects) {
		match redirect {
			DeferredRedirect::Open { fd, path, options, .. } => {
				let file = shell.open_file(&options, &path, params).await.map_err(|err| {
					error::ErrorKind::RedirectionFailure(path.clone(), err)
				})?;
				params.open_files.set_fd(fd, file);
			},
			DeferredRedirect::Duplicate { fd, from } => {
				let file = params
					.try_fd(shell, from)
					.ok_or(error::ErrorKind::BadFileDescriptor(from))?
					.try_clone()?;
				params.open_files.set_fd(fd, file);
			},
			DeferredRedirect::Close { fd } => {
				params.open_files.remove_fd(fd);
			},
		}
	}
	Ok(())
}

/// The `/bin/sh -c` script that makes `redirects` and then becomes the
/// command given as its positional parameters: `exec "$@" 0<'/tmp/f' 2>&1`.
/// Each path is a single-quoted literal (a `'` in it written `'\''`), so the
/// script sets no variable that the command's environment could see.
pub(crate) fn deferred_redirect_script(redirects: &[DeferredRedirect]) -> String {
	use std::fmt::Write as _;
	let mut script = String::from("exec \"$@\"");
	for redirect in redirects {
		match redirect {
			DeferredRedirect::Open { fd, op, path, .. } => {
				let _ = write!(script, " {fd}{op}'{}'", path.replace('\'', "'\\''"));
			},
			DeferredRedirect::Duplicate { fd, from } => {
				let _ = write!(script, " {fd}>&{from}");
			},
			DeferredRedirect::Close { fd } => {
				let _ = write!(script, " {fd}>&-");
			},
		}
	}
	script
}

const fn get_default_fd_for_redirect_kind(kind: &ast::IoFileRedirectKind) -> ShellFd {
	match kind {
		ast::IoFileRedirectKind::Read => 0,
		ast::IoFileRedirectKind::Write => 1,
		ast::IoFileRedirectKind::Append => 1,
		ast::IoFileRedirectKind::ReadAndWrite => 0,
		ast::IoFileRedirectKind::Clobber => 1,
		ast::IoFileRedirectKind::DuplicateInput => 0,
		ast::IoFileRedirectKind::DuplicateOutput => 1,
	}
}

fn setup_process_substitution(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	kind: &ast::ProcessSubstitutionKind,
	subshell_cmd: &ast::SubshellCommand,
) -> Result<(ShellFd, OpenFile), error::Error> {
	// Bash forks a process substitution, and forgets the ended jobs a listing
	// reported when it starts a child.
	shell.jobs_mut().remove_reported_jobs();
	// TODO(execute): Don't execute synchronously!
	// Execute in a subshell.
	let mut subshell = shell.clone();

	// Set up execution parameters for the child execution.
	let mut child_params = params.clone();
	child_params.process_group_policy = ProcessGroupPolicy::SameProcessGroup;

	// Starting at 63 (a.k.a. 64-1)--and decrementing--look for an
	// available fd before starting the substitution command.
	let mut candidate_fd_num = 63;
	while params.open_files.contains_fd(candidate_fd_num) {
		candidate_fd_num -= 1;
		if candidate_fd_num == 0 {
			return Err(error::ErrorKind::TooManyOpenFiles.into());
		}
	}

	// Set up pipe so we can connect to the command.
	let (reader, writer) = ioutils::pipe("process substitution")?;
	let (reader, writer) = (reader.into(), writer.into());

	let target_file = match kind {
		ast::ProcessSubstitutionKind::Read => {
			child_params.open_files.set_fd(OpenFiles::STDOUT_FD, writer);
			reader
		},
		ast::ProcessSubstitutionKind::Write => {
			child_params.open_files.set_fd(OpenFiles::STDIN_FD, reader);
			writer
		},
	};

	// Asynchronously spawn off the subshell; we intentionally don't block on its
	// completion.
	let subshell_cmd = subshell_cmd.to_owned();
	tokio::spawn(async move {
		// Intentionally ignore the result of the subshell command.
		let _ = subshell_cmd
			.list
			.execute(&mut subshell, &child_params)
			.await;
	});


	Ok((candidate_fd_num, target_file))
}

// LOCAL DIVERGENCE (vs upstream reubeno/brush@main):
// Upstream writes the entire heredoc/here-string body into the pipe
// synchronously on the calling thread. That deadlocks any time the body
// exceeds the OS pipe buffer because the reader is not handed to the
// downstream command (and therefore not drained) until after this
// function returns. Concrete buffer sizes:
//
//   * Linux:    64 KiB default, growable via `F_SETPIPE_SZ` up to
//               `/proc/sys/fs/pipe-max-size` (1 MiB default).
//   * macOS:    16-64 KiB, no `F_SETPIPE_SZ` equivalent.
//   * Windows:  ~4 KiB (`CreatePipe(nSize = 0)`), no portable knob to
//               raise it.
//
// We keep the `F_SETPIPE_SZ` fast path for Linux (avoids a thread spawn
// for the common in-process case) but fall through to a detached writer
// thread on every other platform with OS threads, and on Linux when the
// kernel rejects the requested size (body > `pipe-max-size`). The thread
// owns the writer; it terminates naturally when the consumer drains the
// pipe or drops the reader (`BrokenPipe`), so no `JoinHandle` is retained.
// Targets without OS thread support keep upstream's synchronous write path
// so heredocs continue to work there instead of failing at thread spawn.
fn setup_open_file_with_contents(
	construct: &'static str,
	contents: &str,
) -> Result<OpenFile, error::Error> {
	let (reader, mut writer) = ioutils::pipe(construct)?;
	let bytes = contents.as_bytes();

	// Linux fast path: grow the pipe so the entire body fits inline.
	// Falls through to the generic writer when (a) `bytes.len()`
	// overflows `i32`, or (b) the kernel rejects the requested size
	// (body > /proc/sys/fs/pipe-max-size, default 1 MiB).
	#[cfg(any(target_os = "linux", target_os = "android"))]
	{
		use std::os::fd::AsFd as _;

		if let Ok(len) = i32::try_from(bytes.len())
			&& nix::fcntl::fcntl(reader.as_fd(), nix::fcntl::FcntlArg::F_SETPIPE_SZ(len)).is_ok()
		{
			writer.write_all(bytes)?;
			drop(writer);
			return Ok(reader.into());
		}
	}
	#[cfg(target_family = "wasm")]
	{
		writer.write_all(bytes)?;
		drop(writer);
		return Ok(reader.into());
	}
	#[cfg(not(target_family = "wasm"))]
	{
		// Generic path: detached writer thread. Writing inline deadlocks
		// once `bytes.len()` exceeds the OS pipe buffer (Windows ~4 KiB,
		// macOS 16-64 KiB), neither of which has a `F_SETPIPE_SZ`
		// equivalent.
		let payload = bytes.to_vec();
		std::thread::Builder::new()
			.name("brush-heredoc-writer".into())
			.spawn(move || {
				// `BrokenPipe` is expected when the consumer drops the
				// reader before the body is fully written; there is
				// nothing useful to do with that error here.
				let _ = writer.write_all(&payload);
			})?;
	}

	Ok(reader.into())
}
