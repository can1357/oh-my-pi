//! The VM: shells, virtual processes and the cooperative scheduler.
//!
//! [`Shell::step`] runs ready virtual processes round-robin, up to 1024 ops
//! each per turn, and returns when a script finishes, a host callout is
//! needed, every vproc is blocked, the control word asks for a pause or a
//! suspend, or the [`Budget`] runs out. Every op dispatch is a safepoint: the
//! dispatch loop loads the control word before each op.

mod api;
mod arith;
mod builtins;
mod callstack;
mod command;
mod control;
mod exec;
mod expand;
mod frames;
mod glob;
mod locale;
mod mode;
mod nested;
mod orphans;
mod pattern;
mod probe;
mod proc;
pub mod quote;
mod redir;
mod state;
mod xtrace;
mod zsh;

use std::{
	collections::{HashMap, HashSet, VecDeque},
	sync::Arc,
	task::Waker,
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

pub use self::{
	api::ShellApi,
	arith::Cache as ArithCache,
	control::{ControlHandle, IoPoll, WakeToken},
	frames::FRAMES_VERSION,
	pattern::Cache as PatternCache,
	proc::{Run, Vproc, vproc_layout},
	text::TextKind,
	zsh::zpattern::Cache as ZshPatternCache,
};
use self::{
	control::{CANCEL, Ctl, PAUSE, RESUME, SIGNAL, SUSPEND},
	proc::{Frame, FrameKind, Live, PendingWrite, ScriptKind},
	state::{Overlay, Root, Var},
};
use crate::bash::{
	diag::{Diag, DiagSite, render},
	engine::Engine,
	error::{RestoreError, ShellError},
	event::{AssignScope, Event, EventData, EventMask, Origin, OriginChain, OriginLink},
	fd::{FdOrigin, FdRef, FdTable},
	fs::File,
	host::{EnvView, Host, StdFd, Verdict},
	ids::{CallId, CmdTag, JobId, ModeId, RunId, ToolRef, UnitId, Vpid},
	ir::{self, Unit},
	signal::{DefaultAction, SigTarget, Signal},
	store::{
		Attrs, Change, Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, Table, VarValue,
	},
};

/// Ops a vproc runs per scheduler turn.
const SLICE: u32 = 1024;

/// bash version this engine implements (`$BASH_VERSION`).
pub const BASH_VERSION: &str = "5.3.0(1)-release";

/// Engine types are `Send`; hosts move shells between threads.
const _: () = {
	const fn send<T: Send>() {}
	send::<Shell>();
	send::<ToolCall>();
	send::<ControlHandle>();
};

mod text {
	/// Kind of text parsed at run time.
	#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
	pub enum TextKind {
		/// Arithmetic text.
		Arith,
		/// An unquoted here-document body.
		HereDoc,
		/// The inside of a compound array value given as a string
		/// (`declare -a d='($a)'`), parsed as the list of `declare __=(…)`.
		Compound,
	}
}

/// The host and the store, lent to the engine for one call.
///
/// The executor builds one per call from its rquickjs-backed host and store,
/// so no `'js` lifetime enters engine structs.
pub struct Cx<'a> {
	/// Side effects.
	pub host:  &'a mut dyn Host,
	/// Persistent state.
	pub store: &'a mut dyn StateStore,
}

/// Initial state of a new shell.
#[derive(Clone, Debug)]
pub struct ShellInit {
	/// Starting mode. A zsh-dialect shell starts with that emulation's
	/// options, and takes [`Self::options`] as zsh option names (`no`
	/// prefix allowed).
	pub mode:        ModeId,
	/// `$0`; also the prefix of diagnostics.
	pub argv0:       BString,
	/// Positional parameters.
	pub args:        Vec<BString>,
	/// Imported environment (names that are not identifiers are skipped;
	/// `BASH_FUNC_name%%` entries define exported functions).
	pub env:         Vec<(BString, BString)>,
	/// Working directory (absolute).
	pub cwd:         BString,
	/// Interactive shell semantics.
	pub interactive: bool,
	/// `set -o` / `shopt` names to set.
	pub options:     Vec<(BString, bool)>,
	/// `$$` (persisted across restores); zero selects [`Host::shell_pid`].
	pub shell_pid:   u32,
	/// Startup files (`path`, contents) the shell sources, in order, before
	/// its first script: what
	/// [`crate::bash::invocation::ShellArgs::startup_files`] names and the
	/// host found (`BASH_ENV`, a login shell's profiles).
	pub startup:     Vec<(BString, BString)>,
}

impl Default for ShellInit {
	fn default() -> Self {
		Self {
			mode:        ModeId::Bash,
			argv0:       BString::from("bash"),
			args:        Vec::new(),
			env:         Vec::new(),
			cwd:         BString::from("/"),
			interactive: false,
			options:     Vec::new(),
			shell_pid:   0,
			startup:     Vec::new(),
		}
	}
}

/// A script to run ([`Shell::submit`]).
pub struct Script {
	/// Source bytes.
	pub source:       Arc<[u8]>,
	/// Where they came from (diagnostic prefixes, events).
	pub origin:       Origin,
	/// Mode to parse and run in; the vproc's mode before the run comes
	/// back when it ends (`None`: the shell's current mode, which an
	/// `emulate` in the script changes for later runs too).
	pub mode:         Option<ModeId>,
	/// Positional parameters for the script.
	pub args:         Option<Vec<BString>>,
	/// Which virtual process runs it.
	pub vproc:        VprocSel,
	/// Opaque host tag, echoed in `RunStart`.
	pub tag:          u64,
	/// Working directory for the run.
	pub cwd:          Option<BString>,
	/// Exported variables for the run.
	pub env:          Vec<(BString, BString)>,
	/// Changes to inherited non-shell environment entries for a new subshell.
	/// A `None` name clears them; otherwise `None` removes and `Some` sets.
	pub foreign_env:  Vec<(Option<BString>, Option<BString>)>,
	/// Shell variable names whose inherited bindings must not be exported in
	/// the new subshell, including bindings hidden by local scopes.
	pub unexport_env: Vec<BString>,
}

impl Script {
	/// A command script (`-c` semantics) on the root vproc.
	pub fn command(source: impl Into<Arc<[u8]>>) -> Self {
		Self {
			source:       source.into(),
			origin:       Origin::Command,
			mode:         None,
			args:         None,
			vproc:        VprocSel::Root,
			tag:          0,
			cwd:          None,
			env:          Vec::new(),
			foreign_env:  Vec::new(),
			unexport_env: Vec::new(),
		}
	}
}

/// Virtual process selection of a [`Script`].
///
/// `Root` runs in the shell itself, after earlier root scripts: its changes
/// persist, and [`Script::cwd`] / [`Script::env`] / [`Script::args`] are
/// applied to the root state when the script starts (as `cd`, `export` and
/// `set --` would). The `NewSubshell*` forms run in a fresh vproc with a
/// copy-on-write view of the root state, concurrently with other vprocs;
/// `cwd`, `env` and `args` apply to that subshell only.
pub enum VprocSel {
	/// The root vproc.
	Root,
	/// A new subshell vproc sharing the root's fds.
	NewSubshell,
	/// A new subshell vproc with its own fds 0, 1, 2.
	NewSubshellWithStdio([RunStdio; 3]),
}

/// One standard stream of a `NewSubshellWithStdio` run.
pub enum RunStdio {
	/// The root's fd.
	Inherit,
	/// Closed.
	Closed,
	/// This host file (a stdin blob, an output capture). Lost on restore.
	File(Box<dyn File>),
}

/// How much work one [`Shell::step`] may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
	/// Ops (safepoints).
	pub max_ops: u32,
	/// Wall time, checked between scheduler turns.
	pub max_ns:  u64,
}

impl Default for Budget {
	/// 20 000 ops or 2 ms.
	fn default() -> Self {
		Self { max_ops: 20_000, max_ns: 2_000_000 }
	}
}

/// Why [`Shell::step`] returned.
#[derive(Debug)]
pub enum Step {
	/// A script finished (others may continue).
	Done {
		/// The script.
		run:    RunId,
		/// Its final status.
		status: i32,
	},
	/// Run a host callout; answer with [`Shell::complete`] (in any order).
	/// The store is up to date when this is returned.
	Call {
		/// Answer key.
		id:   CallId,
		/// What to run.
		call: ToolCall,
	},
	/// Every vproc waits (on a pipe, callout, task, external or pending fs
	/// op); await [`ControlHandle::poll_runnable`], then step again.
	Blocked,
	/// Paused by [`ControlHandle::pause`] or a `Verdict::Pause`; returned
	/// until [`ControlHandle::resume`].
	Paused,
	/// The drain requested by [`ControlHandle::request_suspend`] reached a
	/// global safepoint: [`Shell::externalize`] now captures a complete
	/// snapshot. Returned once; the next `step` continues normally.
	SuspendReady,
	/// Budget exhausted with runnable work left.
	Yield,
	/// Nothing submitted.
	Idle,
}

/// A host callout to run ([`Step::Call`]).
#[derive(Clone, Debug)]
pub struct ToolCall {
	/// From [`Resolved::Tool`](crate::bash::Resolved::Tool).
	pub tool:      ToolRef,
	/// Expanded argv.
	pub argv:      Vec<BString>,
	/// Calling vproc.
	pub vpid:      Vpid,
	/// Output tag of this execution.
	pub tag:       CmdTag,
	/// Working directory.
	pub cwd:       BString,
	/// fds 0, 1, 2 (also reachable by number through [`ShellApi`]).
	pub stdio:     [FdRef; 3],
	/// Further open fds.
	pub extra_fds: Vec<(i32, FdRef)>,
	/// Environment.
	pub env:       EnvView,
	/// File-creation mask: the shell's `umask`.
	pub umask:     u32,
}

/// How a host callout ended.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CallOutcome {
	/// Exit status.
	Exit(i32),
	/// Killed by a (virtual) signal: status 128 + n.
	Signaled(Signal),
	/// Failed: printed as `name: line N: tool: msg`, status 1.
	Error(BString),
}

/// One shell: transient execution state only (scheduler, vprocs, frames,
/// caches). Persistent state lives in the [`StateStore`]. `Send`; holds no
/// host references.
pub struct Shell {
	k:       Kernel,
	/// Boxed: a `Vproc` is ~650 bytes and the vector doubles, so idle
	/// subshells would pay up to twice that in spare capacity (target:
	/// ≤ 2 KiB per idle vproc).
	#[expect(clippy::vec_box, reason = "slack capacity of 8-byte slots, not of whole vprocs")]
	procs:   Vec<Box<Vproc>>,
	rr:      usize,
	/// A slice cut short by the step budget or a control request: the vproc
	/// and the ops it has left. The next step continues it, so which vproc
	/// runs when depends only on op counts, never on where the host's steps,
	/// pauses or snapshots fall.
	slice:   Option<(Vpid, u32)>,
	/// Subshell vprocs that ended since the last orphan check: their
	/// children are orphans ([`EngineConfig::end_orphan_jobs`] only).
	///
	/// [`EngineConfig::end_orphan_jobs`]: crate::bash::EngineConfig::end_orphan_jobs
	gone:    Vec<Vpid>,
	/// Orphaned job trees still watched for in-engine work (see the
	/// `orphans` module); empty unless [`Self::gone`] ever had entries.
	orphans: Vec<Vpid>,
}

/// Shell-wide state shared by all vprocs (kept apart from `procs` so ops can
/// borrow a vproc and the kernel at once).
pub struct Kernel {
	pub engine:          Arc<Engine>,
	pub ctl:             Arc<Ctl>,
	pub waker:           Waker,
	/// Facts derived from the root state in the store (the state itself
	/// lives in the store).
	pub root:            Root,
	pub mask:            EventMask,
	pub seq:             u64,
	pub next_vpid:       u32,
	pub next_run:        u64,
	pub next_call:       u64,
	pub next_cmd:        u64,
	pub next_job:        u32,
	pub done:            VecDeque<(RunId, i32)>,
	pub calls_out:       VecDeque<(CallId, ToolCall)>,
	pub results:         HashMap<CallId, CallOutcome>,
	/// Units announced with `UnitCompiled` (not imaged: a restored shell
	/// announces again what it can still run).
	pub announced:       HashSet<UnitId>,
	/// Every unit the shell can still run is to be announced before the
	/// next step runs anything: set by `create` and `restore` (the host may
	/// have seen none of them; see [`Shell::announce_live`]).
	pub reannounce:      bool,
	/// Unit blobs known to be in the store ([`Kernel::persist_unit`],
	/// `externalize`).
	pub written:         HashSet<UnitId>,
	/// The `next_vpid` value last written as `MiscKey::NextVpid`
	/// ([`Kernel::vpid`], [`Kernel::sync_root`]).
	pub written_vpid:    u32,
	pub paused:          bool,
	pub argv0:           BString,
	pub shell_pid:       u32,
	/// Idempotent fs ops dropped by the last suspend (re-issued on resume).
	pub dropped_fs:      u32,
	/// Child vprocs created during a turn, adopted by the scheduler after it.
	/// Every child vproc has a `Record::Proc` from its adoption until its
	/// exit status is collected ([`Kernel::proc_exited`],
	/// [`Kernel::proc_collect`]). Boxed as `Shell::procs` holds them:
	/// adoption moves pointers, and the capacity a burst leaves behind is 8
	/// bytes a slot, not a whole vproc (`cmd &` in a loop spawns ~200 per
	/// slice: that kept ~600 bytes per idle vproc; the target is ≤ 2 KiB).
	#[expect(clippy::vec_box, reason = "slack capacity of 8-byte slots, not of whole vprocs")]
	pub spawned:         Vec<Box<Vproc>>,
	/// `$RANDOM` generator state (written through as `MiscKey::Random` by
	/// [`Kernel::next_random`] and [`Kernel::seed_random`]).
	pub rand:            state::Random,
	/// `now_ns` at shell creation (`$SECONDS`; `MiscKey::StartNs`).
	pub start_ns:        u64,
	/// Startup files (`path`, contents) the root vproc sources when its
	/// first run starts ([`ShellInit::startup`]); not imaged (the first run
	/// starts at the first step).
	pub startup:         Vec<(BString, BString)>,
	/// Which DEBUG/ERR/RETURN traps may be set: lets `exec::start_trap`
	/// skip its checks before every command; not imaged.
	pub pseudo_traps:    exec::PseudoTraps,
	/// `PATH` as the last command lookup copied it: a buffer reused so a
	/// command's resolution allocates nothing; not imaged.
	pub path_buf:        BString,
	/// Re-parsed `${ ;}` bodies ([`exec::NoforkUnits`]); not imaged.
	pub nofork_units:    exec::NoforkUnits,
	/// The last event clock reading while it is still current
	/// ([`Kernel::stamp`]): set by a reading that ends a duration or starts a
	/// command, cleared by [`Kernel::clock_stale`] before anything that can
	/// take time (a vproc's turn, an op other than control flow, I/O,
	/// parsing, a builtin). Lets the `CmdStart`, `CmdExpanded` and
	/// `FuncEnter` events of a command (and a function's `FuncExit`) share
	/// one `Host::now_ns` with the previous `CmdEnd` (xeon overhead profile:
	/// `now_ns` a third of the default-mask event cost). Not imaged.
	pub clock:           Option<u64>,
	/// The empty document an async command without job control reads as
	/// `/dev/null`, shared by all of them (it never yields a byte, so one
	/// object serves every reader): an fd object and two buffers less per
	/// background vproc (idle vproc ≤ 2 KiB). Not imaged (a restored
	/// child keeps its own object).
	pub null_input:      Option<FdRef>,
	/// `(label, caller)`: the labeled subshell trees host callouts started
	/// ([`ShellApi::run_subshell_in`]) and the vproc that ran each callout;
	/// virtual signals to the caller reach the tree (`Shell::deliver`).
	/// Pruned there once no vproc carries the label; not imaged (callouts
	/// do not survive a restore).
	pub callout_labels:  Vec<(u32, Vpid)>,
	/// The last root run that `exit` or `set -e` ended
	/// ([`Shell::ended_by_exit`]); not imaged.
	pub exited:          Option<RunId>,
	/// Signal deaths of external programs replacing a submitted run, pending
	/// its completion report; callouts do not survive frame restoration.
	pub exec_signals:    HashMap<RunId, i32>,
	/// Signal death associated with the most recently reported run.
	pub reported_signal: Option<(RunId, i32)>,
	/// Background jobs whose pid is still to be settled
	/// ([`proc::Bang`]): imaged (a restored job still decides).
	pub bangs:           Vec<proc::Bang>,
	/// `(job, OS pid)`: jobs settled on their program's OS pid during the
	/// turn, written into the job tables and `$!` of every vproc by the
	/// scheduler after it (`Shell::adopt`); empty between turns, not
	/// imaged.
	pub settled:         Vec<(Vpid, u32)>,
	/// Background jobs' lone commands whose redirections wait for their name
	/// to resolve ([`proc::Deferral`]): imaged (a restored command goes on).
	pub deferrals:       Vec<proc::Deferral>,
}

/// A child vproc's entry in the process table ([`Kernel::proc_state`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcState {
	/// Still running.
	Running,
	/// Finished with this status; not collected yet.
	Exited(i32),
}

impl ProcState {
	/// The exit status once finished.
	pub const fn exited(self) -> Option<i32> {
		match self {
			Self::Running => None,
			Self::Exited(status) => Some(status),
		}
	}
}

impl Kernel {
	fn new(engine: &Arc<Engine>, root: Root, argv0: BString, shell_pid: u32) -> Self {
		let ctl = Ctl::new();
		Self {
			engine: Arc::clone(engine),
			waker: control::engine_waker(&ctl),
			ctl,
			root,
			mask: EventMask::DEFAULT,
			seq: 0,
			next_vpid: engine.config().vpid_base,
			next_run: 1,
			next_call: 1,
			next_cmd: 1,
			next_job: 1,
			done: VecDeque::new(),
			calls_out: VecDeque::new(),
			results: HashMap::new(),
			announced: HashSet::new(),
			reannounce: true,
			written: HashSet::new(),
			written_vpid: engine.config().vpid_base,
			paused: false,
			argv0,
			shell_pid,
			dropped_fs: 0,
			spawned: Vec::new(),
			rand: state::Random::new(1),
			start_ns: 0,
			startup: Vec::new(),
			pseudo_traps: exec::PseudoTraps::default(),
			path_buf: BString::default(),
			nofork_units: HashMap::new(),
			clock: None,
			null_input: None,
			callout_labels: Vec::new(),
			exited: None,
			exec_signals: HashMap::new(),
			reported_signal: None,
			bangs: Vec::new(),
			settled: Vec::new(),
			deferrals: Vec::new(),
		}
	}

	/// The redirections `vproc`'s command leaves to the process it spawns,
	/// while it decides ([`proc::Deferral`]).
	pub fn deferral(&mut self, vproc: Vpid) -> Option<&mut proc::Deferral> {
		self.deferrals.iter_mut().find(|d| d.vproc == vproc)
	}

	/// `vproc` ended, or its command did: forget what it was deciding.
	pub fn forget_deferral(&mut self, vproc: Vpid) {
		if !self.deferrals.is_empty() {
			self.deferrals.retain(|d| d.vproc != vproc);
		}
	}

	/// The pid of background job `job` is still to be settled
	/// ([`proc::Bang`]): readers of it wait (`WaitKey::Proc(job)`).
	pub fn bang_pending(&self, job: Vpid) -> bool {
		self.bangs.iter().any(|b| b.job == job)
	}

	/// Settle the job vproc `vproc` decides ([`proc::Bang`]): known by the
	/// OS pid `os`, or by its virtual pid (`None`). Wakes the readers.
	pub fn settle_bang(&mut self, vproc: Vpid, os: Option<u32>) {
		let Some(i) = self.bangs.iter().position(|b| b.vproc == vproc) else {
			return;
		};
		let bang = self.bangs.swap_remove(i);
		if let Some(pid) = os {
			self.settled.push((bang.job, pid));
		}
		self.ctl.notify();
	}

	/// Next `$RANDOM` (0..=32767); the generator state is written through.
	pub fn next_random(&mut self, store: &mut dyn StateStore) -> u32 {
		let v = self.rand.next();
		self
			.root
			.set_misc(store, MiscKey::Random, self.rand.encode());
		v
	}

	/// `RANDOM=seed`; written through.
	pub fn seed_random(&mut self, store: &mut dyn StateStore, seed: i64) {
		self.rand.seed(seed);
		self
			.root
			.set_misc(store, MiscKey::Random, self.rand.encode());
	}

	/// A fresh vpid; the counter is written through (a shell restored from
	/// the store alone never reuses one).
	pub fn vpid(&mut self, store: &mut dyn StateStore) -> Vpid {
		let v = Vpid(self.next_vpid);
		self.next_vpid += 1;
		self.written_vpid = self.next_vpid;
		self
			.root
			.set_misc(store, MiscKey::NextVpid, self.next_vpid.to_string());
		v
	}

	/// Write `unit`'s blob ([`BlobSlot::Unit`](crate::bash::store::BlobSlot))
	/// once per id: a function body is in the store from its definition on,
	/// so a shell restored from the store alone keeps its line numbers.
	pub fn persist_unit(&mut self, store: &mut dyn StateStore, unit: &Unit) {
		if self.written.contains(&unit.id) {
			return;
		}
		let written = postcard::to_stdvec(unit)
			.map_err(StoreError::Encode)
			.and_then(|bytes| store.put_blob(crate::bash::store::BlobSlot::Unit(unit.id), &bytes));
		match written {
			Ok(()) => {
				self.written.insert(unit.id);
			},
			Err(err) => self.fail(err),
		}
	}

	/// Write the root vproc's in-place fields ([`state::sync_root`]) and a
	/// vpid counter advanced without the store (`Shell::submit`): called
	/// before every engine call returns.
	pub fn sync_root(&mut self, store: &mut dyn StateStore, root: &Vproc) {
		state::sync_root(&mut self.root, store, root);
		if self.next_vpid != self.written_vpid {
			self.written_vpid = self.next_vpid;
			self
				.root
				.set_misc(store, MiscKey::NextVpid, self.next_vpid.to_string());
		}
	}

	/// A fresh job id; the counter is written through.
	pub fn job_id(&mut self, store: &mut dyn StateStore) -> JobId {
		let id = JobId(self.next_job);
		self.next_job += 1;
		self
			.root
			.set_misc(store, MiscKey::NextJob, self.next_job.to_string());
		id
	}

	/// Child vproc `vpid` of `parent` ended with `status`; the record stays
	/// until the status is collected ([`Self::proc_collect`]).
	pub fn proc_exited(
		&mut self,
		store: &mut dyn StateStore,
		vpid: Vpid,
		parent: Option<Vpid>,
		status: i32,
	) {
		let rec = Record::Proc { parent, status: Some(status) };
		self.root.write(store, Change::Put(Key::Proc(vpid), rec));
	}

	/// Child vproc `vpid`'s state: `None` unknown (never started here, or
	/// collected). A store failure reads as unknown (and is kept for the
	/// next turn).
	pub fn proc_state(&mut self, store: &mut dyn StateStore, vpid: Vpid) -> Option<ProcState> {
		match store.get(Key::Proc(vpid)) {
			Ok(Some(Record::Proc { status, .. })) => {
				Some(status.map_or(ProcState::Running, ProcState::Exited))
			},
			Ok(_) => None,
			Err(err) => {
				self.root.fail(err);
				None
			},
		}
	}

	/// Take the exit status of finished child vproc `vpid` (its record goes);
	/// `None` while it runs or when unknown.
	pub fn proc_collect(&mut self, store: &mut dyn StateStore, vpid: Vpid) -> Option<i32> {
		let status = self.proc_state(store, vpid)?.exited()?;
		self.root.write(store, Change::Del(Key::Proc(vpid)));
		Some(status)
	}

	/// The clock for an event now: the last reading while it is still
	/// current ([`Self::clock`]), else a fresh [`crate::bash::Host::now_ns`]
	/// that later events may share. For events at the start of something
	/// (`CmdStart`, `CmdExpanded`, `FuncEnter`).
	#[inline]
	pub fn stamp(&mut self, cx: &Cx<'_>) -> u64 {
		match self.clock {
			Some(t) => t,
			None => self.read_clock(cx),
		}
	}

	/// A fresh [`crate::bash::Host::now_ns`] (a duration ends here: `CmdEnd`),
	/// kept for the events that follow ([`Self::stamp`]).
	#[inline]
	pub fn read_clock(&mut self, cx: &Cx<'_>) -> u64 {
		let t = cx.host.now_ns();
		self.clock = Some(t);
		t
	}

	/// Something that can take time starts (or a vproc's turn does): the
	/// next [`Self::stamp`] reads the clock.
	#[inline]
	pub const fn clock_stale(&mut self) {
		self.clock = None;
	}

	/// Emit an event without a node if its kind is enabled; applies the
	/// host's verdict.
	#[inline]
	pub fn emit(
		&mut self,
		cx: &mut Cx<'_>,
		(vpid, mode): (Vpid, ModeId),
		run: Option<&Run>,
		data: EventData<'_>,
	) {
		if self.mask.contains(data.kind()) {
			let t_ns = cx.host.now_ns();
			self.deliver_at(cx, (vpid, mode), run, data, t_ns);
		}
	}

	/// The event of [`Self::emit`] handed to the host, out of line: its
	/// callers inline only the mask test (a disabled kind costs one AND and
	/// touches nothing else).
	#[inline(never)]
	fn deliver_at(
		&mut self,
		cx: &mut Cx<'_>,
		(vpid, mode): (Vpid, ModeId),
		run: Option<&Run>,
		data: EventData<'_>,
		t_ns: u64,
	) {
		let ev = Event::of_run(self.seq, t_ns, vpid, run, mode, data);
		self.send(cx, &ev);
	}

	/// Hand `ev` (numbered with the current `seq`) to the host and apply its
	/// verdict. Inline: at the hot `emit_op_at` sites the event costs the
	/// host's call and nothing around it; a verdict other than `Continue`
	/// takes the out-of-line [`Self::apply_verdict`].
	#[inline]
	fn send(&mut self, cx: &mut Cx<'_>, ev: &Event<'_>) {
		self.seq += 1;
		let verdict = cx.host.event(ev);
		if verdict != Verdict::Continue {
			self.apply_verdict(verdict);
		}
	}

	/// A host's `Pause` or `Cancel` verdict, as a control request.
	#[cold]
	#[inline(never)]
	fn apply_verdict(&self, verdict: Verdict) {
		match verdict {
			Verdict::Continue => {},
			Verdict::Pause => self.ctl.request(PAUSE, RESUME),
			Verdict::Cancel(sig) => self.ctl.request_cancel(sig),
		}
	}

	/// Emit an event at `node` of the vproc's current frame. A disabled kind
	/// returns before anything else; an enabled one stores the vproc and the
	/// node, which the host resolves only if it reads them
	/// ([`Event::node`], [`Event::span`], [`Event::run`]).
	#[inline]
	pub fn emit_op(&mut self, cx: &mut Cx<'_>, vp: &Vproc, node: u32, data: EventData<'_>) {
		if self.mask.contains(data.kind()) {
			let t_ns = cx.host.now_ns();
			self.deliver_op(cx, vp, node, data, t_ns);
		}
	}

	/// [`Self::emit_op`] stamped `t_ns`, a reading the caller took for the
	/// event's own duration or shares ([`Self::stamp`],
	/// [`Self::read_clock`]); take it only when the kind is enabled.
	#[inline]
	pub fn emit_op_at(
		&mut self,
		cx: &mut Cx<'_>,
		vp: &Vproc,
		node: u32,
		data: EventData<'_>,
		t_ns: u64,
	) {
		if self.mask.contains(data.kind()) {
			// Built in place at the (few, hot) callers: no lookup, one call
			// per event.
			let ev = Event::of_op(self.seq, t_ns, vp, node, data);
			self.send(cx, &ev);
		}
	}

	/// The event of [`Self::emit_op`] handed to the host, out of line like
	/// [`Self::deliver_at`].
	#[inline(never)]
	fn deliver_op(
		&mut self,
		cx: &mut Cx<'_>,
		vp: &Vproc,
		node: u32,
		data: EventData<'_>,
		t_ns: u64,
	) {
		let ev = Event::of_op(self.seq, t_ns, vp, node, data);
		self.send(cx, &ev);
	}

	/// Queue a diagnostic on the vproc's stderr and emit a `Diag` event.
	pub fn diag(&mut self, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32, diag: Diag) {
		let bytes = self.render_diag(cx, vp, line, &diag);
		vp.out
			.push_back(PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
	}

	/// The stderr bytes of a diagnostic; emits the `Diag` event. Builtins
	/// queue the bytes with their own output to keep stdout/stderr order.
	pub fn render_diag(&mut self, cx: &mut Cx<'_>, vp: &Vproc, line: u32, diag: &Diag) -> Vec<u8> {
		let bytes = self.render_quiet(cx, vp, line, diag);
		self.diag_event(cx, vp, diag);
		bytes
	}

	/// The stderr bytes of a diagnostic, without its event: also what a
	/// spawned process prints for a redirection it applies itself
	/// ([`crate::bash::ChildRedir`]).
	pub fn render_quiet(&mut self, cx: &mut Cx<'_>, vp: &Vproc, line: u32, diag: &Diag) -> Vec<u8> {
		if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			let (mut prefix, mut zline) = self.zsh_site(cx, vp, line);
			if self.zsh_shinstdin(cx, vp) {
				prefix.clear();
				zline = 0;
			}
			return crate::bash::diag::render_zsh(diag, crate::bash::diag::ZshSite {
				prefix: &prefix,
				line:   zline,
			});
		}
		static COMMAND: Origin = Origin::Command;
		let origin = vp
			.runs
			.front()
			.and_then(|r| r.chain.links.first())
			.map_or(&COMMAND, |l| &l.origin);
		let utf8 = locale::is_utf8(self, cx.store, vp);
		// An in-engine nested shell names itself (its `$0`).
		let shell_name = match vp
			.overlay
			.as_ref()
			.and_then(|o| o.records.get(&KeyBuf::Misc(MiscKey::Argv0)))
		{
			Some(Some(Record::Misc(name))) => name.as_slice(),
			_ => self.argv0.as_slice(),
		};
		render(diag, DiagSite { shell_name, origin, line, utf8 })
	}

	/// The `Diag` event of a diagnostic `vp` prints.
	fn diag_event(&mut self, cx: &mut Cx<'_>, vp: &Vproc, diag: &Diag) {
		if self.mask.contains(crate::bash::event::EventKind::Diag) {
			let message = BString::from(diag.to_string());
			self.emit(cx, (vp.vpid, vp.mode), vp.runs.front(), EventData::Diag {
				code:    diag.code(),
				message: BStr::new(&message),
			});
		}
	}

	/// zsh's `scriptname` and `lineno` for a diagnostic of `vp` at script
	/// line `line` (zsh `zwarning`): the innermost function's name with the
	/// line counted from its definition, `(eval)` with the line in the
	/// eval'd text, a sourced file's name, the script's path, or `zsh` for a
	/// `-c` string or standard input.
	fn zsh_site(&self, cx: &mut Cx<'_>, vp: &Vproc, line: u32) -> (BString, u32) {
		let (name, base) = self.zsh_site_base(cx.store, vp);
		(name, line.saturating_sub(base))
	}

	/// zsh `zwarning`'s `isset(SHINSTDIN) && !locallevel`: commands read
	/// from standard input, outside functions (`locallevel`) and sourced
	/// files (`source` turns `shinstdin` off), report without a script name
	/// or line ([`crate::bash::diag::ZshSite`] with an empty prefix). A subshell
	/// decides by the site it inherited.
	fn zsh_shinstdin(&mut self, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
		let mut top = false;
		for f in &vp.frames {
			match f.kind {
				FrameKind::Function { .. } | FrameKind::Script { what: ScriptKind::Source, .. } => {
					return false;
				},
				FrameKind::Script { what: ScriptKind::Run, .. } => top = true,
				_ => {},
			}
		}
		let inherited = vp.zsh.as_ref().and_then(|z| z.site.as_ref());
		if !top && inherited.is_none_or(|(name, _)| name.as_slice() != b"zsh") {
			return false;
		}
		let opt = crate::bash::zshopt::ZshOpt::Shinstdin;
		state::zsh_option(&mut self.root, cx.store, vp, opt).unwrap_or(false)
	}

	/// [`Self::zsh_site`] of `vp` as the script name and the script line
	/// its lines count from (`u32::MAX`: a function without a definition
	/// line, which prints no line); a subshell without a site of its own
	/// takes the one its parent had when it started ([`proc::VprocZsh::site`]).
	fn zsh_site_base(&self, store: &mut dyn StateStore, vp: &Vproc) -> (BString, u32) {
		for (i, f) in vp.frames.iter().enumerate().rev() {
			match &f.kind {
				// zsh numbers a function's lines from its definition's (0,
				// which prints no line).
				FrameKind::Function { name, .. } => {
					let start = f
						.unit
						.as_ref()
						.map_or(u32::MAX, |u| callstack::definition_line(u));
					return (name.clone(), start);
				},
				// The text of a command substitution run in a child vproc:
				// zsh reports it under its parent's name.
				FrameKind::Script { what: ScriptKind::Eval, .. } if i == 0 && vp.parent.is_some() => {},
				FrameKind::Script { what: ScriptKind::Eval, .. } => {
					return (BString::from("(eval)"), 0);
				},
				FrameKind::Script { what: ScriptKind::Source, .. } => {
					let file = vp.calls.iter().rev().find_map(|c| match &c.kind {
						callstack::CallKind::Source { file, .. } => Some(file.clone()),
						_ => None,
					});
					return (file.unwrap_or_else(|| BString::from("zsh")), 0);
				},
				FrameKind::Script { what: ScriptKind::Run, .. } => {
					let link = vp.runs.front().and_then(|r| r.chain.links.first());
					let name = if let Some(l) = link {
						if let Origin::File(path) = &l.origin {
							path.clone()
						} else {
							BString::from("zsh")
						}
					} else {
						let argv0 =
							state::dollar0(store, vp, &self.argv0).unwrap_or_else(|_| self.argv0.clone());
						let base = argv0.rsplit(|&c| c == b'/').next().unwrap_or_default();
						BString::from(base)
					};
					return (name, 0);
				},
				_ => {},
			}
		}
		match vp.zsh.as_ref().and_then(|z| z.site.as_ref()) {
			Some((name, base)) => (name.clone(), *base),
			None => (BString::from("zsh"), 0),
		}
	}

	/// Record a store failure; the next scheduler turn abandons every script.
	pub fn fail(&mut self, err: StoreError) {
		self.root.fail(err);
	}
}

/// The level an imported `SHLVL` gives (before the shell adds one): bash
/// takes a whole number or 0, zsh (`zstrtol`, never evaluated) the leading
/// number. Called at shell startup and for nested shells.
fn imported_shlvl(value: &[u8], zsh: bool) -> i32 {
	if !zsh {
		return std::str::from_utf8(value)
			.ok()
			.and_then(|v| v.parse().ok())
			.unwrap_or(0);
	}
	let v = value.trim_ascii_start();
	let (neg, digits) = match v.split_first() {
		Some((b'-', rest)) => (true, rest),
		Some((b'+', rest)) => (false, rest),
		_ => (false, v),
	};
	let n = digits
		.iter()
		.take_while(|c| c.is_ascii_digit())
		.fold(0i32, |n, &c| n.wrapping_mul(10).wrapping_add(i32::from(c - b'0')));
	if neg { n.wrapping_neg() } else { n }
}

/// Whether `name` is a shell identifier.
pub fn is_ident(name: &[u8]) -> bool {
	name
		.first()
		.is_some_and(|&c| c == b'_' || c.is_ascii_alphabetic())
		&& name.iter().all(|&c| c == b'_' || c.is_ascii_alphanumeric())
}

/// The shell's own stdio as an fd table.
fn host_stdio(host: &mut dyn Host, cache: &mut [Option<FdRef>; 3]) -> FdTable {
	let mut fds = FdTable::default();
	for s in [StdFd::Stdin, StdFd::Stdout, StdFd::Stderr] {
		let i = s.fd() as usize;
		let r = cache[i].get_or_insert_with(|| match host.stdio(s) {
			Some(f) => FdRef::open(f, FdOrigin::Std(s)),
			None => FdRef::closed(),
		});
		fds.set(s.fd(), Some(r.clone()));
	}
	fds
}

/// Shell variables bash sets at startup (not exported unless imported).
fn startup_vars(k: &mut Kernel, cx: &mut Cx<'_>, init: &ShellInit) -> Result<(), StoreError> {
	let ppid = cx.host.ppid();
	let need_shell = state::global(cx.store, b"SHELL")?.is_none();
	let deferred_shell = if need_shell && init.mode.dialect() != crate::bash::ids::Dialect::Zsh {
		match cx.host.login_shell_initializer() {
			Some(initializer) => cx.store.defer_scalar(b"SHELL", Attrs::NONE, initializer)?,
			None => false,
		}
	} else {
		false
	};
	let values = if init.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		zsh_startup_values(cx)
	} else {
		startup_values(cx, &init.argv0, ppid, need_shell && !deferred_shell)
	};
	for (name, var, forced) in values {
		if forced || state::global(cx.store, name)?.is_none() {
			k.root.set_var(cx.store, name, Some(var));
		}
	}
	Ok(())
}

/// The plain variables zsh 5.9 sets at startup (`init.c` `setupvals`,
/// `params.c` defaults), as `(name, value, forced)` like
/// [`startup_values`]; zsh's special parameters (`PPID`, `USERNAME`,
/// `ZSH_VERSION`, …) are computed by the zsh dialect, not stored.
pub fn zsh_startup_values(cx: &Cx<'_>) -> Vec<(&'static [u8], Var, bool)> {
	let user = cx.host.user();
	let defaults: [(&'static [u8], &[u8]); 22] = [
		(b"IFS", b" \t\n\0"),
		(b"PS1", b"%m%# "),
		(b"PS2", b"%_> "),
		(b"PS3", b"?# "),
		(b"PS4", b"+%N:%i> "),
		(b"SPROMPT", b"zsh: correct '%R' to '%r' [nyae]? "),
		(b"WORDCHARS", b"*?_-.[]~=/&;!#$%^(){}<>"),
		(b"TMPPREFIX", b"/tmp/zsh"),
		(b"KEYTIMEOUT", b"40"),
		(b"LISTMAX", b"100"),
		(b"MAILCHECK", b"60"),
		(b"OPTIND", b"1"),
		(b"PATH", b"/bin:/usr/bin:/usr/ucb:/usr/local/bin"),
		(b"NULLCMD", b"cat"),
		(b"READNULLCMD", b"more"),
		// The scalar sides of the special ties start set (empty): `$+cdpath`
		// is 1 until `unset CDPATH` (`params.c` `IPDEF8`).
		(b"FPATH", b""),
		(b"CDPATH", b""),
		(b"MANPATH", b""),
		(b"MODULE_PATH", b""),
		(b"MAILPATH", b""),
		(b"PSVAR", b""),
		(b"FIGNORE", b""),
	];
	let mut out: Vec<(&'static [u8], Var, bool)> = defaults
		.into_iter()
		.map(|(name, value)| (name, Var::scalar(value, Attrs::NONE), false))
		.collect();
	if !user.home.is_empty() {
		out.push((&b"HOME"[..], Var::scalar(user.home, Attrs::NONE), false));
	}
	out
}

/// bash's startup variables of a new shell named `argv0` whose `$PPID` is
/// `ppid`, as `(name, value, forced)`: a variable already set (imported)
/// keeps its value unless `forced`. Shared by [`Shell::create`] and the
/// in-engine nested shell (`nested`). `need_shell`: `SHELL` is not set yet,
/// so the host's [`login_shell`](Host::login_shell) is looked up (bash's
/// `set_shell_var`); otherwise the value would be dropped and the lookup
/// (slow on macOS) is skipped.
pub fn startup_values(
	cx: &Cx<'_>,
	argv0: &[u8],
	ppid: u32,
	need_shell: bool,
) -> Vec<(&'static [u8], Var, bool)> {
	let user = cx.host.user();
	let shell = if need_shell {
		cx.host.login_shell().unwrap_or_default()
	} else {
		BString::default()
	};
	let defaults: [(&'static [u8], BString); 17] = [
		(b"IFS", BString::from(" \t\n")),
		(b"PS2", BString::from("> ")),
		(b"PS4", BString::from("+ ")),
		(b"OPTIND", BString::from("1")),
		(b"OPTERR", BString::from("1")),
		(b"BASH_VERSION", BString::from(BASH_VERSION)),
		(b"BASH", BString::from(argv0)),
		(b"HOSTNAME", cx.host.hostname()),
		(b"PPID", BString::from(ppid.to_string())),
		(b"UID", BString::from(user.uid.to_string())),
		(b"EUID", BString::from(user.euid.to_string())),
		(b"HOSTTYPE", BString::from(std::env::consts::ARCH)),
		(b"OSTYPE", BString::from(std::env::consts::OS)),
		(b"HOME", user.home),
		(b"SHELL", shell),
		(b"TERM", BString::from("dumb")),
		// bash's `DEFAULT_PATH_VALUE` when the environment has no PATH.
		(b"PATH", BString::from(crate::bash::invocation::DEFAULT_PATH)),
	];
	let mut out = Vec::with_capacity(defaults.len() + 2);
	for (name, value) in defaults {
		// bash sets HOME and SHELL from the passwd entry only when known.
		if matches!(name, b"HOME" | b"SHELL") && value.is_empty() {
			continue;
		}
		// `PPID` and `EUID` (and `UID` when not imported) are readonly
		// integers; `PPID` is always the parent's.
		let attrs = if matches!(name, b"PPID" | b"UID" | b"EUID") {
			Attrs::READONLY.with(Attrs::INTEGER)
		} else {
			Attrs::NONE
		};
		out.push((name, Var::scalar(value, attrs), name == b"PPID"));
	}
	let versinfo = ["5", "3", "0", "1", "release", std::env::consts::ARCH];
	out.push((
		&b"BASH_VERSINFO"[..],
		Var {
			attrs: Attrs::READONLY,
			value: VarValue::Indexed(
				versinfo
					.iter()
					.enumerate()
					.map(|(i, v)| (i as i64, BString::from(*v)))
					.collect(),
			),
		},
		true,
	));
	// bash's `get_group_list`: the real gid first, then the supplementary
	// groups other than it. Assignments to `GROUPS` are ignored (`set_value`).
	let groups = std::iter::once(user.gid).chain(user.groups.into_iter().filter(|&g| g != user.gid));
	out.push((
		&b"GROUPS"[..],
		Var {
			attrs: Attrs::NONE,
			value: VarValue::Indexed(
				groups
					.enumerate()
					.map(|(i, g)| (i as i64, BString::from(g.to_string())))
					.collect(),
			),
		},
		true,
	));
	out
}

impl Shell {
	/// New shell: writes the initial root state (environment, `$0`,
	/// positional parameters, options, cwd, `$$`, bash's startup variables,
	/// imported functions) into `cx.store`.
	///
	/// # Errors
	///
	/// [`ShellError::UnknownOption`] for an option name bash does not know;
	/// [`ShellError::Store`] when the store fails.
	pub fn create(
		engine: &Arc<Engine>,
		cx: &mut Cx<'_>,
		init: ShellInit,
	) -> Result<Self, ShellError> {
		let shell_pid = if init.shell_pid == 0 {
			cx.host.shell_pid()
		} else {
			init.shell_pid
		};
		let root = Root::load(cx.store).map_err(ShellError::Store)?;
		let mut k = Kernel::new(engine, root, init.argv0.clone(), shell_pid);
		k.rand = state::Random::new((cx.host.random() & 0xffff_ffff) as u32);
		k.root.set_misc(cx.store, MiscKey::Random, k.rand.encode());
		k.start_ns = cx.host.now_ns();
		k.root
			.set_misc(cx.store, MiscKey::StartNs, k.start_ns.to_string());
		k.startup.clone_from(&init.startup);
		let mut foreign: Vec<BString> = Vec::new();
		for (name, value) in &init.env {
			if let Some(func) = name
				.strip_prefix(b"BASH_FUNC_")
				.and_then(|n| n.strip_suffix(b"%%"))
			{
				import_function(&mut k, cx.store, func, value);
			} else if is_ident(name) {
				k.root
					.set_var(cx.store, name, Some(Var::scalar(value.clone(), Attrs::EXPORT)));
			} else {
				let mut entry = name.clone();
				entry.push(b'=');
				entry.extend_from_slice(value);
				foreign.push(entry);
			}
		}
		if !foreign.is_empty() {
			k.root.set_record(
				cx.store,
				KeyBuf::Misc(MiscKey::ForeignEnv),
				Some(Record::Words(foreign)),
			);
		}
		k.root
			.set_var(cx.store, b"PWD", Some(Var::scalar(init.cwd.clone(), Attrs::EXPORT)));
		let zsh = init.mode.dialect() == crate::bash::ids::Dialect::Zsh;
		let shlvl = state::global(cx.store, b"SHLVL")?
			.and_then(|v| v.as_scalar())
			.map_or(0, |v| imported_shlvl(v, zsh));
		k.root
			.set_var(cx.store, b"SHLVL", Some(Var::scalar((shlvl + 1).to_string(), Attrs::EXPORT)));
		startup_vars(&mut k, cx, &init)?;
		// bash's `sv_strict_posix` at import: `POSIXLY_CORRECT` (or
		// `POSIX_PEDANTIC`) in the environment turns POSIX mode on; explicit
		// options below still win.
		let mut posix = init
			.env
			.iter()
			.any(|(n, _)| matches!(n.as_slice(), b"POSIXLY_CORRECT" | b"POSIX_PEDANTIC"));
		// A zsh-dialect shell's options are zsh's, applied once its root vproc
		// exists (below).
		let mut zsh_options = Vec::new();
		for (name, on) in &init.options {
			if zsh {
				let (opt, inverted) = crate::bash::zshopt::ZshOpt::lookup(name)
					.ok_or_else(|| ShellError::UnknownOption { name: name.clone() })?;
				zsh_options.push((opt, *on != inverted));
				continue;
			}
			let opt = OptId::from_name(name)
				.ok_or_else(|| ShellError::UnknownOption { name: name.clone() })?;
			k.root.set_option(cx.store, opt, *on);
			if opt == OptId::Posix {
				posix = *on;
			}
		}
		// Posix mode turns `expand_aliases` on (`bash --posix`, `-o posix`).
		if posix {
			k.root.set_option(cx.store, OptId::Posix, true);
			k.root.set_option(cx.store, OptId::ExpandAliases, true);
		}
		state::init_option_vars(&mut k.root, cx.store)?;
		k.root
			.set_misc(cx.store, MiscKey::Argv0, init.argv0.clone());
		k.root
			.set_misc(cx.store, MiscKey::ShellPid, shell_pid.to_string());
		k.root.set_misc(cx.store, MiscKey::Cwd, init.cwd.clone());
		k.root.set_misc(cx.store, MiscKey::Status, "0");
		k.root
			.set_misc(cx.store, MiscKey::Mode, <&'static str>::from(init.mode));
		k.root
			.set_misc(cx.store, MiscKey::Interactive, if init.interactive { "1" } else { "0" });
		k.root
			.set_misc(cx.store, MiscKey::Umask, format!("{:04o}", cx.host.umask() & 0o7777));
		k.root.set_positional(cx.store, init.args);
		for sig in cx.host.ignored_signals().iter() {
			k.root.set_record(
				cx.store,
				KeyBuf::Trap(crate::bash::store::TrapKey::Signal(sig)),
				Some(Record::Trap { mode: init.mode, action: BString::default() }),
			);
		}
		let vpid = k.vpid(cx.store);
		if let Some(err) = k.root.take_fault() {
			return Err(ShellError::Store(err));
		}
		let mut fds = host_stdio(cx.host, &mut [None, None, None]);
		for (fd, file) in cx.host.inherited_fds() {
			if fd > 2 {
				fds.set(fd, Some(FdRef::open(file, FdOrigin::Host)));
			}
		}
		let mut root = Vproc::new(vpid, None, fds, init.cwd, None, false);
		root.mode = init.mode;
		if zsh {
			let start = mode::ZshStart {
				mode:        init.mode,
				options:     &zsh_options,
				interactive: init.interactive,
				login:       init.argv0.first() == Some(&b'-'),
				stdin:       false,
			};
			mode::init_zsh_options(&mut k.root, cx.store, &mut root, &start)
				.map_err(ShellError::Store)?;
			if let Some(err) = k.root.take_fault() {
				return Err(ShellError::Store(err));
			}
		}
		Ok(Self {
			k,
			procs: vec![Box::new(root)],
			rr: 0,
			slice: None,
			gone: Vec::new(),
			orphans: Vec::new(),
		})
	}

	/// Rebind the root's standard streams to the host's current streams,
	/// including any higher-numbered duplicates of those streams.
	pub(crate) fn reset_root_stdio(&mut self, host: &mut dyn Host) {
		let fresh = host_stdio(host, &mut [None, None, None]);
		let fds = &mut self.procs[0].fds;
		for fd in 3..fds.slots().len() {
			if let Some(FdOrigin::Std(stream)) = fds.get(fd as i32).map(FdRef::origin) {
				fds.set(fd as i32, fresh.get(stream.fd()).cloned());
			}
		}
		for fd in 0..3 {
			fds.set(fd, fresh.get(fd).cloned());
		}
	}

	/// Queue a script; see [`VprocSel`] for where it runs. A new subshell
	/// starts from the shell's global state: it does not see the locals of
	/// a function the shell is in the middle of (a host submits between
	/// steps, at no particular point of the root's execution).
	pub fn submit(&mut self, script: Script) -> RunId {
		self.submit_from(0, script, None, None)
	}

	/// [`Self::submit`] for the vproc at `parent` (`ShellApi::run_subshell`
	/// passes its store: the new subshell sees the caller's function
	/// scopes). A new subshell vproc gets `lineage`, or else the parent's.
	/// The new vproc is adopted, and its `Record::Proc` written, at the next
	/// scheduler turn.
	fn submit_from(
		&mut self,
		parent: usize,
		script: Script,
		mut store: Option<&mut dyn StateStore>,
		lineage: Option<crate::bash::host::Lineage>,
	) -> RunId {
		let id = RunId(self.k.next_run);
		self.k.next_run += 1;
		let mode = script.mode.unwrap_or(self.procs[parent].mode);
		let mut run = Run {
			id,
			tag: script.tag,
			src: script.source,
			chain: OriginChain { links: vec![OriginLink { origin: script.origin, at: None }] },
			mode,
			restore_mode: None,
			explicit_mode: script.mode.is_some(),
			lossy: 0,
			args: None,
			cwd: None,
			env: Vec::new(),
			started: false,
			exit_trap_started: false,
		};
		let stdio = match script.vproc {
			VprocSel::Root => {
				run.args = script.args;
				run.cwd = script.cwd;
				run.env = script.env;
				self.procs[0].runs.push_back(run);
				return id;
			},
			VprocSel::NewSubshell => None,
			VprocSel::NewSubshellWithStdio(stdio) => Some(stdio),
		};
		let p = &self.procs[parent];
		let mut overlay = p.overlay.clone().unwrap_or_default();
		if !script.foreign_env.is_empty() {
			let mut foreign = match store.as_deref_mut() {
				Some(store) => match state::record(store, p, Key::Misc(MiscKey::ForeignEnv)) {
					Ok(Some(Record::Words(entries))) => entries.clone(),
					Ok(_) => Vec::new(),
					Err(err) => {
						self.k.root.fail(err);
						Vec::new()
					},
				},
				None => match overlay.records.get(&KeyBuf::Misc(MiscKey::ForeignEnv)) {
					Some(Some(Record::Words(entries))) => entries.clone(),
					_ => Vec::new(),
				},
			};
			for (name, value) in script.foreign_env {
				if let Some(name) = name {
					foreign.retain(|entry| entry.split(|&b| b == b'=').next() != Some(name.as_slice()));
					if let Some(value) = value {
						let mut entry = name;
						entry.push(b'=');
						entry.extend_from_slice(&value);
						foreign.push(entry);
					}
				} else {
					foreign.clear();
				}
			}
			overlay
				.records
				.insert(KeyBuf::Misc(MiscKey::ForeignEnv), Some(Record::Words(foreign)));
		}
		for (name, value) in script.env {
			if is_ident(&name) {
				overlay
					.vars
					.insert(name, Some(Var::scalar(value, Attrs::EXPORT)));
			}
		}
		if let Some(args) = script.args {
			overlay.positional = Some(args);
		}
		let mut fds = p.fds.clone();
		if let Some(stdio) = stdio {
			for (fd, s) in stdio.into_iter().enumerate() {
				match s {
					RunStdio::Inherit => {},
					RunStdio::Closed => fds.set(fd as i32, None),
					RunStdio::File(f) => fds.set(fd as i32, Some(FdRef::open(f, FdOrigin::Host))),
				}
			}
		}
		let cwd = script.cwd.unwrap_or_else(|| p.cwd.clone());
		let status = p.status;
		let mut scopes = match store {
			Some(store) => state::copy_scopes(&self.k.root, store, p).unwrap_or_else(|err| {
				self.k.root.fail(err);
				Vec::new()
			}),
			None if p.overlay.is_some() => p.scopes.clone(),
			None => Vec::new(),
		};
		for name in script.unexport_env {
			overlay.vars.insert(name.clone(), None);
			for scope in &mut scopes {
				if let Some(Some(var)) = scope.vars.get_mut(&name) {
					var.attrs = var.attrs.without(Attrs::EXPORT);
				}
			}
		}
		let parent_vpid = p.vpid;
		// Written as `MiscKey::NextVpid` before the next step returns
		// (`Kernel::sync_root`).
		let vpid = Vpid(self.k.next_vpid);
		self.k.next_vpid += 1;
		let parent_lineage = self.procs[parent].lineage;
		let mut vp = Vproc::new(vpid, Some(parent_vpid), fds, cwd, Some(overlay), true);
		vp.lineage = lineage.unwrap_or(parent_lineage);
		vp.status = status;
		vp.scopes = scopes;
		vp.mode = mode;
		vp.runs.push_back(run);
		self.k.spawned.push(Box::new(vp));
		id
	}

	/// Another writer changed the store since the engine last looked:
	/// drop what the engine derived from it and re-read the root vproc's
	/// working directory (a TS tool may have moved the shell). Called at
	/// every engine entry that runs or inspects shell code (`step`, `api`,
	/// `externalize`).
	fn see_epoch(&mut self, cx: &mut Cx<'_>) {
		let epoch = cx.store.epoch();
		if epoch == self.k.root.epoch() {
			return;
		}
		self.k.root.invalidate(cx.store, epoch);
		match state::root_misc(cx.store, MiscKey::Cwd) {
			Ok(Some(cwd)) => {
				let cwd = BString::from(cwd);
				self.procs[0].cwd = cwd;
			},
			Ok(None) => {},
			Err(err) => self.k.fail(err),
		}
		// The root's mode too (a copied or restored store).
		match state::root_misc(cx.store, MiscKey::Mode) {
			Ok(Some(m)) => {
				if let Some(mode) = std::str::from_utf8(m).ok().and_then(|m| m.parse().ok()) {
					self.procs[0].mode = mode;
				}
			},
			Ok(None) => {},
			Err(err) => self.k.fail(err),
		}
	}

	/// Run up to `budget` of work; see [`Step`]. Before it returns, the
	/// store holds every change the step made (`Kernel::sync_root` writes
	/// the root vproc's in-place fields).
	pub fn step(&mut self, cx: &mut Cx<'_>, budget: Budget) -> Step {
		self.see_epoch(cx);
		// Subshells a host submitted since the last step.
		self.adopt(cx);
		self.settle_callouts();
		if self.k.reannounce {
			self.announce_live(cx);
		}
		let step = self.step_inner(cx, budget);
		self.k.sync_root(cx.store, &self.procs[0]);
		step
	}

	/// Announce (`UnitCompiled`, as shell-level events) every unit this
	/// shell can still run: the bodies of the functions the store and the
	/// subshell overlays define, and the units of every frame. Runs at the
	/// first step after `create` (imported functions) and `restore` (the
	/// host may be a new process that saw no event of the shell), with the
	/// event mask the host set by then. A function whose body is neither
	/// cached nor in the store is announced when a call recompiles it.
	fn announce_live(&mut self, cx: &mut Cx<'_>) {
		self.k.reannounce = false;
		self.k.announced.clear();
		let mut ids = Vec::new();
		let scanned = cx.store.scan(Table::Func, &mut |_, rec| {
			if let Record::Func { unit, .. } = rec {
				ids.push(*unit);
			}
		});
		if let Err(err) = scanned {
			self.k.fail(err);
			return;
		}
		for vp in &self.procs {
			if let Some(ov) = &vp.overlay {
				ids.extend(ov.records.values().filter_map(|rec| match rec {
					Some(Record::Func { unit, .. }) => Some(*unit),
					_ => None,
				}));
			}
		}
		let mut units = Vec::with_capacity(ids.len());
		for id in ids {
			match frames::load_unit(&self.k.engine, cx.store, id) {
				Ok(unit) => units.push(unit),
				Err(RestoreError::Store(err)) => {
					self.k.fail(err);
					return;
				},
				// Missing or unusable: the call recompiles the body from its
				// source and announces it then.
				Err(_) => {},
			}
		}
		for vp in &self.procs {
			units.extend(vp.frames.iter().filter_map(|f| f.unit.clone()));
		}
		let root = self.procs[0].vpid;
		for unit in &units {
			exec::announce(&mut self.k, cx, root, None, unit, unit.line);
		}
	}

	fn step_inner(&mut self, cx: &mut Cx<'_>, budget: Budget) -> Step {
		let start = cx.host.now_ns();
		let mut ops = 0u32;
		loop {
			if let Some(err) = self.k.root.take_fault() {
				self.fail_all(cx, &err);
			}
			// The orphans of subshells a signal ended (`apply_requests`), or
			// that a restore found; before `report`, which tells of the runs
			// ending them ended.
			if !self.k.paused {
				self.end_orphans(cx, None);
			}
			if let Some(step) = self.report() {
				return step;
			}
			if self.k.ctl.word() != 0 {
				if let Some(step) = self.apply_requests(cx) {
					return step;
				}
				continue;
			}
			if self.k.paused {
				self.k.ctl.park(self.k.ctl.wakes());
				return Step::Paused;
			}
			if !self.procs.iter().any(|p| p.has_work()) {
				return Step::Idle;
			}
			let wakes = self.k.ctl.wakes();
			let cont = self.slice.and_then(|(vpid, left)| {
				let i = self.procs.iter().position(|p| p.vpid == vpid)?;
				self.runnable(i, wakes).then_some((i, left))
			});
			let Some((i, left)) = cont.or_else(|| self.pick(wakes).map(|i| (i, SLICE))) else {
				self.slice = None;
				self.k.ctl.park(wakes);
				return Step::Blocked;
			};
			// `Yield` means runnable work is left: checked after `pick`.
			if ops >= budget.max_ops || cx.host.now_ns().saturating_sub(start) >= budget.max_ns {
				return Step::Yield;
			}
			if cont.is_none() {
				self.rr = (i + 1) % self.procs.len();
			}
			let slice = left.min(budget.max_ops - ops).max(1);
			let before = ops;
			exec::run_slice(&mut self.k, &mut self.procs[i], cx, slice, &mut ops);
			let used = ops - before;
			let p = &self.procs[i];
			let ran = p.vpid;
			self.slice = (used < left && p.has_work() && p.blocked.is_none() && !p.stopped)
				.then_some((ran, left - used));
			self.adopt(cx);
			self.end_orphans(cx, Some(ran));
		}
	}

	/// Move children created during the turn into the scheduler and reap
	/// subshell vprocs that finished.
	fn adopt(&mut self, cx: &mut Cx<'_>) {
		for p in &self.k.spawned {
			let rec = Record::Proc { parent: p.parent, status: None };
			self
				.k
				.root
				.write(cx.store, Change::Put(Key::Proc(p.vpid), rec));
		}
		self.procs.append(&mut self.k.spawned);
		self.apply_settled();
		let mut i = 0;
		while i < self.procs.len() {
			let p = &self.procs[i];
			// A subshell vproc exits once its frames and diagnostics are done.
			if p.transient && !p.has_work() && p.out.is_empty() {
				let p = self.procs.remove(i);
				// A job that ended undecided keeps its virtual pid.
				self.k.settle_bang(p.vpid, None);
				self.k.forget_deferral(p.vpid);
				self.k.proc_exited(cx.store, p.vpid, p.parent, p.status);
				self.k.ctl.notify();
				self.rr = 0;
				self.reaped(cx, p.parent, p.vpid, p.status);
			} else {
				i += 1;
			}
		}
	}

	/// Write the OS pids jobs settled on during the turn
	/// ([`Kernel::settled`]) into every job table listing them (the
	/// parent's, a command substitution's copies) and every `$!` naming
	/// them.
	fn apply_settled(&mut self) {
		for (job, pid) in std::mem::take(&mut self.k.settled) {
			for p in &mut self.procs {
				if p.last_bg.is(job) {
					p.last_bg.set_os(pid);
				}
				if let Some(entry) = p.jobs.by_vpid_mut(job) {
					entry.os_pid = Some(pid);
				}
			}
		}
	}

	/// A background job's lone command was a host callout
	/// ([`proc::BangStage::Callout`]) the host has seen: unless it handed
	/// the job to a subshell meanwhile
	/// ([`ShellApi::exec_subshell_in`]), the job keeps its virtual pid.
	/// Called when the host steps the shell again.
	fn settle_callouts(&mut self) {
		let seen: Vec<Vpid> = self
			.k
			.bangs
			.iter()
			.filter(|b| {
				b.stage == proc::BangStage::Callout
					&& !self
						.k
						.calls_out
						.iter()
						.any(|(_, call)| call.vpid == b.vproc)
			})
			.map(|b| b.vproc)
			.collect();
		for vproc in seen {
			self.k.settle_bang(vproc, None);
		}
	}

	/// Child vproc `vpid` of `parent` ended with `status`: the parent's job
	/// for it is done (`jobs`, `wait` see it) and a parent trapping
	/// `SIGCHLD` owes one more run of the trap.
	fn reaped(&mut self, cx: &mut Cx<'_>, parent: Option<Vpid>, vpid: Vpid, status: i32) {
		// Its own children are orphans now.
		if self.k.engine.config().end_orphan_jobs {
			self.gone.push(vpid);
		}
		let Some(i) = parent.and_then(|v| self.procs.iter().position(|p| p.vpid == v)) else {
			return;
		};
		let job = self.procs[i].jobs.by_vpid_mut(vpid);
		let background = job.is_some();
		if let Some(job) = job {
			job.state = proc::JobState::Done(status);
			job.notified = false;
		}
		owe_chld(&mut self.k, cx, &mut self.procs[i], background);
	}

	/// Vproc `vpid` stopped (`Some(signal)`) or continued (`None`). If it
	/// leads a job, the job's state follows, as bash's `waitchld` does: a
	/// stop makes the job current (`set_current_job`), a stopped job that
	/// continues makes bash `reset_current`; one `bg` or `kill -CONT`
	/// already marked running is left alone. Without job control bash never
	/// learns of stops (`waitpid` without `WUNTRACED`): the job stays
	/// running.
	fn job_changed(&mut self, cx: &mut Cx<'_>, vpid: Vpid, stop: Option<Signal>) {
		for p in &mut self.procs {
			if p.jobs.by_vpid(vpid).is_none() {
				continue;
			}
			if p.jobs.subshell
				|| !state::option(&mut self.k.root, cx.store, p, OptId::Monitor).unwrap_or(false)
			{
				return;
			}
			let Some(job) = p.jobs.by_vpid_mut(vpid) else {
				return;
			};
			let number = job.number;
			match (stop, job.state) {
				(_, proc::JobState::Done(_)) => {},
				(Some(sig), _) => {
					job.state = proc::JobState::Stopped(sig);
					job.notified = false;
					p.jobs.set_current(number);
				},
				(None, proc::JobState::Stopped(_)) => {
					job.state = proc::JobState::Running;
					job.notified = false;
					p.jobs.reset_current();
				},
				(None, proc::JobState::Running) => {},
			}
			return;
		}
	}

	/// Next vproc to run, round-robin: has work, not stopped, not parked at
	/// the current wake count.
	fn pick(&self, wakes: u64) -> Option<usize> {
		let n = self.procs.len();
		(0..n)
			.map(|off| (self.rr + off) % n)
			.find(|&i| self.runnable(i, wakes))
	}

	/// Vproc `i` has work and is neither stopped nor waiting for a wake that
	/// has not come.
	fn runnable(&self, i: usize, wakes: u64) -> bool {
		let p = &self.procs[i];
		p.has_work() && !p.stopped && p.blocked.as_ref().is_none_or(|b| b.at != wakes)
	}

	/// A finished script or an outgoing callout, if any.
	fn report(&mut self) -> Option<Step> {
		if let Some((run, status)) = self.k.done.pop_front() {
			self.k.reported_signal = self.k.exec_signals.remove(&run).map(|signal| (run, signal));
			return Some(Step::Done { run, status });
		}
		let (id, call) = self.k.calls_out.pop_front()?;
		Some(Step::Call { id, call })
	}

	/// Apply pending control requests.
	fn apply_requests(&mut self, cx: &mut Cx<'_>) -> Option<Step> {
		let req = self.k.ctl.take();
		if req & (CANCEL | SIGNAL) != 0 {
			// A cancel or signal concerns blocked vprocs too: let them run
			// (pause/resume deliberately do not).
			self.k.ctl.notify();
		}
		if req & CANCEL != 0 {
			let sig = self.k.ctl.cancel_signal();
			let status = sig.exit_status(self.k.engine.config().platform);
			for i in (0..self.procs.len()).rev() {
				// A detached tree (`nohup`) outlives the cancellation.
				if self.procs[i].lineage.detached {
					continue;
				}
				let key = crate::bash::store::TrapKey::Signal(sig);
				let trapped = sig != Signal::Kill
					&& self.procs[i].has_work()
					&& exec::start_trap(&mut self.k, &mut self.procs[i], cx, key);
				// bash runs the EXIT trap when a signal ends it: an untrapped
				// TERM/INT/… ends the shell's own vprocs through it too.
				let unwinds = trapped
					|| (sig != Signal::Kill && self.procs[i].has_work() && !self.procs[i].transient);
				if unwinds {
					for frame in &mut self.procs[i].frames {
						if let Some(sc) = frame.scratch.as_mut() {
							// A spawn still pending never starts: the cancelled
							// command is not resumed (the trap is the last action).
							if matches!(sc.live, Live::Spawn(_)) {
								sc.live = Live::None;
							}
							match &mut sc.live {
								Live::Task(task) => task.signal(sig),
								Live::Ext(ext) => {
									let _ = ext.signal(sig);
									let _ = ext.cont();
								},
								_ => {},
							}
						}
					}
					self.procs[i].stopped = false;
					if trapped {
						exec::mark_cancel(&mut self.procs[i], status);
					} else {
						exec::finish_cancel(&mut self.k.root, cx.store, &mut self.procs[i], status);
					}
				} else {
					self.kill(cx, i, sig, status);
				}
			}
			// Calls of the cancelled vprocs are void; a detached tree's go on.
			let detached: Vec<Vpid> = self
				.procs
				.iter()
				.filter(|p| p.lineage.detached)
				.map(|p| p.vpid)
				.collect();
			let kept: Vec<CallId> = self
				.k
				.results
				.keys()
				.copied()
				.filter(|&id| {
					self
						.awaiting(id)
						.is_some_and(|i| detached.contains(&self.procs[i].vpid))
				})
				.collect();
			self
				.k
				.calls_out
				.retain(|(_, call)| detached.contains(&call.vpid));
			self.k.results.retain(|id, _| kept.contains(id));
			self.k.paused = false;
		}
		if req & SIGNAL != 0 {
			for (target, sig) in self.k.ctl.take_signals() {
				self.deliver(cx, target, sig);
			}
		}
		if req & PAUSE != 0 && !self.k.paused {
			self.set_paused(cx, true);
		}
		if req & RESUME != 0 && self.k.paused {
			self.set_paused(cx, false);
		}
		if req & SUSPEND != 0 {
			for p in &mut self.procs {
				for f in &mut p.frames {
					if let Some(sc) = f.scratch.as_mut()
						&& sc.live.is_idempotent_fs()
					{
						// Dropping requests cancellation; the stage re-issues it.
						sc.live = Live::None;
						p.blocked = None;
						self.k.dropped_fs += 1;
					}
				}
			}
			let root = (self.procs[0].vpid, self.procs[0].mode);
			self.k.emit(cx, root, None, EventData::Suspended);
			return Some(Step::SuspendReady);
		}
		None
	}

	/// Terminate vproc `i` with `status`: signal its task or external, end its
	/// scripts. Transient vprocs are removed.
	fn kill(&mut self, cx: &mut Cx<'_>, i: usize, sig: Signal, status: i32) {
		let p = &mut self.procs[i];
		for f in &mut p.frames {
			if let Some(sc) = f.scratch.as_mut() {
				match &mut sc.live {
					Live::Task(t) => t.signal(sig),
					Live::Ext(e) => {
						let _ = e.signal(sig);
						let _ = e.cont();
					},
					_ => {},
				}
			}
		}
		exec::unwind(&mut self.k.root, cx.store, p, 0);
		while state::drop_scope(&mut self.k.root, cx.store, p) {}
		p.out.clear();
		p.blocked = None;
		p.stopped = false;
		p.status = status;
		let runs: Vec<Run> = p.runs.drain(..).collect();
		let vpid = (p.vpid, p.mode);
		for run in &runs {
			self.k.exec_signals.remove(&run.id);
			if run.started {
				self
					.k
					.emit(cx, vpid, Some(run), EventData::RunEnd { status });
			}
			self.k.done.push_back((run.id, status));
		}
		if self.procs[i].transient {
			let p = self.procs.remove(i);
			self.k.settle_bang(p.vpid, None);
			self.k.forget_deferral(p.vpid);
			self.k.proc_exited(cx.store, p.vpid, p.parent, status);
			self.rr = 0;
			self.reaped(cx, p.parent, p.vpid, status);
		}
	}

	/// Add to `hits` (indices of signalled vprocs, left sorted) the labeled
	/// subshell trees that callouts of hit vprocs started
	/// ([`ShellApi::run_subshell_in`]), transitively: a signal to a callout's
	/// caller reaches its child tree, as one to a process reaches what it
	/// `exec`s or forwards to. Prunes the links of labels no vproc carries.
	fn callout_trees(&mut self, hits: &mut Vec<usize>) {
		let procs = &self.procs;
		let links = &mut self.k.callout_labels;
		links.retain(|&(label, _)| procs.iter().any(|p| p.lineage.label == label));
		let mut grew = !links.is_empty();
		while grew {
			grew = false;
			for &(label, caller) in links.iter() {
				if !hits.iter().any(|&i| procs[i].vpid == caller) {
					continue;
				}
				for (i, p) in procs.iter().enumerate() {
					if p.lineage.label == label && !hits.contains(&i) {
						hits.push(i);
						grew = true;
					}
				}
			}
		}
		hits.sort_unstable();
	}

	/// Whether `vpid` belongs to the job rooted at `root`, excluding nested
	/// jobs.
	fn in_job(&self, mut vpid: Vpid, root: Vpid) -> bool {
		loop {
			if vpid == root {
				return true;
			}
			let Some(parent) = self
				.procs
				.iter()
				.find(|p| p.vpid == vpid)
				.and_then(|p| p.parent)
			else {
				return false;
			};
			let Some(process) = self.procs.iter().find(|p| p.vpid == parent) else {
				return false;
			};
			if process.jobs.by_vpid(vpid).is_some() {
				return false;
			}
			vpid = parent;
		}
	}

	/// Deliver a virtual signal to its target or its configured trap.
	fn deliver(&mut self, cx: &mut Cx<'_>, target: SigTarget, sig: Signal) {
		let root = (self.procs[0].vpid, self.procs[0].mode);
		self
			.k
			.emit(cx, root, None, EventData::Signal { sig, target });
		let platform = self.k.engine.config().platform;
		let job_root = match target {
			SigTarget::Job(id) => self
				.procs
				.iter()
				.flat_map(|p| p.jobs.iter())
				.find(|job| job.id == id)
				.map(|job| job.vpid),
			_ => None,
		};
		let mut hits: Vec<usize> = (0..self.procs.len())
			.filter(|&i| match target {
				SigTarget::Vpid(v) => self.procs[i].vpid == v,
				SigTarget::All => true,
				SigTarget::Job(_) => job_root.is_some_and(|v| self.in_job(self.procs[i].vpid, v)),
				SigTarget::Label(l) => l != 0 && self.procs[i].lineage.label == l,
			})
			.collect();
		self.callout_trees(&mut hits);
		// Vprocs this signal stopped or continued (job states follow).
		let mut changed: Vec<(Vpid, Option<Signal>)> = Vec::new();
		for &i in hits.iter().rev() {
			let trap = if matches!(sig, Signal::Kill | Signal::Stop) {
				None
			} else {
				let key = crate::bash::store::TrapKey::Signal(sig);
				match state::record(cx.store, &self.procs[i], crate::bash::store::Key::Trap(key)) {
					Ok(Some(Record::Trap { action, .. })) => Some(action.is_empty()),
					Ok(_) => None,
					Err(err) => {
						self.k.fail(err);
						return;
					},
				}
			};
			let terminating = trap.is_none() && sig.default_action() == DefaultAction::Terminate;
			// A signal to the shell PID does not also target its foreground child.
			// A terminating child is signaled once by `kill`, not here and there.
			if target != SigTarget::Vpid(root.0) && !terminating {
				for frame in &mut self.procs[i].frames {
					if let Some(sc) = frame.scratch.as_mut() {
						match &mut sc.live {
							Live::Task(task) => task.signal(sig),
							Live::Ext(ext) => {
								let _ = ext.signal(sig);
							},
							_ => {},
						}
					}
				}
			}
			// A vproc that is just its program (bash would have `exec`'d it:
			// `cmd &`, a pipeline stage, `( cmd )`, `exec cmd`) or just waits
			// for children the signal reaches too (the job vproc of `a | b &`)
			// does not die by itself: the program gets the signal and may trap
			// it, and the vproc ends with the program's real status, once it
			// has exited (`wait` returns then, not before).
			if terminating && target != SigTarget::Vpid(root.0) {
				let reaches_children = !matches!(target, SigTarget::Vpid(_));
				if let Some(lone) = transparent(&self.procs[i], reaches_children) {
					let p = &mut self.procs[i];
					let stopped = p.stopped;
					if lone {
						for frame in &mut p.frames {
							if let Some(Live::Ext(ext)) = frame.scratch.as_mut().map(|sc| &mut sc.live) {
								let _ = ext.signal(sig);
							}
						}
					}
					if stopped {
						// Continued so the program can act on the signal (bash
						// `kill_pid` continues a stopped job it signals).
						set_stopped(p, false);
						changed.push((p.vpid, None));
					}
					continue;
				}
			}
			if let Some(ignored) = trap {
				if !ignored {
					let process = &mut self.procs[i];
					process.pending_traps = process.pending_traps.with(sig);
					if !process.waiting_foreground() {
						process.blocked = None;
					}
					// bash: a trapped signal ends the `wait` builtin with 128 + n
					// (then the trap runs); `SIGCHLD` does not.
					if sig != Signal::Chld {
						interrupt_wait(process, sig.exit_status(platform));
					}
				}
				continue;
			}
			match sig.default_action() {
				DefaultAction::Terminate => self.kill(cx, i, sig, sig.exit_status(platform)),
				DefaultAction::Stop | DefaultAction::Continue => {
					let stop = sig.default_action() == DefaultAction::Stop;
					let p = &mut self.procs[i];
					if p.stopped != stop {
						changed.push((p.vpid, stop.then_some(sig)));
					}
					set_stopped(p, stop);
				},
				DefaultAction::Ignore => {},
			}
		}
		for (vpid, stop) in changed {
			self.job_changed(cx, vpid, stop);
		}
	}

	fn set_paused(&mut self, cx: &mut Cx<'_>, on: bool) {
		self.k.paused = on;
		for p in &mut self.procs {
			pause_handles(p, on);
		}
		let root = (self.procs[0].vpid, self.procs[0].mode);
		let data = if on {
			EventData::Stopped { job: None }
		} else {
			EventData::Continued { job: None }
		};
		self.k.emit(cx, root, None, data);
	}

	/// Abandon every script after a store failure.
	fn fail_all(&mut self, cx: &mut Cx<'_>, err: &StoreError) {
		let root = (self.procs[0].vpid, self.procs[0].mode);
		let message = BString::from(format!("{}: {err}", Diag::StoreFailed));
		self.k.emit(cx, root, None, EventData::Diag {
			code:    Diag::StoreFailed.code(),
			message: BStr::new(&message),
		});
		for i in (0..self.procs.len()).rev() {
			self.kill(cx, i, Signal::Term, 1);
		}
	}

	/// Whether a vproc carrying lineage label `label` still exists (running,
	/// or submitted and not adopted yet): the label's tree has not ended.
	pub fn label_live(&self, label: u32) -> bool {
		label != 0
			&& self
				.procs
				.iter()
				.chain(&self.k.spawned)
				.any(|p| p.lineage.label == label)
	}

	/// Whether root run `run` (a [`VprocSel::Root`] script) ended through
	/// `exit` or `set -e` rather than by reaching its end: a host that runs
	/// one command as several root scripts stops after such a one, as bash
	/// would have left the command there. Known for the last such run only;
	/// ask right after its [`Step::Done`].
	pub fn ended_by_exit(&self, run: RunId) -> bool {
		self.k.exited == Some(run)
	}

	/// The signal that killed an external replacing `run`, if any. Ask
	/// immediately after its [`Step::Done`]; ordinary `exit 128+n` is not
	/// a signal death.
	pub fn exec_signal(&self, run: RunId) -> Option<i32> {
		self
			.k
			.reported_signal
			.filter(|(id, _)| *id == run)
			.map(|(_, signal)| signal)
	}

	/// Number of the root's background jobs that still wait for a running
	/// external process, or for the host to finish starting one (`sh -c
	/// 'sleep 9' &`, a pipeline stage); jobs that
	/// only run in-engine work (a builtin `sleep`, a loop) are not counted.
	/// A host keeping a shell alive for its externals asks this between
	/// scripts.
	pub fn live_external_jobs(&self) -> usize {
		let Some(root) = self.procs.first() else {
			return 0;
		};
		root
			.jobs
			.iter()
			.filter(|job| {
				self.procs.iter().any(|p| {
					self.in_job(p.vpid, job.vpid)
						&& p.frames.iter().any(|f| {
							f.scratch
								.as_ref()
								.is_some_and(|sc| matches!(sc.live, Live::Ext(_) | Live::Spawn(_)))
						})
				})
			})
			.count()
	}

	/// Answer a [`Step::Call`]. Unknown ids (cancelled scripts) are ignored.
	pub fn complete(&mut self, call: CallId, outcome: CallOutcome) {
		if self.awaiting(call).is_some() {
			self.k.results.insert(call, outcome);
			self.k.ctl.notify();
		}
	}

	/// Index of the vproc whose `Exec` awaits `call`.
	fn awaiting(&self, call: CallId) -> Option<usize> {
		self.procs.iter().position(|p| {
			p.frames.iter().any(|f| {
				f.scratch
					.as_ref()
					.and_then(|s| s.exec.as_ref())
					.is_some_and(|e| e.waiting == Some(proc::Awaited::Call(call)))
			})
		})
	}

	/// The engine waker. Hosts poll every [`Task`](crate::bash::Task),
	/// [`ExtProc`](crate::bash::ExtProc), [`FsPending`](crate::bash::FsPending)
	/// and [`File`] they hand the engine with a `Context` built from it; the
	/// engine already does so itself. Waking it makes
	/// [`ControlHandle::poll_runnable`] ready.
	pub fn wake(&self) -> Waker {
		self.k.waker.clone()
	}

	/// Thread-safe control handle.
	pub fn control(&self) -> ControlHandle {
		ControlHandle(Arc::clone(&self.k.ctl))
	}

	/// Select the emitted event kinds.
	pub const fn set_event_mask(&mut self, mask: EventMask) {
		self.k.mask = mask;
	}

	/// The current event mask.
	pub const fn event_mask(&self) -> EventMask {
		self.k.mask
	}
}

/// Define a function exported through the environment (`BASH_FUNC_f%%`).
fn import_function(k: &mut Kernel, store: &mut dyn StateStore, name: &[u8], value: &[u8]) {
	if let Some(rec) = imported_function(k, name, value) {
		if let Record::Func { unit, .. } = &rec
			&& let Some(unit) = k.engine.cached(unit)
		{
			k.persist_unit(store, &unit);
		}
		k.root
			.set_record(store, KeyBuf::Func(BString::from(name)), Some(rec));
	}
}

/// The function a `BASH_FUNC_name%%` environment entry defines (`None` when
/// the text is not exactly that function), for a new shell's state
/// ([`Shell::create`], the in-engine nested shell).
pub fn imported_function(k: &Kernel, name: &[u8], value: &[u8]) -> Option<Record> {
	if !value.starts_with(b"() {") {
		return None;
	}
	let mut src = Vec::with_capacity(name.len() + value.len() + 1);
	src.extend_from_slice(name);
	src.push(b' ');
	src.extend_from_slice(value);
	// bash `SEVAL_FUNCDEF`: the text must define exactly the function named.
	// Exported functions are bash text, whatever the shell's mode.
	let func = ir::function_from_source(&src, ModeId::Bash, crate::bash::syntax::Features::NONE)
		.filter(|f| f.name.as_slice() == name)?;
	let unit = k.engine.intern(*func.body);
	Some(Record::Func {
		mode:   ModeId::Bash,
		sticky: None,
		source: func.source,
		unit:   unit.id,
		attrs:  Attrs::EXPORT,
		// bash's `make_function_def` before the shell is initialized.
		file:   BString::from("environment"),
	})
}

/// A child of `p` finished: if `p` traps `SIGCHLD`, it owes one more run of
/// the trap (bash's `waitchld` counts the children it reaped and runs the
/// trap that many times). Called by the scheduler for child vprocs and by
/// `Exec` for externals `p` ran itself; `background`: the child was one of
/// `p`'s background jobs. zsh (`update_job`) runs the trap (a `trap` action
/// or the `TRAPCHLD` function) only for those, not for the foreground job.
pub fn owe_chld(k: &mut Kernel, cx: &mut Cx<'_>, p: &mut Vproc, background: bool) {
	let zsh = p.mode.dialect() == crate::bash::ids::Dialect::Zsh;
	if zsh && !background {
		return;
	}
	let key = crate::bash::store::Key::Trap(crate::bash::store::TrapKey::Signal(Signal::Chld));
	let trapped = match state::record(cx.store, p, key) {
		Ok(Some(Record::Trap { action, .. })) => !action.is_empty(),
		Ok(None) if zsh => matches!(
			state::record(cx.store, p, crate::bash::store::Key::Func(bstr::BStr::new(b"TRAPCHLD"))),
			Ok(Some(Record::Func { .. }))
		),
		Ok(_) => false,
		Err(err) => {
			k.fail(err);
			false
		},
	};
	if trapped {
		p.jobs.chld += 1;
		p.pending_traps = p.pending_traps.with(Signal::Chld);
		if !p.waiting_foreground() {
			p.blocked = None;
		}
	}
}

/// End a `wait` builtin that `p` is in with `status` (a trapped signal
/// arrived): its `Exec` completes at once, keeping the jobs it waited for.
fn interrupt_wait(p: &mut Vproc, status: i32) {
	for frame in &mut p.frames {
		let Some(e) = frame.scratch.as_mut().and_then(|sc| sc.exec.as_mut()) else {
			continue;
		};
		let waiting = matches!(
			e.waiting,
			Some(proc::Awaited::Jobs { .. } | proc::Awaited::AllJobs | proc::Awaited::AnyJob)
		);
		if waiting && e.target == Some(proc::Target::Intrinsic(crate::bash::ids::IntrinsicId::Wait)) {
			e.waiting = Some(proc::Awaited::Jobs { force: true });
			e.wait_for.clear();
			e.wait_into = None;
			e.status = status;
		}
	}
}

/// Whether a terminating signal to `p` is the business of what `p` runs
/// rather than of `p` itself, as when bash `exec`s a subshell's last
/// command: `Some(true)` when `p` is a subshell vproc (no `EXIT` trap of its
/// own) whose one frame awaits the external that is its last command (`cmd
/// &`, a pipeline stage, `( cmd )`) or one it `exec`s; `Some(false)` when it
/// only waits for the stages of its pipeline or its `( … )` before it exits
/// (the job vproc of `a | b &`), and the signal reaches those too
/// (`children`: a job, label or broadcast target); `None` otherwise.
fn transparent(p: &Vproc, children: bool) -> Option<bool> {
	if !p.transient || p.own_traps.has(crate::bash::store::TrapKey::Exit) {
		return None;
	}
	let [frame] = p.frames.as_slice() else {
		return None;
	};
	let unit = frame.unit.as_ref()?;
	let sc = frame.scratch.as_ref()?;
	let op = unit.ops.get(frame.pc as usize)?;
	let code_at = |pc: u32| unit.ops.get(pc as usize).map(|op| op.code);
	match (&sc.live, op.code) {
		(Live::Ext(_), ir::Opcode::Exec) => {
			let exec = sc.exec.as_ref().is_some_and(|e| e.exec_as.is_some());
			(exec || code_at(frame.pc + 1) == Some(ir::Opcode::SubExit)).then_some(true)
		},
		(_, ir::Opcode::Spawn) if children && !sc.children.is_empty() => {
			let spawn = unit.spawns.get(op.a as usize)?;
			let end = match (spawn.kind, code_at(spawn.end)) {
				// `( … )`: its `Leave` follows.
				(ir::SpawnKind::Subshell, Some(ir::Opcode::Leave)) => spawn.end + 1,
				(ir::SpawnKind::Subshell | ir::SpawnKind::Pipeline, _) => spawn.end,
				_ => return None,
			};
			(code_at(end) == Some(ir::Opcode::SubExit)).then_some(false)
		},
		_ => None,
	}
}

fn set_stopped(p: &mut Vproc, on: bool) {
	p.stopped = on;
	pause_handles(p, on);
}

/// Pause or resume a vproc's task or external.
fn pause_handles(p: &mut Vproc, on: bool) {
	for f in &mut p.frames {
		if let Some(sc) = f.scratch.as_mut() {
			match &mut sc.live {
				Live::Task(t) if on => t.pause(),
				Live::Task(t) => t.resume(),
				Live::Ext(e) if on => {
					let _ = e.stop();
				},
				Live::Ext(e) => {
					let _ = e.cont();
				},
				_ => {},
			}
		}
	}
}

impl Vproc {
	fn new(
		vpid: Vpid,
		parent: Option<Vpid>,
		fds: FdTable,
		cwd: BString,
		overlay: Option<Overlay>,
		transient: bool,
	) -> Self {
		Self {
			vpid,
			parent,
			runs: VecDeque::new(),
			frames: Vec::new(),
			scopes: Vec::new(),
			fds,
			cwd,
			status: 0,
			pipestatus: Vec::new(),
			overlay,
			out: VecDeque::new(),
			blocked: None,
			pending_traps: crate::bash::signal::SigSet::EMPTY,
			stopped: false,
			transient,
			jobs: proc::JobTable::default(),
			last_bg: proc::LastBg::default(),
			getopts: proc::GetoptsState { optind: None, next: None, at: None },
			procsubs: Vec::new(),
			coprocs: Vec::new(),
			restore_opts: Vec::new(),
			rlimits: Vec::new(),
			lineage: crate::bash::host::Lineage::default(),
			trace_base: 0,
			subshell: 0,
			command: None,
			spare: Vec::new(),
			calls: Vec::new(),
			own_traps: proc::OwnTraps::EMPTY,
			trap_frames: 0,
			mode: ModeId::Bash,
			zsh: None,
		}
	}

	/// A child of `self` (subshell, pipeline stage, background job, command
	/// substitution) that starts running `unit` at `entry` with `fds`.
	pub fn child(
		&self,
		k: &mut Kernel,
		store: &mut dyn StateStore,
		unit: Arc<Unit>,
		entry: u32,
		fds: FdTable,
	) -> Self {
		let line_shift = self.frames.last().map_or(0, |f| f.line_shift);
		// A `( … )` body follows its `Spawn` op.
		let subshell_line = entry
			.checked_sub(1)
			.and_then(|pc| unit.ops.get(pc as usize))
			.filter(|op| {
				op.code == ir::Opcode::Spawn
					&& unit
						.spawns
						.get(op.a as usize)
						.is_some_and(|s| s.kind == ir::SpawnKind::Subshell)
			})
			.map(|op| (unit.line + exec::end_line(&unit, op.node)).saturating_sub(line_shift));
		let mut frame = Frame::new(Some(unit), entry, proc::FrameKind::Subshell);
		// A subshell runs code of the same unit: it keeps the line numbering.
		frame.line_shift = line_shift;
		frame.subshell_line = subshell_line;
		self.child_running(k, store, fds, frame)
	}

	/// A subshell of `self` that parses and runs `src` from script line
	/// `line` (a `$( )` re-parsed with the aliases in effect).
	pub fn child_text(
		&self,
		k: &mut Kernel,
		store: &mut dyn StateStore,
		src: &[u8],
		line: u32,
		fds: FdTable,
	) -> Self {
		let kind = proc::FrameKind::script(
			src,
			crate::bash::syntax::Pos { offset: 0, line },
			proc::ScriptKind::Eval,
		);
		self.child_running(k, store, fds, Frame::new(None, 0, kind))
	}

	/// A subshell of `self` with `fds` whose first frame is `frame`; it
	/// starts with a copy of `self`'s function scopes (the root's are read
	/// from the store).
	fn child_running(
		&self,
		k: &mut Kernel,
		store: &mut dyn StateStore,
		fds: FdTable,
		mut frame: Frame,
	) -> Self {
		let vpid = k.vpid(store);
		let mut vp = Self::new(
			vpid,
			Some(self.vpid),
			fds,
			self.cwd.clone(),
			Some(self.overlay.clone().unwrap_or_default()),
			true,
		);
		// `$BASH_SUBSHELL`: one more than the parent's (a pipeline stage
		// or background job adjusts it, `exec::spawn`). The parent's
		// caught-signal traps stay in the overlay: the child lists them but
		// does not run them (`state::inherited_trap`).
		set_subshell_depth(&mut vp, subshell_depth(self).saturating_add(1));
		vp.status = self.status;
		vp.scopes = state::copy_scopes(&k.root, store, self).unwrap_or_else(|err| {
			k.fail(err);
			Vec::new()
		});
		// Exact: `clone_from` into the empty vector reserves four slots.
		vp.pipestatus.reserve_exact(self.pipestatus.len());
		vp.pipestatus.extend_from_slice(&self.pipestatus);
		vp.getopts.clone_from(&self.getopts);
		vp.command.clone_from(&self.command);
		vp.rlimits.clone_from(&self.rlimits);
		vp.lineage = self.lineage;
		vp.mode = self.mode;
		vp.set_sticky(self.sticky().cloned());
		// zsh forks keep `scriptname`: diagnostics of the child name the
		// parent's function, `(eval)` or file.
		if self.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			let site = k.zsh_site_base(store, self);
			let z = vp.zsh.get_or_insert_with(Box::default);
			z.site = Some(site);
			z.context = zsh::specials::eval_context(self);
		}
		// bash `without_job_control`: no jobs, no job control (a command
		// substitution turns it back on when it starts).
		vp.jobs.subshell = true;
		vp.calls = callstack::inherited(self);
		vp.trace_base = xtrace::level(self) - 1;
		// Started from a context where `set -e` is ignored (the parent's op
		// is a condition, or its frame runs in one): so is the child.
		frame.ignore_errexit = self.frames.last().is_some_and(|f| {
			f.ignore_errexit
				|| f
					.unit
					.as_ref()
					.and_then(|u| u.ops.get(f.pc as usize))
					.is_some_and(|op| op.flags & ir::Op::COND != 0)
		});
		// Room for exactly this frame: a `Frame` is ~300 bytes and a first
		// push reserves four (idle vproc ≤ 2 KiB); calls grow it.
		vp.frames.reserve_exact(1);
		vp.frames.push(frame);
		vp
	}
}

/// `$BASH_SUBSHELL` of `vp` ([`Vproc::subshell`]); zero for the shell
/// itself and a nested shell.
pub const fn subshell_depth(vp: &Vproc) -> u32 {
	vp.subshell
}

/// Set `vp`'s `$BASH_SUBSHELL` (a vproc without an overlay is the shell
/// itself and stays at zero). Called by `child_running` and by
/// `exec::spawn` for pipeline stages and background jobs.
pub const fn set_subshell_depth(vp: &mut Vproc, depth: u32) {
	if vp.overlay.is_some() {
		vp.subshell = depth;
	}
}

/// Scope of an assignment made by `vp`.
pub const fn assign_scope(vp: &Vproc) -> AssignScope {
	if vp.overlay.is_some() {
		AssignScope::Subshell
	} else {
		AssignScope::Global
	}
}
