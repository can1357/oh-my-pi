use std::{
	collections::VecDeque,
	io::Write,
	path::{Path, PathBuf},
	sync::{Arc, atomic::AtomicBool},
};

use brush_parser::ast::{self, CommandPrefixOrSuffixItem};
use itertools::Itertools;

use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};

use crate::{
	ShellFd,
	arithmetic::{self, ExpandAndEvaluate},
	commands::{self, CommandArg},
	env::{EnvironmentLookup, EnvironmentScope, valid_variable_name},
	error, escape, expansion, extendedtests, extensions, ioutils, jobs, openfiles,
	openfiles::{OpenFile, OpenFiles},
	pipetap::{self, PipeTap},
	results::{ExecutionExitCode, ExecutionResult, ExecutionSpawnResult, ExecutionWaitResult},
	shell::Shell,
	sys, timing,
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
	/// The spare descriptors at which files this process opened are handed to
	/// the child (see [`ExecutionParameters::defer_carried`]). They exist only
	/// for that hand-over: the child the command runs in closes them, and a
	/// command a later redirection runs must not see them.
	carried_fds:              Vec<ShellFd>,
	/// Whether this context's own cancellation goes unreported; see
	/// [`ExecutionParameters::set_quiet_cancellation`].
	quiet_cancellation:       bool,
	/// The stub of the background job this command is (see
	/// [`crate::jobstub`]): it makes the command's redirections in turn and
	/// then becomes the command, or reports why it cannot.
	#[cfg(unix)]
	job_stub:                 Option<Arc<crate::jobstub::JobStub>>,
	/// Whether the process these parameters start is a job's stub, which
	/// applies the `ulimit` settings itself, once its control socket is out
	/// of the way.
	#[cfg(unix)]
	starts_job_stub:          bool,
	/// The descriptors the job's stub has been given (by a redirection it
	/// made, or a descriptor it was handed) that this process does not hold.
	#[cfg(unix)]
	stub_fds:                 Vec<ShellFd>,
}

/// A redirection a background external command's child makes itself, after
/// the parent has spawned it. Opening a FIFO waits for its other end, which
/// may be the next command (`/bin/cat < f & echo hi > f`), so the parent must
/// not wait for it, as bash does not: bash opens it in the forked child. The
/// forked child makes these before it executes the command (see
/// [`crate::childredirects`]), so the pid the shell tracks is the command's,
/// and `$!`, `wait`, `kill` and `jobs` see it.
///
/// Once one redirection is deferred, every later one is deferred too, so the
/// child makes them all in the order written, as the child Bash forks does: a
/// later one replaces an earlier one (`/bin/echo x >f >/dev/null &` never
/// opens the FIFO in the parent), and one that cannot be made stops the rest,
/// so a file named after it is neither created nor truncated
/// (`12>f 2>log` with `ulimit -n 9` leaves `log` as it was). What only this
/// process can open (a provider path, the terminal, a here-document's or a
/// process substitution's pipe) it opens without waiting and hands the child
/// at a spare descriptor, which the child moves into place in its turn; one
/// it opens for writing it opens without truncating, and the child
/// truncates it in its turn.
#[derive(Clone)]
pub(crate) enum DeferredRedirect {
	/// `fd OP path`; `options` reopen it in the parent if the redirections
	/// must be made there after all.
	Open { fd: ShellFd, mode: ChildOpenMode, path: PathBuf, options: pi_vfs::OpenOptions },
	/// `fd>&from`.
	Duplicate { fd: ShellFd, from: ShellFd },
	/// `fd>&-`.
	Close { fd: ShellFd },
	/// Truncates the file at `fd`, which this process opened from `path`
	/// without truncating it, as `O_TRUNC` would have: a file that is not a
	/// regular file is left alone.
	Truncate { fd: ShellFd, path: PathBuf },
}

/// How the child opens a deferred path: `<`, `>` (and `>|`), `>` with
/// `noclobber`, `>>` or `<>`.
#[derive(Clone, Copy)]
pub(crate) enum ChildOpenMode {
	Read,
	Write,
	/// `>` with `noclobber` set: an existing regular file is not replaced.
	WriteNoClobber,
	Append,
	ReadWrite,
}

impl DeferredRedirect {
	/// The descriptor this redirection sets.
	const fn fd(&self) -> ShellFd {
		match self {
			Self::Open { fd, .. }
			| Self::Duplicate { fd, .. }
			| Self::Close { fd }
			| Self::Truncate { fd, .. } => *fd,
		}
	}

	/// Whether this redirection sets or reads `fd`.
	const fn touches(&self, fd: ShellFd) -> bool {
		self.fd() == fd || matches!(self, Self::Duplicate { from, .. } if *from == fd)
	}
}

impl ExecutionParameters {
	/// The redirections left for an external command's child to make; see
	/// [`DeferredRedirect`].
	pub(crate) fn deferred_redirects(&self) -> &[DeferredRedirect] {
		&self.deferred_redirects
	}

	/// These parameters for a command run while this one's redirections are
	/// set up (a command or process substitution in a redirection's word or a
	/// here-document): the redirections deferred for this command's child are
	/// this command's, not the nested one's, which must neither make them nor
	/// defer its own on their account, nor see the descriptors files are
	/// carried to this command's child at.
	pub(crate) fn for_nested_command(&self) -> Self {
		let mut params = self.clone();
		params.deferred_redirects.clear();
		params.defer_fifo_redirects = false;
		for fd in std::mem::take(&mut params.carried_fds) {
			params.open_files.remove_fd(fd);
		}
		#[cfg(unix)]
		{
			params.job_stub = None;
			params.starts_job_stub = false;
			params.stub_fds.clear();
		}
		params
	}

	/// Whether the child sets `fd` itself, so what this process holds there is
	/// not what the command reads or writes (its standard input is not this
	/// process's terminal, say).
	pub(crate) fn sets_deferred(&self, fd: ShellFd) -> bool {
		self.deferred_redirects.iter().any(|redirect| redirect.fd() == fd) || self.stub_sets(fd)
	}

	/// Whether a redirection is deferred already, so every later one is too.
	/// A background job's stub makes every one of the command's redirections.
	fn deferring(&self) -> bool {
		#[cfg(unix)]
		if self.job_stub.is_some() {
			return true;
		}
		!self.deferred_redirects.is_empty()
	}

	/// Whether the child these parameters start applies the shell's `ulimit`
	/// settings itself: one that makes deferred redirections, or a job's stub.
	pub(crate) fn child_applies_limits(&self) -> bool {
		#[cfg(unix)]
		if self.starts_job_stub {
			return true;
		}
		!self.deferred_redirects.is_empty()
	}

	/// Whether the job's stub has been given `fd` already, by a redirection
	/// it made or a descriptor it was handed: this process does not hold it.
	#[cfg(unix)]
	fn stub_sets(&self, fd: ShellFd) -> bool {
		self.stub_fds.contains(&fd)
	}

	/// Only Unix starts a job as a stub.
	#[cfg(not(unix))]
	const fn stub_sets(&self, _fd: ShellFd) -> bool {
		false
	}

	/// These parameters for the external command a background job's `stub`
	/// becomes: the stub makes each of its redirections in turn (see
	/// [`Self::flush_to_stub`]) and then executes it.
	#[cfg(unix)]
	pub(crate) fn for_job_stub(&self, stub: Arc<crate::jobstub::JobStub>) -> Self {
		let mut params = self.clone();
		params.job_stub = Some(stub);
		params.defer_fifo_redirects = true;
		params
	}

	/// These parameters for starting a background job's stub.
	#[cfg(unix)]
	pub(crate) fn starting_job_stub(&self) -> Self {
		let mut params = self.clone();
		params.starts_job_stub = true;
		params
	}

	/// The stub of the background job this command is, if any.
	#[cfg(unix)]
	pub(crate) fn job_stub(&self) -> Option<&Arc<crate::jobstub::JobStub>> {
		self.job_stub.as_ref()
	}

	/// Hands the redirections deferred so far to the job's stub, if any, in
	/// order, each once the one before it is made, as the child Bash forks
	/// makes them. A file this process carries at a spare descriptor is given
	/// to the stub at the descriptor it is for. Each descriptor the stub sets
	/// comes back, and is put here at the same number while `read` says a
	/// word that can read one is still to expand, so that those words see
	/// the descriptors the command will have, as they do in Bash's child; a
	/// descriptor it closes is closed here. The error of the first one the
	/// stub cannot make is returned, and the rest are dropped.
	#[cfg(unix)]
	pub(crate) async fn flush_to_stub(&mut self, read: bool) -> Result<(), error::Error> {
		use std::os::fd::AsRawFd as _;

		use crate::jobstub::StepFailure;
		let Some(stub) = self.job_stub.clone() else {
			return Ok(());
		};
		let mut redirects = std::mem::take(&mut self.deferred_redirects).into_iter().peekable();
		while let Some(redirect) = redirects.next() {
			// What the step's failure ends the command with, in the words the
			// child that makes deferred redirections reports it in. A stub that
			// is gone was killed: its status is the job's, and there is nothing
			// to report.
			let gone = || error::Error::from(error::ErrorKind::Interrupted);
			let opening = |path: &Path, errno: i32| {
				error::Error::from(error::ErrorKind::RedirectionFailure(
					path.to_string_lossy().into_owned(),
					std::io::Error::from_raw_os_error(errno),
				))
			};
			let bad = |fd: ShellFd| error::Error::from(error::ErrorKind::BadFileDescriptor(fd));
			let made = match &redirect {
				DeferredRedirect::Open { fd, mode, path, .. } => {
					stub.open(*fd, *mode, path).await.map_err(|failure| match failure {
						StepFailure::Call(errno) => opening(path, errno),
						StepFailure::Target(_) => bad(*fd),
						StepFailure::Gone => gone(),
					})
				},
				DeferredRedirect::Duplicate { fd, from } if self.carried_fds.contains(from) => {
					// The spare is this process's; the `Close` of it that follows is too.
					if matches!(redirects.peek(), Some(DeferredRedirect::Close { fd: spare }) if spare == from) {
						redirects.next();
					}
					self.carried_fds.retain(|spare| spare != from);
					let file = self.open_files.remove_fd(*from);
					match file.as_ref().map(OpenFile::try_borrow_as_fd) {
						Some(Ok(borrowed)) => stub.place(*fd, borrowed.as_raw_fd()).await.map_err(|failure| {
							if matches!(failure, StepFailure::Gone) { gone() } else { bad(*fd) }
						}),
						_ => Err(bad(*fd)),
					}
				},
				DeferredRedirect::Duplicate { fd, from } => stub.duplicate(*fd, *from).await.map_err(|failure| {
					if matches!(failure, StepFailure::Gone) { gone() } else { bad(*from) }
				}),
				DeferredRedirect::Close { fd } => stub.close(*fd).await.map(|()| None).map_err(|_| gone()),
				DeferredRedirect::Truncate { fd, path } => {
					stub.truncate(*fd).await.map(|()| None).map_err(|failure| match failure {
						StepFailure::Call(errno) | StepFailure::Target(errno) => opening(path, errno),
						StepFailure::Gone => gone(),
					})
				},
			};
			let descriptor = match made {
				Ok(descriptor) => descriptor,
				Err(error) => {
					for fd in std::mem::take(&mut self.carried_fds) {
						self.open_files.remove_fd(fd);
					}
					return Err(error);
				},
			};
			match (&redirect, descriptor) {
				(DeferredRedirect::Close { fd }, _) => drop(self.open_files.remove_fd(*fd)),
				(_, Some(descriptor)) if read => drop(
					self
						.open_files
						.set_fd(redirect.fd(), OpenFile::from(std::fs::File::from(descriptor))),
				),
				(_, Some(_) | None) => {},
			}
			self.stub_fds.push(redirect.fd());
		}
		Ok(())
	}

	/// Gives the job's stub, if any, the descriptor `fd` this process just set
	/// up for the command (a process substitution's pipe), at the same number.
	#[cfg(unix)]
	pub(crate) async fn place_in_stub(&mut self, fd: ShellFd) -> Result<(), error::Error> {
		use std::os::fd::AsRawFd as _;
		let Some(stub) = self.job_stub.clone() else {
			return Ok(());
		};
		let file = self.open_files.try_fd(fd).ok_or(error::ErrorKind::BadFileDescriptor(fd))?;
		let raw = file.try_borrow_as_fd()?.as_raw_fd();
		stub.place(fd, raw).await.map_err(|_| error::Error::from(error::ErrorKind::TooManyOpenFiles))?;
		self.stub_fds.push(fd);
		Ok(())
	}

	/// Leaves `redirect` for the child. The child starts with the descriptors
	/// this process holds, as the child Bash forks does, and makes the deferred
	/// redirections over them in order: a duplication (`>f 1>&3 3>/dev/null`)
	/// reads the descriptor as it is here, and an error the child reports
	/// while making them goes to the standard error in effect at that point.
	fn defer(&mut self, redirect: DeferredRedirect) {
		self.deferred_redirects.push(redirect);
	}

	/// Leaves for the child the placing of `file`, which this process opened,
	/// on `fd`: the child gets it at a spare descriptor, counting down from 63
	/// as a process substitution's pipe is given and then up from 64 to the
	/// open-file limit, moves it to `fd` in its turn and closes the spare. The
	/// spare is never `fd` itself, which closing it would undo. A file with no
	/// native descriptor (a virtual provider file) cannot reach the child: its
	/// error fails the command after the redirections deferred so far, which
	/// the child that reports it makes first.
	fn defer_carried(
		&mut self,
		shell: &Shell<impl extensions::ShellExtensions>,
		fd: ShellFd,
		file: OpenFile,
	) -> Result<(), error::Error> {
		#[cfg(unix)]
		file.try_borrow_as_fd()?;
		let spare = (3..=63)
			.rev()
			.chain(64..open_file_limit())
			.find(|spare| {
				*spare != fd
					&& self.try_fd(shell, *spare).is_none()
					&& !self.deferred_redirects.iter().any(|redirect| redirect.touches(*spare))
			})
			.ok_or(error::ErrorKind::TooManyOpenFiles)?;
		self.open_files.set_fd(spare, file);
		self.carried_fds.push(spare);
		self.defer(DeferredRedirect::Duplicate { fd, from: spare });
		self.defer(DeferredRedirect::Close { fd: spare });
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

/// The number of descriptors this process may have open (its soft
/// `RLIMIT_NOFILE`), up to 1,048,576.
#[cfg(unix)]
fn open_file_limit() -> ShellFd {
	rlimit::Resource::NOFILE
		.get()
		.map_or(1024, |(soft, _)| soft.min(1 << 20))
		.try_into()
		.unwrap_or(ShellFd::MAX)
}

/// Only Unix defers redirections; elsewhere nothing is carried.
#[cfg(not(unix))]
const fn open_file_limit() -> ShellFd {
	64
}

fn ensure_not_cancelled(params: &ExecutionParameters) -> Result<(), error::Error> {
	if params.is_cancelled() {
		return Err(error::ErrorKind::Interrupted.into());
	}
	Ok(())
}

/// Ends a subshell whose body failed with `error` as a child shell process
/// ends: it reports the error on its own standard error and exits with the
/// error's status, so its parent sees neither the error nor a request to exit,
/// return or break. A cancelled subshell keeps the error, so cancellation still
/// stops the parent and nothing reports the interruption.
pub(crate) async fn end_failed_subshell(
	subshell: &Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	error: error::Error,
) -> Result<ExecutionResult, error::Error> {
	if params.is_cancelled() {
		return Err(error);
	}
	let _ = subshell.display_error(&mut params.stderr(subshell), &error).await;
	Ok(ExecutionExitCode::from(&error).into())
}

/// The exit status an asynchronous subshell (a background job, a coprocess, a
/// process substitution) ends with once its body has ended. Only that status
/// reaches the shell that started it: the subshell reports its own error, and
/// a request to exit, return or break ends the subshell alone. A cancelled one
/// ends quietly with the interruption's status.
async fn async_subshell_status(
	subshell: &Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	body: Result<ExecutionResult, error::Error>,
) -> ExecutionResult {
	let status = match body {
		Ok(result) => result.exit_code,
		Err(error) => match end_failed_subshell(subshell, params, error).await {
			Ok(result) => result.exit_code,
			Err(error) => ExecutionExitCode::from(&error),
		},
	};
	status.into()
}

/// Reports `error`, which ends a command while redirections it installed are
/// in force, through those redirections, and marks it reported, so the command
/// that catches it outside them does not print it again. A cancelled run
/// reports nothing.
///
/// Every diagnostic is written exactly once, through the redirections Bash
/// 5.2.21 has installed when the diagnostic is produced:
/// - A compound command, `[[ … ]]` and a function's definition install their
///   redirections in the order written before the body runs; a function's,
///   after its nesting depth is checked and its arguments are set. An error
///   from the body goes through all of them, and one from installing a
///   redirection goes through those installed before it; see
///   [`redirect_setup_failure`] for what the command then ends with.
/// - A simple command expands its words, and a command without a name makes
///   its assignments, before it installs any of its redirections: their
///   errors go where the command's caller sends them. A redirection that
///   cannot be installed is reported through those before it, and the command
///   fails with status 1. An error from the command itself goes through all of
///   them. The simple command reports both itself, through [`ErrorReport`]:
///   the external command's child may be the one to set its standard error.
pub(crate) async fn report_in_redirect_scope(
	shell: &Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	error: error::Error,
) -> error::Error {
	if params.is_cancelled() || error.is_reported() {
		return error;
	}
	let _ = shell.display_error(&mut params.stderr(shell), &error).await;
	error.into_reported()
}

/// Installs `redirects` into `params` in the order written. A redirection that
/// cannot be installed is reported through those installed before it; see
/// [`report_in_redirect_scope`].
pub(crate) async fn setup_redirects(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &mut ExecutionParameters,
	redirects: &[ast::IoRedirect],
) -> Result<(), error::Error> {
	for redirect in redirects {
		if let Err(error) = setup_redirect(shell, params, redirect).await {
			return Err(report_in_redirect_scope(shell, params, error).await);
		}
	}
	Ok(())
}

/// What a compound command or `[[ … ]]` ends with when one of its own
/// redirections cannot be installed, once [`setup_redirects`] has reported
/// the error. As in Bash, a file that cannot be opened, a bad descriptor or
/// an ambiguous target fails only that command, with status 1, and the
/// command list goes on; any other error, such as a failed expansion, still
/// ends the command list.
fn redirect_setup_failure(error: error::Error) -> Result<ExecutionResult, error::Error> {
	match error.kind() {
		error::ErrorKind::RedirectionFailure(..)
		| error::ErrorKind::BadFileDescriptor(_)
		| error::ErrorKind::InvalidRedirection => Ok(ExecutionResult::general_error()),
		_ => Err(error),
	}
}

/// Installs a simple command's redirections into `params` in the order
/// written, once its words are expanded, and returns the error of the first
/// one that cannot be installed, unreported: the command reports it through
/// those installed before it, with an [`ErrorReport`]. A background job's
/// stub makes each one before the next one's word is expanded.
async fn setup_simple_command_redirects(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &mut ExecutionParameters,
	command: &ast::SimpleCommand,
) -> Result<(), error::Error> {
	let prefix = command.prefix.as_ref().map_or(&[][..], |prefix| prefix.0.as_slice());
	let suffix = command.suffix.as_ref().map_or(&[][..], |suffix| suffix.0.as_slice());
	let items: Vec<&CommandPrefixOrSuffixItem> = prefix.iter().chain(suffix).collect();
	for (index, item) in items.iter().enumerate() {
		if let CommandPrefixOrSuffixItem::IoRedirect(redirect) = item {
			setup_redirect(shell, params, redirect).await?;
			#[cfg(unix)]
			{
				// The descriptors the stub sets are kept here only while a
				// word that can read one is still to expand: a command may
				// have hundreds of redirections, and holding every one of
				// their descriptors would reach the open-file limit the
				// command itself is given.
				let read = items[index + 1..].iter().any(|item| expansion_may_read_descriptors(item));
				params.flush_to_stub(read).await?;
			}
		}
	}
	Ok(())
}

/// Whether expanding `item`'s words can read a descriptor the command will
/// have: only a command substitution or a process substitution runs code
/// that reads one, and both are spelled.
fn expansion_may_read_descriptors(item: &CommandPrefixOrSuffixItem) -> bool {
	let reads = |text: &str| {
		text.contains("$(") || text.contains('`') || text.contains("<(") || text.contains(">(")
	};
	match item {
		CommandPrefixOrSuffixItem::Word(word) => reads(&word.flatten()),
		CommandPrefixOrSuffixItem::AssignmentWord(_, word) => reads(&word.flatten()),
		CommandPrefixOrSuffixItem::IoRedirect(redirect) => match redirect {
			ast::IoRedirect::File(_, _, ast::IoFileRedirectTarget::Filename(word))
			| ast::IoRedirect::HereString(_, word) => reads(&word.flatten()),
			ast::IoRedirect::File(..) | ast::IoRedirect::HereDocument(..) => false,
			_ => true,
		},
		CommandPrefixOrSuffixItem::ProcessSubstitution(..) => true,
	}
}

/// Where a simple command reports an error that ends it before its command
/// runs: a redirection that cannot be installed, or a command that cannot be
/// found or started. As in the child Bash forks for the command, the error
/// goes through every redirection installed so far.
enum ErrorReport {
	/// The command's standard error, which this process holds.
	Stderr(OpenFile),
	/// The command's parameters, some of whose redirections the external
	/// command's child makes itself (see [`DeferredRedirect`]): the child
	/// Bash forks makes them before it reports, so a FIFO among them is
	/// opened whether or not the command runs, and it may be the standard
	/// error the report goes to.
	Deferred { params: ExecutionParameters, in_pipeline: bool, process_group_id: Option<i32> },
	/// The stub of the background job the command is, which has made its
	/// redirections so far and reports on the standard error they leave.
	#[cfg(unix)]
	Stub(Arc<crate::jobstub::JobStub>),
}

impl ErrorReport {
	/// Where the simple command run in `context` with `params` reports.
	fn new<SE: extensions::ShellExtensions>(
		context: &PipelineExecutionContext<'_, SE>,
		params: &ExecutionParameters,
	) -> Self {
		#[cfg(unix)]
		if let Some(stub) = params.job_stub()
			&& !stub.has_ended()
		{
			return Self::Stub(Arc::clone(stub));
		}
		if params.deferred_redirects().is_empty() {
			Self::Stderr(params.stderr(&context.shell))
		} else {
			// The child that reports is the job's own process, whose status
			// `wait` gets and which `kill` reaches: under `nohup` it does not
			// reparent, as no command runs that would outlive the shell.
			let mut params = params.clone();
			params.detach_reparent = false;
			Self::Deferred {
				params,
				in_pipeline: context.in_pipeline,
				process_group_id: context.process_group_id,
			}
		}
	}

	/// Reports `error` and returns what the command ends with: `ended`, or,
	/// when its child makes some of its redirections, a process that makes
	/// them in order, writes the diagnostic on the standard error they leave
	/// and exits with `ended`'s status, as the child Bash forks does (see
	/// [`crate::childredirects`]). That process stands for the
	/// command, so `wait`, `$!`, `jobs` and `kill` reach it as they would the
	/// command, and this shell goes on while it waits for a FIFO's other end.
	/// Should it fail to start, `error` ends the command unreported, so that
	/// the job reports it on its own standard error rather than nowhere.
	async fn report(
		self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		error: error::Error,
		ended: ExecutionResult,
	) -> Result<ExecutionSpawnResult, error::Error> {
		match self {
			Self::Stderr(mut stderr) => {
				let _ = shell.display_error(&mut stderr, &error).await;
				Ok(ended.into())
			},
			#[cfg(unix)]
			Self::Stub(stub) => {
				let status = u8::from(ended.exit_code);
				match shell.error_text(&error) {
					Some(diagnostic) => stub.report(status, diagnostic.as_bytes()).await,
					None => stub.exit(status).await,
				}
				Ok(ended.into())
			},
			Self::Deferred { params, in_pipeline, process_group_id } => {
				let Some(diagnostic) = shell.error_text(&error) else {
					return Ok(ended.into());
				};
				let context = commands::ExecutionContext { shell, command_name: "sh".to_owned(), params };
				commands::spawn_deferred_report(
					context,
					in_pipeline,
					process_group_id,
					&diagnostic,
					ended.exit_code,
				)
				.await
				.map_err(|start_error| {
					tracing::warn!(
						target: crate::trace_categories::COMMANDS,
						"could not start the process that reports a command's error: {start_error}"
					);
					error
				})
			},
		}
	}
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

		for command in &self.complete_commands {
			ensure_not_cancelled(params)?;
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

				// Starting a job succeeds: `$?` is 0 after `&`, as in Bash.
				result = ExecutionResult::success();
				shell.set_last_exit_status(result.exit_code.into());
			} else {
				result = ao_list.execute(shell, params).await?;

				// Update status
				shell.set_last_exit_status(result.exit_code.into());
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

	// The job runs in a subshell of its own, not interactive so it leaves the
	// terminal alone. Choosing how to start the job expands its command word
	// (and each wrapper's operand) in that subshell, so their side effects
	// stay out of this shell as in Bash, and only once: the job's copy of the
	// list has each such word replaced by the fields it expanded to. `jobs`
	// shows the list as written.
	let command_line = ao_list.to_string();
	let mut job_shell = background_job_shell(shell);
	let mut job_ao_list = ao_list.clone();

	// On Unix any job but a pipeline of external commands starts as a stub
	// forked at once, before any of its words is expanded, as Bash forks the
	// job's child first: `$!` names the stub, which becomes the command or
	// stands for it (see `crate::jobstub`).
	#[cfg(unix)]
	if !literal_external_pipeline(&job_ao_list, &job_shell) {
		let job = match start_driven_job(job_ao_list, command_line.clone(), job_shell, &async_params).await
		{
			Ok(job) => job,
			Err(error) => jobs::Job::finished(
				command_line,
				end_failed_subshell(shell, &async_params, error).await?,
			),
		};
		shell.set_last_background_pid(job.last_pid());
		return Ok(shell.jobs_mut().add_as_current(job));
	}

	let direct_pipeline =
		background_process_pipeline_for_async_job(&mut job_ao_list, &mut job_shell, &async_params)
			.await;
	let spawned = match direct_pipeline {
		Ok(Some((pipeline, detach_reparent))) => {
			// A transparent background wrapper (e.g. `nohup cmd &`) was unwrapped to its
			// operand. Reparent that operand out of the shell's descendant tree so it
			// survives the host's descendant-walk teardown — the persistence agents
			// reach for `nohup` expecting.
			async_params.detach_reparent = detach_reparent;
			// The parent spawns this command before going on, so it must not wait for
			// a FIFO's other end; see `DeferredRedirect`.
			let mut direct_params = async_params.clone();
			direct_params.defer_fifo_redirects = true;
			spawn_pipeline_as_job(&pipeline, command_line.clone(), &mut job_shell, &direct_params)
				.await
		},
		Ok(None) => Ok(spawn_async_ao_list_in_task(
			job_ao_list,
			command_line.clone(),
			job_shell,
			&async_params,
		)),
		Err(error) => Err(error),
	};
	let job = match spawned {
		Ok(job) => job,
		// The job's command failed to expand before any of the job started: the
		// failure is the job's, reported and ended as the job's own subshell
		// would.
		Err(error) => jobs::Job::finished(
			command_line,
			end_failed_subshell(shell, &async_params, error).await?,
		),
	};

	shell.set_last_background_pid(job.last_pid());
	Ok(shell.jobs_mut().add_as_current(job))
}

/// A subshell of `shell` for a background job to run in.
fn background_job_shell<SE: extensions::ShellExtensions>(shell: &Shell<SE>) -> Shell<SE> {
	let mut job_shell = shell.clone();
	job_shell.options_mut().interactive = false;
	job_shell
}

/// Whether `ao_list` is a pipeline of two or more external commands named
/// literally, which a background job spawns as its processes. Only literal
/// names are looked at: expanding a stage's command word here would run its
/// substitutions twice, or change the job's shell before each stage executes
/// in its own pipeline subshell.
fn literal_external_pipeline<SE: extensions::ShellExtensions>(
	ao_list: &ast::AndOrList,
	shell: &Shell<SE>,
) -> bool {
	ao_list.additional.is_empty()
		&& !ao_list.first.bang
		&& ao_list.first.seq.len() > 1
		&& ao_list.first.seq.iter().all(|command| {
			let ast::Command::Simple(simple_cmd) = command else {
				return false;
			};
			let Some(word) = simple_cmd.word_or_name.as_ref() else {
				return false;
			};
			let name = word.value.as_str();
			!name.is_empty()
				&& name.chars().all(|c| c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+'))
				&& !shell.aliases().contains_key(name)
				&& !shell.builtins().get(name).is_some_and(|registration| !registration.disabled)
				&& shell.funcs().get(name).is_none()
		})
}

/// Finds the pipeline to spawn directly as the processes of a background job,
/// and whether a transparent wrapper (`nohup`) was unwrapped to reach it, or
/// `None` when the job must run in a task: a builtin, function or alias, a
/// command word that expands to other than one field, or anything but a
/// lone simple command or a pipeline of external commands.
///
/// `shell` is the job's own subshell. Each command word looked at (the
/// command name, then each wrapper's operand) is expanded there, once, and
/// replaced in `ao_list` by the fields it expanded to, so whichever way the
/// job then runs, that word is not expanded again.
async fn background_process_pipeline_for_async_job<SE: extensions::ShellExtensions>(
	ao_list: &mut ast::AndOrList,
	shell: &mut Shell<SE>,
	params: &ExecutionParameters,
) -> Result<Option<(ast::Pipeline, bool)>, error::Error> {
	if !ao_list.additional.is_empty() || ao_list.first.bang {
		return Ok(None);
	}

	if ao_list.first.seq.len() > 1 {
		return Ok(literal_external_pipeline(ao_list, shell).then(|| (ao_list.first.clone(), false)));
	}

	let [ast::Command::Simple(simple_cmd)] = ao_list.first.seq.as_mut_slice() else {
		return Ok(None);
	};

	// Where the command word being looked at is: `None` for the command name,
	// else the index of a wrapper's operand in the suffix. Each turn takes a
	// word, and the command has only so many, so the turns end with them.
	let mut position = None;
	let mut wrappers = 0;
	let words = 1 + simple_cmd.suffix.as_ref().map_or(0, |suffix| suffix.0.len());
	for _ in 0..words {
		let command_name = match expand_command_word_in_place(simple_cmd, position, shell, params).await? {
			CommandWord::Name(name) => name,
			CommandWord::Missing => return Ok(None),
			// The word expanded to nothing: the next word is the command's, as in
			// Bash (`$empty /bin/cmd &`).
			CommandWord::Vanished => {
				match position {
					// A word kept for the status of its substitution, or none left.
					None if simple_cmd.word_or_name.is_some() => return Ok(None),
					None => {
						let suffix = simple_cmd.suffix.as_mut().map(|suffix| &mut suffix.0);
						let Some(suffix) = suffix else { return Ok(None) };
						let Some(index) =
							suffix.iter().position(|item| matches!(item, CommandPrefixOrSuffixItem::Word(_)))
						else {
							return Ok(None);
						};
						let CommandPrefixOrSuffixItem::Word(word) = suffix.remove(index) else {
							return Ok(None);
						};
						simple_cmd.word_or_name = Some(word);
					},
					Some(index) => {
						let next = simple_cmd.suffix.as_ref().and_then(|suffix| {
							suffix
								.0
								.iter()
								.enumerate()
								.skip(index)
								.find(|(_, item)| matches!(item, CommandPrefixOrSuffixItem::Word(_)))
								.map(|(next, _)| next)
						});
						let Some(next) = next else { return Ok(None) };
						position = Some(next);
					},
				}
				continue;
			},
		};

		if shell.aliases().contains_key(&command_name) {
			return Ok(None);
		}
		// `exec cmd &` runs as an external command does: the stub makes its
		// redirections, then becomes `cmd` (see
		// `commands::SimpleCommand::execute_exec_as_job_stub`), whatever the
		// shell registers as `exec` (the bash tool withholds it, as it would
		// replace the host), unless a function takes the name.
		#[cfg(unix)]
		if wrappers == 0 && command_name == "exec" && shell.funcs().get("exec").is_none() {
			return Ok(Some((ao_list.first.clone(), false)));
		}
		if let Some(registration) = shell.builtins().get(command_name.as_str())
			&& !registration.disabled
		{
			if !registration.transparent_background_wrapper {
				return Ok(None);
			}
			let Some(operand) = wrapper_operand_position(simple_cmd, position) else {
				return Ok(None);
			};
			position = Some(operand);
			wrappers += 1;
			continue;
		}
		if shell.funcs().get(command_name.as_str()).is_some() {
			return Ok(None);
		}

		// Unwrapping a transparent background wrapper (`nohup`) means the
		// operand should reparent away from the shell when finally spawned.
		let mut pipeline = ao_list.first.clone();
		for _ in 0..wrappers {
			let Some(unwrapped) = unwrap_transparent_background_wrapper(&pipeline) else {
				return Ok(None);
			};
			pipeline = unwrapped;
		}
		return Ok(Some((pipeline, wrappers > 0)));
	}

	Ok(None)
}

/// What expanding a background job's command word in place found.
enum CommandWord {
	/// The command's name: the first field the word expanded to.
	Name(String),
	/// No field: the word is gone, and the next word is the command's.
	Vanished,
	/// No word is there.
	Missing,
}

/// Expands the command word at `position` in `simple_cmd` (the command name
/// when `None`, else that suffix item) and puts the fields it expanded to in
/// its place as single-quoted words, which expand to exactly those fields.
/// The first field is the command's name, as in Bash, however many there are
/// (`cmd='/bin/sh -c'; $cmd …`).
async fn expand_command_word_in_place<SE: extensions::ShellExtensions>(
	simple_cmd: &mut ast::SimpleCommand,
	position: Option<usize>,
	shell: &mut Shell<SE>,
	params: &ExecutionParameters,
) -> Result<CommandWord, error::Error> {
	let word = match position {
		None => simple_cmd.word_or_name.as_ref(),
		Some(index) => match simple_cmd.suffix.as_ref().and_then(|suffix| suffix.0.get(index)) {
			Some(CommandPrefixOrSuffixItem::Word(word)) => Some(word),
			_ => None,
		},
	};
	let Some(word) = word else {
		return Ok(CommandWord::Missing);
	};
	let loc = word.loc.clone();
	let status_changes = shell.last_exit_status_change_count();
	let fields = expansion::full_expand_and_split_word(shell, params, word).await?;
	let name = fields.first().cloned();

	let mut literals = fields.iter().map(|field| ast::Word {
		value: escape::single_quote(field).into_owned(),
		loc:   loc.clone(),
	});
	match position {
		None => {
			simple_cmd.word_or_name = literals.next();
			let rest: Vec<_> = literals.map(CommandPrefixOrSuffixItem::Word).collect();
			if !rest.is_empty() {
				simple_cmd.suffix.get_or_insert_with(Default::default).0.splice(0..0, rest);
			}
			// A command left with no word at all ends with the status of the
			// last command substitution in its expansion (`$(exit 3) &` ends
			// with 3). Keep that status with a word that expands to nothing
			// and sets it, without running the substitution again; `builtin`,
			// so that a function named `exit` does not run.
			let has_words = simple_cmd.suffix.as_ref().is_some_and(|suffix| {
				suffix.0.iter().any(|item| matches!(item, CommandPrefixOrSuffixItem::Word(_)))
			});
			if simple_cmd.word_or_name.is_none()
				&& !has_words
				&& shell.last_exit_status_change_count() != status_changes
			{
				simple_cmd.word_or_name = Some(ast::Word {
					value: format!("$(builtin exit {})", shell.last_exit_status()),
					loc,
				});
			}
		},
		Some(index) => {
			if let Some(suffix) = simple_cmd.suffix.as_mut() {
				suffix.0.splice(index..=index, literals.map(CommandPrefixOrSuffixItem::Word));
			}
		},
	}

	Ok(name.map_or(CommandWord::Vanished, CommandWord::Name))
}

/// The suffix index of the operand of the transparent wrapper whose word is
/// at `wrapper` (the command name when `None`, else that suffix item): the
/// first word after it, past a `--` that only ends the wrapper's options.
/// This is the word `unwrap_transparent_background_wrapper` moves into
/// command position.
fn wrapper_operand_position(simple_cmd: &ast::SimpleCommand, wrapper: Option<usize>) -> Option<usize> {
	let suffix = &simple_cmd.suffix.as_ref()?.0;
	let mut words = suffix
		.iter()
		.enumerate()
		.skip(wrapper.map_or(0, |index| index + 1))
		.filter_map(|(index, item)| match item {
			CommandPrefixOrSuffixItem::Word(word) => Some((index, word)),
			_ => None,
		});
	let (index, word) = words.next()?;
	if word.value == "--" { words.next().map(|(index, _)| index) } else { Some(index) }
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

/// Spawns `pipeline`'s processes from `shell`, the job's own subshell, and
/// returns them as a job; a job that ended before any process started holds
/// its status for `wait`.
async fn spawn_pipeline_as_job<SE: extensions::ShellExtensions>(
	pipeline: &ast::Pipeline,
	command_line: String,
	shell: &mut Shell<SE>,
	params: &ExecutionParameters,
) -> Result<jobs::Job, error::Error> {
	let spawn_results = spawn_pipeline_processes(pipeline, shell, params).await?;
	let mut tasks = VecDeque::new();
	// The status of the last stage when it ended without starting a process.
	let mut ended_last_stage = None;

	for spawn_result in spawn_results {
		ended_last_stage = match spawn_result.poll().await? {
			ExecutionWaitResult::Stopped(child) => {
				tasks.push_back(jobs::JobTask::External(child));
				None
			},
			ExecutionWaitResult::Completed(result) => Some(ExecutionResult::from(result.exit_code)),
		};
	}

	if tasks.is_empty() {
		// No process started: the command could not be redirected or run, and
		// has said so on its standard error, which this process held. (A
		// command whose child was to make some of its redirections ends as the
		// process that makes them and reports; see `ErrorReport`.) Running it
		// again in a task would repeat its effects and its diagnostic.
		let status = ended_last_stage.unwrap_or_else(ExecutionResult::success);
		return Ok(jobs::Job::finished(command_line, status));
	}

	let job = jobs::Job::new(tasks, command_line, jobs::JobState::Running);
	// A job's status is its last stage's, also when only that stage failed to start.
	Ok(match ended_last_stage {
		Some(status) => job.with_final_status(status),
		None => job,
	})
}

/// Runs `ao_list` as a job in a task of its own, in `shell`, the job's own
/// subshell.
fn spawn_async_ao_list_in_task<SE: extensions::ShellExtensions>(
	ao_list: ast::AndOrList,
	command_line: String,
	mut shell: Shell<SE>,
	params: &ExecutionParameters,
) -> jobs::Job {
	let mut params = params.clone();

	// Let the job flag its own task for cancellation: the interpreter checks
	// these parameters between commands and loop iterations, so `kill %N` also
	// stops a body that never yields (a loop of synchronous builtins). It is a
	// child of the run's token, so cancelling the run (a tool abort) stops the
	// job too; a run that completes never cancels its token, so a job still
	// outlives the command line that started it.
	let cancellation = params
		.cancel_token()
		.map_or_else(CancellationToken::new, |token| token.child_token());
	params.set_cancel_token(cancellation.clone());

	let join_handle = tokio::spawn(async move {
		let body = ao_list.execute(&mut shell, &params).await;
		async_subshell_status(&shell, &params, body).await
	});

	jobs::Job::new(
		[jobs::JobTask::Internal(AbortOnDropHandle::new(join_handle))],
		command_line,
		jobs::JobState::Running,
	)
	.with_cancellation(cancellation)
}

/// Starts `ao_list` as a background job whose process is a stub forked now,
/// before any of its words is expanded (see [`crate::jobstub`]), driven by a
/// task with `shell`, the job's own subshell. `$!`, `wait`, `kill` and
/// `jobs` reach the stub; `$BASHPID` in the job is its pid.
#[cfg(unix)]
async fn start_driven_job<SE: extensions::ShellExtensions>(
	ao_list: ast::AndOrList,
	command_line: String,
	mut shell: Shell<SE>,
	params: &ExecutionParameters,
) -> Result<jobs::Job, error::Error> {
	let mut params = params.clone();
	// The job's own token, a child of the run's, as for a job run in a task
	// (see `spawn_async_ao_list_in_task`).
	let cancellation = params
		.cancel_token()
		.map_or_else(CancellationToken::new, |token| token.child_token());
	params.set_cancel_token(cancellation.clone());
	let (process, stub) = commands::spawn_job_stub(commands::ExecutionContext {
		shell:        &mut shell,
		command_name: "sh".to_owned(),
		params:       params.starting_job_stub(),
	})
	.await?;
	let stub = Arc::new(stub);
	let mut bashpid = ShellVariable::new(ShellValue::String(stub.pid().to_string()));
	bashpid.treat_as_integer();
	shell.env_mut().set_global("BASHPID", bashpid)?;
	let driver = tokio::spawn(drive_job(ao_list, shell, params, stub, cancellation.clone()));
	// The stub is the job's last task: its status is the job's.
	Ok(jobs::Job::new(
		[jobs::JobTask::Internal(AbortOnDropHandle::new(driver)), jobs::JobTask::External(process)],
		command_line,
		jobs::JobState::Running,
	)
	.with_cancellation(cancellation))
}

/// Runs a background job whose stub is `stub`, in `shell`, the job's own
/// subshell, which expands the job's command word here, once. An external
/// command runs as the stub: the stub makes its redirections in turn and then
/// becomes it. `nohup cmd &` starts upstream's launcher, which this task
/// waits for. Anything else runs here. The stub then exits with the job's
/// status, unless it has become the command or reported why it could not. A
/// signal that ends the stub first ends the job: what runs here is cancelled.
#[cfg(unix)]
async fn drive_job<SE: extensions::ShellExtensions>(
	mut ao_list: ast::AndOrList,
	mut shell: Shell<SE>,
	params: ExecutionParameters,
	stub: Arc<crate::jobstub::JobStub>,
	cancellation: CancellationToken,
) -> ExecutionResult {
	let run = async {
		let body = match background_process_pipeline_for_async_job(&mut ao_list, &mut shell, &params).await {
			Ok(Some((pipeline, false))) => {
				pipeline.execute(&mut shell, &params.for_job_stub(Arc::clone(&stub))).await
			},
			Ok(Some((pipeline, true))) => {
				let mut launch = params.clone();
				launch.detach_reparent = true;
				launch.defer_fifo_redirects = true;
				pipeline.execute(&mut shell, &launch).await
			},
			Ok(None) => ao_list.execute(&mut shell, &params).await,
			Err(error) => Err(error),
		};
		async_subshell_status(&shell, &params, body).await
	};
	tokio::pin!(run);
	let ended = tokio::select! {
		biased;
		ended = &mut run => ended,
		() = stub.closed() => {
			if !stub.is_closing() {
				cancellation.cancel();
				return ExecutionResult::general_error();
			}
			// The stub executed the command, or was told how to end.
			(&mut run).await
		},
	};
	if !stub.has_ended() {
		stub.exit(u8::from(ended.exit_code)).await;
	}
	ended
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

		// Spawn all the processes required for the pipeline, connecting outputs/inputs
		// with pipes as needed.
		let spawn_results = spawn_pipeline_processes(self, shell, &params).await?;

		// Wait for the processes. This also has a side effect of updating pipeline
		// status.
		let mut result =
			wait_for_pipeline_processes_and_update_status(self, spawn_results, shell, &params).await?;

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
			result.exit_code = ExecutionExitCode::from(if result.is_success() { 1 } else { 0 });
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
			|| (current_pipeline_index == pipeline_len - 1
				&& shell.options().run_last_pipeline_cmd_in_current_shell
				&& !shell.options().enable_job_control);

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

	// Clear our the pipeline status so we can start filling it out.
	shell.last_pipeline_statuses_mut().clear();

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

	while let Some(child) = process_spawn_results.pop_front() {
		ensure_not_cancelled(params)?;
		let wait_result = if !stopped_children.is_empty() {
			child.poll().await?
		} else {
			child.wait_with_cancel(params.cancel_token()).await?
		};

		match wait_result {
			ExecutionWaitResult::Completed(current_result) => {
				result = current_result;
				shell.set_last_exit_status(result.exit_code.into());
				shell
					.last_pipeline_statuses_mut()
					.push(result.exit_code.into());

				// Track the last failure for pipefail option
				if !result.is_success() {
					last_failure_exit_code = Some(result.exit_code);
				}
			},
			ExecutionWaitResult::Stopped(child) => {
				result = ExecutionResult::stopped();
				shell.set_last_exit_status(result.exit_code.into());
				shell
					.last_pipeline_statuses_mut()
					.push(result.exit_code.into());

				stopped_children.push(jobs::JobTask::External(child));
			},
		}
	}

	// Apply pipefail semantics if enabled
	if shell.options().return_last_failure_from_pipeline {
		if let Some(failure_exit_code) = last_failure_exit_code {
			result.exit_code = failure_exit_code;
		}
	}

	if shell.options().interactive {
		sys::terminal::move_self_to_foreground()?;
	}

	// If there were stopped jobs, then encapsulate the pipeline as a managed job
	// and hand it off to the job manager.
	if !stopped_children.is_empty() {
		let job = shell.jobs_mut().add_as_current(jobs::Job::new(
			stopped_children,
			pipeline.to_string(),
			jobs::JobState::Stopped,
		));

		let formatted = job.to_string();

		// N.B. We use the '\r' to overwrite any ^Z output.
		params
			.stderr(shell)
			.write_all_async(format!("\r{formatted}\n").as_bytes())
			.await?;
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
							// An error from installing the redirections or from the
							// body is reported while those installed apply.
							if let Some(redirects) = &redirects
								&& let Err(error) = setup_redirects(&mut shell, &mut params, &redirects.0).await
							{
								return redirect_setup_failure(error);
							}
							match compound.execute(&mut shell, &params).await {
								Err(error) if redirects.is_some() => {
									Err(report_in_redirect_scope(&shell, &params, error).await)
								},
								ended => ended,
							}
						})))
					},
					mut shell => {
						// Set up any additional redirects. An error from installing
						// them or from the body is reported while those installed apply.
						if let Some(redirects) = redirects
							&& let Err(error) = setup_redirects(&mut shell, &mut params, &redirects.0).await
						{
							return Ok(redirect_setup_failure(error)?.into());
						}

						let ended = match compound.execute(&mut shell, &params).await {
							Err(error) if redirects.is_some() => {
								Err(report_in_redirect_scope(&*shell, &params, error).await)
							},
							ended => ended,
						};
						Ok(ended?.into())
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
				// Set up any additional redirects. An error from installing them or
				// from evaluating the expression is reported while those installed
				// apply.
				if let Some(redirects) = redirects
					&& let Err(error) =
						setup_redirects(&mut pipeline_context.shell, &mut params, &redirects.0).await
				{
					return Ok(redirect_setup_failure(error)?.into());
				}

				// Evaluate the extended test expression.
				let matched = match extendedtests::eval_extended_test_expr(
					&e.expr,
					&mut pipeline_context.shell,
					&params,
				)
				.await
				{
					Err(error) if redirects.is_some() => {
						return Err(
							report_in_redirect_scope(&*pipeline_context.shell, &params, error).await,
						);
					},
					matched => matched?,
				};
				Ok(ExecutionResult::new(if matched { 0 } else { 1 }).into())
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
		// The coprocess reports its own error on the standard error it inherits,
		// not through the pipes it shares with this shell.
		let mut report_params = params.clone();
		report_params.set_cancel_token(cancellation.clone());
		let join_handle = tokio::spawn(async move {
			let ended = async {
				let pipeline_context = PipelineExecutionContext {
					shell:            commands::ShellForCommand::ParentShell(&mut child_shell),
					process_group_id: None,
					in_pipeline:       false,
				};
				let spawn_result = body
					.execute_in_pipeline(pipeline_context, child_params)
					.await?;
				match spawn_result.wait_with_cancel(cancel_token).await? {
					ExecutionWaitResult::Completed(result) => Ok(result),
					ExecutionWaitResult::Stopped(_) => Ok(ExecutionResult::stopped()),
				}
			}
			.await;
			async_subshell_status(&child_shell, &report_params, ended).await
		});

		let job = shell.jobs_mut().add_as_current(
			jobs::Job::new(
				[jobs::JobTask::Internal(AbortOnDropHandle::new(join_handle))],
				format!("coproc {name}"),
				jobs::JobState::Running,
			)
			.with_cancellation(cancellation),
		);
		let job_id = job.id;

		// Fill out the fd variable.
		let arr_value = ShellValue::from(vec![stdout_fd.to_string(), stdin_fd.to_string()]);
		shell
			.env_mut()
			.set_global(name.clone(), ShellVariable::new(arr_value))?;

		// Set the job ID for the coprocess in a separate variable with the _PID suffix.
		let pid_name = format!("{name}_PID");
		shell
			.env_mut()
			.set_global(pid_name, ShellVariable::new(job_id.to_string()))?;

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
			if let Some(condition) = &self.condition {
				// An empty condition (e.g., `for (( ; ; ))`) means "always true".
				if !condition.value.is_empty() && condition.eval(shell, params, true).await? == 0 {
					break;
				}
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

		let mut assignments = vec![];
		let mut args: Vec<CommandArg> = vec![];
		let mut command_takes_assignments = false;

		// Capture the status change count before expansion, so we can detect
		// if expansion (e.g., command substitution) set an exit status.
		let status_change_count_before_expansion = context.shell.last_exit_status_change_count();

		// As Bash does, expand every word, process substitutions included, before
		// installing any redirection, then install them in the order written (see
		// `report_in_redirect_scope`): an expansion error, or what a substitution
		// writes to standard error, goes where this command's caller sends it,
		// and a command whose expansion fails opens none of its files.
		for item in prefix_iter.chain(cmd_name_items.iter()).chain(suffix_iter) {
			ensure_not_cancelled(&params)?;
			match item {
				CommandPrefixOrSuffixItem::IoRedirect(_) => {},
				CommandPrefixOrSuffixItem::ProcessSubstitution(kind, subshell_command) => {
					params.disable_command_output_marking();
					let (installed_fd_num, substitution_file) =
						setup_process_substitution(&context.shell, &params, kind, subshell_command)?;

					params
						.open_files
						.set_fd(installed_fd_num, substitution_file);
					#[cfg(unix)]
					params.place_in_stub(installed_fd_num).await?;

					args.push(CommandArg::String(std::format!("/dev/fd/{installed_fd_num}")));
				},
				CommandPrefixOrSuffixItem::AssignmentWord(assignment, word) => {
					if args.is_empty() {
						// If we haven't yet seen any arguments, then this must be a proper
						// scoped assignment. Add it to the list we're accumulating.
						assignments.push(assignment);
					} else {
						if command_takes_assignments {
							// This looks like an assignment, and the command being invoked is a
							// well-known builtin that takes arguments that need to function like
							// assignments (but which are processed by the builtin).
							let expanded =
								expand_assignment(&mut context.shell, &params, assignment).await?;
							args.push(CommandArg::Assignment(expanded));
						} else {
							// This *looks* like an assignment, but it's really a string we should
							// fully treat as a regular looking
							// argument.
							let mut next_args =
								expansion::full_expand_and_split_word(&mut context.shell, &params, word)
									.await?
									.into_iter()
									.map(CommandArg::String)
									.collect();
							args.append(&mut next_args);
						}
					}
				},
				CommandPrefixOrSuffixItem::Word(arg) => {
					let mut next_args =
						expansion::full_expand_and_split_word(&mut context.shell, &params, arg).await?;

					if args.is_empty() {
						if let Some(cmd_name) = next_args.first() {
							if let Some(alias_value) = context.shell.aliases().get(cmd_name.as_str()) {
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

							let first_arg = next_args[0].as_str();

							// Check if we're going to be invoking a special declaration builtin.
							// That will change how we parse and process args.
							if context
								.shell
								.builtins()
								.get(first_arg)
								.is_some_and(|r| !r.disabled && r.declaration_builtin)
							{
								command_takes_assignments = true;
							}
						}
					}

					let mut next_args = next_args.into_iter().map(CommandArg::String).collect();
					args.append(&mut next_args);
				},
			}
		}

		// If we have a command, then execute it.
		if let Some(CommandArg::String(cmd_name)) = args.first().cloned() {
			ensure_not_cancelled(&params)?;
			if let Err(error) = setup_simple_command_redirects(&mut context.shell, &mut params, self).await {
				return redirect_failure(&mut context, &params, error).await;
			}

			let report = ErrorReport::new(&context, &params);
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

			match execute_command(context, params, cmd_name, assignments, args).await {
				Ok(result) => Ok(result),
				Err(err) => {
					let ended = err.to_result(parent_shell);
					if quiet_token.as_ref().is_some_and(CancellationToken::is_cancelled) {
						return Ok(ended.into());
					}
					report.report(parent_shell, err, ended).await
				},
			}
		} else {
			// No command to run; assignments must be applied to this shell.
			for assignment in assignments {
				// Apply the assignment. Don't mark as fatal - let errors be handled
				// at the program level so multiple complete_commands can execute independently.
				apply_assignment(
					assignment,
					&mut context.shell,
					&params,
					false,
					None,
					EnvironmentScope::Global,
				)
				.await?;
			}

			// Bash makes the assignments before it installs the redirections.
			ensure_not_cancelled(&params)?;
			if let Err(error) = setup_simple_command_redirects(&mut context.shell, &mut params, self).await {
				return redirect_failure(&mut context, &params, error).await;
			}

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
			Ok(ExecutionResult::new(context.shell.last_exit_status()).into())
		}
	}
}

/// Ends a simple command one of whose redirections cannot be installed with
/// status 1, as in Bash, once `error` is reported through those installed
/// before it (see [`ErrorReport`]). A cancelled run reports nothing.
async fn redirect_failure<SE: extensions::ShellExtensions>(
	context: &mut PipelineExecutionContext<'_, SE>,
	params: &ExecutionParameters,
	error: error::Error,
) -> Result<ExecutionSpawnResult, error::Error> {
	if params.is_cancelled() {
		return Ok(ExecutionResult::general_error().into());
	}
	ErrorReport::new(context, params)
		.report(&mut context.shell, error, ExecutionResult::general_error())
		.await
}

async fn execute_command(
	mut context: PipelineExecutionContext<'_, impl extensions::ShellExtensions>,
	params: ExecutionParameters,
	cmd_name: String,
	assignments: Vec<&ast::Assignment>,
	args: Vec<CommandArg>,
) -> Result<ExecutionSpawnResult, error::Error> {
	// Push a new ephemeral environment scope for the duration of the command. We'll
	// set command-scoped variable assignments after doing so, and revert them
	// before returning.
	let mut guard = crate::env::ScopeGuard::new(&mut context.shell, EnvironmentScope::Command);

	for assignment in &assignments {
		// Ensure it's tagged as exported and created in the command scope.
		apply_assignment(
			assignment,
			guard.shell(),
			&params,
			true,
			Some(EnvironmentScope::Command),
			EnvironmentScope::Command,
		)
		.await?;
	}

	if guard.shell().options().print_commands_and_arguments {
		guard
			.shell()
			.trace_command(&params, args.iter().map(|arg| arg.quote_for_tracing()).join(" "))
			.await;
	}

	guard.detach();
	drop(guard);

	// Construct the command struct.
	let mut cmd = commands::SimpleCommand::new(context.shell, params, cmd_name, args);
	cmd.process_group_id = context.process_group_id;
	cmd.in_pipeline = context.in_pipeline;

	// Arrange to pop off that ephemeral environment scope.
	cmd.post_execute = Some(|shell| shell.env_mut().pop_scope(EnvironmentScope::Command));

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

					let deferring = params.deferring();
					let noclobber =
						shell.options().disallow_overwriting_regular_files_via_output_redirection;
					if params.defer_fifo_redirects
						&& let Some(mode) = deferred_open_mode(kind, noclobber)
						&& let Some(redirect) = child_open(
							shell,
							fd_num,
							mode,
							&expanded_file_path,
							&options,
							deferring,
							// Opening a FIFO for reading and writing never waits.
							!matches!(kind, ast::IoFileRedirectKind::ReadAndWrite),
						) {
						params.defer(redirect);
						return Ok(());
					}

					// A file this process opens for the child is truncated by the
					// child in its turn: an earlier redirection the child fails to
					// make leaves it as it was, as in Bash.
					let truncate_in_child = deferring && options.is_truncate();
					if truncate_in_child {
						options.truncate(false);
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

					if deferring {
						params.defer_carried(shell, fd_num, opened_file)?;
						if truncate_in_child {
							params.defer(DeferredRedirect::Truncate { fd: fd_num, path: expanded_file_path });
						}
					} else {
						params.open_files.set_fd(fd_num, opened_file);
					}
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

					if params.deferring() {
						params.defer(DeferredRedirect::Duplicate { fd: fd_num, from: *fd });
						return Ok(());
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
					if params.deferring() {
						// The child makes it after the deferred redirections: a
						// duplication, a move (`N>&M-`, a duplication then a close
						// of `M`) or a close (`N>&-`). `>&file` defers through
						// `setup_redirect_output_and_error_to`.
						match source {
							Some(from) => {
								params.defer(DeferredRedirect::Duplicate { fd: fd_num, from });
								if dash {
									params.defer(DeferredRedirect::Close { fd: from });
								}
								return Ok(());
							},
							None if dash && expanded.is_empty() => {
								params.defer(DeferredRedirect::Close { fd: fd_num });
								return Ok(());
							},
							None => {},
						}
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
							#[cfg(unix)]
							params.place_in_stub(substitution_fd).await?;

							let fd_num =
								specified_fd_num.unwrap_or_else(|| get_default_fd_for_redirect_kind(kind));
							if params.deferring() {
								// The child gets the pipe at `substitution_fd` and
								// moves a copy to `fd_num` in its turn.
								params.defer(DeferredRedirect::Duplicate { fd: fd_num, from: substitution_fd });
							} else {
								params.open_files.set_fd(fd_num, target_file);
							}
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
			if params.deferring() {
				params.defer_carried(shell, fd_num, f)?;
			} else {
				params.open_files.set_fd(fd_num, f);
			}
		},

		ast::IoRedirect::HereString(fd_num, word) => {
			// If not specified, default to stdin (fd 0).
			let fd_num = fd_num.unwrap_or(0);

			let mut expanded_word = expansion::basic_expand_word(shell, params, word).await?;
			expanded_word.push('\n');

			let f = setup_open_file_with_contents("here-string", expanded_word.as_str())?;
			if params.deferring() {
				params.defer_carried(shell, fd_num, f)?;
			} else {
				params.open_files.set_fd(fd_num, f);
			}
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

	// `noclobber` refuses to replace an existing regular file, as for `>`.
	let noclobber =
		!append && shell.options().disallow_overwriting_regular_files_via_output_redirection;
	let mut file_options = pi_vfs::OpenOptions::new();
	file_options.write(true).append(append);
	if noclobber && shell.filesystem().is_file(&abs_file_path).await {
		file_options.create_new(true);
	} else {
		file_options.create(true).truncate(!append && !noclobber);
	}
	let mode = if append {
		ChildOpenMode::Append
	} else if noclobber {
		ChildOpenMode::WriteNoClobber
	} else {
		ChildOpenMode::Write
	};

	let deferring = params.deferring();
	if params.defer_fifo_redirects
		&& let Some(redirect) = child_open(
			shell,
			OpenFiles::STDOUT_FD,
			mode,
			&abs_file_path,
			&file_options,
			deferring,
			true,
		) {
		params.defer(redirect);
		params.defer(DeferredRedirect::Duplicate {
			fd:   OpenFiles::STDERR_FD,
			from: OpenFiles::STDOUT_FD,
		});
		return Ok(());
	}

	// A file this process opens for the child is truncated by the child in its
	// turn; see `setup_redirect`.
	let truncate_in_child = deferring && file_options.is_truncate();
	if truncate_in_child {
		file_options.truncate(false);
	}
	let stdout_file = shell
		.open_file(&file_options, &abs_file_path, params)
		.await
		.map_err(|err| {
			error::ErrorKind::RedirectionFailure(abs_file_path.to_string_lossy().to_string(), err)
		})?;

	if deferring {
		params.defer_carried(shell, OpenFiles::STDOUT_FD, stdout_file)?;
		if truncate_in_child {
			params.defer(DeferredRedirect::Truncate { fd: OpenFiles::STDOUT_FD, path: abs_file_path });
		}
		params.defer(DeferredRedirect::Duplicate {
			fd:   OpenFiles::STDERR_FD,
			from: OpenFiles::STDOUT_FD,
		});
		return Ok(());
	}

	let stderr_file = stdout_file.try_clone()?;

	params.open_files.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.open_files.set_fd(OpenFiles::STDERR_FD, stderr_file);

	Ok(())
}

/// How the child repeats an open of `kind`, with `noclobber` set or not;
/// `None` for kinds that are not plain opens.
const fn deferred_open_mode(kind: &ast::IoFileRedirectKind, noclobber: bool) -> Option<ChildOpenMode> {
	match kind {
		ast::IoFileRedirectKind::Read => Some(ChildOpenMode::Read),
		ast::IoFileRedirectKind::Write if noclobber => Some(ChildOpenMode::WriteNoClobber),
		ast::IoFileRedirectKind::Write | ast::IoFileRedirectKind::Clobber => Some(ChildOpenMode::Write),
		ast::IoFileRedirectKind::Append => Some(ChildOpenMode::Append),
		ast::IoFileRedirectKind::ReadAndWrite => Some(ChildOpenMode::ReadWrite),
		ast::IoFileRedirectKind::DuplicateInput | ast::IoFileRedirectKind::DuplicateOutput => None,
	}
}

/// What a background external command's child does in place of this process
/// opening `path` on `fd` as `mode` says (see [`DeferredRedirect`]), or
/// `None` when this process opens it.
///
/// With `deferring`, an earlier redirection is deferred, so the child makes
/// this one too, after it: a descriptor path as the duplication it names, any
/// other host path as the same open. Only this process can open a provider
/// path or the terminal; it then hands the child what it opened (see
/// [`ExecutionParameters::defer_carried`]). Without `deferring`, the open is
/// deferred only when it would wait for a FIFO's other end (`may_wait`: it is
/// not read-write).
fn child_open(
	shell: &Shell<impl extensions::ShellExtensions>,
	fd: ShellFd,
	mode: ChildOpenMode,
	path: &Path,
	options: &pi_vfs::OpenOptions,
	deferring: bool,
	may_wait: bool,
) -> Option<DeferredRedirect> {
	let open = || DeferredRedirect::Open { fd, mode, path: path.to_owned(), options: options.clone() };
	if !deferring {
		return (may_wait && is_native_fifo(shell, path)).then(open);
	}
	match openfiles::DescriptorPath::parse(path) {
		Some(openfiles::DescriptorPath::Fd(from)) => Some(DeferredRedirect::Duplicate { fd, from }),
		Some(openfiles::DescriptorPath::Terminal) => None,
		None if !shell.filesystem().is_native_local(path) => None,
		None => Some(open()),
	}
}

/// Whether `path` names a FIFO on the host that a child process opens as the
/// same FIFO. A descriptor path (`/dev/stdout`, `/dev/fd/N`, `/proc/self/fd/N`)
/// does not qualify even when it reaches a pipe: it names a descriptor of
/// whichever process opens it, which this shell resolves against its own.
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

/// Makes the deferred redirections in this process after all, in order, when
/// the command turns out to run in it (a builtin or a function); the open of a
/// FIFO then waits here, as it did before deferral, and what the command runs
/// makes its own redirections here too. A redirection that cannot be made
/// stops the rest and is reported here, on the standard error the ones before
/// it leave, as the child Bash forks reports it.
///
/// Returns, when there were any to make, the parameters they leave: the
/// command reports the error it ends with through them, with
/// [`report_in_scope`], and that error comes back reported, as a failure
/// here does, so the report its caller prepared ([`ErrorReport::Deferred`]),
/// which would make the redirections again, is not made. With none to make,
/// that report writes on the same standard error the command has.
pub(crate) async fn materialize_deferred_redirects(
	shell: &Shell<impl extensions::ShellExtensions>,
	params: &mut ExecutionParameters,
) -> Result<Option<ExecutionParameters>, error::Error> {
	params.defer_fifo_redirects = false;
	params.carried_fds.clear();
	if params.deferred_redirects.is_empty() {
		return Ok(None);
	}
	match make_deferred_redirects(shell, params).await {
		Ok(()) => Ok(Some(params.clone())),
		Err(error) => Err(report_made_here(shell, params, error).await),
	}
}

/// `result`, with its error reported through `scope`, the parameters
/// [`materialize_deferred_redirects`] returned for a command that runs in this
/// process: the report the command's caller prepared holds the standard error
/// from before those redirections were made.
pub(crate) async fn report_in_scope<T>(
	shell: &Shell<impl extensions::ShellExtensions>,
	scope: Option<&ExecutionParameters>,
	result: Result<T, error::Error>,
) -> Result<T, error::Error> {
	match (result, scope) {
		(Err(error), Some(params)) => Err(report_made_here(shell, params, error).await),
		(result, _) => result,
	}
}

/// Reports `error` through `params`, whose deferred redirections this process
/// made, unless it was reported already or the context's cancellation goes
/// unreported (as the simple command's own report would), and marks it
/// reported in every case: nothing may make those redirections again.
async fn report_made_here(
	shell: &Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	error: error::Error,
) -> error::Error {
	if params.reports_errors() {
		let _ = shell.display_error(&mut params.stderr(shell), &error).await;
	}
	error.into_reported()
}

async fn make_deferred_redirects(
	shell: &Shell<impl extensions::ShellExtensions>,
	params: &mut ExecutionParameters,
) -> Result<(), error::Error> {
	for redirect in std::mem::take(&mut params.deferred_redirects) {
		match redirect {
			DeferredRedirect::Open { fd, path, options, .. } => {
				let file = shell.open_file(&options, &path, params).await.map_err(|err| {
					error::ErrorKind::RedirectionFailure(path.to_string_lossy().into_owned(), err)
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
			DeferredRedirect::Truncate { fd, path } => {
				#[cfg(unix)]
				if let Some(file) = params.try_fd(shell, fd) {
					use std::os::fd::AsRawFd as _;
					let raw = file.try_borrow_as_fd()?.as_raw_fd();
					// SAFETY: `raw` is a descriptor `file` holds open for the call.
					if unsafe { libc::ftruncate(raw, 0) } != 0 {
						let error = std::io::Error::last_os_error();
						if error.raw_os_error() != Some(libc::EINVAL) {
							return Err(error::ErrorKind::RedirectionFailure(
								path.to_string_lossy().into_owned(),
								error,
							)
							.into());
						}
					}
				}
				#[cfg(not(unix))]
				let _ = (fd, path);
			},
		}
	}
	Ok(())
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
	shell: &Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	kind: &ast::ProcessSubstitutionKind,
	subshell_cmd: &ast::SubshellCommand,
) -> Result<(ShellFd, OpenFile), error::Error> {
	// TODO(execute): Don't execute synchronously!
	// Execute in a subshell.
	let mut subshell = shell.clone();

	// Set up execution parameters for the child execution.
	let mut child_params = params.for_nested_command();
	child_params.process_group_policy = ProcessGroupPolicy::SameProcessGroup;

	// Starting at 63 (a.k.a. 64-1)--and decrementing--look for an fd nothing
	// else holds before starting the substitution command: neither this
	// context nor the shell, nor a redirection the command's child is left to
	// make, which would replace the pipe there before the command reads it.
	// Under `ulimit -n N` the search starts below N, as Bash's pipe lands
	// there: a background job's process has the limit before it is given the
	// pipe.
	let mut candidate_fd_num: ShellFd = 63;
	#[cfg(unix)]
	if let Some(limit) = shell.resource_limits().open_files_override() {
		candidate_fd_num = candidate_fd_num.min(ShellFd::try_from(limit.saturating_sub(1)).unwrap_or(ShellFd::MAX));
	}
	loop {
		if candidate_fd_num <= 0 {
			return Err(error::ErrorKind::TooManyOpenFiles.into());
		}
		if !(params.open_files.contains_fd(candidate_fd_num)
			|| params.try_fd(shell, candidate_fd_num).is_some()
			|| params.deferred_redirects.iter().any(|redirect| redirect.touches(candidate_fd_num))
			|| params.stub_sets(candidate_fd_num))
		{
			break;
		}
		candidate_fd_num -= 1;
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
	// completion. Nobody waits for its status, so it reports its own error.
	let subshell_cmd = subshell_cmd.to_owned();
	tokio::spawn(async move {
		let body = subshell_cmd.list.execute(&mut subshell, &child_params).await;
		async_subshell_status(&subshell, &child_params, body).await;
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
