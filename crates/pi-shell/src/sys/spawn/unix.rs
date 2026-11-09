//! Unix spawning.
//!
//! **Paths.** `posix_spawn` (macOS; Linux with glibc ≥ 2.29) whenever it can
//! express the spec: placement via `POSIX_SPAWN_SETSID`/`SETPGROUP`, stdio
//! and extra fds via `adddup2`, cwd via `addchdir_np`, every signal not to be
//! ignored reset to its default (`SETSIGDEF`, which restores `SIGPIPE` that
//! Rust hosts ignore), an empty signal mask, and on macOS
//! `POSIX_SPAWN_CLOEXEC_DEFAULT` so no stray host fd leaks into the child.
//! It cannot set a umask or *ignore* a signal, so a spec whose umask differs
//! from the process's, or that ignores a signal the host does not ignore,
//! takes the fork path: std's `Command` with an async-signal-safe `pre_exec`
//! hook (umask, extra fds, dispositions, `setsid`). A spec with
//! redirections for the process to apply ([`SpawnSpec::redirs`]) takes a
//! bare `fork`: std's `Command` and `posix_spawn` both wait for the exec,
//! and an open in the child may wait for a FIFO's other end, which only the
//! child may do (`fork_redirs`).
//!
//! **Placement** follows [`Sessions`]: `Detach` makes every external a
//! session leader; `Share` uses the `setpgid` leader idiom (`New` leads a
//! group, `Join` joins one) but never joins a group whose leader is in
//! another session, and falls back to leading its own group when the join
//! fails with `EPERM` (the group emptied in between); `Inherit` leaves the
//! child in the host's group and session, and every group-wide operation
//! then targets the child's pid alone (a [`Scope`]). A job-controlled spawn
//! (`PgroupSpec::Job`, under `Share` or `Inherit`) is placed like a `Share`
//! one; a foreground job's child also takes the shell's terminal before it
//! execs (the fork path: `posix_spawn` cannot), and the parent places it
//! and hands over the terminal again after the spawn, so neither side
//! races the other.
//!
//! **Waiting** reports stops and continues besides the exit
//! ([`ExtProc::poll_event`]).

use std::{
	cell::RefCell,
	ffi::{CString, OsStr, c_char},
	fs, io,
	io::Read as _,
	os::{
		fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd},
		unix::{ffi::OsStrExt, fs::OpenOptionsExt as _, process::CommandExt},
	},
	path::Path,
	process::{Command, Stdio},
	sync::{
		Arc, LazyLock,
		atomic::{AtomicU64, Ordering},
	},
	task::{Context, Poll},
	thread,
	time::{Duration, Instant},
};

use bstr::BString;
use parking_lot::{Condvar, Mutex, MutexGuard};
use pi_builtins::read_process_umask as process_umask;

use super::{Dir, Leftover, Sessions, Shared, child_end};
use crate::{
	bash::{
		ChildRedir, ChildRedirs, EnvView, ExitStatus, ExtProc, OpenFlags, OsHandle, PgroupSpec,
		Platform, ProcEvent, Rlimit, SigSet, Signal, SpawnSpec, StdioSpec,
	},
	sys::{
		lifecycle::{Abandon, Tracker},
		proc::{self, ProcInfo, ProcState},
		pump::{Feed, Pump, Pumps},
		rlimit,
	},
};

/// Include Linux realtime signal 64; macOS has only signals 1 through 31.
#[cfg(target_os = "linux")]
const NSIG: usize = 65;
#[cfg(not(target_os = "linux"))]
const NSIG: usize = 32;

/// Waiter and escalation threads only wait and signal.
const SMALL_STACK: usize = 64 << 10;

/// Registry sweep interval (amortized O(1) per spawn).
const SWEEP: usize = 64;

/// Waiter threads kept parked between externals (process-wide).
const IDLE_MAX: usize = 8;

/// How long a parked waiter waits for its next external before it exits.
const IDLE_FOR: Duration = Duration::from_secs(10);

/// One external to wait for: its pid and its lifecycle.
type Wait = (i32, Arc<Tracker>, Arc<Shared>);

/// A parked waiter thread's slot for its next external.
struct Mailbox {
	job:   Mutex<Option<Wait>>,
	ready: Condvar,
}

/// Parked waiter threads, shared by every spawner of the process: reusing
/// one saves a thread creation and teardown (stack, guard page, signal
/// stack) per external, about a tenth of a spawn's cost on Linux.
static IDLE: Mutex<Vec<Arc<Mailbox>>> = Mutex::new(Vec::new());

/// Wait for the exit of `pid` on a parked waiter, or a new one: it records
/// the status in `tracker` and reaps the process when nobody holds its
/// `ExtProc` any more.
fn watch(pid: i32, tracker: Arc<Tracker>, shared: Arc<Shared>) -> io::Result<()> {
	let parked = IDLE.lock().pop();
	if let Some(mb) = parked {
		*mb.job.lock() = Some((pid, tracker, shared));
		mb.ready.notify_one();
		return Ok(());
	}
	let mb =
		Arc::new(Mailbox { job: Mutex::new(Some((pid, tracker, shared))), ready: Condvar::new() });
	thread::Builder::new()
		.name("obash-wait".into())
		.stack_size(SMALL_STACK)
		.spawn(move || waiter(&mb))
		.map(drop)
}

/// A waiter thread: wait for each external handed to `mb`, park in
/// [`IDLE`] in between; exit when the pool is full or after [`IDLE_FOR`]
/// without work.
fn waiter(mb: &Arc<Mailbox>) {
	while let Some((pid, tracker, shared)) = next_wait(mb) {
		let status = wait_exit(pid, &tracker);
		if tracker.exited(status) {
			shared.state.reap(pid);
		}
		drop(tracker);
		let mut idle = IDLE.lock();
		if idle.len() >= IDLE_MAX {
			return;
		}
		idle.push(Arc::clone(mb));
	}
}

/// The next external for the waiter of `mb`; `None` once it left the pool
/// after [`IDLE_FOR`] without one.
fn next_wait(mb: &Arc<Mailbox>) -> Option<Wait> {
	let mut job = mb.job.lock();
	loop {
		if let Some(next) = job.take() {
			return Some(next);
		}
		if !mb.ready.wait_for(&mut job, IDLE_FOR).timed_out() || job.is_some() {
			continue;
		}
		// Leave the pool, unless a spawner took this waiter from it already
		// (its external is on the way). `watch` locks the pool before a
		// mailbox, so the pool is not locked while holding `job`.
		let left = MutexGuard::unlocked(&mut job, || {
			let mut idle = IDLE.lock();
			let before = idle.len();
			idle.retain(|m| !Arc::ptr_eq(m, mb));
			idle.len() < before
		});
		if left && job.is_none() {
			return None;
		}
	}
}

/// Platform state of a spawner.
pub(super) struct State {
	/// The process umask when the spawner was created: `posix_spawn` cannot
	/// set one, so specs asking for another take the fork path.
	umask:     Option<u32>,
	groups:    Mutex<Groups>,
	/// Optional libc extension: without it `posix_spawn` cannot set the cwd
	/// (glibc < 2.29), so such libcs take the fork path. The gate also keeps
	/// `POSIX_SPAWN_SETSID` (glibc 2.26+) off libcs older than that, where
	/// `Place::Session` spawns would be refused with `EINVAL`. Never relax it
	/// into "the cwd is already right, skip `addchdir`": glibc 2.17–2.25 would
	/// then reach `posix_spawn` and fail every `Place::Session` spawn.
	#[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
	add_chdir: Option<posix::AddChdir>,
}

/// Scopes the spawner created, for leak checks.
struct Groups {
	list:       Vec<Scope>,
	next_sweep: usize,
}

/// What group-wide operations of one external reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
	/// The process group it leads or joined.
	Group(i32),
	/// The session it leads (and the group of the same id).
	Session(i32),
	/// Only the unreaped process itself (`Sessions::Inherit`: the group
	/// is the host's). Retired under the registry lock before reaping.
	Process { pid: i32 },
}

impl Scope {
	/// The scope of an external `pid` spawned at `place`.
	const fn of(place: Place, pid: i32) -> Self {
		match place {
			Place::Session => Self::Session(pid),
			Place::Group(0) => Self::Group(pid),
			Place::Group(pgid) => Self::Group(pgid),
			Place::Inherit => Self::Process { pid },
		}
	}

	/// The id reported in a [`Leftover`].
	const fn id(self) -> i32 {
		match self {
			Self::Group(id) | Self::Session(id) | Self::Process { pid: id, .. } => id,
		}
	}

	const fn contains(self, p: &ProcInfo) -> bool {
		match self {
			Self::Group(pgid) => p.pgid == pgid,
			Self::Session(sid) => p.sid == sid,
			Self::Process { pid } => p.pid == pid,
		}
	}

	/// Whether anything is left in the scope.
	fn alive(self) -> bool {
		match self {
			Self::Group(id) | Self::Session(id) => group_alive(id),
			// Registered only while unreaped; zombies are filtered by the
			// caller, and reaping retires the entry under this same lock.
			Self::Process { .. } => true,
		}
	}

	/// Send `sig` to the scope. Only valid while the external is unreaped
	/// (its pid and group cannot be recycled then).
	///
	/// A session's group exists only once its leader ran `setsid`, which
	/// the child does itself after the fork; until then the leader is the
	/// only member, so the signal goes to its pid (else it is lost: a
	/// `kill $!` right after the spawn left the program running).
	fn signal(self, sig: Signal) -> io::Result<()> {
		let n = i32::from(sig.number(Platform::current()));
		let rc = match self {
			// SAFETY: plain syscall without pointer arguments.
			Self::Group(id) => unsafe { libc::killpg(id, n) },
			// SAFETY: as above.
			Self::Session(id) => match unsafe { libc::killpg(id, n) } {
				// SAFETY: as above.
				-1 if errno() == libc::ESRCH => unsafe { libc::kill(id, n) },
				rc => rc,
			},
			// SAFETY: as above.
			Self::Process { pid, .. } => unsafe { libc::kill(pid, n) },
		};
		if rc == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}

	/// KILL whatever is left in the scope after the external exited
	/// (identity-pinned; a `Process` scope has nothing beyond the pid).
	fn sweep(self) {
		let _ = match self {
			Self::Group(id) => proc::kill_group(id, Signal::Kill),
			Self::Session(id) => proc::kill_session(id, Signal::Kill),
			Self::Process { .. } => return,
		};
	}
}

impl State {
	/// State for a spawner; `umask` is the process umask when the host knows
	/// it (read here otherwise).
	pub(super) fn new(umask: Option<u32>) -> Self {
		Self {
			umask: umask.or_else(process_umask),
			groups: Mutex::new(Groups { list: Vec::new(), next_sweep: SWEEP }),
			#[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
			add_chdir: posix::add_chdir(),
		}
	}

	/// The process umask when the spawner was created.
	pub(super) const fn umask(&self) -> Option<u32> {
		self.umask
	}

	fn record(&self, s: Scope) {
		let mut gs = self.groups.lock();
		if !gs.list.contains(&s) {
			gs.list.push(s);
		}
		if gs.list.len() >= gs.next_sweep {
			gs.list.retain(|s| s.alive());
			gs.next_sweep = gs.list.len() + SWEEP;
		}
	}

	/// Whether `posix_spawn` can express a spec with this umask and these
	/// ignored signals (it can neither set a umask nor ignore a signal; the
	/// child inherits both from the host).
	#[cfg_attr(
		not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))),
		allow(dead_code, reason = "no posix_spawn path on this target")
	)]
	fn posix_eligible(&self, umask: u32, ign: SigSet) -> bool {
		self.umask == Some(umask) && ign.iter().all(host_ignores)
	}

	/// Retire a process-only scope before its pid can be reused. Readers
	/// hold this lock while collecting the process table too.
	fn reap(&self, pid: i32) {
		let mut gs = self.groups.lock();
		gs.list.retain(|s| *s != Scope::Process { pid });
		reap(pid);
	}
}

/// Whether process group `pgid` has a member (`EPERM`: exists, not ours).
fn group_alive(pgid: i32) -> bool {
	// SAFETY: plain syscall; signal 0 only checks existence and permission.
	let alive = unsafe { libc::kill(-pgid, 0) } == 0;
	alive || io::Error::last_os_error().kind() == io::ErrorKind::PermissionDenied
}

pub(super) fn dup(h: OsHandle) -> io::Result<fs::File> {
	let fd = RawFd::try_from(h.0).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
	// SAFETY: the engine keeps the fd object that owns this descriptor alive
	// for the whole spawn call.
	let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
	Ok(fs::File::from(borrowed.try_clone_to_owned()?))
}

fn invalid(e: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, e)
}

/// One of the child's fds until the spawn: a descriptor the spawner owns
/// (closed after the spawn, so pumps see the child's end of file) or the
/// engine's own handle of an inherited stream, installed as it is (the
/// engine keeps it open for the spawn call; a copy cost a `dup` and a
/// `close` per stream and spawn).
enum Source {
	Owned(OwnedFd),
	Host(RawFd),
}

impl AsFd for Source {
	fn as_fd(&self) -> BorrowedFd<'_> {
		match self {
			Self::Owned(fd) => fd.as_fd(),
			// SAFETY: the engine keeps the fd object that owns this
			// descriptor alive for the whole spawn call.
			Self::Host(fd) => unsafe { BorrowedFd::borrow_raw(*fd) },
		}
	}
}

impl AsRawFd for Source {
	fn as_raw_fd(&self) -> RawFd {
		self.as_fd().as_raw_fd()
	}
}

/// The child's fd for one stream (`/dev/null` for `Null`).
fn child_fd(
	shared: &Shared,
	spec: crate::bash::StdioSpec,
	dir: Dir,
	pumps: &mut Vec<Pump>,
	held: &mut Vec<Arc<Feed>>,
) -> io::Result<Source> {
	if let crate::bash::StdioSpec::Inherit(h) = spec {
		return RawFd::try_from(h.0).map(Source::Host).map_err(invalid);
	}
	match child_end(shared, spec, dir, pumps, held)? {
		Some(f) => Ok(Source::Owned(f.into())),
		None => Ok(Source::Owned(
			fs::File::options()
				.read(true)
				.write(true)
				.open("/dev/null")?
				.into(),
		)),
	}
}

/// Move every source fd above every target fd, so installing one target
/// (`dup2`) can never clobber a source still to be installed.
fn lift(fds: &mut [(i32, Source)]) -> io::Result<()> {
	let floor = fds.iter().map(|(t, _)| *t).max().unwrap_or(2).max(2) + 1;
	for (_, fd) in fds.iter_mut() {
		if fd.as_raw_fd() < floor {
			// SAFETY: fcntl on an fd we hold; returns a new descriptor.
			let lifted = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, floor) };
			if lifted < 0 {
				return Err(io::Error::last_os_error());
			}
			// SAFETY: a successful F_DUPFD_CLOEXEC returned a descriptor we own.
			*fd = Source::Owned(unsafe { OwnedFd::from_raw_fd(lifted) });
		}
	}
	Ok(())
}

/// Where the child goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
	/// Lead a new session (and group).
	Session,
	/// `setpgid(0, pgid)`: `0` leads a new group.
	Group(i32),
	/// Stay in the host's group and session.
	Inherit,
}

impl Place {
	const fn joins(self) -> bool {
		matches!(self, Self::Group(p) if p != 0)
	}
}

fn place(sessions: Sessions, pgroup: PgroupSpec) -> io::Result<Place> {
	let join = |pgid: u32| -> io::Result<Place> {
		let pgid = i32::try_from(pgid).map_err(invalid)?;
		Ok(if joinable(pgid) {
			Place::Group(pgid)
		} else {
			Place::Group(0)
		})
	};
	Ok(match (sessions, pgroup) {
		(Sessions::Detach, _) => Place::Session,
		(Sessions::Inherit, PgroupSpec::New(_) | PgroupSpec::Join(_)) => Place::Inherit,
		(Sessions::Share, PgroupSpec::New(_))
		| (Sessions::Share | Sessions::Inherit, PgroupSpec::Job { join: None, .. }) => Place::Group(0),
		(Sessions::Share, PgroupSpec::Join(pgid))
		| (Sessions::Share | Sessions::Inherit, PgroupSpec::Job { join: Some(pgid), .. }) => join(pgid)?,
	})
}

/// The terminal a job-controlled foreground spawn hands its group
/// ([`PgroupSpec::Job`]); `None` for every other spawn.
fn job_terminal(place: Place, pgroup: PgroupSpec) -> io::Result<Option<RawFd>> {
	match (place, pgroup) {
		(Place::Group(_), PgroupSpec::Job { terminal: Some(h), .. }) => {
			RawFd::try_from(h.0).map(Some).map_err(invalid)
		},
		_ => Ok(None),
	}
}

/// Make `pgid` the foreground group of terminal `tty` (zsh `attachtty`),
/// with `SIGTTOU` blocked: the caller may itself be in a background group
/// by now (the shell after its job took the terminal). Async-signal-safe:
/// the forked child calls it before it execs.
fn attach_tty(tty: RawFd, pgid: i32) {
	// SAFETY: sigset_t is plain data; the calls only read and write the sets
	// passed, and tcsetpgrp takes no pointers.
	unsafe {
		let mut ttou = std::mem::zeroed::<libc::sigset_t>();
		let mut old = std::mem::zeroed::<libc::sigset_t>();
		libc::sigemptyset(&raw mut ttou);
		libc::sigaddset(&raw mut ttou, libc::SIGTTOU);
		libc::pthread_sigmask(libc::SIG_BLOCK, &raw const ttou, &raw mut old);
		libc::tcsetpgrp(tty, pgid);
		libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old, std::ptr::null_mut());
	}
}

/// Whether to try joining group `pgid`: never when its leader lives in
/// another session (a detached child: `setpgid` would fail with `EPERM`).
/// When the leader's session is unknown (macOS answers `ESRCH` for an
/// unreaped zombie leader, which still holds the group), the join is tried
/// and an `EPERM` falls back to leading a new group.
fn joinable(pgid: i32) -> bool {
	// SAFETY: plain syscalls without pointer arguments.
	let (theirs, ours) = unsafe { (libc::getsid(pgid), libc::getsid(0)) };
	pgid > 0 && (theirs < 0 || theirs == ours)
}

/// Signal dispositions for the child: `true` = ignored.
fn ignored(ign: SigSet) -> [bool; NSIG] {
	let mut out = [false; NSIG];
	for sig in ign.iter() {
		if let Some(slot) = out.get_mut(usize::from(sig.number(Platform::current()))) {
			*slot = true;
		}
	}
	out
}

/// Generation of the process's signal dispositions, bumped by
/// [`dispositions_changed`].
static DISPOSITIONS: AtomicU64 = AtomicU64::new(1);

/// The signals the process ignores, as [`host_ignored`] last read them, and
/// the [`DISPOSITIONS`] generation of that reading.
static HOST_IGNORED: Mutex<(u64, [bool; NSIG])> = Mutex::new((0, [false; NSIG]));

/// See [`crate::sys::dispositions_changed`].
pub(super) fn dispositions_changed() {
	DISPOSITIONS.fetch_add(1, Ordering::Release);
}

/// The signals the process ignores (`true` at their numbers): read once per
/// generation of the dispositions, not per spawn.
fn host_ignored() -> [bool; NSIG] {
	let generation = DISPOSITIONS.load(Ordering::Acquire);
	let mut cached = HOST_IGNORED.lock();
	if cached.0 != generation {
		let mut ignored = [false; NSIG];
		for (n, slot) in ignored.iter_mut().enumerate().skip(1) {
			// SAFETY: sigaction is plain data, valid zeroed.
			let mut old: libc::sigaction = unsafe { std::mem::zeroed() };
			// SAFETY: a null new action only queries; `old` is writable.
			let rc = unsafe { libc::sigaction(n as i32, std::ptr::null(), &raw mut old) };
			*slot = rc == 0 && old.sa_sigaction == libc::SIG_IGN;
		}
		*cached = (generation, ignored);
	}
	cached.1
}

/// Whether the host itself ignores `sig` (children inherit that through
/// `posix_spawn`).
fn host_ignores(sig: Signal) -> bool {
	let n = usize::from(sig.number(Platform::current()));
	host_ignored().get(n).copied().unwrap_or(false)
}

/// Everything `launch` needs besides the fds.
struct Program<'a> {
	path:    &'a [u8],
	argv:    &'a [BString],
	env:     &'a EnvView,
	cwd:     &'a [u8],
	umask:   u32,
	ign:     SigSet,
	/// `(resource, soft, hard)` set in the child before exec.
	rlimits: &'a [(Rlimit, Option<u64>, Option<u64>)],
	/// A foreground job's terminal: the child makes its group the
	/// terminal's foreground before it execs ([`attach_tty`]).
	tty:     Option<RawFd>,
	/// Targets the child gets closed ([`StdioSpec::Closed`]): each is
	/// installed from a null-device placeholder, then closed.
	closed:  &'a [i32],
}

/// A possible shell text file needs the engine's ENOEXEC retry. The child
/// redirection path cannot report exec errors to the engine after returning
/// its pid, so let the engine open the redirections and attempt the real
/// exec itself instead. This is only a routing hint: the actual exec still
/// decides whether the file is executable and whether fallback is needed.
fn may_need_script_fallback(path: &[u8], cwd: &[u8]) -> bool {
	let path = Path::new(OsStr::from_bytes(path));
	let path = if path.is_absolute() {
		path.to_path_buf()
	} else {
		Path::new(OsStr::from_bytes(cwd)).join(path)
	};
	let Ok(mut file) = fs::OpenOptions::new()
		.read(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(path)
	else {
		return false;
	};
	if !file.metadata().is_ok_and(|m| m.is_file()) {
		return false;
	}
	let mut head = [0u8; 80];
	let Ok(n) = file.read(&mut head) else {
		return false;
	};
	let head = &head[..n];
	!head.starts_with(b"#!")
		&& !head
			.split(|&c| c == b'\n')
			.next()
			.unwrap_or_default()
			.contains(&0)
}

pub(super) fn spawn(shared: &Arc<Shared>, spec: SpawnSpec<'_>) -> io::Result<Box<dyn ExtProc>> {
	let SpawnSpec {
		path,
		argv,
		env,
		cwd,
		stdio,
		extra_fds,
		pgroup,
		umask,
		sigmask_ign,
		rlimits,
		lineage,
		redirs,
		ctty,
		..
	} = spec;
	if redirs.is_some() && may_need_script_fallback(path, cwd) {
		// The engine retries with its own asynchronous redirection opens.
		return Err(io::Error::other("script requires engine redirection"));
	}
	// A process of a `zpty` session leads a session of its own, without a
	// controlling terminal (it cannot reach the user's terminal through
	// `/dev/tty`; taking the pty as its controlling terminal would hang
	// the pty up for the session when it exits): no group placement
	// applies.
	let place = if ctty.is_some() {
		Place::Session
	} else {
		place(shared.config.sessions, pgroup)?
	};
	let tty = job_terminal(place, pgroup)?;
	let mut pumps = Vec::new();
	let mut feeds = Vec::new();
	let mut fds = Vec::with_capacity(3 + extra_fds.len());
	let mut closed = Vec::new();
	let [stdin, stdout, stderr] = stdio;
	for (target, spec, dir) in [(0, stdin, Dir::In), (1, stdout, Dir::Out), (2, stderr, Dir::Out)] {
		if matches!(spec, StdioSpec::Closed) {
			closed.push(target);
		}
		fds.push((target, child_fd(shared, spec, dir, &mut pumps, &mut feeds)?));
	}
	for (fd, s) in extra_fds {
		if fd < 3 {
			return Err(invalid(format!("extra fd {fd} overlaps stdio")));
		}
		if matches!(s, StdioSpec::Closed) {
			// Not passed: the child has no such descriptor.
			continue;
		}
		fds.push((fd, child_fd(shared, s, Dir::Probe, &mut pumps, &mut feeds)?));
	}
	lift(&mut fds)?;
	let tracker = Tracker::new(pumps.iter().map(Pump::outputs).sum());
	// Polled by the `ExtProc`; dropped (stopping every pump) on any failure
	// below.
	let pumps = Pumps::new(pumps, feeds, &tracker);
	let program =
		Program { path, argv, env, cwd, umask, ign: sigmask_ign, rlimits, tty, closed: &closed };
	let launched = match &redirs {
		Some(redirs) => fork_redirs(&program, &fds, place, redirs),
		None => launch(&shared.state, &program, &fds, place),
	};
	// Our copies of the child's ends: pumps see end of file when the child
	// (and what it forks) closes its own.
	drop(fds);
	let (pid, place) = launched?;
	if let PgroupSpec::Job { .. } = pgroup
		&& let Place::Group(pgid) = place
	{
		// The shell places its job's process too (zsh `addproc`): whichever
		// of the two runs first decides, so a signal to the group or the
		// terminal's next read cannot come before the child is in it. After
		// the child's exec this fails harmlessly (`EACCES`).
		let want = if pgid == 0 { pid } else { pgid };
		// SAFETY: plain syscall without pointer arguments.
		unsafe { libc::setpgid(pid, want) };
		if let Some(tty) = tty {
			attach_tty(tty, want);
		}
	}
	let scope = Scope::of(place, pid);
	// A detached external is meant to outlive the shell: not a leak.
	if !lineage.detached {
		shared.state.record(scope);
	}
	// Parked: the engine thread waits on the pidfd itself (see `Exits::Park`).
	// A job-controlled external has a waiter thread: a pidfd reports its
	// exit, not its stops.
	#[cfg(target_os = "linux")]
	let pidfd =
		if shared.config.exits == super::Exits::Park && !matches!(pgroup, PgroupSpec::Job { .. }) {
			pidfd_open(pid)
		} else {
			None
		};
	#[cfg(target_os = "linux")]
	let parked = pidfd.is_some();
	#[cfg(not(target_os = "linux"))]
	let parked = false;
	if !parked && let Err(e) = watch(pid, Arc::clone(&tracker), Arc::clone(shared)) {
		// Without a waiter nobody would observe the exit: undo the spawn
		// (the child is unreaped, so its scope is still ours).
		let _ = scope.signal(Signal::Kill);
		shared.state.reap(pid);
		return Err(e);
	}
	Ok(Box::new(UnixProc {
		pid,
		scope,
		tracker,
		shared: Arc::clone(shared),
		detached: lineage.detached,
		pumps,
		#[cfg(target_os = "linux")]
		pidfd,
		#[cfg(target_os = "linux")]
		awaited: false,
	}))
}

/// Spawn by the best path; returns the pid and the placement that took.
fn launch(
	state: &State,
	prog: &Program<'_>,
	fds: &[(i32, Source)],
	place: Place,
) -> io::Result<(i32, Place)> {
	// `posix_spawn` cannot set resource limits either, nor hand a terminal
	// to the child's group before the exec.
	#[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
	if prog.rlimits.is_empty()
		&& prog.tty.is_none()
		&& state.posix_eligible(prog.umask, prog.ign)
		&& let Some(add_chdir) = state.add_chdir
	{
		let exec = Exec::new(prog)?;
		return retry_join(place, |p| posix::spawn(&exec, fds, prog.closed, p, prog.ign, add_chdir));
	}
	#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
	let _ = state;
	fork_exec(prog, fds, place)
}

/// Run `spawn` at `place`; a join refused with `EPERM` (the group emptied
/// or moved sessions since `joinable`) retries as the leader of a new group.
fn retry_join(
	place: Place,
	mut spawn: impl FnMut(Place) -> io::Result<i32>,
) -> io::Result<(i32, Place)> {
	match spawn(place) {
		Err(e) if place.joins() && e.raw_os_error() == Some(libc::EPERM) => {
			let lead = Place::Group(0);
			spawn(lead).map(|pid| (pid, lead))
		},
		r => r.map(|pid| (pid, place)),
	}
}

thread_local! {
	/// Retain the last exported environment on this spawning thread.
	static EXEC_ENV: RefCell<Option<Arc<ExecEnv>>> = const { RefCell::new(None) };
}

/// Immutable C environment shared by consecutive execs with equal exports.
struct ExecEnv {
	source: EnvView,
	/// Storage kept alive for `ptrs`; never modified after construction.
	_buf:   Vec<u8>,
	ptrs:   Vec<*mut c_char>,
}

// SAFETY: the pointers only read the owned, immutable heap buffer.
unsafe impl Send for ExecEnv {}
// SAFETY: sharing only reads the immutable strings and pointer array.
unsafe impl Sync for ExecEnv {}

impl ExecEnv {
	fn get(env: &EnvView) -> io::Result<Arc<Self>> {
		EXEC_ENV.with_borrow_mut(|cached| {
			if let Some(previous) = cached.as_ref()
				&& previous.source == *env
			{
				return Ok(Arc::clone(previous));
			}
			let len: usize = env.iter().map(|(k, v)| k.len() + v.len() + 2).sum();
			let mut buf = Vec::with_capacity(len);
			let base = buf.as_ptr();
			let mut ptrs = Vec::with_capacity(env.len() + 1);
			for (k, v) in env.iter() {
				let at = push_cstring(&mut buf, &[&**k, b"=", &**v])?;
				// The exact capacity includes every entry's terminating NUL,
				// so appending cannot invalidate this allocation's pointers.
				ptrs.push(base.wrapping_add(at).cast::<c_char>().cast_mut());
			}
			ptrs.push(std::ptr::null_mut());
			let built = Arc::new(Self { source: env.clone(), _buf: buf, ptrs });
			*cached = Some(Arc::clone(&built));
			Ok(built)
		})
	}
}

/// Append one NUL-terminated C string without accepting embedded NULs.
fn push_cstring(buf: &mut Vec<u8>, parts: &[&[u8]]) -> io::Result<usize> {
	if parts.iter().any(|p| p.contains(&0)) {
		return Err(CString::new(parts.concat()).map_or_else(invalid, |_| invalid("NUL byte")));
	}
	let at = buf.len();
	for p in parts {
		buf.extend_from_slice(p);
	}
	buf.push(0);
	Ok(at)
}

/// C arguments built before a fork; retries retain the same environment.
struct Exec {
	/// Arguments, path and cwd, NUL-terminated in one immutable allocation.
	buf:  Vec<u8>,
	path: usize,
	cwd:  usize,
	argv: Vec<*mut c_char>,
	env:  Arc<ExecEnv>,
}

// SAFETY: `argv` points into the owned immutable `buf`, and `env` is immutable.
unsafe impl Send for Exec {}
// SAFETY: shared access only reads the same immutable allocations.
unsafe impl Sync for Exec {}

impl Exec {
	fn new(prog: &Program<'_>) -> io::Result<Self> {
		let env = ExecEnv::get(prog.env)?;
		let arg_len: usize = prog.argv.iter().map(|a| a.len() + 1).sum();
		let mut buf = Vec::with_capacity(arg_len + prog.path.len() + prog.cwd.len() + 2);
		let base = buf.as_ptr();
		let mut argv = Vec::with_capacity(prog.argv.len() + 1);
		for a in prog.argv {
			let at = push_cstring(&mut buf, &[a.as_slice()])?;
			// Capacity covers every string, so the allocation stays put.
			argv.push(base.wrapping_add(at).cast::<c_char>().cast_mut());
		}
		argv.push(std::ptr::null_mut());
		let path = push_cstring(&mut buf, &[prog.path])?;
		let cwd = push_cstring(&mut buf, &[prog.cwd])?;
		Ok(Self { buf, path, cwd, argv, env })
	}

	/// The program's path as a C string.
	fn path(&self) -> *const c_char {
		self.buf[self.path..].as_ptr().cast()
	}

	/// The working directory as a C string.
	fn cwd(&self) -> *const c_char {
		self.buf[self.cwd..].as_ptr().cast()
	}
}

/// The fork path: std's `Command` (fork, stdio, cwd, process group) plus an
/// async-signal-safe `pre_exec` that finishes the setup and calls `execve`
/// itself. std would `execvp`, whose libc retries a file without `#!` as a
/// `/bin/sh` script; the engine must see `ENOEXEC` instead and run such a
/// script in-engine, like bash.
fn fork_exec(prog: &Program<'_>, fds: &[(i32, Source)], place: Place) -> io::Result<(i32, Place)> {
	let exec = Exec::new(prog)?;
	let mut cmd = Command::new(OsStr::from_bytes(prog.path));
	cmd.current_dir(OsStr::from_bytes(prog.cwd));
	let stdio = |target: i32| -> io::Result<Stdio> {
		let (_, fd) = fds
			.iter()
			.find(|(t, _)| *t == target)
			.ok_or_else(|| invalid("missing stdio"))?;
		Ok(Stdio::from(fd.as_fd().try_clone_to_owned()?))
	};
	cmd.stdin(stdio(0)?);
	cmd.stdout(stdio(1)?);
	cmd.stderr(stdio(2)?);
	let extra: Vec<(i32, RawFd)> = fds
		.iter()
		.filter(|(t, _)| *t > 2)
		.map(|(t, fd)| (*t, fd.as_raw_fd()))
		.collect();
	let closed = prog.closed.to_vec();
	let ignore = ignored(prog.ign);
	let mask = prog.umask as libc::mode_t;
	let limits = limits(prog);
	let session = place == Place::Session;
	let tty = prog.tty;
	if let Place::Group(pgid) = place {
		cmd.process_group(pgid);
	}
	// SAFETY: the hook runs in the forked child before exec and calls only
	// async-signal-safe functions (umask, dup2, close, signal, setsid,
	// execve) on data prepared before the fork, without allocating.
	unsafe {
		cmd.pre_exec(move || {
			// Use the whole value: a closure naming only `exec.argv` would
			// capture that field (a bare `Vec<*mut c_char>`, not `Send`) instead
			// of the `Exec` whose `Send`/`Sync` covers the pointers.
			let exec = &exec;
			// std placed the child in its group already; it takes the
			// terminal while it still has the shell's dispositions.
			if let Some(tty) = tty {
				attach_tty(tty, libc::getpgrp());
			}
			libc::umask(mask);
			for &(target, src) in &extra {
				if libc::dup2(src, target) < 0 {
					return Err(io::Error::last_os_error());
				}
			}
			for &target in &closed {
				libc::close(target);
			}
			for (n, &ign) in ignore.iter().enumerate().skip(1) {
				let n = n as i32;
				if n == libc::SIGKILL || n == libc::SIGSTOP {
					continue;
				}
				libc::signal(n, if ign { libc::SIG_IGN } else { libc::SIG_DFL });
			}
			if session && libc::setsid() < 0 {
				return Err(io::Error::last_os_error());
			}
			for (res, lim) in &limits {
				if libc::setrlimit(*res, lim) != 0 {
					return Err(io::Error::last_os_error());
				}
			}
			libc::execve(exec.path(), exec.argv.as_ptr().cast(), exec.env.ptrs.as_ptr().cast());
			// Only reached when exec failed: std reports this errno.
			Err(io::Error::last_os_error())
		});
	}
	retry_join(place, |p| {
		if let Place::Group(pgid) = p {
			cmd.process_group(pgid);
		}
		// Dropping the `Child` neither waits nor kills; the waiter owns it.
		cmd.spawn().map(|child| child.id() as i32)
	})
}

/// The resource limits to set in the child; resources this platform lacks
/// are skipped (bash reported them at `ulimit` time).
fn limits(prog: &Program<'_>) -> Vec<(rlimit::Resource, libc::rlimit)> {
	prog
		.rlimits
		.iter()
		.filter_map(|&(r, soft, hard)| {
			let lim = libc::rlimit { rlim_cur: rlimit::to_raw(soft), rlim_max: rlimit::to_raw(hard) };
			rlimit::resource(r).map(|res| (res, lim))
		})
		.collect()
}

/// The descriptions of `errno` values the forked child of
/// [`fork_redirs`] prints (it must not format or allocate): bash's
/// `strerror` texts, by number.
static ERRNO_TEXT: LazyLock<Vec<Vec<u8>>> = LazyLock::new(|| {
	(0..256)
		.map(|n| {
			crate::bash::diag::strerror(&io::Error::from_raw_os_error(n))
				.as_bytes()
				.to_vec()
		})
		.collect()
});

/// One [`ChildRedir`] with its C path and flags, built before the fork.
enum ChildStep {
	Open { fds: Vec<i32>, path: CString, flags: libc::c_int, mode: libc::mode_t, diag: Vec<u8> },
	Dup { fd: i32, src: i32, diag: Vec<u8> },
	Close { fd: i32 },
}

impl ChildStep {
	fn new(redir: &ChildRedir) -> io::Result<Self> {
		Ok(match redir {
			ChildRedir::Open { fds, path, flags, mode, diag } => {
				let access = match (flags.contains(OpenFlags::READ), flags.contains(OpenFlags::WRITE)) {
					(true, true) => libc::O_RDWR,
					(false, true) => libc::O_WRONLY,
					_ => libc::O_RDONLY,
				};
				let extra = [
					(OpenFlags::CREATE, libc::O_CREAT),
					(OpenFlags::TRUNC, libc::O_TRUNC),
					(OpenFlags::APPEND, libc::O_APPEND),
					(OpenFlags::EXCL, libc::O_EXCL),
				]
				.iter()
				.filter(|(f, _)| flags.contains(*f))
				.fold(libc::O_NOCTTY, |acc, (_, bit)| acc | bit);
				Self::Open {
					fds:   fds.clone(),
					path:  CString::new(path.to_vec()).map_err(invalid)?,
					flags: access | extra,
					mode:  *mode as libc::mode_t,
					diag:  diag.to_vec(),
				}
			},
			ChildRedir::Dup { fd, src, diag } => {
				Self::Dup { fd: *fd, src: *src, diag: diag.to_vec() }
			},
			ChildRedir::Close { fd } => Self::Close { fd: *fd },
		})
	}
}

/// Write `diag`, the description of `errno` and a newline to fd 2 and exit
/// with `status`: the forked child's report of a failed redirection or
/// exec. Async-signal-safe.
fn child_fail(diag: &[u8], errno: i32, status: i32, texts: &[Vec<u8>]) -> ! {
	let text = usize::try_from(errno)
		.ok()
		.and_then(|n| texts.get(n))
		.map_or(&b"Unknown error"[..], Vec::as_slice);
	for part in [diag, text, b"\n"] {
		// SAFETY: write(2) of a valid buffer; a failure is ignored (nowhere
		// to report it).
		unsafe { libc::write(2, part.as_ptr().cast(), part.len()) };
	}
	// SAFETY: `_exit` ends the forked child without running host code.
	unsafe { libc::_exit(status) }
}

/// The last OS error number. Async-signal-safe.
fn errno() -> i32 {
	io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// The spawn of a process that applies redirections itself
/// ([`ChildRedirs`]): a bare `fork` whose child installs its fds, applies
/// the redirections in order (an open may wait for a FIFO's other end:
/// only the child waits, as bash's does) and execs. The parent returns at
/// once with the pid; a failure in the child is reported on its own fd 2
/// and its exit status (1 for a redirection, 127 or 126 for the exec).
fn fork_redirs(
	prog: &Program<'_>,
	fds: &[(i32, Source)],
	place: Place,
	redirs: &ChildRedirs,
) -> io::Result<(i32, Place)> {
	let exec = Exec::new(prog)?;
	let steps = redirs
		.list
		.iter()
		.map(ChildStep::new)
		.collect::<io::Result<Vec<_>>>()?;
	let exec_diag = redirs.exec_diag.to_vec();
	let texts: &[Vec<u8>] = &ERRNO_TEXT;
	let ignore = ignored(prog.ign);
	let mask = prog.umask as libc::mode_t;
	let limits = limits(prog);
	let raw: Vec<(i32, RawFd)> = fds.iter().map(|(t, fd)| (*t, fd.as_raw_fd())).collect();
	let closed = prog.closed;
	// Every signal stays blocked across the fork: the child runs with the
	// host's handlers until it resets them, and a signal delivered then (a
	// `kill $!` right after the spawn) would run host code and be lost
	// while the child goes on to wait in a FIFO open. Blocked, it stays
	// pending until the child's dispositions are the program's.
	// SAFETY: sigset_t is plain data; the calls only read and write the
	// sets passed.
	let old = unsafe {
		let mut all = std::mem::zeroed::<libc::sigset_t>();
		let mut old = std::mem::zeroed::<libc::sigset_t>();
		libc::sigfillset(&raw mut all);
		libc::pthread_sigmask(libc::SIG_BLOCK, &raw const all, &raw mut old);
		old
	};
	// SAFETY: the child calls only async-signal-safe functions on data
	// prepared above, without allocating, and ends in `execve` or `_exit`.
	let pid = unsafe { libc::fork() };
	if pid != 0 {
		// SAFETY: restores the mask saved above.
		unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old, std::ptr::null_mut()) };
	}
	if pid < 0 {
		return Err(io::Error::last_os_error());
	}
	if pid == 0 {
		// SAFETY: as above (the forked child).
		unsafe {
			match place {
				Place::Session => {
					libc::setsid();
				},
				// A refused join leads a group of its own (as `retry_join`).
				Place::Group(pgid) => {
					if libc::setpgid(0, pgid) < 0 && pgid != 0 {
						libc::setpgid(0, 0);
					}
					if let Some(tty) = prog.tty {
						attach_tty(tty, libc::getpgrp());
					}
				},
				Place::Inherit => {},
			}
			if libc::chdir(exec.cwd()) != 0 {
				child_fail(&exec_diag, errno(), 126, texts);
			}
			for &(target, src) in &raw {
				if libc::dup2(src, target) < 0 {
					child_fail(&exec_diag, errno(), 126, texts);
				}
			}
			for &target in closed {
				libc::close(target);
			}
			libc::umask(mask);
			for (n, &ign) in ignore.iter().enumerate().skip(1) {
				let n = n as i32;
				if n == libc::SIGKILL || n == libc::SIGSTOP {
					continue;
				}
				libc::signal(n, if ign { libc::SIG_IGN } else { libc::SIG_DFL });
			}
			// Only now may pending signals arrive: they act as on the program.
			let empty = std::mem::zeroed::<libc::sigset_t>();
			libc::sigprocmask(libc::SIG_SETMASK, &raw const empty, std::ptr::null_mut());
			for (res, lim) in &limits {
				if libc::setrlimit(*res, lim) != 0 {
					child_fail(&exec_diag, errno(), 126, texts);
				}
			}
			for step in &steps {
				match step {
					ChildStep::Open { fds, path, flags, mode, diag } => {
						let fd = libc::open(path.as_ptr(), *flags, libc::c_uint::from(*mode));
						if fd < 0 {
							child_fail(diag, errno(), 1, texts);
						}
						for &target in fds {
							if target != fd && libc::dup2(fd, target) < 0 {
								child_fail(diag, errno(), 1, texts);
							}
						}
						if !fds.contains(&fd) {
							libc::close(fd);
						}
					},
					ChildStep::Dup { fd, src, diag } => {
						if libc::dup2(*src, *fd) < 0 {
							child_fail(diag, errno(), 1, texts);
						}
					},
					ChildStep::Close { fd } => {
						libc::close(*fd);
					},
				}
			}
			libc::execve(exec.path(), exec.argv.as_ptr().cast(), exec.env.ptrs.as_ptr().cast());
			let e = errno();
			child_fail(&exec_diag, e, if e == libc::ENOENT { 127 } else { 126 }, texts);
		}
	}
	// The parent places the child too, so a signal to its group cannot
	// come before it joined; whichever of the two runs first decides.
	let place = match place {
		Place::Group(pgid) => {
			let want = if pgid == 0 { pid } else { pgid };
			// SAFETY: plain syscalls without pointer arguments.
			unsafe {
				if libc::setpgid(pid, want) < 0 && pgid != 0 {
					libc::setpgid(pid, pid);
				}
				if pgid != 0 && libc::getpgid(pid) == pid {
					Place::Group(0)
				} else {
					place
				}
			}
		},
		other => other,
	};
	Ok((pid, place))
}

#[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
mod posix {
	use std::{cell::RefCell, io, mem::MaybeUninit, os::fd::AsRawFd};

	thread_local! {
		/// Reusable actions for this thread's last descriptor map and cwd.
		/// The actions contain descriptor numbers, not open-file ownership:
		/// a later spawn always duplicates the descriptors it currently has.
		static ACTIONS: RefCell<Option<Actions>> = const { RefCell::new(None) };
		/// Rebuild attributes only when placement or signal dispositions change.
		static ATTRS: RefCell<Option<(Place, SigSet, u64, Attr)>> = const { RefCell::new(None) };
	}

	/// The cached action list and the inputs that completely describe it.
	struct Actions {
		raw:    FileActions,
		fds:    Vec<(i32, i32)>,
		closed: Vec<i32>,
		cwd:    Vec<u8>,
	}

	impl Actions {
		fn matches(&self, exec: &Exec, fds: &[(i32, Source)], closed: &[i32]) -> bool {
			self.cwd == exec.buf[exec.cwd..]
				&& self.closed == closed
				&& self.fds.len() == fds.len()
				&& self
					.fds
					.iter()
					.zip(fds)
					.all(|(&(target, source), (want, fd))| target == *want && source == fd.as_raw_fd())
		}

		fn new(
			exec: &Exec,
			fds: &[(i32, Source)],
			closed: &[i32],
			add_chdir: AddChdir,
		) -> io::Result<Self> {
			let mut raw = FileActions::new()?;
			for (target, fd) in fds {
				// SAFETY: initialized actions; descriptors are plain integers.
				check(unsafe {
					libc::posix_spawn_file_actions_adddup2(raw.ptr(), fd.as_raw_fd(), *target)
				})?;
			}
			for &target in closed {
				// SAFETY: initialized actions; `target` is a plain integer.
				check(unsafe { libc::posix_spawn_file_actions_addclose(raw.ptr(), target) })?;
			}
			// SAFETY: initialized actions; libc copies the NUL-terminated cwd.
			check(unsafe { add_chdir(raw.ptr(), exec.cwd()) })?;
			Ok(Self {
				raw,
				fds: fds
					.iter()
					.map(|(target, fd)| (*target, fd.as_raw_fd()))
					.collect(),
				closed: closed.to_vec(),
				cwd: exec.buf[exec.cwd..].to_vec(),
			})
		}
	}

	use std::sync::atomic::Ordering;

	use super::{DISPOSITIONS, Exec, Place, Source, host_ignored, ignored};
	use crate::bash::SigSet;

	pub(super) type AddChdir = unsafe extern "C" fn(
		*mut libc::posix_spawn_file_actions_t,
		*const libc::c_char,
	) -> libc::c_int;

	#[cfg(target_os = "macos")]
	#[allow(clippy::unnecessary_wraps, reason = "the libc extension is optional on Linux")]
	pub(super) const fn add_chdir() -> Option<AddChdir> {
		Some(libc::posix_spawn_file_actions_addchdir_np)
	}

	#[cfg(target_os = "linux")]
	pub(super) fn add_chdir() -> Option<AddChdir> {
		// A direct reference prevents loading on glibc < 2.29 before the
		// spawner can choose its existing fork fallback.
		static ADD_CHDIR: std::sync::LazyLock<Option<AddChdir>> = std::sync::LazyLock::new(|| {
			// SAFETY: RTLD_DEFAULT and this NUL-terminated symbol name are valid.
			let symbol = unsafe {
				libc::dlsym(libc::RTLD_DEFAULT, c"posix_spawn_file_actions_addchdir_np".as_ptr())
			};
			if symbol.is_null() {
				None
			} else {
				// SAFETY: the resolved libc function has the AddChdir signature
				// and remains available for the lifetime of the process.
				Some(unsafe { std::mem::transmute::<*mut libc::c_void, AddChdir>(symbol) })
			}
		});
		*ADD_CHDIR
	}

	/// `POSIX_SPAWN_SETSID` (`<sys/spawn.h>`, macOS 10.15+; absent from the
	/// libc crate).
	#[cfg(target_os = "macos")]
	const SETSID: libc::c_int = 0x0400;
	#[cfg(target_os = "linux")]
	const SETSID: libc::c_int = libc::POSIX_SPAWN_SETSID as libc::c_int;

	fn check(rc: libc::c_int) -> io::Result<()> {
		if rc == 0 {
			Ok(())
		} else {
			Err(io::Error::from_raw_os_error(rc))
		}
	}

	/// `posix_spawn` `exec` with `fds` installed and the targets `closed`
	/// closed after, at `place`, with every signal not in `ign` at its
	/// default: the ones the host ignores are reset (`exec` resets caught
	/// ones; glibc's child spends a `sigaction` on each signal of the set).
	/// `add_chdir` is the resolved libc entry point, one value for the
	/// process, so the cached action list does not key on it.
	pub fn spawn(
		exec: &Exec,
		fds: &[(i32, Source)],
		closed: &[i32],
		place: Place,
		ign: SigSet,
		add_chdir: AddChdir,
	) -> io::Result<i32> {
		ACTIONS.with_borrow_mut(|cached| {
			if !cached
				.as_ref()
				.is_some_and(|actions| actions.matches(exec, fds, closed))
			{
				*cached = Some(Actions::new(exec, fds, closed, add_chdir)?);
			}
			let actions = &mut cached.as_mut().expect("initialized actions").raw;
			ATTRS.with_borrow_mut(|cached| {
				let generation = DISPOSITIONS.load(Ordering::Acquire);
				if !cached
					.as_ref()
					.is_some_and(|(p, i, g, _)| *p == place && *i == ign && *g == generation)
				{
					*cached = Some((place, ign, generation, Attr::for_child(place, ign)?));
				}
				let attr = &mut cached.as_mut().expect("initialized attributes").3;
				let mut pid: libc::pid_t = 0;
				// SAFETY: every pointer is valid for the call: NUL-terminated
				// strings owned by `exec`, NULL-terminated pointer arrays, and
				// initialized actions and attributes.
				check(unsafe {
					libc::posix_spawn(
						&raw mut pid,
						exec.path(),
						actions.ptr(),
						attr.ptr(),
						exec.argv.as_ptr(),
						exec.env.ptrs.as_ptr(),
					)
				})?;
				Ok(pid)
			})
		})
	}

	/// Initialized `posix_spawn_file_actions_t`, destroyed on drop.
	struct FileActions(MaybeUninit<libc::posix_spawn_file_actions_t>);

	impl FileActions {
		fn new() -> io::Result<Self> {
			let mut fa = MaybeUninit::uninit();
			// SAFETY: init writes the object; only an initialized one is
			// wrapped (and destroyed on drop).
			check(unsafe { libc::posix_spawn_file_actions_init(fa.as_mut_ptr()) })?;
			Ok(Self(fa))
		}

		const fn ptr(&mut self) -> *mut libc::posix_spawn_file_actions_t {
			self.0.as_mut_ptr()
		}
	}

	impl Drop for FileActions {
		fn drop(&mut self) {
			// SAFETY: initialized in `new`.
			unsafe { libc::posix_spawn_file_actions_destroy(self.0.as_mut_ptr()) };
		}
	}

	/// Initialized `posix_spawnattr_t`, destroyed on drop.
	struct Attr(MaybeUninit<libc::posix_spawnattr_t>);

	impl Attr {
		fn new() -> io::Result<Self> {
			let mut a = MaybeUninit::uninit();
			// SAFETY: init writes the object; only an initialized one is
			// wrapped (and destroyed on drop).
			check(unsafe { libc::posix_spawnattr_init(a.as_mut_ptr()) })?;
			Ok(Self(a))
		}

		fn for_child(place: Place, ign: SigSet) -> io::Result<Self> {
			let mut attr = Self::new()?;
			let mut flags = libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_SETSIGDEF;
			match place {
				Place::Session => flags |= SETSID,
				Place::Group(pgid) => {
					flags |= libc::POSIX_SPAWN_SETPGROUP;
					// SAFETY: `attr` is initialized.
					check(unsafe { libc::posix_spawnattr_setpgroup(attr.ptr(), pgid) })?;
				},
				Place::Inherit => {},
			}
			#[cfg(target_os = "macos")]
			{
				flags |= libc::POSIX_SPAWN_CLOEXEC_DEFAULT;
			}
			// SAFETY: sigset_t is plain data, initialized by sigemptyset below.
			let mut empty: libc::sigset_t = unsafe { std::mem::zeroed() };
			// SAFETY: as above.
			let mut defaults: libc::sigset_t = unsafe { std::mem::zeroed() };
			let ignore = ignored(ign);
			let host = host_ignored();
			// SAFETY: both sets are valid, writable sigset_t values.
			unsafe {
				libc::sigemptyset(&raw mut empty);
				libc::sigemptyset(&raw mut defaults);
				for (n, (&host, &ign)) in host.iter().zip(&ignore).enumerate().skip(1) {
					if host && !ign {
						libc::sigaddset(&raw mut defaults, n as i32);
					}
				}
				check(libc::posix_spawnattr_setflags(attr.ptr(), flags as libc::c_short))?;
				check(libc::posix_spawnattr_setsigmask(attr.ptr(), &raw const empty))?;
				check(libc::posix_spawnattr_setsigdefault(attr.ptr(), &raw const defaults))?;
			}
			Ok(attr)
		}

		const fn ptr(&mut self) -> *mut libc::posix_spawnattr_t {
			self.0.as_mut_ptr()
		}
	}

	impl Drop for Attr {
		fn drop(&mut self) {
			// SAFETY: initialized in `new`.
			unsafe { libc::posix_spawnattr_destroy(self.0.as_mut_ptr()) };
		}
	}
}

/// Block until `pid` exits and return its status, leaving it unreaped;
/// every stop and continue on the way goes to `tracker`
/// ([`ExtProc::poll_event`], zsh's `WUNTRACED`).
///
/// Stops and continues are waited for too (`WSTOPPED | WCONTINUED`; macOS
/// `waitid(WEXITED)` reports stops anyway, measured: `si_status` 17 after
/// `SIGSTOP`). With `WNOWAIT` such a report would repeat, so it is
/// consumed with a non-reaping `waitid(WSTOPPED | WCONTINUED | WNOHANG)`
/// (the event reported is the one consumed) and the wait goes on.
fn wait_exit(pid: i32, tracker: &Tracker) -> ExitStatus {
	loop {
		// SAFETY: siginfo_t is plain data, valid zeroed.
		let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
		// SAFETY: `info` is writable; WNOWAIT leaves the child waitable.
		let rc = unsafe {
			libc::waitid(
				libc::P_PID,
				pid as libc::id_t,
				&raw mut info,
				libc::WEXITED | libc::WSTOPPED | libc::WCONTINUED | libc::WNOWAIT,
			)
		};
		if rc == 0 {
			// SAFETY: waitid filled `info` for a CLD_* event.
			let status = unsafe { info.si_status() };
			match info.si_code {
				libc::CLD_EXITED => return ExitStatus::Exited(status),
				libc::CLD_KILLED | libc::CLD_DUMPED => return signaled(status),
				_ => {
					// SAFETY: as above; without WEXITED this never reaps.
					let mut seen: libc::siginfo_t = unsafe { std::mem::zeroed() };
					// SAFETY: `seen` is writable.
					let rc = unsafe {
						libc::waitid(
							libc::P_PID,
							pid as libc::id_t,
							&raw mut seen,
							libc::WSTOPPED | libc::WCONTINUED | libc::WNOHANG,
						)
					};
					// SAFETY: `seen` was zeroed and possibly filled by waitid.
					if rc != 0 || unsafe { seen.si_pid() } == 0 {
						// Nothing consumed: do not spin on a report that stays.
						thread::sleep(std::time::Duration::from_millis(10));
						continue;
					}
					// SAFETY: waitid filled `seen` for a CLD_* event.
					let sig = unsafe { seen.si_status() };
					match seen.si_code {
						libc::CLD_STOPPED => {
							let sig = u8::try_from(sig)
								.ok()
								.and_then(|n| Signal::from_number(n, Platform::current()))
								.unwrap_or(Signal::Stop);
							tracker.changed(ProcEvent::Stopped(sig));
						},
						libc::CLD_CONTINUED => tracker.changed(ProcEvent::Continued),
						_ => {},
					}
					continue;
				},
			}
		}
		if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
			// ECHILD: someone else reaped it (SIGCHLD set to SIG_IGN in the
			// host). The status is lost; report the conventional failure.
			return ExitStatus::Exited(127);
		}
	}
}

/// A pidfd of child `pid` (close-on-exec; readable once it exited); `None`
/// where the kernel has none (before 5.3) or refuses it.
#[cfg(target_os = "linux")]
fn pidfd_open(pid: i32) -> Option<OwnedFd> {
	// SAFETY: plain syscall without pointer arguments; the result is checked.
	let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
	let fd = RawFd::try_from(fd).ok().filter(|&fd| fd >= 0)?;
	// SAFETY: a successful pidfd_open returned a descriptor we own.
	Some(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// The exit status of `pid` if it has exited, leaving it unreaped (Linux
/// `waitid(WEXITED)` reports exits only).
#[cfg(target_os = "linux")]
fn exit_now(pid: i32) -> Option<ExitStatus> {
	// SAFETY: siginfo_t is plain data, valid zeroed.
	let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
	// SAFETY: `info` is writable; WNOWAIT leaves the child waitable.
	let rc = unsafe {
		libc::waitid(
			libc::P_PID,
			pid as libc::id_t,
			&raw mut info,
			libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
		)
	};
	if rc != 0 {
		// ECHILD: someone else reaped it (as in `wait_exit`). EINTR: the
		// pidfd stays readable, the next park returns at once.
		return (io::Error::last_os_error().kind() != io::ErrorKind::Interrupted)
			.then_some(ExitStatus::Exited(127));
	}
	// SAFETY: waitid filled `info`, or left it zeroed (no exit yet: pid 0).
	if unsafe { info.si_pid() } == 0 {
		return None;
	}
	// SAFETY: as above, for a CLD_* exit.
	let status = unsafe { info.si_status() };
	Some(match info.si_code {
		libc::CLD_KILLED | libc::CLD_DUMPED => signaled(status),
		_ => ExitStatus::Exited(status),
	})
}

fn signaled(n: i32) -> ExitStatus {
	u8::try_from(n)
		.ok()
		.and_then(|n| Signal::from_number(n, Platform::current()))
		.map_or(ExitStatus::SignaledRaw(n), ExitStatus::Signaled)
}

/// Reap `pid`, which has exited (or is about to: SIGKILL was sent).
fn reap(pid: i32) {
	let mut st = 0;
	// SAFETY: `st` is writable; `pid` is our unreaped child.
	while unsafe { libc::waitpid(pid, &raw mut st, 0) } < 0
		&& io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
	{}
}

/// A spawned external. Its process is never reaped while this exists, so
/// signals to its scope cannot reach a recycled pid or group.
struct UnixProc {
	pid:      i32,
	scope:    Scope,
	tracker:  Arc<Tracker>,
	shared:   Arc<Shared>,
	/// [`crate::bash::Lineage::detached`]: dropping it while it runs releases
	/// the process instead of escalating TERM → KILL.
	detached: bool,
	/// The child's pumps and the shared input feeds it holds (kept open
	/// while this lives), driven by `poll_wait`.
	pumps:    Pumps,
	/// [`super::Exits::Park`]: the pidfd a [`Parker`](crate::sys::Parker) waits
	/// on, while no waiter thread watches the process.
	#[cfg(target_os = "linux")]
	pidfd:    Option<OwnedFd>,
	/// The first poll registers the pidfd directly; later polls may have
	/// been woken by its readiness and check the exit status.
	#[cfg(target_os = "linux")]
	awaited:  bool,
}

#[cfg(target_os = "linux")]
impl UnixProc {
	/// Parked: record the exit if the process has exited (unreaped); whether
	/// the exit is known.
	fn exited_now(&self) -> bool {
		if self.tracker.lock().has_exited() {
			return true;
		}
		let Some(status) = exit_now(self.pid) else {
			return false;
		};
		crate::sys::park::exits::forget(self.pid);
		// The `ExtProc` is alive: nothing to reap yet.
		let _ = self.tracker.exited(status);
		true
	}

	/// Parked and still running: have the next park wake `waker` at the
	/// exit, or hand the process to a waiter thread when no parker waits.
	fn await_exit(&mut self, waker: &std::task::Waker) {
		let Some(fd) = self.pidfd.as_ref().map(AsRawFd::as_raw_fd) else {
			return;
		};
		self.awaited = true;
		if !crate::sys::park::exits::await_exit(self.pid, fd, waker) {
			self.unpark();
		}
	}

	/// Hand the process to a waiter thread (it reaps when abandoned); wait
	/// here when no thread can be started.
	fn unpark(&mut self) {
		crate::sys::park::exits::forget(self.pid);
		if self.pidfd.take().is_some()
			&& watch(self.pid, Arc::clone(&self.tracker), Arc::clone(&self.shared)).is_err()
		{
			let status = wait_exit(self.pid, &self.tracker);
			if self.tracker.exited(status) {
				self.shared.state.reap(self.pid);
			}
		}
	}
}

impl ExtProc for UnixProc {
	fn pid(&self) -> u32 {
		self.pid as u32
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		#[cfg(target_os = "linux")]
		if self.pidfd.is_some() && !(self.awaited && self.exited_now()) {
			self.await_exit(cx.waker());
		}
		self.pumps.poll(cx, &self.tracker);
		self.tracker.poll(cx)
	}

	fn poll_event(&mut self, cx: &mut Context<'_>) -> Poll<ProcEvent> {
		#[cfg(target_os = "linux")]
		if self.pidfd.is_some() && !(self.awaited && self.exited_now()) {
			self.await_exit(cx.waker());
		}
		self.pumps.poll(cx, &self.tracker);
		self.tracker.poll_event(cx)
	}

	fn pgid(&self) -> Option<u32> {
		match self.scope {
			Scope::Group(id) | Scope::Session(id) => u32::try_from(id).ok(),
			Scope::Process { .. } => None,
		}
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.tracker.lock().signalled(sig);
		self.scope.signal(sig)
	}

	fn stop(&mut self) -> io::Result<()> {
		self.scope.signal(Signal::Stop)
	}

	fn cont(&mut self) -> io::Result<()> {
		self.scope.signal(Signal::Cont)
	}
}

impl Drop for UnixProc {
	fn drop(&mut self) {
		// The pumps (and the feeds, giving back what no child read) stop when
		// the fields drop, after this.
		#[cfg(target_os = "linux")]
		if self.pidfd.is_some() {
			// Parked: no waiter knows the exit yet.
			self.exited_now();
			crate::sys::park::exits::forget(self.pid);
		}
		let grace = self.shared.config.grace;
		let mut life = self.tracker.lock();
		if self.detached {
			let exited = life.release();
			drop(life);
			if exited {
				self.shared.state.reap(self.pid);
				return;
			}
			// Running on; parked: a waiter observes the exit and reaps.
			#[cfg(target_os = "linux")]
			self.unpark();
			return;
		}
		match life.abandon(Instant::now(), grace) {
			Abandon::Exited => {
				drop(life);
				self.shared.state.reap(self.pid);
			},
			Abandon::Orphaned { term, sweep_at } => {
				// Unreaped (a zombie), so the scope is still ours.
				if term {
					let _ = self.scope.signal(Signal::Term);
				}
				let _ = self.scope.signal(Signal::Cont);
				drop(life);
				self.shared.state.reap(self.pid);
				escalate_at(&self.tracker, self.scope, sweep_at);
			},
			Abandon::Escalate { term, kill_at } => {
				// Under the lock: the waiter cannot record the exit and reap
				// in between, so the scope is still ours.
				if term {
					let _ = self.scope.signal(Signal::Term);
				}
				// A stopped (paused) group acts on TERM only once continued.
				let _ = self.scope.signal(Signal::Cont);
				drop(life);
				escalate_at(&self.tracker, self.scope, kill_at);
				// Parked: a waiter observes the exit and reaps.
				#[cfg(target_os = "linux")]
				self.unpark();
			},
		}
	}
}

/// [`escalate`] on a thread of its own; at once when no thread can be
/// started (KILL now rather than never).
fn escalate_at(tracker: &Arc<Tracker>, scope: Scope, kill_at: Instant) {
	let waiter = Arc::clone(tracker);
	let started = thread::Builder::new()
		.name("obash-kill".into())
		.stack_size(SMALL_STACK)
		.spawn(move || escalate(&waiter, scope, kill_at));
	if started.is_err() {
		let now = Instant::now();
		tracker.lock().schedule_kill(now);
		escalate(tracker, scope, now);
	}
}

/// After `kill_at`: KILL the scope if its leader is still running (under the
/// lock, so it is unreaped), then every straggler left in a group or session
/// (identity-pinned).
fn escalate(tracker: &Tracker, scope: Scope, kill_at: Instant) {
	let now = Instant::now();
	if kill_at > now {
		thread::sleep(kill_at - now);
	}
	{
		let mut life = tracker.lock();
		if life.take_kill(Instant::now().max(kill_at)) {
			let _ = scope.signal(Signal::Kill);
		}
	}
	scope.sweep();
}

fn leftover_procs(shared: &Shared) -> io::Result<Vec<(Scope, ProcInfo)>> {
	// Keep process-only scopes unreaped until their identities have been
	// read: otherwise a recycled pid could appear to be our external.
	let mut groups = shared.state.groups.lock();
	let me = std::process::id() as i32;
	let table = proc::list()?;
	groups
		.list
		.retain(|s| table.iter().any(|p| s.contains(p)) || s.alive());
	groups.next_sweep = groups.list.len() + SWEEP;
	Ok(table
		.into_iter()
		.filter(|p| p.pid != me && p.state != ProcState::Zombie)
		.filter_map(|p| groups.list.iter().find(|g| g.contains(&p)).map(|g| (*g, p)))
		.collect())
}

fn leftover((s, p): &(Scope, ProcInfo)) -> Leftover {
	Leftover { pid: p.pid as u32, group: s.id() as u32, name: p.name.clone() }
}

pub(super) fn leftovers(shared: &Shared) -> io::Result<Vec<Leftover>> {
	Ok(leftover_procs(shared)?.iter().map(leftover).collect())
}

pub(super) fn kill_leftovers(shared: &Shared) -> io::Result<Vec<Leftover>> {
	let mut killed = Vec::new();
	for entry in leftover_procs(shared)? {
		if proc::signal_pinned(&entry.1, Signal::Kill)? {
			killed.push(leftover(&entry));
		}
	}
	Ok(killed)
}

#[cfg(test)]
mod tests;
