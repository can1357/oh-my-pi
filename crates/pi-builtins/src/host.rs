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
//! [`Utility::run`] body (or [`AsyncUtility`], with an `async` body awaited on
//! the shell task; see [`async_util`]). [`util`] wraps that into a
//! [`Registration`] which
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
	future::poll_fn,
	io::{self, BufWriter, LineWriter, Read, Write},
	marker::PhantomData,
	panic::{AssertUnwindSafe, catch_unwind},
	path::{Path, PathBuf},
	pin::pin,
	time::Duration,
	sync::{
		Arc, OnceLock,
		atomic::{AtomicBool, Ordering},
	},
};

use futures::{
	FutureExt,
	stream::{FuturesUnordered, StreamExt},
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

use crate::stdio::{AsyncOut, Source};

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

	/// Whether the utility runs command lines through [`Host::run_command`] or
	/// [`Host::spawn_command`] (`xargs`, `find -exec`, `ifne`). The adapter then
	/// forks subshells of the invoking shell to serve them; every other utility
	/// skips that cost.
	const RUNS_COMMANDS: bool = false;

	/// Whether the utility handles cancellation like a process that catches
	/// SIGINT/SIGTERM/SIGHUP: once the shell cancels it (abort, `timeout`), it
	/// still reports its own exit status and its final diagnostics (`rsync`'s
	/// `received SIGINT, SIGTERM, or SIGHUP (code 20)` trailer). The adapter
	/// then awaits the body's status instead of reporting 130, and output
	/// written after the cancellation is not dropped. The body must still end
	/// promptly once [`Host::is_cancelled`] turns true. Every other utility
	/// keeps the default: killed silently with status 130.
	const OWNS_CANCELLATION: bool = false;

	/// Whether the utility asks [`Host::path_is_stdout`] (`rg`, which must not
	/// read the file its own output lands in). Only then does the host keep a
	/// handle on stdout's identity; every other utility skips the dup.
	const CHECKS_STDOUT_PATH: bool = false;

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

/// A command-line utility whose body is `async`, awaited directly on the
/// shell task by the adapter [`AsyncUtil`] (no blocking thread).
///
/// The constants and [`AsyncUtility::rewrite_argv`] mean what they do for
/// [`Utility`]. The body is dropped when the shell cancels the utility, so it
/// needs no polling of [`Host::is_cancelled`]; it MUST NOT block. Its output
/// is memory-backed: writes to [`Host::stdout_writer`] and [`Host::stderr`]
/// are delivered by [`Host::flush_output`] (called at unit boundaries) and by
/// the adapter when the body ends, and stdin is read with
/// [`Host::read_stdin`] or [`Host::read_stdin_to_end`]. Register with
/// [`async_util`].
pub(crate) trait AsyncUtility: clap::Parser + Send + Sync + 'static {
	/// Program name, used in diagnostics.
	const NAME: &'static str;

	/// Exit status for a usage error; see [`Utility::USAGE_ERROR`].
	const USAGE_ERROR: u8 = 1;

	/// Whether the body runs command lines through [`Host::run_command_async`]
	/// or [`Host::spawn_command_async`].
	const RUNS_COMMANDS: bool = false;

	/// Whether the body asks [`Host::path_is_stdout`].
	const CHECKS_STDOUT_PATH: bool = false;

	/// Rewrites raw `argv` before clap parses it; see [`Utility::rewrite_argv`].
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(argv)
	}

	/// Runs the utility to completion, returning its exit status.
	fn run(self, host: &mut Host) -> impl Future<Output = i32> + Send;
}

/// The shell as a utility builtin sees it: standard streams, working
/// directory, exported environment, cancellation, and accumulated exit status.
///
/// The three streams are public fields rather than accessors so a utility can
/// hold `&mut` borrows of two of them at once (reading stdin while writing
/// stdout is the common case).
pub(crate) struct Host {
	/// Standard input. Reads observe cancellation, so a blocked pipe read
	/// fails with the cancellation error on abort instead of hanging the shell.
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
	/// Whether stdout is a regular file, sampled before the SIGPIPE guard hid
	/// its descriptor; picks [`Host::stdout_writer`]'s buffering.
	stdout_is_file:        bool,
	/// Unwrapped stdout retained for provider-aware self-read detection; only
	/// kept for [`Utility::CHECKS_STDOUT_PATH`] utilities.
	stdout_handle:         Option<OpenFile>,
	/// Populated on the utility worker, where virtual handle queries may block.
	stdout_metadata:       OnceLock<Option<Metadata>>,
	/// The effective umask, read once per invocation (see [`Host::umask`]).
	umask:                 OnceLock<u32>,

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
	/// Raised when the utility reports an error yet goes on; `None` when the
	/// shell asked for no such report.
	reported_error:        Option<Arc<AtomicBool>>,
	/// The memory-backed stdout and stderr of an async utility; `None` for a
	/// sync one, whose writers deliver on every write.
	async_out:             Option<AsyncStreams>,
	/// Stdin as an async [`Source`], opened by the first [`Host::read_stdin`].
	stdin_source:          Option<Source>,
}

/// The two [`AsyncOut`]s of an async utility; one buffer when stdout and
/// stderr share a destination.
struct AsyncStreams {
	stdout: AsyncOut,
	stderr: AsyncOut,
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

/// Metadata of the regular file backing a utility's stdout (see
/// [`Host::stdout_file`]).
#[derive(Clone, Debug)]
pub(crate) struct StdoutFile(Metadata);

impl StdoutFile {
	/// Whether `path` on `fs` is this file.
	pub async fn is(&self, fs: &pi_vfs::Fs, path: &Path) -> bool {
		fs.metadata(path).await.is_ok_and(|candidate| self.0.same_file(&candidate))
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

/// What the death of the emulated process (SIGPIPE, cancellation) does to one
/// output stream; shared by [`SigpipeGuard`] and the async utilities'
/// memory-backed output.
#[derive(Clone)]
pub(crate) struct OutputGate {
	stream:  GuardedStream,
	sigpipe: Arc<Sigpipe>,
	cancel:  CommandCancel,
}

impl OutputGate {
	fn new(stream: GuardedStream, sigpipe: &Arc<Sigpipe>, cancel: &CommandCancel) -> Self {
		Self { stream, sigpipe: Arc::clone(sigpipe), cancel: cancel.clone() }
	}

	/// Whether the emulated process is dead to this stream's reader: writes
	/// are dropped.
	pub fn discards(&self) -> bool {
		(self.cancel.silences && self.cancel.fired())
			|| matches!(self.stream, GuardedStream::Stderr) && self.sigpipe.is_hit()
	}

	/// Whether writes to this stream fail: stdout once a reader has gone.
	pub fn fails(&self) -> bool {
		matches!(self.stream, GuardedStream::Stdout) && self.sigpipe.is_hit()
	}

	/// Notes a failed write, flipping the SIGPIPE state on a closed reader.
	pub fn record(&self, error: &io::Error) {
		self.sigpipe.record(error);
	}
}

/// An [`openfiles::Stream`] wrapper that turns `EPIPE` into emulated SIGPIPE.
/// Clones share the [`Sigpipe`] state, so `stdout_clone()` handles given to
/// helper threads participate too.
///
/// It also emulates the other way a command dies: once the command is
/// cancelled (abort, `timeout`, `kill %N`), a standalone utility would be
/// killed and print nothing more, so every later write on either stream is
/// dropped. This is the one place that silences what a cancelled utility
/// says about its cancelled reads (`cat: /dev/zero: Operation canceled`,
/// `tail: internal error`); utilities need no case of their own. A utility
/// that owns its cancellation ([`Utility::OWNS_CANCELLATION`]) is not
/// silenced: it reports its own end, like a process that catches the signal.
struct SigpipeGuard {
	inner: OpenFile,
	gate:  OutputGate,
}

impl SigpipeGuard {
	fn wrap(
		inner: OpenFile,
		stream: GuardedStream,
		sigpipe: &Arc<Sigpipe>,
		cancel: &CommandCancel,
	) -> OpenFile {
		OpenFile::Stream(Box::new(Self { inner, gate: OutputGate::new(stream, sigpipe, cancel) }))
	}

	/// Whether the emulated process is dead to this stream's reader.
	fn discards(&self) -> bool {
		self.gate.discards()
	}
}

impl Read for SigpipeGuard {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		self.inner.read(buf)
	}
}

impl Write for SigpipeGuard {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		if self.discards() {
			return Ok(buf.len());
		}
		self.inner.write(buf).inspect_err(|error| self.gate.record(error))
	}

	fn flush(&mut self) -> io::Result<()> {
		if self.discards() {
			return Ok(());
		}
		self.inner.flush().inspect_err(|error| self.gate.record(error))
	}
}

impl openfiles::Stream for SigpipeGuard {
	fn clone_box(&self) -> Box<dyn openfiles::Stream> {
		Box::new(Self { inner: self.inner.clone(), gate: self.gate.clone() })
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

/// Whether the command a utility runs for has been cancelled: its token fired
/// (checked directly, so a diagnostic written before the adapter reacts is
/// still dropped), or the adapter raised the host's flag.
#[derive(Clone)]
struct CommandCancel {
	flag:     Arc<AtomicBool>,
	token:    Option<CancellationToken>,
	/// Writes on guarded streams are dropped once cancelled (false for a
	/// [`Utility::OWNS_CANCELLATION`] utility, which reports its own end).
	silences: bool,
}

impl CommandCancel {
	fn fired(&self) -> bool {
		self.flag.load(Ordering::Relaxed) || self.token.as_ref().is_some_and(CancellationToken::is_cancelled)
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
		// Scoped to the command's own cancellation (the operand's token under
		// `timeout`), so a utility reading a host file stops when it fires
		// instead of draining the file first: `timeout 1 cat /dev/zero` never
		// returned.
		let filesystem = context.shell.filesystem().blocking();
		let filesystem = match context.cancel_token() {
			Some(token) => filesystem.with_cancellation(token),
			None => filesystem,
		};
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

/// The host process umask, which builtins must never change: they run on
/// threads of a process that other shells and the host share.
///
/// Linux reads it race-free from `/proc/self/status`. Elsewhere the only way to
/// read it is to set it and set it back, which briefly unmasks other threads'
/// creations, so that happens once per process.
#[cfg(unix)]
pub(crate) fn process_umask() -> u32 {
	use std::sync::LazyLock;

	use nix::sys::stat::{Mode, umask};

	#[allow(clippy::useless_conversion, reason = "`mode_t` is u16 on some targets")]
	static TOGGLED: LazyLock<u32> = LazyLock::new(|| {
		let mask = umask(Mode::empty());
		umask(mask);
		u32::from(mask.bits())
	});
	cfg_select! {
		any(target_os = "linux", target_os = "android") => {
			procfs::process::Process::myself()
				.ok()
				.and_then(|me| me.status().ok())
				.and_then(|status| status.umask)
				.unwrap_or_else(|| *TOGGLED)
		}
		_ => *TOGGLED,
	}
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

	/// The file mode creation mask for new files: the shell's `umask` once one
	/// was set, else the host process's. `0` where there is no umask. Read
	/// once per invocation.
	pub fn umask(&self) -> u32 {
		*self.umask.get_or_init(|| {
			#[cfg(unix)]
			{
				self.fs().creation_mask().unwrap_or_else(process_umask)
			}
			#[cfg(not(unix))]
			{
				0
			}
		})
	}

	/// Whether `path` identifies the regular file currently backing stdout.
	/// Always `false` unless the utility set [`Utility::CHECKS_STDOUT_PATH`].
	pub async fn path_is_stdout(&self, path: &Path) -> bool {
		match self.stdout_file() {
			Some(stdout) => stdout.is(&self.vfs(), path).await,
			None => false,
		}
	}

	/// The regular file backing stdout, as a `Sync` value worker threads can
	/// test paths against; `None` when stdout is no regular file or the
	/// utility did not set [`Utility::CHECKS_STDOUT_PATH`].
	pub fn stdout_file(&self) -> Option<StdoutFile> {
		self.stdout_metadata
			.get_or_init(|| self.stdout_handle.as_ref().and_then(output_metadata))
			.as_ref()
			.filter(|stdout| stdout.is_file())
			.map(|stdout| StdoutFile(stdout.clone()))
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

	/// The flag to raise when the utility reports an error yet goes on, so
	/// its exit status does not show the failure; `None` when the shell asked
	/// for no such report.
	pub fn reported_error_flag(&self) -> Option<Arc<AtomicBool>> {
		self.reported_error.clone()
	}

	/// The async facade of the host filesystem, for utilities awaiting
	/// provider I/O.
	pub fn vfs(&self) -> pi_vfs::Fs {
		self.paths.fs().to_async()
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

	/// Writes `<name>: <message>` followed by GNU's `Try '<name> --help' for
	/// more information.`, records exit status `code`, and returns it.
	///
	/// For usage errors found after parsing (operand combinations, invalid
	/// option values); clap's own errors are rendered by the [`Util`] adapter.
	pub fn usage_error(&mut self, message: impl std::fmt::Display, code: i32) -> i32 {
		let _ = writeln!(self.stderr, "{0}: {message}\nTry '{0} --help' for more information.", self.name);
		self.fail(code);
		code
	}

	/// Writes only the `Try '<name> --help' for more information.` pointer,
	/// after diagnostics already printed; records exit status `code` and
	/// returns it.
	pub fn try_help(&mut self, code: i32) -> i32 {
		let _ = writeln!(self.stderr, "Try '{} --help' for more information.", self.name);
		self.fail(code);
		code
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

	/// Whether stdout is a regular file, where output is only observed once
	/// the utility exits.
	pub const fn stdout_is_regular_file(&self) -> bool {
		self.stdout_is_file
	}

	/// A buffered stdout with a flush policy chosen by the destination of
	/// fd 1; see [`StreamWriter`].
	///
	/// Utilities that emit output progressively — stream filters (`grep`,
	/// `sed`, `cut`) and directory walkers (`ls`, `fd`) — must write through
	/// this rather than a raw `BufWriter`, so their output is visible as it is
	/// produced. Batch emitters whose output only exists once all input is
	/// consumed (`sort`, `tac`, `seq`) may keep plain block buffering.
	pub fn stdout_writer(&self) -> StreamWriter {
		if let Some(streams) = &self.async_out {
			return StreamWriter::Async(streams.stdout.clone());
		}
		match &self.merged_out {
			Some(shared) => StreamWriter::Shared(Arc::clone(shared)),
			None => StreamWriter::new(self.stdout.clone(), self.stdout_is_file),
		}
	}

	/// Delivers pending output of stdout and stderr: everything for non-file destinations, regular-file output once 64 KiB is pending; returns at once when nothing is due.
	///
	/// Output of an async utility sits in memory until this runs; the adapter
	/// delivers whatever remains when the body ends. Sync utilities write
	/// through, so this is a no-op for them.
	///
	/// # Errors
	///
	/// The first write failure; a closed reader is [`io::ErrorKind::BrokenPipe`]
	/// and ends the utility with the SIGPIPE status.
	pub async fn flush_output(&self) -> io::Result<()> {
		self.drain_output(false).await
	}

	/// Delivers pending output: all of it when `full`, else as
	/// [`Host::flush_output`].
	async fn drain_output(&self, full: bool) -> io::Result<()> {
		let Some(streams) = &self.async_out else {
			return Ok(());
		};
		let stdout = streams.stdout.drain(full).await;
		let stderr = if streams.stdout.same_as(&streams.stderr) {
			Ok(())
		} else {
			streams.stderr.drain(full).await
		};
		stdout.and(stderr)
	}

	/// Reads up to `buf.len()` bytes of stdin (0 at EOF): a provider file through its async API, a descriptor once the reactor reports it readable.
	///
	/// Dropping the future cancels the read; nothing keeps running.
	///
	/// # Errors
	///
	/// The read error; [`pi_vfs::cancelled`] once the command is cancelled.
	pub async fn read_stdin(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		if self.stdin.cancel.fired() {
			return Err(pi_vfs::cancelled());
		}
		let source = open_stdin(&mut self.stdin_source, &self.stdin.file)?;
		until_cancelled(&self.stdin.cancel, source.read(buf)).await
	}

	/// Reads the rest of stdin into `buf`, failing with `io::ErrorKind::OutOfMemory` past `limit` bytes.
	///
	/// Returns the bytes appended; on an error, or when the future is dropped
	/// mid-read, `buf` keeps what was read within the limit.
	///
	/// # Errors
	///
	/// [`io::ErrorKind::OutOfMemory`] past `limit`, else the read error.
	pub async fn read_stdin_to_end(&mut self, buf: &mut Vec<u8>, limit: usize) -> io::Result<usize> {
		if self.stdin.cancel.fired() {
			return Err(pi_vfs::cancelled());
		}
		let source = open_stdin(&mut self.stdin_source, &self.stdin.file)?;
		until_cancelled(&self.stdin.cancel, source.read_to_end(buf, limit)).await
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
	/// diagnostics are flushed first so output stays in order. Commands run in
	/// subshells, so a `cd` inside one cannot leak into the caller; a subshell's
	/// working directory is reset before each run.
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
	pub fn run_command(&mut self, command: ShellCommand) -> io::Result<CommandStatus> {
		self.spawn_command(command)?.wait()
	}

	/// Starts `command` as [`Host::run_command`] does, without waiting for it.
	///
	/// Commands started before earlier ones finish run concurrently, each in
	/// its own subshell (`xargs -P`); their output interleaves on this
	/// utility's descriptors. A command whose [`RunningCommand`] is dropped
	/// may never run; one already running is still waited for before the
	/// builtin returns.
	///
	/// # Errors
	///
	/// - [`io::ErrorKind::Interrupted`]: the shell cancelled this utility.
	/// - [`io::ErrorKind::Unsupported`]: the utility did not set
	///   [`Utility::RUNS_COMMANDS`].
	///
	/// Failures to run the command itself surface from [`RunningCommand::wait`].
	pub fn spawn_command(&mut self, command: ShellCommand) -> io::Result<RunningCommand> {
		let (commands, request, response) = self.enqueue(command)?;
		commands.send(request).map_err(|_| cancelled_command())?;
		Ok(RunningCommand { response })
	}

	/// Async twin of [`Host::run_command`]; the adapter keeps serving command
	/// requests while this is awaited.
	///
	/// # Errors
	///
	/// As for [`Host::run_command`], with [`AsyncUtility::RUNS_COMMANDS`].
	pub async fn run_command_async(&mut self, command: ShellCommand) -> io::Result<CommandStatus> {
		self.spawn_command_async(command).await?.wait().await
	}

	/// Async twin of [`Host::spawn_command`].
	///
	/// # Errors
	///
	/// As for [`Host::spawn_command`], with [`AsyncUtility::RUNS_COMMANDS`].
	pub async fn spawn_command_async(&mut self, command: ShellCommand) -> io::Result<RunningCommandAsync> {
		let _ = self.drain_output(true).await;
		let (commands, request, response) = self.enqueue(command)?;
		commands.send_async(request).await.map_err(|_| cancelled_command())?;
		Ok(RunningCommandAsync { response })
	}

	/// Builds the request for `command`, flushing pending diagnostics first so
	/// output stays in order.
	fn enqueue(
		&mut self,
		mut command: ShellCommand,
	) -> io::Result<(flume::Sender<CommandRequest>, CommandRequest, flume::Receiver<io::Result<CommandStatus>>)> {
		let Some(commands) = self.commands.clone() else {
			return Err(io::Error::new(
				io::ErrorKind::Unsupported,
				format!("{} cannot run commands", self.name),
			));
		};
		command.cwd = command.cwd.map(|dir| self.paths.resolve(dir));
		let (reply, response) = flume::bounded(1);
		let _ = self.stderr.flush();
		Ok((commands, CommandRequest { command, reply }, response))
	}
}

/// A command started by [`Host::spawn_command_async`].
#[must_use = "a started command should be waited for"]
pub(crate) struct RunningCommandAsync {
	response: flume::Receiver<io::Result<CommandStatus>>,
}

impl RunningCommandAsync {
	/// Waits for the command to finish.
	///
	/// # Errors
	///
	/// As for [`Host::run_command`].
	pub async fn wait(self) -> io::Result<CommandStatus> {
		self.response.recv_async().await.map_err(|_| cancelled_command())?
	}
}

/// A command started by [`Host::spawn_command`].
#[must_use = "a started command should be waited for"]
pub(crate) struct RunningCommand {
	response: flume::Receiver<io::Result<CommandStatus>>,
}

impl RunningCommand {
	/// Waits for the command to finish.
	///
	/// # Errors
	///
	/// As for [`Host::run_command`].
	pub fn wait(self) -> io::Result<CommandStatus> {
		self.response.recv().map_err(|_| cancelled_command())?
	}

	/// Waits for whichever of `running` finishes first and removes it from
	/// the list; `None` when `running` is empty.
	///
	/// # Errors
	///
	/// As for [`Host::run_command`], for the command that finished.
	pub fn wait_any(running: &mut Vec<Self>) -> Option<io::Result<CommandStatus>> {
		if running.is_empty() {
			return None;
		}
		let (index, response) = running
			.iter()
			.enumerate()
			.fold(flume::Selector::new(), |selector, (index, command)| {
				selector.recv(&command.response, move |response| (index, response))
			})
			.wait();
		drop(running.swap_remove(index));
		Some(response.map_err(|_| cancelled_command()).flatten())
	}
}

/// A command line for [`Host::run_command`]: `argv[0]` names the builtin or
/// program. Stdin defaults to the null device, as GNU `xargs` and `find
/// -exec` give their children.
pub(crate) struct ShellCommand {
	argv:  Vec<OsString>,
	argv0: Option<OsString>,
	cwd:   Option<PathBuf>,
	stdin: Option<OpenFile>,
	env:   Vec<EnvChange>,
}

/// One environment change a [`ShellCommand`] makes for its own command.
enum EnvChange {
	Clear,
	Remove(String),
	Set(String, String),
}

impl ShellCommand {
	pub fn new(argv: Vec<OsString>) -> Self {
		Self { argv, argv0: None, cwd: None, stdin: None, env: Vec::new() }
	}

	/// Presents `argv0` to the command as its `argv[0]` (`env -a`); the
	/// command is still looked up by the `argv[0]` given to
	/// [`ShellCommand::new`]. A builtin receives it as its first argument.
	pub fn argv0(mut self, argv0: impl Into<OsString>) -> Self {
		self.argv0 = Some(argv0.into());
		self
	}

	/// Starts the command from an empty environment (`env -i`): every
	/// exported variable is gone. Unexported shell variables, which were never
	/// part of the environment, stay.
	///
	/// This and [`ShellCommand::env_remove`] and [`ShellCommand::env`] apply
	/// in call order, to this command only: the worker subshell gets its
	/// variables back once the command finishes, so neither later commands
	/// nor the invoking shell see the change. A command with environment
	/// changes is looked up on its own `PATH`, or with no `PATH` on the
	/// default search path `execvp` uses, never through the shell's hash
	/// table.
	pub fn env_clear(mut self) -> Self {
		self.env.push(EnvChange::Clear);
		self
	}

	/// Removes the variable `name` for the command (`env -u`), exported or
	/// not. See [`ShellCommand::env_clear`] for the scope of the change.
	pub fn env_remove(mut self, name: impl Into<String>) -> Self {
		self.env.push(EnvChange::Remove(name.into()));
		self
	}

	/// Sets `name` to `value` in the command's environment (`env NAME=VALUE`).
	/// See [`ShellCommand::env_clear`] for the scope of the change.
	pub fn env(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
		self.env.push(EnvChange::Set(name.into(), value.into()));
		self
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

/// A [`Host::spawn_command`] call in flight from the utility's blocking worker
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

/// Serves [`Host::spawn_command`] on the async side, where a shell can run.
///
/// Every command runs in a worker subshell copied from one forked off the
/// invoking shell when the utility started, so commands see its builtins,
/// exported variables, and filesystem, while side effects on shell state
/// (`cd`, assignments) stay inside the subshell the way they would inside a
/// child process. Finished workers are reused; another is forked only when
/// every existing one is busy, so sequential commands share one.
struct CommandRunner<SE: ShellExtensions> {
	template: Shell<SE>,
	idle:     Vec<Shell<SE>>,
	params:   Arc<ExecutionParameters>,
	cwd:      Arc<Path>,
	requests: flume::Receiver<CommandRequest>,
}

impl<SE: ShellExtensions> CommandRunner<SE> {
	fn new(context: &ExecutionContext<'_, SE>, requests: flume::Receiver<CommandRequest>) -> Self {
		let mut template = context.shell.clone();
		template.options_mut().interactive = false;
		let cwd = Arc::from(template.working_dir());
		Self {
			template,
			idle: Vec::new(),
			params: Arc::new(context.params.clone()),
			cwd,
			requests,
		}
	}

	/// Starts serving `request` on a worker. The future answers the request —
	/// a utility that stopped waiting (it was cancelled) simply never reads
	/// the answer — and yields the worker back for [`CommandRunner::release`].
	fn start(&mut self, request: CommandRequest) -> impl Future<Output = Shell<SE>> + Send + use<SE> {
		let mut shell = self.idle.pop().unwrap_or_else(|| self.template.clone());
		let params = Arc::clone(&self.params);
		let cwd = Arc::clone(&self.cwd);
		async move {
			let status = run_in(&mut shell, &params, &cwd, request.command).await.map_err(|error| {
				let kind = match ExecutionExitCode::from(&error) {
					ExecutionExitCode::NotFound => io::ErrorKind::NotFound,
					ExecutionExitCode::CannotExecute => io::ErrorKind::PermissionDenied,
					_ => io::ErrorKind::Other,
				};
				io::Error::new(kind, error.to_string())
			});
			let _ = request.reply.send(status);
			shell
		}
	}

	/// Returns a worker whose command finished to the idle pool.
	fn release(&mut self, shell: Shell<SE>) {
		self.idle.push(shell);
	}
}

/// Runs `command` in the worker `shell` with the utility's `base` parameters,
/// from the command's own directory or else `cwd`.
async fn run_in<SE: ShellExtensions>(
	shell: &mut Shell<SE>,
	base: &ExecutionParameters,
	cwd: &Path,
	command: ShellCommand,
) -> Result<CommandStatus, Error> {
	let dir = command.cwd.as_deref().unwrap_or(cwd);
	if shell.working_dir() != dir {
		shell.set_working_dir(dir).await?;
	}
	if command.env.is_empty() {
		return dispatch(shell, base, command, None).await;
	}
	// The worker is reused for later commands: run on a scratch environment
	// and put the worker's own back whatever the outcome.
	let saved = shell.env().clone();
	*shell.env_mut() = changed_env(&saved, &command.env)?;
	let path_dirs = search_path(shell);
	let status = dispatch(shell, base, command, Some(path_dirs)).await;
	*shell.env_mut() = saved;
	status
}

/// `env` with `changes` applied, flattened into one global scope: a change
/// must win over every scope, and the command runs no shell functions whose
/// locals could need the stack.
fn changed_env(
	env: &brush_core::env::ShellEnvironment,
	changes: &[EnvChange],
) -> Result<brush_core::env::ShellEnvironment, Error> {
	let mut vars: HashMap<String, brush_core::ShellVariable> =
		env.iter().map(|(name, var)| (name.clone(), var.clone())).collect();
	for change in changes {
		match change {
			EnvChange::Clear => vars.retain(|_, var| !var.is_exported()),
			EnvChange::Remove(name) => {
				vars.remove(name);
			},
			EnvChange::Set(name, value) => {
				let mut var = brush_core::ShellVariable::new(brush_core::ShellValue::String(value.clone()));
				var.export();
				vars.insert(name.clone(), var);
			},
		}
	}
	let mut changed = brush_core::env::ShellEnvironment::new();
	for (name, var) in vars {
		changed.set_global(name, var)?;
	}
	Ok(changed)
}

/// The directories `execvp` would search for a command run with `shell`'s
/// environment: its `PATH`, else the C library's default. Relative and empty
/// entries name directories under the working directory.
fn search_path<SE: ShellExtensions>(shell: &Shell<SE>) -> Vec<PathBuf> {
	const DEFAULT_PATH: &str = if cfg!(any(target_os = "linux", target_os = "android")) {
		"/bin:/usr/bin"
	} else {
		"/usr/bin:/bin"
	};
	let path = shell.env().get_str("PATH", shell);
	let path = path.as_deref().unwrap_or(DEFAULT_PATH);
	brush_core::sys::fs::split_paths(path)
		.map(|dir| shell.working_dir().join(dir))
		.collect()
}

/// Dispatches `command` in the worker `shell` as a simple command, searching
/// `path_dirs` for programs when given.
async fn dispatch<SE: ShellExtensions>(
	shell: &mut Shell<SE>,
	base: &ExecutionParameters,
	command: ShellCommand,
	path_dirs: Option<Vec<PathBuf>>,
) -> Result<CommandStatus, Error> {
	let mut params = base.clone();
	params.set_fd(OpenFiles::STDIN_FD, or_null(command.stdin)?);
	let cancel = params.cancel_token();
	let mut args: Vec<CommandArg> = command
		.argv
		.into_iter()
		.map(|arg| CommandArg::from(arg.to_string_lossy().into_owned()))
		.collect();
	let name = args.first().map_or_default(ToString::to_string);
	let argv0 = command.argv0.map(|argv0| argv0.to_string_lossy().into_owned());
	if let (Some(argv0), Some(first)) = (&argv0, args.first_mut()) {
		*first = CommandArg::from(argv0.clone());
	}
	let mut simple =
		SimpleCommand::new(ShellForCommand::ParentShell(shell), params, name, args);
	simple.use_functions = false;
	simple.argv0 = argv0;
	simple.path_dirs = path_dirs;
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
			let mut stderr = base.stderr(shell);
			let _ = shell.display_error(&mut stderr, &error).await;
			return Ok(CommandStatus::Exited(ExecutionExitCode::from(&error).into()));
		},
	};
	wait_status(spawned, cancel).await
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
/// in `OpenFile::File`, hence the `fstat` in [`Destination::of`] rather than
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
	/// Memory-backed output of an async utility: writes append to a buffer
	/// the host delivers asynchronously (see [`Host::flush_output`]).
	Async(AsyncOut),
}

impl StreamWriter {
	const BLOCK_CAPACITY: usize = 64 * 1024;
	const LINE_CAPACITY: usize = 16 * 1024;

	/// Picks the policy for a destination: block for a regular file, line
	/// otherwise. `regular_file` comes from the stream's [`Destination`],
	/// sampled before any wrapper hides the descriptor.
	pub fn new(file: OpenFile, regular_file: bool) -> Self {
		if regular_file { Self::block(file) } else { Self::line(file) }
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
			Self::Async(out) => out.dup_file(),
		}
	}

	/// Whether the destination is a terminal, mirroring
	/// [`OpenFile::is_terminal`].
	pub fn is_terminal(&self) -> bool {
		match self {
			Self::Block(w) => w.get_ref().is_terminal(),
			Self::Line(w) => w.get_ref().is_terminal(),
			Self::Shared(shared) => shared.lock().is_terminal(),
			Self::Async(out) => out.is_terminal(),
		}
	}
}

impl Write for StreamWriter {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Self::Block(w) => w.write(buf),
			Self::Line(w) => w.write(buf),
			Self::Shared(shared) => shared.lock().write(buf),
			Self::Async(out) => out.write(buf),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::Block(w) => w.flush(),
			Self::Line(w) => w.flush(),
			Self::Shared(shared) => shared.lock().flush(),
			Self::Async(out) => out.flush(),
		}
	}

	fn write_vectored(&mut self, bufs: &[io::IoSlice<'_>]) -> io::Result<usize> {
		match self {
			Self::Block(w) => w.write_vectored(bufs),
			Self::Line(w) => w.write_vectored(bufs),
			Self::Shared(shared) => shared.lock().write_vectored(bufs),
			Self::Async(out) => out.write_vectored(bufs),
		}
	}

	// `write_all` and `write_fmt` must reach the inner writer's own versions:
	// the defaults loop over `write`, and `LineWriter::write` flushes a
	// buffered prefix before writing the newline-terminated rest, so a line
	// written in pieces (`cat -n`'s number, then the content) would cost two
	// syscalls instead of one. Under one lock, a `Shared` line also stays
	// whole against concurrent stderr writes.
	fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
		match self {
			Self::Block(w) => w.write_all(buf),
			Self::Line(w) => w.write_all(buf),
			Self::Shared(shared) => shared.lock().write_all(buf),
			Self::Async(out) => out.write_all(buf),
		}
	}

	fn write_fmt(&mut self, args: std::fmt::Arguments<'_>) -> io::Result<()> {
		match self {
			Self::Block(w) => w.write_fmt(args),
			Self::Line(w) => w.write_fmt(args),
			Self::Shared(shared) => shared.lock().write_fmt(args),
			Self::Async(out) => out.write_fmt(args),
		}
	}
}

/// What a standard stream's descriptor points at, sampled once per
/// invocation before the stream is wrapped.
#[derive(Clone, Copy)]
struct Destination {
	/// A regular file: nothing observes it until the utility exits, so writes
	/// block-buffer. A pipe wrapped in `std::fs::File` (how the shell hands
	/// the capture pipe to a command) reports a fifo, and a handle that cannot
	/// be queried counts as not a file: line buffering is the
	/// visibility-safe default.
	regular_file: bool,
	/// Device and inode of a non-seekable destination (pipe, fifo, terminal,
	/// socket), which has no offset, so equal ids mean one object (`2>&1`).
	/// Regular files never carry one: `cmd >f 2>f` opens two descriptions
	/// with independent offsets, and one writer would change where bytes land.
	#[cfg(unix)]
	id:           Option<(u64, u64)>,
}

impl Destination {
	fn of(file: &OpenFile) -> Self {
		#[cfg(unix)]
		{
			let Some(stat) = file
				.try_borrow_as_fd()
				.ok()
				.and_then(|fd| rustix::fs::fstat(fd).ok())
			else {
				return Self { regular_file: false, id: None };
			};
			let regular_file =
				rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::RegularFile;
			#[allow(clippy::unnecessary_cast, reason = "dev_t and ino_t widths vary by target")]
			let id = (!regular_file).then_some((stat.st_dev as u64, stat.st_ino as u64));
			Self { regular_file, id }
		}
		#[cfg(not(unix))]
		{
			Self {
				regular_file: matches!(file, OpenFile::File(f) if f.metadata().is_ok_and(|m| m.is_file())),
			}
		}
	}

	/// Whether `self` and `other` are the same non-seekable object (`2>&1`,
	/// and the harness default, where one capture pipe backs both fds).
	fn shares_with(&self, other: &Self) -> bool {
		#[cfg(unix)]
		{
			self.id.is_some() && self.id == other.id
		}
		#[cfg(not(unix))]
		{
			let _ = other;
			false
		}
	}
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
/// On unix, when fd 0 is a descriptor whose reads can block (a pipe, FIFO,
/// terminal, socket or device), reads wait for readiness in short
/// slices so an abort or `timeout` is observed even when input never arrives on
/// a blocked pipe. A cancelled read fails with [`pi_vfs::cancelled`], not EOF,
/// so a utility never reports a result for input it did not finish reading
/// (`timeout 1 md5sum - < big` printed a checksum of a prefix); it unwinds
/// rather than leaving a detached thread writing to descriptors the host has
/// moved on from, and what it says about the error is dropped.
pub(crate) struct Stdin {
	file:   OpenFile,
	#[cfg_attr(not(unix), allow(dead_code, reason = "readiness polling is unix-only"))]
	fd:     Option<i32>,
	/// The command's cancellation. A provider-backed fd 0 (`< virtual://f`) has
	/// no descriptor to poll, and the facade that opened it is usually the
	/// outer command's, not this command's (a `timeout` operand), so its reads
	/// are raced against this command's token directly.
	cancel: CommandCancel,
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
		Ok(Self { file, fd, cancel: self.cancel.clone() })
	}

	/// Whether the command was cancelled, for utilities that read fd 0's
	/// descriptor directly (`wc -c` splices a pipe) and so bypass the reads
	/// that fail once it is.
	pub fn is_cancelled(&self) -> bool {
		self.cancel.fired()
	}
}

/// The raw descriptor [`Stdin`] polls for readiness, so a blocked read
/// observes cancellation; `None` off unix, for in-process streams, and for a
/// descriptor whose reads never block (see [`pi_vfs::reads_can_block`]).
fn pollable_fd(file: &OpenFile) -> Option<i32> {
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		file.try_borrow_as_fd()
			.ok()
			.filter(|fd| pi_vfs::fd_reads_can_block(*fd))
			.map(|fd| fd.as_raw_fd())
	}
	#[cfg(not(unix))]
	{
		let _ = file;
		None
	}
}

impl Read for Stdin {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if self.cancel.fired() {
			return Err(pi_vfs::cancelled());
		}
		#[cfg(unix)]
		if let Some(fd) = self.fd {
			// SAFETY: `fd` is owned by the live `OpenFile` held in this struct.
			let fd = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
			pi_vfs::wait_readable(fd, || self.cancel.fired())?;
		}
		match (&self.file, &self.cancel.token) {
			(OpenFile::Vfs(file), Some(token)) => file.read_until_cancelled(buf, token),
			_ => self.file.read(buf),
		}
	}
}

/// Stdin as a [`Source`], opened on first use and kept in `slot`.
fn open_stdin<'a>(slot: &'a mut Option<Source>, file: &OpenFile) -> io::Result<&'a mut Source> {
	let source = match slot.take() {
		Some(source) => source,
		None => Source::inherited(file)?,
	};
	Ok(slot.insert(source))
}

/// Awaits `read`, failing with [`pi_vfs::cancelled`] once the command is
/// cancelled: a provider-backed stdin's facade is usually the outer
/// command's, not this command's (a `timeout` operand), so the read is raced
/// against this command's own token. Without a token, dropping the future is
/// the only cancellation.
async fn until_cancelled<T>(
	cancel: &CommandCancel,
	read: impl Future<Output = io::Result<T>>,
) -> io::Result<T> {
	match &cancel.token {
		Some(token) => tokio::select! {
			biased;
			() = token.cancelled() => Err(pi_vfs::cancelled()),
			read = read => read,
		},
		None => read.await,
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

/// Renders an I/O error the way GNU utilities print `strerror(errno)`: without
/// Rust's ` (os error N)` suffix, and with POSIX wording for OS errors whose
/// kind maps to a single errno. Windows reports `ERROR_FILE_NOT_FOUND` as
/// "The system cannot find the file specified.", which a GNU-emulating
/// diagnostic must spell "No such file or directory" like everywhere else.
pub(crate) fn strip_errno(error: &io::Error) -> String {
	if error.raw_os_error().is_some()
		&& let Some(text) = posix_strerror(error.kind())
	{
		return text.to_owned();
	}
	let mut message = error.to_string();
	if let Some(position) = message.find(" (os error ") {
		message.truncate(position);
	}
	message
}

/// POSIX `strerror` text for an OS error kind. Kinds that cover several errnos
/// on unix (`PermissionDenied` is both `EPERM` and `EACCES`) keep the native
/// text there, which is already exact.
fn posix_strerror(kind: io::ErrorKind) -> Option<&'static str> {
	use io::ErrorKind;
	Some(match kind {
		ErrorKind::NotFound => "No such file or directory",
		ErrorKind::AlreadyExists => "File exists",
		ErrorKind::NotADirectory => "Not a directory",
		ErrorKind::IsADirectory => "Is a directory",
		ErrorKind::DirectoryNotEmpty => "Directory not empty",
		#[cfg(not(unix))]
		ErrorKind::PermissionDenied => "Permission denied",
		_ => return None,
	})
}

/// Forward-slash spelling of a Windows display path, or `None` when the path
/// already displays as-is (non-Windows, no backslashes, verbatim prefix, or
/// non-Unicode names that must stay native).
///
/// Utilities that print paths they built themselves (`find`, `rg`, `diff -r`)
/// render them the way the bash they emulate does, with `/` separators, so
/// output does not change spelling with the host platform.
pub(crate) fn forward_slash_display(path: &Path) -> Option<PathBuf> {
	if !cfg!(windows) {
		return None;
	}
	let text = path.to_str()?;
	let literal = matches!(
		path.components().next(),
		Some(std::path::Component::Prefix(prefix))
			if prefix.kind().is_verbatim() || matches!(prefix.kind(), std::path::Prefix::DeviceNS(_))
	);
	(text.contains('\\') && !literal).then(|| PathBuf::from(text.replace('\\', "/")))
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

/// Returns the [`Registration`] for an [`AsyncUtility`].
pub(crate) fn async_util<U: AsyncUtility, SE: ShellExtensions>() -> Registration<SE> {
	builtins::builtin::<AsyncUtil<U>, SE>().async_io()
}

/// What the shared adapter needs to know about a utility, whichever trait it
/// implements.
#[derive(Clone, Copy)]
struct Spec {
	name:               &'static str,
	usage_error:        u8,
	runs_commands:      bool,
	checks_stdout_path: bool,
	owns_cancellation:  bool,
	/// Whether the body is async, so its output is memory-backed (see
	/// [`AsyncOut`]).
	async_io:           bool,
	rewrite_argv:       fn(Vec<OsString>) -> Result<Vec<OsString>, String>,
}

impl Spec {
	fn of_sync<U: Utility>() -> Self {
		Self {
			name:               U::NAME,
			usage_error:        U::USAGE_ERROR,
			runs_commands:      U::RUNS_COMMANDS,
			checks_stdout_path: U::CHECKS_STDOUT_PATH,
			owns_cancellation:  U::OWNS_CANCELLATION,
			async_io:           false,
			rewrite_argv:       U::rewrite_argv,
		}
	}

	fn of_async<U: AsyncUtility>() -> Self {
		Self {
			name:               U::NAME,
			usage_error:        U::USAGE_ERROR,
			runs_commands:      U::RUNS_COMMANDS,
			checks_stdout_path: U::CHECKS_STDOUT_PATH,
			owns_cancellation:  false,
			async_io:           true,
			rewrite_argv:       U::rewrite_argv,
		}
	}
}

/// Adapter turning an [`AsyncUtility`] into a brush builtin; see [`Util`].
pub(crate) struct AsyncUtil<U: AsyncUtility> {
	argv:    Vec<String>,
	_marker: PhantomData<fn() -> U>,
}

impl<U: AsyncUtility> clap::FromArgMatches for AsyncUtil<U> {
	fn from_arg_matches(_matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { argv: Vec::new(), _marker: PhantomData })
	}

	fn update_from_arg_matches(&mut self, _matches: &clap::ArgMatches) -> Result<(), clap::Error> {
		Ok(())
	}
}

impl<U: AsyncUtility> clap::CommandFactory for AsyncUtil<U> {
	fn command() -> clap::Command {
		U::command()
	}

	fn command_for_update() -> clap::Command {
		U::command_for_update()
	}
}

impl<U: AsyncUtility> clap::Parser for AsyncUtil<U> {}

impl<U: AsyncUtility> builtins::Command for AsyncUtil<U> {
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
		run_async_utility::<U, SE>(context, self.argv.clone()).await
	}
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
	let spec = Spec::of_sync::<U>();
	let Prepared { parsed, mut host, runner, cancel, cancel_flag, _cancel_on_drop } =
		match prepare::<U, SE>(context, argv, spec) {
			Ok(prepared) => prepared,
			Err(done) => return done,
		};

	let handle = tokio::task::spawn_blocking(move || {
		let code = run_caught::<U>(parsed, &mut host);
		let closes = host.fs().drain_closes();
		closes_status(&mut host, closes, code)
	});

	// Respect shell abort/`timeout`. On cancel `drive` sets the host's cancel
	// flag, which makes a blocked stdin read return EOF, and drops the runner,
	// which fails any later `spawn_command`; the utility unwinds cleanly
	// (flushing what it already produced) and the blocking task completes.
	// The blocking thread cannot be dropped, so it is always awaited: no
	// detached thread keeps writing to the builtin's descriptors.
	let code = drive(spec, cancel, cancel_flag, runner, async { handle.await.ok() }, false).await;
	Ok(ExecutionResult::new((code & 0xff) as u8))
}

/// Drives an [`AsyncUtility`] from raw arguments to an exit status, awaiting
/// its body on the shell task.
async fn run_async_utility<U: AsyncUtility, SE: ShellExtensions>(
	context: ExecutionContext<'_, SE>,
	argv: Vec<String>,
) -> Result<ExecutionResult, Error> {
	let spec = Spec::of_async::<U>();
	let Prepared { parsed, mut host, runner, cancel, cancel_flag, _cancel_on_drop } =
		match prepare::<U, SE>(context, argv, spec) {
			Ok(prepared) => prepared,
			Err(done) => return done,
		};

	// On cancel the body is dropped, which cancels whatever it awaits.
	let body = async { Some(run_caught_async::<U>(parsed, &mut host).await) };
	let code = drive(spec, cancel, cancel_flag, runner, body, true).await;
	Ok(ExecutionResult::new((code & 0xff) as u8))
}

/// A utility ready to run: parsed arguments, its host, and the adapter's
/// cancellation and command-serving state.
struct Prepared<P, SE: ShellExtensions> {
	parsed:           P,
	host:             Host,
	runner:           Option<CommandRunner<SE>>,
	cancel:           Option<CancellationToken>,
	cancel_flag:      Arc<AtomicBool>,
	_cancel_on_drop:  CancelOnDrop,
}

/// Rewrites and parses `argv` and builds the host. `Err` carries the finished
/// result when the invocation ends early (usage error, `--help`, host failure).
///
/// Everything owned is captured here, before the caller's first await, so its
/// future stays `Send`: the borrowed `ExecutionContext` (and its `&mut Shell`)
/// is dropped on return.
fn prepare<P: clap::Parser, SE: ShellExtensions>(
	context: ExecutionContext<'_, SE>,
	argv: Vec<String>,
	spec: Spec,
) -> Result<Prepared<P, SE>, Result<ExecutionResult, Error>> {
	let argv: Vec<OsString> = argv.into_iter().map(OsString::from).collect();

	let argv = match (spec.rewrite_argv)(argv) {
		Ok(argv) => argv,
		Err(message) => {
			let _ = writeln!(context.stderr(), "{}: {message}", spec.name);
			return Err(Ok(ExecutionResult::new(spec.usage_error)));
		},
	};

	let parsed = match P::try_parse_from(&argv) {
		Ok(parsed) => parsed,
		Err(err) => {
			// clap reports `--help` and `--version` as errors; those belong on
			// stdout with a success status, everything else on stderr.
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(context.stderr(), "{rendered}");
				return Err(Ok(ExecutionResult::new(spec.usage_error)));
			}
			let _ = write!(context.stdout(), "{rendered}");
			return Err(Ok(ExecutionResult::success()));
		},
	};

	let mut host = build_host(&context, spec).map_err(Err)?;
	let cancel = context.cancel_token();
	let cancel_flag = host.cancel_flag();
	let cancel_on_drop = CancelOnDrop(Arc::clone(&cancel_flag));
	let runner = spec.runs_commands.then(|| {
		let (sender, requests) = flume::unbounded();
		host.commands = Some(sender);
		CommandRunner::new(&context, requests)
	});
	Ok(Prepared { parsed, host, runner, cancel, cancel_flag, _cancel_on_drop: cancel_on_drop })
}

/// Awaits `body` (`None` when its task failed) while serving the utility's
/// command requests and watching for the shell's cancellation, returning the
/// exit status the adapter reports.
///
/// A cancelled body is awaited to its end unless `abandon` drops it instead
/// (an async body is cancelled by being dropped). Commands already running
/// are awaited either way, so none keeps writing to the builtin's (possibly
/// redirected) descriptors.
async fn drive<SE: ShellExtensions>(
	spec: Spec,
	cancel: Option<CancellationToken>,
	cancel_flag: Arc<AtomicBool>,
	mut runner: Option<CommandRunner<SE>>,
	body: impl Future<Output = Option<i32>>,
	abandon: bool,
) -> i32 {
	let mut body = pin!(body);
	let cancelled = async {
		match &cancel {
			Some(token) => token.cancelled().await,
			None => std::future::pending().await,
		}
	};
	tokio::pin!(cancelled);
	let mut running = FuturesUnordered::new();
	loop {
		tokio::select! {
			biased;
			() = &mut cancelled => {
				cancel_flag.store(true, Ordering::Relaxed);
				drop(runner.take());
				if abandon && !spec.owns_cancellation {
					drain(&mut running).await;
					break final_status(false, true, None);
				}
				let (result, ()) = tokio::join!(&mut body, drain(&mut running));
				break final_status(spec.owns_cancellation, true, result);
			},
			Some(shell) = running.next(), if !running.is_empty() => {
				if let Some(runner) = runner.as_mut() {
					runner.release(shell);
				}
			},
			result = &mut body => {
				// Commands the utility started but never waited for.
				drain(&mut running).await;
				// If the token already fired, a blocking body only finished
				// because our cancel flag unblocked it: report interrupted.
				let interrupted = cancel.as_ref().is_some_and(CancellationToken::is_cancelled);
				break final_status(spec.owns_cancellation, interrupted, result);
			},
			Some(request) = next_request(runner.as_ref()) => {
				if let Some(runner) = runner.as_mut() {
					running.push(runner.start(request));
				}
			},
		}
	}
}

/// Reports a failed drain of the files the utility left to close: the first
/// error is printed and turns a zero `code` into 1.
fn closes_status(host: &mut Host, closes: io::Result<()>, code: i32) -> i32 {
	match closes {
		Ok(()) => code,
		Err(error) => {
			host.error(error, 1);
			if code == 0 { 1 } else { code }
		},
	}
}

/// The exit status the adapter reports: 130 for a cancelled utility, unless
/// it owns its cancellation ([`Utility::OWNS_CANCELLATION`]); otherwise the
/// body's status (1 when the body task itself failed).
fn final_status(owns_cancellation: bool, cancelled: bool, body: Option<i32>) -> i32 {
	if cancelled && !owns_cancellation { 130 } else { body.unwrap_or(1) }
}

/// Runs every command in `running` to completion.
async fn drain<F: Future>(running: &mut FuturesUnordered<F>) {
	while running.next().await.is_some() {}
}

/// The next [`Host::spawn_command`] request, or `None` once the utility has
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
	let _scope = PanicScope::enter();
	let outcome = catch_unwind(AssertUnwindSafe(|| parsed.run(host)));
	settle(U::NAME, outcome, host)
}

/// [`run_caught`] for an [`AsyncUtility`]: the panic scope covers each poll of
/// the body, which may resume on another thread, and the body's closes are
/// drained afterwards.
///
/// All output the body left pending is delivered before the status is
/// settled, so a closed reader still ends it with [`SIGPIPE_EXIT_CODE`]; a
/// cancelled command delivers nothing more.
async fn run_caught_async<U: AsyncUtility>(parsed: U, host: &mut Host) -> i32 {
	let outcome = {
		let body = AssertUnwindSafe(async { parsed.run(host).await }).catch_unwind();
		let mut body = pin!(body);
		poll_fn(|cx| {
			let _scope = PanicScope::enter();
			body.as_mut().poll(cx)
		})
		.await
	};
	let write_failed = match host.drain_output(true).await {
		Err(error) if !host.sigpipe_hit() => {
			host.error(format!("write error: {}", strip_errno(&error)), 1);
			true
		},
		_ => false,
	};
	let code = settle(U::NAME, outcome, host);
	let code = if write_failed && code == 0 { 1 } else { code };
	let closes = host.vfs().drain_closes().await;
	let code = closes_status(host, closes, code);
	let _ = host.drain_output(true).await;
	if host.sigpipe_hit() { SIGPIPE_EXIT_CODE } else { code }
}

/// Marks the current thread as inside a utility body for [`panic_scope_active`].
struct PanicScope;

impl PanicScope {
	fn enter() -> Self {
		PANIC_SCOPE_DEPTH.update(|depth| depth + 1);
		Self
	}
}

impl Drop for PanicScope {
	fn drop(&mut self) {
		PANIC_SCOPE_DEPTH.update(|depth| depth.saturating_sub(1));
	}
}

/// The status of a finished body: [`SIGPIPE_EXIT_CODE`] when a guarded stream
/// hit a closed reader, 1 with a note after a panic, else the body's own.
fn settle(name: &str, outcome: std::thread::Result<i32>, host: &mut Host) -> i32 {
	if host.sigpipe_hit() {
		return SIGPIPE_EXIT_CODE;
	}
	match outcome {
		Ok(code) => code,
		Err(_) => {
			let _ = writeln!(host.stderr, "{name}: internal error");
			1
		},
	}
}

/// Snapshots the command's streams, working directory, and exported
/// environment into an owned [`Host`] that can move to a blocking thread.
fn build_host<SE: ShellExtensions>(context: &ExecutionContext<'_, SE>, spec: Spec) -> Result<Host, Error> {
	let Spec { name, checks_stdout_path, owns_cancellation, async_io, .. } = spec;
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
	let command_cancel = CommandCancel {
		flag:     Arc::clone(&cancel),
		token:    context.cancel_token(),
		silences: !owns_cancellation,
	};

	let stdout = or_null(context.try_fd(OpenFiles::STDOUT_FD))?;
	let stdout_handle = if checks_stdout_path { output_handle(&stdout) } else { None };
	let stderr_file = or_null(context.try_fd(OpenFiles::STDERR_FD))?;
	// Classified before the SIGPIPE guard wraps them: the guard is an opaque
	// stream, so a file behind it can no longer be told from a pipe on
	// Windows, and one sample per stream serves every writer below.
	let stdout_destination = Destination::of(&stdout);
	let stderr_destination = Destination::of(&stderr_file);
	let sigpipe = Arc::new(Sigpipe::default());
	// `2>&1` (and the default capture pipe): one shared writer keeps
	// diagnostics and output in exact write order. It carries stdout output,
	// so it takes the stdout guard: once the reader is gone every write fails
	// and nothing is observable either way.
	//
	// An async utility's writers never touch a descriptor: they append to
	// memory-backed `AsyncOut`s that the host drains asynchronously.
	let mut async_out = None;
	let (merged_out, stderr) = if stdout_destination.shares_with(&stderr_destination) {
		if async_io {
			let out = async_out_for(
				stderr_file,
				GuardedStream::Stdout,
				stderr_destination.regular_file,
				&sigpipe,
				&command_cancel,
			);
			async_out = Some(AsyncStreams { stdout: out.clone(), stderr: out.clone() });
			(None, StreamWriter::Async(out))
		} else {
			let guarded = SigpipeGuard::wrap(stderr_file, GuardedStream::Stdout, &sigpipe, &command_cancel);
			let shared =
				Arc::new(Mutex::new(StreamWriter::new(guarded, stderr_destination.regular_file)));
			(Some(Arc::clone(&shared)), StreamWriter::Shared(shared))
		}
	} else if async_io {
		let out = async_out_for(
			stderr_file,
			GuardedStream::Stderr,
			stderr_destination.regular_file,
			&sigpipe,
			&command_cancel,
		);
		let stdout_out = async_out_for(
			stdout.clone(),
			GuardedStream::Stdout,
			stdout_destination.regular_file,
			&sigpipe,
			&command_cancel,
		);
		async_out = Some(AsyncStreams { stdout: stdout_out, stderr: out.clone() });
		(None, StreamWriter::Async(out))
	} else {
		let guarded = SigpipeGuard::wrap(stderr_file, GuardedStream::Stderr, &sigpipe, &command_cancel);
		(None, StreamWriter::new(guarded, stderr_destination.regular_file))
	};
	let stdout = SigpipeGuard::wrap(stdout, GuardedStream::Stdout, &sigpipe, &command_cancel);

	Ok(Host {
		stdin: Stdin {
			file:   or_null(stdin)?,
			fd:     stdin_fd,
			cancel: command_cancel,
		},
		stdout,
		stderr,
		stdout_is_file: stdout_destination.regular_file,
		stdout_handle,
		stdout_metadata: OnceLock::new(),
		umask: OnceLock::new(),
		name: invoked,
		paths: ShellPaths::new(context),
		env,
		cancel,
		exit_code: 0,
		stdin_is_search_input,
		merged_out,
		sigpipe,
		commands: None,
		reported_error: context.params.reported_error().cloned(),
		async_out,
		stdin_source: None,
	})
}

/// The memory-backed output for `file`, a standard stream with `stream`'s
/// SIGPIPE and cancellation rules: provider files are written through their
/// async API, descriptors once the reactor reports them writable (see
/// [`AsyncOut`]).
fn async_out_for(
	file: OpenFile,
	stream: GuardedStream,
	regular_file: bool,
	sigpipe: &Arc<Sigpipe>,
	cancel: &CommandCancel,
) -> AsyncOut {
	let gate = OutputGate::new(stream, sigpipe, cancel);
	match file {
		OpenFile::Vfs(file) => AsyncOut::provider(file, gate),
		file => {
			let guarded = SigpipeGuard::wrap(file, stream, sigpipe, cancel);
			AsyncOut::native(guarded, regular_file, gate)
		},
	}
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
		Arc, AtomicBool, CommandCancel, GuardedStream, HashMap, Host, OpenFile, OpenFiles, OsString,
		PathBuf, Read, ShellPaths, Sigpipe, SigpipeGuard, Stdin, StreamWriter, Utility, Write, io, openfiles,
		output_handle, run_caught,
		AsyncStreams, AsyncUtility, Spec, async_out_for, run_caught_async,
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
			String::from_utf8_lossy_owned(self.stdout())
		}

		/// Stderr as a lossy string, for readable assertions.
		pub fn err(&self) -> String {
			String::from_utf8_lossy_owned(self.stderr())
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
			Self::for_test_streams(name, stdin, cwd, false, false)
		}

		/// [`Host::for_test`] for an async utility: output is memory-backed and
		/// reaches the [`Capture`] once drained (see [`Host::flush_output`]).
		pub(crate) fn for_test_async(
			name: &str,
			stdin: impl Into<Vec<u8>>,
			cwd: impl Into<PathBuf>,
		) -> (Self, Capture) {
			Self::for_test_streams(name, Box::new(MemStream::reader(stdin.into())), cwd, false, true)
		}

		/// [`Host::for_test`] for a utility that owns its cancellation
		/// ([`Utility::OWNS_CANCELLATION`]): writes after cancellation survive.
		pub(crate) fn for_test_owning(
			name: &str,
			stdin: impl Into<Vec<u8>>,
			cwd: impl Into<PathBuf>,
		) -> (Self, Capture) {
			Self::for_test_streams(name, Box::new(MemStream::reader(stdin.into())), cwd, true, false)
		}

		fn for_test_streams(
			name: &str,
			stdin: Box<dyn openfiles::Stream>,
			cwd: impl Into<PathBuf>,
			owns_cancellation: bool,
			async_io: bool,
		) -> (Self, Capture) {
			let capture = Capture {
				stdout: Arc::new(Mutex::new(Vec::new())),
				stderr: Arc::new(Mutex::new(Vec::new())),
			};
			let cancel = Arc::new(AtomicBool::new(false));
			let sigpipe = Arc::new(Sigpipe::default());
			let command_cancel =
				CommandCancel { flag: Arc::clone(&cancel), token: None, silences: !owns_cancellation };
			let stdout = OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&capture.stdout))));
			let stderr = OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&capture.stderr))));
			let async_out = async_io.then(|| AsyncStreams {
				stdout: async_out_for(stdout.clone(), GuardedStream::Stdout, false, &sigpipe, &command_cancel),
				stderr: async_out_for(stderr.clone(), GuardedStream::Stderr, false, &sigpipe, &command_cancel),
			});
			let stderr_writer = match &async_out {
				Some(streams) => StreamWriter::Async(streams.stderr.clone()),
				None => StreamWriter::line(SigpipeGuard::wrap(
					stderr,
					GuardedStream::Stderr,
					&sigpipe,
					&command_cancel,
				)),
			};
			let host = Self {
				stdin:                 Stdin {
					file:   OpenFile::Stream(stdin),
					fd:     None,
					cancel: command_cancel.clone(),
				},
				stdout:                SigpipeGuard::wrap(
					stdout,
					GuardedStream::Stdout,
					&sigpipe,
					&command_cancel,
				),
				stderr:                stderr_writer,
				stdout_is_file:        false,
				stdout_handle:         None,
				stdout_metadata:       Default::default(),
				umask:                 Default::default(),
				name:                  name.to_string(),
				paths:                 ShellPaths::with_cwd(cwd),
				env:                   HashMap::new(),
				cancel,
				exit_code:             0,
				stdin_is_search_input: false,
				merged_out:            None,
				sigpipe,
				commands:              None,
				reported_error:        None,
				async_out,
				stdin_source:          None,
			};
			(host, capture)
		}

		/// Replaces stdout on a test host, classifying and guarding it like
		/// the stream [`build_host`](super::build_host) installs. Tests that
		/// model a departed reader (`… | head`) hand in the write end of a
		/// pipe whose read end is already dropped.
		pub(crate) fn set_test_stdout(&mut self, file: OpenFile) {
			self.stdout_is_file = super::Destination::of(&file).regular_file;
			self.stdout_handle = output_handle(&file);
			self.stdout_metadata.take();
			let command_cancel = self.stdin.cancel.clone();
			if let Some(streams) = &mut self.async_out {
				streams.stdout = async_out_for(
					file.clone(),
					GuardedStream::Stdout,
					self.stdout_is_file,
					&self.sigpipe,
					&command_cancel,
				);
			}
			self.stdout = SigpipeGuard::wrap(file, GuardedStream::Stdout, &self.sigpipe, &command_cancel);
		}

		/// Replaces stdin on a test host with a native descriptor, classified
		/// like the one [`build_host`](super::build_host) installs.
		pub(crate) fn set_test_stdin(&mut self, file: OpenFile) {
			self.stdin.fd = super::pollable_fd(&file);
			self.stdin.file = file;
			self.stdin_source = None;
		}

		/// Sets an exported variable on a test host.
		pub(crate) fn set_test_var(&mut self, key: &str, value: &str) {
			self.env.insert(key.to_string(), value.to_string());
		}

		/// Requests cancellation on a test host.
		pub(crate) fn cancel_for_test(&self) {
			self.cancel.store(true, super::Ordering::Relaxed);
		}

		/// The cancellation flag of a test host, for a test that cancels
		/// from another thread while a utility runs.
		pub(crate) fn cancel_flag_for_test(&self) -> Arc<AtomicBool> {
			Arc::clone(&self.cancel)
		}
	}

	/// `poll` never reports the null device readable on macOS and the BSDs, so
	/// a utility whose stdin is `/dev/null` (the bash tool wires it there)
	/// waited for cancellation before it saw EOF. Stdin from a pipe still polls.
	#[cfg(unix)]
	#[test]
	fn stdin_from_the_null_device_is_not_polled() {
		let null = openfiles::null().unwrap();
		assert_eq!(super::pollable_fd(&null), None);
		let (reader, _writer) = std::io::pipe().unwrap();
		assert!(super::pollable_fd(&OpenFile::from(reader)).is_some());
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
		let spec = Spec::of_sync::<U>();
		let (mut host, capture) = test_host(spec, stdin, cwd);
		let code = match parse_for_test::<U>(spec, argv, &mut host) {
			Ok(parsed) => run_caught::<U>(parsed, &mut host),
			Err(code) => code,
		};
		(code, capture)
	}

	/// [`run_util`] for an [`AsyncUtility`]: the body is awaited in place and
	/// its output drained into the [`Capture`] before it returns.
	pub(crate) async fn run_async_util<U: AsyncUtility>(
		argv: &[&str],
		stdin: &str,
		cwd: impl Into<PathBuf>,
	) -> (i32, Capture) {
		let spec = Spec::of_async::<U>();
		let (mut host, capture) = test_host(spec, stdin, cwd);
		let code = match parse_for_test::<U>(spec, argv, &mut host) {
			Ok(parsed) => run_caught_async::<U>(parsed, &mut host).await,
			Err(code) => code,
		};
		let _ = host.drain_output(true).await;
		(code, capture)
	}

	/// An in-memory host for a utility with `spec`.
	fn test_host(spec: Spec, stdin: &str, cwd: impl Into<PathBuf>) -> (Host, Capture) {
		if spec.async_io {
			Host::for_test_async(spec.name, stdin.as_bytes().to_vec(), cwd)
		} else if spec.owns_cancellation {
			Host::for_test_owning(spec.name, stdin.as_bytes().to_vec(), cwd)
		} else {
			Host::for_test(spec.name, stdin.as_bytes().to_vec(), cwd)
		}
	}

	/// Rewrites and parses `argv` as the adapter does; `Err` is the exit status
	/// of an invocation that ends before the body (usage error, `--help`).
	fn parse_for_test<P: clap::Parser>(spec: Spec, argv: &[&str], host: &mut Host) -> Result<P, i32> {
		let full: Vec<OsString> = std::iter::once(OsString::from(spec.name))
			.chain(argv.iter().map(OsString::from))
			.collect();
		let full = match (spec.rewrite_argv)(full) {
			Ok(full) => full,
			Err(message) => {
				let _ = writeln!(host.stderr, "{}: {message}", spec.name);
				return Err(i32::from(spec.usage_error));
			},
		};
		P::try_parse_from(&full).map_err(|err| {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(host.stderr, "{rendered}");
				i32::from(spec.usage_error)
			} else {
				let _ = write!(host.stdout, "{rendered}");
				0
			}
		})
	}

	/// Writes `small` holding `needle` and a sparse `big` twice the line limit
	/// of `grep` and `rg`, with no line terminator and no disk space used.
	#[cfg(all(unix, feature = "util.grep"))]
	pub(crate) fn tree_with_sparse_file() -> tempfile::TempDir {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("small"), "needle\n").unwrap();
		let big = std::fs::File::create(tree.path().join("big")).unwrap();
		big.set_len(2 * crate::grep::MAX_LINE_BYTES as u64).unwrap();
		tree
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
	/// appending writer over a shared buffer that can also record each
	/// `write` call separately.
	#[derive(Clone)]
	struct MemStream {
		input:  Arc<Mutex<io::Cursor<Vec<u8>>>>,
		output: Arc<Mutex<Vec<u8>>>,
		writes: Option<Arc<Mutex<Vec<Vec<u8>>>>>,
	}

	impl MemStream {
		fn reader(data: Vec<u8>) -> Self {
			Self {
				input:  Arc::new(Mutex::new(io::Cursor::new(data))),
				output: Arc::new(Mutex::new(Vec::new())),
				writes: None,
			}
		}

		fn writer(output: Arc<Mutex<Vec<u8>>>) -> Self {
			Self { input: Arc::new(Mutex::new(io::Cursor::new(Vec::new()))), output, writes: None }
		}

		/// A writer that keeps every `write` call's bytes as one entry.
		fn recording(writes: Arc<Mutex<Vec<Vec<u8>>>>) -> Self {
			Self { writes: Some(writes), ..Self::writer(Arc::default()) }
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
			if let Some(writes) = &self.writes {
				writes.lock().push(buf.to_vec());
			}
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
		use crate::host::{Arc, Destination, Host, OpenFile, StreamWriter, Write};

		/// Contract: on a non-file destination, a completed line is visible to
		/// the consumer before any explicit flush; a partial line is held back.
		#[test]
		fn line_policy_flushes_completed_lines_immediately() {
			let buf = Arc::new(Mutex::new(Vec::new()));
			let stream = OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&buf))));
			let regular_file = Destination::of(&stream).regular_file;
			let mut out = StreamWriter::new(stream, regular_file);
			assert!(matches!(out, StreamWriter::Line(_)));

			out.write_all(b"hit\n").unwrap();
			assert_eq!(buf.lock().as_slice(), b"hit\n");

			out.write_all(b"partial").unwrap();
			assert_eq!(buf.lock().as_slice(), b"hit\n");

			out.flush().unwrap();
			assert_eq!(buf.lock().as_slice(), b"hit\npartial");
		}

		/// Contract: a line written in pieces (`write!` with several
		/// arguments) reaches a line-buffered destination as one write, so a
		/// reader never sees half a line.
		#[test]
		fn line_policy_writes_a_piecewise_line_once() {
			let writes = Arc::new(Mutex::new(Vec::new()));
			let stream = OpenFile::Stream(Box::new(MemStream::recording(Arc::clone(&writes))));
			let mut out = StreamWriter::line(stream);
			write!(out, "{:>6}\t", 1).unwrap();
			writeln!(out, "{}", "content").unwrap();
			assert_eq!(*writes.lock(), vec![b"     1\tcontent\n".to_vec()]);
		}

		/// Contract: a regular-file stdout stays block-buffered behind the
		/// SIGPIPE guard — bytes reach the file only on flush, not per line.
		#[test]
		fn regular_file_stdout_gets_block_buffering() {
			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("out.txt");
			let file = std::fs::File::create(&path).unwrap();
			let (mut host, _) = Host::for_test("cat", "", ".");
			host.set_test_stdout(OpenFile::File(file));
			let mut out = host.stdout_writer();
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
			let file = OpenFile::File(std::fs::File::from(std::os::fd::OwnedFd::from(writer)));
			assert!(!Destination::of(&file).regular_file);
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
			let shared = |a: &OpenFile, b: &OpenFile| Destination::of(a).shares_with(&Destination::of(b));

			let (reader, writer) = std::io::pipe().unwrap();
			let dup = writer.try_clone().unwrap();
			let a = OpenFile::File(std::fs::File::from(std::os::fd::OwnedFd::from(writer)));
			let b = OpenFile::File(std::fs::File::from(std::os::fd::OwnedFd::from(dup)));
			assert!(shared(&a, &b));

			let (reader2, writer2) = std::io::pipe().unwrap();
			let c = OpenFile::File(std::fs::File::from(std::os::fd::OwnedFd::from(writer2)));
			assert!(!shared(&a, &c));

			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("out.txt");
			let f1 = OpenFile::File(std::fs::File::create(&path).unwrap());
			let f2 = OpenFile::File(std::fs::File::create(&path).unwrap());
			assert!(!shared(&f1, &f2));

			drop((reader, reader2));
		}
	}

	#[cfg(unix)]
	mod native_descriptors {
		use std::io::{Read, Write};

		use crate::host::{Host, OpenFile};

		/// Contract: reading a pipe waits for its writer without holding the
		/// runtime thread; a blocking read would deadlock this current-thread
		/// runtime, whose only thread is the one that must write.
		#[tokio::test(flavor = "current_thread")]
		async fn stdin_pipe_read_waits_for_a_later_writer() {
			let (mut host, _capture) = Host::for_test_async("reader", "", "/");
			let (reader, mut writer) = std::io::pipe().unwrap();
			host.set_test_stdin(OpenFile::from(reader));

			let mut buf = [0; 16];
			let read = host.read_stdin(&mut buf);
			let write = async {
				tokio::task::yield_now().await;
				writer.write_all(b"later").unwrap();
			};
			let (count, ()) = tokio::join!(read, write);
			assert_eq!(&buf[..count.unwrap()], b"later");

			drop(writer);
			assert_eq!(host.read_stdin(&mut buf).await.unwrap(), 0);
		}

		/// Contract: `read_stdin_to_end` over a pipe collects what the writer
		/// sends later and ends at its close.
		#[tokio::test(flavor = "current_thread")]
		async fn stdin_pipe_read_to_end_collects_late_writes() {
			let (mut host, _capture) = Host::for_test_async("reader", "", "/");
			let (reader, mut writer) = std::io::pipe().unwrap();
			host.set_test_stdin(OpenFile::from(reader));

			let mut bytes = Vec::new();
			let read = host.read_stdin_to_end(&mut bytes, usize::MAX);
			let write = async {
				tokio::task::yield_now().await;
				writer.write_all(b"one ").unwrap();
				tokio::task::yield_now().await;
				writer.write_all(b"two").unwrap();
				drop(writer);
			};
			let (count, ()) = tokio::join!(read, write);
			assert_eq!(count.unwrap(), 7);
			assert_eq!(bytes, b"one two");
		}

		/// Contract: a drain larger than the pipe waits for its reader instead
		/// of blocking; every byte arrives in order.
		#[tokio::test(flavor = "current_thread")]
		async fn drain_to_a_pipe_waits_for_a_slow_reader() {
			let (mut host, _capture) = Host::for_test_async("writer", "", "/");
			let (mut reader, writer) = std::io::pipe().unwrap();
			host.set_test_stdout(OpenFile::from(writer));
			let collector = std::thread::spawn(move || {
				let mut bytes = Vec::new();
				reader.read_to_end(&mut bytes).unwrap();
				bytes
			});

			let payload: Vec<u8> = (0..2_000_000_u32).map(|n| u8::try_from(n % 251).unwrap()).collect();
			let mut out = host.stdout_writer();
			out.write_all(&payload).unwrap();
			host.flush_output().await.unwrap();
			drop(out);
			drop(host);

			assert_eq!(collector.join().unwrap(), payload);
		}
	}

	mod async_stdio {
		use parking_lot::Mutex;

		use super::MemStream;
		use crate::host::{
			Arc, AsyncUtility, AtomicBool, CommandCancel, GuardedStream, Host, OpenFile, Sigpipe, StreamWriter,
			Write, async_out_for, run_caught_async,
		};

		/// Writes a line to stdout and a note to stderr, knowing nothing of
		/// descriptors or pipes.
		#[derive(clap::Parser)]
		struct Chatty;

		impl AsyncUtility for Chatty {
			const NAME: &'static str = "chatty";

			async fn run(self, host: &mut Host) -> i32 {
				let mut out = host.stdout_writer();
				let _ = writeln!(out, "line");
				let _ = writeln!(host.stderr, "chatty: note");
				0
			}
		}

		/// Contract for `2>&1`: handles onto one `AsyncOut` deliver in exact
		/// write order, and nothing reaches the destination before a drain.
		#[tokio::test]
		async fn merged_streams_keep_write_order() {
			let buf = Arc::new(Mutex::new(Vec::new()));
			let sigpipe = Arc::new(Sigpipe::default());
			let cancel =
				CommandCancel { flag: Arc::new(AtomicBool::new(false)), token: None, silences: true };
			let out = async_out_for(
				OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&buf)))),
				GuardedStream::Stdout,
				false,
				&sigpipe,
				&cancel,
			);
			let mut stdout = StreamWriter::Async(out.clone());
			let mut stderr = StreamWriter::Async(out.clone());

			writeln!(stdout, "out 1").unwrap();
			writeln!(stderr, "err 1").unwrap();
			writeln!(stdout, "out 2").unwrap();
			assert_eq!(buf.lock().as_slice(), b"");

			out.drain(false).await.unwrap();
			assert_eq!(buf.lock().as_slice(), b"out 1\nerr 1\nout 2\n");
		}

		/// Contract: a reader that is gone by the final drain ends the utility
		/// with the SIGPIPE status, and its stderr output is discarded.
		#[cfg(unix)]
		#[tokio::test]
		async fn closed_reader_in_the_final_drain_yields_141_and_silences_stderr() {
			let (mut host, capture) = Host::for_test_async("chatty", "", "/");
			let (reader, writer) = std::io::pipe().unwrap();
			drop(reader);
			host.set_test_stdout(OpenFile::from(writer));

			let code = run_caught_async::<Chatty>(Chatty, &mut host).await;

			assert_eq!(code, crate::host::SIGPIPE_EXIT_CODE);
			assert_eq!(capture.err(), "");
		}

		/// Contract: output written once the command is cancelled is dropped,
		/// while what was delivered before stays delivered.
		#[tokio::test]
		async fn output_after_cancellation_is_dropped() {
			let (host, capture) = Host::for_test_async("chatty", "", "/");
			let mut out = host.stdout_writer();
			let mut err = StreamWriter::Async(match &host.async_out {
				Some(streams) => streams.stderr.clone(),
				None => unreachable!("an async test host has memory-backed output"),
			});

			writeln!(out, "before").unwrap();
			host.flush_output().await.unwrap();
			assert_eq!(capture.out(), "before\n");

			host.cancel_for_test();
			writeln!(out, "after").unwrap();
			writeln!(err, "diagnostic").unwrap();
			host.flush_output().await.unwrap();

			assert_eq!(capture.out(), "before\n");
			assert_eq!(capture.err(), "");
		}
	}

	mod cancellation {
		use crate::host::{Host, Utility, Write, final_status, run_caught};

		/// Reports its cancellation on stderr and exits 20, like a process that
		/// catches SIGTERM.
		#[derive(clap::Parser)]
		struct Catcher;

		impl Utility for Catcher {
			const NAME: &'static str = "catcher";
			const OWNS_CANCELLATION: bool = true;

			fn run(self, host: &mut Host) -> i32 {
				while !host.is_cancelled() {
					std::thread::yield_now();
				}
				let _ = writeln!(host.stderr, "catcher: received SIGTERM (code 20)");
				let _ = host.stderr.flush();
				20
			}
		}

		/// The same body without owning cancellation: killed silently.
		#[derive(clap::Parser)]
		struct Plain;

		impl Utility for Plain {
			const NAME: &'static str = "plain";

			fn run(self, host: &mut Host) -> i32 {
				while !host.is_cancelled() {
					std::thread::yield_now();
				}
				let _ = writeln!(host.stderr, "plain: interrupted");
				let _ = host.stderr.flush();
				20
			}
		}

		/// Contract: a default utility is cancelled like a killed process,
		/// with status 130 and nothing printed after the cancellation.
		#[test]
		fn default_utility_is_silenced_and_reports_130() {
			let (mut host, capture) = Host::for_test("plain", "", "/");
			host.cancel_for_test();
			let code = run_caught::<Plain>(Plain, &mut host);
			assert_eq!(capture.err(), "");
			assert_eq!(final_status(Plain::OWNS_CANCELLATION, true, Some(code)), 130);
		}

		/// Contract: a utility that owns its cancellation reports its own
		/// status, and its final diagnostics reach stderr.
		#[test]
		fn owning_utility_reports_its_own_status_and_text() {
			let (mut host, capture) = Host::for_test_owning("catcher", "", "/");
			host.cancel_for_test();
			let code = run_caught::<Catcher>(Catcher, &mut host);
			assert_eq!(capture.err(), "catcher: received SIGTERM (code 20)\n");
			assert_eq!(final_status(Catcher::OWNS_CANCELLATION, true, Some(code)), 20);
			// Uncancelled runs keep the body's status either way.
			assert_eq!(final_status(false, false, Some(3)), 3);
			assert_eq!(final_status(true, false, None), 1);
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
pub(crate) use testing::{Capture, run_async_util, run_script, run_util};
#[cfg(all(test, unix, feature = "util.grep"))]
pub(crate) use testing::tree_with_sparse_file;

