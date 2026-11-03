//! Process management

use futures::FutureExt;
use std::{
	io::Write,
	sync::Arc,
};

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

use tokio_util::sync::CancellationToken;

use crate::{error, openfiles::OpenFile, sys};

struct CompletionMarker {
	output:            OpenFile,
	end_marker_prefix: String,
	end_marker_suffix: String,
}

/// A waitable future that will yield the results of a child process's
/// execution.
pub(crate) type WaitableChildProcess = std::pin::Pin<
	Box<dyn futures::Future<Output = Result<std::process::Output, std::io::Error>> + Send + Sync>,
>;

/// Tracks a child process being awaited.
pub struct ChildProcess {
	/// A waitable future that will yield the results of a child process's
	/// execution.
	exec_future: WaitableChildProcess,
	/// Tracks whether this process has already been reaped.
	reaped:      bool,
	/// If available, the process ID of the child.
	pid:         Option<sys::process::ProcessId>,
	/// If available, the shared process group ID of the pipeline.
	pgid:        Option<sys::process::ProcessId>,
	/// Every external process in this pipeline.
	stop_pids:   Option<Arc<[sys::process::ProcessId]>>,
	/// What a job-control signal to the job reaches of this process,
	/// recorded as it started (see [`sys::signal::signal_target`]).
	signal_target: Option<sys::process::ProcessId>,
	/// The stops the last wait consumed: each process of the stop scope that
	/// stopped, with its `WSTOPSIG`.
	reported_stops: Vec<(sys::process::ProcessId, u8)>,
	/// Windows handle duplicated from the child process for safe termination.
	#[cfg(windows)]
	kill_handle: Option<OwnedHandle>,
	completion_marker: Option<CompletionMarker>,
	/// The exit [`Self::settle`] collected, which the next wait or poll
	/// returns.
	settled: Option<std::io::Result<std::process::Output>>,
}

impl ChildProcess {
	/// Wraps a child process and its future.
	pub fn new(
		child: sys::process::Child,
		pid: Option<sys::process::ProcessId>,
		pgid: Option<sys::process::ProcessId>,
	) -> Self {
		#[cfg(windows)]
		let kill_handle = child.raw_handle().and_then(duplicate_handle);

		Self {
			exec_future: Box::pin(child.wait_with_output()),
			pid,
			pgid,
			stop_pids: None,
			signal_target: pid.map(sys::signal::signal_target),
			reported_stops: Vec::new(),
			reaped: false,
			#[cfg(windows)]
			kill_handle,
			completion_marker: None,
			settled: None,
		}
	}

	/// Returns the process's ID.
	pub const fn pid(&self) -> Option<sys::process::ProcessId> {
		self.pid
	}

	/// Returns the process's group ID.
	pub const fn pgid(&self) -> Option<sys::process::ProcessId> {
		self.pgid
	}

	/// What a job-control signal to the job reaches of this process: its
	/// process group (negative) or the process, as it was when it started.
	pub const fn signal_target(&self) -> Option<sys::process::ProcessId> {
		self.signal_target
	}

	/// Sets the external process IDs that form this pipeline's stop scope.
	pub(crate) fn set_stop_pids(&mut self, pids: Arc<[sys::process::ProcessId]>) {
		self.stop_pids = Some(pids);
	}

	/// Takes the stops the last wait consumed (see [`ProcessWaitResult::Stopped`]):
	/// which processes of the stop scope stopped, each with its `WSTOPSIG`.
	/// Empty when the shell itself got SIGTSTP.
	pub(crate) fn take_reported_stops(&mut self) -> Vec<(sys::process::ProcessId, u8)> {
		std::mem::take(&mut self.reported_stops)
	}

	/// The process's output once it has ended, waiting at most `grace` for
	/// it, or `None` while it still runs. Unlike [`Self::wait`], it reports
	/// no stop and leaves the process alone.
	pub(crate) async fn finish_within(
		&mut self,
		grace: std::time::Duration,
	) -> Result<Option<std::process::Output>, error::Error> {
		let deadline = tokio::time::Instant::now() + grace;
		loop {
			if let Some(output) = self.poll() {
				return output.map(Some);
			}
			if tokio::time::Instant::now() >= deadline {
				return Ok(None);
			}
			tokio::time::sleep(std::time::Duration::from_millis(5)).await;
		}
	}

	/// Duplicates the process handle for termination use on Windows.
	#[cfg(windows)]
	pub fn duplicate_kill_handle(&self) -> Option<OwnedHandle> {
		let handle = self.kill_handle.as_ref()?;
		duplicate_handle(handle.as_raw_handle())
	}

	pub(crate) fn set_completion_marker(
		&mut self,
		output: OpenFile,
		end_marker_prefix: String,
		end_marker_suffix: String,
	) {
		self.completion_marker =
			Some(CompletionMarker { output, end_marker_prefix, end_marker_suffix });
	}

	/// Checks whether this process, or a stage in its pipeline, stopped.
	/// Returns the `WSTOPSIG` of the first stopped stage, or `None`, and
	/// keeps every stop it consumed (see [`Self::take_reported_stops`]).
	fn poll_for_stop(&mut self) -> Result<Option<u8>, error::Error> {
		let Some(pid) = self.pid else {
			return Ok(None);
		};
		let pids = self
			.stop_pids
			.as_deref()
			.unwrap_or_else(|| std::slice::from_ref(&pid));
		let stops = sys::signal::poll_for_stopped_processes(pids, self.pgid)?;
		let first = stops.first().map(|&(_, signal)| signal);
		self.reported_stops.extend(stops);
		Ok(first)
	}

	/// Waits for the process to exit.
	///
	/// Cancellation gives the process a bounded TERM grace before killing it.
	pub async fn wait(
		&mut self,
		cancel_token: Option<CancellationToken>,
	) -> Result<ProcessWaitResult, error::Error> {
		// An exit `settle` already collected: the exec future has completed.
		if let Some(output) = self.settled.take() {
			return Ok(ProcessWaitResult::Completed(output?));
		}
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigtstp = sys::signal::tstp_signal_listener()?;
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigchld = sys::signal::chld_signal_listener()?;
		self.reported_stops.clear();

		// A SIGCHLD delivered before the subscription above never reaches
		// `sigchld`. Pipeline stages are all spawned before the first is
		// waited on, so this process or one in its pipeline can stop before
		// this point. Exits need no such check: the child's exec future
		// registered for them when it was spawned.
		if let Some(signal) = self.poll_for_stop()? {
			return Ok(ProcessWaitResult::Stopped(signal));
		}

		let cancelled = async {
			match &cancel_token {
				Some(token) => token.cancelled().await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(cancelled);

		#[allow(clippy::ignored_unit_patterns)]
		loop {
			tokio::select! {
				output = &mut self.exec_future => {
					let output = output?;
					let marker_exit_code = completion_exit_code(&output.status);
					self.reaped = true;
					self.write_completion_marker(marker_exit_code);
					break Ok(ProcessWaitResult::Completed(output))
				},
				_ = &mut cancelled => {
					// The embedding host terminates the process group/tree. Allow
					// its TERM wave to finish without sending a duplicate TERM or
					// racing it with an immediate hard kill.
					#[cfg(unix)]
					{
						if let Ok(Ok(_)) = tokio::time::timeout(
							std::time::Duration::from_secs(1),
							&mut self.exec_future,
						).await {
							self.reaped = true;
						}
					}
					self.kill();
					self.write_completion_marker(130);
					break Ok(ProcessWaitResult::Cancelled)
				},
				_ = sigtstp.recv() => {
					// SIGTSTP delivered to the shell process; WSTOPSIG = 20.
					break Ok(ProcessWaitResult::Stopped(20))
				},
				_ = sigchld.recv() => {
					if let Some(signal) = self.poll_for_stop()? {
						break Ok(ProcessWaitResult::Stopped(signal));
					}
				},
				_ = sys::signal::await_ctrl_c() => {
					// SIGINT got thrown. Handle it and continue looping. The child should
					// have received it as well, and either handled it or ended up getting
					// terminated (in which case we'll see the child exit).
				},
			}
		}
	}

	/// Sends a kill signal if the process has not already been reaped.
	fn kill(&mut self) {
		if self.reaped {
			return;
		}
		#[cfg(unix)]
		{
			let Some(pid) = self.pid else { return };
			let _ = nix::sys::signal::kill(
				nix::unistd::Pid::from_raw(pid),
				nix::sys::signal::Signal::SIGKILL,
			);
		}

		#[cfg(windows)]
		{
			let terminated = self
				.kill_handle
				.as_ref()
				.is_some_and(|handle| terminate_raw_handle(handle.as_raw_handle()));
			if !terminated {
				if let Some(pid) = self.pid {
					let _ = terminate_process_id(pid);
				}
			}
		}
	}

	fn write_completion_marker(&mut self, exit_code: i32) {
		if let Some(mut marker) = self.completion_marker.take() {
			let _ = write!(
				marker.output,
				"{}{}{}",
				marker.end_marker_prefix, exit_code, marker.end_marker_suffix
			);
			let _ = marker.output.flush();
		}
	}

	pub(crate) fn poll(&mut self) -> Option<Result<std::process::Output, error::Error>> {
		if let Some(output) = self.settled.take() {
			return Some(output.map_err(Into::into));
		}
		let result = self.exec_future.as_mut().now_or_never()?;
		Some(match result {
			Ok(output) => {
				let marker_exit_code = completion_exit_code(&output.status);
				self.reaped = true;
				self.write_completion_marker(marker_exit_code);
				Ok(output)
			},
			Err(err) => Err(err.into()),
		})
	}

	/// Collects the exit of a process that has already ended, so the next
	/// [`Self::poll`] returns it. This handle learns of an exit through the
	/// runtime's reactor, which can be behind the kernel when it is polled,
	/// while Bash's `SIGCHLD` handler has always run by its next notify
	/// point; a process the kernel reports ended is therefore waited for here.
	pub(crate) async fn settle(&mut self) {
		if self.reaped || self.settled.is_some() {
			return;
		}
		let Some(pid) = self.pid else {
			return;
		};
		if !sys::signal::process_has_exited(pid) {
			return;
		}
		let output = (&mut self.exec_future).await;
		if let Ok(output) = &output {
			self.write_completion_marker(completion_exit_code(&output.status));
		}
		self.reaped = true;
		self.settled = Some(output);
	}

	/// Waits for the process to exit, without looking for stops, and keeps
	/// its exit for the next [`Self::wait`] or [`Self::poll`], as Bash's
	/// `SIGCHLD` handler records a process's end whenever it comes. Returns
	/// how the process ended, or `None` when its wait failed or an earlier
	/// wait took its exit.
	pub(crate) async fn collect_exit(&mut self) -> Option<ProcessStatus> {
		if !self.reaped && self.settled.is_none() {
			let output = (&mut self.exec_future).await;
			if let Ok(output) = &output {
				self.write_completion_marker(completion_exit_code(&output.status));
			}
			self.reaped = true;
			self.settled = Some(output);
		}
		match &self.settled {
			Some(Ok(output)) => Some(ProcessStatus::from_exit_status(&output.status)),
			_ => None,
		}
	}
}

impl Drop for ChildProcess {
	fn drop(&mut self) {
		// Ensure we do not leave an unreaped child running when the handle is dropped.
		self.kill();
	}
}

#[cfg(windows)]
fn duplicate_handle(handle: RawHandle) -> Option<OwnedHandle> {
	use windows_sys::Win32::{
		Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
		System::Threading::GetCurrentProcess,
	};

	// SAFETY: GetCurrentProcess returns a pseudo-handle for the current process
	// and has no preconditions.
	let current = unsafe { GetCurrentProcess() };
	let mut out_handle = std::ptr::null_mut();
	// SAFETY: `current` is a valid current-process pseudo-handle, `handle` is
	// an OS process handle owned by Tokio's child process object, and
	// `out_handle` is a valid out pointer checked below before ownership is
	// transferred to OwnedHandle.
	let ok = unsafe {
		DuplicateHandle(
			current,
			handle,
			current,
			&mut out_handle,
			0,
			0,
			DUPLICATE_SAME_ACCESS,
		)
	};
	if ok == 0 || out_handle.is_null() {
		return None;
	}

	// SAFETY: DuplicateHandle succeeded and returned a non-null owned duplicate
	// in `out_handle`, so transferring ownership to OwnedHandle is valid.
	Some(unsafe { OwnedHandle::from_raw_handle(out_handle) })
}

#[cfg(windows)]
fn terminate_raw_handle(handle: RawHandle) -> bool {
	use windows_sys::Win32::System::Threading::TerminateProcess;

	// SAFETY: The caller provides a process handle opened/duplicated for process
	// termination. The handle remains owned by its original owner.
	unsafe { TerminateProcess(handle, 1) != 0 }
}

/// Checks whether a duplicated Windows process handle still refers to a running process.
#[cfg(windows)]
#[must_use]
pub fn process_handle_is_running(handle: &OwnedHandle) -> bool {
	use windows_sys::Win32::{
		Foundation::WAIT_TIMEOUT,
		System::Threading::WaitForSingleObject,
	};

	// SAFETY: `handle` is a live duplicated process handle with synchronization access.
	unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_TIMEOUT }
}

/// Terminates the process referenced by a duplicated Windows process handle.
#[cfg(windows)]
#[must_use]
pub fn terminate_process_handle(handle: &OwnedHandle) -> bool {
	terminate_raw_handle(handle.as_raw_handle())
}

#[cfg(windows)]
fn terminate_process_id(pid: sys::process::ProcessId) -> bool {
	use windows_sys::Win32::Foundation::CloseHandle;
	use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE};

	let Ok(pid) = u32::try_from(pid) else {
		return false;
	};

	// SAFETY: OpenProcess is called with PROCESS_TERMINATE for a numeric process id.
	// A null handle is handled below.
	let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
	if handle.is_null() {
		return false;
	}

	let terminated = terminate_raw_handle(handle);
	// SAFETY: The handle was returned by OpenProcess and is closed exactly once here.
	let _close_result = unsafe { CloseHandle(handle) };
	terminated
}

fn completion_exit_code(status: &std::process::ExitStatus) -> i32 {
	if let Some(code) = status.code() {
		return code;
	}

	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt as _;
		if let Some(signal) = status.signal() {
			return 128 + signal;
		}
	}

	127
}

/// Represents the result of waiting for an executing process.
pub enum ProcessWaitResult {
	/// The process completed.
	Completed(std::process::Output),
	/// The process stopped and has not yet completed. The signal is the
	/// `WSTOPSIG` of the wait status; Bash adds 128 to it for `$?`.
	Stopped(u8),
	/// The process was killed due to cancellation.
	Cancelled,
}

/// How a process ended, or that it still runs: the status Bash keeps for
/// each process of a job, which its job listings and its reports of a job a
/// signal ended print.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessStatus {
	/// The process still runs.
	Running,
	/// The process exited with this status.
	Exited(u8),
	/// A signal ended the process.
	Signaled {
		/// The number of the signal.
		signal:      u8,
		/// Whether the kernel wrote a core image, as `WCOREDUMP` reports.
		core_dumped: bool,
	},
}

impl ProcessStatus {
	/// The status the operating system reported for a process that ended.
	pub fn from_exit_status(status: &std::process::ExitStatus) -> Self {
		#[cfg(unix)]
		{
			use std::os::unix::process::ExitStatusExt as _;
			if let Some(signal) = status.signal() {
				let signal = u8::try_from(signal & 0x7f).unwrap_or_default();
				return Self::Signaled { signal, core_dumped: status.core_dumped() };
			}
		}
		Self::Exited(u8::try_from(completion_exit_code(status) & 0xff).unwrap_or_default())
	}

	/// The signal that ended the process, if one did.
	pub const fn signal(self) -> Option<u8> {
		match self {
			Self::Signaled { signal, .. } => Some(signal),
			Self::Running | Self::Exited(_) => None,
		}
	}

	/// `WSTOPSIG` of the wait status of a process that ended, which Bash's
	/// `wait_for` adds to 128 for a stopped job whose first process has
	/// ended: the exit status of a process that exited, 0 for one a signal
	/// killed (or one that still runs).
	pub const fn stop_signal_word(self) -> u8 {
		match self {
			Self::Exited(status) => status,
			Self::Running | Self::Signaled { .. } => 0,
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{io::{Read, Seek, SeekFrom}, time::Duration};

	use super::*;

	#[tokio::test]
	async fn cancellation_writes_marker_even_when_wait_fails_during_grace() {
		let mut marker = tempfile::tempfile().expect("marker file");
		let mut child = ChildProcess {
			exec_future: Box::pin(async {
				tokio::time::sleep(Duration::from_millis(10)).await;
				Err(std::io::Error::other("wait failed during cancellation"))
			}),
			reaped: false,
			pid: None,
			pgid: None,
			stop_pids: None,
			signal_target: None,
			reported_stops: Vec::new(),
			completion_marker: None,
			settled: None,
		};
		child.set_completion_marker(
			OpenFile::from(marker.try_clone().expect("marker writer")),
			"<exit>".into(),
			"</exit>".into(),
		);
		let cancel = CancellationToken::new();
		cancel.cancel();
		assert!(matches!(child.wait(Some(cancel)).await, Ok(ProcessWaitResult::Cancelled)));
		marker.seek(SeekFrom::Start(0)).expect("rewind marker");
		let mut output = String::new();
		marker.read_to_string(&mut output).expect("read marker");
		assert_eq!(output, "<exit>130</exit>");
	}
}
