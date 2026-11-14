//! How the cli tests start processes, all through [`command`]: hermetic (no
//! variable of the caller that changes what obash does, stdin `/dev/null`,
//! stdout and stderr pipes, on Unix nothing but stdio inherited) and bounded
//! (on Unix in its own process group, killed with whatever it left in it).

#![allow(dead_code, reason = "each test crate uses a subset")]

use std::{
	ffi::OsStr,
	io::Read,
	process::{Child, Command, ExitStatus, Output, Stdio},
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

/// Variables of the caller that change what obash does: the startup files
/// and options bash imports, the fault injector's and the fs mode.
const CALLER_VARS: [&str; 13] = [
	"BASH_ENV",
	"ENV",
	"SHELLOPTS",
	"BASHOPTS",
	"POSIXLY_CORRECT",
	"POSIX_PEDANTIC",
	"PI_SHELL_FAULT",
	"PI_SHELL_FAULT_MODE",
	"PI_SHELL_FAULT_LOST",
	"PI_SHELL_FAULT_STATS",
	"PI_SHELL_FAULT_DEPTH",
	"PI_SHELL_LOST_LOG",
	"PI_SHELL_FS",
];

/// How long a test process may run before it is killed.
pub const LIMIT: Duration = Duration::from_secs(30);

/// The fds above 2 this test process has open.
#[cfg(unix)]
pub fn open_fds() -> Vec<i32> {
	let dir = if cfg!(target_os = "linux") {
		"/proc/self/fd"
	} else {
		"/dev/fd"
	};
	std::fs::read_dir(dir)
		.unwrap()
		.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
		.filter(|&fd| fd > 2)
		.collect()
}

/// `program`, started hermetically (see the module docs). On Unix every fd
/// above 2 gets close-on-exec before `exec`, so the process inherits
/// nothing but stdio whatever the runner left open; fds other threads open
/// after the listing fall in a 64-fd margin.
pub fn command(program: impl AsRef<OsStr>) -> Command {
	let mut cmd = Command::new(program);
	for var in CALLER_VARS {
		cmd.env_remove(var);
	}
	cmd.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt;

		let top = open_fds().into_iter().max().unwrap_or(2) + 64;
		cmd.process_group(0);
		// SAFETY: the hook runs in the forked child before `exec` and only
		// calls fcntl (async-signal-safe) on the child's own descriptor table.
		unsafe {
			cmd.pre_exec(move || {
				for fd in 3..=top {
					libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
				}
				Ok(())
			});
		}
	}
	cmd
}

/// [`command`] for the obash under test.
pub fn obash() -> Command {
	command(env!("CARGO_BIN_EXE_obash"))
}

/// Run `cmd` (from [`command`]) to its end within [`LIMIT`]: its output and
/// pid.
pub fn run(cmd: &mut Command) -> (Output, u32) {
	let child = cmd.spawn().unwrap();
	let pid = child.id();
	(finish(child, LIMIT), pid)
}

/// [`run`]'s output.
pub fn output(cmd: &mut Command) -> Output {
	run(cmd).0
}

/// The output of `child` (spawned from [`command`]) once it exits; it is
/// killed after `limit` (the test fails). Its pipes are drained meanwhile,
/// so a chatty process cannot block on them, and what it left in its
/// process group is killed after it exits.
pub fn finish(mut child: Child, limit: Duration) -> Output {
	let stdout = drain(child.stdout.take());
	let stderr = drain(child.stderr.take());
	let deadline = Instant::now() + limit;
	let status: ExitStatus = loop {
		if let Some(status) = child.try_wait().unwrap() {
			break status;
		}
		if Instant::now() >= deadline {
			kill_all(&mut child);
			let _ = child.wait();
			panic!("pid {} did not finish within {limit:?}", child.id());
		}
		thread::sleep(Duration::from_millis(5));
	};
	kill_all(&mut child);
	Output { status, stdout: stdout.join().unwrap(), stderr: stderr.join().unwrap() }
}

/// Read `pipe` to its end on a thread.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> JoinHandle<Vec<u8>> {
	thread::spawn(move || {
		let mut bytes = Vec::new();
		if let Some(mut pipe) = pipe {
			pipe.read_to_end(&mut bytes).unwrap();
		}
		bytes
	})
}

/// Kill `child` (spawned from [`command`]) and, on Unix, everything in its
/// process group.
pub fn kill_all(child: &mut Child) {
	#[cfg(unix)]
	{
		let group = i32::try_from(child.id()).unwrap();
		// SAFETY: signals the process group `command` created; a group
		// already gone answers ESRCH.
		unsafe { libc::killpg(group, libc::SIGKILL) };
	}
	// The process itself (on Unix the group took it already).
	let _ = child.kill();
}
