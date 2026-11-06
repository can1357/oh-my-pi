//! Every element of every axis the fatal-jump model has, with Bash 5.3.0's
//! own answer for the same `-c` string (Bash 5.2.21 agrees on all of them).
//!
//! The rows come from a generated pass: the axis lists are read out of the
//! engine's own enum declarations (`Opcode`, `DeclareKind`, `JumpCode`,
//! `LandingCatch`), crossed with one sample per element, and measured
//! against both bash binaries. `fatal_sites.rs` inside the crate is the
//! other half: it fails when the code gains a variant this fixture has no
//! sample for.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use serde::Deserialize;

#[derive(Deserialize)]
struct Row {
	id:     String,
	script: String,
	out:    String,
	status: i32,
}

#[derive(Deserialize)]
struct Fixture {
	rows: Vec<Row>,
}

const FIXTURE: &str = include_str!("fatal-site-matrix.json");

/// Run `script` (its diagnostics discarded) in a fresh shell, in `cwd`:
/// some rows write a script file and source or run it.
async fn run(script: &str, cwd: &str) -> (String, Option<i32>) {
	let (tx, rx) = flume::unbounded::<String>();
	let command = format!("exec 2>/dev/null\n{script}");
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command, cwd: Some(cwd.to_owned()), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(20_000)),
		)
		.await
		.expect("run");
	(rx.drain().collect(), result.exit_code)
}

#[tokio::test(flavor = "multi_thread")]
async fn every_site_of_the_jump_model_answers_as_bash_does() {
	let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture");
	assert!(!fixture.rows.is_empty(), "the fixture has no rows");
	// A `TempDir`, so the rows that write a script file leave nothing
	// behind: the directory goes when this binding drops.
	let dir = tempfile::Builder::new()
		.prefix("fatal-site-matrix-")
		.tempdir()
		.expect("scratch directory");
	let cwd = dir.path().to_string_lossy().into_owned();
	let mut wrong = Vec::new();
	for row in &fixture.rows {
		let got = run(&row.script, &cwd).await;
		if got != (row.out.clone(), Some(row.status)) {
			wrong.push(format!(
				"{}: got {got:?}, Bash 5.3.0 gives ({:?}, {})",
				row.id, row.out, row.status
			));
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
