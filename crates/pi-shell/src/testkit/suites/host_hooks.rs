//! Hooks an embedding host relies on: pipe taps (`Host::pipe_tap`), which
//! root runs `exit` ended (`Shell::ended_by_exit`), the count of
//! background jobs still running an external (`Shell::live_external_jobs`),
//! the `umask` native tasks and callouts start with, and a
//! [`Host::spawn`](crate::bash::Host::spawn) future that stays pending (the
//! shell goes on, a cancel or snapshot drops it and spawns nothing).

use std::{
	future::Future,
	io,
	pin::Pin,
	sync::Arc,
	task::{Context, Poll, Waker},
};

use bstr::{BStr, BString};
use parking_lot::Mutex;

use crate::{
	bash::{
		Budget, CallOutcome, Cx, ExitStatus, ExtProc, PipeMirror, PipeTap, Script, ShellApi, Signal,
		SpawnFuture, SpawnSpec, Step,
	},
	testkit::{
		FakeHost, Rig,
		fault::skeleton_init,
		run::{Stop, advance, wait_runnable},
	},
};

/// Runs `src` as a root script; its status and whether `exit` ended it.
fn run(r: &mut Rig, src: &str) -> (i32, bool) {
	let (shell, host, store) = r.parts();
	let id = shell.submit(Script::command(src.as_bytes()));
	loop {
		match advance(shell, host, store, id, Budget::default()) {
			Stop::Done(status) => return (status, shell.ended_by_exit(id)),
			Stop::Yield => {},
			Stop::Paused | Stop::Blocked => panic!("`{src}` stopped unexpectedly"),
		}
	}
}

#[derive(Default)]
struct Recorder {
	streams: Mutex<Vec<Arc<Stream>>>,
}

struct Stream {
	producer: String,
	consumer: String,
	/// Bytes mirrored, and whether the pipe was closed.
	state:    Mutex<(Vec<u8>, bool)>,
}

impl PipeTap for Recorder {
	fn open(&self, producer: &BStr, consumer: &BStr) -> Option<Arc<dyn PipeMirror>> {
		let stream = Arc::new(Stream {
			producer: producer.to_string(),
			consumer: consumer.to_string(),
			state:    Mutex::new((Vec::new(), false)),
		});
		self.streams.lock().push(Arc::clone(&stream));
		Some(stream)
	}
}

impl PipeMirror for Stream {
	fn write(&self, bytes: &[u8]) {
		let mut state = self.state.lock();
		assert!(!state.1, "write after close");
		state.0.extend_from_slice(bytes);
	}

	fn close(&self) {
		let mut state = self.state.lock();
		assert!(!state.1, "closed twice");
		state.1 = true;
	}
}

// Failure mode: a tapped pipeline loses or duplicates bytes, names the wrong
// stages, or leaves its stream open after the pipeline ended.
#[test]
fn a_pipe_tap_mirrors_each_pipe_between_stages() {
	let recorder = Arc::new(Recorder::default());
	let host = FakeHost::new().with_pipe_tap(Arc::clone(&recorder) as Arc<dyn PipeTap>);
	let mut r = Rig::new(host, skeleton_init(&[]));
	let (status, _) = run(
		&mut r,
		"printf 'a\\nb\\n' | while read -r l; do echo \"<$l>\"; done | { read -r x; read -r y; }",
	);
	assert_eq!(status, 0);
	let streams = recorder.streams.lock();
	assert_eq!(streams.len(), 2, "one stream per pipe");
	assert!(streams[0].producer.starts_with("printf"), "{}", streams[0].producer);
	assert!(streams[0].consumer.starts_with("while"), "{}", streams[0].consumer);
	assert!(streams[1].producer.starts_with("while"), "{}", streams[1].producer);
	assert!(streams[1].consumer.starts_with("{ read"), "{}", streams[1].consumer);
	assert_eq!(*streams[0].state.lock(), (b"a\nb\n".to_vec(), true));
	assert_eq!(*streams[1].state.lock(), (b"<a>\n<b>\n".to_vec(), true));
}

// Failure mode: a host running a command as several root scripts cannot tell
// `exit` (stop here) from reaching the end, or a subshell's `exit` reads as
// the shell's.
#[test]
fn ended_by_exit_names_root_runs_that_exit_or_errexit_ended() {
	let mut r = Rig::new(FakeHost::new(), skeleton_init(&[]));
	assert_eq!(run(&mut r, "true"), (0, false));
	assert_eq!(run(&mut r, "exit 3"), (3, true));
	assert_eq!(run(&mut r, "f() { exit 4; }; f"), (4, true));
	assert_eq!(run(&mut r, "(exit 5)"), (5, false));
	assert_eq!(run(&mut r, "x=$(exit 6); echo \"$x\""), (0, false));
	assert_eq!(run(&mut r, "set -e; false; true"), (1, true));
	assert_eq!(run(&mut r, "false || true"), (0, false));
}

/// An external that runs until a signal ends it.
struct Sleeper {
	killed: Option<Signal>,
	waker:  Option<Waker>,
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

// Failure mode: a host drops a shell whose background external is still
// running (killing it), or keeps one alive for a job that is done.
#[test]
fn live_external_jobs_counts_background_jobs_running_an_external() {
	let host = FakeHost::new().with_spawner(Box::new(|_: SpawnSpec<'_>| {
		Ok(Box::new(Sleeper { killed: None, waker: None }) as Box<dyn ExtProc>)
	}));
	let mut r = Rig::new(host, skeleton_init(&[]));
	assert_eq!(r.shell().live_external_jobs(), 0);
	assert_eq!(run(&mut r, "/fake/sleeper &"), (0, false));
	// Let the job reach its external.
	let (shell, host, store) = r.parts();
	while let Step::Yield | Step::Done { .. } =
		shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default())
	{}
	assert_eq!(r.shell().live_external_jobs(), 1);
	// A job of in-engine work only is not counted.
	assert_eq!(run(&mut r, "{ :; } & wait $!"), (0, false));
	assert_eq!(r.shell().live_external_jobs(), 1);
	assert_eq!(run(&mut r, "kill %1; wait %1"), (143, false));
	assert_eq!(r.shell().live_external_jobs(), 0);
}

// Failure mode: a host's native utilities create files with the host
// process's mask rather than the shell's after `umask 077`.
#[test]
fn natives_and_callouts_start_with_the_vproc_umask() {
	let mut host = FakeHost::new();
	host.countdown("nat", 0, 0);
	host.tool(
		"call",
		Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| -> CallOutcome {
			unreachable!("the test driver answers `call`")
		}),
	);
	let mut r = Rig::new(host, skeleton_init(&[]));
	let (shell, host, store) = r.parts();
	let src = "nat; call; umask 077; nat; call; (umask 002; nat; call); nat; call";
	let main = shell.submit(Script::command(src.as_bytes()));
	let mut calls = Vec::new();
	loop {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default()) {
			Step::Done { run, status } if run == main => {
				assert_eq!(status, 0);
				break;
			},
			Step::Call { id, call } => {
				calls.push(call.umask);
				shell.complete(id, CallOutcome::Exit(0));
			},
			Step::Done { .. } | Step::Yield => {},
			Step::Blocked => {
				if !host.fire_next_timer() {
					wait_runnable(&shell.control());
				}
			},
			other => panic!("{other:?} while `{src}` runs"),
		}
	}
	let natives: Vec<u32> = host.starts.iter().map(|&(_, mask)| mask).collect();
	assert_eq!(natives, [0o022, 0o077, 0o002, 0o077]);
	assert_eq!(calls, [0o022, 0o077, 0o002, 0o077]);
}

/// An external that has exited with a fixed status by the time it exists.
struct Exited(i32);

impl ExtProc for Exited {
	fn pid(&self) -> u32 {
		78
	}

	fn poll_wait(&mut self, _cx: &mut Context<'_>) -> Poll<ExitStatus> {
		Poll::Ready(ExitStatus::Exited(self.0))
	}

	fn signal(&mut self, _sig: Signal) -> io::Result<()> {
		Ok(())
	}

	fn stop(&mut self) -> io::Result<()> {
		Ok(())
	}

	fn cont(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// What a test knows about the spawns it holds back with [`Gated`].
#[derive(Default)]
struct Gate {
	/// The provider answers: pending spawns resolve to an [`Exited`].
	open:    bool,
	/// Waker of the latest poll of a pending spawn.
	waker:   Option<Waker>,
	/// `Host::spawn` calls (futures made).
	made:    u32,
	/// Futures dropped.
	dropped: u32,
	/// Futures that resolved to a process.
	started: u32,
}

impl Gate {
	/// The provider answers: wake the engine.
	fn release(gate: &Mutex<Self>) {
		let waker = {
			let mut gate = gate.lock();
			gate.open = true;
			gate.waker.take()
		};
		if let Some(waker) = waker {
			waker.wake();
		}
	}
}

/// A spawn that stays pending until its [`Gate`] opens, then makes an
/// external exiting with status 7.
struct Gated(Arc<Mutex<Gate>>);

impl Future for Gated {
	type Output = io::Result<Box<dyn ExtProc>>;

	fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
		let mut gate = self.0.lock();
		if !gate.open {
			gate.waker = Some(cx.waker().clone());
			return Poll::Pending;
		}
		gate.started += 1;
		Poll::Ready(Ok(Box::new(Exited(7))))
	}
}

impl Drop for Gated {
	fn drop(&mut self) {
		self.0.lock().dropped += 1;
	}
}

/// `(made, dropped, started)` of `gate`.
fn tally(gate: &Mutex<Gate>) -> (u32, u32, u32) {
	let gate = gate.lock();
	(gate.made, gate.dropped, gate.started)
}

fn gated_host(gate: &Arc<Mutex<Gate>>) -> FakeHost {
	let gate = Arc::clone(gate);
	FakeHost::new().with_spawn_future(Box::new(move |_: SpawnSpec<'_>| -> SpawnFuture {
		gate.lock().made += 1;
		Box::pin(Gated(Arc::clone(&gate)))
	}))
}

/// Steps the rig's shell until every vproc waits.
fn until_blocked(r: &mut Rig) {
	let (shell, host, store) = r.parts();
	loop {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default()) {
			Step::Yield => {},
			Step::Blocked => return,
			other => panic!("{other:?} before the spawn was pending"),
		}
	}
}

/// Steps the rig's shell until its run is done; the status.
fn until_done(r: &mut Rig) -> i32 {
	let (shell, host, store) = r.parts();
	loop {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default()) {
			Step::Done { status, .. } => return status,
			Step::Yield => {},
			Step::Blocked => wait_runnable(&shell.control()),
			other => panic!("{other:?} while the spawn resolves"),
		}
	}
}

// Failure mode: a host whose spawn waits on a provider (a URL resolved
// through the filesystem) stalls the shell, or its answer is lost.
#[test]
fn pending_spawn_does_not_block_the_shell_and_resumes_when_answered() {
	let gate = Arc::new(Mutex::new(Gate::default()));
	let mut r = Rig::new(gated_host(&gate), skeleton_init(&[]));
	let (shell, ..) = r.parts();
	shell.submit(Script::command(b"{ echo bg; } & /fake/prog; echo \"status $?\"".as_slice()));
	until_blocked(&mut r);
	// The spawn is pending: no process, and the background job ran meanwhile.
	assert_eq!(tally(&gate), (1, 0, 0));
	assert_eq!(r.parts().1.live_externals(), 0);
	assert_eq!(r.parts().1.stdout.bytes(), b"bg\n");
	Gate::release(&gate);
	assert_eq!(until_done(&mut r), 0);
	assert_eq!(r.parts().1.stdout.bytes(), b"bg\nstatus 7\n");
	assert_eq!(tally(&gate), (1, 1, 1));
}

// Failure mode: a cancelled command still spawns its process when the
// provider answers later.
#[test]
fn cancel_drops_a_pending_spawn_before_any_process_exists() {
	let gate = Arc::new(Mutex::new(Gate::default()));
	let mut r = Rig::new(gated_host(&gate), skeleton_init(&[]));
	let (shell, ..) = r.parts();
	shell.submit(Script::command(b"/fake/prog; echo after".as_slice()));
	until_blocked(&mut r);
	r.shell().control().cancel(Signal::Term);
	assert_eq!(until_done(&mut r), 143);
	assert_eq!(tally(&gate), (1, 1, 0), "the cancel drops the future");
	// The provider answers too late: nothing is spawned.
	Gate::release(&gate);
	assert_eq!(tally(&gate), (1, 1, 0));
	assert_eq!(r.parts().1.live_externals(), 0);
	assert_eq!(r.parts().1.stdout.bytes(), b"");
}

// Failure mode: a snapshot taken while a spawn is pending finishes it
// silently, or restores a second spawn beside the first.
#[test]
fn snapshot_of_a_pending_spawn_reissues_it_without_duplicating_the_process() {
	let gate = Arc::new(Mutex::new(Gate::default()));
	let mut r = Rig::new(gated_host(&gate), skeleton_init(&[]));
	let (shell, ..) = r.parts();
	shell.submit(Script::command(b"/fake/prog; echo \"status $?\"".as_slice()));
	until_blocked(&mut r);
	r.snapshot();
	// The pending future was dropped by the suspend; nothing started.
	assert_eq!(tally(&gate), (1, 1, 0));
	until_blocked(&mut r);
	assert_eq!(tally(&gate), (2, 1, 0), "asked again after the restore");
	Gate::release(&gate);
	assert_eq!(until_done(&mut r), 0);
	assert_eq!(r.parts().1.stdout.bytes(), b"status 7\n");
	assert_eq!(tally(&gate), (2, 2, 1), "one process for one command");
}
