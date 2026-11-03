//! A loop whose body only runs builtins never awaits anything. `timeout` must
//! still stop it, a script with such a loop in the background must still run
//! on, cancelling the run must still end it, and so must a long list inside
//! one command.
#![cfg(unix)]

use std::{
	sync::mpsc,
	time::{Duration, Instant},
};

use brush_core::{ProfileLoadBehavior, RcLoadBehavior, SourceInfo};
use pi_builtins::{BuiltinSet, default_builtins};
use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Runs `setup`, if any, and then `command` in one shell session, on a runtime
/// of its own. Returns the output of `command` and how long `command` alone
/// ran, or `None` when the two have not finished after `limit`. A loop that
/// never yields would pin a runtime worker for good, so the runtime lives on a
/// thread that is left behind instead of shut down.
fn run_within(
	setup: Option<&str>,
	command: &str,
	cwd: Option<&std::path::Path>,
	cancel_after_ms: Option<u32>,
	limit: Duration,
) -> Option<(String, Duration)> {
	let (done_tx, done_rx) = mpsc::channel();
	let setup = setup.map(str::to_owned);
	let command = command.to_owned();
	let cwd = cwd.map(|cwd| cwd.to_string_lossy().into_owned());
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(4)
			.enable_all()
			.build()
			.expect("runtime");
		let output = runtime.block_on(async move {
			let shell = Shell::new(None);
			let (tx, rx) = flume::unbounded::<String>();
			let mut setup_report = String::new();
			if let Some(setup) = setup {
				let result = shell
					.run(
						ShellRunOptions { command: setup, cwd: cwd.clone(), ..Default::default() },
						Some(tx.clone()),
						CancelToken::new(None),
					)
					.await;
				let output: String = rx.drain().collect();
				setup_report = format!(
					"[setup: {output}{}] ",
					result.map_or_else(|e| e.to_string(), |r| format!("{:?}", r.exit_code))
				);
			}
			let started = Instant::now();
			let result = shell
				.run(
					ShellRunOptions { command, cwd, ..Default::default() },
					Some(tx),
					CancelToken::new(cancel_after_ms),
				)
				.await;
			let elapsed = started.elapsed();
			let output: String = rx.drain().collect();
			let report = format!(
				"{setup_report}{output}[run: {}]",
				result.map_or_else(|e| e.to_string(), |r| format!("{:?}", r.exit_code))
			);
			(report, elapsed)
		});
		let _ = done_tx.send(output);
		std::mem::forget(runtime);
	});
	done_rx.recv_timeout(limit).ok()
}

#[test]
fn timeout_stops_a_loop_that_never_yields() {
	let started = Instant::now();
	let (output, _) = run_within(
		None,
		"timeout 1 eval 'while :; do :; done'; echo \"status=$?\"",
		None,
		None,
		Duration::from_secs(10),
	)
	.expect("`timeout 1` did not stop the loop within 10 s");
	assert!(output.contains("status=124"), "timeout did not report 124: {output:?}");
	assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
}

/// Without the yield this script hung on a 4-worker runtime when an external
/// command (`mkfifo` here; `/usr/bin/touch t` too, a builtin does not) ran
/// just before the background loop: it never got past `sleep 0.2`, so neither
/// `kill %1` nor `wait` ran. `kill %1` marks the job done whether or not the
/// loop stops, so the script checks that the loop stopped: the file it writes
/// must not grow after `kill %1`. Without `kill %1` the same file keeps
/// growing.
#[test]
fn kill_stops_a_background_loop_after_an_external_command() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (output, _) = run_within(
		None,
		"mkfifo p; while :; do echo x >> f; done & sleep 0.2; kill %1; wait; sleep 0.1; a=$(wc -c < \
		 f); sleep 0.2; b=$(wc -c < f); [ \"$a\" = \"$b\" ] && echo stopped; echo end",
		Some(dir.path()),
		None,
		Duration::from_secs(10),
	)
	.expect("the script did not reach its end within 10 s");
	assert!(output.contains("stopped"), "the loop kept writing after `kill %1`: {output:?}");
	assert!(output.contains("end"), "the script did not finish: {output:?}");
}

/// pi-shell aborts a cancelled run after a 2 s grace period, so a run that
/// ends in under 2 s, reports the interruption and runs no later command shows
/// the cancellation itself reached the loop.
#[test]
fn cancelling_the_run_stops_a_loop_under_timeout() {
	let started = Instant::now();
	let (output, _) = run_within(
		None,
		"timeout 30 eval 'while :; do :; done'; echo after",
		None,
		Some(500),
		Duration::from_secs(10),
	)
	.expect("the cancelled run did not end within 10 s");
	assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
	assert!(output.contains("interrupted"), "the cancelled run lost its diagnostics: {output:?}");
	assert!(!output.contains("after"), "the cancelled run kept running: {output:?}");
	assert!(output.ends_with("[run: None]"), "the cancelled run reported an exit code: {output:?}");
}

/// A `case` statement that matches nothing runs no body, so it never reaches a
/// statement's checkpoint: its own scan must yield for `timeout` to stop it.
/// `f` is defined by an earlier run, so the timed run does no parsing and
/// spends its time matching patterns. 300,000 arms, as in the review's
/// reproduction; without a checkpoint they held `timeout 1` for 13 to 17 s.
#[test]
fn timeout_stops_a_case_scan_that_matches_nothing() {
	let arms: String = (0..300_000).map(|i| format!("[a-y]{i}) ;; ")).collect();
	let setup = format!("f() {{ case z in {arms}esac; }}");
	let (output, elapsed) = run_within(
		Some(&setup),
		"timeout 1 f; echo \"status=$?\"",
		None,
		None,
		Duration::from_secs(120),
	)
	.expect("defining and running the scan took over 120 s");
	assert!(
		output.contains("status=124"),
		"`timeout 1` did not stop the scan: {output:?} after {elapsed:?}"
	);
	// Eight times the limit: generous for a loaded machine, and well below
	// the scan's own length without a checkpoint.
	assert!(elapsed < Duration::from_secs(8), "the timed run took {elapsed:?}: {output:?}");
}

/// What a run of `script; reached=1` did beside a task that cancels it as
/// soon as that task gets the runtime's only worker.
struct CancelledRun {
	interrupted:     bool,
	reached:         bool,
	/// Tasks alive when the cancelling task first ran: the stages of a
	/// pipeline that had been started by then.
	tasks_at_cancel: usize,
}

fn run_beside_a_cancelling_task(script: String) -> CancelledRun {
	let (result_tx, result_rx) = mpsc::sync_channel(1);
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(1)
			.enable_all()
			.build()
			.expect("runtime");
		let result = runtime.block_on(async move {
			let cancellation = CancellationToken::new();
			let (run_started_tx, run_started_rx) = oneshot::channel();

			let run_cancellation = cancellation.clone();
			let run = tokio::spawn(async move {
				let mut shell = brush_core::Shell::builder()
					.do_not_inherit_env(true)
					.profile(ProfileLoadBehavior::Skip)
					.rc(RcLoadBehavior::Skip)
					.builtins(default_builtins(BuiltinSet::BashMode))
					.build()
					.await
					.expect("shell");
				let mut params = shell.default_exec_params();
				params.set_cancel_token(run_cancellation);
				run_started_tx
					.send(())
					.expect("the cancelling task waits for the run");
				let result = shell
					.run_string(format!("{script}; reached=1"), &SourceInfo::default(), &params)
					.await
					.expect("script parses");
				(!result.is_success(), shell.env().get("reached").is_some())
			});

			let canceller = tokio::spawn(async move {
				run_started_rx.await.expect("run starts");
				let tasks = tokio::runtime::Handle::current()
					.metrics()
					.num_alive_tasks();
				cancellation.cancel();
				tasks
			});

			let (interrupted, reached) = run.await.expect("run task");
			let tasks_at_cancel = canceller.await.expect("cancelling task");
			CancelledRun { interrupted, reached, tasks_at_cancel }
		});
		let _ = result_tx.send(result);
	});
	result_rx
		.recv_timeout(Duration::from_secs(60))
		.expect("the run did not end within 60 s")
}

/// Each script holds a list of 10,000 items inside one command, more than the
/// 4,096 steps a loop may take between yields, and each list is walked by a
/// different interpreter loop. When that loop does not yield, the run keeps
/// the only worker to its end, and the cancelling task runs too late.
#[test]
fn cancellation_stops_a_long_list_inside_one_command() {
	fn items(item: impl Fn(usize) -> String, separator: &str) -> String {
		(0..10_000).map(item).collect::<Vec<_>>().join(separator)
	}
	let words = items(|i| format!("w{i}"), " ");
	let lists = [
		// The first arm matches; the other 10,000 run by fall-through, so no
		// pattern is tested and no body runs.
		(
			"arms of a case statement",
			format!("case a in a) ;& {} z) ;; esac", items(|_| "b) ;&".to_owned(), " ")),
		),
		(
			"patterns of one case arm",
			format!("case z in {}) ;; esac", items(|i| format!("w{i}"), "|")),
		),
		("words of a command", format!("g() {{ x=1; }}; g {words}")),
		("words of a for loop", format!("for i in {words}; do break; done")),
		("elements of an array assignment", format!("a=({words})")),
		("elements of a declared array", format!("declare -a a=({words})")),
		(
			"redirections of a compound command",
			format!("{{ x=1; }} {}", items(|_| ">/dev/null".to_owned(), " ")),
		),
	];
	let mut missed = vec![];
	for (list, script) in lists {
		let run = run_beside_a_cancelling_task(script);
		if !run.interrupted || run.reached {
			missed.push(format!("{list} (interrupted={}, reached={})", run.interrupted, run.reached));
		}
	}

	// A pipeline's stages run as tasks, and waiting for them yields, so the
	// run ends interrupted either way: what shows the stage loop held the
	// worker is how many stages it had started when the cancelling task ran.
	// 200 stages: each holds a pipe, and 1,000 would exceed a default
	// descriptor limit of 1,024. A stage loop that yields starts at most 128,
	// the cooperative budget; one that does not starts all 200.
	let stages = vec!["{ x=1; }"; 200].join(" | ");
	let run = run_beside_a_cancelling_task(stages);
	if run.tasks_at_cancel > 160 {
		missed.push(format!(
			"stages of a pipeline ({} tasks alive at the cancellation)",
			run.tasks_at_cancel
		));
	}

	assert!(missed.is_empty(), "the cancellation came too late for the {}", missed.join("; "));
}

/// Runs `script` through [`Shell::run`] on a runtime with one worker, the
/// state of the bash tool's runtime when every other worker is busy. Returns
/// the output, or `None` when the run has not ended after 10 s. Whatever a
/// background job or a pipe's other end must do then waits for that worker,
/// so it runs only if the foreground loop yields.
fn run_on_one_worker(script: &str) -> Option<String> {
	let (done_tx, done_rx) = mpsc::channel();
	let command = script.to_owned();
	let cwd = tempfile::tempdir().expect("tempdir");
	let cwd_path = cwd.path().to_string_lossy().into_owned();
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(1)
			.enable_all()
			.build()
			.expect("runtime");
		let output = runtime.block_on(async move {
			let shell = Shell::new(None);
			let (tx, rx) = flume::unbounded::<String>();
			let result = shell
				.run(
					ShellRunOptions { command, cwd: Some(cwd_path), ..Default::default() },
					Some(tx),
					CancelToken::new(None),
				)
				.await;
			let output: String = rx.drain().collect();
			format!(
				"{output}[run: {}]",
				result.map_or_else(|e| e.to_string(), |r| format!("{:?}", r.exit_code))
			)
		});
		let _ = done_tx.send(output);
		std::mem::forget(runtime);
	});
	let output = done_rx.recv_timeout(Duration::from_secs(10)).ok();
	drop(cwd);
	output
}

/// INFRA-714's case: a process substitution is read while a busy loop runs in
/// the background. The substitution's writer and the loop share the worker,
/// so `mapfile` gets its line, and `grep` then answers, only if the loop
/// yields.
#[test]
fn mapfile_and_grep_answer_beside_a_background_busy_loop() {
	let output = run_on_one_worker(
		"while :; do :; done & mapfile -t x < <(printf a); echo \"got=${x[0]}\"; printf 'b\\n' | \
		 grep b; kill %1; echo end",
	)
	.expect("the script did not end within 10 s");
	assert!(output.starts_with("got=a\nb\n"), "{output:?}");
	assert!(output.contains("end\n"), "{output:?}");
}

/// A foreground loop that polls a background job with `kill -0` must see the
/// job end: the job's task needs the worker the loop runs on.
#[test]
fn a_loop_polling_a_background_job_sees_it_end() {
	for script in [
		"false & p=$!; while kill -0 $p 2>/dev/null; do :; done; echo ended",
		"{ false; } & p=$!; while kill -0 $p 2>/dev/null; do :; done; echo ended",
		"sleep 0.1 & p=$!; until ! kill -0 $p 2>/dev/null; do :; done; echo ended",
	] {
		let output =
			run_on_one_worker(script).unwrap_or_else(|| panic!("{script:?} did not end within 10 s"));
		assert!(output.starts_with("ended\n"), "{script:?}: {output:?}");
	}
}

/// Each kind of loop, run in the background, must leave the foreground able to
/// run, to start a command substitution, and to stop the loop with `kill`.
#[test]
fn foreground_work_runs_beside_each_kind_of_background_loop() {
	let loops = [
		"while :; do :; done",
		"until false; do :; done",
		"for ((i = 0; 1; i++)); do :; done",
		"while ((1)); do ((1)); done",
		"while [[ 1 ]]; do [ 1 ]; done",
		"f() { :; }; while :; do f; done",
		"f() { :; }; g() { f; }; while :; do g; done",
		"while :; do eval ':'; done",
		"while :; do { :; }; done",
		"while :; do true && false || :; done",
		"while :; do case a in b) ;; esac; done",
		"while :; do if false; then :; elif false; then :; fi; done",
		"while :; do printf -v x %s a; done",
	];
	let mut missed = vec![];
	for body in loops {
		let script = format!("{body} & sleep 0.2; echo \"fg=$(echo sub)\"; kill %1; echo end");
		match run_on_one_worker(&script) {
			Some(output) if output.starts_with("fg=sub\n") && output.contains("end\n") => {},
			other => missed.push(format!("{body:?}: {other:?}")),
		}
	}
	assert!(missed.is_empty(), "the foreground did not run beside: {}", missed.join("; "));
}
