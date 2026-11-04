//! The cancel gate with real processes, end to end through the
//! engine's cancel path: a [`Shell`] over a [`FakeHost`] whose externals come
//! from a [`NativeSpawner`] runs `/bin/sh` jobs with grandchildren; the host
//! calls `cancel(TERM)`; the engine signals each external and drops it while
//! unwinding, and the spawner's abandon escalation (sys S3) does the rest.
//!
//! With the default [`SpawnConfig`] ([`Sessions::Detach`]) every external
//! leads its own session, so:
//! - TERM reaches the whole group (child and grandchildren) at once: a group
//!   that does not ignore TERM is gone well inside the grace;
//! - a group that ignores TERM is killed once the grace
//!   ([`SpawnConfig::DEFAULT_GRACE`], 2 s) is over, including a grandchild that
//!   outlived its leader (the session sweep);
//! - afterwards nothing is left: the spawner's leftovers and a process-table
//!   scan of the session are empty, and the idle shell holds no external handle
//!   ([`FakeHost::assert_no_leaks`]).
//!
//! Under [`Sessions::Inherit`] (`obash`, a standalone shell) externals stay
//! in the host's process group, so the same cancel reaches only the
//! external's own pid: TERM at once, KILL after the grace; its children are
//! outside the engine's reach, as they are outside bash's.
//!
//! Run: `cango test -p pi-shell --lib sys::suites::cancel_externals --
//! --nocapture --test-threads 1`. Each test prints its measured times.

#![cfg(unix)]

use std::{
	thread,
	time::{Duration, Instant},
};

use bstr::ByteSlice;

use crate::{
	bash::{Budget, Cx, Engine, EngineConfig, MemStore, RunId, Script, Shell, Signal, SpawnSpec},
	sys::{
		NativeSpawner, Sessions, SpawnConfig,
		proc::{self, ProcInfo, ProcState},
	},
	testkit::{
		FakeHost,
		fault::skeleton_init,
		run::{Stop, advance, advance_or_blocked},
	},
};

const LONG: Duration = Duration::from_secs(20);

/// Well inside the grace: what "at once" must beat.
const PROMPT: Duration = Duration::from_secs(1);

/// Poll `cond` until it holds; the elapsed time.
fn until(what: &str, mut cond: impl FnMut() -> bool) -> Duration {
	let start = Instant::now();
	while !cond() {
		assert!(start.elapsed() < LONG, "timed out waiting for {what}");
		thread::sleep(Duration::from_millis(5));
	}
	start.elapsed()
}

/// Exited (a zombie counts) or gone.
fn gone(pid: i32) -> bool {
	proc::info(pid).is_none_or(|i| i.state == ProcState::Zombie)
}

/// Live (non-zombie) members of session `sid`.
fn live_session(sid: i32) -> Vec<ProcInfo> {
	let mut m = proc::session_members(sid).unwrap();
	m.retain(|p| p.state != ProcState::Zombie);
	m
}

/// Kills what a case left behind, even when it fails: the spawner's
/// leftovers and the stray processes it registered.
struct Cleanup {
	spawner: NativeSpawner,
	strays:  Vec<ProcInfo>,
}

impl Drop for Cleanup {
	fn drop(&mut self) {
		let _ = self.spawner.kill_leftovers();
		for p in &self.strays {
			let _ = proc::signal_pinned(p, Signal::Kill);
		}
	}
}

/// A shell running `src`, stopped while it waits for its external.
struct Case {
	shell:   Shell,
	host:    FakeHost,
	store:   MemStore,
	run:     RunId,
	cleanup: Cleanup,
}

impl Case {
	/// Start `src` under `sessions` with the default grace; returns once the
	/// shell is blocked on the external and the spawner's scopes hold
	/// `procs` processes, `sleeps` of them already `sleep`.
	fn start(sessions: Sessions, src: &str, procs: usize, sleeps: usize) -> Self {
		let spawner = NativeSpawner::new(SpawnConfig { sessions, ..SpawnConfig::default() });
		let hook = spawner.clone();
		let mut host =
			FakeHost::new().with_spawner(Box::new(move |spec: SpawnSpec<'_>| hook.spawn(spec)));
		let mut store = MemStore::new();
		let engine = Engine::new(EngineConfig::default());
		let mut shell =
			Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
				.unwrap();
		let run = shell.submit(Script::command(src.as_bytes().to_vec()));
		loop {
			match advance_or_blocked(&mut shell, &mut host, &mut store, run, Budget::default()) {
				Stop::Blocked => break,
				Stop::Yield => {},
				other => panic!("{other:?} before the external ran"),
			}
		}
		assert_eq!(host.live_externals(), 1, "the shell waits for one external");
		until("the job's processes", || {
			let left = spawner.leftovers().unwrap();
			left.len() == procs && left.iter().filter(|l| l.name == "sleep").count() == sleeps
		});
		Self { shell, host, store, run, cleanup: Cleanup { spawner, strays: Vec::new() } }
	}

	/// The external's pid (its session and group under `Detach`).
	fn leader(&self) -> i32 {
		let left = self.cleanup.spawner.leftovers().unwrap();
		left
			.iter()
			.find(|l| l.pid == l.group)
			.map(|l| l.pid as i32)
			.expect("the external leads its scope")
	}

	/// `cancel(TERM)` and step to the run's end: its status, the time from
	/// the cancel to `Done`, and the instant of the cancel. The shell is
	/// then checked for leaked vprocs and external handles.
	fn cancel(&mut self) -> (i32, Duration, Instant) {
		let t0 = Instant::now();
		self.shell.control().cancel(Signal::Term);
		let status = loop {
			let (shell, host, store) = (&mut self.shell, &mut self.host, &mut self.store);
			match advance(shell, host, store, self.run, Budget::default()) {
				Stop::Done(status) => break status,
				Stop::Yield => {},
				other => panic!("unexpected {other:?} after cancel"),
			}
		};
		let done = t0.elapsed();
		self.host.assert_no_leaks(&mut self.shell, &mut self.store);
		(status, done, t0)
	}

	fn stdout(&self) -> String {
		self.host.stdout.bytes().to_str_lossy().into_owned()
	}

	/// Nothing is left in the spawner's scopes or in session `sid`.
	fn assert_clean(&self, sid: i32) {
		until("no leftovers", || self.cleanup.spawner.leftovers().unwrap().is_empty());
		assert!(live_session(sid).is_empty(), "session {sid}: {:?}", live_session(sid));
	}
}

/// Check the TERM-ignoring group of `case` (`procs` processes in session
/// `sid`) survives half the grace and is gone after it.
fn assert_killed_after_the_grace(case: &Case, sid: i32, procs: usize, t0: Instant) -> Duration {
	let grace = SpawnConfig::DEFAULT_GRACE;
	thread::sleep((grace / 2).saturating_sub(t0.elapsed()));
	assert_eq!(live_session(sid).len(), procs, "TERM is ignored and KILL waits for the grace");
	until("the group killed", || live_session(sid).is_empty());
	let killed = t0.elapsed();
	assert!(killed >= grace, "KILL before the grace: {killed:?}");
	assert!(killed < grace + PROMPT, "KILL late: {killed:?}");
	case.assert_clean(sid);
	killed
}

#[test]
fn cancel_term_reaches_the_externals_whole_group_at_once() {
	// `sh` does not forward TERM to its children: they die only if the
	// signal goes to the group.
	let mut case =
		Case::start(Sessions::Detach, "/bin/sh -c '/bin/sleep 30 & /bin/sleep 30; wait'", 3, 2);
	let sid = case.leader();
	let (status, done, t0) = case.cancel();
	assert_eq!(status, 143);
	until("the group terminated", || live_session(sid).is_empty());
	let term = t0.elapsed();
	eprintln!("detach, TERM honoured: cancel→Done {done:?}, cancel→group gone {term:?}");
	assert!(term < PROMPT, "TERM did not reach the group at once: {term:?}");
	case.assert_clean(sid);
}

#[test]
fn cancel_term_kills_a_group_ignoring_term_after_the_default_grace() {
	let mut case = Case::start(
		Sessions::Detach,
		"/bin/sh -c 'trap \"\" TERM; /bin/sleep 30 & /bin/sleep 30; wait'",
		3,
		2,
	);
	let sid = case.leader();
	let (status, done, t0) = case.cancel();
	assert_eq!(status, 143);
	let killed = assert_killed_after_the_grace(&case, sid, 3, t0);
	eprintln!("detach, TERM ignored: cancel→Done {done:?}, cancel→group killed {killed:?}");
}

/// The shell's own TERM trap runs once; the external still gets TERM at
/// once (it ignores it) and KILL after the grace.
#[test]
fn cancel_term_with_a_shell_trap_runs_it_and_still_kills_the_external_group() {
	let mut case = Case::start(
		Sessions::Detach,
		"trap 'echo trapped' TERM\n/bin/sh -c 'trap \"\" TERM; /bin/sleep 30 & /bin/sleep 30; wait'",
		3,
		2,
	);
	let sid = case.leader();
	let (status, done, t0) = case.cancel();
	assert_eq!(status, 143);
	assert_eq!(case.stdout(), "trapped\n", "the trap runs exactly once");
	let killed = assert_killed_after_the_grace(&case, sid, 3, t0);
	eprintln!("detach, shell trap: cancel→Done {done:?}, cancel→group killed {killed:?}");
}

/// The leader dies of TERM at once; its grandchild ignores TERM, outlives
/// it, and is swept from the session when the grace is over.
#[test]
fn cancel_term_sweeps_a_grandchild_that_outlives_its_leader() {
	let mut case = Case::start(
		Sessions::Detach,
		"/bin/sh -c '(trap \"\" TERM; exec /bin/sleep 30) & wait'",
		2,
		1,
	);
	let sid = case.leader();
	let (status, done, t0) = case.cancel();
	assert_eq!(status, 143);
	let leader = until("the leader terminated", || gone(sid));
	assert!(t0.elapsed() < PROMPT, "TERM did not reach the leader at once: {leader:?}");
	let killed = assert_killed_after_the_grace(&case, sid, 1, t0);
	eprintln!(
		"detach, orphaned grandchild: cancel→Done {done:?}, leader gone {leader:?}, grandchild \
		 killed {killed:?}"
	);
}

/// `obash`'s layout: the external shares the host's group, so cancel reaches
/// its pid only (TERM at once, KILL after the grace) and its children
/// survive it.
#[test]
fn inherit_cancel_reaches_only_the_external_itself() {
	let mut case = Case::start(
		Sessions::Inherit,
		"/bin/sh -c 'trap \"\" TERM; /bin/sleep 30 & /bin/sleep 30; wait'",
		1,
		0,
	);
	let pid = case.leader();
	let mut children = Vec::new();
	until("both sleeps started", || {
		children = proc::list()
			.unwrap()
			.into_iter()
			.filter(|p| p.ppid == pid && p.name == "sleep")
			.collect();
		children.len() == 2
	});
	case.cleanup.strays.clone_from(&children);
	let (status, done, t0) = case.cancel();
	assert_eq!(status, 143);
	let grace = SpawnConfig::DEFAULT_GRACE;
	thread::sleep((grace / 2).saturating_sub(t0.elapsed()));
	assert!(!gone(pid), "TERM is ignored and KILL waits for the grace");
	until("the external killed", || gone(pid));
	let killed = t0.elapsed();
	assert!(killed >= grace && killed < grace + PROMPT, "KILL at {killed:?}");
	until("no leftovers", || case.cleanup.spawner.leftovers().unwrap().is_empty());
	for child in &children {
		assert!(!gone(child.pid), "the external's children are outside the cancel's reach");
	}
	for child in &children {
		assert!(proc::signal_pinned(child, Signal::Kill).unwrap());
	}
	until("the children gone", || children.iter().all(|c| gone(c.pid)));
	eprintln!("inherit: cancel→Done {done:?}, cancel→external killed {killed:?}");
}
