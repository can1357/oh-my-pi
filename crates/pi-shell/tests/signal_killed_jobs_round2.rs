//! Regressions from the first review of #17845, each compared with Bash
//! 5.2.21 reading the same script on its standard input. Each script runs
//! through `pi_shell::Shell::run`, the shell the bash tool's executor runs;
//! `PI_SHELL_BASH_ORACLE=1` sends it to Bash too, to check the comparison.
//! Pids read `PID`, and Bash's `bash: line N: ` prefix is folded.
#![cfg(target_os = "linux")]

use std::sync::LazyLock;

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

fn oracle() -> bool {
	std::env::var_os("PI_SHELL_BASH_ORACLE").is_some()
}

async fn run_in(shell: &Shell, script: &str) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions { command: script.to_owned(), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(60_000)),
		)
		.await
		.expect("run");
	(result.exit_code, rx.drain().collect())
}

async fn run(script: &str) -> (Option<i32>, String) {
	if oracle() {
		return run_bash(script).await;
	}
	run_in(&Shell::new(None), script).await
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

fn rows(cases: &[(&str, &str)]) -> Vec<(String, String)> {
	cases
		.iter()
		.map(|&(name, script)| (name.to_owned(), script.to_owned()))
		.collect()
}

}

/// With `lastpipe` Bash waits for the pipeline with its job list frozen, so
/// a process a signal ended in it is reported at the next notify point, after
/// the commands that follow on its line: the last command's own child as a
/// job of its own, and with `pipefail` the pipeline whose earlier stage died.
#[tokio::test(flavor = "multi_thread")]
async fn lastpipe_defers_a_signal_report_until_the_next_notify_point() {
	assert_all_bash(rows(&[
		("last-stage", "shopt -s lastpipe; /bin/true | /bin/sh -c 'kill -KILL $$'; echo st=$?"),
		(
			"pipefail-first-stage",
			"set -o pipefail; shopt -s lastpipe; /bin/sh -c 'kill -HUP $$' | /bin/true; echo st=$?",
		),
		(
			"first-stage-no-pipefail",
			"shopt -s lastpipe; /bin/sh -c 'kill -HUP $$' | /bin/true; echo st=$?",
		),
		(
			"inside-last-stage",
			"shopt -s lastpipe; /bin/true | { /bin/sh -c 'kill -KILL $$'; echo in; }; echo st=$?",
		),
		(
			"next-line",
			"shopt -s lastpipe; /bin/true | /bin/sh -c 'kill -KILL $$'; echo st=$?\necho next",
		),
	]))
	.await;
}

/// Waits, without starting a child, until the process `$1` names runs
/// `sleep`: a signal Bash's forked child receives before it runs the
/// command lands in Bash's own handler, and the command then runs on. A
/// pid with no `/proc` entry (one of a job this shell runs itself) returns
/// at once.
const STARTED: &str = "started() { local c; while read -r c 2>/dev/null < /proc/$1/comm; do [[ $c \
                       == sleep ]] && return 0; done; }; ";

/// Waits, without starting a child, until the process `$1` names is gone or
/// a zombie (at most 30 s), so a signal has landed before the next step.
const DEAD: &str = "dead() { local s t=$((SECONDS+30)); while ((SECONDS < t)); do read -r s \
                    2>/dev/null < /proc/$1/stat || return 0; [[ $s == *\") Z \"* ]] && return 0; \
                    done; return 1; }; ";

/// A script that leaves early (`exit`, `set -e`, a fatal expansion error)
/// reads no more input, so the read at its end that would report a job never
/// happens.
#[tokio::test(flavor = "multi_thread")]
async fn early_exit_does_not_read_the_end_of_input() {
	assert_all_bash(vec![
		(
			"exit".to_owned(),
			format!("{STARTED}sleep 30 & started $!; kill -HUP $!; echo before; exit 0"),
		),
		(
			"errexit".to_owned(),
			format!(
				"{STARTED}set -e; sleep 30 & started $!; kill -HUP $!; echo before; false; echo after"
			),
		),
	])
	.await;

	// The shell's own text for the expansion error differs from Bash's
	// (`undefined_var: boom`), so that line is left out of the comparison.
	let script = format!(
		"{STARTED}sleep 30 & started $!; kill -HUP $!; echo before; : ${{undefined_var?boom}}; echo \
		 after"
	);
	let script = script.as_str();
	let without_error = |(status, output): (Option<i32>, String)| {
		let mut kept = String::new();
		for line in normalize(&output)
			.lines()
			.filter(|line| !line.contains("boom"))
		{
			kept.push_str(line);
			kept.push('\n');
		}
		(status, kept)
	};
	assert_eq!(without_error(run(script).await), without_error(run_bash(script).await), "{script}");
}

/// Each stage of a background pipeline that runs in the shell has a pid, a
/// status and a command of its own, as Bash's forked stages do: a report
/// prints one line per stage, and `kill` of one stage's pid ends that stage
/// alone.
#[tokio::test(flavor = "multi_thread")]
async fn background_pipelines_report_every_stage() {
	assert_all_bash(vec![
		// `sleep 0.1` lets the first stage write before its reader dies (a
		// stage the shell runs itself has no `/proc` entry for `started`), and
		// `started` lets Bash's forked stage run `sleep` before the signal.
		(
			"last-stage-killed".to_owned(),
			format!(
				"{STARTED}echo x | sleep 30 & p=$!; sleep 0.1; started $p; kill -HUP $p; sleep 0.5; \
				 /bin/true; echo after"
			),
		),
		(
			"job-killed".to_owned(),
			"sleep 30 | /bin/cat & p=$!; sleep 0.1; kill -KILL %1; wait %1; echo st=$?".to_owned(),
		),
		(
			"other-stage-runs-on".to_owned(),
			format!(
				"{STARTED}sleep 0.3 | sleep 30 & p=$!; started $p; kill -HUP $p; wait %1; echo st=$?"
			),
		),
		(
			"jobs-l".to_owned(),
			"sleep 30 | sleep 30 & sleep 0.1; jobs -l; kill -KILL %1; wait %1; echo st=$?".to_owned(),
		),
		// The job runs a moment before it fails, so it is alive when the shell
		// makes it, and the shell polls `jobs -l` until it has ended, waiting
		// between polls with a read that times out on a process substitution,
		// which is no job: in Bash a job whose processes all ended before the
		// job was made, or a foreground child started after they ended, takes
		// the `+` from it. The last listing is printed.
		(
			"exit-status".to_owned(),
			"t=$(mktemp); (sleep 0.1; false) & while jobs -l > \"$t\"; IFS= read -r l < \"$t\"; [[ \
			 $l == *Running* ]]; do read -t 0.05 -u 9 9< <(sleep 1); done; while IFS= read -r l; do \
			 echo \"$l\"; done < \"$t\"; rm -f \"$t\""
				.to_owned(),
		),
		(
			"pipeline-exit-status".to_owned(),
			"t=$(mktemp); sleep 0.1 | false & while jobs -l > \"$t\"; IFS= read -r l < \"$t\"; [[ $l \
			 == *Running* ]]; do read -t 0.05 -u 9 9< <(sleep 1); done; while IFS= read -r l; do \
			 echo \"$l\"; done < \"$t\"; rm -f \"$t\""
				.to_owned(),
		),
	])
	.await;
}

/// A subshell Bash runs its last command in place of (`CMD_NO_FORK`) is
/// that command's process: a signal that ends the command is reported once,
/// with the subshell's text, at the end of the wait for the subshell. A
/// command Bash forks inside the subshell is reported by the subshell.
#[tokio::test(flavor = "multi_thread")]
async fn a_signal_killed_subshell_reports_its_own_text() {
	assert_all_bash(rows(&[
		("only-command", "( /bin/sh -c 'kill -KILL $$' ); echo st=$?"),
		("last-of-list", "( echo a; /bin/sh -c 'kill -KILL $$' ); echo st=$?"),
		("last-of-and", "( true && /bin/sh -c 'kill -KILL $$' ); echo st=$?"),
		("not-last", "( /bin/sh -c 'kill -KILL $$'; echo after ); echo st=$?"),
		("nested", "( ( /bin/sh -c 'kill -KILL $$' ) ); echo st=$?"),
		("trapped-inside", "( trap : USR1; /bin/sh -c 'kill -KILL $$' ); echo st=$?"),
		("redirected-last", "( echo a; /bin/sh -c 'kill -KILL $$' 2>/dev/null ); echo st=$?"),
		("term", "( echo a; /bin/sh -c 'kill -TERM $$' ); echo st=$?"),
	]))
	.await;
}

/// A here-document whose body Bash expands with text it reads (a `$(...)`,
/// or one in a `${...}` operand) reports the jobs that ended there, as each
/// line Bash reads does. The document feeds a builtin: for an external
/// command Bash expands it in the child it forks, whose copy of the job
/// table reports once more, which this shell does not (see the PR's
/// "Found and not fixed").
#[tokio::test(flavor = "multi_thread")]
async fn a_here_document_that_reads_text_reports_as_bash_does() {
	let killed =
		format!("{STARTED}{DEAD}/bin/sleep 30 & p=$!; started $p; kill -s HUP $p; dead $p; x=ab");
	let rows = [
		("substitution", "$(echo b)"),
		("pattern-operand", "${x%$(echo b)}"),
		("offset-operand", "${x:$(echo 1)}"),
		("no-text", "${x%b}"),
	]
	.map(|(name, body)| {
		(name.to_owned(), format!("{killed}; read -r y <<EOF\n{body}\nEOF\necho \"after=$y\""))
	});
	assert_all_bash(rows.into()).await;
}

/// `kill -0` on a background process a signal killed fails once the process
/// has ended, as Bash's `SIGCHLD` handler has collected it, also in a loop
/// that reaches no point that reports jobs; the job is reported at the next
/// such point (here `rm`, after the loop). The shell collected a child only
/// at such a point, so the loop ran out its 500 rounds. The loop waits on a
/// FIFO, not a `<(...)`, which would be a point that reports jobs: how many
/// rounds it runs depends on how fast the process dies.
#[tokio::test(flavor = "multi_thread")]
async fn kill_zero_sees_a_killed_process_gone() {
	assert_all_bash(vec![(
		"builtin-loop".to_owned(),
		format!(
			"{STARTED}/bin/sleep 30 & p=$!; started $p; d=$(mktemp -d); mkfifo $d/f; exec 9<>$d/f; \
			 kill -s HUP $p; n=0; while kill -0 $p 2>/dev/null && ((n++ < 500)); do read -t 0.01 -u \
			 9; done; echo \"ended=$((n < 500))\"; exec 9>&-; rm -rf $d; echo next"
		),
	)])
	.await;
}

/// A foreground pipeline one of whose processes a signal stopped is a
/// stopped job: a shell reading a script reports nothing for it, and its
/// status is 128 plus its first stage's (here `set -m`: without job control
/// Bash does not see the stop and waits on).
#[tokio::test(flavor = "multi_thread")]
async fn a_stopped_foreground_pipeline_is_not_reported() {
	const TAIL: &str = "echo st=$?; kill -CONT %1; wait %1; echo final=$?";
	assert_all_bash(vec![
		(
			"stop-last".to_owned(),
			format!("set -m; /bin/true | /bin/sh -c 'sleep .05; kill -STOP $$; exit 7'; {TAIL}"),
		),
		("stop-only".to_owned(), format!("set -m; /bin/sh -c 'kill -STOP $$; exit 7'; {TAIL}")),
	])
	.await;
}
