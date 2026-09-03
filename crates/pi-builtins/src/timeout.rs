//! `timeout` builtin, moved from `pi-shell`.

use std::{
	io::Write,
	sync::{Arc, Mutex},
	time::Duration,
};

use brush_core::{
	ExecutionContext, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy, SourceInfo,
	SpawnObserver, builtins, sys, traps::TrapSignal,
};
use clap::Parser;
use tokio::time;
use tokio_util::sync::CancellationToken;

use crate::host::{parse_duration, quote_arg};

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
/// brush's cancellation token can only SIGKILL a child (see
/// `brush_core::processes::Process::wait`), so delivering the *configured*
/// signal requires knowing the child's pid/pgid; the shell reports those
/// through its [`SpawnObserver`] hook.
#[derive(Default)]
struct SpawnRecorder(Mutex<Vec<(i32, Option<i32>)>>);

impl SpawnObserver for SpawnRecorder {
	fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
		if let Ok(mut spawns) = self.0.lock() {
			spawns.push((pid, pgid));
		}
	}
}

impl SpawnRecorder {
	/// Sends `signal` to every recorded child — its whole process group when
	/// `group` is set — and reports whether any delivery succeeded.
	fn signal(&self, signal: TrapSignal, group: bool) -> bool {
		let spawns = match self.0.lock() {
			Ok(spawns) => spawns.clone(),
			Err(_) => return false,
		};
		let mut sent = false;
		for (pid, pgid) in spawns {
			let target = match pgid {
				Some(pgid) if group => -pgid,
				_ => pid,
			};
			if sys::signal::kill_process(target, signal).is_ok() {
				sent = true;
			}
		}
		sent
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
		let spawns = Arc::new(SpawnRecorder::default());
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
			// external children it degrades to SIGKILL — see `Process::wait`.
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
				match time::timeout(Duration::from_secs(2), &mut run_future).await {
					Ok(result) => reap(result)?,
					Err(_) => None,
				}
			},
		};

		// Exit status per GNU: the command's own status under
		// `--preserve-status`; 137 when it died from SIGKILL; else 124.
		if args.preserve_status {
			if signalled {
				return Ok(child_result.unwrap_or_else(|| ExecutionResult::new(EXIT_KILLED)));
			}
			// Cancel-fallback path (in-process operand): the inner shell's own
			// cancellation check races the operand's result, so its status is
			// unreliable. Report death by the delivered signal (128+N, or 137
			// after escalation) deterministically, matching GNU for a command
			// taken down by the timeout signal.
			let number = i32::try_from(signal).unwrap_or(15);
			let code = if killed {
				EXIT_KILLED
			} else {
				128_u8.wrapping_add(number as u8)
			};
			return Ok(ExecutionResult::new(code));
		}
		if killed {
			return Ok(ExecutionResult::new(EXIT_KILLED));
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
		let result = run_with_deadline("timeout -s TERM 0.050 /bin/sleep 5").await;
		assert_eq!(u8::from(result.exit_code), 124);

		let result =
			run_with_deadline("timeout --preserve-status 0.050 /bin/sleep 5").await;
		assert_eq!(u8::from(result.exit_code), 143, "SIGTERM death is 128+15");
	}
}
