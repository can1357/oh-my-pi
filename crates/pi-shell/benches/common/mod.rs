//! Shared by the engine benches (`create`, `overhead`, `memory`): a host whose
//! event sink discards, and a driver that runs one script to its end.

use std::{hint::black_box, io, sync::Arc};

use bstr::{BStr, BString, ByteSlice};
use pi_shell::{
	bash::{
		Budget, Cx, Deadline, Engine, Event, File, Fs, Host, Invocation, MemStore, ModeId, NativeRef,
		ResolveCtx, Resolved, Script, Shell, SpawnFuture, SpawnSpec, StdFd, Step, SystemTimeLike,
		Task, Timer, TtyInfo, UserInfo, Verdict,
	},
	testkit::{FakeHost, fault::skeleton_init},
};

/// [`FakeHost`] with a null event sink: every event is dropped as it
/// arrives. `FakeHost` itself keeps each event as a JSON value, which would
/// measure `serde_json` instead of the engine.
pub struct NullHost(pub FakeHost);

impl Host for NullHost {
	fn resolve(&mut self, name: &BStr, mode: ModeId, why: ResolveCtx) -> Resolved {
		self.0.resolve(name, mode, why)
	}

	fn start(&mut self, cmd: &NativeRef, inv: Invocation<'_>) -> io::Result<Box<dyn Task>> {
		self.0.start(cmd, inv)
	}

	fn restore_task(&mut self, cmd: &NativeRef, state: &[u8]) -> io::Result<Box<dyn Task>> {
		self.0.restore_task(cmd, state)
	}

	fn spawn(&mut self, spec: SpawnSpec<'_>) -> SpawnFuture {
		self.0.spawn(spec)
	}

	fn fs(&mut self) -> &mut dyn Fs {
		self.0.fs()
	}

	fn stdio(&mut self, fd: StdFd) -> Option<Box<dyn File>> {
		self.0.stdio(fd)
	}

	fn now_ns(&self) -> u64 {
		self.0.now_ns()
	}

	fn timer(&mut self, at: Deadline) -> Box<dyn Timer> {
		self.0.timer(at)
	}

	fn wall(&self) -> SystemTimeLike {
		self.0.wall()
	}

	fn random(&mut self) -> u64 {
		self.0.random()
	}

	fn shell_pid(&self) -> u32 {
		self.0.shell_pid()
	}

	fn ppid(&self) -> u32 {
		self.0.ppid()
	}

	fn user(&self) -> UserInfo {
		self.0.user()
	}

	fn login_shell(&self) -> Option<BString> {
		self.0.login_shell()
	}

	fn hostname(&self) -> BString {
		self.0.hostname()
	}

	fn tty(&mut self, fd: i32) -> Option<TtyInfo> {
		self.0.tty(fd)
	}

	fn tz_offset(&self, tz: Option<&BStr>, unix_s: i64) -> (i32, BString) {
		self.0.tz_offset(tz, unix_s)
	}

	fn event(&mut self, ev: &Event<'_>) -> Verdict {
		black_box(ev);
		Verdict::Continue
	}
}

/// No op or time limit: a run ends only when its script does.
pub const UNBOUNDED: Budget = Budget { max_ops: u32::MAX, max_ns: u64::MAX };

/// A shell as the skeleton tests create it (`$0` = bash, `PATH` only).
pub fn new_shell(engine: &Arc<Engine>, host: &mut NullHost, store: &mut MemStore) -> Shell {
	Shell::create(engine, &mut Cx { host, store }, skeleton_init(&[])).expect("create")
}

/// Submit `src` and step until it is done; its status.
///
/// # Panics
///
/// When the shell blocks, pauses, calls out or goes idle first (the bench
/// workloads never do).
pub fn run(shell: &mut Shell, host: &mut NullHost, store: &mut MemStore, src: &[u8]) -> i32 {
	let id = shell.submit(Script::command(src));
	loop {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, UNBOUNDED) {
			Step::Done { run, status } if run == id => return status,
			Step::Done { .. } | Step::Yield => {},
			other => panic!("{other:?} while running `{}`", src.as_bstr()),
		}
	}
}

/// `PASS` or `MISS`.
pub const fn verdict(ok: bool) -> &'static str {
	if ok { "PASS" } else { "MISS" }
}
