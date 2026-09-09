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
//! 1. materializes process-substitution arguments (`diff <(a) <(b)`) into real
//!    file descriptors,
//! 2. parses `argv`, rendering `--help`/`--version` on stdout and usage errors
//!    on stderr with the utility's own exit status,
//! 3. runs the body on a blocking thread, so a slow utility never stalls the
//!    async runtime and concurrent pipeline stages stay isolated,
//! 4. observes the shell's cancellation token (abort/`timeout`), and
//! 5. contains panics at the builtin boundary instead of taking down the
//!    long-lived host process.

use std::{
	cell::Cell,
	ffi::OsString,
	future::Future,
	io::{self, BufWriter, LineWriter, Read, Write},
	marker::PhantomData,
	panic::{AssertUnwindSafe, catch_unwind},
	path::{Path, PathBuf},
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};
#[cfg(unix)]
use std::{ffi::OsStr, os::fd};

use bytes::Bytes;
use im::HashMap;
use omp_core::Str;
use omp_shell::{
	Error, ExecutionContext, ExecutionResult, PathPolicy, ProcessScope, ShellExtensions,
	SpawnObserver, SpawnWrapper,
	builtins::{self, Registration},
	openfiles::{self, OpenFile, OpenFiles},
	sys::fs,
};
#[cfg(test)]
use omp_shell::{OpenRequest, PathAccess, PathDenied};
use omp_tool::Diag;
use parking_lot::Mutex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// A boxed dynamic-device host operation.
///
/// Device discovery and invocation are cold I/O boundaries, so one boxed
/// future per shell command keeps the host trait object-safe without affecting
/// interpreter hot paths.
pub type DynFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, DynFault>> + Send + 'a>>;

/// One live operation advertised by the dynamic-device host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DynDevice {
	/// Canonical `namespace/tool` invocation name.
	pub name:        Str,
	/// Concise operation description used for discovery search.
	pub description: Option<Str>,
}

/// The JSON schema and documentation for one dynamic operation.
#[derive(Clone, Debug, PartialEq)]
pub struct DynSchema {
	/// Canonical `namespace/tool` invocation name.
	pub name:        Str,
	/// Concise operation description.
	pub description: Option<Str>,
	/// JSON Schema describing the operation's argument object.
	pub schema:      Value,
}

/// One dynamic operation result plus out-of-band harness diagnostics.
#[derive(Clone, Debug, PartialEq)]
pub struct DynCallOutput {
	/// Successful output written to stdout by the builtin.
	pub output: DynOutput,
	/// Structured harness notices that must not be written to stdout.
	pub diags:  Vec<Diag>,
}

impl From<DynOutput> for DynCallOutput {
	fn from(output: DynOutput) -> Self {
		Self { output, diags: Vec::new() }
	}
}

/// A successful dynamic operation result.
///
/// The builtin writes every variant to stdout: plain and Markdown text
/// verbatim, JSON compact, image blobs as terminal graphics passthrough
/// ([`crate::graphics::encode_image_passthrough`]) and other blobs as raw
/// bytes, so `dyn tts … > speech.mp3` and `dyn image_gen …` both compose with
/// redirection.
#[derive(Clone, Debug, PartialEq)]
pub enum DynOutput {
	/// Plain text written directly to stdout.
	Text(Str),
	/// Markdown text. Shell composition writes the source bytes unchanged;
	/// direct presentation consumers may render the semantic form.
	Markdown(Str),
	/// Structured output serialized as JSON on stdout.
	Json(Value),
	/// Binary media with its MIME type.
	Blob {
		/// MIME type of `bytes`.
		mime:  Str,
		/// Exact media bytes.
		bytes: Bytes,
	},
	/// Several outputs written in order; text, JSON, and media may mix.
	Parts(Vec<DynOutput>),
}

/// A host-reported operation fault rendered by the builtin.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DynFault {
	/// User-facing fault detail.
	pub message: Str,
}

impl DynFault {
	/// Creates a fault from host-owned diagnostic text.
	pub fn new(message: impl Into<Str>) -> Self {
		Self { message: message.into() }
	}
}

/// Environment capability behind the stable in-process `dyn` builtin.
///
/// Implementations own their catalogs and invocation authority. The shell only
/// maps JSON schemas to CLI arguments; it never mutates the model-facing tool
/// roster or starts an external command.
pub trait DynHost: Send + Sync + 'static {
	/// Returns the complete live catalog.
	fn list(&self) -> DynFuture<'_, Vec<DynDevice>>;

	/// Returns the current schema for one exact live operation.
	fn schema(&self, name: &str) -> DynFuture<'_, DynSchema>;

	/// Invokes one operation with schema-shaped JSON arguments and the shell
	/// command's cancellation token.
	fn call(
		&self,
		name: &str,
		args: Value,
		cancel: CancellationToken,
	) -> DynFuture<'_, DynCallOutput>;
}

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
	/// Standard output; the null device when fd 1 is closed. Utilities with
	/// progressive output buffer it through [`Host::stdout_writer`].
	pub stdout: OpenFile,
	/// Standard error, buffered according to its destination; the null device
	/// when fd 2 is closed. When fd 2 shares fd 1's destination, both streams
	/// serialize through one writer so `2>&1` preserves write order.
	pub stderr: StreamWriter,

	name:                  String,
	cwd:                   PathBuf,
	env:                   HashMap<String, String>,
	path_policy:           Option<Arc<dyn PathPolicy>>,
	spawn_wrapper:         Option<Arc<dyn SpawnWrapper>>,
	process_scope:         Option<Arc<dyn ProcessScope>>,
	spawn_observer:        Option<Arc<dyn SpawnObserver>>,
	cancel:                Arc<AtomicBool>,
	exit_code:             i32,
	stdin_is_search_input: bool,
	/// Shared stdout/stderr writer when both descriptors target one
	/// non-seekable destination.
	merged_out:            Option<Arc<Mutex<StreamWriter>>>,
}

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Relaxed);
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
		&self.cwd
	}

	/// Resolves `path` against [`Host::cwd`]; absolute paths pass through.
	///
	/// Every path argument must go through this before touching the
	/// filesystem: the host process's current directory is unrelated to the
	/// shell's.
	pub fn resolve(&self, path: impl AsRef<Path>) -> PathBuf {
		let normalized_path = fs::normalize_shell_path(path.as_ref());
		let path = normalized_path.as_ref();
		if path.is_absolute() {
			path.to_path_buf()
		} else {
			self.cwd.join(path)
		}
	}

	/// Resolves a user-named write path and admits it through the installed
	/// policy.
	pub fn ensure_writable(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
		let path = self.resolve(path);
		if let Some(policy) = &self.path_policy {
			policy.check_write(&path).map_err(io::Error::other)?;
		}
		Ok(path)
	}

	/// Returns the installed write-path policy.
	pub fn path_policy(&self) -> Option<&Arc<dyn PathPolicy>> {
		self.path_policy.as_ref()
	}

	/// Returns whether this builtin is running behind a kernel sandbox launcher.
	pub fn kernel_sandbox_active(&self) -> bool {
		self
			.spawn_wrapper
			.as_ref()
			.is_some_and(|wrapper| wrapper.launcher().is_some())
	}

	/// Returns whether the active process scope permits observing `pid`.
	pub fn may_observe(&self, pid: i32) -> bool {
		self
			.process_scope
			.as_ref()
			.is_none_or(|scope| scope.may_observe(pid))
	}

	/// Returns whether the active process scope permits signalling `pid`.
	pub fn may_signal(&self, pid: i32) -> bool {
		self
			.process_scope
			.as_ref()
			.is_none_or(|scope| scope.may_signal(pid))
	}

	/// Records a child spawned internally by this utility.
	pub fn observe_spawn(&self, pid: u32) {
		if let (Some(observer), Ok(pid)) = (&self.spawn_observer, i32::try_from(pid)) {
			observer.on_spawn(pid, None);
		}
	}

	/// Builds a child command with the sandbox launcher prefix when installed.
	pub fn command(&self, program: impl AsRef<ffi::OsStr>) -> process::Command {
		let program = program.as_ref();
		let mut command = if let Some((launcher, prefix)) = self
			.spawn_wrapper
			.as_ref()
			.and_then(|wrapper| wrapper.launcher())
		{
			let mut command = process::Command::new(launcher);
			command.args(prefix).arg(program);
			command
		} else {
			process::Command::new(program)
		};
		command.current_dir(&self.cwd).env_clear();
		if let Some(wrapper) = &self.spawn_wrapper {
			let mut environment: Vec<_> = self
				.env
				.iter()
				.map(|(key, value)| (OsString::from(key), OsString::from(value)))
				.collect();
			wrapper.resolve_env(&mut environment);
			command.envs(environment);
		} else {
			command.envs(self.env());
		}
		command
	}

	/// Iterates the exported shell variables captured for this utility
	/// invocation.
	///
	/// The shell's exported variables are *not* present in the host process
	/// environment, so `std::env::var` would miss them.
	pub fn env(&self) -> impl Iterator<Item = (&str, &str)> {
		self
			.env
			.iter()
			.map(|(key, value)| (key.as_str(), value.as_str()))
	}

	/// Looks up one exported shell variable.
	pub fn var(&self, key: &str) -> Option<&str> {
		self.env.get(key).map(String::as_str)
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

	/// Whether stdin is a shell pipe or custom stream, and so should be treated
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

	/// Writes `<name>: <message>` to stderr and records exit status `code`.
	pub fn error(&mut self, message: impl Display, code: i32) {
		tracing::warn!(builtin = self.name.as_str(), exit_code = code, "builtin operation failed");
		let _ = writeln!(self.stderr, "{}: {message}", self.name);
		self.fail(code);
	}

	/// Duplicates stdout, for utilities that hand a writer to a helper thread.
	pub fn stdout_clone(&self) -> OpenFile {
		self.stdout.clone()
	}

	/// Duplicates stderr as a raw [`OpenFile`], for utilities that hand a
	/// writer to a helper thread. Any partial line buffered by this handle is
	/// not copied.
	pub fn stderr_clone(&self) -> OpenFile {
		self.stderr.dup_file()
	}

	/// Returns a buffered stdout whose policy follows fd 1's destination.
	///
	/// Regular files use block buffering. Pipes, captures, terminals, and
	/// custom streams use line buffering so complete lines are observable
	/// while the utility is still running.
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
			cwd:            self.cwd.clone(),
			env:            Arc::new(
				self
					.env
					.iter()
					.map(|(k, v)| (k.clone(), v.clone()))
					.collect(),
			),
			stderr:         self.stderr.dup_file(),
			wrapper:        self.spawn_wrapper.clone(),
			spawn_observer: self.spawn_observer.clone(),
			process_scope:  self.process_scope.clone(),
		}
	}

	/// Runs `command` with stdin from the null device and stdout/stderr piped
	/// back into this host's streams, returning the child's exit status.
	///
	/// The host's streams are in-process `Write` handles (pipes or in-memory
	/// buffers), not inheritable descriptors, and the process's own fd 0/1/2
	/// belong to the TUI — a child must never inherit stdio. Child stdout
	/// streams through on the calling thread while a helper thread drains
	/// stderr into a buffer, which is forwarded once the child exits.
	///
	/// Callers must construct the command through [`Host::command`] so its
	/// directory, environment policy, and launcher prefix are already installed.
	pub fn run_captured(
		&mut self,
		command: &mut process::Command,
	) -> io::Result<process::ExitStatus> {
		command
			.stdin(process::Stdio::null())
			.stdout(process::Stdio::piped())
			.stderr(process::Stdio::piped());
		let mut child = command.spawn()?;
		self.observe_spawn(child.id());

		let mut child_err = child.stderr.take();
		let stderr_thread = thread::spawn(move || {
			let mut buf = Vec::new();
			if let Some(err) = child_err.as_mut() {
				let _ = err.read_to_end(&mut buf);
			}
			buf
		});

		if let Some(mut out) = child.stdout.take() {
			let _ = io::copy(&mut out, &mut self.stdout);
		}
		let status = child.wait();
		if let Ok(buf) = stderr_thread.join() {
			let _ = self.stderr.write_all(&buf);
		}
		status
	}
}
/// A destination-aware buffered writer for utility output.
///
/// The standard library writers own and recycle their buffers for the
/// lifetime of this value: writes do not allocate scratch storage per call.
/// A shared variant serializes stdout and stderr through that same owned
/// buffer when shell redirection merges the descriptors.
pub(crate) enum StreamWriter {
	/// Block-buffered output for regular files.
	Block(BufWriter<OpenFile>),
	/// Line-buffered output for pipes, captures, terminals, and streams.
	Line(LineWriter<OpenFile>),
	/// Serialized access to a writer shared by stdout and stderr.
	Shared(Arc<Mutex<StreamWriter>>),
}

impl StreamWriter {
	const BLOCK_CAPACITY: usize = 64 * 1024;
	const LINE_CAPACITY: usize = 16 * 1024;

	/// Selects block buffering for a regular file and line buffering otherwise.
	pub fn new(file: OpenFile) -> Self {
		if is_regular_file(&file) {
			Self::block(file)
		} else {
			Self::line(file)
		}
	}

	/// Forces line buffering regardless of destination.
	pub fn line(file: OpenFile) -> Self {
		Self::Line(LineWriter::with_capacity(Self::LINE_CAPACITY, file))
	}

	/// Forces block buffering regardless of destination.
	pub fn block(file: OpenFile) -> Self {
		Self::Block(BufWriter::with_capacity(Self::BLOCK_CAPACITY, file))
	}

	/// Duplicates the underlying descriptor without copying buffered bytes.
	pub fn dup_file(&self) -> OpenFile {
		match self {
			Self::Block(writer) => writer.get_ref().clone(),
			Self::Line(writer) => writer.get_ref().clone(),
			Self::Shared(shared) => shared.lock().dup_file(),
		}
	}

	/// Reports whether the destination is a terminal.
	pub fn is_terminal(&self) -> bool {
		match self {
			Self::Block(writer) => writer.get_ref().is_terminal(),
			Self::Line(writer) => writer.get_ref().is_terminal(),
			Self::Shared(shared) => shared.lock().is_terminal(),
		}
	}
}

impl Write for StreamWriter {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Self::Block(writer) => writer.write(buf),
			Self::Line(writer) => writer.write(buf),
			Self::Shared(shared) => shared.lock().write(buf),
		}
	}

	fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
		match self {
			Self::Block(writer) => writer.write_all(buf),
			Self::Line(writer) => writer.write_all(buf),
			Self::Shared(shared) => shared.lock().write_all(buf),
		}
	}

	fn write_fmt(&mut self, args: fmt::Arguments<'_>) -> io::Result<()> {
		match self {
			Self::Block(writer) => writer.write_fmt(args),
			Self::Line(writer) => writer.write_fmt(args),
			Self::Shared(shared) => shared.lock().write_fmt(args),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::Block(writer) => writer.flush(),
			Self::Line(writer) => writer.flush(),
			Self::Shared(shared) => shared.lock().flush(),
		}
	}

	fn write_vectored(&mut self, bufs: &[io::IoSlice<'_>]) -> io::Result<usize> {
		match self {
			Self::Block(writer) => writer.write_vectored(bufs),
			Self::Line(writer) => writer.write_vectored(bufs),
			Self::Shared(shared) => shared.lock().write_vectored(bufs),
		}
	}
}

/// Returns whether `file` is a regular file suitable for block buffering.
///
/// A pipe wrapped in [`std::fs::File`] reports a FIFO file type, while an
/// uninspectable destination safely falls back to line buffering.
pub(crate) fn is_regular_file(file: &OpenFile) -> bool {
	match file {
		OpenFile::File(file) => file.metadata().is_ok_and(|metadata| metadata.is_file()),
		_ => false,
	}
}

/// Returns whether two descriptors share one non-seekable destination.
///
/// Regular files are excluded because separate opens have independent offsets,
/// even when their device and inode match.
#[cfg(unix)]
fn same_destination(a: &OpenFile, b: &OpenFile) -> bool {
	use std::{fs, os::unix::fs::MetadataExt};

	fn identity(file: &OpenFile) -> Option<(u64, u64)> {
		let fd = file.try_borrow_as_fd().ok()?;
		let owned = fd.try_clone_to_owned().ok()?;
		let metadata = fs::File::from(owned).metadata().ok()?;
		if metadata.file_type().is_file() {
			return None;
		}
		Some((metadata.dev(), metadata.ino()))
	}

	match (identity(a), identity(b)) {
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
	cwd:            PathBuf,
	env:            Arc<Vec<(String, String)>>,
	stderr:         OpenFile,
	wrapper:        Option<Arc<dyn SpawnWrapper>>,
	spawn_observer: Option<Arc<dyn SpawnObserver>>,
	process_scope:  Option<Arc<dyn ProcessScope>>,
}

impl ChildEnv {
	/// Builds a `Command` for `program` with the shell's working directory and
	/// environment, and with stderr piped.
	///
	/// Stdin and stdout are left untouched for the caller to wire; they default
	/// to inherited, so a caller that leaves them alone MUST redirect them.
	pub fn command(&self, program: impl AsRef<ffi::OsStr>) -> process::Command {
		let program = program.as_ref();
		let mut command = if let Some((launcher, prefix)) =
			self.wrapper.as_ref().and_then(|wrapper| wrapper.launcher())
		{
			let mut command = process::Command::new(launcher);
			command.args(prefix).arg(program);
			command
		} else {
			process::Command::new(program)
		};
		command
			.current_dir(&self.cwd)
			.env_clear()
			.stderr(process::Stdio::piped());
		if let Some(wrapper) = &self.wrapper {
			let mut environment: Vec<_> = self
				.env
				.iter()
				.map(|(key, value)| (OsString::from(key), OsString::from(value)))
				.collect();
			wrapper.resolve_env(&mut environment);
			command.envs(environment);
		} else {
			command.envs(self.env.iter().map(|(key, value)| (key, value)));
		}
		command
	}

	/// Drains a child's piped stderr into the command's standard error on a
	/// helper thread.
	///
	/// The returned handle should be joined once the child has exited, so the
	/// diagnostic lands before the utility reports its own result. Dropping the
	/// handle detaches the thread, which is only correct if nothing downstream
	/// depends on the ordering.
	pub fn forward_stderr(&self, mut child_stderr: process::ChildStderr) -> thread::JoinHandle<()> {
		let mut stderr = self.stderr.clone();
		thread::spawn(move || {
			let _ = io::copy(&mut child_stderr, &mut stderr);
		})
	}

	/// Records a child spawned through this environment.
	pub fn observe_spawn(&self, pid: u32) {
		if let (Some(observer), Ok(pid)) = (&self.spawn_observer, i32::try_from(pid)) {
			observer.on_spawn(pid, None);
		}
	}

	/// Returns whether the active process scope permits signalling `pid`.
	pub fn may_signal(&self, pid: u32) -> bool {
		i32::try_from(pid).is_ok_and(|pid| {
			self
				.process_scope
				.as_ref()
				.is_none_or(|scope| scope.may_signal(pid))
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
	/// The underlying open file, for utilities that need to inspect fd 0
	/// (`is_terminal`) or hand it to a child process.
	pub const fn file(&self) -> &OpenFile {
		&self.file
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
pub(crate) fn os_bytes(value: &ffi::OsStr) -> Option<&[u8]> {
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
/// anything unrepresentable. For diagnostics, where losing a byte beats
/// failing.
pub(crate) fn os_bytes_lossy(value: &ffi::OsStr) -> borrow::Cow<'_, [u8]> {
	match os_bytes(value) {
		Some(bytes) => borrow::Cow::Borrowed(bytes),
		None => borrow::Cow::Owned(value.to_string_lossy().into_owned().into_bytes()),
	}
}

/// Parses a GNU-style duration: a decimal number with an optional
/// `s`/`m`/`h`/`d` suffix, as accepted by `sleep` and `timeout`.
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

/// Returns the [`Registration`] for a [`Utility`].
pub(crate) fn util<U: Utility, SE: ShellExtensions>() -> Registration<SE> {
	builtins::builtin::<Util<U>, SE>()
}

/// Adapter turning a [`Utility`] into a brush builtin.
///
/// Holds the raw argument vector rather than a parsed `U`: process-substitution
/// arguments can only be materialized once the shell is in hand, which happens
/// in [`builtins::Command::execute`], and parse failures must be reported on
/// the utility's own terms (help on stdout, usage errors with the utility's
/// exit status) rather than through brush's generic usage-error path.
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
	#[cfg_attr(not(unix), expect(unused_mut, reason = "rewritten only on unix"))]
	let mut argv: Vec<OsString> = argv.into_iter().map(OsString::from).collect();
	#[cfg(unix)]
	let process_substitution_fds = materialize_process_substitution_fds(&context, &mut argv)?;

	let argv = match U::rewrite_argv(argv) {
		Ok(argv) => argv,
		Err(message) => {
			tracing::warn!(builtin = U::NAME, "builtin argument rewrite failed");
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
				tracing::warn!(
					builtin = U::NAME,
					error_kind = ?err.kind(),
					"builtin arguments rejected"
				);
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
	drop(context);

	let mut handle = task::spawn_blocking(move || {
		#[cfg(unix)]
		let _process_substitution_fds = process_substitution_fds;
		run_caught::<U>(parsed, &mut host)
	});

	// Respect shell abort/`timeout`. On cancel we set the host's cancel flag,
	// which makes a blocked stdin read return EOF; the utility unwinds cleanly
	// (flushing what it already produced) and the blocking task completes. We
	// await that completion before returning so no detached thread keeps
	// writing to the command's (possibly redirected) descriptors.
	let code = match cancel {
		Some(token) => {
			let token_check = token.clone();
			tokio::select! {
				biased;
				() = token.cancelled() => {
					cancel_flag.store(true, Ordering::Relaxed);
					let _ = resolve_builtin_task::<U>((&mut handle).await);
					130
				},
				result = &mut handle => {
					// If the token already fired, the task only finished because
					// our cancel flag unblocked it — report interrupted.
					if token_check.is_cancelled() {
						130
					} else {
						resolve_builtin_task::<U>(result)
					}
				},
			}
		},
		None => resolve_builtin_task::<U>(handle.await),
	};

	Ok(ExecutionResult::new((code & 0xff) as u8))
}

fn resolve_builtin_task<U: Utility>(result: Result<i32, task::JoinError>) -> i32 {
	match result {
		Ok(code) => code,
		Err(error) => {
			tracing::error!(
				builtin = U::NAME,
				cancelled = error.is_cancelled(),
				"builtin worker task failed"
			);
			1
		},
	}
}

/// Runs a utility body, containing any panic at the builtin boundary.
///
/// A port that panics (an `unwrap` on a `BrokenPipe`, say) must not take down
/// the long-lived host process. With `panic = "unwind"` the panic unwinds to
/// here, where it becomes a non-zero exit plus a concise note on the command's
/// own stderr.
pub(crate) fn run_caught<U: Utility>(parsed: U, host: &mut Host) -> i32 {
	struct Guard;
	impl Drop for Guard {
		fn drop(&mut self) {
			PANIC_SCOPE_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
		}
	}
	PANIC_SCOPE_DEPTH.with(|depth| depth.set(depth.get() + 1));
	let _guard = Guard;

	match catch_unwind(AssertUnwindSafe(|| parsed.run(host))) {
		Ok(code) => code,
		Err(_) => {
			tracing::error!(builtin = U::NAME, "builtin panicked");
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
	// On unix, capture the raw stdin fd so reads can poll it for cancellation;
	// the `OpenFile` is kept alive by the `Stdin` below, so the fd stays valid.
	#[cfg(unix)]
	let stdin_fd: Option<i32> = {
		use std::os::fd::AsRawFd;
		stdin
			.as_ref()
			.and_then(|file| file.try_borrow_as_fd().ok())
			.map(|fd| fd.as_raw_fd())
	};
	#[cfg(not(unix))]
	let stdin_fd: Option<i32> = None;
	let stdin_is_search_input = stdin
		.as_ref()
		.is_some_and(|file| matches!(file, OpenFile::PipeReader(_) | OpenFile::Stream(_)));

	let mut env = HashMap::new();
	for (key, var) in context.shell.env().iter_exported() {
		if var.value().is_set() {
			env.insert(key.clone(), var.value().to_cow_str(context.shell).into_owned());
		}
	}
	let spawn_wrapper = context.params.spawn_wrapper().cloned();

	let invoked = if context.command_name.is_empty() {
		name.to_string()
	} else {
		context.command_name.clone()
	};

	// One flag, shared: the adapter flips it on cancellation, and a blocked
	// `Stdin::read` must observe the very same flag or it never wakes.
	let cancel = Arc::new(AtomicBool::new(false));

	let stdout = or_null(context.try_fd(OpenFiles::STDOUT_FD))?;
	let stderr_file = or_null(context.try_fd(OpenFiles::STDERR_FD))?;
	let (merged_out, stderr) = if same_destination(&stdout, &stderr_file) {
		let shared = Arc::new(Mutex::new(StreamWriter::new(stderr_file)));
		(Some(Arc::clone(&shared)), StreamWriter::Shared(shared))
	} else {
		(None, StreamWriter::new(stderr_file))
	};

	Ok(Host {
		stdin: Stdin { file: or_null(stdin)?, fd: stdin_fd, cancel: Arc::clone(&cancel) },
		stdout,
		stderr,
		name: invoked,
		cwd: context.shell.working_dir().to_path_buf(),
		env,
		path_policy: context.params.path_policy().cloned(),
		spawn_wrapper,
		process_scope: context.params.process_scope().cloned(),
		spawn_observer: context.params.spawn_observer().cloned(),
		cancel,
		exit_code: 0,
		stdin_is_search_input,
		merged_out,
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

/// Recognizes brush's process-substitution arguments (`/dev/fd/<shell fd>`).
#[cfg(unix)]
fn process_substitution_fd(arg: &OsStr) -> Option<omp_shell::ShellFd> {
	arg.to_str()?
		.strip_prefix("/dev/fd/")?
		.parse::<omp_shell::ShellFd>()
		.ok()
}

/// Rewrites `/dev/fd/<shell fd>` arguments to real descriptors of the host
/// process, returning the owned descriptors that must stay alive for the
/// duration of the utility.
///
/// Brush allocates process-substitution pipes in its own descriptor table, so
/// the shell fd number in the argument is meaningless to `open`.
#[cfg(unix)]
fn materialize_process_substitution_fds<SE: ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	argv: &mut [OsString],
) -> Result<Vec<fd::OwnedFd>, Error> {
	use std::os::fd::AsRawFd;

	let mut fds = Vec::new();
	for arg in argv {
		let Some(shell_fd) = process_substitution_fd(arg) else {
			continue;
		};
		let Some(file) = context.try_fd(shell_fd) else {
			continue;
		};
		let fd = file.try_borrow_as_fd()?.try_clone_to_owned()?;
		*arg = OsString::from(format!("/dev/fd/{}", fd.as_raw_fd()));
		fds.push(fd);
	}
	Ok(fds)
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

	use std::iter;
	#[cfg(unix)]
	use std::os::fd;

	use omp_shell::error;
	use parking_lot::Mutex;

	use super::{
		Arc, AtomicBool, Error, HashMap, Host, OpenFile, OpenRequest, Ordering, OsString, PathAccess,
		PathBuf, PathDenied, PathPolicy, Read, SpawnWrapper, Stdin, StreamWriter, Utility, Write, io,
		openfiles, run_caught,
	};

	/// Test policy admitting writes only beneath one root.
	pub(crate) struct ScopedPathPolicy {
		root: PathBuf,
	}

	impl ScopedPathPolicy {
		/// Creates a policy admitting `root` and its descendants.
		pub(crate) fn new(root: impl AsRef<std::path::Path>) -> Self {
			Self { root: root.as_ref().to_path_buf() }
		}
	}

	impl PathPolicy for ScopedPathPolicy {
		fn check_read(&self, path: &std::path::Path) -> Result<(), PathDenied> {
			if path.starts_with(&self.root) {
				Ok(())
			} else {
				Err(PathDenied { path: path.to_path_buf(), access: PathAccess::Read })
			}
		}

		fn check_write(&self, path: &std::path::Path) -> Result<(), PathDenied> {
			if path.starts_with(&self.root) {
				Ok(())
			} else {
				Err(PathDenied { path: path.to_path_buf(), access: PathAccess::Write })
			}
		}

		fn open(
			&self,
			path: &std::path::Path,
			request: OpenRequest,
		) -> Result<std::fs::File, PathDenied> {
			let access = request.access;
			if !path.starts_with(&self.root) {
				return Err(PathDenied { path: path.to_path_buf(), access });
			}
			std::fs::File::options()
				.read(matches!(access, PathAccess::Read | PathAccess::ReadWrite))
				.write(!matches!(access, PathAccess::Read))
				.create(!matches!(access, PathAccess::Read))
				.truncate(matches!(access, PathAccess::Truncate))
				.append(matches!(access, PathAccess::Append))
				.create_new(matches!(access, PathAccess::CreateNew))
				.open(path)
				.map_err(|_| PathDenied { path: path.to_path_buf(), access })
		}
	}
	struct TestSpawnWrapper {
		prefix: Vec<OsString>,
	}

	impl SpawnWrapper for TestSpawnWrapper {
		fn launcher(&self) -> Option<(&std::ffi::OsStr, &[OsString])> {
			Some((std::ffi::OsStr::new("/fake-wrapper"), &self.prefix))
		}

		fn env_allowed(&self, key: &str) -> bool {
			key != "SECRET"
		}
	}

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

		/// Shares stdout's backing buffer for mid-execution observations.
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
			Self::for_test_with_stdin(name, Box::new(MemStream::reader(stdin.into())), cwd)
		}

		/// Builds a host backed by arbitrary in-memory stdin.
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
			let host = Self {
				stdin: Stdin {
					file:   OpenFile::Stream(stdin),
					fd:     None,
					cancel: Arc::clone(&cancel),
				},
				stdout: OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&capture.stdout)))),
				stderr: StreamWriter::new(OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(
					&capture.stderr,
				))))),
				name: name.to_string(),
				cwd: cwd.into(),
				env: HashMap::new(),
				path_policy: None,
				spawn_wrapper: None,
				process_scope: None,
				spawn_observer: None,
				cancel,
				exit_code: 0,
				stdin_is_search_input: false,
				merged_out: None,
			};
			(host, capture)
		}

		/// Sets an exported variable on a test host.
		pub(crate) fn set_test_var(&mut self, key: &str, value: &str) {
			self.env.insert(key.to_string(), value.to_string());
		}

		/// Installs a write-path policy on a test host.
		pub(crate) fn set_test_path_policy(&mut self, policy: Arc<dyn PathPolicy>) {
			self.path_policy = Some(policy);
		}

		/// Installs a child spawn wrapper on a test host.
		pub(crate) fn set_test_spawn_wrapper(&mut self, wrapper: Arc<dyn SpawnWrapper>) {
			self.spawn_wrapper = Some(wrapper);
		}

		/// Requests cancellation on a test host.
		pub(crate) fn cancel_for_test(&self) {
			self.cancel.store(true, Ordering::Relaxed);
		}
	}
	#[test]
	fn child_command_applies_wrapper_prefix_and_environment_filter() {
		let (mut host, _) = Host::for_test("test", "", "/");
		host.set_test_var("KEEP", "yes");
		host.set_test_var("SECRET", "no");
		host.set_test_spawn_wrapper(Arc::new(TestSpawnWrapper {
			prefix: vec![OsString::from("--capture")],
		}));

		let command = host.command("/bin/echo");
		assert_eq!(command.get_program(), std::ffi::OsStr::new("/fake-wrapper"));
		assert_eq!(command.get_args().collect::<Vec<_>>(), [
			std::ffi::OsStr::new("--capture"),
			std::ffi::OsStr::new("/bin/echo")
		]);
		assert!(command.get_envs().any(|(key, value)| {
			key == std::ffi::OsStr::new("KEEP") && value == Some(std::ffi::OsStr::new("yes"))
		}));
		assert!(
			!command
				.get_envs()
				.any(|(key, _)| key == std::ffi::OsStr::new("SECRET"))
		);
	}

	#[cfg(windows)]
	#[test]
	fn resolves_msys_drive_aliases_to_native_drive() {
		let (host, _) = Host::for_test("test", "", r"C:\workspace");

		assert_eq!(host.resolve("/c/Users/Adam/file.txt"), PathBuf::from(r"C:\Users\Adam\file.txt"));
	}

	/// Parses `argv` and runs `U` against an in-memory host, mirroring what the
	/// registered builtin does: `argv[0]` is the command name, clap failures are
	/// reported the same way, and panics are contained.
	pub(crate) fn run_util<U: Utility>(
		argv: &[&str],
		stdin: &str,
		cwd: impl Into<PathBuf>,
	) -> (i32, Capture) {
		run_util_inner::<U>(argv, stdin, cwd.into(), None)
	}

	/// Runs a utility with a write-path policy installed on its host.
	pub(crate) fn run_util_with_policy<U: Utility>(
		argv: &[&str],
		stdin: &str,
		cwd: impl Into<PathBuf>,
		policy: Arc<dyn PathPolicy>,
	) -> (i32, Capture) {
		run_util_inner::<U>(argv, stdin, cwd.into(), Some(policy))
	}

	fn run_util_inner<U: Utility>(
		argv: &[&str],
		stdin: &str,
		cwd: PathBuf,
		policy: Option<Arc<dyn PathPolicy>>,
	) -> (i32, Capture) {
		let (mut host, capture) = Host::for_test(U::NAME, stdin.as_bytes().to_vec(), cwd);
		if let Some(policy) = policy {
			host.set_test_path_policy(policy);
		}
		let full: Vec<OsString> = iter::once(OsString::from(U::NAME))
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
		fn try_clone_to_owned(&self) -> Result<fd::OwnedFd, Error> {
			Err(error::ErrorKind::CannotConvertToNativeFd.into())
		}

		#[cfg(unix)]
		fn try_borrow_as_fd(&self) -> Result<fd::BorrowedFd<'_>, Error> {
			Err(error::ErrorKind::CannotConvertToNativeFd.into())
		}
	}

	mod stdout_policy {
		use std::fs;
		#[cfg(unix)]
		use std::{io, os::fd};

		use super::{Arc, MemStream, Mutex, OpenFile, StreamWriter, Write};

		#[test]
		fn non_file_flushes_complete_lines_without_flushing_partials() {
			let buffer = Arc::new(Mutex::new(Vec::new()));
			let stream = OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&buffer))));
			let mut out = StreamWriter::new(stream);
			assert!(matches!(out, StreamWriter::Line(_)));

			out.write_all(b"hit\n").unwrap();
			assert_eq!(buffer.lock().as_slice(), b"hit\n");

			out.write_all(b"partial").unwrap();
			assert_eq!(buffer.lock().as_slice(), b"hit\n");

			out.flush().unwrap();
			assert_eq!(buffer.lock().as_slice(), b"hit\npartial");
		}

		#[test]
		fn regular_file_is_block_buffered() {
			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("out.txt");
			let file = fs::File::create(&path).unwrap();
			let mut out = StreamWriter::new(OpenFile::File(file));
			assert!(matches!(out, StreamWriter::Block(_)));

			out.write_all(b"hit\n").unwrap();
			assert_eq!(fs::read(&path).unwrap(), b"");

			out.flush().unwrap();
			assert_eq!(fs::read(&path).unwrap(), b"hit\n");
		}

		#[cfg(unix)]
		#[test]
		fn pipe_wrapped_as_file_is_line_buffered() {
			let (reader, writer) = io::pipe().unwrap();
			let file = fs::File::from(fd::OwnedFd::from(writer));
			assert!(matches!(StreamWriter::new(OpenFile::File(file)), StreamWriter::Line(_)));
			drop(reader);
		}

		#[test]
		fn shared_handles_preserve_write_order() {
			let buffer = Arc::new(Mutex::new(Vec::new()));
			let inner =
				StreamWriter::line(OpenFile::Stream(Box::new(MemStream::writer(Arc::clone(&buffer)))));
			let shared = Arc::new(Mutex::new(inner));
			let mut out = StreamWriter::Shared(Arc::clone(&shared));
			let mut err = StreamWriter::Shared(shared);

			writeln!(out, "out 1").unwrap();
			writeln!(err, "err 1").unwrap();
			writeln!(out, "out 2").unwrap();

			assert_eq!(buffer.lock().as_slice(), b"out 1\nerr 1\nout 2\n");
		}

		#[cfg(unix)]
		#[test]
		fn same_destination_detects_duplicated_pipe_only() {
			use crate::host::same_destination;

			let (reader, writer) = io::pipe().unwrap();
			let duplicate = writer.try_clone().unwrap();
			let a = OpenFile::File(fs::File::from(fd::OwnedFd::from(writer)));
			let b = OpenFile::File(fs::File::from(fd::OwnedFd::from(duplicate)));
			assert!(same_destination(&a, &b));

			let (other_reader, other_writer) = io::pipe().unwrap();
			let other = OpenFile::File(fs::File::from(fd::OwnedFd::from(other_writer)));
			assert!(!same_destination(&a, &other));

			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("out.txt");
			let first = OpenFile::File(fs::File::create(&path).unwrap());
			let second = OpenFile::File(fs::File::create(&path).unwrap());
			assert!(!same_destination(&first, &second));

			drop((reader, other_reader));
		}
	}
}

use std::{borrow, ffi, fmt, fmt::Display, process, thread};

#[cfg(test)]
#[allow(unused_imports, reason = "used by utility test modules, which are feature-gated")]
pub(crate) use testing::{Capture, ScopedPathPolicy, run_util, run_util_with_policy};
use tokio::task;
