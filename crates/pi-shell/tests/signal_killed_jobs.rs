//! A job or foreground command a signal ended is reported the way Bash
//! 5.2.21 reports it when it reads a script: at Bash's notify points (each
//! input line, the end of a foreground command Bash forks, `wait`, `wait -n`,
//! and the end of the script) the shell prints the job's processes, as
//! `jobs -l` lists them, to standard error, and then forgets the job. SIGINT,
//! SIGTERM, SIGPIPE and a signal the shell traps are reported by no line, a
//! foreground SIGTERM or trapped signal by the signal's name alone. `jobs`
//! lists a job with Bash's status text.
//!
//! Every expected output is what Bash prints for the same script read on its
//! standard input, with two differences folded away: the `bash: line N: `
//! prefix Bash puts before each of its own diagnostics, which this shell
//! never prints, and the `(core dumped) ` text, which depends on the system's
//! core dump setup. Pids read `PID`. Setting `PI_SHELL_BASH_ORACLE=1` runs
//! the scripts under `bash` instead, to check the expected outputs.
#![cfg(target_os = "linux")]

use std::sync::{Arc, LazyLock};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Waits, without starting a child, until the process `$1` names is gone or
/// a zombie (at most 30 s: a core dump can take seconds), so a signal has
/// landed before the next step; and
/// until a background `sleep` or `perl` runs its program, as a signal that
/// reaches the forked shell first runs that shell's trap there instead.
const PRELUDE: &str = r#"dead() { local s t=$((SECONDS+30)); while ((SECONDS < t)); do read -r s 2>/dev/null < /proc/$1/stat || return 0; [[ $s == *") Z "* ]] && return 0; done; return 1; }; started() { local c; while read -r c 2>/dev/null < /proc/$1/comm; do [[ $c == sleep || $c == perl ]] && return 0; done; }"#;

fn oracle() -> bool {
	std::env::var_os("PI_SHELL_BASH_ORACLE").is_some()
}

/// Runs `script` in a fresh shell, or under Bash for the oracle, and returns
/// its exit status and its stdout and stderr in one stream.
async fn run(script: String) -> (Option<i32>, String) {
	if oracle() {
		return tokio::task::spawn_blocking(move || {
			use std::io::Write;
			let mut child = std::process::Command::new("setsid")
				.args(["sh", "-c", "exec bash --noprofile --norc 2>&1"])
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
		.expect("join");
	}
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command: script, ..Default::default() },
			Some(tx),
			CancelToken::new(Some(60_000)),
		)
		.await
		.expect("run");
	(result.exit_code, rx.drain().collect())
}

static PID: LazyLock<regex::Regex> =
	LazyLock::new(|| regex::Regex::new(r"( *)\b(\d{4,})\b").expect("pid pattern"));
static PREFIX: LazyLock<regex::Regex> =
	LazyLock::new(|| regex::Regex::new(r"(?m)^bash: line \d+: ").expect("prefix pattern"));

/// Folds the differences the module comment names: `bash: line N: `, the
/// `(core dumped) ` text, and each pid, with the padding `%5ld` gave it.
fn normalize(output: &str) -> String {
	let output = PREFIX.replace_all(output, "");
	let output = output.replace("(core dumped) ", "");
	PID.replace_all(&output, |caps: &regex::Captures<'_>| {
		let spaces = caps[1].len();
		let digits = caps[2].len();
		let pad = 5_usize.saturating_sub(digits).min(spaces);
		format!("{}PID", " ".repeat(spaces - pad))
	})
	.into_owned()
}

/// Runs each `(name, script, expected)` row, eight at a time, and asserts
/// the normalized output and exit status 0, naming every row that differs.
async fn assert_rows(rows: Vec<(String, String, String)>) {
	let limit = Arc::new(tokio::sync::Semaphore::new(8));
	let mut runs = tokio::task::JoinSet::new();
	for (index, (_, script, _)) in rows.iter().enumerate() {
		let (script, limit) = (script.clone(), Arc::clone(&limit));
		runs.spawn(async move {
			let _permit = limit.acquire_owned().await.expect("run limit");
			(index, run(script).await)
		});
	}
	let mut results = runs.join_all().await;
	results.sort_unstable_by_key(|&(index, _)| index);
	let mismatches: Vec<String> = results
		.into_iter()
		.filter_map(|(index, (status, output))| {
			let (name, script, expected) = &rows[index];
			let output = normalize(&output);
			((status, output.as_str()) != (Some(0), expected.as_str())).then(|| {
				format!(
					"{name}: `{script}`\n  want: Some(0) {expected:?}\n  got:  {status:?} {output:?}"
				)
			})
		})
		.collect();
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// The signals the matrix covers, with their numbers and the text Bash's
/// `strsignal` gives them.
const SIGNALS: [(&str, u8, &str); 10] = [
	("HUP", 1, "Hangup"),
	("INT", 2, "Interrupt"),
	("QUIT", 3, "Quit"),
	("ABRT", 6, "Aborted"),
	("KILL", 9, "Killed"),
	("SEGV", 11, "Segmentation fault"),
	("PIPE", 13, "Broken pipe"),
	("TERM", 15, "Terminated"),
	("USR1", 10, "User defined signal 1"),
	("ALRM", 14, "Alarm clock"),
];

/// Whether Bash prints a line for a job `signal` ended: not for SIGINT,
/// SIGTERM or SIGPIPE.
fn reported(signal: &str) -> bool {
	!matches!(signal, "INT" | "TERM" | "PIPE")
}

/// A status padded as Bash's `print_pipeline` pads it.
fn padded(status: &str) -> String {
	format!("{status:<24}")
}

/// The scenarios of the matrix: where the job ends, and what follows.
const SCENARIOS: [&str; 10] = [
	"fg",
	"line",
	"wait",
	"waitsame",
	"waitn",
	"waitnsame",
	"jobs",
	"jobssame",
	"trapped",
	"disowned",
];

/// One scenario's script and Bash's output for it. `start` starts the job
/// and leaves it ended by `signal`; `job` is the job's command text.
fn scenario(
	name: &str,
	signal: &str,
	start: &str,
	job: &str,
	status: u8,
	desc: &str,
) -> (String, String) {
	let line = format!("PID {}{job}\n", padded(desc));
	let report = if reported(signal) { line.as_str() } else { "" };
	let st = 128 + u32::from(status);
	let (lines, expected): (Vec<String>, String) = match name {
		"fg" => (
			vec![format!("{start}; /bin/true; echo fg-done"), "echo next".into()],
			format!("{report}fg-done\nnext\n"),
		),
		"line" => (
			vec![format!("{start}; echo same-line"), "echo next-line".into()],
			format!("same-line\n{report}next-line\n"),
		),
		"wait" => (
			vec![start.into(), r#"wait %1; echo "wait=$?"; wait $p; echo "waitpid=$?""#.into()],
			format!("{report}wait: %1: no such job\nwait=127\nwaitpid={st}\n"),
		),
		"waitsame" => (
			vec![
				format!(r#"{start}; wait %1; echo "wait=$?""#),
				r#"echo next; wait $p; echo "waitpid=$?""#.into(),
			],
			format!("{report}wait={st}\nnext\nwaitpid={st}\n"),
		),
		"waitn" => {
			(vec![start.into(), r#"wait -n; echo "waitn=$?""#.into()], format!("{report}waitn=127\n"))
		},
		"waitnsame" => (
			vec![
				format!(r#"{start}; wait -n; echo "waitn=$?""#),
				r#"echo next; wait $p; echo "waitpid=$?""#.into(),
			],
			format!("{report}waitn={st}\nnext\nwaitpid={st}\n"),
		),
		"jobs" => (vec![start.into(), r#"jobs; echo "jobs=$?""#.into()], format!("{report}jobs=0\n")),
		"jobssame" => (
			vec![
				format!(r#"{start}; jobs; echo "jobs=$?""#),
				r#"echo next; wait %1; echo "wait=$?""#.into(),
			],
			format!("[1]+  {}{job}\njobs=0\nnext\nwait: %1: no such job\nwait=127\n", padded(desc)),
		),
		"trapped" => (
			vec![
				format!("trap 'echo trapped' {signal}; echo trap=$?"),
				format!("{start}; echo same-line"),
				r#"wait %1; echo "wait=$?""#.into(),
			],
			"trap=0\nsame-line\nwait: %1: no such job\nwait=127\n".into(),
		),
		"disowned" => (
			vec![
				format!("{}; echo same-line", start.replacen(" & p=$!;", " & p=$!; disown;", 1)),
				r#"echo next; wait $p; echo "waitpid=$?"; jobs; echo "jobs=$?""#.into(),
			],
			"same-line\nnext\nwaitpid=0\njobs=0\n".into(),
		),
		_ => unreachable!("scenario {name}"),
	};
	let mut script = String::from(PRELUDE);
	for line in lines {
		script.push('\n');
		script.push_str(&line);
	}
	(script, expected)
}

/// The rows for one kind of job: `job(signal)` gives the command text and
/// the line that starts the job and leaves it ended by the signal.
fn matrix(kind: &str, job: impl Fn(&str) -> (String, String)) -> Vec<(String, String, String)> {
	let mut rows = Vec::new();
	for (signal, number, desc) in SIGNALS {
		let (command, start) = job(signal);
		for name in SCENARIOS {
			let (script, expected) = scenario(name, signal, &start, &command, number, desc);
			rows.push((format!("{kind}-{signal}-{name}"), script, expected));
		}
	}
	rows
}

/// A background external process a signal ends. A shell without job
/// control starts a background job with SIGINT and SIGQUIT ignored, so for
/// those two the job restores the default action and signals itself.
fn external_job(signal: &str) -> (String, String) {
	if matches!(signal, "INT" | "QUIT") {
		let command =
			format!(r#"perl -e '$SIG{{{signal}}}="DEFAULT"; kill "{signal}", $$; sleep 5'"#);
		let start = format!("{command} & p=$!; dead $p");
		return (command, start);
	}
	let command = String::from("/bin/sleep 30");
	let start = format!("{command} & p=$!; started $p; kill -s {signal} $p; dead $p");
	(command, start)
}
/// Each non-core-dumping signal ends a background external process: the
/// report, when Bash prints one, comes at the next notify point, and the job
/// is gone after. QUIT, ABRT and SEGV have environment-dependent core-dump
/// latency; the in-process matrix and printer unit test cover their text,
/// while the sequential VM Bash matrix records their external behavior.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_process_a_non_core_signal_ends_is_reported_as_bash_does() {
	let rows = matrix("external", external_job)
		.into_iter()
		.filter(|(name, ..)| {
			!(name.contains("-QUIT-") || name.contains("-ABRT-") || name.contains("-SEGV-"))
		})
		.collect();
	assert_rows(rows).await;
}

/// The same for a background job the shell runs itself (`sleep` is a
/// builtin here, an external command in Bash): `kill` ends it with the
/// signal, as a signal ends a process. In Bash a background job ignores
/// SIGINT and SIGQUIT, so for those two the expected outputs are the ones
/// Bash gives the job that signals itself (see [`external_job`]), with this
/// job's command; the oracle skips those rows.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_job_kill_ends_in_the_shell_is_reported_as_bash_does() {
	let rows: Vec<_> = matrix("in-process", |signal| {
		let command = String::from("sleep 30");
		let start = format!("{command} & p=$!; started $p; kill -s {signal} $p; dead $p");
		(command, start)
	})
	.into_iter()
	.filter(|(name, ..)| !(oracle() && (name.contains("-INT-") || name.contains("-QUIT-"))))
	.collect();
	assert_rows(rows).await;
}

fn rows(cases: &[(&str, &str, &str)]) -> Vec<(String, String, String)> {
	cases
		.iter()
		.map(|&(name, script, expected)| {
			(name.to_owned(), format!("{PRELUDE}\n{script}"), expected.to_owned())
		})
		.collect()
}

/// A foreground command a signal ends is reported at the end of its wait:
/// by its processes' lines, by the signal's name alone for SIGTERM or a
/// trapped signal, by nothing for SIGINT and SIGPIPE. A pipeline is reported
/// by one line per process when its last process (the one its status comes
/// from) was ended by a signal, and a command substitution never.
#[tokio::test(flavor = "multi_thread")]
async fn a_foreground_command_a_signal_ends_is_reported_as_bash_does() {
	assert_rows(rows(&[
		(
			"kill",
			"/bin/sh -c 'kill -KILL $$'; echo st=$?",
			"PID Killed                  /bin/sh -c 'kill -KILL $$'\nst=137\n",
		),
		(
			"hup",
			"/bin/sh -c 'kill -HUP $$'; echo st=$?",
			"PID Hangup                  /bin/sh -c 'kill -HUP $$'\nst=129\n",
		),
		(
			"usr1",
			"/bin/sh -c 'kill -USR1 $$'; echo st=$?",
			"PID User defined signal 1   /bin/sh -c 'kill -USR1 $$'\nst=138\n",
		),
		(
			"segv",
			"/bin/sh -c 'kill -SEGV $$'; echo st=$?",
			"PID Segmentation fault      /bin/sh -c 'kill -SEGV $$'\nst=139\n",
		),
		("term", "/bin/sh -c 'kill -TERM $$'; echo st=$?", "Terminated\nst=143\n"),
		("int", "/bin/sh -c 'kill -INT $$'; echo st=$?", "st=130\n"),
		("pipe", "/bin/sh -c 'kill -PIPE $$'; echo st=$?", "st=141\n"),
		(
			"trapped",
			"trap : USR1; /bin/sh -c 'kill -USR1 $$'; echo st=$?",
			"User defined signal 1\nst=138\n",
		),
		(
			"pipeline-last",
			"/bin/true | /bin/sh -c 'kill -KILL $$'; echo st=$?",
			"PID Done                    /bin/true\n     PID Killed                  | /bin/sh -c \
			 'kill -KILL $$'\nst=137\n",
		),
		("pipeline-first", "/bin/sh -c 'kill -KILL $$' | /bin/true; echo st=$?", "st=0\n"),
		("comsub", "x=$(/bin/sh -c 'kill -KILL $$'); echo st=$?", "st=137\n"),
		(
			"background-wait",
			"/bin/sh -c 'kill -KILL $$' & wait $!; echo st=$?",
			"PID Killed                  /bin/sh -c 'kill -KILL $$'\nst=137\n",
		),
		(
			"command",
			"command /bin/sh -c 'kill -KILL $$'; echo st=$?",
			"PID Killed                  command /bin/sh -c 'kill -KILL $$'\nst=137\n",
		),
	]))
	.await;
}

/// The notify points beyond the ones the matrix covers: the end of the
/// script, also right after the job's own line; a `$(...)` text read; a
/// subshell; not a builtin; inside a command substitution, nothing is ever
/// printed. `wait %1` reports the job it waited for and forgets it. A job
/// started in another directory than the shell is in when it is reported
/// names that directory.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_job_is_reported_at_each_bash_notify_point() {
	const KILL_LINE: &str = "/bin/sleep 30 & p=$!; started $p; kill -s HUP $p; dead $p";
	let report = "PID Hangup                  /bin/sleep 30\n";
	let cases: Vec<(String, String, String)> = [
		("end", format!("{KILL_LINE}"), format!("{report}")),
		("end-newline", format!("{KILL_LINE}\n"), format!("{report}")),
		("builtin", format!("{KILL_LINE}; :; echo after"), format!("after\n{report}")),
		("comsub", format!("{KILL_LINE}; x=$(:); echo after"), format!("{report}after\n")),
		("subshell", format!("{KILL_LINE}; (:); echo after"), format!("{report}after\n")),
		("stand-in", format!("{KILL_LINE}; sleep 0; echo after"), format!("{report}after\n")),
		(
			"wait-twice",
			format!("{KILL_LINE}; wait %1; echo a=$?; wait %1; echo b=$?"),
			format!("{report}a=129\nwait: %1: no such job\nb=127\n"),
		),
		(
			"exec-stderr",
			format!("{KILL_LINE}; exec 2>/dev/null; /bin/true; echo after"),
			"after\n".into(),
		),
		(
			"wait-stderr",
			format!("{KILL_LINE}; wait %1 2>/dev/null; echo w=$?"),
			"w=129\n".into(),
		),
		(
			"wd",
			"cd /tmp; /bin/sleep 30 & p=$!; cd /; started $p; kill -s HUP $p; dead $p; /bin/true; \
			 echo after"
				.into(),
			"PID Hangup                  /bin/sleep 30  (wd: /tmp)\nafter\n".into(),
		),
		(
			"in-comsub",
			"x=$(sleep 30 & kill -9 $!; sleep 0; echo inner); echo \"[$x]\"".into(),
			"[inner]\n".into(),
		),
		("wait-all-ended", format!("{KILL_LINE}; wait; echo w=$?"), format!("w=0\n{report}")),
	]
	.into_iter()
	.map(|(name, script, expected)| (name.to_owned(), format!("{PRELUDE}\n{script}"), expected))
	.collect();
	assert_rows(cases).await;
}

/// `jobs` and `jobs -l` list with Bash's `print_pipeline`: the status
/// padded to 24 columns, the pid in `-l`, ` &` after a running job.
#[tokio::test(flavor = "multi_thread")]
async fn jobs_lists_with_bash_status_text() {
	assert_rows(rows(&[
		(
			"jobs-l",
			"/bin/sleep 30 & p=$!; jobs -l; kill -9 $p; dead $p; jobs -l; echo j=$?",
			"[1]+ PID Running                 /bin/sleep 30 &\n[1]+ PID Killed                  /bin/sleep 30\nj=0\n",
		),
		(
			"jobs-exit",
			"/bin/sh -c 'exit 3' & p=$!; dead $p; jobs; echo j=$?",
			"[1]+  Exit 3                  /bin/sh -c 'exit 3'\nj=0\n",
		),
		(
			"jobs-done",
			"/bin/true & p=$!; dead $p; jobs; echo j=$?",
			"[1]+  Done                    /bin/true\nj=0\n",
		),
		(
			"jobs-pipeline",
			"/bin/sleep 30 | /bin/cat & p=$!; jobs; jobs -l; kill %1; wait",
			"[1]+  Running                 /bin/sleep 30 | /bin/cat &\n[1]+ PID Running                 /bin/sleep 30\n     PID                       | /bin/cat &\n",
		),
	]))
	.await;
}
