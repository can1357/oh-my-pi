//! Whole-job pause and exit classification for Windows Job Objects, written
//! against a small trait so the state machine is tested on every platform.
//!
//! Windows has no `SIGSTOP`: a job pauses by suspending each member process
//! (`NtSuspendProcess`) and resumes by resuming exactly the processes it
//! suspended (`NtResumeProcess`), through the handles it opened, so a pid
//! recycled in between is never touched. Pause and resume are idempotent per
//! job: several `ExtProc`s of one pipeline share the job, and the engine
//! calls `stop`/`cont` on each.

use std::io;

use crate::bash::{ExitStatus, Signal};

/// The operations a job pause needs from the OS.
pub trait JobOps {
	/// An opened member process (keeps its identity).
	type Member;
	/// The job's current members, opened for suspend/resume.
	fn members(&self) -> io::Result<Vec<Self::Member>>;
	/// Suspend one member.
	fn suspend(&self, m: &Self::Member) -> io::Result<()>;
	/// Resume one member.
	fn resume(&self, m: &Self::Member) -> io::Result<()>;
}

/// Pause state of one job.
#[derive(Debug)]
pub struct JobPause<M> {
	/// Members suspended by the current pause; `None` when running.
	suspended: Option<Vec<M>>,
}

impl<M> Default for JobPause<M> {
	fn default() -> Self {
		Self { suspended: None }
	}
}

impl<M> JobPause<M> {
	/// Whether the job is paused.
	#[cfg(test)]
	pub const fn paused(&self) -> bool {
		self.suspended.is_some()
	}

	/// Suspend every member (no-op when paused). Members that exit while
	/// being listed are skipped; the first other failure resumes what was
	/// suspended and is returned.
	pub fn pause<O: JobOps<Member = M>>(&mut self, ops: &O) -> io::Result<()> {
		if self.suspended.is_some() {
			return Ok(());
		}
		let mut done = Vec::new();
		for m in ops.members()? {
			match ops.suspend(&m) {
				Ok(()) => done.push(m),
				Err(e) if e.kind() == io::ErrorKind::NotFound => {},
				Err(e) => {
					for m in &done {
						let _ = ops.resume(m);
					}
					return Err(e);
				},
			}
		}
		self.suspended = Some(done);
		Ok(())
	}

	/// Resume exactly the members the pause suspended (no-op when running).
	/// Every member is attempted; the first failure is returned.
	pub fn resume<O: JobOps<Member = M>>(&mut self, ops: &O) -> io::Result<()> {
		let Some(done) = self.suspended.take() else {
			return Ok(());
		};
		let mut first = Ok(());
		for m in &done {
			if let Err(e) = ops.resume(m)
				&& first.is_ok()
			{
				first = Err(e);
			}
		}
		first
	}
}

/// Exit code `TerminateJobObject` gives every member when the job is killed
/// (`128 + SIGKILL`, what bash shows for a killed command).
pub const KILL_EXIT_CODE: u32 = 137;

/// `STATUS_CONTROL_C_EXIT`: the exit code of a console process ended by its
/// default `CTRL_C`/`CTRL_BREAK` handler.
pub const CONTROL_C_EXIT: u32 = 0xc000_013a;

/// Classify a Windows exit code: our own job kill reads as
/// `Signaled(KILL)`, the console-control exit as the signal we mapped to
/// `CTRL_BREAK` (`console`, else INT), anything else as a plain exit.
pub fn exit_status(code: u32, killed: bool, console: Option<Signal>) -> ExitStatus {
	match code {
		KILL_EXIT_CODE if killed => ExitStatus::Signaled(Signal::Kill),
		CONTROL_C_EXIT => ExitStatus::Signaled(console.unwrap_or(Signal::Int)),
		code => ExitStatus::Exited(code as i32),
	}
}

#[cfg(test)]
mod tests {
	use std::cell::RefCell;

	use super::*;

	/// Members 1..=n; `gone` vanish while listed; `fail` refuses suspension.
	#[derive(Default)]
	struct Fake {
		members: Vec<u32>,
		gone:    Vec<u32>,
		fail:    Option<u32>,
		count:   RefCell<std::collections::HashMap<u32, i32>>,
	}

	impl JobOps for Fake {
		type Member = u32;

		fn members(&self) -> io::Result<Vec<u32>> {
			Ok(self.members.clone())
		}

		fn suspend(&self, m: &u32) -> io::Result<()> {
			if self.gone.contains(m) {
				return Err(io::ErrorKind::NotFound.into());
			}
			if self.fail == Some(*m) {
				return Err(io::ErrorKind::PermissionDenied.into());
			}
			*self.count.borrow_mut().entry(*m).or_default() += 1;
			Ok(())
		}

		fn resume(&self, m: &u32) -> io::Result<()> {
			*self.count.borrow_mut().entry(*m).or_default() -= 1;
			Ok(())
		}
	}

	fn counts(f: &Fake) -> Vec<(u32, i32)> {
		let mut v: Vec<_> = f.count.borrow().iter().map(|(k, v)| (*k, *v)).collect();
		v.sort_unstable();
		v
	}

	#[test]
	fn pause_and_resume_are_idempotent_and_balanced() {
		let ops = Fake { members: vec![1, 2, 3], ..Fake::default() };
		let mut job = JobPause::default();
		job.pause(&ops).unwrap();
		job.pause(&ops).unwrap();
		assert!(job.paused());
		assert_eq!(counts(&ops), [(1, 1), (2, 1), (3, 1)], "second pause suspends nothing");
		job.resume(&ops).unwrap();
		job.resume(&ops).unwrap();
		assert!(!job.paused());
		assert_eq!(counts(&ops), [(1, 0), (2, 0), (3, 0)]);
	}

	#[test]
	fn members_exiting_mid_pause_are_skipped_and_never_resumed() {
		let ops = Fake { members: vec![1, 2], gone: vec![2], ..Fake::default() };
		let mut job = JobPause::default();
		job.pause(&ops).unwrap();
		job.resume(&ops).unwrap();
		assert_eq!(counts(&ops), [(1, 0)]);
	}

	#[test]
	fn a_failed_suspend_rolls_the_pause_back() {
		let ops = Fake { members: vec![1, 2, 3], fail: Some(2), ..Fake::default() };
		let mut job = JobPause::default();
		assert_eq!(job.pause(&ops).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
		assert!(!job.paused());
		assert_eq!(counts(&ops), [(1, 0)], "member 1 resumed, 3 never touched");
	}

	#[test]
	fn exit_codes_map_to_bash_statuses() {
		assert_eq!(exit_status(137, true, None), ExitStatus::Signaled(Signal::Kill));
		assert_eq!(exit_status(137, false, None), ExitStatus::Exited(137), "a real exit 137");
		assert_eq!(
			exit_status(CONTROL_C_EXIT, false, Some(Signal::Term)),
			ExitStatus::Signaled(Signal::Term)
		);
		assert_eq!(exit_status(CONTROL_C_EXIT, false, None), ExitStatus::Signaled(Signal::Int));
		assert_eq!(exit_status(3, true, None), ExitStatus::Exited(3));
	}
}
