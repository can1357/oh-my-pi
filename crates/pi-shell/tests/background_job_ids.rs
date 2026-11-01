//! A background job that runs inside the shell process (a function, a
//! subshell, a brace group, an `&&`/`||` list, a builtin, a pipeline with
//! such a stage, a coprocess) takes part in job control the way the process
//! Bash forks for it does: `$!` names it, and `wait`, `kill`, `jobs` and
//! `disown` reach it by that process id. Every expected output is what GNU
//! bash 5.2.21 prints for the same script.
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

/// `$!` was empty after an in-process job, so `wait "$!"` failed with
/// `no such job` and the script went on before the job had finished.
#[tokio::test(flavor = "multi_thread")]
async fn wait_on_the_pid_of_a_background_function_waits_for_it() {
	assert_bash_outputs(&[(
		r#"f(){ sleep 0.2; echo CHILD; }; f & p=$!; case $p in ''|*[!0-9]*) echo P=no;; *) echo P=yes;; esac; wait "$p"; echo "AFTER=$?""#,
		"P=yes\nCHILD\nAFTER=0\n",
	)])
	.await;
}

/// Each row backgrounds a different kind of in-process job; the job's own
/// exit status must reach `wait "$!"`.
#[tokio::test(flavor = "multi_thread")]
async fn every_in_process_job_kind_reports_its_status_through_its_pid() {
	assert_bash_outputs(&[
		(r#"f(){ return 7; }; f & wait "$!"; echo "status=$?""#, "status=7\n"),
		(r#"( exit 3 ) & wait "$!"; echo "status=$?""#, "status=3\n"),
		(r#"{ sleep 0.1; ( exit 4 ); } & wait "$!"; echo "status=$?""#, "status=4\n"),
		(r#"false || ( exit 5 ) & wait "$!"; echo "status=$?""#, "status=5\n"),
		(r#"false & wait "$!"; echo "status=$?""#, "status=1\n"),
		(
			r#"f(){ cat >/dev/null; return 8; }; echo hi | f & wait "$!"; echo "status=$?""#,
			"status=8\n",
		),
	])
	.await;
}

/// `exit` in a background job ends the job, not the shell that waits for it:
/// only the job's status reaches `wait`. `wait %1` and `wait -n` handed the
/// job's `exit` to the waiting shell, which then exited too.
#[tokio::test(flavor = "multi_thread")]
async fn exit_in_a_background_job_ends_only_the_job() {
	assert_bash_outputs(&[
		(
			r#"{ sleep 0.1; exit 4; } & wait "$!"; echo "status=$?"; echo still-here"#,
			"status=4\nstill-here\n",
		),
		(
			r#"{ sleep 0.1; exit 4; } & wait %1; echo "status=$?"; echo still-here"#,
			"status=4\nstill-here\n",
		),
		(
			r#"{ sleep 0.1; exit 4; } & wait -n; echo "status=$?"; echo still-here"#,
			"status=4\nstill-here\n",
		),
	])
	.await;
}

/// A pid whose job left the job table keeps its status: `wait` on it again,
/// or after `wait -n` reported it, returns the same status. An external job
/// answered `not a child of this shell` (127) the second time.
#[tokio::test(flavor = "multi_thread")]
async fn a_reported_pid_keeps_its_status() {
	assert_bash_outputs(&[
		(
			r#"f(){ return 6; }; f & p=$!; sleep 0.3; wait "$p"; echo "first=$?"; wait "$p"; echo "second=$?""#,
			"first=6\nsecond=6\n",
		),
		(
			r#"/bin/sh -c 'exit 6' & p=$!; wait "$p"; echo "first=$?"; wait "$p"; echo "second=$?""#,
			"first=6\nsecond=6\n",
		),
		(
			r#"f(){ return 4; }; f & p=$!; wait -n; echo "n=$?"; wait "$p"; echo "again=$?""#,
			"n=4\nagain=4\n",
		),
	])
	.await;
}

/// A job that `wait` reported leaves the job table: waiting on its job spec
/// again is `no such job` (127). It used to report 0, a status the job never
/// returned.
#[tokio::test(flavor = "multi_thread")]
async fn a_reported_job_spec_is_forgotten() {
	assert_bash_outputs(&[
		(
			r#"f(){ return 6; }; f & wait %1; echo "first=$?"; wait %1 2>/dev/null; echo "second=$?""#,
			"first=6\nsecond=127\n",
		),
		(
			r#"/bin/sh -c 'exit 6' & wait %1; echo "first=$?"; wait %1 2>/dev/null; echo "second=$?""#,
			"first=6\nsecond=127\n",
		),
	])
	.await;
}

/// `wait` with no operand also forgets the statuses it reported.
#[tokio::test(flavor = "multi_thread")]
async fn wait_without_operands_forgets_reported_pids() {
	assert_bash_outputs(&[(
		r#"f(){ return 6; }; f & p=$!; wait; wait "$p" 2>/dev/null; echo "status=$?""#,
		"status=127\n",
	)])
	.await;
}

/// When a job leaves the table, `%%` moves to the previous job and the next
/// job takes the number after the highest one in use. A job number was the
/// table's length plus one, so two jobs could share it.
#[tokio::test(flavor = "multi_thread")]
async fn job_specs_follow_jobs_that_leave_the_table() {
	assert_bash_outputs(&[
		(
			r#"f(){ sleep 0.2; return 3; }; g(){ return 4; }; f & g & wait "$!"; echo "g=$?"; wait %%; echo "f=$?""#,
			"g=4\nf=3\n",
		),
		(
			r#"g(){ :; }; f(){ sleep 0.3; }; g & f & wait -n; f & wait %3; echo "status=$?""#,
			"status=0\n",
		),
	])
	.await;
}

/// `wait` refuses an operand with Bash's message and status: a job spec
/// that names no job is 127, not 1, and an operand that is neither a pid nor
/// a job spec says so.
#[tokio::test(flavor = "multi_thread")]
async fn wait_refuses_bad_operands_as_bash_does() {
	assert_bash_outputs(&[(
		r#"msg=$(wait "" 2>&1); echo "status=$? ${msg#*wait: }"; msg=$(wait %3 2>&1); echo "status=$? ${msg#*wait: }"; msg=$(wait -n x 2>&1); echo "status=$? ${msg#*wait: }""#,
		"status=1 `': not a pid or valid job spec\nstatus=127 %3: no such job\nstatus=127 x: no such job\n",
	)])
	.await;
}

/// A signal that ends a process ends an in-process job, and `wait` reports
/// it as Bash reports a process the signal killed: 128 plus the signal
/// number. `kill %1` used to leave `wait %1` reporting 0, and `kill "$!"` had
/// no pid to name. A job that already finished keeps its own status.
#[tokio::test(flavor = "multi_thread")]
async fn kill_ends_an_in_process_job_with_the_signal_status() {
	assert_bash_outputs(&[
		(r#"f(){ sleep 5; }; f & kill %1; wait %1; echo "status=$?""#, "status=143\n"),
		(r#"f(){ sleep 5; }; f & p=$!; kill "$p"; wait "$p"; echo "status=$?""#, "status=143\n"),
		(
			r#"exec 2>/dev/null; ( sleep 5 ) & kill -KILL "$!"; wait "$!"; echo "status=$?""#,
			"status=137\n",
		),
		(
			r#"f(){ sleep 0.3; }; f & p=$!; kill -0 "$p" && echo alive; wait "$p"; kill -0 "$p" 2>/dev/null || echo gone"#,
			"alive\ngone\n",
		),
		(
			r#"f(){ return 5; }; f & p=$!; sleep 0.3; kill "$p" 2>/dev/null; echo "kill=$?"; wait "$p"; echo "status=$?""#,
			"kill=1\nstatus=5\n",
		),
	])
	.await;
}

/// `kill` reaches an in-process job by its pid from another shell in the
/// process: a subshell, or a background watchdog that ends the job it was
/// started beside.
#[tokio::test(flavor = "multi_thread")]
async fn kill_reaches_an_in_process_job_from_a_subshell() {
	assert_bash_outputs(&[
		(
			r#"f(){ sleep 5; }; f & p=$!; (kill "$p"); echo "kill=$?"; wait "$p"; echo "status=$?""#,
			"kill=0\nstatus=143\n",
		),
		(
			r#"f(){ sleep 5; }; f & p=$!; ( sleep 0.1; kill "$p" ) & wait "$p"; echo "status=$?""#,
			"status=143\n",
		),
	])
	.await;
}

/// `jobs -p`, `jobs -l` and `wait -p` name an in-process job by the pid in
/// `$!`; `jobs -p` printed nothing, `jobs -l` printed `<pid unknown>` and
/// `wait -p` the job number.
#[tokio::test(flavor = "multi_thread")]
async fn job_listings_name_an_in_process_job_by_its_pid() {
	assert_bash_outputs(&[(
		r#"t=$(mktemp); f(){ sleep 0.3; }; f & jobs -p >"$t"; read -r j <"$t"; [ -n "$!" ] && [ "$j" = "$!" ] && echo jobs-p; jobs -l >"$t"; read -r l <"$t"; case "$l" in *"$!"*) echo jobs-l;; esac; wait -n -p w; [ "$w" = "$!" ] && echo wait-p; rm -f "$t""#,
		"jobs-p\njobs-l\nwait-p\n",
	)])
	.await;
}

/// `NAME_PID` held the coprocess's job number, so `wait "$C_PID"` asked
/// for pid 1, and `$!` was left unset.
#[tokio::test(flavor = "multi_thread")]
async fn coproc_pid_names_a_waitable_coprocess() {
	assert_bash_outputs(&[(
		r#"coproc C { echo hi; }; read -r l <&"${C[0]}"; echo "$l"; [ "$C_PID" = "$!" ] && echo same; wait "$C_PID"; echo "status=$?""#,
		"hi\nsame\nstatus=0\n",
	)])
	.await;
}

/// `disown` was not implemented: it failed with status 99, `-h` printed a
/// usage text, and the job stayed in the job table. A disowned job leaves
/// job control but keeps running, and its pid keeps the status it had so far.
#[tokio::test(flavor = "multi_thread")]
async fn disown_takes_a_job_out_of_job_control_and_leaves_it_running() {
	assert_bash_outputs(&[
		(
			r#"f(){ sleep 0.2; echo survived; }; f & disown; jobs; wait %1 2>/dev/null; echo "status=$?"; sleep 0.4"#,
			"status=127\nsurvived\n",
		),
		(r#"f(){ sleep 0.2; }; f & f & disown -a; jobs; echo "status=$?""#, "status=0\n"),
		(r#"f(){ sleep 0.3; }; f & disown -r; jobs; echo "status=$?""#, "status=0\n"),
		(r#"f(){ sleep 0.2; }; f & p=$!; disown "$p"; jobs; echo "status=$?""#, "status=0\n"),
		(
			r#"f(){ sleep 0.2; }; f & f & disown %1; wait %1 2>/dev/null; echo "first=$?"; wait %2; echo "second=$?""#,
			"first=127\nsecond=0\n",
		),
		(r#"f(){ sleep 0.2; }; f & disown -h %1; wait %1; echo "status=$?""#, "status=0\n"),
		(
			r#"f(){ sleep 0.3; return 3; }; f & p=$!; disown; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=0\n",
		),
		(
			r#"msg=$(disown %3 2>&1); echo "status=$? ${msg#*disown: }"; msg=$(disown 2>&1); echo "status=$? ${msg#*disown: }""#,
			"status=1 %3: no such job\nstatus=1 current: no such job\n",
		),
	])
	.await;
}

/// `disown -a` and `disown -r` keep no status for the pids they remove, and
/// `disown -a` forgets the statuses `wait` kept; each `disown` operand is
/// resolved against the table the operands before it left. All of them
/// removed jobs one by one, keeping each status, against the table as it was.
#[tokio::test(flavor = "multi_thread")]
async fn disown_resolves_each_operand_and_keeps_bash_statuses() {
	assert_bash_outputs(&[
		(
			r#"f(){ return 6; }; f & p=$!; wait "$p"; disown -a; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=127\n",
		),
		(
			r#"f(){ sleep 0.3; return 3; }; f & p=$!; disown -a; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=127\n",
		),
		(
			r#"f(){ sleep 0.3; return 3; }; f & p=$!; disown -r; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=127\n",
		),
		(
			r#"f(){ return 6; }; f & p=$!; wait "$p"; disown -r; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=6\n",
		),
		(r#"f(){ sleep 0.3; }; f & f & disown %% %%; jobs; echo "status=$?""#, "status=0\n"),
		(
			r#"f(){ sleep 0.3; }; f & f & disown %1 %1 2>/dev/null; echo "status=$?"; wait %2; echo "second=$?""#,
			"status=1\nsecond=0\n",
		),
	])
	.await;
}

/// A disowned external job is still a child that dropping the session would
/// kill, so the session must keep counting it for the host to retain it.
#[tokio::test(flavor = "multi_thread")]
async fn a_disowned_external_job_keeps_the_session_alive() {
	let shell = Shell::new(None);
	shell
		.run(
			ShellRunOptions { command: "sh -c 'sleep 30' & disown".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.expect("run");
	assert_eq!(shell.live_background_job_count().await, 1);
	shell.abort().await;
}

/// A job the shell runs itself keeps the session alive while it runs, plain
/// or `disown`ed, and stops counting once it ends. The count was 0, so the
/// host could drop the shell and stop the job mid-run.
#[tokio::test(flavor = "multi_thread")]
async fn an_in_process_job_keeps_the_session_alive_until_it_ends() {
	for command in ["f(){ sleep 0.4; }; f &", "f(){ sleep 0.4; }; f & disown"] {
		let shell = Shell::new(None);
		shell
			.run(
				ShellRunOptions { command: command.into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.expect("run");
		assert_eq!(shell.live_background_job_count().await, 1, "`{command}` while running");
		let ended = tokio::time::timeout(std::time::Duration::from_secs(5), async {
			while shell.live_background_job_count().await != 0 {
				tokio::time::sleep(std::time::Duration::from_millis(20)).await;
			}
		})
		.await;
		assert!(ended.is_ok(), "`{command}` was still counted 5 s after it ended");
	}
}

/// A signal the job trapped runs the job's trap once its foreground command
/// returns, and the job goes on to its own status; `exit` in the trap sets
/// it. A trap inherited from the shell that started the job does not count,
/// as an asynchronous subshell resets traps. `kill` used to end a trapping
/// job with 143 and never run the trap.
#[tokio::test(flavor = "multi_thread")]
async fn kill_runs_a_trap_the_job_set() {
	assert_bash_outputs(&[
		(
			r#"f(){ trap 'echo got-term' TERM; sleep 0.5; }; f & sleep 0.1; kill %1; wait %1; echo "status=$?""#,
			"got-term\nstatus=0\n",
		),
		(
			r#"f(){ trap 'echo got-term' TERM; sleep 0.5; }; f & p=$!; sleep 0.1; kill "$p"; wait "$p"; echo "status=$?""#,
			"got-term\nstatus=0\n",
		),
		(
			r#"f(){ trap 'echo got-term; exit 3' TERM; sleep 0.5; echo after; }; f & sleep 0.1; kill %1; wait %1; echo "status=$?""#,
			"got-term\nstatus=3\n",
		),
		(
			r#"trap 'echo parent' TERM; f(){ sleep 5; }; f & sleep 0.1; kill %1; wait %1; echo "status=$?""#,
			"status=143\n",
		),
	])
	.await;
}

/// Whether something appends to `path` within 300 ms.
fn still_written(path: &std::path::Path) -> bool {
	let before = std::fs::metadata(path).map_or(0, |meta| meta.len());
	std::thread::sleep(std::time::Duration::from_millis(300));
	std::fs::metadata(path).map_or(0, |meta| meta.len()) > before
}

/// Dropping the shell stops a background loop of builtins within a bound,
/// plain or `disown`ed. Such a loop never yields, so the abort a dropped task
/// handle requests never lands; on main the loop kept running after its
/// shell was gone. The shell runs on its own runtime, shut down without
/// waiting, so a loop that does not stop fails this test instead of hanging
/// it.
#[test]
fn dropping_the_shell_stops_its_background_loops() {
	for suffix in ["", " disown"] {
		let dir = tempfile::tempdir().expect("temporary directory");
		let output = dir.path().join("out");
		let script = format!("(while :; do echo x >> '{}'; done) &{suffix}", output.display());
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(2)
			.enable_all()
			.build()
			.expect("runtime");
		let shell = runtime.block_on(async {
			let shell = Shell::new(None);
			shell
				.run(
					ShellRunOptions { command: script, ..Default::default() },
					None,
					CancelToken::default(),
				)
				.await
				.expect("run");
			shell
		});
		assert!(still_written(&output), "`{suffix}`: the loop never started");
		runtime.block_on(async move { drop(shell) });
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
		let mut stopped = false;
		while std::time::Instant::now() < deadline {
			if !still_written(&output) {
				stopped = true;
				break;
			}
		}
		runtime.shutdown_background();
		assert!(stopped, "`{suffix}`: the loop kept running 5 s after its shell was dropped");
	}
}
