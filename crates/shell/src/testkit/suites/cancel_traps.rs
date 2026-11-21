//! `cancel` at many safepoints of a shell with traps, background vprocs and
//! native tasks in flight (cancel with TERM, KILL or INT at a random
//! safepoint): which traps ran, the exit status, and no leaked vprocs or
//! tasks. Goldens from bash 5.3.20 sent the same OS signal (`kill -TERM`
//! from outside) where bash has an analogue:
//!
//! - an EXIT trap runs when bash dies of an untrapped TERM (status 143);
//! - `exit N` in the TERM trap exits N, after the EXIT trap.
//!
//! A TERM trap that returns normally makes bash carry on; `cancel(TERM)`
//! instead ends the shell after it ("traps run, then unwind"),
//! with the status of a TERM death, 143.

use bstr::BStr;

use crate::{
	bash::{Budget, Script, Signal, store::Key},
	testkit::{
		FakeHost, Rig,
		fault::skeleton_init,
		run::{Stop, advance},
	},
};

/// Function depth 3, a busy background vproc, and native tasks in the
/// foreground (`hold` in `f3`'s loop) and in the background.
const BUSY: &[u8] = b"f1() { f2; }; f2() { f3; }; f3() { while :; do hold; :; done; }\n{ while :; \
                      do :; done; } &\n{ hold; } &\nf1\n";

/// Op counts at which the cancel arrives.
const AT: [u32; 8] = [1, 2, 7, 31, 97, 333, 1_000, 5_000];

/// Run `traps` and then [`BUSY`] as one script, as the bash goldens do (an
/// earlier root run's EXIT trap fires and is consumed at that run's end);
/// once the traps are in place, run `at` more ops, cancel with `sig`,
/// finish; the status, the stdout, and the tasks alive at the cancel.
fn cancel_at(traps: &[u8], sig: Signal, at: u32) -> (i32, String, usize) {
	let mut host = FakeHost::new();
	// Pending for a million polls: only a cancel ends it.
	host.countdown("hold", 1_000_000, 0);
	let mut rig = Rig::new(host, skeleton_init(&[]));
	let id = rig
		.shell()
		.submit(Script::command([traps, b"\nREADY=1\n", BUSY].concat()));
	let (shell, host, store) = rig.parts();
	let one = Budget { max_ops: 1, max_ns: u64::MAX };
	while store.record(Key::Var(BStr::new("READY"))).is_none() {
		assert_eq!(advance(shell, host, store, id, one), Stop::Yield, "installing traps");
	}
	let small = Budget { max_ops: at, max_ns: u64::MAX };
	assert_eq!(advance(shell, host, store, id, small), Stop::Yield, "busy until cancelled");
	let in_flight = host.live_tasks();
	shell.control().cancel(sig);
	let status = loop {
		match advance(shell, host, store, id, Budget::default()) {
			Stop::Done(status) => break status,
			Stop::Yield => {},
			other => panic!("unexpected {other:?} after cancel({sig:?}) at {at}"),
		}
	};
	host.assert_no_leaks(shell, store);
	let out = String::from_utf8_lossy_owned(host.stdout.bytes());
	(status, out, in_flight)
}

#[test]
fn cancel_term_runs_the_term_trap_once_and_ends_with_143_at_every_safepoint() {
	for at in AT {
		let (status, out, tasks) = cancel_at(b"trap 'echo trapped' TERM", Signal::Term, at);
		assert_eq!((status, out.as_str()), (143, "trapped\n"), "cancel at op {at}");
		if at >= 1_000 {
			assert!(tasks >= 1, "a task is in flight at op {at}");
		}
	}
}

#[test]
fn cancel_kill_runs_no_trap_and_ends_with_137_at_every_safepoint() {
	for at in AT {
		let (status, out, _) =
			cancel_at(b"trap 'echo trapped' TERM; trap 'echo exiting' EXIT", Signal::Kill, at);
		assert_eq!((status, out.as_str()), (137, ""), "cancel at op {at}");
	}
}

#[test]
fn cancel_int_without_a_trap_ends_with_130() {
	for at in AT {
		let (status, out, _) = cancel_at(b"trap 'echo trapped' TERM", Signal::Int, at);
		assert_eq!((status, out.as_str()), (130, ""), "cancel at op {at}");
	}
}

/// bash: `trap 'echo t; exit 3' TERM; trap 'echo e' EXIT; f(){ while :; do
/// :; done; }; f` killed with TERM prints `t`, `e` and exits 3.
#[test]
fn cancel_term_honours_exit_in_the_term_trap_and_runs_the_exit_trap() {
	for at in AT {
		let (status, out, _) =
			cancel_at(b"trap 'echo trapped; exit 3' TERM; trap 'echo exiting' EXIT", Signal::Term, at);
		assert_eq!((status, out.as_str()), (3, "trapped\nexiting\n"), "cancel at op {at}");
	}
}

/// bash: `trap 'echo e' EXIT; f(){ while :; do :; done; }; f` killed with
/// TERM prints `e` and dies of the signal (143).
#[test]
fn cancel_term_without_a_term_trap_still_runs_the_exit_trap() {
	for at in AT {
		let (status, out, _) = cancel_at(b"trap 'echo exiting' EXIT", Signal::Term, at);
		assert_eq!((status, out.as_str()), (143, "exiting\n"), "cancel at op {at}");
	}
}
