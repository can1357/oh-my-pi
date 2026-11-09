//! Every element of every axis the fatal-jump model has, with Bash 5.3.0's own
//! answer for the same `-c` string and the answer the engine gave when the
//! fixture was measured.  Bash 5.2.21 agrees on all rows EXCEPT the 537
//! no-fork ones (`${ ;}` and `${| ;}`), which it cannot parse at all — each
//! of those carries `bash_peer_lacks_nofork` and 5.3.0 is the only answer.
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
/// rows write a script file and source or run it.  Returns `(stdout,
/// exit_code, timed_out)`.
async fn run(script: &str, cwd: &str) -> (String, Option<i32>, bool) {
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
	(rx.drain().collect(), result.exit_code, result.timed_out)
}

/// A scratch directory this run alone owns.
///
/// `create_dir` fails when the name already exists, so a directory, a file or
/// a SYMLINK left at the name by anything else is never adopted: the rows
/// write their helper scripts into a directory that was empty a moment ago,
/// and the recursive cleanup below can only remove what this run made. The
/// process id alone is not ownership — a pid is reused, and the name is
/// guessable by anything that shares `TMPDIR`.
fn fresh_scratch_dir(base: &std::path::Path) -> std::path::PathBuf {
	for n in 0..1024u32 {
		let candidate = base.join(format!("fatal-site-matrix-{}-{n}", std::process::id()));
		match std::fs::create_dir(&candidate) {
			Ok(()) => return candidate,
			Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
			Err(err) => panic!("scratch directory {}: {err}", candidate.display()),
		}
	}
	panic!("no free scratch directory name under {}", base.display())
}

/// The allocation never takes a name something else already holds, whatever
/// kind of thing holds it.
#[test]
fn the_scratch_directory_is_fresh_and_owned() {
	let base = fresh_scratch_dir(&std::env::temp_dir());
	let first = fresh_scratch_dir(&base);
	let second = fresh_scratch_dir(&base);
	assert_ne!(first, second, "two allocations took the same directory");
	// A symlink at the next name must be stepped over, not followed.
	let outside = base.join("outside");
	std::fs::write(&outside, b"not the matrix's").expect("canary");
	let taken = base.join(format!("fatal-site-matrix-{}-2", std::process::id()));
	std::os::unix::fs::symlink(&outside, &taken).expect("symlink");
	let third = fresh_scratch_dir(&base);
	assert_ne!(third, taken, "the allocation adopted a pre-existing symlink");
	assert!(third.is_dir() && !third.is_symlink(), "{third:?} is not a fresh directory");
	assert_eq!(std::fs::read(&outside).expect("canary"), b"not the matrix's");
	std::fs::remove_dir_all(&base).expect("cleanup");
}

#[tokio::test(flavor = "multi_thread")]
async fn every_site_of_the_jump_model_answers_as_the_measured_baseline_does() {
	let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture");
	assert!(!fixture.rows.is_empty(), "the fixture has no rows");
	let dir = fresh_scratch_dir(&std::env::temp_dir());
	let cwd = dir.to_string_lossy().into_owned();
	let (mut regressions, mut stale, mut drift, mut timeouts) =
		(Vec::new(), Vec::new(), Vec::new(), Vec::new());
	for row in &fixture.rows {
		let (out, exit_code, timed_out) = run(&row.script, &cwd).await;
		if timed_out {
			timeouts.push(format!("{}: timed out (got ({out:?}, {exit_code:?}))", row.id));
			continue;
		}
		let got = (out, exit_code);
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
		("TIMEOUT (the row did not finish; this is not a measured answer)", &timeouts),
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
