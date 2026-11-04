use super::*;

/// One row of `prefix_assignments.json`: a script, and what Bash 5.3.20
/// prints for it and exits with, run as a script file in an empty
/// directory. A row where Bash 5.2.21 prints otherwise keeps that beside it
/// (`bash_5_2`, `status_5_2`); the engine follows Bash 5.3.
#[derive(serde::Deserialize)]
struct Row {
	name:   String,
	script: String,
	bash:   String,
	status: i32,
}

/// `output` with each line's diagnostic site (`bash: line 3: `) removed, as
/// the rows record Bash's diagnostics: Bash names a script file there, the
/// shell names itself.
fn without_diagnostic_site(output: &str) -> String {
	output
		.split_inclusive('\n')
		.map(|line| {
			let Some(rest) = line.strip_prefix("bash: ") else {
				return line;
			};
			rest
				.strip_prefix("line ")
				.and_then(|after| {
					let digits = after.bytes().take_while(u8::is_ascii_digit).count();
					(digits > 0)
						.then(|| after[digits..].strip_prefix(": "))
						.flatten()
				})
				.unwrap_or(rest)
		})
		.collect()
}

/// A simple command's prefix assignments, as Bash makes them: after the
/// command's words and before its redirections, in order, each in force
/// while the later ones expand; a later expansion's write to an earlier one
/// is what the command gets. Each goes where Bash's `assign_in_env` finds it
/// against the variables as they stand at that point: through the names that
/// hold others (`declare -n`), at most eight, a ring and a deeper chain warned
/// of; a readonly one is reported under the name written, before its value
/// expands, and the command runs without it. `=` gives the value as it is
/// and `+=` appends with the name's attributes (`-i` adds, an arithmetic
/// error abandons the line); a compound value is the text written. Their
/// diagnostics and `set -x` lines are written as each is made, before the
/// command's redirections; listings do not show them. For an external
/// command, a builtin, a function, `command`, `eval` and `.`, in the
/// foreground and the background, and with no command word.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn prefix_assignments_match_bash() {
	let rows: Vec<Row> =
		serde_json::from_str(include_str!("prefix_assignments.json")).expect("parity rows");
	let mut failures = Vec::new();
	for row in &rows {
		let dir = tempfile::tempdir().expect("scratch directory");
		let outcome = run_command_capture_within(
			Duration::from_secs(15),
			&row.script,
			Some(dir.path()),
			None,
			CancelToken::default(),
		)
		.await;
		match outcome {
			Ok((result, output))
				if result.exit_code == Some(row.status)
					&& without_diagnostic_site(&output) == row.bash => {},
			Ok((result, output)) => failures.push(format!(
				"{}: Bash prints {:?} and exits {}; got status {:?}, output {output:?}",
				row.name, row.bash, row.status, result.exit_code
			)),
			Err(_) => failures.push(format!("{}: did not finish within 15 s", row.name)),
		}
	}
	assert!(failures.is_empty(), "{} of {} rows differ: {failures:#?}", failures.len(), rows.len());
}
