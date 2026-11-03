//! A generated differential net over simple commands: prefix assignments,
//! command words (external, function, special builtin, a name made by a
//! substitution, word arguments, declaration builtins, also through
//! `command` and `builtin`), redirections that work and that fail, with
//! and without an expansion in their target, one that reads the prefix
//! variables, before and after the command word, process substitutions,
//! `set -u`, expansion errors, readonly variables and POSIX mode. Every
//! expansion appends a distinct tag to a file, so each row records what
//! ran, how many times and in what order, with the final variable values,
//! the exit status and the files made. Bash 5.2.21 reading each script on
//! standard input printed every expected output in
//! `fixtures/simple_command_order.tsv`.
//!
//! Bash expands the command words first, then each prefix assignment in
//! turn, expanding and assigning it once, into the command's temporary
//! environment or, with no command name, into the shell; only then does it
//! perform the redirections, which do not see the temporary environment
//! (`expand_word_list_internal`, `do_assignment_statements`). An assignment
//! word is an assignment argument only after a declaration builtin named
//! as written, past `command` words in POSIX mode (`fix_assignment_words`).
//! In POSIX mode the assignments before a special builtin stay, and its
//! failed redirection ends the shell.
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

#[tokio::test(flavor = "multi_thread")]
async fn simple_commands_expand_assign_and_redirect_in_bash_order() {
	let rows: Vec<(String, String, String)> = include_str!("fixtures/simple_command_order.tsv")
		.lines()
		.map(|line| {
			let fields: Vec<&str> = line.split('\t').collect();
			let [id, script, output] = fields[..] else {
				panic!("bad row {line:?}");
			};
			(id.to_owned(), script.to_owned(), output.replace("\\n", "\n"))
		})
		.collect();
	assert_eq!(rows.len(), 1232);
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
		.filter_map(|(index, (exit_code, output))| {
			let (id, script, expected) = &rows[index];
			((exit_code, output.as_str()) != (Some(0), expected.as_str())).then(|| {
				format!(
					"{id}: `{script}`\n  bash: Some(0) {expected:?}\n  omp:  {exit_code:?} {output:?}"
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
