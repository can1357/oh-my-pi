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

/// Bash installs the job of a `lastpipe` pipeline's processes but its last
/// before the last command runs (`stop_pipeline` with the table frozen), so
/// the last command sees it: `jobs` lists it without ` &`, `wait %1` waits
/// for it (and counts as reporting it), `kill %1` signals it, `wait` with
/// no operand passes over it, `wait -n` returns at once, and `$!` is not
/// its. Each first stage runs long enough to be running when the last
/// command looks, or has ended by then through a child the last command
/// waited for: a process that has just started may or may not have run by
/// then, in Bash too.
#[tokio::test(flavor = "multi_thread")]
async fn the_lastpipe_job_is_in_the_table_while_its_last_command_runs() {
	let firsts = ["/bin/sleep 0.5", "/bin/sleep 0.5 | /bin/sleep 0.5", "sleep 0.5"];
	let insides = [
		"jobs",
		"jobs -l",
		"jobs %1",
		"jobs -n",
		"jobs -l; jobs -l",
		"wait %1; echo w=$?",
		"wait %1; jobs -l",
		"wait -n; echo w=$?",
		"wait; echo w=$?",
		"echo \"bang=$!\"",
		"kill %1; echo k=$?",
		"kill -0 %1; echo k=$?",
		"kill %1; wait %1; echo w=$?",
		"kill -HUP %1; wait %1; echo w=$?",
		"/bin/sleep 0.05; jobs -l",
	];
	let mut cases = Vec::new();
	for first in firsts {
		for inside in insides {
			cases.push((
				format!("{first} | {{ {inside}; }}"),
				format!(
					"shopt -s lastpipe; {first} | {{ {inside}; }}; echo st=$?; jobs -l; echo after"
				),
			));
		}
	}
	cases.extend(rows(&[
		(
			"ended-first/after-a-child",
			"shopt -s lastpipe; /bin/true | { /bin/sleep 0.1; jobs -l; wait %1; echo w=$?; }; jobs \
			 -l; echo after",
		),
		(
			"killed-first/after-a-child",
			"shopt -s lastpipe; /bin/sh -c 'kill -KILL $$' | { /bin/sleep 0.1; jobs -l; wait %1; \
			 echo w=$?; }; jobs -l; echo after",
		),
		(
			"background-before",
			"sleep 30 & b=$!; shopt -s lastpipe; /bin/sleep 0.5 | { jobs -l; [ \"$!\" = \"$b\" ] && \
			 echo same; }; kill -KILL $b; wait $b 2>/dev/null; jobs -l; echo after",
		),
		(
			"stage-pid",
			"shopt -s lastpipe; d=$(mktemp -d); sleep 0.5 | { jobs -p > $d/p; read p < $d/p; kill \
			 $p; echo k=$?; wait %1; echo w=$?; }; rm -rf $d; echo after",
		),
		(
			"pipefail",
			"set -o pipefail; shopt -s lastpipe; /bin/sleep 0.5 | { kill %1; }; echo st=$? \
			 \"${PIPESTATUS[*]}\"; jobs -l; echo after",
		),
		(
			"next-line",
			"set -o pipefail; shopt -s lastpipe; /bin/sleep 0.5 | { kill -HUP %1; }; echo \
			 st=$?\necho next",
		),
	]));
	assert_all_bash(cases).await;
}

/// What the last command of a `lastpipe` pipeline asks of the control flow
/// reaches the shell, since that command runs in it. `break` and `continue`
/// only set a flag, so the job of the pipeline's other processes ends as
/// usual: for an external first stage, a builtin one and one a signal kills.
/// `return`, `exit`, `set -e` inside the command and an abandoned command
/// are jumps Bash takes with `longjmp` out of `execute_pipeline`, which
/// neither waits for that job nor appends the shell to it: the job stays as
/// installed, its first stage still running when the next command looks
/// (a first stage that ends at once would race that command, in Bash too),
/// and is forgotten or reported at a later notify point once it ends.
#[tokio::test(flavor = "multi_thread")]
async fn lastpipe_control_flow_reaches_the_shell_with_its_job() {
	type Flow = fn(&str) -> String;
	// Rows whose output does not depend on when the first stage ends: `break`
	// and `continue` wait for it, and `exit` and `set -e` end the script
	// before anything looks at it.
	let any_first: [(&str, Flow); 4] = [
		("exit", |first| format!("{first} | exit 6; echo after")),
		("errexit", |first| format!("set -e; {first} | {{ false; echo no; }}; echo after")),
		("break", |first| {
			format!("for i in 1 2; do {first} | break; echo i=$i; done; jobs -l; echo done")
		}),
		("continue", |first| {
			format!("for i in 1 2; do {first} | continue; echo i=$i; done; jobs -l; echo done")
		}),
	];
	// Jumps after which the script goes on and looks at the job while its
	// first stage runs: `return`, and an assignment statement to a readonly
	// variable, which abandons the rest of its input line.
	let long_first: [(&str, Flow); 2] = [
		("return", |first| {
			format!("f() {{ {first} | return 4; echo no; }}; f; echo st=$?; jobs -l; echo done")
		}),
		("abandoned", |first| {
			format!(
				"exec 2>/dev/null; readonly r=1; {first} | {{ r=2; echo no; }}; echo same-line\necho \
				 after=$?; jobs -l"
			)
		}),
	];
	let mut cases = Vec::new();
	for first in ["/bin/sleep 0.2", "sleep 0.2", "/bin/sh -c 'kill -KILL $$'"] {
		for (name, flow) in any_first {
			cases.push((format!("{name}/{first}"), format!("shopt -s lastpipe; {}", flow(first))));
		}
	}
	for first in ["/bin/sleep 0.2", "sleep 0.2"] {
		for (name, flow) in long_first {
			cases.push((format!("{name}/{first}"), format!("shopt -s lastpipe; {}", flow(first))));
		}
	}
	cases.extend(rows(&[
		(
			"return/ends-later",
			"shopt -s lastpipe; f() { /bin/sleep 0.2 | return 4; }; f; /bin/sleep 0.4; jobs -l; echo \
			 done",
		),
		(
			"return/killed-later",
			"shopt -s lastpipe; f() { /bin/sh -c 'sleep 0.1; kill -KILL $$' | return 4; }; f; \
			 /bin/sleep 0.4; jobs -l; echo done",
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
/// diagnostic and fails) ends as in Bash, with the same status and the
/// script going on, whether its standard error is redirected away, closed
/// or full. A builtin whose invalid-option status differs from Bash's
/// whatever its standard error is, is not one this checks.
#[tokio::test(flavor = "multi_thread")]
async fn each_builtin_fails_as_bash_does_on_a_closed_or_full_stderr() {
	const BUILTINS: &[&str] = &[
		"alias",
		"bg",
		"bind",
		"builtin",
		"cd",
		"compgen",
		"complete",
		"compopt",
		"declare",
		"dirs",
		"disown",
		"echo",
		"enable",
		"exec",
		"export",
		"false",
		"fg",
		"getopts",
		"hash",
		"help",
		"jobs",
		"let",
		"mapfile",
		"popd",
		"pushd",
		"pwd",
		"read",
		"readarray",
		"readonly",
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
	let mut cases = Vec::new();
	for builtin in BUILTINS {
		for (stream, setup) in
			[("away", "exec 2>/dev/null"), ("closed", "exec 2>&-"), ("full", "exec 2>/dev/full")]
		{
			cases.push((
				format!("{stream}/{builtin}"),
				format!("{setup}; {builtin} -Z </dev/null; echo status=$?; echo AFTER"),
			));
		}
	}
	assert_all_bash(cases).await;
}
