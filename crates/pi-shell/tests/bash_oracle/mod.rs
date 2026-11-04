//! Rows compared with Bash through `pi_shell::Shell::run`.
//!
//! The oracle rule: `Shell::run` runs each tool call's string as `bash -c`
//! runs its argument (the engine's `Origin::Command`; a fatal expansion
//! error exits 127 there, where a script on standard input exits 1). So
//! every row's expected output is what `BASH --noprofile --norc -c SCRIPT
//! 2>&1` prints, with Bash 5.3.20 as the target where 5.2.21 and 5.3.20
//! differ. The mode is the same for every row.
//!
//! A fixture row holds the script and Bash 5.3.20's exit status (128 + N
//! for a shell a signal ended) and output, standard output and error in
//! one stream. Both sides are normalized the same way: job-line pids read
//! `PID`, and Bash's `NAME: line N: ` diagnostic prefix is dropped, or, for
//! a row whose `prefix` is `line`, kept with its line and the name read as
//! `bash` (`name`: the line reads `N` too, for a row of several tool calls,
//! whose lines Bash counts through the calls joined into one string).
//!
//! `PI_SHELL_BASH_ORACLE=/path/to/bash` runs every row under that Bash
//! instead and compares it with the same expected output: Bash 5.3.20
//! passes every row, Bash 5.2.21 fails only the rows where it differs from
//! 5.3.20.

#![allow(dead_code, reason = "each test file uses part of the harness")]

use std::{path::PathBuf, sync::LazyLock};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use serde::Deserialize;

/// One script and what Bash 5.3.20 makes of it.
#[derive(Clone, Debug, Deserialize)]
pub struct Row {
	/// The contract the row belongs to (one test each).
	pub group:  String,
	pub name:   String,
	pub script: String,
	/// The tool calls the row makes on one shell, when several: Bash runs
	/// them as one string, one per line.
	#[serde(default)]
	pub calls:  Vec<String>,
	/// What of Bash's diagnostic prefix the row compares ([`normalize`]).
	#[serde(default)]
	pub prefix: Prefix,
	pub status: i32,
	pub output: String,
}

/// What of Bash's `NAME: line N: ` prefix a row compares.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Prefix {
	/// Nothing: the prefix is dropped.
	#[default]
	None,
	/// The line, with the name read as `bash`.
	Line,
	/// That there is one: `bash: line N: `.
	Name,
}

/// The rows of `fixture` (under `tests/fixtures/`) in `group`.
pub fn rows(fixture: &str, group: &str) -> Vec<Row> {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests/fixtures")
		.join(fixture);
	let text = std::fs::read_to_string(&path).expect("fixture");
	let all: Vec<Row> = serde_json::from_str(&text).expect("fixture rows");
	let rows: Vec<Row> = all.into_iter().filter(|r| r.group == group).collect();
	assert!(!rows.is_empty(), "no rows in group {group}");
	rows
}

/// The Bash `PI_SHELL_BASH_ORACLE` names, if any.
pub fn oracle() -> Option<PathBuf> {
	std::env::var_os("PI_SHELL_BASH_ORACLE").map(PathBuf::from)
}

/// Runs `script` as one `Shell::run` call of `shell`: its exit status and
/// its standard output and error in one stream.
pub async fn run_in(shell: &Shell, script: &str) -> (Option<i32>, String) {
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

/// Runs `script` in a fresh shell, or as `BASH -c` for the oracle.
pub async fn run(script: &str) -> (Option<i32>, String) {
	match oracle() {
		Some(bash) => run_bash(bash, script).await,
		None => run_in(&Shell::new(None), script).await,
	}
}

/// Runs the row's script (each of its calls in turn, on one shell), or the
/// calls joined as one `BASH -c` string for the oracle.
pub async fn run_row(row: &Row) -> (Option<i32>, String) {
	if row.calls.is_empty() {
		return run(&row.script).await;
	}
	if let Some(bash) = oracle() {
		return run_bash(bash, &row.calls.join("\n")).await;
	}
	let shell = Shell::new(None);
	let (mut status, mut output) = (None, String::new());
	for call in &row.calls {
		let (s, out) = run_in(&shell, call).await;
		status = s;
		output.push_str(&out);
	}
	(status, output)
}

async fn run_bash(bash: PathBuf, script: &str) -> (Option<i32>, String) {
	use std::os::unix::process::ExitStatusExt;
	let script = script.to_owned();
	tokio::task::spawn_blocking(move || {
		let output = std::process::Command::new("sh")
			.args(["-c", r#"exec "$0" --noprofile --norc -c "$1" 2>&1"#])
			.arg(&bash)
			.arg(&script)
			.stdin(std::process::Stdio::null())
			.output()
			.expect("bash");
		// A shell a signal ended reads as its status would to a parent shell.
		let status = output.status.code().or_else(|| output.status.signal().map(|n| 128 + n));
		(status, String::from_utf8_lossy(&output.stdout).into_owned())
	})
	.await
	.expect("join")
}

/// A pid where a job line prints one, with its `%5ld` padding: first on a
/// line, after a listing's `[N]+ ` or a kept diagnostic prefix, and
/// followed by a space.
static PID: LazyLock<regex::Regex> = LazyLock::new(|| {
	regex::Regex::new(r"(?m)^(\[\d+\][+ -] |bash: line (?:\d+|N): )?( *)(\d+) ").expect("pid")
});
/// Bash's diagnostic prefix: `bash: line N: `, its path when started by
/// path, a sourced file's name, or `environment: line N: ` in a function of
/// a `-c` string.
static PREFIX: LazyLock<regex::Regex> =
	LazyLock::new(|| regex::Regex::new(r"(?m)^\S+: line (\d+): ").expect("prefix"));

/// Normalizes the diagnostic prefix as `prefix` says, and writes every
/// job-line pid, of any length and with the padding `%5ld` gave it, as
/// `PID`.
pub fn normalize_as(output: &str, prefix: Prefix) -> String {
	let output = match prefix {
		Prefix::None => PREFIX.replace_all(output, ""),
		Prefix::Line => PREFIX.replace_all(output, "bash: line $1: "),
		Prefix::Name => PREFIX.replace_all(output, "bash: line N: "),
	};
	PID.replace_all(&output, |caps: &regex::Captures<'_>| {
		let listing = caps.get(1).map_or("", |prefix| prefix.as_str());
		let spaces = caps[2].len();
		let pad = 5_usize.saturating_sub(caps[3].len()).min(spaces);
		format!("{listing}{}PID ", " ".repeat(spaces - pad))
	})
	.into_owned()
}

/// [`normalize_as`] dropping the prefix.
pub fn normalize(output: &str) -> String {
	normalize_as(output, Prefix::None)
}

/// Runs every row, `parallel` at a time, each in a fresh shell (or under
/// the oracle Bash), and names every one whose status or normalized output
/// differs from the expected one.
pub async fn assert_rows(rows: Vec<Row>, parallel: usize) {
	let total = rows.len();
	let gate = std::sync::Arc::new(tokio::sync::Semaphore::new(parallel));
	let mut set = tokio::task::JoinSet::new();
	for (i, row) in rows.into_iter().enumerate() {
		let gate = gate.clone();
		set.spawn(async move {
			let _permit = gate.acquire_owned().await.expect("gate");
			let (status, output) = run_row(&row).await;
			let output = normalize_as(&output, row.prefix);
			(i, row, status, output)
		});
	}
	let mut mismatches = Vec::new();
	while let Some(done) = set.join_next().await {
		let (i, row, status, output) = done.expect("row task");
		if (status, output.as_str()) != (Some(row.status), row.output.as_str()) {
			mismatches.push((
				i,
				format!(
					"{}: `{}`\n  want: {:?} {:?}\n  got:  {status:?} {output:?}",
					row.name, row.script, row.status, row.output
				),
			));
		}
	}
	mismatches.sort_by_key(|(i, _)| *i);
	assert!(
		mismatches.is_empty(),
		"{} of {total} rows differ from Bash 5.3.20 (`bash -c`):\n{}",
		mismatches.len(),
		mismatches
			.into_iter()
			.map(|(_, m)| m)
			.collect::<Vec<_>>()
			.join("\n")
	);
}
