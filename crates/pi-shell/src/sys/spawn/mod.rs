//! The reference spawner: every external runs in its own process group
//! (Unix) or Job Object (Windows), so a cancel or a job pause reaches the
//! whole tree, and nothing it started outlives a cancel unnoticed. The
//! exception is [`Sessions::Inherit`] (standalone shells): externals share
//! the host's group, and group-wide operations narrow to the external's pid.
//!
//! **Lifecycle of an [`ExtProc`] it returns.**
//! - A waiter observes the exit without reaping it (Unix `waitid(WNOWAIT)`): an
//!   exited pipeline leader keeps its process group alive for later
//!   `PgroupSpec::Join` stages, and a group signal can never reach a recycled
//!   pid while the `ExtProc` exists. The waiter is a thread, or under
//!   [`Exits::Park`] (Linux) the engine thread itself, parked in a
//!   [`Parker`](crate::sys::Parker) with the external's pidfd.
//! - [`ExtProc::poll_wait`] is ready once the process has exited *and* its
//!   output pumps have delivered everything (a redirect into a VFS file is
//!   complete when the command is). It also drives the pumps and the shared
//!   input feeds of the external: no thread moves their bytes. Output still
//!   flowing when the `ExtProc` is dropped (an abandoned or detached external)
//!   is delivered to its end of file as adopted work
//!   ([`NativeSpawner::poll_orphans`]); input stops with the `ExtProc`.
//! - Dropping the `ExtProc` after the exit reaps the process. Dropping it while
//!   the process runs *abandons* it (the engine's cancel unwinds this way):
//!   TERM goes to the group at once unless it was already sent, KILL follows
//!   after [`SpawnConfig::grace`] (default 2 s) to the group and to every
//!   straggler still in it, and the process is reaped in the background. `kill
//!   -TERM` from a script never escalates.
//! - A detached external ([`crate::bash::Lineage::detached`], `nohup`) is
//!   released instead: dropping its `ExtProc` signals nothing, the process runs
//!   on and is reaped in the background when it exits, and the leak checks do
//!   not count it.
//!
//! **Leak checks.** The spawner remembers every group (session, job) it
//! created; [`NativeSpawner::leftovers`] lists the processes still in them,
//! [`NativeSpawner::kill_leftovers`] kills those. The testkit calls them after
//! each case.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::{
	fmt, fs, io,
	sync::{Arc, Weak},
	task::Context,
	time::Duration,
};

use bstr::BString;
use parking_lot::Mutex;

#[cfg(unix)]
use self::unix as imp;
#[cfg(windows)]
use self::windows as imp;
use crate::{
	bash::{ExtProc, SpawnSpec, StdioSpec},
	sys::pump::{End, Feed, Pump, os},
};

/// Spawns externals for a [`Host`](crate::bash::Host). Cheap to clone; clones
/// share the leak-check registry.
#[derive(Clone)]
pub struct NativeSpawner {
	shared: Arc<Shared>,
}

/// Configuration of a [`NativeSpawner`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpawnConfig {
	/// Time between TERM and KILL when a running external is abandoned, and
	/// on Windows after any TERM (`CTRL_BREAK` is often ignored).
	pub grace:    Duration,
	/// Session layout of externals (Unix).
	pub sessions: Sessions,
	/// Who observes the exits of externals (Linux).
	pub exits:    Exits,
	/// The process umask, when the host knows it (Unix): `None` makes the
	/// spawner read it itself, from `/proc/self/status` on Linux or via a
	/// forked probe on other Unix systems. Externals asking for exactly this
	/// mask take the `posix_spawn` path, which cannot set one.
	pub umask:    Option<u32>,
}

impl SpawnConfig {
	/// The default [`SpawnConfig::grace`].
	pub const DEFAULT_GRACE: Duration = Duration::from_secs(2);
}

impl Default for SpawnConfig {
	fn default() -> Self {
		Self {
			grace:    Self::DEFAULT_GRACE,
			sessions: Sessions::default(),
			exits:    Exits::default(),
			umask:    None,
		}
	}
}

/// Who observes the exit of a running external.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum Exits {
	/// A waiter thread per running external blocks in `waitid` and wakes
	/// the engine's waker (threads are pooled). Works with any executor.
	#[default]
	Thread,
	/// Linux: the engine thread waits for the exit itself while it parks in
	/// a [`Parker`](crate::sys::Parker) (a pidfd in its `poll` set), one thread
	/// switch per external fewer in each direction. For hosts whose engine
	/// thread polls the `ExtProc`s and blocks only in [`Parker::park`]
	/// (`obash`). An external falls back to a waiter thread when no parker
	/// exists, `pidfd_open` fails, or it is abandoned while running; other
	/// platforms always use [`Exits::Thread`].
	///
	/// [`Parker::park`]: crate::sys::Parker::park
	Park,
}

/// Where a Unix external lives relative to the host's session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum Sessions {
	/// Every external leads a new session (`setsid`), hence its own process
	/// group, without a controlling terminal: reading or configuring a
	/// terminal never stops it with `SIGTTIN`/`SIGTTOU`, and it cannot grab
	/// the host's foreground. `PgroupSpec::Join` stages lead their own
	/// sessions too: a process can never `setpgid`-join a leader in another
	/// session (`EPERM`, the pi-shell lesson). The default, for agent hosts.
	#[default]
	Detach,
	/// Bash job-control layout: `PgroupSpec::New` leads a process group in the
	/// host's session, `Join` joins the leader's group when that group is
	/// still in this session (otherwise, or on `EPERM`, the stage leads its
	/// own group). Externals in a background group stop when they touch the
	/// terminal; use this only when the host manages the foreground.
	Share,
	/// Non-interactive bash layout: externals stay in the host's process
	/// group and session (no `setpgid`, no `setsid`), so they share its
	/// controlling terminal (`read < /dev/tty` in a nested shell works).
	/// `PgroupSpec` is ignored. Because the group is the host's, every
	/// group-wide operation narrows to the spawned process itself: signals,
	/// `stop`/`cont` and the abandon escalation reach only that pid, and
	/// leak checks see only it, not processes it forked (bash's own view of
	/// its children). For standalone shells such as `obash`.
	Inherit,
}

/// A process still alive in a group, session or job the spawner created.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Leftover {
	/// OS process id.
	pub pid:   u32,
	/// The group it was found in: process group or session id (Unix; the
	/// pid itself under [`Sessions::Inherit`]), the job's leader pid
	/// (Windows).
	pub group: u32,
	/// Command name (Unix `comm`, Windows image path).
	pub name:  BString,
}

/// A spawn asked for an fd the platform cannot hand to an external.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("fd {fd} to external on Windows")]
pub struct UnsupportedFd {
	/// The fd number (> 2).
	pub fd: i32,
}

/// Spawner state shared by clones and by the processes it spawned.
struct Shared {
	config: SpawnConfig,
	state:  imp::State,
	/// Engine read ends currently bridged into an OS pipe, alive while an
	/// external holding the pipe is.
	feeds:  Mutex<Vec<Weak<Feed>>>,
}

impl Shared {
	/// The live feed of engine object `fd`, if one exists.
	#[cfg(unix)]
	fn feed_of(&self, fd: &crate::bash::FdRef) -> Option<Arc<Feed>> {
		let mut feeds = self.feeds.lock();
		feeds.retain(|f| f.strong_count() > 0);
		feeds.iter().filter_map(Weak::upgrade).find(|f| f.feeds(fd))
	}

	/// The child's read end of the pipe fed from `end`. An engine fd object
	/// gets one pipe and one pump for every external and fd it is handed to
	/// (see [`Feed`]); the child's `ExtProc` keeps and polls the feed through
	/// `held`. A host file without an OS handle has no identity: it gets its
	/// own pipe.
	fn input(
		&self,
		end: End,
		pumps: &mut Vec<Pump>,
		held: &mut Vec<Arc<Feed>>,
	) -> io::Result<fs::File> {
		let End::Fd(fd) = end else {
			return pipe_end(end, true, pumps);
		};
		let mut feeds = self.feeds.lock();
		feeds.retain(|f| f.strong_count() > 0);
		let found = feeds
			.iter()
			.filter_map(Weak::upgrade)
			.find(|f| f.feeds(&fd));
		let feed = if let Some(feed) = found {
			feed
		} else {
			let feed = Arc::new(Feed::new(fd)?);
			feeds.push(Arc::downgrade(&feed));
			feed
		};
		drop(feeds);
		let child = feed.child_end()?;
		if !held.iter().any(|h| Arc::ptr_eq(h, &feed)) {
			held.push(feed);
		}
		Ok(child)
	}
}

impl NativeSpawner {
	/// A spawner with `config`.
	///
	/// Without [`SpawnConfig::umask`], on Unix other than Linux this reads
	/// the process umask by setting and restoring it (there is no read-only
	/// call); create such spawners before threads that create files start.
	pub fn new(config: SpawnConfig) -> Self {
		Self {
			shared: Arc::new(Shared {
				config,
				#[cfg(unix)]
				state: imp::State::new(config.umask),
				#[cfg(windows)]
				state: imp::State::new(),
				feeds: Mutex::new(Vec::new()),
			}),
		}
	}

	/// The configuration.
	pub fn config(&self) -> SpawnConfig {
		self.shared.config
	}

	/// The process umask read when the spawner was created (Unix; `None`
	/// elsewhere or when it could not be read). A host gives its shells
	/// this mask: externals spawned with it take the `posix_spawn` path,
	/// which cannot set another.
	#[cfg_attr(
		not(unix),
		expect(clippy::missing_const_for_fn, reason = "the Unix version reads the spawner's state")
	)]
	pub fn umask(&self) -> Option<u32> {
		#[cfg(unix)]
		{
			self.shared.state.umask()
		}
		#[cfg(not(unix))]
		None
	}

	/// Advance the output work of externals whose `ExtProc` is gone: output
	/// pumps of a detached or abandoned external and relays a leftover holds
	/// open deliver to the ends of their streams, as plain pipes would. Inside
	/// a Tokio runtime that work runs as tasks of it; elsewhere it is kept for
	/// whoever calls this (every external's `poll_wait` and a
	/// [`Parker`](crate::sys::Parker) do) and wakes `cx`'s task when it can go
	/// on.
	pub fn poll_orphans(cx: &Context<'_>) {
		crate::sys::pump::orphan::poll(cx);
	}

	/// Spawn `spec`; see the module docs for the process lifecycle.
	///
	/// # Errors
	///
	/// The OS error of the spawn (`NotFound`, `PermissionDenied`, …), or
	/// `InvalidInput` for arguments the OS cannot represent (interior NUL;
	/// non-UTF-8 on Windows). On Windows any extra fd fails with
	/// `Unsupported` carrying an [`UnsupportedFd`].
	pub fn spawn(&self, spec: SpawnSpec<'_>) -> io::Result<Box<dyn ExtProc>> {
		imp::spawn(&self.shared, spec)
	}

	/// Processes still alive in the groups, sessions (Unix) or jobs
	/// (Windows) this spawner created, excluding zombies and the calling
	/// process. Empty after a clean case.
	pub fn leftovers(&self) -> io::Result<Vec<Leftover>> {
		imp::leftovers(&self.shared)
	}

	/// Kill (`SIGKILL`, `TerminateJobObject`) every [`leftover`] and return
	/// them. Unix kills are identity-pinned: a pid recycled since the scan is
	/// never hit.
	///
	/// [`leftover`]: NativeSpawner::leftovers
	pub fn kill_leftovers(&self) -> io::Result<Vec<Leftover>> {
		imp::kill_leftovers(&self.shared)
	}
}

impl Default for NativeSpawner {
	fn default() -> Self {
		Self::new(SpawnConfig::default())
	}
}

impl fmt::Debug for NativeSpawner {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("NativeSpawner")
			.field("config", &self.shared.config)
			.finish_non_exhaustive()
	}
}

/// Direction of a stream as seen from the child.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dir {
	/// The child reads (stdin).
	In,
	/// The child writes (stdout, stderr).
	Out,
	/// Not given (extra fds): probed from the engine object, see
	/// [`End::direction`].
	#[cfg(unix)]
	Probe,
}

/// The child's side of one stream; pumps for engine objects go to `pumps`,
/// shared input feeds the `ExtProc` must keep go to `held`. `None` for
/// [`StdioSpec::Null`].
fn child_end(
	shared: &Shared,
	spec: StdioSpec,
	dir: Dir,
	pumps: &mut Vec<Pump>,
	held: &mut Vec<Arc<Feed>>,
) -> io::Result<Option<fs::File>> {
	let end = match spec {
		StdioSpec::Inherit(h) => return imp::dup(h).map(Some),
		StdioSpec::Null => return Ok(None),
		StdioSpec::Pipe(fd) => End::Fd(fd),
		StdioSpec::File(f) => match f.os_handle() {
			Some(h) => return imp::dup(h).map(Some),
			None => End::File(f),
		},
	};
	match dir {
		Dir::In => shared.input(end, pumps, held).map(Some),
		Dir::Out => pipe_end(end, false, pumps).map(Some),
		#[cfg(unix)]
		Dir::Probe => {
			let mut end = end;
			// Already feeding another external or fd: the same pipe, no probe.
			if let End::Fd(fd) = &end
				&& shared.feed_of(fd).is_some()
			{
				return shared.input(end, pumps, held).map(Some);
			}
			match end.direction() {
				(true, false) => shared.input(end, pumps, held).map(Some),
				(true, true) => {
					// Read-write (`n<>`): one socket pumped both ways. Linux
					// cannot reopen a socket through `/dev/fd/N` (ENXIO), but
					// `n<>` is used through the fd number, not by path.
					let (ours, theirs) = os::socket_pair()?;
					pumps.push(Pump::Duplex(end, ours));
					Ok(Some(theirs))
				},
				// Writable only, or neither (a pipe whose reader is gone: the
				// child writes and gets EPIPE as it would).
				(false, _) => pipe_end(end, false, pumps).map(Some),
			}
		},
	}
}

/// A pipe between the child and engine object `end`; the child's end.
fn pipe_end(end: End, child_reads: bool, pumps: &mut Vec<Pump>) -> io::Result<fs::File> {
	let (ours, theirs) = os::pipe(child_reads)?;
	pumps.push(if child_reads {
		Pump::In(end, ours)
	} else {
		Pump::Out(ours, end)
	});
	Ok(theirs)
}
