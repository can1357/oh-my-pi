//! A background job that runs inside the shell process (a function, a
//! subshell, a brace group, an `&&`/`||` list, a builtin, a pipeline with
//! such a stage, a coprocess) takes part in job control the way the process
//! Bash forks for it does: `$!` names it, and `wait`, `kill`, `jobs` and
//! `disown` reach it by that process id. Every expected output is what GNU
//! bash 5.2.21 prints for the same script.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// The scripts that run at once in the whole test process. `cargo test` runs
/// every test of this file in one process, as many at once as the host has
/// CPUs; with eight scripts each, 57 tests passed the default limit of 1024
/// open files, though a shell holds none once its script has run.
static SCRIPT_RUNS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

/// Runs `command` in `shell`, returning its exit status and output. The
/// bound is for a script that hangs: a loaded host takes seconds for a row
/// that waits on processes, and nextest ends a test of its own after 240 s.
async fn run_in(shell: &Shell, command: &str) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions { command: command.to_owned(), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(60_000)),
		)
		.await
		.expect("run");
	(result.exit_code, rx.drain().collect())
}

/// Runs each script in a fresh shell, eight at a time across the process
/// (see [`SCRIPT_RUNS`]), and asserts Bash's output and exit status 0,
/// reporting every row that differs.
async fn assert_bash_outputs(rows: &[(&str, &str)]) {
	let mut runs = tokio::task::JoinSet::new();
	for (index, &(script, _)) in rows.iter().enumerate() {
		let script = script.to_owned();
		runs.spawn(async move {
			let _permit = SCRIPT_RUNS.acquire().await.expect("run limit");
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

/// A job that `wait` reported stays in the job table until the next cleanup
/// point, which the next `wait` on it is, so a second `wait` on its job spec
/// returns its status again and a third is `no such job` (127). It used to
/// report 0, a status the job never returned, and later 127 at once.
#[tokio::test(flavor = "multi_thread")]
async fn a_reported_job_spec_is_forgotten() {
	assert_bash_outputs(&[
		(
			r#"f(){ return 6; }; f & wait %1; echo "first=$?"; wait %1; echo "second=$?"; wait %1 2>/dev/null; echo "third=$?""#,
			"first=6\nsecond=6\nthird=127\n",
		),
		(
			r#"/bin/sh -c 'exit 6' & wait %1; echo "first=$?"; wait %1; echo "second=$?"; wait %1 2>/dev/null; echo "third=$?""#,
			"first=6\nsecond=6\nthird=127\n",
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
/// table's length plus one, so two jobs could share it. A job `wait` reported
/// leaves the table at the next input line.
#[tokio::test(flavor = "multi_thread")]
async fn job_specs_follow_jobs_that_leave_the_table() {
	assert_bash_outputs(&[
		(
			"f(){ sleep 0.2; return 3; }; g(){ return 4; }; f & g & wait \"$!\"; echo \"g=$?\"\nwait \
			 %%; echo \"f=$?\"",
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
	assert_bash_outputs(&[
		(
			r#"msg=$(wait %3 2>&1); echo "status=$? ${msg#*wait: }"; msg=$(wait -n x 2>&1); echo "status=$? ${msg#*wait: }""#,
			"status=127 %3: no such job\nstatus=127 x: no such job\n",
		),
		// `wait ""` prints an error containing a backtick, which brush's
		// command substitution parser reads as a nested backquote; left out.
	])
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
			r#"d=$(mktemp -d); f(){ /bin/sh -c ': > "$1/ready"; while [ -d "$1" ]; do sleep 0.01; done' sh "$d"; }; f & p=$!; ( until [ -e "$d/ready" ]; do sleep 0.01; done; kill "$p" ) & wait "$p"; echo "status=$?"; rm -rf "$d""#,
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
/// The command uses `exec` to avoid leaving a grandchild; the test kills it
/// after the assertion, since `disown` removed it from the shell's table.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_disowned_external_job_keeps_the_session_alive() {
	let files = tempfile::tempdir().expect("pid files");
	let pidfile = files.path().join("pid");
	let command = format!(
		"sh -c 'echo $$ > \"{}\"; exec sleep 30' & disown",
		pidfile.to_str().expect("utf8 path")
	);
	let shell = Shell::new(None);
	shell
		.run(ShellRunOptions { command, ..Default::default() }, None, CancelToken::default())
		.await
		.expect("run");
	assert_eq!(shell.live_background_job_count().await, 1);
	shell.abort().await;
	// Reap the disowned process the shell no longer tracks.
	if let Ok(pid) = std::fs::read_to_string(&pidfile)
		&& let Ok(pid) = pid.trim().parse::<i32>()
	{
		// SAFETY: `kill` and `waitpid` take a plain pid and a null status
		// pointer, which `waitpid` accepts; they touch no Rust memory.
		unsafe { libc::kill(pid, libc::SIGKILL) };
		// SAFETY: as above.
		unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
	}
}

/// A job the shell runs itself keeps the session alive while it runs, plain
/// or `disown`ed, and stops counting once it ends. The count was 0, so the
/// host could drop the shell and stop the job mid-run. The job runs until the
/// test creates its `go` file.
#[tokio::test(flavor = "multi_thread")]
async fn an_in_process_job_keeps_the_session_alive_until_it_ends() {
	for disown in ["", " disown"] {
		let files = tempfile::tempdir().expect("job files");
		let go = files.path().join("go");
		let command = format!(
			"f(){{ until [ -e '{}' ]; do sleep 0.01; done; }}; f &{disown}",
			go.to_str().expect("utf8 path")
		);
		let shell = Shell::new(None);
		shell
			.run(
				ShellRunOptions { command: command.clone(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.expect("run");
		assert_eq!(shell.live_background_job_count().await, 1, "`{command}` while running");
		std::fs::write(&go, "").expect("release job");
		let ended = tokio::time::timeout(std::time::Duration::from_secs(20), async {
			while shell.live_background_job_count().await != 0 {
				tokio::time::sleep(std::time::Duration::from_millis(20)).await;
			}
		})
		.await;
		assert!(ended.is_ok(), "`{command}` was still counted 20 s after it was released");
	}
}

/// A signal the job trapped runs the job's trap once its foreground command
/// returns, and the job goes on to its own status; `exit` in the trap sets
/// it. A trap inherited from the shell that started the job does not count,
/// as an asynchronous subshell resets traps. `kill` used to end a trapping
/// job with 143 and never run the trap. The job's foreground command says
/// when it runs (`ready`), after the trap is set, and runs until the shell
/// has signalled the job (`go`) or removed the directory.
#[tokio::test(flavor = "multi_thread")]
async fn kill_runs_a_trap_the_job_set() {
	const FILES: &str = r#"d=$(mktemp -d); hold(){ /bin/sh -c ': > "$1/ready"; while [ -d "$1" ] && [ ! -e "$1/go" ]; do sleep 0.01; done' sh "$d"; }; ready(){ until [ -e "$d/ready" ]; do sleep 0.01; done; }; "#;
	let rows = [
		(
			r#"f(){ trap 'echo got-term' TERM; hold; }; f & ready; kill %1; : > "$d/go"; wait %1; echo "status=$?"; rm -rf "$d""#,
			"got-term\nstatus=0\n",
		),
		(
			r#"f(){ trap 'echo got-term' TERM; hold; }; f & p=$!; ready; kill "$p"; : > "$d/go"; wait "$p"; echo "status=$?"; rm -rf "$d""#,
			"got-term\nstatus=0\n",
		),
		(
			r#"f(){ trap 'echo got-term; exit 3' TERM; hold; echo after; }; f & ready; kill %1; : > "$d/go"; wait %1; echo "status=$?"; rm -rf "$d""#,
			"got-term\nstatus=3\n",
		),
		(
			r#"trap 'echo parent' TERM; f(){ hold; }; f & ready; kill %1; wait %1; echo "status=$?"; rm -rf "$d""#,
			"status=143\n",
		),
	]
	.map(|(tail, output)| (format!("{FILES}{tail}"), output));
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
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
/// pid) or `none`. Rows compare the kind of listing; the listing's text is
/// Bash's, which `signal_killed_jobs.rs` checks.
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
			(in_process.to_string(), format!(r"g(){{ read -r x < '{in_process}'; return 6; }}; g & ")),
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
	const AGAIN: &str = r"jobs %1 >/dev/null 2>&1; echo again=$?";
	let rows = [
		(
			format!("jobs -n >/dev/null\njobs %1 > \"$o\" 2>/dev/null; kind; {WAITS}"),
			"none\njob=127\npid=1\n",
		),
		(format!(r#"jobs -n >/dev/null; jobs %1 > "$o"; kind; {WAITS}"#), "full\njob=127\npid=1\n"),
		(format!(r"jobs >/dev/null; eval $':\n{AGAIN}'; {WAITS}"), "again=1\njob=127\npid=1\n"),
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

/// Waits until the process whose pid is the argument has exited, without
/// reaping it: `zombie "$p"`.
#[cfg(target_os = "linux")]
const ZOMBIE: &str = r#"zombie(){ /bin/sh -c 'until [ ! -e "/proc/$1" ] || [ "$(cut -d " " -f 3 "/proc/$1/stat" 2>/dev/null)" = Z ]; do :; done' sh "$1"; }; "#;

/// The files `source` reads, and a newline for `eval`.
#[cfg(target_os = "linux")]
const BOUNDARY_FILES: &str = r##"d=$(mktemp -d); : > "$d/empty"; echo " " > "$d/space"; echo "#c" > "$d/comment"; echo : > "$d/cmd"; nl=$'\n'; "##;

/// What each observation of [`BOUNDARIES`] prints when the boundary kept the
/// reported job, and when it forgot it.
#[cfg(target_os = "linux")]
const KEPT: &str = "none none job=1 next=127 pid=1";
#[cfg(target_os = "linux")]
const FORGOTTEN: &str = "none none job=127 next=127 pid=1";

/// Each boundary, run after `jobs` reported the ended job, and what Bash
/// 5.2.21 prints for each observation in
/// [`a_reported_job_is_forgotten_at_each_bash_cleanup_point`]. `\n` is a new
/// input line. A `-` is not compared: Bash keeps a `lastpipe` pipeline in its
/// table as an ended foreground job until the next cleanup point, so `jobs`
/// lists it and `wait -n` returns its status, and this shell has no such job.
/// The background job sleeps: a `true &` can end between the two scans of
/// Bash's `wait -n` (`wait_for_any_job`), which then returns 127.
#[cfg(target_os = "linux")]
const BOUNDARIES: &[(&str, &str)] = &[
	("\n", FORGOTTEN),
	(":", KEPT),
	("{ :; }", KEPT),
	("if :; then :; fi", KEPT),
	("case x in x) :;; esac", KEPT),
	("g() { :; }; g", KEPT),
	("[[ x ]]", KEPT),
	("((1))", KEPT),
	("x=1", KEPT),
	(">/dev/null", KEPT),
	("$empty", KEPT),
	(": 2>/dev/null </missing_17712", KEPT),
	("/bin/true", FORGOTTEN),
	("command /bin/true", FORGOTTEN),
	("missing_17712 2>/dev/null", FORGOTTEN),
	("/missing_17712 2>/dev/null", FORGOTTEN),
	("/tmp 2>/dev/null", FORGOTTEN),
	("/bin/true 2>/dev/null </missing_17712", FORGOTTEN),
	("cat 2>/dev/null </missing_17712", FORGOTTEN),
	("sleep 0", FORGOTTEN),
	("(:)", FORGOTTEN),
	(": | :", FORGOTTEN),
	("shopt -s lastpipe; : | :", "- - job=1 - pid=1"),
	("shopt -s lastpipe; : | /bin/true", "- - job=1 - pid=1"),
	("{ /bin/sleep 0.1 & }", "full full job=0 next=0 pid=1"),
	("x=$(:)", FORGOTTEN),
	("x=$()", FORGOTTEN),
	("x=`:`", KEPT),
	(": <(:)", FORGOTTEN),
	("eval :", FORGOTTEN),
	(r#"eval " ""#, FORGOTTEN),
	(r##"eval "#c""##, FORGOTTEN),
	(r#"eval "$nl""#, FORGOTTEN),
	(r#"eval """#, KEPT),
	("eval", KEPT),
	(r#". "$d/cmd""#, FORGOTTEN),
	(r#". "$d/space""#, FORGOTTEN),
	(r#". "$d/comment""#, FORGOTTEN),
	(r#". "$d/empty""#, KEPT),
	("for a in x; do :; done", FORGOTTEN),
	("for a in; do :; done", KEPT),
	("for ((i=0;i<1;i++)); do :; done", FORGOTTEN),
	("for ((;0;)); do :; done", FORGOTTEN),
	("while false; do :; done", FORGOTTEN),
	("until true; do :; done", FORGOTTEN),
	("while :; do break; done", FORGOTTEN),
	("jobs >/dev/null", FORGOTTEN),
	("jobs %1 >/dev/null", FORGOTTEN),
	("jobs -p >/dev/null", FORGOTTEN),
	("jobs -n >/dev/null", FORGOTTEN),
	("wait %1", FORGOTTEN),
	(r#"wait "$p""#, FORGOTTEN),
	("wait", "none none job=127 next=127 pid=127"),
	("wait -n", KEPT),
	("kill -0 %1", "full full job=1 next=1 pid=1"),
	(r#"kill -0 "$p" 2>/dev/null"#, KEPT),
	("disown %1", FORGOTTEN),
];

/// After `jobs` reported an ended job, each boundary in [`BOUNDARIES`] runs,
/// then one observation: a listing of every job, `jobs -n`, `wait` on the
/// job spec, `wait -n`, or `wait` on the pid. The shell forgets the job where
/// Bash runs `cleanup_dead_jobs`: when it reads an input line, of the script,
/// of an `eval` string or a sourced file that is not empty, or of the text
/// of a `$(...)` or `<(...)` it expands; when it starts a child, an external
/// command found or not, one whose redirection fails in the child, a
/// subshell, a pipeline, a background job; after each test or pass of a
/// loop; in `wait` and `jobs`. `kill` on the job spec makes the job one no
/// listing has shown, so it is listed again and `wait -n` returns it. With
/// `lastpipe` Bash freezes its job table for the pipeline. The shell kept the
/// job through a command that is not found or fails its redirection, a
/// loop, an `eval` string or a sourced file of blanks or a comment, and
/// forgot it in a `lastpipe` pipeline.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_reported_job_is_forgotten_at_each_bash_cleanup_point() {
	const OBSERVATIONS: [&str; 5] = [
		r#"jobs > "$o"; kind"#,
		r#"jobs -n > "$o"; kind"#,
		r#"wait %1 2>/dev/null; echo "job=$?""#,
		r#"wait -n 2>/dev/null; echo "next=$?""#,
		r#"wait "$p" 2>/dev/null; echo "pid=$?""#,
	];
	let mut rows = Vec::new();
	for &(boundary, outputs) in BOUNDARIES {
		let separator = if boundary == "\n" {
			"\n".to_owned()
		} else {
			format!("; {boundary}; ")
		};
		for (observation, output) in OBSERVATIONS.iter().zip(outputs.split(' ')) {
			if output != "-" {
				rows.push((
					format!(r#"{BOUNDARY_FILES}jobs >/dev/null{separator}{observation}; rm -rf "$d""#),
					format!("{output}\n"),
				));
			}
		}
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(tail, output)| (tail.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs_after_an_ended_job(&rows).await;
}

/// `wait` on a job reports it: the job stays in the table until the next
/// cleanup point, so a second `wait` on it in the same line returns its
/// status again, and the next line no longer finds it; its pid keeps the
/// status. `wait` with no operand reports every ended job except the one
/// whose pid is `$!` and that it did not wait for, then forgets every pid's
/// status. In POSIX mode `wait` on a pid also forgets the job and the pid's
/// status, unless only the status was left. `wait -n` with an operand that
/// names no job refuses it and waits for the others; `wait` with no operand
/// leaves its `-p` variable unset. `wait` took the job out of the table at
/// once, `wait` with no operand forgot every ended job, and `wait -n` gave
/// up at the first bad operand.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn wait_reports_the_job_it_waits_for_as_bash_does() {
	assert_bash_outputs_after_an_ended_job(&[
		(
			"wait %1; echo a=$?; wait %1; echo b=$?; wait %1 2>/dev/null; echo c=$?\nwait %1 \
			 2>/dev/null; echo d=$?",
			"a=1\nb=1\nc=127\nd=127\n",
		),
		(
			"wait $p; echo a=$?; wait %1; echo b=$?\nwait %1 2>/dev/null; echo c=$?; wait $p; echo \
			 d=$?",
			"a=1\nb=1\nc=127\nd=1\n",
		),
		(
			"wait; echo a=$?; wait %1 2>/dev/null; echo b=$?; wait $p; echo c=$?\nwait %1 \
			 2>/dev/null; echo d=$?",
			"a=0\nb=1\nc=1\nd=127\n",
		),
		(
			"jobs >/dev/null; wait; wait %1 2>/dev/null; echo a=$?; wait $p 2>/dev/null; echo b=$?",
			"a=127\nb=127\n",
		),
		("set -m; jobs >/dev/null; wait; echo w=$?; wait %1 2>/dev/null; echo a=$?", "w=0\na=127\n"),
		("set -o posix; wait $p; echo a=$?; wait $p 2>/dev/null; echo b=$?", "a=1\nb=127\n"),
		(
			"set -o posix; jobs >/dev/null; /bin/true; wait $p; echo a=$?; wait $p 2>/dev/null; echo \
			 b=$?",
			"a=1\nb=1\n",
		),
		(r#"v=x; wait -p v; echo "w=$? v=${v-unset}""#, "w=0 v=unset\n"),
		("wait -n 99999999 %5 2>/dev/null; echo a=$?", "a=127\n"),
		("wait -n %5 $p 2>/dev/null; echo a=$?", "a=1\n"),
		(
			"for a in x; do jobs >/dev/null; wait %1 2>/dev/null; echo in=$?; done; wait %1 \
			 2>/dev/null; echo a=$?",
			"in=1\na=127\n",
		),
		(
			"i=0; while ((i++ < 2)); do wait %1 2>/dev/null; echo in$i=$?; jobs >/dev/null; done",
			"in1=1\nin2=127\n",
		),
	])
	.await;
}

/// Two ended jobs, statuses 1 and 2, pids `$p` and `$q`, then `tail`, for an
/// external pair and for a pair the shell runs itself.
#[cfg(target_os = "linux")]
fn after_two_ended_jobs(tail: &str) -> [String; 2] {
	[
		format!(
			r"{ZOMBIE}/bin/sh -c 'exit 1' & p=$!; /bin/sh -c 'exit 2' & q=$!; zombie $p; zombie $q; {tail}"
		),
		format!(
			r#"f(){{ return "$1"; }}; f 1 & p=$!; f 2 & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do sleep 0.01; done; {tail}"#
		),
	]
}

/// `wait -n` returns the first ended job no listing reported, in table
/// order. With none, it waits while any job runs, then returns the first
/// ended job among those it selects, a reported one too. `wait` with no
/// operand keeps the ended job whose pid is `$!` and forgets the others, and
/// every pid's status. A job-spec listing forgets the job before `wait -n`
/// resolves its operands.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn wait_n_and_wait_choose_among_jobs_as_bash_does() {
	let mut scripts = Vec::new();
	for (tail, output) in [
		(
			"wait; wait %1 2>/dev/null; echo a=$?; wait %2 2>/dev/null; echo b=$?; wait $p \
			 2>/dev/null; echo c=$?; wait $q; echo d=$?",
			"a=127\nb=2\nc=127\nd=2\n",
		),
		("wait -n; echo a=$?; wait -n; echo b=$?; wait -n; echo c=$?", "a=1\nb=2\nc=127\n"),
		("jobs %1 >/dev/null; wait -n %1 %2 2>/dev/null; echo a=$?", "a=2\n"),
	] {
		for script in after_two_ended_jobs(tail) {
			scripts.push((script, output));
		}
	}
	// The second job ends while `wait -n` waits: it then returns the first
	// ended job, the one `jobs` reported, and the second job next.
	scripts.push((
		format!(
			r#"{ZOMBIE}d=$(mktemp -d); mkfifo "$d/f"; /bin/sh -c 'exit 1' & a=$!; zombie $a; /bin/sh -c 'read x < "$0"; exit 3' "$d/f" & /bin/sh -c 'sleep 1; echo go > "$0"' "$d/f" & disown; jobs >/dev/null; wait -n; echo x=$?; wait -n; echo y=$?; wait -n; echo z=$?; rm -rf "$d""#
		),
		"x=1\ny=3\nz=127\n",
	));
	let rows: Vec<(&str, &str)> = scripts
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// With `lastpipe` the last command of a pipeline runs in the shell, and
/// Bash freezes its job table for the whole pipeline: nothing in it, an
/// external command, a loop or an `eval` included, forgets the reported job,
/// and `wait -n` returns at once. The next cleanup point after it forgets
/// the job.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_lastpipe_pipeline_forgets_no_job() {
	assert_bash_outputs_after_an_ended_job(&[
		(
			"jobs >/dev/null; shopt -s lastpipe; : | { wait %1; echo in=$?; }; wait %1 2>/dev/null; echo a=$?; wait %1 2>/dev/null; echo b=$?",
			"in=1\na=1\nb=127\n",
		),
		(
			r#"jobs >/dev/null; shopt -s lastpipe; : | { jobs > "$o"; kind; }; wait %1 2>/dev/null; echo a=$?"#,
			"full\na=1\n",
		),
		(
			"shopt -s lastpipe; : | { wait -n; echo in=$?; }; wait -n; echo a=$?; wait -n; echo b=$?",
			"in=127\na=1\nb=127\n",
		),
		(
			"jobs >/dev/null; shopt -s lastpipe; : | { /bin/true; wait %1 2>/dev/null; echo in=$?; }",
			"in=1\n",
		),
		(
			"jobs >/dev/null; shopt -s lastpipe; : | for a in x; do :; done; wait %1 2>/dev/null; echo a=$?",
			"a=1\n",
		),
		(
			"jobs >/dev/null; shopt -s lastpipe; : | eval ':'; wait %1 2>/dev/null; echo a=$?",
			"a=1\n",
		),
		(
			r#"jobs >/dev/null; shopt -s lastpipe; : | :; /bin/true; wait %1 2>/dev/null; echo a=$?; jobs > "$o"; kind"#,
			"a=127\nnone\n",
		),
	])
	.await;
}

/// Bash reads one more line of an `eval` string or a sourced file when text
/// follows the line its last command ends on, a blank line or a comment
/// line, and that read forgets the reported job; a comment on the command's
/// own line, a final newline and a here-document's lines are part of the
/// command. The text of a `$(...)` is read when its word is expanded, also
/// in a `${...}` operand that is not used, or in double quotes, but not
/// when the word is not expanded; a backquoted command's text is not read.
/// The shell read no such line and expanded no unused operand.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn reading_a_line_of_text_forgets_a_reported_job() {
	const WAIT: &str = "wait %1 2>/dev/null; echo a=$?";
	let mut rows: Vec<(String, &str)> = Vec::new();
	for (text, output) in [
		(r"jobs >/dev/null", "a=1\n"),
		(r"jobs >/dev/null\n", "a=1\n"),
		(r"jobs >/dev/null\n\n", "a=127\n"),
		(r"jobs >/dev/null\n ", "a=127\n"),
		(r"jobs >/dev/null # c", "a=1\n"),
		(r"jobs >/dev/null\n#c", "a=127\n"),
		(r"jobs >/dev/null; read v <<E\nx\nE\n", "a=1\n"),
		(r"jobs >/dev/null; read v <<E\nx\nE\n\n", "a=127\n"),
	] {
		rows.push((format!("eval $'{text}'; {WAIT}"), output));
		rows.push((
			format!(r#"s=$(mktemp); printf '{text}' > "$s"; . "$s"; {WAIT}; rm -f "$s""#),
			output,
		));
	}
	for (tail, output) in [
		("jobs >/dev/null; {\nwait %1 2>/dev/null; echo in=$?; }", "in=1\n"),
		("jobs >/dev/null; cat <<EOF\nx\nEOF\nwait %1 2>/dev/null; echo a=$?", "x\na=127\n"),
		("jobs >/dev/null; read v <<EOF; wait %1 2>/dev/null; echo a=$?\nx\nEOF\n:", "a=1\n"),
		("jobs >/dev/null; eval $':\\n'; wait %1 2>/dev/null; echo a=$?", "a=127\n"),
		(
			"jobs >/dev/null; eval $'wait %1 2>/dev/null; echo in1=$?\\nwait %1 2>/dev/null; echo \
			 in2=$?'",
			"in1=127\nin2=127\n",
		),
		("jobs >/dev/null; false && x=$(:); wait %1 2>/dev/null; echo a=$?", "a=1\n"),
		(r#"jobs >/dev/null; : "$(:)"; wait %1 2>/dev/null; echo a=$?"#, "a=127\n"),
		("jobs >/dev/null; x=1; : ${x:-$(:)}; wait %1 2>/dev/null; echo a=$?", "a=127\n"),
		("jobs >/dev/null; x=1; : ${x:+`:`}; wait %1 2>/dev/null; echo a=$?", "a=1\n"),
		("jobs >/dev/null; g(){ local x=$(:); wait %1 2>/dev/null; echo in=$?; }; g", "in=127\n"),
		("jobs >/dev/null; : > >(:); wait %1 2>/dev/null; echo a=$?", "a=127\n"),
		("jobs >/dev/null; g(){ /bin/true; }; g; wait %1 2>/dev/null; echo a=$?", "a=127\n"),
		("jobs >/dev/null; : | wait %1 2>/dev/null; echo a=$?", "a=127\n"),
		("jobs >/dev/null; coproc :; wait %1 2>/dev/null; echo a=$?", "a=0\n"),
		("jobs >/dev/null; command :; wait %1 2>/dev/null; echo a=$?", "a=1\n"),
		("disown %1; wait $p; echo a=$?", "a=1\n"),
		("jobs >/dev/null; disown %1; wait $p; echo a=$?", "a=1\n"),
	] {
		rows.push((tail.to_owned(), output));
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(tail, output)| (tail.as_str(), *output))
		.collect();
	assert_bash_outputs_after_an_ended_job(&rows).await;
}

/// `kill` on a job spec makes the job one no listing has shown, as Bash's
/// `kill_pid` does, even with a signal that changes nothing: `jobs -n` lists
/// it again, and an ended job is no longer reported. Without job control a
/// job that has ended gets no signal and `kill` succeeds. A process-group
/// operand counts the same; a pid does not. `kill %1` on an ended job failed
/// and left it reported.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn kill_on_a_job_makes_it_unreported() {
	const AFTER: &str = r#"echo k=$?; jobs -n > "$o"; kind; wait %1 2>/dev/null; echo a=$?"#;
	let rows = [
		(format!("jobs >/dev/null; kill %1; {AFTER}"), "k=0\nfull\na=1\n"),
		(format!("jobs >/dev/null; kill -0 %1; {AFTER}"), "k=0\nfull\na=1\n"),
		(format!("jobs >/dev/null; kill -0 -- -$p 2>/dev/null; {AFTER}"), "k=1\nfull\na=1\n"),
		(format!("jobs >/dev/null; kill -0 $p 2>/dev/null; {AFTER}"), "k=1\nnone\na=127\n"),
	];
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(tail, output)| (tail.as_str(), *output))
		.collect();
	assert_bash_outputs_after_an_ended_job(&rows).await;
	let scripts = ["/bin/sleep 2", "sleep 2"].map(|command| {
		format!(
			r#"{LISTING_KIND}{command} & p=$!; jobs >/dev/null; jobs -n > "$o"; kind; kill -0 %1; jobs -n > "$o"; kind; kill -0 $p; jobs -n > "$o"; kind; kill %1; wait %1; rm -f "$o""#
		)
	});
	assert_bash_outputs(&[(&scripts[0], "none\nfull\nnone\n"), (&scripts[1], "none\nfull\nnone\n")])
		.await;
}

/// With job control on (`set -m`), a process of a job that stops or
/// continues is a change no listing has shown: `jobs -n` lists the job
/// again, and `jobs -s` and `jobs -r` see its new state. Without job control
/// Bash does not see stops or continues at all. `wait` on a stopped job
/// returns 128 plus the stop signal at once. The shell saw neither.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn set_m_sees_a_job_stop_and_continue() {
	const STOPPED: &str = r#"/bin/sh -c 'while [ -e "/proc/$1/stat" ]; do read a b s rest < "/proc/$1/stat"; [ "$s" = T ] && break; done' sh "$p"; "#;
	const RUNNING: &str = r#"/bin/sh -c 'while [ -e "/proc/$1/stat" ]; do read a b s rest < "/proc/$1/stat"; [ "$s" != T ] && break; done' sh "$p"; "#;
	const END: &str = r#"exec 2>/dev/null; kill -KILL "$p"; wait "$p"; rm -f "$o""#;
	let rows = ["set -m; ", ""].map(|job_control| {
		format!(
			r#"{LISTING_KIND}{job_control}/bin/sleep 60 & p=$!; jobs >/dev/null; kill -STOP "$p"; {STOPPED}echo STOP; jobs -n > "$o"; kind; jobs -s > "$o"; kind; kill -CONT "$p"; {RUNNING}echo CONT; jobs -n > "$o"; kind; jobs -r > "$o"; kind; {END}"#
		)
	});
	let after_wait = format!(
		r#"{LISTING_KIND}set -m; /bin/sleep 60 & p=$!; kill -STOP "$p"; {STOPPED}wait %1 2>/dev/null; echo w=$?; jobs >/dev/null; kill -CONT "$p"; {RUNNING}jobs -n > "$o"; kind; {END}"#
	);
	assert_bash_outputs(&[
		(&rows[0], "STOP\nfull\nfull\nCONT\nfull\nfull\n"),
		(&rows[1], "STOP\nnone\nnone\nCONT\nnone\nfull\n"),
		(&after_wait, "w=147\nfull\n"),
	])
	.await;
}

/// A function that returns 7 is an in-process job in this shell and a forked
/// job in Bash. It has ended and `jobs` has reported it.
#[cfg(target_os = "linux")]
const REPORTED_FUNCTION_JOB: &str = r#"f(){ return 7; }; f & p=$!; while kill -0 "$p" 2>/dev/null; do sleep 0.01; done; jobs >/dev/null; "#;

/// The redirection of `command` applies to the command it wraps. Bash strips
/// `command` and its `-p`/`--` options before it decides whether that command
/// forks (`check_command_builtin`, which takes one `-p` and then one `--`):
/// `command /bin/true`, an unknown name and a function it suppresses all
/// fork, while `command -v`, `command -V`, a colon and `builtin command` do
/// not. Any other option spelling, a second `-p` or `-pp` included, leaves
/// the `command` builtin itself to run in the shell, and `command -- -p`
/// runs a program named `-p`. A failed redirection before or after the
/// command word has the same boundary. The classifier saw only `command`, so
/// the 24 external wrapped rows kept the reported job.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_redirect_of_command_uses_its_wrapped_command() {
	let mut rows = Vec::new();
	// Bash 5.2.21's status for `wait %1` after each option spelling, with
	// `/bin/true` and with `:` as the operand.
	for (options, external, colon) in [
		("-p -p", 7, 7),
		("-pp", 7, 7),
		("-p -p --", 7, 7),
		("-- -p", 127, 127),
		("-p --", 127, 7),
		("-pv", 7, 7),
		("-vp", 7, 7),
		("-v -p", 7, 7),
		("-p -v", 7, 7),
		("-x", 7, 7),
	] {
		for (operand, status) in [("/bin/true", external), (":", colon)] {
			rows.push((
				format!(
					"{REPORTED_FUNCTION_JOB}command {options} {operand} 2>/dev/null </missing_17712; \
					 wait %1 2>/dev/null; echo job=$?; wait \"$p\"; echo pid=$?"
				),
				if status == 127 {
					"job=127\npid=7\n"
				} else {
					"job=7\npid=7\n"
				},
			));
		}
	}
	for wrapper in [
		"",
		"command ",
		"command -p ",
		"command -- ",
		"command -v ",
		"command -V ",
		"command command ",
		"builtin command ",
	] {
		for operand in [":", "/bin/true", "missing_17712", "f"] {
			// The command forks unless it is the colon builtin, or an unwrapped
			// function, which runs in the shell.
			let wrapped_external =
				matches!(wrapper, "" | "command " | "command -p " | "command -- " | "command command ")
					&& operand != ":"
					&& (!wrapper.is_empty() || operand != "f");
			for prefix in [false, true] {
				let command = if prefix {
					format!("2>/dev/null </missing_17712 {wrapper}{operand}")
				} else {
					format!("{wrapper}{operand} 2>/dev/null </missing_17712")
				};
				rows.push((
					format!(
						"{REPORTED_FUNCTION_JOB}{command}; wait %1 2>/dev/null; echo job=$?; wait \
						 \"$p\"; echo pid=$?"
					),
					if wrapped_external {
						"job=127\npid=7\n"
					} else {
						"job=7\npid=7\n"
					},
				));
			}
		}
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// Bash parses each `$(...)` it meets while it expands a word, and each
/// `<(...)` or `>(...)` in a `${...}` operand: nested in an arithmetic
/// expansion, in double quotes, and in an operand `${...}` does not select.
/// Single quotes protect only outside double quotes; an escaped `$` and a
/// backquoted command stay unread. The walk stopped at arithmetic
/// expressions, did not see process substitutions, and let single quotes
/// protect inside double quotes, leaving the reported job in 14 of the
/// review's 56 rows. With `x` unset, `${x:-$((1+${y:+$(echo 0)}))}` is an
/// arithmetic syntax error that stops the script in both shells, so that row
/// is left out.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn nested_word_expansion_reads_every_bash_substitution() {
	let words = [
		"${x:-$(:)}",
		"${x:-$((1+$(echo 0)))}",
		"${x:-$[1+$(echo 0)]}",
		"${x:-<(:)}",
		"${x:->(:)}",
		"${x:-${y:-$(:)}}",
		"${x:-'$(echo ignored)'}",
		r#""${x:-'$(echo ignored)'}""#,
		r#""${x:-'${y:-$(echo ignored)}'}""#,
		r#"${x:-"$(echo ignored)"}"#,
		r"${x:-\$(echo ignored)}",
		r#""${x:-\$(echo ignored)}""#,
		"${x:+$(:)}",
		"${x:+$((1+$(echo 0)))}",
		"${x:+<(:)}",
		r#"${x:+`echo "$(:)"`}"#,
		"${x:-`echo \"$(:)\"`}",
		"${x:-$((1+${y:-$(echo 0)}))}",
		"${x:-$((1+${y:+$(echo 0)}))}",
		"${x:0:$(echo 1)}",
		"${x:0:$((1+$(echo 0)))}",
		"${x/$(echo x)/z}",
		"${x#$(echo x)}",
		"${x%$(echo x)}",
	];
	let statuses = [
		127, 127, 127, 127, 127, 127, 7, 127, 127, 127, 7, 7, 127, 127, 127, 7, 7, 127, 127, 127,
		127, 127, 127, 127,
	];
	let mut rows = Vec::new();
	for set_x in ["x=1", "unset x"] {
		for (index, (word, &status)) in words.iter().zip(statuses.iter()).enumerate() {
			if set_x == "unset x" && index == 18 {
				continue;
			}
			rows.push((
				format!(
					"{REPORTED_FUNCTION_JOB}{set_x}; : {word}; wait %1 2>/dev/null; echo job=$?; wait \
					 \"$p\"; echo pid=$?"
				),
				format!("job={status}\npid=7\n"),
			));
		}
	}
	// The observation is on the line of `read`: Bash reads a here-document's
	// lines before it runs that line, and reading the next line would forget
	// the job whatever the body holds. A quoted delimiter expands nothing.
	for (body, quote, status) in [
		("$(:)", "", 127),
		("`:`", "", 7),
		("${x:-$(:)}", "", 127),
		("${x:-$((1+$(echo 0)))}", "", 127),
		("$(:)", "\"", 7),
		("`:`", "\"", 7),
		("${x:-$(:)}", "\"", 7),
		("${x:-$((1+$(echo 0)))}", "\"", 7),
	] {
		rows.push((
			format!(
				"{REPORTED_FUNCTION_JOB}x=1; read v <<{quote}E{quote}; wait %1 2>/dev/null; echo \
				 job=$?; wait \"$p\"; echo pid=$?\n{body}\nE\n"
			),
			format!("job={status}\npid=7\n"),
		));
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// With job control, an all-external pipeline is stopped when no process
/// runs and one is stopped: an exited stage does not run. Bash lists it
/// through `jobs -s`, `jobs -n` leaves it out once `jobs` has shown it, and
/// `wait %1` warns that the job is stopped and returns at once with 128 plus
/// `WSTOPSIG` of the job's first process, here the exited `/bin/true`, so
/// 128; continued, it ends with its last stage's 7. Counting the exited
/// stage as running left the job `Running` and out of `jobs -s`, the listing
/// drained the stop report, and `wait %1` blocked until cancelled. The rows
/// are the review's; the warning's text differs between the shells, so only
/// its presence is compared.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_stopped_pipeline_with_an_exited_stage_is_waitable() {
	const START: &str = r#"o=$(mktemp); kind(){ n=0; while IFS= read -r line; do n=$((n+1)); done < "$o"; echo rows=$n; }; set -m; /bin/true | /bin/sh -c 'kill -STOP $$; /bin/sleep 0.1; exit 7' & p=$!; /bin/sh -c 'while [ -e "/proc/$1/stat" ]; do read a b s r < "/proc/$1/stat"; [ "$s" = T ] && exit; done' sh "$p"; /bin/sleep 0.2; jobs >/dev/null; "#;
	const END: &str = r#"echo status=$?; kind; [ -s "$o.err" ] && echo warned; kill -CONT %1; wait -f %1; echo final=$?; rm -f "$o" "$o.err""#;
	let rows = [
		(format!(r#"{START}jobs -s > "$o" 2> "$o.err"; {END}"#), "status=0\nrows=1\nfinal=7\n"),
		(format!(r#"{START}jobs -n > "$o" 2> "$o.err"; {END}"#), "status=0\nrows=0\nfinal=7\n"),
		(
			format!(r#"{START}wait %1 > "$o" 2> "$o.err"; {END}"#),
			"status=128\nrows=0\nwarned\nfinal=7\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// `bg` leaves a running job alone, reports that it is already in the
/// background, and succeeds. `fg` unmarks a running job, waits for it as a
/// foreground job and removes it without retaining its pid status. The shell
/// kept the mark for `fg`, retained the pid and tried to take the controlling
/// terminal in a noninteractive script, so external foregrounding failed.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn bg_and_fg_handle_a_running_job_as_bash_does() {
	let mut rows = Vec::new();
	for job in ["/bin/sleep 0.2", "f(){ /bin/sleep 0.2; }; f"] {
		rows.push((
			format!(r#"{LISTING_KIND}set -m; {job} & p=$!; jobs >/dev/null; bg %1 >/dev/null 2>&1; echo bg=$?; jobs -n > "$o"; kind; wait "$p"; echo wait=$?; rm -f "$o""#),
			"bg=0\nnone\nwait=0\n",
		));
		rows.push((
			format!(r#"{LISTING_KIND}set -m; {job} & p=$!; jobs >/dev/null; fg %1 >/dev/null 2>&1; echo fg=$?; jobs -n > "$o"; kind; wait "$p" 2>/dev/null; echo wait=$?; rm -f "$o""#),
			"fg=0\nnone\nwait=127\n",
		));
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// Builds the script of one row of `fixtures/bash_reads_sweep.tsv`: a job
/// that `jobs` reported, the variables set or unset, then the word expanded
/// as an argument, in double quotes, after a quoted brace (so Bash
/// brace-expands the word), as an assignment value, or in a here-document
/// body, and `wait %1` on the line of the expansion.
#[cfg(target_os = "linux")]
fn sweep_script(context: &str, state: &str, word: &str) -> String {
	const SETUP: &str = r#"f(){ return 7; }; f & p=$!; while kill -0 "$p" 2>/dev/null; do sleep 0.001; done; jobs >/dev/null; "#;
	const OBSERVE: &str = "wait %1 2>/dev/null; echo OBS=$?";
	let state = if state == "set" {
		"x=1; y=1; "
	} else {
		"unset x y; "
	};
	match context {
		"arg" => format!("{SETUP}{state}: {word}; {OBSERVE}"),
		"dq" => format!("{SETUP}{state}: \"{word}\"; {OBSERVE}"),
		"brace" => format!("{SETUP}{state}: '{{'{word}; {OBSERVE}"),
		"assign" => format!("{SETUP}{state}v={word}; {OBSERVE}"),
		"heredoc" => format!("{SETUP}{state}read v <<E; {OBSERVE}\n{word}\nE\n"),
		_ => panic!("unknown sweep context {context}"),
	}
}

/// Bash reads text with its parser while it expands a word wherever its
/// extraction of the word meets a `$(...)`, or a `<(...)`/`>(...)` outside
/// double quotes, also in a part of the word it then does not use: the
/// operand `${...}` does not select, a pattern, a `$((` that is a command
/// substitution, the text brace expansion scans (where single quotes inside
/// double quotes are literal), a `$'...'` once translated; a `$((` with
/// balanced parentheses is arithmetic, and only its expansions are read. The
/// fixture holds 852 words, generated over 16 payloads, 6 operators, 5 ways to
/// expand a word and both variable states, each with Bash 5.2.21's status
/// (rows that are an expansion error in Bash are left out, and `$'...'`
/// offsets of a double-quoted `${x:offset:length}` that Bash's parser
/// translates and this shell does not). A scan built on
/// guessed rules missed `${x^'$(...)'}`-style operators, backquotes inside
/// `${...}`, `$((` disambiguation and here-document quoting.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn bash_reads_command_text_where_its_extraction_does() {
	let rows: Vec<(String, String)> = include_str!("fixtures/bash_reads_sweep.tsv")
		.lines()
		.map(|line| {
			let fields: Vec<&str> = line.split('\t').collect();
			let [context, state, word, status] = fields[..] else {
				panic!("bad sweep row {line:?}");
			};
			(sweep_script(context, state, word), format!("OBS={status}\n"))
		})
		.collect();
	assert_eq!(rows.len(), 852);
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// The rows of the review that found the scan's gaps, and the other places
/// Bash parses text at expansion: a compound array assignment, in an
/// assignment statement or a declaration builtin's argument (but not before
/// a command name, and not `a[0]=x`); `case`, `[[ ]]` and `(( ))` operands
/// it evaluates; `for` words; a redirection target.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn bash_reads_command_text_at_these_expansions() {
	let rows = [
		("x=1; : ${x^'$(echo ignored)'}", 7),
		("x=1; : ${x:-$((1+`echo 0`))}", 7),
		(": $((:); :)", 7),
		(r#"x=1; : "${x:-`echo $(echo 0)`}""#, 127),
		(r#"x=1; : "`echo $(echo 0)`""#, 7),
		(r#": '{'"`echo $(echo 0)`""#, 127),
		(": `echo $(echo 0)`", 7),
		(": $( (:) )", 127),
		(": $((:);)", 7),
		("a=(one two)", 127),
		("a=()", 127),
		("a=(x); jobs >/dev/null; a+=(y)", 127),
		("a[0]=x", 7),
		("declare -a b=(1 2)", 127),
		("declare -A m=([k]=v)", 127),
		("declare -a c", 7),
		("readonly r=(1)", 127),
		("typeset -a t=(1)", 127),
		("declare s='(1 2)'", 7),
		("a=(1) :", 7),
		("case $(:) in *) ;; esac", 127),
		("case a in a) ;; $(:)) ;; esac", 7),
		("[[ $(:) ]]", 127),
		("[[ 1 || $(:) ]]", 7),
		("(( $(echo 0) ))", 127),
		("for i in $(:); do :; done", 127),
		(": >/dev/null$(:)", 127),
		("x=1; : ${x:-$'$(:)'}", 7),
	]
	.map(|(tail, status)| {
		(
			format!("{REPORTED_FUNCTION_JOB}{tail}; wait %1 2>/dev/null; echo job=$?"),
			format!("job={status}\n"),
		)
	});
	let mut rows: Vec<(String, String)> = rows.into();
	rows.push((
		format!("{REPORTED_FUNCTION_JOB}g(){{ local l=(1 2); wait %1 2>/dev/null; echo in=$?; }}; g"),
		"in=127\n".to_owned(),
	));
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// Bash expands every word of a simple command, then its assignment values,
/// before it performs a redirection, and an expansion error ends the
/// command there: nothing after it is expanded, so no later `$(...)` or
/// `${v:=...}` runs, while one before it has. A process substitution before
/// it has run too. With no command name the assignments take effect and the
/// failed redirection gives status 1; a word that holds a `$(...)` forgets
/// the reported job. The redirection failed first, then every later word was
/// expanded whatever failed, so `</missing : ${u:?oops} ${v:=$(echo touched >
/// m)}` wrote `m`. Each command runs in a subshell, which the error ends.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_redirect_expands_no_further_than_bash_does() {
	const SUBSHELL_ROWS: [(&str, &str); 12] = [
		("</missing17712 : ${u:?oops} ${v:=$(echo touched > m)}", ""),
		("</missing17712 : $(echo before > m) ${u:?oops}", "before"),
		("</missing17712 /bin/true ${u:?oops} $(echo touched > m)", ""),
		("</missing17712 x=${u:?oops} $(echo touched > m)", "touched"),
		("</missing17712 x=$(echo touched > m) y=${u:?oops}", "touched"),
		("x=${u:?oops} </missing17712 $(echo touched > m)", "touched"),
		("</missing17712 : $((1/0)) $(echo touched > m)", ""),
		("set -u; </missing17712 : $nosuchvar $(echo touched > m)", ""),
		("</missing17712 : ${v:=set} ${u:?oops}; echo v=${v-unset}", ""),
		("</missing17712 x=1 ${u:?oops}", ""),
		("</missing17712 : <(echo procsub > m) ${u:?oops}", "procsub"),
		("</missing17712 declare a=(1 2) ${u:?oops}", ""),
	];
	let mut rows: Vec<(String, String)> = SUBSHELL_ROWS
		.iter()
		.map(|&(command, written)| {
			(
				format!(
					"d=$(mktemp -d); cd \"$d\"; unset u v x; ( {command} ) 2>/dev/null; echo st=$?; \
					 sleep 0.05; [ -e m ] && echo m=$(cat m); cd /; rm -rf \"$d\""
				),
				if written.is_empty() {
					"st=1\n".to_owned()
				} else {
					format!("st=1\nm={written}\n")
				},
			)
		})
		.collect();
	// The script goes on after a redirection that fails without an expansion
	// error; an assignment with no command name takes effect. The job is
	// observed before anything else expands a `$(...)`.
	for (command, assignment_only, output) in [
		("x=$(echo touched > m) </missing17712 :", false, "job=127\nm=touched\n"),
		("</missing17712 x=$(echo touched > m) :", false, "job=127\nm=touched\n"),
		("</missing17712 x=$(echo touched > m) /bin/true", false, "job=127\nm=touched\n"),
		("</missing17712 : <(echo procsub)", false, "job=127\n"),
		("</missing17712 : $(echo touched > m)", false, "job=127\nm=touched\n"),
		("</missing17712 /bin/true $(echo touched > m)", false, "job=127\nm=touched\n"),
		("x=1 </missing17712", true, "st=1\nx=1\njob=127\n"),
		("x=$(echo touched > m) </missing17712", true, "st=1\nx=\njob=127\nm=touched\n"),
		("</missing17712 x=1", true, "st=1\nx=1\njob=127\n"),
		// Bash runs a null command whose redirection reads standard input in a
		// child; one that writes, a here-string and a here-document it runs
		// in the shell.
		("</dev/null", false, "job=127\n"),
		("x=1 </dev/null", false, "job=127\n"),
		("0<&-", false, "job=127\n"),
		(">/dev/null", false, "job=7\n"),
		("<<<x", false, "job=7\n"),
		("x=1 >/dev/null", false, "job=7\n"),
	] {
		let show = if assignment_only {
			r#"echo st=$?; echo "x=${x-unset}"; "#
		} else {
			""
		};
		rows.push((
			format!(
				"d=$(mktemp -d); cd \"$d\"; {REPORTED_FUNCTION_JOB}unset x; {{ {command}; }} \
				 2>/dev/null; {show}wait %1 2>/dev/null; echo job=$?; [ -e m ] && echo m=$(cat m); cd \
				 /; rm -rf \"$d\""
			),
			output.to_owned(),
		));
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// Waits until each pid named by its arguments is stopped: `waitstop P...`.
#[cfg(target_os = "linux")]
const WAIT_STOPPED: &str = r#"waitstop(){ for q; do /bin/sh -c 'while [ -e /proc/$1/stat ]; do read a b s r < /proc/$1/stat; [ "$s" = T ] && exit; sleep 0.001; done' sh "$q"; done; }; "#;

/// A pipeline whose two stages each stopped, by SIGSTOP or SIGTSTP. `fg`,
/// `bg` and `kill -CONT %1` continue every stage, as Bash's `killpg` does,
/// so the job ends with its last stage's 7; `wait %1` returns at once with
/// 128 plus the first stage's stop signal, and `jobs -s` lists the job.
/// Only the stored leader was continued, so `fg` waited for ever on the
/// other stage; and SIGTSTP stopped nothing, as each stage led an orphaned
/// process group in a session of its own.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn fg_bg_and_kill_continue_every_stopped_stage() {
	let mut rows = Vec::new();
	for (signal, stop_status) in [("STOP", 147)] {
		let start = format!(
			r#"d=$(mktemp -d); {WAIT_STOPPED}set -m; /bin/sh -c 'echo $$ > "$1/a"; kill -{signal} $$; exit 3' sh "$d" | /bin/sh -c 'echo $$ > "$1/b"; kill -{signal} $$; exit 7' sh "$d" & p=$!; until [ -s "$d/a" ] && [ -s "$d/b" ]; do sleep 0.01; done; waitstop $(cat "$d/a") $(cat "$d/b"); "#
		);
		for (tail, output) in [
			("fg %1 >/dev/null; echo OBS=$?".to_owned(), "OBS=7\n".to_owned()),
			("bg %1 >/dev/null; echo OBSbg=$?; wait %1; echo OBS=$?".to_owned(), "OBSbg=0\nOBS=7\n".to_owned()),
			("kill -CONT %1; wait %1; echo OBS=$?".to_owned(), "OBS=7\n".to_owned()),
			(
				"wait %1 2>/dev/null; echo OBS=$?; kill -CONT %1; wait %1; echo OBSfinal=$?".to_owned(),
				format!("OBS={stop_status}\nOBSfinal=7\n"),
			),
			(
				r#"o=$(mktemp); jobs -s > "$o"; echo OBS=$(wc -l < "$o"); kill -CONT %1; wait %1; echo OBSfinal=$?; rm -f "$o""#.to_owned(),
				"OBS=1\nOBSfinal=7\n".to_owned(),
			),
		] {
			rows.push((format!(r#"{start}{tail}; rm -rf "$d""#), output));
		}
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// Without job control `fg` and `bg` refuse at once (`no job control`, status
/// 1), and the job runs on with its status intact; a job started before
/// `set -m` is refused too (`started without job control`). With job
/// control they take no option: `-x` is an invalid option (status 2), `--`
/// ends the options, `fg` uses only its first operand, `bg` resumes each
/// operand and fails for one that names no job. `fg` and `bg` acted on the
/// job without job control.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn fg_and_bg_follow_bash_job_control_rules() {
	let mut rows: Vec<(String, String)> = Vec::new();
	for op in ["fg", "bg"] {
		for (tail, output) in [
			(
				format!(
					r#"set +m; /bin/sleep 0.2 & p=$!; {op} %1; echo OBS=$?; wait "$p"; echo OBSwait=$?"#
				),
				"OBS=1\nOBSwait=0\n",
			),
			(format!("set +m; {op}; echo OBS=$?"), "OBS=1\n"),
			(format!("set +m; {op} %5; echo OBS=$?"), "OBS=1\n"),
			(format!(r#"set +m; /bin/true & p=$!; wait "$p"; {op} %1; echo OBS=$?"#), "OBS=1\n"),
			(format!("set +m; {op} -x; echo OBS=$?"), "OBS=1\n"),
			(
				format!(
					r#"/bin/sleep 0.2 & p=$!; set -m; {op} >/dev/null; echo OBS=$?; wait "$p"; echo OBSwait=$?"#
				),
				"OBS=1\nOBSwait=0\n",
			),
			(
				format!(
					r#"/bin/sleep 0.2 & p=$!; set -m; {op} %1 >/dev/null; echo OBS=$?; wait "$p"; echo OBSwait=$?"#
				),
				"OBS=1\nOBSwait=0\n",
			),
		] {
			rows.push((format!("{{ {tail}; }} 2>/dev/null"), output.to_owned()));
		}
	}
	let stopped = format!(
		r#"{WAIT_STOPPED}set -m; /bin/sh -c 'kill -STOP $$; exit 7' & p=$!; waitstop "$p"; "#
	);
	for (op, output) in [
		("fg -x", "OBS=2\nOBSp=7\n"),
		("fg --", "OBS=7\nOBSp=127\n"),
		("fg -- %1", "OBS=7\nOBSp=127\n"),
		("fg %1 %2", "OBS=7\nOBSp=127\n"),
		("fg %5", "OBS=1\nOBSp=7\n"),
		("fg", "OBS=7\nOBSp=127\n"),
		("bg -x", "OBS=2\nOBSp=7\n"),
		("bg --", "OBS=0\nOBSp=7\n"),
		("bg %1 %2", "OBS=1\nOBSp=7\n"),
		("bg %5", "OBS=1\nOBSp=7\n"),
	] {
		rows.push((
			format!(
				r"{{ {stopped}{op} >/dev/null; echo OBS=$?; kill -CONT %1 2>/dev/null; wait -f %1 2>/dev/null; echo OBSp=$?; }} 2>/dev/null"
			),
			output.to_owned(),
		));
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// `wait` on a stopped job returns 128 plus the stop value of the status of
/// its first process: the signal while it is stopped, its exit status once it
/// exited, 0 when a signal killed it. On a pid, a value above 256 becomes 127
/// (`wait.def`); on a job spec every builtin status above 256 maps as Bash's
/// `builtin_status` does (257 and 258 to 2, the rest to 1), and 256 itself is
/// `$?`. `wait -n` on a stopped job finds nothing to wait for (127). A
/// stopped job's status saturated at 255, and SIGTSTP and SIGTTIN stopped
/// nothing.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn wait_on_a_stopped_job_uses_bash_status_arithmetic() {
	let mut rows: Vec<(String, String)> = Vec::new();
	for (first, job, pid) in [
		("exit 0", 128, 128),
		("exit 1", 129, 129),
		("exit 7", 135, 135),
		("exit 127", 255, 255),
		("exit 128", 256, 256),
		("exit 129", 2, 127),
		("exit 130", 2, 127),
		("exit 131", 1, 127),
		("exit 200", 1, 127),
		("exit 255", 1, 127),
		("kill -TERM $$", 128, 128),
	] {
		for (op, status) in [("wait %1", job), ("wait \"$p\"", pid), ("wait -n %1", 127)] {
			rows.push((
				format!(
					r#"{WAIT_STOPPED}set -m; /bin/sh -c '{first}' | /bin/sh -c 'kill -STOP $$; exit 7' & p=$!; waitstop "$p"; /bin/sleep 0.05; jobs >/dev/null; {op} 2>/dev/null; echo OBSwait=$?; kill -CONT %1; wait -f %1; echo OBSfinal=$?"#
				),
				format!("OBSwait={status}\nOBSfinal=7\n"),
			));
		}
	}
	for (signal, status) in [("STOP", 147)] {
		for op in ["wait %1", "wait \"$p\""] {
			rows.push((
				format!(
					r#"{WAIT_STOPPED}set -m; /bin/sh -c 'kill -{signal} $$; exit 7' & p=$!; waitstop "$p"; {op} 2>/dev/null; echo OBSwait=$?; kill -CONT %1; wait -f %1; echo OBSfinal=$?"#
				),
				format!("OBSwait={status}\nOBSfinal=7\n"),
			));
		}
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// With job control, `kill -CONT %1` marks a stopped job running at once, and
/// `kill %1` on a stopped job follows SIGTERM with SIGCONT, so the job's TERM
/// trap runs (Bash's `kill_pid`). The job stayed stopped in the table until
/// the next look, and a trapping stopped job never acted on the TERM.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn kill_continues_a_stopped_job_as_bash_does() {
	let marks = format!(
		r#"{WAIT_STOPPED}o=$(mktemp); set -m; /bin/sh -c 'kill -STOP $$; sleep 0.3; exit 7' & p=$!; waitstop "$p"; jobs -s >"$o"; echo S1=$(wc -l <"$o"); kill -CONT %1; jobs -r >"$o"; echo R=$(wc -l <"$o"); jobs -s > "$o"; echo S2=$(wc -l <"$o"); wait %1; echo OBS=$?; rm -f "$o""#
	);
	// The job's own status after the TERM races Bash's notice of the
	// continue, so the row looks at the trap's work instead.
	let term = format!(
		r#"{WAIT_STOPPED}d=$(mktemp -d); set -m; /bin/sh -c 'trap "echo trapped > \"$1/t\"; exit 5" TERM; kill -STOP $$; while :; do sleep 0.01; done' sh "$d" & p=$!; waitstop "$p"; kill %1; i=0; until [ -e "$d/t" ] || [ $i -ge 500 ]; do sleep 0.01; i=$((i+1)); done; cat "$d/t" 2>/dev/null || echo missing; kill -KILL "$p" 2>/dev/null; wait %1 >/dev/null 2>&1; rm -rf "$d""#
	);
	assert_bash_outputs(&[(&marks, "S1=1\nR=1\nS2=0\nOBS=7\n"), (&term, "trapped\n")]).await;
}

/// A foreground pipeline that stops returns what Bash's `wait_for` returns
/// for a stopped job: 128 plus the `WSTOPSIG` value of its first process's
/// status, which is the signal that stopped it, or its exit status once it
/// has exited, 0 when a signal killed it, and a builtin's status, which Bash
/// runs in a child. It can pass 255 (`exit 200` gives 328), and `PIPESTATUS`
/// keeps its value, since Bash sets it only for a job that ended. `return`
/// passes the status through `builtin_status`, which keeps 256 and makes 328
/// a 1, and a process exit keeps its low 8 bits. A script prints no
/// `Stopped` line; `jobs` lists the job. The status was 128 plus the stop
/// signal of the stage that stopped, `PIPESTATUS` held every stage, and the
/// shell printed the job. (A first stage that still runs when a later one
/// stops is left out: Bash waits for it to end, which hangs when it blocks
/// on a stopped reader, so this shell gives such a stage only a short
/// grace. Each row here stops after its first stage has ended.)
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_stopped_foreground_job_returns_what_bash_wait_for_returns() {
	const STOP: &str = "/bin/sh -c 'sleep .05; kill -STOP $$; exit 7'";
	const TAIL: &str = "kill -CONT %1; wait %1; echo final=$?";
	let mut rows: Vec<(String, String)> = [
		("/bin/sh -c 'exit 0'", "128/0"),
		("/bin/sh -c 'exit 3'", "131/0"),
		("/bin/sh -c 'exit 128'", "256/0"),
		("/bin/sh -c 'exit 200'", "328/0"),
		("/bin/sh -c 'kill -TERM $$'", "128/0"),
		("echo x", "128/0"),
	]
	.into_iter()
	.map(|(first, status)| {
		(
			format!(r#"set -m; {first} | {STOP}; echo "s=$?/${{PIPESTATUS[*]}}"; {TAIL}"#),
			format!("s={status}\nfinal=7\n"),
		)
	})
	.collect();
	for (script, output) in [
		(
			format!(
				r#"set -m; /bin/sh -c 'kill -STOP $$; exit 5' | /bin/sh -c 'sleep .2; exit 7'; echo "s=$?/${{PIPESTATUS[*]}}"; {TAIL}"#
			),
			"s=147/0\nfinal=7\n",
		),
		(
			format!(
				r#"set -m; set -o pipefail; /bin/sh -c 'exit 3' | {STOP}; echo "s=$?/${{PIPESTATUS[*]}}"; {TAIL}"#
			),
			"s=131/0\nfinal=7\n",
		),
		(
			format!(
				r#"set -m; trap 'echo "err=$?/${{PIPESTATUS[*]}}"' ERR; /bin/sh -c 'exit 128' | {STOP}; trap - ERR; {TAIL}"#
			),
			"err=256/0\nfinal=7\n",
		),
		(
			format!(
				r#"set -m; g(){{ /bin/sh -c 'exit 128' | {STOP}; return; }}; g; echo "s=$?/${{PIPESTATUS[*]}}"; {TAIL}"#
			),
			"s=256/256\nfinal=7\n",
		),
		(
			format!(
				r#"set -m; g(){{ /bin/sh -c 'exit 200' | {STOP}; return; }}; g; echo "s=$?/${{PIPESTATUS[*]}}"; {TAIL}"#
			),
			"s=1/1\nfinal=7\n",
		),
		(
			format!(
				r#"set -m; /bin/sh -c 'exit 200' | {STOP}; x=$?; ( exit $x ); echo "sub=$?"; {TAIL}"#
			),
			"sub=72\nfinal=7\n",
		),
		(
			format!(
				r#"set -m; /bin/sh -c 'kill -STOP $$; exit 7'; echo "s=$?/${{PIPESTATUS[*]}}"; {TAIL}"#
			),
			"s=147/0\nfinal=7\n",
		),
		(
			format!(
				r#"{LISTING_KIND}set -m; /bin/sh -c 'kill -STOP $$; exit 7'; echo "s=$?"; jobs > "$o"; kind; {TAIL}; rm -f "$o""#
			),
			"s=147\nfull\nfinal=7\n",
		),
	] {
		rows.push((script, output.to_owned()));
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// `wait -p` names the pid Bash waits for: the last process of a pipeline
/// (`find_last_pid`), as `$!` does, also for a job that stopped. It named
/// the first.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn wait_p_names_the_last_process_of_a_pipeline() {
	assert_bash_outputs(&[
		(
			r#"/bin/true | /bin/sh -c 'exit 3' & p=$!; wait -p got %1; echo "s=$? same=$([ "$got" = "$p" ] && echo y)""#,
			"s=3 same=y\n",
		),
		(
			r#"/bin/true | /bin/sh -c 'exit 3' & p=$!; wait -n -p got; echo "s=$? same=$([ "$got" = "$p" ] && echo y)""#,
			"s=3 same=y\n",
		),
		(
			r#"set -m; /bin/true | /bin/sh -c 'kill -STOP $$; exit 7' & p=$!; /bin/sh -c 'while [ -e /proc/$1/stat ]; do read a b s r </proc/$1/stat; [ "$s" = T ] && break; done' sh "$p"; sleep 0.1; wait -p got %1 2>/dev/null; echo "s=$? same=$([ "$got" = "$p" ] && echo y)"; kill -CONT %1; wait %1; echo final=$?"#,
			"s=128 same=y\nfinal=7\n",
		),
	])
	.await;
}

/// `fg`, `bg` and `kill -CONT %1` continue every process group the job's
/// stages had when they started, as Bash's `killpg` on the job's group
/// does, also the group of a stage that has exited, which still holds that
/// stage's stopped child, and for a pipeline that stopped in the
/// foreground as for one started in the background. Only `bg` and `fg` on
/// a background job reached that group: a foreground pipeline became a job
/// after its ended stage was reaped, so the job never knew the group, and
/// `kill -CONT` signalled the groups of the stages still tracked.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn continuing_a_job_reaches_the_group_of_a_stage_that_exited() {
	const CHILD: &str = r#"/usr/bin/python3 -c '"'"'import os,signal,pathlib;pathlib.Path("childpid").write_text(str(os.getpid()));os.kill(os.getpid(),signal.SIGSTOP);pathlib.Path("resumed").write_text("yes")'"'"'"#;
	const STAGE: &str = r"/bin/sh -c 'echo $$ >stagepid; until [ -s childpid ]; do /bin/sleep .01; done; /bin/sleep .2; kill -STOP $$; exit 7'";
	const STOPPED: &str = r#"until [ -s stagepid ]; do /bin/sleep .01; done; read s <stagepid; until read -r _ _ st _ <"/proc/$s/stat" && [ "$st" = T ]; do /bin/sleep .01; done; jobs >/dev/null; "#;
	const AFTER: &str = r#"i=0; until [ -s resumed ] || [ $i -ge 500 ]; do /bin/sleep .01; i=$((i+1)); done; if [ -s resumed ]; then echo child=resumed; else echo child=still-stopped; fi; read c <childpid; kill -CONT "$c" 2>/dev/null; /bin/sleep .1; cd /; rm -rf "$d""#;
	let mut rows = Vec::new();
	for background in [true, false] {
		for resume in [
			"bg %1 >/dev/null; wait %1; echo s=$?; ",
			"fg %1 >/dev/null; echo s=$?; ",
			"kill -CONT %1; wait %1; echo s=$?; ",
		] {
			let mut script = String::from(r#"d=$(mktemp -d); cd "$d"; set -m; /bin/sh -c '"#);
			script.push_str(CHILD);
			script.push_str(" & exit 0' | ");
			script.push_str(STAGE);
			script.push_str(if background { " & " } else { "; " });
			if background {
				script.push_str(STOPPED);
			}
			script.push_str(resume);
			script.push_str(AFTER);
			rows.push(script);
		}
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|script| (script.as_str(), "s=7\nchild=resumed\n"))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// A foreground pipeline whose stage still runs when another stops counts
/// as stopped here after a short grace (Bash waits for the stage instead),
/// and the job then stays stopped, as a stopped Bash job does while one of
/// its processes is stopped (`set_job_status_and_cleanup`), until `bg`,
/// `fg` or `kill -CONT` continues it and the wait gets the last stage's
/// status. The job ran again as soon as it was looked at, since a stage
/// still ran, so `bg` reported it already in the background and `fg`
/// returned the stopped status.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_pipeline_stopped_while_a_stage_ran_resumes_as_bash_does() {
	const GRACE: &str =
		"set -m; /bin/sh -c 'sleep 1; exit 33' | /bin/sh -c 'kill -STOP $$; exit 7'; ";
	let rows: Vec<(String, &str)> = [
		(r#"bg %1 >/dev/null; echo "resume=$?"; wait %1; echo "final=$?""#, "resume=0\nfinal=7\n"),
		(r#"fg %1 >/dev/null; echo "fg=$?""#, "fg=7\n"),
		(r#"kill -CONT %1; echo "resume=$?"; wait %1; echo "final=$?""#, "resume=0\nfinal=7\n"),
		(
			r#"jobs -s >/dev/null; jobs -r; echo "running=$?"; kill -CONT %1; wait %1; echo "final=$?""#,
			"running=0\nfinal=7\n",
		),
	]
	.into_iter()
	.map(|(tail, output)| (format!("{GRACE}{tail}"), output))
	.collect();
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// In a double-quoted `${x:-word}` Bash's parser translates a `$'...'` of
/// the word's own to its value as it is (`parse_matched_pair`), and the
/// expansion reads that value; one inside a single-quoted or double-quoted
/// string of the word stays as written, and its backslash goes with the
/// double quotes. One inside a nested double-quoted string was translated,
/// so `\x24(...)` became a command that ran, and one after a single quote
/// was translated.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_double_quoted_operand_translates_only_its_own_ansi_c_strings() {
	let rows: Vec<(String, &str)> = [
		(r#""${x:-"$'a\tb'"}""#, "<$'atb'>\nm=\n"),
		(r#""${x:-"$'\x24(echo injected >>m; echo BAD)'"}""#, "<$'x24(echo injected >>m; echo BAD)'>\nm=\n"),
		(r#""${x:-'$'a\tb''}""#, "<'$'a\\tb''>\nm=\n"),
		(r#""${x:-${y:-'$'a\tb''}}""#, "<'$'a\\tb''>\nm=\n"),
		(r#""${x:-$'a\tb'}""#, "<a\tb>\nm=\n"),
		(r#""${x:-'a'$'\tb'}""#, "<'a'\tb>\nm=\n"),
		(r#""${x:-`echo $'a\tb'`}""#, "<a\tb>\nm=\n"),
		(r#""${x:-$(echo $'a\tb')}""#, "<a\tb>\nm=\n"),
		(r#""${x:-a"b"$'\tc'}""#, "<ab\tc>\nm=\n"),
	]
	.into_iter()
	.map(|(word, output)| {
		(
			format!(
				r#"unset x y; d=$(mktemp -d); cd "$d"; : >m; printf '<%s>\n' {word}; printf 'm=%s\n' "$(cat m)"; cd /; rm -rf "$d""#
			),
			output,
		)
	})
	.collect();
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// In a here-document Bash translates each `$'...'` of a `%`, `#`, `/`,
/// `^`, `,` or `:` operand as it extracts it, single-quoted at the
/// operand's own level and as it is in a nested `${...}`
/// (`extract_heredoc_dolbrace_string`), and then expands the operand when
/// the variable is set, reading a `$(...)` the translation produced even
/// where the nested expansion does not use it. The scan saw only the text
/// as written, so the reported job stayed.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_here_document_operand_is_read_as_bash_translates_it() {
	let mut rows: Vec<(String, String)> = Vec::new();
	for op in ["/", ":", "##", "^^", "%", ",,"] {
		for (inner, status) in [
			("${y:-$'$(echo 0)'}", 127),
			("${y:-'$(echo 0)'}", 7),
			("$'$(echo 0)'", 7),
			("${y:+$'$(echo 0)'}", 127),
			("${y#$'$(echo 0)'}", 7),
		] {
			// Bash's offset `'$(echo 0)'` is an arithmetic syntax error.
			if op == ":" && inner == "$'$(echo 0)'" {
				continue;
			}
			rows.push((
				sweep_script("heredoc", "set", &format!("${{x{op}{inner}}}")),
				format!("OBS={status}\n"),
			));
		}
	}
	rows.push((sweep_script("heredoc", "unset", "${x/${y:-$'$(echo 0)'}}"), "OBS=7\n".to_owned()));
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), output.as_str()))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// Bash extracts a double-quoted `${x OP word}` again from the text its
/// parser left, with each `$'...'` translated, whatever `x` holds: a value
/// that leaves a quote open (`\"`, `\'`, `\\`) or holds a NUL, which ends
/// the parser's text, leaves the expansion without its closing `}`, a `bad
/// substitution` that ends the subshell with status 1. The value went in
/// as text, and the command printed it.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_translation_that_leaves_the_expansion_open_is_a_bad_substitution() {
	let mut rows: Vec<(String, &str)> = Vec::new();
	for state in ["unset x", "x=used"] {
		for op in [":-", ":+", ":=", "-"] {
			for word in [r#"$'\"'"#, r"$'\''", r"$'\\'", r"$'a\0b'", r"$'a\tb'"] {
				let output = match (word, state, op) {
					(r"$'a\tb'", "unset x", ":+") => "<>\nafter\nstatus=0\n",
					(r"$'a\tb'", "unset x", _) | (r"$'a\tb'", "x=used", ":+") => {
						"<a\tb>\nafter\nstatus=0\n"
					},
					(r"$'a\tb'", ..) => "<used>\nafter\nstatus=0\n",
					_ => "status=1\n",
				};
				rows.push((
					format!(
						"{state}; ( printf '<%s>\\n' \"${{x{op}{word}}}\"; echo after ) \
						 2>/dev/null\necho \"status=$?\""
					),
					output,
				));
			}
		}
	}
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// `kill` signals a job as Bash's `kill_pid` does (`jobs.c:3670-3741`),
/// shown on a pipeline whose two stages both stopped. A job started with
/// job control is signalled through its process group, whichever of its
/// processes a negative pid names, and here that is every group its stages
/// had; a stopped one gets SIGCONT after SIGTERM or SIGHUP, to the same
/// targets, and SIGCONT makes it run. A pid gets the signal alone, with no
/// SIGCONT and no change to the job. A job started without job control gets
/// the signal in each live process by pid and is never continued. The
/// SIGCONT after SIGTERM to one stage's group went to every group, so the
/// other stage ran instead of ending.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn kill_signals_a_stopped_pipeline_as_bash_kill_pid_does() {
	const STATE: &str = r#"st(){ s=dead; if [ -r "/proc/$1/stat" ]; then read -r _ _ s _ <"/proc/$1/stat"; [ "$s" = Z ] && s=dead; fi; echo "$s"; }; "#;
	const PIPE: &str = r#"/bin/sh -c 'echo $$ >p1; kill -STOP $$; echo one >one' | /bin/sh -c 'echo $$ >p2; kill -STOP $$; echo two >two' & until [ -s p1 ] && [ -s p2 ]; do /bin/sleep .01; done; read a <p1; read b <p2; until [ "$(st $a)" = T ] && [ "$(st $b)" = T ]; do /bin/sleep .01; done; jobs >/dev/null; "#;
	const SETTLE: &str = r#"/bin/sleep .3; i=0; while [ $i -lt 300 ]; do sa=$(st $a); sb=$(st $b); case "$sa:$sb" in dead:dead|dead:T|T:dead|T:T) break;; esac; /bin/sleep .01; i=$((i+1)); done; "#;
	const REPORT: &str = r#"one=no; [ -s one ] && one=ran; two=no; [ -s two ] && two=ran; echo "one=$one two=$two a=$(st $a) b=$(st $b)"; jobs -r >r.txt; jobs -s >s.txt; nr=0; while read -r l; do nr=$((nr+1)); done <r.txt; ns=0; while read -r l; do ns=$((ns+1)); done <s.txt; echo "running=$nr stopped=$ns"; "#;
	const CLEAN: &str =
		r#"/bin/kill -KILL "$a" "$b" 2>/dev/null; wait 2>/dev/null; cd /; rm -rf "$d""#;
	let table: [(&str, &str, &str, &str); 32] = [
		("-m", "TERM", "%1", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "TERM", "-- -$a", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "TERM", "-- -$b", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "TERM", "$a", "kill=0\none=no two=no a=T b=T\nrunning=0 stopped=1\n"),
		("-m", "TERM", "$b", "kill=0\none=no two=no a=T b=T\nrunning=0 stopped=1\n"),
		("-m", "HUP", "%1", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "HUP", "-- -$a", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "HUP", "-- -$b", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "HUP", "$a", "kill=0\none=no two=no a=T b=T\nrunning=0 stopped=1\n"),
		("-m", "HUP", "$b", "kill=0\none=no two=no a=T b=T\nrunning=0 stopped=1\n"),
		("-m", "CONT", "%1", "kill=0\none=ran two=ran a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "CONT", "-- -$a", "kill=0\none=ran two=ran a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "CONT", "-- -$b", "kill=0\none=ran two=ran a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "CONT", "$a", "kill=0\none=ran two=no a=dead b=T\nrunning=0 stopped=1\n"),
		("-m", "CONT", "$b", "kill=0\none=no two=ran a=T b=dead\nrunning=0 stopped=1\n"),
		("-m", "KILL", "%1", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "KILL", "-- -$a", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "KILL", "-- -$b", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("-m", "KILL", "$a", "kill=0\none=no two=no a=dead b=T\nrunning=0 stopped=1\n"),
		("-m", "KILL", "$b", "kill=0\none=no two=no a=T b=dead\nrunning=0 stopped=1\n"),
		("+m", "TERM", "%1", "kill=0\none=no two=no a=T b=T\nrunning=1 stopped=0\n"),
		("+m", "TERM", "$a", "kill=0\none=no two=no a=T b=T\nrunning=1 stopped=0\n"),
		("+m", "TERM", "$b", "kill=0\none=no two=no a=T b=T\nrunning=1 stopped=0\n"),
		("+m", "HUP", "%1", "kill=0\none=no two=no a=T b=T\nrunning=1 stopped=0\n"),
		("+m", "HUP", "$a", "kill=0\none=no two=no a=T b=T\nrunning=1 stopped=0\n"),
		("+m", "HUP", "$b", "kill=0\none=no two=no a=T b=T\nrunning=1 stopped=0\n"),
		("+m", "CONT", "%1", "kill=0\none=ran two=ran a=dead b=dead\nrunning=0 stopped=0\n"),
		("+m", "CONT", "$a", "kill=0\none=ran two=no a=dead b=T\nrunning=1 stopped=0\n"),
		("+m", "CONT", "$b", "kill=0\none=no two=ran a=T b=dead\nrunning=1 stopped=0\n"),
		("+m", "KILL", "%1", "kill=0\none=no two=no a=dead b=dead\nrunning=0 stopped=0\n"),
		("+m", "KILL", "$a", "kill=0\none=no two=no a=dead b=T\nrunning=1 stopped=0\n"),
		("+m", "KILL", "$b", "kill=0\none=no two=no a=T b=dead\nrunning=1 stopped=0\n"),
	];
	let rows: Vec<(String, &str)> = table
		.into_iter()
		.map(|(mode, signal, target, output)| {
			(
				format!(
					r#"{{ d=$(mktemp -d); cd "$d"; {STATE}set {mode}; {PIPE}kill -{signal} {target} 2>/dev/null; echo kill=$?; {SETTLE}{REPORT}{CLEAN}; }} 2>/dev/null"#
				),
				output,
			)
		})
		.collect();
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// Without job control `kill %1` signals each live process of the job by
/// pid, as Bash's `kill_pid` does for a job in the shell's own process
/// group: a child of the job's process, in that process's group, gets
/// nothing. With job control the job's group gets it, child included; a pid
/// reaches that process alone either way. The child got the signal without
/// job control too.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn kill_without_job_control_signals_each_process_by_pid() {
	const CHILD: &str = r#"/usr/bin/python3 -c 'import os,signal,pathlib,time
signal.signal(signal.SIGUSR1,lambda *a: pathlib.Path("parent-hit").write_text("yes"))
c=os.fork()
if c==0:
 signal.signal(signal.SIGUSR1,lambda *a: pathlib.Path("child-hit").write_text("yes"))
 pathlib.Path("childpid").write_text(str(os.getpid()))
else:
 pathlib.Path("parentpid").write_text(str(os.getpid()))
while True: time.sleep(.02)
' & "#;
	let table: [(&str, &str, &str); 4] = [
		("+m", "%1", "kill=0\nparent=hit\nchild=miss\n"),
		("+m", "$p", "kill=0\nparent=hit\nchild=miss\n"),
		("-m", "%1", "kill=0\nparent=hit\nchild=hit\n"),
		("-m", "$p", "kill=0\nparent=hit\nchild=miss\n"),
	];
	let rows: Vec<(String, &str)> = table
		.into_iter()
		.map(|(mode, target, output)| {
			(
				format!(
					r#"{{ d=$(mktemp -d); cd "$d"; set {mode}; {CHILD}p=$!; until [ -s childpid ] && [ -s parentpid ]; do /bin/sleep .01; done; kill -USR1 {target}; echo kill=$?; i=0; until [ -s parent-hit ] || [ $i -ge 300 ]; do /bin/sleep .01; i=$((i+1)); done; /bin/sleep .2; if [ -s parent-hit ]; then echo parent=hit; else echo parent=miss; fi; if [ -s child-hit ]; then echo child=hit; else echo child=miss; fi; read c <childpid; read q <parentpid; /bin/kill -KILL "$c" "$q" 2>/dev/null; wait 2>/dev/null; cd /; rm -rf "$d"; }} 2>/dev/null"#
				),
				output,
			)
		})
		.collect();
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|(script, output)| (script.as_str(), *output))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// `fg` on a job that stops again returns the stopped status and, in a
/// script, prints nothing for it, as Bash's `notify_of_job_status` prints a
/// stopped job only in an interactive shell. `fg` printed the job's
/// `Stopped` line.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn fg_prints_nothing_for_a_job_that_stops_again_in_a_script() {
	assert_bash_outputs(&[(
		r#"set -m; /bin/sh -c 'kill -STOP $$; kill -STOP $$; exit 7' & p=$!; until read -r _ _ st _ <"/proc/$p/stat" && [ "$st" = T ]; do /bin/sleep .01; done; jobs >/dev/null; fg %1 >/dev/null; echo "fg=$?"; kill -CONT %1; wait %1; echo "final=$?""#,
		"fg=147\nfinal=7\n",
	)])
	.await;
}
