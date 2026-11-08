//! A valid root identity must not be mistaken for a disowned child's owner.
use std::sync::Arc;

use bstr::BString;
use pi_shell::{
	bash::{Budget, CallOutcome, Cx, Engine, EngineConfig, MemStore, Script, Shell, ShellApi, Step},
	testkit::{FakeHost, fault::skeleton_init},
};

#[test]
fn background_and_foreground_waits_work_at_every_configured_root_identity() {
	for root in [0, 1, 42] {
		assert_execution(
			root,
			"f(){ hold; return 7; }; f & p=$!; wait \"$p\"; echo first=$?; wait \"$p\"; echo again=$?",
			"first=7\nagain=7\n",
		);
		assert_execution(root, "( hold; exit 7 ); echo foreground=$?", "foreground=7\n");
	}
}

#[test]
fn disown_does_not_disown_other_children_of_a_zero_pid_root() {
	for root in [0, 1, 42] {
		assert_execution(
			root,
			"f(){ hold; return 7; }; f & a=$!; disown \"$a\"; ( hold; exit 9 ); echo owned=$?; wait \
			 \"$a\"; echo disowned=$?",
			"owned=9\ndisowned=0\n",
		);
	}
}

#[test]
fn a_disowned_child_cannot_wait_for_itself() {
	for root in [0, 1, 42] {
		assert_execution(
			root,
			"f(){ hold; wait \"$BASHPID\" 2>/dev/null; echo self=$?; }; f & p=$!; disown \"$p\"",
			"self=127\n",
		);
	}
}

fn assert_execution(root: u32, script: &str, expected: &str) {
	let engine = Engine::new(EngineConfig { vpid_base: root, ..EngineConfig::default() });
	let mut host = FakeHost::new();
	host.tool("hold", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	shell.submit(Script::command(script.as_bytes()));
	let mut pending = Vec::new();
	let mut idle = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Call { id, .. } => pending.push(id),
			Step::Blocked if !pending.is_empty() => {
				for id in pending.drain(..) {
					shell.complete(id, CallOutcome::Exit(0));
				}
			},
			Step::Done { .. } | Step::Yield => {},
			Step::Idle => {
				idle = true;
				break;
			},
			_ => break,
		}
	}
	assert!(idle, "root={root}, script={script:?}: execution remained blocked");
	assert_eq!(host.stdout.bytes(), expected.as_bytes(), "root={root}, script={script:?}");
}
