//! Regressions from the second review of #17845, each compared with Bash
//! 5.2.21 reading the same script on its standard input, in the same run.
//! Each script runs through `pi_shell::Shell::run`, the shell the bash tool's
//! executor runs; `PI_SHELL_BASH_ORACLE=1` sends it to Bash on both sides, to
//! check the comparison. Pids read `PID`, and Bash's `bash: line N: ` prefix
//! is folded.
#![cfg(target_os = "linux")]

use std::{collections::BTreeSet, sync::LazyLock};

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

fn rows(cases: &[(&str, &str)]) -> Vec<(String, String)> {
	cases
		.iter()
		.map(|&(name, script)| (name.to_owned(), script.to_owned()))
		.collect()
}

/// Every chain of `builtin` and `command` wrappers in front of `exec`: each
/// sequence of up to four plain wrappers, each sequence of up to two drawn
/// from every option spelling Bash's `command` stripping and `builtin`
/// accept, and the describing `command -v`/`-V` forms.
fn wrapper_chains() -> BTreeSet<String> {
	let mut chains = BTreeSet::new();
	let mut grow = |tokens: &[&str], depth: usize| {
		let mut level = vec![String::new()];
		for _ in 0..depth {
			let mut next = Vec::new();
			for chain in &level {
				for token in tokens {
					next.push(format!("{chain}{token} "));
				}
			}
			chains.extend(next.iter().cloned());
			level = next;
		}
		chains.insert(String::new());
	};
	grow(&["builtin", "command"], 4);
	grow(&["builtin", "builtin --", "command", "command -p", "command --", "command -p --"], 2);
	for describe in ["command -v", "command -V", "command -pv"] {
		for prefix in ["", "builtin ", "command "] {
			chains.insert(format!("{prefix}{describe} "));
		}
	}
	chains
}

/// `exec` reached through any chain of wrappers keeps its redirections only
/// when Bash's `command` stripping leaves `exec` itself (`command exec`,
/// `command -p -- exec`); through `builtin` it runs with its own option
/// checks and is refused when disabled, and its redirections end with the
/// command.
#[tokio::test(flavor = "multi_thread")]
async fn exec_through_wrappers_follows_bash() {
	let mut cases = Vec::new();
	for chain in wrapper_chains() {
		let shown = if chain.is_empty() {
			"bare"
		} else {
			chain.trim_end()
		};
		for (scenario, script) in [
			("persist", format!("{chain}exec 2>/dev/null; echo ERR >&2; echo OUT")),
			(
				"group",
				format!("{{ {chain}exec 2>/dev/null; echo IN >&2; }} 2>&1; echo ERR >&2; echo OUT"),
			),
			("missing-argument", format!("{{ {chain}exec -a; }} 2>/dev/null; echo status=$?")),
			(
				"invalid-option",
				format!("{{ {chain}exec -z 2>/dev/null; echo ERR >&2; }} 2>&1; echo OUT"),
			),
			(
				"disabled",
				format!("enable -n exec; {chain}exec 2>/dev/null; echo status=$?; echo ERR >&2"),
			),
		] {
			cases.push((format!("{shown}/{scenario}"), script));
		}
	}
	cases.extend(rows(&[
		("builtin-invalid-option", "builtin -x exec 2>/dev/null; echo status=$?"),
		(
			"builtin-eval-keeps",
			"d=$(mktemp -d); builtin eval \"exec 3>$d/f\"; echo X >&3; cat $d/f; rm -rf $d",
		),
		(
			"builtin-command-eval-keeps",
			"d=$(mktemp -d); builtin command eval \"exec 3>$d/f\"; echo X >&3; cat $d/f; rm -rf $d",
		),
	]));
	assert_all_bash(cases).await;
}

/// A stage of a background pipeline the shell runs itself has ended when its
/// command has ended, whatever stage before it still runs: `kill` of its pid
/// fails, `jobs -l` shows it as Bash shows an ended process of a running
/// job, and nothing reports a death for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_stage_ends_when_its_command_ends() {
	let mut cases = Vec::new();
	for last in ["false", "true", "/bin/false", "(exit 3)", "{ false; }"] {
		cases.push((
			format!("kill-ended-last/{last}"),
			format!(
				"sleep 0.8 | {last} & p=$!; sleep .3; kill -HUP $p 2>/dev/null; echo kill=$?; wait \
				 $p; echo status=$?"
			),
		));
		cases.push((
			format!("jobs-l/{last}"),
			format!("sleep 0.8 | {last} & sleep .3; jobs -l; wait; echo w=$?"),
		));
	}
	// `jobs -p` names the first process; a file carries it, since a command
	// substitution's `jobs` is not the point here.
	for first in ["false", "/bin/false", "true"] {
		cases.push((
			format!("kill-ended-first/{first}"),
			format!(
				"{first} | sleep 0.8 & sleep .3; d=$(mktemp -d); jobs -p > $d/p; read p < $d/p; rm \
				 -rf $d; kill -HUP $p 2>/dev/null; echo kill=$?; wait; echo w=$?"
			),
		));
	}
	assert_all_bash(cases).await;
}

/// With `lastpipe` Bash keeps the pipeline, whose last process is the shell
/// itself, and each child the last command forks as jobs in its table while
/// the list is frozen: `jobs` lists them, `wait %N` waits for them, and the
/// next notify point reports them in table order.
#[tokio::test(flavor = "multi_thread")]
async fn lastpipe_jobs_live_in_the_job_table() {
	const KILLED: &str = "/bin/sh -c 'kill -KILL $$'";
	let mut cases = Vec::new();
	for (name, tail) in [
		("jobs-l", "jobs -l; echo after"),
		("jobs", "jobs; echo after; jobs; echo end"),
		("wait-2", "wait %2; echo status=$?"),
		("wait-1", "wait %1; echo status=$?"),
		("next-line", "echo after\necho next"),
		("same-line", "echo after"),
		("jobs-n", "jobs -n; echo after"),
	] {
		cases.push((
			format!("killed-last/{name}"),
			format!("shopt -s lastpipe; /bin/true | {KILLED}; {tail}"),
		));
	}
	cases.extend(rows(&[
		(
			"pipefail-group",
			"set -o pipefail; shopt -s lastpipe; /bin/sh -c 'kill -HUP $$' | { /bin/sh -c 'kill \
			 -KILL $$'; echo in; }; echo after",
		),
		("ok/jobs-l", "shopt -s lastpipe; /bin/true | /bin/true; jobs -l; echo after"),
		("ok/next-line", "shopt -s lastpipe; /bin/true | /bin/true; echo after\njobs -l; echo end"),
		("builtin-last/jobs-l", "shopt -s lastpipe; /bin/true | echo x; jobs -l; echo after"),
		("term-last", "shopt -s lastpipe; /bin/true | /bin/sh -c 'kill -TERM $$'; echo after"),
		(
			"background-first",
			"sleep 30 & b=$!; shopt -s lastpipe; /bin/true | /bin/sh -c 'kill -KILL $$'; jobs -l; \
			 kill -KILL $b; wait $b 2>/dev/null; echo after",
		),
		(
			"two-pipelines",
			"shopt -s lastpipe; /bin/true | /bin/sh -c 'kill -KILL $$'; /bin/true | /bin/sh -c 'kill \
			 -HUP $$'; jobs -l; echo after",
		),
		(
			"wait-all",
			"shopt -s lastpipe; /bin/true | /bin/sh -c 'kill -KILL $$'; wait; echo status=$?; jobs \
			 -l; echo end",
		),
		(
			"wait-next",
			"shopt -s lastpipe; /bin/true | /bin/sh -c 'kill -KILL $$'; wait -n; echo status=$?; \
			 jobs -l; echo end",
		),
		(
			"group-two-children",
			"shopt -s lastpipe; /bin/true | { /bin/sh -c 'kill -KILL $$'; /bin/sh -c 'kill -HUP $$'; \
			 }; jobs -l; echo after",
		),
		("stand-in-last", "shopt -s lastpipe; printf 'a\\n' | cat; jobs -l; echo after"),
		(
			"while-read",
			"shopt -s lastpipe; printf 'a\\n' | while read l; do echo $l; done; jobs -l; echo after",
		),
		(
			"for-head",
			"shopt -s lastpipe; /bin/true | for i in a b; do ( : ); done; jobs -l; echo after",
		),
		("case-head", "shopt -s lastpipe; /bin/true | case a in b) ;; esac; jobs -l; echo after"),
		// Bash keeps the spacing inside `(( … ))`, which the parser here does
		// not; without spaces both print the same text.
		("arithmetic", "shopt -s lastpipe; /bin/true | ((1)); jobs -l; echo after"),
		("conditional", "shopt -s lastpipe; /bin/true | [[ -n a ]]; jobs -l; echo after"),
		(
			"subshell-last",
			"shopt -s lastpipe; /bin/true | ( /bin/sh -c 'kill -KILL $$' ); jobs -l; echo after",
		),
	]));
	assert_all_bash(cases).await;
}

/// Every process of a foreground pipeline a signal ended is printed with a
/// pid, also a stage the shell runs itself. No stage writes to the pipe: a
/// write after the last stage died would end it with SIGPIPE, or not,
/// depending on timing, in Bash too.
#[tokio::test(flavor = "multi_thread")]
async fn foreground_stages_the_shell_runs_have_pids() {
	const KILLED: &str = "/bin/sh -c 'kill -KILL $$'";
	let mut cases = Vec::new();
	for stages in ["true", "true | true", "{ true; }", "( true )", ": | false", "printf ''"] {
		cases.push((stages.to_owned(), format!("{stages} | {KILLED}; echo status=$?")));
	}
	cases.push((
		"pipefail".to_owned(),
		format!("set -o pipefail; true | {KILLED} | true; echo status=$?"),
	));
	assert_all_bash(cases).await;
}

/// Bash runs a subshell's last command in place of the subshell unless an
/// `EXIT` or `ERR` trap or a signal trap with a command is set in it
/// (`should_optimize_fork`); an ignored signal (`trap "" SIG`), `DEBUG` and
/// `RETURN` do not count, and traps the subshell inherited are reset.
#[tokio::test(flavor = "multi_thread")]
async fn ignored_signals_do_not_stop_subshell_replacement() {
	const KILLED: &str = "/bin/sh -c 'kill -KILL $$'";
	let mut cases = Vec::new();
	for trap in [
		"trap \"\" USR1",
		"trap \"\" PIPE",
		"trap \"\" INT",
		"trap \"\" TERM",
		"trap \"\" HUP",
		"trap : USR1",
		"trap : EXIT",
		"trap : ERR",
		"trap : DEBUG",
		"trap : RETURN",
		"trap \"\" EXIT",
	] {
		cases.push((format!("inside/{trap}"), format!("( {trap}; {KILLED} ); echo status=$?")));
		cases.push((
			format!("inside-list/{trap}"),
			format!("( {trap}; echo a; {KILLED} ); echo status=$?"),
		));
		cases.push((
			format!("inherited/{trap}"),
			format!("{trap}; ( echo a; {KILLED} ); echo status=$?"),
		));
	}
	// What else decides it: `errtrace` keeps an inherited `ERR` trap, a trap
	// reset in the subshell no longer counts, a redirection on the last
	// command or a last command inside an `&&` after `;` blocks it.
	for (name, script) in [
		("errtrace", format!("set -E; trap : ERR; ( echo a; {KILLED} ); echo status=$?")),
		("no-errtrace", format!("trap : ERR; ( echo a; {KILLED} ); echo status=$?")),
		("reset-inside", format!("( trap : USR1; trap - USR1; echo a; {KILLED} ); echo status=$?")),
		("redirected-last", format!("( echo a; {KILLED} >/dev/null ); echo status=$?")),
		("redirected-only", format!("( {KILLED} >/dev/null ); echo status=$?")),
		("and-list", format!("( true && {KILLED} ); echo status=$?")),
		("or-list", format!("( false || {KILLED} ); echo status=$?")),
		("semicolon-and", format!("( echo a; true && {KILLED} ); echo status=$?")),
	] {
		cases.push((name.to_owned(), script));
	}
	assert_all_bash(cases).await;
}

/// Bash writes a diagnostic to standard error and goes on when the write
/// fails, its standard error closed or full: the command fails as it would
/// have, and the script continues.
#[tokio::test(flavor = "multi_thread")]
async fn a_diagnostic_to_a_closed_or_failing_stderr_is_not_fatal() {
	let mut cases = Vec::new();
	let failures = [
		("redirection", "echo BAD >&2"),
		("cd", "cd /nonexistent"),
		("type", "type nosuchcommand_zz"),
		("jobs", "jobs %9"),
		("wait", "wait %9"),
		("unset", "unset -z x"),
		("alias", "alias nosuchalias_zz"),
		("not-found", "nosuchcommand_zz"),
		("missing-file", "cat < /nonexistent"),
		("arithmetic", "echo $((1/0))"),
		("unset-variable", ": ${x?unset}"),
		("job-report", "sleep 30 & p=$!; kill -KILL $p; wait $p"),
		("readonly", "readonly r=1; r=2"),
	];
	for (stream, setup) in [("closed", "exec 2>&-"), ("full", "exec 2>/dev/full")] {
		for (name, command) in failures {
			cases.push((
				format!("{stream}/{name}"),
				format!("{setup}; {command}; echo status=$?; echo AFTER"),
			));
		}
	}
	cases.extend(rows(&[
		("group", "{ exec 2>&-; echo BAD >&2; } 2>/dev/null; echo AFTER; echo ERR >&2"),
		("group-no-exec", "{ echo BAD >&2; } 2>&-; echo AFTER"),
		("next-line", "exec 2>&-\necho BAD >&2\necho AFTER=$?"),
	]));
	assert_all_bash(cases).await;
}

/// Each of Bash's builtins given an option it does not take (each prints a
/// diagnostic and fails) ends the same way, with the same status and the
/// script going on, whether its standard error is redirected away, closed
/// or full.
#[tokio::test(flavor = "multi_thread")]
async fn no_builtin_fails_differently_on_a_closed_or_full_stderr() {
	const BUILTINS: &[&str] = &[
		"alias",
		"bg",
		"bind",
		"builtin",
		"caller",
		"cd",
		"command",
		"compgen",
		"complete",
		"compopt",
		"declare",
		"dirs",
		"disown",
		"echo",
		"enable",
		"eval",
		"exec",
		"export",
		"false",
		"fc",
		"fg",
		"getopts",
		"hash",
		"help",
		"history",
		"jobs",
		"kill",
		"let",
		"local",
		"mapfile",
		"popd",
		"printf",
		"pushd",
		"pwd",
		"read",
		"readarray",
		"readonly",
		"set",
		"shift",
		"shopt",
		"source",
		"test",
		"times",
		"trap",
		"true",
		"type",
		"typeset",
		"ulimit",
		"umask",
		"unalias",
		"unset",
		"wait",
	];
	let mut mismatches = Vec::new();
	for builtin in BUILTINS {
		let tail = format!("{builtin} -Z </dev/null; echo status=$?; echo AFTER");
		let away = run(&format!("exec 2>/dev/null; {tail}")).await;
		for setup in ["exec 2>&-", "exec 2>/dev/full"] {
			let script = format!("{setup}; {tail}");
			let ended = run(&script).await;
			if ended != away {
				mismatches
					.push(format!("`{script}`\n  2>/dev/null: {away:?}\n  here:        {ended:?}"));
			}
		}
	}
	assert!(mismatches.is_empty(), "{} differ:\n{}", mismatches.len(), mismatches.join("\n"));
}
