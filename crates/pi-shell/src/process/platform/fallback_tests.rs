use std::{process::Command, time::Duration};

use super::*;

#[tokio::test]
async fn proc_start_time_fallback_kills_and_observes_exit() {
	let mut child = Command::new("sleep")
		.arg("30")
		.spawn()
		.expect("spawn sleep");
	let pid = i32::try_from(child.id()).expect("child pid fits in i32");
	let start_time = read_live_start_time(pid).expect("read child start time");
	let process = Process { pid, identity: ProcessIdentity::ProcStartTime { start_time } };
	assert_eq!(process.status(), ProcessStatus::Running);

	let signaled = process.kill(libc::SIGTERM);
	let exit_observed = tokio::time::timeout(Duration::from_secs(5), process.exited()).await;
	let status_after_exit = process.status();
	let signal_after_exit = process.kill(libc::SIGKILL);
	let _ = child.kill();
	let _ = child.wait();

	assert!(signaled, "the matching start-time identity must permit signaling");
	assert!(
		exit_observed.is_ok_and(|result| result.is_ok()),
		"fallback exit polling must resolve after the process exits"
	);
	assert_eq!(status_after_exit, ProcessStatus::Exited, "an exited/zombie child is not live");
	assert!(!signal_after_exit, "an exited process must not be signaled");
}

#[test]
fn proc_start_time_fallback_rejects_mismatched_identity_before_kill() {
	let mut child = Command::new("sleep")
		.arg("30")
		.spawn()
		.expect("spawn sleep");
	let pid = i32::try_from(child.id()).expect("child pid fits in i32");
	let start_time = read_live_start_time(pid).expect("read child start time");
	let wrong_start_time = if start_time == u64::MAX {
		start_time - 1
	} else {
		start_time + 1
	};
	let process =
		Process { pid, identity: ProcessIdentity::ProcStartTime { start_time: wrong_start_time } };

	let status = process.status();
	let signaled = process.kill(libc::SIGKILL);
	let original_process_survived = read_live_start_time(pid) == Some(start_time);
	let _ = child.kill();
	let _ = child.wait();

	assert_eq!(status, ProcessStatus::Exited, "a mismatched start time is not this process");
	assert!(!signaled, "a mismatched start-time identity must never signal the raw pid");
	assert!(original_process_survived, "the actual process must survive the rejected signal");
}
