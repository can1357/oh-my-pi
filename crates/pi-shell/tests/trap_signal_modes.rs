//! Rows generated from every Linux-catchable signal crossed with action
//! re-raising, restoration, return (with and without a caller), and nesting.
//! The fixture contains only rows red at the published pending-queue head;
//! its expected output is independently measured from real Bash script files.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use serde::Deserialize;

mod obash_support;

#[derive(Deserialize)]
struct Row {
	id:              String,
	script:          String,
	output:          String,
	status:          i32,
	mode:            Option<String>,
	boundary_output: Option<String>,
}

fn rows() -> Vec<Row> {
	serde_json::from_str(include_str!("fixtures/pending-trap-queue/signal-modes-red.json")).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn returning_from_a_signal_action_preserves_bashs_later_action_policy() {
	let mut failures = Vec::new();
	for row in rows().into_iter().filter(|row| row.mode.is_none()) {
		let (tx, rx) = flume::unbounded::<String>();
		let result = Shell::new(None)
			.run(
				ShellRunOptions { command: row.script, ..Default::default() },
				Some(tx),
				CancelToken::new(Some(20_000)),
			)
			.await
			.unwrap();
		let output: String = rx.drain().collect();
		if result.exit_code != Some(row.status) || output != row.output {
			failures.push(format!(
				"{}: expected ({}, {:?}), got ({:?}, {:?})",
				row.id, row.status, row.output, result.exit_code, output
			));
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn restoring_a_signal_action_retains_its_in_progress_mode() {
	assert_restored_rows(false);
}

#[test]
fn restoring_self_reaped_child_debt_exposes_the_version_29_boundary() {
	assert_restored_rows(true);
}

fn assert_restored_rows(boundary: bool) {
	let mut failures = Vec::new();
	for row in rows()
		.into_iter()
		.filter(|row| row.mode.is_some() && row.boundary_output.is_some() == boundary)
	{
		let expected = row.boundary_output.as_ref().unwrap_or(&row.output);
		let dir = tempfile::tempdir().unwrap();
		let script = dir.path().join("script.sh");
		let stats = dir.path().join("stats");
		std::fs::write(&script, row.script).unwrap();
		let output = obash_support::output(
			obash_support::obash()
				.arg("--fault=1:1")
				.arg(format!("--fault-mode={}", row.mode.unwrap()))
				.arg(script)
				.env("PI_SHELL_FAULT_STATS", &stats),
		);
		let counters = std::fs::read_to_string(stats).unwrap();
		let restored: u64 = counters
			.split_whitespace()
			.find_map(|word| word.strip_prefix("restored="))
			.unwrap()
			.parse()
			.unwrap();
		assert!(restored > 0, "{}: {counters}", row.id);
		assert!(counters.split_whitespace().any(|word| word == "lost=0"), "{counters}");
		if output.status.code() != Some(row.status)
			|| output.stdout != expected.as_bytes()
			|| !output.stderr.is_empty()
		{
			failures.push(format!(
				"{}: expected ({}, {:?}), got {output:?}; {counters}",
				row.id, row.status, expected
			));
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}
