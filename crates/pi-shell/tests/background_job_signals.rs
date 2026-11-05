//! Signals to a background job the shell runs itself, and the traps that
//! job sets, as Bash 5.3 runs a script (Bash 5.2.21 agrees on every row).
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs each script in a fresh shell and asserts Bash's output and exit
/// status 0, reporting every row that differs.
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

/// A job whose function trapped `TERM` runs the trap when its current
/// command returns, then its own status reaches `wait`: the signal also
/// interrupted the `sleep`, the pipeline or the subshell the function ran,
/// so `wait` reported 130 or 143. Without job control bash signals the
/// job's own process, not what it is running.
#[tokio::test(flavor = "multi_thread")]
async fn a_trapped_job_signal_reaches_only_the_job() {
	assert_bash_outputs(&[
		(r#"f(){ trap 'echo got-term' TERM; sleep 0.5; }; f & sleep 0.1; kill %1; wait %1; echo "status=$?""#, "got-term\nstatus=0\n"),
		(r#"f(){ trap 'echo got-term' TERM; sleep 0.5; }; f & p=$!; sleep 0.1; kill "$p"; wait "$p"; echo "status=$?""#, "got-term\nstatus=0\n"),
		(r#"f(){ trap 'echo got' TERM; /bin/sleep .3 | /bin/cat; echo "inner=$?"; }; f & /bin/sleep .1; kill %1; wait %1; echo status=$?"#, "got\ninner=0\nstatus=0\n"),
		(r"f(){ trap 'echo got' TERM; ( /bin/sleep .3; echo inner ); }; f & /bin/sleep .1; kill %1; wait %1; echo status=$?", "inner\ngot\nstatus=0\n"),
	])
	.await;
}

/// Traps pending at once run one after the other in signal-number order,
/// as bash's `run_pending_traps` does: `TERM` ran before `USR1`, `USR2`
/// before `USR1`.
#[tokio::test(flavor = "multi_thread")]
async fn pending_traps_run_in_signal_order() {
	assert_bash_outputs(&[
		(r#"f(){ trap 'echo got-usr1' USR1; trap 'echo got-term' TERM; sleep 0.5; }; f & p=$!; /bin/sleep 0.1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#, "got-usr1\ngot-term\nstatus=0\n"),
		(r#"f(){ trap 'echo got-usr1' USR1; trap 'echo got-usr2' USR2; sleep 0.5; }; f & p=$!; /bin/sleep 0.1; kill -USR1 "$p"; kill -USR2 "$p"; wait "$p"; echo status=$?"#, "got-usr1\ngot-usr2\nstatus=0\n"),
	])
	.await;
}

/// `kill -s EXIT` is signal 0, a probe as `kill -0` is: it was refused as
/// an invalid signal.
#[tokio::test(flavor = "multi_thread")]
async fn kill_exit_probes() {
	assert_bash_outputs(&[
		(r#"f(){ trap 'echo exit-trap' EXIT; sleep 0.3; echo end; }; f & p=$!; /bin/sleep 0.1; kill -s EXIT "$p"; echo kill=$?; wait "$p"; echo status=$?"#, "kill=0\nend\nexit-trap\nstatus=0\n"),
	])
	.await;
}

/// Already right at main ff0a986b; kept so they stay right: `SIGKILL` ends
/// a job that traps `KILL`, a trap delivered during the last command of an
/// `&&` job runs, and an ignored `TERM` stays ignored in a background job.
#[tokio::test(flavor = "multi_thread")]
async fn untrappable_and_inherited_dispositions_hold() {
	assert_bash_outputs(&[
		(r#"exec 2>/dev/null; f(){ trap 'echo survived' KILL; sleep 1; }; f & p=$!; /bin/sleep 0.1; kill -KILL "$p"; wait "$p"; echo status=$?"#, "status=137\n"),
		(r#"f(){ trap 'echo got-usr1' USR1; :; }; f && sleep 0.25 & p=$!; /bin/sleep 0.05; kill -USR1 "$p"; wait "$p"; echo status=$?"#, "got-usr1\nstatus=0\n"),
		(r#"trap '' TERM; f(){ sleep 0.3; echo survived; }; f & p=$!; /bin/sleep 0.1; kill -TERM "$p"; wait "$p"; echo status=$?"#, "survived\nstatus=0\n"),
	])
	.await;
}

/// Pending traps run one after the other, never interleaved, and a trap
/// that exits the shell drops the traps still pending, as bash's
/// `run_pending_traps` does: a second pending trap ran between the first
/// trap's commands, and `exit` inside a trap still ran the other one.
#[tokio::test(flavor = "multi_thread")]
async fn one_pending_trap_runs_at_a_time() {
	assert_bash_outputs(&[
		(r#"f(){ trap 'echo one-start; echo one-end' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#, "one-start\none-end\nterm-start\nterm-end\nafter\nstatus=0\n"),
		(r#"h(){ echo one-start; echo one-end; }; f(){ trap 'h' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#, "one-start\none-end\nterm-start\nterm-end\nafter\nstatus=0\n"),
		(r#"f(){ trap 'echo one-start; exit 23' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#, "one-start\nstatus=23\n"),
		(r#"f(){ trap 'echo one-start; return 23' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#, "one-start\nstatus=23\n"),
	])
	.await;
}

/// A program the job `exec`s owns its own signal disposition: the shell's
/// trap record is gone across `exec`, so `TERM` reaches the program and
/// kills it. An ignored signal the program inherits stays ignored.
#[tokio::test(flavor = "multi_thread")]
async fn an_exec_d_program_gets_the_signal_its_shell_trapped() {
	assert_bash_outputs(&[
		(r#"f(){ trap 'echo trapped' TERM; exec /bin/sleep 0.5; }; f & p=$!; /bin/sleep 0.1; kill -TERM "$p"; wait "$p"; echo status=$?"#, "status=143\n"),
		(r#"f(){ trap 'echo trapped' TERM; exec /bin/sleep 0.5; }; f & /bin/sleep 0.1; kill -TERM %1; wait %1; echo status=$?"#, "status=143\n"),
		(r#"trap '' TERM; f(){ exec /bin/sleep 0.5; }; f & p=$!; /bin/sleep 0.1; kill -TERM "$p"; wait "$p"; echo status=$?"#, "status=0\n"),
	])
	.await;
}

/// `SIGEXIT` is not a signal name bash takes: only plain `EXIT` is signal
/// 0. `kill -s SIGEXIT` silently succeeded.
#[tokio::test(flavor = "multi_thread")]
async fn only_plain_exit_names_signal_zero() {
	assert_bash_outputs(&[
		(r#"f(){ /bin/sleep .25; echo end; }; f & p=$!; kill -s SIGEXIT "$p" 2>/dev/null; echo kill=$?; wait "$p"; echo status=$?"#, "kill=1\nend\nstatus=0\n"),
		(r#"f(){ /bin/sleep .25; echo end; }; f & p=$!; kill -SIGEXIT "$p" 2>/dev/null; echo kill=$?; wait "$p"; echo status=$?"#, "kill=1\nend\nstatus=0\n"),
		(r#"f(){ /bin/sleep .25; echo end; }; f & p=$!; kill -s exit "$p"; echo kill=$?; wait "$p"; echo status=$?"#, "kill=0\nend\nstatus=0\n"),
	])
	.await;
}

/// A signal that arrives WHILE a trap action runs interrupts it, as it
/// interrupts any other command (bash's `CHECK_WAIT_INTR`); only the
/// signals already pending when the action started wait for it. A
/// `return` out of an action drops those, so the action bash never
/// reached leaves no trace.
#[tokio::test(flavor = "multi_thread")]
async fn a_signal_during_a_trap_action_interrupts_it() {
	assert_bash_outputs(&[
		(
			r#"d=$(mktemp -d); f(){ trap 'echo one-start; : > "$d/in-one"; sleep .3; echo one-end' USR1; trap 'echo term' TERM; sleep .4; echo after; }; f & p=$!; until [ -e "$d/in-one" ]; do kill -USR1 "$p" 2>/dev/null; sleep .02; done; kill -TERM "$p"; wait "$p"; echo status=$?; rm -rf "$d""#,
			"one-start\nterm\none-end\nafter\nstatus=0\n",
		),
		(
			r#"d=$(mktemp -d); g(){ trap 'echo one; return 23' USR1; trap 'echo term; : > "$d/term-ran"' TERM; : > "$d/ready"; sleep .3; }; f(){ g; echo caller=$?; echo next; }; f & p=$!; until [ -e "$d/ready" ]; do sleep .02; done; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?; [ -e "$d/term-ran" ] && echo unexpected-term-file; rm -rf "$d""#,
			"one\ncaller=23\nnext\nstatus=0\n",
		),
	])
	.await;
}

/// A foreground external the job runs is a process of its own: a signal
/// the job's shell traps reaches the shell only, so the command runs on
/// and the trap runs when it returns. Only a program `exec` put in the
/// shell's place gets the signal itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_trapped_signal_leaves_a_foreground_external_alone() {
	assert_bash_outputs(&[
		(
			r#"d=$(mktemp -d); f(){ trap 'echo term' TERM; : > "$d/ready"; /bin/sleep .4; echo inner=$?; }; f & p=$!; until [ -e "$d/ready" ]; do sleep .02; done; kill -TERM "$p"; wait "$p"; echo status=$?; rm -rf "$d""#,
			"term\ninner=0\nstatus=0\n",
		),
		(
			r#"d=$(mktemp -d); f(){ trap 'echo term' TERM; : > "$d/ready"; /bin/sleep .4; echo inner=$?; }; f & until [ -e "$d/ready" ]; do sleep .02; done; kill -TERM %1; wait %1; echo status=$?; rm -rf "$d""#,
			"term\ninner=0\nstatus=0\n",
		),
	])
	.await;
}
