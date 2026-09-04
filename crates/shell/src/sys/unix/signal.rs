//! Signal processing utilities

use std::mem;

use nix::sys::signal;
pub(crate) use nix::sys::signal::Signal;

use crate::{error, sys, traps};

pub(crate) fn continue_process(pid: sys::process::ProcessId) -> Result<(), error::Error> {
	signal::kill(Pid::from_raw(pid), signal::SIGCONT)
		.map_err(|_errno| error::ErrorKind::FailedToSendSignal)?;
	Ok(())
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

	signal::kill(Pid::from_raw(pid), translated_signal)
		.map_err(|_errno| error::ErrorKind::FailedToSendSignal)?;

	Ok(())
}

pub(crate) fn lead_new_process_group() -> Result<(), error::Error> {
	nix::unistd::setpgid(Pid::from_raw(0), Pid::from_raw(0))?;
	Ok(())
}

pub(crate) fn tstp_signal_listener() -> Result<unix::Signal, error::Error> {
	let signal = unix::signal(SignalKind::from_raw(nix::libc::SIGTSTP))?;
	Ok(signal)
}

pub(crate) fn chld_signal_listener() -> Result<unix::Signal, error::Error> {
	let signal = unix::signal(SignalKind::child())?;
	Ok(signal)
}

use nix::{
	errno::Errno,
	sys::{
		signal::{SaFlags, SigAction, SigHandler, SigSet},
		wait,
		wait::WaitPidFlag,
	},
	unistd::Pid,
};
pub(crate) use tokio::signal::ctrl_c as await_ctrl_c;
use tokio::signal::{unix, unix::SignalKind};

pub(crate) fn mask_sigttou() -> Result<(), error::Error> {
	let ignore = SigAction::new(SigHandler::SigIgn, SaFlags::empty(), SigSet::empty());

	// SAFETY:
	// Setting the signal action should be safe here. The unsafe concerns
	// for calling `sigaction` are primarily around ensuring that any provided
	// signal handler functions are only performing operations that are
	// safe to do in a signal handler context. Here we are not providing
	// a custom handler, just asking the OS to ignore the signal.
	unsafe { signal::sigaction(signal::Signal::SIGTTOU, &ignore) }?;

	Ok(())
}

pub(crate) fn poll_for_stopped_children() -> Result<bool, error::Error> {
	let mut found_stopped = false;

	loop {
		let wait_status = waitid_all(WaitPidFlag::WUNTRACED | WaitPidFlag::WNOHANG);
		match wait_status {
			Ok(wait::WaitStatus::Stopped(_stopped_pid, _signal)) => {
				found_stopped = true;
			},
			Ok(_) => break,
			Err(Errno::ECHILD) => break,
			Err(e) => return Err(e.into()),
		}
	}

	Ok(found_stopped)
}

#[cfg(not(target_os = "macos"))]
fn waitid_all(flags: WaitPidFlag) -> Result<wait::WaitStatus, Errno> {
	wait::waitid(wait::Id::All, flags)
}

//
// N.B. These functions were mostly copied from nix::sys::wait (https://github.com/nix-rust/nix, MIT license)
// to enable use of the `waitid` call on macOS. Ideally nix would expose it on
// macOS and we would remove this code.
//

#[cfg(target_os = "macos")]
fn waitid_all(flags: WaitPidFlag) -> Result<wait::WaitStatus, Errno> {
	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	// The siginfo structure is valid when filled with zeroes. Memory is zeroed
	// rather than uninitialized, as not all platforms initialize the memory in
	// the StillAlive case.
	let mut siginfo: nix::libc::siginfo_t = unsafe { mem::zeroed() };

	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	Errno::result(unsafe {
		nix::libc::waitid(nix::libc::P_ALL, 0, &raw mut siginfo, flags.bits())
	})?;

	siginfo_to_wait_status(siginfo)
}

#[cfg(target_os = "macos")]
fn siginfo_to_wait_status(siginfo: nix::libc::siginfo_t) -> Result<wait::WaitStatus, Errno> {
	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	let si_pid = unsafe { siginfo.si_pid() };
	if si_pid == 0 {
		return Ok(wait::WaitStatus::StillAlive);
	}

	let pid = Pid::from_raw(si_pid);

	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	let si_status = unsafe { siginfo.si_status() };

	let status = match siginfo.si_code {
		nix::libc::CLD_EXITED => wait::WaitStatus::Exited(pid, si_status),
		nix::libc::CLD_KILLED | nix::libc::CLD_DUMPED => wait::WaitStatus::Signaled(
			pid,
			signal::Signal::try_from(si_status)?,
			siginfo.si_code == nix::libc::CLD_DUMPED,
		),
		nix::libc::CLD_STOPPED => {
			wait::WaitStatus::Stopped(pid, signal::Signal::try_from(si_status)?)
		},
		nix::libc::CLD_CONTINUED => wait::WaitStatus::Continued(pid),
		_ => return Err(Errno::EINVAL),
	};

	Ok(status)
}
