//! The VM: shells, virtual processes and the cooperative scheduler.
//!
//! [`Shell::step`] runs ready virtual processes round-robin, up to 1024 ops
//! each per turn, and returns when a script finishes, a host callout is
//! needed, every vproc is blocked, the control word asks for a pause or a
//! suspend, or the [`Budget`] runs out. Every op dispatch is a safepoint: the
//! dispatch loop loads the control word before each op.

mod api;
pub(crate) mod arith;
mod builtins;
mod callstack;
mod command;
mod control;
mod exec;
mod expand;
mod fdprobe;
mod frames;
mod fsprobe;
mod glob;
mod jobctl;
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
mod zle;
mod zsh;

use std::{
	collections::{HashMap, HashSet, VecDeque},
	sync::Arc,
	task::Waker,
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

/// zsh/newuser's startup check, for the process shell's startup files.
pub use self::builtins::zsh_mod_newuser::startup_scripts as newuser_startup_scripts;
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
	state::{Root, Var},
};
use crate::bash::{
	Image,
	diag::{Diag, DiagSite, render},
	engine::Engine,
	error::ShellError,
	event::{AssignScope, Event, EventData, EventMask, Origin, OriginChain, OriginLink},
	fd::{FdOrigin, FdRef, FdTable},
	fs::File,
	host::{EnvView, Host, StdFd, Verdict},
	ids::{CallId, CmdTag, JobId, ModeId, RunId, ToolRef, UnitId, Vpid},
	image::Records,
	ir::{self, Unit},
	signal::{DefaultAction, SigTarget, Signal},
	store::{Attrs, Change, Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, VarValue},
};

/// Ops a vproc runs per scheduler turn.
const SLICE: u32 = 1024;

/// bash version this engine implements (`$BASH_VERSION`).
pub const BASH_VERSION: &str = "5.3.0(1)-release";

/// Largest buffer a kernel keeps for reuse (the spare syntax tree, the unit
/// blob encoder): every ordinary command fits, and a huge one's buffers are
/// freed instead of held for the shell's lifetime.
const SPARE_BUFFER_BYTES: usize = 1 << 20;

/// Unit ids [`Kernel::written`] remembers before it starts over.
const WRITTEN_MAX: usize = 1 << 16;

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
	/// Unexported parameters a zsh shell sets from its command line before
	/// its startup files: `ZSH_EXECUTION_STRING` (the `-c` string) and
	/// `ZSH_SCRIPT` (the script file).
	pub zsh_params:  Vec<(BString, BString)>,
	/// The system zsh's function directories, which a zsh shell's `fpath`
	/// starts with when the environment sets no `FPATH` (zsh's compiled-in
	/// `FPATH_DIR` and its subdirectories). `None`: zsh 5.9's default
	/// layout.
	pub zsh_fpath:   Option<Vec<BString>>,
	/// Whose shell it is: a user's, or a program's ([`Profile::Tool`]).
	pub profile:     Profile,
}

/// Whose shell a [`Shell`] is, which decides whether it may touch its
/// user's interactive state. Recorded at [`Shell::create`]
/// ([`MiscKey::Profile`]); nested shells (`bash -c`, `zsh -i`) inherit it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Profile {
	/// A user's own shell (`omp zsh`, obash): history, the line editor and
	/// the completion system work as in bash and zsh.
	#[default]
	User,
	/// A shell a program drives (an agent's `bash` tool, an embedder's
	/// session). It never reads, writes or records history (`fc -R/-W/-A`,
	/// `history -r/-w/-a/-n` fail on any history file; zsh's automatic
	/// load and save do not run), never edits lines on a terminal, has no
	/// completion system or key bindings (zsh/zle, zsh/complete,
	/// zsh/complist, zsh/computil, zsh/compctl, zsh/zleparameter and
	/// zsh/deltochar do not load, so `zle`, `bindkey`, `vared`, `compadd`, …
	/// fail; bash's `complete`, `compgen`, `compopt` and `bind` do not
	/// exist), and a nested interactive shell skips the interactive startup
	/// files (`~/.bashrc`, `$ENV`, `/etc/zshrc`, `.zshrc`) where completion
	/// and history are set up.
	Tool,
}

/// Whether `vp`'s shell was created with [`Profile::Tool`].
///
/// # Errors
/// [`StoreError`] when the record cannot be read.
pub fn is_tool(store: &mut dyn StateStore, vp: &Vproc) -> Result<bool, StoreError> {
	Ok(matches!(
		state::record(store, vp, Key::Misc(MiscKey::Profile))?,
		Some(Record::Misc(v)) if v.as_slice() == b"tool"
	))
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
			zsh_params:  Vec::new(),
			zsh_fpath:   None,
			profile:     Profile::User,
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
	/// Positional parameters for the script, replacing the inherited current
	/// positional scope in a new subshell without changing its caller.
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
	pub engine:             Arc<Engine>,
	pub ctl:                Arc<Ctl>,
	pub waker:              Waker,
	/// Facts derived from the root state in the store (the state itself
	/// lives in the store).
	pub root:               Root,
	pub mask:               EventMask,
	pub seq:                u64,
	pub next_vpid:          u32,
	pub next_run:           u64,
	pub next_call:          u64,
	pub next_cmd:           u64,
	pub next_job:           u32,
	pub done:               VecDeque<(RunId, i32)>,
	pub calls_out:          VecDeque<(CallId, ToolCall)>,
	pub results:            HashMap<CallId, CallOutcome>,
	/// Units announced by each vproc to the current observer. A prior
	/// background vproc's rejected events must not suppress current units.
	/// Not imaged: restored/cached frames announce lazily when executed.
	pub announced:          HashSet<(Vpid, UnitId, Option<crate::bash::event::SourceOrigin>)>,
	/// Observed script origins by actual activation depth. Empty without
	/// tracing.
	pub trace_sources:      HashMap<Vpid, HashMap<usize, crate::bash::event::SourceOrigin>>,
	/// Origin of each currently executing source-context unit in its actual
	/// vproc.
	pub trace_unit_origins: HashMap<Vpid, Arc<HashMap<UnitId, crate::bash::event::SourceOrigin>>>,
	/// Unit blobs known to be in the store ([`Kernel::note_written`]); at
	/// most [`WRITTEN_MAX`] ids.
	pub written:            HashSet<UnitId, crate::bash::ids::UnitIdState>,
	/// Reused buffer for encoding unit blobs ([`Kernel::persist_unit`]); not
	/// imaged.
	blob_buf:               Vec<u8>,
	/// The `next_vpid` value last written as `MiscKey::NextVpid`
	/// ([`Kernel::vpid`], [`Kernel::sync_root`]).
	pub written_vpid:       u32,
	pub paused:             bool,
	pub argv0:              BString,
	pub shell_pid:          u32,
	/// Idempotent fs ops dropped by the last suspend (re-issued on resume).
	pub dropped_fs:         u32,
	/// Child vprocs created during a turn, adopted by the scheduler after it.
	/// Every child vproc has a `Record::Proc` from its adoption until its
	/// exit status is collected ([`Kernel::proc_exited`],
	/// [`Kernel::proc_collect`]). Boxed as `Shell::procs` holds them:
	/// adoption moves pointers, and the capacity a burst leaves behind is 8
	/// bytes a slot, not a whole vproc (`cmd &` in a loop spawns ~200 per
	/// slice: that kept ~600 bytes per idle vproc; the target is ≤ 2 KiB).
	#[expect(clippy::vec_box, reason = "slack capacity of 8-byte slots, not of whole vprocs")]
	pub spawned:            Vec<Box<Vproc>>,
	/// The records an asynchronous command's signal ignores
	/// (`exec::ignore_async_signals`) last turned which (mode, records)
	/// into: the next one forked from the same records shares them. Held
	/// weakly, so neither the root's records nor an exited job's stay
	/// shared through it.
	pub async_ignored:      Option<(ModeId, Records, Records)>,
	/// Subshells the host submitted to the root since the last turn (no
	/// store at hand): `adopt` gives each the root's state then, with its
	/// script's changes.
	pending_forks:          Vec<(Vpid, ForkEdits)>,
	/// `$RANDOM` generator state (written through as `MiscKey::Random` by
	/// [`Kernel::next_random`] and [`Kernel::seed_random`]).
	pub rand:               state::Random,
	/// `now_ns` at shell creation (`$SECONDS`; `MiscKey::StartNs`).
	pub start_ns:           u64,
	/// Startup files (`path`, contents) the root vproc sources when its
	/// first run starts ([`ShellInit::startup`]); not imaged (the first run
	/// starts at the first step).
	pub startup:            Vec<(BString, BString)>,
	/// Which DEBUG/ERR/RETURN traps may be set: lets `exec::start_trap`
	/// skip its checks before every command; not imaged.
	pub pseudo_traps:       exec::PseudoTraps,
	/// Re-parsed `${ ;}` bodies ([`exec::NoforkUnits`]); not imaged.
	pub nofork_units:       exec::NoforkUnits,
	/// The functions each zsh word code digest (`.zwc`) holds, by path,
	/// with the modification time and size they were read at
	/// ([`Kernel::dump_funcs`]): an `$fpath` search asks of the same digests
	/// for every function it resolves. Per shell, as its host's files are
	/// (shells sharing an engine may see other files at a path); not imaged.
	zsh_dumps:              parking_lot::Mutex<HashMap<BString, DumpFuncs>>,
	/// Syntax-tree buffers of the last command run, lent to the next parse
	/// ([`Parser::recycle`](crate::bash::syntax::Parser::recycle); at most
	/// [`SPARE_BUFFER_BYTES`], see [`Kernel::keep_spare_tree`]); not imaged.
	pub spare_tree:         crate::bash::syntax::Tree,
	/// The arithmetic this shell evaluated last ([`arith::Recent`]); not
	/// imaged.
	pub arith_recent:       arith::Recent,
	/// [`arith_recent`](Self::arith_recent) for zsh's evaluator.
	pub zsh_arith_recent:   zsh::math::Recent,
	/// The last event clock reading while it is still current
	/// ([`Kernel::stamp`]): set by a reading that ends a duration or starts a
	/// command, cleared by [`Kernel::clock_stale`] before anything that can
	/// take time (a vproc's turn, an op other than control flow, I/O,
	/// parsing, a builtin). Lets the `CmdStart`, `CmdExpanded` and
	/// `FuncEnter` events of a command (and a function's `FuncExit`) share
	/// one `Host::now_ns` with the previous `CmdEnd` (xeon overhead profile:
	/// `now_ns` a third of the default-mask event cost). Not imaged.
	pub clock:              Option<u64>,
	/// The empty document an async command without job control reads as
	/// `/dev/null`, shared by all of them (it never yields a byte, so one
	/// object serves every reader): an fd object and two buffers less per
	/// background vproc (idle vproc ≤ 2 KiB). Not imaged (a restored
	/// child keeps its own object).
	pub null_input:         Option<FdRef>,
	/// `(label, caller)`: the labeled subshell trees host callouts started
	/// ([`ShellApi::run_subshell_in`]) and the vproc that ran each callout;
	/// virtual signals to the caller reach the tree (`Shell::deliver`).
	/// Pruned there once no vproc carries the label; not imaged (callouts
	/// do not survive a restore).
	pub callout_labels:     Vec<(u32, Vpid)>,
	/// The root's background jobs (their vpids) as its current script
	/// started: an earlier script's work, which a cancel of this one spares
	/// (`Shell::apply_requests`). Set at every root run start; not imaged.
	pub prior_jobs:         Vec<Vpid>,
	/// The last root run that `exit` or `set -e` ended
	/// ([`Shell::ended_by_exit`]); not imaged.
	pub exited:             Option<RunId>,
	/// Signal deaths of external programs replacing a submitted run, pending
	/// its completion report; callouts do not survive frame restoration.
	pub exec_signals:       HashMap<RunId, i32>,
	/// Signal death associated with the most recently reported run.
	pub reported_signal:    Option<(RunId, i32)>,
	/// Background jobs whose pid is still to be settled
	/// ([`proc::Bang`]): imaged (a restored job still decides).
	pub bangs:              Vec<proc::Bang>,
	/// `(job, OS pid)`: jobs settled on their program's OS pid during the
	/// turn, written into the job tables and `$!` of every vproc by the
	/// scheduler after it (`Shell::adopt`); empty between turns, not
	/// imaged.
	pub settled:            Vec<(Vpid, u32)>,
	/// `(OS pid, vproc, job)`: a job's `$!` names a program a vproc other
	/// than the job's own runs (a background pipeline's last stage), so
	/// `kill` of that pid signals that vproc, and finds no process once it
	/// ended though the job runs on. Dropped when the job ends; not imaged
	/// (a restored shell signals the job's vproc).
	pub pid_owners:         Vec<(u32, Vpid, Vpid)>,
	/// The math options ([`zsh::arith::math_options`]) last read for a vproc
	/// without an image (the root), with the [`state::Root::opts_gen`] and mode
	/// they were read under: every `(( ))` asks.
	pub math_opts:          Option<(u64, ModeId, zsh::math::Options)>,
	/// Background jobs' lone commands whose redirections wait for their name
	/// to resolve ([`proc::Deferral`]): imaged (a restored command goes on).
	pub deferrals:          Vec<proc::Deferral>,
	/// Job control of the interactive shell (process groups, the
	/// terminal, stop events); not imaged.
	pub jobctl:             jobctl::JobCtl,
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

/// A digest's function names, with the modification time (ns) and size
/// of the file they were read from.
type DumpFuncs = ((i64, u64), Arc<std::collections::HashSet<BString>>);

impl Kernel {
	/// The functions (metafied names) of the digest `path` as this shell
	/// last read it, while its modification time and size are `stamp`.
	pub(crate) fn dump_funcs(
		&self,
		path: &[u8],
		stamp: (i64, u64),
	) -> Option<Arc<std::collections::HashSet<BString>>> {
		self
			.zsh_dumps
			.lock()
			.get(path)
			.filter(|(s, _)| *s == stamp)
			.map(|(_, f)| Arc::clone(f))
	}

	/// Remember the functions `funcs` of the digest `path` at `stamp`.
	pub(crate) fn cache_dump_funcs(
		&self,
		path: &[u8],
		stamp: (i64, u64),
		funcs: Arc<std::collections::HashSet<BString>>,
	) {
		self
			.zsh_dumps
			.lock()
			.insert(BString::from(path), (stamp, funcs));
	}

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
			trace_sources: HashMap::new(),
			trace_unit_origins: HashMap::new(),
			written: HashSet::default(),
			blob_buf: Vec::new(),
			written_vpid: engine.config().vpid_base,
			paused: false,
			argv0,
			shell_pid,
			dropped_fs: 0,
			spawned: Vec::new(),
			pending_forks: Vec::new(),
			async_ignored: None,
			rand: state::Random::new(1),
			start_ns: 0,
			startup: Vec::new(),
			pseudo_traps: exec::PseudoTraps::default(),
			nofork_units: HashMap::new(),
			zsh_dumps: parking_lot::Mutex::new(HashMap::new()),
			spare_tree: crate::bash::syntax::Tree::default(),
			arith_recent: arith::Recent::default(),
			zsh_arith_recent: zsh::math::Recent::default(),
			clock: None,
			null_input: None,
			callout_labels: Vec::new(),
			prior_jobs: Vec::new(),
			exited: None,
			exec_signals: HashMap::new(),
			reported_signal: None,
			bangs: Vec::new(),
			settled: Vec::new(),
			pid_owners: Vec::new(),
			math_opts: None,
			deferrals: Vec::new(),
			jobctl: jobctl::JobCtl::default(),
		}
	}

	/// Record the root's background jobs as earlier scripts' work
	/// ([`Kernel::prior_jobs`]), as a root script is about to start.
	pub fn note_prior_jobs(&mut self, root: &Vproc) {
		self.prior_jobs.clear();
		self.prior_jobs.extend(root.jobs.iter().map(|job| job.vpid));
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
			if bang.vproc != bang.job {
				self.pid_owners.push((pid, bang.vproc, bang.job));
			}
		}
		jobctl::bang_settled(self, bang.vproc, os);
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
		if !self.note_written(unit.id) {
			return;
		}
		let mut buf = core::mem::take(&mut self.blob_buf);
		buf.clear();
		let written = postcard::to_extend(unit, buf)
			.map_err(StoreError::Encode)
			.and_then(|buf| {
				let put = store.put_blob(crate::bash::store::BlobSlot::Unit(unit.id), &buf);
				if buf.capacity() <= SPARE_BUFFER_BYTES {
					self.blob_buf = buf;
				}
				put
			});
		if let Err(err) = written {
			self.written.remove(&unit.id);
			self.fail(err);
		}
	}

	/// Note that `id`'s blob is in the store; `false` when it already was
	/// known. Past [`WRITTEN_MAX`] ids the set starts over: forgetting one
	/// only costs writing its blob again, while a long-lived shell compiles
	/// new units without end.
	pub(crate) fn note_written(&mut self, id: UnitId) -> bool {
		if self.written.len() >= WRITTEN_MAX && !self.written.contains(&id) {
			self.written.clear();
		}
		self.written.insert(id)
	}

	/// Lend `tree`'s buffers to the next parse ([`Kernel::spare_tree`]),
	/// unless they outgrew [`SPARE_BUFFER_BYTES`]: one huge command's tree
	/// is freed rather than held for the shell's lifetime.
	pub(crate) fn keep_spare_tree(&mut self, tree: crate::bash::syntax::Tree) {
		if tree.heap_bytes() <= SPARE_BUFFER_BYTES {
			self.spare_tree = tree;
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

	/// The vproc that runs (or ran) the program OS pid `pid` names when
	/// that is not its job's own vproc ([`Self::pid_owners`]).
	pub fn pid_owner(&self, pid: u32) -> Option<Vpid> {
		self
			.pid_owners
			.iter()
			.find(|&&(p, ..)| p == pid)
			.map(|&(_, owner, _)| owner)
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
		self.pid_owners.retain(|&(.., job)| job != vpid);
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

	/// Whether `vp` started child vproc `vpid` (its record names `vp` as
	/// parent): a subshell copies `$!`, not its parent's children.
	pub fn started(&mut self, store: &mut dyn StateStore, vp: Vpid, vpid: Vpid) -> bool {
		match store.get(Key::Proc(vpid)) {
			Ok(Some(Record::Proc { parent, .. })) => *parent == Some(vp),
			Ok(_) => false,
			Err(err) => {
				self.root.fail(err);
				false
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
			if self
				.mask
				.contains(crate::bash::event::EventKind::UnitCompiled)
				&& matches!(
					&data,
					EventData::Subshell { .. }
						| EventData::Background { .. }
						| EventData::Pipeline { .. }
				)
				&& let Some(origins) = self.trace_unit_origins.get(&vp.vpid).cloned()
			{
				match &data {
					EventData::Subshell { child } | EventData::Background { pid: child, .. } => {
						self.trace_unit_origins.entry(*child).or_insert(origins);
					},
					EventData::Pipeline { stages } => {
						for child in *stages {
							self
								.trace_unit_origins
								.entry(*child)
								.or_insert_with(|| Arc::clone(&origins));
						}
					},
					_ => {},
				}
			}
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
		zle::display::trash_for_message(self, cx, vp);
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
			let utf8 = zsh::params::mb_in(self, cx.store, vp).unwrap_or(false);
			return crate::bash::diag::render_zsh(diag, crate::bash::diag::ZshSite {
				prefix: &prefix,
				line: zline,
				utf8,
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
			.image
			.as_ref()
			.and_then(|image| image.get(Key::Misc(MiscKey::Argv0)))
		{
			Some(Record::Misc(name)) => name.as_slice(),
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
	pub(super) fn zsh_site_base(&self, store: &mut dyn StateStore, vp: &Vproc) -> (BString, u32) {
		// Code a builtin runs (`ScriptKind::Code`) keeps the line numbers
		// it was parsed with: its caller's name, no function offset.
		let mut code = false;
		// A function whose body is a lone command without braces names the
		// site; its lines are the caller's, counted from the caller's base.
		let mut named: Option<BString> = None;
		let site = |named: Option<BString>, name: BString, base: u32| (named.unwrap_or(name), base);
		for (i, f) in vp.frames.iter().enumerate().rev() {
			match &f.kind {
				FrameKind::Script { what: ScriptKind::Code(_), .. } => code = true,
				FrameKind::Function { name, .. } if i > 0 && !code && exec::keeps_caller_line(f) => {
					named.get_or_insert_with(|| name.clone());
				},
				// zsh numbers a function's lines from its definition's (0,
				// which prints no line).
				FrameKind::Function { name, .. } => {
					let start = if code {
						0
					} else {
						f.unit
							.as_ref()
							.map_or(u32::MAX, |u| callstack::definition_line(u))
					};
					return site(named, name.clone(), start);
				},
				// The text of a command substitution run in a child vproc:
				// zsh reports it under its parent's name.
				FrameKind::Script { what: ScriptKind::Eval, .. } if i == 0 && vp.parent.is_some() => {},
				FrameKind::Script { what: ScriptKind::Eval, .. } => {
					return site(named, BString::from("(eval)"), 0);
				},
				FrameKind::Script { what: ScriptKind::Source, .. } => {
					let file = vp.calls.iter().rev().find_map(|c| match &c.kind {
						callstack::CallKind::Source { file, .. } => Some(file.clone()),
						_ => None,
					});
					return site(named, file.unwrap_or_else(|| BString::from("zsh")), 0);
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
					return site(named, name, 0);
				},
				_ => {},
			}
		}
		match vp.zsh.as_ref().and_then(|z| z.site.as_ref()) {
			Some((name, base)) => site(named, name.clone(), *base),
			None => site(named, BString::from("zsh"), 0),
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
	let deferred_shell = need_shell
		&& init.mode.dialect() != crate::bash::ids::Dialect::Zsh
		&& match cx.host.login_shell_initializer() {
			Some(initializer) => cx.store.defer_scalar(b"SHELL", Attrs::NONE, initializer)?,
			None => false,
		};
	let values = if init.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		zsh_startup_values(cx, k.engine.config().platform)
	} else {
		startup_values(cx, &init.argv0, ppid, k.engine.config().platform, StartupVars {
			lookup_shell: need_shell && !deferred_shell,
			interactive:  init.interactive,
		})
	};
	// zsh started as sh or ksh has no `MANPATH` and no prompt aliases
	// (`special_params_sh`).
	let started_sh =
		matches!(init.mode, crate::bash::ids::ModeId::ZshSh | crate::bash::ids::ModeId::Ksh);
	if started_sh {
		k.root.set_misc(cx.store, MiscKey::ZshStartedSh, "1");
	}
	for (name, var, forced) in values {
		if started_sh && name == b"MANPATH" {
			continue;
		}
		if forced || state::global(cx.store, name)?.is_none() {
			k.root.set_var(cx.store, name, Some(var));
		}
	}
	// zsh's other prompt names share the variable of `PS1`, … (`RPS1`
	// and `RPS2` start unset, and so do their other names).
	if init.mode.dialect() == crate::bash::ids::Dialect::Zsh && !started_sh {
		for group in crate::bash::vm::zsh::specials::PROMPT_GROUPS {
			let value = match state::global(cx.store, group[0])? {
				Some(Var { value: VarValue::Str(s), .. }) => s.clone(),
				Some(_) => BString::default(),
				None => continue,
			};
			for &name in &group[1..] {
				if state::global(cx.store, name)?.is_none() {
					k.root
						.set_var(cx.store, name, Some(Var::scalar(value.clone(), Attrs::NONE)));
				}
			}
		}
	}
	if init.mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& let Some(dirs) = &init.zsh_fpath
		&& !init.env.iter().any(|(n, _)| n == "FPATH")
	{
		let sep = crate::bash::vm::probe::path_separator(k.engine.config().platform);
		let joined = bstr::join([sep], dirs);
		k.root
			.set_var(cx.store, b"FPATH", Some(Var::scalar(BString::from(joined), Attrs::NONE)));
	}
	for (name, value) in &init.zsh_params {
		k.root
			.set_var(cx.store, name, Some(Var::scalar(value.clone(), Attrs::NONE)));
	}
	Ok(())
}

/// The plain variables zsh 5.9 sets at startup (`init.c` `setupvals`,
/// `params.c` defaults), as `(name, value, forced)` like
/// [`startup_values`]; zsh's special parameters (`PPID`, `USERNAME`,
/// `ZSH_VERSION`, …) are computed by the zsh dialect, not stored.
pub fn zsh_startup_values(
	cx: &mut Cx<'_>,
	platform: crate::bash::ids::Platform,
) -> Vec<(&'static [u8], Var, bool)> {
	let user = cx.host.user();
	let defaults: [(&'static [u8], &[u8]); 20] = [
		(b"IFS", b" \t\n\0"),
		(b"PS1", b"%m%# "),
		(b"PS2", b"%_> "),
		(b"PS3", b"?# "),
		(b"PS4", b"+%N:%i> "),
		(b"SPROMPT", b"zsh: correct '%R' to '%r' [nyae]? "),
		(b"WORDCHARS", b"*?_-.[]~=/&;!#$%^(){}<>"),
		(b"TMPPREFIX", b"/tmp/zsh"),
		(b"TIMEFMT", b"%J  %U user %S system %P cpu %*E total"),
		(b"OPTIND", b"1"),
		(b"PATH", b"/bin:/usr/bin:/usr/ucb:/usr/local/bin"),
		(b"NULLCMD", b"cat"),
		(b"READNULLCMD", b"more"),
		// The scalar sides of the special ties start set (empty): `$+cdpath`
		// is 1 until `unset CDPATH` (`params.c` `IPDEF8`). `fpath` and
		// `module_path` start with the system zsh's compiled-in directories
		// (`init.c` `setupvals`: `FPATH_DIR`, `MODULE_DIR`).
		(b"FPATH", b"/usr/local/share/zsh/site-functions:/usr/share/zsh/site-functions:/usr/share/zsh/5.9/functions"),
		(b"CDPATH", b""),
		(b"MANPATH", b""),
		(b"MODULE_PATH", b"/usr/lib/zsh/5.9"),
		(b"MAILPATH", b""),
		(b"PSVAR", b""),
		(b"FIGNORE", b""),
	];
	// `MODULE_PATH` is never imported (`PM_DONTIMPORT`). The directory
	// lists take the platform's separator, as their ties split them.
	let sep = crate::bash::vm::probe::path_separator(platform);
	let mut out: Vec<(&'static [u8], Var, bool)> = defaults
		.into_iter()
		.map(|(name, value)| {
			let value: BString = if matches!(name, b"PATH" | b"FPATH") {
				value
					.iter()
					.map(|&c| if c == b':' { sep } else { c })
					.collect::<Vec<u8>>()
					.into()
			} else {
				value.into()
			};
			(name, Var::scalar(value, Attrs::NONE), name == b"MODULE_PATH")
		})
		.collect();
	// `setiparam`: integers.
	let integers: [(&'static [u8], &[u8]); 3] =
		[(b"MAILCHECK", b"60"), (b"KEYTIMEOUT", b"40"), (b"LISTMAX", b"100")];
	for (name, value) in integers {
		out.push((name, Var::scalar(value, Attrs::INTEGER), false));
	}
	// zsh exports `HOME` and `LOGNAME` (`addenv` when not imported).
	if !user.home.is_empty() {
		let home = if platform == crate::bash::ids::Platform::Windows {
			builtins::zsh_dir::windows_spelling(&user.home, &user.home)
		} else {
			user.home.clone()
		};
		out.push((&b"HOME"[..], Var::scalar(home, Attrs::EXPORT), false));
	}
	out.push((&b"LOGNAME"[..], Var::scalar(user.name, Attrs::EXPORT), false));
	let (_, release, machine) = cx.host.uname().unwrap_or_default();
	let macos = cfg!(target_os = "macos");
	// The configure-time `MACHTYPE`, `VENDOR` and `OSTYPE` of the system's
	// zsh (Apple's build reports `x86_64` on every Mac).
	let machtype = if macos {
		BString::from("x86_64")
	} else {
		BString::from(std::env::consts::ARCH)
	};
	let vendor = if macos {
		"apple"
	} else if std::env::consts::ARCH == "x86_64" {
		"pc"
	} else {
		"unknown"
	};
	let ostype = if platform == crate::bash::ids::Platform::Windows {
		// MSYS2's zsh, the zsh Windows users and plugins know.
		BString::from("msys")
	} else if macos {
		let mut o = BString::from("darwin");
		if let Some(major) = release
			.split(|&c| c == b'.')
			.next()
			.filter(|m| !m.is_empty())
		{
			o.extend_from_slice(major);
			o.extend_from_slice(b".0");
		}
		o
	} else {
		BString::from("linux-gnu")
	};
	let tty = cx
		.host
		.terminal()
		.and_then(|t| t.open_controlling().ok().flatten())
		.map_or_default(|s| s.name);
	// `HOST` is set before the environment is imported, the others after.
	let cputype = if !machine.is_empty() {
		machine
	} else if macos && std::env::consts::ARCH == "aarch64" {
		BString::from("arm64")
	} else {
		BString::from(std::env::consts::ARCH)
	};
	let fixed: [(&'static [u8], BString, bool); 6] = [
		(b"HOST", cx.host.hostname(), false),
		(b"CPUTYPE", cputype, true),
		(b"MACHTYPE", machtype, true),
		(b"OSTYPE", ostype, true),
		(b"TTY", tty, true),
		(b"VENDOR", BString::from(vendor), true),
	];
	for (name, value, forced) in fixed {
		out.push((name, Var::scalar(value, Attrs::NONE), forced));
	}
	// `signals`: `EXIT`, the signal names by number, `ZERR`, `DEBUG`.
	let mut signals = vec![BString::from("EXIT")];
	for n in 1..=31u8 {
		match crate::bash::signal::Signal::from_number(n, platform) {
			Some(s) => signals.push(BString::from(s.to_string())),
			None => signals.push(BString::from(format!("SIG{n}"))),
		}
	}
	signals.push(BString::from("ZERR"));
	signals.push(BString::from("DEBUG"));
	out.push((
		&b"signals"[..],
		Var {
			attrs: Attrs::NONE,
			value: VarValue::Indexed(
				signals
					.into_iter()
					.enumerate()
					.map(|(i, s)| (i64::try_from(i).unwrap_or(0), s))
					.collect(),
			),
		},
		true,
	));
	out
}

/// Startup-only defaults shared by root and nested bash/sh shells.
pub struct StartupVars {
	lookup_shell: bool,
	interactive:  bool,
}

/// bash's startup variables of a new shell named `argv0` whose `$PPID` is
/// `ppid`, as `(name, value, forced)`: a variable already set (imported)
/// keeps its value unless `forced`. Shared by [`Shell::create`] and the
/// in-engine nested shell (`nested`). The login shell is looked up only
/// when needed; the primary prompt is initialized only for interactive shells.
pub fn startup_values(
	cx: &Cx<'_>,
	argv0: &[u8],
	ppid: u32,
	platform: crate::bash::ids::Platform,
	options: StartupVars,
) -> Vec<(&'static [u8], Var, bool)> {
	let user = cx.host.user();
	let shell = if options.lookup_shell {
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
		(b"PATH", BString::from(crate::bash::invocation::default_path(platform))),
	];
	let mut out = Vec::with_capacity(defaults.len() + 2 + usize::from(options.interactive));
	if options.interactive {
		out.push((&b"PS1"[..], Var::scalar(BString::from(r"\s-\v\$ "), Attrs::NONE), false));
	}
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
		// zsh on Windows keeps directories spelled with `/` (`cd` does), so
		// `$PWD`, `$HOME` and `~` agree from the start.
		let zsh_on_windows = init.mode.dialect() == crate::bash::ids::Dialect::Zsh
			&& engine.config().platform == crate::bash::ids::Platform::Windows;
		let cwd = if zsh_on_windows {
			builtins::zsh_dir::windows_spelling(&init.cwd, &init.cwd)
		} else {
			init.cwd.clone()
		};
		for (name, value) in &init.env {
			if let Some(func) = name
				.strip_prefix(b"BASH_FUNC_")
				.and_then(|n| n.strip_suffix(b"%%"))
			{
				import_function(&mut k, cx.store, func, value);
			} else if is_ident(name) {
				let value = if zsh_on_windows && name == "HOME" {
					builtins::zsh_dir::windows_spelling(value, value)
				} else {
					value.clone()
				};
				k.root
					.set_var(cx.store, name, Some(Var::scalar(value, Attrs::EXPORT)));
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
			.set_var(cx.store, b"PWD", Some(Var::scalar(cwd.clone(), Attrs::EXPORT)));
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
		k.root.set_misc(cx.store, MiscKey::Cwd, cwd.clone());
		k.root.set_misc(cx.store, MiscKey::Status, "0");
		k.root
			.set_misc(cx.store, MiscKey::Mode, <&'static str>::from(init.mode));
		k.root
			.set_misc(cx.store, MiscKey::Interactive, if init.interactive { "1" } else { "0" });
		if init.profile == Profile::Tool {
			k.root.set_misc(cx.store, MiscKey::Profile, "tool");
		}
		k.root
			.set_misc(cx.store, MiscKey::Umask, format!("{:04o}", cx.host.umask() & 0o7777));
		k.root.set_positional(cx.store, init.args);
		for sig in cx.host.ignored_signals().iter() {
			// zsh `init_signals`: of the signals ignored on entry only `QUIT`
			// is recorded as ignored (`ZSIG_IGNORED`), and any of them may be
			// trapped.
			if zsh {
				cx.host.forget_ignored(sig);
				if sig != crate::bash::Signal::Quit {
					continue;
				}
				k.root.set_record(
					cx.store,
					KeyBuf::Misc(MiscKey::ZshEntryIgnored),
					Some(Record::Words(vec![BString::from(sig.to_string())])),
				);
			}
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
		let mut root = Vproc::new(vpid, None, fds, cwd, None, false);
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
			// zsh `createaliastable`: every zsh starts with these two
			// aliases, `-f` and any emulation included.
			for (name, text) in [("run-help", "man"), ("which-command", "whence")] {
				k.root.set_record(
					cx.store,
					KeyBuf::Alias(name.into()),
					Some(Record::Alias(text.into())),
				);
			}
			if let Some(err) = k.root.take_fault() {
				return Err(ShellError::Store(err));
			}
		}
		if init.interactive {
			jobctl::init_io(&mut k, cx, &mut root);
			if let Some(err) = k.root.take_fault() {
				return Err(ShellError::Store(err));
			}
			// zsh `init_io`: an interactive shell with its terminal uses
			// the line editor, unless the command line turned it off.
			let zle = crate::bash::zshopt::ZshOpt::Zle;
			let off = zsh_options.iter().any(|&(o, on)| o == zle && !on);
			if zsh && !off && jobctl::shtty_file(&k).is_some() {
				state::set_zsh_option(&mut k.root, cx.store, &mut root, zle, true)
					.map_err(ShellError::Store)?;
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
		store: Option<&mut dyn StateStore>,
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
		let edits = ForkEdits {
			env:          script.env,
			foreign_env:  script.foreign_env,
			unexport_env: script.unexport_env,
			args:         script.args,
		};
		let p = &self.procs[parent];
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
		// The parent's global state now; a host's submission (no store) to
		// the root takes it when the scheduler adopts the subshell, before
		// the root runs again.
		let base = match store {
			Some(store) => {
				let image = state::fork_image(&self.k.root, store, p);
				let scopes = state::copy_scopes(&self.k.root, store, p);
				match image.and_then(|image| Ok((image, scopes?))) {
					Ok(base) => Some(base),
					Err(err) => {
						self.k.root.fail(err);
						Some(((Image::default(), None), Vec::new()))
					},
				}
			},
			None => p
				.image
				.clone()
				.map(|image| ((image, p.locale_gen), p.scopes.clone())),
		};
		let parent_vpid = p.vpid;
		// Written as `MiscKey::NextVpid` before the next step returns
		// (`Kernel::sync_root`).
		let vpid = Vpid(self.k.next_vpid);
		self.k.next_vpid += 1;
		let parent_lineage = self.procs[parent].lineage;
		let mut vp = Vproc::new(vpid, Some(parent_vpid), fds, cwd, Some(Image::default()), true);
		vp.lineage = lineage.unwrap_or(parent_lineage);
		vp.status = status;
		vp.mode = mode;
		vp.runs.push_back(run);
		match base {
			Some(((image, locale_gen), scopes)) => {
				vp.image = Some(image);
				vp.locale_gen = locale_gen;
				vp.scopes = scopes;
				edits.apply(&mut vp);
			},
			None => self.k.pending_forks.push((vpid, edits)),
		}
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
		let step = self.step_inner(cx, budget);
		self.k.sync_root(cx.store, &self.procs[0]);
		step
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
			self.job_events(cx);
		}
	}

	/// Move children created during the turn into the scheduler and reap
	/// subshell vprocs that finished.
	fn adopt(&mut self, cx: &mut Cx<'_>) {
		for (vpid, edits) in std::mem::take(&mut self.k.pending_forks) {
			let base = state::fork_image(&self.k.root, cx.store, &self.procs[0]);
			let Some(vp) = self.k.spawned.iter_mut().find(|p| p.vpid == vpid) else {
				continue;
			};
			let (image, locale_gen) = base.unwrap_or_else(|err| {
				self.k.root.fail(err);
				(Image::default(), None)
			});
			vp.image = Some(image);
			vp.locale_gen = locale_gen;
			edits.apply(vp);
		}
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
				self.k.trace_sources.remove(&p.vpid);
				self.k.trace_unit_origins.remove(&p.vpid);
				jobctl::forget_vproc(&mut self.k, p.vpid);
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
		jobctl::job_done(&mut self.k, cx, &mut self.procs[i], vpid);
		owe_chld(&mut self.k, cx, &mut self.procs[i], background);
	}

	/// Vproc `vpid` stopped (`Some(signal)`) or continued (`None`). If it
	/// leads a job, the job's state follows, as bash's `waitchld` does: a
	/// stop makes the job current (`set_current_job`), a stopped job that
	/// continues makes bash `reset_current`; one `bg` or `kill -CONT`
	/// already marked running is left alone. Without job control bash never
	/// learns of stops (`waitpid` without `WUNTRACED`): the job stays
	/// running. zsh always waits with `WUNTRACED`: its jobs show stops
	/// with or without `MONITOR`.
	fn job_changed(&mut self, cx: &mut Cx<'_>, vpid: Vpid, stop: Option<Signal>) {
		for p in &mut self.procs {
			// The owner's entry, not a subshell's copy of it.
			if p.jobs.by_vpid(vpid).is_none_or(|j| j.inherited) {
				continue;
			}
			if p.jobs.subshell
				|| (p.mode.dialect() != crate::bash::ids::Dialect::Zsh
					&& !state::option(&mut self.k.root, cx.store, p, OptId::Monitor).unwrap_or(false))
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
					jobctl::stopped_current(p, number);
				},
				(None, proc::JobState::Stopped(_)) => {
					job.state = proc::JobState::Running;
					job.notified = false;
					// zsh leaves the current job alone (`update_job`).
					if p.mode.dialect() != crate::bash::ids::Dialect::Zsh {
						p.jobs.reset_current();
					}
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
			if self.procs[0].runs.front().is_some_and(|run| !run.started) {
				// The cancelled script has not started: it started no job.
				self.k.note_prior_jobs(&self.procs[0]);
			}
			// A detached tree (`nohup`) outlives the cancellation, and so does
			// a background job an earlier script left running: it is no part
			// of the cancelled command, as bash's interrupt reaches only the
			// foreground job.
			let spared: Vec<Vpid> = self
				.procs
				.iter()
				.filter(|p| p.lineage.detached || self.in_prior_job(p.vpid))
				.map(|p| p.vpid)
				.collect();
			for i in (0..self.procs.len()).rev() {
				if spared.contains(&self.procs[i].vpid) {
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
			// Calls of the cancelled vprocs are void; the spared ones' go on.
			let kept: Vec<CallId> = self
				.k
				.results
				.keys()
				.copied()
				.filter(|&id| {
					self
						.awaiting(id)
						.is_some_and(|i| spared.contains(&self.procs[i].vpid))
				})
				.collect();
			self
				.k
				.calls_out
				.retain(|(_, call)| spared.contains(&call.vpid));
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
			self.k.trace_sources.remove(&p.vpid);
			self.k.trace_unit_origins.remove(&p.vpid);
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

	/// Whether `vpid` runs in a background job an earlier root script
	/// started ([`Kernel::prior_jobs`]): it leads one or descends from one.
	fn in_prior_job(&self, mut vpid: Vpid) -> bool {
		if self.k.prior_jobs.is_empty() {
			return false;
		}
		loop {
			if self.k.prior_jobs.contains(&vpid) {
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
			vpid = parent;
		}
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
				SigTarget::Tree(v) => self.in_job(self.procs[i].vpid, v),
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
			// The line editor of the interactive shell: `SIGINT` abandons the
			// line being read, `SIGWINCH` makes it redisplay.
			if self.procs[i].parent.is_none() && zle::signal(&mut self.procs[i], sig, trap.is_some()) {
				continue;
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
			// The interactive shell itself: zsh's handlers (`INT` abandons
			// the command line; `QUIT`, `TERM`, `ALRM` and, with job
			// control, the terminal stop signals do nothing).
			if self.procs[i].parent.is_none()
				&& jobctl::untrapped(&mut self.k, cx, &mut self.procs[i], sig)
			{
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

	/// Select the emitted event kinds for a new observer generation.
	/// Units are announced again only when parsed or executed, even when
	/// the mask is unchanged; cached functions are never read ahead.
	pub fn set_event_mask(&mut self, mask: EventMask) {
		self.k.mask = mask;
		self.k.announced.clear();
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
	let source = ir::FuncText::of(&func);
	let unit = k.engine.intern(Arc::unwrap_or_clone(func.body));
	Some(Record::Func {
		mode: ModeId::Bash,
		sticky: None,
		source,
		unit: unit.id,
		attrs: Attrs::EXPORT,
		// bash's `make_function_def` before the shell is initialized.
		file: BString::from("environment"),
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

/// What a submitted script changes in the state its new subshell forks
/// ([`Script::env`], [`Script::foreign_env`], [`Script::unexport_env`],
/// [`Script::args`]).
struct ForkEdits {
	env:          Vec<(BString, BString)>,
	foreign_env:  Vec<(Option<BString>, Option<BString>)>,
	unexport_env: Vec<BString>,
	args:         Option<Vec<BString>>,
}

impl ForkEdits {
	/// Apply the changes to `vp`, a subshell holding its forked state.
	fn apply(self, vp: &mut Vproc) {
		// A locale variable among them: the subshell no longer has its
		// parent's locale values (`state::locale_token`).
		if self
			.env
			.iter()
			.map(|(name, _)| name)
			.chain(&self.unexport_env)
			.any(|name| state::is_locale_name(name))
		{
			vp.locale_gen = None;
		}
		let Some(image) = vp.image.as_mut() else {
			return;
		};
		if !self.foreign_env.is_empty() {
			let mut foreign = match image.get(Key::Misc(MiscKey::ForeignEnv)) {
				Some(Record::Words(entries)) => entries.clone(),
				_ => Vec::new(),
			};
			for (name, value) in self.foreign_env {
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
			image.put(Key::Misc(MiscKey::ForeignEnv), Record::Words(foreign));
		}
		for (name, value) in self.env {
			if is_ident(&name) {
				image.set_var(&name, Some(Var::scalar(value, Attrs::EXPORT)));
			}
		}
		for name in self.unexport_env {
			image.del_var(&name);
			for scope in &mut vp.scopes {
				if let Some(Some(var)) = scope.vars.get_mut(&name) {
					var.attrs = var.attrs.without(Attrs::EXPORT);
				}
			}
		}
		if let Some(args) = self.args {
			// A copied function scope takes precedence: install the
			// script's arguments at that level, as `set --` does.
			match vp.scopes.iter_mut().rev().find(|s| s.positional.is_some()) {
				Some(scope) => scope.positional = Some(args),
				None => {
					if let Some(image) = vp.image.as_mut() {
						image.put(Key::Misc(MiscKey::Positional), Record::Words(args));
					}
				},
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
		image: Option<Image>,
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
			image,
			locale_gen: None,
			out: VecDeque::new(),
			blocked: None,
			pending_traps: crate::bash::signal::SigSet::EMPTY,
			stopped: false,
			transient,
			exit_trap_run: false,
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
			zle: None,
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
		let (image, locale_gen) = state::fork_image(&k.root, store, self).unwrap_or_else(|err| {
			k.fail(err);
			(Image::default(), None)
		});
		let mut vp = Self::new(vpid, Some(self.vpid), fds, self.cwd.clone(), Some(image), true);
		vp.locale_gen = locale_gen;
		// `$BASH_SUBSHELL`: one more than the parent's (a pipeline stage
		// or background job adjusts it, `exec::spawn`). The parent's
		// caught-signal traps stay in the image: the child lists them but
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
		// `$!` is a parameter every subshell copies; `wait` and `kill`
		// still check that the child it names is this vproc's own.
		vp.last_bg = self.last_bg;
		vp.getopts.clone_from(&self.getopts);
		vp.command.clone_from(&self.command);
		vp.rlimits.clone_from(&self.rlimits);
		vp.lineage = self.lineage;
		jobctl::inherit(k, vp.vpid, self.vpid);
		vp.mode = self.mode;
		vp.zle.clone_from(&self.zle);
		vp.set_sticky(self.sticky().cloned());
		// zsh forks keep `scriptname`: diagnostics of the child name the
		// parent's function, `(eval)` or file.
		if self.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			let site = k.zsh_site_base(store, self);
			let z = vp.zsh.get_or_insert_with(Box::default);
			z.site = Some(site);
			z.context = zsh::specials::eval_context(self);
			if let Some(parent) = self.zsh.as_deref() {
				z.ptys.clone_from(&parent.ptys);
				z.curses.clone_from(&parent.curses);
				z.last_math = parent.last_math;
			}
		}
		// The session's terminal (a `zpty` slave) whatever the mode.
		if let Some(tty) = self.zsh.as_deref().and_then(|z| z.ctty.0.clone()) {
			vp.zsh.get_or_insert_with(Box::default).ctty = proc::Ctty(Some(tty));
		}
		// bash `without_job_control`: no jobs, no job control (a command
		// substitution turns it back on when it starts).
		vp.jobs.subshell = true;
		// zsh `clearjobtab`: a fork of a shell doing job control keeps a
		// copy of its job table to report (`jobs`, `$jobstates`).
		if self.mode.dialect() == crate::bash::ids::Dialect::Zsh
			&& !self.jobs.is_empty()
			&& state::option(&mut k.root, store, self, OptId::Monitor).unwrap_or(false)
		{
			vp.jobs = exec::inherited_jobs(self, true);
		}
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

/// Set `vp`'s `$BASH_SUBSHELL` (a vproc without an image is the shell
/// itself and stays at zero). Called by `child_running` and by
/// `exec::spawn` for pipeline stages and background jobs.
pub const fn set_subshell_depth(vp: &mut Vproc, depth: u32) {
	if vp.image.is_some() {
		vp.subshell = depth;
	}
}

/// Scope of an assignment made by `vp`.
pub const fn assign_scope(vp: &Vproc) -> AssignScope {
	if vp.image.is_some() {
		AssignScope::Subshell
	} else {
		AssignScope::Global
	}
}
