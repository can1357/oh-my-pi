//! Signal processing utilities

pub(crate) use nix::sys::signal::Signal;

use crate::{error, sys, traps};

/// What a job-control signal to the job of the process `pid` reaches, as
/// the job records it when the process starts (before any stage is reaped):
/// its process group (`-pgid`, as `kill(2)` names a group) when it is not
/// the shell's own, which also holds the stage's own children after the
/// stage has exited, as Bash's `killpg` on the job's group reaches them;
/// else the process alone.
pub(crate) fn signal_target(pid: sys::process::ProcessId) -> sys::process::ProcessId {
	let own_group = nix::unistd::getpgrp();
	match nix::unistd::getpgid(Some(nix::unistd::Pid::from_raw(pid))) {
		Ok(group) if group != own_group => -group.as_raw(),
		_ => pid,
	}
}

/// Sends SIGCONT to each of a job's `targets` (see [`signal_target`]), as
/// Bash's `start_job` and `kill_pid` continue a job with `killpg`. Fails
/// when no signal could be sent.
pub(crate) fn continue_targets(targets: &[sys::process::ProcessId]) -> Result<(), error::Error> {
	let mut sent = false;
	for &target in targets {
		sent |= nix::sys::signal::kill(nix::unistd::Pid::from_raw(target), Signal::SIGCONT).is_ok();
	}
	if sent { Ok(()) } else { Err(error::ErrorKind::FailedToSendSignal.into()) }
}

/// Whether `signal` is SIGCONT.
pub(crate) fn is_continue(signal: Signal) -> bool {
	signal == Signal::SIGCONT
}

/// Whether `signal` is SIGTERM or SIGHUP, which Bash's `kill_pid` follows
/// with SIGCONT for a stopped job.
pub(crate) fn needs_continue_when_stopped(signal: Signal) -> bool {
	matches!(signal, Signal::SIGTERM | Signal::SIGHUP)
}

/// Sends a signal to a specific process.
///
/// # Arguments
/// * `pid` - The process ID to send the signal to
/// * `signal` - The signal to send (must be a real signal, not a trap signal)
pub fn kill_process(
	pid: sys::process::ProcessId,
	signal: traps::TrapSignal,
) -> Result<(), error::Error> {
	let translated_signal = match signal {
		traps::TrapSignal::Signal(signal) => signal,
		traps::TrapSignal::Debug
		| traps::TrapSignal::Err
		| traps::TrapSignal::Exit
		| traps::TrapSignal::Return => {
			return Err(error::ErrorKind::InvalidSignal(signal.to_string()).into());
		},
	};

	nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), translated_signal)
		.map_err(|_errno| error::ErrorKind::FailedToSendSignal)?;

	Ok(())
}

/// Whether signal 0 reaches `pid` (a negative value names a process group):
/// the target exists and may be signalled.
pub(crate) fn probe_process(pid: sys::process::ProcessId) -> bool {
	nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

pub(crate) fn lead_new_process_group() -> Result<(), error::Error> {
	nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0))?;
	Ok(())
}

pub(crate) fn tstp_signal_listener() -> Result<tokio::signal::unix::Signal, error::Error> {
	let signal =
		tokio::signal::unix::signal(tokio::signal::unix::SignalKind::from_raw(nix::libc::SIGTSTP))?;
	Ok(signal)
}

pub(crate) fn chld_signal_listener() -> Result<tokio::signal::unix::Signal, error::Error> {
	let signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())?;
	Ok(signal)
}

pub(crate) use tokio::signal::ctrl_c as await_ctrl_c;

pub(crate) fn mask_sigttou() -> Result<(), error::Error> {
	let ignore = nix::sys::signal::SigAction::new(
		nix::sys::signal::SigHandler::SigIgn,
		nix::sys::signal::SaFlags::empty(),
		nix::sys::signal::SigSet::empty(),
	);

	// SAFETY:
	// Setting the signal action should be safe here. The unsafe concerns
	// for calling `sigaction` are primarily around ensuring that any provided
	// signal handler functions are only performing operations that are
	// safe to do in a signal handler context. Here we are not providing
	// a custom handler, just asking the OS to ignore the signal.
	unsafe { nix::sys::signal::sigaction(nix::sys::signal::Signal::SIGTTOU, &ignore) }?;

	Ok(())
}

/// Consumes the pending stopped-child statuses of a process or pipeline and
/// returns each stopped process with its `WSTOPSIG`, in the order of `pids`.
///
/// A pipeline's external member IDs are always checked first. A process group
/// is an additional scoped check: a detached pipe-input stage can leave the
/// recorded group while still belonging to the pipeline. The
/// `ChildProcess::wait` caller owns this state transition and reports it to
/// the job manager; `WNOWAIT` would report the same stop again after the job
/// resumes.
pub(crate) fn poll_for_stopped_processes(
	pids: &[sys::process::ProcessId],
	pgid: Option<sys::process::ProcessId>,
) -> Result<Vec<(sys::process::ProcessId, u8)>, error::Error> {
	let flags = nix::sys::wait::WaitPidFlag::WUNTRACED | nix::sys::wait::WaitPidFlag::WNOHANG;
	let mut stops = Vec::new();
	for pid in pids {
		drain_stopped(|| waitid_child(*pid, None, flags), &mut stops)?;
	}
	if let Some(pgid) = pgid {
		drain_stopped(|| waitid_child(pgid, Some(pgid), flags), &mut stops)?;
	}
	Ok(stops)
}

/// The last stop or continue a child reported.
pub(crate) enum StopOrContinue {
	/// The child stopped on this signal.
	Stopped(u8),
	/// The child continued.
	Continued,
}

/// Consumes the stops and continues `pid` reported since the last call and
/// returns the latest, or `None` when it reported neither. Exits are not
/// asked for (`WEXITED` is not set), so the child's own wait still reaps it.
pub(crate) fn poll_for_stop_or_continue(
	pid: sys::process::ProcessId,
) -> Result<Option<StopOrContinue>, error::Error> {
	let flags = nix::sys::wait::WaitPidFlag::WUNTRACED
		| nix::sys::wait::WaitPidFlag::WCONTINUED
		| nix::sys::wait::WaitPidFlag::WNOHANG;
	let mut latest = None;
	loop {
		match waitid_child(pid, None, flags) {
			Ok(nix::sys::wait::WaitStatus::Stopped(_pid, signal)) => {
				latest = Some(StopOrContinue::Stopped(u8::try_from(signal as i32).unwrap_or(u8::MAX)));
			},
			Ok(nix::sys::wait::WaitStatus::Continued(_pid)) => latest = Some(StopOrContinue::Continued),
			Ok(_) | Err(nix::errno::Errno::ECHILD) => return Ok(latest),
			Err(e) => return Err(e.into()),
		}
	}
}

/// Whether `pid` is stopped now, where the system says (`/proc` on Linux);
/// `None` elsewhere. A process that was continued and is exiting reports
/// neither a continue nor an exit for a moment; this tells its stop is over.
pub(crate) fn is_stopped(pid: sys::process::ProcessId) -> Option<bool> {
	#[cfg(target_os = "linux")]
	{
		let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
		let state = stat.rsplit_once(')')?.1.trim_start().chars().next()?;
		Some(matches!(state, 'T' | 't'))
	}
	#[cfg(not(target_os = "linux"))]
	{
		let _ = pid;
		None
	}
}

/// Whether `pid` has exited or been killed, without reaping it (`WNOWAIT`):
/// its own wait still collects the status. A stopped child that was
/// continued and has exited reports no continue any more, so this tells a
/// stop that is over from one that is not.
pub(crate) fn has_exited(pid: sys::process::ProcessId) -> bool {
	let flags = nix::sys::wait::WaitPidFlag::WEXITED
		| nix::sys::wait::WaitPidFlag::WNOWAIT
		| nix::sys::wait::WaitPidFlag::WNOHANG;
	matches!(
		waitid_child(pid, None, flags),
		Ok(nix::sys::wait::WaitStatus::Exited(..) | nix::sys::wait::WaitStatus::Signaled(..))
	)
}

fn drain_stopped(
	mut wait: impl FnMut() -> Result<nix::sys::wait::WaitStatus, nix::errno::Errno>,
	stops: &mut Vec<(sys::process::ProcessId, u8)>,
) -> Result<(), error::Error> {
	loop {
		match wait() {
			Ok(nix::sys::wait::WaitStatus::Stopped(stopped_pid, sig)) => {
				let signal = u8::try_from(sig as i32).unwrap_or(u8::MAX);
				let stopped_pid = stopped_pid.as_raw();
				match stops.iter_mut().find(|(pid, _)| *pid == stopped_pid) {
					Some(stop) => stop.1 = signal,
					None => stops.push((stopped_pid, signal)),
				}
			},
			Ok(_) | Err(nix::errno::Errno::ECHILD) => return Ok(()),
			Err(e) => return Err(e.into()),
		}
	}
}

#[cfg(not(target_os = "macos"))]
fn waitid_child(
	pid: sys::process::ProcessId,
	pgid: Option<sys::process::ProcessId>,
	flags: nix::sys::wait::WaitPidFlag,
) -> Result<nix::sys::wait::WaitStatus, nix::errno::Errno> {
	let id = match pgid {
		Some(pgid) => nix::sys::wait::Id::PGid(nix::unistd::Pid::from_raw(pgid)),
		None => nix::sys::wait::Id::Pid(nix::unistd::Pid::from_raw(pid)),
	};
	nix::sys::wait::waitid(id, flags)
}

//
// N.B. These functions were mostly copied from nix::sys::wait (https://github.com/nix-rust/nix, MIT license)
// to enable use of the `waitid` call on macOS. Ideally nix would expose it on
// macOS and we would remove this code.
//

#[cfg(target_os = "macos")]
fn waitid_child(
	pid: sys::process::ProcessId,
	pgid: Option<sys::process::ProcessId>,
	flags: nix::sys::wait::WaitPidFlag,
) -> Result<nix::sys::wait::WaitStatus, nix::errno::Errno> {
	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	// The siginfo structure is valid when filled with zeroes. Memory is zeroed
	// rather than uninitialized, as not all platforms initialize the memory in
	// the StillAlive case.
	let mut siginfo: nix::libc::siginfo_t = unsafe { std::mem::zeroed() };
	let (id_type, id) = match pgid {
		Some(pgid) => (nix::libc::P_PGID, pgid),
		None => (nix::libc::P_PID, pid),
	};

	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	nix::errno::Errno::result(unsafe {
		nix::libc::waitid(id_type, id as nix::libc::id_t, &raw mut siginfo, flags.bits())
	})?;

	siginfo_to_wait_status(siginfo)
}

#[cfg(target_os = "macos")]
fn siginfo_to_wait_status(
	siginfo: nix::libc::siginfo_t,
) -> Result<nix::sys::wait::WaitStatus, nix::errno::Errno> {
	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	let si_pid = unsafe { siginfo.si_pid() };
	if si_pid == 0 {
		return Ok(nix::sys::wait::WaitStatus::StillAlive);
	}

	let pid = nix::unistd::Pid::from_raw(si_pid);

	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	let si_status = unsafe { siginfo.si_status() };

	let status = match siginfo.si_code {
		nix::libc::CLD_EXITED => nix::sys::wait::WaitStatus::Exited(pid, si_status),
		nix::libc::CLD_KILLED | nix::libc::CLD_DUMPED => nix::sys::wait::WaitStatus::Signaled(
			pid,
			nix::sys::signal::Signal::try_from(si_status)?,
			siginfo.si_code == nix::libc::CLD_DUMPED,
		),
		nix::libc::CLD_STOPPED => {
			nix::sys::wait::WaitStatus::Stopped(pid, nix::sys::signal::Signal::try_from(si_status)?)
		},
		nix::libc::CLD_CONTINUED => nix::sys::wait::WaitStatus::Continued(pid),
		_ => return Err(nix::errno::Errno::EINVAL),
	};

	Ok(status)
}
