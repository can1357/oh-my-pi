//! `FakeHost`: a deterministic [`Host`] for engine tests.
//!
//! Output is captured in memory; the clock advances 1 µs per read (and
//! jumps to the next timer deadline when every vproc waits); host
//! callouts and native tasks come from tables the test fills; every event is
//! recorded as JSON. Write "storms" (random `Pending` writes that wake
//! immediately) exercise the resumable output stage.
//!
//! **Leak checks.** Every [`Task`] the host starts or restores and every
//! [`ExtProc`] its spawner hook ([`FakeHost::with_spawner`],
//! [`FakeHost::with_spawn_future`]) returns is
//! counted until the engine drops it. [`FakeHost::assert_no_leaks`] runs
//! after each case of [`run_script`](crate::testkit::run_script); dropping a
//! [`Rig`](crate::testkit::Rig) checks [`FakeHost::assert_released`]. OS
//! processes are checked by the spawner's own leak check
//! (`crate::sys::NativeSpawner::leftovers`) in the tests that spawn them.

use std::{
	io,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
	},
	task::{Context, Poll, Waker},
	thread,
	time::Duration,
};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::Mutex;

use crate::{
	bash::{
		Budget, CallOutcome, Cx, Deadline, Event, EventSink, ExitStatus, ExtProc, File, FileKind, Fs,
		IntrinsicId, Invocation, ModeId, NativeRef, OsHandle, PipeTap, ResolveCtx, Resolved, Shell,
		ShellApi, Signal, SpawnFuture, SpawnSpec, StateStore, StdFd, Step, SystemTimeLike, Task,
		Timer, ToolRef, TtyInfo, UserInfo, Verdict, fs::SeekFrom,
	},
	testkit::{memfs::MemFs, rng::Rng},
};

/// A host callout: runs with access to the calling vproc.
pub type ToolFn = Arc<dyn Fn(&mut ShellApi<'_, '_>, &[BString]) -> CallOutcome + Send + Sync>;

/// Builds a native task from its argv.
pub type NativeFn = Arc<dyn Fn(&[BString]) -> Box<dyn Task> + Send + Sync>;

/// Rebuilds a native task from its checkpoint.
pub type RestoreFn = Arc<dyn Fn(&[u8]) -> io::Result<Box<dyn Task>> + Send + Sync>;

/// Decides a [`Verdict`] per event (breakpoints in tests).
pub type VerdictFn = Box<dyn FnMut(&Event<'_>) -> Verdict + Send>;

/// Spawns externals for [`Host::spawn`](crate::bash::Host::spawn) (a real
/// spawner in OS-level tests, e.g. `crate::sys::NativeSpawner::spawn`).
pub type SpawnFn = Box<dyn FnMut(SpawnSpec<'_>) -> io::Result<Box<dyn ExtProc>> + Send>;

/// Like [`SpawnFn`], for a host whose spawn is a future the test controls
/// ([`Host::spawn`](crate::bash::Host::spawn)): it decides when, and whether,
/// each process comes to exist.
pub type SpawnFutureFn = Box<dyn FnMut(SpawnSpec<'_>) -> SpawnFuture + Send>;

/// Shared in-memory output buffer.
#[derive(Clone, Debug, Default)]
pub struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
	/// Everything written so far.
	pub fn bytes(&self) -> Vec<u8> {
		self.0.lock().clone()
	}
}

/// A captured output stream.
struct CaptureFile {
	buf:   Capture,
	storm: Option<(f64, Rng)>,
}

impl File for CaptureFile {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if let Some((p, rng)) = &mut self.storm
			&& rng.chance(*p)
		{
			cx.waker().wake_by_ref();
			return Poll::Pending;
		}
		// Partial writes too: at most 7 bytes when storming.
		let n = if self.storm.is_some() {
			buf.len().min(7)
		} else {
			buf.len()
		};
		self.buf.0.lock().extend_from_slice(&buf[..n]);
		Poll::Ready(Ok(n))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self { buf: self.buf.clone(), storm: self.storm.clone() }))
	}
}

/// Stdin from bytes; the read position is shared, so it survives a restore.
struct Stdin(Arc<Mutex<(Vec<u8>, usize)>>);

impl File for Stdin {
	fn poll_read(&mut self, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		let mut s = self.0.lock();
		let (data, pos) = &mut *s;
		let n = buf.len().min(data.len() - *pos);
		buf[..n].copy_from_slice(&data[*pos..*pos + n]);
		*pos += n;
		Poll::Ready(Ok(n))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self(Arc::clone(&self.0))))
	}
}

struct Native {
	name:    BString,
	make:    NativeFn,
	restore: Option<RestoreFn>,
}

/// Tasks and externals the host handed to the engine that are still alive:
/// zero once a case is over.
#[derive(Debug, Default)]
struct Census {
	tasks: AtomicUsize,
	exts:  AtomicUsize,
}

/// A [`Task`] the host started or restored, counted while the engine holds
/// it.
struct CountedTask {
	task:   Box<dyn Task>,
	census: Arc<Census>,
}

impl CountedTask {
	fn wrap(task: Box<dyn Task>, census: &Arc<Census>) -> Box<dyn Task> {
		census.tasks.fetch_add(1, Ordering::AcqRel);
		Box::new(Self { task, census: Arc::clone(census) })
	}
}

impl Task for CountedTask {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<i32> {
		self.task.poll(cx)
	}

	fn signal(&mut self, sig: Signal) {
		self.task.signal(sig);
	}

	fn pause(&mut self) {
		self.task.pause();
	}

	fn resume(&mut self) {
		self.task.resume();
	}

	fn checkpoint(&mut self) -> Option<Vec<u8>> {
		self.task.checkpoint()
	}
}

impl Drop for CountedTask {
	fn drop(&mut self) {
		self.census.tasks.fetch_sub(1, Ordering::AcqRel);
	}
}

/// An [`ExtProc`] of the spawner hook, counted while the engine holds it.
struct CountedExt {
	ext:    Box<dyn ExtProc>,
	census: Arc<Census>,
}

impl CountedExt {
	fn wrap(ext: Box<dyn ExtProc>, census: &Arc<Census>) -> Box<dyn ExtProc> {
		census.exts.fetch_add(1, Ordering::AcqRel);
		Box::new(Self { ext, census: Arc::clone(census) })
	}
}

impl ExtProc for CountedExt {
	fn pid(&self) -> u32 {
		self.ext.pid()
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		self.ext.poll_wait(cx)
	}

	fn poll_event(&mut self, cx: &mut Context<'_>) -> Poll<crate::bash::ProcEvent> {
		self.ext.poll_event(cx)
	}

	fn pgid(&self) -> Option<u32> {
		self.ext.pgid()
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.ext.signal(sig)
	}

	fn stop(&mut self) -> io::Result<()> {
		self.ext.stop()
	}

	fn cont(&mut self) -> io::Result<()> {
		self.ext.cont()
	}
}

impl Drop for CountedExt {
	fn drop(&mut self) {
		self.census.exts.fetch_sub(1, Ordering::AcqRel);
	}
}

/// Most turns [`FakeHost::assert_no_leaks`] gives leftover work.
const DRAIN_TURNS: u32 = 10_000;

/// Most consecutive 1 ms waits [`FakeHost::assert_no_leaks`] allows a shell
/// whose every vproc is blocked with no timer armed.
const DRAIN_BLOCKED_MS: u32 = 2_000;

/// Deterministic test host.
pub struct FakeHost {
	/// The filesystem.
	pub fs:      MemFs,
	/// Captured fd 1.
	pub stdout:  Capture,
	/// Captured fd 2.
	pub stderr:  Capture,
	stdin:       Arc<Mutex<(Vec<u8>, usize)>>,
	tools:       Vec<(BString, ToolFn)>,
	natives:     Vec<Native>,
	/// Every event, as JSON, in emission order.
	pub events:  Vec<serde_json::Value>,
	/// Gets every event too ([`FakeHost::with_event_sink`]).
	sink:        Option<Arc<dyn EventSink>>,
	verdict:     Option<VerdictFn>,
	clock:       Arc<AtomicU64>,
	/// Armed timers (virtual time; see [`FakeHost::fire_next_timer`]).
	timers:      Arc<Mutex<Vec<Arc<TimerSlot>>>>,
	rng:         Rng,
	storm:       Option<(f64, u64)>,
	/// `$$`.
	pub pid:     u32,
	/// Every native task started: its name and the `umask` it was given
	/// ([`Invocation::umask`]).
	pub starts:  Vec<(BString, u32)>,
	spawner:     Option<SpawnFutureFn>,
	census:      Arc<Census>,
	pipe_tap:    Option<Arc<dyn PipeTap>>,
	/// [`Host::child_opens`](crate::bash::Host::child_opens) answers this.
	child_opens: bool,
	/// The login database [`Host::logins`](crate::bash::Host::logins)
	/// reports (`None`: none, `Unsupported`).
	pub logins:  Option<crate::bash::Logins>,
}

impl Default for FakeHost {
	fn default() -> Self {
		Self::new()
	}
}

impl FakeHost {
	/// Host with an empty `MemFs` and no callouts.
	pub fn new() -> Self {
		Self {
			fs:          MemFs::new(),
			stdout:      Capture::default(),
			stderr:      Capture::default(),
			stdin:       Arc::new(Mutex::new((Vec::new(), 0))),
			tools:       Vec::new(),
			natives:     Vec::new(),
			events:      Vec::new(),
			sink:        None,
			verdict:     None,
			clock:       Arc::new(AtomicU64::new(0)),
			timers:      Arc::new(Mutex::new(Vec::new())),
			rng:         Rng::new(1),
			storm:       None,
			pid:         4242,
			starts:      Vec::new(),
			spawner:     None,
			census:      Arc::new(Census::default()),
			pipe_tap:    None,
			child_opens: false,
			logins:      None,
		}
	}

	/// Let spawned externals open the redirections whose open would wait
	/// ([`Host::child_opens`](crate::bash::Host::child_opens)): the spawner
	/// sees them in [`SpawnSpec::redirs`].
	#[must_use]
	pub const fn with_child_opens(mut self) -> Self {
		self.child_opens = true;
		self
	}

	/// Offer every pipeline pipe to `tap`
	/// ([`Host::pipe_tap`](crate::bash::Host::pipe_tap)).
	pub fn with_pipe_tap(mut self, tap: Arc<dyn PipeTap>) -> Self {
		self.pipe_tap = Some(tap);
		self
	}

	/// Forward every event to `sink` as well (a
	/// [`RunTrace`](crate::bash::trace::RunTrace)); the test sets the
	/// shell's mask to the sink's.
	pub fn with_event_sink(mut self, sink: Arc<dyn EventSink>) -> Self {
		self.sink = Some(sink);
		self
	}

	/// Spawn externals through `spawn` instead of failing with
	/// `Unsupported` (OS-level tests over a real spawner).
	pub fn with_spawner(mut self, mut spawn: SpawnFn) -> Self {
		self.spawner = Some(Box::new(move |spec: SpawnSpec<'_>| -> SpawnFuture {
			Box::pin(std::future::ready(spawn(spec)))
		}));
		self
	}

	/// Spawn externals through the futures `spawn` returns instead of
	/// failing with `Unsupported`: a future that stays pending holds the
	/// spawn back, one that is dropped spawns nothing.
	pub fn with_spawn_future(mut self, spawn: SpawnFutureFn) -> Self {
		self.spawner = Some(spawn);
		self
	}

	/// Tasks started or restored by this host that are still alive.
	pub fn live_tasks(&self) -> usize {
		self.census.tasks.load(Ordering::Acquire)
	}

	/// Externals spawned through [`FakeHost::with_spawner`] or
	/// [`FakeHost::with_spawn_future`] whose [`ExtProc`] is still alive.
	pub fn live_externals(&self) -> usize {
		self.census.exts.load(Ordering::Acquire)
	}

	/// Leak check once the shell that used this host is gone: every task and
	/// external handle it was given has been dropped.
	/// [`Rig`](crate::testkit::Rig) runs it on drop.
	///
	/// # Panics
	///
	/// When a task or external handle survived the shell.
	pub fn assert_released(&self) {
		let (tasks, exts) = (self.live_tasks(), self.live_externals());
		assert!(
			tasks == 0 && exts == 0,
			"leaked {tasks} tasks and {exts} externals: still alive after the shell was dropped"
		);
	}

	/// Leak check after a case: steps `shell` until it is idle (background
	/// vprocs the case left behind may finish, as bash's orphans would;
	/// callouts are answered and timers fired as
	/// [`crate::testkit::run::advance`] does), then requires that the idle
	/// shell holds no task or external.
	/// [`run_script`](crate::testkit::run_script) runs it after every case;
	/// tests that drive a shell by hand call it themselves.
	///
	/// # Panics
	///
	/// Leaked vprocs: the shell still has work after `DRAIN_TURNS` turns, or
	/// every vproc stays blocked for 2 s without a timer to fire. Leaked
	/// tasks or externals: any is alive once the shell is idle.
	pub fn assert_no_leaks(&mut self, shell: &mut Shell, store: &mut dyn StateStore) {
		let mut blocked_ms = 0u32;
		for _ in 0..DRAIN_TURNS {
			let step = shell.step(&mut Cx { host: &mut *self, store: &mut *store }, Budget::default());
			match step {
				Step::Idle => {
					let (tasks, exts) = (self.live_tasks(), self.live_externals());
					assert!(
						tasks == 0 && exts == 0,
						"leaked {tasks} tasks and {exts} externals: held by an idle shell"
					);
					return;
				},
				Step::Done { .. } | Step::Yield | Step::SuspendReady => blocked_ms = 0,
				Step::Paused => shell.control().resume(),
				Step::Call { id, call } => {
					blocked_ms = 0;
					let tool = self
						.tool_fn(call.tool)
						.expect("callout registered with the host");
					let mut cx = Cx { host: &mut *self, store: &mut *store };
					let outcome = {
						let mut api = shell.api(&mut cx, id).expect("call is outstanding");
						tool(&mut api, &call.argv)
					};
					shell.complete(id, outcome);
				},
				Step::Blocked => {
					if self.fire_next_timer() {
						continue;
					}
					let ctl = shell.control();
					let mut cx = Context::from_waker(Waker::noop());
					while ctl.poll_runnable(&mut cx).is_pending() {
						blocked_ms += 1;
						assert!(
							blocked_ms <= DRAIN_BLOCKED_MS,
							"leaked vprocs: every vproc stays blocked after the case ended"
						);
						thread::sleep(Duration::from_millis(1));
					}
				},
			}
		}
		panic!("leaked vprocs: the shell still has work {DRAIN_TURNS} turns after the case ended");
	}

	/// Virtual time: when every vproc waits, jump the clock to the earliest
	/// armed timer's deadline and fire it. `false` when no timer is armed.
	///
	/// [`crate::testkit::advance`] calls it on `Step::Blocked`, so `read -t`
	/// times out deterministically. A test that mixes timers with real-time
	/// `MemFs` latency may see a timer fire before a slow fs answer.
	pub fn fire_next_timer(&self) -> bool {
		let next = self
			.timers
			.lock()
			.iter()
			.filter(|t| !t.fired.load(Ordering::Acquire))
			.min_by_key(|t| t.deadline)
			.cloned();
		let Some(next) = next else {
			return false;
		};
		self.clock.fetch_max(next.deadline, Ordering::AcqRel);
		next.fired.store(true, Ordering::Release);
		let waker = next.waker.lock().take();
		if let Some(w) = waker {
			w.wake();
		}
		true
	}

	/// Use `fs` as the filesystem.
	pub fn with_fs(mut self, fs: MemFs) -> Self {
		self.fs = fs;
		self
	}

	/// Provide stdin bytes.
	pub fn with_stdin(self, bytes: &[u8]) -> Self {
		*self.stdin.lock() = (bytes.to_vec(), 0);
		self
	}

	/// Make output writes return `Pending` (waking at once) with
	/// probability `p`, and write at most 7 bytes at a time.
	pub const fn with_write_storm(mut self, seed: u64, p: f64) -> Self {
		self.storm = Some((p, seed));
		self
	}

	/// Register host callout `name`.
	pub fn tool(&mut self, name: &str, f: ToolFn) {
		self.tools.push((BString::from(name), f));
	}

	/// Register native command `name`.
	pub fn native(&mut self, name: &str, make: NativeFn, restore: Option<RestoreFn>) {
		self
			.natives
			.push(Native { name: BString::from(name), make, restore });
	}

	/// Register `name` as a [`Countdown`] task: pending for `polls` polls,
	/// then exiting with `status`; it checkpoints and restores.
	pub fn countdown(&mut self, name: &str, polls: u32, status: i32) {
		let make: NativeFn = Arc::new(move |_: &[BString]| {
			Box::new(Countdown { left: polls, status }) as Box<dyn Task>
		});
		let restore: RestoreFn = Arc::new(Countdown::restore);
		self.native(name, make, Some(restore));
	}

	/// Decide verdicts per event.
	pub fn on_event(&mut self, f: VerdictFn) {
		self.verdict = Some(f);
	}

	/// The callout behind `r`.
	pub fn tool_fn(&self, r: ToolRef) -> Option<ToolFn> {
		self.tools.get(r.0 as usize).map(|(_, f)| Arc::clone(f))
	}

	fn capture(&self, buf: &Capture, salt: u64) -> Box<dyn File> {
		Box::new(CaptureFile {
			buf:   buf.clone(),
			storm: self.storm.map(|(p, seed)| (p, Rng::new(seed ^ salt))),
		})
	}
}

/// One armed virtual timer.
struct TimerSlot {
	deadline: u64,
	fired:    AtomicBool,
	waker:    Mutex<Option<Waker>>,
}

/// The [`Timer`] handed to the engine; dropping it disarms the slot.
struct FakeTimer {
	slot:   Arc<TimerSlot>,
	clock:  Arc<AtomicU64>,
	timers: Arc<Mutex<Vec<Arc<TimerSlot>>>>,
}

impl Timer for FakeTimer {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<()> {
		if self.slot.fired.load(Ordering::Acquire)
			|| self.clock.load(Ordering::Acquire) >= self.slot.deadline
		{
			return Poll::Ready(());
		}
		*self.slot.waker.lock() = Some(cx.waker().clone());
		Poll::Pending
	}
}

impl Drop for FakeTimer {
	fn drop(&mut self) {
		self.timers.lock().retain(|t| !Arc::ptr_eq(t, &self.slot));
	}
}

impl crate::bash::Host for FakeHost {
	fn resolve(&mut self, name: &BStr, mode: ModeId, why: ResolveCtx) -> Resolved {
		if let Some(i) = self.tools.iter().position(|(n, _)| n.as_bstr() == name) {
			return Resolved::Tool(ToolRef(i as u64));
		}
		if let Some(i) = self.natives.iter().position(|n| n.name.as_bstr() == name) {
			return Resolved::Native(NativeRef(i as u64));
		}
		// `bash`/`sh`/`zsh` run in-engine as a nested shell.
		if !why.has_slash && matches!(name.as_bytes(), b"bash" | b"sh" | b"zsh") {
			return Resolved::SelfShell;
		}
		IntrinsicId::lookup(name, mode).map_or(Resolved::NotFound, Resolved::Intrinsic)
	}

	fn start(&mut self, cmd: &NativeRef, inv: Invocation<'_>) -> io::Result<Box<dyn Task>> {
		let n = self
			.natives
			.get(cmd.0 as usize)
			.ok_or(io::ErrorKind::NotFound)?;
		self.starts.push((n.name.clone(), inv.umask));
		Ok(CountedTask::wrap((n.make)(inv.argv), &self.census))
	}

	fn restore_task(&mut self, cmd: &NativeRef, state: &[u8]) -> io::Result<Box<dyn Task>> {
		let n = self
			.natives
			.get(cmd.0 as usize)
			.ok_or(io::ErrorKind::NotFound)?;
		let restore = n.restore.as_ref().ok_or(io::ErrorKind::Unsupported)?;
		restore(state).map(|task| CountedTask::wrap(task, &self.census))
	}

	fn spawn(&mut self, spec: SpawnSpec<'_>) -> SpawnFuture {
		let Some(spawn) = self.spawner.as_mut() else {
			return Box::pin(std::future::ready(Err(io::Error::from(io::ErrorKind::Unsupported))));
		};
		let census = Arc::clone(&self.census);
		let spawned = spawn(spec);
		Box::pin(async move { spawned.await.map(|ext| CountedExt::wrap(ext, &census)) })
	}

	fn pipe_tap(&mut self) -> Option<Arc<dyn PipeTap>> {
		self.pipe_tap.clone()
	}

	fn child_opens(&mut self, _path: &BStr) -> bool {
		self.child_opens
	}

	fn fs(&mut self) -> &mut dyn Fs {
		&mut self.fs
	}

	fn stdio(&mut self, fd: StdFd) -> Option<Box<dyn File>> {
		Some(match fd {
			StdFd::Stdin => Box::new(Stdin(Arc::clone(&self.stdin))),
			StdFd::Stdout => self.capture(&self.stdout, 1),
			StdFd::Stderr => self.capture(&self.stderr, 2),
		})
	}

	fn now_ns(&self) -> u64 {
		self.clock.fetch_add(1_000, Ordering::Relaxed)
	}

	fn timer(&mut self, at: Deadline) -> Box<dyn Timer> {
		let slot = Arc::new(TimerSlot {
			deadline: at.0,
			fired:    AtomicBool::new(false),
			waker:    Mutex::new(None),
		});
		self.timers.lock().push(Arc::clone(&slot));
		Box::new(FakeTimer { slot, clock: Arc::clone(&self.clock), timers: Arc::clone(&self.timers) })
	}

	fn wall(&self) -> SystemTimeLike {
		SystemTimeLike { secs: 1_700_000_000, nanos: 0 }
	}

	fn random(&mut self) -> u64 {
		self.rng.next_u64()
	}

	fn shell_pid(&self) -> u32 {
		self.pid
	}

	fn ppid(&self) -> u32 {
		1
	}

	fn user(&self) -> UserInfo {
		UserInfo {
			uid:    1000,
			euid:   1000,
			gid:    1000,
			groups: vec![1000, 27],
			name:   "tester".into(),
			home:   "/home/tester".into(),
		}
	}

	fn login_shell(&self) -> Option<BString> {
		Some("/bin/bash".into())
	}

	fn hostname(&self) -> BString {
		"testhost".into()
	}

	fn tty(&mut self, _fd: i32) -> Option<TtyInfo> {
		None
	}

	/// Every zone is UTC: goldens stay independent of the machine.
	fn tz_offset(&self, _tz: Option<&BStr>, _unix_s: i64) -> (i32, BString) {
		(0, "UTC".into())
	}

	fn logins(&self) -> io::Result<crate::bash::Logins> {
		self
			.logins
			.clone()
			.ok_or_else(|| io::ErrorKind::Unsupported.into())
	}

	fn event(&mut self, ev: &Event<'_>) -> Verdict {
		self
			.events
			.push(serde_json::to_value(ev).expect("events serialize"));
		if let Some(sink) = &self.sink {
			sink.event(ev);
		}
		self.verdict.as_mut().map_or(Verdict::Continue, |f| f(ev))
	}
}

/// A native task that is pending for a number of polls, then exits.
///
/// It checkpoints its remaining poll count, so it survives
/// externalize → restore through
/// [`Host::restore_task`](crate::bash::Host::restore_task).
#[derive(Debug)]
pub struct Countdown {
	left:   u32,
	status: i32,
}

impl Countdown {
	fn restore(state: &[u8]) -> io::Result<Box<dyn Task>> {
		let (left, status) = state
			.split_first_chunk::<4>()
			.ok_or(io::ErrorKind::InvalidData)?;
		let status = status
			.first_chunk::<4>()
			.ok_or(io::ErrorKind::InvalidData)?;
		Ok(Box::new(Self { left: u32::from_le_bytes(*left), status: i32::from_le_bytes(*status) }))
	}
}

impl Task for Countdown {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<i32> {
		if self.left == 0 {
			return Poll::Ready(self.status);
		}
		self.left -= 1;
		cx.waker().wake_by_ref();
		Poll::Pending
	}

	fn signal(&mut self, sig: Signal) {
		if matches!(sig, Signal::Term | Signal::Int | Signal::Kill) {
			self.left = 0;
			self.status = 128 + i32::from(sig.number(crate::bash::Platform::Linux));
		}
	}

	fn checkpoint(&mut self) -> Option<Vec<u8>> {
		let mut v = self.left.to_le_bytes().to_vec();
		v.extend_from_slice(&self.status.to_le_bytes());
		Some(v)
	}
}
