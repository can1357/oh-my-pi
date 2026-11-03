//! Job management for shell instances.

use std::io::Write;

use crate::{
	error, extensions,
	interp::ExecutionParameters,
	jobs::{ForegroundJob, JobNotice, JobOrigin, JobSelector, ListingContext, WaitedJob},
	results::ExecutionResult,
};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {
	/// Checks for completed jobs in the shell, reporting any changes found.
	pub fn check_for_completed_jobs(&mut self) -> Result<(), error::Error> {
		let results = self.jobs.poll()?;

		if self.options.enable_job_control {
			for (job, _result) in results {
				writeln!(self.stderr(), "{job}")?;
			}
		}

		Ok(())
	}

	/// What a `jobs` listing of this shell's jobs is printed relative to.
	pub fn job_listing_context(&self) -> ListingContext {
		ListingContext {
			cwd:   self.working_dir().to_path_buf(),
			home:  self.env_str("HOME").map(|home| home.into_owned()),
			posix: self.options.posix_mode,
		}
	}

	/// Records `command` as the one this shell last started, as Bash's
	/// `the_printed_command_except_trap` does for each simple command and
	/// each `for`, `case`, `((` and `[[` head it starts outside a trap
	/// handler. The last process of a `lastpipe` pipeline's job, the shell
	/// itself, shows it.
	pub(crate) fn note_printed_command(&mut self, command: impl std::fmt::Display) {
		use std::fmt::Write as _;
		if self.call_stack.running_trap() {
			return;
		}
		self.printed_command.clear();
		let _ = write!(self.printed_command, "{command}");
	}

	/// The command this shell last started; see
	/// [`Self::note_printed_command`].
	pub(crate) fn printed_command(&self) -> &str {
		&self.printed_command
	}

	/// Reports the jobs that ended and forgets the reported ones, as Bash's
	/// `notify_and_cleanup` does at each of its cleanup points: a job a
	/// signal ended prints its processes on standard error as `params` sees
	/// it (the shell's own, which `exec` changes, unless the command at hand
	/// redirected it), and a job that exited stays for `wait`. See
	/// [`crate::jobs::JobManager::notify_and_cleanup`].
	pub async fn notify_and_cleanup_jobs(&mut self, params: &ExecutionParameters) {
		self.notify_and_cleanup_jobs_with(params, None).await;
	}

	/// Like [`Self::notify_and_cleanup_jobs`], and also reports `foreground`,
	/// the command that just ended, which Bash holds in its job table until
	/// the end of the wait for it (`wait_for`). While the job table is frozen
	/// nothing is reported or forgotten, and `foreground` stays in the table
	/// unnotified, as Bash keeps it (see
	/// [`crate::jobs::JobManager::keep_foreground`]).
	pub(crate) async fn notify_and_cleanup_jobs_with(
		&mut self,
		params: &ExecutionParameters,
		foreground: Option<&ForegroundJob>,
	) {
		if self.jobs.is_frozen() {
			if let Some(foreground) = foreground {
				let origin = JobOrigin::of(self);
				self.jobs.keep_foreground(foreground.clone(), origin);
			}
			return;
		}
		self.jobs.settle_ended().await;
		let listing = self.job_listing_context();
		let last_async_pid = self.last_background_pid();
		let mut stderr = params.stderr(self);
		let mut notice = JobNotice::new(&mut stderr, &self.traps, listing, last_async_pid);
		self.jobs.notify_and_cleanup(&mut notice, foreground);
	}

	/// Waits for the job `selector` names, as `wait %N` and `wait PID` do,
	/// and reports the jobs that ended; see
	/// [`crate::jobs::JobManager::wait_for`].
	pub async fn wait_for_job(
		&mut self,
		selector: JobSelector,
		wait_for_terminate: bool,
		params: &ExecutionParameters,
	) -> Result<Option<ExecutionResult>, error::Error> {
		let job_control = self.options.enable_job_control;
		let listing = self.job_listing_context();
		let last_async_pid = self.last_background_pid();
		let mut stderr = params.stderr(self);
		let mut notice = JobNotice::new(&mut stderr, &self.traps, listing, last_async_pid);
		self
			.jobs
			.wait_for(selector, wait_for_terminate, job_control, &mut notice)
			.await
	}

	/// Waits for the next job among those `selectors` name to end, as
	/// `wait -n` does, and reports the jobs that ended; see
	/// [`crate::jobs::JobManager::wait_next`].
	pub async fn wait_next_job(
		&mut self,
		selectors: &[JobSelector],
		params: &ExecutionParameters,
	) -> Result<Option<WaitedJob>, error::Error> {
		let job_control = self.options.enable_job_control;
		self.jobs.settle_ended().await;
		let listing = self.job_listing_context();
		let last_async_pid = self.last_background_pid();
		let mut stderr = params.stderr(self);
		let mut notice = JobNotice::new(&mut stderr, &self.traps, listing, last_async_pid);
		self.jobs.wait_next_with_notice(selectors, job_control, &mut notice).await
	}

	/// Waits for every job, as `wait` with no operand does, and reports the
	/// jobs that ended; returns the stopped jobs it passed over (see
	/// [`crate::jobs::JobManager::wait_all_with_notice`]).
	pub async fn wait_all_jobs(
		&mut self,
		wait_for_terminate: bool,
		params: &ExecutionParameters,
	) -> Result<Vec<(usize, Option<crate::sys::process::ProcessId>)>, error::Error> {
		let job_control = self.options.enable_job_control;
		self.jobs.settle_ended().await;
		let listing = self.job_listing_context();
		let last_async_pid = self.last_background_pid();
		let mut stderr = params.stderr(self);
		let mut notice = JobNotice::new(&mut stderr, &self.traps, listing, last_async_pid);
		if wait_for_terminate {
			self
				.jobs
				.wait_all_for_termination_with_notice(job_control, &mut notice)
				.await
		} else {
			self.jobs.wait_all_with_notice(job_control, &mut notice).await
		}
	}

	/// Runs the job `id` in the foreground and waits for it, as `fg` does,
	/// and reports the jobs that ended; see
	/// [`crate::jobs::JobManager::run_in_foreground`].
	pub async fn run_job_in_foreground(
		&mut self,
		id: usize,
		take_terminal: bool,
		params: &ExecutionParameters,
	) -> Result<Option<ExecutionResult>, error::Error> {
		let listing = self.job_listing_context();
		let last_async_pid = self.last_background_pid();
		let mut stderr = params.stderr(self);
		let mut notice = JobNotice::new(&mut stderr, &self.traps, listing, last_async_pid);
		self.jobs.run_in_foreground(id, take_terminal, &mut notice).await
	}
}
