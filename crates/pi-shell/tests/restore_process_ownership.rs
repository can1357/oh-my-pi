//! A frameless restore can legitimately give an owned child its parent's id.
use std::sync::Arc;

use bstr::BString;
use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, MemStore, RestoreOpts, Script, Shell,
		ShellApi, StateStore, Step, Vpid,
		store::{Key, Record},
	},
	testkit::{FakeHost, fault::skeleton_init},
};

#[test]
fn an_owned_child_remains_waitable_after_the_frameless_root_identity_changes() {
	assert_restored_wait(1);
}

#[test]
fn an_owned_child_remains_waitable_after_a_same_identity_frameless_restore() {
	assert_restored_wait(0);
}

fn assert_restored_wait(root: u32) {
	let mut host = FakeHost::new();
	host.tool("hold", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
	let mut store = MemStore::new();
	let config = EngineConfig { vpid_base: 0, ..EngineConfig::default() };
	let engine = Engine::new(config);
	let shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	drop(shell);
	let engine = Engine::new(EngineConfig { vpid_base: root, ..config });
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert!(report.lost.is_empty(), "restore must report no loss: {report:?}");
	let run = shell.submit(Script::command(b"( hold; exit 7 ); echo owned=$?".as_slice()));
	let mut calls = 0;
	let mut done = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Call { id, call } => {
				calls += 1;
				assert_eq!(call.vpid, Vpid(1));
				let record = store.get(Key::Proc(call.vpid)).unwrap();
				println!("root={root}, child={:?}, record={record:?}", call.vpid);
				assert_eq!(record, Some(&Record::OwnedProc { parent: Some(Vpid(root)), status: None }));
				shell.complete(id, CallOutcome::Exit(0));
			},
			Step::Done { run: finished, status } if finished == run => {
				assert_eq!(status, 0);
				done = true;
				break;
			},
			Step::Done { .. } | Step::Yield => {},
			step => panic!("root={root}: owned foreground wait did not complete: {step:?}"),
		}
	}
	assert_eq!(calls, 1);
	assert!(done, "the foreground wait must finish");
	assert_eq!(host.stdout.bytes(), b"owned=7\n");
}

#[test]
fn an_explicitly_disowned_child_stays_disowned_after_a_frames_round_trip() {
	assert_disowned_round_trip(false);
}

#[test]
fn an_explicitly_disowned_child_leaves_no_completion_when_frames_are_dropped() {
	assert_disowned_round_trip(true);
}

fn assert_disowned_round_trip(drop_frames: bool) {
	let engine = Engine::new(EngineConfig { vpid_base: 0, ..EngineConfig::default() });
	let mut host = FakeHost::new();
	host.tool("hold", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	shell.submit(Script::command(b"f(){ hold; return 7; }; f & p=$!; disown \"$p\"".as_slice()));
	let mut call = None;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Call { id, .. } => call = Some(id),
			Step::Blocked if call.is_some() => break,
			Step::Done { .. } | Step::Yield => {},
			step => panic!("disowned child must reach its call: {step:?}"),
		}
	}
	let call = call.expect("the child called hold");
	assert_eq!(store.get(Key::Proc(Vpid(1))).unwrap(), Some(&Record::DisownedProc));
	shell.control().request_suspend();
	assert!(matches!(
		shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
		Step::SuspendReady
	));
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.unwrap();
	let mut store = MemStore::from_bytes(&store.to_bytes()).unwrap();
	assert_eq!(store.get(Key::Proc(Vpid(1))).unwrap(), Some(&Record::DisownedProc));
	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames,
			..RestoreOpts::default()
		})
		.unwrap();
	assert!(report.lost.is_empty(), "an explicitly disowned child has no owned completion to lose");
	if !drop_frames {
		shell.complete(call, CallOutcome::Exit(0));
	}
	shell.submit(Script::command(b"wait \"$p\"; echo disowned=$?".as_slice()));
	drive_idle(&mut shell, &mut host, &mut store);
	assert_eq!(host.stdout.bytes(), b"disowned=0\n");
	assert!(host.stderr.bytes().is_empty());
	assert!(
		store.get(Key::Proc(Vpid(1))).unwrap().is_none(),
		"a disowned child must not publish a completion"
	);
}

#[test]
fn a_real_legacy_owned_self_parent_restores_owned_with_a_diagnostic() {
	// Written and reloaded by unmodified 03f6cbc7 after a frameless 0 -> 1
	// root restore, an ordinary foreground spawn, and externalize at hold.
	let mut store =
		MemStore::from_bytes(include_bytes!("fixtures/frames/legacy-b73c-owned-self-parent.image"))
			.unwrap();
	let engine = Engine::new(EngineConfig { vpid_base: 1, ..EngineConfig::default() });
	let mut host = FakeHost::new();
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert!(report.lost.is_empty());
	assert_eq!(
		store.get(Key::Proc(Vpid(1))).unwrap(),
		Some(&Record::OwnedProc { parent: Some(Vpid(1)), status: None })
	);
	shell.complete(CallId(1), CallOutcome::Exit(0));
	drive_idle(&mut shell, &mut host, &mut store);
	assert_eq!(host.stdout.bytes(), b"owned=7\n");
	let warning = String::from_utf8_lossy(host.stderr.bytes().as_ref()).into_owned();
	assert!(warning.contains("process 1") && warning.contains("restoring as owned"), "{warning}");
}

#[test]
fn a_real_legacy_disowned_record_defaults_to_owned_instead_of_deleting_completion() {
	// No ownership tag exists in this 03f6cbc7 image. The kept status still
	// gives a direct wait its Bash-compatible 0; the process completion is
	// retained rather than interpreting its parent id as a disown marker.
	let mut store =
		MemStore::from_bytes(include_bytes!("fixtures/frames/legacy-b73c-disowned.image")).unwrap();
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let (mut shell, _) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	shell.complete(CallId(1), CallOutcome::Exit(0));
	drive_idle(&mut shell, &mut host, &mut store);
	let child = Vpid(EngineConfig::default().vpid_base + 1);
	assert_eq!(
		store.get(Key::Proc(child)).unwrap(),
		Some(&Record::OwnedProc {
			parent: Some(Vpid(EngineConfig::default().vpid_base)),
			status: Some(7),
		})
	);
	shell.submit(Script::command(b"wait \"$p\"; echo disowned=$?".as_slice()));
	drive_idle(&mut shell, &mut host, &mut store);
	assert_eq!(host.stdout.bytes(), b"disowned=0\n");
	let warning = String::from_utf8_lossy(host.stderr.bytes().as_ref()).into_owned();
	assert!(warning.contains("restoring as owned"), "{warning}");
}

#[test]
fn a_real_legacy_disown_all_exposes_completion_when_no_kept_status_exists() {
	// The real 03f6 reader reports 127 for this same image. Restoring its
	// untagged Proc as owned deliberately retains 7 rather than risking
	// deletion of an indistinguishable owned child's completion.
	let mut store =
		MemStore::from_bytes(include_bytes!("fixtures/frames/legacy-b73c-disown-all.image")).unwrap();
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert!(report.lost.is_empty());
	shell.complete(CallId(1), CallOutcome::Exit(0));
	drive_idle(&mut shell, &mut host, &mut store);
	shell.submit(Script::command(b"wait \"$p\"; echo disowned=$?".as_slice()));
	drive_idle(&mut shell, &mut host, &mut store);
	assert_eq!(host.stdout.bytes(), b"disowned=7\n");
	let warning = String::from_utf8_lossy(host.stderr.bytes().as_ref()).into_owned();
	assert!(warning.contains("restoring as owned"), "{warning}");
}

#[test]
fn resaving_a_legacy_owned_self_parent_makes_the_resolution_explicit() {
	let mut store =
		MemStore::from_bytes(include_bytes!("fixtures/frames/legacy-b73c-owned-self-parent.image"))
			.unwrap();
	let original = postcard::to_stdvec(store.get(Key::Proc(Vpid(1))).unwrap().unwrap()).unwrap();
	let engine = Engine::new(EngineConfig { vpid_base: 1, ..EngineConfig::default() });
	let mut first_host = FakeHost::new();
	let (mut shell, _) = Shell::restore(
		&engine,
		&mut Cx { host: &mut first_host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert!(matches!(
		shell.step(&mut Cx { host: &mut first_host, store: &mut store }, Budget::default()),
		Step::Blocked
	));
	assert!(
		first_host
			.events
			.iter()
			.any(|event| event.to_string().contains("restoring as owned"))
	);
	shell.control().request_suspend();
	assert!(matches!(
		shell.step(&mut Cx { host: &mut first_host, store: &mut store }, Budget::default()),
		Step::SuspendReady
	));
	shell
		.externalize(&mut Cx { host: &mut first_host, store: &mut store })
		.unwrap();
	let mut store = MemStore::from_bytes(&store.to_bytes()).unwrap();
	let saved = postcard::to_stdvec(store.get(Key::Proc(Vpid(1))).unwrap().unwrap()).unwrap();
	println!("legacy process bytes={original:?}, resaved process bytes={saved:?}");
	assert!(
		first_host
			.events
			.iter()
			.any(|event| event.to_string().contains("restoring as owned"))
	);
	let mut second_host = FakeHost::new();
	let (mut shell, _) = Shell::restore(
		&engine,
		&mut Cx { host: &mut second_host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert!(
		!second_host
			.events
			.iter()
			.any(|event| event.to_string().contains("restoring as owned")),
		"a tagged image must not emit a new ambiguity diagnostic"
	);
	shell.complete(CallId(1), CallOutcome::Exit(0));
	drive_idle(&mut shell, &mut second_host, &mut store);
	assert_eq!(second_host.stdout.bytes(), b"owned=7\n");
	assert!(
		!second_host
			.events
			.iter()
			.any(|event| event.to_string().contains("restoring as owned")),
		"executing a tagged image must not diagnose ownership again"
	);
	assert_eq!(
		String::from_utf8_lossy(second_host.stderr.bytes().as_ref())
			.matches("restoring as owned")
			.count(),
		1,
		"the one diagnostic queued before saving must still be delivered exactly once"
	);
}

fn drive_idle(shell: &mut Shell, host: &mut FakeHost, store: &mut MemStore) {
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host, store }, Budget::default()) {
			Step::Idle => return,
			Step::Done { .. } | Step::Yield => {},
			step => panic!("restored process must complete: {step:?}"),
		}
	}
	panic!("restored process did not become idle");
}
