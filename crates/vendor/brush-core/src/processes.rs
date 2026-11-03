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

impl CompletionMarker {
	fn write(mut self, exit_code: i32) {
		let _ = write!(self.output, "{}{}{}", self.end_marker_prefix, exit_code, self.end_marker_suffix);
		let _ = self.output.flush();
	}
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
	/// Windows handle duplicated from the child process for safe termination.
	#[cfg(windows)]
	kill_handle: Option<OwnedHandle>,
	completion_marker: Option<CompletionMarker>,
	/// Relays carrying this process's output into shell text; see
	/// [`crate::outputrelay`].
	output_relays: Vec<crate::outputrelay::RelayHandle>,
	/// The exit [`Self::poll`] reaped while the relays still forwarded the
	/// process's output; reported once they have.
	exited: Option<std::process::Output>,
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
			reaped: false,
			#[cfg(windows)]
			kill_handle,
			completion_marker: None,
			output_relays: Vec::new(),
			exited: None,
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

	/// Sets the external process IDs that form this pipeline's stop scope.
	pub(crate) fn set_stop_pids(&mut self, pids: Arc<[sys::process::ProcessId]>) {
		self.stop_pids = Some(pids);
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

	/// Has [`Self::wait`] report the process finished only once `relays` have
	/// forwarded its output, so that output precedes whatever the shell writes
	/// into the same sink next.
	pub(crate) fn set_output_relays(&mut self, relays: Vec<crate::outputrelay::RelayHandle>) {
		self.output_relays = relays;
	}

	/// Checks whether this process, or a stage in its pipeline, stopped.
	fn poll_for_stop(&self) -> Result<bool, error::Error> {
		let Some(pid) = self.pid else {
			return Ok(false);
		};
		let pids = self
			.stop_pids
			.as_deref()
			.unwrap_or_else(|| std::slice::from_ref(&pid));
		sys::signal::poll_for_stopped_processes(pids, self.pgid)
	}

	/// Waits for the process to exit.
	///
	/// Cancellation gives the process a bounded TERM grace before killing it.
	pub async fn wait(
		&mut self,
		cancel_token: Option<CancellationToken>,
	) -> Result<ProcessWaitResult, error::Error> {
		if let Some(output) = self.exited.take() {
			return Ok(self.complete(output, cancel_token.as_ref()).await);
		}

		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigtstp = sys::signal::tstp_signal_listener()?;
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigchld = sys::signal::chld_signal_listener()?;

		// A SIGCHLD delivered before the subscription above never reaches
		// `sigchld`. Pipeline stages are all spawned before the first is
		// waited on, so this process or one in its pipeline can stop before
		// this point. Exits need no such check: the child's exec future
		// registered for them when it was spawned.
		if self.poll_for_stop()? {
			return Ok(ProcessWaitResult::Stopped);
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
					self.reaped = true;
					break Ok(self.complete(output?, cancel_token.as_ref()).await)
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
					break Ok(ProcessWaitResult::Stopped)
				},
				_ = sigchld.recv() => {
					if self.poll_for_stop()? {
						break Ok(ProcessWaitResult::Stopped);
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

	/// Reports the exited process once its relays have forwarded its output.
	/// The exit status is known by then, so a cancellation only stops the
	/// waiting; the completion marker still follows the output, written once
	/// the drain the cancellation left behind finishes.
	async fn complete(
		&mut self,
		output: std::process::Output,
		cancel_token: Option<&CancellationToken>,
	) -> ProcessWaitResult {
		let exit_code = completion_exit_code(&output.status);
		let mut drain = Box::pin(crate::outputrelay::drain(std::mem::take(&mut self.output_relays)));
		let cancelled = async {
			match cancel_token {
				Some(token) => token.cancelled().await,
				None => std::future::pending().await,
			}
		};
		tokio::select! {
			() = &mut drain => self.write_completion_marker(exit_code),
			() = cancelled => {
				if let Some(marker) = self.completion_marker.take() {
					tokio::spawn(async move {
						drain.await;
						marker.write(exit_code);
					});
				}
			},
		}
		ProcessWaitResult::Completed(output)
	}

	fn write_completion_marker(&mut self, exit_code: i32) {
		if let Some(marker) = self.completion_marker.take() {
			marker.write(exit_code);
		}
	}

	/// Reports the exit without waiting, once the process exited and its
	/// relays have forwarded its output, as [`Self::wait`] does; until then
	/// it reports nothing.
	pub(crate) fn poll(&mut self) -> Option<Result<std::process::Output, error::Error>> {
		if self.exited.is_none() {
			match self.exec_future.as_mut().now_or_never()? {
				Ok(output) => {
					self.reaped = true;
					self.exited = Some(output);
				},
				Err(err) => return Some(Err(err.into())),
			}
		}
		if !crate::outputrelay::drained_now(&mut self.output_relays) {
			return None;
		}
		let output = self.exited.take()?;
		self.write_completion_marker(completion_exit_code(&output.status));
		Some(Ok(output))
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
	/// The process stopped and has not yet completed.
	Stopped,
	/// The process was killed due to cancellation.
	Cancelled,
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
			completion_marker: None,
			output_relays: Vec::new(),
			exited: None,
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

#[cfg(test)]
mod relay_tests {
	use super::*;
	use crate::outputrelay::TestRelay;

	/// A process that exited with status 7, its output still forwarding
	/// through a relay until the returned feed finishes.
	fn exited_with_forwarding_relay() -> (TestRelay, ChildProcess) {
		#[cfg(windows)]
		let output = std::process::Command::new("cmd").args(["/C", "exit 7"]).output();
		#[cfg(not(windows))]
		let output = std::process::Command::new("sh").args(["-c", "exit 7"]).output();
		let output = output.expect("run child");
		let (forwarding, relay) = TestRelay::new(true);
		let child = ChildProcess {
			exec_future: Box::pin(async move { Ok(output) }),
			reaped: false,
			pid: None,
			pgid: None,
			stop_pids: None,
			#[cfg(windows)]
			kill_handle: None,
			completion_marker: None,
			output_relays: vec![relay],
			exited: None,
		};
		(forwarding, child)
	}

	/// Cancelling while an exited command's output still drains keeps the
	/// status the command exited with, and its completion marker still waits
	/// for that output.
	#[tokio::test]
	async fn cancellation_while_output_drains_keeps_the_exit_status() {
		use std::io::{Read, Seek, SeekFrom};

		let (forwarding, mut child) = exited_with_forwarding_relay();
		let mut marker = tempfile::tempfile().expect("marker file");
		child.set_completion_marker(
			OpenFile::from(marker.try_clone().expect("marker writer")),
			"<exit>".into(),
			"</exit>".into(),
		);
		let read_marker = |marker: &mut std::fs::File| {
			let mut text = String::new();
			marker.seek(SeekFrom::Start(0)).expect("rewind marker");
			marker.read_to_string(&mut text).expect("read marker");
			text
		};
		let cancel = CancellationToken::new();
		let trigger = cancel.clone();
		tokio::spawn(async move {
			tokio::time::sleep(std::time::Duration::from_millis(50)).await;
			trigger.cancel();
		});
		let Ok(ProcessWaitResult::Completed(output)) = child.wait(Some(cancel)).await else {
			panic!("an exited command reported as cancelled");
		};
		assert_eq!(output.status.code(), Some(7));
		assert_eq!(read_marker(&mut marker), "", "marker written ahead of the output");

		forwarding.finish();
		tokio::time::timeout(std::time::Duration::from_secs(5), async {
			while read_marker(&mut marker).is_empty() {
				tokio::time::sleep(std::time::Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("marker written once the output drained");
		assert_eq!(read_marker(&mut marker), "<exit>7</exit>");
	}

	/// The background reaper's poll reports an exited job only once its
	/// output is forwarded, and a wait after such a poll still completes.
	#[tokio::test]
	async fn poll_reports_exit_only_after_relays_drain() {
		let (forwarding, mut child) = exited_with_forwarding_relay();
		assert!(child.poll().is_none(), "reported while its output still forwards");
		forwarding.finish();
		let Some(Ok(output)) = child.poll() else {
			panic!("drained exit not reported");
		};
		assert_eq!(output.status.code(), Some(7));

		let (forwarding, mut child) = exited_with_forwarding_relay();
		assert!(child.poll().is_none());
		tokio::spawn(async move {
			tokio::time::sleep(std::time::Duration::from_millis(50)).await;
			forwarding.finish();
		});
		let Ok(ProcessWaitResult::Completed(output)) = child.wait(None).await else {
			panic!("a polled exit not completed by wait");
		};
		assert_eq!(output.status.code(), Some(7));
	}
}
