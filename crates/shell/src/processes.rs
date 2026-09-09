//! Process management

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
#[cfg(windows)]
use std::ptr;
use std::{future, io, io::Write, pin, process};

use futures::FutureExt;
#[cfg(unix)]
use nix::sys::signal;
#[cfg(unix)]
use nix::{errno::Errno, unistd::Pid};
use tokio_util::sync::CancellationToken;

use crate::{error, openfiles::OpenFile, sys};

/// A portable subset of signals accepted by environment process controls.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessSignal {
	/// Hang up the process group.
	Hangup,
	/// Interrupt the process group.
	Interrupt,
	/// Request a core-producing quit.
	Quit,
	/// Ask the process group to terminate cleanly.
	Terminate,
	/// Unconditionally kill the process group.
	Kill,
	/// Send the first user-defined signal.
	User1,
	/// Send the second user-defined signal.
	User2,
	/// Continue stopped processes.
	Continue,
	/// Stop the process group.
	Stop,
	/// Notify the process group of a terminal window change.
	WindowChanged,
}

/// Sends `signal` to every process in `pgid`.
///
/// Process groups are the cancellation ownership boundary used by embedders.
/// A missing group is treated as already stopped.
#[cfg(unix)]
pub fn signal_process_group(pgid: i32, requested_signal: ProcessSignal) -> Result<(), io::Error> {
	if pgid <= 0 {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "process-group id must be positive"));
	}
	let signal_name = process_signal_name(requested_signal);
	let signal = match requested_signal {
		ProcessSignal::Hangup => signal::Signal::SIGHUP,
		ProcessSignal::Interrupt => signal::Signal::SIGINT,
		ProcessSignal::Quit => signal::Signal::SIGQUIT,
		ProcessSignal::Terminate => signal::Signal::SIGTERM,
		ProcessSignal::Kill => signal::Signal::SIGKILL,
		ProcessSignal::User1 => signal::Signal::SIGUSR1,
		ProcessSignal::User2 => signal::Signal::SIGUSR2,
		ProcessSignal::Continue => signal::Signal::SIGCONT,
		ProcessSignal::Stop => signal::Signal::SIGSTOP,
		ProcessSignal::WindowChanged => signal::Signal::SIGWINCH,
	};
	match signal::kill(Pid::from_raw(-pgid), signal) {
		Ok(()) => {
			match requested_signal {
				ProcessSignal::Terminate => {
					tracing::info!(
						pgid,
						signal = signal_name,
						"shell process group termination requested"
					);
				},
				ProcessSignal::Kill => {
					tracing::warn!(
						pgid,
						signal = signal_name,
						"shell process group force kill delivered"
					);
				},
				_ => {
					tracing::debug!(pgid, signal = signal_name, "shell process group signal delivered");
				},
			}
			Ok(())
		},
		Err(Errno::ESRCH) => {
			tracing::info!(pgid, signal = signal_name, "shell process group already exited");
			Ok(())
		},
		Err(error) => {
			tracing::warn!(
				pgid,
				signal = signal_name,
				error = %error,
				"failed to signal shell process group"
			);
			Err(io::Error::from_raw_os_error(error as i32))
		},
	}
}

/// Sends `signal` to a process when process groups are unavailable.
#[cfg(not(unix))]
pub fn signal_process_group(pgid: i32, signal: ProcessSignal) -> Result<(), io::Error> {
	tracing::warn!(
		pgid,
		signal = process_signal_name(signal),
		"process-group signalling is unsupported on this platform"
	);
	Err(io::Error::new(
		io::ErrorKind::Unsupported,
		"process-group signalling is unsupported on this platform",
	))
}

const fn process_signal_name(signal: ProcessSignal) -> &'static str {
	match signal {
		ProcessSignal::Hangup => "hangup",
		ProcessSignal::Interrupt => "interrupt",
		ProcessSignal::Quit => "quit",
		ProcessSignal::Terminate => "terminate",
		ProcessSignal::Kill => "kill",
		ProcessSignal::User1 => "user1",
		ProcessSignal::User2 => "user2",
		ProcessSignal::Continue => "continue",
		ProcessSignal::Stop => "stop",
		ProcessSignal::WindowChanged => "window_changed",
	}
}

struct CompletionMarker {
	output:            OpenFile,
	end_marker_prefix: String,
	end_marker_suffix: String,
}

/// A waitable future that will yield the results of a child process's
/// execution.
pub(crate) type WaitableChildProcess =
	pin::Pin<Box<dyn futures::Future<Output = Result<process::Output, io::Error>> + Send + Sync>>;

/// Tracks a child process being awaited.
pub struct ChildProcess {
	/// A waitable future that will yield the results of a child process's
	/// execution.
	exec_future:       WaitableChildProcess,
	/// Tracks whether this process has already been reaped.
	reaped:            bool,
	/// If available, the process ID of the child.
	pid:               Option<sys::process::ProcessId>,
	/// If available, the process group ID of the child.
	pgid:              Option<sys::process::ProcessId>,
	/// Windows handle duplicated from the child process for safe termination.
	#[cfg(windows)]
	kill_handle:       Option<OwnedHandle>,
	completion_marker: Option<CompletionMarker>,
	terminate_on_drop: bool,
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
			reaped: false,
			#[cfg(windows)]
			kill_handle,
			completion_marker: None,
			terminate_on_drop: true,
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

	/// Detaches the process so dropping its managed job does not terminate it.
	pub(crate) fn detach(mut self) {
		self.terminate_on_drop = false;
		let _reaper = tokio::spawn(async move {
			match self.exec_future.as_mut().await {
				Ok(output) => {
					let marker_exit_code = completion_exit_code(&output.status);
					self.record_exit(&output);
					self.reaped = true;
					self.write_completion_marker(marker_exit_code);
				},
				Err(error) => {
					tracing::warn!(
						pid = ?self.pid,
						pgid = ?self.pgid,
						error = %error,
						"failed to reap detached shell child process"
					);
				},
			}
		});
	}

	/// Allows the process to survive when its managed job table is dropped.
	pub(crate) const fn preserve_on_drop(&mut self) {
		self.terminate_on_drop = false;
	}

	/// Waits for the process to exit.
	///
	/// If a cancellation token is provided and triggered, the process will be
	/// killed.
	pub async fn wait(
		&mut self,
		cancel_token: Option<CancellationToken>,
	) -> Result<ProcessWaitResult, error::Error> {
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigtstp = sys::signal::tstp_signal_listener()?;
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigchld = sys::signal::chld_signal_listener()?;

		let cancelled = async {
			match &cancel_token {
				Some(token) => token.cancelled().await,
				None => future::pending().await,
			}
		};
		tokio::pin!(cancelled);

		#[allow(
			clippy::ignored_unit_patterns,
			reason = "the signal listener's unit notification is intentionally ignored"
		)]
		loop {
			tokio::select! {
				output = &mut self.exec_future => {
					let output = output?;
					let marker_exit_code = completion_exit_code(&output.status);
					self.record_exit(&output);
					self.reaped = true;
					self.write_completion_marker(marker_exit_code);
					break Ok(ProcessWaitResult::Completed(output))
				},
				_ = &mut cancelled => {
					self.kill();
					self.write_completion_marker(130);
					break Ok(ProcessWaitResult::Cancelled)
				},
				_ = sigtstp.recv() => {
					break Ok(ProcessWaitResult::Stopped)
				},
				_ = sigchld.recv() => {
					if sys::signal::poll_for_stopped_children()? {
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
			tracing::warn!(
				pid,
				pgid = ?self.pgid,
				"force killing shell child process"
			);
			let _ = signal::kill(Pid::from_raw(pid), signal::Signal::SIGKILL);
		}

		#[cfg(windows)]
		{
			tracing::warn!(
				pid = ?self.pid,
				pgid = ?self.pgid,
				"force terminating shell child process"
			);
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

	fn record_exit(&self, output: &process::Output) {
		tracing::info!(
			pid = ?self.pid,
			pgid = ?self.pgid,
			exit_code = ?output.status.code(),
			success = output.status.success(),
			"shell child process exited"
		);
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

	pub(crate) fn poll(&mut self) -> Option<Result<process::Output, error::Error>> {
		let result = self.exec_future.as_mut().now_or_never()?;
		Some(match result {
			Ok(output) => {
				let marker_exit_code = completion_exit_code(&output.status);
				self.record_exit(&output);
				self.reaped = true;
				self.write_completion_marker(marker_exit_code);
				Ok(output)
			},
			Err(err) => Err(err.into()),
		})
	}
}

impl Drop for ChildProcess {
	fn drop(&mut self) {
		if self.terminate_on_drop {
			self.kill();
		}
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
	let mut out_handle = ptr::null_mut();
	// SAFETY: `current` is a valid current-process pseudo-handle, `handle` is
	// an OS process handle owned by Tokio's child process object, and
	// `out_handle` is a valid out pointer checked below before ownership is
	// transferred to OwnedHandle.
	let ok = unsafe {
		DuplicateHandle(current, handle, current, &mut out_handle, 0, 0, DUPLICATE_SAME_ACCESS)
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

/// Checks whether a duplicated Windows process handle still refers to a running
/// process.
#[cfg(windows)]
pub fn process_handle_is_running(handle: &OwnedHandle) -> bool {
	use windows_sys::Win32::{Foundation::WAIT_TIMEOUT, System::Threading::WaitForSingleObject};

	// SAFETY: `handle` is a live duplicated process handle with synchronization
	// access.
	unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_TIMEOUT }
}

/// Terminates the process referenced by a duplicated Windows process handle.
#[cfg(windows)]
pub fn terminate_process_handle(handle: &OwnedHandle) -> bool {
	terminate_raw_handle(handle.as_raw_handle())
}

#[cfg(windows)]
fn terminate_process_id(pid: sys::process::ProcessId) -> bool {
	use windows_sys::Win32::{
		Foundation::CloseHandle,
		System::Threading::{OpenProcess, PROCESS_TERMINATE},
	};

	let Ok(pid) = u32::try_from(pid) else {
		return false;
	};

	// SAFETY: OpenProcess is called with PROCESS_TERMINATE for a numeric process
	// id. A null handle is handled below.
	let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
	if handle.is_null() {
		return false;
	}

	let terminated = terminate_raw_handle(handle);
	// SAFETY: The handle was returned by OpenProcess and is closed exactly once
	// here.
	let _close_result = unsafe { CloseHandle(handle) };
	terminated
}

fn completion_exit_code(status: &process::ExitStatus) -> i32 {
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
	Completed(process::Output),
	/// The process stopped and has not yet completed.
	Stopped,
	/// The process was killed due to cancellation.
	Cancelled,
}
