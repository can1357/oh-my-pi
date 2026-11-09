//! Job control of the interactive shell: zsh 5.9 `jobs.c` (process
//! groups, the terminal handoff, stops and continues, job notices), the
//! job parts of `exec.c` (`entersubsh`, `addproc`, the `list_pipe` fork of
//! a suspended construct) and `init.c` (`init_io`, `acquire_pgrp`,
//! `release_pgrp`); bash's `jobs.c` where the dialects differ.
//!
//! **Layout.** At interactive startup the shell opens its terminal (zsh
//! `SHTTY`, [`init_io`]) and, with `MONITOR`, makes itself the leader of
//! the terminal's foreground process group ([`Pgrp`]), ignoring
//! `TSTP`/`TTIN`/`TTOU` while its jobs get the defaults. Every job runs in
//! a process group of its own ([`pgroup`]): the shell's own foreground
//! commands (a pipeline at a time, keyed by the root vproc), a background
//! job (keyed by its vproc, [`leader_of`]). A foreground job owns
//! the terminal; when it stops or ends the terminal comes back
//! ([`reclaim`]).
//!
//! **Stops.** An external of the shell's foreground stopping makes the
//! running command a stopped job ([`suspend`]): what the shell was in the
//! middle of moves to a new job vproc that runs on to the end of the
//! top-level pipeline once continued (zsh forks the rest of a construct;
//! a lone command is just that command), and the shell goes on after it
//! with `$?` 128 + the signal. Stops and continues of other jobs reach the
//! job table after the scheduler turn that saw them ([`Shell::job_events`]).

use std::{
	fmt::Write as _,
	task::{Context, Poll, Waker},
};

use bstr::{BStr, BString};

use super::{
	Cx, Kernel, Shell,
	exec::{self, Flow},
	proc::{Frame, FrameKind, JobState, PendingWrite, Saved, Scratch, ScriptKind, Vproc},
	state,
};
use crate::bash::{
	fd::{FdOrigin, FdRef},
	host::{ExtProc, OsHandle, PgroupSpec, ProcEvent},
	ids::{Dialect, JobId, Platform, Vpid},
	ir::{Opcode, Unit},
	signal::{SigSet, Signal},
	store::{KeyBuf, OptId, TrapKey},
	term::{SetWhen, TermFlag, Termios},
	zshopt::ZshOpt,
};

/// The action text handed to [`crate::bash::Host::set_signal_trap`] for a
/// signal the interactive shell catches itself (any non-empty action
/// catches; the text is not run).
const CATCH: &[u8] = b"interactive";

/// The interactive shell's process groups (zsh `mypgrp`, `origpgrp`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pgrp {
	/// The group the shell leads and that owns the terminal between jobs.
	mine: i32,
	/// The group the shell was started in, given the terminal back at exit.
	orig: i32,
}

/// Job-control state of a shell ([`Kernel::jobctl`]). Not imaged: process
/// groups and terminals do not survive a restore (a restored shell runs
/// without job control).
#[derive(Default)]
pub struct JobCtl {
	/// The shell is interactive (set by [`init_io`]).
	interactive: bool,
	/// The root vproc: the key of the shell's own foreground job.
	root:        Option<Vpid>,
	/// zsh `SHTTY`: the shell's terminal, where job notices go.
	shtty:       Option<FdRef>,
	/// Its handle for the [`crate::bash::Terminal`] seam.
	handle:      Option<OsHandle>,
	/// `MONITOR` acquired the terminal (zsh `jobbing` with a terminal).
	pgrp:        Option<Pgrp>,
	/// The shell's terminal modes (zsh `shttyinfo`).
	modes:       Option<Termios>,
	/// `(job key, pgid)`: the process group of each job that has one.
	groups:      Vec<(Vpid, u32)>,
	/// `(vproc, job key)` for vprocs outside the shell's foreground job
	/// ([`leader_of`]): a background job and what it runs, a command
	/// substitution (`None`: no job, the shell's own group). Kept here
	/// rather than in the vproc (idle vproc ≤ 2 KiB); only while the
	/// shell does job control.
	leaders:     Vec<(Vpid, Option<Vpid>)>,
	/// Terminal modes of stopped jobs, put back by `fg` (zsh `jn->ty`).
	job_modes:   Vec<(Vpid, Termios)>,
	/// The job owning the terminal: the root (its own commands) or the
	/// job `fg` resumed.
	fg:          Option<Vpid>,
	/// Stops and continues externals of non-root vprocs reported during
	/// the turn: `(vproc, event)`.
	events:      Vec<(Vpid, ProcEvent)>,
	/// A process of the shell's foreground job stopped: the root suspends
	/// the job when it runs next.
	fg_stop:     Option<Signal>,
	/// `(child, job)`: children of the shell that moved into a suspended
	/// job ([`suspend`]), re-parented after the turn.
	reparent:    Vec<(Vpid, Vpid)>,
	/// Background jobs whose `[n] pid…` line is still to be printed.
	announce:    Vec<Announce>,
	/// `(job, text)`: a suspended construct's own text (zsh's super-job),
	/// shown once it is done; until then the job shows the process that
	/// stopped (the sub-job).
	texts:       Vec<(Vpid, BString)>,
	/// zsh `stopmsg`: `exit` warned about jobs; counts down per command.
	stopmsg:     u8,
	/// The terminal `read -k`/`-q` put in cbreak mode, with the modes it
	/// had ([`set_cbreak`]).
	cbreak:      Option<(FdRef, Termios)>,
}

impl JobCtl {
	/// A process of the shell's foreground job stopped and the root has not
	/// suspended the job yet ([`pending_suspend`]).
	pub const fn has_fg_stop(&self) -> bool {
		self.fg_stop.is_some()
	}

	/// The shell acquired the terminal for job control (`MONITOR` with a
	/// terminal at some point).
	pub const fn has_pgrp(&self) -> bool {
		self.pgrp.is_some()
	}
}

/// zsh `sigmsg`: how a signal is named in job notices.
pub const fn sigmsg(sig: Signal) -> &'static str {
	match sig {
		Signal::Hup => "hangup",
		Signal::Int => "interrupt",
		Signal::Quit => "quit",
		Signal::Ill => "illegal hardware instruction",
		Signal::Trap => "trace trap",
		Signal::Abrt => "abort",
		Signal::Bus => "bus error",
		Signal::Fpe => "floating point exception",
		Signal::Kill => "killed",
		Signal::Usr1 => "user-defined signal 1",
		Signal::Segv => "segmentation fault",
		Signal::Usr2 => "user-defined signal 2",
		Signal::Pipe => "broken pipe",
		Signal::Alrm => "alarm",
		Signal::Term => "terminated",
		Signal::Chld => "death of child",
		Signal::Cont => "continued",
		Signal::Stop => "suspended (signal)",
		Signal::Tstp => "suspended",
		Signal::Ttin => "suspended (tty input)",
		Signal::Ttou => "suspended (tty output)",
		Signal::Urg => "urgent condition",
		Signal::Xcpu => "cpu limit exceeded",
		Signal::Xfsz => "file size limit exceeded",
		Signal::Vtalrm => "virtual time alarm",
		Signal::Prof => "profile signal",
		Signal::Winch => "window size changed",
		Signal::Io => "i/o ready",
		Signal::Sys => "invalid system call",
		Signal::Emt => "EMT instruction",
		Signal::Info => "status request from keyboard",
		Signal::Stkflt => "SIGSTKFLT",
		Signal::Pwr => "power fail",
		_ => "unknown signal",
	}
}

/// The signal that ended a job with `status` (128 + n), if any.
pub fn death_signal(status: i32, platform: Platform) -> Option<Signal> {
	status
		.checked_sub(128)
		.and_then(|n| u8::try_from(n).ok())
		.and_then(|n| Signal::from_number(n, platform))
}

/// What [`format_job`] prints a job line for (zsh `printjob`'s `lng` and
/// `synch`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JobLine {
	/// `lng & 1` (`jobs -l`): the job's pid before its status.
	pub pid:     bool,
	/// `lng & 2` (`jobs -p`): the process group leader's pid.
	pub leader:  bool,
	/// The job continued (`fg`, `bg`): `continued` instead of `running`.
	pub conted:  bool,
	/// The shell's current foreground job (zsh `thisfmt`): `zsh: ` instead
	/// of `[n]  + `.
	pub thisfmt: bool,
}

/// zsh `printjob`'s line for job `number` of `vp`'s table: `[1]  + done
/// sleep 1`, `zsh: suspended  vim`. The status word is padded to the
/// longest one shown plus two (at least `continued`'s nine). `None` when
/// there is no such job. The `(pwd …)` line is the caller's.
pub fn format_job(vp: &Vproc, number: u32, how: JobLine, platform: Platform) -> Option<Vec<u8>> {
	let job = vp.jobs.get(number)?;
	let word: String = match job.state {
		JobState::Running if how.conted => "continued".into(),
		JobState::Running => "running".into(),
		JobState::Stopped(sig) => sigmsg(sig).into(),
		JobState::Done(0) => "done".into(),
		JobState::Done(status) => match death_signal(status, platform) {
			Some(sig) => sigmsg(sig).into(),
			None => format!("exit {status:<4}"),
		},
	};
	let len = word.len().max(9);
	let mut line = Vec::with_capacity(32 + job.text.len());
	if how.thisfmt {
		line.extend_from_slice(b"zsh: ");
	} else {
		let mark = if vp.jobs.current == Some(number) {
			'+'
		} else if vp.jobs.previous == Some(number) {
			'-'
		} else {
			' '
		};
		line.extend_from_slice(format!("[{number}]  {mark} ").as_bytes());
	}
	if how.pid || how.leader {
		line.extend_from_slice(format!("{} ", job.pid()).as_bytes());
	}
	line.extend_from_slice(format!("{word:<w$}", w = len + 2).as_bytes());
	line.extend_from_slice(&job.text);
	line.push(b'\n');
	Some(line)
}

/// Write `bytes` where zsh writes job notices (`shout`): the shell's
/// terminal, else its standard output.
pub fn notice(k: &Kernel, vp: &mut Vproc, bytes: &[u8]) {
	match &k.jobctl.shtty {
		Some(tty) => write_all(tty, bytes),
		None => vp
			.out
			.push_back(PendingWrite { fd: 1, bytes: BString::from(bytes), off: 0 }),
	}
}

/// Write to the terminal while it takes the bytes (a terminal does not
/// refuse a notice's few dozen).
fn write_all(fd: &FdRef, mut bytes: &[u8]) {
	let mut cx = Context::from_waker(Waker::noop());
	while !bytes.is_empty() {
		match fd.poll_write(&mut cx, bytes) {
			Poll::Ready(Ok(n)) if n > 0 => bytes = &bytes[n..],
			_ => return,
		}
	}
}

/// zsh `init_io` for an interactive shell, called once by
/// [`Shell::create`]: open the shell's terminal and, with `MONITOR`, take
/// over its foreground (`acquire_pgrp`; without a terminal, or when that
/// fails, `MONITOR` goes off as in zsh). The shell then catches `INT`,
/// `WINCH` and `ALRM` for its whole life and ignores `QUIT` and `TERM`, and
/// `TSTP`/`TTIN`/`TTOU` while it does job control; its externals start
/// with the default dispositions.
pub fn init_io(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	k.jobctl.interactive = true;
	k.jobctl.root = Some(vp.vpid);
	k.jobctl.fg = Some(vp.vpid);
	// zsh `init_signals`: an interactive zsh starts every signal at its
	// default, so what was ignored on entry is not passed on to its
	// commands (except `QUIT`, which it records as ignored).
	if vp.mode.dialect() == Dialect::Zsh {
		for sig in cx.host.ignored_signals().iter() {
			if sig != Signal::Quit {
				k.root
					.set_record(cx.store, KeyBuf::Trap(TrapKey::Signal(sig)), None);
			}
		}
	}
	open_shtty(k, cx);
	let monitor = state::option(&mut k.root, cx.store, vp, OptId::Monitor).unwrap_or(false);
	if monitor
		&& !acquire(k, cx)
		&& let Err(err) = state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Monitor, false)
	{
		k.fail(err);
	}
	for sig in [Signal::Int, Signal::Winch, Signal::Alrm] {
		let _ = cx.host.set_signal_trap(sig, Some(BStr::new(CATCH)));
	}
	for sig in held_ignored(k).iter() {
		let _ = cx.host.set_signal_trap(sig, Some(BStr::new(b"")));
	}
}

/// Open the shell's terminal (zsh `init_io`: `SHTTY`) and read its modes
/// (`shttyinfo`); nothing when the host has no terminal.
fn open_shtty(k: &mut Kernel, cx: &mut Cx<'_>) {
	if k.jobctl.shtty.is_some() {
		return;
	}
	if let Some(term) = cx.host.terminal()
		&& let Ok(Some(tty)) = term.open_controlling()
	{
		let handle = tty.file.os_handle();
		k.jobctl.modes = handle.and_then(|h| term.attrs(h).ok());
		k.jobctl.handle = handle;
		k.jobctl.shtty = Some(FdRef::open(tty.file, FdOrigin::Host));
	}
}

/// The signals the interactive shell ignores itself (zsh `init_signals`):
/// `QUIT` and `TERM`, and the terminal stop signals while it does job
/// control.
const fn held_ignored(k: &Kernel) -> SigSet {
	let mut set = SigSet::EMPTY.with(Signal::Quit).with(Signal::Term);
	if k.jobctl.pgrp.is_some() {
		set = set.with(Signal::Tstp).with(Signal::Ttin).with(Signal::Ttou);
	}
	set
}

/// zsh `acquire_pgrp`: wait until the shell's group owns the terminal (a
/// shell started in the background stops on `SIGTTIN` until it is brought
/// to the foreground), then lead a group of its own and give it the
/// terminal. `false` when the shell cannot (no terminal, `setpgid`
/// refused).
fn acquire(k: &mut Kernel, cx: &mut Cx<'_>) -> bool {
	let Some(h) = k.jobctl.handle else {
		return false;
	};
	let me = i32::try_from(cx.host.shell_pid()).unwrap_or(0);
	let Some(term) = cx.host.terminal() else {
		return false;
	};
	let orig = term.process_group();
	let mut mine = orig;
	let mut last = mine;
	let mut tries = 0;
	loop {
		let Some(term) = cx.host.terminal() else {
			return false;
		};
		match term.foreground(h) {
			Ok(fg) if fg != mine => {},
			_ => break,
		}
		mine = term.process_group();
		if mine == me {
			let _ = term.set_foreground(h, mine);
		}
		if term.foreground(h).is_ok_and(|fg| fg == mine) {
			break;
		}
		// zsh's `read(0, NULL, 0)`: the kernel stops a background reader's
		// group with `SIGTTIN`, which is what this does.
		let _ = cx.host.signal_process(0, Some(Signal::Ttin));
		let Some(term) = cx.host.terminal() else {
			return false;
		};
		mine = term.process_group();
		if mine == last {
			tries += 1;
			if tries == 100 {
				break;
			}
		}
		last = mine;
	}
	if mine != me {
		let Some(term) = cx.host.terminal() else {
			return false;
		};
		if term.set_process_group(0, 0).is_err() {
			return false;
		}
		mine = me;
		let _ = term.set_foreground(h, mine);
	}
	k.jobctl.pgrp = Some(Pgrp { mine, orig });
	true
}

/// zsh `dosetopt` turning `MONITOR` on from a builtin (`set -m`, `setopt
/// monitor`, `options[monitor]=on`): with a terminal the shell takes it
/// over (`acquire_pgrp`) and starts ignoring the terminal stop signals;
/// without one the option cannot change (`can't change option`).
pub fn enable_monitor(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	open_shtty(k, cx);
	if k.jobctl.handle.is_none() {
		return false;
	}
	if vp.parent.is_some() {
		return true;
	}
	if k.jobctl.root.is_none() {
		k.jobctl.root = Some(vp.vpid);
		k.jobctl.fg = Some(vp.vpid);
	}
	if k.jobctl.pgrp.is_none() && acquire(k, cx) {
		for sig in [Signal::Tstp, Signal::Ttin, Signal::Ttou] {
			let _ = cx.host.set_signal_trap(sig, Some(BStr::new(b"")));
		}
	}
	true
}

/// The OS disposition the root shell asks for when its trap for `sig`
/// changes to `action` (`None`: removed): an interactive shell keeps its
/// own (`INT`, `WINCH`, `ALRM` caught; `QUIT`, `TERM` and, with job
/// control, `TSTP`/`TTIN`/`TTOU` ignored) instead of the entry disposition.
pub fn trap_disposition<'a>(k: &Kernel, sig: Signal, action: Option<&'a BStr>) -> Option<&'a BStr> {
	if action.is_some() || !k.jobctl.interactive {
		return action;
	}
	if matches!(sig, Signal::Int | Signal::Winch | Signal::Alrm) {
		return Some(BStr::new(CATCH));
	}
	held_ignored(k).contains(sig).then(|| BStr::new(b""))
}

/// The interactive root got `sig` with no trap set: what zsh's handler
/// does. `INT` abandons the command being run (`errflag |=
/// ERRFLAG_INT`; `$?` 130); `ALRM`, `QUIT` and `TERM` are ignored.
/// `false` for any other signal (its default action applies).
pub fn untrapped(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, sig: Signal) -> bool {
	if !k.jobctl.interactive || vp.parent.is_some() {
		return false;
	}
	match sig {
		Signal::Int => {
			interrupt(k, cx, vp);
			true
		},
		Signal::Alrm | Signal::Quit | Signal::Term => true,
		Signal::Tstp | Signal::Ttin | Signal::Ttou => k.jobctl.pgrp.is_some(),
		_ => false,
	}
}

/// Abandon the command line the root is running: frames above the run's
/// script go, the script reads its next command.
fn interrupt(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	end_cbreak(k, cx);
	if vp.frames.is_empty() {
		return;
	}
	exec::unwind(&mut k.root, cx.store, vp, 1);
	exec::clear_scratch(&mut k.root, cx.store, vp);
	let f = &mut vp.frames[0];
	let saves: Vec<Vec<Saved>> = std::mem::take(&mut f.redirs);
	f.loops.clear();
	f.enters.clear();
	f.cases.clear();
	f.times.clear();
	f.debug_pc = None;
	if matches!(f.kind, FrameKind::Script { .. }) {
		f.unit = None;
	}
	for s in saves.into_iter().rev() {
		exec::restore(vp, s);
	}
	vp.status = 130;
	vp.blocked = None;
}

/// Whether the shell does job control now: it acquired the terminal and
/// `MONITOR` is on.
pub fn jobbing(k: &mut Kernel, cx: &mut Cx<'_>) -> bool {
	k.jobctl.pgrp.is_some() && k.root.option(cx.store, OptId::Monitor).unwrap_or(false)
}

/// Whether the shell is interactive ([`init_io`] ran).
pub const fn interactive(k: &Kernel) -> bool {
	k.jobctl.interactive
}

/// The process group of job `key` (a job vproc, or the root for the
/// shell's own foreground commands), once one of its processes leads one.
pub fn group(k: &Kernel, key: Vpid) -> Option<u32> {
	k.jobctl
		.groups
		.iter()
		.find(|(l, _)| *l == key)
		.map(|&(_, g)| g)
}

fn set_group(k: &mut Kernel, key: Vpid, pgid: u32) {
	match k.jobctl.groups.iter_mut().find(|(l, _)| *l == key) {
		Some(entry) => entry.1 = pgid,
		None => k.jobctl.groups.push((key, pgid)),
	}
}

fn take_group(k: &mut Kernel, key: Vpid) -> Option<u32> {
	let i = k.jobctl.groups.iter().position(|(l, _)| *l == key)?;
	Some(k.jobctl.groups.swap_remove(i).1)
}

/// The job whose process group the externals of vproc `vpid` join: the
/// root's own key for the shell and what runs in its foreground, a
/// background job's vpid for that job and its children, `None` in a
/// command substitution (its externals stay in the shell's group, zsh
/// `ESUB_NOMONITOR`).
pub fn leader_of(k: &Kernel, vpid: Vpid) -> Option<Vpid> {
	match k.jobctl.leaders.iter().find(|(v, _)| *v == vpid) {
		Some(&(_, leader)) => leader,
		None => k.jobctl.root.or(Some(vpid)),
	}
}

/// Set vproc `vpid`'s job ([`leader_of`]); kept only under job control.
pub fn set_leader(k: &mut Kernel, vpid: Vpid, leader: Option<Vpid>) {
	if k.jobctl.pgrp.is_none() {
		return;
	}
	let foreground = leader.is_some() && leader == k.jobctl.root;
	match k.jobctl.leaders.iter().position(|(v, _)| *v == vpid) {
		Some(i) if foreground => {
			k.jobctl.leaders.swap_remove(i);
		},
		Some(i) => k.jobctl.leaders[i].1 = leader,
		None if foreground => {},
		None => k.jobctl.leaders.push((vpid, leader)),
	}
}

/// New child `child` of vproc `parent` belongs to the parent's job.
pub fn inherit(k: &mut Kernel, child: Vpid, parent: Vpid) {
	if k.jobctl.pgrp.is_none() {
		return;
	}
	let leader = leader_of(k, parent);
	set_leader(k, child, leader);
}

/// Vproc `vpid` leads a job of its own (a background job, a coprocess),
/// unless it is in a command substitution.
pub fn own_job(k: &mut Kernel, vpid: Vpid) {
	if k.jobctl.pgrp.is_some() && leader_of(k, vpid).is_some() {
		set_leader(k, vpid, Some(vpid));
	}
}

/// Vproc `vpid` ended: its job entry goes.
pub fn forget_vproc(k: &mut Kernel, vpid: Vpid) {
	if !k.jobctl.leaders.is_empty() {
		k.jobctl.leaders.retain(|(v, _)| *v != vpid);
	}
}

/// Placement of an external `vp` spawns ([`crate::bash::SpawnSpec::pgroup`]):
/// with job control, its job's group (a new one for the job's first
/// process), taking the terminal when the job is in the foreground; else
/// the host's plain placement.
pub fn pgroup(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, job: JobId) -> PgroupSpec {
	if k.jobctl.pgrp.is_none() || !jobbing(k, cx) {
		return PgroupSpec::New(job);
	}
	let Some(leader) = leader_of(k, vp.vpid) else {
		return PgroupSpec::New(job);
	};
	PgroupSpec::Job {
		join:     group(k, leader),
		terminal: if k.jobctl.fg == Some(leader) {
			k.jobctl.handle
		} else {
			None
		},
	}
}

/// `vp` spawned `ext`: under job control its group is its job's (the first
/// process's, or the one it had to lead when the old one had emptied).
pub fn spawned(k: &mut Kernel, vp: &Vproc, ext: &dyn ExtProc) {
	if k.jobctl.pgrp.is_none() {
		return;
	}
	if let (Some(leader), Some(pgid)) = (leader_of(k, vp.vpid), ext.pgid()) {
		set_group(k, leader, pgid);
	}
}

/// A background job's `[n] pid…` line still to be printed: zsh names every
/// process of the job (`[1] 1846 1847` for `a | b &`).
struct Announce {
	job:    Vpid,
	number: u32,
	/// `(vproc, pid)` per process the line names, in order: the vproc that
	/// decides the pid ([`Bang`](super::proc::Bang)) and the pid once it
	/// settled. One entry (the job's own) until its pipeline starts.
	pids:   Vec<(Vpid, Option<u32>)>,
}

/// A background job `vpid` started: an interactive shell doing job
/// control prints `[n] pid` with the pid `$!` gives (zsh `spawnjob`):
/// once it is settled, at once when nothing is left to settle.
pub fn started(k: &mut Kernel, cx: &mut Cx<'_>, vpid: Vpid, number: u32) {
	if k.jobctl.interactive && jobbing(k, cx) {
		k.jobctl
			.announce
			.push(Announce { job: vpid, number, pids: vec![(vpid, None)] });
		if !k.bang_pending(vpid) {
			bang_settled(k, vpid, None);
		}
	}
}

/// Whether job `job`'s `[n] pid…` line is still to be printed.
pub fn announcing(k: &Kernel, job: Vpid) -> bool {
	k.jobctl.announce.iter().any(|a| a.job == job)
}

/// Background job `job`'s pipeline started its stages: its line names each
/// stage's process, `(vproc, pending)`. A stage that is not pending keeps
/// its virtual pid.
pub fn pipeline_started(k: &mut Kernel, job: Vpid, stages: &[(Vpid, bool)]) {
	let Some(i) = k.jobctl.announce.iter().position(|a| a.job == job) else {
		return;
	};
	k.jobctl.announce[i].pids = stages
		.iter()
		.map(|&(stage, pending)| (stage, (!pending).then_some(stage.0)))
		.collect();
	print_settled(k, i);
}

/// An external `vp` waits for stopped or continued ([`ExtProc::poll_event`]).
/// The root's own foreground job stopping is suspended at once (`Some`:
/// the flow of the op that waited); any other change is applied to the job
/// table after the turn. `None`: the vproc goes on waiting.
pub fn ext_event(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, ev: ProcEvent) -> Option<Flow> {
	k.jobctl.pgrp?;
	match ev {
		ProcEvent::Stopped(sig) if vp.parent.is_none() => Some(suspend(k, cx, vp, sig)),
		ProcEvent::Exited(_) => None,
		ProcEvent::Continued if vp.parent.is_none() => None,
		ev => {
			k.jobctl.events.push((vp.vpid, ev));
			None
		},
	}
}

/// At the start of the root's turn: a process of its foreground job
/// stopped while the root waited for something else (a pipeline stage, a
/// subshell): suspend the job now. Whether it did.
pub fn pending_suspend(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> bool {
	if vp.parent.is_some() {
		return false;
	}
	let Some(sig) = k.jobctl.fg_stop.take() else {
		return false;
	};
	if vp.frames.iter().all(|f| f.unit.is_none()) {
		return false;
	}
	let _ = suspend(k, cx, vp, sig);
	true
}

/// Source text of syntax node `node`.
fn node_text(unit: &Unit, node: u32) -> BString {
	unit
		.nodes
		.get(node as usize)
		.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
		.map_or_else(BString::default, BString::from)
}

/// Where the job that `frame` (the base frame of the root) is running
/// ends: after the outermost compound command open in it (its `Leave`,
/// and the `PopRedir` of its redirections), the end of the pipeline at the
/// pc, or the command after the pc.
fn boundary(unit: &Unit, frame: &Frame) -> u32 {
	let pc = frame.pc;
	if let Some(&(node, _)) = frame.enters.first() {
		let leave = unit
			.ops
			.iter()
			.enumerate()
			.skip(pc as usize)
			.find(|(_, op)| op.code == Opcode::Leave && op.node == node)
			.map(|(i, _)| i as u32);
		if let Some(leave) = leave {
			let mut end = leave + 1;
			if unit
				.ops
				.get(end as usize)
				.is_some_and(|op| op.code == Opcode::PopRedir && op.node == node)
			{
				end += 1;
			}
			return end;
		}
	}
	if let Some(rec) = frame.loops.first() {
		return rec.exit;
	}
	match unit.ops.get(pc as usize) {
		Some(op) if op.code == Opcode::Spawn => {
			unit.spawns.get(op.a as usize).map_or(pc + 1, |s| s.end)
		},
		_ => pc + 1,
	}
}

/// The child vprocs (subshells, pipeline stages) the op owning `sc` still
/// waits for.
fn live_children(sc: &Scratch, out: &mut Vec<Vpid>) {
	out.extend(
		sc.children
			.iter()
			.filter(|(_, s)| s.is_none())
			.map(|(v, _)| *v),
	);
}

/// A copy of saved fd slots (the objects are shared).
fn copy_saves(saves: &[Saved]) -> Vec<Saved> {
	saves
		.iter()
		.map(|s| Saved { fd: s.fd, prev: s.prev.clone() })
		.collect()
}

/// Undo in `vp` what the op owning `sc` did to it (its redirections, its
/// temporary scope), as dropping the scratch would; the scratch itself
/// moved to the suspended job.
fn undo_scratch(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, sc: &Scratch) {
	if let Some(io) = sc.io.as_deref() {
		for s in io.saved.iter().rev() {
			vp.fds.set(s.fd, s.prev.clone());
		}
	}
	if sc.exec.as_ref().is_some_and(|e| e.scoped) {
		state::drop_scope(&mut k.root, cx.store, vp);
	}
}

/// zsh's handling of a stopped foreground job of the shell itself
/// (`waitjobs` seeing `STAT_STOPPED`, and the `list_pipe` fork when a
/// construct of the shell was running): what the root was in the middle of
/// becomes stopped job `[n]`, a new job vproc that runs on to the end of
/// the top-level pipeline (or compound command) once continued, with the
/// frames, op state, external and pipeline stages it owned; the root drops
/// them as if they had returned and goes on after that pipeline with `$?`
/// 128 + `sig`. The terminal comes back, the job's modes are kept for `fg`,
/// and `zsh: suspended  text` is printed.
pub fn suspend(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, sig: Signal) -> Flow {
	k.jobctl.fg_stop = None;
	let platform = k.engine.config().platform;
	// A sourced file's commands are pipelines of their own (zsh resets
	// `list_pipe` in `execlist` under `sourcelevel`).
	let base = vp
		.frames
		.iter()
		.rposition(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Source, .. }))
		.unwrap_or(0);
	let Some(unit) = vp.frames.get(base).and_then(|f| f.unit.clone()) else {
		return Flow::Call;
	};
	let pc = vp.frames[base].pc;
	let construct = !vp.frames[base].enters.is_empty()
		|| !vp.frames[base].loops.is_empty()
		|| vp.frames[base + 1..]
			.iter()
			.any(|f| f.kind != FrameKind::Stage);
	let end = boundary(&unit, &vp.frames[base]);
	// zsh names the job by the process that stopped inside a construct, by
	// the pipeline otherwise.
	let text = if construct {
		vp.frames
			.last()
			.and_then(|f| {
				let u = f.unit.as_ref()?;
				u.ops.get(f.pc as usize).map(|op| node_text(u, op.node))
			})
			.unwrap_or_default()
	} else {
		unit
			.ops
			.get(pc as usize)
			.map_or_else(BString::default, |op| node_text(&unit, op.node))
	};
	// The construct as a whole (zsh's super-job text).
	let whole = if construct {
		let node = vp.frames[base]
			.enters
			.first()
			.map(|&(node, _)| node)
			.or_else(|| unit.ops.get(pc as usize).map(|op| op.node));
		node.map(|n| exec::job_text(k, cx, vp, &unit, n))
	} else {
		None
	};
	// After a construct the rest of the command line is dropped, as zsh's
	// parent shell does after the `list_pipe` fork; after a plain pipeline
	// the line goes on.
	let resume = if construct {
		unit
			.ops
			.iter()
			.rposition(|op| op.code == Opcode::End)
			.map_or(end, |i| i as u32)
	} else {
		end
	};
	let mut job = vp.child(k, cx.store, std::sync::Arc::clone(&unit), pc, vp.fds.clone());
	set_leader(k, job.vpid, Some(job.vpid));
	if let Some(whole) = whole {
		k.jobctl.texts.push((job.vpid, whole));
	}
	job.stopped = true;
	let mut children: Vec<Vpid> = Vec::new();
	// Frames above the base move to the job; the shell pops stand-ins with
	// the same kind and saved fds, so it returns from them as usual.
	let mut moved: Vec<Frame> = Vec::new();
	while vp.frames.len() > base + 1 {
		let top = vp.frames.len() - 1;
		let f = &mut vp.frames[top];
		let mut stand_in = Frame::new(f.unit.clone(), f.pc, f.kind.clone());
		stand_in.redirs = f.redirs.iter().map(|s| copy_saves(s)).collect();
		stand_in.getopts.clone_from(&f.getopts);
		let frame = std::mem::replace(f, stand_in);
		if let Some(sc) = frame.scratch.as_deref() {
			undo_scratch(k, cx, vp, sc);
			live_children(sc, &mut children);
		}
		exec::pop_frame(&mut k.root, cx.store, vp);
		moved.push(frame);
	}
	moved.reverse();
	// The base frame's part: the op at the pc and the open compounds.
	let f = &mut vp.frames[base];
	let scratch = f.scratch.take();
	let enters = std::mem::take(&mut f.enters);
	let loops = std::mem::take(&mut f.loops);
	let cases = std::mem::take(&mut f.cases);
	let redirs = std::mem::take(&mut f.redirs);
	f.pc = resume;
	f.debug_pc = None;
	let root_saves: Vec<Vec<Saved>> = redirs.iter().map(|s| copy_saves(s)).collect();
	if let Some(sc) = scratch.as_deref() {
		undo_scratch(k, cx, vp, sc);
		live_children(sc, &mut children);
	}
	for saves in root_saves.into_iter().rev() {
		exec::restore(vp, saves);
	}
	let jf = &mut job.frames[0];
	jf.scratch = scratch;
	jf.enters = enters;
	jf.loops = loops;
	jf.cases = cases;
	jf.redirs = redirs;
	jf.kind = FrameKind::Job { stop_at: end };
	job.frames.extend(moved);
	job.trap_frames = u32::try_from(
		job.frames
			.iter()
			.filter(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { .. }, .. }))
			.count(),
	)
	.unwrap_or(u32::MAX);
	let jvpid = job.vpid;
	for child in children {
		match k.spawned.iter_mut().find(|p| p.vpid == child) {
			Some(p) => p.parent = Some(jvpid),
			None => k.jobctl.reparent.push((child, jvpid)),
		}
		set_leader(k, child, Some(jvpid));
	}
	let pgid = take_group(k, vp.vpid);
	if let Some(pgid) = pgid {
		set_group(k, jvpid, pgid);
	}
	let id = k.job_id(cx.store);
	let number = vp.jobs.add(id, jvpid, text, true, vp.cwd.clone());
	if let Some(entry) = vp.jobs.get_mut(number) {
		entry.state = JobState::Stopped(sig);
		entry.notified = true;
		entry.os_pid = pgid;
	}
	stopped_current(vp, number);
	k.spawned.push(Box::new(job));
	reclaim(k, cx, Some(jvpid), false);
	// zsh `printjob`: a newline first after a `^Z` of the job itself
	// (`doputnl`), not after a construct's.
	let mut line = Vec::new();
	if sig == Signal::Tstp && !construct {
		line.push(b'\n');
	}
	let how = JobLine { thisfmt: true, pid: long_list(k, cx, vp), ..JobLine::default() };
	if let Some(text) = format_job(vp, number, how, platform) {
		line.extend_from_slice(&text);
	}
	notice(k, vp, &line);
	vp.status = sig.exit_status(platform);
	Flow::Call
}

/// A job stopped: it becomes the current job and the old current one the
/// previous (zsh `update_job`: `prevjob = curjob; curjob = job`; bash
/// `set_current_job`).
pub fn stopped_current(vp: &mut Vproc, number: u32) {
	if vp.mode.dialect() == Dialect::Zsh {
		// Even when it already was current: zsh then has it as both.
		vp.jobs.previous = vp.jobs.current;
		vp.jobs.current = Some(number);
	} else {
		vp.jobs.set_current(number);
	}
}

/// The terminal goes back to the shell (zsh `attachtty(mypgrp)`). A job
/// that stopped (`stopped`) keeps the modes it left for `fg`, and the
/// shell's are put back; after a finished foreground job the shell adopts
/// the modes it left (zsh `gettyinfo(&shttyinfo)`: `stty` changes stay),
/// except while the line editor is active (`editing`: zsh's `!zleactive`,
/// the terminal is in the editor's modes then).
/// The shell's own commands are the foreground job again.
pub fn reclaim(k: &mut Kernel, cx: &mut Cx<'_>, stopped: Option<Vpid>, editing: bool) {
	k.jobctl.fg = k.jobctl.root;
	let (Some(h), Some(pgrp)) = (k.jobctl.handle, k.jobctl.pgrp) else {
		return;
	};
	let Some(term) = cx.host.terminal() else {
		return;
	};
	if term.foreground(h).is_ok_and(|fg| fg != pgrp.mine) {
		let _ = term.set_foreground(h, pgrp.mine);
	}
	match stopped {
		Some(job) => {
			if let Ok(modes) = term.attrs(h) {
				k.jobctl.job_modes.retain(|(j, _)| *j != job);
				k.jobctl.job_modes.push((job, modes));
			}
			if let Some(modes) = &k.jobctl.modes {
				let _ = term.set_attrs(h, modes, SetWhen::Drain);
			}
		},
		None if editing => {},
		None => {
			if let Ok(modes) = term.attrs(h) {
				k.jobctl.modes = Some(modes);
			}
		},
	}
}

/// `fg`: job `leader` takes the terminal and the modes it had when it
/// stopped (zsh `bin_fg`: `attachtty(gleader)`, `settyinfo(jn->ty)`); it
/// is the foreground job until it ends or stops. Its processes are
/// continued by the caller.
pub fn give_terminal(k: &mut Kernel, cx: &mut Cx<'_>, leader: Vpid) {
	if k.jobctl.pgrp.is_none() {
		return;
	}
	k.jobctl.fg = Some(leader);
	let Some(h) = k.jobctl.handle else {
		return;
	};
	let modes = k
		.jobctl
		.job_modes
		.iter()
		.position(|(j, _)| *j == leader)
		.map(|i| k.jobctl.job_modes.swap_remove(i).1);
	let pgid = group(k, leader);
	let Some(term) = cx.host.terminal() else {
		return;
	};
	if let Some(modes) = &modes {
		let _ = term.set_attrs(h, modes, SetWhen::Drain);
	}
	if let Some(pgid) = pgid.and_then(|g| i32::try_from(g).ok()) {
		let _ = term.set_foreground(h, pgid);
	}
}

/// The root's foreground command (a lone external or a pipeline) is over:
/// its group is done with, the terminal comes back. One killed by a signal
/// other than `INT` or `PIPE` is reported (`zsh: terminated  cmd`); `INT`
/// moves to a new line (zsh `printjob`'s `doputnl`). A pipeline's last
/// stage running here ends only with the pipeline.
pub fn fg_done(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	killed: Option<Signal>,
	text: &[u8],
) {
	if vp.parent.is_some() || k.jobctl.pgrp.is_none() {
		return;
	}
	if vp.frames.iter().any(|f| f.kind == FrameKind::Stage) {
		return;
	}
	take_group(k, vp.vpid);
	reclaim(k, cx, None, super::zle::active(vp));
	match killed {
		Some(Signal::Int) => notice(k, vp, b"\n"),
		Some(Signal::Pipe) | None => {},
		Some(sig) => {
			let line = format!("zsh: {:<w$}", sigmsg(sig), w = sigmsg(sig).len().max(9) + 2);
			let mut line = line.into_bytes();
			line.extend_from_slice(text);
			line.push(b'\n');
			notice(k, vp, &line);
		},
	}
}

/// Job `vpid` of `vp`'s table finished (`reaped`). The foreground job
/// `fg` resumed gives the terminal back (reported like the shell's own
/// foreground commands when a signal other than `INT`/`PIPE` killed it);
/// a background job is reported at once under `notify`, else before the
/// next prompt ([`notices_before_prompt`]). Its group is forgotten.
pub fn job_done(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, vpid: Vpid) {
	take_group(k, vpid);
	k.jobctl.job_modes.retain(|(j, _)| *j != vpid);
	if let Some(i) = k.jobctl.texts.iter().position(|(j, _)| *j == vpid) {
		let (_, text) = k.jobctl.texts.swap_remove(i);
		if let Some(job) = vp.jobs.by_vpid_mut(vpid) {
			job.text = text;
		}
	}
	if k.jobctl.pgrp.is_none() || vp.parent.is_some() {
		return;
	}
	let platform = k.engine.config().platform;
	let Some(number) = vp.jobs.by_vpid(vpid).map(|j| j.number) else {
		return;
	};
	if k.jobctl.fg == Some(vpid) {
		reclaim(k, cx, None, super::zle::active(vp));
		let killed = match vp.jobs.get(number).map(|j| j.state) {
			Some(JobState::Done(status)) => death_signal(status, platform),
			_ => None,
		};
		if let Some(job) = vp.jobs.get_mut(number) {
			job.notified = true;
		}
		match killed {
			Some(Signal::Int) => notice(k, vp, b"\n"),
			Some(Signal::Pipe) | None => {},
			Some(_) => {
				let how = JobLine { thisfmt: true, pid: long_list(k, cx, vp), ..JobLine::default() };
				if let Some(line) = format_job(vp, number, how, platform) {
					notice(k, vp, &line);
				}
			},
		}
		return;
	}
	if state::option(&mut k.root, cx.store, vp, OptId::Notify).unwrap_or(false) {
		report_async(k, cx, vp, number, platform);
	}
}

/// [`report`] at any time under `notify` (zsh `update_job` from the
/// `SIGCHLD` handler): while the line editor waits for a key the notice
/// goes above the line it redraws.
fn report_async(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, number: u32, platform: Platform) {
	let how = JobLine { pid: long_list(k, cx, vp), ..JobLine::default() };
	if let Some(line) = format_job(vp, number, how, platform)
		&& super::zle::display::print_above(k, cx, vp, &line)
	{
		settle_report(vp, number);
		return;
	}
	report(k, vp, number, platform, how);
}

/// zsh `LONG_LIST_JOBS`: job notices show the pid (`printjob`'s `lng`).
fn long_list(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	vp.mode.dialect() == Dialect::Zsh
		&& state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Longlistjobs).unwrap_or(false)
}

/// Print job `number`'s changed state (zsh `printjob` from `scanjobs` or
/// `update_job`) and forget it when it is done (`deletejob`).
fn report(k: &Kernel, vp: &mut Vproc, number: u32, platform: Platform, how: JobLine) {
	if let Some(line) = format_job(vp, number, how, platform) {
		notice(k, vp, &line);
	}
	settle_report(vp, number);
}

/// Job `number` was reported: forget it when done, else mark it reported.
fn settle_report(vp: &mut Vproc, number: u32) {
	let done = vp
		.jobs
		.get(number)
		.is_some_and(|j| matches!(j.state, JobState::Done(_)));
	if done {
		forget(vp, number);
	} else if let Some(job) = vp.jobs.get_mut(number) {
		job.notified = true;
	}
}

/// zsh `deletejob` after a report: the current job falls back to the
/// previous one (`curjob = prevjob; prevjob = job`, then `setprevjob`);
/// bash `cleanup_dead_jobs`.
fn forget(vp: &mut Vproc, number: u32) {
	if vp.mode.dialect() != Dialect::Zsh {
		vp.jobs.remove(number);
		return;
	}
	let Some(i) = vp.jobs.list.iter().position(|j| j.number == number) else {
		return;
	};
	vp.jobs.list.remove(i);
	if vp.jobs.current == Some(number) {
		vp.jobs.current = vp.jobs.previous;
		vp.jobs.previous = None;
	}
	if vp.jobs.previous == Some(number) || vp.jobs.previous.is_none() {
		vp.jobs.previous = zsh_prevjob(vp);
	}
}

/// zsh `setprevjob`: the newest stopped job other than the current one,
/// else the newest other job.
pub fn zsh_prevjob(vp: &Vproc) -> Option<u32> {
	let current = vp.jobs.current;
	let mut other = None;
	for j in vp.jobs.list.iter().rev() {
		if Some(j.number) == current || j.inherited {
			continue;
		}
		if matches!(j.state, JobState::Stopped(_)) {
			return Some(j.number);
		}
		other = other.or(Some(j.number));
	}
	other
}

/// Before each prompt (zsh `preprompt` → `scanjobs` when `notify` is off;
/// with it, only what was not printed yet): report every job whose state
/// changed since it was last reported, and forget the finished ones.
/// Called by the interactive reader.
pub fn notices_before_prompt(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if !jobbing(k, cx) {
		return;
	}
	let platform = k.engine.config().platform;
	// zsh reports what `update_job` marked changed: stops and ends.
	let changed: Vec<u32> = vp
		.jobs
		.iter()
		.filter(|j| !j.notified && !j.inherited && j.state != JobState::Running)
		.map(|j| j.number)
		.collect();
	let how = JobLine { pid: long_list(k, cx, vp), ..JobLine::default() };
	for number in changed {
		report(k, vp, number, platform, how);
	}
}

/// A background job whose `[n] pid…` line waits for its pids to settle:
/// the interactive shell reads its next line only after printing it (zsh
/// prints it right after the fork).
pub fn announce_wait(k: &Kernel) -> Option<Vpid> {
	k.jobctl
		.announce
		.iter()
		.find(|a| a.pids.iter().any(|(_, pid)| pid.is_none()))
		.map(|a| a.job)
}

/// The process vproc `vproc` decides is known by its pid now (its OS pid
/// `os`, else its virtual pid): once every process of its job is, the
/// job's `[n] pid…` line goes to the shell's terminal (zsh `spawnjob`
/// prints it right after the fork, to `shout`).
pub fn bang_settled(k: &mut Kernel, vproc: Vpid, os: Option<u32>) {
	let found = k.jobctl.announce.iter_mut().enumerate().find_map(|(i, a)| {
		let entry = a
			.pids
			.iter_mut()
			.find(|(v, pid)| *v == vproc && pid.is_none())?;
		entry.1 = Some(os.unwrap_or(vproc.0));
		Some(i)
	});
	if let Some(i) = found {
		print_settled(k, i);
	}
}

/// Print announcement `i`'s line once all its pids settled.
fn print_settled(k: &mut Kernel, i: usize) {
	let Some(pids) = k.jobctl.announce[i]
		.pids
		.iter()
		.map(|&(_, pid)| pid)
		.collect::<Option<Vec<u32>>>()
	else {
		return;
	};
	let number = k.jobctl.announce.swap_remove(i).number;
	if let Some(tty) = &k.jobctl.shtty {
		let mut line = format!("[{number}]");
		for pid in pids {
			let _ = write!(line, " {pid}");
		}
		line.push('\n');
		write_all(tty, line.as_bytes());
	}
}

/// The lowest fd ≥ `from` a `{var}` redirection or a module opens: in a zsh
/// with its terminal open, fd 10 is the terminal's (zsh `movefd` puts
/// `SHTTY` there), so the first one handed out is 11.
pub fn lowest_free_fd(k: &Kernel, vp: &Vproc, from: i32) -> i32 {
	let fd = vp.fds.lowest_free(from);
	if fd == 10 && k.jobctl.shtty.is_some() && vp.mode.dialect() == Dialect::Zsh {
		vp.fds.lowest_free(11)
	} else {
		fd
	}
}

/// The number of jobs in `vp`'s table (prompt `%j`, `\j`).
pub fn job_count(vp: &Vproc) -> usize {
	vp.jobs.iter().filter(|j| !j.inherited).count()
}

/// zsh `zexit`'s check before an interactive shell leaves (`exit`,
/// `logout`, end of input): with jobs left (stopped ones; running ones too
/// under `checkrunningjobs`) and `checkjobs` set, warn `you have suspended
/// jobs.` and stay; the next command clears the warning, so an `exit`
/// right after it leaves. bash: `There are stopped jobs.` (running ones
/// under `shopt -s checkjobs`). `true`: the shell must not exit now.
pub fn check_before_exit(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> bool {
	if vp.parent.is_some() || !k.jobctl.interactive || k.jobctl.stopmsg > 0 || !jobbing(k, cx) {
		return false;
	}
	notices_before_prompt(k, cx, vp);
	let zsh = vp.mode.dialect() == Dialect::Zsh;
	let (check, running) = if zsh {
		(
			state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Checkjobs).unwrap_or(false),
			state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Checkrunningjobs).unwrap_or(false),
		)
	} else {
		(true, state::option(&mut k.root, cx.store, vp, OptId::Checkjobs).unwrap_or(false))
	};
	if !check {
		return false;
	}
	let found = vp.jobs.iter().find(|j| {
		!j.inherited
			&& match j.state {
				JobState::Stopped(_) => true,
				JobState::Running => running,
				JobState::Done(_) => false,
			}
	});
	let Some(stopped) = found.map(|j| matches!(j.state, JobState::Stopped(_))) else {
		return false;
	};
	let msg: &[u8] = match (zsh, stopped) {
		(true, true) => b"zsh: you have suspended jobs.\n",
		(true, false) => b"zsh: you have running jobs.\n",
		(false, true) => b"There are stopped jobs.\n",
		(false, false) => b"There are running jobs.\n",
	};
	vp.out
		.push_back(PendingWrite { fd: 2, bytes: BString::from(msg), off: 0 });
	k.jobctl.stopmsg = 2;
	true
}

/// zsh `bin_suspend` in a shell doing job control: stop ignoring the
/// terminal stop signals, give the terminal back to the group the shell
/// came from (`release_pgrp`), stop with `SIGTSTP` to that group, and when
/// continued take the terminal over again (`acquire_pgrp`). `false` without
/// job control (the caller stops the shell as a plain process).
pub fn suspend_shell(k: &mut Kernel, cx: &mut Cx<'_>) -> bool {
	let Some(pgrp) = k.jobctl.pgrp else {
		return false;
	};
	let stops = [Signal::Ttin, Signal::Tstp, Signal::Ttou];
	for sig in stops {
		let _ = cx.host.set_signal_trap(sig, None);
	}
	if pgrp.orig != pgrp.mine
		&& pgrp.orig > 0
		&& let Some(h) = k.jobctl.handle
		&& let Some(term) = cx.host.terminal()
	{
		let _ = term.set_foreground(h, pgrp.orig);
		let _ = term.set_process_group(0, pgrp.orig);
	}
	let _ = cx.host.signal_process(-pgrp.orig, Some(Signal::Tstp));
	k.jobctl.pgrp = None;
	if acquire(k, cx) {
		for sig in stops {
			let _ = cx.host.set_signal_trap(sig, Some(BStr::new(b"")));
		}
	}
	true
}

/// `jobs` listed the jobs: an `exit` right after leaves without the
/// warning (zsh `bin_fg`: `stopmsg = 2`).
pub const fn jobs_listed(k: &mut Kernel) {
	k.jobctl.stopmsg = 2;
}

/// The interactive root read a command: an earlier `exit` warning wears
/// off (zsh `loop`: `if (stopmsg) stopmsg--`).
pub const fn command_read(k: &mut Kernel) {
	k.jobctl.stopmsg = k.jobctl.stopmsg.saturating_sub(1);
}

/// zsh `SHTTY`: the shell's terminal, as an engine fd object (the line
/// editor reads keys from and draws on it).
pub fn shtty_file(k: &Kernel) -> Option<FdRef> {
	k.jobctl.shtty.clone()
}

/// The shell's terminal modes (zsh `shttyinfo`): what the line editor
/// starts from and puts back, and what a stopped job's leave is replaced
/// with.
pub const fn shell_modes(k: &Kernel) -> Option<&Termios> {
	k.jobctl.modes.as_ref()
}

/// Replace the shell's terminal modes (zsh `gettyinfo(&shttyinfo)` by the
/// line editor).
pub fn set_shell_modes(k: &mut Kernel, modes: Termios) {
	k.jobctl.modes = Some(modes);
}

/// The terminal `read -k`/`-q` reads keys from (zsh `bin_read`): a `zpty`
/// command's own terminal in its session, else `SHTTY`, opened now when
/// the shell has none yet (zsh opens `/dev/tty`). `None`: no terminal.
pub fn key_terminal(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> Option<FdRef> {
	if let Some(ctty) = session_terminal(vp) {
		return Some(ctty);
	}
	open_shtty(k, cx);
	shtty_file(k)
}

/// [`key_terminal`] when already open (what a [`super::proc::Probe::Input`]
/// of [`super::proc::Probe::TERMINAL_FD`] reads).
pub fn open_key_terminal(k: &Kernel, vp: &Vproc) -> Option<FdRef> {
	session_terminal(vp).or_else(|| shtty_file(k))
}

/// A `zpty` command's terminal ([`super::proc::VprocZsh::ctty`]).
fn session_terminal(vp: &Vproc) -> Option<FdRef> {
	vp.zsh.as_deref().and_then(|z| z.ctty.0.clone())
}

/// zsh `setcbreak` on `tty` for `read -k`/`-q`: no line editing, a read
/// returns each key (echo stays). The terminal's modes before it are kept
/// for [`end_cbreak`].
pub fn set_cbreak(k: &mut Kernel, cx: &mut Cx<'_>, tty: &FdRef) {
	let (Some(h), Some(term)) = (tty.os_handle(), cx.host.terminal()) else {
		return;
	};
	let Ok(cur) = term.attrs(h) else {
		return;
	};
	let mut ti = cur.clone();
	ti.set(TermFlag::Icanon, false);
	ti.min = 1;
	ti.time = 0;
	k.jobctl.cbreak = Some((tty.clone(), cur));
	let _ = term.set_attrs(h, &ti, SetWhen::Drain);
}

/// After [`set_cbreak`]: its terminal back to the modes it had (zsh
/// `settyinfo`), the shell's own or a `zpty` command's. Also when the
/// read is abandoned ([`interrupt`]): the terminal does not stay in
/// cbreak mode.
pub fn end_cbreak(k: &mut Kernel, cx: &mut Cx<'_>) {
	if let Some((tty, modes)) = k.jobctl.cbreak.take()
		&& let (Some(h), Some(term)) = (tty.os_handle(), cx.host.terminal())
	{
		let _ = term.set_attrs(h, &modes, SetWhen::Drain);
	}
}

impl Shell {
	/// Apply what job control saw during the turn: children of a suspended
	/// job join it, stops and continues of jobs reach the job tables (a
	/// stop of the shell's own foreground job suspends it, [`suspend`]; of
	/// the job `fg` resumed, gives the terminal back and ends the `fg`),
	/// and settled background jobs get their `[n] pid` line.
	pub(super) fn job_events(&mut self, cx: &mut Cx<'_>) {
		let jc = &self.k.jobctl;
		if jc.events.is_empty() && jc.reparent.is_empty() {
			return;
		}
		for (child, job) in std::mem::take(&mut self.k.jobctl.reparent) {
			for i in 0..self.procs.len() {
				if self.procs[i].vpid == child {
					self.procs[i].parent = Some(job);
				}
				if self.below(self.procs[i].vpid, child) {
					set_leader(&mut self.k, self.procs[i].vpid, Some(job));
				}
			}
		}
		let platform = self.k.engine.config().platform;
		for (vpid, ev) in std::mem::take(&mut self.k.jobctl.events) {
			let Some(leader) = leader_of(&self.k, vpid) else {
				continue;
			};
			// A stop already undone (the job was continued before this turn
			// saw it) is not reported.
			if matches!(ev, ProcEvent::Stopped(_)) && !self.ext_stopped(vpid) {
				continue;
			}
			match ev {
				ProcEvent::Stopped(sig) if Some(leader) == self.k.jobctl.root => {
					self.k.jobctl.fg_stop = Some(sig);
					if let Some(root) = self.procs.iter_mut().find(|p| p.parent.is_none()) {
						root.blocked = None;
					}
					self.k.ctl.notify();
				},
				ProcEvent::Stopped(sig) => {
					// Every process of a stopped job reports; the job stops once.
					let already = self.procs.iter().any(|p| {
						p.jobs
							.by_vpid(leader)
							.is_some_and(|j| !j.inherited && matches!(j.state, JobState::Stopped(_)))
					});
					if already {
						continue;
					}
					let fg = self.k.jobctl.fg == Some(leader);
					if let Some(p) = self.procs.iter_mut().find(|p| p.vpid == leader) {
						p.stopped = true;
					}
					self.job_changed(cx, leader, Some(sig));
					let Some(owner) = self
						.procs
						.iter()
						.position(|p| p.jobs.by_vpid(leader).is_some_and(|j| !j.inherited))
					else {
						continue;
					};
					let number = self.procs[owner].jobs.by_vpid(leader).map(|j| j.number);
					let Some(number) = number else {
						continue;
					};
					if fg {
						reclaim(&mut self.k, cx, Some(leader), false);
						let mut line = Vec::new();
						if sig == Signal::Tstp {
							line.push(b'\n');
						}
						let pid = long_list(&mut self.k, cx, &self.procs[owner]);
						let how = JobLine { thisfmt: true, pid, ..JobLine::default() };
						if let Some(text) = format_job(&self.procs[owner], number, how, platform) {
							line.extend_from_slice(&text);
						}
						notice(&self.k, &mut self.procs[owner], &line);
						if let Some(job) = self.procs[owner].jobs.get_mut(number) {
							job.notified = true;
						}
					} else if state::option(
						&mut self.k.root,
						cx.store,
						&self.procs[owner],
						OptId::Notify,
					)
					.unwrap_or(false)
					{
						report_async(&mut self.k, cx, &mut self.procs[owner], number, platform);
					}
					// The `fg` waiting for it returns; a `wait` for it ends (a stop
					// ends a wait with job control).
					self.procs[owner].blocked = None;
					self.k.ctl.notify();
				},
				ProcEvent::Continued => self.job_changed(cx, leader, None),
				ProcEvent::Exited(_) => {},
			}
		}
	}

	/// Whether the program vproc `vpid` waits for is stopped now (`true`
	/// when it cannot be told).
	#[cfg(unix)]
	fn ext_stopped(&self, vpid: Vpid) -> bool {
		let Some(p) = self.procs.iter().find(|p| p.vpid == vpid) else {
			return true;
		};
		let pid = p
			.frames
			.iter()
			.rev()
			.find_map(|f| match f.scratch.as_deref().map(|sc| &sc.live) {
				Some(super::proc::Live::Ext(ext)) => Some(ext.pid()),
				_ => None,
			});
		let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) else {
			return true;
		};
		crate::sys::proc::info(pid)
			.is_none_or(|info| info.state == crate::sys::proc::ProcState::Stopped)
	}

	/// Windows has no process-table state to recheck: a reported stop stands.
	#[cfg(not(unix))]
	#[expect(clippy::unused_self, reason = "the Unix variant reads the vprocs")]
	const fn ext_stopped(&self, _vpid: Vpid) -> bool {
		true
	}

	/// Whether vproc `v` is `ancestor` or below it.
	fn below(&self, mut v: Vpid, ancestor: Vpid) -> bool {
		loop {
			if v == ancestor {
				return true;
			}
			let Some(parent) = self
				.procs
				.iter()
				.find(|p| p.vpid == v)
				.and_then(|p| p.parent)
			else {
				return false;
			};
			v = parent;
		}
	}

	/// The interactive shell is leaving (zsh `zexit`): under `hup`, running
	/// jobs get `SIGHUP` (`warning: N jobs SIGHUPed`; stopped ones are
	/// hung up by the system when the shell's session goes), and the
	/// terminal goes back to the process group the shell came from
	/// (`release_pgrp`). The process host calls it once before it exits.
	pub fn leave_job_control(&mut self, cx: &mut Cx<'_>) {
		let Some(pgrp) = self.k.jobctl.pgrp else {
			return;
		};
		let Some(i) = self.procs.iter().position(|p| p.parent.is_none()) else {
			return;
		};
		let zsh = self.procs[i].mode.dialect() == Dialect::Zsh;
		let hup = zsh
			&& state::zsh_option(&mut self.k.root, cx.store, &self.procs[i], ZshOpt::Hup)
				.unwrap_or(false)
			&& jobbing(&mut self.k, cx);
		if hup {
			let targets: Vec<u32> = self.procs[i]
				.jobs
				.iter()
				.filter(|j| !j.inherited && !j.nohup && j.state == JobState::Running)
				.filter_map(|j| group(&self.k, j.vpid))
				.collect();
			let mut killed = 0;
			for pgid in targets {
				if let Ok(pgid) = i32::try_from(pgid)
					&& pgid != pgrp.mine
					&& cx.host.signal_process(-pgid, Some(Signal::Hup)).is_ok()
				{
					killed += 1;
				}
			}
			if killed > 0 {
				// The shell is leaving: written now, not queued.
				let line = format!("zsh: warning: {killed} jobs SIGHUPed\n");
				write_all(&self.procs[i].fds.handle(2), line.as_bytes());
			}
		}
		if pgrp.orig != pgrp.mine
			&& pgrp.orig > 0
			&& let Some(h) = self.k.jobctl.handle
			&& let Some(term) = cx.host.terminal()
		{
			let _ = term.set_foreground(h, pgrp.orig);
			let _ = term.set_process_group(0, pgrp.orig);
		}
		self.k.jobctl.pgrp = None;
	}
}
