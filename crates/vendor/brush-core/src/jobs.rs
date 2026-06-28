//! Job management

use std::{collections::VecDeque, fmt::Display, time::Duration};

#[cfg(windows)]
use std::os::windows::io::OwnedHandle;

use futures::FutureExt;

use crate::{ExecutionResult, error, processes, sys, trace_categories, traps};

pub(crate) type JobJoinHandle = tokio::task::JoinHandle<Result<ExecutionResult, error::Error>>;
pub(crate) type JobResult = (Job, Result<ExecutionResult, error::Error>);

const WAIT_NEXT_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Selects a managed job by shell job ID or child process ID.
#[derive(Clone, Copy)]
pub enum JobSelector {
	/// Shell-internal job ID.
	JobId(usize),
	/// Child process ID.
	ProcessId(i32),
}

/// Result returned when waiting for a single managed job.
pub struct WaitedJob {
	/// Shell-internal job ID.
	pub id: usize,
	/// Process ID when known, otherwise the shell-internal job ID.
	pub identifier: String,
	/// Command line associated with the job.
	pub command_line: String,
	/// Exit status returned by the job.
	pub result: ExecutionResult,
}

impl WaitedJob {
	fn from_job(job: Job, result: ExecutionResult, identifier: String) -> Self {
		Self { id: job.id, identifier, command_line: job.command_line, result }
	}
}

/// Manages the jobs that are currently managed by the shell.
#[derive(Default)]
pub struct JobManager {
	/// The jobs that are currently managed by the shell.
	pub jobs: Vec<Job>,
}

/// Represents a task that is part of a job.
pub enum JobTask {
	/// An external process.
	External(processes::ChildProcess),
	/// An internal asynchronous task.
	Internal(JobJoinHandle),
}

/// Represents the result of waiting on a job task.
pub enum JobTaskWaitResult {
	/// The task has completed.
	Completed(ExecutionResult),
	/// The task was stopped.
	Stopped,
}

impl JobTask {
	/// Returns whether the task is an external process.
	pub const fn is_external(&self) -> bool {
		matches!(self, Self::External(_))
	}

	/// Waits for the task to complete. Returns the result of the wait.
	pub async fn wait(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<JobTaskWaitResult, error::Error> {
		match self {
			Self::External(process) => loop {
				let wait_result = process.wait(None).await?;
				match wait_result {
					processes::ProcessWaitResult::Completed(output) => {
						break Ok(JobTaskWaitResult::Completed(output.into()));
					},
					processes::ProcessWaitResult::Stopped if wait_for_terminate => {},
					processes::ProcessWaitResult::Stopped => break Ok(JobTaskWaitResult::Stopped),
					processes::ProcessWaitResult::Cancelled => {
						break Ok(JobTaskWaitResult::Completed(ExecutionResult::new(130)));
					},
				}
			},
			Self::Internal(handle) => Ok(JobTaskWaitResult::Completed(handle.await??)),
		}
	}

	/// Polls the task for completion. Returns `Some(result)` if the task has
	/// completed, or `None` if it is still running. The result is the execution
	/// result of the task. Behaves in a best-effort manner; if an internal
	/// error occurs during polling, it will return `None`.
	fn poll(&mut self) -> Option<Result<ExecutionResult, error::Error>> {
		match self {
			Self::External(process) => {
				let check_result = process.poll();
				check_result.map(|polled_result| polled_result.map(|output| output.into()))
			},
			Self::Internal(handle) => {
				let checkable_handle = handle;
				checkable_handle.now_or_never().and_then(|r| r.ok())
			},
		}
	}
}

impl JobManager {
	/// Returns a new job manager.
	pub fn new() -> Self {
		Self::default()
	}

	/// Adds a job to the job manager and marks it as the current job;
	/// returns an immutable reference to the job.
	///
	/// # Arguments
	///
	/// * `job` - The job to add.
	#[allow(clippy::missing_panics_doc, reason = "push() guarantees the vector length is >= 1")]
	pub fn add_as_current(&mut self, mut job: Job) -> &Job {
		for j in &mut self.jobs {
			if matches!(j.annotation, JobAnnotation::Current) {
				j.annotation = JobAnnotation::Previous;
				break;
			}
		}

		let id = self.jobs.len() + 1;
		job.id = id;
		job.annotation = JobAnnotation::Current;
		self.jobs.push(job);

		#[allow(clippy::unwrap_used, reason = "we just pushed an element")]
		self.jobs.last().unwrap()
	}

	/// Returns the current job, if there is one.
	pub fn current_job(&self) -> Option<&Job> {
		self
			.jobs
			.iter()
			.find(|j| matches!(j.annotation, JobAnnotation::Current))
	}

	/// Returns a mutable reference to the current job, if there is one.
	pub fn current_job_mut(&mut self) -> Option<&mut Job> {
		self
			.jobs
			.iter_mut()
			.find(|j| matches!(j.annotation, JobAnnotation::Current))
	}

	/// Returns the previous job, if there is one.
	pub fn prev_job(&self) -> Option<&Job> {
		self
			.jobs
			.iter()
			.find(|j| matches!(j.annotation, JobAnnotation::Previous))
	}

	/// Returns a mutable reference to the previous job, if there is one.
	pub fn prev_job_mut(&mut self) -> Option<&mut Job> {
		self
			.jobs
			.iter_mut()
			.find(|j| matches!(j.annotation, JobAnnotation::Previous))
	}

	/// Tries to resolve the given job specification to a job.
	///
	/// # Arguments
	///
	/// * `job_spec` - The job specification to resolve.
	pub fn resolve_job_spec(&mut self, job_spec: &str) -> Option<&mut Job> {
		let remainder = job_spec.strip_prefix('%')?;

		match remainder {
			"%" | "+" => self.current_job_mut(),
			"-" => self.prev_job_mut(),
			s if s.chars().all(char::is_numeric) => {
				let id = s.parse::<usize>().ok()?;
				self.jobs.iter_mut().find(|j| j.id == id)
			},
			_ => {
				tracing::warn!(target: trace_categories::UNIMPLEMENTED, "unimplemented: job spec naming command: '{job_spec}'");
				None
			},
		}
	}

	/// Tries to resolve the given job specification to a wait selector.
	///
	/// # Arguments
	///
	/// * `job_spec` - The job specification to resolve.
	pub fn resolve_job_spec_selector(&self, job_spec: &str) -> Option<JobSelector> {
		let remainder = job_spec.strip_prefix('%')?;

		match remainder {
			"%" | "+" => self.current_job().map(|job| JobSelector::JobId(job.id)),
			"-" => self.prev_job().map(|job| JobSelector::JobId(job.id)),
			s if s.chars().all(char::is_numeric) => {
				let id = s.parse::<usize>().ok()?;
				self
					.jobs
					.iter()
					.any(|job| job.id == id)
					.then_some(JobSelector::JobId(id))
			},
			_ => {
				tracing::warn!(target: trace_categories::UNIMPLEMENTED, "unimplemented: job spec naming command: '{job_spec}'");
				None
			},
		}
	}

	/// Returns whether a managed job contains the given process ID.
	pub fn contains_process_id(&self, pid: i32) -> bool {
		self.jobs.iter().any(|job| job.contains_process_id(pid))
	}

	/// Tries to resolve the given process ID to a managed job.
	///
	/// # Arguments
	///
	/// * `pid` - The process ID to resolve.
	pub fn resolve_process_id(&mut self, pid: i32) -> Option<&mut Job> {
		self.jobs.iter_mut().find(|job| job.contains_process_id(pid))
	}

	/// Waits for all managed jobs to complete.
	pub async fn wait_all(&mut self) -> Result<Vec<Job>, error::Error> {
		self.wait_all_with_policy(false).await
	}

	/// Waits for all managed jobs to terminate, ignoring stopped-state changes.
	pub async fn wait_all_for_termination(&mut self) -> Result<Vec<Job>, error::Error> {
		self.wait_all_with_policy(true).await
	}

	async fn wait_all_with_policy(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<Vec<Job>, error::Error> {
		for job in &mut self.jobs {
			job.wait_with_policy(wait_for_terminate).await?;
		}

		Ok(self.sweep_completed_jobs())
	}

	/// Waits for the next matching managed job to complete.
	pub async fn wait_next(
		&mut self,
		selectors: &[JobSelector],
	) -> Result<Option<WaitedJob>, error::Error> {
		loop {
			let mut found_candidate = false;
			let mut i = 0;
			while i != self.jobs.len() {
				if !selectors.is_empty()
					&& !selectors
						.iter()
						.any(|selector| self.jobs[i].matches_selector(*selector))
				{
					i += 1;
					continue;
				}

				found_candidate = true;
				let identifier = self.jobs[i].wait_identifier();
				if let Some(result) = self.jobs[i].poll_done()? {
					let job = self.jobs.remove(i);
					return result.map(|result| Some(WaitedJob::from_job(job, result, identifier)));
				}
				if matches!(self.jobs[i].state, JobState::Done) {
					let job = self.jobs.remove(i);
					return Ok(Some(WaitedJob::from_job(
						job,
						ExecutionResult::success(),
						identifier,
					)));
				}
				i += 1;
			}

			if !found_candidate {
				return Ok(None);
			}

			tokio::time::sleep(WAIT_NEXT_POLL_INTERVAL).await;
		}
	}

	/// Polls all managed jobs for completion.
	pub fn poll(&mut self) -> Result<Vec<JobResult>, error::Error> {
		let mut results = vec![];

		let mut i = 0;
		while i != self.jobs.len() {
			if let Some(result) = self.jobs[i].poll_done()? {
				let job = self.jobs.remove(i);
				results.push((job, result));
			} else if matches!(self.jobs[i].state, JobState::Done) {
				// TODO(jobs): This is a workaround to remove jobs that are done but for which
				// we don't know what happened.
				results.push((self.jobs.remove(i), Ok(ExecutionResult::success())));
			} else {
				i += 1;
			}
		}

		Ok(results)
	}

	fn sweep_completed_jobs(&mut self) -> Vec<Job> {
		let mut completed_jobs = vec![];

		let mut i = 0;
		while i != self.jobs.len() {
			if self.jobs[i].tasks.is_empty() {
				completed_jobs.push(self.jobs.remove(i));
			} else {
				i += 1;
			}
		}

		completed_jobs
	}
}

/// Represents the current execution state of a job.
#[derive(Clone)]
pub enum JobState {
	/// Unknown state.
	Unknown,
	/// The job is running.
	Running,
	/// The job is stopped.
	Stopped,
	/// The job has completed.
	Done,
}

impl Display for JobState {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Unknown => write!(f, "Unknown"),
			Self::Running => write!(f, "Running"),
			Self::Stopped => write!(f, "Stopped"),
			Self::Done => write!(f, "Done"),
		}
	}
}

/// Represents an annotation for a job.
#[derive(Clone)]
pub enum JobAnnotation {
	/// No annotation.
	None,
	/// The job is the current job.
	Current,
	/// The job is the previous job.
	Previous,
}

impl Display for JobAnnotation {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::None => write!(f, ""),
			Self::Current => write!(f, "+"),
			Self::Previous => write!(f, "-"),
		}
	}
}

/// Encapsulates a set of processes managed by the shell as a single unit.
pub struct Job {
	/// The tasks that make up the job.
	tasks: VecDeque<JobTask>,

	/// If available, the process group ID of the job's processes.
	pgid: Option<sys::process::ProcessId>,

	/// The annotation of the job (e.g., current, previous).
	annotation: JobAnnotation,

	/// The shell-internal ID of the job.
	pub id: usize,

	/// The command line of the job.
	pub command_line: String,

	/// The current operational state of the job.
	pub state: JobState,
}

impl Display for Job {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(
			f,
			"[{}]{:3}{}\t{}",
			self.id,
			self.annotation.to_string(),
			self.state,
			self.command_line
		)
	}
}

impl Job {
	/// Returns a new job object.
	///
	/// # Arguments
	///
	/// * `children` - The job's known child processes.
	/// * `command_line` - The command line of the job.
	/// * `state` - The current operational state of the job.
	pub(crate) fn new<I>(tasks: I, command_line: String, state: JobState) -> Self
	where
		I: IntoIterator<Item = JobTask>,
	{
		Self {
			id: 0,
			tasks: tasks.into_iter().collect(),
			pgid: None,
			annotation: JobAnnotation::None,
			command_line,
			state,
		}
	}

	/// Returns a pid-style string for the job.
	pub fn to_pid_style_string(&self) -> String {
		let display_pid = self
			.representative_pid()
			.map_or_else(|| String::from("<pid unknown>"), |pid| pid.to_string());
		std::format!("[{}]{}\t{}", self.id, self.annotation, display_pid)
	}

	/// Returns the annotation of the job.
	pub fn annotation(&self) -> JobAnnotation {
		self.annotation.clone()
	}

	/// Returns the command name of the job.
	pub fn command_name(&self) -> &str {
		self
			.command_line
			.split_ascii_whitespace()
			.next()
			.unwrap_or_default()
	}

	/// Returns whether the job is the current job.
	pub const fn is_current(&self) -> bool {
		matches!(self.annotation, JobAnnotation::Current)
	}

	/// Returns whether the job is the previous job.
	pub const fn is_prev(&self) -> bool {
		matches!(self.annotation, JobAnnotation::Previous)
	}

	/// Polls whether the job has completed.
	pub fn poll_done(
		&mut self,
	) -> Result<Option<Result<ExecutionResult, error::Error>>, error::Error> {
		let mut result: Option<Result<ExecutionResult, error::Error>> = None;

		tracing::debug!(target: trace_categories::JOBS, "Polling job {} for completion...", self.id);

		while !self.tasks.is_empty() {
			let task = &mut self.tasks[0];
			match task.poll() {
				Some(r) => {
					self.tasks.remove(0);
					result = Some(r);
				},
				None => {
					return Ok(None);
				},
			}
		}

		tracing::debug!(target: trace_categories::JOBS, "Job {} has completed.", self.id);

		self.state = JobState::Done;

		Ok(result)
	}

	/// Waits for the job to complete.
	pub async fn wait(&mut self) -> Result<ExecutionResult, error::Error> {
		self.wait_with_policy(false).await
	}

	/// Waits for the job to terminate, ignoring stopped-state changes.
	pub async fn wait_for_termination(&mut self) -> Result<ExecutionResult, error::Error> {
		self.wait_with_policy(true).await
	}

	async fn wait_with_policy(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<ExecutionResult, error::Error> {
		let mut result = ExecutionResult::success();

		while let Some(task) = self.tasks.back_mut() {
			match task.wait(wait_for_terminate).await? {
				JobTaskWaitResult::Completed(execution_result) => {
					result = execution_result;
					self.tasks.pop_back();
				},
				JobTaskWaitResult::Stopped => {
					self.state = JobState::Stopped;
					return Ok(ExecutionResult::stopped());
				},
			}
		}

		self.state = JobState::Done;

		Ok(result)
	}

	/// Moves the job to execute in the background.
	pub fn move_to_background(&mut self) -> Result<(), error::Error> {
		match &self.state {
			JobState::Stopped => {
				let pgid = self
					.process_group_id()
					.ok_or(error::ErrorKind::FailedToSendSignal)?;
				sys::signal::continue_process(pgid)?;
				self.state = JobState::Running;
				Ok(())
			},
			JobState::Running => Ok(()),
			JobState::Unknown | JobState::Done => Err(error::ErrorKind::FailedToSendSignal.into()),
		}
	}

	/// Moves the job to execute in the foreground.
	pub fn move_to_foreground(&mut self) -> Result<(), error::Error> {
		if matches!(self.state, JobState::Stopped) {
			if let Some(pgid) = self.process_group_id() {
				sys::signal::continue_process(pgid)?;
				self.state = JobState::Running;
			} else {
				return Err(error::ErrorKind::FailedToSendSignal.into());
			}
		}

		if let Some(pgid) = self.process_group_id() {
			sys::terminal::move_to_foreground(pgid)?;
		}

		Ok(())
	}

	/// Kills the job.
	///
	/// # Arguments
	///
	/// * `signal` - The signal to send to the job.
	pub fn kill(&self, signal: traps::TrapSignal) -> Result<(), error::Error> {
		if let Some(pid) = self.process_group_id() {
			sys::signal::kill_process(pid, signal)
		} else {
			Err(error::ErrorKind::FailedToSendSignal.into())
		}
	}

	/// Aborts shell-internal background tasks and drops their join handles.
	///
	/// External process jobs are intentionally left alone; callers that abort
	/// internal tasks are still responsible for signalling any process trees
	/// those tasks may have spawned.
	pub fn abort_internal_tasks(&mut self) {
		let mut aborted = false;
		self.tasks.retain_mut(|task| {
			if let JobTask::Internal(handle) = task {
				handle.abort();
				aborted = true;
				return false;
			}
			true
		});
		if aborted && self.tasks.is_empty() {
			self.state = JobState::Done;
		}
	}

	fn matches_selector(&self, selector: JobSelector) -> bool {
		match selector {
			JobSelector::JobId(id) => self.id == id,
			JobSelector::ProcessId(pid) => self.contains_process_id(pid),
		}
	}

	fn contains_process_id(&self, pid: i32) -> bool {
		self.tasks.iter().any(|task| match task {
			JobTask::External(process) => process.pid().is_some_and(|process_pid| process_pid == pid),
			JobTask::Internal(_) => false,
		})
	}

	fn wait_identifier(&self) -> String {
		self
			.representative_pid()
			.map_or_else(|| self.id.to_string(), |pid| pid.to_string())
	}

	/// Tries to retrieve a "representative" pid for the job.
	pub fn representative_pid(&self) -> Option<sys::process::ProcessId> {
		for task in &self.tasks {
			match task {
				JobTask::External(p) => {
					if let Some(pid) = p.pid() {
						return Some(pid);
					}
				},
				JobTask::Internal(_) => (),
			}
		}
		None
	}

	/// Tries to retrieve the process group ID (PGID) of the job.
	pub fn process_group_id(&self) -> Option<sys::process::ProcessId> {
		// TODO(jobs): Don't assume that the first PID is the PGID.
		self.pgid.or_else(|| self.representative_pid())
	}

	/// Duplicates process handles for termination on Windows.
	#[cfg(windows)]
	pub fn duplicate_kill_handles(&self) -> Vec<OwnedHandle> {
		self
			.tasks
			.iter()
			.filter_map(|task| match task {
				JobTask::External(process) => process.duplicate_kill_handle(),
				JobTask::Internal(_) => None,
			})
			.collect()
	}
}
