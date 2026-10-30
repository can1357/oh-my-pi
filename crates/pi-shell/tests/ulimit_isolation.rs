//! Regression tests for oh-my-pi issue #13325: `ulimit` in the embedded shell
//! must never change the host process's own resource limits. The shell runs
//! in-process and `( … )` subshells are clones, not forks, so limits live in
//! shell state and apply only to the external commands the shell spawns.
//!
//! This lives in `tests/` (a process of its own) on purpose: on regression the
//! builtin lowers the test process's `RLIMIT_NOFILE`.

#![cfg(unix)]

use pi_shell::{ShellExecuteOptions, cancel::CancelToken, execute_shell};

fn host_nofile() -> (libc::rlim_t, libc::rlim_t) {
	let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
	// SAFETY: `lim` is a valid, writable `rlimit` for the duration of the call.
	assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) }, 0);
	(lim.rlim_cur, lim.rlim_max)
}

fn format_limit(value: libc::rlim_t) -> String {
	if value == libc::RLIM_INFINITY {
		"unlimited".to_string()
	} else {
		value.to_string()
	}
}

async fn run(command: &str) -> (Option<i32>, Vec<String>) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions { command: command.to_string(), ..Default::default() },
		Some(tx),
		CancelToken::default(),
	)
	.await
	.expect("shell execution");
	let output: String = rx.try_iter().collect();
	(result.exit_code, output.lines().map(str::to_string).collect())
}

/// `( ulimit …; cmd )` caps `cmd` and nothing else: the subshell and its
/// children see the new limit, the parent shell and its later children keep
/// the host's, and the host process itself is untouched.
#[tokio::test(flavor = "multi_thread")]
async fn subshell_ulimit_caps_children_without_touching_host() {
	let (soft, hard) = host_nofile();
	let lowered = soft.min(4096) - 7;

	let (code, lines) = run(&format!(
		"( ulimit -S -n {lowered}; ulimit -S -n; /bin/sh -c 'ulimit -S -n' ); ulimit -S -n; /bin/sh \
		 -c 'ulimit -S -n'"
	))
	.await;

	assert_eq!(code, Some(0), "output: {lines:?}");
	let host = format_limit(soft);
	assert_eq!(lines, [lowered.to_string(), lowered.to_string(), host.clone(), host]);
	assert_eq!(host_nofile(), (soft, hard), "host RLIMIT_NOFILE must be unchanged");
}

/// A bare `ulimit` still reaches the shell's later children, but never the
/// host process.
#[tokio::test(flavor = "multi_thread")]
async fn bare_ulimit_caps_children_without_touching_host() {
	let (soft, hard) = host_nofile();
	let lowered = soft.min(4096) - 11;

	let (code, lines) = run(&format!("ulimit -S -n {lowered}; /bin/sh -c 'ulimit -S -n'")).await;

	assert_eq!(code, Some(0), "output: {lines:?}");
	assert_eq!(lines, [lowered.to_string()]);
	assert_eq!(host_nofile(), (soft, hard), "host RLIMIT_NOFILE must be unchanged");
}
