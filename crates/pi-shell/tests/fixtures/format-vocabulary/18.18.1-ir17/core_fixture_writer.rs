use std::{path::PathBuf, sync::Arc};

use bstr::BString;
use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, MemStore, RunId, Script,
		Shell, ShellApi, StateStore, Step,
		store::BlobSlot,
	},
	testkit::{FakeHost, fault::skeleton_init},
};

#[test]
fn write_current_execution_cores() {
	let output = PathBuf::from(std::env::var_os("FIXTURE_OUTPUT").expect("FIXTURE_OUTPUT"));
	std::fs::create_dir_all(&output).unwrap();
	let engine = Engine::new(EngineConfig { vpid_base: 0, ..EngineConfig::default() });
	for (name, source, runs) in [
		("parent-wait", r#"KEEP=preserved; f(){ hold; return 23; }; f & p=$!; wait "$p"; echo child=$?"#, 1),
		("no-wait", r#"KEEP=preserved; f(){ hold; return 23; }; f &"#, 0),
		("root-kept", r#"f(){ return 23; }; f & p=$!; wait "$p"; jobs; hold; wait "$p"; echo kept=$?"#, 1),
		("subshell-kept", r#"( f(){ return 23; }; f & p=$!; wait "$p"; jobs; hold; wait "$p"; echo kept=$? )"#, 1),
	] {
		let mut host = FakeHost::new();
		host.tool("hold", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
		let mut store = MemStore::new();
		let mut shell = Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[])).unwrap();
		shell.submit(Script::command(source.as_bytes()));
		let mut calls = Vec::new();
		let mut blocked = false;
		for _ in 0..10_000 {
			match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
				Step::Call { id, .. } => calls.push(id),
				Step::Blocked => { blocked = true; break; },
				Step::Done { .. } | Step::Yield => {},
				other => panic!("{name}: {other:?}"),
			}
		}
		assert!(blocked, "{name} must contain a real pending call");
		assert_eq!(calls, [CallId(1)]);
		shell.control().request_suspend();
		assert!(matches!(shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()), Step::SuspendReady));
		let report = shell.externalize(&mut Cx { host: &mut host, store: &mut store }).unwrap();
		assert!(report.lost.is_empty());
		let frames = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
		let ((magic, ir, version, build, active), _) = postcard::take_from_bytes::<([u8; 4], u32, u32, [u8; 32], Vec<RunId>)>(&frames).unwrap();
		assert_eq!(magic, *b"OBF1");
		assert_eq!(active.len(), runs);
		let bytes = store.to_bytes();
		std::fs::write(output.join(format!("{name}.image")), &bytes).unwrap();
		let identity = serde_json::json!({"ir_version": ir, "frames_version": version, "build_id": build, "size": bytes.len(), "active_runs": active.len(), "call": 1, "vpid_base": 0, "source": source});
		std::fs::write(output.join(format!("{name}.json")), serde_json::to_vec_pretty(&identity).unwrap()).unwrap();
		println!("{name}: {identity}; report={report:?}");
	}
}
