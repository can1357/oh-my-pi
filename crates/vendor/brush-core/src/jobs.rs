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
	ExecutionExitCode, ExecutionResult, error, processes, sys, trace_categories,
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

	/// Whether the job table is frozen, as Bash freezes its job list while
	/// `lastpipe` runs the last command of a pipeline in the shell itself
	/// (`freeze_jobs_list` in `execute_pipeline`): no cleanup point forgets a
	/// job then, and `wait -n` returns at once.
	frozen: bool,
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
	/// The task has completed, with its status and the `WSTOPSIG` of its wait
	/// status (see [`stop_signal_word`]).
	Completed(ExecutionResult, u8),
	/// The task was stopped.
	Stopped,
}

/// How a wait with job control on ended (see [`Job::wait_with_job_control`]).
enum JobWaitEnd {
	/// The job ended with this result.
	Ended(ExecutionResult),
	/// The job stopped; this is its stopped status (see
	/// [`Job::stopped_status`]).
	Stopped(u32),
}

/// What a foreground pipeline's wait saw of its stages when it stopped (see
/// [`Job::record_pipeline_stop`]).
#[derive(Default)]
pub(crate) struct PipelineStop {
	/// The pipeline's first external pid.
	pub first_pid:   Option<sys::process::ProcessId>,
	/// The pipeline's last external pid.
	pub last_pid:    Option<sys::process::ProcessId>,
	/// The external pids of the stages that ended.
	pub ended_pids:  Vec<sys::process::ProcessId>,
	/// Each stopped stage's pid with the signal that stopped it.
	pub stopped:     Vec<(sys::process::ProcessId, u8)>,
	/// The `WSTOPSIG` value of the first stage's status, once it ended (see
	/// [`stop_signal_word`]).
	pub first_word:  Option<u8>,
	/// The last stage's status, once it ended.
	pub last_status: Option<ExecutionExitCode>,
	/// What a job-control signal reaches of every external stage, as each
	/// started (see [`processes::ChildProcess::signal_target`]).
	pub signal_targets: Vec<sys::process::ProcessId>,
}

/// How `kill` delivers a signal, as Bash's `kill_pid` decides it (see
/// [`Job::kill_delivery`], [`JobManager::kill_pid_delivery`]).
pub struct KillDelivery {
	/// Each target of the signal: a pid, or a negative process group.
	pub targets:         Vec<sys::process::ProcessId>,
	/// Whether the same targets get SIGCONT after the signal.
	pub continue_after:  bool,
	/// Whether the call fails when no target took the signal; Bash's
	/// per-process path for a job started without job control never fails.
	pub reports_failure: bool,
}

impl KillDelivery {
	/// The signal goes to `targets` alone.
	const fn to(targets: Vec<sys::process::ProcessId>) -> Self {
		Self { targets, continue_after: false, reports_failure: true }
	}

	/// Sends `signal` to every target (`None` probes them with signal 0),
	/// then SIGCONT to the same targets when the delivery asks for it.
	/// Returns whether the call succeeded: some target took the signal, or
	/// the delivery never fails.
	pub fn deliver(&self, signal: Option<traps::TrapSignal>) -> bool {
		let mut delivered = false;
		for &target in &self.targets {
			delivered |= match signal {
				Some(signal) => sys::signal::kill_process(target, signal).is_ok(),
				None => sys::signal::probe_process(target),
			};
		}
		if self.continue_after {
			let _ = sys::signal::continue_targets(&self.targets);
		}
		delivered || !self.reports_failure
	}
}

/// The signal targets of `processes`, each once (see
/// [`processes::ChildProcess::signal_target`]).
pub(crate) fn signal_targets<'a>(
	processes: impl IntoIterator<Item = &'a processes::ChildProcess>,
) -> Vec<sys::process::ProcessId> {
	let mut targets: Vec<_> = processes.into_iter().filter_map(processes::ChildProcess::signal_target).collect();
	targets.sort_unstable();
	targets.dedup();
	targets
}

/// `WSTOPSIG` of the wait status of a process that ended, which Bash's
/// `wait_for` adds to 128 for a stopped job whose first process has ended:
/// the exit status of a process that exited, 0 for one a signal killed.
pub(crate) fn stop_signal_word(output: &std::process::Output) -> u8 {
	output
		.status
		.code()
		.map_or(0, |code| u8::try_from(code & 0xff).unwrap_or(0))
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
						let word = stop_signal_word(&output);
						break Ok(JobTaskWaitResult::Completed(output.into(), word));
					},
					processes::ProcessWaitResult::Stopped(_) if wait_for_terminate => {},
					processes::ProcessWaitResult::Stopped(_) => break Ok(JobTaskWaitResult::Stopped),
					processes::ProcessWaitResult::Cancelled => {
						break Ok(JobTaskWaitResult::Completed(ExecutionResult::new(130), 0));
					},
				}
			},
			// `exit` or `return` in a background job ends the job, not the shell
			// that waits for it: only the job's status leaves the task.
			Self::Internal(handle) => Ok(JobTaskWaitResult::Completed(
				ExecutionResult::new(handle.await??.exit_code.into()),
				0,
			)),
		}
	}

	/// Polls the task for completion. Returns `Some(result)` if the task has
	/// completed, or `None` if it is still running. The result is the execution
	/// result of the task and the `WSTOPSIG` of its wait status (see
	/// [`stop_signal_word`]). An in-process task that ended in a panic counts as
	/// completed with that error: its handle must not be polled again.
	fn poll(&mut self) -> Option<Result<(ExecutionResult, u8), error::Error>> {
		match self {
			Self::External(process) => process.poll().map(|polled| {
				polled.map(|output| {
					let word = stop_signal_word(&output);
					(output.into(), word)
				})
			}),
			Self::Internal(handle) => handle.now_or_never().map(|joined| {
				let result = joined.map_err(error::Error::from).and_then(std::convert::identity)?;
				Ok((ExecutionResult::new(result.exit_code.into()), 0))
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
	/// * `job_control` - Whether job control is on, which `fg` and `bg`
	///   require of the job (see [`Job::started_with_job_control`]).
	#[allow(clippy::missing_panics_doc, reason = "push() guarantees the vector length is >= 1")]
	pub fn add_as_current(&mut self, mut job: Job, job_control: bool) -> &Job {
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
		job.started_with_job_control = job_control;
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

	/// Bash's `kill_pid` (`jobs.c:3670-3741`) for a pid operand of `kill`
	/// (`signal` is `None` for signal 0). A pid below -1 names a process
	/// group: if one of the jobs holds the pid it negates, that job decides
	/// the delivery (see [`Job::kill_delivery`]), else the group gets the
	/// signal. Any other pid gets the signal alone, with no regard to a job
	/// that holds it: no SIGCONT follows, and the job's state stays.
	pub fn kill_pid_delivery(
		&mut self,
		pid: sys::process::ProcessId,
		signal: Option<traps::TrapSignal>,
		observe_stops: bool,
	) -> Result<KillDelivery, error::Error> {
		if let Some(group) = pid.checked_neg().filter(|&group| group > 1)
			&& let Some(job) = self.resolve_process_id(group)
		{
			return job.kill_delivery(signal, Some(group), observe_stops);
		}
		Ok(KillDelivery::to(vec![pid]))
	}

	/// Waits for every job, as Bash's `wait` with no operand does
	/// (`wait_for_background_pids`), then forgets the jobs that ended and every
	/// status kept for a pid. A job this call waited for is reported, as is
	/// every job that had already ended except the one whose last pid is
	/// `last_async_pid` (`$!`), which Bash keeps until a later `wait` reports
	/// it; the reported jobs leave the table at once. Without job control Bash
	/// does not see stops, so it waits through them. With `job_control` on it
	/// scans the table again after each wait, waits only for a job that runs,
	/// and notes each stopped job it passes; the returned list holds the job
	/// number and last pid of each, once per scan, for its `job N[PID] stopped`
	/// warning.
	pub async fn wait_all(
		&mut self,
		last_async_pid: Option<sys::process::ProcessId>,
		job_control: bool,
	) -> Result<Vec<(usize, Option<sys::process::ProcessId>)>, error::Error> {
		self.wait_all_with_policy(false, last_async_pid, job_control).await
	}

	/// Like [`Self::wait_all`], but a job that stops does not end the wait for
	/// it.
	pub async fn wait_all_for_termination(
		&mut self,
		last_async_pid: Option<sys::process::ProcessId>,
		job_control: bool,
	) -> Result<Vec<(usize, Option<sys::process::ProcessId>)>, error::Error> {
		self.wait_all_with_policy(true, last_async_pid, job_control).await
	}

	async fn wait_all_with_policy(
		&mut self,
		wait_for_terminate: bool,
		last_async_pid: Option<sys::process::ProcessId>,
		job_control: bool,
	) -> Result<Vec<(usize, Option<sys::process::ProcessId>)>, error::Error> {
		// A job that ended before this call is not one it waits for.
		self.poll_preserving_completed()?;
		let mut waited_for: Vec<usize> = self
			.jobs
			.iter()
			.filter(|job| !job.is_done())
			.map(|job| job.id)
			.collect();
		let mut stopped_notices = Vec::new();
		if job_control {
			loop {
				self.observe_stops_and_continues()?;
				let mut running = None;
				for (index, job) in self.jobs.iter().enumerate() {
					if matches!(job.state, JobState::Stopped) {
						stopped_notices.push((job.id, job.last_pid()));
					}
					if matches!(job.state, JobState::Running) {
						running = Some(index);
						break;
					}
				}
				let Some(index) = running else {
					break;
				};
				self.jobs[index].wait_with_job_control(wait_for_terminate).await?;
			}
		} else {
			for job in &mut self.jobs {
				job.wait_with_policy(true).await?;
			}
		}
		waited_for.retain(|id| self.jobs.iter().any(|job| job.id == *id && job.is_done()));
		for job in &mut self.jobs {
			if job.is_done() && (waited_for.contains(&job.id) || job.last_pid() != last_async_pid) {
				job.listed = true;
			}
		}
		self.remove_reported_jobs();
		self.reported.clear();
		Ok(stopped_notices)
	}

	/// Waits for the job `selector` names, as Bash's `wait %N` and `wait PID`
	/// do (`wait_for_job`, `wait_for_single_pid`): once the job has ended (or,
	/// with job control on, stopped), the shell forgets every ended job that
	/// was reported, this one too if something had reported it before, and
	/// then reports this job, which leaves the table at the next cleanup point
	/// (see [`Self::remove_reported_jobs`]). Until then a second `wait` finds
	/// it and returns its status again; afterwards its pid keeps the status.
	/// Without job control Bash does not see stops, so it waits through them.
	/// With job control on, it returns once the job no longer runs: a stopped
	/// job is not waited for, and the status is 128 plus `WSTOPSIG` of the
	/// status of the job's first process (see [`Job::stopped_status`]), which
	/// `wait PID` turns into 127 above 256 (`status > 256 means pid error` in
	/// its `wait.def`) and `wait %N`, as any builtin, maps through
	/// `builtin_status`. Returns `None` when no job matches and no status is
	/// kept for the pid.
	pub async fn wait_for(
		&mut self,
		selector: JobSelector,
		wait_for_terminate: bool,
		job_control: bool,
	) -> Result<Option<ExecutionResult>, error::Error> {
		let Some(index) = self.jobs.iter().position(|job| job.matches_selector(selector)) else {
			return Ok(match selector {
				JobSelector::ProcessId(pid) => self.reported_status(pid).map(ExecutionResult::new),
				JobSelector::JobId(_) => None,
			});
		};
		let id = self.jobs[index].id;
		let waited = if job_control {
			self.jobs[index]
				.wait_with_job_control(wait_for_terminate)
				.await
				.map(|end| match end {
					JobWaitEnd::Ended(result) => result,
					JobWaitEnd::Stopped(status) => match selector {
						JobSelector::ProcessId(_) if status > 256 => ExecutionExitCode::NotFound.into(),
						_ => ExecutionExitCode::from_builtin_status(status).into(),
					},
				})
		} else {
			self.jobs[index].wait_with_policy(true).await
		};
		self.remove_reported_jobs();
		if let Some(job) = self.jobs.iter_mut().find(|job| job.id == id)
			&& matches!(job.state, JobState::Done)
		{
			job.listed = true;
		}
		waited.map(Some)
	}

	/// Runs the job `id` in the foreground and waits for it, as Bash's `fg`
	/// does with job control on (`start_job`, then `wait_for`): see
	/// [`Job::move_to_foreground`]. The job is no longer asynchronous, so once
	/// it ends it leaves the table at once and its pid keeps no status
	/// (`delete_job` keeps one only for an asynchronous job), and the ended
	/// jobs that were reported leave with it (`notify_and_cleanup`). A job that
	/// stops again stays, and `fg` returns its stopped status (see
	/// [`Self::wait_for`]). Returns `None` when no job has that id.
	pub async fn run_in_foreground(
		&mut self,
		id: usize,
		take_terminal: bool,
	) -> Result<Option<ExecutionResult>, error::Error> {
		let Some(index) = self.jobs.iter().position(|job| job.id == id) else {
			return Ok(None);
		};
		self.jobs[index].move_to_foreground(take_terminal)?;
		let waited = self.jobs[index].wait_with_job_control(false).await.map(|end| match end {
			JobWaitEnd::Ended(result) => result,
			JobWaitEnd::Stopped(status) => ExecutionExitCode::from_builtin_status(status).into(),
		});
		if self.jobs[index].is_done() {
			self.remove(index);
			self.remove_reported_jobs();
		}
		waited.map(Some)
	}

	/// Waits for the next job among those `selectors` name (every job when
	/// empty) to end, as Bash's `wait -n` does (`wait_for_any_job`). The first
	/// such job, in table order, that has ended and that nothing reported is
	/// returned at once. Otherwise, while any job runs (selected or not), it
	/// waits until one ends and returns the first selected job that has ended,
	/// reported or not. The returned job leaves the table and its pid keeps
	/// its status. Returns `None` when no job runs, or at once while the table
	/// is frozen. With job control on, a job that stops no longer runs.
	pub async fn wait_next(
		&mut self,
		selectors: &[JobSelector],
		job_control: bool,
	) -> Result<Option<WaitedJob>, error::Error> {
		if self.frozen {
			return Ok(None);
		}
		let selected = |job: &Job| {
			selectors.is_empty() || selectors.iter().any(|selector| job.matches_selector(*selector))
		};
		self.refresh_states(job_control)?;
		if let Some(index) = self
			.jobs
			.iter()
			.position(|job| job.is_done() && !job.listed && selected(job))
		{
			return self.take_waited(index).map(Some);
		}
		loop {
			if !self.jobs.iter().any(|job| matches!(job.state, JobState::Running)) {
				return Ok(None);
			}
			let ended_before = self.jobs.iter().filter(|job| job.is_done()).count();
			while self.jobs.iter().filter(|job| job.is_done()).count() == ended_before
				&& self.jobs.iter().any(|job| matches!(job.state, JobState::Running))
			{
				tokio::time::sleep(WAIT_NEXT_POLL_INTERVAL).await;
				self.refresh_states(job_control)?;
			}
			if let Some(index) = self.jobs.iter().position(|job| job.is_done() && selected(job)) {
				return self.take_waited(index).map(Some);
			}
		}
	}

	/// Collects the jobs that ended, without taking their statuses, and with
	/// job control on also their stops and continues.
	fn refresh_states(&mut self, job_control: bool) -> Result<(), error::Error> {
		if job_control {
			self.observe_stops_and_continues()?;
		}
		self.poll_preserving_completed()
	}

	/// Takes the ended job at `index` out of the table for `wait -n`; its pid
	/// keeps its status.
	fn take_waited(&mut self, index: usize) -> Result<WaitedJob, error::Error> {
		let identifier = self.jobs[index].wait_identifier();
		let result = self.jobs[index].take_completed_result();
		let job = self.remove(index);
		let result = result?;
		self.report(&job, u8::from(result.exit_code));
		Ok(WaitedJob::from_job(job, result, identifier))
	}

	/// Applies the stops and continues every job's processes reported since
	/// the last look. Bash observes them only with job control on (its
	/// `waitchld` asks for `WUNTRACED|WCONTINUED` only then); see
	/// [`Job::observe_stops_and_continues`].
	pub fn observe_stops_and_continues(&mut self) -> Result<(), error::Error> {
		for job in &mut self.jobs {
			job.observe_stops_and_continues()?;
		}
		Ok(())
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

	/// Records that a `jobs` listing showed the job `id` names in its current
	/// state, as Bash's listing does for each job it prints in any form but
	/// `-p`. `jobs -n` then leaves the job out until one of its processes
	/// changes state. A job shown as ended is reported: `wait -n` passes over
	/// it, and [`Self::remove_reported_jobs`] forgets it. A job shown while it
	/// runs is not reported, so `wait -n` returns it once it ends.
	pub fn mark_listed(&mut self, id: usize) {
		if let Some(job) = self.jobs.iter_mut().find(|job| job.id == id) {
			job.listed = true;
		}
	}

	/// Freezes the job table, returning whether it was already frozen; see
	/// [`Self::set_frozen`].
	pub fn freeze(&mut self) -> bool {
		std::mem::replace(&mut self.frozen, true)
	}

	/// Freezes or thaws the job table. While it is frozen no cleanup point
	/// forgets a job and `wait -n` returns at once, as while Bash's job list
	/// is frozen.
	pub fn set_frozen(&mut self, frozen: bool) {
		self.frozen = frozen;
	}

	/// Forgets the ended jobs that were reported, as Bash 5.2's
	/// `cleanup_dead_jobs` does: each leaves the table, and its last pid keeps
	/// its status for a later `wait PID`. Nothing leaves while the table is
	/// frozen. The shell calls this where Bash does:
	///
	/// - each time it reads an input line (`shell_getc`, via
	///   `notify_and_cleanup`): before each complete command of a script, an
	///   `eval` string, a sourced file or a trap handler, once more after the
	///   last command when text follows it, once for a non-empty text with no
	///   command, and when it expands a `$(...)` command or `<(...)`/`>(...)`
	///   process substitution, whose text Bash parses then. A command that
	///   spans lines is read whole before it runs; a backquoted substitution
	///   is not parsed then and is no cleanup point;
	/// - when it installs a new job (`stop_pipeline`): an external command,
	///   found or not, a builtin that stands in for one, a subshell, a
	///   pipeline of two or more commands, a background job, a coprocess;
	/// - in a loop (`REAP`): after each body of a `for` that iterates, after
	///   each test of an arithmetic `for`, a `while` or an `until`;
	/// - after `wait` waits for a job (`wait_for`), and in `wait` with no
	///   operand;
	/// - before `jobs` lists every job, and after each job spec it lists.
	///
	/// A builtin, function or brace group that runs in the shell itself is
	/// not such a point.
	pub fn remove_reported_jobs(&mut self) {
		if self.frozen {
			return;
		}
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

	/// Whether some ended job was reported, so the next cleanup point would
	/// forget it (see [`Self::remove_reported_jobs`]).
	pub fn has_reported_jobs(&self) -> bool {
		self.jobs.iter().any(Job::is_reported)
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

	/// What a job-control signal reaches of each external stage, recorded as
	/// the stage started: its process group (negative), unless that is the
	/// shell's own, then the process. `fg`, `bg` and `kill` signal exactly
	/// these (see [`Job::signal_targets`]); a group still holds a stage's
	/// children after the stage has exited, as Bash's `killpg` on the job's
	/// group reaches them.
	signal_targets: Vec<sys::process::ProcessId>,

	/// The annotation of the job (e.g., current, previous).
	annotation: JobAnnotation,

	/// The shell-internal ID of the job.
	pub id: usize,

	/// The command line of the job.
	pub command_line: String,

	/// The current operational state of the job.
	pub state: JobState,

	/// Whether a `jobs` listing has shown the job since any of its processes
	/// last changed state, as Bash's `J_NOTIFIED` flag records: a listing in
	/// any form but `-p` sets it, and a process that ends, stops or continues
	/// clears it. `jobs -n` leaves out a listed job. A listed job that has
	/// ended is reported: `wait -n` passes over it, and the shell forgets it
	/// at its next cleanup point (see [`JobManager::remove_reported_jobs`]).
	listed: bool,

	/// The job's processes that reported a stop and no continue since, each
	/// with the signal that stopped it; see
	/// [`Job::observe_stops_and_continues`].
	stopped_processes: Vec<(sys::process::ProcessId, u8)>,

	/// `WSTOPSIG` of the wait status of the job's first process once it has
	/// ended (see [`stop_signal_word`]); see [`Job::stopped_status`].
	first_process_word: Option<u8>,

	/// Whether job control was on when the job started, as Bash's
	/// `J_JOBCONTROL` flag records; `fg` and `bg` refuse a job without it.
	started_with_job_control: bool,

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
		let signal_targets = signal_targets(tasks.iter().filter_map(|task| match task {
			JobTask::External(process) => Some(process),
			JobTask::Internal(_) => None,
		}));
		Self {
			id: 0,
			tasks,
			completed_result: None,
			completed_process_ids: Vec::new(),
			representative_process_id,
			last_process_id,
			pgid,
			signal_targets,
			annotation: JobAnnotation::None,
			command_line,
			state,
			listed: false,
			stopped_processes: Vec::new(),
			first_process_word: None,
			started_with_job_control: false,
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

	/// Whether job control was on when the job started, as Bash's
	/// `J_JOBCONTROL` records; `fg` and `bg` refuse a job without it.
	pub const fn started_with_job_control(&self) -> bool {
		self.started_with_job_control
	}

	/// Returns whether a `jobs` listing has shown the job since it ended.
	pub const fn is_reported(&self) -> bool {
		self.listed && matches!(self.state, JobState::Done)
	}

	/// Returns whether a `jobs` listing has shown the job since any of its
	/// processes last changed state; `jobs -n` lists only jobs it has not.
	pub const fn is_listed(&self) -> bool {
		self.listed
	}

	/// Records that `kill` signalled the job through a job spec or its process
	/// group, which Bash counts as a change no listing has shown (`kill_pid`
	/// clears `J_NOTIFIED`), even for a signal that changes nothing: `jobs -n`
	/// lists the job again, and an ended job is no longer reported.
	pub const fn clear_listed(&mut self) {
		self.listed = false;
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
				Some(polled) => {
					let pid = match task {
						JobTask::External(process) => process.pid(),
						JobTask::Internal(_) => None,
					};
					if preserve_process_ids && let Some(pid) = pid {
						self.completed_process_ids.push(pid);
					}
					let result = match polled {
						Ok((result, word)) => {
							if pid.is_some() && pid == self.representative_process_id {
								self.first_process_word = Some(word);
							}
							Ok(result)
						},
						Err(error) => Err(error),
					};
					self.tasks.remove(index);
					// As in Bash, a process that ends, even one stage of a job
					// that runs on, is a change no listing has shown yet.
					self.listed = false;
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

	/// The status `wait` reports for the job once it has ended. The job keeps
	/// it, so a second `wait` before the job leaves the table reports it
	/// again, as in Bash. An in-process task's failure is reported once.
	fn take_completed_result(&mut self) -> Result<ExecutionResult, error::Error> {
		if let Some(status) = self.signal_status() {
			return Ok(ExecutionResult::new(status));
		}
		match self.completed_result.take() {
			Some(Ok(result)) => {
				let status = u8::from(result.exit_code);
				self.completed_result = Some(Ok(ExecutionResult::new(status)));
				Ok(ExecutionResult::new(status))
			},
			Some(Err(error)) => Err(error),
			None => Ok(ExecutionResult::success()),
		}
	}

	/// Whether every process of the job has ended.
	pub const fn is_done(&self) -> bool {
		matches!(self.state, JobState::Done)
	}

	/// What Bash's `wait_for` computes for a stopped job: 128 plus `WSTOPSIG`
	/// of the status of the job's first process, which is the signal that
	/// stopped it while it is stopped, and once it has ended its exit status,
	/// or 0 when a signal killed it (see [`stop_signal_word`]). It can exceed
	/// 255; each caller maps it as its builtin does (see
	/// [`JobManager::wait_for`]).
	fn stopped_status(&self) -> u32 {
		let first = self.representative_process_id;
		let word = self
			.first_process_word
			.or_else(|| {
				self.stopped_processes
					.iter()
					.find(|&&(pid, _)| Some(pid) == first)
					.map(|&(_, signal)| signal)
			})
			.unwrap_or(0);
		128 + u32::from(word)
	}

	/// Records what a foreground pipeline's wait saw before it became this
	/// stopped job, which Bash keeps in the job (`stop_pipeline`): the
	/// pipeline's first and last external pids name the job (`jobs -p`,
	/// `wait -p`), an ended stage's pid still selects it (`wait PID`), each
	/// stopped stage keeps its stop signal, the first stage's status once it
	/// has ended gives the stopped status (see [`Job::stopped_status`]), the
	/// last stage's status once it has ended is the job's, and every stage's
	/// signal target, ended stages' included, is the job's.
	pub(crate) fn record_pipeline_stop(&mut self, stop: PipelineStop) {
		self.representative_process_id = stop.first_pid.or(self.representative_process_id);
		self.last_process_id = stop.last_pid.or(self.last_process_id);
		self.completed_process_ids.extend(stop.ended_pids);
		self.stopped_processes = stop.stopped;
		if stop.first_word.is_some() {
			self.first_process_word = stop.first_word;
		}
		if let Some(status) = stop.last_status {
			self.completed_result = Some(Ok(ExecutionResult::from(status)));
		}
		self.signal_targets = stop.signal_targets;
	}

	/// Applies the stops, continues and exits the job's processes reported
	/// since the last look, as Bash's `set_job_status_and_cleanup` does: any of
	/// them is a change no listing has shown. A running job becomes stopped
	/// when no process of it runs and one is stopped; a process that exited
	/// does not run, so a pipeline with one stage stopped and the others ended
	/// is stopped. A stopped job stays stopped while one of its processes is
	/// stopped, though another runs (`jobs.c:4021-4040`: only a job that is
	/// not stopped returns early while a process runs), so a foreground
	/// pipeline this shell counted stopped while a stage still ran stays so
	/// until it is continued; it runs again once none is stopped. Bash sees
	/// stops and continues only with job control on, so only then do callers
	/// look.
	fn observe_stops_and_continues(&mut self) -> Result<(), error::Error> {
		if self.is_done() {
			return Ok(());
		}
		let mut changed = false;
		for task in &self.tasks {
			let JobTask::External(process) = task else {
				continue;
			};
			let Some(pid) = process.pid() else {
				continue;
			};
			match sys::signal::poll_for_stop_or_continue(pid)? {
				Some(sys::signal::StopOrContinue::Stopped(signal)) => {
					self.stopped_processes.retain(|&(stopped, _)| stopped != pid);
					self.stopped_processes.push((pid, signal));
					changed = true;
				},
				Some(sys::signal::StopOrContinue::Continued) => {
					self.stopped_processes.retain(|&(stopped, _)| stopped != pid);
					changed = true;
				},
				None => {},
			}
		}
		if changed {
			self.listed = false;
		}
		// Whether this look decides the job's state: a stop or continue it
		// saw, or a stop an earlier look recorded that an exit may now settle.
		// A stop a foreground wait saw itself is left as that wait set it.
		let decides_state = changed || !self.stopped_processes.is_empty();
		self.refresh()?;
		if self.is_done() {
			self.stopped_processes.clear();
			return Ok(());
		}
		if decides_state {
			let live: Vec<_> = self.process_ids().collect();
			self.stopped_processes.retain(|(pid, _)| live.contains(pid));
			let any_stopped = !self.stopped_processes.is_empty();
			let any_running = self.tasks.iter().any(|task| match task {
				JobTask::External(process) => process
					.pid()
					.is_none_or(|pid| !self.stopped_processes.iter().any(|&(stopped, _)| stopped == pid)),
				JobTask::Internal(_) => true,
			});
			let stopped = match self.state {
				JobState::Stopped => any_stopped,
				_ => any_stopped && !any_running,
			};
			self.state = if stopped { JobState::Stopped } else { JobState::Running };
		}
		Ok(())
	}

	/// Waits for the job as Bash's `wait_for` does with job control on: until
	/// it ends, or, unless `wait_for_terminate`, until no process of it runs
	/// and one is stopped. It looks at the processes' stops, continues and
	/// exits itself instead of waiting for one process, so a stop an earlier
	/// look took cannot leave it waiting on a stopped process.
	async fn wait_with_job_control(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<JobWaitEnd, error::Error> {
		loop {
			self.observe_stops_and_continues()?;
			if self.is_done() {
				return self.take_completed_result().map(JobWaitEnd::Ended);
			}
			if !wait_for_terminate && matches!(self.state, JobState::Stopped) {
				return Ok(JobWaitEnd::Stopped(self.stopped_status()));
			}
			tokio::time::sleep(WAIT_NEXT_POLL_INTERVAL).await;
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
			// The job keeps the pid of each task it waited for, so a job spec
			// and `wait PID` still name the job until it leaves the table.
			let waited_pid = match task {
				JobTask::External(process) => process.pid(),
				JobTask::Internal(_) => None,
			};
			let waited = task.wait(wait_for_terminate).await;
			// The process ended or stopped: a change no listing has shown.
			self.listed = false;
			// A task `kill` ended reports its signal, whatever its aborted join
			// returned.
			if self.signal_status().is_some() {
				self.end_waited_task(waited_pid);
				continue;
			}
			let waited = match waited {
				Ok(waited) => waited,
				Err(error) => {
					// An in-process task that failed has ended: its join handle
					// must not stay where a later poll would poll it again.
					if !is_external {
						self.end_waited_task(waited_pid);
						if self.tasks.is_empty() {
							self.state = JobState::Done;
						}
					}
					return Err(error);
				},
			};
			match waited {
				JobTaskWaitResult::Completed(execution_result, word) => {
					if self.completed_result.is_none() {
						self.completed_result = Some(Ok(execution_result));
					}
					if waited_pid.is_some() && waited_pid == self.representative_process_id {
						self.first_process_word = Some(word);
					}
					self.end_waited_task(waited_pid);
				},
				JobTaskWaitResult::Stopped => {
					self.state = JobState::Stopped;
					// The pipeline's foreground wait would return 128 +
					// WSTOPSIG here, but a job waited on by its job spec gets
					// its status from `stopped_status`, so this intermediate
					// value never reaches `$?` — only `observe_stops_and_continues`
					// sets the per-process stop signal.
					return Ok(ExecutionResult::new(148));
				},
			}
		}

		self.state = JobState::Done;
		self.take_completed_result()
	}

	/// Takes the task the job just waited for out of the job, keeping its pid,
	/// so a job spec and `wait PID` still name the job until it leaves the
	/// table.
	fn end_waited_task(&mut self, pid: Option<sys::process::ProcessId>) {
		if let Some(pid) = pid
			&& !self.completed_process_ids.contains(&pid)
		{
			self.completed_process_ids.push(pid);
		}
		self.tasks.pop_back();
	}

	/// Continues a stopped job in the background, as Bash's `start_job` does
	/// for `bg` (see [`Self::resume`]). A job that runs is left as it is.
	pub fn move_to_background(&mut self) -> Result<(), error::Error> {
		match &self.state {
			JobState::Stopped => {
				self.resume();
				Ok(())
			},
			JobState::Running => Ok(()),
			JobState::Unknown | JobState::Done => Err(error::ErrorKind::FailedToSendSignal.into()),
		}
	}

	/// Moves the job to execute in the foreground, as Bash's `start_job`
	/// does for `fg`: a stopped job continues (see [`Self::resume`]), a job
	/// that runs becomes one no listing has shown, and with `take_terminal`
	/// its process group gets the terminal.
	pub fn move_to_foreground(&mut self, take_terminal: bool) -> Result<(), error::Error> {
		if matches!(self.state, JobState::Stopped) {
			self.resume();
		} else {
			self.listed = false;
		}
		if take_terminal && let Some(pgid) = self.process_group_id() {
			sys::terminal::move_to_foreground(pgid)?;
		}
		Ok(())
	}

	/// Continues a stopped job as Bash's `start_job` does: the job's signal
	/// targets get SIGCONT (`killpg`; see [`Self::signal_targets`]), whether
	/// or not that succeeds, the job runs, and continuing it counts as
	/// reported (`J_NOTIFIED`).
	fn resume(&mut self) {
		let _ = self.continue_processes();
		self.state = JobState::Running;
		self.stopped_processes.clear();
		self.listed = true;
	}

	/// Bash's `kill_pid` (`jobs.c:3670-3741`) for a signal `kill` sends to
	/// this job: through its job spec, or through the negative pid of one of
	/// its processes, `group` being the process group that pid names
	/// (`signal` is `None` for signal 0, which only probes). The job counts
	/// as one no listing has shown (`J_NOTIFIED`).
	///
	/// A job started without job control shares the shell's process group
	/// in Bash: the negative pid goes to that group as named (`killpg
	/// (pid)`), and a job spec signals each live process by pid, never its
	/// group, never continues it, and succeeds whatever the signals did.
	/// A job started with job control is signalled through its group, which
	/// here is every group its stages had (see [`Self::signal_targets`]),
	/// whichever process the negative pid named. If it is stopped, SIGTERM
	/// and SIGHUP are followed by SIGCONT to the same targets, and SIGCONT
	/// makes it run and count as reported, as `bg` would. Stops are seen
	/// only when `observe_stops`, as Bash's `waitchld` sees them only with
	/// job control on.
	pub fn kill_delivery(
		&mut self,
		signal: Option<traps::TrapSignal>,
		group: Option<sys::process::ProcessId>,
		observe_stops: bool,
	) -> Result<KillDelivery, error::Error> {
		self.listed = false;
		if !self.started_with_job_control {
			if let Some(group) = group {
				return Ok(KillDelivery::to(vec![-group]));
			}
			self.refresh()?;
			return Ok(KillDelivery {
				targets:         self.process_ids().collect(),
				continue_after:  false,
				reports_failure: false,
			});
		}
		if observe_stops {
			self.observe_stops_and_continues()?;
		}
		let stopped = matches!(self.state, JobState::Stopped);
		let signal = match signal {
			Some(traps::TrapSignal::Signal(signal)) => Some(signal),
			_ => None,
		};
		if stopped && signal.is_some_and(sys::signal::is_continue) {
			self.state = JobState::Running;
			self.stopped_processes.clear();
			self.listed = true;
		}
		let mut targets = self.signal_targets();
		if targets.is_empty()
			&& let Some(pgid) = self.process_group_id()
		{
			targets.push(-pgid);
		}
		Ok(KillDelivery {
			targets,
			continue_after: stopped && signal.is_some_and(sys::signal::needs_continue_when_stopped),
			reports_failure: true,
		})
	}

	/// What a signal to the job's process group reaches, as Bash's `start_job`
	/// and `kill_pid` signal a job started with job control (`killpg`):
	/// every process group the job's stages had as they started, an ended
	/// stage's too (it still holds the children that stage left), and each
	/// stage still tracked that ran in the shell's own group. The pid of a
	/// stage that has ended is never a target: it may name another process
	/// by now.
	pub fn signal_targets(&self) -> Vec<sys::process::ProcessId> {
		let live = self.tasks.iter().filter_map(|task| match task {
			JobTask::External(process) => process.signal_target(),
			JobTask::Internal(_) => None,
		});
		let mut targets: Vec<_> =
			self.signal_targets.iter().copied().filter(|&target| target < 0).chain(live).collect();
		targets.sort_unstable();
		targets.dedup();
		targets
	}

	/// Sends SIGCONT to the job's process groups (see [`Self::resume`],
	/// [`Self::signal_targets`]).
	pub fn continue_processes(&self) -> Result<(), error::Error> {
		sys::signal::continue_targets(&self.signal_targets())
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

	/// What `wait -p` assigns for the job: the pid Bash waits for, the last
	/// of the pipeline (`find_last_pid` in `wait_for_job` and
	/// `wait_for_any_job`), or the job number without one.
	pub fn wait_identifier(&self) -> String {
		self.last_pid().map_or_else(|| self.id.to_string(), |pid| pid.to_string())
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
			.wait_next(&[JobSelector::ProcessId(pid)], false)
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

		let waited = shell.jobs_mut().wait_next(&[JobSelector::ProcessId(pids[1])], false).await?;
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

