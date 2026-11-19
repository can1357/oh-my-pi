//! pi's extras that run command lines (`env`, `ifne`, `xargs`, `find
//! -exec`): the utility runs on the session's runtime like any extra
//! ([`crate::extras`]), and its [`CommandRunner`] hands each command to the
//! driver, which runs it in a subshell of the caller.
//!
//! As in pi, a command is looked up before it runs, so the utility reports
//! a missing or unexecutable command in its own words (`xargs: nope: No such
//! file or directory`, status 127): a builtin (an engine intrinsic, a tool or
//! an extra) runs through `command`, so shell functions never run, as in
//! pi's earlier shell; any other name is searched on the
//! command's own `PATH` (with environment changes applied; the C library's
//! default path without one) and runs by absolute path through `exec -a`, so
//! the program sees the name it was asked for. A command line
//! ([`ShellCommand::line`]: `awk`'s `system()` and pipes) is not looked up:
//! its source runs verbatim in the subshell, with no positional parameters,
//! so pi's builtins and `scheme://` paths work in it and a missing command is
//! the shell's own diagnostic and status 127. Environment changes (`env -i`,
//! `-u`, `NAME=VALUE`) apply in the subshell before the command, in order.
//!
//! The subshell's stdin is what the utility asks for (the null device by
//! default; `env`'s own stdin is the caller's fd 0); stdout and stderr are the
//! caller's, which the utility writes to as well, so their output interleaves
//! in order. Each subshell carries the call's lineage label, so a signal to
//! the utility's job reaches its commands too. Externals replace their
//! subshell through `exec`, so their actual signal deaths reach the utility
//! as [`CommandStatus::Signaled`], distinct from an ordinary exit of `128+n`.
//! In-engine commands report [`CommandStatus::Exited`].
//!
//! A command the utility may signal ([`ShellCommand::signals`]: `watchexec`,
//! `entr -r`) runs under a label of its own below the call's, so each signal
//! reaches that command's tree alone, as one to its process group would;
//! `KILL` also goes to the externals the tree left running, as for `timeout`.

use std::{
	ffi::OsStr,
	future::Future,
	io,
	path::PathBuf,
	pin::Pin,
	sync::Arc,
	task::{Context, Poll, Waker},
};

use bstr::{BString, ByteSlice};
use omp_builtins::extras::{CommandRunner, CommandStatus, EnvChange, Fd, ShellCommand};
use tokio_util::sync::CancellationToken;

use super::{Child, ToolConfig, Turn, signal_os};
use crate::{
	bash::{
		CallOutcome, IntrinsicId, Lineage, ModeId, Platform, RunId, RunStdio, Script, ShellApi,
		SigTarget, Signal, ToolCall, VprocSel,
	},
	extras::Done,
	sys::StdFile,
};

/// `execvp`'s search path when a command's environment has no `PATH`.
const DEFAULT_PATH: &str = if cfg!(any(target_os = "linux", target_os = "android")) {
	"/bin:/usr/bin"
} else {
	"/usr/bin:/bin"
};

/// How a command a utility asked for ended, back to the utility.
type Reply = flume::Sender<io::Result<CommandStatus>>;

/// What the utility asks of the driver.
enum Request {
	/// Run a command.
	Run {
		command:   Box<ShellCommand>,
		program:   Program,
		reply:     Reply,
		/// The id later [`Request::Signal`]s name the command by; `None` when
		/// the utility sends it no signals.
		signalled: Option<u64>,
	},
	/// Deliver the signal numbered `signal` to the tree of the command `id`.
	Signal { id: u64, signal: i32 },
}

/// A command's subshell, still running.
struct Run {
	id:    RunId,
	reply: Reply,
	/// The id and label of a command the utility may signal: its tree has a
	/// label of its own.
	own:   Option<(u64, u32)>,
}

/// What a requested command is, decided by the lookup before it is sent.
enum Program {
	/// A builtin: runs through `command`.
	Builtin,
	/// A program at this path: runs through `exec -a`.
	Path(PathBuf),
	/// A command line: its source runs as it is.
	Line,
}

/// The utility, once started.
struct Running {
	done:      Arc<Done>,
	cancel:    CancellationToken,
	requests:  flume::Receiver<Request>,
	env_names: Vec<BString>,
}

/// A call of an extra that runs command lines.
pub(super) struct Extra {
	/// Only the label: the lineage of every command's subshell.
	pub(super) child: Child,
	/// The call, until the utility starts.
	call:             Option<ToolCall>,
	running:          Option<Running>,
	/// The commands' subshells still running, with their replies.
	runs:             Vec<Run>,
	/// Labels of signalled commands that ended since the last turn.
	ended:            Vec<u32>,
	/// Labels of ended signalled commands, for the next one: a utility
	/// restarting its command for days holds one label, not one per run.
	spare:            Vec<u32>,
}

impl Extra {
	pub(super) fn new(call: ToolCall) -> Self {
		Self {
			child:   Child::default(),
			call:    Some(call),
			running: None,
			runs:    Vec::new(),
			ended:   Vec::new(),
			spare:   Vec::new(),
		}
	}

	pub(super) fn advance(
		&mut self,
		api: &mut ShellApi<'_, '_>,
		turn: &mut Turn<'_>,
	) -> Option<CallOutcome> {
		if let Some(call) = self.call.take() {
			let Some(runtime) = turn.config.runtime.clone() else {
				return Some(CallOutcome::Error("pi's extras need a runtime".into()));
			};
			self.child.label = turn.labels.fresh(api.lineage().label);
			let (requests, received) = flume::unbounded();
			let cancel = CancellationToken::new();
			let mut invocation = crate::extras::invocation(
				&call.argv,
				&call.env,
				call.cwd.as_bstr(),
				&call.stdio,
				&call.extra_fds,
				call.umask,
				turn.config,
			);
			invocation.cancel = Some(cancel.clone());
			let lookup = Lookup {
				path:   invocation.env.get("PATH").cloned(),
				cwd:    invocation.cwd.clone(),
				config: turn.config.clone(),
			};
			invocation.commands =
				Some(Box::new(Runner { requests, waker: turn.waker.clone(), lookup, signalled: 0 }));
			let done = crate::extras::spawn(&runtime, invocation);
			let env_names = call
				.env
				.iter()
				.map(|(name, _)| BString::from(name))
				.collect();
			self.running = Some(Running { done, cancel, requests: received, env_names });
		}
		// The externals of an ended command are no longer its label's.
		for label in self.ended.drain(..) {
			turn.log.forget(&[label]);
			self.spare.push(label);
		}
		let running = self.running.as_ref()?;
		while let Ok(request) = running.requests.try_recv() {
			match request {
				Request::Run { command, program, reply, signalled } => {
					let own = signalled.map(|id| {
						let label = self
							.spare
							.pop()
							.unwrap_or_else(|| turn.labels.fresh(self.child.label));
						(id, label)
					});
					let label = own.map_or(self.child.label, |(_, label)| label);
					let lineage = Lineage { label, detached: false };
					let id =
						api.run_subshell_in(script(*command, &program, &running.env_names), lineage);
					self.runs.push(Run { id, reply, own });
				},
				Request::Signal { id, signal } => {
					// A command that ended already has no tree to signal.
					let label = self
						.runs
						.iter()
						.find_map(|run| run.own.filter(|&(own, _)| own == id))
						.map(|(_, label)| label);
					let signal = u8::try_from(signal)
						.ok()
						.and_then(|number| Signal::from_number(number, Platform::current()));
					if let (Some(label), Some(signal)) = (label, signal) {
						signal_tree(turn, label, signal);
					}
				},
			}
		}
		match running.done.poll(&Context::from_waker(turn.waker)) {
			// The utility waits for every command it started; one whose
			// reply nobody awaits any more still ends before the call does.
			Poll::Ready(code) if self.runs.is_empty() => Some(CallOutcome::Exit(code)),
			_ => None,
		}
	}

	/// `run` ended with `status`; `false` when it is not one of this call's
	/// commands.
	pub(super) fn on_done(&mut self, run: RunId, status: i32, signal: Option<i32>) -> bool {
		let Some(at) = self.runs.iter().position(|r| r.id == run) else {
			return false;
		};
		let Run { reply, own, .. } = self.runs.swap_remove(at);
		self.ended.extend(own.map(|(_, label)| label));
		let code = u8::try_from(status.rem_euclid(256)).unwrap_or(u8::MAX);
		// The utility may have stopped waiting (cancelled).
		let outcome = signal.map_or(CommandStatus::Exited(code), CommandStatus::Signaled);
		let _ = reply.send(Ok(outcome));
		true
	}

	/// The commands' subshells still running.
	pub(super) fn pending(&self) -> Vec<RunId> {
		self.runs.iter().map(|run| run.id).collect()
	}
}

impl Drop for Extra {
	/// An abandoned call (its caller was cancelled or killed) cancels the
	/// utility, which unwinds on the runtime; the replies of its commands
	/// are dropped, so it stops waiting for them.
	fn drop(&mut self) {
		if let Some(running) = &self.running {
			running.cancel.cancel();
		}
	}
}

/// Send `signal` to the tree of the command labeled `label` and, for `KILL`,
/// to the externals it started (each leads its own process group).
fn signal_tree(turn: &Turn<'_>, label: u32, signal: Signal) {
	let group = turn.labels.group(label);
	for &label in &group {
		turn.ctl.signal(SigTarget::Label(label), signal);
	}
	// The tree's live externals get the signal from the engine; those it
	// already abandoned are reached here, but only by the uncatchable `KILL`
	// (a trapped signal must not run its handler twice).
	if signal == Signal::Kill {
		for pid in turn.log.live(&group) {
			signal_os(pid, signal, true);
		}
	}
}

/// The script of one command: its environment changes, then the command,
/// with the argv as the positional parameters (a command line runs verbatim,
/// with none).
fn script(mut command: ShellCommand, program: &Program, env_names: &[BString]) -> Script {
	let stdin = child_stdin(command.take_stdin());
	let mut source = Vec::new();
	let mut foreign_env = Vec::new();
	let mut unexport_env = Vec::new();
	for change in command.env_changes() {
		match change {
			// Every variable goes (a readonly one stops being exported), and
			// every function, so no `BASH_FUNC_` export is left either.
			EnvChange::Clear => {
				foreign_env.push((None, None));
				// Unsetting a command-prefix or local binding would uncover
				// an exported outer one, so every name in the call's
				// environment is masked too ([`Script::unexport_env`]).
				for name in env_names {
					if let Ok(name) = std::str::from_utf8(name)
						&& is_name(name)
					{
						unexport_env.push(BString::from(name));
						source.extend_from_slice(b"unset -v ");
						source.extend_from_slice(name.as_bytes());
						source.extend_from_slice(b" 2>/dev/null || export -n ");
						source.extend_from_slice(name.as_bytes());
						source.extend_from_slice(b" 2>/dev/null; ");
					}
				}
				// The tool profile has no `compgen`: every variable name comes
				// from `${!X@}` over each possible first character, and every
				// function from `declare -F` (`declare -f[x…] name` lines).
				source.extend_from_slice(b"for __pi_var in");
				for first in (b'A'..=b'Z').chain(b'a'..=b'z').chain(*b"_") {
					source.extend_from_slice(b" ${!");
					source.push(first);
					source.extend_from_slice(b"@}");
				}
				source.extend_from_slice(
					b"; do unset -v \"$__pi_var\" 2>/dev/null \
					  || export -n \"$__pi_var\" 2>/dev/null; done; unset -v __pi_var; \
					  while read -r _ _ __pi_fn; do [ -n \"$__pi_fn\" ] && unset -f \"$__pi_fn\"; \
					  done <<< \"$(declare -F)\"; unset -v __pi_fn; ",
				);
			},
			EnvChange::Remove(name) if is_name(name) => {
				unexport_env.push(BString::from(name.as_bytes()));
				source.extend_from_slice(b"unset -v ");
				source.extend_from_slice(name.as_bytes());
				source.extend_from_slice(b" 2>/dev/null || export -n ");
				source.extend_from_slice(name.as_bytes());
				source.extend_from_slice(b" 2>/dev/null; ");
			},
			EnvChange::Set(name, value) if is_name(name) => {
				source.extend_from_slice(b"export ");
				source.extend_from_slice(name.as_bytes());
				source.push(b'=');
				quote(&mut source, value.as_bytes());
				source.extend_from_slice(b"; ");
			},
			EnvChange::Remove(name) => foreign_env.push((Some(BString::from(name.as_bytes())), None)),
			EnvChange::Set(name, value) => foreign_env
				.push((Some(BString::from(name.as_bytes())), Some(BString::from(value.as_bytes())))),
		}
	}
	let mut args: Vec<BString> = command.args().iter().map(|arg| os_bytes(arg)).collect();
	match program {
		Program::Line => {
			if let Some(line) = command.source() {
				source.extend_from_slice(line.as_encoded_bytes());
			}
		},
		Program::Builtin => source.extend_from_slice(b"command -- \"$@\""),
		Program::Path(path) => {
			let argv0 = command
				.presented_argv0()
				.map_or_else(|| args[0].clone(), os_bytes);
			source.extend_from_slice(b"exec -a ");
			quote(&mut source, &argv0);
			source.extend_from_slice(b" -- \"$@\"");
			args[0] = os_bytes(path.as_os_str());
		},
	}
	let mut script = Script::command(source);
	script.foreign_env = foreign_env;
	script.unexport_env = unexport_env;
	script.args = Some(args);
	// The working directory is logical, as after `cd`: `-execdir` hands over
	// `<root>/./sub`, and the command's `$PWD` is `<root>/sub`.
	script.cwd = command
		.dir()
		.map(|dir| os_bytes(omp_vfs::normalize_lexically(dir).as_os_str()));
	script.vproc = VprocSel::NewSubshellWithStdio([stdin, RunStdio::Inherit, RunStdio::Inherit]);
	script
}

/// fd 0 of a command: the null device unless the utility gave one. A host
/// descriptor goes in as it is; a provider file (an engine object the
/// utility got as one, which only `env` passes on: its own stdin) is the
/// caller's fd 0.
fn child_stdin(stdin: Option<Fd>) -> RunStdio {
	let file = match stdin {
		None => std::fs::File::open(if cfg!(windows) { "NUL" } else { "/dev/null" }),
		Some(Fd::File(file)) => Ok(file),
		Some(Fd::Vfs(_)) => return RunStdio::Inherit,
		Some(Fd::Closed) => return RunStdio::Closed,
	};
	file.map_or(RunStdio::Closed, |file| RunStdio::File(Box::new(StdFile::new(file))))
}

fn os_bytes(s: &OsStr) -> BString {
	BString::from(s.as_encoded_bytes())
}

/// A shell variable name.
fn is_name(name: &str) -> bool {
	let mut bytes = name.bytes();
	bytes
		.next()
		.is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
		&& bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Append `word` single-quoted.
fn quote(out: &mut Vec<u8>, word: &[u8]) {
	out.push(b'\'');
	for &c in word {
		if c == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else {
			out.push(c);
		}
	}
	out.push(b'\'');
}

/// The utility's [`CommandRunner`]: looks each command up, then sends it to
/// the driver and waits for its reply.
struct Runner {
	requests:  flume::Sender<Request>,
	/// Wakes the driver.
	waker:     Waker,
	lookup:    Lookup,
	/// The id of the last command the utility may signal.
	signalled: u64,
}

impl CommandRunner for Runner {
	fn start(
		&mut self,
		mut command: ShellCommand,
	) -> Pin<Box<dyn Future<Output = io::Result<CommandStatus>> + Send + 'static>> {
		let signals = command.take_signals().map(|signals| {
			self.signalled += 1;
			(signals, self.signalled, self.requests.clone(), self.waker.clone())
		});
		let signalled = signals.as_ref().map(|&(_, id, ..)| id);
		let response = self.lookup.program(&command).map(|program| {
			let (reply, response) = flume::bounded(1);
			let sent = self
				.requests
				.send(Request::Run { command: Box::new(command), program, reply, signalled })
				.is_ok();
			self.waker.wake_by_ref();
			sent.then_some(response)
		});
		Box::pin(async move {
			let response = response?.ok_or_else(cancelled)?;
			let Some((signals, id, requests, waker)) = signals else {
				return response.recv_async().await.map_err(|_| cancelled())?;
			};
			// Hand the driver each signal until the command ends.
			let mut signals = Some(signals);
			loop {
				let next = async {
					match &signals {
						Some(signals) => signals.recv_async().await.ok(),
						None => std::future::pending().await,
					}
				};
				tokio::select! {
					biased;
					outcome = response.recv_async() => return outcome.map_err(|_| cancelled())?,
					signal = next => match signal {
						Some(signal) => {
							let _ = requests.send(Request::Signal { id, signal });
							waker.wake_by_ref();
						},
						// The utility sends no more.
						None => signals = None,
					},
				}
			}
		})
	}
}

/// The error a utility sees once the driver dropped its command unanswered:
/// the call was abandoned.
fn cancelled() -> io::Error {
	io::Error::new(io::ErrorKind::Interrupted, "command cancelled")
}

/// What a command name runs, as of the utility's start.
struct Lookup {
	/// The utility's `PATH`.
	path:   Option<String>,
	/// The utility's working directory.
	cwd:    PathBuf,
	config: ToolConfig,
}

impl Lookup {
	/// How `command` runs; `NotFound` when nothing has its name,
	/// `PermissionDenied` when only files that cannot be executed have it.
	fn program(&self, command: &ShellCommand) -> io::Result<Program> {
		if command.source().is_some() {
			return Ok(Program::Line);
		}
		let name = command
			.args()
			.first()
			.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
		let cwd = command.dir().unwrap_or(&self.cwd);
		if has_separator(name) {
			return match executable(cwd.join(name)) {
				Some(Candidate::Runs(file)) => Ok(Program::Path(file)),
				Some(Candidate::Denied) => Err(io::ErrorKind::PermissionDenied.into()),
				None => Err(io::ErrorKind::NotFound.into()),
			};
		}
		if self.builtin(name) {
			return Ok(Program::Builtin);
		}
		let path = command
			.env_changes()
			.iter()
			.fold(self.path.as_deref(), |path, change| match change {
				EnvChange::Clear => None,
				EnvChange::Remove(var) if var == "PATH" => None,
				EnvChange::Set(var, value) if var == "PATH" => Some(value.as_str()),
				_ => path,
			})
			.unwrap_or(DEFAULT_PATH);
		let mut denied = false;
		for dir in std::env::split_paths(OsStr::new(path)) {
			match executable(cwd.join(dir).join(name)) {
				Some(Candidate::Runs(file)) => return Ok(Program::Path(file)),
				Some(Candidate::Denied) => denied = true,
				None => {},
			}
		}
		let kind = if denied {
			io::ErrorKind::PermissionDenied
		} else {
			io::ErrorKind::NotFound
		};
		Err(kind.into())
	}

	/// Whether `name` runs in-process: an engine intrinsic, a tool, an extra
	/// this shell offers, or a shell the engine runs itself (`env bash -c …`,
	/// `xargs sh -c …`; [`PiHost::resolve`](crate::host::PiHost)).
	fn builtin(&self, name: &OsStr) -> bool {
		let name = os_bytes(name);
		IntrinsicId::lookup(&name, ModeId::Bash).is_some()
			|| self.config.lookup(name.as_bstr()).is_some()
			|| self.config.native_extra(name.as_bstr()).is_some()
			|| crate::sys::shebang::is_self_shell(&name)
	}
}

fn has_separator(name: &OsStr) -> bool {
	let bytes = name.as_encoded_bytes();
	bytes.contains(&b'/') || (cfg!(windows) && bytes.contains(&b'\\'))
}

/// A file found for a command name.
enum Candidate {
	/// The file that runs.
	Runs(PathBuf),
	/// A file that cannot be executed (Unix only).
	#[cfg_attr(not(unix), expect(dead_code, reason = "only Unix has execute bits"))]
	Denied,
}

/// What `path` names as a command; `None` for nothing (or a directory).
#[cfg(unix)]
fn executable(path: PathBuf) -> Option<Candidate> {
	use std::os::unix::fs::PermissionsExt as _;
	let meta = std::fs::metadata(&path)
		.ok()
		.filter(std::fs::Metadata::is_file)?;
	Some(if meta.permissions().mode() & 0o111 != 0 {
		Candidate::Runs(path)
	} else {
		Candidate::Denied
	})
}

/// What `path` names as a command: the file itself, else the file with `.exe`
/// appended (as a shell's `PATHEXT` search does, so `python3.11` finds
/// `python3.11.exe`, not `python3.exe`); `None` for nothing (or a directory).
#[cfg(not(unix))]
fn executable(path: PathBuf) -> Option<Candidate> {
	if path.is_file() {
		return Some(Candidate::Runs(path));
	}
	let mut exe = path.into_os_string();
	exe.push(".exe");
	let exe = PathBuf::from(exe);
	exe.is_file().then_some(Candidate::Runs(exe))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn quoting_survives_single_quotes() {
		let mut out = Vec::new();
		quote(&mut out, b"it's");
		assert_eq!(out, b"'it'\\''s'");
	}

	#[test]
	fn only_shell_names_are_variables() {
		assert!(is_name("PATH"));
		assert!(is_name("_x1"));
		assert!(!is_name("1x"));
		assert!(!is_name("a-b"));
		assert!(!is_name(""));
	}

	#[cfg(not(unix))]
	#[test]
	fn a_dotted_name_runs_its_own_exe() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("python3.11.exe"), b"").unwrap();
		std::fs::write(dir.path().join("python3.exe"), b"").unwrap();
		let Some(Candidate::Runs(file)) = executable(dir.path().join("python3.11")) else {
			panic!("python3.11 did not resolve");
		};
		assert_eq!(file, dir.path().join("python3.11.exe"));
		assert!(executable(dir.path().join("missing")).is_none());
	}
}
