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

use super::{Scope, State, process_umask};
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
	// pi-shell lesson (shell.rs ~6105): a later stage must not setpgid-join a
	// leader that moved sessions; detached stages lead their own.
	let mut stage = s.spawn(spec(&a, &env, PgroupSpec::Join(lead_pid))).unwrap();
	let pid = stage.pid();
	assert_eq!((pgid(pid), sid(pid)), (pid as i32, pid as i32));
	for p in [&mut lead, &mut stage] {
		p.signal(Signal::Kill).unwrap();
		assert_eq!(wait(p), ExitStatus::Signaled(Signal::Kill));
	}
}

/// pi-shell lesson (shell.rs ~6105/~7827): joining a group whose leader is
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

#[test]
fn ignored_signals_reach_the_child_through_the_fork_path() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("kill -USR1 $$; exit 7");
	assert!(!super::host_ignores(Signal::Usr1));
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
	let state = State::new(None);
	let host = process_umask().unwrap();
	let a = sh("umask");
	for mask in [host, 0o027] {
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

#[cfg(all(target_os = "linux", target_env = "gnu"))]
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
