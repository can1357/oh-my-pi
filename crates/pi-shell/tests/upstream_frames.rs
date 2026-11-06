//! Frames written by the upstream engine must restore without losing running
//! shells.
#![cfg(unix)]

use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, MemStore, RestoreOpts, RestoreReport,
		Script, Shell, Step,
	},
	testkit::FakeHost,
};

fn assert_upstream_restore(image: &[u8], runs: u32) {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::from_bytes(image).expect("upstream store image");
	let (_, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.expect("upstream frames must restore without dropping execution position");
	println!("{report:?}");
	assert_eq!(report, RestoreReport { vprocs: 2, runs, ..RestoreReport::default() });
}

// Both fixtures were written by the unmodified pi-shell library at upstream
// main b0b02d1120976535f466b282739c25775f991830 (frames version 29). The writer
// ran KEEP=preserved; f(){ hold; return 23; }; f & p=$!; <tail>
// and externalized after the child's host call `hold` was pending. No engine
// identity or image bytes were rewritten. The parent tail is shown per test.
#[test]
fn upstream_frames_with_active_child_and_parent_wait_restore_losslessly() {
	// tail: wait "$p"; upstream reports two vprocs and one unfinished run.
	assert_upstream_restore(include_bytes!("fixtures/frames/upstream-v29-parent-wait.image"), 1);
}

#[test]
fn upstream_frames_with_active_child_without_parent_wait_restore_losslessly() {
	// tail: :; upstream reports two vprocs and no unfinished root run.
	assert_upstream_restore(include_bytes!("fixtures/frames/upstream-v29-no-wait.image"), 0);
}

/// An upstream image has no optional retained-status or wait-state records.
/// Its live child must still finish, acquire a retained status, and obey the
/// normal rule that operandless `wait` forgets that status.
#[test]
fn restored_upstream_shell_retains_new_statuses_without_optional_job_records() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store =
		MemStore::from_bytes(include_bytes!("fixtures/frames/upstream-v29-parent-wait.image"))
			.expect("upstream image without optional job records");
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
