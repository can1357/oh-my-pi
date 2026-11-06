//! Frames written by the upstream engine must restore without losing running
//! shells.
#![cfg(unix)]

mod upstream_frames_support;

use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, Incompatibility, RestoreError,
		RestoreOpts, RestoreReport, Script, Shell, Step,
	},
	testkit::FakeHost,
};
use upstream_frames_support::Identity;

fn assert_upstream_restore(parent_wait: bool, runs: u32) {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = upstream_frames_support::store(parent_wait, Identity::Same);
	let (_, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.expect("upstream frames must restore without dropping execution position");
	println!("{report:?}");
	assert_eq!(report, RestoreReport { vprocs: 2, runs, ..RestoreReport::default() });
}

// Each upstream-written pair runs
// KEEP=preserved; f(){ hold; return 23; }; f & p=$!; <tail>
// and externalizes after the child's `hold` call is pending. Writer shas and
// crate versions are recorded at the shared fixture consumer. A crate version
// bump changes Engine::build_id and requires a new pair, not an identity edit.
#[test]
fn upstream_frames_with_active_child_and_parent_wait_restore_losslessly() {
	// tail: wait "$p"; upstream reports two vprocs and one unfinished run.
	assert_upstream_restore(true, 1);
}

#[test]
fn upstream_frames_with_active_child_without_parent_wait_restore_losslessly() {
	// tail: :; upstream reports two vprocs and no unfinished root run.
	assert_upstream_restore(false, 0);
}

/// An upstream image has no optional retained-status or wait-state records.
/// Its live child must still finish, acquire a retained status, and obey the
/// normal rule that operandless `wait` forgets that status.
#[test]
fn restored_upstream_shell_retains_new_statuses_without_optional_job_records() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = upstream_frames_support::store(true, Identity::Same);
	let (mut shell, _) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	shell.complete(CallId(1), CallOutcome::Exit(0));
	let mut idle = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Idle => {
				idle = true;
				break;
			},
			Step::Yield | Step::Done { .. } => {},
			other => panic!("unexpected resumed child: {other:?}"),
		}
	}
	assert!(idle, "restored child must finish");
	let run = shell.submit(Script::command(
		br#"echo KEEP=$KEEP; wait "$p"; echo child=$?; wait; wait "$p" 2>/dev/null; echo forgotten=$?"#.as_slice(),
	));
	let mut done = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Done { run: r, status } if r == run => {
				assert_eq!(status, 0);
				done = true;
				break;
			},
			Step::Yield | Step::Done { .. } => {},
			other => panic!("unexpected restored shell: {other:?}"),
		}
	}
	assert!(done, "restored shell must finish the status query");
	assert_eq!(host.stdout.bytes(), b"KEEP=preserved\nchild=23\nforgotten=127\n");
}

#[test]
fn foreign_upstream_frames_are_refused_without_changing_the_store() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = upstream_frames_support::store(true, Identity::Different);
	let before = store.to_bytes();
	let error = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err()
	.expect("an image from a different engine build must be refused");
	assert!(
		matches!(error, RestoreError::Incompatible { why: Incompatibility::Build }),
		"a foreign identity must be refused, not misread: {error:?}"
	);
	assert_eq!(store.to_bytes(), before, "a refused image must remain unchanged");
}
