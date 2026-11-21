#![cfg(unix)]

use std::{sync::Arc, time::Duration};

use omp_shell::{
	SessionCommandFuture, SessionCommandHandler, SessionCommandRequest, SessionCommandResult,
	SessionCommands, Shell, ShellOptions, ShellRunOptions,
	cancel::{AbortReason, CancelToken},
	minimizer::MinimizerOptions,
};

/// How a row's cancellation lands.
enum When {
	/// The abort fires while the first segment is still running — a
	/// foreground `/bin/sleep` the cancel must cut — so the tail's work is
	/// prevented. Deterministic: the abort lands well inside the sleep.
	CutsSegment,
	/// No cancellation: the chain stops by its own semantics (an
	/// unreachable tail, the end of the input, an `exit`), which must keep
	/// its ordinary classification.
	Never,
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_after_segment_end_reports_only_prevented_work() {
	let root = tempfile::tempdir().unwrap();
	let config = root.path().join("filters.toml");
	std::fs::write(
		&config,
		"schema_version = 1\n[filters.printf]\nmatch_command = \"^printf$\"\nreplace = [{ pattern = \
		 \"hello\", replacement = \"HI\" }]\n",
	)
	.unwrap();
	// (name, script, when, expected_cancelled, expected_exit, end_status)
	let cases = [
		(
			"cancel cuts reachable tail",
			"slow_fg_ok && printf hello",
			When::CutsSegment,
			true,
			false,
			0,
		),
		(
			"cancel cuts unconditional tail",
			"slow_fg_fail; printf hello",
			When::CutsSegment,
			true,
			false,
			1,
		),
		(
			"unreachable tail keeps its status",
			"slow_fail && printf hello",
			When::Never,
			false,
			false,
			1,
		),
		("no tail keeps its status", "printf hello; slow_ok", When::Never, false, false, 0),
		("exit-established stop", "slow_exit; printf hello", When::Never, false, true, 0),
	];
	let mut mismatches = Vec::new();
	for (name, script, when, expected_cancelled, expected_exit, end_status) in cases {
		let shell = Shell::new(Some(ShellOptions {
			minimizer: Some(MinimizerOptions {
				enabled: Some(true),
				settings_path: Some(config.to_str().unwrap().into()),
				..Default::default()
			}),
			..Default::default()
		}));
		// The `_fg` fixtures hold the foreground for 0.8 s: a cancel at
		// 0.15 s is deterministically inside the first segment. The others
		// background their sleep, so a run without cancellation ends at
		// its own decision point right away.
		let setup = "slow_ok() { /bin/sleep 0.8 & return 0; }; slow_fail() { /bin/sleep 0.8 & \
		             return 1; }; slow_exit() { /bin/sleep 0.8 & exit 0; }; slow_fg_ok() { \
		             /bin/sleep 0.8; return 0; }; slow_fg_fail() { /bin/sleep 0.8; return 1; }";
		let setup_result = shell
			.run(
				ShellRunOptions { command: setup.into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.unwrap();
		assert_eq!(setup_result.exit_code, Some(0), "{name}: valid fixture");
		if name == "cancel cuts reachable tail" {
			let (control_tx, control_rx) = flume::unbounded::<String>();
			let control = shell
				.run(
					ShellRunOptions { command: script.into(), ..Default::default() },
					Some(control_tx),
					CancelToken::default(),
				)
				.await
				.unwrap();
			assert_eq!(control.exit_code, Some(0), "uncancelled control status");
			assert!(!control.cancelled, "uncancelled control");
			assert_eq!(
				control_rx.drain().collect::<String>(),
				"hello",
				"the same conditional tail runs without cancellation"
			);
		}
		let (tx, rx) = flume::unbounded::<String>();
		let result = match when {
			When::CutsSegment => {
				let mut cancel = CancelToken::default();
				let abort = cancel.emplace_abort_token();
				let run = shell.run(
					ShellRunOptions { command: script.into(), ..Default::default() },
					Some(tx),
					cancel,
				);
				tokio::time::sleep(Duration::from_millis(150)).await;
				abort.abort(AbortReason::Signal);
				tokio::time::timeout(Duration::from_secs(5), run)
					.await
					.unwrap_or_else(|_| panic!("{name}: cancelled run did not end"))
					.unwrap()
			},
			When::Never => tokio::time::timeout(
				Duration::from_secs(5),
				shell.run(
					ShellRunOptions { command: script.into(), ..Default::default() },
					Some(tx),
					CancelToken::default(),
				),
			)
			.await
			.unwrap_or_else(|_| panic!("{name}: run did not end"))
			.unwrap(),
		};
		let output: String = rx.drain().collect();
		let expected_output = match (name, when) {
			// A tail the cancel prevented never emitted its output.
			(_, When::CutsSegment) => "",
			// The completed `printf hello` segment's output is the run's.
			("no tail keeps its status", _) => "hello",
			_ => "",
		};
		assert_eq!(output, expected_output, "{name}: segment output");
		assert!(!result.timed_out, "{name}: explicit cancellation, not timeout");
		assert_eq!(result.ended_by_exit, expected_exit, "{name}: exit attribution");
		if !expected_cancelled {
			assert_eq!(result.exit_code, Some(end_status), "{name}: preserve completed status");
		}
		println!(
			"{name}: output={output:?}; result={result:?}; expect cancelled={expected_cancelled}"
		);
		if result.cancelled != expected_cancelled {
			mismatches.push((name, expected_cancelled, result.cancelled));
		}
	}
	assert!(mismatches.is_empty(), "wrong cancellation attribution: {mismatches:?}");
}

/// A session command that answers at once: the tails naming one never run
/// here (the exit prevents them), so its reply content never matters.
struct Immediate;

impl SessionCommandHandler for Immediate {
	fn call(&self, _request: SessionCommandRequest) -> SessionCommandFuture {
		Box::pin(async {
			Ok(SessionCommandResult {
				stdout:    String::new(),
				stderr:    String::new(),
				exit_code: 0,
			})
		})
	}
}

/// `names` as the run's session commands.
fn session_commands(names: &[&str]) -> SessionCommands {
	SessionCommands::new(names.iter().map(|name| (*name).to_owned()), Arc::new(Immediate))
}

/// An exit that leaves an unconditional tail owes the tail's work exactly
/// when the parser of the next run — that run's session commands installed,
/// each preempting the alias of its name — still sees a command there. The
/// probe runs between session runs, where the host's command slot is clear,
/// so it must carry the run's context itself.
#[tokio::test(flavor = "multi_thread")]
async fn exit_tail_owed_under_the_runs_session_commands() {
	let root = tempfile::tempdir().unwrap();
	let config = root.path().join("filters.toml");
	std::fs::write(
		&config,
		"schema_version = 1\n[filters.printf]\nmatch_command = \"^printf$\"\nreplace = [{ pattern = \
		 \"hello\", replacement = \"HI\" }]\n[filters.tail]\nmatch_command = \
		 \"^(gone|hostcmd|echoer)$\"\nreplace = [{ pattern = \"never\", replacement = \"seen\" }]\n",
	)
	.unwrap();
	// (name, tail, the run's session commands, expected ended_by_exit)
	let cases: &[(&str, &str, &[&str], bool)] = &[
		// The tail names a session command whose alias expands to a
		// comment: the command preempts the alias, so the tail is owed.
		("command preempts alias to comment", "gone", &["gone"], true),
		// Without the command, that alias really does hide the tail.
		("alias to comment alone hides the tail", "gone", &[], false),
		// A tail naming a session command with no alias of that name.
		("bare session command tail", "hostcmd", &["hostcmd"], true),
		// An alias to a real command holds one either way.
		("alias to a command holds either way", "echoer", &["echoer"], true),
	];
	for (name, tail, installed, expected) in cases {
		let shell = Shell::new(Some(ShellOptions {
			minimizer: Some(MinimizerOptions {
				enabled: Some(true),
				settings_path: Some(config.to_str().unwrap().into()),
				..Default::default()
			}),
			..Default::default()
		}));
		let setup = "shopt -s expand_aliases; slow_exit() { /bin/sleep 0.2 & exit 0; }; alias \
		             gone='# nothing'; alias echoer='printf hi'";
		let setup_result = shell
			.run(
				ShellRunOptions { command: setup.into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.unwrap();
		assert_eq!(setup_result.exit_code, Some(0), "{name}: valid fixture");
		let result = shell
			.run(
				ShellRunOptions {
					command: format!("slow_exit; {tail}").into(),
					commands: (!installed.is_empty()).then(|| session_commands(installed)),
					..Default::default()
				},
				None,
				CancelToken::default(),
			)
			.await
			.unwrap();
		assert_eq!(result.ended_by_exit, *expected, "{name}: exit attribution");
	}
}
