//! Signal parsing and `kill` behavior at the virtual-process boundary.

use crate::{
	bash::{Platform, SigSet, Signal},
	testkit::{FakeHost, Fault, run_script},
};

#[test]
fn signal_specs_follow_the_configured_platform() {
	assert_eq!(Signal::parse_spec(b"SIGUSR1", Platform::Linux), Some(Signal::Usr1));
	assert_eq!(Signal::parse_spec(b"10", Platform::Linux), Some(Signal::Usr1));
	assert_eq!(Signal::parse_spec(b"30", Platform::MacOs), Some(Signal::Usr1));
	assert_eq!(Signal::parse_spec(b"10", Platform::MacOs), Some(Signal::Bus));
	assert_eq!(Signal::parse_spec(b"sigusr1", Platform::MacOs), Some(Signal::Usr1));
	assert_eq!(Signal::parse_spec(b"EMT", Platform::MacOs), Some(Signal::Emt));
	assert_eq!(Signal::parse_spec(b"EMT", Platform::Linux), None);
	assert_eq!(Signal::parse_spec(b"STKFLT", Platform::Linux), Some(Signal::Stkflt));
	assert_eq!(Signal::parse_spec(b"STKFLT", Platform::MacOs), None);
	assert_eq!(Signal::parse_spec(b"0", Platform::Linux), None);
	assert_eq!(Signal::parse_spec(b"BOGUS", Platform::Linux), None);
}

#[test]
fn realtime_names_numbers_and_sets_are_platform_specific() {
	for n in 34..=64 {
		let signal = Signal::from_number(n, Platform::Linux).unwrap();
		assert_eq!(signal.number(Platform::Linux), n);
		assert_eq!(
			Signal::parse_spec(format!("RTMIN+{}", n - 34).as_bytes(), Platform::Linux),
			Some(signal)
		);
		assert_eq!(
			Signal::parse_spec(format!("SIGRTMAX-{}", 64 - n).as_bytes(), Platform::Linux),
			Some(signal)
		);
		assert_eq!(Signal::from_number(n, Platform::MacOs), None);
	}
	assert_eq!(Signal::parse_spec(b"RTMIN+31", Platform::Linux), None);
	assert_eq!(Signal::parse_spec(b"RTMAX-31", Platform::Linux), None);
	assert_eq!(Signal::parse_spec(b"RTMAX", Platform::MacOs), None);
	assert_eq!(Signal::parse_spec(b"RTMIN", Platform::Windows), None);
	let set = SigSet::EMPTY.with(Signal::Rtmin).with(Signal::Rtmax);
	assert!(set.contains(Signal::Rtmin));
	assert!(set.contains(Signal::Rtmax));
	assert!(!set.without(Signal::Rtmax).contains(Signal::Rtmax));
}

#[cfg(target_os = "linux")]
#[test]
fn realtime_kill_lists_and_delivers_on_virtual_bus() {
	// Bash 5.2.21 and 5.3.0 reject RTMAX-30: initialize_signames builds
	// only canonical offsets, so this is not a signal name. Measurements:
	// /mnt/durable/sami/Port17678/c-r5/oracles.jsonl,
	// F6-list-noncanonical-RTMAX. F6-s-RTMIN and F6-list-RTMAX also verify
	// accepted offsets at both ends.
	let result = run_script(
		FakeHost::new(),
		b"trap 'echo trapped' RTMAX; kill -s RTMIN+30 $$; kill -l 64; kill -l RTMAX-30",
		&[],
		Fault::None,
	);
	assert_eq!(result.stdout, b"trapped\nRTMAX\n");
	assert_eq!(result.status, 1);
}

#[test]
fn kill_checks_self_and_rejects_bad_targets_and_signals() {
	let result = run_script(
		FakeHost::new(),
		b"kill -0 $$; echo $?; kill -BOGUS $$; echo $?; kill -0 not-a-pid; echo $?",
		&[],
		Fault::None,
	);
	assert_eq!(result.stdout, b"0\n1\n1\n");
	assert_eq!(result.status, 0);
}

#[test]
fn kill_accepts_attached_signal_options() {
	let result = run_script(FakeHost::new(), b"trap 'echo term' TERM; kill -sTERM $$; kill -n15 $$; kill -nBAD $$; echo $?; kill -sBAD $$; echo $?", &[], Fault::None);
	assert_eq!(result.stdout, b"term\nterm\n1\n1\n");
	assert_eq!(result.status, 0);
}

#[test]
fn kill_lists_signal_names_and_exit_statuses() {
	let result =
		run_script(FakeHost::new(), b"kill -l TERM; kill -l 15; kill -l 143", &[], Fault::None);
	assert_eq!(result.stdout, b"15\nTERM\nTERM\n");
	assert_eq!(result.status, 0);
}

#[test]
fn kill_numbered_job_terminates_its_pipeline_after_snapshot() {
	for fault in [Fault::None, Fault::Snapshot { every: 17 }] {
		let mut host = FakeHost::new();
		host.countdown("hold", 10_000, 0);
		host.countdown("delay", 4, 0);
		let result = run_script(
			host,
			b"hold | hold & p=$!; delay; kill -KILL %1; wait \"$p\"; echo status=$?",
			&[],
			fault,
		);
		assert_eq!(result.stdout, b"status=137\n", "{fault:?}");
		assert_eq!(result.status, 0, "{fault:?}");
	}
}

#[test]
fn kill_signals_root_from_a_background_vproc() {
	let result = run_script(
		FakeHost::new(),
		b"trap 'echo trapped' USR1; (kill -s USR1 $$) & wait; echo done",
		&[],
		Fault::None,
	);
	assert_eq!(result.stdout, b"trapped\ndone\n");
	assert_eq!(result.status, 0);
}

#[test]
fn snapshots_report_externals_that_outlived_their_shell() {
	use std::{
		io,
		task::{Context, Poll},
	};

	use crate::{
		bash::{
			Budget, Cx, Engine, EngineConfig, ExitStatus, ExtProc, MemStore, Script, Shell, Signal,
			SpawnSpec, Step,
			snapshot::{Lost, RestoreOpts},
		},
		testkit::{Rig, fault::skeleton_init},
	};

	struct PendingExternal;
	impl ExtProc for PendingExternal {
		fn poll_wait(&mut self, _: &mut Context<'_>) -> Poll<ExitStatus> {
			Poll::Pending
		}

		fn pid(&self) -> u32 {
			77
		}

		fn signal(&mut self, signal: Signal) -> io::Result<()> {
			panic!("the foreground program was not targeted: {signal}");
		}

		fn stop(&mut self) -> io::Result<()> {
			Ok(())
		}

		fn cont(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let host = FakeHost::new()
		.with_spawner(Box::new(|_: SpawnSpec<'_>| Ok(Box::new(PendingExternal) as Box<dyn ExtProc>)));
	let mut rig = Rig::new(host, skeleton_init(&[]));
	assert_eq!(
		rig.run(
			Script::command(b"f(){ /x/sleeper; echo unreachable; }; f & echo $!".to_vec()),
			Fault::None
		),
		0
	);
	let printed_pid = rig.host.stdout.bytes();
	let owner = std::str::from_utf8(&printed_pid)
		.unwrap()
		.trim()
		.parse::<u32>()
		.unwrap();
	let budget = Budget { max_ops: 1, max_ns: u64::MAX };
	for _ in 0..200 {
		if rig.host.live_externals() != 0 {
			break;
		}
		let (shell, host, store) = rig.parts();
		shell.step(&mut Cx { host, store }, budget);
	}
	assert_eq!(rig.host.live_externals(), 1, "the real VM must own a pending external");
	assert_eq!(rig.run(Script::command(b"kill -KILL %1; wait %1".to_vec()), Fault::None), 137);
	assert_eq!(rig.host.live_externals(), 1, "killing only its shell must retain the handle");
	{
		let (shell, host, store) = rig.parts();
		let mut cx = Cx { host, store };
		shell.control().request_suspend();
		assert!(matches!(shell.step(&mut cx, budget), Step::SuspendReady));
		let report = shell.externalize(&mut cx).unwrap();
		assert!(
			matches!(report.lost.as_slice(), [Lost::Ext { pid: 77, vpid }] if vpid.0 == owner),
			"{:?}",
			report.lost
		);
	}
	let bytes = rig.store.to_bytes();
	let mut store = MemStore::from_bytes(&bytes).unwrap();
	let engine = Engine::new(EngineConfig::default());
	let (_, host, _) = rig.parts();
	let (_, report) =
		Shell::restore(&engine, &mut Cx { host, store: &mut store }, RestoreOpts::default()).unwrap();
	// The owner frame is gone. Frames v3 carries no survivor metadata, so
	// restore reports only frame-backed losses, not this externalize loss.
	assert!(report.lost.is_empty(), "{:?}", report.lost);
}
