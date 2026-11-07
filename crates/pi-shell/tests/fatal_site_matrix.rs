//! Every element of every axis the fatal-jump model has, with Bash 5.3.0's own
//! answer for the same `-c` string (Bash 5.2.21 agrees on all of them) and the
//! answer the engine gave when the fixture was measured.
//!
//! The rows come from a generated pass: the axis lists are read out of the
//! engine's own enum declarations (`Opcode`, `DeclareKind`, `Stop`,
//! `FrameKind`) and out of the gate's generated axes (`Carrier`,
//! `FatalContext`, `Raiser`, `TrapReplication`), crossed with one sample per
//! element — in full, not as a cover, for the carrier matrix — and measured
//! against both bash binaries and the baseline tree. `vm/fatal_sites.rs` inside
//! the crate is the other half: it fails when the code gains a variant, or the
//! matrix a combination, this fixture has no sample for.
//!
//! What this test asserts is the ENGINE column, not bash's: the engine does not
//! match bash at every site yet, and a gate that failed on those would say
//! nothing about a change. A row whose answer moved is reported with what the
//! move means — a regression when the baseline matched bash and the new answer
//! does not, a stale fixture when the new answer is bash's, and a drift when it
//! is neither.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use serde::Deserialize;

#[derive(Deserialize)]
struct Row {
	id:            String,
	script:        String,
	/// Bash 5.3.0's output for the same `-c` string.
	out:           String,
	/// Bash 5.3.0's exit status.
	status:        i32,
	/// The engine's output when the fixture was measured.
	engine_out:    String,
	/// The engine's exit status when the fixture was measured (`null` if the
	/// run produced none).
	engine_status: Option<i32>,
}

#[derive(Deserialize)]
struct Fixture {
	rows: Vec<Row>,
}

const FIXTURE: &str = include_str!("fatal-site-matrix.json");

/// Run `script` (its diagnostics discarded) in a fresh shell, in `cwd`: some
/// rows write a script file and source or run it.
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
async fn every_site_of_the_jump_model_answers_as_the_measured_baseline_does() {
	let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture");
	assert!(!fixture.rows.is_empty(), "the fixture has no rows");
	let dir = std::env::temp_dir().join(format!("fatal-site-matrix-{}", std::process::id()));
	std::fs::create_dir_all(&dir).expect("scratch directory");
	let cwd = dir.to_string_lossy().into_owned();
	let (mut regressions, mut stale, mut drift) = (Vec::new(), Vec::new(), Vec::new());
	for row in &fixture.rows {
		let got = run(&row.script, &cwd).await;
		let baseline = (row.engine_out.clone(), row.engine_status);
		if got == baseline {
			continue;
		}
		let bash = (row.out.clone(), Some(row.status));
		let line = format!(
			"{}: {got:?}, the measured baseline gives {baseline:?}, Bash 5.3.0 gives {bash:?}",
			row.id
		);
		if baseline == bash {
			regressions.push(line);
		} else if got == bash {
			stale.push(line);
		} else {
			drift.push(line);
		}
	}
	let _ = std::fs::remove_dir_all(&dir);
	let mut report = String::new();
	for (what, rows) in [
		("REGRESSION (the baseline matched Bash 5.3.0 and this tree does not)", &regressions),
		("STALE FIXTURE (this tree now matches Bash 5.3.0; re-measure and commit)", &stale),
		("DRIFT (neither the baseline's answer nor bash's)", &drift),
	] {
		if !rows.is_empty() {
			report.push_str(&format!("\n{} {what}:\n{}\n", rows.len(), rows.join("\n")));
		}
	}
	assert!(report.is_empty(), "{report}");
}
