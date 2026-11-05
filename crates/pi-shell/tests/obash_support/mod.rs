//! How the cli tests start processes, all through [`command`]: hermetic
//! (none of the caller's environment — a fixed [`PATH`] and the account's
//! own name, nothing else — stdin `/dev/null`, stdout and stderr pipes, on
//! Unix nothing but stdio inherited) and bounded (on Unix in its own
//! process group, killed with whatever it left in it).

#![allow(dead_code, reason = "each test crate uses a subset")]

use std::{
	ffi::OsStr,
	io::Read,
	process::{Child, Command, ExitStatus, Output, Stdio},
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};
#[cfg(unix)]
use std::{
	ffi::{CStr, OsString},
	os::unix::ffi::OsStringExt as _,
	sync::LazyLock,
};

/// The `PATH` the test process gets, instead of the caller's. The tests
/// that run a real external (`sh`, `cat`) need one, and a fixed one keeps
/// which binary they run out of the caller's hands: under a launcher whose
/// `PATH` has no coreutils, `cat` was not found and the test failed. A test
/// that cares about the search sets its own.
const PATH: &str = "/usr/bin:/bin";

/// The name of the account the tests run as, read from the password
/// database rather than taken from the caller's `USER`.
///
/// The shell answers `$USERNAME` out of `USER`
/// (`crates/pi-shell/src/process/host.rs`, `read_user`), and two tests need
/// a real name in it: `zsh_mod_files_owners_match_zsh` chowns to
/// `$USERNAME` and `zsh_mod_watch` watches `$USER`. Clearing the
/// environment leaves them with no name at all, and inheriting one lets the
/// caller hand them somebody else's; the uid answers the question the tests
/// are actually asking.
#[cfg(unix)]
static ACCOUNT_NAME: LazyLock<Option<OsString>> = LazyLock::new(|| {
	let mut buf = vec![0u8; 1024];
	loop {
		// SAFETY: `passwd` is plain data, so an all-zero one is valid; the
		// call below overwrites it before anything reads it.
		let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
		let mut found: *mut libc::passwd = std::ptr::null_mut();
		// SAFETY: `pwd`, `found` and `buf` are live for the call and passed
		// with `buf`'s real length; `getpwuid_r` writes only into them, and
		// `getuid` has no preconditions.
		let rc = unsafe {
			libc::getpwuid_r(
				libc::getuid(),
				std::ptr::from_mut(&mut pwd),
				buf.as_mut_ptr().cast(),
				buf.len(),
				std::ptr::from_mut(&mut found),
			)
		};
		if rc == libc::ERANGE && buf.len() < 1 << 16 {
			buf.resize(buf.len() * 2, 0);
			continue;
		}
		if rc != 0 || found.is_null() {
			return None;
		}
		// SAFETY: a non-null `found` means `pwd` is filled in and `pw_name`
		// points into `buf`, which is still alive here.
		let name = unsafe { CStr::from_ptr(pwd.pw_name) };
		return Some(OsString::from_vec(name.to_bytes().to_vec()));
	}
});

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
	cmd.env_clear().env("PATH", PATH);
	#[cfg(unix)]
	if let Some(user) = ACCOUNT_NAME.as_deref() {
		cmd.env("USER", user);
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
