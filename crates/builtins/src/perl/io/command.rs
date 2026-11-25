use std::{
	cell::RefCell,
	io::{self, Read},
	path::PathBuf,
	rc::Rc,
	sync::{Arc, atomic::{AtomicBool, Ordering}},
	time::Duration,
};

use crate::{
	host::{CommandStatus, Host, RunningCommand, ShellCommand},
	openfile::{Fd, OpenFile},
};

use super::{device::Device, os_string};

/// Child invocation for `system`, `qx`, and pipe opens.
#[derive(Clone, Copy, Debug)]
pub(in crate::perl) enum ShellSpec<'a> {
	/// Shell source run by the invoking shell.
	Line(&'a [u8]),
	/// Literal argument list; its first item is the command name.
	Argv(&'a [Vec<u8>]),
	/// `system {program} argv0, ...`: look up `program`, present `argv0`.
	Program {
		/// Program to resolve through the shell.
		program: &'a [u8],
		/// Child argv, beginning with the presented `argv[0]`.
		argv: &'a [Vec<u8>],
	},
}

impl ShellSpec<'_> {
	/// A single string with no word-generating syntax is executed as an
	/// argv on Unix. Besides avoiding the shell, this reports an exec
	/// failure as `$? == -1` rather than an ordinary shell exit 127.
	/// Build a Host command with Perl's literal-argv fast path for simple strings.
	pub(in crate::perl) fn exec_command(self) -> io::Result<ShellCommand> {
		if let Self::Line(line) = self && cfg!(unix) {
			let mut words = line.split(|b| b.is_ascii_whitespace()).filter(|word| !word.is_empty());
			if let Some(first) = words.next()
				&& !matches!(first, b"." | b"exec")
				&& !first.contains(&b'=')
				&& !line.iter().any(|b| b"$&*(){}[]'\";\\|?<>~`\n".contains(b))
			{
				if line.contains(&0) {
					return Err(io::ErrorKind::InvalidInput.into());
				}
				let argv = std::iter::once(first).chain(words).map(|word| os_string(word).into_owned()).collect();
				return Ok(ShellCommand::new(argv));
			}
		}
		self.command()
	}

	fn is_empty_line(self) -> bool {
		matches!(self, Self::Line(line) if line.iter().all(u8::is_ascii_whitespace))
	}

	/// Convert to a Host command without interpreting shell source.
	pub(super) fn command(self) -> io::Result<ShellCommand> {
		match self {
			Self::Line(line) => {
				if line.contains(&0) {
					return Err(io::ErrorKind::InvalidInput.into());
				}
				Ok(ShellCommand::line(os_string(line).into_owned()))
			},
			Self::Argv(argv) => {
				if argv.first().is_none_or(Vec::is_empty) {
					return Err(io::ErrorKind::NotFound.into());
				}
				if argv.iter().any(|a| a.contains(&0)) {
					return Err(io::ErrorKind::InvalidInput.into());
				}
				Ok(ShellCommand::new(argv.iter().map(|arg| os_string(arg).into_owned()).collect()))
			},
			Self::Program { program, argv } => {
				let (argv0, args) = argv.split_first().ok_or(io::ErrorKind::InvalidInput)?;
				if program.is_empty() {
					return Err(io::ErrorKind::NotFound.into());
				}
				if program.contains(&0) || argv.iter().any(|a| a.contains(&0)) {
					return Err(io::ErrorKind::InvalidInput.into());
				}
				let args = std::iter::once(program).chain(args.iter().map(Vec::as_slice))
					.map(|arg| os_string(arg).into_owned()).collect();
				Ok(ShellCommand::new(args).argv0(os_string(argv0).into_owned()))
			},
		}
	}
}

/// The Perl cwd and `%ENV` inherited by a child, without modifying its parent shell.
pub(in crate::perl) struct ChildContext {
	pub cwd: PathBuf,
	pub env: Vec<(Vec<u8>, Vec<u8>)>,
	streams: [Option<Fd>; 3],
}

impl ChildContext {
	/// Construct a context with the Host's normal stdin, stdout and stderr.
	pub fn new(cwd: PathBuf, env: Vec<(Vec<u8>, Vec<u8>)>) -> Self {
		Self { cwd, env, streams: [None, None, None] }
	}

	/// Override one standard descriptor from an interpreter-owned PerlIO slot.
	pub fn set_stream(&mut self, index: usize, descriptor: Fd) {
		if let Some(slot) = self.streams.get_mut(index) { *slot = Some(descriptor); }
	}

	/// Apply this interpreter's cwd and environment to a child command.
	pub(in crate::perl) fn apply(&self, mut command: ShellCommand) -> ShellCommand {
		command = command.current_dir(&self.cwd).env_clear();
		for (name, value) in &self.env {
			if let (Ok(name), Ok(value)) = (std::str::from_utf8(name), std::str::from_utf8(value))
				&& !name.is_empty() && !name.contains(['\0', '=']) && !value.contains('\0')
			{
				command = command.env(name, value);
			}
		}
		for (index, fd) in self.streams.iter().enumerate() {
			let Some(fd) = fd.as_ref().and_then(|fd| fd.try_clone().ok()) else { continue; };
			command = match index { 0 => command.stdin(fd), 1 => command.stdout(fd), _ => command.stderr(fd) };
		}
		command
	}
}

fn in_context(command: ShellCommand, context: Option<&ChildContext>) -> ShellCommand {
	match context { Some(c) => c.apply(command), None => command }
}

type ChildResult = Result<i32, (io::ErrorKind, Option<i32>)>;

struct PipeState {
	// Host's nonblocking reap API consumes completed entries from a vector.
	running: Vec<RunningCommand>,
	status: Option<ChildResult>,
	#[cfg_attr(not(unix), expect(dead_code, reason = "kill is unix-only"))]
	signals: Option<flume::Sender<i32>>,
	/// The invocation's cancellation flag: a blocking reap gives up (leaving the child to the Host) once set.
	cancel: Option<Arc<AtomicBool>>,
}

/// A pipe's synthetic Perl child identity and reusable raw wait status.
#[derive(Clone)]
pub(in crate::perl) struct PipeChild {
	id: i32,
	state: Rc<RefCell<PipeState>>,
}

impl PipeChild {
	/// Associate a Host command with an interpreter-local identifier.
	/// `cancel` is the invocation's flag (`Host::cancel_flag`); blocking reaps poll it.
	pub(in crate::perl) fn new(id: i32, child: RunningCommand, cancel: Option<Arc<AtomicBool>>) -> Self {
		Self::with_signals(id, child, None, cancel)
	}

	pub(super) fn with_signals(id: i32, child: RunningCommand, signals: Option<flume::Sender<i32>>, cancel: Option<Arc<AtomicBool>>) -> Self {
		Self { id, state: Rc::new(RefCell::new(PipeState { running: vec![child], status: None, signals, cancel })) }
	}

	/// Deliver a signal through the Host runner's child group, not to a synthetic PID.
	#[cfg(unix)]
	pub fn signal(&self, number: i32) -> io::Result<()> {
		let gone = || io::Error::from_raw_os_error(libc::ESRCH);
		if self.status(false).is_some() { return Err(gone()); }
		if number == 0 { return Ok(()); }
		let state = self.state.borrow();
		let signals = state.signals.as_ref().ok_or_else(gone)?;
		signals.send(number).map_err(|_| gone())
	}

	/// Return the interpreter-local child identifier.
	pub fn id(&self) -> i32 { self.id }

	/// Reap this child, or return `None` if a nonblocking check finds it still running.
	/// A blocking reap polls (never parks in the Host's wait) and fails with the cancellation
	/// error once the invocation is cancelled, leaving the still-running child to the Host.
	pub fn status(&self, block: bool) -> Option<io::Result<i32>> {
		let mut pause = Duration::from_micros(200);
		loop {
			{
				let Ok(mut state) = self.state.try_borrow_mut() else {
					return block.then(|| Err(io::Error::from_raw_os_error(libc::EBUSY)));
				};
				if state.status.is_none() {
					if let Some(result) = RunningCommand::try_wait_any(&mut state.running) {
						state.status = Some(result.map(wait_status).map_err(|e| (e.kind(), e.raw_os_error())));
					} else if !block || state.running.is_empty() {
						return None;
					} else if state.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
						return Some(Err(omp_vfs::cancelled()));
					}
				}
				if let Some(r) = state.status {
					return Some(r.map_err(|(kind, code)| code.map_or_else(|| kind.into(), io::Error::from_raw_os_error)));
				}
			}
			std::thread::sleep(pause);
			pause = (pause * 2).min(REAP_POLL);
		}
	}

	/// Stop tracking the child without waiting: the Host keeps running and reaps it.
	pub fn detach(&self) {
		if let Ok(mut state) = self.state.try_borrow_mut() { state.running.clear(); }
	}
}

/// Longest pause between checks while waiting for a child (bounds cancellation latency).
const REAP_POLL: Duration = Duration::from_millis(5);

/// Wait for a Host command, checking `cancel` between short pauses; on cancellation the
/// command is left to the Host and the cancellation error returned.
pub(in crate::perl) fn wait_cancellable(child: RunningCommand, cancel: &AtomicBool) -> io::Result<CommandStatus> {
	let mut running = vec![child];
	let mut pause = Duration::from_micros(200);
	loop {
		if let Some(result) = RunningCommand::try_wait_any(&mut running) { return result; }
		if running.is_empty() { return Err(io::ErrorKind::NotFound.into()); }
		if cancel.load(Ordering::Relaxed) { return Err(omp_vfs::cancelled()); }
		std::thread::sleep(pause);
		pause = (pause * 2).min(REAP_POLL);
	}
}

fn inherit_stdin(host: &Host, mut command: ShellCommand) -> io::Result<ShellCommand> {
	if let Some(fd) = command.take_stdin() { return Ok(command.stdin(fd)); }
	let file = host.paths().file(0).unwrap_or_else(|| host.stdin.file());
	match file.to_fd() {
		Ok(fd) => Ok(command.stdin(fd)),
		// A test capture or a custom in-process stream has no fd to hand a
		// child. Leaving this unspecified gives it the host's null input.
		Err(err) if err.kind() == io::ErrorKind::Unsupported => Ok(command),
		Err(err) => Err(err),
	}
}

/// Convert the host's exit/signal distinction into Perl's wait status.
pub(super) const fn wait_status(status: CommandStatus) -> i32 {
	match status {
		CommandStatus::Exited(code) => (code as i32) << 8,
		CommandStatus::Signaled(signal) => signal & 0x7f,
	}
}

/// Start `system`'s command without waiting, so the caller can deliver an
/// `alarm` while it runs (wrap it in a `PipeChild` to poll). `Err(status)` is
/// the immediate wait status of an empty command line.
pub(in crate::perl) fn spawn_system_in(host: &mut Host, cmd: ShellSpec<'_>, context: Option<&ChildContext>) -> io::Result<Result<RunningCommand, i32>> {
	if cmd.is_empty_line() {
		return Ok(Err(wait_status(CommandStatus::Exited(127))));
	}
	let command = inherit_stdin(host, in_context(cmd.exec_command()?, context))?;
	host.spawn_command(command).map(Ok)
}

/// Run backticks/`qx` under the interpreter's cwd and environment, collecting
/// stdout as bytes and returning Perl `$?`. Flush every Perl output handle
/// before calling. Stderr is not captured.
pub(in crate::perl) fn run_capture_in(host: &mut Host, cmd: ShellSpec<'_>, context: Option<&ChildContext>) -> io::Result<(Vec<u8>, i32)> {
	if cmd.is_empty_line() {
		return Ok((Vec::new(), wait_status(CommandStatus::Exited(1))));
	}
	let (file, child) = spawn_pipe(host, in_context(cmd.exec_command()?, context), true, false)?;
	let mut reader = Device::descriptor(file, Some(host.cancel_flag()), None);
	let mut output = Vec::new();
	let read = reader.read_to_end(&mut output);
	drop(reader);
	// A cancelled read leaves the child to the Host instead of waiting for it.
	read?;
	let status = wait_cancellable(child, &host.cancel_flag()).map(wait_status)?;
	Ok((output, status))
}

/// Open a pipe command without Perl's `system` single-word optimization.
pub(super) fn open_pipe(host: &mut Host, shell: ShellSpec<'_>, read: bool, write: bool, context: Option<&ChildContext>, id: i32) -> io::Result<(OpenFile, PipeChild)> {
	let mut command = in_context(shell.command()?, context);
	let signals = if id == 0 { None } else {
		let (tx, rx) = flume::unbounded();
		command = command.signals(rx);
		Some(tx)
	};
	let (file, child) = spawn_pipe(host, command, read, write)?;
	Ok((file, PipeChild::with_signals(id, child, signals, Some(host.cancel_flag()))))
}

/// Start a child with one redirected pipe end; the caller holds the other.
#[cfg(any(unix, windows))]
pub(super) fn spawn_pipe(host: &mut Host, command: ShellCommand, read: bool, write: bool) -> io::Result<(OpenFile, RunningCommand)> {
	if read == write {
		return Err(io::ErrorKind::InvalidInput.into());
	}
	let (reader, writer) = io::pipe()?;
	let (file, command) = if read {
		(OpenFile::from(reader), inherit_stdin(host, command)?.stdout(Fd::from(writer)))
	} else {
		(OpenFile::from(writer), command.stdin(Fd::from(reader)))
	};
	let child = host.spawn_command(command)?;
	Ok((file, child))
}

/// Pipe-based child redirection requires OS pipe descriptors.
#[cfg(not(any(unix, windows)))]
pub(super) fn spawn_pipe(_: &mut Host, _: ShellCommand, _: bool, _: bool) -> io::Result<(OpenFile, RunningCommand)> {
	Err(io::ErrorKind::Unsupported.into())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn perl_wait_status_distinguishes_a_signal_from_a_numeric_exit() {
		assert_eq!(wait_status(CommandStatus::Exited(143)), 143 << 8);
		assert_eq!(wait_status(CommandStatus::Signaled(15)), 15);
	}
}
