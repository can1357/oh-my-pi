//! A cancelled run's command substitutions are gone when `Shell::run`
//! returns. The test body runs in a child process whose soft `RLIMIT_NOFILE`
//! is raised to its hard limit, as the omp host's is: under the default 1,024
//! a runaway recursion of substitutions stops at `EMFILE` instead of running
//! until the timeout.

#![cfg(target_os = "linux")]

use std::os::unix::process::CommandExt as _;

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Set in the child process that runs a test body.
const CHILD: &str = "PI_SHELL_TEST_RAISED_NOFILE_CHILD";

/// Returns `true` in the child, where the soft open-file limit equals the
/// hard one. In the test process, runs test `name` in that child, checks that
/// it ran and passed, and returns `false`.
fn in_raised_limit_child(name: &str) -> bool {
	if std::env::var_os(CHILD).is_some() {
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
			lim.rlim_cur = lim.rlim_max;
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
		"child test {name} with the soft open-file limit raised: \
		 {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
		output.status
	);
	false
}

fn open_descriptors() -> usize {
	std::fs::read_dir("/proc/self/fd")
		.expect("descriptors")
		.count()
}

/// A `PS4` that turns `set -x` back on recurses through command
/// substitutions without end, as in Bash. When a persistent shell's run
/// times out, it returns only after those substitutions are gone: the host
/// has its baseline descriptors at the moment `run` returns, in each of three
/// repeats, with the 12 s timeout the review used. Before, the run returned
/// while thousands of substitutions still held their pipes, for seconds.
#[test]
fn a_timed_out_run_returns_after_its_substitutions_are_gone() {
	if !in_raised_limit_child("a_timed_out_run_returns_after_its_substitutions_are_gone") {
		return;
	}
	let runtime = tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()
		.expect("tokio runtime");
	runtime.block_on(async {
		let shell = Shell::new(None);
		let warmup = shell
			.run(
				ShellRunOptions { command: ":".into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.expect("warmup run");
		assert_eq!(warmup.exit_code, Some(0));
		let baseline = open_descriptors();
		for repeat in 0..3 {
			let (tx, rx) = flume::unbounded::<String>();
			let drain = tokio::spawn(async move { while rx.recv_async().await.is_ok() {} });
			let result = shell
				.run(
					ShellRunOptions {
						command: "PS4='$(set -x; printf P)+ '; set -x; :".into(),
						..Default::default()
					},
					Some(tx),
					CancelToken::new(Some(12_000)),
				)
				.await
				.expect("run");
			let at_return = open_descriptors();
			assert!(result.timed_out, "repeat {repeat}: {result:?}");
			assert!(
				at_return <= baseline,
				"repeat {repeat}: {at_return} descriptors open when run returned, {baseline} before"
			);
			drain.abort();
		}
	});
}
