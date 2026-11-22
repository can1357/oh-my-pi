//! Session commands: names a host installs for one run.
//!
//! Each name is a command of its own during that
//! [`Shell::run`](crate::Shell::run). It resolves after the shell's builtins,
//! pi's shell tools and in-process utilities, and before shell functions,
//! aliases and `PATH` ([`crate::extras`] has the whole order).
//!
//! While a name is installed, a function or alias of that name does not run
//! in its place: the parser leaves such an alias unexpanded, a simple command
//! skips such a function, and `type`/`command -v` report the session command.
//! Other names, and the same names in runs that do not install them, keep
//! their functions and aliases.
//!
//! - Every invocation is one [`SessionCommandHandler::call`] on the session's
//!   runtime, awaited without blocking a thread; several may be in flight
//!   (pipeline stages, `&` jobs). The engine polls it like an extra, so
//!   pipelines, redirections, substitutions, subshells, functions, background
//!   jobs and the tools that run command lines (`timeout`, `xargs`, `env`,
//!   `find -exec`) all reach it.
//! - Stdin is read to end of file, as UTF-8 of at most [`STDIN_LIMIT_BYTES`],
//!   only when an argument is a bare `-`; otherwise the command never touches
//!   it, so `echo x | cmd arg` and `cmd arg` inside a `while read` loop leave
//!   the input to its reader. Stdin it cannot pass on fails the command with
//!   status 2.
//! - The reply's stdout and stderr are written to the command's own fds 1 and
//!   2; its exit code, clamped to `0..=255`, is the command's status. A failed
//!   call reports `NAME: <reason>` on stderr with status 1.
//! - A `TERM`, `INT`, `KILL`, `HUP` or `QUIT` cancels the command like an extra
//!   (status 130), and the reply of the call it abandons is ignored.
//! - The commands are scoped to one `Shell::run`: once it ends, calls in flight
//!   end and later ones fail with status 1 without reaching the handler (a
//!   background job that outlived its run), and the names no longer resolve.

use std::{
	fmt,
	future::poll_fn,
	io,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::Mutex;
use strum::IntoEnumIterator;
use tokio_util::sync::CancellationToken;

use crate::{
	bash::{Dialect, FdRef, IntrinsicId, Invocation, NativeRef, Signal, Task},
	extras::{self, Done},
};

/// Largest stdin a session command passes to its handler, in bytes.
pub const STDIN_LIMIT_BYTES: usize = 16 * 1024 * 1024;

/// First [`NativeRef`] of a session command: refs from here up (below
/// [`extras::SUSPEND`]) index the run's sorted names.
const FIRST_REF: u64 = 1 << 62;

/// Status of a command cancelled by a signal: pi's, as for an extra.
const CANCELLED: i32 = 130;

/// Status of a command whose stdin cannot be passed on.
const BAD_STDIN: i32 = 2;

/// Status of a failed call.
const FAILED: i32 = 1;

/// Read size of stdin.
const READ_CHUNK: usize = 64 * 1024;

/// One invocation of a session command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionCommandRequest {
	/// Command name as invoked.
	pub name:  String,
	/// Arguments after the command name.
	pub argv:  Vec<String>,
	/// The shell's working directory at invocation time (a `scheme://` URL
	/// when the shell is in one).
	pub cwd:   String,
	/// Stdin read to end of file when an argument is a bare `-`; empty
	/// otherwise.
	pub stdin: String,
}

/// What a session command writes and the status it ends with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionCommandResult {
	/// Written to the command's stdout.
	pub stdout:    String,
	/// Written to the command's stderr.
	pub stderr:    String,
	/// The command's status, clamped to `0..=255`.
	pub exit_code: i32,
}

/// The future of one [`SessionCommandHandler::call`]: the result, or the
/// reason the call failed.
pub type SessionCommandFuture =
	Pin<Box<dyn Future<Output = Result<SessionCommandResult, String>> + Send>>;

/// Serves the session commands of a run.
pub trait SessionCommandHandler: Send + Sync {
	/// Serve `request`. Dropping the future abandons the call.
	///
	/// # Errors
	///
	/// The reason the call failed; the command reports it on stderr with
	/// status 1.
	fn call(&self, request: SessionCommandRequest) -> SessionCommandFuture;
}

/// Commands a host provides for one run, and the handler serving them.
///
/// Cheap to clone; clones share the names and the handler.
#[derive(Clone)]
pub struct SessionCommands {
	/// Sorted, without duplicates: a session command's [`NativeRef`] is
	/// [`FIRST_REF`] plus its index.
	names:   Arc<[BString]>,
	handler: Arc<dyn SessionCommandHandler>,
	/// Cancelled once the run these commands belong to ended ([`RunLease`]).
	ended:   CancellationToken,
}

impl fmt::Debug for SessionCommands {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("SessionCommands")
			.field("names", &self.names)
			.finish_non_exhaustive()
	}
}

impl SessionCommands {
	/// The commands `names`, each served by `handler`.
	pub fn new(
		names: impl IntoIterator<Item = String>,
		handler: Arc<dyn SessionCommandHandler>,
	) -> Self {
		let mut names: Vec<BString> = names.into_iter().map(BString::from).collect();
		names.sort_unstable();
		names.dedup();
		Self { names: names.into(), handler, ended: CancellationToken::new() }
	}

	/// The [`NativeRef`] of the command `name`, if it is one of these.
	pub(crate) fn lookup(&self, name: &BStr) -> Option<NativeRef> {
		let index = self
			.names
			.binary_search_by(|probe| probe.as_bstr().cmp(name))
			.ok()?;
		u64::try_from(index)
			.ok()
			.and_then(|index| FIRST_REF.checked_add(index))
			.map(NativeRef)
	}

	/// Start the command `cmd` ([`SessionCommands::lookup`]) for `inv` on
	/// `runtime`.
	///
	/// # Errors
	///
	/// `NotFound` when `cmd` is none of these commands.
	pub(crate) fn start(
		&self,
		runtime: &tokio::runtime::Handle,
		cmd: NativeRef,
		inv: Invocation<'_>,
	) -> io::Result<CommandTask> {
		let name = command_index(cmd)
			.and_then(|index| self.names.get(index))
			.ok_or(io::ErrorKind::NotFound)?
			.to_str_lossy()
			.into_owned();
		let argv: Vec<String> = inv
			.argv
			.iter()
			.skip(1)
			.map(|arg| arg.to_str_lossy().into_owned())
			.collect();
		let [stdin, stdout, stderr] = inv.stdio;
		let stdin = argv.iter().any(|arg| arg == "-").then_some(stdin);
		let cancel = CancellationToken::new();
		let call = Call {
			name,
			argv,
			cwd: inv.cwd.to_str_lossy().into_owned(),
			stdin,
			stdout,
			stderr,
			handler: Arc::clone(&self.handler),
			ended: self.ended.clone(),
			cancel: cancel.clone(),
		};
		Ok(CommandTask { done: extras::spawn_status(runtime, call.run()), cancel })
	}
}

/// The session commands of the run in flight, which the host resolves and
/// the tools that run command lines ([`crate::tools`]) run in-process.
///
/// Cheap to clone; clones share the slot.
#[derive(Clone, Default)]
pub struct CommandSlot(Arc<SlotState>);

#[derive(Default)]
struct SlotState {
	/// `commands` holds some: lookups of a run without session commands
	/// never take the lock.
	installed: AtomicBool,
	commands:  Mutex<Option<SessionCommands>>,
}

impl CommandSlot {
	/// Install `commands` for the commands run from now on (`None`: none).
	pub fn set(&self, commands: Option<SessionCommands>) {
		let mut slot = self.0.commands.lock();
		self
			.0
			.installed
			.store(commands.is_some(), Ordering::Release);
		*slot = commands;
	}

	/// The commands installed now.
	pub(crate) fn get(&self) -> Option<SessionCommands> {
		if !self.0.installed.load(Ordering::Acquire) {
			return None;
		}
		self.0.commands.lock().clone()
	}

	/// The [`NativeRef`] of the installed command `name`, if there is one.
	pub(crate) fn lookup(&self, name: &BStr) -> Option<NativeRef> {
		if !self.0.installed.load(Ordering::Acquire) {
			return None;
		}
		self.0.commands.lock().as_ref()?.lookup(name)
	}
}

/// Whether `cmd` names a session command rather than an extra.
pub(crate) const fn is_command(cmd: NativeRef) -> bool {
	cmd.0 >= FIRST_REF && cmd.0 != extras::SUSPEND.0
}

/// The index into the sorted names of session command `cmd`.
fn command_index(cmd: NativeRef) -> Option<usize> {
	if !is_command(cmd) {
		return None;
	}
	usize::try_from(cmd.0 - FIRST_REF).ok()
}

/// The session commands of one [`Shell::run`](crate::Shell::run): the
/// commands it hands out end when it is dropped.
pub(crate) struct RunLease(SessionCommands);

impl RunLease {
	/// A lease on `commands` for one run.
	pub(crate) fn new(commands: &SessionCommands) -> Self {
		Self(SessionCommands {
			names:   Arc::clone(&commands.names),
			handler: Arc::clone(&commands.handler),
			ended:   CancellationToken::new(),
		})
	}

	/// The commands, for the session runs of this run.
	pub(crate) fn commands(&self) -> SessionCommands {
		self.0.clone()
	}
}

impl Drop for RunLease {
	fn drop(&mut self) {
		self.0.ended.cancel();
	}
}

/// Every name that never reaches a session command in command position.
///
/// Sorted, for the session's default mode (bash): the reserved words, the
/// engine's builtins, pi's tools and extras (whatever the session's
/// switches), and the shells the engine runs itself.
pub fn reserved_command_names() -> Vec<&'static str> {
	let mut names: Vec<&'static str> = crate::bash::syntax::RESERVED_WORDS
		.iter()
		.filter_map(|word| std::str::from_utf8(word).ok())
		.chain(
			IntrinsicId::iter()
				.filter(|id| id.available_in(Dialect::Bash))
				.map(<&'static str>::from),
		)
		.chain(crate::tools::names())
		.chain(crate::sys::shebang::SELF_SHELLS)
		.collect();
	names.sort_unstable();
	names.dedup();
	names
}

/// One invocation, owned by its task on the runtime.
struct Call {
	name:    String,
	argv:    Vec<String>,
	cwd:     String,
	/// `None` when no argument is `-`: stdin is never read.
	stdin:   Option<FdRef>,
	stdout:  FdRef,
	stderr:  FdRef,
	handler: Arc<dyn SessionCommandHandler>,
	ended:   CancellationToken,
	cancel:  CancellationToken,
}

/// Why a command ended without a reply to write.
struct Failure {
	status: i32,
	reason: String,
}

impl Call {
	/// The command, to its status.
	async fn run(self) -> i32 {
		let Self { name, argv, cwd, stdin, stdout, stderr, handler, ended, cancel } = self;
		let work = async {
			let reply = tokio::select! {
				biased;
				() = ended.cancelled() => Err(Failure {
					status: FAILED,
					reason: "the shell run that provided this command has ended".to_owned(),
				}),
				reply = serve(&name, argv, cwd, stdin, &*handler) => reply,
			};
			match reply {
				Ok(SessionCommandResult { stdout: out, stderr: err, exit_code }) => {
					write_all(&stdout, out.as_bytes()).await;
					write_all(&stderr, err.as_bytes()).await;
					exit_code.clamp(0, 255)
				},
				Err(Failure { status, reason }) => {
					let message = format!("{name}: {}\n", reason.trim_end());
					write_all(&stderr, message.as_bytes()).await;
					status
				},
			}
		};
		tokio::select! {
			biased;
			() = cancel.cancelled() => CANCELLED,
			status = work => status,
		}
	}
}

/// Read the stdin a request carries, then make the call.
async fn serve(
	name: &str,
	argv: Vec<String>,
	cwd: String,
	stdin: Option<FdRef>,
	handler: &dyn SessionCommandHandler,
) -> Result<SessionCommandResult, Failure> {
	let stdin = match stdin {
		Some(fd) => read_stdin(fd)
			.await
			.map_err(|reason| Failure { status: BAD_STDIN, reason })?,
		None => String::new(),
	};
	let request = SessionCommandRequest { name: name.to_owned(), argv, cwd, stdin };
	handler
		.call(request)
		.await
		.map_err(|reason| Failure { status: FAILED, reason })
}

/// `fd` to end of file, as UTF-8 of at most [`STDIN_LIMIT_BYTES`]; the
/// descriptor is released once read.
async fn read_stdin(fd: FdRef) -> Result<String, String> {
	let mut bytes = Vec::new();
	let mut chunk = vec![0_u8; READ_CHUNK];
	loop {
		let read = poll_fn(|cx| fd.poll_read(cx, &mut chunk)).await;
		let n = match read {
			Ok(0) => break,
			Ok(n) => n,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
			Err(err) => return Err(format!("cannot read stdin: {err}")),
		};
		if bytes.len() + n > STDIN_LIMIT_BYTES {
			return Err(format!("stdin exceeds the {STDIN_LIMIT_BYTES} byte limit"));
		}
		bytes.extend_from_slice(&chunk[..n]);
	}
	drop(fd);
	String::from_utf8(bytes).map_err(|_| "stdin is not valid UTF-8".to_owned())
}

/// Write all of `bytes` to `fd`; a descriptor that stops taking them (a
/// closed pipe, a closed fd) loses the rest.
async fn write_all(fd: &FdRef, mut bytes: &[u8]) {
	while !bytes.is_empty() {
		match poll_fn(|cx| fd.poll_write(cx, bytes)).await {
			Ok(0) => return,
			Ok(n) => bytes = &bytes[n..],
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(_) => return,
		}
	}
	let _ = poll_fn(|cx| fd.poll_flush(cx)).await;
}

/// A running session command, as the engine's [`Task`].
///
/// Dropping it (the engine abandoned the command) cancels the call.
pub(crate) struct CommandTask {
	done:   Arc<Done>,
	cancel: CancellationToken,
}

impl Task for CommandTask {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<i32> {
		self.done.poll(cx)
	}

	fn signal(&mut self, sig: Signal) {
		if extras::cancels(sig) {
			self.cancel.cancel();
		}
	}
}

impl Drop for CommandTask {
	fn drop(&mut self) {
		self.cancel.cancel();
	}
}
