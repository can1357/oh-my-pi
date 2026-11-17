//! Restore fidelity: state that lives in a vproc between ops
//! survives a snapshot taken there.

use crate::testkit::{FakeHost, Fault, run_script};

fn same_under_snapshots(src: &[u8]) -> (Vec<u8>, Vec<u8>) {
	let base = run_script(FakeHost::new(), src, &[], Fault::None);
	let hit = run_script(FakeHost::new(), src, &[], Fault::Snapshot { every: 1 });
	assert!(hit.snapshots > 0, "no snapshot landed");
	assert_eq!(
		(&hit.stdout, &hit.stderr, hit.status),
		(&base.stdout, &base.stderr, base.status),
		"differs under snapshots"
	);
	(base.stdout, base.stderr)
}

/// `read` takes a pipe's bytes one at a time; the bytes it holds while the
/// writer runs on are part of the image, not lost.
#[test]
fn a_partial_read_survives_a_snapshot() {
	let (out, _) = same_under_snapshots(
		b"{ printf ab; :; :; :; :; printf 'c\\n'; } | { read x; echo \"got $x\"; }",
	);
	assert_eq!(out, b"got abc\n");
}

/// `select` prints its prompt when its read starts; a restored shell
/// continues that read instead of prompting again.
#[test]
fn a_waiting_select_does_not_prompt_twice() {
	let (out, err) = same_under_snapshots(
		b"{ :; :; :; :; echo 1; } | { select x in a b; do echo \"$x\"; break; done; }",
	);
	assert_eq!((out.as_slice(), err.as_slice()), (&b"a\n"[..], &b"1) a\n2) b\n#? "[..]));
}

/// `BASH_COMMAND` inside a trap action names the trapped command, also
/// when the action continues in a restored shell.
#[test]
fn bash_command_survives_a_snapshot_inside_a_trap() {
	let (out, _) = same_under_snapshots(b"trap ': x; echo \"[$BASH_COMMAND]\"' DEBUG; echo one");
	assert_eq!(out, b"[echo one]\none\n");
}
