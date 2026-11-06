//! A vproc's queue of pending signal actions, as Bash 5.3 runs a script.
//!
//! Bash keeps one queue per shell (`trap.c`): `trap_handler` counts the
//! delivery in `pending_traps[sig]` and raises `catch_flag`, and
//! `run_pending_traps` is the only thing that runs actions. It returns at
//! once when `catch_flag` is clear, clears it when it starts, then scans
//! the signal numbers upwards once, running the action of each signal
//! still pending when the scan reaches it. So the signals pending when a
//! scan starts never interleave. A fresh delivery while an action runs can
//! start a nested scan, including the same ordinary signal (but not WINCH).
//! A repeat still pending when its action ends is dropped. A `return` that
//! jumps out of the scan abandons what it had not reached.
//!
//! The Bash goldens use script-file measurements on Bash 5.3.0, checked
//! against Bash 5.2.21 (`/usr/bin/bash`). The function-trap test also protects
//! the shared queue's existing zsh behavior.
//!
//! The scripts name `/bin/sleep` and `/bin/true` by path on purpose. This
//! engine has `sleep` and `true` as builtins, so a bare `sleep` is neither
//! a child (no `SIGCHLD`) nor a foreground external, and a row written
//! with it would compare two different situations instead of the queue.
#![cfg(unix)]

use std::os::unix::ffi::OsStrExt;

use bstr::BStr;
use pi_shell::{
	Shell, ShellRunOptions,
	bash::{
		Budget, Cx, Engine, EngineConfig, MemStore, RestoreOpts, RunId, Shell as CoreShell, SigSet,
		StateStore, Step,
		store::{Change, Key},
	},
	cancel::CancelToken,
	process::{NativeHost, no_callouts, wait_runnable},
	sys::Parker,
};

mod obash_support;
mod pty_support;

/// Runs each script in a fresh shell and asserts Bash's output and exit
/// status 0, reporting every row that differs. The channel carries the
/// run's stdout and stderr together, as the bash tool reads them.
async fn assert_bash_outputs(rows: &[(&str, &str)]) {
	let mut mismatches = Vec::new();
	for &(script, bash_output) in rows {
		let (tx, rx) = flume::unbounded::<String>();
		let result = Shell::new(None)
			.run(
				ShellRunOptions { command: script.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(20_000)),
			)
			.await
			.expect("run");
		let output: String = rx.drain().collect();
		if (result.exit_code, output.as_str()) != (Some(0), bash_output) {
			mismatches.push(format!(
				"`{script}`\n  bash: Some(0) {bash_output:?}\n  omp:  {:?} {output:?}",
				result.exit_code
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// The signals pending when a scan starts run one after the other, in
/// signal-number order and never interleaved, at the first point the
/// shell is not waiting for a foreground command.
#[tokio::test(flavor = "multi_thread")]
async fn pending_actions_run_in_signal_order_one_at_a_time() {
	assert_bash_outputs(&[
		(
			r#"f(){ trap 'echo got-usr1' USR1; trap 'echo got-term' TERM; /bin/sleep 0.5; true; }; f & p=$!; /bin/sleep 0.1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"got-usr1\ngot-term\nstatus=0\n",
		),
		(
			r#"f(){ trap 'echo got-usr1' USR1; trap 'echo got-usr2' USR2; /bin/sleep 0.5; true; }; f & p=$!; /bin/sleep 0.1; kill -USR1 "$p"; kill -USR2 "$p"; wait "$p"; echo status=$?"#,
			"got-usr1\ngot-usr2\nstatus=0\n",
		),
		// Delivery order does not matter: the scan goes up the signal
		// numbers, so HUP (1) runs before USR1 (10) before TERM (15).
		(
			r#"f(){ trap 'echo hup' HUP; trap 'echo usr1' USR1; trap 'echo term' TERM; sleep .4; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; kill -HUP "$p"; wait "$p"; echo status=$?"#,
			"hup\nusr1\nterm\nafter\nstatus=0\n",
		),
		(
			r#"f(){ trap 'echo u1' USR1; trap 'echo term' TERM; sleep .3; echo after; }; f & p=$!; /bin/sleep .1; kill -TERM "$p"; kill -USR1 "$p"; wait "$p"; echo status=$?"#,
			"u1\nterm\nafter\nstatus=0\n",
		),
		// A multi-command action runs whole before the next action starts.
		(
			r#"f(){ trap 'echo one-start; echo one-end' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"one-start\none-end\nterm-start\nterm-end\nafter\nstatus=0\n",
		),
		// The same, with the action's commands inside a function call.
		(
			r#"h(){ echo one-start; echo one-end; }; f(){ trap 'h' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"one-start\none-end\nterm-start\nterm-end\nafter\nstatus=0\n",
		),
	])
	.await;
}

/// An action that `exit`s or `return`s leaves the rest of the scan
/// behind: bash's `run_pending_traps` cleared `catch_flag` when it
/// started, so the actions it had not reached do not run at all.
#[tokio::test(flavor = "multi_thread")]
async fn an_action_that_leaves_drops_what_the_queue_had_not_reached() {
	assert_bash_outputs(&[
		(
			r#"f(){ trap 'echo one-start; exit 23' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"one-start\nstatus=23\n",
		),
		(
			r#"f(){ trap 'echo one-start; return 23' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"one-start\nstatus=23\n",
		),
		// A `return` out of a NESTED action unwinds the function, so the
		// outer action's remaining commands never run either.
		(
			r#"f(){ trap 'echo u1-start; kill -USR2 $BASHPID; sleep .15; echo u1-end' USR1; trap 'echo u2; return 19' USR2; sleep .5; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; wait "$p"; echo status=$?"#,
			"u1-start\nu2\nstatus=19\n",
		),
		(
			r#"f(){ trap 'echo u1-start; kill -USR2 $BASHPID; sleep .15; echo u1-end' USR1; trap 'echo u2; exit 19' USR2; sleep .5; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; wait "$p"; echo status=$?"#,
			"u1-start\nu2\nstatus=19\n",
		),
	])
	.await;
}

/// A delivery that arrives WHILE an action runs raises `catch_flag`
/// again, so it starts a nested scan: it interrupts the action's current
/// command, runs its own action there, and the interrupted action goes
/// on afterwards. The nested scan reads the live queue, so a signal the
/// outer scan had not reached runs nested too.
#[tokio::test(flavor = "multi_thread")]
async fn a_signal_during_an_action_runs_nested_and_interrupts_it() {
	assert_bash_outputs(&[
		(
			r#"d=$(mktemp -d); f(){ trap 'echo one-start; : > "$d/in-one"; sleep .3; echo one-end' USR1; trap 'echo term' TERM; : > "$d/ready"; sleep .6; echo after; }; f & p=$!; while [ ! -e "$d/ready" ]; do sleep .02; done; kill -USR1 "$p"; while [ ! -e "$d/in-one" ]; do sleep .02; done; kill -TERM "$p"; wait "$p"; echo status=$?; rm -rf "$d""#,
			"one-start\nterm\none-end\nafter\nstatus=0\n",
		),
		// The action signals itself: the nested action runs before the
		// outer action's remaining commands.
		(
			r#"f(){ trap 'echo u1-start; kill -USR2 $BASHPID; sleep .15; echo u1-end' USR1; trap 'echo u2' USR2; sleep .5; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; wait "$p"; echo status=$?"#,
			"u1-start\nu2\nu1-end\nafter\nstatus=0\n",
		),
		// TERM was already queued when USR1's action started, so the outer
		// scan owns it; the nested scan the self-sent USR2 starts reads the
		// live queue and runs TERM too, before the outer action resumes.
		(
			r#"f(){ trap 'echo u1-start; kill -USR2 $BASHPID; sleep .15; echo u1-end' USR1; trap 'echo u2' USR2; trap 'echo term' TERM; sleep .5; echo after; }; f & p=$!; /bin/sleep .1; kill -TERM "$p"; kill -USR1 "$p"; wait "$p"; echo status=$?"#,
			"u1-start\nu2\nterm\nu1-end\nafter\nstatus=0\n",
		),
	])
	.await;
}

/// A repeat of the signal whose action is running is dropped: bash
/// clears `pending_traps[sig]` again when the action ends. Its action
/// runs once more only when the repeat arrives after that.
#[tokio::test(flavor = "multi_thread")]
async fn a_repeat_during_an_action_is_dropped_when_the_action_ends() {
	assert_bash_outputs(&[
		// Two TERMs arrive while USR1's action runs; TERM runs once.
		(
			r#"d=$(mktemp -d); f(){ trap 'echo one-start; /bin/sleep .3; echo one-end' USR1; trap 'echo term' TERM; : > "$d/ready"; /bin/sleep .6; echo after; }; f & p=$!; while [ ! -e "$d/ready" ]; do /bin/sleep .02; done; kill -TERM "$p"; kill -TERM "$p"; kill -TERM "$p"; kill -USR1 "$p"; wait "$p"; echo status=$?; rm -rf "$d""#,
			"one-start\none-end\nterm\nafter\nstatus=0\n",
		),
		// A second USR1 during USR1's own action is dropped.
		(
			r#"d=$(mktemp -d); f(){ trap 'echo u1-start; : >> "$d/c"; /bin/sleep .15; echo u1-end' USR1; : > "$d/ready"; /bin/sleep .6; echo after; }; f & p=$!; while [ ! -e "$d/ready" ]; do /bin/sleep .02; done; kill -USR1 "$p"; /bin/sleep .05; kill -USR1 "$p"; wait "$p"; echo status=$?; rm -rf "$d""#,
			"u1-start\nu1-end\nafter\nstatus=0\n",
		),
		// WINCH signalling itself from its own action: bash refuses the
		// recursive WINCH scan outright, and the repeat is then dropped.
		(
			r#"d=$(mktemp -d); n=0; f(){ trap 'n=$((n+1)); [ $n -lt 3 ] && kill -WINCH $BASHPID; echo winch=$n' WINCH; : > "$d/ready"; /bin/sleep .3; echo after; }; f & p=$!; while [ ! -e "$d/ready" ]; do /bin/sleep .02; done; kill -WINCH "$p"; wait "$p"; echo status=$?; rm -rf "$d""#,
			"winch=1\nafter\nstatus=0\n",
		),
	])
	.await;
}

/// `SIGCHLD` is the one signal whose queue entry is a count: bash's
/// `run_sigchld_trap` runs the action once per child reaped, and marks
/// the trap in progress so a child reaped by the action itself cannot
/// re-enter it (the action's own children are counted for a later scan).
#[tokio::test(flavor = "multi_thread")]
async fn a_chld_action_runs_once_per_child_and_is_not_re_entered() {
	assert_bash_outputs(&[
		(
			r#"n=0; f(){ trap 'n=$((n+1))' CHLD; /bin/true; /bin/true; /bin/true; /bin/sleep .2; echo runs=$n; }; f & p=$!; wait "$p"; echo status=$?"#,
			"runs=4\nstatus=0\n",
		),
		(
			r#"n=0; f(){ trap 'n=$((n+1)); /bin/true' CHLD; /bin/true; /bin/sleep .3; echo runs=$n; }; f & p=$!; wait "$p"; echo status=$?"#,
			"runs=3\nstatus=0\n",
		),
		(
			r#"n=0; f(){ trap 'n=$((n+1)); /bin/true' CHLD; /bin/true; /bin/true; /bin/sleep .2; echo runs=$n; }; f & p=$!; wait "$p"; echo status=$?"#,
			"runs=6\nstatus=0\n",
		),
	])
	.await;
}

/// The disposition a signal has when the scan reaches it decides, not
/// the one it had when it was delivered. A trap reset to the default
/// while its signal waits makes bash resend the signal to itself, so the
/// default action happens; a trap set to the empty action makes the
/// queued delivery do nothing.
///
/// Bash also prints an internal warning on stderr for both
/// (`run_pending_traps: bad value in trap_list[15]: (nil)`), which names
/// a C pointer and which bash's own source marks `whoops -- print
/// warning?`. That text is not reproduced; the goldens below are bash's
/// stdout, and the assertion reads stdout and stderr together, so it
/// also pins that this engine prints nothing instead.
#[tokio::test(flavor = "multi_thread")]
async fn the_disposition_a_pending_signal_has_when_its_action_starts_decides() {
	assert_bash_outputs(&[
		// TERM queued, then reset to the default by USR1's action: the
		// resend terminates the job (143 = 128 + 15).
		(
			r#"f(){ trap 'echo in-usr1; trap - TERM; echo reset' USR1; trap 'echo term' TERM; /bin/sleep .4; echo after; }; f & p=$!; /bin/sleep .1; kill -TERM "$p"; kill -USR1 "$p"; wait "$p"; echo status=$?"#,
			"in-usr1\nreset\nstatus=143\n",
		),
		// The same with TSTP, whose default a non-interactive shell
		// ignores: the resend does nothing and the job runs on.
		(
			r#"f(){ trap 'echo in-usr1; trap - TSTP; echo reset' USR1; trap 'echo tstp' TSTP; /bin/sleep .4; echo after; }; f & p=$!; /bin/sleep .1; kill -TSTP "$p"; kill -USR1 "$p"; wait "$p"; echo status=$?; jobs"#,
			"in-usr1\nreset\nafter\nstatus=0\n",
		),
		// Set to ignore instead of reset: nothing happens at all.
		(
			r#"f(){ trap 'echo in-usr1; trap "" TERM; echo ignored' USR1; trap 'echo term' TERM; /bin/sleep .4; echo after; }; f & p=$!; /bin/sleep .1; kill -TERM "$p"; kill -USR1 "$p"; wait "$p"; echo status=$?"#,
			"in-usr1\nignored\nafter\nstatus=0\n",
		),
	])
	.await;
}

/// The queue is only read where bash reads it. While the shell waits for
/// a foreground command, a delivery waits with it — so a signal whose
/// trap an earlier queued action would have installed still takes its
/// default and kills the job.
#[tokio::test(flavor = "multi_thread")]
async fn a_delivery_waits_for_the_foreground_command() {
	assert_bash_outputs(&[
		// USR1 at .1s waits for `sleep .4`; TERM at .2s has no trap yet.
		(
			r#"f(){ trap 'echo u1; trap "echo term-new" TERM' USR1; sleep .4; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; /bin/sleep .1; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"status=143\n",
		),
		// The same action, with TERM arriving after it has run: the trap
		// it installed is in force.
		(
			r#"f(){ trap 'echo u1; trap "echo term-new" TERM' USR1; sleep .2; sleep .6; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; /bin/sleep .3; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"u1\nterm-new\nafter\nstatus=0\n",
		),
	])
	.await;
}

/// Ordinary signals can recursively interrupt their own action. Bash's
/// default `EVALNEST_MAX` is zero (unlimited), not 128.
#[tokio::test(flavor = "multi_thread")]
async fn an_ordinary_signal_can_interrupt_its_own_action() {
	assert_bash_outputs(&[
		(
			r#"n=0; trap 'n=$((n+1)); echo enter=$n; if [ $n -lt 3 ]; then kill -USR1 $BASHPID; fi; echo leave=$n' USR1; kill -USR1 $BASHPID; echo end=$n"#,
			"enter=1\nenter=2\nenter=3\nleave=3\nleave=3\nleave=3\nend=3\n",
		),
		(
			r#"n=0; trap 'n=$((n+1)); echo old=$n; trap "echo new" USR1; kill -USR1 $BASHPID; echo tail' USR1; kill -USR1 $BASHPID; echo end"#,
			"old=1\nnew\ntail\nend\n",
		),
		(
			r#"n=0; trap 'n=$((n+1)); if [ $n -le 132 ]; then kill -USR1 $BASHPID; fi' USR1; kill -USR1 $BASHPID; echo after=$n"#,
			"after=133\n",
		),
	])
	.await;
}

/// A batch owns the action captured before its first child, even when
/// that action replaces, ignores, or resets the live CHLD disposition.
#[tokio::test(flavor = "multi_thread")]
async fn a_chld_batch_keeps_its_original_action() {
	assert_bash_outputs(&[
		(
			r#"n=0; trap 'n=$((n+1)); echo old=$n; trap "echo new" CHLD' CHLD; /bin/true | /bin/true | /bin/true | /bin/sleep .2; echo end=$n"#,
			"old=1\nold=2\nold=3\nold=4\nend=4\n",
		),
		(
			r#"n=0; trap 'n=$((n+1)); echo old=$n; trap "" CHLD' CHLD; /bin/true | /bin/true | /bin/true | /bin/sleep .2; echo end=$n"#,
			"old=1\nold=2\nold=3\nold=4\nend=4\n",
		),
		(
			r#"n=0; trap 'n=$((n+1)); echo old=$n; trap - CHLD' CHLD; /bin/true | /bin/true | /bin/true | /bin/sleep .2; echo end=$n"#,
			"old=1\nold=2\nold=3\nold=4\nend=4\n",
		),
	])
	.await;
}

/// Exercise the real script-file snapshot consumer, not a queue clone.
/// Exact Bash output also prevents plain and restored runs agreeing on
/// the same bug. Counters ensure restoration was not silently skipped.
#[test]
fn a_snapshot_keeps_an_ordinary_signals_recursive_actions() {
	let rows = [(
		r#"n=0; trap 'n=$((n+1)); echo enter=$n; if [ $n -lt 3 ]; then kill -USR1 $BASHPID; fi; echo leave=$n' USR1; kill -USR1 $BASHPID; echo end=$n"#,
		"enter=1\nenter=2\nenter=3\nleave=3\nleave=3\nleave=3\nend=3\n",
	)];
	let mut mismatches = Vec::new();
	for (row, (script, expected)) in rows.into_iter().enumerate() {
		for mode in ["step", "exec"] {
			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("script.sh");
			let stats = dir.path().join("stats");
			std::fs::write(&path, script).unwrap();
			let output = obash_support::output(
				obash_support::obash()
					.arg("--fault=1:1")
					.arg(format!("--fault-mode={mode}"))
					.arg(&path)
					.env("PI_SHELL_FAULT_STATS", &stats),
			);
			let counters = std::fs::read_to_string(stats).unwrap();
			let restored: u64 = counters
				.split_whitespace()
				.find_map(|field| field.strip_prefix("restored="))
				.unwrap()
				.parse()
				.unwrap();
			assert!(restored > 0, "{mode}: {counters}");
			assert!(counters.split_whitespace().any(|field| field == "lost=0"), "{counters}");
			if !output.status.success()
				|| output.stdout != expected.as_bytes()
				|| !output.stderr.is_empty()
			{
				mismatches.push(format!(
					"row {row} {mode}: expected {expected:?}; got {output:?}; {counters}"
				));
			}
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// Both standard streams share one real file, preserving their combined
/// order across the exec-mode process replacements as the bash tool does.
/// The second file is written by the trap, not by the test harness.
fn snapshot_action_mismatch(
	mode: &str,
	script: &str,
	bash_status: i32,
	bash_output: &str,
	bash_effect: &str,
) -> Option<String> {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("script.sh");
	let stats = dir.path().join("stats");
	let combined = dir.path().join("combined");
	let effect = dir.path().join("effect");
	std::fs::write(&path, script).unwrap();
	let sink = std::fs::File::create(&combined).unwrap();
	let output = obash_support::output(
		obash_support::obash()
			.arg("--fault=1:1")
			.arg(format!("--fault-mode={mode}"))
			.arg(&path)
			.env("PI_SHELL_FAULT_STATS", &stats)
			.env("TRAP_OUTPUT", &effect)
			.stdout(sink.try_clone().unwrap())
			.stderr(sink),
	);
	let counters = std::fs::read_to_string(stats).unwrap();
	let restored: u64 = counters
		.split_whitespace()
		.find_map(|field| field.strip_prefix("restored="))
		.unwrap()
		.parse()
		.unwrap();
	assert!(restored > 0, "{mode}: {counters}");
	assert!(counters.split_whitespace().any(|field| field == "lost=0"), "{counters}");
	let combined = std::fs::read_to_string(combined).unwrap();
	let effect = std::fs::read_to_string(effect).ok();
	let actual = (output.status.code(), combined.as_str(), effect.as_deref());
	let expected = (Some(bash_status), bash_output, Some(bash_effect));
	(actual != expected).then(|| {
		format!("{mode}: `{script}`\n  bash: {expected:?}\n  omp:  {actual:?}\n  {counters}")
	})
}

/// A fresh different signal must interrupt the running action regardless
/// of whether its signal number is above or below the outer scan's cursor.
/// With `exit`, deferring that action also loses its real file write.
fn assert_snapshot_fresh_signal(mode: &str, leave: &str, status: i32, expected: &str) {
	let mut mismatches = Vec::new();
	for (running, fresh) in [("USR1", "USR2"), ("USR2", "USR1")] {
		let script = format!(
			"trap 'echo start >&2; kill -{fresh} $BASHPID; {leave}echo tail' {running}; trap 'printf \
			 saved > \"$TRAP_OUTPUT\"; echo nested' {fresh}; kill -{running} $BASHPID; echo end"
		);
		if let Some(mismatch) = snapshot_action_mismatch(mode, &script, status, expected, "saved") {
			mismatches.push(mismatch);
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
fn a_snapshot_preserves_a_fresh_different_signal_before_exit_in_step_mode() {
	assert_snapshot_fresh_signal("step", "exit 23; ", 23, "start\nnested\n");
}

#[test]
fn a_snapshot_preserves_a_fresh_different_signal_before_exit_in_exec_mode() {
	assert_snapshot_fresh_signal("exec", "exit 23; ", 23, "start\nnested\n");
}

#[test]
fn a_snapshot_preserves_a_fresh_different_signal_before_the_tail_in_step_mode() {
	assert_snapshot_fresh_signal("step", "", 0, "start\nnested\ntail\nend\n");
}

#[test]
fn a_snapshot_preserves_a_fresh_different_signal_before_the_tail_in_exec_mode() {
	assert_snapshot_fresh_signal("exec", "", 0, "start\nnested\ntail\nend\n");
}

fn assert_snapshot_child_actions(mode: &str) {
	let script = r#"n=0; trap 'n=$((n+1)); printf saved >> "$TRAP_OUTPUT"; echo chld' CHLD; /bin/true & /bin/true & /bin/true & /bin/sleep .2; echo end=$n; wait"#;
	assert_eq!(
		snapshot_action_mismatch(
			mode,
			script,
			0,
			"chld\nchld\nchld\nchld\nend=4\n",
			"savedsavedsavedsaved",
		),
		None
	);
}

#[test]
fn a_snapshot_runs_every_owed_child_action_and_file_write_in_step_mode() {
	assert_snapshot_child_actions("step");
}

#[test]
fn a_snapshot_runs_every_owed_child_action_and_file_write_in_exec_mode() {
	assert_snapshot_child_actions("exec");
}

fn assert_different_signal_during_child_action(mode: &str) {
	let script = r#"trap 'echo different; printf saved > "$TRAP_OUTPUT"' USR1; trap 'echo child; kill -USR1 $BASHPID; echo tail' CHLD; /bin/true; echo end"#;
	assert_eq!(
		snapshot_action_mismatch(mode, script, 0, "child\ndifferent\ntail\nend\n", "saved"),
		None
	);
}

#[test]
fn a_different_signal_still_interrupts_a_running_child_action_in_step_mode() {
	assert_different_signal_during_child_action("step");
}

#[test]
fn a_different_signal_still_interrupts_a_running_child_action_in_exec_mode() {
	assert_different_signal_during_child_action("exec");
}

/// Genuine upstream image: 75e7801e247d4e3263439d4cc08ccad60dc64bdd,
/// pi-shell 18.17.0. USR1 is running; HUP, USR2 and TERM are pending.
/// Only the ordinary variable `d` is rebound to isolate real file writes;
/// the Frames blob, identities and units are never rewritten or regenerated.
/// These bytes contain pending deliveries, not an interrupted scan to replay.
#[test]
fn a_legacy_upstream_snapshot_runs_every_unscanned_action_without_inventing_a_scan() {
	let dir = tempfile::tempdir().unwrap();
	let mut store = MemStore::from_bytes(include_bytes!(
		"fixtures/pending-trap-queue/upstream-18.17.0-mid-action.store"
	))
	.unwrap();
	store
		.apply(Change::SetScalar(
			Key::Var(BStr::new(b"d")),
			BStr::new(dir.path().as_os_str().as_bytes()),
		))
		.unwrap();
	let engine = Engine::new(EngineConfig::default());
	let mut host = NativeHost::new(None, false, Vec::new(), SigSet::EMPTY, 0, false);
	let (mut shell, report) = CoreShell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert!(report.lost.is_empty(), "{report:?}");
	assert!(report.abandoned.is_empty(), "{report:?}");
	let mut parker = Parker::new();
	let mut status = None;
	for _ in 0..100_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Done { run: RunId(1), status: code } => {
				status = Some(code);
				break;
			},
			Step::Call { id, .. } => no_callouts(&mut shell, id),
			Step::Blocked | Step::Paused => {
				wait_runnable(
					&mut parker,
					&shell,
					pi_shell::bash::Vpid(EngineConfig::default().vpid_base),
				);
			},
			Step::Yield => parker.poll_exits(),
			Step::Idle => panic!("legacy image became idle before completing its action"),
			_ => {},
		}
	}
	assert_eq!(status, Some(23), "legacy image did not finish with its action's exit status");
	for signal in ["hup", "usr2", "term"] {
		assert_eq!(std::fs::read(dir.path().join(signal)).unwrap(), b"saved", "{signal}");
	}
	assert_eq!(std::fs::read(dir.path().join("order")).unwrap(), b"hup\nusr2\nterm\n");
}

/// A reset-to-default stop parks the whole scan until CONT. The marker
/// tests timing, not Bash's job-status text or whether TTIN is coalesced.
#[tokio::test(flavor = "multi_thread")]
async fn a_pending_default_stop_parks_later_actions_and_commands_until_cont() {
	assert_bash_outputs(&[(
		r#"d=$(mktemp -d); set -m; f(){ trap 'echo reset; trap - TSTP' USR1; trap 'echo old-tstp' TSTP; trap '[ -e "$d/continued" ] || echo EARLY-ttin' TTIN; /bin/sleep .4; [ -e "$d/continued" ] || echo EARLY-after; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TSTP "$p"; kill -TTIN "$p"; /bin/sleep .6; : > "$d/continued"; echo continue; kill -CONT "$p"; /bin/sleep .2; wait "$p"; rm -rf "$d""#,
		"reset\ncontinue\nafter\n",
	)])
	.await;
}

#[test]
fn a_chld_function_trap_still_runs_for_completed_background_jobs() {
	let script = r#"n=0; TRAPCHLD() { n=$((n+1)); echo chld=$n; }; /bin/true & /bin/true & /bin/true & /bin/sleep .2; wait; echo end=$n"#;
	for mode in ["plain", "step", "exec"] {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("script.zsh");
		std::fs::write(&path, script).unwrap();
		let mut command = obash_support::obash();
		if mode != "plain" {
			command
				.arg("--fault=1:1")
				.arg(format!("--fault-mode={mode}"));
		}
		let output = obash_support::output(command.arg("--emulate=zsh").arg(path));
		assert!(output.status.success(), "{mode}: {output:?}");
		assert_eq!(output.stdout, b"chld=1\nchld=2\nchld=3\nend=3\n", "{mode}: {output:?}");
		assert!(output.stderr.is_empty(), "{mode}: {output:?}");
	}
}

/// zsh's idle alarm enters the same pending queue as an ordinary signal.
/// A function trap has no text record, but must run instead of the default.
#[test]
fn a_zsh_alarm_function_trap_keeps_the_interactive_shell_alive() {
	let mut shell = pty_support::Spawn::zsh()
		.args(["-f", "-i"])
		.env("PS1", "ready> ")
		.spawn()
		.unwrap();
	shell.read_until("ready> ", pty_support::TIMEOUT).unwrap();
	shell
		.write("TRAPALRM() { TMOUT=0; print -r -- alarm-fired; }; TMOUT=1\r")
		.unwrap();
	shell
		.read_until("alarm-fired\r\n", pty_support::TIMEOUT)
		.unwrap();
	shell.write("print -r -- shell-alive; exit\r").unwrap();
	shell
		.read_until("shell-alive\r\n", pty_support::TIMEOUT)
		.unwrap();
	assert!(shell.wait(pty_support::TIMEOUT).unwrap().success());
}
