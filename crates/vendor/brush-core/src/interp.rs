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
	arithmetic::ExpandAndEvaluate,
	commands::{self, CommandArg},
	env::{EnvironmentLookup, EnvironmentScope, valid_variable_name},
	error, expansion, extendedtests, extensions, ioutils, jobs, openfiles,
	openfiles::{OpenFile, OpenFiles},
	pipetap::{self, PipeTap},
	results::{ExecutionExitCode, ExecutionResult, ExecutionSpawnResult, ExecutionWaitResult},
	shell::Shell,
	sys, timing,
	variables::{ArrayLiteral, ShellValue, ShellValueLiteral, ShellVariable},
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

/// Cooperates with Tokio's scheduler at an interpreter loop boundary.
///
/// `mapfile` uses a 64 KiB byte budget; this checkpoint spends Tokio's
/// cooperative task budget instead. They share only the yield-then-check
/// cancellation shape.
///
/// The cancellation check alone is not enough. Every sub-future of a loop of
/// synchronous builtins (`while :; do :; done`, a `for` over expanded words,
/// the writer of a process substitution) is already ready, so the future never
/// returns `Pending` and the worker polling it never returns to the scheduler.
/// Nothing outside can then take that worker back: the run's own timer, the
/// job's cancel token (set through an `async fn` that needs a worker of its
/// own) and `JoinHandle::abort` (which drops a future at its next yield point)
/// all wait for a yield that never comes. One task per worker is therefore
/// enough to take the whole runtime, with no way back short of ending the
/// process. Spending the cooperative budget restores all three.
///
/// So every loop here that a script or its data can make long spends one, or
/// runs a step that does. The length of a script bounds nothing: a generated
/// script is as long as its data (a `case` arm with a hundred thousand
/// alternatives, a keyed array literal of a million elements), and each of
/// those steps is ready at once.
///
/// A loop may leave its first step to the checkpoint that led to it only
/// where the loop typically runs more than once and no single step is
/// unbounded, that is, none does work that grows with the data without
/// spending a checkpoint of its own. A loop that usually runs once (the stages
/// of a pipeline, the items and assignments of a command, the alternatives of
/// a `case` arm) would otherwise usually have no checkpoint of its own, and
/// whether the one that led to it is close enough would be a property of every
/// path into it: one step can do all the work after that checkpoint is spent.
/// Those loops spend one on every step, and the cost of that on the hot path
/// is accepted.
pub(crate) async fn loop_checkpoint(params: &ExecutionParameters) -> Result<(), error::Error> {
	tokio::task::coop::consume_budget().await;
	yield_if_held_too_long().await;
	// After the cooperative yield, so a cancellation raised while this task was
	// parked is seen on the step that follows it.
	ensure_not_cancelled(params)
}

/// [`loop_checkpoint`] for a step that is itself a stride of work — a byte
/// stride copied, converted or scanned — rather than one element moved.
///
/// Such a step reads the clock every time. Amortising the reading over sixteen
/// of them assumes the sixteen are cheap, and a stride is not: converting
/// 64 KiB of `Σ` costs about 1.2 ms, so sixteen of them held the worker for
/// 19.6 ms at a stretch, sixty-four times over, with the time bound seeing
/// none of it.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] once the run is cancelled.
pub(crate) async fn stride_checkpoint(params: &ExecutionParameters) -> Result<(), error::Error> {
	tokio::task::coop::consume_budget().await;
	yield_after_stride().await;
	ensure_not_cancelled(params)
}

/// CPU time the calling thread has used so far.
///
/// Wall-clock time would count every stretch the machine took the thread away
/// too, which is not this thread holding anything.
#[cfg(unix)]
fn worker_cpu_time() -> std::time::Duration {
	let mut now = nix::libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `clock_gettime` writes only the `timespec` it is given, and
	// `CLOCK_THREAD_CPUTIME_ID` is always available.
	unsafe { nix::libc::clock_gettime(nix::libc::CLOCK_THREAD_CPUTIME_ID, &raw mut now) };
	std::time::Duration::new(
		u64::try_from(now.tv_sec).unwrap_or_default(),
		u32::try_from(now.tv_nsec).unwrap_or_default(),
	)
}

/// Time since the calling thread first read it. **This is wall time, not the
/// thread's CPU time.**
///
/// Windows has a thread CPU clock, `GetThreadTimes`, but it advances only at
/// the scheduler's tick, 15.6 ms by default: read against a 1 ms bound it
/// stands still for fifteen of them and then jumps, so the bound would become
/// the tick. Wall time also counts the stretches the machine took the thread
/// away, which can only make a checkpoint yield sooner than it had to. The
/// hold measurements in `tests.rs` read the Unix thread clock and do not run
/// here, so nothing measures this path.
#[cfg(windows)]
fn worker_cpu_time() -> std::time::Duration {
	thread_local! {
		static FIRST_READING: std::time::Instant = std::time::Instant::now();
	}
	FIRST_READING.with(std::time::Instant::elapsed)
}

/// No clock: `std::time::Instant` does not exist on every other target this
/// crate names (`wasm32-unknown-unknown` panics on it). The time bound is off
/// there, and only Tokio's own budget makes a checkpoint yield.
#[cfg(not(any(unix, windows)))]
const fn worker_cpu_time() -> std::time::Duration {
	std::time::Duration::ZERO
}

/// How long a worker may run between yields before a checkpoint makes it
/// yield, whatever Tokio's own budget says.
///
/// Tokio yields once per 128 checkpoints spent. That is a count, and a count
/// says nothing about what a step costs: the byte budget spends one checkpoint
/// per 64 KiB, so it guaranteed a yield only every 8 MiB — a few milliseconds
/// at memcpy rate, and 189 ms when a byte costs more than a memcpy, which is
/// what the expansion path costs. Bounding the interval in time is the
/// property every stride in this file was reaching for and none could express.
const LONGEST_HOLD_BETWEEN_YIELDS: std::time::Duration = std::time::Duration::from_millis(1);

/// How many checkpoints pass between readings of the thread's clock.
///
/// `CLOCK_THREAD_CPUTIME_ID` is **not** served by the vDSO on Linux: a
/// per-thread CPU clock has to be read in the kernel, so a reading is a real
/// syscall of 100–300 ns — several times what a checkpoint costs. Taking one
/// per [`element_checkpoint`] would be the kind of charge this file spent six
/// rounds removing, so an element-sized step amortises it over sixteen.
///
/// A stride-sized step does not amortise it at all; see [`stride_checkpoint`].
/// One 8 KiB stride of case conversion is 150 µs, against which 300 ns is two
/// parts in a thousand, and sixteen of them would be 2.4 ms of hold the clock
/// never saw. The amortisation is sound only where the sixteen steps are
/// cheap, which is what the two entry points separate.
const CHECKPOINTS_PER_CLOCK_READING: u32 = 16;

/// What this thread has done since it last yielded.
#[derive(Clone, Copy)]
struct Hold {
	checkpoints_since_reading: u32,
	last_yield:                std::time::Duration,
}

thread_local! {
	static HOLD: std::cell::Cell<Hold> =
		const {
			std::cell::Cell::new(Hold {
				checkpoints_since_reading: 0,
				last_yield:                std::time::Duration::ZERO,
			})
		};
}

/// When a checkpoint reads the thread's clock.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ClockReading {
	/// Once every [`CHECKPOINTS_PER_CLOCK_READING`] checkpoints: for a step
	/// that moves one element, where sixteen of them are cheap.
	EverySixteenth,
	/// Every time: for a step that is itself a stride of work, where one is
	/// already as much as the bound allows.
	EveryTime,
}

/// Yields if this thread has run for [`LONGEST_HOLD_BETWEEN_YIELDS`] since it
/// last did, reading the clock once every [`CHECKPOINTS_PER_CLOCK_READING`]
/// checkpoints.
///
/// For a caller holding a cancellation token rather than execution parameters,
/// and so unable to use [`loop_checkpoint`]: it checks nothing and returns
/// nothing.
pub(crate) async fn yield_if_held_too_long() {
	yield_if_held(ClockReading::EverySixteenth).await;
}

/// [`yield_if_held_too_long`] for a step that is itself a stride of work,
/// which reads the clock every time. See [`stride_checkpoint`].
pub(crate) async fn yield_after_stride() {
	yield_if_held(ClockReading::EveryTime).await;
}

async fn yield_if_held(reading: ClockReading) {
	let due = HOLD.with(|hold| {
		let mut state = hold.get();
		state.checkpoints_since_reading += 1;
		if reading == ClockReading::EverySixteenth
			&& state.checkpoints_since_reading < CHECKPOINTS_PER_CLOCK_READING
		{
			hold.set(state);
			return false;
		}
		state.checkpoints_since_reading = 0;
		let now = worker_cpu_time();
		let due = now.saturating_sub(state.last_yield) >= LONGEST_HOLD_BETWEEN_YIELDS;
		if due {
			state.last_yield = now;
		}
		hold.set(state);
		due
	});
	if due {
		tokio::task::yield_now().await;
	}
}

/// How many steps of one element each a loop may take between checkpoints.
///
/// A checkpoint costs about 50 ns, and a step that only moves one element of
/// an array costs about as much, so one checkpoint per element charged copying
/// a million-element array 23%. Spreading it over this many steps bounds the
/// stretch between yields at a fraction of a millisecond while charging the
/// copy almost nothing — the same trade [`expansion`]'s field splitting already
/// makes for a field that can be any length.
pub(crate) const ELEMENT_CHECKPOINT_STRIDE: usize = 256;

/// [`loop_checkpoint`] on every [`ELEMENT_CHECKPOINT_STRIDE`]-th step, for a
/// loop whose count is set by run-time data and whose single step is cheap and
/// bounded — one element of an array, one field of an expansion.
///
/// `step` is counted from zero, so the first step always spends one: a run
/// already cancelled stops before it touches anything.
pub(crate) async fn element_checkpoint(
	params: &ExecutionParameters,
	step: usize,
) -> Result<(), error::Error> {
	if step % ELEMENT_CHECKPOINT_STRIDE == 0 {
		return loop_checkpoint(params).await;
	}
	Ok(())
}

/// Moves `items` onto the end of `out`, spending a checkpoint before every
/// [`ELEMENT_CHECKPOINT_STRIDE`] of them: the checkpoints
/// [`element_checkpoint`] spends on a loop that pushes them one at a time.
///
/// The moves between two checkpoints run as one synchronous `extend`. A loop
/// that awaited [`element_checkpoint`] on every push kept its state in the
/// future, read back and written out again on every element.
pub(crate) async fn extend_in_strides<T>(
	params: &ExecutionParameters,
	out: &mut Vec<T>,
	mut items: impl ExactSizeIterator<Item = T>,
) -> Result<(), error::Error> {
	let mut remaining = items.len();
	out.reserve(remaining);
	while remaining > 0 {
		loop_checkpoint(params).await?;
		let stride = remaining.min(ELEMENT_CHECKPOINT_STRIDE);
		out.extend(items.by_ref().take(stride));
		remaining -= stride;
	}
	Ok(())
}

/// How many bytes a loop may copy or rewrite between checkpoints.
///
/// Counting steps alone is wrong wherever a step's work is the length of what
/// it moves: 128 array elements of 4 MiB each are 128 steps and half a
/// gigabyte, and a stride of 256 would let all of it pass without a yield.
/// `mapfile` already spends its checkpoint on a 64 KiB byte budget; this is the
/// same number for the same reason.
pub(crate) const BYTE_CHECKPOINT_STRIDE: usize = 64 * 1024;

/// Above how many bytes a single copy is divided into strides rather than made
/// in one step.
///
/// The test is per copy and the dividing path is an `async` call, so this is
/// also the line between the two: below it a copy takes the plain path,
/// because calling an `async` function on each of a million fields costs more
/// than the checkpoints it spends.
pub const DIVIDE_COPY_ABOVE_BYTES: usize = BYTE_CHECKPOINT_STRIDE;

/// Counts the checkpoints a loop over elements owes, by both the number of
/// steps and the bytes those steps copy.
///
/// [`element_checkpoint`] is the right thing only where a step is cheap *and*
/// bounded. Where a step copies a string, the string's length is the work, and
/// a step count says nothing about it.
///
/// Counting is synchronous, and a loop awaits [`loop_checkpoints`] only on a
/// step that owes one. Awaiting a future on every step, even a step that owes
/// nothing, cost copying a million-element array 9%: more than the
/// checkpoints it spent.
///
/// There was a per-loop step stride here for a while, on the theory that
/// inserting into a map costs more than moving a value and so should yield
/// more often. It did not: `array_insertion_yields_throughout` measures the
/// same longest hold at a stride of 32 as at 256 — 19.31 ms against 19.50 ms —
/// because that stretch is not the insertion loop but the free of the million
/// elements the assignment replaced, which no checkpoint can enter. The test
/// that disproved the knob asserts nanoseconds per element and stays.
pub struct ElementBudget {
	steps: usize,
	bytes: usize,
}

impl ElementBudget {
	pub const fn new() -> Self {
		Self { steps: 0, bytes: 0 }
	}

	/// Call once per step, before it runs, with the bytes that step copies or
	/// rewrites — zero where it only moves a value it already owns. Returns
	/// the checkpoints due before the step; spend them with
	/// [`loop_checkpoints`].
	///
	/// The first step always owes one, so a run already cancelled stops before
	/// it touches anything, and so does every [`ELEMENT_CHECKPOINT_STRIDE`]-th
	/// after it. A step that copies more than [`BYTE_CHECKPOINT_STRIDE`] owes
	/// one checkpoint for each stride it covers, not one for the step: Tokio
	/// yields once per 128 checkpoints spent, so a loop of 64 steps that each
	/// copy two megabytes would otherwise spend 64 and yield none.
	#[inline]
	pub const fn charge(&mut self, bytes: usize) -> Due {
		let entry = self.steps == 0;
		self.steps += 1;
		self.bytes = self.bytes.saturating_add(bytes);
		let mut timed = (!entry && self.steps % ELEMENT_CHECKPOINT_STRIDE == 0) as usize;
		if self.bytes >= BYTE_CHECKPOINT_STRIDE {
			timed += self.bytes / BYTE_CHECKPOINT_STRIDE;
			self.bytes %= BYTE_CHECKPOINT_STRIDE;
		}
		Due { entry, timed }
	}
}

/// The checkpoints one step of a loop owes, as [`ElementBudget::charge`]
/// counts them. It compares with a number as the count of them.
///
/// The causes are kept apart because they want different clocks. **The one a
/// loop owes on entering** is its cancellation check, and a loop of one step
/// owes it too: it reads the thread's clock one time in sixteen, like any
/// [`loop_checkpoint`]. Reading it every time made every element that copies
/// through a budget of its own pay a system call, `CLOCK_THREAD_CPUTIME_ID`
/// not being a vDSO clock on Linux: copying a million-element array three
/// times became 30% slower and rendering a short `BASH_COMMAND` went from 176
/// to 642 ns. **The ones owed later** stand for
/// [`ELEMENT_CHECKPOINT_STRIDE`] steps or a [`BYTE_CHECKPOINT_STRIDE`] of
/// bytes, so the budget has already amortised them, and each reads the clock.
/// Reading those one time in sixteen as well put 4,096 steps between readings,
/// and a step that allocates is cheap only on a quiet machine: under load,
/// `${seed[@]@U}` over a million fields held the worker 4.6–5.1 ms in three
/// trials of five; and `read`, which owes one per 64 KiB, held it 5.4 ms quiet
/// with sixteen strides of decoding between readings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[must_use]
pub struct Due {
	/// The loop's first step.
	entry: bool,
	/// The checkpoints owed for steps and bytes since the last one.
	timed: usize,
}

impl Due {
	const fn count(self) -> usize {
		self.entry as usize + self.timed
	}
}

impl PartialEq<usize> for Due {
	fn eq(&self, other: &usize) -> bool {
		self.count() == *other
	}
}

impl PartialOrd<usize> for Due {
	fn partial_cmp(&self, other: &usize) -> Option<std::cmp::Ordering> {
		Some(self.count().cmp(other))
	}
}

/// Spends the checkpoints [`ElementBudget::charge`] found due: every one of
/// them a [`stride_checkpoint`] if any was owed for steps or bytes, else the
/// one [`loop_checkpoint`] a loop owes on entering.
pub async fn loop_checkpoints(params: &ExecutionParameters, due: Due) -> Result<(), error::Error> {
	if due.timed == 0 {
		return if due.entry { loop_checkpoint(params).await } else { Ok(()) };
	}
	for _ in 0..due.count() {
		stride_checkpoint(params).await?;
	}
	Ok(())
}

/// Copies `text` into a new `String`, spending a checkpoint before each
/// [`BYTE_CHECKPOINT_STRIDE`] of it.
///
/// Charging a step for the bytes it is about to copy counts the work; it does
/// not divide it. One element of 512 MiB owed 8,193 checkpoints, spent all of
/// them, and then held the worker for 195 ms inside a single `clone`, because
/// nothing can interrupt a copy already under way. A budget spent before an
/// operation that cannot be interrupted buys nothing; the operation has to be
/// the thing that is divided.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part way,
/// leaving the copy unfinished and discarded.
pub async fn clone_in_strides(
	params: &ExecutionParameters,
	text: &str,
) -> Result<String, error::Error> {
	if text.len() <= BYTE_CHECKPOINT_STRIDE {
		loop_checkpoint(params).await?;
		return Ok(text.to_owned());
	}
	let mut copied = String::with_capacity(text.len());
	push_str_in_strides(params, &mut copied, text).await?;
	Ok(copied)
}

/// Appends `text` to `out`, spending a checkpoint before each
/// [`BYTE_CHECKPOINT_STRIDE`] of it. See [`clone_in_strides`].
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part way,
/// leaving `out` holding what had been appended by then.
pub async fn push_str_in_strides(
	params: &ExecutionParameters,
	out: &mut String,
	text: &str,
) -> Result<(), error::Error> {
	out.reserve(text.len());
	let mut rest = text;
	loop {
		stride_checkpoint(params).await?;
		if rest.len() <= BYTE_CHECKPOINT_STRIDE {
			out.push_str(rest);
			return Ok(());
		}
		// A stride lands mid-character at most three bytes in.
		let mut end = BYTE_CHECKPOINT_STRIDE;
		while !rest.is_char_boundary(end) {
			end -= 1;
		}
		let (piece, remaining) = rest.split_at(end);
		out.push_str(piece);
		rest = remaining;
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
			loop_checkpoint(params).await?;
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
			loop_checkpoint(params).await?;
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
			None => spawn_async_ao_list_in_task(ao_list, shell, &async_params).await?,
		}
	} else {
		spawn_async_ao_list_in_task(ao_list, shell, &async_params).await?
	};

	shell.set_last_background_pid(job.last_pid());
	Ok(shell.jobs_mut().add_as_current(job))
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
	let mut subshell = shell.clone_divided(params).await?;
	subshell.options_mut().interactive = false;

	let spawn_results = spawn_pipeline_processes(pipeline, &mut subshell, params).await?;
	let mut tasks = VecDeque::new();

	for spawn_result in spawn_results {
		if let ExecutionWaitResult::Stopped(child) = spawn_result.poll().await? {
			tasks.push_back(jobs::JobTask::External(child));
		}
	}

	if tasks.is_empty() {
		return Ok(None);
	}

	Ok(Some(jobs::Job::new(tasks, command_line, jobs::JobState::Running)))
}

async fn spawn_async_ao_list_in_task<SE: extensions::ShellExtensions>(
	ao_list: &ast::AndOrList,
	shell: &Shell<SE>,
	params: &ExecutionParameters,
) -> Result<jobs::Job, error::Error> {
	// Clone the inputs.
	let mut cloned_shell = shell.clone_divided(params).await?;
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

	let join_handle = tokio::spawn(async move {
		cloned_ao_list
			.execute(&mut cloned_shell, &cloned_params)
			.await
	});

	Ok(jobs::Job::new(
		[jobs::JobTask::Internal(AbortOnDropHandle::new(join_handle))],
		ao_list.to_string(),
		jobs::JobState::Running,
	)
	.with_cancellation(cancellation))
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
			loop_checkpoint(params).await?;
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
		loop_checkpoint(params).await?;
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
					target: Box::new(shell.clone_divided(&cmd_params).await?),
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
				// Clone off a new subshell, and run the body of the subshell there.
				// TODO(source-info): Do we need to reset the line number?
				let mut subshell = shell.clone_divided(params).await?;

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
		let (stdin_reader, stdin_writer) = std::io::pipe()?;
		let (stdout_reader, stdout_writer) = std::io::pipe()?;

		// Allocate new fds in the (parent) shell for the read end of the coprocess's
		// stdout and the write end of the coprocess's stdin.
		let stdout_fd = shell.open_files_mut().add(stdout_reader.into())?;
		let stdin_fd = shell.open_files_mut().add(stdin_writer.into())?;

		// Crete a subshell that the coprocess will own and run in.
		let mut child_shell = shell.clone_divided(params).await?;
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
		let join_handle = tokio::spawn(async move {
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
			// Otherwise, we use the current positional parameters. One of
			// them can be a whole array joined into a string, so the copy is
			// divided: `for arr; do …` with a 64 MiB positional held the
			// worker 25.4 ms in `extend_from_slice` alone, before the
			// divided assignment it leads to had begun.
			let count = shell.current_shell_args().len();
			expanded_values.reserve(count);
			for index in 0..count {
				let argument = clone_in_strides(params, &shell.current_shell_args()[index]).await?;
				expanded_values.push(argument);
			}
		}

		for value in expanded_values {
			loop_checkpoint(params).await?;
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

			// Update the variable. One value of a `for` is one element of an
			// array and can be any size, and this caller has the execution
			// parameters, so it takes the divided route: an uppercase
			// attribute on the loop variable held the worker 85.0 ms on a
			// 64 MiB element through the synchronous one. A loop variable
			// with the integer attribute takes the arithmetic value, as in
			// Bash: `declare -i n; for n in 1+1` gives `2`.
			let value =
				crate::variables::value_for_variable(shell, &self.variable_name, value).await?;
			shell
				.env_mut()
				.update_or_add(
					&self.variable_name,
					ShellValueLiteral::Scalar(value),
					|_| Ok(()),
					EnvironmentLookup::Anywhere,
					EnvironmentScope::Global,
					params,
				)
				.await?;

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
			if force_execute_next_case {
				// A fall-through (`;&`) runs this arm without testing it.
				loop_checkpoint(params).await?;
				force_execute_next_case = false;
			} else {
				let mut matches = false;
				for pattern in &case.patterns {
					// A script can have any number of arms, and one arm any number
					// of alternatives (`a|b|…)`). Each one tested spends a
					// checkpoint, so every arm spends at least one: the parser
					// gives each arm a pattern.
					loop_checkpoint(params).await?;
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
			loop_checkpoint(params).await?;
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
			loop_checkpoint(params).await?;
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

		for item in prefix_iter.chain(cmd_name_items.iter()).chain(suffix_iter) {
			loop_checkpoint(&params).await?;
			match item {
				CommandPrefixOrSuffixItem::IoRedirect(redirect) => {
					if let Err(e) = setup_redirect(&mut context.shell, &mut params, redirect).await {
						params
							.stderr(&context.shell)
							.write_all_async(format!("error: {e}\n").as_bytes())
							.await?;
						return Ok(ExecutionResult::general_error().into());
					}
				},
				CommandPrefixOrSuffixItem::ProcessSubstitution(kind, subshell_command) => {
					params.disable_command_output_marking();
					let (installed_fd_num, substitution_file) =
						setup_process_substitution(&context.shell, &params, kind, subshell_command).await?;

					params
						.open_files
						.set_fd(installed_fd_num, substitution_file);

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

			match execute_command(context, params, cmd_name, assignments, args).await {
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
			// No command to run; assignments must be applied to this shell.
			for assignment in assignments {
				loop_checkpoint(&params).await?;
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
		loop_checkpoint(&params).await?;
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
				loop_checkpoint(params).await?;
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
					// One element can expand to any number of words (`"${a[@]}"`).
					let words = split_expanded_value.into_iter().map(|word| (None, word.into()));
					extend_in_strides(params, &mut expanded_values, words).await?;
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
	// of an existing array. The subscript is kept as written: an index is
	// expanded once, as arithmetic, below, and a key as a word.
	let mut array_index;
	let variable_name = match &assignment.name {
		ast::AssignmentName::VariableName(name) => {
			array_index = None;
			name
		},
		ast::AssignmentName::ArrayElementName(name, index) => {
			array_index = Some(index.clone());
			name
		},
	};

	// Expand the values. Whether a literal names any subscript is learned
	// here, element by element, so that a literal with none pays nothing more
	// for subscripts below.
	let mut keyed = false;
	let mut new_value = match &assignment.value {
		ast::AssignmentValue::Scalar(unexpanded_value) => {
			let value =
				expansion::basic_expand_assignment_word(shell, params, unexpanded_value).await?;
			ShellValueLiteral::Scalar(value)
		},
		ast::AssignmentValue::Array(unexpanded_values) => {
			let mut elements = vec![];
			for (unexpanded_key, unexpanded_value) in unexpanded_values {
				// A key or value with no expansion character in it reaches no
				// checkpoint of its own while it expands.
				loop_checkpoint(params).await?;
				let key = match unexpanded_key {
					Some(unexpanded_key) => Some(
						expansion::basic_expand_assignment_word(shell, params, unexpanded_key).await?,
					),
					None => None,
				};

				if key.is_some() {
					keyed = true;
					let value =
						expansion::basic_expand_assignment_word(shell, params, unexpanded_value).await?;
					elements.push((key, value));
				} else {
					// Array elements are treated as regular words, not assignments
					let values =
						expansion::full_expand_and_split_word(shell, params, unexpanded_value).await?;
					// One element can expand to any number of words (`"${a[@]}"`).
					let words = values.into_iter().map(|value| (None, value));
					extend_in_strides(params, &mut elements, words).await?;
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

	// What the variable written makes of the assignment: where its subscripts
	// count from, if they are indexes, and whether its values are arithmetic.
	// An element goes into the array as it stands, so its subscript counts
	// back from there whether or not it appends; a literal replaces the array
	// unless it appends.
	let append = assignment.append || array_index.is_some();
	let (index_start, integer) =
		assignment_destination(shell, variable_name, required_scope, append);
	match (&array_index, index_start) {
		// An index is arithmetic text, expanded once by its evaluation, with
		// its single quotes kept as Bash keeps them: `x[' ']=v` is a syntax
		// error, where taking the quotes out first had made it index `0`.
		(Some(idx), Some(start)) => {
			let Some(index) =
				crate::variables::evaluate_index_subscript(shell, params, idx, start).await?
			else {
				// Bash ends a non-interactive shell here, as it does for the
				// arithmetic error a subscript can raise: `x[-5]=v` and `x[@]=v`.
				let word = std::format!("{variable_name}[{idx}]");
				return Err(error::Error::from(error::ErrorKind::BadArraySubscript(word)).into_fatal());
			};
			array_index = Some(index.to_string());
		},
		// A key of an associative array is a word.
		(Some(idx), None) => {
			array_index = Some(expansion::basic_expand_word(shell, params, idx).await?);
		},
		(None, _) => {},
	}
	new_value = match new_value {
		// The value after the subscript, the order Bash's side effects show:
		// `a[i++]=i++` assigns `1` at `0`.
		ShellValueLiteral::Scalar(value) if integer => {
			ShellValueLiteral::Scalar(crate::variables::integer_value(shell, value).await?)
		},
		ShellValueLiteral::Array(literal) if keyed || integer => ShellValueLiteral::Array(
			literal.evaluate_elements(shell, params, index_start, integer).await?,
		),
		other => other,
	};

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
						existing_value
							.assign_at_index_divided(array_index, s, assignment.append, params)
							.await?;
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

				existing_value.assign(new_value, assignment.append, params).await?;
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
			ShellValueLiteral::Scalar(s) => ShellValue::indexed_array_with_element(&array_index, s)?,
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
			ShellValueLiteral::Array(values) => {
				ShellValue::indexed_array_from_literals(values, params).await?
			},
		}
	};

	let mut new_var = ShellVariable::new(new_value);

	if export {
		new_var.export();
	}

	shell.env_mut().add(variable_name, new_var, creation_scope)
}

/// What the variable an assignment writes makes of it: where its subscripts
/// count from — `None` when it is an associative array, whose subscripts are
/// keys, and otherwise one past the largest index of the array the
/// assignment starts from ([`ShellVariable::indexed_literal_start`]) — and
/// whether it has the integer attribute, which makes its values arithmetic.
///
/// The variable written is the one found, unless the assignment needs a
/// scope it is not in; then [`apply_assignment`] makes a new one, which
/// starts empty and with no attributes.
fn assignment_destination(
	shell: &Shell<impl extensions::ShellExtensions>,
	name: &str,
	required_scope: Option<EnvironmentScope>,
	append: bool,
) -> (Option<u64>, bool) {
	match shell.env().get(name) {
		Some((scope, var)) if required_scope.is_none_or(|required| scope == required) => (
			var.takes_indexes().then(|| var.indexed_literal_start(append)),
			var.is_treated_as_integer(),
		),
		_ => (Some(0), false),
	}
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
								err.to_string(),
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
								setup_process_substitution(shell, params, substitution_kind, subshell_cmd).await?;

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

			let f = setup_open_file_with_contents(io_here_doc.as_str())?;
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

			let f = setup_open_file_with_contents(expanded_word.as_str())?;
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
			error::ErrorKind::RedirectionFailure(
				abs_file_path.to_string_lossy().to_string(),
				err.to_string(),
			)
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
					error::ErrorKind::RedirectionFailure(path.clone(), err.to_string())
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

async fn setup_process_substitution(
	shell: &Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	kind: &ast::ProcessSubstitutionKind,
	subshell_cmd: &ast::SubshellCommand,
) -> Result<(ShellFd, OpenFile), error::Error> {
	// TODO(execute): Don't execute synchronously!
	// Execute in a subshell.
	let mut subshell = shell.clone_divided(params).await?;

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
	let (reader, writer) = std::io::pipe()?;
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
fn setup_open_file_with_contents(contents: &str) -> Result<OpenFile, error::Error> {
	let (reader, mut writer) = std::io::pipe()?;
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
