//! How the cli tests start processes, all through [`command`]: hermetic
//! (none of the caller's environment — a [`TEST_PATH`] built from where
//! the programs the tests need actually live, and the account's own name,
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
#[cfg(not(unix))]
const SYSTEM_DIRS: &[&str] = &[];

/// The `PATH` for when nothing resolved, which is **not** the empty one.
///
/// An empty `PATH` is not "no directories": a shell reads it as the
/// working directory. A child would then run whatever `sh` or `cat` the
/// directory it happens to start in contains, and
/// `external_commands_run_through_path` would **pass** on one — a test
/// reading the machine it runs on, which is the defect this harness
/// exists to remove, arrived at by the harness itself. Found by review
/// on a host where every caller entry was rejected.
///
/// `/dev/null` is not a directory, so a lookup through it finds nothing
/// and stops there. The test that needed a program then fails on that
/// program, which is what a reader can act on.
#[cfg(unix)]
const NO_PROGRAMS: &str = "/dev/null";
#[cfg(not(unix))]
const NO_PROGRAMS: &str = "NUL";

/// The `PATH` the test process gets, instead of the caller's: the
/// directories the programs in [`REQUIRED`] were found in, **in search
/// order**, and nothing else.
///
/// A fixed `/usr/bin:/bin` is hermetic and wrong on a host that does not
/// follow the filesystem hierarchy standard. This repository ships
/// `nix/dev-shell.nix`, so NixOS is one: `cat` is in the Nix store and the
/// FIFO test's `cat < f` failed with the program installed. Resolving each
/// program keeps both properties — the search starts at [`SYSTEM_DIRS`],
/// so an FHS host answers as a fixed list would and the caller cannot
/// redirect anything; a host that keeps its tools elsewhere contributes
/// only the directories those tools are in.
///
/// Two properties this has to keep, both of which a first version broke.
/// The result is the searched directories FILTERED, never reordered: if
/// `cat` is found in the second directory and `sh` in the first, the
/// `PATH` is still first-then-second, so the shell runs the same `sh` the
/// caller's own `PATH` would have. And a directory counts only if this
/// account can actually execute the program in it, so an unreadable or
/// not-executable-by-us file does not shadow a usable one further along.
///
/// What is read from the caller is therefore which **absolute**
/// directories to search after the system ones, never a startup file, a
/// shell option or a setting that changes what obash does. A relative
/// entry is not supported and is dropped — see [`supported_dir`], which
/// carries the reason. A program found nowhere puts no directory on the
/// `PATH` and the test that needs it fails on it, as it does today on a
/// host that lacks it.
pub static TEST_PATH: LazyLock<OsString> = LazyLock::new(|| {
	let caller = std::env::var_os("PATH").unwrap_or_default();
	let searched: Vec<PathBuf> = SYSTEM_DIRS
		.iter()
		.map(PathBuf::from)
		.chain(std::env::split_paths(&caller).filter_map(supported_dir))
		.collect();
	let mut needed = vec![false; searched.len()];
	for program in REQUIRED {
		if let Some(at) = searched.iter().position(|dir| is_program(&dir.join(program))) {
			needed[at] = true;
		}
	}
	let kept = searched
		.iter()
		.zip(&needed)
		.filter(|&(_, &used)| used)
		// A directory whose own name holds the list separator cannot go on
		// a `PATH` at all, and the question is asked of the function that
		// would reject it rather than of a hardcoded character. Dropping
		// it loses the programs in it; letting `join_paths` fail would
		// instead panic every spawn in the binary, which is worse — and a
		// working directory named `a:b` reaches this through a relative
		// entry, so it is not hypothetical.
		.filter(|(dir, _)| std::env::join_paths([dir.as_path()]).is_ok())
		.map(|(dir, _)| dir);
	let joined = std::env::join_paths(kept).unwrap_or_default();
	if joined.is_empty() { OsString::from(NO_PROGRAMS) } else { joined }
});

/// One of the caller's `PATH` entries, if this harness supports it.
///
/// **A relative entry is not supported and is dropped.** That is a
/// deliberate limitation of the harness, not an oversight, and the pull
/// request that introduced it says so rather than leaving it here. A
/// launcher that says `PATH=../../store` has usable programs there and
/// this harness will not find them; a test that needs one of the ten
/// then fails on it, as it does on a host that lacks the program.
///
/// The reason is that a relative entry has no single meaning for the
/// processes this harness starts. Several tests give the process they
/// start a `current_dir` of their own, so a relative entry passed
/// through would name a different place in each of them. Resolving it
/// against the TEST PROCESS's working directory was tried and does not
/// hold either: that directory may be unnameable — one called `a:b`
/// produces an entry no `PATH` can carry — or unreadable, since a
/// removed working directory makes `current_dir()` fail, and review
/// found both. Installing the programs into a directory the harness
/// owns was tried next and was worse: it made the harness depend on
/// `TMPDIR` being absolute, colon-free and writable, and its cleanup
/// could follow a symlink a caller planted out of its own tree.
///
/// An **empty** entry means the working directory in the same way, and
/// is dropped for the same reason.
///
/// What a caller gets is therefore this: the absolute directories on its
/// `PATH` are searched after the system ones, and nothing else it offers
/// is read.
fn supported_dir(dir: PathBuf) -> Option<PathBuf> {
	dir.is_absolute().then_some(dir)
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
fn is_program(path: &Path) -> bool {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt as _;

		if !std::fs::metadata(path).is_ok_and(|meta| meta.is_file()) {
			return false;
		}
		let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
			return false;
		};
		// SAFETY: `c_path` is a NUL-terminated string that outlives the
		// call; `faccessat` only reads it, and `AT_FDCWD` with an
		// absolute path ignores the directory argument.
		let rc = unsafe {
			libc::faccessat(libc::AT_FDCWD, c_path.as_ptr(), libc::X_OK, libc::AT_EACCESS)
		};
		rc == 0
	}
	#[cfg(not(unix))]
	{
		path.is_file()
	}
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
