//! Host plumbing for utility builtins (`cat`, `grep`, `sed`, `ls`, …).
//!
//! These builtins are ports of standalone command-line utilities: synchronous
//! programs that read `argv`, talk to fd 0/1/2, resolve relative paths against
//! the current directory, and exit with a status. [`Host`] hands them exactly
//! that view of the shell they run inside — as a value, threaded explicitly —
//! so no process-global or thread-local I/O state is involved: output lands on
//! the command's (possibly redirected or piped) file descriptors and relative
//! paths resolve against the *shell's* working directory rather than the host
//! process's.
//!
//! A utility implements [`Utility`]: a `clap` argument model plus a synchronous
//! [`Utility::run`] body. [`util`] wraps that into a [`Registration`] which
//!
//! 1. parses `argv`, rendering `--help`/`--version` on stdout and usage errors
//!    on stderr with the utility's own exit status,
//! 2. runs the body on a blocking thread, so a slow utility never stalls the
//!    async runtime and concurrent pipeline stages stay isolated,
//! 3. observes the shell's cancellation token (abort/`timeout`), and
//! 4. contains panics at the builtin boundary instead of taking down the
//!    long-lived host process.
//!
//! Paths go through [`ShellPaths`], which also maps descriptor paths
//! (`/dev/stdin`, `/dev/fd/63` from `diff <(a) <(b)`, `/dev/tty`) onto the
//! *shell's* descriptors: the builtin shares the host process, whose own fd 0
//! is the host's terminal.

// The whole module is API consumed by the feature-gated utility modules; a build
// with no utility features enabled legitimately uses none of it.
#![allow(dead_code, reason = "consumed by the feature-gated utility modules")]

use std::{
	cell::Cell,
	collections::HashMap,
	ffi::OsString,
	io::{self, BufWriter, LineWriter, Read, Write},
	marker::PhantomData,
	panic::{AssertUnwindSafe, catch_unwind},
	path::{Path, PathBuf},
	time::Duration,
	sync::{
		Arc, OnceLock,
		atomic::{AtomicBool, Ordering},
	},
};

use parking_lot::Mutex;
use pi_vfs::{BlockingFs, Metadata, absolute_path};

use brush_core::{
	CommandArg, Error, ExecutionContext, ExecutionExitCode, ExecutionParameters, ExecutionResult,
	ExecutionSpawnResult, Shell, ShellExtensions,
	builtins::{self, Registration},
	commands::{ShellForCommand, SimpleCommand},
	openfiles::{self, OpenFile, OpenFiles},
	processes::ProcessWaitResult,
};
use tokio_util::sync::CancellationToken;

/// A command-line utility implemented as a shell builtin.
///
/// Implementors supply the `clap` argument model (via `derive(Parser)`, or
/// [`matches_parser!`] for builder-style definitions) and a synchronous body.
/// Register with [`util`].
pub(crate) trait Utility: clap::Parser + Send + Sync + 'static {
	/// Program name, used in diagnostics (`sed: -e expression #1: …`).
	const NAME: &'static str;

	/// Exit status for a usage error. Most GNU utilities use 1; the
	/// `ls`/`grep`/`cmp` families reserve 1 for "differences found" and use 2.
	const USAGE_ERROR: u8 = 1;

	/// Whether the utility runs command lines through [`Host::run_command`]
	/// (`xargs`, `find -exec`, `ifne`). The adapter then forks a subshell of
	/// the invoking shell to serve them; every other utility skips that cost.
	const RUNS_COMMANDS: bool = false;

	/// Rewrites raw `argv` before clap parses it.
	///
	/// A few utilities accept syntax clap cannot model — GNU's obsolete
	/// `head -5` count form, for instance. `argv[0]` is the command name.
	/// Returning `Err(message)` reports `<name>: <message>` on stderr and exits
	/// with [`Utility::USAGE_ERROR`]. The default is the identity.
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(argv)
	}

	/// Runs the utility to completion, returning its exit status.
	///
	/// Called on a blocking thread, so blocking reads, `rayon`, and long
	/// filesystem walks are all fine. Long-running loops should poll
	/// [`Host::is_cancelled`] so shell abort/`timeout` is observed promptly.
	fn run(self, host: &mut Host) -> i32;
}

/// The shell as a utility builtin sees it: standard streams, working
/// directory, exported environment, cancellation, and accumulated exit status.
///
/// The three streams are public fields rather than accessors so a utility can
/// hold `&mut` borrows of two of them at once (reading stdin while writing
/// stdout is the common case).
pub(crate) struct Host {
	/// Standard input. Reads observe cancellation, so a blocked pipe read
	/// returns EOF on abort instead of hanging the shell.
	pub stdin:  Stdin,
	/// Standard output; the null device when fd 1 is closed. Raw: utilities
	/// with bulk output buffer it themselves via [`Host::stdout_writer`].
	pub stdout: OpenFile,
	/// Standard error, buffered with the destination-aware policy of
	/// [`StreamWriter`]; the null device when fd 2 is closed. When fd 2 shares
	/// fd 1's destination (`2>&1`, or the default capture pipe), this is the
	/// same serialized writer [`Host::stdout_writer`] returns, so interleaving
	/// follows write order exactly.
	pub stderr: StreamWriter,
	/// Unwrapped stdout retained for provider-aware self-read detection.
	stdout_handle:         Option<OpenFile>,
	/// Populated on the utility worker, where virtual handle queries may block.
	stdout_metadata:       OnceLock<Option<Metadata>>,

	name:                  String,
	paths:                 ShellPaths,
	env:                   HashMap<String, String>,
	cancel:                Arc<AtomicBool>,
	exit_code:             i32,
	stdin_is_search_input: bool,
	/// The shared stdout/stderr writer when both fds point at one
	/// destination; `None` when they diverge.
	merged_out:            Option<Arc<Mutex<StreamWriter>>>,
	/// Emulated SIGPIPE state shared with every guarded stream handed out by
	/// this host; see [`Sigpipe`].
	sigpipe:               Arc<Sigpipe>,
	/// Requests to the adapter's [`CommandRunner`]; `None` unless the utility
	/// set [`Utility::RUNS_COMMANDS`].
	commands:              Option<flume::Sender<CommandRequest>>,
}

fn output_handle(file: &OpenFile) -> Option<OpenFile> {
	match file {
		OpenFile::File(_) | OpenFile::Vfs(_) | OpenFile::Stdout(_) => file.try_clone().ok(),
		_ => None,
	}
}

fn output_metadata(file: &OpenFile) -> Option<Metadata> {
	match file {
		// `Metadata::from_file` keeps the handle identity a Windows path stat
		// drops; without it `path_is_stdout` can never match on Windows.
		OpenFile::File(file) => Metadata::from_file(file).ok(),
		OpenFile::Vfs(file) => file.metadata().ok(),
		OpenFile::Stdout(stdout) => {
			#[cfg(unix)]
			{
				use std::os::fd::AsFd;
				let handle = stdout.as_fd().try_clone_to_owned().ok()?;
				Metadata::from_file(&std::fs::File::from(handle)).ok()
			}
			#[cfg(windows)]
			{
				use std::os::windows::io::AsHandle;
				let handle = stdout.as_handle().try_clone_to_owned().ok()?;
				Metadata::from_file(&std::fs::File::from(handle)).ok()
			}
			#[cfg(not(any(unix, windows)))]
			{
				let _ = stdout;
				None
			}
		},
		_ => None,
	}
}

/// Exit status of a process killed by SIGPIPE (128 + 13).
pub(crate) const SIGPIPE_EXIT_CODE: i32 = 141;

/// Emulated SIGPIPE for an in-process utility.
///
/// A standalone utility whose reader goes away (`cut big.txt | head`) never
/// observes `EPIPE`: the kernel delivers SIGPIPE and the process dies silently
/// with status 141. A builtin runs inside the long-lived shell process, which
/// must ignore SIGPIPE, so the same write returns `ErrorKind::BrokenPipe` and
/// every ported error path would report it as a generic write failure.
///
/// [`SigpipeGuard`] wraps the host's stdout and stderr: the first broken-pipe
/// write flips [`Sigpipe::hit`], after which stderr writes are discarded (a
/// dead process prints nothing) while stdout writes keep failing so the
/// utility's loops still terminate. [`run_caught`] then reports
/// [`SIGPIPE_EXIT_CODE`] regardless of what the body returned.
///
/// [`Sigpipe::ignored`] is the builtin analogue of `signal(SIGPIPE, SIG_IGN)`
/// for utilities that must survive a closed reader (`tee -p`).
#[derive(Default)]
pub(crate) struct Sigpipe {
	hit:     AtomicBool,
	ignored: AtomicBool,
}

impl Sigpipe {
	fn record(&self, error: &io::Error) {
		if error.kind() == io::ErrorKind::BrokenPipe && !self.ignored.load(Ordering::Relaxed) {
			self.hit.store(true, Ordering::Relaxed);
		}
	}

	fn is_hit(&self) -> bool {
		self.hit.load(Ordering::Relaxed)
	}
}

/// Which standard stream a [`SigpipeGuard`] fronts; decides what a write does
/// once the emulated process is dead.
#[derive(Clone, Copy)]
enum GuardedStream {
	Stdout,
	Stderr,
}

/// An [`openfiles::Stream`] wrapper that turns `EPIPE` into emulated SIGPIPE.
/// Clones share the [`Sigpipe`] state, so `stdout_clone()` handles given to
/// helper threads participate too.
struct SigpipeGuard {
	inner:   OpenFile,
	stream:  GuardedStream,
	sigpipe: Arc<Sigpipe>,
}

impl SigpipeGuard {
	fn wrap(inner: OpenFile, stream: GuardedStream, sigpipe: &Arc<Sigpipe>) -> OpenFile {
		OpenFile::Stream(Box::new(Self { inner, stream, sigpipe: Arc::clone(sigpipe) }))
	}
}

impl Read for SigpipeGuard {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		self.inner.read(buf)
	}
}

impl Write for SigpipeGuard {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		if matches!(self.stream, GuardedStream::Stderr) && self.sigpipe.is_hit() {
			return Ok(buf.len());
		}
		self.inner.write(buf).inspect_err(|error| self.sigpipe.record(error))
	}

	fn flush(&mut self) -> io::Result<()> {
		if matches!(self.stream, GuardedStream::Stderr) && self.sigpipe.is_hit() {
			return Ok(());
		}
		self.inner.flush().inspect_err(|error| self.sigpipe.record(error))
	}
}

impl openfiles::Stream for SigpipeGuard {
	fn clone_box(&self) -> Box<dyn openfiles::Stream> {
		Box::new(Self {
			inner:   self.inner.clone(),
			stream:  self.stream,
			sigpipe: Arc::clone(&self.sigpipe),
		})
	}

	#[cfg(unix)]
	fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, Error> {
		Ok(self.inner.try_borrow_as_fd()?.try_clone_to_owned()?)
	}

	#[cfg(unix)]
	fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, Error> {
		self.inner.try_borrow_as_fd()
	}
}

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Relaxed);
	}
}

/// Where [`ShellPaths::resolve`] points a descriptor path the shell cannot
/// back: a closed descriptor, or `/dev/tty` with no terminal. No process has
/// descriptor -1, so every filesystem call on it fails with `ENOENT`, which is
/// what opening a closed descriptor's path reports. (A process without a
/// terminal gets `ENXIO` for `/dev/tty`; a path cannot carry that errno.)
#[cfg(unix)]
const UNAVAILABLE_DESCRIPTOR: &str = "/dev/fd/-1";

/// How a builtin running inside the host process sees paths.
///
/// Relative paths resolve against the shell's working directory, not the
/// process's. Paths naming descriptors (`/dev/stdin`, `/dev/fd/63` from
/// `<(…)`, `/dev/tty`) resolve against the shell's descriptors: opened for
/// real they would reach the host process's own, and its fd 0 is the host's
/// terminal, so `cat /dev/stdin` would block on the host's keystrokes.
///
/// Clones share the duplicated descriptors, which stay open while any clone
/// is alive, so a resolved `/dev/fd/N` path never outlives its descriptor.
/// The default resolves against the process working directory with no
/// descriptors, for tests that build utility state without a shell.
#[derive(Clone, Default)]
pub(crate) struct ShellPaths {
	cwd:         PathBuf,
	filesystem:  BlockingFs,
	#[cfg(unix)]
	descriptors: Arc<[(brush_core::ShellFd, OpenFile)]>,
}

impl std::fmt::Debug for ShellPaths {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let mut debug = f.debug_struct("ShellPaths");
		debug.field("cwd", &self.cwd);
		#[cfg(unix)]
		debug.field("fds", &self.descriptors.iter().map(|(fd, _)| *fd).collect::<Vec<_>>());
		debug.finish()
	}
}

impl ShellPaths {
	/// Captures the working directory and the descriptors visible to the
	/// command in `context`: usually just 0/1/2, plus any from `exec N>` or
	/// process substitution.
	pub fn new<SE: ShellExtensions>(context: &ExecutionContext<'_, SE>) -> Self {
		let filesystem = context.shell.filesystem().blocking();
		#[cfg(unix)]
		let descriptors: Arc<[(brush_core::ShellFd, OpenFile)]> = context
			.open_fds()
			.map(|(fd, file)| (fd, file.clone()))
			.collect();
		#[cfg(unix)]
		let filesystem = descriptors.iter().fold(filesystem, |filesystem, (fd, file)| {
			match file.as_vfs().and_then(|file| file.try_clone().ok()) {
				Some(file) => filesystem.mount_file(virtual_descriptor_path(*fd), file),
				None => filesystem,
			}
		});
		Self {
			cwd: context.shell.working_dir().to_path_buf(),
			filesystem,
			#[cfg(unix)]
			descriptors,
		}
	}

	/// A resolver with no descriptors, for tests that exercise path handling
	/// without a shell.
	#[cfg(test)]
	pub fn with_cwd(cwd: impl Into<PathBuf>) -> Self {
		Self { cwd: cwd.into(), ..Self::default() }
	}

	/// The shell working directory that relative paths resolve against.
	pub fn cwd(&self) -> &Path {
		&self.cwd
	}

	/// Filesystem captured from the shell, shared by utility worker threads.
	pub fn fs(&self) -> &BlockingFs {
		&self.filesystem
	}

	/// Resolves `path` to what the shell would open.
	///
	/// Relative paths join [`ShellPaths::cwd`]. Windows aliases (`/c/...`,
	/// `/tmp`) become native paths via `brush_core::sys::fs::normalize_shell_path`.
	/// A descriptor path becomes `/dev/fd/<host fd>` for the shell's
	/// descriptor, or a path that cannot be opened when the shell has none.
	pub fn resolve(&self, path: impl AsRef<Path>) -> PathBuf {
		let resolved = self.absolute(path.as_ref());
		#[cfg(unix)]
		if let Some(descriptor) = openfiles::DescriptorPath::parse(&resolved) {
			return self.descriptor_target(descriptor);
		}
		resolved
	}

	/// Like [`ShellPaths::resolve`], for calls that inspect `path` itself
	/// without following it (`lstat`, `readlink`).
	///
	/// `/dev/stdin`, `/dev/stdout`, and `/dev/stderr` are symlinks, and
	/// `/dev/tty` a device node, that read the same in every process; only
	/// following them reaches a process's own descriptors, so they stay as
	/// spelled. `/dev/fd/N` names the descriptor itself and still resolves.
	pub fn resolve_link(&self, path: impl AsRef<Path>) -> PathBuf {
		let resolved = self.absolute(path.as_ref());
		#[cfg(unix)]
		if let Some(descriptor) = openfiles::DescriptorPath::parse(&resolved)
			&& descriptor != openfiles::DescriptorPath::Terminal
			// `/dev/stdin` and friends sit directly under `/dev`.
			&& resolved.components().count() != 3
		{
			return self.descriptor_target(descriptor);
		}
		resolved
	}

	fn absolute(&self, path: &Path) -> PathBuf {
		if pi_vfs::is_virtual_path(path) {
			return path.to_path_buf();
		}
		let normalized_path = brush_core::sys::fs::normalize_shell_path(path);
		absolute_path(&self.cwd, normalized_path.as_ref())
	}

	#[cfg(unix)]
	fn descriptor_target(&self, descriptor: openfiles::DescriptorPath) -> PathBuf {
		use std::os::fd::AsRawFd as _;

		let fd = match descriptor {
			openfiles::DescriptorPath::Fd(fd) => fd,
			// Mirrors `brush_core::commands::child_session_action`: a command
			// whose stdin is not a terminal runs with no controlling terminal,
			// like the external commands the shell detaches into their own
			// session.
			openfiles::DescriptorPath::Terminal => {
				return if self.file(OpenFiles::STDIN_FD).is_some_and(OpenFile::is_terminal) {
					PathBuf::from("/dev/tty")
				} else {
					PathBuf::from(UNAVAILABLE_DESCRIPTOR)
				};
			},
		};
		if self.file(fd).and_then(OpenFile::as_vfs).is_some() {
			return virtual_descriptor_path(fd);
		}
		match self.file(fd).and_then(|file| file.try_borrow_as_fd().ok()) {
			Some(host_fd) => PathBuf::from(format!("/dev/fd/{}", host_fd.as_raw_fd())),
			None => PathBuf::from(UNAVAILABLE_DESCRIPTOR),
		}
	}

	#[cfg(unix)]
	fn file(&self, fd: brush_core::ShellFd) -> Option<&OpenFile> {
		self.descriptors
			.iter()
			.find(|(shell_fd, _)| *shell_fd == fd)
			.map(|(_, file)| file)
	}
}

/// Virtual descriptors cannot share native `/dev/fd` numbers in the overlay.
#[cfg(unix)]
fn virtual_descriptor_path(fd: brush_core::ShellFd) -> PathBuf {
	PathBuf::from(format!("omp-descriptor://{fd}"))
}

impl Host {
	/// The name the utility was invoked as. Differs from [`Utility::NAME`] when
	/// one implementation backs several builtins (`grep` and `rg`).
	pub fn name(&self) -> &str {
		&self.name
	}

	/// The shell working directory that relative paths resolve against.
	pub fn cwd(&self) -> &Path {
		self.paths.cwd()
	}

	/// Native working directory for utility subprocesses; rejects virtual filesystem views.
	pub fn native_cwd(&self) -> io::Result<&Path> {
		native_working_dir(self.fs(), self.cwd())
	}

	/// Resolves `path` to what the shell would open; see [`ShellPaths::resolve`].
	///
	/// Every path argument must go through this (or [`Host::paths`]) before
	/// touching the filesystem: the host process's working directory and
	/// descriptors are unrelated to the shell's.
	pub fn resolve(&self, path: impl AsRef<Path>) -> PathBuf {
		self.paths.resolve(path)
	}

	/// The resolver behind [`Host::resolve`], for utility state that outlives
	/// a `&Host` borrow.
	pub fn paths(&self) -> &ShellPaths {
		&self.paths
	}

	/// Filesystem for every utility path access, usable on its blocking worker.
	pub fn fs(&self) -> &BlockingFs {
		self.paths.fs()
	}

	/// Whether `path` identifies the regular file currently backing stdout.
	pub fn path_is_stdout(&self, path: &Path) -> bool {
		self.stdout_metadata
			.get_or_init(|| self.stdout_handle.as_ref().and_then(output_metadata))
			.as_ref()
			.is_some_and(|stdout| {
				if !stdout.is_file() {
					return false;
				}
				// Windows path stats do not carry a file index, so compare an
				// open handle there. On Unix, stat is sufficient and avoids
				// blocking while probing a FIFO or other non-regular path.
				#[cfg(windows)]
				let candidate = self.fs().open(path).and_then(|file| file.metadata());
				#[cfg(not(windows))]
				let candidate = self.fs().metadata(path);
				candidate.is_ok_and(|candidate| stdout.same_file(&candidate))
			})
	}

	/// Looks up an exported shell variable.
	///
	/// The shell's exported variables are *not* present in the host process
	/// environment, so `std::env::var` would miss them.
	pub fn var(&self, key: &str) -> Option<&str> {
		self.env.get(key).map(String::as_str)
	}

	/// The exported shell environment, for building a child process
	/// environment (`env_clear().envs(host.env())`).
	pub fn env(&self) -> impl Iterator<Item = (&str, &str)> {
		self.env.iter().map(|(k, v)| (k.as_str(), v.as_str()))
	}

	/// Whether the host has asked this invocation to stop (shell abort or
	/// `timeout`). Long internal loops — recursive directory walks in
	/// particular — poll this so cancellation is observed without waiting for
	/// stdin or for the whole work item to finish.
	pub fn is_cancelled(&self) -> bool {
		self.cancel.load(Ordering::Relaxed)
	}

	/// A cancellation flag that can be moved into worker threads and walker
	/// callbacks.
	pub fn cancel_flag(&self) -> Arc<AtomicBool> {
		Arc::clone(&self.cancel)
	}

	/// Whether stdin is a shell pipe, virtual file, or custom stream, and so should be treated
	/// as implicit input rather than a terminal. `rg PATTERN` uses this to
	/// decide between searching stdin and searching `.`.
	pub const fn stdin_is_search_input(&self) -> bool {
		self.stdin_is_search_input
	}

	/// Records a non-zero exit status while processing continues (the
	/// `cat a missing b` case: report, keep going, exit 1).
	pub const fn fail(&mut self, code: i32) {
		if code != 0 {
			self.exit_code = code;
		}
	}

	/// The status accumulated via [`Host::fail`]; 0 when nothing failed.
	pub const fn exit_code(&self) -> i32 {
		self.exit_code
	}

	/// Whether a write to stdout or stderr has hit a closed reader. The
	/// utility is, in process terms, already dead: stop work, skip
	/// diagnostics, and return; [`run_caught`] reports the SIGPIPE status.
	pub fn sigpipe_hit(&self) -> bool {
		self.sigpipe.is_hit()
	}

	/// Stops treating a closed reader as fatal, like `signal(SIGPIPE,
	/// SIG_IGN)`: broken-pipe writes stay ordinary `io::Error`s for the utility
	/// to handle (`tee -p`, `tee --output-error`).
	pub fn ignore_sigpipe(&self) {
		self.sigpipe.ignored.store(true, Ordering::Relaxed);
	}

	/// Writes `<name>: <message>` to stderr and records exit status `code`.
	pub fn error(&mut self, message: impl std::fmt::Display, code: i32) {
		let _ = writeln!(self.stderr, "{}: {message}", self.name);
		self.fail(code);
	}

	/// Duplicates stdout, for utilities that hand a writer to a helper thread.
	pub fn stdout_clone(&self) -> OpenFile {
		self.stdout.clone()
	}

	/// Duplicates stderr as a raw [`OpenFile`], for utilities that hand a
	/// writer to a helper thread. Data pending in the buffered stderr (at most
	/// one partial line) is not carried over.
	pub fn stderr_clone(&self) -> OpenFile {
		self.stderr.dup_file()
	}

	/// A buffered stdout with a flush policy chosen by the destination of
	/// fd 1; see [`StdoutWriter`].
	///
	/// Utilities that emit output progressively — stream filters (`grep`,
	/// `sed`, `cut`) and directory walkers (`ls`, `fd`) — must write through
	/// this rather than a raw `BufWriter`, so their output is visible as it is
	/// produced. Batch emitters whose output only exists once all input is
	/// consumed (`sort`, `tac`, `seq`) may keep plain block buffering.
	pub fn stdout_writer(&self) -> StreamWriter {
		match &self.merged_out {
			Some(shared) => StreamWriter::Shared(Arc::clone(shared)),
			None => StreamWriter::new(self.stdout.clone()),
		}
	}

	/// A launcher for child processes started by this utility.
	///
	/// Owned and `Clone`, so it can move into worker threads and into helper
	/// types that never see the `Host` itself — `sort --compress-program` spawns
	/// its compressor from inside the temp-file abstraction, for instance.
	pub fn child_env(&self) -> ChildEnv {
		ChildEnv {
			cwd:    self.paths.cwd().to_path_buf(),
			filesystem: self.fs().clone(),
			env:    Arc::new(
				self
					.env
					.iter()
					.map(|(k, v)| (k.clone(), v.clone()))
					.collect(),
			),
			stderr: self.stderr.dup_file(),
		}
	}

	/// Runs `command` in a subshell of the invoking shell and waits for it.
	///
	/// Dispatch is the shell's own (builtins before `PATH`, shell functions
	/// skipped, as for `command`), so an in-process utility sees the virtual
	/// `scheme://` paths no external program can open. The command writes
	/// straight to this utility's stdout and stderr descriptors; pending
	/// diagnostics are flushed first so output stays in order. Every command
	/// shares one subshell, so a `cd` inside it cannot leak into the caller;
	/// its working directory is reset before each run.
	///
	/// # Errors
	///
	/// - [`io::ErrorKind::NotFound`]: no builtin or program is named `argv[0]`.
	/// - [`io::ErrorKind::PermissionDenied`]: the command cannot be executed
	///   (not executable, or an external program in a virtual directory).
	/// - [`io::ErrorKind::Interrupted`]: the shell cancelled this utility.
	/// - [`io::ErrorKind::Unsupported`]: the utility did not set
	///   [`Utility::RUNS_COMMANDS`].
	/// - Any other shell failure (bad working directory, redirection error).
	pub fn run_command(&mut self, mut command: ShellCommand) -> io::Result<CommandStatus> {
		let Some(commands) = &self.commands else {
			return Err(io::Error::new(
				io::ErrorKind::Unsupported,
				format!("{} cannot run commands", self.name),
			));
		};
		command.cwd = command.cwd.map(|dir| self.paths.resolve(dir));
		let (reply, response) = flume::bounded(1);
		let request = CommandRequest { command, reply };
		let _ = self.stderr.flush();
		commands.send(request).map_err(|_| cancelled_command())?;
		response.recv().map_err(|_| cancelled_command())?
	}
}

/// A command line for [`Host::run_command`]: `argv[0]` names the builtin or
/// program. Stdin defaults to the null device, as GNU `xargs` and `find
/// -exec` give their children.
pub(crate) struct ShellCommand {
	argv:  Vec<OsString>,
	cwd:   Option<PathBuf>,
	stdin: Option<OpenFile>,
}

impl ShellCommand {
	pub fn new(argv: Vec<OsString>) -> Self {
		Self { argv, cwd: None, stdin: None }
	}

	/// Runs in `dir` (relative to the shell's working directory) instead of
	/// the shell's working directory; `find -execdir` uses this.
	pub fn current_dir(mut self, dir: impl Into<PathBuf>) -> Self {
		self.cwd = Some(dir.into());
		self
	}

	/// Feeds `stdin` to the command as fd 0.
	pub fn stdin(mut self, stdin: OpenFile) -> Self {
		self.stdin = Some(stdin);
		self
	}
}

/// How a command run through [`Host::run_command`] ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CommandStatus {
	/// A builtin returned, or a process exited, with this status.
	Exited(u8),
	/// A process was killed by this signal.
	Signaled(i32),
}

impl CommandStatus {
	pub const fn success(self) -> bool {
		matches!(self, Self::Exited(0))
	}

	/// The status a shell reports in `$?`: the exit status, or `128 + signal`.
	pub const fn code(self) -> i32 {
		match self {
			Self::Exited(code) => code as i32,
			Self::Signaled(signal) => 128 + signal,
		}
	}
}

impl From<std::process::ExitStatus> for CommandStatus {
	fn from(status: std::process::ExitStatus) -> Self {
		#[cfg(unix)]
		{
			use std::os::unix::process::ExitStatusExt;
			if let Some(signal) = status.signal() {
				return Self::Signaled(signal);
			}
		}
		Self::Exited(status.code().map_or(1, |code| (code & 0xff) as u8))
	}
}

/// A [`Host::run_command`] call in flight from the utility's blocking worker
/// to the adapter's [`CommandRunner`].
struct CommandRequest {
	command: ShellCommand,
	reply:   flume::Sender<io::Result<CommandStatus>>,
}

/// The error a utility sees once the adapter stops serving commands: the
/// shell cancelled it, so its request was dropped unanswered.
fn cancelled_command() -> io::Error {
	io::Error::new(io::ErrorKind::Interrupted, "command cancelled")
}

/// Serves [`Host::run_command`] on the async side, where a shell can run.
///
/// Holds a subshell forked from the invoking shell when the utility started,
/// so commands see its builtins, exported variables, and filesystem, while
/// side effects on shell state (`cd`, assignments) stay inside the subshell
/// the way they would inside a child process.
struct CommandRunner<SE: ShellExtensions> {
	shell:    Shell<SE>,
	params:   ExecutionParameters,
	cwd:      PathBuf,
	requests: flume::Receiver<CommandRequest>,
}

impl<SE: ShellExtensions> CommandRunner<SE> {
	fn new(context: &ExecutionContext<'_, SE>, requests: flume::Receiver<CommandRequest>) -> Self {
		let mut shell = context.shell.clone();
		shell.options_mut().interactive = false;
		let cwd = shell.working_dir().to_path_buf();
		Self { shell, params: context.params.clone(), cwd, requests }
	}

	/// Runs one request and answers it; a utility that stopped waiting (it
	/// was cancelled) simply never reads the answer.
	async fn serve(&mut self, request: CommandRequest) {
		let status = self.run(request.command).await.map_err(|error| {
			let kind = match ExecutionExitCode::from(&error) {
				ExecutionExitCode::NotFound => io::ErrorKind::NotFound,
				ExecutionExitCode::CannotExecute => io::ErrorKind::PermissionDenied,
				_ => io::ErrorKind::Other,
			};
			io::Error::new(kind, error.to_string())
		});
		let _ = request.reply.send(status);
	}

	async fn run(&mut self, command: ShellCommand) -> Result<CommandStatus, Error> {
		let dir = command.cwd.as_deref().unwrap_or(&self.cwd);
		if self.shell.working_dir() != dir {
			self.shell.set_working_dir(dir).await?;
		}
		let mut params = self.params.clone();
		params.set_fd(OpenFiles::STDIN_FD, or_null(command.stdin)?);
		let cancel = params.cancel_token();
		let args: Vec<CommandArg> = command
			.argv
			.into_iter()
			.map(|arg| CommandArg::from(arg.to_string_lossy().into_owned()))
			.collect();
		let name = args.first().map(ToString::to_string).unwrap_or_default();
		let mut simple =
			SimpleCommand::new(ShellForCommand::ParentShell(&mut self.shell), params, name, args);
		simple.use_functions = false;
		let spawned = match simple.execute().await {
			Ok(spawned) => spawned,
			// Nothing ran; the utility reports that in its own words.
			Err(error)
				if matches!(
					ExecutionExitCode::from(&error),
					ExecutionExitCode::NotFound | ExecutionExitCode::CannotExecute
				) =>
			{
				return Err(error);
			},
			// A builtin ran and failed: report it as the shell does after any
			// command, and hand back the status it would put in `$?`.
			Err(error) => {
				let mut stderr = self.params.stderr(&self.shell);
				let _ = self.shell.display_error(&mut stderr, &error).await;
				return Ok(CommandStatus::Exited(ExecutionExitCode::from(&error).into()));
			},
		};
		wait_status(spawned, cancel).await
	}
}

/// Waits for a spawned command, keeping the signal that killed a process
/// (the shell's own result folds it into `128 + signal`).
async fn wait_status(
	spawned: ExecutionSpawnResult,
	cancel: Option<CancellationToken>,
) -> Result<CommandStatus, Error> {
	let mut child = match spawned {
		ExecutionSpawnResult::StartedProcess(child) => child,
		spawned => {
			let result = ExecutionResult::from(spawned.wait_with_cancel(cancel).await?);
			return Ok(CommandStatus::Exited(result.exit_code.into()));
		},
	};
	Ok(match child.wait(cancel).await? {
		ProcessWaitResult::Completed(output) => output.status.into(),
		ProcessWaitResult::Stopped => CommandStatus::Exited(ExecutionResult::stopped().exit_code.into()),
		ProcessWaitResult::Cancelled => CommandStatus::Exited(ExecutionExitCode::Interrupted.into()),
	})
}

/// Buffered writer for a utility's output streams, with a flush policy
/// matching the destination.
///
/// When the destination is a regular file (or the null device), nothing
/// observes the output until the utility exits, so writes are block-buffered
/// for throughput. Everywhere else — a pipe to the next pipeline stage, the
/// harness capture pipe behind the TUI's live tool output (a pipe fd wrapped
/// in `OpenFile::File`, hence the `fstat` in [`is_regular_file`] rather than
/// a variant match), or an in-memory stream — writes are line-buffered so
/// each completed line is visible as soon as it is produced rather than when
/// the utility exits.
///
/// Construct via [`Host::stdout_writer`]; [`StreamWriter::line`] and
/// [`StreamWriter::block`] force a policy for utilities with explicit
/// buffering flags (`rg --line-buffered`).
pub(crate) enum StreamWriter {
	/// Block-buffered: flushed when full, on drop, and on explicit `flush`.
	Block(BufWriter<OpenFile>),
	/// Line-buffered: additionally flushed through the last newline of every
	/// write.
	Line(LineWriter<OpenFile>),
	/// A serialized handle onto a writer shared by stdout and stderr, used
	/// when fd 1 and fd 2 have the same destination (`2>&1`, or the default
	/// capture pipe): one buffer means diagnostics and output interleave in
	/// exactly the order they were written.
	Shared(Arc<Mutex<StreamWriter>>),
}

impl StreamWriter {
	const BLOCK_CAPACITY: usize = 64 * 1024;
	const LINE_CAPACITY: usize = 16 * 1024;

	/// Picks the policy for `file`: block for regular files, line otherwise.
	pub fn new(file: OpenFile) -> Self {
		if is_regular_file(&file) { Self::block(file) } else { Self::line(file) }
	}

	/// Forces line buffering regardless of destination.
	pub fn line(file: OpenFile) -> Self {
		Self::Line(LineWriter::with_capacity(Self::LINE_CAPACITY, file))
	}

	/// Forces block buffering regardless of destination.
	pub fn block(file: OpenFile) -> Self {
		Self::Block(BufWriter::with_capacity(Self::BLOCK_CAPACITY, file))
	}

	/// Duplicates the underlying descriptor as a raw [`OpenFile`], for
	/// utilities that hand a writer to helper threads. Buffered data pending
	/// in this writer (at most one partial line under the line policy) is not
	/// carried over.
	pub fn dup_file(&self) -> OpenFile {
		match self {
			Self::Block(w) => w.get_ref().clone(),
			Self::Line(w) => w.get_ref().clone(),
			Self::Shared(shared) => shared.lock().dup_file(),
		}
	}

	/// Whether the destination is a terminal, mirroring
	/// [`OpenFile::is_terminal`].
	pub fn is_terminal(&self) -> bool {
		match self {
			Self::Block(w) => w.get_ref().is_terminal(),
			Self::Line(w) => w.get_ref().is_terminal(),
			Self::Shared(shared) => shared.lock().is_terminal(),
		}
	}
}

impl Write for StreamWriter {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Self::Block(w) => w.write(buf),
			Self::Line(w) => w.write(buf),
			Self::Shared(shared) => shared.lock().write(buf),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::Block(w) => w.flush(),
			Self::Line(w) => w.flush(),
			Self::Shared(shared) => shared.lock().flush(),
		}
	}

	fn write_vectored(&mut self, bufs: &[io::IoSlice<'_>]) -> io::Result<usize> {
		match self {
			Self::Block(w) => w.write_vectored(bufs),
			Self::Line(w) => w.write_vectored(bufs),
			Self::Shared(shared) => shared.lock().write_vectored(bufs),
		}
	}
}

/// Whether writes to `file` land in a regular file, where output is only ever
/// observed after the utility exits.
///
/// A pipe wrapped in `std::fs::File` (how the shell hands the capture pipe to
/// a command) reports a fifo file type, and `metadata` on exotic handles can
/// fail outright; both classify as "not a regular file" and get line
/// buffering, the visibility-safe default. The check goes through the
/// descriptor rather than the variant so a [`SigpipeGuard`] around a file
/// still block-buffers.
pub(crate) fn is_regular_file(file: &OpenFile) -> bool {
	#[cfg(unix)]
	{
		let Ok(fd) = file.try_borrow_as_fd() else {
			return false;
		};
		let Ok(dup) = fd.try_clone_to_owned() else {
			return false;
		};
		std::fs::File::from(dup).metadata().is_ok_and(|m| m.is_file())
	}
	#[cfg(not(unix))]
	{
		match file {
			OpenFile::File(f) => f.metadata().is_ok_and(|m| m.is_file()),
			_ => false,
		}
	}
}

/// Whether two open files refer to the same non-seekable destination — the
/// `2>&1` case (and the harness default, where one capture pipe backs both
/// fds).
///
/// Matching is by `fstat` device+inode and deliberately excludes regular
/// files: `cmd >f 2>f` opens two descriptions with independent offsets, and
/// funneling them through one writer would change where the bytes land.
/// Pipes, fifos, terminals, and sockets have no offset, so a device+inode
/// match identifies the same object.
#[cfg(unix)]
fn same_destination(a: &OpenFile, b: &OpenFile) -> bool {
	use std::os::unix::fs::MetadataExt;
	fn id(file: &OpenFile) -> Option<(u64, u64)> {
		let fd = file.try_borrow_as_fd().ok()?;
		let dup = fd.try_clone_to_owned().ok()?;
		let meta = std::fs::File::from(dup).metadata().ok()?;
		if meta.file_type().is_file() {
			return None;
		}
		Some((meta.dev(), meta.ino()))
	}
	match (id(a), id(b)) {
		(Some(a), Some(b)) => a == b,
		_ => false,
	}
}

#[cfg(not(unix))]
fn same_destination(_a: &OpenFile, _b: &OpenFile) -> bool {
	false
}

/// A shell-faithful launcher for child processes started by a utility builtin.
///
/// Carries the three things a child must inherit from the *shell* rather than
/// from the host process: the working directory, the exported environment
/// (which is also what `PATH` lookup resolves against, so a program installed
/// only on the shell's `PATH` is found), and a duplicate of the command's
/// standard error.
///
/// That last one matters more than it looks: the host process's fd 2 belongs to
/// the TUI, so a child left with inherited stderr writes straight into the
/// rendered frame. [`ChildEnv::command`] therefore always pipes stderr, and
/// [`ChildEnv::forward_stderr`] drains it to the command's own fd 2.
#[derive(Clone)]
pub(crate) struct ChildEnv {
	cwd:    PathBuf,
	filesystem: BlockingFs,
	env:    Arc<Vec<(String, String)>>,
	stderr: OpenFile,
}

fn native_working_dir<'a>(filesystem: &BlockingFs, cwd: &'a Path) -> io::Result<&'a Path> {
	if filesystem.is_native_local(cwd) {
		Ok(cwd)
	} else {
		Err(pi_vfs::unsupported("external process in a virtual working directory"))
	}
}

impl ChildEnv {
	/// Builds a `Command` for `program` with the shell's working directory and
	/// environment, and with stderr piped.
	///
	/// Stdin and stdout are left untouched for the caller to wire; they default
	/// to inherited, so a caller that leaves them alone MUST redirect them.
	pub fn command(&self, program: impl AsRef<std::ffi::OsStr>) -> io::Result<std::process::Command> {
		let cwd = native_working_dir(&self.filesystem, &self.cwd)?;
		let mut command = std::process::Command::new(program);
		command
			.current_dir(cwd)
			.env_clear()
			.envs(self.env.iter().map(|(k, v)| (k, v)))
			.stderr(std::process::Stdio::piped());
		Ok(command)
	}

	/// Drains a child's piped stderr into the command's standard error on a
	/// helper thread.
	///
	/// The returned handle should be joined once the child has exited, so the
	/// diagnostic lands before the utility reports its own result. Dropping the
	/// handle detaches the thread, which is only correct if nothing downstream
	/// depends on the ordering.
	pub fn forward_stderr(
		&self,
		mut child_stderr: std::process::ChildStderr,
	) -> std::thread::JoinHandle<()> {
		let mut stderr = self.stderr.clone();
		std::thread::spawn(move || {
			let _ = io::copy(&mut child_stderr, &mut stderr);
		})
	}
}

/// Standard input for a utility builtin: the command's fd 0 plus the
/// cancellation flag.
///
/// On unix, when fd 0 is a real descriptor, reads wait for readiness in short
/// slices so an abort or `timeout` is observed even when input never arrives on
/// a blocked pipe; the utility then sees EOF and unwinds cleanly rather than
/// leaving a detached thread writing to descriptors the host has moved on from.
pub(crate) struct Stdin {
	file:   OpenFile,
	#[cfg_attr(not(unix), allow(dead_code, reason = "readiness polling is unix-only"))]
	fd:     Option<i32>,
	cancel: Arc<AtomicBool>,
}

impl Stdin {
	/// Mirror of `std::io::Stdin::lock`; the handle is already the lockable
	/// target, so this is the identity.
	pub const fn lock(&mut self) -> &mut Self {
		self
	}

	/// The underlying open file, for utilities that need to inspect fd 0
	/// (`is_terminal`) or hand it to a child process.
	pub const fn file(&self) -> &OpenFile {
		&self.file
	}

	/// Duplicates fd 0 for a helper thread (`ifne` pumping its input into the
	/// command); the duplicate observes the same cancellation.
	pub fn try_clone(&self) -> io::Result<Self> {
		let file = self.file.try_clone()?;
		let fd = pollable_fd(&file);
		Ok(Self { file, fd, cancel: Arc::clone(&self.cancel) })
	}
}

/// The raw descriptor [`Stdin`] polls for readiness, so a blocked read
/// observes cancellation; `None` off unix or for in-process streams.
fn pollable_fd(file: &OpenFile) -> Option<i32> {
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		file.try_borrow_as_fd().ok().map(|fd| fd.as_raw_fd())
	}
	#[cfg(not(unix))]
	{
		let _ = file;
		None
	}
}

impl Read for Stdin {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if self.cancel.load(Ordering::Relaxed) {
			return Ok(0);
		}
		#[cfg(unix)]
		if let Some(fd) = self.fd {
			loop {
				if self.cancel.load(Ordering::Relaxed) {
					return Ok(0);
				}
				let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
				// SAFETY: one `pollfd` valid for the call; `fd` is owned by the
				// live `OpenFile` held in this struct.
				let ready = unsafe { libc::poll(&mut pfd, 1, 200) };
				if ready < 0 {
					let err = io::Error::last_os_error();
					if err.kind() == io::ErrorKind::Interrupted {
						continue;
					}
					return Err(err);
				}
				if ready > 0 {
					break;
				}
			}
		}
		self.file.read(buf)
	}
}

thread_local! {
	/// Depth of active utility bodies on this thread. The native crash hook
	/// reads this from inside a panic (see [`panic_scope_active`]) to decide
	/// whether the panic is about to be caught; a `Cell` is used because the
	/// panicking code may hold other borrows, and a `RefCell` borrow there
	/// would panic again and abort the process.
	static PANIC_SCOPE_DEPTH: Cell<usize> = const { Cell::new(0) };
}

/// Whether a utility builtin body is running on the current thread.
///
/// A panic raised here is, by construction, about to be caught at the builtin
/// boundary, so the native crash hook treats it as recoverable and keeps it out
/// of the user-facing crash report.
#[must_use]
pub fn panic_scope_active() -> bool {
	PANIC_SCOPE_DEPTH.with(|depth| depth.get() > 0)
}

static RAYON_GLOBAL_POOL_AVAILABLE: AtomicBool = AtomicBool::new(!cfg!(target_os = "windows"));

/// Records whether utility builtins may use Rayon's process-global worker pool
/// without risking lazy initialization under Windows commit pressure.
pub fn set_rayon_global_pool_available(available: bool) {
	RAYON_GLOBAL_POOL_AVAILABLE.store(available, Ordering::SeqCst);
}

/// Whether utility builtins may enter Rayon's process-global worker pool.
#[must_use]
pub fn rayon_global_pool_available() -> bool {
	RAYON_GLOBAL_POOL_AVAILABLE.load(Ordering::SeqCst)
}

/// Indents all but the first line of a usage string by 7 spaces, aligning
/// continuation lines under clap's `Usage: ` prefix.
pub(crate) fn format_usage(usage: &str) -> String {
	debug_assert!(
		!usage.contains("{}"),
		"usage strings must name the command explicitly, not via a '{{}}' placeholder"
	);
	usage.replace('\n', "\n       ")
}

/// Borrows an `OsStr` as raw bytes.
///
/// Unix strings are arbitrary byte sequences, so this is free there. On Windows
/// only well-formed UTF-16 has a UTF-8 byte view, so an ill-formed value yields
/// `None`; callers report that as an invalid argument.
pub(crate) fn os_bytes(value: &std::ffi::OsStr) -> Option<&[u8]> {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt;
		Some(value.as_bytes())
	}
	#[cfg(not(unix))]
	{
		value.to_str().map(str::as_bytes)
	}
}

/// Borrows an `OsStr` as raw bytes, substituting replacement characters for
/// anything unrepresentable. For diagnostics, where losing a byte beats failing.
pub(crate) fn os_bytes_lossy(value: &std::ffi::OsStr) -> std::borrow::Cow<'_, [u8]> {
	match os_bytes(value) {
		Some(bytes) => std::borrow::Cow::Borrowed(bytes),
		None => std::borrow::Cow::Owned(value.to_string_lossy().into_owned().into_bytes()),
	}
}

/// Parses a GNU-style duration: a decimal number with an optional `s`/`m`/`h`/`d`
/// suffix, as accepted by `sleep` and `timeout`.
///
/// GNU also accepts `inf`/`infinity` (optionally signed `+`, any case);
/// infinite and overflowing values saturate to [`Duration::MAX`]. Callers
/// treat such durations as "sleep until cancelled". Sub-millisecond precision
/// is preserved: GNU `sleep 0.0001` really sleeps 100 microseconds.
pub(crate) fn parse_duration(input: &str) -> Option<Duration> {
	let trimmed = input.trim();
	if trimmed.is_empty() {
		return None;
	}
	let unsigned = trimmed.strip_prefix('+').unwrap_or(trimmed);
	if unsigned.eq_ignore_ascii_case("inf") || unsigned.eq_ignore_ascii_case("infinity") {
		return Some(Duration::MAX);
	}
	let (number, multiplier) = match trimmed.chars().last()? {
		's' => (&trimmed[..trimmed.len() - 1], 1.0),
		'm' => (&trimmed[..trimmed.len() - 1], 60.0),
		'h' => (&trimmed[..trimmed.len() - 1], 3600.0),
		'd' => (&trimmed[..trimmed.len() - 1], 86400.0),
		ch if ch.is_ascii_alphabetic() => return None,
		_ => (trimmed, 1.0),
	};
	let value = number.parse::<f64>().ok()?;
	if value.is_nan() || value.is_sign_negative() {
		return None;
	}
	if value.is_infinite() {
		return Some(Duration::MAX);
	}
	// Only overflow remains once NaN and negatives are excluded; saturate.
	Duration::try_from_secs_f64(value * multiplier).map_or(Some(Duration::MAX), Some)
}


/// Shell-quotes `arg` when rebuilding a command line for a child process.
///
/// `timeout` and `nohup` reconstruct the command they were handed so it can be
/// re-parsed by a shell; anything that could be re-split or re-expanded must be
/// quoted first.
pub(crate) fn quote_arg(arg: &str) -> String {
	if arg.is_empty() {
		return "''".to_string();
	}
	let safe = arg
		.chars()
		.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '+'));
	if safe {
		return arg.to_string();
	}
	let escaped = arg.replace('\'', "'\"'\"'");
	format!("'{escaped}'")
}

/// Reads a boolean "disable" flag for the uutils builtins from the session
/// environment (preferred) then the process environment, mirroring the nohup
/// builtin gate. Truthy = present and not "", "0", or "false".

/// Returns the [`Registration`] for a [`Utility`].
pub(crate) fn util<U: Utility, SE: ShellExtensions>() -> Registration<SE> {
	builtins::builtin::<Util<U>, SE>()
}

/// Adapter turning a [`Utility`] into a brush builtin.
///
/// Holds the raw argument vector rather than a parsed `U`: parse failures must
/// be reported on the utility's own terms (help on stdout, usage errors with
/// the utility's exit status) rather than through brush's generic usage-error
/// path.
pub(crate) struct Util<U: Utility> {
	argv:    Vec<String>,
	_marker: PhantomData<fn() -> U>,
}

impl<U: Utility> clap::FromArgMatches for Util<U> {
	fn from_arg_matches(_matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { argv: Vec::new(), _marker: PhantomData })
	}

	fn update_from_arg_matches(&mut self, _matches: &clap::ArgMatches) -> Result<(), clap::Error> {
		Ok(())
	}
}

impl<U: Utility> clap::CommandFactory for Util<U> {
	fn command() -> clap::Command {
		U::command()
	}

	fn command_for_update() -> clap::Command {
		U::command_for_update()
	}
}

impl<U: Utility> clap::Parser for Util<U> {}

impl<U: Utility> builtins::Command for Util<U> {
	type Error = Error;

	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Ok(Self { argv: args.into_iter().collect(), _marker: PhantomData })
	}

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		run_utility::<U, SE>(context, self.argv.clone()).await
	}
}

/// Drives a utility from raw arguments to an exit status.
async fn run_utility<U: Utility, SE: ShellExtensions>(
	context: ExecutionContext<'_, SE>,
	argv: Vec<String>,
) -> Result<ExecutionResult, Error> {
	// Capture everything owned *before* the first await so the returned future
	// stays `Send`: the borrowed `ExecutionContext` (and its `&mut Shell`) is
	// dropped before we await the blocking task.
	let argv: Vec<OsString> = argv.into_iter().map(OsString::from).collect();

	let argv = match U::rewrite_argv(argv) {
		Ok(argv) => argv,
		Err(message) => {
			let _ = writeln!(context.stderr(), "{}: {message}", U::NAME);
			return Ok(ExecutionResult::new(U::USAGE_ERROR));
		},
	};

	let parsed = match U::try_parse_from(&argv) {
		Ok(parsed) => parsed,
		Err(err) => {
			// clap reports `--help` and `--version` as errors; those belong on
			// stdout with a success status, everything else on stderr.
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(context.stderr(), "{rendered}");
				return Ok(ExecutionResult::new(U::USAGE_ERROR));
			}
			let _ = write!(context.stdout(), "{rendered}");
			return Ok(ExecutionResult::success());
		},
	};

	let mut host = build_host(&context, U::NAME)?;
	let cancel = context.cancel_token();
	let cancel_flag = host.cancel_flag();
	let _cancel_on_drop = CancelOnDrop(Arc::clone(&cancel_flag));
	let mut runner = U::RUNS_COMMANDS.then(|| {
		let (sender, requests) = flume::unbounded();
		host.commands = Some(sender);
		CommandRunner::new(&context, requests)
	});
	drop(context);

	let mut handle = tokio::task::spawn_blocking(move || {
		let code = run_caught::<U>(parsed, &mut host);
		if let Err(error) = host.fs().drain_closes() {
			host.error(error, 1);
			if code == 0 { 1 } else { code }
		} else {
			code
		}
	});

	// Respect shell abort/`timeout`. On cancel we set the host's cancel flag,
	// which makes a blocked stdin read return EOF, and drop the runner, which
	// fails any pending or later `run_command`; the utility unwinds cleanly
	// (flushing what it already produced) and the blocking task completes. We
	// await that completion before returning so no detached thread keeps
	// writing to the command's (possibly redirected) descriptors. A command
	// being served when the token fires is cancelled through its own params.
	let cancelled = async {
		match &cancel {
			Some(token) => token.cancelled().await,
			None => std::future::pending().await,
		}
	};
	tokio::pin!(cancelled);
	let code = loop {
		tokio::select! {
			biased;
			() = &mut cancelled => {
				cancel_flag.store(true, Ordering::Relaxed);
				drop(runner.take());
				let _ = (&mut handle).await;
				break 130;
			},
			result = &mut handle => {
				// If the token already fired, the task only finished because
				// our cancel flag unblocked it — report interrupted.
				let interrupted = cancel.as_ref().is_some_and(CancellationToken::is_cancelled);
				break if interrupted { 130 } else { result.unwrap_or(1) };
			},
			Some(request) = next_request(runner.as_ref()) => {
				if let Some(runner) = runner.as_mut() {
					runner.serve(request).await;
				}
			},
		}
	};

	Ok(ExecutionResult::new((code & 0xff) as u8))
}

/// The next [`Host::run_command`] request, or `None` once the utility has
/// dropped its host (or never had a runner).
async fn next_request<SE: ShellExtensions>(
	runner: Option<&CommandRunner<SE>>,
) -> Option<CommandRequest> {
	match runner {
		Some(runner) => runner.requests.recv_async().await.ok(),
		None => None,
	}
}

/// Runs a utility body, containing any panic at the builtin boundary and
/// applying emulated SIGPIPE.
///
/// A port that panics (an `unwrap` on a `BrokenPipe`, say) must not take down
/// the long-lived host process. With `panic = "unwind"` the panic unwinds to
/// here, where it becomes a non-zero exit plus a concise note on the command's
/// own stderr.
///
/// When a guarded stream hit a closed reader ([`Sigpipe`]), the body's own
/// verdict — exit status, diagnostics, even a panic — is what a process killed
/// mid-write would never have produced, so the result is [`SIGPIPE_EXIT_CODE`]
/// and nothing else.
pub(crate) fn run_caught<U: Utility>(parsed: U, host: &mut Host) -> i32 {
	struct Guard;
	impl Drop for Guard {
		fn drop(&mut self) {
			PANIC_SCOPE_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
		}
	}
	PANIC_SCOPE_DEPTH.with(|depth| depth.set(depth.get() + 1));
	let _guard = Guard;

	let outcome = catch_unwind(AssertUnwindSafe(|| parsed.run(host)));
	if host.sigpipe_hit() {
		return SIGPIPE_EXIT_CODE;
	}
	match outcome {
		Ok(code) => code,
		Err(_) => {
			let _ = writeln!(host.stderr, "{}: internal error", U::NAME);
			1
		},
	}
}

/// Snapshots the command's streams, working directory, and exported
/// environment into an owned [`Host`] that can move to a blocking thread.
fn build_host<SE: ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	name: &str,
) -> Result<Host, Error> {
	let stdin = context.try_fd(OpenFiles::STDIN_FD);
	// The `OpenFile` is kept alive by the `Stdin` below, so the fd stays valid.
	let stdin_fd = stdin.as_ref().and_then(pollable_fd);
	let stdin_is_search_input = stdin
		.as_ref()
		.is_some_and(|file| matches!(file, OpenFile::PipeReader(_) | OpenFile::Stream(_) | OpenFile::Vfs(_)));

	let mut env = HashMap::new();
	for (key, var) in context.shell.env().iter_exported() {
		if var.value().is_set() {
			env.insert(key.clone(), var.value().to_cow_str(context.shell).into_owned());
		}
	}

	let invoked = if context.command_name.is_empty() {
		name.to_string()
	} else {
		context.command_name.clone()
	};

	// One flag, shared: the adapter flips it on cancellation, and a blocked
	// `Stdin::read` must observe the very same flag or it never wakes.
	let cancel = Arc::new(AtomicBool::new(false));

	let stdout = or_null(context.try_fd(OpenFiles::STDOUT_FD))?;
	let stdout_handle = output_handle(&stdout);
	let stderr_file = or_null(context.try_fd(OpenFiles::STDERR_FD))?;
	let sigpipe = Arc::new(Sigpipe::default());
	// `2>&1` (and the default capture pipe): one shared writer keeps
	// diagnostics and output in exact write order. It carries stdout output,
	// so it takes the stdout guard: once the reader is gone every write fails
	// and nothing is observable either way.
	let (merged_out, stderr) = if same_destination(&stdout, &stderr_file) {
		let guarded = SigpipeGuard::wrap(stderr_file, GuardedStream::Stdout, &sigpipe);
		let shared = Arc::new(Mutex::new(StreamWriter::new(guarded)));
		(Some(Arc::clone(&shared)), StreamWriter::Shared(shared))
	} else {
		let guarded = SigpipeGuard::wrap(stderr_file, GuardedStream::Stderr, &sigpipe);
		(None, StreamWriter::new(guarded))
	};
	let stdout = SigpipeGuard::wrap(stdout, GuardedStream::Stdout, &sigpipe);

	Ok(Host {
		stdin: Stdin {
			file:   or_null(stdin)?,
			fd:     stdin_fd,
			cancel: Arc::clone(&cancel),
		},
		stdout,
		stderr,
		stdout_handle,
		stdout_metadata: OnceLock::new(),
		name: invoked,
		paths: ShellPaths::new(context),
		env,
		cancel,
		exit_code: 0,
		stdin_is_search_input,
		merged_out,
		sigpipe,
		commands: None,
	})
}

/// Substitutes the null device for a closed descriptor, so a utility reading
/// from or writing to it sees EOF / discards output instead of failing.
fn or_null(file: Option<OpenFile>) -> Result<OpenFile, Error> {
	match file {
		Some(file) => Ok(file),
		None => openfiles::null(),
	}
}

/// Implements `clap::Parser` for a builder-style utility: `$ty` stores the
/// `ArgMatches` produced by `$app` in a field named `matches`.
///
/// Ports whose upstream argument model is built with `clap::Command::new(…)`
/// use this instead of rewriting dozens of arguments into `derive(Parser)`
/// form. Brush still renders `--help`, usage, and man content from `$app`.
#[allow(unused_macros, reason = "used by utility modules, which are feature-gated")]
macro_rules! matches_parser {
	($ty:ident, $app:path) => {
		impl clap::FromArgMatches for $ty {
			fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
				Ok(Self { matches: matches.clone() })
			}

			fn update_from_arg_matches(
				&mut self,
				matches: &clap::ArgMatches,
			) -> Result<(), clap::Error> {
				self.matches = matches.clone();
				Ok(())
			}
		}

		impl clap::CommandFactory for $ty {
			fn command() -> clap::Command {
				$app()
			}

			fn command_for_update() -> clap::Command {
				$app()
			}
		}

		impl clap::Parser for $ty {}
	};
}

#[allow(unused_imports, reason = "used by utility modules, which are feature-gated")]
pub(crate) use matches_parser;

#[cfg(test)]
mod testing {
	//! In-memory [`Host`] construction for unit tests.

	use parking_lot::Mutex;

	use super::{
		Arc, AtomicBool, GuardedStream, HashMap, Host, OpenFile, OpenFiles, OsString, PathBuf, Read,
		ShellPaths, Sigpipe, SigpipeGuard, Stdin, StreamWriter, Utility, Write, io, openfiles,
		output_handle, run_caught,
	};

	/// Captured in-memory output from [`Host::for_test`].
	pub(crate) struct Capture {
		stdout: Arc<Mutex<Vec<u8>>>,
		stderr: Arc<Mutex<Vec<u8>>>,
	}

	impl Capture {
		/// Raw bytes the utility wrote to stdout.
		pub fn stdout(&self) -> Vec<u8> {
			self.stdout.lock().clone()
		}

		/// Shared stdout buffer for tests that must observe output mid-run.
		pub(crate) fn stdout_buffer(&self) -> Arc<Mutex<Vec<u8>>> {
			Arc::clone(&self.stdout)
		}

		/// Raw bytes the utility wrote to stderr.
		pub fn stderr(&self) -> Vec<u8> {
			self.stderr.lock().clone()
		}

		/// Stdout as a lossy string, for readable assertions.
		pub fn out(&self) -> String {
			String::from_utf8_lossy(&self.stdout()).into_owned()
		}

		/// Stderr as a lossy string, for readable assertions.
		pub fn err(&self) -> String {
			String::from_utf8_lossy(&self.stderr()).into_owned()
		}
	}

	impl Host {
		/// Builds a host backed by in-memory streams.
		///
		/// Returns the host plus a [`Capture`] over the same buffers, so a test
		/// can run a utility and then assert on what it wrote.
		pub(crate) fn for_test(
			name: &str,
			stdin: impl Into<Vec<u8>>,
			cwd: impl Into<PathBuf>,
		) -> (Self, Capture) {
			Self::for_test_with_stdin(
				name,
				Box::new(MemStream::reader(stdin.into())),
				cwd,
			)
		}

		/// Builds a host backed by an arbitrary in-memory stdin stream.
		pub(crate) fn for_test_with_stdin(
			name: &str,
			stdin: Box<dyn openfiles::Stream>,
			cwd: impl Into<PathBuf>,
		) -> (Self, Capture) {
			let capture = Capture {
				stdout: Arc::new(Mutex::new(Vec::new())),
				stderr: Arc::new(Mutex::new(Vec::new())),
			};
			let cancel = Arc::new(AtomicBool::new(false));
			let sigpipe = Arc::new(Sigpipe::default());
			let stdout = OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&capture.stdout))));
			let stderr = OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&capture.stderr))));
			let host = Self {
				stdin:                 Stdin {
					file:   OpenFile::Stream(stdin),
					fd:     None,
					cancel: Arc::clone(&cancel),
				},
				stdout:                SigpipeGuard::wrap(stdout, GuardedStream::Stdout, &sigpipe),
				stderr:                StreamWriter::new(SigpipeGuard::wrap(
					stderr,
					GuardedStream::Stderr,
					&sigpipe,
				)),
				stdout_handle:         None,
				stdout_metadata:       Default::default(),
				name:                  name.to_string(),
				paths:                 ShellPaths::with_cwd(cwd),
				env:                   HashMap::new(),
				cancel,
				exit_code:             0,
				stdin_is_search_input: false,
				merged_out:            None,
				sigpipe,
				commands:              None,
			};
			(host, capture)
		}

		/// Replaces stdout on a test host, keeping it under the SIGPIPE guard
		/// like the stream [`build_host`](super::build_host) installs. Tests
		/// that model a departed reader (`… | head`) hand in the write end of a
		/// pipe whose read end is already dropped.
		pub(crate) fn set_test_stdout(&mut self, file: OpenFile) {
			self.stdout_handle = output_handle(&file);
			self.stdout_metadata.take();
			self.stdout = SigpipeGuard::wrap(file, GuardedStream::Stdout, &self.sigpipe);
		}

		/// Sets an exported variable on a test host.
		pub(crate) fn set_test_var(&mut self, key: &str, value: &str) {
			self.env.insert(key.to_string(), value.to_string());
		}

		/// Requests cancellation on a test host.
		pub(crate) fn cancel_for_test(&self) {
			self.cancel.store(true, super::Ordering::Relaxed);
		}
	}

	#[cfg(windows)]
	#[test]
	fn resolves_msys_and_tmp_aliases_to_native_locations() {
		let (host, _) = Host::for_test("test", "", r"C:\workspace");

		assert_eq!(host.resolve("/c/Users/Adam/file.txt"), PathBuf::from(r"C:\Users\Adam\file.txt"));
		assert_eq!(host.resolve("/tmp/probe"), std::env::temp_dir().join("probe"));
	}

	/// Parses `argv` and runs `U` against an in-memory host, mirroring what the
	/// registered builtin does: `argv[0]` is the command name, clap failures are
	/// reported the same way, and panics are contained.
	pub(crate) fn run_util<U: Utility>(
		argv: &[&str],
		stdin: &str,
		cwd: impl Into<PathBuf>,
	) -> (i32, Capture) {
		let (mut host, capture) = Host::for_test(U::NAME, stdin.as_bytes().to_vec(), cwd);
		let full: Vec<OsString> = std::iter::once(OsString::from(U::NAME))
			.chain(argv.iter().map(OsString::from))
			.collect();
		let full = match U::rewrite_argv(full) {
			Ok(full) => full,
			Err(message) => {
				let _ = writeln!(host.stderr, "{}: {message}", U::NAME);
				return (i32::from(U::USAGE_ERROR), capture);
			},
		};
		let code = match U::try_parse_from(&full) {
			Ok(parsed) => run_caught::<U>(parsed, &mut host),
			Err(err) => {
				let rendered = err.to_string();
				if err.use_stderr() {
					let _ = write!(host.stderr, "{rendered}");
					i32::from(U::USAGE_ERROR)
				} else {
					let _ = write!(host.stdout, "{rendered}");
					0
				}
			},
		};
		(code, capture)
	}

	/// Runs `script` in a real shell with every builtin registered, from `cwd`
	/// with `stdin` on fd 0, returning its status, stdout, and stderr.
	///
	/// Utilities that set [`Utility::RUNS_COMMANDS`] need this: an in-memory
	/// [`Host::for_test`] has no shell to run their commands in.
	pub(crate) async fn run_script(
		script: &str,
		stdin: &str,
		cwd: &std::path::Path,
	) -> (i32, String, String) {
		use std::io::Seek;

		use brush_core::{ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo};

		use crate::factory::{BuiltinSet, default_builtins, utility_builtins};

		let mut shell = Shell::builder()
			.profile(ProfileLoadBehavior::Skip)
			.rc(RcLoadBehavior::Skip)
			.builtins(default_builtins(BuiltinSet::BashMode))
			.build()
			.await
			.expect("test shell");
		for (name, builtin) in utility_builtins() {
			shell.register_builtin(name, builtin);
		}
		shell.set_working_dir(cwd).await.expect("test working directory");

		let mut input = tempfile::tempfile().expect("stdin file");
		input.write_all(stdin.as_bytes()).expect("write stdin");
		input.rewind().expect("rewind stdin");
		let output = tempfile::tempfile().expect("stdout file");
		let error = tempfile::tempfile().expect("stderr file");
		let mut params = shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, OpenFile::from(input));
		params.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(output.try_clone().expect("stdout")));
		params.set_fd(OpenFiles::STDERR_FD, OpenFile::from(error.try_clone().expect("stderr")));
		let result = shell
			.run_string(script, &SourceInfo::from("run-script"), &params)
			.await
			.expect("run test script");

		let read = |mut file: std::fs::File| {
			let mut text = String::new();
			file.rewind().expect("rewind capture");
			file.read_to_string(&mut text).expect("read capture");
			text
		};
		(i32::from(u8::from(result.exit_code)), read(output), read(error))
	}

	/// An in-memory [`openfiles::Stream`]: a cursor over fixed input, or an
	/// appending writer over a shared buffer.
	#[derive(Clone)]
	struct MemStream {
		input:  Arc<Mutex<io::Cursor<Vec<u8>>>>,
		output: Arc<Mutex<Vec<u8>>>,
	}

	impl MemStream {
		fn reader(data: Vec<u8>) -> Self {
			Self {
				input:  Arc::new(Mutex::new(io::Cursor::new(data))),
				output: Arc::new(Mutex::new(Vec::new())),
			}
		}

		fn writer(output: Arc<Mutex<Vec<u8>>>) -> Self {
			Self { input: Arc::new(Mutex::new(io::Cursor::new(Vec::new()))), output }
		}
	}

	impl Read for MemStream {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			self.input.lock().read(buf)
		}
	}

	impl Write for MemStream {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			self.output.lock().extend_from_slice(buf);
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	impl openfiles::Stream for MemStream {
		fn clone_box(&self) -> Box<dyn openfiles::Stream> {
			Box::new(self.clone())
		}

		#[cfg(unix)]
		fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, super::Error> {
			Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
		}

		#[cfg(unix)]
		fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, super::Error> {
			Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
		}
	}

	mod stdout_policy {
		use parking_lot::Mutex;

		use super::MemStream;
		use crate::host::{Arc, OpenFile, StreamWriter, Write};

		/// Contract: on a non-file destination, a completed line is visible to
		/// the consumer before any explicit flush; a partial line is held back.
		#[test]
		fn line_policy_flushes_completed_lines_immediately() {
			let buf = Arc::new(Mutex::new(Vec::new()));
			let stream = OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&buf))));
			let mut out = StreamWriter::new(stream);
			assert!(matches!(out, StreamWriter::Line(_)));

			out.write_all(b"hit\n").unwrap();
			assert_eq!(buf.lock().as_slice(), b"hit\n");

			out.write_all(b"partial").unwrap();
			assert_eq!(buf.lock().as_slice(), b"hit\n");

			out.flush().unwrap();
			assert_eq!(buf.lock().as_slice(), b"hit\npartial");
		}

		/// Contract: a regular-file destination stays block-buffered — bytes
		/// reach the file only on flush, not per line.
		#[test]
		fn regular_file_gets_block_buffering() {
			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("out.txt");
			let file = std::fs::File::create(&path).unwrap();
			let mut out = StreamWriter::new(OpenFile::File(file));
			assert!(matches!(out, StreamWriter::Block(_)));

			out.write_all(b"hit\n").unwrap();
			assert_eq!(std::fs::read(&path).unwrap(), b"");

			out.flush().unwrap();
			assert_eq!(std::fs::read(&path).unwrap(), b"hit\n");
		}

		/// Contract: the shell hands commands their stdout as a pipe fd wrapped
		/// in `std::fs::File`; that must classify as line-buffered, or live tool
		/// output stalls until the utility exits.
		#[cfg(unix)]
		#[test]
		fn pipe_wrapped_as_file_gets_line_buffering() {
			let (reader, writer) = std::io::pipe().unwrap();
			let file = std::fs::File::from(std::os::fd::OwnedFd::from(writer));
			assert!(matches!(StreamWriter::new(OpenFile::File(file)), StreamWriter::Line(_)));
			drop(reader);
		}

		/// Contract for `2>&1`: two handles onto one shared writer interleave
		/// in exact write order — diagnostics land where they were emitted
		/// relative to output, not where a second buffer happened to flush.
		#[test]
		fn shared_handles_preserve_write_order() {
			let buf = Arc::new(Mutex::new(Vec::new()));
			let inner =
				StreamWriter::line(OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&buf)))));
			let shared = Arc::new(Mutex::new(inner));
			let mut out = StreamWriter::Shared(Arc::clone(&shared));
			let mut err = StreamWriter::Shared(shared);

			writeln!(out, "out 1").unwrap();
			writeln!(err, "err 1").unwrap();
			writeln!(out, "out 2").unwrap();

			assert_eq!(buf.lock().as_slice(), b"out 1\nerr 1\nout 2\n");
		}

		/// Contract: `2>&1` over a pipe is detected (same object, no offset),
		/// while distinct pipes and regular files — which have independent
		/// offsets under `>f 2>f` — are not merged.
		#[cfg(unix)]
		#[test]
		fn same_destination_detects_dup_pipes_only() {
			use crate::host::same_destination;

			let (reader, writer) = std::io::pipe().unwrap();
			let dup = writer.try_clone().unwrap();
			let a = OpenFile::File(std::fs::File::from(std::os::fd::OwnedFd::from(writer)));
			let b = OpenFile::File(std::fs::File::from(std::os::fd::OwnedFd::from(dup)));
			assert!(same_destination(&a, &b));

			let (reader2, writer2) = std::io::pipe().unwrap();
			let c = OpenFile::File(std::fs::File::from(std::os::fd::OwnedFd::from(writer2)));
			assert!(!same_destination(&a, &c));

			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("out.txt");
			let f1 = OpenFile::File(std::fs::File::create(&path).unwrap());
			let f2 = OpenFile::File(std::fs::File::create(&path).unwrap());
			assert!(!same_destination(&f1, &f2));

			drop((reader, reader2));
		}
	}

	#[cfg(unix)]
	mod sigpipe {
		use std::ffi::OsString;

		use crate::host::{Host, OpenFile, SIGPIPE_EXIT_CODE, Utility, Write, run_caught};

		/// A port written the naive way: any write failure is a diagnostic on
		/// stderr plus exit 1. Nothing in it knows about broken pipes.
		#[derive(clap::Parser)]
		struct NaiveWriter {
			#[arg(long)]
			ignore_sigpipe: bool,
		}

		impl Utility for NaiveWriter {
			const NAME: &'static str = "naive";

			fn run(self, host: &mut Host) -> i32 {
				if self.ignore_sigpipe {
					host.ignore_sigpipe();
				}
				for _ in 0..4 {
					if let Err(error) = writeln!(host.stdout, "line") {
						let _ = writeln!(host.stderr, "naive: write error: {error}");
						return 1;
					}
				}
				0
			}
		}

		fn closed_pipe_host(args: &[&str]) -> (i32, super::Capture) {
			let (mut host, capture) = Host::for_test("naive", "", "/");
			let (reader, writer) = std::io::pipe().unwrap();
			drop(reader);
			host.set_test_stdout(OpenFile::from(writer));
			let argv: Vec<OsString> =
				std::iter::once("naive").chain(args.iter().copied()).map(OsString::from).collect();
			let parsed = <NaiveWriter as clap::Parser>::try_parse_from(argv).unwrap();
			(run_caught::<NaiveWriter>(parsed, &mut host), capture)
		}

		/// Contract: a utility that knows nothing about SIGPIPE still dies the
		/// way its standalone counterpart does — status 141, no diagnostic —
		/// when the downstream stage has already exited (`cut f | sed 'bad'`).
		#[test]
		fn closed_reader_silences_diagnostics_and_exits_141() {
			let (code, capture) = closed_pipe_host(&[]);
			assert_eq!(code, SIGPIPE_EXIT_CODE);
			assert_eq!(capture.err(), "");
		}

		/// Contract: `ignore_sigpipe` is `SIG_IGN` — the utility sees the
		/// `io::Error` and its own reporting stands.
		#[test]
		fn ignored_sigpipe_leaves_error_handling_to_the_utility() {
			let (code, capture) = closed_pipe_host(&["--ignore-sigpipe"]);
			assert_eq!(code, 1);
			assert!(capture.err().starts_with("naive: write error: Broken pipe"), "{:?}", capture.err());
		}
	}
}

#[cfg(test)]
#[allow(unused_imports, reason = "used by utility test modules, which are feature-gated")]
pub(crate) use testing::{Capture, run_script, run_util};
