//! Nested shell execution under a low open-file limit. Each test reruns its
//! body in a child process whose soft `RLIMIT_NOFILE` is [`LIMIT`], since the
//! limit is process-wide.

#![cfg(unix)]

use std::os::unix::process::CommandExt as _;

use pi_shell::{ShellExecuteOptions, cancel::CancelToken, execute_shell};

/// Set in the child process that runs a test body.
const CHILD: &str = "PI_SHELL_TEST_DESCRIPTOR_LIMIT_CHILD";

/// The soft open-file limit of the child. Low, so that a level holding even
/// one descriptor of its own exhausts it within a few hundred levels.
const LIMIT: libc::rlim_t = 128;

/// Stack of each shell worker thread.
const STACK_BYTES: usize = 512 << 20;

fn soft_nofile() -> libc::rlim_t {
	let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
	// SAFETY: `lim` is a valid, writable `rlimit` for the duration of the call.
	assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) }, 0);
	lim.rlim_cur
}

/// Returns `true` in the child, where the test body runs under a soft limit
/// of [`LIMIT`] open files. In the test process, runs test `name` in that
/// child, checks that it ran and passed, and returns `false`.
fn in_limited_child(name: &str) -> bool {
	if std::env::var_os(CHILD).is_some() {
		assert_eq!(soft_nofile(), LIMIT, "the child must run under the lowered limit");
		return true;
	}

	let mut command = std::process::Command::new(std::env::current_exe().expect("test binary"));
	command
		.args(["--exact", name, "--nocapture"])
		.env(CHILD, "1");
	// SAFETY: runs in the forked child before exec; `getrlimit` and `setrlimit`
	// are async-signal-safe and the closure allocates nothing.
	unsafe {
		command.pre_exec(|| {
			let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
			if libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) != 0 {
				return Err(std::io::Error::last_os_error());
			}
			lim.rlim_cur = LIMIT;
			if libc::setrlimit(libc::RLIMIT_NOFILE, &raw const lim) != 0 {
				return Err(std::io::Error::last_os_error());
			}
			Ok(())
		});
	}
	let output = command.output().expect("child test process");
	let stdout = String::from_utf8_lossy(&output.stdout);
	let stderr = String::from_utf8_lossy(&output.stderr);
	assert!(
		output.status.success() && stdout.contains("1 passed"),
		"child test {name} under a soft limit of {LIMIT} open files: \
		 {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
		output.status
	);
	false
}

/// Runs `command` in a one-shot shell; returns its exit code and the merged
/// stdout and stderr.
fn run(command: &str) -> (Option<i32>, String) {
	let runtime = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.thread_stack_size(STACK_BYTES)
		.enable_all()
		.build()
		.expect("tokio runtime");
	runtime.block_on(async {
		let (tx, rx) = flume::unbounded::<String>();
		let result = execute_shell(
			ShellExecuteOptions { command: command.to_string(), ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell execution");
		(result.exit_code, rx.try_iter().collect())
	})
}

/// A nesting level that redirects nothing holds no descriptor of its own, so
/// 200 levels fit under 128 open files. Regression: each level duplicated the
/// standard streams and stopped near 40 levels under a 1,024 limit.
#[test]
fn nesting_holds_no_descriptor_per_level() {
	if !in_limited_child("nesting_holds_no_descriptor_per_level") {
		return;
	}

	let dir = tempfile::tempdir().expect("tempdir");
	let again = dir.path().join("again.sh");
	std::fs::write(
		&again,
		format!(
			"if [ $n -lt 200 ]; then n=$((n+1)); . '{}'; else echo reached=$n; fi\n",
			again.display()
		),
	)
	.expect("write the sourced script");

	let outcomes: Vec<_> = [
		(
			"function",
			"f() { if [ \"$1\" -lt 200 ]; then f $(( $1 + 1 )); else echo reached=$1; fi; }; f 0; \
			 echo after=$?"
				.to_string(),
		),
		("source", format!("n=0; . '{}'; echo after=$?", again.display())),
	]
	.into_iter()
	.map(|(shape, command)| (shape, run(&command)))
	.collect();

	let reached = (Some(0), "reached=200\nafter=0\n".to_string());
	assert_eq!(outcomes, [("function", reached.clone()), ("source", reached)]);
}

/// Running out of descriptors prints one diagnostic naming the limit, and the
/// next command still runs. Regression: the shell printed nothing.
#[test]
fn running_out_of_descriptors_names_the_limit() {
	if !in_limited_child("running_out_of_descriptors_names_the_limit") {
		return;
	}

	let (code, output) = run(
		"f() { if [ \"$1\" -lt 1000 ]; then f $(( $1 + 1 )) < /dev/null; else echo reached; fi; }; \
		 f 0; echo after=$?",
	);
	let lines: Vec<_> = output.lines().collect();
	assert_eq!(code, Some(0), "{output}");
	assert_eq!(lines.len(), 2, "{output}");
	assert_eq!(lines[1], "after=1");
	for part in [
		"failed to redirect to /dev/null: Too many open files",
		"limit of 128 open files",
		"ulimit -n",
	] {
		assert!(lines[0].contains(part), "missing {part:?} in {output}");
	}
}
