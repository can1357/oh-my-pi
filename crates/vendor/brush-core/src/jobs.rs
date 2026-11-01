//! Job management

use std::{
	collections::{HashMap, VecDeque},
	fmt::Display,
	sync::{
		Arc, LazyLock, Mutex, MutexGuard, PoisonError,
		atomic::{AtomicI32, AtomicU8, Ordering},
	},
	time::Duration,
};

#[cfg(windows)]
use std::os::windows::io::OwnedHandle;

use futures::FutureExt;
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::{
	ExecutionResult, error, processes, sys, trace_categories,
	traps::{self, JobSignals},
};

/// Handle to a shell-internal job task. Dropping it aborts the task, as
/// dropping a [`processes::ChildProcess`] kills its process: a job that leaves
/// its shell's job table (a subshell exiting, the shell dropping) must not keep
/// running where no `kill` or `wait` can reach it.
pub(crate) type JobJoinHandle = AbortOnDropHandle<Result<ExecutionResult, error::Error>>;
pub(crate) type JobResult = (Job, Result<ExecutionResult, error::Error>);

const WAIT_NEXT_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// How long `kill %N` waits for an aborted in-shell task to unwind.
const INTERNAL_TASK_UNWIND_LIMIT: Duration = Duration::from_millis(500);

/// Ids of jobs that run inside the shell process (a function, a subshell, a
/// compound command), for which no operating-system process exists for `$!`,
/// `wait`, `kill` and `jobs` to name. They start at 2^30, above Linux's
/// `PID_MAX_LIMIT` of 2^22, so on Linux no process shares one. Whether `kill`
/// treats a number as a shell job id depends on [`IN_PROCESS_JOBS`], not on
/// this range: an id no live job holds goes to the operating system, where a
/// platform with larger process ids (Windows) can have a process with it.
const FIRST_IN_PROCESS_PID: sys::process::ProcessId = 1 << 30;

/// The next in-process job id. One counter serves every shell in the process
/// and never wraps: after the last id it refuses new jobs, so an id names one
/// job for the life of the process.
static NEXT_IN_PROCESS_PID: AtomicI32 = AtomicI32::new(FIRST_IN_PROCESS_PID);

/// Every in-process job that exists, by pid. `kill` finds a job here from any
/// shell in the process (a subshell, a command substitution, another
/// background job), as one process signals another by its pid.
static IN_PROCESS_JOBS: LazyLock<Mutex<HashMap<sys::process::ProcessId, Arc<InProcessTarget>>>> =
	LazyLock::new(Mutex::default);

/// How many process ids keep the status of a job that left the job table, for
/// a later `wait` on that pid. Bash keeps a bounded list too; POSIX requires at
/// least `CHILD_MAX`'s minimum, 25. The bound keeps a long session that starts
/// many jobs from growing.
const REPORTED_STATUS_LIMIT: usize = 1024;

fn allocate_in_process_pid() -> Result<sys::process::ProcessId, error::Error> {
	allocate_in_process_pid_from(&NEXT_IN_PROCESS_PID)
}

fn allocate_in_process_pid_from(
	counter: &AtomicI32,
) -> Result<sys::process::ProcessId, error::Error> {
	let mut pid = counter.load(Ordering::Relaxed);
	loop {
		if pid < FIRST_IN_PROCESS_PID {
			return Err(error::ErrorKind::OutOfJobIds.into());
		}
		// -1 marks exhaustion. It cannot be a shell job id.
		let next = pid.checked_add(1).unwrap_or(-1);
		match counter.compare_exchange_weak(pid, next, Ordering::Relaxed, Ordering::Relaxed) {
			Ok(_) => return Ok(pid),
			Err(current) => pid = current,
		}
	}
}

fn in_process_jobs()
-> MutexGuard<'static, HashMap<sys::process::ProcessId, Arc<InProcessTarget>>> {
	IN_PROCESS_JOBS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether `pid` identifies a live in-process job. Numeric range is not a
/// discriminator: an operating-system process can use any signed id that the
/// platform exposes, notably on Windows.
pub fn has_in_process_job(pid: sys::process::ProcessId) -> bool {
	in_process_jobs().contains_key(&pid)
}

/// Whether the in-process job `pid` names is still running, as `kill -0` asks
/// of a process. Any shell in the process may ask.
pub fn in_process_job_is_running(pid: sys::process::ProcessId) -> bool {
	let target = in_process_jobs().get(&pid).cloned();
	target.is_some_and(|target| target.is_running())
}

/// Ends the in-process job `pid` names as signal `signal_number` ends a
/// process; any shell in the process may end it. The shell that owns the job
/// then reports 128 plus `signal_number` to `wait`. Returns `false` when no
/// such job is running.
pub fn end_in_process_job(pid: sys::process::ProcessId, signal_number: u8) -> bool {
	let target = in_process_jobs().get(&pid).cloned();
	target.is_some_and(|target| target.end(signal_number))
}

/// Leaves `signal` pending when the in-process job `pid` trapped it. The job
/// invokes that trap at its next interpreter check instead of being aborted.
pub fn deliver_trapped_in_process_signal(pid: sys::process::ProcessId, signal: traps::TrapSignal) -> bool {
	let target = in_process_jobs().get(&pid).cloned();
	target.is_some_and(|target| target.deliver_trapped_signal(signal))
}

/// [`InProcessTarget::state`] while the task runs.
const TASK_RUNNING: u8 = 0;
/// [`InProcessTarget::state`] once the task returned on its own.
const TASK_FINISHED: u8 = u8::MAX;

/// What `kill` reaches of a job that runs inside the shell process.
struct InProcessTarget {
	/// Aborts the job's task where it next yields.
	abort: AbortHandle,
	/// Ends the job's task at its next interpreter check, so a body that never
	/// yields (a loop of synchronous builtins) stops too. A child of the run's
	/// token, so cancelling the run (a tool abort) also stops the job.
	cancellation: CancellationToken,
	/// [`TASK_RUNNING`], [`TASK_FINISHED`], or the number of the signal that
	/// ended the task. The task and `kill` each claim it from
	/// [`TASK_RUNNING`], so whichever comes first decides the job's status.
	state: Arc<AtomicU8>,

	/// Traps the job itself installed and signals awaiting their handler.
	signals: Arc<JobSignals>,
}

impl InProcessTarget {
	fn is_running(&self) -> bool {
		!self.abort.is_finished()
	}
	/// Leaves a trapped signal pending for the task to handle between commands.
	fn deliver_trapped_signal(&self, signal: traps::TrapSignal) -> bool {
		if !self.is_running() || !self.signals.is_trapped(signal) {
			return false;
		}
		self.signals.deliver(signal);
		true
	}

	/// Ends the task as signal `signal_number` ends a process. Returns `false`
	/// when the task had already finished.
	fn end(&self, signal_number: u8) -> bool {
		if self.abort.is_finished() {
			return false;
		}
		match self.state.compare_exchange(
			TASK_RUNNING,
			signal_number,
			Ordering::AcqRel,
			Ordering::Acquire,
		) {
			// A signal that is already ending the task keeps its status.
			Ok(_) => {},
			Err(TASK_FINISHED) => return false,
			Err(_) => {},
		}
		// Abort first: a task waiting at an await is then dropped without
		// running on, so it prints nothing as it ends.
		self.abort.abort();
		self.cancellation.cancel();
		true
	}
}

/// The pid of a job that runs inside the shell process, and its entry in
/// [`IN_PROCESS_JOBS`], which dropping the job removes.
struct InProcess {
	pid:    sys::process::ProcessId,
	target: Arc<InProcessTarget>,
}

impl Drop for InProcess {
	fn drop(&mut self) {
		// A job that leaves its shell with its task still running (the shell or
		// a subshell dropping) must stop: the abort its dropped handle requests
		// lands only where the task yields.
		self.target.cancellation.cancel();
		let mut jobs = in_process_jobs();
		if jobs.get(&self.pid).is_some_and(|target| Arc::ptr_eq(target, &self.target)) {
			jobs.remove(&self.pid);
		}
	}
}

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

	/// Jobs `disown` took out of job control. The shell still owns them: they
	/// keep running, are reaped, and end with the shell, but no job spec, pid
	/// lookup, `jobs` listing or `wait` reaches them.
	disowned: Vec<Job>,

	/// Exit statuses of jobs that left the job table, by the job's last pid
	/// (its `$!`), so a later `wait` on that pid returns the status again, as
	/// in Bash. `wait` with no operand forgets them.
	reported: VecDeque<(sys::process::ProcessId, u8)>,
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
			// `exit` or `return` in a background job ends the job, not the shell
			// that waits for it: only the job's status leaves the task.
			Self::Internal(handle) => Ok(JobTaskWaitResult::Completed(ExecutionResult::new(
				handle.await??.exit_code.into(),
			))),
		}
	}

	/// Polls the task for completion. Returns `Some(result)` if the task has
	/// completed, or `None` if it is still running. The result is the execution
	/// result of the task. An in-process task that ended in a panic counts as
	/// completed with that error: its handle must not be polled again.
	fn poll(&mut self) -> Option<Result<ExecutionResult, error::Error>> {
		match self {
			Self::External(process) => {
				let check_result = process.poll();
				check_result.map(|polled_result| polled_result.map(|output| output.into()))
			},
			Self::Internal(handle) => handle.now_or_never().map(|joined| {
				let result = joined.map_err(error::Error::from).and_then(std::convert::identity)?;
				Ok(ExecutionResult::new(result.exit_code.into()))
			}),
		}
	}
}

impl JobManager {
	/// Whether an external child still needs a wait, including stopped jobs
	/// that may later be signalled without another shell command, and jobs
	/// `disown` took out of job control.
	pub fn has_live_external_jobs(&self) -> bool {
		self
			.jobs
			.iter()
			.chain(&self.disowned)
			.any(|job| job.external_process_count() > 0)
	}

	/// How many jobs, disowned ones included, still hold a task the shell
	/// would stop on drop. The persistent host retains the shell while this is
	/// nonzero: a background function must survive the command that started it
	/// as an external background process does.
	pub fn live_job_count(&self) -> usize {
		self
			.jobs
			.iter()
			.chain(&self.disowned)
			.filter(|job| !job.tasks.is_empty())
			.count()
	}

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
		// As in Bash, a new job first takes the ended jobs `jobs` reported out
		// of the table. Then the current job becomes the previous one, the
		// previous one loses its mark, and the new job takes the number after
		// the highest one in use.
		self.remove_reported_jobs();
		for j in &mut self.jobs {
			match j.annotation {
				JobAnnotation::Current => j.annotation = JobAnnotation::Previous,
				JobAnnotation::Previous => j.annotation = JobAnnotation::None,
				JobAnnotation::None => {},
			}
		}

		let id = self.jobs.iter().map(|j| j.id).max().unwrap_or(0) + 1;
		job.id = id;
		job.annotation = JobAnnotation::Current;
		// A pid this job's processes now hold no longer names the job that
		// reported under it.
		for pid in job.process_ids().chain(job.in_process_pid()) {
			self.forget_reported(pid);
		}
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

	/// Waits for all managed jobs to complete, then forgets the statuses kept
	/// for jobs that left the job table, as Bash's `wait` with no operand does.
	pub async fn wait_all(&mut self) -> Result<Vec<Job>, error::Error> {
		self.wait_all_with_policy(false).await
	}

	/// Waits for all managed jobs to terminate, ignoring stopped-state changes,
	/// then forgets the statuses kept for jobs that left the job table.
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

		let completed_jobs = self.sweep_completed_jobs();
		self.reported.clear();
		Ok(completed_jobs)
	}

	/// Waits for the job `selector` names. A job that ends leaves the job
	/// table, and its pid keeps the status for a later `wait` on that pid, as
	/// in Bash; such a pid returns that status again. Returns `None` when no
	/// job matches and no status is kept for the pid.
	pub async fn wait_for(
		&mut self,
		selector: JobSelector,
		wait_for_terminate: bool,
	) -> Result<Option<ExecutionResult>, error::Error> {
		let Some(index) = self.jobs.iter().position(|job| job.matches_selector(selector)) else {
			return Ok(match selector {
				JobSelector::ProcessId(pid) => self.reported_status(pid).map(ExecutionResult::new),
				JobSelector::JobId(_) => None,
			});
		};
		let waited = self.jobs[index].wait_with_policy(wait_for_terminate).await;
		if matches!(self.jobs[index].state, JobState::Done) {
			let job = self.remove(index);
			if let Ok(result) = &waited {
				self.report(&job, u8::from(result.exit_code));
			}
		}
		waited.map(Some)
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
				// A job `jobs` reported has told its status, so, as in Bash, it
				// is not one to wait for.
				if self.jobs[i].is_reported()
					|| (!selectors.is_empty()
						&& !selectors
							.iter()
							.any(|selector| self.jobs[i].matches_selector(*selector)))
				{
					i += 1;
					continue;
				}

				found_candidate = true;
				let identifier = self.jobs[i].wait_identifier();
				let result = match self.jobs[i].poll_done()? {
					Some(result) => result,
					None if matches!(self.jobs[i].state, JobState::Done) => {
						self.jobs[i].take_completed_result()
					},
					None => {
						i += 1;
						continue;
					},
				};
				let job = self.remove(i);
				if let Ok(result) = &result {
					self.report(&job, u8::from(result.exit_code));
				}
				return result.map(|result| Some(WaitedJob::from_job(job, result, identifier)));
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
			let result = match self.jobs[i].poll_done()? {
				Some(result) => result,
				None if matches!(self.jobs[i].state, JobState::Done) => {
					self.jobs[i].take_completed_result()
				},
				None => {
					i += 1;
					continue;
				},
			};
			let job = self.remove(i);
			if let Ok(result) = &result {
				self.report(&job, u8::from(result.exit_code));
			}
			results.push((job, result));
		}

		Ok(results)
	}

	/// Reaps finished children without consuming their jobs. Their PID and exit
	/// status remain available for a later explicit `wait` or job selection.
	/// A job `disown` took out of job control leaves the shell once it ends.
	pub fn poll_preserving_completed(&mut self) -> Result<(), error::Error> {
		for job in &mut self.jobs {
			job.refresh()?;
		}
		self.disowned.retain_mut(|job| {
			let _ = job.refresh();
			!job.tasks.is_empty()
		});
		Ok(())
	}

	/// Records that `jobs` showed the job `id` names in its current state, as
	/// Bash does for each job it lists. `jobs -n` then leaves the job out until
	/// its state changes. A job shown as ended counts as reported: `wait -n`
	/// passes over it, and the next listing of every job, or the next job to
	/// start, takes it out of the table. A job shown while it still runs is
	/// not reported, so `wait -n` returns it once it ends.
	pub fn mark_reported(&mut self, id: usize) {
		if let Some(job) = self.jobs.iter_mut().find(|job| job.id == id) {
			job.listed_state = Some(job.state.clone());
		}
	}

	/// Takes the ended jobs `jobs` reported out of the table, as Bash does
	/// before it lists every job and before a new job starts. Each one's pid
	/// keeps its status for a later `wait` on that pid.
	pub fn remove_reported_jobs(&mut self) {
		let mut index = 0;
		while index < self.jobs.len() {
			if !self.jobs[index].is_reported() {
				index += 1;
				continue;
			}
			let mut job = self.remove(index);
			if let Ok(result) = job.take_completed_result() {
				self.report(&job, u8::from(result.exit_code));
			}
		}
	}

	/// Takes the job `selector` names out of job control, as `disown` does: no
	/// job spec, pid lookup, `jobs` listing or `wait` reaches it again, but it
	/// keeps running, is reaped, and ends with the shell. As in Bash, its pid
	/// keeps the status the job has so far (0 while it runs) for a later
	/// `wait`. Returns `false` when no job matches.
	pub fn disown(&mut self, selector: JobSelector) -> bool {
		let Some(index) = self.jobs.iter().position(|job| job.matches_selector(selector)) else {
			return false;
		};
		let job = self.remove(index);
		self.report(&job, job.status_so_far());
		self.keep_disowned(job);
		true
	}

	/// Takes every job, or with `running_only` every running job, out of job
	/// control, as `disown -a` and `disown -r` do. As in Bash, their pids keep
	/// no status for `wait`, and `disown -a` also forgets every status kept so
	/// far.
	pub fn disown_all(&mut self, running_only: bool) {
		let mut index = 0;
		while index < self.jobs.len() {
			if running_only && !matches!(self.jobs[index].state, JobState::Running) {
				index += 1;
				continue;
			}
			let job = self.remove(index);
			self.keep_disowned(job);
		}
		if !running_only {
			self.reported.clear();
		}
	}

	/// Keeps a disowned job that still runs, so it is reaped and ends with the
	/// shell.
	fn keep_disowned(&mut self, job: Job) {
		if !job.tasks.is_empty() {
			self.disowned.push(job);
		}
	}

	/// Every job the shell owns, disowned ones included: what a cancelled run
	/// or the shell's end must stop.
	pub fn owned_jobs_mut(&mut self) -> impl Iterator<Item = &mut Job> {
		self.jobs.iter_mut().chain(&mut self.disowned)
	}

	/// Every job the shell owns, disowned ones included.
	pub fn owned_jobs(&self) -> impl Iterator<Item = &Job> {
		self.jobs.iter().chain(&self.disowned)
	}

	fn sweep_completed_jobs(&mut self) -> Vec<Job> {
		let mut completed_jobs = vec![];

		let mut i = 0;
		while i != self.jobs.len() {
			if self.jobs[i].tasks.is_empty() {
				completed_jobs.push(self.remove(i));
			} else {
				i += 1;
			}
		}

		completed_jobs
	}

	/// Takes a job out of the table, and moves the current and previous marks
	/// as Bash does when the job held one: the previous job becomes current,
	/// and the most recent other job previous.
	fn remove(&mut self, index: usize) -> Job {
		let job = self.jobs.remove(index);
		if job.is_current() || job.is_prev() {
			if self.current_job().is_none() {
				let next = self
					.jobs
					.iter()
					.position(Job::is_prev)
					.or_else(|| self.jobs.len().checked_sub(1));
				if let Some(next) = next {
					self.jobs[next].annotation = JobAnnotation::Current;
				}
			}
			if self.prev_job().is_none()
				&& let Some(prev) = self.jobs.iter_mut().rev().find(|j| !j.is_current())
			{
				prev.annotation = JobAnnotation::Previous;
			}
		}
		job
	}

	/// Keeps `status` for the job's last pid (its `$!`), so a later `wait` on
	/// that pid returns it again, as in Bash.
	fn report(&mut self, job: &Job, status: u8) {
		let Some(pid) = job.last_pid() else {
			return;
		};
		self.reported.retain(|&(reported, _)| reported != pid);
		if self.reported.len() == REPORTED_STATUS_LIMIT {
			self.reported.pop_front();
		}
		self.reported.push_back((pid, status));
	}

	/// Forgets the status kept for `pid`, because this shell just started a
	/// new child that holds it: `wait PID` then waits for the new child, or
	/// reports `pid` as not a child, as Bash does.
	pub fn forget_reported(&mut self, pid: sys::process::ProcessId) {
		self.reported.retain(|&(reported, _)| reported != pid);
	}

	fn reported_status(&self, pid: sys::process::ProcessId) -> Option<u8> {
		self
			.reported
			.iter()
			.find(|&&(reported, _)| reported == pid)
			.map(|&(_, status)| status)
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
	/// Last status reaped in the background, pending an explicit wait.
	/// Set once the final pipeline stage has completed, regardless of whether
	/// earlier stages are still running.
	completed_result: Option<Result<ExecutionResult, error::Error>>,

	/// PIDs of children removed from the task queue by polling.
	completed_process_ids: Vec<sys::process::ProcessId>,

	/// First external stage's PID (the process-group leader), retained after
	/// that stage has been reaped, or an in-process job's own pid. Used by
	/// `jobs -p`, job display and `wait`.
	representative_process_id: Option<sys::process::ProcessId>,

	/// Last external stage's PID, retained after reaping, or an in-process
	/// job's own pid; becomes `$!`.
	last_process_id: Option<sys::process::ProcessId>,

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

	/// The state `jobs` last showed the job in, if it showed it at all. A job
	/// shown as ended is reported: as in Bash, `wait -n` passes over it, while
	/// `wait` on its job spec or pid still finds it until the next listing of
	/// every job, or the next job to start, takes it out of the table.
	listed_state: Option<JobState>,

	/// The pid of a job that runs inside the shell process, and what `kill`
	/// reaches of it; `None` for a job of external processes.
	in_process: Option<InProcess>,
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
		let tasks: VecDeque<_> = tasks.into_iter().collect();
		// `jobs -p` and job display name the process-group leader (first
		// stage); `$!` names the last stage, as in bash.
		let external_pids = || {
			tasks.iter().filter_map(|task| match task {
				JobTask::External(process) => process.pid(),
				JobTask::Internal(_) => None,
			})
		};
		let representative_process_id = external_pids().next();
		let last_process_id = external_pids().last();
		let pgid = tasks.iter().find_map(|task| match task {
			JobTask::External(process) => process.pgid().or_else(|| process.pid()),
			JobTask::Internal(_) => None,
		});
		Self {
			id: 0,
			tasks,
			completed_result: None,
			completed_process_ids: Vec::new(),
			representative_process_id,
			last_process_id,
			pgid,
			annotation: JobAnnotation::None,
			command_line,
			state,
			listed_state: None,
			in_process: None,
		}
	}

	/// Returns a job that runs `body` inside the shell process. It takes a
	/// shell-only id, which `$!`, `jobs`, `wait` and `kill` name it by and
	/// which `kill` reaches from any shell in the process; `cancellation` ends
	/// the task at its next interpreter check.
	///
	/// Returns [`error::ErrorKind::OutOfJobIds`] after the final id is handed
	/// out rather than reusing an id that names a live or reported job.
	pub(crate) fn spawn_in_process<F>(
		body: F,
		command_line: String,
		cancellation: CancellationToken,
		signals: Arc<JobSignals>,
	) -> Result<Self, error::Error>
	where
		F: Future<Output = Result<ExecutionResult, error::Error>> + Send + 'static,
	{
		let pid = allocate_in_process_pid()?;
		let state = Arc::new(AtomicU8::new(TASK_RUNNING));
		let finished = Arc::clone(&state);
		let handle = AbortOnDropHandle::new(tokio::spawn(async move {
			let result = body.await;
			// A signal that claimed the task first keeps its status.
			let _ = finished.compare_exchange(
				TASK_RUNNING,
				TASK_FINISHED,
				Ordering::AcqRel,
				Ordering::Acquire,
			);
			result
		}));
		let target = Arc::new(InProcessTarget {
			abort: handle.abort_handle(),
			cancellation,
			state,
			signals,
		});
		in_process_jobs().insert(pid, Arc::clone(&target));
		let mut job = Self::new([JobTask::Internal(handle)], command_line, JobState::Running);
		job.representative_process_id = Some(pid);
		job.last_process_id = Some(pid);
		job.in_process = Some(InProcess { pid, target });
		Ok(job)
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

	/// Returns whether `jobs` has shown the job since it ended.
	pub const fn is_reported(&self) -> bool {
		matches!(self.listed_state, Some(JobState::Done))
	}

	/// Returns whether the job's state differs from the one `jobs` last
	/// showed, which is what `jobs -n` lists. A job `jobs` never showed has
	/// changed.
	pub fn changed_since_listed(&self) -> bool {
		self.listed_state
			.as_ref()
			.is_none_or(|listed| std::mem::discriminant(listed) != std::mem::discriminant(&self.state))
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
		self.poll_done_impl(false)
	}

	fn poll_done_preserving_process_ids(
		&mut self,
	) -> Result<Option<Result<ExecutionResult, error::Error>>, error::Error> {
		self.poll_done_impl(true)
	}

	fn poll_done_impl(
		&mut self,
		preserve_process_ids: bool,
	) -> Result<Option<Result<ExecutionResult, error::Error>>, error::Error> {
		tracing::debug!(target: trace_categories::JOBS, "Polling job {} for completion...", self.id);

		let mut index = 0;
		while index < self.tasks.len() {
			let is_final_stage = index + 1 == self.tasks.len() && self.completed_result.is_none();
			let task = &mut self.tasks[index];
			match task.poll() {
				Some(result) => {
					if preserve_process_ids
						&& let JobTask::External(process) = task
						&& let Some(pid) = process.pid()
					{
						self.completed_process_ids.push(pid);
					}
					self.tasks.remove(index);
					if is_final_stage {
						self.completed_result = Some(result);
					}
				},
				None if !preserve_process_ids => return Ok(None),
				None => index += 1,
			}
		}

		if !self.tasks.is_empty() {
			return Ok(None);
		}

		tracing::debug!(target: trace_categories::JOBS, "Job {} has completed.", self.id);
		self.state = JobState::Done;
		Ok(Some(self.take_completed_result()))
	}

	/// Reaps the job's finished tasks without consuming the job: a job that
	/// ended keeps its status for a later `wait`, and its pids for job
	/// selection.
	pub fn refresh(&mut self) -> Result<(), error::Error> {
		if !matches!(self.state, JobState::Done)
			&& let Some(result) = self.poll_done_preserving_process_ids()?
		{
			self.completed_result = Some(result);
		}
		Ok(())
	}

	/// 128 plus the number of the signal `kill` ended the job's in-process
	/// task with, as `wait` reports a process a signal killed.
	fn signal_status(&self) -> Option<u8> {
		match self.in_process.as_ref()?.target.state.load(Ordering::Acquire) {
			TASK_RUNNING | TASK_FINISHED => None,
			signal => Some(128_u8.saturating_add(signal)),
		}
	}

	/// The status `wait` reports for the job once it has ended.
	fn take_completed_result(&mut self) -> Result<ExecutionResult, error::Error> {
		let result = self.completed_result.take();
		match self.signal_status() {
			Some(status) => Ok(ExecutionResult::new(status)),
			None => result.unwrap_or_else(|| Ok(ExecutionResult::success())),
		}
	}

	/// The status the job has so far: 0 while it runs.
	fn status_so_far(&self) -> u8 {
		self.signal_status().unwrap_or(match &self.completed_result {
			Some(Ok(result)) => u8::from(result.exit_code),
			_ => 0,
		})
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
		while let Some(task) = self.tasks.back_mut() {
			let is_external = task.is_external();
			let waited = task.wait(wait_for_terminate).await;
			// A task `kill` ended reports its signal, whatever its aborted join
			// returned.
			if self.signal_status().is_some() {
				self.tasks.pop_back();
				continue;
			}
			let waited = match waited {
				Ok(waited) => waited,
				Err(error) => {
					// An in-process task that failed has ended: its join handle
					// must not stay where a later poll would poll it again.
					if !is_external {
						self.tasks.pop_back();
						if self.tasks.is_empty() {
							self.state = JobState::Done;
						}
					}
					return Err(error);
				},
			};
			match waited {
				JobTaskWaitResult::Completed(execution_result) => {
					if self.completed_result.is_none() {
						self.completed_result = Some(Ok(execution_result));
					}
					self.tasks.pop_back();
				},
				JobTaskWaitResult::Stopped => {
					self.state = JobState::Stopped;
					return Ok(ExecutionResult::stopped());
				},
			}
		}

		self.state = JobState::Done;
		self.take_completed_result()
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
		drop(self.take_internal_tasks());
	}

	/// Aborts shell-internal background tasks and returns a future that
	/// resolves once they have unwound and dropped what they held, or after
	/// [`INTERNAL_TASK_UNWIND_LIMIT`]. `kill %N` awaits it, as a killed
	/// process is gone once it is reaped: a FIFO open the job was waiting in is
	/// then released before the next command opens that FIFO.
	pub fn take_internal_tasks(&mut self) -> impl Future<Output = ()> + Send + 'static {
		let mut aborted = Vec::new();
		let mut index = 0;
		while index < self.tasks.len() {
			if matches!(self.tasks.get(index), Some(JobTask::Internal(_))) {
				if let Some(JobTask::Internal(handle)) = self.tasks.remove(index) {
					handle.abort();
					aborted.push(handle);
				}
			} else {
				index += 1;
			}
		}
		// Aborting lands only where a task yields, and a loop of synchronous
		// builtins may run for a long time before that: the cancellation flag
		// stops it at its next interpreter check.
		if let Some(in_process) = &self.in_process {
			in_process.target.cancellation.cancel();
		}
		if !aborted.is_empty() && self.tasks.is_empty() {
			self.state = JobState::Done;
		}
		async move {
			for handle in aborted {
				let _ = tokio::time::timeout(INTERNAL_TASK_UNWIND_LIMIT, handle).await;
			}
		}
	}

	/// The pid of a job that runs inside the shell process.
	pub fn in_process_pid(&self) -> Option<sys::process::ProcessId> {
		self.in_process.as_ref().map(|in_process| in_process.pid)
	}

	/// Leaves `signal` pending when this running job trapped it.
	pub fn deliver_trapped_signal(&self, signal: traps::TrapSignal) -> bool {
		self
			.in_process
			.as_ref()
			.is_some_and(|in_process| in_process.target.deliver_trapped_signal(signal))
	}

	/// Ends the job's in-process task as signal `signal_number` ends a
	/// process; `wait` then reports 128 plus `signal_number`. Returns a future
	/// that resolves once the task has unwound (see
	/// [`Job::take_internal_tasks`]), or `None` when the task is not running.
	pub fn end_in_process(
		&mut self,
		signal_number: u8,
	) -> Option<impl Future<Output = ()> + Send + 'static> {
		let in_process = self.in_process.as_ref()?;
		if !self.has_internal_tasks() || !in_process.target.end(signal_number) {
			return None;
		}
		Some(self.take_internal_tasks())
	}

	fn matches_selector(&self, selector: JobSelector) -> bool {
		match selector {
			JobSelector::JobId(id) => self.id == id,
			JobSelector::ProcessId(pid) => self.contains_process_id(pid),
		}
	}

	fn contains_process_id(&self, pid: i32) -> bool {
		self.in_process_pid() == Some(pid)
			|| self.completed_process_ids.contains(&pid)
			|| self.tasks.iter().any(|task| match task {
				JobTask::External(process) => process.pid().is_some_and(|process_pid| process_pid == pid),
				JobTask::Internal(_) => false,
			})
	}

	fn wait_identifier(&self) -> String {
		self
			.representative_pid()
			.map_or_else(|| self.id.to_string(), |pid| pid.to_string())
	}

	/// Returns whether part of the job runs inside the shell process (a builtin,
	/// function, or compound command) rather than as an external process.
	pub fn has_internal_tasks(&self) -> bool {
		self.tasks.iter().any(|task| !task.is_external())
	}

	/// Returns the number of external processes retained by this job.
	pub fn external_process_count(&self) -> usize {
		self.tasks.iter().filter(|task| task.is_external()).count()
	}

	/// Iterates over the external process IDs that make up this job.
	pub fn process_ids(&self) -> impl Iterator<Item = sys::process::ProcessId> + '_ {
		self.tasks.iter().filter_map(|task| match task {
			JobTask::External(process) => process.pid(),
			JobTask::Internal(_) => None,
		})
	}

	/// Returns the first external stage's PID (the process-group leader), or
	/// an in-process job's own pid, for `jobs -p` and job display, even after
	/// that stage has been reaped.
	pub fn representative_pid(&self) -> Option<sys::process::ProcessId> {
		self.representative_process_id
	}

	/// Returns the last external stage's PID, or an in-process job's own pid:
	/// the value `$!` takes after this job is started, even after that stage
	/// has been reaped.
	pub fn last_pid(&self) -> Option<sys::process::ProcessId> {
		self.last_process_id
	}

	/// Tries to retrieve the process group ID (PGID) of the job.
	pub fn process_group_id(&self) -> Option<sys::process::ProcessId> {
		self.pgid
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

#[cfg(all(test, unix))]
mod tests {
	use std::{
		sync::{Arc, atomic::AtomicI32},
		time::Duration,
	};

	use anyhow::Result;
	use tokio_util::sync::CancellationToken;

	use crate::{ExecutionResult, traps::JobSignals};

	use super::{Job, JobSelector, allocate_in_process_pid_from};

	#[tokio::test]
	async fn reaped_job_remains_waitable_by_original_pid_and_status() -> Result<()> {
		let mut shell = crate::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		shell
			.run_string("/bin/sh -c 'exit 7' &", &crate::SourceInfo::default(), &params)
			.await?;
		let pid = shell.last_background_pid().expect("background process PID");

		tokio::time::timeout(Duration::from_secs(5), async {
			loop {
				shell.jobs_mut().poll_preserving_completed()?;
				if !shell.jobs().has_live_external_jobs() {
					return Ok::<_, crate::error::Error>(());
				}
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await??;

		assert!(shell.jobs().contains_process_id(pid));
		assert_eq!(shell.last_background_pid(), Some(pid));
		let waited = shell
			.jobs_mut()
			.wait_next(&[JobSelector::ProcessId(pid)])
			.await?
			.expect("completed job still waitable");
		assert_eq!(u8::from(waited.result.exit_code), 7);
		assert!(!shell.jobs().contains_process_id(pid));
		assert_eq!(shell.last_background_pid(), Some(pid));
		Ok(())
	}
	#[tokio::test]
	async fn reaped_job_direct_wait_returns_original_status() -> Result<()> {
		let mut shell = crate::Shell::builder().build().await?;
		shell
			.run_string(
				"/bin/sh -c 'exit 9' &",
				&crate::SourceInfo::default(),
				&shell.default_exec_params(),
			)
			.await?;
		let pid = shell.last_background_pid().expect("background process PID");

		tokio::time::timeout(Duration::from_secs(5), async {
			loop {
				shell.jobs_mut().poll_preserving_completed()?;
				if !shell.jobs().has_live_external_jobs() {
					return Ok::<_, crate::error::Error>(());
				}
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await??;

		let job = shell.jobs_mut().resolve_process_id(pid).expect("reaped PID remains selectable");
		let result = job.wait().await?;
		assert_eq!(u8::from(result.exit_code), 9);
		Ok(())
	}

	#[tokio::test]
	async fn later_pipeline_stage_is_reaped_before_earlier_stage_finishes() -> Result<()> {
		let mut shell = crate::Shell::builder().build().await?;
		shell
			.run_string(
				"/bin/sleep 2 | /bin/sh -c 'exit 7' &",
				&crate::SourceInfo::default(),
				&shell.default_exec_params(),
			)
			.await?;
		let job = shell.jobs().current_job().expect("background pipeline");
		let pids: Vec<_> = job.process_ids().collect();
		assert_eq!(pids.len(), 2);
		// `$!` is the last stage; `jobs -p` stays on the group leader.
		assert_eq!(shell.last_background_pid(), Some(pids[1]));
		assert_eq!(job.representative_pid(), Some(pids[0]));

		tokio::time::timeout(Duration::from_secs(5), async {
			loop {
				shell.jobs_mut().poll_preserving_completed()?;
				if shell.jobs().current_job().expect("background pipeline").external_process_count() == 1 {
					return Ok::<_, crate::error::Error>(());
				}
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await??;

		let job = shell.jobs().current_job().expect("background pipeline");
		assert_eq!(job.process_ids().collect::<Vec<_>>(), vec![pids[0]]);
		assert!(shell.jobs().contains_process_id(pids[1]));
		assert!(shell.jobs().has_live_external_jobs());

		let waited = shell.jobs_mut().wait_next(&[JobSelector::ProcessId(pids[1])]).await?;
		assert_eq!(u8::from(waited.expect("pipeline still waitable").result.exit_code), 7);
		Ok(())
	}

	/// A status kept for a reported pid must not survive this shell starting a
	/// new child under that pid: `wait PID` then means the new child, as in
	/// Bash. The test keeps a status for every pid Linux is likely to hand out
	/// next, starts a foreground and a background child, and checks that
	/// neither child's pid still reports the old status.
	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn a_new_child_under_a_reported_pid_drops_its_old_status() -> Result<()> {
		let mut shell = crate::Shell::builder().build().await?;
		let dir = tempfile::tempdir()?;
		let last: i32 = std::fs::read_to_string("/proc/sys/kernel/ns_last_pid")?.trim().parse()?;
		for pid in last + 1..last + 4001 {
			shell.jobs_mut().reported.push_back((pid, 7));
		}
		let foreground = dir.path().join("fg");
		let background = dir.path().join("bg");
		let script = format!(
			"/bin/sh -c 'echo $$ > {}'; /bin/sh -c 'echo $$ > {}' &",
			foreground.display(),
			background.display()
		);
		shell
			.run_string(&script, &crate::SourceInfo::default(), &shell.default_exec_params())
			.await?;
		// No `wait`: a `wait` would itself replace or clear the kept status.
		tokio::time::timeout(Duration::from_secs(5), async {
			while std::fs::read_to_string(&background).map_or(true, |text| text.trim().is_empty()) {
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await?;
		for path in [&foreground, &background] {
			let pid: i32 = std::fs::read_to_string(path)?.trim().parse()?;
			assert!((last + 1..last + 4001).contains(&pid), "pid {pid} outside the seeded range");
			assert_ne!(shell.jobs().reported_status(pid), Some(7), "pid {pid} kept the old status");
		}
		Ok(())
	}

	/// The last synthetic id is handed out once; no later job can wrap and
	/// reuse it while the first job can still be signalled or waited on.
	#[test]
	fn in_process_id_exhaustion_never_wraps() {
		let counter = AtomicI32::new(i32::MAX);
		assert_eq!(allocate_in_process_pid_from(&counter).expect("last id"), i32::MAX);
		let err = allocate_in_process_pid_from(&counter).expect_err("must not wrap");
		assert!(matches!(err.kind(), crate::error::ErrorKind::OutOfJobIds));
	}

	/// A live job at the final id keeps its own registry target: exhausting
	/// the counter refuses the next job rather than reusing that id and
	/// overwriting the first job's target.
	#[tokio::test]
	async fn a_live_final_id_never_aliases_another_job() {
		let original = super::NEXT_IN_PROCESS_PID.swap(i32::MAX, std::sync::atomic::Ordering::SeqCst);
		let first = Job::spawn_in_process(
			std::future::pending::<Result<ExecutionResult, crate::error::Error>>(),
			"first".into(),
			CancellationToken::new(),
			Arc::new(JobSignals::default()),
		)
		.expect("final id");
		let pid = first.in_process_pid().expect("in-process id");
		assert_eq!(pid, i32::MAX);
		assert!(super::has_in_process_job(pid));

		let second = Job::spawn_in_process(
			std::future::pending::<Result<ExecutionResult, crate::error::Error>>(),
			"second".into(),
			CancellationToken::new(),
			Arc::new(JobSignals::default()),
		);
		let Err(err) = second else {
			panic!("job id wrapped and aliased {pid}");
		};
		assert!(matches!(err.kind(), crate::error::ErrorKind::OutOfJobIds));
		assert!(super::has_in_process_job(pid));

		drop(first);
		super::NEXT_IN_PROCESS_PID.store(original, std::sync::atomic::Ordering::SeqCst);
	}
}

/// Runs on every platform: whether `kill` treats a number as a shell job id
/// depends on the live registry, not on its range. On Windows a real process
/// can have an id at or above 2^30; it must still reach the operating system.
#[cfg(test)]
mod registry_tests {
	use std::sync::Arc;

	use tokio_util::sync::CancellationToken;

	use super::{FIRST_IN_PROCESS_PID, Job, has_in_process_job};
	use crate::{ExecutionResult, traps::JobSignals};

	#[tokio::test]
	async fn only_a_live_registered_job_id_is_in_process() {
		// An id in the synthetic range that no job holds is an operating-system
		// id, as a Windows process id there would be.
		assert!(!has_in_process_job(i32::MAX - 7));
		assert!(!has_in_process_job(FIRST_IN_PROCESS_PID - 1));

		let job = Job::spawn_in_process(
			std::future::pending::<Result<ExecutionResult, crate::error::Error>>(),
			"job".into(),
			CancellationToken::new(),
			Arc::new(JobSignals::default()),
		)
		.expect("job id");
		let pid = job.in_process_pid().expect("in-process id");
		assert!(has_in_process_job(pid));
		drop(job);
		assert!(!has_in_process_job(pid));
	}
}

