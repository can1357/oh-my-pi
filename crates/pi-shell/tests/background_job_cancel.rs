//! Cancelling a run reaches the in-process background jobs it started, so a
//! run cancelled while it `wait`s on one ends at once and reports why.
#![cfg(unix)]

use std::time::{Duration, Instant};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Each `&` job had a token of its own that the run's token did not reach, so
/// the cancelled run sat in `wait` until the host's 2 s grace aborted it, and
/// the `interrupted` diagnostics were lost.
#[tokio::test(flavor = "multi_thread")]
async fn cancelled_run_stops_waiting_on_its_background_job() {
	for script in ["sleep 20 & wait; echo after", "{ sleep 20; } & wait %1; echo after"] {
		let (tx, rx) = flume::unbounded::<String>();
		let started = Instant::now();
		let result = Shell::new(None)
			.run(
				ShellRunOptions { command: script.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(300)),
			)
			.await
			.expect("run");
		let elapsed = started.elapsed();
		let output: String = rx.drain().collect();

		assert!(elapsed < Duration::from_millis(1500), "`{script}` took {elapsed:?}");
		assert!(output.contains("interrupted"), "`{script}` lost its diagnostics: {output:?}");
		assert!(!output.contains("after"), "`{script}` kept running: {output:?}");
		assert_eq!(result.exit_code, None, "`{script}`");
	}
}

/// Whether each pid written in `files` still names a live process that is
/// not a zombie.
#[cfg(target_os = "linux")]
fn alive(files: &[std::path::PathBuf]) -> Vec<bool> {
	files
		.iter()
		.map(|file| {
			let pid = std::fs::read_to_string(file).expect("pid file");
			std::fs::read_to_string(format!("/proc/{}/stat", pid.trim())).is_ok_and(|stat| {
				stat
					.rsplit(')')
					.next()
					.is_some_and(|rest| !rest.trim_start().starts_with('Z'))
			})
		})
		.collect()
}

/// With job control on (`set -m`) an external job stays in the host's
/// session, so SIGTSTP can stop it, where without it each child leads a
/// session of its own. Cancelling the run, and the run ending on its own,
/// must treat the children the same either way: the foreground child of a
/// cancelled run ends, and a background job fares as it does without job
/// control.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn set_m_children_end_with_the_run_as_without_it() {
	let mut outcomes = Vec::new();
	for job_control in ["set +m", "set -m"] {
		let files = tempfile::tempdir().expect("pid files");
		let pid_files = ["bg", "fg", "finished-bg"].map(|name| files.path().join(name));
		let [bg, fg, finished_bg] = pid_files
			.each_ref()
			.map(|file| file.to_str().expect("utf8 path").to_owned());
		let cancelled = format!(
			"{job_control}; /bin/sh -c 'echo $$ > \"$1\"; exec sleep 30' sh '{bg}' & /bin/sh -c \
			 'echo $$ > \"$1\"; exec sleep 30' sh '{fg}'"
		);
		Shell::new(None)
			.run(
				ShellRunOptions { command: cancelled, ..Default::default() },
				None,
				CancelToken::new(Some(500)),
			)
			.await
			.expect("cancelled run");
		tokio::time::sleep(Duration::from_millis(500)).await;
		let after_cancel = alive(&pid_files[..2]);

		let finished = format!(
			"{job_control}; /bin/sh -c 'echo $$ > \"$1\"; exec sleep 30' sh '{finished_bg}' & until \
			 [ -s '{finished_bg}' ]; do sleep 0.01; done; echo started"
		);
		let (tx, rx) = flume::unbounded::<String>();
		Shell::new(None)
			.run(
				ShellRunOptions { command: finished, ..Default::default() },
				Some(tx),
				CancelToken::new(Some(20_000)),
			)
			.await
			.expect("finished run");
		assert!(rx.drain().collect::<String>().contains("started"));
		tokio::time::sleep(Duration::from_millis(500)).await;
		let after_finish = alive(&pid_files[2..]);

		for file in &pid_files {
			if let Ok(pid) = std::fs::read_to_string(file)
				&& let Ok(pid) = pid.trim().parse::<i32>()
			{
				// SAFETY: `kill` takes no pointers; the pid is one this test
				// started.
				unsafe { libc::kill(pid, libc::SIGKILL) };
			}
		}
		outcomes.push((job_control, after_cancel, after_finish));
	}
	assert!(!outcomes[0].1[1], "the cancelled run's foreground child survived: {outcomes:?}");
	assert_eq!(
		(&outcomes[0].1, &outcomes[0].2),
		(&outcomes[1].1, &outcomes[1].2),
		"set -m changed which children outlive the run: {outcomes:?}"
	);
}
