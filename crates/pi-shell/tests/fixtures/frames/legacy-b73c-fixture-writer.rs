use std::{path::PathBuf, sync::Arc};

use bstr::BString;
use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, MemStore, Script, Shell, ShellApi,
		StateStore, Step, Vpid,
		store::{BlobSlot, Key, Record},
	},
	testkit::{FakeHost, fault::skeleton_init},
};

fn externalize(shell: &mut Shell, host: &mut FakeHost, store: &mut MemStore) {
	shell.control().request_suspend();
	assert!(matches!(
		shell.step(&mut Cx { host, store }, Budget::default()),
		Step::SuspendReady
	));
	shell.externalize(&mut Cx { host, store }).unwrap();
}

fn wait_for_pending_call(shell: &mut Shell, host: &mut FakeHost, store: &mut MemStore) {
	let mut call = None;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host, store }, Budget::default()) {
			Step::Call { id, .. } => call = Some(id),
			Step::Blocked if call.is_some() => return,
			Step::Done { .. } | Step::Yield => {},
			step => panic!("fixture must reach its pending call: {step:?}"),
		}
	}
	panic!("fixture never reached its pending call");
}

fn verify_current_header(store: &mut MemStore) {
	let frames = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
	let ((magic, ir, version, build, _), _) =
		postcard::take_from_bytes::<([u8; 4], u32, u32, [u8; 32], Vec<pi_shell::bash::RunId>)>(&frames)
			.unwrap();
	assert_eq!(magic, *b"OBF1");
	assert_eq!((ir, version), (17, 30));
	assert_eq!(build, Engine::build_id());
}

#[test]
fn write_legacy_ownership_fixtures() {
	let output = PathBuf::from(std::env::var_os("FIXTURE_OUTPUT").expect("FIXTURE_OUTPUT"));
	std::fs::create_dir_all(&output).unwrap();

	let mut host = FakeHost::new();
	host.tool("hold", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
	let mut store = MemStore::new();
	let config = EngineConfig { vpid_base: 0, ..EngineConfig::default() };
	let create_engine = Engine::new(config);
	let shell = Shell::create(&create_engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[])).unwrap();
	drop(shell);
	let engine = Engine::new(EngineConfig { vpid_base: 1, ..config });
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		Default::default(),
	)
	.unwrap();
	assert!(report.lost.is_empty());
	shell.submit(Script::command(b"( hold; exit 7 ); echo owned=$?".as_slice()));
	wait_for_pending_call(&mut shell, &mut host, &mut store);
	assert_eq!(
		store.get(Key::Proc(Vpid(1))).unwrap(),
		Some(&Record::Proc { parent: Some(Vpid(1)), status: None })
	);
	externalize(&mut shell, &mut host, &mut store);
	verify_current_header(&mut store);
	std::fs::write(output.join("owned-self-parent.image"), store.to_bytes()).unwrap();

	for (name, source) in [
		("disowned", b"f(){ hold; return 7; }; f & p=$!; disown \"$p\"".as_slice()),
		("disown-all", b"f(){ hold; return 7; }; f & p=$!; disown -a".as_slice()),
	] {
		let engine = Engine::new(EngineConfig::default());
		let mut host = FakeHost::new();
		host.tool("hold", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
		let mut store = MemStore::new();
		let mut shell =
			Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
				.unwrap();
		shell.submit(Script::command(source));
		wait_for_pending_call(&mut shell, &mut host, &mut store);
		let child = Vpid(EngineConfig::default().vpid_base + 1);
		assert_eq!(
			store.get(Key::Proc(child)).unwrap(),
			Some(&Record::Proc { parent: Some(child), status: None })
		);
		externalize(&mut shell, &mut host, &mut store);
		verify_current_header(&mut store);
		std::fs::write(output.join(format!("{name}.image")), store.to_bytes()).unwrap();
	}
}
