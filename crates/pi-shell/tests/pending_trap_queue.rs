//! A vproc's queue of pending signal actions, as Bash 5.3 runs a script
//! (Bash 5.2.21 agrees on every row). Bash keeps one queue per shell:
//! `trap_handler` counts the signal, and `run_pending_traps` is the only
//! thing that runs actions — it takes the signals pending when it starts,
//! runs one action at a time in signal order, is re-entered only by a
//! signal that arrives WHILE an action runs, and leaves what it never
//! reached behind when a `return` jumps out of it.
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

/// Two signals pending at once run in signal-number order, one action
/// after the other (bash `run_pending_traps`), never interleaved.
#[tokio::test(flavor = "multi_thread")]
async fn pending_actions_run_in_signal_order_one_at_a_time() {
	assert_bash_outputs(&[
		(
			r#"f(){ trap 'echo got-usr1' USR1; trap 'echo got-term' TERM; sleep 0.5; }; f & p=$!; /bin/sleep 0.1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"got-usr1\ngot-term\nstatus=0\n",
		),
		(
			r#"f(){ trap 'echo got-usr1' USR1; trap 'echo got-usr2' USR2; sleep 0.5; }; f & p=$!; /bin/sleep 0.1; kill -USR1 "$p"; kill -USR2 "$p"; wait "$p"; echo status=$?"#,
			"got-usr1\ngot-usr2\nstatus=0\n",
		),
		(
			r#"f(){ trap 'echo one-start; echo one-end' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"one-start\none-end\nterm-start\nterm-end\nafter\nstatus=0\n",
		),
		(
			r#"h(){ echo one-start; echo one-end; }; f(){ trap 'h' USR1; trap 'echo term-start; echo term-end' TERM; /bin/sleep .35; echo after; }; f & p=$!; /bin/sleep .1; kill -USR1 "$p"; kill -TERM "$p"; wait "$p"; echo status=$?"#,
			"one-start\none-end\nterm-start\nterm-end\nafter\nstatus=0\n",
		),
	])
	.await;
}

/// An action that `exit`s or `return`s leaves the queue behind: bash's
/// `run_pending_traps` cleared `catch_flag` when it started, so the
/// actions it had not reached do not run at all.
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
	])
	.await;
}

/// A signal that arrives WHILE an action runs interrupts it, as it
/// interrupts any other command; only the signals already queued when the
/// action started wait for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_signal_during_an_action_interrupts_it() {
	assert_bash_outputs(&[(
		r#"d=$(mktemp -d); f(){ trap 'echo one-start; : > "$d/in-one"; sleep .3; echo one-end' USR1; trap 'echo term' TERM; sleep .4; echo after; }; f & p=$!; until [ -e "$d/in-one" ]; do kill -USR1 "$p" 2>/dev/null; sleep .02; done; kill -TERM "$p"; wait "$p"; echo status=$?; rm -rf "$d""#,
		"one-start\nterm\none-end\nafter\nstatus=0\n",
	)])
	.await;
}

/// The queue counts deliveries, so a second delivery of a signal already
/// queued runs its action once more and no more; and an action that runs
/// an external command is not re-entered by the `SIGCHLD` of that command.
#[tokio::test(flavor = "multi_thread")]
async fn the_queue_counts_each_delivery_once() {
	assert_bash_outputs(&[
		(
			r#"d=$(mktemp -d); f(){ trap 'echo one-start; sleep .3; echo one-end' USR1; trap 'echo term' TERM; : > "$d/ready"; sleep .6; echo after; }; f & p=$!; while [ ! -e "$d/ready" ]; do sleep .02; done; kill -USR1 "$p"; kill -TERM "$p"; sleep .1; kill -TERM "$p"; wait "$p"; echo status=$?; rm -rf "$d""#,
			"one-start\none-end\nterm\nafter\nstatus=0\n",
		),
		(
			r#"n=0; f(){ trap 'n=$((n+1)); /bin/true' CHLD; /bin/true; /bin/true; sleep .2; echo runs=$n; }; f & p=$!; wait "$p"; echo status=$?"#,
			"runs=1\nstatus=0\n",
		),
		(
			r#"d=$(mktemp -d); n=0; f(){ trap 'n=$((n+1)); [ $n -lt 3 ] && kill -WINCH $BASHPID; echo winch=$n' WINCH; : > "$d/ready"; sleep .3; echo after; }; f & p=$!; while [ ! -e "$d/ready" ]; do sleep .02; done; kill -WINCH "$p"; wait "$p"; echo status=$?; rm -rf "$d""#,
			"winch=0\nafter\nstatus=0\n",
		),
	])
	.await;
}
