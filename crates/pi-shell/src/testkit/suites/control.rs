//! Control, restore and store-failure behaviour of the shell.

use crate::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Incompatibility, Lost, MemStore, RestoreError, RestoreOpts,
		Script, Shell, SigTarget, Signal, StateStore, Step,
		ir::{IR_VERSION, Unit},
		store::{BlobSlot, Key, Record, Table},
	},
	testkit::{
		FakeHost, Fault, Rig,
		fault::skeleton_init,
		run::{Stop, advance},
	},
};

fn rig() -> Rig {
	Rig::new(FakeHost::new(), skeleton_init(&[]))
}

#[test]
fn cancel_kill_ends_every_run_and_the_shell_stays_usable() {
	let mut r = rig();
	let busy = r
		.shell()
		.submit(Script::command(&b"while true; do :; done"[..]));
	let small = Budget { max_ops: 50, max_ns: u64::MAX };
	let (shell, host, store) = r.parts();
	assert_eq!(advance(shell, host, store, busy, small), Stop::Yield);
	shell.control().cancel(Signal::Kill);
	assert_eq!(advance(shell, host, store, busy, small), Stop::Done(137));
	assert_eq!(r.run(Script::command(&b"echo after"[..]), Fault::None), 0);
	assert_eq!(r.host.stdout.bytes(), b"after\n");
}

#[test]
fn virtual_term_signal_to_all_kills_like_bash() {
	let mut r = rig();
	let id = r
		.shell()
		.submit(Script::command(&b"while :; do :; done"[..]));
	let small = Budget { max_ops: 10, max_ns: u64::MAX };
	let (shell, host, store) = r.parts();
	assert_eq!(advance(shell, host, store, id, small), Stop::Yield);
	shell.control().signal(SigTarget::All, Signal::Term);
	assert_eq!(advance(shell, host, store, id, small), Stop::Done(143));
}

#[test]
fn pause_holds_until_resume() {
	let mut r = rig();
	let id = r.shell().submit(Script::command(&b"echo a; echo b"[..]));
	let (shell, host, store) = r.parts();
	shell.control().pause();
	for _ in 0..3 {
		let step = shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default());
		assert!(matches!(step, Step::Paused));
	}
	assert!(host.stdout.bytes().is_empty(), "nothing runs while paused");
	shell.control().resume();
	assert_eq!(advance(shell, host, store, id, Budget::default()), Stop::Done(0));
	assert_eq!(host.stdout.bytes(), b"a\nb\n");
}

#[test]
fn root_state_persists_across_runs_and_snapshots() {
	let mut r = rig();
	r.run(Script::command(&b"x=1; y=keep"[..]), Fault::None);
	r.snapshot();
	r.run(Script::command(&b"x+=2; echo $x $y; false"[..]), Fault::None);
	r.snapshot();
	r.run(Script::command(&b"echo $?"[..]), Fault::None);
	assert_eq!(r.host.stdout.bytes(), b"12 keep\n1\n");
}

#[test]
fn subshell_runs_do_not_leak_into_the_root() {
	let mut r = rig();
	r.run(Script::command(&b"x=root"[..]), Fault::None);
	let sub = Script {
		vproc: crate::bash::VprocSel::NewSubshell,
		env: vec![("E".into(), "env".into())],
		args: Some(vec!["p1".into()]),
		..Script::command(&b"x=sub; echo $x $E $1"[..])
	};
	r.run(sub, Fault::Snapshot { every: 2 });
	r.run(Script::command(&b"echo $x $E $1"[..]), Fault::None);
	assert_eq!(r.host.stdout.bytes(), b"sub env p1\nroot\n");
}

#[test]
fn restore_rejects_corrupt_and_foreign_frames_and_can_drop_them() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	let id = shell.submit(Script::command(&b"for i in 1 2 3; do echo $i; done"[..]));
	assert_eq!(
		advance(&mut shell, &mut host, &mut store, id, Budget { max_ops: 4, max_ns: u64::MAX }),
		Stop::Yield
	);
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.unwrap();
	drop(shell);
	let mut blob = store.get_blob(BlobSlot::Frames).unwrap().unwrap();

	blob[0] ^= 0xff;
	store.put_blob(BlobSlot::Frames, &blob).unwrap();
	let err = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err();
	assert!(
		matches!(err, Some(RestoreError::Incompatible { why: Incompatibility::Magic })),
		"a foreign blob is refused: {err:?}"
	);

	blob[0] ^= 0xff;
	blob.truncate(blob.len() - 3);
	store.put_blob(BlobSlot::Frames, &blob).unwrap();
	let err = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.err();
	assert!(matches!(err, Some(RestoreError::Corrupt(_))), "a truncated blob is corrupt: {err:?}");

	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
		})
		.unwrap();
	assert_eq!(report.abandoned, [id], "the header still names the abandoned run");
	assert!(store.get_blob(BlobSlot::Frames).unwrap().is_none(), "restore consumes the blob");
	let next = shell.submit(Script::command(&b"echo fresh"[..]));
	assert_eq!(advance(&mut shell, &mut host, &mut store, id, Budget::default()), Stop::Done(255));
	assert_eq!(advance(&mut shell, &mut host, &mut store, next, Budget::default()), Stop::Done(0));
	assert!(host.stdout.bytes().ends_with(b"fresh\n"));
}

#[test]
fn restore_drop_frames_abandons_the_running_script_with_255() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	let id = shell.submit(Script::command(&b"while :; do :; done"[..]));
	assert_eq!(
		advance(&mut shell, &mut host, &mut store, id, Budget { max_ops: 9, max_ns: u64::MAX }),
		Stop::Yield
	);
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.unwrap();
	drop(shell);
	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
		})
		.unwrap();
	assert_eq!(report.abandoned, [id]);
	assert!(matches!(
		shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
		Step::Done { run, status: 255 } if run == id
	));
}

#[test]
fn a_root_only_restore_reports_a_function_body_it_cannot_read() {
	// A restore from the root store alone never reads the frames header,
	// where the IR version is checked. An older build's function body
	// then decodes as nothing this build knows and is recompiled from the
	// function's canonical text, which is alias-free and shorter than the
	// text it was defined from: `$LINENO` inside the function changes.
	// That must be reported, not read as a clean restore.
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	let id = shell.submit(Script::command(&b"\n\nf() {\n\techo $LINENO\n}\nf\n"[..]));
	assert_eq!(advance(&mut shell, &mut host, &mut store, id, Budget::default()), Stop::Done(0));
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.unwrap();
	drop(shell);
	store.del_blob(BlobSlot::Frames).unwrap();
	assert_eq!(host.stdout.bytes(), b"4\n", "the defined body keeps its own line numbers");

	// The store as this build wrote it: no body is lost.
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert!(
		!report.lost.iter().any(|l| matches!(l, Lost::Unit { .. })),
		"this build's own bodies are readable: {:?}",
		report.lost
	);
	let id = shell.submit(Script::command(&b"f"[..]));
	assert_eq!(advance(&mut shell, &mut host, &mut store, id, Budget::default()), Stop::Done(0));
	assert_eq!(host.stdout.bytes(), b"4\n4\n", "a readable body still reports line 4");
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.unwrap();
	drop(shell);
	store.del_blob(BlobSlot::Frames).unwrap();

	// The same store with that body written as an older build wrote it:
	// the unit alone, with no version in front of it.
	let mut found = None;
	store
		.scan(Table::Func, &mut |key, rec| {
			if let (Key::Func(name), Record::Func { unit, .. }) = (key, rec)
				&& &**name == b"f"
			{
				found = Some(*unit);
			}
		})
		.unwrap();
	let unit_id = found.expect("the store holds the function");
	let bytes = store.get_blob(BlobSlot::Unit(unit_id)).unwrap().unwrap();
	let (version, unit): (u32, Unit) = postcard::from_bytes(&bytes).unwrap();
	assert_eq!(version, IR_VERSION, "this build tags the blob it wrote");
	let old = postcard::to_stdvec(&unit).unwrap();
	store.put_blob(BlobSlot::Unit(unit_id), &old).unwrap();

	// A fresh engine, as a new process has: the body can only come from
	// the store, not from the engine's cache of this one.
	let engine = Engine::new(EngineConfig::default());
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert!(
		report
			.lost
			.contains(&Lost::Unit { unit: unit_id, found: None }),
		"the body this build cannot read is reported: {:?}",
		report.lost
	);
	let id = shell.submit(Script::command(&b"f"[..]));
	assert_eq!(advance(&mut shell, &mut host, &mut store, id, Budget::default()), Stop::Done(0));
	assert_eq!(
		host.stdout.bytes(),
		b"4\n4\n3\n",
		"the function still runs, from its canonical text, on the line that text puts it on"
	);
}
