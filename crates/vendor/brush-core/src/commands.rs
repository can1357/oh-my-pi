//! Command execution

use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	fmt::Display,
	io::{self, Write},
	path::{Path, PathBuf},
};

use brush_parser::ast;
use itertools::Itertools;
use sys::commands::{CommandExt, CommandFdInjectionExt, CommandFgControlExt, CommandSessionExt};

use crate::{
	ErrorKind, ExecutionControlFlow, ExecutionExitCode, ExecutionParameters, ExecutionResult, Shell,
	ShellFd, builtins, commands, env, error, escape,
	extensions::{self, ShellExtensions},
	functions,
	interp::{self, Execute, ExternalCommandInfo, ExternalCommandOutputMarkers, ProcessGroupPolicy},
	openfiles::{self, OpenFiles},
	pathsearch, processes,
	results::{ExecutionSpawnResult, ExecutionWaitResult},
	sys, trace_categories, traps,
};

thread_local! {
	static BUILTIN_ON_BLOCKING_WORKER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether the calling builtin runs on a Tokio blocking worker (synchronous
/// builtins in owned-shell pipeline stages and async jobs, or on virtual
/// files; `async_io` builtins run as tasks). Synchronous I/O
/// there cannot starve the async runtime, so a builtin must not offload it to
/// another blocking worker: holding this one while queueing that can exhaust
/// a bounded blocking pool and leave every nested read waiting forever.
pub fn builtin_on_blocking_worker() -> bool {
	BUILTIN_ON_BLOCKING_WORKER.with(std::cell::Cell::get)
}

/// Drives a builtin to completion on the current blocking worker, marking the
/// thread for [`builtin_on_blocking_worker`] while it runs.
fn block_on_builtin<F: Future>(future: F) -> F::Output {
	struct Restore(bool);
	impl Drop for Restore {
		fn drop(&mut self) {
			BUILTIN_ON_BLOCKING_WORKER.with(|flag| flag.set(self.0));
		}
	}
	let _restore = Restore(BUILTIN_ON_BLOCKING_WORKER.with(|flag| flag.replace(true)));
	tokio::runtime::Handle::current().block_on(future)
}

/// Encapsulates the result of waiting for a command to complete.
pub enum CommandWaitResult {
	/// The command completed.
	CommandCompleted(ExecutionResult),
	/// The command was stopped before it completed.
	CommandStopped(ExecutionResult, processes::ChildProcess),
}

/// Represents the context for executing a command.
pub struct ExecutionContext<'a, SE: ShellExtensions = extensions::DefaultShellExtensions> {
	/// The shell in which the command is being executed.
	pub shell:        &'a mut Shell<SE>,
	/// The name of the command being executed.
	pub command_name: String,
	/// The parameters for the execution.
	pub params:       ExecutionParameters,
}

impl<SE: ShellExtensions> ExecutionContext<'_, SE> {
	/// Returns the standard input file; usable with `write!` et al.
	pub fn stdin(&self) -> impl std::io::Read + 'static {
		self.params.stdin(self.shell)
	}

	/// Returns the standard output file; usable with `write!` et al.
	pub fn stdout(&self) -> impl std::io::Write + 'static {
		self.params.stdout(self.shell)
	}

	/// Returns the standard error file; usable with `write!` et al.
	pub fn stderr(&self) -> impl std::io::Write + 'static {
		self.params.stderr(self.shell)
	}

	/// Returns the cancellation token, if one is configured.
	pub fn cancel_token(&self) -> Option<tokio_util::sync::CancellationToken> {
		self.params.cancel_token()
	}

	/// Returns true when cancellation has been requested.
	pub fn is_cancelled(&self) -> bool {
		self.params.is_cancelled()
	}

	/// Returns the file descriptor with the given number. Returns `None`
	/// if the file descriptor is not open.
	///
	/// # Arguments
	///
	/// * `fd` - The file descriptor number to retrieve.
	pub fn try_fd(&self, fd: ShellFd) -> Option<openfiles::OpenFile> {
		self.params.try_fd(self.shell, fd)
	}

	/// Iterates over all open file descriptors.
	pub fn iter_fds(&self) -> impl Iterator<Item = (ShellFd, openfiles::OpenFile)> {
		self.params.iter_fds(self.shell)
	}

	/// Iterates over all open file descriptors without duplicating them.
	pub fn open_fds(&self) -> impl Iterator<Item = (ShellFd, &openfiles::OpenFile)> {
		self.params.open_fds(self.shell)
	}
}

/// An argument to a command.
#[derive(Clone, Debug)]
pub enum CommandArg {
	/// A simple string argument.
	String(String),
	/// An assignment/declaration; typically treated as a string, but will
	/// be specially handled by a limited set of built-in commands.
	Assignment(ast::Assignment),
}

impl Display for CommandArg {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::String(s) => f.write_str(s),
			Self::Assignment(a) => write!(f, "{a}"),
		}
	}
}

impl From<String> for CommandArg {
	fn from(s: String) -> Self {
		Self::String(s)
	}
}

impl From<&String> for CommandArg {
	fn from(value: &String) -> Self {
		Self::String(value.clone())
	}
}

impl CommandArg {
	pub(crate) fn quote_for_tracing(&self) -> Cow<'_, str> {
		match self {
			Self::String(s) => escape::quote_if_needed(s, escape::QuoteMode::SingleQuote),
			Self::Assignment(a) => {
				let mut s = a.name.to_string();
				let op = if a.append { "+=" } else { "=" };
				s.push_str(op);
				s.push_str(&escape::quote_if_needed(
					a.value.to_string().as_str(),
					escape::QuoteMode::SingleQuote,
				));
				s.into()
			},
		}
	}
}

/// Encapsulates a possibly-owned reference to a `Shell` for command execution.
pub enum ShellForCommand<'a, SE: extensions::ShellExtensions> {
	/// The command is run in the same shell as its parent; the provided
	/// mutable reference allows modifying the parent shell.
	ParentShell(&'a mut Shell<SE>),
	/// The command is run in its own owned shell (which is also provided).
	OwnedShell {
		/// The owned shell.
		target: Box<Shell<SE>>,
		/// The parent shell.
		parent: &'a mut Shell<SE>,
	},
}

impl<SE: extensions::ShellExtensions> std::ops::Deref for ShellForCommand<'_, SE> {
	type Target = Shell<SE>;

	fn deref(&self) -> &Self::Target {
		match self {
			ShellForCommand::ParentShell(shell) => shell,
			ShellForCommand::OwnedShell { target, .. } => target,
		}
	}
}

impl<SE: extensions::ShellExtensions> std::ops::DerefMut for ShellForCommand<'_, SE> {
	fn deref_mut(&mut self) -> &mut Self::Target {
		match self {
			ShellForCommand::ParentShell(shell) => shell,
			ShellForCommand::OwnedShell { target, .. } => target,
		}
	}
}

/// The host path a file-backed virtual path aliases, if any.
///
/// External processes have no view of the shell's virtual filesystem, so a
/// `scheme://` path handed to one means nothing there. File-backed schemes
/// (`skill://`, `local://`, `artifact://`, …) alias a real file and resolve to
/// it; rendered ones (`omp://`, `history://`) and schemes no provider serves
/// alias nothing and keep their virtual spelling. A provider error (an unknown
/// skill, a path escaping its root) is the command's error: the child would
/// only fail later on a URL it cannot open.
async fn host_path(filesystem: &pi_vfs::Fs, path: &Path) -> Result<Option<PathBuf>, error::Error> {
	if filesystem.is_native() || !pi_vfs::is_virtual_path(path) {
		return Ok(None);
	}
	filesystem.backing_path(path).await.map_err(|err| {
		error::ErrorKind::ExternalCommandVirtualPathUnresolved(path.to_owned(), err).into()
	})
}

/// What [`host_arg`] does with an argument, decided from its text alone.
///
/// Both the bare spelling (`skill://example-skill/tool.py`) and the
/// attached-value spelling (`--index=skill://example-skill/data`) translate.
/// Anything the filesystem does not route to a backing file is left exactly as
/// it was written, so `https://…`, `s3://…`, and ordinary words reach the
/// child untouched. A bare scheme root (`local://`) is far likelier a search
/// pattern or message text than a directory, so it stays literal too.
#[derive(Clone, Copy)]
enum HostArgPlan {
	/// The argument names no file-backed URL.
	Literal,
	/// The whole argument is a URL, which its backing path replaces.
	Whole,
	/// `name=URL`, with the `=` at this offset: the URL's backing path
	/// replaces the part after it.
	Attached(usize),
}

/// The [`HostArgPlan`] for `text`. Every test is on the text alone and reads
/// as far as the whole of it, so an argument longer than a stride is planned
/// on a blocking worker ([`ComposedCommand::arg`]).
fn host_arg_plan(text: &str) -> HostArgPlan {
	if !text.contains("://") {
		return HostArgPlan::Literal;
	}
	if pi_vfs::is_virtual_path(Path::new(text)) {
		return if is_url_root(text) { HostArgPlan::Literal } else { HostArgPlan::Whole };
	}
	let Some((name, value)) = text.split_once('=') else {
		return HostArgPlan::Literal;
	};
	// Only an option name may carry an attached URL. A URL of its own that
	// happens to embed one in a query string (`https://host/cb?next=local://x`)
	// is one opaque string to the program receiving it.
	if name.contains("://") || is_url_root(value) {
		return HostArgPlan::Literal;
	}
	HostArgPlan::Attached(name.len())
}

/// `text` rewritten to the host path its [`HostArgPlan`] names, if the
/// filesystem routes that URL to a backing file.
async fn host_arg(
	filesystem: &pi_vfs::Fs,
	text: &str,
	plan: HostArgPlan,
) -> Result<Option<OsString>, error::Error> {
	match plan {
		HostArgPlan::Literal => Ok(None),
		HostArgPlan::Whole => Ok(host_path(filesystem, Path::new(text))
			.await?
			.map(PathBuf::into_os_string)),
		HostArgPlan::Attached(equals) => {
			let (name, value) = (&text[..equals], &text[equals + 1..]);
			let Some(host) = host_path(filesystem, Path::new(value)).await? else {
				return Ok(None);
			};
			let mut rewritten = OsString::from(name);
			rewritten.push("=");
			rewritten.push(host);
			Ok(Some(rewritten))
		},
	}
}

/// Whether `text` is a URL naming nothing below its scheme (`local://`).
fn is_url_root(text: &str) -> bool {
	pi_vfs::url_scheme(Path::new(text))
		.is_some_and(|scheme| text[scheme.len() + 3..].trim_matches('/').is_empty())
}

/// Runs `work` on a blocking worker and waits for it, or in place on a
/// builtin that is on a blocking worker already.
async fn off_worker<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, error::Error> {
	if builtin_on_blocking_worker() {
		return Ok(work());
	}
	match tokio::task::spawn_blocking(work).await {
		Ok(done) => Ok(done),
		Err(join_error) if join_error.is_panic() => std::panic::resume_unwind(join_error.into_panic()),
		Err(join_error) => Err(error::ErrorKind::ThreadingError(join_error).into()),
	}
}

/// A command [`compose_std_command`] composed, with what it left to be done
/// where the command starts.
///
/// **The size that decides where a command starts is the size of everything
/// composed into it, because the start touches all of it again.** `std`
/// copies every variable of the environment once more and builds the block
/// the process receives from those copies when it starts, and frees every
/// argument when the command is dropped: a hundred thousand small exported
/// variables held the worker 90.8 ms before `/usr/bin/true`, though no one of
/// them was long. So composing counts the steps and bytes it puts into the
/// command, and a command of more than one step's worth —
/// [`interp::DIVIDE_COPY_ABOVE_BYTES`] of text or
/// [`interp::ELEMENT_CHECKPOINT_STRIDE`] arguments and variables — starts on
/// a blocking worker ([`Self::start`]). An ordinary command starts in place.
///
/// A piece longer than a stride is not copied into the command while it is
/// composed, because `Command::arg` and `Command::env` copy in one call: it is
/// copied out in strides and left for the start (`deferred`), and so is every
/// argument after it, to keep the arguments in order, and every variable after
/// it, so that a later setting of the same name still wins. So is an
/// exported function, whose definition is rendered as text only there.
///
/// **Nothing here decides whether the operating system will start the
/// command.** An argument or environment too long for it is copied to where
/// the command starts and refused there by the spawn, with the spawn's own
/// error and in the spawn's own order of checks.
pub struct ComposedCommand {
	command:       std::process::Command,
	deferred:      Vec<Deferred>,
	args_deferred: bool,
	env_deferred:  bool,
	budget:        interp::ElementBudget,
	steps:         usize,
	bytes:         usize,
}

/// A piece of a [`ComposedCommand`] left for where it starts.
enum Deferred {
	Arg0(String),
	Arg(OsString),
	Env(OsString, OsString),
	Function(String, std::sync::Arc<ast::FunctionDefinition>),
}

impl ComposedCommand {
	fn new(command: std::process::Command) -> Self {
		Self {
			command,
			deferred: Vec::new(),
			args_deferred: false,
			env_deferred: false,
			budget: interp::ElementBudget::new(),
			steps: 0,
			bytes: 0,
		}
	}

	/// The command, for the settings a caller adds before it starts.
	pub const fn command_mut(&mut self) -> &mut std::process::Command {
		&mut self.command
	}

	/// Counts one step of `bytes` put into the command, and spends the
	/// checkpoints it owes.
	async fn charge(&mut self, params: &ExecutionParameters, bytes: usize) -> Result<(), error::Error> {
		self.steps += 1;
		self.bytes = self.bytes.saturating_add(bytes);
		let due = self.budget.charge(bytes);
		if due > 0 {
			interp::loop_checkpoints(params, due).await?;
		}
		Ok(())
	}

	/// Spends the checkpoints one step owes that looks at something without
	/// putting it into the command.
	async fn walk(&mut self, params: &ExecutionParameters) -> Result<(), error::Error> {
		let due = self.budget.charge(0);
		if due > 0 {
			interp::loop_checkpoints(params, due).await?;
		}
		Ok(())
	}

	async fn arg0(&mut self, params: &ExecutionParameters, argv0: &str) -> Result<(), error::Error> {
		if argv0.len() <= interp::DIVIDE_COPY_ABOVE_BYTES {
			self.charge(params, argv0.len()).await?;
			self.command.arg0(argv0);
			return Ok(());
		}
		self.charge(params, 0).await?;
		let argv0 = interp::clone_in_strides(params, argv0).await?;
		self.deferred.push(Deferred::Arg0(argv0));
		Ok(())
	}

	/// Adds `arg`, rewritten to the host path it names where `rewrites`.
	///
	/// A long argument is planned on a blocking worker from a copy made in
	/// strides: deciding whether it holds a URL reads all of it.
	async fn arg(
		&mut self,
		params: &ExecutionParameters,
		filesystem: &pi_vfs::Fs,
		rewrites: bool,
		arg: &str,
	) -> Result<(), error::Error> {
		if arg.len() <= interp::DIVIDE_COPY_ABOVE_BYTES {
			self.charge(params, arg.len()).await?;
			let rewritten = if rewrites { host_arg(filesystem, arg, host_arg_plan(arg)).await? } else { None };
			match (rewritten, self.args_deferred) {
				(Some(rewritten), true) => self.deferred.push(Deferred::Arg(rewritten)),
				(None, true) => self.deferred.push(Deferred::Arg(OsString::from(arg))),
				(Some(rewritten), false) => {
					self.command.arg(rewritten);
				},
				(None, false) => {
					self.command.arg(arg);
				},
			}
			return Ok(());
		}
		self.charge(params, 0).await?;
		let arg = interp::clone_in_strides(params, arg).await?;
		let (arg, plan) = if rewrites {
			off_worker(move || {
				let plan = host_arg_plan(&arg);
				(arg, plan)
			})
			.await?
		} else {
			(arg, HostArgPlan::Literal)
		};
		let arg = match host_arg(filesystem, &arg, plan).await? {
			Some(rewritten) => rewritten,
			None => OsString::from(arg),
		};
		self.args_deferred = true;
		self.deferred.push(Deferred::Arg(arg));
		Ok(())
	}

	/// Adds the variable `name` with `value` to the child's environment.
	async fn env(
		&mut self,
		params: &ExecutionParameters,
		name: &str,
		value: Cow<'_, str>,
	) -> Result<(), error::Error> {
		let bytes = name.len() + value.len();
		if bytes <= interp::DIVIDE_COPY_ABOVE_BYTES {
			self.charge(params, bytes).await?;
			self.set_env(OsStr::new(name), OsStr::new(value.as_ref()));
			return Ok(());
		}
		self.charge(params, 0).await?;
		let name = interp::clone_in_strides(params, name).await?;
		let value = match value {
			Cow::Owned(value) => value,
			Cow::Borrowed(value) => interp::clone_in_strides(params, value).await?,
		};
		self.env_deferred = true;
		self.deferred.push(Deferred::Env(name.into(), value.into()));
		Ok(())
	}

	/// Sets a variable whose value the shell does not size (a path the
	/// operating system gave it), after any deferred one of the same name.
	fn set_env(&mut self, name: &OsStr, value: &OsStr) {
		if self.env_deferred {
			self.deferred.push(Deferred::Env(name.to_owned(), value.to_owned()));
		} else {
			self.command.env(name, value);
		}
	}

	/// Finishes the command and runs `start` on it — a spawn, or an `exec` —
	/// on a blocking worker if more than one step's worth was composed into
	/// it, and in place otherwise. The command is dropped where `start` ran.
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::ThreadingError`] if the blocking worker
	/// did not run `start`.
	pub async fn start<T: Send + 'static>(
		self,
		start: impl FnOnce(std::process::Command) -> T + Send + 'static,
	) -> Result<T, error::Error> {
		let large = !self.deferred.is_empty()
			|| self.bytes > interp::DIVIDE_COPY_ABOVE_BYTES
			|| self.steps > interp::ELEMENT_CHECKPOINT_STRIDE;
		if large {
			off_worker(move || start(self.finish())).await
		} else {
			Ok(start(self.finish()))
		}
	}

	/// The command with every deferred piece copied into it.
	fn finish(self) -> std::process::Command {
		let Self { mut command, deferred, .. } = self;
		for piece in deferred {
			match piece {
				Deferred::Arg0(argv0) => {
					command.arg0(argv0);
				},
				Deferred::Arg(arg) => {
					command.arg(arg);
				},
				Deferred::Env(name, value) => {
					command.env(name, value);
				},
				Deferred::Function(name, definition) => {
					command.env(std::format!("BASH_FUNC_{name}%%"), std::format!("() {}", definition.body));
				},
			}
		}

		// When tracing is enabled, report.
		tracing::debug!(
			 target: trace_categories::COMMANDS,
			 "Spawning: cmd='{} {}'",
			 command.get_program().to_string_lossy().to_string(),
			 command.get_args()
				  .map(|a| a.to_string_lossy().to_string())
				  .join(" ")
		);

		command
	}
}

/// Composes a `std::process::Command` to execute the given command.
/// Appropriately configures the command name and arguments, redirections,
/// injected file descriptors, environment variables, etc.
///
/// Composing is divided: every argument and every variable is a step, the
/// variables are found a step at a time, and a piece longer than a stride is
/// left for where the command starts. See [`ComposedCommand`].
///
/// # Arguments
///
/// * `context` - The execution context in which the command is being composed.
/// * `command_name` - The name of the command to execute.
/// * `argv0` - The value to use for `argv[0]` (may be different from the
///   command).
/// * `leading` - Arguments to pass before `args`.
/// * `args` - The arguments to pass to the command.
/// * `empty_env` - If true, the command will be executed with an empty
///   environment; if false, the command will inherit environment variables
///   marked as exported in the provided `Shell`.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
/// way, and the error of a virtual working directory, program or argument the
/// child cannot be handed.
pub async fn compose_std_command<SE: extensions::ShellExtensions, S: AsRef<str> + Sync>(
	context: &ExecutionContext<'_, SE>,
	command_name: &str,
	argv0: &str,
	leading: &[&str],
	args: &[S],
	empty_env: bool,
) -> Result<ComposedCommand, error::Error> {
	// The operating system has no view of this process's virtual filesystem: a
	// child can only start in a native directory and only run a native program.
	// A file-backed scheme aliases a real file, so the program, the arguments
	// and the working directory are handed to the child as those files; a
	// scheme backed by nothing is still refused.
	let filesystem = context.shell.filesystem();
	let working_dir = context.shell.working_dir();
	let spawn_dir = match host_path(filesystem, working_dir).await? {
		Some(backing) => {
			// A child may write anywhere under its working directory, so it must
			// not start in one the shell itself refuses to mutate (`skill://`,
			// `artifact://`). Arguments still translate: those name single files
			// the program was asked to use.
			match filesystem.access(working_dir, false, true, false).await {
				Ok(()) => backing,
				Err(err) if err.kind() == io::ErrorKind::ReadOnlyFilesystem => {
					return Err(error::ErrorKind::ExternalCommandInReadOnlyWorkingDir(
						context.command_name.clone(),
						working_dir.to_owned(),
					)
					.into());
				},
				Err(err) => {
					return Err(error::ErrorKind::ExternalCommandVirtualPathUnresolved(
						working_dir.to_owned(),
						err,
					)
					.into());
				},
			}
		},
		None if filesystem.is_native_local(working_dir) => working_dir.to_owned(),
		None => {
			return Err(error::ErrorKind::ExternalCommandInVirtualWorkingDir(
				context.command_name.clone(),
				working_dir.to_owned(),
			)
			.into());
		},
	};
	let mut program = PathBuf::from(command_name);
	if sys::fs::contains_path_separator(command_name) {
		let spelled = context.shell.absolute_path(Path::new(command_name));
		if !filesystem.is_native_local(&spelled) {
			program = host_path(filesystem, &spelled)
				.await?
				.ok_or_else(|| error::ErrorKind::ExternalCommandIsVirtual(spelled))?;
		}
	}

	let params = &context.params;
	let mut composed = ComposedCommand::new(std::process::Command::new(&program));

	// Override argv[0].
	// NOTE: Not supported on all platforms.
	composed.arg0(params, argv0).await?;

	// A native filesystem routes no URL to a backing file, so nothing is
	// rewritten and no argument needs reading for one.
	let rewrites = !filesystem.is_native();
	for arg in leading {
		composed.arg(params, filesystem, rewrites, arg).await?;
	}
	for arg in args {
		composed.arg(params, filesystem, rewrites, arg.as_ref()).await?;
	}

	// Apply `ulimit` overrides to the child only; the host keeps its own limits.
	#[cfg(unix)]
	if !context.shell.resource_limits().is_empty() {
		let limits = context.shell.resource_limits().clone();
		// SAFETY: runs in the forked child before exec; `apply_in_child` only
		// issues `setrlimit` calls, which are async-signal-safe, and does not
		// allocate.
		unsafe {
			composed.command.pre_exec(move || limits.apply_in_child());
		}
	}

	// Likewise `umask`: the child gets the shell's mask, the host keeps its own.
	#[cfg(unix)]
	if let Some(mask) = context.shell.umask() {
		// SAFETY: runs in the forked child before exec; `umask` is
		// async-signal-safe and cannot fail.
		unsafe {
			composed.command.pre_exec(move || {
				nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(
					mask as nix::libc::mode_t,
				));
				Ok(())
			});
		}
	}

	// Use the shell's current working dir, as the host spells it.
	composed.command.current_dir(&spawn_dir);

	// Start with a clear environment.
	composed.command.env_clear();

	if !empty_env {
		// Add in exported variables, found a step at a time: every variable
		// is looked at, exported or not.
		for (name, variable) in context.shell.env().exported_divided(params).await? {
			// NOTE: To match bash behavior, we only include exported variables
			// that are set (i.e., have a value). This means a variable that
			// shows up in `declare -p` but has no *set* value will be omitted.
			if variable.value().is_set() {
				composed
					.env(params, name, variable.value().to_cow_str(context.shell))
					.await?;
			}
		}
		// A child started in the directory a URL aliases must not be told its
		// working directory is the URL: anything reading `PWD` directly would
		// disagree with its own `getcwd()`. The shell's own `$PWD` keeps the
		// URL spelling; only the child's environment is corrected.
		if spawn_dir != working_dir {
			composed.set_env(OsStr::new("PWD"), spawn_dir.as_os_str());
		}
		// Set _ to the resolved command path for external commands, as the host
		// spells it when the program was a URL.
		composed.set_env(OsStr::new("_"), program.as_os_str());

		// Add in exported functions. A definition is rendered as text where
		// the command starts, since it can be any length.
		for (func_name, registration) in context.shell.funcs().iter() {
			composed.walk(params).await?;
			if registration.is_exported() {
				composed
					.deferred
					.push(Deferred::Function(func_name.clone(), registration.shared_definition()));
			}
		}
	}

	// Redirect stdin, if applicable.
	match context.try_fd(OpenFiles::STDIN_FD) {
		None => (),
		Some(stdin_file) => {
			let as_stdio = stdin_file.into_stdio()?;
			composed.command.stdin(as_stdio);
		},
	}

	// Redirect stdout, if applicable.
	match context.try_fd(OpenFiles::STDOUT_FD) {
		None => (),
		Some(stdout_file) => {
			let as_stdio = stdout_file.into_stdio()?;
			composed.command.stdout(as_stdio);
		},
	}

	// Redirect stderr, if applicable.
	match context.try_fd(OpenFiles::STDERR_FD) {
		None => {},
		Some(stderr_file) => {
			let as_stdio = stderr_file.into_stdio()?;
			composed.command.stderr(as_stdio);
		},
	}

	// Inject any other fds.
	let other_files = context.iter_fds().filter(|(fd, _)| {
		*fd != OpenFiles::STDIN_FD && *fd != OpenFiles::STDOUT_FD && *fd != OpenFiles::STDERR_FD
	});
	composed.command.inject_fds(other_files)?;

	Ok(composed)
}

/// Renders `args` the way `BASH_COMMAND` holds them: joined by spaces, each as
/// its `Display` writes it.
///
/// **One pass, charged as it goes, with nothing deciding in front of it.**
/// The rendering runs before every command, and every earlier version chose
/// between a plain join and a divided one, and every choice was wrong for
/// some shape. Summing the lengths to choose was itself a pass over every
/// argument: eight million empty ones spent 20.6 ms deciding. Choosing on the
/// count and on each argument's own length let 256 arguments of 64 KiB, 16 MiB
/// in all, take the plain join for 5.5 ms, and 240.1 ms when `BASH_COMMAND`
/// lowercased what it was given, because the plain write converted in one
/// step too. No count can be the criterion, since the work is the bytes as
/// well as the steps. So nothing chooses: every argument and every element of
/// an array argument is one step of an [`interp::ElementBudget`], charged its
/// bytes, and a piece longer than a stride is copied in strides. An ordinary
/// command line owes the one checkpoint of its first step and no other.
async fn render_command_line(
	params: &ExecutionParameters,
	args: &[CommandArg],
) -> Result<String, error::Error> {
	let mut line = CommandLine { params, budget: interp::ElementBudget::new(), text: String::new() };
	for (index, arg) in args.iter().enumerate() {
		let separator = if index > 0 { " " } else { "" };
		match arg {
			CommandArg::String(text) => line.push(&[separator, text]).await?,
			CommandArg::Assignment(assignment) => {
				line.push_assignment(separator, assignment).await?;
			},
		}
	}
	Ok(line.text)
}

/// A command line being rendered by [`render_command_line`].
struct CommandLine<'a> {
	params: &'a ExecutionParameters,
	budget: interp::ElementBudget,
	text:   String,
}

impl CommandLine<'_> {
	/// Appends `parts` as one step: the parts within a stride are charged
	/// their bytes and copied as they are, and a longer one is copied in
	/// strides of its own.
	async fn push(&mut self, parts: &[&str]) -> Result<(), error::Error> {
		let short = parts
			.iter()
			.map(|part| part.len())
			.filter(|len| *len <= interp::DIVIDE_COPY_ABOVE_BYTES)
			.sum();
		let due = self.budget.charge(short);
		if due > 0 {
			interp::loop_checkpoints(self.params, due).await?;
		}
		for part in parts {
			if part.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
				interp::push_str_in_strides(self.params, &mut self.text, part).await?;
			} else {
				self.text.push_str(part);
			}
		}
		Ok(())
	}

	/// Appends `assignment` as its `Display` writes it. The name and the
	/// operator are one step, and so is a scalar value and each element of an
	/// array value: an element's key, like the subscript of the name, is
	/// **expanded** text, and `declare a["$huge"]=v` spent 50.6 ms in one
	/// `to_string` of the name.
	async fn push_assignment(
		&mut self,
		separator: &str,
		assignment: &ast::Assignment,
	) -> Result<(), error::Error> {
		let operator = if assignment.append { "+=" } else { "=" };
		match &assignment.name {
			ast::AssignmentName::VariableName(name) => self.push(&[separator, name, operator]).await?,
			ast::AssignmentName::ArrayElementName(name, index) => {
				self.push(&[separator, name, "[", index, "]", operator]).await?;
			},
		}
		match &assignment.value {
			ast::AssignmentValue::Scalar(word) => self.push(&[&word.value]).await,
			ast::AssignmentValue::Array(words) => {
				self.push(&["("]).await?;
				for (index, (key, value)) in words.iter().enumerate() {
					let separator = if index > 0 { " " } else { "" };
					match key {
						Some(key) => self.push(&[separator, "[", &key.value, "]=", &value.value]).await?,
						None => self.push(&[separator, &value.value]).await?,
					}
				}
				self.text.push(')');
				Ok(())
			},
		}
	}
}

/// Renders one argument as its `Display` writes it, copying it in strides
/// above one stride.
pub(crate) async fn render_argument(
	params: &ExecutionParameters,
	arg: &CommandArg,
) -> Result<String, error::Error> {
	match arg {
		CommandArg::String(text) => interp::clone_in_strides(params, text).await,
		CommandArg::Assignment(_) => render_command_line(params, std::slice::from_ref(arg)).await,
	}
}

pub(crate) async fn on_preexecute(
	cmd: &mut commands::SimpleCommand<'_, impl extensions::ShellExtensions>,
) -> Result<(), error::Error> {
	// Set BASH_COMMAND before invoking the DEBUG trap (and generally before
	// executing commands). The write converts in strides too, for a
	// `BASH_COMMAND` given a case attribute.
	let full_cmd = render_command_line(&cmd.params, &cmd.args).await?;
	cmd.shell
		.env_mut()
		.update_or_add(
			"BASH_COMMAND",
			crate::variables::ShellValueLiteral::Scalar(full_cmd),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
			&cmd.params,
		)
		.await?;

	// Fire the DEBUG trap if one is registered.
	if cmd.shell.traps().handles(traps::TrapSignal::Debug) {
		let _ = cmd
			.shell
			.invoke_trap_handler(traps::TrapSignal::Debug, &cmd.params)
			.await?;
	}

	Ok(())
}

/// Represents a simple command to be executed.
pub struct SimpleCommand<'a, SE: extensions::ShellExtensions> {
	/// The shell to run the command in.
	shell: ShellForCommand<'a, SE>,

	/// The execution parameters for the command.
	pub params: ExecutionParameters,

	/// The name of the command to execute.
	pub command_name: String,

	/// The arguments to the command, including the command itself.
	pub args: Vec<CommandArg>,

	/// Whether to consider shell functions when looking up the command name.
	/// If true, shell functions will be checked; if false, they will be ignored.
	pub use_functions: bool,

	/// Optional list of directories to search for external commands. If left
	/// `None`, the default search logic will be used.
	pub path_dirs: Option<Vec<PathBuf>>,

	/// The process group ID to use for externally executed commands. This may be
	/// `None`, in which case the default behavior will be used.
	pub process_group_id: Option<i32>,
	/// Whether this command is part of a multi-command pipeline.
	pub in_pipeline: bool,

	/// Optional override for the `argv[0]` value presented to an externally
	/// spawned process. When `None`, `command_name` is used.
	pub argv0: Option<String>,

	/// Optionally provides a function that can run after execution occurs. Note
	/// that it is *not* invoked if the shell is discarded during the execution
	/// process.
	#[allow(clippy::type_complexity)]
	pub post_execute: Option<fn(&mut Shell<SE>) -> Result<(), error::Error>>,
}

impl<'a, SE: extensions::ShellExtensions> SimpleCommand<'a, SE> {
	/// Creates a new `SimpleCommand` instance.
	///
	/// # Arguments
	///
	/// * `shell` - The shell in which to execute the command.
	/// * `params` - The execution parameters for the command.
	/// * `command_name` - The name of the command to execute.
	/// * `args` - The arguments to the command, including the command itself.
	pub const fn new(
		shell: ShellForCommand<'a, SE>,
		params: ExecutionParameters,
		command_name: String,
		args: Vec<CommandArg>,
	) -> Self {
		Self {
			shell,
			params,
			command_name,
			args,
			use_functions: true,
			path_dirs: None,
			process_group_id: None,
			in_pipeline: false,
			argv0: None,
			post_execute: None,
		}
	}

	/// Executes the simple command.
	///
	/// The command may be a builtin, a shell function, or an externally
	/// executed command. This function's implementation is responsible for
	/// dispatching it appropriately according to the context provided.
	#[allow(clippy::missing_panics_doc, reason = "these unwrap calls should not panic")]
	pub async fn execute(mut self) -> Result<ExecutionSpawnResult, error::Error> {
		// First see if it's the name of a builtin.
		let builtin = self.shell.builtins().get(&self.command_name).cloned();

		// If we're in POSIX mode and found a special builtin (that's not disabled),
		// then invoke it without considering functions.
		if self.shell.options().posix_mode
			&& builtin
				.as_ref()
				.is_some_and(|r| !r.disabled && r.special_builtin)
		{
			#[allow(clippy::unwrap_used, reason = "we just checked that builtin is Some")]
			let builtin = builtin.unwrap();
			return self.execute_via_builtin(builtin).await;
		}

		// Assuming we weren't requested not to do so, check if it's the name of
		// a shell function.
		if self.use_functions {
			if let Some(func_registration) =
				self.shell.funcs().get(self.command_name.as_str()).cloned()
			{
				return self.execute_via_function(func_registration).await;
			}
		}

		// If we haven't yet resolved the command name and found a builtin that's not
		// disabled, then invoke it.
		if let Some(builtin) = builtin {
			if !builtin.disabled {
				return self.execute_via_builtin(builtin).await;
			}
		}

		// We still haven't found a command to invoke. We'll need to look for an
		// external command.
		if !sys::fs::contains_path_separator(&self.command_name) {
			// All else failed; if we were given path directories to search, try to look
			// through them for a matching executable. Otherwise, use our default search
			// logic.
			let path = if let Some(path_dirs) = &self.path_dirs {
				pathsearch::find_executable(
					self.shell.filesystem(),
					path_dirs,
					Path::new(&self.command_name),
				)
				.await
			} else {
				self
					.shell
					.find_first_executable_in_path_using_cache(&self.command_name)
					.await
			};

			if let Some(path) = path {
				self.execute_via_external(&path).await
			} else {
				// Bash updates $_ even when the command is not found, so mirror
				// that here before reporting the error.
				let last_arg = Self::take_last_arg(&self.args, &self.params).await?;
				self.shell.update_last_arg_variable(last_arg);

				if let Some(post_execute) = self.post_execute {
					let _ = post_execute(&mut self.shell);
				}

				Err(ErrorKind::CommandNotFound(self.command_name).into())
			}
		} else {
			let command_name = PathBuf::from(self.command_name.clone());
			self.execute_via_external(command_name.as_path()).await
		}
	}

	/// Whether any descriptor the command would see is backed by a virtual
	/// filesystem provider.
	fn sees_virtual_files(&self) -> bool {
		self
			.params
			.open_fds(&*self.shell)
			.any(|(_, file)| file.as_vfs().is_some())
	}

	/// Extracts the owned string representation of the last argument of a
	/// command, suitable for recording into `$_`.
	///
	/// The copy is divided, because the last argument is whatever the command
	/// line expanded to: `noop "${huge[@]}"` with a 64 MiB argument spent
	/// **47.0 ms** of a 70.8 ms hold in this one `to_string`. An assignment
	/// argument carries an expanded value and is rendered the way
	/// `BASH_COMMAND` renders it.
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way; `$_` is then left as it was.
	async fn take_last_arg(
		args: &[CommandArg],
		params: &ExecutionParameters,
	) -> Result<Option<String>, error::Error> {
		match args.last() {
			None => Ok(None),
			Some(arg) => Ok(Some(render_argument(params, arg).await?)),
		}
	}

	async fn execute_via_builtin(
		mut self,
		builtin: builtins::Registration<SE>,
	) -> Result<ExecutionSpawnResult, error::Error> {
		// Only an external command's child can make deferred redirections.
		interp::materialize_deferred_redirects(&self.shell, &mut self.params).await?;
		match self.shell {
			ShellForCommand::OwnedShell { target, .. } => {
				Self::execute_via_builtin_in_owned_shell(
					*target,
					self.params,
					builtin,
					self.command_name,
					self.args,
				)
				.await
			},
			ShellForCommand::ParentShell(..) => {
				self.execute_via_builtin_in_parent_shell(builtin).await
			},
		}
	}

	async fn execute_via_builtin_in_owned_shell(
		mut shell: Shell<SE>,
		params: ExecutionParameters,
		builtin: builtins::Registration<SE>,
		command_name: String,
		args: Vec<CommandArg>,
	) -> Result<ExecutionSpawnResult, error::Error> {
		let last_arg = Self::take_last_arg(&args, &params).await?;

		// An `async_io` builtin never blocks a worker, so it runs as a plain task.
		// Every other builtin does synchronous descriptor I/O: it runs on a
		// blocking worker, driven to completion there, so that I/O cannot starve
		// the async runtime.
		let join_handle = if builtin.async_io {
			tokio::spawn(async move {
				let cmd_context = ExecutionContext { shell: &mut shell, command_name, params };

				let result = execute_builtin_command(&builtin, cmd_context, args).await;

				// Update $_ after command execution.
				shell.update_last_arg_variable(last_arg);

				result
			})
		} else {
			tokio::task::spawn_blocking(move || {
				let cmd_context = ExecutionContext { shell: &mut shell, command_name, params };

				let result = block_on_builtin(execute_builtin_command(&builtin, cmd_context, args));

				// Update $_ after command execution.
				shell.update_last_arg_variable(last_arg);

				result
			})
		};

		Ok(ExecutionSpawnResult::StartedTask(join_handle))
	}

	async fn execute_via_builtin_in_parent_shell(
		self,
		builtin: builtins::Registration<SE>,
	) -> Result<ExecutionSpawnResult, error::Error> {
		let sees_virtual_files = self.sees_virtual_files();
		let mut shell = self.shell;
		let last_arg = Self::take_last_arg(&self.args, &self.params).await?;

		let result = if sees_virtual_files && !builtin.async_io {
			// Synchronous builtins do blocking I/O on their descriptors. A virtual file's
			// synchronous I/O awaits its provider, which must not happen on an
			// async runtime thread (a current-thread runtime would have nothing
			// left to drive the provider). Run the builtin on a blocking worker
			// instead, against a lease of the parent shell that is adopted only
			// once the builtin returns: if this future is dropped mid-builtin,
			// the parent keeps its prior state and jobs, and the worker's copy
			// is discarded when it finishes. A filesystem built with a
			// cancellation token interrupts the lease's virtual I/O once
			// cancelled, so the worker returns promptly.
			let lease = shell.lease(&self.params).await?;
			let command_name = self.command_name;
			let params = self.params;
			let args = self.args;
			let join_handle = tokio::task::spawn_blocking(move || {
				let mut lease = lease;
				let cmd_context = ExecutionContext { shell: &mut lease, command_name, params };
				let result = block_on_builtin(execute_builtin_command(&builtin, cmd_context, args));
				(lease, result)
			});
			match join_handle.await {
				Ok((lease, result)) => {
					shell.settle_lease(lease);
					result
				},
				Err(join_error) if join_error.is_panic() => {
					std::panic::resume_unwind(join_error.into_panic())
				},
				Err(join_error) => Err(error::ErrorKind::ThreadingError(join_error).into()),
			}
		} else {
			let cmd_context = ExecutionContext {
				shell:        &mut shell,
				command_name: self.command_name,
				params:       self.params,
			};

			execute_builtin_command(&builtin, cmd_context, self.args).await
		};

		// Update $_ after command execution.
		shell.update_last_arg_variable(last_arg);

		if let Some(post_execute) = self.post_execute {
			let _ = post_execute(&mut shell);
		}

		let result = result?;

		Ok(result.into())
	}

	async fn execute_via_function(
		mut self,
		func_registration: functions::Registration,
	) -> Result<ExecutionSpawnResult, error::Error> {
		// Only an external command's child can make deferred redirections.
		interp::materialize_deferred_redirects(&self.shell, &mut self.params).await?;
		let mut params = self.params;
		params.disable_command_output_marking();

		let last_arg = Self::take_last_arg(&self.args, &params).await?;

		match self.shell {
			// The function runs in an owned subshell (a pipeline stage or
			// async job): execute it as a task, mirroring
			// `execute_via_builtin_in_owned_shell`, so all pipeline stages run
			// concurrently and its output streams to the next stage as it is
			// produced.
			ShellForCommand::OwnedShell { target, .. } => {
				let mut shell = *target;
				let command_name = self.command_name;
				let args = self.args;
				let join_handle = tokio::spawn(async move {
					let cmd_context = ExecutionContext { shell: &mut shell, command_name, params };
					let result =
						invoke_shell_function(func_registration, cmd_context, &args[1..]).await;

					// $_ is reset *after* the function body runs; see the
					// parent-shell path below.
					shell.update_last_arg_variable(last_arg);

					match result?.wait().await? {
						ExecutionWaitResult::Completed(result) => Ok(result),
						ExecutionWaitResult::Stopped(_) => Ok(ExecutionResult::stopped()),
					}
				});
				Ok(ExecutionSpawnResult::StartedTask(join_handle))
			},
			mut shell => {
				let cmd_context = ExecutionContext {
					shell:        &mut shell,
					command_name: self.command_name,
					params,
				};

				// Strip the function name off args.
				let result = invoke_shell_function(func_registration, cmd_context, &self.args[1..]).await;

				// $_ is reset *after* the function body runs, to the last argument of
				// the invocation (or the function name itself if zero args). Any
				// mutations made inside the body are overwritten — this matches bash,
				// where the caller observes only the invocation's last argument.
				shell.update_last_arg_variable(last_arg);

				if let Some(post_execute) = self.post_execute {
					let _ = post_execute(&mut shell);
				}

				result
			},
		}
	}

	async fn execute_via_external(self, path: &Path) -> Result<ExecutionSpawnResult, error::Error> {
		let mut shell = self.shell;
		let last_arg = Self::take_last_arg(&self.args, &self.params).await?;

		let cmd_context = ExecutionContext {
			shell:        &mut shell,
			command_name: self.command_name,
			params:       self.params,
		};

		let resolved_path = path.to_string_lossy();
		let result = execute_external_command(
			cmd_context,
			resolved_path.as_ref(),
			self.in_pipeline,
			self.process_group_id,
			self.argv0.as_deref(),
			&self.args[1..],
		)
		.await;

		// Update $_ after command execution.
		shell.update_last_arg_variable(last_arg);

		if let Some(post_execute) = self.post_execute {
			let _ = post_execute(&mut shell);
		}

		result
	}
}

pub(crate) async fn execute_external_command(
	context: ExecutionContext<'_, impl extensions::ShellExtensions>,
	executable_path: &str,
	in_pipeline: bool,
	process_group_id: Option<i32>,
	argv0_override: Option<&str>,
	args: &[CommandArg],
) -> Result<ExecutionSpawnResult, error::Error> {
	// Filter out the args; we only want strings.
	let cmd_args = args
		.iter()
		.filter_map(|e| {
			if let CommandArg::String(s) = e {
				Some(s)
			} else {
				None
			}
		})
		.collect::<Vec<_>>();

	// Before we lose ownership of the open files, figure out if stdin will be a
	// terminal. A deferred redirection of fd 0 is made in the child before the
	// command runs (see `interp::DeferredRedirect`), so what this process holds
	// there, which can still be its terminal, is not the command's input.
	let child_stdin_is_terminal = !context.params.sets_deferred(openfiles::OpenFiles::STDIN_FD)
		&& context
			.try_fd(openfiles::OpenFiles::STDIN_FD)
			.is_some_and(|f| f.is_terminal());

	// Figure out if we should be setting up a new process group.
	let new_pg = matches!(context.params.process_group_policy, ProcessGroupPolicy::NewProcessGroup);
	let session_action = child_session_action(new_pg, child_stdin_is_terminal, in_pipeline);

	// Compose the std::process::Command that encapsulates what we want to launch.
	// argv[0] defaults to context.command_name (the user-facing name of the
	// command) unless the caller specified an explicit override.
	//
	// Nothing here checks whether the operating system will take the
	// arguments and environment: an argument or variable too long for it is
	// refused by the spawn, with the spawn's own error, in the spawn's own
	// order of checks. What keeps a long one from holding the worker is where
	// it is copied and where the command starts (`ComposedCommand`).
	let argv0 = argv0_override.unwrap_or(context.command_name.as_str());
	let mut composed = if context.params.deferred_redirects().is_empty() {
		compose_std_command(
			&context,
			executable_path,
			argv0,
			&[],
			cmd_args.as_slice(),
			false, /* empty environment? */
		)
		.await?
	} else {
		// Redirections to a FIFO left for the child (see
		// `interp::DeferredRedirect`): `/bin/sh` makes them and then execs the
		// command in place, so the pid the shell tracks is the command's. Its
		// argv[0] is then the resolved path. The arguments are passed through
		// as they are, not copied: one can be any length.
		let script = interp::deferred_redirect_script(context.params.deferred_redirects());
		let leading = ["-c", script.as_str(), "sh", executable_path];
		compose_std_command(&context, "/bin/sh", "sh", &leading, cmd_args.as_slice(), false).await?
	};
	let mut marker_output = prepare_output_markers(&context, executable_path, cmd_args.as_slice());

	// Set up process group/session state.
	//
	// A child we are about to `setsid()` (`DetachSession`) must NOT also be
	// handed a `process_group(...)`. For a would-be new-group leader it would
	// duplicate the group `setsid` already creates; for a pipeline stage joining
	// an established group it is a cross-session `setpgid` that fails with EPERM
	// now that the leader (and every prior stage) has moved into its own session.
	// In both cases `setsid` alone gives the child its own session and process
	// group. See `child_session_action` for the decision rationale.
	let command_leads_session = new_pg
		&& matches!(session_action, ChildSessionAction::TakeForeground)
		&& context.shell.options().external_cmd_leads_session;

	let cmd = composed.command_mut();
	match session_action {
		ChildSessionAction::DetachSession => {
			// setsid() creates the fresh session + process group; no process_group().
			// A reparenting operand (`nohup cmd &`) additionally double-forks so it
			// leaves the host's descendant tree and survives the teardown walk.
			if context.params.detach_reparent {
				cmd.detach_session_reparent();
			} else {
				cmd.detach_session();
			}
		}
		ChildSessionAction::TakeForeground if command_leads_session => {
			// Don't set process_group(0) - setsid() in pre_exec will handle it.
			cmd.lead_session();
		}
		ChildSessionAction::TakeForeground => {
			// Foreground a child that is not leading its own session: create/join
			// the process group in the current session, then grab the terminal.
			if new_pg {
				cmd.process_group(0);
			} else if let Some(pgid) = process_group_id {
				cmd.process_group(pgid);
			}
			cmd.take_foreground();
		}
		ChildSessionAction::None => {
			// Normal case: create a new process group in the current session, or
			// join an established one (later pipeline stages).
			if new_pg {
				cmd.process_group(0);
			} else if let Some(pgid) = process_group_id {
				cmd.process_group(pgid);
			}
		}
	}

	match composed.start(sys::process::spawn).await? {
		Ok(child) => {
			// Retrieve the pid.
			#[expect(clippy::cast_possible_wrap)]
			let pid = child.id().map(|id| id as i32);
			let mut actual_pgid = process_group_id;
			if let Some(pid) = &pid {
				if new_pg {
					actual_pgid = Some(*pid);
				}
			} else {
				tracing::warn!("could not retrieve pid for child process");
			}

			// Report the spawned child for scoped teardown. Skipped for reparented
			// launches (`detach_reparent`, e.g. `nohup cmd &`): those double-fork
			// out of the descendant tree and must survive the host's cancellation
			// cleanup, so they are intentionally left unowned.
			if !context.params.detach_reparent
				&& let Some(observer) = context.params.spawn_observer()
				&& let Some(pid) = pid
			{
				observer.on_spawn(pid, actual_pgid);
			}

			let mut child_process = processes::ChildProcess::new(child, pid, actual_pgid);
			if let Some((output, markers)) = marker_output.take() {
				child_process.set_completion_marker(
					output,
					markers.end_marker_prefix,
					markers.end_marker_suffix,
				);
			}
			Ok(ExecutionSpawnResult::StartedProcess(child_process))
		},
		Err(spawn_err) => spawn_failed(context, marker_output, spawn_err),
	}
}

/// What a failed spawn reports: the completion marker with status 127, the
/// terminal taken back by an interactive shell, and the error.
fn spawn_failed(
	context: ExecutionContext<'_, impl extensions::ShellExtensions>,
	marker_output: Option<(openfiles::OpenFile, ExternalCommandOutputMarkers)>,
	spawn_err: io::Error,
) -> Result<ExecutionSpawnResult, error::Error> {
	if let Some((mut output, markers)) = marker_output {
		let _ = write_completion_marker(&mut output, &markers, 127);
	}

	if context.shell.options().interactive {
		sys::terminal::move_self_to_foreground()?;
	}

	if spawn_err.kind() == std::io::ErrorKind::NotFound {
		if !context.shell.working_dir().exists() {
			Err(error::ErrorKind::WorkingDirMissing(context.shell.working_dir().to_owned()).into())
		} else {
			Err(error::ErrorKind::CommandNotFound(context.command_name).into())
		}
	} else {
		Err(error::ErrorKind::FailedToExecuteCommand(context.command_name, spawn_err).into())
	}
}

fn prepare_output_markers<SE: extensions::ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	executable_path: &str,
	args: &[&String],
) -> Option<(openfiles::OpenFile, ExternalCommandOutputMarkers)> {
	let marker = context.params.command_output_marker()?;
	let markers = marker.markers_for_external_command(ExternalCommandInfo {
		command_name:    context.command_name.as_str(),
		executable_path,
		args:            args.iter().map(|arg| arg.as_str()).collect(),
	})?;
	let mut output = context.params.try_stdout(context.shell)?;
	if output.write_all(markers.start_marker.as_bytes()).is_err() {
		return None;
	}
	if output.flush().is_err() {
		return None;
	}
	Some((output, markers))
}

fn write_completion_marker(
	output: &mut openfiles::OpenFile,
	markers: &ExternalCommandOutputMarkers,
	exit_code: i32,
) -> io::Result<()> {
	write!(output, "{}{}{}", markers.end_marker_prefix, exit_code, markers.end_marker_suffix)?;
	output.flush()
}

async fn execute_builtin_command<SE: extensions::ShellExtensions>(
	builtin: &builtins::Registration<SE>,
	context: ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> Result<ExecutionResult, error::Error> {
	// In POSIX mode, special builtins that return errors are to be treated as
	// fatal.
	let mark_errors_fatal = builtin.special_builtin && context.shell.options().posix_mode;

	match (builtin.execute_func)(context, args).await {
		Ok(result) => Ok(result),
		Err(e) => {
			// Broken pipe errors should silently return the appropriate exit code
			if let Some(io_err) = e.as_io_error() {
				if io_err.kind() == std::io::ErrorKind::BrokenPipe {
					return Ok(ExecutionExitCode::from(io_err).into());
				}
			}

			Err(if mark_errors_fatal { e.into_fatal() } else { e })
		},
	}
}

pub(crate) async fn invoke_shell_function(
	function: functions::Registration,
	mut context: ExecutionContext<'_, impl extensions::ShellExtensions>,
	args: &[CommandArg],
) -> Result<ExecutionSpawnResult, error::Error> {
	let ast::FunctionBody(body, redirects) = &function.definition().body;

	// Apply any redirects specified at function definition-time.
	if let Some(redirects) = redirects {
		for redirect in &redirects.0 {
			interp::setup_redirect(context.shell, &mut context.params, redirect).await?;
		}
	}

	// A function's positional parameters are copies of the command's
	// arguments, and an argument is whatever the command line expanded to:
	// `f "$huge"` spent **26.113 ms** building this list before the function
	// body had started. Charging the copy is not dividing it, and the charge
	// used to come after an undivided `to_string`, which kept 25.969 ms of it.
	// Charged by the step as well as the bytes, so a function called with a
	// million small arguments yields as surely as one called with a single
	// huge one.
	let mut positional_args = Vec::with_capacity(args.len());
	let mut budget = interp::ElementBudget::new();
	for arg in args {
		let short = match arg {
			CommandArg::String(text) if text.len() <= interp::DIVIDE_COPY_ABOVE_BYTES => Some(text),
			_ => None,
		};
		let due = budget.charge(short.map_or(0, String::len));
		if due > 0 {
			interp::loop_checkpoints(&context.params, due).await?;
		}
		positional_args.push(match short {
			Some(text) => text.clone(),
			None => render_argument(&context.params, arg).await?,
		});
	}
	let positional_args = positional_args.into_iter();

	// Pass through open files.
	let params = context.params.clone();

	// Note that we're going deeper. Once we do this, we need to make sure we don't
	// bail early before "exiting" the function.
	context.shell.enter_function(
		context.command_name.as_str(),
		&function,
		positional_args,
		&context.params,
	)?;

	// Invoke the function.
	let result = body.execute(context.shell, &params).await;

	// Clean up parameters so any owned files are closed.
	drop(params);

	// We've come back out, reflect it.
	context.shell.leave_function()?;

	// Get the actual execution result from the body of the function.
	let mut result = result?;

	// Handle control-flow.
	match result.next_control_flow {
		ExecutionControlFlow::BreakLoop { .. } => {
			context
				.params
				.stderr(context.shell)
				.write_all_async(b"break: only meaningful in a `for', `while', or `until' loop\n")
				.await?;
			result.next_control_flow = ExecutionControlFlow::Normal;
		},
		ExecutionControlFlow::ContinueLoop { .. } => {
			context
				.params
				.stderr(context.shell)
				.write_all_async(b"continue: only meaningful in a `for', `while', or `until' loop\n")
				.await?;
			result.next_control_flow = ExecutionControlFlow::Normal;
		},
		ExecutionControlFlow::ReturnFromFunctionOrScript => {
			// It's now been handled.
			result.next_control_flow = ExecutionControlFlow::Normal;
		},
		_ => {},
	}

	Ok(result.into())
}

pub(crate) async fn invoke_command_in_subshell_and_get_output(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	s: String,
) -> Result<String, error::Error> {
	// Instantiate a subshell to run the command in.
	let mut subshell = shell.clone_divided(params).await?;

	// Command substitutions don't inherit errexit by default. Only inherit it when
	// command_subst_inherits_errexit is enabled, otherwise disable errexit in the
	// subshell.
	if !shell.options().command_subst_inherits_errexit {
		subshell.options_mut().exit_on_nonzero_command_exit = false;
	}

	// Get our own set of parameters we can customize and use.
	let mut params = params.clone();
	params.process_group_policy = ProcessGroupPolicy::SameProcessGroup;
	params.disable_command_output_marking();

	// A subshell that is only an input redirection ("< file") has no command to
	// run and no output of its own: it is the file. Parse here, before the pipe
	// exists, and read the file straight into the result. Routing it through a
	// pipe that this same task then drains is what let `$(<file)` take the
	// runtime: the write parks a thread until the drain makes room, and the
	// drain cannot run while a worker is parked. See `openfiles::copy_async`.
	let parse_result = subshell.parse_string_off_worker(s).await?;
	if let Ok(program) = &parse_result
		&& let Some(redir) = try_unwrap_bare_input_redir_program(program)
	{
		interp::setup_redirect(&mut subshell, &mut params, redir).await?;
		let contents = openfiles::read_to_end_detached(params.stdin(&subshell)).await?;
		shell.set_last_exit_status(0);
		return String::from_utf8(contents).map_err(|_invalid| {
			error::Error::from(std::io::Error::from(std::io::ErrorKind::InvalidData))
		});
	}

	// Set up pipe so we can read the output.
	let (reader, writer) = std::io::pipe()?;
	params.set_fd(OpenFiles::STDOUT_FD, writer.into());

	let mut async_reader = sys::async_pipe::AsyncPipeReader::new(reader)?;

	let cmd_join_handle = tokio::spawn(run_substitution_command(subshell, params, parse_result));

	let output_str = async_reader.read_to_string().await?;

	// Now observe the command's completion.
	let run_result = cmd_join_handle.await?;
	let cmd_result = run_result?;

	// Store the status.
	shell.set_last_exit_status(cmd_result.exit_code.into());

	// Note: $_ is naturally isolated from the parent because we cloned the
	// shell to run the substitution.

	Ok(output_str)
}

async fn run_substitution_command(
	mut shell: Shell<impl extensions::ShellExtensions>,
	params: ExecutionParameters,
	parse_result: Result<ast::Program, brush_parser::ParseError>,
) -> Result<ExecutionResult, error::Error> {
	// TODO(source-info): review this
	let source_info = crate::SourceInfo::from("main");

	// Handle the parse result using default shell behavior.
	shell
		.run_parsed_result(parse_result, &source_info, &params)
		.await
}

// Detects a subshell command that consists solely of a single input redirection
// (e.g., "< file"), returning the IoRedirect when present.
fn try_unwrap_bare_input_redir_program(program: &ast::Program) -> Option<&ast::IoRedirect> {
	// We're looking for exactly one complete command...
	let [complete] = program.complete_commands.as_slice() else {
		return None;
	};

	// ...a single list item...
	let ast::CompoundList(items) = complete;
	let [item] = items.as_slice() else {
		return None;
	};

	// ...with a single pipeline (no && or || chaining)...
	let and_or = &item.0;
	if !and_or.additional.is_empty() {
		return None;
	}

	// ...not negated...
	let pipeline = &and_or.first;
	if pipeline.bang {
		return None;
	}

	// ...with a single command in the pipeline...
	let [ast::Command::Simple(simple_cmd)] = pipeline.seq.as_slice() else {
		return None;
	};

	// ...with no program word/name and no suffix...
	if simple_cmd.word_or_name.is_some() || simple_cmd.suffix.is_some() {
		return None;
	}

	// ...and exactly one prefix containing an I/O redirect...
	let prefix = simple_cmd.prefix.as_ref()?;
	let [ast::CommandPrefixOrSuffixItem::IoRedirect(redir)] = prefix.0.as_slice() else {
		return None;
	};

	// ...that is a file input redirection to a filename, targeting stdin.
	match redir {
		ast::IoRedirect::File(
			fd,
			ast::IoFileRedirectKind::Read,
			ast::IoFileRedirectTarget::Filename(..),
		) if fd.is_none_or(|fd| fd == openfiles::OpenFiles::STDIN_FD) => Some(redir),
		_ => None,
	}
}

/// What to do with the child's controlling-tty/session ownership immediately
/// before spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildSessionAction {
	/// Call `setsid()` (via `cmd.detach_session()`) so the child cannot stop
	/// the parent through SIGTTIN/SIGTTOU on the inherited tty.
	DetachSession,
	/// Move the child to the foreground of its tty so it participates in
	/// interactive job control.
	TakeForeground,
	/// Leave session/foreground state alone.
	None,
}

/// Decide whether to detach the child's session, foreground it, or do nothing.
///
/// The pre-fix code only detached when `new_pg` was set, which is gated on
/// brush's interactive job-control path. When brush is embedded in a
/// non-interactive host (e.g. `pi-natives` inside OMP), `new_pg` is false, the
/// child inherited the host's controlling tty, and any `/dev/tty` open or
/// `tcsetpgrp` call from the child could SIGTTIN/SIGTTOU and stop the host.
///
/// A child whose stdin is **not** a terminal therefore always detaches, even
/// when it is a stage of a multi-command pipeline. An interactive program in a
/// pipeline (`zsh -i ... | awk`) would otherwise open `/dev/tty`, `tcsetpgrp`
/// itself to the foreground, and leave the host stopped on its next tty read.
/// `setsid()` puts each stage in its own session with no controlling tty, so it
/// cannot reach `/dev/tty` at all. The historical EPERM hazard — a later stage
/// `setpgid()`-joining a leader that already moved to a new session — is avoided
/// in `execute_external_command`, which skips `process_group(...)` entirely for
/// detached children; pipeline stages no longer share one process group, which
/// the embedded host does not rely on (it cancels via the descendant tree, and
/// pipes are session-independent).
///
/// `in_pipeline_group` is no longer consulted: a pipeline stage that legitimately
/// needs the shared tty group has terminal stdin and is handled by the
/// `child_stdin_is_terminal` arm before pipeline membership would ever matter.
///
/// Foregrounding remains gated on `new_pg && child_stdin_is_terminal`.
pub const fn child_session_action(
	new_pg: bool,
	child_stdin_is_terminal: bool,
	_in_pipeline_group: bool,
) -> ChildSessionAction {
	if new_pg && child_stdin_is_terminal {
		return ChildSessionAction::TakeForeground;
	}

	if child_stdin_is_terminal {
		return ChildSessionAction::None;
	}

	ChildSessionAction::DetachSession
}
