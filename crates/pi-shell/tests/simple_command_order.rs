//! A generated differential net over simple commands: prefix assignments,
//! command words (external, function, special builtin, a name made by a
//! substitution, word arguments, declaration builtins, also through
//! `command` and `builtin`), redirections that work and that fail, with
//! and without an expansion in their target, one that reads the prefix
//! variables, before and after the command word, process substitutions,
//! `set -u`, expansion errors, readonly variables and POSIX mode; prefix
//! assignments that build on the variable (`+=` on a string, an integer, an
//! upper-case, an unset and a local variable, and on a value an earlier
//! prefix assignment set); and a command name that expands to nothing.
//! Every expansion appends a distinct tag to
//! a file, so each row records what ran, how many times and in what order,
//! with the final variable values, the exit status and the files made. Bash
//! 5.2.21 reading each script on standard input printed every expected
//! output in `fixtures/simple_command_order.tsv`.
//!
//! Bash expands the command words first, then each prefix assignment in
//! turn, expanding and assigning it once, into the command's temporary
//! environment or, with no command name, into the shell; only then does it
//! perform the redirections, which do not see the temporary environment
//! (`expand_word_list_internal`, `do_assignment_statements`). An assignment
//! word is an assignment argument only after a declaration builtin named
//! as written, past `command` words in POSIX mode (`fix_assignment_words`).
//! In POSIX mode the assignments before a special builtin stay, and its
//! failed redirection ends the shell; an assignment to a readonly variable
//! there ends the shell before a special builtin and abandons the command
//! before any other. A `+=` prefix assignment gives the command the
//! variable's value with the word appended as an assignment to the variable
//! appends it (`assign_in_env`, `make_variable_value`).
#![cfg(unix)]

use std::sync::Arc;

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs `command` in a fresh shell, returning its exit status and output.
async fn run(command: String) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command, ..Default::default() },
			Some(tx),
			CancelToken::new(Some(20_000)),
		)
		.await
		.expect("run");
	(result.exit_code, rx.drain().collect())
}

/// Runs each `(id, script, exit status, output)` row in a fresh shell,
/// eight at a time, and asserts Bash's exit status and output, reporting
/// every row that differs.
async fn assert_bash_rows(rows: Vec<(String, String, i32, String)>) {
	let limit = Arc::new(tokio::sync::Semaphore::new(8));
	let mut runs = tokio::task::JoinSet::new();
	for (index, (_, script, ..)) in rows.iter().enumerate() {
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
		.filter_map(|(index, (exit_code, output))| {
			let (id, script, expected_exit, expected) = &rows[index];
			((exit_code, output.as_str()) != (Some(*expected_exit), expected.as_str())).then(|| {
				format!(
					"{id}: `{script}`\n  bash: Some({expected_exit}) {expected:?}\n  omp:  \
					 {exit_code:?} {output:?}"
				)
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

#[tokio::test(flavor = "multi_thread")]
async fn simple_commands_expand_assign_and_redirect_in_bash_order() {
	let rows: Vec<(String, String, i32, String)> = include_str!("fixtures/simple_command_order.tsv")
		.lines()
		.map(|line| {
			let fields: Vec<&str> = line.split('\t').collect();
			let [id, script, output] = fields[..] else {
				panic!("bad row {line:?}");
			};
			(id.to_owned(), script.to_owned(), 0, output.replace("\\n", "\n"))
		})
		.collect();
	assert_eq!(rows.len(), 1364);
	assert_bash_rows(rows).await;
}

/// An assignment to a readonly variable through every entry point Bash has
/// (a statement, `+=`, an element, a key, a list, a prefix before an
/// external command, a function or a special builtin, `export`, `declare`,
/// `readonly`, `local`, `read`, `printf -v`, `let`, `(( ))`, `for`,
/// `${x:=v}`, `unset`), on a scalar, an indexed, an associative and an
/// unset variable, at top level, after `||`, in a function, a nested
/// function, a subshell, a subshell with `set -e`, `eval`, `if eval`,
/// `command eval` and a command substitution, with and without `set -e`
/// and POSIX mode; then `set -e` across functions, subshells, `eval`,
/// `command` and an ERR trap, assignments in ERR and DEBUG trap handlers,
/// and POSIX mode's fatal errors. Bash 5.2.21 reading each script
/// on standard input printed every expected output in
/// `fixtures/readonly_assignments.jsonl` (`bash -c` exits 127 instead of 1
/// where POSIX mode or a failed expansion forces the shell's input to end).
///
/// As in Bash, a readonly variable is reported, which exits the shell at
/// once under `set -e` (`report_error`), unless an `eval`, `source` or
/// `command` run where a failure is tested turned errexit off; then the
/// failure jumps as Bash's `do_assignment_statements`, `assign_in_env`,
/// `parameter_brace_expand_rhs` and `execute_for_command` jump. An element
/// of a readonly array is readonly too. Before this round `set -e` let the
/// jump abandon the command instead of exiting, the element assignment
/// succeeded, and an ERR or DEBUG handler's exit was dropped.
#[tokio::test(flavor = "multi_thread")]
async fn readonly_assignments_fail_and_jump_as_bash_does() {
	let rows: Vec<(String, String, i32, String)> =
		include_str!("fixtures/readonly_assignments.jsonl")
			.lines()
			.map(|line| {
				let row: serde_json::Value = serde_json::from_str(line).expect("fixture row");
				let field = |name: &str| row[name].as_str().expect("fixture field").to_owned();
				let exit =
					i32::try_from(row["exit"].as_i64().expect("fixture exit")).expect("exit status");
				(field("id"), field("script"), exit, field("output"))
			})
			.collect();
	assert_eq!(rows.len(), 1113);
	assert_bash_rows(rows).await;
}

/// A failed assignment abandons the command being run, as Bash's
/// `jump_to_top_level (DISCARD)` in `do_assignment_statements` does: every
/// enclosing command ends, the callers of a function and the rest of its
/// input line included, and the text it was read from goes on with its
/// next line, status 1. That is so for a prefix assignment to a readonly
/// variable in POSIX mode, before a command that is not a special builtin,
/// and for an assignment statement to one in any mode. `eval`, `source` and
/// a trap handler read text of their own, so their caller goes on; a
/// subshell, a command substitution, a pipeline stage and a background job
/// end with status 1. A POSIX-mode shell exits instead before a special
/// builtin, and for an assignment statement unless it runs under `command`.
/// Each script's first line runs with its standard error discarded. The
/// error ended only the function it was in, and the caller ran on; and the
/// trap rows passed without their handler running, since this shell refuses
/// to signal itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_assignment_abandons_the_command_as_bash_does() {
	let rows: [(&str, &str, i32, &str); 30] = [
		("top", r"set -o posix; readonly x=old; x=new /bin/true; echo same-line", 0, "next s=1\n"),
		(
			"function",
			r"set -o posix; readonly x=old; f(){ x=new /bin/true; echo in-f; }; f; echo after-f",
			0,
			"next s=1\n",
		),
		(
			"nested",
			r"set -o posix; readonly x=old; f(){ x=new /bin/true; echo in-f; }; g(){ f; echo in-g; }; g; echo after-g",
			0,
			"next s=1\n",
		),
		(
			"subshell",
			r"(set -o posix; readonly x=old; f() { x=new /bin/true; }; f; echo continued); echo status=$?",
			0,
			"status=1\nnext s=0\n",
		),
		(
			"eval",
			r"set -o posix; readonly x=old; eval 'x=new /bin/true; echo in-eval1
echo in-eval2'; echo after-eval",
			0,
			"in-eval2\nafter-eval\nnext s=0\n",
		),
		(
			"eval-function",
			r"set -o posix; readonly x=old; f(){ x=new /bin/true; echo in-f; }; eval 'f; echo in-eval1
echo in-eval2'; echo after-eval",
			0,
			"in-eval2\nafter-eval\nnext s=0\n",
		),
		(
			"source",
			r#"d=$(mktemp -d); cd "$d"; set -o posix; readonly x=old; printf 'x=new /bin/true; echo in-src1\necho in-src2\n' >s.sh; . ./s.sh; echo after-src; cd /; rm -rf "$d""#,
			0,
			"in-src2\nafter-src\nnext s=0\n",
		),
		(
			"for",
			r"set -o posix; readonly x=old; for i in 1 2; do x=new /bin/true; echo i=$i; done; echo after-for",
			0,
			"next s=1\n",
		),
		(
			"while-function",
			r"set -o posix; readonly x=old; f(){ i=0; while [ $i -lt 2 ]; do i=$((i+1)); x=new /bin/true; echo i=$i; done; echo end-f; }; f; echo after",
			0,
			"next s=1\n",
		),
		(
			"comsub",
			r#"set -o posix; readonly x=old; v=$(x=new /bin/true; echo in-comsub); echo "v=$v s=$?""#,
			0,
			"v= s=1\nnext s=0\n",
		),
		(
			"pipe-last",
			r#"set -o posix; readonly x=old; echo a | x=new /bin/true; echo "after-pipe s=$?""#,
			0,
			"after-pipe s=1\nnext s=0\n",
		),
		(
			"pipe-first",
			r#"set -o posix; readonly x=old; x=new /bin/true | cat; echo "after-pipe s=$?""#,
			0,
			"after-pipe s=0\nnext s=0\n",
		),
		(
			"if",
			r"set -o posix; readonly x=old; if x=new /bin/true; then echo t; else echo e; fi; echo after-if",
			0,
			"next s=1\n",
		),
		(
			"or",
			r"set -o posix; readonly x=old; x=new /bin/true || echo or; echo after-or",
			0,
			"next s=1\n",
		),
		(
			"brace",
			r"set -o posix; readonly x=old; { x=new /bin/true; echo in-brace; }; echo after-brace",
			0,
			"next s=1\n",
		),
		// The handler prints `entered` first, so each row proves it ran: an
		// abandoned command ends the handler alone, and the caller goes on;
		// before a special builtin the shell exits.
		(
			"trap",
			r"set -o posix; readonly x=old; trap 'echo entered; x=new /bin/true; echo in-trap' ERR; false; echo after-trap",
			0,
			"entered\nafter-trap\nnext s=0\n",
		),
		(
			"trap-special",
			r"set -o posix; readonly x=old; trap 'echo entered; x=new :; echo in-trap' ERR; false; echo after-trap",
			1,
			"entered\n",
		),
		(
			"special-in-function",
			r"set -o posix; readonly x=old; f(){ x=new :; echo in-f; }; f; echo after-f",
			1,
			"",
		),
		(
			"non-posix-function",
			r"readonly x=old; f(){ x=new /bin/true; echo in-f; }; f; echo after-f",
			0,
			"in-f\nafter-f\nnext s=0\n",
		),
		(
			"background",
			r#"set -o posix; readonly x=old; f(){ x=new /bin/true; echo in-bg; }; f & wait $!; echo "after-bg s=$?""#,
			0,
			"after-bg s=1\nnext s=0\n",
		),
		("statement/bash/readonly", r"readonly x=1; x=2; echo same", 0, "next s=1\n"),
		(
			"statement/bash/readonly-fn",
			r"readonly x=1; f(){ x=2; echo in-f; }; f; echo after-f",
			0,
			"next s=1\n",
		),
		(
			"statement/bash/readonly-sub",
			r"readonly x=1; ( x=2; echo in-sub ); echo after-sub",
			0,
			"after-sub\nnext s=0\n",
		),
		(
			"statement/bash/readonly-eval",
			r"readonly x=1; eval 'x=2; echo in-eval1
echo in-eval2'; echo after-eval",
			0,
			"in-eval2\nafter-eval\nnext s=0\n",
		),
		(
			"statement/bash/command-readonly",
			r"readonly x=1; command eval 'x=2'; echo same",
			0,
			"same\nnext s=0\n",
		),
		// Bash reading the script on standard input, or from a file, exits 1
		// here; `bash -c` exits 127.
		("statement/posix/readonly", r"set -o posix; readonly x=1; x=2; echo same", 1, ""),
		(
			"statement/posix/readonly-fn",
			r"set -o posix; readonly x=1; f(){ x=2; echo in-f; }; f; echo after-f",
			1,
			"",
		),
		(
			"statement/posix/readonly-sub",
			r"set -o posix; readonly x=1; ( x=2; echo in-sub ); echo after-sub",
			0,
			"after-sub\nnext s=0\n",
		),
		(
			"statement/posix/readonly-eval",
			r"set -o posix; readonly x=1; eval 'x=2; echo in-eval1
echo in-eval2'; echo after-eval",
			1,
			"",
		),
		(
			"statement/posix/command-readonly",
			r"set -o posix; readonly x=1; command eval 'x=2'; echo same",
			0,
			"same\nnext s=0\n",
		),
	];
	let rows = rows
		.into_iter()
		.map(|(id, line, exit, output)| {
			(
				id.to_owned(),
				format!("{{ {line}; }} 2>/dev/null\necho \"next s=$?\""),
				exit,
				output.to_owned(),
			)
		})
		.collect();
	assert_bash_rows(rows).await;
}

/// Each stage of a pipeline of two or more runs in a subshell, the last one
/// too unless `lastpipe` runs it in the shell: `exit`, `return`, `break`,
/// `continue` and an abandoned command there end that subshell alone. The
/// last stage's request reached the shell.
#[tokio::test(flavor = "multi_thread")]
async fn control_flow_in_a_pipeline_stage_ends_only_that_stage() {
	let rows: [(&str, &str, i32, &str); 7] = [
		(
			"exit-last",
			r#"true | exit 3; echo "after s=$?"
echo next"#,
			0,
			"after s=3\nnext\n",
		),
		(
			"exit-first",
			r#"exit 5 | cat; echo "after s=$?"
echo next"#,
			0,
			"after s=0\nnext\n",
		),
		(
			"return-last",
			r#"f(){ true | return 4; echo "in-f s=$?"; }; f; echo "after s=$?""#,
			0,
			"in-f s=4\nafter s=0\n",
		),
		(
			"break-last",
			r"for i in 1 2; do true | break; echo i=$i; done; echo done",
			0,
			"i=1\ni=2\ndone\n",
		),
		(
			"continue-last",
			r"for i in 1 2; do true | continue; echo i=$i; done; echo done",
			0,
			"i=1\ni=2\ndone\n",
		),
		("lastpipe-exit", r"shopt -s lastpipe; true | exit 6; echo after", 6, ""),
		(
			"lastpipe-break",
			r"shopt -s lastpipe; for i in 1 2; do true | break; echo i=$i; done; echo done",
			0,
			"done\n",
		),
	];
	let rows = rows
		.into_iter()
		.map(|(id, script, exit, output)| (id.to_owned(), script.to_owned(), exit, output.to_owned()))
		.collect();
	assert_bash_rows(rows).await;
}
