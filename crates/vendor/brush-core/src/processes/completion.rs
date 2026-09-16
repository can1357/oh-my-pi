//! Completion output and status for an owned external child.

use std::io::Write;

use crate::{openfiles::OpenFile, sys};

pub(super) struct CompletionMarker {
	pub(super) output: OpenFile,
	pub(super) end_marker_prefix: String,
	pub(super) end_marker_suffix: String,
}

impl CompletionMarker {
	pub(super) fn write(mut self, exit_code: i32) {
		let _ = write!(self.output, "{}{}{}", self.end_marker_prefix, exit_code, self.end_marker_suffix);
		let _ = self.output.flush();
	}
}

pub(super) fn completion_exit_code(status: &std::process::ExitStatus) -> i32 {
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

pub(super) async fn wait_with_output(child: sys::process::Child) -> std::io::Result<std::process::Output> {
	#[cfg(not(target_os = "macos"))]
	{ child.wait_with_output().await }
	#[cfg(target_os = "macos")]
	{
		let completion = child.wait_with_output();
		tokio::pin!(completion);
		// SIGCHLD belongs to the host process, not this embedded shell. Another
		// runtime can replace Tokio's listener after it has been registered.
		// Re-poll the same wait future so its waitpid check still collects an
		// actual exit; retain Tokio's output collection and kill-on-drop.
		let period = std::time::Duration::from_millis(100);
		let mut recheck = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
		loop {
			tokio::select! {
				biased;
				result = &mut completion => return result,
				_ = recheck.tick() => {},
			}
		}
	}
}
