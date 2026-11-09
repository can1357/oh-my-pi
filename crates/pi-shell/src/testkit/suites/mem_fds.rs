//! In-memory fds (pipes between vprocs, command-substitution captures,
//! here-documents) survive snapshots: with a snapshot at every safepoint a
//! script prints exactly what a plain run prints.

use crate::testkit::{FakeHost, Fault, run_script};

/// The plain run's stdout, after checking the snapshot run matches it.
fn same_under_snapshots(src: &str) -> String {
	let base = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	let hit = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::Snapshot { every: 1 });
	assert!(hit.snapshots > 0, "no snapshot was taken");
	let out = String::from_utf8_lossy(&base.stdout).into_owned();
	assert_eq!(String::from_utf8_lossy(&hit.stdout), out, "stdout");
	assert_eq!(
		String::from_utf8_lossy(&hit.stderr),
		String::from_utf8_lossy(&base.stderr),
		"stderr"
	);
	assert_eq!(hit.status, base.status, "status");
	assert_eq!(hit.events, base.events, "events");
	out
}

#[test]
fn a_pipeline_mid_flight() {
	let out = same_under_snapshots("printf '%s\\n' a b c | while read x; do echo $x; done");
	assert_eq!(out, "a\nb\nc\n");
}

#[test]
fn a_command_substitution_mid_flight() {
	let out =
		same_under_snapshots("x=$(echo a; echo b); echo \"$x\"; y=${ echo c; echo d; }; echo \"$y\"");
	assert_eq!(out, "a\nb\nc\nd\n");
}

#[test]
fn a_here_document_mid_read() {
	let out =
		same_under_snapshots("while read l; do echo \"[$l]\"; done <<EOF\none\ntwo\nthree\nEOF");
	assert_eq!(out, "[one]\n[two]\n[three]\n");
}
