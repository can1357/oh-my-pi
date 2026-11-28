//! Process groups, sessions, signals, escalation, pumps and leak checks
//! against real processes (`/bin/sh`, `sleep`, `yes`, `cat`).

use std::{
	io,
	os::unix::process::CommandExt,
	sync::Arc,
	task::{Context, Poll, Wake, Waker},
	thread,
	time::{Duration, Instant},
};

use bstr::{BString, ByteSlice};
use parking_lot::Mutex;

use super::{Scope, process_umask};
use crate::{
	bash::{
		ChildRedir, ChildRedirs, CmdTag, EnvView, ExitStatus, ExtProc, File, FileKind, JobId,
		OpenFlags, OsHandle, PgroupSpec, Rlimit, RunId, SigSet, Signal, SpawnSpec, StdioSpec, Vpid,
	},
	sys::{
		proc::{self, ProcState},
		spawn::{NativeSpawner, Sessions, SpawnConfig},
	},
};

const LONG: Duration = Duration::from_secs(20);

/// A detached external is signalled through its session, whose group exists
/// only after the child's own `setsid`. A signal sent before that (`kill $!`
/// right after the spawn) must still reach the leader, here a process that
/// never leads a session at all.
#[test]
fn a_session_is_signalled_before_its_leader_ran_setsid() {
	let mut child = std::process::Command::new("sleep")
		.arg("30")
		.spawn()
		.unwrap();
	let pid = i32::try_from(child.id()).unwrap();
	Scope::Session(pid).signal(Signal::Term).unwrap();
	let status = child.wait().unwrap();
	assert_eq!(std::os::unix::process::ExitStatusExt::signal(&status), Some(libc::SIGTERM));
}

struct Unpark(thread::Thread);

impl Wake for Unpark {
	fn wake(self: Arc<Self>) {
		self.0.unpark();
	}
}

fn wait(p: &mut Box<dyn ExtProc>) -> ExitStatus {
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	let mut cx = Context::from_waker(&waker);
	let deadline = Instant::now() + LONG;
	loop {
		if let Poll::Ready(s) = p.poll_wait(&mut cx) {
			return s;
		}
		assert!(Instant::now() < deadline, "process did not finish");
		thread::park_timeout(Duration::from_millis(50));
	}
}

/// Poll `cond` until it holds; the elapsed time.
fn until(what: &str, mut cond: impl FnMut() -> bool) -> Duration {
	let start = Instant::now();
	while !cond() {
		assert!(start.elapsed() < LONG, "timed out waiting for {what}");
		thread::sleep(Duration::from_millis(5));
	}
	start.elapsed()
}

fn argv(words: &[&str]) -> Vec<BString> {
	words.iter().map(|w| BString::from(*w)).collect()
}

fn sh(script: &str) -> Vec<BString> {
	argv(&["/bin/sh", "-c", script])
}

/// Spec with null stdio, cwd `/`, the process umask, nothing ignored.
fn spec<'a>(argv: &'a [BString], env: &'a EnvView, pgroup: PgroupSpec) -> SpawnSpec<'a> {
	SpawnSpec {
		path: argv[0].as_bstr(),
		argv,
		env,
		cwd: b"/".as_bstr(),
		stdio: [StdioSpec::Null, StdioSpec::Null, StdioSpec::Null],
		extra_fds: Vec::new(),
		pgroup,
		tag: CmdTag { run: RunId(1), vpid: Vpid(Vpid::BASE), seq: 1 },
		vpid: Vpid(Vpid::BASE),
		umask: process_umask().unwrap_or(0o022),
		sigmask_ign: SigSet::EMPTY,
		rlimits: &[],
		lineage: crate::bash::Lineage::default(),
		redirs: None,
		ctty: None,
	}
}

const NEW: PgroupSpec = PgroupSpec::New(JobId(1));

fn spawner(sessions: Sessions, grace: Duration) -> NativeSpawner {
	NativeSpawner::new(SpawnConfig { grace, sessions, ..SpawnConfig::default() })
}

fn pgid(pid: u32) -> i32 {
	// SAFETY: plain syscall without pointer arguments.
	unsafe { libc::getpgid(pid as i32) }
}

fn sid(pid: u32) -> i32 {
	// SAFETY: plain syscall without pointer arguments.
	unsafe { libc::getsid(pid as i32) }
}

fn our_sid() -> i32 {
	sid(0)
}

/// Live (non-zombie) members of a group.
fn live_group(pgid: i32) -> Vec<proc::ProcInfo> {
	let mut m = proc::group_members(pgid).unwrap();
	m.retain(|p| p.state != ProcState::Zombie);
	m
}

/// An engine-side file without an OS handle: a byte source, a capture, or a
/// sink whose reader is gone.
#[derive(Clone, Default)]
struct MemFile {
	input:    Arc<Mutex<(Vec<u8>, usize)>>,
	output:   Arc<Mutex<Vec<u8>>>,
	broken:   bool,
	/// Refuse reads / writes like an fd opened the other way.
	no_read:  bool,
	no_write: bool,
	/// `seek(Current(n))` moves the input position (a VFS file).
	seekable: bool,
}

impl MemFile {
	/// A read end like the engine's `<( )` pipe end.
	fn reader(data: &[u8]) -> Self {
		Self { no_write: true, ..Self::feed(data) }
	}

	/// A write end like the engine's `>( )` pipe end.
	fn writer() -> Self {
		Self { no_read: true, ..Self::default() }
	}

	fn feed(data: &[u8]) -> Self {
		Self { input: Arc::new(Mutex::new((data.to_vec(), 0))), ..Self::default() }
	}

	fn broken() -> Self {
		Self { broken: true, ..Self::default() }
	}

	fn captured(&self) -> Vec<u8> {
		self.output.lock().clone()
	}

	fn boxed(&self) -> StdioSpec {
		StdioSpec::File(Box::new(self.clone()))
	}
}

impl File for MemFile {
	fn poll_read(&mut self, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		if self.no_read {
			return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
		}
		let mut g = self.input.lock();
		let (data, pos) = &mut *g;
		let n = buf.len().min(data.len() - *pos);
		buf[..n].copy_from_slice(&data[*pos..*pos + n]);
		*pos += n;
		Poll::Ready(Ok(n))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if self.no_write {
			return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
		}
		if self.broken {
			return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
		}
		self.output.lock().extend_from_slice(buf);
		Poll::Ready(Ok(buf.len()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
		let io::SeekFrom::Current(off) = pos else {
			return Err(io::ErrorKind::Unsupported.into());
		};
		if !self.seekable {
			return Err(io::ErrorKind::Unsupported.into());
		}
		let mut g = self.input.lock();
		let at =
			g.1.checked_add_signed(off as isize)
				.filter(|&at| at <= g.0.len())
				.ok_or(io::ErrorKind::InvalidInput)?;
		g.1 = at;
		Ok(at as u64)
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

/// `f(){ date; cat "$1"; }; f <(echo l8r)`: an external that never reads
/// its feed leaves the bytes the pump moved into the OS pipe; dropping its
/// `ExtProc` gives them back to the engine object at once, so the next
/// reader (here another external) gets them.
#[test]
fn bytes_left_in_a_feed_go_back_to_the_engine_object_when_its_external_is_done() {
	let env = EnvView::default();
	let spawner = NativeSpawner::default();
	let data = b"l8r\n";
	let src = MemFile { seekable: true, ..MemFile::reader(data) };
	let sub = crate::bash::FdRef::from_file(Box::new(src.clone()));
	let idle = sh("exit 0");
	let mut first = spec(&idle, &env, NEW);
	first.extra_fds = vec![(63, StdioSpec::Pipe(sub.clone()))];
	let mut p = spawner.spawn(first).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	until("the pump took the bytes", || src.input.lock().1 == data.len());
	drop(p);
	assert_eq!(src.input.lock().1, 0, "given back by the drop, before it returns");

	let out = MemFile::default();
	let cat = argv(&["/bin/cat"]);
	let mut second = spec(&cat, &env, NEW);
	second.stdio = [StdioSpec::Pipe(sub), out.boxed(), StdioSpec::Null];
	let mut p = spawner.spawn(second).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), data, "the next reader gets every byte");
}

#[test]
fn exit_codes_and_group_signals_are_reported() {
	let env = EnvView::default();
	for sessions in [Sessions::Detach, Sessions::Share] {
		let s = spawner(sessions, Duration::from_secs(2));
		let a = sh("exit 3");
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(3));

		let a = argv(&["/bin/sleep", "30"]);
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		p.signal(Signal::Term).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Term), "{sessions:?}");
	}
}

/// More externals at once than waiters are kept parked, then a sequential
/// round that reuses the parked ones: every exit reaches its own external.
#[test]
fn parked_waiters_report_each_external_its_own_exit() {
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, Duration::from_secs(2));
	let scripts: Vec<Vec<BString>> = (0..super::IDLE_MAX + 4)
		.map(|i| sh(&format!("sleep 0.2; exit {i}")))
		.collect();
	let mut running: Vec<_> = scripts
		.iter()
		.map(|a| s.spawn(spec(a, &env, NEW)).unwrap())
		.collect();
	for (i, p) in running.iter_mut().enumerate().rev() {
		assert_eq!(wait(p), ExitStatus::Exited(i32::try_from(i).unwrap()));
	}
	drop(running);
	for i in 0..2 * super::IDLE_MAX {
		let a = sh(&format!("exit {i}"));
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(i32::try_from(i).unwrap()));
	}
	assert!(s.leftovers().unwrap().is_empty());
}

/// For test `name` (its path below this module): its OOM adjustment in a
/// process of its own ([`alone`]), lowered there below 1000
/// ([`lowered_score`]); `None` in the process that ran it there, which
/// returns, and where the value stays at 1000, where the test skips. A test
/// that a tool process of this build runs (a bash tool command) starts at
/// 1000 already, so a child reading 1000 would not show that its own spawn
/// set it; the value of the test runner itself never changes.
#[cfg(target_os = "linux")]
fn below_tool_score(name: &str) -> Option<String> {
	if !alone(name) {
		return None;
	}
	lowered_score(std::path::Path::new("/proc/self/oom_score_adj"))
}

/// The OOM adjustment in `score`, lowered from 1000 to 999 where it was
/// 1000, as read back; `None`, saying the test skips, where it stays at
/// 1000 (the kernel refuses 999 below a minimum a privileged writer set):
/// a test reading 1000 in a child could not tell then whether the child's
/// spawn set it.
#[cfg(target_os = "linux")]
fn lowered_score(score: &std::path::Path) -> Option<String> {
	if std::fs::read_to_string(score).ok()?.trim() == "1000" {
		let _ = std::fs::write(score, "999");
	}
	let baseline = std::fs::read_to_string(score).ok()?;
	if baseline.trim() == "1000" {
		eprintln!(
			"skipping: the baseline OOM adjustment in {score:?} stays at 1000, so a child reading \
			 1000 would not show that its spawn set it"
		);
		return None;
	}
	Some(baseline)
}

/// Failure mode: an OOM adjustment that cannot be lowered from 1000 passes
/// as a baseline, and the score tests then pass where a child only inherits
/// the 1000 its host has. A read-only file stands for the refused write.
#[cfg(target_os = "linux")]
#[test]
fn a_score_that_stays_at_1000_is_no_baseline() {
	use std::os::unix::fs::PermissionsExt;

	// SAFETY: no arguments.
	if unsafe { libc::geteuid() } == 0 {
		eprintln!("skipping: root writes a read-only file");
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	let score = dir.path().join("oom_score_adj");
	std::fs::write(&score, "1000\n").unwrap();
	std::fs::set_permissions(&score, std::fs::Permissions::from_mode(0o444)).unwrap();
	assert_eq!(lowered_score(&score), None, "a baseline of 1000 was taken");
}

/// Test `name`'s check that a spawn (`measured`, with `redirs`) gives the
/// program and its child the OOM adjustment of tool processes, and leaves
/// the host's.
#[cfg(target_os = "linux")]
fn check_tool_oom_score(name: &str, measured: bool, redirs: Option<ChildRedirs>) {
	let Some(before) = below_tool_score(name) else {
		return;
	};
	let score = "/proc/self/oom_score_adj";
	let env = EnvView::default();
	let a = sh("read -r score < /proc/self/oom_score_adj; printf '%s\\n' \"$score\"; /bin/cat \
	            /proc/self/oom_score_adj; :");
	let s = spawner(Sessions::Detach, Duration::from_secs(2));
	let out = MemFile::default();
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	sp.redirs = redirs;
	let mut p = if measured {
		s.spawn_measured(sp)
	} else {
		s.spawn(sp)
	}
	.unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(std::fs::read_to_string(score).unwrap(), before);
	assert_eq!(out.captured(), b"1000\n1000\n");
}

/// Failure mode: a program the shell starts, its child included, keeps Oh
/// My Pi's OOM adjustment, so the kernel, picking one process to kill for
/// lack of memory, may kill Oh My Pi in its place; or the spawn changes Oh
/// My Pi's own value.
#[cfg(target_os = "linux")]
#[test]
fn ordinary_spawn_sets_tool_oom_score() {
	check_tool_oom_score("ordinary_spawn_sets_tool_oom_score", false, None);
}

/// Failure mode: as for [`ordinary_spawn_sets_tool_oom_score`], for a
/// program whose redirections its child installs (the fork path).
#[cfg(target_os = "linux")]
#[test]
fn redirected_spawn_sets_tool_oom_score() {
	check_tool_oom_score(
		"redirected_spawn_sets_tool_oom_score",
		false,
		Some(ChildRedirs {
			list:      vec![ChildRedir::Close { fd: 9 }],
			exec_diag: BString::from("test: /bin/sh: "),
		}),
	);
}

/// Failure mode: as for [`ordinary_spawn_sets_tool_oom_score`], for a
/// program `time` measures, which the measuring helper starts.
#[cfg(target_os = "linux")]
#[test]
fn measured_spawn_inherits_tool_oom_score() {
	check_tool_oom_score("measured_spawn_inherits_tool_oom_score", true, None);
}

/// Failure mode: a program under a low open-files limit (`ulimit -n 3`)
/// starts without the OOM adjustment of tool processes: its child set the
/// limit before it opened `/proc/self/oom_score_adj`, and the open failed.
#[cfg(target_os = "linux")]
#[test]
fn a_low_open_files_limit_keeps_the_tool_oom_score() {
	if below_tool_score("a_low_open_files_limit_keeps_the_tool_oom_score").is_none() {
		return;
	}
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let (_, hard) = crate::sys::rlimit::get(Rlimit::Nofile).unwrap();
	// Fds 0, 1 and 2 are open: no other fd fits under the limit.
	let limits = [(Rlimit::Nofile, Some(3), hard)];
	let a = argv(&["/usr/bin/true"]);
	let mut sp = spec(&a, &env, NEW);
	sp.rlimits = &limits;
	let mut p = s.spawn(sp).unwrap();
	// The spawn returns once the program exec'd, and the process stays
	// unreaped while `p` lives: its value is final, whether or not its loader
	// then fails for want of an fd.
	let path = format!("/proc/{}/oom_score_adj", p.pid());
	let score = std::fs::read_to_string(path).unwrap();
	wait(&mut p);
	assert_eq!(score, "1000\n");
}

/// A measured spawn (`time`; on Linux the program runs under a helper)
/// ends as the program did, takes group signals as it would, reports a
/// usage, and fails like a plain spawn when the program is missing.
#[test]
fn measured_spawns_end_as_their_program() {
	let env = EnvView::default();
	for sessions in [Sessions::Detach, Sessions::Share] {
		let s = spawner(sessions, Duration::from_secs(2));
		for (script, status) in
			[("exit 3", ExitStatus::Exited(3)), ("kill -USR1 $$", ExitStatus::Signaled(Signal::Usr1))]
		{
			let a = sh(script);
			let mut p = s.spawn_measured(spec(&a, &env, NEW)).unwrap();
			assert_eq!(wait(&mut p), status, "{sessions:?}: {script}");
			assert!(p.usage().is_some_and(|u| u.max_rss > 0), "{sessions:?}: {script}");
		}
		let a = argv(&["/bin/sleep", "30"]);
		let mut p = s.spawn_measured(spec(&a, &env, NEW)).unwrap();
		#[cfg(target_os = "linux")]
		{
			let program = child_of(p.pid() as i32);
			assert_eq!(program.name, "sleep", "the helper's child is the program");
			assert_eq!(program.pgid, pgid(p.pid()), "in the helper's group");
		}
		p.signal(Signal::Term).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Term), "{sessions:?}");
		drop(p);
		assert!(s.leftovers().unwrap().is_empty(), "{sessions:?}");
	}
	let a = argv(&["/nonexistent/prog"]);
	let err = NativeSpawner::default()
		.spawn_measured(spec(&a, &env, NEW))
		.err()
		.unwrap();
	assert_eq!(err.kind(), io::ErrorKind::NotFound);
}

#[test]
fn missing_program_fails_with_not_found_on_both_paths() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = argv(&["/nonexistent/prog"]);
	let err = s.spawn(spec(&a, &env, NEW)).err().unwrap();
	assert_eq!(err.kind(), io::ErrorKind::NotFound, "posix_spawn path");
	let mut forked = spec(&a, &env, NEW);
	forked.umask = if forked.umask == 0o077 { 0o027 } else { 0o077 };
	let err = s.spawn(forked).err().unwrap();
	assert_eq!(err.kind(), io::ErrorKind::NotFound, "fork path");
}

/// A script without `#!` cannot be exec'd: the spawn must fail with the
/// kernel's ENOEXEC intact, so the host can run it in-engine as bash does.
#[test]
fn shebang_less_script_fails_with_enoexec_on_both_paths() {
	use std::os::unix::fs::PermissionsExt;

	let path = std::env::temp_dir().join(format!("obash-noexec-{}", std::process::id()));
	std::fs::write(&path, b"echo inscript $1\n").unwrap();
	std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = vec![BString::from(path.as_os_str().as_encoded_bytes()), BString::from("arg")];
	let posix = spec(&a, &env, NEW);
	let mut forked = spec(&a, &env, NEW);
	forked.umask = if forked.umask == 0o077 { 0o027 } else { 0o077 };
	for (what, sp) in [("posix_spawn", posix), ("fork", forked)] {
		let err = s
			.spawn(sp)
			.err()
			.unwrap_or_else(|| panic!("{what}: spawned a shebang-less script"));
		assert_eq!(err.raw_os_error(), Some(libc::ENOEXEC), "{what}: {err}");
	}
	std::fs::remove_file(&path).unwrap();
}

/// Set in the process [`alone`] starts.
const ALONE: &str = "PI_SHELL_TEST_ALONE";

/// How long a test run alone ([`alone`]) may take before it is killed.
const ALONE_FOR: Duration = Duration::from_secs(120);

/// Run test `name` (its path below this module) again, alone, in a process
/// of its own, and fail where it fails there; true in that process, where
/// the caller runs the test's body. A check for a child left asks about
/// every child of the process, a change of the process's state reaches
/// every test in it, and under libtest (`cargo test`, Bazel) the other
/// tests share the test's process. The process is killed and reaped where
/// it outlasts [`ALONE_FOR`], and ends with this one.
fn alone(name: &str) -> bool {
	use std::{io::Read as _, process::Stdio, sync::mpsc};

	if std::env::var_os(ALONE).is_some() {
		return true;
	}
	let mut command = std::process::Command::new(std::env::current_exe().unwrap());
	command
		.arg("--exact")
		.arg(format!("sys::spawn::unix::tests::{name}"))
		.env(ALONE, "1")
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	#[cfg(target_os = "linux")]
	// SAFETY: prctl is async-signal-safe and takes no pointers.
	unsafe {
		command.pre_exec(|| {
			libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
			Ok(())
		});
	}
	let mut child = command.spawn().unwrap();
	// Drained as the process writes, so a full pipe cannot stall it.
	let (sent, output) = mpsc::channel();
	for pipe in [
		child
			.stdout
			.take()
			.map(|p| Box::new(p) as Box<dyn io::Read + Send>),
		child
			.stderr
			.take()
			.map(|p| Box::new(p) as Box<dyn io::Read + Send>),
	] {
		let (sent, mut pipe) = (sent.clone(), pipe.unwrap());
		thread::spawn(move || {
			let mut bytes = Vec::new();
			let _ = pipe.read_to_end(&mut bytes);
			let _ = sent.send(String::from_utf8_lossy(&bytes).into_owned());
		});
	}
	let deadline = Instant::now() + ALONE_FOR;
	let status = loop {
		if let Some(status) = child.try_wait().unwrap() {
			break Some(status);
		}
		if Instant::now() >= deadline {
			// SIGKILL to the unreaped child, then its reap.
			let _ = child.kill();
			child.wait().unwrap();
			break None;
		}
		thread::sleep(Duration::from_millis(10));
	};
	// A program it started may hold its pipes still: wait for them a while.
	let mut said = String::new();
	for _ in 0..2 {
		match output.recv_timeout(Duration::from_secs(10)) {
			Ok(text) => said.push_str(&text),
			Err(_) => said.push_str("<a pipe of the test's process stayed open>"),
		}
	}
	let status = status.unwrap_or_else(|| panic!("the test alone ran past {ALONE_FOR:?}: {said}"));
	assert!(status.success(), "the test alone failed: {said}");
	assert!(said.contains("1 passed"), "the process ran no test: {said}");
	false
}

/// Failure mode: a program that cannot start spawns anyway (the engine then
/// reports an exit status instead of the OS error bash prints), fails with
/// another error, or leaves its failed child unreaped (a zombie per
/// failure). The exec's `EACCES`, and a working directory the child cannot
/// enter. The body runs alone in a process of its own ([`alone`]).
#[test]
fn exec_and_setup_errors_fail_the_spawn_and_leave_no_child() {
	use std::os::unix::fs::PermissionsExt;

	if !alone("exec_and_setup_errors_fail_the_spawn_and_leave_no_child") {
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	let plain = dir.path().join("not-executable");
	std::fs::write(&plain, b"#!/bin/sh\nexit 0\n").unwrap();
	std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
	let not_executable = vec![BString::from(plain.as_os_str().as_encoded_bytes())];
	let runs = argv(&["/usr/bin/true"]);
	let env = EnvView::default();
	let s = NativeSpawner::default();
	for (what, a, cwd, errno) in [
		("not executable", &not_executable, "/", libc::EACCES),
		("missing cwd", &runs, "/nonexistent/dir", libc::ENOENT),
	] {
		let mut sp = spec(a, &env, NEW);
		sp.cwd = cwd.as_bytes().as_bstr();
		let err = s
			.spawn(sp)
			.err()
			.unwrap_or_else(|| panic!("{what}: spawned"));
		assert_eq!(err.raw_os_error(), Some(errno), "{what}: {err}");
	}
	// This process runs this test alone: it has no other child.
	// SAFETY: plain syscall; `WNOHANG` does not wait.
	let rc = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
	assert_eq!(
		(rc, io::Error::last_os_error().raw_os_error()),
		(-1, Some(libc::ECHILD)),
		"a failed child is left unreaped"
	);
}

/// A fresh path in the temp directory for test `what`.
fn temp_path(what: &str) -> std::path::PathBuf {
	std::env::temp_dir().join(format!("obash-{what}-{}", std::process::id()))
}

/// The open of `path` with `flags` onto `fds` by the process.
fn child_open(fds: &[i32], path: &std::path::Path, flags: OpenFlags) -> ChildRedir {
	let path = BString::from(path.as_os_str().as_encoded_bytes());
	let diag = BString::from(format!("test: {path}: "));
	ChildRedir::Open { fds: fds.to_vec(), path, flags, mode: 0o600, diag }
}

const WRITE: OpenFlags = OpenFlags::WRITE
	.with(OpenFlags::CREATE)
	.with(OpenFlags::TRUNC);

/// bash's forked child opens a background command's FIFO redirection: the
/// spawn returns (with the pid `$!` shows) while the open still waits for
/// the FIFO's other end, which the shell's next command opens.
#[test]
fn redirections_left_to_the_process_do_not_hold_the_spawn() {
	let fifo = temp_path("child-fifo");
	let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
	// SAFETY: mkfifo with a valid C path.
	assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo");
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("echo $$");
	let mut sp = spec(&a, &env, NEW);
	sp.redirs = Some(ChildRedirs {
		list:      vec![child_open(&[1], &fifo, WRITE)],
		exec_diag: BString::from("test: /bin/sh: "),
	});
	// Returns although nothing reads the FIFO yet.
	let mut p = s.spawn(sp).expect("spawn");
	let said = std::fs::read_to_string(&fifo).expect("read the FIFO");
	assert_eq!(said.trim(), p.pid().to_string(), "the program's own pid");
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	std::fs::remove_file(&fifo).unwrap();
}

/// A redirection or exec the process fails reports as bash's child does:
/// the message on its (redirected) stderr, status 1 or 127.
#[test]
fn failures_left_to_the_process_are_its_own_message_and_status() {
	let err = temp_path("child-err");
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("echo never");
	let mut sp = spec(&a, &env, NEW);
	let missing = std::path::Path::new("/nonexistent/dir/f");
	sp.redirs = Some(ChildRedirs {
		list:      vec![child_open(&[2], &err, WRITE), child_open(&[1], missing, WRITE)],
		exec_diag: BString::from("test: /bin/sh: "),
	});
	let mut p = s.spawn(sp).expect("spawn");
	assert_eq!(wait(&mut p), ExitStatus::Exited(1));
	assert_eq!(
		std::fs::read_to_string(&err).unwrap(),
		"test: /nonexistent/dir/f: No such file or directory\n"
	);

	let a = argv(&["/nonexistent/prog"]);
	let mut sp = spec(&a, &env, NEW);
	sp.redirs = Some(ChildRedirs {
		list:      vec![child_open(&[2], &err, WRITE)],
		exec_diag: BString::from("test: /nonexistent/prog: "),
	});
	let mut p = s.spawn(sp).expect("the spawn does not wait for the exec");
	assert_eq!(wait(&mut p), ExitStatus::Exited(127));
	assert_eq!(
		std::fs::read_to_string(&err).unwrap(),
		"test: /nonexistent/prog: No such file or directory\n"
	);
	std::fs::remove_file(&err).unwrap();
}

#[test]
fn detached_externals_lead_their_own_sessions_without_a_terminal() {
	let env = EnvView::default();
	let s = spawner(Sessions::Detach, Duration::from_secs(2));
	let a = argv(&["/bin/sleep", "30"]);
	let mut lead = s.spawn(spec(&a, &env, NEW)).unwrap();
	let lead_pid = lead.pid();
	assert_eq!((pgid(lead_pid), sid(lead_pid)), (lead_pid as i32, lead_pid as i32));
	// omp-shell lesson (shell.rs ~6105): a later stage must not setpgid-join a
	// leader that moved sessions; detached stages lead their own.
	let mut stage = s.spawn(spec(&a, &env, PgroupSpec::Join(lead_pid))).unwrap();
	let pid = stage.pid();
	assert_eq!((pgid(pid), sid(pid)), (pid as i32, pid as i32));
	for p in [&mut lead, &mut stage] {
		p.signal(Signal::Kill).unwrap();
		assert_eq!(wait(p), ExitStatus::Signaled(Signal::Kill));
	}
}

/// omp-shell lesson (shell.rs ~6105/~7827): joining a group whose leader is
/// in another session fails with EPERM; the spawner must not try, and the
/// stage leads its own group in our session instead.
#[test]
fn share_join_of_a_leader_in_another_session_leads_its_own_group() {
	let mut foreign = std::process::Command::new("/bin/sleep");
	foreign.arg("30");
	// SAFETY: setsid is async-signal-safe.
	unsafe {
		foreign.pre_exec(|| {
			libc::setsid();
			Ok(())
		});
	}
	let mut foreign = foreign.spawn().unwrap();
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(2));
	let a = argv(&["/bin/sleep", "30"]);
	let mut p = s
		.spawn(spec(&a, &env, PgroupSpec::Join(foreign.id())))
		.unwrap();
	let pid = p.pid();
	assert_eq!(pgid(pid), pid as i32, "leads its own group");
	assert_eq!(sid(pid), our_sid(), "stays in our session");
	p.signal(Signal::Kill).unwrap();
	wait(&mut p);
	foreign.kill().unwrap();
	foreign.wait().unwrap();
}

#[test]
fn share_join_of_an_exited_but_held_leader_joins_its_group() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(2));
	let a = argv(&["/usr/bin/true"]);
	let mut lead = s.spawn(spec(&a, &env, NEW)).unwrap();
	assert_eq!(wait(&mut lead), ExitStatus::Exited(0));
	// `true | sleep`: the leader exited first, but its ExtProc is alive, so
	// it is an unreaped zombie and the group still exists.
	let b = argv(&["/bin/sleep", "30"]);
	let mut stage = s
		.spawn(spec(&b, &env, PgroupSpec::Join(lead.pid())))
		.unwrap();
	assert_eq!(pgid(stage.pid()), lead.pid() as i32, "joined the leader's group");
	stage.signal(Signal::Kill).unwrap();
	wait(&mut stage);
	drop(lead);
}

#[test]
fn share_join_after_the_leader_was_reaped_leads_its_own_group() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(2));
	let a = argv(&["/usr/bin/true"]);
	let mut lead = s.spawn(spec(&a, &env, NEW)).unwrap();
	wait(&mut lead);
	let gone = lead.pid();
	drop(lead);
	let b = argv(&["/bin/sleep", "30"]);
	let mut stage = s.spawn(spec(&b, &env, PgroupSpec::Join(gone))).unwrap();
	assert_eq!(pgid(stage.pid()), stage.pid() as i32);
	stage.signal(Signal::Kill).unwrap();
	wait(&mut stage);
}

/// Running or sleeping (not stopped, not a zombie, not gone).
fn live(pid: i32) -> bool {
	proc::info(pid).is_some_and(|i| !matches!(i.state, ProcState::Zombie | ProcState::Stopped))
}

fn gone(pid: i32) -> bool {
	proc::info(pid).is_none_or(|i| i.state == ProcState::Zombie)
}

/// The first child of `parent` (the scan sees it once it has forked).
fn child_of(parent: i32) -> proc::ProcInfo {
	let mut found = None;
	until("grandchild forked", || {
		found = proc::list().unwrap().into_iter().find(|p| p.ppid == parent);
		found.is_some()
	});
	found.unwrap()
}

/// Non-interactive bash layout: the child shares the host's group and
/// session (so it keeps the controlling terminal), `PgroupSpec` is ignored,
/// and signals, stop and cont reach the child alone, never the shared group.
#[test]
fn inherit_keeps_the_hosts_group_and_signals_only_the_child() {
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, Duration::from_secs(2));
	let a = sh("/bin/sleep 30 & wait");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid();
	assert_eq!((pgid(pid), sid(pid)), (pgid(0), our_sid()), "host's group and session");
	let grandchild = child_of(pid as i32);
	let b = argv(&["/bin/sleep", "30"]);
	let mut joined = s.spawn(spec(&b, &env, PgroupSpec::Join(pid))).unwrap();
	assert_eq!(pgid(joined.pid()), pgid(0), "Join is ignored too");
	joined.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut joined), ExitStatus::Signaled(Signal::Kill));
	assert!(live(pid as i32), "a signal to one external spares its siblings");

	p.stop().unwrap();
	until("child stopped", || proc::info(pid as i32).is_some_and(|i| i.state == ProcState::Stopped));
	assert!(live(grandchild.pid), "stop reaches the child only");
	p.cont().unwrap();
	until("child continued", || live(pid as i32));
	p.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Kill));
	assert!(live(grandchild.pid), "the grandchild is outside the child's scope");
	assert!(proc::signal_pinned(&grandchild, Signal::Kill).unwrap());
	until("grandchild gone", || gone(grandchild.pid));
}

/// The abandon escalation (TERM, KILL after the grace) targets the child's
/// pid: a process sharing the host's group survives it.
#[test]
fn inherit_abandon_escalation_spares_the_hosts_group() {
	let grace = Duration::from_millis(300);
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, grace);
	let mut bystander = std::process::Command::new("/bin/sleep")
		.arg("30")
		.spawn()
		.unwrap();
	assert_eq!(pgid(bystander.id()), pgid(0));
	// `exec` keeps the ignored TERM: one process that only KILL ends.
	let a = sh("trap '' TERM; exec /bin/sleep 30");
	let p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid() as i32;
	until("exec'd", || proc::info(pid).is_some_and(|i| i.name == "sleep"));
	let start = Instant::now();
	drop(p);
	thread::sleep(grace / 2);
	assert!(live(pid), "TERM is ignored, KILL waits for the grace");
	until("child killed", || gone(pid));
	assert!(start.elapsed() >= grace);
	assert!(bystander.try_wait().unwrap().is_none(), "nothing was sent to the host's process group");
	bystander.kill().unwrap();
	bystander.wait().unwrap();
}

/// Reaping retires a process-only leak scope before its pid can be reused.
#[test]
fn reaping_retires_inherited_process_scope() {
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, Duration::from_secs(2));
	let a = sh("exit 0");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let scope = Scope::Process { pid: p.pid() as i32 };
	assert!(s.shared.state.groups.lock().list.contains(&scope));
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	// A live ExtProc still pins the zombie's identity for signals.
	assert!(s.shared.state.groups.lock().list.contains(&scope));
	drop(p);
	assert!(!s.shared.state.groups.lock().list.contains(&scope));
}

#[test]
fn inherit_leftovers_track_the_child_itself() {
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, Duration::from_secs(2));
	let a = argv(&["/bin/sleep", "30"]);
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid();
	let left = s.leftovers().unwrap();
	assert_eq!(left.len(), 1, "{left:?}");
	assert_eq!((left[0].pid, left[0].group), (pid, pid), "the pid is its own scope");
	p.signal(Signal::Kill).unwrap();
	wait(&mut p);
	drop(p);
	assert!(s.leftovers().unwrap().is_empty(), "the test process itself is never listed");
}

#[test]
fn stop_and_cont_reach_every_member_of_the_group() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(2));
	let a = sh("/bin/sleep 30 & /bin/sleep 30 & wait");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let group = p.pid() as i32;
	until("three members", || live_group(group).len() == 3);
	p.stop().unwrap();
	until("all stopped", || {
		live_group(group)
			.iter()
			.all(|m| m.state == ProcState::Stopped)
	});
	p.cont().unwrap();
	until("all continued", || {
		live_group(group)
			.iter()
			.all(|m| m.state != ProcState::Stopped)
	});
	p.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Kill));
	until("group gone", || live_group(group).is_empty());
}

/// Cancel of a running external: TERM to the group at once, KILL after the
/// grace. Observe the fixture, not a full process-table scan that can itself
/// outlast the grace on a busy host.
fn abandon_escalates(grace: Duration) -> Duration {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, grace);
	// The trap makes sh and the sleep it starts ignore TERM.
	let a = sh("trap '' TERM; /bin/sleep 30; exit 0");
	let p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let group = p.pid() as i32;
	let mut members = Vec::new();
	until("sleep started", || {
		members = live_group(group);
		members.len() == 2
	});
	let start = Instant::now();
	drop(p);
	until("group killed", || {
		let mut killed = true;
		for member in &members {
			let gone = proc::info(member.pid)
				.is_none_or(|now| now.start != member.start || now.state == ProcState::Zombie);
			if gone {
				assert!(start.elapsed() >= grace, "KILL before the grace: pid {}", member.pid);
			}
			killed &= gone;
		}
		killed
	});
	let measured = start.elapsed();
	eprintln!("TERM→KILL escalation: grace {grace:?}, measured {measured:?}");
	assert!(measured >= grace, "KILL before the grace: {measured:?}");
	measured
}

/// A detached external (`nohup`) dropped while it runs is released, not
/// abandoned: no TERM, no KILL after the grace, no leftover; it is reaped
/// once it exits.
#[test]
fn dropped_detached_external_runs_on_and_is_no_leftover() {
	let env = EnvView::default();
	let s = spawner(Sessions::Detach, Duration::from_millis(100));
	let a = argv(&["/bin/sleep", "30"]);
	let mut detached = spec(&a, &env, NEW);
	detached.lineage = crate::bash::Lineage { label: 7, detached: true };
	let p = s.spawn(detached).unwrap();
	let pid = p.pid() as i32;
	assert!(s.leftovers().unwrap().is_empty(), "a detached external is no leak");
	drop(p);
	thread::sleep(Duration::from_millis(400));
	assert!(live(pid), "released, not killed after the grace");
	// SAFETY: plain syscall; the pid is unreaped while the sleep runs.
	assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
	until("reaped after its exit", || proc::info(pid).is_none());
}

/// The shell tears down while a detached external runs: its `ExtProc` is
/// dropped, but what it writes after that still reaches the engine object,
/// as a pipe would carry it, and its end of file completes the work. With no
/// runtime, the retained output work advances whenever anyone polls it:
/// here a drive loop before it parks (as a `Parker` does).
#[test]
fn output_written_after_the_extproc_is_dropped_still_arrives() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let out = MemFile::default();
	let a = sh("/bin/sleep 0.3; echo late");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	sp.lineage = crate::bash::Lineage { label: 0, detached: true };
	drop(s.spawn(sp).unwrap());
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	let cx = Context::from_waker(&waker);
	let deadline = Instant::now() + LONG;
	while out.captured() != b"late\n" {
		assert!(Instant::now() < deadline, "late output lost: {:?}", out.captured());
		NativeSpawner::poll_orphans(&cx);
		thread::park_timeout(Duration::from_millis(50));
	}
}

#[test]
fn abandoned_external_is_killed_after_a_short_grace() {
	let grace = Duration::from_millis(300);
	let measured = abandon_escalates(grace);
	assert!(measured < grace + Duration::from_secs(1), "KILL late: {measured:?}");
}

#[test]
fn abandoned_external_is_killed_after_the_default_grace() {
	let measured = abandon_escalates(SpawnConfig::DEFAULT_GRACE);
	assert!(measured < SpawnConfig::DEFAULT_GRACE + Duration::from_secs(1), "{measured:?}");
}

#[test]
fn abandon_sends_term_to_the_whole_group_at_once() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(60));
	let a = sh("/bin/sleep 30 & /bin/sleep 30 & wait");
	let p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let group = p.pid() as i32;
	until("members up", || live_group(group).len() == 3);
	drop(p);
	let t = until("group terminated", || live_group(group).is_empty());
	assert!(t < Duration::from_secs(5), "TERM did not reach the group: {t:?}");
}

#[test]
fn abandoning_a_paused_job_still_terminates_it() {
	let env = EnvView::default();
	let s = spawner(Sessions::Detach, Duration::from_secs(60));
	let a = argv(&["/bin/sleep", "30"]);
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid() as i32;
	p.stop().unwrap();
	until("stopped", || proc::info(pid).is_some_and(|i| i.state == ProcState::Stopped));
	drop(p);
	until("terminated", || proc::info(pid).is_none_or(|i| i.state == ProcState::Zombie));
}

/// KILLs (and continues) a stray process when a case ends, failed or not.
struct KillOnDrop(proc::ProcInfo);

impl Drop for KillOnDrop {
	fn drop(&mut self) {
		let _ = proc::signal_pinned(&self.0, Signal::Kill);
		let _ = proc::signal_pinned(&self.0, Signal::Cont);
	}
}

/// A debugger's inferior (lldb's, which outlived a timed-out job stopped
/// and orphaned): a grandchild that moved to a session of its own and
/// stopped itself is outside the external's session, and the cancel's TERM
/// kills its parent and leaves it to init before the KILL. The cancel
/// (TERM, then the drop) must still kill it.
///
/// Needs `/usr/bin/perl` (macOS and Debian-family Linux ship it) for `setsid`.
#[test]
fn cancel_kills_a_stopped_grandchild_in_a_session_of_its_own() {
	let env = EnvView::default();
	let grace = Duration::from_millis(300);
	let s = spawner(Sessions::Detach, grace);
	// It ignores TERM and HUP and sleeps on once continued: only the KILL
	// after the grace ends it, when its parent is long dead.
	let a = sh("/usr/bin/perl -e '$SIG{HUP} = $SIG{TERM} = q(IGNORE); use POSIX (); \
	            POSIX::setsid() > 0 or die; kill(q(STOP), $$); sleep 30' & wait");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid() as i32;
	let inferior = KillOnDrop(child_of(pid));
	let ipid = inferior.0.pid;
	until("grandchild stopped in its own session", || {
		proc::info(ipid).is_some_and(|i| i.state == ProcState::Stopped && i.sid == ipid)
	});
	let start = Instant::now();
	p.signal(Signal::Term).unwrap();
	drop(p);
	until("grandchild killed", || {
		proc::info(ipid).is_none_or(|i| i.start != inferior.0.start || i.state == ProcState::Zombie)
	});
	assert!(start.elapsed() >= grace, "it ignores TERM: only the KILL ends it");
}

#[test]
fn a_scripts_term_does_not_escalate() {
	let env = EnvView::default();
	let s = spawner(Sessions::Detach, Duration::from_millis(100));
	let a = sh("trap '' TERM; while :; do /bin/sleep 1; done");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid() as i32;
	// The first sleep is forked after the trap is set: TERM is ignored now.
	until("trap set", || {
		proc::session_members(pid)
			.unwrap()
			.iter()
			.filter(|m| m.state != ProcState::Zombie)
			.count()
			>= 2
	});
	p.signal(Signal::Term).unwrap();
	thread::sleep(Duration::from_millis(500));
	assert!(
		proc::info(pid).is_some_and(|i| i.state != ProcState::Zombie),
		"`kill -TERM` alone never kills"
	);
	p.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Kill));
}

#[test]
fn output_is_delivered_before_completion() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let (out, err) = (MemFile::default(), MemFile::default());
	let a = sh("printf hello; printf oops >&2; exit 4");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), err.boxed()];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(4));
	assert_eq!(out.captured(), b"hello", "complete as soon as the command is");
	assert_eq!(err.captured(), b"oops");
}

/// An engine pipe that is full until opened: writes stay `Pending`.
#[derive(Clone, Default)]
struct Gate {
	open:   Arc<Mutex<(bool, Option<Waker>)>>,
	output: Arc<Mutex<Vec<u8>>>,
}

impl File for Gate {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Ok(0))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		let mut g = self.open.lock();
		if !g.0 {
			g.1 = Some(cx.waker().clone());
			return Poll::Pending;
		}
		self.output.lock().extend_from_slice(buf);
		Poll::Ready(Ok(buf.len()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

#[test]
fn exit_is_not_reported_before_the_output_reaches_the_engine() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let gate = Gate::default();
	let a = sh("printf hello");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, StdioSpec::File(Box::new(gate.clone())), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	let pid = p.pid() as i32;
	until("child exited", || proc::info(pid).is_some_and(|i| i.state == ProcState::Zombie));
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	let mut cx = Context::from_waker(&waker);
	thread::sleep(Duration::from_millis(200));
	assert!(p.poll_wait(&mut cx).is_pending(), "the pump still holds the output");
	let pump = {
		let mut g = gate.open.lock();
		g.0 = true;
		g.1.take().expect("the pump waits on the full pipe")
	};
	pump.wake();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(*gate.output.lock(), b"hello");
}

#[test]
fn input_pump_feeds_stdin_until_end_of_file() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
	let out = MemFile::default();
	let a = argv(&["/bin/cat"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [MemFile::feed(&data).boxed(), out.boxed(), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), data, "every byte crosses both pumps, then EOF");
}

/// An engine sink that is full (`Pending`, waking its writer at once) every
/// other write and takes at most 1000 bytes otherwise.
#[derive(Clone, Default)]
struct Trickle {
	full:   Arc<std::sync::atomic::AtomicBool>,
	output: Arc<Mutex<Vec<u8>>>,
}

impl File for Trickle {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Ok(0))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if self
			.full
			.fetch_xor(true, std::sync::atomic::Ordering::SeqCst)
		{
			cx.waker().wake_by_ref();
			return Poll::Pending;
		}
		let n = buf.len().min(1000);
		self.output.lock().extend_from_slice(&buf[..n]);
		Poll::Ready(Ok(n))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

/// Megabytes of output through partial writes and a sink that keeps
/// filling up: the output pump holds the child back (its pipe fills) and
/// delivers every byte in order before the exit is reported.
#[test]
fn large_output_crosses_a_slow_engine_sink_intact() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let sink = Trickle::default();
	let a = argv(&["/usr/bin/seq", "1", "200000"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, StdioSpec::File(Box::new(sink.clone())), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	let expected = (1..=200_000).fold(String::new(), |mut all, i| {
		use std::fmt::Write as _;
		let _ = writeln!(all, "{i}");
		all
	});
	assert!(*sink.output.lock() == expected.as_bytes(), "output lost, doubled or reordered");
}

/// An engine source that never has bytes (and never wakes anyone); counts
/// its live copies.
#[derive(Clone, Default)]
struct Silent(Arc<()>);

impl File for Silent {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Pending
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

/// Input waiting for engine bytes that never come stops with the child:
/// at its exit (the cancel wakes the poller, which drops the input pump
/// and the engine object before reporting the exit), and when the `ExtProc`
/// of a running child is dropped.
#[test]
fn input_waiting_for_engine_bytes_is_dropped_with_the_child() {
	let env = EnvView::default();
	let s = NativeSpawner::new(SpawnConfig {
		grace: Duration::from_millis(300),
		..SpawnConfig::default()
	});
	let silent = Silent::default();
	let a = sh("exit 3");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::File(Box::new(silent.clone())), StdioSpec::Null, StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(3));
	assert_eq!(Arc::strong_count(&silent.0), 1, "the exit released the engine object");
	drop(p);

	let a = argv(&["/bin/sleep", "30"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::File(Box::new(silent.clone())), StdioSpec::Null, StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	assert!(p.poll_wait(&mut Context::from_waker(&waker)).is_pending());
	assert_eq!(Arc::strong_count(&silent.0), 2, "the input pump waits on the engine object");
	drop(p);
	assert_eq!(Arc::strong_count(&silent.0), 1, "the drop released it at once");
	until("the abandoned child is gone", || s.leftovers().unwrap().is_empty());
}

#[test]
fn external_dies_of_sigpipe_when_the_engine_reader_is_gone() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = argv(&["/usr/bin/yes"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, MemFile::broken().boxed(), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	// The test harness ignores SIGPIPE; the child gets the default back, so
	// PIPESTATUS shows 141 like bash.
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Pipe));
}

#[test]
fn ignored_sigpipe_turns_into_a_write_error() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = argv(&["/usr/bin/yes"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, MemFile::broken().boxed(), StdioSpec::Null];
	sp.sigmask_ign = SigSet::EMPTY.with(Signal::Pipe);
	let mut p = s.spawn(sp).unwrap();
	match wait(&mut p) {
		ExitStatus::Exited(code) => assert_ne!(code, 0, "yes reports the EPIPE"),
		other => panic!("SIGPIPE was not ignored: {other:?}"),
	}
}

#[cfg(target_os = "linux")]
#[test]
fn ignored_realtime_max_reaches_the_child() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_millis(100));
	let a = sh("kill -s 64 $$; exit 7");
	let mut sp = spec(&a, &env, NEW);
	sp.sigmask_ign = SigSet::EMPTY.with(Signal::Rtmax);
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(7));
}

/// Whether the test process ignores `sig`.
fn host_ignores(sig: libc::c_int) -> bool {
	// SAFETY: sigaction is plain data, valid zeroed.
	let mut old: libc::sigaction = unsafe { std::mem::zeroed() };
	// SAFETY: a null new action only queries; `old` is writable.
	let rc = unsafe { libc::sigaction(sig, std::ptr::null(), &raw mut old) };
	rc == 0 && old.sa_sigaction == libc::SIG_IGN
}

#[test]
fn ignored_signals_reach_the_child_through_the_fork_path() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("kill -USR1 $$; exit 7");
	assert!(!host_ignores(libc::SIGUSR1));
	let mut sp = spec(&a, &env, NEW);
	sp.sigmask_ign = SigSet::EMPTY.with(Signal::Usr1);
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(7), "USR1 ignored on entry");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Usr1), "default disposition");
}

#[test]
fn signal_the_host_ignores_after_a_spawn_is_reset_in_later_children() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("kill -USR2 $$; exit 7");
	assert_eq!(wait(&mut s.spawn(spec(&a, &env, NEW)).unwrap()), ExitStatus::Signaled(Signal::Usr2));
	// SAFETY: nextest runs each test in its own process; nothing else here
	// uses USR2, and the default comes back below.
	unsafe { libc::signal(libc::SIGUSR2, libc::SIG_IGN) };
	crate::sys::dispositions_changed();
	let status = wait(&mut s.spawn(spec(&a, &env, NEW)).unwrap());
	// SAFETY: as above.
	unsafe { libc::signal(libc::SIGUSR2, libc::SIG_DFL) };
	crate::sys::dispositions_changed();
	assert_eq!(
		status,
		ExitStatus::Signaled(Signal::Usr2),
		"the host's new SIG_IGN leaked into the child"
	);
}

/// The signals the calling thread blocks.
#[cfg(target_os = "linux")]
fn blocked_here() -> Vec<i32> {
	// SAFETY: sigset_t is plain data, valid zeroed; a null new set only
	// queries the mask.
	unsafe {
		let mut now = std::mem::zeroed::<libc::sigset_t>();
		libc::pthread_sigmask(libc::SIG_BLOCK, std::ptr::null(), &raw mut now);
		(1..=64)
			.filter(|&n| libc::sigismember(&raw const now, n) == 1)
			.collect()
	}
}

/// The calling thread's mask as the kernel holds it, the libcs' own signals
/// included: bit `n - 1` for signal `n`; `None` where the read failed (its
/// errno is set). A null new set only reads, and with `SIG_BLOCK` as its
/// `how` no filter of `refused_calls` refuses the call. `/proc`'s `SigBlk`
/// line says the same, but a sandbox such as gVisor does not write it.
#[cfg(target_os = "linux")]
fn read_mask() -> Option<u64> {
	let mut mask = 0u64;
	// SAFETY: a null new set only reads the mask, into the kernel's
	// 64-signal set.
	let rc = unsafe {
		libc::syscall(
			libc::SYS_rt_sigprocmask,
			libc::SIG_BLOCK,
			std::ptr::null::<u64>(),
			&raw mut mask,
			size_of::<u64>(),
		)
	};
	(rc == 0).then_some(mask)
}

/// [`read_mask`], which does not fail here.
#[cfg(target_os = "linux")]
fn thread_mask() -> u64 {
	match read_mask() {
		Some(mask) => mask,
		None => panic!("the mask read failed: {}", io::Error::last_os_error()),
	}
}

/// The environment variable that has this test binary report the mask it
/// started with ([`report_start_mask`]), and the status it exits with once
/// it did.
#[cfg(target_os = "linux")]
const MASK_PROBE: &std::ffi::CStr = c"PI_SHELL_SPAWN_MASK_PROBE";
#[cfg(target_os = "linux")]
const MASK_PROBE_RAN: i32 = 70;

/// [`report_start_mask`], run by the loader before `main` in each process
/// of this test binary.
#[cfg(target_os = "linux")]
#[used]
#[unsafe(link_section = ".init_array")]
static REPORT_START_MASK: extern "C" fn() = report_start_mask;

/// The probe a test spawns through the route it tests ([`program_mask`]):
/// where [`MASK_PROBE`] is set, write the mask this process started with to
/// fd 1, as 16 hex digits, and exit with [`MASK_PROBE_RAN`]; elsewhere
/// return. It reads the kernel's mask ([`read_mask`]), so it answers where
/// `/proc` has no `SigBlk` line, and it reads it before `main`, on the main
/// thread before any other starts: a test runs on a thread libtest starts,
/// and the first `pthread_create` of a glibc process unblocks glibc's
/// signals 32 and 33 on the thread that calls it (a thread it starts has 32
/// unblocked). Before `main` it calls only the C library: no allocation, no
/// `std` I/O.
#[cfg(target_os = "linux")]
extern "C" fn report_start_mask() {
	// SAFETY: a NUL-terminated name; nothing changes the environment before
	// `main`.
	if unsafe { libc::getenv(MASK_PROBE.as_ptr()) }.is_null() {
		return;
	}
	let mask = read_mask();
	let bits = mask.unwrap_or_default();
	let mut line = *b"0000000000000000\n";
	for (n, digit) in line[..16].iter_mut().enumerate() {
		*digit = b"0123456789abcdef"[((bits >> (60 - 4 * n)) & 0xf) as usize];
	}
	let status = mask.map_or(MASK_PROBE_RAN + 1, |_| MASK_PROBE_RAN);
	// SAFETY: writes the initialized line to fd 1, then ends the process
	// without running `main`.
	unsafe {
		libc::write(1, line.as_ptr().cast(), line.len());
		libc::_exit(status);
	}
}

/// The mask a program `s` spawns starts with: this test binary as the probe
/// [`report_start_mask`], with the test process's environment.
#[cfg(target_os = "linux")]
fn program_mask(s: &NativeSpawner) -> u64 {
	let me = std::env::current_exe().unwrap();
	// A filter that names no test: where the probe did not run, libtest
	// runs nothing and exits 0, rather than every test again.
	let a = [
		BString::from(me.as_os_str().as_encoded_bytes()),
		BString::from("--exact"),
		BString::from("the mask probe did not run"),
	];
	let mut pairs: Vec<(BString, BString)> = std::env::vars_os()
		.map(|(k, v)| (BString::from(k.as_encoded_bytes()), BString::from(v.as_encoded_bytes())))
		.collect();
	pairs.push((BString::from(MASK_PROBE.to_bytes()), BString::from("1")));
	let env = EnvView::new(pairs);
	let out = MemFile::default();
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	let status = wait(&mut s.spawn(sp).unwrap());
	let said = String::from_utf8(out.captured()).unwrap();
	assert_eq!(status, ExitStatus::Exited(MASK_PROBE_RAN), "the probe said {said:?}");
	let mask = u64::from_str_radix(said.trim_end(), 16);
	mask.unwrap_or_else(|_| panic!("the probe said {said:?}"))
}

/// Failure mode: the program starts with the signals its spawning thread
/// blocks still blocked (a TERM would not end it), or the spawn leaves the
/// spawning thread with another mask than it had.
#[cfg(target_os = "linux")]
#[test]
fn the_child_starts_with_no_signal_blocked_and_the_thread_keeps_its_mask() {
	let (status, blocked) = thread::spawn(|| {
		// SAFETY: sigset_t is plain data, valid zeroed; the calls only read
		// and write the sets passed.
		unsafe {
			let mut term = std::mem::zeroed::<libc::sigset_t>();
			libc::sigemptyset(&raw mut term);
			libc::sigaddset(&raw mut term, libc::SIGTERM);
			libc::pthread_sigmask(libc::SIG_SETMASK, &raw const term, std::ptr::null_mut());
		}
		let env = EnvView::default();
		let a = argv(&["/bin/sleep", "30"]);
		let mut p = NativeSpawner::default().spawn(spec(&a, &env, NEW)).unwrap();
		p.signal(Signal::Term).unwrap();
		(wait(&mut p), blocked_here())
	})
	.join()
	.unwrap();
	assert_eq!(status, ExitStatus::Signaled(Signal::Term), "TERM stayed blocked in the child");
	assert_eq!(blocked, [libc::SIGTERM], "the spawning thread's mask");
}

/// glibc's own signals 32 and 33: bit `n - 1` for signal `n`.
#[cfg(target_os = "linux")]
const GLIBC_SIGNALS: u64 = (1 << (32 - 1)) | (1 << (33 - 1));

/// Change the calling thread's mask by `how` with `set` through the system
/// call, which takes glibc's signals 32 and 33 too (`pthread_sigmask`
/// leaves them out).
#[cfg(target_os = "linux")]
fn change_mask(how: libc::c_int, set: u64) {
	// SAFETY: the kernel's 64-signal set, valid for the call; no old set
	// wanted.
	let rc = unsafe {
		libc::syscall(
			libc::SYS_rt_sigprocmask,
			how,
			&raw const set,
			std::ptr::null_mut::<u64>(),
			size_of::<u64>(),
		)
	};
	assert_eq!(rc, 0, "{}", io::Error::last_os_error());
}

/// Failure mode: the program starts with glibc's own signals 32 and 33
/// blocked, which its spawning thread blocks through the raw call
/// (`pthread_sigmask` leaves them out). The program is this binary's probe
/// ([`report_start_mask`]).
#[cfg(target_os = "linux")]
#[test]
fn the_child_starts_with_signals_32_and_33_unblocked() {
	let program = thread::spawn(|| {
		change_mask(libc::SIG_BLOCK, GLIBC_SIGNALS);
		assert_eq!(thread_mask() & GLIBC_SIGNALS, GLIBC_SIGNALS, "the raw block took");
		program_mask(&NativeSpawner::default())
	})
	.join()
	.unwrap();
	assert_eq!(program, 0, "the program's mask: {program:#x}");
}

/// Failure mode: a spawn puts its thread's mask back through glibc's
/// `pthread_sigmask`, which leaves glibc's own signals 32 and 33 out of a
/// set it sets: a spawning thread that blocks them through the raw call has
/// them unblocked after the spawn. Each route: the vfork child, the bare
/// `fork` of a spawn with redirections, the measuring helper of `time`
/// (exec'd by a vfork child), and a foreground job on each, whose terminal
/// the spawning thread hands over with `SIGTTOU` blocked. glibc only: musl's
/// `pthread_sigmask` takes 32 to 34 out of the mask it reads, so no restore
/// of that mask can keep them blocked.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn a_spawn_keeps_the_spawning_threads_block_on_signals_32_and_33() {
	use std::os::fd::AsRawFd as _;

	let (held, changed) = thread::spawn(|| {
		change_mask(libc::SIG_BLOCK, GLIBC_SIGNALS);
		let held = thread_mask();
		assert_eq!(held & GLIBC_SIGNALS, GLIBC_SIGNALS, "the raw block took");
		// Any descriptor serves as the job's terminal: the handover
		// (`tcsetpgrp`) then fails, harmlessly, between the mask's block and
		// its restore.
		let null = std::fs::File::open("/dev/null").unwrap();
		let terminal = Some(OsHandle(null.as_raw_fd() as u64));
		let job = PgroupSpec::Job { join: None, terminal };
		let redirs = ChildRedirs {
			list:      vec![ChildRedir::Close { fd: 9 }],
			exec_diag: BString::from("test: /bin/sh: "),
		};
		let env = EnvView::default();
		let a = sh(":");
		let s = spawner(Sessions::Share, Duration::from_millis(100));
		let mut changed = Vec::new();
		for (route, pgroup, redirs, measured) in [
			("vfork", NEW, None, false),
			("vfork, foreground job", job, None, false),
			("fork with redirections", NEW, Some(redirs.clone()), false),
			("fork with redirections, foreground job", job, Some(redirs), false),
			("measured", NEW, None, true),
			("measured, foreground job", job, None, true),
		] {
			let mut sp = spec(&a, &env, pgroup);
			sp.redirs = redirs;
			let spawned = if measured {
				s.spawn_measured(sp)
			} else {
				s.spawn(sp)
			};
			assert_eq!(wait(&mut spawned.unwrap()), ExitStatus::Exited(0), "{route}");
			let mask = thread_mask();
			if mask != held {
				changed.push(format!("{route}: {mask:#x}"));
				change_mask(libc::SIG_SETMASK, held);
			}
		}
		(held, changed)
	})
	.join()
	.unwrap();
	assert!(changed.is_empty(), "the spawning thread's mask {held:#x} became {changed:?}");
}

/// System calls a seccomp filter refuses, as a container's or a sandbox's
/// syscall filter may. The vfork child shares the host's memory: the spawn
/// must not clone while its launcher's signals stay deliverable, nor start
/// a program whose signal state or limits the child could not set, nor
/// leave a launcher that keeps every signal blocked to start more children,
/// nor change the spawning thread's mask, nor enter a libc's thread
/// machinery in the child. Each spawn runs on a thread of its own, under a
/// filter only that thread, its launcher and its child have, and each test
/// runs alone in a process of its own ([`alone`]).
#[cfg(all(
	target_os = "linux",
	target_endian = "little",
	any(target_arch = "x86_64", target_arch = "aarch64")
))]
mod refused_calls {
	use std::{
		ffi::c_int,
		io,
		ops::Range,
		ptr,
		sync::atomic::{AtomicBool, AtomicI32, AtomicU64, AtomicUsize, Ordering},
		thread,
		time::{Duration, Instant},
	};

	use super::super::vfork;

	/// The errno of a refused call.
	const REFUSED: c_int = libc::EPERM;

	// Classic BPF (`linux/filter.h`) over `seccomp_data` (`linux/seccomp.h`):
	// load the word at an offset; jump where it is equal, greater, greater
	// or equal; return. The filter's two answers; the architecture it reads.
	const LOAD: u16 = 0x20;
	const JEQ: u16 = 0x15;
	const JGT: u16 = 0x25;
	const JGE: u16 = 0x35;
	const RET: u16 = 0x06;
	const ALLOW: u32 = 0x7fff_0000;
	const ERRNO: u32 = 0x0005_0000;
	#[cfg(target_arch = "x86_64")]
	const ARCH: u32 = 0xc000_003e; // AUDIT_ARCH_X86_64
	#[cfg(target_arch = "aarch64")]
	const ARCH: u32 = 0xc000_00b7; // AUDIT_ARCH_AARCH64

	/// Where an instruction jumps: to the next one, over `n` more, past the
	/// condition it checks (which holds), or past its rule (the call does
	/// not match it).
	#[derive(Clone, Copy)]
	enum To {
		Next,
		Skip(u8),
		Holds,
		Miss,
	}

	/// An instruction: its code, its operand and its two jumps.
	type Op = (u16, u32, To, To);

	/// The offset of argument `n`'s low word in `seccomp_data`; its high
	/// word follows.
	const fn arg(n: usize) -> u32 {
		16 + 8 * n as u32
	}

	/// A condition on a call: its number, or one of its arguments, which the
	/// kernel passes as 64 bits.
	enum Cond {
		Nr(libc::c_long),
		/// The argument's low 32 bits are this value.
		Is(usize, u32),
		/// The argument lies in the range.
		In(usize, Range<u64>),
		/// The argument lies outside the range.
		Out(usize, Range<u64>),
	}

	impl Cond {
		/// The instructions that check the condition: on past them where it
		/// holds, past the rule (`To::Miss`) where it does not.
		fn compile(&self) -> Vec<Op> {
			use To::{Holds, Miss, Next, Skip};
			let mut ops = match self {
				Self::Nr(nr) => vec![(LOAD, 0, Next, Next), (JEQ, *nr as u32, Holds, Miss)],
				Self::Is(n, value) => vec![(LOAD, arg(*n), Next, Next), (JEQ, *value, Holds, Miss)],
				Self::In(n, range) => within(*n, range, Miss, Holds),
				Self::Out(n, range) => within(*n, range, Holds, Miss),
			};
			let len = ops.len();
			for (i, op) in ops.iter_mut().enumerate() {
				for to in [&mut op.2, &mut op.3] {
					if matches!(to, Holds) {
						*to = Skip((len - i - 1) as u8);
					}
				}
			}
			ops
		}
	}

	/// The instructions that check whether argument `n` lies in `range`: on
	/// to `inside` or to `outside`.
	fn within(n: usize, range: &Range<u64>, outside: To, inside: To) -> Vec<Op> {
		use To::{Next, Skip};
		let (start, end) = (range.start, range.end);
		vec![
			// At or above the start: the high words decide, or else the low.
			(LOAD, arg(n) + 4, Next, Next),
			(JGT, (start >> 32) as u32, Skip(3), Next),
			(JEQ, (start >> 32) as u32, Next, outside),
			(LOAD, arg(n), Next, Next),
			(JGE, start as u32, Next, outside),
			// Below the end, likewise.
			(LOAD, arg(n) + 4, Next, Next),
			(JGT, (end >> 32) as u32, outside, Next),
			(JEQ, (end >> 32) as u32, Next, inside),
			(LOAD, arg(n), Next, Next),
			(JGE, end as u32, outside, inside),
		]
	}

	/// A seccomp filter: a call that matches one of its rules fails with
	/// the rule's errno; every other call runs.
	#[derive(Default)]
	struct Filter(Vec<libc::sock_filter>);

	impl Filter {
		/// Refuse call `nr` with `errno` where every condition holds.
		fn refuse(mut self, nr: libc::c_long, conds: &[Cond], errno: c_int) -> Self {
			let mut rule = Cond::Nr(nr).compile();
			for cond in conds {
				rule.extend(cond.compile());
			}
			rule.push((RET, ERRNO | errno as u32, To::Next, To::Next));
			let len = rule.len();
			for (i, (code, k, jt, jf)) in rule.into_iter().enumerate() {
				let offset = |to: To| match to {
					To::Next => 0,
					To::Skip(n) => n,
					// The instruction after the rule's return.
					To::Miss => (len - i - 1) as u8,
					To::Holds => unreachable!("`Cond::compile` resolves it"),
				};
				let op = libc::sock_filter { code, jt: offset(jt), jf: offset(jf), k };
				self.0.push(op);
			}
			self
		}

		/// Install the filter on the calling thread; the children it starts
		/// inherit it.
		fn install(self) -> io::Result<()> {
			let rules = u8::try_from(self.0.len()).unwrap();
			// Another architecture's calls run: their numbers differ.
			let load = libc::sock_filter { code: LOAD, jt: 0, jf: 0, k: 4 };
			let arch = libc::sock_filter { code: JEQ, jt: 0, jf: rules, k: ARCH };
			let allow = libc::sock_filter { code: RET, jt: 0, jf: 0, k: ALLOW };
			let mut program = vec![load, arch];
			program.extend(self.0);
			program.push(allow);
			let prog = libc::sock_fprog {
				len:    u16::try_from(program.len()).unwrap(),
				filter: program.as_mut_ptr(),
			};
			// SAFETY: plain prctl calls; `prog` points at `program`, which the
			// kernel copies during the call.
			let rc = unsafe {
				if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 {
					libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &raw const prog)
				} else {
					-1
				}
			};
			if rc == 0 {
				Ok(())
			} else {
				Err(io::Error::last_os_error())
			}
		}
	}

	/// The calling thread's stack.
	fn this_thread_stack() -> Range<u64> {
		// SAFETY: `attr` is plain data, filled by `pthread_getattr_np` before
		// it is read and destroyed; the other pointers are writable.
		unsafe {
			let mut attr = std::mem::zeroed::<libc::pthread_attr_t>();
			assert_eq!(libc::pthread_getattr_np(libc::pthread_self(), &raw mut attr), 0);
			let (mut low, mut size) = (ptr::null_mut(), 0);
			assert_eq!(libc::pthread_attr_getstack(&raw const attr, &raw mut low, &raw mut size), 0);
			libc::pthread_attr_destroy(&raw mut attr);
			let low = low as u64;
			low..low + size as u64
		}
	}

	/// The signals the spawning thread of [`under`] blocks: `SIGUSR1` and
	/// `SIGTERM`, bit `n - 1` for signal `n`.
	const THREAD_MASK: u64 = (1 << (libc::SIGUSR1 - 1)) | (1 << (libc::SIGTERM - 1));

	/// How long a test waits for a launcher to end, a child to be reaped or a
	/// program's output.
	const SETTLE: Duration = Duration::from_secs(10);

	/// What ran on the thread of [`under`]: its result, that thread's mask
	/// after it, and whether every launcher it started ended.
	struct Under<R> {
		result:         R,
		mask:           u64,
		launcher_ended: bool,
	}

	/// A spawn of `/bin/sh -c :` under a filter ([`spawn_under`]).
	type Spawned = Under<Result<c_int, vfork::Failure>>;

	impl Spawned {
		/// The errno the spawn failed with; `None` where it spawned.
		fn errno(&self) -> Option<c_int> {
			self.result.as_ref().err().map(vfork::Failure::errno)
		}

		/// Where the spawn failed; `None` where it spawned.
		fn stage(&self) -> Option<vfork::Stage> {
			self.result.as_ref().err().map(vfork::Failure::stage)
		}
	}

	/// The launchers of this process: its threads named `omp-spawn`.
	fn launchers() -> usize {
		std::fs::read_dir("/proc/self/task")
			.unwrap()
			.filter_map(Result::ok)
			.filter(|task| {
				std::fs::read_to_string(task.path().join("comm"))
					.is_ok_and(|comm| comm.trim_end() == "omp-spawn")
			})
			.count()
	}

	/// Whether the launchers of this process number `n` at most, within
	/// [`SETTLE`].
	fn launchers_down_to(n: usize) -> bool {
		let deadline = Instant::now() + SETTLE;
		loop {
			if launchers() <= n {
				return true;
			}
			if Instant::now() >= deadline {
				return false;
			}
			thread::sleep(Duration::from_millis(5));
		}
	}

	/// Run `run` on a thread of its own, which blocks [`THREAD_MASK`], under
	/// the filter `refuse` builds from that thread's stack. Where `retires`,
	/// the thread then waits ([`SETTLE`] at most), before it ends and its
	/// launcher with it, for the launchers `run` started to end.
	fn under<R: Send>(
		retires: bool,
		refuse: impl FnOnce(Range<u64>) -> Filter + Send,
		run: impl FnOnce() -> R + Send,
	) -> Under<R> {
		thread::scope(|scope| {
			let spawning = scope.spawn(move || {
				let mask = THREAD_MASK;
				// SAFETY: the kernel's 64-signal set, valid for the call; no old
				// set wanted.
				let rc = unsafe {
					libc::syscall(
						libc::SYS_rt_sigprocmask,
						libc::SIG_SETMASK,
						&raw const mask,
						ptr::null_mut::<u64>(),
						size_of::<u64>(),
					)
				};
				assert_eq!(rc, 0, "{}", io::Error::last_os_error());
				let filter = refuse(this_thread_stack());
				filter.install().expect("the filter installs");
				// The launchers start with the spawns: they have this thread's
				// filter.
				let before = launchers();
				let result = run();
				let mask = super::thread_mask();
				let launcher_ended = retires && launchers_down_to(before);
				Under { result, mask, launcher_ended }
			});
			spawning.join().unwrap()
		})
	}

	/// The spawn of `/bin/sh -c :` with `rlimits` on the calling thread's
	/// launcher.
	fn spawn_sh(rlimits: &[(vfork::Resource, libc::rlimit)]) -> Result<c_int, vfork::Failure> {
		let argv = [c"/bin/sh".as_ptr(), c"-c".as_ptr(), c":".as_ptr(), ptr::null()];
		let envp = [ptr::null()];
		let child = vfork::Child {
			path:    argv[0],
			argv:    argv.as_ptr(),
			envp:    envp.as_ptr(),
			cwd:     c"/".as_ptr(),
			session: false,
			group:   None,
			tty:     None,
			umask:   0o022,
			fds:     &[],
			closed:  &[],
			ignored: 0,
			limits:  rlimits,
		};
		// SAFETY: `child`'s strings and arrays outlive the spawn.
		unsafe { vfork::spawn(&child) }
	}

	/// The spawn of `/bin/sh -c :` with `rlimits` ([`under`]).
	fn spawn_under(
		rlimits: &[(vfork::Resource, libc::rlimit)],
		retires: bool,
		refuse: impl FnOnce(Range<u64>) -> Filter + Send,
	) -> Spawned {
		under(retires, refuse, || spawn_sh(rlimits))
	}

	/// [`super::alone`] for test `name` of this module.
	fn alone(name: &str) -> bool {
		super::alone(&format!("refused_calls::{name}"))
	}

	/// That this process has no child: the test runs alone in it.
	fn assert_no_child() {
		// SAFETY: plain syscall; `WNOHANG` does not wait.
		let rc = unsafe { libc::waitpid(-1, ptr::null_mut(), libc::WNOHANG) };
		assert_eq!(
			(rc, io::Error::last_os_error().raw_os_error()),
			(-1, Some(libc::ECHILD)),
			"the failed spawn left a child"
		);
	}

	/// Whether this process has no child within [`SETTLE`], without reaping
	/// one (another thread is to).
	fn childless_within_settle() -> bool {
		let deadline = Instant::now() + SETTLE;
		loop {
			// SAFETY: siginfo_t is plain data, valid zeroed; `WNOWAIT` leaves
			// the child unreaped and `WNOHANG` does not wait.
			let rc = unsafe {
				let mut info = std::mem::zeroed::<libc::siginfo_t>();
				let options = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
				libc::waitid(libc::P_ALL, 0, &raw mut info, options)
			};
			if rc < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
				return true;
			}
			if Instant::now() >= deadline {
				return false;
			}
			thread::sleep(Duration::from_millis(5));
		}
	}

	/// Whether `pid` is a child of ours that exits and stays unreaped: waits
	/// for its exit, and leaves it a zombie.
	fn exits_unreaped(pid: c_int) -> bool {
		// SAFETY: siginfo_t is plain data, valid zeroed; `info` is writable,
		// and waitid filled it where it returned 0.
		unsafe {
			let mut info = std::mem::zeroed::<libc::siginfo_t>();
			let options = libc::WEXITED | libc::WNOWAIT;
			let rc = libc::waitid(libc::P_PID, pid as libc::id_t, &raw mut info, options);
			rc == 0 && info.si_pid() == pid
		}
	}

	/// Refuse the launcher's unblock of its signals after the clone, and with
	/// `kill` its kill of the program it started.
	fn refuse_unblock(kill: bool) -> Filter {
		let unblock = [Cond::Is(0, libc::SIG_UNBLOCK as u32)];
		let filter = Filter::default().refuse(libc::SYS_rt_sigprocmask, &unblock, REFUSED);
		if kill {
			let sigkill = [Cond::Is(1, libc::SIGKILL as u32)];
			filter.refuse(libc::SYS_kill, &sigkill, REFUSED)
		} else {
			filter
		}
	}

	/// The lines a program wrote to `runs`, once one did ([`SETTLE`] at
	/// most) and a second, which a second start would write, had a second to.
	fn runs_of(runs: &std::path::Path) -> String {
		let deadline = Instant::now() + SETTLE;
		while std::fs::read_to_string(runs).unwrap_or_default().is_empty()
			&& Instant::now() < deadline
		{
			thread::sleep(Duration::from_millis(5));
		}
		thread::sleep(Duration::from_secs(1));
		std::fs::read_to_string(runs).unwrap_or_default()
	}

	/// Failure mode: the spawn clones although its launcher's signals stay
	/// deliverable, so one can run a host handler in the child, on the
	/// host's memory. The filter refuses the launcher's block alone (glibc
	/// blocks every signal to start a thread, with a set of its own), and
	/// the vfork clone too, with `ENOTSUP`: a spawn that clones fails with
	/// that errno instead.
	#[test]
	fn a_refused_block_of_the_launchers_signals_fails_the_spawn_before_the_clone() {
		if !alone("a_refused_block_of_the_launchers_signals_fails_the_spawn_before_the_clone") {
			return;
		}
		let spawned = spawn_under(&[], false, |_| {
			let all = (&raw const vfork::ALL_SIGNALS) as u64;
			let block = [Cond::Is(0, libc::SIG_BLOCK as u32), Cond::In(1, all..all + 8)];
			let clone = [Cond::Is(0, (libc::CLONE_VM | libc::CLONE_VFORK | libc::SIGCHLD) as u32)];
			Filter::default()
				.refuse(libc::SYS_rt_sigprocmask, &block, REFUSED)
				.refuse(libc::SYS_clone, &clone, libc::ENOTSUP)
		});
		assert_eq!(spawned.errno(), Some(REFUSED), "{:?}", spawned.result);
		assert_eq!(spawned.stage(), Some(vfork::Stage::Launcher));
		assert_eq!(spawned.mask, THREAD_MASK, "the spawning thread's mask");
		assert_no_child();
	}

	/// Failure mode: the program starts with a disposition its child could
	/// not reset: here `SIGPIPE`, which the test harness ignores, so a
	/// program whose reader is gone fails its writes instead of dying.
	#[test]
	fn a_refused_disposition_reset_in_the_child_fails_the_spawn() {
		if !alone("a_refused_disposition_reset_in_the_child_fails_the_spawn") {
			return;
		}
		let spawned = spawn_under(&[], false, |_| {
			let pipe = [Cond::Is(0, libc::SIGPIPE as u32)];
			Filter::default().refuse(libc::SYS_rt_sigaction, &pipe, REFUSED)
		});
		assert_eq!(spawned.errno(), Some(REFUSED), "{:?}", spawned.result);
		assert_eq!(spawned.stage(), Some(vfork::Stage::Child(vfork::Step::Dispositions)));
		assert_eq!(spawned.mask, THREAD_MASK, "the spawning thread's mask");
		assert_no_child();
	}

	/// Failure mode: the program starts with every signal blocked (a `TERM`
	/// would not end it), its child's change of the mask the clone left it
	/// refused. The child's set lies on its own stack, off the spawning
	/// thread's, whose own changes of its mask run, and off the launcher's
	/// idle set ([`vfork::IDLE_SIGNALS`]), whose block runs.
	#[test]
	fn a_refused_mask_change_in_the_child_fails_the_spawn() {
		if !alone("a_refused_mask_change_in_the_child_fails_the_spawn") {
			return;
		}
		let idle = ptr::from_ref::<u64>(&vfork::IDLE_SIGNALS) as u64;
		let spawned = spawn_under(&[], false, |stack| {
			let childs = [
				Cond::Is(0, libc::SIG_SETMASK as u32),
				Cond::Out(1, stack),
				Cond::Out(1, idle..idle + 8),
			];
			Filter::default().refuse(libc::SYS_rt_sigprocmask, &childs, REFUSED)
		});
		assert_eq!(spawned.errno(), Some(REFUSED), "{:?}", spawned.result);
		assert_eq!(spawned.stage(), Some(vfork::Stage::Child(vfork::Step::Mask)));
		assert_eq!(spawned.mask, THREAD_MASK, "the spawning thread's mask");
		assert_no_child();
	}

	/// Failure mode: the spawn returns the program while its launcher, its
	/// unblock refused, keeps every signal blocked and goes on to clone more
	/// children, or the spawning thread is left with every signal blocked;
	/// or it fails and leaves the program running with nothing to wait for
	/// it. Only the launcher's unblock is refused: the launcher alone
	/// unblocks.
	#[test]
	fn a_refused_unblock_of_the_launchers_signals_fails_the_spawn_and_ends_both() {
		if !alone("a_refused_unblock_of_the_launchers_signals_fails_the_spawn_and_ends_both") {
			return;
		}
		let spawned = spawn_under(&[], true, |_| refuse_unblock(false));
		assert_eq!(spawned.errno(), Some(REFUSED), "{:?}", spawned.result);
		assert_eq!(spawned.stage(), Some(vfork::Stage::Ran { unended: None }));
		assert_eq!(spawned.mask, THREAD_MASK, "the spawning thread's mask");
		assert!(spawned.launcher_ended, "the launcher whose signals stayed blocked goes on");
		assert_no_child();
	}

	/// Failure mode: a spawn whose program cannot be killed (its launcher's
	/// unblock and kill refused) returns it as spawned, or fails and leaves
	/// it with nothing to wait for it: here the program ends by itself, and
	/// its launcher reaps it, then ends.
	#[test]
	fn a_refused_kill_of_the_program_fails_the_spawn_and_the_launcher_reaps_it() {
		if !alone("a_refused_kill_of_the_program_fails_the_spawn_and_the_launcher_reaps_it") {
			return;
		}
		let spawned = spawn_under(&[], true, |_| refuse_unblock(true));
		assert!(
			matches!(spawned.stage(), Some(vfork::Stage::Ran { unended: Some(_) })),
			"{:?}",
			spawned.result
		);
		let Under { result, mask, launcher_ended } = spawned;
		let err = io::Error::from(result.expect_err("spawned"));
		assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{err}");
		assert!(err.to_string().contains("could not be ended"), "{err}");
		assert!(vfork::program_ran(&err), "{err}");
		assert_eq!(mask, THREAD_MASK, "the spawning thread's mask");
		assert!(launcher_ended, "the launcher did not reap the program and end");
		assert_no_child();
	}

	/// Failure mode: a spawn that joins a group fails after its program
	/// exec'd (its launcher's unblock and kill refused, with the `EPERM` of a
	/// refused `setpgid`), and is retried as the leader of a group of its
	/// own: the program runs twice. Through the production path
	/// (`vfork_exec`), a program that records each start.
	#[test]
	fn a_join_that_failed_after_the_exec_is_not_retried() {
		use std::{os::unix::process::CommandExt, process::Stdio};

		use bstr::BString;

		/// The group's leader, killed and reaped when dropped, a failed
		/// assertion's unwind included.
		struct Leader(std::process::Child);

		impl Drop for Leader {
			fn drop(&mut self) {
				let _ = self.0.kill();
				let _ = self.0.wait();
			}
		}

		if !alone("a_join_that_failed_after_the_exec_is_not_retried") {
			return;
		}
		let dir = tempfile::tempdir().unwrap();
		let runs = dir.path().join("runs");
		// A group in this session to join. Its stdio is not the test
		// process's pipes, which `alone` reads to their end: a leader left
		// running would hold them, and hide how the test failed.
		let mut leader = std::process::Command::new("/bin/sleep");
		leader.arg("30").process_group(0);
		leader
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null());
		let leader = Leader(leader.spawn().unwrap());
		let pgid = leader.0.id() as c_int;
		let script = format!("echo ran >> '{}'", runs.display());
		let argv = [BString::from("/bin/sh"), BString::from("-c"), BString::from(script)];
		let env = super::EnvView::default();
		let launched = under(
			true,
			|_| refuse_unblock(true),
			|| {
				let prog = super::super::Program {
					path:    b"/bin/sh",
					argv:    &argv,
					env:     &env,
					cwd:     b"/",
					umask:   0o022,
					ign:     super::SigSet::EMPTY,
					rlimits: &[],
					tty:     None,
					closed:  &[],
				};
				super::super::vfork_exec(&prog, &[], super::super::Place::Group(pgid))
					.map(|(pid, _)| pid)
			},
		);
		let started = runs_of(&runs);
		drop(leader);
		let err = launched.result.expect_err("spawned");
		assert!(vfork::program_ran(&err), "{err}");
		assert!(launched.launcher_ended, "the launcher did not reap the program and end");
		assert_eq!(started, "ran\n", "the program started again");
		assert_no_child();
	}

	/// Failure mode: a measured spawn (`time`) whose helper exec'd and could
	/// not be ended (its launcher's unblock and kill refused) runs the
	/// program again without the helper: the program runs twice.
	#[test]
	fn a_measured_spawn_whose_helper_started_does_not_run_the_program_again() {
		use bstr::BString;

		use super::ExtProc as _;

		if !alone("a_measured_spawn_whose_helper_started_does_not_run_the_program_again") {
			return;
		}
		let dir = tempfile::tempdir().unwrap();
		let runs = dir.path().join("runs");
		let script = format!("echo ran >> '{}'", runs.display());
		let argv = [BString::from("/bin/sh"), BString::from("-c"), BString::from(script)];
		let env = super::EnvView::default();
		let launched = under(
			true,
			|_| refuse_unblock(true),
			|| {
				let spawner = super::spawner(super::Sessions::Share, Duration::from_secs(2));
				spawner
					.spawn_measured(super::spec(&argv, &env, super::NEW))
					.map(|p| p.pid())
			},
		);
		let started = runs_of(&runs);
		let err = launched.result.expect_err("spawned");
		assert!(vfork::program_ran(&err), "{err}");
		assert!(launched.launcher_ended, "the launcher did not reap the helper and end");
		assert_eq!(started, "ran\n", "the program started again");
	}

	/// Failure mode: a launcher that cannot wait for the child it was to end
	/// (a filter refuses its waits) keeps waiting, never ends, and leaves the
	/// child a zombie. The process's reaper, started with the process's
	/// first launcher here, before the filter, can wait.
	#[test]
	fn a_launcher_whose_waits_are_refused_hands_its_child_to_the_reaper() {
		if !alone("a_launcher_whose_waits_are_refused_hands_its_child_to_the_reaper") {
			return;
		}
		vfork::prepare().unwrap();
		let spawned = spawn_under(&[], true, |_| {
			refuse_unblock(false)
				.refuse(libc::SYS_wait4, &[], REFUSED)
				.refuse(libc::SYS_waitid, &[], REFUSED)
		});
		assert!(
			matches!(spawned.stage(), Some(vfork::Stage::Ran { unended: Some(_) })),
			"{:?}",
			spawned.result
		);
		assert!(spawned.launcher_ended, "the launcher whose waits are refused never ends");
		assert!(childless_within_settle(), "the reaper did not collect the child");
	}

	/// The launcher [`record_reach`] watches for.
	static WATCHED: AtomicI32 = AtomicI32::new(0);

	/// The signals [`WATCHED`] took: bit `n - 1` for signal `n`.
	static REACHED: AtomicU64 = AtomicU64::new(0);

	/// A handler that records a signal [`WATCHED`] took.
	extern "C" fn record_reach(sig: c_int) {
		// SAFETY: plain syscall without arguments.
		let tid = unsafe { libc::syscall(libc::SYS_gettid) } as i32;
		if tid == WATCHED.load(Ordering::Relaxed) {
			REACHED.fetch_or(1 << (sig - 1), Ordering::Relaxed);
		}
	}

	/// The kernel's `struct sigaction` on x86-64 and 64-bit Arm: the
	/// handler, the flags, `sa_restorer` and the mask.
	#[derive(Clone, Copy, Default)]
	#[repr(C)]
	struct Action {
		handler:  usize,
		flags:    u64,
		restorer: usize,
		mask:     u64,
	}

	/// Set the action of `sig` to `new` through the system call, which takes
	/// glibc's own signals too (its `sigaction` refuses them), or only read
	/// it; the action it had.
	fn action(sig: c_int, new: Option<&Action>) -> Action {
		let mut old = Action::default();
		// SAFETY: actions of the kernel's layout, valid for the call, and the
		// kernel's set size.
		let rc = unsafe {
			libc::syscall(
				libc::SYS_rt_sigaction,
				sig,
				new.map_or(ptr::null(), ptr::from_ref),
				&raw mut old,
				size_of::<u64>(),
			)
		};
		assert_eq!(rc, 0, "signal {sig}: {}", io::Error::last_os_error());
		old
	}

	/// Failure mode: an idle launcher leaves an application signal
	/// unblocked (glibc keeps only 32 and 33, so 34 is `SIGRTMIN`): a host
	/// that blocks it on every thread to take it with `sigwait` gets it on
	/// the launcher instead, whose default action ends the process. Or it
	/// blocks its libc's own signals, which glibc's `setuid` waits for each
	/// thread to take. The kernel answers, where `/proc` has no `SigBlk`
	/// line too: every signal is sent to the launcher alone, under a handler
	/// that records the ones it takes.
	#[test]
	fn an_idle_launcher_blocks_every_signal_but_its_libcs() {
		if !alone("an_idle_launcher_blocks_every_signal_but_its_libcs") {
			return;
		}
		// A spawn first: between spawns the launcher has the mask that its
		// unblock after the clone left.
		assert_eq!(vfork::reap(spawn_sh(&[]).unwrap()), Ok(()));
		let launcher = std::fs::read_dir("/proc/self/task")
			.unwrap()
			.filter_map(Result::ok)
			.find(|task| {
				std::fs::read_to_string(task.path().join("comm"))
					.is_ok_and(|comm| comm.trim_end() == "omp-spawn")
			})
			.and_then(|task| task.file_name().to_str()?.parse::<c_int>().ok())
			.expect("a launcher");
		WATCHED.store(launcher, Ordering::Relaxed);
		// The flags and `sa_restorer` with which glibc's `sigaction` has a
		// handler return (x86-64), and every signal blocked while the handler
		// runs, so the launcher's small stack takes one frame at a time.
		let usr1 = action(libc::SIGUSR1, None);
		// SAFETY: a handler that only records; the old action comes back
		// below.
		unsafe { libc::signal(libc::SIGUSR1, record_reach as libc::sighandler_t) };
		let handler = Action { mask: !0, ..action(libc::SIGUSR1, None) };
		let mut kept = Vec::new();
		for n in 1..=64 {
			if n != libc::SIGKILL && n != libc::SIGSTOP {
				kept.push((n, action(n, Some(&handler))));
			}
		}
		let pid = std::process::id() as c_int;
		for &(n, _) in &kept {
			// SAFETY: a signal to this process's launcher alone, which takes
			// it with the handler or keeps it pending.
			let rc = unsafe { libc::syscall(libc::SYS_tgkill, pid, launcher, n) };
			assert_eq!(rc, 0, "signal {n}: {}", io::Error::last_os_error());
		}
		// Another spawn: the launcher wakes for it, and takes each signal it
		// does not block before it serves the spawn.
		assert_eq!(vfork::reap(spawn_sh(&[]).unwrap()), Ok(()));
		let reached = REACHED.load(Ordering::Relaxed);
		for (n, old) in &kept {
			action(*n, Some(old));
		}
		action(libc::SIGUSR1, Some(&usr1));
		let libcs = (32..libc::SIGRTMIN()).fold(0u64, |set, n| set | (1 << (n - 1)));
		assert_eq!(reached & (1 << (libc::SIGRTMIN() - 1)), 0, "SIGRTMIN reaches the launcher");
		assert_eq!(reached, libcs, "the signals the idle launcher took: {reached:#x}");
	}

	/// Failure mode: a launcher whose block of the host's signals is refused
	/// starts anyway, and the host's signals reach it between spawns.
	#[test]
	fn a_launcher_that_cannot_block_the_hosts_signals_does_not_start() {
		if !alone("a_launcher_that_cannot_block_the_hosts_signals_does_not_start") {
			return;
		}
		let idle = ptr::from_ref::<u64>(&vfork::IDLE_SIGNALS) as u64;
		let started = under(
			true,
			|_| {
				let setmask = [Cond::Is(0, libc::SIG_SETMASK as u32), Cond::In(1, idle..idle + 8)];
				Filter::default().refuse(libc::SYS_rt_sigprocmask, &setmask, REFUSED)
			},
			vfork::prepare,
		);
		assert_eq!(
			started
				.result
				.as_ref()
				.err()
				.and_then(io::Error::raw_os_error),
			Some(REFUSED),
			"{:?}",
			started.result
		);
		assert!(started.launcher_ended, "the launcher that could not start runs on");
	}

	/// Failure mode: the program starts without a limit its child could not
	/// set, or the child sets it through musl's `setrlimit`, which answers
	/// `prlimit64`'s `ENOSYS` with `__synccall`: the threads' lock, taken in
	/// a child that shares the host's memory.
	#[test]
	fn a_refused_limit_fails_the_spawn() {
		if !alone("a_refused_limit_fails_the_spawn") {
			return;
		}
		let no_core = [(libc::RLIMIT_CORE, libc::rlimit { rlim_cur: 0, rlim_max: 0 })];
		let filter = Filter::default().refuse(libc::SYS_prlimit64, &[], libc::ENOSYS);
		let spawned = spawn_under(&no_core, false, |_| filter);
		assert_eq!(spawned.errno(), Some(libc::ENOSYS), "{:?}", spawned.result);
		assert_eq!(spawned.stage(), Some(vfork::Stage::Child(vfork::Step::Limits)));
		assert_eq!(spawned.mask, THREAD_MASK, "the spawning thread's mask");
		assert_no_child();
	}

	/// Signals [`interrupted`] took.
	static INTERRUPTIONS: AtomicUsize = AtomicUsize::new(0);

	/// A handler that counts its signals.
	extern "C" fn interrupted(_: c_int) {
		INTERRUPTIONS.fetch_add(1, Ordering::Relaxed);
	}

	/// Failure mode: a reap that a signal interrupts gives the child up
	/// unreaped (a zombie per failed spawn), a reap whose wait fails
	/// otherwise counts the child as reaped and drops it, or the reap of a
	/// child another waiter took fails.
	#[test]
	fn a_reap_waits_through_signals_and_keeps_a_child_its_refused_wait_left() {
		if !alone("a_reap_waits_through_signals_and_keeps_a_child_its_refused_wait_left") {
			return;
		}
		// Without `SA_RESTART`: the signal interrupts the wait.
		// SAFETY: sigaction is plain data, valid zeroed; the handler only
		// counts.
		unsafe {
			let mut action = std::mem::zeroed::<libc::sigaction>();
			action.sa_sigaction = interrupted as usize;
			libc::sigemptyset(&raw mut action.sa_mask);
			assert_eq!(libc::sigaction(libc::SIGUSR1, &raw const action, ptr::null_mut()), 0);
		}
		let mut sleeper = std::process::Command::new("/bin/sleep");
		let sleeper = sleeper.arg("0.5").spawn().unwrap();
		let pid = sleeper.id() as c_int;
		// SAFETY: no arguments.
		let waiting = unsafe { libc::pthread_self() };
		let done = AtomicBool::new(false);
		let reaped = thread::scope(|scope| {
			scope.spawn(|| {
				while !done.load(Ordering::Acquire) {
					// SAFETY: a signal to a thread that outlives this scope.
					unsafe { libc::pthread_kill(waiting, libc::SIGUSR1) };
					thread::sleep(Duration::from_millis(20));
				}
			});
			let reaped = vfork::reap(pid);
			done.store(true, Ordering::Release);
			reaped
		});
		assert_eq!(reaped, Ok(()));
		assert!(INTERRUPTIONS.load(Ordering::Relaxed) > 0, "no signal interrupted the wait");
		assert_no_child();
		assert_eq!(vfork::reap(pid), Ok(()), "the reap of a child another waiter took");
		drop(sleeper);
		let ran = std::process::Command::new("/bin/true").spawn().unwrap();
		let pid = ran.id() as c_int;
		let refused = thread::scope(|scope| {
			scope
				.spawn(|| {
					let filter = Filter::default().refuse(libc::SYS_wait4, &[], REFUSED);
					filter.install().expect("the filter installs");
					vfork::reap(pid)
				})
				.join()
				.unwrap()
		});
		assert_eq!(refused, Err(REFUSED));
		assert!(exits_unreaped(pid), "the refused reap gave the child up");
		assert_eq!(vfork::reap(pid), Ok(()));
		assert_no_child();
		drop(ran);
	}
}

#[test]
fn umask_probe_preserves_concurrent_file_creation_mask() {
	use std::{
		os::unix::fs::{OpenOptionsExt, PermissionsExt},
		sync::atomic::{AtomicBool, Ordering},
	};

	const MARKER: &str = "PI_SHELL_UMASK_PROBE_CHILD";
	if std::env::var_os(MARKER).is_none() {
		let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
		cmd.args([
			"--exact",
			"sys::spawn::unix::tests::umask_probe_preserves_concurrent_file_creation_mask",
		])
		.env(MARKER, "1");
		// SAFETY: this runs after fork, before exec, and changes only the
		// isolated test subprocess's mask.
		unsafe {
			cmd.pre_exec(|| {
				libc::umask(0o077);
				Ok(())
			});
		}
		let output = cmd.output().unwrap();
		assert!(
			output.status.success(),
			"isolated probe test failed: {}{}",
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);
		assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"), "child ran no test");
		return;
	}

	assert_eq!(process_umask(), Some(0o077));
	let dir = tempfile::tempdir().unwrap();
	let done = Arc::new(AtomicBool::new(false));
	let probing = Arc::clone(&done);
	let start = Arc::new(std::sync::Barrier::new(2));
	let probe_start = Arc::clone(&start);
	let probe = thread::spawn(move || {
		probe_start.wait();
		while !probing.load(Ordering::Relaxed) {
			assert_eq!(process_umask(), Some(0o077));
		}
	});
	start.wait();
	let mut wrong_modes = Vec::new();
	for n in 0..2000 {
		let path = dir.path().join(n.to_string());
		let file = std::fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.mode(0o666)
			.open(path)
			.unwrap();
		let mode = file.metadata().unwrap().permissions().mode() & 0o777;
		if mode != 0o600 {
			wrong_modes.push(mode);
		}
	}
	done.store(true, Ordering::Relaxed);
	probe.join().unwrap();
	assert_eq!(process_umask(), Some(0o077), "the process mask changed");
	let after = std::fs::OpenOptions::new()
		.write(true)
		.create_new(true)
		.mode(0o666)
		.open(dir.path().join("after"))
		.unwrap();
	assert_eq!(after.metadata().unwrap().permissions().mode() & 0o777, 0o600);
	assert!(wrong_modes.is_empty(), "concurrent files had wrong modes: {wrong_modes:?}");

	// This subprocess runs only this test. Change its own mask after the
	// reader thread joined, then restore it before checking the result.
	// SAFETY: umask cannot fail; neither call affects the parent process.
	let previous = unsafe { libc::umask(0o027) };
	let changed = process_umask();
	// SAFETY: restore the mask returned above in this isolated subprocess.
	unsafe { libc::umask(previous) };
	assert_eq!(changed, Some(0o027), "the probe returned a cached mask");
}

#[test]
fn umask_reaches_the_child_on_both_paths() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	#[cfg(target_os = "macos")]
	let state = super::State::new(None);
	let host = process_umask().unwrap();
	let a = sh("umask");
	for mask in [host, 0o027] {
		#[cfg(target_os = "macos")]
		assert_eq!(state.posix_eligible(mask, SigSet::EMPTY), mask == host);
		let out = MemFile::default();
		let mut sp = spec(&a, &env, NEW);
		sp.umask = mask;
		sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
		let mut p = s.spawn(sp).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(0));
		assert_eq!(out.captured().trim(), format!("{mask:04o}").as_bytes());
	}
}

#[test]
fn rlimits_reach_the_child_and_unknown_resources_are_skipped() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let (_, hard) = crate::sys::rlimit::get(Rlimit::Nofile).unwrap();
	// FreeBSD-only `Swap` exists nowhere here: skipped, not an error.
	let limits = [(Rlimit::Swap, Some(1), Some(1)), (Rlimit::Nofile, Some(64), hard)];
	let a = sh("ulimit -n");
	let out = MemFile::default();
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	sp.rlimits = &limits;
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured().trim(), b"64");
	assert_eq!(
		crate::sys::rlimit::get(Rlimit::Nofile).unwrap().1,
		hard,
		"the host's limits are untouched"
	);
}

#[test]
fn an_impossible_rlimit_fails_the_spawn_with_the_os_error() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let (soft, _) = crate::sys::rlimit::get(Rlimit::Nofile).unwrap();
	let soft = soft.unwrap();
	// Soft above hard: EINVAL from setrlimit in the child.
	let limits = [(Rlimit::Nofile, Some(soft), Some(soft - 1))];
	let a = argv(&["/usr/bin/true"]);
	let mut sp = spec(&a, &env, NEW);
	sp.rlimits = &limits;
	let err = s.spawn(sp).err().expect("setrlimit refuses soft > hard");
	assert_eq!(err.raw_os_error(), Some(libc::EINVAL), "{err}");
}

/// A reused descriptor map must not reuse another command's working directory.
#[test]
fn consecutive_spawns_apply_their_current_cwd() {
	let s = NativeSpawner::default();
	let env = EnvView::default();
	for cwd in ["/", "/usr", "/"] {
		let a = sh(&format!("test . -ef {cwd}"));
		let mut sp = spec(&a, &env, NEW);
		sp.cwd = cwd.as_bytes().as_bstr();
		let mut p = s.spawn(sp).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(0), "{cwd}");
	}
}

/// Cached C environments must track changes, deletion, and recovery after
/// rejecting an invalid command environment.
#[test]
fn consecutive_spawns_receive_their_current_environment() {
	let s = NativeSpawner::default();
	for (value, script) in [
		(Some("first"), r#"test "$SPAWN_CACHE" = first"#),
		(Some("second"), r#"test "$SPAWN_CACHE" = second"#),
		(None, r#"test "${SPAWN_CACHE+x}" != x"#),
	] {
		let pairs = value
			.into_iter()
			.map(|v| ("SPAWN_CACHE".into(), v.into()))
			.collect();
		let env = EnvView::new(pairs);
		let a = sh(script);
		for _ in 0..2 {
			let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
			assert_eq!(wait(&mut p), ExitStatus::Exited(0));
		}
	}
	let a = sh(r#"test "$SPAWN_CACHE" = recovered"#);
	let invalid = EnvView::new(vec![("SPAWN_CACHE".into(), BString::from(b"bad\0value"))]);
	assert_eq!(s.spawn(spec(&a, &invalid, NEW)).err().unwrap().kind(), io::ErrorKind::InvalidInput);
	let env = EnvView::new(vec![("SPAWN_CACHE".into(), "recovered".into())]);
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
}

#[test]
fn cwd_env_and_argv0_reach_the_child() {
	let s = NativeSpawner::default();
	let env = EnvView::new(vec![(BString::from("FOO"), BString::from("b a r"))]);
	let a = argv(&["/bin/sh", "-c", "cd -P . && pwd; printf '%s|%s\\n' \"$FOO\" \"$0\"", "name0"]);
	let out = MemFile::default();
	let mut sp = spec(&a, &env, NEW);
	sp.cwd = b"/usr".as_bstr();
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), b"/usr\nb a r|name0\n");
}

#[cfg(target_os = "macos")]
#[test]
fn missing_spawn_chdir_uses_fork_with_the_requested_cwd() {
	let mut s = NativeSpawner::default();
	Arc::get_mut(&mut s.shared).unwrap().state.add_chdir = None;
	let env = EnvView::default();
	let a = argv(&["/bin/pwd"]);
	let out = MemFile::default();
	let mut sp = spec(&a, &env, NEW);
	sp.cwd = b"/usr".as_bstr();
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), b"/usr\n");
}

#[test]
fn extra_fds_are_passed_to_the_child() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let pumped = MemFile::default();
	let path = std::env::temp_dir().join(format!("obash-extra-{}", std::process::id()));
	let direct = std::fs::File::create(&path).unwrap();
	let a = sh("echo pumped >&5; echo direct >&7; read x <&5; echo \"got $x\" >&7");
	let mut sp = spec(&a, &env, NEW);
	let duplex = MemFile { input: MemFile::feed(b"back\n").input, ..pumped.clone() };
	sp.extra_fds = vec![
		(5, StdioSpec::File(Box::new(duplex))),
		(7, StdioSpec::File(Box::new(crate::sys::StdFile::new(direct)))),
	];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(pumped.captured(), b"pumped\n", "fd 5 pumped both ways over a socket pair");
	assert_eq!(std::fs::read(&path).unwrap(), b"direct\ngot back\n", "fd 7 passed through");
	std::fs::remove_file(&path).unwrap();
}

/// Failure mode: a stream the spec closes (`>&-`) is still open in the
/// program, which then writes into the null device instead of failing.
#[test]
fn a_closed_stream_is_closed_in_the_child() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let err = MemFile::default();
	let a = sh("if [ -e /dev/fd/1 ]; then echo open >&2; else echo closed >&2; fi");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, StdioSpec::Closed, err.boxed()];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(err.captured(), b"closed\n");
}

/// bash hands one kernel pipe to every process that inherits a procsub fd.
/// `cat < <(…)` holds it as fd 0 and fd 63; in `diff <(a) <(b)`, `b` holds
/// `a`'s fd 63 without reading it. A pump per handoff would race for the
/// bytes and lose what it took into a pipe nobody reads (varenv8, shopt1).
#[test]
fn one_engine_reader_feeds_every_external_it_is_handed_to() {
	let env = EnvView::default();
	let spawner = NativeSpawner::default();
	let data = b"line1\nline2\n";

	// Same object on fd 0 and fd 63 of one external.
	let sub = crate::bash::FdRef::from_file(Box::new(MemFile::reader(data)));
	let out = MemFile::default();
	let cat = argv(&["/bin/cat"]);
	let mut both = spec(&cat, &env, NEW);
	both.stdio = [StdioSpec::Pipe(sub.clone()), out.boxed(), StdioSpec::Null];
	both.extra_fds = vec![(63, StdioSpec::Pipe(sub))];
	let mut child = spawner.spawn(both).unwrap();
	assert_eq!(wait(&mut child), ExitStatus::Exited(0));
	assert_eq!(out.captured(), data, "fd 63 took nothing from stdin");

	// A bystander inherits the object first and never reads it; the reader
	// spawned after it still gets everything.
	let sub = crate::bash::FdRef::from_file(Box::new(MemFile::reader(data)));
	let sleep = argv(&["/bin/sleep", "30"]);
	let mut idle = spec(&sleep, &env, NEW);
	idle.extra_fds = vec![(63, StdioSpec::Pipe(sub.clone()))];
	let mut bystander = spawner.spawn(idle).unwrap();
	thread::sleep(Duration::from_millis(50));
	let out = MemFile::default();
	let by_path = sh("cat /dev/fd/63");
	let mut reader = spec(&by_path, &env, NEW);
	reader.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	reader.extra_fds = vec![(63, StdioSpec::Pipe(sub))];
	let mut child = spawner.spawn(reader).unwrap();
	assert_eq!(wait(&mut child), ExitStatus::Exited(0));
	assert_eq!(out.captured(), data, "the bystander's copy stole nothing");
	bystander.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut bystander), ExitStatus::Signaled(Signal::Kill));
}

/// `cat <(echo hi)` / `tee >(cat)`: the external opens the substitution by
/// path. Linux reopens `/dev/fd/N` through `/proc`, which works for a pipe
/// but fails with ENXIO for a socket, so one-way extra fds must be pipes.
#[test]
fn one_way_extra_fds_can_be_opened_by_path() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let (sub_out, out) = (MemFile::writer(), MemFile::default());
	let a = sh("cat /dev/fd/63; echo to-sub > /dev/fd/62");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	sp.extra_fds = vec![
		(63, StdioSpec::File(Box::new(MemFile::reader(b"hi\n")))),
		(62, StdioSpec::File(Box::new(sub_out.clone()))),
	];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), b"hi\n", "read end reopened by path");
	assert_eq!(sub_out.captured(), b"to-sub\n", "write end reopened by path");
}

#[test]
fn leftovers_lists_and_kills_processes_that_outlive_their_command() {
	let env = EnvView::default();
	for sessions in [Sessions::Detach, Sessions::Share] {
		let s = spawner(sessions, Duration::from_secs(2));
		// The background sleep outlives sh in sh's group and session.
		let a = sh("/bin/sleep 30 & exit 0");
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(0));
		drop(p);
		// The background child shows the shell's name until it has exec'd.
		let mut left = Vec::new();
		until("background sleep exec'd", || {
			left = s.leftovers().unwrap();
			left.len() == 1 && left[0].name == "sleep"
		});
		let killed = s.kill_leftovers().unwrap();
		assert_eq!(killed, left);
		until("leftover gone", || s.leftovers().unwrap().is_empty());
	}
}

/// A spawner whose externals a [`Parker`](crate::sys::Parker) waits for.
#[cfg(target_os = "linux")]
fn parked_spawner(grace: Duration) -> NativeSpawner {
	NativeSpawner::new(SpawnConfig {
		grace,
		sessions: Sessions::Inherit,
		exits: crate::sys::Exits::Park,
		umask: None,
	})
}

/// Drive `p` as `obash` does: poll with the parker's waker, park in between.
#[cfg(target_os = "linux")]
fn wait_parked(parker: &mut crate::sys::Parker, p: &mut Box<dyn ExtProc>) -> ExitStatus {
	let waker = parker.waker().clone();
	let mut cx = Context::from_waker(&waker);
	let deadline = Instant::now() + LONG;
	loop {
		if let Poll::Ready(s) = p.poll_wait(&mut cx) {
			return s;
		}
		assert!(Instant::now() < deadline, "process did not finish");
		parker.park(LONG);
	}
}

/// The exit itself ends the park (a pidfd in the poll set), long before the
/// park's timeout; no waiter thread is involved; the status is exact and
/// the process is reaped once its `ExtProc` is dropped.
#[cfg(target_os = "linux")]
#[test]
fn a_parked_external_wakes_the_parker_at_its_exit() {
	let env = EnvView::default();
	let s = parked_spawner(Duration::from_secs(2));
	let mut parker = crate::sys::Parker::new();
	for (script, status) in [
		("sleep 0.2; exit 5", ExitStatus::Exited(5)),
		("kill -KILL $$", ExitStatus::Signaled(Signal::Kill)),
	] {
		let a = sh(script);
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		let pid = p.pid() as i32;
		let start = Instant::now();
		assert_eq!(wait_parked(&mut parker, &mut p), status, "{script}");
		assert!(start.elapsed() < LONG / 2, "woken by the exit, not the timeout");
		assert!(proc::info(pid).is_some(), "unreaped while the ExtProc lives");
		drop(p);
		assert!(proc::info(pid).is_none(), "reaped on drop");
	}
}

/// Parked externals deliver their output before they complete, and many at
/// once each get their own exit.
#[cfg(target_os = "linux")]
#[test]
fn parked_externals_deliver_output_and_their_own_exits() {
	let env = EnvView::default();
	let s = parked_spawner(Duration::from_secs(2));
	let mut parker = crate::sys::Parker::new();
	let outs: Vec<MemFile> = (0..6).map(|_| MemFile::default()).collect();
	let scripts: Vec<Vec<BString>> = (0..6)
		.map(|i| sh(&format!("sleep 0.{i}; printf out{i}; exit {i}")))
		.collect();
	let mut running: Vec<_> = scripts
		.iter()
		.zip(&outs)
		.map(|(a, out)| {
			let mut sp = spec(a, &env, NEW);
			sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
			s.spawn(sp).unwrap()
		})
		.collect();
	for (i, p) in running.iter_mut().enumerate().rev() {
		assert_eq!(wait_parked(&mut parker, p), ExitStatus::Exited(i32::try_from(i).unwrap()));
		assert_eq!(outs[i].captured(), format!("out{i}").as_bytes());
	}
	drop(running);
	assert!(s.leftovers().unwrap().is_empty());
}

/// Abandoned while running, a parked external is escalated and then reaped
/// by a waiter; without any parker its exit is still observed.
#[cfg(target_os = "linux")]
#[test]
fn parked_externals_are_reaped_after_abandon_and_work_without_a_parker() {
	let env = EnvView::default();
	let s = parked_spawner(Duration::from_millis(300));
	let parker = crate::sys::Parker::new();
	let a = sh("trap '' TERM; exec /bin/sleep 30");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid() as i32;
	let waker = parker.waker().clone();
	assert!(p.poll_wait(&mut Context::from_waker(&waker)).is_pending());
	until("exec'd", || proc::info(pid).is_some_and(|i| i.name == "sleep"));
	drop(p);
	until("killed and reaped", || proc::info(pid).is_none());
	drop(parker);

	let a = sh("exit 7");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(7));
}
