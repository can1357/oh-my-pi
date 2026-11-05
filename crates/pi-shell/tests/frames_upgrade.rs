//! The fixture was externalized by upstream 88a69582 with Frames layout 29.
//! Refusing its execution state must not erase the snapshot or its root state.

use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Incompatibility, MemStore, RestoreError, RestoreOpts,
		RunId, Script, Shell, Step,
	},
	testkit::FakeHost,
};

#[test]
fn older_frames_are_refused_without_changing_the_store() {
	let mut store = MemStore::from_bytes(include_bytes!("fixtures/frames-v29.store")).unwrap();
	let before = store.to_bytes();
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let error = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err()
	.expect("the old execution layout is incompatible");
	println!("{error:?}: {error}");
	assert!(matches!(error, RestoreError::Incompatible { why: Incompatibility::Build }));
	assert_eq!(store.to_bytes(), before, "refusal must not perform recovery or erase the image");
	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
		})
		.unwrap();
	assert_eq!(report.abandoned, [RunId(1)]);
	let budget = Budget::default();
	assert!(matches!(
		shell.step(&mut Cx { host: &mut host, store: &mut store }, budget),
		Step::Done { run: RunId(1), status: 255 },
	));
	let run = shell.submit(Script::command(&b"echo $saved"[..]));
	for _ in 0..100 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, budget) {
			Step::Done { run: id, status } if id == run => {
				assert_eq!(status, 0);
				assert_eq!(host.stdout.bytes(), b"kept\n", "explicit recovery keeps root variables");
				return;
			},
			Step::Yield => {},
			other => panic!("unexpected recovery step: {other:?}"),
		}
	}
	panic!("the recovered shell did not finish");
}
