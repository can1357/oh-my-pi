//! pi's engine host: [`PiHost`], the [`crate::bash::Host`] of an embedded
//! shell.
//!
//! Unlike `obash`'s `NativeHost`, an embedded host owns no part of the host
//! process: it installs no OS signal handlers, takes over no inherited fds,
//! never reports a terminal, and gives the shell standard streams that a
//! [`Session`](crate::session::Session) swaps per command
//! ([`StdStreams`]). Every external leads its own session and process group
//! (`Sessions::Detach`), so a cancel reaches its whole tree and nothing it
//! does can touch pi's terminal or process group.

use std::{
	cell::OnceCell,
	hash::{BuildHasher, RandomState},
	io,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll, Waker},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::Mutex;

use crate::{
	bash::{
		Deadline, Event, ExitStatus, ExtProc, FdRef, File, FileKind, Fs, IntrinsicId, Invocation,
		ModeId, NativeRef, OsHandle, ResolveCtx, Resolved, Rlimit, Signal, SpawnFuture, SpawnSpec,
		StdFd, StdioSpec, SystemTimeLike, Task, Timer, TtyInfo, UserInfo, Verdict,
	},
	output_decode,
	sys::{End, Exits, NativeSpawner, OutputDecoding, Relays, Sessions, SpawnConfig, StdFile},
	tools::{SpawnLog, ToolConfig},
};

mod urls;

/// Time between TERM and KILL when a running external is abandoned (a cancel
/// unwinds the command that waits for it): pi's `TERM_GRACE`.
pub const TERM_GRACE: Duration = Duration::from_secs(1);

/// Told about every external a [`PiHost`] spawns, from the engine thread.
///
/// The [`Session`](crate::session::Session) lists a run's live children
/// through it (pi's `Shell::pids()`). Implementations must not block.
pub trait SpawnObserver: Send + Sync {
	/// `pid` was spawned; it leads its own session and process group, so
	/// its process group id is `pid` too (Unix).
	fn spawned(&self, pid: u32);
	/// `pid`'s exit was observed, or the engine abandoned it (the spawner
	/// then terminates it in the background).
	fn released(&self, pid: u32);
}

/// The shell's standard streams, replaced for each run.
///
/// Files acquired from [`crate::bash::Host::stdio`] retain their run's slots.
/// Clearing those slots closes the caller's pipe ends and makes subsequent
/// reads return EOF and writes discard their data, even if background jobs
/// still hold the files. Externals may independently hold the pipe open.
/// Cheap to clone; clones share the current generation.
#[derive(Clone, Default)]
pub struct StdStreams {
	slots: Arc<Mutex<Arc<[Slot; 3]>>>,
	/// Stdout and stderr of the current run are one text capture
	/// ([`StdStreams::install`]).
	text:  Arc<AtomicBool>,
}

/// One swappable stream.
type Slot = Mutex<Option<Box<dyn File>>>;

impl StdStreams {
	/// Install the three streams of the next command (`None`: like
	/// `/dev/null`). `text` says stdout and stderr are one pipe whose reader
	/// takes its bytes as shell text, so externals writing there are decoded
	/// ([`PiHost::set_output_decoding`]).
	pub fn install(&self, streams: [Option<std::fs::File>; 3], text: bool) {
		let slots =
			streams.map(|file| Mutex::new(file.map(|f| Box::new(StdFile::new(f)) as Box<dyn File>)));
		*self.slots.lock() = Arc::new(slots);
		self.text.store(text, Ordering::Release);
	}

	/// Whether `os` is the stdout or stderr of a text capture the run
	/// installed ([`StdStreams::install`]).
	fn is_text(&self, os: OsHandle) -> bool {
		if !self.text.load(Ordering::Acquire) {
			return false;
		}
		let slots = Arc::clone(&self.slots.lock());
		slots[1..]
			.iter()
			.any(|slot| slot.lock().as_ref().and_then(|f| f.os_handle()) == Some(os))
	}

	/// A dup of the text capture's stdout, which decoded text is forwarded
	/// into.
	fn text_sink(&self) -> Option<Box<dyn File>> {
		let slots = Arc::clone(&self.slots.lock());
		let stdout = slots[1].lock();
		stdout.as_ref()?.dup().ok()
	}

	/// Remove every stream, closing the files installed last.
	pub fn clear(&self) {
		for slot in self.slots.lock().iter() {
			*slot.lock() = None;
		}
	}

	/// The engine-side file of stream `fd`.
	fn file(&self, fd: StdFd) -> Box<dyn File> {
		let index = match fd {
			StdFd::Stdin => 0,
			StdFd::Stdout => 1,
			StdFd::Stderr => 2,
		};
		Box::new(StreamFile { slots: Arc::clone(&self.slots.lock()), index })
	}
}

/// An engine [`File`] forwarding to one of the [`StdStreams`].
struct StreamFile {
	slots: Arc<[Slot; 3]>,
	index: usize,
}

impl StreamFile {
	fn with<T>(&self, empty: T, f: impl FnOnce(&mut dyn File) -> T) -> T {
		self.slots[self.index]
			.lock()
			.as_mut()
			.map_or(empty, |file| f(&mut **file))
	}
}

impl File for StreamFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		self.with(Poll::Ready(Ok(0)), |f| f.poll_read(cx, buf))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.with(Poll::Ready(Ok(buf.len())), |f| f.poll_write(cx, buf))
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		self.with(Poll::Ready(Ok(())), |f| f.poll_flush(cx))
	}

	fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
		self.with(Err(io::ErrorKind::Unsupported.into()), |f| f.seek(pos))
	}

	fn kind(&self) -> FileKind {
		self.with(FileKind::Device, |f| f.kind())
	}

	fn os_handle(&self) -> Option<OsHandle> {
		self.with(None, |f| f.os_handle())
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		// Share the generation, not a duplicate OS handle: clear closes the
		// run's pipe even while a background job retains this file.
		Ok(Box::new(Self { slots: Arc::clone(&self.slots), index: self.index }))
	}
}

/// pi's [`crate::bash::Host`]: the given filesystem, a process-group spawner,
/// per-command standard streams, and no OS signal, fd or terminal state of
/// the host process.
pub struct PiHost {
	fs:       Box<dyn Fs + Send>,
	/// Launches externals; a spawn that waits on the filesystem provider
	/// carries a clone.
	launcher: Launcher,
	/// pi's commands that are host callouts ([`crate::tools`]).
	tools:    ToolConfig,
	runtime:  tokio::runtime::Handle,
	start:    Instant,
	random:   RandomState,
	draws:    u64,
	/// [`crate::bash::Host::user`], read once.
	user:     OnceCell<UserInfo>,
	/// The pi-vfs filesystem behind `fs`, when there is one: what an
	/// external's URL arguments and working directory alias.
	vfs:      Option<crate::vfs::VfsFs>,
	/// Mirrors the pipeline pipes of the command being run.
	pipe_tap: Option<Arc<dyn crate::bash::PipeTap>>,
}

/// What launching an external needs of a [`PiHost`], owned and cheap to
/// clone, so the future of a spawn that first resolves URLs
/// ([`crate::bash::SpawnFuture`]) holds no borrow of the host.
#[derive(Clone)]
struct Launcher {
	spawner:  NativeSpawner,
	streams:  StdStreams,
	observer: Option<Arc<dyn SpawnObserver>>,
	/// Externals of labeled subshell trees, for the tools.
	spawns:   SpawnLog,
	/// Decodes what externals write into a text sink; `None` where output
	/// needs none ([`output_decode::external_output_decoding`]).
	decoding: Option<Arc<dyn OutputDecoding>>,
}

/// A text sink a relay forwards into.
enum TextSink {
	/// The run's text capture.
	Run,
	/// A command substitution's capture.
	Capture(FdRef),
}

impl TextSink {
	fn is_same(&self, other: &Self) -> bool {
		match (self, other) {
			(Self::Run, Self::Run) => true,
			(Self::Capture(a), Self::Capture(b)) => a.same(b),
			_ => false,
		}
	}
}

impl Launcher {
	/// The text sink `stdio` writes into, if it is one.
	fn text_sink_of(&self, stdio: &StdioSpec) -> Option<TextSink> {
		match stdio {
			StdioSpec::Inherit(os) => self.streams.is_text(*os).then_some(TextSink::Run),
			StdioSpec::Pipe(fd) => fd.is_capture().then(|| TextSink::Capture(fd.clone())),
			StdioSpec::Null | StdioSpec::File(_) => None,
		}
	}

	/// Point the stdout and stderr of `spec` that write into a text sink at
	/// relays. Streams of one sink share a relay, so their interleaving
	/// survives; pipeline pipes and files are left alone.
	fn route_text(&self, spec: &mut SpawnSpec<'_>, relays: &mut Relays<'_>) -> io::Result<()> {
		let mut routed: Vec<(TextSink, OsHandle)> = Vec::new();
		for index in [1, 2] {
			let Some(sink) = self.text_sink_of(&spec.stdio[index]) else {
				continue;
			};
			let os = if let Some(&(_, os)) = routed.iter().find(|(known, _)| known.is_same(&sink)) {
				os
			} else {
				let end = match &sink {
					TextSink::Run => match self.streams.text_sink() {
						Some(file) => End::File(file),
						None => continue,
					},
					TextSink::Capture(fd) => End::Fd(fd.clone()),
				};
				let os = relays.attach(end)?;
				routed.push((sink, os));
				os
			};
			spec.stdio[index] = StdioSpec::Inherit(os);
		}
		Ok(())
	}

	/// Start the external `spec` names, now. Text routing and the observer
	/// see a spawn only once it succeeded.
	fn launch(&self, mut spec: SpawnSpec<'_>) -> io::Result<Box<dyn ExtProc>> {
		let mut relays = self.decoding.as_deref().map(Relays::new);
		if let Some(relays) = &mut relays {
			self.route_text(&mut spec, relays)?;
		}
		let lineage = spec.lineage;
		let mut child = self.spawner.spawn(spec)?;
		if let Some(relays) = relays {
			child = relays.wrap(child);
		}
		self.spawns.record(lineage, child.pid());
		Ok(match &self.observer {
			Some(observer) => {
				let pid = child.pid();
				observer.spawned(pid);
				Box::new(Observed { child, observer: Arc::clone(observer), released: false })
			},
			None => child,
		})
	}
}

impl PiHost {
	/// A host over `fs` whose timers run on `runtime`.
	///
	/// Externals lead their own sessions; one abandoned while running (a
	/// cancel) gets TERM, then KILL after [`TERM_GRACE`].
	pub fn new(fs: Box<dyn Fs + Send>, runtime: tokio::runtime::Handle) -> Self {
		Self {
			fs,
			launcher: Launcher {
				spawner:  NativeSpawner::new(SpawnConfig {
					grace:    TERM_GRACE,
					sessions: Sessions::Detach,
					// The session driver is an async task: exits wake its waker
					// from waiter threads.
					exits:    Exits::Thread,
					umask:    None,
				}),
				streams:  StdStreams::default(),
				observer: None,
				spawns:   SpawnLog::default(),
				decoding: output_decode::external_output_decoding(),
			},
			tools: ToolConfig::default(),
			runtime,
			start: Instant::now(),
			random: RandomState::new(),
			draws: 0,
			user: OnceCell::new(),
			vfs: None,
			pipe_tap: None,
		}
	}

	/// Decode what externals write into a text sink with `decoding` instead
	/// of the host default.
	pub fn set_output_decoding(&mut self, decoding: Option<Arc<dyn OutputDecoding>>) {
		self.launcher.decoding = decoding;
	}

	/// Serve externals the paths `vfs` aliases: a `scheme://` argument,
	/// program or working directory the filesystem backs with a host file is
	/// handed to the external as that file (see [`PiHost::spawn`]).
	pub fn set_vfs(&mut self, vfs: Option<crate::vfs::VfsFs>) {
		self.vfs = vfs;
	}

	/// The pi-vfs filesystem slot set by [`PiHost::set_vfs`].
	pub const fn vfs(&self) -> Option<&crate::vfs::VfsFs> {
		self.vfs.as_ref()
	}

	/// Mirror the pipeline pipes of the commands run from now on to `tap`
	/// (`None`: none).
	pub fn set_pipe_tap(&mut self, tap: Option<Arc<dyn crate::bash::PipeTap>>) {
		self.pipe_tap = tap;
	}

	/// Where builtins report an error their exit status hides (jq after a
	/// failing input), for the command being run; `None` when nobody asks.
	pub fn reported_error(&self) -> Option<Arc<AtomicBool>> {
		self.tools.reported_error.get()
	}

	/// Set the flag of [`PiHost::reported_error`] for the commands run from
	/// now on.
	pub fn set_reported_error(&self, flag: Option<Arc<AtomicBool>>) {
		self.tools.reported_error.set(flag);
	}

	/// The standard streams the shell's fds 0, 1 and 2 forward to.
	pub const fn streams(&self) -> &StdStreams {
		&self.launcher.streams
	}

	/// Report every external spawned from now on to `observer`.
	pub fn set_spawn_observer(&mut self, observer: Arc<dyn SpawnObserver>) {
		self.launcher.observer = Some(observer);
	}

	/// The spawner (leak checks: [`NativeSpawner::leftovers`]).
	pub const fn spawner(&self) -> &NativeSpawner {
		&self.launcher.spawner
	}

	/// Resolve the commands `config` names to its tools.
	pub fn set_tools(&mut self, config: ToolConfig) {
		self.tools = config;
	}

	/// Where externals of labeled subshell trees are recorded.
	pub fn spawn_log(&self) -> SpawnLog {
		self.launcher.spawns.clone()
	}
}

impl crate::bash::Host for PiHost {
	/// pi's order ([`crate::extras`]): the engine's intrinsics (`suspend`
	/// withheld), the tools (`timeout`, `nohup`, `git`, the extras that run
	/// command lines), the other extras, then `PATH`. A name with a slash is
	/// only ever a path; `exec` searches `PATH` without asking.
	fn resolve(&mut self, name: &BStr, mode: ModeId, why: ResolveCtx<'_>) -> Resolved {
		if why.has_slash {
			return Resolved::NotFound;
		}
		if let Some(id) = IntrinsicId::lookup(name, mode) {
			return if id == IntrinsicId::Suspend {
				Resolved::Native(crate::extras::SUSPEND)
			} else {
				Resolved::Intrinsic(id)
			};
		}
		if let Some(tool) = self.tools.lookup(name) {
			return Resolved::Tool(tool);
		}
		self
			.tools
			.native_extra(name)
			.map_or(Resolved::NotFound, Resolved::Native)
	}

	/// Runs the extra `cmd` names on the runtime ([`crate::extras::ExtraTask`]),
	/// or refuses `suspend`.
	fn start(&mut self, cmd: &NativeRef, inv: Invocation<'_>) -> io::Result<Box<dyn Task>> {
		if *cmd == crate::extras::SUSPEND {
			let [_, _, stderr] = inv.stdio;
			return Ok(Box::new(crate::extras::Refusal::new(b"suspend", stderr)));
		}
		let name = crate::extras::native_name(*cmd).ok_or(io::ErrorKind::NotFound)?;
		let mut invocation = crate::extras::invocation(
			inv.argv,
			inv.env,
			inv.cwd,
			&inv.stdio,
			inv.extra_fds,
			inv.umask,
			&self.tools,
		);
		// The table's spelling selects the extra (`sg` stays `sg`).
		name.clone_into(&mut invocation.name);
		Ok(Box::new(crate::extras::ExtraTask::start(&self.runtime, invocation)))
	}

	/// pi's extras keep no state across a snapshot ([`Task::checkpoint`] is
	/// `None`), so there is nothing to restore: a task in flight is lost.
	fn restore_task(&mut self, _cmd: &NativeRef, _state: &[u8]) -> io::Result<Box<dyn Task>> {
		Err(io::ErrorKind::Unsupported.into())
	}

	/// Spawns through the process-group spawner. With a pi-vfs filesystem,
	/// an external sees no URL it cannot open: a `scheme://` program,
	/// argument (bare, or attached to an option name: `--root=skill://x`) or
	/// working directory the filesystem backs with a host file is handed over
	/// as that file, and the child's `PWD` names the host directory. A
	/// working directory backed by nothing, or one the filesystem refuses to
	/// change, refuses the command, as does a URL the provider cannot
	/// resolve. Only a spawn that names a URL asks the provider, and it
	/// awaits the answer: the returned future owns a copy of the names and
	/// the spawn's descriptors, and launches (routing, observer and all)
	/// only after the resolution succeeded, so dropping it earlier spawns
	/// nothing. Any other spawn launches at once and returns a ready future.
	fn spawn(&mut self, spec: SpawnSpec<'_>) -> SpawnFuture {
		let Some(fs) = self
			.vfs
			.as_ref()
			.filter(|_| urls::names_url(&spec))
			.map(crate::vfs::VfsFs::filesystem)
		else {
			return Box::pin(std::future::ready(self.launcher.launch(spec)));
		};
		let launcher = self.launcher.clone();
		let (names, rest) = urls::split(spec);
		Box::pin(async move {
			let hosted = urls::resolve(&fs, &names).await?;
			rest.launch(&hosted, |spec| launcher.launch(spec))
		})
	}

	/// A forked child opens a redirection itself only on Unix (the spawner
	/// cannot elsewhere) and only for a native-local path: it sees the host
	/// filesystem, not pi's providers.
	fn child_opens(&mut self, path: &BStr) -> bool {
		cfg!(unix)
			&& self
				.vfs
				.as_ref()
				.is_none_or(|vfs| vfs.is_native_local(path))
	}

	fn signal_process(&mut self, pid: i32, signal: Option<Signal>) -> io::Result<()> {
		// As pi's `kill`: `-0` only probes, so it may name anything.
		if signal.is_some() {
			check_signal_target(pid)?;
		}
		#[cfg(unix)]
		{
			let number =
				signal.map_or(0, |sig| i32::from(sig.number(crate::bash::Platform::current())));
			// SAFETY: kill accepts integer process and signal numbers.
			if unsafe { libc::kill(pid, number) } == 0 {
				Ok(())
			} else {
				Err(io::Error::last_os_error())
			}
		}
		#[cfg(not(unix))]
		{
			let _ = signal;
			Err(io::ErrorKind::Unsupported.into())
		}
	}

	fn pipe_tap(&mut self) -> Option<Arc<dyn crate::bash::PipeTap>> {
		self.pipe_tap.clone()
	}

	fn fs(&mut self) -> &mut dyn Fs {
		&mut *self.fs
	}

	fn stdio(&mut self, fd: StdFd) -> Option<Box<dyn File>> {
		Some(self.launcher.streams.file(fd))
	}

	fn now_ns(&self) -> u64 {
		u64::try_from(self.start.elapsed().as_nanos()).unwrap_or(u64::MAX)
	}

	fn timer(&mut self, at: Deadline) -> Box<dyn Timer> {
		let deadline = tokio::time::Instant::from_std(self.start + Duration::from_nanos(at.0));
		let shared = Arc::new(TimerShared::default());
		let fire = Arc::clone(&shared);
		let task = self.runtime.spawn(async move {
			tokio::time::sleep_until(deadline).await;
			fire.fired.store(true, Ordering::Release);
			let waker = fire.waker.lock().take();
			if let Some(waker) = waker {
				waker.wake();
			}
		});
		Box::new(RuntimeTimer { shared, task })
	}

	fn wall(&self) -> SystemTimeLike {
		let d = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default();
		SystemTimeLike {
			secs:  i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
			nanos: d.subsec_nanos(),
		}
	}

	fn random(&mut self) -> u64 {
		self.draws += 1;
		self.random.hash_one(self.draws)
	}

	fn shell_pid(&self) -> u32 {
		std::process::id()
	}

	fn ppid(&self) -> u32 {
		#[cfg(unix)]
		{
			// SAFETY: getppid has no preconditions.
			u32::try_from(unsafe { libc::getppid() }).unwrap_or(0)
		}
		#[cfg(not(unix))]
		0
	}

	fn user(&self) -> UserInfo {
		self.user.get_or_init(read_user).clone()
	}

	fn umask(&self) -> u32 {
		self.launcher.spawner.umask().unwrap_or(0o022)
	}

	fn hostname(&self) -> BString {
		#[cfg(unix)]
		{
			let mut buf = [0u8; 256];
			// SAFETY: the buffer is valid for `len` bytes; gethostname
			// NUL-terminates on success.
			if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0 {
				let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
				return BString::from(&buf[..end]);
			}
		}
		std::env::var_os("COMPUTERNAME")
			.map_or_else(|| BString::from("localhost"), |v| BString::from(v.as_encoded_bytes()))
	}

	fn tty(&mut self, _fd: i32) -> Option<TtyInfo> {
		None
	}

	fn tz_offset(&self, tz: Option<&BStr>, unix_s: i64) -> (i32, BString) {
		let Ok(ts) = jiff::Timestamp::from_second(unix_s) else {
			return (0, "UTC".into());
		};
		// Like the C library: a leading `:` or a name in the tz database
		// selects that zone, anything else is read as a POSIX TZ string; an
		// unusable value means UTC.
		let zone = match tz.map(|t| t.to_str_lossy()) {
			None => jiff::tz::TimeZone::system(),
			Some(text) => {
				let name = text.strip_prefix(':').unwrap_or(&text);
				jiff::tz::TimeZone::get(name)
					.or_else(|_| jiff::tz::TimeZone::posix(name))
					.unwrap_or(jiff::tz::TimeZone::UTC)
			},
		};
		let info = zone.to_offset_info(ts);
		(info.offset().seconds(), BString::from(info.abbreviation()))
	}

	fn rlimit(&self, res: Rlimit) -> io::Result<(Option<u64>, Option<u64>)> {
		crate::sys::rlimit::get(res)
	}

	#[cfg(unix)]
	fn cpu_times(&self) -> io::Result<crate::bash::CpuTimes> {
		let usage = |who| {
			let mut ru = std::mem::MaybeUninit::<libc::rusage>::zeroed();
			// SAFETY: getrusage writes one `rusage` into the valid pointer.
			if unsafe { libc::getrusage(who, ru.as_mut_ptr()) } != 0 {
				return Err(io::Error::last_os_error());
			}
			// SAFETY: getrusage succeeded, so the struct is initialized.
			let ru = unsafe { ru.assume_init() };
			let ns = |tv: libc::timeval| {
				u64::try_from(tv.tv_sec).unwrap_or(0) * 1_000_000_000
					+ u64::try_from(tv.tv_usec).unwrap_or(0) * 1_000
			};
			Ok((ns(ru.ru_utime), ns(ru.ru_stime)))
		};
		let (user_ns, sys_ns) = usage(libc::RUSAGE_SELF)?;
		let (child_user_ns, child_sys_ns) = usage(libc::RUSAGE_CHILDREN)?;
		Ok(crate::bash::CpuTimes { user_ns, sys_ns, child_user_ns, child_sys_ns })
	}

	fn event(&mut self, _ev: &Event<'_>) -> Verdict {
		Verdict::Continue
	}
}

/// Refuse a signal that would reach pi itself.
///
/// Refused: this process (`pid` equal to ours), its own process group (`0`, or
/// `-pgid`), every process (`-1`), or one of its ancestors or their process
/// groups. Everything above pi in the process tree is load-bearing for the
/// session (the terminal, the harness). The tree is resolved at each call, not
/// cached: a recycled pid of an ancestor that exited is not protected.
///
/// # Errors
///
/// `PermissionDenied` for a protected target.
pub fn check_signal_target(pid: i32) -> io::Result<()> {
	let refused = || {
		// pi's wording (`kill: (PID) - refusing to signal the shell process`).
		Err(io::Error::new(io::ErrorKind::PermissionDenied, "refusing to signal the shell process"))
	};
	if pid == 0 || pid == -1 {
		return refused();
	}
	let protected = protected_processes();
	let hit = if pid > 0 {
		protected.iter().any(|&(p, _)| p == pid)
	} else {
		protected.iter().any(|&(_, g)| g == -pid)
	};
	if hit { refused() } else { Ok(()) }
}

/// This process and its ancestors with their process groups, nearest first.
/// A recorded parent is followed only while it started no later than its
/// child: a younger process holding the number is a recycled pid.
#[cfg(unix)]
fn protected_processes() -> Vec<(i32, i32)> {
	let Ok(me) = i32::try_from(std::process::id()) else {
		return Vec::new();
	};
	// SAFETY: getpgrp has no preconditions.
	let own_group = unsafe { libc::getpgrp() };
	let mut chain = vec![(me, own_group)];
	let Some(mut cur) = crate::sys::proc::info(me) else {
		return chain;
	};
	// A process tree is shallow; the bound only guards a malformed table.
	for _ in 0..64 {
		if cur.ppid <= 0 || cur.ppid == cur.pid {
			break;
		}
		let Some(parent) = crate::sys::proc::info(cur.ppid) else {
			break;
		};
		if parent.start > cur.start {
			break;
		}
		chain.push((parent.pid, parent.pgid));
		cur = parent;
	}
	chain
}

/// Only this process off Unix.
#[cfg(not(unix))]
fn protected_processes() -> Vec<(i32, i32)> {
	i32::try_from(std::process::id()).map_or_else(|_| Vec::new(), |me| vec![(me, me)])
}

/// An external reported to a [`SpawnObserver`].
struct Observed {
	child:    Box<dyn ExtProc>,
	observer: Arc<dyn SpawnObserver>,
	released: bool,
}

impl Observed {
	fn release(&mut self) {
		if !self.released {
			self.released = true;
			self.observer.released(self.child.pid());
		}
	}
}

impl ExtProc for Observed {
	fn pid(&self) -> u32 {
		self.child.pid()
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		let status = std::task::ready!(self.child.poll_wait(cx));
		self.release();
		Poll::Ready(status)
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.child.signal(sig)
	}

	fn stop(&mut self) -> io::Result<()> {
		self.child.stop()
	}

	fn cont(&mut self) -> io::Result<()> {
		self.child.cont()
	}
}

impl Drop for Observed {
	fn drop(&mut self) {
		self.release();
	}
}

/// State a [`RuntimeTimer`] shares with its sleeping task.
#[derive(Default)]
struct TimerShared {
	fired: AtomicBool,
	waker: Mutex<Option<Waker>>,
}

/// A timer sleeping on the tokio runtime; dropping it aborts the sleep.
struct RuntimeTimer {
	shared: Arc<TimerShared>,
	task:   tokio::task::JoinHandle<()>,
}

impl Timer for RuntimeTimer {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<()> {
		if self.shared.fired.load(Ordering::Acquire) {
			return Poll::Ready(());
		}
		*self.shared.waker.lock() = Some(cx.waker().clone());
		// The task may have fired between the check and the store.
		if self.shared.fired.load(Ordering::Acquire) {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

impl Drop for RuntimeTimer {
	fn drop(&mut self) {
		self.task.abort();
	}
}

/// The current user: ids, groups, and `USER`/`HOME` (`USERNAME`/
/// `USERPROFILE` on Windows) of the process environment.
fn read_user() -> UserInfo {
	let var = |k: &str| {
		std::env::var_os(k).map_or_else(BString::default, |v| BString::from(v.as_encoded_bytes()))
	};
	#[cfg(unix)]
	// SAFETY: getuid/geteuid/getgid have no preconditions.
	let (uid, euid, gid) = unsafe { (libc::getuid(), libc::geteuid(), libc::getgid()) };
	#[cfg(not(unix))]
	let (uid, euid, gid) = (0, 0, 0);
	let (name, home) = if cfg!(windows) {
		(var("USERNAME"), var("USERPROFILE"))
	} else {
		(var("USER"), var("HOME"))
	};
	UserInfo { uid, euid, gid, groups: groups(), name, home }
}

/// The process's supplementary group ids (`GROUPS`); empty where the
/// platform has none or `getgroups` fails.
fn groups() -> Vec<u32> {
	#[cfg(unix)]
	{
		// SAFETY: a zero count with a null pointer only asks for the count.
		let n = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
		let Ok(len) = usize::try_from(n) else {
			return Vec::new();
		};
		let mut ids: Vec<libc::gid_t> = vec![0; len];
		// SAFETY: `ids` has room for `n` entries; getgroups writes at most
		// that many and returns how many it wrote.
		let got = unsafe { libc::getgroups(n, ids.as_mut_ptr()) };
		ids.truncate(usize::try_from(got).unwrap_or(0));
		ids
	}
	#[cfg(not(unix))]
	Vec::new()
}
