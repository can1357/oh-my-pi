//! `timeout`, `nohup` and `kill` through a [`Session`]: the engine, pi's
//! host and the tools' drive loop, with real processes.

#![cfg(unix)]

use std::{
	io::{Read as _, Seek as _},
	os::unix::{ffi::OsStrExt as _, process::ExitStatusExt as _},
	path::Path,
	time::{Duration, Instant},
};

use bstr::BString;
use tokio_util::sync::CancellationToken;

use crate::session::{RunOptions, RunStdio, Session, SessionConfig};

fn session() -> Session {
	let env = std::env::vars_os()
		.filter(|(name, _)| name != "PI_DISABLE_NOHUP_BUILTIN")
		.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
		.collect();
	let cwd = std::env::current_dir().unwrap();
	Session::new(SessionConfig {
		env,
		cwd: BString::from(cwd.as_os_str().as_bytes()),
		fs: Box::new(crate::sys::StdFs::default()),
		vfs: None,
		runtime: tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.unwrap()
}

struct Ran {
	status:  i32,
	stdout:  String,
	stderr:  String,
	elapsed: Duration,
}

fn read_back(mut file: std::fs::File) -> String {
	file.rewind().unwrap();
	let mut text = String::new();
	file.read_to_string(&mut text).unwrap();
	text
}

async fn run_with(s: &mut Session, command: &str, cancel: CancellationToken) -> Ran {
	let (out, err) = (tempfile::tempfile().unwrap(), tempfile::tempfile().unwrap());
	let stdio = RunStdio {
		stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
		stdout: Some(out.try_clone().unwrap()),
		stderr: Some(err.try_clone().unwrap()),
	};
	let started = Instant::now();
	let outcome = s
		.run_with(RunOptions::new(command), stdio, cancel)
		.await
		.unwrap();
	Ran {
		status:  outcome.status,
		stdout:  read_back(out),
		stderr:  read_back(err),
		elapsed: started.elapsed(),
	}
}

async fn run(s: &mut Session, command: &str) -> Ran {
	run_with(s, command, CancellationToken::new()).await
}

fn alive(pid: i32) -> bool {
	// SAFETY: signal 0 only probes existence.
	unsafe { libc::kill(pid, 0) == 0 }
}

/// Waits (bounded) for `pid` to be gone; whether it is.
async fn gone(pid: i32, within: Duration) -> bool {
	let start = Instant::now();
	while alive(pid) && start.elapsed() < within {
		tokio::time::sleep(Duration::from_millis(20)).await;
	}
	!alive(pid)
}

/// The pid an operand wrote to `file`, once it is there.
async fn pid_in(file: &Path) -> i32 {
	let start = Instant::now();
	loop {
		if let Some(pid) = std::fs::read_to_string(file)
			.ok()
			.and_then(|t| t.trim().parse().ok())
		{
			return pid;
		}
		assert!(start.elapsed() < Duration::from_secs(10), "no pid in {}", file.display());
		tokio::time::sleep(Duration::from_millis(10)).await;
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_expires_with_124_and_leaves_no_process() {
	let mut s = session();
	let r = run(&mut s, "timeout 0.2 sleep 5").await;
	assert_eq!(r.status, 124, "{}", r.stderr);
	assert!(r.elapsed < Duration::from_secs(2), "took {:?}", r.elapsed);

	let dir = tempfile::tempdir().unwrap();
	let file = dir.path().join("pid");
	let command = format!("timeout 0.2 sh -c 'echo $$ > {}; exec sleep 5'", file.display());
	let r = run(&mut s, &command).await;
	assert_eq!(r.status, 124, "{}", r.stderr);
	let pid = pid_in(&file).await;
	assert!(gone(pid, Duration::from_millis(500)).await, "sleep {pid} survived the timeout");
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_reports_the_status_of_a_command_that_finishes() {
	let mut s = session();
	assert_eq!(run(&mut s, "timeout 5 true").await.status, 0);
	assert_eq!(run(&mut s, "timeout 5 sh -c 'exit 7'").await.status, 7);
	assert_eq!(run(&mut s, "timeout 0 true").await.status, 0);
	// Not found and not executable, as the shell reports them.
	assert_eq!(run(&mut s, "timeout 5 nosuchcommand-pi").await.status, 127);
	// Operands reach the command as they are: no re-splitting or expansion.
	let r = run(&mut s, "timeout 5 printf '[%s]' 'a b' '$HOME' ''").await;
	assert_eq!(r.stdout, "[a b][$HOME][]");
}

/// Functions and builtins run under `timeout`, as with pi's builtin.
#[tokio::test(flavor = "multi_thread")]
async fn timeout_runs_functions_and_builtins() {
	let mut s = session();
	let r = run(&mut s, "f(){ sleep 5; }; timeout 0.2 f").await;
	assert_eq!(r.status, 124);
	assert!(r.elapsed < Duration::from_secs(2), "took {:?}", r.elapsed);
	let r = run(&mut s, "g(){ echo in-g \"$@\"; return 3; }; timeout 5 g x").await;
	assert_eq!((r.status, r.stdout.as_str()), (3, "in-g x\n"));
	let r = run(&mut s, "timeout 0.2 eval 'while :; do :; done'").await;
	assert_eq!((r.status, r.stderr.as_str()), (124, ""));
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_signals_and_statuses_follow_gnu() {
	let mut s = session();
	assert_eq!(run(&mut s, "timeout -s KILL 0.2 sleep 5").await.status, 137);
	assert_eq!(
		run(&mut s, "timeout --preserve-status 0.1 sleep 5")
			.await
			.status,
		143
	);
	let r = run(&mut s, "timeout -v 0.1 sleep 5").await;
	assert_eq!(r.status, 124);
	assert_eq!(r.stderr, "timeout: sending signal TERM to command 'sleep'\n");
}

/// A command that ignores the signal is killed after `-k`, external
/// grandchildren included.
#[tokio::test(flavor = "multi_thread")]
async fn kill_after_ends_a_command_that_ignores_the_signal() {
	let mut s = session();
	let dir = tempfile::tempdir().unwrap();
	let file = dir.path().join("pid");
	let command = format!(
		"timeout -k 0.2 0.1 sh -c 'trap \"\" TERM; sleep 5 & echo $! > {}; wait'",
		file.display()
	);
	let r = run(&mut s, &command).await;
	assert_eq!(r.status, 137, "{}", r.stderr);
	assert!(r.elapsed < Duration::from_secs(2), "took {:?}", r.elapsed);
	let pid = pid_in(&file).await;
	assert!(gone(pid, Duration::from_millis(500)).await, "sleep {pid} survived -k");
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_usage_errors_exit_125() {
	let mut s = session();
	let r = run(&mut s, "timeout invalid true").await;
	assert_eq!((r.status, r.stderr.as_str()), (125, "timeout: invalid time interval 'invalid'\n"));
	assert_eq!(run(&mut s, "timeout").await.status, 125);
	assert_eq!(run(&mut s, "timeout -s NOSUCH 1 true").await.status, 125);
	assert_eq!(run(&mut s, "timeout -k bogus 1 true").await.status, 125);
	let r = run(&mut s, "timeout --help").await;
	assert_eq!(r.status, 0);
	assert!(r.stdout.starts_with("Usage: timeout"), "{}", r.stdout);
}

/// Cancelling the run that waits in `timeout` ends the command too.
#[tokio::test(flavor = "multi_thread")]
async fn cancel_reaches_the_timed_command() {
	let mut s = session();
	let dir = tempfile::tempdir().unwrap();
	let file = dir.path().join("pid");
	let cancel = CancellationToken::new();
	let command = format!("timeout 30 sh -c 'echo $$ > {}; exec sleep 30'", file.display());
	let trigger = cancel.clone();
	let probe = async {
		let pid = pid_in(&file).await;
		trigger.cancel();
		pid
	};
	let (r, pid) = tokio::join!(run_with(&mut s, &command, cancel), probe);
	assert_eq!(r.status, 143);
	assert!(gone(pid, Duration::from_secs(3)).await, "sleep {pid} survived the cancel");
}

#[tokio::test(flavor = "multi_thread")]
async fn nohup_reports_its_command_status() {
	let mut s = session();
	assert_eq!(run(&mut s, "nohup false").await.status, 1);
	assert_eq!(run(&mut s, "nohup sh -c 'exit 7'").await.status, 7);
	let r = run(&mut s, "nohup").await;
	assert_eq!((r.status, r.stderr.as_str()), (125, "nohup: missing operand\n"));
	let r = run(&mut s, "nohup --help").await;
	assert!(r.status == 0 && r.stdout.starts_with("Usage: nohup"), "{}", r.stdout);
	let r = run(&mut s, "nohup -- echo --help").await;
	assert_eq!(r.stdout, "--help\n");
}

/// pi's `nohup_background_captures_operand_pid`: `$!` of `nohup cmd &` is
/// usable, and a signal to it reaches the command.
#[tokio::test(flavor = "multi_thread")]
async fn nohup_in_the_background_has_a_usable_pid() {
	let mut s = session();
	let r = run(
		&mut s,
		"nohup sh -c 'exit 0' >/dev/null 2>&1 & pid=$!; printf 'pid=%s\\n' \"$pid\"; test -n \
		 \"$pid\"",
	)
	.await;
	assert_eq!(r.status, 0);
	let pid = r.stdout.trim().strip_prefix("pid=").expect("pid= line");
	assert!(pid.parse::<i32>().is_ok_and(|pid| pid > 0), "{}", r.stdout);
	let r = run(&mut s, "nohup sleep 30 & kill $!; wait $!; echo st=$?").await;
	assert_eq!(r.stdout, "st=143\n");
	assert!(r.elapsed < Duration::from_secs(5), "took {:?}", r.elapsed);
}

/// `nohup cmd &` outlives the cancel of the run that started it and the
/// session itself.
#[tokio::test(flavor = "multi_thread")]
async fn nohup_operand_survives_cancel_and_teardown() {
	let mut s = session();
	let dir = tempfile::tempdir().unwrap();
	let file = dir.path().join("pid");
	let cancel = CancellationToken::new();
	let command =
		format!("nohup sh -c 'echo $$ > {}; exec sleep 30' >/dev/null 2>&1 & wait", file.display());
	let trigger = cancel.clone();
	let probe = async {
		let pid = pid_in(&file).await;
		trigger.cancel();
		pid
	};
	let (r, pid) = tokio::join!(run_with(&mut s, &command, cancel), probe);
	let _reap = Reap(pid);
	assert_ne!(r.status, 0, "the run was cancelled");
	tokio::time::sleep(Duration::from_millis(1500)).await;
	assert!(alive(pid), "the nohup operand died with the cancel");
	assert_eq!(run(&mut s, "echo ok").await.stdout, "ok\n");
	drop(s);
	tokio::time::sleep(Duration::from_millis(1500)).await;
	assert!(alive(pid), "the nohup operand died with the session");
}

/// Kills a process when dropped (a test's cleanup, even when it fails).
struct Reap(i32);

impl Drop for Reap {
	fn drop(&mut self) {
		// SAFETY: plain syscall; the test's own child tree.
		unsafe { libc::kill(self.0, libc::SIGKILL) };
	}
}

/// The engine's `kill` takes job specs; `%1` ends the job, whose status
/// `wait` then reports.
#[tokio::test(flavor = "multi_thread")]
async fn kill_of_a_job_spec_ends_the_job() {
	let mut s = session();
	let r = run(&mut s, "sleep 30 & kill %1; wait %1; echo st=$?").await;
	assert_eq!(r.stdout, "st=143\n", "{}", r.stderr);
	assert!(r.elapsed < Duration::from_secs(5), "took {:?}", r.elapsed);
}

/// pi's `kill_builtin_refuses_*`: no signal reaches pi's own process group or
/// an ancestor; probes and unrelated processes still work.
#[tokio::test(flavor = "multi_thread")]
async fn kill_refuses_pi_and_its_ancestors() {
	let mut s = session();
	let r = run(
		&mut s,
		"kill -CONT $PPID; echo ancestor=$?; kill -CONT -- 0; echo group=$?; kill -0 $PPID; echo \
		 probe=$?",
	)
	.await;
	assert!(r.stdout.contains("ancestor=1"), "{}", r.stdout);
	assert!(r.stdout.contains("group=1"), "{}", r.stdout);
	assert!(r.stdout.contains("probe=0"), "{}", r.stdout);
	assert!(r.stderr.contains("refusing to signal the shell process"), "{}", r.stderr);

	let mut child = std::process::Command::new("/bin/sleep")
		.arg("30")
		.spawn()
		.unwrap();
	let r = run(&mut s, &format!("kill -TERM {}; echo child=$?", child.id())).await;
	assert_eq!(r.stdout, "child=0\n", "{}", r.stderr);
	assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGTERM));
}
