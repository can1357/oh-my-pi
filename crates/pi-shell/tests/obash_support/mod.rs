//! How the cli tests start processes, all through [`command`]: hermetic
//! (none of the caller's environment — a [`TEST_PATH`] naming one
//! directory this harness makes and fills, and the account's own name,
//! nothing else — stdin `/dev/null`, stdout and stderr pipes, on Unix
//! nothing but stdio inherited) and bounded (on Unix in its own process
//! group, killed with whatever it left in it).

#![allow(dead_code, reason = "each test crate uses a subset")]

use std::{
	ffi::{OsStr, OsString},
	io::Read,
	path::{Path, PathBuf},
	process::{Child, Command, ExitStatus, Output, Stdio},
	sync::LazyLock,
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};
#[cfg(unix)]
use std::{ffi::CStr, os::unix::ffi::OsStringExt as _};

/// The programs the tests resolve through `PATH`, found by tracing
/// `execve` across every test that starts a process through [`command`]
/// rather than by reading the scripts. Everything else the tests run they
/// name absolutely.
const REQUIRED: [&str; 10] =
	["cat", "cut", "ln", "ls", "mkfifo", "mv", "rm", "sh", "sleep", "tty"];

/// Where a host following the filesystem hierarchy standard keeps them.
/// Searched before anything the caller offers, so on such a host no
/// launcher can put its own `cat` in front of the system's.
#[cfg(unix)]
const SYSTEM_DIRS: &[&str] = &["/usr/bin", "/bin"];

/// The `PATH` the test process gets, instead of the caller's: ONE
/// directory, the one [`toolbox`] makes and fills with the programs in
/// [`REQUIRED`]. No directory of the caller's is on it.
///
/// Earlier versions of this harness put the caller's own directories on
/// the test `PATH` — first a fixed `/usr/bin:/bin`, which is wrong on a
/// host that does not follow the filesystem hierarchy standard (this
/// repository ships `nix/dev-shell.nix`, and `cat` is in the Nix store
/// there), then the directories the programs were actually found in.
/// That second shape kept the harness dependent on those directories
/// being nameable and reachable from every child, and review found three
/// hosts in a row where they are not: a directory whose name holds the
/// list separator cannot go on a `PATH` at all, a relative entry means a
/// different place in each child that chose its own working directory,
/// and a working directory that has been removed cannot be named.
///
/// One directory this harness owns answers all of them at once: it has a
/// name we chose, it is absolute, and it means the same thing to every
/// child whatever directory that child runs in.
///
/// What is still read from the caller is which directories to SEARCH
/// after the system ones, and `TMPDIR` for where to put our own
/// directory — never a startup file, a shell option or a setting that
/// changes what obash does. A program found nowhere is not installed,
/// and the test that needs it fails on it, as it does on a host that
/// lacks it.
#[cfg(unix)]
pub static TEST_PATH: LazyLock<OsString> = LazyLock::new(|| match toolbox() {
	Some(dir) => dir.into_os_string(),
	None => OsString::new(),
});

/// On a non-Unix host this harness builds no toolbox: it has no
/// `faccessat` to ask about executability and no symlink it may create
/// unprivileged. These integration tests need `sh`, `mkfifo` and `tty`
/// and are not run there, so the caller's `PATH` is passed through
/// rather than a second resolution scheme being carried for a platform
/// that does not run them.
#[cfg(not(unix))]
pub static TEST_PATH: LazyLock<OsString> =
	LazyLock::new(|| std::env::var_os("PATH").unwrap_or_default());

/// A directory holding the programs in [`REQUIRED`] under their own
/// names, made fresh for this test process.
///
/// Each program is the FIRST one the search finds, so the shell runs the
/// same `sh` the caller's own `PATH` would have reached, and a launcher
/// still cannot put its own `cat` in front of the system's. Collapsing
/// the search to one directory loses nothing: order only ever decided
/// which of several `cat`s wins, and that decision is made here.
///
/// `None` only when the directory cannot be made at all, which leaves an
/// empty `PATH` — the same outcome as a host that has none of the
/// programs.
#[cfg(unix)]
fn toolbox() -> Option<PathBuf> {
	let dir = owned_dir()?;
	let caller = std::env::var_os("PATH").unwrap_or_default();
	let searched: Vec<PathBuf> = SYSTEM_DIRS
		.iter()
		.map(PathBuf::from)
		.chain(std::env::split_paths(&caller).filter(|entry| !entry.as_os_str().is_empty()))
		.collect();
	for program in REQUIRED {
		let found = searched.iter().map(|dir| dir.join(program)).find(|p| is_program(p));
		if let Some(found) = found {
			install(&found, &dir.join(program));
		}
	}
	Some(dir)
}

/// `found` under `at`, so that running `at` runs it.
///
/// A symlink: `execve` follows it, it costs no read and 12 bytes of
/// directory entry (measured 0.09 ms and 0 disk blocks for all ten,
/// against 0.86 ms and 733 kB for copies), and it follows a CHAIN, so a
/// Nix profile entry that is itself a symlink with a relative target
/// still resolves against its own directory rather than ours. The source
/// may be read-only; nothing writes to it.
///
/// A hard link would be cheaper still and is not usable: it cannot cross
/// a filesystem, and the one it would have to cross is the ordinary one
/// — `/usr/bin` against `TMPDIR` fails with `EXDEV` on this very box, a
/// plain FHS host, before any Nix store is involved. It also links the
/// SYMLINK rather than its target, which would move a relative profile
/// entry's meaning into our directory and break it.
///
/// A copy is the fallback for the one source a symlink cannot name: a
/// program found through a relative `PATH` entry while the working
/// directory cannot be read. The kernel still resolves `../store/cat`
/// from a removed directory, so the copy succeeds where naming it
/// absolutely does not.
#[cfg(unix)]
fn install(found: &Path, at: &Path) {
	if let Some(target) = absolute(found)
		&& std::os::unix::fs::symlink(&target, at).is_ok()
	{
		return;
	}
	let _ = std::fs::copy(found, at);
}

/// `found` as a path that means the same from any directory, or `None`
/// when it cannot be named that way.
#[cfg(unix)]
fn absolute(found: &Path) -> Option<PathBuf> {
	if found.is_absolute() {
		return Some(found.to_path_buf());
	}
	Some(std::env::current_dir().ok()?.join(found))
}

/// An empty directory belonging to this test process alone.
///
/// Named after the pid under a per-account base, so two test processes
/// cannot collide and a reused pid cannot inherit the last one's
/// contents. Nothing removes it at exit — a test process can be killed —
/// so each one first clears out the directories of processes that are
/// gone, which bounds what accumulates without an exit hook that a kill
/// would skip.
#[cfg(unix)]
fn owned_dir() -> Option<PathBuf> {
	// SAFETY: `getuid` takes no arguments, cannot fail and has no preconditions.
	let uid = unsafe { libc::getuid() };
	let base = std::env::temp_dir().join(format!("obash-test-path.{uid}"));
	sweep(&base);
	let dir = base.join(std::process::id().to_string());
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(&dir).ok()?;
	Some(dir)
}

/// Remove the toolboxes of test processes that have exited.
#[cfg(unix)]
fn sweep(base: &Path) {
	let Ok(entries) = std::fs::read_dir(base) else {
		return;
	};
	for entry in entries.flatten() {
		let Ok(pid) = entry.file_name().to_string_lossy().parse::<libc::pid_t>() else {
			continue;
		};
		if pid <= 0 {
			continue;
		}
		// SAFETY: signal 0 sends nothing; it only reports whether the pid
		// exists and whether we could signal it.
		let gone = unsafe { libc::kill(pid, 0) } == -1
			&& std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
		if gone {
			let _ = std::fs::remove_dir_all(entry.path());
		}
	}
}

/// Whether `path` is a program this process can execute, following links:
/// a Nix store entry reached through a profile is a symlink.
///
/// The question is asked of the kernel rather than of the mode bits,
/// because `mode & 0o111` is the union of the owner, group and other bits
/// and not a permission anybody has: a file we own with mode `0001` is
/// executable by everyone except us, and treating it as a program hides a
/// usable one later on the search path.
///
/// It is asked about the EFFECTIVE user and group, with `AT_EACCESS`,
/// because those are the ids `exec` will check. Plain `access(2)` answers
/// for the real ids, and under `setpriv` — real 60001, effective 1000 —
/// it called every program unusable and left the `PATH` empty while the
/// shell could have run them.
#[cfg(unix)]
fn is_program(path: &Path) -> bool {
	use std::os::unix::ffi::OsStrExt as _;

	if !std::fs::metadata(path).is_ok_and(|meta| meta.is_file()) {
		return false;
	}
	let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
		return false;
	};
	// SAFETY: `c_path` is a NUL-terminated string that outlives the call;
	// `faccessat` only reads it. `AT_FDCWD` resolves a relative path
	// against this process's working directory, which is where a relative
	// `PATH` entry means, and is ignored for an absolute one.
	let rc =
		unsafe { libc::faccessat(libc::AT_FDCWD, c_path.as_ptr(), libc::X_OK, libc::AT_EACCESS) };
	rc == 0
}

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
		// A real record can be larger than any round number worth
		// guessing: a 70 kB GECOS field is legal, the host accepts it, and
		// a 64 kB ceiling turned it into "no account name at all" — the
		// state the `USER` line exists to prevent, arrived at silently.
		// Grow until the call stops asking for room; the bound only stops
		// an unbounded loop if the library ever asks forever.
		if rc == libc::ERANGE && buf.len() < 1 << 26 {
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
	cmd.env_clear().env("PATH", &*TEST_PATH);
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
