//! Frames written by the upstream engine must restore without losing running shells.
#![cfg(unix)]

use pi_shell::{
	bash::{Cx, Engine, EngineConfig, MemStore, RestoreOpts, RestoreReport, Shell},
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

// Both fixtures were written by the unmodified pi-shell library at upstream main
// b0b02d1120976535f466b282739c25775f991830 (frames version 29). The writer ran
// KEEP=preserved; f(){ hold; return 23; }; f & p=$!; <tail>
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
