//! Job status notification of a shell that is not interactive, as bash 5.3
//! does it (`jobs.c`: `notify_of_job_status`, `print_pipeline`,
//! `pretty_print_job`, `cleanup_dead_jobs`). A job or foreground command a
//! signal ended is reported by its processes' lines on standard error at
//! bash's notify points, then forgotten:
//!
//! - background jobs, at each input line the shell reads ([`notify`] from
//!   the command reader), when `wait` returns the job, and after `jobs`;
//! - a foreground command, when the shell's wait for it ends
//!   ([`report_foreground`]).
//!
//! The lines are bash's own: `NAME: line N: ` (as before every diagnostic)
//! then the job's processes as `jobs -l` lists them, without the `[N]+`.
//! `SIGINT`, `SIGTERM`, `SIGPIPE` (bash's
//! `DONT_REPORT_SIGTERM` and `DONT_REPORT_SIGPIPE` builds) and a signal the
//! shell traps are reported by no line: a background job they ended stays
//! in the table for `wait` and `jobs` (bash 5.3); a foreground one ended by
//! `SIGTERM` or a trapped signal is reported in `jobs`' short form.

use bstr::BString;

use super::{
	Kernel,
	proc::{Job, JobState, Vproc},
	state,
};
use crate::bash::{
	Cx, Platform,
	signal::Signal,
	store::{Death, Key, OptId, Record, TrapKey},
};

/// bash 5.3's `LONGEST_SIGNAL_DESC`: the column the command starts at after
/// a status (`print_pipeline` pads to it; a longer status overflows it).
pub const STATUS_WIDTH: usize = 27;

/// One process of a job or foreground command as bash's `PROCESS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcStatus {
	/// Still running (`PS_RUNNING`).
	Running,
	/// Exited with this status (`WIFEXITED`).
	Exited(i32),
	/// Ended by a signal (`WIFSIGNALED`).
	Signaled(Death),
	/// Stopped by this signal (`WIFSTOPPED`).
	Stopped(Signal),
}

/// A process line: pid, status and command text.
#[derive(Clone, Copy, Debug)]
pub struct ProcLine<'a> {
	/// The pid bash prints (`%5ld`).
	pub pid:    u32,
	/// Its command as bash prints it.
	pub text:   &'a [u8],
	/// How it ended, or that it runs.
	pub status: ProcStatus,
}

/// How [`print_pipeline`] prints (bash `JLIST_STANDARD` and `JLIST_LONG`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
	/// One line: the last process's status, the commands joined by ` | `.
	Standard,
	/// One line per process, each with its pid.
	Long,
}

/// The job-level facts [`print_pipeline`] needs.
#[derive(Clone, Copy, Debug)]
pub struct JobLook<'a> {
	/// The job runs (bash `RUNNING (job)`): every process shows `Running`.
	pub running:    bool,
	/// The job is stopped (bash `STOPPED (job)`).
	pub stopped:    bool,
	/// A background job: ` &` after a running one.
	pub background: bool,
	/// `posix` mode (`Done(N)`, `Stopped(SIGTSTP)`).
	pub posix:      bool,
	/// The platform's signal texts.
	pub platform:   Platform,
	/// The directory the job started in when it is not the shell's current
	/// one (`  (wd: DIR)`, already shortened by `polite_directory_format`).
	pub wd:         Option<&'a [u8]>,
}

/// bash `j_strsignal`: the text of signal number `n`.
pub fn signal_text(n: u8, platform: Platform) -> String {
	Signal::from_number(n, platform).map_or_else(
		|| format!("Unknown signal {n}"),
		|sig| sig.description(platform),
	)
}

/// bash `printable_job_status` for one process of a job.
fn status_text(st: ProcStatus, job: &JobLook<'_>, format: Format) -> String {
	if job.stopped && format == Format::Standard {
		return match st {
			ProcStatus::Stopped(sig) if job.posix => format!("Stopped(SIG{sig})"),
			_ => String::from("Stopped"),
		};
	}
	if job.running {
		return String::from("Running");
	}
	match st {
		ProcStatus::Running => String::from("Running"),
		ProcStatus::Stopped(sig) => sig.description(job.platform),
		ProcStatus::Signaled(d) => signal_text(d.signal, job.platform),
		ProcStatus::Exited(0) => String::from("Done"),
		ProcStatus::Exited(n) if job.posix => format!("Done({n})"),
		ProcStatus::Exited(n) => format!("Exit {n}"),
	}
}

const fn core(st: ProcStatus) -> bool {
	matches!(st, ProcStatus::Signaled(Death { core: true, .. }))
}

/// bash `print_pipeline`: the lines of `procs` (in pipeline order) in
/// `format`, appended to `out`. The caller writes a `jobs` listing's
/// `[N]+ ` before them.
pub fn print_pipeline(out: &mut Vec<u8>, procs: &[ProcLine<'_>], format: Format, job: &JobLook<'_>) {
	let Some((first, last)) = procs.first().zip(procs.last()) else {
		return;
	};
	let long = format == Format::Long;
	for (i, p) in procs.iter().enumerate() {
		let is_first = i == 0;
		let is_last = i + 1 == procs.len();
		if !is_first {
			out.extend_from_slice(if long { b"     " } else { b" |" });
		}
		if long {
			out.extend_from_slice(format!("{:5}", p.pid).as_bytes());
			if is_first {
				out.push(b' ');
			}
		}
		if !is_first {
			out.push(b' ');
		}
		// The status shown: each process's own (long), the last one's
		// (standard, first line only).
		if is_first || long {
			let show = if long { p } else { last };
			let mut text = status_text(show.status, job, format);
			if !is_first
				&& matches!(show.status, ProcStatus::Running) == matches!(first.status, ProcStatus::Running)
				&& show.status == first.status
			{
				text.clear();
			}
			out.extend_from_slice(text.as_bytes());
			// An empty status counts as the `| ` that follows it.
			let width = if text.is_empty() { 2 } else { text.len() };
			out.resize(out.len() + STATUS_WIDTH.saturating_sub(width), b' ');
			if core(show.status) {
				out.extend_from_slice(b"(core dumped) ");
			}
		}
		if !is_first && long {
			out.extend_from_slice(b"| ");
		}
		out.extend_from_slice(p.text);
		if is_last {
			if job.running && job.background {
				out.extend_from_slice(b" &");
			}
			if let Some(wd) = job.wd {
				out.extend_from_slice(b"  (wd: ");
				out.extend_from_slice(wd);
				out.push(b')');
			}
		}
		if long || is_last {
			out.push(b'\n');
		}
	}
}

/// The status of a job's process as [`print_pipeline`] takes it.
pub const fn job_status(job: &Job) -> ProcStatus {
	match (job.state, job.death) {
		(JobState::Running, _) => ProcStatus::Running,
		(JobState::Stopped(sig), _) => ProcStatus::Stopped(sig),
		(JobState::Done(_), Some(death)) => ProcStatus::Signaled(death),
		(JobState::Done(status), None) => ProcStatus::Exited(status),
	}
}

/// The processes of `job` as [`print_pipeline`] takes them: its stages, or
/// the job as one process.
pub fn job_procs(job: &Job) -> Vec<ProcLine<'_>> {
	match job.stages.as_deref() {
		Some(stages) if !stages.is_empty() => stages
			.iter()
			.map(|s| ProcLine {
				pid:    s.vpid.0,
				text:   &s.text,
				status: match (s.status, s.death) {
					(None, _) => ProcStatus::Running,
					(Some(_), Some(death)) => ProcStatus::Signaled(death),
					(Some(status), None) => ProcStatus::Exited(status),
				},
			})
			.collect(),
		_ => vec![ProcLine { pid: job.pid(), text: &job.text, status: job_status(job) }],
	}
}

/// The signal that ended the process `job`'s status comes from (bash
/// `raw_job_exit_status`: the last process; with `pipefail` the last one
/// that failed), if one did.
fn raw_death(job: &Job, pipefail: bool) -> Option<Death> {
	match job.stages.as_deref() {
		Some(stages) if !stages.is_empty() => {
			let raw = if pipefail {
				stages.iter().rposition(|s| s.status.is_some_and(|st| st != 0))
			} else {
				None
			}
			.unwrap_or(stages.len() - 1);
			stages[raw].death
		},
		_ => job.death,
	}
}

/// bash `signal_is_trapped`: `vp` has a trap for signal number `n`, an
/// ignored one (`trap '' SIG`) included.
fn trapped(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, n: u8) -> bool {
	let platform = k.engine.config().platform;
	let Some(sig) = Signal::from_number(n, platform) else {
		return false;
	};
	match state::record(cx.store, vp, Key::Trap(TrapKey::Signal(sig))) {
		Ok(rec) => matches!(rec, Some(Record::Trap { .. })),
		Err(err) => {
			k.fail(err);
			false
		},
	}
}

/// What bash prints for a process a signal ended (`notify_of_job_status`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Report {
	/// Its lines, with pids (`JLIST_NONINTERACTIVE`).
	Full,
	/// A foreground job's short form (`JLIST_STANDARD`): `SIGTERM` or a
	/// trapped signal.
	Short,
	/// Nothing: `SIGINT` and `SIGPIPE`; `SIGTERM` and trapped signals for a
	/// background job.
	None,
}

fn report_kind(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, death: Death, foreground: bool) -> Report {
	let platform = k.engine.config().platform;
	let is = |sig: Signal| death.signal == sig.number(platform);
	let silent_name = is(Signal::Int) || is(Signal::Pipe);
	if !silent_name && !is(Signal::Term) && !trapped(k, cx, vp, death.signal) {
		Report::Full
	} else if foreground && !silent_name {
		Report::Short
	} else {
		Report::None
	}
}

/// Queue `bytes` on `vp`'s standard error, as bash's `fprintf (stderr, …)`.
fn write_stderr(vp: &mut Vproc, bytes: Vec<u8>) {
	if !bytes.is_empty() {
		vp.queue_out(2, bytes);
	}
}

/// The `(wd: DIR)` text of a job that started in `wd` when the shell is
/// elsewhere now (bash `polite_directory_format` of the job's directory).
fn wd_note(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, wd: &[u8]) -> Option<BString> {
	if wd == vp.cwd.as_slice() {
		return None;
	}
	let home = state::lookup(&k.root, cx.store, vp, b"HOME")
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar().map(BString::from));
	Some(super::builtins::dirstack::polite(home.as_ref().map(|h| h.as_slice()), wd, false))
}

/// The lines bash prints for job `job` when it reports it.
fn job_lines(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, job: &Job, format: Format) -> Vec<u8> {
	let wd = wd_note(k, cx, vp, &job.wd);
	let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	let look = JobLook {
		running:    job.state == JobState::Running,
		stopped:    matches!(job.state, JobState::Stopped(_)),
		background: !job.foreground,
		posix,
		platform:   k.engine.config().platform,
		wd:         wd.as_ref().map(|w| w.as_slice()),
	};
	let mut out = Vec::new();
	print_pipeline(&mut out, &job_procs(job), format, &look);
	out
}

/// bash `notify_and_cleanup` in a shell that is not interactive: report
/// each job of `vp` that a signal ended and that was not reported yet
/// (`only`: just job `%only`, as `wait` and the end of a foreground wait
/// do), mark it reported, then forget the reported jobs that ended
/// (`cleanup_dead_jobs`, keeping their statuses for `wait PID`).
pub fn notify(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, only: Option<u32>, line: u32) {
	// bash `notify_and_cleanup` returns at once while the list is frozen.
	if vp.jobs_frozen() {
		return;
	}
	let pending = vp.jobs.iter().any(|j| {
		!j.notified && matches!(j.state, JobState::Done(_)) && only.is_none_or(|n| j.number == n)
	});
	if pending {
		let out = mark(k, cx, vp, only, line);
		write_stderr(vp, out);
	}
	cleanup(vp);
}

/// The marking half of [`notify`] (bash `notify_of_job_status`): returns
/// the report lines for standard error, for the caller to write in order
/// with its own output; `line` is the script line bash's prefix names.
pub fn mark(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	only: Option<u32>,
	line: u32,
) -> Vec<u8> {
	if vp.jobs_frozen() {
		return Vec::new();
	}
	let last = vp.last_bg;
	let pipefail = state::option(&mut k.root, cx.store, vp, OptId::Pipefail).unwrap_or(false);
	let numbers: Vec<u32> = vp
		.jobs
		.iter()
		.filter(|j| {
			!j.notified && matches!(j.state, JobState::Done(_)) && only.is_none_or(|n| j.number == n)
		})
		.map(|j| j.number)
		.collect();
	let mut out = Vec::new();
	for number in numbers {
		let Some(job) = vp.jobs.get(number).cloned() else {
			continue;
		};
		// A command substitution prints nothing and forgets every job that
		// ended but the one `$!` names (bash's `SUBSHELL_COMSUB` branch).
		if vp.jobs.comsub {
			if !last.is(job.vpid)
				&& let Some(j) = vp.jobs.get_mut(number)
			{
				j.notified = true;
			}
			continue;
		}
		let Some(death) = raw_death(&job, pipefail) else {
			// Exited: the top-level shell keeps it for `wait` (POSIX); a
			// subshell forgets it (bash's catch-all branch), and a foreground
			// job is done with.
			if (vp.jobs.subshell || job.foreground)
				&& let Some(j) = vp.jobs.get_mut(number)
			{
				j.notified = true;
			}
			continue;
		};
		match report_kind(k, cx, vp, death, job.foreground) {
			Report::Full => {
				out.extend(k.line_prefix(vp, line));
				out.extend(job_lines(k, cx, vp, &job, Format::Long));
				if let Some(j) = vp.jobs.get_mut(number) {
					j.notified = true;
				}
			},
			// A foreground job's short form (`SIGTERM`, a trapped signal).
			Report::Short => {
				out.extend(job_lines(k, cx, vp, &job, Format::Standard));
				if let Some(j) = vp.jobs.get_mut(number) {
					j.notified = true;
				}
			},
			// A background job is kept, not marked: `wait` and `jobs` still
			// see it. A foreground one is done with.
			Report::None => {
				if job.foreground
					&& let Some(j) = vp.jobs.get_mut(number)
				{
					j.notified = true;
				}
			},
		}
	}
	out
}

/// bash `cleanup_dead_jobs`: forget the jobs that ended and were reported
/// (and the foreground ones that ended without a signal).
pub fn cleanup(vp: &mut Vproc) {
	if !vp.jobs_frozen() {
		vp.jobs.cleanup();
	}
}

/// bash `notify_and_cleanup (job)` at the end of the wait for a foreground
/// job (a command the shell forked: an external, a subshell, a pipeline):
/// `procs` are its processes in pipeline order and `death` is the signal
/// that ended the process its status comes from (the last one; with
/// `pipefail` the last that failed), if one did; `line` is the script line
/// of the command.
pub fn report_foreground(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	procs: &[ProcLine<'_>],
	death: Option<Death>,
	line: u32,
) -> Vec<u8> {
	let Some(death) = death else {
		return Vec::new();
	};
	if vp.jobs.comsub {
		return Vec::new();
	}
	let format = match report_kind(k, cx, vp, death, true) {
		Report::Full => Format::Long,
		Report::Short => Format::Standard,
		Report::None => return Vec::new(),
	};
	let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	let look = JobLook {
		running: false,
		stopped: false,
		background: false,
		posix,
		platform: k.engine.config().platform,
		wd: None,
	};
	let mut out = if format == Format::Long { k.line_prefix(vp, line) } else { Vec::new() };
	print_pipeline(&mut out, procs, format, &look);
	out
}

/// Hold the report `bytes` of the foreground command at syntax node
/// `node` until its own redirections are undone (bash forked it: they
/// applied in the child, and bash reports on the shell's standard error).
pub fn defer_report(k: &mut Kernel, vp: &Vproc, node: u32, bytes: Vec<u8>) {
	if !bytes.is_empty() {
		k.fg_reports.insert(vp.vpid, (node, bytes));
	}
}

/// Write the report held for the command at `node`, once its redirections
/// are undone ([`defer_report`]).
pub fn flush_report(k: &mut Kernel, vp: &mut Vproc, node: u32) {
	if k.fg_reports.get(&vp.vpid).is_some_and(|(n, _)| *n == node)
		&& let Some((_, bytes)) = k.fg_reports.remove(&vp.vpid)
	{
		write_stderr(vp, bytes);
	}
}
