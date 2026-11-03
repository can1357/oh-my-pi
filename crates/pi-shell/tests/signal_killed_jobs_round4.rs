//! Regressions from the third review of #17845, each compared with Bash
//! 5.2.21 reading the same script on its standard input, in the same run.
//! Each script runs through `pi_shell::Shell::run`, the shell the bash tool's
//! executor runs; `PI_SHELL_BASH_ORACLE=1` sends it to Bash on both sides, to
//! check the comparison. Pids read `PID`, and Bash's `bash: line N: ` prefix
//! is folded.
#![cfg(target_os = "linux")]

use std::sync::LazyLock;

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

fn oracle() -> bool {
	std::env::var_os("PI_SHELL_BASH_ORACLE").is_some()
}

async fn run(script: &str) -> (Option<i32>, String) {
	if oracle() {
		return run_bash(script).await;
	}
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command: script.to_owned(), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(60_000)),
		)
		.await
		.expect("run");
	(result.exit_code, rx.drain().collect())
}

async fn run_bash(script: &str) -> (Option<i32>, String) {
	let script = script.to_owned();
	tokio::task::spawn_blocking(move || {
		use std::io::Write;
		let mut child = std::process::Command::new("sh")
			.args(["-c", "exec bash --noprofile --norc 2>&1"])
			.stdin(std::process::Stdio::piped())
			.stdout(std::process::Stdio::piped())
			.spawn()
			.expect("bash");
		child
			.stdin
			.take()
			.expect("stdin")
			.write_all(format!("{script}\n").as_bytes())
			.expect("write");
		let output = child.wait_with_output().expect("bash output");
		(output.status.code(), String::from_utf8_lossy(&output.stdout).into_owned())
	})
	.await
	.expect("join")
}

/// A pid where a job line prints one, with its `%5ld` padding: first on a
/// line, or after a listing's `[N]+ `, and followed by a space.
static PID: LazyLock<regex::Regex> =
	LazyLock::new(|| regex::Regex::new(r"(?m)^(\[\d+\][+ -] )?( *)(\d+) ").expect("pid"));
static PREFIX: LazyLock<regex::Regex> =
	LazyLock::new(|| regex::Regex::new(r"(?m)^bash: line \d+: ").expect("prefix"));

/// Writes every pid, of any length and with the padding `%5ld` gave it, as
/// `PID`, and drops Bash's `bash: line N: ` prefix.
fn normalize(output: &str) -> String {
	let output = PREFIX.replace_all(output, "");
	PID.replace_all(&output, |caps: &regex::Captures<'_>| {
		let listing = caps.get(1).map_or("", |prefix| prefix.as_str());
		let spaces = caps[2].len();
		let pad = 5_usize.saturating_sub(caps[3].len()).min(spaces);
		format!("{listing}{}PID ", " ".repeat(spaces - pad))
	})
	.into_owned()
}

/// Runs each `(name, script)` here and under Bash, and names every one whose
/// status or normalized output differs.
async fn assert_all_bash(rows: Vec<(String, String)>) {
	let mut mismatches = Vec::new();
	for (name, script) in &rows {
		let (status, output) = run(script).await;
		let (bash_status, bash_output) = run_bash(script).await;
		let (output, bash_output) = (normalize(&output), normalize(&bash_output));
		if (status, &output) != (bash_status, &bash_output) {
			mismatches.push(format!(
				"{name}: `{script}`\n  bash: {bash_status:?} {bash_output:?}\n  omp:  {status:?} \
				 {output:?}"
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

/// Each change a builtin can make to the job table (`disown`, `wait`,
/// `kill`, `jobs`, `fg`, `bg`, a nested pipeline, a new job), run by the last
/// command of a `lastpipe` pipeline while the pipeline's other process still
/// runs: Bash keeps the job list frozen then, so no job leaves it
/// (`delete_job` returns at once), and the pipeline still waits for that
/// process and keeps its status, `pipefail` included. The first stage is an
/// external process and one the shell runs itself; it writes a file just
/// before it exits, which the command after the pipeline looks for.
#[tokio::test(flavor = "multi_thread")]
async fn no_job_table_change_in_a_lastpipe_last_command_cuts_its_wait_short() {
	const PID_OF_1: &str = "jobs -p > $d/p; read p < $d/p; ";
	let mutations: Vec<String> = [
		"disown %1",
		"disown",
		"disown -r",
		"disown -h %1",
		"P disown $p",
		"disown %1; disown %1",
		"disown %1; jobs -l",
		"wait",
		"wait %1; echo w=$?",
		"P wait $p; echo w=$?",
		"wait -n; echo w=$?",
		"wait -n %1; echo w=$?",
		"wait -p v -n; echo \"w=$? v=${v-unset}\"",
		"wait %1; wait %1; echo w=$?",
		"kill -0 %1; echo k=$?",
		"P kill -0 $p; echo k=$?",
		"kill %1",
		"kill -HUP %1",
		"P kill -KILL $p",
		"jobs",
		"jobs -l",
		"jobs -n",
		"jobs -p >/dev/null",
		"jobs -r",
		"jobs -s",
		"jobs %1",
		"jobs -l %1",
		"fg %1",
		"bg %1",
		"/bin/true",
		"/bin/true | true",
		"/bin/true | read x",
		"x=$(:)",
		"sleep 0.05 & wait $!; echo w=$?",
		"sleep 0.05 & disown %2; jobs -l",
	]
	.iter()
	.map(|mutation| match mutation.strip_prefix("P ") {
		Some(rest) => format!("{PID_OF_1}{rest}"),
		None => (*mutation).to_owned(),
	})
	.collect();
	let firsts = [
		"/bin/sh -c \"sleep 0.2; touch $d/ready; exit 7\"",
		"{ sleep 0.2; touch $d/ready; (exit 7); }",
	];
	let mut cases = Vec::new();
	for first in firsts {
		for pipefail in ["", "set -o pipefail; "] {
			for mutation in &mutations {
				cases.push((
					format!("{pipefail}{first} | {{ {mutation}; }}"),
					format!(
						"d=$(mktemp -d); shopt -s lastpipe; {pipefail}{first} | {{ {mutation}; }}; echo \
						 status=$? \"${{PIPESTATUS[*]}}\"; test -e $d/ready; echo ready=$?; jobs -l; rm \
						 -rf $d; echo END"
					),
				));
			}
		}
	}
	// A job that was in the table before the pipeline stays there too. (A
	// listing right after `kill` races the signal's delivery, in Bash too.)
	for mutation in ["disown %1; jobs -l", "disown -r; jobs -l", "wait %1; echo w=$?", "kill %1"] {
		cases.push((
			format!("background-before/{mutation}"),
			format!(
				"d=$(mktemp -d); sleep 0.4 & shopt -s lastpipe; /bin/sh -c \"sleep 0.2; touch \
				 $d/ready; exit 7\" | {{ {mutation}; }}; echo status=$?; test -e $d/ready; echo \
				 ready=$?; wait; jobs -l; rm -rf $d; echo END"
			),
		));
	}
	assert_all_bash(cases).await;
}

/// `disown -a` in a `lastpipe` last command removes no job either, so the
/// pipeline waits for its first process and keeps its status. Bash 5.2.21
/// does not: its `delete_all_jobs` skips each frozen job but then frees the
/// whole job array, so the pipeline finds no job, returns 127 and loses the
/// first process's status, and every job is gone from the table. This shell
/// keeps Bash's frozen-list rule instead of that defect.
#[tokio::test(flavor = "multi_thread")]
async fn disown_all_in_a_lastpipe_last_command_removes_no_job() {
	if oracle() {
		return;
	}
	let script = "d=$(mktemp -d); shopt -s lastpipe; set -o pipefail; /bin/sh -c \"sleep 0.2; \
	              touch $d/ready; exit 7\" | { disown -a; }; echo status=$? \"${PIPESTATUS[*]}\"; \
	              test -e $d/ready; echo ready=$?; jobs -l; rm -rf $d; echo END";
	let (status, output) = run(script).await;
	assert_eq!(
		(status, normalize(&output)),
		(
			Some(0),
			"status=7 7 0\nready=0\n[1]  PID Exit 7                  /bin/sh -c \"sleep 0.2; touch \
			 $d/ready; exit 7\"\n     PID Done                    | disown -a\nEND\n"
				.to_owned()
		)
	);
}

/// A command substitution prints no job report and forgets each job that
/// ended, an exited background job too, except the one whose last pid is
/// `$!` (Bash's `SUBSHELL_COMSUB` branch of `notify_of_job_status`); a
/// script keeps an exited background job for `wait` and `jobs`. The jobs
/// are the substitution's own, started in it; each ends before the
/// foreground child the substitution then waits for.
#[tokio::test(flavor = "multi_thread")]
async fn a_command_substitution_forgets_each_ended_job_but_the_last() {
	let mut cases = Vec::new();
	for (name, jobs) in [
		("in-process", "sleep 0.01 & sleep 0.01 &"),
		("external", "/bin/sleep 0.01 & /bin/sleep 0.01 &"),
		("failed", "/bin/false & false &"),
		("killed", "/bin/sh -c 'kill -KILL $$' & /bin/true &"),
	] {
		cases.push((
			format!("{name}/jobs"),
			format!("x=$({jobs} /bin/sleep 0.3; jobs); echo \"[$x]\""),
		));
		cases.push((
			format!("{name}/jobs-l"),
			format!("x=$({jobs} /bin/sleep 0.3; jobs -l); echo \"$x\""),
		));
		cases.push((
			format!("{name}/wait"),
			format!(
				"x=$({jobs} /bin/sleep 0.3; wait %1 2>&1; echo w=$?; wait %2; echo v=$?); echo \"$x\""
			),
		));
		cases.push((format!("{name}/script"), format!("{jobs} /bin/sleep 0.3; jobs; echo end")));
	}
	cases.push((
		"kept-status".to_owned(),
		"x=$(sleep 0.01 & p=$!; sleep 0.01 & /bin/sleep 0.3; wait $p; echo w=$?); echo \"$x\""
			.to_owned(),
	));
	assert_all_bash(cases).await;
}
