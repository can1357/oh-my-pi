//! Driving a shell to completion: the trampoline a test host plays.

use std::{
	sync::Arc,
	task::{Context, Wake, Waker},
	thread::{self, Thread},
	time::Duration,
};

use crate::{
	bash::{Budget, ControlHandle, Cx, RunId, Shell, StateStore, Step},
	sys::NativeSpawner,
	testkit::host::FakeHost,
};

/// Why [`advance`] returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
	/// The run finished with this status.
	Done(i32),
	/// The budget ran out (a safepoint where faults can be injected).
	Yield,
	/// The shell is paused (by a verdict or a control request).
	Paused,
	/// Every vproc waits (only from [`advance_or_blocked`]).
	Blocked,
}

/// Step `shell` until `run` finishes, the budget yields, or it pauses.
///
/// Answers callouts from the host's tool table at once and parks the thread
/// while every vproc is blocked.
pub fn advance(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut dyn StateStore,
	run: RunId,
	budget: Budget,
) -> Stop {
	drive(shell, host, store, run, budget, false)
}

/// Like [`advance`], but returns [`Stop::Blocked`] instead of waiting when
/// every vproc is blocked (to inject faults while operations are pending).
pub fn advance_or_blocked(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut dyn StateStore,
	run: RunId,
	budget: Budget,
) -> Stop {
	drive(shell, host, store, run, budget, true)
}

fn drive(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut dyn StateStore,
	run: RunId,
	budget: Budget,
	stop_blocked: bool,
) -> Stop {
	loop {
		let step = shell.step(&mut Cx { host: &mut *host, store: &mut *store }, budget);
		match step {
			Step::Done { run: r, status } if r == run => return Stop::Done(status),
			Step::Done { .. } | Step::SuspendReady => {},
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
			Step::Blocked if stop_blocked => return Stop::Blocked,
			Step::Blocked => {
				if !host.fire_next_timer() {
					wait_runnable(&shell.control());
				}
			},
			Step::Paused => return Stop::Paused,
			Step::Yield => return Stop::Yield,
			Step::Idle => panic!("{run:?} is neither running nor reported done"),
		}
	}
}

struct Unpark(Thread);

impl Wake for Unpark {
	fn wake(self: Arc<Self>) {
		self.0.unpark();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.0.unpark();
	}
}

/// Park the calling thread until the shell may make progress.
pub fn wait_runnable(ctl: &ControlHandle) {
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	let mut cx = Context::from_waker(&waker);
	loop {
		NativeSpawner::poll_orphans(&cx);
		if ctl.poll_runnable(&mut cx).is_ready() {
			break;
		}
		thread::park_timeout(Duration::from_millis(50));
	}
}
