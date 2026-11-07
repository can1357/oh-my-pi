//! Recovery keeps root state and abandons saved execution, whether the image
//! matches this engine or uses upstream 88a69582's Frames layout 29.

use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Incompatibility, MemStore, RestoreError, RestoreOpts,
		RunId, Script, Shell, Step,
	},
	testkit::{
		FakeHost, Rig,
		fault::{Fault, skeleton_init},
	},
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
	assert_recovery_keeps_root_state(&mut shell, &mut host, &mut store, RunId(1));
}

#[test]
fn same_identity_recovery_keeps_root_state_and_abandons_saved_runs() {
	let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
	assert_eq!(rig.run(Script::command(&b"saved=kept"[..]), Fault::None), 0);
	let run = rig
		.shell()
		.submit(Script::command(&b"while :; do :; done"[..]));
	let (shell, host, store) = rig.parts();
	let mut cx = Cx { host, store };
	assert!(matches!(shell.step(&mut cx, Budget { max_ops: 32, max_ns: u64::MAX }), Step::Yield));
	shell.control().request_suspend();
	assert!(matches!(shell.step(&mut cx, Budget::default()), Step::SuspendReady));
	shell.externalize(&mut cx).unwrap();
	let mut store = MemStore::from_bytes(&rig.store.to_bytes()).unwrap();
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let (mut recovered, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
		})
		.unwrap();
	println!("same-identity recovery={report:?}");
	assert_eq!(report.abandoned, [run]);
	assert_eq!(report.runs, 0, "explicit recovery must not resume saved execution");
	assert_recovery_keeps_root_state(&mut recovered, &mut host, &mut store, run);
}

fn assert_recovery_keeps_root_state(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut MemStore,
	abandoned: RunId,
) {
	let budget = Budget::default();
	assert!(matches!(
		shell.step(&mut Cx { host, store }, budget),
		Step::Done { run, status: 255 } if run == abandoned,
	));
	let run = shell.submit(Script::command(&b"echo $saved"[..]));
	for _ in 0..100 {
		match shell.step(&mut Cx { host, store }, budget) {
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
