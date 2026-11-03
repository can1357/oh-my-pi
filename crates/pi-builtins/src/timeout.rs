//! `timeout` builtin, moved from `pi-shell`.

use std::{io::Write, sync::Arc, time::Duration};

use brush_core::{
	ExecutionContext, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy, SourceInfo,
	SpawnObserver, builtins, traps::TrapSignal,
};
use clap::Parser;
use parking_lot::Mutex;
use tokio::time;
use tokio_util::sync::CancellationToken;

use crate::{
	PinnedProcess, SpawnLedger,
	host::{parse_duration, quote_arg},
};

/// GNU timeout's exit status for its own usage/internal errors.
const EXIT_TIMEOUT_FAILURE: u8 = 125;
/// GNU timeout's exit status when the time limit expired.
const EXIT_TIMED_OUT: u8 = 124;
/// 128 + SIGKILL(9): reported when the command died from SIGKILL.
const EXIT_KILLED: u8 = 137;

/// Run a command with a time limit.
#[derive(Parser)]
#[command(disable_help_flag = true)]
struct TimeoutArgs {
	/// Signal to send on expiry: a name with or without the `SIG` prefix, or
	/// a number. Defaults to TERM.
	#[arg(short = 's', long = "signal", value_name = "SIGNAL")]
	signal: Option<String>,
	/// Also send SIGKILL if the command is still running this long after the
	/// initial signal.
	#[arg(short = 'k', long = "kill-after", value_name = "DURATION")]
	kill_after: Option<String>,
	/// Exit with the command's own status even when the time limit expired.
	#[arg(long)]
	preserve_status: bool,
	/// GNU compatibility: don't put the command in a separate process group,
	/// and signal only the direct children rather than a whole group.
	#[arg(long)]
	foreground: bool,
	/// Diagnose each signal sent to the command on stderr.
	#[arg(short = 'v', long)]
	verbose: bool,
	// Hyphenated operands must reach `parse_duration` so `timeout -1 cmd`
	// reports an invalid time interval (exit 125) like GNU, instead of a
	// clap unknown-option error.
	#[arg(required = true, allow_hyphen_values = true)]
	duration: String,
	// The command's own options belong to the command: `timeout 5 grep -v x`.
	#[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
	command: Vec<String>,
}

/// Holds the raw argument vector so parse failures surface as GNU timeout's
/// exit status 125, not brush's generic usage-error status 2 (which the
/// default `builtins::Command::new` path would produce).
pub(crate) struct TimeoutCommand {
	argv: Vec<String>,
}

impl clap::FromArgMatches for TimeoutCommand {
	fn from_arg_matches(_matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { argv: Vec::new() })
	}

	fn update_from_arg_matches(&mut self, _matches: &clap::ArgMatches) -> Result<(), clap::Error> {
		Ok(())
	}
}

impl clap::CommandFactory for TimeoutCommand {
	fn command() -> clap::Command {
		<TimeoutArgs as clap::CommandFactory>::command()
	}

	fn command_for_update() -> clap::Command {
		<TimeoutArgs as clap::CommandFactory>::command_for_update()
	}
}

impl clap::Parser for TimeoutCommand {}

/// Records the external children spawned while running the timed command.
///
/// brush's cancellation token sends TERM then KILL (see
/// `brush_core::processes::Process::wait`), so delivering the *configured*
/// signal requires knowing the children; the shell reports them through its
/// [`SpawnObserver`] hook, and each is pinned as it is reported, so the signal
/// reaches it, or the group it was spawned into, and never a process that took
/// its pid or group number after it exited.
///
/// Each spawn is also reported to the observer this command inherited: the
/// run's spawn registry, or an enclosing `timeout`. That observer signals
/// what it recorded when the whole run is cancelled or an outer limit
/// expires; replacing it would leave the operand's process group, which
/// direct-child cancellation does not reach, unknown to it.
struct SpawnRecorder {
	spawns: Mutex<SpawnLedger>,
	parent: Option<Arc<dyn SpawnObserver>>,
}

impl SpawnObserver for SpawnRecorder {
	fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
		// Forward first: the run's registry pins the child's identity at once.
		if let Some(parent) = &self.parent {
			parent.on_spawn(pid, pgid);
		}
		// Windows has no signals for `timeout` to deliver: it cancels the
		// operand instead, so there is nothing to record.
		if cfg!(windows) {
			return;
		}
		// brush has not reaped the child yet, so `pid` still names it.
		let process = PinnedProcess::from_pid(pid);
		self.spawns.lock().record(pgid, process);
	}

	fn before_reap(&self, pid: i32, unreaped: bool) {
		if let Some(parent) = &self.parent {
			parent.before_reap(pid, unreaped);
		}
		self.spawns.lock().before_reap(pid, unreaped);
	}
}

impl SpawnRecorder {
	/// Sends `signal` to every recorded child that is still there and, when
	/// `group` is set, to the group each recorded leader leads: listed while
	/// the shell has not reaped the leader, through the kernel's group signal
	/// (Linux 6.9 and later) after that. One wave delivers it (see
	/// [`crate::SignalWave`]), with the ledger locked, so the shell cannot
	/// reap a leader while the wave lists its group.
	fn signal(&self, signal: TrapSignal, group: bool) -> bool {
		let Ok(signal) = i32::try_from(signal) else {
			return false;
		};
		let mut spawns = self.spawns.lock();
		let wave = spawns.plan_wave(signal, group).deliver();
		spawns.record_reached(&wave);
		!wave.reached().is_empty() || !wave.members().is_empty() || !wave.kernel_leaders().is_empty()
	}
}

/// Parses a `-s` operand: a signal name (with or without the `SIG` prefix,
/// any case) or a signal number.
fn parse_signal(spec: &str) -> Option<TrapSignal> {
	let parsed = if let Ok(number) = spec.trim().parse::<i32>() {
		TrapSignal::try_from(number).ok()?
	} else {
		TrapSignal::try_from(spec).ok()?
	};
	// Only real signals can be delivered; EXIT/DEBUG/ERR are shell traps.
	matches!(parsed, TrapSignal::Signal(_)).then_some(parsed)
}

/// Renders a signal the way GNU timeout's diagnostics do: `TERM`, not `SIGTERM`.
fn signal_display(signal: TrapSignal) -> &'static str {
	let name = signal.as_str();
	name.strip_prefix("SIG").unwrap_or(name)
}

impl builtins::Command for TimeoutCommand {
	type Error = brush_core::Error;

	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Ok(Self { argv: args.into_iter().collect() })
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> std::result::Result<ExecutionResult, brush_core::Error> {
		if context.is_cancelled() {
			return Ok(ExecutionExitCode::Interrupted.into());
		}
		let args = match TimeoutArgs::try_parse_from(&self.argv) {
			Ok(args) => args,
			Err(err) => {
				// clap reports `--help` as an error; that belongs on stdout
				// with a success status, real usage errors exit 125.
				let rendered = err.to_string();
				if err.use_stderr() {
					let _ = write!(context.stderr(), "{rendered}");
					return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
				}
				let _ = write!(context.stdout(), "{rendered}");
				return Ok(ExecutionResult::success());
			},
		};
		let Some(limit) = parse_duration(&args.duration) else {
			let _ = writeln!(
				context.stderr(),
				"timeout: invalid time interval '{}'",
				args.duration
			);
			return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
		};
		let kill_after = match &args.kill_after {
			Some(spec) => match parse_duration(spec) {
				Some(duration) => Some(duration),
				None => {
					let _ =
						writeln!(context.stderr(), "timeout: invalid time interval '{spec}'");
					return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
				},
			},
			None => None,
		};
		let signal = match &args.signal {
			Some(spec) => match parse_signal(spec) {
				Some(signal) => signal,
				None => {
					let _ = writeln!(context.stderr(), "timeout: '{spec}': invalid signal");
					return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
				},
			},
			None => TrapSignal::try_from("TERM").expect("SIGTERM must be a known signal"),
		};

		let child_cancel = CancellationToken::new();
		let spawns = Arc::new(SpawnRecorder {
			spawns: Mutex::default(),
			parent: context.params.spawn_observer().cloned(),
		});
		let mut params = context.params.clone();
		// GNU runs the command in its own process group and signals the whole
		// group; `--foreground` keeps it in the invoking group and signals
		// only the direct children.
		params.process_group_policy = if args.foreground {
			ProcessGroupPolicy::SameProcessGroup
		} else {
			ProcessGroupPolicy::NewProcessGroup
		};
		params.set_cancel_token(child_cancel.clone());
		// GNU's killed command says nothing; neither does the shell that ran an
		// in-process operand once the limit cancels it.
		params.set_quiet_cancellation(true);
		params.set_spawn_observer(Arc::clone(&spawns) as Arc<dyn SpawnObserver>);

		let mut command_line = String::new();
		for (idx, arg) in args.command.iter().enumerate() {
			if idx > 0 {
				command_line.push(' ');
			}
			command_line.push_str(&quote_arg(arg));
		}

		// Grab an owned stderr handle up front: `run_future` below holds the
		// shell mutably, so `context.stderr()` is unavailable once it exists.
		let mut stderr = context.stderr();
		let outer_cancel = context.cancel_token();
		let source_info = SourceInfo::from("pi-natives:timeout");
		let run_future = context.shell.run_string(command_line, &source_info, &params);
		tokio::pin!(run_future);

		let outer_cancelled = async {
			match &outer_cancel {
				Some(token) => token.cancelled().await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(outer_cancelled);

		// GNU: a duration of zero disables the timeout entirely.
		let deadline = async {
			if limit.is_zero() {
				std::future::pending::<()>().await;
			} else {
				time::sleep(limit).await;
			}
		};
		tokio::pin!(deadline);

		tokio::select! {
			result = &mut run_future => return result,
			() = &mut outer_cancelled => {
				child_cancel.cancel();
				return Ok(ExecutionExitCode::Interrupted.into());
			},
			() = &mut deadline => {},
		}

		// The limit expired: deliver the configured signal like GNU timeout.
		if args.verbose {
			let _ = writeln!(
				stderr,
				"timeout: sending signal {} to command '{}'",
				signal_display(signal),
				args.command[0]
			);
		}
		let signalled = spawns.signal(signal, !args.foreground);
		if !signalled {
			// The operand ran in-process (a builtin, say) or the child is
			// already gone; cancellation is the only remaining lever. For
			// external children it uses TERM then KILL — see `Process::wait`.
			child_cancel.cancel();
		}
		let mut killed = signal.as_str() == "SIGKILL";

		// Wait for the command to finish, escalating to SIGKILL after
		// `--kill-after`. Without `-k`, GNU waits indefinitely — a command
		// that catches the signal keeps running (the caller can still cancel).
		// After a cancel-fallback (in-process operand), the inner shell may
		// surface its own cancellation as an Interrupted error instead of the
		// operand's result; that is expected retirement, not a fault.
		let reap = |result: Result<ExecutionResult, brush_core::Error>| match result {
			Ok(result) => Ok(Some(result)),
			Err(err) if !signalled && matches!(err.kind(), brush_core::ErrorKind::Interrupted) => {
				Ok(None)
			},
			Err(err) => Err(err),
		};
		let kill_deadline = async {
			match kill_after {
				Some(duration) => time::sleep(duration).await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(kill_deadline);

		let child_result = tokio::select! {
			result = &mut run_future => reap(result)?,
			() = &mut outer_cancelled => {
				child_cancel.cancel();
				return Ok(ExecutionExitCode::Interrupted.into());
			},
			() = &mut kill_deadline => {
				if args.verbose {
					let _ = writeln!(
						stderr,
						"timeout: sending signal KILL to command '{}'",
						args.command[0]
					);
				}
				killed = true;
				let kill = TrapSignal::try_from("KILL").expect("SIGKILL must be a known signal");
				spawns.signal(kill, !args.foreground);
				child_cancel.cancel();
				// SIGKILL can't be resisted; bound the reaping wait anyway so
				// a wedged in-process operand can't hang the builtin forever.
				// The operand's own result is moot once it was sent SIGKILL,
				// and the cancellation just above can surface as Interrupted.
				match time::timeout(Duration::from_secs(2), &mut run_future).await {
					Ok(Err(err)) if !matches!(err.kind(), brush_core::ErrorKind::Interrupted) => {
						return Err(err);
					},
					_ => None,
				}
			},
		};

		// Exit status per GNU: 137 once the command was sent SIGKILL, by `-s`
		// or by `-k`, with or without `--preserve-status`: the operand's result
		// after `-k` races the cancellation that follows the kill and can read
		// 130. Otherwise the command's own status under `--preserve-status`,
		// else 124.
		if killed {
			return Ok(ExecutionResult::new(EXIT_KILLED));
		}
		if args.preserve_status {
			if let Some(result) = child_result.filter(|_| signalled) {
				return Ok(result);
			}
			// Cancel-fallback path (in-process operand): the inner shell's own
			// cancellation check races the operand's result, so its status is
			// unreliable. Report death by the delivered signal (128+N)
			// deterministically, matching GNU for a command taken down by the
			// timeout signal.
			let number = i32::try_from(signal).unwrap_or(15);
			return Ok(ExecutionResult::new(128_u8.wrapping_add(number as u8)));
		}
		Ok(ExecutionResult::new(EXIT_TIMED_OUT))
	}
}

#[cfg(test)]
mod tests {
	use std::{
		io::{Read, Seek, SeekFrom},
		time::Duration,
	};

	use brush_core::{
		ExecutionContext, ExecutionResult, Shell, SourceInfo, builtins,
		extensions::DefaultShellExtensions,
		openfiles::OpenFiles,
	};
	use clap::Parser;

	use super::{TimeoutArgs, TimeoutCommand, parse_signal, signal_display};

	#[derive(Parser)]
	struct StatusCommand;

	impl builtins::Command for StatusCommand {
		type Error = brush_core::Error;

		async fn execute<SE: brush_core::ShellExtensions>(
			&self,
			_context: ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			Ok(ExecutionResult::new(7))
		}
	}

	#[derive(Parser)]
	struct SlowCommand;

	impl builtins::Command for SlowCommand {
		type Error = brush_core::Error;

		async fn execute<SE: brush_core::ShellExtensions>(
			&self,
			context: ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			let cancel_token = context
				.cancel_token()
				.expect("timeout must provide its operand a cancellation token");
			tokio::select! {
				() = cancel_token.cancelled() => Ok(ExecutionResult::success()),
				() = tokio::time::sleep(Duration::from_millis(500)) => {
					Ok(ExecutionResult::new(99))
				},
			}
		}
	}

	/// An operand that ignores cancellation, so only SIGKILL escalation (the
	/// cancel-token fallback plus the bounded reap) can retire it early.
	#[derive(Parser)]
	struct StubbornCommand;

	impl builtins::Command for StubbornCommand {
		type Error = brush_core::Error;

		async fn execute<SE: brush_core::ShellExtensions>(
			&self,
			_context: ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			tokio::time::sleep(Duration::from_millis(300)).await;
			Ok(ExecutionResult::new(99))
		}
	}

	async fn test_shell() -> Shell<DefaultShellExtensions> {
		Shell::builder()
			.builtin(
				"timeout",
				builtins::builtin::<TimeoutCommand, DefaultShellExtensions>(),
			)
			.builtin(
				"status-test",
				builtins::builtin::<StatusCommand, DefaultShellExtensions>(),
			)
			.builtin(
				"slow-test",
				builtins::builtin::<SlowCommand, DefaultShellExtensions>(),
			)
			.build()
			.await
			.expect("build test shell")
	}

	async fn run_with_deadline(command: &str) -> ExecutionResult {
		let mut shell = test_shell().await;
		let mut params = shell.default_exec_params();
		// Cancelling the operand makes the shell report an interrupted command;
		// without this the diagnostic lands on the test runner's terminal.
		for fd in [OpenFiles::STDIN_FD, OpenFiles::STDOUT_FD, OpenFiles::STDERR_FD] {
			params.set_fd(fd, brush_core::openfiles::null().expect("null device"));
		}
		tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string(command, &SourceInfo::default(), &params),
		)
		.await
		.expect("timeout builtin test exceeded its safety deadline")
		.expect("execute test command")
	}

	#[tokio::test]
	async fn command_finishing_inside_limit_returns_its_status() {
		let result = run_with_deadline("timeout 0.250 status-test").await;

		assert_eq!(u8::from(result.exit_code), 7);
	}

	#[tokio::test]
	async fn command_exceeding_limit_is_cancelled_with_timeout_status() {
		let result = run_with_deadline("timeout 0.010 slow-test").await;

		assert_eq!(u8::from(result.exit_code), 124);
	}

	/// A shell with every builtin and in-process utility, as the bash tool's
	/// shell has, working in `dir`.
	#[cfg(unix)]
	async fn full_shell(dir: &std::path::Path) -> Shell<DefaultShellExtensions> {
		let mut shell = Shell::builder()
			.builtins(crate::default_builtins(crate::BuiltinSet::BashMode))
			.working_dir(dir.to_path_buf())
			.build()
			.await
			.expect("build test shell");
		for (name, registration) in crate::utility_builtins().into_iter().chain(crate::process_builtins()) {
			shell.register_builtin(name, registration);
		}
		shell
	}

	/// What [`run_with_params`] saw.
	#[cfg(unix)]
	struct Ran {
		status: u8,
		stdout: String,
		stderr: String,
	}

	/// Runs `command` (stdin closed, output captured) under `cancel`, if
	/// given. The 1 s deadline is the contract: a command that ignores
	/// cancellation never returns.
	#[cfg(unix)]
	async fn run_in_process(
		shell: &mut Shell<DefaultShellExtensions>,
		command: &str,
		cancel: Option<tokio_util::sync::CancellationToken>,
	) -> Ran {
		let mut params = shell.default_exec_params();
		if let Some(token) = cancel {
			params.set_cancel_token(token);
		}
		run_with_params(shell, command, params).await
	}

	/// [`run_in_process`] with `params` in place of the shell's defaults.
	#[cfg(unix)]
	async fn run_with_params(
		shell: &mut Shell<DefaultShellExtensions>,
		command: &str,
		params: brush_core::ExecutionParameters,
	) -> Ran {
		run_with_params_within(shell, command, params, Duration::from_secs(1)).await
	}

	/// [`run_with_params`] for a command that runs longer than one second:
	/// it fails only when the command has not returned by `deadline`.
	#[cfg(unix)]
	async fn run_with_params_within(
		shell: &mut Shell<DefaultShellExtensions>,
		command: &str,
		mut params: brush_core::ExecutionParameters,
		deadline: Duration,
	) -> Ran {
		let mut stdout = tempfile::tempfile().expect("create stdout capture");
		let mut stderr = tempfile::tempfile().expect("create stderr capture");
		params.set_fd(OpenFiles::STDIN_FD, brush_core::openfiles::null().expect("null device"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout.try_clone().expect("clone stdout capture").into());
		params.set_fd(OpenFiles::STDERR_FD, stderr.try_clone().expect("clone stderr capture").into());
		let result = tokio::time::timeout(deadline, shell.run_string(command, &SourceInfo::default(), &params))
			.await
			.unwrap_or_else(|_| panic!("`{command}` ignored cancellation"))
			.expect("execute test command");
		let read_back = |file: &mut std::fs::File| {
			file.seek(SeekFrom::Start(0)).expect("rewind capture");
			let mut text = String::new();
			file.read_to_string(&mut text).expect("read capture");
			text
		};
		Ran { status: u8::from(result.exit_code), stdout: read_back(&mut stdout), stderr: read_back(&mut stderr) }
	}

	/// A scratch directory holding `sparse` and `sparse2`: 4 GiB files of NUL
	/// bytes with no line breaks that take no disk space, too long to read
	/// inside a short limit.
	#[cfg(unix)]
	fn sparse_dir() -> tempfile::TempDir {
		let dir = tempfile::tempdir().expect("create scratch dir");
		for name in ["sparse", "sparse2"] {
			std::fs::File::create(dir.path().join(name))
				.and_then(|file| file.set_len(4 << 30))
				.expect("create sparse file");
		}
		dir
	}

	/// A utility reading a host file that never ends kept reading after the
	/// limit: the builtin waits for its operand, so `timeout` never returned.
	/// Once cancelled it says nothing about the cancelled read either
	/// (`cat: /dev/zero: Operation canceled`); the shell's own
	/// `error: interrupted` for the retired operand is not the utility's.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn in_process_reader_of_an_endless_file_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran = run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 cat /dev/zero", None).await;

		assert_eq!(ran.status, 124);
		assert!(!ran.stderr.contains("cat:"), "{}", ran.stderr);
	}

	/// `grep -z` over a large sparse file reads its NUL bytes as empty records,
	/// so memory stays flat but the search runs for minutes.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelled_grep_stops_without_a_diagnostic() {
		let dir = sparse_dir();
		let ran = run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 grep -z x sparse", None).await;

		assert_eq!(ran.status, 124);
		assert!(!ran.stderr.contains("grep:"), "{}", ran.stderr);
	}

	/// `diff` reads each file whole (`Fs::read`), which took no notice of the
	/// token, so `timeout 150 diff -r` over a tree holding a huge sparse file
	/// ran to the end of it.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn whole_file_read_of_a_sparse_file_stops_at_the_limit() {
		let dir = sparse_dir();
		let ran = run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 diff sparse sparse2", None).await;

		assert_eq!(ran.status, 124);
		assert!(!ran.stderr.contains("diff:"), "{}", ran.stderr);
	}

	/// `tail` panicked on the cancelled read (`tail: internal error`); what a
	/// cancelled utility prints is dropped in one place for every utility.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelled_utilities_print_nothing_about_it() {
		let dir = sparse_dir();
		let mut shell = full_shell(dir.path()).await;
		for command in ["timeout 0.2 tail -n 1 sparse", "timeout 0.2 sha256sum /dev/zero"] {
			let ran = run_in_process(&mut shell, command, None).await;
			assert_eq!(ran.status, 124, "{command}");
			assert!(!ran.stderr.contains("tail") && !ran.stderr.contains("sha256sum"), "{command}: {}", ran.stderr);
		}
	}

	/// When the limit cancels an in-process operand, the shell that ran it
	/// printed `error: interrupted` (and a builtin's own `mapfile:
	/// interrupted`). GNU `timeout` kills its command, which says nothing; the
	/// status alone reports the timeout.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn timeout_prints_nothing_of_its_own_when_the_limit_fires() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		for command in [
			"timeout 0.2 cat /dev/zero",
			"timeout 0.2 mapfile -t a < /dev/zero",
			"timeout 0.2 eval 'cat /dev/zero'",
		] {
			let ran = run_in_process(&mut shell, command, None).await;
			assert_eq!((ran.status, ran.stderr.as_str()), (124, ""), "{command}");
		}
		let ran = run_in_process(&mut shell, "timeout 0.5 cat nosuch; echo st=$?", None).await;
		assert!(ran.stderr.contains("nosuch"), "an error before the limit is still printed: {}", ran.stderr);
	}

	/// A cancelled read of standard input looked like EOF, so `md5sum` printed
	/// the checksum of whatever prefix it had read, as if it were the input's.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelled_stdin_read_reports_no_result_for_partial_input() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran =
			run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 md5sum - < /dev/zero", None).await;

		assert_eq!(ran.status, 124);
		assert_eq!(ran.stdout, "");
	}

	/// `wc -c` counts a pipe with `splice`, which bypasses the cancellable
	/// reads: behind a writer that never stops, `timeout` never returned.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn byte_count_of_an_endless_pipe_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran =
			run_in_process(&mut full_shell(dir.path()).await, "cat /dev/zero | timeout 0.2 wc -c", None).await;

		assert_eq!(ran.status, 124);
		assert_eq!(ran.stdout, "");
	}

	/// `mapfile` reading a line that never ends did not check cancellation.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn mapfile_of_endless_input_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran =
			run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 mapfile -t a < /dev/zero", None).await;

		assert_eq!(ran.status, 124);
	}

	/// `mapfile` read its input without waiting for it first, so input that
	/// paused before a delimiter or EOF (`{ printf x; sleep 60; } | timeout 1
	/// mapfile a`) held the task that runs `timeout` in a blocking read, and
	/// the limit never fired. Read a block at a time and, with `-n`, a byte at
	/// a time.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn mapfile_of_paused_input_stops_at_the_limit() {
		use std::io::Write as _;
		let dir = tempfile::tempdir().expect("create scratch dir");
		let fifo = dir.path().join("fifo");
		pi_vfs::BlockingFs::native()
			.make_node(&fifo, pi_vfs::NodeKind::Fifo, 0o600)
			.expect("create FIFO");
		let mut shell = full_shell(dir.path()).await;
		for command in ["timeout 0.2 mapfile a < fifo", "timeout 0.2 mapfile -n 2 a < fifo"] {
			let path = fifo.clone();
			let writer = std::thread::spawn(move || {
				let mut file = std::fs::OpenOptions::new()
					.write(true)
					.open(path)
					.expect("open FIFO for writing");
				file.write_all(b"x").expect("write to FIFO");
				// Pauses past the test's deadline, then ends the input.
				std::thread::sleep(Duration::from_secs(2));
			});
			let ran = run_in_process(&mut shell, command, None).await;
			assert_eq!((ran.status, ran.stderr.as_str()), (124, ""), "{command}");
			writer.join().expect("FIFO writer");
		}
	}

	/// `ls -R` walked the whole tree before it looked at cancellation.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn recursive_listing_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran =
			run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 ls -R / > /dev/null", None).await;

		assert_eq!(ran.status, 124);
	}

	/// Opening a FIFO with no writer blocked in `open` until one came, past
	/// the limit; now the open stops at the limit, and a writer that does come
	/// is still read.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn reader_of_a_fifo_without_a_writer_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		pi_vfs::BlockingFs::native()
			.make_node(dir.path().join("fifo"), pi_vfs::NodeKind::Fifo, 0o600)
			.expect("create FIFO");
		let mut shell = full_shell(dir.path()).await;

		let ran = run_in_process(&mut shell, "timeout 0.2 cat fifo", None).await;
		assert_eq!(ran.status, 124);

		let ran = run_in_process(&mut shell, "(sleep 0.1; echo hi > fifo) & timeout 0.8 cat fifo; wait", None).await;
		assert_eq!((ran.status, ran.stdout.as_str()), (0, "hi\n"), "{}", ran.stderr);
	}

	/// A background in-process reader must stop when the run that started it
	/// is cancelled (a tool abort); otherwise it keeps a core busy after the
	/// session is gone.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn background_reader_stops_when_its_run_is_cancelled() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let run_token = tokio_util::sync::CancellationToken::new();
		run_in_process(&mut shell, "cat /dev/zero > /dev/null &", Some(run_token.clone())).await;
		run_token.cancel();

		// `wait` returns once the job has ended; the deadline catches a job that
		// keeps reading.
		run_in_process(&mut shell, "wait", None).await;
	}

	#[tokio::test]
	async fn invalid_duration_preserves_diagnostic() {
		let mut shell = test_shell().await;
		let mut stderr = tempfile::tempfile().expect("create stderr capture");
		let mut params = shell.default_exec_params();
		params.set_fd(
			OpenFiles::STDERR_FD,
			stderr.try_clone().expect("clone stderr capture").into(),
		);

		let result = tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string(
				"timeout invalid status-test",
				&SourceInfo::default(),
				&params,
			),
		)
		.await
		.expect("invalid-duration test exceeded its safety deadline")
		.expect("execute invalid-duration command");
		stderr.seek(SeekFrom::Start(0)).expect("rewind stderr capture");
		let mut diagnostic = String::new();
		stderr.read_to_string(&mut diagnostic).expect("read stderr capture");

		assert_eq!(u8::from(result.exit_code), 125);
		assert_eq!(diagnostic, "timeout: invalid time interval 'invalid'\n");
	}

	#[tokio::test]
	async fn gnu_flag_spellings_parse() {
		// Failure mode: a real-world GNU invocation dying in clap.
		let args = TimeoutArgs::try_parse_from([
			"timeout", "-s", "INT", "-k", "2s", "10s", "cmd", "arg",
		])
		.expect("-s/-k spellings must parse");
		assert_eq!(args.signal.as_deref(), Some("INT"));
		assert_eq!(args.kill_after.as_deref(), Some("2s"));
		assert_eq!(args.duration, "10s");
		assert_eq!(args.command, ["cmd", "arg"]);

		let args = TimeoutArgs::try_parse_from([
			"timeout",
			"--signal=KILL",
			"--kill-after=1",
			"--preserve-status",
			"--foreground",
			"-v",
			"5",
			"cmd",
		])
		.expect("long spellings must parse");
		assert!(args.preserve_status && args.foreground && args.verbose);

		// `--` before the duration ends option parsing, GNU-style.
		let args = TimeoutArgs::try_parse_from(["timeout", "--", "5", "cmd"])
			.expect("-- before the duration must parse");
		assert_eq!(args.duration, "5");

		// The command's own options must pass through untouched.
		let args = TimeoutArgs::try_parse_from(["timeout", "5", "grep", "-v", "-e", "x"])
			.expect("command options must not be parsed by timeout");
		assert_eq!(args.command, ["grep", "-v", "-e", "x"]);

		// A hyphenated duration reaches parse_duration (exit 125 later),
		// instead of failing as an unknown clap option.
		let args = TimeoutArgs::try_parse_from(["timeout", "-1", "cmd"])
			.expect("hyphenated duration must reach the interval check");
		assert_eq!(args.duration, "-1");
	}

	/// A timeout's group-mode wave reaches a joined pipeline stage through its
	/// leader's group. The recorder must not then deliver the same signal to
	/// that stage directly: shells run one TERM trap for each TERM they take.
	#[cfg(unix)]
	#[test]
	fn recorder_signals_a_group_member_once_per_wave() {
		use std::{
			io::{BufRead as _, BufReader},
			os::unix::process::CommandExt as _,
			process::{Command, Stdio},
			thread,
			time::Instant,
		};

		use brush_core::traps::TrapSignal;
		use parking_lot::Mutex;

		use super::SpawnRecorder;
		use crate::{PinnedProcess, ProcessStatus, SpawnLedger, pinned_process::tests::ProcessGuard};

		// Two TERMs sent back to back merge while both are pending, so a
		// single attempt can pass with the defect; one in several does not.
		for attempt in 0..40 {
			let dir = tempfile::tempdir().expect("trap directory");
			// The leader starts a member of its own group (a joined pipeline
			// stage) whose TERM trap appends one `x` per TERM it takes.
			let script = r#"sh -c 'trap "printf x >> runs; sleep 0.3; exit 0" TERM
: > ready
while :; do :; done' &
echo "$!"
while :; do :; done"#;
			let mut leader = Command::new("sh")
				.args(["-c", script])
				.current_dir(dir.path())
				.process_group(0)
				.stdout(Stdio::piped())
				.spawn()
				.expect("start group leader");
			let mut output = BufReader::new(leader.stdout.take().expect("leader stdout"));
			let leader_pid = i32::try_from(leader.id()).expect("leader pid fits");
			let mut guard = ProcessGuard::new(leader);
			let mut line = String::new();
			output.read_line(&mut line).expect("read joined member pid");
			let member_pid = line.trim().parse::<i32>().expect("member pid");
			let leader_pin = PinnedProcess::from_pid(leader_pid).expect("pin group leader");
			let member_pin = PinnedProcess::from_pid(member_pid).expect("pin joined member");
			guard.pin(&member_pin);
			let deadline = Instant::now() + Duration::from_secs(5);
			while !dir.path().join("ready").exists() {
				assert!(Instant::now() < deadline, "attempt {attempt}: the member never set its trap");
				thread::sleep(Duration::from_millis(10));
			}
			assert_eq!(member_pin.group_id(), Some(leader_pid), "the member joined the leader's group");

			let recorder = SpawnRecorder { spawns: Mutex::new(SpawnLedger::default()), parent: None };
			{
				let mut spawns = recorder.spawns.lock();
				spawns.record(Some(leader_pid), Some(leader_pin));
				spawns.record(Some(leader_pid), Some(member_pin.clone()));
			}
			let term = TrapSignal::try_from("TERM").expect("TERM is a signal");
			assert!(recorder.signal(term, true), "attempt {attempt}: the wave must reach the group");

			let deadline = Instant::now() + Duration::from_secs(5);
			while member_pin.status() == ProcessStatus::Running && Instant::now() < deadline {
				thread::sleep(Duration::from_millis(10));
			}
			assert!(
				member_pin.status() != ProcessStatus::Running,
				"attempt {attempt}: the member must end after its TERM trap"
			);
			let runs = std::fs::read_to_string(dir.path().join("runs")).expect("TERM trap ran");
			assert_eq!(runs, "x", "attempt {attempt}: the member must take TERM once");
		}
	}

	#[test]
	fn signal_spellings_parse_and_display_without_prefix() {
		// Failure mode: rejecting a signal spelling GNU accepts.
		for spec in ["TERM", "term", "SIGTERM", "sigterm", "15", "KILL", "9", "INT", "2"] {
			assert!(parse_signal(spec).is_some(), "spec {spec:?} must parse");
		}
		// Shell-trap pseudo-signals and unknown names are invalid for kill(2).
		for spec in ["NOSUCH", "EXIT", "DEBUG", "ERR", "64", "-5"] {
			assert!(parse_signal(spec).is_none(), "spec {spec:?} must be rejected");
		}
		let term = parse_signal("SIGTERM").expect("SIGTERM parses");
		assert_eq!(signal_display(term), "TERM");
	}

	#[tokio::test]
	async fn zero_duration_disables_the_timeout() {
		// Failure mode: `timeout 0 cmd` firing instantly instead of never.
		let result = run_with_deadline("timeout 0 slow-test").await;
		assert_eq!(u8::from(result.exit_code), 99);

		let result = run_with_deadline("timeout 0s status-test").await;
		assert_eq!(u8::from(result.exit_code), 7);
	}

	#[tokio::test]
	async fn preserve_status_reports_death_by_the_timeout_signal() {
		// In-process operands retire via the cancel fallback, where the inner
		// shell's result is racy; --preserve-status must deterministically
		// report death by the configured signal (TERM -> 143), like GNU does
		// for a command killed by the timeout signal.
		let result = run_with_deadline("timeout --preserve-status 0.010 slow-test").await;

		assert_eq!(u8::from(result.exit_code), 143);
	}

	#[tokio::test]
	async fn kill_signal_reports_137() {
		// GNU exits 128+9 when the command is taken down with SIGKILL.
		let result = run_with_deadline("timeout -s KILL 0.010 slow-test").await;

		assert_eq!(u8::from(result.exit_code), 137);
	}

	#[tokio::test]
	async fn kill_after_escalates_and_reports_137() {
		// stubborn-test ignores the initial (cancellation-based) signal; the
		// -k deadline must escalate and report the SIGKILL status.
		let mut shell = test_shell().await;
		shell
			.register_builtin(
				"stubborn-test",
				builtins::builtin::<StubbornCommand, DefaultShellExtensions>(),
			);
		let mut params = shell.default_exec_params();
		// Keep the inner shell's interrupted notice off the test runner's
		// terminal, like run_with_deadline does.
		for fd in [OpenFiles::STDIN_FD, OpenFiles::STDOUT_FD, OpenFiles::STDERR_FD] {
			params.set_fd(fd, brush_core::openfiles::null().expect("null device"));
		}
		let result = tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string(
				"timeout -k 0.075 0.010 stubborn-test",
				&SourceInfo::default(),
				&params,
			),
		)
		.await
		.expect("escalation test exceeded its safety deadline")
		.expect("execute escalation command");

		assert_eq!(u8::from(result.exit_code), 137);
	}

	#[tokio::test]
	async fn clap_parse_failure_exits_125_not_2() {
		// GNU usage errors exit 125; brush's generic clap path would exit 2.
		let result = run_with_deadline("timeout").await;

		assert_eq!(u8::from(result.exit_code), 125);
	}

	#[tokio::test]
	async fn invalid_kill_after_interval_exits_125() {
		let result = run_with_deadline("timeout -k bogus 1 status-test").await;

		assert_eq!(u8::from(result.exit_code), 125);
	}

	#[tokio::test]
	async fn invalid_signal_exits_125() {
		let result = run_with_deadline("timeout -s NOSUCH 1 status-test").await;

		assert_eq!(u8::from(result.exit_code), 125);
	}

	#[tokio::test]
	async fn verbose_reports_the_signal_sent() {
		let mut shell = test_shell().await;
		let mut stderr = tempfile::tempfile().expect("create stderr capture");
		let mut params = shell.default_exec_params();
		params.set_fd(
			OpenFiles::STDERR_FD,
			stderr.try_clone().expect("clone stderr capture").into(),
		);

		let result = tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string("timeout -v 0.010 slow-test", &SourceInfo::default(), &params),
		)
		.await
		.expect("verbose test exceeded its safety deadline")
		.expect("execute verbose command");
		stderr.seek(SeekFrom::Start(0)).expect("rewind stderr capture");
		let mut diagnostic = String::new();
		stderr.read_to_string(&mut diagnostic).expect("read stderr capture");

		assert_eq!(u8::from(result.exit_code), 124);
		// The cancel-fallback may race the inner shell's own cancellation
		// check, which can append its interrupted notice after our line.
		assert!(
			diagnostic.starts_with("timeout: sending signal TERM to command 'slow-test'\n"),
			"diagnostic must lead with the GNU-style signal line: {diagnostic:?}"
		);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn external_child_receives_the_configured_signal() {
		// Failure mode: the timed-out external child only ever seeing SIGKILL
		// (the cancel-token path) instead of the configured signal.
		let result = run_with_deadline("timeout -s TERM 0.050 sleep 5").await;
		assert_eq!(u8::from(result.exit_code), 124);

		let result =
			run_with_deadline("timeout --preserve-status 0.050 sleep 5").await;
		assert_eq!(u8::from(result.exit_code), 143, "SIGTERM death is 128+15");
	}

	/// `-k` escalation under `--preserve-status` reports the command's death
	/// by SIGKILL, 137, as GNU `timeout` does. The operand token cancelled
	/// after the kill could win over the real exit status, and 130 came out.
	///
	/// The operand writes its pid to `ready` once its `trap "" TERM` is in
	/// place. An attempt without `ready` took TERM before the trap (a machine
	/// so loaded that `sh` needed more than the 1 s limit to start), so it
	/// shows nothing about the status and is not counted.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn preserve_status_after_kill_escalation_reports_137() {
		/// Kills the operand and its `sleep` when an attempt ends, passed or
		/// failed, if `timeout`'s SIGKILL did not: both ignore TERM. Each pid
		/// is pinned and checked against what the test started before the kill.
		struct OperandGuard<'a>(&'a std::path::Path);

		impl Drop for OperandGuard<'_> {
			fn drop(&mut self) {
				for (file, word) in [("ready", "trap"), ("sleep_pid", "sleep")] {
					let Some(pid) = std::fs::read_to_string(self.0.join(file))
						.ok()
						.and_then(|text| text.trim().parse::<i32>().ok())
					else {
						continue;
					};
					if let Some(process) = crate::PinnedProcess::from_pid(pid)
						&& process.args().iter().any(|arg| arg.contains(word))
					{
						let _ = process.kill(libc::SIGKILL);
					}
				}
			}
		}

		const COUNTED: u32 = 5;
		const ATTEMPTS: u32 = 20;
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let mut counted = 0;
		for attempt in 0..ATTEMPTS {
			for file in ["ready", "sleep_pid"] {
				let _ = std::fs::remove_file(dir.path().join(file));
			}
			let _guard = OperandGuard(dir.path());
			let params = shell.default_exec_params();
			let ran = run_with_params_within(
				&mut shell,
				"timeout --preserve-status -k 0.1 1 /bin/sh -c 'trap \"\" TERM; echo $$ > ready; /bin/sleep \
				 30 & echo $! > sleep_pid; wait'",
				params,
				Duration::from_secs(10),
			)
			.await;
			if !dir.path().join("ready").exists() {
				continue;
			}
			assert_eq!(ran.status, 137, "attempt {attempt}: {}", ran.stderr);
			counted += 1;
			if counted == COUNTED {
				return;
			}
		}
		panic!("only {counted} of {ATTEMPTS} operands set their TERM trap within the 1 s limit");
	}

	/// Records what the shell reports for each external child it spawns.
	#[cfg(target_os = "linux")]
	#[derive(Default)]
	struct SpawnLog(std::sync::Mutex<Vec<(i32, Option<i32>)>>);

	#[cfg(target_os = "linux")]
	impl brush_core::SpawnObserver for SpawnLog {
		fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
			self.0.lock().expect("spawn log lock").push((pid, pgid));
		}
	}

	/// The run's spawn registry, and an outer `timeout`, signal the process
	/// group a child is reported in. Each child here prints the group `/proc`
	/// shows it in, and the report must name that group, or none when it is
	/// the shell's own (the host's), which no teardown may signal. A child
	/// detached into its own session under `SameProcessGroup` (the default
	/// policy, `--foreground`, later pipeline stages) was reported in no group
	/// or in the pipeline leader's, so its background children were lost once
	/// it died.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn spawned_children_report_the_process_group_they_are_in() {
		use std::{collections::HashMap, sync::Arc};

		let pty = nix::pty::openpty(None, None).expect("open a pseudo-terminal");
		let tty = nix::unistd::ttyname(&pty.slave).expect("name the pseudo-terminal");
		let tty = tty.display();
		let shell_group = nix::unistd::getpgrp().as_raw();
		// `r` prints the pid and process group of the `sh` that runs it.
		let setup = r#"r='read -r p c s pp g x < /proc/$$/stat; echo "$p $g"'
f() { /bin/sh -c "$r" | /bin/sh -c "$r; cat"; }
"#;
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let mut wrong = Vec::new();
		for (case, command) in [
			("a child", r#"/bin/sh -c "$r""#.to_owned()),
			("pipeline stages", "f".to_owned()),
			("a timeout operand", r#"timeout 5 /bin/sh -c "$r""#.to_owned()),
			("pipeline stages under timeout", "timeout 5 f".to_owned()),
			("a --foreground operand", r#"timeout --foreground 5 /bin/sh -c "$r""#.to_owned()),
			("pipeline stages under --foreground", "timeout --foreground 5 f".to_owned()),
			("a child reading a terminal", format!(r#"/bin/sh -c "$r" < {tty}"#)),
			(
				"a --foreground operand reading a terminal",
				format!(r#"timeout --foreground 5 /bin/sh -c "$r" < {tty}"#),
			),
		] {
			let log = Arc::new(SpawnLog::default());
			let mut params = shell.default_exec_params();
			params.set_spawn_observer(Arc::clone(&log) as Arc<dyn brush_core::SpawnObserver>);
			let ran = run_with_params(&mut shell, &format!("{setup}{command}"), params).await;
			assert_eq!(ran.status, 0, "{case}: {}", ran.stderr);
			let groups: HashMap<i32, i32> = ran
				.stdout
				.lines()
				.map(|line| {
					let (pid, group) = line.split_once(' ').expect("`pid group` line");
					(pid.parse().expect("pid"), group.parse().expect("group"))
				})
				.collect();
			assert!(!groups.is_empty(), "{case}: no child reported its group");
			let reported = log.0.lock().expect("spawn log lock").clone();
			for (pid, group) in groups {
				let reported_group = reported
					.iter()
					.find_map(|&(spawned, group)| (spawned == pid).then_some(group))
					.unwrap_or_else(|| panic!("{case}: child {pid} was not reported: {reported:?}"));
				let expected = (group != shell_group).then_some(group);
				if reported_group != expected {
					wrong.push(format!(
						"{case}: child {pid} is in group {group} (the shell's is {shell_group}), \
						 reported in {reported_group:?}"
					));
				}
			}
		}
		assert!(wrong.is_empty(), "children reported in the wrong group: {wrong:#?}");
	}
}
