//! Recovery keeps root state and abandons saved execution when the image
//! differs from this engine only in Frames layout or build. Upstream
//! 88a69582's released image (Frames layout 29, IR 15) now also differs in IR
//! record schema, so every mode refuses it.

use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Incompatibility, MemStore, RestoreError, RestoreOpts,
		RunId, Script, Shell, StateStore, Step,
		ir::IR_VERSION,
		store::BlobSlot,
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
	for opts in [RestoreOpts::default(), RestoreOpts { drop_frames: true, ..Default::default() }] {
		let error = Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts)
			.err()
			.expect("the old execution layout is incompatible");
		println!("{opts:?}: {error:?}: {error}");
		let RestoreError::Incompatible { why: Incompatibility::IrVersion { found, expected } } =
			error
		else {
			panic!("a released image of another IR record schema must be refused as such");
		};
		assert_eq!((found, expected), (15, IR_VERSION), "upstream 88a69582 wrote IR 15");
		assert_eq!(
			store.to_bytes(),
			before,
			"refusal must not perform recovery or erase the image"
		);
	}
}

#[test]
fn another_frames_layout_is_refused_and_recovers_only_with_drop_frames() {
	let (mut store, saved) = suspended_image();
	let mut frames = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
	assert_eq!(&frames[..4], b"OBF1", "the header starts with the magic");
	assert_eq!(
		u32::from(frames[4]),
		IR_VERSION,
		"this fixture is written by this engine, and the IR version is a one-byte varint"
	);
	assert!(frames[5] < 0x7f, "the layout version is a one-byte varint");
	frames[5] += 1;
	store.put_blob(BlobSlot::Frames, &frames).unwrap();
	let before = store.to_bytes();
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let error = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err()
	.expect("another Frames layout is incompatible");
	println!("{error:?}: {error}");
	assert!(matches!(error, RestoreError::Incompatible { why: Incompatibility::Build }));
	assert_eq!(store.to_bytes(), before, "refusal must not perform recovery or erase the image");
	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
			..Default::default()
		})
		.unwrap();
	println!("layout recovery={report:?}");
	assert_eq!(report.abandoned, [saved]);
	assert_eq!(report.runs, 0, "explicit recovery must not resume saved execution");
	assert_recovery_keeps_root_state(&mut shell, &mut host, &mut store, saved);
}

/// A store this engine wrote, holding `saved=kept` and one suspended run.
fn suspended_image() -> (MemStore, RunId) {
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
	(MemStore::from_bytes(&rig.store.to_bytes()).unwrap(), run)
}

#[test]
fn same_identity_recovery_keeps_root_state_and_abandons_saved_runs() {
	let (mut store, run) = suspended_image();
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let (mut recovered, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
			..Default::default()
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
