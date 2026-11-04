//! A persistent engine shell driven per command.
//!
//! **Threading.** The engine is step-driven and synchronous: [`Shell::step`]
//! runs a budget of work and returns, and everything it waits on (pipes,
//! externals, pending filesystem operations, timers) wakes a waker. A
//! [`Session`] gives the shell, its [`MemStore`] and its [`PiHost`] to one
//! task (the *driver*) on [`SessionConfig::runtime`], which steps the shell
//! and, while every virtual process waits, suspends on the engine's waker, a
//! wake bell (requests, cancellation, tool completion) and the next tool
//! deadline. Nothing blocks a thread: a current-thread runtime drives the
//! driver, the provider futures of a `pi_vfs`-backed [`Fs`], external
//! spawning and output pumps together, and a step that exhausts its budget
//! yields to the runtime. The async side ([`Session::run`]) only sends jobs
//! over a channel and awaits the reply. Between commands the driver keeps
//! stepping background work (`cmd &` in-engine jobs, reaping background
//! externals).
//! **State.** Variables, functions, aliases, options, traps and the working
//! directory live in the store and the root virtual process; every command
//! runs on the root ([`VprocSel::Root`]), so they persist across commands.
//! An `EXIT` trap is consumed when it fires at a run boundary; other traps
//! remain installed.
//! Each command starts with its own standard streams, even if an earlier
//! command redirected them with `exec`. Higher-numbered descriptors persist;
//! duplicates of standard streams follow the current command's streams.
//!
//! **`exit`.** A root run is a `bash -c` script: `exit N` (or `set -e`)
//! unwinds the run with status `N`, runs the `EXIT` trap at the run boundary,
//! and the shell stays usable for the next command with its state intact
//! (pi's `exit_and_errexit_keep_session_state`). The engine does this
//! itself; the session only reports the status.
//!
//! **Cancellation.** A cancelled run is stopped through the engine's
//! [`ControlHandle::cancel`](crate::bash::ControlHandle::cancel): first `TERM`
//! (signal traps run, externals get `TERM`, status 143), then, if the run
//! has not ended after [`TERM_GRACE`], `KILL` (no traps, status 137).
//! Unwinding drops the externals the run waits for; the spawner sends their
//! process groups `TERM` and `KILL` after [`TERM_GRACE`] in the background.
//! The cancel request reaches the engine only from the driver, while the run
//! it targets is still in flight, so a late cancel never leaks into the next
//! command. What `nohup` started ([`crate::tools`]) is detached: neither a
//! cancel nor closing the session ends it.
//!
//! **Subshell jobs.** Unlike bash, a subshell's background jobs that run
//! in-engine work (builtins, loops) end when the subshell exits
//! ([`EngineConfig::end_orphan_jobs`]): no process stands for them, so
//! nothing could reach them afterwards. A job that is just an external runs
//! on as its own process, as in bash.
//!
//! **Tools.** `timeout`, `nohup` and (with `PI_SMART_GIT`/`PI_GIT_GUARD`)
//! `git` are host callouts: the driver hands them to its
//! [`ToolCalls`](crate::tools::ToolCalls), routes the `Done` of their
//! subshells there, polls them every turn, and parks no longer than their
//! next deadline.

use std::{
	future::poll_fn,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU8, Ordering},
	},
	task::{Wake, Waker},
	time::Duration,
};

use bstr::{BString, ByteSlice};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
	bash::{
		Budget, CallId, Cx, Engine, EngineConfig, EventMask, Fs, MemStore, PipeTap, RunId, Script,
		Shell, ShellError, ShellInit, Signal, Step, ToolCall, VprocSel,
		store::{Key, MiscKey, Record},
	},
	host::{PiHost, SpawnObserver, TERM_GRACE},
	sys::OutputDecoding,
	tools::{ToolCalls, ToolConfig},
	vfs::VfsFs,
};

/// How long a run may take to end after the `KILL` cancel before the session
/// gives up on it ([`SessionError::Unresponsive`]).
const KILL_WAIT: Duration = Duration::from_secs(5);

/// Most default-budget steps of background work a command's end waits for
/// ([`Driver::settle`]): about 8 ms.
const SETTLE_STEPS: u32 = 4;

/// Longest suspension of the driver: every wake it waits for is delivered by
/// a waker, so this only bounds the cost of a lost one.
const MAX_PARK: Duration = Duration::from_secs(1);

/// Configuration of a new [`Session`].
pub struct SessionConfig {
	/// The shell's initial environment, all exported (no inheritance from
	/// the pi process beyond what is listed).
	pub env:             Vec<(BString, BString)>,
	/// Initial working directory (absolute).
	pub cwd:             BString,
	/// The filesystem: `crate::vfs::VfsFs`, or `crate::sys::StdFs`.
	pub fs:              Box<dyn Fs + Send>,
	/// The pi-vfs filesystem slot behind [`SessionConfig::fs`] (a clone of
	/// the same [`VfsFs`]), when there is one: pi's utilities and in-process
	/// `git worktree add` ([`crate::tools`]) work on the filesystem it holds
	/// when they run, and externals get the host files its URLs alias
	/// ([`PiHost::spawn`](crate::bash::Host::spawn)). `None`: every path is
	/// native.
	pub vfs:             Option<VfsFs>,
	/// Runtime the host's timers (`read -t`, `TMOUT`) sleep on.
	pub runtime:         tokio::runtime::Handle,
	/// Decodes what externals write into a text capture
	/// ([`RunOptions::text_capture`]); `None` is the platform default
	/// ([`crate::output_decode::external_output_decoding`]).
	pub output_decoding: Option<Arc<dyn OutputDecoding>>,
}

/// One command of a [`Session`].
#[derive(Clone, Default)]
pub struct RunOptions {
	/// The command string (`bash -c` semantics).
	pub command:        String,
	/// Variables exported to this command only (pi's per-run env). They are
	/// visible to everything the command runs; afterwards each named
	/// variable is back to what it was before, whatever the command did to
	/// it.
	pub env:            Vec<(BString, BString)>,
	/// Working directory to change to before the command (absolute, or a
	/// `scheme://` URL path the filesystem serves); like `cd`, it persists.
	pub cwd:            Option<BString>,
	/// Gets a copy of the bytes crossing the pipes of the command's pipelines
	/// ([`crate::bash::Host::pipe_tap`]); pipelines it leaves running in the
	/// background stay tapped.
	pub pipe_tap:       Option<Arc<dyn PipeTap>>,
	/// Set when a utility reports an error its exit status hides (`jq`
	/// after a failing input that is not the last).
	pub reported_error: Option<Arc<AtomicBool>>,
	/// The command's stdout and stderr are one pipe whose reader takes its
	/// bytes as shell text: what externals write there is decoded per
	/// program by the host's output decoding
	/// ([`PiHost::set_output_decoding`](crate::host::PiHost::set_output_decoding)),
	/// through one relay for both streams. Pipeline pipes and files are
	/// never decoded.
	pub text_capture:   bool,
}

impl RunOptions {
	/// Run `command` with no env overlay in the current directory.
	pub fn new(command: impl Into<String>) -> Self {
		Self {
			command:        command.into(),
			env:            Vec::new(),
			cwd:            None,
			pipe_tap:       None,
			reported_error: None,
			text_capture:   false,
		}
	}
}

impl std::fmt::Debug for RunOptions {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("RunOptions")
			.field("command", &self.command)
			.field("env", &self.env)
			.field("cwd", &self.cwd)
			.field("pipe_tap", &self.pipe_tap.is_some())
			.field("reported_error", &self.reported_error)
			.finish()
	}
}

/// The standard streams of one command, as OS handles.
///
/// `None` behaves like `/dev/null`. The session closes its copies when the
/// command ends, so a reader of a pipe passed here sees end of file once the
/// command (and any external still holding the pipe) is done.
#[derive(Debug, Default)]
pub struct RunStdio {
	/// fd 0.
	pub stdin:  Option<std::fs::File>,
	/// fd 1.
	pub stdout: Option<std::fs::File>,
	/// fd 2.
	pub stderr: Option<std::fs::File>,
}

/// How a command ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunOutcome {
	/// Exit status, bash semantics (127 not found, 128 + n for a signal).
	pub status:    i32,
	/// The run was stopped by its cancellation token.
	pub cancelled: bool,
	/// `exit` or `set -e` ended the command (rather than its end): a caller
	/// running one command as several runs stops here, as bash would have.
	pub exited:    bool,
	/// The shell's working directory after the command.
	pub cwd:       BString,
}

/// Failure of a [`Session`] call.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
	/// The engine refused the initial state.
	#[error("could not create the shell")]
	Create(#[source] ShellError),
	/// The driver task is gone (it panicked, or its runtime shut down), or
	/// an earlier run became
	/// [`SessionError::Unresponsive`].
	#[error("the shell session is closed")]
	Closed,
	/// A cancelled run did not end even after the `KILL` cancel; the session
	/// is closed.
	#[error("the shell did not stop after cancellation")]
	Unresponsive,
	/// [`RunOptions::cwd`] is not absolute.
	#[error("working directory {0} is not absolute")]
	RelativeCwd(BString),
}

/// The live externals of the run in flight (pi's `Shell::pids()`). Cheap to
/// clone; clones share the list.
#[derive(Clone, Default)]
pub struct Children(Arc<ChildrenState>);

#[derive(Default)]
struct ChildrenState {
	/// A run is in flight.
	active: AtomicBool,
	/// Live pids in spawn order.
	pids:   Mutex<Vec<u32>>,
}

impl Children {
	/// Pids of the live externals spawned by the run in flight, in spawn
	/// order; empty while no run is in flight.
	pub fn pids(&self) -> Vec<i32> {
		if !self.0.active.load(Ordering::Acquire) {
			return Vec::new();
		}
		self
			.0
			.pids
			.lock()
			.iter()
			.filter_map(|&pid| i32::try_from(pid).ok())
			.collect()
	}

	fn set_active(&self, active: bool) {
		self.0.active.store(active, Ordering::Release);
	}
}

impl SpawnObserver for Children {
	fn spawned(&self, pid: u32) {
		self.0.pids.lock().push(pid);
	}

	fn released(&self, pid: u32) {
		let mut pids = self.0.pids.lock();
		if let Some(i) = pids.iter().position(|&p| p == pid) {
			pids.remove(i);
		}
	}
}

/// The wake bell of a driver task: its waker (handed to worker threads and
/// held by the [`Session`]) stores a permit the driver awaits; it never
/// blocks.
#[derive(Default)]
struct Bell(tokio::sync::Notify);

impl Wake for Bell {
	fn wake(self: Arc<Self>) {
		self.0.notify_one();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.0.notify_one();
	}
}

/// A persistent shell: commands run one at a time on a driver task of the
/// session's runtime (see the module docs), and state persists between them.
pub struct Session {
	/// Requests for the driver; `None` once the session is closed.
	jobs:     Option<flume::Sender<Request>>,
	/// Rings the driver's bell.
	waker:    Waker,
	children: Children,
}

impl Session {
	/// Start a shell with `config`'s environment and working directory.
	///
	/// The shell is created here (no I/O) and its driver task is spawned on
	/// [`SessionConfig::runtime`], which must keep running for the session
	/// to answer.
	///
	/// # Errors
	///
	/// [`SessionError::Create`] when the engine refuses the initial state.
	pub fn new(config: SessionConfig) -> Result<Self, SessionError> {
		let SessionConfig { env, cwd, fs, vfs, runtime, output_decoding } = config;
		let (jobs, rx) = flume::unbounded();
		let children = Children::default();
		let bell = Arc::new(Bell::default());
		let waker = Waker::from(Arc::clone(&bell));
		let tools = ToolConfig::from_env(&env, vfs.clone(), runtime.clone());
		let mut host = PiHost::new(fs, runtime.clone());
		if output_decoding.is_some() {
			host.set_output_decoding(output_decoding);
		}
		host.set_spawn_observer(Arc::new(children.clone()));
		host.set_vfs(vfs);
		host.set_tools(tools.clone());
		let tools = ToolCalls::new(tools, host.spawn_log(), waker.clone());
		// A subshell's background in-engine work ends with it: nothing
		// (no process for `pkill`, no job for `kill %N`) could reach it.
		let engine = Engine::new(EngineConfig { end_orphan_jobs: true, ..EngineConfig::default() });
		let mut store = MemStore::new();
		let init = ShellInit { env, cwd, ..ShellInit::default() };
		let mut shell = Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, init)
			.map_err(SessionError::Create)?;
		// Nothing observes events: skip building them.
		shell.set_event_mask(EventMask::NONE);
		let driver = Driver { shell, store, host, bell, jobs: rx, children: children.clone(), tools };
		runtime.spawn(driver.serve());
		Ok(Self { jobs: Some(jobs), waker, children })
	}

	/// The live externals of the run in flight; usable while
	/// [`Session::run`] borrows the session.
	pub fn children(&self) -> Children {
		self.children.clone()
	}

	/// Number of background jobs (`cmd &`) still running an external
	/// process ([`Shell::live_external_jobs`]); jobs of in-engine work only
	/// are not counted. Exited externals are reaped between commands, so
	/// a later `wait` still reports their status.
	///
	/// # Errors
	///
	/// [`SessionError::Closed`] when the session is closed.
	pub async fn live_external_jobs(&self) -> Result<usize, SessionError> {
		let jobs = self.jobs.as_ref().ok_or(SessionError::Closed)?;
		let (reply_tx, reply_rx) = flume::bounded(1);
		jobs
			.send(Request::LiveJobs(reply_tx))
			.map_err(|_| SessionError::Closed)?;
		self.waker.wake_by_ref();
		reply_rx
			.recv_async()
			.await
			.map_err(|_| SessionError::Closed)
	}

	/// Run `command` with `stdio`; see [`Session::run_with`].
	///
	/// # Errors
	///
	/// See [`Session::run_with`].
	pub async fn run(
		&mut self,
		command: &str,
		stdio: RunStdio,
		cancel: CancellationToken,
	) -> Result<RunOutcome, SessionError> {
		self.run_with(RunOptions::new(command), stdio, cancel).await
	}

	/// Run one command to completion and report how it ended.
	///
	/// When `cancel` fires the run is stopped (`TERM`, then `KILL` after
	/// [`TERM_GRACE`]) and the outcome says `cancelled`. Dropping the future
	/// stops the run with `KILL`. A non-zero status (`exit 3`, `set -e`,
	/// `nosuchcmd`) is an outcome, not an error: the session stays usable.
	///
	/// # Errors
	///
	/// [`SessionError::RelativeCwd`] for a relative [`RunOptions::cwd`];
	/// [`SessionError::Closed`] when the session is closed;
	/// [`SessionError::Unresponsive`] (closing the session) when a cancelled
	/// run does not end.
	pub async fn run_with(
		&mut self,
		options: RunOptions,
		stdio: RunStdio,
		cancel: CancellationToken,
	) -> Result<RunOutcome, SessionError> {
		if let Some(cwd) = &options.cwd
			&& !is_absolute(cwd)
		{
			return Err(SessionError::RelativeCwd(cwd.clone()));
		}
		let jobs = self.jobs.as_ref().ok_or(SessionError::Closed)?;
		let level = Arc::new(CancelLevel::default());
		let (reply_tx, reply_rx) = flume::bounded(1);
		let job = Job { options, stdio, cancel: Arc::clone(&level), reply: reply_tx };
		jobs
			.send(Request::Run(job))
			.map_err(|_| SessionError::Closed)?;
		self.waker.wake_by_ref();
		let mut guard = CancelOnDrop { level: &level, waker: &self.waker, armed: true };
		let reply = reply_rx.recv_async();
		tokio::pin!(reply);
		let outcome = tokio::select! {
			r = &mut reply => Some(r),
			() = cancel.cancelled() => None,
		};
		let outcome = if let Some(r) = outcome {
			Some(r)
		} else {
			guard.raise(CancelLevel::TERM);
			if let Ok(r) = tokio::time::timeout(TERM_GRACE, &mut reply).await {
				Some(r)
			} else {
				guard.raise(CancelLevel::KILL);
				tokio::time::timeout(KILL_WAIT, &mut reply).await.ok()
			}
		};
		guard.armed = false;
		drop(guard);
		match outcome {
			Some(Ok(outcome)) => Ok(outcome),
			Some(Err(_)) => {
				self.close();
				Err(SessionError::Closed)
			},
			None => {
				self.close();
				Err(SessionError::Unresponsive)
			},
		}
	}

	/// Stop accepting jobs and let the driver task end (it drops the
	/// shell; externals still running are terminated by the spawner).
	fn close(&mut self) {
		if self.jobs.take().is_some() {
			self.waker.wake_by_ref();
		}
	}
}

impl Drop for Session {
	fn drop(&mut self) {
		self.close();
	}
}

/// Whether `path` is absolute for the engine (a Windows drive path, or a
/// `scheme://` URL path, too).
fn is_absolute(path: &[u8]) -> bool {
	path.first() == Some(&b'/')
		|| (cfg!(windows)
			&& path.get(1) == Some(&b':')
			&& path.first().is_some_and(u8::is_ascii_alphabetic))
		|| path.to_path().is_ok_and(pi_vfs::is_virtual_path)
}

/// Cancellation requested for one run: none, `TERM` or `KILL`.
#[derive(Default)]
struct CancelLevel(AtomicU8);

impl CancelLevel {
	const KILL: u8 = 2;
	const TERM: u8 = 1;

	fn get(&self) -> u8 {
		self.0.load(Ordering::Acquire)
	}
}

/// Escalates the run's cancel level and wakes the driver; stops the run with
/// `KILL` when the run future is dropped before the reply.
struct CancelOnDrop<'a> {
	level: &'a CancelLevel,
	waker: &'a Waker,
	armed: bool,
}

impl CancelOnDrop<'_> {
	fn raise(&self, level: u8) {
		self.level.0.fetch_max(level, Ordering::AcqRel);
		self.waker.wake_by_ref();
	}
}

impl Drop for CancelOnDrop<'_> {
	fn drop(&mut self) {
		if self.armed {
			self.raise(CancelLevel::KILL);
		}
	}
}

/// What the driver is asked to do.
enum Request {
	/// Run a command.
	Run(Job),
	/// Count the background jobs running an external.
	LiveJobs(flume::Sender<usize>),
}

/// One command for the driver.
struct Job {
	options: RunOptions,
	stdio:   RunStdio,
	cancel:  Arc<CancelLevel>,
	reply:   flume::Sender<RunOutcome>,
}

/// The driver task's state: the shell and everything it is stepped with.
struct Driver {
	shell:    Shell,
	store:    MemStore,
	host:     PiHost,
	bell:     Arc<Bell>,
	jobs:     flume::Receiver<Request>,
	children: Children,
	/// The host callouts in flight (`timeout`, `nohup`, `git`).
	tools:    ToolCalls,
}

impl Driver {
	/// Run jobs until the session is closed; step background work between
	/// them.
	async fn serve(mut self) {
		loop {
			match self.jobs.try_recv() {
				Ok(Request::Run(job)) => self.run(job).await,
				Ok(Request::LiveJobs(reply)) => {
					let _ = reply.send(self.shell.live_external_jobs());
				},
				Err(flume::TryRecvError::Disconnected) => break,
				Err(flume::TryRecvError::Empty) => self.idle_turn().await,
			}
		}
	}

	/// One step of background work while no command runs, or a suspension
	/// when there is none to do (a new job's ring ends it).
	async fn idle_turn(&mut self) {
		self.poll_tools();
		match self.step(Budget::default()) {
			Step::Done { run, status } => self.on_done(run, status),
			Step::Call { id, call } => self.on_call(id, call),
			Step::Yield => tokio::task::yield_now().await,
			Step::Blocked | Step::Paused => self.wait().await,
			Step::Idle => self.idle().await,
			Step::SuspendReady => {},
		}
	}

	/// Run one job to completion and send its outcome.
	async fn run(&mut self, job: Job) {
		let Job { options, stdio, cancel, reply } = job;
		let RunOptions { command, env, cwd, pipe_tap, reported_error, text_capture } = options;
		self.host.set_pipe_tap(pipe_tap);
		self.host.set_reported_error(reported_error);
		// The values the overlay hides, restored after the run.
		let saved: Vec<(BString, Option<Record>)> = env
			.iter()
			.map(|(name, _)| (name.clone(), self.store.record(Key::Var(name.as_bstr())).cloned()))
			.collect();
		self
			.host
			.streams()
			.install([stdio.stdin, stdio.stdout, stdio.stderr], text_capture);
		self.shell.reset_root_stdio(&mut self.host);
		self.children.set_active(true);
		let run = self.shell.submit(Script {
			cwd,
			env,
			vproc: VprocSel::Root,
			..Script::command(command.as_bytes())
		});
		let mut applied = 0;
		let status = loop {
			let wanted = cancel.get();
			if wanted > applied {
				applied = wanted;
				let sig = if wanted >= CancelLevel::KILL {
					Signal::Kill
				} else {
					Signal::Term
				};
				self.shell.control().cancel(sig);
			}
			self.poll_tools();
			match self.step(Budget::default()) {
				Step::Done { run: done, status } if done == run => break status,
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				Step::Yield => tokio::task::yield_now().await,
				Step::Blocked | Step::Paused => self.wait().await,
				Step::SuspendReady => {},
				// Unreachable while the run is queued (its `Done` is reported
				// before `Idle`); end the run rather than spin.
				Step::Idle => break 1,
			}
		};
		if applied > 0 {
			// A cancel that raced the run's natural end is still pending:
			// apply it now (it ends background work too, as pi's cancel
			// does), not at the start of the next command.
			match self.step(Budget { max_ops: 1, max_ns: u64::MAX }) {
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				_ => {},
			}
		}
		let exited = self.shell.ended_by_exit(run);
		self.settle().await;
		self.children.set_active(false);
		self.host.streams().clear();
		self.host.set_pipe_tap(None);
		self.host.set_reported_error(None);
		self.restore_overlay(saved);
		let cwd = match self.store.record(Key::Misc(MiscKey::Cwd)) {
			Some(Record::Misc(cwd)) => cwd.clone(),
			_ => BString::default(),
		};
		// The caller may have stopped waiting (dropped future).
		let _ = reply.send(RunOutcome { status, cancelled: applied > 0, exited, cwd });
	}

	/// Let the background work a command started reach its first wait (an
	/// external spawned, a pipe read) before the command reports, so the
	/// caller's next look at the session (`live_external_jobs`) sees what the
	/// command left running. Bounded: a busy background loop never waits.
	async fn settle(&mut self) {
		for _ in 0..SETTLE_STEPS {
			self.poll_tools();
			match self.step(Budget::default()) {
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				Step::Yield => tokio::task::yield_now().await,
				Step::SuspendReady => {},
				Step::Blocked | Step::Paused | Step::Idle => break,
			}
		}
	}

	/// Put back the variables a run's env overlay replaced, newest first so
	/// a name given twice ends at its original value.
	fn restore_overlay(&mut self, saved: Vec<(BString, Option<Record>)>) {
		for (name, record) in saved.into_iter().rev() {
			let key = Key::Var(name.as_bstr());
			match record {
				// A variable record always fits a variable key.
				Some(record) => drop(self.store.put_out_of_band(key, record)),
				None => self.store.del_out_of_band(key),
			}
		}
	}

	/// A script other than the current command finished: a subshell of a
	/// host callout ([`ToolCalls::on_done`]); nothing else submits scripts.
	fn on_done(&mut self, run: RunId, status: i32) {
		let signal = self.shell.exec_signal(run);
		self.tools.on_done(run, status, signal);
	}

	/// Start a host callout ([`crate::bash::Resolved::Tool`]).
	fn on_call(&mut self, id: CallId, call: ToolCall) {
		let mut cx = Cx { host: &mut self.host, store: &mut self.store };
		self.tools.on_call(&mut self.shell, &mut cx, id, call);
	}

	/// Let the host callouts in flight make progress (answering the calls
	/// that finished).
	fn poll_tools(&mut self) {
		let mut cx = Cx { host: &mut self.host, store: &mut self.store };
		self.tools.poll(&mut self.shell, &mut cx);
	}

	fn step(&mut self, budget: Budget) -> Step {
		self
			.shell
			.step(&mut Cx { host: &mut self.host, store: &mut self.store }, budget)
	}

	/// Suspend until the shell may make progress, a job or cancel request
	/// rings the bell, or a host callout's deadline comes.
	///
	/// The future owns what it waits on, so it does not hold the driver.
	fn wait(&self) -> impl Future<Output = ()> + Send + use<> {
		let ctl = self.shell.control();
		let bell = Arc::clone(&self.bell);
		let now = crate::bash::Host::now_ns(&self.host);
		let limit = self
			.tools
			.next_deadline()
			.map_or(MAX_PARK, |at| Duration::from_nanos(at.saturating_sub(now)).min(MAX_PARK));
		async move {
			tokio::select! {
				biased;
				() = poll_fn(|cx| ctl.poll_runnable(cx)) => {},
				() = bell.0.notified() => {},
				() = tokio::time::sleep(limit) => {},
			}
		}
	}

	/// Suspend while there is nothing to run: until a job, a tool worker
	/// or the loss-bound timeout rings.
	fn idle(&self) -> impl Future<Output = ()> + Send + use<> {
		let bell = Arc::clone(&self.bell);
		async move {
			tokio::select! {
				biased;
				() = bell.0.notified() => {},
				() = tokio::time::sleep(MAX_PARK) => {},
			}
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{io, io::Read, os::unix::ffi::OsStrExt, time::Instant};

	use super::*;
	use crate::sys::StdFs;

	fn session() -> Session {
		let env = std::env::vars_os()
			.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
			.collect();
		let cwd = std::env::current_dir().unwrap();
		Session::new(SessionConfig {
			env,
			cwd: BString::from(cwd.as_os_str().as_bytes()),
			fs: Box::new(StdFs::default()),
			vfs: None,
			runtime: tokio::runtime::Handle::current(),
			output_decoding: None,
		})
		.unwrap()
	}

	/// A command's outcome and its stdout and stderr, read through pipes on
	/// threads (the pipes are drained while the command runs).
	struct Captured {
		outcome: RunOutcome,
		stdout:  String,
		stderr:  String,
	}

	async fn capture(session: &mut Session, options: RunOptions) -> Captured {
		let (out_r, out_w) = io::pipe().unwrap();
		let (err_r, err_w) = io::pipe().unwrap();
		let drain = |mut r: io::PipeReader| {
			std::thread::spawn(move || {
				let mut s = String::new();
				r.read_to_string(&mut s).unwrap();
				s
			})
		};
		let (out, err) = (drain(out_r), drain(err_r));
		let stdio = RunStdio {
			stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
			stdout: Some(std::fs::File::from(std::os::fd::OwnedFd::from(out_w))),
			stderr: Some(std::fs::File::from(std::os::fd::OwnedFd::from(err_w))),
		};
		let outcome = session
			.run_with(options, stdio, CancellationToken::new())
			.await
			.unwrap();
		Captured { outcome, stdout: out.join().unwrap(), stderr: err.join().unwrap() }
	}

	async fn sh(session: &mut Session, command: &str) -> Captured {
		capture(session, RunOptions::new(command)).await
	}

	fn alive(pid: i32) -> bool {
		// SAFETY: signal 0 only probes existence.
		unsafe { libc::kill(pid, 0) == 0 }
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn echo_is_captured_through_a_pipe() {
		let mut s = session();
		let c = sh(&mut s, "echo hi").await;
		assert_eq!((c.outcome.status, c.stdout.as_str()), (0, "hi\n"));
		assert!(!c.outcome.cancelled);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn exec_standard_redirections_end_at_run_boundary() {
		let mut s = session();
		let first = sh(&mut s, "exec >/dev/null; echo hidden").await;
		assert_eq!(first.stdout, "");
		assert_eq!(sh(&mut s, "echo hi").await.stdout, "hi\n");

		sh(&mut s, "exec 2>/dev/null").await;
		let missing = sh(&mut s, "ls /nope").await;
		assert_ne!(missing.outcome.status, 0);
		assert!(missing.stderr.contains("/nope"), "stderr: {:?}", missing.stderr);

		let dir = tempfile::tempdir().unwrap();
		let input = dir.path().join("input");
		std::fs::write(&input, "first\nsecond\n").unwrap();
		let command = format!("exec <'{}'; read -r x; echo \"$x\"", input.display());
		assert_eq!(sh(&mut s, &command).await.stdout, "first\n");
		assert_eq!(sh(&mut s, "read -r x || echo eof").await.stdout, "eof\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn exec_higher_fds_persist_across_runs() {
		let mut s = session();
		let dir = tempfile::tempdir().unwrap();
		let output = dir.path().join("output");
		let command = format!("exec 3>'{}' 4>&1", output.display());
		assert_eq!(sh(&mut s, &command).await.outcome.status, 0);
		let c = sh(&mut s, "echo file >&3; echo captured >&4").await;
		assert_eq!(c.stdout, "captured\n");
		assert_eq!(std::fs::read_to_string(output).unwrap(), "file\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn background_output_stays_with_starting_run() {
		for command in [
			"(sleep 0.3; echo late) &",
			"(sleep 0.3; /bin/echo late) &",
			"{ sleep 0.3; echo late >&2; } &",
		] {
			let mut s = session();
			s.run(command, RunStdio::default(), CancellationToken::new())
				.await
				.unwrap();
			let next = sh(&mut s, "sleep 1; echo second").await;
			assert_eq!(next.stdout, "second\n", "{command}");
			assert_eq!(next.stderr, "", "{command}");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn background_output_is_captured_when_waited_in_starting_run() {
		let mut s = session();
		let c = sh(&mut s, "(sleep 0.1; echo job; echo error >&2) & wait").await;
		assert_eq!((c.outcome.status, c.stdout.as_str(), c.stderr.as_str()), (0, "job\n", "error\n"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn background_external_holding_pipe_does_not_delay_run() {
		let mut s = session();
		let (_reader, writer) = io::pipe().unwrap();
		let stdio = RunStdio {
			stdout: Some(std::fs::File::from(std::os::fd::OwnedFd::from(writer))),
			..RunStdio::default()
		};
		let outcome = tokio::time::timeout(
			Duration::from_secs(1),
			s.run("/bin/sleep 2 &", stdio, CancellationToken::new()),
		)
		.await
		.expect("a background external holding stdout must not delay the run")
		.unwrap();
		assert_eq!(outcome.status, 0);
		assert_eq!(sh(&mut s, "wait %1").await.outcome.status, 0);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn background_job_remains_waitable_in_later_run() {
		let mut s = session();
		s.run("(sleep 0.1; exit 7) &", RunStdio::default(), CancellationToken::new())
			.await
			.unwrap();
		assert_eq!(sh(&mut s, "sleep 0.3; wait %1").await.outcome.status, 7);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn statuses_follow_bash() {
		let mut s = session();
		assert_eq!(sh(&mut s, "false").await.outcome.status, 1);
		let c = sh(&mut s, "nosuchcmd").await;
		assert_eq!(c.outcome.status, 127);
		assert!(c.stderr.contains("nosuchcmd: command not found"), "stderr: {:?}", c.stderr);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn state_persists_across_runs() {
		let mut s = session();
		let dir = tempfile::tempdir().unwrap();
		let dir = dir.path().canonicalize().unwrap();
		let cd = format!("x=41; f() {{ echo \"f$((x + 1))\"; }}; cd '{}'", dir.display());
		assert_eq!(sh(&mut s, &cd).await.outcome.status, 0);
		let c = sh(&mut s, "f; pwd").await;
		assert_eq!(c.stdout, format!("f42\n{}\n", dir.display()));
		assert_eq!(c.outcome.cwd, BString::from(dir.as_os_str().as_bytes()));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn per_run_env_is_visible_in_that_run_only() {
		let mut s = session();
		sh(&mut s, "KEEP=old").await;
		let options = RunOptions {
			env: vec![("ONLY".into(), "one".into()), ("KEEP".into(), "new".into())],
			..RunOptions::new("echo \"$ONLY $KEEP\"; env | grep '^ONLY='")
		};
		let c = capture(&mut s, options).await;
		assert_eq!(c.stdout, "one new\nONLY=one\n");
		let c = sh(&mut s, "echo \"${ONLY-unset} $KEEP\"").await;
		assert_eq!(c.stdout, "unset old\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn cwd_override_applies_and_persists() {
		let mut s = session();
		let dir = tempfile::tempdir().unwrap();
		let dir = dir.path().canonicalize().unwrap();
		let path = BString::from(dir.as_os_str().as_bytes());
		let options = RunOptions { cwd: Some(path.clone()), ..RunOptions::new("/bin/pwd") };
		let c = capture(&mut s, options).await;
		assert_eq!(c.stdout, format!("{}\n", dir.display()));
		assert_eq!(sh(&mut s, "pwd").await.outcome.cwd, path);
		let err = s
			.run_with(
				RunOptions { cwd: Some("rel".into()), ..RunOptions::new(":") },
				RunStdio::default(),
				CancellationToken::new(),
			)
			.await
			.unwrap_err();
		assert!(matches!(err, SessionError::RelativeCwd(_)));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn exit_ends_the_command_not_the_session() {
		let mut s = session();
		assert_eq!(sh(&mut s, "y=7; exit 3; y=8").await.outcome.status, 3);
		assert_eq!(sh(&mut s, "set -e; false; echo no").await.outcome.status, 1);
		let c = sh(&mut s, "echo $y").await;
		assert_eq!((c.outcome.status, c.stdout.as_str()), (0, "7\n"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn outcome_says_whether_exit_ended_the_command() {
		let mut s = session();
		assert!(!sh(&mut s, "false").await.outcome.exited);
		assert!(sh(&mut s, "exit 0").await.outcome.exited);
		assert!(sh(&mut s, "set -e; false; echo no").await.outcome.exited);
		assert!(!sh(&mut s, "set +e; (exit 4)").await.outcome.exited);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn live_external_jobs_counts_background_externals_until_they_end() {
		let mut s = session();
		assert_eq!(s.live_external_jobs().await.unwrap(), 0);
		// The sleep writes elsewhere: holding the captured pipes, as an
		// external started in the background does, it would keep `capture`
		// reading until it exits.
		let started = sh(&mut s, "/bin/sleep 30 >/dev/null 2>&1 & { :; } &").await;
		assert_eq!(started.outcome.status, 0);
		assert_eq!(s.live_external_jobs().await.unwrap(), 1);
		assert_eq!(sh(&mut s, "kill %1; wait %1").await.outcome.status, 143);
		assert_eq!(s.live_external_jobs().await.unwrap(), 0);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn pipe_taps_and_reported_errors_last_one_run() {
		#[derive(Default)]
		struct Taps(Mutex<Vec<(String, String, Arc<Mirror>)>>);
		#[derive(Default)]
		struct Mirror(Mutex<(Vec<u8>, bool)>);
		impl PipeTap for Taps {
			fn open(
				&self,
				producer: &bstr::BStr,
				consumer: &bstr::BStr,
			) -> Option<Arc<dyn crate::bash::PipeMirror>> {
				let mirror = Arc::new(Mirror::default());
				self
					.0
					.lock()
					.push((producer.to_string(), consumer.to_string(), Arc::clone(&mirror)));
				Some(mirror)
			}
		}
		impl crate::bash::PipeMirror for Mirror {
			fn write(&self, bytes: &[u8]) {
				self.0.lock().0.extend_from_slice(bytes);
			}

			fn close(&self) {
				self.0.lock().1 = true;
			}
		}

		let mut s = session();
		let taps = Arc::new(Taps::default());
		let options = RunOptions {
			pipe_tap: Some(Arc::clone(&taps) as Arc<dyn PipeTap>),
			reported_error: Some(Arc::new(AtomicBool::new(false))),
			..RunOptions::new("printf 'x\\ny\\n' | /usr/bin/sort -r")
		};
		let c = capture(&mut s, options).await;
		assert_eq!(c.stdout, "y\nx\n");
		{
			let taps = taps.0.lock();
			let [(producer, consumer, mirror)] = taps.as_slice() else {
				panic!("one tapped pipe: {}", taps.len());
			};
			assert!(producer.starts_with("printf") && consumer.contains("sort"));
			assert_eq!(*mirror.0.lock(), (b"x\ny\n".to_vec(), true));
		}
		// The next run is untapped.
		sh(&mut s, "printf z | /usr/bin/sort").await;
		assert_eq!(taps.0.lock().len(), 1);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn url_paths_are_absolute_working_directories() {
		let mut s = session();
		// No provider serves the scheme: the directory check fails, the
		// path is not joined onto the current directory.
		let c = sh(&mut s, "cd virtual://nowhere").await;
		assert_ne!(c.outcome.status, 0);
		assert!(c.stderr.contains("virtual://nowhere"), "stderr: {:?}", c.stderr);
		assert!(!c.stderr.contains("/virtual:"), "joined onto the cwd: {:?}", c.stderr);
		let options = RunOptions { cwd: Some("virtual://dir".into()), ..RunOptions::new(":") };
		let outcome = s
			.run_with(options, RunStdio::default(), CancellationToken::new())
			.await
			.unwrap();
		assert_eq!(outcome.cwd, "virtual://dir");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn pipeline_into_an_external() {
		let mut s = session();
		let c = sh(&mut s, "printf 'a\\nb\\n' | /usr/bin/sort -r").await;
		assert_eq!((c.outcome.status, c.stdout.as_str()), (0, "b\na\n"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn external_runs_in_its_own_session_and_cancel_stops_it() {
		let mut s = session();
		let children = s.children();
		let cancel = CancellationToken::new();
		let probe = {
			let cancel = cancel.clone();
			let children = children.clone();
			async move {
				let pid = loop {
					if let Some(&pid) = children.pids().first() {
						break pid;
					}
					tokio::time::sleep(Duration::from_millis(10)).await;
				};
				// SAFETY: getpgid/getsid/getpgrp only read process ids.
				let ids = unsafe { (libc::getpgid(pid), libc::getsid(pid), libc::getpgrp()) };
				cancel.cancel();
				(pid, ids)
			}
		};
		let started = Instant::now();
		let (outcome, (pid, (pgid, sid, own_group))) =
			tokio::join!(s.run("/bin/sleep 30", RunStdio::default(), cancel.clone()), probe);
		let outcome = outcome.unwrap();
		assert!(outcome.cancelled);
		assert_eq!(outcome.status, 143);
		assert!(started.elapsed() < Duration::from_secs(5), "cancel took {:?}", started.elapsed());
		assert_eq!((pgid, sid), (pid, pid), "the external leads its own session");
		assert_ne!(pgid, own_group);
		assert!(children.pids().is_empty(), "no run in flight");
		let gone = Instant::now();
		while alive(pid) && gone.elapsed() < Duration::from_secs(3) {
			tokio::time::sleep(Duration::from_millis(20)).await;
		}
		assert!(!alive(pid), "sleep {pid} survived the cancel");
		// The session is still usable.
		assert_eq!(sh(&mut s, "echo ok").await.stdout, "ok\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trapped_term_escalates_to_kill() {
		let mut s = session();
		let cancel = CancellationToken::new();
		let trigger = cancel.clone();
		tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(200)).await;
			trigger.cancel();
		});
		let started = Instant::now();
		let outcome = s
			.run("trap 'while :; do :; done' TERM; while :; do :; done", RunStdio::default(), cancel)
			.await
			.unwrap();
		assert!(outcome.cancelled);
		assert_eq!(outcome.status, 137);
		assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
	}

	#[test]
	fn signals_to_pi_and_its_ancestors_are_refused() {
		use crate::host::check_signal_target;
		let me = i32::try_from(std::process::id()).unwrap();
		// SAFETY: getppid/getpgrp have no preconditions.
		let (parent, group) = unsafe { (libc::getppid(), libc::getpgrp()) };
		for pid in [me, parent, 0, -1, -group] {
			let err = check_signal_target(pid).unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "pid {pid}");
		}
		let mut child = std::process::Command::new("/bin/sleep")
			.arg("5")
			.spawn()
			.unwrap();
		let pid = i32::try_from(child.id()).unwrap();
		assert!(check_signal_target(pid).is_ok());
		child.kill().unwrap();
		child.wait().unwrap();
	}
}
