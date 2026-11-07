//! A subshell's background jobs once the subshell exits. bash leaves them
//! running as orphans, and so does the engine by default; with
//! `EngineConfig::end_orphan_jobs` (a host's policy) the in-engine work of
//! an orphaned job (a native task, a shell loop, even one waiting on an
//! external) ends as a `TERM` would end it, while a job that is just an
//! external (`(server &)`) and a detached tree (`nohup`) run on.

use std::{
	io,
	sync::Arc,
	task::{Context, Poll, Waker},
};

use bstr::BString;
use parking_lot::Mutex;

use crate::{
	bash::{
		Budget, CallOutcome, Cx, EngineConfig, ExitStatus, ExtProc, Lineage, Script, ShellApi,
		Signal, SpawnSpec, Step,
	},
	testkit::{
		FakeHost, Rig,
		fault::skeleton_init,
		run::{Stop, advance},
	},
};

/// Label of the tree `detach` starts.
const LABEL: u32 = 7;

/// Signals the externals were sent, in order.
type Signals = Arc<Mutex<Vec<Signal>>>;

/// An external that runs until a signal ends it; records the signals.
struct Sleeper {
	signals: Signals,
	killed:  Option<Signal>,
	waker:   Option<Waker>,
}

impl ExtProc for Sleeper {
	fn pid(&self) -> u32 {
		77
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		if let Some(sig) = self.killed {
			Poll::Ready(ExitStatus::Signaled(sig))
		} else {
			self.waker = Some(cx.waker().clone());
			Poll::Pending
		}
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.signals.lock().push(sig);
		self.killed = Some(sig);
		if let Some(waker) = self.waker.take() {
			waker.wake();
		}
		Ok(())
	}

	fn stop(&mut self) -> io::Result<()> {
		Ok(())
	}

	fn cont(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// A rig with `end_orphan_jobs` as given. Every external is a [`Sleeper`]
/// recording into `signals`; the native `hold` runs until a signal ends it;
/// the callout `detach` starts its operands (`"$@"`) in a detached subshell
/// labeled [`LABEL`] and returns at once, as `nohup cmd &` leaves `cmd`.
fn rig(end_orphan_jobs: bool, signals: &Signals) -> Rig {
	let seen = Arc::clone(signals);
	let mut host = FakeHost::new().with_spawner(Box::new(move |_: SpawnSpec<'_>| {
		let sleeper = Sleeper { signals: Arc::clone(&seen), killed: None, waker: None };
		Ok(Box::new(sleeper) as Box<dyn ExtProc>)
	}));
	host.countdown("hold", u32::MAX, 0);
	host.tool(
		"detach",
		Arc::new(|api: &mut ShellApi<'_, '_>, argv: &[BString]| -> CallOutcome {
			let mut script = Script::command(&b"\"$@\""[..]);
			script.args = Some(argv[1..].to_vec());
			api.run_subshell_in(script, Lineage { label: LABEL, detached: true });
			CallOutcome::Exit(0)
		}),
	);
	let cfg = EngineConfig { end_orphan_jobs, ..EngineConfig::default() };
	Rig::with_config(host, skeleton_init(&[]), cfg)
}

/// Runs `src` as a root script; its status.
fn run(r: &mut Rig, src: &str) -> i32 {
	let (shell, host, store) = r.parts();
	let id = shell.submit(Script::command(src.as_bytes()));
	loop {
		match advance(shell, host, store, id, Budget::default()) {
			Stop::Done(status) => return status,
			Stop::Yield => {},
			Stop::Paused | Stop::Blocked => panic!("`{src}` stopped unexpectedly"),
		}
	}
}

/// Where the shell is after a run.
#[derive(Debug, PartialEq, Eq)]
enum Settled {
	/// Nothing left to run.
	Idle,
	/// Every vproc waits (on an external).
	Blocked,
	/// Work stayed runnable.
	Busy,
}

/// Steps the shell up to `steps` times (answering callouts): `Idle` or
/// `Blocked` as soon as it is, else `Busy`.
fn settle(r: &mut Rig, steps: u32) -> Settled {
	let (shell, host, store) = r.parts();
	for _ in 0..steps {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default()) {
			Step::Idle => return Settled::Idle,
			Step::Blocked => return Settled::Blocked,
			Step::Done { .. } | Step::Yield => {},
			Step::Call { id, call } => {
				let tool = host
					.tool_fn(call.tool)
					.expect("callout registered with the host");
				let mut cx = Cx { host: &mut *host, store: &mut *store };
				let outcome = {
					let mut api = shell.api(&mut cx, id).expect("call is outstanding");
					tool(&mut api, &call.argv)
				};
				shell.complete(id, outcome);
			},
			other => panic!("{other:?} after the run"),
		}
	}
	Settled::Busy
}

// Failure mode: a native task backgrounded in a subshell keeps running
// after the subshell (pi's `(yes > f &)`): no process for `pkill`, no job
// for `kill %N`.
#[test]
fn a_subshell_exit_ends_its_background_native_task() {
	let mut r = rig(true, &Signals::default());
	assert_eq!(run(&mut r, "(hold &)"), 0);
	assert_eq!(settle(&mut r, 1_000), Settled::Idle);
	assert_eq!(r.host.live_tasks(), 0);
}

// Failure mode: a backgrounded loop outlives its subshell and spins between
// commands for the life of the host.
#[test]
fn a_subshell_exit_ends_its_background_shell_loop() {
	let mut r = rig(true, &Signals::default());
	assert_eq!(run(&mut r, "(while :; do :; done &)"), 0);
	assert_eq!(settle(&mut r, 1_000), Settled::Idle);
}

// Failure mode: a loop that is waiting on an external when it is judged
// counts as the external's job and runs on, or ends without signalling the
// external.
#[test]
fn a_subshell_exit_ends_a_background_loop_waiting_on_an_external() {
	let signals = Signals::default();
	let mut r = rig(true, &signals);
	assert_eq!(run(&mut r, "(while :; do /x/sleeper; done &)"), 0);
	assert_eq!(settle(&mut r, 1_000), Settled::Idle);
	assert_eq!(r.host.live_externals(), 0);
	assert_eq!(*signals.lock(), [Signal::Term]);
}

// Failure mode: a job that is just its program (`(server >log 2>&1 &)`),
// or that runs builtins on the way to it, is ended with the subshell,
// where bash leaves the program running.
#[test]
fn a_background_job_that_is_just_an_external_outlives_its_subshell() {
	let signals = Signals::default();
	let mut r = rig(true, &signals);
	assert_eq!(run(&mut r, "(/x/sleeper &); (cd / && /x/sleeper &)"), 0);
	assert_eq!(settle(&mut r, 1_000), Settled::Blocked);
	assert_eq!(r.host.live_externals(), 2);
	assert!(signals.lock().is_empty(), "an external was signalled");
}

// Failure mode: ending an orphaned job also ends the jobs it started (a
// lone external among them), or leaves them unjudged once it is gone.
#[test]
fn a_nested_job_is_judged_on_its_own_when_its_parent_job_ends() {
	let signals = Signals::default();
	let mut r = rig(true, &signals);
	assert_eq!(run(&mut r, "( { /x/sleeper & while :; do :; done; } & )"), 0);
	assert_eq!(settle(&mut r, 1_000), Settled::Blocked);
	assert_eq!(r.host.live_externals(), 1);
	assert!(signals.lock().is_empty(), "an external was signalled");
}

// Failure mode: the tree a `nohup`-like callout detached is ended with the
// subshell that backgrounded the callout.
#[test]
fn a_detached_tree_outlives_its_subshell() {
	let mut r = rig(true, &Signals::default());
	assert_eq!(run(&mut r, "spin() { while :; do :; done; }; (detach spin &)"), 0);
	assert_eq!(settle(&mut r, 50), Settled::Busy);
	assert!(r.shell().label_live(LABEL), "the detached tree was ended");
}

// Failure mode: a restored shell no longer knows which jobs are orphans,
// and one that reaches a loop after the restore spins on.
#[test]
fn orphans_are_found_again_after_a_restore() {
	let mut r = rig(true, &Signals::default());
	assert_eq!(run(&mut r, "( { /x/sleeper; while :; do :; done; } & )"), 0);
	assert_eq!(settle(&mut r, 1_000), Settled::Blocked);
	// The external is lost: the job goes on to its loop.
	r.snapshot();
	assert_eq!(settle(&mut r, 1_000), Settled::Idle);
}

// Failure mode: the default engine (bash's behavior, obash) ends orphaned
// jobs.
#[test]
fn without_the_knob_orphaned_jobs_run_on() {
	let mut r = rig(false, &Signals::default());
	assert_eq!(run(&mut r, "(hold &)"), 0);
	assert_eq!(settle(&mut r, 50), Settled::Busy);
	assert_eq!(r.host.live_tasks(), 1);
	let mut r = rig(false, &Signals::default());
	assert_eq!(run(&mut r, "(while :; do :; done &)"), 0);
	assert_eq!(settle(&mut r, 50), Settled::Busy);
}
