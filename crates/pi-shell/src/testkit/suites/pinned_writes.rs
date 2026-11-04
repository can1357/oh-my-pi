//! A diagnostic written while a redirection was in force stays bound to that
//! redirection's file after the redirection ends ([`PendingWrite::pin`]). A
//! snapshot taken while such a write still waits on a host file must name the
//! file as lost, as it does for a descriptor slot holding one; otherwise a
//! restore claims nothing was lost and the rest of the diagnostic is dropped.
//!
//! [`PendingWrite::pin`]: crate::bash::vm::proc::PendingWrite

use crate::{
	bash::{
		Budget, Cx, Engine, EngineConfig, FileKind, Lost, MemStore, RestoreOpts, Script, Shell,
		ShellApi, Step,
	},
	testkit::{
		fault::skeleton_init,
		host::FakeHost,
		run::{Stop, advance},
	},
};

#[test]
fn a_snapshot_names_a_host_file_a_pending_diagnostic_is_bound_to_as_lost() {
	let mut host = FakeHost::new();
	host.fs.add_stalled_fifo("/tmp/p");
	let mut store = MemStore::new();
	let engine = Engine::new(EngineConfig::default());
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.expect("create");
	let id =
		shell.submit(Script::command(&br#"{ : "${missing:?BOOM}"; } 2>/tmp/p & echo started"#[..]));
	assert_eq!(advance(&mut shell, &mut host, &mut store, id, Budget::default()), Stop::Done(0));
	assert_eq!(host.stdout.bytes(), b"started\n");
	// The run ends before the background job is scheduled: step until it
	// waits on its write to the FIFO.
	for _ in 0..1000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Blocked | Step::Idle => break,
			Step::Yield | Step::Done { .. } => {},
			_ => panic!("the background job stopped on something other than its write"),
		}
	}

	let lost_pipe = |lost: &[Lost]| {
		lost
			.iter()
			.any(|l| matches!(l, Lost::Fd { fd: 2, kind: FileKind::Pipe, .. }))
	};
	let report = shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.expect("externalize");
	assert!(lost_pipe(&report.lost), "the snapshot names the FIFO as lost: {:?}", report.lost);
	drop(shell);

	let engine = Engine::new(EngineConfig::default());
	let (_shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut FakeHost::new(), store: &mut store },
		RestoreOpts::default(),
	)
	.expect("restore");
	assert!(lost_pipe(&report.lost), "the restore names the FIFO as lost: {:?}", report.lost);
}
