//! Virtual processes, scripts, frames and per-op scratch.

use std::{collections::VecDeque, sync::Arc};

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::state::{Overlay, Scope};
pub use crate::bash::store::{Job, JobState};
use crate::bash::{
	event::{OriginChain, ResolvedKind, WaitKey},
	fd::{FdRef, FdTable},
	fs::{FsPending, Stat},
	host::{ExtProc, Resolved, Task},
	ids::{CallId, CmdTag, IntrinsicId, JobId, ModeId, NativeRef, RunId, ToolRef, Vpid},
	ir::Unit,
	mem::Capture,
	signal::SigSet,
	syntax::Pos,
};

/// A green thread: its scripts, frames, fds, cwd and state overlay.
pub struct Vproc {
	pub vpid:          Vpid,
	pub parent:        Option<Vpid>,
	/// Scripts queued on this vproc (root only); the front one runs.
	pub runs:          VecDeque<Run>,
	/// Activation stack.
	pub frames:        Vec<Frame>,
	/// Function-local scopes, innermost last.
	pub scopes:        Vec<Scope>,
	pub fds:           FdTable,
	pub cwd:           BString,
	/// `$?`.
	pub status:        i32,
	/// `PIPESTATUS` of the last pipeline.
	pub pipestatus:    Vec<i32>,
	/// `None` for the root vproc (writes go to the root cache).
	pub overlay:       Option<Overlay>,
	/// Diagnostics waiting to be written to their fds.
	pub out:           VecDeque<PendingWrite>,
	pub blocked:       Option<Blocked>,
	/// Signal traps deferred until the foreground command completes.
	pub pending_traps: SigSet,
	/// Stopped by a virtual `STOP` (job control).
	pub stopped:       bool,
	/// Exit once its frames are done (subshell vprocs).
	pub transient:     bool,
	/// Set when this vproc's EXIT trap has been started. A root vproc keeps
	/// the same flag per run ([`Run::exit_trap_started`]); a forked subshell
	/// has no `Run`, and its `own_traps`, `trap_frames` and the frame scans
	/// all go back to their pre-trap values once the trap's frame is popped,
	/// so without this the trap could start a second time.
	pub exit_trap_run: bool,
	/// Background jobs not yet waited for or reported, current/previous
	/// job and the `SIGCHLD` trap runs owed.
	pub jobs:          JobTable,
	/// `$!`: the last asynchronous child and the OS pid it is known by.
	pub last_bg:       LastBg,
	/// Cleared scratches kept for the next ops (allocation reuse), at most
	/// one per nesting level a caller's op parks at (a function call keeps
	/// its op's scratch while the body needs another); never serialized.
	#[expect(
		clippy::vec_box,
		reason = "the boxes move between frames (`Frame::scratch`) and this pool without copying"
	)]
	pub spare:         Vec<Box<Scratch>>,
	/// `getopts` progress between calls.
	pub getopts:       GetoptsState,
	/// Open process-substitution fds: `(frame depth, fd)`, the depth being
	/// the frame count when the op that opened it ran.
	pub procsubs:      Vec<(u32, i32)>,
	/// Coprocesses not reaped yet.
	pub coprocs:       Vec<Coproc>,
	/// `set -o` states saved by `local -` in functions that returned, to
	/// restore before the next op.
	pub restore_opts:  Vec<BString>,
	/// Limits `ulimit` set in this vproc or inherited from its parent;
	/// passed to externals, never applied to the host process.
	pub rlimits:       Vec<(crate::bash::host::Rlimit, Option<u64>, Option<u64>)>,
	/// Host lineage, inherited from the parent (set by
	/// [`super::ShellApi::run_subshell_in`]) and passed to externals.
	pub lineage:       crate::bash::host::Lineage,
	/// `set -x` nesting this vproc starts at, beyond the first level (bash's
	/// `indirection_level`): its parent's, plus one in a command
	/// substitution.
	pub trace_base:    u32,
	/// `$BASH_SUBSHELL`: the subshell nesting (0 for the shell itself and a
	/// nested shell). A field, not an overlay record: a record would cost
	/// every subshell a ~530-byte map allocation (idle vproc ≤ 2 KiB).
	pub subshell:      u32,
	/// The command being run (`BASH_COMMAND`): its unit and syntax node.
	/// Externalized by unit id (a trap action continuing after a restore
	/// still names the trapped command).
	pub command:       Option<(Arc<Unit>, u32)>,
	/// Pushes onto bash's call-stack arrays (`FUNCNAME`, `BASH_SOURCE`,
	/// `BASH_LINENO`, `BASH_ARGC`, `BASH_ARGV`), oldest first; a subshell
	/// starts with its parent's.
	pub calls:         Vec<super::callstack::Call>,
	/// The traps this vproc set itself: a subshell lists its parent's but
	/// runs only its own (ERR, DEBUG and RETURN also under
	/// `errtrace`/`functrace`; bash 5.3 keeps listing inherited signal
	/// traps until the subshell changes one).
	pub own_traps:     OwnTraps,
	/// Trap-action frames ([`ScriptKind::Trap`]) on `frames`: zero lets
	/// the per-op checks (cancellation, `BASH_COMMAND`, a trap inside its
	/// own action) skip their frame scans. Kept by
	/// [`super::exec::push_script`], [`super::exec::pop_frame`] and the
	/// frame restore; never serialized (recounted from the frames).
	pub trap_frames:   u32,
	/// Current mode: the emulation its code runs under, set by
	/// `emulate`, a mode-switching function call (restored on return) and
	/// a run's explicit mode; inherited by children. The root's is written
	/// through as `MiscKey::Mode`. Every event reports it.
	pub mode:          ModeId,
	/// zsh state of a vproc running zsh or mode-switching code (`None` for
	/// pure bash: nothing to keep, nothing to check).
	pub zsh:           Option<Box<VprocZsh>>,
	/// The line editor's state ([`super::zle::Zle`]): keymaps, widgets,
	/// kill ring and the line being edited; created when ZLE is first used.
	/// Inherited (copied) by children; never serialized: a restored shell
	/// starts with zsh's defaults and no line in progress.
	pub zle:           Option<Box<super::zle::Zle>>,
}

/// The terminal of the session a vproc runs in when it is not the shell's
/// ([`VprocZsh::ctty`]).
#[derive(Clone, Debug, Default)]
pub struct Ctty(pub Option<FdRef>);

impl PartialEq for Ctty {
	fn eq(&self, other: &Self) -> bool {
		match (&self.0, &other.0) {
			(Some(a), Some(b)) => a.same(b),
			(None, None) => true,
			_ => false,
		}
	}
}

impl Eq for Ctty {}

/// A vproc's zsh state ([`Vproc::zsh`]).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VprocZsh {
	/// zsh's current sticky emulation (zsh's global `sticky`): set while
	/// `emulate MODE -c` runs and inside a sticky function; a function
	/// defined meanwhile records it.
	pub sticky:             Option<crate::bash::store::Sticky>,
	/// What frames restore when they end: `(frame count with the frame on
	/// top, saved state)` for the `eval` frame of `emulate … -c` (zsh
	/// `bin_emulate`) and a trap running in another mode; innermost last.
	pub restores:           Vec<(u32, crate::bash::store::ZshScope)>,
	/// zsh `exit_pending`: `exit N` ran inside a function: `(N, the call
	/// depth then)` (zsh `exit_val`, `exit_level`). The functions return one
	/// by one down from that depth (their `always` lists and `EXIT` traps
	/// run; a call those lists make runs to its end), then the shell exits
	/// with N.
	pub exit_pending:       Option<(i32, u32)>,
	/// The diagnostic site a subshell of zsh code inherits (zsh forks keep
	/// `scriptname`): its parent's script name and the script line its
	/// lines count from (a function's definition line); used when none of
	/// its own frames names a site (`Kernel::zsh_site`).
	pub site:               Option<(BString, u32)>,
	/// The `zsh_eval_context` a subshell of zsh code starts with: its
	/// parent's when it started (zsh forks keep the context stack); empty
	/// for none.
	pub context:            Vec<BString>,
	/// The `zsh_eval_context` word of a subshell's first frame when it is
	/// not a command substitution's (`zpty`, whose command zsh runs with
	/// `execode(…, "zpty")`).
	pub first_context:      Option<BString>,
	/// zsh/zpty's commands (zsh `ptycmds`); a subshell starts with a copy,
	/// as a zsh fork keeps the table.
	pub ptys:               crate::bash::vm::builtins::zsh_mod_zpty::PtyTable,
	/// The terminal of the session this vproc runs in (zsh's `SHTTY` of a
	/// zpty child): the slave of the `zpty` that started it (or an
	/// ancestor). Inherited by children, opened for `/dev/tty`, handed to
	/// every external it spawns ([`crate::bash::SpawnSpec::ctty`]). Never
	/// serialized: a pty is a host object, lost on restore like the host fds.
	#[serde(skip)]
	pub ctty:               Ctty,
	/// zsh/curses' state (ncurses' screen and zsh's window table) once
	/// `zcurses init` ran; a subshell starts with a copy, as a zsh fork has
	/// its own.
	pub curses:             Option<Box<crate::bash::vm::builtins::zsh_mod_curses::screen::Curses>>,
	/// zsh `zexit`'s hooks under way or done ([`crate::bash::vm::zsh::zexit`]).
	/// A subshell starts without.
	#[serde(default)]
	pub zexit:              Option<crate::bash::vm::zsh::zexit::ZExit>,
	/// The shell is exiting because of an `exit` inside a function (zsh's
	/// `exit_pending` when `zexit` runs; the engine clears
	/// [`Self::exit_pending`] once the functions have returned).
	#[serde(default)]
	pub exit_from_function: bool,
	/// zsh's `lastmathval`: the value of the last arithmetic evaluation,
	/// which a user math function returns (zsh `callmathfunc`).
	#[serde(default)]
	pub last_math:          Option<LastMath>,
	/// Files of `=(…)` substitutions: `(frame depth, path)` as
	/// [`Vproc::procsubs`]; removed when the command is over (zsh's job
	/// `filelist`). A subshell starts without.
	#[serde(default)]
	pub tempfiles:          Vec<(u32, BString)>,
	/// The code (and line) of a glob's shell-code qualifier to run above
	/// the op that returned [`Flow::Call`](super::exec::Flow::Call) for it
	/// (zsh `qualsheval`); pushed by the run loop, which drops it when the
	/// op returned anything else. Never imaged: it lives within one op step.
	#[serde(skip)]
	pub glob_hook:          Option<(BString, u32)>,
}

/// A number as zsh's `lastmathval` keeps it ([`VprocZsh::last_math`]); a
/// float by its bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LastMath {
	/// An integer.
	Int(i64),
	/// A double, `f64::to_bits`.
	Float(u64),
}

impl VprocZsh {
	/// Whether it holds nothing (the vproc drops it).
	const fn is_empty(&self) -> bool {
		self.sticky.is_none()
			&& self.restores.is_empty()
			&& self.exit_pending.is_none()
			&& self.site.is_none()
			&& self.context.is_empty()
			&& self.first_context.is_none()
			&& self.tempfiles.is_empty()
			&& self.ptys.is_empty()
			&& self.ctty.0.is_none()
			&& self.curses.is_none()
			&& self.zexit.is_none()
			&& !self.exit_from_function
			&& self.last_math.is_none()
			&& self.glob_hook.is_none()
	}
}

impl Vproc {
	/// zsh's current sticky emulation.
	pub fn sticky(&self) -> Option<&crate::bash::store::Sticky> {
		self.zsh.as_ref().and_then(|z| z.sticky.as_ref())
	}

	/// Set (or clear) the current sticky emulation.
	pub fn set_sticky(&mut self, sticky: Option<crate::bash::store::Sticky>) {
		match (&mut self.zsh, sticky) {
			(Some(z), s) => z.sticky = s,
			(None, Some(s)) => {
				self.zsh = Some(Box::new(VprocZsh { sticky: Some(s), ..VprocZsh::default() }));
			},
			(None, None) => {},
		}
		self.trim_zsh();
	}

	/// Keep `saved` for the frame now on top, restored when it pops.
	pub fn push_restore(&mut self, saved: crate::bash::store::ZshScope) {
		let depth = u32::try_from(self.frames.len()).unwrap_or(u32::MAX);
		self
			.zsh
			.get_or_insert_with(Box::default)
			.restores
			.push((depth, saved));
	}

	/// The state the frame popped at `depth` (the frame count with it on
	/// top) restores, if any.
	pub fn take_restore(&mut self, depth: u32) -> Option<crate::bash::store::ZshScope> {
		let z = self.zsh.as_mut()?;
		let saved = match z.restores.last() {
			Some((d, _)) if *d == depth => z.restores.pop().map(|(_, s)| s),
			_ => None,
		};
		self.trim_zsh();
		saved
	}

	/// Drop the side table once it holds nothing.
	pub(super) fn trim_zsh(&mut self) {
		if self.zsh.as_deref().is_some_and(VprocZsh::is_empty) {
			self.zsh = None;
		}
	}
}

/// A set of trap keys ([`Vproc::own_traps`]): the pseudo-signals and the
/// signals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnTraps {
	pseudo:  u8,
	signals: SigSet,
}

impl OwnTraps {
	/// The empty set.
	pub const EMPTY: Self = Self { pseudo: 0, signals: SigSet::EMPTY };

	const fn bit(key: crate::bash::store::TrapKey) -> u8 {
		use crate::bash::store::TrapKey;
		match key {
			TrapKey::Exit => 1,
			TrapKey::Err => 2,
			TrapKey::Debug => 4,
			TrapKey::Return => 8,
			TrapKey::Signal(_) => 0,
		}
	}

	/// Whether `key` is in the set.
	pub const fn has(self, key: crate::bash::store::TrapKey) -> bool {
		match key {
			crate::bash::store::TrapKey::Signal(sig) => self.signals.contains(sig),
			_ => self.pseudo & Self::bit(key) != 0,
		}
	}

	/// The set with `key` added.
	pub const fn with(self, key: crate::bash::store::TrapKey) -> Self {
		match key {
			crate::bash::store::TrapKey::Signal(sig) => {
				Self { pseudo: self.pseudo, signals: self.signals.with(sig) }
			},
			_ => Self { pseudo: self.pseudo | Self::bit(key), signals: self.signals },
		}
	}
}

/// `getopts` progress between calls (bash's `sh_optind`, `sh_curopt` and
/// `sh_charindex`): a subshell inherits it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GetoptsState {
	/// The `OPTIND` text the last call stored; another value means the
	/// script assigned `OPTIND` (`OPTIND=1` restarts the scan).
	pub optind: Option<BString>,
	/// Within an option word: its argument index (1-based) and the offset of
	/// its next option letter.
	pub next:   Option<(u32, u32)>,
	/// The scope holding that `OPTIND` (`None`: the shell's own): a new
	/// variable (`local OPTIND=1`) restarts the scan even with the same text.
	pub at:     Option<u32>,
}

/// The job table of one shell: bash's `jobs` array with `js.j_current` and
/// `js.j_previous`. Called by the job builtins, `wait`, `kill`, the
/// scheduler (state changes) and `$!`/`\j`. The root vproc's table is
/// written to the store (`Record::Job`, `MiscKey::JobCurrent`, …) at the
/// end of every step ([`super::state::sync_root`]); a subshell's is in the
/// frames image.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobTable {
	/// Jobs in start order (ascending numbers).
	pub list:     Vec<Job>,
	/// The current job (`%+`, `%%`), by number.
	pub current:  Option<u32>,
	/// The previous job (`%-`), by number.
	pub previous: Option<u32>,
	/// `SIGCHLD` trap runs owed: bash runs the trap once per child that
	/// finished while it was set, however many finished at once.
	pub chld:     u32,
	/// A forked subshell (`( )`, `&`, a pipeline stage, `<( )`): bash runs
	/// it without job control and with an empty job table. A command
	/// substitution keeps both (it lists its parent's jobs).
	pub subshell: bool,
}

/// What a job spec names (bash `get_job_spec`), without its `%`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobLookup {
	/// Job `n` (it may not exist: `%7`).
	Job(u32),
	/// No job (`%+` with an empty table, an unmatched name).
	None,
	/// Several jobs' commands match the name (bash `DUP_JOB`).
	Ambiguous,
}

impl JobTable {
	/// Number of jobs (prompt `\j`).
	pub const fn len(&self) -> usize {
		self.list.len()
	}

	/// No jobs.
	pub const fn is_empty(&self) -> bool {
		self.list.is_empty()
	}

	/// Jobs in start order.
	pub fn iter(&self) -> std::slice::Iter<'_, Job> {
		self.list.iter()
	}

	/// Job `%number`.
	pub fn get(&self, number: u32) -> Option<&Job> {
		self.list.iter().find(|j| j.number == number)
	}

	/// Job `%number`, to update it.
	pub fn get_mut(&mut self, number: u32) -> Option<&mut Job> {
		self.list.iter_mut().find(|j| j.number == number)
	}

	/// The job whose root vproc is `vpid`.
	pub fn by_vpid(&self, vpid: Vpid) -> Option<&Job> {
		self.list.iter().find(|j| j.vpid == vpid)
	}

	/// The job whose root vproc is `vpid`, to update it.
	pub fn by_vpid_mut(&mut self, vpid: Vpid) -> Option<&mut Job> {
		self.list.iter_mut().find(|j| j.vpid == vpid)
	}

	/// The job `pid` names: its virtual pid or its program's OS pid
	/// ([`Job::os_pid`]).
	pub fn by_pid(&self, pid: u32) -> Option<&Job> {
		self.list.iter().find(|j| j.named_by(pid))
	}

	/// Add a background job (bash `stop_pipeline` for an async list): it
	/// takes the number after the highest one in use (bash does not reuse
	/// lower freed numbers until the table is empty) and becomes current
	/// as `reset_current` decides. Returns its number.
	pub fn add(&mut self, id: JobId, vpid: Vpid, text: BString, control: bool, wd: BString) -> u32 {
		let number = self.list.last().map_or(1, |j| j.number.saturating_add(1));
		self.list.push(Job {
			id,
			number,
			vpid,
			text,
			state: JobState::Running,
			control,
			notified: false,
			nohup: false,
			inherited: false,
			wd,
			os_pid: None,
		});
		self.reset_current();
		number
	}

	/// Remove job `number` (bash `delete_job`); a removed current or
	/// previous job makes `reset_current` pick new ones.
	pub fn remove(&mut self, number: u32) -> Option<Job> {
		let i = self.list.iter().position(|j| j.number == number)?;
		let job = self.list.remove(i);
		if self.current == Some(number) || self.previous == Some(number) {
			self.reset_current();
		}
		Some(job)
	}

	/// Remove every job `pick` selects, as [`Self::remove`] does.
	pub fn remove_where(&mut self, mut pick: impl FnMut(&Job) -> bool) {
		let mut reset = false;
		let (current, previous) = (self.current, self.previous);
		self.list.retain(|j| {
			let gone = pick(j);
			reset |= gone && (current == Some(j.number) || previous == Some(j.number));
			!gone
		});
		if reset {
			self.reset_current();
		}
	}

	fn state(&self, number: Option<u32>) -> Option<JobState> {
		number.and_then(|n| self.get(n)).map(|j| j.state)
	}

	fn is_stopped(&self, number: Option<u32>) -> bool {
		matches!(self.state(number), Some(JobState::Stopped(_)))
	}

	fn is_running(&self, number: Option<u32>) -> bool {
		self.state(number) == Some(JobState::Running)
	}

	/// The newest job older than `before` (all jobs for `None`) that is
	/// stopped (`stopped`) or running (bash `most_recent_job_in_state`).
	fn newest(&self, before: Option<u32>, stopped: bool) -> Option<u32> {
		self
			.list
			.iter()
			.rev()
			.filter(|j| before.is_none_or(|b| j.number < b))
			.find(|j| {
				if stopped {
					matches!(j.state, JobState::Stopped(_))
				} else {
					j.state == JobState::Running
				}
			})
			.map(|j| j.number)
	}

	/// Make `job` the current job and pick a useful previous one (bash
	/// `set_current_job`).
	pub fn set_current(&mut self, job: u32) {
		if self.current != Some(job) {
			self.previous = self.current;
			self.current = Some(job);
		}
		if self.previous != self.current && self.is_stopped(self.previous) {
			return;
		}
		if self.is_stopped(self.current)
			&& let Some(candidate) = self.newest(self.current, true)
		{
			self.previous = Some(candidate);
			return;
		}
		let candidate = if self.is_running(self.current) {
			self.newest(self.current, false)
		} else {
			self.newest(None, false)
		};
		self.previous = candidate.or(self.current);
	}

	/// Choose the current job after a change (bash `reset_current`): a
	/// stopped current job stays; else the previous one if stopped, the
	/// newest stopped one, or the newest running one.
	pub fn reset_current(&mut self) {
		let candidate = if self.is_stopped(self.current) {
			self.current
		} else if self.is_stopped(self.previous) {
			self.previous
		} else {
			self.newest(None, true).or_else(|| self.newest(None, false))
		};
		if let Some(job) = candidate {
			self.set_current(job);
		} else {
			self.current = None;
			self.previous = None;
		}
	}

	/// Resolve a job spec without its leading `%` (bash `get_job_spec`
	/// after the `%`): a number, `%`/`+`/`-`, a command prefix, or `?` and a
	/// substring (matched case-insensitively, as `strcasestr`).
	pub fn lookup(&self, spec: &[u8]) -> JobLookup {
		if !spec.is_empty() && spec.iter().all(u8::is_ascii_digit) {
			return std::str::from_utf8(spec)
				.ok()
				.and_then(|s| s.parse::<u32>().ok())
				.map_or(JobLookup::None, JobLookup::Job);
		}
		let current = |n: Option<u32>| n.map_or(JobLookup::None, JobLookup::Job);
		match spec.first() {
			None | Some(b'%' | b'+') => return current(self.current),
			Some(b'-') => return current(self.previous),
			_ => {},
		}
		let (name, substring) = match spec.strip_prefix(b"?") {
			Some(rest) => (rest, true),
			None => (spec, false),
		};
		let mut found = JobLookup::None;
		for job in self.list.iter().rev() {
			let hit = if substring {
				name.is_empty()
					|| job
						.text
						.windows(name.len())
						.any(|w| w.eq_ignore_ascii_case(name))
			} else {
				job.text.starts_with(name)
			};
			if hit {
				if found != JobLookup::None {
					return JobLookup::Ambiguous;
				}
				found = JobLookup::Job(job.number);
			}
		}
		found
	}
}

/// `$!` of a vproc ([`Vproc::last_bg`]): the last asynchronous child (a
/// background job, a process substitution, a coprocess) and the
/// OS pid of the program it runs, once known ([`Job::os_pid`]). Two words,
/// zero meaning none (no vpid or OS pid is zero): an `Option` pair would
/// grow every vproc (idle vproc ≤ 2 KiB).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastBg {
	vpid: u32,
	os:   u32,
}

impl LastBg {
	/// `$!` names `vpid`, by its virtual pid until [`Self::set_os`].
	pub const fn new(vpid: Vpid) -> Self {
		Self { vpid: vpid.0, os: 0 }
	}

	/// The child `$!` names.
	pub const fn vpid(self) -> Option<Vpid> {
		if self.vpid == 0 {
			None
		} else {
			Some(Vpid(self.vpid))
		}
	}

	/// The OS pid the child is known by, once settled.
	pub const fn os(self) -> Option<u32> {
		if self.os == 0 { None } else { Some(self.os) }
	}

	/// The child runs the program with OS pid `pid`.
	pub const fn set_os(&mut self, pid: u32) {
		self.os = pid;
	}

	/// The pid `$!` expands to: the OS pid, else the virtual pid.
	pub const fn pid(self) -> Option<u32> {
		match (self.os(), self.vpid()) {
			(Some(os), _) => Some(os),
			(None, Some(v)) => Some(v.0),
			(None, None) => None,
		}
	}

	/// `$!` names `v`.
	pub const fn is(self, v: Vpid) -> bool {
		self.vpid != 0 && self.vpid == v.0
	}

	/// `pid` is `$!`'s virtual or OS pid: the child it names.
	pub const fn named_by(self, pid: u32) -> Option<Vpid> {
		if pid != 0 && self.vpid != 0 && (self.vpid == pid || self.os == pid) {
			Some(Vpid(self.vpid))
		} else {
			None
		}
	}
}

/// A background job whose pid is still to be settled, kept by the kernel
/// ([`super::Kernel::bangs`]) for the vproc that may settle it. The first
/// command that vproc dispatches decides: the external spawned as the job's
/// lone command (or `exec`'d) makes the job known by that program's OS pid
/// ([`Job::os_pid`], `$!`); anything else (a builtin, a native task, a
/// subshell or pipeline, a non-`exec` external in a compound body, the
/// vproc's end) leaves its virtual pid. Readers of the pid (`$!`, `jobs
/// -l`/`-p`/`-x`) wait for the decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bang {
	/// The vproc that decides: the job's own, or the subshell a callout of
	/// its lone command handed the job to.
	pub vproc: Vpid,
	/// The job's vproc (the one `$!` and the job table name).
	pub job:   Vpid,
	/// What may still give the job its program.
	pub stage: BangStage,
}

/// The redirections of a background job's lone command whose open would
/// wait (a FIFO without its other end), kept by the kernel
/// ([`super::Kernel::deferrals`]) while the command resolves: an external
/// applies them itself ([`crate::bash::ChildRedirs`]), so the job has its OS
/// pid at once; anything else applies them here as usual.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deferral {
	/// The vproc running the command.
	pub vproc: Vpid,
	/// Index of the first redirection left (the one whose open would wait).
	pub from:  usize,
	/// Where the command is.
	pub phase: DeferPhase,
	/// The redirections collected for the process (`Collect`), in order.
	pub list:  Vec<crate::bash::host::ChildRedir>,
}

/// Progress of a [`Deferral`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeferPhase {
	/// The redirection stage stopped at the open that would wait; the
	/// command's name resolves next.
	Lookup,
	/// It is an external: the redirection stage resumes, collecting the
	/// rest for the process.
	Collect,
	/// It is not (or its spawn failed): the redirection stage resumes and
	/// opens the rest here.
	Resume,
}

impl Vproc {
	/// The vproc a pid operand (`kill`, `wait`, `disown`) names here: a
	/// job's or `$!`'s OS pid maps to its vproc; any other number is taken
	/// as a virtual pid.
	pub fn vpid_of(&self, pid: u32) -> Vpid {
		match self.jobs.by_pid(pid) {
			Some(job) => job.vpid,
			None => self.last_bg.named_by(pid).unwrap_or(Vpid(pid)),
		}
	}

	/// The pid the user knows the child `v` by (`wait -p`): its job's or
	/// `$!`'s OS pid, else its virtual pid.
	pub fn shown_pid(&self, v: Vpid) -> u32 {
		match self.jobs.by_vpid(v) {
			Some(job) => job.pid(),
			None if self.last_bg.is(v) => self.last_bg.os().unwrap_or(v.0),
			None => v.0,
		}
	}
}

/// What may still settle a [`Bang`] with an OS pid.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BangStage {
	/// The job's body is one simple command: its external is the program
	/// (bash's subshell `exec`s it).
	Lone,
	/// Only an `exec`'d external is (`{ exec cmd; } &`, a function called
	/// as the lone command).
	Exec,
	/// A host callout runs as the lone command: it may hand the job to the
	/// subshell it starts ([`crate::bash::ShellApi::exec_subshell_in`],
	/// `nohup`); unless it does, the alias settles virtual when the host
	/// steps the shell again.
	Callout,
}

/// A running coprocess: its vproc, the variable naming it and the shell's
/// ends of its pipes (unset and closed once it is reaped).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Coproc {
	pub vpid:  Vpid,
	/// `NAME` (`NAME[0]`, `NAME[1]`, `NAME_PID`).
	pub name:  BString,
	/// The fd the shell reads the coprocess's output from (`NAME[0]`).
	pub read:  i32,
	/// The fd the shell writes its input to (`NAME[1]`).
	pub write: i32,
}

impl Vproc {
	/// `BASH_COMMAND`: the source text of the current command.
	pub fn command_text(&self) -> &[u8] {
		self.command.as_ref().map_or(&[][..], |(unit, node)| {
			unit
				.nodes
				.get(*node as usize)
				.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
				.unwrap_or_default()
		})
	}

	pub const fn has_work(&self) -> bool {
		!self.runs.is_empty() || !self.frames.is_empty()
	}

	/// Bash defers trapped signals while waiting for a foreground command.
	pub fn waiting_foreground(&self) -> bool {
		self.frames.iter().any(|frame| {
			frame.scratch.as_ref().is_some_and(|scratch| {
				!scratch.children.is_empty()
					|| scratch.sub.is_some()
					|| matches!(
						scratch.exec.as_ref().and_then(|exec| exec.waiting),
						Some(Awaited::Call(_) | Awaited::Task(_) | Awaited::Ext { .. })
					)
			})
		})
	}
}

/// Why a vproc is parked, and the wake count it parked at.
pub struct Blocked {
	pub key: WaitKey,
	pub at:  u64,
}

/// A submitted script.
pub struct Run {
	pub id:                RunId,
	pub tag:               u64,
	pub src:               Arc<[u8]>,
	pub chain:             OriginChain,
	/// The mode it starts in: [`Script::mode`](super::Script::mode), or the
	/// vproc's mode when the script was submitted.
	pub mode:              ModeId,
	/// The vproc's mode before a run with an explicit mode started, put
	/// back when it ends (a per-run mode does not leak into later runs).
	pub restore_mode:      Option<ModeId>,
	/// [`Script::mode`](super::Script::mode) was given.
	pub explicit_mode:     bool,
	/// [`crate::bash::store::LossyKind`] bits reported outside any
	/// mode-switching call during this run (`Diag::ModeLossy` once per kind).
	pub lossy:             u8,
	/// Root scripts: positional parameters, cwd and exported variables to
	/// install when the script starts.
	pub args:              Option<Vec<BString>>,
	pub cwd:               Option<BString>,
	pub env:               Vec<(BString, BString)>,
	pub started:           bool,
	pub exit_trap_started: bool,
}

/// What kind of activation a frame is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FrameKind {
	/// Parses and runs commands from source one at a time: the run's
	/// script, `eval`, `source`.
	Script {
		/// Source bytes.
		src:   BString,
		/// Next command's position.
		pos:   (u32, u32),
		/// Parser state kept between commands (one box, mostly `None`).
		aux:   Option<Box<ScriptAux>>,
		/// What kind of script.
		what:  ScriptKind,
		/// More source is read from fd 0 a line at a time when `src` runs
		/// out or ends inside a command (bash reading its script from
		/// standard input: commands that read fd 0 see the following lines).
		stdin: bool,
	},
	/// A function call (a scope is pushed with it).
	Function {
		/// Name.
		name:     BString,
		/// Its scope holds a [`crate::bash::store::ZshScope`] (a zsh-dialect or
		/// mode-switching call): the return restores from it
		/// (`mode::leave_call`). False for a bash call within bash.
		zsh:      bool,
		/// The call that loaded the function (zsh `execautofn`, which runs
		/// the loaded body with `execode(…, "loadautofunc")`):
		/// `zsh_eval_context` shows `loadautofunc` after its `shfunc`.
		autoload: bool,
	},
	/// The code of a child vproc: `SubExit`/`End` exits the vproc.
	Subshell,
	/// `${ cmd; }` / `${| cmd; }` run in the current shell: `SubExit` pops.
	NoFork,
	/// The last stage of a pipeline run in the current shell (`lastpipe`):
	/// `SubExit` pops, and the `Spawn` op collects its status.
	Stage,
	/// The base frame of a job the shell suspended
	/// ([`super::jobctl::suspend`]): a subshell frame that also ends its
	/// vproc when its pc reaches `stop_at` (the end of the top-level
	/// pipeline it took over from the shell).
	Job {
		/// Where the job ends.
		stop_at: u32,
	},
}

/// Parser state a [`FrameKind::Script`] keeps between its commands.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptAux {
	/// Unread alias text left after the last command (read before `pos`),
	/// and the alias names still barred from re-expansion.
	pub pending: Option<(BString, Vec<BString>)>,
	/// zsh `parse_string` (`eval`, traps, `-c`, substitutions): the whole
	/// text is parsed before any of it runs, so every command parses with
	/// the features and aliases of the first.
	pub parse:   Option<ParseSnapshot>,
}

/// The parse context a zsh string keeps for all its commands
/// ([`ScriptAux::parse`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParseSnapshot {
	/// [`crate::bash::syntax::Features`] bits.
	pub features: u32,
	/// The aliases in effect (`None`: none, or expansion off).
	pub aliases:  Option<super::builtins::Aliases>,
}

/// Source of a [`FrameKind::Script`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScriptKind {
	/// The run's own script.
	Run,
	/// `eval`.
	Eval,
	/// `source` / `.` (a `return` target).
	Source,
	/// Shell code the line editor runs (a user widget, a hook function
	/// like `precmd` or `zle-line-init`): the call of a function, which
	/// zsh makes directly, so it shows in no call context of its own
	/// (`zsh_eval_context`, diagnostics); the editor restores `$?`.
	Hook,
	/// A trap action, restoring the interrupted status when it finishes.
	Trap {
		key:           crate::bash::store::TrapKey,
		status:        i32,
		cancel:        Option<i32>,
		return_target: Option<usize>,
		/// An ERR trap run by `set -e`: the shell exits with `status` when
		/// the trap ends.
		exit:          bool,
	},
	/// Shell code a builtin runs as zsh's `execode`/`execstring` do with
	/// a context name (`zstyle -e` values, `zregexparse` guards and
	/// actions): it parses whole, shows in `zsh_eval_context` under its
	/// context, reports diagnostics under the caller's name with the line
	/// numbers it was parsed at, and an error in it ends only the code
	/// (recorded in [`crate::bash::store::MiscKey::ZshCodeError`] for the
	/// builtin, which runs again when the frame returns).
	Code(CodeKind),
}

/// What a [`ScriptKind::Code`] frame runs (its `zsh_eval_context` word).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CodeKind {
	/// A `zstyle -e` value (`style`).
	Style,
	/// A `zregexparse` guard (`zregexparse-guard`).
	RegexGuard,
	/// A `zregexparse` action (`zregexparse-action`).
	RegexAction,
}

impl CodeKind {
	/// The context name zsh passes to `execode`/`execstring`.
	pub const fn context(self) -> &'static str {
		match self {
			Self::Style => "style",
			Self::RegexGuard => "zregexparse-guard",
			Self::RegexAction => "zregexparse-action",
		}
	}
}

impl FrameKind {
	pub fn script(src: &[u8], pos: Pos, what: ScriptKind) -> Self {
		Self::Script {
			src: BString::from(src),
			pos: (pos.offset, pos.line),
			aux: None,
			what,
			stdin: false,
		}
	}
}

/// One activation: a unit, a pc and its loop, case, time and redirection
/// stacks.
pub struct Frame {
	/// Code being run; `None` for a script frame between commands.
	pub unit:              Option<Arc<Unit>>,
	pub pc:                u32,
	pub kind:              FrameKind,
	pub loops:             Vec<LoopRec>,
	/// Open compound commands: (node, start time) for `CmdEnd`.
	pub enters:            Vec<(u32, u64)>,
	/// `case` subjects, and whether an arm matched yet.
	pub cases:             Vec<(BString, bool)>,
	/// `time` starts.
	pub times:             Vec<TimeMark>,
	/// fds saved by `Redir` ops, innermost last.
	pub redirs:            Vec<Vec<Saved>>,
	/// Scratch of the op at `pc` while it is parked or calling.
	pub scratch:           Option<Box<Scratch>>,
	/// Lines subtracted from diagnostic line numbers: bash numbers a
	/// command substitution by re-parsing its text from the line of the
	/// command that runs it, so its first command reports that line.
	pub line_shift:        u32,
	/// Exec op whose DEBUG trap has already run.
	pub debug_pc:          Option<u32>,
	/// Pseudo-traps installed in this function rather than inherited.
	pub debug_trap_local:  bool,
	pub err_trap_local:    bool,
	pub return_trap_local: bool,
	/// A zsh function call with `PM_TAGGED_LOCAL` in effect (`functions
	/// -T`, `function -T`, or an anonymous function called from such a
	/// call): the named functions it calls run with `xtrace` off.
	pub trace_local:       bool,
	/// zsh: `ERR_EXIT` as it was when the DEBUG trap at this frame's list
	/// marker ([`Self::debug_pc`]) started, put back when it ends.
	pub debug_errexit:     bool,
	/// A failing nested command already ran the ERR trap.
	pub err_reported:      bool,
	/// Called (function, `eval`, `source`, subshell) from a context where
	/// `set -e` is ignored: an `if`/`while`/`until` condition, a `&&`/`||`
	/// list except its last command, a `!` pipeline.
	pub ignore_errexit:    bool,
	/// The base frame of a `( … )` child: the line bash reports for errors
	/// of the compound commands it runs directly (the subshell's last line,
	/// where bash's parser recorded it).
	pub subshell_line:     Option<u32>,
	/// A function frame: the getopts state at the call, put back on return
	/// when the function made `OPTIND` local (bash
	/// `sh_getopt_save_istate`/`sh_getopt_restore_istate`). `None` is the
	/// default state: no allocation per call, and 40 bytes less per frame
	/// (idle vproc ≤ 2 KiB).
	pub getopts:           Option<Box<GetoptsState>>,
}

impl Frame {
	pub const fn new(unit: Option<Arc<Unit>>, pc: u32, kind: FrameKind) -> Self {
		Self {
			unit,
			pc,
			kind,
			loops: Vec::new(),
			enters: Vec::new(),
			cases: Vec::new(),
			times: Vec::new(),
			redirs: Vec::new(),
			scratch: None,
			line_shift: 0,
			debug_pc: None,
			debug_trap_local: false,
			err_trap_local: false,
			return_trap_local: false,
			trace_local: false,
			debug_errexit: false,
			err_reported: false,
			ignore_errexit: false,
			subshell_line: None,
			getopts: None,
		}
	}
}

/// Where a `time`d pipeline started: the monotonic clock and the CPU times
/// of the shell and its children (all in ns), for the report at its end.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeMark {
	/// [`crate::bash::host::Host::now_ns`].
	pub real: u64,
	/// User CPU time of the shell and its waited-for children.
	pub user: u64,
	/// System CPU time of the shell and its waited-for children.
	pub sys:  u64,
}

/// An fd slot saved by a redirection, restored when it ends.
pub struct Saved {
	pub fd:   i32,
	pub prev: Option<FdRef>,
}

/// A loop record (`break`/`continue` targets, the loop's status).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopRec {
	pub kind:       LoopKind,
	/// Status of the last completed body.
	pub status:     i32,
	pub iterations: u32,
	pub exit:       u32,
	pub cont:       u32,
	/// Depths of the frame stacks when the loop started (`break` unwinds
	/// them).
	pub depth:      Depths,
}

/// Lengths of a frame's stacks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Depths {
	pub enters: u32,
	pub cases:  u32,
	pub times:  u32,
	pub redirs: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoopKind {
	While,
	For {
		var:   BString,
		items: Vec<BString>,
		next:  u32,
	},
	Select {
		var:   BString,
		items: Vec<BString>,
		first: bool,
		/// zsh `selectlist`'s `more`: the row the next menu page starts
		/// at (0 for the first page).
		more:  u32,
	},
	/// zsh `repeat N`: passes still to run.
	Repeat {
		left: i64,
	},
	/// zsh `for a b … in words`: each pass assigns the next words to the
	/// variables in turn (missing ones empty).
	ForMulti {
		vars:  Vec<BString>,
		items: Vec<BString>,
		next:  u32,
	},
	/// zsh `{ try-list } always { always-list }`: not a loop (`break` and
	/// `continue` counts skip it). [`LoopRec::exit`] is the pc of the
	/// always-list, [`LoopRec::cont`] the pc after it, [`LoopRec::status`]
	/// the try-list's status once the always-list runs.
	Try {
		/// The always-list is running.
		always:  bool,
		/// What ended the try-list early: resumed after the always-list.
		pending: Option<TryEnd>,
	},
}

/// How a zsh try-list ended early (zsh `exectry`: the `errflag`,
/// `retflag`, `breaks`/`contflag` and pending `exit` it saves around the
/// always-list).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TryEnd {
	/// An error (`errflag`): `TRY_BLOCK_ERROR` is 1 in the always-list.
	Error,
	/// `return n`.
	Return(i32),
	/// `break n` / `continue n`: the loop levels still to leave.
	Break { n: u32, cont: bool },
	/// `exit n` from inside a function (zsh `exit_pending`).
	Exit(i32),
}

/// Bytes still to be written to an fd.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingWrite {
	pub fd:    i32,
	pub bytes: BString,
	pub off:   usize,
}

/// One logged expansion step (see `expand`): replaying the log reproduces
/// an expansion that parked on a command substitution without repeating
/// side effects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Atom {
	/// A scalar value (or `None`: unset).
	Str(Option<BString>),
	/// A list value (`$@`, `${a[@]}`).
	List(Vec<BString>),
	/// A finished command substitution.
	Sub { out: BString, status: i32 },
	/// A side effect that already happened.
	Done,
	/// A branch decided on the first pass, whose own side effect would
	/// change the decision on the replay (zsh `${name:=word}`).
	Branch(bool),
	/// An assignment a pass made (zsh `${name::=word}`) and what it
	/// replaced: `old` is `Str(None)` (unset), `Str(Some)` (a scalar) or
	/// `List` (an array); `new` the scalar it left (`None`: an array). The
	/// next pass puts `old` back first while `name` still holds `new`, then
	/// assigns again as it replays, so it sees the first pass's state at
	/// every point.
	Wrote { name: BString, old: Box<Self>, new: Option<BString> },
}

/// Per-op scratch: expansion replay logs, staged progress and transient
/// handles of the op at the frame's pc.
#[derive(Default)]
pub struct Scratch {
	/// Replay logs, one per expansion site of the op ([`Slot`]).
	pub logs:        [Vec<Atom>; 4],
	/// A command substitution being waited for.
	pub sub:         Option<PendingSub>,
	/// Progress of a staged `Exec` (boxed: it moves to `spare_exec` and
	/// back once per command; a pointer moves, not the 368-byte state).
	pub exec:        Option<Box<ExecState>>,
	/// Redirection, probe and PATH-search progress ([`ScratchIo`]), created
	/// by [`Self::io()`] on first use and kept by [`Self::recycle`].
	pub io:          Option<Box<ScratchIo>>,
	/// Transient handles of the `Exec`.
	pub live:        Live,
	/// Children of a `Spawn` op, with their statuses as they exit.
	pub children:    Vec<(Vpid, Option<i32>)>,
	/// A `Spawn` running its last stage in this shell (`lastpipe`).
	pub inline:      Option<InlineStage>,
	/// A finished `Exec`'s state kept so the next command reuses its
	/// allocations; never serialized.
	pub spare_exec:  Option<Box<ExecState>>,
	/// Cleared word buffers of finished commands, filled again by the next
	/// expansion (`Expander::pool`); kept by [`Self::recycle`], never
	/// serialized.
	pub spare_words: Vec<BString>,
}

impl Scratch {
	/// Clear for the next op, keeping allocations: a finished `Exec`'s
	/// state becomes the spare.
	pub fn recycle(&mut self) {
		let Self { logs, sub, exec, io, live, children, inline, spare_exec, spare_words: _ } = self;
		for log in logs {
			log.clear();
		}
		// Tested first: most ops leave both empty, and an assignment would
		// run their drop glue (a call each) anyway.
		if sub.is_some() {
			*sub = None;
		}
		if let Some(e) = exec.take() {
			*spare_exec = Some(e);
		}
		if let Some(io) = io {
			io.clear();
		}
		if !matches!(live, Live::None) {
			*live = Live::None;
		}
		children.clear();
		*inline = None;
	}

	/// The op's I/O progress, created on first use (the first redirection,
	/// probe or PATH search of a scratch that had none). Called where that
	/// progress is written; readers use [`Self::probes`], [`Self::probing`]
	/// or the field, which allocate nothing.
	#[inline]
	pub fn io(&mut self) -> &mut ScratchIo {
		self.io.get_or_insert_with(Box::default)
	}

	/// Answers of the op's file probes and lookups so far (empty without
	/// [`ScratchIo`]); handed to builtins and `[[ ]]` as their cache.
	pub fn probes(&self) -> &[(Probe, ProbeResult)] {
		self.io.as_ref().map_or(&[][..], |io| &io.probes[..])
	}

	/// The probe in flight, if any.
	pub fn probing(&self) -> Option<&Probe> {
		self.io.as_ref().and_then(|io| io.probing.as_ref())
	}
}

/// The I/O progress of an op: redirections, the fds they saved, file
/// probes, PATH search, fd reads and pathname-expansion walks. Most ops need
/// none of it (an idle background job's parked `Exec` neither), so a
/// [`Scratch`] holds it boxed and creates it on first use: 232 bytes less per
/// scratch (idle vproc ≤ 2 KiB). A recycled scratch keeps it cleared, so
/// an op that redirects or probes in a loop allocates it once.
#[derive(Default)]
pub struct ScratchIo {
	/// Progress of a `Redir` op or the redirection stage of an `Exec`.
	pub redir:   RedirProgress,
	/// fds saved by the `Exec`'s own redirections.
	pub saved:   Vec<Saved>,
	/// Results of file probes and lookups (pollable builtins, `[[ -f ]]`).
	pub probes:  Vec<(Probe, ProbeResult)>,
	/// The probe whose fs operation is in flight (`Scratch::live`), with its
	/// partial progress.
	pub probing: Option<Probe>,
	/// PATH search of the probe in flight.
	pub search:  Option<PathSearch>,
	/// Bytes read so far by an `Input`/`Read` probe.
	pub input:   Vec<u8>,
	/// The pathname-expansion walk of the `Glob` probe in flight.
	pub walk:    Option<Box<super::glob::Walk>>,
	/// The zsh part ([`ScratchZsh`]), created by zsh code on first use
	/// ([`Self::zsh()`]): a bash op's progress neither carries nor clears it.
	pub zsh:     Option<Box<ScratchZsh>>,
}

impl ScratchIo {
	/// Clear for the next op, keeping the vectors' allocations.
	fn clear(&mut self) {
		let Self { redir, saved, probes, probing, search, input, walk, zsh } = self;
		*redir = RedirProgress::default();
		saved.clear();
		probes.clear();
		*probing = None;
		*search = None;
		input.clear();
		*walk = None;
		if let Some(z) = zsh {
			z.clear();
		}
	}

	/// The op's zsh I/O progress, created on first use.
	pub fn zsh(&mut self) -> &mut ScratchZsh {
		self.zsh.get_or_insert_with(Box::default)
	}
}

/// The I/O progress only zsh code keeps ([`ScratchIo::zsh`]).
#[derive(Default)]
pub struct ScratchZsh {
	/// The zsh filename-generation walk of the `Glob` probe in flight (not
	/// imaged, like [`ScratchIo::walk`]: a restored op restarts its walk).
	pub zglob:     Option<Box<super::zsh::zglob::Walk>>,
	/// zsh `multios`: per fd redirected by this list, whether it is an
	/// output and the objects it was redirected to so far (zsh `mfds`).
	pub multio:    Vec<(i32, bool, Vec<FdRef>)>,
	/// zsh `xpandredir`: a redirection whose target expanded to several
	/// words becomes one redirection per word (index in the list, word),
	/// applied after the list's own; [`RedirProgress::done`] counts on
	/// through them.
	pub more:      Vec<(u32, BString)>,
	/// The `fcntl` lock a history file operation holds (zsh `flock_fd`,
	/// `histfcntllock`), released with the op (not imaged).
	pub hist_lock: Option<Box<dyn crate::bash::fs::File>>,
}

impl ScratchZsh {
	/// Clear for the next op, keeping the vectors' allocations.
	fn clear(&mut self) {
		let Self { zglob, multio, more, hist_lock } = self;
		*zglob = None;
		multio.clear();
		more.clear();
		*hist_lock = None;
	}
}

/// Progress of a pipeline's last stage run in the current shell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum InlineStage {
	/// Its frame is running above the `Spawn` op's.
	Running,
	/// It finished with this status.
	Done(i32),
}

/// Which replay log of a [`Scratch`] an expansion uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
	/// Command words, loop lists, case words and patterns, `[[ ]]` operands.
	Words   = 0,
	/// The current redirection's target.
	Redirs  = 1,
	/// Prefix assignment values.
	Assigns = 2,
	/// Expansions a builtin runs itself (`unset 'a[$(cmd)]'`).
	Builtin = 3,
}

/// A command substitution in flight.
pub enum PendingSub {
	/// `$( )`: a child vproc writing into a capture.
	Fork { vpid: Vpid, capture: Capture },
	/// `${ ;}` / `${| ;}`: a `NoFork` frame above this one.
	NoFork { capture: Capture, value: bool },
	/// A zsh hook function call run in the current shell
	/// ([`crate::bash::vm::expand::Stop::ZshSub::here`]): a script frame
	/// above this one; `status` is the caller's `$?`, put back when it ends.
	Here { status: i32 },
	/// A zsh user math function's shell function run in the current shell
	/// ([`crate::bash::vm::expand::Stop::MathCall`]): a function frame above
	/// this one; as [`Self::Here`], with its value ([`VprocZsh::last_math`])
	/// logged too, in the replay log `slot` of the expansion that called it
	/// (an op may expand several: `[[ ]]` operands, then its arithmetic).
	Math { status: i32, slot: Slot },
}

/// Progress through a redirection list.
#[derive(Default)]
pub struct RedirProgress {
	/// Redirections fully applied.
	pub done:    usize,
	/// Expanded target of the current redirection.
	pub target:  Option<BString>,
	/// Pending `open` of the current redirection.
	pub opening: Option<Box<dyn FsPending<Box<dyn crate::bash::fs::File>>>>,
}

/// A file probe or name lookup requested by a pollable builtin or `[[ ]]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Probe {
	/// `stat(path)` (`follow` = not `lstat`).
	Stat { path: BString, follow: bool },
	/// `access(path, mode bits)`.
	Access { path: BString, mode: u8 },
	/// PATH search for a command name over `$PATH` = `path`.
	Path { name: BString, path: BString },
	/// Whole-file read (`source`).
	Read { path: BString },
	/// `cd` target validation.
	Chdir { path: BString },
	/// Input from an fd up to a delimiter (`read`): `delim` `None` reads
	/// to EOF, else the read ends with the `lines`-th delimiter (1 but for
	/// `mapfile`); `nchars` caps the count; `part` numbers successive reads
	/// of one command (continuation lines, `select` re-prompts); `timeout_ns`
	/// gives up after that long without complete input (`read -t`, `TMOUT`).
	/// Nothing past the end is consumed: a regular file's read-ahead is given
	/// back, other fds are read a byte at a time.
	Input {
		fd:         i32,
		delim:      Option<u8>,
		lines:      u32,
		nchars:     Option<usize>,
		part:       u32,
		timeout_ns: Option<u64>,
	},
	/// Whether fd has input available, without reading it (`read -t 0`).
	Ready { fd: i32 },
	/// Pathname expansion of an escaped pattern, relative to the cwd.
	Glob { pattern: BString, opts: super::glob::GlobOpts },
	/// The canonical physical path of an absolute path (zsh's `:A`/`:P`
	/// modifiers): [`ProbeResult::Path`], `None` when it does not resolve.
	RealPath { path: BString },
	/// An fd-level operation of a zsh module builtin (`sysread`, `zselect`,
	/// `sysopen`, sockets): [`ProbeResult::Fd`]. Asked by builtins only
	/// (performed by [`super::probe::perform_mut`]).
	Fd(Box<super::fdprobe::FdProbe>),
	/// A filesystem request answered with its `errno` (zsh/files, zsh/stat,
	/// zsh/attr, zsh/mapfile): [`ProbeResult::Fs`]. `seq` numbers the
	/// asker's requests, so one made twice is asked twice.
	Fs { seq: u32, req: Box<super::fsprobe::FsReq> },
	/// An operation of the zsh/zftp `zftp` builtin (network, terminal,
	/// files): [`ProbeResult::Zftp`]. `seq` numbers the builtin's
	/// operations within the command. Performed by
	/// [`super::probe::perform_mut`].
	Zftp { seq: u32, op: Box<super::builtins::zsh_mod_zftp::ZftpOp> },
	/// A filesystem or clock step of a history file operation
	/// ([`super::builtins::history::io`]): [`ProbeResult::Hist`]. `seq`
	/// numbers the operation's steps.
	Hist { seq: u32, op: Box<super::builtins::history::io::HistOp> },
}

/// Answer of a [`Probe`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProbeResult {
	Stat(Option<crate::bash::fs::Stat>),
	Ok(bool),
	Path(Option<BString>),
	/// File contents, or the `strerror` text of the failure.
	Bytes(Result<BString, BString>),
	Input {
		data:      BString,
		eof:       bool,
		/// The timeout passed first (`data` holds the partial input).
		timed_out: bool,
	},
	/// Matching paths, sorted (empty: no match).
	Paths(Vec<BString>),
	/// Answer of a [`Probe::Fd`].
	Fd(Box<super::fdprobe::FdAnswer>),
	/// Answer of a [`Probe::Fs`].
	Fs(super::fsprobe::FsResult),
	/// Answer of a [`Probe::Zftp`].
	Zftp(Box<super::builtins::zsh_mod_zftp::ZftpAns>),
	/// Answer of a [`Probe::Hist`].
	Hist(Box<super::builtins::history::io::HistAnswer>),
}

/// Serializable progress of an `Exec` (survives externalize/restore).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecState {
	pub stage:       Stage,
	pub tag:         CmdTag,
	pub t0:          u64,
	pub argv:        Vec<BString>,
	/// The words are expanded (`argv`, `compound` are final).
	pub expanded:    bool,
	/// argv indexes of compound-assignment words (`declare a=(…)`).
	pub compound:    Vec<u32>,
	/// Fields still to pathname-expand: `(argv index, escaped pattern)`.
	pub globs:       Vec<(u32, BString)>,
	/// Prefix assignments as `(name, shown value)` for events.
	pub assigns:     Vec<(BString, BString)>,
	/// Expanded prefix assignments: subscript and value.
	pub values:      Vec<(Option<BString>, AssignValue)>,
	/// `set -k`: `words` indexes of the assignment words taken out of
	/// `argv`; their values follow the prefix ones in `values`.
	pub keywords:    Vec<u32>,
	/// argv indexes of single fields from words written as array
	/// references ([`super::builtins::Ctx::arrayref`]).
	pub arrayref:    Vec<u32>,
	pub target:      Option<Target>,
	pub waiting:     Option<Awaited>,
	/// A temporary scope (builtin environment) was pushed for this command.
	pub scoped:      bool,
	/// Control transfer to perform once the output is written.
	pub control:     Option<Transfer>,
	/// `Task::checkpoint` bytes taken at externalize.
	pub checkpoint:  Option<Vec<u8>>,
	/// Command output still to be written.
	pub writes:      VecDeque<PendingWrite>,
	pub status:      i32,
	/// Status of the last command substitution (`$?` of `x=$(…)`).
	pub sub_status:  Option<i32>,
	/// Children `wait` waits for.
	pub wait_for:    Vec<Vpid>,
	/// `exec command`: how the command replaces the shell.
	pub exec_as:     Option<Box<ExecAs>>,
	/// `wait -p var`: the variable that gets the waited child's pid.
	pub wait_into:   Option<Box<BString>>,
	/// Run through `command`: a special builtin's failure does not end a
	/// posix shell.
	pub via_command: bool,
	/// The awaited frame was pushed by the builtin, which runs again when
	/// it returns ([`Control::Resume`](super::builtins::Control::Resume)).
	pub resume:      bool,
	/// Times the builtin ran again after a frame it pushed returned.
	pub resumed:     u32,
}

/// Options of `exec [-cl] [-a name] command`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecAs {
	/// `-c`: an empty environment.
	pub clear_env: bool,
	/// `-l`: `-` before `argv[0]`.
	pub login:     bool,
	/// `-a name`: `argv[0]`.
	pub argv0:     Option<BString>,
}

/// A control transfer requested by a builtin (`return`, `break`, `exit`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Transfer {
	Return(i32),
	Break {
		n:    u32,
		cont: bool,
	},
	Exit(i32),
	/// The rest of the line is abandoned with this status (a `-c` string
	/// whole).
	DiscardAll(i32),
	/// `exec command`: the shell exits with the command's status.
	Exec,
}

/// An expanded assignment value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssignValue {
	Scalar(BString),
	/// `(…)`: `(key, append, value)` with keys as written (expanded).
	Array(Vec<(Option<BString>, bool, BString)>),
}

/// Stages of `Exec`: each keeps its results here, so a wake
/// or a restore resumes the same stage and nothing earlier re-runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Stage {
	/// Expand words to fields (side effects, no fs calls).
	Expand,
	/// Apply redirections (`open` through `Fs`).
	Redirect,
	/// Resolve the name; PATH search through `Fs`.
	Lookup,
	/// Start the command (builtins run here, re-run after each probe).
	Dispatch,
	/// Wait for a callout, task, external or called frame.
	Await,
	/// Write the command's own output.
	Output,
	/// Report and finish.
	Finish,
}

/// What a command name resolved to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Target {
	Function(BString),
	Intrinsic(IntrinsicId),
	Tool(ToolRef),
	Native(NativeRef),
	Device(NativeRef),
	SelfShell,
	External(BString),
	/// An external without `#!` that the OS refused (`ENOEXEC`): read it and
	/// run it as a script in a subshell, as bash does.
	Script(BString),
	/// zsh `zexecve`: the `#!` interpreter run in place of a script the OS
	/// refused (an external that gets no second substitution).
	Interp(BString),
	/// PATH search in progress.
	Search,
	NotFound,
	/// The OS refused to execute `path` with error `code` (raw OS error,
	/// not `ENOEXEC`): probes decide bash's message (`Is a directory`, `bad
	/// interpreter`, `required file not found`, the error itself).
	Refused {
		path: BString,
		code: i32,
	},
}

impl Target {
	pub const fn kind(&self) -> ResolvedKind {
		match self {
			Self::Function(_) => ResolvedKind::Function,
			Self::Intrinsic(_) => ResolvedKind::Intrinsic,
			Self::Tool(_) => ResolvedKind::Tool,
			Self::Native(_) => ResolvedKind::Native,
			Self::Device(_) => ResolvedKind::Device,
			Self::SelfShell => ResolvedKind::SelfShell,
			Self::External(_) | Self::Script(_) | Self::Interp(_) | Self::Refused { .. } => {
				ResolvedKind::External
			},
			Self::Search | Self::NotFound => ResolvedKind::NotFound,
		}
	}
}

impl From<Resolved> for Target {
	fn from(r: Resolved) -> Self {
		match r {
			Resolved::Intrinsic(id) => Self::Intrinsic(id),
			Resolved::Tool(t) => Self::Tool(t),
			Resolved::Native(n) => Self::Native(n),
			Resolved::Device(n) => Self::Device(n),
			Resolved::SelfShell => Self::SelfShell,
			Resolved::External(p) => Self::External(p),
			Resolved::NotFound => Self::NotFound,
		}
	}
}

/// PATH search state: candidates and the probe in progress.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathSearch {
	pub cands:         Vec<BString>,
	pub idx:           usize,
	/// The candidate passed `stat`; `access(X)` is next.
	pub checking_exec: bool,
	/// The first regular file that is not executable: bash's
	/// `FS_EXEC_PREFERRED` finds it when no candidate is executable.
	pub nonexec:       Option<usize>,
}

/// What an `Exec` waits for in `Stage::Await`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Awaited {
	Call(CallId),
	Task(NativeRef),
	Ext {
		pid: u32,
	},
	/// A pushed frame (function, `eval`, `source`) to return.
	Frame,
	/// Background children (`wait id …`); the status is the last one's.
	/// Without `force` (`wait -f`) a job that stops ends the wait (status
	/// 128 + the stop signal), as in bash with job control.
	Jobs {
		force: bool,
	},
	/// Every background child (`wait` without operands); the status is 0.
	AllJobs,
	/// The first of the children to finish (`wait -n`); its status.
	AnyJob,
}

/// Transient handles; never serialized.
#[derive(Default)]
pub enum Live {
	#[default]
	None,
	Stat(Box<dyn FsPending<Stat>>),
	Access(Box<dyn FsPending<()>>),
	/// `realpath` of a `RealPath` probe in flight.
	Path(Box<dyn FsPending<BString>>),
	/// `open` of a `Read` probe in flight.
	Open(Box<dyn FsPending<Box<dyn crate::bash::fs::File>>>),
	/// The opened file of a `Read` probe.
	File(Box<dyn crate::bash::fs::File>),
	Task(Box<dyn Task>),
	Ext(Box<dyn ExtProc>),
	/// [`Host::spawn`](crate::bash::Host::spawn) of the external of a
	/// `Dispatch` still in flight: no process exists yet.
	Spawn(crate::bash::host::SpawnFuture),
	/// The timer of an `Input` probe with a timeout.
	Timer(Box<dyn crate::bash::host::Timer>),
	/// `read_dir` of a glob walk in flight.
	OpenDir(Box<dyn FsPending<Box<dyn crate::bash::fs::DirIter>>>),
	/// The listing of a glob walk.
	Dir(Box<dyn crate::bash::fs::DirIter>),
	/// A socket or lock operation of a [`Probe::Fd`] in flight.
	Fd(Box<super::fdprobe::FdLive>),
	/// A request of a [`Probe::Fs`] in flight.
	Fs(Box<super::fsprobe::FsLive>),
	/// An operation of a [`Probe::Zftp`] in flight (sockets, timers).
	Zftp(Box<super::builtins::zsh_mod_zftp::ZftpLive>),
}

impl Live {
	/// A pending idempotent fs op (dropped by a suspend, re-issued later).
	/// Reading a regular file again from the start is; reading a pipe, FIFO
	/// or device is not (the bytes taken are gone, and closing the reader
	/// can break the writer), so a suspend keeps it and externalize reports
	/// it lost. A pending spawn counts too: it has made no process, so
	/// dropping it spawns nothing and the `Dispatch` stage asks again.
	pub fn is_idempotent_fs(&self) -> bool {
		match self {
			Self::Stat(_)
			| Self::Access(_)
			| Self::Path(_)
			| Self::OpenDir(_)
			| Self::Dir(_)
			| Self::Spawn(_) => true,
			// A FIFO open is a rendezvous with the other end.
			Self::Open(open) => open.reissuable(),
			Self::Fd(live) => live.is_idempotent(),
			Self::Fs(live) => live.idempotent,
			Self::File(file) => file.kind() == crate::bash::fs::FileKind::Regular,
			// Network traffic is not asked twice.
			Self::Task(_) | Self::Ext(_) | Self::Timer(_) | Self::Zftp(_) | Self::None => false,
		}
	}
}

// Size guards for the idle-vproc target (≤ 2 KiB): an idle background job
// holds one boxed `Vproc`, one `Frame`, one boxed `Scratch` and one boxed
// `ExecState`, so every byte here is a byte per idle vproc. Raise a bound
// only with the testkit `memory` bench's numbers in hand.
// zsh support added the boxed zsh side table `Vproc::zsh` (8 B; `Frame` is
// unchanged, its zsh state lives there and in `FrameKind`): the memory
// bench measured 1,785 B per idle vproc with it (target ≤ 2,048).
// Host lineage (`Vproc::lineage`, 8 B: a `u32` label and a flag) added at
// most 8 B to that, still under 2,048. The resumable `mapfile -C` counter
// (`ExecState::resumed`, 368 → 376 B): the bench measured 1,832 B per idle
// vproc with both. The line editor's boxed state (`Vproc::zle`, 8 B) brings
// that to at most 1,840 B.
const _: () = assert!(size_of::<Vproc>() <= 672, "Vproc grew (idle vproc ≤ 2 KiB)");
const _: () = assert!(size_of::<Frame>() <= 256, "Frame grew (idle vproc ≤ 2 KiB)");
const _: () = assert!(size_of::<Scratch>() <= 216, "Scratch grew (idle vproc ≤ 2 KiB)");
const _: () = assert!(size_of::<ExecState>() <= 376, "ExecState grew (idle vproc ≤ 2 KiB)");
// An op that redirects or probes keeps a `ScratchIo` (cleared per op): its
// zsh-only progress lives in the boxed `ScratchZsh` (zsh support grew it by one
// pointer only; `RedirProgress` not at all).
const _: () = assert!(size_of::<ScratchIo>() <= 248, "ScratchIo grew (zsh support is zero cost)");
const _: () =
	assert!(size_of::<RedirProgress>() <= 48, "RedirProgress grew (zsh support is zero cost)");

/// `size_of` of the structures an idle vproc holds, by name: the testkit
/// `memory` bench prints them as its `memory sizes:` line beside the bytes
/// per idle vproc. Measurement only.
pub const fn vproc_layout() -> [(&'static str, usize); 5] {
	[
		("Vproc", size_of::<Vproc>()),
		("Frame", size_of::<Frame>()),
		("Scratch", size_of::<Scratch>()),
		("ScratchIo", size_of::<ScratchIo>()),
		("ExecState", size_of::<ExecState>()),
	]
}
