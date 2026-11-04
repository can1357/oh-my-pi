//! The output minimizer runs a `a; b; c` chain one segment per engine run,
//! each segment with streams of its own, so a segment that changes the
//! shell's standard descriptors (`exec >file`) would lose that change before
//! the next segment. A chain whose commands may do that, seen in its own text
//! or in the live shell's functions, aliases and traps, runs whole, as Bash
//! runs it.
//!
//! Each row is a setup call, then a chain call, on one persistent
//! `pi_shell::Shell` (the shell the bash tool keeps for a session), with the
//! minimizer on and off. Each call runs with `bash -c` semantics; the two
//! calls on one shell are modelled as one `bash -c` string holding both, one
//! per line (the state the first leaves carries into the second; every
//! descriptor change a row checks happens in the chain call). The expected
//! status, output and files are Bash 5.3.20's (Bash 5.2.21 agrees on every
//! row).
//!
//! `PI_SHELL_BASH_ORACLE=/path/to/bash` runs every row under that Bash
//! instead and compares it with the same expected result.
#![cfg(target_os = "linux")]

use std::path::Path;

use pi_shell::{
	Shell, ShellOptions, ShellRunOptions, cancel::CancelToken, minimizer::MinimizerOptions,
};

/// What a row leaves: the last call's status, every call's output (stdout and
/// stderr merged), and the named files with their contents (`-`: missing).
type Outcome = (Option<i32>, String, Vec<(String, String)>);

struct Row {
	name:     &'static str,
	/// The call before the chain, on the same shell.
	setup:    &'static str,
	/// The chain the minimizer may run a segment at a time.
	chain:    &'static str,
	/// Files the row's commands may write.
	files:    &'static [&'static str],
	/// Bash 5.3.20's output and file contents; every row's status is 0.
	output:   &'static str,
	contents: &'static [&'static str],
}

const HIDDEN: &[&str] = &["hidden"];
const BOTH_HIDDEN: &[&str] = &["HIDDEN\nEND\n"];

const ROWS: &[Row] = &[
	Row {
		name:     "function-stdout",
		setup:    "quiet() { exec >hidden; }",
		chain:    "quiet; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "function-stderr-file",
		setup:    "quiet() { exec 2>hidden; }",
		chain:    "quiet; echo ERR >&2; echo OUT",
		files:    HIDDEN,
		output:   "OUT\n",
		contents: &["ERR\n"],
	},
	Row {
		name:     "function-stderr-null",
		setup:    "quiet() { exec 2>/dev/null; }",
		chain:    "quiet; echo ERR >&2; echo OUT",
		files:    &[],
		output:   "OUT\n",
		contents: &[],
	},
	Row {
		name:     "function-dup",
		setup:    "dup() { exec 3>&1; }",
		chain:    "dup; echo X >&3; echo END",
		files:    &[],
		output:   "X\nEND\n",
		contents: &[],
	},
	Row {
		name:     "nested-function",
		setup:    "inner() { exec >hidden; }; outer() { inner; }",
		chain:    "outer; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "alias",
		setup:    "shopt -s expand_aliases; alias e=exec",
		chain:    "e >hidden; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "function-eval",
		setup:    "quiet() { eval 'exec >hidden'; }",
		chain:    "quiet; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "eval",
		setup:    ":",
		chain:    "eval 'exec >hidden'; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "source",
		setup:    "printf 'exec >hidden\\n' > q.sh",
		chain:    ". ./q.sh; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "function-source",
		setup:    "printf 'exec >hidden\\n' > q.sh; quiet() { . ./q.sh; }",
		chain:    "quiet; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "err-trap",
		setup:    "trap 'exec >hidden' ERR",
		chain:    "false; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "command-function",
		setup:    "command() { exec >hidden; }",
		chain:    "command; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "utility-function",
		setup:    "echo() { exec >hidden; builtin echo \"$@\"; }",
		chain:    "echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		// Each call's `exec >hidden` truncates the file again.
		contents: &["END\n"],
	},
	Row {
		name:     "same-call",
		setup:    ":",
		chain:    "quiet() { exec >hidden; }; quiet; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "plain-exec",
		setup:    ":",
		chain:    "exec >hidden; echo HIDDEN; echo END",
		files:    HIDDEN,
		output:   "",
		contents: BOTH_HIDDEN,
	},
	Row {
		name:     "harmless-function",
		setup:    "say() { builtin echo \"$@\"; }",
		chain:    "say A; echo B; echo C",
		files:    &[],
		output:   "A\nB\nC\n",
		contents: &[],
	},
	Row {
		name:     "brace-expanded-exec",
		setup:    ":",
		chain:    "e{x..x}ec 2>/dev/null; echo ERR >&2; echo OUT",
		files:    &[],
		output:   "OUT\n",
		contents: &[],
	},
	Row {
		name:     "single-quoted-exec",
		setup:    ":",
		chain:    "'exec' 2>/dev/null; echo E >&2; echo O",
		files:    &[],
		output:   "O\n",
		contents: &[],
	},
	Row {
		name:     "double-quoted-exec",
		setup:    ":",
		chain:    "\"exec\" 2>/dev/null; echo E >&2; echo O",
		files:    &[],
		output:   "O\n",
		contents: &[],
	},
	Row {
		name:     "escaped-exec",
		setup:    ":",
		chain:    "\\exec 2>/dev/null; echo E >&2; echo O",
		files:    &[],
		output:   "O\n",
		contents: &[],
	},
	Row {
		name:     "partly-quoted-exec",
		setup:    ":",
		chain:    "e'x'ec 2>/dev/null; echo E >&2; echo O",
		files:    &[],
		output:   "O\n",
		contents: &[],
	},
	Row {
		name:     "command-quoted-exec",
		setup:    ":",
		chain:    "command 'exec' 2>/dev/null; echo E >&2; echo O",
		files:    &[],
		output:   "O\n",
		contents: &[],
	},
];

impl Row {
	fn expected(&self) -> Outcome {
		let files = self
			.files
			.iter()
			.zip(self.contents)
			.map(|(name, text)| ((*name).to_owned(), (*text).to_owned()))
			.collect();
		(Some(0), self.output.to_owned(), files)
	}
}

/// The Bash `PI_SHELL_BASH_ORACLE` names, when set.
fn oracle() -> Option<String> {
	std::env::var("PI_SHELL_BASH_ORACLE")
		.ok()
		.filter(|path| !path.is_empty())
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

/// `calls` run one after another on one shell in `dir`, the output minimizer
/// on or off: the last call's status and every call's output.
async fn run_calls(minimize: bool, dir: &Path, calls: &[&str]) -> (Option<i32>, String) {
	let options = minimize.then(|| ShellOptions {
		minimizer: Some(MinimizerOptions { enabled: Some(true), ..Default::default() }),
		..Default::default()
	});
	let shell = Shell::new(options);
	let cd = format!("cd '{}'", dir.display());
	let mut status = None;
	let mut output = String::new();
	for call in std::iter::once(cd.as_str()).chain(calls.iter().copied()) {
		let (call_status, call_output) = run_in(&shell, call).await;
		status = call_status;
		output.push_str(&call_output);
	}
	(status, output)
}

/// `bash -c` running `calls`, each on a line of its own, in `dir`; its
/// stderr merged into its stdout.
async fn run_bash(bash: &str, dir: &Path, calls: &[&str]) -> (Option<i32>, String) {
	let script = format!("cd '{}'\n{}\n", dir.display(), calls.join("\n"));
	let bash = bash.to_owned();
	tokio::task::spawn_blocking(move || {
		let output = std::process::Command::new("sh")
			.args(["-c", r#"exec "$0" --noprofile --norc -c "$1" 2>&1"#, &bash, &script])
			.stdin(std::process::Stdio::null())
			.output()
			.expect("bash");
		(output.status.code(), String::from_utf8_lossy(&output.stdout).into_owned())
	})
	.await
	.expect("join")
}

/// The files `names` in `dir`, with their contents (`-` for a missing one).
fn files(dir: &Path, names: &[&str]) -> Vec<(String, String)> {
	names
		.iter()
		.map(|name| {
			let text = std::fs::read_to_string(dir.join(name)).unwrap_or_else(|_| "-".to_owned());
			((*name).to_owned(), text)
		})
		.collect()
}

/// A chain whose commands may change the shell's standard descriptors (an
/// `exec` reached through a function, a nested function, an alias, `eval` or
/// `.` in a function, an ERR trap, a function named `command` or `echo`, an
/// `exec` spelled with quotes, a backslash or brace expansion) leaves the
/// redirection in force for the commands after it, as in Bash, with the
/// minimizer on as with it off; a harmless function still gives Bash's
/// output. A regression shows as output that should have gone to a file (or
/// to `/dev/null`) coming back to the caller.
#[tokio::test(flavor = "multi_thread")]
async fn a_chain_that_may_change_the_shells_descriptors_runs_whole() {
	let bash = oracle();
	let modes: &[Option<bool>] = if bash.is_some() {
		&[None]
	} else {
		&[Some(true), Some(false)]
	};
	let mut mismatches = Vec::new();
	let mut runs = 0;
	for row in ROWS {
		let expected = row.expected();
		for &mode in modes {
			runs += 1;
			let dir = tempfile::tempdir().expect("dir");
			let calls = [row.setup, row.chain];
			let (status, output) = match (&bash, mode) {
				(Some(bash), _) => run_bash(bash, dir.path(), &calls).await,
				(None, Some(minimize)) => run_calls(minimize, dir.path(), &calls).await,
				(None, None) => unreachable!("engine runs choose the minimizer"),
			};
			let got = (status, output, files(dir.path(), row.files));
			if got != expected {
				let label = match mode {
					Some(true) => "minimizer on",
					Some(false) => "minimizer off",
					None => "oracle",
				};
				mismatches.push(format!(
					"{} ({label}): `{}` then `{}`\n  want: {expected:?}\n  got:  {got:?}",
					row.name, row.setup, row.chain
				));
			}
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {runs} rows differ from Bash 5.3.20:\n{}",
		mismatches.len(),
		mismatches.join("\n")
	);
}
