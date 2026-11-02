//! A background job that runs inside the shell process (a function, a
//! subshell, a brace group, an `&&`/`||` list, a builtin, a pipeline with
//! such a stage, a coprocess) takes part in job control the way the process
//! Bash forks for it does: `$!` names it, and `wait`, `kill`, `jobs` and
//! `disown` reach it by that process id. Every expected output is what GNU
//! bash 5.2.21 prints for the same script.
#![cfg(unix)]

use std::sync::Arc;

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs `command` in `shell`, returning its exit status and output.
async fn run_in(shell: &Shell, command: &str) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions { command: command.to_owned(), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(20_000)),
		)
		.await
		.expect("run");
	(result.exit_code, rx.drain().collect())
}

/// Runs each script in a fresh shell, eight at a time, and asserts Bash's
/// output and exit status 0, reporting every row that differs.
async fn assert_bash_outputs(rows: &[(&str, &str)]) {
	let limit = Arc::new(tokio::sync::Semaphore::new(8));
	let mut runs = tokio::task::JoinSet::new();
	for (index, &(script, _)) in rows.iter().enumerate() {
		let (script, limit) = (script.to_owned(), Arc::clone(&limit));
		runs.spawn(async move {
			let _permit = limit.acquire_owned().await.expect("run limit");
			(index, run_in(&Shell::new(None), &script).await)
		});
	}
	let mut results = runs.join_all().await;
	results.sort_unstable_by_key(|&(index, _)| index);
	let mismatches: Vec<String> = results
		.into_iter()
		.filter_map(|(index, (exit_code, output))| {
			let (script, bash_output) = rows[index];
			((exit_code, output.as_str()) != (Some(0), bash_output)).then(|| {
				format!("`{script}`\n  bash: Some(0) {bash_output:?}\n  omp:  {exit_code:?} {output:?}")
			})
		})
		.collect();
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

/// Defines `$o`, a file a `jobs` listing is written to, and `kind`, which
/// prints what the listing in `$o` was: `full` (a `[N]` line), `pid` (a bare
/// pid) or `none`. The output format differs from Bash (`Done` against
/// `Exit 1`), so rows compare the kind of listing rather than its text.
const LISTING_KIND: &str = r#"o=$(mktemp); kind(){ line=; read -r line < "$o"; case $line in "["*) echo full;; "") echo none;; *) echo pid;; esac; }; "#;

/// Starts an external job that exits with status 1 and waits until it has
/// exited, setting `$p` to its pid. Nothing has reported the job yet. A
/// foreground process waits for the exit, so the shell's runtime learns of it
/// no later than of the foreground process's own.
#[cfg(target_os = "linux")]
const ENDED_EXTERNAL_JOB: &str = r#"/bin/sh -c 'exit 1' & p=$!; /bin/sh -c 'until [ ! -e "/proc/$1" ] || [ "$(cut -d " " -f 3 "/proc/$1/stat" 2>/dev/null)" = Z ]; do :; done' sh "$p"; "#;

/// The same for a job the shell runs itself. A `sleep` in the loop that
/// waits for it lets the job's task run.
#[cfg(target_os = "linux")]
const ENDED_IN_PROCESS_JOB: &str =
	r#"f(){ return 1; }; f & p=$!; while kill -0 "$p" 2>/dev/null; do sleep 0.01; done; "#;

/// Runs each `(tail, bash output)` row twice: after [`ENDED_EXTERNAL_JOB`],
/// then after [`ENDED_IN_PROCESS_JOB`].
///
/// Each expected output is what Bash 5.2.21 prints when it reads the script
/// from stdin or a file, as a session that runs one command after another
/// does. Plain `bash -c` differs in the rows that run `wait %1`, `jobs %1` or
/// `jobs -p`: it drops an ended job from its table at the next process it
/// waits for, here the foreground waiter or `sleep`.
#[cfg(target_os = "linux")]
async fn assert_bash_outputs_after_an_ended_job(rows: &[(&str, &str)]) {
	let scripts: Vec<(String, &str)> = rows
		.iter()
		.flat_map(|&(tail, output)| {
			[ENDED_EXTERNAL_JOB, ENDED_IN_PROCESS_JOB]
				.map(|job| (format!(r#"{LISTING_KIND}{job}{tail}; rm -f "$o""#), output))
		})
		.collect();
	let rows: Vec<(&str, &str)> = scripts
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// `jobs` showed a job that had ended during the same command as `Running`:
/// it read the job states without first collecting the jobs that had ended.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn jobs_shows_a_job_that_ended_as_ended() {
	assert_bash_outputs_after_an_ended_job(&[(r#"jobs -r; echo "[end]""#, "[end]\n")]).await;
}

/// Once `jobs` has listed an ended job, the next listing of every job leaves
/// it out, `jobs -p` and `jobs -n` included. It was listed again on every
/// call.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn jobs_lists_an_ended_job_once() {
	assert_bash_outputs_after_an_ended_job(&[
		(r#"jobs >/dev/null; jobs; echo "[end]""#, "[end]\n"),
		(r#"jobs >/dev/null; jobs -p; echo "[end]""#, "[end]\n"),
		(r#"jobs -n > "$o"; kind; jobs -n > "$o"; kind"#, "full\nnone\n"),
	])
	.await;
}

/// `wait -n` passes over an ended job that `jobs`, `jobs -l`, `jobs %1` or
/// `jobs -n` listed, so with no other job it returns 127; it returned the
/// listed job again. `jobs -p` prints only pids, `jobs -r` leaves the job
/// out and `jobs %99` names no job, so none of them reports a status and
/// `wait -n` still returns the job.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn wait_n_passes_over_a_job_jobs_reported() {
	assert_bash_outputs_after_an_ended_job(&[
		(r#"jobs >/dev/null; wait -n; echo "n=$?""#, "n=127\n"),
		(r#"jobs -l >/dev/null; wait -n; echo "n=$?""#, "n=127\n"),
		(r#"jobs %1 >/dev/null; wait -n; echo "n=$?""#, "n=127\n"),
		(r#"jobs -n >/dev/null; wait -n; echo "n=$?""#, "n=127\n"),
		(r#"jobs -r %1 >/dev/null; wait -n; echo "n=$?""#, "n=127\n"),
		(r#"jobs -s %1 >/dev/null; wait -n; echo "n=$?""#, "n=127\n"),
		(r#"jobs -p >/dev/null; wait -n; echo "n=$?""#, "n=1\n"),
		(r#"jobs -r >/dev/null; wait -n; echo "n=$?""#, "n=1\n"),
		(r#"jobs %99 2>/dev/null; wait -n; echo "n=$?""#, "n=1\n"),
	])
	.await;
}

/// A listing of every job (`jobs`, `jobs -n`) keeps the ended job it reports
/// in the table, so `wait %1` still returns its status. Each job spec a
/// listing resolves takes the reported jobs out after it, so `wait %1` gives
/// 127 and a second `%1` operand names no job. A job spec that names no job
/// takes nothing out. Either way the job's pid keeps its status, also after
/// the next listing of every job. `jobs -n` took the job out at once and
/// `jobs %1` left it in.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_reported_job_leaves_the_table_where_bash_takes_it_out() {
	const TAIL: &str = r#"wait %1 2>/dev/null; echo "job=$?"; wait "$p"; echo "pid=$?""#;
	let rows = [
		(format!("jobs >/dev/null; {TAIL}"), "job=1\npid=1\n"),
		(format!("jobs -n >/dev/null; {TAIL}"), "job=1\npid=1\n"),
		(format!("jobs %1 >/dev/null; {TAIL}"), "job=127\npid=1\n"),
		(format!("jobs -n %1 >/dev/null; {TAIL}"), "job=127\npid=1\n"),
		(format!("jobs >/dev/null; jobs >/dev/null; {TAIL}"), "job=127\npid=1\n"),
		(
			r#"jobs %1 %1 >/dev/null 2>&1; echo "list=$?"; wait "$p"; echo "pid=$?""#.to_owned(),
			"list=1\npid=1\n",
		),
		(
			r#"jobs >/dev/null; jobs %99 2>/dev/null; echo "list=$?"; wait %1 2>/dev/null; echo "job=$?""#
				.to_owned(),
			"list=1\njob=1\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(tail, output)| (tail.as_str(), *output))
		.collect();
	assert_bash_outputs_after_an_ended_job(&rows).await;
}

/// The next job to start leaves out an ended job `jobs` reported, so it takes
/// that job's number. It took the next number, and `%1` still named the ended
/// job.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_new_job_takes_the_number_of_a_reported_job() {
	assert_bash_outputs_after_an_ended_job(&[(
		r#"jobs >/dev/null; /bin/sh -c 'exit 3' & wait %1; echo "jobspec=$?""#,
		"jobspec=3\n",
	)])
	.await;
}

/// A job-spec listing takes out every job a listing reported, not only the
/// job it names: after `jobs` reported both ended jobs, `jobs %2` also takes
/// out `%1`, whose pid keeps its status.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_job_spec_listing_takes_out_every_reported_job() {
	const TAIL: &str = r#"jobs >/dev/null; jobs %2 >/dev/null; wait %1 2>/dev/null; echo "job1=$?"; wait "$a"; echo "pid=$?""#;
	let scripts = [
		format!(
			r#"/bin/sh -c 'exit 1' & a=$!; /bin/sh -c 'exit 2' & b=$!; for q in $a $b; do /bin/sh -c 'until [ ! -e "/proc/$1" ] || [ "$(cut -d " " -f 3 "/proc/$1/stat" 2>/dev/null)" = Z ]; do :; done' sh "$q"; done; {TAIL}"#
		),
		format!(
			r#"f(){{ return "$1"; }}; f 1 & a=$!; f 2 & b=$!; while kill -0 $a 2>/dev/null || kill -0 $b 2>/dev/null; do sleep 0.01; done; {TAIL}"#
		),
	];
	assert_bash_outputs(&[(&scripts[0], "job1=127\npid=1\n"), (&scripts[1], "job1=127\npid=1\n")])
		.await;
}

/// `jobs -n` lists a job whose state changed since a listing last showed it,
/// and a job no listing has shown yet counts as changed, also while it runs.
/// Once a listing has shown a running job, `jobs -n` leaves it out, and
/// `wait -n` returns it when it ends: a running job is not reported. `jobs
/// -n` listed only ended jobs.
#[tokio::test(flavor = "multi_thread")]
async fn jobs_n_lists_a_job_whose_state_changed() {
	const WAIT_JOB: &str = r#"wait %1; echo "wait=$?""#;
	let rows = [
		("jobs >/dev/null", r#"wait -n; echo "n=$?""#, "n=6\n"),
		(r#"jobs -n %1 > "$o"; kind"#, WAIT_JOB, "full\nwait=6\n"),
		(r#"jobs %1 >/dev/null; jobs -n %1 > "$o"; kind"#, WAIT_JOB, "none\nwait=6\n"),
		(r#"jobs -n > "$o"; kind"#, WAIT_JOB, "full\nwait=6\n"),
		(r#"jobs >/dev/null; jobs -n > "$o"; kind"#, WAIT_JOB, "none\nwait=6\n"),
	];
	let dir = tempfile::tempdir().expect("fifo directory");
	let mut scripts = Vec::new();
	for (index, (listing, after, output)) in rows.iter().enumerate() {
		let external = dir.path().join(format!("{index}-external"));
		let in_process = dir.path().join(format!("{index}-in-process"));
		let (external, in_process) = (external.display(), in_process.display());
		let starts = [
			(
				external.to_string(),
				format!(r#"/bin/sh -c 'read -r x < "$0"; exit 6' '{external}' & "#),
			),
			(
				in_process.to_string(),
				format!(r#"g(){{ read -r x < '{in_process}'; return 6; }}; g & "#),
			),
		];
		for (fifo, start) in starts {
			scripts.push((
				format!(
					r#"{LISTING_KIND}mkfifo '{fifo}'; {start}{listing}; echo go > '{fifo}'; {after}; rm -f "$o""#
				),
				*output,
			));
		}
	}
	let rows: Vec<(&str, &str)> = scripts
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// Each run of a persistent shell starts a new input line, so it no longer
/// finds a job a listing in an earlier run reported, while the job's pid keeps
/// its status for `wait`.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_new_shell_input_forgets_a_job_jobs_reported() {
	for job in [ENDED_IN_PROCESS_JOB, ENDED_EXTERNAL_JOB] {
		let shell = Shell::new(None);
		assert_eq!(run_in(&shell, &format!("{job}jobs >/dev/null")).await, (Some(0), String::new()));
		assert_eq!(
			run_in(&shell, r#"wait %1 2>/dev/null; echo "job=$?"; wait "$p"; echo "pid=$?""#).await,
			(Some(0), "job=127\npid=1\n".to_owned())
		);
	}
}

/// Every arrangement of `-l`, `-n` and `-p` decides the listing by its last
/// option, as in Bash: each option alone and in every order, repeated, and
/// split over words. With `-p` last, `jobs` prints the ended job's pid and
/// reports nothing: a later listing of every job still shows the job, `wait
/// -n` still returns it and the next input line still finds it. With `-l`,
/// `-n` or none last, `jobs` prints the job in full and reports it: a later
/// listing leaves it out, `wait -n` passes over it, and the next input line
/// no longer finds it; `wait` on its job spec in the same line, and on its pid
/// at any time, still returns its status. A disowned job is in no listing.
///
/// A later `-l` lost to an earlier `-p` (`jobs -pl` printed only the pid and
/// reported nothing), a repeated option was refused, and a reported job was
/// still found on the next line of the same command.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn the_last_of_jobs_l_n_and_p_decides_the_listing() {
	let mut words = vec![String::new()];
	for length in 1..=3 {
		words.extend((0..3usize.pow(length)).map(|mut code| {
			let mut word = String::from("-");
			for _ in 0..length {
				word.push(['l', 'n', 'p'][code % 3]);
				code /= 3;
			}
			word
		}));
	}
	words.extend(
		[
			"-n -p", "-p -n", "-p -l", "-l -p", "-n -l", "-l -n", "-n -p -l", "-l -p -n", "-np -l",
			"-n -pl", "-pl -n", "-p -nl", "-npln", "-lpnp",
		]
		.map(String::from),
	);
	let mut scripts = Vec::new();
	for word in &words {
		let reports = word
			.chars()
			.rev()
			.find(|option| option.is_ascii_lowercase())
			!= Some('p');
		for (job, disowned) in [
			(ENDED_EXTERNAL_JOB, false),
			(ENDED_IN_PROCESS_JOB, false),
			(ENDED_EXTERNAL_JOB, true),
			(ENDED_IN_PROCESS_JOB, true),
		] {
			let start = if disowned {
				format!("{job}disown %1; ")
			} else {
				job.to_owned()
			};
			let rows = [
				(
					format!(
						r#"jobs {word} > "$o"; kind; jobs > "$o"; kind; wait -n; echo "n=$?"; wait "$p"; echo "pid=$?""#
					),
					match (disowned, reports) {
						(true, _) => "none\nnone\nn=127\npid=1\n",
						(false, true) => "full\nnone\nn=127\npid=1\n",
						(false, false) => "pid\nfull\nn=127\npid=1\n",
					},
				),
				(
					format!(r#"jobs {word} >/dev/null; wait -n; echo "n=$?"; wait "$p"; echo "pid=$?""#),
					if disowned || reports {
						"n=127\npid=1\n"
					} else {
						"n=1\npid=1\n"
					},
				),
				(
					format!(
						r#"jobs {word} >/dev/null; wait %1 2>/dev/null; echo "job=$?"; wait "$p"; echo "pid=$?""#
					),
					if disowned {
						"job=127\npid=1\n"
					} else {
						"job=1\npid=1\n"
					},
				),
				(
					format!(
						"jobs {word} >/dev/null\n{}",
						r#"jobs %1 >/dev/null 2>&1; echo "again=$?"; wait -n; echo "n=$?"; wait "$p"; echo "pid=$?""#
					),
					if disowned || reports {
						"again=1\nn=127\npid=1\n"
					} else {
						"again=0\nn=127\npid=1\n"
					},
				),
			];
			for (tail, output) in rows {
				scripts.push((format!(r#"{LISTING_KIND}{start}{tail}; rm -f "$o""#), output));
			}
		}
	}
	let rows: Vec<(&str, &str)> = scripts
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// As Bash does before it reads each input line, the shell forgets a job a
/// listing reported before it runs the next line of a command, of an `eval`
/// string (a one-line `eval` too) or of a sourced file; the job's pid keeps
/// its status. A command that spans lines (a brace group, an `if`, a function
/// body) is read whole before it runs, so its later lines still find the job,
/// as does a later command on the same line. The shell forgot a reported job
/// only when a new run started, never between the lines of one.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_reported_job_is_forgotten_before_the_next_input_line() {
	const WAITS: &str = r#"wait %1 2>/dev/null; echo "job=$?"; wait "$p"; echo "pid=$?""#;
	const AGAIN: &str = r#"jobs %1 >/dev/null 2>&1; echo again=$?"#;
	let rows = [
		(
			format!("jobs -n >/dev/null\njobs %1 > \"$o\" 2>/dev/null; kind; {WAITS}"),
			"none\njob=127\npid=1\n",
		),
		(format!(r#"jobs -n >/dev/null; jobs %1 > "$o"; kind; {WAITS}"#), "full\njob=127\npid=1\n"),
		(format!(r#"jobs >/dev/null; eval $':\n{AGAIN}'; {WAITS}"#), "again=1\njob=127\npid=1\n"),
		(format!("jobs >/dev/null; eval ':'; {WAITS}"), "job=127\npid=1\n"),
		(
			format!(
				r#"s=$(mktemp); printf ':\n%s\n' '{AGAIN}' > "$s"; jobs >/dev/null; . "$s"; rm -f "$s"; {WAITS}"#
			),
			"again=1\njob=127\npid=1\n",
		),
		(format!("{{ jobs >/dev/null\n{AGAIN}\n}}; {WAITS}"), "again=0\njob=127\npid=1\n"),
		(format!("if true; then jobs >/dev/null\n{AGAIN}\nfi; {WAITS}"), "again=0\njob=127\npid=1\n"),
		(format!("h(){{ jobs >/dev/null\n{AGAIN}\n}}; h; {WAITS}"), "again=0\njob=127\npid=1\n"),
	];
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(tail, output)| (tail.as_str(), *output))
		.collect();
	assert_bash_outputs_after_an_ended_job(&rows).await;
}

/// As Bash does when it starts a child, the shell forgets a job a listing
/// reported when it starts an external command, a builtin that stands in for
/// one (`cat`, `sleep`, `timeout`), a subshell, a pipeline, or a command or
/// process substitution; `wait %1` then names no job, while the pid keeps
/// its status. A builtin, brace group or function that runs in the shell
/// starts no child, so `wait %1` still finds the job. The shell kept the job
/// through every one of them.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn starting_a_child_forgets_a_reported_job() {
	const WAITS: &str = r#"wait %1 2>/dev/null; echo "job=$?"; wait "$p"; echo "pid=$?""#;
	let rows: Vec<(String, &str)> = [
		("/bin/true", "job=127\npid=1\n"),
		("cat </dev/null", "job=127\npid=1\n"),
		("sleep 0", "job=127\npid=1\n"),
		("timeout 5 true", "job=127\npid=1\n"),
		("(:)", "job=127\npid=1\n"),
		(": | :", "job=127\npid=1\n"),
		("x=$(:)", "job=127\npid=1\n"),
		(": <(:)", "job=127\npid=1\n"),
		("true", "job=1\npid=1\n"),
		("{ :; }", "job=1\npid=1\n"),
		("g(){ :; }; g", "job=1\npid=1\n"),
	]
	.into_iter()
	.map(|(child, output)| (format!("jobs >/dev/null; {child}; {WAITS}"), output))
	.collect();
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(tail, output)| (tail.as_str(), *output))
		.collect();
	assert_bash_outputs_after_an_ended_job(&rows).await;
}

/// `wait` prints none of the jobs it collects, also with `set -m`, as in
/// Bash; `jobs` is how a script learns their state. With `set -m`, `wait`
/// printed every job that had ended, so a job `jobs` had just reported was
/// reported a second time.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn wait_reports_no_job_under_set_m() {
	let rows: Vec<String> = [ENDED_EXTERNAL_JOB, ENDED_IN_PROCESS_JOB]
		.into_iter()
		.flat_map(|job| {
			[
				format!(r#"set -m; {job}jobs >/dev/null; wait; echo "w=$?""#),
				format!(r#"set -m; {job}wait; echo "w=$?""#),
			]
		})
		.collect();
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|script| (script.as_str(), "w=0\n"))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// A process of a job that ends, even one stage of a pipeline that runs on,
/// is a change of state no listing has shown, so `jobs -n` lists the job
/// again, as in Bash. `jobs -n` compared only the job's state, which stayed
/// `Running`, and left the job out.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn jobs_n_lists_a_job_again_after_one_of_its_processes_ends() {
	const WAIT_FOR_EXIT: &str = r#"/bin/sh -c 'until [ ! -e "/proc/$1" ] || [ "$(cut -d " " -f 3 "/proc/$1/stat" 2>/dev/null)" = Z ]; do :; done' sh"#;
	let script = format!(
		r#"{LISTING_KIND}d=$(mktemp -d); mkfifo "$d/a" "$d/b"; /bin/sh -c 'read x < "$0"' "$d/a" | /bin/sh -c 'read x < "$0"' "$d/b" & jobs -p > "$o"; read -r first < "$o"; jobs >/dev/null; jobs -n > "$o"; kind; echo go > "$d/a"; {WAIT_FOR_EXIT} "$first"; jobs -n > "$o"; kind; echo go > "$d/b"; wait; rm -rf "$d" "$o""#
	);
	assert_bash_outputs(&[(&script, "none\nfull\n")]).await;
}

/// The last of `-r` and `-s` decides which jobs `jobs` lists, and either may
/// repeat, as in Bash. Both together listed nothing, and a repeated one was
/// refused.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn the_last_of_jobs_r_and_s_decides_the_state_listed() {
	let script = format!(
		r#"{LISTING_KIND}d=$(mktemp -d); mkfifo "$d/f"; /bin/sh -c 'read x < "$0"' "$d/f" & jobs -sr > "$o"; kind; jobs -rs > "$o"; kind; jobs -rsr > "$o"; kind; jobs -ss > "$o"; kind; jobs -r -s -r > "$o"; kind; echo go > "$d/f"; wait; rm -rf "$d" "$o""#
	);
	assert_bash_outputs(&[(&script, "full\nnone\nfull\nnone\nfull\n")]).await;
}

/// With output filtering on, the bash tool runs the commands of a `;`/`&&`
/// chain one at a time. A later command of the same line is not a new input
/// line, so it still finds a job the chain's listing reported, while a command
/// on the chain's next line no longer does, as in Bash.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_chain_run_a_command_at_a_time_forgets_a_reported_job_per_line() {
	use pi_shell::{
		ShellOptions,
		minimizer::{MinimizerConfig, MinimizerOptions, engine},
	};

	let options = MinimizerOptions { enabled: Some(true), ..Default::default() };
	for (chain, output) in [
		(r#"jobs >/dev/null; wait %1 2>/dev/null; echo "job=$?""#, "job=1\n"),
		("jobs >/dev/null\nwait %1 2>/dev/null; echo \"job=$?\"", "job=127\n"),
	] {
		assert_eq!(
			engine::mode_for(chain, &MinimizerConfig::from_options(&options)),
			engine::MinimizerMode::SegmentedChain,
			"`{chain}` must run a command at a time"
		);
		for job in [ENDED_EXTERNAL_JOB, ENDED_IN_PROCESS_JOB] {
			let shell = Shell::new(Some(ShellOptions {
				minimizer: Some(options.clone()),
				..Default::default()
			}));
			assert_eq!(run_in(&shell, job).await, (Some(0), String::new()));
			assert_eq!(run_in(&shell, chain).await, (Some(0), output.to_owned()), "`{chain}`");
		}
	}
}
