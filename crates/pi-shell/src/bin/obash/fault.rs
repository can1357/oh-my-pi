//! The `obash` fault injector.
//!
//! `--fault=SEED:K` (or `PI_SHELL_FAULT=SEED:K`) runs the script under one of
//! three modes, chosen by `--fault-mode` or `PI_SHELL_FAULT_MODE`:
//!
//! - `step` (default): every K ops a coin seeded with SEED chooses between
//!   pause → `Paused` → resume and a snapshot restored in this process
//!   (externalize → drop the shell → new engine and store image → restore).
//! - `pause`: after every op, with probability 1/K, pause → `Paused` → resume.
//! - `exec` (Unix): every K ops a snapshot restored in a new process image. The
//!   running binary re-executes itself with the serialized store in an
//!   inherited, unlinked temp file and the continuation (run id, event mask,
//!   nesting depth, clock, signal state, counters) on its command line
//!   (`--fault-resume`). Signals stay blocked across the `exec` until the new
//!   image has re-installed the trap dispositions, so pending signals are
//!   delivered to the restored shell.
//!
//! A snapshot whose externalize reports something lost (externals in flight,
//! tasks without checkpoints, open OS handles) is not restored under
//! `PI_SHELL_FAULT_LOST=skip` (the default): the shell runs
//! on and snapshots again K ops later. Under `defer` the shell runs on too,
//! but the snapshot is retried at every following safepoint until one loses
//! nothing (then the next K ops count from there). Under `restore` it is
//! restored anyway and the losses go to `PI_SHELL_LOST_LOG` as `lost …`
//! lines, which make a conformance harness exclude the run.
//! `PI_SHELL_FAULT_STATS=PATH` appends one line of counters per process when
//! it exits. Nested obash instances
//! (`${THIS_SH}`) add their depth (`PI_SHELL_FAULT_DEPTH`) to the seed.

use std::{
	ffi::OsString,
	fmt::Write as _,
	fs,
	io::{self, Write},
	path::PathBuf,
	task::Context,
	time::Duration,
};

use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, EventMask, ExtError,
		ExternalizeReport, Lost, MemStore, Platform, RestoreError, RestoreOpts, RunId, Shell, SigSet,
		Signal, Step, StoreError, Vpid,
	},
	sys::Parker,
	testkit::Rng,
};

use crate::host::NativeHost;

/// Environment variable counting nested obash instances under a fault run.
pub const FAULT_DEPTH: &str = "PI_SHELL_FAULT_DEPTH";

/// What the injector does at its safepoints (`--fault-mode`,
/// `PI_SHELL_FAULT_MODE`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum Mode {
	/// Every K ops a seeded coin: pause/resume or an in-process snapshot.
	#[default]
	Step,
	/// After every op, pause/resume with probability 1/K.
	Pause,
	/// Every K ops a snapshot restored in a new process image (Unix).
	Exec,
}

impl Mode {
	/// The name in flags, the environment and the stats line.
	const fn name(self) -> &'static str {
		match self {
			Self::Step => "step",
			Self::Pause => "pause",
			Self::Exec => "exec",
		}
	}
}

/// What to do with a snapshot whose externalize reports losses
/// (`PI_SHELL_FAULT_LOST`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LostPolicy {
	/// Keep the running shell and snapshot again later.
	#[default]
	Skip,
	/// Restore anyway and log the losses (the kit marks the run lost).
	Restore,
	/// Keep the running shell and try the snapshot again at every following
	/// safepoint until one loses nothing; the next K ops count from there.
	Defer,
}

/// The injector's command-line options, flattened into obash's own.
#[derive(clap::Args, Debug, Default)]
pub struct FaultArgs {
	/// Inject faults: `SEED:K` (see `--fault-mode`). A snapshot whose
	/// externalize reports anything lost is not restored unless
	/// `PI_SHELL_FAULT_LOST=restore` (`defer` retries it at every
	/// following safepoint).
	#[arg(long, value_name = "SEED:K", value_parser = parse_fault)]
	pub fault:        Option<(u64, u32)>,
	/// `step` (pause/resume or an in-process snapshot every K ops, by a
	/// seeded coin), `pause` (pause/resume with probability 1/K after every
	/// op) or `exec` (a snapshot every K ops, restored in a new process).
	#[arg(long, value_enum, value_name = "MODE")]
	pub fault_mode:   Option<Mode>,
	/// Continue an `exec`-mode snapshot; obash passes it to itself.
	#[arg(long, hide = true, value_name = "STATE")]
	pub fault_resume: Option<String>,
}

/// Parse `SEED:K` (K ≥ 1).
///
/// # Errors
///
/// A message naming the malformed part.
pub fn parse_fault(s: &str) -> Result<(u64, u32), String> {
	let (seed, k) = s.split_once(':').ok_or("expected SEED:K")?;
	let seed = seed.parse().map_err(|_| format!("bad seed `{seed}'"))?;
	let k: u32 = k.parse().map_err(|_| format!("bad K `{k}'"))?;
	if k == 0 {
		return Err("K must be at least 1".into());
	}
	Ok((seed, k))
}

/// A failure of the injector itself (never of the script).
#[derive(Debug, thiserror::Error)]
pub enum FaultError {
	/// A fault variable holds a value obash does not know.
	#[error("{name}: invalid value `{value}'")]
	Env {
		/// The variable.
		name:  &'static str,
		/// Its value.
		value: String,
	},
	/// `--fault-resume` does not hold a continuation obash wrote.
	#[error("--fault-resume: invalid continuation `{0}'")]
	Resume(String),
	/// `exec` mode needs `exec(2)`.
	#[error("fault mode `exec' re-executes the running binary, which needs Unix")]
	ExecUnsupported,
	/// A pause did not stop the shell at the next safepoint.
	#[error("a pause did not stop the shell at the next safepoint (got {step})")]
	NotPaused {
		/// What `step` returned instead.
		step: String,
	},
	/// Externalize failed.
	#[error("could not snapshot the shell")]
	Externalize(#[from] ExtError),
	/// Restore failed.
	#[error("could not restore the shell")]
	Restore(#[from] RestoreError),
	/// The store image does not decode.
	#[error("could not decode the store image")]
	Store(#[from] StoreError),
	/// Writing, passing or reading the image, or the signal mask, failed.
	#[error("could not hand the snapshot over")]
	Io(#[from] io::Error),
	/// `exec(2)` of the running binary failed.
	#[error("could not re-execute obash")]
	#[cfg_attr(not(unix), expect(dead_code, reason = "only Unix re-executes"))]
	Exec(#[source] io::Error),
}

/// The fault variables of the environment (nested `${THIS_SH}` instances
/// inherit them).
#[derive(Debug, Default)]
pub struct Env {
	/// `PI_SHELL_FAULT=SEED:K`.
	pub fault:    Option<(u64, u32)>,
	/// `PI_SHELL_FAULT_DEPTH`: nesting depth, added to the seed.
	pub depth:    u64,
	/// `PI_SHELL_FAULT_MODE=step|pause|exec`.
	pub mode:     Option<Mode>,
	/// `PI_SHELL_FAULT_LOST=skip|restore`.
	pub lost:     LostPolicy,
	/// `PI_SHELL_LOST_LOG=PATH`: where restored losses are appended.
	pub lost_log: Option<PathBuf>,
	/// `PI_SHELL_FAULT_STATS=PATH`: where the per-process counters go.
	pub stats:    Option<PathBuf>,
}

impl Env {
	/// Read the fault variables; empty ones count as unset.
	///
	/// # Errors
	///
	/// [`FaultError::Env`] for a malformed value.
	pub fn from_env() -> Result<Self, FaultError> {
		let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
		let text = |name: &'static str| var(name).map(|v| (name, v.to_string_lossy().into_owned()));
		let bad = |name: &'static str, value: String| FaultError::Env { name, value };
		let fault = match text("PI_SHELL_FAULT") {
			Some((name, v)) => Some(parse_fault(&v).map_err(|_| bad(name, v))?),
			None => None,
		};
		let depth = match text(FAULT_DEPTH) {
			Some((name, v)) => v.parse().map_err(|_| bad(name, v))?,
			None => 0,
		};
		let mode = match text("PI_SHELL_FAULT_MODE") {
			Some((name, v)) => {
				Some(<Mode as clap::ValueEnum>::from_str(&v, false).map_err(|_| bad(name, v))?)
			},
			None => None,
		};
		let lost = match text("PI_SHELL_FAULT_LOST") {
			Some((_, v)) if v == "skip" => LostPolicy::Skip,
			Some((_, v)) if v == "restore" => LostPolicy::Restore,
			Some((_, v)) if v == "defer" => LostPolicy::Defer,
			Some((name, v)) => return Err(bad(name, v)),
			None => LostPolicy::Skip,
		};
		Ok(Self {
			fault,
			depth,
			mode,
			lost,
			lost_log: var("PI_SHELL_LOST_LOG").map(PathBuf::from),
			stats: var("PI_SHELL_FAULT_STATS").map(PathBuf::from),
		})
	}
}

/// An active fault plan.
#[derive(Clone, Copy, Debug)]
struct Plan {
	seed: u64,
	k:    u32,
	mode: Mode,
	lost: LostPolicy,
}

/// Counters of one process, written to `PI_SHELL_FAULT_STATS` at exit; an
/// `exec`-mode re-execution keeps the pid and carries them over.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Stats {
	/// Snapshots taken (externalize calls).
	snapshots:    u64,
	/// Snapshots restored.
	restored:     u64,
	/// Snapshots not restored because something would be lost.
	skipped:      u64,
	/// … of which lost an external in flight.
	skipped_ext:  u64,
	/// … a task without a checkpoint.
	skipped_task: u64,
	/// … an open OS handle (an fd, or a pipe read in flight).
	skipped_fd:   u64,
	/// Snapshots restored although something was lost (`restore` policy).
	lost:         u64,
	/// Pauses injected.
	pauses:       u64,
	/// Snapshots retried at the next safepoint (`defer` policy; each also
	/// counts as skipped).
	deferred:     u64,
}

impl Stats {
	/// Count a skipped snapshot once per kind of loss it reported.
	fn skip(&mut self, lost: &[Lost]) {
		self.skipped += 1;
		if lost.iter().any(|l| matches!(l, Lost::Ext { .. })) {
			self.skipped_ext += 1;
		}
		if lost.iter().any(|l| matches!(l, Lost::Task { .. })) {
			self.skipped_task += 1;
		}
		if lost
			.iter()
			.any(|l| matches!(l, Lost::Fd { .. } | Lost::Pending { .. }))
		{
			self.skipped_fd += 1;
		}
	}
}

/// What an `exec`-mode process passes to its successor on the command line
/// (`--fault-resume=key=value,…`); the store image travels in the fd.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resume {
	/// The inherited fd holding the store image.
	image_fd: i32,
	/// The script whose status is obash's exit status.
	run:      RunId,
	/// The shell's event mask.
	events:   u64,
	/// The nesting depth of the first process (seeds its coin).
	depth:    u64,
	/// The host clock (`now_ns`) at the snapshot.
	clock_ns: u64,
	/// The OS numbers (bit n - 1) of the signals ignored on entry.
	ignored:  u64,
	/// The signal mask to reinstate (bit n - 1) once the traps are back.
	sigmask:  u64,
	/// The counters so far.
	stats:    Stats,
}

impl Resume {
	#[cfg(any(unix, test))]
	fn encode(&self) -> String {
		let s = &self.stats;
		format!(
			"img={},run={},events={},depth={},clock={},ignored={},sigmask={},snapshots={},\
			 restored={},skipped={},skipped_ext={},skipped_task={},skipped_fd={},lost={},pauses={},\
			 deferred={}",
			self.image_fd,
			self.run.0,
			self.events,
			self.depth,
			self.clock_ns,
			self.ignored,
			self.sigmask,
			s.snapshots,
			s.restored,
			s.skipped,
			s.skipped_ext,
			s.skipped_task,
			s.skipped_fd,
			s.lost,
			s.pauses,
			s.deferred,
		)
	}

	/// Parse what [`Self::encode`] wrote.
	///
	/// # Errors
	///
	/// [`FaultError::Resume`] for anything else.
	pub fn decode(text: &str) -> Result<Self, FaultError> {
		let bad = || FaultError::Resume(text.to_owned());
		let mut r = Self {
			image_fd: -1,
			run:      RunId(0),
			events:   0,
			depth:    0,
			clock_ns: 0,
			ignored:  0,
			sigmask:  0,
			stats:    Stats::default(),
		};
		let mut run = None;
		for field in text.split(',') {
			let (key, value) = field.split_once('=').ok_or_else(bad)?;
			let value: u64 = value.parse().map_err(|_| bad())?;
			let s = &mut r.stats;
			match key {
				"img" => r.image_fd = i32::try_from(value).map_err(|_| bad())?,
				"run" => run = Some(RunId(value)),
				"events" => r.events = value,
				"depth" => r.depth = value,
				"clock" => r.clock_ns = value,
				"ignored" => r.ignored = value,
				"sigmask" => r.sigmask = value,
				"snapshots" => s.snapshots = value,
				"restored" => s.restored = value,
				"skipped" => s.skipped = value,
				"skipped_ext" => s.skipped_ext = value,
				"skipped_task" => s.skipped_task = value,
				"skipped_fd" => s.skipped_fd = value,
				"lost" => s.lost = value,
				"pauses" => s.pauses = value,
				"deferred" => s.deferred = value,
				_ => return Err(bad()),
			}
		}
		r.run = run.ok_or_else(bad)?;
		if r.image_fd < 3 {
			return Err(bad());
		}
		Ok(r)
	}

	/// The script whose status obash exits with.
	pub const fn run(&self) -> RunId {
		self.run
	}

	/// The depth of the first process.
	pub const fn depth(&self) -> u64 {
		self.depth
	}

	/// The host clock to continue from.
	pub const fn clock_ns(&self) -> u64 {
		self.clock_ns
	}

	/// The signals ignored when the first process started.
	pub fn ignored(&self) -> SigSet {
		set_of_bits(self.ignored)
	}

	/// The event mask of the shell.
	pub const fn mask(&self) -> EventMask {
		EventMask::from_bits(self.events)
	}
}

/// OS signal numbers of `set` as bits (n - 1).
#[cfg(any(unix, test))]
fn bits_of_set(set: SigSet) -> u64 {
	set.iter()
		.map(|sig| sig.number(Platform::current()))
		.filter(|n| (1..=64).contains(n))
		.fold(0, |bits, n| bits | (1u64 << (n - 1)))
}

/// The signals whose OS numbers are the bits (n - 1) of `bits`.
fn set_of_bits(bits: u64) -> SigSet {
	(1..=64u8)
		.filter(|n| bits & (1u64 << (n - 1)) != 0)
		.filter_map(|n| Signal::from_number(n, Platform::current()))
		.fold(SigSet::EMPTY, SigSet::with)
}

/// A shell and everything a restore replaces, as the run loop owns it.
pub struct Parts {
	/// Engine configuration (restores build a new engine from it; the
	/// shell holds its own).
	pub cfg:   EngineConfig,
	/// The host; it survives in-process restores.
	pub host:  NativeHost,
	/// The store; replaced by its own image at every snapshot.
	pub store: MemStore,
	/// The shell.
	pub shell: Shell,
	/// The script whose status obash exits with.
	pub run:   RunId,
	/// The event mask restored shells get.
	pub mask:  EventMask,
}

/// The injector: the active plan, its coin and counters. obash's run loop
/// is [`Injector::drive`], with or without a plan.
pub struct Injector {
	plan:     Option<Plan>,
	/// The nesting depth, passed on to an `exec`-mode successor.
	#[cfg(unix)]
	depth:    u64,
	coin:     Rng,
	stats:    Stats,
	lost_log: Option<PathBuf>,
	stats_to: Option<PathBuf>,
	/// obash's own options a re-executed process needs again (events).
	#[cfg(unix)]
	own_args: Vec<OsString>,
	/// The signal mask before signals were blocked for an `exec`.
	#[cfg(unix)]
	held:     Option<u64>,
	/// A deferred snapshot is retried at the next safepoint.
	pending:  bool,
	/// Where the drive loop blocks while the shell waits (it also waits for
	/// the exits of externals itself, Linux).
	parker:   Parker,
}

impl Injector {
	/// The plan from `args` (taking precedence) and `env`; `depth` is the
	/// nesting depth (from `env`, or the first process's after a re-exec);
	/// `own_args` are the options an `exec`-mode successor gets again.
	///
	/// # Errors
	///
	/// [`FaultError::ExecUnsupported`] for `exec` mode off Unix.
	pub fn new(
		args: &FaultArgs,
		env: Env,
		depth: u64,
		own_args: Vec<OsString>,
	) -> Result<Self, FaultError> {
		let plan = args.fault.or(env.fault).map(|(seed, k)| Plan {
			seed,
			k,
			mode: args.fault_mode.or(env.mode).unwrap_or_default(),
			lost: env.lost,
		});
		if cfg!(not(unix)) && plan.is_some_and(|p| p.mode == Mode::Exec) {
			return Err(FaultError::ExecUnsupported);
		}
		#[cfg(not(unix))]
		let _ = own_args;
		Ok(Self {
			coin: Rng::new(plan.map_or(0, |p| p.seed.wrapping_add(depth))),
			plan,
			#[cfg(unix)]
			depth,
			stats: Stats::default(),
			lost_log: env.lost_log,
			stats_to: env.stats,
			#[cfg(unix)]
			own_args,
			#[cfg(unix)]
			held: None,
			pending: false,
			parker: Parker::new(),
		})
	}

	/// Restore the shell an `exec`-mode predecessor externalized: the image
	/// from the inherited fd (closed afterwards) and the counters; signal
	/// dispositions `trap ''` left behind are reset. Call before
	/// [`Shell::restore`]; signals stay blocked until [`Self::resumed`].
	///
	/// # Errors
	///
	/// [`FaultError::Io`] when the fd cannot be read,
	/// [`FaultError::Store`]/[`FaultError::Restore`] for a bad image,
	/// [`FaultError::ExecUnsupported`] off Unix.
	#[cfg_attr(
		not(unix),
		expect(clippy::missing_const_for_fn, reason = "the Unix version reads the image fd")
	)]
	pub fn take_image(&mut self, resume: &Resume) -> Result<MemStore, FaultError> {
		self.stats = resume.stats;
		#[cfg(unix)]
		{
			let bytes = os::read_image(resume.image_fd)?;
			// What the predecessor ignored by `trap ''` is still ignored after
			// `exec`; only what was ignored on entry must look inherited.
			os::reset_ignored(resume.ignored)?;
			Ok(MemStore::from_bytes(&bytes)?)
		}
		#[cfg(not(unix))]
		Err(FaultError::ExecUnsupported)
	}

	/// Finish a resume once [`Shell::restore`] succeeded: count it, log what
	/// it lost, and unblock the signals held across the `exec`.
	///
	/// # Errors
	///
	/// [`FaultError::Io`] when the signal mask cannot be set.
	#[cfg_attr(
		not(unix),
		expect(clippy::unnecessary_wraps, reason = "the Unix version restores the signal mask")
	)]
	pub fn resumed(&mut self, resume: &Resume, lost: &[Lost]) -> Result<(), FaultError> {
		self.stats.restored += 1;
		self.log_lost(lost);
		#[cfg(unix)]
		os::set_signal_mask(resume.sigmask)?;
		#[cfg(not(unix))]
		let _ = resume;
		Ok(())
	}

	/// Steps per [`Shell::step`] call: K under `step` and `exec` (a fault at
	/// every Yield), one under `pause` (every op is a safepoint).
	fn budget(&self) -> Budget {
		match self.plan {
			None => Budget::default(),
			Some(Plan { mode: Mode::Pause, .. }) => Budget { max_ops: 1, max_ns: u64::MAX },
			Some(Plan { k, .. }) => Budget { max_ops: k, max_ns: u64::MAX },
		}
	}

	/// Run the shell until script `parts.run` finishes; its status. Faults
	/// are injected at every `Yield` as the plan says.
	///
	/// # Errors
	///
	/// A failed snapshot, restore, pause or re-exec ([`FaultError`]).
	pub fn drive(&mut self, parts: Parts) -> Result<i32, FaultError> {
		let Parts { cfg, mut host, mut store, mut shell, run, mask } = parts;
		let root = Vpid(cfg.vpid_base);
		let every_k = self.budget();
		let status = loop {
			// While a deferred snapshot waits, every op is a safepoint.
			let budget = if self.pending {
				Budget { max_ops: 1, max_ns: u64::MAX }
			} else {
				every_k
			};
			NativeHost::dispatch_signals(&shell.control(), root);
			match shell.step(&mut Cx { host: &mut host, store: &mut store }, budget) {
				Step::Done { run: done, status } if done == run => break status,
				Step::Call { id, .. } => no_callouts(&mut shell, id),
				Step::Blocked | Step::Paused => wait_runnable(&mut self.parker, &shell, root),
				Step::Yield => {
					// A busy shell never parks: notice background exits here.
					self.parker.poll_exits();
					let Some(plan) = self.plan else {
						continue;
					};
					match plan.mode {
						Mode::Pause => {
							if self.coin.chance(1.0 / f64::from(plan.k)) {
								self.pause(&mut shell, &mut host, &mut store, budget)?;
							}
						},
						Mode::Step if !self.pending && self.coin.chance(0.5) => {
							self.pause(&mut shell, &mut host, &mut store, budget)?;
						},
						Mode::Step => {
							let ext = match suspend(
								&mut self.parker,
								&mut shell,
								&mut host,
								&mut store,
								root,
								run,
								budget,
							)? {
								Suspended::Ready(ext) => ext,
								Suspended::Finished(status) => break status,
							};
							if !self.accept(plan, &ext.lost) {
								// Externalize leaves the shell running: keep it.
								continue;
							}
							// The old shell goes first, as when its process ends.
							drop(shell);
							store = MemStore::from_bytes(&store.to_bytes())?;
							let (restored, report) = Shell::restore(
								&Engine::new(cfg),
								&mut Cx { host: &mut host, store: &mut store },
								RestoreOpts::default(),
							)?;
							self.stats.restored += 1;
							self.log_lost(&report.lost);
							shell = restored;
							host.bind_signals(shell.control(), root);
							shell.set_event_mask(mask);
						},
						Mode::Exec => {
							#[cfg(unix)]
							{
								let ext = match self.block_and_suspend(
									&mut shell, &mut host, &mut store, root, run, budget,
								)? {
									Suspended::Ready(ext) => ext,
									Suspended::Finished(status) => break status,
								};
								if !self.accept(plan, &ext.lost) {
									self.unblock()?;
									continue;
								}
								return Err(self.relaunch(plan, &mut host, &store, run, mask));
							}
							#[cfg(not(unix))]
							return Err(FaultError::ExecUnsupported);
						},
					}
				},
				Step::Done { .. } | Step::SuspendReady => {},
				Step::Idle => break 0,
			}
		};
		host.flush()?;
		Ok(status)
	}

	/// Pause, observe `Paused` at the next safepoint, resume.
	fn pause(
		&mut self,
		shell: &mut Shell,
		host: &mut NativeHost,
		store: &mut MemStore,
		budget: Budget,
	) -> Result<(), FaultError> {
		let ctl = shell.control();
		ctl.pause();
		let step = shell.step(&mut Cx { host, store }, budget);
		ctl.resume();
		self.stats.pauses += 1;
		if matches!(step, Step::Paused) {
			Ok(())
		} else {
			Err(FaultError::NotPaused { step: format!("{step:?}") })
		}
	}

	/// Count a snapshot; whether to restore it under the plan's Lost policy
	/// (`defer` marks a kept one for a retry at the next safepoint).
	fn accept(&mut self, plan: Plan, lost: &[Lost]) -> bool {
		self.stats.snapshots += 1;
		self.pending = false;
		if lost.is_empty() {
			return true;
		}
		match plan.lost {
			LostPolicy::Skip => {
				self.stats.skip(lost);
				false
			},
			LostPolicy::Defer => {
				self.stats.skip(lost);
				self.stats.deferred += 1;
				self.pending = true;
				false
			},
			LostPolicy::Restore => {
				self.stats.lost += 1;
				true
			},
		}
	}

	/// Block signals (they stay pending across the `exec`), hand the ones
	/// already caught to the shell, then suspend and externalize. Signals
	/// stay blocked only when a snapshot is returned.
	#[cfg(unix)]
	fn block_and_suspend(
		&mut self,
		shell: &mut Shell,
		host: &mut NativeHost,
		store: &mut MemStore,
		root: Vpid,
		run: RunId,
		budget: Budget,
	) -> Result<Suspended, FaultError> {
		self.held = Some(os::block_signals()?);
		NativeHost::dispatch_signals(&shell.control(), root);
		let suspended = suspend(&mut self.parker, shell, host, store, root, run, budget);
		if !matches!(suspended, Ok(Suspended::Ready(_))) {
			self.unblock()?;
		}
		suspended
	}

	/// Reinstate the signal mask [`Self::block_and_suspend`] replaced.
	#[cfg(unix)]
	fn unblock(&mut self) -> Result<(), FaultError> {
		if let Some(mask) = self.held.take() {
			os::set_signal_mask(mask)?;
		}
		Ok(())
	}

	/// Hand the externalized shell to a new process image: quiesce the host
	/// (event sink and standard streams flushed; the engine's own writes are
	/// unbuffered and no helper thread is relied upon past this point), put
	/// the store image into an inherited fd and `exec` the running binary
	/// with the continuation. Returns only when that fails.
	#[cfg(unix)]
	fn relaunch(
		&self,
		plan: Plan,
		host: &mut NativeHost,
		store: &MemStore,
		run: RunId,
		mask: EventMask,
	) -> FaultError {
		if let Err(err) = host.flush() {
			return err.into();
		}
		// Rust's own stdout buffer is empty unless obash printed through it;
		// a closed stream has nothing to lose.
		let _ = io::stdout().flush();
		let _ = io::stderr().flush();
		let image_fd = match os::image_fd(&store.to_bytes()) {
			Ok(fd) => fd,
			Err(err) => return err.into(),
		};
		let resume = Resume {
			image_fd,
			run,
			events: mask.bits(),
			depth: self.depth,
			clock_ns: pi_shell::bash::Host::now_ns(&*host),
			ignored: bits_of_set(host.entry_ignored()),
			sigmask: self.held.unwrap_or(0),
			stats: self.stats,
		};
		let mut args = vec![
			OsString::from(format!("--fault-resume={}", resume.encode())),
			OsString::from(format!("--fault={}:{}", plan.seed, plan.k)),
			OsString::from("--fault-mode=exec"),
		];
		args.extend(self.own_args.iter().cloned());
		FaultError::Exec(os::exec(&args))
	}

	/// Append `lost …` lines for a restore's losses to `PI_SHELL_LOST_LOG`
	/// (the kit excludes such runs), in one write.
	fn log_lost(&self, lost: &[Lost]) {
		let Some(path) = &self.lost_log else {
			return;
		};
		if lost.is_empty() {
			return;
		}
		let mut text = String::new();
		for l in lost {
			let _ = writeln!(text, "lost {l:?}");
		}
		append(path, &text);
	}

	/// Append this process's counters to `PI_SHELL_FAULT_STATS`, if set: one
	/// line in one write (concurrent processes do not interleave), e.g.
	/// `pid=4242 mode=exec snapshots=9 restored=7 skipped=2 skipped_ext=2
	/// skipped_task=0 skipped_fd=1 lost=0 pauses=0`. A skipped snapshot
	/// counts once per kind of loss it reported. Plain runs (no plan) write
	/// nothing. obash calls it at exit.
	pub fn finish(&self) {
		let (Some(path), Some(plan)) = (&self.stats_to, self.plan) else {
			return;
		};
		let s = &self.stats;
		let line = format!(
			"pid={} mode={} snapshots={} restored={} skipped={} skipped_ext={} skipped_task={} \
			 skipped_fd={} lost={} pauses={} deferred={}\n",
			std::process::id(),
			plan.mode.name(),
			s.snapshots,
			s.restored,
			s.skipped,
			s.skipped_ext,
			s.skipped_task,
			s.skipped_fd,
			s.lost,
			s.pauses,
			s.deferred,
		);
		append(path, &line);
	}
}

/// Append `text` to the file at `path` in one write; a log that cannot be
/// written must not change what the script does.
fn append(path: &std::path::Path, text: &str) {
	if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
		let _ = f.write_all(text.as_bytes());
	}
}

/// How a suspend ended.
enum Suspended {
	/// At a safepoint, externalized.
	Ready(ExternalizeReport),
	/// The script finished first, with this status.
	Finished(i32),
}

/// `request_suspend` → `SuspendReady` → externalize. Finished scripts are
/// reported before the suspend; a mutating fs op in flight delays it
/// (`Blocked`).
fn suspend(
	parker: &mut Parker,
	shell: &mut Shell,
	host: &mut NativeHost,
	store: &mut MemStore,
	root: Vpid,
	run: RunId,
	budget: Budget,
) -> Result<Suspended, FaultError> {
	shell.control().request_suspend();
	loop {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, budget) {
			Step::SuspendReady => break,
			Step::Done { run: done, status } if done == run => return Ok(Suspended::Finished(status)),
			Step::Call { id, .. } => no_callouts(shell, id),
			Step::Blocked => wait_runnable(parker, shell, root),
			Step::Yield => parker.poll_exits(),
			Step::Done { .. } | Step::Paused | Step::Idle => {},
		}
	}
	Ok(Suspended::Ready(shell.externalize(&mut Cx { host, store })?))
}

/// obash has no host callouts: answer each with an error.
fn no_callouts(shell: &mut Shell, id: CallId) {
	shell.complete(id, CallOutcome::Error("host callouts are not available in obash".into()));
}

/// Park until the shell may make progress, forwarding OS signals (a signal
/// caught on this thread ends the park at once on Linux; otherwise within
/// 50 ms).
fn wait_runnable(parker: &mut Parker, shell: &Shell, root: Vpid) {
	let ctl = shell.control();
	let waker = parker.waker().clone();
	let mut cx = Context::from_waker(&waker);
	loop {
		NativeHost::dispatch_signals(&ctl, root);
		if ctl.poll_runnable(&mut cx).is_ready() {
			break;
		}
		parker.park(Duration::from_millis(50));
	}
}

/// The OS side of `exec` mode: signal masks and dispositions, the image fd,
/// the re-exec.
#[cfg(unix)]
mod os {
	use std::{
		ffi::OsString,
		fs,
		io::{self, Read, Seek, SeekFrom, Write},
		os::{
			fd::{AsRawFd, FromRawFd},
			unix::process::CommandExt,
		},
		path::PathBuf,
		ptr,
	};

	/// Bits (n - 1) of the signals 1..=64 in `set`.
	#[cfg_attr(
		target_os = "macos",
		expect(clippy::trivially_copy_pass_by_ref, reason = "a sigset_t is 128 bytes on Linux")
	)]
	fn bits_of(set: &libc::sigset_t) -> u64 {
		let mut bits = 0;
		for n in 1..=64 {
			// SAFETY: sigismember only reads the initialized set; a number the
			// platform does not have answers -1.
			if unsafe { libc::sigismember(set, n) } == 1 {
				bits |= 1u64 << (n - 1);
			}
		}
		bits
	}

	/// The set of signals whose bits (n - 1) are set in `bits`.
	fn set_of(bits: u64) -> libc::sigset_t {
		// SAFETY: sigset_t is plain data; sigemptyset initializes it.
		let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: the set is valid and writable.
		unsafe { libc::sigemptyset(&raw mut set) };
		for n in 1..=64 {
			if bits & (1u64 << (n - 1)) != 0 {
				// SAFETY: as above; a number the platform lacks fails harmlessly.
				unsafe { libc::sigaddset(&raw mut set, n) };
			}
		}
		set
	}

	/// Block every signal in this thread (they stay pending, and pending
	/// signals survive `exec`); the previous mask.
	pub fn block_signals() -> io::Result<u64> {
		// SAFETY: plain data, initialized by sigfillset.
		let mut all: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: the set is valid and writable.
		unsafe { libc::sigfillset(&raw mut all) };
		// SAFETY: plain data, written by pthread_sigmask.
		let mut old: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: both sets are valid for the call.
		let rc = unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &raw const all, &raw mut old) };
		if rc != 0 {
			return Err(io::Error::from_raw_os_error(rc));
		}
		Ok(bits_of(&old))
	}

	/// Set this thread's signal mask to the signals in `bits`.
	pub fn set_signal_mask(bits: u64) -> io::Result<()> {
		let set = set_of(bits);
		// SAFETY: the set is valid; the old mask is not wanted.
		let rc = unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &raw const set, ptr::null_mut()) };
		if rc == 0 {
			Ok(())
		} else {
			Err(io::Error::from_raw_os_error(rc))
		}
	}

	/// Give every signal that is ignored now but not in `entry` (bits n - 1)
	/// its default disposition: an `exec` keeps what `trap ''` ignored, and
	/// the restored traps must not mistake it for ignored on entry.
	pub fn reset_ignored(entry: u64) -> io::Result<()> {
		for n in 1..=64 {
			if entry & (1u64 << (n - 1)) != 0 || n == libc::SIGKILL || n == libc::SIGSTOP {
				continue;
			}
			// SAFETY: plain data, written by sigaction on success.
			let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
			// SAFETY: a null new action only queries; numbers the platform
			// lacks fail with EINVAL.
			if unsafe { libc::sigaction(n, ptr::null(), &raw mut current) } != 0
				|| current.sa_sigaction != libc::SIG_IGN
			{
				continue;
			}
			// SAFETY: plain data; SIG_DFL with an empty mask is a valid action.
			let mut default: libc::sigaction = unsafe { std::mem::zeroed() };
			default.sa_sigaction = libc::SIG_DFL;
			// SAFETY: the mask is valid and writable.
			unsafe { libc::sigemptyset(&raw mut default.sa_mask) };
			// SAFETY: a valid action for a signal the query accepted.
			if unsafe { libc::sigaction(n, &raw const default, ptr::null_mut()) } != 0 {
				return Err(io::Error::last_os_error());
			}
		}
		Ok(())
	}

	/// An fd above the standard streams, without close-on-exec, reading
	/// `bytes` from the start: an unlinked temp file (no name outlives the
	/// hand-over).
	pub fn image_fd(bytes: &[u8]) -> io::Result<i32> {
		let pid = std::process::id();
		let mut last = io::Error::from(io::ErrorKind::AlreadyExists);
		for dir in [std::env::temp_dir(), PathBuf::from("/tmp")] {
			for n in 0..16u32 {
				let path = dir.join(format!(".obash-frames-{pid}-{n}"));
				let mut file = match fs::OpenOptions::new()
					.read(true)
					.write(true)
					.create_new(true)
					.open(&path)
				{
					Ok(file) => file,
					Err(err) => {
						let taken = err.kind() == io::ErrorKind::AlreadyExists;
						last = err;
						if taken {
							continue;
						}
						break;
					},
				};
				fs::remove_file(&path)?;
				file.write_all(bytes)?;
				file.seek(SeekFrom::Start(0))?;
				// F_DUPFD: the lowest free fd ≥ 10, close-on-exec clear (a
				// closed standard stream would otherwise get the image).
				// SAFETY: the fd is open; the duplicate is owned by the caller
				// and handed to the next process image.
				let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 10) };
				if fd < 0 {
					return Err(io::Error::last_os_error());
				}
				return Ok(fd);
			}
		}
		Err(last)
	}

	/// Read the image from the inherited `fd` and close it.
	pub fn read_image(fd: i32) -> io::Result<Vec<u8>> {
		// SAFETY: F_GETFD only reads the descriptor flags.
		if unsafe { libc::fcntl(fd, libc::F_GETFD) } == -1 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: the predecessor process image opened this fd for this one
		// alone; nothing in this process has taken it over.
		let mut file = unsafe { fs::File::from_raw_fd(fd) };
		let mut bytes = Vec::new();
		file.read_to_end(&mut bytes)?;
		Ok(bytes)
	}

	/// `exec` the running binary (same argv[0]) with `args`; returns only
	/// on failure. Linux re-executes `/proc/self/exe`, so a binary replaced
	/// on disk meanwhile does not take over.
	pub fn exec(args: &[OsString]) -> io::Error {
		let exe = if cfg!(target_os = "linux") {
			PathBuf::from("/proc/self/exe")
		} else {
			match std::env::current_exe() {
				Ok(exe) => exe,
				Err(err) => return err,
			}
		};
		let argv0 = std::env::args_os()
			.next()
			.unwrap_or_else(|| OsString::from("obash"));
		std::process::Command::new(exe)
			.arg0(argv0)
			.args(args)
			.exec()
	}
}

#[cfg(test)]
mod tests {
	use pi_shell::bash::{Lost, NativeRef, RunId, SigSet, Signal, Vpid};

	use super::{Resume, Stats, bits_of_set, parse_fault, set_of_bits};

	#[test]
	fn a_continuation_survives_its_command_line() {
		let resume = Resume {
			image_fd: 11,
			run:      RunId(3),
			events:   0x1f,
			depth:    2,
			clock_ns: 123_456_789,
			ignored:  1 << 12,
			sigmask:  1 << 9,
			stats:    Stats {
				snapshots:    9,
				restored:     7,
				skipped:      2,
				skipped_ext:  2,
				skipped_task: 0,
				skipped_fd:   1,
				lost:         0,
				pauses:       4,
				deferred:     3,
			},
		};
		assert_eq!(Resume::decode(&resume.encode()).unwrap(), resume);
	}

	#[test]
	fn a_malformed_continuation_is_refused() {
		for bad in [
			"",
			"run=1",
			"img=2,run=1",
			"img=11",
			"img=11,run=1,bogus=3",
			"img=11,run=x",
			"img=11;run=1",
		] {
			assert!(Resume::decode(bad).is_err(), "{bad:?} was accepted");
		}
	}

	#[test]
	fn fault_specs_need_a_seed_and_a_positive_k() {
		assert_eq!(parse_fault("1:97"), Ok((1, 97)));
		for bad in ["1", "x:3", "1:0", "1:-2", ":5"] {
			assert!(parse_fault(bad).is_err(), "{bad:?} was accepted");
		}
	}

	#[test]
	fn signal_sets_round_trip_through_os_numbers() {
		let set = SigSet::EMPTY
			.with(Signal::Int)
			.with(Signal::Pipe)
			.with(Signal::Usr1);
		assert_eq!(set_of_bits(bits_of_set(set)), set);
		assert_eq!(set_of_bits(0), SigSet::EMPTY);
	}

	#[test]
	fn a_skip_counts_each_kind_of_loss_once() {
		let mut stats = Stats::default();
		stats.skip(&[
			Lost::Ext { vpid: Vpid(2), pid: 10 },
			Lost::Ext { vpid: Vpid(3), pid: 11 },
			Lost::Fd { vpid: Vpid(2), fd: 3, kind: pi_shell::bash::FileKind::Pipe },
		]);
		stats.skip(&[Lost::Task { vpid: Vpid(2), native: NativeRef(1) }]);
		assert_eq!(
			(stats.skipped, stats.skipped_ext, stats.skipped_task, stats.skipped_fd),
			(2, 1, 1, 1)
		);
	}
}
