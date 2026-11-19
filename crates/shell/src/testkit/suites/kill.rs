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
	let result = run_script(
		FakeHost::new(),
		b"trap 'echo trapped' RTMAX; kill -s RTMIN+30 $$; kill -l 64; kill -l RTMAX-30",
		&[],
		Fault::None,
	);
	assert_eq!(result.stdout, b"trapped\nRTMAX\n34\n");
	assert_eq!(result.status, 0);
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
