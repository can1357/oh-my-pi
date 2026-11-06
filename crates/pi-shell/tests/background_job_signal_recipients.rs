//! Real kernel recipients through the same Shell/PiHost/spawner API used by
//! pi-natives. A virtual wait status alone cannot detect a lost or widened
//! signal.
#![cfg(target_os = "linux")]

use std::{fs, process::Command};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
	name:     String,
	topology: String,
	spec:     String,
	target:   String,
	mode:     String,
	number:   u8,
}

fn quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

async fn assert_recipients(tree: bool) {
	let scratch = tempfile::tempdir().unwrap();
	let observer = scratch.path().join("signal-recipient");
	let compiled = Command::new("cc")
		.args(["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2"])
		.arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/signal-recipient.c"))
		.arg("-o")
		.arg(&observer)
		.output()
		.expect("compile the real signal observer");
	assert!(compiled.status.success(), "{}", String::from_utf8_lossy(&compiled.stderr));
	let cases: Vec<Case> =
		serde_json::from_str(include_str!("fixtures/signal-recipient.json")).unwrap();
	let mut mismatches = Vec::new();
	let mut rows = 0;
	for case in cases
		.iter()
		.filter(|case| (case.topology == "tree") == tree)
	{
		rows += 1;
		let directory = tempfile::tempdir_in(scratch.path()).unwrap();
		let args = [
			observer.to_str().unwrap(),
			directory.path().to_str().unwrap(),
			&case.topology,
			&case.spec,
			&case.target,
			&case.mode,
		]
		.map(quote)
		.join(" ");
		let command = format!("set -- {args}\n{}", include_str!("fixtures/signal-recipient.sh"));
		let (tx, rx) = flume::unbounded::<String>();
		let shell = Shell::new(None);
		let result = shell
			.run(
				ShellRunOptions { command, ..Default::default() },
				Some(tx),
				CancelToken::new(Some(10_000)),
			)
			.await
			.expect("run recipient script through PiHost");
		let output: String = rx.drain().collect();
		let mut errors = Vec::new();
		if (result.exit_code, output.as_str()) != (Some(0), "kill=0\nwait=0\n") {
			errors.push(format!("status={:?} output={output:?}", result.exit_code));
		}
		let roles: &[(&str, bool)] = match case.topology.as_str() {
			"tree" => &[("parent", true), ("child", false)],
			"completed" => &[("right", true)],
			_ => &[("left", false), ("right", true)],
		};
		for &(role, selected) in roles {
			let expected = format!(
				"15={} 32={} 33={} 34={} wrong=0\n",
				u8::from(selected && case.number == 15),
				u8::from(selected && case.number == 32),
				u8::from(selected && case.number == 33),
				u8::from(selected && case.number == 34),
			);
			let actual = fs::read_to_string(directory.path().join(format!("{role}-events")));
			if actual.as_ref().ok() != Some(&expected) {
				errors.push(format!("{role}: expected {expected:?}, got {actual:?}"));
			}
		}
		if !errors.is_empty() {
			mismatches.push(format!("{}: {}", case.name, errors.join("; ")));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {rows} recipient rows differ from Bash:\n{}",
		mismatches.len(),
		mismatches.join("\n"),
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pipeline_pid_signals_only_its_rightmost_program_and_waits_for_it() {
	assert_recipients(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_program_signal_does_not_reach_its_native_descendants() {
	assert_recipients(true).await;
}
